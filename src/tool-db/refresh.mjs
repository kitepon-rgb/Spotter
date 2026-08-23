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
import { getHostAdapter } from '../host/adapters.mjs';
import { localDbPath, globalDbPath } from './loader.mjs';

// ベンダー別のsnapshot builderと実装本体は investigate-claude.mjs /
// investigate-codex.mjs へ移設し、選択は src/host/adapters.mjs が所有する。
// 既存importer・test契約のため同名で再exportする。
export { buildInvestigationSnapshot, filterClaudeAiBaseline } from './investigate-claude.mjs';

// Refresh the tool-db. Discovers all currently available tools, resolves each via the
// 3-tier lookup, writes through. Returns the resolved Map.
export async function refresh({
  projectRoot,
  logFn = () => {},
  claudeBin = 'claude',
  codexBin = 'codex',
  hostAgent = 'claude',
} = {}) {
  const adapter = getHostAdapter(hostAgent);
  const snapshot = await adapter.buildSnapshot({ logFn, claudeBin, codexBin, projectRoot });
  const toolNames = Array.from(snapshot.keys());
  const investigate = async (name) => snapshot.get(name) ?? null;

  return resolveAll({
    toolNames,
    localPath: localDbPath(projectRoot, adapter.hostAgent),
    globalPath: globalDbPath(adapter.hostAgent),
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
