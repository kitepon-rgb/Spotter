import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCatalog, CatalogLoadError, CatalogSchemaError } from '../src/catalog/loader.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('loadCatalog: loads and validates template', async () => {
  // The shipped template must be a valid catalog.
  const cat = await loadCatalog('templates/tools.yaml');
  assert.equal(cat.version, 1);
  assert.ok(cat.tools.length > 0);
});

test('loadCatalog: ENOENT surfaces as CatalogLoadError', async () => {
  await assert.rejects(
    loadCatalog('/nonexistent/tools.yaml'),
    (err) => err instanceof CatalogLoadError && err.message.includes('not found')
  );
});

test('loadCatalog: invalid YAML surfaces as CatalogLoadError', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-test-'));
  const path = join(dir, 'bad.yaml');
  try {
    await writeFile(path, 'tools: [\n  - invalid: :yaml', 'utf8');
    await assert.rejects(
      loadCatalog(path),
      (err) => err instanceof CatalogLoadError && err.message.includes('yaml parse failed')
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadCatalog: schema violation surfaces as CatalogSchemaError', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-test-'));
  const path = join(dir, 'wrong.yaml');
  try {
    await writeFile(path, 'version: 2\ntools: []\n', 'utf8');
    await assert.rejects(
      loadCatalog(path),
      (err) => err instanceof CatalogSchemaError
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
