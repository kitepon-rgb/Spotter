// Minimal YAML frontmatter parser for Claude Code skill / agent `.md` files.
//
// We only need to read top-level scalar string fields (`name`, `description`). No nesting,
// no arrays, no multi-line strings. Anything more complex is ignored safely. Zero deps by
// design — the Spotter project goal forbids a YAML library for this small need.
//
// Supported input:
//   ---
//   name: council
//   description: Convene a four-voice council ...
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
    // Strip surrounding quotes if present.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}
