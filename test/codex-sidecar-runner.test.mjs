import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readFindingsJson,
  runCodexReadOnlyWorkflow,
  runCodexRiskCheck,
  runCodexWork,
} from '../src/core/codex-sidecar-runner.mjs';

const finding = {
  id: 'spotter.user_input.1',
  stage: 'user_input',
  toolName: 'mcp__caveat__caveat_search',
  reason: '既知の罠を確認する必要がある',
  category: 'tool_miss',
  severity: 'unknown',
  confidence: 'unknown',
  references: [],
  source: 'haiku',
};

const cleanGitStatus = async () => ({ stdout: '', stderr: '' });

test('runCodexRiskCheck: invokes codex-sidecar risk-check with context-file and saves structured record', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-codex-risk-'));
  const calls = [];
  try {
    const record = await runCodexRiskCheck({
      projectRoot: project,
      hostAgent: 'claude',
      findings: [finding],
      dryRun: true,
      now: () => new Date('2026-05-06T01:02:03.004Z'),
      execFileFn: async (cmd, args, opts) => {
        calls.push({ cmd, args, opts });
        assert.equal(opts.cwd, project);
        assert.equal(opts.env.SPOTTER_SIDECAR, '1');
        assert.ok(opts.env.SPOTTER_PARENT_PID);
        if (args[0] === 'diagnostics') {
          return {
            stdout: JSON.stringify({ status: 'ok', normalizedRequest: { workflow: 'review' } }),
            stderr: '',
          };
        }
        assert.equal(args[0], 'risk-check');
        assert.ok(args.includes('--dry-run'));
        const contextPath = args[args.indexOf('--context-file') + 1];
        const context = JSON.parse(await readFile(contextPath, 'utf8'));
        assert.equal(context.context.length, 1);
        assert.equal(context.context[0].source, 'spotter');
        assert.equal(context.context[0].data.findingKind, 'spotter.tool_miss');
        return {
          stdout: JSON.stringify({
            status: 'dry-run',
            workflow: 'risk-check',
            normalizedRequest: { workflow: 'risk-check', context: context.context },
          }),
          stderr: '',
        };
      },
    });

    assert.equal(calls.length, 2);
    assert.equal(record.status, 'success');
    assert.equal(record.workflow, 'codex_risk_check');
    assert.equal(record.result.status, 'dry-run');
    assert.equal(record.meta.sidecarWorkflow, 'risk-check');
    assert.match(record.meta.resultPath, /2026-05-06T01-02-03-004Z-codex-risk-check\.json$/);
    const saved = JSON.parse(await readFile(record.meta.resultPath, 'utf8'));
    assert.equal(saved.workflow, 'codex_risk_check');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runCodexRiskCheck: prompt includes exact risk schema hints', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-codex-risk-schema-hint-'));
  try {
    const record = await runCodexRiskCheck({
      projectRoot: project,
      hostAgent: 'claude',
      findings: [finding],
      dryRun: true,
      save: false,
      execFileFn: async (_cmd, args) => {
        if (args[0] === 'diagnostics') {
          return { stdout: JSON.stringify({ status: 'ok' }), stderr: '' };
        }
        const prompt = args.at(-1);
        assert.match(prompt, /affectedFiles as Array<\{path:string,line\?:number,label\?:string\}>/);
        assert.match(prompt, /confidence as \{level:"high"\|"medium"\|"low"\|"unknown"/);
        assert.match(prompt, /basis as "observed", "inferred", or "hypothetical"/);
        return {
          stdout: JSON.stringify({
            status: 'dry-run',
            workflow: 'risk-check',
            normalizedRequest: { workflow: 'risk-check' },
          }),
          stderr: '',
        };
      },
    });
    assert.equal(record.status, 'success');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runCodexRiskCheck: unavailable sidecar returns explicit skipped record, not hidden fallback', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-codex-risk-unavailable-'));
  try {
    const record = await runCodexRiskCheck({
      projectRoot: project,
      hostAgent: 'claude',
      findings: [finding],
      save: false,
      execFileFn: async (_cmd, args) => {
        assert.equal(args[0], 'diagnostics');
        const err = new Error('codex-sidecar missing');
        err.code = 'ENOENT';
        throw err;
      },
    });

    assert.equal(record.status, 'skipped');
    assert.equal(record.error.code, 'codex_sidecar_unavailable');
    assert.equal(record.meta.availability.state, 'unavailable');
    assert.equal(record.meta.decision.mode, 'compatibility');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runCodexRiskCheck: Codex host still invokes sidecar when explicit structured second pass is requested', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-codex-risk-codex-host-'));
  try {
    let riskCalls = 0;
    const record = await runCodexRiskCheck({
      projectRoot: project,
      hostAgent: 'codex',
      findings: [finding],
      save: false,
      execFileFn: async (_cmd, args) => {
        if (args[0] === 'diagnostics') {
          return { stdout: JSON.stringify({ status: 'ok' }), stderr: '' };
        }
        riskCalls += 1;
        return { stdout: JSON.stringify({ status: 'ok', workflow: 'risk-check', summary: 'ok' }), stderr: '' };
      },
    });

    assert.equal(riskCalls, 1);
    assert.equal(record.status, 'success');
    assert.equal(record.meta.decision.reason, 'codex_host_with_explicit_boundary');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runCodexRiskCheck: local built sidecar CLI path is used for diagnostics and invocation', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-codex-risk-local-cli-'));
  const localCli = '/repo/codex-sidecar/packages/cli/dist/index.js';
  try {
    const seen = [];
    const record = await runCodexRiskCheck({
      projectRoot: project,
      hostAgent: 'codex',
      findings: [finding],
      save: false,
      env: { PATH: '/bin', SPOTTER_CODEX_SIDECAR_CLI_PATH: localCli },
      execFileFn: async (cmd, args) => {
        seen.push({ cmd, args });
        assert.equal(cmd, process.execPath);
        assert.equal(args[0], localCli);
        if (args[1] === 'diagnostics') {
          return { stdout: JSON.stringify({ status: 'ok' }), stderr: '' };
        }
        assert.equal(args[1], 'risk-check');
        return { stdout: JSON.stringify({ status: 'ok', workflow: 'risk-check', summary: 'ok' }), stderr: '' };
      },
    });

    assert.equal(seen.length, 2);
    assert.equal(record.status, 'success');
    assert.equal(record.meta.sidecarCommand[0], 'codex-sidecar');
    assert.equal(record.meta.decision.reason, 'codex_host_with_explicit_boundary');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runCodexReadOnlyWorkflow: maps review/explore/opinion to matching codex-sidecar workflows', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-codex-readonly-'));
  try {
    const seen = [];
    for (const workflow of ['codex_review', 'codex_explore', 'codex_opinion']) {
      const record = await runCodexReadOnlyWorkflow({
        workflow,
        projectRoot: project,
        hostAgent: 'claude',
        findings: [finding],
        dryRun: true,
        save: false,
        execFileFn: async (_cmd, args) => {
          if (args[0] === 'diagnostics') {
            return { stdout: JSON.stringify({ status: 'ok' }), stderr: '' };
          }
          seen.push(args[0]);
          return { stdout: JSON.stringify({ status: 'dry-run', workflow: args[0] }), stderr: '' };
        },
      });
      assert.equal(record.status, 'success');
      assert.equal(record.workflow, workflow);
    }
    assert.deepEqual(seen, ['review', 'explore', 'opinion']);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runCodexReadOnlyWorkflow: rejects unsupported workflows', async () => {
  await assert.rejects(
    runCodexReadOnlyWorkflow({
      workflow: 'codex_unknown',
      projectRoot: '/repo',
      findings: [],
    }),
    /unsupported workflow/
  );
});

test('readFindingsJson: accepts array, {findings}, and {judgment:{findings}}', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-findings-json-'));
  try {
    const arrayPath = join(dir, 'array.json');
    const objectPath = join(dir, 'object.json');
    const judgmentPath = join(dir, 'judgment.json');
    await writeFile(arrayPath, JSON.stringify([finding]), 'utf8');
    await writeFile(objectPath, JSON.stringify({ findings: [finding] }), 'utf8');
    await writeFile(judgmentPath, JSON.stringify({ judgment: { findings: [finding] } }), 'utf8');

    assert.equal((await readFindingsJson(arrayPath)).length, 1);
    assert.equal((await readFindingsJson(objectPath)).length, 1);
    assert.equal((await readFindingsJson(judgmentPath)).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runCodexWork: requires explicit approval, scope, cleanup, and instruction', async () => {
  await assert.rejects(
    runCodexWork({
      projectRoot: '/repo',
      findings: [],
      instruction: 'change docs',
      approved: false,
      allowedPaths: ['docs/'],
      cleanup: 'remove',
    }),
    /explicit approval/
  );
  await assert.rejects(
    runCodexWork({
      projectRoot: '/repo',
      findings: [],
      instruction: 'change docs',
      approved: true,
      allowedPaths: [],
      cleanup: 'remove',
    }),
    /at least one allowed path/
  );
  await assert.rejects(
    runCodexWork({
      projectRoot: '/repo',
      findings: [],
      instruction: 'change docs',
      approved: true,
      allowedPaths: ['docs/'],
      cleanup: null,
    }),
    /cleanup must be/
  );
});

test('runCodexWork: invokes codex-sidecar work with scoped config and validates changed files', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-codex-work-'));
  const calls = [];
  try {
    await writeFile(join(project, '.codex-sidecar.yml'), [
      'project: spotter',
      'defaults:',
      '  readonly: true',
      '  result_format: json',
      'allowed_paths:',
      '  - src/',
      '  - docs/',
      'deny_paths:',
      '  - .spotter/',
      'presets:',
      '  work:',
      '    workflow: work',
      '    readonly: false',
      '    require_worktree: true',
      '    allowed_paths:',
      '      - docs/',
      '',
    ].join('\n'), 'utf8');
    const record = await runCodexWork({
      projectRoot: project,
      hostAgent: 'claude',
      findings: [finding],
      instruction: 'Update a focused docs note.',
      approved: true,
      allowedPaths: ['src/'],
      cleanup: 'remove',
      save: false,
      gitStatusFn: cleanGitStatus,
      execFileFn: async (cmd, args) => {
        calls.push({ cmd, args });
        if (args[0] === 'diagnostics') {
          assert.equal(args[args.indexOf('--preset') + 1], 'work');
          return {
            stdout: JSON.stringify({
              status: 'ok',
              normalizedRequest: {
                workflow: 'work',
                readonly: false,
                requireWorktree: true,
                allowedPaths: ['src/', 'docs/'],
              },
            }),
            stderr: '',
          };
        }
        assert.equal(args[0], 'work');
        assert.ok(args.includes('--remove-worktree'));
        const configPath = join(project, args[args.indexOf('--config') + 1]);
        const configText = await readFile(configPath, 'utf8');
        assert.match(configText, /allowed_paths:\n  - "src\/"/);
        assert.doesNotMatch(configText, /  - docs\//);
        const contextPath = args[args.indexOf('--context-file') + 1];
        const context = JSON.parse(await readFile(contextPath, 'utf8'));
        assert.equal(context.context.at(-1).data.schemaVersion, 'spotter.codex_work_approval.v1');
        return {
          stdout: JSON.stringify({
            status: 'ok',
            workflow: 'work',
            changedFiles: ['src/core/example.mjs'],
            tests: ['npm test'],
            diagnostics: { worktree: true },
            worktreePath: '/tmp/spotter-worktree',
            worktreePreserved: false,
          }),
          stderr: '',
        };
      },
    });

    assert.equal(calls.length, 2);
    assert.equal(record.status, 'success');
    assert.equal(record.workflow, 'codex_work');
    assert.deepEqual(record.result.changedFiles, ['src/core/example.mjs']);
    assert.equal(record.meta.availability.state, 'work-capable');
    assert.deepEqual(record.meta.workApproval.allowedPaths, ['src/']);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runCodexWork: unavailable work capability returns explicit skipped record', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-codex-work-unavailable-'));
  try {
    const record = await runCodexWork({
      projectRoot: project,
      hostAgent: 'claude',
      findings: [finding],
      instruction: 'Update docs.',
      approved: true,
      allowedPaths: ['docs/'],
      cleanup: 'preserve',
      save: false,
      gitStatusFn: cleanGitStatus,
      execFileFn: async (_cmd, args) => {
        assert.equal(args[0], 'diagnostics');
        return { stdout: JSON.stringify({ status: 'failed', reason: 'no work preset' }), stderr: '' };
      },
    });

    assert.equal(record.status, 'skipped');
    assert.equal(record.error.code, 'codex_sidecar_unavailable');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runCodexWork: changed files outside approved scope become structured error', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-codex-work-scope-'));
  try {
    await writeFile(join(project, '.codex-sidecar.yml'), [
      'project: spotter',
      'allowed_paths:',
      '  - src/',
      'presets:',
      '  work:',
      '    workflow: work',
      '    readonly: false',
      '    require_worktree: true',
      '',
    ].join('\n'), 'utf8');
    const record = await runCodexWork({
      projectRoot: project,
      hostAgent: 'claude',
      findings: [finding],
      instruction: 'Update implementation.',
      approved: true,
      allowedPaths: ['src/'],
      cleanup: 'preserve',
      save: false,
      gitStatusFn: cleanGitStatus,
      execFileFn: async (_cmd, args) => {
        if (args[0] === 'diagnostics') {
          return {
            stdout: JSON.stringify({
              status: 'ok',
              normalizedRequest: {
                workflow: 'work',
                readonly: false,
                requireWorktree: true,
                allowedPaths: ['src/'],
              },
            }),
            stderr: '',
          };
        }
        return {
          stdout: JSON.stringify({
            status: 'ok',
            workflow: 'work',
            changedFiles: ['README.md'],
          }),
          stderr: '',
        };
      },
    });

    assert.equal(record.status, 'error');
    assert.equal(record.error.code, 'codex_work_changed_files_outside_approved_scope');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runCodexWork: dirty approved scope stops before sidecar invocation', async () => {
  const project = await mkdtemp(join(tmpdir(), 'spotter-codex-work-dirty-'));
  try {
    let sidecarCalls = 0;
    const record = await runCodexWork({
      projectRoot: project,
      hostAgent: 'claude',
      findings: [finding],
      instruction: 'Update docs.',
      approved: true,
      allowedPaths: ['docs/'],
      cleanup: 'preserve',
      save: false,
      gitStatusFn: async () => ({ stdout: '?? docs/SPOTTER_CODEX_DUAL_SUPPORT_TODO.md\n', stderr: '' }),
      execFileFn: async () => {
        sidecarCalls += 1;
        return { stdout: JSON.stringify({ status: 'ok' }), stderr: '' };
      },
    });

    assert.equal(sidecarCalls, 0);
    assert.equal(record.status, 'error');
    assert.equal(record.error.code, 'codex_work_dirty_approved_scope');
    assert.equal(record.meta.dirtyScope.entries[0].path, 'docs/SPOTTER_CODEX_DUAL_SUPPORT_TODO.md');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
