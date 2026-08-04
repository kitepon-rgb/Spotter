import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEvaluationStore } from '../src/core/evaluation-store.mjs';
import { runEvaluationCommand } from '../src/cli/evaluation-cmd.mjs';

test('evaluation report fixes proposal and adoption denominators across saved observations', async () => {
  const fixture = await createFixture();
  try {
    const output = [];
    const report = await runEvaluationCommand({
      argv: ['report'],
      createStoreFn: () => fixture.store,
      writeOutput: (text) => output.push(text),
    });
    assert.deepEqual(report.totals, {
      S: 10, P: 4, I: 6, C: 5, A: 2, M: 1,
      proposalRate: 0.4, toolAdoptionRate: 0.4,
    });
    assert.match(output.join(''), /proposal rate: 4\/10 = 40%/);
    assert.match(output.join(''), /tool adoption rate: 2\/5 = 40%/);
    assert.match(output.join(''), /S=10 P=4 I=6 C=5 A=2 M=1/);
    assert.equal(report.byProject['/projects/alpha'].S, 5);
    assert.equal(report.byHost.claude.A, 2);
    assert.equal(report.byTool['mcp__tools__alpha'].A, 1);
  } finally { await fixture.cleanup(); }
});

test('evaluation cases filter saved items and case keeps both contexts in separate fields', async () => {
  const fixture = await createFixture();
  try {
    const output = [];
    const cases = await runEvaluationCommand({
      argv: ['cases', '--outcome', 'not_adopted', '--project', '/projects/alpha', '--tool-id', 'mcp__tools__delta', '--json'],
      createStoreFn: () => fixture.store,
      writeOutput: (text) => output.push(text),
    });
    assert.equal(cases.length, 1);
    assert.equal(cases[0].observationId, 'turn-2');
    assert.equal(cases[0].toolId, 'mcp__tools__delta');
    assert.equal(JSON.parse(output.join(''))[0].outcome, 'not_adopted');

    const detailOutput = [];
    const item = await runEvaluationCommand({
      argv: ['case', 'turn-1'],
      createStoreFn: () => fixture.store,
      writeOutput: (text) => detailOutput.push(text),
    });
    assert.equal(item.auditorSeenContext, 'spotter-only context');
    assert.deepEqual(item.observerSnapshot.turns, [{ user: 'older user', assistant: 'older assistant' }]);
    assert.match(detailOutput.join(''), /auditor seen context\n  spotter-only context/);
    assert.match(detailOutput.join(''), /observer snapshot turns \(available\)/);
    assert.match(detailOutput.join(''), /proposal IDs/);
    assert.match(detailOutput.join(''), /used IDs/);
    assert.match(detailOutput.join(''), /item outcomes/);
  } finally { await fixture.cleanup(); }
});

test('evaluation report does not count an active turn as missing outcome', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'spotter-evaluation-open-'));
  const store = createEvaluationStore({ databasePath: join(directory, 'evaluation.db') });
  try {
    store.recordTurn({
      observationId: 'open-turn',
      projectPath: '/projects/open',
      host: 'claude',
      sessionId: 'open-session',
      auditStatus: 'success',
      proposedToolIds: ['mcp__tools__pending'],
      requestText: 'still running',
      observerContextStatus: 'context_unavailable',
    });
    assert.deepEqual(store.summarize().totals, {
      S: 1, P: 1, I: 1, C: 0, A: 0, M: 0,
      proposalRate: 1, toolAdoptionRate: null,
    });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'spotter-evaluation-cli-'));
  const store = createEvaluationStore({ databasePath: join(directory, 'evaluation.db') });
  const close = store.close.bind(store);
  store.close = () => {};
  const base = {
    auditStatus: 'success', host: 'claude', sessionId: 'session-1',
    observerContextStatus: 'available', backend: 'codex-cli', model: 'gpt-5.6-terra', spotterVersion: '1.5.0',
  };
  const record = (id, projectPath, proposedToolIds, recordedAtMs) => store.recordTurn({
    ...base, observationId: id, projectPath, proposedToolIds, recordedAtMs, proposedAtMs: recordedAtMs,
    requestText: proposedToolIds.length ? `request ${id}` : undefined,
    auditorSeenContext: id === 'turn-1' ? 'spotter-only context' : undefined,
    observerSnapshot: id === 'turn-1' ? { turns: [{ user: 'older user', assistant: 'older assistant' }] } : undefined,
  });
  record('turn-1', '/projects/alpha', ['mcp__tools__alpha', 'mcp__tools__beta'], 1_000);
  store.closeTurn({ observationId: 'turn-1', usedToolIds: ['mcp__tools__alpha', 'mcp__tools__alpha'], completedAtMs: 1_010 });
  record('turn-2', '/projects/alpha', ['mcp__tools__gamma', 'mcp__tools__delta'], 2_000);
  store.closeTurn({ observationId: 'turn-2', usedToolIds: ['mcp__tools__gamma'], completedAtMs: 2_010 });
  record('turn-3', '/projects/beta', ['mcp__tools__epsilon'], 3_000);
  store.closeTurn({ observationId: 'turn-3', usedToolIds: [], completedAtMs: 3_010 });
  record('turn-4', '/projects/beta', ['mcp__tools__zeta'], 4_000);
  store.closeTurn({ observationId: 'turn-4', usageStatus: 'incomplete', completedAtMs: 4_010 });
  for (let index = 5; index <= 10; index += 1) {
    record(`turn-${index}`, index % 2 ? '/projects/alpha' : '/projects/beta', [], index * 1_000);
    store.closeTurn({ observationId: `turn-${index}`, usedToolIds: [], completedAtMs: index * 1_000 + 10 });
  }
  return {
    store,
    cleanup: async () => { close(); await rm(directory, { recursive: true, force: true }); },
  };
}
