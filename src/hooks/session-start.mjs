// SessionStart hook — spawn daemon detached, wait up to 3s for readiness (§9.1).
//
// §14.3 classifies readiness failure as unexpected (exit 2). §14.1 forbids silent fallback.
//
// v0.2 gates (plan §18, C:\Users\kite_\.claude\plans\10-cuddly-codd.md):
//   - isChildCall: Spotter's own claude -p subprocess → exit 0 (prevents recursion)
//   - isSubagentCall: Bell's Task subagent → exit 0 (not audited in v0.2)
//   - source !== 'startup': /compact, /clear, --resume, --continue → exit 0
//     (these continue an existing parent session; v0.2 does not migrate daemon state)
//
// v0.3 gate:
//   - isOutsideSpotterProject: cwd has no .spotter/marker.json above it → exit 0
//     (Throughline workdir etc. — `claude -p` from tools outside any installed project)
//
// v0.12.0: spawn + readiness-poll moved to spawn-daemon.mjs (shared with auto-resurrect
// in user-prompt.mjs). The --parent-pid scheme from v0.6.2 is gone; orphan cleanup is
// now heartbeat-based inside the daemon.

import {
  readStdinJson,
  requireString,
  die,
  isChildCall,
  isSubagentCall,
  isUnsupportedNonClaudeEnvelope,
  isOutsideSpotterProject,
  findSpotterMarker,
  recordClaudeHookEvent,
} from './lib.mjs';
import { spawnDaemonAndWaitReady, spawnRefreshDetached } from './spawn-daemon.mjs';

export async function runSessionStart({
  now = Date.now,
  readInput = readStdinJson,
  spawnDaemonAndWaitReadyFn = spawnDaemonAndWaitReady,
  spawnRefreshDetachedFn = spawnRefreshDetached,
  recordHookEventFn = recordClaudeHookEvent,
} = {}) {
  if (isChildCall()) return;

  const input = await readInput();

  if (isUnsupportedNonClaudeEnvelope(input)) return;
  if (isSubagentCall(input)) return;
  if (input.source !== 'startup') return;
  if (isOutsideSpotterProject(input)) return;

  const sessionId = requireString(input, 'session_id');
  const projectRoot = findSpotterMarker(input.cwd);
  if (!projectRoot) {
    die(`SessionStart: failed to locate project root from cwd=${input.cwd}`, 2);
  }

  const startedAt = Date.now();
  await spawnDaemonAndWaitReadyFn({ sessionId, projectRoot, now });
  spawnRefreshDetachedFn({ projectRoot });
  await recordHookEventFn({
    projectRoot,
    event: { hook: 'SessionStart', status: 'spawned', durationMs: Date.now() - startedAt },
  });
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  runSessionStart().catch((err) => die(err.message, err.exitCode ?? 2));
}
