import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { createHubServer } from '../src/dashboard/hub-server.mjs';

test('GET / and /devices/ probe every configured device once and render online/offline status', async (t) => {
  let onlineHealthRequests = 0;
  let offlineHealthRequests = 0;
  const online = await listen(http.createServer((request, response) => {
    if (request.url === '/_spotter/health') onlineHealthRequests += 1;
    response.writeHead(200).end('ok');
  }));
  const offline = await listen(http.createServer((request) => {
    if (request.url === '/_spotter/health') offlineHealthRequests += 1;
    // Intentionally leave the response open: the hub must bound this probe.
  }));
  const hub = await listen(createHubServer({
    devices: [
      { id: 'mac', name: 'Mac', upstream: online.url },
      { id: 'fox-windows', name: 'FOX Windows native', upstream: offline.url },
    ],
    probeTimeoutMs: 40,
  }));
  t.after(() => closeAll(hub.server, online.server, offline.server));

  const root = await fetch(`${hub.url}/`);
  const rootHtml = await root.text();
  assert.equal(root.status, 200);
  assert.match(rootHtml, /Mac<small>online<\/small>/);
  assert.match(rootHtml, /FOX Windows native<small>offline<\/small>/);
  assert.match(rootHtml, /href="\/devices\/mac\/"/);
  assert.equal(onlineHealthRequests, 1);
  assert.equal(offlineHealthRequests, 1);

  const devices = await fetch(`${hub.url}/devices/`);
  assert.equal(devices.status, 200);
  assert.match(await devices.text(), /Mac<small>online<\/small>/);
  assert.equal(onlineHealthRequests, 2);
  assert.equal(offlineHealthRequests, 2);
});

test('device route proxies the identical path/query and strips hop-by-hop headers both ways', async (t) => {
  let received;
  const upstream = await listen(http.createServer((request, response) => {
    received = { url: request.url, method: request.method, headers: request.headers };
    response.writeHead(207, {
      connection: 'x-upstream-private',
      'content-type': 'application/json',
      'x-visible': 'yes',
      'x-upstream-private': 'must-not-pass',
    });
    response.end(JSON.stringify({ proxied: true }));
  }));
  const hub = await listen(createHubServer({
    devices: [{ id: 'mac', name: 'Mac', upstream: upstream.url }],
  }));
  t.after(() => closeAll(hub.server, upstream.server));

  const result = await request(`${hub.url}/devices/mac/cases?project=%2Fwork%2Fapp&limit=5`, {
    connection: 'x-client-private',
    'x-client-private': 'must-not-pass',
    'x-visible': 'yes',
  });

  assert.equal(result.statusCode, 207);
  assert.deepEqual(JSON.parse(result.body), { proxied: true });
  assert.equal(result.headers['x-visible'], 'yes');
  assert.equal(result.headers['x-upstream-private'], undefined);
  assert.equal(received.method, 'GET');
  assert.equal(received.url, '/devices/mac/cases?project=%2Fwork%2Fapp&limit=5');
  assert.equal(received.headers['x-visible'], 'yes');
  assert.equal(received.headers['x-client-private'], undefined);
  assert.equal(received.headers.host, new URL(upstream.url).host);
});

test('an unavailable device returns only that proxy request as 502 and unknown routes return 404', async (t) => {
  const online = await listen(http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' }).end(`online:${request.url}`);
  }));
  const unavailable = await unavailableOrigin();
  const hub = await listen(createHubServer({
    devices: [
      { id: 'online', name: 'Online', upstream: online.url },
      { id: 'offline', name: 'Offline', upstream: unavailable },
    ],
    proxyTimeoutMs: 200,
  }));
  t.after(() => closeAll(hub.server, online.server));

  const failed = await fetch(`${hub.url}/devices/offline/`);
  assert.equal(failed.status, 502);
  assert.equal(await failed.text(), 'Bad Gateway\n');

  const healthy = await fetch(`${hub.url}/devices/online/overview?from=2026-08-01`);
  assert.equal(healthy.status, 200);
  assert.equal(await healthy.text(), 'online:/devices/online/overview?from=2026-08-01');

  assert.equal((await fetch(`${hub.url}/devices/unknown/`)).status, 404);
  assert.equal((await fetch(`${hub.url}/unknown`)).status, 404);
});

test('invalid static device configuration fails before the server starts', () => {
  assert.throws(
    () => createHubServer({ devices: [{ id: 'duplicate', name: 'One', upstream: 'http://127.0.0.1:1' }, { id: 'duplicate', name: 'Two', upstream: 'http://127.0.0.1:2' }] }),
    /duplicate device id/,
  );
  assert.throws(
    () => createHubServer({ devices: [{ id: 'bad/id', name: 'Bad', upstream: 'http://127.0.0.1:1' }] }),
    /path segment/,
  );
});

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}` };
}

async function unavailableOrigin() {
  const temporary = await listen(http.createServer());
  await new Promise((resolve, reject) => temporary.server.close((error) => (error ? reject(error) : resolve())));
  return temporary.url;
}

function request(url, headers) {
  return new Promise((resolve, reject) => {
    const outgoing = http.get(url, { headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    outgoing.on('error', reject);
  });
}

function closeAll(...servers) {
  return Promise.all(servers.map((server) => new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  })));
}
