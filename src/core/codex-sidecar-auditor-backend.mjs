import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { toSpotterJudgment } from './judgment.mjs';
import { filterCatalogMisses } from './auditor-response.mjs';
import { AuditorBackendError } from './auditor-error.mjs';
import { buildWindowsCompatibleInvocation } from './windows-cli-shim.mjs';

const execFileP = promisify(execFile);
const DEFAULT_CODEX_SIDECAR_AUDITOR_TIMEOUT_MS = 45_000;
const STDOUT_LIMIT = 8 * 1024;
const STDERR_LIMIT = 16 * 1024;
const CHILD_OUTPUT_MAX_BUFFER = 4 * 1024 * 1024;

export function createCodexSidecarAuditorBackend({
  catalog = [],
  projectRoot,
  env = process.env,
  execFileFn = execFileP,
  buildInvocationFn = buildWindowsCompatibleInvocation,
  timeoutMs = DEFAULT_CODEX_SIDECAR_AUDITOR_TIMEOUT_MS,
} = {}) {
  if (!Array.isArray(catalog)) {
    throw new TypeError('createCodexSidecarAuditorBackend: catalog must be an array');
  }
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new TypeError('createCodexSidecarAuditorBackend: projectRoot must be a non-empty string');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('createCodexSidecarAuditorBackend: timeoutMs must be a positive number');
  }
  const catalogNames = new Set(catalog.map((tool) => tool.name));

  return {
    name: 'codex-sidecar',
    reset() {},
    async judge(input = {}) {
      const stage = validateStage(input.stage);
      const startedAt = Date.now();
      const prompt = buildCodexSidecarAuditorPrompt({ catalog, input: { ...input, stage } });
      const tempDir = await mkdtemp(join(tmpdir(), 'spotter-codex-sidecar-auditor-'));
      const contextFilePath = join(tempDir, 'auditor-context.json');
      try {
        await writeFile(contextFilePath, JSON.stringify(buildCodexSidecarAuditorContext(prompt), null, 2), 'utf8');
        const run = await runCodexSidecarAuditor({
          projectRoot,
          contextFilePath,
          env,
          execFileFn,
          buildInvocationFn,
          timeoutMs,
        });
        const parsed = parseCodexSidecarAuditorResult(run.value, { stage });
        const { parsed: filtered, dropped } = filterCatalogMisses(parsed, catalogNames);
        return toSpotterJudgment({
          stage,
          parsed: filtered,
          meta: {
            ...(input.meta ?? {}),
            backend: 'codex-sidecar',
            mode: 'auditor',
            durationMs: Date.now() - startedAt,
            diagnostics: {
              ...run.diagnostics,
              droppedCatalogExternalNames: dropped,
            },
          },
        });
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
  };
}

export function buildCodexSidecarAuditorPrompt({ catalog, input }) {
  const stage = validateStage(input.stage);
  const lines = [
    'You are Spotter, a primary tool-use auditor.',
    'Return the codex-sidecar auditor structured fields only through the sidecar JSON contract.',
    'Use only exact tool names from <catalog>. If no listed tool clearly applies, set pass=true and missingTools=[].',
    'Report only tools that are immediately applicable from the current input/output.',
    'Do not report follow-up tools whose need depends on a result not yet observed.',
    '',
    '<catalog>',
    JSON.stringify(catalog.map((tool) => ({ name: tool.name, description: tool.description }))),
    '</catalog>',
    '',
    `stage=${stage}`,
  ];
  if (stage === 'user_input') {
    if (typeof input.userInput !== 'string') {
      throw new TypeError('buildCodexSidecarAuditorPrompt: user_input requires userInput string');
    }
    lines.push('<user_input>', input.userInput, '</user_input>');
  } else {
    if (typeof input.finalResponse !== 'string') {
      throw new TypeError('buildCodexSidecarAuditorPrompt: turn_end requires finalResponse string');
    }
    const usedTools = Array.isArray(input.usedTools) && input.usedTools.length > 0
      ? input.usedTools.map((tool) => `- ${tool}`).join('\n')
      : '(none)';
    lines.push('<used_tools>', usedTools, '</used_tools>', '<final_response>', input.finalResponse, '</final_response>');
  }
  return lines.join('\n');
}

export function buildCodexSidecarAuditorContext(prompt) {
  if (typeof prompt !== 'string' || prompt.length === 0) {
    throw new TypeError('buildCodexSidecarAuditorContext: prompt must be a non-empty string');
  }
  return [
    {
      kind: 'manual_note',
      source: 'spotter-primary-auditor',
      trust: 'project',
      summary: 'Spotter primary auditor request. Follow data.instructions exactly.',
      data: { instructions: prompt },
    },
  ];
}

function buildCodexSidecarTaskPrompt() {
  return 'Evaluate context[0].data.instructions as a Spotter primary auditor request. Return auditor pass and missingTools.';
}

export function buildCodexSidecarAuditorCommand({ projectRoot, contextFilePath, env = process.env, timeoutMs = DEFAULT_CODEX_SIDECAR_AUDITOR_TIMEOUT_MS } = {}) {
  for (const [name, value] of Object.entries({ projectRoot, contextFilePath })) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(`buildCodexSidecarAuditorCommand: ${name} must be a non-empty string`);
    }
  }
  const args = [
    'auditor',
    '--project',
    projectRoot,
    '--preset',
    'auditor',
    '--json',
    '--context-file',
    contextFilePath,
    '--turn-timeout-ms',
    String(Math.ceil(timeoutMs)),
    buildCodexSidecarTaskPrompt(),
  ];
  const cliPath = env?.SPOTTER_CODEX_SIDECAR_CLI_PATH;
  if (typeof cliPath === 'string' && cliPath.length > 0) {
    return { cmd: process.execPath, args: [cliPath, ...args] };
  }
  const bin = env?.SPOTTER_CODEX_SIDECAR_BIN || 'codex-sidecar';
  return { cmd: bin, args };
}

function buildExecOptions({ projectRoot, env, timeoutMs }) {
  return {
    cwd: projectRoot,
    env: {
      ...env,
      SPOTTER_PARENT_PID: env?.SPOTTER_PARENT_PID || `codex-sidecar-auditor:${process.pid}`,
      SPOTTER_BACKEND: 'codex-sidecar',
      SPOTTER_CHILD_BACKEND: 'codex-sidecar',
      SPOTTER_SIDECAR: '1',
    },
    timeout: timeoutMs + 5_000,
    windowsHide: true,
    maxBuffer: CHILD_OUTPUT_MAX_BUFFER,
  };
}

async function runCodexSidecarAuditor({
  projectRoot,
  contextFilePath,
  env,
  execFileFn,
  buildInvocationFn,
  timeoutMs,
}) {
  const { cmd, args } = buildCodexSidecarAuditorCommand({ projectRoot, contextFilePath, env, timeoutMs });
  const options = buildExecOptions({ projectRoot, env, timeoutMs });
  const invocation = buildInvocationFn({
    command: cmd,
    args,
    env,
    allowCmdFallback: false,
  });
  const startedAt = Date.now();
  let stdout = '';
  let stderr = '';
  try {
    const result = await execFileFn(invocation.command, invocation.args, options);
    stdout = result.stdout ?? '';
    stderr = result.stderr ?? '';
  } catch (err) {
    stdout = typeof err?.stdout === 'string' ? err.stdout : '';
    stderr = typeof err?.stderr === 'string' ? err.stderr : '';
    let value = null;
    if (stdout.trim().length > 0) {
      try {
        value = parseJson(stdout, { stage: 'unknown' });
      } catch {
        // Keep the command error as the primary error.
      }
    }
    if (value && value.status !== 'failed' && value.status !== 'refused') {
      return {
        value,
        diagnostics: diagnostics({ startedAt, stdout, stderr, exitCode: err?.code ?? null, cmd, args }),
      };
    }
    throw new AuditorBackendError('E_CODEX_SIDECAR_EXIT', `codex-sidecar auditor failed: ${err?.message ?? String(err)}`, {
      backend: 'codex-sidecar',
      diagnostics: diagnostics({ startedAt, stdout, stderr, exitCode: err?.code ?? null, cmd, args }),
      cause: err,
    });
  }
  return {
    value: parseJson(stdout, { stage: 'unknown' }),
    diagnostics: diagnostics({ startedAt, stdout, stderr, exitCode: 0, cmd, args }),
  };
}

function parseCodexSidecarAuditorResult(value, { stage }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AuditorBackendError('E_CODEX_SIDECAR_SCHEMA', 'codex-sidecar auditor output must be an object', {
      backend: 'codex-sidecar',
      stage,
    });
  }
  if (value.status === 'failed' || value.status === 'refused') {
    throw new AuditorBackendError('E_CODEX_SIDECAR_STATUS', `codex-sidecar auditor returned status=${value.status}`, {
      backend: 'codex-sidecar',
      stage,
      diagnostics: { status: value.status, error: value.error ?? null },
    });
  }
  if (typeof value.pass !== 'boolean') {
    throw new AuditorBackendError('E_CODEX_SIDECAR_SCHEMA', 'codex-sidecar auditor result requires boolean pass', {
      backend: 'codex-sidecar',
      stage,
      diagnostics: { status: value.status },
    });
  }
  if (!Array.isArray(value.missingTools) || value.missingTools.some((tool) => !tool || typeof tool.name !== 'string' || typeof tool.reason !== 'string')) {
    throw new AuditorBackendError('E_CODEX_SIDECAR_SCHEMA', 'codex-sidecar auditor result requires missingTools array', {
      backend: 'codex-sidecar',
      stage,
      diagnostics: { status: value.status },
    });
  }
  const missingTools = value.missingTools.map((tool) => ({ name: tool.name, reason: tool.reason }));
  if (value.pass === true && missingTools.length > 0) {
    throw new AuditorBackendError('E_CODEX_SIDECAR_SCHEMA', 'codex-sidecar auditor result is inconsistent: pass=true with missingTools', {
      backend: 'codex-sidecar',
      stage,
    });
  }
  if (value.pass === false && missingTools.length === 0) {
    throw new AuditorBackendError('E_CODEX_SIDECAR_SCHEMA', 'codex-sidecar auditor result is inconsistent: pass=false without missingTools', {
      backend: 'codex-sidecar',
      stage,
    });
  }
  return {
    pass: value.pass,
    missing_tools: missingTools,
  };
}

function parseJson(stdout, { stage }) {
  try {
    return JSON.parse(stdout);
  } catch (err) {
    throw new AuditorBackendError('E_CODEX_SIDECAR_JSON', `codex-sidecar auditor output is not valid JSON: ${err.message}`, {
      backend: 'codex-sidecar',
      stage,
      cause: err,
    });
  }
}

function diagnostics({ startedAt, stdout, stderr, exitCode, cmd, args }) {
  const stdoutText = limit(stdout, STDOUT_LIMIT);
  const stderrText = limit(stderr, STDERR_LIMIT);
  return {
    durationMs: Date.now() - startedAt,
    processCount: 1,
    processCountMethod: 'direct_child_exec_file',
    command: [cmd, ...argsForMeta(args)],
    stdoutBytes: Buffer.byteLength(typeof stdout === 'string' ? stdout : '', 'utf8'),
    stderrBytes: Buffer.byteLength(typeof stderr === 'string' ? stderr : '', 'utf8'),
    stdout: stdoutText.value,
    stderr: stderrText.value,
    stdoutTruncated: stdoutText.truncated,
    stderrTruncated: stderrText.truncated,
    exitCode,
  };
}

function argsForMeta(args) {
  return args.map((arg, index) => {
    if (index > 0 && args[index - 1] === '--turn-timeout-ms') return '<ms>';
    if (index > 0 && args[index - 1] === '--context-file') return '<context-file>';
    if (index === args.length - 1) return '<prompt>';
    return arg;
  });
}

function limit(value, maxBytes) {
  const text = typeof value === 'string' ? value : '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return { value: text, truncated: false };
  }
  return {
    value: Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8'),
    truncated: true,
  };
}

function validateStage(stage) {
  if (stage !== 'user_input' && stage !== 'turn_end') {
    throw new TypeError('codex-sidecar auditor stage must be user_input or turn_end');
  }
  return stage;
}
