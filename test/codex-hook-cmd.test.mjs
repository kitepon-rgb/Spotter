import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  codexHookDiagnostics,
  installCodexHooks,
  resolveCodexHookNodePath,
  runCodexHookInstallCommand,
  runCodexSessionStartHook,
  runCodexStopHook,
  runCodexUserPromptSubmitHook,
  uninstallCodexHooks,
} from '../src/cli/codex-hook-cmd.mjs';
import { AuditorBackendError } from '../src/core/auditor-error.mjs';
import { CodexAuditorModelPolicyError } from '../src/core/codex-auditor-model-policy.mjs';

async function makeProject() {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-codex-hook-project-'));
  await mkdir(join(dir, '.spotter'), { recursive: true });
  await writeFile(join(dir, '.spotter', 'marker.json'), '{"markerVersion":"1"}\n', 'utf8');
  return dir;
}

const THROUGHLINE_CONFIG = { mode: 'throughline', command: '/opt/throughline/bin/throughline', args: [] };
const FRESH_CONTEXT = Object.freeze({
  schema: 'throughline.auditor_context.v1', status: 'fresh', reason: 'fresh',
  turns: Object.freeze([{ originSessionId: 'prior', turnNumber: 1, user: '前の依頼', assistant: '前の回答', createdAt: 1 }]),
  stats: Object.freeze({ requestedTurns: 2, returnedTurns: 1, chars: 8, truncated: false }),
});
const freshContextDeps = {
  readAuditorContextConfigFn: async () => THROUGHLINE_CONFIG,
  loadAuditorContextFn: async () => FRESH_CONTEXT,
};

test('installCodexHooks: fresh install generates only canonical Codex hook fields', async () => {
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
    assert.deepEqual(hooks.hooks.SessionStart[0].hooks[0], {
      type: 'command',
      command: '"/usr/bin/node" "/repo/bin/spotter.mjs" codex-hook session-start',
      timeout: 5,
    });
    assert.equal(hooks.hooks.UserPromptSubmit.length, 2);
    assert.equal(hooks.hooks.UserPromptSubmit[0].hooks[0].command, 'keep me');
    assert.deepEqual(hooks.hooks.UserPromptSubmit[1].hooks[0], {
      type: 'command',
      command: '"/usr/bin/node" "/repo/bin/spotter.mjs" codex-hook user-prompt-submit',
      timeout: 60,
    });
    assert.deepEqual(hooks.hooks.Stop[0].hooks[0], {
      type: 'command',
      command: '"/usr/bin/node" "/repo/bin/spotter.mjs" codex-hook stop',
      timeout: 60,
    });
    assert.match(config, /^\[features\]$/m);
    assert.match(config, /^hooks = true$/m);
    assert.match(config, /^other = true$/m);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test('installCodexHooks: reinstall normalizes installer-owned Spotter handlers, removes duplicates, and is byte-idempotent', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'spotter-codex-home-upgrade-'));
  try {
    await writeFile(join(codexHome, 'hooks.json'), JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{
          type: 'command',
          command: 'node /old/spotter.mjs codex-hook session-start',
          timeoutSec: 5,
          async: true,
          statusMessage: '利用者が追加した表示もinstaller所有entryでは残さない',
          unknownField: 'remove with other legacy fields',
        }] }, { hooks: [{
          type: 'command',
          command: 'node /older/spotter.mjs codex-hook session-start',
          timeoutSec: 99,
          async: false,
          statusMessage: null,
        }] }],
        UserPromptSubmit: [{ hooks: [{
          type: 'command',
          command: 'node /old/spotter.mjs codex-hook user-prompt-submit',
          timeoutSec: 60,
          async: false,
          statusMessage: null,
        }] }, { hooks: [{
          type: 'command',
          command: 'node /older/spotter.mjs codex-hook user-prompt-submit',
          timeoutSec: 99,
          async: true,
          statusMessage: null,
        }] }],
        Stop: [{ hooks: [{
          type: 'command',
          command: 'node /old/spotter.mjs codex-hook stop',
          timeoutSec: 60,
          async: false,
          statusMessage: null,
        }] }, { hooks: [{
          type: 'command',
          command: 'node /older/spotter.mjs codex-hook stop',
          timeoutSec: 99,
          async: true,
          statusMessage: null,
        }] }],
      },
    }), 'utf8');

    await installCodexHooks({ codexHome, nodePath: '/usr/bin/node', spotterBin: '/repo/bin/spotter.mjs' });
    const hooks = JSON.parse(await readFile(join(codexHome, 'hooks.json'), 'utf8'));

    for (const [event, subcommand, timeout] of [
      ['SessionStart', 'session-start', 5],
      ['UserPromptSubmit', 'user-prompt-submit', 60],
      ['Stop', 'stop', 60],
    ]) {
      const spotterHooks = hooks.hooks[event].flatMap((group) => group.hooks)
        .filter((hook) => hook.command.includes(`codex-hook ${subcommand}`));
      assert.deepEqual(spotterHooks, [{
        type: 'command',
        command: `"/usr/bin/node" "/repo/bin/spotter.mjs" codex-hook ${subcommand}`,
        timeout,
      }]);
      assert.equal(hooks.hooks[event].length, 1, `${event} duplicate-only group is removed`);
    }
    const firstInstallBytes = await readFile(join(codexHome, 'hooks.json'), 'utf8');
    const second = await installCodexHooks({ codexHome, nodePath: '/usr/bin/node', spotterBin: '/repo/bin/spotter.mjs' });
    assert.equal(second.hooksChanged, false);
    assert.equal(await readFile(join(codexHome, 'hooks.json'), 'utf8'), firstInstallBytes);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test('installCodexHooks: preserves mixed-group metadata and non-Spotter handlers while removing emptied duplicate groups', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'spotter-codex-home-mixed-'));
  const beforeEmptyGroup = { matcher: 'pre-existing-empty', hooks: [] };
  const firstOther = { type: 'command', command: 'throughline start', timeout: 17, unknownHookField: ['keep'] };
  const secondOther = { type: 'prompt', prompt: 'keep this hook', statusMessage: null };
  try {
    await writeFile(join(codexHome, 'hooks.json'), JSON.stringify({
      hooks: {
        SessionStart: [
          beforeEmptyGroup,
          {
            matcher: 'startup',
            unknownGroupField: { keep: true },
            hooks: [
              firstOther,
              { type: 'command', command: 'node /old/spotter.mjs codex-hook session-start', timeoutSec: 5, statusMessage: 'remove', unknown: true },
              secondOther,
              { type: 'command', command: 'node /older/spotter.mjs codex-hook session-start', timeoutSec: 99, async: false },
            ],
          },
          { matcher: 'duplicate-only', hooks: [{ type: 'command', command: 'node /third/spotter.mjs codex-hook session-start' }] },
        ],
      },
    }), 'utf8');

    await installCodexHooks({ codexHome, nodePath: '/usr/bin/node', spotterBin: '/repo/bin/spotter.mjs' });
    const hooks = JSON.parse(await readFile(join(codexHome, 'hooks.json'), 'utf8'));

    assert.deepEqual(hooks.hooks.SessionStart, [
      beforeEmptyGroup,
      {
        matcher: 'startup',
        unknownGroupField: { keep: true },
        hooks: [
          firstOther,
          { type: 'command', command: '"/usr/bin/node" "/repo/bin/spotter.mjs" codex-hook session-start', timeout: 5 },
          secondOther,
        ],
      },
    ]);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test('installCodexHooks: does not clean up a known Spotter subcommand placed under a different event', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'spotter-codex-home-misplaced-'));
  const misplacedStop = { type: 'command', command: 'node /old/spotter.mjs codex-hook stop', timeoutSec: 60 };
  try {
    await writeFile(join(codexHome, 'hooks.json'), JSON.stringify({
      hooks: { SessionStart: [{ matcher: 'misplaced', hooks: [misplacedStop] }] },
    }), 'utf8');

    await installCodexHooks({ codexHome, nodePath: '/usr/bin/node', spotterBin: '/repo/bin/spotter.mjs' });
    const hooks = JSON.parse(await readFile(join(codexHome, 'hooks.json'), 'utf8'));

    assert.deepEqual(hooks.hooks.SessionStart[0], { matcher: 'misplaced', hooks: [misplacedStop] });
    assert.deepEqual(hooks.hooks.SessionStart[1].hooks[0], {
      type: 'command',
      command: '"/usr/bin/node" "/repo/bin/spotter.mjs" codex-hook session-start',
      timeout: 5,
    });
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test('installCodexHooks: retains near-miss commands instead of claiming installer ownership', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'spotter-codex-home-near-miss-'));
  const nearMisses = [
    { type: 'command', command: 'node /repo/bin/notspotter.mjs codex-hook stop' },
    { type: 'command', command: 'renode.exe /repo/bin/spotter.mjs codex-hook stop' },
    { type: 'command', command: 'echo "node /repo/bin/spotter.mjs codex-hook stop"' },
  ];
  try {
    await writeFile(join(codexHome, 'hooks.json'), JSON.stringify({
      hooks: { Stop: [{ matcher: 'near-miss', hooks: nearMisses }] },
    }), 'utf8');

    await installCodexHooks({ codexHome, nodePath: '/usr/bin/node', spotterBin: '/repo/bin/spotter.mjs' });
    const hooks = JSON.parse(await readFile(join(codexHome, 'hooks.json'), 'utf8'));

    assert.deepEqual(hooks.hooks.Stop[0], { matcher: 'near-miss', hooks: nearMisses });
    assert.deepEqual(hooks.hooks.Stop[1].hooks[0], {
      type: 'command',
      command: '"/usr/bin/node" "/repo/bin/spotter.mjs" codex-hook stop',
      timeout: 60,
    });
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test('installCodexHooks and uninstallCodexHooks: recognize quoted Windows node.cmd and escaped path separators', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'spotter-codex-home-windows-node-cmd-'));
  const nodePath = String.raw`C:\Program Files\nodejs\node.cmd`;
  const spotterBin = String.raw`C:\Program Files\claude-spotter\bin\spotter.mjs`;
  const legacyCommand = `"${nodePath}" "${spotterBin}" codex-hook stop`;
  try {
    await writeFile(join(codexHome, 'hooks.json'), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: legacyCommand, timeoutSec: 60, async: false }] }] },
    }), 'utf8');

    await installCodexHooks({ codexHome, nodePath, spotterBin });
    let hooks = JSON.parse(await readFile(join(codexHome, 'hooks.json'), 'utf8'));
    assert.deepEqual(hooks.hooks.Stop, [{ hooks: [{
      type: 'command',
      command: String.raw`"C:\\Program Files\\nodejs\\node.cmd" "C:\\Program Files\\claude-spotter\\bin\\spotter.mjs" codex-hook stop`,
      timeout: 60,
    }] }]);

    const result = await uninstallCodexHooks({ codexHome });
    hooks = JSON.parse(await readFile(join(codexHome, 'hooks.json'), 'utf8'));
    assert.equal(result.hooks.stop, 'not-installed');
    assert.deepEqual(hooks.hooks.Stop, []);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test('installCodexHooks: preserves non-Spotter hook groups exactly', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'spotter-codex-home-preserve-'));
  const otherGroups = [{
    matcher: 'startup',
    unknownGroupField: { keep: true },
    hooks: [{ type: 'command', command: 'throughline start', timeout: 17, async: false, unknownHookField: ['keep'] }],
  }, {
    hooks: [{ type: 'prompt', prompt: 'keep this hook', statusMessage: null }],
  }];
  try {
    await writeFile(join(codexHome, 'hooks.json'), JSON.stringify({
      hooks: { SessionStart: otherGroups },
      unrelatedTopLevel: { keep: 'value' },
    }), 'utf8');

    await installCodexHooks({ codexHome, nodePath: '/usr/bin/node', spotterBin: '/repo/bin/spotter.mjs' });
    const hooks = JSON.parse(await readFile(join(codexHome, 'hooks.json'), 'utf8'));

    assert.deepEqual(hooks.hooks.SessionStart.slice(0, 2), otherGroups);
    assert.deepEqual(hooks.unrelatedTopLevel, { keep: 'value' });
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

test('installCodexHooks: default node path prefers stable Homebrew symlink', async () => {
  const stableNode = join('/opt/homebrew/bin', process.platform === 'win32' ? 'node.exe' : 'node');
  const cellarNode = join('/opt/homebrew/Cellar/node/26.0.0/bin', process.platform === 'win32' ? 'node.exe' : 'node');
  const result = resolveCodexHookNodePath({
    env: { PATH: '/opt/homebrew/bin' },
    execPath: cellarNode,
    exists: (path) => path === stableNode,
    realpath: (path) => {
      if (path === stableNode || path === cellarNode) {
        return '/opt/homebrew/Cellar/node/26.0.0/bin/node';
      }
      throw new Error(`unexpected path: ${path}`);
    },
  });
  assert.equal(result, stableNode);
});

test('installCodexHooks: re-run rewrites old Cellar Node hook command', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'spotter-codex-home-node-rewrite-'));
  try {
    await writeFile(join(codexHome, 'hooks.json'), JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: 'command',
                command: '/opt/homebrew/Cellar/node/26.0.0/bin/node /opt/homebrew/lib/node_modules/claude-spotter/bin/spotter.mjs codex-hook user-prompt-submit',
                timeoutSec: 60,
                async: false,
                statusMessage: null,
              },
            ],
          },
          { hooks: [{ type: 'command', command: 'node caveat.js codex-hook user-prompt-submit' }] },
        ],
      },
    }), 'utf8');

    await installCodexHooks({
      codexHome,
      nodePath: '/opt/homebrew/bin/node',
      spotterBin: '/opt/homebrew/lib/node_modules/claude-spotter/bin/spotter.mjs',
    });
    const hooks = JSON.parse(await readFile(join(codexHome, 'hooks.json'), 'utf8'));

    assert.equal(
      hooks.hooks.UserPromptSubmit[0].hooks[0].command,
      '"/opt/homebrew/bin/node" "/opt/homebrew/lib/node_modules/claude-spotter/bin/spotter.mjs" codex-hook user-prompt-submit',
    );
    assert.equal(
      hooks.hooks.UserPromptSubmit[1].hooks[0].command,
      'node caveat.js codex-hook user-prompt-submit',
    );
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

test('uninstallCodexHooks: removes canonical and misplaced known Spotter handlers while preserving negative ownership cases', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'spotter-codex-home-uninstall-'));
  const negativeOwnershipHooks = [
    { type: 'command', command: 'node /repo/bin/spotter.mjs codex-hook stop-extra' },
    { type: 'command', command: 'node /repo/bin/spotter.mjs codex-hook stop && notify' },
    { type: 'command', command: 'node /repo/bin/other-tool.mjs codex-hook stop' },
    { type: 'command', command: 'node /repo/bin/notspotter.mjs codex-hook stop' },
    { type: 'command', command: 'echo "node /repo/bin/spotter.mjs codex-hook stop"' },
  ];
  try {
    await writeFile(join(codexHome, 'hooks.json'), JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: 'keep me' }] },
          { hooks: [{ type: 'command', command: 'node /repo/bin/spotter.mjs codex-hook user-prompt-submit' }] },
        ],
        SessionStart: [
          { hooks: [{ type: 'command', command: 'node /repo/bin/spotter.mjs codex-hook session-start' }] },
          // Install only normalizes matching event/subcommand pairs; uninstall removes known Spotter commands from every managed event.
          { matcher: 'misplaced', hooks: [{ type: 'command', command: 'node /repo/bin/spotter.mjs codex-hook stop' }] },
        ],
        Stop: [
          { hooks: [{ type: 'command', command: 'node /repo/bin/spotter.mjs codex-hook stop' }] },
          { matcher: 'negative-ownership', hooks: negativeOwnershipHooks },
          { matcher: 'pre-existing-empty', hooks: [] },
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
    assert.deepEqual(hooks.hooks.Stop, [
      { matcher: 'negative-ownership', hooks: negativeOwnershipHooks },
      { matcher: 'pre-existing-empty', hooks: [] },
    ]);
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
  let judgeInput;
  try {
    await runCodexUserPromptSubmitHook({
      readInput: async () => ({
        cwd: project,
        hook_event_name: 'UserPromptSubmit',
        session_id: 'codex-session-1',
        transcript_path: '/tmp/codex-session-1.jsonl',
        prompt: 'GeForce 5000 番台について既知の罠を調べて',
      }),
      ...freshContextDeps,
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
          judge: async (input) => {
            judgeInput = input;
            return ({
            pass: false,
            findings: [{
              toolName: 'mcp__caveat__caveat_search',
              reason: `stage=${input.stage}`,
            }],
            anomalies: [],
            meta: { backend: 'codex-cli' },
            });
          },
        };
      },
      writeOutput: (text) => out.push(text),
    });

    const parsed = JSON.parse(out.join(''));
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(parsed.hookSpecificOutput.additionalContext, /mcp__caveat__caveat_search/);
    assert.deepEqual(judgeInput, {
      stage: 'user_input', userInput: 'GeForce 5000 番台について既知の罠を調べて',
      recentContext: FRESH_CONTEXT.turns, contextStatus: 'fresh',
    });
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

test('runCodexUserPromptSubmitHook: backend error uses fixed systemMessage and never reflects provider text', async () => {
  const project = await makeProject();
  const out = [];
  const errOut = [];
  try {
    await runCodexUserPromptSubmitHook({
      readInput: async () => ({
        cwd: project,
        session_id: 'codex-backend-error',
        transcript_path: '/tmp/codex-backend-error.jsonl',
        prompt: 'GeForce 5000 番台について既知の罠を調べて',
      }),
      ...freshContextDeps,
      readLocalFn: async ({ hostAgent }) => {
        assert.equal(hostAgent, 'codex');
        return [{ name: 'mcp__caveat__caveat_search', description: 'Search known traps.' }];
      },
      createAuditorBackendFn: () => ({
        judge: async () => {
          throw new AuditorBackendError('E_CODEX_CLI_USAGE_LIMIT', 'codex-cli usage limit reached — wait for reset', {
            backend: 'codex-cli',
            diagnostics: { stderr: "You've hit your usage limit." },
          });
        },
      }),
      writeOutput: (text) => out.push(text),
      writeError: (text) => errOut.push(text),
    });

    const parsed = JSON.parse(out.join(''));
    assert.match(parsed.systemMessage, /利用上限/);
    assert.match(errOut.join(''), /利用上限/);
    assert.doesNotMatch(out.join('') + errOut.join(''), /usage limit reached|You've hit your usage limit/);
    assert.equal(parsed.hookSpecificOutput, undefined);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runCodexUserPromptSubmitHook: model policy creation error maps to fixed generic diagnostics', async () => {
  const project = await makeProject();
    const out = [];
  const errOut = [];
  const events = [];
  try {
    await runCodexUserPromptSubmitHook({
      readInput: async () => ({
        cwd: project,
        session_id: 'codex-model-error',
        transcript_path: '/tmp/codex-model-error.jsonl',
        prompt: 'GeForce 5000 番台について既知の罠を調べて',
      }),
      ...freshContextDeps,
      readLocalFn: async () => [],
      createAuditorBackendFn: () => {
        throw new CodexAuditorModelPolicyError('SPOTTER_CODEX_CLI_MODEL is invalid');
      },
      recordHookEventFn: async ({ event }) => { events.push(event); },
      writeOutput: (text) => out.push(text),
      writeError: (text) => errOut.push(text),
    });

    const parsed = JSON.parse(out.join(''));
    assert.match(parsed.systemMessage, /一時的な問題/);
    assert.doesNotMatch(out.join('') + errOut.join(''), /SPOTTER_CODEX_CLI_MODEL is invalid|E_CODEX_CLI_MODEL_POLICY/);
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'error');
    assert.equal(events[0].backend, 'codex-cli');
    assert.equal(events[0].code, 'E_SPOTTER_AUDIT_GENERIC');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runCodexUserPromptSubmitHook: catalog read failure cannot escape or reflect its message', async () => {
  const project = await makeProject();
  const out = [];
  const errOut = [];
  const events = [];
  try {
    await runCodexUserPromptSubmitHook({
      readInput: async () => ({ cwd: project, session_id: 'codex-catalog-error', transcript_path: '/tmp/codex-catalog-error.jsonl', prompt: '十分に長いユーザー入力' }),
      ...freshContextDeps,
      readLocalFn: async () => { throw new Error('AI_SENTINEL:catalog-secret'); },
      recordHookEventFn: async ({ event }) => { events.push(event); },
      writeOutput: (text) => out.push(text),
      writeError: (text) => errOut.push(text),
    });
    assert.match(JSON.parse(out.join('')).systemMessage, /一時的な問題/);
    assert.doesNotMatch(out.join('') + errOut.join('') + JSON.stringify(events), /AI_SENTINEL|catalog-secret/);
    assert.equal(events[0].code, 'E_SPOTTER_AUDIT_GENERIC');
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
        session_id: 'codex-timeout-default',
        transcript_path: '/tmp/codex-timeout-default.jsonl',
        prompt: 'GeForce 5000 番台について既知の罠を調べて',
      }),
      ...freshContextDeps,
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
        session_id: 'codex-timeout-override',
        transcript_path: '/tmp/codex-timeout-override.jsonl',
        prompt: 'GeForce 5000 番台について既知の罠を調べて',
      }),
      ...freshContextDeps,
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

test('runCodexUserPromptSubmitHook: disabled and non-fresh context quietly skip without creating a backend', async () => {
  const project = await makeProject();
  try {
    for (const [config, contextStatus] of [
      [{ mode: 'disabled' }, 'disabled'],
      [THROUGHLINE_CONFIG, 'stale'],
    ]) {
      const out = []; const events = [];
      await runCodexUserPromptSubmitHook({
        readInput: async () => ({ cwd: project, session_id: `codex-${contextStatus}`, transcript_path: `/tmp/${contextStatus}.jsonl`, prompt: '短文' }),
        readAuditorContextConfigFn: async () => config,
        loadAuditorContextFn: async () => ({ ...FRESH_CONTEXT, status: contextStatus, turns: [], stats: { requestedTurns: 2, returnedTurns: 0, chars: 0, truncated: false } }),
        createAuditorBackendFn: () => { throw new Error('backend must not be created'); },
        recordHookEventFn: async ({ event }) => { events.push(event); },
        writeOutput: (text) => out.push(text),
      });
      assert.deepEqual(out, []);
      assert.equal(events[0].status, 'skipped');
      assert.equal(events[0].contextStatus, contextStatus);
    }
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runCodexStopHook: records a finding without delivering it to the next prompt', async () => {
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
      readCodexToolUsageFn: async (transcriptPath) => {
        assert.equal(transcriptPath, '/tmp/transcript.jsonl');
        return { usedTools: [], anomalies: [], stats: {} };
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

    assert.match(JSON.parse(stopOut.join('')).systemMessage, /確認候補を記録/);

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

    assert.deepEqual(userOut, []);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runCodexStopHook: backend error is fixed diagnostics and is not delivered to the next prompt', async () => {
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
      readCodexToolUsageFn: async () => ({ usedTools: [], anomalies: [], stats: {} }),
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

    assert.match(JSON.parse(stopOut.join('')).systemMessage, /時間内に完了しなかった/);
    assert.match(stopErr.join(''), /時間内に完了しなかった/);
    assert.doesNotMatch(stopOut.join('') + stopErr.join(''), /codex-cli did not respond|E_CODEX_CLI_TIMEOUT/);

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

    assert.deepEqual(userOut, []);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runCodexStopHook: transcript observation failure is fixed and non-blocking', async () => {
  const project = await makeProject();
  const out = [];
  const errOut = [];
  const events = [];
  try {
    await runCodexStopHook({
      readInput: async () => ({
        cwd: project,
        transcript_path: '/tmp/transcript.jsonl',
        last_assistant_message: '十分に長い応答'.repeat(20),
      }),
      readCodexToolUsageFn: async () => { throw new Error('AI_SENTINEL:transcript-secret'); },
      recordHookEventFn: async ({ event }) => { events.push(event); },
      writeOutput: (text) => out.push(text),
      writeError: (text) => errOut.push(text),
    });
    assert.match(JSON.parse(out.join('')).systemMessage, /一時的な問題/);
    assert.equal(events[0].reason, 'tool_usage_observation');
    assert.doesNotMatch(out.join('') + errOut.join('') + JSON.stringify(events), /AI_SENTINEL|transcript-secret/);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runCodexStopHook: catalog read failure is fixed and non-blocking', async () => {
  const project = await makeProject();
  const out = [];
  const errOut = [];
  const events = [];
  try {
    await runCodexStopHook({
      readInput: async () => ({
        cwd: project,
        transcript_path: '/tmp/transcript.jsonl',
        last_assistant_message: '十分に長い応答'.repeat(20),
      }),
      readCodexToolUsageFn: async () => ({ usedTools: [], anomalies: [], stats: {} }),
      readLocalFn: async () => { throw new Error('AI_SENTINEL:catalog-secret'); },
      recordHookEventFn: async ({ event }) => { events.push(event); },
      writeOutput: (text) => out.push(text),
      writeError: (text) => errOut.push(text),
    });
    assert.match(JSON.parse(out.join('')).systemMessage, /一時的な問題/);
    assert.equal(events[0].code, 'E_SPOTTER_AUDIT_GENERIC');
    assert.doesNotMatch(out.join('') + errOut.join('') + JSON.stringify(events), /AI_SENTINEL|catalog-secret/);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runCodexStopHook: model policy creation error is fixed generic diagnostics without next-turn delivery', async () => {
  const project = await makeProject();
  const stopOut = [];
  const stopErr = [];
  const userOut = [];
  const events = [];
  try {
    await runCodexStopHook({
      readInput: async () => ({
        cwd: project,
        session_id: 'sess-model-policy-error',
        transcript_path: '/tmp/transcript.jsonl',
        last_assistant_message: 'GPU について断定しました。'.repeat(20),
      }),
      readLocalFn: async () => [],
      readCodexToolUsageFn: async () => ({ usedTools: [], anomalies: [], stats: {} }),
      createAuditorBackendFn: () => {
        throw new CodexAuditorModelPolicyError('SPOTTER_CODEX_CLI_REASONING_EFFORT is invalid');
      },
      recordHookEventFn: async ({ event }) => { events.push(event); },
      writeOutput: (text) => stopOut.push(text),
      writeError: (text) => stopErr.push(text),
    });

    assert.match(JSON.parse(stopOut.join('')).systemMessage, /一時的な問題/);
    assert.doesNotMatch(stopOut.join('') + stopErr.join(''), /SPOTTER_CODEX_CLI_REASONING_EFFORT|E_CODEX_CLI_MODEL_POLICY/);
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'error');
    assert.equal(events[0].code, 'E_SPOTTER_AUDIT_GENERIC');

    await runCodexUserPromptSubmitHook({
      readInput: async () => ({
        cwd: project,
        session_id: 'sess-model-policy-error',
        prompt: 'ok',
      }),
      createAuditorBackendFn: () => { throw new Error('short prompt must not create a backend'); },
      writeOutput: (text) => userOut.push(text),
    });
    assert.deepEqual(userOut, []);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runCodexStopHook: obsolete pending writer injection is ignored and failure stays fixed', async () => {
  const project = await makeProject();
  try {
    for (const appendPendingContextFn of [
      async () => false,
      async () => { throw new Error('disk unavailable'); },
    ]) {
      const errors = [];
      const events = [];
      await runCodexStopHook({
        readInput: async () => ({
          cwd: project,
          session_id: 'sess-codex-warning-persist-failure',
          transcript_path: '/tmp/transcript.jsonl',
          last_assistant_message: 'GPU について断定しました。'.repeat(20),
        }),
        readLocalFn: async () => [],
        readCodexToolUsageFn: async () => ({ usedTools: [], anomalies: [], stats: {} }),
        createAuditorBackendFn: () => {
          throw new CodexAuditorModelPolicyError('invalid model policy');
        },
        appendPendingContextFn,
        recordHookEventFn: async ({ event }) => { events.push(event); },
        writeError: (text) => errors.push(text),
      });

      assert.match(errors.join(''), /一時的な問題/);
      assert.doesNotMatch(errors.join(''), /invalid model policy|E_CODEX_CLI_MODEL_POLICY/);
      assert.equal(events.length, 1);
      assert.equal(events[0].status, 'error');
      assert.equal(events[0].code, 'E_SPOTTER_AUDIT_GENERIC');
    }
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runCodexStopHook: obsolete pending writer cannot affect structured finding', async () => {
  const project = await makeProject();
  const errors = [];
  const events = [];
  try {
    await runCodexStopHook({
      readInput: async () => ({
        cwd: project,
        session_id: 'sess-codex-finding-persist-failure',
        transcript_path: '/tmp/transcript.jsonl',
        last_assistant_message: 'GPU について断定しました。'.repeat(20),
      }),
      readLocalFn: async () => [],
      readCodexToolUsageFn: async () => ({ usedTools: [], anomalies: [], stats: {} }),
      createAuditorBackendFn: () => ({
        name: 'codex-cli',
        judge: async () => ({
          pass: false,
          findings: [{ toolName: 'mcp__caveat__caveat_search', reason: 'search first' }],
          anomalies: [],
          meta: { backend: 'codex-cli' },
        }),
      }),
      appendPendingContextFn: async () => { throw new Error('read-only filesystem'); },
      recordHookEventFn: async ({ event }) => { events.push(event); },
      writeError: (text) => errors.push(text),
    });

    assert.equal(errors.join(''), '');
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'finding');
    assert.deepEqual(events[0].missingTools, ['mcp__caveat__caveat_search']);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runCodexStopHook: stderr writer failure cannot reject a persistence failure', async () => {
  const project = await makeProject();
  try {
    await runCodexStopHook({
      readInput: async () => ({
        cwd: project,
        session_id: 'sess-codex-stderr-failure',
        transcript_path: '/tmp/transcript.jsonl',
        last_assistant_message: 'GPU について断定しました。'.repeat(20),
      }),
      readLocalFn: async () => [],
      readCodexToolUsageFn: async () => ({ usedTools: [], anomalies: [], stats: {} }),
      createAuditorBackendFn: () => { throw new CodexAuditorModelPolicyError('bad policy'); },
      appendPendingContextFn: async () => false,
      recordHookEventFn: async () => { throw new Error('event log unavailable'); },
      writeError: () => { throw new Error('stderr unavailable'); },
    });
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runCodexStopHook: skips short final responses with no used tools', async () => {
  const project = await makeProject();
  const out = [];
  const events = [];
  try {
    await runCodexStopHook({
      readInput: async () => ({
        cwd: project,
        session_id: 'sess-spotter-short-stop',
        transcript_path: '/tmp/transcript.jsonl',
        last_assistant_message: '短い回答です。',
      }),
      readCodexToolUsageFn: async () => ({ usedTools: [], anomalies: [], stats: {} }),
      readLocalFn: async () => {
        throw new Error('short final response should not load catalog');
      },
      createAuditorBackendFn: () => {
        throw new Error('short final response should not invoke backend');
      },
      recordHookEventFn: async ({ event }) => { events.push(event); },
      writeOutput: (text) => out.push(text),
    });

    assert.deepEqual(out, []);
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'skipped');
    assert.equal(events[0].reason, 'short_final_no_tools');
    assert.equal(events[0].toolUsageAnomalyCount, 0);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runCodexStopHook: current custom_tool_call prevents a false short-final skip', async () => {
  const project = await makeProject();
  const transcript = join(project, '.spotter', 'current-rollout.jsonl');
  const events = [];
  let auditedInput = null;
  try {
    await writeFile(transcript, JSON.stringify({
      type: 'response_item',
      payload: { type: 'custom_tool_call', name: 'exec', call_id: 'exec-1', arguments: 'private command' },
    }) + '\n', 'utf8');
    await runCodexStopHook({
      readInput: async () => ({
        cwd: project,
        session_id: 'sess-spotter-current-tool',
        transcript_path: transcript,
        last_assistant_message: '短い回答です。',
      }),
      readLocalFn: async () => [],
      createAuditorBackendFn: () => ({
        name: 'codex-cli',
        judge: async (input) => {
          auditedInput = input;
          return { pass: true, findings: [], anomalies: [], meta: { backend: 'codex-cli' } };
        },
      }),
      recordHookEventFn: async ({ event }) => { events.push(event); },
    });

    assert.deepEqual(auditedInput.usedTools, ['exec']);
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'success');
    assert.equal(events[0].usedToolCount, 1);
    assert.equal(events[0].toolUsageAnomalyCount, 0);
    assert.equal(events[0].toolUsageStats.recognized, 1);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runCodexStopHook: prior-turn tool and anomaly do not disable the current short-final skip', async () => {
  const project = await makeProject();
  const transcript = join(project, '.spotter', 'multi-turn-rollout.jsonl');
  const events = [];
  try {
    await writeFile(transcript, [
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'previous' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'old-call' } }),
      'malformed previous-turn line',
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'current' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', content: 'current short answer' } }),
    ].join('\n'), 'utf8');
    await runCodexStopHook({
      readInput: async () => ({
        cwd: project,
        session_id: 'sess-spotter-current-clean',
        transcript_path: transcript,
        last_assistant_message: '短い回答です。',
      }),
      readLocalFn: async () => { throw new Error('prior-turn tool must not force a current audit'); },
      createAuditorBackendFn: () => { throw new Error('prior-turn anomaly must not force a current audit'); },
      recordHookEventFn: async ({ event }) => { events.push(event); },
    });

    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'skipped');
    assert.equal(events[0].usedToolCount, 0);
    assert.equal(events[0].toolUsageAnomalyCount, 0);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runCodexStopHook: transcript anomaly prevents skip and records only safe diagnostics', async () => {
  const project = await makeProject();
  const transcript = join(project, '.spotter', 'future-rollout.jsonl');
  const events = [];
  let auditCalls = 0;
  try {
    await writeFile(transcript, [
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'future_tool_call', name: 'future', arguments: 'secret prompt body' },
      }),
      'malformed line with private body',
    ].join('\n'), 'utf8');
    await runCodexStopHook({
      readInput: async () => ({
        cwd: project,
        session_id: 'sess-spotter-future-tool',
        transcript_path: transcript,
        last_assistant_message: '短い回答です。',
      }),
      readLocalFn: async () => [],
      createAuditorBackendFn: () => ({
        name: 'codex-cli',
        judge: async (input) => {
          auditCalls += 1;
          assert.deepEqual(input.usedTools, []);
          return { pass: true, findings: [], anomalies: [], meta: { backend: 'codex-cli' } };
        },
      }),
      recordHookEventFn: async ({ event }) => { events.push(event); },
    });

    assert.equal(auditCalls, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'success');
    assert.equal(events[0].toolUsageAnomalyCount, 2);
    assert.deepEqual(events[0].toolUsageAnomalies, [
      { code: 'E_CODEX_TOOL_CALL_TYPE_UNKNOWN', line: 1 },
      { code: 'E_CODEX_TRANSCRIPT_JSON_PARSE', line: 2 },
    ]);
    assert.doesNotMatch(JSON.stringify(events[0]), /secret prompt body|private body/);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('runCodexStopHook: missing transcript is observation failure and never a no-tools skip', async () => {
  const project = await makeProject();
  const events = [];
  let auditCalls = 0;
  try {
    await runCodexStopHook({
      readInput: async () => ({
        cwd: project,
        session_id: 'sess-spotter-missing-transcript',
        transcript_path: join(project, '.spotter', 'missing-rollout.jsonl'),
        last_assistant_message: '短い回答です。',
      }),
      readLocalFn: async () => [],
      createAuditorBackendFn: () => ({
        name: 'codex-cli',
        judge: async () => {
          auditCalls += 1;
          return { pass: true, findings: [], anomalies: [], meta: { backend: 'codex-cli' } };
        },
      }),
      recordHookEventFn: async ({ event }) => { events.push(event); },
    });

    assert.equal(auditCalls, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'success');
    assert.equal(events[0].toolUsageScope, 'unavailable');
    assert.deepEqual(events[0].toolUsageAnomalies, [{ code: 'E_CODEX_TRANSCRIPT_NOT_FOUND' }]);
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
    assert.equal(result.readiness, 'configured-unverified');
    assert.equal(result.auditorBackend, 'codex-cli');
    assert.equal(result.auditorModelSelection.effectiveModel, 'gpt-5.6-terra');
    assert.equal(result.auditorModelSelection.effectiveReasoningEffort, 'medium');
    assert.equal(result.auditorModelSelection.modelSource, 'policy:production');
    assert.equal(result.auditorModelSelection.availability, 'unverified-until-invocation');
    for (const event of ['sessionStart', 'userPromptSubmit', 'stop']) {
      assert.equal(result.validation[event].expectedRegisteredCount, 1);
      assert.equal(result.validation[event].registered, true);
      assert.equal(result.validation[event].compatible, true);
      assert.equal(result.validation[event].misconfigured, false);
      assert.equal(result.validation[event].canonical, true);
      assert.deepEqual(result.validation[event].issues, []);
    }
    assert.equal(result.trust.state, 'unknown');
    assert.match(result.trust.action, /\/hooks/);
    assert.match(result.trust.action, /not machine-verifiable/);
    assert.equal(result.runtime, null);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test('codexHookDiagnostics: reports effective overrides without probing model availability', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'spotter-codex-home-diagnostics-model-'));
  let spawnCalls = 0;
  try {
    const result = await codexHookDiagnostics({
      codexHome,
      env: {
        SPOTTER_CODEX_CLI_MODEL: 'gpt-5.6-terra',
        SPOTTER_CODEX_CLI_REASONING_EFFORT: 'medium',
      },
      spawnSyncFn: () => {
        spawnCalls += 1;
        return { status: 0, stdout: 'hooks stable true\n', stderr: '' };
      },
    });

    assert.equal(spawnCalls, 1, 'only the hooks feature query may spawn');
    assert.equal(result.auditorModelSelection.effectiveModel, 'gpt-5.6-terra');
    assert.equal(result.auditorModelSelection.effectiveReasoningEffort, 'medium');
    assert.equal(result.auditorModelSelection.effectiveStatus, 'override-unverified');
    assert.equal(result.auditorModelSelection.availability, 'unverified-until-invocation');
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test('codexHookDiagnostics: invalid model policy fails before querying Codex', async () => {
  let spawnCalls = 0;
  await assert.rejects(
    codexHookDiagnostics({
      env: { SPOTTER_CODEX_CLI_MODEL: ' gpt-5.6-luna' },
      spawnSyncFn: () => {
        spawnCalls += 1;
        return { status: 0, stdout: 'hooks stable true\n', stderr: '' };
      },
    }),
    { code: 'E_CODEX_CLI_MODEL_POLICY' },
  );
  assert.equal(spawnCalls, 0);
});

test('codexHookDiagnostics: non-Codex active backend does not report or validate a dormant Codex model', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'spotter-codex-home-diagnostics-haiku-'));
  let spawnCalls = 0;
  try {
    const result = await codexHookDiagnostics({
      codexHome,
      env: {
        SPOTTER_AUDITOR_BACKEND: 'haiku',
        SPOTTER_CODEX_CLI_MODEL: ' invalid dormant override',
      },
      spawnSyncFn: () => {
        spawnCalls += 1;
        return { status: 0, stdout: 'hooks stable true\n', stderr: '' };
      },
    });

    assert.equal(spawnCalls, 1);
    assert.equal(result.auditorBackend, 'haiku');
    assert.equal(result.auditorModelSelection, null);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test('codexHookDiagnostics: auto on a Codex host resolves to codex-cli before model selection', async () => {
  const result = await codexHookDiagnostics({
    env: { SPOTTER_AUDITOR_BACKEND: 'auto' },
    spawnSyncFn: () => ({ status: 0, stdout: 'hooks stable true\n', stderr: '' }),
  });
  assert.equal(result.auditorBackend, 'codex-cli');
  assert.equal(result.auditorModelSelection.effectiveModel, 'gpt-5.6-terra');
});

test('codexHookDiagnostics: legacy async SessionStart remains availability available but readiness misconfigured', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'spotter-codex-home-diagnostics-legacy-async-'));
  try {
    await writeFile(join(codexHome, 'hooks.json'), JSON.stringify({ hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'node /repo/spotter.mjs codex-hook session-start', timeoutSec: 5, async: true }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node /repo/spotter.mjs codex-hook user-prompt-submit', timeout: 60 }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'node /repo/spotter.mjs codex-hook stop', timeout: 60 }] }],
    } }), 'utf8');
    const result = await codexHookDiagnostics({ codexHome, spawnSyncFn: () => ({ status: 0, stdout: 'hooks stable true\n', stderr: '' }) });
    assert.equal(result.availability, 'available');
    assert.equal(result.readiness, 'misconfigured');
    assert.ok(result.validation.sessionStart.issues.includes('async:true'));
    assert.ok(result.validation.sessionStart.issues.includes('timeoutSec'));
  } finally { await rm(codexHome, { recursive: true, force: true }); }
});

test('codexHookDiagnostics: compatibility matrix distinguishes missing, structural errors, and harmless noncanonical fields', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'spotter-codex-home-diagnostics-matrix-'));
  const base = () => ({ hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'node /repo/spotter.mjs codex-hook session-start', timeout: 5 }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node /repo/spotter.mjs codex-hook user-prompt-submit', timeout: 60 }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'node /repo/spotter.mjs codex-hook stop', timeout: 60 }] }],
  } });
  try {
    const cases = [
      {
        name: 'fresh canonical', mutate: (value) => value, readiness: 'configured-unverified',
        event: 'sessionStart', count: 1, compatible: true, canonical: true, issues: [],
      },
      {
        name: 'pure missing', mutate: (value) => { value.hooks.Stop = []; return value; }, readiness: 'not-installed',
        event: 'stop', count: 0, compatible: false, canonical: false, issues: ['missing'],
      },
      {
        name: 'duplicate', mutate: (value) => { value.hooks.Stop.push(structuredClone(value.hooks.Stop[0])); return value; }, readiness: 'misconfigured',
        event: 'stop', count: 2, compatible: false, canonical: false, issues: ['duplicate'],
      },
      {
        name: 'wrong event', mutate: (value) => { value.hooks.SessionStart[0].hooks[0].command = 'node /repo/spotter.mjs codex-hook stop'; return value; }, readiness: 'misconfigured',
        event: 'sessionStart', count: 0, compatible: false, canonical: false, issues: ['missing', 'wrong-event-subcommand'],
      },
      {
        name: 'type mismatch', mutate: (value) => { value.hooks.SessionStart[0].hooks[0].type = 'prompt'; return value; }, readiness: 'misconfigured',
        event: 'sessionStart', count: 1, compatible: false, canonical: false, issues: ['type!=command'],
      },
      {
        name: 'timeout missing uses the official default', mutate: (value) => { delete value.hooks.Stop[0].hooks[0].timeout; return value; }, readiness: 'configured-unverified',
        event: 'stop', count: 1, compatible: true, canonical: false, issues: ['timeout:missing'],
      },
      {
        name: 'timeout string', mutate: (value) => { value.hooks.Stop[0].hooks[0].timeout = '60'; return value; }, readiness: 'misconfigured',
        event: 'stop', count: 1, compatible: false, canonical: false, issues: ['timeout-invalid'],
      },
      {
        name: 'timeout zero', mutate: (value) => { value.hooks.Stop[0].hooks[0].timeout = 0; return value; }, readiness: 'misconfigured',
        event: 'stop', count: 1, compatible: false, canonical: false, issues: ['timeout-invalid'],
      },
      {
        name: 'timeoutSec only', mutate: (value) => { delete value.hooks.Stop[0].hooks[0].timeout; value.hooks.Stop[0].hooks[0].timeoutSec = 60; return value; }, readiness: 'misconfigured',
        event: 'stop', count: 1, compatible: false, canonical: false, issues: ['timeout:missing', 'timeoutSec'],
      },
      {
        name: 'async true', mutate: (value) => { value.hooks.SessionStart[0].hooks[0].async = true; return value; }, readiness: 'misconfigured',
        event: 'sessionStart', count: 1, compatible: false, canonical: false, issues: ['async:true'],
      },
      {
        name: 'harmless known noncanonical fields', mutate: (value) => { value.hooks.SessionStart[0].hooks[0].async = false; value.hooks.SessionStart[0].hooks[0].statusMessage = null; return value; }, readiness: 'configured-unverified',
        event: 'sessionStart', count: 1, compatible: true, canonical: false, issues: ['async:false', 'statusMessage:null'],
      },
      {
        name: 'official optional fields with a valid Windows override', mutate: (value) => { value.hooks.Stop[0].hooks[0].statusMessage = 'visible'; value.hooks.Stop[0].hooks[0].commandWindows = String.raw`node.exe C:\repo\spotter.mjs codex-hook stop`; return value; }, readiness: 'configured-unverified',
        event: 'stop', count: 1, compatible: true, canonical: true, issues: [],
      },
      {
        name: 'invalid Windows override', mutate: (value) => { value.hooks.Stop[0].hooks[0].commandWindows = 'cmd'; return value; }, readiness: 'misconfigured',
        event: 'stop', count: 1, compatible: false, canonical: false, issues: ['commandWindows-invalid'],
      },
      {
        name: 'wrong-event Windows override', mutate: (value) => { value.hooks.Stop[0].hooks[0].commandWindows = String.raw`node.exe C:\repo\spotter.mjs codex-hook session-start`; return value; }, readiness: 'misconfigured',
        event: 'stop', count: 1, compatible: false, canonical: false, issues: ['commandWindows-invalid'],
      },
      {
        name: 'non-string Windows override', mutate: (value) => { value.hooks.Stop[0].hooks[0].commandWindows = 42; return value; }, readiness: 'misconfigured',
        event: 'stop', count: 1, compatible: false, canonical: false, issues: ['commandWindows-invalid'],
      },
      {
        name: 'other product handler', mutate: (value) => { value.hooks.Stop[0].hooks.push({ type: 'command', command: 'node caveat.js codex-hook stop', timeout: 1 }); return value; }, readiness: 'configured-unverified',
        event: 'stop', count: 1, compatible: true, canonical: true, issues: [],
      },
    ];
    for (const entry of cases) {
      await writeFile(join(codexHome, 'hooks.json'), JSON.stringify(entry.mutate(base())), 'utf8');
      const result = await codexHookDiagnostics({ codexHome, spawnSyncFn: () => ({ status: 0, stdout: 'hooks stable true\n', stderr: '' }) });
      const validation = result.validation[entry.event];
      assert.equal(result.readiness, entry.readiness, entry.name);
      assert.equal(validation.expectedRegisteredCount, entry.count, entry.name);
      assert.equal(validation.registered, entry.count > 0, entry.name);
      assert.equal(validation.compatible, entry.compatible, entry.name);
      assert.equal(validation.misconfigured, entry.readiness === 'misconfigured', entry.name);
      assert.equal(validation.canonical, entry.canonical, entry.name);
      assert.deepEqual(validation.issues, entry.issues, entry.name);
    }
  } finally { await rm(codexHome, { recursive: true, force: true }); }
});

test('codexHookDiagnostics: feature failure or disabled feature is unavailable without rewriting legacy availability', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'spotter-codex-home-diagnostics-feature-'));
  try {
    await installCodexHooks({ codexHome, nodePath: '/usr/bin/node', spotterBin: '/repo/bin/spotter.mjs' });
    for (const result of [
      await codexHookDiagnostics({ codexHome, spawnSyncFn: () => ({ status: 1, stdout: '', stderr: 'failed' }) }),
      await codexHookDiagnostics({ codexHome, spawnSyncFn: () => ({ status: 0, stdout: 'hooks stable false\n', stderr: '' }) }),
    ]) {
      assert.equal(result.availability, 'unavailable');
      assert.equal(result.readiness, 'unavailable');
    }
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test('codexHookDiagnostics: runtime observation is informational and never proves trust or readiness', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'spotter-codex-home-diagnostics-runtime-'));
  const project = await makeProject();
  try {
    await installCodexHooks({ codexHome, nodePath: '/usr/bin/node', spotterBin: '/repo/bin/spotter.mjs' });
    const spawnSyncFn = () => ({ status: 0, stdout: 'hooks stable true\n', stderr: '' });
    const before = await codexHookDiagnostics({ codexHome, projectRoot: project, spawnSyncFn });
    assert.equal(before.readiness, 'configured-unverified');
    assert.equal(before.runtime.observation, 'not-observed');
    assert.equal(before.trust.state, 'unknown');

    await writeFile(join(project, '.spotter', 'hook-events.jsonl'), JSON.stringify({
      schema: 'spotter.hook_event.v1',
      timestamp: '2026-07-12T00:00:00.000Z',
      host: 'codex',
      hook: 'SessionStart',
      status: 'refresh_spawned',
    }) + '\n', 'utf8');
    const after = await codexHookDiagnostics({ codexHome, projectRoot: project, spawnSyncFn });
    assert.equal(after.readiness, 'configured-unverified');
    assert.equal(after.runtime.observation, 'observed');
    assert.equal(after.runtime.byHook.SessionStart, 1);
    assert.equal(after.trust.state, 'unknown');
  } finally {
    await rm(codexHome, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
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
