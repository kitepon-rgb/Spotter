export const HOST_AGENTS = new Set(['claude', 'codex', 'automation', 'unknown']);

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

export function assertHostAgent(hostAgent) {
  if (!HOST_AGENTS.has(hostAgent)) {
    throw new TypeError(`hostAgent must be one of: ${Array.from(HOST_AGENTS).join(', ')}`);
  }
}
