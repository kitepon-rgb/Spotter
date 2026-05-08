import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  codexHookDiagnostics,
  installCodexHooks,
  runCodexHookInstallCommand,
  runCodexSessionStartHook,
  runCodexStopHook,
  runCodexUserPromptSubmitHook,
  uninstallCodexHooks,
} from '../src/cli/codex-hook-cmd.mjs';
import { AuditorBackendError } from '../src/core/auditor-error.mjs';

async function makeProject() {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-codex-hook-project-'));
  await mkdir(join(dir, '.spotter'), { recursive: true });
  await writeFile(join(dir, '.spotter', 'marker.json'), '{"markerVersion":"1"}\n', 'utf8');
  return dir;
}

test('installCodexHooks: merges Spotter hooks and enables hooks feature', async () => {
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
    assert.equal(result.hooks.sessionStart, 'installed');
    assert.equal(result.hooks.stop, 'installed');
    assert.equal(hooks.hooks.SessionStart.length, 1);
    assert.ok(hooks.hooks.SessionStart[0].hooks[0].command.includes('codex-hook session-start'));
    assert.equal(hooks.hooks.SessionStart[0].hooks[0].timeoutSec, 5);
    assert.equal(hooks.hooks.SessionStart[0].hooks[0].async, true);
    assert.equal(hooks.hooks.UserPromptSubmit.length, 2);
    assert.equal(hooks.hooks.UserPromptSubmit[0].hooks[0].command, 'keep me');
    assert.ok(hooks.hooks.UserPromptSubmit[1].hooks[0].command.includes('codex-hook user-prompt-submit'));
    assert.equal(hooks.hooks.UserPromptSubmit[1].hooks[0].timeoutSec, 60);
    assert.equal(hooks.hooks.UserPromptSubmit[1].hooks[0].async, false);
    assert.match(config, /^\[features\]$/m);
    assert.match(config, /^hooks = true$/m);
    assert.match(config, /^other = true$/m);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test('installCodexHooks: adds current hooks feature even when legacy codex_hooks exists', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'spotter-codex-home-legacy-feature-'));
  try {
    await writeFile(join(codexHome, 'config.toml'), '[features]\ncodex_hooks = true\n', 'utf8');

    const result = await installCodexHooks({
      codexHome,
      nodePath: '/usr/bin/node',
      spotterBin: '/repo/bin/spotter.mjs',
    });
    const config = await readFile(join(codexHome, 'config.toml'), 'utf8');

    assert.equal(result.feature, 'enabled');
    assert.match(config, /^hooks = true$/m);
    assert.match(config, /^codex_hooks = true$/m);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test('runCodexHookInstallCommand: registers SessionStart without seeding catalog at install time', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'spotter-codex-home-install-cmd-'));
  const out = [];
  try {
    await runCodexHookInstallCommand({
      argv: ['--codex-home', codexHome],
      writeOutput: (text) => out.push(text),
    });

    const parsed = JSON.parse(out.join(''));
    assert.equal(parsed.hooks.sessionStart, 'installed');
    assert.equal(parsed.catalogSeed, undefined);
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
        SessionStart: [
          { hooks: [{ type: 'command', command: 'node /repo/bin/spotter.mjs codex-hook session-start' }] },
        ],
        Stop: [
          { hooks: [{ type: 'command', command: 'node /repo/bin/spotter.mjs codex-hook stop' }] },
        ],
      },
    }), 'utf8');

    const result = await uninstallCodexHooks({ codexHome });
    const hooks = JSON.parse(await readFile(join(codexHome, 'hooks.json'), 'utf8'));

    assert.equal(result.hooks.userPromptSubmit, 'not-installed');
    assert.equal(result.hooks.sessionStart, 'not-installed');
    assert.equal(result.hooks.stop, 'not-installed');
    assert.deepEqual(hooks.hooks.SessionStart, []);
    assert.equal(hooks.hooks.UserPromptSubmit.length, 1);
    assert.equal(hooks.hooks.UserPromptSubmit[0].hooks[0].command, 'keep me');
    assert.deepEqual(hooks.hooks.Stop, []);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test('runCodexSessionStartHook: spawns Codex host refresh for installed Spotter projects', async () => {
  const project = await makeProject();
  const seen = [];
  try {
    await runCodexSessionStartHook({
      readInput: async () => ({
        cwd: project,
        hook_event_name: 'SessionStart',
        session_id: 'sess-codex-start',
      }),
      spawnRefreshDetachedFn: (args) => seen.push(args),
      recordHookEventFn: async ({ projectRoot, event }) => {
        assert.equal(projectRoot, project);
        assert.equal(event.hook, 'SessionStart');
        assert.equal(event.status, 'refresh_spawned');
      },
    });
    assert.deepEqual(seen, [{ projectRoot: project, hostAgent: 'codex' }]);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runCodexSessionStartHook: exits outside installed Spotter project', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-codex-start-outside-'));
  try {
    await runCodexSessionStartHook({
      readInput: async () => ({ cwd: dir, hook_event_name: 'SessionStart' }),
      spawnRefreshDetachedFn: () => {
        throw new Error('should not refresh outside marker project');
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runCodexSessionStartHook: child Codex backend env exits before reading stdin', async () => {
  const old = process.env.SPOTTER_PARENT_PID;
  process.env.SPOTTER_PARENT_PID = 'codex-cli:test';
  try {
    await runCodexSessionStartHook({
      readInput: async () => {
        throw new Error('should not read stdin for Spotter child calls');
      },
      spawnRefreshDetachedFn: () => {
        throw new Error('should not refresh for Spotter child calls');
      },
    });
  } finally {
    if (old === undefined) delete process.env.SPOTTER_PARENT_PID;
    else process.env.SPOTTER_PARENT_PID = old;
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
      readLocalFn: async ({ projectRoot, hostAgent }) => {
        assert.equal(projectRoot, project);
        assert.equal(hostAgent, 'codex');
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

test('runCodexUserPromptSubmitHook: backend error is surfaced as Codex context, not hook process failure', async () => {
  const project = await makeProject();
  const out = [];
  try {
    await runCodexUserPromptSubmitHook({
      readInput: async () => ({
        cwd: project,
        prompt: 'GeForce 5000 番台について既知の罠を調べて',
      }),
      readLocalFn: async ({ hostAgent }) => {
        assert.equal(hostAgent, 'codex');
        return [{ name: 'mcp__caveat__caveat_search', description: 'Search known traps.' }];
      },
      createAuditorBackendFn: () => ({
        judge: async () => {
          throw new AuditorBackendError('E_CODEX_CLI_EXIT', 'codex-cli exited with code 1', {
            backend: 'codex-cli',
            diagnostics: { stderr: "You've hit your usage limit." },
          });
        },
      }),
      writeOutput: (text) => out.push(text),
    });

    const parsed = JSON.parse(out.join(''));
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(parsed.hookSpecificOutput.additionalContext, /E_CODEX_CLI_EXIT/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /No fallback auditor was used/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /usage limit/);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runCodexUserPromptSubmitHook: Codex hook auditor timeout defaults short and accepts env override', async () => {
  const project = await makeProject();
  const old = process.env.SPOTTER_CODEX_HOOK_AUDITOR_TIMEOUT_MS;
  const seen = [];
  try {
    delete process.env.SPOTTER_CODEX_HOOK_AUDITOR_TIMEOUT_MS;
    await runCodexUserPromptSubmitHook({
      readInput: async () => ({
        cwd: project,
        prompt: 'GeForce 5000 番台について既知の罠を調べて',
      }),
      readLocalFn: async () => [{ name: 'mcp__caveat__caveat_search', description: 'Search known traps.' }],
      createAuditorBackendFn: ({ timeoutMs }) => {
        seen.push(timeoutMs);
        return { judge: async () => ({ pass: true, findings: [], anomalies: [], meta: { backend: 'codex-cli' } }) };
      },
    });

    process.env.SPOTTER_CODEX_HOOK_AUDITOR_TIMEOUT_MS = '1234';
    await runCodexUserPromptSubmitHook({
      readInput: async () => ({
        cwd: project,
        prompt: 'GeForce 5000 番台について既知の罠を調べて',
      }),
      readLocalFn: async () => [{ name: 'mcp__caveat__caveat_search', description: 'Search known traps.' }],
      createAuditorBackendFn: ({ timeoutMs }) => {
        seen.push(timeoutMs);
        return { judge: async () => ({ pass: true, findings: [], anomalies: [], meta: { backend: 'codex-cli' } }) };
      },
    });

    assert.deepEqual(seen, [20_000, 1234]);
  } finally {
    if (old === undefined) delete process.env.SPOTTER_CODEX_HOOK_AUDITOR_TIMEOUT_MS;
    else process.env.SPOTTER_CODEX_HOOK_AUDITOR_TIMEOUT_MS = old;
    await rm(project, { recursive: true, force: true });
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

test('runCodexStopHook: queues turn_end miss for next UserPromptSubmit context', async () => {
  const project = await makeProject();
  const stopOut = [];
  const userOut = [];
  const longFinalResponse = 'GPU について断定しました。'.repeat(20);
  try {
    await runCodexStopHook({
      readInput: async () => ({
        cwd: project,
        hook_event_name: 'Stop',
        session_id: 'sess-spotter-stop',
        transcript_path: '/tmp/transcript.jsonl',
        last_assistant_message: longFinalResponse,
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
              reason: `${input.stage}:${input.finalResponse.length}:${input.usedTools.length}`,
            }],
            anomalies: [],
            meta: { backend: 'codex-cli' },
          }),
        };
      },
      writeOutput: (text) => stopOut.push(text),
    });

    assert.deepEqual(stopOut, []);

    await runCodexUserPromptSubmitHook({
      readInput: async () => ({
        cwd: project,
        hook_event_name: 'UserPromptSubmit',
        session_id: 'sess-spotter-stop',
        prompt: 'ok',
      }),
      createAuditorBackendFn: () => {
        throw new Error('short prompt with pending context should not invoke backend');
      },
      writeOutput: (text) => userOut.push(text),
    });

    const parsed = JSON.parse(userOut.join(''));
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(parsed.hookSpecificOutput.additionalContext, /Spotter からの指摘/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /mcp__caveat__caveat_search/);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runCodexStopHook: backend error is queued for next UserPromptSubmit context', async () => {
  const project = await makeProject();
  const stopOut = [];
  const stopErr = [];
  const userOut = [];
  const longFinalResponse = 'GPU について断定しました。'.repeat(20);
  try {
    await runCodexStopHook({
      readInput: async () => ({
        cwd: project,
        session_id: 'sess-spotter-stop-error',
        transcript_path: '/tmp/transcript.jsonl',
        last_assistant_message: longFinalResponse,
      }),
      readLocalFn: async () => [{ name: 'mcp__caveat__caveat_search', description: 'Search known traps.' }],
      readCodexUsedToolsFn: async () => [],
      createAuditorBackendFn: () => ({
        judge: async () => {
          throw new AuditorBackendError('E_CODEX_CLI_TIMEOUT', 'codex-cli did not respond', {
            backend: 'codex-cli',
          });
        },
      }),
      writeOutput: (text) => stopOut.push(text),
      writeError: (text) => stopErr.push(text),
    });

    assert.deepEqual(stopOut, []);
    assert.match(stopErr.join(''), /E_CODEX_CLI_TIMEOUT/);
    assert.match(stopErr.join(''), /No fallback auditor was used/);

    await runCodexUserPromptSubmitHook({
      readInput: async () => ({
        cwd: project,
        session_id: 'sess-spotter-stop-error',
        prompt: 'ok',
      }),
      createAuditorBackendFn: () => {
        throw new Error('short prompt with pending context should not invoke backend');
      },
      writeOutput: (text) => userOut.push(text),
    });

    const parsed = JSON.parse(userOut.join(''));
    assert.match(parsed.hookSpecificOutput.additionalContext, /E_CODEX_CLI_TIMEOUT/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /No fallback auditor was used/);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runCodexStopHook: skips short final responses with no used tools', async () => {
  const project = await makeProject();
  const out = [];
  try {
    await runCodexStopHook({
      readInput: async () => ({
        cwd: project,
        session_id: 'sess-spotter-short-stop',
        transcript_path: '/tmp/transcript.jsonl',
        last_assistant_message: '短い回答です。',
      }),
      readCodexUsedToolsFn: async () => [],
      readLocalFn: async () => {
        throw new Error('short final response should not load catalog');
      },
      createAuditorBackendFn: () => {
        throw new Error('short final response should not invoke backend');
      },
      writeOutput: (text) => out.push(text),
    });

    assert.deepEqual(out, []);
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
      spawnSyncFn: () => ({ status: 0, stdout: 'hooks stable true\n', stderr: '' }),
    });

    assert.equal(result.availability, 'available');
    assert.equal(result.codexHooksFeature, 'enabled');
    assert.equal(result.evidence, 'hooks stable true');
    assert.equal(result.installedHooks.sessionStart, 'installed');
    assert.equal(result.installedHooks.userPromptSubmit, 'installed');
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test('codexHookDiagnostics: accepts legacy codex_hooks feature output', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'spotter-codex-home-diagnostics-legacy-'));
  try {
    await installCodexHooks({ codexHome, nodePath: '/usr/bin/node', spotterBin: '/repo/bin/spotter.mjs' });
    const result = await codexHookDiagnostics({
      codexHome,
      spawnSyncFn: () => ({ status: 0, stdout: 'codex_hooks stable true\n', stderr: '' }),
    });

    assert.equal(result.availability, 'available');
    assert.equal(result.codexHooksFeature, 'enabled');
    assert.equal(result.evidence, 'codex_hooks stable true');
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
