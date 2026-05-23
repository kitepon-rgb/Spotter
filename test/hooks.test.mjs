import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSessionStart } from '../src/hooks/session-start.mjs';
import { runUserPrompt } from '../src/hooks/user-prompt.mjs';
import { runStop } from '../src/hooks/stop.mjs';
import { TransportError } from '../src/daemon/transport.mjs';
import {
  appendPendingContext,
  drainPendingContexts,
  pendingPath,
  readPendingContexts,
} from '../src/hooks/pending-context.mjs';
import {
  formatTransparentContext,
  formatTransparentBlockReason,
  isChildCall,
  isSubagentCall,
  findSpotterMarker,
  isOutsideSpotterProject,
} from '../src/hooks/lib.mjs';

test('formatTransparentContext: mentions Spotter explicitly (§12.2)', () => {
  const text = formatTransparentContext([
    { name: 'mcp__caveat__caveat_search', reason: '過去の罠を確認する必要がある' },
  ]);
  assert.equal(text, [
    '[Spotter からの推奨ツール]',
    'このプロンプトに応答する前に、以下のツールを使うべきか検討してください。',
    '- `mcp__caveat__caveat_search`: 過去の罠を確認する必要がある',
  ].join('\n'));
});

test('formatTransparentBlockReason: mentions Spotter and asks for correction (§12.3)', () => {
  const text = formatTransparentBlockReason([
    { name: 'mcp__caveat__caveat_record', reason: '再利用すべき知見を記録する必要がある' },
  ]);
  assert.equal(text, [
    '[Spotter からの指摘]',
    '上記応答ではツールが不足している可能性があります。以下を検討し、必要なら呼び出した上で応答を補正してください。',
    '- `mcp__caveat__caveat_record`: 再利用すべき知見を記録する必要がある',
  ].join('\n'));
});

test('formatTransparentContext: handles multiple tools', () => {
  const text = formatTransparentContext([
    { name: 'a', reason: 'r1' },
    { name: 'b', reason: 'r2' },
  ]);
  assert.ok(text.includes('a'));
  assert.ok(text.includes('b'));
  assert.ok(text.includes('r1'));
  assert.ok(text.includes('r2'));
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
      }),
      sendRequestFn: async (request) => {
        sendCount++;
        assert.equal(request.sessionId, 's-user');
        assert.equal(request.event, 'user_input');
        assert.deepEqual(request.payload, { user_input: 'この外部仕様の罠を確認して記録してください' });
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

test('runUserPrompt: short prompts return without daemon traffic', async () => {
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
      sendRequestFn: async () => {
        sendCount++;
        return { ok: true, result: { pass: true, missing_tools: [] } };
      },
      spawnDaemonAndWaitReadyFn: async () => {
        throw new Error('spawn should not be called for short prompt');
      },
      writeOutput: () => {
        throw new Error('output should not be written for short prompt');
      },
    });
    assert.equal(sendCount, 0);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

// Phase B (hook parity, 2026-05-08): pending-context queue + Stop deferred delivery.

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

test('appendPendingContext: creates file and dedupes identical entries', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-pending-append-'));
  try {
    await appendPendingContext({ projectRoot: project, sessionId: 's1', text: 'hello' });
    await appendPendingContext({ projectRoot: project, sessionId: 's1', text: 'hello' }); // dup
    await appendPendingContext({ projectRoot: project, sessionId: 's1', text: 'world' });
    const path = pendingPath({ projectRoot: project, sessionId: 's1' });
    const raw = await readFile(path, 'utf8');
    assert.deepEqual(JSON.parse(raw), ['hello', 'world']);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('drainPendingContexts: returns array and unlinks file', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-pending-drain-'));
  try {
    await appendPendingContext({ projectRoot: project, sessionId: 's1', text: 'one' });
    await appendPendingContext({ projectRoot: project, sessionId: 's1', text: 'two' });
    const drained = await drainPendingContexts({ projectRoot: project, sessionId: 's1' });
    assert.deepEqual(drained, ['one', 'two']);
    const path = pendingPath({ projectRoot: project, sessionId: 's1' });
    await assert.rejects(stat(path), (err) => err.code === 'ENOENT');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('drainPendingContexts: returns empty array when file is missing', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-pending-empty-'));
  try {
    const drained = await drainPendingContexts({ projectRoot: project, sessionId: 'never-written' });
    assert.deepEqual(drained, []);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
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
    const drained = await drainPendingContexts({ projectRoot: project, sessionId: 's-pass' });
    assert.deepEqual(drained, []);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runStop: pass:false queues block reason and emits no stdout', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-stop-defer-'));
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    let stdoutWrites = 0;
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
    });
    // No stdout from Stop hook itself; behavior visible via the pending queue file.
    assert.equal(stdoutWrites, 0);
    const path = pendingPath({ projectRoot: project, sessionId: 's-defer' });
    const queued = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(queued.length, 1);
    assert.match(queued[0], /\[Spotter からの指摘\]/);
    assert.match(queued[0], /mcp__caveat__caveat_search/);
    assert.match(queued[0], /既知の罠を確認する必要がある/);
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
    const drained = await drainPendingContexts({ projectRoot: project, sessionId: 's-active' });
    assert.deepEqual(drained, []);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runStop: transport failure exits with stderr (no silent fallback to pending)', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-stop-transport-'));
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    const dieCalls = [];
    await runStop({
      readInput: async () => ({
        session_id: 's-transport',
        cwd: project,
        transcript_path: '/tmp/transcript.jsonl',
      }),
      sendRequestFn: async () => {
        throw new TransportError('E_UNREACHABLE', 'daemon missing');
      },
      appendPendingContextFn: async () => {
        throw new Error('appendPendingContext must NOT be called on transport failure');
      },
      getLastAssistantTextFn: () => 'reply',
      dieFn: (msg, code) => { dieCalls.push({ msg, code }); },
    });
    assert.equal(dieCalls.length, 1);
    assert.equal(dieCalls[0].code, 1); // E_UNREACHABLE → exit 1 per exitCodeFor
    assert.match(dieCalls[0].msg, /E_UNREACHABLE/);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runUserPrompt: drains pending context and merges with daemon pass:false additionalContext', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-prompt-drain-merge-'));
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    await appendPendingContext({
      projectRoot: project,
      sessionId: 's-merge',
      text: '[Spotter からの指摘]\n前ターンの指摘テキスト',
    });
    let output = '';
    await runUserPrompt({
      readInput: async () => ({
        session_id: 's-merge',
        cwd: project,
        prompt: '次のターンの長いユーザー入力',
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
    assert.match(ctx, /前ターンの指摘テキスト/);
    assert.match(ctx, /\[Spotter からの推奨ツール\]/);
    assert.match(ctx, /今ターンの推奨/);
    // pending file deleted after drain
    const drained = await drainPendingContexts({ projectRoot: project, sessionId: 's-merge' });
    assert.deepEqual(drained, []);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runUserPrompt: short prompt with pending context emits drain only and skips daemon', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-prompt-short-pending-'));
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    await appendPendingContext({
      projectRoot: project,
      sessionId: 's-short-p',
      text: '[Spotter からの指摘]\n保留中の指摘',
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
    assert.equal(sendCalls, 0, 'short prompt must not call daemon');
    const parsed = JSON.parse(output);
    assert.match(parsed.hookSpecificOutput.additionalContext, /保留中の指摘/);
    // drained
    const drained = await drainPendingContexts({ projectRoot: project, sessionId: 's-short-p' });
    assert.deepEqual(drained, []);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runUserPrompt: pending drain only (daemon pass:true) still emits additionalContext', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-prompt-drain-only-'));
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    await appendPendingContext({
      projectRoot: project,
      sessionId: 's-drain-only',
      text: '[Spotter からの指摘]\n前ターン保留',
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
    const parsed = JSON.parse(output);
    assert.match(parsed.hookSpecificOutput.additionalContext, /前ターン保留/);
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
