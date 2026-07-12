import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { version } from '../version.mjs';
import { CODEX_AUDITOR_PROMPT_VERSION, createCodexCliAuditorBackend } from '../core/codex-cli-backend.mjs';
import { CODEX_AUDITOR_MODEL_POLICY, resolveCodexAuditorModelSelection } from '../core/codex-auditor-model-policy.mjs';

const execFileAsync = promisify(execFile);
const ALLOWED_PROFILES = ['baseline', 'luna', 'terra', 'terra-medium'];
const DEFAULT_PROFILES = ['baseline', 'luna', 'terra'];
export const MAX_MODEL_MATRIX_RUNS = 300;

export async function runAuditorModelMatrixCommand({
  argv = [], env = process.env, now = () => Date.now(), readFileFn = readFile, writeFileFn = writeFile,
  createBackendFn = createCodexCliAuditorBackend, resolveSelectionFn = resolveCodexAuditorModelSelection,
  getCodexCliVersionFn = getCodexCliVersion, generatedAt = () => new Date().toISOString(), writeOutput = (text) => process.stdout.write(text),
} = {}) {
  const opts = parseArgs(argv);
  const raw = await readFileFn(opts.fixturesPath);
  const fixtureBytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const fixture = parseAndValidateFixture(fixtureBytes.toString('utf8'));
  const contextOptions = resolveContextOptions(opts, fixture.schema);
  if (fixture.cases.length * opts.repeat * opts.profiles.length > MAX_MODEL_MATRIX_RUNS) {
    throw new Error(`model-matrix run count exceeds maximum ${MAX_MODEL_MATRIX_RUNS}`);
  }
  const selections = Object.fromEntries(opts.profiles.map((profile) => [profile, resolveSelectionFn({ env, profile })]));
  const backends = Object.fromEntries(opts.profiles.map((profile) => {
    const backend = createBackendFn({ catalog: fixture.catalog, projectRoot: opts.projectRoot, env, modelProfile: profile });
    if (!sameSelection(selections[profile], backend?.modelSelection)) {
      throw new Error(`backend model selection does not match preflight profile: ${profile}`);
    }
    return [profile, backend];
  }));
  const cliVersion = normalizeCodexCliVersion(await getCodexCliVersionFn({ env }));
  const runs = [];
  let order = 0;
  for (const item of fixture.cases) for (let repeat = 1; repeat <= opts.repeat; repeat += 1) for (const profile of opts.profiles) {
    const startedAt = now();
    const modelSelection = selections[profile];
    try {
      const backend = backends[profile];
      const judgment = await backend.judge({ ...toAuditorInput(item, contextOptions), meta: { caseId: item.id, repeat, profile } });
      if (!sameSelection(modelSelection, judgment?.meta?.modelSelection)) {
        throw new Error('judgment model selection does not match backend model selection');
      }
      const rawFindings = Array.isArray(judgment?.findings) ? judgment.findings : [];
      const rawActualTools = rawFindings.map((finding) => finding?.toolName);
      const actualTools = rawActualTools.filter(isCleanString);
      const invalidFindingCount = rawActualTools.length - actualTools.length;
      const actualPass = typeof judgment?.pass === 'boolean' ? judgment.pass : null;
      const rawDroppedTools = Array.isArray(judgment?.meta?.diagnostics?.droppedCatalogExternalNames)
        ? judgment.meta.diagnostics.droppedCatalogExternalNames
        : [];
      const rawAnomalies = Array.isArray(judgment?.anomalies) ? judgment.anomalies : [];
      const droppedTools = cleanStrings(rawDroppedTools);
      const anomalyTypes = cleanStrings(rawAnomalies.map((anomaly) => anomaly?.type));
      const tokenUsage = safeTokenUsage(judgment?.meta?.diagnostics?.tokenUsage);
      const schemaSuccess = actualPass !== null && Array.isArray(judgment?.findings)
        && invalidFindingCount === 0 && new Set(actualTools).size === actualTools.length
        && actualPass === (actualTools.length === 0);
      runs.push(successRun({
        order: ++order,
        item,
        repeat,
        profile,
        modelSelection,
        durationMs: now() - startedAt,
        schemaSuccess,
        actualPass,
        actualTools,
        invalidFindingCount,
        droppedTools,
        droppedToolCount: rawDroppedTools.length,
        anomalyTypes,
        anomalyCount: rawAnomalies.length,
        tokenUsage,
      }));
    } catch (err) {
      runs.push({ order: ++order, caseId: item.id, repeat, profile, status: 'error', durationMs: now() - startedAt,
        schemaSuccess: false, exactMatch: false, expected: item.expected, actual: { pass: null, missingTools: [], invalidFindingCount: 0, droppedCatalogExternalNames: [], droppedCatalogExternalNameCount: 0, anomalies: [], anomalyCount: 0 }, falsePositiveTools: [], falseNegativeTools: [], modelSelection,
        tokenUsage: null, error: safeError(err) });
    }
  }
  const usage = summarizeTokenUsage(runs, opts.profiles);
  const artifact = {
    schema: 'spotter.auditor_model_matrix.v1', generatedAt: generatedAt(), packageVersion: version,
    fixture: { schema: fixture.schema, path: safeFixturePath(opts.fixturesPath, opts.projectRoot), sha256: createHash('sha256').update(fixtureBytes).digest('hex'), cases: fixture.cases.length, catalogCount: fixture.catalog.length },
    codexCli: cliVersion, policy: { schema: CODEX_AUDITOR_MODEL_POLICY.schema, version: CODEX_AUDITOR_MODEL_POLICY.policyVersion },
    auditorPromptVersion: CODEX_AUDITOR_PROMPT_VERSION,
    profiles: Object.fromEntries(Object.entries(selections).map(([profile, selection]) => [profile, {
      model: selection.effectiveModel,
      reasoningEffort: selection.effectiveReasoningEffort,
      verifiedAt: selection.effectiveVerifiedAt,
      verificationScope: selection.effectiveVerificationScope ?? null,
      status: selection.effectiveStatus ?? null,
      selection,
    }])), runs, summary: summarize(runs, opts.profiles), usageStatus: usage.status, tokenUsage: usage.summary,
    costStatus: 'not-available-chatgpt-plan', cost: null,
    evaluation: { repeat: opts.repeat, profiles: opts.profiles, maxRuns: MAX_MODEL_MATRIX_RUNS, recentTurns: contextOptions.recentTurns, bodyCap: contextOptions.bodyCap },
    executionOrdering: 'case-repeat-profile', promotionEligible: false, blockingReasons: blockingReasons(runs, usage.status),
  };
  const json = JSON.stringify(artifact, null, 2) + '\n';
  if (opts.outputPath) await writeFileFn(opts.outputPath, json, 'utf8');
  writeOutput(json);
  return artifact;
}

function parseArgs(argv) {
  const opts = { fixturesPath: null, profiles: [], repeat: 1, projectRoot: process.cwd(), outputPath: null, recentTurns: null, bodyCap: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]; const value = () => { const v = argv[++i]; if (!v || v.startsWith('--')) throw new Error(`${arg} requires a value`); return v; };
    if (arg === '--fixtures') opts.fixturesPath = resolve(value());
    else if (arg === '--profile') opts.profiles.push(value());
    else if (arg === '--repeat') opts.repeat = Number(value());
    else if (arg === '--project') opts.projectRoot = resolve(value());
    else if (arg === '--output') opts.outputPath = resolve(value());
    else if (arg === '--recent-turns') opts.recentTurns = Number(value());
    else if (arg === '--body-cap') opts.bodyCap = Number(value());
    else throw new Error(`unknown auditor model-matrix option: ${arg}`);
  }
  if (!opts.fixturesPath) throw new Error('--fixtures FILE is required');
  if (!Number.isInteger(opts.repeat) || opts.repeat < 1) throw new Error('--repeat must be a positive integer');
  if (opts.recentTurns !== null && (!Number.isInteger(opts.recentTurns) || opts.recentTurns < 0 || opts.recentTurns > 3)) throw new Error('--recent-turns must be 0, 1, 2, or 3');
  if (opts.bodyCap !== null && (!Number.isInteger(opts.bodyCap) || opts.bodyCap <= 0)) throw new Error('--body-cap must be a positive integer');
  opts.profiles = opts.profiles.length ? opts.profiles : [...DEFAULT_PROFILES];
  if (new Set(opts.profiles).size !== opts.profiles.length || opts.profiles.some((profile) => !ALLOWED_PROFILES.includes(profile))) throw new Error('--profile must be baseline, luna, terra, or terra-medium without duplicates');
  return opts;
}

function parseAndValidateFixture(raw) {
  let fixture; try { fixture = JSON.parse(raw); } catch { throw new Error('fixture must be valid JSON'); }
  objectOnly(fixture, ['schema', 'catalog', 'cases'], 'fixture');
  if (!['spotter.auditor_model_fixtures.v1', 'spotter.auditor_model_fixtures.v2'].includes(fixture.schema)) throw new Error('unsupported fixture schema');
  if (!Array.isArray(fixture.catalog) || !Array.isArray(fixture.cases) || fixture.cases.length === 0) throw new Error('fixture catalog and non-empty cases are required');
  const catalogNames = new Set();
  for (const tool of fixture.catalog) { objectOnly(tool, ['name', 'description'], 'catalog tool'); clean(tool.name, 'catalog name'); clean(tool.description, 'catalog description'); if (catalogNames.has(tool.name)) throw new Error('duplicate catalog name'); catalogNames.add(tool.name); }
  const ids = new Set();
  for (const item of fixture.cases) {
    objectOnly(item, ['id', 'stage', 'input', 'expected'], 'case'); clean(item.id, 'case id');
    if (ids.has(item.id)) throw new Error('duplicate case id'); ids.add(item.id);
    if (!['user_input', 'turn_end'].includes(item.stage)) throw new Error('case stage is invalid');
    validateInput(fixture.schema, item.stage, item.input); objectOnly(item.expected, ['pass', 'missingTools'], 'case expected');
    if (typeof item.expected.pass !== 'boolean' || !Array.isArray(item.expected.missingTools)
      || new Set(item.expected.missingTools).size !== item.expected.missingTools.length
      || item.expected.missingTools.some((name) => typeof name !== 'string' || !catalogNames.has(name))
      || item.expected.pass !== (item.expected.missingTools.length === 0)) throw new Error('case expected is invalid or references a catalog-external tool');
  }
  return fixture;
}
function objectOnly(value, keys, label) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new Error(`${label} has invalid fields`); }
function clean(value, label) { if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) throw new Error(`${label} must be a clean non-empty string`); }
function validateInput(schema, stage, input) { if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('case input is invalid'); if (stage === 'user_input') { objectOnly(input, schema === 'spotter.auditor_model_fixtures.v2' ? ['userInput', 'recentContext'] : ['userInput'], 'user_input input'); clean(input.userInput, 'userInput'); if (schema === 'spotter.auditor_model_fixtures.v2') { if (!Array.isArray(input.recentContext) || input.recentContext.length < 1 || input.recentContext.length > 3) throw new Error('recentContext must contain one to three turns'); for (const turn of input.recentContext) { objectOnly(turn, ['user', 'assistant'], 'recentContext turn'); clean(turn.user, 'recentContext user'); clean(turn.assistant, 'recentContext assistant'); } } } else { objectOnly(input, ['finalResponse', 'usedTools'], 'turn_end input'); clean(input.finalResponse, 'finalResponse'); if (!Array.isArray(input.usedTools) || input.usedTools.some((tool) => typeof tool !== 'string' || tool.length === 0 || tool.trim() !== tool) || new Set(input.usedTools).size !== input.usedTools.length) throw new Error('usedTools is invalid'); } }
function resolveContextOptions(opts, schema) { if (schema === 'spotter.auditor_model_fixtures.v1') { if (opts.recentTurns !== null || opts.bodyCap !== null) throw new Error('--recent-turns and --body-cap require a v2 fixture'); return { recentTurns: null, bodyCap: null }; } return { recentTurns: opts.recentTurns ?? 2, bodyCap: opts.bodyCap ?? 1200 }; }
function toAuditorInput(item, contextOptions) { if (item.stage !== 'user_input') return { stage: item.stage, finalResponse: item.input.finalResponse, usedTools: item.input.usedTools }; const input = { stage: item.stage, userInput: item.input.userInput }; if (contextOptions.recentTurns > 0 && item.input.recentContext) input.recentContext = item.input.recentContext.slice(-contextOptions.recentTurns).map((turn) => ({ user: turn.user.slice(-contextOptions.bodyCap), assistant: turn.assistant.slice(-contextOptions.bodyCap) })); return input; }
function isCleanString(value) { return typeof value === 'string' && value.length > 0 && value.trim() === value; }
function cleanStrings(values = []) { return [...new Set(values.filter(isCleanString))]; }
function successRun({ order, item, repeat, profile, modelSelection, durationMs, schemaSuccess, actualPass, actualTools, invalidFindingCount, droppedTools, droppedToolCount, anomalyTypes, anomalyCount, tokenUsage }) { const expectedTools = item.expected.missingTools; const fp = [...actualTools.filter((tool) => !expectedTools.includes(tool)), ...droppedTools.filter((tool) => !expectedTools.includes(tool))]; const fn = expectedTools.filter((tool) => !actualTools.includes(tool)); return { order, caseId: item.id, repeat, profile, status: 'success', durationMs, schemaSuccess, exactMatch: schemaSuccess && actualPass === item.expected.pass && actualTools.length === expectedTools.length && fp.length === 0 && fn.length === 0 && droppedToolCount === 0 && anomalyCount === 0, expected: item.expected, actual: { pass: actualPass, missingTools: actualTools, invalidFindingCount, droppedCatalogExternalNames: droppedTools, droppedCatalogExternalNameCount: droppedToolCount, anomalies: anomalyTypes, anomalyCount }, falsePositiveTools: fp, falseNegativeTools: fn, modelSelection, tokenUsage }; }
const SAFE_RUN_ERRORS = Object.freeze({
  E_CODEX_CLI_AUTH: { name: 'AuditorBackendError', message: 'codex-cli authentication failed; run codex login' },
  E_CODEX_CLI_EXIT: { name: 'AuditorBackendError', message: 'codex-cli invocation exited unsuccessfully' },
  E_CODEX_CLI_MODEL_POLICY: { name: 'CodexAuditorModelPolicyError', message: 'codex-cli model policy validation failed' },
  E_CODEX_CLI_NO_FINAL_JSON: { name: 'AuditorBackendError', message: 'codex-cli did not produce a final JSON result' },
  E_CODEX_CLI_SCHEMA: { name: 'AuditorBackendError', message: 'codex-cli returned an invalid auditor result' },
  E_CODEX_CLI_SPAWN: { name: 'AuditorBackendError', message: 'codex-cli invocation could not start' },
  E_CODEX_CLI_TIMEOUT: { name: 'AuditorBackendError', message: 'codex-cli invocation timed out' },
  E_CODEX_CLI_USAGE_LIMIT: { name: 'AuditorBackendError', message: 'codex-cli usage limit reached; wait for reset or change plan' },
  E_AUDITOR_MODEL_MATRIX: { name: 'Error', message: 'auditor model-matrix run failed' },
});
const SAFE_DIAGNOSTIC_ENUMS = Object.freeze({
  completionReason: new Set(['last_message_before_process_close']),
  lastMessageCheck: new Set(['schema_valid', 'missing_last_message', 'schema_invalid_last_message']),
  processCountMethod: new Set(['direct_child_spawn', 'direct_child_exec_file', 'spawn_failed', 'not_available', 'not_instrumented']),
});
function safeFixturePath(fixturePath, projectRoot) { const path = relative(projectRoot, fixturePath); if (path === '') return '.'; if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) return '<external-fixture>'; return path.split(sep).join('/'); }
function safeError(err) { const code = Object.hasOwn(SAFE_RUN_ERRORS, err?.code) ? err.code : 'E_AUDITOR_MODEL_MATRIX'; const safe = SAFE_RUN_ERRORS[code]; const diagnostics = compact(err?.diagnostics); const stage = ['user_input', 'turn_end', 'configuration'].includes(err?.stage) ? err.stage : 'unknown'; return { code, name: safe.name, message: safe.message, backend: 'codex-cli', stage, ...(diagnostics ? { diagnostics } : {}) }; }
function compact(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) return null; const out = {}; for (const key of ['durationMs', 'processCount', 'exitCode']) if (typeof value[key] === 'number' && Number.isFinite(value[key])) out[key] = value[key]; for (const key of ['stdoutTruncated', 'stderrTruncated']) if (typeof value[key] === 'boolean') out[key] = value[key]; for (const [key, allowed] of Object.entries(SAFE_DIAGNOSTIC_ENUMS)) if (allowed.has(value[key])) out[key] = value[key]; for (const key of ['stdout', 'stderr']) if (typeof value[key] === 'string' || Buffer.isBuffer(value[key])) out[`${key}Bytes`] = Buffer.byteLength(value[key]); return Object.keys(out).length ? out : null; }
export function percentile(values, ratio) { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.ceil(sorted.length * ratio) - 1]; }
function summarize(rows, profiles) { const one = (items) => { const durations = items.map((item) => item.durationMs); const timeout = items.filter((item) => item.error?.code === 'E_CODEX_CLI_TIMEOUT').length; return { total: items.length, success: items.filter((item) => item.status === 'success').length, error: items.filter((item) => item.status === 'error').length, schemaSuccess: items.filter((item) => item.schemaSuccess).length, exactMatch: items.filter((item) => item.exactMatch).length, falsePositiveTools: items.reduce((sum, item) => sum + item.falsePositiveTools.length, 0), falseNegativeTools: items.reduce((sum, item) => sum + item.falseNegativeTools.length, 0), invalidFindingCount: items.reduce((sum, item) => sum + item.actual.invalidFindingCount, 0), anomalyCount: items.reduce((sum, item) => sum + item.actual.anomalyCount, 0), droppedCatalogExternalNameCount: items.reduce((sum, item) => sum + item.actual.droppedCatalogExternalNameCount, 0), durationMs: { p50: percentile(durations, 0.5), p95: percentile(durations, 0.95) }, timeoutCount: timeout, timeoutRate: items.length ? timeout / items.length : 0 }; }; return { ...one(rows), byProfile: Object.fromEntries(profiles.map((profile) => [profile, one(rows.filter((row) => row.profile === profile))])) }; }
function safeTokenUsage(value) { const keys = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens']; if (!value || typeof value !== 'object' || keys.some((key) => !Number.isSafeInteger(value[key]) || value[key] < 0) || value.totalTokens !== value.inputTokens + value.outputTokens) return null; return Object.fromEntries(keys.map((key) => [key, value[key]])); }
function summarizeTokenUsage(runs, profiles) { const observed = runs.filter((run) => run.tokenUsage); const one = (items) => { const withUsage = items.filter((item) => item.tokenUsage); const total = (key) => withUsage.reduce((sum, item) => sum + item.tokenUsage[key], 0); const totals = { inputTokens: total('inputTokens'), cachedInputTokens: total('cachedInputTokens'), outputTokens: total('outputTokens'), reasoningOutputTokens: total('reasoningOutputTokens'), totalTokens: total('totalTokens') }; return { observedRuns: withUsage.length, totalRuns: items.length, totals, totalTokensPerRun: { p50: percentile(withUsage.map((item) => item.tokenUsage.totalTokens), 0.5), p95: percentile(withUsage.map((item) => item.tokenUsage.totalTokens), 0.95) } }; }; const status = observed.length === 0 ? 'not-available' : observed.length === runs.length ? 'complete' : 'partial'; return { status, summary: observed.length === 0 ? null : { ...one(runs), byProfile: Object.fromEntries(profiles.map((profile) => [profile, one(runs.filter((run) => run.profile === profile))])) } }; }
function blockingReasons(runs, usageStatus) { const reasons = []; if (usageStatus !== 'complete') reasons.push('usage_not_available'); reasons.push('cost_not_available'); if (runs.some((run) => run.status === 'error')) reasons.push('run_error'); if (runs.some((run) => !run.schemaSuccess)) reasons.push('schema_failure'); if (runs.some((run) => !run.exactMatch)) reasons.push('exact_mismatch'); if (runs.some((run) => run.actual.anomalyCount > 0 || run.actual.droppedCatalogExternalNameCount > 0)) reasons.push('quality_anomaly'); return reasons; }
function sameSelection(expected, actual) { if (!expected || !actual || typeof expected !== 'object' || typeof actual !== 'object') return false; const keys = ['effectiveModel', 'effectiveReasoningEffort', 'modelSource', 'effortSource', 'policySchema', 'policyVersion', 'policyVerifiedAt', 'policyVerificationScope', 'effectiveVerifiedAt', 'effectiveStatus', 'effectiveVerificationScope', 'role', 'availability']; return keys.every((key) => expected[key] === actual[key]); }
function byteCount(value) { return typeof value === 'string' || Buffer.isBuffer(value) ? Buffer.byteLength(value) : 0; }
function safeVersionCode(value) { return typeof value === 'string' && /^E_[A-Z0-9_]{1,80}$/.test(value) ? value : 'E_CODEX_CLI_VERSION_INVALID'; }
function normalizeCodexCliVersion(value) { const status = value?.status; if (status === 'available' && typeof value.version === 'string' && value.version.length <= 200 && !/[\r\n]/.test(value.version) && /^codex(?:-cli)?\s+v?\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9.-]+)?$/.test(value.version)) return { status: 'available', version: value.version }; if (status === 'unavailable') return { status: 'unavailable', ...(value?.code ? { code: safeVersionCode(value.code) } : {}) }; return { status: 'error', code: safeVersionCode(value?.code), stdoutBytes: byteCount(value?.stdout ?? value?.version), stderrBytes: byteCount(value?.stderr) }; }
async function getCodexCliVersion({ env = process.env } = {}) { try { const { stdout } = await execFileAsync('codex', ['--version'], { timeout: 5_000, encoding: 'utf8', env }); return { status: 'available', version: stdout.trim() }; } catch (err) { return { status: err?.code === 'ENOENT' ? 'unavailable' : 'error', code: err?.code === 'ENOENT' ? 'E_CODEX_CLI_NOT_FOUND' : 'E_CODEX_CLI_VERSION_COMMAND', stdout: err?.stdout, stderr: err?.stderr }; } }
