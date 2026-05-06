import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createAuditorBackend } from '../core/auditor-backend.mjs';
import { readLocal } from '../tool-db/refresh.mjs';

const AUDITOR_USAGE = `spotter auditor — experimental primary auditor smoke commands

Usage:
  spotter auditor judge --stage user_input|turn_end --input FILE
                        [--project DIR] [--host-agent claude|codex|automation|unknown]
                        [--backend haiku|codex-cli|codex-sidecar|auto]
  spotter auditor matrix --stage user_input|turn_end --input FILE [--project DIR]

Input JSON:
  user_input: {"user_input":"..."} or {"userInput":"..."}
  turn_end:   {"final_response":"...","used_tools":["..."]} or {"finalResponse":"...","usedTools":["..."]}

This command is internal/experimental. It is a smoke entrypoint, not proof that Codex native integration is complete.
`;

export async function runAuditorCommand({ argv = process.argv.slice(2) } = {}) {
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') {
    process.stdout.write(AUDITOR_USAGE);
    return;
  }
  if (sub === 'judge') {
    await runAuditorJudgeCommand({ argv: argv.slice(1) });
    return;
  }
  if (sub === 'matrix') {
    await runAuditorMatrixCommand({ argv: argv.slice(1) });
    return;
  }
  process.stderr.write(`unknown auditor subcommand: ${sub}\n${AUDITOR_USAGE}`);
  process.exit(2);
}

export async function runAuditorJudgeCommand({
  argv = [],
  readLocalFn = readLocal,
  createAuditorBackendFn = createAuditorBackend,
  writeOutput = (text) => process.stdout.write(text),
  writeError = (text) => process.stderr.write(text),
} = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    writeOutput(AUDITOR_USAGE);
    return;
  }
  const opts = parseJudgeArgs(argv);
  const missing = [];
  if (!opts.stage) missing.push('--stage user_input|turn_end');
  if (!opts.inputPath) missing.push('--input FILE');
  if (missing.length > 0) {
    writeError(`missing required auditor judge option(s): ${missing.join(', ')}\n${AUDITOR_USAGE}`);
    process.exit(2);
    return;
  }
  const payload = JSON.parse(await readFile(opts.inputPath, 'utf8'));
  const catalog = await readLocalFn({ projectRoot: opts.projectRoot, hostAgent: opts.hostAgent });
  const backend = createAuditorBackendFn({
    backend: opts.backend,
    catalog,
    projectRoot: opts.projectRoot,
    hostAgent: opts.hostAgent,
    env: process.env,
  });
  const judgment = await backend.judge(toAuditorInput({ stage: opts.stage, payload }));
  writeOutput(JSON.stringify(judgment, null, 2) + '\n');
}

export async function runAuditorMatrixCommand({
  argv = [],
  readLocalFn = readLocal,
  createAuditorBackendFn = createAuditorBackend,
  writeOutput = (text) => process.stdout.write(text),
  writeError = (text) => process.stderr.write(text),
  now = () => Date.now(),
} = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    writeOutput(AUDITOR_USAGE);
    return;
  }
  const opts = parseMatrixArgs(argv);
  const missing = [];
  if (!opts.stage) missing.push('--stage user_input|turn_end');
  if (!opts.inputPath) missing.push('--input FILE');
  if (missing.length > 0) {
    writeError(`missing required auditor matrix option(s): ${missing.join(', ')}\n${AUDITOR_USAGE}`);
    process.exit(2);
    return;
  }

  const payload = JSON.parse(await readFile(opts.inputPath, 'utf8'));
  const auditorInput = toAuditorInput({ stage: opts.stage, payload });
  const matrix = [];
  for (const row of AUDITOR_MATRIX_ROWS) {
    const catalog = await readLocalFn({ projectRoot: opts.projectRoot, hostAgent: row.hostAgent });
    matrix.push(await runAuditorMatrixRow({
      row,
      auditorInput,
      catalog,
      projectRoot: opts.projectRoot,
      createAuditorBackendFn,
      now,
    }));
  }
  const result = {
    fixture: {
      stage: opts.stage,
      inputPath: opts.inputPath,
      projectRoot: opts.projectRoot,
    },
    matrix,
    summary: summarizeMatrix(matrix),
  };
  writeOutput(JSON.stringify(result, null, 2) + '\n');
}

const AUDITOR_MATRIX_ROWS = Object.freeze([
  Object.freeze({ id: 'claude.codex-cli', hostAgent: 'claude', backend: 'codex-cli' }),
  Object.freeze({ id: 'claude.codex-sidecar', hostAgent: 'claude', backend: 'codex-sidecar' }),
  Object.freeze({ id: 'codex.codex-cli', hostAgent: 'codex', backend: 'codex-cli' }),
  Object.freeze({ id: 'codex.codex-sidecar', hostAgent: 'codex', backend: 'codex-sidecar' }),
]);

async function runAuditorMatrixRow({
  row,
  auditorInput,
  catalog,
  projectRoot,
  createAuditorBackendFn,
  now,
}) {
  const startedAt = now();
  try {
    const backend = createAuditorBackendFn({
      backend: row.backend,
      catalog,
      projectRoot,
      hostAgent: row.hostAgent,
      env: envForMatrixHost(row.hostAgent, process.env),
    });
    const judgment = await backend.judge({
      ...auditorInput,
      meta: {
        matrixId: row.id,
        hostAgent: row.hostAgent,
        requestedBackend: row.backend,
      },
    });
    return {
      ...row,
      role: 'primary_auditor',
      status: 'success',
      durationMs: now() - startedAt,
      pass: judgment.pass === true,
      findingCount: Array.isArray(judgment.findings) ? judgment.findings.length : 0,
      missingTools: Array.isArray(judgment.findings)
        ? judgment.findings.map((finding) => finding.toolName)
        : [],
      metrics: {
        schemaSuccess: judgment && typeof judgment.pass === 'boolean' && Array.isArray(judgment.findings),
        processCount: judgment?.meta?.diagnostics?.processCount ?? null,
        processCountMethod: judgment?.meta?.diagnostics?.processCountMethod ?? 'not_instrumented',
        recursionSafety: recursionSafetyFor(row.backend),
      },
      meta: compactAuditorMeta(judgment.meta ?? {}),
    };
  } catch (err) {
    return {
      ...row,
      role: 'primary_auditor',
      status: 'error',
      durationMs: now() - startedAt,
      pass: null,
      findingCount: null,
      missingTools: [],
      metrics: {
        schemaSuccess: false,
        processCount: null,
        processCountMethod: 'not_available',
        recursionSafety: recursionSafetyFor(row.backend),
      },
      error: serializeError(err, row),
    };
  }
}

function summarizeMatrix(matrix) {
  return {
    total: matrix.length,
    success: matrix.filter((row) => row.status === 'success').length,
    error: matrix.filter((row) => row.status === 'error').length,
    sidecarPrimaryAuditorImplemented: matrix
      .filter((row) => row.backend === 'codex-sidecar')
      .some((row) => row.status === 'success'),
  };
}

function recursionSafetyFor(backend) {
  if (backend === 'codex-cli') return 'spotter_parent_pid_backend_env';
  if (backend === 'codex-sidecar') return 'spotter_parent_pid_sidecar_env';
  return 'unknown';
}

function envForMatrixHost(hostAgent, baseEnv) {
  const env = { ...(baseEnv ?? {}) };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE;
  delete env.CODEX_SESSION_ID;
  delete env.CODEX_SANDBOX;
  if (hostAgent === 'claude') {
    env.CLAUDE_CODE = '1';
  } else if (hostAgent === 'codex') {
    env.CODEX_SANDBOX = 'read-only';
    env.CODEX_SESSION_ID = env.CODEX_SESSION_ID || 'spotter-matrix';
  }
  return env;
}

function serializeError(err, row) {
  const out = {
    name: typeof err?.name === 'string' ? err.name : 'Error',
    code: typeof err?.code === 'string' ? err.code : 'E_AUDITOR_MATRIX_ROW',
    message: typeof err?.message === 'string' ? err.message : String(err),
    backend: typeof err?.backend === 'string' ? err.backend : row.backend,
  };
  if (typeof err?.stage === 'string') out.stage = err.stage;
  if (err?.diagnostics !== undefined) out.diagnostics = compactDiagnostics(err.diagnostics);
  return out;
}

function compactAuditorMeta(meta) {
  const out = jsonSafe(meta);
  if (out && typeof out === 'object' && !Array.isArray(out) && out.diagnostics !== undefined) {
    out.diagnostics = compactDiagnostics(out.diagnostics);
  }
  return out;
}

function compactDiagnostics(diagnostics) {
  const out = jsonSafe(diagnostics);
  if (!out || typeof out !== 'object' || Array.isArray(out)) return out;
  for (const stream of ['stdout', 'stderr']) {
    if (typeof out[stream] === 'string') {
      if (typeof out[`${stream}Bytes`] !== 'number') {
        out[`${stream}Bytes`] = Buffer.byteLength(out[stream], 'utf8');
      }
      delete out[stream];
    }
  }
  return out;
}

function jsonSafe(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function toAuditorInput({ stage, payload }) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw Object.assign(new Error('auditor judge input must be a JSON object'), { exitCode: 2 });
  }
  if (stage === 'user_input') {
    const userInput = payload.user_input ?? payload.userInput;
    if (typeof userInput !== 'string') {
      throw Object.assign(new Error('auditor judge user_input requires user_input string'), { exitCode: 2 });
    }
    return { stage, userInput };
  }
  if (stage === 'turn_end') {
    const finalResponse = payload.final_response ?? payload.finalResponse;
    const usedTools = payload.used_tools ?? payload.usedTools ?? [];
    if (typeof finalResponse !== 'string') {
      throw Object.assign(new Error('auditor judge turn_end requires final_response string'), { exitCode: 2 });
    }
    if (!Array.isArray(usedTools) || usedTools.some((tool) => typeof tool !== 'string')) {
      throw Object.assign(new Error('auditor judge turn_end used_tools must be an array of strings'), { exitCode: 2 });
    }
    return { stage, finalResponse, usedTools };
  }
  throw Object.assign(new Error('auditor judge --stage must be user_input or turn_end'), { exitCode: 2 });
}

function parseJudgeArgs(argv) {
  const opts = {
    stage: null,
    inputPath: null,
    projectRoot: process.cwd(),
    hostAgent: null,
    backend: process.env.SPOTTER_AUDITOR_BACKEND || (process.env.SPOTTER_AUDITOR_BACKEND_POLICY ? 'auto' : 'haiku'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--stage') {
      opts.stage = requireValue(argv, (index += 1), '--stage');
      continue;
    }
    if (arg === '--input') {
      opts.inputPath = resolve(requireValue(argv, (index += 1), '--input'));
      continue;
    }
    if (arg === '--project') {
      opts.projectRoot = resolve(requireValue(argv, (index += 1), '--project'));
      continue;
    }
    if (arg === '--host-agent') {
      opts.hostAgent = requireValue(argv, (index += 1), '--host-agent');
      continue;
    }
    if (arg === '--backend') {
      opts.backend = requireValue(argv, (index += 1), '--backend');
      continue;
    }
    process.stderr.write(`unknown auditor judge option: ${arg}\n${AUDITOR_USAGE}`);
    process.exit(2);
    return opts;
  }
  return opts;
}

function parseMatrixArgs(argv) {
  const opts = {
    stage: null,
    inputPath: null,
    projectRoot: process.cwd(),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--stage') {
      opts.stage = requireValue(argv, (index += 1), '--stage');
      continue;
    }
    if (arg === '--input') {
      opts.inputPath = resolve(requireValue(argv, (index += 1), '--input'));
      continue;
    }
    if (arg === '--project') {
      opts.projectRoot = resolve(requireValue(argv, (index += 1), '--project'));
      continue;
    }
    process.stderr.write(`unknown auditor matrix option: ${arg}\n${AUDITOR_USAGE}`);
    process.exit(2);
    return opts;
  }
  return opts;
}

function requireValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw Object.assign(new Error(`${option} requires a value`), { exitCode: 2 });
  }
  return value;
}
