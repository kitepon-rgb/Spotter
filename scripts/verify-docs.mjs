import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const version = packageJson.version;

await requireText('CLAUDE.md', '@AGENTS.md\n', { exact: true });
await requireText('README.md', '**Node.js 22.13+**');
await requireText('README.ja.md', '**Node.js 22.13 以上**');
await requireText('docs/00_overview.md', `Current production release: **v${version}**`);
await requireText('docs/open-issues.md', `Spotter v${version}`);
await requireText('docs/10_spotter-dashboard-plan.md', `claude-spotter@${version}`);
await requireText('docs/11_dashboard-operations.md', `**v${version}**`);
await requireText('AGENTS.md', `> **v${version}`);
await requireText('CHANGELOG.md', `## ${version} —`);

if (packageJson.engines?.node !== '>=22.13.0') {
  failures.push(`package.json: engines.node must remain >=22.13.0 (actual: ${packageJson.engines?.node ?? 'missing'})`);
}

const markdownFiles = await listMarkdown(root);
let checkedLinks = 0;
for (const file of markdownFiles) {
  const repoPath = relative(root, file).split(sep).join('/');
  if (repoPath.includes('/raw/')) continue;
  const lines = (await readFile(file, 'utf8')).split('\n');
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const withoutCode = line.replace(/`[^`]*`/g, '');
    for (const match of withoutCode.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = normalizeLinkTarget(match[1]);
      if (!target) continue;
      checkedLinks += 1;
      const localPath = resolve(dirname(file), target);
      try {
        await access(localPath);
      } catch {
        failures.push(`${repoPath}:${index + 1}: missing local link target ${target}`);
      }
    }
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
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.spotter') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...await listMarkdown(path));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(path);
  }
  return out;
}

function normalizeLinkTarget(raw) {
  let target = raw.trim();
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
  target = target.split(/\s+["']/u, 1)[0];
  if (
    target === '...' ||
    target.startsWith('#') ||
    target.startsWith('/') ||
    /^(?:https?:|mailto:|file:)/u.test(target)
  ) return null;
  target = target.split('#', 1)[0];
  if (!target) return null;
  try {
    return decodeURIComponent(target);
  } catch {
    failures.push(`invalid percent-encoding in Markdown link: ${target}`);
    return null;
  }
}
