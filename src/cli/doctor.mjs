// `spotter doctor` — environment diagnostic.

import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadCatalog } from '../catalog/loader.mjs';

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
  for (const sub of ['tool-catalog', 'runtime', 'workdir', 'logs']) {
    const path = join(home, sub);
    const ok = await exists(path);
    mark(ok, `dir ${path}`);
    if (!ok) warnings += 1;
  }

  // catalog
  const catalogPath = join(home, 'tool-catalog', 'tools.yaml');
  try {
    const cat = await loadCatalog(catalogPath);
    mark(true, `catalog: ${cat.tools.length} tools at ${catalogPath}`);
  } catch (err) {
    mark(false, 'catalog', err.message);
    failures += 1;
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
