// claude -p --model claude-haiku-4-5-* wrapper.
// §5.5: structured JSON I/O, no retries, schema violations throw.
//
// v0.5.0: session-scoped Haiku is back. Each daemon holds a single Haiku session-id for
// the life of the Bell session; the first call uses --session-id only, subsequent calls
// use --session-id + --resume to reattach to the same claude -p conversation, avoiding
// per-turn cold-start spawn (observed 20–50s in v0.4.x stateless mode).
//
// Role-collapse (Haiku drifting into Bell's persona over long sessions — the failure mode
// v0.4.0 reverted to stateless to avoid) is now handled by a recovery mechanism instead of
// structural prevention: if the daemon detects a schema violation (E_HAIKU_SCHEMA) from
// parseHaikuResponse, it calls reset() on the caller to renew the session-id, then silent-
// passes the offending turn. See daemon.mjs for the catch site. This makes role collapse a
// "想定済み異常" (CLAUDE.md §0) — recorded, recovered from, never bubbled up as exit 2.

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

// v0.4.3 minimization (retained in v0.5.0):
//   Aggressive trim — no adversarial prompt-injection list, no 【最重要】 tags, no triple
//   restatement. The judgment-anchoring instruction at the tail stays prominent.
//
// Shared header (role + schema + few-shot) is identical between first/final stages, which
// keeps the Anthropic prompt-cache prefix stable across calls of the same stage.

const SHARED_HEADER = [
  'あなたは Spotter。Bell (主役の Claude) が呼び忘れるツールを検出する監査役です。',
  'ユーザーへの会話文は生成せず、必ず下記 JSON のみを返します。',
  '',
  '## 出力',
  '{"pass": <true|false>, "missing_tools": [{"name": "<カタログ名>", "reason": "<一文の日本語>"}]}',
  '- pass:true なら missing_tools は空、pass:false なら 1 件以上',
  '- JSON のみ。前置き・コードフェンス禁止',
  '',
  '## 例',
  '- "今何時?" → {"pass":false,"missing_tools":[{"name":"current_time","reason":"時刻の直接質問"}]}',
  '- "ありがとう" → {"pass":true,"missing_tools":[]}',
].join('\n');

// Build the first-stage prompt — sent on UserPromptSubmit before tools are invoked.
export function buildFirstStagePrompt({ catalog, userInput }) {
  return [
    SHARED_HEADER,
    '',
    '## カタログ',
    JSON.stringify(projectCatalog(catalog), null, 2),
    '',
    '## ユーザー入力',
    '<user_input>',
    userInput,
    '</user_input>',
    '',
    'when_to_use に明確に該当するツールだけを列挙。推測禁止。該当なしなら pass:true。',
  ].join('\n');
}

// Build the final-stage prompt — Stop hook, after Bell's response.
export function buildFinalStagePrompt({ catalog, userInput, usedTools, finalResponse }) {
  return [
    SHARED_HEADER,
    '',
    '## カタログ',
    JSON.stringify(projectCatalog(catalog), null, 2),
    '',
    '## ユーザー入力',
    '<user_input>',
    userInput,
    '</user_input>',
    '',
    '## Bell が既に使用したツール',
    usedTools.length > 0 ? usedTools.map((t) => `- ${t}`).join('\n') : '(なし)',
    '',
    '## Bell の応答',
    '<final_response>',
    finalResponse,
    '</final_response>',
    '',
    '既使用ツールを除き、when_to_use に明確に該当するのに Bell が呼び忘れたツールを列挙。推測禁止。該当なしなら pass:true。',
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
//
// v0.5.1: claude CLI rejects `--session-id` together with `--resume` unless `--fork-session`
// is present (fork would create a new id, defeating the point). So first call uses
// `--session-id <uuid>` to pin the id; every subsequent call uses `--resume <uuid>` alone to
// re-attach. buildSpawnArgs is exported so tests can assert flag wiring without spawning.
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
// v0.5.0: session-scoped. The caller keeps one session-id for the session's lifetime, and
// exposes a reset() method that rotates the session-id (used by daemon on E_HAIKU_SCHEMA
// to recover from role collapse). The returned value is a function (so existing tests that
// check `typeof caller === 'function'` still pass) with `reset` and `sessionId` attached.
export function createHaikuCaller({ timeoutMs, claudeBin = 'claude', model = HAIKU_MODEL, env = process.env }) {
  if (typeof timeoutMs !== 'number' || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a positive number');
  }

  let currentSessionId = randomUUID();
  let isFirstCall = true;

  const callHaiku = async function (prompt) {
    await ensureWorkdir();
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
        // still be treated as "session not yet established" so the next attempt uses
        // --session-id only (not --resume against a non-existent session).
        isFirstCall = false;
        resolve(stdout);
      });

      child.stdin.end(prompt, 'utf8');
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

  return callHaiku;
}
