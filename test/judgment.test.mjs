import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legacyResultFromJudgment, toSpotterFinding, toSpotterJudgment } from '../src/core/judgment.mjs';

test('toSpotterFinding: maps a Haiku missing tool to neutral finding shape', () => {
  const finding = toSpotterFinding({
    stage: 'user_input',
    index: 0,
    tool: { name: 'mcp__caveat__caveat_search', reason: '既知の罠を確認する必要がある' },
  });

  assert.deepEqual(finding, {
    id: 'spotter.user_input.1',
    stage: 'user_input',
    toolName: 'mcp__caveat__caveat_search',
    reason: '既知の罠を確認する必要がある',
    category: 'tool_miss',
    severity: 'unknown',
    confidence: 'unknown',
    references: [],
    source: 'haiku',
    raw: { name: 'mcp__caveat__caveat_search', reason: '既知の罠を確認する必要がある' },
  });
});

test('toSpotterJudgment: maps pass=false parsed result to findings', () => {
  const judgment = toSpotterJudgment({
    stage: 'turn_end',
    parsed: {
      pass: false,
      missing_tools: [
        { name: 'mcp__caveat__caveat_record', reason: '新発見を記録する必要がある' },
      ],
    },
    meta: { mode: 'resumed', durationMs: 123 },
  });

  assert.equal(judgment.pass, false);
  assert.equal(judgment.findings.length, 1);
  assert.equal(judgment.findings[0].id, 'spotter.turn_end.1');
  assert.equal(judgment.findings[0].stage, 'turn_end');
  assert.equal(judgment.findings[0].severity, 'unknown');
  assert.deepEqual(judgment.anomalies, []);
  assert.deepEqual(judgment.meta, { stage: 'turn_end', mode: 'resumed', durationMs: 123 });
});

test('toSpotterJudgment: uses backend meta as finding source when present', () => {
  const judgment = toSpotterJudgment({
    stage: 'user_input',
    parsed: {
      pass: false,
      missing_tools: [
        { name: 'mcp__caveat__caveat_search', reason: '検索すべき' },
      ],
    },
    meta: { backend: 'codex-cli' },
  });

  assert.equal(judgment.findings[0].source, 'codex-cli');
});

test('toSpotterJudgment: preserves known anomalies without turning them into findings', () => {
  const judgment = toSpotterJudgment({
    stage: 'user_input',
    parsed: {
      pass: true,
      missing_tools: [],
      reason: 'role_collapse_reset',
    },
  });

  assert.equal(judgment.pass, true);
  assert.deepEqual(judgment.findings, []);
  assert.equal(judgment.anomalies.length, 1);
  assert.equal(judgment.anomalies[0].type, 'role_collapse_reset');
  assert.equal(judgment.anomalies[0].source, 'spotter');
});

test('legacyResultFromJudgment: projects neutral judgment back to existing Claude shape', () => {
  const judgment = toSpotterJudgment({
    stage: 'user_input',
    parsed: {
      pass: false,
      missing_tools: [
        { name: 'mcp__caveat__caveat_search', reason: '検索すべき' },
      ],
    },
  });

  assert.deepEqual(legacyResultFromJudgment(judgment), {
    pass: false,
    missing_tools: [
      { name: 'mcp__caveat__caveat_search', reason: '検索すべき' },
    ],
  });
});

test('legacyResultFromJudgment: preserves anomaly reason for existing logs and hook behavior', () => {
  const judgment = toSpotterJudgment({
    stage: 'turn_end',
    parsed: {
      pass: true,
      missing_tools: [],
      reason: 'hallucination_filtered',
    },
  });

  assert.deepEqual(legacyResultFromJudgment(judgment), {
    pass: true,
    missing_tools: [],
    reason: 'hallucination_filtered',
  });
});
