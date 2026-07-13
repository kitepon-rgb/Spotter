import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  constants,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir, platform as currentPlatform, arch as currentArch } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { version } from '../version.mjs';

export const RUNTIME_ERROR_STORE_SCHEMA = 'spotter.runtime_errors.v1';
export const RUNTIME_ERROR_STATE_SCHEMA_VERSION = '1.0';
export const RUNTIME_ERROR_STORE_FAILURE_DIAGNOSTIC = 'spotter-runtime-errors: local aggregate store unavailable\n';

export const RUNTIME_ERROR_DEFINITIONS = deepFreeze({
  daemon_transport: {
    component: 'daemon_transport',
    errorCode: 'SPOTTER.DAEMON.TRANSPORT',
    messageTemplate: 'Spotter daemon transport failed',
    severity: 'high',
  },
  daemon_persistence: {
    component: 'daemon_persistence',
    errorCode: 'SPOTTER.DAEMON.PERSISTENCE',
    messageTemplate: 'Spotter daemon state persistence failed',
    severity: 'high',
  },
  auditor_unavailable: {
    component: 'auditor',
    errorCode: 'SPOTTER.AUDITOR.UNAVAILABLE',
    messageTemplate: 'Spotter auditor backend was unavailable',
    severity: 'warn',
  },
});

const CONFIG_TOP_KEYS = new Set(['schema_version', 'host', 'collection', 'reporting']);
const HOST_KEYS = new Set(['id', 'profile']);
const COLLECTION_KEYS = new Set(['enabled']);
const REPORTING_KEYS = new Set(['enabled', 'endpoint', 'credential_file']);
const HOST_PROFILES = new Set(['server', 'mac', 'wsl', 'windows-native']);
const SEVERITIES = new Set(['fatal', 'high', 'warn', 'info']);
const STATUS_VALUES = new Set(['open', 'resolved']);
const MAX_SNAPSHOT_LIMIT = 500;
const MAX_RECEIPTS = 1_024;
// A cold Node worker plus its independent receipt reconciler must both fit in
// this budget under the parallel full-suite/CI load. 500 ms was below that
// measured boundary and caused valid committed receipts to be reported as
// unavailable. The observer remains absolutely bounded. Receipt reconciliation
// is prewarmed in parallel, so its cold-start cost is not paid after timeout.
const DEFAULT_ISOLATED_TIMEOUT_MS = 1_500;
const WINDOWS_DEFAULT_ISOLATED_TIMEOUT_MS = 5_000;
const RUNTIME_ERROR_WORKER = fileURLToPath(new URL('./runtime-error-store-worker.mjs', import.meta.url));
const pathQueues = new Map();

export function defaultFactoryReporterConfigPath({
  env = process.env,
  platform = process.platform,
  homeDir = homedir(),
} = {}) {
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA;
    if (typeof base !== 'string' || base.length === 0) return null;
    return join(base, 'dotagents', 'factory-reporter', 'config.json');
  }
  const base = typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME.length > 0
    ? env.XDG_CONFIG_HOME
    : join(homeDir, '.config');
  return join(base, 'dotagents', 'factory-reporter.json');
}

export function defaultRuntimeErrorStorePath({
  env = process.env,
  platform = process.platform,
  homeDir = homedir(),
} = {}) {
  if (platform === 'win32') {
    const base = typeof env.LOCALAPPDATA === 'string' && env.LOCALAPPDATA.length > 0
      ? env.LOCALAPPDATA
      : homeDir;
    return join(base, 'Spotter', 'runtime-errors-v1.json');
  }
  return join(homeDir, '.spotter', 'runtime-errors-v1.json');
}

export function runtimeErrorFingerprint(definition) {
  validateDefinition(definition);
  const canonical = [
    'factory-v1',
    'spotter',
    definition.component,
    definition.errorCode,
    definition.messageTemplate,
  ].join('\n');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export async function readRuntimeCollectionMode(options = {}) {
  const configPath = options.configPath ?? defaultFactoryReporterConfigPath(options);
  if (!configPath) return { mode: 'config_missing', enabled: false };
  let raw;
  try {
    raw = decodeUtf8(await readPrivateFile(configPath, options, { enforceWindowsAcl: false }));
  } catch (error) {
    return error?.code === 'ENOENT'
      ? { mode: 'config_missing', enabled: false }
      : { mode: 'config_malformed', enabled: false };
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return { mode: 'config_malformed', enabled: false };
  }
  if (!isCanonicalReporterConfig(value)) return { mode: 'config_malformed', enabled: false };
  return value.collection.enabled === true
    ? { mode: 'enabled', enabled: true }
    : { mode: 'disabled', enabled: false };
}

export async function observeRuntimeError(input, options = {}) {
  const kind = validateObservationInput(input);
  const observationId = options.observationId === undefined
    ? null
    : validateObservationId(options.observationId);
  const collection = await readRuntimeCollectionMode(options);
  if (!collection.enabled) return { collected: false, reason: collection.mode };
  const definition = RUNTIME_ERROR_DEFINITIONS[kind];
  const fingerprint = runtimeErrorFingerprint(definition);
  const storePath = options.storePath ?? defaultRuntimeErrorStorePath(options);
  const result = await mutateStore(storePath, options, (store) => {
    const receipt = observationId
      ? store.receipts.find((candidate) => candidate.id === observationId)
      : null;
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) {
        throw storeError('runtime error observation id conflicts with another fingerprint');
      }
      const existing = store.records.find((record) => record.fingerprint === fingerprint);
      return { collected: true, fingerprint, sequence: existing?.sequence ?? null, duplicate: true };
    }
    const timestamp = nowIso(options.now);
    const existing = store.records.find((record) => record.fingerprint === fingerprint);
    const sequence = store.next_sequence++;
    if (existing) {
      existing.product_version = validateProductVersion(options.productVersion ?? version);
      existing.occurrence_count += 1;
      existing.last_seen = timestamp;
      existing.status = 'open';
      existing.resolved_at = null;
      existing.reason_code = null;
      existing.sequence = sequence;
    } else {
      store.records.push({
        product: 'spotter',
        product_version: validateProductVersion(options.productVersion ?? version),
        component: definition.component,
        error_code: definition.errorCode,
        message_template: definition.messageTemplate,
        severity: definition.severity,
        fingerprint,
        occurrence_count: 1,
        first_seen: timestamp,
        last_seen: timestamp,
        state_schema_version: RUNTIME_ERROR_STATE_SCHEMA_VERSION,
        os: validatePlatform(options.platform ?? currentPlatform()),
        arch: validateArch(options.arch ?? currentArch()),
        status: 'open',
        resolved_at: null,
        reason_code: null,
        sequence,
      });
    }
    if (observationId) {
      store.receipts.push({ id: observationId, fingerprint });
      if (store.receipts.length > MAX_RECEIPTS) store.receipts.splice(0, store.receipts.length - MAX_RECEIPTS);
    }
    return { collected: true, fingerprint, sequence };
  });
  return result;
}

export async function observeRuntimeErrorSafe(input, options = {}) {
  try {
    return await observeRuntimeError(input, options);
  } catch {
    try {
      (options.writeError ?? ((text) => process.stderr.write(text)))(RUNTIME_ERROR_STORE_FAILURE_DIAGNOSTIC);
    } catch {
      // Runtime error reporting must never stop Spotter, including when stderr is unavailable.
    }
    return { collected: false, reason: 'store_unavailable' };
  }
}

export async function observeRuntimeErrorIsolatedSafe(input, options = {}) {
  let kind;
  try {
    kind = validateObservationInput(input);
  } catch {
    return emitFixedStoreFailure(options);
  }
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? (platform === 'win32'
    ? WINDOWS_DEFAULT_ISOLATED_TIMEOUT_MS
    : DEFAULT_ISOLATED_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 10 || timeoutMs > 10_000) {
    return emitFixedStoreFailure(options);
  }
  const observationId = randomUUID().replaceAll('-', '');
  const expectedFingerprint = runtimeErrorFingerprint(RUNTIME_ERROR_DEFINITIONS[kind]);
  const workerOptions = {
    configPath: options.configPath ?? defaultFactoryReporterConfigPath(options),
    storePath: options.storePath ?? defaultRuntimeErrorStorePath(options),
    productVersion: options.productVersion ?? version,
    platform: options.platform ?? process.platform,
    arch: options.arch ?? process.arch,
    beforeOpenDelayMs: options.beforeOpenDelayMs,
    observationId,
  };
  const encoded = Buffer.from(JSON.stringify(workerOptions), 'utf8').toString('base64url');
  const deadline = Date.now() + timeoutMs;
  const reconciliationReserveMs = Math.min(750, Math.max(100, Math.floor(timeoutMs * 0.4)));
  const observeBudgetMs = Math.max(1, timeoutMs - reconciliationReserveMs);
  const workerPath = options.workerPath ?? RUNTIME_ERROR_WORKER;
  const reconciliationOptions = { ...workerOptions, expectedFingerprint, waitMs: timeoutMs };
  delete reconciliationOptions.beforeOpenDelayMs;
  const reconciliationEncoded = Buffer.from(JSON.stringify(reconciliationOptions), 'utf8').toString('base64url');
  const reconciliationController = new AbortController();
  const reconciliation = runRuntimeWorker(
    options.reconciliationWorkerPath ?? RUNTIME_ERROR_WORKER,
    ['receipt', observationId, reconciliationEncoded],
    timeoutMs,
    reconciliationController.signal,
  );
  const observed = await runRuntimeWorker(workerPath, ['observe', kind, encoded], observeBudgetMs);
  if (observed.kind === 'exit' && observed.code === 0) { reconciliationController.abort(); await reconciliation; return { collected: true }; }
  if (observed.kind === 'exit' && observed.code === 10) { reconciliationController.abort(); await reconciliation; return { collected: false, reason: 'collection_disabled' }; }

  const remainingMs = deadline - Date.now();
  if (remainingMs > 0) {
    const reconciled = await reconciliation;
    if (reconciled.kind === 'exit' && reconciled.code === 0) return { collected: true };
  }
  reconciliationController.abort(); await reconciliation;
  return emitFixedStoreFailure(options);
}

function runRuntimeWorker(workerPath, args, timeoutMs, signal) {
  return new Promise((resolve) => {
    let settled = false;
    let stopping = false;
    let child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve(result);
    };
    const stop = (kind) => { if (stopping || settled) return; stopping = true; void killWorkerTree(child).then(() => finish({ kind })); };
    const abort = () => stop('cancelled');
    const killGraceMs = process.platform === 'win32' ? 250 : 0;
    const timer = setTimeout(() => stop('timeout'), Math.max(1, timeoutMs - killGraceMs));
    try {
      child = spawn(process.execPath, [workerPath, ...args], {
        stdio: 'ignore',
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: { ...process.env, SPOTTER_RUNTIME_ERROR_WORKER: '1' },
      });
    } catch {
      finish({ kind: 'error' });
      return;
    }
    child.once('error', () => finish({ kind: 'error' }));
    child.once('close', (code) => { if (!stopping) finish({ kind: 'exit', code }); });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function killWorkerTree(child) {
  if (!Number.isSafeInteger(child?.pid) || child.pid <= 0) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      let done = false; let fallback; const finish = () => { if (done) return; done = true; clearTimeout(fallback); resolve(); };
      let killer; try { killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { child.kill('SIGKILL'); finish(); return; }
      fallback = setTimeout(() => { child.kill('SIGKILL'); finish(); }, 225);
      killer.once('error', () => { child.kill('SIGKILL'); finish(); });
      killer.once('close', finish);
    });
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
  return Promise.resolve();
}

export async function hasRuntimeErrorReceipt(observationId, expectedFingerprint, options = {}) {
  const receipt = validateObservationId(observationId);
  const fingerprint = validateFingerprint(expectedFingerprint);
  const collection = await readRuntimeCollectionMode(options);
  if (!collection.enabled) return false;
  const storePath = options.storePath ?? defaultRuntimeErrorStorePath(options);
  const store = await readStore(storePath, options);
  const found = store.receipts.find((candidate) => candidate.id === receipt);
  if (!found) return false;
  if (found.fingerprint !== fingerprint) {
    throw storeError('runtime error receipt fingerprint conflict');
  }
  return true;
}

function emitFixedStoreFailure(options) {
  try {
    (options.writeError ?? ((text) => process.stderr.write(text)))(RUNTIME_ERROR_STORE_FAILURE_DIAGNOSTIC);
  } catch {
    // The runtime observer remains non-blocking even when stderr is unavailable.
  }
  return { collected: false, reason: 'store_unavailable' };
}

export async function readRuntimeErrorSnapshot(options = {}) {
  const collection = await readRuntimeCollectionMode(options);
  const afterCursor = validateCursor(options.afterCursor ?? 0, 'afterCursor');
  const limit = validateLimit(options.limit ?? 100);
  if (!collection.enabled) return emptySnapshot(collection.mode, afterCursor);
  const storePath = options.storePath ?? defaultRuntimeErrorStorePath(options);
  const store = await readStore(storePath, options);
  const records = store.records
    .filter((record) => record.sequence > afterCursor)
    .sort((a, b) => a.sequence - b.sequence);
  const selected = records.slice(0, limit).map(copyRecord);
  return {
    schema: RUNTIME_ERROR_STORE_SCHEMA,
    collection: 'enabled',
    records: selected,
    after_cursor: afterCursor,
    next_cursor: selected.length > 0 ? selected.at(-1).sequence : afterCursor,
    latest_sequence: store.next_sequence - 1,
    acknowledged_through: store.acknowledged_through,
    has_more: records.length > selected.length,
  };
}

export async function acknowledgeRuntimeErrors(input, options = {}) {
  assertExactObject(input, new Set(['cursor']));
  const cursor = validateCursor(input.cursor, 'cursor');
  const collection = await readRuntimeCollectionMode(options);
  if (!collection.enabled) return { acknowledged: false, reason: collection.mode, acknowledged_through: 0 };
  const storePath = options.storePath ?? defaultRuntimeErrorStorePath(options);
  return mutateStore(storePath, options, (store) => {
    const latest = store.next_sequence - 1;
    if (cursor > latest) throw inputError('cursor exceeds latest sequence');
    store.acknowledged_through = Math.max(store.acknowledged_through, cursor);
    return { acknowledged: true, acknowledged_through: store.acknowledged_through };
  });
}

export async function resolveRuntimeError(input, options = {}) {
  return transitionRuntimeError(input, 'resolved', options);
}

export async function reopenRuntimeError(input, options = {}) {
  return transitionRuntimeError(input, 'open', options);
}

async function transitionRuntimeError(input, status, options) {
  assertExactObject(input, new Set(['fingerprint']));
  const fingerprint = validateFingerprint(input.fingerprint);
  const collection = await readRuntimeCollectionMode(options);
  if (!collection.enabled) return { changed: false, reason: collection.mode };
  const storePath = options.storePath ?? defaultRuntimeErrorStorePath(options);
  return mutateStore(storePath, options, (store) => {
    const record = store.records.find((item) => item.fingerprint === fingerprint);
    if (!record || record.status === status) return { changed: false, status: record?.status ?? null };
    const resolvedAt = status === 'resolved' ? nowIso(options.now) : null;
    if (resolvedAt !== null && resolvedAt < record.last_seen) {
      throw inputError('resolution timestamp precedes last observation');
    }
    record.status = status;
    record.resolved_at = resolvedAt;
    record.reason_code = status === 'resolved' ? 'operator_resolved' : null;
    record.sequence = store.next_sequence++;
    return { changed: true, status, sequence: record.sequence };
  });
}

export async function compactRuntimeErrors(options = {}) {
  const maxResolvedRecords = options.maxResolvedRecords ?? 100;
  if (!Number.isSafeInteger(maxResolvedRecords) || maxResolvedRecords < 0 || maxResolvedRecords > 10_000) {
    throw inputError('maxResolvedRecords must be an integer between 0 and 10000');
  }
  const collection = await readRuntimeCollectionMode(options);
  if (!collection.enabled) return { compacted: false, reason: collection.mode, removed: 0 };
  const storePath = options.storePath ?? defaultRuntimeErrorStorePath(options);
  return mutateStore(storePath, options, (store) => {
    const compactable = store.records
      .filter((record) => record.status === 'resolved' && record.sequence <= store.acknowledged_through)
      .sort((a, b) => b.sequence - a.sequence);
    const keep = new Set(compactable.slice(0, maxResolvedRecords).map((record) => record.fingerprint));
    const before = store.records.length;
    store.records = store.records.filter((record) => (
      record.status !== 'resolved'
      || record.sequence > store.acknowledged_through
      || keep.has(record.fingerprint)
    ));
    return { compacted: true, removed: before - store.records.length };
  });
}

export async function readRuntimeErrorStoreStatus(options = {}) {
  const collection = await readRuntimeCollectionMode(options);
  const base = {
    schema: 'spotter.runtime_error_status.v1',
    collection: collection.mode,
    store: collection.enabled ? 'absent' : 'not_accessed',
    records: 0,
    open: 0,
    resolved: 0,
    unacknowledged: 0,
    latest_sequence: 0,
    acknowledged_through: 0,
  };
  if (!collection.enabled) return base;
  const storePath = options.storePath ?? defaultRuntimeErrorStorePath(options);
  let store;
  try {
    store = await readStore(storePath, options, { missingOk: false });
  } catch (error) {
    base.store = error?.code === 'ENOENT' ? 'absent' : 'unavailable';
    return base;
  }
  base.store = 'available';
  base.records = store.records.length;
  base.open = store.records.filter((record) => record.status === 'open').length;
  base.resolved = store.records.filter((record) => record.status === 'resolved').length;
  base.latest_sequence = store.next_sequence - 1;
  base.acknowledged_through = store.acknowledged_through;
  base.unacknowledged = store.records.filter((record) => record.sequence > store.acknowledged_through).length;
  return base;
}

async function mutateStore(storePath, options, mutate) {
  return enqueue(storePath, async () => {
    const directory = dirname(storePath);
    await ensurePrivateDirectory(directory, options);
    const lockPath = runtimeErrorLockPath(storePath);
    return withStoreLock(lockPath, options, async () => {
      const store = await readStore(storePath, options);
      const result = mutate(store);
      validateStore(store);
      const atomicWriteFn = options.atomicWriteFn ?? atomicWriteStore;
      await atomicWriteFn(storePath, `${JSON.stringify(store)}\n`, options);
      return result;
    });
  });
}

export function runtimeErrorLockPath(storePath) {
  return `${storePath}.lock.sqlite`;
}

async function withStoreLock(lockPath, options, operation) {
  await ensurePrivateLockFile(lockPath, options);
  const database = new DatabaseSync(lockPath);
  let active = false;
  try {
    await enforcePrivatePath(lockPath, options, { directory: false, repair: false });
    database.exec('PRAGMA busy_timeout=10000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
    active = true;
    const result = await operation();
    database.exec('COMMIT');
    active = false;
    return result;
  } finally {
    if (active) { try { database.exec('ROLLBACK'); } catch {} }
    database.close();
  }
}

async function ensurePrivateLockFile(lockPath, options) {
  let handle;
  try {
    handle = await open(lockPath, 'wx', 0o600);
    await handle.sync();
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
  await enforcePrivatePath(lockPath, options, {
    directory: false,
    repair: (options.platform ?? process.platform) === 'win32',
  });
}

async function atomicWriteStore(storePath, bytes, options = {}) {
  const temporary = `${storePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, storePath);
    await enforcePrivatePath(storePath, options, { directory: false, repair: true });
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function readStore(storePath, options = {}, { missingOk = true } = {}) {
  let raw;
  try {
    raw = decodeUtf8(await readPrivateFile(storePath, options, { enforceWindowsAcl: true }));
  } catch (error) {
    if (missingOk && error?.code === 'ENOENT') return emptyStore();
    throw error;
  }
  let store;
  try {
    store = JSON.parse(raw);
  } catch {
    throw storeError('runtime error store is malformed');
  }
  validateStore(store);
  return store;
}

async function ensurePrivateDirectory(directory, options) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await enforcePrivatePath(directory, options, { directory: true, repair: true });
}

async function readPrivateFile(path, options, { enforceWindowsAcl }) {
  const platform = options.platform ?? process.platform;
  if (enforceWindowsAcl) {
    await enforcePrivatePath(dirname(path), options, { directory: true, repair: platform === 'win32' });
    if (platform === 'win32') await enforcePrivatePath(path, options, { directory: false, repair: true });
  }
  const info = await lstat(path);
  validatePrivateStat(info, options, { directory: false, platform });
  if (Number.isSafeInteger(options.beforeOpenDelayMs) && options.beforeOpenDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, options.beforeOpenDelayMs));
  }
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags);
  try {
    const openedInfo = await handle.stat();
    validatePrivateStat(openedInfo, options, { directory: false, platform });
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function enforcePrivatePath(path, options, { directory, repair }) {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    if (repair) await runWindowsAcl(path, { directory }, options);
    return;
  }
  if (repair) await chmod(path, directory ? 0o700 : 0o600);
  const info = await lstat(path);
  validatePrivateStat(info, options, { directory, platform });
}

function validatePrivateStat(info, options, { directory, platform }) {
  if ((directory ? !info.isDirectory() : !info.isFile()) || info.isSymbolicLink()) {
    throw storeError('runtime error path type is unsafe');
  }
  if (platform === 'win32') return;
  const expectedMode = directory ? 0o700 : 0o600;
  if ((info.mode & 0o777) !== expectedMode) throw storeError('runtime error path mode is unsafe');
  const getuid = options.getuidFn ?? process.getuid?.bind(process);
  if (typeof getuid === 'function' && info.uid !== getuid()) throw storeError('runtime error path owner is unsafe');
}

export function buildWindowsAclPowerShell({ directory }) {
  const securityType = directory ? 'DirectorySecurity' : 'FileSecurity';
  const ioType = directory ? 'Directory' : 'File';
  const inheritance = directory
    ? '[System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit'
    : '[System.Security.AccessControl.InheritanceFlags]::None';
  return [
    '$ErrorActionPreference = "Stop"',
    '$target = $args[0]',
    '$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User',
    `$acl = New-Object System.Security.AccessControl.${securityType}`,
    '$acl.SetOwner($sid)',
    '$acl.SetAccessRuleProtection($true, $false)',
    `$inheritance = ${inheritance}`,
    '$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, "FullControl", $inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)',
    '$acl.AddAccessRule($rule)',
    `[System.IO.${ioType}]::SetAccessControl($target, $acl)`,
    `$readback = [System.IO.${ioType}]::GetAccessControl($target)`,
    '$ownerSid = $readback.GetOwner([System.Security.Principal.SecurityIdentifier]).Value',
    '$entries = @($readback.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))',
    '$valid = $entries.Count -eq 1 -and $ownerSid -eq $sid.Value -and $entries[0].IdentityReference.Value -eq $sid.Value -and $entries[0].AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and -not $entries[0].IsInherited -and (($entries[0].FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl)',
    'if (-not $valid) { exit 7 }',
  ].join('; ');
}

async function runWindowsAcl(path, { directory }, options) {
  const executable = options.powerShellPath ?? 'powershell.exe';
  const script = buildWindowsAclPowerShell({ directory });
  await spawnForExit(executable, ['-NoProfile', '-NonInteractive', '-Command', script, path], {
    timeoutMs: options.aclTimeoutMs ?? 3_000,
  });
}

export async function processStartIdentity(pid, options = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const platform = options.platform ?? process.platform;
  try {
    if (platform === 'linux') {
      const raw = await readFile(`/proc/${pid}/stat`, 'utf8');
      const close = raw.lastIndexOf(')');
      if (close < 0) return null;
      const fields = raw.slice(close + 2).trim().split(/\s+/);
      return fields[19] ? `linux:${fields[19]}` : null;
    }
    if (platform === 'win32') {
      const script = `$p = Get-Process -Id ${pid} -ErrorAction Stop; [Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks)`;
      const output = await spawnCapture(options.powerShellPath ?? 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 1_000 });
      return output ? `windows:${output.trim()}` : null;
    }
    const output = await spawnCapture('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { timeoutMs: 1_000 });
    return output.trim() ? `posix:${output.trim()}` : null;
  } catch {
    return null;
  }
}

function spawnForExit(command, args, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(storeError('private ACL operation failed')) : resolve();
    };
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('error', finish);
    child.once('close', (code) => finish(code === 0 ? null : new Error('nonzero')));
  });
}

function spawnCapture(command, args, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = '';
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (stdout.length < 4_096) stdout += chunk.slice(0, 4_096 - stdout.length);
    });
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(stdout);
    };
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('error', finish);
    child.once('close', (code) => finish(code === 0 ? null : new Error('process identity unavailable')));
  });
}

function emptyStore() {
  return {
    schema: RUNTIME_ERROR_STORE_SCHEMA,
    state_schema_version: RUNTIME_ERROR_STATE_SCHEMA_VERSION,
    next_sequence: 1,
    acknowledged_through: 0,
    records: [],
    receipts: [],
  };
}

function validateStore(store) {
  assertObject(store, 'store');
  const keys = new Set(['schema', 'state_schema_version', 'next_sequence', 'acknowledged_through', 'records', 'receipts']);
  if (!hasOnlyKeys(store, keys)
    || store.schema !== RUNTIME_ERROR_STORE_SCHEMA
    || store.state_schema_version !== RUNTIME_ERROR_STATE_SCHEMA_VERSION
    || !Number.isSafeInteger(store.next_sequence) || store.next_sequence < 1
    || !Number.isSafeInteger(store.acknowledged_through) || store.acknowledged_through < 0
    || store.acknowledged_through >= store.next_sequence
    || !Array.isArray(store.records)
    || !Array.isArray(store.receipts) || store.receipts.length > MAX_RECEIPTS) {
    throw storeError('runtime error store schema mismatch');
  }
  const fingerprints = new Set();
  const sequences = new Set();
  for (const record of store.records) {
    validateRecord(record, store.next_sequence);
    if (fingerprints.has(record.fingerprint)) throw storeError('duplicate runtime error fingerprint');
    if (sequences.has(record.sequence)) throw storeError('duplicate runtime error sequence');
    fingerprints.add(record.fingerprint);
    sequences.add(record.sequence);
  }
  const receipts = new Set();
  for (const receipt of store.receipts) {
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
      || Object.keys(receipt).length !== 2 || !Object.hasOwn(receipt, 'id') || !Object.hasOwn(receipt, 'fingerprint')
      || typeof receipt.id !== 'string' || !/^[a-f0-9]{32}$/.test(receipt.id)
      || typeof receipt.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.fingerprint)) {
      throw storeError('invalid runtime error receipt');
    }
    if (!Object.values(RUNTIME_ERROR_DEFINITIONS).some((definition) => runtimeErrorFingerprint(definition) === receipt.fingerprint)) {
      throw storeError('unknown runtime error receipt fingerprint');
    }
    if (receipts.has(receipt.id)) throw storeError('duplicate runtime error receipt');
    receipts.add(receipt.id);
  }
}

function validateRecord(record, nextSequence) {
  const keys = new Set([
    'product', 'product_version', 'component', 'error_code', 'message_template', 'severity',
    'fingerprint', 'occurrence_count', 'first_seen', 'last_seen', 'state_schema_version',
    'os', 'arch', 'status', 'resolved_at', 'reason_code', 'sequence',
  ]);
  assertObject(record, 'record');
  const definition = Object.values(RUNTIME_ERROR_DEFINITIONS).find((candidate) => (
    candidate.component === record.component
    && candidate.errorCode === record.error_code
    && candidate.messageTemplate === record.message_template
    && candidate.severity === record.severity
  ));
  if (!hasOnlyKeys(record, keys) || Object.keys(record).length !== keys.size
    || record.product !== 'spotter'
    || !definition
    || record.fingerprint !== runtimeErrorFingerprint(definition)
    || !Number.isSafeInteger(record.occurrence_count) || record.occurrence_count < 1
    || !validTimestamp(record.first_seen) || !validTimestamp(record.last_seen) || record.first_seen > record.last_seen
    || record.state_schema_version !== RUNTIME_ERROR_STATE_SCHEMA_VERSION
    || !STATUS_VALUES.has(record.status)
    || (record.status === 'open' && (record.resolved_at !== null || record.reason_code !== null))
    || (record.status === 'resolved' && (!validTimestamp(record.resolved_at)
      || record.resolved_at < record.last_seen || record.reason_code !== 'operator_resolved'))
    || !Number.isSafeInteger(record.sequence) || record.sequence < 1 || record.sequence >= nextSequence) {
    throw storeError('runtime error record schema mismatch');
  }
  validateProductVersion(record.product_version);
  validatePlatform(record.os);
  validateArch(record.arch);
}

function validateObservationInput(input) {
  if (typeof input === 'string') {
    if (!Object.hasOwn(RUNTIME_ERROR_DEFINITIONS, input)) throw inputError('unknown runtime error kind');
    return input;
  }
  assertExactObject(input, new Set(['kind']));
  if (typeof input.kind !== 'string' || !Object.hasOwn(RUNTIME_ERROR_DEFINITIONS, input.kind)) {
    throw inputError('unknown runtime error kind');
  }
  return input.kind;
}

function validateObservationId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) {
    throw inputError('invalid runtime error observation id');
  }
  return value;
}

function validateDefinition(value) {
  assertObject(value, 'definition');
  if (!validStableId(value.component)
    || typeof value.errorCode !== 'string'
    || typeof value.messageTemplate !== 'string'
    || !SEVERITIES.has(value.severity)) {
    throw inputError('invalid runtime error definition');
  }
}

function isCanonicalReporterConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !hasOnlyKeys(value, CONFIG_TOP_KEYS)) return false;
  if (Object.keys(value).length !== CONFIG_TOP_KEYS.size || value.schema_version !== '1.0') return false;
  const { host, collection, reporting } = value;
  if (!host || typeof host !== 'object' || Array.isArray(host) || !hasOnlyKeys(host, HOST_KEYS) || Object.keys(host).length !== 2) return false;
  if (typeof host.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(host.id) || host.id.length > 64 || !HOST_PROFILES.has(host.profile)) return false;
  if (!collection || typeof collection !== 'object' || Array.isArray(collection) || !hasOnlyKeys(collection, COLLECTION_KEYS) || Object.keys(collection).length !== 1 || typeof collection.enabled !== 'boolean') return false;
  if (!reporting || typeof reporting !== 'object' || Array.isArray(reporting) || !hasOnlyKeys(reporting, REPORTING_KEYS) || typeof reporting.enabled !== 'boolean') return false;
  if (reporting.enabled === true) {
    if (!isCanonicalHttpEndpoint(reporting.endpoint)) return false;
    if (typeof reporting.credential_file !== 'string' || reporting.credential_file.length < 1 || reporting.credential_file.length > 4096) return false;
  }
  if (reporting.endpoint !== undefined && !isCanonicalHttpEndpoint(reporting.endpoint)) return false;
  if (reporting.credential_file !== undefined && (typeof reporting.credential_file !== 'string' || reporting.credential_file.length < 1 || reporting.credential_file.length > 4096)) return false;
  return true;
}

function isCanonicalHttpEndpoint(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.username === ''
      && parsed.password === ''
      && parsed.hash === ''
      && parsed.href === value;
  } catch {
    return false;
  }
}

function emptySnapshot(collection, afterCursor) {
  return {
    schema: RUNTIME_ERROR_STORE_SCHEMA,
    collection,
    records: [],
    after_cursor: afterCursor,
    next_cursor: afterCursor,
    latest_sequence: 0,
    acknowledged_through: 0,
    has_more: false,
  };
}

function copyRecord(record) {
  return { ...record };
}

function validateCursor(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw inputError(`${name} must be a non-negative integer`);
  return value;
}

function validateLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_SNAPSHOT_LIMIT) {
    throw inputError(`limit must be an integer between 1 and ${MAX_SNAPSHOT_LIMIT}`);
  }
  return value;
}

function validateFingerprint(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw inputError('invalid fingerprint');
  return value;
}

function validateProductVersion(value) {
  if (typeof value !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(value)) {
    throw inputError('invalid product version');
  }
  return value;
}

function validatePlatform(value) {
  if (typeof value !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(value)) throw inputError('invalid platform');
  return value;
}

function validateArch(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(value)) throw inputError('invalid architecture');
  return value;
}

function nowIso(now) {
  const value = typeof now === 'function' ? now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw inputError('invalid observation timestamp');
  return date.toISOString();
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validStableId(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9._-]{0,95}$/.test(value);
}

function decodeUtf8(bytes) {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function assertExactObject(value, allowedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !hasOnlyKeys(value, allowedKeys) || Object.keys(value).length !== allowedKeys.size) {
    throw inputError('runtime error API accepts allow-listed fields only');
  }
}

function assertObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw storeError(`${name} must be an object`);
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function inputError(message) {
  return Object.assign(new TypeError(message), { code: 'E_RUNTIME_ERROR_INPUT' });
}

function storeError(message) {
  return Object.assign(new Error(message), { code: 'E_RUNTIME_ERROR_STORE' });
}

function enqueue(path, operation) {
  const previous = pathQueues.get(path) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  pathQueues.set(path, current);
  return current.finally(() => {
    if (pathQueues.get(path) === current) pathQueues.delete(path);
  });
}

function deepFreeze(value) {
  for (const item of Object.values(value)) Object.freeze(item);
  return Object.freeze(value);
}
