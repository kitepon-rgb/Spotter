# Spotter Documentation Overview

Spotter is a Claude-first, hook-driven audit agent that runs alongside Claude Code
and Codex hosts to surface missed tool-use opportunities. `AGENTS.md` is the
canonical agent source for product philosophy, invariants, commands, hook contracts,
error handling, and release workflow. `CLAUDE.md` is only the `@AGENTS.md` import entry.

Current production release: **v1.5.7**. UserPromptSubmit auditing uses only the current
request and the host-local tool catalog. Before reading catalog descriptions, the auditor
establishes a standard-host-tool baseline and reports only directly applicable catalog tools
that are better suited. Throughline is optional proposal-evaluation evidence and never gates
or changes auditing.

## Naming Convention

- `00_` is the documentation entry point.
- Numbered files are ordered canonical designs, operational contracts, or completed
  implementation records that explicitly state their status.
- Stable operational ledgers such as `open-issues.md` keep semantic names without numbers.
- Superseded plans move to `archive/`. A completed plan may remain numbered only while
  it is also the clearest current design or operations reference.

## Canonical Documents

- [`01_catalog-design.md`](01_catalog-design.md): tool-db and catalog discovery design.
- [`02_spotter-claude-contract.md`](02_spotter-claude-contract.md): Claude hook,
  daemon, backend, and Codex adapter contract.
- [`04_operational-slo.md`](04_operational-slo.md): latency, failure-rate, quality,
  and observed proposal/adoption objectives.
- [`09_proposal-adoption-evaluation-plan.md`](09_proposal-adoption-evaluation-plan.md):
  completed local proposal/adoption evaluation design and v1.5.4 correction.
- [`10_spotter-dashboard-plan.md`](10_spotter-dashboard-plan.md): completed
  device-routed dashboard design.
- [`11_dashboard-operations.md`](11_dashboard-operations.md): current four-terminal
  dashboard operations.
- [`adr/0001-hook-driven-parallel-auditor.md`](adr/0001-hook-driven-parallel-auditor.md):
  root architectural decision.

## Operational Documents

- [`open-issues.md`](open-issues.md): current unresolved issues and observation tasks.
- [`08_factory-diagnostics-plan.md`](08_factory-diagnostics-plan.md): completed
  factory diagnostics and opt-in local runtime-error store design.

## Historical and Archive

- [`07_throughline-auditor-context-plan.md`](07_throughline-auditor-context-plan.md):
  revoked v1.4.20–v1.4.21 Throughline auditor-context design. Its body is historical,
  not a current contract.

- [`archive/`](archive/): completed plans, historical design snapshots, rollout logs,
  and smoke notes. These are reference material rather than current contract.
- [`archive/03_current-state-recovery-plan.md`](archive/03_current-state-recovery-plan.md):
  completed recovery, v1.4.17/1.4.18 release, and model-evaluation plan.
- [`archive/05_parent-session-safety-plan.md`](archive/05_parent-session-safety-plan.md):
  completed parent-session output-boundary implementation plan.
- [`archive/06_release-v1.4.19-plan.md`](archive/06_release-v1.4.19-plan.md):
  completed v1.4.19 release checklist and verification record.
