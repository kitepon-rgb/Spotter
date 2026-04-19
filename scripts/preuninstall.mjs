// Runs before `npm uninstall (-g) claude-spotter`.
//
// v0.3: with project-scoped install (no global hook registration), preuninstall
// has nothing global to clean. We do a best-effort cleanup of the legacy
// ~/.claude/settings.json registration in case the user upgraded from <0.3, then
// print guidance for project-level uninstall.
//
// Never fails the uninstall — on error we warn and exit 0.

import { runUninstall } from '../src/cli/uninstall.mjs';

try {
  await runUninstall({ target: 'user', autoYes: true });
} catch (err) {
  console.warn(`claude-spotter: legacy user-scope cleanup skipped — ${err.message}`);
}

console.log('claude-spotter: per-project hooks (in <project>/.claude/settings.json) are not removed automatically.');
console.log('  To remove them, run `spotter uninstall` in each project before this uninstall completes,');
console.log('  or edit <project>/.claude/settings.json manually after.');
