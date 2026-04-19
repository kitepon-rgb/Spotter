// Session-scoped daemon — receives hook events, dispatches to handlers,
// calls Haiku on user_input / turn_end, keeps used_tools in process memory.
//
// §5.4: Claude calls are stateless per turn; process memory holds only lightweight state.
// §5.7: event dispatch is defined per the envelope contract.
// §14: unexpected errors are thrown; hooks convert them to exit codes.

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

const DEFAULT_CATALOG_PATH = join(homedir(), '.spotter', 'tool-catalog', 'tools.yaml');

export async function startDaemon({
  sessionId,
  catalogPath = DEFAULT_CATALOG_PATH,
  haikuCaller,
  logFn = () => {},
} = {}) {
  if (!sessionId) {
    throw new TypeError('sessionId is required');
  }

  await ensureRuntimeDir();

  // Load catalog up front — daemon cannot run without it (§14.1).
  const catalog = await loadCatalog(catalogPath);
  logFn(`catalog loaded: ${catalog.tools.length} tools from ${catalogPath}`);

  // Default Haiku caller: timeout below the hook timeout for user_input/turn_end (§5.7).
  const callHaiku = haikuCaller ?? createHaikuCaller({ timeoutMs: 28_000 });

  // Per-turn state, reset on turn_end.
  const state = {
    usedTools: [],
    lastUserInput: null,
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

    const prompt = buildFirstStagePrompt({ catalog, userInput });
    const raw = await callHaiku(prompt);
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
      // Spotter already intervened this turn — §7.5/§8.1 max-1-loop guarantee.
      logFn('turn_end: stop_hook_active=true, passing');
      state.usedTools = [];
      state.lastUserInput = null;
      return { pass: true, missing_tools: [], reason: 'stop_hook_active' };
    }
    if (state.lastUserInput === null) {
      // No user_input seen this turn — nothing to audit against. Pass quietly.
      logFn('turn_end: no user_input observed, passing');
      return { pass: true, missing_tools: [], reason: 'no_user_input' };
    }

    const prompt = buildFinalStagePrompt({
      catalog,
      userInput: state.lastUserInput,
      usedTools: state.usedTools,
      finalResponse,
    });
    const raw = await callHaiku(prompt);
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
      logFn(`daemon listening on ${path}`);
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
    stop: () => shutdown(server, sessionId, logFn),
  };
}

async function shutdown(server, sessionId, logFn) {
  try {
    await new Promise((resolve) => server.close(resolve));
  } catch (err) {
    // SessionEnd cleanup failures are §14.1 exceptions — warn only.
    logFn(`shutdown: server.close failed: ${err.message}`);
  }
  // On Unix, remove the socket file. On Windows, Named Pipes are auto-cleaned.
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
