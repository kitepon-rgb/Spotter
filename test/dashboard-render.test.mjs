import assert from 'node:assert/strict';
import test from 'node:test';
import { escapeHtml, renderDashboard } from '../src/dashboard/render.mjs';

const overview = {
  totals: { S: 10, P: 5, I: 4, C: 3, A: 2, M: 1 },
  byProject: { '/work/app': { S: 6, P: 3, I: 2, C: 2, A: 1, M: 0 } },
  byTool: { 'mcp__caveat__search': { S: 4, P: 2, I: 2, C: 1, A: 1, M: 0 } },
};

test('renders device list, overview metrics, rates, and responsive dependency-free layout', () => {
  const html = renderDashboard({
    devices: [
      { id: 'mac', name: 'Mac', online: true, href: '/devices/mac/' },
      { id: 'fox-windows', name: 'FOX Windows native', online: false, href: '/devices/fox-windows/' },
    ],
    selectedDeviceId: 'mac',
    overview,
  });

  assert.match(html, /<title>Mac — Spotter evaluation dashboard<\/title>/);
  assert.match(html, /href="\/">端末を選び直す<\/a>/);
  assert.match(html, /aria-label="端末一覧"/);
  assert.match(html, /Mac<small>online<\/small>/);
  assert.match(html, /FOX Windows native<small>offline<\/small>/);
  assert.match(html, /対象ターン<\/span><strong>10<\/strong>/);
  assert.match(html, /ツール提案あり<\/span><strong>5<\/strong>/);
  assert.match(html, /提案ツール数<\/span><strong>4<\/strong>/);
  assert.match(html, /利用判定済み<\/span><strong>3<\/strong>/);
  assert.match(html, /実際に使用<\/span><strong>2<\/strong>/);
  assert.match(html, /判定不能<\/span><strong>1<\/strong>/);
  assert.match(html, /提案率<small>ツール提案あり ÷ 対象ターン<\/small><\/dt><dd>50% \(5\/10\)<\/dd>/);
  assert.match(html, /採用率<small>実際に使用 ÷ 利用判定済み<\/small><\/dt><dd>67% \(2\/3\)<\/dd>/);
  assert.doesNotMatch(html, />[SPICAM]<\/span>/);
  assert.doesNotMatch(html, /[PA]\/[SC]/);
  assert.match(html, /@media \(max-width: 700px\)/);
  assert.doesNotMatch(html, /<script\b/i);
  assert.doesNotMatch(html, /https:\/\/[^\s]*cdn/i);
});

test('renders project and tool breakdowns plus non-adopted case links', () => {
  const html = renderDashboard({
    device: { id: 'mac', name: 'Mac' },
    ...overview,
    notAdoptedCases: [{ observationId: 'obs-1', recordedAtMs: 0, projectPath: '/work/app', toolId: 'mcp__caveat__search', outcome: 'not_adopted' }],
  });

  assert.match(html, /project別内訳/);
  assert.match(html, /\/work\/app/);
  assert.match(html, /tool別内訳/);
  assert.match(html, /mcp__caveat__search/);
  assert.match(html, /<th scope="col">対象ターン<\/th>/);
  assert.match(html, /<th scope="col">判定不能<\/th>/);
  assert.match(html, /非採用case/);
  assert.match(html, /href="\?case=obs-1"/);
  assert.match(html, /1970-01-01T00:00:00\.000Z/);
});

test('renders request, auditor context, and Throughline snapshot as distinct case-detail sections', () => {
  const html = renderDashboard({
    device: { id: 'mac', name: 'Mac' },
    overview,
    caseDetail: {
      observationId: 'obs-1', sessionId: 'session-1', host: 'codex',
      requestText: 'please inspect this',
      auditorSeenContext: 'context supplied to the auditor only',
      observerContextStatus: 'available',
      observerSnapshot: { turns: [{ user: 'earlier user turn', assistant: 'earlier answer' }] },
      proposedToolIds: ['mcp__caveat__search'], usedToolIds: [], items: [{ outcome: 'not_adopted' }],
    },
  });

  assert.match(html, /<h3 id="request">request<\/h3>/);
  assert.match(html, /please inspect this/);
  assert.match(html, /<h3 id="auditor-context">auditorへ渡したcontext<\/h3>/);
  assert.match(html, /context supplied to the auditor only/);
  assert.match(html, /<h3 id="observer-context">Throughline observer snapshot<\/h3>/);
  assert.match(html, /earlier user turn/);
});

test('escapes all dynamic text and rejects unsafe href protocols', () => {
  const payload = '<img src=x onerror=alert(1)>&"\'';
  const html = renderDashboard({
    devices: [{ id: 'evil', name: payload, online: true, href: 'javascript:alert(1)' }],
    selectedDeviceId: 'evil',
    overview: { totals: {} },
    cases: [{ observationId: 'x', projectPath: payload, toolId: payload, href: 'data:text/html,bad' }],
    caseDetail: { observationId: payload, requestText: payload, auditorSeenContext: payload, observerSnapshot: { payload } },
  });

  assert.equal(escapeHtml(payload), '&lt;img src=x onerror=alert(1)&gt;&amp;&quot;&#39;');
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /javascript:alert/);
  assert.doesNotMatch(html, /data:text\/html/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;&amp;&quot;&#39;/);
});
