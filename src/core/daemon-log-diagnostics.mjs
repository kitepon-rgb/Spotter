import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const LOG_SCHEMA = 'spotter.daemon_log_summary.v1';
const STAGES = ['user_input', 'turn_end'];

export function defaultDaemonLogDir() {
  return join(homedir(), '.spotter', 'logs');
}

export async function summarizeDaemonLogs({
  logDir = defaultDaemonLogDir(),
  readFileFn = readFile,
  readdirFn = readdir,
} = {}) {
  const entries = await readdirFn(logDir, { withFileTypes: true });
  const logFiles = entries
    .filter((entry) => entry.isFile() && /^daemon-.+\.log$/.test(entry.name))
    .map((entry) => join(logDir, entry.name))
    .sort();

  const summary = createEmptySummary({ logDir });
  for (const filePath of logFiles) {
    const text = await readFileFn(filePath, 'utf8');
    mergeSummary(summary, summarizeDaemonLogText({ text, filePath }));
  }
  finalizeSummary(summary);
  return summary;
}

export function summarizeDaemonLogText({ text, filePath = 'daemon-unknown.log' }) {
  if (typeof text !== 'string') {
    throw new TypeError('summarizeDaemonLogText: text must be a string');
  }
  const summary = createEmptySummary({ logDir: null });
  summary.files.total = 1;
  summary.files.parsed = 1;

  const sessionId = sessionIdFromPath(filePath);
  if (sessionId) summary.sessions.ids.push(sessionId);

  for (const rawLine of text.split(/\r?\n/)) {
    const line = parseLogLine(rawLine);
    if (!line) continue;
    parseMessage(summary, line.message);
  }
  finalizeSummary(summary);
  return summary;
}

function createEmptySummary({ logDir }) {
  return {
    schema: LOG_SCHEMA,
    logDir,
    files: {
      total: 0,
      parsed: 0,
    },
    sessions: {
      count: 0,
      ids: [],
    },
    daemon: {
      toolDbLoaded: 0,
      starts: 0,
      stops: 0,
      heartbeatTimeouts: 0,
      restartSignals: 0,
    },
    stages: {
      user_input: createStageSummary(),
      turn_end: createStageSummary(),
    },
    anomalies: {
      roleCollapseReset: 0,
      hallucinationFiltered: 0,
      catalogExternalDropped: {
        events: 0,
        names: {},
      },
      haikuInvocationFailures: {
        total: 0,
        byCode: {},
      },
      handlerErrors: {
        total: 0,
        byCode: {},
      },
      fatals: {
        total: 0,
        byKind: {},
      },
    },
    codexRiskCheck: {
      disabledSkips: 0,
      noProjectRootSkips: 0,
      dispatched: 0,
      dispatchFailures: 0,
    },
  };
}

function createStageSummary() {
  return {
    calls: 0,
    passTrue: 0,
    passFalse: 0,
    missingTotal: 0,
    missingByTool: {},
    reasons: {},
    modes: {},
  };
}

function parseLogLine(rawLine) {
  const trimmed = rawLine.trim();
  if (trimmed.length === 0) return null;
  const match = trimmed.match(/^\[([^\]]+)\]\s+(.*)$/);
  if (!match) return { timestamp: null, message: trimmed };
  return { timestamp: match[1], message: match[2] };
}

function parseMessage(summary, message) {
  if (message.startsWith('tool-db loaded:')) {
    summary.daemon.toolDbLoaded += 1;
    return;
  }
  if (message.startsWith('started on ')) {
    summary.daemon.starts += 1;
    return;
  }
  if (message === 'daemon stopped') {
    summary.daemon.stops += 1;
    return;
  }
  if (message.startsWith('heartbeat timeout ')) {
    summary.daemon.heartbeatTimeouts += 1;
    return;
  }

  const stageLine = message.match(/^(user_input|turn_end): pass=(true|false), missing=(.*?), (?:backend=([^,]+), )?mode=([^,]+), duration_ms=(\d+)(?:, reason=([^,]+))?$/);
  if (stageLine) {
    recordStageCall(summary.stages[stageLine[1]], {
      pass: stageLine[2] === 'true',
      missing: parseMissingList(stageLine[3]),
      mode: stageLine[5],
      durationMs: Number(stageLine[6]),
      reason: stageLine[7] ?? null,
    });
    if (stageLine[7] === 'hallucination_filtered') {
      summary.anomalies.hallucinationFiltered += 1;
    }
    return;
  }

  const droppedLine = message.match(/^(user_input|turn_end): dropped catalog-external names: (.+)$/);
  if (droppedLine) {
    summary.anomalies.catalogExternalDropped.events += 1;
    for (const name of parseMissingList(droppedLine[2])) {
      increment(summary.anomalies.catalogExternalDropped.names, name);
    }
    return;
  }

  if (/^(user_input|turn_end): role collapse detected, session reset:/.test(message)) {
    summary.anomalies.roleCollapseReset += 1;
    return;
  }

  const invocationFailure = message.match(/^(user_input|turn_end): haiku invocation failed \(([^)]+)\),/);
  if (invocationFailure) {
    summary.anomalies.haikuInvocationFailures.total += 1;
    increment(summary.anomalies.haikuInvocationFailures.byCode, invocationFailure[2]);
    return;
  }

  const handlerError = message.match(/^handler error on [^:]+: ([^:]+):/);
  if (handlerError) {
    summary.anomalies.handlerErrors.total += 1;
    increment(summary.anomalies.handlerErrors.byCode, handlerError[1]);
    return;
  }

  const fatal = message.match(/^FATAL ([^:]+):/);
  if (fatal) {
    summary.anomalies.fatals.total += 1;
    increment(summary.anomalies.fatals.byKind, fatal[1]);
    return;
  }

  if (/^(user_input|turn_end): codex_risk_check skipped: disabled$/.test(message)) {
    summary.codexRiskCheck.disabledSkips += 1;
    return;
  }
  if (/^(user_input|turn_end): codex_risk_check skipped: no projectRoot$/.test(message)) {
    summary.codexRiskCheck.noProjectRootSkips += 1;
    return;
  }
  if (/^(user_input|turn_end): codex_risk_check dispatched /.test(message)) {
    summary.codexRiskCheck.dispatched += 1;
    return;
  }
  if (/^(user_input|turn_end): codex_risk_check dispatch failed:/.test(message)) {
    summary.codexRiskCheck.dispatchFailures += 1;
  }
}

function recordStageCall(stage, { pass, missing, mode, durationMs, reason }) {
  stage.calls += 1;
  if (pass) stage.passTrue += 1;
  else stage.passFalse += 1;
  stage.missingTotal += missing.length;
  for (const name of missing) increment(stage.missingByTool, name);
  if (reason) increment(stage.reasons, reason);
  const modeStats = stage.modes[mode] ?? {
    count: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
    averageDurationMs: 0,
  };
  modeStats.count += 1;
  modeStats.totalDurationMs += durationMs;
  modeStats.maxDurationMs = Math.max(modeStats.maxDurationMs, durationMs);
  stage.modes[mode] = modeStats;
}

function parseMissingList(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function mergeSummary(target, source) {
  target.files.total += source.files.total;
  target.files.parsed += source.files.parsed;
  target.sessions.ids.push(...source.sessions.ids);
  target.daemon.toolDbLoaded += source.daemon.toolDbLoaded;
  target.daemon.starts += source.daemon.starts;
  target.daemon.stops += source.daemon.stops;
  target.daemon.heartbeatTimeouts += source.daemon.heartbeatTimeouts;
  for (const stage of STAGES) mergeStage(target.stages[stage], source.stages[stage]);
  target.anomalies.roleCollapseReset += source.anomalies.roleCollapseReset;
  target.anomalies.hallucinationFiltered += source.anomalies.hallucinationFiltered;
  mergeCounter(target.anomalies.catalogExternalDropped.names, source.anomalies.catalogExternalDropped.names);
  target.anomalies.catalogExternalDropped.events += source.anomalies.catalogExternalDropped.events;
  target.anomalies.haikuInvocationFailures.total += source.anomalies.haikuInvocationFailures.total;
  mergeCounter(target.anomalies.haikuInvocationFailures.byCode, source.anomalies.haikuInvocationFailures.byCode);
  target.anomalies.handlerErrors.total += source.anomalies.handlerErrors.total;
  mergeCounter(target.anomalies.handlerErrors.byCode, source.anomalies.handlerErrors.byCode);
  target.anomalies.fatals.total += source.anomalies.fatals.total;
  mergeCounter(target.anomalies.fatals.byKind, source.anomalies.fatals.byKind);
  target.codexRiskCheck.disabledSkips += source.codexRiskCheck.disabledSkips;
  target.codexRiskCheck.noProjectRootSkips += source.codexRiskCheck.noProjectRootSkips;
  target.codexRiskCheck.dispatched += source.codexRiskCheck.dispatched;
  target.codexRiskCheck.dispatchFailures += source.codexRiskCheck.dispatchFailures;
}

function mergeStage(target, source) {
  target.calls += source.calls;
  target.passTrue += source.passTrue;
  target.passFalse += source.passFalse;
  target.missingTotal += source.missingTotal;
  mergeCounter(target.missingByTool, source.missingByTool);
  mergeCounter(target.reasons, source.reasons);
  for (const [mode, stats] of Object.entries(source.modes)) {
    const targetStats = target.modes[mode] ?? {
      count: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
      averageDurationMs: 0,
    };
    targetStats.count += stats.count;
    targetStats.totalDurationMs += stats.totalDurationMs;
    targetStats.maxDurationMs = Math.max(targetStats.maxDurationMs, stats.maxDurationMs);
    target.modes[mode] = targetStats;
  }
}

function finalizeSummary(summary) {
  summary.sessions.ids = [...new Set(summary.sessions.ids)].sort();
  summary.sessions.count = summary.sessions.ids.length;
  summary.daemon.restartSignals = Math.max(0, summary.daemon.toolDbLoaded - summary.sessions.count);
  for (const stage of STAGES) {
    for (const stats of Object.values(summary.stages[stage].modes)) {
      stats.averageDurationMs = stats.count > 0
        ? Math.round(stats.totalDurationMs / stats.count)
        : 0;
    }
  }
}

function sessionIdFromPath(filePath) {
  const match = basename(filePath).match(/^daemon-(.+)\.log$/);
  return match ? match[1] : null;
}

function increment(counter, key) {
  counter[key] = (counter[key] ?? 0) + 1;
}

function mergeCounter(target, source) {
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + value;
  }
}
