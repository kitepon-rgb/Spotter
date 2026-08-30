import { execFileSync } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { relativeMarkdownLinkTargets } from './markdown-link-targets.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const packageLock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
const version = packageJson.version;
const stubMarker = '履歴参照stub';

if (packageLock.version !== version || packageLock.packages?.['']?.version !== version) {
  failures.push('package.json and package-lock.json release versions must match');
}

await requireText('CLAUDE.md', '@AGENTS.md\n', { exact: true });
await requireText('README.md', '**Node.js 22.13+**');
await requireText('README.ja.md', '**Node.js 22.13 以上**');
await requireText('docs/00_overview.md', '## 現行契約');
await requireText('docs/open-issues.md', '現在の未完事項だけを記録する');
await requireText('docs/10_spotter-dashboard-plan.md', 'immutableな`narrative_ref`');
await requireText('docs/11_dashboard-operations.md', 'service設定の正本');
await requireText('AGENTS.md', '## 文書の寿命');
await requireText('CHANGELOG.md', `## ${version} —`);

if (packageJson.engines?.node !== '>=22.13.0') {
  failures.push(`package.json: engines.node must remain >=22.13.0 (actual: ${packageJson.engines?.node ?? 'missing'})`);
}

const markdownFiles = await listMarkdown(root);
let checkedLinks = 0;
for (const file of markdownFiles) {
  const repoPath = relative(root, file).split(sep).join('/');
  const text = await readFile(file, 'utf8');
  for (const target of relativeMarkdownLinkTargets(text)) {
    checkedLinks += 1;
    const localPath = resolve(dirname(file), target);
    try {
      await access(localPath);
    } catch {
      failures.push(`${repoPath}: missing local link target ${target}`);
    }
  }
}

const docsRoot = join(root, 'docs');
const overviewPath = join(docsRoot, '00_overview.md');
const overviewText = await readFile(overviewPath, 'utf8');
const overviewTargets = new Set(localLinkTargets(overviewPath, overviewText));
const topLevelDocs = (await readdir(docsRoot, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
  .map((entry) => join(docsRoot, entry.name))
  .sort();
const stubs = new Map();
for (const file of topLevelDocs) {
  const text = await readFile(file, 'utf8');
  if (isHistoryStub(text)) stubs.set(repoPathOf(file), text);
  else if (file !== overviewPath && !overviewTargets.has(resolve(file))) {
    failures.push(`docs/00_overview.md: current document ${repoPathOf(file)} is not indexed`);
  }
}

const archiveRoot = join(docsRoot, 'archive');
const archiveIndexPath = join(archiveRoot, 'README.md');
const archiveIndexText = await readFile(archiveIndexPath, 'utf8');
const archiveIndexTargets = new Set(localLinkTargets(archiveIndexPath, archiveIndexText));
const archiveFiles = (await readdir(archiveRoot, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md')
  .map((entry) => join(archiveRoot, entry.name))
  .sort();
for (const file of archiveFiles) {
  if (!archiveIndexTargets.has(resolve(file))) {
    failures.push(`docs/archive/README.md: archived document ${repoPathOf(file)} is not indexed`);
  }
}

for (const [stubPath, text] of stubs) {
  const archivePath = join(archiveRoot, stubPath.slice('docs/'.length));
  try {
    await access(archivePath);
  } catch {
    failures.push(`${stubPath}: matching archive ${repoPathOf(archivePath)} is missing`);
    continue;
  }
  if (!new Set(localLinkTargets(join(root, stubPath), text)).has(resolve(archivePath))) {
    failures.push(`${stubPath}: link to ${repoPathOf(archivePath)} is missing`);
  }
}

for (const fixedPath of fixedHistoricalDocumentReferences()) {
  if (!fixedPath.startsWith('docs/') || fixedPath.startsWith('docs/archive/')) continue;
  const basename = fixedPath.slice('docs/'.length);
  if (basename.includes('/')) continue;
  try {
    await access(join(archiveRoot, basename));
  } catch {
    continue;
  }
  if (!stubs.has(fixedPath)) {
    failures.push(`${fixedPath}: fixed reference remains, so a history reference stub is required`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exit(1);
}

process.stdout.write(`documentation verification: ok (${markdownFiles.length} Markdown files, ${checkedLinks} local links)\n`);

async function requireText(repoPath, expected, { exact = false } = {}) {
  const content = await readFile(join(root, repoPath), 'utf8');
  const valid = exact
    ? content.replaceAll('\r\n', '\n') === expected.replaceAll('\r\n', '\n')
    : content.includes(expected);
  if (!valid) failures.push(`${repoPath}: missing canonical text ${JSON.stringify(expected)}`);
}

async function listMarkdown(directory) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['.git', '.lattice', '.spotter', '.claude', '.codex', 'node_modules'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...await listMarkdown(path));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(path);
  }
  return out;
}

function localLinkTargets(file, text) {
  return relativeMarkdownLinkTargets(text).map((target) => resolve(dirname(file), target));
}

function fixedHistoricalDocumentReferences() {
  let stdout;
  try {
    stdout = execFileSync('git', [
      'grep', '-I', '-h', '-o', '-E', 'docs/[A-Za-z0-9_./-]+\\.md', '--',
      ':(exclude)docs/archive/**',
    ], { cwd: root, encoding: 'utf8' });
  } catch (error) {
    if (error.status === 1) return [];
    throw error;
  }
  return [...new Set(stdout.split('\n').filter(Boolean))].sort();
}

function isHistoryStub(text) {
  return text.split('\n', 1)[0].includes(stubMarker);
}

function repoPathOf(file) {
  return relative(root, file).split(sep).join('/');
}
