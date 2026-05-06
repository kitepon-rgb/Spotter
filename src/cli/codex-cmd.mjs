import { resolve } from 'node:path';
import { readFindingsJson, runCodexReadOnlyWorkflow, runCodexWork } from '../core/codex-sidecar-runner.mjs';

const CODEX_USAGE = `spotter codex — Codex sidecar workflows

Usage:
  spotter codex risk-check --findings FILE [--project DIR] [--host-agent claude|codex|automation|unknown]
                         [--dry-run] [--turn-timeout-ms MS] [--out FILE] [--no-save]
  spotter codex review --findings FILE [--project DIR] [--host-agent claude|codex|automation|unknown]
                         [--dry-run] [--turn-timeout-ms MS] [--out FILE] [--no-save]
  spotter codex explore --findings FILE [--project DIR] [--host-agent claude|codex|automation|unknown]
                         [--dry-run] [--turn-timeout-ms MS] [--out FILE] [--no-save]
  spotter codex opinion --findings FILE [--project DIR] [--host-agent claude|codex|automation|unknown]
                         [--dry-run] [--turn-timeout-ms MS] [--out FILE] [--no-save]
  spotter codex work --findings FILE --instruction TEXT --approve-work --allowed-path PATH
                         (--preserve-worktree | --remove-worktree)
                         [--project DIR] [--host-agent claude|codex|automation|unknown]
                         [--dry-run] [--turn-timeout-ms MS] [--out FILE] [--no-save]
`;

const CLI_WORKFLOWS = {
  'risk-check': 'codex_risk_check',
  review: 'codex_review',
  explore: 'codex_explore',
  opinion: 'codex_opinion',
};

export async function runCodexCommand({ argv = process.argv.slice(2) } = {}) {
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') {
    process.stdout.write(CODEX_USAGE);
    return;
  }
  if (sub === 'work') {
    await runCodexWorkCommand({ argv: argv.slice(1) });
    return;
  }
  const workflow = CLI_WORKFLOWS[sub];
  if (workflow) {
    await runCodexReadOnlyWorkflowCommand({ argv: argv.slice(1), workflow, commandName: sub });
    return;
  }
  process.stderr.write(`unknown codex subcommand: ${sub}\n${CODEX_USAGE}`);
  process.exit(2);
}

export async function runCodexWorkCommand({
  argv = [],
  writeOutput = (text) => process.stdout.write(text),
  writeError = (text) => process.stderr.write(text),
  runCodexWorkFn = runCodexWork,
  readFindingsJsonFn = readFindingsJson,
} = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    writeOutput(CODEX_USAGE);
    return;
  }
  const opts = parseWorkArgs(argv);
  const missing = [];
  if (!opts.findingsPath) missing.push('--findings FILE');
  if (!opts.instruction) missing.push('--instruction TEXT');
  if (!opts.approved) missing.push('--approve-work');
  if (opts.allowedPaths.length === 0) missing.push('--allowed-path PATH');
  if (!opts.cleanup) missing.push('--preserve-worktree or --remove-worktree');
  if (missing.length > 0) {
    writeError(`missing required codex work option(s): ${missing.join(', ')}\n${CODEX_USAGE}`);
    process.exit(2);
    return;
  }
  const findings = await readFindingsJsonFn(opts.findingsPath);
  const record = await runCodexWorkFn({
    projectRoot: opts.projectRoot,
    findings,
    instruction: opts.instruction,
    hostAgent: opts.hostAgent,
    approved: opts.approved,
    allowedPaths: opts.allowedPaths,
    cleanup: opts.cleanup,
    dryRun: opts.dryRun,
    turnTimeoutMs: opts.turnTimeoutMs,
    save: opts.save,
    outPath: opts.outPath,
  });
  writeOutput(JSON.stringify(record, null, 2) + '\n');
}

export async function runCodexReadOnlyWorkflowCommand({
  argv = [],
  workflow,
  commandName,
  writeOutput = (text) => process.stdout.write(text),
  writeError = (text) => process.stderr.write(text),
  runCodexReadOnlyWorkflowFn = runCodexReadOnlyWorkflow,
  readFindingsJsonFn = readFindingsJson,
} = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    writeOutput(CODEX_USAGE);
    return;
  }
  const opts = parseReadOnlyArgs(argv, commandName);
  if (!opts.findingsPath) {
    writeError(`missing required --findings FILE\n${CODEX_USAGE}`);
    process.exit(2);
    return;
  }
  const findings = await readFindingsJsonFn(opts.findingsPath);
  const record = await runCodexReadOnlyWorkflowFn({
    workflow,
    projectRoot: opts.projectRoot,
    findings,
    hostAgent: opts.hostAgent,
    dryRun: opts.dryRun,
    turnTimeoutMs: opts.turnTimeoutMs,
    save: opts.save,
    outPath: opts.outPath,
  });
  writeOutput(JSON.stringify(record, null, 2) + '\n');
}

function parseReadOnlyArgs(argv, commandName) {
  const opts = {
    projectRoot: process.cwd(),
    hostAgent: null,
    findingsPath: null,
    dryRun: false,
    turnTimeoutMs: null,
    save: true,
    outPath: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--findings') {
      opts.findingsPath = resolve(requireValue(argv, (index += 1), '--findings'));
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
    if (arg === '--dry-run') {
      opts.dryRun = true;
      continue;
    }
    if (arg === '--turn-timeout-ms') {
      opts.turnTimeoutMs = parsePositiveInteger(requireValue(argv, (index += 1), '--turn-timeout-ms'), '--turn-timeout-ms');
      continue;
    }
    if (arg === '--out') {
      opts.outPath = resolve(requireValue(argv, (index += 1), '--out'));
      opts.save = true;
      continue;
    }
    if (arg === '--no-save') {
      opts.save = false;
      continue;
    }
    process.stderr.write(`unknown codex ${commandName} option: ${arg}\n${CODEX_USAGE}`);
    process.exit(2);
    return opts;
  }
  return opts;
}

function parseWorkArgs(argv) {
  const opts = {
    projectRoot: process.cwd(),
    hostAgent: null,
    findingsPath: null,
    instruction: null,
    approved: false,
    allowedPaths: [],
    cleanup: null,
    dryRun: false,
    turnTimeoutMs: null,
    save: true,
    outPath: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--findings') {
      opts.findingsPath = resolve(requireValue(argv, (index += 1), '--findings'));
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
    if (arg === '--instruction') {
      opts.instruction = requireValue(argv, (index += 1), '--instruction');
      continue;
    }
    if (arg === '--approve-work') {
      opts.approved = true;
      continue;
    }
    if (arg === '--allowed-path') {
      opts.allowedPaths.push(requireValue(argv, (index += 1), '--allowed-path'));
      continue;
    }
    if (arg === '--preserve-worktree') {
      opts.cleanup = 'preserve';
      continue;
    }
    if (arg === '--remove-worktree') {
      opts.cleanup = 'remove';
      continue;
    }
    if (arg === '--dry-run') {
      opts.dryRun = true;
      continue;
    }
    if (arg === '--turn-timeout-ms') {
      opts.turnTimeoutMs = parsePositiveInteger(requireValue(argv, (index += 1), '--turn-timeout-ms'), '--turn-timeout-ms');
      continue;
    }
    if (arg === '--out') {
      opts.outPath = resolve(requireValue(argv, (index += 1), '--out'));
      opts.save = true;
      continue;
    }
    if (arg === '--no-save') {
      opts.save = false;
      continue;
    }
    process.stderr.write(`unknown codex work option: ${arg}\n${CODEX_USAGE}`);
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

function parsePositiveInteger(value, option) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw Object.assign(new Error(`${option} must be a positive integer`), { exitCode: 2 });
  }
  return parsed;
}
