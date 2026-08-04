import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import test from 'node:test';
import { runDashboardCommand } from '../src/cli/dashboard-cmd.mjs';

function fakeServer() {
  const server = new EventEmitter();
  server.listen = (port, host) => {
    server.bound = { address: host, family: host.includes(':') ? 'IPv6' : 'IPv4', port };
    queueMicrotask(() => server.emit('listening'));
  };
  server.address = () => server.bound;
  return server;
}

test('device command binds a local server with explicit identity and database', async () => {
  let factoryOptions;
  let output = '';
  const server = await runDashboardCommand({
    argv: ['device', '--id', 'mac', '--name', 'Mac', '--host', '127.0.0.1', '--port', '54000', '--db', 'fixture.db'],
    cwd: '/work',
    createDeviceServerFn(options) { factoryOptions = options; return fakeServer(); },
    writeOutput(text) { output += text; },
  });

  assert.deepEqual(factoryOptions, { deviceId: 'mac', deviceName: 'Mac', databasePath: resolve('/work', 'fixture.db') });
  assert.deepEqual(server.address(), { address: '127.0.0.1', family: 'IPv4', port: 54000 });
  assert.match(output, /dashboard device listening/);
});

test('hub command reads the static device map once and starts the hub server', async () => {
  let readPath;
  let factoryOptions;
  const config = { devices: [
    { id: 'mac', name: 'Mac', upstream: 'http://127.0.0.1:53941' },
    { id: 'fox-wsl', name: 'FOX WSL2', upstream: 'http://127.0.0.1:53942' },
  ] };
  await runDashboardCommand({
    argv: ['hub', '--config', 'hub.json', '--host', '172.18.0.1'],
    cwd: '/work',
    readFileFn: async (path) => { readPath = path; return JSON.stringify(config); },
    createHubServerFn(options) { factoryOptions = options; return fakeServer(); },
    writeOutput() {},
  });

  assert.equal(readPath, resolve('/work', 'hub.json'));
  assert.deepEqual(factoryOptions, config);
});

test('dashboard command rejects missing identity, duplicate options, bad ports, and invalid hub config', async () => {
  const invalid = [
    ['device'],
    ['device', '--id', 'mac', '--id', 'again'],
    ['device', '--id', 'mac', '--host', '127.0.0.1', '--host', '127.0.0.1'],
    ['device', '--id', 'mac', '--port', '53940', '--port', '53940'],
    ['device', '--id', 'not/a-segment'],
    ['device', '--id', 'mac', '--port', '0'],
    ['hub'],
  ];
  for (const argv of invalid) {
    await assert.rejects(runDashboardCommand({ argv, createDeviceServerFn: fakeServer, writeOutput() {} }), /dashboard/);
  }
  await assert.rejects(runDashboardCommand({
    argv: ['hub', '--config', 'hub.json'],
    readFileFn: async () => '{not json',
    writeOutput() {},
  }), /not valid JSON/);
  await assert.rejects(runDashboardCommand({
    argv: ['hub', '--config', 'hub.json'],
    readFileFn: async () => JSON.stringify({ devices: [{ id: 'x', name: 'x', upstream: 'file:///tmp/x' }] }),
    writeOutput() {},
  }), /invalid upstream/);
});
