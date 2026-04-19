// claude -p --model claude-haiku-4-5-* wrapper.
// §5.5: structured JSON I/O, no retries, schema violations throw.

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const WORKDIR = join(homedir(), '.spotter', 'workdir');

export class HaikuError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HaikuError';
    this.code = code;
  }
}

export async function ensureWorkdir() {
  // §5.2: the workdir is isolated. No CLAUDE.md here.
  await mkdir(WORKDIR, { recursive: true });
  return WORKDIR;
}

// Build the first-stage prompt — projection of catalog purpose/when_to_use only.
// When `isFirst` is true, includes system rules + full catalog (used with --session-id).
// When false, sends only incremental input (used with --resume; Haiku already has catalog/rules).
export function buildFirstStagePrompt({ catalog, userInput, isFirst = true }) {
  if (!isFirst) {
    return [
      '## 新しいユーザー入力',
      userInput,
      '',
      '既に共有済みの判定ルール・カタログに従い、同一 JSON スキーマで結果を返してください。',
    ].join('\n');
  }
  const toolsProjection = catalog.tools.map((t) => ({
    name: t.name,
    purpose: t.purpose,
    when_to_use: t.when_to_use,
  }));
  return [
    systemRules(),
    '## ツールカタログ',
    JSON.stringify(toolsProjection, null, 2),
    '',
    '## ユーザー入力',
    userInput,
    '',
    '## 判定',
    'ユーザーの入力内容から、上記カタログのうち「呼ぶべきだったのに Bell が呼び忘れるリスクのあるツール」を全て列挙してください。',
    '該当するツールが 1 件もない場合は `pass: true` にしてください。',
    '必ず指定スキーマの JSON オブジェクトのみを返してください。他のテキストは一切含めないでください。',
  ].join('\n');
}

// Build the final-stage prompt — Stop hook, after Bell's response.
// Incremental form (isFirst=false) omits the catalog since Haiku's resumed session already has it.
export function buildFinalStagePrompt({ catalog, userInput, usedTools, finalResponse, isFirst = true }) {
  if (!isFirst) {
    return [
      '## ターン終了判定',
      '',
      '### 対象ユーザー入力',
      userInput,
      '',
      '### Bell が既に使用したツール',
      usedTools.length > 0 ? usedTools.map((t) => `- ${t}`).join('\n') : '(なし)',
      '',
      '### Bell の最終応答',
      finalResponse,
      '',
      '既に共有済みのルールに従い、使用済みツールは除外した上で同一 JSON スキーマで結果を返してください。',
    ].join('\n');
  }
  const toolsProjection = catalog.tools.map((t) => ({
    name: t.name,
    purpose: t.purpose,
    when_to_use: t.when_to_use,
  }));
  return [
    systemRules(),
    '## ツールカタログ',
    JSON.stringify(toolsProjection, null, 2),
    '',
    '## ユーザー入力',
    userInput,
    '',
    '## Bell が既に使用したツール',
    usedTools.length > 0 ? usedTools.map((t) => `- ${t}`).join('\n') : '(なし)',
    '',
    '## Bell の最終応答',
    finalResponse,
    '',
    '## 判定',
    'ユーザーの入力と Bell の最終応答を見て、呼ぶべきだったのに呼ばれていないツールを列挙してください。',
    '「既に使用したツール」に含まれるものは除外してください (同じツールを二重に指摘しないため)。',
    '該当するツールが 1 件もない場合は `pass: true` にしてください。',
    '必ず指定スキーマの JSON オブジェクトのみを返してください。他のテキストは一切含めないでください。',
  ].join('\n');
}

// Build a warmup prompt — fired by the daemon right after `server.listen` to pay the
// Haiku cold-start cost before the first user_input arrives. Uses --session-id to create
// the Haiku conversation with catalog + rules loaded; subsequent real calls hit --resume
// and respond within the hook timeout.
// The returned response is discarded by the caller; we instruct Haiku to return the trivial
// pass object so that parseHaikuResponse does not throw on the warmup result.
export function buildWarmupPrompt({ catalog }) {
  const toolsProjection = catalog.tools.map((t) => ({
    name: t.name,
    purpose: t.purpose,
    when_to_use: t.when_to_use,
  }));
  return [
    systemRules(),
    '## ツールカタログ',
    JSON.stringify(toolsProjection, null, 2),
    '',
    '## ウォームアップ呼び出し',
    'これはセッション開始直後のウォームアップ呼び出しです。実際のユーザー入力はまだありません。',
    '以降の判定に備えて、上記カタログと判定ルールをコンテキストに保持してください。',
    'この呼び出しでは必ず `{"pass": true, "missing_tools": []}` のみを返してください。',
  ].join('\n');
}

function systemRules() {
  return [
    'あなたは Spotter — Claude (Bell) が呼び忘れているツールを検出する監査役です。',
    '',
    '## 出力スキーマ (厳守)',
    '```json',
    '{',
    '  "pass": <boolean>,',
    '  "missing_tools": [',
    '    { "name": "<tool_name>", "reason": "<一文の日本語>" }',
    '  ]',
    '}',
    '```',
    '',
    '- `pass: true` なら `missing_tools: []`',
    '- `pass: false` なら `missing_tools` は 1 件以上、`name` はカタログに存在するツール名',
    '- JSON オブジェクトのみ出力。説明文・前置き・```json``` フェンス禁止',
  ].join('\n');
}

// Parse Haiku's response. Throws HaikuError on schema violation.
export function parseHaikuResponse(raw) {
  const trimmed = raw.trim();
  // Be tolerant of a surrounding code fence, which Haiku sometimes adds despite the prompt.
  const unfenced = stripFence(trimmed);
  let parsed;
  try {
    parsed = JSON.parse(unfenced);
  } catch (err) {
    throw new HaikuError('E_HAIKU_SCHEMA', `haiku output is not valid JSON: ${err.message} :: raw=${truncate(raw)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HaikuError('E_HAIKU_SCHEMA', `haiku output root is not an object :: ${truncate(raw)}`);
  }
  if (typeof parsed.pass !== 'boolean') {
    throw new HaikuError('E_HAIKU_SCHEMA', `haiku "pass" must be boolean :: ${truncate(raw)}`);
  }
  if (!Array.isArray(parsed.missing_tools)) {
    throw new HaikuError('E_HAIKU_SCHEMA', `haiku "missing_tools" must be array :: ${truncate(raw)}`);
  }
  parsed.missing_tools.forEach((m, i) => {
    if (m === null || typeof m !== 'object' || Array.isArray(m)) {
      throw new HaikuError('E_HAIKU_SCHEMA', `missing_tools[${i}] not an object`);
    }
    if (typeof m.name !== 'string' || m.name.length === 0) {
      throw new HaikuError('E_HAIKU_SCHEMA', `missing_tools[${i}].name must be non-empty string`);
    }
    if (typeof m.reason !== 'string' || m.reason.length === 0) {
      throw new HaikuError('E_HAIKU_SCHEMA', `missing_tools[${i}].reason must be non-empty string`);
    }
  });
  // Cross-field: pass: true implies missing_tools empty.
  if (parsed.pass === true && parsed.missing_tools.length > 0) {
    throw new HaikuError(
      'E_HAIKU_SCHEMA',
      `pass: true with non-empty missing_tools is inconsistent :: ${truncate(raw)}`
    );
  }
  if (parsed.pass === false && parsed.missing_tools.length === 0) {
    throw new HaikuError(
      'E_HAIKU_SCHEMA',
      `pass: false with empty missing_tools is inconsistent :: ${truncate(raw)}`
    );
  }
  return parsed;
}

function stripFence(text) {
  const fenceMatch = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  return fenceMatch ? fenceMatch[1] : text;
}

function truncate(s, n = 300) {
  if (s.length <= n) return s;
  return s.slice(0, n) + '...';
}

// On Windows, the `claude` entry is typically a .cmd shim which Node's spawn
// cannot locate without going through the shell. We use cmd.exe /c explicitly
// rather than spawn({ shell: true }) because the latter triggers DEP0190 on Node 24+.
//
// v0.2: For the first call of a daemon's lifetime, spawn with `--session-id <haikuSessionId>`
// to create a new Haiku conversation. For subsequent calls, spawn with `--resume <haikuSessionId>`
// to continue that same conversation (so catalog/system rules persist in Haiku's context).
// Note: `--bare` was tried but fails with "Not logged in" — it is intentionally NOT used.
function buildSpawnArgs(claudeBin, model, haikuSessionId, isFirstCall) {
  const sessionFlag = isFirstCall ? '--session-id' : '--resume';
  const args = ['-p', sessionFlag, haikuSessionId, '--model', model];
  if (process.platform === 'win32') {
    return { cmd: 'cmd.exe', cmdArgs: ['/c', claudeBin, ...args] };
  }
  return { cmd: claudeBin, cmdArgs: args };
}

// Invoke `claude -p` in the isolated workdir. Returns raw stdout.
// §5.5: no retry on failure. §14.1: silent fallback forbidden.
//
// v0.2: `haikuSessionId` is required — used for --session-id (first call) / --resume (subsequent).
// The SPOTTER_PARENT_PID env var is always injected so hooks firing inside the spawned claude
// exit early via isChildCall() (prevents daemon-spawn recursion).
export function createHaikuCaller({ timeoutMs, haikuSessionId, claudeBin = 'claude', model = HAIKU_MODEL, env = process.env }) {
  if (typeof timeoutMs !== 'number' || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a positive number');
  }
  if (typeof haikuSessionId !== 'string' || haikuSessionId.length === 0) {
    throw new TypeError('haikuSessionId is required (non-empty string)');
  }

  return async function callHaiku(prompt, { isFirst = true } = {}) {
    await ensureWorkdir();
    return new Promise((resolve, reject) => {
      const { cmd, cmdArgs } = buildSpawnArgs(claudeBin, model, haikuSessionId, isFirst);
      const child = spawn(cmd, cmdArgs, {
        cwd: WORKDIR,
        env: { ...env, SPOTTER_PARENT_PID: String(process.pid) },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new HaikuError('E_HAIKU_TIMEOUT', `haiku did not respond within ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new HaikuError('E_INTERNAL', `failed to spawn ${claudeBin}: ${err.message}`));
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          reject(new HaikuError('E_INTERNAL', `haiku exited with code ${code}: ${truncate(stderr)}`));
          return;
        }
        resolve(stdout);
      });

      child.stdin.end(prompt, 'utf8');
    });
  };
}
