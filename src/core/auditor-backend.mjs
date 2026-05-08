import {
  buildFinalStagePrompt,
  buildFirstStagePrompt,
  buildPreamble,
  createHaikuCaller,
  HaikuError,
  parseHaikuResponse,
} from '../daemon/haiku-caller.mjs';
import { toSpotterJudgment } from './judgment.mjs';
import { filterCatalogMisses } from './auditor-response.mjs';
import { AuditorBackendError } from './auditor-error.mjs';
import { detectHostAgent } from './host-agent.mjs';
import { createCodexCliAuditorBackend } from './codex-cli-backend.mjs';
import { createCodexSidecarAuditorBackend } from './codex-sidecar-auditor-backend.mjs';

export { AuditorBackendError } from './auditor-error.mjs';
export {
  parseAuditorResponse,
  validateAuditorResponse,
  filterCatalogMisses,
} from './auditor-response.mjs';

const AUDITOR_BACKENDS = new Set(['haiku', 'codex-cli', 'codex-sidecar', 'auto']);
const AUDITOR_POLICIES = new Set(['current', 'next']);
export const DEFAULT_HAIKU_AUDITOR_TIMEOUT_MS = 45_000;

export function createAuditorBackend({
  backend = 'haiku',
  catalog = [],
  projectRoot = null,
  hostAgent = null,
  env = process.env,
  logger = () => {},
  haikuCaller = null,
  timeoutMs = DEFAULT_HAIKU_AUDITOR_TIMEOUT_MS,
} = {}) {
  const selected = backend === 'auto'
    ? selectAuditorBackend({ hostAgent, env, projectConfig: projectRoot ? { projectRoot } : null })
    : { backend, mode: backend, compatibility: backend === 'haiku' ? 'current_haiku' : 'none', reason: 'explicit_backend' };
  if (selected.backend === 'haiku') {
    return createHaikuAuditorBackend({ catalog, logger, haikuCaller, timeoutMs });
  }
  if (selected.backend === 'codex-sidecar') {
    return createCodexSidecarAuditorBackend({
      catalog,
      projectRoot,
      env,
      timeoutMs,
    });
  }
  if (selected.backend === 'codex-cli') {
    return createCodexCliAuditorBackend({
      catalog,
      projectRoot,
      env,
      timeoutMs,
    });
  }
  throw new AuditorBackendError('E_BACKEND_UNKNOWN', `unknown auditor backend: ${selected.backend}`, {
    backend: String(selected.backend),
  });
}

export function createHaikuAuditorBackend({
  catalog = [],
  logger = () => {},
  haikuCaller = null,
  timeoutMs = DEFAULT_HAIKU_AUDITOR_TIMEOUT_MS,
} = {}) {
  if (!Array.isArray(catalog)) {
    throw new TypeError('createHaikuAuditorBackend: catalog must be an array');
  }
  const catalogNames = new Set(catalog.map((t) => t.name));
  const preamble = buildPreamble({ tools: catalog });
  const callHaiku = haikuCaller ?? createHaikuCaller({ preamble, timeoutMs });

  return {
    name: 'haiku',
    reset() {
      if (typeof callHaiku.reset === 'function') callHaiku.reset();
    },
    async judge(input = {}) {
      const stage = validateStage(input.stage);
      const prompt = buildStagePrompt(stage, input);
      let raw, meta;
      try {
        const mode = callHaiku.isFirstCall === false ? 'resumed' : 'first';
        const start = Date.now();
        raw = await callHaiku(prompt);
        meta = { ...(input.meta ?? {}), backend: 'haiku', mode, durationMs: Date.now() - start };
      } catch (err) {
        if (err instanceof HaikuError && typeof callHaiku.reset === 'function') {
          logger(`${stage}: haiku invocation failed (${err.code}), rotating session before rethrow: ${err.message}`);
          callHaiku.reset();
        }
        throw err;
      }

      let parsed;
      try {
        parsed = parseHaikuResponse(raw);
      } catch (err) {
        if (err instanceof HaikuError && err.code === 'E_HAIKU_SCHEMA') {
          logger(`${stage}: role collapse detected, session reset: ${err.message}`);
          if (typeof callHaiku.reset === 'function') callHaiku.reset();
          return toSpotterJudgment({
            stage,
            parsed: { pass: true, missing_tools: [], reason: 'role_collapse_reset' },
            meta,
          });
        }
        throw err;
      }

      const { parsed: filtered, dropped } = filterCatalogMisses(parsed, catalogNames);
      if (dropped.length > 0) {
        logger(`${stage}: dropped catalog-external names: ${dropped.join(',')}`);
      }
      return toSpotterJudgment({ stage, parsed: filtered, meta });
    },
  };
}

export function selectAuditorBackend({
  hostAgent = null,
  env = process.env,
  projectConfig = null,
  stage = 'user_input',
} = {}) {
  const explicit = env?.SPOTTER_AUDITOR_BACKEND;
  const policy = env?.SPOTTER_AUDITOR_BACKEND_POLICY;
  const effectiveHost = hostAgent ?? detectHostAgent({ env });
  validateStage(stage);

  if (explicit !== undefined && explicit !== '') {
    assertAuditorBackend(explicit);
    if (explicit === 'auto') {
      return selectByPolicy({ hostAgent: effectiveHost, policy, projectConfig });
    }
    return {
      backend: explicit,
      mode: explicit,
      compatibility: explicit === 'haiku' ? 'explicit_haiku' : 'none',
      reason: 'explicit_backend',
    };
  }

  return selectByPolicy({ hostAgent: effectiveHost, policy, projectConfig });
}

function selectByPolicy({ hostAgent, policy, projectConfig }) {
  const effectivePolicy = policy || 'current';
  assertAuditorPolicy(effectivePolicy);
  if (effectivePolicy === 'current') {
    if (hostAgent === 'unknown' || hostAgent === 'automation') {
      throw new AuditorBackendError(
        'E_BACKEND_HOST_UNKNOWN',
        `explicit auditor backend required for hostAgent=${hostAgent}`,
        { backend: 'auto', diagnostics: { hostAgent, policy: effectivePolicy, projectConfig } }
      );
    }
    return {
      backend: 'haiku',
      mode: 'compatibility_haiku',
      compatibility: 'current_haiku',
      reason: `policy_current_${hostAgent}`,
    };
  }
  if (hostAgent === 'codex') {
    return {
      backend: 'codex-cli',
      mode: 'codex-cli',
      compatibility: 'none',
      reason: 'policy_next_codex_host',
    };
  }
  if (hostAgent === 'claude') {
    // Phase 5: Claude host opt-in `next` policy promotes the primary auditor backend
    // from Haiku to Codex CLI. Phase 4 matrix smoke (2026-05-06, GeForce 5000 fixture)
    // measured `claude.codex-cli=10041ms` vs `claude.codex-sidecar=12863ms` and Haiku
    // diagnostics averaged `user_input ~14.3s / turn_end ~16.6s`, so Codex CLI wins on
    // latency without giving up schema-fixed JSON judgment. Hidden fallback is
    // forbidden — when codex-cli is unavailable / times out / exits non-zero,
    // `createCodexCliAuditorBackend` throws `AuditorBackendError` and the daemon
    // surfaces the structured error instead of dropping back to Haiku.
    // Haiku stays reachable only via `current` policy or
    // `SPOTTER_AUDITOR_BACKEND=haiku`.
    return {
      backend: 'codex-cli',
      mode: 'codex-cli',
      compatibility: 'none',
      reason: 'policy_next_claude_codex_cli',
    };
  }
  throw new AuditorBackendError(
    'E_BACKEND_HOST_UNKNOWN',
    `explicit auditor backend required for hostAgent=${hostAgent}`,
    { backend: 'auto', diagnostics: { hostAgent, policy: effectivePolicy, projectConfig } }
  );
}

function buildStagePrompt(stage, input) {
  if (stage === 'user_input') {
    if (typeof input.userInput !== 'string') {
      throw new TypeError('haiku auditor user_input requires userInput string');
    }
    return buildFirstStagePrompt({ userInput: input.userInput });
  }
  if (typeof input.finalResponse !== 'string') {
    throw new TypeError('haiku auditor turn_end requires finalResponse string');
  }
  return buildFinalStagePrompt({
    usedTools: Array.isArray(input.usedTools) ? input.usedTools : [],
    finalResponse: input.finalResponse,
  });
}

function validateStage(stage) {
  if (stage !== 'user_input' && stage !== 'turn_end') {
    throw new TypeError('auditor stage must be user_input or turn_end');
  }
  return stage;
}

function assertAuditorBackend(backend) {
  if (!AUDITOR_BACKENDS.has(backend)) {
    throw new AuditorBackendError('E_BACKEND_UNKNOWN', `unknown auditor backend: ${backend}`, {
      backend: String(backend),
    });
  }
}

function assertAuditorPolicy(policy) {
  if (!AUDITOR_POLICIES.has(policy)) {
    throw new AuditorBackendError('E_BACKEND_POLICY_UNKNOWN', `unknown auditor backend policy: ${policy}`, {
      backend: 'auto',
      diagnostics: { policy },
    });
  }
}
