// `spotter daemon start|stop` — internal commands invoked by SessionStart/SessionEnd hooks.

import { startDaemon } from '../daemon/daemon.mjs';
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

  const running = await startDaemon({ sessionId, logFn: log });
  log(`started on ${running.path}`);

  // Keep process alive; SessionEnd → shutdown event triggers server.close() which resolves the await.
  await new Promise((resolve) => running.server.on('close', resolve));
  log('server closed, exiting');
}
