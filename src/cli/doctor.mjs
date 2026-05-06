// `spotter doctor` — environment diagnostic.

import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadDb, globalDbPath, localDbPath } from '../tool-db/loader.mjs';
import { findSpotterMarker } from '../hooks/lib.mjs';
import { codexHookDiagnostics } from './codex-hook-cmd.mjs';

const execFileP = promisify(execFile);

export async function runDoctor() {
  console.log('spotter doctor');
  let warnings = 0;
  let failures = 0;

  // Node version
  const nodeVersion = process.versions.node;
  const major = parseInt(nodeVersion.split('.')[0], 10);
  const minor = parseInt(nodeVersion.split('.')[1], 10);
  const okNode = major > 22 || (major === 22 && minor >= 5);
  mark(okNode, `Node.js ${nodeVersion}`, 'need >= 22.5');
  if (!okNode) failures += 1;

  // claude CLI — on Windows the entry is `claude.cmd`; route through cmd.exe /c
  // rather than shell:true (DEP0190 on Node 24+).
  try {
    const opts = { timeout: 5_000, windowsHide: true };
    const { stdout } = process.platform === 'win32'
      ? await execFileP('cmd.exe', ['/c', 'claude', '--version'], opts)
      : await execFileP('claude', ['--version'], opts);
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
    const { stdout } = await execFileP('codex', ['--version'], { timeout: 5_000, windowsHide: true });
    mark(true, `codex CLI: ${stdout.trim()}`);
  } catch (err) {
    mark(false, 'codex CLI', `not found or failed: ${err.message}`);
    warnings += 1;
  }

  try {
    const diagnostics = await codexHookDiagnostics();
    const hooksOk = diagnostics.availability === 'available';
    mark(
      hooksOk,
      `codex hooks: ${diagnostics.availability}`,
      `feature=${diagnostics.codexHooksFeature}, session_start=${diagnostics.installedHooks.sessionStart}, user_prompt=${diagnostics.installedHooks.userPromptSubmit}, stop=${diagnostics.installedHooks.stop}`
    );
    if (!hooksOk) warnings += 1;
  } catch (err) {
    mark(false, 'codex hooks diagnostics', err.message);
    warnings += 1;
  }

  if (projectRoot) {
    const sidecar = await codexSidecarAuditorReadiness(projectRoot);
    mark(sidecar.ok, `codex-sidecar auditor: ${sidecar.status}`, sidecar.detail);
    if (!sidecar.ok) warnings += 1;
  }

  // tool-db (global cache). Since v1.2.0 this is not part of daemon audit input;
  // the daemon audits the project-local DB only. Empty global cache is fine.
  try {
    const global = await loadDb(globalDbPath());
    const count = Object.keys(global.tools).length;
    mark(true, `global cache DB: ${count} tools at ${globalDbPath()}`);
  } catch (err) {
    mark(false, 'global cache DB', `${err.message} (cache only; daemon audits local DB)`);
    warnings += 1;
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
    const { stdout } = await execFileP(cmd, finalArgs, {
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
