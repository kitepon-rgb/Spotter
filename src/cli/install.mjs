// `spotter install` — create ~/.spotter/, register Claude hooks, and register
// Codex native hooks when the Codex CLI is available.
//
// Per plan §15.4, this shows a diff and asks for confirmation before touching settings.json.
//
// v0.3: also writes <cwd>/.spotter/marker.json (project mode) so hooks can detect
// "this Claude Code session is rooted in a project where Spotter is installed" and
// silently exit otherwise (prevents Throughline-style proliferation).
//
// v0.7.0: tool catalog (the old YAML) is replaced by tool-db.json (auto-discovered MCP
// servers, skills, sub-agents — see docs/01_catalog-design.md for v1.0.0 scope).
// Install seeds the DB automatically via `refresh` (project-mode only — user-mode
// has no projectRoot so DB seeding is skipped there).

import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { version as SPOTTER_VERSION } from '../version.mjs';
import { refresh } from '../tool-db/refresh.mjs';
import { localDbPath, globalDbPath } from '../tool-db/loader.mjs';
import { installCodexHooks } from './codex-hook-cmd.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..', '..');
const SPOTTER_BIN = join(PACKAGE_ROOT, 'bin', 'spotter.mjs');

const SPOTTER_HOME = join(homedir(), '.spotter');

const MARKER_VERSION = '1';

// v1.3.0: UserPromptSubmit / Stop を 60s に統一。理由:
// - daemon 側 Haiku timeout は 45s (DEFAULT_HAIKU_TIMEOUT_MS @ daemon.mjs)
// - hook → daemon IPC 往復・JSON parse・log fsync を加味すると ~50s が上限
// - Claude Code 本体は settings.json の timeout で hook を kill するので、ここが最も狭い
// 旧値 (UserPromptSubmit=30 / Stop=15) は v0.13.1 の Haiku timeout 緩和 (30→45s) を
// 反映しておらず、Chime 等の preamble が大きい (93 KB / 357 件) 環境で daemon が
// 24-32s かけて正常応答を返している最中に Claude Code 側で hook が timeout で
// 切られ、ユーザー視点の「チャット入力無反応」を誘発していた。docs/open-issues.md
// の「install.mjs の hook timeout が v0.13.1 緩和を反映していない」項目を閉じる。
const HOOK_EVENTS = [
  { event: 'SessionStart', sub: 'session-start', timeout: 5 },
  { event: 'UserPromptSubmit', sub: 'user-prompt', timeout: 60 },
  { event: 'PreToolUse', sub: 'pre-tool-use', timeout: 2 },
  { event: 'Stop', sub: 'stop', timeout: 60 },
  { event: 'SessionEnd', sub: 'session-end', timeout: 3 },
];

export async function runInstall({
  target = 'project',
  autoYes = false,
  cwd = process.cwd(),
  skipRefresh = false,
  skipCodexHooks = skipRefresh,
  refreshFn = refresh,
  codexCliPresentFn = isCodexCliPresent,
  installCodexHooksFn = installCodexHooks,
} = {}) {
  const settingsPath = target === 'user'
    ? join(homedir(), '.claude', 'settings.json')
    : join(cwd, '.claude', 'settings.json');

  console.log('spotter install');
  console.log(`  package: ${PACKAGE_ROOT}`);
  console.log(`  settings: ${settingsPath}`);

  // 1. create directories
  await mkdir(SPOTTER_HOME, { recursive: true });
  await mkdir(join(SPOTTER_HOME, 'runtime'), { recursive: true });
  await mkdir(join(SPOTTER_HOME, 'workdir'), { recursive: true });
  await mkdir(join(SPOTTER_HOME, 'logs'), { recursive: true });

  // 2. project marker (v0.3): hooks use this to detect installed projects.
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
  } else {
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
  }

  let codexHooksRegistered = false;
  if (target === 'project' && !skipCodexHooks) {
    if (codexCliPresentFn()) {
      const result = await installCodexHooksFn();
      codexHooksRegistered = true;
      console.log('  Codex hooks registered');
      console.log(`  Codex hooks: ${result.hooksPath}`);
    } else {
      console.log('  Codex CLI not found — Codex hooks not registered');
    }
  }

  // Seed the tool-db so the first session has something to audit against.
  // Runs regardless of whether settings.json changed — re-running `spotter install`
  // on an already-installed project is the canonical way to refresh tool-db drift
  // (skills added, MCP servers registered, etc.) alongside upgrades.
  // Skipped for user-mode (deprecated — no projectRoot) and when caller opts out
  // (tests set skipRefresh=true to avoid scanning the real user environment).
  if (target === 'project' && !skipRefresh) {
    console.log('\ndiscovering MCP servers, skills, and sub-agents...');
    const log = (msg) => process.stderr.write(`  ${msg}\n`);
    try {
      const claudeResolved = await refreshFn({ projectRoot: cwd, hostAgent: 'claude', logFn: log });
      console.log(`  ${claudeResolved.size} Claude tool(s) resolved`);
      console.log(`  Claude local DB:  ${localDbPath(cwd, 'claude')}`);
      console.log(`  Claude global DB: ${globalDbPath('claude')}`);
      if (codexHooksRegistered) {
        const codexResolved = await refreshFn({ projectRoot: cwd, hostAgent: 'codex', logFn: log });
        console.log(`  ${codexResolved.size} Codex tool(s) resolved`);
        console.log(`  Codex local DB:  ${localDbPath(cwd, 'codex')}`);
        console.log(`  Codex global DB: ${globalDbPath('codex')}`);
      }
    } catch (err) {
      // §0: throw (fallback 禁止). But surface the recovery path so the user isn't
      // left with "hooks registered, tool-db missing" and no clue what to run.
      process.stderr.write(`\nspotter install: tool-db seeding failed.\n`);
      process.stderr.write(`  hooks are registered but tool-db is not ready.\n`);
      process.stderr.write(`  recover with: spotter db refresh and, for Codex, spotter db refresh --host-agent codex\n`);
      throw err;
    }
  }

  console.log('\nnext steps:');
  console.log('  reload Claude Code (or open a new session) to activate Spotter');
  if (codexHooksRegistered) {
    console.log('  open a new Codex session to activate Codex hooks');
  } else if (target === 'project' && !skipCodexHooks) {
    console.log('  Codex hooks are not active: rerun `spotter install` where `codex --version` succeeds');
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isCodexCliPresent() {
  const result = spawnSync('codex', ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5_000,
    windowsHide: true,
  });
  return result.status === 0;
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

    let alreadyHas = false;
    for (const group of groups) {
      if (!Array.isArray(group.hooks)) continue;
      for (const hook of group.hooks) {
        if (hook?.type !== 'command') continue;
        if (!hook.command?.includes('spotter.mjs') || !hook.command?.includes(`hook ${sub}`)) continue;
        alreadyHas = true;
        hook.command = command;
        hook.timeout = timeout;
      }
    }
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
