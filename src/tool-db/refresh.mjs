// Discover available tools and ensure the tool-db has descriptions for all of them.
//
// Flow per docs/01_catalog-design.md:
//   1. enumerate available tool names (MCP + skills + sub-agents, user-addable only)
//   2. for each, look up local → global → investigate (write-through; drift-correct)
//   3. write back any updates atomically
//
// v1.0.0: Claude Code built-in tools (both immediate and deferred) are no longer in the
// catalog. The working assumption is Bell uses built-ins fluently without reminding.
// Spotter's audit surface is the tools the user actively adds: MCP servers, skills, and
// sub-agents.

import { resolveAll } from './lookup.mjs';
import { listMcpToolsAll, listMcpServers, bellVisibleName } from './investigate-mcp.mjs';
import { getClaudeAiBaselineByServer } from './claude-ai-baseline.mjs';
import { buildCodexInvestigationSnapshot } from './investigate-codex.mjs';
import { listSkillsAll } from './investigate-skills.mjs';
import { listAgentsAll } from './investigate-agents.mjs';
import { localDbPath, globalDbPath, normalizeToolDbHostAgent } from './loader.mjs';

// Pure filter: returns the subset of the claude.ai baseline whose server name is
// present in `presentServerNames`. Accepts a Set for O(1) membership. Extracted as
// a named export so it can be unit-tested without a live `claude` CLI.
export function filterClaudeAiBaseline(presentServerNames) {
  const out = new Map();
  for (const [serverName, tools] of getClaudeAiBaselineByServer()) {
    if (!presentServerNames.has(serverName)) continue;
    for (const [toolName, description] of Object.entries(tools)) {
      out.set(toolName, description);
    }
  }
  return out;
}

// Build the (name → description) map for an investigation pass across all sources:
//   - claude.ai MCP baseline (Gmail / Calendar / Drive — OAuth, not locally introspectable)
//   - MCP servers via stdio + HTTP/SSE (user + project .mcp.json, live fetched)
//   - Skills from user scope, project scope, and enabled plugins
//   - Sub-agents from user scope, project scope, and enabled plugins
//
// Returns an in-memory snapshot the caller can use as the investigate() backend.
export async function buildInvestigationSnapshot({ logFn = () => {}, claudeBin = 'claude', projectRoot } = {}) {
  const snapshot = new Map();

  // Anthropic-provided `claude.ai ...` MCP servers. Hardcoded because the OAuth proxy
  // is not reachable without reading ~/.claude/.credentials.json (deliberately avoided).
  // Injected only for servers actually present in `claude mcp list` — otherwise phantom
  // tools (Gmail/Calendar/Drive) leak into environments where those servers are not
  // connected. See filterClaudeAiBaseline above.
  const servers = await listMcpServers({ claudeBin, projectRoot });
  const presentServerNames = new Set(servers.map((s) => s.name));
  const baseline = filterClaudeAiBaseline(presentServerNames);
  for (const [name, description] of baseline) {
    snapshot.set(name, description);
  }
  if (baseline.size > 0) {
    logFn(`claude.ai baseline injected: ${baseline.size} tools from ${[...presentServerNames].filter((n) => n.startsWith('claude.ai ')).join(', ')}`);
  }

  // MCP servers (stdio + user-registered HTTP/SSE). projectRoot forwards for
  // project-scope `.mcp.json` merge (see mcp-config.mjs).
  const mcp = await listMcpToolsAll({ logFn, claudeBin, projectRoot });
  for (const [serverName, tools] of mcp.entries()) {
    for (const tool of tools) {
      if (!tool.description || tool.description.length === 0) continue;
      snapshot.set(bellVisibleName(serverName, tool.name), tool.description);
    }
  }

  // Skills (plugin-namespaced as `<plugin>:<name>`, or bare for user/project scope).
  const skills = await listSkillsAll({ logFn, projectRoot });
  for (const [name, description] of skills) {
    snapshot.set(name, description);
  }

  // Sub-agents (bare name; project > user > plugin precedence resolved internally).
  const agents = await listAgentsAll({ logFn, projectRoot });
  for (const [name, description] of agents) {
    snapshot.set(name, description);
  }

  return snapshot;
}

// Refresh the tool-db. Discovers all currently available tools, resolves each via the
// 3-tier lookup, writes through. Returns the resolved Map.
export async function refresh({
  projectRoot,
  logFn = () => {},
  claudeBin = 'claude',
  codexBin = 'codex',
  hostAgent = 'claude',
} = {}) {
  const toolDbHostAgent = normalizeToolDbHostAgent(hostAgent);
  const snapshot = toolDbHostAgent === 'codex'
    ? await buildCodexInvestigationSnapshot({ logFn, codexBin, projectRoot })
    : await buildInvestigationSnapshot({ logFn, claudeBin, projectRoot });
  const toolNames = Array.from(snapshot.keys());
  const investigate = async (name) => snapshot.get(name) ?? null;

  return resolveAll({
    toolNames,
    localPath: localDbPath(projectRoot, toolDbHostAgent),
    globalPath: globalDbPath(toolDbHostAgent),
    investigate,
    logFn,
  });
}

// Read-only: load the LOCAL tool-db only — the daemon's audit must reflect what this
// specific project can actually use. The host-specific global DB is a cache written by
// `refresh` (so other projects can pick up descriptions cheaply) but is NEVER mixed
// into the daemon's audit catalog. Mixing global in caused phantom-tool suggestions
// from previously-visited projects bleeding into unrelated ones.
export async function readLocal({ projectRoot, hostAgent = 'claude' }) {
  const { loadDb } = await import('./loader.mjs');
  const local = await loadDb(localDbPath(projectRoot, hostAgent));
  return Object.entries(local.tools).map(([name, description]) => ({ name, description }));
}
