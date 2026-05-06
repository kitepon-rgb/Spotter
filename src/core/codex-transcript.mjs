import { readFile } from 'node:fs/promises';

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

export async function readCodexUsedTools(transcriptPath) {
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) return [];
  let raw;
  try {
    raw = await readFile(transcriptPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

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
    const payload = parsed.payload;
    if (payload.type !== 'function_call') continue;
    const name = typeof payload.name === 'string' ? payload.name : '';
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
