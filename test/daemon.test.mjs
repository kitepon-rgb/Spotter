import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startDaemon } from '../src/daemon/daemon.mjs';
import { sendRequest } from '../src/daemon/transport.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

async function setupCatalog() {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-test-'));
  const catalogPath = join(dir, 'tools.yaml');
  await writeFile(catalogPath, `version: 1
tools:
  - name: current_time
    purpose: get the current time
    when_to_use:
      - time questions
    test_cases:
      - user_input: "何時?"
        expected_tool: current_time
`, 'utf8');
  return { dir, catalogPath };
}

test('startDaemon: user_input event dispatches to Haiku stub', async () => {
  const { dir, catalogPath } = await setupCatalog();
  const sessionId = `d-${randomUUID()}`;
  let haikuCalls = 0;
  const haikuCaller = async () => {
    haikuCalls += 1;
    return JSON.stringify({
      pass: false,
      missing_tools: [{ name: 'current_time', reason: 'time question' }],
    });
  };
  const running = await startDaemon({ sessionId, catalogPath, haikuCaller });
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

test('startDaemon: tool_used records without invoking Haiku', async () => {
  const { dir, catalogPath } = await setupCatalog();
  const sessionId = `d-${randomUUID()}`;
  let haikuCalls = 0;
  const haikuCaller = async () => {
    haikuCalls += 1;
    return JSON.stringify({ pass: true, missing_tools: [] });
  };
  const running = await startDaemon({ sessionId, catalogPath, haikuCaller });
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
  const { dir, catalogPath } = await setupCatalog();
  const sessionId = `d-${randomUUID()}`;
  let haikuCalls = 0;
  const haikuCaller = async () => {
    haikuCalls += 1;
    return JSON.stringify({ pass: false, missing_tools: [{ name: 'current_time', reason: 'r' }] });
  };
  const running = await startDaemon({ sessionId, catalogPath, haikuCaller });
  try {
    // first set a user_input so state.lastUserInput is populated
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

test('startDaemon: session_id mismatch rejected as E_INTERNAL', async () => {
  const { dir, catalogPath } = await setupCatalog();
  const sessionId = `d-${randomUUID()}`;
  const running = await startDaemon({
    sessionId,
    catalogPath,
    haikuCaller: async () => JSON.stringify({ pass: true, missing_tools: [] }),
  });
  try {
    // craft a request whose envelope session_id differs from the daemon's session_id
    const { sendRequest: realSend } = await import('../src/daemon/transport.mjs');
    // sendRequest uses the session id for socket lookup AND envelope.session_id — they're coupled,
    // so we can only test this by bypassing sendRequest. Minimal raw client:
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

test('startDaemon: throws on missing catalog', async () => {
  const sessionId = `d-${randomUUID()}`;
  await assert.rejects(
    startDaemon({
      sessionId,
      catalogPath: '/nonexistent/catalog.yaml',
      haikuCaller: async () => JSON.stringify({ pass: true, missing_tools: [] }),
    })
  );
});

test('startDaemon: readiness event responds immediately', async () => {
  const { dir, catalogPath } = await setupCatalog();
  const sessionId = `d-${randomUUID()}`;
  const running = await startDaemon({
    sessionId,
    catalogPath,
    haikuCaller: async () => { throw new Error('should not be called'); },
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
