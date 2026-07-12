// UserPromptSubmit hook — send user_input to daemon and project only validated tool IDs into
// fixed non-imperative additionalContext text.
// v0.2 gates: see src/hooks/session-start.mjs comment.
//
// v0.12.0: auto-resurrect. If sendRequest fails with E_UNREACHABLE (daemon was
// heartbeat-killed for 30 min idle, crashed, or was never spawned because SessionStart
// fired in a context we skipped), we spawn a fresh daemon and retry once. This is the
// natural recovery point — the start of a new turn — so the user's prompt is still
// audited even after long pauses or daemon failures.
//
// Legacy pending files are never read or delivered. The same-session path is best-effort
// removed before both short and normal prompt paths.

import {
  readStdinJson,
  requireString,
  die,
  isChildCall,
  isSubagentCall,
  isOutsideSpotterProject,
  findSpotterMarker,
  recordClaudeHookEvent,
} from './lib.mjs';
import { sendRequest, TransportError } from '../daemon/transport.mjs';
import { spawnDaemonAndWaitReady } from './spawn-daemon.mjs';
import { discardLegacyPending } from './pending-context.mjs';
import { projectBackendFailure, projectParentAdvice, projectToolIds } from './parent-output-projector.mjs';

const TIMEOUT_MS = 50_000;
const SHORT_PROMPT_MAX_CHARS = 10;

export async function runUserPrompt({
  readInput = readStdinJson,
  sendRequestFn = sendRequest,
  spawnDaemonAndWaitReadyFn = spawnDaemonAndWaitReady,
  discardLegacyPendingFn = discardLegacyPending,
  recordHookEventFn = recordClaudeHookEvent,
  writeOutput = (text) => process.stdout.write(text),
  writeError = (text) => process.stderr.write(text),
} = {}) {
  if (isChildCall()) return;
  const input = await readInput();
  if (isSubagentCall(input)) return;
  if (isOutsideSpotterProject(input)) return;

  const sessionId = requireString(input, 'session_id');
  const prompt = requireString(input, 'prompt');
  const projectRoot = findSpotterMarker(input.cwd);
  const startedAt = Date.now();

  const legacyPending = projectRoot
    ? await discardLegacyPendingFn({ projectRoot, sessionId })
    : { discarded: false, diagnostic: 'legacy_pending_invalid_path' };

  const degrade = async ({ code, reason }) => {
    const failure = projectBackendFailure(code);
    emitSystemMessage(writeOutput, failure.systemMessage);
    safeWriteError(writeError, failure.stderr);
    await recordHookEventFn({
      projectRoot,
      event: {
        hook: 'UserPromptSubmit',
        status: 'degraded',
        code: failure.code,
        reason,
        legacyPendingDiagnostic: legacyPending.diagnostic,
        durationMs: Date.now() - startedAt,
      },
    });
  };

  if ([...prompt.trim()].length <= SHORT_PROMPT_MAX_CHARS) {
    await recordHookEventFn({
      projectRoot,
      event: {
        hook: 'UserPromptSubmit',
        status: 'skipped',
        reason: 'short_prompt',
        legacyPendingDiagnostic: legacyPending.diagnostic,
        durationMs: Date.now() - startedAt,
      },
    });
    return;
  }

  const sendUserInput = () =>
    sendRequestFn({
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
      // v0.12.0: daemon is gone (heartbeat shutdown, crash, missing). Resurrect and retry once.
      // projectRoot is guaranteed non-null here (isOutsideSpotterProject early-returned otherwise).
      try {
        await spawnDaemonAndWaitReadyFn({ sessionId, projectRoot });
        response = await sendUserInput();
      } catch (recoverErr) {
        await degrade({
          code: recoverErr?.code ?? 'E_RESURRECT_FAILED',
          reason: 'resurrect_failed',
        });
        return;
      }
    } else {
      await degrade({ code: err?.code, reason: 'transport' });
      return;
    }
  }

  if (response.ok !== true) {
    await degrade({
      code: response.error?.code ?? 'E_INTERNAL',
      reason: 'daemon_error',
    });
    return;
  }

  const result = response.result;
  const toolIds = projectToolIds(Array.isArray(result.missing_tools) ? result.missing_tools.map((entry) => entry?.name) : []);
  const advice = result.pass !== true
    ? projectParentAdvice(toolIds)
    : '';
  if (advice) emitAdditionalContext(writeOutput, advice);

  await recordHookEventFn({
    projectRoot,
    event: {
      hook: 'UserPromptSubmit',
      status: 'success',
      pass: result.pass === true,
      missingTools: toolIds,
      legacyPendingDiagnostic: legacyPending.diagnostic,
      durationMs: Date.now() - startedAt,
    },
  });
}

function emitAdditionalContext(writeOutput, text) {
  if (!text) return;
  const output = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: text,
    },
  };
  writeOutput(JSON.stringify(output));
}

function emitSystemMessage(writeOutput, systemMessage) {
  writeOutput(JSON.stringify({ systemMessage }));
}

function safeWriteError(writeError, text) {
  try {
    writeError(text);
  } catch {
    // A warning writer must not turn a valid user prompt into a blocking hook failure.
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  runUserPrompt().catch((err) => die(err.message, err.exitCode ?? 2));
}
