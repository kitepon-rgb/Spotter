// UserPromptSubmit hook — send user_input to daemon, inject additionalContext (§12.2 transparent).
// v0.2 gates: see src/hooks/session-start.mjs comment.
//
// v0.12.0: auto-resurrect. If sendRequest fails with E_UNREACHABLE (daemon was
// heartbeat-killed for 30 min idle, crashed, or was never spawned because SessionStart
// fired in a context we skipped), we spawn a fresh daemon and retry once. This is the
// natural recovery point — the start of a new turn — so the user's prompt is still
// audited even after long pauses or daemon failures.
//
// Phase B (hook parity, 2026-05-08): deferred Stop delivery. Drain
// `<projectRoot>/.spotter/pending/<sessionId>.json` populated by the previous turn's Stop
// hook and merge those entries into the same additionalContext. Drain runs even on the
// short-prompt early-return path so pending context never gets stuck behind a "ok" / "thanks"
// reply.

import {
  readStdinJson,
  requireString,
  die,
  formatTransparentContext,
  formatSpotterWarning,
  isChildCall,
  isSubagentCall,
  isOutsideSpotterProject,
  findSpotterMarker,
  recordClaudeHookEvent,
} from './lib.mjs';
import { sendRequest, TransportError } from '../daemon/transport.mjs';
import { spawnDaemonAndWaitReady } from './spawn-daemon.mjs';
import { drainPendingContexts } from './pending-context.mjs';

const TIMEOUT_MS = 50_000;
const SHORT_PROMPT_MAX_CHARS = 10;

export async function runUserPrompt({
  readInput = readStdinJson,
  sendRequestFn = sendRequest,
  spawnDaemonAndWaitReadyFn = spawnDaemonAndWaitReady,
  drainPendingContextsFn = drainPendingContexts,
  recordHookEventFn = recordClaudeHookEvent,
  writeOutput = (text) => process.stdout.write(text),
} = {}) {
  if (isChildCall()) return;
  const input = await readInput();
  if (isSubagentCall(input)) return;
  if (isOutsideSpotterProject(input)) return;

  const sessionId = requireString(input, 'session_id');
  const prompt = requireString(input, 'prompt');
  const projectRoot = findSpotterMarker(input.cwd);
  const startedAt = Date.now();

  // Phase B: drain pending Spotter findings deferred from the previous turn's Stop hook.
  // We always attempt to drain — even on the short-prompt skip path — so pending text never
  // gets stuck behind a one-liner reply.
  const pendingContexts = projectRoot
    ? await drainPendingContextsFn({ projectRoot, sessionId })
    : [];

  // Loud degradation (§0 / §14.1): the audit could not run, but the user's prompt is valid.
  // Surface a visible [Spotter からの警告] (merged with any drained pending context) and exit 0
  // so the prompt reaches the host — never erase it with a blocking exit 2.
  const degrade = async ({ code, message, reason }) => {
    const contexts = pendingContexts.slice();
    contexts.push(formatSpotterWarning({ code, message }));
    emitAdditionalContext(writeOutput, contexts);
    await recordHookEventFn({
      projectRoot,
      event: {
        hook: 'UserPromptSubmit',
        status: 'degraded',
        code: code ?? 'E_INTERNAL',
        reason,
        pendingContextCount: pendingContexts.length,
        durationMs: Date.now() - startedAt,
      },
    });
  };

  if ([...prompt.trim()].length <= SHORT_PROMPT_MAX_CHARS) {
    if (pendingContexts.length > 0) {
      emitAdditionalContext(writeOutput, pendingContexts);
    }
    await recordHookEventFn({
      projectRoot,
      event: {
        hook: 'UserPromptSubmit',
        status: 'skipped',
        reason: 'short_prompt',
        pendingContextCount: pendingContexts.length,
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
          message: recoverErr?.message ?? '',
          reason: 'resurrect_failed',
        });
        return;
      }
    } else {
      await degrade({ code: err?.code ?? 'E_INTERNAL', message: err?.message ?? '', reason: 'transport' });
      return;
    }
  }

  if (response.ok !== true) {
    await degrade({
      code: response.error?.code ?? 'E_INTERNAL',
      message: response.error?.message ?? '',
      reason: 'daemon_error',
    });
    return;
  }

  const result = response.result;
  const contexts = pendingContexts.slice();
  if (result.pass !== true) {
    contexts.push(formatTransparentContext(result.missing_tools));
  }
  if (contexts.length > 0) {
    emitAdditionalContext(writeOutput, contexts);
  }

  await recordHookEventFn({
    projectRoot,
    event: {
      hook: 'UserPromptSubmit',
      status: 'success',
      pass: result.pass === true,
      missingTools: Array.isArray(result.missing_tools) ? result.missing_tools.map((m) => m.name) : [],
      pendingContextCount: pendingContexts.length,
      durationMs: Date.now() - startedAt,
    },
  });
}

function emitAdditionalContext(writeOutput, contexts) {
  const text = contexts.map((c) => String(c).trim()).filter(Boolean).join('\n\n');
  if (!text) return;
  const output = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: text,
    },
  };
  writeOutput(JSON.stringify(output));
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  runUserPrompt().catch((err) => die(err.message, err.exitCode ?? 2));
}
