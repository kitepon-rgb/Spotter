// Claude-native catalog investigation (investigate-codex.mjs の Claude 対称)。
// `claude mcp list` + Claude skills / sub-agents から (name → description) snapshot を作る。

import { listMcpToolsAll, listMcpServers, bellVisibleName } from './investigate-mcp.mjs';
import { getClaudeAiBaselineByServer } from './claude-ai-baseline.mjs';
import { listSkillsAll } from './investigate-skills.mjs';
import { listAgentsAll } from './investigate-agents.mjs';

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
