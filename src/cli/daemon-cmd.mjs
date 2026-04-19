// `spotter daemon start|stop` — internal commands invoked by SessionStart/SessionEnd hooks.

import { startDaemon, DaemonAlreadyRunningError } from '../daemon/daemon.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { open } from 'node:fs/promises';

function parseArgs(argv) {
  const out = { sessionId: null, parentPid: null, projectRoot: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--session-id') {
      out.sessionId = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--parent-pid') {
      const n = parseInt(argv[i + 1], 10);
      if (Number.isInteger(n) && n > 0) out.parentPid = n;
      i += 1;
    } else if (argv[i] === '--project-root') {
      out.projectRoot = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

export async function runDaemonStart({ argv }) {
  const { sessionId, parentPid, projectRoot } = parseArgs(argv);
  if (!sessionId) {
    process.stderr.write('spotter daemon start: --session-id is required\n');
    process.exit(2);
  }
  if (!projectRoot) {
    process.stderr.write('spotter daemon start: --project-root is required (the path containing .spotter/marker.json)\n');
    process.exit(2);
  }

  const logFile = await open(
    join(homedir(), '.spotter', 'logs', `daemon-${sessionId}.log`),
    'a'
  );
  const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    logFile.write(line).catch(() => {});
  };

  let running;
  try {
    // v0.5.0: no warmup. Session-scoped Haiku (--resume on follow-ups) pays cold-start
    // only on the first real call; warmup added complexity for marginal benefit and is
    // removed along with the stateless regime that required it.
    // v0.6.2: parentPid (Claude Code PID, captured by SessionStart hook as process.ppid)
    // is threaded in so the daemon self-terminates when the parent dies without
    // SessionEnd (crash / kill / IDE reload).
    // v0.7.0: projectRoot drives tool-db loading (replaces the old tools.yaml catalog).
    running = await startDaemon({ sessionId, projectRoot, parentPid, logFn: log });
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
