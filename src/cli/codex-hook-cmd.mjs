import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuditorBackend } from '../core/auditor-backend.mjs';
import { codexLastAssistantMessage, readCodexUsedTools } from '../core/codex-transcript.mjs';
import { legacyResultFromJudgment } from '../core/judgment.mjs';
import { readLocal } from '../tool-db/refresh.mjs';
import { spawnRefreshDetached } from '../hooks/spawn-daemon.mjs';
import {
  die,
  findSpotterMarker,
  formatTransparentBlockReason,
  formatTransparentContext,
  isChildCall,
  readStdinJson,
  requireString,
} from '../hooks/lib.mjs';
import {
  appendPendingContext,
  drainPendingContexts,
} from '../hooks/pending-context.mjs';
import {
  appendHookEvent,
  hookEventsPath,
  summarizeHookEvents,
} from '../core/hook-event-log.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..', '..');
const SPOTTER_BIN = join(PACKAGE_ROOT, 'bin', 'spotter.mjs');
const CODEX_HOOK_TIMEOUT_SEC = 60;
const DEFAULT_CODEX_HOOK_AUDITOR_TIMEOUT_MS = 20_000;
const SHORT_PROMPT_MAX_CHARS = 10;
const DEFAULT_CODEX_STOP_SHORT_FINAL_MAX_CHARS = 120;
const CODEX_HOOK_FEATURE_NAMES = ['hooks', 'codex_hooks'];

const CODEX_HOOK_USAGE = `spotter codex-hook — Codex native hook adapter

Usage:
  spotter codex-hook install [--codex-home DIR]
  spotter codex-hook uninstall [--codex-home DIR]
  spotter codex-hook diagnostics [--codex-home DIR] [--project DIR]
  spotter codex-hook session-start
  spotter codex-hook user-prompt-submit
  spotter codex-hook stop

Installs Codex SessionStart / UserPromptSubmit / Stop hooks and uses Codex CLI as the default primary auditor backend.
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
  if (sub === 'session-start') {
    await runCodexSessionStartHook();
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

export async function runCodexSessionStartHook({
  readInput = readStdinJson,
  spawnRefreshDetachedFn = spawnRefreshDetached,
  recordHookEventFn = appendCodexHookEvent,
  writeError = (text) => process.stderr.write(text),
} = {}) {
  if (isChildCall()) return;
  const input = await readInput();
  const projectRoot = findSpotterMarker(input.cwd);
  if (!projectRoot) return;
  const startedAt = Date.now();

  spawnRefreshDetachedFn({ projectRoot, hostAgent: 'codex' });
  await recordCodexHookEventSafe(recordHookEventFn, {
    projectRoot,
    event: {
      hook: 'SessionStart',
      status: 'refresh_spawned',
      durationMs: Date.now() - startedAt,
    },
  }, writeError);
}

export async function runCodexUserPromptSubmitHook({
  readInput = readStdinJson,
  readLocalFn = readLocal,
  createAuditorBackendFn = createAuditorBackend,
  recordHookEventFn = appendCodexHookEvent,
  writeOutput = (text) => process.stdout.write(text),
  writeError = (text) => process.stderr.write(text),
} = {}) {
  if (isChildCall()) return;
  const input = await readInput();
  const projectRoot = findSpotterMarker(input.cwd);
  if (!projectRoot) return;
  const startedAt = Date.now();

  const prompt = requireString(input, 'prompt');
  const contexts = await drainPendingContexts({ projectRoot, sessionId: codexSessionId(input) });
  if ([...prompt.trim()].length <= SHORT_PROMPT_MAX_CHARS) {
    await recordCodexHookEventSafe(recordHookEventFn, {
      projectRoot,
      event: {
        hook: 'UserPromptSubmit',
        status: 'skipped',
        reason: 'short_prompt',
        pendingContextCount: contexts.length,
        durationMs: Date.now() - startedAt,
      },
    }, writeError);
    writeCodexUserPromptContexts({ contexts, writeOutput });
    return;
  }

  const catalog = await readLocalFn({ projectRoot, hostAgent: 'codex' });
  const backend = createCodexHookAuditorBackend({ catalog, projectRoot, createAuditorBackendFn });
  let judgment;
  try {
    judgment = await backend.judge({ stage: 'user_input', userInput: prompt });
  } catch (err) {
    contexts.push(formatCodexHookBackendError(err));
    await recordCodexHookEventSafe(recordHookEventFn, {
      projectRoot,
      event: {
        hook: 'UserPromptSubmit',
        status: 'error',
        backend: err?.backend ?? null,
        code: err?.code ?? 'E_INTERNAL',
        pendingContextCount: contexts.length,
        durationMs: Date.now() - startedAt,
      },
    }, writeError);
    writeCodexUserPromptContexts({ contexts, writeOutput });
    return;
  }
  await recordCodexHookEventSafe(recordHookEventFn, {
    projectRoot,
    event: {
      hook: 'UserPromptSubmit',
      status: 'success',
      backend: judgment.meta?.backend ?? backend.name ?? 'unknown',
      pass: judgment.pass,
      missingTools: judgment.findings.map((finding) => finding.toolName),
      pendingContextCount: contexts.length,
      backendDurationMs: judgment.meta?.durationMs ?? null,
      durationMs: Date.now() - startedAt,
    },
  }, writeError);
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
  recordHookEventFn = appendCodexHookEvent,
  writeOutput = (text) => process.stdout.write(text),
  writeError = (text) => process.stderr.write(text),
} = {}) {
  if (isChildCall()) return;
  const input = await readInput();
  if (input.stop_hook_active === true) return;
  const projectRoot = findSpotterMarker(input.cwd);
  if (!projectRoot) return;
  const startedAt = Date.now();

  const transcriptPath = requireString(input, 'transcript_path');
  const finalResponse = codexLastAssistantMessage(input) ?? '(no final response available)';
  const usedTools = await readCodexUsedToolsFn(transcriptPath);
  if (shouldSkipShortCodexStop({ finalResponse, usedTools, env: process.env })) {
    await recordCodexHookEventSafe(recordHookEventFn, {
      projectRoot,
      event: {
        hook: 'Stop',
        status: 'skipped',
        reason: 'short_final_no_tools',
        usedToolCount: usedTools.length,
        durationMs: Date.now() - startedAt,
      },
    }, writeError);
    return;
  }
  const catalog = await readLocalFn({ projectRoot, hostAgent: 'codex' });
  const backend = createCodexHookAuditorBackend({ catalog, projectRoot, createAuditorBackendFn });
  let judgment;
  try {
    judgment = await backend.judge({ stage: 'turn_end', finalResponse, usedTools });
  } catch (err) {
    const errorText = formatCodexHookBackendError(err);
    writeError(`${errorText}\n`);
    await appendPendingContext({
      projectRoot,
      sessionId: codexSessionId(input),
      text: errorText,
    });
    await recordCodexHookEventSafe(recordHookEventFn, {
      projectRoot,
      event: {
        hook: 'Stop',
        status: 'error',
        backend: err?.backend ?? null,
        code: err?.code ?? 'E_INTERNAL',
        usedToolCount: usedTools.length,
        durationMs: Date.now() - startedAt,
      },
    }, writeError);
    return;
  }
  if (judgment.pass === true) {
    await recordCodexHookEventSafe(recordHookEventFn, {
      projectRoot,
      event: {
        hook: 'Stop',
        status: 'success',
        backend: judgment.meta?.backend ?? backend.name ?? 'unknown',
        pass: true,
        missingTools: [],
        usedToolCount: usedTools.length,
        backendDurationMs: judgment.meta?.durationMs ?? null,
        durationMs: Date.now() - startedAt,
      },
    }, writeError);
    return;
  }

  await appendPendingContext({
    projectRoot,
    sessionId: codexSessionId(input),
    text: formatTransparentBlockReason(legacyResultFromJudgment(judgment).missing_tools),
  });
  await recordCodexHookEventSafe(recordHookEventFn, {
    projectRoot,
    event: {
      hook: 'Stop',
      status: 'queued',
      backend: judgment.meta?.backend ?? backend.name ?? 'unknown',
      pass: false,
      missingTools: judgment.findings.map((finding) => finding.toolName),
      usedToolCount: usedTools.length,
      backendDurationMs: judgment.meta?.durationMs ?? null,
      durationMs: Date.now() - startedAt,
    },
  }, writeError);
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
  const result = await codexHookDiagnostics({ codexHome: opts.codexHome, projectRoot: opts.projectRoot });
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
      sessionStart: hookState(next, 'SessionStart', 'codex-hook session-start'),
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
      sessionStart: hookState(next, 'SessionStart', 'codex-hook session-start'),
      userPromptSubmit: hookState(next, 'UserPromptSubmit', 'codex-hook user-prompt-submit'),
      stop: hookState(next, 'Stop', 'codex-hook stop'),
    },
    hooksChanged,
  };
}

export async function codexHookDiagnostics({ codexHome = defaultCodexHome(), projectRoot = null, spawnSyncFn = spawnSync } = {}) {
  const features = spawnSyncFn('codex', ['features', 'list'], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  const featureOutput = [features.stdout, features.stderr].filter(Boolean).join('\n');
  const hooks = await loadJson(join(codexHome, 'hooks.json'));
  const evidence = featureOutput.split('\n').find((line) => isEnabledCodexHookFeatureLine(line)) ?? null;
  const codexHooksFeature = evidence ? 'enabled' : 'not-enabled';
  const installed = {
    sessionStart: hookState(hooks, 'SessionStart', 'codex-hook session-start'),
    userPromptSubmit: hookState(hooks, 'UserPromptSubmit', 'codex-hook user-prompt-submit'),
    stop: hookState(hooks, 'Stop', 'codex-hook stop'),
  };
  const runtimeProjectRoot = projectRoot ? findSpotterMarker(projectRoot) : null;
  return {
    availability: features.error || features.status !== 0 || codexHooksFeature !== 'enabled'
      ? 'unavailable'
      : installed.sessionStart === 'installed' && installed.userPromptSubmit === 'installed' && installed.stop === 'installed'
        ? 'available'
        : 'not-installed',
    codexBinary: features.error ? 'missing' : 'present',
    codexHooksFeature,
    codexHome,
    hooksPath: join(codexHome, 'hooks.json'),
    installedHooks: installed,
    evidence,
    runtime: runtimeProjectRoot
      ? await summarizeCodexHookEvents({ projectRoot: runtimeProjectRoot })
      : null,
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

// Phase B (hook parity, 2026-05-08): pending-context helpers were moved to
// `src/hooks/pending-context.mjs` and the on-disk path migrated from
// `.spotter/codex-pending/` to host-neutral `.spotter/pending/`. The Claude Stop hook
// now writes to the same queue.

// Phase D (hook parity, 2026-05-08): Codex hook events now go through the host-neutral
// `appendHookEvent` so Claude / Codex events live in the same `.spotter/hook-events.jsonl`.
// Kept as an internal wrapper so existing call sites (and the `recordHookEventFn` DI knob
// in tests) can stay on the same shape.
async function appendCodexHookEvent({ projectRoot, event }) {
  await appendHookEvent({ projectRoot, host: 'codex', event });
}

async function recordCodexHookEventSafe(recordHookEventFn, input, writeError) {
  try {
    await recordHookEventFn(input);
  } catch (err) {
    writeError(`Spotter codex-hook event log failed: ${err.message}\n`);
  }
}

// Phase D (hook parity, 2026-05-08): Codex `--project` diagnostics now read the host-neutral
// `<projectRoot>/.spotter/hook-events.jsonl` and filter to `host:"codex"` so the existing
// `codex-hook diagnostics` shape (counts of just Codex events) stays intact.
export async function summarizeCodexHookEvents({ projectRoot, readFileFn = readFile } = {}) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new TypeError('summarizeCodexHookEvents: projectRoot must be a non-empty string');
  }
  const full = await summarizeHookEvents({ projectRoot, readFileFn });
  // Re-aggregate with a Codex-only filter so the legacy diagnostics caller doesn't see Claude
  // entries pulled in from the unified file. We re-read the JSONL ourselves to keep counts
  // exact (summarizeHookEvents already iterated, but it folded Claude entries in).
  const summary = {
    schema: 'spotter.hook_events_summary.v1',
    projectRoot,
    logPath: hookEventsPath(projectRoot),
    exists: full.exists,
    events: 0,
    parseErrors: full.parseErrors,
    byHook: {},
    byStatus: {},
    byBackend: {},
    averageDurationMs: 0,
    maxDurationMs: 0,
    recent: [],
  };
  if (!summary.exists) return summary;
  let totalDurationMs = 0;
  try {
    const raw = await readFileFn(summary.logPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.host !== 'codex') continue;
      summary.events += 1;
      incrementCounter(summary.byHook, event.hook ?? 'unknown');
      incrementCounter(summary.byStatus, event.status ?? 'unknown');
      if (event.backend) incrementCounter(summary.byBackend, event.backend);
      if (Number.isFinite(event.durationMs)) {
        totalDurationMs += event.durationMs;
        summary.maxDurationMs = Math.max(summary.maxDurationMs, event.durationMs);
      }
      summary.recent.push(compactCodexHookEvent(event));
      if (summary.recent.length > 5) summary.recent.shift();
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  summary.averageDurationMs = summary.events > 0 ? Math.round(totalDurationMs / summary.events) : 0;
  return summary;
}

function compactCodexHookEvent(event) {
  return {
    timestamp: event.timestamp ?? null,
    hook: event.hook ?? 'unknown',
    status: event.status ?? 'unknown',
    backend: event.backend ?? null,
    pass: typeof event.pass === 'boolean' ? event.pass : null,
    missingTools: Array.isArray(event.missingTools) ? event.missingTools : [],
    code: event.code ?? null,
    reason: event.reason ?? null,
    durationMs: Number.isFinite(event.durationMs) ? event.durationMs : null,
  };
}

function incrementCounter(counter, key) {
  counter[key] = (counter[key] ?? 0) + 1;
}

function defaultCodexHome() {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

function parseCodexHomeArgs(argv) {
  const opts = { codexHome: defaultCodexHome(), projectRoot: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--codex-home') {
      opts.codexHome = resolve(requireValue(argv, (index += 1), '--codex-home'));
      continue;
    }
    if (arg === '--project') {
      opts.projectRoot = resolve(requireValue(argv, (index += 1), '--project'));
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
  addCodexHook(next, 'SessionStart', `${quoteArg(nodePath)} ${quoteArg(spotterBin)} codex-hook session-start`, {
    timeoutSec: 5,
    async: true,
  });
  addCodexHook(next, 'UserPromptSubmit', `${quoteArg(nodePath)} ${quoteArg(spotterBin)} codex-hook user-prompt-submit`);
  addCodexHook(next, 'Stop', `${quoteArg(nodePath)} ${quoteArg(spotterBin)} codex-hook stop`);
  return next;
}

function addCodexHook(settings, event, command, { timeoutSec = CODEX_HOOK_TIMEOUT_SEC, async = false } = {}) {
  const groups = settings.hooks[event] = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
  for (const group of groups) {
    if (!Array.isArray(group.hooks)) continue;
    for (const hook of group.hooks) {
      if (hook?.type !== 'command') continue;
      if (!String(hook.command ?? '').includes('spotter.mjs') || !String(hook.command ?? '').includes(`codex-hook ${codexHookSubcommandForEvent(event)}`)) continue;
      hook.command = command;
      hook.timeoutSec = timeoutSec;
      hook.async = async;
      hook.statusMessage = null;
      return;
    }
  }
  groups.push({
    hooks: [{
      type: 'command',
      command,
      timeoutSec,
      async,
      statusMessage: null,
    }],
  });
}

function codexHookSubcommandForEvent(event) {
  if (event === 'SessionStart') return 'session-start';
  if (event === 'Stop') return 'stop';
  return 'user-prompt-submit';
}

function removeCodexHooks(current) {
  const next = structuredClone(current ?? {});
  if (!next.hooks || typeof next.hooks !== 'object') return next;
  for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
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
  if (/^\s*hooks\s*=\s*true\s*$/m.test(raw)) return 'already-enabled';
  const next = enableCodexHooksFeature(raw);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, next, 'utf8');
  return 'enabled';
}

function enableCodexHooksFeature(raw) {
  const text = raw.trimEnd();
  if (!/^\s*\[features\]\s*$/m.test(text)) {
    return `${text}${text ? '\n\n' : ''}[features]\nhooks = true\n`;
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
    if (inFeatures && /^\s*hooks\s*=/.test(line)) {
      lines[index] = 'hooks = true';
      return `${lines.join('\n')}\n`;
    }
  }
  lines.splice(insertAt, 0, 'hooks = true');
  return `${lines.join('\n')}\n`;
}

function isEnabledCodexHookFeatureLine(line) {
  const trimmed = String(line ?? '').trim();
  return CODEX_HOOK_FEATURE_NAMES.some((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${escaped}\\s+\\S+\\s+true\\b`).test(trimmed);
  });
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
