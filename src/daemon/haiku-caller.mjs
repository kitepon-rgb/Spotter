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
const SHARED_HEADER = [
  'あなたは Spotter。Bell (主役の Claude) が呼び忘れるツールを検出する監査役です。',
  'ユーザーへの会話文は生成せず、必ず下記 JSON のみを返します。',
  '',
  '## 出力',
  '{"pass": <true|false>, "missing_tools": [{"name": "<カタログ名>", "reason": "<一文の日本語>"}]}',
  '- pass:true なら missing_tools は空、pass:false なら 1 件以上',
  '- JSON のみ。前置き・コードフェンス禁止',
  '',
  '## 判定対象',
  '各ターン、以下いずれかの stage で判定リクエストを受けます:',
  '- stage=user_input: <user_input> のみ届く。when_to_use に明確に該当するツールを列挙',
  '- stage=turn_end: <user_input> + <used_tools> + <final_response> が届く。既使用を除き Bell が呼び忘れたツールを列挙',
  'どちらも推測禁止。該当なしなら pass:true。',
  '',
  '## 例',
  '- stage=user_input "今何時?" → {"pass":false,"missing_tools":[{"name":"current_time","reason":"時刻の直接質問"}]}',
  '- stage=user_input "ありがとう" → {"pass":true,"missing_tools":[]}',
].join('\n');

// Preamble — sent exactly once per Haiku session (first call). Contains the role,
// output contract, few-shot examples, and the tool catalog. The Anthropic session
// retains this in history so subsequent --resume calls can judge with only a small
// per-turn payload.
export function buildPreamble({ catalog }) {
  return [
    SHARED_HEADER,
    '',
    '## カタログ',
    JSON.stringify(projectCatalog(catalog), null, 2),
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
export function buildFinalStagePrompt({ userInput, usedTools, finalResponse }) {
  const usedList = usedTools.length > 0 ? usedTools.map((t) => `- ${t}`).join('\n') : '(なし)';
  return [
    'stage=turn_end',
    '<user_input>',
    userInput,
    '</user_input>',
    '<used_tools>',
    usedList,
    '</used_tools>',
    '<final_response>',
    finalResponse,
    '</final_response>',
  ].join('\n');
}

function projectCatalog(catalog) {
  return catalog.tools.map((t) => ({
    name: t.name,
    purpose: t.purpose,
    when_to_use: t.when_to_use,
  }));
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
