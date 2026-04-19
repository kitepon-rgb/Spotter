// Runs before `npm uninstall (-g) claude-spotter`.
// Removes hooks from ~/.claude/settings.json so an uninstall leaves the system clean.
//
// Never fails the uninstall — on error we warn and exit 0.

import { runUninstall } from '../src/cli/uninstall.mjs';

try {
  await runUninstall({ target: 'user', autoYes: true });
  console.log('claude-spotter: hooks removed from ~/.claude/settings.json.');
} catch (err) {
  console.warn(`claude-spotter: hook cleanup skipped — ${err.message}`);
  console.warn('  you may need to edit ~/.claude/settings.json manually.');
}
