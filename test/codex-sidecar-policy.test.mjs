import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildDiagnosticsCommand,
  buildSidecarSpawnOptions,
  classifySidecarAvailability,
  decideCodexSidecarUse,
  detectHostAgent,
  workCapabilitySmokeFromDiagnostics,
} from '../src/core/codex-sidecar-policy.mjs';
import { runSessionStart } from '../src/hooks/session-start.mjs';

test('detectHostAgent: explicit host wins, then known env markers', () => {
  assert.equal(detectHostAgent({ explicitHostAgent: 'claude', env: { CODEX_SESSION_ID: 'c' } }), 'claude');
  assert.equal(detectHostAgent({ env: { CLAUDECODE: '1' } }), 'claude');
  assert.equal(detectHostAgent({ env: { CODEX_SESSION_ID: 'c' } }), 'codex');
  assert.equal(detectHostAgent({ env: { GITHUB_ACTIONS: 'true' } }), 'automation');
  assert.equal(detectHostAgent({ env: {} }), 'unknown');
});

test('buildDiagnosticsCommand: codex-sidecar diagnostics is the availability command', () => {
  assert.deepEqual(buildDiagnosticsCommand({
    projectRoot: '/repo',
    preset: 'review',
  }), [
    'codex-sidecar',
    'diagnostics',
    '--project',
    '/repo',
    '--preset',
    'review',
    '--json',
  ]);
});

test('classifySidecarAvailability: maps diagnostics and smoke to explicit states', () => {
  assert.deepEqual(classifySidecarAvailability({ disabled: true }), {
    state: 'explicitly disabled',
    reason: 'codex_sidecar_explicitly_disabled',
    diagnostics: null,
    smoke: null,
  });
  assert.equal(classifySidecarAvailability().state, 'unavailable');
  assert.equal(classifySidecarAvailability({ diagnostics: { status: 'error', reason: 'missing_config' } }).state, 'unavailable');
  assert.equal(classifySidecarAvailability({ diagnostics: { status: 'ok' } }).state, 'configured');
  assert.equal(classifySidecarAvailability({ diagnostics: { status: 'ok' }, smoke: { status: 'ok' } }).state, 'operational');
  assert.equal(
    classifySidecarAvailability({ diagnostics: { status: 'ok' }, smoke: { status: 'ok', worktree: true } }).state,
    'work-capable'
  );
});

test('workCapabilitySmokeFromDiagnostics: requires work preset, worktree, and allowed paths', () => {
  assert.deepEqual(workCapabilitySmokeFromDiagnostics({
    status: 'ok',
    normalizedRequest: {
      workflow: 'work',
      readonly: false,
      requireWorktree: true,
      allowedPaths: ['src/'],
    },
  }), {
    status: 'ok',
    worktree: true,
    reason: 'work_preset_requires_worktree_with_allowed_paths',
  });
  assert.equal(workCapabilitySmokeFromDiagnostics({
    status: 'ok',
    normalizedRequest: {
      workflow: 'work',
      readonly: false,
      requireWorktree: true,
      allowedPaths: [],
    },
  }).status, 'failed');
});

test('decideCodexSidecarUse: Claude prefers available sidecar for independent read-only workflows', () => {
  assert.deepEqual(decideCodexSidecarUse({
    hostAgent: 'claude',
    availability: 'configured',
    workflow: 'codex_review',
  }), {
    useSidecar: true,
    mode: 'sidecar',
    reason: 'claude_host_independent_second_pass',
  });
});

test('decideCodexSidecarUse: Codex host avoids Codex-on-Codex without a boundary', () => {
  assert.deepEqual(decideCodexSidecarUse({
    hostAgent: 'codex',
    availability: 'operational',
    workflow: 'codex_review',
  }), {
    useSidecar: false,
    mode: 'direct',
    reason: 'codex_host_without_independent_boundary',
  });
  assert.equal(decideCodexSidecarUse({
    hostAgent: 'codex',
    availability: 'operational',
    workflow: 'codex_review',
    explicitSecondPass: true,
  }).useSidecar, true);
});

test('decideCodexSidecarUse: unavailable and disabled states are explicit compatibility mode', () => {
  assert.deepEqual(decideCodexSidecarUse({
    hostAgent: 'claude',
    availability: 'unavailable',
    workflow: 'codex_review',
  }), {
    useSidecar: false,
    mode: 'compatibility',
    reason: 'codex_sidecar_unavailable',
  });
  assert.equal(decideCodexSidecarUse({
    hostAgent: 'claude',
    availability: 'explicitly disabled',
    workflow: 'codex_review',
  }).reason, 'codex_sidecar_explicitly_disabled');
});

test('decideCodexSidecarUse: work workflow requires work-capable availability', () => {
  assert.equal(decideCodexSidecarUse({
    hostAgent: 'claude',
    availability: 'operational',
    workflow: 'codex_work',
    requiresWorktree: true,
  }).reason, 'codex_sidecar_not_work_capable');
  assert.equal(decideCodexSidecarUse({
    hostAgent: 'claude',
    availability: 'work-capable',
    workflow: 'codex_work',
    requiresWorktree: true,
  }).useSidecar, true);
});

test('buildSidecarSpawnOptions: marks sidecar children so Claude hooks do not spawn daemons', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-sidecar-policy-'));
  const prev = process.env.SPOTTER_PARENT_PID;
  try {
    await mkdir(join(project, '.spotter'), { recursive: true });
    await writeFile(join(project, '.spotter', 'marker.json'), '{}', 'utf8');
    const options = buildSidecarSpawnOptions({
      projectRoot: project,
      env: { PATH: '/bin' },
      marker: 'test-sidecar',
    });
    assert.equal(options.cwd, project);
    assert.match(options.env.SPOTTER_PARENT_PID, /^test-sidecar:/);
    assert.equal(options.env.SPOTTER_SIDECAR, '1');

    process.env.SPOTTER_PARENT_PID = options.env.SPOTTER_PARENT_PID;
    let spawnCount = 0;
    await runSessionStart({
      readInput: async () => ({
        session_id: 'sidecar-recursion',
        cwd: project,
        source: 'startup',
      }),
      spawnDaemonAndWaitReadyFn: async () => {
        spawnCount += 1;
      },
      spawnRefreshDetachedFn: () => {},
    });
    assert.equal(spawnCount, 0);
  } finally {
    if (prev === undefined) delete process.env.SPOTTER_PARENT_PID;
    else process.env.SPOTTER_PARENT_PID = prev;
    await rm(project, { recursive: true, force: true });
  }
});
