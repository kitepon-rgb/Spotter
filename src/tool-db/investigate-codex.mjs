// Codex-native catalog investigation.
//
// This intentionally does not reuse Claude's `claude mcp list` / `~/.claude*`
// discovery path. Codex and Claude expose different MCP servers and skills, so a
// Codex refresh must build a separate snapshot and write it to tool-db.codex.json.

import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { bellVisibleName, listMcpToolsOne, splitArgs } from './investigate-mcp.mjs';
import { readFrontmatter } from './frontmatter.mjs';

const execFileP = promisify(execFile);

async function execCodex(codexBin, args, opts) {
  const execOpts = { ...opts, windowsHide: true };
  if (process.platform === 'win32') {
    return execFileP('cmd.exe', ['/c', codexBin, ...args], execOpts);
  }
  return execFileP(codexBin, args, execOpts);
}

export async function buildCodexInvestigationSnapshot({
  logFn = () => {},
  codexBin = 'codex',
  projectRoot,
  codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'),
} = {}) {
  const snapshot = new Map();

  const mcp = await listCodexMcpToolsAll({ logFn, codexBin, projectRoot });
  for (const [serverName, tools] of mcp.entries()) {
    for (const tool of tools) {
      if (!tool.description || tool.description.length === 0) continue;
      snapshot.set(bellVisibleName(serverName, tool.name), tool.description);
    }
  }

  const skills = await listCodexSkillsAll({ logFn, projectRoot, codexHome });
  for (const [name, description] of skills) {
    snapshot.set(name, description);
  }

  return snapshot;
}

export async function listCodexMcpToolsAll({ logFn = () => {}, codexBin = 'codex', projectRoot } = {}) {
  const servers = await listCodexMcpServers({ codexBin, projectRoot });
  const out = new Map();
  for (const server of servers) {
    try {
      const tools = await listMcpToolsOne({ server, logFn, projectRoot });
      out.set(server.name, tools);
    } catch (err) {
      logFn(`codex mcp investigate failed for "${server.name}": ${err.message}`);
    }
  }
  return out;
}

export async function listCodexMcpServers({ codexBin = 'codex', projectRoot } = {}) {
  const execOpts = { encoding: 'utf8' };
  if (projectRoot) execOpts.cwd = projectRoot;
  const { stdout } = await execCodex(codexBin, ['mcp', 'list'], execOpts);
  const names = parseCodexMcpListOutput(stdout);
  const servers = [];
  for (const name of names) {
    const { stdout: detail } = await execCodex(codexBin, ['mcp', 'get', name], execOpts);
    const server = parseCodexMcpGetOutput(detail);
    if (server) servers.push(server);
  }
  return servers;
}

export function parseCodexMcpListOutput(text) {
  const out = [];
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('Name ')) continue;
    const fields = line.split(/\s+/u);
    if (fields.length < 2) continue;
    const status = fields.includes('disabled') ? 'disabled' : fields.includes('enabled') ? 'enabled' : null;
    if (status !== 'enabled') continue;
    out.push(fields[0]);
  }
  return out;
}

export function parseCodexMcpGetOutput(text) {
  const lines = String(text ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  const name = lines[0];
  if (!name) return null;
  const fields = new Map();
  for (const line of lines.slice(1)) {
    const sep = line.indexOf(':');
    if (sep <= 0) continue;
    fields.set(line.slice(0, sep).trim(), line.slice(sep + 1).trim());
  }
  if (fields.get('enabled') === 'false') return null;
  const transport = fields.get('transport');
  if (transport === 'stdio') {
    const command = fields.get('command');
    if (!command || command === '-') return null;
    const argsRaw = fields.get('args');
    return {
      name,
      transport: 'stdio',
      command,
      args: argsRaw && argsRaw !== '-' ? splitArgs(argsRaw) : [],
      cwd: fields.get('cwd') && fields.get('cwd') !== '-' ? fields.get('cwd') : undefined,
      env: parseCodexEnv(fields.get('env')),
    };
  }
  if (transport === 'http' || transport === 'sse') {
    const url = fields.get('url');
    if (!url || url === '-') return null;
    return { name, transport: transport === 'sse' ? 'sse' : 'http', url };
  }
  return null;
}

function parseCodexEnv(raw) {
  if (!raw || raw === '-') return {};
  const env = {};
  for (const item of splitArgs(raw)) {
    const sep = item.indexOf('=');
    if (sep <= 0) continue;
    env[item.slice(0, sep)] = item.slice(sep + 1);
  }
  return env;
}

export async function listCodexSkillsAll({
  logFn = () => {},
  projectRoot,
  codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'),
} = {}) {
  const out = new Map();

  for (const [name, description] of await scanCodexSkillsDir(join(codexHome, 'skills', '.system'), logFn)) {
    out.set(name, description);
  }
  for (const plugin of await listEnabledCodexPlugins({ codexHome, logFn })) {
    for (const [name, description] of await scanCodexSkillsDir(join(plugin.installPath, 'skills'), logFn)) {
      out.set(`${plugin.prefix}:${name}`, description);
    }
  }
  for (const [name, description] of await scanCodexSkillsDir(join(codexHome, 'skills'), logFn)) {
    out.set(name, description);
  }
  if (projectRoot) {
    for (const [name, description] of await scanCodexSkillsDir(join(projectRoot, '.codex', 'skills'), logFn)) {
      out.set(name, description);
    }
  }

  return out;
}

async function scanCodexSkillsDir(dir, logFn) {
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
      if (err.code !== 'ENOENT') {
        logFn(`codex skill read failed at ${skillFile}: ${err.message}`);
      }
    }
  }
  return out;
}

async function listEnabledCodexPlugins({ codexHome, logFn }) {
  const configPath = join(codexHome, 'config.toml');
  let text;
  try {
    text = await readFile(configPath, 'utf8');
  } catch {
    return [];
  }
  const enabled = parseEnabledCodexPluginIds(text);
  const out = [];
  for (const id of enabled) {
    const installPath = await codexPluginInstallPath({ codexHome, id });
    if (!installPath) {
      logFn(`codex plugin enabled but cache not found: ${id}`);
      continue;
    }
    out.push({ id, prefix: id.split('@')[0], installPath });
  }
  return out;
}

export function parseEnabledCodexPluginIds(tomlText) {
  const out = [];
  let current = null;
  for (const rawLine of String(tomlText ?? '').split('\n')) {
    const line = rawLine.trim();
    const section = line.match(/^\[plugins\."([^"]+)"\]$/u);
    if (section) {
      current = section[1];
      continue;
    }
    if (!current) continue;
    if (/^\[/.test(line)) {
      current = null;
      continue;
    }
    if (/^enabled\s*=\s*true\b/u.test(line)) out.push(current);
  }
  return out;
}

async function codexPluginInstallPath({ codexHome, id }) {
  const [name, marketplace] = id.split('@');
  if (!name || !marketplace) return null;
  const root = join(codexHome, 'plugins', 'cache', marketplace, name);
  let versions;
  try {
    versions = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const dirs = versions.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  return dirs.length > 0 ? join(root, dirs.at(-1)) : null;
}
