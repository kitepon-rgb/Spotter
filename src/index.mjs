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
export { loadDb, saveDb, emptyDb, ToolDbSchemaError, globalDbPath, localDbPath } from './tool-db/loader.mjs';
export { resolveAll } from './tool-db/lookup.mjs';
export { refresh, readMerged, buildInvestigationSnapshot } from './tool-db/refresh.mjs';
export { listMcpServers, listMcpToolsAll, bellVisibleName, McpInvestigationError } from './tool-db/investigate-mcp.mjs';
export { DEFERRED_TOOL_BASELINE, getDeferredDescription, listDeferredNames } from './tool-db/deferred-baseline.mjs';
export { version } from './version.mjs';
