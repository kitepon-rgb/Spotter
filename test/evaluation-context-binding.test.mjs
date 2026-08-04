import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadEvaluationObserverContext,
} from '../src/core/evaluation-context.mjs';

const CONFIG = Object.freeze({
  mode: 'throughline',
  command: '/opt/throughline/bin/throughline',
  args: Object.freeze(['--profile', 'readonly']),
});

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function snapshot({ host, threadId, turns = [] }) {
  const threadHash = host === null ? null : sha256(threadId);
  return {
    schema: 'throughline.observer_read.v1',
    status: 'snapshot',
    host,
    thread_sha256: threadHash,
    afterCursor: null,
    throughCursor: 'tlc1.fixed',
    turns: turns.map((turn) => ({ host, thread_sha256: threadHash, ...turn })),
    historyTruncated: false,
    page: { complete: true, nextToken: null },
  };
}

test('observer snapshot: Claude session hashを照合し、既存observer-readを一度だけ呼ぶ', async () => {
  const calls = [];
  const result = await loadEvaluationObserverContext({
    projectRoot: '/repo',
    host: 'claude',
    sessionId: 'claude-session-1',
    config: CONFIG,
    recordedAtMs: 123,
    realpathFn: async (value) => value,
    execFileFn: async (...args) => {
      calls.push(args);
      return { stdout: JSON.stringify(snapshot({
        host: 'claude',
        threadId: 'claude-session-1',
        turns: [{ completed_at: 100, user: '依頼', assistant: '応答' }],
      })) };
    },
  });

  assert.equal(result.status, 'context_available');
  assert.equal(result.snapshot.host, 'claude');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [
    CONFIG.command,
    ['--profile', 'readonly', 'observer-read', '--project', '/repo', '--limit', '10', '--json'],
    { encoding: 'utf8', timeout: 1_000, maxBuffer: 64 * 1024, windowsHide: true, shell: false },
  ]);
});

test('observer snapshot: Codexはobserver feedと同じくcodex:を除いたthread IDのhashへ束縛する', async () => {
  const result = await loadEvaluationObserverContext({
    projectRoot: '/repo',
    host: 'codex',
    sessionId: 'codex:thread-1',
    config: CONFIG,
    realpathFn: async (value) => value,
    execFileFn: async () => ({ stdout: JSON.stringify(snapshot({ host: 'codex', threadId: 'thread-1' })) }),
  });

  assert.equal(result.status, 'context_available');
  assert.equal(result.snapshot.thread_sha256, sha256('thread-1'));
});

test('observer snapshot: 同projectの別hostまたは別sessionは欠測にし、再問い合わせしない', async () => {
  for (const [wire, reason] of [
    [snapshot({ host: 'codex', threadId: 'thread-1' }), 'observer_host_mismatch'],
    [snapshot({ host: 'claude', threadId: 'other-session' }), 'observer_session_mismatch'],
  ]) {
    let calls = 0;
    const result = await loadEvaluationObserverContext({
      projectRoot: '/repo',
      host: 'claude',
      sessionId: 'expected-session',
      config: CONFIG,
      recordedAtMs: 456,
      realpathFn: async (value) => value,
      execFileFn: async () => {
        calls += 1;
        return { stdout: JSON.stringify(wire) };
      },
    });

    assert.deepEqual(result, {
      status: 'context_unavailable',
      recordedAtMs: 456,
      reason,
      snapshot: null,
    });
    assert.equal(calls, 1);
  }
});

test('observer snapshot: 完了turnが無いempty snapshotは他session本文を含まないため利用可能', async () => {
  const result = await loadEvaluationObserverContext({
    projectRoot: '/repo',
    host: 'claude',
    sessionId: 'session-without-completed-turn',
    config: CONFIG,
    realpathFn: async (value) => value,
    execFileFn: async () => ({ stdout: JSON.stringify(snapshot({ host: null, threadId: null })) }),
  });

  assert.equal(result.status, 'context_available');
  assert.equal(result.snapshot.host, null);
  assert.deepEqual(result.snapshot.turns, []);
});

test('observer snapshot: expected host/session identityは必須', async () => {
  const base = {
    projectRoot: '/repo',
    config: CONFIG,
    realpathFn: async (value) => value,
    execFileFn: async () => { throw new Error('must not execute'); },
  };
  await assert.rejects(loadEvaluationObserverContext({ ...base, sessionId: 'session' }), /host must be claude or codex/);
  await assert.rejects(loadEvaluationObserverContext({ ...base, host: 'claude' }), /sessionId must be a non-empty string/);
  await assert.rejects(loadEvaluationObserverContext({ ...base, host: 'codex', sessionId: 'codex:' }), /sessionId must identify a thread/);
});
