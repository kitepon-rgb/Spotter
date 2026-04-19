// PreToolUse hook — record tool usage in daemon (lightweight, no Haiku call). §9.1 v0.1.
// v0.2 gates: see src/hooks/session-start.mjs comment.

import { readStdinJson, requireString, exitCodeFor, die, isChildCall, isSubagentCall, isOutsideSpotterProject } from './lib.mjs';
import { sendRequest } from '../daemon/transport.mjs';

const TIMEOUT_MS = 1_000;

export async function runPreToolUse() {
  if (isChildCall()) return;
  const input = await readStdinJson();
  if (isSubagentCall(input)) return;
  if (isOutsideSpotterProject(input)) return;

  const sessionId = requireString(input, 'session_id');
  const toolName = requireString(input, 'tool_name');

  try {
    const response = await sendRequest({
      sessionId,
      event: 'tool_used',
      payload: { tool_name: toolName },
      timeoutMs: TIMEOUT_MS,
    });
    if (response.ok !== true) {
      die(`daemon error on tool_used: ${response.error?.code ?? '?'}: ${response.error?.message ?? ''}`, 2);
    }
  } catch (err) {
    die(`pre-tool-use transport failure: ${err.code ?? '?'}: ${err.message}`, exitCodeFor(err));
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  runPreToolUse().catch((err) => die(err.message, err.exitCode ?? 2));
}
