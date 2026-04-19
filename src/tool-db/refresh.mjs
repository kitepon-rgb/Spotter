// Discover available tools and ensure the tool-db has descriptions for all of them.
//
// Flow per docs/catalog-design-deferred-mcp.md:
//   1. enumerate available tool names (MCP server tools + deferred Claude Code built-ins)
//   2. for each, look up local → global → investigate (write-through; drift-correct)
//   3. write back any updates atomically

import { resolveAll } from './lookup.mjs';
import { listMcpToolsAll, bellVisibleName } from './investigate-mcp.mjs';
import { getDeferredDescription, listDeferredNames } from './deferred-baseline.mjs';
import { localDbPath, globalDbPath } from './loader.mjs';

// Build the (name → description) map for an investigation pass:
// - MCP: from `claude mcp list` + per-server `tools/list`, names rewritten to
//   `mcp__<server-id>__<tool-name>` (Bell-visible form)
// - Deferred: from the hardcoded baseline
//
// Returns an in-memory snapshot the caller can use as the investigate() backend.
export async function buildInvestigationSnapshot({ logFn = () => {}, claudeBin = 'claude' } = {}) {
  const snapshot = new Map();

  // Deferred built-ins.
  for (const name of listDeferredNames()) {
    snapshot.set(name, getDeferredDescription(name));
  }

  // MCP servers.
  const mcp = await listMcpToolsAll({ logFn, claudeBin });
  for (const [serverName, tools] of mcp.entries()) {
    for (const tool of tools) {
      if (!tool.description || tool.description.length === 0) continue;
      snapshot.set(bellVisibleName(serverName, tool.name), tool.description);
    }
  }

  return snapshot;
}

// Refresh the tool-db. Discovers all currently available tools, resolves each via the
// 3-tier lookup, writes through. Returns the resolved Map.
export async function refresh({ projectRoot, logFn = () => {}, claudeBin = 'claude' }) {
  const snapshot = await buildInvestigationSnapshot({ logFn, claudeBin });
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
