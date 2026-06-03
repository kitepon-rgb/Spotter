import { test } from 'node:test';
import assert from 'node:assert/strict';
import { socketPath, sendRequest, createServer, TransportError, ensureRuntimeDir, secureSocketFile, removeStaleSocketFile } from '../src/daemon/transport.mjs';
import { randomUUID } from 'node:crypto';
import { stat, unlink, writeFile } from 'node:fs/promises';

test('socketPath: Windows uses Named Pipe namespace', { skip: process.platform !== 'win32' }, () => {
  assert.equal(socketPath('abc'), '\\\\.\\pipe\\spotter-abc');
});

test('socketPath: Unix uses ~/.spotter/runtime/session-*.sock', { skip: process.platform === 'win32' }, () => {
  const path = socketPath('abc');
  assert.ok(path.endsWith('/session-abc.sock'));
});

test('socketPath: throws on empty session id', () => {
  assert.throws(() => socketPath(''), TypeError);
  assert.throws(() => socketPath(null), TypeError);
});

test('sendRequest: returns E_UNREACHABLE when daemon not listening', async () => {
  const bogusId = `missing-${randomUUID()}`;
  await assert.rejects(
    sendRequest({ sessionId: bogusId, event: 'readiness', timeoutMs: 500 }),
    (err) => err instanceof TransportError && err.code === 'E_UNREACHABLE'
  );
});

test('ensureRuntimeDir: Unix runtime dir is owner-only', { skip: process.platform === 'win32' }, async () => {
  const dir = await ensureRuntimeDir();
  const mode = (await stat(dir)).mode & 0o777;
  assert.equal(mode, 0o700);
});

test('secureSocketFile: Unix socket is owner-only', { skip: process.platform === 'win32' }, async () => {
  await ensureRuntimeDir();
  const sessionId = `perm-${randomUUID()}`;
  const { server, path } = createServer({ sessionId, handler: async () => ({ ok: true }) });
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(path, resolve);
  });

  try {
    await secureSocketFile(path);
    const mode = (await stat(path)).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    await new Promise((r) => server.close(r));
    await unlink(path).catch((err) => {
      if (err.code !== 'ENOENT') throw err;
    });
  }
});

test('removeStaleSocketFile: a fresh daemon can rebind after an ungraceful death left a stale socket', { skip: process.platform === 'win32' }, async () => {
  await ensureRuntimeDir();
  const sessionId = `stale-${randomUUID()}`;
  const path = socketPath(sessionId);

  // Simulate the socket file an ungracefully-killed daemon leaves behind (its stop() never ran).
  // Any pre-existing file at the bind path makes the Unix bind() fail with EADDRINUSE.
  await writeFile(path, '');

  // Reproduce the bug: without cleanup, listen() fails with EADDRINUSE — this is exactly why the
  // daemon never reached "daemon listening" and every resurrect crash-looped.
  const blocked = createServer({ sessionId, handler: async () => ({ ok: true }) });
  await assert.rejects(
    new Promise((resolve, reject) => {
      blocked.server.on('error', reject);
      blocked.server.listen(path, resolve);
    }),
    (err) => err.code === 'EADDRINUSE',
  );

  // The fix: drop the stale socket, then a fresh daemon binds and actually serves.
  await removeStaleSocketFile(path);
  const fresh = createServer({ sessionId, handler: async (envelope) => ({ echoed_id: envelope.id }) });
  await new Promise((resolve, reject) => {
    fresh.server.on('error', reject);
    fresh.server.listen(path, resolve);
  });
  try {
    const resp = await sendRequest({ sessionId, event: 'readiness', timeoutMs: 2_000 });
    assert.equal(resp.ok, true);
  } finally {
    await new Promise((r) => fresh.server.close(r));
    await unlink(path).catch((err) => {
      if (err.code !== 'ENOENT') throw err;
    });
  }
});

test('removeStaleSocketFile: absent file (ENOENT) is a no-op, not an error', { skip: process.platform === 'win32' }, async () => {
  await ensureRuntimeDir();
  const path = socketPath(`noent-${randomUUID()}`);
  await unlink(path).catch(() => {});
  await removeStaleSocketFile(path); // must not throw
  await assert.rejects(stat(path), (err) => err.code === 'ENOENT');
});

test('removeStaleSocketFile: no-op on Windows Named Pipe path', { skip: process.platform !== 'win32' }, async () => {
  // Named pipes are not filesystem files; there is nothing to unlink and it must not throw.
  await removeStaleSocketFile(socketPath(`win-${randomUUID()}`));
  assert.ok(true);
});

test('round-trip: server echoes result through envelope', async () => {
  await ensureRuntimeDir();
  const sessionId = `rt-${randomUUID()}`;
  const handler = async (envelope) => {
    if (envelope.event !== 'readiness') throw new Error('unexpected event');
    return { ready: true, echoed_id: envelope.id };
  };
  const { server, path } = createServer({ sessionId, handler });
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(path, resolve);
  });

  try {
    const resp = await sendRequest({ sessionId, event: 'readiness', timeoutMs: 2_000 });
    assert.equal(resp.ok, true);
    assert.equal(resp.result.ready, true);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('round-trip: handler throw becomes ok:false envelope', async () => {
  await ensureRuntimeDir();
  const sessionId = `err-${randomUUID()}`;
  const handler = async () => {
    const e = new Error('boom');
    e.code = 'E_CATALOG_MISSING';
    throw e;
  };
  const { server, path } = createServer({ sessionId, handler });
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(path, resolve);
  });

  try {
    const resp = await sendRequest({ sessionId, event: 'user_input', timeoutMs: 2_000 });
    assert.equal(resp.ok, false);
    assert.equal(resp.error.code, 'E_CATALOG_MISSING');
    assert.equal(resp.error.message, 'boom');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('round-trip: malformed envelope id returns E_INTERNAL', async () => {
  // Server checks envelope shape; we send garbage directly via sendRequest's wire format would not
  // naturally produce this, so we validate at the server by sending a bad id via a raw client.
  // Minimal assertion: handler is never called on pre-parse errors.
  await ensureRuntimeDir();
  const sessionId = `raw-${randomUUID()}`;
  let handlerCalls = 0;
  const handler = async () => { handlerCalls += 1; return {}; };
  const { server, path } = createServer({ sessionId, handler });
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(path, resolve);
  });

  const net = await import('node:net');
  await new Promise((resolve) => {
    const sock = net.createConnection(path, () => {
      sock.write('not json\n');
      sock.on('data', (chunk) => {
        const resp = JSON.parse(chunk.toString().split('\n')[0]);
        assert.equal(resp.ok, false);
        assert.equal(resp.error.code, 'E_INTERNAL');
        sock.destroy();
        resolve();
      });
    });
  });
  await new Promise((r) => server.close(r));
  assert.equal(handlerCalls, 0);
});
