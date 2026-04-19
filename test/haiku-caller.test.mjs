import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPreamble,
  buildFirstStagePrompt,
  buildFinalStagePrompt,
  parseHaikuResponse,
  createHaikuCaller,
  buildSpawnArgs,
  HaikuError,
} from '../src/daemon/haiku-caller.mjs';

const sampleCatalog = {
  version: 1,
  tools: [
    { name: 'current_time', purpose: 'get time', when_to_use: ['time questions'] },
    { name: 'web_search', purpose: 'search', when_to_use: ['latest info'] },
  ],
};

test('buildPreamble contains role, schema, catalog, and few-shot examples', () => {
  // v0.6.0: preamble is sent once per session (first call). It carries everything Haiku
  // needs to keep its role and output contract — role statement, JSON schema, both stage
  // definitions, few-shot examples, and the full tool catalog.
  const preamble = buildPreamble({ catalog: sampleCatalog });
  assert.ok(preamble.includes('Spotter'));
  assert.ok(preamble.includes('Bell'));
  assert.ok(preamble.includes('監査役'));
  assert.ok(preamble.includes('会話文は生成せず') || preamble.includes('会話文は生成しません'));
  assert.ok(preamble.includes('current_time'));
  assert.ok(preamble.includes('get time'));
  assert.ok(preamble.includes('"pass":false'));
  assert.ok(preamble.includes('"pass":true'));
  assert.ok(preamble.includes('stage=user_input'));
  assert.ok(preamble.includes('stage=turn_end'));
  assert.ok(preamble.includes('推測禁止'));
});

test('buildFirstStagePrompt is a small per-turn delta — no catalog, no header', () => {
  // v0.6.0: the first-stage prompt is only the stage marker + wrapped user input. The
  // catalog / role / few-shot live in the preamble and must NOT be re-transmitted here.
  const prompt = buildFirstStagePrompt({ userInput: '今何時?' });
  assert.ok(prompt.includes('stage=user_input'));
  assert.ok(prompt.includes('今何時?'));
  assert.ok(!prompt.includes('current_time'), 'catalog must not be in per-turn prompt');
  assert.ok(!prompt.includes('get time'), 'catalog descriptions must not be in per-turn prompt');
  assert.ok(!prompt.includes('Spotter'), 'role text must not be in per-turn prompt');
});

test('buildFirstStagePrompt wraps user input in <user_input> tags', () => {
  const prompt = buildFirstStagePrompt({ userInput: '時間を教えて' });
  assert.ok(prompt.includes('<user_input>'));
  assert.ok(prompt.includes('</user_input>'));
  const opening = prompt.indexOf('<user_input>');
  const closing = prompt.indexOf('</user_input>');
  const payload = prompt.indexOf('時間を教えて');
  assert.ok(opening < payload && payload < closing, 'payload must be between the tags');
});

test('buildFinalStagePrompt is a small per-turn delta — no catalog, no header', () => {
  const prompt = buildFinalStagePrompt({
    userInput: '?',
    usedTools: [],
    finalResponse: 'reply',
  });
  assert.ok(prompt.includes('stage=turn_end'));
  assert.ok(!prompt.includes('current_time'), 'catalog must not be in per-turn prompt');
  assert.ok(!prompt.includes('Spotter'), 'role text must not be in per-turn prompt');
});

test('buildFinalStagePrompt wraps user_input, used_tools, and final_response in tags', () => {
  const prompt = buildFinalStagePrompt({
    userInput: '何時?',
    usedTools: ['read_file'],
    finalResponse: 'Bell の返答',
  });
  assert.ok(prompt.includes('<user_input>'));
  assert.ok(prompt.includes('</user_input>'));
  assert.ok(prompt.includes('<used_tools>'));
  assert.ok(prompt.includes('</used_tools>'));
  assert.ok(prompt.includes('<final_response>'));
  assert.ok(prompt.includes('</final_response>'));
  assert.ok(prompt.includes('read_file'));
  assert.ok(prompt.includes('Bell の返答'));
});

test('buildFinalStagePrompt handles empty used_tools', () => {
  const prompt = buildFinalStagePrompt({
    userInput: '?',
    usedTools: [],
    finalResponse: 'r',
  });
  assert.ok(prompt.includes('なし'));
});

test('createHaikuCaller throws on invalid timeout', () => {
  assert.throws(
    () => createHaikuCaller({ timeoutMs: 0 }),
    TypeError
  );
});

test('createHaikuCaller throws if preamble is a non-string', () => {
  assert.throws(
    () => createHaikuCaller({ preamble: 123, timeoutMs: 1000 }),
    TypeError
  );
});

test('createHaikuCaller returns a callable with reset() and sessionId (session-scoped)', () => {
  const caller = createHaikuCaller({ timeoutMs: 1000 });
  assert.equal(typeof caller, 'function');
  assert.equal(typeof caller.reset, 'function');
  assert.equal(typeof caller.sessionId, 'string');
  assert.ok(caller.sessionId.length > 0);
});

test('createHaikuCaller: reset() assigns a new session-id', () => {
  // reset() is the recovery path for role collapse — it must produce a fresh uuid so the
  // next call starts a brand-new claude -p session (and re-transmits the preamble).
  const caller = createHaikuCaller({ timeoutMs: 1000 });
  const before = caller.sessionId;
  caller.reset();
  const after = caller.sessionId;
  assert.notEqual(before, after);
});

test('createHaikuCaller: isFirstCall starts true and reset() restores it', () => {
  // v0.6.0: isFirstCall also gates whether the preamble is prepended on the next call.
  // reset() must restore it to true so role-collapse recovery re-primes the fresh session.
  const caller = createHaikuCaller({ timeoutMs: 1000 });
  assert.equal(caller.isFirstCall, true);
  caller.reset();
  assert.equal(caller.isFirstCall, true);
});

test('buildSpawnArgs: first call uses --session-id without --resume', () => {
  const { cmdArgs } = buildSpawnArgs({
    claudeBin: 'claude',
    model: 'haiku',
    sessionId: 'abc-123',
    resume: false,
  });
  assert.ok(cmdArgs.includes('--session-id'));
  const idIdx = cmdArgs.indexOf('--session-id');
  assert.equal(cmdArgs[idIdx + 1], 'abc-123');
  assert.ok(!cmdArgs.includes('--resume'));
});

test('buildSpawnArgs: subsequent call uses --resume alone (no --session-id)', () => {
  const { cmdArgs } = buildSpawnArgs({
    claudeBin: 'claude',
    model: 'haiku',
    sessionId: 'abc-123',
    resume: true,
  });
  assert.ok(!cmdArgs.includes('--session-id'));
  const resumeIdx = cmdArgs.indexOf('--resume');
  assert.ok(resumeIdx > -1);
  assert.equal(cmdArgs[resumeIdx + 1], 'abc-123');
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
