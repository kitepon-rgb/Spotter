import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
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

test('buildFirstStagePrompt includes catalog and rules', () => {
  const prompt = buildFirstStagePrompt({ catalog: sampleCatalog, userInput: '今何時?' });
  assert.ok(prompt.includes('current_time'));
  assert.ok(prompt.includes('今何時?'));
  assert.ok(prompt.includes('pass'));
  assert.ok(prompt.includes('get time'));
});

test('buildFirstStagePrompt names Bell and the auditor role clearly', () => {
  // v0.4.3: minimized prompt — no role-guard enumeration, no 【最重要】 tags.
  // Must still clearly state who Spotter is and what "Bell" refers to, since Haiku
  // sees this fresh every call (stateless) with no other context.
  const prompt = buildFirstStagePrompt({ catalog: sampleCatalog, userInput: '今何時?' });
  assert.ok(prompt.includes('Spotter'));
  assert.ok(prompt.includes('Bell'));
  assert.ok(prompt.includes('監査役'));
  // Haiku must not generate user-facing chat — enforce explicitly.
  assert.ok(prompt.includes('会話文は生成せず') || prompt.includes('会話文は生成しません'));
});

test('buildFirstStagePrompt wraps user input in <user_input> tags for structural clarity', () => {
  // v0.4.3: tags kept as structural markers (data vs instruction boundary),
  // not as adversarial injection defence — there is no attacker in a solo project.
  const prompt = buildFirstStagePrompt({
    catalog: sampleCatalog,
    userInput: '時間を教えて',
  });
  assert.ok(prompt.includes('<user_input>'));
  assert.ok(prompt.includes('</user_input>'));
  const opening = prompt.indexOf('<user_input>');
  const closing = prompt.indexOf('</user_input>');
  const payload = prompt.indexOf('時間を教えて');
  assert.ok(opening < payload && payload < closing, 'payload must be between the tags');
});

test('buildFirstStagePrompt includes a few-shot example of each pass outcome', () => {
  // v0.4.3: minimal few-shot — 1 pass:false + 1 pass:true. Improves JSON compliance
  // without inflating the prompt.
  const prompt = buildFirstStagePrompt({ catalog: sampleCatalog, userInput: '?' });
  assert.ok(prompt.includes('"pass":false'));
  assert.ok(prompt.includes('"pass":true'));
});

test('buildFirstStagePrompt tail contains the judgment directive (end-anchored)', () => {
  // v0.4.3: the discriminating instruction ("推測禁止、when_to_use 該当のみ") must be
  // at the tail so it anchors the model's final action.
  const prompt = buildFirstStagePrompt({ catalog: sampleCatalog, userInput: '?' });
  const tail = prompt.slice(-200);
  assert.ok(tail.includes('when_to_use'));
  assert.ok(tail.includes('推測禁止'));
  assert.ok(tail.includes('pass:true'));
});

test('buildFinalStagePrompt wraps both user input and final response in tags', () => {
  // v0.4.3: structural delimiters kept.
  const prompt = buildFinalStagePrompt({
    catalog: sampleCatalog,
    userInput: '?',
    usedTools: [],
    finalResponse: 'Bell の返答',
  });
  assert.ok(prompt.includes('<user_input>'));
  assert.ok(prompt.includes('</user_input>'));
  assert.ok(prompt.includes('<final_response>'));
  assert.ok(prompt.includes('</final_response>'));
});

test('buildFinalStagePrompt tail directs Haiku to exclude already-used tools', () => {
  const prompt = buildFinalStagePrompt({
    catalog: sampleCatalog,
    userInput: '?',
    usedTools: ['read_file'],
    finalResponse: 'r',
  });
  const tail = prompt.slice(-200);
  assert.ok(tail.includes('既使用'));
  assert.ok(tail.includes('呼び忘れ'));
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
  assert.ok(prompt.includes('get time'));
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

test('createHaikuCaller throws on invalid timeout', () => {
  assert.throws(
    () => createHaikuCaller({ timeoutMs: 0 }),
    TypeError
  );
});

test('createHaikuCaller returns a callable with reset() and sessionId (session-scoped)', () => {
  // v0.5.0: Haiku calls are session-scoped again (--session-id + --resume on follow-ups).
  // The caller exposes its current session id and a reset() to renew it on role-collapse.
  const caller = createHaikuCaller({ timeoutMs: 1000 });
  assert.equal(typeof caller, 'function');
  assert.equal(typeof caller.reset, 'function');
  assert.equal(typeof caller.sessionId, 'string');
  assert.ok(caller.sessionId.length > 0);
});

test('createHaikuCaller: reset() assigns a new session-id', () => {
  // v0.5.0: reset() is the recovery path for role collapse — it must produce a fresh uuid
  // so the next call starts a brand-new claude -p session.
  const caller = createHaikuCaller({ timeoutMs: 1000 });
  const before = caller.sessionId;
  caller.reset();
  const after = caller.sessionId;
  assert.notEqual(before, after);
});

test('createHaikuCaller: isFirstCall starts true and reset() restores it', () => {
  // The daemon reads isFirstCall to tag log output with mode=first|resumed. Exposing the
  // flag also lets tests assert the spawn-arg transition without running claude -p.
  const caller = createHaikuCaller({ timeoutMs: 1000 });
  assert.equal(caller.isFirstCall, true);
  caller.reset();
  assert.equal(caller.isFirstCall, true);
});

test('buildSpawnArgs: first call uses --session-id without --resume', () => {
  // v0.5.0: the very first call of a session has no prior claude -p session to resume.
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
  // v0.5.1: claude CLI rejects --session-id + --resume without --fork-session, so the
  // resume path drops --session-id and passes the id to --resume instead.
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
