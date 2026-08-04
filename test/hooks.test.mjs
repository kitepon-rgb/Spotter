import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSessionStart } from '../src/hooks/session-start.mjs';
import { runSessionEnd } from '../src/hooks/session-end.mjs';
import { runUserPrompt as runUserPromptImpl } from '../src/hooks/user-prompt.mjs';
import { runStop } from '../src/hooks/stop.mjs';
import { runPreToolUse } from '../src/hooks/pre-tool-use.mjs';
import { TransportError } from '../src/daemon/transport.mjs';
import { discardLegacyPending, pendingPath } from '../src/hooks/pending-context.mjs';
import { projectBackendFailure, projectParentAdvice } from '../src/hooks/parent-output-projector.mjs';
import {
  isChildCall,
  isSubagentCall,
  findSpotterMarker,
  isOutsideSpotterProject,
} from '../src/hooks/lib.mjs';

const formatTransparentContext = (entries) => projectParentAdvice(entries.map((entry) => entry?.name));
const formatTransparentBlockReason = formatTransparentContext;
const formatSpotterWarning = ({ code }) => projectBackendFailure(code).systemMessage;
const TEST_EVALUATION_STORE = { recordTurn() {}, close() {} };
async function runUserPrompt(options = {}) {
  return runUserPromptImpl({
    createEvaluationStoreFn: () => TEST_EVALUATION_STORE,
    loadEvaluationObserverContextFn: async () => ({ status: 'context_unavailable', snapshot: null }),
    ...options,
  });
}
async function seedLegacyPending({ projectRoot, sessionId, content }) {
  const path = pendingPath({ projectRoot, sessionId });
  await mkdir(join(projectRoot, '.spotter', 'pending'), { recursive: true });
  await writeFile(path, content, 'utf8');
  return path;
}

test('formatTransparentContext: mentions Spotter explicitly (§12.2)', () => {
  const text = formatTransparentContext([
    { name: 'mcp__caveat__caveat_search', reason: '過去の罠を確認する必要がある' },
  ]);
  assert.match(text, /関連する可能性がある利用可能ツール/);
  assert.match(text, /mcp__caveat__caveat_search/);
  assert.doesNotMatch(text, /過去の罠を確認する必要がある|応答する前に/);
});

test('formatTransparentBlockReason: is the same non-imperative projected advice', () => {
  const text = formatTransparentBlockReason([
    { name: 'mcp__caveat__caveat_record', reason: '再利用すべき知見を記録する必要がある' },
  ]);
  assert.match(text, /mcp__caveat__caveat_record/);
  assert.doesNotMatch(text, /再利用すべき知見を記録する必要がある|補正してください|呼び出し/);
});

test('formatTransparentContext: handles multiple tools', () => {
  const text = formatTransparentContext([
    { name: 'a', reason: 'r1' },
    { name: 'b', reason: 'r2' },
  ]);
  assert.ok(text.includes('a'));
  assert.ok(text.includes('b'));
  assert.ok(!text.includes('r1'));
  assert.ok(!text.includes('r2'));
});

test('isChildCall: true when SPOTTER_PARENT_PID env is set', () => {
  const prevParent = process.env.SPOTTER_PARENT_PID;
  const prevBackend = process.env.SPOTTER_BACKEND;
  const prevChildBackend = process.env.SPOTTER_CHILD_BACKEND;
  try {
    delete process.env.SPOTTER_BACKEND;
    delete process.env.SPOTTER_CHILD_BACKEND;
    process.env.SPOTTER_PARENT_PID = '12345';
    assert.equal(isChildCall(), true);
    process.env.SPOTTER_PARENT_PID = '';
    assert.equal(isChildCall(), false);
    delete process.env.SPOTTER_PARENT_PID;
    assert.equal(isChildCall(), false);

    process.env.SPOTTER_BACKEND = 'codex-cli';
    assert.equal(isChildCall(), true);
    delete process.env.SPOTTER_BACKEND;
    assert.equal(isChildCall(), false);

    process.env.SPOTTER_CHILD_BACKEND = 'codex-sidecar';
    assert.equal(isChildCall(), true);
    process.env.SPOTTER_CHILD_BACKEND = '';
    assert.equal(isChildCall(), false);
  } finally {
    restoreEnv('SPOTTER_PARENT_PID', prevParent);
    restoreEnv('SPOTTER_BACKEND', prevBackend);
    restoreEnv('SPOTTER_CHILD_BACKEND', prevChildBackend);
  }
});

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

test('SessionEnd treats an unreachable daemon as idempotent already-stopped cleanup', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-session-end-'));
  const events = [];
  const errors = [];
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    await runSessionEnd({
      readInput: async () => ({ session_id: 'ended', cwd: project }),
      sendRequestFn: async () => { throw new TransportError('E_UNREACHABLE', 'daemon absent'); },
      recordHookEventFn: async ({ event }) => { events.push(event); },
      writeError: (text) => { errors.push(text); },
    });
    assert.equal(errors.length, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'already-stopped');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('SessionEnd still warns for cleanup failures other than an absent daemon', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-session-end-'));
  const events = [];
  const errors = [];
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    await runSessionEnd({
      readInput: async () => ({ session_id: 'ended', cwd: project }),
      sendRequestFn: async () => { throw Object.assign(new Error('broken'), { code: 'E_INTERNAL' }); },
      recordHookEventFn: async ({ event }) => { events.push(event); },
      writeError: (text) => { errors.push(text); },
    });
    assert.equal(events[0].status, 'error');
    assert.equal(events[0].code, 'E_INTERNAL');
    assert.match(errors[0], /E_INTERNAL: broken/);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('isSubagentCall: true when input.agent_id is a non-empty string', () => {
  assert.equal(isSubagentCall({ agent_id: 'abc' }), true);
  assert.equal(isSubagentCall({ agent_id: '' }), false);
  assert.equal(isSubagentCall({}), false);
  assert.equal(isSubagentCall(null), false);
  assert.equal(isSubagentCall(undefined), false);
  assert.equal(isSubagentCall({ agent_id: 42 }), false);
});

test('findSpotterMarker: returns the project root when marker exists at cwd', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-marker-'));
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    assert.equal(findSpotterMarker(project), project);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('findSpotterMarker: walks up from a nested cwd to find marker', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-marker-'));
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    const nested = join(project, 'src', 'deep', 'nested');
    await mkdir(nested, { recursive: true });
    assert.equal(findSpotterMarker(nested), project);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('findSpotterMarker: returns null when no marker exists above cwd', async () => {
  const isolated = await mkdtemp(join(tmpdir(), 'spotter-no-marker-'));
  try {
    assert.equal(findSpotterMarker(isolated), null);
  } finally {
    await rm(isolated, { recursive: true, force: true });
  }
});

test('findSpotterMarker: returns null for invalid input', () => {
  assert.equal(findSpotterMarker(''), null);
  assert.equal(findSpotterMarker(null), null);
  assert.equal(findSpotterMarker(undefined), null);
  assert.equal(findSpotterMarker(42), null);
});

test('isOutsideSpotterProject: true when cwd has no marker', async () => {
  const isolated = await mkdtemp(join(tmpdir(), 'spotter-outside-'));
  try {
    assert.equal(isOutsideSpotterProject({ cwd: isolated }), true);
  } finally {
    await rm(isolated, { recursive: true, force: true });
  }
});

test('isOutsideSpotterProject: false when cwd is an installed project', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-inside-'));
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    assert.equal(isOutsideSpotterProject({ cwd: project }), false);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('isOutsideSpotterProject: true when cwd is missing or non-string', () => {
  assert.equal(isOutsideSpotterProject({}), true);
  assert.equal(isOutsideSpotterProject({ cwd: '' }), true);
  assert.equal(isOutsideSpotterProject({ cwd: null }), true);
  assert.equal(isOutsideSpotterProject(null), true);
  assert.equal(isOutsideSpotterProject(undefined), true);
});

test('runSessionStart: SPOTTER_PARENT_PID exits before reading stdin or spawning', async () => {
  const prev = process.env.SPOTTER_PARENT_PID;
  let spawnCount = 0;
  try {
    process.env.SPOTTER_PARENT_PID = '12345';
    await runSessionStart({
      readInput: async () => {
        throw new Error('readInput should not be called for child calls');
      },
      spawnDaemonAndWaitReadyFn: async () => {
        spawnCount++;
      },
      spawnRefreshDetachedFn: () => {},
    });
    assert.equal(spawnCount, 0);
  } finally {
    if (prev === undefined) delete process.env.SPOTTER_PARENT_PID;
    else process.env.SPOTTER_PARENT_PID = prev;
  }
});

test('runSessionStart: agent_id gate exits without spawning daemon', async () => {
  let spawnCount = 0;
  await runSessionStart({
    readInput: async () => ({
      session_id: 's-agent',
      cwd: '/tmp',
      source: 'startup',
      agent_id: 'agent-1',
    }),
    spawnDaemonAndWaitReadyFn: async () => {
      spawnCount++;
    },
    spawnRefreshDetachedFn: () => {},
  });
  assert.equal(spawnCount, 0);
});

test('runSessionStart: non-startup source exits without spawning daemon', async () => {
  let spawnCount = 0;
  await runSessionStart({
    readInput: async () => ({
      session_id: 's-resume',
      cwd: '/tmp',
      source: 'resume',
    }),
    spawnDaemonAndWaitReadyFn: async () => {
      spawnCount++;
    },
    spawnRefreshDetachedFn: () => {},
  });
  assert.equal(spawnCount, 0);
});

test('runSessionStart: missing project marker exits without spawning daemon', async () => {
  const isolated = await mkdtemp(join(tmpdir(), 'spotter-session-start-outside-'));
  try {
    let spawnCount = 0;
    await runSessionStart({
      readInput: async () => ({
        session_id: 's-outside',
        cwd: isolated,
        source: 'startup',
      }),
      spawnDaemonAndWaitReadyFn: async () => {
        spawnCount++;
      },
      spawnRefreshDetachedFn: () => {},
    });
    assert.equal(spawnCount, 0);
  } finally {
    await rm(isolated, { recursive: true, force: true });
  }
});

test('runSessionStart: startup inside installed project spawns daemon and refresh', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-session-start-inside-'));
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    let spawnArgs = null;
    let refreshArgs = null;
    await runSessionStart({
      now: () => 123,
      readInput: async () => ({
        session_id: 's-startup',
        cwd: project,
        source: 'startup',
      }),
      spawnDaemonAndWaitReadyFn: async (args) => {
        spawnArgs = args;
      },
      spawnRefreshDetachedFn: (args) => {
        refreshArgs = args;
      },
    });
    assert.equal(spawnArgs.sessionId, 's-startup');
    assert.equal(spawnArgs.projectRoot, project);
    assert.equal(spawnArgs.now(), 123);
    assert.deepEqual(refreshArgs, { projectRoot: project });
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runUserPrompt: E_UNREACHABLE auto-resurrects daemon and retries once', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-user-prompt-resurrect-'));
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    let sendCount = 0;
    let spawnArgs = null;
    let output = '';
    await runUserPrompt({
      readInput: async () => ({
        session_id: 's-user',
        cwd: project,
        prompt: 'この外部仕様の罠を確認して記録してください',
        transcript_path: '/tmp/s-user.jsonl',
      }),
      sendRequestFn: async (request) => {
        sendCount++;
        assert.equal(request.sessionId, 's-user');
        assert.equal(request.event, 'user_input');
        const { observation_id: observationId, ...payload } = request.payload;
        assert.match(observationId, /^[a-f0-9-]{36}$/);
        assert.deepEqual(payload, {
          user_input: 'この外部仕様の罠を確認して記録してください',
          audit: true,
        });
        if (sendCount === 1) {
          throw new TransportError('E_UNREACHABLE', 'daemon missing');
        }
        return {
          ok: true,
          result: {
            pass: false,
            missing_tools: [
              { name: 'mcp__caveat__caveat_search', reason: '既知の罠を確認する必要がある' },
            ],
          },
        };
      },
      spawnDaemonAndWaitReadyFn: async (args) => {
        spawnArgs = args;
      },
      writeOutput: (text) => {
        output += text;
      },
      dieFn: (message, exitCode) => {
        throw new Error(`die ${exitCode}: ${message}`);
      },
    });

    assert.equal(sendCount, 2);
    assert.deepEqual(spawnArgs, { sessionId: 's-user', projectRoot: project });
    const parsed = JSON.parse(output);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.ok(parsed.hookSpecificOutput.additionalContext.includes('mcp__caveat__caveat_search'));
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runUserPrompt: audits the current prompt without reading auditor-context mode', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-user-prompt-short-'));
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    let sendCount = 0;
    await runUserPrompt({
      readInput: async () => ({
        session_id: 's-short',
        cwd: project,
        prompt: 'ありがとう',
      }),
      readAuditorContextConfigFn: async () => { throw new Error('auditor-context config must not be read'); },
      sendRequestFn: async () => {
        sendCount++;
        return { ok: true, result: { pass: true, missing_tools: [] } };
      },
      spawnDaemonAndWaitReadyFn: async () => {
        throw new Error('spawn should not be called while daemon is reachable');
      },
      writeOutput: () => {
        throw new Error('output should not be written for a passing audit');
      },
    });
    assert.equal(sendCount, 1);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runUserPrompt: audits even a ten-character prompt without loading or sending recent context', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-user-prompt-fresh-short-'));
  const requests = [];
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    await runUserPrompt({
      readInput: async () => ({ session_id: 's-fresh-short', cwd: project, prompt: '続けて確認して' }),
      loadAuditorContextFn: async () => { throw new Error('auditor context must not be loaded'); },
      sendRequestFn: async (request) => {
        requests.push(request);
        return { ok: true, result: { pass: true, missing_tools: [] } };
      },
    });
    assert.equal(requests.length, 1);
    const { observation_id: observationId, ...payload } = requests[0].payload;
    assert.match(observationId, /^[a-f0-9-]{36}$/);
    assert.deepEqual(payload, {
      user_input: '続けて確認して', audit: true,
    });
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runUserPrompt: auditor-context freshness cannot suppress the current prompt audit', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-user-prompt-not-fresh-'));
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    for (const status of ['empty', 'stale', 'session_mismatch']) {
      const requests = [];
      let output = '';
      const events = [];
      await runUserPrompt({
        readInput: async () => ({ session_id: `s-${status}`, cwd: project, prompt: '短文' }),
        loadAuditorContextFn: async () => { throw new Error(`${status} context must not be loaded`); },
        sendRequestFn: async (request) => { requests.push(request); return { ok: true, result: { pass: true, missing_tools: [] } }; },
        recordHookEventFn: async ({ event }) => { events.push(event); },
        writeOutput: (text) => { output += text; },
      });
      assert.equal(requests.length, 1, `${status} must still audit the current prompt`);
      const { observation_id: observationId, ...payload } = requests[0].payload;
      assert.match(observationId, /^[a-f0-9-]{36}$/);
      assert.deepEqual(payload, { user_input: '短文', audit: true });
      assert.equal(output, '');
      assert.equal(events[0].status, 'success');
    }
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runUserPrompt: auditor-context provider failure cannot suppress the current prompt audit', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-user-prompt-context-error-'));
  const sentinel = 'AUDITOR_CONTEXT_PROVIDER_RAW_SENTINEL';
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    let output = ''; let stderr = ''; const events = []; let sendCount = 0;
    await runUserPrompt({
      readInput: async () => ({ session_id: 's-context-error', cwd: project, prompt: '短文', transcript_path: '/tmp/context-error.jsonl' }),
      loadAuditorContextFn: async () => { const err = new Error(sentinel); err.code = 'E_AUDITOR_CONTEXT_UNAVAILABLE'; throw err; },
      sendRequestFn: async () => { sendCount += 1; return { ok: true, result: { pass: true, missing_tools: [] } }; },
      recordHookEventFn: async ({ event }) => { events.push(event); },
      writeOutput: (text) => { output += text; }, writeError: (text) => { stderr += text; },
    });
    assert.equal(sendCount, 1);
    assert.equal(output, '');
    assert.equal(stderr, '');
    assert.doesNotMatch(output + stderr + JSON.stringify(events), new RegExp(sentinel));
    assert.equal(events[0].status, 'success');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

// v1.4.19 migration: legacy pending files are deleted without reading or delivery.

test('pendingPath: sanitizes session id and joins under .spotter/pending/', () => {
  const path = pendingPath({ projectRoot: '/repo', sessionId: 'abc/123' });
  assert.ok(path.endsWith(join('.spotter', 'pending', 'abc123.json')), `got ${path}`);
});

test('pendingPath: returns null for empty / missing inputs', () => {
  assert.equal(pendingPath({}), null);
  assert.equal(pendingPath({ projectRoot: '/repo' }), null);
  assert.equal(pendingPath({ projectRoot: '/repo', sessionId: '' }), null);
  assert.equal(pendingPath({ projectRoot: '/repo', sessionId: '!!!' }), null);
  assert.equal(pendingPath({ projectRoot: '', sessionId: 'abc' }), null);
});

test('discardLegacyPending: deletes arbitrary legacy content without parsing it', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-pending-discard-'));
  try {
    const path = pendingPath({ projectRoot: project, sessionId: 's1' });
    await mkdir(join(project, '.spotter', 'pending'), { recursive: true });
    await writeFile(path, 'AI_SENTINEL:not-json', 'utf8');
    assert.deepEqual(await discardLegacyPending({ projectRoot: project, sessionId: 's1' }), { discarded: true, diagnostic: null });
    await assert.rejects(stat(path), (err) => err.code === 'ENOENT');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('discardLegacyPending: ENOENT is idempotent success', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-pending-missing-'));
  try {
    assert.deepEqual(await discardLegacyPending({ projectRoot: project, sessionId: 's1' }), { discarded: true, diagnostic: null });
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('discardLegacyPending: unlink failure returns only a fixed diagnostic', async () => {
  const sentinel = 'AI_SENTINEL:disk-secret';
  const result = await discardLegacyPending({
    projectRoot: '/repo',
    sessionId: 's1',
    unlinkFn: async () => { throw Object.assign(new Error(sentinel), { code: 'EACCES' }); },
  });
  assert.deepEqual(result, { discarded: false, diagnostic: 'legacy_pending_discard_failed' });
  assert.doesNotMatch(JSON.stringify(result), /AI_SENTINEL|disk-secret/);
});

test('runStop: pass:true returns without writing pending context or stdout', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-stop-pass-'));
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    let appendCalls = 0;
    await runStop({
      readInput: async () => ({
        session_id: 's-pass',
        cwd: project,
        transcript_path: '/tmp/transcript.jsonl',
      }),
      sendRequestFn: async () => ({ ok: true, result: { pass: true, missing_tools: [] } }),
      appendPendingContextFn: async () => { appendCalls += 1; return true; },
      getLastAssistantTextFn: () => 'final reply text',
    });
    assert.equal(appendCalls, 0);
    await assert.rejects(stat(pendingPath({ projectRoot: project, sessionId: 's-pass' })), (err) => err.code === 'ENOENT');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runStop: pass:false emits fixed notice and records only structured safe tool IDs', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-stop-defer-'));
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    const events = [];
    let output = '';
    await runStop({
      readInput: async () => ({
        session_id: 's-defer',
        cwd: project,
        transcript_path: '/tmp/transcript.jsonl',
      }),
      sendRequestFn: async () => ({
        ok: true,
        result: {
          pass: false,
          missing_tools: [{ name: 'mcp__caveat__caveat_search', reason: '既知の罠を確認する必要がある' }],
        },
      }),
      getLastAssistantTextFn: () => 'A について応答した',
      recordHookEventFn: async ({ event }) => { events.push(event); },
      writeOutput: (text) => { output += text; },
    });
    const path = pendingPath({ projectRoot: project, sessionId: 's-defer' });
    await assert.rejects(stat(path), (err) => err.code === 'ENOENT');
    assert.match(JSON.parse(output).systemMessage, /確認候補を記録/);
    assert.doesNotMatch(output, /既知の罠を確認する必要がある|mcp__caveat__caveat_search/);
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'finding');
    assert.deepEqual(events[0].missingTools, ['mcp__caveat__caveat_search']);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runStop: stop_hook_active=true is observed (daemon early-passes; no pending write)', async () => {
  // Phase B keeps the stop_hook_active observation route alive: the daemon early-passes when
  // stop_hook_active is true, the hook receives pass:true, and nothing is queued.
  const project = await mkdtemp(join(tmpdir(), 'spotter-stop-active-'));
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    let observedStopHookActive = null;
    await runStop({
      readInput: async () => ({
        session_id: 's-active',
        cwd: project,
        transcript_path: '/tmp/transcript.jsonl',
        stop_hook_active: true,
      }),
      sendRequestFn: async ({ payload }) => {
        observedStopHookActive = payload.stop_hook_active;
        return { ok: true, result: { pass: true, missing_tools: [], reason: 'stop_hook_active' } };
      },
      getLastAssistantTextFn: () => 'reply',
    });
    assert.equal(observedStopHookActive, true);
    await assert.rejects(stat(pendingPath({ projectRoot: project, sessionId: 's-active' })), (err) => err.code === 'ENOENT');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runStop: transport failure emits fixed diagnostics without later prompt delivery', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-stop-transport-'));
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    const events = [];
    let stopOutput = '';
    let stopError = '';
    await runStop({
      readInput: async () => ({
        session_id: 's-transport',
        cwd: project,
        transcript_path: '/tmp/transcript.jsonl',
      }),
      sendRequestFn: async () => {
        throw new TransportError('E_UNREACHABLE', 'daemon missing');
      },
      getLastAssistantTextFn: () => 'reply',
      recordHookEventFn: async ({ event }) => { events.push(event); },
      writeOutput: (text) => { stopOutput += text; },
      writeError: (text) => { stopError += text; },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'degraded');
    assert.equal(events[0].code, 'E_SPOTTER_AUDIT_GENERIC');
    assert.equal(events[0].reason, 'transport');
    assert.match(JSON.parse(stopOutput).systemMessage, /一時的な問題/);
    assert.match(stopError, /一時的な問題/);
    assert.doesNotMatch(stopOutput + stopError, /daemon missing|E_UNREACHABLE/);

    let output = '';
    await runUserPrompt({
      readInput: async () => ({
        session_id: 's-transport',
        cwd: project,
        prompt: '次のターンの長いユーザー入力',
      }),
      sendRequestFn: async () => ({ ok: true, result: { pass: true, missing_tools: [] } }),
      writeOutput: (text) => { output += text; },
    });
    assert.equal(output, '');
    await assert.rejects(stat(pendingPath({ projectRoot: project, sessionId: 's-transport' })), (err) => err.code === 'ENOENT');

    let nextOutput = '';
    await runUserPrompt({
      readInput: async () => ({
        session_id: 's-transport',
        cwd: project,
        prompt: 'さらに次の長いユーザー入力',
      }),
      sendRequestFn: async () => ({ ok: true, result: { pass: true, missing_tools: [] } }),
      writeOutput: (text) => { nextOutput += text; },
    });
    assert.equal(nextOutput, '');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runStop: daemon auth error emits fixed auth diagnostics without provider text', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-stop-daemon-error-'));
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    const events = [];
    let stopOutput = '';
    await runStop({
      readInput: async () => ({
        session_id: 's-daemon-err',
        cwd: project,
        transcript_path: '/tmp/transcript.jsonl',
      }),
      sendRequestFn: async () => ({
        ok: false,
        error: { code: 'E_CODEX_CLI_AUTH', message: 'codex login required' },
      }),
      getLastAssistantTextFn: () => 'reply',
      recordHookEventFn: async ({ event }) => { events.push(event); },
      writeOutput: (text) => { stopOutput += text; },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'degraded');
    assert.equal(events[0].code, 'E_SPOTTER_AUDIT_AUTH');
    assert.equal(events[0].reason, 'daemon_error');
    assert.match(JSON.parse(stopOutput).systemMessage, /認証状態/);
    assert.doesNotMatch(stopOutput, /codex login required|codex login/);

    let output = '';
    await runUserPrompt({
      readInput: async () => ({
        session_id: 's-daemon-err',
        cwd: project,
        prompt: '次のターンの長いユーザー入力',
      }),
      sendRequestFn: async () => ({ ok: true, result: { pass: true, missing_tools: [] } }),
      writeOutput: (text) => { output += text; },
    });
    assert.equal(output, '');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runStop: failure is not delivered on a later short prompt', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-stop-warning-short-'));
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    await runStop({
      readInput: async () => ({ session_id: 's-warning-short', cwd: project, transcript_path: '/tmp/t.jsonl' }),
      sendRequestFn: async () => { throw new TransportError('E_UNREACHABLE', 'daemon missing'); },
      getLastAssistantTextFn: () => 'reply',
    });
    let output = '';
    let sendCalls = 0;
    await runUserPrompt({
      readInput: async () => ({ session_id: 's-warning-short', cwd: project, prompt: 'ok' }),
      sendRequestFn: async () => { sendCalls += 1; return { ok: true, result: { pass: true } }; },
      writeOutput: (text) => { output += text; },
    });
    assert.equal(sendCalls, 1, 'the later prompt is audited without retained failure context');
    assert.equal(output, '');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runStop: previous failure is not merged with a later prompt recommendation', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-stop-warning-merge-'));
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    await runStop({
      readInput: async () => ({ session_id: 's-warning-merge', cwd: project, transcript_path: '/tmp/t.jsonl' }),
      sendRequestFn: async () => { throw new TransportError('E_UNREACHABLE', 'daemon missing'); },
      getLastAssistantTextFn: () => 'reply',
    });
    let output = '';
    await runUserPrompt({
      readInput: async () => ({ session_id: 's-warning-merge', cwd: project, prompt: '次のターンの長いユーザー入力', transcript_path: '/tmp/s-warning-merge.jsonl' }),
      sendRequestFn: async () => ({
        ok: true,
        result: { pass: false, missing_tools: [{ name: 'mcp__caveat__caveat_search', reason: '今ターンの推奨' }] },
      }),
      writeOutput: (text) => { output += text; },
    });
    const ctx = JSON.parse(output).hookSpecificOutput.additionalContext;
    assert.match(ctx, /mcp__caveat__caveat_search/);
    assert.doesNotMatch(ctx, /E_UNREACHABLE|daemon missing/);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runStop: each failure is immediate fixed output and nothing is retained', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-stop-warning-dedupe-'));
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    const outputs = [];
    const invoke = async (code, message) => runStop({
      readInput: async () => ({ session_id: 's-warning-dedupe', cwd: project, transcript_path: '/tmp/t.jsonl' }),
      sendRequestFn: async () => { throw new TransportError(code, message); },
      getLastAssistantTextFn: () => 'reply',
      writeOutput: (text) => { outputs.push(JSON.parse(text).systemMessage); },
      writeError: () => {},
    });
    await invoke('E_UNREACHABLE', 'daemon missing');
    await invoke('E_UNREACHABLE', 'daemon missing');
    await invoke('E_TIMEOUT', 'daemon timed out');
    assert.equal(outputs.length, 3);
    assert.equal(outputs.filter((text) => text.includes('一時的な問題')).length, 2);
    assert.equal(outputs.filter((text) => text.includes('時間内')).length, 1);
    await assert.rejects(stat(pendingPath({ projectRoot: project, sessionId: 's-warning-dedupe' })), (err) => err.code === 'ENOENT');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runStop: obsolete warning persistence callback is ignored', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-stop-warning-persist-fail-'));
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    for (const appendPendingContextFn of [
      async () => { throw new Error('disk full'); },
      async () => false,
    ]) {
      const events = [];
      let stderr = '';
      let output = '';
      await runStop({
        readInput: async () => ({ session_id: 's-warning-persist-fail', cwd: project, transcript_path: '/tmp/t.jsonl' }),
        sendRequestFn: async () => { throw new TransportError('E_UNREACHABLE', 'daemon missing'); },
        appendPendingContextFn,
        getLastAssistantTextFn: () => 'reply',
        recordHookEventFn: async ({ event }) => { events.push(event); },
        writeOutput: (text) => { output += text; },
        writeError: (text) => { stderr += text; },
      });
      assert.match(stderr, /一時的な問題/);
      assert.match(JSON.parse(output).systemMessage, /一時的な問題/);
      assert.equal(events.length, 1);
      assert.equal(events[0].status, 'degraded');
      assert.equal(events[0].code, 'E_SPOTTER_AUDIT_GENERIC');
      assert.equal(events[0].reason, 'transport');
      assert.doesNotMatch(stderr + output, /disk full|daemon missing|E_UNREACHABLE/);
    }
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runStop: marker removal during failure does not redirect or persist output', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-stop-warning-marker-race-'));
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    const marker = join(project, '.spotter', 'marker.json');
    await writeFile(marker, '{}', 'utf8');
    const events = [];
    let stderr = '';
    let output = '';
    await runStop({
      readInput: async () => ({ session_id: 's-warning-marker-race', cwd: project, transcript_path: '/tmp/t.jsonl' }),
      sendRequestFn: async () => {
        await rm(marker);
        throw new TransportError('E_UNREACHABLE', 'daemon missing');
      },
      appendPendingContextFn: async () => { throw new Error('must not append without a marker'); },
      getLastAssistantTextFn: () => 'reply',
      recordHookEventFn: async ({ event }) => { events.push(event); },
      writeOutput: (text) => { output += text; },
      writeError: (text) => { stderr += text; },
    });
    assert.match(stderr, /一時的な問題/);
    assert.match(JSON.parse(output).systemMessage, /一時的な問題/);
    assert.equal(events[0].code, 'E_SPOTTER_AUDIT_GENERIC');
    await assert.rejects(stat(pendingPath({ projectRoot: project, sessionId: 's-warning-marker-race' })), (err) => err.code === 'ENOENT');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runStop: obsolete finding persistence callback cannot affect structured output', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-stop-finding-persist-fail-'));
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    for (const appendPendingContextFn of [
      async () => { throw new Error('disk full'); },
      async () => false,
      async () => 'truthy-but-not-durable',
    ]) {
      const events = [];
      let stderr = '';
      let output = '';
      await runStop({
        readInput: async () => ({ session_id: 's-finding-persist-fail', cwd: project, transcript_path: '/tmp/t.jsonl' }),
        sendRequestFn: async () => ({
          ok: true,
          result: { pass: false, missing_tools: [{ name: 'mcp__required', reason: 'must be visible' }] },
        }),
        appendPendingContextFn,
        getLastAssistantTextFn: () => 'reply',
        recordHookEventFn: async ({ event }) => { events.push(event); },
        writeOutput: (text) => { output += text; },
        writeError: (text) => { stderr += text; },
      });
      assert.equal(stderr, '');
      assert.match(JSON.parse(output).systemMessage, /確認候補を記録/);
      assert.doesNotMatch(output, /must be visible|mcp__required/);
      assert.equal(events.length, 1);
      assert.equal(events[0].status, 'finding');
      assert.equal(events[0].pass, false);
      assert.deepEqual(events[0].missingTools, ['mcp__required']);
    }
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runStop: finding marker race stays non-blocking and does not persist context', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-stop-finding-marker-race-'));
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    const marker = join(project, '.spotter', 'marker.json');
    await writeFile(marker, '{}', 'utf8');
    const events = [];
    let stderr = '';
    let output = '';
    await runStop({
      readInput: async () => ({ session_id: 's-finding-marker-race', cwd: project, transcript_path: '/tmp/t.jsonl' }),
      sendRequestFn: async () => {
        await rm(marker);
        return { ok: true, result: { pass: false, missing_tools: [{ name: 'mcp__required', reason: 'must be visible' }] } };
      },
      appendPendingContextFn: async () => { throw new Error('must not append after marker loss'); },
      getLastAssistantTextFn: () => 'reply',
      recordHookEventFn: async ({ event }) => { events.push(event); },
      writeOutput: (text) => { output += text; },
      writeError: (text) => { stderr += text; },
    });
    assert.equal(stderr, '');
    assert.match(JSON.parse(output).systemMessage, /確認候補を記録/);
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'finding');
    assert.deepEqual(events[0].missingTools, ['mcp__required']);
    await assert.rejects(stat(pendingPath({ projectRoot: project, sessionId: 's-finding-marker-race' })), (err) => err.code === 'ENOENT');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runStop: stderr writer failure never turns a finding into a rejection', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-stop-stderr-fail-'));
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    const events = [];
    await runStop({
      readInput: async () => ({ session_id: 's-stderr-fail', cwd: project, transcript_path: '/tmp/t.jsonl' }),
      sendRequestFn: async () => ({ ok: true, result: { pass: false, missing_tools: [{ name: 'x', reason: 'y' }] } }),
      appendPendingContextFn: async () => false,
      getLastAssistantTextFn: () => 'reply',
      recordHookEventFn: async ({ event }) => { events.push(event); },
      writeError: () => { throw new Error('stderr closed'); },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'finding');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runUserPrompt: discards legacy pending and emits only current fixed advice', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-prompt-drain-merge-'));
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    const legacyPath = await seedLegacyPending({
      projectRoot: project,
      sessionId: 's-merge',
      content: 'AI_SENTINEL:前ターンの指摘テキスト',
    });
    let output = '';
    await runUserPrompt({
      readInput: async () => ({
        session_id: 's-merge',
        cwd: project,
        prompt: '次のターンの長いユーザー入力',
        transcript_path: '/tmp/s-merge.jsonl',
      }),
      sendRequestFn: async () => ({
        ok: true,
        result: {
          pass: false,
          missing_tools: [{ name: 'mcp__caveat__caveat_search', reason: '今ターンの推奨' }],
        },
      }),
      writeOutput: (text) => { output += text; },
      dieFn: (m, c) => { throw new Error(`die ${c}: ${m}`); },
    });
    const parsed = JSON.parse(output);
    const ctx = parsed.hookSpecificOutput.additionalContext;
    assert.doesNotMatch(ctx, /AI_SENTINEL|前ターンの指摘テキスト|今ターンの推奨/);
    assert.match(ctx, /\[Spotter からの参考情報\]/);
    assert.match(ctx, /mcp__caveat__caveat_search/);
    await assert.rejects(stat(legacyPath), (err) => err.code === 'ENOENT');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runUserPrompt: short prompt deletes legacy pending without emitting it', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-prompt-short-pending-'));
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    const legacyPath = await seedLegacyPending({
      projectRoot: project,
      sessionId: 's-short-p',
      content: 'AI_SENTINEL:保留中の指摘',
    });
    let output = '';
    let sendCalls = 0;
    await runUserPrompt({
      readInput: async () => ({
        session_id: 's-short-p',
        cwd: project,
        prompt: 'ok',
      }),
      sendRequestFn: async () => { sendCalls += 1; return { ok: true, result: { pass: true } }; },
      writeOutput: (text) => { output += text; },
    });
    assert.equal(sendCalls, 1, 'short prompts are audited without retained pending context');
    assert.equal(output, '');
    await assert.rejects(stat(legacyPath), (err) => err.code === 'ENOENT');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runUserPrompt: pass:true deletes legacy pending without additionalContext', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-prompt-drain-only-'));
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    const legacyPath = await seedLegacyPending({
      projectRoot: project,
      sessionId: 's-drain-only',
      content: 'AI_SENTINEL:前ターン保留',
    });
    let output = '';
    await runUserPrompt({
      readInput: async () => ({
        session_id: 's-drain-only',
        cwd: project,
        prompt: '次のターンの長いユーザー入力',
      }),
      sendRequestFn: async () => ({ ok: true, result: { pass: true, missing_tools: [] } }),
      writeOutput: (text) => { output += text; },
    });
    assert.equal(output, '');
    await assert.rejects(stat(legacyPath), (err) => err.code === 'ENOENT');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runUserPrompt: no pending and daemon pass:true emits no output (existing behavior)', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-prompt-noop-'));
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    let writeCount = 0;
    await runUserPrompt({
      readInput: async () => ({
        session_id: 's-noop',
        cwd: project,
        prompt: '長めのユーザー入力',
      }),
      sendRequestFn: async () => ({ ok: true, result: { pass: true, missing_tools: [] } }),
      writeOutput: () => { writeCount += 1; },
    });
    assert.equal(writeCount, 0);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

// v1.4.19: failures stay non-blocking but never become model-facing additionalContext.

test('formatSpotterWarning: auth failure is fixed and does not reflect provider detail', () => {
  const text = formatSpotterWarning({ code: 'E_CODEX_CLI_AUTH', message: 'ignored detail' });
  assert.match(text, /認証状態/);
  assert.doesNotMatch(text, /ignored detail|codex login/);
});

test('formatSpotterWarning: usage limit is fixed and non-imperative', () => {
  const prompt = formatSpotterWarning({ code: 'E_CODEX_CLI_USAGE_LIMIT' });
  assert.match(prompt, /利用上限/);
  const stop = formatSpotterWarning({ code: 'E_CODEX_CLI_USAGE_LIMIT', stage: 'stop' });
  assert.equal(stop, prompt);
  assert.doesNotMatch(stop, /伝えて|実行して|確認して/);
});

test('formatSpotterWarning: timeout hides the original code and message', () => {
  const text = formatSpotterWarning({ code: 'E_HAIKU_TIMEOUT', message: 'timed out' });
  assert.match(text, /時間内に完了しなかった/);
  assert.doesNotMatch(text, /E_HAIKU_TIMEOUT|timed out|codex login/);
});

test('formatSpotterWarning: unknown failure maps to one fixed generic message', () => {
  const first = formatSpotterWarning({ code: 'E_SECRET_ONE', message: 'secret one', stage: 'stop' });
  const second = formatSpotterWarning({ code: 'E_SECRET_TWO', message: 'secret two' });
  assert.equal(first, second);
  assert.doesNotMatch(first, /E_SECRET|secret/);
});

test('runUserPrompt: codex auth failure emits fixed systemMessage and does not erase the prompt', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-prompt-auth-'));
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    let output = '';
    let stderr = '';
    const events = [];
    await runUserPrompt({
      readInput: async () => ({
        session_id: 's-auth',
        cwd: project,
        prompt: '長めのユーザー入力をここに置く',
        transcript_path: '/tmp/s-auth.jsonl',
      }),
      sendRequestFn: async () => ({
        ok: false,
        error: { code: 'E_CODEX_CLI_AUTH', message: 'codex login required' },
      }),
      writeOutput: (text) => { output += text; },
      writeError: (text) => { stderr += text; },
      recordHookEventFn: async ({ event }) => { events.push(event); },
    });
    const parsed = JSON.parse(output);
    assert.match(parsed.systemMessage, /認証状態/);
    assert.match(stderr, /認証状態/);
    assert.equal(parsed.hookSpecificOutput, undefined);
    assert.doesNotMatch(output + stderr, /codex login required|codex login/);
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'degraded');
    assert.equal(events[0].code, 'E_SPOTTER_AUDIT_AUTH');
    assert.equal(events[0].reason, 'daemon_error');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runUserPrompt: generic daemon error emits fixed generic systemMessage', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-prompt-generic-err-'));
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    let output = '';
    await runUserPrompt({
      readInput: async () => ({
        session_id: 's-generic',
        cwd: project,
        prompt: '長めのユーザー入力をここに置く',
        transcript_path: '/tmp/s-generic.jsonl',
      }),
      sendRequestFn: async () => ({ ok: false, error: { code: 'E_INTERNAL', message: 'boom' } }),
      writeOutput: (text) => { output += text; },
    });
    const parsed = JSON.parse(output);
    assert.match(parsed.systemMessage, /一時的な問題/);
    assert.equal(parsed.hookSpecificOutput, undefined);
    assert.doesNotMatch(output, /E_INTERNAL|boom|codex login/);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runUserPrompt: daemon error discards legacy pending and never merges it into diagnostics', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-prompt-degrade-merge-'));
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    const legacyPath = await seedLegacyPending({
      projectRoot: project,
      sessionId: 's-degrade-merge',
      content: 'AI_SENTINEL:前ターンの指摘テキスト',
    });
    let output = '';
    await runUserPrompt({
      readInput: async () => ({
        session_id: 's-degrade-merge',
        cwd: project,
        prompt: '次のターンの長いユーザー入力',
        transcript_path: '/tmp/s-degrade-merge.jsonl',
      }),
      sendRequestFn: async () => ({
        ok: false,
        error: { code: 'E_CODEX_CLI_AUTH', message: 'codex login required' },
      }),
      writeOutput: (text) => { output += text; },
    });
    const parsed = JSON.parse(output);
    assert.match(parsed.systemMessage, /認証状態/);
    assert.doesNotMatch(output, /AI_SENTINEL|前ターンの指摘テキスト|codex login required/);
    await assert.rejects(stat(legacyPath), (err) => err.code === 'ENOENT');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runUserPrompt: resurrect failure degrades loudly instead of erasing the prompt', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-prompt-resurrect-fail-'));
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    let output = '';
    const events = [];
    await runUserPrompt({
      readInput: async () => ({
        session_id: 's-resurrect-fail',
        cwd: project,
        prompt: '長めのユーザー入力をここに置く',
        transcript_path: '/tmp/s-resurrect-fail.jsonl',
      }),
      sendRequestFn: async () => { throw new TransportError('E_UNREACHABLE', 'daemon missing'); },
      spawnDaemonAndWaitReadyFn: async () => { throw new Error('spawn failed'); },
      writeOutput: (text) => { output += text; },
      recordHookEventFn: async ({ event }) => { events.push(event); },
    });
    assert.match(JSON.parse(output).systemMessage, /一時的な問題/);
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'degraded');
    assert.equal(events[0].reason, 'transport_or_resurrect');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runUserPrompt: resurrect throwing a non-Error value still degrades (no TypeError → exit 2)', async () => {
  // Regression: degrade() must not access `.message` on a thrown null/undefined. Otherwise the
  // TypeError escapes to the top-level catch → die(exit 2) → erases the prompt — the exact bug.
  const project = await mkdtemp(join(tmpdir(), 'spotter-prompt-nonerror-throw-'));
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    let output = '';
    await runUserPrompt({
      readInput: async () => ({
        session_id: 's-nonerror',
        cwd: project,
        prompt: '長めのユーザー入力をここに置く',
        transcript_path: '/tmp/s-nonerror.jsonl',
      }),
      sendRequestFn: async () => { throw new TransportError('E_UNREACHABLE', 'daemon missing'); },
      spawnDaemonAndWaitReadyFn: async () => { throw null; }, // non-Error rejection
      writeOutput: (text) => { output += text; },
    });
    assert.match(JSON.parse(output).systemMessage, /一時的な問題/);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runPreToolUse: daemon error records degraded and allows the tool (no exit-2 deny)', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-pretool-degrade-'));
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    const events = [];
    await runPreToolUse({
      readInput: async () => ({
        session_id: 's-pretool',
        cwd: project,
        tool_name: 'Bash',
      }),
      sendRequestFn: async () => ({ ok: false, error: { code: 'E_INTERNAL', message: 'boom' } }),
      recordHookEventFn: async ({ event }) => { events.push(event); },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'degraded');
    assert.equal(events[0].toolName, 'Bash');
    assert.equal(events[0].reason, 'daemon_error');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runUserPrompt: records only safe projected proposal IDs with one proposal-time observer snapshot', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-evaluation-proposal-'));
  const turns = [];
  const observerCalls = [];
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    await runUserPrompt({
      readInput: async () => ({ session_id: 's-evaluation', cwd: project, prompt: '確認して', transcript_path: '/tmp/evaluation.jsonl' }),
      randomUUIDFn: () => '00000000-0000-4000-8000-000000000001',
      now: () => 123456789,
      sendRequestFn: async () => ({ ok: true, result: {
        pass: false,
        missing_tools: [{ name: 'mcp__caveat__caveat_search', reason: 'raw-reason-must-not-persist' }],
        evaluation_meta: { backend: 'codex-cli', model: 'gpt-test' },
      } }),
      createEvaluationStoreFn: () => ({ recordTurn: (turn) => turns.push(turn), close() {} }),
      loadEvaluationObserverContextFn: async (args) => {
        observerCalls.push(args);
        return { status: 'context_available', snapshot: { schema: 'throughline.observer_read.v1', status: 'snapshot' } };
      },
    });
    assert.equal(observerCalls.length, 1);
    assert.equal(observerCalls[0].recordedAtMs, 123456789);
    assert.equal(observerCalls[0].host, 'claude');
    assert.equal(observerCalls[0].sessionId, 's-evaluation');
    assert.equal('config' in observerCalls[0], false, 'observer-read resolves its own config independently');
    assert.equal(turns.length, 1);
    assert.deepEqual(turns[0].proposedToolIds, ['mcp__caveat__caveat_search']);
    assert.equal(turns[0].auditStatus, 'success');
    assert.equal(turns[0].backend, 'codex-cli');
    assert.equal(turns[0].model, 'gpt-test');
    assert.equal(turns[0].auditorSeenContext, null);
    assert.equal(turns[0].recordedAtMs, 123456789);
    assert.equal(turns[0].proposedAtMs, 123456789);
    assert.doesNotMatch(JSON.stringify(turns[0]), /raw-reason-must-not-persist/);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runUserPrompt: observer-read failure never suppresses the completed audit or projected advice', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-evaluation-observer-failure-'));
  const sentinel = 'OBSERVER_READ_RAW_SENTINEL';
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    let output = '';
    let stderr = '';
    const events = [];
    await runUserPrompt({
      readInput: async () => ({ session_id: 's-observer-failure', cwd: project, prompt: '過去の罠を確認して' }),
      sendRequestFn: async () => ({
        ok: true,
        result: {
          pass: false,
          missing_tools: [{ name: 'mcp__caveat__caveat_search', reason: 'raw-auditor-reason' }],
        },
      }),
      loadEvaluationObserverContextFn: async () => { throw new Error(sentinel); },
      recordHookEventFn: async ({ event }) => { events.push(event); },
      writeOutput: (text) => { output += text; },
      writeError: (text) => { stderr += text; },
    });

    const advice = JSON.parse(output).hookSpecificOutput.additionalContext;
    assert.match(advice, /mcp__caveat__caveat_search/);
    assert.match(stderr, /評価記録に失敗/);
    assert.doesNotMatch(output + stderr + JSON.stringify(events), new RegExp(sentinel));
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'success');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runPreToolUse: unresolved usage marks the active observation incomplete without denying the tool', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-pretool-evaluation-'));
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    let request;
    await runPreToolUse({
      readInput: async () => ({ session_id: 's-pretool-evaluation', cwd: project, tool_name: 'Skill', tool_input: {} }),
      sendRequestFn: async (next) => { request = next; return { ok: true, result: { recorded: true } }; },
    });
    assert.deepEqual(request.payload, { tool_name: 'Skill', evaluation_observed: true, evaluation_tool_id: null, usage_incomplete: true });
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runPreToolUse: ordinary built-in tools do not make evaluation usage incomplete', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-pretool-built-in-'));
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    let request;
    await runPreToolUse({
      readInput: async () => ({ session_id: 's-pretool-built-in', cwd: project, tool_name: 'Bash', tool_input: { command: 'pwd' } }),
      sendRequestFn: async (next) => { request = next; return { ok: true, result: { recorded: true } }; },
    });
    assert.deepEqual(request.payload, { tool_name: 'Bash', evaluation_observed: false, evaluation_tool_id: null, usage_incomplete: false });
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runPreToolUse: successful Skill keeps its raw tool name and carries the selector only for evaluation', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-pretool-skill-'));
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    let request;
    await runPreToolUse({
      readInput: async () => ({ session_id: 's-pretool-skill', cwd: project, tool_name: 'Skill', tool_input: { skill: 'throughline' } }),
      sendRequestFn: async (next) => { request = next; return { ok: true, result: { recorded: true } }; },
    });
    assert.deepEqual(request.payload, {
      tool_name: 'Skill', evaluation_observed: true, evaluation_tool_id: 'throughline', usage_incomplete: false,
    });
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
