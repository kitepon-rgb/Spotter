// OS依存のパス表記・PATH探索の唯一の置き場。

import { statSync } from 'node:fs';
import { posix, win32 } from 'node:path';

// Synchronous PATH walk: is `command` reachable as an executable file on PATH?
// No subprocess is spawned. Windows adds PATHEXT-equivalent extensions and reads
// PATH case-insensitively (Path / PATH / path).
export function isExecutableOnPath(command, {
  env = process.env,
  platform = process.platform,
  windowsExtensions = ['.cmd', '.exe', '.bat'],
  fileExists = defaultFileExists,
} = {}) {
  const pathVar = platform === 'win32'
    ? (env?.Path ?? env?.PATH ?? env?.path ?? '')
    : (env?.PATH ?? '');
  if (typeof pathVar !== 'string' || pathVar.length === 0) return false;
  const sep = platform === 'win32' ? ';' : ':';
  const join = platform === 'win32' ? win32.join : posix.join;
  const candidates = platform === 'win32'
    ? windowsExtensions.map((ext) => `${command}${ext}`)
    : [command];
  for (const rawDir of pathVar.split(sep)) {
    const dir = rawDir.trim();
    if (dir.length === 0) continue;
    for (const candidate of candidates) {
      if (fileExists(join(dir, candidate))) return true;
    }
  }
  return false;
}

function defaultFileExists(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

// Normalize an absolute project path for matching against config keys (e.g.
// `~/.claude.json` `projects[]`). Representation can drift across:
//   - separator: `\` on Windows vs `/`
//   - drive-letter case: `C:\` vs `c:\` on Windows
//   - trailing slash: `/foo/bar` vs `/foo/bar/`
// On Windows we canonicalize to forward slashes and lower-case (case-insensitive
// filesystem). On POSIX, `\` is a legal filename character — collapsing it to `/`
// would conflate genuinely distinct paths (e.g. literal `C:\Users\u\proj` vs the
// hypothetical POSIX path `C:/Users/u/proj`), and case stays significant. POSIX
// only normalizes the trailing slash.
export function normalizeProjectPath(p) {
  if (typeof p !== 'string' || p.length === 0) return '';
  let s = p;
  if (process.platform === 'win32') {
    s = s.replace(/\\/g, '/').toLowerCase();
  }
  s = s.replace(/\/+$/, '');
  return s;
}
