// Unit tests for install's hook-merge logic.
// Uses dynamic import to access the internal helpers by re-running mergeHooks
// through a controlled scenario.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInstall } from '../src/cli/install.mjs';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('install: creates hooks in fresh settings.json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spotter-install-'));
  try {
    await runInstall({ target: 'project', autoYes: true, cwd: dir });
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
    await runInstall({ target: 'project', autoYes: true, cwd: dir });
    await runInstall({ target: 'project', autoYes: true, cwd: dir });
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
    await runInstall({ target: 'project', autoYes: true, cwd: dir });
    const settings = JSON.parse(await readFile(join(dir, '.claude', 'settings.json'), 'utf8'));
    // Existing hook must still be there, alongside spotter
    const stopCommands = settings.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command));
    assert.ok(stopCommands.some((c) => c.includes('other-tool')));
    assert.ok(stopCommands.some((c) => c.includes('spotter.mjs')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
