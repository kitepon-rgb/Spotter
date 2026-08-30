#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  missingPackedMarkdownTargets,
  relativeMarkdownLinkTargets,
} from './markdown-link-targets.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const packed = spawnSync(
  npmCommand,
  ['pack', '--dry-run', '--ignore-scripts', '--json'],
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
);

if (packed.error) throw packed.error;
if (packed.status !== 0) {
  process.stderr.write(packed.stderr || packed.stdout);
  process.exit(packed.status ?? 1);
}

let report;
try {
  report = JSON.parse(packed.stdout);
} catch (error) {
  throw new Error(`npm pack --dry-run did not return JSON: ${error.message}`);
}
if (!Array.isArray(report) || report.length !== 1 || !Array.isArray(report[0]?.files)) {
  throw new Error('npm pack --dry-run returned an unexpected report shape');
}

const packedPaths = new Set(report[0].files.map(({ path: packedPath }) => packedPath));
const markdownPaths = [...packedPaths].filter((packedPath) => packedPath.endsWith('.md')).sort();
const failures = [];
let checkedTargets = 0;

for (const markdownPath of markdownPaths) {
  const text = await readFile(path.join(ROOT, ...markdownPath.split('/')), 'utf8');
  for (const { target } of missingPackedMarkdownTargets({
    markdownPath,
    markdown: text,
    packedPaths,
  })) {
    failures.push(`${markdownPath}: packed relative target is missing: ${target}`);
  }
  checkedTargets += relativeMarkdownLinkTargets(text).length;
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exit(1);
}

process.stdout.write(
  `packed Markdown closure: ok (${markdownPaths.length} Markdown files, `
  + `${checkedTargets} relative targets, ${packedPaths.size} packed files)\n`,
);
