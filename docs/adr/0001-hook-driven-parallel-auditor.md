# 0001: Hook-Driven Parallel Auditor

- Status: Accepted
- Date: 2026-07-04

## Context

Spotter exists because the primary agent can miss tools it has access to. Asking
the primary agent to self-audit would keep detection dependent on the same blind
spot.

`AGENTS.md`, `README.md`, and the implementation describe Spotter as a separate
auditor that receives hook events independently of the primary agent's intent.
The daemon records user input, used tools, and final responses, then asks the
configured primary auditor backend to return structured findings.

## Decision

Spotter remains a hook-driven parallel auditor. The primary agent is the doer;
Spotter is the spotter. Tool-use detection must happen through hooks and the
host-local catalog, not through an opt-in command that depends on the primary
agent remembering to call Spotter.

## Consequences

- `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `Stop`, and `SessionEnd`
  contracts are product boundaries.
- Recursive hook and daemon proliferation guards are part of the core safety
  contract.
- Claude and Codex support must share the agent-neutral core rather than fork
  detector behavior.
- Explicit second-pass workflows may exist, but they do not replace the primary
  hook audit path.
