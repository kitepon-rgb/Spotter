import { resolve } from 'node:path';
import { defaultDaemonLogDir, summarizeDaemonLogs } from '../core/daemon-log-diagnostics.mjs';
import { summarizeHookEvents } from '../core/hook-event-log.mjs';
import {
  acknowledgeRuntimeErrors,
  compactRuntimeErrors,
  readRuntimeErrorSnapshot,
  readRuntimeErrorStoreStatus,
  reopenRuntimeError,
  resolveRuntimeError,
} from '../core/runtime-error-store.mjs';

const DIAGNOSTICS_USAGE = `spotter diagnostics — read-only operational diagnostics

Usage:
  spotter diagnostics logs [--log-dir DIR] [--project DIR] [--json]
  spotter diagnostics runtime-errors [snapshot] [--after-cursor N] [--limit N]
  spotter diagnostics runtime-errors ack CURSOR
  spotter diagnostics runtime-errors resolve|reopen FINGERPRINT
  spotter diagnostics runtime-errors compact

  --log-dir   daemon log directory (default: ~/.spotter/runtime)
  --project   project root for hook-events.jsonl (default: cwd)
`;

export async function runDiagnosticsCommand({ argv = process.argv.slice(2) } = {}) {
  const sub = argv[0];
  if (sub === 'logs') {
    await runDiagnosticsLogsCommand({ argv: argv.slice(1) });
    return;
  }
  if (sub === 'runtime-errors') {
    await runRuntimeErrorDiagnosticsCommand({ argv: argv.slice(1) });
    return;
  }
  process.stderr.write(`unknown diagnostics subcommand: ${sub}\n${DIAGNOSTICS_USAGE}`);
  process.exit(2);
}

export async function runDiagnosticsLogsCommand({
  argv = [],
  summarizeDaemonLogsFn = summarizeDaemonLogs,
  summarizeHookEventsFn = summarizeHookEvents,
  readRuntimeErrorStoreStatusFn = readRuntimeErrorStoreStatus,
  writeOutput = (text) => process.stdout.write(text),
} = {}) {
  const opts = parseLogsArgs(argv);
  const summary = await summarizeDaemonLogsFn({ logDir: opts.logDir });
  // Phase D (hook parity, 2026-05-08): hook-event JSONL read alongside daemon log so
  // the hook-side observations (skip reasons, drained pending counts, transport errors
  // that never reach the daemon) surface in the same diagnostics output.
  const hookEvents = await summarizeHookEventsFn({ projectRoot: opts.projectRoot });
  const runtimeErrors = await readRuntimeErrorStoreStatusFn();
  const merged = { ...summary, hookEvents, runtimeErrors };
  if (opts.json) {
    writeOutput(stringifyAsciiJson(merged) + '\n');
    return;
  }
  writeOutput(formatDaemonLogSummary(merged));
}

export function stringifyAsciiJson(value) {
  return JSON.stringify(value, null, 2).replace(/[\u007f-\uffff]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

export function formatDaemonLogSummary(summary) {
  const lines = [
    'spotter diagnostics logs',
    `  log dir: ${summary.logDir ?? defaultDaemonLogDir()}`,
    `  files: ${summary.files.parsed}/${summary.files.total}`,
    `  sessions: ${summary.sessions.count}`,
    `  daemon starts: ${summary.daemon.starts} (tool-db loaded=${summary.daemon.toolDbLoaded}, restart signals=${summary.daemon.restartSignals})`,
    `  daemon stops: ${summary.daemon.stops}, heartbeat timeouts=${summary.daemon.heartbeatTimeouts}`,
  ];

  for (const stage of ['user_input', 'turn_end']) {
    const stats = summary.stages[stage];
    lines.push(
      `  ${stage}: calls=${stats.calls}, pass=false=${stats.passFalse}, missing=${stats.missingTotal}`
    );
    const topMissing = topCounter(stats.missingByTool, 5);
    if (topMissing.length > 0) {
      lines.push(`    top missing: ${topMissing.map(([name, count]) => `${name}=${count}`).join(', ')}`);
    }
    const modes = Object.entries(stats.modes)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([mode, modeStats]) => `${mode}:n=${modeStats.count},avg=${modeStats.averageDurationMs}ms,max=${modeStats.maxDurationMs}ms`);
    if (modes.length > 0) lines.push(`    modes: ${modes.join('; ')}`);
    const backends = Object.entries(stats.backends)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([backend, backendStats]) => `${backend}:n=${backendStats.count},avg=${backendStats.averageDurationMs}ms,max=${backendStats.maxDurationMs}ms,pass=false=${backendStats.passFalse}`);
    if (backends.length > 0) lines.push(`    backends: ${backends.join('; ')}`);
  }

  const backendLines = Object.entries(summary.backends)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([backend, stats]) => `${backend}:n=${stats.count},avg=${stats.averageDurationMs}ms,max=${stats.maxDurationMs}ms,pass=false=${stats.passFalse},missing=${stats.missingTotal}`);
  if (backendLines.length > 0) {
    lines.push(`  backends: ${backendLines.join('; ')}`);
  }

  lines.push(
    `  anomalies: role_collapse=${summary.anomalies.roleCollapseReset}, hallucination_filtered=${summary.anomalies.hallucinationFiltered}, dropped_catalog_external=${summary.anomalies.catalogExternalDropped.events}, haiku_failures=${summary.anomalies.haikuInvocationFailures.total}, handler_errors=${summary.anomalies.handlerErrors.total}, fatals=${summary.anomalies.fatals.total}`
  );

  const droppedNames = topCounter(summary.anomalies.catalogExternalDropped.names, 5);
  if (droppedNames.length > 0) {
    lines.push(`    dropped names: ${droppedNames.map(([name, count]) => `${name}=${count}`).join(', ')}`);
  }

  lines.push(
    `  codex_risk_check: dispatched=${summary.codexRiskCheck.dispatched}, disabled_skips=${summary.codexRiskCheck.disabledSkips}, no_project_skips=${summary.codexRiskCheck.noProjectRootSkips}, failures=${summary.codexRiskCheck.dispatchFailures}`
  );

  // Phase D (hook parity): host-neutral hook-events.jsonl summary if present.
  const hookEvents = summary.hookEvents;
  if (hookEvents) {
    if (!hookEvents.exists) {
      lines.push(`  hook-events.jsonl: not present (path=${hookEvents.logPath})`);
    } else {
      lines.push(
        `  hook-events.jsonl: events=${hookEvents.events}, parse_errors=${hookEvents.parseErrors}, avg=${hookEvents.averageDurationMs}ms, max=${hookEvents.maxDurationMs}ms`
      );
      const byHost = formatCounter(hookEvents.byHost);
      if (byHost) lines.push(`    by host: ${byHost}`);
      const byHook = formatCounter(hookEvents.byHook);
      if (byHook) lines.push(`    by hook: ${byHook}`);
      const byStatus = formatCounter(hookEvents.byStatus);
      if (byStatus) lines.push(`    by status: ${byStatus}`);
      const byBackend = formatCounter(hookEvents.byBackend);
      if (byBackend) lines.push(`    by backend: ${byBackend}`);
    }
  }

  const runtimeErrors = summary.runtimeErrors;
  if (runtimeErrors) {
    lines.push(
      `  runtime-errors: collection=${runtimeErrors.collection}, store=${runtimeErrors.store}, records=${runtimeErrors.records}, open=${runtimeErrors.open}, resolved=${runtimeErrors.resolved}, unacknowledged=${runtimeErrors.unacknowledged}`
    );
  }

  return lines.join('\n') + '\n';
}

export async function runRuntimeErrorDiagnosticsCommand({
  argv = [],
  readSnapshotFn = readRuntimeErrorSnapshot,
  acknowledgeFn = acknowledgeRuntimeErrors,
  resolveFn = resolveRuntimeError,
  reopenFn = reopenRuntimeError,
  compactFn = compactRuntimeErrors,
  writeOutput = (text) => process.stdout.write(text),
} = {}) {
  const action = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'snapshot';
  const actionArgs = action === 'snapshot' && argv[0] !== 'snapshot' ? argv : argv.slice(1);
  if (!['snapshot', 'ack', 'resolve', 'reopen', 'compact'].includes(action)) throw runtimeErrorUsage();
  try {
    if (action === 'ack') {
      if (actionArgs.length !== 1) throw runtimeErrorUsage();
      const result = await acknowledgeFn({ cursor: parseNonNegativeInteger(actionArgs[0], 'cursor') });
      writeOutput(`${JSON.stringify(result)}\n`);
      return;
    }
    if (action === 'resolve' || action === 'reopen') {
      if (actionArgs.length !== 1 || !/^[a-f0-9]{64}$/.test(actionArgs[0])) throw runtimeErrorUsage();
      const result = await (action === 'resolve' ? resolveFn : reopenFn)({ fingerprint: actionArgs[0] });
      writeOutput(`${JSON.stringify(result)}\n`);
      return;
    }
    if (action === 'compact') {
      if (actionArgs.length !== 0) throw runtimeErrorUsage();
      writeOutput(`${JSON.stringify(await compactFn())}\n`);
      return;
    }
  let afterCursor = 0;
  let limit = 100;
  for (let index = 0; index < actionArgs.length; index += 1) {
    const arg = actionArgs[index];
    if (arg === '--after-cursor') {
      afterCursor = parseNonNegativeInteger(requireValue(actionArgs, (index += 1), '--after-cursor'), '--after-cursor');
      continue;
    }
    if (arg === '--limit') {
      limit = parsePositiveInteger(requireValue(actionArgs, (index += 1), '--limit'), '--limit');
      continue;
    }
    throw Object.assign(new Error(`unknown diagnostics runtime-errors option: ${arg}`), { exitCode: 2 });
  }
  const snapshot = await readSnapshotFn({ afterCursor, limit });
  writeOutput(`${JSON.stringify(snapshot)}\n`);
  } catch (error) {
    if (error?.exitCode === 2) throw error;
    const fixed = new Error('runtime error store unavailable');
    fixed.stack = '';
    fixed.exitCode = 1;
    throw fixed;
  }
}

function runtimeErrorUsage() {
  const error = new Error('usage: spotter diagnostics runtime-errors snapshot|ack|resolve|reopen|compact');
  error.stack = '';
  error.exitCode = 2;
  return error;
}

function formatCounter(counter) {
  if (!counter || typeof counter !== 'object') return '';
  const entries = Object.entries(counter).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return '';
  return entries.map(([k, v]) => `${k}=${v}`).join(', ');
}

function parseLogsArgs(argv) {
  const opts = {
    logDir: defaultDaemonLogDir(),
    projectRoot: process.cwd(),
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--log-dir') {
      opts.logDir = resolve(requireValue(argv, (index += 1), '--log-dir'));
      continue;
    }
    if (arg === '--project') {
      opts.projectRoot = resolve(requireValue(argv, (index += 1), '--project'));
      continue;
    }
    if (arg === '--json') {
      opts.json = true;
      continue;
    }
    process.stderr.write(`unknown diagnostics logs option: ${arg}\n${DIAGNOSTICS_USAGE}`);
    process.exit(2);
    return opts;
  }
  return opts;
}

function requireValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw Object.assign(new Error(`${option} requires a value`), { exitCode: 2 });
  }
  return value;
}

function parseNonNegativeInteger(value, option) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw Object.assign(new Error(`${option} requires a non-negative integer`), { exitCode: 2 });
  return Number(value);
}

function parsePositiveInteger(value, option) {
  if (!/^[1-9][0-9]*$/.test(value)) throw Object.assign(new Error(`${option} requires a positive integer`), { exitCode: 2 });
  return Number(value);
}

function topCounter(counter, limit) {
  return Object.entries(counter)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
}
