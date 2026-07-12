import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuditorBackend } from '../core/auditor-backend.mjs';
import { codexLastAssistantMessage, readCodexToolUsage } from '../core/codex-transcript.mjs';
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
  readCodexToolUsageFn = readCodexToolUsage,
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
  const toolUsage = await readCodexToolUsageFn(transcriptPath);
  const usedTools = Array.isArray(toolUsage?.usedTools) ? toolUsage.usedTools : [];
  const toolUsageEvent = compactCodexToolUsageForEvent(toolUsage);
  if (toolUsageEvent.toolUsageAnomalyCount === 0
    && shouldSkipShortCodexStop({ finalResponse, usedTools, env: process.env })) {
    await recordCodexHookEventSafe(recordHookEventFn, {
      projectRoot,
      event: {
        hook: 'Stop',
        status: 'skipped',
        reason: 'short_final_no_tools',
        usedToolCount: usedTools.length,
        ...toolUsageEvent,
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
        ...toolUsageEvent,
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
        ...toolUsageEvent,
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
      ...toolUsageEvent,
      backendDurationMs: judgment.meta?.durationMs ?? null,
      durationMs: Date.now() - startedAt,
    },
  }, writeError);
}

function compactCodexToolUsageForEvent(toolUsage) {
  const anomalies = Array.isArray(toolUsage?.anomalies)
    ? toolUsage.anomalies
      .filter((entry) => entry && typeof entry.code === 'string')
      .map((entry) => ({
        code: entry.code,
        ...(Number.isInteger(entry.line) && entry.line > 0 ? { line: entry.line } : {}),
      }))
    : [];
  const stats = {};
  for (const key of ['lines', 'parsedLines', 'toolCalls', 'recognized', 'anomalies']) {
    const value = toolUsage?.stats?.[key];
    if (Number.isFinite(value)) stats[key] = value;
  }
  return {
    toolUsageAnomalyCount: anomalies.length,
    toolUsageAnomalies: anomalies,
    toolUsageScope: typeof toolUsage?.scope === 'string' ? toolUsage.scope : 'unavailable',
    toolUsageStats: stats,
  };
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

export async function installCodexHooks({ codexHome = defaultCodexHome(), nodePath = resolveCodexHookNodePath(), spotterBin = SPOTTER_BIN } = {}) {
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
      sessionStart: hookState(next, 'SessionStart'),
      userPromptSubmit: hookState(next, 'UserPromptSubmit'),
      stop: hookState(next, 'Stop'),
    },
    hooksChanged,
    feature,
  };
}

function safeRealpath(path, realpath = realpathSync.native) {
  try {
    return realpath(path);
  } catch {
    return null;
  }
}

export function resolveCodexHookNodePath({
  env = process.env,
  execPath = process.execPath,
  platform = process.platform,
  exists = existsSync,
  realpath = realpathSync.native,
} = {}) {
  const execRealpath = safeRealpath(execPath, realpath);
  const pathEnv = env.PATH || env.Path || '';
  const names = platform === 'win32'
    ? ['node.exe', 'node.cmd', 'node.bat', 'node']
    : ['node'];

  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (!exists(candidate)) continue;
      const candidateRealpath = safeRealpath(candidate, realpath);
      if (execRealpath && candidateRealpath && candidateRealpath === execRealpath) {
        return candidate;
      }
    }
  }

  return execPath;
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
      sessionStart: hookState(next, 'SessionStart'),
      userPromptSubmit: hookState(next, 'UserPromptSubmit'),
      stop: hookState(next, 'Stop'),
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
    sessionStart: hookState(hooks, 'SessionStart'),
    userPromptSubmit: hookState(hooks, 'UserPromptSubmit'),
    stop: hookState(hooks, 'Stop'),
  };
  const runtimeProjectRoot = projectRoot ? findSpotterMarker(projectRoot) : null;
  const validation = validateSpotterCodexHooks(hooks);
  const unavailable = features.error || features.status !== 0 || codexHooksFeature !== 'enabled';
  const incompatible = Object.values(validation).some((entry) => entry.misconfigured);
  const missing = Object.values(validation).some((entry) => entry.issues.includes('missing'));
  const runtimeSummary = runtimeProjectRoot ? await summarizeCodexHookEvents({ projectRoot: runtimeProjectRoot }) : null;
  const runtime = runtimeSummary
    ? { ...runtimeSummary, observation: runtimeSummary.events > 0 ? 'observed' : 'not-observed' }
    : null;
  return {
    availability: unavailable
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
    readiness: unavailable ? 'unavailable' : incompatible ? 'misconfigured' : missing ? 'not-installed' : 'configured-unverified',
    validation,
    trust: {
      state: 'unknown',
      action: 'Review the current three Spotter hook definitions with Codex /hooks; trust is not machine-verifiable.',
    },
    runtime,
  };
}

function validateSpotterCodexHooks(settings) {
  return {
    sessionStart: validateSpotterCodexHookEvent(settings, 'SessionStart'),
    userPromptSubmit: validateSpotterCodexHookEvent(settings, 'UserPromptSubmit'),
    stop: validateSpotterCodexHookEvent(settings, 'Stop'),
  };
}

function validateSpotterCodexHookEvent(settings, event) {
  const groups = Array.isArray(settings?.hooks?.[event]) ? settings.hooks[event] : [];
  const allEntries = groups.flatMap((group) => Array.isArray(group.hooks) ? group.hooks : []);
  const candidates = allEntries.filter((hook) => isSpotterCodexCommand(String(hook?.command ?? '')));
  const expectedCandidates = candidates.filter((hook) => isSpotterCodexCommand(String(hook.command ?? ''), event));
  const expected = expectedCandidates.filter((hook) => hook?.type === 'command');
  const issues = [];
  if (expectedCandidates.length === 0) issues.push('missing');
  if (expectedCandidates.length > 1) issues.push('duplicate');
  if (candidates.length !== expectedCandidates.length) issues.push('wrong-event-subcommand');
  if (expectedCandidates.some((hook) => hook?.type !== 'command')) issues.push('type!=command');
  for (const hook of expected) {
    if (hook.async === true) issues.push('async:true');
    if (!Object.hasOwn(hook, 'timeout')) issues.push('timeout:missing');
    else if (!Number.isFinite(hook.timeout) || hook.timeout <= 0) issues.push('timeout-invalid');
    if (Object.hasOwn(hook, 'timeoutSec')) issues.push('timeoutSec');
    if (hook.async === false) issues.push('async:false');
    if (hook.statusMessage === null) issues.push('statusMessage:null');
    if (Object.hasOwn(hook, 'commandWindows') && (
      typeof hook.commandWindows !== 'string'
      || !isSpotterCodexCommand(hook.commandWindows, event)
    )) issues.push('commandWindows-invalid');
  }
  const incompatible = issues.some((issue) => isIncompatibleSpotterHookIssue(issue));
  return {
    expectedRegisteredCount: expectedCandidates.length,
    registered: expectedCandidates.length > 0,
    compatible: expectedCandidates.length > 0 && !incompatible,
    misconfigured: incompatible,
    canonical: issues.length === 0,
    issues: [...new Set(issues)],
  };
}

function isIncompatibleSpotterHookIssue(issue) {
  return [
    'duplicate',
    'wrong-event-subcommand',
    'type!=command',
    'async:true',
    'timeout-invalid',
    'timeoutSec',
    'commandWindows-invalid',
  ].includes(issue);
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
    timeout: 5,
  });
  addCodexHook(next, 'UserPromptSubmit', `${quoteArg(nodePath)} ${quoteArg(spotterBin)} codex-hook user-prompt-submit`);
  addCodexHook(next, 'Stop', `${quoteArg(nodePath)} ${quoteArg(spotterBin)} codex-hook stop`);
  return next;
}

function addCodexHook(settings, event, command, { timeout = CODEX_HOOK_TIMEOUT_SEC } = {}) {
  const groups = settings.hooks[event] = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
  let installed = false;
  const nextGroups = groups.flatMap((group) => {
    if (!Array.isArray(group.hooks)) return [group];
    const hooks = group.hooks.flatMap((hook) => {
      if (!isSpotterCodexHookForEvent(hook, event)) return [hook];
      if (installed) return [];
      installed = true;
      return [{ type: 'command', command, timeout }];
    });
    // Empty groups that predate Spotter are preserved; remove only a group emptied by a duplicate removal.
    if (group.hooks.length > 0 && hooks.length === 0) return [];
    return [{ ...group, hooks }];
  });
  groups.splice(0, groups.length, ...nextGroups);
  if (!installed) groups.push({ hooks: [{ type: 'command', command, timeout }] });
}

function isSpotterCodexHookForEvent(hook, event) {
  return isSpotterCodexHook(hook) && isSpotterCodexCommand(String(hook.command ?? ''), event);
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
      .flatMap((group) => {
        if (!Array.isArray(group.hooks)) return [group];
        const hooks = group.hooks.filter((hook) => !isSpotterCodexHook(hook));
        // Uninstall removes every known Spotter command even if it was placed under the wrong event.
        // Pre-existing empty groups remain untouched.
        if (group.hooks.length > 0 && hooks.length === 0) return [];
        return [{ ...group, hooks }];
      });
  }
  return next;
}

function isSpotterCodexHook(hook) {
  if (hook?.type !== 'command') return false;
  return isSpotterCodexCommand(String(hook.command ?? ''));
}

function isSpotterCodexCommand(command, event = null) {
  const match = command.match(/^(?:"((?:\\.|[^"\\])*)"|(\S+))\s+(?:"((?:\\.|[^"\\])*)"|(\S+))\s+codex-hook\s+(session-start|user-prompt-submit|stop)\s*$/);
  if (!match) return false;
  const nodePath = unescapeQuotedCommandToken(match[1] ?? match[2]);
  const spotterPath = unescapeQuotedCommandToken(match[3] ?? match[4]);
  return /(?:^|[\\/])node(?:\.exe|\.cmd|\.bat)?$/i.test(nodePath)
    && /(?:^|[\\/])spotter\.mjs$/.test(spotterPath)
    && (event === null || match[5] === codexHookSubcommandForEvent(event));
}

function unescapeQuotedCommandToken(token) {
  return token.replace(/\\(["\\$`])/g, '$1');
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

function hookState(settings, event) {
  const groups = settings?.hooks?.[event];
  if (!Array.isArray(groups)) return 'not-installed';
  for (const group of groups) {
    if (!Array.isArray(group.hooks)) continue;
    if (group.hooks.some((hook) => isSpotterCodexHookForEvent(hook, event))) {
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
