import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

test('Markdown-only変更は製品所有の文書gateを必ず実行する', async () => {
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  const caller = await readFile(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
  const reusable = await readFile(
    path.join(repoRoot, '.github/workflows/product-full-ci.yml'),
    'utf8',
  );

  assert.equal(
    packageJson.scripts?.['verify:docs'],
    'node scripts/verify-docs.mjs && node scripts/verify-packed-markdown.mjs && node --test test/ci-contract.test.mjs test/markdown-link-targets.test.mjs',
  );
  for (const dependency of [
    'unified',
    'remark-parse',
    'remark-gfm',
    'micromark-util-decode-string',
  ]) assert.equal(typeof packageJson.devDependencies?.[dependency], 'string');
  assert.match(caller, /uses:\s+\.\/\.github\/workflows\/product-full-ci\.yml/u);
  assert.match(
    caller,
    /documentation-command:\s+npm ci --ignore-scripts --no-audit --no-fund && npm run verify:docs/u,
  );
  assert.doesNotMatch(caller, /kitepon\/dotagents\/\.github\/workflows/u);
  assert.match(
    reusable,
    /if:\s+steps\.changes\.outputs\.product_change == 'false' && inputs\.documentation-command != ''/u,
  );
  assert.match(reusable, /run:\s+\$\{\{ inputs\.documentation-command \}\}/u);
  const packedVerifier = await readFile(
    path.join(repoRoot, 'scripts/verify-packed-markdown.mjs'),
    'utf8',
  );
  assert.match(packedVerifier, /'pack', '--dry-run', '--ignore-scripts', '--json'/u);
  assert.match(packedVerifier, /packed Markdown closure/u);
  assert.match(packedVerifier, /missingPackedMarkdownTargets/u);
});

test('windows-nativeの全commandはPowerShell 7だけで実行する', async () => {
  const reusable = await readFile(
    path.join(repoRoot, '.github/workflows/product-full-ci.yml'),
    'utf8',
  );
  const windowsSteps = [...reusable.matchAll(
    /if:\s+[^\n]*matrix\.environment == 'windows-native'[\s\S]*?(?=\n      - name:|$)/gu,
  )];

  assert.equal(windowsSteps.length, 3);
  for (const step of windowsSteps) assert.match(step[0], /shell:\s+pwsh/u);
  assert.doesNotMatch(reusable, /(?:bash|cmd|powershell)(?:\.exe)?[^\n]*\{0\}/iu);
});

test('release versionはpackage、lock、CHANGELOGで同期する', async () => {
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  const packageLock = JSON.parse(await readFile(path.join(repoRoot, 'package-lock.json'), 'utf8'));
  const changelog = await readFile(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');

  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages?.['']?.version, packageJson.version);
  assert.match(changelog, new RegExp(`^## ${packageJson.version} —`, 'mu'));
});
