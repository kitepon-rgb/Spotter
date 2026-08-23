// Configuration-time (synchronous) check for whether `codex` is on PATH.
// No subprocess is spawned. OS依存のPATH walkは src/platform/paths.mjs が所有する。
//
// This is consumed by `selectByPolicy` in auditor-backend.mjs to choose the
// Claude-host primary auditor: when codex is reachable, the daemon prefers
// Codex CLI over Haiku. Once chosen, the backend's runtime failures still
// throw `AuditorBackendError` — selection-time availability does not become a
// runtime fallback.

import { isExecutableOnPath } from '../platform/paths.mjs';

export function isCodexCliAvailable({
  env = process.env,
  platform = process.platform,
  fileExists,
} = {}) {
  return isExecutableOnPath('codex', {
    env,
    platform,
    ...(fileExists ? { fileExists } : {}),
  });
}
