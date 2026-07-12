import { AuditorBackendError } from './auditor-error.mjs';

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const CODEX_AUDITOR_MODEL_POLICY = deepFreeze({
  schema: 'spotter.codex_auditor_model_policy.v1',
  policyVersion: '3',
  role: 'high-frequency-structured-tool-auditor',
  production: {
    model: 'gpt-5.6-terra',
    reasoningEffort: 'medium',
    verifiedAt: '2026-07-12',
    status: 'production',
    verificationScope: 'operational-smoke',
  },
  evaluationProfiles: {
    baseline: {
      model: 'gpt-5.6-terra',
      reasoningEffort: 'medium',
      verifiedAt: '2026-07-12',
      status: 'verified',
      verificationScope: 'operational-smoke',
    },
    luna: {
      model: 'gpt-5.6-luna',
      reasoningEffort: 'low',
      verifiedAt: '2026-07-12',
      status: 'rejected',
      verificationScope: 'operational-smoke',
    },
    terra: {
      model: 'gpt-5.6-terra',
      reasoningEffort: 'low',
      verifiedAt: '2026-07-12',
      status: 'rejected',
      verificationScope: 'operational-smoke',
    },
    'terra-medium': {
      model: 'gpt-5.6-terra',
      reasoningEffort: 'medium',
      verifiedAt: '2026-07-12',
      status: 'verified',
      verificationScope: 'operational-smoke',
    },
  },
});

export class CodexAuditorModelPolicyError extends AuditorBackendError {
  constructor(message) {
    super('E_CODEX_CLI_MODEL_POLICY', message, {
      backend: 'codex-cli',
      stage: 'configuration',
    });
    this.name = 'CodexAuditorModelPolicyError';
  }
}

function fail(message) {
  throw new CodexAuditorModelPolicyError(message);
}

function requiredCleanString(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    fail(`${label} must be a non-empty string without surrounding whitespace`);
  }
  return value;
}

function optionalEnvironmentOverride(env, key) {
  const value = env?.[key];
  if (value === undefined || value === null || value === '') return null;
  return requiredCleanString(value, key);
}

function policyRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function optionalVerifiedAt(value, label, { required = false } = {}) {
  if (value === null || value === undefined) {
    if (required) fail(`${label} must be an ISO date`);
    return null;
  }
  const verifiedAt = requiredCleanString(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(verifiedAt)) fail(`${label} must be an ISO date`);
  const parsed = new Date(`${verifiedAt}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== verifiedAt) {
    fail(`${label} must be a real ISO calendar date`);
  }
  return verifiedAt;
}

function validateSelection(selection, label, { verifiedAtRequired = false } = {}) {
  const record = policyRecord(selection, label);
  const status = requiredCleanString(record.status, `${label}.status`);
  const verificationScope = requiredCleanString(record.verificationScope, `${label}.verificationScope`);
  if (!['production', 'pending-evaluation', 'candidate', 'verified', 'rejected'].includes(status)) {
    fail(`${label}.status is not supported: ${status}`);
  }
  if (!['operational-smoke', 'not-evaluated'].includes(verificationScope)) {
    fail(`${label}.verificationScope is not supported: ${verificationScope}`);
  }
  const verifiedAt = optionalVerifiedAt(record.verifiedAt, `${label}.verifiedAt`, { required: verifiedAtRequired });
  if (verificationScope === 'not-evaluated' && verifiedAt !== null) {
    fail(`${label}.verifiedAt must be null when verificationScope is not-evaluated`);
  }
  if (verificationScope === 'operational-smoke' && verifiedAt === null) {
    fail(`${label}.verifiedAt is required for an operational smoke`);
  }
  return {
    model: requiredCleanString(record.model, `${label}.model`),
    reasoningEffort: requiredCleanString(record.reasoningEffort, `${label}.reasoningEffort`),
    verifiedAt,
    status,
    verificationScope,
  };
}

function validatePolicy(policy) {
  const record = policyRecord(policy, 'policy');
  const schema = requiredCleanString(record.schema, 'policy.schema');
  if (schema !== 'spotter.codex_auditor_model_policy.v1') fail(`unsupported policy schema: ${schema}`);
  const production = validateSelection(record.production, 'policy.production', { verifiedAtRequired: true });
  if (production.status !== 'production') fail('policy.production.status must be production');
  const rawProfiles = policyRecord(record.evaluationProfiles, 'policy.evaluationProfiles');
  const evaluationProfiles = {};
  for (const profileId of ['baseline', 'luna', 'terra', 'terra-medium']) {
    if (!Object.hasOwn(rawProfiles, profileId)) fail(`policy.evaluationProfiles.${profileId} is required`);
    evaluationProfiles[profileId] = validateSelection(
      rawProfiles[profileId],
      `policy.evaluationProfiles.${profileId}`,
    );
    if (evaluationProfiles[profileId].status === 'production') {
      fail(`policy.evaluationProfiles.${profileId}.status must not be production`);
    }
  }
  const baseline = evaluationProfiles.baseline;
  if (baseline.model !== production.model || baseline.reasoningEffort !== production.reasoningEffort) {
    fail('policy.evaluationProfiles.baseline must match the production model and reasoning effort');
  }
  return {
    schema,
    policyVersion: requiredCleanString(record.policyVersion, 'policy.policyVersion'),
    role: requiredCleanString(record.role, 'policy.role'),
    production,
    evaluationProfiles,
  };
}

export function resolveCodexAuditorModelSelection({
  env = process.env,
  profile = null,
  policy = CODEX_AUDITOR_MODEL_POLICY,
} = {}) {
  const validatedPolicy = validatePolicy(policy);
  const modelOverride = optionalEnvironmentOverride(env, 'SPOTTER_CODEX_CLI_MODEL');
  const effortOverride = optionalEnvironmentOverride(env, 'SPOTTER_CODEX_CLI_REASONING_EFFORT');

  if (profile !== null) {
    const profileId = requiredCleanString(profile, 'profile');
    if (modelOverride || effortOverride) fail('profile selection cannot be combined with environment overrides');
    const selectedProfile = validatedPolicy.evaluationProfiles[profileId];
    if (!selectedProfile) fail(`unknown evaluation profile: ${profileId}`);
    const selection = validateSelection(selectedProfile, `policy.evaluationProfiles.${profileId}`);
    return {
      effectiveModel: selection.model,
      effectiveReasoningEffort: selection.reasoningEffort,
      modelSource: `profile:${profileId}`,
      effortSource: `profile:${profileId}`,
      policySchema: validatedPolicy.schema,
      policyVersion: validatedPolicy.policyVersion,
      policyVerifiedAt: validatedPolicy.production.verifiedAt,
      policyVerificationScope: validatedPolicy.production.verificationScope,
      effectiveVerifiedAt: selection.verifiedAt,
      effectiveStatus: selection.status,
      effectiveVerificationScope: selection.verificationScope,
      role: validatedPolicy.role,
      availability: 'unverified-until-invocation',
    };
  }

  return {
    effectiveModel: modelOverride ?? validatedPolicy.production.model,
    effectiveReasoningEffort: effortOverride ?? validatedPolicy.production.reasoningEffort,
    modelSource: modelOverride ? 'env:SPOTTER_CODEX_CLI_MODEL' : 'policy:production',
    effortSource: effortOverride ? 'env:SPOTTER_CODEX_CLI_REASONING_EFFORT' : 'policy:production',
    policySchema: validatedPolicy.schema,
    policyVersion: validatedPolicy.policyVersion,
    policyVerifiedAt: validatedPolicy.production.verifiedAt,
    policyVerificationScope: validatedPolicy.production.verificationScope,
    effectiveVerifiedAt: modelOverride || effortOverride ? null : validatedPolicy.production.verifiedAt,
    effectiveStatus: modelOverride || effortOverride ? 'override-unverified' : validatedPolicy.production.status,
    effectiveVerificationScope: modelOverride || effortOverride
      ? 'not-evaluated'
      : validatedPolicy.production.verificationScope,
    role: validatedPolicy.role,
    availability: 'unverified-until-invocation',
  };
}
