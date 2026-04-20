// Skill investigation: collect skills from user scope, project scope, and enabled plugins.
//
// Skill file layout (per Claude Code convention):
//   <root>/skills/<skill-name>/SKILL.md
// where <root> is:
//   - user scope   : ~/.claude
//   - project scope: <projectRoot>/.claude
//   - plugin scope : <installPath> (from ~/.claude/plugins/installed_plugins.json)
//
// Bell-visible name:
//   - plugin-provided : `<plugin-prefix>:<skill-name>`   (e.g. `ecc:council`)
//   - user / project  : `<skill-name>`                   (e.g. `council`)
//
// Plugin prefix is the part before `@` in the plugin id (`ecc@ecc` → `ecc`).
//
// Plugins are considered active if either user-scope `~/.claude/settings.json` or
// project-scope `<projectRoot>/.claude/settings.local.json` sets
// `enabledPlugins[<plugin-id>] = true`, AND the plugin is listed in
// `~/.claude/plugins/installed_plugins.json`.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFrontmatter } from './frontmatter.mjs';

export async function listSkillsAll({ logFn = () => {}, projectRoot } = {}) {
  const out = new Map(); // Bell-visible name → description

  // Plugin scope
  const plugins = await listActivePlugins({ projectRoot, logFn });
  for (const plugin of plugins) {
    const pluginSkills = await scanSkillsDir(join(plugin.installPath, 'skills'), logFn);
    for (const [skillName, description] of pluginSkills) {
      out.set(`${plugin.prefix}:${skillName}`, description);
    }
  }

  // User scope (override plugin-same-name? No — plugin-namespaced names never collide
  // with bare names, so no resolution needed.)
  const userSkills = await scanSkillsDir(join(homedir(), '.claude', 'skills'), logFn);
  for (const [skillName, description] of userSkills) {
    out.set(skillName, description);
  }

  // Project scope (overrides user-scope with the same bare name)
  if (projectRoot) {
    const projectSkills = await scanSkillsDir(join(projectRoot, '.claude', 'skills'), logFn);
    for (const [skillName, description] of projectSkills) {
      out.set(skillName, description);
    }
  }

  return out;
}

// Scan `<dir>/<name>/SKILL.md` files. Returns Map<skill-name, description>. Missing
// directories or malformed skills are skipped silently.
async function scanSkillsDir(dir, logFn) {
  const out = new Map();
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = join(dir, entry.name, 'SKILL.md');
    try {
      const fm = await readFrontmatter(skillFile);
      const name = fm.name ?? entry.name;
      const description = fm.description;
      if (typeof description !== 'string' || description.length === 0) continue;
      out.set(name, description);
    } catch (err) {
      // Directory without SKILL.md (e.g. `skills/learned/` placeholder) is normal —
      // it simply isn't a skill. Only report unexpected errors.
      if (err.code !== 'ENOENT') {
        logFn(`skill read failed at ${skillFile}: ${err.message}`);
      }
    }
  }
  return out;
}

// Return the list of plugins that are (a) installed and (b) enabled in user or project
// scope. Each entry: {id, prefix, installPath}.
export async function listActivePlugins({ projectRoot, logFn = () => {} } = {}) {
  const [installed, userEnabled, projectEnabled] = await Promise.all([
    readInstalledPlugins(logFn),
    readEnabledPlugins(join(homedir(), '.claude', 'settings.json')),
    projectRoot
      ? readEnabledPlugins(join(projectRoot, '.claude', 'settings.local.json'))
      : Promise.resolve({}),
  ]);

  const out = [];
  for (const [id, entries] of Object.entries(installed)) {
    const isEnabled = userEnabled[id] === true || projectEnabled[id] === true;
    if (!isEnabled) continue;
    const entry = entries?.[0];
    if (!entry?.installPath) continue;
    const prefix = id.split('@')[0];
    out.push({ id, prefix, installPath: entry.installPath });
  }
  return out;
}

async function readInstalledPlugins(logFn) {
  const path = join(homedir(), '.claude', 'plugins', 'installed_plugins.json');
  try {
    const text = await readFile(path, 'utf8');
    const parsed = JSON.parse(text);
    return parsed.plugins ?? {};
  } catch (err) {
    logFn(`installed_plugins.json read failed: ${err.message}`);
    return {};
  }
}

async function readEnabledPlugins(settingsPath) {
  try {
    const text = await readFile(settingsPath, 'utf8');
    const parsed = JSON.parse(text);
    return parsed.enabledPlugins ?? {};
  } catch {
    return {};
  }
}
