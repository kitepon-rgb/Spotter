import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startDaemon, DaemonAlreadyRunningError, pidFilePath } from '../src/daemon/daemon.mjs';
import { sendRequest } from '../src/daemon/transport.mjs';
import { mkdtemp, writeFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

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
  const running = await startDaemon({ sessionId, tools, haikuCaller, haikuCallWindowMs: 0 });
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
