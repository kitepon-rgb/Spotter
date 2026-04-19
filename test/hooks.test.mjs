import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatTransparentContext,
  formatTransparentBlockReason,
  isChildCall,
  isSubagentCall,
} from '../src/hooks/lib.mjs';

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

test('isChildCall: true when SPOTTER_PARENT_PID env is set', () => {
  const prev = process.env.SPOTTER_PARENT_PID;
  try {
    process.env.SPOTTER_PARENT_PID = '12345';
    assert.equal(isChildCall(), true);
    process.env.SPOTTER_PARENT_PID = '';
    assert.equal(isChildCall(), false);
    delete process.env.SPOTTER_PARENT_PID;
    assert.equal(isChildCall(), false);
  } finally {
    if (prev === undefined) delete process.env.SPOTTER_PARENT_PID;
    else process.env.SPOTTER_PARENT_PID = prev;
  }
});

test('isSubagentCall: true when input.agent_id is a non-empty string', () => {
  assert.equal(isSubagentCall({ agent_id: 'abc' }), true);
  assert.equal(isSubagentCall({ agent_id: '' }), false);
  assert.equal(isSubagentCall({}), false);
  assert.equal(isSubagentCall(null), false);
  assert.equal(isSubagentCall(undefined), false);
  assert.equal(isSubagentCall({ agent_id: 42 }), false);
});
