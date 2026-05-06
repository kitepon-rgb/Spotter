import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildCodexSidecarAuditorCommand,
  buildCodexSidecarAuditorPrompt,
  createCodexSidecarAuditorBackend,
} from '../src/core/codex-sidecar-auditor-backend.mjs';
import { AuditorBackendError } from '../src/core/auditor-backend.mjs';

const catalog = [
  { name: 'mcp__caveat__caveat_search', description: 'Search known caveats.' },
  { name: 'current_time', description: 'Get current time.' },
];

test('buildCodexSidecarAuditorPrompt: uses sidecar auditor contract and exact catalog names', () => {
  const prompt = buildCodexSidecarAuditorPrompt({
    catalog,
    input: { stage: 'user_input', userInput: '過去の罠を確認して' },
  });
  assert.match(prompt, /primary tool-use auditor/);
  assert.match(prompt, /missingTools/);
  assert.match(prompt, /mcp__caveat__caveat_search/);
  assert.match(prompt, /follow-up tools whose need depends on a result not yet observed/);
});

test('buildCodexSidecarAuditorCommand: supports local built CLI path for smoke before global install', () => {
  const command = buildCodexSidecarAuditorCommand({
    projectRoot: '/repo',
    contextFilePath: '/tmp/auditor-context.json',
    timeoutMs: 1234,
    env: { SPOTTER_CODEX_SIDECAR_CLI_PATH: '/sidecar/dist/index.js' },
  });
  assert.equal(command.cmd, process.execPath);
  assert.deepEqual(command.args, [
    '/sidecar/dist/index.js',
    'auditor',
    '--project',
    '/repo',
    '--preset',
    'auditor',
    '--json',
    '--context-file',
    '/tmp/auditor-context.json',
    '--turn-timeout-ms',
    '1234',
    'Evaluate context[0].data.instructions as a Spotter primary auditor request. Return auditor pass and missingTools.',
  ]);
});

test('createCodexSidecarAuditorBackend: maps SidecarResult pass/missingTools to SpotterJudgment', async () => {
  let captured = null;
  const backend = createCodexSidecarAuditorBackend({
    catalog,
    projectRoot: '/repo',
    env: { PATH: '/bin' },
    execFileFn: async (cmd, args, opts) => {
      captured = { cmd, args, opts };
      const contextPath = args[args.indexOf('--context-file') + 1];
      const context = JSON.parse(await readFile(contextPath, 'utf8'));
      assert.match(context[0].data.instructions, /mcp__caveat__caveat_search/);
      return {
        stdout: JSON.stringify({
          status: 'ok',
          workflow: 'auditor',
          summary: 'Caveat should be checked.',
          confidence: { level: 'high' },
          recommendedNextAction: 'Call Caveat.',
          pass: false,
          missingTools: [
            { name: 'mcp__caveat__caveat_search', reason: 'Known trap requested.' },
            { name: 'ghost_tool', reason: 'bogus' },
          ],
        }),
        stderr: 'sidecar warning',
      };
    },
  });
  const judgment = await backend.judge({ stage: 'user_input', userInput: '罠を確認して' });

  assert.equal(captured.cmd, 'codex-sidecar');
  assert.equal(captured.opts.cwd, '/repo');
  assert.ok(captured.opts.maxBuffer > 1024 * 1024);
  assert.ok(!captured.args.join('\n').includes('mcp__caveat__caveat_search'));
  assert.equal(captured.opts.env.SPOTTER_SIDECAR, '1');
  assert.equal(captured.opts.env.SPOTTER_CHILD_BACKEND, 'codex-sidecar');
  assert.equal(judgment.pass, false);
  assert.equal(judgment.findings.length, 1);
  assert.equal(judgment.findings[0].source, 'codex-sidecar');
  assert.equal(judgment.findings[0].toolName, 'mcp__caveat__caveat_search');
  assert.equal(judgment.meta.backend, 'codex-sidecar');
  assert.equal(judgment.meta.mode, 'auditor');
  assert.deepEqual(judgment.meta.diagnostics.droppedCatalogExternalNames, ['ghost_tool']);
  assert.match(judgment.meta.diagnostics.stderr, /sidecar warning/);
});

test('createCodexSidecarAuditorBackend: sidecar failed status is a structured backend error', async () => {
  const backend = createCodexSidecarAuditorBackend({
    catalog,
    projectRoot: '/repo',
    execFileFn: async () => ({
      stdout: JSON.stringify({
        status: 'failed',
        workflow: 'auditor',
        error: { code: 'PRESET_NOT_FOUND', message: 'missing auditor preset' },
      }),
      stderr: '',
    }),
  });

  await assert.rejects(
    backend.judge({ stage: 'user_input', userInput: 'x' }),
    (err) => err instanceof AuditorBackendError && err.code === 'E_CODEX_SIDECAR_STATUS'
  );
});

test('createCodexSidecarAuditorBackend: non-JSON output is a structured backend error', async () => {
  const backend = createCodexSidecarAuditorBackend({
    catalog,
    projectRoot: '/repo',
    execFileFn: async () => ({ stdout: 'not-json', stderr: '' }),
  });

  await assert.rejects(
    backend.judge({ stage: 'user_input', userInput: 'x' }),
    (err) => err instanceof AuditorBackendError && err.code === 'E_CODEX_SIDECAR_JSON'
  );
});
