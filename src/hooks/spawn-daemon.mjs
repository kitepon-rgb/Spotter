// Shared daemon-spawn + readiness-poll plumbing.
//
// Used by:
//   - session-start.mjs (initial daemon for a fresh session)
//   - user-prompt.mjs   (auto-resurrect when a heartbeat-killed or crashed daemon
//                        is detected at the start of a new turn — v0.12.0)
//
// The hook caller is responsible for the v0.2 gates (isChildCall / isSubagentCall /
// isOutsideSpotterProject) and for resolving sessionId + projectRoot before invoking
// this. We keep this module narrowly focused on "spawn detached + poll until ready".

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { sendRequest, TransportError } from '../daemon/transport.mjs';

const READINESS_TIMEOUT_MS = 3_000;
const POLL_INTERVAL_MS = 100;

export async function spawnDaemonAndWaitReady({ sessionId, projectRoot, now = Date.now }) {
  spawnDaemon(sessionId, projectRoot);

  const deadline = now() + READINESS_TIMEOUT_MS;
  while (now() < deadline) {
    try {
      const resp = await sendRequest({
        sessionId,
        event: 'readiness',
        timeoutMs: 500,
      });
      if (resp.ok === true && resp.result && resp.result.ready === true) {
        return;
      }
    } catch (err) {
      if (!(err instanceof TransportError) || err.code !== 'E_UNREACHABLE') {
        // E_TIMEOUT or internal errors while daemon is booting — keep polling.
      }
    }
    await delay(POLL_INTERVAL_MS);
  }

  const err = new Error(`daemon did not reach readiness within ${READINESS_TIMEOUT_MS}ms for session ${sessionId}`);
  err.exitCode = 2;
  throw err;
}

function spawnDaemon(sessionId, projectRoot) {
  const spotterBin = resolveSpotterBin();
  const child = spawn(
    process.execPath,
    [
      spotterBin, 'daemon', 'start',
      '--session-id', sessionId,
      '--project-root', projectRoot,
    ],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }
  );
  child.on('error', (err) => {
    process.stderr.write(`spotter-hook: daemon spawn error: ${err.message}\n`);
  });
  child.unref();
}

// Fire-and-forget `spotter db refresh`. The daemon in THIS session already loaded the
// pre-refresh tool-db, so any updates land in time for the NEXT session. Detached so
// the hook doesn't wait for MCP/skill/agent discovery to finish.
export function spawnRefreshDetached({ projectRoot, hostAgent = 'claude' }) {
  const spotterBin = resolveSpotterBin();
  const child = spawn(
    process.execPath,
    [spotterBin, 'db', 'refresh', '--host-agent', hostAgent],
    {
      cwd: projectRoot,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }
  );
  child.on('error', (err) => {
    process.stderr.write(`spotter-hook: refresh spawn error: ${err.message}\n`);
  });
  child.unref();
}

function resolveSpotterBin() {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', 'bin', 'spotter.mjs');
}
