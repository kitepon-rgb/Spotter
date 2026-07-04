// tool-db: 3-tier lookup with write-through and drift correction.
//
// Per docs/01_catalog-design.md:
//   1. local DB hit       → use it
//   2. local miss, global hit → use it AND write-through to local
//   3. both miss          → investigate, write to BOTH
//   * local≠global hit    → re-investigate (MCP server is source of truth), overwrite BOTH
//
// Local DB pruning: after resolution, any tool currently in the local DB but NOT in
// `toolNames` (i.e. no longer discoverable in this project — server uninstalled, skill
// deleted, agent moved away) is removed. The local DB MUST mirror "what this project
// can use right now" since it is the sole input to the audit. Global DB is the
// long-term knowledge store and is never pruned.
//
// `investigate(name)` is supplied by the caller. Returns description string, or null
// if the tool cannot be resolved (keep going, don't throw).

import { loadDb, saveDb, emptyDb } from './loader.mjs';

export async function resolveAll({ toolNames, localPath, globalPath, investigate, logFn = () => {} }) {
  const local = await loadDb(localPath);
  const global = await loadDb(globalPath);
  const resolved = new Map();
  let localDirty = false;
  let globalDirty = false;

  for (const name of toolNames) {
    const inLocal = local.tools[name];
    const inGlobal = global.tools[name];

    if (inLocal !== undefined && inGlobal !== undefined) {
      if (inLocal === inGlobal) {
        // Both agree. Use it.
        resolved.set(name, { description: inLocal, source: 'local' });
        continue;
      }
      // Drift between local and global. Re-investigate; MCP server wins; overwrite both.
      logFn(`drift detected for "${name}": re-investigating`);
      const fresh = await investigate(name);
      if (fresh === null) {
        // Investigation failed — keep local (oldest unbroken assumption) and warn.
        logFn(`drift for "${name}" but investigation failed; keeping local value`);
        resolved.set(name, { description: inLocal, source: 'local' });
        continue;
      }
      local.tools[name] = fresh;
      global.tools[name] = fresh;
      localDirty = true;
      globalDirty = true;
      resolved.set(name, { description: fresh, source: 'investigated' });
      continue;
    }

    if (inLocal !== undefined) {
      resolved.set(name, { description: inLocal, source: 'local' });
      continue;
    }

    if (inGlobal !== undefined) {
      // Write-through: local picks up the global value so next session is local-only.
      local.tools[name] = inGlobal;
      localDirty = true;
      resolved.set(name, { description: inGlobal, source: 'global' });
      continue;
    }

    // Neither layer has it — investigate.
    const fresh = await investigate(name);
    if (fresh === null) {
      // Investigation failed (e.g., MCP server unreachable). Skip; do not write nulls.
      logFn(`investigation failed for "${name}"; skipping`);
      continue;
    }
    local.tools[name] = fresh;
    global.tools[name] = fresh;
    localDirty = true;
    globalDirty = true;
    resolved.set(name, { description: fresh, source: 'investigated' });
  }

  // Prune local entries no longer present in this project's discovery.
  // Skip names that were requested but failed to resolve (investigation may be a
  // transient failure — keep the existing description rather than blanking the audit).
  const requested = new Set(toolNames);
  for (const name of Object.keys(local.tools)) {
    if (!requested.has(name)) {
      delete local.tools[name];
      localDirty = true;
      logFn(`pruned local entry "${name}" (no longer in this project's discovery)`);
    }
  }

  if (localDirty) await saveDb(localPath, local);
  if (globalDirty) await saveDb(globalPath, global);

  return resolved;
}

// Convenience for daemon/preamble: turn the resolved map into the array format Haiku expects.
export function resolvedToArray(resolved) {
  return Array.from(resolved.entries()).map(([name, { description }]) => ({ name, description }));
}

// Re-export emptyDb for callers that need to seed fresh DBs in tests.
export { emptyDb };
