// Hardcoded description baseline for Anthropic-provided `claude.ai ...` MCP servers
// (Gmail / Google Calendar / Google Drive).
//
// Why hardcoded, not fetched:
//   These servers are NOT registered in local `.mcp.json`. Claude Code calls them via
//   its own mcp-proxy.anthropic.com endpoint using the OAuth token in
//   ~/.claude/.credentials.json. Spotter deliberately does NOT read credentials — so
//   we cannot dynamically invoke tools/list against the proxy. The tool surface is
//   public (the same deferred-tool list Claude Code exposes) and changes slowly.
//
// Maintenance:
//   When Anthropic adds new tools to these MCP servers, append them here. The daemon
//   merges this baseline into the tool-db during `spotter db refresh`.
//
// Bell-visible names follow the convention `mcp__<server-id>__<tool-name>` where
// <server-id> is the `claude.ai ...` server name with non-[A-Za-z0-9_-] chars replaced
// by `_` — e.g. "claude.ai Gmail" → "claude_ai_Gmail".

const GMAIL = {
  mcp__claude_ai_Gmail__search_threads:
    'Search Gmail threads matching a query (e.g. from:alice subject:invoice, is:unread, after:2024-01-01). Use when the user asks to find, read, or reference specific mail.',
  mcp__claude_ai_Gmail__get_thread:
    'Fetch the full body of a Gmail thread by id — all messages, headers, and text. Use after search_threads to read the actual content.',
  mcp__claude_ai_Gmail__list_drafts:
    'List existing Gmail drafts. Use before create_draft when the user asks about pending unsent mail or wants to resume a draft.',
  mcp__claude_ai_Gmail__create_draft:
    'Create a new Gmail draft (to, subject, body, optional cc/bcc). Does NOT send. Use when the user asks Claude to compose a message for later review.',
  mcp__claude_ai_Gmail__list_labels:
    'List all Gmail labels (both system and user-created). Use before label_message / label_thread to find the correct label id.',
  mcp__claude_ai_Gmail__create_label:
    'Create a new Gmail label. Use when the user wants to organize mail into a category that does not yet exist.',
  mcp__claude_ai_Gmail__label_message:
    'Apply a label to a single Gmail message by id.',
  mcp__claude_ai_Gmail__unlabel_message:
    'Remove a label from a single Gmail message by id.',
  mcp__claude_ai_Gmail__label_thread:
    'Apply a label to an entire Gmail thread (all messages in the thread).',
  mcp__claude_ai_Gmail__unlabel_thread:
    'Remove a label from an entire Gmail thread.',
};

const CALENDAR = {
  mcp__claude_ai_Google_Calendar__list_calendars:
    'List all Google Calendars the user has access to (primary, shared, subscribed). Use first when the user does not specify which calendar.',
  mcp__claude_ai_Google_Calendar__list_events:
    'List events in a calendar over a time range. Use when the user asks about upcoming meetings, schedule conflicts, or "what is on my calendar".',
  mcp__claude_ai_Google_Calendar__get_event:
    'Fetch a single event by id with full details (attendees, description, attachments).',
  mcp__claude_ai_Google_Calendar__create_event:
    'Create a new Google Calendar event (title, start/end, attendees, optional location/description). Use when the user asks to schedule something.',
  mcp__claude_ai_Google_Calendar__update_event:
    'Modify an existing event (reschedule, change attendees, update description). Use when the user asks to move or edit a meeting.',
  mcp__claude_ai_Google_Calendar__delete_event:
    'Delete an event from Google Calendar. Use when the user asks to cancel a meeting.',
  mcp__claude_ai_Google_Calendar__respond_to_event:
    'RSVP to an event invitation (accept / decline / tentative).',
  mcp__claude_ai_Google_Calendar__suggest_time:
    'Find free time slots across multiple calendars / attendees. Use when the user asks to find a mutually available meeting time.',
};

const DRIVE = {
  mcp__claude_ai_Google_Drive__search_files:
    'Search Google Drive for files matching a query (name, content, mimeType). Use when the user asks to find a doc/sheet/slide by topic or title.',
  mcp__claude_ai_Google_Drive__list_recent_files:
    'List recently accessed Google Drive files. Use when the user asks "what was I just working on in Drive?" or similar.',
  mcp__claude_ai_Google_Drive__get_file_metadata:
    'Fetch metadata (name, mimeType, owner, modified time, sharing) for a Drive file by id — NOT the content. Use before read_file_content to verify the file type.',
  mcp__claude_ai_Google_Drive__read_file_content:
    'Read the textual content of a Drive file (Docs, Sheets, plain text). Use when the user asks Claude to reference or summarize a file.',
  mcp__claude_ai_Google_Drive__download_file_content:
    'Download binary file content from Drive (PDF, image, zip). Use when the user needs the raw bytes rather than extracted text.',
  mcp__claude_ai_Google_Drive__create_file:
    'Create a new file in Google Drive (text content or uploaded blob). Use when the user asks to save something to Drive.',
  mcp__claude_ai_Google_Drive__get_file_permissions:
    'List who has access to a Drive file and their role (reader/commenter/writer/owner). Use when the user asks who can see or edit a file.',
};

const ALL = { ...GMAIL, ...CALENDAR, ...DRIVE };

export function listClaudeAiNames() {
  return Object.keys(ALL);
}

export function getClaudeAiDescription(name) {
  return ALL[name] ?? null;
}
