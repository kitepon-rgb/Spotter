import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createEvaluationStore,
  DEFAULT_OPEN_TURN_STALE_MS,
} from '../src/core/evaluation-store.mjs';

test('tool別集計とtool filterは提案しなかった成功turnもS母数に保つ', async () => {
  const fixture = await openFixture();
  try {
    recordAndClose(fixture.store, 'target', ['mcp__tools__target'], ['mcp__tools__target'], 1_000);
    recordAndClose(fixture.store, 'other', ['mcp__tools__other'], [], 2_000);
    recordAndClose(fixture.store, 'pass-1', [], [], 3_000);
    recordAndClose(fixture.store, 'pass-2', [], [], 4_000);

    const expectedTarget = {
      S: 4, P: 1, I: 1, C: 1, A: 1, M: 0,
      proposalRate: 0.25, toolAdoptionRate: 1,
    };
    const all = fixture.store.summarize();
    assert.deepEqual(all.byTool.mcp__tools__target, expectedTarget);
    assert.deepEqual(all.byTool.mcp__tools__other, {
      S: 4, P: 1, I: 1, C: 1, A: 0, M: 0,
      proposalRate: 0.25, toolAdoptionRate: 0,
    });

    const filtered = fixture.store.summarize({ toolId: 'mcp__tools__target' });
    assert.deepEqual(filtered.totals, expectedTarget);
    assert.deepEqual(filtered.byProject['/projects/metrics'], expectedTarget);
    assert.deepEqual(filtered.byHost.claude, expectedTarget);
    assert.deepEqual(filtered.byTool, { mcp__tools__target: expectedTarget });

    const neverProposed = fixture.store.summarize({ toolId: 'mcp__tools__absent' });
    assert.deepEqual(neverProposed.totals, {
      S: 4, P: 0, I: 0, C: 0, A: 0, M: 0,
      proposalRate: 0, toolAdoptionRate: null,
    });
  } finally {
    await fixture.cleanup();
  }
});

test('report時点でstaleなopen proposalだけをMへ分類し保存行は変更しない', async () => {
  const fixture = await openFixture();
  try {
    const nowMs = 10_000_000;
    const staleRecordedAt = nowMs - DEFAULT_OPEN_TURN_STALE_MS - 1;
    const recentRecordedAt = nowMs - DEFAULT_OPEN_TURN_STALE_MS + 1;
    recordOpen(fixture.store, 'stale', 'stale-session', staleRecordedAt, ['mcp__tools__stale']);
    recordOpen(fixture.store, 'recent', 'recent-session', recentRecordedAt, ['mcp__tools__recent']);

    assert.deepEqual(fixture.store.summarize({}, { nowMs }).totals, {
      S: 1, P: 1, I: 1, C: 0, A: 0, M: 1,
      proposalRate: 1, toolAdoptionRate: null,
    });
    assert.deepEqual(fixture.store.summarize({}, {
      nowMs: recentRecordedAt,
      openTurnStaleMs: DEFAULT_OPEN_TURN_STALE_MS,
    }).totals, {
      S: 0, P: 0, I: 0, C: 0, A: 0, M: 0,
      proposalRate: null, toolAdoptionRate: null,
    });

    const saved = fixture.store.getCase('stale');
    assert.equal(saved.completedAtMs, null);
    assert.equal(saved.usageStatus, 'open');
    assert.deepEqual(saved.items, [{ toolId: 'mcp__tools__stale', outcome: 'open' }]);
  } finally {
    await fixture.cleanup();
  }
});

async function openFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'spotter-evaluation-metrics-'));
  const store = createEvaluationStore({ databasePath: join(directory, 'evaluation.db') });
  return {
    store,
    cleanup: async () => {
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function baseTurn(observationId, sessionId, recordedAtMs, proposedToolIds) {
  return {
    observationId,
    recordedAtMs,
    proposedAtMs: recordedAtMs,
    projectPath: '/projects/metrics',
    host: 'claude',
    sessionId,
    auditStatus: 'success',
    proposedToolIds,
    requestText: proposedToolIds.length > 0 ? `request ${observationId}` : undefined,
    observerContextStatus: proposedToolIds.length > 0 ? 'context_unavailable' : 'not_requested',
  };
}

function recordAndClose(store, observationId, proposedToolIds, usedToolIds, recordedAtMs) {
  store.recordTurn(baseTurn(observationId, `session-${observationId}`, recordedAtMs, proposedToolIds));
  store.closeTurn({ observationId, usedToolIds, completedAtMs: recordedAtMs + 1 });
}

function recordOpen(store, observationId, sessionId, recordedAtMs, proposedToolIds) {
  store.recordTurn(baseTurn(observationId, sessionId, recordedAtMs, proposedToolIds));
}
