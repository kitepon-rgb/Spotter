import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { access, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  buildCodexCliAuditorPrompt,
  buildCodexCliSpawnOptions,
  buildCodexExecArgs,
  CODEX_AUDITOR_SCHEMA,
  createCodexCliAuditorBackend,
} from '../src/core/codex-cli-backend.mjs';
import { AuditorBackendError, createAuditorBackend } from '../src/core/auditor-backend.mjs';

const catalog = [
  { name: 'mcp__caveat__caveat_search', description: 'Search known caveats.' },
  { name: 'current_time', description: 'Get current time.' },
];

test('buildCodexCliAuditorPrompt: uses a stateless Codex-specific prompt, not Haiku preamble', () => {
  const prompt = buildCodexCliAuditorPrompt({
    catalog,
    input: { stage: 'user_input', userInput: '過去の罠を確認して' },
  });
  assert.match(prompt, /You are Spotter/);
  assert.match(prompt, /stage=user_input/);
  assert.match(prompt, /mcp__caveat__caveat_search/);
  assert.match(prompt, /follow-up tools whose need depends on a result not yet observed/);
  assert.ok(!prompt.includes('あなたは Spotter。Bell'), 'Codex CLI prompt must not reuse raw Haiku preamble');
});

test('buildCodexExecArgs: pins schema, last-message, read-only sandbox, and prompt argument', () => {
  assert.deepEqual(buildCodexExecArgs({
    schemaPath: '/tmp/schema.json',
    lastMessagePath: '/tmp/last.json',
    projectRoot: '/repo',
    prompt: 'judge',
  }), [
    'exec',
    '--json',
    '--output-schema',
    '/tmp/schema.json',
    '--output-last-message',
    '/tmp/last.json',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--sandbox',
    'read-only',
    '--cd',
    '/repo',
    '-c',
    'model_reasoning_effort="low"',
    'judge',
  ]);
});

test('buildCodexExecArgs: accepts explicit auditor model and reasoning effort overrides', () => {
  const args = buildCodexExecArgs({
    schemaPath: '/tmp/schema.json',
    lastMessagePath: '/tmp/last.json',
    projectRoot: '/repo',
    prompt: 'judge',
    model: 'gpt-5.4-mini',
    reasoningEffort: 'medium',
  });
  assert.deepEqual(args.slice(-5), ['--model', 'gpt-5.4-mini', '-c', 'model_reasoning_effort="medium"', 'judge']);
});

test('buildCodexCliSpawnOptions: ignores stdin and marks Codex children for recursion gates', () => {
  const opts = buildCodexCliSpawnOptions({ projectRoot: '/repo', env: { PATH: '/bin' } });
  assert.equal(opts.cwd, '/repo');
  assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(opts.env.SPOTTER_BACKEND, 'codex-cli');
  assert.equal(opts.env.SPOTTER_CHILD_BACKEND, 'codex-cli');
  assert.match(opts.env.SPOTTER_PARENT_PID, /^codex-cli:/);
});

test('CODEX_AUDITOR_SCHEMA: matches the shared Spotter response shape', () => {
  assert.equal(CODEX_AUDITOR_SCHEMA.required.includes('pass'), true);
  assert.equal(CODEX_AUDITOR_SCHEMA.required.includes('missing_tools'), true);
  assert.equal(CODEX_AUDITOR_SCHEMA.properties.missing_tools.items.required.includes('name'), true);
  assert.equal(CODEX_AUDITOR_SCHEMA.properties.missing_tools.items.required.includes('reason'), true);
});

test('createCodexCliAuditorBackend: reads last-message JSON, filters catalog misses, and cleans tempdir', async () => {
  let captured = null;
  const spawnFn = (cmd, args, opts) => {
    captured = { cmd, args, opts };
    const child = new EventEmitter();
    child.pid = 1234;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    const lastPath = args[args.indexOf('--output-last-message') + 1];
    queueMicrotask(async () => {
      child.stdout.write('{"type":"event"}\n');
      child.stderr.write('<html>analytics 403</html>');
      await import('node:fs/promises').then(({ writeFile }) => writeFile(lastPath, JSON.stringify({
        pass: false,
        missing_tools: [
          { name: 'mcp__caveat__caveat_search', reason: 'known caveat should be searched' },
          { name: 'ghost_tool', reason: 'bogus' },
        ],
      }), 'utf8'));
      child.emit('close', 0);
    });
    return child;
  };

  const backend = createCodexCliAuditorBackend({
    catalog,
    projectRoot: '/repo',
    env: { PATH: '/bin', SPOTTER_CODEX_CLI_MODEL: 'gpt-5.4-mini', SPOTTER_CODEX_CLI_REASONING_EFFORT: 'medium' },
    spawnFn,
  });
  const judgment = await backend.judge({ stage: 'user_input', userInput: '罠を確認して' });
  assert.equal(captured.cmd, 'codex');
  assert.equal(captured.opts.stdio[0], 'ignore');
  assert.equal(captured.opts.env.SPOTTER_CHILD_BACKEND, 'codex-cli');
  assert.ok(captured.args.includes('--model'));
  assert.ok(captured.args.includes('gpt-5.4-mini'));
  assert.ok(captured.args.includes('model_reasoning_effort="medium"'));
  const schemaPath = captured.args[captured.args.indexOf('--output-schema') + 1];
  const tempDir = dirname(schemaPath);
  await assert.rejects(access(tempDir));
  assert.equal(judgment.pass, false);
  assert.equal(judgment.findings.length, 1);
  assert.equal(judgment.findings[0].toolName, 'mcp__caveat__caveat_search');
  assert.equal(judgment.meta.backend, 'codex-cli');
  assert.equal(judgment.meta.mode, 'exec');
  assert.deepEqual(judgment.meta.diagnostics.droppedCatalogExternalNames, ['ghost_tool']);
  assert.equal(judgment.meta.diagnostics.processCount, 1);
  assert.equal(judgment.meta.diagnostics.processCountMethod, 'direct_child_spawn');
  assert.equal(judgment.meta.diagnostics.childPid, 1234);
  assert.match(judgment.meta.diagnostics.stderr, /analytics 403/);
});

test('createCodexCliAuditorBackend: no final JSON is a structured error', async () => {
  const spawnFn = (_cmd, _args, _opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => child.emit('close', 0));
    return child;
  };
  const backend = createCodexCliAuditorBackend({
    catalog,
    projectRoot: '/repo',
    spawnFn,
  });
  await assert.rejects(
    backend.judge({ stage: 'user_input', userInput: 'x' }),
    (err) => err instanceof AuditorBackendError && err.code === 'E_CODEX_CLI_NO_FINAL_JSON'
  );
});

test('createCodexCliAuditorBackend: spawn failure is a structured error', async () => {
  const backend = createCodexCliAuditorBackend({
    catalog,
    projectRoot: '/repo',
    spawnFn: () => {
      const err = new Error('missing binary');
      err.code = 'ENOENT';
      throw err;
    },
  });
  await assert.rejects(
    backend.judge({ stage: 'user_input', userInput: 'x' }),
    (err) => err instanceof AuditorBackendError && err.code === 'E_CODEX_CLI_SPAWN'
      && err.diagnostics.processCount === 0
      && err.diagnostics.processCountMethod === 'spawn_failed'
  );
});

test('createCodexCliAuditorBackend: non-zero exit is a structured error with bounded stderr', async () => {
  const spawnFn = (_cmd, _args, _opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stderr.write('x'.repeat(40 * 1024));
      child.emit('close', 2);
    });
    return child;
  };
  const backend = createCodexCliAuditorBackend({
    catalog,
    projectRoot: '/repo',
    spawnFn,
  });
  await assert.rejects(
    backend.judge({ stage: 'user_input', userInput: 'x' }),
    (err) =>
      err instanceof AuditorBackendError &&
      err.code === 'E_CODEX_CLI_EXIT' &&
      err.diagnostics.stderr.length === 32 * 1024 &&
      err.diagnostics.stderrTruncated === true
  );
});

test('createCodexCliAuditorBackend: timeout kills child and returns structured error', async () => {
  let killed = false;
  const spawnFn = (_cmd, _args, _opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      killed = true;
    };
    return child;
  };
  const backend = createCodexCliAuditorBackend({
    catalog,
    projectRoot: '/repo',
    spawnFn,
    timeoutMs: 5,
  });
  await assert.rejects(
    backend.judge({ stage: 'user_input', userInput: 'x' }),
    (err) => err instanceof AuditorBackendError && err.code === 'E_CODEX_CLI_TIMEOUT'
  );
  assert.equal(killed, true);
});

test('createCodexCliAuditorBackend: timeout accepts schema-valid last-message before process close', async () => {
  let killed = false;
  const spawnFn = (_cmd, args, _opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      killed = true;
    };
    const lastPath = args[args.indexOf('--output-last-message') + 1];
    queueMicrotask(async () => {
      await import('node:fs/promises').then(({ writeFile }) => writeFile(lastPath, JSON.stringify({
        pass: false,
        missing_tools: [
          { name: 'mcp__caveat__caveat_search', reason: 'known caveat should be searched' },
        ],
      }), 'utf8'));
    });
    return child;
  };
  const backend = createCodexCliAuditorBackend({
    catalog,
    projectRoot: '/repo',
    spawnFn,
    timeoutMs: 10,
  });
  const judgment = await backend.judge({ stage: 'user_input', userInput: '罠を確認して' });
  assert.equal(killed, true);
  assert.equal(judgment.pass, false);
  assert.equal(judgment.findings[0].toolName, 'mcp__caveat__caveat_search');
  assert.equal(judgment.meta.diagnostics.completionReason, 'last_message_before_process_close');
  assert.equal(judgment.meta.diagnostics.exitCode, null);
});

test('createAuditorBackend: codex-cli now returns the Codex CLI backend', () => {
  const backend = createAuditorBackend({
    backend: 'codex-cli',
    catalog,
    projectRoot: '/repo',
  });
  assert.equal(backend.name, 'codex-cli');
});

test('codex-cli backend source does not depend on sidecar policy', async () => {
  const source = await readFile(new URL('../src/core/codex-cli-backend.mjs', import.meta.url), 'utf8');
  assert.ok(!source.includes('codex-sidecar-policy'));
});
