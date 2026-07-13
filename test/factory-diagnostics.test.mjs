import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { runFactoryDiagnostics } from '../src/cli/factory-diagnostics.mjs';

const codexConfigured = async () => ({ readiness: 'configured-unverified' });
const execFileAsync = promisify(execFile);

test('factory diagnostics: 非activation projectは固定fieldだけで対象外を返す', async () => {
  const root = await temporaryProject();
  const out = await runFactoryDiagnostics({ projectRoot: root });
  assert.equal(out.schema_version, '1.0');
  assert.equal(out.overall_status, 'not_applicable');
  assert.equal(out.checks[0].status, 'skipped');
  assert.deepEqual(Object.keys(out).sort(), [
    'catalogs', 'checks', 'codex_hook_readiness', 'marker_schema_version',
    'overall_status', 'product', 'runtime_error_store', 'schema_version', 'throughline_context', 'version',
  ]);
  assert.equal(out.runtime_error_store.schema, 'spotter.runtime_error_status.v1');
  assertSafe(out);
});

test('factory diagnostics: 正規marker/catalogを既存validatorで検証する', async () => {
  const root = await temporaryProject();
  await activate(root, { markerVersion: '2', auditorContext: { mode: 'disabled' } });
  await writeCatalog(root, 'tool-db.json');
  await writeCatalog(root, 'tool-db.codex.json');
  const out = await runFactoryDiagnostics({
    projectRoot: root,
    codexHookDiagnosticsFn: codexConfigured,
  });
  assert.equal(out.marker_schema_version, '2');
  assert.equal(out.throughline_context, 'disabled');
  assert.deepEqual(out.catalogs, { claude: 'available', codex: 'available' });
  assert.equal(out.codex_hook_readiness, 'configured-unverified');
  assert.equal(out.overall_status, 'unverified');
  assertSafe(out);
});

test('factory diagnostics: 壊れたmarkerを対象外へ丸めず任意値も漏らさない', async () => {
  const root = await temporaryProject();
  await mkdir(join(root, '.spotter'));
  await writeFile(join(root, '.spotter', 'marker.json'), '{broken');
  const broken = await runFactoryDiagnostics({ projectRoot: root });
  assert.equal(broken.overall_status, 'unverified');
  assert.equal(broken.checks[0].reason_code, 'marker_invalid_json');

  await activate(root, {
    markerVersion: '/Users/kite/token-secret',
    auditorContext: { mode: '/private/session' },
  });
  const hostile = await runFactoryDiagnostics({ projectRoot: root });
  assert.equal(hostile.marker_schema_version, null);
  assert.equal(hostile.throughline_context, 'unverified');
  assert.equal(hostile.overall_status, 'fail');
  assertSafe(hostile);
});

test('factory diagnostics: catalogの不在とschema破損を区別する', async () => {
  const root = await temporaryProject();
  await activate(root, { markerVersion: '1' });
  await mkdir(join(root, '.spotter'), { recursive: true });
  await writeFile(join(root, '.spotter', 'tool-db.json'), '{}');
  const out = await runFactoryDiagnostics({
    projectRoot: root,
    codexHookDiagnosticsFn: async () => ({ readiness: 'not-installed' }),
  });
  assert.equal(out.catalogs.claude, 'invalid');
  assert.equal(out.catalogs.codex, 'missing');
  assert.equal(out.overall_status, 'fail');
  assert.equal(findCheck(out, 'claude_catalog').reason_code, 'catalog_invalid_schema');
  assert.equal(findCheck(out, 'codex_catalog').reason_code, 'catalog_missing');
});

test('factory diagnostics: host catalogが一つも無ければgreenにしない', async () => {
  const root = await temporaryProject();
  await activate(root, { markerVersion: '2', auditorContext: { mode: 'disabled' } });
  const out = await runFactoryDiagnostics({
    projectRoot: root,
    codexHookDiagnosticsFn: async () => ({ readiness: 'not-installed' }),
  });
  assert.equal(out.overall_status, 'unverified');
  assert.equal(findCheck(out, 'audit_catalog_readiness').reason_code, 'no_host_catalog');
});

test('factory diagnostics CLI: snapshotはexit 0、余分な引数はexit 2', async () => {
  const root = await temporaryProject();
  const cli = join(import.meta.dirname, '..', 'bin', 'spotter.mjs');
  const { stdout } = await execFileAsync(process.execPath, [cli, 'diagnostics', 'factory'], { cwd: root });
  assert.equal(JSON.parse(stdout).overall_status, 'not_applicable');
  await assert.rejects(
    execFileAsync(process.execPath, [cli, 'diagnostics', 'factory', '--json'], { cwd: root }),
    (error) => error.code === 2 && /usage: spotter diagnostics factory/.test(error.stderr),
  );
});

async function temporaryProject() {
  return mkdtemp(join(tmpdir(), 'spotter-factory-'));
}

async function activate(root, marker) {
  await mkdir(join(root, '.spotter'), { recursive: true });
  await writeFile(join(root, '.spotter', 'marker.json'), JSON.stringify(marker));
}

async function writeCatalog(root, file) {
  await writeFile(join(root, '.spotter', file), JSON.stringify({ version: 1, tools: {} }));
}

function findCheck(out, id) {
  return out.checks.find((entry) => entry.check_id === id);
}

function assertSafe(value) {
  assert.doesNotMatch(JSON.stringify(value), /(?:\/Users|\\Users|token|secret|private|session)/i);
}
