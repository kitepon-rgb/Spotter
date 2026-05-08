// Phase D (hook parity, 2026-05-08): host-neutral hook-event JSONL log.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendHookEvent,
  appendHookEventSafe,
  hookEventsPath,
  summarizeHookEvents,
  HOOK_EVENT_SCHEMA,
  HOOK_EVENTS_SUMMARY_SCHEMA,
} from '../src/core/hook-event-log.mjs';

test('hookEventsPath: joins .spotter/hook-events.jsonl under projectRoot', () => {
  assert.equal(hookEventsPath('/repo'), join('/repo', '.spotter', 'hook-events.jsonl'));
});

test('hookEventsPath: throws on empty / missing projectRoot', () => {
  assert.throws(() => hookEventsPath(''), /projectRoot/);
  assert.throws(() => hookEventsPath(undefined), /projectRoot/);
});

test('appendHookEvent: writes a JSON line with schema, timestamp, and host', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-hookevt-write-'));
  try {
    await appendHookEvent({
      projectRoot: project,
      host: 'claude',
      event: { hook: 'Stop', status: 'queued', missingTools: ['mcp__caveat__caveat_search'], durationMs: 12 },
    });
    const raw = await readFile(hookEventsPath(project), 'utf8');
    const lines = raw.trim().split('\n');
    assert.equal(lines.length, 1);
    const event = JSON.parse(lines[0]);
    assert.equal(event.schema, HOOK_EVENT_SCHEMA);
    assert.equal(event.host, 'claude');
    assert.equal(event.hook, 'Stop');
    assert.equal(event.status, 'queued');
    assert.deepEqual(event.missingTools, ['mcp__caveat__caveat_search']);
    assert.equal(event.durationMs, 12);
    assert.match(event.timestamp, /^\d{4}-\d{2}-\d{2}T/); // ISO 8601
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('appendHookEvent: rejects unknown host values', async () => {
  await assert.rejects(
    () => appendHookEvent({ projectRoot: '/tmp', host: 'whatever', event: {} }),
    /host must be "claude" or "codex"/
  );
});

test('appendHookEvent: appends to an existing file, preserving previous lines', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-hookevt-append-'));
  try {
    await appendHookEvent({ projectRoot: project, host: 'claude', event: { hook: 'PreToolUse', status: 'recorded', toolName: 'a' } });
    await appendHookEvent({ projectRoot: project, host: 'codex', event: { hook: 'Stop', status: 'queued' } });
    const raw = await readFile(hookEventsPath(project), 'utf8');
    const lines = raw.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).host, 'claude');
    assert.equal(JSON.parse(lines[1]).host, 'codex');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('appendHookEventSafe: swallows write errors and reports via writeError', async () => {
  let captured = '';
  await appendHookEventSafe({
    projectRoot: '', // will throw inside appendHookEvent
    host: 'claude',
    event: {},
    writeError: (text) => { captured += text; },
  });
  assert.match(captured, /spotter hook-event log failed/);
});

test('summarizeHookEvents: empty / missing file returns exists=false', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-hookevt-empty-'));
  try {
    const summary = await summarizeHookEvents({ projectRoot: project });
    assert.equal(summary.schema, HOOK_EVENTS_SUMMARY_SCHEMA);
    assert.equal(summary.exists, false);
    assert.equal(summary.events, 0);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('summarizeHookEvents: counts byHost / byHook / byStatus / byBackend across hosts', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-hookevt-counts-'));
  try {
    await appendHookEvent({
      projectRoot: project, host: 'claude',
      event: { hook: 'Stop', status: 'queued', backend: 'haiku', durationMs: 10 },
    });
    await appendHookEvent({
      projectRoot: project, host: 'claude',
      event: { hook: 'UserPromptSubmit', status: 'success', backend: 'haiku', durationMs: 20 },
    });
    await appendHookEvent({
      projectRoot: project, host: 'codex',
      event: { hook: 'Stop', status: 'queued', backend: 'codex-cli', durationMs: 30 },
    });
    const summary = await summarizeHookEvents({ projectRoot: project });
    assert.equal(summary.exists, true);
    assert.equal(summary.events, 3);
    assert.deepEqual(summary.byHost, { claude: 2, codex: 1 });
    assert.deepEqual(summary.byHook, { Stop: 2, UserPromptSubmit: 1 });
    assert.deepEqual(summary.byStatus, { queued: 2, success: 1 });
    assert.deepEqual(summary.byBackend, { haiku: 2, 'codex-cli': 1 });
    assert.equal(summary.maxDurationMs, 30);
    assert.equal(summary.averageDurationMs, 20); // (10+20+30)/3
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('summarizeHookEvents: malformed JSON lines counted as parseErrors', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-hookevt-bad-'));
  try {
    await appendHookEvent({ projectRoot: project, host: 'claude', event: { hook: 'Stop', status: 'queued' } });
    await appendFile(hookEventsPath(project), 'NOT JSON\n', 'utf8');
    await appendHookEvent({ projectRoot: project, host: 'claude', event: { hook: 'Stop', status: 'pass' } });
    const summary = await summarizeHookEvents({ projectRoot: project });
    assert.equal(summary.events, 2);
    assert.equal(summary.parseErrors, 1);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('summarizeHookEvents: recent buffer caps at 5 entries (most recent kept)', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-hookevt-recent-'));
  try {
    for (let i = 0; i < 7; i += 1) {
      await appendHookEvent({
        projectRoot: project, host: 'claude',
        event: { hook: 'PreToolUse', status: 'recorded', toolName: `tool_${i}` },
      });
    }
    const summary = await summarizeHookEvents({ projectRoot: project });
    assert.equal(summary.events, 7);
    assert.equal(summary.recent.length, 5);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('appendHookEvent: creates .spotter/ directory when missing', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-hookevt-mkdir-'));
  try {
    await appendHookEvent({ projectRoot: project, host: 'claude', event: { hook: 'SessionStart', status: 'spawned' } });
    const dotSpotter = join(project, '.spotter');
    const st = await stat(dotSpotter);
    assert.ok(st.isDirectory());
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
