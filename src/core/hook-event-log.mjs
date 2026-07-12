// Phase D (hook parity, 2026-05-08): host-neutral hook-event JSONL log.
//
// Codex side previously wrote `.spotter/codex-hook-events.jsonl` with schema
// `spotter.codex_hook_event.v1`. v1.4.8 unifies that into `.spotter/hook-events.jsonl`
// with schema `spotter.hook_event.v1` + a `host` field, and Claude hooks now write to
// the same file. Records every hook firing with skip / success / error / finding status
// so `spotter diagnostics logs` can surface hook-side observations the daemon log alone
// never sees (short-prompt skip, legacy pending discard diagnostics, hook-level transport errors).
//
// File path: `<projectRoot>/.spotter/hook-events.jsonl` (append-only, no rotation yet).
// Record schema (v1):
//   {
//     schema: "spotter.hook_event.v1",
//     timestamp: "<ISO 8601 UTC>",
//     host: "claude" | "codex",
//     hook: "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "Stop" | "SessionEnd",
//     status: <hook-specific string>,
//     backend?: "haiku" | "codex-cli" | "codex-sidecar" | null,
//     pass?: boolean | null,
//     missingTools?: string[],
//     code?: string | null,
//     reason?: string | null,
//     durationMs?: number,
//     backendDurationMs?: number | null,
//     usedToolCount?: number,
//     legacyPendingDiagnostic?: string | null,
//     toolName?: string | null
//   }

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const HOOK_EVENTS_FILE = 'hook-events.jsonl';
export const HOOK_EVENT_SCHEMA = 'spotter.hook_event.v1';
export const HOOK_EVENTS_SUMMARY_SCHEMA = 'spotter.hook_events_summary.v1';

export function hookEventsPath(projectRoot) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new TypeError('hookEventsPath: projectRoot must be a non-empty string');
  }
  return join(projectRoot, '.spotter', HOOK_EVENTS_FILE);
}

export async function appendHookEvent({ projectRoot, host, event } = {}) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new TypeError('appendHookEvent: projectRoot must be a non-empty string');
  }
  if (host !== 'claude' && host !== 'codex') {
    throw new TypeError(`appendHookEvent: host must be "claude" or "codex" (got ${String(host)})`);
  }
  if (!event || typeof event !== 'object') {
    throw new TypeError('appendHookEvent: event must be an object');
  }
  const value = {
    schema: HOOK_EVENT_SCHEMA,
    timestamp: new Date().toISOString(),
    host,
    ...event,
  };
  const path = hookEventsPath(projectRoot);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(value) + '\n', 'utf8');
}

// Best-effort wrapper used by hook handlers — hook event log failures should never
// fail the hook itself (the auditor judgment + pending queue are the user-facing
// surfaces; missing diagnostics is acceptable degradation).
export async function appendHookEventSafe({ projectRoot, host, event, writeError } = {}) {
  try {
    await appendHookEvent({ projectRoot, host, event });
  } catch (err) {
    if (typeof writeError === 'function') {
      writeError(`spotter hook-event log failed: ${err.message}\n`);
    }
  }
}

export async function summarizeHookEvents({ projectRoot, readFileFn = readFile } = {}) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new TypeError('summarizeHookEvents: projectRoot must be a non-empty string');
  }
  const summary = {
    schema: HOOK_EVENTS_SUMMARY_SCHEMA,
    projectRoot,
    logPath: hookEventsPath(projectRoot),
    exists: false,
    events: 0,
    parseErrors: 0,
    byHost: {},
    byHook: {},
    byStatus: {},
    byBackend: {},
    averageDurationMs: 0,
    maxDurationMs: 0,
    recent: [],
  };
  let totalDurationMs = 0;
  try {
    const raw = await readFileFn(summary.logPath, 'utf8');
    summary.exists = true;
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        summary.parseErrors += 1;
        continue;
      }
      summary.events += 1;
      bump(summary.byHost, event.host ?? 'unknown');
      bump(summary.byHook, event.hook ?? 'unknown');
      bump(summary.byStatus, event.status ?? 'unknown');
      if (event.backend) bump(summary.byBackend, event.backend);
      if (Number.isFinite(event.durationMs)) {
        totalDurationMs += event.durationMs;
        summary.maxDurationMs = Math.max(summary.maxDurationMs, event.durationMs);
      }
      summary.recent.push(compactHookEvent(event));
      if (summary.recent.length > 5) summary.recent.shift();
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  summary.averageDurationMs = summary.events > 0 ? Math.round(totalDurationMs / summary.events) : 0;
  return summary;
}

function compactHookEvent(event) {
  return {
    timestamp: event.timestamp ?? null,
    host: event.host ?? null,
    hook: event.hook ?? 'unknown',
    status: event.status ?? 'unknown',
    backend: event.backend ?? null,
    pass: typeof event.pass === 'boolean' ? event.pass : null,
    missingTools: Array.isArray(event.missingTools) ? event.missingTools : [],
    code: event.code ?? null,
    reason: event.reason ?? null,
    durationMs: Number.isFinite(event.durationMs) ? event.durationMs : null,
  };
}

function bump(counter, key) {
  counter[key] = (counter[key] ?? 0) + 1;
}
