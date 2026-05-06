import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAuditorJudgeCommand, runAuditorMatrixCommand } from '../src/cli/auditor-cmd.mjs';

test('runAuditorJudgeCommand: invokes selected backend with normalized user_input payload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-auditor-cmd-'));
  const inputPath = join(dir, 'input.json');
  const out = [];
  try {
    await writeFile(inputPath, JSON.stringify({ user_input: '既知の罠を確認して' }), 'utf8');
    await runAuditorJudgeCommand({
      argv: [
        '--stage', 'user_input',
        '--input', inputPath,
        '--project', dir,
        '--host-agent', 'codex',
        '--backend', 'codex-cli',
      ],
      readLocalFn: async ({ projectRoot, hostAgent }) => {
        assert.equal(projectRoot, dir);
        assert.equal(hostAgent, 'codex');
        return [{ name: 'mcp__caveat__caveat_search', description: 'Search caveats.' }];
      },
      createAuditorBackendFn: ({ backend, catalog, projectRoot, hostAgent }) => {
        assert.equal(backend, 'codex-cli');
        assert.equal(catalog.length, 1);
        assert.equal(projectRoot, dir);
        assert.equal(hostAgent, 'codex');
        return {
          name: 'codex-cli',
          judge: async (input) => ({
            pass: true,
            findings: [],
            anomalies: [],
            meta: { backend: 'codex-cli', stage: input.stage, userInput: input.userInput },
          }),
        };
      },
      writeOutput: (text) => out.push(text),
    });
    const parsed = JSON.parse(out.join(''));
    assert.equal(parsed.pass, true);
    assert.equal(parsed.meta.backend, 'codex-cli');
    assert.equal(parsed.meta.userInput, '既知の罠を確認して');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runAuditorJudgeCommand: validates turn_end payload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-auditor-cmd-bad-'));
  const inputPath = join(dir, 'input.json');
  try {
    await writeFile(inputPath, JSON.stringify({ final_response: 'done', used_tools: [123] }), 'utf8');
    await assert.rejects(
      runAuditorJudgeCommand({
        argv: ['--stage', 'turn_end', '--input', inputPath, '--project', dir],
        readLocalFn: async () => [],
        createAuditorBackendFn: () => ({ judge: async () => ({ pass: true, findings: [], anomalies: [], meta: {} }) }),
      }),
      /used_tools must be an array of strings/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runAuditorMatrixCommand: evaluates the four host/backend rows with one fixture', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-auditor-matrix-'));
  const inputPath = join(dir, 'input.json');
  const out = [];
  const rows = [];
  const catalogHosts = [];
  let tick = 1000;
  try {
    await writeFile(inputPath, JSON.stringify({ user_input: 'Caveat の既知罠を確認して' }), 'utf8');
    await runAuditorMatrixCommand({
      argv: ['--stage', 'user_input', '--input', inputPath, '--project', dir],
      readLocalFn: async ({ projectRoot, hostAgent }) => {
        assert.equal(projectRoot, dir);
        catalogHosts.push(hostAgent);
        return [{ name: 'mcp__caveat__caveat_search', description: 'Search caveats.' }];
      },
      createAuditorBackendFn: ({ backend, hostAgent, catalog, projectRoot, env }) => {
        assert.equal(projectRoot, dir);
        assert.equal(catalog.length, 1);
        if (hostAgent === 'claude') {
          assert.equal(env.CLAUDE_CODE, '1');
          assert.equal(env.CODEX_SANDBOX, undefined);
        }
        if (hostAgent === 'codex') {
          assert.equal(env.CLAUDE_CODE, undefined);
          assert.equal(env.CODEX_SANDBOX, 'read-only');
          assert.equal(env.CODEX_SESSION_ID, 'spotter-matrix');
        }
        rows.push(`${hostAgent}.${backend}`);
        return {
          name: backend,
          judge: async (input) => ({
            pass: true,
            findings: [],
            anomalies: [],
            meta: {
              backend,
              stage: input.stage,
              hostAgent: input.meta.hostAgent,
              diagnostics: {
                processCount: 1,
                processCountMethod: 'stub_spawn',
                stdout: 'raw stdout',
                stderr: 'raw stderr',
              },
            },
          }),
        };
      },
      writeOutput: (text) => out.push(text),
      now: () => tick++,
    });
    const parsed = JSON.parse(out.join(''));
    assert.deepEqual(rows, [
      'claude.codex-cli',
      'claude.codex-sidecar',
      'codex.codex-cli',
      'codex.codex-sidecar',
    ]);
    assert.deepEqual(catalogHosts, ['claude', 'claude', 'codex', 'codex']);
    assert.equal(parsed.fixture.stage, 'user_input');
    assert.equal(parsed.summary.total, 4);
    assert.equal(parsed.summary.success, 4);
    assert.equal(parsed.summary.error, 0);
    assert.equal(parsed.summary.sidecarPrimaryAuditorImplemented, true);
    assert.deepEqual(parsed.matrix.map((row) => row.id), [
      'claude.codex-cli',
      'claude.codex-sidecar',
      'codex.codex-cli',
      'codex.codex-sidecar',
    ]);
    assert.equal(parsed.matrix[0].metrics.schemaSuccess, true);
    assert.equal(parsed.matrix[0].metrics.processCount, 1);
    assert.equal(parsed.matrix[0].meta.diagnostics.stdout, undefined);
    assert.equal(parsed.matrix[0].meta.diagnostics.stderr, undefined);
    assert.equal(parsed.matrix[0].meta.diagnostics.stdoutBytes, 10);
    assert.equal(parsed.matrix[0].meta.diagnostics.stderrBytes, 10);
    assert.equal(parsed.matrix[1].status, 'success');
    assert.equal(parsed.matrix[1].meta.backend, 'codex-sidecar');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
