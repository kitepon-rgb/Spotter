// `spotter db` — manage the tool-db.
//
//   spotter db list             — print the LOCAL tool-db (what the daemon actually audits)
//   spotter db refresh          — discover available tools and update DB (3-tier resolve)
//   spotter db rebuild          — wipe local + global DBs then refresh (forces re-investigation)
//
// Run inside a project that has been `spotter install`-ed.

import { findSpotterMarker } from '../hooks/lib.mjs';
import { refresh, readLocal } from '../tool-db/refresh.mjs';
import { localDbPath, globalDbPath, loadDb, saveDb, emptyDb } from '../tool-db/loader.mjs';
import { writeFile } from 'node:fs/promises';

function requireProjectRoot() {
  const root = findSpotterMarker(process.cwd());
  if (!root) {
    process.stderr.write('spotter db: no .spotter/marker.json found in or above cwd. Run `spotter install` first.\n');
    process.exit(2);
  }
  return root;
}

export async function runDbList() {
  const projectRoot = requireProjectRoot();
  const tools = await readLocal({ projectRoot });
  if (tools.length === 0) {
    process.stdout.write('(empty — run `spotter db refresh` to populate)\n');
    return;
  }
  for (const { name, description } of tools) {
    process.stdout.write(`${name}\n  ${description}\n\n`);
  }
}

export async function runDbRefresh() {
  const projectRoot = requireProjectRoot();
  const log = (msg) => process.stderr.write(`spotter db refresh: ${msg}\n`);
  log('discovering MCP servers, skills, and sub-agents...');
  const resolved = await refresh({ projectRoot, logFn: log });
  const counts = { local: 0, global: 0, investigated: 0 };
  for (const { source } of resolved.values()) counts[source] = (counts[source] ?? 0) + 1;
  process.stdout.write(
    `${resolved.size} tool(s) resolved (local=${counts.local}, global=${counts.global}, investigated=${counts.investigated})\n`
      + `local DB:  ${localDbPath(projectRoot)}\n`
      + `global DB: ${globalDbPath()}\n`
  );
}

export async function runDbRebuild() {
  const projectRoot = requireProjectRoot();
  // v1.0.0: wipe BOTH local and global DB. Rationale: the catalog scope changed in
  // v1.0.0 (Claude Code built-ins removed; skills + sub-agents added). Stale entries
  // from older versions would otherwise linger in the global DB since `refresh` only
  // touches names currently produced by investigation. Users need a clean slate.
  await saveDb(localDbPath(projectRoot), emptyDb());
  await saveDb(globalDbPath(), emptyDb());
  process.stderr.write(`spotter db rebuild: cleared local + global DB, refreshing...\n`);
  await runDbRefresh();
}
