import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import {
  buildCodexSidecarCommand,
  buildDiagnosticsCommand,
  buildSidecarSpawnOptions,
  classifySidecarAvailability,
  decideCodexSidecarUse,
  detectHostAgent,
  workCapabilitySmokeFromDiagnostics,
} from './codex-sidecar-policy.mjs';
import {
  createSidecarResultRecord,
  spotterFindingsToSidecarContextBlocks,
} from './sidecar-context.mjs';
import { buildWindowsCompatibleInvocation } from './windows-cli-shim.mjs';

const execFileP = promisify(execFile);
const WORKFLOW_MAP = {
  codex_risk_check: { sidecarWorkflow: 'risk-check', preset: 'risk-check', fileSuffix: 'codex-risk-check' },
  codex_review: { sidecarWorkflow: 'review', preset: 'review', fileSuffix: 'codex-review' },
  codex_explore: { sidecarWorkflow: 'explore', preset: 'explore', fileSuffix: 'codex-explore' },
  codex_opinion: { sidecarWorkflow: 'opinion', preset: 'opinion', fileSuffix: 'codex-opinion' },
  codex_work: { sidecarWorkflow: 'work', preset: 'work', fileSuffix: 'codex-work' },
};

export async function runCodexReadOnlyWorkflow({
  workflow,
  projectRoot,
  findings,
  hostAgent = null,
  dryRun = false,
  turnTimeoutMs = null,
  save = true,
  outPath = null,
  execFileFn = execFileP,
  buildInvocationFn = buildWindowsCompatibleInvocation,
  gitStatusFn = execFileP,
  env = process.env,
  now = () => new Date(),
} = {}) {
  const workflowSpec = workflowSpecFor(workflow);
  if (workflow === 'codex_work') {
    throw new TypeError('runCodexReadOnlyWorkflow: codex_work requires runCodexWork');
  }
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new TypeError('runCodexReadOnlyWorkflow: projectRoot must be a non-empty string');
  }
  if (!Array.isArray(findings)) {
    throw new TypeError('runCodexReadOnlyWorkflow: findings must be an array');
  }

  const effectiveHostAgent = detectHostAgent({ explicitHostAgent: hostAgent, env });
  const contextBlocks = spotterFindingsToSidecarContextBlocks(findings);
  const spawnOptions = buildSidecarSpawnOptions({ projectRoot, env });
  spawnOptions.buildInvocationFn = buildInvocationFn;
  const diagnostics = await runDiagnostics({ projectRoot, preset: workflowSpec.preset, execFileFn, spawnOptions });
  const availability = classifySidecarAvailability({ diagnostics });
  const decision = decideCodexSidecarUse({
    hostAgent: effectiveHostAgent,
    availability: availability.state,
    workflow,
    explicitSecondPass: true,
    requiresStructuredResult: true,
  });

  let record;
  if (!decision.useSidecar) {
    record = createSidecarResultRecord({
      workflow,
      status: 'skipped',
      contextBlocks,
      error: {
        code: decision.reason,
        message: `codex-sidecar not invoked: ${decision.reason}`,
      },
      meta: baseMeta({ projectRoot, hostAgent: effectiveHostAgent, availability, decision, diagnostics }),
    });
  } else {
    record = await invokeReadOnlyWorkflow({
      workflow,
      workflowSpec,
      projectRoot,
      contextBlocks,
      dryRun,
      turnTimeoutMs,
      execFileFn,
      spawnOptions,
      meta: baseMeta({ projectRoot, hostAgent: effectiveHostAgent, availability, decision, diagnostics }),
    });
  }

  if (save || outPath) {
    const resultPath = outPath ?? defaultResultPath({ projectRoot, now, workflowSpec });
    await mkdir(dirname(resultPath), { recursive: true });
    record.meta = { ...record.meta, resultPath };
    await writeFile(resultPath, JSON.stringify(record, null, 2) + '\n', 'utf8');
  }

  return record;
}

export async function runCodexRiskCheck(options = {}) {
  return runCodexReadOnlyWorkflow({ ...options, workflow: 'codex_risk_check' });
}

export async function runCodexReview(options = {}) {
  return runCodexReadOnlyWorkflow({ ...options, workflow: 'codex_review' });
}

export async function runCodexExplore(options = {}) {
  return runCodexReadOnlyWorkflow({ ...options, workflow: 'codex_explore' });
}

export async function runCodexOpinion(options = {}) {
  return runCodexReadOnlyWorkflow({ ...options, workflow: 'codex_opinion' });
}

export async function runCodexWork({
  projectRoot,
  findings,
  instruction,
  hostAgent = null,
  approved = false,
  allowedPaths = [],
  cleanup = null,
  dryRun = false,
  turnTimeoutMs = null,
  save = true,
  outPath = null,
  execFileFn = execFileP,
  buildInvocationFn = buildWindowsCompatibleInvocation,
  gitStatusFn = execFileP,
  env = process.env,
  now = () => new Date(),
} = {}) {
  const workflow = 'codex_work';
  const workflowSpec = workflowSpecFor(workflow);
  if (approved !== true) {
    throw Object.assign(new Error('runCodexWork: explicit approval is required'), { code: 'E_CODEX_WORK_APPROVAL_REQUIRED' });
  }
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new TypeError('runCodexWork: projectRoot must be a non-empty string');
  }
  if (!Array.isArray(findings)) {
    throw new TypeError('runCodexWork: findings must be an array');
  }
  if (typeof instruction !== 'string' || instruction.trim().length === 0) {
    throw new TypeError('runCodexWork: instruction must be a non-empty string');
  }
  const normalizedAllowedPaths = normalizeApprovedPaths(allowedPaths);
  if (!['preserve', 'remove'].includes(cleanup)) {
    throw new TypeError('runCodexWork: cleanup must be "preserve" or "remove"');
  }

  const effectiveHostAgent = detectHostAgent({ explicitHostAgent: hostAgent, env });
  const contextBlocks = [
    ...spotterFindingsToSidecarContextBlocks(findings),
    createWorkApprovalContextBlock({ instruction, allowedPaths: normalizedAllowedPaths, cleanup }),
  ];
  const dirtyScope = await inspectApprovedScope({
    projectRoot,
    allowedPaths: normalizedAllowedPaths,
    gitStatusFn,
  });
  const spawnOptions = buildSidecarSpawnOptions({ projectRoot, env, marker: 'codex-work' });
  spawnOptions.buildInvocationFn = buildInvocationFn;
  const diagnostics = dirtyScope.ok
    ? await runDiagnostics({ projectRoot, preset: workflowSpec.preset, execFileFn, spawnOptions })
    : null;
  const smoke = workCapabilitySmokeFromDiagnostics(diagnostics);
  const availability = classifySidecarAvailability({ diagnostics, smoke });
  const decision = decideCodexSidecarUse({
    hostAgent: effectiveHostAgent,
    availability: availability.state,
    workflow,
    explicitSecondPass: true,
    requiresIsolation: true,
    requiresStructuredResult: true,
    requiresWorktree: true,
  });

  let record;
  if (!dirtyScope.ok) {
    record = createSidecarResultRecord({
      workflow,
      status: 'error',
      contextBlocks,
      error: {
        code: dirtyScope.code,
        message: dirtyScope.message,
      },
      meta: {
        ...baseMeta({ projectRoot, hostAgent: effectiveHostAgent, availability, decision, diagnostics }),
        workApproval: { allowedPaths: normalizedAllowedPaths, cleanup },
        dirtyScope,
      },
    });
  } else if (!decision.useSidecar) {
    record = createSidecarResultRecord({
      workflow,
      status: 'skipped',
      contextBlocks,
      error: {
        code: decision.reason,
        message: `codex-sidecar work not invoked: ${decision.reason}`,
      },
      meta: {
        ...baseMeta({ projectRoot, hostAgent: effectiveHostAgent, availability, decision, diagnostics }),
        workApproval: { allowedPaths: normalizedAllowedPaths, cleanup },
      },
    });
  } else {
    record = await invokeWorkWorkflow({
      workflow,
      workflowSpec,
      projectRoot,
      contextBlocks,
      instruction,
      allowedPaths: normalizedAllowedPaths,
      cleanup,
      dryRun,
      turnTimeoutMs,
      execFileFn,
      spawnOptions,
      meta: {
        ...baseMeta({ projectRoot, hostAgent: effectiveHostAgent, availability, decision, diagnostics }),
        workApproval: { allowedPaths: normalizedAllowedPaths, cleanup },
      },
    });
  }

  if (save || outPath) {
    const resultPath = outPath ?? defaultResultPath({ projectRoot, now, workflowSpec });
    await mkdir(dirname(resultPath), { recursive: true });
    record.meta = { ...record.meta, resultPath };
    await writeFile(resultPath, JSON.stringify(record, null, 2) + '\n', 'utf8');
  }

  return record;
}

export async function readFindingsJson(path) {
  if (typeof path !== 'string' || path.length === 0) {
    throw new TypeError('readFindingsJson: path must be a non-empty string');
  }
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.findings)) return parsed.findings;
  if (Array.isArray(parsed?.judgment?.findings)) return parsed.judgment.findings;
  if (typeof parsed?.stage === 'string' && Array.isArray(parsed?.toolIds)) {
    return parsed.toolIds.map((toolName, index) => ({
      id: `spotter.${parsed.stage}.${index + 1}`,
      stage: parsed.stage,
      toolName,
      reason: 'Spotter verified a tool candidate for independent risk review',
      category: 'tool_miss',
      severity: 'unknown',
      confidence: 'unknown',
      references: [],
      source: 'spotter',
    }));
  }
  throw new TypeError('readFindingsJson: JSON must be an array, {findings}, {judgment:{findings}}, or safe {stage,toolIds}');
}

async function runDiagnostics({ projectRoot, preset, execFileFn, spawnOptions }) {
  const [cmd, ...args] = buildDiagnosticsCommand({ projectRoot, preset, env: spawnOptions.env });
  const result = await runJsonCommand({
    cmd,
    args,
    execFileFn,
    spawnOptions,
    allowFailure: true,
  });
  if (result.ok) return result.value;
  return {
    status: 'failed',
    reason: result.error.code,
    error: {
      code: result.error.code,
      message: result.error.message,
    },
  };
}

async function invokeReadOnlyWorkflow({
  workflow,
  workflowSpec,
  projectRoot,
  contextBlocks,
  dryRun,
  turnTimeoutMs,
  execFileFn,
  spawnOptions,
  meta,
}) {
  const tempDir = await mkdtemp(join(tmpdir(), 'spotter-sidecar-context-'));
  const contextPath = join(tempDir, 'context.json');
  try {
    await writeFile(contextPath, JSON.stringify({ context: contextBlocks }, null, 2) + '\n', 'utf8');
    const args = [
      workflowSpec.sidecarWorkflow,
      '--project',
      projectRoot,
      '--preset',
      workflowSpec.preset,
      '--context-file',
      contextPath,
      '--json',
    ];
    if (dryRun) args.push('--dry-run');
    if (turnTimeoutMs !== null && turnTimeoutMs !== undefined) {
      args.push('--turn-timeout-ms', String(turnTimeoutMs));
    }
    args.push(buildWorkflowPrompt(workflow, contextBlocks));

    const command = buildCodexSidecarCommand({ args, env: spawnOptions.env });
    const result = await runJsonCommand({
      cmd: command.cmd,
      args: command.args,
      execFileFn,
      spawnOptions,
      allowFailure: true,
    });
    const commandMeta = ['codex-sidecar', ...argsForMeta(args, contextPath)];
    if (result.ok && result.value?.status !== 'failed' && result.value?.status !== 'refused') {
      return createSidecarResultRecord({
        workflow,
        status: 'success',
        contextBlocks,
        result: result.value,
        meta: {
          ...meta,
          sidecarWorkflow: workflowSpec.sidecarWorkflow,
          sidecarCommand: commandMeta,
        },
      });
    }
    return createSidecarResultRecord({
      workflow,
      status: 'error',
      contextBlocks,
      result: result.ok ? result.value : null,
      error: result.ok
        ? { code: result.value?.status ?? 'sidecar_error', message: result.value?.error?.message ?? 'codex-sidecar returned an error status' }
        : result.error,
      meta: {
        ...meta,
        sidecarWorkflow: workflowSpec.sidecarWorkflow,
        sidecarCommand: commandMeta,
      },
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function invokeWorkWorkflow({
  workflow,
  workflowSpec,
  projectRoot,
  contextBlocks,
  instruction,
  allowedPaths,
  cleanup,
  dryRun,
  turnTimeoutMs,
  execFileFn,
  spawnOptions,
  meta,
}) {
  await mkdir(join(projectRoot, '.spotter'), { recursive: true });
  const tempDir = await mkdtemp(join(projectRoot, '.spotter', 'sidecar-work-'));
  const contextPath = join(tempDir, 'context.json');
  const configPath = join(tempDir, '.codex-sidecar.yml');
  const configArg = relative(projectRoot, configPath);
  try {
    await writeFile(contextPath, JSON.stringify({ context: contextBlocks }, null, 2) + '\n', 'utf8');
    await writeFile(configPath, await buildScopedWorkConfig({ projectRoot, allowedPaths }), 'utf8');
    const args = [
      workflowSpec.sidecarWorkflow,
      '--project',
      projectRoot,
      '--config',
      configArg,
      '--preset',
      workflowSpec.preset,
      '--context-file',
      contextPath,
      '--json',
    ];
    if (dryRun) args.push('--dry-run');
    if (turnTimeoutMs !== null && turnTimeoutMs !== undefined) {
      args.push('--turn-timeout-ms', String(turnTimeoutMs));
    }
    if (cleanup === 'remove') args.push('--remove-worktree');
    args.push(buildWorkPrompt({ instruction, allowedPaths, cleanup, contextBlocks }));

    const command = buildCodexSidecarCommand({ args, env: spawnOptions.env });
    const result = await runJsonCommand({
      cmd: command.cmd,
      args: command.args,
      execFileFn,
      spawnOptions,
      allowFailure: true,
    });
    const commandMeta = ['codex-sidecar', ...argsForMeta(args, contextPath).map((arg) => (arg === configArg ? '<scoped-config>' : arg))];
    if (result.ok && result.value?.status !== 'failed' && result.value?.status !== 'refused') {
      const scopeError = changedFilesScopeError(result.value?.changedFiles, allowedPaths);
      if (scopeError) {
        return createSidecarResultRecord({
          workflow,
          status: 'error',
          contextBlocks,
          result: result.value,
          error: scopeError,
          meta: {
            ...meta,
            sidecarWorkflow: workflowSpec.sidecarWorkflow,
            sidecarCommand: commandMeta,
          },
        });
      }
      return createSidecarResultRecord({
        workflow,
        status: 'success',
        contextBlocks,
        result: result.value,
        meta: {
          ...meta,
          sidecarWorkflow: workflowSpec.sidecarWorkflow,
          sidecarCommand: commandMeta,
        },
      });
    }
    return createSidecarResultRecord({
      workflow,
      status: 'error',
      contextBlocks,
      result: result.ok ? result.value : null,
      error: result.ok
        ? { code: result.value?.status ?? 'sidecar_error', message: result.value?.error?.message ?? 'codex-sidecar returned an error status' }
        : result.error,
      meta: {
        ...meta,
        sidecarWorkflow: workflowSpec.sidecarWorkflow,
        sidecarCommand: commandMeta,
      },
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function runJsonCommand({ cmd, args, execFileFn, spawnOptions, allowFailure = false }) {
  try {
    const { stdout } = await execPortable(execFileFn, cmd, args, spawnOptions);
    return { ok: true, value: parseJsonOutput(stdout) };
  } catch (err) {
    const stdout = typeof err?.stdout === 'string' ? err.stdout : '';
    if (stdout.trim().length > 0) {
      try {
        return { ok: true, value: parseJsonOutput(stdout) };
      } catch {
        // fall through to command error
      }
    }
    const error = {
      code: err?.code ? `exit_${err.code}` : 'exec_error',
      message: err?.message ?? String(err),
    };
    if (allowFailure) return { ok: false, error };
    throw Object.assign(new Error(error.message), { code: error.code });
  }
}

function execPortable(execFileFn, cmd, args, spawnOptions) {
  const options = {
    cwd: spawnOptions.cwd,
    env: spawnOptions.env,
    timeout: 600_000,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  };
  const invocation = spawnOptions.buildInvocationFn({
    command: cmd,
    args,
    env: spawnOptions.env,
    allowCmdFallback: false,
  });
  return execFileFn(invocation.command, invocation.args, options);
}

function parseJsonOutput(stdout) {
  try {
    return JSON.parse(stdout);
  } catch (cause) {
    const err = new Error(`codex-sidecar output is not valid JSON: ${cause.message}`);
    err.cause = cause;
    throw err;
  }
}

function buildWorkflowPrompt(workflow, contextBlocks) {
  const common = [
    `Finding context blocks: ${contextBlocks.length}.`,
    'Return structured JSON only through codex-sidecar.',
  ];
  if (workflow === 'codex_review') {
    return [
      'Review the current Spotter repository state using the provided Spotter findings as context.',
      'Focus on regressions in Claude hook behavior, daemon lifecycle, tool-db isolation, and missing tests.',
      ...common,
    ].join(' ');
  }
  if (workflow === 'codex_explore') {
    return [
      'Explore why the provided Spotter findings matter.',
      'Return concrete code references, affected paths, and evidence boundaries.',
      ...common,
    ].join(' ');
  }
  if (workflow === 'codex_opinion') {
    return [
      'Challenge the proposed Spotter remediation plan implied by these findings.',
      'Identify failure modes, objections, and safer next actions.',
      ...common,
    ].join(' ');
  }
  return [
    'Analyze the Spotter findings in the provided context blocks.',
    'Focus on daemon proliferation, recursive hook execution, latency, compatibility, and false-positive risks.',
    riskSchemaHint(),
    ...common,
  ].join(' ');
}

function buildWorkPrompt({ instruction, allowedPaths, cleanup, contextBlocks }) {
  return [
    'Implement the approved Spotter change in an isolated worktree.',
    `Instruction: ${instruction.trim()}`,
    `Approved write scope: ${allowedPaths.join(', ')}.`,
    `Cleanup policy requested by Spotter: ${cleanup}.`,
    `Finding context blocks: ${contextBlocks.length}.`,
    riskSchemaHint(),
    'Return structured JSON with changedFiles, tests or verification, diagnostics, and residual risks.',
  ].join(' ');
}

function riskSchemaHint() {
  return [
    'When returning risks, each risk must use affectedFiles as Array<{path:string,line?:number,label?:string}> objects,',
    'confidence as {level:"high"|"medium"|"low"|"unknown",rationale?:string},',
    'and basis as "observed", "inferred", or "hypothetical".',
  ].join(' ');
}

async function buildScopedWorkConfig({ projectRoot, allowedPaths }) {
  await readFile(join(projectRoot, '.codex-sidecar.yml'), 'utf8');
  return [
    'project: spotter-scoped-work',
    '',
    'defaults:',
    '  readonly: true',
    '  result_format: json',
    '',
    'safety_profile: claude-hook-package',
    '',
    'allowed_paths:',
    ...allowedPaths.map((path) => `  - ${quoteYamlString(path)}`),
    '',
    'deny_paths:',
    '  - .env',
    '  - .env.*',
    '  - "**/*.key"',
    '  - "**/*.pem"',
    '  - ".spotter/"',
    '  - ".claude/"',
    '  - ".codegraph/"',
    '',
    'presets:',
    '  work:',
    '    workflow: work',
    '    readonly: false',
    '    require_worktree: true',
    '    prompt: "Implement the approved Spotter scoped change and return changed files, tests, diagnostics, and residual risks."',
    '',
  ].join('\n');
}

function quoteYamlString(value) {
  return JSON.stringify(value);
}

function createWorkApprovalContextBlock({ instruction, allowedPaths, cleanup }) {
  return {
    kind: 'manual_note',
    source: 'spotter',
    trust: 'local',
    summary: `Spotter approved codex_work: ${instruction.trim()}`,
    references: [],
    data: {
      schemaVersion: 'spotter.codex_work_approval.v1',
      approved: true,
      allowedPaths,
      cleanup,
    },
  };
}

async function inspectApprovedScope({ projectRoot, allowedPaths, gitStatusFn }) {
  try {
    const { stdout } = await gitStatusFn('git', ['status', '--porcelain=v1', '--', ...allowedPaths], {
      cwd: projectRoot,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    const entries = parseGitPorcelain(stdout);
    if (entries.length === 0) {
      return { ok: true, entries: [] };
    }
    return {
      ok: false,
      code: 'codex_work_dirty_approved_scope',
      message: `codex_work requires approved paths to be clean before creating an isolated worktree: ${entries.map((entry) => entry.path).join(', ')}`,
      entries,
    };
  } catch (err) {
    return {
      ok: false,
      code: 'codex_work_git_status_failed',
      message: `codex_work could not verify approved path cleanliness: ${err?.message ?? String(err)}`,
      entries: [],
    };
  }
}

function parseGitPorcelain(stdout) {
  if (typeof stdout !== 'string' || stdout.trim().length === 0) return [];
  return stdout.split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const status = line.slice(0, 2);
      const rawPath = line.slice(3);
      const renameMarker = ' -> ';
      const markerIndex = rawPath.indexOf(renameMarker);
      return {
        status,
        path: markerIndex === -1 ? rawPath : rawPath.slice(markerIndex + renameMarker.length),
      };
    });
}

function normalizeApprovedPaths(allowedPaths) {
  if (!Array.isArray(allowedPaths)) {
    throw new TypeError('runCodexWork: allowedPaths must be an array');
  }
  const normalized = allowedPaths.map((path) => normalizeProjectPattern(path));
  if (normalized.length === 0) {
    throw new TypeError('runCodexWork: at least one allowed path is required');
  }
  return [...new Set(normalized)];
}

function normalizeProjectPattern(pattern) {
  if (typeof pattern !== 'string' || pattern.trim().length === 0) {
    throw new TypeError('runCodexWork: allowed paths must be non-empty strings');
  }
  const normalized = pattern.trim().replaceAll('\\', '/').replace(/^\.\/+/, '');
  if (normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) {
    throw new TypeError(`runCodexWork: allowed path must be project-relative: ${pattern}`);
  }
  return normalized;
}

function changedFilesScopeError(changedFiles, allowedPaths) {
  if (changedFiles === undefined || changedFiles === null) return null;
  if (!Array.isArray(changedFiles)) {
    return {
      code: 'codex_work_invalid_changed_files',
      message: 'codex-sidecar work result changedFiles must be an array when present',
    };
  }
  const refused = changedFiles
    .filter((file) => typeof file !== 'string' || !isPathApprovedSafe(file, allowedPaths));
  if (refused.length === 0) return null;
  return {
    code: 'codex_work_changed_files_outside_approved_scope',
    message: `codex-sidecar changed files outside approved scope: ${refused.join(', ')}`,
  };
}

function isPathApprovedSafe(file, allowedPaths) {
  try {
    return isPathApproved(file, allowedPaths);
  } catch {
    return false;
  }
}

function isPathApproved(file, allowedPaths) {
  const normalizedFile = normalizeProjectPattern(file);
  return allowedPaths.some((pattern) => matchesApprovedPattern(normalizedFile, pattern));
}

function matchesApprovedPattern(file, pattern) {
  if (pattern.endsWith('/')) return file.startsWith(pattern);
  if (!/[\\*?[{]/.test(pattern)) return file === pattern || file.startsWith(`${pattern}/`);
  const regex = new RegExp(`^${globToRegex(pattern)}$`);
  return regex.test(file);
}

function globToRegex(pattern) {
  let out = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        out += '.*';
        index += 1;
      } else {
        out += '[^/]*';
      }
      continue;
    }
    out += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return out;
}

function baseMeta({ projectRoot, hostAgent, availability, decision, diagnostics }) {
  return {
    projectRoot,
    hostAgent,
    availability,
    decision,
    diagnostics,
  };
}

function defaultResultPath({ projectRoot, now, workflowSpec }) {
  const stamp = now().toISOString().replace(/[:.]/g, '-');
  return join(projectRoot, '.spotter', 'sidecar-results', `${stamp}-${workflowSpec.fileSuffix}.json`);
}

function argsForMeta(args, contextPath) {
  return args.map((arg) => (arg === contextPath ? '<context-file>' : arg));
}

function workflowSpecFor(workflow) {
  const spec = WORKFLOW_MAP[workflow];
  if (!spec) {
    throw new TypeError(`runCodexReadOnlyWorkflow: unsupported workflow ${workflow}`);
  }
  return spec;
}
