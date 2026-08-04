import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { createDeviceServer } from '../dashboard/device-server.mjs';
import { createHubServer } from '../dashboard/hub-server.mjs';

const USAGE = `spotter dashboard — local evaluation dashboard servers

Usage:
  spotter dashboard device --id ID [--name NAME] [--host HOST] [--port PORT] [--db PATH]
  spotter dashboard hub --config FILE [--host HOST] [--port PORT]
`;

export async function runDashboardCommand({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  createDeviceServerFn = createDeviceServer,
  createHubServerFn = createHubServer,
  readFileFn = readFile,
  writeOutput = (text) => process.stdout.write(text),
} = {}) {
  const subcommand = argv[0];
  if (subcommand === 'device') {
    const options = parseOptions(argv.slice(1), { mode: 'device', cwd });
    const server = createDeviceServerFn({
      deviceId: options.id,
      deviceName: options.name ?? options.id,
      databasePath: options.databasePath,
    });
    await listen(server, options.port, options.host);
    writeOutput(`spotter dashboard device listening on ${formatAddress(server.address())}\n`);
    return server;
  }
  if (subcommand === 'hub') {
    const options = parseOptions(argv.slice(1), { mode: 'hub', cwd });
    const config = parseHubConfig(await readFileFn(options.configPath, 'utf8'));
    const server = createHubServerFn({ devices: config.devices });
    await listen(server, options.port, options.host);
    writeOutput(`spotter dashboard hub listening on ${formatAddress(server.address())}\n`);
    return server;
  }
  throw usageError();
}

function parseOptions(argv, { mode, cwd }) {
  const values = { host: '127.0.0.1', port: 53940 };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (seen.has(option)) throw usageError();
    seen.add(option);
    if (option === '--id' && mode === 'device') values.id = requiredValue(argv, ++index, option);
    else if (option === '--name' && mode === 'device') values.name = requiredValue(argv, ++index, option);
    else if (option === '--db' && mode === 'device') {
      const value = requiredValue(argv, ++index, option);
      values.databasePath = isAbsolute(value) ? value : resolve(cwd, value);
    } else if (option === '--config' && mode === 'hub') {
      const value = requiredValue(argv, ++index, option);
      values.configPath = isAbsolute(value) ? value : resolve(cwd, value);
    } else if (option === '--host') {
      values.host = requiredValue(argv, ++index, option);
    } else if (option === '--port') {
      values.port = parsePort(requiredValue(argv, ++index, option));
    } else throw usageError();
  }
  if (mode === 'device' && values.id === undefined) throw usageError('--id is required');
  if (mode === 'device' && /[/?#]/.test(values.id)) throw usageError('--id must be a path segment');
  if (mode === 'hub' && values.configPath === undefined) throw usageError('--config is required');
  return values;
}

function parseHubConfig(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw usageError('dashboard hub config is not valid JSON'); }
  if (!value || !Array.isArray(value.devices) || value.devices.length === 0) {
    throw usageError('dashboard hub config requires devices');
  }
  const ids = new Set();
  for (const device of value.devices) {
    if (!device || typeof device.id !== 'string' || device.id.length === 0
      || typeof device.name !== 'string' || device.name.length === 0
      || typeof device.upstream !== 'string' || device.upstream.length === 0
      || ids.has(device.id)) throw usageError('dashboard hub config has an invalid device');
    let upstream;
    try { upstream = new URL(device.upstream); } catch { throw usageError('dashboard hub config has an invalid upstream'); }
    if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') {
      throw usageError('dashboard hub config has an invalid upstream');
    }
    ids.add(device.id);
  }
  return value;
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
    throw usageError(`${option} requires a value`);
  }
  return value;
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw usageError('--port requires an integer from 1 to 65535');
  return port;
}

function listen(server, port, host) {
  return new Promise((resolveListen, reject) => {
    const onError = (error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolveListen(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function formatAddress(address) {
  if (typeof address === 'string') return address;
  if (!address) return '(unknown)';
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return `http://${host}:${address.port}`;
}

function usageError(message = 'invalid dashboard arguments') {
  const error = new Error(`${message}\n${USAGE}`);
  error.stack = '';
  error.exitCode = 2;
  return error;
}
