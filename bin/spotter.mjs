#!/usr/bin/env node
// spotter — CLI entry point.
// dispatches to src/cli/* and src/hooks/*.

import { runInstall } from '../src/cli/install.mjs';
import { runUninstall } from '../src/cli/uninstall.mjs';
import { runDoctor } from '../src/cli/doctor.mjs';
import { runStatus } from '../src/cli/status.mjs';
import { runDbList, runDbRefresh, runDbRebuild } from '../src/cli/db-cmd.mjs';
import { runCodexCommand } from '../src/cli/codex-cmd.mjs';
import { runCodexHookCommand } from '../src/cli/codex-hook-cmd.mjs';
import { runAuditorCommand } from '../src/cli/auditor-cmd.mjs';
import { runDiagnosticsCommand } from '../src/cli/diagnostics-cmd.mjs';
import { runFactoryDiagnostics } from '../src/cli/factory-diagnostics.mjs';
import { runDaemonStart } from '../src/cli/daemon-cmd.mjs';
import { runSessionStart } from '../src/hooks/session-start.mjs';
import { runUserPrompt } from '../src/hooks/user-prompt.mjs';
import { runPreToolUse } from '../src/hooks/pre-tool-use.mjs';
import { runStop } from '../src/hooks/stop.mjs';
import { runSessionEnd } from '../src/hooks/session-end.mjs';

const USAGE = `spotter — Claude Code tool-call auditor

Usage:
  spotter install [-y] [--auditor-context disabled|throughline]
                                        [--throughline-command ABS] [--throughline-arg VALUE]
                                        register hooks in <cwd>/.claude/settings.json
                                        and create <cwd>/.spotter/marker.json
                                        (Throughline on PATH enables context by default;
                                         pass disabled for a persistent project opt-out)
                                        (run inside each project you want audited)
  spotter install --user [-y]           legacy: register globally in ~/.claude/settings.json
                                        (NOT RECOMMENDED — fires for every Claude Code session
                                         on the system, including unrelated \`claude -p\`)
  spotter uninstall [-y]                remove spotter hooks from <cwd>/.claude/settings.json
                                        and remove <cwd>/.spotter/marker.json
  spotter uninstall --user [-y]         remove from ~/.claude/settings.json
  spotter db list [--host-agent HOST]   show host-local tool-db (claude by default)
  spotter db refresh [--host-agent HOST]
                                        discover MCP / skills / sub-agents and update DB
  spotter db rebuild [--host-agent HOST]
                                        wipe host-local + global DBs then refresh
  spotter status                        show running daemons
  spotter doctor                        environment diagnostic
  spotter diagnostics logs [--json]     summarize daemon logs for precision diagnostics
  spotter diagnostics runtime-errors [snapshot|ack|resolve|reopen|compact]
                                        consume the local allow-listed aggregate store
  spotter codex risk-check --findings FILE
                                        run read-only codex-sidecar risk analysis
  spotter codex review|explore|opinion --findings FILE
                                        run read-only codex-sidecar second-pass workflows
  spotter codex work --findings FILE --approve-work --allowed-path PATH
                                        run approved codex-sidecar worktree workflow
  spotter codex-hook install|uninstall|diagnostics
                                        (experimental) manage Codex native hooks
  spotter auditor judge --stage STAGE --input FILE
                                        (experimental) run primary auditor backend once
  spotter auditor matrix --stage STAGE --input FILE
                                        (experimental) compare primary auditor backend matrix
  spotter auditor model-matrix --fixtures FILE
                                        (experimental) evaluate pinned Codex auditor profiles
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
      const options = parseInstallArgs(rest);
      await runInstall(options);
      return;
    }
    case 'uninstall': {
      const target = rest.includes('--user') ? 'user' : 'project';
      const autoYes = rest.includes('-y') || rest.includes('--yes');
      await runUninstall({ target, autoYes });
      return;
    }
    case 'db': {
      const sub = rest[0];
      if (sub === 'list') { await runDbList({ argv: rest.slice(1) }); return; }
      if (sub === 'refresh') { await runDbRefresh({ argv: rest.slice(1) }); return; }
      if (sub === 'rebuild') { await runDbRebuild({ argv: rest.slice(1) }); return; }
      process.stderr.write(`unknown db subcommand: ${sub}\n${USAGE}`);
      process.exit(2);
      return;
    }
    case 'status':
      await runStatus();
      return;
    case 'doctor':
      await runDoctor();
      return;
    case 'codex':
      await runCodexCommand({ argv: rest });
      return;
    case 'codex-hook':
      await runCodexHookCommand({ argv: rest });
      return;
    case 'auditor':
      await runAuditorCommand({ argv: rest });
      return;
    case 'diagnostics':
      if (rest[0] === 'factory') {
        if (rest.length !== 1) throw invalidFactoryDiagnosticsArgs();
        process.stdout.write(`${JSON.stringify(await runFactoryDiagnostics())}\n`);
        return;
      }
      await runDiagnosticsCommand({ argv: rest });
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

function parseInstallArgs(argv) {
  let target = 'project';
  let autoYes = false;
  let mode = null;
  let command = null;
  const args = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--user') {
      if (target === 'user') throw invalidInstallArgs();
      target = 'user';
    } else if (arg === '-y' || arg === '--yes') {
      if (autoYes) throw invalidInstallArgs();
      autoYes = true;
    } else if (arg === '--auditor-context') {
      if (mode !== null) throw invalidInstallArgs();
      mode = argv[++index];
      if (mode !== 'disabled' && mode !== 'throughline') throw invalidInstallArgs();
    } else if (arg === '--throughline-command') {
      if (command !== null) throw invalidInstallArgs();
      command = argv[++index];
      if (typeof command !== 'string' || command.length === 0) throw invalidInstallArgs();
    } else if (arg === '--throughline-arg') {
      const value = argv[++index];
      if (typeof value !== 'string' || value.length === 0) throw invalidInstallArgs();
      args.push(value);
    } else {
      throw invalidInstallArgs();
    }
  }
  if (mode === null && (command !== null || args.length > 0)) throw invalidInstallArgs();
  if (mode === 'disabled' && (command !== null || args.length > 0)) throw invalidInstallArgs();
  if (mode === 'throughline' && (command === null || !isAbsoluteCommand(command) || isShellWrapper(command))) throw invalidInstallArgs();
  const auditorContext = mode === null ? undefined : mode === 'disabled'
    ? { mode: 'disabled', origin: 'explicit' }
    : { mode: 'throughline', command, args, origin: 'explicit' };
  return { target, autoYes, auditorContext };
}

function isAbsoluteCommand(value) {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
}

function isShellWrapper(value) {
  return /\.(?:cmd|bat)$/i.test(value);
}

function invalidInstallArgs() {
  const err = new Error('invalid install arguments');
  err.stack = '';
  err.exitCode = 2;
  return err;
}

function invalidFactoryDiagnosticsArgs() {
  const err = new Error('usage: spotter diagnostics factory');
  err.stack = '';
  err.exitCode = 2;
  return err;
}

main().catch((err) => {
  process.stderr.write(`spotter: ${err.stack || err.message || err}\n`);
  process.exit(err.exitCode ?? 2);
});
