// Session-scoped daemon — receives hook events, dispatches to handlers,
// calls Haiku on user_input / turn_end, keeps used_tools in process memory.
//
// §5.4: the Haiku conversation is session-scoped (one per parent session), realised via
//       --session-id (first call) and --resume (subsequent). The catalog is therefore
//       transmitted once in the first Haiku call; later calls only send incremental info.
// §5.7: event dispatch follows the envelope contract.
// §14:  unexpected errors are thrown; hooks convert them to exit codes.
//
// v0.2 defence layers against daemon proliferation (see plan §18 / C2 verification log):
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
  parseHaikuResponse,
  createHaikuCaller,
} from './haiku-caller.mjs';
import { loadCatalog } from '../catalog/loader.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const DEFAULT_CATALOG_PATH = join(homedir(), '.spotter', 'tool-catalog', 'tools.yaml');
const HAIKU_CALL_WINDOW_MS = 10_000;

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
  catalogPath = DEFAULT_CATALOG_PATH,
  haikuCaller,
  haikuSessionId,
  logFn = () => {},
} = {}) {
  if (!sessionId) {
    throw new TypeError('sessionId is required');
  }

  await ensureRuntimeDir();

  // Layer: preexisting-daemon detection. If a PID file exists AND that process is alive,
  // a sibling daemon is already serving this session_id — throw so the caller can exit.
  await assertNoLiveDaemon(sessionId);

  // Load catalog up front — daemon cannot run without it (§14.1).
  const catalog = await loadCatalog(catalogPath);
  logFn(`catalog loaded: ${catalog.tools.length} tools from ${catalogPath}`);

  // Per-daemon Haiku conversation id. Same UUID is used for --session-id (first)
  // and --resume (subsequent), so Haiku retains the catalog/rules across calls.
  const ownHaikuSessionId = haikuSessionId ?? randomUUID();

  const callHaiku = haikuCaller ?? createHaikuCaller({
    timeoutMs: 28_000,
    haikuSessionId: ownHaikuSessionId,
  });

  // Per-turn state, reset on turn_end.
  const state = {
    usedTools: [],
    lastUserInput: null,
  };

  // Haiku call serialisation + bookkeeping.
  // Serialisation prevents two concurrent incoming events from both computing isFirst=true
  // and double-sending the catalog (audit H2).
  let haikuInitialized = false;
  let lastHaikuCallAt = 0;
  let haikuChain = Promise.resolve();

  const callHaikuTracked = (buildPrompt) => {
    const run = async () => {
      lastHaikuCallAt = Date.now();
      const isFirst = !haikuInitialized;
      const prompt = buildPrompt({ isFirst });
      const raw = await callHaiku(prompt, { isFirst });
      // Only flip to initialised after a successful call so a failed first call is retried
      // (still as first) rather than leaving Haiku with no catalog/rules in its context.
      haikuInitialized = true;
      return raw;
    };
    // Chain onto the previous call; whether it resolved or rejected, we run next.
    const next = haikuChain.then(run, run);
    haikuChain = next.catch(() => {}); // swallow so chain survives rejections
    return next;
  };

  const handler = async (envelope) => {
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
    if (needsHaiku && lastHaikuCallAt > 0 && sinceLast < HAIKU_CALL_WINDOW_MS) {
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
        setImmediate(() => shutdown(server, sessionId, logFn));
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

    const raw = await callHaikuTracked(({ isFirst }) =>
      buildFirstStagePrompt({ catalog, userInput, isFirst })
    );
    const parsed = parseHaikuResponse(raw);
    logFn(`user_input: pass=${parsed.pass}, missing=${parsed.missing_tools.map((m) => m.name).join(',')}`);
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

    const savedUserInput = state.lastUserInput;
    const savedUsedTools = state.usedTools.slice();
    const raw = await callHaikuTracked(({ isFirst }) =>
      buildFinalStagePrompt({
        catalog,
        userInput: savedUserInput,
        usedTools: savedUsedTools,
        finalResponse,
        isFirst,
      })
    );
    const parsed = parseHaikuResponse(raw);
    logFn(`turn_end: pass=${parsed.pass}, missing=${parsed.missing_tools.map((m) => m.name).join(',')}`);

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
      logFn(`daemon listening on ${path} (haikuSessionId=${ownHaikuSessionId})`);
      resolve();
    });
  });

  // Write PID file so uninstall/doctor can reason about liveness (§15.3 doctor).
  const pidPath = pidFilePath(sessionId);
  await writeFile(pidPath, String(process.pid), 'utf8');

  return {
    server,
    path,
    pidPath,
    haikuSessionId: ownHaikuSessionId,
    stop: () => shutdown(server, sessionId, logFn),
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
