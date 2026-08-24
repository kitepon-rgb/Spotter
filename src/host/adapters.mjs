// AIベンダー（host agent）依存の決定点の唯一の置き場。
// 「どのhostがどのtool-db fileを持ち、どのdiscovery経路でsnapshotを作るか」は
// このtableだけが知る。呼び出し側（loader / refresh / CLI）は adapter を引いて
// 使うだけで、`if (hostAgent === 'codex')` 分岐を業務ロジックに書かない。
//
// ベンダー固有の実装本体は investigate-claude.mjs / investigate-codex.mjs /
// investigate-cursor.mjs が持つ。片方のhostのrefreshがもう片方のDBをprune /
// overwriteしない契約（AGENTS.md「ツールカタログはhost-local tool-db」）はこの分離が担保する。

import { buildInvestigationSnapshot } from '../tool-db/investigate-claude.mjs';
import { buildCodexInvestigationSnapshot } from '../tool-db/investigate-codex.mjs';
import { buildCursorInvestigationSnapshot } from '../tool-db/investigate-cursor.mjs';

const CLAUDE_ADAPTER = Object.freeze({
  hostAgent: 'claude',
  toolDbFileName: 'tool-db.json',
  buildSnapshot: ({ logFn, claudeBin, projectRoot }) =>
    buildInvestigationSnapshot({ logFn, claudeBin, projectRoot }),
});

const CODEX_ADAPTER = Object.freeze({
  hostAgent: 'codex',
  toolDbFileName: 'tool-db.codex.json',
  buildSnapshot: ({ logFn, codexBin, projectRoot }) =>
    buildCodexInvestigationSnapshot({ logFn, codexBin, projectRoot }),
});

// automation (CI等) は従来からClaude経路のdiscoveryを使い、DB fileだけ分離する。
const AUTOMATION_ADAPTER = Object.freeze({
  hostAgent: 'automation',
  toolDbFileName: 'tool-db.automation.json',
  buildSnapshot: ({ logFn, claudeBin, projectRoot }) =>
    buildInvestigationSnapshot({ logFn, claudeBin, projectRoot }),
});

const CURSOR_ADAPTER = Object.freeze({
  hostAgent: 'cursor',
  toolDbFileName: 'tool-db.cursor.json',
  buildSnapshot: ({ logFn, projectRoot }) =>
    buildCursorInvestigationSnapshot({ logFn, projectRoot }),
});

const ADAPTERS = Object.freeze({
  claude: CLAUDE_ADAPTER,
  codex: CODEX_ADAPTER,
  automation: AUTOMATION_ADAPTER,
  cursor: CURSOR_ADAPTER,
});

export function normalizeToolDbHostAgent(hostAgent = 'claude') {
  if (hostAgent === undefined || hostAgent === null || hostAgent === '') {
    return 'claude';
  }
  if (Object.hasOwn(ADAPTERS, hostAgent)) {
    return hostAgent;
  }
  throw new TypeError(`tool-db hostAgent must be claude, codex, automation, or cursor; got ${hostAgent}`);
}

export function getHostAdapter(hostAgent = 'claude') {
  return ADAPTERS[normalizeToolDbHostAgent(hostAgent)];
}
