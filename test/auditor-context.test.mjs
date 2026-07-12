import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AuditorContextProviderError,
  loadAuditorContext,
  readProjectAuditorContextConfig,
  validateAuditorContextResult,
} from '../src/core/auditor-context.mjs';

function freshContext(overrides = {}) {
  return {
    schema: 'throughline.auditor_context.v1',
    status: 'fresh',
    freshness: { expectedAssistantMatched: true },
    turns: [{
      originSessionId: 'session-1', turnNumber: 3, user: '前の依頼', assistant: '前の応答', createdAt: 1,
    }],
    stats: { requestedTurns: 2, returnedTurns: 1, chars: 8, truncated: false },
    ...overrides,
  };
}

test('readProjectAuditorContextConfig: accepts disabled and absolute Throughline configuration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-context-config-'));
  try {
    await mkdir(join(dir, '.spotter'));
    await writeFile(join(dir, '.spotter', 'marker.json'), JSON.stringify({ auditorContext: { mode: 'disabled' } }));
    assert.deepEqual(await readProjectAuditorContextConfig(dir), { mode: 'disabled' });
    await writeFile(join(dir, '.spotter', 'marker.json'), JSON.stringify({ auditorContext: {
      mode: 'throughline', command: '/usr/local/bin/throughline', args: ['--profile', 'read-only'],
    } }));
    assert.deepEqual(await readProjectAuditorContextConfig(dir), {
      mode: 'throughline', command: '/usr/local/bin/throughline', args: ['--profile', 'read-only'],
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readProjectAuditorContextConfig: rejects invalid provider configuration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-context-invalid-'));
  try {
    await mkdir(join(dir, '.spotter'));
    for (const auditorContext of [
      { mode: 'unknown' },
      { mode: 'throughline', command: 'throughline', args: [] },
      { mode: 'throughline', command: 'C:\\tools\\throughline.cmd', args: [] },
      { mode: 'throughline', command: '/abs/throughline', args: [''] },
    ]) {
      await writeFile(join(dir, '.spotter', 'marker.json'), JSON.stringify({ auditorContext }));
      await assert.rejects(readProjectAuditorContextConfig(dir), (err) =>
        err instanceof AuditorContextProviderError && err.code === 'E_AUDITOR_CONTEXT_CONFIG');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadAuditorContext: disabled never executes a provider', async () => {
  const result = await loadAuditorContext({
    config: { mode: 'disabled' },
    execFileFn: async () => { throw new Error('must not execute'); },
  });
  assert.equal(result.status, 'disabled');
  assert.deepEqual(result.turns, []);
});

test('loadAuditorContext: executes Throughline with bounded arguments and prefixes Codex session IDs', async () => {
  const calls = [];
  const result = await loadAuditorContext({
    config: { mode: 'throughline', command: '/usr/local/bin/throughline', args: ['--profile', 'read-only'] },
    host: 'codex', sessionId: 'thread-1', projectRoot: '/repo', transcriptPath: '/tmp/transcript.jsonl',
    execFileFn: async (...args) => {
      calls.push(args);
      return { stdout: JSON.stringify(freshContext()) };
    },
  });
  assert.equal(result.status, 'fresh');
  assert.deepEqual(calls, [[
    '/usr/local/bin/throughline',
    ['--profile', 'read-only', 'auditor-context', '--session', 'codex:thread-1', '--project', '/repo', '--host', 'codex', '--transcript', '/tmp/transcript.jsonl', '--recent-turns', '2', '--max-body-chars', '600', '--max-total-chars', '4000', '--json'],
    { encoding: 'utf8', timeout: 1_000, maxBuffer: 64 * 1024, windowsHide: true, shell: false },
  ]]);
});

test('validateAuditorContextResult: accepts fresh and non-fresh empty results only', () => {
  assert.equal(validateAuditorContextResult(freshContext()).status, 'fresh');
  assert.equal(validateAuditorContextResult(freshContext({ status: 'stale', turns: [], stats: { requestedTurns: 2, returnedTurns: 0, chars: 0, truncated: false } })).status, 'stale');
  assert.throws(() => validateAuditorContextResult(freshContext({ status: 'stale' })), AuditorContextProviderError);
  assert.throws(() => validateAuditorContextResult(freshContext({ freshness: undefined })), AuditorContextProviderError);
  assert.throws(() => validateAuditorContextResult(freshContext({
    turns: [], stats: { requestedTurns: 2, returnedTurns: 0, chars: 0, truncated: false },
  })), AuditorContextProviderError);
});

test('validateAuditorContextResult: rejects oversize turns and invalid raw provider JSON', async () => {
  assert.throws(() => validateAuditorContextResult(freshContext({
    turns: Array.from({ length: 4 }, (_, turnNumber) => ({ originSessionId: 's', turnNumber, user: '', assistant: '', createdAt: 1 })),
    stats: { requestedTurns: 3, returnedTurns: 4, chars: 0, truncated: false },
  })), AuditorContextProviderError);
  const sentinel = 'PROVIDER_RAW_SENTINEL_MUST_NOT_LEAK';
  await assert.rejects(loadAuditorContext({
    config: { mode: 'throughline', command: '/bin/throughline', args: [] },
    host: 'claude', sessionId: 'session', projectRoot: '/repo', transcriptPath: '/tmp/t',
    execFileFn: async () => ({ stdout: `{not-json ${sentinel}` }),
  }), (err) => err instanceof AuditorContextProviderError
    && err.code === 'E_AUDITOR_CONTEXT_SCHEMA'
    && !err.message.includes(sentinel));
});

test('loadAuditorContext: maps timeout, unavailable, and execution failures to fixed codes without raw output', async () => {
  const base = {
    config: { mode: 'throughline', command: '/bin/throughline', args: [] },
    host: 'claude', sessionId: 'session', projectRoot: '/repo', transcriptPath: '/tmp/t',
  };
  for (const [cause, code] of [
    [Object.assign(new Error('timeout raw'), { code: 'ETIMEDOUT' }), 'E_AUDITOR_CONTEXT_TIMEOUT'],
    [Object.assign(new Error('missing raw'), { code: 'ENOENT' }), 'E_AUDITOR_CONTEXT_UNAVAILABLE'],
    [new Error('provider raw'), 'E_AUDITOR_CONTEXT_EXEC'],
  ]) {
    await assert.rejects(loadAuditorContext({ ...base, execFileFn: async () => { throw cause; } }), (err) =>
      err instanceof AuditorContextProviderError && err.code === code && !err.message.includes('raw'));
  }
});
