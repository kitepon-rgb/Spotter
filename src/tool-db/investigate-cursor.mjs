// Cursor-native catalog investigation.
//
// Cursor の MCP / skills / agents は Claude / Codex の設定面とは別物なので、
// この snapshot は ~/.cursor と project の .cursor だけを読む。
// Claude の skills や Codex の mcp list を混ぜない。
// ~/.cursor/skills-cursor は Cursor 製品同梱であり、工場カタログに入れない。

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scanAgentsDir } from './investigate-agents.mjs';
import { bellVisibleName, listMcpToolsOne } from './investigate-mcp.mjs';
import { scanSkillsDir } from './investigate-skills.mjs';
import { describeServer } from './mcp-config.mjs';

export async function buildCursorInvestigationSnapshot({
  logFn = () => {},
  projectRoot,
  cursorHome = join(homedir(), '.cursor'),
} = {}) {
  const snapshot = new Map();

  const mcp = await listCursorMcpToolsAll({ logFn, projectRoot, cursorHome });
  for (const [serverName, tools] of mcp.entries()) {
    for (const tool of tools) {
      if (!tool.description || tool.description.length === 0) continue;
      snapshot.set(bellVisibleName(serverName, tool.name), tool.description);
    }
  }

  const skills = await listCursorSkillsAll({ logFn, projectRoot, cursorHome });
  for (const [name, description] of skills) {
    snapshot.set(name, description);
  }

  const agents = await listCursorAgentsAll({ logFn, projectRoot, cursorHome });
  for (const [name, description] of agents) {
    snapshot.set(name, description);
  }

  return snapshot;
}

export async function listCursorMcpToolsAll({
  logFn = () => {},
  projectRoot,
  cursorHome = join(homedir(), '.cursor'),
} = {}) {
  const servers = await listCursorMcpServers({ projectRoot, cursorHome });
  const out = new Map();
  for (const server of servers) {
    try {
      const tools = await listMcpToolsOne({ server, logFn, projectRoot });
      out.set(server.name, tools);
    } catch (err) {
      logFn(`cursor mcp investigate failed for "${server.name}": ${err.message}`);
    }
  }
  return out;
}

export async function listCursorMcpServers({
  projectRoot,
  cursorHome = join(homedir(), '.cursor'),
} = {}) {
  const user = await readMcpServersFile(join(cursorHome, 'mcp.json'));
  const project = projectRoot ? await readMcpServersFile(join(projectRoot, '.cursor', 'mcp.json')) : {};
  const merged = { ...user, ...project };
  const servers = [];
  for (const [name, entry] of Object.entries(merged)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const described = describeServer(name, entry);
    if (described) servers.push(described);
  }
  return servers;
}

export async function listCursorSkillsAll({
  logFn = () => {},
  projectRoot,
  cursorHome = join(homedir(), '.cursor'),
} = {}) {
  const out = new Map();
  for (const [name, description] of await scanSkillsDir(join(cursorHome, 'skills'), logFn)) {
    out.set(name, description);
  }
  if (projectRoot) {
    for (const [name, description] of await scanSkillsDir(join(projectRoot, '.cursor', 'skills'), logFn)) {
      out.set(name, description);
    }
  }
  return out;
}

export async function listCursorAgentsAll({
  logFn = () => {},
  projectRoot,
  cursorHome = join(homedir(), '.cursor'),
} = {}) {
  const out = new Map();
  for (const [name, description] of await scanAgentsDir(join(cursorHome, 'agents'), logFn)) {
    out.set(name, description);
  }
  if (projectRoot) {
    for (const [name, description] of await scanAgentsDir(join(projectRoot, '.cursor', 'agents'), logFn)) {
      out.set(name, description);
    }
  }
  return out;
}

async function readMcpServersFile(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object') return {};
  return (data.mcpServers && typeof data.mcpServers === 'object') ? data.mcpServers : {};
}
