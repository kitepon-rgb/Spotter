import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadEvaluationContext } from '../src/core/evaluation-context.mjs';

const CONFIG = Object.freeze({
  mode: 'throughline',
  command: '/opt/throughline/bin/throughline',
  args: Object.freeze(['--profile', 'readonly']),
});

test('evaluation context: 提案元sessionとtranscriptを既存auditor-contextへ渡す', async () => {
  const calls = [];
  const snapshot = Object.freeze({
    schema: 'throughline.auditor_context.v1',
    status: 'fresh',
    turns: Object.freeze([{ originSessionId: 'session-1', user: '前の依頼', assistant: '前の応答' }]),
  });
  const result = await loadEvaluationContext({
    projectRoot: '/repo',
    host: 'claude',
    sessionId: 'session-1',
    transcriptPath: '/tmp/transcript.jsonl',
    config: CONFIG,
    recordedAtMs: 123,
    realpathFn: async (value) => value,
    loadAuditorContextFn: async (args) => {
      calls.push(args);
      return snapshot;
    },
  });

  assert.equal(result.status, 'context_available');
  assert.equal(result.snapshot, snapshot);
  assert.deepEqual(calls, [{
    config: CONFIG,
    host: 'claude',
    sessionId: 'session-1',
    projectRoot: '/repo',
    transcriptPath: '/tmp/transcript.jsonl',
    timeoutMs: 1_000,
    maxBuffer: 64 * 1024,
  }]);
});

test('evaluation context: freshでないauditor-context本文は保存しない', async () => {
  const result = await loadEvaluationContext({
    projectRoot: '/repo',
    host: 'claude',
    sessionId: 'session-1',
    transcriptPath: '/tmp/transcript.jsonl',
    config: CONFIG,
    recordedAtMs: 456,
    realpathFn: async (value) => value,
    loadAuditorContextFn: async () => ({ status: 'session_mismatch', turns: [] }),
  });

  assert.deepEqual(result, {
    status: 'context_unavailable',
    recordedAtMs: 456,
    reason: 'auditor_context_session_mismatch',
    snapshot: null,
  });
});
