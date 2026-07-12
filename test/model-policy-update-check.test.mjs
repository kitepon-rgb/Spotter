import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  LATEST_MODELS_URL, PRICING_URL, MAX_BODY_BYTES,
  compareVersions, runModelPolicyCheck, main,
} from '../scripts/check-codex-model-policy.mjs';

const policy = { policyVersion: '3', production: { model: 'gpt-5.6-terra' } };
const latest = (version) => `gpt-${version}-sol\ngpt-${version}-terra\ngpt-${version}-luna`;
const pricing = (version) => `GPT-${version} Sol\nGPT-${version} Terra\nGPT-${version} Luna`;
const fetchFor = ({ latestBody = latest('5.6'), pricingBody = pricing('5.6'), latestStatus = 200, pricingStatus = 200 } = {}) => async (url) => {
  if (url === LATEST_MODELS_URL) return new Response(latestBody, { status: latestStatus });
  if (url === PRICING_URL) return new Response(pricingBody, { status: pricingStatus });
  throw new Error('unexpected url');
};

test('model policy update check: current 5.6 is a bounded artifact with no raw source body', async () => {
  const secret = 'PRIVATE-MARKDOWN-MUST-NOT-LEAK';
  const artifact = await runModelPolicyCheck({ fetchFn: fetchFor({ latestBody: `${latest('5.6')} ${secret}` }), policy, now: () => new Date('2026-07-12T00:00:00.000Z') });
  assert.equal(artifact.status, 'current');
  assert.equal(artifact.schema, 'spotter.codex_model_update_check.v1');
  assert.equal(artifact.proposal, null);
  assert.equal(JSON.stringify(artifact).includes(secret), false);
});

test('model policy update check: future 5.7 becomes evaluation-only update proposal', async () => {
  const artifact = await runModelPolicyCheck({ fetchFn: fetchFor({ latestBody: latest('5.7'), pricingBody: pricing('5.7') }), policy });
  assert.equal(artifact.status, 'update-available');
  assert.match(artifact.proposal, /自動昇格・書換えは行わない/);
  assert.equal(artifact.detectedFamily.version, '5.7');
});

test('model policy update check: historical families may differ while both sources agree on the newest family', async () => {
  const artifact = await runModelPolicyCheck({
    fetchFn: fetchFor({
      latestBody: `${latest('5.5')}\n${latest('5.6')}`,
      pricingBody: `${pricing('5.4')}\n${pricing('5.6')}`,
    }),
    policy,
  });
  assert.equal(artifact.status, 'current');
  assert.deepEqual(artifact.candidates.map(({ version }) => version), ['5.6']);
});

test('model policy update check: one-sided, missing role, non-200, and oversize fail loud', async () => {
  await assert.rejects(runModelPolicyCheck({ fetchFn: fetchFor({ latestBody: latest('5.7'), pricingBody: pricing('5.6') }), policy }), { code: 'E_MODEL_POLICY_CHECK_SOURCE_MISMATCH' });
  await assert.rejects(runModelPolicyCheck({ fetchFn: fetchFor({ latestBody: 'gpt-5.7-sol gpt-5.7-terra' }), policy }), { code: 'E_MODEL_POLICY_CHECK_REQUIRED_FAMILY_MISSING' });
  await assert.rejects(runModelPolicyCheck({ fetchFn: fetchFor({ latestStatus: 500 }), policy }), { code: 'E_MODEL_POLICY_CHECK_HTTP_STATUS' });
  await assert.rejects(runModelPolicyCheck({ fetchFn: fetchFor({ latestBody: `gpt-5.6-sol ${'x'.repeat(MAX_BODY_BYTES)}` }), policy }), { code: 'E_MODEL_POLICY_CHECK_BODY_TOO_LARGE' });
});

test('model policy update check: semantic numbers treat 5.10 as newer than 5.9', () => {
  assert.ok(compareVersions('5.10', '5.9') > 0);
});

test('model policy update check: CLI main prints artifact on success and fixed status on failure', async () => {
  const out = []; const err = [];
  const artifact = { schema: 'spotter.codex_model_update_check.v1' };
  const code = await main({ stdout: { write: (value) => out.push(value) }, stderr: { write: (value) => err.push(value) }, run: async () => artifact });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(out.join('')), artifact);
  assert.equal(err.length, 0);
  const failed = await main({ stdout: { write: (value) => out.push(value) }, stderr: { write: (value) => err.push(value) }, run: async () => { throw new Error('secret'); } });
  assert.equal(failed, 1);
  assert.match(err.at(-1), /^E_MODEL_POLICY_CHECK_UNEXPECTED/);
});

test('workflow does not edit model policy and only creates issues for update-available', async () => {
  const workflow = await readFile(new URL('../.github/workflows/model-policy-check.yml', import.meta.url), 'utf8');
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /concurrency:\s*\n\s*group: codex-model-policy-check/s);
  assert.match(workflow, /node-version: '22\.5\.0'/);
  assert.doesNotMatch(workflow, /codex-auditor-model-policy\.mjs.*(?:sed|perl|node -e|mv|cp)/s);
  assert.match(workflow, /steps\.check\.outputs\.status == 'update-available'/);
  assert.match(workflow, /gh issue list --state all/);
});
