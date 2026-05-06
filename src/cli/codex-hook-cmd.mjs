import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuditorBackend } from '../core/auditor-backend.mjs';
import { codexLastAssistantMessage, readCodexUsedTools } from '../core/codex-transcript.mjs';
import { legacyResultFromJudgment } from '../core/judgment.mjs';
import { readLocal } from '../tool-db/refresh.mjs';
import {
  die,
  findSpotterMarker,
  formatTransparentBlockReason,
  formatTransparentContext,
  isChildCall,
  readStdinJson,
  requireString,
} from '../hooks/lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..', '..');
const SPOTTER_BIN = join(PACKAGE_ROOT, 'bin', 'spotter.mjs');
const CODEX_HOOK_TIMEOUT_SEC = 60;
const DEFAULT_CODEX_HOOK_AUDITOR_TIMEOUT_MS = 20_000;
const SHORT_PROMPT_MAX_CHARS = 10;
const DEFAULT_CODEX_STOP_SHORT_FINAL_MAX_CHARS = 120;
const CODEX_PENDING_DIR = 'codex-pending';

const CODEX_HOOK_USAGE = `spotter codex-hook — experimental Codex native hook adapter

Usage:
  spotter codex-hook install [--codex-home DIR]
  spotter codex-hook uninstall [--codex-home DIR]
  spotter codex-hook diagnostics [--codex-home DIR]
  spotter codex-hook user-prompt-submit
  spotter codex-hook stop

This command is experimental. It installs Codex UserPromptSubmit / Stop hooks and uses Codex CLI as the default primary auditor backend.
`;

export async function runCodexHookCommand({ argv = process.argv.slice(2) } = {}) {
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') {
    process.stdout.write(CODEX_HOOK_USAGE);
    return;
  }
  if (sub === 'install') {
    await runCodexHookInstallCommand({ argv: argv.slice(1) });
    return;
  }
  if (sub === 'uninstall') {
    await runCodexHookUninstallCommand({ argv: argv.slice(1) });
    return;
  }
  if (sub === 'diagnostics') {
    await runCodexHookDiagnosticsCommand({ argv: argv.slice(1) });
    return;
  }
  if (sub === 'user-prompt-submit') {
    await runCodexUserPromptSubmitHook();
    return;
  }
  if (sub === 'stop') {
    await runCodexStopHook();
    return;
  }
  process.stderr.write(`unknown codex-hook subcommand: ${sub}\n${CODEX_HOOK_USAGE}`);
  process.exit(2);
}

export async function runCodexUserPromptSubmitHook({
  readInput = readStdinJson,
  readLocalFn = readLocal,
  createAuditorBackendFn = createAuditorBackend,
  writeOutput = (text) => process.stdout.write(text),
} = {}) {
  if (isChildCall()) return;
  const input = await readInput();
  const projectRoot = findSpotterMarker(input.cwd);
  if (!projectRoot) return;

  const prompt = requireString(input, 'prompt');
  const contexts = await drainCodexPendingContexts({ projectRoot, sessionId: codexSessionId(input) });
  if ([...prompt.trim()].length <= SHORT_PROMPT_MAX_CHARS) {
    writeCodexUserPromptContexts({ contexts, writeOutput });
    return;
  }

  const catalog = await readLocalFn({ projectRoot });
  const backend = createCodexHookAuditorBackend({ catalog, projectRoot, createAuditorBackendFn });
  let judgment;
  try {
    judgment = await backend.judge({ stage: 'user_input', userInput: prompt });
  } catch (err) {
    contexts.push(formatCodexHookBackendError(err));
    writeCodexUserPromptContexts({ contexts, writeOutput });
    return;
  }
  if (judgment.pass === true) {
    writeCodexUserPromptContexts({ contexts, writeOutput });
    return;
  }

  contexts.push(formatTransparentContext(legacyResultFromJudgment(judgment).missing_tools));
  writeCodexUserPromptContexts({ contexts, writeOutput });
}

export async function runCodexStopHook({
  readInput = readStdinJson,
  readLocalFn = readLocal,
  createAuditorBackendFn = createAuditorBackend,
  readCodexUsedToolsFn = readCodexUsedTools,
  writeOutput = (text) => process.stdout.write(text),
  writeError = (text) => process.stderr.write(text),
} = {}) {
  if (isChildCall()) return;
  const input = await readInput();
  if (input.stop_hook_active === true) return;
  const projectRoot = findSpotterMarker(input.cwd);
  if (!projectRoot) return;

  const transcriptPath = requireString(input, 'transcript_path');
  const finalResponse = codexLastAssistantMessage(input) ?? '(no final response available)';
  const usedTools = await readCodexUsedToolsFn(transcriptPath);
  if (shouldSkipShortCodexStop({ finalResponse, usedTools, env: process.env })) return;
  const catalog = await readLocalFn({ projectRoot });
  const backend = createCodexHookAuditorBackend({ catalog, projectRoot, createAuditorBackendFn });
  let judgment;
  try {
    judgment = await backend.judge({ stage: 'turn_end', finalResponse, usedTools });
  } catch (err) {
    const errorText = formatCodexHookBackendError(err);
    writeError(`${errorText}\n`);
    await appendCodexPendingContext({
      projectRoot,
      sessionId: codexSessionId(input),
      text: errorText,
    });
    return;
  }
  if (judgment.pass === true) return;

  await appendCodexPendingContext({
    projectRoot,
    sessionId: codexSessionId(input),
    text: formatTransparentBlockReason(legacyResultFromJudgment(judgment).missing_tools),
  });
}

export async function runCodexHookInstallCommand({
  argv = [],
  writeOutput = (text) => process.stdout.write(text),
} = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    writeOutput(CODEX_HOOK_USAGE);
    return;
  }
  const opts = parseCodexHomeArgs(argv);
  const result = await installCodexHooks({ codexHome: opts.codexHome });
  writeOutput(JSON.stringify(result, null, 2) + '\n');
}

export async function runCodexHookUninstallCommand({
  argv = [],
  writeOutput = (text) => process.stdout.write(text),
} = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    writeOutput(CODEX_HOOK_USAGE);
    return;
  }
  const opts = parseCodexHomeArgs(argv);
  const result = await uninstallCodexHooks({ codexHome: opts.codexHome });
  writeOutput(JSON.stringify(result, null, 2) + '\n');
}

export async function runCodexHookDiagnosticsCommand({
  argv = [],
  writeOutput = (text) => process.stdout.write(text),
} = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    writeOutput(CODEX_HOOK_USAGE);
    return;
  }
  const opts = parseCodexHomeArgs(argv);
  const result = await codexHookDiagnostics({ codexHome: opts.codexHome });
  writeOutput(JSON.stringify(result, null, 2) + '\n');
}

export async function installCodexHooks({ codexHome = defaultCodexHome(), nodePath = process.execPath, spotterBin = SPOTTER_BIN } = {}) {
  const hooksPath = join(codexHome, 'hooks.json');
  const configPath = join(codexHome, 'config.toml');
  const current = await loadJson(hooksPath);
  const next = mergeCodexHooks(current, { nodePath, spotterBin });
  const hooksChanged = JSON.stringify(current) !== JSON.stringify(next);
  if (hooksChanged) {
    await mkdir(dirname(hooksPath), { recursive: true });
    await writeFile(hooksPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
  }
  const feature = await ensureCodexHooksFeature(configPath);
  return {
    codexHome,
    hooksPath,
    configPath,
    hooks: {
      userPromptSubmit: hookState(next, 'UserPromptSubmit', 'codex-hook user-prompt-submit'),
      stop: hookState(next, 'Stop', 'codex-hook stop'),
    },
    hooksChanged,
    feature,
  };
}

export async function uninstallCodexHooks({ codexHome = defaultCodexHome() } = {}) {
  const hooksPath = join(codexHome, 'hooks.json');
  const current = await loadJson(hooksPath);
  const next = removeCodexHooks(current);
  const hooksChanged = JSON.stringify(current) !== JSON.stringify(next);
  if (hooksChanged) {
    await mkdir(dirname(hooksPath), { recursive: true });
    await writeFile(hooksPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
  }
  return {
    codexHome,
    hooksPath,
    hooks: {
      userPromptSubmit: hookState(next, 'UserPromptSubmit', 'codex-hook user-prompt-submit'),
      stop: hookState(next, 'Stop', 'codex-hook stop'),
    },
    hooksChanged,
  };
}

export async function codexHookDiagnostics({ codexHome = defaultCodexHome(), spawnSyncFn = spawnSync } = {}) {
  const features = spawnSyncFn('codex', ['features', 'list'], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  const featureOutput = [features.stdout, features.stderr].filter(Boolean).join('\n');
  const hooks = await loadJson(join(codexHome, 'hooks.json'));
  const codexHooksFeature = /^codex_hooks\s+\S+\s+true\b/m.test(featureOutput) ? 'enabled' : 'not-enabled';
  const installed = {
    userPromptSubmit: hookState(hooks, 'UserPromptSubmit', 'codex-hook user-prompt-submit'),
    stop: hookState(hooks, 'Stop', 'codex-hook stop'),
  };
  return {
    availability: features.error || features.status !== 0 || codexHooksFeature !== 'enabled'
      ? 'unavailable'
      : installed.userPromptSubmit === 'installed' && installed.stop === 'installed'
        ? 'available'
        : 'not-installed',
    codexBinary: features.error ? 'missing' : 'present',
    codexHooksFeature,
    codexHome,
    hooksPath: join(codexHome, 'hooks.json'),
    installedHooks: installed,
    evidence: featureOutput.split('\n').find((line) => line.trim().startsWith('codex_hooks')) ?? null,
  };
}

function createCodexHookAuditorBackend({ catalog, projectRoot, createAuditorBackendFn }) {
  const backend = process.env.SPOTTER_AUDITOR_BACKEND || 'codex-cli';
  return createAuditorBackendFn({
    backend,
    catalog,
    projectRoot,
    hostAgent: 'codex',
    env: process.env,
    timeoutMs: codexHookAuditorTimeoutMs(process.env),
  });
}

function codexHookAuditorTimeoutMs(env) {
  const raw = env?.SPOTTER_CODEX_HOOK_AUDITOR_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_CODEX_HOOK_AUDITOR_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CODEX_HOOK_AUDITOR_TIMEOUT_MS;
}

function shouldSkipShortCodexStop({ finalResponse, usedTools, env }) {
  if (Array.isArray(usedTools) && usedTools.length > 0) return false;
  const raw = env?.SPOTTER_CODEX_STOP_SHORT_FINAL_MAX_CHARS;
  const max = raw === undefined || raw === ''
    ? DEFAULT_CODEX_STOP_SHORT_FINAL_MAX_CHARS
    : Number(raw);
  if (!Number.isFinite(max) || max <= 0) return false;
  return [...String(finalResponse).trim()].length <= max;
}

function writeCodexUserPromptContexts({ contexts, writeOutput }) {
  const text = contexts.map((context) => String(context).trim()).filter(Boolean).join('\n\n');
  if (!text) return;
  writeOutput(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: text,
    },
  }));
}

function formatCodexHookBackendError(err) {
  const code = typeof err?.code === 'string' && err.code ? ` ${err.code}` : '';
  const backend = typeof err?.backend === 'string' && err.backend ? ` ${err.backend}` : '';
  const message = err?.message ? String(err.message) : String(err);
  const diagnostics = formatBackendDiagnostics(err?.diagnostics);
  return [
    `Spotter auditor backend error${code}${backend}: ${message}`,
    'No fallback auditor was used.',
    diagnostics,
  ].filter(Boolean).join('\n');
}

function formatBackendDiagnostics(diagnostics) {
  if (!diagnostics || typeof diagnostics !== 'object') return '';
  const stderr = typeof diagnostics.stderr === 'string' ? diagnostics.stderr.trim() : '';
  const stdout = typeof diagnostics.stdout === 'string' ? diagnostics.stdout.trim() : '';
  const parts = [];
  if (stdout) parts.push(`stdout:\n${stdout.split('\n').slice(-4).join('\n')}`);
  if (stderr) parts.push(`stderr:\n${stderr.split('\n').slice(-4).join('\n')}`);
  if (parts.length === 0) return '';
  return `backend output:\n${parts.join('\n')}`;
}

function codexSessionId(payload) {
  const value = payload?.session_id ?? payload?.sessionId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function codexPendingPath({ projectRoot, sessionId }) {
  if (!sessionId) return null;
  const clean = sessionId.replace(/[^A-Za-z0-9_-]/g, '');
  if (!clean) return null;
  return join(projectRoot, '.spotter', CODEX_PENDING_DIR, `${clean}.json`);
}

async function appendCodexPendingContext({ projectRoot, sessionId, text }) {
  const path = codexPendingPath({ projectRoot, sessionId });
  const value = String(text ?? '').trim();
  if (!path || !value) return false;
  const contexts = await readCodexPendingContexts(path);
  if (!contexts.includes(value)) contexts.push(value);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(contexts, null, 2) + '\n', 'utf8');
  return true;
}

async function drainCodexPendingContexts({ projectRoot, sessionId }) {
  const path = codexPendingPath({ projectRoot, sessionId });
  if (!path) return [];
  const contexts = await readCodexPendingContexts(path);
  if (contexts.length > 0) {
    try {
      await unlink(path);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return contexts;
}

async function readCodexPendingContexts(path) {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean)
      : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

function defaultCodexHome() {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

function parseCodexHomeArgs(argv) {
  const opts = { codexHome: defaultCodexHome() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--codex-home') {
      opts.codexHome = resolve(requireValue(argv, (index += 1), '--codex-home'));
      continue;
    }
    process.stderr.write(`unknown codex-hook option: ${arg}\n${CODEX_HOOK_USAGE}`);
    process.exit(2);
    return opts;
  }
  return opts;
}

async function loadJson(path) {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

function mergeCodexHooks(current, { nodePath, spotterBin }) {
  const next = structuredClone(current ?? {});
  next.hooks = next.hooks ?? {};
  addCodexHook(next, 'UserPromptSubmit', `${quoteArg(nodePath)} ${quoteArg(spotterBin)} codex-hook user-prompt-submit`);
  addCodexHook(next, 'Stop', `${quoteArg(nodePath)} ${quoteArg(spotterBin)} codex-hook stop`);
  return next;
}

function addCodexHook(settings, event, command) {
  const groups = settings.hooks[event] = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
  for (const group of groups) {
    if (!Array.isArray(group.hooks)) continue;
    for (const hook of group.hooks) {
      if (hook?.type !== 'command') continue;
      if (!String(hook.command ?? '').includes('spotter.mjs') || !String(hook.command ?? '').includes(`codex-hook ${event === 'Stop' ? 'stop' : 'user-prompt-submit'}`)) continue;
      hook.command = command;
      hook.timeoutSec = CODEX_HOOK_TIMEOUT_SEC;
      hook.async = false;
      hook.statusMessage = null;
      return;
    }
  }
  groups.push({
    hooks: [{
      type: 'command',
      command,
      timeoutSec: CODEX_HOOK_TIMEOUT_SEC,
      async: false,
      statusMessage: null,
    }],
  });
}

function removeCodexHooks(current) {
  const next = structuredClone(current ?? {});
  if (!next.hooks || typeof next.hooks !== 'object') return next;
  for (const event of ['UserPromptSubmit', 'Stop']) {
    const groups = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
    next.hooks[event] = groups
      .map((group) => ({
        ...group,
        hooks: Array.isArray(group.hooks)
          ? group.hooks.filter((hook) => !isSpotterCodexHook(hook))
          : group.hooks,
      }))
      .filter((group) => !Array.isArray(group.hooks) || group.hooks.length > 0);
  }
  return next;
}

function isSpotterCodexHook(hook) {
  const command = String(hook?.command ?? '');
  return hook?.type === 'command' && command.includes('spotter.mjs') && command.includes('codex-hook ');
}

async function ensureCodexHooksFeature(configPath) {
  let raw = '';
  if (existsSync(configPath)) raw = await readFile(configPath, 'utf8');
  if (/^\s*codex_hooks\s*=\s*true\s*$/m.test(raw)) return 'already-enabled';
  const next = enableCodexHooksFeature(raw);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, next, 'utf8');
  return 'enabled';
}

function enableCodexHooksFeature(raw) {
  const text = raw.trimEnd();
  if (!/^\s*\[features\]\s*$/m.test(text)) {
    return `${text}${text ? '\n\n' : ''}[features]\ncodex_hooks = true\n`;
  }
  const lines = text.split('\n');
  let inFeatures = false;
  let insertAt = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*\[[^\]]+\]\s*$/.test(line)) {
      if (inFeatures) {
        insertAt = index;
        break;
      }
      inFeatures = /^\s*\[features\]\s*$/.test(line);
      continue;
    }
    if (inFeatures && /^\s*codex_hooks\s*=/.test(line)) {
      lines[index] = 'codex_hooks = true';
      return `${lines.join('\n')}\n`;
    }
  }
  lines.splice(insertAt, 0, 'codex_hooks = true');
  return `${lines.join('\n')}\n`;
}

function hookState(settings, event, commandFragment) {
  const groups = settings?.hooks?.[event];
  if (!Array.isArray(groups)) return 'not-installed';
  for (const group of groups) {
    if (!Array.isArray(group.hooks)) continue;
    if (group.hooks.some((hook) => {
      const command = String(hook?.command ?? '');
      return hook?.type === 'command' && command.includes('spotter.mjs') && command.includes(commandFragment);
    })) {
      return 'installed';
    }
  }
  return 'not-installed';
}

function quoteArg(value) {
  return `"${String(value).replace(/(["\\$`])/g, '\\$1')}"`;
}

function requireValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw Object.assign(new Error(`${option} requires a value`), { exitCode: 2 });
  }
  return value;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  runCodexHookCommand().catch((err) => die(err.message, err.exitCode ?? 2));
}
