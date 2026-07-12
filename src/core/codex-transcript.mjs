import { open, readFile } from 'node:fs/promises';

const DEFAULT_CODEX_TRANSCRIPT_TAIL_BYTES = 8 * 1024 * 1024;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseArgs(raw) {
  if (isRecord(raw)) return raw;
  if (typeof raw !== 'string' || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function emptyToolUsage(scope = 'unavailable') {
  return {
    usedTools: [],
    anomalies: [],
    scope,
    stats: { lines: 0, parsedLines: 0, toolCalls: 0, recognized: 0, anomalies: 0 },
  };
}

function addToolUsageAnomaly(usage, code, line = null) {
  usage.anomalies.push({
    code,
    ...(Number.isInteger(line) && line > 0 ? { line } : {}),
  });
  usage.stats.anomalies += 1;
}

async function readTranscriptTail(transcriptPath, maxBytes) {
  let handle;
  try {
    handle = await open(transcriptPath, 'r');
  } catch (err) {
    return { errorCode: err?.code === 'ENOENT' ? 'E_CODEX_TRANSCRIPT_NOT_FOUND' : 'E_CODEX_TRANSCRIPT_READ' };
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return { text: '', fileSize: 0, truncated: false, incomplete: false };
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const chunk = await handle.read(buffer, bytesRead, length - bytesRead, start + bytesRead);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start > 0) {
      // The first byte can sit in the middle of a UTF-8 code point or JSON line. Discard that
      // partial line; a missing turn boundary below becomes an explicit anomaly.
      const newline = text.indexOf('\n');
      text = newline === -1 ? '' : text.slice(newline + 1);
    }
    return {
      text,
      fileSize: size,
      truncated: start > 0,
      incomplete: bytesRead !== length,
    };
  } catch {
    return { errorCode: 'E_CODEX_TRANSCRIPT_READ' };
  } finally {
    await handle.close().catch(() => {});
  }
}

function normalizedToolName(payload) {
  const name = typeof payload.name === 'string' && payload.name.length > 0 ? payload.name : null;
  if (!name) return null;
  const namespace = typeof payload.namespace === 'string' && payload.namespace.length > 0
    ? payload.namespace
    : null;
  if (!namespace) return name;
  if (namespace === 'agents') return `agents.${name}`;
  if (namespace.startsWith('mcp__')) return namespace.endsWith('__')
    ? `${namespace}${name}`
    : `${namespace}__${name}`;
  return `${namespace}__${name}`;
}

function looksLikeToolCall(payload) {
  if (typeof payload.type === 'string'
    && (payload.type.endsWith('_call')
      || payload.type.includes('tool_call')
      || payload.type.includes('function_call'))) return true;
  return typeof payload.name === 'string'
    || typeof payload.call_id === 'string'
    || typeof payload.namespace === 'string';
}

export async function readCodexToolUsage(transcriptPath, {
  maxBytes = DEFAULT_CODEX_TRANSCRIPT_TAIL_BYTES,
} = {}) {
  const usage = emptyToolUsage();
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) {
    addToolUsageAnomaly(usage, 'E_CODEX_TRANSCRIPT_PATH_INVALID');
    return usage;
  }
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError('readCodexToolUsage: maxBytes must be a positive integer');
  }
  const tail = await readTranscriptTail(transcriptPath, maxBytes);
  if (tail.errorCode) {
    addToolUsageAnomaly(usage, tail.errorCode);
    return usage;
  }
  if (tail.fileSize === 0) {
    addToolUsageAnomaly(usage, 'E_CODEX_TRANSCRIPT_EMPTY');
    return usage;
  }
  usage.scope = tail.truncated ? 'bounded-tail-unverified' : 'legacy-whole-transcript';

  const seenCallIds = new Set();
  const seenNames = new Set();
  let sawTurnContext = false;

  for (const [index, line] of tail.text.split('\n').entries()) {
    if (!line) continue;
    const lineNumber = tail.truncated ? null : index + 1;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      usage.stats.lines += 1;
      addToolUsageAnomaly(usage, 'E_CODEX_TRANSCRIPT_JSON_PARSE', lineNumber);
      continue;
    }
    // A rollout file contains multiple turns. Stop must audit only the current turn; otherwise a
    // tool or anomaly from any earlier turn would disable short-final skipping for the rest of the
    // session. Current rollouts emit one top-level turn_context before each turn.
    if (isRecord(parsed) && parsed.type === 'turn_context') {
      usage.usedTools.length = 0;
      usage.anomalies.length = 0;
      Object.assign(usage.stats, emptyToolUsage().stats);
      seenCallIds.clear();
      seenNames.clear();
      sawTurnContext = true;
      usage.scope = 'current-turn';
      continue;
    }
    usage.stats.lines += 1;
    usage.stats.parsedLines += 1;
    if (!isRecord(parsed) || parsed.type !== 'response_item') continue;
    if (!isRecord(parsed.payload)) {
      addToolUsageAnomaly(usage, 'E_CODEX_RESPONSE_ITEM_PAYLOAD_INVALID', lineNumber);
      continue;
    }
    const payload = parsed.payload;
    // Result items confirm completion of a call already counted above; they are not new calls and
    // must not be reported as schema anomalies. These two shapes are observed in current rollouts.
    if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') continue;
    if (payload.type !== 'function_call' && payload.type !== 'custom_tool_call') {
      if (looksLikeToolCall(payload)) {
        usage.stats.toolCalls += 1;
        addToolUsageAnomaly(usage, 'E_CODEX_TOOL_CALL_TYPE_UNKNOWN', lineNumber);
      }
      continue;
    }
    usage.stats.toolCalls += 1;
    const name = normalizedToolName(payload);
    if (!name) {
      addToolUsageAnomaly(usage, 'E_CODEX_TOOL_CALL_NAME_INVALID', lineNumber);
      continue;
    }
    usage.stats.recognized += 1;
    const callId = typeof payload.call_id === 'string' && payload.call_id.length > 0
      ? payload.call_id
      : null;
    if (callId && seenCallIds.has(callId)) continue;
    if (seenNames.has(name)) continue;
    if (callId) seenCallIds.add(callId);
    seenNames.add(name);
    usage.usedTools.push(name);
  }
  if (tail.incomplete) addToolUsageAnomaly(usage, 'E_CODEX_TRANSCRIPT_READ_INCOMPLETE');
  if (tail.truncated && !sawTurnContext) {
    addToolUsageAnomaly(usage, 'E_CODEX_TRANSCRIPT_CURRENT_TURN_EXCEEDS_LIMIT');
  }
  return usage;
}

export async function readCodexUsedTools(transcriptPath) {
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) return [];
  let raw;
  try {
    raw = await readFile(transcriptPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  // Public legacy contract: session-wide `function_call` names only. Codex Stop uses the new
  // bounded current-turn reader above; keeping this implementation separate avoids changing the
  // meaning or error behavior of the already-exported helper.
  const tools = [];
  const seen = new Set();
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed.type !== 'response_item' || !isRecord(parsed.payload)) continue;
    if (parsed.payload.type !== 'function_call') continue;
    const name = typeof parsed.payload.name === 'string' ? parsed.payload.name : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    tools.push(name);
  }
  return tools;
}

export function codexLastAssistantMessage(payload) {
  if (!isRecord(payload)) return null;
  const direct = payload.last_assistant_message ?? payload.lastAssistantMessage;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const message = payload.final_response ?? payload.finalResponse;
  if (typeof message === 'string' && message.length > 0) return message;
  return null;
}

export function codexToolInputText(payload) {
  if (!isRecord(payload)) return '';
  const input = payload.tool_input ?? payload.toolInput;
  if (!isRecord(input)) return '';
  const args = parseArgs(input.arguments);
  const command = input.command ?? input.cmd ?? args.command ?? args.cmd;
  return typeof command === 'string' ? command : '';
}
