import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  startDaemon,
  DaemonAlreadyRunningError,
  pidFilePath,
  shouldSkipShortStop,
  resolveStopShortFinalMaxChars,
  DEFAULT_STOP_SHORT_FINAL_MAX_CHARS,
} from '../src/daemon/daemon.mjs';
import { sendRequest } from '../src/daemon/transport.mjs';
import { HaikuError } from '../src/daemon/haiku-caller.mjs';
import { mkdtemp, writeFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

// v0.7.0: tests pass `tools` directly to startDaemon (an array of {name, description}).
// `dir` is still returned for parity with prior cleanup paths and for tests that need a
// temp directory for other reasons.
async function setupCatalog() {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-test-'));
  const tools = [
    { name: 'current_time', description: 'get the current time' },
  ];
  return { dir, tools };
}

test('startDaemon: user_input event dispatches to Haiku stub', async () => {
  const { dir, tools } = await setupCatalog();
  const sessionId = `d-${randomUUID()}`;
  let haikuCalls = 0;
  const haikuCaller = async (_prompt) => {
    haikuCalls += 1;
    return JSON.stringify({
      pass: false,
      missing_tools: [{ name: 'current_time', reason: 'time question' }],
    });
  };
  const running = await startDaemon({ sessionId, tools, haikuCaller });
  try {
    const resp = await sendRequest({
      sessionId,
      event: 'user_input',
      payload: { user_input: '今何時?' },
      timeoutMs: 2_000,
    });
    assert.equal(resp.ok, true);
    assert.equal(resp.result.pass, false);
    assert.equal(resp.result.missing_tools[0].name, 'current_time');
    assert.equal(haikuCalls, 1);
  } finally {
    await running.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('startDaemon: non-fresh user input updates turn state without invoking auditor', async () => {
  const { dir, tools } = await setupCatalog();
  const sessionId = `d-${randomUUID()}`;
  let haikuCalls = 0;
  const haikuCaller = async () => {
    haikuCalls += 1;
    return JSON.stringify({ pass: true, missing_tools: [] });
  };
  const running = await startDaemon({
    sessionId,
    tools,
    haikuCaller,
    haikuCallWindowMs: 0,
    stopShortFinalMaxChars: 0,
  });
  try {
    const observed = await sendRequest({
      sessionId,
      event: 'user_input',
      payload: { user_input: '続けて', audit: false, context_status: 'stale' },
      timeoutMs: 2_000,
    });
    assert.equal(observed.ok, true);
    assert.equal(observed.result.reason, 'auditor_context_not_fresh');
    assert.equal(haikuCalls, 0);

    const stopped = await sendRequest({
      sessionId,
      event: 'turn_end',
      payload: { final_response: '十分に長い最終応答', stop_hook_active: false },
      timeoutMs: 2_000,
    });
    assert.equal(stopped.ok, true);
    assert.equal(haikuCalls, 1, 'existing Stop auditor must retain the observed turn state');
  } finally {
    await running.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('startDaemon: per-turn prompts carry only the stage delta (no catalog)', async () => {
  // v0.6.0: the daemon builds the preamble (role + schema + catalog) once at startup and
  // threads it into the Haiku caller. Per-turn prompts (what the daemon passes to the
  // caller) carry only the stage-specific payload — the caller is responsible for
  // prepending the preamble on the first call.
  const { dir, tools } = await setupCatalog();
  const sessionId = `d-${randomUUID()}`;
  const promptsSeen = [];
  const haikuCaller = async (prompt) => {
    promptsSeen.push(prompt);
    return JSON.stringify({ pass: true, missing_tools: [] });
  };
  const running = await startDaemon({ sessionId, tools, haikuCaller });
  try {
    await sendRequest({
      sessionId,
      event: 'user_input',
      payload: { user_input: '何時?' },
      timeoutMs: 2_000,
    });
    assert.equal(promptsSeen.length, 1);
    assert.ok(promptsSeen[0].includes('stage=user_input'));
    assert.ok(promptsSeen[0].includes('何時?'));
    assert.ok(!promptsSeen[0].includes('current_time'), 'catalog must not be in per-turn prompt');
    assert.ok(!promptsSeen[0].includes('## 出力'), 'output schema must not be in per-turn prompt');
  } finally {
    await running.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('startDaemon: turn_end per-turn prompt has no <user_input> tag (v0.13.0)', async () => {
  // v0.13.0: stage=turn_end の判定軸が「要請充足チェック」から「ツール適用機会の監査」に
  // 変わった。user_input は渡さない。final_response + used_tools のみで判定する。
  const { dir, tools } = await setupCatalog();
  const sessionId = `d-${randomUUID()}`;
  const promptsSeen = [];
  const haikuCaller = async (prompt) => {
    promptsSeen.push(prompt);
    return JSON.stringify({ pass: true, missing_tools: [] });
  };
  // Phase A: disable short-skip so this test exercises the auditor path even with a
  // short final_response (this test asserts prompt shape, not skip behavior).
  const running = await startDaemon({ sessionId, tools, haikuCaller, haikuCallWindowMs: 0, stopShortFinalMaxChars: 0 });
  try {
    await sendRequest({
      sessionId,
      event: 'user_input',
      payload: { user_input: '何か質問' },
      timeoutMs: 2_000,
    });
    await sendRequest({
      sessionId,
      event: 'turn_end',
      payload: { final_response: 'Bell の最終応答', stop_hook_active: false },
      timeoutMs: 2_000,
    });
    assert.equal(promptsSeen.length, 2);
    const turnEndPrompt = promptsSeen[1];
    assert.ok(turnEndPrompt.includes('stage=turn_end'));
    assert.ok(turnEndPrompt.includes('<final_response>'));
    assert.ok(turnEndPrompt.includes('Bell の最終応答'));
    assert.ok(!turnEndPrompt.includes('<user_input>'), 'turn_end prompt must not contain <user_input> tag (v0.13.0)');
    assert.ok(!turnEndPrompt.includes('何か質問'), 'turn_end prompt must not contain the user question text (v0.13.0)');
  } finally {
    await running.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('startDaemon: tool_used records without invoking Haiku', async () => {
  const { dir, tools } = await setupCatalog();
  const sessionId = `d-${randomUUID()}`;
  let haikuCalls = 0;
  const haikuCaller = async (_prompt) => {
    haikuCalls += 1;
    return JSON.stringify({ pass: true, missing_tools: [] });
  };
  const running = await startDaemon({ sessionId, tools, haikuCaller });
  try {
    const resp = await sendRequest({
      sessionId,
      event: 'tool_used',
      payload: { tool_name: 'read_file' },
      timeoutMs: 2_000,
    });
    assert.equal(resp.ok, true);
    assert.equal(resp.result.recorded, true);
    assert.equal(haikuCalls, 0);
  } finally {
    await running.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('startDaemon: closes the active evaluation exactly once before Stop early returns', async () => {
  const { dir, tools } = await setupCatalog();
  const sessionId = `evaluation-close-${randomUUID()}`;
  const calls = [];
  const evaluationStore = {
    recordUsage: (input) => calls.push(['usage', input]),
    markUsageIncomplete: (input) => calls.push(['incomplete', input]),
    closeTurn: (input) => calls.push(['close', input]),
    closeOpenTurnsForSession: (input) => calls.push(['close-open', input]),
    close: () => calls.push(['store-close']),
  };
  const running = await startDaemon({
    sessionId, tools, evaluationStore,
    haikuCaller: async () => JSON.stringify({ pass: true, missing_tools: [] }),
  });
  try {
    await sendRequest({ sessionId, event: 'user_input', payload: { user_input: '質問', observation_id: 'obs-1' }, timeoutMs: 2_000 });
    await sendRequest({ sessionId, event: 'tool_used', payload: { tool_name: 'current_time', evaluation_observed: true, evaluation_tool_id: 'current_time' }, timeoutMs: 2_000 });
    await sendRequest({ sessionId, event: 'turn_end', payload: { final_response: '了解', stop_hook_active: true }, timeoutMs: 2_000 });
    await sendRequest({ sessionId, event: 'turn_end', payload: { final_response: '了解', stop_hook_active: true }, timeoutMs: 2_000 });
    assert.deepEqual(calls.filter(([kind]) => kind === 'usage'), [['usage', { observationId: 'obs-1', toolIds: ['current_time'] }]]);
    assert.deepEqual(calls.filter(([kind]) => kind === 'close'), [['close', { observationId: 'obs-1' }]]);
  } finally {
    await running.stop();
    assert.deepEqual(calls.filter(([kind]) => kind === 'close-open'), [['close-open', { sessionId }]]);
    assert.equal(calls.filter(([kind]) => kind === 'store-close').length, 1);
    await rm(dir, { recursive: true, force: true });
  }
});

test('startDaemon: Bash remains in raw turn_end usedTools without evaluation-store usage', async () => {
  const { dir, tools } = await setupCatalog();
  const sessionId = `evaluation-raw-${randomUUID()}`;
  const prompts = [];
  let recordUsageCalls = 0;
  const evaluationStore = {
    recordUsage() { recordUsageCalls += 1; return { recorded: true }; },
    markUsageIncomplete() { return { changed: true }; },
    closeTurn() { return { closed: true }; },
    closeOpenTurnsForSession() { return { closed: 0 }; },
    close() {},
  };
  const running = await startDaemon({
    sessionId, tools, evaluationStore, haikuCallWindowMs: 0, stopShortFinalMaxChars: 0,
    haikuCaller: async (prompt) => {
      prompts.push(prompt);
      return JSON.stringify({ pass: true, missing_tools: [] });
    },
  });
  try {
    await sendRequest({ sessionId, event: 'user_input', payload: { user_input: '質問', observation_id: 'obs-raw' }, timeoutMs: 2_000 });
    await sendRequest({ sessionId, event: 'tool_used', payload: { tool_name: 'Bash', evaluation_observed: false, usage_incomplete: false }, timeoutMs: 2_000 });
    await sendRequest({ sessionId, event: 'turn_end', payload: { final_response: '十分に長い最終応答', stop_hook_active: false }, timeoutMs: 2_000 });
    assert.equal(recordUsageCalls, 0);
    assert.match(prompts[1], /Bash/);
  } finally {
    await running.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('startDaemon: successful Skill records canonical evaluation ID while preserving raw turn_end usage', async () => {
  const { dir, tools } = await setupCatalog();
  const sessionId = `evaluation-skill-${randomUUID()}`;
  const prompts = [];
  const usage = [];
  const evaluationStore = {
    recordUsage(input) { usage.push(input); return { recorded: true }; },
    closeTurn() { return { closed: true }; },
    closeOpenTurnsForSession() { return { closed: 0 }; },
    close() {},
  };
  const running = await startDaemon({
    sessionId, tools, evaluationStore, haikuCallWindowMs: 0, stopShortFinalMaxChars: 0,
    haikuCaller: async (prompt) => {
      prompts.push(prompt);
      return JSON.stringify({ pass: true, missing_tools: [] });
    },
  });
  try {
    await sendRequest({ sessionId, event: 'user_input', payload: { user_input: '質問', observation_id: 'obs-skill' }, timeoutMs: 2_000 });
    await sendRequest({ sessionId, event: 'tool_used', payload: { tool_name: 'Skill', evaluation_observed: true, evaluation_tool_id: 'throughline' }, timeoutMs: 2_000 });
    await sendRequest({ sessionId, event: 'turn_end', payload: { final_response: '十分に長い最終応答', stop_hook_active: false }, timeoutMs: 2_000 });
    assert.deepEqual(usage, [{ observationId: 'obs-skill', toolIds: ['throughline'] }]);
    assert.match(prompts[1], /Skill/);
    assert.doesNotMatch(prompts[1], /throughline/);
  } finally {
    await running.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('startDaemon: turn_end passes when stop_hook_active is true (§7.5)', async () => {
  const { dir, tools } = await setupCatalog();
  const sessionId = `d-${randomUUID()}`;
  let haikuCalls = 0;
  const haikuCaller = async (_prompt) => {
    haikuCalls += 1;
    return JSON.stringify({ pass: false, missing_tools: [{ name: 'current_time', reason: 'r' }] });
  };
  const running = await startDaemon({ sessionId, tools, haikuCaller });
  try {
    await sendRequest({
      sessionId,
      event: 'user_input',
      payload: { user_input: '?' },
      timeoutMs: 2_000,
    });
    const resp = await sendRequest({
      sessionId,
      event: 'turn_end',
      payload: { final_response: 'reply', stop_hook_active: true },
      timeoutMs: 2_000,
    });
    assert.equal(resp.ok, true);
    assert.equal(resp.result.pass, true);
    // Haiku should have been called only for the user_input, not the turn_end
    assert.equal(haikuCalls, 1);
  } finally {
    await running.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('startDaemon: 10-second window skips concurrent Haiku-invoking events', async () => {
  const { dir, tools } = await setupCatalog();
  const sessionId = `d-${randomUUID()}`;
  let haikuCalls = 0;
  const haikuCaller = async (_prompt) => {
    haikuCalls += 1;
    return JSON.stringify({ pass: true, missing_tools: [] });
  };
  const running = await startDaemon({ sessionId, tools, haikuCaller });
  try {
    // First call advances lastHaikuCallAt
    await sendRequest({
      sessionId,
      event: 'user_input',
      payload: { user_input: '1' },
      timeoutMs: 2_000,
    });
    // Second call within 10s → should be skipped (pass with reason)
    const resp = await sendRequest({
      sessionId,
      event: 'user_input',
      payload: { user_input: '2' },
      timeoutMs: 2_000,
    });
    assert.equal(resp.ok, true);
    assert.equal(resp.result.pass, true);
    assert.equal(resp.result.reason, 'within_haiku_call_window');
    assert.equal(haikuCalls, 1);
  } finally {
    await running.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('startDaemon: session_id mismatch rejected as E_INTERNAL', async () => {
  const { dir, tools } = await setupCatalog();
  const sessionId = `d-${randomUUID()}`;
  const running = await startDaemon({
    sessionId,
    tools,
    haikuCaller: async (_p) => JSON.stringify({ pass: true, missing_tools: [] }),
  });
  try {
    const net = await import('node:net');
    const { socketPath } = await import('../src/daemon/transport.mjs');
    const { randomUUID: uuid } = await import('node:crypto');
    const resp = await new Promise((resolve, reject) => {
      const sock = net.createConnection(socketPath(sessionId));
      const envelope = {
        id: uuid(),
        event: 'user_input',
        session_id: 'wrong-session-id',
        payload: { user_input: '?' },
      };
      sock.on('connect', () => sock.write(JSON.stringify(envelope) + '\n'));
      sock.on('data', (chunk) => {
        resolve(JSON.parse(chunk.toString().split('\n')[0]));
        sock.destroy();
      });
      sock.on('error', reject);
    });
    assert.equal(resp.ok, false);
    assert.equal(resp.error.code, 'E_INTERNAL');
    assert.ok(resp.error.message.includes('session_id mismatch'));
  } finally {
    await running.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('startDaemon: throws when neither tools nor projectRoot is provided (v0.7.0)', async () => {
  const sessionId = `d-${randomUUID()}`;
  await assert.rejects(
    startDaemon({
      sessionId,
      haikuCaller: async (_p) => JSON.stringify({ pass: true, missing_tools: [] }),
    }),
    TypeError
  );
});

test('startDaemon: readiness event responds immediately', async () => {
  const { dir, tools } = await setupCatalog();
  const sessionId = `d-${randomUUID()}`;
  const running = await startDaemon({
    sessionId,
    tools,
    haikuCaller: async (_p) => { throw new Error('should not be called'); },
  });
  try {
    const resp = await sendRequest({ sessionId, event: 'readiness', timeoutMs: 1_000 });
    assert.equal(resp.ok, true);
    assert.equal(resp.result.ready, true);
  } finally {
    await running.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('startDaemon: DaemonAlreadyRunningError when PID file points at live process', async () => {
  const { dir, tools } = await setupCatalog();
  const sessionId = `preexist-${randomUUID()}`;
  // Plant a PID file pointing at the current process (which is definitely alive).
  const pidPath = pidFilePath(sessionId);
  await writeFile(pidPath, String(process.pid), 'utf8');
  try {
    await assert.rejects(
      startDaemon({
        sessionId,
        tools,
        haikuCaller: async (_p) => JSON.stringify({ pass: true, missing_tools: [] }),
      }),
      (err) => err instanceof DaemonAlreadyRunningError && err.sessionId === sessionId
    );
  } finally {
    try { await unlink(pidPath); } catch {}
    await rm(dir, { recursive: true, force: true });
  }
});

test('startDaemon: user_input with schema-violating Haiku output → silent pass + reset', async () => {
  // v0.5.0: role collapse recovery path.
  // If session-scoped Haiku drifts into Bell's persona and returns non-JSON, the daemon
  // must (a) log the detection, (b) call haikuCaller.reset() so the next turn starts a
  // fresh claude -p session, and (c) silent-pass the current turn (reason:
  // role_collapse_reset) so Bell's reply is not blocked on garbage audit output.
  // This is an explicit §0 exception: "想定済み異常 = 記録 + 正常リターン".
  const { dir, tools } = await setupCatalog();
  const sessionId = `collapse-u-${randomUUID()}`;
  let resetCalled = 0;
  const haikuCaller = async (_p) => 'not-valid-json-at-all';
  haikuCaller.reset = () => { resetCalled += 1; };
  const running = await startDaemon({ sessionId, tools, haikuCaller });
  try {
    const resp = await sendRequest({
      sessionId,
      event: 'user_input',
      payload: { user_input: '?' },
      timeoutMs: 2_000,
    });
    assert.equal(resp.ok, true);
    assert.equal(resp.result.pass, true);
    assert.equal(resp.result.reason, 'role_collapse_reset');
    assert.deepEqual(resp.result.missing_tools, []);
    assert.equal(resetCalled, 1);
  } finally {
    await running.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('startDaemon: turn_end with schema-violating Haiku output → silent pass + reset', async () => {
  // v0.5.0: same role-collapse recovery at the Stop-hook stage.
  // We pass haikuCallWindowMs: 0 so the 10-second recursion guard does not mask the
  // turn_end call (which would otherwise silent-pass via within_haiku_call_window).
  const { dir, tools } = await setupCatalog();
  const sessionId = `collapse-t-${randomUUID()}`;
  let resetCalled = 0;
  let call = 0;
  const haikuCaller = async (_p) => {
    call += 1;
    // First call (user_input) succeeds; second call (turn_end) role-collapses.
    if (call === 1) return JSON.stringify({ pass: true, missing_tools: [] });
    return 'Spotter のロールは正式に終了します。あなたのご質問は...';
  };
  haikuCaller.reset = () => { resetCalled += 1; };
  // Phase A: disable short-skip so this test reaches the auditor (and triggers role-collapse
  // recovery) even with a short final_response.
  const running = await startDaemon({ sessionId, tools, haikuCaller, haikuCallWindowMs: 0, stopShortFinalMaxChars: 0 });
  try {
    await sendRequest({
      sessionId,
      event: 'user_input',
      payload: { user_input: '?' },
      timeoutMs: 2_000,
    });
    const resp = await sendRequest({
      sessionId,
      event: 'turn_end',
      payload: { final_response: 'reply', stop_hook_active: false },
      timeoutMs: 2_000,
    });
    assert.equal(resp.ok, true);
    assert.equal(resp.result.pass, true);
    assert.equal(resp.result.reason, 'role_collapse_reset');
    assert.equal(resetCalled, 1);
  } finally {
    await running.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('startDaemon: auditor failure is collected once at the daemon owner boundary', async () => {
  const { dir, tools } = await setupCatalog();
  const sessionId = `runtime-auditor-${randomUUID()}`;
  const observations = [];
  const haikuCaller = async () => {
    throw new HaikuError('E_HAIKU_TIMEOUT', 'SENTINEL_PROVIDER_FAILURE');
  };
  haikuCaller.reset = () => {};
  const running = await startDaemon({
    sessionId,
    tools,
    haikuCaller,
    runtimeErrorObserver: async (kind) => observations.push(kind),
  });
  try {
    const response = await sendRequest({
      sessionId,
      event: 'user_input',
      payload: { user_input: '監査して' },
      timeoutMs: 2_000,
    });
    assert.equal(response.ok, false);
    assert.deepEqual(observations, ['auditor_unavailable']);
  } finally {
    await running.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('startDaemon: PID persistence failure is collected once and closes the listener', async () => {
  const { dir, tools } = await setupCatalog();
  const sessionId = `runtime-persistence-${randomUUID()}`;
  const observations = [];
  await assert.rejects(startDaemon({
    sessionId,
    tools,
    haikuCaller: async () => JSON.stringify({ pass: true, missing_tools: [] }),
    runtimeErrorObserver: async (kind) => observations.push(kind),
    writePidFileFn: async () => { throw Object.assign(new Error('SENTINEL_PID'), { code: 'EIO' }); },
  }), { code: 'EIO' });
  assert.deepEqual(observations, ['daemon_persistence']);
  await assert.rejects(sendRequest({
    sessionId,
    event: 'readiness',
    payload: {},
    timeoutMs: 100,
  }), { code: 'E_UNREACHABLE' });
  await rm(dir, { recursive: true, force: true });
});

test('startDaemon: listen failure is collected once at the transport owner boundary', async () => {
  const { dir, tools } = await setupCatalog();
  const observations = [];
  const server = new EventEmitter();
  server.listen = () => queueMicrotask(() => {
    server.emit('error', Object.assign(new Error('SENTINEL_LISTEN'), { code: 'EADDRINUSE' }));
  });
  await assert.rejects(startDaemon({
    sessionId: `runtime-transport-${randomUUID()}`,
    tools,
    haikuCaller: async () => JSON.stringify({ pass: true, missing_tools: [] }),
    runtimeErrorObserver: async (kind) => observations.push(kind),
    createServerFn: () => ({ server, path: '/tmp/spotter-test-runtime-transport.sock' }),
    removeStaleSocketFileFn: async () => {},
  }), { code: 'EADDRINUSE' });
  assert.deepEqual(observations, ['daemon_transport']);
  await rm(dir, { recursive: true, force: true });
});

test('startDaemon: user_input log records duration_ms and mode=first', async () => {
  // The daemon tags each Haiku-invoking log line with duration_ms (measured around the
  // caller) and mode (first|resumed, read from caller.isFirstCall). This lets us observe
  // resume-path latency savings and role-collapse recovery frequency from log files alone.
  const { dir, tools } = await setupCatalog();
  const sessionId = `log-first-${randomUUID()}`;
  const logs = [];
  const haikuCaller = async (_p) => JSON.stringify({ pass: true, missing_tools: [] });
  haikuCaller.isFirstCall = true;
  const running = await startDaemon({
    sessionId,
    tools,
    haikuCaller,
    logFn: (msg) => logs.push(msg),
  });
  try {
    await sendRequest({
      sessionId,
      event: 'user_input',
      payload: { user_input: '?' },
      timeoutMs: 2_000,
    });
    const line = logs.find((l) => l.startsWith('user_input:'));
    assert.ok(line, 'user_input log line must exist');
    assert.match(line, /backend=haiku/);
    assert.match(line, /mode=first/);
    assert.match(line, /duration_ms=\d+/);
  } finally {
    await running.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('startDaemon: turn_end log records mode=resumed when caller is past its first call', async () => {
  // A resumed call happens after the first successful Haiku round-trip. We simulate this by
  // flipping the stub's isFirstCall between the user_input and turn_end requests.
  const { dir, tools } = await setupCatalog();
  const sessionId = `log-resumed-${randomUUID()}`;
  const logs = [];
  const haikuCaller = async (_p) => JSON.stringify({ pass: true, missing_tools: [] });
  haikuCaller.isFirstCall = true;
  const running = await startDaemon({
    sessionId,
    tools,
    haikuCaller,
    logFn: (msg) => logs.push(msg),
    haikuCallWindowMs: 0,
    // Phase A: disable short-skip so this test reaches the auditor (it asserts mode=resumed,
    // not skip behavior) even with a short final_response.
    stopShortFinalMaxChars: 0,
  });
  try {
    await sendRequest({
      sessionId,
      event: 'user_input',
      payload: { user_input: '?' },
      timeoutMs: 2_000,
    });
    haikuCaller.isFirstCall = false;
    await sendRequest({
      sessionId,
      event: 'turn_end',
      payload: { final_response: 'reply', stop_hook_active: false },
      timeoutMs: 2_000,
    });
    const line = logs.find((l) => l.startsWith('turn_end: pass='));
    assert.ok(line, 'turn_end log line must exist');
    assert.match(line, /backend=haiku/);
    assert.match(line, /mode=resumed/);
    assert.match(line, /duration_ms=\d+/);
  } finally {
    await running.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('startDaemon: heartbeat timeout shuts daemon down after idle (v0.12.0)', async () => {
  // Replaces v0.6.2's parent-PID watch. Every envelope resets a setTimeout; if no event
  // arrives within heartbeatTimeoutMs, the daemon self-shuts. Covers the orphan path
  // where SessionEnd never fires (crash / kill / IDE reload).
  const { dir, tools } = await setupCatalog();
  const sessionId = `hb-${randomUUID()}`;
  const haikuCaller = async (_p) => JSON.stringify({ pass: true, missing_tools: [] });
  let running;
  try {
    running = await startDaemon({
      sessionId,
      tools,
      haikuCaller,
      heartbeatTimeoutMs: 200,
    });
    const closed = new Promise((resolve) => running.server.on('close', resolve));
    const winner = await Promise.race([
      closed.then(() => 'closed'),
      new Promise((res) => setTimeout(() => res('timeout'), 3_000)),
    ]);
    assert.equal(winner, 'closed', 'daemon should close after heartbeat timeout');
  } finally {
    if (running) {
      try { await running.stop(); } catch { /* server may already be closed */ }
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test('startDaemon: incoming envelopes reset the heartbeat (v0.12.0)', async () => {
  const { dir, tools } = await setupCatalog();
  const sessionId = `hb-reset-${randomUUID()}`;
  const haikuCaller = async (_p) => JSON.stringify({ pass: true, missing_tools: [] });
  let running;
  try {
    running = await startDaemon({
      sessionId,
      tools,
      haikuCaller,
      heartbeatTimeoutMs: 300,
    });
    // Ping every 100ms for ~600ms — far longer than the 300ms timeout. If reset works,
    // the daemon must still be alive at the end.
    for (let i = 0; i < 6; i += 1) {
      await new Promise((res) => setTimeout(res, 100));
      const resp = await sendRequest({ sessionId, event: 'readiness', timeoutMs: 500 });
      assert.equal(resp.ok, true, `ping ${i} should succeed (heartbeat must keep daemon alive)`);
    }
  } finally {
    if (running) {
      try { await running.stop(); } catch { /* */ }
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test('startDaemon: rejects non-positive heartbeatTimeoutMs (v0.12.0)', async () => {
  const { dir, tools } = await setupCatalog();
  const sessionId = `hb-bad-${randomUUID()}`;
  try {
    await assert.rejects(
      () => startDaemon({
        sessionId,
        tools,
        heartbeatTimeoutMs: 0,
        haikuCaller: async (_p) => JSON.stringify({ pass: true, missing_tools: [] }),
      }),
      TypeError
    );
    await assert.rejects(
      () => startDaemon({
        sessionId,
        tools,
        heartbeatTimeoutMs: -1,
        haikuCaller: async (_p) => JSON.stringify({ pass: true, missing_tools: [] }),
      }),
      TypeError
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('startDaemon: stale PID file (dead process) does not block startup', async () => {
  const { dir, tools } = await setupCatalog();
  const sessionId = `stale-${randomUUID()}`;
  const pidPath = pidFilePath(sessionId);
  // A PID we're fairly sure isn't ours and is unlikely to be live. Use a huge number.
  await writeFile(pidPath, '99999999', 'utf8');
  let running;
  try {
    running = await startDaemon({
      sessionId,
      tools,
      haikuCaller: async (_p) => JSON.stringify({ pass: true, missing_tools: [] }),
    });
    assert.ok(running);
  } finally {
    if (running) await running.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('startDaemon: drops Haiku hallucinations not in catalog (v0.13.3)', async () => {
  // Haiku returns a tool name that is NOT in the catalog (training-memory leakage /
  // few-shot cargo-cult). The daemon filters it; since no valid entries remain, pass
  // flips to true with reason='hallucination_filtered'.
  const { dir, tools } = await setupCatalog();
  const sessionId = `d-${randomUUID()}`;
  const haikuCaller = async (_prompt) =>
    JSON.stringify({
      pass: false,
      missing_tools: [{ name: 'Skill(tl)', reason: 'bogus' }],
    });
  const running = await startDaemon({ sessionId, tools, haikuCaller });
  try {
    const resp = await sendRequest({
      sessionId,
      event: 'user_input',
      payload: { user_input: 'something' },
      timeoutMs: 2_000,
    });
    assert.equal(resp.ok, true);
    assert.equal(resp.result.pass, true);
    assert.deepEqual(resp.result.missing_tools, []);
    assert.equal(resp.result.reason, 'hallucination_filtered');
  } finally {
    await running.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('startDaemon: rotates session on E_INTERNAL HaikuError before rethrow (v1.1.6)', async () => {
  // Bell の isolated CLAUDE_CONFIG_DIR 継承で haiku が exit 1 し、次 turn で同じ session-id が
  // "already in use" で stuck する失敗連鎖を避けるための回帰テスト。auth / spawn / timeout
  // などの HaikuError (E_HAIKU_SCHEMA 以外) でも、throw 前に必ず callHaiku.reset() を呼ぶ。
  const { dir, tools } = await setupCatalog();
  const sessionId = `d-${randomUUID()}`;
  let resetCalled = 0;
  const haikuCaller = async (_p) => {
    throw new HaikuError('E_INTERNAL', 'haiku exited with code 1: auth failed');
  };
  haikuCaller.reset = () => { resetCalled += 1; };
  const running = await startDaemon({ sessionId, tools, haikuCaller });
  try {
    const resp = await sendRequest({
      sessionId,
      event: 'user_input',
      payload: { user_input: '?' },
      timeoutMs: 2_000,
    });
    assert.equal(resp.ok, false, 'E_INTERNAL must surface as non-ok response');
    assert.equal(resp.error.code, 'E_INTERNAL');
    assert.equal(resetCalled, 1, 'reset() must run exactly once before rethrow');
  } finally {
    await running.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('startDaemon: rotates session on E_HAIKU_TIMEOUT before rethrow (v1.1.6)', async () => {
  // timeout で子プロセスを kill した直後も session-id は claude CLI 側の認識上「使用中」扱い
  // になる可能性がある。次 turn は必ず新 uuid から始める。
  const { dir, tools } = await setupCatalog();
  const sessionId = `d-${randomUUID()}`;
  let resetCalled = 0;
  const haikuCaller = async (_p) => {
    throw new HaikuError('E_HAIKU_TIMEOUT', 'haiku did not respond within 45000ms');
  };
  haikuCaller.reset = () => { resetCalled += 1; };
  const running = await startDaemon({ sessionId, tools, haikuCaller });
  try {
    const resp = await sendRequest({
      sessionId,
      event: 'user_input',
      payload: { user_input: '?' },
      timeoutMs: 2_000,
    });
    assert.equal(resp.ok, false);
    assert.equal(resp.error.code, 'E_HAIKU_TIMEOUT');
    assert.equal(resetCalled, 1);
  } finally {
    await running.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('startDaemon: keeps valid tools when hallucinations mixed in (v0.13.3)', async () => {
  const { dir, tools } = await setupCatalog();
  const sessionId = `d-${randomUUID()}`;
  const haikuCaller = async (_prompt) =>
    JSON.stringify({
      pass: false,
      missing_tools: [
        { name: 'current_time', reason: 'legit' },
        { name: 'Skill(ghost)', reason: 'bogus' },
      ],
    });
  const running = await startDaemon({ sessionId, tools, haikuCaller });
  try {
    const resp = await sendRequest({
      sessionId,
      event: 'user_input',
      payload: { user_input: '今何時?' },
      timeoutMs: 2_000,
    });
    assert.equal(resp.ok, true);
    assert.equal(resp.result.pass, false);
    assert.equal(resp.result.missing_tools.length, 1);
    assert.equal(resp.result.missing_tools[0].name, 'current_time');
  } finally {
    await running.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('startDaemon: opt-in codex_risk_check dispatches pass=false findings asynchronously', async () => {
  const { dir, tools } = await setupCatalog();
  const sessionId = `codex-risk-${randomUUID()}`;
  const dispatches = [];
  const haikuCaller = async (_prompt) =>
    JSON.stringify({
      pass: false,
      missing_tools: [{ name: 'current_time', reason: 'time question' }],
    });
  const running = await startDaemon({
    sessionId,
    projectRoot: dir,
    tools,
    haikuCaller,
    codexRiskCheckEnabled: true,
    codexRiskCheckDryRun: true,
    dispatchCodexRiskCheckFn: async (args) => {
      dispatches.push(args);
      return { dispatched: true, pid: 123, resultPath: '/tmp/result.json' };
    },
  });
  try {
    const resp = await sendRequest({
      sessionId,
      event: 'user_input',
      payload: { user_input: '今何時?' },
      timeoutMs: 2_000,
    });
    assert.equal(resp.ok, true);
    assert.equal(resp.result.pass, false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0].projectRoot, dir);
    assert.equal(dispatches[0].sessionId, sessionId);
    assert.equal(dispatches[0].stage, 'user_input');
    assert.equal(dispatches[0].dryRun, true);
    assert.equal(dispatches[0].judgment.findings[0].toolName, 'current_time');
  } finally {
    await running.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

// Phase A (hook parity, 2026-05-08): short-final + 0 used_tools のターンは Stop auditor を skip。

test('shouldSkipShortStop: skips when final ≤ maxChars and no used tools', () => {
  assert.equal(shouldSkipShortStop({ finalResponse: '了解', usedTools: [], maxChars: 120 }), true);
  assert.equal(shouldSkipShortStop({ finalResponse: '   了解   ', usedTools: [], maxChars: 120 }), true);
});

test('shouldSkipShortStop: does not skip when used tools exist (even if final is short)', () => {
  assert.equal(
    shouldSkipShortStop({ finalResponse: 'caveat 検索しました', usedTools: ['mcp__caveat__caveat_search'], maxChars: 120 }),
    false
  );
});

test('shouldSkipShortStop: does not skip when final exceeds maxChars', () => {
  const long = 'a'.repeat(121);
  assert.equal(shouldSkipShortStop({ finalResponse: long, usedTools: [], maxChars: 120 }), false);
});

test('shouldSkipShortStop: maxChars <= 0 disables the skip entirely', () => {
  assert.equal(shouldSkipShortStop({ finalResponse: '了解', usedTools: [], maxChars: 0 }), false);
  assert.equal(shouldSkipShortStop({ finalResponse: '了解', usedTools: [], maxChars: -1 }), false);
});

test('shouldSkipShortStop: uses code-point length so multibyte chars count as 1', () => {
  // Codex 側 [...str.trim()].length と同じ数え方 (surrogate pair / CJK は 1 文字扱い)
  const cjk = 'あ'.repeat(120); // 120 code points
  assert.equal(shouldSkipShortStop({ finalResponse: cjk, usedTools: [], maxChars: 120 }), true);
  assert.equal(shouldSkipShortStop({ finalResponse: cjk + 'あ', usedTools: [], maxChars: 120 }), false);
});

test('resolveStopShortFinalMaxChars: returns default when env unset / empty', () => {
  assert.equal(resolveStopShortFinalMaxChars({}), DEFAULT_STOP_SHORT_FINAL_MAX_CHARS);
  assert.equal(resolveStopShortFinalMaxChars({ SPOTTER_STOP_SHORT_FINAL_MAX_CHARS: '' }), DEFAULT_STOP_SHORT_FINAL_MAX_CHARS);
});

test('resolveStopShortFinalMaxChars: parses numeric env override', () => {
  assert.equal(resolveStopShortFinalMaxChars({ SPOTTER_STOP_SHORT_FINAL_MAX_CHARS: '200' }), 200);
  assert.equal(resolveStopShortFinalMaxChars({ SPOTTER_STOP_SHORT_FINAL_MAX_CHARS: '0' }), 0);
  assert.equal(resolveStopShortFinalMaxChars({ SPOTTER_STOP_SHORT_FINAL_MAX_CHARS: '-1' }), -1);
});

test('resolveStopShortFinalMaxChars: non-numeric env falls back to default', () => {
  assert.equal(resolveStopShortFinalMaxChars({ SPOTTER_STOP_SHORT_FINAL_MAX_CHARS: 'abc' }), DEFAULT_STOP_SHORT_FINAL_MAX_CHARS);
});

test('startDaemon: turn_end short final + 0 used_tools skips auditor', async () => {
  const { dir, tools } = await setupCatalog();
  const sessionId = `short-skip-${randomUUID()}`;
  let haikuCalls = 0;
  const haikuCaller = async (_prompt) => {
    haikuCalls += 1;
    return JSON.stringify({ pass: true, missing_tools: [] });
  };
  const running = await startDaemon({ sessionId, tools, haikuCaller, haikuCallWindowMs: 0 });
  try {
    await sendRequest({
      sessionId,
      event: 'user_input',
      payload: { user_input: '質問' },
      timeoutMs: 2_000,
    });
    const resp = await sendRequest({
      sessionId,
      event: 'turn_end',
      payload: { final_response: '了解しました', stop_hook_active: false },
      timeoutMs: 2_000,
    });
    assert.equal(resp.ok, true);
    assert.equal(resp.result.pass, true);
    assert.equal(resp.result.reason, 'short_final_no_tools');
    // Haiku was invoked for user_input only (1 call); turn_end was skipped.
    assert.equal(haikuCalls, 1);
  } finally {
    await running.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('startDaemon: turn_end short final but used tools → normal audit (no skip)', async () => {
  const { dir, tools } = await setupCatalog();
  const sessionId = `short-with-tools-${randomUUID()}`;
  let haikuCalls = 0;
  const haikuCaller = async (_prompt) => {
    haikuCalls += 1;
    return JSON.stringify({ pass: true, missing_tools: [] });
  };
  const running = await startDaemon({ sessionId, tools, haikuCaller, haikuCallWindowMs: 0 });
  try {
    await sendRequest({
      sessionId,
      event: 'user_input',
      payload: { user_input: '質問', },
      timeoutMs: 2_000,
    });
    await sendRequest({
      sessionId,
      event: 'tool_used',
      payload: { tool_name: 'mcp__caveat__caveat_search' },
      timeoutMs: 2_000,
    });
    const resp = await sendRequest({
      sessionId,
      event: 'turn_end',
      payload: { final_response: '検索しました', stop_hook_active: false },
      timeoutMs: 2_000,
    });
    assert.equal(resp.ok, true);
    assert.equal(resp.result.pass, true);
    assert.notEqual(resp.result.reason, 'short_final_no_tools');
    // user_input + turn_end の 2 回呼ばれる (skip されない)
    assert.equal(haikuCalls, 2);
  } finally {
    await running.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('startDaemon: turn_end long final + 0 used_tools → normal audit (no skip)', async () => {
  const { dir, tools } = await setupCatalog();
  const sessionId = `long-no-tools-${randomUUID()}`;
  let haikuCalls = 0;
  const haikuCaller = async (_prompt) => {
    haikuCalls += 1;
    return JSON.stringify({ pass: true, missing_tools: [] });
  };
  const running = await startDaemon({
    sessionId,
    tools,
    haikuCaller,
    haikuCallWindowMs: 0,
    stopShortFinalMaxChars: 50,
  });
  try {
    await sendRequest({
      sessionId,
      event: 'user_input',
      payload: { user_input: '質問' },
      timeoutMs: 2_000,
    });
    const resp = await sendRequest({
      sessionId,
      event: 'turn_end',
      payload: { final_response: 'a'.repeat(60), stop_hook_active: false },
      timeoutMs: 2_000,
    });
    assert.equal(resp.ok, true);
    assert.notEqual(resp.result.reason, 'short_final_no_tools');
    assert.equal(haikuCalls, 2);
  } finally {
    await running.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('startDaemon: stopShortFinalMaxChars=0 disables short-skip entirely', async () => {
  const { dir, tools } = await setupCatalog();
  const sessionId = `skip-disabled-${randomUUID()}`;
  let haikuCalls = 0;
  const haikuCaller = async (_prompt) => {
    haikuCalls += 1;
    return JSON.stringify({ pass: true, missing_tools: [] });
  };
  const running = await startDaemon({
    sessionId,
    tools,
    haikuCaller,
    haikuCallWindowMs: 0,
    stopShortFinalMaxChars: 0,
  });
  try {
    await sendRequest({
      sessionId,
      event: 'user_input',
      payload: { user_input: '質問' },
      timeoutMs: 2_000,
    });
    const resp = await sendRequest({
      sessionId,
      event: 'turn_end',
      payload: { final_response: '了解', stop_hook_active: false },
      timeoutMs: 2_000,
    });
    assert.equal(resp.ok, true);
    assert.notEqual(resp.result.reason, 'short_final_no_tools');
    // skip 無効化されているので turn_end も auditor を呼ぶ
    assert.equal(haikuCalls, 2);
  } finally {
    await running.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('startDaemon: short-skip resets state.usedTools and state.lastUserInput', async () => {
  const { dir, tools } = await setupCatalog();
  const sessionId = `short-skip-reset-${randomUUID()}`;
  let haikuCalls = 0;
  const haikuCaller = async (_prompt) => {
    haikuCalls += 1;
    return JSON.stringify({ pass: true, missing_tools: [] });
  };
  const running = await startDaemon({ sessionId, tools, haikuCaller, haikuCallWindowMs: 0 });
  try {
    // turn 1: user_input → short final → skipped
    await sendRequest({
      sessionId,
      event: 'user_input',
      payload: { user_input: '質問1' },
      timeoutMs: 2_000,
    });
    await sendRequest({
      sessionId,
      event: 'turn_end',
      payload: { final_response: '了解', stop_hook_active: false },
      timeoutMs: 2_000,
    });
    // turn 2: turn_end without preceding user_input → must hit no_user_input branch
    // (proves state.lastUserInput was cleared by the short-skip path)
    const resp = await sendRequest({
      sessionId,
      event: 'turn_end',
      payload: { final_response: 'b'.repeat(200), stop_hook_active: false },
      timeoutMs: 2_000,
    });
    assert.equal(resp.ok, true);
    assert.equal(resp.result.reason, 'no_user_input');
    assert.equal(haikuCalls, 1);
  } finally {
    await running.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('startDaemon: codex_risk_check disabled by default does not dispatch pass=false findings', async () => {
  const { dir, tools } = await setupCatalog();
  const sessionId = `codex-risk-off-${randomUUID()}`;
  const haikuCaller = async (_prompt) =>
    JSON.stringify({
      pass: false,
      missing_tools: [{ name: 'current_time', reason: 'time question' }],
    });
  const running = await startDaemon({
    sessionId,
    projectRoot: dir,
    tools,
    haikuCaller,
    codexRiskCheckEnabled: false,
    dispatchCodexRiskCheckFn: async () => {
      throw new Error('dispatch should not be called when disabled');
    },
  });
  try {
    const resp = await sendRequest({
      sessionId,
      event: 'user_input',
      payload: { user_input: '今何時?' },
      timeoutMs: 2_000,
    });
    assert.equal(resp.ok, true);
    assert.equal(resp.result.pass, false);
  } finally {
    await running.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
