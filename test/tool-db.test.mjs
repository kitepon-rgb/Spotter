import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDb, saveDb, emptyDb, ToolDbSchemaError } from '../src/tool-db/loader.mjs';
import { resolveAll } from '../src/tool-db/lookup.mjs';
import { readLocal } from '../src/tool-db/refresh.mjs';
import { parseMcpListOutput, bellVisibleName, buildStdioSpawn } from '../src/tool-db/investigate-mcp.mjs';
import { parseFrontmatter } from '../src/tool-db/frontmatter.mjs';
import { listSkillsAll } from '../src/tool-db/investigate-skills.mjs';
import { listAgentsAll } from '../src/tool-db/investigate-agents.mjs';
import {
  describeServer,
  readMcpServers,
  normalizeProjectPath,
  extractUserScopeServers,
  findLocalScopeServers,
} from '../src/tool-db/mcp-config.mjs';
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

test('parseMcpListOutput: parses stdio entries (command + args extracted from list line, v1.2.5)', () => {
  // v1.2.5: stdio entries now carry command + args parsed directly from the
  // `claude mcp list` line. This makes `claude mcp get` unnecessary for the
  // catalog spawn path, which is the only way plugin-scoped servers (which
  // `mcp get` cannot reach) become spawnable.
  const input = `Checking MCP server health...

caveat: C:\\Program Files\\nodejs\\node.exe --foo /a/b/c.js mcp-server - ✓ Connected
`;
  const out = parseMcpListOutput(input);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'caveat');
  assert.equal(out[0].transport, 'stdio');
  assert.equal(out[0].command, 'C:\\Program Files\\nodejs\\node.exe');
  assert.deepEqual(out[0].args, ['--foo', '/a/b/c.js', 'mcp-server']);
});

test('parseMcpListOutput: handles quoted stdio args', () => {
  const input = 'quoted: node "C:\\Users\\me\\MCP Servers\\server.js" --name "two words" - ✓ Connected\n';
  const out = parseMcpListOutput(input);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'quoted');
  assert.equal(out[0].transport, 'stdio');
  assert.equal(out[0].command, 'node');
  assert.deepEqual(out[0].args, ['C:\\Users\\me\\MCP Servers\\server.js', '--name', 'two words']);
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

// Regression for v1.2.5: plugin-scoped server names contain internal colons
// (e.g. "plugin:everything-claude-code:context7"). The previous splitter used
// `indexOf(':')` and collapsed six distinct ECC plugin MCPs into the literal
// "plugin", so `claude mcp get plugin` failed six times and the servers'
// tools were silently dropped from the catalog. The fix switched to the ": "
// (colon + space) delimiter, which the CLI uses unambiguously between name
// and rest.
test('parseMcpListOutput: preserves colons inside plugin-scoped names (stdio)', () => {
  const input = 'plugin:everything-claude-code:context7: npx -y @upstash/context7-mcp@2.1.4 - ✓ Connected\n';
  const out = parseMcpListOutput(input);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'plugin:everything-claude-code:context7');
  assert.equal(out[0].transport, 'stdio');
  // v1.2.5: plugin servers carry command + args from the list line because
  // `claude mcp get plugin:...` returns "No MCP server found" — the list line
  // is the only authoritative source.
  assert.equal(out[0].command, 'npx');
  assert.deepEqual(out[0].args, ['-y', '@upstash/context7-mcp@2.1.4']);
});

test('parseMcpListOutput: preserves colons inside plugin-scoped names (HTTP)', () => {
  const input = 'plugin:everything-claude-code:exa: https://mcp.exa.ai/mcp (HTTP) - ✓ Connected\n';
  const out = parseMcpListOutput(input);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'plugin:everything-claude-code:exa');
  assert.equal(out[0].transport, 'http');
  assert.equal(out[0].url, 'https://mcp.exa.ai/mcp');
});

test('parseMcpListOutput: name with spaces still parses (claude.ai baseline)', () => {
  const input = 'claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ✓ Connected\n';
  const out = parseMcpListOutput(input);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'claude.ai Google Drive');
  assert.equal(out[0].transport, 'sse');
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

// --- buildStdioSpawn: Windows .cmd shim coverage (regression for v1.2.2) ---
//
// Bug: until v1.2.1 the Windows branch only wrapped commands whose name literally
// ended in `.cmd`/`.bat`. MCP servers registered with a bare name like
// `claude-mermaid` (npm-global CLI shim) skipped the wrap, and Node's spawn could
// not resolve PATHEXT to find `claude-mermaid.cmd` → ENOENT during investigate.

test('buildStdioSpawn: POSIX always passes command through unchanged', () => {
  if (process.platform === 'win32') return;
  // Bare name
  assert.deepEqual(buildStdioSpawn('node', ['x.js']), { cmd: 'node', cmdArgs: ['x.js'] });
  // Absolute path
  assert.deepEqual(
    buildStdioSpawn('/usr/bin/node', ['x.js']),
    { cmd: '/usr/bin/node', cmdArgs: ['x.js'] }
  );
  // Even a `.cmd` extension on POSIX stays direct (POSIX has no batch interpreter).
  assert.deepEqual(buildStdioSpawn('foo.cmd', []), { cmd: 'foo.cmd', cmdArgs: [] });
});

test('buildStdioSpawn: Windows wraps bare command names through cmd.exe (v1.2.2 fix)', () => {
  if (process.platform !== 'win32') return;
  // Bare npm-global CLI name — the case that broke v1.2.1.
  assert.deepEqual(
    buildStdioSpawn('claude-mermaid', ['--foo']),
    { cmd: 'cmd.exe', cmdArgs: ['/c', 'claude-mermaid', '--foo'] }
  );
  // Even `node` (which has a real .exe on PATH) goes through cmd.exe — extra layer
  // but works, and avoids special-casing every known builtin.
  assert.deepEqual(
    buildStdioSpawn('node', ['x.js']),
    { cmd: 'cmd.exe', cmdArgs: ['/c', 'node', 'x.js'] }
  );
});

test('buildStdioSpawn: Windows wraps explicit .cmd / .bat extensions through cmd.exe', () => {
  if (process.platform !== 'win32') return;
  assert.deepEqual(
    buildStdioSpawn('claude-mermaid.cmd', ['arg']),
    { cmd: 'cmd.exe', cmdArgs: ['/c', 'claude-mermaid.cmd', 'arg'] }
  );
  assert.deepEqual(
    buildStdioSpawn('script.BAT', []),
    { cmd: 'cmd.exe', cmdArgs: ['/c', 'script.BAT'] }
  );
});

test('buildStdioSpawn: Windows leaves absolute .exe paths un-wrapped (avoids cmd.exe quoting risk)', () => {
  if (process.platform !== 'win32') return;
  // Absolute .exe path with spaces — wrapping through cmd.exe /c here would expose
  // us to cmd.exe's quoting rules. We have a known-good binary path; spawn it directly.
  assert.deepEqual(
    buildStdioSpawn('C:\\Program Files\\nodejs\\node.exe', ['server.js']),
    { cmd: 'C:\\Program Files\\nodejs\\node.exe', cmdArgs: ['server.js'] }
  );
  // Case-insensitive `.exe` match.
  assert.deepEqual(
    buildStdioSpawn('C:\\tools\\Foo.EXE', []),
    { cmd: 'C:\\tools\\Foo.EXE', cmdArgs: [] }
  );
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

test('parseFrontmatter: supports folded block scalar descriptions', () => {
  const text = `---
name: folded
description: >
  Convene a four-voice council
  for ambiguous decisions.

  Preserve paragraph breaks.
origin: ECC
---

# Body`;
  const fm = parseFrontmatter(text);
  assert.equal(fm.name, 'folded');
  assert.equal(fm.description, 'Convene a four-voice council for ambiguous decisions.\nPreserve paragraph breaks.');
  assert.equal(fm.origin, 'ECC');
});

test('parseFrontmatter: supports literal block scalar descriptions', () => {
  const text = `---
name: literal
description: |
  Line one.
  Line two.
origin: ECC
---`;
  const fm = parseFrontmatter(text);
  assert.equal(fm.description, 'Line one.\nLine two.');
  assert.equal(fm.origin, 'ECC');
});

test('parseFrontmatter: absent frontmatter returns empty object', () => {
  assert.deepEqual(parseFrontmatter('# Just a markdown file'), {});
  assert.deepEqual(parseFrontmatter(''), {});
});

test('listSkillsAll: reads skill with block scalar description', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'spotter-skill-block-'));
  try {
    const skillDir = join(projectRoot, '.claude', 'skills', 'block-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      `---\nname: block-skill\ndescription: >\n  Does a project-specific thing\n  with multiline frontmatter.\n---\n\nBody\n`,
      'utf8'
    );
    const skills = await listSkillsAll({ projectRoot });
    assert.equal(skills.get('block-skill'), 'Does a project-specific thing with multiline frontmatter.');
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
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

// --- Official scope coverage (User / Project / Local) ---
//
// These tests inject `claudeJsonPath` and `legacyUserPath` so they don't read or write
// the real homedir. The injection keeps tests hermetic and allows asserting on full
// merged state, not just the keys we wrote.

async function setupScopeFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-scope-'));
  return {
    dir,
    projectRoot: dir, // use dir itself as the project root
    claudeJsonPath: join(dir, '.claude.json'),
    legacyUserPath: join(dir, 'legacy-user.mcp.json'),
  };
}

test('readMcpServers: user scope only — pulls servers from ~/.claude.json mcpServers', async () => {
  const fx = await setupScopeFixture();
  try {
    await writeFile(
      fx.claudeJsonPath,
      JSON.stringify({
        mcpServers: {
          'openai-image': {
            command: '/path/to/openai-image-mcp',
            env: { OPENAI_API_KEY: 'sk-user-scope' },
          },
        },
      }),
      'utf8'
    );
    const merged = await readMcpServers({
      projectRoot: fx.projectRoot,
      claudeJsonPath: fx.claudeJsonPath,
      legacyUserPath: fx.legacyUserPath,
    });
    assert.deepEqual(merged['openai-image'], {
      command: '/path/to/openai-image-mcp',
      env: { OPENAI_API_KEY: 'sk-user-scope' },
    });
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});

test('readMcpServers: local scope only — projects[<root>].mcpServers picked up', async () => {
  const fx = await setupScopeFixture();
  try {
    await writeFile(
      fx.claudeJsonPath,
      JSON.stringify({
        projects: {
          [fx.projectRoot]: {
            mcpServers: {
              'local-only': { command: 'node', args: ['x.js'], env: { LOCAL: '1' } },
            },
          },
        },
      }),
      'utf8'
    );
    const merged = await readMcpServers({
      projectRoot: fx.projectRoot,
      claudeJsonPath: fx.claudeJsonPath,
      legacyUserPath: fx.legacyUserPath,
    });
    assert.deepEqual(merged['local-only'], {
      command: 'node',
      args: ['x.js'],
      env: { LOCAL: '1' },
    });
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});

test('readMcpServers: precedence Local > Project > User > legacy on name collision', async () => {
  const fx = await setupScopeFixture();
  try {
    // Legacy user (lowest priority).
    await writeFile(
      fx.legacyUserPath,
      JSON.stringify({ mcpServers: { shared: { command: 'legacy', env: { TIER: 'legacy' } } } }),
      'utf8'
    );
    // User scope + local scope, both keyed under the same projectRoot.
    await writeFile(
      fx.claudeJsonPath,
      JSON.stringify({
        mcpServers: {
          shared: { command: 'user', env: { TIER: 'user' } },
        },
        projects: {
          [fx.projectRoot]: {
            mcpServers: {
              shared: { command: 'local', env: { TIER: 'local' } },
            },
          },
        },
      }),
      'utf8'
    );
    // Project scope.
    await writeFile(
      join(fx.projectRoot, '.mcp.json'),
      JSON.stringify({ mcpServers: { shared: { command: 'project', env: { TIER: 'project' } } } }),
      'utf8'
    );

    const merged = await readMcpServers({
      projectRoot: fx.projectRoot,
      claudeJsonPath: fx.claudeJsonPath,
      legacyUserPath: fx.legacyUserPath,
    });
    assert.deepEqual(merged['shared'], { command: 'local', env: { TIER: 'local' } });

    // Drop local — project wins.
    await writeFile(
      fx.claudeJsonPath,
      JSON.stringify({
        mcpServers: { shared: { command: 'user', env: { TIER: 'user' } } },
      }),
      'utf8'
    );
    const m2 = await readMcpServers({
      projectRoot: fx.projectRoot,
      claudeJsonPath: fx.claudeJsonPath,
      legacyUserPath: fx.legacyUserPath,
    });
    assert.deepEqual(m2['shared'], { command: 'project', env: { TIER: 'project' } });

    // Drop project — user wins over legacy.
    await rm(join(fx.projectRoot, '.mcp.json'));
    const m3 = await readMcpServers({
      projectRoot: fx.projectRoot,
      claudeJsonPath: fx.claudeJsonPath,
      legacyUserPath: fx.legacyUserPath,
    });
    assert.deepEqual(m3['shared'], { command: 'user', env: { TIER: 'user' } });

    // Drop user — legacy is last resort.
    await writeFile(fx.claudeJsonPath, JSON.stringify({}), 'utf8');
    const m4 = await readMcpServers({
      projectRoot: fx.projectRoot,
      claudeJsonPath: fx.claudeJsonPath,
      legacyUserPath: fx.legacyUserPath,
    });
    assert.deepEqual(m4['shared'], { command: 'legacy', env: { TIER: 'legacy' } });
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});

test('readMcpServers: missing ~/.claude.json — no error, scopes 2 & 4 just empty', async () => {
  const fx = await setupScopeFixture();
  try {
    // Don't create claudeJsonPath at all.
    await writeFile(
      join(fx.projectRoot, '.mcp.json'),
      JSON.stringify({ mcpServers: { onlyproj: { command: 'p' } } }),
      'utf8'
    );
    const merged = await readMcpServers({
      projectRoot: fx.projectRoot,
      claudeJsonPath: fx.claudeJsonPath,
      legacyUserPath: fx.legacyUserPath,
    });
    assert.deepEqual(merged['onlyproj'], { command: 'p' });
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});

test('readMcpServers: malformed ~/.claude.json — treated as empty (no throw)', async () => {
  const fx = await setupScopeFixture();
  try {
    await writeFile(fx.claudeJsonPath, '{not valid json', 'utf8');
    await writeFile(
      join(fx.projectRoot, '.mcp.json'),
      JSON.stringify({ mcpServers: { onlyproj: { command: 'p' } } }),
      'utf8'
    );
    const merged = await readMcpServers({
      projectRoot: fx.projectRoot,
      claudeJsonPath: fx.claudeJsonPath,
      legacyUserPath: fx.legacyUserPath,
    });
    assert.deepEqual(merged['onlyproj'], { command: 'p' });
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});

test('readMcpServers: ~/.claude.json without mcpServers / projects keys — no error', async () => {
  const fx = await setupScopeFixture();
  try {
    await writeFile(fx.claudeJsonPath, JSON.stringify({ unrelatedField: 'foo' }), 'utf8');
    const merged = await readMcpServers({
      projectRoot: fx.projectRoot,
      claudeJsonPath: fx.claudeJsonPath,
      legacyUserPath: fx.legacyUserPath,
    });
    assert.equal(typeof merged, 'object');
    assert.deepEqual(merged, {});
  } finally {
    await rm(fx.dir, { recursive: true, force: true });
  }
});

test('extractUserScopeServers: handles null / non-object inputs', () => {
  assert.deepEqual(extractUserScopeServers(null), {});
  assert.deepEqual(extractUserScopeServers(undefined), {});
  assert.deepEqual(extractUserScopeServers({}), {});
  assert.deepEqual(extractUserScopeServers({ mcpServers: null }), {});
  assert.deepEqual(extractUserScopeServers({ mcpServers: 'string' }), {});
  assert.deepEqual(extractUserScopeServers({ mcpServers: { a: { command: 'x' } } }), {
    a: { command: 'x' },
  });
});

test('normalizeProjectPath: separator / trailing slash / Windows case', () => {
  assert.equal(normalizeProjectPath('/home/u/proj'), '/home/u/proj');
  assert.equal(normalizeProjectPath('/home/u/proj/'), '/home/u/proj');
  assert.equal(normalizeProjectPath('/home/u/proj//'), '/home/u/proj');
  // Backslash handling differs by platform: Windows treats `\` as a separator and
  // canonicalizes to `/` + lower-case; POSIX treats `\` as a literal filename
  // character and leaves it untouched (case stays significant). This split is
  // required so that on POSIX, a Windows-shaped key like `C:\Users\u\proj` does
  // NOT collide with a POSIX-shaped input like `C:/Users/u/proj` — see the
  // `findLocalScopeServers: separator variant matches on Windows only` test.
  assert.equal(
    normalizeProjectPath('C:\\Users\\u\\proj'),
    process.platform === 'win32' ? 'c:/users/u/proj' : 'C:\\Users\\u\\proj'
  );
  // Mixed slashes — Windows canonicalizes everything, POSIX strips only trailing
  // slashes.
  assert.equal(
    normalizeProjectPath('C:/Users\\u/proj/'),
    process.platform === 'win32' ? 'c:/users/u/proj' : 'C:/Users\\u/proj'
  );
  // Empty / non-string.
  assert.equal(normalizeProjectPath(''), '');
  assert.equal(normalizeProjectPath(null), '');
  assert.equal(normalizeProjectPath(42), '');
});

test('findLocalScopeServers: exact key hit', () => {
  const claudeJson = {
    projects: {
      '/home/u/proj': { mcpServers: { foo: { command: 'x' } } },
    },
  };
  assert.deepEqual(findLocalScopeServers(claudeJson, '/home/u/proj'), { foo: { command: 'x' } });
});

test('findLocalScopeServers: trailing-slash variant matches', () => {
  const claudeJson = {
    projects: {
      '/home/u/proj': { mcpServers: { foo: { command: 'x' } } },
    },
  };
  assert.deepEqual(findLocalScopeServers(claudeJson, '/home/u/proj/'), { foo: { command: 'x' } });
});

test('findLocalScopeServers: separator variant matches on Windows only', () => {
  const claudeJson = {
    projects: {
      'C:\\Users\\u\\proj': { mcpServers: { foo: { command: 'x' } } },
    },
  };
  if (process.platform === 'win32') {
    assert.deepEqual(findLocalScopeServers(claudeJson, 'C:/Users/u/proj'), {
      foo: { command: 'x' },
    });
    // Drive-letter case difference also matches.
    assert.deepEqual(findLocalScopeServers(claudeJson, 'c:\\users\\u\\proj'), {
      foo: { command: 'x' },
    });
  } else {
    // On POSIX, the literal `C:\Users\u\proj` is not the same path as
    // `C:/Users/u/proj` (and case-sensitive). Don't match.
    assert.deepEqual(findLocalScopeServers(claudeJson, 'C:/Users/u/proj'), {});
  }
});

test('findLocalScopeServers: no key match returns empty (no fuzzy/prefix match)', () => {
  const claudeJson = {
    projects: {
      '/home/u/some-project': { mcpServers: { foo: { command: 'x' } } },
    },
  };
  // Sibling project must NOT inherit servers from another project key.
  assert.deepEqual(findLocalScopeServers(claudeJson, '/home/u/other-project'), {});
  // Prefix must NOT match (no parent walk-up).
  assert.deepEqual(findLocalScopeServers(claudeJson, '/home/u'), {});
});

test('findLocalScopeServers: missing projects / non-object inputs', () => {
  assert.deepEqual(findLocalScopeServers(null, '/x'), {});
  assert.deepEqual(findLocalScopeServers({}, '/x'), {});
  assert.deepEqual(findLocalScopeServers({ projects: null }, '/x'), {});
  assert.deepEqual(findLocalScopeServers({ projects: {} }, '/x'), {});
  assert.deepEqual(
    findLocalScopeServers({ projects: { '/x': { mcpServers: null } } }, '/x'),
    {}
  );
  assert.deepEqual(findLocalScopeServers({ projects: { '/x': null } }, '/x'), {});
  assert.deepEqual(findLocalScopeServers({ projects: { '/x': {} } }, '/x'), {});
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
