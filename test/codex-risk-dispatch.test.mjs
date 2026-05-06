import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dispatchCodexRiskCheck,
  isCodexRiskDispatchDryRun,
  isCodexRiskDispatchEnabled,
} from '../src/core/codex-risk-dispatch.mjs';

const judgment = {
  pass: false,
  findings: [
    {
      id: 'spotter.user_input.1',
      stage: 'user_input',
      toolName: 'mcp__caveat__caveat_search',
      reason: '既知の罠を確認する必要がある',
      category: 'tool_miss',
      severity: 'unknown',
      confidence: 'unknown',
      references: [],
      source: 'haiku',
    },
  ],
  anomalies: [],
  meta: { stage: 'user_input' },
};

test('isCodexRiskDispatchEnabled / DryRun: env flags are explicit opt-in', () => {
  assert.equal(isCodexRiskDispatchEnabled({}), false);
  assert.equal(isCodexRiskDispatchEnabled({ SPOTTER_CODEX_RISK_CHECK: '1' }), true);
  assert.equal(isCodexRiskDispatchEnabled({ SPOTTER_CODEX_RISK_CHECK: 'true' }), true);
  assert.equal(isCodexRiskDispatchDryRun({}), false);
  assert.equal(isCodexRiskDispatchDryRun({ SPOTTER_CODEX_RISK_CHECK_DRY_RUN: 'yes' }), true);
});

test('dispatchCodexRiskCheck: writes judgment and spawns detached spotter codex risk-check', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-risk-dispatch-'));
  try {
    const spawnCalls = [];
    const dispatch = await dispatchCodexRiskCheck({
      projectRoot: project,
      judgment,
      sessionId: 'session/with:unsafe',
      stage: 'user_input',
      hostAgent: 'claude',
      dryRun: true,
      now: () => new Date('2026-05-06T01:02:03.004Z'),
      env: { PATH: '/bin' },
      spawnFn: (cmd, args, opts) => {
        spawnCalls.push({ cmd, args, opts });
        return {
          pid: 12345,
          on: () => {},
          unref: () => {},
        };
      },
    });

    assert.equal(dispatch.dispatched, true);
    assert.equal(dispatch.pid, 12345);
    assert.match(dispatch.findingsPath, /session_with_unsafe-user_input-findings\.json$/);
    assert.match(dispatch.resultPath, /session_with_unsafe-user_input-codex-risk-check\.json$/);
    const saved = JSON.parse(await readFile(dispatch.findingsPath, 'utf8'));
    assert.deepEqual(saved.judgment.findings, judgment.findings);

    assert.equal(spawnCalls.length, 1);
    const call = spawnCalls[0];
    assert.equal(call.cmd, process.execPath);
    assert.ok(call.args.includes('codex'));
    assert.ok(call.args.includes('risk-check'));
    assert.ok(call.args.includes('--dry-run'));
    assert.equal(call.args[call.args.indexOf('--host-agent') + 1], 'claude');
    assert.equal(call.args[call.args.indexOf('--findings') + 1], dispatch.findingsPath);
    assert.equal(call.args[call.args.indexOf('--out') + 1], dispatch.resultPath);
    assert.equal(call.opts.detached, true);
    assert.equal(call.opts.stdio, 'ignore');
    assert.equal(call.opts.env.SPOTTER_SIDECAR, '1');
    assert.match(call.opts.env.SPOTTER_PARENT_PID, /^codex-risk-dispatch:/);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('dispatchCodexRiskCheck: pass=true is a no-op', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-risk-dispatch-noop-'));
  try {
    const dispatch = await dispatchCodexRiskCheck({
      projectRoot: project,
      judgment: { pass: true, findings: [], anomalies: [], meta: { stage: 'user_input' } },
      spawnFn: () => {
        throw new Error('spawn should not be called');
      },
    });
    assert.deepEqual(dispatch, { dispatched: false, reason: 'no_findings' });
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
