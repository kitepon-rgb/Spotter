// Runs after `npm install (-g) claude-spotter`.
// Registers hooks at user level so Spotter is active across all projects
// without requiring a separate `spotter install` step.
//
// Never fails npm install — on any error we warn and exit 0 so the user's
// node_modules/global bin is still usable. They can re-run `spotter install --user`
// manually if needed.

import { runInstall } from '../src/cli/install.mjs';

const SKIP_ENV = 'CLAUDE_SPOTTER_NO_AUTO_INSTALL';

async function main() {
  if (process.env[SKIP_ENV]) {
    console.log(`claude-spotter: auto-install skipped (${SKIP_ENV} set).`);
    console.log('  run `spotter install --user` later to register hooks.');
    return;
  }

  // Skip in well-known CI environments — CI builds shouldn't silently modify
  // ~/.claude/settings.json of whatever runner user this is.
  if (process.env.CI === 'true' || process.env.CI === '1') {
    console.log('claude-spotter: auto-install skipped (CI detected).');
    console.log('  run `spotter install --user` on your dev machine.');
    return;
  }

  try {
    await runInstall({ target: 'user', autoYes: true });
    console.log('\nclaude-spotter: hooks registered at user level (~/.claude/settings.json).');
    console.log('  Open a new Claude Code session to activate.');
    console.log(`  To skip this next time: set ${SKIP_ENV}=1 before npm install.`);
  } catch (err) {
    console.warn(`claude-spotter: auto-install skipped — ${err.message}`);
    console.warn('  run `spotter install --user` to register hooks manually.');
  }
}

main().catch((err) => {
  // Defensive: never let postinstall crash the install.
  console.warn(`claude-spotter: postinstall unexpected error — ${err.message}`);
});
