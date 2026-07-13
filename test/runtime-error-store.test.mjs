import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RUNTIME_ERROR_DEFINITIONS,
  acknowledgeRuntimeErrors,
  buildWindowsAclPowerShell,
  compactRuntimeErrors,
  defaultFactoryReporterConfigPath,
  defaultRuntimeErrorStorePath,
  observeRuntimeError,
  observeRuntimeErrorIsolatedSafe,
  observeRuntimeErrorSafe,
  readRuntimeErrorSnapshot,
  readRuntimeErrorStoreStatus,
  reopenRuntimeError,
  resolveRuntimeError,
  runtimeErrorFingerprint,
  runtimeErrorLockPath,
} from '../src/core/runtime-error-store.mjs';
import { runRuntimeErrorDiagnosticsCommand } from '../src/cli/diagnostics-cmd.mjs';

const TEST_PLATFORM = process.platform === 'win32' ? 'win32' : 'darwin';
const TEST_PROFILE = TEST_PLATFORM === 'win32' ? 'windows-native' : 'mac';
const TEST_CREDENTIAL_FILE = TEST_PLATFORM === 'win32' ? 'C:\\safe\\credential' : '/safe/credential';
const ISOLATED_COMMIT_TIMEOUT_MS = TEST_PLATFORM === 'win32' ? 5_000 : 1_500;

async function sandbox(config = { collection: { enabled: true } }) {
  const root = await mkdtemp(join(tmpdir(), 'spotter-runtime-errors-'));
  const configPath = join(root, 'factory-reporter.json');
  const storePath = join(root, 'spotter', 'runtime-errors-v1.json');
  if (config !== null) {
    await writeFile(configPath, JSON.stringify({
      schema_version: '1.0',
      host: { id: 'test-host', profile: TEST_PROFILE },
      collection: { enabled: false },
      reporting: { enabled: false },
      ...config,
    }));
    if (process.platform !== 'win32') await chmod(configPath, 0o600);
  }
  return { root, configPath, storePath, platform: TEST_PLATFORM };
}

const execFileAsync = promisify(execFile);
const runtimeStoreModule = new URL('../src/core/runtime-error-store.mjs', import.meta.url).href;
const runtimeWorkerPath = fileURLToPath(new URL('../src/core/runtime-error-store-worker.mjs', import.meta.url));

const options = (box, extra = {}) => ({
  configPath: box.configPath,
  storePath: box.storePath,
  now: () => new Date('2026-07-13T00:00:00.000Z'),
  productVersion: '1.4.22',
  platform: box.platform,
  arch: 'arm64',
  ...extra,
});

function createObservationId(round, index) {
  return `${round.toString(16).padStart(16, '0')}${index.toString(16).padStart(16, '0')}`;
}

function encodeWorkerOptions(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function runChild(command, args, spawnOptions = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], ...spawnOptions });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => resolve({ code: null, stderr: error.message }));
    child.once('close', (code) => resolve({ code, stderr }));
  });
}

test('runtime error collection: missing, malformed, and non-boolean config fail closed', async () => {
  for (const config of [null, '{broken', { collection: { enabled: 'true' } }, { collection: {} }]) {
    const box = await sandbox(null);
    if (typeof config === 'string') await writeFile(box.configPath, config);
    if (config && typeof config === 'object') await writeFile(box.configPath, JSON.stringify(config));
    const result = await observeRuntimeError('daemon_transport', options(box));
    assert.equal(result.collected, false);
    await assert.rejects(readFile(box.storePath), { code: 'ENOENT' });
  }
});

test('runtime error collection: invalid UTF-8 config fails closed', async () => {
  const box = await sandbox(null);
  await writeFile(box.configPath, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]));
  assert.deepEqual(await observeRuntimeError('daemon_transport', options(box)), {
    collected: false,
    reason: 'config_malformed',
  });
  await assert.rejects(readFile(box.storePath), { code: 'ENOENT' });
});

test('runtime error collection: canonical config requires collection.enabled === true', async () => {
  const disabled = await sandbox({ collection: { enabled: false } });
  assert.equal((await observeRuntimeError('daemon_transport', options(disabled))).collected, false);
  const enabled = await sandbox();
  assert.equal((await observeRuntimeError('daemon_transport', options(enabled))).collected, true);
});

test('runtime error config: endpoint is accepted only when URL parsing is canonical HTTP(S)', async () => {
  for (const endpoint of ['ftp://example.test/api', 'https://example.test:443/api', 'https://user:pass@example.test/api']) {
    const box = await sandbox({
      collection: { enabled: true },
      reporting: { enabled: true, endpoint, credential_file: TEST_CREDENTIAL_FILE },
    });
    assert.equal((await observeRuntimeError('daemon_transport', options(box))).collected, false, endpoint);
  }
  const box = await sandbox({
    collection: { enabled: true },
    reporting: { enabled: true, endpoint: 'https://example.test/api', credential_file: TEST_CREDENTIAL_FILE },
  });
  assert.equal((await observeRuntimeError('daemon_transport', options(box))).collected, true);
});

test('runtime error paths use the Windows native LocalAppData contract', () => {
  const input = { platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\kite_\\AppData\\Local' }, homeDir: 'C:\\Users\\kite_' };
  assert.equal(defaultFactoryReporterConfigPath(input), join(input.env.LOCALAPPDATA, 'dotagents', 'factory-reporter', 'config.json'));
  assert.equal(defaultRuntimeErrorStorePath(input), join(input.env.LOCALAPPDATA, 'Spotter', 'runtime-errors-v1.json'));
});

test('runtime error API rejects raw exception, stderr, stack, prompt, payload, finding, and paths', async () => {
  const box = await sandbox();
  const forbidden = ['exception', 'stderr', 'stdout', 'stack', 'prompt', 'hookPayload', 'findings', 'path', 'context'];
  for (const key of forbidden) {
    await assert.rejects(
      observeRuntimeError({ kind: 'daemon_transport', [key]: `SENTINEL_${key}` }, options(box)),
      { code: 'E_RUNTIME_ERROR_INPUT' },
      key,
    );
  }
  await assert.rejects(observeRuntimeError('unknown_kind', options(box)), { code: 'E_RUNTIME_ERROR_INPUT' });
  await assert.rejects(readFile(box.storePath), { code: 'ENOENT' });
});

test('runtime error store aggregates fixed definitions with canonical SHA-256 fingerprint', async () => {
  const box = await sandbox();
  await observeRuntimeError('daemon_transport', options(box));
  await observeRuntimeError({ kind: 'daemon_transport' }, options(box, {
    now: () => new Date('2026-07-13T00:00:05.000Z'),
  }));
  const snapshot = await readRuntimeErrorSnapshot(options(box));
  assert.equal(snapshot.records.length, 1);
  assert.deepEqual(snapshot.records[0], {
    product: 'spotter',
    product_version: '1.4.22',
    component: 'daemon_transport',
    error_code: 'SPOTTER.DAEMON.TRANSPORT',
    message_template: 'Spotter daemon transport failed',
    severity: 'high',
    fingerprint: runtimeErrorFingerprint(RUNTIME_ERROR_DEFINITIONS.daemon_transport),
    occurrence_count: 2,
    first_seen: '2026-07-13T00:00:00.000Z',
    last_seen: '2026-07-13T00:00:05.000Z',
    state_schema_version: '1.0',
    os: box.platform,
    arch: 'arm64',
    status: 'open',
    resolved_at: null,
    reason_code: null,
    sequence: 2,
  });
  const raw = await readFile(box.storePath, 'utf8');
  assert.doesNotMatch(raw, /SENTINEL|exception|stderr|stack|prompt|payload|finding|\/Users\//);
});

test('runtime error cursor/ack are monotonic and resolve/reopen creates new observations', async () => {
  const box = await sandbox();
  const first = await observeRuntimeError('daemon_transport', options(box));
  await observeRuntimeError('daemon_persistence', options(box));
  const page = await readRuntimeErrorSnapshot(options(box, { afterCursor: 0, limit: 1 }));
  assert.equal(page.records.length, 1);
  assert.equal(page.has_more, true);
  assert.equal(page.next_cursor, 1);
  assert.equal((await acknowledgeRuntimeErrors({ cursor: 1 }, options(box))).acknowledged_through, 1);
  assert.equal((await acknowledgeRuntimeErrors({ cursor: 0 }, options(box))).acknowledged_through, 1);

  await resolveRuntimeError({ fingerprint: first.fingerprint }, options(box));
  let current = await readRuntimeErrorSnapshot(options(box, { afterCursor: 0 }));
  const resolved = current.records.find((record) => record.fingerprint === first.fingerprint);
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.resolved_at, '2026-07-13T00:00:00.000Z');
  assert.equal(resolved.reason_code, 'operator_resolved');
  await reopenRuntimeError({ fingerprint: first.fingerprint }, options(box));
  current = await readRuntimeErrorSnapshot(options(box, { afterCursor: 0 }));
  const reopenedByOperator = current.records.find((record) => record.fingerprint === first.fingerprint);
  assert.equal(reopenedByOperator.status, 'open');
  assert.equal(reopenedByOperator.resolved_at, null);
  assert.equal(reopenedByOperator.reason_code, null);
  await observeRuntimeError('daemon_transport', options(box));
  const reopened = (await readRuntimeErrorSnapshot(options(box, { afterCursor: 0 }))).records
    .find((record) => record.fingerprint === first.fingerprint);
  assert.equal(reopened.status, 'open');
  assert.equal(reopened.occurrence_count, 2);
  assert.ok(reopened.sequence > 2);
});

test('runtime error retention never compacts unacknowledged records', async () => {
  const box = await sandbox();
  const a = await observeRuntimeError('daemon_transport', options(box));
  await resolveRuntimeError({ fingerprint: a.fingerprint }, options(box));
  const b = await observeRuntimeError('daemon_persistence', options(box));
  await resolveRuntimeError({ fingerprint: b.fingerprint }, options(box));
  let result = await compactRuntimeErrors(options(box, { maxResolvedRecords: 0 }));
  assert.equal(result.removed, 0);
  const maxCursor = (await readRuntimeErrorSnapshot(options(box))).latest_sequence;
  await acknowledgeRuntimeErrors({ cursor: maxCursor }, options(box));
  result = await compactRuntimeErrors(options(box, { maxResolvedRecords: 1 }));
  assert.equal(result.removed, 1);
  assert.equal((await readRuntimeErrorSnapshot(options(box))).records.length, 1);
});

test('runtime error store uses owner-private permissions and atomic failure keeps prior bytes', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX mode bits are not portable to Windows');
  const box = await sandbox();
  await observeRuntimeError('daemon_transport', options(box));
  assert.equal((await stat(join(box.root, 'spotter'))).mode & 0o777, 0o700);
  assert.equal((await stat(box.storePath)).mode & 0o777, 0o600);
  const before = await readFile(box.storePath, 'utf8');
  await assert.rejects(observeRuntimeError('daemon_persistence', options(box, {
    atomicWriteFn: async () => { throw Object.assign(new Error('SENTINEL_WRITE'), { code: 'EIO' }); },
  })));
  assert.equal(await readFile(box.storePath, 'utf8'), before);
});

test('runtime error store rejects symlinks and the OS releases a crashed SQLite writer', async (t) => {
  if (process.platform === 'win32') return t.skip('symlink fixture requires POSIX privileges');
  const box = await sandbox();
  await mkdir(join(box.root, 'spotter'), { recursive: true });
  const target = join(box.root, 'target.json');
  await writeFile(target, '{}');
  await symlink(target, box.storePath);
  await assert.rejects(observeRuntimeError('daemon_transport', options(box)), { code: 'E_RUNTIME_ERROR_STORE' });
  await rm(box.storePath);
  const lock = runtimeErrorLockPath(box.storePath);
  const script = `import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(${JSON.stringify(lock)}); db.exec('BEGIN IMMEDIATE'); console.log('READY'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve, reject) => {
    child.stdout.once('data', (chunk) => String(chunk).includes('READY') ? resolve() : reject(new Error('lock child not ready')));
    child.once('error', reject);
  });
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));
  assert.equal((await observeRuntimeError('daemon_transport', options(box))).collected, true);
});

test('runtime error reads reject unsafe POSIX config/store modes every time', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX mode bits are not portable to Windows');
  const unsafeConfig = await sandbox();
  await chmod(unsafeConfig.configPath, 0o644);
  assert.equal((await observeRuntimeError('daemon_transport', options(unsafeConfig))).collected, false);

  const unsafeStore = await sandbox();
  await observeRuntimeError('daemon_transport', options(unsafeStore));
  await chmod(unsafeStore.storePath, 0o644);
  await assert.rejects(readRuntimeErrorSnapshot(options(unsafeStore)), { code: 'E_RUNTIME_ERROR_STORE' });
});

test('runtime error isolated observer kills FIFO-blocked config and store workers', async (t) => {
  if (process.platform === 'win32') return t.skip('mkfifo is POSIX-only');
  const configFifo = await sandbox(null);
  await execFileAsync('mkfifo', [configFifo.configPath]);
  const storeFifo = await sandbox();
  await mkdir(join(storeFifo.root, 'spotter'), { mode: 0o700 });
  await execFileAsync('mkfifo', [storeFifo.storePath]);

  for (const [index, box] of [configFifo, storeFifo].entries()) {
    const stderr = [];
    const startedAt = Date.now();
    const result = await observeRuntimeErrorIsolatedSafe('daemon_transport', options(box, {
      // Keep the production default budget here. A 100 ms total budget left
      // only 60 ms for Node startup before reconciliation and made the
      // config-FIFO branch nondeterministically time out before it could
      // classify the non-regular config as disabled.
      timeoutMs: 1_500,
      writeError: (text) => stderr.push(text),
    }));
    assert.equal(result.collected, false);
    assert.ok(Date.now() - startedAt < 2_000);
    assert.deepEqual(stderr, index === 0 ? [] : ['spotter-runtime-errors: local aggregate store unavailable\n']);
  }

  const blocked = await sandbox();
  const blockedWorker = join(blocked.root, 'blocked-worker.mjs');
  await writeFile(blockedWorker, 'setInterval(() => {}, 1000);\n');
  const stderr = [];
  const startedAt = Date.now();
  const result = await observeRuntimeErrorIsolatedSafe('daemon_transport', options(blocked, {
    timeoutMs: 1_500,
    workerPath: blockedWorker,
    writeError: (text) => stderr.push(text),
  }));
  assert.equal(result.collected, false);
  assert.ok(Date.now() - startedAt < 2_000);
  assert.deepEqual(stderr, ['spotter-runtime-errors: local aggregate store unavailable\n']);

  const tree = await sandbox();
  const descendantMarker = join(tree.root, 'descendant-survived');
  const treeWorker = join(tree.root, 'blocked-tree-worker.mjs');
  await writeFile(treeWorker, [
    'import { spawn } from "node:child_process";',
    `spawn(process.execPath, ["-e", ${JSON.stringify(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(descendantMarker)}, 'bad'), 1200)`) }], { stdio: "ignore" });`,
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  await observeRuntimeErrorIsolatedSafe('daemon_transport', options(tree, {
    timeoutMs: 1_500,
    workerPath: treeWorker,
    writeError: () => {},
  }));
  await new Promise((resolve) => setTimeout(resolve, 500));
  await assert.rejects(readFile(descendantMarker), { code: 'ENOENT' });
});

test('isolated observer reconciles a committed receipt after the observe worker hangs without double counting', async () => {
  const box = await sandbox();
  const marker = join(box.root, 'observation-id');
  const worker = join(box.root, 'commit-then-hang-worker.mjs');
  await writeFile(worker, `
import { writeFile } from 'node:fs/promises';
import { observeRuntimeError } from ${JSON.stringify(runtimeStoreModule)};
if (process.argv.length !== 5 || process.argv[2] !== 'observe') process.exit(2);
const options = JSON.parse(Buffer.from(process.argv[4], 'base64url').toString('utf8'));
await observeRuntimeError(process.argv[3], options);
await writeFile(${JSON.stringify(marker)}, options.observationId);
setInterval(() => {}, 1000);
`);
  const startedAt = Date.now();
  const result = await observeRuntimeErrorIsolatedSafe('daemon_transport', options(box, {
    timeoutMs: ISOLATED_COMMIT_TIMEOUT_MS,
    workerPath: worker,
    writeError: () => assert.fail('committed receipt must reconcile'),
  }));
  assert.deepEqual(result, { collected: true });
  assert.ok(Date.now() - startedAt < ISOLATED_COMMIT_TIMEOUT_MS);
  const observationId = await readFile(marker, 'utf8');
  assert.match(observationId, /^[a-f0-9]{32}$/);

  const retried = await observeRuntimeError('daemon_transport', options(box, { observationId }));
  assert.equal(retried.duplicate, true);
  const snapshot = await readRuntimeErrorSnapshot(options(box));
  assert.equal(snapshot.records[0].occurrence_count, 1);
  assert.equal('receipts' in snapshot, false);
});

test('receipt IDs are fingerprint-bound and reject cross-kind idempotency conflicts', async () => {
  const box = await sandbox();
  const observationId = 'e'.repeat(32);
  await observeRuntimeError('daemon_transport', options(box, { observationId }));
  await assert.rejects(
    observeRuntimeError('daemon_persistence', options(box, { observationId })),
    {
      code: 'E_RUNTIME_ERROR_STORE',
      message: 'runtime error observation id conflicts with another fingerprint',
    },
  );
  const snapshot = await readRuntimeErrorSnapshot(options(box));
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.records[0].error_code, 'SPOTTER.DAEMON.TRANSPORT');
  assert.equal(snapshot.records[0].occurrence_count, 1);
  assert.equal(snapshot.latest_sequence, 1);
  const store = JSON.parse(await readFile(box.storePath, 'utf8'));
  assert.deepEqual(store.receipts, [{
    id: observationId,
    fingerprint: runtimeErrorFingerprint(RUNTIME_ERROR_DEFINITIONS.daemon_transport),
  }]);
});

test('isolated reconciliation rejects a receipt committed for a different fingerprint', async () => {
  const box = await sandbox();
  const worker = join(box.root, 'wrong-kind-commit-worker.mjs');
  await writeFile(worker, `
import { observeRuntimeError } from ${JSON.stringify(runtimeStoreModule)};
if (process.argv.length !== 5 || process.argv[2] !== 'observe') process.exit(2);
const options = JSON.parse(Buffer.from(process.argv[4], 'base64url').toString('utf8'));
await observeRuntimeError('daemon_persistence', options);
setInterval(() => {}, 1000);
`);
  const stderr = [];
  const result = await observeRuntimeErrorIsolatedSafe('daemon_transport', options(box, {
    timeoutMs: ISOLATED_COMMIT_TIMEOUT_MS,
    workerPath: worker,
    writeError: (text) => stderr.push(text),
  }));
  assert.equal(result.collected, false);
  assert.deepEqual(stderr, ['spotter-runtime-errors: local aggregate store unavailable\n']);
  const snapshot = await readRuntimeErrorSnapshot(options(box));
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.records[0].error_code, 'SPOTTER.DAEMON.PERSISTENCE');
  assert.equal(snapshot.records[0].occurrence_count, 1);
});

test('isolated observer settles by the absolute deadline even when observe and reconciliation workers never close', async () => {
  const box = await sandbox();
  const blockedWorker = join(box.root, 'never-close-worker.mjs');
  await writeFile(blockedWorker, `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n`);
  const stderr = [];
  const timeoutMs = 120;
  const startedAt = Date.now();
  const result = await observeRuntimeErrorIsolatedSafe('daemon_transport', options(box, {
    timeoutMs,
    workerPath: blockedWorker,
    reconciliationWorkerPath: blockedWorker,
    writeError: (text) => stderr.push(text),
  }));
  const elapsed = Date.now() - startedAt;
  assert.equal(result.collected, false);
  assert.ok(elapsed < timeoutMs + 100, `missed hard deadline: ${elapsed}ms`);
  assert.deepEqual(stderr, ['spotter-runtime-errors: local aggregate store unavailable\n']);
});

test('cold SQLite lock creation preserves all 32 concurrent observations across repeated fresh stores', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX lock mode assertion');
  const childSource = `
import { observeRuntimeError } from ${JSON.stringify(runtimeStoreModule)};
const options = JSON.parse(Buffer.from(process.argv[1], 'base64url').toString('utf8'));
const result = await observeRuntimeError('daemon_transport', options);
if (!result.collected) process.exit(3);
`;
  for (let round = 0; round < 3; round += 1) {
    const box = await sandbox();
    const children = Array.from({ length: 32 }, (_, index) => {
      const childOptions = options(box, { observationId: createObservationId(round, index) });
      const encoded = Buffer.from(JSON.stringify({
        ...childOptions,
        now: undefined,
      }), 'utf8').toString('base64url');
      return runChild(process.execPath, ['--input-type=module', '-e', childSource, encoded]);
    });
    const results = await Promise.all(children);
    for (const result of results) assert.equal(result.code, 0, `round ${round}: ${result.stderr}`);
    const snapshot = await readRuntimeErrorSnapshot(options(box));
    assert.equal(snapshot.records.length, 1);
    assert.equal(snapshot.records[0].occurrence_count, 32, `round ${round}`);
    assert.equal(snapshot.latest_sequence, 32, `round ${round}`);
    assert.equal((await stat(runtimeErrorLockPath(box.storePath))).mode & 0o777, 0o600);
  }
});

test('runtime store rejects duplicate record sequences', async () => {
  const box = await sandbox();
  await observeRuntimeError('daemon_transport', options(box));
  await observeRuntimeError('daemon_persistence', options(box));
  const store = JSON.parse(await readFile(box.storePath, 'utf8'));
  store.records[1].sequence = store.records[0].sequence;
  await writeFile(box.storePath, JSON.stringify(store));
  await assert.rejects(readRuntimeErrorSnapshot(options(box)), {
    code: 'E_RUNTIME_ERROR_STORE',
    message: 'duplicate runtime error sequence',
  });
});

test('resolve rejects clock rollback before mutation and store validation rejects regressed resolved_at', async () => {
  const box = await sandbox();
  const observed = await observeRuntimeError('daemon_transport', options(box, {
    now: () => new Date('2026-07-13T00:00:05.000Z'),
  }));
  await assert.rejects(resolveRuntimeError({ fingerprint: observed.fingerprint }, options(box, {
    now: () => new Date('2026-07-13T00:00:04.000Z'),
  })), {
    code: 'E_RUNTIME_ERROR_INPUT',
    message: 'resolution timestamp precedes last observation',
  });
  let snapshot = await readRuntimeErrorSnapshot(options(box));
  assert.equal(snapshot.records[0].status, 'open');
  assert.equal(snapshot.records[0].sequence, 1);
  assert.equal(snapshot.latest_sequence, 1);

  await resolveRuntimeError({ fingerprint: observed.fingerprint }, options(box, {
    now: () => new Date('2026-07-13T00:00:06.000Z'),
  }));
  const store = JSON.parse(await readFile(box.storePath, 'utf8'));
  store.records[0].resolved_at = '2026-07-13T00:00:04.000Z';
  await writeFile(box.storePath, JSON.stringify(store));
  await assert.rejects(readRuntimeErrorSnapshot(options(box)), { code: 'E_RUNTIME_ERROR_STORE' });
  snapshot = await readRuntimeErrorStoreStatus(options(box));
  assert.equal(snapshot.store, 'unavailable');
});

test('receipt ledger uses an exact {id,fingerprint} schema', async () => {
  const box = await sandbox();
  await observeRuntimeError('daemon_transport', options(box, { observationId: 'f'.repeat(32) }));
  const store = JSON.parse(await readFile(box.storePath, 'utf8'));
  store.receipts[0].extra = '/Users/private';
  await writeFile(box.storePath, JSON.stringify(store));
  await assert.rejects(readRuntimeErrorSnapshot(options(box)), {
    code: 'E_RUNTIME_ERROR_STORE',
    message: 'invalid runtime error receipt',
  });
});

test('runtime worker rejects extra fields, mismatched receipt IDs, and non-canonical argv', async () => {
  const box = await sandbox();
  const observationId = 'a'.repeat(32);
  const base = {
    configPath: box.configPath,
    storePath: box.storePath,
    productVersion: '1.4.22',
    platform: box.platform,
    arch: 'arm64',
    observationId,
  };
  const receiptBase = {
    ...base,
    expectedFingerprint: runtimeErrorFingerprint(RUNTIME_ERROR_DEFINITIONS.daemon_transport),
  };
  for (const argv of [
    ['unknown', 'daemon_transport', encodeWorkerOptions(base)],
    ['observe', 'daemon_transport', encodeWorkerOptions({ ...base, raw: '/Users/private' })],
    ['receipt', 'b'.repeat(32), encodeWorkerOptions(receiptBase)],
    ['receipt', observationId, encodeWorkerOptions({ ...receiptBase, expectedFingerprint: 'bad' })],
    ['observe', 'daemon_transport'],
  ]) {
    const result = await runChild(process.execPath, [runtimeWorkerPath, ...argv], {
      env: { ...process.env, SPOTTER_RUNTIME_ERROR_WORKER: '1' },
    });
    assert.equal(result.code, 2, argv.join(' '));
  }
});

test('Windows ACL script rebuilds current-SID-only DACL and verifies readback', () => {
  const script = buildWindowsAclPowerShell({ directory: false });
  assert.match(script, /SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(script, /SecurityIdentifier/);
  assert.match(script, /SetAccessControl/);
  assert.match(script, /GetAccessControl/);
  assert.match(script, /AccessControlType/);
  assert.doesNotMatch(script, /Everyone|Authenticated Users|BUILTIN\\Users/);
});

test('runtime error safe observer never stops Spotter and emits one fixed diagnostic', async () => {
  const box = await sandbox();
  const stderr = [];
  const result = await observeRuntimeErrorSafe('daemon_transport', options(box, {
    atomicWriteFn: async () => { throw new Error('SENTINEL_SECRET'); },
    writeError: (text) => stderr.push(text),
  }));
  assert.equal(result.collected, false);
  assert.deepEqual(stderr, ['spotter-runtime-errors: local aggregate store unavailable\n']);
  assert.doesNotMatch(stderr.join(''), /SENTINEL_SECRET/);
});

test('runtime error diagnostics are bounded and expose no store/config path or payload', async () => {
  const box = await sandbox();
  await observeRuntimeError('auditor_unavailable', options(box));
  const status = await readRuntimeErrorStoreStatus(options(box));
  assert.deepEqual(Object.keys(status).sort(), [
    'acknowledged_through', 'collection', 'latest_sequence', 'open', 'records', 'resolved', 'schema', 'store', 'unacknowledged',
  ]);
  const serialized = JSON.stringify(status);
  assert.doesNotMatch(serialized, new RegExp(box.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(serialized, /message_template|error_code|fingerprint/);
});

test('runtime error snapshot rejects a tampered non-registry template instead of reflecting it', async () => {
  const box = await sandbox();
  await observeRuntimeError('daemon_transport', options(box));
  const store = JSON.parse(await readFile(box.storePath, 'utf8'));
  store.records[0].message_template = 'SENTINEL_PROMPT_OR_PATH_/Users/private';
  await writeFile(box.storePath, JSON.stringify(store));
  await assert.rejects(readRuntimeErrorSnapshot(options(box)), { code: 'E_RUNTIME_ERROR_STORE' });
  const status = await readRuntimeErrorStoreStatus(options(box));
  assert.equal(status.store, 'unavailable');
  assert.doesNotMatch(JSON.stringify(status), /SENTINEL|Users|private/);
});

test('runtime error diagnostics command forwards only bounded cursor and limit', async () => {
  const calls = [];
  const output = [];
  await runRuntimeErrorDiagnosticsCommand({
    argv: ['--after-cursor', '7', '--limit', '25'],
    readSnapshotFn: async (input) => { calls.push(input); return { schema: 'safe' }; },
    writeOutput: (text) => output.push(text),
  });
  assert.deepEqual(calls, [{ afterCursor: 7, limit: 25 }]);
  assert.equal(output.join(''), '{"schema":"safe"}\n');
  await assert.rejects(runRuntimeErrorDiagnosticsCommand({ argv: ['--limit', '0'] }), { exitCode: 2 });
});

test('runtime error diagnostics command owns ack/resolve/reopen/compact lifecycle actions', async () => {
  const calls = [];
  const output = [];
  const fingerprint = 'a'.repeat(64);
  const dependencies = {
    writeOutput: (text) => output.push(text),
    acknowledgeFn: async (input) => { calls.push(['ack', input]); return { ok: 'ack' }; },
    resolveFn: async (input) => { calls.push(['resolve', input]); return { ok: 'resolve' }; },
    reopenFn: async (input) => { calls.push(['reopen', input]); return { ok: 'reopen' }; },
    compactFn: async () => { calls.push(['compact']); return { ok: 'compact' }; },
  };
  await runRuntimeErrorDiagnosticsCommand({ ...dependencies, argv: ['ack', '7'] });
  await runRuntimeErrorDiagnosticsCommand({ ...dependencies, argv: ['resolve', fingerprint] });
  await runRuntimeErrorDiagnosticsCommand({ ...dependencies, argv: ['reopen', fingerprint] });
  await runRuntimeErrorDiagnosticsCommand({ ...dependencies, argv: ['compact'] });
  assert.deepEqual(calls, [
    ['ack', { cursor: 7 }], ['resolve', { fingerprint }], ['reopen', { fingerprint }], ['compact'],
  ]);
  assert.equal(output.length, 4);
});

test('runtime error store implementation has no network transport dependency', async () => {
  const source = await readFile(new URL('../src/core/runtime-error-store.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:(?:http|https|net|tls)|\bfetch\s*\(|XMLHttpRequest|WebSocket/);
});
