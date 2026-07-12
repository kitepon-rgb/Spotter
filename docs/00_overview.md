# Spotter Documentation Overview

Spotter is a Claude-first, hook-driven audit agent that runs alongside Claude Code
and Codex hosts to surface missed tool-use opportunities. `CLAUDE.md` remains the
canonical agent entry point for product philosophy, invariants, commands, hook
contracts, error handling, and release workflow.

## Naming Convention

- `00_` is the documentation entry point.
- Numbered files are ordered canonical designs or the single active execution plan.
- Stable operational ledgers such as `open-issues.md` keep semantic names without numbers.
- Completed plans move to `archive/`; they do not remain beside active documents.

## Canonical Documents

- [`01_catalog-design.md`](01_catalog-design.md): tool-db and catalog discovery design.
- [`02_spotter-claude-contract.md`](02_spotter-claude-contract.md): Claude hook,
  daemon, backend, and Codex adapter contract.
- [`03_current-state-recovery-plan.md`](03_current-state-recovery-plan.md): active
  recovery, release, and model-evaluation plan.
- [`adr/0001-hook-driven-parallel-auditor.md`](adr/0001-hook-driven-parallel-auditor.md):
  root architectural decision.

## Operational Documents

- [`open-issues.md`](open-issues.md): current unresolved issues and observation tasks.

## Archive

- [`archive/`](archive/): completed plans, historical design snapshots, rollout logs,
  and smoke notes. These are reference material rather than current contract.
