// Runs after `npm install (-g) claude-spotter`.
//
// v0.3: auto-register has been removed. The previous behaviour (writing hooks to
// ~/.claude/settings.json globally) caused daemon proliferation: every Claude Code
// session anywhere on the system — including `claude -p` invocations from unrelated
// tools like Throughline — fired the hooks and spawned a daemon. The fix is
// project-scoped install: the user runs `spotter install` inside each project they
// want audited, which writes hooks to that project's .claude/settings.json plus a
// .spotter/marker.json that hooks check before doing any work.
//
// This script now only prints onboarding guidance.

const SKIP_ENV = 'CLAUDE_SPOTTER_NO_AUTO_INSTALL';

// Honor the legacy skip env var for parity with old guidance, but it's a no-op now.
if (process.env[SKIP_ENV]) {
  process.exit(0);
}

if (process.env.CI === 'true' || process.env.CI === '1') {
  process.exit(0);
}

console.log('claude-spotter installed.');
console.log('  Next step (per project you want audited):');
console.log('    cd <your-project>');
console.log('    spotter install');
console.log('  This writes hooks to <project>/.claude/settings.json and a .spotter/');
console.log('  marker so unrelated `claude -p` invocations do not trigger Spotter.');
