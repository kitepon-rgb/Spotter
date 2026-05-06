import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSidecarResultRecord,
  spotterFindingsToSidecarContextBlocks,
  spotterFindingToSidecarContextBlock,
} from '../src/core/sidecar-context.mjs';

test('spotterFindingToSidecarContextBlock: maps tool-miss finding to manual_note without fake ruleId', () => {
  const block = spotterFindingToSidecarContextBlock({
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

  assert.deepEqual(block, {
    kind: 'manual_note',
    source: 'spotter',
    trust: 'local',
    summary: 'Spotter user_input: mcp__caveat__caveat_search - 既知の罠を確認する必要がある',
    references: [],
    data: {
      schemaVersion: 'spotter.sidecar_context.v1',
      findingId: 'spotter.user_input.1',
      findingKind: 'spotter.tool_miss',
      stage: 'user_input',
      toolName: 'mcp__caveat__caveat_search',
      category: 'tool_miss',
      severity: 'unknown',
      confidence: 'unknown',
      source: 'haiku',
    },
  });
  assert.equal(Object.hasOwn(block.data, 'ruleId'), false);
});

test('spotterFindingsToSidecarContextBlocks: preserves real references only', () => {
  const blocks = spotterFindingsToSidecarContextBlocks([
    {
      id: 'spotter.detector.1',
      stage: 'turn_end',
      toolName: 'mcp__caveat__caveat_record',
      reason: '新しい外部仕様の罠を記録する必要がある',
      category: 'external_spec_trap',
      severity: 'medium',
      confidence: 'high',
      references: [
        { path: 'src/daemon/daemon.mjs', line: 123, label: 'Haiku error path' },
      ],
      source: 'detector',
      ruleId: 'SPOTTER-EXTSPEC-001',
    },
  ]);

  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].references, [
    { path: 'src/daemon/daemon.mjs', line: 123, label: 'Haiku error path' },
  ]);
  assert.equal(blocks[0].data.ruleId, 'SPOTTER-EXTSPEC-001');
  assert.equal(blocks[0].data.findingKind, 'spotter.external_spec_trap');
});

test('spotterFindingToSidecarContextBlock: rejects invalid references instead of inventing locations', () => {
  assert.throws(
    () => spotterFindingToSidecarContextBlock({
      id: 'spotter.user_input.1',
      stage: 'user_input',
      toolName: 'tool',
      reason: 'reason',
      references: [{ line: 42 }],
    }),
    /reference 0\.path/
  );
  assert.throws(
    () => spotterFindingToSidecarContextBlock({
      id: 'spotter.user_input.1',
      stage: 'user_input',
      toolName: 'tool',
      reason: 'reason',
      references: [{ path: 'src/file.mjs', line: 0 }],
    }),
    /positive integer/
  );
});

test('createSidecarResultRecord: defines durable structured result storage shape', () => {
  const contextBlocks = [
    spotterFindingToSidecarContextBlock({
      id: 'spotter.user_input.1',
      stage: 'user_input',
      toolName: 'mcp__caveat__caveat_search',
      reason: '既知の罠を確認する必要がある',
      category: 'tool_miss',
    }),
  ];

  assert.deepEqual(createSidecarResultRecord({
    workflow: 'codex_risk_check',
    status: 'success',
    contextBlocks,
    result: { risk: 'low' },
    meta: { projectRoot: '/repo' },
  }), {
    schemaVersion: 'spotter.sidecar_result.v1',
    workflow: 'codex_risk_check',
    status: 'success',
    contextBlocks,
    result: { risk: 'low' },
    error: null,
    meta: { projectRoot: '/repo' },
  });
});
