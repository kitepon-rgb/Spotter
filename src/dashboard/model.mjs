// Dashboard projection over the host-local evaluation store.  This adapter
// deliberately reuses the store's saved metric definitions instead of
// recalculating proposal or adoption rates for the presentation layer.

export function buildDashboardModel(store, filters = {}) {
  const summary = store.summarize(filters);
  const notAdoptedCases = store.listCases({ ...filters, outcome: 'not_adopted' });
  return {
    totals: summary.totals,
    byProject: summary.byProject,
    byTool: summary.byTool,
    notAdoptedCases,
  };
}
