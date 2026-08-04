import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Mac dashboard LaunchAgent exposes Homebrew Node to the spotter env shebang', async () => {
  const plist = await read('ops/dashboard/launchd/dev.kitepon.spotter-dashboard-device.plist');
  assert.match(plist, /<key>EnvironmentVariables<\/key>/);
  assert.match(plist, /<key>PATH<\/key><string>\/opt\/homebrew\/bin:/);
});

test('Windows native device avoids the WSL2 localhost relay port', async () => {
  const device = await read('ops/dashboard/windows/spotter-dashboard-device.ps1');
  const tunnel = await read('ops/dashboard/windows/spotter-dashboard-tunnel.ps1');
  assert.match(device, /--port 53944/);
  assert.match(tunnel, /127\.0\.0\.1:53943:127\.0\.0\.1:53944/);
  assert.doesNotMatch(tunnel, /127\.0\.0\.1:53943:127\.0\.0\.1:53940/);
});
