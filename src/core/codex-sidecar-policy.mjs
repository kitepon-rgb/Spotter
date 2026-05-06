const HOST_AGENTS = new Set(['claude', 'codex', 'automation', 'unknown']);
const AVAILABILITY_STATES = new Set([
  'unavailable',
  'configured',
  'operational',
  'work-capable',
  'explicitly disabled',
]);
const READ_ONLY_WORKFLOWS = new Set([
  'risk-check',
  'review',
  'explore',
  'opinion',
  'codex_risk_check',
  'codex_review',
  'codex_explore',
  'codex_opinion',
]);

export function workCapabilitySmokeFromDiagnostics(diagnostics) {
  const request = diagnostics?.normalizedRequest;
  const allowedPaths = request?.allowedPaths;
  if (
    diagnostics?.status === 'ok' &&
    request?.workflow === 'work' &&
    request?.readonly === false &&
    request?.requireWorktree === true &&
    Array.isArray(allowedPaths) &&
    allowedPaths.length > 0
  ) {
    return {
      status: 'ok',
      worktree: true,
      reason: 'work_preset_requires_worktree_with_allowed_paths',
    };
  }
  return {
    status: 'failed',
    worktree: false,
    reason: 'work_preset_not_work_capable',
  };
}

export function detectHostAgent({ explicitHostAgent = null, env = process.env } = {}) {
  if (explicitHostAgent !== null && explicitHostAgent !== undefined) {
    assertHostAgent(explicitHostAgent);
    return explicitHostAgent;
  }
  if (env?.CLAUDECODE === '1' || env?.CLAUDE_CODE === '1') return 'claude';
  if (env?.CODEX_SESSION_ID || env?.CODEX_SANDBOX) return 'codex';
  if (env?.CI === 'true' || env?.GITHUB_ACTIONS === 'true') return 'automation';
  return 'unknown';
}

export function buildDiagnosticsCommand({ projectRoot, preset = 'review' }) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new TypeError('buildDiagnosticsCommand: projectRoot must be a non-empty string');
  }
  if (typeof preset !== 'string' || preset.length === 0) {
    throw new TypeError('buildDiagnosticsCommand: preset must be a non-empty string');
  }
  return ['codex-sidecar', 'diagnostics', '--project', projectRoot, '--preset', preset, '--json'];
}

export function classifySidecarAvailability({
  disabled = false,
  diagnostics = null,
  smoke = null,
} = {}) {
  if (disabled === true) {
    return {
      state: 'explicitly disabled',
      reason: 'codex_sidecar_explicitly_disabled',
      diagnostics,
      smoke,
    };
  }
  if (!diagnostics || typeof diagnostics !== 'object' || diagnostics.status !== 'ok') {
    return {
      state: 'unavailable',
      reason: diagnostics?.reason ?? diagnostics?.error?.code ?? 'diagnostics_not_ok',
      diagnostics,
      smoke,
    };
  }
  if (smoke?.status === 'ok' && smoke?.worktree === true) {
    return {
      state: 'work-capable',
      reason: 'worktree_smoke_ok',
      diagnostics,
      smoke,
    };
  }
  if (smoke?.status === 'ok') {
    return {
      state: 'operational',
      reason: 'read_only_smoke_ok',
      diagnostics,
      smoke,
    };
  }
  return {
    state: 'configured',
    reason: 'diagnostics_ok',
    diagnostics,
    smoke,
  };
}

export function decideCodexSidecarUse({
  hostAgent,
  availability,
  workflow,
  explicitSecondPass = false,
  requiresIsolation = false,
  requiresStructuredResult = false,
  requiresWorktree = false,
} = {}) {
  assertHostAgent(hostAgent);
  assertAvailability(availability);
  if (typeof workflow !== 'string' || workflow.length === 0) {
    throw new TypeError('decideCodexSidecarUse: workflow must be a non-empty string');
  }

  if (availability === 'explicitly disabled') {
    return { useSidecar: false, mode: 'compatibility', reason: 'codex_sidecar_explicitly_disabled' };
  }
  if (availability === 'unavailable') {
    return { useSidecar: false, mode: 'compatibility', reason: 'codex_sidecar_unavailable' };
  }
  if (requiresWorktree && availability !== 'work-capable') {
    return { useSidecar: false, mode: 'compatibility', reason: 'codex_sidecar_not_work_capable' };
  }
  if (!requiresWorktree && availability === 'configured' && !READ_ONLY_WORKFLOWS.has(workflow)) {
    return { useSidecar: false, mode: 'compatibility', reason: 'codex_sidecar_not_operational_for_workflow' };
  }
  if (hostAgent === 'claude') {
    return { useSidecar: true, mode: 'sidecar', reason: 'claude_host_independent_second_pass' };
  }
  if (hostAgent === 'codex') {
    const hasBoundary = explicitSecondPass || requiresIsolation || requiresStructuredResult || requiresWorktree;
    if (!hasBoundary) {
      return { useSidecar: false, mode: 'direct', reason: 'codex_host_without_independent_boundary' };
    }
    return { useSidecar: true, mode: 'sidecar', reason: 'codex_host_with_explicit_boundary' };
  }
  if (hostAgent === 'automation') {
    return { useSidecar: false, mode: 'compatibility', reason: 'automation_requires_explicit_config' };
  }
  return { useSidecar: false, mode: 'compatibility', reason: 'unknown_host_requires_explicit_config' };
}

export function buildSidecarSpawnOptions({
  projectRoot,
  env = process.env,
  marker = 'codex-sidecar',
} = {}) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new TypeError('buildSidecarSpawnOptions: projectRoot must be a non-empty string');
  }
  if (typeof marker !== 'string' || marker.length === 0) {
    throw new TypeError('buildSidecarSpawnOptions: marker must be a non-empty string');
  }
  return {
    cwd: projectRoot,
    env: {
      ...env,
      SPOTTER_PARENT_PID: env?.SPOTTER_PARENT_PID || `${marker}:${process.pid}`,
      SPOTTER_SIDECAR: '1',
    },
  };
}

function assertHostAgent(hostAgent) {
  if (!HOST_AGENTS.has(hostAgent)) {
    throw new TypeError(`hostAgent must be one of: ${Array.from(HOST_AGENTS).join(', ')}`);
  }
}

function assertAvailability(availability) {
  if (!AVAILABILITY_STATES.has(availability)) {
    throw new TypeError(`availability must be one of: ${Array.from(AVAILABILITY_STATES).join(', ')}`);
  }
}
