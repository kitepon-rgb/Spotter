import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDb, saveDb, emptyDb, ToolDbSchemaError } from '../src/tool-db/loader.mjs';
import { resolveAll } from '../src/tool-db/lookup.mjs';
import { parseMcpListOutput, bellVisibleName } from '../src/tool-db/investigate-mcp.mjs';
import { getDeferredDescription, listDeferredNames } from '../src/tool-db/deferred-baseline.mjs';
import { describeServer } from '../src/tool-db/mcp-config.mjs';

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

test('deferred baseline: WebSearch is present and described', () => {
  const desc = getDeferredDescription('WebSearch');
  assert.equal(typeof desc, 'string');
  assert.ok(desc.length > 0);
});

test('deferred baseline: unknown tool returns null', () => {
  assert.equal(getDeferredDescription('NoSuchTool__'), null);
});

test('deferred baseline: listDeferredNames returns an array', () => {
  const names = listDeferredNames();
  assert.ok(Array.isArray(names));
  assert.ok(names.length > 0);
  assert.ok(names.includes('TodoWrite'));
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
