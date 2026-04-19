// tool-db: read/write JSON files holding {name -> description} pairs.
//
// Two layers:
//   - local:  <project>/.spotter/tool-db.json
//   - global: ~/.spotter/tool-db.json
//
// Both have the same shape:
//   { "version": 1, "tools": { "<name>": "<description>", ... } }
//
// §0: schema violations throw. Empty/missing files are tolerated (return empty db).

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export class ToolDbSchemaError extends Error {
  constructor(message, path) {
    super(`tool-db schema violation at ${path}: ${message}`);
    this.name = 'ToolDbSchemaError';
    this.path = path;
  }
}

export function globalDbPath() {
  return join(homedir(), '.spotter', 'tool-db.json');
}

export function localDbPath(projectRoot) {
  return join(projectRoot, '.spotter', 'tool-db.json');
}

// Load a DB file. Missing file → returns empty db (this is normal, not an error).
// Malformed JSON or wrong shape → throws ToolDbSchemaError.
export async function loadDb(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return emptyDb();
    throw err;
  }
  if (raw.trim().length === 0) return emptyDb();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ToolDbSchemaError(`invalid JSON: ${err.message}`, path);
  }
  return validateDb(parsed, path);
}

// Atomically write a DB file. Creates parent dir if missing.
// Atomic = write to .tmp then rename (POSIX rename is atomic on same filesystem;
// on Windows this is also effectively atomic for replace-or-create).
export async function saveDb(path, db) {
  validateDb(db, path);
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, JSON.stringify(db, null, 2) + '\n', 'utf8');
  await rename(tmpPath, path);
}

export function emptyDb() {
  return { version: 1, tools: {} };
}

function validateDb(raw, path) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ToolDbSchemaError('root must be an object', path);
  }
  if (raw.version !== 1) {
    throw new ToolDbSchemaError(`version must be 1, got ${JSON.stringify(raw.version)}`, path);
  }
  if (raw.tools === null || typeof raw.tools !== 'object' || Array.isArray(raw.tools)) {
    throw new ToolDbSchemaError('tools must be an object', `${path}.tools`);
  }
  for (const [name, desc] of Object.entries(raw.tools)) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new ToolDbSchemaError('tool name must be non-empty string', `${path}.tools`);
    }
    if (typeof desc !== 'string' || desc.length === 0) {
      throw new ToolDbSchemaError(`tool "${name}" description must be non-empty string`, `${path}.tools.${name}`);
    }
  }
  return raw;
}
