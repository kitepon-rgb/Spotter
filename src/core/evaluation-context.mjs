import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import {
  DEFAULT_AUDITOR_CONTEXT_MAX_BUFFER,
  DEFAULT_AUDITOR_CONTEXT_TIMEOUT_MS,
  loadAuditorContext,
  readProjectAuditorContextConfig,
} from './auditor-context.mjs';

export const EVALUATION_CONTEXT_AVAILABLE = 'context_available';
export const EVALUATION_CONTEXT_UNAVAILABLE = 'context_unavailable';

/**
 * Reads the exact-session Throughline context used only as proposal-time
 * evaluation evidence. It must never become auditor input.
 */
export async function loadEvaluationContext({
  projectRoot,
  host,
  sessionId,
  transcriptPath,
  config,
  recordedAtMs = Date.now(),
  timeoutMs = DEFAULT_AUDITOR_CONTEXT_TIMEOUT_MS,
  maxBuffer = DEFAULT_AUDITOR_CONTEXT_MAX_BUFFER,
  execFileFn,
  realpathFn = realpath,
  readConfigFn = readProjectAuditorContextConfig,
  loadAuditorContextFn = loadAuditorContext,
} = {}) {
  if (!Number.isSafeInteger(recordedAtMs) || recordedAtMs < 0) {
    throw new TypeError('recordedAtMs must be a non-negative safe integer');
  }
  if (typeof projectRoot !== 'string' || projectRoot.length === 0 || !isAbsoluteProjectPath(projectRoot)) {
    throw new TypeError('projectRoot must be an absolute path');
  }
  if (host !== 'claude' && host !== 'codex') {
    throw new TypeError('host must be claude or codex');
  }
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new TypeError('sessionId must be a non-empty string');
  }
  if (host === 'codex' && sessionId === 'codex:') {
    throw new TypeError('sessionId must identify a thread');
  }
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0 || !isAbsoluteProjectPath(transcriptPath)) {
    throw new TypeError('transcriptPath must be an absolute path');
  }

  let canonicalProjectRoot;
  try {
    canonicalProjectRoot = await realpathFn(projectRoot);
  } catch {
    return unavailableResult(recordedAtMs, 'project_unavailable');
  }

  let effectiveConfig = config;
  if (effectiveConfig === undefined) {
    try {
      effectiveConfig = await readConfigFn(canonicalProjectRoot);
    } catch {
      return unavailableResult(recordedAtMs, 'config_unavailable');
    }
  }
  if (effectiveConfig?.mode !== 'throughline') {
    return unavailableResult(recordedAtMs, 'provider_disabled');
  }

  let snapshot;
  try {
    snapshot = await loadAuditorContextFn({
      config: effectiveConfig,
      host,
      sessionId,
      projectRoot: canonicalProjectRoot,
      transcriptPath,
      timeoutMs,
      maxBuffer,
      ...(execFileFn === undefined ? {} : { execFileFn }),
    });
  } catch {
    return unavailableResult(recordedAtMs, 'auditor_context_failed');
  }

  if (snapshot.status !== 'fresh') {
    return unavailableResult(recordedAtMs, `auditor_context_${snapshot.status}`);
  }
  return Object.freeze({
    status: EVALUATION_CONTEXT_AVAILABLE,
    recordedAtMs,
    snapshot,
  });
}

function unavailableResult(recordedAtMs, reason) {
  return Object.freeze({
    status: EVALUATION_CONTEXT_UNAVAILABLE,
    recordedAtMs,
    reason,
    snapshot: null,
  });
}

function isAbsoluteProjectPath(value) {
  return isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);
}
