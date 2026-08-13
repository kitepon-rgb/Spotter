import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inspectCodexCliVersion,
  inspectAuditorContextConfiguration,
  inspectCodexHookConfiguration,
  isSupportedNodeVersion,
} from '../src/cli/doctor.mjs';

test('Node要件はpackage enginesと同じ22.13以上', () => {
  assert.equal(isSupportedNodeVersion('22.12.0'), false);
  assert.equal(isSupportedNodeVersion('22.13.0'), true);
  assert.equal(isSupportedNodeVersion('23.0.0'), true);
  assert.equal(isSupportedNodeVersion('21.99.0'), false);
  assert.equal(isSupportedNodeVersion('invalid'), false);
});

test('inspectCodexCliVersion: Windowsではnpm shimをcmd.exe経由で診断する', async () => {
  let call;
  const version = await inspectCodexCliVersion({
    platform: 'win32',
    env: { Path: '' },
    execFileFn: async (command, args, options) => {
      call = { command, args, options };
      return { stdout: 'codex-cli 0.144.3\r\n' };
    },
  });
  assert.equal(version, 'codex-cli 0.144.3');
  assert.equal(call.command, 'cmd.exe');
  assert.deepEqual(call.args, ['/d', '/s', '/c', 'codex', '--version']);
  assert.equal(call.options.windowsHide, true);
});

test('inspectCodexHookConfiguration: forwards projectRoot and rejects legacy false-success', async () => {
  let received;
  const result = await inspectCodexHookConfiguration({
    projectRoot: '/project',
    diagnosticsFn: async (args) => {
      received = args;
      return {
        availability: 'available',
        readiness: 'misconfigured',
        validation: { sessionStart: { issues: ['async:true', 'timeoutSec'] } },
        trust: { state: 'unknown', action: 'review with /hooks' },
        auditorBackend: 'codex-cli',
        auditorModelSelection: {
          effectiveModel: 'gpt-5.6-luna',
          effectiveReasoningEffort: 'low',
          modelSource: 'profile:luna',
          effortSource: 'profile:luna',
          availability: 'unverified-until-invocation',
        },
      };
    },
  });
  assert.deepEqual(received, { projectRoot: '/project' });
  assert.equal(result.ok, false);
  assert.match(result.detail, /availability=available/);
  assert.match(result.detail, /sessionStart:async:true/);
  assert.match(result.detail, /trust=unknown/);
  assert.match(result.detail, /auditor-backend=codex-cli/);
  assert.match(result.detail, /auditor-model=gpt-5\.6-luna/);
  assert.match(result.detail, /availability=unverified-until-invocation/);
});

test('inspectCodexHookConfiguration: non-Codex active backend has no applicable Codex model', async () => {
  const result = await inspectCodexHookConfiguration({
    diagnosticsFn: async () => ({
      availability: 'available',
      readiness: 'configured-unverified',
      validation: {},
      trust: { state: 'unknown', action: 'review with /hooks' },
      auditorBackend: 'haiku',
      auditorModelSelection: null,
    }),
  });
  assert.match(result.detail, /auditor-backend=haiku/);
  assert.match(result.detail, /auditor-model=not-applicable/);
  assert.doesNotMatch(result.detail, /gpt-/);
});

test('inspectCodexHookConfiguration: configured-unverified is the only configuration OK state', async () => {
  const result = await inspectCodexHookConfiguration({
    diagnosticsFn: async () => ({
      availability: 'available', readiness: 'configured-unverified', validation: {}, trust: { state: 'unknown', action: 'review with /hooks' },
    }),
  });
  assert.equal(result.ok, true);
});

test('inspectCodexHookConfiguration: readiness alone determines configuration status', async () => {
  for (const readiness of ['unavailable', 'not-installed', 'misconfigured', 'configured-unverified']) {
    const result = await inspectCodexHookConfiguration({
      diagnosticsFn: async () => ({
        availability: 'available', readiness, validation: {}, runtime: { observation: 'observed' }, trust: { state: 'unknown', action: 'review with /hooks' },
      }),
    });
    assert.equal(result.ok, readiness === 'configured-unverified', readiness);
  }
});

test('inspectAuditorContextConfiguration: missing field and disabled mode are explicit compatible disabled states', async () => {
  const project = await makeProjectMarker({});
  try {
    assert.deepEqual(await inspectAuditorContextConfiguration({ projectRoot: project }), {
      ok: true, mode: 'disabled', detail: 'disabled',
    });
    await writeMarker(project, { auditorContext: { mode: 'disabled' } });
    assert.deepEqual(await inspectAuditorContextConfiguration({ projectRoot: project }), {
      ok: true, mode: 'disabled', detail: 'disabled',
    });
    await writeMarker(project, { auditorContext: { mode: 'disabled', origin: 'explicit' } });
    assert.deepEqual(await inspectAuditorContextConfiguration({ projectRoot: project }), {
      ok: true, mode: 'disabled', detail: 'explicit project opt-out',
    });
    await writeMarker(project, {
      auditorContext: { mode: 'disabled', origin: 'default', reason: 'throughline_unavailable' },
    });
    assert.deepEqual(await inspectAuditorContextConfiguration({ projectRoot: project }), {
      ok: true, mode: 'disabled', detail: 'default disabled: Throughline unavailable',
    });
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('inspectAuditorContextConfiguration: accepts an available absolute Throughline command without reflecting it', async () => {
  const project = await makeProjectMarker({});
  const command = join(project, 'throughline');
  try {
    await writeFile(command, '#!/bin/sh\n', 'utf8');
    await writeMarker(project, { auditorContext: { mode: 'throughline', command, args: ['--profile', 'read-only'] } });
    const result = await inspectAuditorContextConfiguration({ projectRoot: project });
    assert.deepEqual(result, { ok: true, mode: 'throughline', detail: 'command available' });
    assert.doesNotMatch(result.detail, new RegExp(command.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('inspectAuditorContextConfiguration: warns for relative or invalid Throughline configuration', async () => {
  const project = await makeProjectMarker({});
  try {
    for (const auditorContext of [
      { mode: 'throughline', command: 'throughline', args: [] },
      { mode: 'throughline', command: 'C:\\tools\\throughline.cmd', args: [] },
      { mode: 'throughline', command: '/absolute/throughline', args: [''] },
      { mode: 'other', command: '/absolute/throughline', args: [] },
    ]) {
      await writeMarker(project, { auditorContext });
      assert.deepEqual(await inspectAuditorContextConfiguration({ projectRoot: project }), {
        ok: false,
        mode: auditorContext.mode === 'throughline' ? 'throughline' : 'unknown',
        detail: 'invalid configuration',
      });
    }
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('inspectAuditorContextConfiguration: warns when configured command is missing', async () => {
  const project = await makeProjectMarker({});
  try {
    await writeMarker(project, { auditorContext: { mode: 'throughline', command: join(project, 'missing-throughline'), args: [] } });
    assert.deepEqual(await inspectAuditorContextConfiguration({ projectRoot: project }), {
      ok: false, mode: 'throughline', detail: 'command unavailable',
    });
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('inspectAuditorContextConfiguration: malformed marker returns a fixed warning without raw sentinel', async () => {
  const project = await makeProjectMarker({});
  const sentinel = 'DO_NOT_REFLECT_AUDITOR_MARKER_SECRET';
  try {
    await writeFile(join(project, '.spotter', 'marker.json'), `{broken:${sentinel}`, 'utf8');
    const result = await inspectAuditorContextConfiguration({ projectRoot: project });
    assert.deepEqual(result, { ok: false, mode: 'unknown', detail: 'marker unreadable' });
    assert.doesNotMatch(JSON.stringify(result), new RegExp(sentinel));
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

async function makeProjectMarker(marker) {
  const project = await mkdtemp(join(tmpdir(), 'spotter-doctor-auditor-context-'));
  await mkdir(join(project, '.spotter'));
  await writeMarker(project, marker);
  return project;
}

async function writeMarker(project, marker) {
  await writeFile(join(project, '.spotter', 'marker.json'), JSON.stringify(marker), 'utf8');
}
