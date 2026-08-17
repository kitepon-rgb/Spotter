// Pure, dependency-free HTML rendering for the device-routed evaluation viewer.
// This module deliberately renders only the caller-provided projection: it never
// opens EvaluationStore or asks Throughline for context.

const METRIC_KEYS = ['S', 'P', 'I', 'C', 'A', 'M'];
const METRIC_LABELS = {
  S: '対象ターン',
  P: 'ツール提案あり',
  I: '提案ツール数',
  C: '利用判定済み',
  A: '実際に使用',
  M: '判定不能',
};

/**
 * Render a complete dashboard document.
 *
 * The renderer accepts the dashboard projection as plain data. `overview` may be
 * either an EvaluationStore summary (`totals`, `byProject`, `byTool`) or the
 * equivalent display-oriented fields (`metrics`, `projects`, `tools`).
 */
export function renderDashboard({
  title = 'Spotter evaluation dashboard',
  devices = [],
  selectedDeviceId = null,
  device = null,
  overview = {},
  // `model` is the D1 projection: { totals, byProject, byTool,
  // notAdoptedCases }. Top-level fields are accepted as well so a device
  // server can spread that projection without an adapter.
  model = null,
  totals,
  byProject,
  byTool,
  notAdoptedCases,
  cases,
  caseDetail = null,
  filters = {},
  action = '',
} = {}) {
  const selectedId = selectedDeviceId ?? device?.id ?? null;
  const selectedDevice = device ?? devices.find((item) => item?.id === selectedId) ?? null;
  const pageTitle = selectedDevice?.name ? `${selectedDevice.name} — ${title}` : title;
  const dashboardModel = model ?? ((totals || byProject || byTool || notAdoptedCases)
    ? { totals, byProject, byTool, notAdoptedCases }
    : overview);
  const renderedCases = cases ?? dashboardModel?.notAdoptedCases ?? [];
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(pageTitle)}</title>
<style>${DASHBOARD_CSS}</style>
</head>
<body>
<main class="dashboard">
  <header class="page-header">
    <p class="eyebrow">Spotter</p>
    <h1>${escapeHtml(title)}</h1>
    ${selectedDevice ? `<p class="subtitle">端末: ${escapeHtml(selectedDevice.name ?? selectedDevice.id)} · <a class="device-picker-link" href="/">端末を選び直す</a></p>` : '<p class="subtitle">端末を選択してください。</p>'}
  </header>
  ${renderDevices(devices, selectedId)}
  ${selectedDevice ? renderDeviceContent({ overview: dashboardModel, cases: renderedCases, caseDetail, filters, action }) : ''}
</main>
</body>
</html>`;
}

// Explicit aliases keep device and hub callers from needing to know document
// composition details. Both remain pure functions.
export const renderDeviceDashboard = renderDashboard;
export const renderHubDashboard = renderDashboard;

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderDevices(devices, selectedId) {
  if (!Array.isArray(devices) || devices.length === 0) return '';
  return `<nav class="device-nav" aria-label="端末一覧">
  <h2>端末</h2>
  <ul>${devices.map((device) => {
    const id = String(device?.id ?? '');
    const selected = id === selectedId;
    const online = device?.online === true || device?.status === 'online';
    const label = escapeHtml(device?.name ?? id);
    const href = safeHref(device?.href) ?? `?device=${encodeURIComponent(id)}`;
    return `<li><a${selected ? ' aria-current="page"' : ''} class="device ${online ? 'online' : 'offline'}" href="${escapeHtml(href)}"><span class="status-dot" aria-hidden="true"></span>${label}<small>${online ? 'online' : 'offline'}</small></a></li>`;
  }).join('')}</ul>
</nav>`;
}

function renderDeviceContent({ overview, cases, caseDetail, filters, action }) {
  const totals = overview?.totals ?? overview?.metrics ?? overview ?? {};
  const projects = normaliseBreakdown(overview?.byProject ?? overview?.projects);
  const tools = normaliseBreakdown(overview?.byTool ?? overview?.tools);
  const nonAdopted = Array.isArray(cases) ? cases : [];
  return `${renderFilters(filters, action)}
<section aria-labelledby="overview-heading">
  <div class="section-heading"><h2 id="overview-heading">概要</h2>${renderRates(totals)}</div>
  <div class="metrics" aria-label="評価メトリクス">${METRIC_KEYS.map((key) => `<article class="metric"><span>${METRIC_LABELS[key]}</span><strong>${escapeHtml(metric(totals, key))}</strong></article>`).join('')}</div>
</section>
${renderBreakdown('project-breakdown', 'project別内訳', projects)}
${renderBreakdown('tool-breakdown', 'tool別内訳', tools)}
${renderCases(nonAdopted)}
${caseDetail ? renderCaseDetail(caseDetail) : ''}`;
}

function renderFilters(filters, action) {
  const project = filters?.project ?? filters?.projectPath ?? '';
  const from = filters?.from ?? '';
  const to = filters?.to ?? '';
  return `<form class="filters" method="get" action="${escapeHtml(safeHref(action) ?? '')}">
  <label>project <input name="project" value="${escapeHtml(project)}"></label>
  <label>from <input name="from" type="datetime-local" value="${escapeHtml(from)}"></label>
  <label>to <input name="to" type="datetime-local" value="${escapeHtml(to)}"></label>
  <button type="submit">絞り込む</button>
</form>`;
}

function renderRates(summary) {
  const proposal = rate(metricNumber(summary, 'P'), metricNumber(summary, 'S'));
  const adoption = rate(metricNumber(summary, 'A'), metricNumber(summary, 'C'));
  return `<dl class="rates"><div><dt>提案率<small>ツール提案あり ÷ 対象ターン</small></dt><dd>${escapeHtml(proposal)}</dd></div><div><dt>提案適合率（上限）<small>実際に使用 ÷ 利用判定済み</small></dt><dd>${escapeHtml(adoption)}</dd></div></dl>`;
}

function renderBreakdown(id, title, rows) {
  return `<section aria-labelledby="${id}">
  <h2 id="${id}">${title}</h2>
  ${rows.length === 0 ? '<p class="empty">該当するデータはありません。</p>' : `<div class="table-wrap"><table><thead><tr><th scope="col">項目</th>${METRIC_KEYS.map((key) => `<th scope="col">${METRIC_LABELS[key]}</th>`).join('')}<th scope="col">提案率</th><th scope="col">提案適合率（上限）</th></tr></thead><tbody>${rows.map(([label, summary]) => `<tr><th scope="row">${escapeHtml(label)}</th>${METRIC_KEYS.map((key) => `<td>${escapeHtml(metric(summary, key))}</td>`).join('')}<td>${escapeHtml(rate(metricNumber(summary, 'P'), metricNumber(summary, 'S')))}</td><td>${escapeHtml(rate(metricNumber(summary, 'A'), metricNumber(summary, 'C')))}</td></tr>`).join('')}</tbody></table></div>`}
</section>`;
}

function renderCases(cases) {
  return `<section aria-labelledby="cases-heading">
  <h2 id="cases-heading">非採用case</h2>
  ${cases.length === 0 ? '<p class="empty">非採用caseはありません。</p>' : `<div class="table-wrap"><table><thead><tr><th scope="col">記録時刻</th><th scope="col">project</th><th scope="col">tool</th><th scope="col">outcome</th></tr></thead><tbody>${cases.map((item) => {
    const label = escapeHtml(formatDate(item?.recordedAtMs ?? item?.recordedAt));
    const caseHref = safeHref(item?.href) ?? (item?.observationId ? `?case=${encodeURIComponent(item.observationId)}` : null);
    const project = escapeHtml(item?.projectPath ?? item?.project ?? '');
    const tool = escapeHtml(item?.toolId ?? item?.tool ?? '');
    const outcome = escapeHtml(item?.outcome ?? 'not_adopted');
    return `<tr><td>${caseHref ? `<a href="${escapeHtml(caseHref)}">${label}</a>` : label}</td><td>${project}</td><td>${tool}</td><td>${outcome}</td></tr>`;
  }).join('')}</tbody></table></div>`}
</section>`;
}

function renderCaseDetail(item) {
  return `<section class="case-detail" aria-labelledby="case-detail-heading">
  <h2 id="case-detail-heading">case詳細</h2>
  <dl class="metadata"><div><dt>observation</dt><dd>${escapeHtml(item.observationId)}</dd></div><div><dt>session</dt><dd>${escapeHtml(item.sessionId)}</dd></div><div><dt>host</dt><dd>${escapeHtml(item.host)}</dd></div></dl>
  ${renderTextBlock('request', 'request', item.requestText)}
  ${renderTextBlock('auditor-context', 'auditorへ渡したcontext', item.auditorSeenContext)}
  ${renderTextBlock('observer-context', 'Throughline observer snapshot', formatSnapshot(item.observerSnapshot, item.observerContextStatus))}
  ${renderJsonBlock('proposal-ids', '提案ID', item.proposedToolIds)}
  ${renderJsonBlock('used-ids', '利用ID', item.usedToolIds)}
  ${renderJsonBlock('item-outcomes', 'item結果', item.items)}
</section>`;
}

function renderTextBlock(id, title, value) {
  return `<section aria-labelledby="${id}"><h3 id="${id}">${title}</h3><pre>${escapeHtml(value === null || value === undefined || value === '' ? '(none)' : value)}</pre></section>`;
}

function renderJsonBlock(id, title, value) {
  return renderTextBlock(id, title, JSON.stringify(value ?? [], null, 2));
}

function normaliseBreakdown(value) {
  if (Array.isArray(value)) return value.map((item) => [item.label ?? item.name ?? item.projectPath ?? item.toolId ?? '', item.summary ?? item.metrics ?? item]);
  if (value && typeof value === 'object') return Object.entries(value);
  return [];
}

function metric(summary, key) {
  return String(metricNumber(summary, key));
}

function metricNumber(summary, key) {
  const value = Number(summary?.[key]);
  return Number.isFinite(value) ? value : 0;
}

function rate(numerator, denominator) {
  if (denominator === 0) return 'n/a';
  return `${Math.round((numerator / denominator) * 100)}% (${numerator}/${denominator})`;
}

function formatDate(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  return value === null || value === undefined || value === '' ? '(unknown)' : String(value);
}

function formatSnapshot(snapshot, status) {
  if (snapshot === null || snapshot === undefined) return status ? `(status: ${status})` : '(none)';
  return JSON.stringify(snapshot, null, 2);
}

function safeHref(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const url = new URL(value, 'https://spotter.invalid');
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return value.startsWith('/') || value.startsWith('?') || /^https?:\/\//i.test(value) ? value : null;
  } catch { return null; }
}

const DASHBOARD_CSS = `
:root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; color: #19212b; background: #f5f7fa; }
* { box-sizing: border-box; }
body { margin: 0; }
.dashboard { max-width: 1200px; margin: 0 auto; padding: 2rem clamp(1rem, 4vw, 3rem) 4rem; }
.page-header { border-bottom: 1px solid #d7dce2; margin-bottom: 1.5rem; }
.eyebrow { color: #3565a0; font-weight: 700; letter-spacing: .08em; margin: 0; text-transform: uppercase; }
h1 { margin: .25rem 0; font-size: clamp(1.75rem, 4vw, 2.5rem); } h2 { margin-top: 2rem; } h3 { margin-bottom: .5rem; }
.subtitle, .empty { color: #52606d; }
.device-picker-link { color: inherit; }
.device-nav ul { display: flex; flex-wrap: wrap; gap: .5rem; list-style: none; margin: .5rem 0; padding: 0; }
.device { align-items: center; border: 1px solid #ccd4dd; border-radius: 999px; color: inherit; display: inline-flex; gap: .45rem; padding: .45rem .7rem; text-decoration: none; }
.device[aria-current="page"] { border-color: #1c63b8; box-shadow: 0 0 0 2px #b8d6fa; }.device small { color: #52606d; }.status-dot { background: #a03333; border-radius: 50%; height: .55rem; width: .55rem; }.online .status-dot { background: #16803c; }
.filters { align-items: end; display: flex; flex-wrap: wrap; gap: .75rem; margin: 1.5rem 0; }.filters label { display: grid; font-size: .85rem; gap: .25rem; }.filters input, button { border: 1px solid #aeb8c4; border-radius: .35rem; font: inherit; padding: .45rem; }button { background: #1c63b8; color: white; cursor: pointer; }
.section-heading { align-items: baseline; display: flex; flex-wrap: wrap; gap: 1rem; justify-content: space-between; }.rates { display: flex; gap: 1.25rem; margin: 0; }.rates div { display: flex; gap: .45rem; }.rates dt { color: #52606d; }.rates dt small { display: block; font-size: .72rem; }.rates dd { font-weight: 700; margin: 0; }
.metrics { display: grid; gap: .75rem; grid-template-columns: repeat(6, minmax(110px, 1fr)); }.metric { background: #fff; border: 1px solid #d7dce2; border-radius: .5rem; padding: .8rem; }.metric span { color: #52606d; display: block; }.metric strong { font-size: 1.5rem; }
.table-wrap { overflow-x: auto; }table { border-collapse: collapse; min-width: 680px; width: 100%; }th, td { border-bottom: 1px solid #d7dce2; padding: .6rem; text-align: left; vertical-align: top; }thead { background: #eaf0f6; }tbody tr:nth-child(even) { background: #fbfcfd; }
.case-detail { border-top: 2px solid #1c63b8; margin-top: 2.5rem; }.metadata { display: flex; flex-wrap: wrap; gap: 1rem; }.metadata div { min-width: 12rem; }.metadata dt { color: #52606d; }.metadata dd { margin: .2rem 0; overflow-wrap: anywhere; }pre { background: #1e2935; color: #e6edf3; margin: 0; overflow-x: auto; padding: 1rem; white-space: pre-wrap; word-break: break-word; }
@media (max-width: 700px) { .dashboard { padding-top: 1rem; }.metrics { grid-template-columns: repeat(3, 1fr); }.filters { align-items: stretch; flex-direction: column; }.filters input, button { width: 100%; }.rates { flex-direction: column; gap: .25rem; } }
@media (prefers-color-scheme: dark) { :root { color: #e8edf2; background: #111827; }.page-header, th, td { border-color: #364152; }.metric { background: #182230; border-color: #364152; }.subtitle, .empty, .device small, .rates dt, .metric span, .metadata dt { color: #b6c2cf; }thead { background: #243244; }tbody tr:nth-child(even) { background: #151f2c; }.device { border-color: #526173; } }
`;
