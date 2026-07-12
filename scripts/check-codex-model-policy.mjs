import { CODEX_AUDITOR_MODEL_POLICY } from '../src/core/codex-auditor-model-policy.mjs';

export const LATEST_MODELS_URL = 'https://developers.openai.com/api/docs/guides/latest-model.md';
export const PRICING_URL = 'https://learn.chatgpt.com/docs/pricing.md';
export const MAX_BODY_BYTES = 1024 * 1024;
export const FETCH_TIMEOUT_MS = 15_000;

const ROLES = ['sol', 'terra', 'luna'];
const PROPOSAL = '同じfixtureでLuna low/Terra lowを比較し、品質不足時のみTerra mediumを評価する。productionの自動昇格・書換えは行わない。';

export class ModelPolicyCheckError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ModelPolicyCheckError';
    this.code = code;
  }
}

function fail(code) { throw new ModelPolicyCheckError(code); }

function versionKey(major, minor) { return `${Number(major)}.${Number(minor)}`; }

export function compareVersions(left, right) {
  const [leftMajor, leftMinor] = left.split('.').map(Number);
  const [rightMajor, rightMinor] = right.split('.').map(Number);
  return leftMajor - rightMajor || leftMinor - rightMinor;
}

export function extractCompleteFamilies(text, source) {
  const regex = source === 'latest'
    ? /\bgpt-(\d+)\.(\d+)-(sol|terra|luna)\b/gi
    : /\bGPT-(\d+)\.(\d+)\s+(Sol|Terra|Luna)\b/g;
  const byVersion = new Map();
  for (const match of text.matchAll(regex)) {
    const version = versionKey(match[1], match[2]);
    const roles = byVersion.get(version) ?? new Set();
    roles.add(match[3].toLowerCase());
    byVersion.set(version, roles);
  }
  return [...byVersion.entries()]
    .filter(([, roles]) => ROLES.every((role) => roles.has(role)))
    .map(([version]) => ({ version, models: ROLES.map((role) => `gpt-${version}-${role}`) }))
    .sort((a, b) => compareVersions(a.version, b.version));
}

async function readBoundedBody(response) {
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) fail('E_MODEL_POLICY_CHECK_BODY_TOO_LARGE');
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) fail('E_MODEL_POLICY_CHECK_BODY_TOO_LARGE');
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        fail('E_MODEL_POLICY_CHECK_BODY_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export async function fetchMarkdown(url, { fetchFn = fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchFn(url, { signal: controller.signal, headers: { accept: 'text/markdown,text/plain;q=0.9' } });
    } catch {
      fail('E_MODEL_POLICY_CHECK_FETCH_FAILED');
    }
    if (!response || response.status !== 200) fail('E_MODEL_POLICY_CHECK_HTTP_STATUS');
    return await readBoundedBody(response);
  } finally {
    clearTimeout(timeout);
  }
}

function policyProduction(policy) {
  const model = policy?.production?.model;
  const match = typeof model === 'string' && /^gpt-(\d+)\.(\d+)-(sol|terra|luna)$/.exec(model);
  if (!match) fail('E_MODEL_POLICY_CHECK_INVALID_POLICY');
  return { model, version: versionKey(match[1], match[2]) };
}

export async function runModelPolicyCheck({
  fetchFn = fetch,
  now = () => new Date(),
  policy = CODEX_AUDITOR_MODEL_POLICY,
  timeoutMs = FETCH_TIMEOUT_MS,
} = {}) {
  const production = policyProduction(policy);
  const [latestMarkdown, pricingMarkdown] = await Promise.all([
    fetchMarkdown(LATEST_MODELS_URL, { fetchFn, timeoutMs }),
    fetchMarkdown(PRICING_URL, { fetchFn, timeoutMs }),
  ]);
  const latestFamilies = extractCompleteFamilies(latestMarkdown, 'latest');
  const pricingFamilies = extractCompleteFamilies(pricingMarkdown, 'pricing');
  if (latestFamilies.length === 0 || pricingFamilies.length === 0) fail('E_MODEL_POLICY_CHECK_REQUIRED_FAMILY_MISSING');
  const latestDetected = latestFamilies.at(-1);
  const pricingDetected = pricingFamilies.at(-1);
  if (latestDetected.version !== pricingDetected.version) fail('E_MODEL_POLICY_CHECK_SOURCE_MISMATCH');
  const pricingVersionSet = new Set(pricingFamilies.map(({ version }) => version));
  const commonFamilies = latestFamilies.filter(({ version }) => pricingVersionSet.has(version));
  const detectedFamily = latestDetected;
  const status = compareVersions(detectedFamily.version, production.version) > 0 ? 'update-available' : 'current';
  const diagnostics = status === 'current'
    && commonFamilies.some(({ version }) => version !== production.version)
    ? ['E_MODEL_POLICY_CHECK_NON_PRODUCTION_CANDIDATE_PRESENT']
    : [];
  return {
    schema: 'spotter.codex_model_update_check.v1',
    checkedAt: now().toISOString(),
    policy: { version: policy.policyVersion, production: policy.production.model },
    sources: [LATEST_MODELS_URL, PRICING_URL],
    detectedFamily,
    candidates: commonFamilies,
    status,
    proposal: status === 'update-available' ? PROPOSAL : null,
    diagnostics,
  };
}

export async function main({ stdout = process.stdout, stderr = process.stderr, run = runModelPolicyCheck } = {}) {
  try {
    const artifact = await run();
    stdout.write(`${JSON.stringify(artifact)}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof ModelPolicyCheckError ? error.code : 'E_MODEL_POLICY_CHECK_UNEXPECTED';
    stderr.write(`${code}\n`);
    return 1;
  }
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  const exitCode = await main();
  process.exitCode = exitCode;
}
