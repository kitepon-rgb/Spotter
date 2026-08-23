// OS依存のhook⇄daemon IPC面の唯一の置き場。
// Unix domain socket (macOS/Linux) と Named Pipe (Windows) の差はこのファイルが
// 所有し、呼び出し側 (transport / daemon) は process.platform を見ない。

import { chmod, mkdir, unlink } from 'node:fs/promises';
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
  await mkdir(RUNTIME_DIR, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    await chmod(RUNTIME_DIR, 0o700);
  }
  return RUNTIME_DIR;
}

export async function secureSocketFile(path) {
  if (process.platform === 'win32') return;
  await chmod(path, 0o600);
}

// Remove a Unix domain socket file left behind by a daemon that died ungracefully (SIGKILL,
// crash, or machine sleep before SessionEnd ran stop()'s cleanup). stop() unlinks the socket only
// on graceful shutdown, so an orphan file persists otherwise. The CALLER MUST have already
// confirmed no live daemon owns this session (assertNoLiveDaemon) — only then is the file known to
// be stale. Without removing it, server.listen(path) fails with EADDRINUSE and the daemon dies
// before "daemon listening", so every resurrect attempt crash-loops and the session is never
// audited again (observed: Kikoeru session 83d7aa04 — 5 failed restarts, all stuck at backend
// selection). ENOENT is the normal first-run / no-stale-file case and is ignored; any other error
// is rethrown (§0: no silent swallow). No-op on Windows — a Named Pipe vanishes when its owning
// process exits, so there is no filesystem artifact to remove.
export async function removeStaleSocketFile(path) {
  if (process.platform === 'win32') return;
  try {
    await unlink(path);
  } catch (err) {
    if (err?.code === 'ENOENT') return;
    throw err;
  }
}
