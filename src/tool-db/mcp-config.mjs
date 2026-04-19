// Read MCP server definitions directly from `.mcp.json` rather than parsing
// `claude mcp list` text output.
//
// Why: `.mcp.json` is the authoritative source for stdio env vars (e.g. bearer tokens
// passed to the MCP subprocess) and HTTP headers (e.g. Authorization). The CLI output
// of `claude mcp list` / `claude mcp get` hides those secrets. Without them, an HTTP
// MCP server returns 401 and a stdio MCP server spawns without its API key.
//
// Scope: reads user-level `~/.claude/.mcp.json`. Project-level `.mcp.json` and
// `settings.local.json` are not yet consulted — user scope covers the common case
// (globally-installed MCP servers) and is the scope that Spotter's tool-db is
// global-first anyway.
//
// This file does NOT read ~/.claude/.credentials.json (Anthropic OAuth token). That
// remains off-limits per the v0.8.0 design decision. `.mcp.json` is user-authored
// configuration where the user has already chosen to persist their own MCP credentials.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function userMcpConfigPath() {
  return join(homedir(), '.claude', '.mcp.json');
}

// Returns the raw `mcpServers` object from ~/.claude/.mcp.json, or {} if missing.
// Throws only on malformed JSON (not on missing file).
export async function readMcpServers() {
  try {
    const text = await readFile(userMcpConfigPath(), 'utf8');
    const data = JSON.parse(text);
    return data.mcpServers ?? {};
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

// Normalise an `.mcp.json` entry into a server descriptor the investigator can use.
// Returns { name, transport: 'stdio'|'http'|'sse', ...transport-specific fields } or
// null if the entry is not recognisable.
export function describeServer(name, entry) {
  if (entry.command) {
    return {
      name,
      transport: 'stdio',
      command: entry.command,
      args: Array.isArray(entry.args) ? entry.args : [],
      env: entry.env && typeof entry.env === 'object' ? entry.env : {},
    };
  }
  if (entry.url) {
    const transport = entry.type === 'sse' ? 'sse' : 'http';
    return {
      name,
      transport,
      url: entry.url,
      headers: entry.headers && typeof entry.headers === 'object' ? entry.headers : {},
    };
  }
  return null;
}
