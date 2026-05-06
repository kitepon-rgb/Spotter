import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function isCodexRiskDispatchEnabled(env = process.env) {
  const value = env?.SPOTTER_CODEX_RISK_CHECK;
  return value === '1' || value === 'true' || value === 'yes';
}

export function isCodexRiskDispatchDryRun(env = process.env) {
  const value = env?.SPOTTER_CODEX_RISK_CHECK_DRY_RUN;
  return value === '1' || value === 'true' || value === 'yes';
}

export async function dispatchCodexRiskCheck({
  projectRoot,
  judgment,
  sessionId,
  stage,
  hostAgent = 'claude',
  dryRun = false,
  now = () => new Date(),
  spawnFn = spawn,
  env = process.env,
} = {}) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new TypeError('dispatchCodexRiskCheck: projectRoot must be a non-empty string');
  }
  if (!judgment || typeof judgment !== 'object' || !Array.isArray(judgment.findings)) {
    throw new TypeError('dispatchCodexRiskCheck: judgment.findings must be an array');
  }
  if (judgment.pass === true || judgment.findings.length === 0) {
    return { dispatched: false, reason: 'no_findings' };
  }

  const stamp = now().toISOString().replace(/[:.]/g, '-');
  const safeSession = sanitizePart(sessionId ?? 'unknown-session');
  const safeStage = sanitizePart(stage ?? judgment.meta?.stage ?? 'unknown-stage');
  const baseName = `${stamp}-${safeSession}-${safeStage}`;
  const findingsPath = join(projectRoot, '.spotter', 'sidecar-inputs', `${baseName}-findings.json`);
  const resultPath = join(projectRoot, '.spotter', 'sidecar-results', `${baseName}-codex-risk-check.json`);

  await mkdir(dirname(findingsPath), { recursive: true });
  await mkdir(dirname(resultPath), { recursive: true });
  await writeFile(findingsPath, JSON.stringify({ judgment }, null, 2) + '\n', 'utf8');

  const args = [
    resolveSpotterBin(),
    'codex',
    'risk-check',
    '--findings',
    findingsPath,
    '--project',
    projectRoot,
    '--host-agent',
    hostAgent,
    '--out',
    resultPath,
  ];
  if (dryRun) args.push('--dry-run');

  const child = spawnFn(process.execPath, args, {
    cwd: projectRoot,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...env,
      SPOTTER_PARENT_PID: env?.SPOTTER_PARENT_PID || `codex-risk-dispatch:${process.pid}`,
      SPOTTER_SIDECAR: '1',
    },
  });
  child.on?.('error', () => {});
  child.unref?.();

  return {
    dispatched: true,
    findingsPath,
    resultPath,
    pid: child.pid ?? null,
    dryRun,
  };
}

function resolveSpotterBin() {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', 'bin', 'spotter.mjs');
}

function sanitizePart(value) {
  return String(value).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80) || 'unknown';
}
