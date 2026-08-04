import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';

import {
  DEFAULT_AUDITOR_CONTEXT_MAX_BUFFER,
  DEFAULT_AUDITOR_CONTEXT_TIMEOUT_MS,
  readProjectAuditorContextConfig,
} from './auditor-context.mjs';

export const THROUGHLINE_OBSERVER_READ_SCHEMA = 'throughline.observer_read.v1';
export const EVALUATION_OBSERVER_CONTEXT_AVAILABLE = 'context_available';
export const EVALUATION_OBSERVER_CONTEXT_UNAVAILABLE = 'context_unavailable';
export const DEFAULT_EVALUATION_OBSERVER_LIMIT = 10;

const execFileAsync = promisify(execFile);
const UNAVAILABLE_STATUSES = new Set([
  'projection_pending',
  'ambiguous_parent',
  'resync_required',
  'error',
]);

/**
 * Reads one bounded, proposal-time Throughline observer snapshot.
 *
 * This is deliberately separate from auditor-context.mjs: the returned snapshot
 * is evaluation evidence and must never become auditor input.
 */
export async function loadEvaluationObserverContext({
  projectRoot,
  config,
  recordedAtMs = Date.now(),
  timeoutMs = DEFAULT_AUDITOR_CONTEXT_TIMEOUT_MS,
  maxBuffer = DEFAULT_AUDITOR_CONTEXT_MAX_BUFFER,
  execFileFn = execFileAsync,
  realpathFn = realpath,
  readConfigFn = readProjectAuditorContextConfig,
} = {}) {
  if (!Number.isSafeInteger(recordedAtMs) || recordedAtMs < 0) {
    throw new TypeError('recordedAtMs must be a non-negative safe integer');
  }
  if (typeof projectRoot !== 'string' || projectRoot.length === 0 || !isAbsoluteProjectPath(projectRoot)) {
    throw new TypeError('projectRoot must be an absolute path');
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
  if (!isDirectCommandConfig(effectiveConfig)) {
    return unavailableResult(recordedAtMs, 'config_unavailable');
  }

  let stdout;
  try {
    ({ stdout } = await execFileFn(effectiveConfig.command, [
      ...effectiveConfig.args,
      'observer-read',
      '--project', canonicalProjectRoot,
      '--limit', String(DEFAULT_EVALUATION_OBSERVER_LIMIT),
      '--json',
    ], {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer,
      windowsHide: true,
      shell: false,
    }));
  } catch {
    return unavailableResult(recordedAtMs, 'observer_read_failed');
  }

  let snapshot;
  try {
    snapshot = JSON.parse(stdout);
  } catch {
    return unavailableResult(recordedAtMs, 'observer_read_invalid');
  }

  if (UNAVAILABLE_STATUSES.has(snapshot?.status)) {
    return unavailableResult(recordedAtMs, `observer_${snapshot.status}`);
  }
  if (!isObserverSnapshot(snapshot)) {
    return unavailableResult(recordedAtMs, 'observer_read_invalid');
  }
  return Object.freeze({
    status: EVALUATION_OBSERVER_CONTEXT_AVAILABLE,
    recordedAtMs,
    snapshot: freezeSnapshot(snapshot),
  });
}

function unavailableResult(recordedAtMs, reason) {
  return Object.freeze({
    status: EVALUATION_OBSERVER_CONTEXT_UNAVAILABLE,
    recordedAtMs,
    reason,
    snapshot: null,
  });
}

function isDirectCommandConfig(config) {
  return config && config.mode === 'throughline' &&
    isAbsoluteProjectPath(config.command) &&
    !/\.(?:cmd|bat)$/i.test(config.command) &&
    Array.isArray(config.args) &&
    config.args.every((arg) => typeof arg === 'string' && arg.length > 0);
}

function isAbsoluteProjectPath(value) {
  return isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);
}

function isObserverSnapshot(value) {
  if (!isRecord(value) || value.schema !== THROUGHLINE_OBSERVER_READ_SCHEMA || value.status !== 'snapshot') return false;
  if (!Array.isArray(value.turns) || value.turns.length > DEFAULT_EVALUATION_OBSERVER_LIMIT) return false;
  if (typeof value.historyTruncated !== 'boolean' || !isNullableString(value.afterCursor) || !isNullableString(value.throughCursor)) return false;
  if (!isRecord(value.page) || typeof value.page.complete !== 'boolean' || !isNullableString(value.page.nextToken)) return false;
  return value.host === null
    ? value.thread_sha256 === null
    : (value.host === 'claude' || value.host === 'codex') && /^[a-f0-9]{64}$/.test(value.thread_sha256);
}

function freezeSnapshot(snapshot) {
  return Object.freeze({
    ...snapshot,
    turns: Object.freeze(snapshot.turns.map((turn) => Object.freeze({ ...turn }))),
    page: Object.freeze({ ...snapshot.page }),
  });
}

function isNullableString(value) {
  return value === null || typeof value === 'string';
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
