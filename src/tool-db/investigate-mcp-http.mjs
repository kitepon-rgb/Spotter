// HTTP (Streamable HTTP transport) MCP investigation.
//
// Spec: https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http
// Wire:
//   POST <url> with JSON-RPC body + Content-Type: application/json
//   Accept: application/json, text/event-stream  (server may reply with either)
//   First response may set Mcp-Session-Id; echo it on subsequent requests.
//
// We only need initialize → notifications/initialized → tools/list; the handshake is
// plain request/response, no long-lived SSE stream required.
//
// Auth: `claude mcp get <name>` does NOT expose bearer tokens for user-configured
// servers. If a server requires auth beyond public URL access, investigate will fail
// with a descriptive error — caller logs and skips that server.

const PROTOCOL_VERSION = '2025-03-26';
const REQUEST_TIMEOUT_MS = 10_000;

export class McpHttpError extends Error {
  constructor(message, server) {
    super(message);
    this.name = 'McpHttpError';
    this.server = server;
  }
}

export async function listToolsHttp({ url, serverName, headers: staticHeaders = {} }) {
  let sessionId = null;

  const post = async (body) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        ...staticHeaders,
      };
      if (sessionId) headers['Mcp-Session-Id'] = sessionId;
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      const sid = res.headers.get('mcp-session-id');
      if (sid && !sessionId) sessionId = sid;
      if (!res.ok) {
        throw new McpHttpError(`HTTP ${res.status} ${res.statusText}`, serverName);
      }
      // Response may be application/json or text/event-stream.
      const contentType = res.headers.get('content-type') ?? '';
      if (contentType.includes('text/event-stream')) {
        return parseSseSingle(await res.text(), serverName);
      }
      if (contentType.includes('application/json')) {
        return await res.json();
      }
      // Some servers omit content-type; try JSON.
      const text = await res.text();
      if (text.trim().length === 0) return null;
      try {
        return JSON.parse(text);
      } catch {
        throw new McpHttpError(`unexpected response content-type "${contentType}"`, serverName);
      }
    } finally {
      clearTimeout(t);
    }
  };

  const postNotification = async (body) => {
    // Notifications may return 202 Accepted with empty body; swallow the result.
    await post(body).catch((err) => {
      // Some servers reject notifications with no body response as non-2xx; treat as OK
      // only if the error is clearly a parse issue on empty body.
      if (err instanceof McpHttpError) throw err;
      throw err;
    });
  };

  // 1. initialize
  const initResult = await post({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'spotter', version: '0.10.0' },
    },
  });
  if (!initResult || initResult.error) {
    throw new McpHttpError(`initialize failed: ${JSON.stringify(initResult?.error ?? initResult)}`, serverName);
  }

  // 2. notifications/initialized
  await postNotification({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });

  // 3. tools/list
  const listResult = await post({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  });
  if (!listResult || listResult.error) {
    throw new McpHttpError(`tools/list failed: ${JSON.stringify(listResult?.error ?? listResult)}`, serverName);
  }

  const tools = (listResult.result?.tools ?? []).map((t) => ({
    name: t.name,
    description: typeof t.description === 'string' ? t.description : '',
  }));
  return tools;
}

// SSE responses wrap a single JSON message in one `data:` event. Parse it out.
function parseSseSingle(sseText, serverName) {
  for (const rawLine of sseText.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('data:')) {
      const payload = line.slice('data:'.length).trim();
      if (payload.length === 0) continue;
      try {
        return JSON.parse(payload);
      } catch {
        throw new McpHttpError(`failed to parse SSE data payload`, serverName);
      }
    }
  }
  throw new McpHttpError(`no data event in SSE response`, serverName);
}
