import http from 'node:http';
import https from 'node:https';

import { renderHubDashboard } from './render.mjs';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const DEFAULT_PROBE_TIMEOUT_MS = 1_500;
const DEFAULT_PROXY_TIMEOUT_MS = 30_000;

/**
 * Create the main-server hub for device-routed dashboard requests.
 *
 * `devices` is static for the lifetime of the server. Health is deliberately
 * sampled only while rendering the device list; no background monitor or retry
 * path exists here.
 */
export function createHubServer({
  devices,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  fetchFn = fetch,
  proxyTimeoutMs = DEFAULT_PROXY_TIMEOUT_MS,
  onError = (error) => console.error('Spotter hub server request failed:', error),
} = {}) {
  const configuredDevices = normalizeDevices(devices);
  const byId = new Map(configuredDevices.map((device) => [device.id, device]));
  assertPositiveTimeout(probeTimeoutMs, 'probeTimeoutMs');
  assertPositiveTimeout(proxyTimeoutMs, 'proxyTimeoutMs');
  if (typeof fetchFn !== 'function') throw new TypeError('fetchFn must be a function');
  if (typeof onError !== 'function') throw new TypeError('onError must be a function');

  return http.createServer((request, response) => {
    handleRequest({
      request,
      response,
      devices: configuredDevices,
      byId,
      probeTimeoutMs,
      fetchFn,
      proxyTimeoutMs,
    }).catch((error) => {
      onError(error);
      if (response.headersSent) {
        response.destroy();
        return;
      }
      sendText(response, 500, 'Internal Server Error\n');
    });
  });
}

async function handleRequest({ request, response, devices, byId, probeTimeoutMs, fetchFn, proxyTimeoutMs }) {
  if (request.method !== 'GET') {
    sendText(response, 404, 'Not Found\n');
    return;
  }

  const requestUrl = new URL(request.url ?? '/', 'http://spotter.invalid');
  if (requestUrl.pathname === '/' || requestUrl.pathname === '/devices/') {
    const statuses = await Promise.all(devices.map(async (device) => ({
      id: device.id,
      name: device.name,
      href: `/devices/${encodeURIComponent(device.id)}/`,
      online: await probeDevice(device, probeTimeoutMs, fetchFn),
    })));
    const html = renderHubDashboard({ devices: statuses });
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8',
    });
    response.end(html);
    return;
  }

  const deviceId = deviceIdFromPath(requestUrl.pathname);
  const device = deviceId === null ? null : byId.get(deviceId);
  if (!device) {
    sendText(response, 404, 'Not Found\n');
    return;
  }

  proxyGet({ request, response, requestUrl, device, timeoutMs: proxyTimeoutMs });
}

async function probeDevice(device, timeoutMs, fetchFn) {
  try {
    const response = await fetchFn(new URL('/_spotter/health', device.upstream), {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

function proxyGet({ request, response, requestUrl, device, timeoutMs }) {
  const target = new URL(`${requestUrl.pathname}${requestUrl.search}`, device.upstream);
  const headers = withoutHopByHopHeaders(request.headers);
  delete headers['content-length'];
  headers.host = target.host;

  const upstreamRequest = clientFor(target).request(target, {
    method: 'GET',
    headers,
    agent: false,
  }, (upstreamResponse) => {
    upstreamResponse.on('error', () => {
      if (response.headersSent) response.destroy();
      else sendText(response, 502, 'Bad Gateway\n');
    });
    response.writeHead(
      upstreamResponse.statusCode ?? 502,
      withoutHopByHopHeaders(upstreamResponse.headers),
    );
    upstreamResponse.pipe(response);
  });

  upstreamRequest.setTimeout(timeoutMs, () => {
    upstreamRequest.destroy(new Error('device proxy request timed out'));
  });
  upstreamRequest.on('error', () => {
    if (response.headersSent) response.destroy();
    else sendText(response, 502, 'Bad Gateway\n');
  });
  response.on('close', () => {
    if (!upstreamRequest.destroyed) upstreamRequest.destroy();
  });
  upstreamRequest.end();
}

function withoutHopByHopHeaders(headers) {
  const connectionTokens = String(headers.connection ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const excluded = new Set([...HOP_BY_HOP_HEADERS, ...connectionTokens]);
  return Object.fromEntries(
    Object.entries(headers).filter(([name, value]) => (
      value !== undefined && !excluded.has(name.toLowerCase())
    )),
  );
}

function deviceIdFromPath(pathname) {
  const match = /^\/devices\/([^/]+)(?:\/.*)?$/.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function normalizeDevices(devices) {
  if (!Array.isArray(devices)) throw new TypeError('devices must be an array');
  const ids = new Set();
  return devices.map((device, index) => {
    if (!device || typeof device !== 'object') {
      throw new TypeError(`devices[${index}] must be an object`);
    }
    const { id, name, upstream } = device;
    if (typeof id !== 'string' || id.length === 0 || /[/?#]/.test(id)) {
      throw new TypeError(`devices[${index}].id must be a non-empty path segment`);
    }
    if (ids.has(id)) throw new TypeError(`duplicate device id: ${id}`);
    ids.add(id);
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError(`devices[${index}].name must be a non-empty string`);
    }

    let upstreamUrl;
    try {
      upstreamUrl = new URL(upstream);
    } catch {
      throw new TypeError(`devices[${index}].upstream must be an absolute HTTP URL`);
    }
    if (!['http:', 'https:'].includes(upstreamUrl.protocol)
        || upstreamUrl.username || upstreamUrl.password
        || upstreamUrl.pathname !== '/' || upstreamUrl.search || upstreamUrl.hash) {
      throw new TypeError(`devices[${index}].upstream must be an HTTP origin URL`);
    }
    return Object.freeze({ id, name, upstream: upstreamUrl });
  });
}

function clientFor(url) {
  return url.protocol === 'https:' ? https : http;
}

function assertPositiveTimeout(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive number`);
  }
}

function sendText(response, statusCode, body) {
  response.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
  });
  response.end(body);
}
