// Canonical tool IDs for proposal-adoption evaluation.
//
// The catalog already owns tool identity. This module only converts the identifiers emitted by
// host hooks/transcripts into those catalog IDs; it deliberately does not discover, persist, or
// resolve collisions between tools.

const CATALOG_ID_PATTERN = /^[A-Za-z0-9_.:/-]+$/u;
const MCP_ID_PATTERN = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_.:/-]+$/u;
const MAX_CATALOG_ID_LENGTH = 160;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validCatalogId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_CATALOG_ID_LENGTH
    && CATALOG_ID_PATTERN.test(value);
}

function resolved(toolId) {
  return { status: 'resolved', toolId };
}

function missing(reason) {
  return { status: 'missing', reason };
}

function readToolInput(toolInput) {
  if (isRecord(toolInput)) return toolInput;
  if (typeof toolInput !== 'string' || toolInput.length === 0) return null;
  try {
    const parsed = JSON.parse(toolInput);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function selectorFromInput(toolInput, keys) {
  const input = readToolInput(toolInput);
  if (!input) return null;
  for (const key of keys) {
    if (validCatalogId(input[key])) return input[key];
  }
  return null;
}

function canonicalizeClaudeToolId(toolName, toolInput) {
  if (MCP_ID_PATTERN.test(toolName)) return resolved(toolName);
  if (toolName === 'Skill') {
    const selector = selectorFromInput(toolInput, ['skill', 'selector']);
    return selector ? resolved(selector) : missing('E_TOOL_ID_CLAUDE_SKILL_SELECTOR_MISSING');
  }
  if (toolName === 'Agent') {
    const selector = selectorFromInput(toolInput, ['subagent_type']);
    return selector ? resolved(selector) : missing('E_TOOL_ID_CLAUDE_AGENT_SELECTOR_MISSING');
  }
  return missing('E_TOOL_ID_CLAUDE_TOOL_UNSUPPORTED');
}

function canonicalizeCodexSkillId(toolName, toolInput) {
  const selector = selectorFromInput(toolInput, ['skill', 'selector']);
  if (selector) return resolved(selector);

  // `readCodexToolUsage` joins a namespace and name with `__`. Accept the two observed
  // skill namespace spellings as well as the direct wrapper spelling without treating a
  // non-skill tool as a catalog ID.
  const matched = /^(?:skills?|Skill)__(.+)$/u.exec(toolName)
    ?? /^(?:skills?|Skill)\.(.+)$/u.exec(toolName);
  if (matched && validCatalogId(matched[1])) return resolved(matched[1]);
  return missing('E_TOOL_ID_CODEX_SKILL_SELECTOR_MISSING');
}

function canonicalizeCodexToolId(toolName, toolInput) {
  if (MCP_ID_PATTERN.test(toolName)) return resolved(toolName);
  if (toolName === 'Skill' || toolName === 'skill'
    || /^(?:skills?|Skill)(?:__|\.)/u.test(toolName)) {
    return canonicalizeCodexSkillId(toolName, toolInput);
  }
  return missing('E_TOOL_ID_CODEX_TOOL_UNSUPPORTED');
}

/**
 * Converts one actual host tool invocation to its catalog ID.
 *
 * A missing result is intentional: callers must mark usage incomplete rather than converting
 * an unknown invocation into `not_adopted`.
 */
export function canonicalizeToolId({ host, toolName, toolInput } = {}) {
  if (!validCatalogId(toolName)) return missing('E_TOOL_ID_TOOL_NAME_INVALID');
  if (host === 'claude') return canonicalizeClaudeToolId(toolName, toolInput);
  if (host === 'codex') return canonicalizeCodexToolId(toolName, toolInput);
  return missing('E_TOOL_ID_HOST_UNSUPPORTED');
}

function collect(results) {
  const resolvedToolIds = [];
  const seen = new Set();
  const missingResults = [];
  for (const [index, result] of results.entries()) {
    if (result.status === 'resolved') {
      if (seen.has(result.toolId)) continue;
      seen.add(result.toolId);
      resolvedToolIds.push(result.toolId);
      continue;
    }
    missingResults.push({ index, reason: result.reason });
  }
  return {
    resolvedToolIds,
    missingCount: missingResults.length,
    missing: missingResults,
  };
}

/**
 * Validates and de-duplicates the safe-projector output. Proposal IDs are already catalog IDs;
 * this helper must not reinterpret a skill or agent selector as a host wrapper invocation.
 */
export function canonicalizeProposedToolIds(toolIds) {
  if (!Array.isArray(toolIds)) {
    return collect([missing('E_TOOL_ID_PROPOSAL_LIST_INVALID')]);
  }
  return collect(toolIds.map((toolId) => validCatalogId(toolId)
    ? resolved(toolId)
    : missing('E_TOOL_ID_PROPOSAL_INVALID')));
}

/**
 * Canonicalizes host usage records and de-duplicates repeated invocations of the same tool.
 * Each entry is `{ toolName, toolInput? }`; malformed entries remain explicit missing results.
 */
export function canonicalizeUsedToolIds(usages, { host } = {}) {
  if (!Array.isArray(usages)) {
    return collect([missing('E_TOOL_ID_USAGE_LIST_INVALID')]);
  }
  return collect(usages.map((usage) => isRecord(usage)
    ? canonicalizeToolId({ host, toolName: usage.toolName, toolInput: usage.toolInput })
    : missing('E_TOOL_ID_USAGE_INVALID')));
}
