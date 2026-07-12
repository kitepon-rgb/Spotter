// Stop hook — send turn_end to daemon and emit only fixed system messages. It never blocks the
// host and never carries auditor findings or failures into a future UserPromptSubmit.

import {
  readStdinJson,
  requireString,
  die,
  findSpotterMarker,
  isChildCall,
  isSubagentCall,
  recordClaudeHookEvent,
} from './lib.mjs';
import { getLastAssistantText } from './transcript-reader.mjs';
import { sendRequest } from '../daemon/transport.mjs';
import { STOP_FINDING_SYSTEM_MESSAGE, projectBackendFailure, projectToolIds } from './parent-output-projector.mjs';

const TIMEOUT_MS = 50_000;

export async function runStop({
  readInput = readStdinJson,
  sendRequestFn = sendRequest,
  getLastAssistantTextFn = getLastAssistantText,
  recordHookEventFn = recordClaudeHookEvent,
  writeOutput = (text) => process.stdout.write(text),
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

  const recordFailure = async ({ code, reason }) => {
    const failure = projectBackendFailure(code);
    reportError(failure.stderr);
    writeOutput(JSON.stringify({ systemMessage: failure.systemMessage }));
    await recordHookEventFn({
      projectRoot,
      writeError: reportError,
      event: {
        hook: 'Stop',
        status: 'degraded',
        code: failure.code,
        reason,
        durationMs: Date.now() - startedAt,
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
    // Spotter-side failure is surfaced only through fixed diagnostics; a Stop exit 2 would block stopping.
    await recordFailure({
      code: err?.code ?? 'E_INTERNAL',
      reason: 'transport',
    });
    return;
  }

  if (response.ok !== true) {
    // Auditor backend failure is fixed-diagnostic only; forcing a continuation is harmful.
    await recordFailure({
      code: response.error?.code ?? 'E_INTERNAL',
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

  writeOutput(JSON.stringify({ systemMessage: STOP_FINDING_SYSTEM_MESSAGE }));
  await recordHookEventFn({
    projectRoot,
    writeError: reportError,
    event: {
      hook: 'Stop',
      status: 'finding',
      pass: false,
      missingTools: projectToolIds(Array.isArray(result.missing_tools) ? result.missing_tools.map((entry) => entry?.name) : []),
      durationMs: Date.now() - startedAt,
    },
  });
  // No continuation or pending delivery is requested.
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  runStop().catch((err) => die(err.message, err.exitCode ?? 2));
}
