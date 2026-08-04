import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { createEvaluationStore } from '../src/core/evaluation-store.mjs';

const STORE_MODULE_URL = new URL('../src/core/evaluation-store.mjs', import.meta.url).href;

test('evaluation store cold-starts one new SQLite database from two workers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'spotter-evaluation-cold-concurrency-'));

  try {
    for (let round = 0; round < 12; round += 1) {
      const databasePath = join(directory, `evaluation-${round}.db`);
      const startGate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
      const alpha = startColdWriter({
        databasePath,
        projectPath: `/projects/alpha-${round}`,
        observationId: `alpha-${round}`,
        startGate,
      });
      const beta = startColdWriter({
        databasePath,
        projectPath: `/projects/beta-${round}`,
        observationId: `beta-${round}`,
        startGate,
      });
      await Promise.all([alpha.ready, beta.ready]);

      const gate = new Int32Array(startGate);
      Atomics.store(gate, 0, 1);
      Atomics.notify(gate, 0, 2);
      await Promise.all([alpha.completed, beta.completed]);
      // Windows/Node 22.13 can deliver the final message before the worker thread has released
      // its SQLite file handle. Wait for actual worker exit before this fixture is removed.
      await Promise.all([alpha.exited, beta.exited]);

      const store = createEvaluationStore({ databasePath });
      try {
        assert.deepEqual(store.summarize().byProject, {
          [`/projects/alpha-${round}`]: {
            S: 1, P: 0, I: 0, C: 0, A: 0, M: 0,
            proposalRate: 0, toolAdoptionRate: null,
          },
          [`/projects/beta-${round}`]: {
            S: 1, P: 0, I: 0, C: 0, A: 0, M: 0,
            proposalRate: 0, toolAdoptionRate: null,
          },
        });
      } finally {
        store.close();
      }
    }
  } finally {
    // Windows/Node 22.13ではworker終了後もSQLite file handleの解放が遅れることがある。
    // 既に要求したfixture削除の完了だけを待ち、product operation自体は再試行しない。
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function startColdWriter(workerData) {
  const worker = new Worker(`(${writeOneColdTurn.toString()})()`, {
    eval: true,
    workerData: { ...workerData, storeModuleUrl: STORE_MODULE_URL },
  });
  let resolveReady;
  let rejectReady;
  let resolveCompleted;
  let rejectCompleted;
  let resolveExited;
  let rejectExited;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const completed = new Promise((resolve, reject) => { resolveCompleted = resolve; rejectCompleted = reject; });
  const exited = new Promise((resolve, reject) => { resolveExited = resolve; rejectExited = reject; });
  worker.on('message', (message) => {
    if (message?.ready) resolveReady();
    else if (message?.ok) resolveCompleted();
    else {
      const error = new Error(message?.error ?? 'cold evaluation writer failed');
      rejectReady(error);
      rejectCompleted(error);
    }
  });
  worker.once('error', (error) => {
    rejectReady(error);
    rejectCompleted(error);
    rejectExited(error);
  });
  worker.once('exit', (code) => {
    if (code !== 0) {
      const error = new Error(`cold evaluation writer exited with code ${code}`);
      rejectReady(error);
      rejectCompleted(error);
      rejectExited(error);
    } else {
      resolveExited();
    }
  });
  return { ready, completed, exited };
}

async function writeOneColdTurn() {
  const { parentPort, workerData } = require('node:worker_threads');
  try {
    parentPort.postMessage({ ready: true });
    const gate = new Int32Array(workerData.startGate);
    const deadline = Date.now() + 5_000;
    while (Atomics.load(gate, 0) === 0) {
      if (Date.now() >= deadline) throw new Error('cold writer start gate timed out');
      Atomics.wait(gate, 0, 0, 100);
    }

    const { createEvaluationStore: openStore } = await import(workerData.storeModuleUrl);
    const store = openStore({ databasePath: workerData.databasePath });
    try {
      store.recordTurn({
        observationId: workerData.observationId,
        recordedAtMs: 10_000,
        proposedAtMs: 10_000,
        projectPath: workerData.projectPath,
        host: 'codex',
        sessionId: workerData.observationId,
        auditStatus: 'success',
        proposedToolIds: [],
      });
      store.closeTurn({ observationId: workerData.observationId, completedAtMs: 20_000 });
    } finally {
      store.close();
    }
    parentPort.postMessage({ ok: true });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: error?.stack ?? String(error) });
  }
}
