import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  summarizeDaemonLogText,
  summarizeDaemonLogs,
} from '../src/core/daemon-log-diagnostics.mjs';
import { formatDaemonLogSummary } from '../src/cli/diagnostics-cmd.mjs';

const SAMPLE_LOG = [
  '[2026-05-06T00:00:00.000Z] tool-db loaded: 268 tools (project=/repo)',
  '[2026-05-06T00:00:01.000Z] daemon listening on /tmp/sock',
  '[2026-05-06T00:00:02.000Z] started on /tmp/sock',
  '[2026-05-06T00:00:03.000Z] user_input: pass=false, missing=mcp__caveat__caveat_search,current_time, mode=first, duration_ms=21000',
  '[2026-05-06T00:00:04.000Z] turn_end: dropped catalog-external names: Read,Skill(tl)',
  '[2026-05-06T00:00:05.000Z] turn_end: pass=true, missing=, mode=resumed, duration_ms=1200, reason=hallucination_filtered',
  '[2026-05-06T00:00:06.000Z] user_input: role collapse detected, session reset: not json',
  '[2026-05-06T00:00:07.000Z] turn_end: haiku invocation failed (E_HAIKU_TIMEOUT), rotating session before rethrow: timeout',
  '[2026-05-06T00:00:08.000Z] handler error on turn_end: E_HAIKU_TIMEOUT: timeout',
  '[2026-05-06T00:00:09.000Z] FATAL uncaughtException: Error: boom',
  '[2026-05-06T00:00:10.000Z] turn_end: codex_risk_check dispatched pid=123 result=/tmp/result.json',
  '[2026-05-06T00:00:11.000Z] turn_end: codex_risk_check skipped: disabled',
  '[2026-05-06T00:00:12.000Z] daemon stopped',
  '',
].join('\n');

test('summarizeDaemonLogText: aggregates daemon precision signals', () => {
  const summary = summarizeDaemonLogText({
    text: SAMPLE_LOG,
    filePath: '/logs/daemon-session-a.log',
  });

  assert.equal(summary.schema, 'spotter.daemon_log_summary.v1');
  assert.deepEqual(summary.sessions.ids, ['session-a']);
  assert.equal(summary.daemon.toolDbLoaded, 1);
  assert.equal(summary.daemon.starts, 1);
  assert.equal(summary.daemon.stops, 1);
  assert.equal(summary.stages.user_input.calls, 1);
  assert.equal(summary.stages.user_input.passFalse, 1);
  assert.equal(summary.stages.user_input.missingTotal, 2);
  assert.equal(summary.stages.user_input.missingByTool.mcp__caveat__caveat_search, 1);
  assert.equal(summary.stages.user_input.modes.first.averageDurationMs, 21000);
  assert.equal(summary.stages.turn_end.calls, 1);
  assert.equal(summary.stages.turn_end.reasons.hallucination_filtered, 1);
  assert.equal(summary.anomalies.hallucinationFiltered, 1);
  assert.equal(summary.anomalies.catalogExternalDropped.events, 1);
  assert.equal(summary.anomalies.catalogExternalDropped.names.Read, 1);
  assert.equal(summary.anomalies.roleCollapseReset, 1);
  assert.equal(summary.anomalies.haikuInvocationFailures.byCode.E_HAIKU_TIMEOUT, 1);
  assert.equal(summary.anomalies.handlerErrors.byCode.E_HAIKU_TIMEOUT, 1);
  assert.equal(summary.anomalies.fatals.byKind.uncaughtException, 1);
  assert.equal(summary.codexRiskCheck.dispatched, 1);
  assert.equal(summary.codexRiskCheck.disabledSkips, 1);
});

test('summarizeDaemonLogs: reads daemon log files from a directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-log-diagnostics-'));
  try {
    await writeFile(join(dir, 'daemon-session-a.log'), SAMPLE_LOG, 'utf8');
    await writeFile(join(dir, 'not-a-daemon.log'), SAMPLE_LOG, 'utf8');
    const summary = await summarizeDaemonLogs({ logDir: dir });
    assert.equal(summary.files.total, 1);
    assert.equal(summary.files.parsed, 1);
    assert.deepEqual(summary.sessions.ids, ['session-a']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('summarizeDaemonLogText: parses Phase 1 backend-tagged stage lines', () => {
  const summary = summarizeDaemonLogText({
    text: '[2026-05-06T00:00:03.000Z] user_input: pass=true, missing=, backend=haiku, mode=first, duration_ms=42\n',
    filePath: '/logs/daemon-session-b.log',
  });

  assert.equal(summary.stages.user_input.calls, 1);
  assert.equal(summary.stages.user_input.passTrue, 1);
  assert.equal(summary.stages.user_input.modes.first.averageDurationMs, 42);
});

test('formatDaemonLogSummary: produces compact human-readable output', () => {
  const summary = summarizeDaemonLogText({
    text: SAMPLE_LOG,
    filePath: '/logs/daemon-session-a.log',
  });
  const output = formatDaemonLogSummary(summary);

  assert.match(output, /spotter diagnostics logs/);
  assert.match(output, /user_input: calls=1, pass=false=1, missing=2/);
  assert.match(output, /top missing: current_time=1, mcp__caveat__caveat_search=1/);
  assert.match(output, /anomalies: role_collapse=1, hallucination_filtered=1/);
  assert.match(output, /codex_risk_check: dispatched=1, disabled_skips=1/);
});
