// Minimal YAML frontmatter parser for Claude Code skill / agent `.md` files.
//
// We only need to read top-level scalar string fields (`name`, `description`) plus simple
// block scalars (`|` and `>`). No nesting or arrays. Anything more complex is ignored
// safely. Zero deps by design — the Spotter project goal forbids a YAML library for this
// small need.
//
// Supported input:
//   ---
//   name: council
//   description: Convene a four-voice council ...
//   description: >
//     Convene a four-voice council
//     for ambiguous decisions.
//   origin: ECC
//   ---
//   <body...>
//
// Returns an object of frontmatter fields; unparseable / absent frontmatter → {}.

import { readFile } from 'node:fs/promises';

const FENCE = '---';

export async function readFrontmatter(path) {
  const text = await readFile(path, 'utf8');
  return parseFrontmatter(text);
}

export function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== FENCE) return {};
  const out = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === FENCE) break;
    const colonIdx = line.indexOf(':');
    if (colonIdx <= 0) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    if (value.length === 0) continue;
    if (/^[>|][-+]?$/u.test(value)) {
      const parsed = readBlockScalar(lines, i + 1, value[0]);
      if (parsed.value.length > 0) {
        out[key] = parsed.value;
      }
      i = parsed.nextIndex - 1;
      continue;
    }
    // Strip surrounding quotes if present.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function readBlockScalar(lines, startIndex, style) {
  const indent = findBlockIndent(lines, startIndex);
  if (indent === null) return { value: '', nextIndex: startIndex };

  const blockLines = [];
  let index = startIndex;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === FENCE) break;
    if (line.trim().length > 0 && leadingSpaces(line) < indent) break;
    blockLines.push(line.startsWith(' '.repeat(indent)) ? line.slice(indent) : '');
  }

  return {
    value: style === '>' ? foldBlockLines(blockLines) : blockLines.join('\n').trimEnd(),
    nextIndex: index,
  };
}

function findBlockIndent(lines, startIndex) {
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === FENCE) return null;
    if (line.trim().length === 0) continue;
    const indent = leadingSpaces(line);
    return indent > 0 ? indent : null;
  }
  return null;
}

function leadingSpaces(line) {
  return line.length - line.trimStart().length;
}

function foldBlockLines(lines) {
  const paragraphs = [];
  let current = [];
  for (const line of lines) {
    if (line.trim().length === 0) {
      if (current.length > 0) {
        paragraphs.push(current.join(' '));
        current = [];
      }
      continue;
    }
    current.push(line.trim());
  }
  if (current.length > 0) paragraphs.push(current.join(' '));
  return paragraphs.join('\n').trimEnd();
}
