import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runCodexStopHook } from '../src/cli/codex-hook-cmd.mjs';
import { createEvaluationStore } from '../src/core/evaluation-store.mjs';
import { canonicalizeCodexNestedMcpToolIds } from '../src/core/evaluation-tool-id.mjs';

test('Codex nested MCP canonicalization accepts executable calls but rejects prose mentions', () => {
  const usages = [{
    toolName: 'exec',
    toolInput: `
      const prose = "tools.mcp__fake__from_string({})";
      // tools.mcp__fake__from_line_comment({});
      /* tools.mcp__fake__from_block_comment({}); */
      const result = await tools.mcp__caveat__caveat_search({ query: "known trap" });
      const selected = ALL_TOOLS.find(x => x.name === "mcp__aiterm__pty_open");
      const lookupOnly = ALL_TOOLS.find(x => x.name === "mcp__fake__lookup_only");
      const terminal = await tools[selected.name]({ name: "release", shell: "zsh" });
      text(result);
    `,
  }];

  assert.deepEqual(canonicalizeCodexNestedMcpToolIds(usages), [
    'mcp__caveat__caveat_search',
    'mcp__aiterm__pty_open',
  ]);
});

test('Codex Stop adopts nested MCP and exact SKILL.md text-field read from distinct exec calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spotter-codex-nested-usage-'));
  const projectRoot = join(root, 'project');
  const codexHome = join(root, 'codex-home');
  const databasePath = join(root, 'evaluation.db');
  const observationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  try {
    await mkdir(join(projectRoot, '.spotter'), { recursive: true });
    await writeFile(join(projectRoot, '.spotter', 'marker.json'), '{}\n', 'utf8');
    const skillPath = join(codexHome, 'skills', 'throughline', 'SKILL.md');
    await mkdir(join(codexHome, 'skills', 'throughline'), { recursive: true });
    await writeFile(skillPath, '---\nname: throughline\ndescription: test\n---\n', 'utf8');

    const store = createEvaluationStore({ databasePath });
    store.recordTurn({
      observationId,
      recordedAtMs: 1000,
      projectPath: projectRoot,
      host: 'codex',
      sessionId: 'nested-session',
      auditStatus: 'success',
      proposedToolIds: ['mcp__caveat__caveat_search', 'throughline'],
      observerContextStatus: 'not_requested',
    });
    store.close();

    await runCodexStopHook({
      readInput: async () => ({
        cwd: projectRoot,
        session_id: 'nested-session',
        transcript_path: join(root, 'rollout.jsonl'),
        last_assistant_message: '確認しました。',
      }),
      readCodexToolUsageFn: async () => ({
        scope: 'current-turn',
        usedTools: ['exec'],
        toolCalls: [
          {
            toolName: 'exec',
            toolInput: `const tool = ALL_TOOLS.find(x => x.name === "mcp__caveat__caveat_search");
              const result = await tools[tool.name]({query:"x"}); text(result);`,
          },
          {
            toolName: 'exec',
            toolInput: `const result = await tools.mcp__aiterm__pty_write({session_id:1,text:"sed -n '1,220p' ${skillPath}"}); text(result);`,
          },
        ],
        anomalies: [],
        stats: {},
      }),
      createEvaluationStoreFn: () => createEvaluationStore({ databasePath }),
      codexHome,
      now: () => 2000,
      recordHookEventFn: async () => {},
      readLocalFn: async () => [],
      createAuditorBackendFn: () => ({
        judge: async () => ({ pass: true, findings: [], anomalies: [], meta: { backend: 'codex-cli' } }),
      }),
    });

    const resultStore = createEvaluationStore({ databasePath });
    const recorded = resultStore.getCase(observationId);
    resultStore.close();
    assert.equal(recorded.usageStatus, 'complete');
    assert.deepEqual(recorded.items, [
      { toolId: 'mcp__caveat__caveat_search', outcome: 'adopted' },
      { toolId: 'throughline', outcome: 'adopted' },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
