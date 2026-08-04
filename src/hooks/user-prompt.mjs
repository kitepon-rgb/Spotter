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
import {
  loadAuditorContext,
  readProjectAuditorContextConfig,
} from '../core/auditor-context.mjs';
import { randomUUID } from 'node:crypto';
import { createEvaluationStore } from '../core/evaluation-store.mjs';
import { loadEvaluationObserverContext } from '../core/evaluation-context.mjs';
import { version } from '../version.mjs';

const TIMEOUT_MS = 50_000;

export async function runUserPrompt({
  readInput = readStdinJson,
  sendRequestFn = sendRequest,
  spawnDaemonAndWaitReadyFn = spawnDaemonAndWaitReady,
  discardLegacyPendingFn = discardLegacyPending,
  readAuditorContextConfigFn = readProjectAuditorContextConfig,
  loadAuditorContextFn = loadAuditorContext,
  recordHookEventFn = recordClaudeHookEvent,
  createEvaluationStoreFn = createEvaluationStore,
  loadEvaluationObserverContextFn = loadEvaluationObserverContext,
  randomUUIDFn = randomUUID,
  spotterVersion = version,
  now = Date.now,
  writeOutput = (text) => process.stdout.write(text),
  writeError = (text) => process.stderr.write(text),
} = {}) {
  if (isChildCall()) return;
  const input = await readInput();
  if (isSubagentCall(input)) return;
  if (isOutsideSpotterProject(input)) return;

  const sessionId = requireString(input, 'session_id');
  const prompt = requireString(input, 'prompt');
  const observationId = randomUUIDFn();
  const projectRoot = findSpotterMarker(input.cwd);
  const startedAt = Date.now();
  let contextDurationMs = null;
  let evaluationWriteFailed = false;

  const safelyRecordEvaluation = async ({ auditStatus, result = null, auditContext = null }) => {
    if (!projectRoot) return;
    try {
      const proposedToolIds = auditStatus === 'success' && result?.pass !== true
        ? projectToolIds(Array.isArray(result?.missing_tools) ? result.missing_tools.map((entry) => entry?.name) : [])
        : [];
      const proposalRecordedAtMs = proposedToolIds.length > 0 ? now() : null;
      const observer = proposedToolIds.length > 0
        ? await loadEvaluationObserverContextFn({
          projectRoot,
          host: 'claude',
          sessionId,
          config: auditContext?.config,
          recordedAtMs: proposalRecordedAtMs,
        })
        : { status: 'not_requested', snapshot: null };
      const store = createEvaluationStoreFn();
      try {
        store.recordTurn({
          observationId,
          ...(proposalRecordedAtMs === null ? {} : {
            recordedAtMs: proposalRecordedAtMs,
            proposedAtMs: proposalRecordedAtMs,
          }),
          projectPath: projectRoot,
          host: 'claude',
          sessionId,
          auditStatus,
          requestText: prompt,
          auditorSeenContext: auditContext?.turns ? JSON.stringify(auditContext.turns) : null,
          observerContextStatus: observer.status,
          observerSnapshot: observer.snapshot,
          proposedToolIds,
          backend: result?.evaluation_meta?.backend ?? null,
          model: result?.evaluation_meta?.model ?? null,
          spotterVersion,
        });
      } finally {
        store.close();
      }
    } catch {
      if (!evaluationWriteFailed) {
        evaluationWriteFailed = true;
        safeWriteError(writeError, 'spotter-hook: Spotter の評価記録に失敗しました。\n');
      }
    }
  };

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
        contextDurationMs,
        legacyPendingDiagnostic: legacyPending.diagnostic,
        durationMs: Date.now() - startedAt,
      },
    });
  };

  const sendDaemonPayload = async (payload) => {
    const send = () => sendRequestFn({
      sessionId,
      event: 'user_input',
      payload,
      timeoutMs: TIMEOUT_MS,
    });
    try {
      return await send();
    } catch (err) {
      if (!(err instanceof TransportError) || err.code !== 'E_UNREACHABLE') throw err;
      await spawnDaemonAndWaitReadyFn({ sessionId, projectRoot });
      return send();
    }
  };

  const syncUserInputWithoutAudit = async (contextStatus) => {
    try {
      const response = await sendDaemonPayload({
        user_input: prompt,
        observation_id: observationId,
        audit: false,
        context_status: contextStatus,
      });
      if (response.ok !== true) {
        await degrade({ code: response.error?.code ?? 'E_INTERNAL', reason: 'daemon_state_sync' });
        return false;
      }
      return true;
    } catch (err) {
      await degrade({ code: err?.code, reason: 'daemon_state_sync' });
      return false;
    }
  };

  let context;
  let auditorContextConfig;
  const contextStartedAt = Date.now();
  try {
    const config = await readAuditorContextConfigFn(projectRoot);
    auditorContextConfig = config;
    contextDurationMs = Date.now() - contextStartedAt;
    if (config.mode === 'disabled') {
      if (!await syncUserInputWithoutAudit('disabled')) {
        await safelyRecordEvaluation({ auditStatus: 'error' });
        return;
      }
      await safelyRecordEvaluation({ auditStatus: 'skipped' });
      await recordHookEventFn({
        projectRoot,
        event: {
          hook: 'UserPromptSubmit',
          status: 'skipped',
          reason: 'context_disabled',
          contextStatus: 'disabled',
          contextDurationMs,
          legacyPendingDiagnostic: legacyPending.diagnostic,
          durationMs: Date.now() - startedAt,
        },
      });
      return;
    }
    context = await loadAuditorContextFn({
      config,
      host: 'claude',
      sessionId,
      projectRoot,
      transcriptPath: requireString(input, 'transcript_path'),
    });
    contextDurationMs = Date.now() - contextStartedAt;
  } catch (err) {
    contextDurationMs = Date.now() - contextStartedAt;
    await degrade({ code: err?.code, reason: 'auditor_context' });
    await safelyRecordEvaluation({ auditStatus: 'error' });
    return;
  }

  if (context.status === 'unavailable' || context.status === 'schema_mismatch') {
    await degrade({
      code: context.status === 'unavailable'
        ? 'E_AUDITOR_CONTEXT_UNAVAILABLE'
        : 'E_AUDITOR_CONTEXT_SCHEMA',
      reason: 'auditor_context_status',
    });
    await safelyRecordEvaluation({ auditStatus: 'error' });
    return;
  }
  if (context.status !== 'fresh') {
    if (!await syncUserInputWithoutAudit(context.status)) {
      await safelyRecordEvaluation({ auditStatus: 'error' });
      return;
    }
    await safelyRecordEvaluation({ auditStatus: 'skipped' });
    await recordHookEventFn({
      projectRoot,
      event: {
        hook: 'UserPromptSubmit',
        status: 'skipped',
        reason: 'context_not_fresh',
        contextStatus: context.status,
        contextTurns: 0,
        contextChars: 0,
        contextDurationMs,
        legacyPendingDiagnostic: legacyPending.diagnostic,
        durationMs: Date.now() - startedAt,
      },
    });
    return;
  }

  let response;
  try {
    response = await sendDaemonPayload({
      user_input: prompt,
      observation_id: observationId,
      audit: true,
      context_status: 'fresh',
      recent_context: context.turns,
    });
  } catch (err) {
    await degrade({ code: err?.code ?? 'E_RESURRECT_FAILED', reason: 'transport_or_resurrect' });
    await safelyRecordEvaluation({ auditStatus: 'error' });
    return;
  }

  if (response.ok !== true) {
    await degrade({
      code: response.error?.code ?? 'E_INTERNAL',
      reason: 'daemon_error',
    });
    await safelyRecordEvaluation({ auditStatus: 'error' });
    return;
  }

  const result = response.result;
  const toolIds = projectToolIds(Array.isArray(result.missing_tools) ? result.missing_tools.map((entry) => entry?.name) : []);
  const advice = result.pass !== true
    ? projectParentAdvice(toolIds)
    : '';

  await safelyRecordEvaluation({
    auditStatus: 'success',
    result,
    auditContext: { config: auditorContextConfig, turns: context.turns },
  });
  if (advice) emitAdditionalContext(writeOutput, advice);

  await recordHookEventFn({
    projectRoot,
    event: {
      hook: 'UserPromptSubmit',
      status: 'success',
      pass: result.pass === true,
      missingTools: toolIds,
      contextStatus: 'fresh',
      contextTurns: context.stats.returnedTurns,
      contextChars: context.stats.chars,
      contextDurationMs,
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
