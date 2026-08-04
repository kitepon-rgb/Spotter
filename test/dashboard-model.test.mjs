import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboardModel } from '../src/dashboard/model.mjs';

test('dashboard model projects saved summary definitions and not-adopted cases', () => {
  const filters = { projectPath: '/projects/alpha', fromMs: 1_000, toMs: 2_000 };
  const totals = {
    S: 10, P: 4, I: 6, C: 5, A: 2, M: 1,
    proposalRate: 0.4, toolAdoptionRate: 0.4,
  };
  const byProject = { '/projects/alpha': totals };
  const byTool = { mcp__tools__alpha: { ...totals, S: 5, P: 2, I: 2, C: 2, A: 1, M: 0, proposalRate: 0.4, toolAdoptionRate: 0.5 } };
  const cases = [{ observationId: 'turn-2', toolId: 'mcp__tools__delta', outcome: 'not_adopted' }];
  const calls = [];
  const store = {
    summarize: (receivedFilters) => {
      calls.push(['summarize', receivedFilters]);
      return { totals, byProject, byTool, byHost: { claude: totals } };
    },
    listCases: (receivedFilters) => {
      calls.push(['listCases', receivedFilters]);
      return cases;
    },
  };

  assert.deepEqual(buildDashboardModel(store, filters), {
    totals,
    byProject,
    byTool,
    notAdoptedCases: cases,
  });
  assert.deepEqual(calls, [
    ['summarize', filters],
    ['listCases', { ...filters, outcome: 'not_adopted' }],
  ]);
});

test('dashboard model does not round outcome-missing items into not-adopted cases', () => {
  const store = {
    summarize: () => ({
      totals: { S: 1, P: 1, I: 1, C: 0, A: 0, M: 1, proposalRate: 1, toolAdoptionRate: null },
      byProject: {},
      byTool: {},
    }),
    listCases: ({ outcome }) => {
      assert.equal(outcome, 'not_adopted');
      return [];
    },
  };

  const model = buildDashboardModel(store);
  assert.equal(model.totals.M, 1);
  assert.equal(model.totals.C, 0);
  assert.deepEqual(model.notAdoptedCases, []);
});
