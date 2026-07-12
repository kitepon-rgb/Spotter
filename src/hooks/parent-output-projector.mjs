const TOOL_ID_PATTERN = /^[A-Za-z0-9_.:/-]+$/;
const MAX_TOOL_ID_LENGTH = 160;
const MAX_TOOL_IDS = 5;
const MAX_ADVICE_LENGTH = 2000;

const FAILURE_KINDS = new Map([
  ['E_CODEX_CLI_AUTH', 'auth'],
  ['E_CODEX_CLI_USAGE_LIMIT', 'usage_limit'],
  ['E_CODEX_CLI_MODEL_UNAVAILABLE', 'model_unavailable'],
  ['E_CODEX_CLI_TIMEOUT', 'timeout'],
  ['E_TIMEOUT', 'timeout'],
  ['E_HAIKU_TIMEOUT', 'timeout'],
]);

const FAILURE_OUTPUTS = Object.freeze({
  auth: Object.freeze({
    code: 'E_SPOTTER_AUDIT_AUTH',
    systemMessage: 'Spotter の監査は認証状態を確認できないため、このターンでは利用できませんでした。',
  }),
  usage_limit: Object.freeze({
    code: 'E_SPOTTER_AUDIT_USAGE_LIMIT',
    systemMessage: 'Spotter の監査は利用上限のため、このターンでは利用できませんでした。',
  }),
  model_unavailable: Object.freeze({
    code: 'E_SPOTTER_AUDIT_MODEL_UNAVAILABLE',
    systemMessage: 'Spotter の監査は選択中のモデルを利用できないため、このターンでは利用できませんでした。',
  }),
  timeout: Object.freeze({
    code: 'E_SPOTTER_AUDIT_TIMEOUT',
    systemMessage: 'Spotter の監査は時間内に完了しなかったため、このターンでは利用できませんでした。',
  }),
  generic: Object.freeze({
    code: 'E_SPOTTER_AUDIT_GENERIC',
    systemMessage: 'Spotter の監査は一時的な問題のため、このターンでは利用できませんでした。',
  }),
});

export const STOP_FINDING_SYSTEM_MESSAGE = 'Spotter は直前の応答について利用可能ツールの確認候補を記録しました。';

export function projectParentAdvice(toolIds) {
  const accepted = projectToolIds(toolIds);
  if (accepted.length === 0) return '';
  const lines = [
    '[Spotter からの参考情報]',
    '関連する可能性がある利用可能ツール:',
  ];
  for (const toolId of accepted) {
    const next = [...lines, `- \`${toolId}\``, '', '適用可否は、現在の依頼と利用条件に基づいて独立に判断できます。'].join('\n');
    if (next.length > MAX_ADVICE_LENGTH) break;
    lines.push(`- \`${toolId}\``);
  }
  if (lines.length === 2) return '';
  lines.push('', '適用可否は、現在の依頼と利用条件に基づいて独立に判断できます。');
  return lines.join('\n');
}

export function projectToolIds(toolIds) {
  return normalizeToolIds(toolIds);
}

export function projectBackendFailure(code) {
  const kind = FAILURE_KINDS.get(code) ?? 'generic';
  const output = FAILURE_OUTPUTS[kind];
  return Object.freeze({
    code: output.code,
    systemMessage: output.systemMessage,
    stderr: `spotter-hook: ${output.systemMessage}\n`,
  });
}

function normalizeToolIds(toolIds) {
  if (!Array.isArray(toolIds)) return [];
  const unique = new Set();
  for (const toolId of toolIds) {
    if (typeof toolId !== 'string' || toolId.length === 0 || toolId.length > MAX_TOOL_ID_LENGTH) continue;
    if (!TOOL_ID_PATTERN.test(toolId)) continue;
    unique.add(toolId);
  }
  return [...unique].sort().slice(0, MAX_TOOL_IDS);
}
