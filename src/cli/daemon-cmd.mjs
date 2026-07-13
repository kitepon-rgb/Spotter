// `spotter daemon start|stop` — internal commands invoked by SessionStart/SessionEnd hooks.

import { startDaemon, DaemonAlreadyRunningError } from '../daemon/daemon.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { open } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { observeRuntimeErrorIsolatedSafe } from '../core/runtime-error-store.mjs';

function parseArgs(argv) {
  const out = { sessionId: null, projectRoot: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--session-id') {
      out.sessionId = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--project-root') {
      out.projectRoot = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

export async function runDaemonStart({ argv }) {
  const { sessionId, projectRoot } = parseArgs(argv);
  if (!sessionId) {
    process.stderr.write('spotter daemon start: --session-id is required\n');
    process.exit(2);
  }
  if (!projectRoot) {
    process.stderr.write('spotter daemon start: --project-root is required (the path containing .spotter/marker.json)\n');
    process.exit(2);
  }

  const logFilePath = join(homedir(), '.spotter', 'logs', `daemon-${sessionId}.log`);

  // v0.13.2: last-resort fatal handlers. Without these, an uncaughtException or
  // unhandledRejection silently kills the daemon and the regular logFile.write()
  // (async) loses the trailing line on sudden death — leaving zero forensic
  // trace. We do a sync append so the cause is always captured before exit.
  // See open-issues.md "daemon プロセスが shutdown ログなしに死ぬ".
  const fatalLog = (kind, err) => {
    const detail = err && err.stack ? err.stack : String(err);
    const line = `[${new Date().toISOString()}] FATAL ${kind}: ${detail}\n`;
    try {
      writeFileSync(logFilePath, line, { flag: 'a' });
    } catch {
      process.stderr.write(line);
    }
  };
  process.on('uncaughtException', (err) => {
    fatalLog('uncaughtException', err);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    fatalLog('unhandledRejection', reason);
    process.exit(1);
  });

  const logFile = await open(logFilePath, 'a');
  const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    logFile.write(line).catch(() => {});
  };

  let running;
  try {
    // v0.5.0: no warmup. Session-scoped Haiku (--resume on follow-ups) pays cold-start
    // only on the first real call; warmup added complexity for marginal benefit and is
    // removed along with the stateless regime that required it.
    // v0.7.0: projectRoot drives tool-db loading (replaces the old tools.yaml catalog).
    // v0.12.0: orphan-cleanup is heartbeat-based inside startDaemon (no parent-PID arg).
    running = await startDaemon({
      sessionId,
      projectRoot,
      logFn: log,
      runtimeErrorObserver: observeRuntimeErrorIsolatedSafe,
    });
  } catch (err) {
    if (err instanceof DaemonAlreadyRunningError) {
      // v0.2 PID-preexist layer: a sibling daemon already serves this session.
      // Exit cleanly so the hook's readiness poll finds the existing one.
      log(`startup skipped: ${err.message}`);
      await logFile.close();
      process.exit(0);
    }
    throw err;
  }
  log(`started on ${running.path}`);

  // Keep process alive; SessionEnd → shutdown event triggers server.close() which resolves the await.
  await new Promise((resolve) => running.server.on('close', resolve));
  log('server closed, exiting');
}
