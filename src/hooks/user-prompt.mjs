// UserPromptSubmit hook — send user_input to daemon, inject additionalContext (§12.2 transparent).
// v0.2 gates: see src/hooks/session-start.mjs comment.
//
// v0.12.0: auto-resurrect. If sendRequest fails with E_UNREACHABLE (daemon was
// heartbeat-killed for 30 min idle, crashed, or was never spawned because SessionStart
// fired in a context we skipped), we spawn a fresh daemon and retry once. This is the
// natural recovery point — the start of a new turn — so the user's prompt is still
// audited even after long pauses or daemon failures.

import {
  readStdinJson,
  requireString,
  exitCodeFor,
  die,
  formatTransparentContext,
  isChildCall,
  isSubagentCall,
  isOutsideSpotterProject,
  findSpotterMarker,
} from './lib.mjs';
import { sendRequest, TransportError } from '../daemon/transport.mjs';
import { spawnDaemonAndWaitReady } from './spawn-daemon.mjs';

const TIMEOUT_MS = 30_000;
const SHORT_PROMPT_MAX_CHARS = 10;

export async function runUserPrompt() {
  if (isChildCall()) return;
  const input = await readStdinJson();
  if (isSubagentCall(input)) return;
  if (isOutsideSpotterProject(input)) return;

  const sessionId = requireString(input, 'session_id');
  const prompt = requireString(input, 'prompt');

  if ([...prompt.trim()].length <= SHORT_PROMPT_MAX_CHARS) return;

  const sendUserInput = () =>
    sendRequest({
      sessionId,
      event: 'user_input',
      payload: { user_input: prompt },
      timeoutMs: TIMEOUT_MS,
    });

  let response;
  try {
    response = await sendUserInput();
  } catch (err) {
    if (err instanceof TransportError && err.code === 'E_UNREACHABLE') {
      // v0.12.0: daemon is gone (heartbeat shutdown, crash, missing). Resurrect and retry.
      const projectRoot = findSpotterMarker(input.cwd);
      if (!projectRoot) {
        die(`user-prompt: cannot resurrect daemon — no .spotter/marker.json above cwd=${input.cwd}`, 2);
        return;
      }
      try {
        await spawnDaemonAndWaitReady({ sessionId, projectRoot });
      } catch (spawnErr) {
        die(`user-prompt: daemon resurrect failed: ${spawnErr.message}`, spawnErr.exitCode ?? 2);
        return;
      }
      try {
        response = await sendUserInput();
      } catch (retryErr) {
        die(`user-prompt transport failure after resurrect: ${retryErr.code ?? '?'}: ${retryErr.message}`, exitCodeFor(retryErr));
        return;
      }
    } else {
      die(`user-prompt transport failure: ${err.code ?? '?'}: ${err.message}`, exitCodeFor(err));
      return;
    }
  }

  if (response.ok !== true) {
    die(`daemon error on user_input: ${response.error?.code ?? '?'}: ${response.error?.message ?? ''}`, 2);
    return;
  }

  const result = response.result;
  if (result.pass === true) {
    return;
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
