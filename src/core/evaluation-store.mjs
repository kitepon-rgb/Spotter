import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const EVALUATION_STORE_SCHEMA = 'spotter.evaluation_store.v1';
export const DEFAULT_EVALUATION_BUSY_TIMEOUT_MS = 1_000;
// daemonの無通信寿命と同じ30分を超えたopen観測は、保存行を変更せず、
// report上だけproposal itemをoutcome_missingとして扱う。
export const DEFAULT_OPEN_TURN_STALE_MS = 30 * 60 * 1_000;

const AUDIT_STATUSES = new Set(['success', 'error', 'skipped']);
const USAGE_STATUSES = new Set(['open', 'complete', 'incomplete']);
const ITEM_OUTCOMES = new Set(['open', 'adopted', 'not_adopted', 'outcome_missing']);

export function defaultEvaluationStorePath({ homeDir = homedir() } = {}) {
  return join(homeDir, '.spotter', 'evaluation.db');
}

/**
 * Opens the host-local, cross-project evaluation database.  Callers own the
 * returned handle and must close it after their bounded operation.
 */
export function createEvaluationStore({
  databasePath = defaultEvaluationStorePath(),
  busyTimeoutMs = DEFAULT_EVALUATION_BUSY_TIMEOUT_MS,
} = {}) {
  assertPositiveInteger(busyTimeoutMs, 'busyTimeoutMs');
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(databasePath);
  database.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=${busyTimeoutMs}; PRAGMA foreign_keys=ON;`);
  initialize(database);
  return new EvaluationStore(database);
}

export class EvaluationStore {
  constructor(database) {
    this.database = database;
  }

  close() {
    this.database.close();
  }

  /** Records one UserPromptSubmit observation and its projected proposal IDs. */
  recordTurn(input) {
    const turn = normalizeTurn(input);
    return this.#transaction(() => {
      const previous = this.database.prepare(`
        SELECT observation_id FROM evaluation_turns
        WHERE session_id = ? AND completed_at_ms IS NULL
        ORDER BY recorded_at_ms DESC LIMIT 1
      `).get(turn.sessionId);
      if (previous) this.#close(previous.observation_id, [], 'incomplete', turn.recordedAtMs);

      this.database.prepare(`
        INSERT INTO evaluation_turns (
          observation_id, recorded_at_ms, proposed_at_ms, completed_at_ms,
          project_path, host, session_id, audit_status, request_text,
          auditor_seen_context, observer_context_status, observer_snapshot_json,
          used_tool_ids, usage_status, backend, model, spotter_version
        ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 'open', ?, ?, ?)
      `).run(
        turn.observationId, turn.recordedAtMs, turn.proposedAtMs,
        turn.projectPath, turn.host, turn.sessionId, turn.auditStatus,
        turn.requestText, turn.auditorSeenContext, turn.observerContextStatus,
        turn.observerSnapshotJson, turn.backend, turn.model, turn.spotterVersion,
      );
      const insertItem = this.database.prepare(`
        INSERT INTO evaluation_items (observation_id, tool_id, outcome) VALUES (?, ?, 'open')
      `);
      for (const toolId of turn.proposedToolIds) insertItem.run(turn.observationId, toolId);
      return { observationId: turn.observationId, proposed: turn.proposedToolIds.length, previousClosed: Boolean(previous) };
    });
  }

  /** Adds canonical tool IDs observed before Stop. Duplicate calls remain one ID. */
  recordUsage({ observationId, toolIds }) {
    const id = requiredString(observationId, 'observationId');
    const additions = normalizeToolIds(toolIds, 'toolIds');
    return this.#transaction(() => {
      const row = this.database.prepare(`
        SELECT used_tool_ids FROM evaluation_turns WHERE observation_id = ? AND completed_at_ms IS NULL
      `).get(id);
      if (!row) return { recorded: false, reason: 'not_open' };
      const merged = unique([...parseToolIds(row.used_tool_ids), ...additions]);
      this.database.prepare('UPDATE evaluation_turns SET used_tool_ids = ? WHERE observation_id = ?')
        .run(JSON.stringify(merged), id);
      return { recorded: true, usedToolIds: merged };
    });
  }

  /** Marks an open turn as unable to provide complete usage evidence. */
  markUsageIncomplete({ observationId }) {
    const id = requiredString(observationId, 'observationId');
    return this.#transaction(() => {
      const result = this.database.prepare(`
        UPDATE evaluation_turns SET usage_status = 'incomplete'
        WHERE observation_id = ? AND completed_at_ms IS NULL
      `).run(id);
      return { changed: result.changes === 1 };
    });
  }

  /**
   * Finalizes a turn exactly once. Incomplete evidence never becomes
   * not_adopted: every proposal item is instead outcome_missing.
   */
  closeTurn({ observationId, usedToolIds = null, usageStatus = null, completedAtMs = Date.now() }) {
    const id = requiredString(observationId, 'observationId');
    if (usedToolIds !== null) normalizeToolIds(usedToolIds, 'usedToolIds');
    if (usageStatus !== null) assertMember(usageStatus, USAGE_STATUSES, 'usageStatus');
    assertTimestamp(completedAtMs, 'completedAtMs');
    return this.#transaction(() => {
      const row = this.database.prepare(`
        SELECT used_tool_ids, usage_status FROM evaluation_turns
        WHERE observation_id = ? AND completed_at_ms IS NULL
      `).get(id);
      if (!row) return { closed: false, reason: 'not_open' };
      const effectiveStatus = usageStatus ?? row.usage_status;
      return this.#close(id, usedToolIds ?? parseToolIds(row.used_tool_ids), effectiveStatus, completedAtMs);
    });
  }

  /** Closes every still-open observation in one session as outcome_missing. */
  closeOpenTurnsForSession({ sessionId, completedAtMs = Date.now() }) {
    const session = requiredString(sessionId, 'sessionId');
    assertTimestamp(completedAtMs, 'completedAtMs');
    return this.#transaction(() => {
      const rows = this.database.prepare(`
        SELECT observation_id FROM evaluation_turns WHERE session_id = ? AND completed_at_ms IS NULL
      `).all(session);
      for (const row of rows) this.#close(row.observation_id, [], 'incomplete', completedAtMs);
      return { closed: rows.length };
    });
  }

  summarize(filters = {}, {
    nowMs = Date.now(),
    openTurnStaleMs = DEFAULT_OPEN_TURN_STALE_MS,
  } = {}) {
    assertTimestamp(nowMs, 'nowMs');
    assertPositiveDuration(openTurnStaleMs, 'openTurnStaleMs');
    const turns = this.#selectTurns(filters, { nowMs, openTurnStaleMs });
    const aggregate = summarizeRows(turns);
    return {
      schema: EVALUATION_STORE_SCHEMA,
      totals: aggregate,
      byProject: groupSummary(turns, (row) => row.project_path),
      byHost: groupSummary(turns, (row) => row.host),
      byTool: toolGroupSummary(turns, filters.toolId),
    };
  }

  listCases({ outcome, ...filters } = {}) {
    if (outcome !== undefined) assertMember(outcome, ITEM_OUTCOMES, 'outcome');
    const clauses = [];
    const values = [];
    appendFilters(clauses, values, filters, 't');
    if (outcome !== undefined) { clauses.push('i.outcome = ?'); values.push(outcome); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.database.prepare(`
      SELECT t.*, i.tool_id, i.outcome
      FROM evaluation_items i JOIN evaluation_turns t USING (observation_id)
      ${where} ORDER BY t.recorded_at_ms DESC, i.tool_id ASC
    `).all(...values);
    return rows.map(caseRow);
  }

  getCase(observationId) {
    const id = requiredString(observationId, 'observationId');
    const turn = this.database.prepare('SELECT * FROM evaluation_turns WHERE observation_id = ?').get(id);
    if (!turn) return null;
    const items = this.database.prepare(`
      SELECT tool_id, outcome FROM evaluation_items WHERE observation_id = ? ORDER BY tool_id
    `).all(id);
    return turnCase(turn, items);
  }

  #close(observationId, usedToolIds, usageStatus, completedAtMs) {
    const used = unique(usedToolIds);
    const finalStatus = usageStatus === 'open' ? 'complete' : usageStatus;
    const result = this.database.prepare(`
      UPDATE evaluation_turns
      SET completed_at_ms = ?, used_tool_ids = ?, usage_status = ?
      WHERE observation_id = ? AND completed_at_ms IS NULL
    `).run(completedAtMs, JSON.stringify(used), finalStatus, observationId);
    if (result.changes !== 1) return { closed: false, reason: 'not_open' };
    if (finalStatus === 'incomplete') {
      this.database.prepare(`UPDATE evaluation_items SET outcome = 'outcome_missing' WHERE observation_id = ?`)
        .run(observationId);
    } else {
      const update = this.database.prepare(`
        UPDATE evaluation_items SET outcome = ? WHERE observation_id = ? AND tool_id = ?
      `);
      const tools = this.database.prepare('SELECT tool_id FROM evaluation_items WHERE observation_id = ?').all(observationId);
      const usedSet = new Set(used);
      for (const { tool_id: toolId } of tools) update.run(usedSet.has(toolId) ? 'adopted' : 'not_adopted', observationId, toolId);
    }
    return { closed: true, usageStatus: finalStatus };
  }

  #selectTurns(filters, { nowMs, openTurnStaleMs }) {
    const staleBeforeMs = nowMs - openTurnStaleMs;
    const clauses = ['(t.completed_at_ms IS NOT NULL OR t.recorded_at_ms <= ?)'];
    const filterValues = [staleBeforeMs];
    appendFilters(clauses, filterValues, filters, 't', { includeToolId: false });
    const toolId = filters?.toolId === undefined ? null : requiredString(filters.toolId, 'toolId');
    const join = toolId === null
      ? 'LEFT JOIN evaluation_items i USING (observation_id)'
      : 'LEFT JOIN evaluation_items i ON i.observation_id = t.observation_id AND i.tool_id = ?';
    const values = toolId === null ? filterValues : [toolId, ...filterValues];
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.database.prepare(`
      SELECT t.observation_id, t.project_path, t.host, t.audit_status, t.completed_at_ms,
             i.tool_id,
             CASE WHEN t.completed_at_ms IS NULL AND i.tool_id IS NOT NULL
               THEN 'outcome_missing' ELSE i.outcome END AS outcome
      FROM evaluation_turns t ${join}
      ${where}
    `).all(...values);
  }

  #transaction(operation) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }
}

function initialize(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS evaluation_turns (
      observation_id TEXT PRIMARY KEY,
      recorded_at_ms INTEGER NOT NULL,
      proposed_at_ms INTEGER NOT NULL,
      completed_at_ms INTEGER,
      project_path TEXT NOT NULL,
      host TEXT NOT NULL,
      session_id TEXT NOT NULL,
      audit_status TEXT NOT NULL CHECK (audit_status IN ('success', 'error', 'skipped')),
      request_text TEXT,
      auditor_seen_context TEXT,
      observer_context_status TEXT NOT NULL,
      observer_snapshot_json TEXT,
      used_tool_ids TEXT NOT NULL,
      usage_status TEXT NOT NULL CHECK (usage_status IN ('open', 'complete', 'incomplete')),
      backend TEXT,
      model TEXT,
      spotter_version TEXT
    );
    CREATE TABLE IF NOT EXISTS evaluation_items (
      observation_id TEXT NOT NULL REFERENCES evaluation_turns(observation_id) ON DELETE CASCADE,
      tool_id TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('open', 'adopted', 'not_adopted', 'outcome_missing')),
      PRIMARY KEY (observation_id, tool_id)
    );
    CREATE INDEX IF NOT EXISTS evaluation_turns_session_open_idx
      ON evaluation_turns(session_id, recorded_at_ms) WHERE completed_at_ms IS NULL;
    CREATE INDEX IF NOT EXISTS evaluation_turns_recorded_idx ON evaluation_turns(recorded_at_ms);
    CREATE INDEX IF NOT EXISTS evaluation_items_outcome_idx ON evaluation_items(outcome, tool_id);
  `);
}

function normalizeTurn(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('input must be an object');
  const auditStatus = input.auditStatus;
  assertMember(auditStatus, AUDIT_STATUSES, 'auditStatus');
  const proposedToolIds = normalizeToolIds(input.proposedToolIds ?? [], 'proposedToolIds');
  if (auditStatus !== 'success' && proposedToolIds.length > 0) {
    throw new TypeError('only successful audits may record proposedToolIds');
  }
  const hasProposal = proposedToolIds.length > 0;
  const recordedAtMs = input.recordedAtMs ?? Date.now();
  const proposedAtMs = input.proposedAtMs ?? recordedAtMs;
  assertTimestamp(recordedAtMs, 'recordedAtMs');
  assertTimestamp(proposedAtMs, 'proposedAtMs');
  return {
    observationId: requiredString(input.observationId, 'observationId'),
    recordedAtMs,
    proposedAtMs,
    projectPath: requiredString(input.projectPath, 'projectPath'),
    host: requiredString(input.host, 'host'),
    sessionId: requiredString(input.sessionId, 'sessionId'),
    auditStatus,
    requestText: hasProposal ? nullableString(input.requestText, 'requestText') : null,
    auditorSeenContext: hasProposal ? nullableString(input.auditorSeenContext, 'auditorSeenContext') : null,
    observerContextStatus: hasProposal ? requiredString(input.observerContextStatus ?? 'not_requested', 'observerContextStatus') : 'not_requested',
    observerSnapshotJson: hasProposal ? jsonValue(input.observerSnapshot, 'observerSnapshot') : null,
    backend: nullableString(input.backend, 'backend'),
    model: nullableString(input.model, 'model'),
    spotterVersion: nullableString(input.spotterVersion, 'spotterVersion'),
    proposedToolIds,
  };
}

function appendFilters(clauses, values, filters, alias, { includeToolId = true } = {}) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) throw new TypeError('filters must be an object');
  if (filters.projectPath !== undefined) { clauses.push(`${alias}.project_path = ?`); values.push(requiredString(filters.projectPath, 'projectPath')); }
  if (filters.host !== undefined) { clauses.push(`${alias}.host = ?`); values.push(requiredString(filters.host, 'host')); }
  if (filters.backend !== undefined) { clauses.push(`${alias}.backend = ?`); values.push(requiredString(filters.backend, 'backend')); }
  if (filters.model !== undefined) { clauses.push(`${alias}.model = ?`); values.push(requiredString(filters.model, 'model')); }
  if (filters.spotterVersion !== undefined) { clauses.push(`${alias}.spotter_version = ?`); values.push(requiredString(filters.spotterVersion, 'spotterVersion')); }
  if (filters.fromMs !== undefined) { assertTimestamp(filters.fromMs, 'fromMs'); clauses.push(`${alias}.recorded_at_ms >= ?`); values.push(filters.fromMs); }
  if (filters.toMs !== undefined) { assertTimestamp(filters.toMs, 'toMs'); clauses.push(`${alias}.recorded_at_ms <= ?`); values.push(filters.toMs); }
  if (includeToolId && filters.toolId !== undefined) { clauses.push('i.tool_id = ?'); values.push(requiredString(filters.toolId, 'toolId')); }
}

function summarizeRows(rows) {
  const turns = new Map();
  for (const row of rows) {
    if (!turns.has(row.observation_id)) turns.set(row.observation_id, { auditStatus: row.audit_status, items: [] });
    if (row.tool_id !== null) turns.get(row.observation_id).items.push(row);
  }
  let S = 0; let P = 0; let I = 0; let C = 0; let A = 0; let M = 0;
  for (const turn of turns.values()) {
    if (turn.auditStatus !== 'success') continue;
    S += 1;
    if (turn.items.length > 0) P += 1;
    for (const item of turn.items) {
      I += 1;
      if (item.outcome === 'adopted') { C += 1; A += 1; }
      else if (item.outcome === 'not_adopted') C += 1;
      else if (item.outcome === 'outcome_missing') M += 1;
    }
  }
  return { S, P, I, C, A, M, proposalRate: S === 0 ? null : P / S, toolAdoptionRate: C === 0 ? null : A / C };
}

function groupSummary(rows, keyOf) {
  const grouped = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return Object.fromEntries([...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => [key, summarizeRows(values)]));
}

function toolGroupSummary(rows, filteredToolId) {
  const observations = new Map();
  for (const row of rows) {
    if (!observations.has(row.observation_id)) observations.set(row.observation_id, []);
    observations.get(row.observation_id).push(row);
  }
  const toolIds = filteredToolId === undefined
    ? unique(rows.flatMap((row) => row.tool_id === null ? [] : [row.tool_id])).sort()
    : [requiredString(filteredToolId, 'toolId')];
  const result = {};
  for (const toolId of toolIds) {
    const toolRows = [];
    for (const observationRows of observations.values()) {
      const matching = observationRows.find((row) => row.tool_id === toolId);
      toolRows.push(matching ?? { ...observationRows[0], tool_id: null, outcome: null });
    }
    result[toolId] = summarizeRows(toolRows);
  }
  return result;
}

function turnCase(turn, items) {
  return {
    observationId: turn.observation_id,
    recordedAtMs: turn.recorded_at_ms,
    proposedAtMs: turn.proposed_at_ms,
    completedAtMs: turn.completed_at_ms,
    projectPath: turn.project_path,
    host: turn.host,
    sessionId: turn.session_id,
    auditStatus: turn.audit_status,
    requestText: turn.request_text,
    auditorSeenContext: turn.auditor_seen_context,
    observerContextStatus: turn.observer_context_status,
    observerSnapshot: parseJson(turn.observer_snapshot_json),
    proposedToolIds: items.map((item) => item.tool_id),
    usedToolIds: parseToolIds(turn.used_tool_ids),
    usageStatus: turn.usage_status,
    backend: turn.backend,
    model: turn.model,
    spotterVersion: turn.spotter_version,
    items: items.map((item) => ({ toolId: item.tool_id, outcome: item.outcome })),
  };
}

function caseRow(row) {
  return {
    observationId: row.observation_id,
    recordedAtMs: row.recorded_at_ms,
    projectPath: row.project_path,
    host: row.host,
    auditStatus: row.audit_status,
    toolId: row.tool_id,
    outcome: row.outcome,
    requestText: row.request_text,
    auditorSeenContext: row.auditor_seen_context,
    observerContextStatus: row.observer_context_status,
    observerSnapshot: parseJson(row.observer_snapshot_json),
    usedToolIds: parseToolIds(row.used_tool_ids),
    backend: row.backend,
    model: row.model,
  };
}

function normalizeToolIds(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  return unique(value.map((toolId) => requiredString(toolId, name)));
}

function unique(values) { return [...new Set(values)]; }

function parseToolIds(value) {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) throw new TypeError('stored used_tool_ids is invalid');
  return unique(parsed);
}

function parseJson(value) {
  if (value === null || value === undefined) return null;
  try { return JSON.parse(value); } catch { throw new TypeError('stored JSON is invalid'); }
}

function jsonValue(value, name) {
  if (value === undefined || value === null) return null;
  try { return JSON.stringify(value); } catch { throw new TypeError(`${name} must be JSON-serializable`); }
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function nullableString(value, name) {
  if (value === undefined || value === null) return null;
  return requiredString(value, name);
}

function assertMember(value, members, name) {
  if (!members.has(value)) throw new TypeError(`${name} is invalid`);
}

function assertTimestamp(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
}

function assertPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) throw new TypeError(`${name} must be an integer between 1 and 60000`);
}

function assertPositiveDuration(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
}
