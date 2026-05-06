// `spotter db` — manage the tool-db.
//
//   spotter db list             — print the LOCAL tool-db (what the daemon actually audits)
//   spotter db refresh          — discover available tools and update DB (3-tier resolve)
//   spotter db rebuild          — wipe host-local + host-global DBs then refresh
//
// Run inside a project that has been `spotter install`-ed.

import { findSpotterMarker } from '../hooks/lib.mjs';
import { refresh, readLocal } from '../tool-db/refresh.mjs';
import { localDbPath, globalDbPath, loadDb, saveDb, emptyDb } from '../tool-db/loader.mjs';
import { writeFile } from 'node:fs/promises';

const DB_USAGE = `spotter db — manage the host-specific tool-db

Usage:
  spotter db list [--host-agent claude|codex|automation]
  spotter db refresh [--host-agent claude|codex|automation]
  spotter db rebuild [--host-agent claude|codex|automation]
`;

function requireProjectRoot() {
  const root = findSpotterMarker(process.cwd());
  if (!root) {
    process.stderr.write('spotter db: no .spotter/marker.json found in or above cwd. Run `spotter install` first.\n');
    process.exit(2);
  }
  return root;
}

export async function runDbList({ argv = [] } = {}) {
  const projectRoot = requireProjectRoot();
  const opts = parseDbArgs(argv);
  const tools = await readLocal({ projectRoot, hostAgent: opts.hostAgent });
  if (tools.length === 0) {
    process.stdout.write(`(empty — run \`spotter db refresh --host-agent ${opts.hostAgent}\` to populate)\n`);
    return;
  }
  for (const { name, description } of tools) {
    process.stdout.write(`${name}\n  ${description}\n\n`);
  }
}

export async function runDbRefresh({ argv = [] } = {}) {
  const projectRoot = requireProjectRoot();
  const opts = parseDbArgs(argv);
  const log = (msg) => process.stderr.write(`spotter db refresh: ${msg}\n`);
  log(`discovering MCP servers, skills, and sub-agents for host=${opts.hostAgent}...`);
  const resolved = await refresh({ projectRoot, hostAgent: opts.hostAgent, logFn: log });
  const counts = { local: 0, global: 0, investigated: 0 };
  for (const { source } of resolved.values()) counts[source] = (counts[source] ?? 0) + 1;
  process.stdout.write(
    `${resolved.size} tool(s) resolved (local=${counts.local}, global=${counts.global}, investigated=${counts.investigated})\n`
      + `local DB:  ${localDbPath(projectRoot, opts.hostAgent)}\n`
      + `global DB: ${globalDbPath(opts.hostAgent)}\n`
  );
}

export async function runDbRebuild({ argv = [] } = {}) {
  const projectRoot = requireProjectRoot();
  const opts = parseDbArgs(argv);
  // Wipe BOTH host-local and host-global DB. Rationale: catalog scope changes and
  // description drift must not leak between Claude and Codex; each host cache is a
  // separate clean-slate unit.
  await saveDb(localDbPath(projectRoot, opts.hostAgent), emptyDb());
  await saveDb(globalDbPath(opts.hostAgent), emptyDb());
  process.stderr.write(`spotter db rebuild: cleared ${opts.hostAgent} local + ${opts.hostAgent} global DB, refreshing...\n`);
  await runDbRefresh({ argv });
}

function parseDbArgs(argv) {
  const opts = { hostAgent: 'claude' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--host-agent') {
      opts.hostAgent = requireValue(argv, (index += 1), '--host-agent');
      continue;
    }
    process.stderr.write(`unknown db option: ${arg}\n${DB_USAGE}`);
    process.exit(2);
    return opts;
  }
  return opts;
}

function requireValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw Object.assign(new Error(`${option} requires a value`), { exitCode: 2 });
  }
  return value;
}
