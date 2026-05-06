import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexLastAssistantMessage, readCodexUsedTools } from '../src/core/codex-transcript.mjs';

test('readCodexUsedTools: extracts unique function_call names from Codex JSONL transcript', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-codex-transcript-'));
  const transcript = join(dir, 'rollout.jsonl');
  try {
    await writeFile(transcript, [
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'mcp__caveat__caveat_search' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command' } }),
      'not json',
      '',
    ].join('\n'), 'utf8');

    assert.deepEqual(await readCodexUsedTools(transcript), ['mcp__caveat__caveat_search', 'exec_command']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('codexLastAssistantMessage: reads observed Codex Stop payload field', () => {
  assert.equal(codexLastAssistantMessage({ last_assistant_message: 'done' }), 'done');
  assert.equal(codexLastAssistantMessage({ lastAssistantMessage: 'done camel' }), 'done camel');
  assert.equal(codexLastAssistantMessage({}), null);
});
