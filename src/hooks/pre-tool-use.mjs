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
  isUnsupportedNonClaudeEnvelope,
  isOutsideSpotterProject,
  findSpotterMarker,
  recordClaudeHookEvent,
} from './lib.mjs';
import { sendRequest } from '../daemon/transport.mjs';
import { canonicalizeToolId } from '../core/evaluation-tool-id.mjs';

const TIMEOUT_MS = 1_000;

export async function runPreToolUse({
  readInput = readStdinJson,
  sendRequestFn = sendRequest,
  recordHookEventFn = recordClaudeHookEvent,
  createEvaluationStoreFn = null,
  writeError = (text) => process.stderr.write(text),
} = {}) {
  if (isChildCall()) return;
  const input = await readInput();
  if (isUnsupportedNonClaudeEnvelope(input)) return;
  if (isSubagentCall(input)) return;
  if (isOutsideSpotterProject(input)) return;
  const evaluationStoreFactory = createEvaluationStoreFn
    ?? (await import('../core/evaluation-store.mjs')).createEvaluationStore;

  const sessionId = requireString(input, 'session_id');
  const toolName = requireString(input, 'tool_name');
  const canonical = canonicalizeToolId({ host: 'claude', toolName, toolInput: input.tool_input });
  const evaluationObserved = canonical.status === 'resolved' || isEvaluationTarget(toolName);
  const usageIncomplete = evaluationObserved && canonical.status !== 'resolved';
  const projectRoot = findSpotterMarker(input.cwd);
  const startedAt = Date.now();
  let evaluationInvalidated = false;
  const invalidateEvaluation = () => {
    if (!evaluationObserved || evaluationInvalidated) return;
    evaluationInvalidated = true;
    closeEvaluationAsIncomplete({ sessionId, createEvaluationStoreFn: evaluationStoreFactory, writeError });
  };

  try {
    const response = await sendRequestFn({
      sessionId,
      event: 'tool_used',
      payload: {
        tool_name: toolName,
        evaluation_observed: evaluationObserved,
        evaluation_tool_id: canonical.status === 'resolved' ? canonical.toolId : null,
        usage_incomplete: usageIncomplete,
      },
      timeoutMs: TIMEOUT_MS,
    });
    if (response.ok !== true) {
      // Recording is best-effort telemetry, not an audit verdict. On a daemon-side error, allow
      // the tool (exit 0) — a PreToolUse exit 2 would DENY the tool, which must never happen
      // just because Spotter could not record it. The audit at user_input/turn_end still warns
      // loudly if the backend is down.
      invalidateEvaluation();
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
    if (response.result?.evaluation_record_error === true) {
      safeWriteError(writeError, 'spotter-hook: Spotter の評価記録に失敗しました。\n');
      invalidateEvaluation();
      await recordHookEventFn({
        projectRoot,
        event: {
          hook: 'PreToolUse',
          status: 'degraded',
          toolName,
          code: 'E_EVALUATION_RECORD',
          reason: 'evaluation_record_error',
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
    invalidateEvaluation();
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

function closeEvaluationAsIncomplete({ sessionId, createEvaluationStoreFn, writeError }) {
  let store;
  try {
    store = createEvaluationStoreFn();
    store.closeOpenTurnsForSession({ sessionId });
  } catch {
    safeWriteError(writeError, 'spotter-hook: Spotter の評価記録を outcome_missing で確定できませんでした。\n');
  } finally {
    try { store?.close(); } catch {}
  }
}

function safeWriteError(writeError, text) {
  try { writeError(text); } catch {}
}

function isEvaluationTarget(toolName) {
  return toolName === 'Skill' || toolName === 'Agent' || toolName.startsWith('mcp__');
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  runPreToolUse().catch((err) => die(err.message, err.exitCode ?? 2));
}
