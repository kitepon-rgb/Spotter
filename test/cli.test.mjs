import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const execFileAsync = promisify(execFile);
const BIN = resolve('bin', 'spotter.mjs');

test('cli: --help prints public and internal command contract', async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [BIN, '--help']);
  assert.equal(stderr, '');
  assert.ok(stdout.includes('spotter install [-y]'));
  assert.ok(stdout.includes('spotter db list'));
  assert.ok(stdout.includes('spotter db refresh'));
  assert.ok(stdout.includes('spotter db rebuild'));
  assert.ok(stdout.includes('spotter status'));
  assert.ok(stdout.includes('spotter doctor'));
  assert.ok(stdout.includes('spotter diagnostics logs [--json]'));
  assert.ok(stdout.includes('spotter codex risk-check --findings FILE'));
  assert.ok(stdout.includes('spotter codex review|explore|opinion --findings FILE'));
  assert.ok(stdout.includes('spotter codex work --findings FILE --approve-work --allowed-path PATH'));
  assert.ok(stdout.includes('spotter codex-hook install|diagnostics'));
  assert.ok(stdout.includes('spotter auditor judge --stage STAGE --input FILE'));
  assert.ok(stdout.includes('spotter daemon start --session-id ID'));
  assert.ok(stdout.includes('spotter hook <event>'));
  assert.ok(stdout.includes('session-start | user-prompt |'));
  assert.ok(stdout.includes('pre-tool-use | stop | session-end'));
});

test('cli: --version prints package version', async () => {
  const pkg = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
  const { stdout, stderr } = await execFileAsync(process.execPath, [BIN, '--version']);
  assert.equal(stderr, '');
  assert.equal(stdout, `spotter ${pkg.version}\n`);
});

test('cli: codex subcommand help exits successfully', async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [BIN, 'codex', 'risk-check', '--help']);
  assert.equal(stderr, '');
  assert.ok(stdout.includes('spotter codex — Codex sidecar workflows'));
  assert.ok(stdout.includes('spotter codex risk-check --findings FILE'));
  assert.ok(stdout.includes('spotter codex work --findings FILE'));
});

test('cli: auditor subcommand help exits successfully', async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [BIN, 'auditor', '--help']);
  assert.equal(stderr, '');
  assert.ok(stdout.includes('spotter auditor — experimental primary auditor smoke commands'));
  assert.ok(stdout.includes('spotter auditor judge --stage user_input|turn_end --input FILE'));
  assert.ok(stdout.includes('not proof that Codex native integration is complete'));
});

test('cli: codex-hook subcommand help exits successfully', async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [BIN, 'codex-hook', '--help']);
  assert.equal(stderr, '');
  assert.ok(stdout.includes('spotter codex-hook — experimental Codex native hook adapter'));
  assert.ok(stdout.includes('spotter codex-hook install [--codex-home DIR]'));
});

test('cli: unknown command exits 2 and prints usage', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [BIN, 'nope']),
    (err) => {
      assert.equal(err.code, 2);
      assert.match(err.stderr, /unknown command: nope/);
      assert.match(err.stderr, /Usage:/);
      return true;
    }
  );
});

test('cli: unknown hook event exits 2 and prints usage', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [BIN, 'hook', 'nope']),
    (err) => {
      assert.equal(err.code, 2);
      assert.match(err.stderr, /unknown hook event: nope/);
      assert.match(err.stderr, /events: session-start/);
      return true;
    }
  );
});
