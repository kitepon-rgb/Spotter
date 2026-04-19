// Tool catalog schema validation.
// §0 rule: catalog shape violations throw. No silent coercion, no defaults-that-hide-bugs.

const REQUIRED_TOOL_FIELDS = ['name', 'purpose', 'when_to_use'];
const REQUIRED_TEST_CASE_FIELDS = ['user_input', 'expected_tool'];

export class CatalogSchemaError extends Error {
  constructor(message, path) {
    super(`catalog schema violation at ${path}: ${message}`);
    this.name = 'CatalogSchemaError';
    this.path = path;
  }
}

export function validateCatalog(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CatalogSchemaError('root must be an object', '$');
  }
  if (raw.version !== 1) {
    throw new CatalogSchemaError(`version must be 1, got ${JSON.stringify(raw.version)}`, '$.version');
  }
  if (!Array.isArray(raw.tools)) {
    throw new CatalogSchemaError('tools must be an array', '$.tools');
  }
  if (raw.tools.length === 0) {
    throw new CatalogSchemaError('tools must contain at least one entry', '$.tools');
  }

  const seen = new Set();
  raw.tools.forEach((tool, i) => validateTool(tool, `$.tools[${i}]`, seen));

  return raw;
}

function validateTool(tool, path, seen) {
  if (tool === null || typeof tool !== 'object' || Array.isArray(tool)) {
    throw new CatalogSchemaError('tool entry must be an object', path);
  }
  for (const field of REQUIRED_TOOL_FIELDS) {
    if (!(field in tool)) {
      throw new CatalogSchemaError(`missing required field "${field}"`, path);
    }
  }
  if (typeof tool.name !== 'string' || tool.name.length === 0) {
    throw new CatalogSchemaError('name must be a non-empty string', `${path}.name`);
  }
  if (seen.has(tool.name)) {
    throw new CatalogSchemaError(`duplicate tool name "${tool.name}"`, `${path}.name`);
  }
  seen.add(tool.name);

  if (typeof tool.purpose !== 'string' || tool.purpose.trim().length === 0) {
    throw new CatalogSchemaError('purpose must be a non-empty string', `${path}.purpose`);
  }
  if (!Array.isArray(tool.when_to_use) || tool.when_to_use.length === 0) {
    throw new CatalogSchemaError('when_to_use must be a non-empty array', `${path}.when_to_use`);
  }
  tool.when_to_use.forEach((entry, i) => {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new CatalogSchemaError('when_to_use entries must be non-empty strings', `${path}.when_to_use[${i}]`);
    }
  });

  if ('test_cases' in tool) {
    if (!Array.isArray(tool.test_cases)) {
      throw new CatalogSchemaError('test_cases must be an array', `${path}.test_cases`);
    }
    tool.test_cases.forEach((tc, i) => validateTestCase(tc, `${path}.test_cases[${i}]`));
  }
}

function validateTestCase(tc, path) {
  if (tc === null || typeof tc !== 'object' || Array.isArray(tc)) {
    throw new CatalogSchemaError('test case must be an object', path);
  }
  for (const field of REQUIRED_TEST_CASE_FIELDS) {
    if (!(field in tc)) {
      throw new CatalogSchemaError(`missing required field "${field}"`, path);
    }
  }
  if (typeof tc.user_input !== 'string' || tc.user_input.length === 0) {
    throw new CatalogSchemaError('user_input must be a non-empty string', `${path}.user_input`);
  }
  if (typeof tc.expected_tool !== 'string' || tc.expected_tool.length === 0) {
    throw new CatalogSchemaError('expected_tool must be a non-empty string', `${path}.expected_tool`);
  }
}

// Projection for Haiku first-stage judgement (§6.3).
export function projectForFirstStage(catalog) {
  return catalog.tools.map((tool) => ({
    name: tool.name,
    purpose: tool.purpose,
    when_to_use: tool.when_to_use,
  }));
}

// Projection for Haiku final-stage judgement — adds usage/examples when name matches.
export function projectForFinalStage(catalog, candidateNames) {
  return catalog.tools
    .filter((tool) => candidateNames.includes(tool.name))
    .map((tool) => ({
      name: tool.name,
      purpose: tool.purpose,
      when_to_use: tool.when_to_use,
      usage: tool.usage ?? null,
      examples: tool.examples ?? [],
    }));
}
