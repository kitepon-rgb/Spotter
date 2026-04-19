// `spotter daemon start|stop` — internal commands invoked by SessionStart/SessionEnd hooks.

import { startDaemon, DaemonAlreadyRunningError } from '../daemon/daemon.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { open } from 'node:fs/promises';

function parseArgs(argv) {
  const out = { sessionId: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--session-id') {
      out.sessionId = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

export async function runDaemonStart({ argv }) {
  const { sessionId } = parseArgs(argv);
  if (!sessionId) {
    process.stderr.write('spotter daemon start: --session-id is required\n');
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
    running = await startDaemon({ sessionId, logFn: log });
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
