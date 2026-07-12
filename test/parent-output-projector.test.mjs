import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectBackendFailure, projectParentAdvice, projectToolIds } from '../src/hooks/parent-output-projector.mjs';
import { discardLegacyPending, pendingPath } from '../src/hooks/pending-context.mjs';
import { runUserPrompt } from '../src/hooks/user-prompt.mjs';
import { runCodexUserPromptSubmitHook } from '../src/cli/codex-hook-cmd.mjs';
import { runCodexStopHook } from '../src/cli/codex-hook-cmd.mjs';

test('projectParentAdvice: projects only bounded safe tool IDs without reasons', () => {
  const sentinel = 'SENTINEL_SHOULD_NOT_LEAK';
  const advice = projectParentAdvice([
    'z-tool', 'a-tool', 'a-tool', `bad\n${sentinel}`, 'bad`markdown', 'x'.repeat(161),
    'tool_2', 'tool_3', 'tool_4', 'tool_5', 'tool_6',
  ]);
  assert.match(advice, /関連する可能性がある利用可能ツール/);
  assert.match(advice, /独立に判断できます/);
  assert.doesNotMatch(advice, /SENTINEL_SHOULD_NOT_LEAK|使え|呼べ|応答前に|補正|伝えてください/);
  assert.deepEqual(projectToolIds(['z-tool', 'a-tool', 'a-tool', 'bad\n', 'x'.repeat(161), 'tool_2', 'tool_3', 'tool_4', 'tool_5', 'tool_6']), ['a-tool', 'tool_2', 'tool_3', 'tool_4', 'tool_5']);
  assert.ok(advice.length <= 2000);
});

test('Codex Stop emits fixed systemMessage without pending or provider text', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'spotter-codex-stop-projector-'));
  try {
    await mkdir(join(projectRoot, '.spotter'), { recursive: true });
    await writeFile(join(projectRoot, '.spotter', 'marker.json'), '{}', 'utf8');
    let output = '';
    let stderr = '';
    await runCodexStopHook({
      readInput: async () => ({ cwd: projectRoot, session_id: 's', transcript_path: '/tmp/missing.jsonl', last_assistant_message: '十分に長い最終応答です' }),
      readCodexToolUsageFn: async () => ({ usedTools: ['shell'], anomalies: [], stats: {} }),
      readLocalFn: async () => [],
      createAuditorBackendFn: () => { const err = new Error('SENTINEL_MESSAGE'); err.code = 'E_CODEX_CLI_TIMEOUT'; err.diagnostics = { stdout: 'SENTINEL_STDOUT', stderr: 'SENTINEL_STDERR' }; throw err; },
      writeOutput: (text) => { output += text; },
      writeError: (text) => { stderr += text; },
    });
    assert.match(JSON.parse(output).systemMessage, /時間内/);
    assert.doesNotMatch(`${output}\n${stderr}`, /SENTINEL_MESSAGE|SENTINEL_STDOUT|SENTINEL_STDERR/);
    await assert.rejects(readFile(pendingPath({ projectRoot, sessionId: 's' }), 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('discardLegacyPending: never reads legacy content and unlinks every legacy shape', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'spotter-discard-pending-'));
  try {
    for (const content of ['', '{malformed', 'null', '[]', '[1]', '["SENTINEL"]']) {
      const sessionId = `session-${Math.random().toString(16).slice(2)}`;
      const path = pendingPath({ projectRoot, sessionId });
      await mkdir(join(projectRoot, '.spotter', 'pending'), { recursive: true });
      await writeFile(path, content, 'utf8');
      const result = await discardLegacyPending({ projectRoot, sessionId });
      assert.deepEqual(result, { discarded: true, diagnostic: null });
      await assert.rejects(readFile(path, 'utf8'), { code: 'ENOENT' });
    }
    assert.deepEqual(await discardLegacyPending({ projectRoot, sessionId: 'missing' }), { discarded: true, diagnostic: null });
    assert.deepEqual(await discardLegacyPending({ projectRoot, sessionId: 'failure', unlinkFn: async () => { throw new Error('SENTINEL'); } }), {
      discarded: false,
      diagnostic: 'legacy_pending_discard_failed',
    });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('projectBackendFailure: normalizes only allow-listed codes and never reflects input', () => {
  for (const code of ['E_CODEX_CLI_AUTH', 'E_CODEX_CLI_USAGE_LIMIT', 'E_CODEX_CLI_MODEL_UNAVAILABLE', 'E_CODEX_CLI_TIMEOUT', 'UNTRUSTED_SENTINEL']) {
    const projected = projectBackendFailure(code);
    assert.match(projected.code, /^E_SPOTTER_AUDIT_/);
    assert.doesNotMatch(`${projected.systemMessage}\n${projected.stderr}`, /UNTRUSTED_SENTINEL/);
  }
  assert.equal(projectBackendFailure('UNTRUSTED_SENTINEL').code, 'E_SPOTTER_AUDIT_GENERIC');
});

test('Claude and Codex UserPromptSubmit project identical advice and exclude auditor sentinels', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'spotter-projector-parity-'));
  const sentinel = 'SENTINEL_AUDITOR_TEXT';
  try {
    await mkdir(join(projectRoot, '.spotter'), { recursive: true });
    await writeFile(join(projectRoot, '.spotter', 'marker.json'), '{}', 'utf8');
    const result = {
      pass: false,
      missing_tools: [
        { name: 'safe-tool', reason: sentinel },
        { name: `unsafe\n${sentinel}`, reason: sentinel },
      ],
    };
    let claudeOutput = '';
    await runUserPrompt({
      readInput: async () => ({ session_id: 's', cwd: projectRoot, prompt: 'これは十分に長いユーザー入力です' }),
      sendRequestFn: async () => ({ ok: true, result }),
      writeOutput: (text) => { claudeOutput += text; },
    });
    let codexOutput = '';
    await runCodexUserPromptSubmitHook({
      readInput: async () => ({ session_id: 's2', cwd: projectRoot, prompt: 'これは十分に長いユーザー入力です' }),
      readLocalFn: async () => [],
      createAuditorBackendFn: () => ({
        name: 'codex-cli',
        judge: async () => ({
          pass: false,
          findings: result.missing_tools.map((entry) => ({ toolName: entry.name, reason: entry.reason })),
          meta: { backend: 'codex-cli' },
        }),
      }),
      writeOutput: (text) => { codexOutput += text; },
    });
    const claudeAdvice = JSON.parse(claudeOutput).hookSpecificOutput.additionalContext;
    const codexAdvice = JSON.parse(codexOutput).hookSpecificOutput.additionalContext;
    assert.equal(claudeAdvice, codexAdvice);
    assert.match(claudeAdvice, /safe-tool/);
    assert.doesNotMatch(claudeAdvice, /SENTINEL_AUDITOR_TEXT|unsafe/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
