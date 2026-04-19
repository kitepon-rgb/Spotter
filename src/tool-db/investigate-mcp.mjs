// MCP investigation: spawn an MCP server, JSON-RPC over stdio, call tools/list, return
// {<tool name> -> <description>} map.
//
// MCP wire format: line-delimited JSON-RPC 2.0 messages on stdin/stdout.
// Required handshake:
//   1. → initialize          (request)
//   2. ← initialize result   (response)
//   3. → notifications/initialized (notification, no response)
//   4. → tools/list          (request)
//   5. ← tools/list result   (response with tools[] each having {name, description})

import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const PROTOCOL_VERSION = '2025-03-26'; // MCP protocol version we claim to speak.
const HANDSHAKE_TIMEOUT_MS = 10_000;

export class McpInvestigationError extends Error {
  constructor(message, server) {
    super(message);
    this.name = 'McpInvestigationError';
    this.server = server;
  }
}

// Returns: Map<server-name, Array<{name, description}>>.
// Skips servers that fail (logs the failure) so one broken server doesn't block the rest.
export async function listMcpToolsAll({ logFn = () => {}, claudeBin = 'claude' } = {}) {
  const servers = await listMcpServers({ claudeBin });
  const out = new Map();
  for (const server of servers) {
    try {
      const tools = await listMcpToolsOne({ server, logFn });
      out.set(server.name, tools);
    } catch (err) {
      logFn(`mcp investigate failed for "${server.name}": ${err.message}`);
    }
  }
  return out;
}

// Parse `claude mcp list` output. Returns array of {name, transport, command, url}.
// stdio servers have command, http/sse servers have url.
export async function listMcpServers({ claudeBin = 'claude' } = {}) {
  const { stdout } = await execFileP(claudeBin, ['mcp', 'list'], { encoding: 'utf8' });
  return parseMcpListOutput(stdout);
}

// `claude mcp list` output lines look like:
//   "<name>: <url> - <status>"
//   "<name>: <url> (HTTP) - <status>"
//   "<name>: <command> <args...> - <status>"
// We don't need full parsing — we just need the name and to know if it's an HTTP url
// or a stdio command. For stdio we will re-query `claude mcp get <name>` for proper args.
export function parseMcpListOutput(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('Checking') || trimmed.startsWith('Note:')) continue;
    // Format: "<name>: <rest>"
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx <= 0) continue;
    const name = trimmed.slice(0, colonIdx).trim();
    const rest = trimmed.slice(colonIdx + 1).trim();
    // skip the trailing " - ✓ Connected" / " - ✗ Failed"
    const dashIdx = rest.lastIndexOf(' - ');
    const beforeStatus = dashIdx > 0 ? rest.slice(0, dashIdx).trim() : rest;
    if (beforeStatus.startsWith('http://') || beforeStatus.startsWith('https://')) {
      const isHttp = /\(HTTP\)$/.test(beforeStatus);
      const url = beforeStatus.replace(/\s*\(HTTP\)$/, '').trim();
      out.push({ name, transport: isHttp ? 'http' : 'sse', url });
    } else {
      // stdio — defer to `claude mcp get` for properly-tokenized command/args.
      out.push({ name, transport: 'stdio' });
    }
  }
  return out;
}

// Fetch tools/list from a single MCP server. HTTP/SSE servers are not yet supported here
// (we'd need to speak the HTTP+SSE MCP transport); we throw so the caller can log+skip.
export async function listMcpToolsOne({ server, logFn = () => {}, claudeBin = 'claude' }) {
  if (server.transport === 'stdio') {
    const config = await getStdioConfig({ name: server.name, claudeBin });
    return spawnAndQuery(config, server.name);
  }
  if (server.transport === 'http' || server.transport === 'sse') {
    throw new McpInvestigationError(
      `${server.transport} transport not yet supported (need HTTP MCP client)`,
      server.name
    );
  }
  throw new McpInvestigationError(`unknown transport: ${server.transport}`, server.name);
}

// Parse `claude mcp get <name>` to extract Command + Args for stdio servers.
async function getStdioConfig({ name, claudeBin }) {
  const { stdout } = await execFileP(claudeBin, ['mcp', 'get', name], { encoding: 'utf8' });
  let command = null;
  let argsRaw = null;
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('Command:')) command = line.slice('Command:'.length).trim();
    else if (line.startsWith('Args:')) argsRaw = line.slice('Args:'.length).trim();
  }
  if (!command) throw new McpInvestigationError(`no Command in mcp get output for "${name}"`, name);
  const args = argsRaw && argsRaw.length > 0 ? splitArgs(argsRaw) : [];
  return { command, args };
}

// Naive argv tokenizer: splits on spaces, no quote handling. The MCP commands we see
// (node + a single .js path + flags) don't need quoting. If a future server has spaces
// in paths, we'd need a proper shell-like tokenizer.
function splitArgs(s) {
  return s.split(/\s+/).filter((t) => t.length > 0);
}

async function spawnAndQuery({ command, args }, serverName) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let buffer = '';
    let nextId = 1;
    const pending = new Map(); // id → {resolve, reject}
    let settled = false;
    let initializedSent = false;

    const cleanup = () => {
      try { child.stdin.end(); } catch { /* ignore */ }
      try { child.kill(); } catch { /* ignore */ }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new McpInvestigationError(`handshake/list timed out after ${HANDSHAKE_TIMEOUT_MS}ms`, serverName));
    }, HANDSHAKE_TIMEOUT_MS);

    const send = (msg) => {
      child.stdin.write(JSON.stringify(msg) + '\n', 'utf8');
    };
    const request = (method, params) => new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { resolve: res, reject: rej });
      send({ jsonrpc: '2.0', id, method, params });
    });

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.length === 0) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // ignore non-JSON noise (some servers emit log lines on stdout)
        }
        if (msg.id !== undefined && pending.has(msg.id)) {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) p.reject(new McpInvestigationError(`server error: ${JSON.stringify(msg.error)}`, serverName));
          else p.resolve(msg.result);
        }
      }
    });

    child.stderr.on('data', () => { /* swallow stderr; we only care about stdout JSON-RPC */ });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new McpInvestigationError(`spawn error: ${err.message}`, serverName));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!initializedSent) {
        reject(new McpInvestigationError(`server exited (code=${code}) before handshake completed`, serverName));
      } else {
        reject(new McpInvestigationError(`server closed unexpectedly (code=${code})`, serverName));
      }
    });

    (async () => {
      try {
        await request('initialize', {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'spotter', version: '0.7.0' },
        });
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        initializedSent = true;
        const result = await request('tools/list', {});
        const tools = (result?.tools ?? []).map((t) => ({
          name: t.name,
          description: typeof t.description === 'string' ? t.description : '',
        }));
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        resolve(tools);
      } catch (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        reject(err);
      }
    })();
  });
}

// Build the Bell-visible name for an MCP tool: `mcp__<server-id>__<tool-name>`.
// server-id is the server name with non-[A-Za-z0-9_-] chars replaced by `_`
// (matches the convention Claude Code uses; e.g. "claude.ai Gmail" → "claude_ai_Gmail").
export function bellVisibleName(serverName, toolName) {
  const id = serverName.replace(/[^A-Za-z0-9_-]/g, '_');
  return `mcp__${id}__${toolName}`;
}
