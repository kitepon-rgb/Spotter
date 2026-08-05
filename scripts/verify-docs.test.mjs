import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('maintained document versions and repository-local links stay consistent', async () => {
  const { stdout } = await execFileAsync(process.execPath, ['scripts/verify-docs.mjs'], {
    cwd: process.cwd(),
  });
  assert.match(stdout, /^documentation verification: ok \(/);
});
