// Hand-curated descriptions for Claude Code built-in deferred tools.
//
// Why hardcoded: Claude Code's built-in tools cannot be queried introspectively from a
// daemon process (they're internal to the Claude binary, not exposed via MCP). The list
// is small and stable; we maintain it here and update on Claude Code releases.
//
// `spotter db refresh` merges this baseline into the global DB. Users can override
// per-project by editing their local DB (per docs/catalog-design-deferred-mcp.md).

export const DEFERRED_TOOL_BASELINE = {
  // Reasoning / dialogue
  'AskUserQuestion': 'Ask the user a clarifying question with multi-choice or free-text answer when requirements are ambiguous; preferable to guessing.',
  'TodoWrite': 'Create or update a structured task list to plan and track multi-step work; surfaces progress to the user and to future turns.',
  'EnterPlanMode': 'Enter Plan Mode: Claude proposes a plan first and waits for user approval before doing the work.',
  'ExitPlanMode': 'Exit Plan Mode after the user has approved the proposed plan.',

  // Web access
  'WebSearch': 'Search the web for up-to-date information (news, prices, releases, events that postdate training).',
  'WebFetch': 'Fetch the contents of a specific URL to read its body (HTML/Markdown/JSON), e.g. when the user pastes a link.',

  // Notebook
  'NotebookEdit': 'Edit cells in a Jupyter notebook (.ipynb) — insert, replace, or delete cells.',

  // Worktree / isolated execution
  'EnterWorktree': 'Create a temporary git worktree to isolate experimental edits from the main checkout.',
  'ExitWorktree': 'Tear down a previously-created worktree.',

  // Background processes / monitoring
  'Monitor': 'Stream events from a long-running background process; receives a notification per stdout line.',
  'PushNotification': 'Send a push notification to the user (e.g. on long task completion).',

  // Scheduling / cron
  'CronCreate': 'Schedule a recurring agent (cron-style trigger) that runs Claude Code on an interval.',
  'CronDelete': 'Delete a scheduled cron trigger by id.',
  'CronList': 'List all currently configured cron triggers.',
  'RemoteTrigger': 'Create or run a remote trigger (one-shot or recurring scheduled agent).',

  // Sub-agent / task control
  'TaskOutput': 'Read the latest output from a running background sub-agent.',
  'TaskStop': 'Stop a running background sub-agent.',
};

export function getDeferredDescription(name) {
  return DEFERRED_TOOL_BASELINE[name] ?? null;
}

export function listDeferredNames() {
  return Object.keys(DEFERRED_TOOL_BASELINE);
}
