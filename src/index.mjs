// Public entry for programmatic use (e.g. `import { startDaemon } from 'claude-spotter'`).

export { startDaemon } from './daemon/daemon.mjs';
export {
  sendRequest,
  TransportError,
  socketPath,
} from './daemon/transport.mjs';
export {
  buildFirstStagePrompt,
  buildFinalStagePrompt,
  parseHaikuResponse,
  createHaikuCaller,
  HaikuError,
} from './daemon/haiku-caller.mjs';
export { loadCatalog, CatalogLoadError, CatalogSchemaError } from './catalog/loader.mjs';
export { validateCatalog } from './catalog/schema.mjs';
export { runLint } from './catalog/lint.mjs';
export { version } from './version.mjs';
