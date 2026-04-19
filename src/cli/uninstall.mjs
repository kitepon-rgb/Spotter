// `spotter uninstall` — remove hook entries that reference this spotter installation.
// Does NOT delete ~/.spotter/ (user data), just unregisters hooks.

import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

export async function runUninstall({ target = 'project', autoYes = false, cwd = process.cwd() } = {}) {
  const settingsPath = target === 'user'
    ? join(homedir(), '.claude', 'settings.json')
    : join(cwd, '.claude', 'settings.json');

  console.log(`spotter uninstall (settings: ${settingsPath})`);

  let current;
  try {
    current = JSON.parse(await readFile(settingsPath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log('  no settings.json present — nothing to uninstall');
      return;
    }
    throw err;
  }

  if (!current.hooks) {
    console.log('  no hooks block present — nothing to uninstall');
    return;
  }

  const updated = structuredClone(current);
  let removed = 0;
  for (const [event, groups] of Object.entries(updated.hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = [];
    for (const g of groups) {
      if (!Array.isArray(g?.hooks)) { kept.push(g); continue; }
      const filtered = g.hooks.filter((h) => !(h?.type === 'command' && h?.command?.includes('spotter.mjs')));
      if (filtered.length > 0) {
        kept.push({ ...g, hooks: filtered });
      } else {
        removed += g.hooks.length;
      }
    }
    if (kept.length > 0) {
      updated.hooks[event] = kept;
    } else {
      delete updated.hooks[event];
    }
  }
  if (Object.keys(updated.hooks).length === 0) {
    delete updated.hooks;
  }

  if (JSON.stringify(current) === JSON.stringify(updated)) {
    console.log('  no spotter hooks found — nothing to remove');
    return;
  }

  console.log(`  will remove ${removed} spotter hook entries`);
  if (!autoYes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('apply? [y/N] ');
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log('aborted.');
      return;
    }
  }

  await writeFile(settingsPath, JSON.stringify(updated, null, 2) + '\n', 'utf8');
  console.log(`wrote ${settingsPath}`);
  console.log('note: ~/.spotter/ (catalog, logs) was not removed. delete manually if no longer needed.');
}
