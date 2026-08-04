import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { createEvaluationStore } from '../src/core/evaluation-store.mjs';

const STORE_MODULE_URL = new URL('../src/core/evaluation-store.mjs', import.meta.url).href;

test('evaluation store keeps both projects complete under parallel SQLite writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'spotter-evaluation-concurrency-'));
  const databasePath = join(directory, 'evaluation.db');
  const initializer = createEvaluationStore({ databasePath });
  initializer.close();

  try {
    const startGate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const alphaWriter = startWriter({ databasePath, projectPath: '/projects/alpha', host: 'claude', prefix: 'alpha', startGate });
    await alphaWriter.ready;
    const betaWriter = startWriter({ databasePath, projectPath: '/projects/beta', host: 'codex', prefix: 'beta', startGate });
    await betaWriter.ready;
    const gate = new Int32Array(startGate);
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0, 2);
    await Promise.all([alphaWriter.completed, betaWriter.completed]);

    const store = createEvaluationStore({ databasePath });
    try {
      const report = store.summarize();
      assert.deepEqual(report.totals, {
        S: 40,
        P: 24,
        I: 48,
        C: 32,
        A: 8,
        M: 16,
        proposalRate: 0.6,
        toolAdoptionRate: 0.25,
      });
      assert.deepEqual(report.byProject['/projects/alpha'], {
        S: 20,
        P: 12,
        I: 24,
        C: 16,
        A: 4,
        M: 8,
        proposalRate: 0.6,
        toolAdoptionRate: 0.25,
      });
      assert.deepEqual(report.byProject['/projects/beta'], report.byProject['/projects/alpha']);
      assert.equal(report.totals.I, report.totals.C + report.totals.M);
      assert.ok(report.totals.A <= report.totals.C);
      assert.ok(report.totals.P <= report.totals.S);
      assert.equal(store.listCases({ outcome: 'adopted' }).length, 8);
      assert.equal(store.listCases({ outcome: 'not_adopted' }).length, 24);
      assert.equal(store.listCases({ outcome: 'outcome_missing' }).length, 16);
    } finally {
      store.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function startWriter(workerData) {
  const worker = new Worker(`(${writeProjectRows.toString()})()`, {
    eval: true,
    workerData: { ...workerData, storeModuleUrl: STORE_MODULE_URL },
  });
  let resolveReady;
  let rejectReady;
  let resolveCompleted;
  let rejectCompleted;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const completed = new Promise((resolve, reject) => { resolveCompleted = resolve; rejectCompleted = reject; });
  worker.on('message', (message) => {
    if (message?.ready) resolveReady();
    else if (message?.ok) resolveCompleted();
    else {
      const error = new Error(message?.error ?? 'evaluation writer failed');
      rejectReady(error);
      rejectCompleted(error);
    }
  });
  worker.once('error', (error) => {
    rejectReady(error);
    rejectCompleted(error);
  });
  worker.once('exit', (code) => {
    if (code !== 0) {
      const error = new Error(`evaluation writer exited with code ${code}`);
      rejectReady(error);
      rejectCompleted(error);
    }
  });
  return { ready, completed };
}

async function writeProjectRows() {
  const { parentPort, workerData } = require('node:worker_threads');
  try {
    const { createEvaluationStore: openStore } = await import(workerData.storeModuleUrl);
    const store = openStore({ databasePath: workerData.databasePath, busyTimeoutMs: 10_000 });
    const gate = new Int32Array(workerData.startGate);
    parentPort.postMessage({ ready: true });
    const deadline = Date.now() + 5_000;
    while (Atomics.load(gate, 0) === 0) {
      if (Date.now() >= deadline) throw new Error('parallel writer start gate timed out');
      Atomics.wait(gate, 0, 0, 100);
    }

    try {
      for (let index = 0; index < 20; index += 1) {
        const observationId = `${workerData.prefix}-turn-${index}`;
        const proposedToolIds = index < 12
          ? [`mcp__${workerData.prefix}__tool_${index}_a`, `mcp__${workerData.prefix}__tool_${index}_b`]
          : [];
        store.recordTurn({
          observationId,
          recordedAtMs: 10_000 + index,
          proposedAtMs: 10_000 + index,
          projectPath: workerData.projectPath,
          host: workerData.host,
          sessionId: `${workerData.prefix}-session-${index}`,
          auditStatus: 'success',
          proposedToolIds,
          requestText: proposedToolIds.length ? `request ${index}` : undefined,
          observerContextStatus: proposedToolIds.length ? 'available' : undefined,
          observerSnapshot: proposedToolIds.length ? { project: workerData.projectPath, index } : undefined,
        });
        if (index < 4) {
          store.recordUsage({ observationId, toolIds: [proposedToolIds[0]] });
          store.closeTurn({ observationId, completedAtMs: 20_000 + index });
        } else if (index < 8) {
          store.closeTurn({ observationId, usedToolIds: [], completedAtMs: 20_000 + index });
        } else if (index < 12) {
          store.markUsageIncomplete({ observationId });
          store.closeTurn({ observationId, completedAtMs: 20_000 + index });
        } else {
          store.closeTurn({ observationId, usedToolIds: [], completedAtMs: 20_000 + index });
        }
      }
    } finally {
      store.close();
    }
    parentPort.postMessage({ ok: true });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: error?.stack ?? String(error) });
  }
}
