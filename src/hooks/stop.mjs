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
// failure); they are recorded as `degraded` and exit 0. The next UserPromptSubmit surfaces the
// loud `[Spotter からの警告]`. No verdict is produced on failure, so nothing is queued — this is
// still not a silent "all clear" (the surfacing just moves to the next turn — see lib.mjs).
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
  isChildCall,
  isSubagentCall,
  isOutsideSpotterProject,
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
} = {}) {
  if (isChildCall()) return;
  const input = await readInput();
  if (isSubagentCall(input)) return;
  if (isOutsideSpotterProject(input)) return;

  const sessionId = requireString(input, 'session_id');
  const transcriptPath = requireString(input, 'transcript_path');
  const stopHookActive = input.stop_hook_active === true;
  const projectRoot = findSpotterMarker(input.cwd);
  const startedAt = Date.now();

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
    // Spotter-side failure (daemon unreachable, etc.): record + exit 0. Do NOT force the model to
    // continue (a Stop exit 2 blocks stopping). The next UserPromptSubmit surfaces the loud
    // warning; no pending is written, so this is not a silent "all clear" — there was no verdict.
    await recordHookEventFn({
      projectRoot,
      event: {
        hook: 'Stop',
        status: 'degraded',
        code: err?.code ?? 'E_INTERNAL',
        reason: 'transport',
        durationMs: Date.now() - startedAt,
      },
    });
    return;
  }

  if (response.ok !== true) {
    // Auditor backend failed (e.g. codex login expired): record + exit 0. Forcing a continuation
    // (exit 2) on a Spotter-side failure is harmful; the loud warning is delivered by the next
    // UserPromptSubmit. No verdict was produced, so nothing is queued.
    await recordHookEventFn({
      projectRoot,
      event: {
        hook: 'Stop',
        status: 'degraded',
        code: response.error?.code ?? 'E_INTERNAL',
        reason: 'daemon_error',
        durationMs: Date.now() - startedAt,
      },
    });
    return;
  }

  const result = response.result;
  if (result.pass === true) {
    await recordHookEventFn({
      projectRoot,
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
  if (!projectRoot) {
    // TOCTOU: the marker disappeared between the isOutsideSpotterProject guard and now. We cannot
    // persist the finding (no project dir to write into), but a Stop exit 2 would force the model
    // to continue — the harmful pattern this hook avoids. Drop the unpersistable finding and exit
    // 0; the next UserPromptSubmit re-audits from a fresh marker walk.
    return;
  }
  const text = formatTransparentBlockReason(result.missing_tools);
  await appendPendingContextFn({ projectRoot, sessionId, text });
  await recordHookEventFn({
    projectRoot,
    event: {
      hook: 'Stop',
      status: 'queued',
      pass: false,
      missingTools: result.missing_tools.map((m) => m.name),
      durationMs: Date.now() - startedAt,
    },
  });
  // No stdout output — Stop hook just exits 0. Pending will surface on next UserPromptSubmit.
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  runStop().catch((err) => die(err.message, err.exitCode ?? 2));
}
