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
// `decision:"block"` is no longer emitted from this hook. Backend / transport errors still
// exit with code 1 + stderr (silent fallback is forbidden — see lib.mjs).
// `stop_hook_active:true` is still observed: the daemon early-passes on it, so we just
// receive `pass:true` and return without writing pending context.
//
// v0.2 gates: see src/hooks/session-start.mjs comment.

import {
  readStdinJson,
  requireString,
  exitCodeFor,
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
  dieFn = die,
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
    await recordHookEventFn({
      projectRoot,
      event: {
        hook: 'Stop',
        status: 'error',
        code: err?.code ?? 'E_INTERNAL',
        durationMs: Date.now() - startedAt,
      },
    });
    dieFn(`stop transport failure: ${err.code ?? '?'}: ${err.message}`, exitCodeFor(err));
    return;
  }

  if (response.ok !== true) {
    await recordHookEventFn({
      projectRoot,
      event: {
        hook: 'Stop',
        status: 'error',
        code: response.error?.code ?? 'E_INTERNAL',
        durationMs: Date.now() - startedAt,
      },
    });
    dieFn(`daemon error on turn_end: ${response.error?.code ?? '?'}: ${response.error?.message ?? ''}`, 2);
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
    // Marker walk-up returns null only when isOutsideSpotterProject would have early-returned
    // above. Reaching here implies the marker disappeared mid-turn; treat as unexpected.
    dieFn(`stop: cannot queue pending context — no .spotter/marker.json above cwd=${input.cwd}`, 2);
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
