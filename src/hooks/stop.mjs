// Stop hook — send turn_end, return decision:"block" on miss (§12.3 transparent).
// `stop_hook_active: true` → daemon returns pass automatically (§7.5 max-1-loop).
// v0.2 gates: see src/hooks/session-start.mjs comment.

import {
  readStdinJson,
  requireString,
  optionalString,
  exitCodeFor,
  die,
  formatTransparentBlockReason,
  isChildCall,
  isSubagentCall,
} from './lib.mjs';
import { sendRequest } from '../daemon/transport.mjs';

const TIMEOUT_MS = 15_000;

export async function runStop() {
  if (isChildCall()) return;
  const input = await readStdinJson();
  if (isSubagentCall(input)) return;

  const sessionId = requireString(input, 'session_id');
  const stopHookActive = input.stop_hook_active === true;
  // Claude Code passes the transcript path; the final response is read from there or provided inline.
  const finalResponse = optionalString(input, 'final_response') ?? '(no final response provided)';

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
