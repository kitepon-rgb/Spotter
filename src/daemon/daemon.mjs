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
import { createServer, ensureRuntimeDir, removeStaleSocketFile, secureSocketFile, socketPath } from './transport.mjs';
import { readLocal } from '../tool-db/refresh.mjs';
import { legacyResultFromJudgment } from '../core/judgment.mjs';
import {
  createAuditorBackend,
  DEFAULT_HAIKU_AUDITOR_TIMEOUT_MS,
} from '../core/auditor-backend.mjs';
import {
  dispatchCodexRiskCheck,
  isCodexRiskDispatchDryRun,
  isCodexRiskDispatchEnabled,
} from '../core/codex-risk-dispatch.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFile, unlink } from 'node:fs/promises';
const DEFAULT_HAIKU_CALL_WINDOW_MS = 10_000;
// Phase A (hook parity, 2026-05-08): short-final + 0 used_tools のターンは Stop auditor を skip。
// Codex 側 `shouldSkipShortCodexStop` と同じ閾値 (120 chars)。閾値 <= 0 で機能無効。
// finalResponse は code-point 単位で計測 (Codex 側と同じ `[...str.trim()].length`)。
const DEFAULT_STOP_SHORT_FINAL_MAX_CHARS = 120;
// v0.5.0: lowered 60s → 30s. Session-scoped (--resume) means the first call still pays
// cold-start but subsequent calls skip it. 45s covers first-call cold path plus the
// observed Haiku CLI latency spikes (2026-04-20 log shows 20.9s resumed calls and 30s
// timeouts in the wild). Role-collapse recovery (reset → next call is effectively a
// cold start again) stays within budget.
const DEFAULT_HAIKU_TIMEOUT_MS = DEFAULT_HAIKU_AUDITOR_TIMEOUT_MS;
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
  codexRiskCheckEnabled = isCodexRiskDispatchEnabled(),
  codexRiskCheckDryRun = isCodexRiskDispatchDryRun(),
  dispatchCodexRiskCheckFn = dispatchCodexRiskCheck,
  // If a haikuCaller is explicitly injected (test path), default to haiku — the
  // injection itself signals caller intent. Production callers never inject one,
  // so they hit the `auto` branch which runs availability detection. Explicit
  // SPOTTER_AUDITOR_BACKEND env or auditorBackendName override still wins above.
  auditorBackendName = process.env.SPOTTER_AUDITOR_BACKEND || (haikuCaller ? 'haiku' : 'auto'),
  auditorEnv = process.env,
  stopShortFinalMaxChars = resolveStopShortFinalMaxChars(process.env),
  runtimeErrorObserver = async () => ({ collected: false, reason: 'observer_not_configured' }),
  createAuditorBackendFn = createAuditorBackend,
  createServerFn = createServer,
  removeStaleSocketFileFn = removeStaleSocketFile,
  secureSocketFileFn = secureSocketFile,
  writePidFileFn = writeFile,
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

  // v1.2.0: tool list comes from the LOCAL tool-db only. The audit must reflect what
  // this specific project can use — mixing in the global DB caused phantom suggestions
  // from previously-visited projects (Gmail tools popping up in projects with no Gmail
  // MCP, etc.). For tests, the caller can pass `tools` directly. For production,
  // projectRoot drives the load from the Claude-local audit DB:
  // <projectRoot>/.spotter/tool-db.json. Codex hooks use their own host DB.
  let toolList;
  if (Array.isArray(tools)) {
    toolList = tools;
  } else {
    if (!projectRoot) {
      throw new TypeError('startDaemon: either `tools` or `projectRoot` must be provided');
    }
    toolList = await readLocal({ projectRoot, hostAgent: 'claude' });
  }
  logFn(`tool-db loaded: ${toolList.length} tools` + (projectRoot ? ` (project=${projectRoot})` : ''));

  // v1.4.10: default `auto` triggers availability-based selection — Codex CLI when
  // detected on PATH, Haiku otherwise. `SPOTTER_AUDITOR_BACKEND=haiku` (or any other
  // explicit backend) still wins. hostAgent is hard-coded to 'claude' because this
  // daemon process is Claude-only (see readLocal({hostAgent:'claude'}) above and
  // dispatchCodexRiskCheck hostAgent below); without this, `auto` selection would
  // fail with E_BACKEND_HOST_UNKNOWN on Claude Code launches that don't set
  // CLAUDECODE/CLAUDE_CODE (e.g. custom wrappers), even though the daemon clearly
  // belongs to a Claude host.
  const observeFailure = async (kind) => {
    try {
      await runtimeErrorObserver(kind);
    } catch {
      // The production observer is already non-throwing. Keep injected/custom observers
      // from changing daemon behavior as the same telemetry-failure safety boundary.
    }
  };

  let auditorBackend;
  try {
    auditorBackend = createAuditorBackendFn({
      backend: auditorBackendName,
      catalog: toolList,
      projectRoot,
      hostAgent: 'claude',
      env: auditorEnv,
      logger: logFn,
      haikuCaller,
      timeoutMs: DEFAULT_HAIKU_TIMEOUT_MS,
    });
  } catch (error) {
    await observeFailure('auditor_unavailable');
    throw error;
  }

  // Per-turn state, reset on turn_end.
  const state = {
    usedTools: [],
    lastUserInput: null,
  };

  // 10-second recursion-guard bookkeeping. Every auditor spawn updates this; incoming
  // auditor-invoking events within the window are treated as recursive noise and passed.
  // Tests may pass haikuCallWindowMs: 0 to disable this guard.
  let lastAuditorCallAt = 0;

  const runAuditorJudgment = async (input) => {
    lastAuditorCallAt = Date.now();
    try {
      return await auditorBackend.judge(input);
    } catch (error) {
      await observeFailure('auditor_unavailable');
      throw error;
    }
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

    // 10-second window safety net: events that would invoke the auditor within 10s of
    // our own child spawn are likely recursive noise; pass them quietly.
    const needsHaiku = (envelope.event === 'user_input' && envelope.payload?.audit !== false)
      || envelope.event === 'turn_end';
    const sinceLast = Date.now() - lastAuditorCallAt;
    if (
      needsHaiku &&
      haikuCallWindowMs > 0 &&
      lastAuditorCallAt > 0 &&
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

    if (payload.audit === false) {
      logFn('user_input: audit skipped because fresh context was unavailable');
      return { pass: true, missing_tools: [], reason: 'auditor_context_not_fresh' };
    }

    const hasContext = payload.context_status !== undefined || payload.recent_context !== undefined;
    if (hasContext && (payload.context_status !== 'fresh' || !Array.isArray(payload.recent_context))) {
      const err = new Error('context-bearing user_input payload must include fresh recent_context');
      err.code = 'E_AUDITOR_CONTEXT_INPUT';
      throw err;
    }
    if (hasContext && auditorBackend.name === 'haiku') {
      const err = new Error('recent conversation context is not supported by the haiku auditor backend');
      err.code = 'E_AUDITOR_CONTEXT_BACKEND_UNSUPPORTED';
      throw err;
    }
    const judgment = await runAuditorJudgment(hasContext
      ? {
          stage: 'user_input',
          userInput,
          recentContext: payload.recent_context,
          contextStatus: 'fresh',
        }
      : { stage: 'user_input', userInput });
    const result = legacyResultFromJudgment(judgment);
    const meta = judgment.meta ?? {};
    logFn(
      `user_input: pass=${result.pass}, missing=${result.missing_tools.map((m) => m.name).join(',')}, backend=${meta.backend ?? auditorBackend.name}, mode=${meta.mode}, duration_ms=${meta.durationMs}${
        result.reason ? `, reason=${result.reason}` : ''
      }`
    );
    maybeDispatchCodexRiskCheck('user_input', judgment);
    return result;
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

    // Phase A (hook parity): short final + 0 used_tools のターンは auditor を呼ばずに skip。
    // Codex 側 `shouldSkipShortCodexStop` と同じ判定軸。「了解」「ありがとう」級の相槌応答に
    // 7-10s の auditor spawn を毎回掛けないための latency 削減。0 件条件があるので「caveat
    // 検索しました」のような短いツール後報告は skip されない。
    const finalChars = [...finalResponse.trim()].length;
    if (
      shouldSkipShortStop({
        finalResponse,
        usedTools: state.usedTools,
        maxChars: stopShortFinalMaxChars,
      })
    ) {
      logFn(
        `turn_end: pass=true, reason=short_final_no_tools, usedTools=0, finalChars=${finalChars}, maxChars=${stopShortFinalMaxChars}`
      );
      state.usedTools = [];
      state.lastUserInput = null;
      return { pass: true, missing_tools: [], reason: 'short_final_no_tools' };
    }

    // v0.13.0: state.lastUserInput は turn_end の Haiku 判定には渡さない (新軸は
    // final_response + used_tools のみで判定)。ただし「挨拶ターン (user_input が来て
    // いない) は早期 pass」の分岐は上で使うので保存は引き続き必要。
    const savedUsedTools = state.usedTools.slice();
    const judgment = await runAuditorJudgment({
      stage: 'turn_end',
      usedTools: savedUsedTools,
      finalResponse,
    });
    const result = legacyResultFromJudgment(judgment);
    const meta = judgment.meta ?? {};
    logFn(
      `turn_end: pass=${result.pass}, missing=${result.missing_tools.map((m) => m.name).join(',')}, backend=${meta.backend ?? auditorBackend.name}, mode=${meta.mode}, duration_ms=${meta.durationMs}${
        result.reason ? `, reason=${result.reason}` : ''
      }`
    );
    maybeDispatchCodexRiskCheck('turn_end', judgment);

    state.usedTools = [];
    state.lastUserInput = null;
    return result;
  }

  function maybeDispatchCodexRiskCheck(stage, judgment) {
    if (!codexRiskCheckEnabled) {
      if (judgment.pass === false && judgment.findings.length > 0) {
        logFn(`${stage}: codex_risk_check skipped: disabled`);
      }
      return;
    }
    if (!projectRoot) {
      logFn(`${stage}: codex_risk_check skipped: no projectRoot`);
      return;
    }
    if (judgment.pass === true || judgment.findings.length === 0) return;
    dispatchCodexRiskCheckFn({
      projectRoot,
      judgment,
      sessionId,
      stage,
      hostAgent: 'claude',
      dryRun: codexRiskCheckDryRun,
    }).then((dispatch) => {
      if (dispatch?.dispatched) {
        logFn(`${stage}: codex_risk_check dispatched pid=${dispatch.pid ?? 'unknown'} result=${dispatch.resultPath}`);
      }
    }).catch((err) => {
      logFn(`${stage}: codex_risk_check dispatch failed: ${err.message}`);
    });
  }

  const onErrorFn = (err, envelope) => {
    const evt = envelope?.event ?? '(pre-parse)';
    logFn(`handler error on ${evt}: ${err.code ?? 'E_INTERNAL'}: ${err.message}`);
    // Handler/auditor failures are owned above. A connection-level error has no
    // envelope and belongs to the transport boundary here.
    if (envelope === null) void observeFailure('daemon_transport');
  };

  const { server, path } = createServerFn({ sessionId, handler, onError: onErrorFn });

  // assertNoLiveDaemon() above confirmed no live process owns this session_id. Any socket file at
  // `path` is therefore an orphan from a prior daemon that died ungracefully (stop()'s unlink runs
  // only on graceful shutdown). Remove it so listen() doesn't fail with EADDRINUSE — otherwise the
  // daemon dies before "daemon listening" and every resurrect crash-loops, leaving the session
  // permanently unaudited.
  await removeStaleSocketFileFn(path);

  let listening = false;
  try {
    await new Promise((resolve, reject) => {
      server.on('error', (error) => {
        if (!listening) reject(error);
        else void observeFailure('daemon_transport');
      });
      server.listen(path, () => {
        listening = true;
        resolve();
      });
    });
  } catch (error) {
    await observeFailure('daemon_transport');
    throw error;
  }
  await secureSocketFileFn(path);
  logFn(`daemon listening on ${path}`);

  // Write PID file so uninstall/doctor can reason about liveness (§15.3 doctor).
  const pidPath = pidFilePath(sessionId);
  try {
    await writePidFileFn(pidPath, String(process.pid), 'utf8');
  } catch (error) {
    await observeFailure('daemon_persistence');
    await new Promise((resolve) => server.close(resolve)).catch(() => {});
    if (process.platform !== 'win32') await unlink(path).catch(() => {});
    throw error;
  }

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

// Phase A (hook parity): pure-function short-stop predicate. Exported for test
// reuse. `maxChars` is the resolved threshold (env-aware, see resolveStopShortFinalMaxChars);
// `<= 0` disables the skip entirely.
export function shouldSkipShortStop({ finalResponse, usedTools, maxChars }) {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return false;
  if (Array.isArray(usedTools) && usedTools.length > 0) return false;
  return [...String(finalResponse ?? '').trim()].length <= maxChars;
}

// Reads `SPOTTER_STOP_SHORT_FINAL_MAX_CHARS` from env. Empty / missing → default 120.
// Non-numeric → default. `0` or negative → disables the skip (NaN-safe).
export function resolveStopShortFinalMaxChars(env = process.env) {
  const raw = env?.SPOTTER_STOP_SHORT_FINAL_MAX_CHARS;
  if (raw === undefined || raw === '') return DEFAULT_STOP_SHORT_FINAL_MAX_CHARS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_STOP_SHORT_FINAL_MAX_CHARS;
  return parsed;
}

export { DEFAULT_STOP_SHORT_FINAL_MAX_CHARS };
