import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCodexCliAvailable } from '../src/core/codex-cli-availability.mjs';

test('isCodexCliAvailable: returns false when PATH is empty', () => {
  assert.equal(
    isCodexCliAvailable({ env: {}, platform: 'linux', fileExists: () => true }),
    false
  );
});

test('isCodexCliAvailable: returns true when codex sits on POSIX PATH', () => {
  const seen = [];
  const fileExists = (p) => {
    seen.push(p);
    return p === '/usr/local/bin/codex';
  };
  assert.equal(
    isCodexCliAvailable({
      env: { PATH: '/usr/bin:/usr/local/bin:/opt/homebrew/bin' },
      platform: 'linux',
      fileExists,
    }),
    true
  );
  assert.deepEqual(seen, ['/usr/bin/codex', '/usr/local/bin/codex']);
});

test('isCodexCliAvailable: returns false when codex is missing from POSIX PATH', () => {
  assert.equal(
    isCodexCliAvailable({
      env: { PATH: '/usr/bin:/usr/local/bin' },
      platform: 'linux',
      fileExists: () => false,
    }),
    false
  );
});

test('isCodexCliAvailable: handles Windows PATH separator and PATHEXT-equivalent extensions', () => {
  const truthy = new Set([
    'C:\\Users\\x\\AppData\\Roaming\\npm\\codex.cmd',
  ]);
  const calls = [];
  const fileExists = (p) => {
    calls.push(p);
    return truthy.has(p);
  };
  assert.equal(
    isCodexCliAvailable({
      env: { Path: 'C:\\Windows;C:\\Users\\x\\AppData\\Roaming\\npm' },
      platform: 'win32',
      fileExists,
    }),
    true
  );
  assert.ok(calls.includes('C:\\Windows\\codex.cmd'));
  assert.ok(calls.includes('C:\\Users\\x\\AppData\\Roaming\\npm\\codex.cmd'));
});

test('isCodexCliAvailable: accepts PATH as fallback on Windows when Path is missing', () => {
  const fileExists = (p) => p === 'D:\\bin\\codex.exe';
  assert.equal(
    isCodexCliAvailable({
      env: { PATH: 'D:\\bin' },
      platform: 'win32',
      fileExists,
    }),
    true
  );
});

test('isCodexCliAvailable: skips empty entries from a malformed PATH', () => {
  const fileExists = (p) => p === '/opt/codex/bin/codex';
  assert.equal(
    isCodexCliAvailable({
      env: { PATH: '::/opt/codex/bin: ' },
      platform: 'linux',
      fileExists,
    }),
    true
  );
});

test('isCodexCliAvailable: defaultFileExists swallows ENOENT and returns false', () => {
  // No DI — exercise the default fs.statSync path. This guarantees that a
  // missing PATH entry never throws into the caller.
  assert.equal(
    isCodexCliAvailable({
      env: { PATH: '/definitely/not/a/real/dir/spotter-test-only' },
      platform: 'linux',
    }),
    false
  );
});
