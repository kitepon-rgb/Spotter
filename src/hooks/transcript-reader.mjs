// Transcript JSONL reader — extracts the final assistant text from Claude Code's
// transcript file. Used by Stop hook to pass *only* the visible response
// (not thinking, not tool_use) to the Haiku judge.
//
// JSONL format (verified against Claude Code transcripts):
//   {type: "user",      message: {role: "user",      content: [{type:"text", text:"..."}]}, ...}
//   {type: "assistant", message: {role: "assistant", content: [
//     {type:"thinking", thinking:"..."},    // MUST be excluded
//     {type:"tool_use", ...},               // MUST be excluded
//     {type:"text", text:"..."},            // what we want
//   ]}, ...}
//
// Ported from Throughline (MIT, same author) src/transcript-reader.mjs.

import { readFileSync, existsSync } from 'node:fs';

// Concatenate only text blocks — thinking / tool_use / image are dropped.
function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

// Walk the JSONL backwards and return the text of the last assistant entry
// that has at least one non-empty text block. Returns null if no such entry
// exists or the file is missing.
export function getLastAssistantText(transcriptPath) {
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) return null;
  if (!existsSync(transcriptPath)) return null;

  const raw = readFileSync(transcriptPath, 'utf8');
  const lines = raw.split('\n');

  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;

    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (entry.type !== 'assistant') continue;
    const msg = entry.message;
    if (!msg || msg.role !== 'assistant') continue;

    const text = extractText(msg.content);
    if (text.length > 0) return text;
  }

  return null;
}
