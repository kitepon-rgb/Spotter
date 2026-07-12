# Spotter Documentation Overview

Spotter is a Claude-first, hook-driven audit agent that runs alongside Claude Code
and Codex hosts to surface missed tool-use opportunities. `CLAUDE.md` remains the
canonical agent entry point for product philosophy, invariants, commands, hook
contracts, error handling, and release workflow.

## Naming Convention

- `00_` is the documentation entry point.
- Numbered files are ordered canonical designs, operational contracts, or the single active execution plan.
- Stable operational ledgers such as `open-issues.md` keep semantic names without numbers.
- Completed plans move to `archive/`; they do not remain beside active documents.

## Canonical Documents

- [`01_catalog-design.md`](01_catalog-design.md): tool-db and catalog discovery design.
- [`02_spotter-claude-contract.md`](02_spotter-claude-contract.md): Claude hook,
  daemon, backend, and Codex adapter contract.
- [`04_operational-slo.md`](04_operational-slo.md): latency, failure-rate, quality,
  and recommendation-acceptance objectives.
- [`adr/0001-hook-driven-parallel-auditor.md`](adr/0001-hook-driven-parallel-auditor.md):
  root architectural decision.

## Operational Documents

- [`open-issues.md`](open-issues.md): current unresolved issues and observation tasks.
- [`07_throughline-auditor-context-plan.md`](07_throughline-auditor-context-plan.md): proposed
  Throughline L2 context integration and precision-evaluation plan.

## Archive

- [`archive/`](archive/): completed plans, historical design snapshots, rollout logs,
  and smoke notes. These are reference material rather than current contract.
- [`archive/03_current-state-recovery-plan.md`](archive/03_current-state-recovery-plan.md):
  completed recovery, v1.4.17/1.4.18 release, and model-evaluation plan.
- [`archive/05_parent-session-safety-plan.md`](archive/05_parent-session-safety-plan.md):
  completed parent-session output-boundary implementation plan.
- [`archive/06_release-v1.4.19-plan.md`](archive/06_release-v1.4.19-plan.md):
  completed v1.4.19 release checklist and verification record.
