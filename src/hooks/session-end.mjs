// SessionEnd hook — best-effort shutdown notice. §14.1 exception: cleanup failures warn only.
// v0.2 gates: see src/hooks/session-start.mjs comment.

import { readStdinJson, requireString, isChildCall, isSubagentCall, isOutsideSpotterProject } from './lib.mjs';
import { sendRequest } from '../daemon/transport.mjs';

const TIMEOUT_MS = 2_000;

export async function runSessionEnd() {
  if (isChildCall()) return;
  const input = await readStdinJson();
  if (isSubagentCall(input)) return;
  if (isOutsideSpotterProject(input)) return;

  const sessionId = requireString(input, 'session_id');

  try {
    await sendRequest({
      sessionId,
      event: 'shutdown',
      timeoutMs: TIMEOUT_MS,
    });
  } catch (err) {
    // §14.1 exception — don't fail the Claude Code session just because cleanup failed.
    process.stderr.write(`spotter-hook: session-end shutdown warning: ${err.code ?? '?'}: ${err.message}\n`);
    process.exit(0);
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  runSessionEnd().catch((err) => {
    process.stderr.write(`spotter-hook: session-end unexpected error: ${err.message}\n`);
    process.exit(0); // still don't block session end (§14.1 exception)
  });
}
