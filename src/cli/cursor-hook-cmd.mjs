import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnRefreshDetached } from '../hooks/spawn-daemon.mjs';
import {
  die,
  findSpotterMarker,
  isChildCall,
  readStdinJson,
} from '../hooks/lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..', '..');
const SPOTTER_BIN = join(PACKAGE_ROOT, 'bin', 'spotter.mjs');
const CURSOR_SESSION_START_TIMEOUT_SEC = 5;
const CURSOR_HOOK_FRAGMENT = 'cursor-hook session-start';

const CURSOR_HOOK_USAGE = `spotter cursor-hook — Cursor native hook adapter

Usage:
  spotter cursor-hook install [--cursor-home DIR]
  spotter cursor-hook uninstall [--cursor-home DIR]
  spotter cursor-hook diagnostics [--cursor-home DIR]
  spotter cursor-hook session-start

Installs a Cursor sessionStart hook that refreshes tool-db.cursor.json.
Does not convert the Cursor envelope to Claude shape. Factory hooks stay in place.
`;

export async function runCursorHookCommand({ argv = process.argv.slice(2) } = {}) {
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') {
    process.stdout.write(CURSOR_HOOK_USAGE);
    return;
  }
  if (sub === 'install') {
    const opts = parseCursorHomeArgs(argv.slice(1));
    const result = await installCursorHooks({ cursorHome: opts.cursorHome });
    process.stdout.write(`${JSON.stringify({
      installation: result.hooks.sessionStart === 'unchanged' ? 'already_wired' : 'wired',
      hooksPath: result.hooksPath,
      hooks: result.hooks,
    }, null, 2)}\n`);
    return;
  }
  if (sub === 'uninstall') {
    const opts = parseCursorHomeArgs(argv.slice(1));
    const result = await uninstallCursorHooks({ cursorHome: opts.cursorHome });
    process.stdout.write(`${JSON.stringify({
      hooksPath: result.hooksPath,
      hooks: result.hooks,
    }, null, 2)}\n`);
    return;
  }
  if (sub === 'diagnostics') {
    const opts = parseCursorHomeArgs(argv.slice(1));
    const result = cursorHookDiagnostics({ cursorHome: opts.cursorHome });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (sub === 'session-start') {
    await runCursorSessionStartHook();
    return;
  }
  process.stderr.write(`unknown cursor-hook subcommand: ${sub}\n${CURSOR_HOOK_USAGE}`);
  process.exit(2);
}

export async function runCursorSessionStartHook({
  readInput = readStdinJson,
  spawnRefreshDetachedFn = spawnRefreshDetached,
} = {}) {
  if (isChildCall()) return;
  const input = await readInput();
  const cwd = cursorCwd(input);
  if (!cwd) return;
  const projectRoot = findSpotterMarker(cwd);
  if (!projectRoot) return;
  spawnRefreshDetachedFn({ projectRoot, hostAgent: 'cursor' });
}

export function cursorCwd(input) {
  if (typeof input?.cwd === 'string' && input.cwd.length > 0) return input.cwd;
  const root = input?.workspace_roots?.[0];
  if (typeof root === 'string' && root.length > 0) return root;
  return null;
}

export async function installCursorHooks({
  cursorHome = defaultCursorHome(),
  nodePath = process.execPath,
  spotterBin = SPOTTER_BIN,
} = {}) {
  const hooksPath = join(cursorHome, 'hooks.json');
  const file = await loadCursorHooks(hooksPath);
  const command = hookCommand(nodePath, spotterBin);
  const sessionStart = upsertSessionStart(file, command);
  if (sessionStart === 'added') await persistCursorHooks(hooksPath, file);
  return {
    cursorHome,
    hooksPath,
    hooks: { sessionStart },
  };
}

export async function uninstallCursorHooks({
  cursorHome = defaultCursorHome(),
} = {}) {
  const hooksPath = join(cursorHome, 'hooks.json');
  const file = await loadCursorHooks(hooksPath);
  const removed = removeSessionStart(file);
  if (removed) await persistCursorHooks(hooksPath, file);
  return {
    cursorHome,
    hooksPath,
    hooks: { sessionStart: removed ? 'removed' : 'not present' },
  };
}

export function cursorHookDiagnostics({ cursorHome = defaultCursorHome() } = {}) {
  const hooksPath = join(cursorHome, 'hooks.json');
  const present = existsSync(hooksPath);
  const file = present ? JSON.parse(readFileSync(hooksPath, 'utf8')) : { version: 1, hooks: {} };
  if (file === null || typeof file !== 'object' || Array.isArray(file)) {
    return {
      installation: 'not-installed',
      cursorHome,
      hooksPath,
      installedHooks: { sessionStart: false },
    };
  }
  if (file.hooks == null || typeof file.hooks !== 'object' || Array.isArray(file.hooks)) {
    file.hooks = {};
  }
  const installed = listFor(file, 'sessionStart').some((entry) => isSpotterCursorHook(entry));
  return {
    installation: installed ? 'installed' : 'not-installed',
    cursorHome,
    hooksPath,
    installedHooks: { sessionStart: installed },
  };
}

export function isCursorHomePresent(cursorHome = defaultCursorHome()) {
  return existsSync(cursorHome);
}

function defaultCursorHome() {
  return join(homedir(), '.cursor');
}

function parseCursorHomeArgs(argv) {
  let cursorHome = defaultCursorHome();
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--cursor-home') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw Object.assign(new Error('--cursor-home requires a value'), { exitCode: 2 });
      }
      cursorHome = value;
      index += 1;
    }
  }
  return { cursorHome };
}

function hookCommand(nodePath, spotterBin) {
  return `${quoteArg(nodePath)} ${quoteArg(spotterBin)} cursor-hook session-start`;
}

function quoteArg(value) {
  const text = String(value);
  if (!/[\s"']/.test(text)) return text;
  return `"${text.replaceAll('"', '\\"')}"`;
}

function isSpotterCursorHook(entry) {
  return typeof entry?.command === 'string' && entry.command.includes(CURSOR_HOOK_FRAGMENT);
}

function listFor(file, event) {
  const current = file.hooks?.[event];
  return Array.isArray(current) ? current : [];
}

function upsertSessionStart(file, command) {
  file.hooks ??= {};
  const list = listFor(file, 'sessionStart');
  for (const entry of list) {
    if (typeof entry.command !== 'string') continue;
    if (entry.command === command && entry.timeout === CURSOR_SESSION_START_TIMEOUT_SEC) {
      return 'unchanged';
    }
    if (entry.command === command || isSpotterCursorHook(entry)) {
      entry.command = command;
      entry.timeout = CURSOR_SESSION_START_TIMEOUT_SEC;
      file.hooks.sessionStart = list;
      return 'added';
    }
  }
  list.push({ command, timeout: CURSOR_SESSION_START_TIMEOUT_SEC });
  file.hooks.sessionStart = list;
  return 'added';
}

function removeSessionStart(file) {
  const list = listFor(file, 'sessionStart');
  const kept = list.filter((entry) => !isSpotterCursorHook(entry));
  if (kept.length === list.length) return false;
  if (kept.length > 0) file.hooks.sessionStart = kept;
  else delete file.hooks.sessionStart;
  return true;
}

async function loadCursorHooks(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${path} は object である必要があります`);
    }
    if (parsed.hooks == null) parsed.hooks = {};
    if (typeof parsed.hooks !== 'object' || Array.isArray(parsed.hooks)) {
      throw new Error(`${path} の hooks は object である必要があります`);
    }
    return parsed;
  } catch (err) {
    if (err?.code === 'ENOENT') return { version: 1, hooks: {} };
    throw err;
  }
}

async function persistCursorHooks(path, file) {
  await mkdir(dirname(path), { recursive: true });
  file.version = file.version ?? 1;
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  runCursorHookCommand().catch((err) => die(err.message, err.exitCode ?? 2));
}
