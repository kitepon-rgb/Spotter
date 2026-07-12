import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toSpotterJudgment } from './judgment.mjs';
import { AuditorBackendError } from './auditor-error.mjs';
import { filterCatalogMisses, parseAuditorResponse } from './auditor-response.mjs';
import {
  CODEX_AUDITOR_MODEL_POLICY,
  resolveCodexAuditorModelSelection,
} from './codex-auditor-model-policy.mjs';

const DEFAULT_CODEX_CLI_TIMEOUT_MS = 45_000;
const DEFAULT_CODEX_CLI_MODEL = CODEX_AUDITOR_MODEL_POLICY.production.model;
const DEFAULT_CODEX_CLI_REASONING_EFFORT = CODEX_AUDITOR_MODEL_POLICY.production.reasoningEffort;
const STDERR_LIMIT = 32 * 1024;
const STDOUT_LIMIT = 64 * 1024;
const JSONL_LINE_LIMIT = 16 * 1024;
const MAX_RECORDED_TOKEN_COUNT = 100_000_000;

// codex prints auth/login failures to BOTH stdout (the JSON error stream, e.g.
// {"type":"error","message":"...sign in again..."}) and stderr (codex_login::auth::manager,
// e.g. "401 Unauthorized ... token_revoked"). We scan the combined text for these markers so a
// revoked/expired login is classified as the distinct, actionable E_CODEX_CLI_AUTH instead of
// being collapsed into the generic E_CODEX_CLI_EXIT. Conservative case-insensitive substring
// match keyed on the wording codex actually emits; if codex changes its wording the generic
// path still degrades loudly (the hook no longer freezes the host on either code). Classification
// runs only on the nonzero-exit path below — auth failures are observed to exit immediately
// (<1s), so the timeout path is not expected to see them; if codex ever starts hanging on auth,
// the timeout would surface as the generic E_CODEX_CLI_TIMEOUT rather than E_CODEX_CLI_AUTH.
const CODEX_AUTH_FAILURE_MARKERS = [
  'token_revoked',
  'refresh_token_reused',
  'refresh token was already used',
  'refresh token has already been used',
  'invalidated oauth token',
  '401 unauthorized',
  'sign in again',
  'sign back in',
  'log out and sign in',
  'not logged in',
  'please log in',
  'please login',
];

// Codex account-plan exhaustion is distinct from an arbitrary CLI crash: retrying the same
// auditor call cannot recover until the stated reset time or a plan change. Match only wording
// observed from Codex CLI so unrelated provider/rate errors stay on the generic loud path.
const CODEX_USAGE_LIMIT_FAILURE_MARKERS = [
  "you've hit your usage limit",
  'you have hit your usage limit',
];

// A model may be absent from local CLI metadata yet still be accepted by the provider, so do
// not classify metadata wording alone. This marker is the observed provider-side rejection for
// a model that cannot be used with the current ChatGPT account.
const CODEX_MODEL_UNAVAILABLE_FAILURE_MARKERS = [
  'model is not supported when using codex with a chatgpt account',
];

export function isCodexAuthFailure(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  const haystack = text.toLowerCase();
  return CODEX_AUTH_FAILURE_MARKERS.some((marker) => haystack.includes(marker));
}

export function isCodexUsageLimitFailure(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  const haystack = text.toLowerCase();
  return CODEX_USAGE_LIMIT_FAILURE_MARKERS.some((marker) => haystack.includes(marker));
}

export function isCodexModelUnavailableFailure(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  const haystack = text.toLowerCase();
  return CODEX_MODEL_UNAVAILABLE_FAILURE_MARKERS.some((marker) => haystack.includes(marker));
}

export function parseCodexTurnUsageLine(line) {
  if (typeof line !== 'string' || line.length === 0 || line.length > JSONL_LINE_LIMIT) return null;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (event?.type !== 'turn.completed') return null;
  const usage = event.usage;
  const keys = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens'];
  if (!usage || typeof usage !== 'object' || keys.some((key) => !Number.isSafeInteger(usage[key]) || usage[key] < 0 || usage[key] > MAX_RECORDED_TOKEN_COUNT)) return null;
  return Object.freeze({
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.cached_input_tokens,
    outputTokens: usage.output_tokens,
    reasoningOutputTokens: usage.reasoning_output_tokens,
    totalTokens: usage.input_tokens + usage.output_tokens,
  });
}

export const CODEX_AUDITOR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pass', 'missing_tools'],
  properties: {
    pass: { type: 'boolean' },
    missing_tools: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'reason'],
        properties: {
          name: { type: 'string', minLength: 1 },
          reason: { type: 'string', minLength: 1 },
        },
      },
    },
  },
};

export function createCodexCliAuditorBackend({
  catalog = [],
  projectRoot,
  env = process.env,
  spawnFn = spawn,
  timeoutMs = DEFAULT_CODEX_CLI_TIMEOUT_MS,
  codexBin = 'codex',
  modelProfile = null,
  resolveModelSelectionFn = resolveCodexAuditorModelSelection,
} = {}) {
  if (!Array.isArray(catalog)) {
    throw new TypeError('createCodexCliAuditorBackend: catalog must be an array');
  }
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new TypeError('createCodexCliAuditorBackend: projectRoot must be a non-empty string');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('createCodexCliAuditorBackend: timeoutMs must be a positive number');
  }
  const modelSelection = Object.freeze({
    ...resolveModelSelectionFn({ env, profile: modelProfile }),
  });
  const catalogNames = new Set(catalog.map((tool) => tool.name));

  return {
    name: 'codex-cli',
    modelSelection,
    reset() {},
    async judge(input = {}) {
      const stage = validateStage(input.stage);
      const tempDir = await mkdtemp(join(tmpdir(), 'spotter-codex-cli-'));
      const schemaPath = join(tempDir, 'auditor-schema.json');
      const lastMessagePath = join(tempDir, 'last-message.json');
      const startedAt = Date.now();
      try {
        await writeFile(schemaPath, JSON.stringify(CODEX_AUDITOR_SCHEMA, null, 2), 'utf8');
        const prompt = buildCodexCliAuditorPrompt({ catalog, input: { ...input, stage } });
        const run = await runCodexExec({
          codexBin,
          prompt,
          projectRoot,
          schemaPath,
          lastMessagePath,
          stage,
          env,
          spawnFn,
          timeoutMs,
          modelSelection,
        });
        let rawFinal;
        try {
          rawFinal = await readFile(lastMessagePath, 'utf8');
        } catch (err) {
          throw new AuditorBackendError('E_CODEX_CLI_NO_FINAL_JSON', `codex-cli did not write final JSON: ${err.message}`, {
            backend: 'codex-cli',
            stage,
            diagnostics: run.diagnostics,
            cause: err,
          });
        }
        let parsed;
        try {
          parsed = parseAuditorResponse(rawFinal, {
            backend: 'codex-cli',
            stage,
            errorCode: 'E_CODEX_CLI_SCHEMA',
          });
        } catch (err) {
          throw attachModelSelectionDiagnostics(err, {
            modelSelection,
            diagnostics: run.diagnostics,
          });
        }
        const { parsed: filtered, dropped } = filterCatalogMisses(parsed, catalogNames);
        return toSpotterJudgment({
          stage,
          parsed: filtered,
          meta: {
            ...(input.meta ?? {}),
            backend: 'codex-cli',
            mode: 'exec',
            durationMs: Date.now() - startedAt,
            modelSelection,
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

export function buildCodexCliAuditorPrompt({ catalog, input }) {
  const stage = validateStage(input.stage);
  const lines = [
    'You are Spotter, a tool-use auditor. Return JSON only.',
    'Schema: {"pass":boolean,"missing_tools":[{"name":string,"reason":string}]}',
    'Use only exact tool names from <catalog>. If no listed tool clearly applies, return {"pass":true,"missing_tools":[]}.',
    'Report only tools that are immediately applicable from the current input/output. Do not report follow-up tools whose need depends on a result not yet observed.',
    'Do not invent tool names. Do not explain outside JSON.',
    '',
    '<catalog>',
    JSON.stringify(catalog.map((tool) => ({ name: tool.name, description: tool.description }))),
    '</catalog>',
    '',
    `stage=${stage}`,
  ];
  if (stage === 'user_input') {
    if (typeof input.userInput !== 'string') {
      throw new TypeError('buildCodexCliAuditorPrompt: user_input requires userInput string');
    }
    lines.push('<user_input>', input.userInput, '</user_input>');
  } else {
    if (typeof input.finalResponse !== 'string') {
      throw new TypeError('buildCodexCliAuditorPrompt: turn_end requires finalResponse string');
    }
    const usedTools = Array.isArray(input.usedTools) && input.usedTools.length > 0
      ? input.usedTools.map((tool) => `- ${tool}`).join('\n')
      : '(none)';
    lines.push('<used_tools>', usedTools, '</used_tools>', '<final_response>', input.finalResponse, '</final_response>');
  }
  return lines.join('\n');
}

export function buildCodexExecArgs({ schemaPath, lastMessagePath, projectRoot, prompt, model = DEFAULT_CODEX_CLI_MODEL, reasoningEffort = DEFAULT_CODEX_CLI_REASONING_EFFORT }) {
  for (const [name, value] of Object.entries({ schemaPath, lastMessagePath, projectRoot, prompt })) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(`buildCodexExecArgs: ${name} must be a non-empty string`);
    }
  }
  const args = [
    'exec',
    '--json',
    '--output-schema',
    schemaPath,
    '--output-last-message',
    lastMessagePath,
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--sandbox',
    'read-only',
    '--cd',
    projectRoot,
  ];
  if (typeof model === 'string' && model.length > 0) {
    args.push('--model', model);
  }
  if (typeof reasoningEffort === 'string' && reasoningEffort.length > 0) {
    args.push('-c', `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`);
  }
  args.push(prompt);
  return args;
}

export function buildCodexCliSpawnOptions({ projectRoot, env = process.env } = {}) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new TypeError('buildCodexCliSpawnOptions: projectRoot must be a non-empty string');
  }
  return {
    cwd: projectRoot,
    env: {
      ...env,
      SPOTTER_PARENT_PID: env?.SPOTTER_PARENT_PID || `codex-cli:${process.pid}`,
      SPOTTER_BACKEND: 'codex-cli',
      SPOTTER_CHILD_BACKEND: 'codex-cli',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  };
}

async function runCodexExec({
  codexBin,
  prompt,
  projectRoot,
  schemaPath,
  lastMessagePath,
  stage,
  env,
  spawnFn,
  timeoutMs,
  modelSelection,
}) {
  const args = buildCodexExecArgs({
    schemaPath,
    lastMessagePath,
    projectRoot,
    prompt,
    model: modelSelection.effectiveModel,
    reasoningEffort: modelSelection.effectiveReasoningEffort,
  });
  const options = buildCodexCliSpawnOptions({ projectRoot, env });
  const startedAt = Date.now();
  let child;
  try {
    child = spawnFn(codexBin, args, options);
  } catch (err) {
    throw new AuditorBackendError('E_CODEX_CLI_SPAWN', `failed to spawn ${codexBin}: ${err.message}`, {
      backend: 'codex-cli',
      stage,
      diagnostics: {
        durationMs: Date.now() - startedAt,
        processCount: 0,
        processCountMethod: 'spawn_failed',
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        modelSelection,
      },
      cause: err,
    });
  }
  let stdout = '';
  let stderr = '';
  let stdoutTruncated = false;
  let stderrTruncated = false;
  const usageTracker = createCodexUsageTracker();

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      settle(async () => {
        const completed = await readSchemaValidLastMessage({ lastMessagePath, stage });
        if (completed.ok) {
          if (typeof child.kill === 'function') child.kill();
          resolve({
            diagnostics: {
              ...diagnostics(),
              exitCode: null,
              completionReason: 'last_message_before_process_close',
            },
          });
          return;
        }
        if (typeof child.kill === 'function') child.kill();
        reject(new AuditorBackendError('E_CODEX_CLI_TIMEOUT', `codex-cli did not respond within ${timeoutMs}ms`, {
          backend: 'codex-cli',
          stage,
          diagnostics: {
            ...diagnostics(),
            lastMessageCheck: completed.reason,
          },
        }));
      });
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      const next = chunk.toString('utf8');
      usageTracker.observe(next);
      if (stdout.length + next.length > STDOUT_LIMIT) {
        stdout = (stdout + next).slice(0, STDOUT_LIMIT);
        stdoutTruncated = true;
      } else {
        stdout += next;
      }
    });
    child.stderr?.on('data', (chunk) => {
      const next = chunk.toString('utf8');
      if (stderr.length + next.length > STDERR_LIMIT) {
        stderr = (stderr + next).slice(0, STDERR_LIMIT);
        stderrTruncated = true;
      } else {
        stderr += next;
      }
    });
    child.on('error', (err) => {
      settle(() => reject(new AuditorBackendError('E_CODEX_CLI_SPAWN', `failed to spawn ${codexBin}: ${err.message}`, {
        backend: 'codex-cli',
        stage,
        diagnostics: diagnostics(),
        cause: err,
      })));
    });
    child.on('close', (code) => {
      settle(() => {
        if (code !== 0) {
          const diag = { ...diagnostics(), exitCode: code };
          if (isCodexAuthFailure(`${diag.stdout}\n${diag.stderr}`)) {
            reject(new AuditorBackendError('E_CODEX_CLI_AUTH', 'codex-cli auth failed — codex login required (run `codex login`)', {
              backend: 'codex-cli',
              stage,
              diagnostics: diag,
            }));
            return;
          }
          if (isCodexUsageLimitFailure(`${diag.stdout}\n${diag.stderr}`)) {
            reject(new AuditorBackendError('E_CODEX_CLI_USAGE_LIMIT', 'codex-cli usage limit reached — wait for the stated reset time or change the Codex plan', {
              backend: 'codex-cli',
              stage,
              diagnostics: diag,
            }));
            return;
          }
          if (isCodexModelUnavailableFailure(`${diag.stdout}\n${diag.stderr}`)) {
            reject(new AuditorBackendError('E_CODEX_CLI_MODEL_UNAVAILABLE', 'codex-cli model is unavailable — update the model or reasoning-effort override, or review the auditor model policy', {
              backend: 'codex-cli',
              stage,
              diagnostics: diag,
            }));
            return;
          }
          reject(new AuditorBackendError('E_CODEX_CLI_EXIT', `codex-cli exited with code ${code}`, {
            backend: 'codex-cli',
            stage,
            diagnostics: diag,
          }));
          return;
        }
        resolve({ diagnostics: { ...diagnostics(), exitCode: code } });
      });
    });
  });

  function diagnostics() {
    const out = {
      durationMs: Date.now() - startedAt,
      processCount: 1,
      processCountMethod: 'direct_child_spawn',
      stdout,
      stderr,
      stdoutTruncated,
      stderrTruncated,
      modelSelection,
    };
    const tokenUsage = usageTracker.current();
    if (tokenUsage) out.tokenUsage = tokenUsage;
    if (Number.isInteger(child?.pid)) out.childPid = child.pid;
    return out;
  }
}

function createCodexUsageTracker() {
  let pending = '';
  let latest = null;
  const parse = (line) => {
    const usage = parseCodexTurnUsageLine(line.trim());
    if (usage) latest = usage;
  };
  return {
    observe(text) {
      if (typeof text !== 'string' || text.length === 0) return;
      const lines = (pending + text).split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) parse(line);
      if (pending.length > JSONL_LINE_LIMIT) pending = '';
    },
    current() {
      if (pending) parse(pending);
      return latest;
    },
  };
}

function attachModelSelectionDiagnostics(error, { modelSelection, diagnostics = null } = {}) {
  if (!(error instanceof AuditorBackendError)) return error;
  error.diagnostics = {
    ...(diagnostics ?? {}),
    ...(error.diagnostics ?? {}),
    modelSelection,
  };
  return error;
}

async function readSchemaValidLastMessage({ lastMessagePath, stage }) {
  try {
    const rawFinal = await readFile(lastMessagePath, 'utf8');
    parseAuditorResponse(rawFinal, {
      backend: 'codex-cli',
      stage,
      errorCode: 'E_CODEX_CLI_SCHEMA',
    });
    return { ok: true, reason: 'schema_valid' };
  } catch (err) {
    return { ok: false, reason: err?.code === 'ENOENT' ? 'missing_last_message' : 'schema_invalid_last_message' };
  }
}

function validateStage(stage) {
  if (stage !== 'user_input' && stage !== 'turn_end') {
    throw new TypeError('codex-cli auditor stage must be user_input or turn_end');
  }
  return stage;
}
