// SessionStart hook — spawn daemon detached, wait up to 3s for readiness (§9.1).
//
// §14.3 classifies readiness failure as unexpected (exit 2). §14.1 forbids silent fallback.
//
// v0.2 gates (plan §18, C:\Users\kite_\.claude\plans\10-cuddly-codd.md):
//   - isChildCall: Spotter's own claude -p subprocess → exit 0 (prevents recursion)
//   - isSubagentCall: Bell's Task subagent → exit 0 (not audited in v0.2)
//   - source !== 'startup': /compact, /clear, --resume, --continue → exit 0
//     (these continue an existing parent session; v0.2 does not migrate daemon state)

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readStdinJson, requireString, die, isChildCall, isSubagentCall } from './lib.mjs';
import { sendRequest, TransportError } from '../daemon/transport.mjs';

const READINESS_TIMEOUT_MS = 3_000;
const POLL_INTERVAL_MS = 100;

export async function runSessionStart({ argv = process.argv, now = Date.now } = {}) {
  // Gate 1 (pre-stdin): Spotter's own claude -p subprocess — exit without reading stdin.
  if (isChildCall()) return;

  const input = await readStdinJson();

  // Gate 2: Task subagent — skip audit.
  if (isSubagentCall(input)) return;

  // Gate 3: non-startup sources (resume/compact/clear) don't spawn a new daemon.
  if (input.source !== 'startup') return;

  const sessionId = requireString(input, 'session_id');

  spawnDaemon(sessionId, argv);

  const deadline = now() + READINESS_TIMEOUT_MS;
  while (now() < deadline) {
    try {
      const resp = await sendRequest({
        sessionId,
        event: 'readiness',
        timeoutMs: 500,
      });
      if (resp.ok === true && resp.result && resp.result.ready === true) {
        return; // success — exit 0 implicitly
      }
    } catch (err) {
      if (!(err instanceof TransportError) || err.code !== 'E_UNREACHABLE') {
        // E_TIMEOUT or internal errors while daemon is booting — keep polling.
        // E_UNREACHABLE means the socket file/pipe doesn't exist yet — also retryable.
      }
    }
    await delay(POLL_INTERVAL_MS);
  }

  die(`daemon did not reach readiness within ${READINESS_TIMEOUT_MS}ms for session ${sessionId}`, 2);
}

function spawnDaemon(sessionId, argv) {
  // Invoke `node <spotter-bin> daemon start --session-id ...` detached.
  const spotterBin = resolveSpotterBin(argv);
  const child = spawn(process.execPath, [spotterBin, 'daemon', 'start', '--session-id', sessionId], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', (err) => {
    // best effort: the polling below will fail if the spawn actually didn't work
    process.stderr.write(`spotter-hook: daemon spawn error: ${err.message}\n`);
  });
  child.unref();
}

function resolveSpotterBin(argv) {
  // argv[1] is the path to the currently running script (bin/spotter.mjs when invoked via CLI,
  // or src/hooks/session-start.mjs in tests). Walk up to the package root.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', 'bin', 'spotter.mjs');
}

// Direct-execution entry — used when called as `node session-start.mjs`.
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  runSessionStart().catch((err) => die(err.message, err.exitCode ?? 2));
}
