// Stop hook — send turn_end to daemon. Phase B (hook parity, 2026-05-08): deferred delivery.
//
// Prior behavior (pre-v1.4.8): on `pass:false` returned `{decision:"block", reason:<text>}` so
// Claude Code re-asks Bell to regenerate the response. This worked but caused a UX defect —
// the regenerated reply (= the corrective answer) became the transcript's final message and
// the original "A" topic got lost in transcript review.
//
// Phase B behavior: on `pass:false` we instead append the same transparent block-reason text
// to `<projectRoot>/.spotter/pending/<sessionId>.json`. The next UserPromptSubmit drains the
// queue and folds the entries into `additionalContext`, so Bell receives the audit finding
// alongside the next user input. The original A reply stays as the turn's final message.
//
// `decision:"block"` is no longer emitted from this hook. Backend / transport errors do NOT
// force a continuation (a Stop exit 2 would block stopping = harmful noise on a Spotter-side
// failure); they are recorded as `degraded` and exit 0. Their loud `[Spotter からの警告]` is
// persisted in the same pending queue as findings, then delivered by the next
// UserPromptSubmit. A persistence failure is written to stderr but never turns Stop into exit 2.
// `stop_hook_active:true` is still observed: the daemon early-passes on it, so we just
// receive `pass:true` and return without writing pending context.
//
// v0.2 gates: see src/hooks/session-start.mjs comment.

import {
  readStdinJson,
  requireString,
  die,
  findSpotterMarker,
  formatTransparentBlockReason,
  formatSpotterWarning,
  isChildCall,
  isSubagentCall,
  recordClaudeHookEvent,
} from './lib.mjs';
import { getLastAssistantText } from './transcript-reader.mjs';
import { sendRequest } from '../daemon/transport.mjs';
import { appendPendingContext } from './pending-context.mjs';

const TIMEOUT_MS = 50_000;

export async function runStop({
  readInput = readStdinJson,
  sendRequestFn = sendRequest,
  appendPendingContextFn = appendPendingContext,
  getLastAssistantTextFn = getLastAssistantText,
  recordHookEventFn = recordClaudeHookEvent,
  writeError = (text) => process.stderr.write(text),
} = {}) {
  if (isChildCall()) return;
  const input = await readInput();
  if (isSubagentCall(input)) return;
  // Resolve the installed project once. Keeping this proven root lets the failure event remain
  // attributable even if the marker disappears while the daemon request is in flight.
  const projectRoot = findSpotterMarker(input.cwd);
  if (!projectRoot) return;

  const sessionId = requireString(input, 'session_id');
  const transcriptPath = requireString(input, 'transcript_path');
  const stopHookActive = input.stop_hook_active === true;
  const startedAt = Date.now();

  const reportError = (text) => {
    try {
      writeError(text);
    } catch {
      // Stop must remain non-blocking even when stderr itself is unavailable.
    }
  };

  const persistPending = async ({ text, kind }) => {
    let queued = false;
    let pendingWriteError = null;
    // Never redirect a pending entry into a different installed ancestor if the original marker
    // disappears while the daemon request is in flight.
    const currentProjectRoot = findSpotterMarker(input.cwd);
    if (currentProjectRoot !== projectRoot) {
      pendingWriteError = 'Spotter project marker no longer identifies the original project';
    } else {
      try {
        queued = await appendPendingContextFn({
          projectRoot,
          sessionId,
          text,
        }) === true;
        if (!queued) pendingWriteError = 'appendPendingContext returned false';
      } catch (err) {
        pendingWriteError = String(err?.message ?? err) || 'unknown pending context persistence error';
      }
    }
    if (!queued) {
      // Include the original warning/finding as well as the persistence failure. If the durable
      // channel is unavailable, stderr is the only remaining loud surface for this Stop event.
      reportError(`Spotter Stop ${kind} persistence failed: ${pendingWriteError}\n${text}\n`);
    }
    return { queued, pendingWriteError };
  };

  const recordFailure = async ({ code, message, reason }) => {
    const text = formatSpotterWarning({ code, message, stage: 'stop' });
    const { queued: warningQueued, pendingWriteError } = await persistPending({ text, kind: 'warning' });
    await recordHookEventFn({
      projectRoot,
      writeError: reportError,
      event: {
        hook: 'Stop',
        status: 'degraded',
        code: code ?? 'E_INTERNAL',
        reason,
        durationMs: Date.now() - startedAt,
        warningQueued,
        ...(!warningQueued ? { pendingWriteError } : {}),
      },
    });
  };

  // Extract only the visible assistant text (thinking and tool_use blocks excluded).
  // null when the transcript has no assistant text yet — pass a sentinel so the
  // daemon's schema (final_response: string) is still satisfied.
  const finalResponse = getLastAssistantTextFn(transcriptPath) ?? '(no final response available)';

  let response;
  try {
    response = await sendRequestFn({
      sessionId,
      event: 'turn_end',
      payload: {
        final_response: finalResponse,
        stop_hook_active: stopHookActive,
      },
      timeoutMs: TIMEOUT_MS,
    });
  } catch (err) {
    // Spotter-side failure (daemon unreachable, etc.): persist a loud warning and exit 0. Do NOT
    // force the model to continue: a Stop exit 2 blocks stopping.
    await recordFailure({
      code: err?.code ?? 'E_INTERNAL',
      message: err?.message ?? '',
      reason: 'transport',
    });
    return;
  }

  if (response.ok !== true) {
    // Auditor backend failed (e.g. codex login expired): queue its actionable warning and exit 0.
    // Forcing a continuation (exit 2) on a Spotter-side failure is harmful.
    await recordFailure({
      code: response.error?.code ?? 'E_INTERNAL',
      message: response.error?.message ?? '',
      reason: 'daemon_error',
    });
    return;
  }

  const result = response.result;
  if (result.pass === true) {
    await recordHookEventFn({
      projectRoot,
      writeError: reportError,
      event: {
        hook: 'Stop',
        status: 'pass',
        pass: true,
        reason: result.reason ?? null,
        durationMs: Date.now() - startedAt,
      },
    });
    return; // nothing to defer
  }

  // Phase B: queue the finding for the next UserPromptSubmit instead of returning
  // decision:"block". Using the same transparent block-reason wording keeps the user-facing
  // text identical to the prior block flow.
  const text = formatTransparentBlockReason(result.missing_tools);
  const { queued: findingQueued, pendingWriteError } = await persistPending({ text, kind: 'finding' });
  await recordHookEventFn({
    projectRoot,
    writeError: reportError,
    event: {
      hook: 'Stop',
      status: findingQueued ? 'queued' : 'degraded',
      pass: false,
      missingTools: result.missing_tools.map((m) => m.name),
      durationMs: Date.now() - startedAt,
      findingQueued,
      ...(!findingQueued ? { pendingWriteError } : {}),
    },
  });
  // No stdout output — Stop hook just exits 0. Pending will surface on next UserPromptSubmit.
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  runStop().catch((err) => die(err.message, err.exitCode ?? 2));
}
