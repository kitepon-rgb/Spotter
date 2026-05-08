import { statSync } from 'node:fs';
import { posix, win32 } from 'node:path';

// Configuration-time (synchronous) check for whether `codex` is on PATH.
// No subprocess is spawned. The function walks env.PATH and tests each candidate
// with `fs.statSync`; PATHEXT-equivalent extensions are added on Windows.
//
// This is consumed by `selectByPolicy` in auditor-backend.mjs to choose the
// Claude-host primary auditor: when codex is reachable, the daemon prefers
// Codex CLI over Haiku. Once chosen, the backend's runtime failures still
// throw `AuditorBackendError` — selection-time availability does not become a
// runtime fallback.

const WINDOWS_EXTS = ['.cmd', '.exe', '.bat'];

export function isCodexCliAvailable({
  env = process.env,
  platform = process.platform,
  fileExists = defaultFileExists,
} = {}) {
  const pathVar = pickPathVar(env, platform);
  if (typeof pathVar !== 'string' || pathVar.length === 0) return false;
  const sep = platform === 'win32' ? ';' : ':';
  const join = platform === 'win32' ? win32.join : posix.join;
  const candidates = platform === 'win32'
    ? WINDOWS_EXTS.map((ext) => `codex${ext}`)
    : ['codex'];
  for (const rawDir of pathVar.split(sep)) {
    const dir = rawDir.trim();
    if (dir.length === 0) continue;
    for (const candidate of candidates) {
      if (fileExists(join(dir, candidate))) return true;
    }
  }
  return false;
}

function pickPathVar(env, platform) {
  if (platform === 'win32') {
    return env?.Path ?? env?.PATH ?? env?.path ?? '';
  }
  return env?.PATH ?? '';
}

function defaultFileExists(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
