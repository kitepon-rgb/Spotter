// Shared hook plumbing — stdin read, error → exit-code mapping per §14.3 / §14.4.
//
// Exit code contract (§14.3 / §14.4):
//   0 = success (normal flow), OR a LOUD degradation: the audit could not run but the failure
//       is surfaced in-band via a `[Spotter からの警告]` additionalContext block, so the host
//       stays responsive and the user's prompt is never erased. UserPromptSubmit uses this for
//       any daemon / auditor-backend failure (e.g. codex login expired) — see user-prompt.mjs.
//   1 = expected abnormal, non-blocking (Claude Code proceeds; first stderr line shown to user).
//   2 = unexpected protocol/contract violation (malformed Claude Code envelope, missing required
//       field). Reserved for cases where there is no real user prompt worth preserving — a
//       UserPromptSubmit exit 2 BLOCKS and erases the prompt, so audit failures must NOT use it.
//
// A loud degradation (visible warning naming the cause + remedy) is NOT a silent fallback: the
// user is explicitly told the audit did not run. The forbidden pattern (§14.1) is the SILENT
// exit-0 that leaves the user believing they are protected when they are not.
//
// v0.2 gate helpers (plan §18 / C:\Users\kite_\.claude\plans\10-cuddly-codd.md):
// - isChildCall(): env-var gate for Spotter's own child backend invocations
// - isSubagentCall(input): agent_id gate for Bell's Task subagent hooks
// Combined with session-start's source='startup' check, these prevent daemon
// proliferation (v0.1 postmortem §18.2).
//
// v0.3 gate (plan §18 daemon-proliferation root fix):
// - findSpotterMarker(cwd): walk up from cwd looking for .spotter/marker.json.
//   Hooks exit 0 when no marker is found, so other tools' `claude -p` invocations
//   in unrelated workdirs (Throughline workdir etc.) never spawn a daemon.

import { statSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';

export function isChildCall() {
  return hasNonEmptyEnv('SPOTTER_PARENT_PID')
      || hasNonEmptyEnv('SPOTTER_BACKEND')
      || hasNonEmptyEnv('SPOTTER_CHILD_BACKEND');
}

function hasNonEmptyEnv(key) {
  const v = process.env[key];
  return typeof v === 'string' && v.length > 0;
}

export function isSubagentCall(input) {
  return input !== null
      && typeof input === 'object'
      && typeof input.agent_id === 'string'
      && input.agent_id.length > 0;
}

// Walk up from startCwd looking for .spotter/marker.json. Returns the project
// root path containing the marker, or null if none was found before reaching
// the filesystem root.
//
// Synchronous fs is intentional — hooks run on every Claude Code event and
// must add minimal latency. statSync of one file per directory level is cheap.
export function findSpotterMarker(startCwd) {
  if (typeof startCwd !== 'string' || startCwd.length === 0) return null;
  let dir = startCwd;
  const root = parse(dir).root;
  while (true) {
    const marker = join(dir, '.spotter', 'marker.json');
    try {
      const st = statSync(marker);
      if (st.isFile()) return dir;
    } catch {
      // marker missing at this level — keep walking up
    }
    if (dir === root) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// True when input.cwd does not sit inside a project that has been `spotter install`-ed.
// Used by all 5 hooks to early-exit on unrelated `claude -p` invocations from other tools.
export function isOutsideSpotterProject(input) {
  const cwd = input?.cwd;
  if (typeof cwd !== 'string' || cwd.length === 0) return true;
  return findSpotterMarker(cwd) === null;
}

export async function readStdinJson() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  if (raw.length === 0) {
    const err = new Error('hook received empty stdin — Claude Code is expected to provide a JSON envelope');
    err.exitCode = 2;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (cause) {
    const err = new Error(`hook stdin is not valid JSON: ${cause.message}`);
    err.exitCode = 2;
    err.cause = cause;
    throw err;
  }
}

export function requireString(input, key) {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0) {
    const err = new Error(`hook input missing required string "${key}"`);
    err.exitCode = 2;
    throw err;
  }
  return value;
}

export function optionalString(input, key) {
  const value = input[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    const err = new Error(`hook input "${key}" must be a string if present`);
    err.exitCode = 2;
    throw err;
  }
  return value;
}

export function die(message, exitCode = 2) {
  process.stderr.write(`spotter-hook: ${message}\n`);
  process.exit(exitCode);
}

export function formatTransparentContext(missingTools) {
  // §12.2: transparent phrasing — header `[Spotter からの推奨ツール]` 自体が出典明示を担う。
  const lines = missingTools.map((m) => `- \`${m.name}\`: ${m.reason}`);
  return [
    '[Spotter からの推奨ツール]',
    'このプロンプトに応答する前に、以下のツールを使うべきか検討してください。',
    ...lines,
  ].join('\n');
}

// Phase D (hook parity, 2026-05-08): hook-event JSONL helper for Claude-side hooks.
// Each Claude hook calls this once with its observation; failures are silenced (a
// missing diagnostics file is acceptable, but the hook itself must not break).
import { appendHookEventSafe } from '../core/hook-event-log.mjs';

export async function recordClaudeHookEvent({ projectRoot, event, writeError } = {}) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) return;
  await appendHookEventSafe({
    projectRoot,
    host: 'claude',
    event,
    writeError: writeError ?? ((text) => process.stderr.write(text)),
  });
}

export function formatTransparentBlockReason(missingTools) {
  // §12.3: transparent phrasing — header `[Spotter からの指摘]` 自体が出典明示を担う。
  const lines = missingTools.map((m) => `- \`${m.name}\`: ${m.reason}`);
  return [
    '[Spotter からの指摘]',
    '上記応答ではツールが不足している可能性があります。以下を検討し、必要なら呼び出した上で応答を補正してください。',
    ...lines,
  ].join('\n');
}

// Loud degradation notice (§0 / §14.1): the auditor could not run this turn. Surfaced via the
// same additionalContext channel as findings so the host stays responsive AND the user is told
// they are temporarily unprotected (and, for an expired codex login, exactly how to recover).
// This is the opposite of a silent fallback.
export function formatSpotterWarning({ code, message, stage = 'user_input' } = {}) {
  const header = '[Spotter からの警告]';
  const stopFailure = stage === 'stop';
  if (code === 'E_CODEX_CLI_AUTH') {
    return [
      header,
      stopFailure
        ? 'Spotter の監査エンジン (codex) のログインが失効しているため、直前の応答を Stop 時に監査できませんでした。'
        : 'Spotter の監査エンジン (codex) のログインが失効しているため、今回の入力は監査できませんでした。',
      stopFailure
        ? 'ユーザーに、直前の応答が未監査だったことと「端末で `codex login` を実行して再ログインすれば Spotter の監査が復旧する」ことを伝えてください。'
        : 'この応答を続ける前に、ユーザーに「端末で `codex login` を実行して再ログインすれば Spotter の監査が復旧する」ことを伝えてください。',
    ].join('\n');
  }
  const lines = [
    header,
    stopFailure
      ? `Spotter は直前の応答を Stop 時に監査できませんでした (理由コード: ${code ?? 'unknown'})。直前の応答は未監査です。`
      : `Spotter は今回の入力を監査できませんでした (理由コード: ${code ?? 'unknown'})。この応答は監査されていません。`,
    stopFailure
      ? 'ユーザーに、直前の応答が未監査だったことと Spotter の監査が一時的に無効だったことを伝えてください。'
      : 'この応答を続ける前に、ユーザーに Spotter の監査が一時的に無効になっていることを伝えてください。',
  ];
  if (typeof message === 'string' && message.length > 0) lines.push(`詳細: ${message}`);
  return lines.join('\n');
}
