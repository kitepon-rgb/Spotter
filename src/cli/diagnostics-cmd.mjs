import { resolve } from 'node:path';
import { defaultDaemonLogDir, summarizeDaemonLogs } from '../core/daemon-log-diagnostics.mjs';

const DIAGNOSTICS_USAGE = `spotter diagnostics — read-only operational diagnostics

Usage:
  spotter diagnostics logs [--log-dir DIR] [--json]
`;

export async function runDiagnosticsCommand({ argv = process.argv.slice(2) } = {}) {
  const sub = argv[0];
  if (sub === 'logs') {
    await runDiagnosticsLogsCommand({ argv: argv.slice(1) });
    return;
  }
  process.stderr.write(`unknown diagnostics subcommand: ${sub}\n${DIAGNOSTICS_USAGE}`);
  process.exit(2);
}

export async function runDiagnosticsLogsCommand({
  argv = [],
  summarizeDaemonLogsFn = summarizeDaemonLogs,
  writeOutput = (text) => process.stdout.write(text),
} = {}) {
  const opts = parseLogsArgs(argv);
  const summary = await summarizeDaemonLogsFn({ logDir: opts.logDir });
  if (opts.json) {
    writeOutput(JSON.stringify(summary, null, 2) + '\n');
    return;
  }
  writeOutput(formatDaemonLogSummary(summary));
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

  return lines.join('\n') + '\n';
}

function parseLogsArgs(argv) {
  const opts = {
    logDir: defaultDaemonLogDir(),
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--log-dir') {
      opts.logDir = resolve(requireValue(argv, (index += 1), '--log-dir'));
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

function topCounter(counter, limit) {
  return Object.entries(counter)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
}
