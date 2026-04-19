// `spotter install` — create ~/.spotter/, place template catalog, register hooks in .claude/settings.json.
//
// Per plan §15.4, this shows a diff and asks for confirmation before touching settings.json.
//
// v0.3: also writes <cwd>/.spotter/marker.json (project mode) so hooks can detect
// "this Claude Code session is rooted in a project where Spotter is installed" and
// silently exit otherwise (prevents Throughline-style proliferation).

import { mkdir, writeFile, readFile, access, copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { version as SPOTTER_VERSION } from '../version.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..', '..');
const TEMPLATE_CATALOG = join(PACKAGE_ROOT, 'templates', 'tools.yaml');
const SPOTTER_BIN = join(PACKAGE_ROOT, 'bin', 'spotter.mjs');

const SPOTTER_HOME = join(homedir(), '.spotter');
const CATALOG_DEST = join(SPOTTER_HOME, 'tool-catalog', 'tools.yaml');

const MARKER_VERSION = '1';

const HOOK_EVENTS = [
  { event: 'SessionStart', sub: 'session-start', timeout: 5 },
  { event: 'UserPromptSubmit', sub: 'user-prompt', timeout: 30 },
  { event: 'PreToolUse', sub: 'pre-tool-use', timeout: 2 },
  { event: 'Stop', sub: 'stop', timeout: 15 },
  { event: 'SessionEnd', sub: 'session-end', timeout: 3 },
];

export async function runInstall({ target = 'project', autoYes = false, cwd = process.cwd() } = {}) {
  const settingsPath = target === 'user'
    ? join(homedir(), '.claude', 'settings.json')
    : join(cwd, '.claude', 'settings.json');

  console.log('spotter install');
  console.log(`  package: ${PACKAGE_ROOT}`);
  console.log(`  settings: ${settingsPath}`);

  // 1. create directories
  await mkdir(SPOTTER_HOME, { recursive: true });
  await mkdir(join(SPOTTER_HOME, 'tool-catalog'), { recursive: true });
  await mkdir(join(SPOTTER_HOME, 'runtime'), { recursive: true });
  await mkdir(join(SPOTTER_HOME, 'workdir'), { recursive: true });
  await mkdir(join(SPOTTER_HOME, 'logs'), { recursive: true });

  // 2. place catalog template if missing
  if (!(await exists(CATALOG_DEST))) {
    await copyFile(TEMPLATE_CATALOG, CATALOG_DEST);
    console.log(`  wrote ${CATALOG_DEST}`);
  } else {
    console.log(`  catalog already present at ${CATALOG_DEST} (not overwritten)`);
  }

  // 3. project marker (v0.3): hooks use this to detect installed projects.
  //    Skipped in user-mode install — user-mode is a deprecated escape hatch and
  //    intentionally has no marker, so all hooks would exit. (Existing user-mode
  //    installs from <0.3 won't surprise-stop working only because of this — they
  //    were already broken by daemon proliferation.)
  //
  //    Always overwritten so that `spotter install` after a version bump refreshes
  //    `spotterVersion` / `installedAt` rather than leaving stale metadata.
  if (target === 'project') {
    const markerDir = join(cwd, '.spotter');
    const markerPath = join(markerDir, 'marker.json');
    await mkdir(markerDir, { recursive: true });
    const marker = {
      markerVersion: MARKER_VERSION,
      spotterVersion: SPOTTER_VERSION,
      installedAt: new Date().toISOString(),
    };
    await writeFile(markerPath, JSON.stringify(marker, null, 2) + '\n', 'utf8');
    console.log(`  wrote ${markerPath}`);
  }

  // 4. compute desired settings.json with hooks
  const current = await loadSettings(settingsPath);
  const updated = mergeHooks(current);
  const diff = diffSettings(current, updated);

  if (diff === null) {
    console.log('  hooks already registered — nothing to change');
    return;
  }

  console.log('\n--- proposed .claude/settings.json changes ---');
  console.log(diff);
  console.log('---------------------------------------------\n');

  if (!autoYes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('apply these changes? [y/N] ');
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log('aborted.');
      return;
    }
  }

  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(updated, null, 2) + '\n', 'utf8');
  console.log(`wrote ${settingsPath}`);
  console.log('\nnext: reload Claude Code (or open a new session) to activate Spotter.');
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function loadSettings(path) {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

function mergeHooks(current) {
  const next = structuredClone(current);
  next.hooks = next.hooks ?? {};

  for (const { event, sub, timeout } of HOOK_EVENTS) {
    const command = `node "${SPOTTER_BIN}" hook ${sub}`;
    const hookEntry = { type: 'command', command, timeout };
    const groups = next.hooks[event] = next.hooks[event] ?? [];

    // Dedup: skip if an identical spotter command is already present
    const alreadyHas = groups.some((g) =>
      Array.isArray(g.hooks) &&
      g.hooks.some((h) => h?.type === 'command' && h?.command?.includes('spotter.mjs') && h?.command?.includes(`hook ${sub}`))
    );
    if (alreadyHas) continue;

    groups.push({ hooks: [hookEntry] });
  }
  return next;
}

function diffSettings(current, updated) {
  const a = JSON.stringify(current, null, 2);
  const b = JSON.stringify(updated, null, 2);
  if (a === b) return null;
  return `BEFORE:\n${a}\n\nAFTER:\n${b}`;
}
