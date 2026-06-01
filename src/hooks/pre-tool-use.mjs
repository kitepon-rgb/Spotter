// PreToolUse hook — record tool usage in daemon (lightweight, no Haiku call). §9.1 v0.1.
// v0.2 gates: see src/hooks/session-start.mjs comment.
// Phase D (hook parity, 2026-05-08): also writes a `recorded` / `error` event to the
// shared `<projectRoot>/.spotter/hook-events.jsonl` so diagnostics can see PreToolUse
// activity even though the daemon log records the same tool name from its side.

import {
  readStdinJson,
  requireString,
  die,
  isChildCall,
  isSubagentCall,
  isOutsideSpotterProject,
  findSpotterMarker,
  recordClaudeHookEvent,
} from './lib.mjs';
import { sendRequest } from '../daemon/transport.mjs';

const TIMEOUT_MS = 1_000;

export async function runPreToolUse({
  readInput = readStdinJson,
  sendRequestFn = sendRequest,
  recordHookEventFn = recordClaudeHookEvent,
} = {}) {
  if (isChildCall()) return;
  const input = await readInput();
  if (isSubagentCall(input)) return;
  if (isOutsideSpotterProject(input)) return;

  const sessionId = requireString(input, 'session_id');
  const toolName = requireString(input, 'tool_name');
  const projectRoot = findSpotterMarker(input.cwd);
  const startedAt = Date.now();

  try {
    const response = await sendRequestFn({
      sessionId,
      event: 'tool_used',
      payload: { tool_name: toolName },
      timeoutMs: TIMEOUT_MS,
    });
    if (response.ok !== true) {
      // Recording is best-effort telemetry, not an audit verdict. On a daemon-side error, allow
      // the tool (exit 0) — a PreToolUse exit 2 would DENY the tool, which must never happen
      // just because Spotter could not record it. The audit at user_input/turn_end still warns
      // loudly if the backend is down.
      await recordHookEventFn({
        projectRoot,
        event: {
          hook: 'PreToolUse',
          status: 'degraded',
          toolName,
          code: response.error?.code ?? 'E_INTERNAL',
          reason: 'daemon_error',
          durationMs: Date.now() - startedAt,
        },
      });
      return;
    }
    await recordHookEventFn({
      projectRoot,
      event: {
        hook: 'PreToolUse',
        status: 'recorded',
        toolName,
        durationMs: Date.now() - startedAt,
      },
    });
  } catch (err) {
    // Transport failure during best-effort recording: allow the tool (no exit 2 deny).
    await recordHookEventFn({
      projectRoot,
      event: {
        hook: 'PreToolUse',
        status: 'degraded',
        toolName,
        code: err?.code ?? 'E_INTERNAL',
        reason: 'transport',
        durationMs: Date.now() - startedAt,
      },
    });
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  runPreToolUse().catch((err) => die(err.message, err.exitCode ?? 2));
}
