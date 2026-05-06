import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import {
  buildPreamble,
  buildFirstStagePrompt,
  buildFinalStagePrompt,
  parseHaikuResponse,
  filterCatalogMisses,
  createHaikuCaller,
  buildSpawnArgs,
  sanitizeHaikuEnv,
  preparePromptFile,
  ensureWorkdir,
  emptyMcpConfigPath,
  HaikuError,
} from '../src/daemon/haiku-caller.mjs';

const sampleTools = [
  { name: 'mcp__caveat__caveat_record', description: 'Record a new caveat about an external trap.' },
  { name: 'mcp__caveat__caveat_search', description: 'Search recorded caveats before repeating known traps.' },
];

test('buildPreamble contains role, schema, tool-db entries, and few-shot examples', () => {
  // v0.6.0: preamble is sent once per session (first call). It carries everything Haiku
  // needs to keep its role and output contract — role statement, JSON schema, both stage
  // definitions, few-shot examples, and the full tool list.
  // v0.7.0: tools are {name, description} pairs from tool-db (replaces YAML catalog).
  const preamble = buildPreamble({ tools: sampleTools });
  assert.ok(preamble.includes('Spotter'));
  assert.ok(preamble.includes('Bell'));
  assert.ok(preamble.includes('監査役'));
  assert.ok(preamble.includes('会話文は生成せず') || preamble.includes('会話文は生成しません'));
  assert.ok(preamble.includes('mcp__caveat__caveat_record'));
  assert.ok(preamble.includes('Record a new caveat'));
  assert.ok(!preamble.includes('"current_time"'), 'few-shot examples must not suggest catalog-external current_time');
  assert.ok(!preamble.includes('"Read"'), 'few-shot examples must not suggest catalog-external Read');
  assert.ok(preamble.includes('"pass":false'));
  assert.ok(preamble.includes('"pass":true'));
  assert.ok(preamble.includes('stage=user_input'));
  assert.ok(preamble.includes('stage=turn_end'));
  assert.ok(preamble.includes('推測禁止'));
});

test('buildPreamble matches the current prompt snapshot', () => {
  const preamble = buildPreamble({ tools: sampleTools });
  const expected = [
    'あなたは Spotter。Bell (主役の Claude) が呼び忘れるツールを検出する監査役です。',
    'ユーザーへの会話文は生成せず、必ず下記 JSON のみを返します。',
    '',
    '## 出力',
    '{"pass": <true|false>, "missing_tools": [{"name": "<カタログ名>", "reason": "<一文の日本語>"}]}',
    '- pass:true なら missing_tools は空、pass:false なら 1 件以上',
    '- JSON のみ。前置き・コードフェンス禁止',
    '- **name は後述「## カタログ」に列挙されたツール名そのまま**のみ許可。',
    '  カタログ外の名前 (Skill(xxx) / 任意のスラッシュコマンド / 記憶した既知ツール等) は禁止。',
    '  該当するツールがカタログに見当たらなければ、無理に挙げず pass:true を返す。',
    '',
    '## 判定対象',
    '各ターン、以下いずれかの stage で判定リクエストを受けます:',
    '',
    '### stage=user_input',
    '<user_input> のみ届く。カタログの description から用途が明確に該当するツールを列挙。',
    '推測禁止。該当なしなら pass:true。',
    '',
    '### stage=turn_end  (ツール適用機会の監査)',
    '<final_response> + <used_tools> が届く。',
    'Bell の応答に含まれる動作 — 事実の断定 / 記録すべき新情報 / 既知情報の参照 —',
    'それぞれについて、カタログに役立つツールがあれば提示する。',
    '検証 (Read/Grep/Bash/WebFetch 等) / 登録 (memory/caveat 等) / 照会 (search/list 等) のいずれも対象。',
    '<used_tools> に既に含まれるツールは再指摘しない。',
    '指摘ゼロは歓迎。迷ったら pass:true。',
    '',
    '## 例',
    '以下の tool 名は例用カタログに存在すると仮定した例です。実回答では必ず実カタログの名前だけを使う。',
    '- stage=user_input "この外部仕様の落とし穴を覚えておいて"',
    '  → {"pass":false,"missing_tools":[{"name":"mcp__caveat__caveat_record","reason":"再利用すべき外部仕様の罠は記録対象"}]}',
    '- stage=user_input "ありがとう"',
    '  → {"pass":true,"missing_tools":[]}',
    '- stage=turn_end 応答「判明: A モジュールは B に依存」(used:なし) ← 登録',
    '  → {"pass":false,"missing_tools":[{"name":"mcp__caveat__caveat_record","reason":"新発見の依存関係は記録して次回参照可能にすべき"}]}',
    '- stage=turn_end 応答「この話題は前にも議論したはず」(used:なし) ← 照会',
    '  → {"pass":false,"missing_tools":[{"name":"mcp__caveat__caveat_search","reason":"過去の議論参照は検索して裏付けるべき"}]}',
    '- stage=turn_end 応答「作業完了しました」(used:mcp__caveat__caveat_record) ← pass',
    '  → {"pass":true,"missing_tools":[]}',
    '',
    '## カタログ',
    JSON.stringify(sampleTools, null, 2),
  ].join('\n');
  assert.equal(preamble, expected);
});

test('buildPreamble throws if tools is not an array', () => {
  assert.throws(() => buildPreamble({ tools: null }), TypeError);
  assert.throws(() => buildPreamble({ tools: { foo: 'bar' } }), TypeError);
});

test('buildFirstStagePrompt is a small per-turn delta — no catalog, no header', () => {
  // v0.6.0: the first-stage prompt is only the stage marker + wrapped user input. The
  // catalog / role / few-shot live in the preamble and must NOT be re-transmitted here.
  const prompt = buildFirstStagePrompt({ userInput: '今何時?' });
  assert.ok(prompt.includes('stage=user_input'));
  assert.ok(prompt.includes('今何時?'));
  assert.ok(!prompt.includes('mcp__caveat'), 'tool-db entries must not be in per-turn prompt');
  assert.ok(!prompt.includes('Search the web'), 'tool descriptions must not be in per-turn prompt');
  assert.ok(!prompt.includes('Spotter'), 'role text must not be in per-turn prompt');
});

test('buildFirstStagePrompt wraps user input in <user_input> tags', () => {
  const prompt = buildFirstStagePrompt({ userInput: '時間を教えて' });
  assert.equal(prompt, [
    'stage=user_input',
    '<user_input>',
    '時間を教えて',
    '</user_input>',
  ].join('\n'));
});

test('buildFinalStagePrompt is a small per-turn delta — no catalog, no header', () => {
  const prompt = buildFinalStagePrompt({
    usedTools: [],
    finalResponse: 'reply',
  });
  assert.ok(prompt.includes('stage=turn_end'));
  assert.ok(!prompt.includes('mcp__caveat'), 'tool-db entries must not be in per-turn prompt');
  assert.ok(!prompt.includes('Spotter'), 'role text must not be in per-turn prompt');
});

test('buildFinalStagePrompt wraps used_tools and final_response in tags (no user_input — v0.13.0)', () => {
  // v0.13.0: stage=turn_end の判定は final_response + used_tools のみ。
  // user_input は渡さない (ツール適用機会の監査に転換)。
  const prompt = buildFinalStagePrompt({
    usedTools: ['read_file'],
    finalResponse: 'Bell の返答',
  });
  assert.equal(prompt, [
    'stage=turn_end',
    '<used_tools>',
    '- read_file',
    '</used_tools>',
    '<final_response>',
    'Bell の返答',
    '</final_response>',
  ].join('\n'));
  assert.ok(!prompt.includes('<user_input>'), 'user_input tag must not appear in v0.13.0 turn_end prompt');
});

test('buildFinalStagePrompt handles empty used_tools', () => {
  const prompt = buildFinalStagePrompt({
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
    mcpConfigPath: '/tmp/empty-mcp.json',
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
    mcpConfigPath: '/tmp/empty-mcp.json',
  });
  assert.ok(!cmdArgs.includes('--session-id'));
  const resumeIdx = cmdArgs.indexOf('--resume');
  assert.ok(resumeIdx > -1);
  assert.equal(cmdArgs[resumeIdx + 1], 'abc-123');
});

// v1.3.0: Haiku spawn 時に user/project MCP 設定を絶対 load させない (CPU 飽和の根因)。
// 2026-05-04 Spotter リポジトリで実害観測 — daemon 3 並走 × 各 Haiku 呼出が
// `npm exec @modelcontextprotocol/...` を数十個 spawn していた。修正は spawn 引数で
// `--strict-mcp-config --mcp-config <empty>` を必ず付ける + workdir に空 config 配置。
test('buildSpawnArgs: always emits --strict-mcp-config and --mcp-config <path> (first call)', () => {
  const { cmdArgs } = buildSpawnArgs({
    claudeBin: 'claude',
    model: 'haiku',
    sessionId: 'abc-123',
    resume: false,
    mcpConfigPath: '/some/empty.json',
  });
  assert.ok(cmdArgs.includes('--strict-mcp-config'));
  const cfgIdx = cmdArgs.indexOf('--mcp-config');
  assert.ok(cfgIdx > -1, '--mcp-config must be present');
  assert.equal(cmdArgs[cfgIdx + 1], '/some/empty.json');
});

test('buildSpawnArgs: always emits --strict-mcp-config and --mcp-config <path> (resumed call)', () => {
  const { cmdArgs } = buildSpawnArgs({
    claudeBin: 'claude',
    model: 'haiku',
    sessionId: 'abc-123',
    resume: true,
    mcpConfigPath: '/some/empty.json',
  });
  assert.ok(cmdArgs.includes('--strict-mcp-config'));
  const cfgIdx = cmdArgs.indexOf('--mcp-config');
  assert.ok(cfgIdx > -1);
  assert.equal(cmdArgs[cfgIdx + 1], '/some/empty.json');
});

test('buildSpawnArgs: rejects missing or empty mcpConfigPath', () => {
  const base = { claudeBin: 'claude', model: 'haiku', sessionId: 'x', resume: false };
  assert.throws(() => buildSpawnArgs({ ...base }), TypeError);
  assert.throws(() => buildSpawnArgs({ ...base, mcpConfigPath: '' }), TypeError);
  assert.throws(() => buildSpawnArgs({ ...base, mcpConfigPath: null }), TypeError);
});

test('ensureWorkdir: writes the empty-mcp.json with strict-empty mcpServers', async () => {
  // Haiku spawn で `--strict-mcp-config --mcp-config <empty>` に渡す前提のファイル。
  // 内容が `{"mcpServers":{}}` でない壊れ方をすると claude CLI が parse error で落ちる。
  await ensureWorkdir();
  const cfgPath = emptyMcpConfigPath();
  const body = await readFile(cfgPath, 'utf8');
  const parsed = JSON.parse(body);
  assert.deepEqual(parsed, { mcpServers: {} });
});

test('ensureWorkdir: idempotent — safe to call repeatedly', async () => {
  await ensureWorkdir();
  await ensureWorkdir();
  await ensureWorkdir();
  const body = await readFile(emptyMcpConfigPath(), 'utf8');
  assert.equal(JSON.parse(body).mcpServers && typeof JSON.parse(body).mcpServers, 'object');
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

test('buildPreamble declares the catalog-only rule (v0.13.3)', () => {
  // Explicit rule discouraging catalog-external names. See filterCatalogMisses for the
  // defensive filter that enforces this on the daemon side.
  const preamble = buildPreamble({ tools: sampleTools });
  assert.ok(preamble.includes('カタログ'));
  assert.ok(/カタログ外|カタログに記載|カタログ外の名前/.test(preamble));
});

test('filterCatalogMisses: passthrough when every name is in catalog', () => {
  const parsed = {
    pass: false,
    missing_tools: [{ name: 'WebSearch', reason: 'r' }],
  };
  const catalog = new Set(['WebSearch', 'mcp__caveat__caveat_record']);
  const { parsed: out, dropped } = filterCatalogMisses(parsed, catalog);
  assert.deepEqual(dropped, []);
  assert.equal(out, parsed); // same reference when nothing dropped
});

test('filterCatalogMisses: drops a single hallucination and flips pass to true', () => {
  const parsed = {
    pass: false,
    missing_tools: [{ name: 'Skill(tl)', reason: 'bogus' }],
  };
  const { parsed: out, dropped } = filterCatalogMisses(parsed, ['WebSearch']);
  assert.equal(out.pass, true);
  assert.deepEqual(out.missing_tools, []);
  assert.equal(out.reason, 'hallucination_filtered');
  assert.deepEqual(dropped, ['Skill(tl)']);
});

test('filterCatalogMisses: keeps valid entries when hallucinations mixed in', () => {
  const parsed = {
    pass: false,
    missing_tools: [
      { name: 'WebSearch', reason: 'ok' },
      { name: 'Skill(ghost)', reason: 'bogus' },
    ],
  };
  const { parsed: out, dropped } = filterCatalogMisses(parsed, new Set(['WebSearch']));
  assert.equal(out.pass, false);
  assert.equal(out.missing_tools.length, 1);
  assert.equal(out.missing_tools[0].name, 'WebSearch');
  assert.deepEqual(dropped, ['Skill(ghost)']);
});

test('filterCatalogMisses: accepts array form of catalogNames', () => {
  const parsed = { pass: true, missing_tools: [] };
  const { parsed: out, dropped } = filterCatalogMisses(parsed, ['WebSearch']);
  assert.equal(out.pass, true);
  assert.deepEqual(dropped, []);
});

test('sanitizeHaikuEnv: strips CLAUDE_CONFIG_DIR so haiku uses default ~/.claude/ (v1.1.6)', () => {
  // Bell の isolated CLAUDE_CONFIG_DIR (例 bellbot) が hook → daemon → haiku 連鎖で継承されると
  // credentials 不在の config を読みに行き auth 失敗 exit 1。Spotter haiku はデフォルト
  // ~/.claude/ で走る必要があるため spawn env 構築時点で剥がす。
  const input = {
    PATH: '/usr/bin',
    HOME: '/home/user',
    CLAUDE_CONFIG_DIR: '/tmp/bellbot-isolated',
    ANTHROPIC_API_KEY: 'keep-me',
  };
  const out = sanitizeHaikuEnv(input);
  assert.equal('CLAUDE_CONFIG_DIR' in out, false);
  assert.equal(out.PATH, '/usr/bin');
  assert.equal(out.HOME, '/home/user');
  assert.equal(out.ANTHROPIC_API_KEY, 'keep-me');
  // 原本は変更しない
  assert.equal(input.CLAUDE_CONFIG_DIR, '/tmp/bellbot-isolated');
});

test('sanitizeHaikuEnv: no-op when CLAUDE_CONFIG_DIR is absent', () => {
  const input = { PATH: '/usr/bin' };
  const out = sanitizeHaikuEnv(input);
  assert.deepEqual(out, { PATH: '/usr/bin' });
});

// v1.3.0: preparePromptFile — root fix for the "stdin abandoned after 3s" bug.
//
// Reproduction baseline (2026-05-04, claude CLI 2.1.126, Spotter v1.2.5):
// - Pipe stdin + 93 KB preamble → claude exits 1 with
//     "Warning: no stdin data received in 3s, proceeding without it."
//     "Error: Input must be provided either through stdin or as a prompt argument when using --print"
// - File-fd stdin + same 93 KB → exit 0, normal JSON response.
// The contract these tests pin: a real file fd is delivered, contains the full prompt
// (including > pipe-buffer payloads), and the close() handle reclaims both fd and file.

test('preparePromptFile: writes the full prompt to a tempfile and returns a readable fd', async () => {
  const payload = 'hello\n世界';
  const file = await preparePromptFile(payload);
  try {
    assert.equal(typeof file.tmpPath, 'string');
    assert.ok(file.tmpPath.includes('spotter-prompt-'));
    assert.equal(typeof file.fd, 'number');
    const onDisk = await readFile(file.tmpPath, 'utf8');
    assert.equal(onDisk, payload);
  } finally {
    await file.close();
  }
});

test('preparePromptFile: handles payloads larger than the kernel pipe buffer (regression vs v1.2.5)', async () => {
  // 100 KB > Linux pipe buffer (64 KB). The pipe-stdin path drops this; the fd path
  // must deliver every byte. We assert size + boundary content (head/tail/middle) so a
  // truncation regression cannot hide.
  const big = 'A'.repeat(100 * 1024);
  const file = await preparePromptFile(big);
  try {
    const st = await stat(file.tmpPath);
    assert.equal(st.size, 100 * 1024);
    const onDisk = await readFile(file.tmpPath, 'utf8');
    assert.equal(onDisk.length, big.length);
    assert.equal(onDisk[0], 'A');
    assert.equal(onDisk[onDisk.length - 1], 'A');
  } finally {
    await file.close();
  }
});

test('preparePromptFile: close() removes the tempfile', async () => {
  const file = await preparePromptFile('x');
  await file.close();
  await assert.rejects(stat(file.tmpPath), (err) => err.code === 'ENOENT');
});

test('preparePromptFile: close() is idempotent (best-effort cleanup)', async () => {
  // The daemon's settle path may race timeout-vs-close; close() must not throw on the
  // second call even though the fd or file are already gone.
  const file = await preparePromptFile('x');
  await file.close();
  await file.close(); // must not throw
});

test('preparePromptFile: rejects non-string input', async () => {
  await assert.rejects(preparePromptFile(null), TypeError);
  await assert.rejects(preparePromptFile(undefined), TypeError);
  await assert.rejects(preparePromptFile(123), TypeError);
});

test('preparePromptFile: parallel calls produce distinct tempfiles', async () => {
  // Multiple concurrent Spotter sessions (or a single session with overlapping retries)
  // must not collide on tmpPath. randomUUID guarantees this; the test pins it.
  const files = await Promise.all([
    preparePromptFile('a'),
    preparePromptFile('b'),
    preparePromptFile('c'),
  ]);
  try {
    const paths = new Set(files.map((f) => f.tmpPath));
    assert.equal(paths.size, 3);
  } finally {
    await Promise.all(files.map((f) => f.close()));
  }
});
