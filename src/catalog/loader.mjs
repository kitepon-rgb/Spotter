import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import { validateCatalog, CatalogSchemaError } from './schema.mjs';

export class CatalogLoadError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'CatalogLoadError';
    if (cause) this.cause = cause;
  }
}

export async function loadCatalog(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new CatalogLoadError(`catalog not found: ${path}`, err);
    }
    throw new CatalogLoadError(`cannot read catalog: ${path}`, err);
  }

  let parsed;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    throw new CatalogLoadError(`yaml parse failed in ${path}: ${err.message}`, err);
  }

  // schema errors propagate as CatalogSchemaError — the caller can distinguish them
  validateCatalog(parsed);
  return parsed;
}

export { CatalogSchemaError };
