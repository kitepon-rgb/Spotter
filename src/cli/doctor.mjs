// `spotter doctor` — environment diagnostic.

import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadDb, globalDbPath, localDbPath } from '../tool-db/loader.mjs';
import { findSpotterMarker } from '../hooks/lib.mjs';

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

  // tool-db (local) if cwd is inside a Spotter project
  const projectRoot = findSpotterMarker(process.cwd());
  if (projectRoot) {
    try {
      const local = await loadDb(localDbPath(projectRoot));
      const count = Object.keys(local.tools).length;
      mark(true, `local audit DB: ${count} tools at ${localDbPath(projectRoot)}`);
    } catch (err) {
      mark(false, 'local audit DB', err.message);
      failures += 1;
    }
  }

  console.log('');
  if (failures > 0) {
    console.log(`result: ${failures} failure(s), ${warnings} warning(s)`);
    process.exit(1);
  }
  console.log(`result: OK (${warnings} warnings)`);
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
