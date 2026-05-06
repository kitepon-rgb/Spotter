const KNOWN_ANOMALY_REASONS = new Set([
  'role_collapse_reset',
  'hallucination_filtered',
]);

export function toSpotterJudgment({ stage, parsed, meta = {} }) {
  if (typeof stage !== 'string' || stage.length === 0) {
    throw new TypeError('toSpotterJudgment: stage must be a non-empty string');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new TypeError('toSpotterJudgment: parsed must be an object');
  }
  if (typeof parsed.pass !== 'boolean') {
    throw new TypeError('toSpotterJudgment: parsed.pass must be boolean');
  }
  if (!Array.isArray(parsed.missing_tools)) {
    throw new TypeError('toSpotterJudgment: parsed.missing_tools must be an array');
  }

  const findings = parsed.missing_tools.map((tool, index) => toSpotterFinding({ stage, tool, index }));
  const anomalies = [];
  if (typeof parsed.reason === 'string' && KNOWN_ANOMALY_REASONS.has(parsed.reason)) {
    anomalies.push({
      type: parsed.reason,
      stage,
      source: 'spotter',
      raw: parsed,
    });
  }

  return {
    pass: parsed.pass,
    findings,
    anomalies,
    meta: {
      stage,
      ...meta,
    },
  };
}

export function toSpotterFinding({ stage, tool, index }) {
  if (!tool || typeof tool !== 'object') {
    throw new TypeError('toSpotterFinding: tool must be an object');
  }
  if (typeof tool.name !== 'string' || tool.name.length === 0) {
    throw new TypeError('toSpotterFinding: tool.name must be a non-empty string');
  }
  if (typeof tool.reason !== 'string' || tool.reason.length === 0) {
    throw new TypeError('toSpotterFinding: tool.reason must be a non-empty string');
  }

  return {
    id: `spotter.${stage}.${index + 1}`,
    stage,
    toolName: tool.name,
    reason: tool.reason,
    category: 'tool_miss',
    severity: 'unknown',
    confidence: 'unknown',
    references: [],
    source: 'haiku',
    raw: { ...tool },
  };
}

export function legacyResultFromJudgment(judgment) {
  if (!judgment || typeof judgment !== 'object') {
    throw new TypeError('legacyResultFromJudgment: judgment must be an object');
  }
  const out = {
    pass: judgment.pass === true,
    missing_tools: Array.isArray(judgment.findings)
      ? judgment.findings.map((finding) => ({
          name: finding.toolName,
          reason: finding.reason,
        }))
      : [],
  };
  const firstAnomaly = Array.isArray(judgment.anomalies) ? judgment.anomalies[0] : null;
  if (firstAnomaly?.type) {
    out.reason = firstAnomaly.type;
  }
  return out;
}
