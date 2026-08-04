import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createEvaluationStore } from '../src/core/evaluation-store.mjs';
import { createDeviceServer } from '../src/dashboard/device-server.mjs';

test('device server serves health, filtered overview links, and case detail from SQLite', async (t) => {
  const fixture = createFixtureDatabase(t);
  let opened = 0;
  let closed = 0;
  const createStoreFn = (options) => {
    opened += 1;
    const store = createEvaluationStore(options);
    const close = store.close.bind(store);
    store.close = () => {
      closed += 1;
      close();
    };
    return store;
  };
  const server = await listen(t, createDeviceServer({
    deviceId: 'mac local',
    deviceName: 'Development Mac',
    databasePath: fixture.databasePath,
    createStoreFn,
  }));

  const health = await fetch(`${server.origin}/_spotter/health`);
  assert.equal(health.status, 200);
  assert.match(health.headers.get('content-type'), /^application\/json/);
  assert.deepEqual(await health.json(), { ok: true, deviceId: 'mac local' });
  assert.equal(opened, 0);

  const query = new URLSearchParams({
    project: '/projects/alpha',
    from: new Date(fixture.alphaRecordedAtMs - 1).toISOString(),
    to: new Date(fixture.alphaRecordedAtMs + 1).toISOString(),
  });
  const overview = await fetch(`${server.origin}/devices/mac%20local/?${query}`);
  const overviewHtml = await overview.text();
  assert.equal(overview.status, 200);
  assert.match(overview.headers.get('content-type'), /^text\/html/);
  assert.match(overviewHtml, /Development Mac/);
  assert.match(overviewHtml, /href="\/devices\/mac%20local\/"/);
  assert.match(overviewHtml, /対象ターン<\/span><strong>1<\/strong>/);
  assert.match(overviewHtml, /\/projects\/alpha/);
  assert.doesNotMatch(overviewHtml, /\/projects\/beta/);
  assert.match(overviewHtml, /mcp__caveat__search/);
  assert.match(overviewHtml, /href="\/devices\/mac%20local\/cases\/obs-alpha\?project=%2Fprojects%2Falpha&amp;from=/);
  assert.equal(opened, 1);
  assert.equal(closed, 1);

  const detail = await fetch(`${server.origin}/devices/mac%20local/cases/obs-alpha`);
  const detailHtml = await detail.text();
  assert.equal(detail.status, 200);
  assert.match(detailHtml, /case詳細/);
  assert.match(detailHtml, /inspect alpha/);
  assert.match(detailHtml, /auditor-only alpha context/);
  assert.match(detailHtml, /earlier alpha turn/);
  assert.match(detailHtml, /mcp__caveat__search/);
  assert.equal(opened, 2);
  assert.equal(closed, 2);
});

test('device server returns explicit errors without opening the store for rejected routes', async (t) => {
  const fixture = createFixtureDatabase(t);
  let opened = 0;
  const createStoreFn = (options) => {
    opened += 1;
    return createEvaluationStore(options);
  };
  const errors = [];
  const server = await listen(t, createDeviceServer({
    deviceId: 'mac',
    databasePath: fixture.databasePath,
    createStoreFn,
    onError: (error) => errors.push(error),
  }));

  const otherDevice = await fetch(`${server.origin}/devices/windows/`);
  assert.equal(otherDevice.status, 404);
  assert.equal((await otherDevice.json()).error, 'not_found');
  const unknown = await fetch(`${server.origin}/favicon.ico`);
  assert.equal(unknown.status, 404);
  const invalidFilter = await fetch(`${server.origin}/devices/mac/?from=not-a-date`);
  assert.equal(invalidFilter.status, 400);
  assert.match((await invalidFilter.json()).message, /ISO timestamp/);
  const missingCase = await fetch(`${server.origin}/devices/mac/cases/missing`);
  assert.equal(missingCase.status, 404);
  assert.equal(opened, 1);
  assert.deepEqual(errors, []);
});

test('device server exposes store failures as a fixed HTTP 500 error', async (t) => {
  const cause = new Error('private database detail');
  const errors = [];
  const server = await listen(t, createDeviceServer({
    deviceId: 'mac',
    createStoreFn: () => { throw cause; },
    onError: (error) => errors.push(error),
  }));

  const response = await fetch(`${server.origin}/devices/mac/`);
  const body = await response.json();
  assert.equal(response.status, 500);
  assert.deepEqual(body, { error: 'evaluation_store_error', message: 'evaluation store request failed' });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].cause, cause);
});

function createFixtureDatabase(t) {
  const directory = mkdtempSync(join(tmpdir(), 'spotter-dashboard-device-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'evaluation.db');
  const alphaRecordedAtMs = Date.parse('2026-08-04T01:00:00.000Z');
  const store = createEvaluationStore({ databasePath });
  try {
    store.recordTurn({
      observationId: 'obs-alpha',
      recordedAtMs: alphaRecordedAtMs,
      proposedAtMs: alphaRecordedAtMs,
      projectPath: '/projects/alpha',
      host: 'codex',
      sessionId: 'session-alpha',
      auditStatus: 'success',
      requestText: 'inspect alpha',
      auditorSeenContext: 'auditor-only alpha context',
      observerContextStatus: 'available',
      observerSnapshot: { turns: [{ user: 'earlier alpha turn', assistant: 'earlier answer' }] },
      proposedToolIds: ['mcp__caveat__search'],
      backend: 'codex-cli',
      model: 'gpt-5.6-terra',
    });
    store.closeTurn({ observationId: 'obs-alpha', usedToolIds: [], completedAtMs: alphaRecordedAtMs + 100 });
    const betaRecordedAtMs = Date.parse('2026-08-04T02:00:00.000Z');
    store.recordTurn({
      observationId: 'obs-beta',
      recordedAtMs: betaRecordedAtMs,
      proposedAtMs: betaRecordedAtMs,
      projectPath: '/projects/beta',
      host: 'claude',
      sessionId: 'session-beta',
      auditStatus: 'success',
      proposedToolIds: ['mcp__tools__beta'],
    });
    store.closeTurn({ observationId: 'obs-beta', usedToolIds: ['mcp__tools__beta'], completedAtMs: betaRecordedAtMs + 100 });
  } finally {
    store.close();
  }
  return { databasePath, alphaRecordedAtMs };
}

async function listen(t, server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  return { origin: `http://127.0.0.1:${address.port}` };
}
