import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTransparentContext, formatTransparentBlockReason } from '../src/hooks/lib.mjs';

test('formatTransparentContext: mentions Spotter explicitly (§12.2)', () => {
  const text = formatTransparentContext([
    { name: 'current_time', reason: 'time question' },
  ]);
  assert.ok(text.includes('Spotter'));
  assert.ok(text.includes('current_time'));
  assert.ok(text.includes('time question'));
});

test('formatTransparentBlockReason: mentions Spotter and asks for correction (§12.3)', () => {
  const text = formatTransparentBlockReason([
    { name: 'web_search', reason: 'latest news' },
  ]);
  assert.ok(text.includes('Spotter'));
  assert.ok(text.includes('web_search'));
  assert.ok(text.includes('指摘'));
});

test('formatTransparentContext: handles multiple tools', () => {
  const text = formatTransparentContext([
    { name: 'a', reason: 'r1' },
    { name: 'b', reason: 'r2' },
  ]);
  assert.ok(text.includes('a'));
  assert.ok(text.includes('b'));
  assert.ok(text.includes('r1'));
  assert.ok(text.includes('r2'));
});
