// Legacy pending migration only. Historical files are never read or parsed because they may
// contain untrusted auditor text; the matching same-session file is best-effort unlinked.

import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

const PENDING_DIR = 'pending';

export function pendingPath({ projectRoot, sessionId } = {}) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) return null;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  const clean = sessionId.replace(/[^A-Za-z0-9_-]/g, '');
  if (!clean) return null;
  return join(projectRoot, '.spotter', PENDING_DIR, `${clean}.json`);
}

export async function discardLegacyPending({ projectRoot, sessionId, unlinkFn = unlink } = {}) {
  const path = pendingPath({ projectRoot, sessionId });
  if (!path) return { discarded: false, diagnostic: 'legacy_pending_invalid_path' };
  try {
    await unlinkFn(path);
    return { discarded: true, diagnostic: null };
  } catch (err) {
    if (err?.code === 'ENOENT') return { discarded: true, diagnostic: null };
    return { discarded: false, diagnostic: 'legacy_pending_discard_failed' };
  }
}
