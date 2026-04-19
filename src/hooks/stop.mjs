// Stop hook — send turn_end, return decision:"block" on miss (§12.3 transparent).
// `stop_hook_active: true` → daemon returns pass automatically (§7.5 max-1-loop).
// v0.2 gates: see src/hooks/session-start.mjs comment.

import {
  readStdinJson,
  requireString,
  exitCodeFor,
  die,
  formatTransparentBlockReason,
  isChildCall,
  isSubagentCall,
  isOutsideSpotterProject,
} from './lib.mjs';
import { getLastAssistantText } from './transcript-reader.mjs';
import { sendRequest } from '../daemon/transport.mjs';

const TIMEOUT_MS = 50_000;

export async function runStop() {
  if (isChildCall()) return;
  const input = await readStdinJson();
  if (isSubagentCall(input)) return;
  if (isOutsideSpotterProject(input)) return;

  const sessionId = requireString(input, 'session_id');
  const transcriptPath = requireString(input, 'transcript_path');
  const stopHookActive = input.stop_hook_active === true;

  // Extract only the visible assistant text (thinking and tool_use blocks excluded).
  // null when the transcript has no assistant text yet — pass a sentinel so the
  // daemon's schema (final_response: string) is still satisfied.
  const finalResponse = getLastAssistantText(transcriptPath) ?? '(no final response available)';

  let response;
  try {
    response = await sendRequest({
      sessionId,
      event: 'turn_end',
      payload: {
        final_response: finalResponse,
        stop_hook_active: stopHookActive,
      },
      timeoutMs: TIMEOUT_MS,
    });
  } catch (err) {
    die(`stop transport failure: ${err.code ?? '?'}: ${err.message}`, exitCodeFor(err));
    return;
  }

  if (response.ok !== true) {
    die(`daemon error on turn_end: ${response.error?.code ?? '?'}: ${response.error?.message ?? ''}`, 2);
    return;
  }

  const result = response.result;
  if (result.pass === true) {
    return; // no block
  }

  const reason = formatTransparentBlockReason(result.missing_tools);
  const output = { decision: 'block', reason };
  process.stdout.write(JSON.stringify(output));
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  runStop().catch((err) => die(err.message, err.exitCode ?? 2));
}
