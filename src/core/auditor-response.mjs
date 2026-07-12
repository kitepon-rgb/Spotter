import { AuditorBackendError } from './auditor-error.mjs';

export function parseAuditorResponse(raw, {
  backend = 'auditor',
  stage = 'unknown',
  errorCode = 'E_AUDITOR_SCHEMA',
} = {}) {
  if (typeof raw !== 'string') {
    throw new AuditorBackendError(errorCode, `${backend} output must be a string`, { backend, stage });
  }
  const trimmed = raw.trim();
  const unfenced = stripFence(trimmed);
  let parsed;
  try {
    parsed = JSON.parse(unfenced);
  } catch (err) {
    throw new AuditorBackendError(
      errorCode,
      `${backend} output is not valid JSON`,
      { backend, stage, cause: err }
    );
  }
  validateAuditorResponse(parsed, { backend, stage, errorCode });
  return parsed;
}

export function validateAuditorResponse(parsed, {
  backend = 'auditor',
  stage = 'unknown',
  errorCode = 'E_AUDITOR_SCHEMA',
} = {}) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AuditorBackendError(errorCode, `${backend} output root is not an object`, { backend, stage });
  }
  if (typeof parsed.pass !== 'boolean') {
    throw new AuditorBackendError(errorCode, `${backend} "pass" must be boolean`, { backend, stage });
  }
  if (!Array.isArray(parsed.missing_tools)) {
    throw new AuditorBackendError(errorCode, `${backend} "missing_tools" must be array`, { backend, stage });
  }
  parsed.missing_tools.forEach((m, i) => {
    if (m === null || typeof m !== 'object' || Array.isArray(m)) {
      throw new AuditorBackendError(errorCode, `missing_tools[${i}] not an object`, { backend, stage });
    }
    if (typeof m.name !== 'string' || m.name.length === 0) {
      throw new AuditorBackendError(errorCode, `missing_tools[${i}].name must be non-empty string`, { backend, stage });
    }
    if (typeof m.reason !== 'string' || m.reason.length === 0) {
      throw new AuditorBackendError(errorCode, `missing_tools[${i}].reason must be non-empty string`, { backend, stage });
    }
  });
  if (parsed.pass === true && parsed.missing_tools.length > 0) {
    throw new AuditorBackendError(
      errorCode,
      'pass: true with non-empty missing_tools is inconsistent',
      { backend, stage }
    );
  }
  if (parsed.pass === false && parsed.missing_tools.length === 0) {
    throw new AuditorBackendError(
      errorCode,
      'pass: false with empty missing_tools is inconsistent',
      { backend, stage }
    );
  }
}

export function filterCatalogMisses(parsed, catalogNames) {
  const names = catalogNames instanceof Set ? catalogNames : new Set(catalogNames);
  const kept = [];
  const dropped = [];
  for (const m of parsed.missing_tools) {
    if (names.has(m.name)) kept.push(m);
    else dropped.push(m.name);
  }
  if (dropped.length === 0) return { parsed, dropped };
  if (kept.length === 0) {
    return {
      parsed: { pass: true, missing_tools: [], reason: 'hallucination_filtered' },
      dropped,
    };
  }
  return { parsed: { ...parsed, missing_tools: kept }, dropped };
}

function stripFence(text) {
  const fenceMatch = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  return fenceMatch ? fenceMatch[1] : text;
}
