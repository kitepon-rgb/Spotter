import { resolve } from 'node:path';
import { createEvaluationStore } from '../core/evaluation-store.mjs';
import { formatEvaluationCase, formatEvaluationCases, formatEvaluationReport } from '../core/evaluation-report.mjs';
import { stringifyAsciiJson } from './diagnostics-cmd.mjs';

const USAGE = `spotter evaluation — saved proposal-adoption observations

Usage:
  spotter evaluation report [--project PATH] [--from ISO] [--to ISO] [--host HOST] [--tool-id ID] [--backend NAME] [--model NAME] [--spotter-version VERSION] [--json]
  spotter evaluation cases --outcome OUTCOME [--project PATH] [--from ISO] [--to ISO] [--host HOST] [--tool-id ID] [--backend NAME] [--model NAME] [--spotter-version VERSION] [--json]
  spotter evaluation case OBSERVATION_ID [--json]
`;

export async function runEvaluationCommand({
  argv = process.argv.slice(2),
  createStoreFn = createEvaluationStore,
  cwd = process.cwd(),
  writeOutput = (text) => process.stdout.write(text),
} = {}) {
  const subcommand = argv[0];
  if (subcommand === 'report') {
    const options = parseOptions(argv.slice(1), { requireOutcome: false, cwd });
    return withStore(createStoreFn, (store) => {
      const report = store.summarize(options.filters);
      writeOutput(options.json ? `${stringifyAsciiJson(report)}\n` : formatEvaluationReport(report));
      return report;
    });
  }
  if (subcommand === 'cases') {
    const options = parseOptions(argv.slice(1), { requireOutcome: true, cwd });
    return withStore(createStoreFn, (store) => {
      const cases = store.listCases({ outcome: options.outcome, ...options.filters });
      writeOutput(options.json ? `${stringifyAsciiJson(cases)}\n` : formatEvaluationCases(cases));
      return cases;
    });
  }
  if (subcommand === 'case') {
    if (typeof argv[1] !== 'string' || argv[1].length === 0 || argv[1].startsWith('--')) throw usageError();
    const json = parseJsonOnly(argv.slice(2));
    return withStore(createStoreFn, (store) => {
      const item = store.getCase(argv[1]);
      if (!item) throw Object.assign(new Error(`evaluation observation not found: ${argv[1]}`), { exitCode: 1 });
      writeOutput(json ? `${stringifyAsciiJson(item)}\n` : formatEvaluationCase(item));
      return item;
    });
  }
  throw usageError();
}

function parseJsonOnly(argv) {
  if (argv.length === 0) return false;
  if (argv.length === 1 && argv[0] === '--json') return true;
  throw usageError();
}

function withStore(createStoreFn, operation) {
  const store = createStoreFn();
  try { return operation(store); } finally { store.close(); }
}

function parseOptions(argv, { requireOutcome, cwd }) {
  const filters = {};
  let outcome;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--json') {
      if (json) throw usageError();
      json = true;
    } else if (option === '--project') {
      if (filters.projectPath !== undefined) throw usageError();
      filters.projectPath = resolve(cwd, requiredValue(argv, ++index, option));
    } else if (option === '--from') {
      if (filters.fromMs !== undefined) throw usageError();
      filters.fromMs = parseIso(requiredValue(argv, ++index, option), option);
    } else if (option === '--to') {
      if (filters.toMs !== undefined) throw usageError();
      filters.toMs = parseIso(requiredValue(argv, ++index, option), option);
    } else if (option === '--host') {
      if (filters.host !== undefined) throw usageError();
      filters.host = requiredValue(argv, ++index, option);
    } else if (option === '--tool-id') {
      if (filters.toolId !== undefined) throw usageError();
      filters.toolId = requiredValue(argv, ++index, option);
    } else if (option === '--outcome' && requireOutcome) {
      if (outcome !== undefined) throw usageError();
      outcome = normalizeOutcome(requiredValue(argv, ++index, option));
    } else if (option === '--backend') {
      if (filters.backend !== undefined) throw usageError();
      filters.backend = requiredValue(argv, ++index, option);
    } else if (option === '--model') {
      if (filters.model !== undefined) throw usageError();
      filters.model = requiredValue(argv, ++index, option);
    } else if (option === '--spotter-version') {
      if (filters.spotterVersion !== undefined) throw usageError();
      filters.spotterVersion = requiredValue(argv, ++index, option);
    } else {
      throw usageError();
    }
  }
  if (requireOutcome && outcome === undefined) throw usageError();
  if (filters.fromMs !== undefined && filters.toMs !== undefined && filters.fromMs > filters.toMs) throw usageError();
  return { filters, outcome, json };
}

function normalizeOutcome(value) {
  if (value === 'not-adopted') return 'not_adopted';
  if (value === 'outcome-missing') return 'outcome_missing';
  return value;
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) throw usageError(`${option} requires a value`);
  return value;
}

function parseIso(value, option) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw usageError(`${option} requires an ISO timestamp`);
  return milliseconds;
}

function usageError(message = 'invalid evaluation arguments') {
  const error = new Error(`${message}\n${USAGE}`);
  error.stack = '';
  error.exitCode = 2;
  return error;
}
