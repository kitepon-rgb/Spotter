import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  codexHookDiagnostics,
  installCodexHooks,
  runCodexStopHook,
  runCodexUserPromptSubmitHook,
  uninstallCodexHooks,
} from '../src/cli/codex-hook-cmd.mjs';

async function makeProject() {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-codex-hook-project-'));
  await mkdir(join(dir, '.spotter'), { recursive: true });
  await writeFile(join(dir, '.spotter', 'marker.json'), '{"markerVersion":"1"}\n', 'utf8');
  return dir;
}

test('installCodexHooks: merges Spotter hooks and enables codex_hooks feature', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'spotter-codex-home-'));
  try {
    await writeFile(join(codexHome, 'hooks.json'), JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'keep me' }] }],
      },
    }), 'utf8');
    await writeFile(join(codexHome, 'config.toml'), 'model = "gpt-5.5"\n\n[features]\nother = true\n', 'utf8');

    const result = await installCodexHooks({
      codexHome,
      nodePath: '/usr/bin/node',
      spotterBin: '/repo/bin/spotter.mjs',
    });
    const hooks = JSON.parse(await readFile(join(codexHome, 'hooks.json'), 'utf8'));
    const config = await readFile(join(codexHome, 'config.toml'), 'utf8');

    assert.equal(result.hooks.userPromptSubmit, 'installed');
    assert.equal(result.hooks.stop, 'installed');
    assert.equal(hooks.hooks.UserPromptSubmit.length, 2);
    assert.equal(hooks.hooks.UserPromptSubmit[0].hooks[0].command, 'keep me');
    assert.ok(hooks.hooks.UserPromptSubmit[1].hooks[0].command.includes('codex-hook user-prompt-submit'));
    assert.equal(hooks.hooks.UserPromptSubmit[1].hooks[0].timeoutSec, 60);
    assert.equal(hooks.hooks.UserPromptSubmit[1].hooks[0].async, false);
    assert.match(config, /^\[features\]$/m);
    assert.match(config, /^codex_hooks = true$/m);
    assert.match(config, /^other = true$/m);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test('uninstallCodexHooks: removes only Spotter Codex hook entries', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'spotter-codex-home-uninstall-'));
  try {
    await writeFile(join(codexHome, 'hooks.json'), JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: 'keep me' }] },
          { hooks: [{ type: 'command', command: 'node /repo/bin/spotter.mjs codex-hook user-prompt-submit' }] },
        ],
        Stop: [
          { hooks: [{ type: 'command', command: 'node /repo/bin/spotter.mjs codex-hook stop' }] },
        ],
      },
    }), 'utf8');

    const result = await uninstallCodexHooks({ codexHome });
    const hooks = JSON.parse(await readFile(join(codexHome, 'hooks.json'), 'utf8'));

    assert.equal(result.hooks.userPromptSubmit, 'not-installed');
    assert.equal(result.hooks.stop, 'not-installed');
    assert.equal(hooks.hooks.UserPromptSubmit.length, 1);
    assert.equal(hooks.hooks.UserPromptSubmit[0].hooks[0].command, 'keep me');
    assert.deepEqual(hooks.hooks.Stop, []);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test('runCodexUserPromptSubmitHook: invokes Codex CLI auditor and emits Codex additionalContext', async () => {
  const project = await makeProject();
  const out = [];
  try {
    await runCodexUserPromptSubmitHook({
      readInput: async () => ({
        cwd: project,
        hook_event_name: 'UserPromptSubmit',
        prompt: 'GeForce 5000 番台について既知の罠を調べて',
      }),
      readLocalFn: async ({ projectRoot }) => {
        assert.equal(projectRoot, project);
        return [{ name: 'mcp__caveat__caveat_search', description: 'Search known traps.' }];
      },
      createAuditorBackendFn: ({ backend, projectRoot, hostAgent }) => {
        assert.equal(backend, 'codex-cli');
        assert.equal(projectRoot, project);
        assert.equal(hostAgent, 'codex');
        return {
          judge: async (input) => ({
            pass: false,
            findings: [{
              toolName: 'mcp__caveat__caveat_search',
              reason: `stage=${input.stage}`,
            }],
            anomalies: [],
            meta: { backend: 'codex-cli' },
          }),
        };
      },
      writeOutput: (text) => out.push(text),
    });

    const parsed = JSON.parse(out.join(''));
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(parsed.hookSpecificOutput.additionalContext, /mcp__caveat__caveat_search/);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runCodexUserPromptSubmitHook: child Codex backend env exits before reading stdin', async () => {
  const old = process.env.SPOTTER_PARENT_PID;
  process.env.SPOTTER_PARENT_PID = 'codex-cli:test';
  try {
    await runCodexUserPromptSubmitHook({
      readInput: async () => {
        throw new Error('should not read stdin for Spotter child calls');
      },
    });
  } finally {
    if (old === undefined) delete process.env.SPOTTER_PARENT_PID;
    else process.env.SPOTTER_PARENT_PID = old;
  }
});

test('runCodexUserPromptSubmitHook: exits outside installed Spotter project', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-codex-hook-outside-'));
  const out = [];
  try {
    await runCodexUserPromptSubmitHook({
      readInput: async () => ({
        cwd: dir,
        prompt: 'GeForce 5000 番台について既知の罠を調べて',
      }),
      createAuditorBackendFn: () => {
        throw new Error('should not create backend outside marker project');
      },
      writeOutput: (text) => out.push(text),
    });
    assert.deepEqual(out, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runCodexStopHook: blocks with transparent Spotter reason on turn_end miss', async () => {
  const project = await makeProject();
  const out = [];
  try {
    await runCodexStopHook({
      readInput: async () => ({
        cwd: project,
        hook_event_name: 'Stop',
        transcript_path: '/tmp/transcript.jsonl',
        last_assistant_message: 'GPU について断定しました',
      }),
      readLocalFn: async () => [{ name: 'mcp__caveat__caveat_search', description: 'Search known traps.' }],
      readCodexUsedToolsFn: async (transcriptPath) => {
        assert.equal(transcriptPath, '/tmp/transcript.jsonl');
        return [];
      },
      createAuditorBackendFn: ({ backend, hostAgent }) => {
        assert.equal(backend, 'codex-cli');
        assert.equal(hostAgent, 'codex');
        return {
          judge: async (input) => ({
            pass: false,
            findings: [{
              toolName: 'mcp__caveat__caveat_search',
              reason: `${input.stage}:${input.finalResponse}:${input.usedTools.length}`,
            }],
            anomalies: [],
            meta: { backend: 'codex-cli' },
          }),
        };
      },
      writeOutput: (text) => out.push(text),
    });

    const parsed = JSON.parse(out.join(''));
    assert.equal(parsed.decision, 'block');
    assert.match(parsed.reason, /Spotter からの指摘/);
    assert.match(parsed.reason, /mcp__caveat__caveat_search/);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('codexHookDiagnostics: reports feature and hook installation state', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'spotter-codex-home-diagnostics-'));
  try {
    await installCodexHooks({ codexHome, nodePath: '/usr/bin/node', spotterBin: '/repo/bin/spotter.mjs' });
    const result = await codexHookDiagnostics({
      codexHome,
      spawnSyncFn: () => ({ status: 0, stdout: 'codex_hooks stable true\n', stderr: '' }),
    });

    assert.equal(result.availability, 'available');
    assert.equal(result.codexHooksFeature, 'enabled');
    assert.equal(result.installedHooks.userPromptSubmit, 'installed');
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test('codexHookDiagnostics: does not count other codex-hook commands as Spotter hooks', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'spotter-codex-home-diagnostics-other-'));
  try {
    await writeFile(join(codexHome, 'hooks.json'), JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node caveat.js codex-hook user-prompt-submit' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'node caveat.js codex-hook stop' }] }],
      },
    }), 'utf8');
    const result = await codexHookDiagnostics({
      codexHome,
      spawnSyncFn: () => ({ status: 0, stdout: 'codex_hooks stable true\n', stderr: '' }),
    });

    assert.equal(result.availability, 'not-installed');
    assert.equal(result.installedHooks.userPromptSubmit, 'not-installed');
    assert.equal(result.installedHooks.stop, 'not-installed');
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});
