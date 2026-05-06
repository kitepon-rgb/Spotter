import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAuditorJudgeCommand } from '../src/cli/auditor-cmd.mjs';

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
      readLocalFn: async ({ projectRoot }) => {
        assert.equal(projectRoot, dir);
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
