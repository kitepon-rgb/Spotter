// hook ⇄ daemon transport (§5.6 socket abstraction, §5.7 envelope).
// Cross-platform: Unix domain socket on macOS/Linux, Named Pipe on Windows.
// Wire format: newline-delimited JSON, one request or response per line.

import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const RUNTIME_DIR = join(homedir(), '.spotter', 'runtime');

export function socketPath(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new TypeError('sessionId must be a non-empty string');
  }
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\spotter-${sessionId}`;
  }
  return join(RUNTIME_DIR, `session-${sessionId}.sock`);
}

export async function ensureRuntimeDir() {
  await mkdir(RUNTIME_DIR, { recursive: true });
  return RUNTIME_DIR;
}

// Request/response over a single connection. Used by hooks.
export function sendRequest({ sessionId, event, payload, timeoutMs }) {
  if (typeof timeoutMs !== 'number' || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a positive number');
  }
  const envelope = {
    id: randomUUID(),
    event,
    session_id: sessionId,
    payload: payload ?? {},
  };

  return new Promise((resolve, reject) => {
    const path = socketPath(sessionId);
    const sock = net.createConnection(path);
    let buf = '';
    let settled = false;

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      fn(value);
    };

    const timer = setTimeout(() => {
      settle(reject, new TransportError('E_TIMEOUT', `daemon did not respond within ${timeoutMs}ms`));
    }, timeoutMs);

    sock.on('connect', () => {
      sock.write(JSON.stringify(envelope) + '\n');
    });

    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const newlineIdx = buf.indexOf('\n');
      if (newlineIdx === -1) return;
      const line = buf.slice(0, newlineIdx);
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        settle(reject, new TransportError('E_INTERNAL', `invalid JSON from daemon: ${err.message}`));
        return;
      }
      if (parsed.id !== envelope.id) {
        settle(reject, new TransportError('E_INTERNAL', `id mismatch: sent ${envelope.id}, got ${parsed.id}`));
        return;
      }
      settle(resolve, parsed);
    });

    sock.on('error', (err) => {
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
        settle(reject, new TransportError('E_UNREACHABLE', `daemon unreachable at ${path}: ${err.code}`));
      } else {
        settle(reject, new TransportError('E_INTERNAL', `socket error: ${err.message}`));
      }
    });
  });
}

export class TransportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TransportError';
    this.code = code;
  }
}

// Daemon side: listen on socket, dispatch envelopes through a handler.
// handler: async (envelope) => result — result is put into { ok: true, result } or
// on throw packed into { ok: false, error: { code, message } }.
export function createServer({ sessionId, handler, onError }) {
  const path = socketPath(sessionId);
  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', async (chunk) => {
      buf += chunk.toString('utf8');
      let newlineIdx;
      while ((newlineIdx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, newlineIdx);
        buf = buf.slice(newlineIdx + 1);
        if (line.length === 0) continue;
        let envelope;
        try {
          envelope = JSON.parse(line);
        } catch (err) {
          // Malformed client input — write minimal error response with null id.
          conn.write(JSON.stringify({
            id: null,
            ok: false,
            error: { code: 'E_INTERNAL', message: `invalid JSON: ${err.message}` },
          }) + '\n');
          continue;
        }
        try {
          const result = await handler(envelope);
          conn.write(JSON.stringify({ id: envelope.id, ok: true, result }) + '\n');
        } catch (err) {
          const code = err.code && typeof err.code === 'string' ? err.code : 'E_INTERNAL';
          const message = err.message ?? String(err);
          conn.write(JSON.stringify({ id: envelope.id, ok: false, error: { code, message } }) + '\n');
          if (onError) onError(err, envelope);
        }
      }
    });
    conn.on('error', (err) => {
      if (onError) onError(err, null);
    });
  });

  return { server, path };
}
