import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectCodexHookConfiguration } from '../src/cli/doctor.mjs';

test('inspectCodexHookConfiguration: forwards projectRoot and rejects legacy false-success', async () => {
  let received;
  const result = await inspectCodexHookConfiguration({
    projectRoot: '/project',
    diagnosticsFn: async (args) => {
      received = args;
      return {
        availability: 'available',
        readiness: 'misconfigured',
        validation: { sessionStart: { issues: ['async:true', 'timeoutSec'] } },
        trust: { state: 'unknown', action: 'review with /hooks' },
        auditorBackend: 'codex-cli',
        auditorModelSelection: {
          effectiveModel: 'gpt-5.6-luna',
          effectiveReasoningEffort: 'low',
          modelSource: 'profile:luna',
          effortSource: 'profile:luna',
          availability: 'unverified-until-invocation',
        },
      };
    },
  });
  assert.deepEqual(received, { projectRoot: '/project' });
  assert.equal(result.ok, false);
  assert.match(result.detail, /availability=available/);
  assert.match(result.detail, /sessionStart:async:true/);
  assert.match(result.detail, /trust=unknown/);
  assert.match(result.detail, /auditor-backend=codex-cli/);
  assert.match(result.detail, /auditor-model=gpt-5\.6-luna/);
  assert.match(result.detail, /availability=unverified-until-invocation/);
});

test('inspectCodexHookConfiguration: non-Codex active backend has no applicable Codex model', async () => {
  const result = await inspectCodexHookConfiguration({
    diagnosticsFn: async () => ({
      availability: 'available',
      readiness: 'configured-unverified',
      validation: {},
      trust: { state: 'unknown', action: 'review with /hooks' },
      auditorBackend: 'haiku',
      auditorModelSelection: null,
    }),
  });
  assert.match(result.detail, /auditor-backend=haiku/);
  assert.match(result.detail, /auditor-model=not-applicable/);
  assert.doesNotMatch(result.detail, /gpt-/);
});

test('inspectCodexHookConfiguration: configured-unverified is the only configuration OK state', async () => {
  const result = await inspectCodexHookConfiguration({
    diagnosticsFn: async () => ({
      availability: 'available', readiness: 'configured-unverified', validation: {}, trust: { state: 'unknown', action: 'review with /hooks' },
    }),
  });
  assert.equal(result.ok, true);
});

test('inspectCodexHookConfiguration: readiness alone determines configuration status', async () => {
  for (const readiness of ['unavailable', 'not-installed', 'misconfigured', 'configured-unverified']) {
    const result = await inspectCodexHookConfiguration({
      diagnosticsFn: async () => ({
        availability: 'available', readiness, validation: {}, runtime: { observation: 'observed' }, trust: { state: 'unknown', action: 'review with /hooks' },
      }),
    });
    assert.equal(result.ok, readiness === 'configured-unverified', readiness);
  }
});
