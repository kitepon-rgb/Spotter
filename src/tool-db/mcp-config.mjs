// Read MCP server definitions from Claude Code's official scope storage.
//
// Why: The CLI output of `claude mcp list` / `claude mcp get` hides secrets such as
// stdio env vars (bearer tokens passed to the MCP subprocess) and HTTP headers
// (Authorization). Without them, an HTTP MCP server returns 401 and a stdio MCP
// server spawns without its API key. Reading the underlying config files directly is
// the only way to recover full transport details.
//
// Scope (per Claude Code's official spec — https://code.claude.com/docs/en/mcp):
//
//   - User    — `~/.claude.json` direct `mcpServers`. Loaded in all projects.
//   - Project — `<projectRoot>/.mcp.json`. Loaded in current project only.
//   - Local   — `~/.claude.json` `projects["<projectRoot>"].mcpServers`. Loaded in
//               current project only.
//
// Precedence on name collision (more specific wins): Local > Project > User.
//
// Additionally, `~/.claude/.mcp.json` is read as a "legacy user-level" source — it is
// NOT part of the official scope model but some Spotter installations still rely on
// it, so we keep reading it at the lowest priority for backward compatibility.
//
// Until v1.2.0 we only read project + legacy. That left two of the three official
// sources unread, so a server registered with `claude mcp add -s user` (env stored in
// `~/.claude.json` direct `mcpServers`) was discovered by `claude mcp list` but
// spawned without its env, returning empty `tools/list` and getting pruned from the
// catalog. This module now covers all four sources.
//
// This file does NOT read ~/.claude/.credentials.json (Anthropic OAuth token). That
// remains off-limits per the v0.8.0 design decision. The `.mcp.json` files and
// `~/.claude.json`'s `mcpServers` are user-authored / Claude-Code-managed
// configuration where the user has already chosen to persist their own MCP
// credentials.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function userClaudeJsonPath() {
  return join(homedir(), '.claude.json');
}

export function legacyUserMcpConfigPath() {
  return join(homedir(), '.claude', '.mcp.json');
}

export function projectMcpConfigPath(projectRoot) {
  return join(projectRoot, '.mcp.json');
}

// Back-compat alias. Older callers / external integrators may still import this.
export function userMcpConfigPath() {
  return legacyUserMcpConfigPath();
}

// Read `~/.claude.json`. Missing file → null. Malformed JSON → null. Other I/O errors
// re-throw. Lenient parsing because this file is owned by Claude Code (not Spotter
// nor the user directly): a transient corruption mid-write must not crash Spotter.
async function readClaudeJsonFile(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

// Read an `.mcp.json`-shaped file (user-authored). Missing → empty map. Malformed
// JSON or other I/O errors re-throw — these files are written by hand or by the
// `claude mcp add` CLI; surfacing a parse error helps the user notice the corruption.
async function readMcpServersFile(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object') return {};
  return (data.mcpServers && typeof data.mcpServers === 'object') ? data.mcpServers : {};
}

// Normalize a project path for matching against `~/.claude.json` `projects[]` keys.
// Claude stores absolute paths verbatim, but representation can drift across:
//   - separator: `\` on Windows vs `/`
//   - drive-letter case: `C:\` vs `c:\` on Windows
//   - trailing slash: `/foo/bar` vs `/foo/bar/`
// On Windows we canonicalize to forward slashes and lower-case (case-insensitive
// filesystem). On POSIX, `\` is a legal filename character — collapsing it to `/`
// would conflate genuinely distinct paths (e.g. literal `C:\Users\u\proj` vs the
// hypothetical POSIX path `C:/Users/u/proj`), and case stays significant. POSIX
// only normalizes the trailing slash.
export function normalizeProjectPath(p) {
  if (typeof p !== 'string' || p.length === 0) return '';
  let s = p;
  if (process.platform === 'win32') {
    s = s.replace(/\\/g, '/').toLowerCase();
  }
  s = s.replace(/\/+$/, '');
  return s;
}

// Extract user-scope `mcpServers` from a parsed `~/.claude.json` object.
export function extractUserScopeServers(claudeJson) {
  if (!claudeJson || typeof claudeJson !== 'object') return {};
  const servers = claudeJson.mcpServers;
  return (servers && typeof servers === 'object') ? servers : {};
}

// Extract local-scope `mcpServers` for a given projectRoot from a parsed
// `~/.claude.json` object. Tries the exact key first, then a normalized match
// (separator / case / trailing-slash insensitive on Windows). If no key matches,
// returns empty — we deliberately do NOT fuzzy-match (e.g. partial-prefix), since
// that could pull in another project's secrets.
export function findLocalScopeServers(claudeJson, projectRoot) {
  if (!claudeJson || typeof claudeJson !== 'object') return {};
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) return {};
  const projects = claudeJson.projects;
  if (!projects || typeof projects !== 'object') return {};

  const direct = projects[projectRoot];
  if (direct && typeof direct === 'object'
      && direct.mcpServers && typeof direct.mcpServers === 'object') {
    return direct.mcpServers;
  }

  const target = normalizeProjectPath(projectRoot);
  if (target.length === 0) return {};
  for (const key of Object.keys(projects)) {
    if (normalizeProjectPath(key) !== target) continue;
    const entry = projects[key];
    if (entry && typeof entry === 'object'
        && entry.mcpServers && typeof entry.mcpServers === 'object') {
      return entry.mcpServers;
    }
  }
  return {};
}

// Returns the merged `mcpServers` map across all known scopes for the current
// project. Sources, lowest → highest priority on name collision:
//   1. legacy `~/.claude/.mcp.json`                                    (back-compat)
//   2. user scope    `~/.claude.json` `mcpServers`                     (all projects)
//   3. project scope `<projectRoot>/.mcp.json`                         (this project)
//   4. local scope   `~/.claude.json` `projects[<root>].mcpServers`    (this project)
//
// Missing files / missing keys are treated as empty (no error). If `projectRoot` is
// not supplied, scopes 3 and 4 are skipped.
//
// IMPORTANT: this function does NOT decide which servers are "loaded in this
// project" — that is `claude mcp list`'s job. Callers in investigate-mcp.mjs
// intersect this map with the CLI list (CLI authoritative for membership; this map
// authoritative for transport details + secrets).
export async function readMcpServers({
  projectRoot,
  claudeJsonPath = userClaudeJsonPath(),
  legacyUserPath = legacyUserMcpConfigPath(),
} = {}) {
  const legacy = await readMcpServersFile(legacyUserPath);
  const claudeJson = await readClaudeJsonFile(claudeJsonPath);
  const user = extractUserScopeServers(claudeJson);
  const project = projectRoot ? await readMcpServersFile(projectMcpConfigPath(projectRoot)) : {};
  const local = projectRoot ? findLocalScopeServers(claudeJson, projectRoot) : {};
  return { ...legacy, ...user, ...project, ...local };
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
