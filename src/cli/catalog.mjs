// `spotter catalog edit|lint`
//
// edit: open the catalog in $EDITOR
// lint: validate schema + run test_cases against live Haiku (v0.1 completion metric)

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runLint } from '../catalog/lint.mjs';
import { createHaikuCaller } from '../daemon/haiku-caller.mjs';

const CATALOG_PATH = join(homedir(), '.spotter', 'tool-catalog', 'tools.yaml');

export async function runCatalogEdit() {
  const editor = process.env.EDITOR || process.env.VISUAL || defaultEditor();
  await new Promise((resolve, reject) => {
    const child = spawn(editor, [CATALOG_PATH], { stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`editor exited with ${code}`))));
    child.on('error', reject);
  });
}

function defaultEditor() {
  return process.platform === 'win32' ? 'notepad' : 'vi';
}

export async function runCatalogLint({ catalogPath = CATALOG_PATH } = {}) {
  const haikuCaller = createHaikuCaller({ timeoutMs: 30_000 });
  const result = await runLint({
    catalogPath,
    haikuCaller,
    writeLine: (s) => console.log(s),
  });
  if (result.failed > 0) {
    process.exit(1);
  }
}
