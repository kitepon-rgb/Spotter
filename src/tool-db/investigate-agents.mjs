// Sub-agent investigation: collect agents from user scope, project scope, and enabled
// plugins.
//
// Agent file layout (per Claude Code convention):
//   <root>/agents/<agent-name>.md         (single .md with frontmatter)
// where <root> is:
//   - user scope   : ~/.claude
//   - project scope: <projectRoot>/.claude
//   - plugin scope : <installPath>
//
// Bell-visible name: just `<agent-name>` — sub-agents are NOT namespaced the way skills
// are. Name collisions (e.g. both ECC and a user dotfile defining `code-reviewer`) are
// resolved by precedence: project > user > plugin. Later writes to the Map override.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFrontmatter } from './frontmatter.mjs';
import { listActivePlugins } from './investigate-skills.mjs';

export async function listAgentsAll({ logFn = () => {}, projectRoot } = {}) {
  const out = new Map(); // Bell-visible name → description

  // Plugin scope first (lowest precedence)
  const plugins = await listActivePlugins({ projectRoot, logFn });
  for (const plugin of plugins) {
    const pluginAgents = await scanAgentsDir(join(plugin.installPath, 'agents'), logFn);
    for (const [name, description] of pluginAgents) {
      out.set(name, description);
    }
  }

  // User scope (overrides plugin)
  const userAgents = await scanAgentsDir(join(homedir(), '.claude', 'agents'), logFn);
  for (const [name, description] of userAgents) {
    out.set(name, description);
  }

  // Project scope (highest precedence)
  if (projectRoot) {
    const projectAgents = await scanAgentsDir(join(projectRoot, '.claude', 'agents'), logFn);
    for (const [name, description] of projectAgents) {
      out.set(name, description);
    }
  }

  return out;
}

// Scan `<dir>/<name>.md` files. Returns Map<agent-name, description>. Missing directories
// or malformed agents are skipped silently.
export async function scanAgentsDir(dir, logFn) {
  const out = new Map();
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.md')) continue;
    const agentFile = join(dir, entry.name);
    try {
      const fm = await readFrontmatter(agentFile);
      const name = fm.name ?? entry.name.replace(/\.md$/, '');
      const description = fm.description;
      if (typeof description !== 'string' || description.length === 0) continue;
      out.set(name, description);
    } catch (err) {
      logFn(`agent read failed at ${agentFile}: ${err.message}`);
    }
  }
  return out;
}
