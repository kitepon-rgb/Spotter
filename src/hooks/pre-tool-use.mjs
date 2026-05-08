// PreToolUse hook — record tool usage in daemon (lightweight, no Haiku call). §9.1 v0.1.
// v0.2 gates: see src/hooks/session-start.mjs comment.
// Phase D (hook parity, 2026-05-08): also writes a `recorded` / `error` event to the
// shared `<projectRoot>/.spotter/hook-events.jsonl` so diagnostics can see PreToolUse
// activity even though the daemon log records the same tool name from its side.

import {
  readStdinJson,
  requireString,
  exitCodeFor,
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
  dieFn = die,
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
      await recordHookEventFn({
        projectRoot,
        event: {
          hook: 'PreToolUse',
          status: 'error',
          toolName,
          code: response.error?.code ?? 'E_INTERNAL',
          durationMs: Date.now() - startedAt,
        },
      });
      dieFn(`daemon error on tool_used: ${response.error?.code ?? '?'}: ${response.error?.message ?? ''}`, 2);
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
    await recordHookEventFn({
      projectRoot,
      event: {
        hook: 'PreToolUse',
        status: 'error',
        toolName,
        code: err?.code ?? 'E_INTERNAL',
        durationMs: Date.now() - startedAt,
      },
    });
    dieFn(`pre-tool-use transport failure: ${err.code ?? '?'}: ${err.message}`, exitCodeFor(err));
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  runPreToolUse().catch((err) => die(err.message, err.exitCode ?? 2));
}
