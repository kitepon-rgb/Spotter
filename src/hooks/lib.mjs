// Shared hook plumbing — stdin read, error → exit-code mapping per §14.3 / §14.4.
//
// Exit code contract (§14.3 / §14.4):
//   0 = success (normal flow)
//   1 = expected abnormal (daemon unreachable; user should restart daemon)
//   2 = unexpected (propagate to Claude Code transcript)
//
// Silent fallback (exit 0 with missing behaviour) is forbidden. See §14.1.
//
// v0.2 gate helpers (plan §18 / C:\Users\kite_\.claude\plans\10-cuddly-codd.md):
// - isChildCall(): env-var gate for Spotter's own claude -p invocations
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
  const v = process.env.SPOTTER_PARENT_PID;
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

// Map a TransportError / HaikuError into an exit code.
export function exitCodeFor(err) {
  if (err && typeof err.code === 'string') {
    if (err.code === 'E_UNREACHABLE') return 1;
    return 2;
  }
  return 2;
}

export function die(message, exitCode = 2) {
  process.stderr.write(`spotter-hook: ${message}\n`);
  process.exit(exitCode);
}

export function formatTransparentContext(missingTools) {
  // §12.2: transparent phrasing — Bell should reference Spotter explicitly.
  const lines = missingTools.map((m) => `- \`${m.name}\`: ${m.reason}`);
  return [
    '[Spotter からの推奨ツール]',
    'このプロンプトに応答する前に、以下のツールを使うべきか検討してください。',
    ...lines,
    '',
    '使う場合は「Spotter の推奨に従い〜」のように監査役の指摘を明示してください。',
  ].join('\n');
}

export function formatTransparentBlockReason(missingTools) {
  // §12.3: transparent phrasing for Stop hook block.
  const lines = missingTools.map((m) => `- \`${m.name}\`: ${m.reason}`);
  return [
    '[Spotter からの指摘]',
    '上記応答ではツールが不足している可能性があります。以下を検討し、必要なら呼び出した上で応答を補正してください。',
    ...lines,
    '',
    '応答には「Spotter からの指摘を受けて〜」のように監査役の介入を明示してください。',
  ].join('\n');
}
