// Rendering helpers for the local proposal-adoption evaluation store.
// These functions deliberately accept saved store results only: reporting must
// never consult Throughline or any other runtime source.

export function formatEvaluationReport(summary) {
  const lines = ['spotter evaluation report'];
  appendSummary(lines, 'all projects', summary.totals);
  appendGroups(lines, 'by project', summary.byProject);
  appendGroups(lines, 'by tool', summary.byTool);
  appendGroups(lines, 'by host', summary.byHost);
  return `${lines.join('\n')}\n`;
}

export function formatEvaluationCases(cases) {
  const lines = ['spotter evaluation cases'];
  if (cases.length === 0) return `${lines.join('\n')}\n`;
  for (const item of cases) {
    lines.push(`  ${item.observationId} ${new Date(item.recordedAtMs).toISOString()}`);
    lines.push(`    project: ${item.projectPath}`);
    lines.push(`    host: ${item.host}`);
    lines.push(`    tool: ${item.toolId} (${item.outcome})`);
  }
  return `${lines.join('\n')}\n`;
}

export function formatEvaluationCase(item) {
  const lines = [
    `spotter evaluation case ${item.observationId}`,
    '',
    'metadata',
    `  recorded at: ${new Date(item.recordedAtMs).toISOString()}`,
    `  project: ${item.projectPath}`,
    `  host: ${item.host}`,
    `  session: ${item.sessionId}`,
    `  audit status: ${item.auditStatus}`,
    `  usage status: ${item.usageStatus}`,
    `  backend: ${item.backend ?? '(none)'}`,
    `  model: ${item.model ?? '(none)'}`,
    `  spotter version: ${item.spotterVersion ?? '(none)'}`,
    '',
    'request',
    indentText(item.requestText),
    '',
    'auditor seen context',
    indentText(item.auditorSeenContext),
    '',
    `observer snapshot turns (${item.observerContextStatus})`,
    indentJson(item.observerSnapshot?.turns ?? []),
    '',
    'proposal IDs',
    indentJson(item.proposedToolIds),
    '',
    'used IDs',
    indentJson(item.usedToolIds),
    '',
    'item outcomes',
    indentJson(item.items),
  ];
  return `${lines.join('\n')}\n`;
}

function appendGroups(lines, title, groups) {
  lines.push('', title);
  for (const [key, summary] of Object.entries(groups)) appendSummary(lines, key, summary, '  ');
}

function appendSummary(lines, label, summary, prefix = '') {
  lines.push(`${prefix}${label}`);
  lines.push(`${prefix}  S=${summary.S} P=${summary.P} I=${summary.I} C=${summary.C} A=${summary.A} M=${summary.M}`);
  lines.push(`${prefix}  proposal rate: ${fraction(summary.P, summary.S)}`);
  lines.push(`${prefix}  tool adoption rate: ${fraction(summary.A, summary.C)}`);
}

function fraction(numerator, denominator) {
  return denominator === 0 ? `${numerator}/${denominator} = n/a` : `${numerator}/${denominator} = ${Math.round((numerator / denominator) * 100)}%`;
}

function indentText(value) {
  return value === null || value === undefined || value === '' ? '  (none)' : String(value).split('\n').map((line) => `  ${line}`).join('\n');
}

function indentJson(value) {
  return JSON.stringify(value, null, 2).split('\n').map((line) => `  ${line}`).join('\n');
}
