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
import { listToolsHttp } from './investigate-mcp-http.mjs';
import { readMcpServers, describeServer } from './mcp-config.mjs';

const execFileP = promisify(execFile);

const PROTOCOL_VERSION = '2025-03-26'; // MCP protocol version we claim to speak.
const HANDSHAKE_TIMEOUT_MS = 10_000;

// On Windows, `claude` is a .cmd shim; Node's execFile cannot locate it directly without
// going through cmd.exe. Matches the pattern in src/daemon/haiku-caller.mjs buildSpawnArgs.
// We use cmd.exe /c rather than shell:true to avoid DEP0190 on Node 24+.
// `windowsHide: true` is forced at this layer so every caller (listMcpServers,
// getStdioConfig, etc.) is silent — without it a cmd.exe console window flashes on every
// refresh, and those flashes steal keyboard focus on Windows.
async function execClaude(claudeBin, args, opts) {
  const execOpts = { ...opts, windowsHide: true };
  if (process.platform === 'win32') {
    return execFileP('cmd.exe', ['/c', claudeBin, ...args], execOpts);
  }
  return execFileP(claudeBin, args, execOpts);
}

export class McpInvestigationError extends Error {
  constructor(message, server) {
    super(message);
    this.name = 'McpInvestigationError';
    this.server = server;
  }
}

// Returns: Map<server-name, Array<{name, description}>>.
// Skips servers that fail (logs the failure) so one broken server doesn't block the rest.
export async function listMcpToolsAll({ logFn = () => {}, claudeBin = 'claude', projectRoot } = {}) {
  const servers = await listMcpServers({ claudeBin, projectRoot });
  const out = new Map();
  for (const server of servers) {
    try {
      const tools = await listMcpToolsOne({ server, logFn, claudeBin, projectRoot });
      out.set(server.name, tools);
    } catch (err) {
      logFn(`mcp investigate failed for "${server.name}": ${err.message}`);
    }
  }
  return out;
}

// Returns the list of MCP servers to investigate. Merges two sources:
//   - `claude mcp list` — authoritative for *which* servers exist in this session
//     (covers all scopes: user, project, local, enterprise)
//   - `~/.claude/.mcp.json` — authoritative for transport details + auth secrets
//     (stdio env, http headers). The CLI hides these on purpose.
//
// For each server named by the CLI, if `.mcp.json` has a matching entry we use that
// full descriptor (with env/headers). Otherwise we fall back to the parsed CLI line,
// which at minimum gives us name + transport + url (or triggers `claude mcp get` for
// stdio command tokenisation).
//
// We pass `cwd: projectRoot` to the CLI so its project-scope walk-up lands in the same
// directory we read `.mcp.json` from. Without this, `claude` walks up from the parent
// process's cwd and can resolve a different project than `readMcpServers` does.
export async function listMcpServers({ claudeBin = 'claude', projectRoot } = {}) {
  const execOpts = { encoding: 'utf8' };
  if (projectRoot) execOpts.cwd = projectRoot;
  const [{ stdout }, mcpServers] = await Promise.all([
    execClaude(claudeBin, ['mcp', 'list'], execOpts),
    readMcpServers({ projectRoot }),
  ]);
  const cliList = parseMcpListOutput(stdout);
  return cliList.map((cliEntry) => {
    const configEntry = mcpServers[cliEntry.name];
    if (configEntry) {
      const described = describeServer(cliEntry.name, configEntry);
      if (described) return described;
    }
    return cliEntry;
  });
}

// `claude mcp list` output lines look like:
//   "<name>: <url> - <status>"
//   "<name>: <url> (HTTP) - <status>"
//   "<name>: <command> <args...> - <status>"
// We don't need full parsing — we just need the name and to know if it's an HTTP url
// or a stdio command. For stdio we will re-query `claude mcp get <name>` for proper args.
//
// Splitter: ": " (colon + SPACE), not ":" alone. Plugin-style server names contain
// internal colons — e.g. "plugin:everything-claude-code:context7" — and a bare
// `indexOf(':')` collapses six distinct ECC plugin MCPs into the literal string
// "plugin", causing `claude mcp get plugin` to fail and silently dropping the
// servers' tools from the catalog. Server names cannot contain a literal ": "
// (colon + space) because the CLI uses that exact pair as the line delimiter, so
// `indexOf(': ')` is safe even for names with spaces (e.g. "claude.ai Google Drive").
export function parseMcpListOutput(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('Checking') || trimmed.startsWith('Note:')) continue;
    // Format: "<name>: <rest>" — split on ": " (colon + space), see comment above.
    const sepIdx = trimmed.indexOf(': ');
    if (sepIdx <= 0) continue;
    const name = trimmed.slice(0, sepIdx).trim();
    const rest = trimmed.slice(sepIdx + 2).trim();
    // skip the trailing " - ✓ Connected" / " - ✗ Failed"
    const dashIdx = rest.lastIndexOf(' - ');
    const beforeStatus = dashIdx > 0 ? rest.slice(0, dashIdx).trim() : rest;
    if (beforeStatus.startsWith('http://') || beforeStatus.startsWith('https://')) {
      const isHttp = /\(HTTP\)$/.test(beforeStatus);
      const url = beforeStatus.replace(/\s*\(HTTP\)$/, '').trim();
      out.push({ name, transport: isHttp ? 'http' : 'sse', url });
    } else {
      // stdio — extract command + args directly from the CLI line. Plugin-scoped
      // servers (e.g. "plugin:everything-claude-code:context7") cannot be re-
      // queried via `claude mcp get` (CLI returns "No MCP server found with
      // name: ..." even though `mcp list` shows them), so the list line is the
      // only authoritative source for these. Bare-name servers also work this
      // way. Tokenisation handles quoted args and the unquoted Windows absolute
      // executable paths Claude Code prints for some stdio servers, e.g.
      // `C:\Program Files\nodejs\node.exe --foo ...`.
      const tokens = splitCommandLine(beforeStatus);
      // tokens.length === 0 means the CLI emitted "<name>: " followed by only
      // status text (or nothing) — a malformed entry we cannot spawn anyway.
      // We `continue` rather than throw so a single broken line cannot poison
      // refresh for all the other healthy servers in the same `mcp list`. The
      // fact that this entry was dropped is recoverable: the next refresh re-
      // reads the CLI from scratch. This is the same "skip one server, log
      // through listMcpToolsAll" treatment the rest of the path uses.
      if (tokens.length === 0) continue;
      out.push({ name, transport: 'stdio', command: tokens[0], args: tokens.slice(1) });
    }
  }
  return out;
}

// Fetch tools/list from a single MCP server. The `server` descriptor either came
// from `.mcp.json` (carries env / headers) or from CLI output (bare). For stdio
// entries without full config we fall back to `claude mcp get`.
export async function listMcpToolsOne({ server, logFn = () => {}, claudeBin = 'claude', projectRoot }) {
  if (server.transport === 'stdio') {
    const hasFullConfig = server.command !== undefined;
    const config = hasFullConfig
      ? { command: server.command, args: server.args ?? [], env: server.env ?? {} }
      : await getStdioConfig({ name: server.name, claudeBin, projectRoot });
    return spawnAndQuery(config, server.name);
  }
  if (server.transport === 'http' || server.transport === 'sse') {
    // For `claude.ai ...` servers, CLI reports http/sse but they are NOT in local
    // .mcp.json — covered by src/tool-db/claude-ai-baseline.mjs at a higher layer.
    if (!server.url) {
      throw new McpInvestigationError(`no URL available for ${server.transport} server`, server.name);
    }
    return listToolsHttp({ url: server.url, serverName: server.name, headers: server.headers ?? {} });
  }
  throw new McpInvestigationError(`unknown transport: ${server.transport}`, server.name);
}

// Parse `claude mcp get <name>` to extract Command + Args for stdio servers.
// `cwd: projectRoot` pins the CLI's scope walk-up to the same directory used for
// `.mcp.json` reading — see listMcpServers for the rationale.
async function getStdioConfig({ name, claudeBin, projectRoot }) {
  const execOpts = { encoding: 'utf8' };
  if (projectRoot) execOpts.cwd = projectRoot;
  const { stdout } = await execClaude(claudeBin, ['mcp', 'get', name], execOpts);
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

export function splitCommandLine(s) {
  const windows = extractUnquotedWindowsExecutable(s);
  if (windows) {
    const args = windows.rest.length > 0 ? splitArgs(windows.rest) : [];
    return [windows.command, ...args];
  }
  return splitArgs(s);
}

function extractUnquotedWindowsExecutable(s) {
  if (!/^(?:[A-Za-z]:\\|\\\\)/u.test(s)) return null;
  const match = s.match(/^(.+?\.(?:exe|cmd|bat))(?:\s+|$)(.*)$/iu);
  if (!match) return null;
  return { command: match[1], rest: match[2].trim() };
}

// Minimal command-line tokenizer for Claude CLI text output. It is intentionally
// not a shell evaluator: it only preserves quoted spans and strips the quote
// delimiters. Backslashes outside quotes are kept verbatim so Windows paths in
// args do not get mangled.
export function splitArgs(s) {
  const out = [];
  let current = '';
  let quote = null;
  let tokenStarted = false;

  const push = () => {
    if (!tokenStarted) return;
    out.push(current);
    current = '';
    tokenStarted = false;
  };

  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
        tokenStarted = true;
        continue;
      }
      if (quote === '"' && ch === '\\' && (s[i + 1] === '"' || s[i + 1] === '\\')) {
        current += s[i + 1];
        tokenStarted = true;
        i += 1;
        continue;
      }
      current += ch;
      tokenStarted = true;
      continue;
    }

    if (/\s/u.test(ch)) {
      push();
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      tokenStarted = true;
      continue;
    }
    current += ch;
    tokenStarted = true;
  }

  push();
  return out;
}

// On Windows, npm-global CLI tools (e.g. `claude-mermaid`) ship as `<name>.cmd`
// batch wrappers. Node's `child_process.spawn` without `shell: true` calls Windows
// `CreateProcess`, which only directly executes `.exe` files — it does NOT search
// PATHEXT for `.cmd`/`.bat` shims when given a bare command name. So
// `spawn('claude-mermaid', ...)` fails with ENOENT even though `claude-mermaid.cmd`
// is on PATH.
//
// Until v1.2.1 this function only wrapped commands whose name literally ended in
// `.cmd`/`.bat`, which missed the common case where the registered command is a
// bare name (the CLI as installed). v1.2.2 routes any non-`.exe` command through
// `cmd.exe /c` on Windows, which makes PATHEXT lookup apply and runs both `.cmd`
// shims and bare names transparently.
//
// We keep absolute `.exe` paths un-wrapped because (a) they spawn correctly as-is
// and (b) wrapping them through `cmd.exe /c "<path with spaces>" args` runs into
// cmd.exe's quoting rules for paths containing spaces, which add risk for zero
// benefit.
//
// We use `cmd.exe /c` explicitly rather than `spawn({ shell: true })` because the
// latter triggers DEP0190 on Node 24+ and re-introduces argument-quoting risks
// (matches the rationale in haiku-caller's buildSpawnArgs and the caveat
// `windows-node-spawn-claude-fails-with-enoent-because-claude-is-a-cmd-wrapper`).
export function buildStdioSpawn(command, args) {
  if (process.platform !== 'win32') {
    return { cmd: command, cmdArgs: args };
  }
  if (/\.exe$/i.test(command)) {
    return { cmd: command, cmdArgs: args };
  }
  return { cmd: 'cmd.exe', cmdArgs: ['/c', command, ...args] };
}

async function spawnAndQuery({ command, args, env = {} }, serverName) {
  return new Promise((resolve, reject) => {
    const { cmd, cmdArgs } = buildStdioSpawn(command, args);
    const child = spawn(cmd, cmdArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, ...env },
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
          clientInfo: { name: 'spotter', version: '0.10.0' },
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
