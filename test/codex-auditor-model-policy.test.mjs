import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CODEX_AUDITOR_MODEL_POLICY,
  resolveCodexAuditorModelSelection,
} from '../src/core/codex-auditor-model-policy.mjs';
import { AuditorBackendError } from '../src/core/auditor-error.mjs';

test('resolveCodexAuditorModelSelection: production default remains gpt-5.4-mini × low', () => {
  const selection = resolveCodexAuditorModelSelection({ env: {} });
  assert.equal(selection.effectiveModel, 'gpt-5.4-mini');
  assert.equal(selection.effectiveReasoningEffort, 'low');
  assert.equal(selection.modelSource, 'policy:production');
  assert.equal(selection.effortSource, 'policy:production');
  assert.equal(selection.policySchema, 'spotter.codex_auditor_model_policy.v1');
  assert.equal(selection.policyVersion, '2');
  assert.equal(selection.policyVerifiedAt, '2026-05-06');
  assert.equal(selection.policyVerificationScope, 'operational-smoke');
  assert.equal(selection.effectiveVerifiedAt, '2026-05-06');
  assert.equal(selection.effectiveStatus, 'production');
  assert.equal(selection.effectiveVerificationScope, 'operational-smoke');
  assert.equal(selection.availability, 'unverified-until-invocation');
});

test('resolveCodexAuditorModelSelection: environment model and effort overrides are independent', () => {
  const modelOnly = resolveCodexAuditorModelSelection({
    env: { SPOTTER_CODEX_CLI_MODEL: 'test-model' },
  });
  assert.equal(modelOnly.effectiveModel, 'test-model');
  assert.equal(modelOnly.effectiveReasoningEffort, 'low');
  assert.equal(modelOnly.modelSource, 'env:SPOTTER_CODEX_CLI_MODEL');
  assert.equal(modelOnly.effortSource, 'policy:production');
  assert.equal(modelOnly.effectiveVerifiedAt, null);
  assert.equal(modelOnly.effectiveStatus, 'override-unverified');
  assert.equal(modelOnly.effectiveVerificationScope, 'not-evaluated');

  const effortOnly = resolveCodexAuditorModelSelection({
    env: { SPOTTER_CODEX_CLI_REASONING_EFFORT: 'medium' },
  });
  assert.equal(effortOnly.effectiveModel, 'gpt-5.4-mini');
  assert.equal(effortOnly.effectiveReasoningEffort, 'medium');
  assert.equal(effortOnly.modelSource, 'policy:production');
  assert.equal(effortOnly.effortSource, 'env:SPOTTER_CODEX_CLI_REASONING_EFFORT');
  assert.equal(effortOnly.effectiveVerifiedAt, null);

  const both = resolveCodexAuditorModelSelection({
    env: { SPOTTER_CODEX_CLI_MODEL: 'test-model', SPOTTER_CODEX_CLI_REASONING_EFFORT: 'high' },
  });
  assert.equal(both.effectiveModel, 'test-model');
  assert.equal(both.effectiveReasoningEffort, 'high');
  assert.equal(both.effectiveVerifiedAt, null);
});

test('resolveCodexAuditorModelSelection: empty environment values are unset but whitespace is invalid', () => {
  const empty = resolveCodexAuditorModelSelection({
    env: { SPOTTER_CODEX_CLI_MODEL: '', SPOTTER_CODEX_CLI_REASONING_EFFORT: '' },
  });
  assert.equal(empty.effectiveModel, 'gpt-5.4-mini');
  assert.throws(
    () => resolveCodexAuditorModelSelection({ env: { SPOTTER_CODEX_CLI_MODEL: ' gpt-5.6-luna' } }),
    { code: 'E_CODEX_CLI_MODEL_POLICY' },
  );
});

test('resolveCodexAuditorModelSelection: semantic profiles are reproducible and do not change production', () => {
  const baseline = resolveCodexAuditorModelSelection({ env: {}, profile: 'baseline' });
  const luna = resolveCodexAuditorModelSelection({ env: {}, profile: 'luna' });
  const terra = resolveCodexAuditorModelSelection({ env: {}, profile: 'terra' });
  const terraMedium = resolveCodexAuditorModelSelection({ env: {}, profile: 'terra-medium' });
  assert.equal(baseline.effectiveModel, 'gpt-5.4-mini');
  assert.equal(baseline.effectiveReasoningEffort, 'low');
  assert.equal(baseline.effectiveVerifiedAt, '2026-05-06');
  assert.equal(baseline.effectiveStatus, 'pending-evaluation');
  assert.equal(baseline.effectiveVerificationScope, 'operational-smoke');
  assert.equal(luna.effectiveModel, 'gpt-5.6-luna');
  assert.equal(luna.effectiveReasoningEffort, 'low');
  assert.equal(luna.effectiveVerifiedAt, null);
  assert.equal(luna.effectiveStatus, 'candidate');
  assert.equal(luna.effectiveVerificationScope, 'not-evaluated');
  assert.equal(terra.effectiveModel, 'gpt-5.6-terra');
  assert.equal(terra.effectiveReasoningEffort, 'low');
  assert.equal(terra.effectiveVerifiedAt, null);
  assert.equal(terraMedium.effectiveModel, 'gpt-5.6-terra');
  assert.equal(terraMedium.effectiveReasoningEffort, 'medium');
  assert.equal(terraMedium.modelSource, 'profile:terra-medium');
  assert.equal(luna.modelSource, 'profile:luna');
  assert.equal(luna.effortSource, 'profile:luna');
  assert.equal(resolveCodexAuditorModelSelection({ env: {} }).effectiveModel, 'gpt-5.4-mini');
});

test('resolveCodexAuditorModelSelection: profile conflicts and unknown profiles fail explicitly', () => {
  assert.throws(
    () => resolveCodexAuditorModelSelection({
      env: { SPOTTER_CODEX_CLI_MODEL: 'test-model' },
      profile: 'luna',
    }),
    (err) => err instanceof AuditorBackendError
      && err.code === 'E_CODEX_CLI_MODEL_POLICY'
      && err.backend === 'codex-cli'
      && err.stage === 'configuration',
  );
  assert.throws(
    () => resolveCodexAuditorModelSelection({ env: {}, profile: 'latest' }),
    { code: 'E_CODEX_CLI_MODEL_POLICY' },
  );
});

test('resolveCodexAuditorModelSelection: invalid injected policy model or effort fails explicitly', () => {
  const invalidModel = structuredClone(CODEX_AUDITOR_MODEL_POLICY);
  invalidModel.production.model = ' gpt-5.4-mini';
  assert.throws(
    () => resolveCodexAuditorModelSelection({ env: {}, policy: invalidModel }),
    { code: 'E_CODEX_CLI_MODEL_POLICY' },
  );
  const invalidEffort = structuredClone(CODEX_AUDITOR_MODEL_POLICY);
  invalidEffort.evaluationProfiles.luna.reasoningEffort = '';
  assert.throws(
    () => resolveCodexAuditorModelSelection({ env: {}, profile: 'luna', policy: invalidEffort }),
    { code: 'E_CODEX_CLI_MODEL_POLICY' },
  );
  const invalidVersion = structuredClone(CODEX_AUDITOR_MODEL_POLICY);
  invalidVersion.policyVersion = 1;
  assert.throws(
    () => resolveCodexAuditorModelSelection({ env: {}, policy: invalidVersion }),
    { code: 'E_CODEX_CLI_MODEL_POLICY' },
  );
  const invalidVerifiedAt = structuredClone(CODEX_AUDITOR_MODEL_POLICY);
  invalidVerifiedAt.production.verifiedAt = null;
  assert.throws(
    () => resolveCodexAuditorModelSelection({ env: {}, policy: invalidVerifiedAt }),
    { code: 'E_CODEX_CLI_MODEL_POLICY' },
  );
  for (const invalidDate of ['2026-99-99', '2026-02-31']) {
    const invalidCalendarDate = structuredClone(CODEX_AUDITOR_MODEL_POLICY);
    invalidCalendarDate.production.verifiedAt = invalidDate;
    assert.throws(
      () => resolveCodexAuditorModelSelection({ env: {}, policy: invalidCalendarDate }),
      { code: 'E_CODEX_CLI_MODEL_POLICY' },
    );
  }
  const invalidUnselectedProfile = structuredClone(CODEX_AUDITOR_MODEL_POLICY);
  invalidUnselectedProfile.evaluationProfiles.terra.status = 'verified';
  assert.throws(
    () => resolveCodexAuditorModelSelection({ env: {}, profile: 'luna', policy: invalidUnselectedProfile }),
    { code: 'E_CODEX_CLI_MODEL_POLICY' },
  );
  const candidateProduction = structuredClone(CODEX_AUDITOR_MODEL_POLICY);
  candidateProduction.production.status = 'candidate';
  assert.throws(
    () => resolveCodexAuditorModelSelection({ env: {}, policy: candidateProduction }),
    { code: 'E_CODEX_CLI_MODEL_POLICY' },
  );
  const productionProfile = structuredClone(CODEX_AUDITOR_MODEL_POLICY);
  productionProfile.evaluationProfiles.luna.status = 'production';
  assert.throws(
    () => resolveCodexAuditorModelSelection({ env: {}, profile: 'luna', policy: productionProfile }),
    { code: 'E_CODEX_CLI_MODEL_POLICY' },
  );
  const mismatchedBaseline = structuredClone(CODEX_AUDITOR_MODEL_POLICY);
  mismatchedBaseline.evaluationProfiles.baseline.model = 'gpt-5.6-luna';
  assert.throws(
    () => resolveCodexAuditorModelSelection({ env: {}, profile: 'baseline', policy: mismatchedBaseline }),
    { code: 'E_CODEX_CLI_MODEL_POLICY' },
  );
});

test('CODEX_AUDITOR_MODEL_POLICY: is deeply immutable', () => {
  assert.ok(Object.isFrozen(CODEX_AUDITOR_MODEL_POLICY));
  assert.ok(Object.isFrozen(CODEX_AUDITOR_MODEL_POLICY.production));
  assert.ok(Object.isFrozen(CODEX_AUDITOR_MODEL_POLICY.evaluationProfiles));
  assert.ok(Object.isFrozen(CODEX_AUDITOR_MODEL_POLICY.evaluationProfiles.luna));
  assert.throws(() => { CODEX_AUDITOR_MODEL_POLICY.production.model = 'other'; }, TypeError);
});

test('codex auditor model policy module has no filesystem or model cache dependency', async () => {
  const source = await readFile(new URL('../src/core/codex-auditor-model-policy.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:fs|models_cache/);
});
