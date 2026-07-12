import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

export const THROUGHLINE_AUDITOR_CONTEXT_SCHEMA = 'throughline.auditor_context.v1';
export const DEFAULT_AUDITOR_CONTEXT_TIMEOUT_MS = 1_000;
export const DEFAULT_AUDITOR_CONTEXT_MAX_BUFFER = 64 * 1024;

const execFileAsync = promisify(execFile);
const SAFE_STATUSES = new Set([
  'fresh',
  'empty',
  'stale',
  'session_mismatch',
  'unavailable',
  'schema_mismatch',
]);

export async function readProjectAuditorContextConfig(projectRoot) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new TypeError('projectRoot must be a non-empty string');
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(join(projectRoot, '.spotter', 'marker.json'), 'utf8'));
  } catch (cause) {
    throw new AuditorContextProviderError('E_AUDITOR_CONTEXT_CONFIG', 'auditor context config could not be read', { cause });
  }
  const config = parsed?.auditorContext;
  if (config === undefined) return Object.freeze({ mode: 'disabled' });
  if (config?.mode === 'disabled') return Object.freeze({ mode: 'disabled' });
  if (config?.mode !== 'throughline') {
    throw new AuditorContextProviderError('E_AUDITOR_CONTEXT_CONFIG', 'auditor context mode is invalid');
  }
  if (!isAbsoluteCommand(config.command) || isShellWrapper(config.command)) {
    throw new AuditorContextProviderError('E_AUDITOR_CONTEXT_CONFIG', 'auditor context command must be a direct absolute executable');
  }
  if (!Array.isArray(config.args) || config.args.some((arg) => typeof arg !== 'string' || arg.length === 0)) {
    throw new AuditorContextProviderError('E_AUDITOR_CONTEXT_CONFIG', 'auditor context args must be a string array');
  }
  return Object.freeze({ mode: 'throughline', command: config.command, args: Object.freeze([...config.args]) });
}

export async function loadAuditorContext({
  config,
  host,
  sessionId,
  projectRoot,
  transcriptPath,
  recentTurns = 2,
  maxBodyChars = 600,
  maxTotalChars = 4000,
  timeoutMs = DEFAULT_AUDITOR_CONTEXT_TIMEOUT_MS,
  maxBuffer = DEFAULT_AUDITOR_CONTEXT_MAX_BUFFER,
  execFileFn = execFileAsync,
} = {}) {
  if (config?.mode === 'disabled') return disabledResult();
  if (config?.mode !== 'throughline') {
    throw new AuditorContextProviderError('E_AUDITOR_CONTEXT_CONFIG', 'auditor context provider is not configured');
  }
  for (const [name, value] of Object.entries({ sessionId, projectRoot, transcriptPath })) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new AuditorContextProviderError('E_AUDITOR_CONTEXT_INPUT', `${name} is required`);
    }
  }
  if (host !== 'claude' && host !== 'codex') {
    throw new AuditorContextProviderError('E_AUDITOR_CONTEXT_INPUT', 'host must be claude or codex');
  }

  const normalizedSessionId = host === 'codex' && !sessionId.startsWith('codex:')
    ? `codex:${sessionId}`
    : sessionId;
  const args = [
    ...config.args,
    'auditor-context',
    '--session', normalizedSessionId,
    '--project', projectRoot,
    '--host', host,
    '--transcript', transcriptPath,
    '--recent-turns', String(recentTurns),
    '--max-body-chars', String(maxBodyChars),
    '--max-total-chars', String(maxTotalChars),
    '--json',
  ];

  let stdout;
  try {
    ({ stdout } = await execFileFn(config.command, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer,
      windowsHide: true,
      shell: false,
    }));
  } catch (cause) {
    const code = cause?.killed || cause?.code === 'ETIMEDOUT'
      ? 'E_AUDITOR_CONTEXT_TIMEOUT'
      : cause?.code === 'ENOENT'
        ? 'E_AUDITOR_CONTEXT_UNAVAILABLE'
        : 'E_AUDITOR_CONTEXT_EXEC';
    throw new AuditorContextProviderError(code, 'auditor context provider failed', { cause });
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (cause) {
    throw new AuditorContextProviderError('E_AUDITOR_CONTEXT_SCHEMA', 'auditor context output is not valid JSON', { cause });
  }
  return validateAuditorContextResult(parsed);
}

export function validateAuditorContextResult(value) {
  if (!isRecord(value) || value.schema !== THROUGHLINE_AUDITOR_CONTEXT_SCHEMA || !SAFE_STATUSES.has(value.status)) {
    throw new AuditorContextProviderError('E_AUDITOR_CONTEXT_SCHEMA', 'auditor context output schema is invalid');
  }
  if (!Array.isArray(value.turns) || !isRecord(value.stats) || !isRecord(value.freshness)) {
    throw new AuditorContextProviderError('E_AUDITOR_CONTEXT_SCHEMA', 'auditor context output shape is invalid');
  }
  if (value.status !== 'fresh' && value.turns.length !== 0) {
    throw new AuditorContextProviderError('E_AUDITOR_CONTEXT_SCHEMA', 'non-fresh auditor context must not contain turns');
  }
  if (value.status === 'fresh' && value.turns.length === 0) {
    throw new AuditorContextProviderError('E_AUDITOR_CONTEXT_SCHEMA', 'fresh auditor context must contain a turn');
  }
  if (value.turns.length > 3) {
    throw new AuditorContextProviderError('E_AUDITOR_CONTEXT_SCHEMA', 'auditor context turn limit exceeded');
  }
  let chars = 0;
  const turns = value.turns.map((turn) => {
    if (!isRecord(turn) ||
      typeof turn.originSessionId !== 'string' || turn.originSessionId.length === 0 ||
      !Number.isInteger(turn.turnNumber) || turn.turnNumber < 0 ||
      typeof turn.user !== 'string' || typeof turn.assistant !== 'string' ||
      turn.user.length > 2400 || turn.assistant.length > 2400 ||
      !Number.isFinite(turn.createdAt)) {
      throw new AuditorContextProviderError('E_AUDITOR_CONTEXT_SCHEMA', 'auditor context turn is invalid');
    }
    chars += turn.user.length + turn.assistant.length;
    return Object.freeze({
      originSessionId: turn.originSessionId,
      turnNumber: turn.turnNumber,
      user: turn.user,
      assistant: turn.assistant,
      createdAt: turn.createdAt,
    });
  });
  if (!Number.isInteger(value.stats.requestedTurns) || value.stats.requestedTurns < 0 ||
    !Number.isInteger(value.stats.returnedTurns) || value.stats.returnedTurns < 0 ||
    typeof value.stats.chars !== 'number' || !Number.isFinite(value.stats.chars) || value.stats.chars < 0 ||
    chars > 4000 || value.stats.chars !== chars || value.stats.returnedTurns !== turns.length) {
    throw new AuditorContextProviderError('E_AUDITOR_CONTEXT_SCHEMA', 'auditor context bounds are invalid');
  }
  return Object.freeze({
    schema: value.schema,
    status: value.status,
    reason: typeof value.reason === 'string' ? value.reason : 'unknown',
    turns: Object.freeze(turns),
    stats: Object.freeze({
      requestedTurns: value.stats.requestedTurns,
      returnedTurns: value.stats.returnedTurns,
      chars: value.stats.chars,
      truncated: value.stats.truncated === true,
    }),
  });
}

export class AuditorContextProviderError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, { cause });
    this.name = 'AuditorContextProviderError';
    this.code = code;
  }
}

function disabledResult() {
  return Object.freeze({
    schema: THROUGHLINE_AUDITOR_CONTEXT_SCHEMA,
    status: 'disabled',
    reason: 'project_disabled',
    turns: Object.freeze([]),
    stats: Object.freeze({ requestedTurns: 0, returnedTurns: 0, chars: 0, truncated: false }),
  });
}

function isAbsoluteCommand(value) {
  return typeof value === 'string' && value.length > 0 &&
    (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value));
}

function isShellWrapper(value) {
  return /\.(?:cmd|bat)$/i.test(value);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
