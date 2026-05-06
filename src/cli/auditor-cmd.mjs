import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createAuditorBackend } from '../core/auditor-backend.mjs';
import { readLocal } from '../tool-db/refresh.mjs';

const AUDITOR_USAGE = `spotter auditor — experimental primary auditor smoke commands

Usage:
  spotter auditor judge --stage user_input|turn_end --input FILE
                        [--project DIR] [--host-agent claude|codex|automation|unknown]
                        [--backend haiku|codex-cli|codex-sidecar|auto]

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
  const catalog = await readLocalFn({ projectRoot: opts.projectRoot });
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

function requireValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw Object.assign(new Error(`${option} requires a value`), { exitCode: 2 });
  }
  return value;
}
