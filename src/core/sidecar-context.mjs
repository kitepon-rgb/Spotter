const SIDECAR_CONTEXT_SCHEMA_VERSION = 'spotter.sidecar_context.v1';
const SIDECAR_RESULT_SCHEMA_VERSION = 'spotter.sidecar_result.v1';
const DEFAULT_CONTEXT_KIND = 'manual_note';
const DEFAULT_CONTEXT_SOURCE = 'spotter';
const DEFAULT_CONTEXT_TRUST = 'local';
const STABLE_TOOL_MISS_KIND = 'spotter.tool_miss';

export function spotterFindingsToSidecarContextBlocks(findings) {
  if (!Array.isArray(findings)) {
    throw new TypeError('spotterFindingsToSidecarContextBlocks: findings must be an array');
  }
  return findings.map((finding) => spotterFindingToSidecarContextBlock(finding));
}

export function spotterFindingToSidecarContextBlock(finding) {
  assertFinding(finding);

  const data = {
    schemaVersion: SIDECAR_CONTEXT_SCHEMA_VERSION,
    findingId: finding.id,
    findingKind: stableFindingKind(finding),
    stage: finding.stage,
    toolName: finding.toolName,
    category: finding.category ?? 'unknown',
    severity: finding.severity ?? 'unknown',
    confidence: finding.confidence ?? 'unknown',
    source: finding.source ?? 'spotter',
  };
  if (typeof finding.ruleId === 'string' && finding.ruleId.length > 0 && finding.category !== 'tool_miss') {
    data.ruleId = finding.ruleId;
  }

  return {
    kind: DEFAULT_CONTEXT_KIND,
    source: DEFAULT_CONTEXT_SOURCE,
    trust: DEFAULT_CONTEXT_TRUST,
    summary: `Spotter ${finding.stage}: ${finding.toolName} - ${finding.reason}`,
    references: normalizeReferences(finding.references),
    data,
  };
}

export function createSidecarResultRecord({
  workflow,
  status,
  contextBlocks,
  result = null,
  error = null,
  meta = {},
}) {
  if (typeof workflow !== 'string' || workflow.length === 0) {
    throw new TypeError('createSidecarResultRecord: workflow must be a non-empty string');
  }
  if (!['success', 'error', 'skipped'].includes(status)) {
    throw new TypeError('createSidecarResultRecord: status must be success, error, or skipped');
  }
  if (!Array.isArray(contextBlocks)) {
    throw new TypeError('createSidecarResultRecord: contextBlocks must be an array');
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    throw new TypeError('createSidecarResultRecord: meta must be an object');
  }

  return {
    schemaVersion: SIDECAR_RESULT_SCHEMA_VERSION,
    workflow,
    status,
    contextBlocks,
    result,
    error,
    meta,
  };
}

function assertFinding(finding) {
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
    throw new TypeError('spotterFindingToSidecarContextBlock: finding must be an object');
  }
  for (const key of ['id', 'stage', 'toolName', 'reason']) {
    if (typeof finding[key] !== 'string' || finding[key].length === 0) {
      throw new TypeError(`spotterFindingToSidecarContextBlock: finding.${key} must be a non-empty string`);
    }
  }
}

function stableFindingKind(finding) {
  if (finding.category === 'tool_miss' || finding.category === undefined || finding.category === null) {
    return STABLE_TOOL_MISS_KIND;
  }
  return `spotter.${finding.category}`;
}

function normalizeReferences(references) {
  if (references === undefined || references === null) return [];
  if (!Array.isArray(references)) {
    throw new TypeError('spotterFindingToSidecarContextBlock: finding.references must be an array if present');
  }
  return references.map((ref, index) => {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) {
      throw new TypeError(`spotterFindingToSidecarContextBlock: reference ${index} must be an object`);
    }
    if (typeof ref.path !== 'string' || ref.path.length === 0) {
      throw new TypeError(`spotterFindingToSidecarContextBlock: reference ${index}.path must be a non-empty string`);
    }
    const out = { path: ref.path };
    if (ref.line !== undefined && ref.line !== null) {
      if (!Number.isInteger(ref.line) || ref.line <= 0) {
        throw new TypeError(`spotterFindingToSidecarContextBlock: reference ${index}.line must be a positive integer`);
      }
      out.line = ref.line;
    }
    if (typeof ref.label === 'string' && ref.label.length > 0) {
      out.label = ref.label;
    }
    return out;
  });
}
