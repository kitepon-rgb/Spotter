// OS依存のパス表記正規化の唯一の置き場。

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
