import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFirstStagePrompt,
  buildFinalStagePrompt,
  buildWarmupPrompt,
  parseHaikuResponse,
  createHaikuCaller,
  HaikuError,
} from '../src/daemon/haiku-caller.mjs';

const sampleCatalog = {
  version: 1,
  tools: [
    { name: 'current_time', purpose: 'get time', when_to_use: ['time questions'] },
    { name: 'web_search', purpose: 'search', when_to_use: ['latest info'] },
  ],
};

test('buildFirstStagePrompt (isFirst=true) includes catalog and rules', () => {
  const prompt = buildFirstStagePrompt({ catalog: sampleCatalog, userInput: '今何時?', isFirst: true });
  assert.ok(prompt.includes('current_time'));
  assert.ok(prompt.includes('今何時?'));
  assert.ok(prompt.includes('pass'));
  assert.ok(prompt.includes('get time'));
});

test('buildWarmupPrompt includes catalog and rules, instructs trivial pass response (A-2)', () => {
  const prompt = buildWarmupPrompt({ catalog: sampleCatalog });
  assert.ok(prompt.includes('current_time'));
  assert.ok(prompt.includes('get time'));
  assert.ok(prompt.includes('ウォームアップ'));
  // Haiku must return the trivial pass object, parseable by parseHaikuResponse
  assert.ok(prompt.includes('"pass": true'));
  assert.ok(prompt.includes('"missing_tools": []'));
  // System rules (schema etc.) must be present so Haiku loads them on this --session-id call
  assert.ok(prompt.includes('出力スキーマ'));
});

test('buildFirstStagePrompt (isFirst=false) omits catalog — incremental form', () => {
  const prompt = buildFirstStagePrompt({ catalog: sampleCatalog, userInput: '今何時?', isFirst: false });
  // Should still include the user input
  assert.ok(prompt.includes('今何時?'));
  // But NOT re-send the catalog
  assert.ok(!prompt.includes('get time'));
  assert.ok(!prompt.includes('"name":'));
});

test('buildFinalStagePrompt (isFirst=true) includes used_tools section', () => {
  const prompt = buildFinalStagePrompt({
    catalog: sampleCatalog,
    userInput: '今何時?',
    usedTools: ['read_file'],
    finalResponse: '深夜ですね',
    isFirst: true,
  });
  assert.ok(prompt.includes('read_file'));
  assert.ok(prompt.includes('深夜ですね'));
  assert.ok(prompt.includes('get time'));
});

test('buildFinalStagePrompt (isFirst=false) omits catalog — incremental form', () => {
  const prompt = buildFinalStagePrompt({
    catalog: sampleCatalog,
    userInput: '今何時?',
    usedTools: ['read_file'],
    finalResponse: '深夜ですね',
    isFirst: false,
  });
  assert.ok(prompt.includes('read_file'));
  assert.ok(prompt.includes('深夜ですね'));
  // Catalog shouldn't be resent
  assert.ok(!prompt.includes('get time'));
});

test('buildFinalStagePrompt handles empty used_tools', () => {
  const prompt = buildFinalStagePrompt({
    catalog: sampleCatalog,
    userInput: '?',
    usedTools: [],
    finalResponse: 'r',
    isFirst: true,
  });
  assert.ok(prompt.includes('なし'));
});

test('createHaikuCaller throws without haikuSessionId', () => {
  assert.throws(
    () => createHaikuCaller({ timeoutMs: 1000 }),
    TypeError
  );
});

test('createHaikuCaller throws on invalid timeout', () => {
  assert.throws(
    () => createHaikuCaller({ haikuSessionId: 'abc', timeoutMs: 0 }),
    TypeError
  );
});

test('parseHaikuResponse: accepts valid pass=true', () => {
  const raw = JSON.stringify({ pass: true, missing_tools: [] });
  const parsed = parseHaikuResponse(raw);
  assert.equal(parsed.pass, true);
  assert.deepEqual(parsed.missing_tools, []);
});

test('parseHaikuResponse: accepts valid pass=false with tools', () => {
  const raw = JSON.stringify({
    pass: false,
    missing_tools: [{ name: 'current_time', reason: 'time question' }],
  });
  const parsed = parseHaikuResponse(raw);
  assert.equal(parsed.pass, false);
  assert.equal(parsed.missing_tools.length, 1);
});

test('parseHaikuResponse: tolerates ```json fence', () => {
  const raw = '```json\n{"pass": true, "missing_tools": []}\n```';
  const parsed = parseHaikuResponse(raw);
  assert.equal(parsed.pass, true);
});

test('parseHaikuResponse: throws on invalid JSON', () => {
  assert.throws(
    () => parseHaikuResponse('not json at all'),
    (err) => err instanceof HaikuError && err.code === 'E_HAIKU_SCHEMA'
  );
});

test('parseHaikuResponse: throws on pass=true with non-empty missing_tools', () => {
  const raw = JSON.stringify({
    pass: true,
    missing_tools: [{ name: 'x', reason: 'y' }],
  });
  assert.throws(
    () => parseHaikuResponse(raw),
    (err) => err instanceof HaikuError && err.message.includes('inconsistent')
  );
});

test('parseHaikuResponse: throws on pass=false with empty missing_tools', () => {
  const raw = JSON.stringify({ pass: false, missing_tools: [] });
  assert.throws(
    () => parseHaikuResponse(raw),
    (err) => err instanceof HaikuError && err.message.includes('inconsistent')
  );
});

test('parseHaikuResponse: throws on missing required fields', () => {
  assert.throws(() => parseHaikuResponse('{"pass": true}'), HaikuError);
  assert.throws(() => parseHaikuResponse('{"missing_tools": []}'), HaikuError);
});

test('parseHaikuResponse: throws on invalid tool entry', () => {
  const raw = JSON.stringify({
    pass: false,
    missing_tools: [{ name: '', reason: 'empty' }],
  });
  assert.throws(() => parseHaikuResponse(raw), HaikuError);
});
