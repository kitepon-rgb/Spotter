import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runPreToolUse } from '../src/hooks/pre-tool-use.mjs';
import { startDaemon } from '../src/daemon/daemon.mjs';
import { sendRequest, TransportError } from '../src/daemon/transport.mjs';

test('PreToolUse: evaluation target transport failure closes the session observation as outcome_missing', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-evaluation-pretool-failure-'));
  const calls = [];
  const events = [];
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    await runPreToolUse({
      readInput: async () => ({
        session_id: 'session-transport-failure',
        cwd: project,
        tool_name: 'Skill',
        tool_input: { skill: 'throughline' },
      }),
      sendRequestFn: async () => {
        throw new TransportError('E_UNREACHABLE', 'daemon unavailable');
      },
      createEvaluationStoreFn: () => ({
        closeOpenTurnsForSession(input) { calls.push(['close-open', input]); return { closed: 1 }; },
        close() { calls.push(['close']); },
      }),
      recordHookEventFn: async ({ event }) => { events.push(event); },
    });

    assert.deepEqual(calls, [
      ['close-open', { sessionId: 'session-transport-failure' }],
      ['close'],
    ]);
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'degraded');
    assert.equal(events[0].reason, 'transport');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('PreToolUse: built-in transport failure does not invalidate evaluation usage', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-evaluation-pretool-builtin-'));
  let openedStore = false;
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    await runPreToolUse({
      readInput: async () => ({
        session_id: 'session-builtin-failure',
        cwd: project,
        tool_name: 'Bash',
        tool_input: { command: 'pwd' },
      }),
      sendRequestFn: async () => {
        throw new TransportError('E_UNREACHABLE', 'daemon unavailable');
      },
      createEvaluationStoreFn: () => {
        openedStore = true;
        throw new Error('must not open');
      },
      recordHookEventFn: async () => {},
    });
    assert.equal(openedStore, false);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('PreToolUse: daemon-side evaluation error closes the session observation once', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-evaluation-pretool-daemon-error-'));
  const calls = [];
  const events = [];
  let stderr = '';
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    await runPreToolUse({
      readInput: async () => ({
        session_id: 'session-daemon-record-error',
        cwd: project,
        tool_name: 'Skill',
        tool_input: { skill: 'throughline' },
      }),
      sendRequestFn: async () => ({ ok: true, result: { recorded: true, evaluation_record_error: true } }),
      createEvaluationStoreFn: () => ({
        closeOpenTurnsForSession(input) { calls.push(input); return { closed: 1 }; },
        close() {},
      }),
      recordHookEventFn: async ({ event }) => { events.push(event); },
      writeError: (text) => { stderr += text; },
    });

    assert.deepEqual(calls, [{ sessionId: 'session-daemon-record-error' }]);
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'degraded');
    assert.equal(events[0].reason, 'evaluation_record_error');
    assert.match(stderr, /評価記録に失敗/);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('daemon: SQLite usage failure closes incomplete while preserving raw turn_end usedTools', async () => {
  const sessionId = `es-${randomUUID()}`;
  const prompts = [];
  const calls = [];
  const evaluationStore = {
    recordUsage() { throw new Error('sqlite write failed'); },
    markUsageIncomplete(input) { calls.push(['mark-incomplete', input]); return { changed: true }; },
    closeTurn(input) { calls.push(['close-turn', input]); return { closed: true }; },
    closeOpenTurnsForSession(input) { calls.push(['close-open', input]); return { closed: 0 }; },
    close() { calls.push(['close-store']); },
  };
  const running = await startDaemon({
    sessionId,
    tools: [],
    evaluationStore,
    haikuCallWindowMs: 0,
    stopShortFinalMaxChars: 0,
    haikuCaller: async (prompt) => {
      prompts.push(prompt);
      return JSON.stringify({ pass: true, missing_tools: [] });
    },
  });
  try {
    await sendRequest({
      sessionId,
      event: 'user_input',
      payload: { user_input: '評価記録失敗の確認', observation_id: 'obs-sqlite-failure' },
      timeoutMs: 2_000,
    });
    const usage = await sendRequest({
      sessionId,
      event: 'tool_used',
      payload: {
        tool_name: 'Skill',
        evaluation_observed: true,
        evaluation_tool_id: 'throughline',
        usage_incomplete: false,
      },
      timeoutMs: 2_000,
    });
    assert.equal(usage.result.evaluation_record_error, true);

    await sendRequest({
      sessionId,
      event: 'turn_end',
      payload: { final_response: '十分に長い最終応答です', stop_hook_active: false },
      timeoutMs: 2_000,
    });

    assert.deepEqual(calls.filter(([kind]) => kind === 'close-turn'), [[
      'close-turn',
      { observationId: 'obs-sqlite-failure', usageStatus: 'incomplete' },
    ]]);
    assert.match(prompts[1], /Skill/);
  } finally {
    await running.stop();
  }
});

test('daemon: tool_used handler error marks the active evaluation incomplete before Stop', async () => {
  const sessionId = `eh-${randomUUID()}`;
  const calls = [];
  const evaluationStore = {
    recordUsage() { return { recorded: true }; },
    markUsageIncomplete() { return { changed: true }; },
    closeTurn(input) { calls.push(input); return { closed: true }; },
    closeOpenTurnsForSession() { return { closed: 0 }; },
    close() {},
  };
  const running = await startDaemon({
    sessionId,
    tools: [],
    evaluationStore,
    haikuCallWindowMs: 0,
    haikuCaller: async () => JSON.stringify({ pass: true, missing_tools: [] }),
  });
  try {
    await sendRequest({
      sessionId,
      event: 'user_input',
      payload: { user_input: '評価handler失敗の確認', observation_id: 'obs-handler-failure' },
      timeoutMs: 2_000,
    });
    const failed = await sendRequest({
      sessionId,
      event: 'tool_used',
      payload: { tool_name: '', evaluation_observed: true },
      timeoutMs: 2_000,
    });
    assert.equal(failed.ok, false);
    await sendRequest({
      sessionId,
      event: 'turn_end',
      payload: { final_response: '了解', stop_hook_active: true },
      timeoutMs: 2_000,
    });
    assert.deepEqual(calls, [{ observationId: 'obs-handler-failure', usageStatus: 'incomplete' }]);
  } finally {
    await running.stop();
  }
});
