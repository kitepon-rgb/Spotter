// `spotter doctor` — environment diagnostic.

import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadDb, globalDbPath, localDbPath } from '../tool-db/loader.mjs';
import { findSpotterMarker } from '../hooks/lib.mjs';
import { codexHookDiagnostics } from './codex-hook-cmd.mjs';
import { buildWindowsCompatibleInvocation, execFileWindowsSafe } from '../platform/spawn.mjs';

const execFileP = promisify(execFile);

export async function runDoctor() {
  console.log('spotter doctor');
  let warnings = 0;
  let failures = 0;

  // Node version
  const nodeVersion = process.versions.node;
  const okNode = isSupportedNodeVersion(nodeVersion);
  mark(okNode, `Node.js ${nodeVersion}`, 'need >= 22.13');
  if (!okNode) failures += 1;

  // claude CLI — Windows の .cmd shim 解決は src/platform/spawn.mjs が所有する。
  try {
    const { stdout } = await execFileWindowsSafe('claude', ['--version'], { timeout: 5_000 });
    mark(true, `claude CLI: ${stdout.trim()}`);
  } catch (err) {
    mark(false, 'claude CLI', `not found or failed: ${err.message}`);
    failures += 1;
  }

  // ~/.spotter directories
  const home = join(homedir(), '.spotter');
  for (const sub of ['runtime', 'workdir', 'logs']) {
    const path = join(home, sub);
    const ok = await exists(path);
    mark(ok, `dir ${path}`);
    if (!ok) warnings += 1;
  }

  const projectRoot = findSpotterMarker(process.cwd());

  // Codex native readiness. These are warnings because Claude-backed installs may
  // still be valid, but Codex-first tuning needs the signal in one place.
  try {
    const version = await inspectCodexCliVersion();
    mark(true, `codex CLI: ${version}`);
  } catch (err) {
    mark(false, 'codex CLI', `not found or failed: ${err.message}`);
    warnings += 1;
  }

  try {
    const hookConfiguration = await inspectCodexHookConfiguration({ projectRoot });
    mark(
      hookConfiguration.ok,
      `codex hook configuration: ${hookConfiguration.diagnostics.readiness}`,
      hookConfiguration.detail,
    );
    if (!hookConfiguration.ok) warnings += 1;
  } catch (err) {
    mark(false, 'codex hooks diagnostics', err.message);
    warnings += 1;
  }

  if (projectRoot) {
    const sidecar = await codexSidecarAuditorReadiness(projectRoot);
    mark(sidecar.ok, `codex-sidecar auditor: ${sidecar.status}`, sidecar.detail);
    if (!sidecar.ok) warnings += 1;

    const auditorContext = await inspectAuditorContextConfiguration({ projectRoot });
    mark(auditorContext.ok, `evaluation context: ${auditorContext.mode}`, auditorContext.detail);
    if (!auditorContext.ok) warnings += 1;
  }

  // tool-db (host-specific global caches). Since v1.2.0 these are not part of
  // audit input; each host audits its project-local DB only. Empty caches are fine.
  for (const hostAgent of ['claude', 'codex']) {
    try {
      const path = globalDbPath(hostAgent);
      const global = await loadDb(path);
      const count = Object.keys(global.tools).length;
      mark(true, `${hostAgent} global cache DB: ${count} tools at ${path}`);
    } catch (err) {
      mark(false, `${hostAgent} global cache DB`, `${err.message} (cache only; audit uses local DB)`);
      warnings += 1;
    }
  }

  // tool-db (local) if cwd is inside a Spotter project. Claude and Codex use
  // separate host-local files so one host cannot prune the other's tool list.
  if (projectRoot) {
    const claudeDb = await checkLocalAuditDb({ projectRoot, hostAgent: 'claude' });
    mark(claudeDb.ok, `claude local audit DB: ${claudeDb.count} tools at ${claudeDb.path}`, claudeDb.detail);
    if (!claudeDb.ok) warnings += 1;

    const codexDb = await checkLocalAuditDb({ projectRoot, hostAgent: 'codex' });
    mark(codexDb.ok, `codex local audit DB: ${codexDb.count} tools at ${codexDb.path}`, codexDb.detail);
    if (!codexDb.ok) warnings += 1;
  }

  console.log('');
  if (failures > 0) {
    console.log(`result: ${failures} failure(s), ${warnings} warning(s)`);
    process.exit(1);
  }
  console.log(`result: OK (${warnings} warnings)`);
}

export function isSupportedNodeVersion(value) {
  if (typeof value !== 'string' || !/^\d+\.\d+(?:\.\d+)?(?:[-+].*)?$/.test(value)) return false;
  const [major, minor] = value.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}

export async function inspectCodexCliVersion({
  codexBin = 'codex',
  platform = process.platform,
  env = process.env,
  execFileFn = execFileP,
} = {}) {
  const invocation = buildWindowsCompatibleInvocation({
    command: codexBin,
    args: ['--version'],
    platform,
    env,
  });
  const { stdout } = await execFileFn(invocation.command, invocation.args, {
    timeout: 5_000,
    windowsHide: true,
  });
  return stdout.trim();
}

export async function inspectCodexHookConfiguration({ projectRoot = null, diagnosticsFn = codexHookDiagnostics } = {}) {
  const diagnostics = await diagnosticsFn({ projectRoot });
  const issues = Object.entries(diagnostics.validation ?? {})
    .flatMap(([event, value]) => (value.issues ?? []).map((issue) => `${event}:${issue}`));
  return {
    ok: diagnostics.readiness === 'configured-unverified',
    diagnostics,
    detail: [
      `availability=${diagnostics.availability}`,
      `issues=${issues.join(',') || 'none'}`,
      `trust=${diagnostics.trust?.state ?? 'unknown'}`,
      `auditor-backend=${diagnostics.auditorBackend ?? 'unknown'}`,
      formatCodexAuditorModelSelection({
        backend: diagnostics.auditorBackend,
        selection: diagnostics.auditorModelSelection,
      }),
      diagnostics.trust?.action ?? 'review with /hooks',
    ].filter(Boolean).join('; '),
  };
}

export async function inspectAuditorContextConfiguration({
  projectRoot,
  readFileFn = readFile,
  accessFn = access,
} = {}) {
  const disabled = { ok: true, mode: 'disabled', detail: 'disabled' };
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) return disabled;

  let marker;
  try {
    marker = JSON.parse(await readFileFn(join(projectRoot, '.spotter', 'marker.json'), 'utf8'));
  } catch {
    return { ok: false, mode: 'unknown', detail: 'marker unreadable' };
  }

  const config = marker?.auditorContext;
  if (config === undefined) return disabled;
  if (config?.mode === 'disabled') {
    if (config.origin === 'explicit') return { ok: true, mode: 'disabled', detail: 'explicit project opt-out' };
    if (config.reason === 'throughline_unavailable') {
      return { ok: true, mode: 'disabled', detail: 'default disabled: Throughline unavailable' };
    }
    return disabled;
  }
  if (config?.mode !== 'throughline') {
    return { ok: false, mode: 'unknown', detail: 'invalid configuration' };
  }
  if (
    typeof config.command !== 'string' ||
    !isAbsolute(config.command) ||
    /\.(?:cmd|bat)$/i.test(config.command) ||
    !Array.isArray(config.args) ||
    config.args.some((arg) => typeof arg !== 'string' || arg.length === 0)
  ) {
    return { ok: false, mode: 'throughline', detail: 'invalid configuration' };
  }
  try {
    await accessFn(config.command);
  } catch {
    return { ok: false, mode: 'throughline', detail: 'command unavailable' };
  }
  return { ok: true, mode: 'throughline', detail: 'command available' };
}

function formatCodexAuditorModelSelection({ backend, selection }) {
  if (backend && backend !== 'codex-cli') return 'auditor-model=not-applicable';
  if (!selection || typeof selection !== 'object') return 'auditor-model=unknown';
  return `auditor-model=${selection.effectiveModel ?? 'unknown'} effort=${selection.effectiveReasoningEffort ?? 'unknown'} source=${selection.modelSource ?? 'unknown'}/${selection.effortSource ?? 'unknown'} availability=${selection.availability ?? 'unknown'}`;
}

async function checkLocalAuditDb({ projectRoot, hostAgent }) {
  const path = localDbPath(projectRoot, hostAgent);
  const present = await exists(path);
  try {
    const db = await loadDb(path);
    const count = Object.keys(db.tools).length;
    return {
      ok: present,
      count,
      path,
      detail: present ? null : `missing; run spotter db refresh --host-agent ${hostAgent}`,
    };
  } catch (err) {
    return { ok: false, count: 0, path, detail: err.message };
  }
}

async function codexSidecarAuditorReadiness(projectRoot) {
  const args = ['diagnostics', '--project', projectRoot, '--preset', 'auditor', '--json'];
  const cliPath = process.env.SPOTTER_CODEX_SIDECAR_CLI_PATH;
  const cmd = cliPath ? process.execPath : 'codex-sidecar';
  const finalArgs = cliPath ? [cliPath, ...args] : args;
  try {
    const invocation = buildWindowsCompatibleInvocation({
      command: cmd,
      args: finalArgs,
      env: process.env,
      allowCmdFallback: false,
    });
    const { stdout } = await execFileP(invocation.command, invocation.args, {
      timeout: 15_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    const parsed = JSON.parse(stdout);
    const ok = parsed?.status === 'ok' && parsed?.normalizedRequest?.workflow === 'auditor';
    return {
      ok,
      status: ok ? 'available' : 'unavailable',
      detail: ok
        ? `workflow=${parsed.normalizedRequest.workflow}, reasoning=${parsed.normalizedRequest.modelReasoningEffort ?? 'default'}`
        : `unexpected diagnostics: status=${parsed?.status ?? 'unknown'}`,
    };
  } catch (err) {
    const stderr = typeof err?.stderr === 'string' && err.stderr.trim() ? ` stderr=${err.stderr.trim().split('\n').slice(-1)[0]}` : '';
    return {
      ok: false,
      status: 'unavailable',
      detail: `${err.message}${stderr}`,
    };
  }
}

async function exists(path) {
  try { await access(path); return true; }
  catch { return false; }
}

function mark(ok, label, detail) {
  const icon = ok ? 'OK ' : 'NG ';
  const line = detail ? `${label} — ${detail}` : label;
  console.log(`  ${icon} ${line}`);
}
