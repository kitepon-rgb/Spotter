// `spotter catalog lint` — schema validation + test_cases execution against live Haiku.
// §11: v0.1 completion metric = this command passes. No mocks (§14.1 silent-fallback discipline).

import { loadCatalog } from './loader.mjs';
import { buildFirstStagePrompt, parseHaikuResponse } from '../daemon/haiku-caller.mjs';

export async function runLint({ catalogPath, haikuCaller, writeLine }) {
  writeLine(`lint: loading ${catalogPath}`);
  const catalog = await loadCatalog(catalogPath);
  writeLine(`lint: loaded ${catalog.tools.length} tools, validating test_cases...`);

  const totalCases = catalog.tools.reduce(
    (sum, t) => sum + (Array.isArray(t.test_cases) ? t.test_cases.length : 0),
    0
  );
  if (totalCases === 0) {
    writeLine('lint: no test_cases present — schema validation only, passed');
    return { passed: 0, failed: 0, total: 0 };
  }

  let passed = 0;
  const failures = [];

  for (const tool of catalog.tools) {
    if (!Array.isArray(tool.test_cases)) continue;
    for (const tc of tool.test_cases) {
      // Each test case is an independent judgement, so isFirst=true always.
      const prompt = buildFirstStagePrompt({
        catalog,
        userInput: tc.user_input,
        isFirst: true,
      });
      const rawResponse = await haikuCaller(prompt, { isFirst: true });
      const parsed = parseHaikuResponse(rawResponse);
      const detectedNames = parsed.missing_tools.map((m) => m.name);
      const hit = detectedNames.includes(tc.expected_tool);
      if (hit) {
        passed += 1;
        writeLine(`  PASS  ${tool.name} :: "${tc.user_input}" → ${tc.expected_tool}`);
      } else {
        failures.push({
          tool: tool.name,
          user_input: tc.user_input,
          expected: tc.expected_tool,
          detected: detectedNames,
        });
        writeLine(
          `  FAIL  ${tool.name} :: "${tc.user_input}" → expected ${tc.expected_tool}, detected [${detectedNames.join(', ') || '-'}]`
        );
      }
    }
  }

  const failed = failures.length;
  writeLine('');
  writeLine(`lint summary: ${passed}/${totalCases} passed, ${failed} failed`);
  return { passed, failed, total: totalCases, failures };
}
