import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runEvaluationCommand } from '../src/cli/evaluation-cmd.mjs';

test('evaluation JSON commands emit ASCII-safe output for Windows PowerShell 5.1', async () => {
  const report = {
    totals: { S: 1, P: 1, I: 1, C: 1, A: 0, M: 0, proposalRate: 1, toolAdoptionRate: 0 },
    byProject: { '/プロジェクト/α': { S: 1, P: 1, I: 1, C: 1, A: 0, M: 0 } },
    byTool: { 'mcp__道具__検索': { S: 0, P: 0, I: 1, C: 1, A: 0, M: 0 } },
    byHost: { claude: { S: 1, P: 1, I: 1, C: 1, A: 0, M: 0 } },
  };
  const cases = [{ observationId: '観測-1', toolId: 'Agent（探索）', outcome: 'not_adopted' }];
  const detail = {
    observationId: '観測-1',
    requestText: '日本語の依頼',
    observerSnapshot: { turns: [{ user: '調べて', assistant: '承知しました' }] },
  };

  const invocations = [
    { argv: ['report', '--json'], expected: report },
    { argv: ['cases', '--outcome', 'not-adopted', '--json'], expected: cases },
    { argv: ['case', '観測-1', '--json'], expected: detail },
  ];

  for (const invocation of invocations) {
    let output = '';
    await runEvaluationCommand({
      argv: invocation.argv,
      createStoreFn: () => ({
        summarize: () => report,
        listCases: () => cases,
        getCase: () => detail,
        close: () => {},
      }),
      writeOutput: (text) => { output += text; },
    });

    assert.doesNotMatch(output, /[^\x00-\x7f]/);
    assert.deepEqual(JSON.parse(output), invocation.expected);
  }
});
