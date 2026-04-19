import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getLastAssistantText } from '../src/hooks/transcript-reader.mjs';

function makeTranscript(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'spotter-transcript-'));
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n'));
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('getLastAssistantText: returns text blocks only, excludes thinking', () => {
  const { path, cleanup } = makeTranscript([
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'INTERNAL REASONING DO NOT LEAK' },
          { type: 'text', text: 'visible response' },
        ],
      },
    },
  ]);
  try {
    const result = getLastAssistantText(path);
    assert.equal(result, 'visible response');
    assert.ok(!result.includes('INTERNAL'));
  } finally {
    cleanup();
  }
});

test('getLastAssistantText: returns the most recent assistant text entry', () => {
  const { path, cleanup } = makeTranscript([
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'old reply' }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'followup' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'latest reply' }] } },
  ]);
  try {
    assert.equal(getLastAssistantText(path), 'latest reply');
  } finally {
    cleanup();
  }
});

test('getLastAssistantText: skips assistant entries that contain only tool_use', () => {
  const { path, cleanup } = makeTranscript([
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'text reply' }] } },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
      },
    },
  ]);
  try {
    assert.equal(getLastAssistantText(path), 'text reply');
  } finally {
    cleanup();
  }
});

test('getLastAssistantText: concatenates multiple text blocks in one entry', () => {
  const { path, cleanup } = makeTranscript([
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'part1 ' },
          { type: 'thinking', thinking: 'dropped' },
          { type: 'text', text: 'part2' },
        ],
      },
    },
  ]);
  try {
    assert.equal(getLastAssistantText(path), 'part1 part2');
  } finally {
    cleanup();
  }
});

test('getLastAssistantText: returns null when transcript file is missing', () => {
  assert.equal(getLastAssistantText('/nonexistent/definitely/missing.jsonl'), null);
});

test('getLastAssistantText: returns null for invalid input', () => {
  assert.equal(getLastAssistantText(''), null);
  assert.equal(getLastAssistantText(null), null);
  assert.equal(getLastAssistantText(undefined), null);
});

test('getLastAssistantText: returns null when no assistant text exists', () => {
  const { path, cleanup } = makeTranscript([
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }],
      },
    },
  ]);
  try {
    assert.equal(getLastAssistantText(path), null);
  } finally {
    cleanup();
  }
});

test('getLastAssistantText: tolerates malformed JSON lines (partial writes)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spotter-transcript-'));
  const path = join(dir, 'transcript.jsonl');
  const valid = JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'good line' }] },
  });
  writeFileSync(path, `${valid}\n{broken partial line`);
  try {
    assert.equal(getLastAssistantText(path), 'good line');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
