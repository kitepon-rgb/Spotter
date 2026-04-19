// `spotter install` — create ~/.spotter/, place template catalog, register hooks in .claude/settings.json.
//
// Per plan §15.4, this shows a diff and asks for confirmation before touching settings.json.

import { mkdir, writeFile, readFile, access, copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..', '..');
const TEMPLATE_CATALOG = join(PACKAGE_ROOT, 'templates', 'tools.yaml');
const SPOTTER_BIN = join(PACKAGE_ROOT, 'bin', 'spotter.mjs');

const SPOTTER_HOME = join(homedir(), '.spotter');
const CATALOG_DEST = join(SPOTTER_HOME, 'tool-catalog', 'tools.yaml');

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

  // 3. compute desired settings.json with hooks
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
