// Discover available tools and ensure the tool-db has descriptions for all of them.
//
// Flow per docs/catalog-design.md:
//   1. enumerate available tool names (MCP + skills + sub-agents, user-addable only)
//   2. for each, look up local → global → investigate (write-through; drift-correct)
//   3. write back any updates atomically
//
// v1.0.0: Claude Code built-in tools (both immediate and deferred) are no longer in the
// catalog. The working assumption is Bell uses built-ins fluently without reminding.
// Spotter's audit surface is the tools the user actively adds: MCP servers, skills, and
// sub-agents.

import { resolveAll } from './lookup.mjs';
import { listMcpToolsAll, bellVisibleName } from './investigate-mcp.mjs';
import { getClaudeAiDescription, listClaudeAiNames } from './claude-ai-baseline.mjs';
import { listSkillsAll } from './investigate-skills.mjs';
import { listAgentsAll } from './investigate-agents.mjs';
import { localDbPath, globalDbPath } from './loader.mjs';

// Build the (name → description) map for an investigation pass across all sources:
//   - claude.ai MCP baseline (Gmail / Calendar / Drive — OAuth, not locally introspectable)
//   - MCP servers via stdio + HTTP/SSE (user + project .mcp.json, live fetched)
//   - Skills from user scope, project scope, and enabled plugins
//   - Sub-agents from user scope, project scope, and enabled plugins
//
// Returns an in-memory snapshot the caller can use as the investigate() backend.
export async function buildInvestigationSnapshot({ logFn = () => {}, claudeBin = 'claude', projectRoot } = {}) {
  const snapshot = new Map();

  // Anthropic-provided `claude.ai ...` MCP servers — hardcoded because the OAuth proxy
  // is not reachable without reading ~/.claude/.credentials.json (deliberately avoided).
  // If a live HTTP investigate for the same name later succeeds below, it overrides.
  for (const name of listClaudeAiNames()) {
    snapshot.set(name, getClaudeAiDescription(name));
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
export async function refresh({ projectRoot, logFn = () => {}, claudeBin = 'claude' }) {
  const snapshot = await buildInvestigationSnapshot({ logFn, claudeBin, projectRoot });
  const toolNames = Array.from(snapshot.keys());
  const investigate = async (name) => snapshot.get(name) ?? null;

  return resolveAll({
    toolNames,
    localPath: localDbPath(projectRoot),
    globalPath: globalDbPath(),
    investigate,
    logFn,
  });
}

// Read-only: load the current tool-db (local + global merged with local-wins) for use
// by daemon at session start. Does NOT perform discovery or write — that's `refresh`'s
// job, run via CLI or install hook.
export async function readMerged({ projectRoot }) {
  const { loadDb } = await import('./loader.mjs');
  const local = await loadDb(localDbPath(projectRoot));
  const global = await loadDb(globalDbPath());
  const merged = { ...global.tools, ...local.tools }; // local overrides
  return Object.entries(merged).map(([name, description]) => ({ name, description }));
}
