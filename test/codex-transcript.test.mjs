import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  codexLastAssistantMessage,
  readCodexToolUsage,
  readCodexUsedTools,
} from '../src/core/codex-transcript.mjs';

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

test('readCodexUsedTools: preserves legacy session-wide and read-error semantics', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-codex-transcript-legacy-contract-'));
  const transcript = join(dir, 'rollout.jsonl');
  try {
    await writeFile(transcript, [
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'previous' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'old_function' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'custom_is_not_legacy' } }),
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'current' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'current_function' } }),
    ].join('\n'), 'utf8');
    assert.deepEqual(await readCodexUsedTools(transcript), ['old_function', 'current_function']);
    assert.deepEqual(await readCodexUsedTools(join(dir, 'missing.jsonl')), []);
    await assert.rejects(readCodexUsedTools(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readCodexToolUsage: recognizes current shell, legacy function, MCP, and agent calls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-codex-transcript-matrix-'));
  const transcript = join(dir, 'rollout.jsonl');
  try {
    await writeFile(transcript, [
      JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'shell-1', arguments: 'private command' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'shell-1', output: 'private output' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'legacy-1' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'legacy-1', output: 'private output' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', namespace: 'mcp__codegraph', name: 'codegraph_explore', call_id: 'mcp-1' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', namespace: 'mcp__caveat__', name: 'caveat_search', call_id: 'mcp-legacy-1' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', namespace: 'mcp__codex_apps__github', name: '_create_pull_request', call_id: 'mcp-leading-underscore-1' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', namespace: 'agents', name: 'spawn_agent', call_id: 'agent-1' } }),
    ].join('\n'), 'utf8');

    const usage = await readCodexToolUsage(transcript);
    assert.equal(usage.scope, 'legacy-whole-transcript');
    assert.deepEqual(usage.usedTools, [
      'exec',
      'exec_command',
      'mcp__codegraph__codegraph_explore',
      'mcp__caveat__caveat_search',
      'mcp__codex_apps__github___create_pull_request',
      'agents.spawn_agent',
    ]);
    assert.deepEqual(usage.toolCalls, [
      { toolName: 'exec', toolInput: 'private command' },
      { toolName: 'exec_command', toolInput: null },
      { toolName: 'mcp__codegraph__codegraph_explore', toolInput: null },
      { toolName: 'mcp__caveat__caveat_search', toolInput: null },
      { toolName: 'mcp__codex_apps__github___create_pull_request', toolInput: null },
      { toolName: 'agents.spawn_agent', toolInput: null },
    ]);
    assert.deepEqual(usage.anomalies, []);
    assert.deepEqual(usage.stats, { lines: 8, parsedLines: 8, toolCalls: 6, recognized: 6, anomalies: 0 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readCodexToolUsage: dedupes by call_id and normalized name', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-codex-transcript-dedupe-'));
  const transcript = join(dir, 'rollout.jsonl');
  try {
    await writeFile(transcript, [
      JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'same-call' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'same-call' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'exec' } }),
    ].join('\n'), 'utf8');

    const usage = await readCodexToolUsage(transcript);
    assert.deepEqual(usage.usedTools, ['exec']);
    assert.equal(usage.stats.recognized, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readCodexToolUsage: retains readable calls while reporting unknown and malformed shapes safely', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-codex-transcript-anomalies-'));
  const transcript = join(dir, 'rollout.jsonl');
  try {
    await writeFile(transcript, [
      JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', arguments: 'do not expose this' } }),
      'not valid json and do not preserve this body',
      JSON.stringify({ type: 'response_item', payload: { type: 'future_tool_call', name: 'future', arguments: 'secret prompt' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'web_search_call', id: 'future-shape', input: 'private query' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', namespace: 'agents', arguments: 'private args' } }),
      JSON.stringify({ type: 'response_item', payload: { name: 'type-is-missing' } }),
      JSON.stringify({ type: 'response_item', payload: null }),
    ].join('\n'), 'utf8');

    const usage = await readCodexToolUsage(transcript);
    assert.deepEqual(usage.usedTools, ['exec']);
    assert.deepEqual(usage.anomalies.map(({ code }) => code), [
      'E_CODEX_TRANSCRIPT_JSON_PARSE',
      'E_CODEX_TOOL_CALL_TYPE_UNKNOWN',
      'E_CODEX_TOOL_CALL_TYPE_UNKNOWN',
      'E_CODEX_TOOL_CALL_NAME_INVALID',
      'E_CODEX_TOOL_CALL_TYPE_UNKNOWN',
      'E_CODEX_RESPONSE_ITEM_PAYLOAD_INVALID',
    ]);
    assert.equal(usage.stats.anomalies, 6);
    assert.doesNotMatch(JSON.stringify(usage.anomalies), /do not expose|secret prompt|private query|private args/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readCodexToolUsage: mixed transcript ignores non-tool response items and preserves legacy wrapper output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-codex-transcript-mixed-'));
  const transcript = join(dir, 'rollout.jsonl');
  try {
    await writeFile(transcript, [
      JSON.stringify({ type: 'response_item', payload: { type: 'message', content: 'normal assistant text' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'custom_tool_call', name: 'must-ignore' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command' } }),
    ].join('\n'), 'utf8');

    const usage = await readCodexToolUsage(transcript);
    assert.deepEqual(usage.usedTools, ['exec_command']);
    assert.deepEqual(usage.anomalies, []);
    assert.deepEqual(await readCodexUsedTools(transcript), ['exec_command']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readCodexToolUsage: last turn_context resets prior-turn tools and anomalies', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-codex-transcript-turn-boundary-'));
  const transcript = join(dir, 'rollout.jsonl');
  try {
    await writeFile(transcript, [
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'previous' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'old-call' } }),
      'malformed previous-turn line',
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'current' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', content: 'current short answer' } }),
    ].join('\n'), 'utf8');

    const current = await readCodexToolUsage(transcript);
    assert.equal(current.scope, 'current-turn');
    assert.deepEqual(current.usedTools, []);
    assert.deepEqual(current.anomalies, []);
    assert.deepEqual(current.stats, { lines: 1, parsedLines: 1, toolCalls: 0, recognized: 0, anomalies: 0 });

    await writeFile(transcript, [
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'previous' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'old-call' } }),
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'current' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', namespace: 'agents', name: 'wait_agent', call_id: 'new-call' } }),
    ].join('\n'), 'utf8');
    const currentWithTool = await readCodexToolUsage(transcript);
    assert.equal(currentWithTool.scope, 'current-turn');
    assert.deepEqual(currentWithTool.usedTools, ['agents.wait_agent']);
    assert.deepEqual(currentWithTool.anomalies, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readCodexToolUsage: unavailable transcript is anomalous while legacy wrapper stays array-compatible', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-codex-transcript-unavailable-'));
  const missing = join(dir, 'missing.jsonl');
  const empty = join(dir, 'empty.jsonl');
  try {
    const missingUsage = await readCodexToolUsage(missing);
    assert.equal(missingUsage.scope, 'unavailable');
    assert.deepEqual(missingUsage.usedTools, []);
    assert.deepEqual(missingUsage.anomalies, [{ code: 'E_CODEX_TRANSCRIPT_NOT_FOUND' }]);
    assert.deepEqual(await readCodexUsedTools(missing), []);

    await writeFile(empty, '', 'utf8');
    const emptyUsage = await readCodexToolUsage(empty);
    assert.equal(emptyUsage.scope, 'unavailable');
    assert.deepEqual(emptyUsage.anomalies, [{ code: 'E_CODEX_TRANSCRIPT_EMPTY' }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readCodexToolUsage: bounded tail finds a recent turn or reports an unbounded current turn', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-codex-transcript-bounded-'));
  const transcript = join(dir, 'rollout.jsonl');
  try {
    const largePrefix = JSON.stringify({ type: 'response_item', payload: { type: 'message', content: 'x'.repeat(4096) } });
    await writeFile(transcript, [
      largePrefix,
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'current' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'current-call' } }),
    ].join('\n'), 'utf8');
    const boundedCurrent = await readCodexToolUsage(transcript, { maxBytes: 512 });
    assert.equal(boundedCurrent.scope, 'current-turn');
    assert.deepEqual(boundedCurrent.usedTools, ['exec']);
    assert.deepEqual(boundedCurrent.anomalies, []);

    await writeFile(transcript, Array.from({ length: 20 }, (_, index) => JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', content: `${index}:${'x'.repeat(80)}` },
    })).join('\n'), 'utf8');
    const unbounded = await readCodexToolUsage(transcript, { maxBytes: 256 });
    assert.equal(unbounded.scope, 'bounded-tail-unverified');
    assert.ok(unbounded.anomalies.some(({ code }) => code === 'E_CODEX_TRANSCRIPT_CURRENT_TURN_EXCEEDS_LIMIT'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('codexLastAssistantMessage: reads observed Codex Stop payload field', () => {
  assert.equal(codexLastAssistantMessage({ last_assistant_message: 'done' }), 'done');
  assert.equal(codexLastAssistantMessage({ lastAssistantMessage: 'done camel' }), 'done camel');
  assert.equal(codexLastAssistantMessage({}), null);
});
