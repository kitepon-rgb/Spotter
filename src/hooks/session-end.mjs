// SessionEnd hook — best-effort shutdown notice. §14.1 exception: cleanup failures warn only.
// v0.2 gates: see src/hooks/session-start.mjs comment.
// Phase D (hook parity, 2026-05-08): records a `shutdown` / `error` event to the shared
// hook-event JSONL so diagnostics see session lifecycle endpoints alongside per-turn events.

import {
  readStdinJson,
  requireString,
  isChildCall,
  isSubagentCall,
  isOutsideSpotterProject,
  findSpotterMarker,
  recordClaudeHookEvent,
} from './lib.mjs';
import { sendRequest } from '../daemon/transport.mjs';

const TIMEOUT_MS = 2_000;

export async function runSessionEnd({
  readInput = readStdinJson,
  sendRequestFn = sendRequest,
  recordHookEventFn = recordClaudeHookEvent,
  writeError = (text) => process.stderr.write(text),
} = {}) {
  if (isChildCall()) return;
  const input = await readInput();
  if (isSubagentCall(input)) return;
  if (isOutsideSpotterProject(input)) return;

  const sessionId = requireString(input, 'session_id');
  const projectRoot = findSpotterMarker(input.cwd);
  const startedAt = Date.now();

  try {
    await sendRequestFn({
      sessionId,
      event: 'shutdown',
      timeoutMs: TIMEOUT_MS,
    });
    await recordHookEventFn({
      projectRoot,
      event: { hook: 'SessionEnd', status: 'shutdown', durationMs: Date.now() - startedAt },
    });
  } catch (err) {
    if (err?.code === 'E_UNREACHABLE') {
      await recordHookEventFn({
        projectRoot,
        event: { hook: 'SessionEnd', status: 'already-stopped', durationMs: Date.now() - startedAt },
      });
      return;
    }
    await recordHookEventFn({
      projectRoot,
      event: {
        hook: 'SessionEnd',
        status: 'error',
        code: err?.code ?? 'E_INTERNAL',
        durationMs: Date.now() - startedAt,
      },
    });
    // §14.1 exception — don't fail the Claude Code session just because cleanup failed.
    writeError(`spotter-hook: session-end shutdown warning: ${err.code ?? '?'}: ${err.message}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  runSessionEnd().catch((err) => {
    process.stderr.write(`spotter-hook: session-end unexpected error: ${err.message}\n`);
    process.exit(0); // still don't block session end (§14.1 exception)
  });
}
