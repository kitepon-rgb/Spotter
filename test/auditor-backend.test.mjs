import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  AuditorBackendError,
  createAuditorBackend,
  createHaikuAuditorBackend,
  filterCatalogMisses,
  parseAuditorResponse,
  selectAuditorBackend,
} from '../src/core/auditor-backend.mjs';
import { detectHostAgent } from '../src/core/host-agent.mjs';

const catalog = [
  { name: 'current_time', description: 'get current time' },
  { name: 'mcp__caveat__caveat_search', description: 'search caveats' },
];

test('parseAuditorResponse: backend-neutral parser accepts the Spotter JSON shape', () => {
  const parsed = parseAuditorResponse('```json\n{"pass":true,"missing_tools":[]}\n```', {
    backend: 'codex-cli',
    stage: 'user_input',
  });
  assert.deepEqual(parsed, { pass: true, missing_tools: [] });
});

test('parseAuditorResponse: schema errors use AuditorBackendError, not HaikuError', () => {
  assert.throws(
    () => parseAuditorResponse('{"pass":false,"missing_tools":[]}', { backend: 'codex-cli' }),
    (err) =>
      err instanceof AuditorBackendError &&
      err.code === 'E_AUDITOR_SCHEMA' &&
      err.backend === 'codex-cli' &&
      err.message.includes('inconsistent')
  );
});

test('filterCatalogMisses: backend-neutral filtering preserves current hallucination semantics', () => {
  const { parsed, dropped } = filterCatalogMisses({
    pass: false,
    missing_tools: [{ name: 'ghost_tool', reason: 'bogus' }],
  }, catalog.map((tool) => tool.name));
  assert.deepEqual(dropped, ['ghost_tool']);
  assert.deepEqual(parsed, {
    pass: true,
    missing_tools: [],
    reason: 'hallucination_filtered',
  });
});

test('detectHostAgent: neutral host detection is available outside sidecar policy', () => {
  assert.equal(detectHostAgent({ env: { CLAUDE_CODE: '1', CODEX_SESSION_ID: 'c' } }), 'claude');
  assert.equal(detectHostAgent({ env: { CODEX_SANDBOX: 'read-only' } }), 'codex');
  assert.equal(detectHostAgent({ env: { CI: 'true' } }), 'automation');
  assert.equal(detectHostAgent({ env: {} }), 'unknown');
});

test('selectAuditorBackend: explicit backend wins over policy and host default', () => {
  assert.deepEqual(selectAuditorBackend({
    hostAgent: 'codex',
    env: {
      SPOTTER_AUDITOR_BACKEND: 'haiku',
      SPOTTER_AUDITOR_BACKEND_POLICY: 'next',
    },
  }), {
    backend: 'haiku',
    mode: 'haiku',
    compatibility: 'explicit_haiku',
    reason: 'explicit_backend',
  });
});

test('selectAuditorBackend: current keeps Haiku for Claude and Codex hosts', () => {
  assert.deepEqual(selectAuditorBackend({
    hostAgent: 'claude',
    env: { SPOTTER_AUDITOR_BACKEND_POLICY: 'current' },
  }), {
    backend: 'haiku',
    mode: 'compatibility_haiku',
    compatibility: 'current_haiku',
    reason: 'policy_current_claude',
  });
  assert.deepEqual(selectAuditorBackend({
    hostAgent: 'codex',
    env: { SPOTTER_AUDITOR_BACKEND_POLICY: 'current' },
  }), {
    backend: 'haiku',
    mode: 'compatibility_haiku',
    compatibility: 'current_haiku',
    reason: 'policy_current_codex',
  });
});

test('selectAuditorBackend: next promotes Codex CLI for Codex and Claude hosts (Phase 5)', () => {
  assert.deepEqual(selectAuditorBackend({
    hostAgent: 'codex',
    env: { SPOTTER_AUDITOR_BACKEND_POLICY: 'next' },
  }), {
    backend: 'codex-cli',
    mode: 'codex-cli',
    compatibility: 'none',
    reason: 'policy_next_codex_host',
  });
  assert.deepEqual(selectAuditorBackend({
    hostAgent: 'claude',
    env: { SPOTTER_AUDITOR_BACKEND_POLICY: 'next' },
  }), {
    backend: 'codex-cli',
    mode: 'codex-cli',
    compatibility: 'none',
    reason: 'policy_next_claude_codex_cli',
  });
});

test('selectAuditorBackend: explicit haiku still wins under next policy on Claude host', () => {
  // Phase 5 must not silently fall back to Haiku, but explicit
  // SPOTTER_AUDITOR_BACKEND=haiku is the documented compatibility escape hatch.
  assert.deepEqual(selectAuditorBackend({
    hostAgent: 'claude',
    env: {
      SPOTTER_AUDITOR_BACKEND: 'haiku',
      SPOTTER_AUDITOR_BACKEND_POLICY: 'next',
    },
  }), {
    backend: 'haiku',
    mode: 'haiku',
    compatibility: 'explicit_haiku',
    reason: 'explicit_backend',
  });
});

test('selectAuditorBackend: auto on unknown host requires explicit backend', () => {
  assert.throws(
    () => selectAuditorBackend({ hostAgent: 'unknown', env: { SPOTTER_AUDITOR_BACKEND: 'auto' } }),
    (err) => err instanceof AuditorBackendError && err.code === 'E_BACKEND_HOST_UNKNOWN'
  );
});

test('createAuditorBackend: codex-sidecar returns the sidecar auditor backend', () => {
  const backend = createAuditorBackend({ backend: 'codex-sidecar', catalog, projectRoot: '/repo' });
  assert.equal(backend.name, 'codex-sidecar');
});

test('createAuditorBackend: auto + Claude host + next policy yields codex-cli backend', () => {
  const backend = createAuditorBackend({
    backend: 'auto',
    catalog,
    projectRoot: '/repo',
    hostAgent: 'claude',
    env: { SPOTTER_AUDITOR_BACKEND_POLICY: 'next' },
  });
  assert.equal(backend.name, 'codex-cli');
});

test('createAuditorBackend: auto + Claude host + current policy stays on Haiku', () => {
  const backend = createAuditorBackend({
    backend: 'auto',
    catalog,
    projectRoot: '/repo',
    hostAgent: 'claude',
    env: { SPOTTER_AUDITOR_BACKEND_POLICY: 'current' },
  });
  assert.equal(backend.name, 'haiku');
});

test('createHaikuAuditorBackend: adapter returns SpotterJudgment and preserves preamble-once caller state', async () => {
  const prompts = [];
  const haikuCaller = async (prompt) => {
    prompts.push(prompt);
    haikuCaller.isFirstCall = false;
    return JSON.stringify({
      pass: false,
      missing_tools: [{ name: 'current_time', reason: 'time question' }],
    });
  };
  haikuCaller.isFirstCall = true;
  let resetCalled = 0;
  haikuCaller.reset = () => {
    resetCalled += 1;
    haikuCaller.isFirstCall = true;
  };

  const backend = createHaikuAuditorBackend({ catalog, haikuCaller });
  const judgment = await backend.judge({ stage: 'user_input', userInput: '今何時?' });
  assert.equal(backend.name, 'haiku');
  assert.equal(judgment.pass, false);
  assert.equal(judgment.findings[0].toolName, 'current_time');
  assert.equal(judgment.meta.backend, 'haiku');
  assert.equal(judgment.meta.mode, 'first');
  assert.equal(typeof judgment.meta.durationMs, 'number');
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].includes('stage=user_input'));
  assert.ok(!prompts[0].includes('## カタログ'), 'adapter must pass only per-turn delta to provided caller');
  backend.reset();
  assert.equal(resetCalled, 1);
});

test('auditor-backend module does not import codex-sidecar policy', async () => {
  const source = await readFile(new URL('../src/core/auditor-backend.mjs', import.meta.url), 'utf8');
  assert.ok(!source.includes('codex-sidecar-policy'));
});
