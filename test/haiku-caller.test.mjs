import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFirstStagePrompt,
  buildFinalStagePrompt,
  parseHaikuResponse,
  HaikuError,
} from '../src/daemon/haiku-caller.mjs';

const sampleCatalog = {
  version: 1,
  tools: [
    { name: 'current_time', purpose: 'get time', when_to_use: ['time questions'] },
    { name: 'web_search', purpose: 'search', when_to_use: ['latest info'] },
  ],
};

test('buildFirstStagePrompt includes user input and tools', () => {
  const prompt = buildFirstStagePrompt({ catalog: sampleCatalog, userInput: '今何時?' });
  assert.ok(prompt.includes('current_time'));
  assert.ok(prompt.includes('今何時?'));
  assert.ok(prompt.includes('pass'));
  // purpose should be present, but usage/examples should not (first-stage projection)
  assert.ok(prompt.includes('get time'));
});

test('buildFinalStagePrompt includes used_tools section', () => {
  const prompt = buildFinalStagePrompt({
    catalog: sampleCatalog,
    userInput: '今何時?',
    usedTools: ['read_file'],
    finalResponse: '深夜ですね',
  });
  assert.ok(prompt.includes('read_file'));
  assert.ok(prompt.includes('深夜ですね'));
});

test('buildFinalStagePrompt handles empty used_tools', () => {
  const prompt = buildFinalStagePrompt({
    catalog: sampleCatalog,
    userInput: '?',
    usedTools: [],
    finalResponse: 'r',
  });
  assert.ok(prompt.includes('なし'));
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
