import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MAX_MODEL_MATRIX_RUNS, runAuditorModelMatrixCommand, percentile } from '../src/cli/auditor-model-matrix-cmd.mjs';
import { resolveCodexAuditorModelSelection } from '../src/core/codex-auditor-model-policy.mjs';

const fixture = {
  schema: 'spotter.auditor_model_fixtures.v1',
  catalog: [{ name: 'mcp__caveat__caveat_search', description: 'Search caveats.' }],
  cases: [
    { id: 'user-pass', stage: 'user_input', input: { userInput: 'hello' }, expected: { pass: true, missingTools: [] } },
    { id: 'user-miss', stage: 'user_input', input: { userInput: 'check caveats' }, expected: { pass: false, missingTools: ['mcp__caveat__caveat_search'] } },
    { id: 'turn-pass', stage: 'turn_end', input: { finalResponse: 'done', usedTools: [] }, expected: { pass: true, missingTools: [] } },
    { id: 'turn-miss', stage: 'turn_end', input: { finalResponse: 'done', usedTools: [] }, expected: { pass: false, missingTools: ['mcp__caveat__caveat_search'] } },
  ],
};
const execFileAsync = promisify(execFile);
const selection = (profile) => resolveCodexAuditorModelSelection({ env: {}, profile });

test('model-matrix validates fixtures before creating any backend', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-model-matrix-invalid-'));
  try {
    const path = join(dir, 'bad.json');
    await writeFile(path, JSON.stringify({ ...fixture, cases: [] }));
    let creates = 0;
    await assert.rejects(runAuditorModelMatrixCommand({ argv: ['--fixtures', path], createBackendFn: () => { creates += 1; } }), /cases/);
    assert.equal(creates, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('model-matrix runs case then repeat then profile round-robin and writes artifact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-model-matrix-order-'));
  try {
    const path = join(dir, 'fixture.json');
    const outputPath = join(dir, 'artifact.json');
    await writeFile(path, JSON.stringify(fixture));
    const calls = [];
    const out = [];
    let now = 0;
    await runAuditorModelMatrixCommand({
      argv: ['--fixtures', path, '--profile', 'baseline', '--profile', 'luna', '--repeat', '2', '--output', outputPath],
      env: {}, now: () => ++now,
      generatedAt: () => '2026-07-12T00:00:00.000Z',
      getCodexCliVersionFn: async () => ({ status: 'unavailable' }),
      createBackendFn: ({ modelProfile }) => ({ modelSelection: selection(modelProfile), judge: async (input) => {
        calls.push(`${input.meta.caseId}:${input.meta.repeat}:${modelProfile}`);
        const row = fixture.cases.find((item) => item.id === input.meta.caseId);
        return { pass: row.expected.pass, findings: row.expected.missingTools.map((toolName) => ({ toolName })), meta: { modelSelection: selection(modelProfile) } };
      } }),
      writeOutput: (text) => out.push(text),
    });
    assert.deepEqual(calls.slice(0, 4), ['user-pass:1:baseline', 'user-pass:1:luna', 'user-pass:2:baseline', 'user-pass:2:luna']);
    const artifact = JSON.parse(out.join(''));
    assert.equal(artifact.runs.length, 16);
    assert.equal(artifact.summary.total, 16);
    assert.equal(artifact.summary.exactMatch, 16);
    assert.equal(artifact.usageStatus, 'not-available');
    assert.equal(artifact.promotionEligible, false);
    assert.deepEqual(artifact.blockingReasons, ['usage_not_available']);
    assert.equal(artifact.profiles.luna.model, 'gpt-5.6-luna');
    assert.equal(JSON.parse(await readFile(outputPath, 'utf8')).fixture.catalogCount, 1);
    assert.equal(artifact.executionOrdering, 'case-repeat-profile');
    assert.equal(artifact.generatedAt, '2026-07-12T00:00:00.000Z');
    assert.deepEqual(artifact.evaluation.profiles, ['baseline', 'luna']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('model-matrix rejects profile environment conflicts before spawning', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-model-matrix-env-'));
  try {
    const path = join(dir, 'fixture.json'); await writeFile(path, JSON.stringify(fixture));
    let creates = 0;
    await assert.rejects(runAuditorModelMatrixCommand({
      argv: ['--fixtures', path], env: { SPOTTER_CODEX_CLI_MODEL: 'override' }, createBackendFn: () => { creates += 1; },
    }), { code: 'E_CODEX_CLI_MODEL_POLICY' });
    assert.equal(creates, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('model-matrix serializes errors without stdout or stderr bodies and fixed percentiles', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-model-matrix-error-'));
  try {
    const path = join(dir, 'fixture.json'); await writeFile(path, JSON.stringify(fixture));
    const out = [];
    await runAuditorModelMatrixCommand({
      argv: ['--fixtures', path, '--profile', 'baseline'], env: {}, getCodexCliVersionFn: async () => ({ status: 'error', message: 'missing' }),
      createBackendFn: ({ modelProfile }) => ({ modelSelection: selection(modelProfile), judge: async () => { throw Object.assign(new Error('x'.repeat(1200)), { code: 'E_TIMEOUT', backend: 'codex-cli', stage: 'user_input', diagnostics: { stdout: 'secret output', stderr: 'secret error', lastMessageCheck: 'present', processCountMethod: 'ps', stdoutTruncated: true } }); } }),
      writeOutput: (text) => out.push(text),
    });
    const artifact = JSON.parse(out.join(''));
    assert.equal(artifact.runs[0].error.diagnostics.stdoutBytes, 13);
    assert.equal(artifact.runs[0].error.diagnostics.stderrBytes, 12);
    assert.deepEqual(artifact.runs[0].actual, { pass: null, missingTools: [], invalidFindingCount: 0, droppedCatalogExternalNames: [], droppedCatalogExternalNameCount: 0, anomalies: [], anomalyCount: 0 });
    assert.equal(artifact.runs[0].error.message.length, 1000);
    assert.equal(artifact.runs[0].error.diagnostics.lastMessageCheck, 'present');
    assert.equal(artifact.runs[0].error.diagnostics.processCountMethod, 'ps');
    assert.equal(artifact.runs[0].error.diagnostics.stdoutTruncated, true);
    assert.doesNotMatch(JSON.stringify(artifact), /secret output|secret error/);
    assert.equal(percentile([1, 2, 3, 4], 0.5), 2);
    assert.equal(percentile([1, 2, 3, 4], 0.95), 4);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('model-matrix passes the backend environment to the Codex version probe', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-model-matrix-version-env-'));
  try {
    const path = join(dir, 'fixture.json'); await writeFile(path, JSON.stringify(fixture));
    const env = { PATH: '/pinned/codex/bin' };
    let observedEnv = null;
    await runAuditorModelMatrixCommand({
      argv: ['--fixtures', path, '--profile', 'baseline'], env,
      getCodexCliVersionFn: async ({ env: probeEnv }) => { observedEnv = probeEnv; return { status: 'available', version: 'codex-cli 0.144.1' }; },
      createBackendFn: ({ env: backendEnv, modelProfile }) => ({ modelSelection: selection(modelProfile), judge: async () => { assert.equal(backendEnv, env); return { pass: true, findings: [], meta: { modelSelection: selection(modelProfile) } }; } }),
      writeOutput: () => {},
    });
    assert.equal(observedEnv, env);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('model-matrix scores filtered catalog names and anomaly types without retaining raw data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-model-matrix-anomaly-'));
  try {
    const path = join(dir, 'fixture.json'); await writeFile(path, JSON.stringify(fixture));
    const artifact = await runAuditorModelMatrixCommand({ argv: ['--fixtures', path, '--profile', 'baseline'], env: {}, getCodexCliVersionFn: async () => ({ status: 'unavailable' }), createBackendFn: ({ modelProfile }) => ({ modelSelection: selection(modelProfile), judge: async () => ({ pass: true, findings: [], anomalies: [{ type: 'hallucination_filtered', raw: { secret: 'do-not-store' } }], meta: { modelSelection: selection(modelProfile), diagnostics: { droppedCatalogExternalNames: ['ghost_tool', 'ghost_tool'] } } }) }), writeOutput: () => {} });
    const run = artifact.runs[0];
    assert.equal(run.schemaSuccess, true);
    assert.equal(run.exactMatch, false);
    assert.deepEqual(run.falsePositiveTools, ['ghost_tool']);
    assert.equal(run.actual.droppedCatalogExternalNameCount, 2);
    assert.equal(run.actual.anomalyCount, 1);
    assert.deepEqual(run.actual.anomalies, ['hallucination_filtered']);
    assert.doesNotMatch(JSON.stringify(artifact), /do-not-store/);
    assert.equal(artifact.summary.anomalyCount, 4);
    assert.equal(artifact.summary.droppedCatalogExternalNameCount, 8);
    assert.ok(artifact.blockingReasons.includes('quality_anomaly'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('model-matrix rejects missing or mismatched backend selection before probing or judging', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-model-matrix-backend-selection-'));
  try {
    const path = join(dir, 'fixture.json'); await writeFile(path, JSON.stringify(fixture));
    for (const backendSelection of [null, selection('baseline')]) {
      let versionCalls = 0;
      let judgeCalls = 0;
      await assert.rejects(runAuditorModelMatrixCommand({
        argv: ['--fixtures', path, '--profile', 'luna'], env: {},
        getCodexCliVersionFn: async () => { versionCalls += 1; return { status: 'unavailable' }; },
        createBackendFn: () => ({ modelSelection: backendSelection, judge: async () => { judgeCalls += 1; } }),
        writeOutput: () => {},
      }), /backend model selection does not match preflight profile: luna/);
      assert.equal(versionCalls, 0);
      assert.equal(judgeCalls, 0);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('model-matrix records missing or mismatched judgment selection as errors, never exact matches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-model-matrix-judgment-selection-'));
  try {
    const path = join(dir, 'fixture.json'); await writeFile(path, JSON.stringify(fixture));
    for (const judgmentSelection of [null, selection('baseline')]) {
      const artifact = await runAuditorModelMatrixCommand({
        argv: ['--fixtures', path, '--profile', 'luna'], env: {},
        getCodexCliVersionFn: async () => ({ status: 'unavailable' }),
        createBackendFn: () => ({
          modelSelection: selection('luna'),
          judge: async () => ({ pass: true, findings: [], meta: { modelSelection: judgmentSelection } }),
        }),
        writeOutput: () => {},
      });
      assert.equal(artifact.summary.error, fixture.cases.length);
      assert.equal(artifact.summary.exactMatch, 0);
      assert.ok(artifact.runs.every((run) => run.status === 'error' && run.exactMatch === false));
      assert.ok(artifact.blockingReasons.includes('run_error'));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('model-matrix normalizes Codex version output without retaining command bodies', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-model-matrix-version-safe-'));
  try {
    const path = join(dir, 'fixture.json'); await writeFile(path, JSON.stringify(fixture));
    const runWithVersion = (result) => runAuditorModelMatrixCommand({
      argv: ['--fixtures', path, '--profile', 'baseline'], env: {},
      getCodexCliVersionFn: async () => result,
      createBackendFn: ({ modelProfile }) => ({
        modelSelection: selection(modelProfile),
        judge: async () => ({ pass: true, findings: [], meta: { modelSelection: selection(modelProfile) } }),
      }),
      writeOutput: () => {},
    });

    const commandSecret = 'VERSION_STDERR_SECRET';
    const failed = await runWithVersion({ status: 'error', code: commandSecret, message: commandSecret, stdout: 'stdout secret', stderr: commandSecret });
    assert.deepEqual(failed.codexCli, {
      status: 'error', code: 'E_CODEX_CLI_VERSION_INVALID', stdoutBytes: 13, stderrBytes: Buffer.byteLength(commandSecret),
    });
    assert.doesNotMatch(JSON.stringify(failed), /VERSION_STDERR_SECRET|stdout secret/);

    const invalidVersion = 'codex-cli 0.144.1\nVERSION_OUTPUT_SECRET';
    const invalid = await runWithVersion({ status: 'available', version: invalidVersion });
    assert.deepEqual(invalid.codexCli, {
      status: 'error', code: 'E_CODEX_CLI_VERSION_INVALID', stdoutBytes: Buffer.byteLength(invalidVersion), stderrBytes: 0,
    });
    assert.doesNotMatch(JSON.stringify(invalid), /VERSION_OUTPUT_SECRET/);

    const valid = await runWithVersion({ status: 'available', version: 'codex-cli 0.144.1' });
    assert.deepEqual(valid.codexCli, { status: 'available', version: 'codex-cli 0.144.1' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('model-matrix rejects dirty or duplicate usedTools before creating a backend', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-model-matrix-used-tools-'));
  try {
    for (const [index, usedTools] of [[''], [' tool'], ['tool', 'tool']].entries()) {
      const value = structuredClone(fixture);
      value.cases[2].input.usedTools = usedTools;
      const path = join(dir, `fixture-${index}.json`); await writeFile(path, JSON.stringify(value));
      let creates = 0;
      let versionCalls = 0;
      await assert.rejects(runAuditorModelMatrixCommand({
        argv: ['--fixtures', path],
        createBackendFn: () => { creates += 1; },
        getCodexCliVersionFn: async () => { versionCalls += 1; return { status: 'unavailable' }; },
      }), /usedTools is invalid/);
      assert.equal(creates, 0);
      assert.equal(versionCalls, 0);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('model-matrix sanitizes malformed pass and finding values before serializing artifacts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-model-matrix-malformed-'));
  try {
    const path = join(dir, 'fixture.json'); await writeFile(path, JSON.stringify(fixture));
    const cyclicToolName = { secret: 'CYCLIC_TOOL_SECRET' };
    cyclicToolName.self = cyclicToolName;
    const responses = [
      { pass: { secret: 'PASS_OBJECT_SECRET' }, findings: [] },
      { pass: false, findings: [{ toolName: '' }] },
      { pass: false, findings: [{ toolName: ' ghost ' }] },
      { pass: false, findings: [{ toolName: cyclicToolName }] },
    ];
    for (const response of responses) {
      const artifact = await runAuditorModelMatrixCommand({
        argv: ['--fixtures', path, '--profile', 'baseline'], env: {},
        getCodexCliVersionFn: async () => ({ status: 'unavailable' }),
        createBackendFn: ({ modelProfile }) => ({
          modelSelection: selection(modelProfile),
          judge: async () => ({ ...response, meta: { modelSelection: selection(modelProfile) } }),
        }),
        writeOutput: () => {},
      });
      const serialized = JSON.stringify(artifact);
      assert.doesNotMatch(serialized, /PASS_OBJECT_SECRET|CYCLIC_TOOL_SECRET/);
      assert.ok(artifact.runs.every((run) => run.status === 'success' && !run.schemaSuccess && !run.exactMatch));
      assert.ok(artifact.runs.every((run) => run.actual.pass === null || typeof run.actual.pass === 'boolean'));
      assert.ok(artifact.runs.every((run) => run.actual.missingTools.every((tool) => typeof tool === 'string' && tool.length > 0 && tool.trim() === tool)));
      assert.ok(artifact.blockingReasons.includes('schema_failure'));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('model-matrix counts a filtered hallucination as a false positive even when expected findings match', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-model-matrix-filtered-fp-'));
  try {
    const oneCase = { ...fixture, cases: [fixture.cases[1]] };
    const path = join(dir, 'fixture.json'); await writeFile(path, JSON.stringify(oneCase));
    const artifact = await runAuditorModelMatrixCommand({
      argv: ['--fixtures', path, '--profile', 'baseline'], env: {},
      getCodexCliVersionFn: async () => ({ status: 'unavailable' }),
      createBackendFn: ({ modelProfile }) => ({
        modelSelection: selection(modelProfile),
        judge: async () => ({
          pass: false,
          findings: [{ toolName: 'mcp__caveat__caveat_search' }],
          meta: { modelSelection: selection(modelProfile), diagnostics: { droppedCatalogExternalNames: ['ghost_tool'] } },
        }),
      }),
      writeOutput: () => {},
    });
    assert.equal(artifact.runs[0].schemaSuccess, true);
    assert.equal(artifact.runs[0].exactMatch, false);
    assert.deepEqual(artifact.runs[0].falsePositiveTools, ['ghost_tool']);
    assert.equal(artifact.summary.falsePositiveTools, 1);
    assert.ok(artifact.blockingReasons.includes('quality_anomaly'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('model-matrix help has a dedicated successful usage', async () => {
  const { stdout } = await execFileAsync(process.execPath, ['bin/spotter.mjs', 'auditor', 'model-matrix', '--help'], { cwd: process.cwd() });
  assert.match(stdout, /Usage: spotter auditor model-matrix --fixtures FILE/);
});

test('model-matrix rejects unknown fields, duplicate expected tools, and inconsistent expected pass', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-model-matrix-semantic-'));
  try {
    for (const [name, value] of Object.entries({
      unknown: { ...fixture, extra: true },
      duplicate: { ...fixture, cases: [{ ...fixture.cases[1], expected: { pass: false, missingTools: ['mcp__caveat__caveat_search', 'mcp__caveat__caveat_search'] } }] },
      inconsistent: { ...fixture, cases: [{ ...fixture.cases[0], expected: { pass: false, missingTools: [] } }] },
    })) {
      const path = join(dir, `${name}.json`); await writeFile(path, JSON.stringify(value));
      await assert.rejects(runAuditorModelMatrixCommand({ argv: ['--fixtures', path] }));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('model-matrix marks duplicate or inconsistent actual findings as schema and exact mismatches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-model-matrix-quality-'));
  try {
    const path = join(dir, 'fixture.json'); await writeFile(path, JSON.stringify(fixture));
    const artifact = await runAuditorModelMatrixCommand({
      argv: ['--fixtures', path, '--profile', 'baseline'], env: {}, getCodexCliVersionFn: async () => ({ status: 'unavailable' }),
      createBackendFn: ({ modelProfile }) => ({ modelSelection: selection(modelProfile), judge: async () => ({ pass: true, findings: [{ toolName: 'mcp__caveat__caveat_search' }, { toolName: 'mcp__caveat__caveat_search' }], meta: { modelSelection: selection(modelProfile) } }) }),
      writeOutput: () => {},
    });
    assert.equal(artifact.runs[0].schemaSuccess, false);
    assert.equal(artifact.runs[0].exactMatch, false);
    assert.equal(artifact.summary.falsePositiveTools, 4);
    assert.equal(artifact.summary.falseNegativeTools, 0);
    assert.ok(artifact.blockingReasons.includes('schema_failure'));
    assert.ok(artifact.blockingReasons.includes('exact_mismatch'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('model-matrix bounds maximum runs before backend creation and records timeout blocking reason', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-model-matrix-bound-'));
  try {
    const path = join(dir, 'fixture.json'); await writeFile(path, JSON.stringify(fixture));
    let creates = 0;
    await assert.rejects(runAuditorModelMatrixCommand({ argv: ['--fixtures', path, '--repeat', String(MAX_MODEL_MATRIX_RUNS)], createBackendFn: () => { creates += 1; } }), /exceeds/);
    assert.equal(creates, 0);
    const artifact = await runAuditorModelMatrixCommand({ argv: ['--fixtures', path, '--profile', 'baseline'], env: {}, getCodexCliVersionFn: async () => ({ status: 'unavailable' }), createBackendFn: ({ modelProfile }) => ({ modelSelection: selection(modelProfile), judge: async () => { throw Object.assign(new Error('timeout'), { code: 'E_CODEX_CLI_TIMEOUT' }); } }), writeOutput: () => {} });
    assert.equal(artifact.summary.timeoutCount, 4);
    assert.equal(artifact.summary.timeoutRate, 1);
    assert.ok(artifact.blockingReasons.includes('run_error'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('representative model-matrix fixture has distinct valid stage cases', async () => {
  const representative = JSON.parse(await readFile(new URL('./fixtures/auditor-model-matrix.v1.json', import.meta.url), 'utf8'));
  assert.equal(representative.cases.length, 4);
  assert.notDeepEqual(representative.cases[2].input, representative.cases[3].input);
  assert.ok(representative.cases[2].input.usedTools.length > 0);
  const dir = await mkdtemp(join(tmpdir(), 'spotter-model-matrix-representative-'));
  try {
    const path = join(dir, 'fixture.json'); await writeFile(path, JSON.stringify(representative));
    await runAuditorModelMatrixCommand({ argv: ['--fixtures', path, '--profile', 'baseline'], env: {}, getCodexCliVersionFn: async () => ({ status: 'unavailable' }), createBackendFn: ({ modelProfile }) => ({ modelSelection: selection(modelProfile), judge: async () => ({ pass: true, findings: [], meta: { modelSelection: selection(modelProfile) } }) }), writeOutput: () => {} });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
