import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cursorCwd,
  cursorHookDiagnostics,
  installCursorHooks,
  runCursorSessionStartHook,
  uninstallCursorHooks,
} from '../src/cli/cursor-hook-cmd.mjs';

test('cursor-hook install: flat sessionStart を足し、工場 hook は残す', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-cursor-hooks-'));
  try {
    await writeFile(join(dir, 'hooks.json'), `${JSON.stringify({
      version: 1,
      hooks: {
        sessionStart: [{ command: '/factory/cursor-constitution-hook', timeout: 10 }],
        beforeSubmitPrompt: [{ command: '/factory/cursor-constitution-hook', timeout: 10 }],
      },
    }, null, 2)}\n`);
    const first = await installCursorHooks({
      cursorHome: dir,
      nodePath: '/opt/homebrew/bin/node',
      spotterBin: '/opt/homebrew/bin/spotter',
    });
    assert.equal(first.hooks.sessionStart, 'added');
    const file = JSON.parse(await readFile(join(dir, 'hooks.json'), 'utf8'));
    assert.equal(file.version, 1);
    assert.deepEqual(file.hooks.beforeSubmitPrompt, [
      { command: '/factory/cursor-constitution-hook', timeout: 10 },
    ]);
    assert.equal(file.hooks.sessionStart[0].command, '/factory/cursor-constitution-hook');
    assert.equal(file.hooks.sessionStart[1].command.includes('cursor-hook session-start'), true);
    assert.equal(file.hooks.sessionStart[1].timeout, 5);
    assert.equal(Object.hasOwn(file.hooks.sessionStart[1], 'type'), false);

    const second = await installCursorHooks({
      cursorHome: dir,
      nodePath: '/opt/homebrew/bin/node',
      spotterBin: '/opt/homebrew/bin/spotter',
    });
    assert.equal(second.hooks.sessionStart, 'unchanged');
    assert.equal(cursorHookDiagnostics({ cursorHome: dir }).installation, 'installed');

    const removed = await uninstallCursorHooks({ cursorHome: dir });
    assert.equal(removed.hooks.sessionStart, 'removed');
    const after = JSON.parse(await readFile(join(dir, 'hooks.json'), 'utf8'));
    assert.deepEqual(after.hooks.sessionStart, [
      { command: '/factory/cursor-constitution-hook', timeout: 10 },
    ]);
    assert.deepEqual(after.hooks.beforeSubmitPrompt, [
      { command: '/factory/cursor-constitution-hook', timeout: 10 },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cursor-hook session-start: conversation_id envelope から marker を探し cursor refresh を spawn する', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-cursor-session-'));
  try {
    await mkdir(join(dir, '.spotter'), { recursive: true });
    await writeFile(join(dir, '.spotter', 'marker.json'), '{"markerVersion":"2"}\n');
    const calls = [];
    await runCursorSessionStartHook({
      readInput: async () => ({
        conversation_id: 'conv-1',
        workspace_roots: [dir],
        prompt: 'hello',
      }),
      spawnRefreshDetachedFn: (opts) => { calls.push(opts); },
    });
    assert.deepEqual(calls, [{ projectRoot: dir, hostAgent: 'cursor' }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cursorCwd: cwd が無ければ workspace_roots[0] を使う', () => {
  assert.equal(cursorCwd({ cwd: '/tmp/proj' }), '/tmp/proj');
  assert.equal(cursorCwd({ workspace_roots: ['/tmp/ws'] }), '/tmp/ws');
  assert.equal(cursorCwd({}), null);
});
