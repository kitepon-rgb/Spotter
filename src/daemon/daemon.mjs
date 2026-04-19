// Session-scoped daemon — receives hook events, dispatches to handlers,
// calls Haiku on user_input / turn_end, keeps used_tools in process memory.
//
// v0.6.0: preamble (role + schema + catalog) is sent only on the first Haiku call of the
// session; subsequent calls send only the per-turn delta, relying on --resume to replay
// the preamble from session history. This is the OpenClaw pattern and addresses v0.5.x's
// "resumed calls slower than first" observation (prompt bloat had been outweighing the
// --resume prefill savings).
//
// v0.5.0: Haiku calls are session-scoped at the claude -p layer (--session-id + --resume).
// Role collapse (Haiku drifting into Bell's persona) is handled by recovery rather than
// structural prevention: E_HAIKU_SCHEMA → haikuCaller.reset() + silent-pass the offending
// turn (a §0 "想定済み異常 = 記録 + 正常リターン" classification). reset() restores
// isFirstCall=true so the next attempt re-sends the preamble on a fresh session.
//
// §5.7: event dispatch follows the envelope contract.
// §14:  unexpected errors are thrown; hooks convert them to exit codes.
//
// v0.12.0: orphan-cleanup is now heartbeat-based instead of parent-PID watch. Every
// envelope (including readiness) resets a setTimeout; if no hook event arrives within
// HEARTBEAT_TIMEOUT_MS (30 min), the daemon self-shuts. Replaces v0.6.2's --parent-pid
// scheme, which mis-fired in VSCode native-extension environments where process.ppid
// pointed at a short-lived wrapper. UserPromptSubmit hook auto-resurrects a dead daemon.
//
// v0.2 defence layers against daemon proliferation (see plan §18) — still active:
//   - SPOTTER_PARENT_PID env var (set by haiku-caller when spawning claude -p; hooks skip on presence)
//   - agent_id gate (subagent hooks exit 0 before reaching the daemon)
//   - source='startup' gate (session-start hook only spawns daemon for startup sources)
//   - PID preexist check (if a live daemon already serves this session_id, new attempt exits)
//   - 10-second call window (inside the daemon, ignore Haiku-invoking events that arrived within
//     10s of our own claude -p spawn — final safety net against any recursion that slipped past
//     the env-var gate)

import { readFile } from 'node:fs/promises';
import { createServer, ensureRuntimeDir, socketPath } from './transport.mjs';
import {
  buildFirstStagePrompt,
  buildFinalStagePrompt,
  buildPreamble,
  parseHaikuResponse,
  filterCatalogMisses,
  createHaikuCaller,
  HaikuError,
} from './haiku-caller.mjs';
import { readMerged } from '../tool-db/refresh.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFile, unlink } from 'node:fs/promises';
const DEFAULT_HAIKU_CALL_WINDOW_MS = 10_000;
// v0.5.0: lowered 60s → 30s. Session-scoped (--resume) means the first call still pays
// cold-start but subsequent calls skip it. 45s covers first-call cold path plus the
// observed Haiku CLI latency spikes (2026-04-20 log shows 20.9s resumed calls and 30s
// timeouts in the wild). Role-collapse recovery (reset → next call is effectively a
// cold start again) stays within budget.
const DEFAULT_HAIKU_TIMEOUT_MS = 45_000;
// v0.12.0: heartbeat-based orphan cleanup. Every envelope resets a setTimeout; if no
// hook event arrives within this window, the daemon self-shuts. 30 min is the longest
// silence we expect from a live Claude Code session. UserPromptSubmit auto-resurrects
// a dead daemon, so over-aggressive timeout would just cause a visible re-spawn.
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30 * 60 * 1000;

export class DaemonAlreadyRunningError extends Error {
  constructor(sessionId, pid) {
    super(`daemon for session ${sessionId} already running (pid=${pid})`);
    this.name = 'DaemonAlreadyRunningError';
    this.sessionId = sessionId;
    this.pid = pid;
  }
}

export async function startDaemon({
  sessionId,
  projectRoot,
  tools,
  haikuCaller,
  logFn = () => {},
  haikuCallWindowMs = DEFAULT_HAIKU_CALL_WINDOW_MS,
  heartbeatTimeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS,
} = {}) {
  if (!sessionId) {
    throw new TypeError('sessionId is required');
  }
  if (!Number.isFinite(heartbeatTimeoutMs) || heartbeatTimeoutMs <= 0) {
    throw new TypeError('heartbeatTimeoutMs must be a positive number');
  }

  await ensureRuntimeDir();

  // Layer: preexisting-daemon detection. If a PID file exists AND that process is alive,
  // a sibling daemon is already serving this session_id — throw so the caller can exit.
  await assertNoLiveDaemon(sessionId);

  // v0.7.0: tool list comes from tool-db (local + global merged with local-wins).
  // For tests, the caller can pass `tools` directly. For production, projectRoot drives
  // the load from <projectRoot>/.spotter/tool-db.json + ~/.spotter/tool-db.json.
  let toolList;
  if (Array.isArray(tools)) {
    toolList = tools;
  } else {
    if (!projectRoot) {
      throw new TypeError('startDaemon: either `tools` or `projectRoot` must be provided');
    }
    toolList = await readMerged({ projectRoot });
  }
  logFn(`tool-db loaded: ${toolList.length} tools` + (projectRoot ? ` (project=${projectRoot})` : ''));

  // v0.13.3: Haiku occasionally hallucinates tool names outside the catalog (training-memory
  // leakage / few-shot cargo-cult). We filter these post-parse; entries not in this set are
  // dropped. See filterCatalogMisses for the pass-flip semantics.
  const catalogNames = new Set(toolList.map((t) => t.name));

  // v0.6.0: preamble (role + schema + catalog) is built once and threaded into the Haiku
  // caller. The caller prepends it on the first call only; --resume keeps it in session
  // history for all subsequent calls.
  const preamble = buildPreamble({ tools: toolList });
  const callHaiku = haikuCaller ?? createHaikuCaller({ preamble, timeoutMs: DEFAULT_HAIKU_TIMEOUT_MS });

  // Per-turn state, reset on turn_end.
  const state = {
    usedTools: [],
    lastUserInput: null,
  };

  // 10-second recursion-guard bookkeeping. Every Haiku spawn updates this; incoming
  // Haiku-invoking events within the window are treated as recursive noise and passed.
  // Tests may pass haikuCallWindowMs: 0 to disable this guard.
  let lastHaikuCallAt = 0;

  const callHaikuTracked = async (prompt) => {
    lastHaikuCallAt = Date.now();
    const mode = callHaiku.isFirstCall === false ? 'resumed' : 'first';
    const start = Date.now();
    const raw = await callHaiku(prompt);
    return { raw, meta: { durationMs: Date.now() - start, mode } };
  };

  // v0.5.0: shared Haiku-invocation + parse helper. On E_HAIKU_SCHEMA (role collapse),
  // rotates the Haiku session-id and silent-passes the turn (reason: role_collapse_reset).
  // Other Haiku errors (timeout, spawn failure) still propagate — §14 unexpected → throw.
  const runHaikuJudgment = async (stage, prompt) => {
    const { raw, meta } = await callHaikuTracked(prompt);
    let parsed;
    try {
      parsed = parseHaikuResponse(raw);
    } catch (err) {
      if (err instanceof HaikuError && err.code === 'E_HAIKU_SCHEMA') {
        logFn(`${stage}: role collapse detected, session reset: ${err.message}`);
        if (typeof callHaiku.reset === 'function') {
          callHaiku.reset();
        }
        return { parsed: { pass: true, missing_tools: [], reason: 'role_collapse_reset' }, meta };
      }
      throw err;
    }
    const { parsed: filtered, dropped } = filterCatalogMisses(parsed, catalogNames);
    if (dropped.length > 0) {
      logFn(`${stage}: dropped catalog-external names: ${dropped.join(',')}`);
    }
    return { parsed: filtered, meta };
  };

  // v0.12.0: heartbeat. Reset on every envelope; if no event arrives within
  // heartbeatTimeoutMs the daemon self-shuts. Replaces v0.6.2 parent-PID watch.
  // The timer itself is created after server.listen() succeeds (see below).
  let heartbeatHandle = null;
  const resetHeartbeat = () => {
    if (heartbeatHandle !== null) clearTimeout(heartbeatHandle);
    heartbeatHandle = setTimeout(() => {
      heartbeatHandle = null;
      logFn(`heartbeat timeout (${heartbeatTimeoutMs}ms), shutting down`);
      shutdown(server, sessionId, logFn).catch((err) => {
        logFn(`heartbeat shutdown error: ${err.message}`);
      });
    }, heartbeatTimeoutMs);
    heartbeatHandle.unref();
  };

  const handler = async (envelope) => {
    resetHeartbeat();
    if (!envelope || typeof envelope !== 'object') {
      const err = new Error('invalid envelope');
      err.code = 'E_INTERNAL';
      throw err;
    }
    if (envelope.session_id !== sessionId) {
      const err = new Error(`session_id mismatch: daemon=${sessionId}, event=${envelope.session_id}`);
      err.code = 'E_INTERNAL';
      throw err;
    }

    // 10-second window safety net: events that would invoke Haiku within 10s of our own
    // claude -p spawn are likely recursive noise; pass them quietly.
    const needsHaiku = envelope.event === 'user_input' || envelope.event === 'turn_end';
    const sinceLast = Date.now() - lastHaikuCallAt;
    if (
      needsHaiku &&
      haikuCallWindowMs > 0 &&
      lastHaikuCallAt > 0 &&
      sinceLast < haikuCallWindowMs
    ) {
      logFn(`${envelope.event} skipped: within ${sinceLast}ms of own haiku call`);
      return { pass: true, missing_tools: [], reason: 'within_haiku_call_window' };
    }

    switch (envelope.event) {
      case 'readiness':
        return { ready: true };
      case 'user_input':
        return handleUserInput(envelope.payload ?? {});
      case 'tool_used':
        return handleToolUsed(envelope.payload ?? {});
      case 'turn_end':
        return handleTurnEnd(envelope.payload ?? {});
      case 'shutdown':
        setImmediate(() => stop());
        return { stopping: true };
      default: {
        const err = new Error(`unknown event: ${envelope.event}`);
        err.code = 'E_INTERNAL';
        throw err;
      }
    }
  };

  async function handleUserInput(payload) {
    const userInput = payload.user_input;
    if (typeof userInput !== 'string') {
      const err = new Error('user_input payload must include user_input string');
      err.code = 'E_INTERNAL';
      throw err;
    }
    state.lastUserInput = userInput;
    state.usedTools = []; // reset tools for this turn

    const { parsed, meta } = await runHaikuJudgment('user_input', buildFirstStagePrompt({ userInput }));
    logFn(
      `user_input: pass=${parsed.pass}, missing=${parsed.missing_tools.map((m) => m.name).join(',')}, mode=${meta.mode}, duration_ms=${meta.durationMs}${
        parsed.reason ? `, reason=${parsed.reason}` : ''
      }`
    );
    return parsed;
  }

  function handleToolUsed(payload) {
    const name = payload.tool_name;
    if (typeof name !== 'string' || name.length === 0) {
      const err = new Error('tool_used payload must include non-empty tool_name');
      err.code = 'E_INTERNAL';
      throw err;
    }
    state.usedTools.push(name);
    logFn(`tool_used: ${name} (cumulative=${state.usedTools.length})`);
    return { recorded: true };
  }

  async function handleTurnEnd(payload) {
    const finalResponse = payload.final_response;
    if (typeof finalResponse !== 'string') {
      const err = new Error('turn_end payload must include final_response string');
      err.code = 'E_INTERNAL';
      throw err;
    }
    if (payload.stop_hook_active === true) {
      logFn('turn_end: stop_hook_active=true, passing');
      state.usedTools = [];
      state.lastUserInput = null;
      return { pass: true, missing_tools: [], reason: 'stop_hook_active' };
    }
    if (state.lastUserInput === null) {
      logFn('turn_end: no user_input observed, passing');
      return { pass: true, missing_tools: [], reason: 'no_user_input' };
    }

    // v0.13.0: state.lastUserInput は turn_end の Haiku 判定には渡さない (新軸は
    // final_response + used_tools のみで判定)。ただし「挨拶ターン (user_input が来て
    // いない) は早期 pass」の分岐は上で使うので保存は引き続き必要。
    const savedUsedTools = state.usedTools.slice();
    const { parsed, meta } = await runHaikuJudgment(
      'turn_end',
      buildFinalStagePrompt({
        usedTools: savedUsedTools,
        finalResponse,
      })
    );
    logFn(
      `turn_end: pass=${parsed.pass}, missing=${parsed.missing_tools.map((m) => m.name).join(',')}, mode=${meta.mode}, duration_ms=${meta.durationMs}${
        parsed.reason ? `, reason=${parsed.reason}` : ''
      }`
    );

    state.usedTools = [];
    state.lastUserInput = null;
    return parsed;
  }

  const onErrorFn = (err, envelope) => {
    const evt = envelope?.event ?? '(pre-parse)';
    logFn(`handler error on ${evt}: ${err.code ?? 'E_INTERNAL'}: ${err.message}`);
  };

  const { server, path } = createServer({ sessionId, handler, onError: onErrorFn });

  await new Promise((resolve, reject) => {
    server.on('error', (err) => reject(err));
    server.listen(path, () => {
      logFn(`daemon listening on ${path}`);
      resolve();
    });
  });

  // Write PID file so uninstall/doctor can reason about liveness (§15.3 doctor).
  const pidPath = pidFilePath(sessionId);
  await writeFile(pidPath, String(process.pid), 'utf8');

  // Start the heartbeat. The first hook event (typically SessionStart's readiness
  // ping moments later) will reset it; if nothing arrives in heartbeatTimeoutMs we self-shut.
  logFn(`heartbeat armed (timeout=${heartbeatTimeoutMs}ms)`);
  resetHeartbeat();

  const stop = async () => {
    if (heartbeatHandle !== null) {
      clearTimeout(heartbeatHandle);
      heartbeatHandle = null;
    }
    return shutdown(server, sessionId, logFn);
  };

  return {
    server,
    path,
    pidPath,
    stop,
  };
}

async function assertNoLiveDaemon(sessionId) {
  const pidPath = pidFilePath(sessionId);
  let raw;
  try {
    raw = await readFile(pidPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  const pid = parseInt(raw.trim(), 10);
  if (!Number.isFinite(pid)) return; // stale/malformed — treat as absent
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err.code === 'ESRCH') return; // process gone; stale PID file is fine
    if (err.code === 'EPERM') {
      // running under another user — still counts as live
      throw new DaemonAlreadyRunningError(sessionId, pid);
    }
    return;
  }
  throw new DaemonAlreadyRunningError(sessionId, pid);
}

async function shutdown(server, sessionId, logFn) {
  try {
    await new Promise((resolve) => server.close(resolve));
  } catch (err) {
    logFn(`shutdown: server.close failed: ${err.message}`);
  }
  if (process.platform !== 'win32') {
    try {
      await unlink(socketPath(sessionId));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logFn(`shutdown: unlink socket failed: ${err.message}`);
      }
    }
  }
  try {
    await unlink(pidFilePath(sessionId));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logFn(`shutdown: unlink pid failed: ${err.message}`);
    }
  }
  logFn('daemon stopped');
}

export function pidFilePath(sessionId) {
  return join(homedir(), '.spotter', 'runtime', `session-${sessionId}.pid`);
}
