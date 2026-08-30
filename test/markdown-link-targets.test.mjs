import assert from 'node:assert/strict';
import test from 'node:test';

import {
  markdownLinkTargets,
  missingPackedMarkdownTargets,
  relativeMarkdownLinkTargets,
} from '../scripts/markdown-link-targets.mjs';

test('nested link、括弧付きdestination、reference、HTML href/src/srcsetを全て列挙する', () => {
  const markdown = [
    '[![image](assets/image(one).png)](docs/outer(target).md)',
    '',
    '[reference]: docs/reference.md "title"',
    '[multiline]:',
    '  docs/multiline.md',
    '',
    '<a href="docs/from-html.md">guide</a>',
    '<video src="assets/demo.mp4"></video>',
    '<img src="assets/base.png" srcset="assets/small.png 1x, assets/large.png 2x">',
    '<source srcset="assets/mobile.png 480w, https://example.com/wide.png 960w">',
  ].join('\n');

  assert.deepEqual(markdownLinkTargets(markdown), [
    'docs/outer(target).md',
    'assets/image(one).png',
    'docs/reference.md',
    'docs/multiline.md',
    'docs/from-html.md',
    'assets/demo.mp4',
    'assets/base.png',
    'assets/small.png',
    'assets/large.png',
    'assets/mobile.png',
    'https://example.com/wide.png',
  ]);
});

test('npm tarballに無い相対targetをnested外側と改行referenceから拒否する', () => {
  const missing = missingPackedMarkdownTargets({
    markdownPath: 'README.md',
    markdown: [
      '[![present](assets/present.png)](docs/missing(outer).md)',
      '',
      '[guide]:',
      '  docs/missing-guide.md',
    ].join('\n'),
    packedPaths: new Set(['README.md', 'assets/present.png']),
  });

  assert.deepEqual(missing, [
    { target: 'docs/missing(outer).md', resolved: 'docs/missing(outer).md' },
    { target: 'docs/missing-guide.md', resolved: 'docs/missing-guide.md' },
  ]);
});

test('codeとcomment内の疑似linkを除外し、Markdown escapeをpathへ戻す', () => {
  const markdown = [
    '`[inline](missing-inline.md)`',
    '<!-- [comment](missing-comment.md) -->',
    '```md',
    '[fenced](missing-fenced.md)',
    '```',
    '[real](docs/a\\(b\\).md)',
  ].join('\n');

  assert.deepEqual(markdownLinkTargets(markdown), ['docs/a(b).md']);
});

test('fenceらしい本文行とdata-srcを実linkとして誤認しない', () => {
  const markdown = [
    '<video data-src="missing-data-src.mp4"></video>',
    '```md',
    '```not-a-closing-fence',
    '[still-fenced](missing-still-fenced.md)',
    '```',
  ].join('\n');

  assert.deepEqual(markdownLinkTargets(markdown), []);
});

test('閉じていないcitation bracketを次の段落の括弧へ接続しない', () => {
  const markdown = [
    'citation [Author et al., 2026,',
    '',
    'a Modular Architecture (MASAI) agents.',
  ].join('\n');

  assert.deepEqual(markdownLinkTargets(markdown), []);
});

test('CommonMark ASTとHTML tokenizerが監査再現を正しく分類する', () => {
  const markdown = [
    '    [indented-code](missing-indented.md)',
    '',
    '`` [real-after-unclosed-code](docs/real-inline.md) ```',
    '',
    '[foo\\]]: docs/escaped.md',
    '',
    '> [quoted]: docs/quoted.md',
    '',
    '- [listed]: docs/listed.md',
    '',
    '[invalid]: docs/invalid.md "unterminated',
    '',
    '[blank-line](',
    '',
    'docs/invalid-inline.md)',
    '',
    '[entity](assets/a&amp;b.png)',
    '',
    '<a title=\'example href="missing-title.md"\' href="docs/real.md">x</a>',
    '<a href="assets/html&amp;entity.md">entity</a>',
    '<img srcset="assets/crop,wide.png 1x, assets/next.png 2x">',
  ].join('\n');

  assert.deepEqual(relativeMarkdownLinkTargets(markdown), [
    'docs/real-inline.md',
    'docs/escaped.md',
    'docs/quoted.md',
    'docs/listed.md',
    'assets/a&b.png',
    'docs/real.md',
    'assets/html&entity.md',
    'assets/crop,wide.png',
    'assets/next.png',
  ]);
});
