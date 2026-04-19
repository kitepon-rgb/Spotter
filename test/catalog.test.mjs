import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCatalog, CatalogSchemaError, projectForFirstStage } from '../src/catalog/schema.mjs';

test('validateCatalog: accepts minimal valid catalog', () => {
  const input = {
    version: 1,
    tools: [
      {
        name: 'current_time',
        purpose: 'Get the current time.',
        when_to_use: ['time questions'],
      },
    ],
  };
  const out = validateCatalog(input);
  assert.equal(out.tools[0].name, 'current_time');
});

test('validateCatalog: rejects wrong version', () => {
  assert.throws(
    () => validateCatalog({ version: 2, tools: [] }),
    (err) => err instanceof CatalogSchemaError && err.path === '$.version'
  );
});

test('validateCatalog: rejects non-object root', () => {
  assert.throws(
    () => validateCatalog([]),
    (err) => err instanceof CatalogSchemaError && err.path === '$'
  );
  assert.throws(
    () => validateCatalog(null),
    (err) => err instanceof CatalogSchemaError
  );
});

test('validateCatalog: rejects empty tools array', () => {
  assert.throws(
    () => validateCatalog({ version: 1, tools: [] }),
    (err) => err instanceof CatalogSchemaError && err.path === '$.tools'
  );
});

test('validateCatalog: rejects duplicate tool names', () => {
  const input = {
    version: 1,
    tools: [
      { name: 'foo', purpose: 'p', when_to_use: ['x'] },
      { name: 'foo', purpose: 'p', when_to_use: ['y'] },
    ],
  };
  assert.throws(
    () => validateCatalog(input),
    (err) => err instanceof CatalogSchemaError && err.message.includes('duplicate')
  );
});

test('validateCatalog: rejects tool missing required field', () => {
  const input = {
    version: 1,
    tools: [{ name: 'foo', purpose: 'p' }],
  };
  assert.throws(
    () => validateCatalog(input),
    (err) => err instanceof CatalogSchemaError && err.message.includes('when_to_use')
  );
});

test('validateCatalog: validates test_cases', () => {
  const input = {
    version: 1,
    tools: [
      {
        name: 'foo',
        purpose: 'p',
        when_to_use: ['x'],
        test_cases: [{ user_input: '?', expected_tool: 'foo' }],
      },
    ],
  };
  assert.doesNotThrow(() => validateCatalog(input));

  const bad = {
    version: 1,
    tools: [
      {
        name: 'foo',
        purpose: 'p',
        when_to_use: ['x'],
        test_cases: [{ user_input: '?' }], // missing expected_tool
      },
    ],
  };
  assert.throws(() => validateCatalog(bad), CatalogSchemaError);
});

test('projectForFirstStage: only exposes purpose/when_to_use', () => {
  const catalog = {
    version: 1,
    tools: [
      {
        name: 'foo',
        purpose: 'p',
        when_to_use: ['x'],
        usage: 'foo <arg>',
        examples: [{ input: 'a', call: 'foo a' }],
        keywords: ['k'],
      },
    ],
  };
  const proj = projectForFirstStage(catalog);
  assert.deepEqual(Object.keys(proj[0]).sort(), ['name', 'purpose', 'when_to_use']);
});
