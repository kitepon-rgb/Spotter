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
export { legacyResultFromJudgment, toSpotterFinding, toSpotterJudgment } from './core/judgment.mjs';
export {
  createSidecarResultRecord,
  spotterFindingsToSidecarContextBlocks,
  spotterFindingToSidecarContextBlock,
} from './core/sidecar-context.mjs';
export {
  buildDiagnosticsCommand,
  buildSidecarSpawnOptions,
  classifySidecarAvailability,
  decideCodexSidecarUse,
  detectHostAgent,
  workCapabilitySmokeFromDiagnostics,
} from './core/codex-sidecar-policy.mjs';
export {
  dispatchCodexRiskCheck,
  isCodexRiskDispatchDryRun,
  isCodexRiskDispatchEnabled,
} from './core/codex-risk-dispatch.mjs';
export {
  readFindingsJson,
  runCodexExplore,
  runCodexOpinion,
  runCodexReadOnlyWorkflow,
  runCodexReview,
  runCodexRiskCheck,
  runCodexWork,
} from './core/codex-sidecar-runner.mjs';
export {
  defaultDaemonLogDir,
  summarizeDaemonLogText,
  summarizeDaemonLogs,
} from './core/daemon-log-diagnostics.mjs';
export { loadDb, saveDb, emptyDb, ToolDbSchemaError, globalDbPath, localDbPath } from './tool-db/loader.mjs';
export { resolveAll } from './tool-db/lookup.mjs';
export { refresh, readLocal, buildInvestigationSnapshot } from './tool-db/refresh.mjs';
export { listMcpServers, listMcpToolsAll, bellVisibleName, McpInvestigationError } from './tool-db/investigate-mcp.mjs';
export { listSkillsAll, listActivePlugins } from './tool-db/investigate-skills.mjs';
export { listAgentsAll } from './tool-db/investigate-agents.mjs';
export { version } from './version.mjs';
