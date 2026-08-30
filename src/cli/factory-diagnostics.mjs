import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { codexHookDiagnostics } from './codex-hook-cmd.mjs';
import { inspectAuditorContextConfiguration } from './doctor.mjs';
import { loadDb, localDbPath } from '../tool-db/loader.mjs';
import { version } from '../version.mjs';
import { readRuntimeErrorStoreStatus } from '../core/runtime-error-store.mjs';

const KNOWN_MARKER_VERSIONS = new Set(['1', '2']);
const SAFE_CONTEXT_MODES = new Set(['disabled', 'throughline']);
const SAFE_CODEX_READINESS = new Set([
  'configured-unverified',
  'misconfigured',
  'not-installed',
  'unavailable',
]);

const COMPATIBILITY_PRIORITY = Object.freeze({
  compatible: 0,
  indeterminate: 1,
  incompatible: 2,
});

export async function runFactoryDiagnostics({
  projectRoot = process.cwd(),
  codexHookDiagnosticsFn = codexHookDiagnostics,
  inspectAuditorContextFn = inspectAuditorContextConfiguration,
  readRuntimeErrorStoreStatusFn = readRuntimeErrorStoreStatus,
} = {}) {
  const runtimeErrorStore = await readRuntimeErrorStoreStatusFn();
  const markerResult = await readMarker(join(projectRoot, '.spotter', 'marker.json'));
  if (markerResult.status === 'missing') return inactiveSnapshot(runtimeErrorStore);

  const checks = [];
  if (markerResult.status !== 'valid') {
    checks.push(check('project_activation', 'unverified', markerResult.reasonCode));
    return snapshot({
      overallStatus: 'unverified',
      compatibilityStatus: markerResult.reasonCode === 'marker_unreadable'
        ? 'indeterminate'
        : 'incompatible',
      checks,
      runtimeErrorStore,
    });
  }

  const marker = markerResult.value;
  let compatibilityStatus = 'compatible';
  checks.push(check('project_activation', 'pass'));

  const markerVersion = typeof marker.markerVersion === 'string' && KNOWN_MARKER_VERSIONS.has(marker.markerVersion)
    ? marker.markerVersion
    : null;
  checks.push(markerVersion
    ? check('marker_schema', 'pass')
    : check('marker_schema', 'fail', 'unsupported_marker_schema'));
  if (markerVersion === null) compatibilityStatus = 'incompatible';

  const contextMode = safeContextMode(marker.auditorContext);
  if (contextMode === null) {
    checks.push(check('throughline_context', 'fail', 'invalid_context_configuration'));
    compatibilityStatus = 'incompatible';
  } else if (contextMode === 'disabled') {
    checks.push(check('throughline_context', 'skipped', 'evaluation_evidence_disabled'));
  } else {
    const context = await inspectAuditorContextFn({ projectRoot });
    checks.push(context?.ok === true && context?.mode === 'throughline'
      ? check('throughline_context', 'pass')
      : check('throughline_context', 'unverified', 'context_provider_unavailable'));
  }

  const catalogs = {};
  const catalogInspections = [];
  for (const host of ['claude', 'codex']) {
    const result = await inspectCatalog(localDbPath(projectRoot, host));
    catalogInspections.push(result);
    catalogs[host] = result.publicStatus;
    checks.push(check(`${host}_catalog`, result.checkStatus, result.reasonCode));
    compatibilityStatus = mergeCompatibilityStatus(compatibilityStatus, result.compatibilityStatus);
  }
  const hasAvailableCatalog = Object.values(catalogs).includes('available');
  checks.push(hasAvailableCatalog
    ? check('audit_catalog_readiness', 'pass')
    : Object.values(catalogs).includes('invalid')
      ? check('audit_catalog_readiness', 'fail', 'catalog_invalid_schema')
      : check('audit_catalog_readiness', 'unverified', 'no_host_catalog'));
  if (!hasAvailableCatalog && !catalogInspections.some((result) => result.compatibilityStatus === 'indeterminate')) {
    compatibilityStatus = 'incompatible';
  }

  let codexReadiness = 'unverified';
  try {
    const diagnostics = await codexHookDiagnosticsFn({ projectRoot });
    if (SAFE_CODEX_READINESS.has(diagnostics?.readiness)) codexReadiness = diagnostics.readiness;
  } catch {
    // A safe snapshot still reports that the inspector could not establish readiness.
  }
  checks.push(codexReadiness === 'configured-unverified'
    ? check('codex_hooks', 'unverified', 'trust_not_machine_verifiable')
    : codexReadiness === 'not-installed'
      ? check('codex_hooks', 'skipped', 'not_installed')
      : codexReadiness === 'misconfigured'
        ? check('codex_hooks', 'fail', 'misconfigured')
        : check('codex_hooks', 'unverified', 'diagnostics_unavailable'));
  if (codexReadiness === 'misconfigured') {
    compatibilityStatus = 'incompatible';
  } else if (codexReadiness === 'unavailable' || codexReadiness === 'unverified') {
    compatibilityStatus = mergeCompatibilityStatus(compatibilityStatus, 'indeterminate');
  }

  return snapshot({
    overallStatus: overallStatus(checks),
    compatibilityStatus,
    markerSchemaVersion: markerVersion,
    throughlineContext: contextMode ?? 'unverified',
    catalogs,
    codexHookReadiness: codexReadiness,
    runtimeErrorStore,
    checks,
  });
}

function inactiveSnapshot(runtimeErrorStore) {
  return snapshot({
    overallStatus: 'not_applicable',
    compatibilityStatus: 'not_applicable',
    runtimeErrorStore,
    checks: [check('project_activation', 'skipped', 'project_not_activated')],
  });
}

function snapshot({
  overallStatus,
  compatibilityStatus,
  markerSchemaVersion = null,
  throughlineContext = 'unverified',
  catalogs = { claude: 'not_applicable', codex: 'not_applicable' },
  codexHookReadiness = 'not_applicable',
  runtimeErrorStore,
  checks,
}) {
  return {
    schema_version: '1.1',
    product: 'spotter',
    version,
    overall_status: overallStatus,
    compatibility_status: compatibilityStatus,
    marker_schema_version: markerSchemaVersion,
    throughline_context: throughlineContext,
    catalogs,
    codex_hook_readiness: codexHookReadiness,
    runtime_error_store: runtimeErrorStore,
    checks,
  };
}

async function readMarker(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    return error?.code === 'ENOENT'
      ? { status: 'missing' }
      : { status: 'unverified', reasonCode: 'marker_unreadable' };
  }
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { status: 'unverified', reasonCode: 'marker_invalid_shape' };
    }
    return { status: 'valid', value };
  } catch {
    return { status: 'unverified', reasonCode: 'marker_invalid_json' };
  }
}

async function inspectCatalog(path) {
  try {
    await access(path);
  } catch (error) {
    return error?.code === 'ENOENT'
      ? {
          publicStatus: 'missing',
          checkStatus: 'skipped',
          reasonCode: 'catalog_missing',
          compatibilityStatus: 'compatible',
        }
      : {
          publicStatus: 'unverified',
          checkStatus: 'unverified',
          reasonCode: 'catalog_unreadable',
          compatibilityStatus: 'indeterminate',
        };
  }
  try {
    await loadDb(path);
    return { publicStatus: 'available', checkStatus: 'pass', compatibilityStatus: 'compatible' };
  } catch {
    return {
      publicStatus: 'invalid',
      checkStatus: 'fail',
      reasonCode: 'catalog_invalid_schema',
      compatibilityStatus: 'incompatible',
    };
  }
}

function safeContextMode(config) {
  if (config === undefined) return 'disabled';
  return config && typeof config === 'object' && SAFE_CONTEXT_MODES.has(config.mode)
    ? config.mode
    : null;
}

function check(checkId, status, reasonCode) {
  return reasonCode
    ? { check_id: checkId, status, reason_code: reasonCode }
    : { check_id: checkId, status };
}

function overallStatus(checks) {
  if (checks.some((entry) => entry.status === 'fail')) return 'fail';
  if (checks.some((entry) => entry.status === 'unverified')) return 'unverified';
  return 'pass';
}

function mergeCompatibilityStatus(current, next) {
  return COMPATIBILITY_PRIORITY[next] > COMPATIBILITY_PRIORITY[current] ? next : current;
}

export function factoryDiagnosticsExitCode(snapshotValue) {
  return snapshotValue?.compatibility_status === 'compatible'
    || snapshotValue?.compatibility_status === 'not_applicable'
    ? 0
    : 1;
}
