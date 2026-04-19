// UserPromptSubmit hook — send user_input to daemon, inject additionalContext (§12.2 transparent).
// v0.2 gates: see src/hooks/session-start.mjs comment.

import {
  readStdinJson,
  requireString,
  exitCodeFor,
  die,
  formatTransparentContext,
  isChildCall,
  isSubagentCall,
  isOutsideSpotterProject,
} from './lib.mjs';
import { sendRequest } from '../daemon/transport.mjs';

const TIMEOUT_MS = 30_000;

export async function runUserPrompt() {
  if (isChildCall()) return;
  const input = await readStdinJson();
  if (isSubagentCall(input)) return;
  if (isOutsideSpotterProject(input)) return;

  const sessionId = requireString(input, 'session_id');
  const prompt = requireString(input, 'prompt');

  let response;
  try {
    response = await sendRequest({
      sessionId,
      event: 'user_input',
      payload: { user_input: prompt },
      timeoutMs: TIMEOUT_MS,
    });
  } catch (err) {
    die(`user-prompt transport failure: ${err.code ?? '?'}: ${err.message}`, exitCodeFor(err));
    return;
  }

  if (response.ok !== true) {
    die(`daemon error on user_input: ${response.error?.code ?? '?'}: ${response.error?.message ?? ''}`, 2);
    return;
  }

  const result = response.result;
  if (result.pass === true) {
    return; // no additionalContext to inject
  }

  const additionalContext = formatTransparentContext(result.missing_tools);
  const output = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  };
  process.stdout.write(JSON.stringify(output));
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  runUserPrompt().catch((err) => die(err.message, err.exitCode ?? 2));
}
