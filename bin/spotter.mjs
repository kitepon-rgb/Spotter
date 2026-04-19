#!/usr/bin/env node
// spotter — CLI entry point.
// dispatches to src/cli/* and src/hooks/*.

import { runInstall } from '../src/cli/install.mjs';
import { runUninstall } from '../src/cli/uninstall.mjs';
import { runDoctor } from '../src/cli/doctor.mjs';
import { runStatus } from '../src/cli/status.mjs';
import { runCatalogEdit, runCatalogLint } from '../src/cli/catalog.mjs';
import { runDaemonStart } from '../src/cli/daemon-cmd.mjs';
import { runSessionStart } from '../src/hooks/session-start.mjs';
import { runUserPrompt } from '../src/hooks/user-prompt.mjs';
import { runPreToolUse } from '../src/hooks/pre-tool-use.mjs';
import { runStop } from '../src/hooks/stop.mjs';
import { runSessionEnd } from '../src/hooks/session-end.mjs';

const USAGE = `spotter — Claude Code tool-call auditor

Usage:
  spotter install [-y]                  register hooks in <cwd>/.claude/settings.json
                                        and create <cwd>/.spotter/marker.json
                                        (run inside each project you want audited)
  spotter install --user [-y]           legacy: register globally in ~/.claude/settings.json
                                        (NOT RECOMMENDED — fires for every Claude Code session
                                         on the system, including unrelated \`claude -p\`)
  spotter uninstall [-y]                remove spotter hooks from <cwd>/.claude/settings.json
                                        and remove <cwd>/.spotter/marker.json
  spotter uninstall --user [-y]         remove from ~/.claude/settings.json
  spotter catalog edit                  open tool catalog in $EDITOR
  spotter catalog lint                  validate catalog + run test_cases (Haiku live call)
  spotter status                        show running daemons
  spotter doctor                        environment diagnostic
  spotter daemon start --session-id ID  (internal) run session daemon
  spotter hook <event>                  (internal) hook dispatch
                                        events: session-start | user-prompt |
                                                pre-tool-use | stop | session-end
  spotter --help | -h                   this message
  spotter --version | -v                version
`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(USAGE);
    return;
  }
  if (argv[0] === '--version' || argv[0] === '-v') {
    const { version } = await import('../src/version.mjs');
    process.stdout.write(`spotter ${version}\n`);
    return;
  }

  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'install': {
      const target = rest.includes('--user') ? 'user' : 'project';
      const autoYes = rest.includes('-y') || rest.includes('--yes');
      await runInstall({ target, autoYes });
      return;
    }
    case 'uninstall': {
      const target = rest.includes('--user') ? 'user' : 'project';
      const autoYes = rest.includes('-y') || rest.includes('--yes');
      await runUninstall({ target, autoYes });
      return;
    }
    case 'catalog': {
      const sub = rest[0];
      if (sub === 'edit') { await runCatalogEdit(); return; }
      if (sub === 'lint') { await runCatalogLint(); return; }
      process.stderr.write(`unknown catalog subcommand: ${sub}\n${USAGE}`);
      process.exit(2);
      return;
    }
    case 'status':
      await runStatus();
      return;
    case 'doctor':
      await runDoctor();
      return;
    case 'daemon': {
      const sub = rest[0];
      if (sub === 'start') { await runDaemonStart({ argv: rest.slice(1) }); return; }
      process.stderr.write(`unknown daemon subcommand: ${sub}\n${USAGE}`);
      process.exit(2);
      return;
    }
    case 'hook': {
      const event = rest[0];
      switch (event) {
        case 'session-start': await runSessionStart(); return;
        case 'user-prompt': await runUserPrompt(); return;
        case 'pre-tool-use': await runPreToolUse(); return;
        case 'stop': await runStop(); return;
        case 'session-end': await runSessionEnd(); return;
        default:
          process.stderr.write(`unknown hook event: ${event}\n${USAGE}`);
          process.exit(2);
      }
      return;
    }
    default:
      process.stderr.write(`unknown command: ${cmd}\n${USAGE}`);
      process.exit(2);
  }
}

main().catch((err) => {
  process.stderr.write(`spotter: ${err.stack || err.message || err}\n`);
  process.exit(err.exitCode ?? 2);
});
