// `spotter status` — show running daemons (by PID file) and their socket state.

import { readdir, readFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sendRequest, TransportError } from '../daemon/transport.mjs';

const RUNTIME_DIR = join(homedir(), '.spotter', 'runtime');

export async function runStatus() {
  console.log('spotter status');

  let entries;
  try {
    entries = await readdir(RUNTIME_DIR);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log('  no runtime directory yet — run `spotter install` first');
      return;
    }
    throw err;
  }

  const pidFiles = entries.filter((n) => n.endsWith('.pid'));
  if (pidFiles.length === 0) {
    console.log('  no daemons registered');
    return;
  }

  for (const pidFile of pidFiles) {
    const sessionId = pidFile.replace(/^session-/, '').replace(/\.pid$/, '');
    const pid = await readPid(join(RUNTIME_DIR, pidFile));
    const alive = isProcessAlive(pid);
    let socketState = '?';
    try {
      const resp = await sendRequest({ sessionId, event: 'readiness', timeoutMs: 500 });
      socketState = resp.ok === true ? 'ready' : 'error';
    } catch (err) {
      if (err instanceof TransportError) socketState = err.code;
      else socketState = 'unknown';
    }
    console.log(`  session=${sessionId} pid=${pid} process=${alive ? 'alive' : 'dead'} socket=${socketState}`);
  }
}

async function readPid(path) {
  try {
    return parseInt((await readFile(path, 'utf8')).trim(), 10);
  } catch {
    return NaN;
  }
}

function isProcessAlive(pid) {
  if (!Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}
