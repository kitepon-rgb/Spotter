import { createServer } from 'node:http';
import { createEvaluationStore, defaultEvaluationStorePath } from '../core/evaluation-store.mjs';
import { buildDashboardModel } from './model.mjs';
import { renderDeviceDashboard } from './render.mjs';

const FILTER_NAMES = new Set(['project', 'from', 'to']);

export function createDeviceServer({
  deviceId,
  deviceName = deviceId,
  databasePath = defaultEvaluationStorePath(),
  createStoreFn = createEvaluationStore,
  onError = (error) => console.error('Spotter device server request failed:', error),
} = {}) {
  const id = requiredString(deviceId, 'deviceId');
  const name = requiredString(deviceName, 'deviceName');
  if (typeof createStoreFn !== 'function') throw new TypeError('createStoreFn must be a function');
  if (typeof onError !== 'function') throw new TypeError('onError must be a function');

  return createServer((request, response) => {
    try {
      handleRequest({ request, response, deviceId: id, deviceName: name, databasePath, createStoreFn });
    } catch (error) {
      if (!(error instanceof HttpError) || error.statusCode >= 500) onError(error);
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const httpError = error instanceof HttpError
        ? error
        : new HttpError(500, 'internal_error', 'device request failed', { cause: error });
      sendJson(response, httpError.statusCode, { error: httpError.code, message: httpError.publicMessage }, httpError.headers);
    }
  });
}

function handleRequest({ request, response, deviceId, deviceName, databasePath, createStoreFn }) {
  if (request.method !== 'GET') {
    throw new HttpError(405, 'method_not_allowed', 'only GET is supported', { headers: { Allow: 'GET' } });
  }

  let url;
  try {
    url = new URL(request.url ?? '/', 'http://spotter.local');
  } catch (error) {
    throw new HttpError(400, 'invalid_url', 'request URL is invalid', { cause: error });
  }

  if (url.pathname === '/_spotter/health') {
    if (url.search !== '') throw badRequest('health endpoint does not accept query parameters');
    sendJson(response, 200, { ok: true, deviceId });
    return;
  }

  const route = matchDeviceRoute(url.pathname);
  if (route === null || route.deviceId !== deviceId) throw notFound();
  const parsedFilters = parseFilters(url.searchParams);
  const overviewPath = `/devices/${encodeURIComponent(deviceId)}/`;

  let projection;
  try {
    projection = withStore({ createStoreFn, databasePath }, (store) => {
      const model = buildDashboardModel(store, parsedFilters.store);
      return {
        model: {
          ...model,
          notAdoptedCases: model.notAdoptedCases.map((item) => ({
            ...item,
            href: caseHref(deviceId, item.observationId, parsedFilters.display),
          })),
        },
        caseDetail: route.observationId === null ? null : store.getCase(route.observationId),
      };
    });
  } catch (error) {
    throw new HttpError(500, 'evaluation_store_error', 'evaluation store request failed', { cause: error });
  }

  if (route.observationId !== null && projection.caseDetail === null) throw notFound('evaluation case was not found');
  const html = renderDeviceDashboard({
    devices: [{ id: deviceId, name: deviceName, online: true, href: overviewPath }],
    selectedDeviceId: deviceId,
    model: projection.model,
    caseDetail: projection.caseDetail,
    filters: parsedFilters.display,
    action: overviewPath,
  });
  sendHtml(response, 200, html);
}

function withStore({ createStoreFn, databasePath }, operation) {
  const store = createStoreFn({ databasePath });
  try {
    return operation(store);
  } finally {
    store.close();
  }
}

function matchDeviceRoute(pathname) {
  const overview = /^\/devices\/([^/]+)\/$/.exec(pathname);
  if (overview) return { deviceId: decodePathSegment(overview[1]), observationId: null };
  const detail = /^\/devices\/([^/]+)\/cases\/([^/]+)$/.exec(pathname);
  if (detail) {
    return {
      deviceId: decodePathSegment(detail[1]),
      observationId: decodePathSegment(detail[2]),
    };
  }
  return null;
}

function decodePathSegment(value) {
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.length === 0) throw new Error('empty path segment');
    return decoded;
  } catch (error) {
    throw new HttpError(400, 'invalid_path', 'path contains invalid encoding', { cause: error });
  }
}

function parseFilters(searchParams) {
  for (const name of searchParams.keys()) {
    if (!FILTER_NAMES.has(name)) throw badRequest(`unknown query parameter: ${name}`);
  }

  const display = {};
  const store = {};
  const project = singleValue(searchParams, 'project');
  const from = singleValue(searchParams, 'from');
  const to = singleValue(searchParams, 'to');
  if (project !== null) {
    if (project.length === 0) throw badRequest('project must not be empty');
    display.project = project;
    store.projectPath = project;
  }
  if (from !== null) {
    display.from = from;
    store.fromMs = parseTimestamp(from, 'from');
  }
  if (to !== null) {
    display.to = to;
    store.toMs = parseTimestamp(to, 'to');
  }
  if (store.fromMs !== undefined && store.toMs !== undefined && store.fromMs > store.toMs) {
    throw badRequest('from must not be later than to');
  }
  return { display, store };
}

function singleValue(searchParams, name) {
  const values = searchParams.getAll(name);
  if (values.length > 1) throw badRequest(`${name} must be specified once`);
  return values.length === 0 ? null : values[0];
}

function parseTimestamp(value, name) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw badRequest(`${name} must be an ISO timestamp`);
  return milliseconds;
}

function caseHref(deviceId, observationId, displayFilters) {
  const path = `/devices/${encodeURIComponent(deviceId)}/cases/${encodeURIComponent(observationId)}`;
  const query = new URLSearchParams(displayFilters).toString();
  return query.length === 0 ? path : `${path}?${query}`;
}

function sendHtml(response, statusCode, html) {
  const body = Buffer.from(html, 'utf8');
  response.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

function sendJson(response, statusCode, value, extraHeaders = {}) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  response.end(body);
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function badRequest(message) {
  return new HttpError(400, 'invalid_request', message);
}

function notFound(message = 'route was not found') {
  return new HttpError(404, 'not_found', message);
}

class HttpError extends Error {
  constructor(statusCode, code, publicMessage, { cause, headers = {} } = {}) {
    super(publicMessage, { cause });
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.publicMessage = publicMessage;
    this.headers = headers;
  }
}
