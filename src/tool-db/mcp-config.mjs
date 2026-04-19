// Read MCP server definitions directly from `.mcp.json` rather than parsing
// `claude mcp list` text output.
//
// Why: `.mcp.json` is the authoritative source for stdio env vars (e.g. bearer tokens
// passed to the MCP subprocess) and HTTP headers (e.g. Authorization). The CLI output
// of `claude mcp list` / `claude mcp get` hides those secrets. Without them, an HTTP
// MCP server returns 401 and a stdio MCP server spawns without its API key.
//
// Scope: merges user-level `~/.claude/.mcp.json` with optional project-level
// `<projectRoot>/.mcp.json`. Project scope overrides user scope on name collision
// (matches Claude Code's own precedence — more-specific scope wins).
// `settings.local.json` (local scope) is not yet consulted.
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

export function projectMcpConfigPath(projectRoot) {
  return join(projectRoot, '.mcp.json');
}

async function readOne(path) {
  try {
    const text = await readFile(path, 'utf8');
    const data = JSON.parse(text);
    return data.mcpServers ?? {};
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

// Returns the merged `mcpServers` object: user scope as base, project scope overrides
// on name collision. Missing files are treated as empty (not an error). If projectRoot
// is not supplied, only user scope is read.
export async function readMcpServers({ projectRoot } = {}) {
  const user = await readOne(userMcpConfigPath());
  if (!projectRoot) return user;
  const project = await readOne(projectMcpConfigPath(projectRoot));
  return { ...user, ...project };
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
