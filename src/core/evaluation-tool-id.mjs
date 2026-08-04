import { join, normalize, sep, win32 } from 'node:path';
import { homedir } from 'node:os';
import { readFrontmatter } from '../tool-db/frontmatter.mjs';

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

function maskJavaScriptLiteralsAndComments(source) {
  let masked = '';
  let index = 0;
  let state = 'code';
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (state === 'code') {
      if (char === '/' && next === '/') {
        masked += '  ';
        index += 2;
        state = 'line-comment';
        continue;
      }
      if (char === '/' && next === '*') {
        masked += '  ';
        index += 2;
        state = 'block-comment';
        continue;
      }
      if (char === '"' || char === "'" || char === '`') {
        masked += ' ';
        index += 1;
        state = char;
        continue;
      }
      masked += char;
      index += 1;
      continue;
    }
    if (state === 'line-comment') {
      masked += char === '\n' ? '\n' : ' ';
      index += 1;
      if (char === '\n') state = 'code';
      continue;
    }
    if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        masked += '  ';
        index += 2;
        state = 'code';
      } else {
        masked += char === '\n' ? '\n' : ' ';
        index += 1;
      }
      continue;
    }
    if (char === '\\') {
      masked += next === '\n' ? ' \n' : '  ';
      index += Math.min(2, source.length - index);
      continue;
    }
    masked += char === '\n' ? '\n' : ' ';
    index += 1;
    if (char === state) state = 'code';
  }
  return masked;
}

function parseJavaScriptStringAt(source, start) {
  const quote = source[start];
  if (quote !== '"' && quote !== "'") return null;
  let raw = quote;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    raw += char;
    if (char === '\\') {
      index += 1;
      if (index < source.length) raw += source[index];
      continue;
    }
    if (char !== quote) continue;
    if (quote === '"') {
      try {
        return { value: JSON.parse(raw), end: index + 1 };
      } catch {
        return null;
      }
    }
    // Shell commands in Codex wrappers use ordinary single-quoted JS literals. Decode only
    // the escape forms needed by those literals; template/expression evaluation is excluded.
    const body = raw.slice(1, -1);
    const value = body.replace(/\\(?:([\\'"bnrtfv0])|x([0-9A-Fa-f]{2})|u([0-9A-Fa-f]{4}))/gu,
      (match, simple, hex, unicode) => {
        if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
        if (unicode) return String.fromCodePoint(Number.parseInt(unicode, 16));
        return ({ '\\': '\\', "'": "'", '"': '"', b: '\b', n: '\n', r: '\r', t: '\t', f: '\f', v: '\v', 0: '\0' })[simple] ?? match;
      });
    return { value, end: index + 1 };
  }
  return null;
}

function codexShellInputs(toolInput) {
  const parsed = readToolInput(toolInput);
  if (parsed) {
    return [...new Set([parsed.cmd, parsed.command, parsed.text]
      .filter((value) => typeof value === 'string' && value.length > 0))];
  }
  if (typeof toolInput !== 'string') return [];
  // Current outer `exec` calls contain JavaScript which invokes PTY/shell tools. Extract only
  // literal cmd/command/text property values from executable code, never prose in comments or
  // string values. A later exact read-command check prevents arbitrary text fields from counting.
  const masked = maskJavaScriptLiteralsAndComments(toolInput);
  const inputs = [];
  const propertyPattern = /(?:^|[,{])\s*(?:cmd|command|text)\s*:/gu;
  for (const match of masked.matchAll(propertyPattern)) {
    let valueStart = match.index + match[0].length;
    while (/\s/u.test(toolInput[valueStart] ?? '')) valueStart += 1;
    const parsedString = parseJavaScriptStringAt(toolInput, valueStart);
    if (parsedString && parsedString.value.length > 0) inputs.push(parsedString.value);
  }
  return [...new Set(inputs)];
}

function nestedMcpToolIds(toolInput) {
  if (typeof toolInput !== 'string') return [];
  const executable = maskJavaScriptLiteralsAndComments(toolInput);
  const matches = executable.matchAll(/\btools\.(mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_.:/-]+)\s*\(/gu);
  return [...new Set([...matches].map((match) => match[1]).filter(validCatalogId))];
}

function escapedRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function mentionedSkillFiles(command) {
  const matches = [
    ...(command.match(/(?:[A-Za-z]:[\\/]|\/)[^\s"'`;&|]+[\\/]SKILL\.md/gu) ?? []),
    ...(command.match(/(?<=")(?:[A-Za-z]:[\\/]|\/)[^"]+[\\/]SKILL\.md(?=")/gu) ?? []),
    ...(command.match(/(?<=')(?:[A-Za-z]:[\\/]|\/)[^']+[\\/]SKILL\.md(?=')/gu) ?? []),
  ];
  return [...new Set(matches)];
}

function isReadCommandForPath(command, skillPath) {
  const pathPattern = skillPath.split(/[\\/]/u).map(escapedRegExp).join('[\\\\/]');
  return new RegExp(
    String.raw`(?:^|[;&|\n(])\s*(?:cat|sed|head|tail|less|more)\b[^;&|\n]*${pathPattern}`,
    'u',
  ).test(command);
}

function normalizedPortablePath(value) {
  if (win32.isAbsolute(value)) return win32.normalize(value).replaceAll('\\', '/');
  return normalize(value).split(sep).join('/');
}

function relativeSkillIdentity(skillPath, { projectRoot, codexHome }) {
  const path = normalizedPortablePath(skillPath);
  const home = normalizedPortablePath(codexHome);
  const project = normalizedPortablePath(projectRoot);
  const roots = [
    { prefix: `${home}/skills/.system/`, plugin: null },
    { prefix: `${home}/skills/`, plugin: null },
    { prefix: `${project}/.codex/skills/`, plugin: null },
  ];
  for (const root of roots) {
    if (!path.startsWith(root.prefix) || !path.endsWith('/SKILL.md')) continue;
    const relative = path.slice(root.prefix.length, -'/SKILL.md'.length);
    if (relative.length > 0 && !relative.includes('/')) return { plugin: root.plugin, directory: relative };
  }

  const pluginPrefix = `${home}/plugins/cache/`;
  if (!path.startsWith(pluginPrefix) || !path.endsWith('/SKILL.md')) return null;
  const parts = path.slice(pluginPrefix.length).split('/');
  // <marketplace>/<plugin>/<version>/skills/<skill>/SKILL.md
  if (parts.length !== 6 || parts[3] !== 'skills' || parts[5] !== 'SKILL.md') return null;
  return { plugin: parts[1], directory: parts[4] };
}

/**
 * Recognizes Codex skill adoption through the actual invocation form: reading a proposed
 * skill's SKILL.md with a shell read command. Ordinary shell use is deliberately ignored.
 */
export async function canonicalizeCodexSkillReadToolIds(usages, {
  proposedToolIds = [],
  projectRoot,
  codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'),
  readFrontmatterFn = readFrontmatter,
} = {}) {
  if (!Array.isArray(usages) || !Array.isArray(proposedToolIds)
    || typeof projectRoot !== 'string' || projectRoot.length === 0
    || typeof codexHome !== 'string' || codexHome.length === 0) return [];

  const proposed = new Set(proposedToolIds.filter((toolId) => validCatalogId(toolId)
    && !MCP_ID_PATTERN.test(toolId)));
  if (proposed.size === 0) return [];

  const adopted = new Set();
  for (const usage of usages) {
    if (!isRecord(usage) || (usage.toolName !== 'exec' && usage.toolName !== 'exec_command')) continue;
    for (const command of codexShellInputs(usage.toolInput)) {
      for (const skillPath of mentionedSkillFiles(command)) {
        if (!isReadCommandForPath(command, skillPath)) continue;
        const identity = relativeSkillIdentity(skillPath, { projectRoot, codexHome });
        if (!identity) continue;
        let frontmatter;
        try {
          frontmatter = await readFrontmatterFn(skillPath);
        } catch {
          continue;
        }
        const skillName = typeof frontmatter?.name === 'string' && frontmatter.name.length > 0
          ? frontmatter.name
          : identity.directory;
        const toolId = identity.plugin ? `${identity.plugin}:${skillName}` : skillName;
        if (proposed.has(toolId)) adopted.add(toolId);
      }
    }
  }
  return [...adopted];
}

/**
 * Recognizes MCP calls that current Codex rollouts execute inside an outer `exec` JavaScript
 * wrapper. Only a direct executable `tools.mcp__...(` member call counts; string/comment mentions
 * are deliberately ignored.
 */
export function canonicalizeCodexNestedMcpToolIds(usages) {
  if (!Array.isArray(usages)) return [];
  const adopted = new Set();
  for (const usage of usages) {
    if (!isRecord(usage) || usage.toolName !== 'exec') continue;
    for (const toolId of nestedMcpToolIds(usage.toolInput)) adopted.add(toolId);
  }
  return [...adopted];
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
