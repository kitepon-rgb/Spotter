import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDb, saveDb, emptyDb, ToolDbSchemaError } from '../src/tool-db/loader.mjs';
import { resolveAll } from '../src/tool-db/lookup.mjs';
import { readLocal } from '../src/tool-db/refresh.mjs';
import { parseMcpListOutput, bellVisibleName } from '../src/tool-db/investigate-mcp.mjs';
import { parseFrontmatter } from '../src/tool-db/frontmatter.mjs';
import { listSkillsAll } from '../src/tool-db/investigate-skills.mjs';
import { listAgentsAll } from '../src/tool-db/investigate-agents.mjs';
import { describeServer, readMcpServers } from '../src/tool-db/mcp-config.mjs';
import { filterClaudeAiBaseline } from '../src/tool-db/refresh.mjs';

async function setupPaths() {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-tooldb-'));
  return {
    dir,
    localPath: join(dir, 'local.json'),
    globalPath: join(dir, 'global.json'),
  };
}

test('emptyDb: produces valid v1 shape', () => {
  const db = emptyDb();
  assert.equal(db.version, 1);
  assert.deepEqual(db.tools, {});
});

test('loadDb: missing file returns emptyDb (not an error)', async () => {
  const db = await loadDb(join(tmpdir(), 'nonexistent-' + Math.random() + '.json'));
  assert.deepEqual(db, emptyDb());
});

test('loadDb: malformed JSON throws ToolDbSchemaError', async () => {
  const { dir, localPath } = await setupPaths();
  await writeFile(localPath, '{not json', 'utf8');
  await assert.rejects(loadDb(localPath), ToolDbSchemaError);
  await rm(dir, { recursive: true, force: true });
});

test('loadDb: wrong version throws', async () => {
  const { dir, localPath } = await setupPaths();
  await writeFile(localPath, JSON.stringify({ version: 99, tools: {} }), 'utf8');
  await assert.rejects(loadDb(localPath), ToolDbSchemaError);
  await rm(dir, { recursive: true, force: true });
});

test('loadDb: non-string description throws', async () => {
  const { dir, localPath } = await setupPaths();
  await writeFile(localPath, JSON.stringify({ version: 1, tools: { foo: 42 } }), 'utf8');
  await assert.rejects(loadDb(localPath), ToolDbSchemaError);
  await rm(dir, { recursive: true, force: true });
});

test('saveDb + loadDb: roundtrip preserves entries', async () => {
  const { dir, localPath } = await setupPaths();
  const db = { version: 1, tools: { foo: 'foo desc', bar: 'bar desc' } };
  await saveDb(localPath, db);
  const loaded = await loadDb(localPath);
  assert.deepEqual(loaded.tools, db.tools);
  await rm(dir, { recursive: true, force: true });
});

test('resolveAll: local hit only — no investigation, no writes', async () => {
  const { dir, localPath, globalPath } = await setupPaths();
  await saveDb(localPath, { version: 1, tools: { foo: 'local desc' } });
  let invoked = 0;
  const investigate = async () => { invoked += 1; return 'should not be called'; };
  const resolved = await resolveAll({
    toolNames: ['foo'],
    localPath,
    globalPath,
    investigate,
  });
  assert.equal(resolved.get('foo').description, 'local desc');
  assert.equal(resolved.get('foo').source, 'local');
  assert.equal(invoked, 0);
  await rm(dir, { recursive: true, force: true });
});

test('resolveAll: global hit, local empty → write-through to local', async () => {
  const { dir, localPath, globalPath } = await setupPaths();
  await saveDb(globalPath, { version: 1, tools: { foo: 'global desc' } });
  const investigate = async () => 'should not be called';
  const resolved = await resolveAll({
    toolNames: ['foo'],
    localPath,
    globalPath,
    investigate,
  });
  assert.equal(resolved.get('foo').description, 'global desc');
  assert.equal(resolved.get('foo').source, 'global');
  // local now contains it
  const localAfter = await loadDb(localPath);
  assert.equal(localAfter.tools.foo, 'global desc');
  await rm(dir, { recursive: true, force: true });
});

test('resolveAll: both empty → investigate, write to both', async () => {
  const { dir, localPath, globalPath } = await setupPaths();
  let invoked = 0;
  const investigate = async (name) => {
    invoked += 1;
    assert.equal(name, 'foo');
    return 'fresh from MCP';
  };
  const resolved = await resolveAll({
    toolNames: ['foo'],
    localPath,
    globalPath,
    investigate,
  });
  assert.equal(resolved.get('foo').description, 'fresh from MCP');
  assert.equal(resolved.get('foo').source, 'investigated');
  assert.equal(invoked, 1);
  const localAfter = await loadDb(localPath);
  const globalAfter = await loadDb(globalPath);
  assert.equal(localAfter.tools.foo, 'fresh from MCP');
  assert.equal(globalAfter.tools.foo, 'fresh from MCP');
  await rm(dir, { recursive: true, force: true });
});

test('resolveAll: drift between local and global → re-investigate, overwrite both', async () => {
  const { dir, localPath, globalPath } = await setupPaths();
  await saveDb(localPath, { version: 1, tools: { foo: 'old local' } });
  await saveDb(globalPath, { version: 1, tools: { foo: 'old global' } });
  const investigate = async () => 'authoritative current';
  const resolved = await resolveAll({
    toolNames: ['foo'],
    localPath,
    globalPath,
    investigate,
  });
  assert.equal(resolved.get('foo').description, 'authoritative current');
  assert.equal(resolved.get('foo').source, 'investigated');
  const localAfter = await loadDb(localPath);
  const globalAfter = await loadDb(globalPath);
  assert.equal(localAfter.tools.foo, 'authoritative current');
  assert.equal(globalAfter.tools.foo, 'authoritative current');
  await rm(dir, { recursive: true, force: true });
});

test('resolveAll: investigation failure → tool omitted from result, not written', async () => {
  const { dir, localPath, globalPath } = await setupPaths();
  const investigate = async () => null; // simulate "MCP server unreachable"
  const resolved = await resolveAll({
    toolNames: ['foo'],
    localPath,
    globalPath,
    investigate,
  });
  assert.equal(resolved.has('foo'), false);
  // Neither file should have been created with a `foo` entry.
  const local = await loadDb(localPath);
  const global = await loadDb(globalPath);
  assert.equal(local.tools.foo, undefined);
  assert.equal(global.tools.foo, undefined);
  await rm(dir, { recursive: true, force: true });
});

test('parseMcpListOutput: parses stdio entries', () => {
  const input = `Checking MCP server health...

caveat: C:\\Program Files\\nodejs\\node.exe --foo /a/b/c.js mcp-server - ✓ Connected
`;
  const out = parseMcpListOutput(input);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'caveat');
  assert.equal(out[0].transport, 'stdio');
});

test('parseMcpListOutput: parses HTTP entries', () => {
  const input = 'x-api: https://example.com/mcp (HTTP) - ✓ Connected\n';
  const out = parseMcpListOutput(input);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'x-api');
  assert.equal(out[0].transport, 'http');
  assert.equal(out[0].url, 'https://example.com/mcp');
});

test('parseMcpListOutput: parses SSE entries (no (HTTP) suffix)', () => {
  const input = 'gmail: https://gmail.example.com/mcp - ✓ Connected\n';
  const out = parseMcpListOutput(input);
  assert.equal(out.length, 1);
  assert.equal(out[0].transport, 'sse');
});

test('parseMcpListOutput: skips noise lines', () => {
  const input = `Checking MCP server health...
Note: workspace trust dialog skipped.

`;
  const out = parseMcpListOutput(input);
  assert.equal(out.length, 0);
});

test('bellVisibleName: simple name', () => {
  assert.equal(bellVisibleName('caveat', 'caveat_record'), 'mcp__caveat__caveat_record');
});

test('bellVisibleName: spaces and dots are normalised to underscores', () => {
  assert.equal(
    bellVisibleName('claude.ai Gmail', 'search_threads'),
    'mcp__claude_ai_Gmail__search_threads'
  );
});

test('bellVisibleName: hyphens preserved', () => {
  assert.equal(bellVisibleName('x-api', 'fetch_tweet'), 'mcp__x-api__fetch_tweet');
});

test('parseFrontmatter: extracts name and description', () => {
  const text = `---
name: council
description: Convene a four-voice council for ambiguous decisions.
origin: ECC
---

# Body`;
  const fm = parseFrontmatter(text);
  assert.equal(fm.name, 'council');
  assert.equal(fm.description, 'Convene a four-voice council for ambiguous decisions.');
  assert.equal(fm.origin, 'ECC');
});

test('parseFrontmatter: strips quotes around values', () => {
  const text = `---
name: "quoted-name"
description: 'single-quoted'
---`;
  const fm = parseFrontmatter(text);
  assert.equal(fm.name, 'quoted-name');
  assert.equal(fm.description, 'single-quoted');
});

test('parseFrontmatter: absent frontmatter returns empty object', () => {
  assert.deepEqual(parseFrontmatter('# Just a markdown file'), {});
  assert.deepEqual(parseFrontmatter(''), {});
});

test('listSkillsAll: reads user-scope skills from projectRoot if configured', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'spotter-skill-'));
  try {
    const skillDir = join(projectRoot, '.claude', 'skills', 'my-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      `---\nname: my-skill\ndescription: Does a project-specific thing.\n---\n\nBody\n`,
      'utf8'
    );
    const skills = await listSkillsAll({ projectRoot });
    assert.equal(skills.get('my-skill'), 'Does a project-specific thing.');
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('listSkillsAll: skips skill with missing description', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'spotter-skill-'));
  try {
    const skillDir = join(projectRoot, '.claude', 'skills', 'no-desc');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      `---\nname: no-desc\n---\n\nBody\n`,
      'utf8'
    );
    const skills = await listSkillsAll({ projectRoot });
    assert.equal(skills.has('no-desc'), false);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('listAgentsAll: reads project-scope agents', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'spotter-agent-'));
  try {
    const agentsDir = join(projectRoot, '.claude', 'agents');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, 'my-agent.md'),
      `---\nname: my-agent\ndescription: Expert in project-specific reviews.\n---\n\nBody\n`,
      'utf8'
    );
    const agents = await listAgentsAll({ projectRoot });
    assert.equal(agents.get('my-agent'), 'Expert in project-specific reviews.');
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('listAgentsAll: skips non-.md files in project scope', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'spotter-agent-'));
  try {
    const agentsDir = join(projectRoot, '.claude', 'agents');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, 'README.txt'), 'not an agent\n', 'utf8');
    const agents = await listAgentsAll({ projectRoot });
    // Bare name must not appear. (Other user/plugin scope agents may legitimately
    // populate the Map — we only assert the non-md file wasn't picked up.)
    assert.equal(agents.has('README'), false);
    assert.equal(agents.has('README.txt'), false);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('describeServer: stdio entry with env', () => {
  const desc = describeServer('x-api', {
    command: 'cmd',
    args: ['/c', 'node', 'server.js'],
    env: { X_BEARER_TOKEN: 'secret' },
  });
  assert.deepEqual(desc, {
    name: 'x-api',
    transport: 'stdio',
    command: 'cmd',
    args: ['/c', 'node', 'server.js'],
    env: { X_BEARER_TOKEN: 'secret' },
  });
});

test('describeServer: stdio entry without args/env', () => {
  const desc = describeServer('foo', { command: 'node' });
  assert.equal(desc.transport, 'stdio');
  assert.deepEqual(desc.args, []);
  assert.deepEqual(desc.env, {});
});

test('describeServer: http entry with headers', () => {
  const desc = describeServer('api', {
    url: 'https://example.com/mcp',
    headers: { Authorization: 'Bearer xxx' },
  });
  assert.deepEqual(desc, {
    name: 'api',
    transport: 'http',
    url: 'https://example.com/mcp',
    headers: { Authorization: 'Bearer xxx' },
  });
});

test('describeServer: sse transport distinguished via type field', () => {
  const desc = describeServer('s', { url: 'https://x.test/mcp', type: 'sse' });
  assert.equal(desc.transport, 'sse');
});

test('describeServer: unrecognised entry returns null', () => {
  assert.equal(describeServer('weird', { foo: 'bar' }), null);
});

test('readMcpServers: project scope overrides user scope on name collision', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'spotter-mcpcfg-'));
  try {
    await writeFile(
      join(projectRoot, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'shared': { command: 'project-node', args: ['p.js'] },
          'project-only': { command: 'proj-only' },
        },
      }),
      'utf8'
    );
    // Note: this test reads the REAL user scope ~/.claude/.mcp.json. We only assert
    // that project-scope entries override and project-only entries are present —
    // we do not assert on unrelated user-scope entries.
    const merged = await readMcpServers({ projectRoot });
    assert.deepEqual(merged['shared'], { command: 'project-node', args: ['p.js'] });
    assert.deepEqual(merged['project-only'], { command: 'proj-only' });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('readMcpServers: missing project file falls back to user only', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'spotter-mcpcfg-'));
  try {
    const withProject = await readMcpServers({ projectRoot });
    const withoutProject = await readMcpServers();
    // The two should be identical when no project .mcp.json exists.
    assert.deepEqual(Object.keys(withProject).sort(), Object.keys(withoutProject).sort());
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('filterClaudeAiBaseline: all three servers present → full 25-tool baseline', () => {
  const present = new Set(['claude.ai Gmail', 'claude.ai Google Calendar', 'claude.ai Google Drive']);
  const out = filterClaudeAiBaseline(present);
  assert.equal(out.size, 25);
  assert.ok(out.has('mcp__claude_ai_Gmail__search_threads'));
  assert.ok(out.has('mcp__claude_ai_Google_Calendar__list_events'));
  assert.ok(out.has('mcp__claude_ai_Google_Drive__search_files'));
});

test('filterClaudeAiBaseline: only Gmail present → only Gmail tools injected', () => {
  const present = new Set(['claude.ai Gmail', 'unrelated-server']);
  const out = filterClaudeAiBaseline(present);
  assert.equal(out.size, 10);
  assert.ok(out.has('mcp__claude_ai_Gmail__search_threads'));
  assert.ok(!out.has('mcp__claude_ai_Google_Calendar__list_events'));
  assert.ok(!out.has('mcp__claude_ai_Google_Drive__search_files'));
});

test('filterClaudeAiBaseline: none of the three present → empty result', () => {
  const present = new Set(['openclaw-tools', 'local-tools']);
  const out = filterClaudeAiBaseline(present);
  assert.equal(out.size, 0);
});

test('resolveAll: prunes local entries no longer in toolNames (project shed a tool)', async () => {
  const { dir, localPath, globalPath } = await setupPaths();
  // Local has two tools; this refresh discovers only `keep`.
  await saveDb(localPath, { version: 1, tools: { keep: 'kept desc', gone: 'stale desc' } });
  await saveDb(globalPath, { version: 1, tools: { keep: 'kept desc', gone: 'stale desc' } });
  const investigate = async () => { throw new Error('should not be called when local hits'); };
  const resolved = await resolveAll({
    toolNames: ['keep'],
    localPath,
    globalPath,
    investigate,
  });
  assert.equal(resolved.has('gone'), false);
  assert.equal(resolved.get('keep').description, 'kept desc');
  // Local file pruned `gone`, kept `keep`.
  const localAfter = await loadDb(localPath);
  assert.equal(localAfter.tools.keep, 'kept desc');
  assert.equal(localAfter.tools.gone, undefined);
  // Global remains untouched (knowledge store is append-only).
  const globalAfter = await loadDb(globalPath);
  assert.equal(globalAfter.tools.gone, 'stale desc');
  await rm(dir, { recursive: true, force: true });
});

test('resolveAll: investigate failure on requested tool keeps existing local value (no prune)', async () => {
  const { dir, localPath, globalPath } = await setupPaths();
  await saveDb(localPath, { version: 1, tools: { foo: 'cached desc' } });
  // Force re-investigation by creating drift (global differs), then have investigate fail.
  await saveDb(globalPath, { version: 1, tools: { foo: 'old global' } });
  const investigate = async () => null;
  const resolved = await resolveAll({
    toolNames: ['foo'],
    localPath,
    globalPath,
    investigate,
  });
  // Local existing value retained because foo is still requested (just transiently uninvestigable).
  assert.equal(resolved.get('foo').description, 'cached desc');
  const localAfter = await loadDb(localPath);
  assert.equal(localAfter.tools.foo, 'cached desc');
  await rm(dir, { recursive: true, force: true });
});

test('readLocal: returns ONLY local entries — global tools must not leak in', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'spotter-readlocal-'));
  try {
    // Manually seed only the local DB; readLocal must ignore the global DB entirely.
    const { localDbPath } = await import('../src/tool-db/loader.mjs');
    await saveDb(localDbPath(projectRoot), {
      version: 1,
      tools: { 'mcp__local__only': 'local-only desc' },
    });
    const tools = await readLocal({ projectRoot });
    const names = tools.map((t) => t.name);
    assert.deepEqual(names, ['mcp__local__only']);
    // Sanity: even if the real ~/.spotter/tool-db.json exists with hundreds of tools,
    // readLocal must only return the single local entry above.
    assert.equal(tools.length, 1);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
