import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runCodexStopHook } from '../src/cli/codex-hook-cmd.mjs';
import { createEvaluationStore } from '../src/core/evaluation-store.mjs';
import { canonicalizeCodexSkillReadToolIds } from '../src/core/evaluation-tool-id.mjs';

async function seedSkill(root, relative, name) {
  const path = join(root, relative, 'SKILL.md');
  await mkdir(join(root, relative), { recursive: true });
  await writeFile(path, `---\nname: ${name}\ndescription: test skill\n---\n\n# ${name}\n`, 'utf8');
  return path;
}

test('Codex skill adoption recognizes only an exact proposed SKILL.md read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spotter-codex-skill-'));
  const projectRoot = join(root, 'project');
  const codexHome = join(root, 'codex-home');
  try {
    const skillPath = await seedSkill(codexHome, join('skills', 'directory-name'), 'frontmatter-name');
    const pluginPath = await seedSkill(
      codexHome,
      join('plugins', 'cache', 'market', 'browser', '1.0.0', 'skills', 'control'),
      'control-in-app-browser',
    );
    const adopted = await canonicalizeCodexSkillReadToolIds([
      { toolName: 'exec_command', toolInput: JSON.stringify({ cmd: `sed -n '1,240p' ${skillPath}` }) },
      { toolName: 'exec', toolInput: `const r = await tools.exec_command({cmd:"cat ${pluginPath}"});` },
      { toolName: 'exec_command', toolInput: JSON.stringify({ cmd: 'echo frontmatter-name' }) },
    ], {
      proposedToolIds: ['frontmatter-name', 'browser:control-in-app-browser'],
      projectRoot,
      codexHome,
    });
    assert.deepEqual(adopted.sort(), ['browser:control-in-app-browser', 'frontmatter-name']);

    assert.deepEqual(await canonicalizeCodexSkillReadToolIds([
      { toolName: 'exec_command', toolInput: JSON.stringify({ cmd: `rg SKILL.md ${skillPath}` }) },
      { toolName: 'exec_command', toolInput: JSON.stringify({ cmd: `echo "cat ${skillPath}"` }) },
      { toolName: 'exec_command', toolInput: JSON.stringify({ cmd: 'cat /tmp/skills/frontmatter-name/SKILL.md' }) },
      { toolName: 'exec_command', toolInput: JSON.stringify({ cmd: `cat ${skillPath}` }) },
    ], {
      proposedToolIds: ['some-other-skill'], projectRoot, codexHome,
    }), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Codex Stop records a proposed skill read through exec_command as adopted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spotter-codex-skill-stop-'));
  const projectRoot = join(root, 'project');
  const codexHome = join(root, 'codex-home');
  const databasePath = join(root, 'evaluation.db');
  try {
    await mkdir(join(projectRoot, '.spotter'), { recursive: true });
    await writeFile(join(projectRoot, '.spotter', 'marker.json'), '{}\n', 'utf8');
    const skillPath = await seedSkill(projectRoot, join('.codex', 'skills', 'review'), 'review');
    const store = createEvaluationStore({ databasePath });
    store.recordTurn({
      observationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      recordedAtMs: 1000,
      projectPath: projectRoot,
      host: 'codex',
      sessionId: 'skill-session',
      auditStatus: 'success',
      proposedToolIds: ['review'],
      observerContextStatus: 'not_requested',
    });
    store.close();

    await runCodexStopHook({
      readInput: async () => ({
        cwd: projectRoot,
        session_id: 'skill-session',
        transcript_path: join(root, 'rollout.jsonl'),
        last_assistant_message: '完了しました。',
      }),
      readCodexToolUsageFn: async () => ({
        scope: 'current-turn',
        usedTools: ['exec_command'],
        toolCalls: [{
          toolName: 'exec_command',
          toolInput: JSON.stringify({ cmd: `sed -n '1,240p' ${skillPath}` }),
        }],
        anomalies: [],
        stats: {},
      }),
      createEvaluationStoreFn: () => createEvaluationStore({ databasePath }),
      codexHome,
      now: () => 2000,
      recordHookEventFn: async () => {},
      readLocalFn: async () => [],
      createAuditorBackendFn: () => ({
        judge: async () => ({ pass: true, findings: [], anomalies: [], meta: { backend: 'codex-cli' } }),
      }),
    });

    const resultStore = createEvaluationStore({ databasePath });
    const recorded = resultStore.getCase('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    resultStore.close();
    assert.equal(recorded.usageStatus, 'complete');
    assert.deepEqual(recorded.usedToolIds, ['review']);
    assert.deepEqual(recorded.items, [{ toolId: 'review', outcome: 'adopted' }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
