// claude -p --model claude-haiku-4-5-* wrapper.
// §5.5: structured JSON I/O, no retries, schema violations throw.
//
// v0.6.0: preamble-once. The full role + schema + few-shot + catalog (the "preamble") is
// sent only on the first call of a Haiku session; every subsequent call sends only the
// per-turn delta. Anthropic's --resume replays the preamble from session history, so
// Haiku keeps its role and catalog context without us re-transmitting ~2KB of boilerplate
// per turn. This is the OpenClaw pattern (same author, proven in production with Discord
// → Claude long-lived sessions). Role collapse remains handled by reset() → fresh session
// → preamble resent on next call.
//
// v0.5.x prior behaviour (re-sending full context every turn) made subsequent "resumed"
// calls *slower* than the first (prompt bloat outweighed --resume prefill savings). v0.6.0
// puts the catalog only in the first turn's user message; the session retains it for free.

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

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

// Shared header covers BOTH stages — the preamble documents stage=user_input and
// stage=turn_end so per-turn prompts only need to announce which stage they are.
//
// v0.13.0: stage=turn_end の判定軸を「要請充足チェック」から「ツール適用機会の監査」に転換。
// 旧軸は <user_input> に対し used_tools が足りているかをチェックしていた。新軸は
// <final_response> の内容 (事実断定 / 記録すべき新情報 / 既知情報の参照) に対し、カタログ
// 上のツール (検証 / 登録 / 照会) を差し込める余地を探す。非対称 (指摘ゼロ歓迎) 設計。
const SHARED_HEADER = [
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
  '<user_input> のみ届く。when_to_use に明確に該当するツールを列挙。',
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
  '- stage=user_input "今何時?"',
  '  → {"pass":false,"missing_tools":[{"name":"current_time","reason":"時刻の直接質問"}]}',
  '- stage=user_input "ありがとう"',
  '  → {"pass":true,"missing_tools":[]}',
  '- stage=turn_end 応答「この関数は配列長を返します」(used:なし) ← 検証',
  '  → {"pass":false,"missing_tools":[{"name":"Read","reason":"関数実装の断定は実ファイル読取で裏付けるべき"}]}',
  '- stage=turn_end 応答「判明: A モジュールは B に依存」(used:Grep) ← 登録',
  '  → {"pass":false,"missing_tools":[{"name":"mcp__caveat__caveat_record","reason":"新発見の依存関係は記録して次回参照可能にすべき"}]}',
  '- stage=turn_end 応答「この話題は前にも議論したはず」(used:なし) ← 照会',
  '  → {"pass":false,"missing_tools":[{"name":"mcp__caveat__caveat_search","reason":"過去の議論参照は検索して裏付けるべき"}]}',
  '- stage=turn_end 応答「作業完了しました」(used:Read,Edit,Bash) ← pass',
  '  → {"pass":true,"missing_tools":[]}',
].join('\n');

// Preamble — sent exactly once per Haiku session (first call). Contains the role,
// output contract, few-shot examples, and the tool catalog. The Anthropic session
// retains this in history so subsequent --resume calls can judge with only a small
// per-turn payload.
//
// v0.7.0: `tools` is an array of {name, description} pairs (the new tool-db format).
// `description` is the natural-language explanation supplied by the MCP server (or the
// hardcoded baseline for Claude Code built-in deferred tools). No schema, no usage —
// Haiku only needs to decide whether the tool should be called; "how to call" is Bell's
// responsibility (via ToolSearch).
export function buildPreamble({ tools }) {
  if (!Array.isArray(tools)) {
    throw new TypeError('buildPreamble: tools must be an array of {name, description}');
  }
  return [
    SHARED_HEADER,
    '',
    '## カタログ',
    JSON.stringify(tools, null, 2),
  ].join('\n');
}

// Per-turn prompt — UserPromptSubmit stage. Sent as-is on every call (first and resumed);
// createHaikuCaller prepends the preamble on first call only.
export function buildFirstStagePrompt({ userInput }) {
  return [
    'stage=user_input',
    '<user_input>',
    userInput,
    '</user_input>',
  ].join('\n');
}

// Per-turn prompt — Stop hook stage.
// v0.13.0: user_input は渡さない。判定軸が「ユーザー要請の充足」から「final_response に
// ツール適用機会があるか」に変わったため。挨拶ターンの早期 pass は daemon 側の
// state.lastUserInput === null 分岐 (handleTurnEnd) で処理する。
export function buildFinalStagePrompt({ usedTools, finalResponse }) {
  const usedList = usedTools.length > 0 ? usedTools.map((t) => `- ${t}`).join('\n') : '(なし)';
  return [
    'stage=turn_end',
    '<used_tools>',
    usedList,
    '</used_tools>',
    '<final_response>',
    finalResponse,
    '</final_response>',
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

// v0.13.3: post-parse defence against catalog-external hallucinations. Haiku occasionally
// proposes tool names that are not in the catalog — training-memory leakage or few-shot
// cargo-culting. The SHARED_HEADER now forbids this explicitly, but we also filter
// defensively: entries whose name is not in `catalogNames` are dropped. If all entries are
// dropped, pass is flipped to true with reason='hallucination_filtered'. Mixed cases keep
// the valid entries and stay pass=false.
//
// Returns { parsed, dropped } where `dropped` is the list of filtered-out names (for
// observability / logging).
export function filterCatalogMisses(parsed, catalogNames) {
  const names = catalogNames instanceof Set ? catalogNames : new Set(catalogNames);
  const kept = [];
  const dropped = [];
  for (const m of parsed.missing_tools) {
    if (names.has(m.name)) kept.push(m);
    else dropped.push(m.name);
  }
  if (dropped.length === 0) return { parsed, dropped };
  if (kept.length === 0) {
    return {
      parsed: { pass: true, missing_tools: [], reason: 'hallucination_filtered' },
      dropped,
    };
  }
  return { parsed: { ...parsed, missing_tools: kept }, dropped };
}

function stripFence(text) {
  const fenceMatch = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  return fenceMatch ? fenceMatch[1] : text;
}

function truncate(s, n = 300) {
  if (s.length <= n) return s;
  return s.slice(0, n) + '...';
}

// On Windows, the `claude` entry is typically a .cmd shim which Node's spawn cannot locate
// without going through the shell. We use cmd.exe /c explicitly rather than spawn({ shell:
// true }) because the latter triggers DEP0190 on Node 24+.
export function buildSpawnArgs({ claudeBin, model, sessionId, resume }) {
  const args = resume
    ? ['-p', '--resume', sessionId, '--model', model]
    : ['-p', '--session-id', sessionId, '--model', model];
  if (process.platform === 'win32') {
    return { cmd: 'cmd.exe', cmdArgs: ['/c', claudeBin, ...args] };
  }
  return { cmd: claudeBin, cmdArgs: args };
}

// Invoke `claude -p` in the isolated workdir. Returns raw stdout.
// §5.5: no retry on failure. §14.1: silent fallback forbidden (role-collapse recovery in
// daemon.mjs is an explicit §0 exception, not silent fallback).
//
// v0.6.0: accepts an optional `preamble` string that is prepended to the user message on
// the first call only. Subsequent calls (after a successful first call) send only the
// per-turn prompt — the preamble lives in Anthropic's session history via --resume. A
// reset() call (used on role collapse) restores isFirstCall=true so the preamble is
// re-sent on the next attempt with a fresh session-id.
export function createHaikuCaller({ preamble, timeoutMs, claudeBin = 'claude', model = HAIKU_MODEL, env = process.env }) {
  if (typeof timeoutMs !== 'number' || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a positive number');
  }
  if (preamble !== undefined && typeof preamble !== 'string') {
    throw new TypeError('preamble must be a string if provided');
  }

  let currentSessionId = randomUUID();
  let isFirstCall = true;

  const callHaiku = async function (prompt) {
    await ensureWorkdir();
    const wirePrompt = (isFirstCall && preamble) ? `${preamble}\n\n${prompt}` : prompt;
    return new Promise((resolve, reject) => {
      const { cmd, cmdArgs } = buildSpawnArgs({
        claudeBin,
        model,
        sessionId: currentSessionId,
        resume: !isFirstCall,
      });
      const child = spawn(cmd, cmdArgs, {
        cwd: WORKDIR,
        env: { ...env, SPOTTER_PARENT_PID: String(process.pid) },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      let settled = false;

      // v0.13.2: absorb EPIPE/ECONNRESET on stdio streams. We end(prompt) and
      // then kill() on timeout — if the write hadn't drained yet, the unflushed
      // stream can emit 'error' after kill. Today's Node doesn't crash on
      // unhandled stdin errors, but the docs don't guarantee that, and this
      // listener removes a potential silent-death path.
      const noop = () => {};
      child.stdin.on('error', noop);
      child.stdout.on('error', noop);
      child.stderr.on('error', noop);

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
        // Flip isFirstCall only after a successful spawn — a failed first call should
        // still be treated as "preamble not yet delivered" so the next attempt re-sends
        // the full prelude against a fresh --session-id (not --resume a non-existent one).
        isFirstCall = false;
        resolve(stdout);
      });

      child.stdin.end(wirePrompt, 'utf8');
    });
  };

  callHaiku.reset = () => {
    currentSessionId = randomUUID();
    isFirstCall = true;
  };

  Object.defineProperty(callHaiku, 'sessionId', {
    get: () => currentSessionId,
    enumerable: true,
  });

  Object.defineProperty(callHaiku, 'isFirstCall', {
    get: () => isFirstCall,
    enumerable: true,
  });

  return callHaiku;
}
