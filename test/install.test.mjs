// Unit tests for install's hook-merge logic.
// Uses dynamic import to access the internal helpers by re-running mergeHooks
// through a controlled scenario.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexInstallNextSteps, resolveDefaultAuditorContext, runInstall } from '../src/cli/install.mjs';
import { runUninstall } from '../src/cli/uninstall.mjs';
import { mkdtemp, readFile, writeFile, rm, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('install: Codex next steps require /hooks review, new-session smoke, and project diagnostics', () => {
  assert.deepEqual(codexInstallNextSteps('/project'), [
    'review the three Spotter hooks with Codex /hooks',
    'open a new Codex session so SessionStart runs, then use the diagnostics command below',
    'confirm configuration: spotter codex-hook diagnostics --project "/project"',
  ]);
  assert.equal(
    codexInstallNextSteps('/Project With Spaces')[2],
    'confirm configuration: spotter codex-hook diagnostics --project "/Project With Spaces"',
  );
  assert.equal(
    codexInstallNextSteps(String.raw`C:\Projects\Spotter "smoke"`)[2],
    String.raw`confirm configuration: spotter codex-hook diagnostics --project "C:\\Projects\\Spotter \"smoke\""`,
  );
});

test('install: hookやtool-dbより前にruntime state rootをprivateへ準備する', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-install-runtime-state-'));
  const calls = [];
  try {
    await runInstall({
      target: 'project', autoYes: true, cwd: dir, skipRefresh: true,
      prepareRuntimeErrorStoreDirectoryFn: async () => { calls.push('prepare'); },
    });
    assert.deepEqual(calls, ['prepare']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('install: creates hooks in fresh settings.json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-install-'));
  try {
    await runInstall({ target: 'project', autoYes: true, cwd: dir, skipRefresh: true });
    const settings = JSON.parse(await readFile(join(dir, '.claude', 'settings.json'), 'utf8'));
    assert.ok(settings.hooks);
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop', 'SessionEnd']) {
      assert.ok(settings.hooks[event], `missing hook: ${event}`);
      const group = settings.hooks[event][0];
      assert.ok(group.hooks[0].command.includes('spotter.mjs'));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('install: idempotent — re-run does not duplicate entries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-install-'));
  try {
    await runInstall({ target: 'project', autoYes: true, cwd: dir, skipRefresh: true });
    await runInstall({ target: 'project', autoYes: true, cwd: dir, skipRefresh: true });
    const settings = JSON.parse(await readFile(join(dir, '.claude', 'settings.json'), 'utf8'));
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop', 'SessionEnd']) {
      assert.equal(
        settings.hooks[event].length,
        1,
        `re-run duplicated hooks for ${event}`
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('install: re-run updates existing spotter hook timeouts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-install-timeout-'));
  try {
    await mkdir(join(dir, '.claude'), { recursive: true });
    await writeFile(
      join(dir, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node "/pkg/bin/spotter.mjs" hook user-prompt', timeout: 30 }] }],
          Stop: [{ hooks: [{ type: 'command', command: 'node "/pkg/bin/spotter.mjs" hook stop', timeout: 15 }] }],
        },
      }),
      'utf8'
    );

    await runInstall({ target: 'project', autoYes: true, cwd: dir, skipRefresh: true });
    const settings = JSON.parse(await readFile(join(dir, '.claude', 'settings.json'), 'utf8'));

    assert.equal(settings.hooks.UserPromptSubmit.length, 1, 'should not duplicate UserPromptSubmit hook');
    assert.equal(settings.hooks.Stop.length, 1, 'should not duplicate Stop hook');
    assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].timeout, 60);
    assert.equal(settings.hooks.Stop[0].hooks[0].timeout, 60);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('install: re-run rewrites existing spotter hook commands to this package path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-install-command-path-'));
  try {
    await mkdir(join(dir, '.claude'), { recursive: true });
    await writeFile(
      join(dir, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: 'node "/old/bin/spotter.mjs" hook session-start', timeout: 5 }] }],
        },
      }),
      'utf8'
    );

    await runInstall({ target: 'project', autoYes: true, cwd: dir, skipRefresh: true });
    const settings = JSON.parse(await readFile(join(dir, '.claude', 'settings.json'), 'utf8'));
    const hook = settings.hooks.SessionStart[0].hooks[0];

    assert.match(hook.command, /[/\\]bin[/\\]spotter\.mjs/);
    assert.ok(!hook.command.includes('/old/bin/spotter.mjs'));
    assert.ok(!hook.command.includes('\\old\\bin\\spotter.mjs'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('install: preserves pre-existing unrelated hooks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-install-'));
  try {
    await mkdir(join(dir, '.claude'), { recursive: true });
    await writeFile(
      join(dir, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'other-tool finish' }] }],
        },
      }),
      'utf8'
    );
    await runInstall({ target: 'project', autoYes: true, cwd: dir, skipRefresh: true });
    const settings = JSON.parse(await readFile(join(dir, '.claude', 'settings.json'), 'utf8'));
    // Existing hook must still be there, alongside spotter
    const stopCommands = settings.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command));
    assert.ok(stopCommands.some((c) => c.includes('other-tool')));
    assert.ok(stopCommands.some((c) => c.includes('spotter.mjs')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('install (project): writes .spotter/marker.json with version metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-marker-'));
  try {
    await runInstall({
      target: 'project', autoYes: true, cwd: dir, skipRefresh: true,
      resolveDefaultAuditorContextFn: async () => ({
        mode: 'throughline', command: '/opt/throughline/bin/throughline', args: [], origin: 'default',
      }),
    });
    const marker = JSON.parse(await readFile(join(dir, '.spotter', 'marker.json'), 'utf8'));
    assert.equal(marker.markerVersion, '2');
    assert.ok(typeof marker.spotterVersion === 'string' && marker.spotterVersion.length > 0);
    assert.ok(typeof marker.installedAt === 'string' && marker.installedAt.length > 0);
    assert.deepEqual(marker.auditorContext, {
      mode: 'throughline', command: '/opt/throughline/bin/throughline', args: [], origin: 'default',
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('install (project): preserves existing auditorContext unless explicitly replaced', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-marker-context-preserve-'));
  const existing = { mode: 'throughline', command: '/opt/throughline/bin/throughline', args: ['--profile', 'readonly'] };
  try {
    await mkdir(join(dir, '.spotter'), { recursive: true });
    await writeFile(join(dir, '.spotter', 'marker.json'), JSON.stringify({ markerVersion: '1', auditorContext: existing }), 'utf8');
    await runInstall({ target: 'project', autoYes: true, cwd: dir, skipRefresh: true });
    let marker = JSON.parse(await readFile(join(dir, '.spotter', 'marker.json'), 'utf8'));
    assert.deepEqual(marker.auditorContext, { ...existing, origin: 'explicit' });

    await runInstall({
      target: 'project', autoYes: true, cwd: dir, skipRefresh: true,
      auditorContext: { mode: 'disabled' },
    });
    marker = JSON.parse(await readFile(join(dir, '.spotter', 'marker.json'), 'utf8'));
    assert.deepEqual(marker.auditorContext, { mode: 'disabled', origin: 'explicit' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('install (project): writes explicit Throughline auditorContext configuration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-marker-context-throughline-'));
  const auditorContext = { mode: 'throughline', command: '/opt/throughline/bin/throughline', args: ['--profile', 'readonly'] };
  try {
    await runInstall({ target: 'project', autoYes: true, cwd: dir, skipRefresh: true, auditorContext });
    const marker = JSON.parse(await readFile(join(dir, '.spotter', 'marker.json'), 'utf8'));
    assert.deepEqual(marker.auditorContext, { ...auditorContext, origin: 'explicit' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('install (project): migrates legacy default-disabled markers but preserves explicit opt-out', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-marker-context-migrate-'));
  const resolved = { mode: 'throughline', command: '/opt/throughline/bin/throughline', args: [], origin: 'default' };
  try {
    await mkdir(join(dir, '.spotter'), { recursive: true });
    await writeFile(join(dir, '.spotter', 'marker.json'), JSON.stringify({
      markerVersion: '1', auditorContext: { mode: 'disabled' },
    }), 'utf8');
    await runInstall({
      target: 'project', autoYes: true, cwd: dir, skipRefresh: true,
      resolveDefaultAuditorContextFn: async () => resolved,
    });
    let marker = JSON.parse(await readFile(join(dir, '.spotter', 'marker.json'), 'utf8'));
    assert.deepEqual(marker.auditorContext, resolved);

    await runInstall({
      target: 'project', autoYes: true, cwd: dir, skipRefresh: true,
      auditorContext: { mode: 'disabled' },
    });
    await runInstall({
      target: 'project', autoYes: true, cwd: dir, skipRefresh: true,
      resolveDefaultAuditorContextFn: async () => resolved,
    });
    marker = JSON.parse(await readFile(join(dir, '.spotter', 'marker.json'), 'utf8'));
    assert.deepEqual(marker.auditorContext, { mode: 'disabled', origin: 'explicit' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveDefaultAuditorContext: unavailable is explicit and Windows npm shims use node.exe plus throughline.mjs', async () => {
  assert.deepEqual(
    await resolveDefaultAuditorContext({ env: { PATH: '' } }),
    { mode: 'disabled', origin: 'default', reason: 'throughline_unavailable' },
  );

  const readable = new Set([
    join('C:\\npm', 'throughline.cmd'),
    join('C:\\npm', 'node_modules', 'throughline', 'bin', 'throughline.mjs'),
  ]);
  const result = await resolveDefaultAuditorContext({
    env: { Path: 'C:\\npm' },
    platform: 'win32',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    accessFn: async (path) => {
      if (!readable.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
  });
  assert.deepEqual(result, {
    mode: 'throughline',
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: [join('C:\\npm', 'node_modules', 'throughline', 'bin', 'throughline.mjs')],
    origin: 'default',
  });
});

test('install (project): re-run refreshes marker (installedAt updates on each install)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-marker-refresh-'));
  try {
    await runInstall({ target: 'project', autoYes: true, cwd: dir, skipRefresh: true });
    const first = JSON.parse(await readFile(join(dir, '.spotter', 'marker.json'), 'utf8'));
    // Ensure wall-clock advances at least 1ms so installedAt differs.
    await new Promise((r) => setTimeout(r, 5));
    await runInstall({ target: 'project', autoYes: true, cwd: dir, skipRefresh: true });
    const second = JSON.parse(await readFile(join(dir, '.spotter', 'marker.json'), 'utf8'));
    assert.equal(second.markerVersion, first.markerVersion);
    assert.equal(second.spotterVersion, first.spotterVersion);
    assert.notEqual(second.installedAt, first.installedAt, 'installedAt should refresh on re-install');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('install: re-run seeds tool-db even when hooks are unchanged (v1.1.1 regression guard)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-install-refresh-'));
  try {
    let callCount = 0;
    const mockRefresh = async ({ hostAgent }) => {
      assert.equal(hostAgent, 'claude');
      callCount++;
      return new Map();
    };
    await runInstall({ target: 'project', autoYes: true, cwd: dir, refreshFn: mockRefresh, skipCodexHooks: true });
    await runInstall({ target: 'project', autoYes: true, cwd: dir, refreshFn: mockRefresh, skipCodexHooks: true });
    // Both calls must invoke refresh. The 2nd is the direct regression test for
    // the early-return that v1.1.1 removed — before that fix, the 2nd call
    // short-circuited at "hooks already registered" and never touched refresh.
    assert.equal(callCount, 2, 'refresh should run on both fresh and re-install');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('install: registers Codex hooks when Codex CLI is present', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-install-codex-hooks-'));
  const calls = [];
  try {
    await runInstall({
      target: 'project',
      autoYes: true,
      cwd: dir,
      skipRefresh: true,
      skipCodexHooks: false,
      codexCliPresentFn: () => true,
      installCodexHooksFn: async () => {
        calls.push('install');
        return {
          hooksPath: '/home/test/.codex/hooks.json',
          hooks: { sessionStart: 'installed', userPromptSubmit: 'installed', stop: 'installed' },
        };
      },
    });
    assert.deepEqual(calls, ['install']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('install: seeds Codex tool-db when Codex hooks are registered', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-install-codex-seed-'));
  const refreshHosts = [];
  try {
    const mockRefresh = async ({ hostAgent }) => {
      refreshHosts.push(hostAgent);
      return new Map();
    };
    await runInstall({
      target: 'project',
      autoYes: true,
      cwd: dir,
      refreshFn: mockRefresh,
      skipCodexHooks: false,
      codexCliPresentFn: () => true,
      installCodexHooksFn: async () => ({
        hooksPath: '/home/test/.codex/hooks.json',
        hooks: { sessionStart: 'installed', userPromptSubmit: 'installed', stop: 'installed' },
      }),
    });
    assert.deepEqual(refreshHosts, ['claude', 'codex']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('install: skips Codex tool-db seed when Codex CLI is unavailable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-install-codex-unavailable-'));
  const refreshHosts = [];
  try {
    const mockRefresh = async ({ hostAgent }) => {
      refreshHosts.push(hostAgent);
      return new Map();
    };
    await runInstall({
      target: 'project',
      autoYes: true,
      cwd: dir,
      refreshFn: mockRefresh,
      skipCodexHooks: false,
      codexCliPresentFn: () => false,
      installCodexHooksFn: async () => {
        throw new Error('should not install Codex hooks');
      },
    });
    assert.deepEqual(refreshHosts, ['claude']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('install: refresh failure surfaces recovery hint on stderr', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-install-refresh-fail-'));
  const origWrite = process.stderr.write.bind(process.stderr);
  const captured = [];
  process.stderr.write = (chunk) => {
    captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  try {
    const failingRefresh = async () => {
      throw new Error('simulated MCP enumeration failure');
    };
    await assert.rejects(
      runInstall({ target: 'project', autoYes: true, cwd: dir, refreshFn: failingRefresh, skipCodexHooks: true }),
      /simulated MCP/
    );
    const stderrText = captured.join('');
    assert.ok(
      stderrText.includes('spotter db refresh'),
      `recovery hint missing from stderr. got: ${stderrText}`
    );
  } finally {
    process.stderr.write = origWrite;
    await rm(dir, { recursive: true, force: true });
  }
});

test('uninstall (project): removes .spotter/marker.json but keeps .spotter dir', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-uninstall-marker-'));
  try {
    await runInstall({ target: 'project', autoYes: true, cwd: dir, skipRefresh: true });
    // sanity: marker present after install
    await stat(join(dir, '.spotter', 'marker.json'));
    await runUninstall({ target: 'project', autoYes: true, cwd: dir });
    // marker gone
    await assert.rejects(stat(join(dir, '.spotter', 'marker.json')), { code: 'ENOENT' });
    // directory itself still present (user data may live here)
    const dirStat = await stat(join(dir, '.spotter'));
    assert.ok(dirStat.isDirectory());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
