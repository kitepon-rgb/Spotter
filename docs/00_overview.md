# Spotter Documentation Overview

Spotter is a Claude-first, hook-driven audit agent that runs alongside Claude Code
and Codex hosts to surface missed tool-use opportunities. `AGENTS.md` is the
canonical agent source for product philosophy, invariants, commands, hook contracts,
error handling, and release workflow. `CLAUDE.md` is only the `@AGENTS.md` import entry.

Current production release: **v1.5.12**. Evaluation turns whose Stop was never observed are now
graded at the next prompt from the usage evidence collected so far instead of being discarded as
`outcome_missing`; only turns marked `usage_status=incomplete` remain unjudged. The A/C ratio is
displayed as a fit rate (upper bound), not as a Spotter attribution metric. Windows dashboard
tasks retain their user profile while starting PowerShell non-interactively with hidden console
windows. Unsupported non-Claude hooks are rejected before evaluation SQLite loads, including on
Node 24. UserPromptSubmit auditing uses only
the current request and the host-local tool catalog. Before reading catalog descriptions, the auditor
establishes a standard-host-tool baseline and reports only directly applicable catalog tools
that are better suited. Throughline is optional proposal-evaluation evidence and never gates
or changes auditing.

## Authority And Verification

Runtime behavior is defined by the source and tests. `AGENTS.md` defines design and agent
rules; it does not override contradictory executable behavior. The maintained documents below
were rechecked against the v1.5.7 source boundary `0977fd7` during the v1.5.8 documentation
release. If a maintained document and code disagree, treat that as a documentation defect and
use the code until the document is corrected.

| Subject | Maintained document | Executable authority |
|---|---|---|
| CLI and install | `README.md`, `README.ja.md`, `02_spotter-claude-contract.md` | `bin/spotter.mjs`, `src/cli/`, `package.json` |
| Catalog and tool DB | `01_catalog-design.md` | `src/tool-db/` |
| Hooks, daemon, auditor, projection | `02_spotter-claude-contract.md` | `src/hooks/`, `src/daemon/`, `src/core/` |
| Evaluation and dashboard | `09_proposal-adoption-evaluation-plan.md`, `10_spotter-dashboard-plan.md`, `11_dashboard-operations.md` | `src/core/evaluation-*`, `src/cli/evaluation-cmd.mjs`, `src/dashboard/`, `ops/dashboard/` |
| Open work and SLO | `open-issues.md`, `04_operational-slo.md` | recorded observations and release evidence |

`CHANGELOG.md` describes each release at its publication time. ADRs record decisions. Files
under `docs/archive/`, `docs/evidence/`, and dated `rag/` paths are immutable or amended
point-in-time records; later maintained documents supersede them for current behavior.

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
- [`11_dashboard-operations.md`](11_dashboard-operations.md): current service contract for
  the four-terminal reference dashboard; it is not a live online/version ledger.
- [`adr/0001-hook-driven-parallel-auditor.md`](adr/0001-hook-driven-parallel-auditor.md):
  root architectural decision.

## Operational Documents

- [`open-issues.md`](open-issues.md): current unresolved issues and observation tasks.
- [`08_factory-diagnostics-plan.md`](08_factory-diagnostics-plan.md): completed
  factory diagnostics and opt-in local runtime-error store design.
- [`BUGHUB_RUNTIME_ERROR_STORE_PLAN.md`](BUGHUB_RUNTIME_ERROR_STORE_PLAN.md): completed
  runtime-error projection implementation record and ownership boundary.

## Decision Records

- [`adr/0001-hook-driven-parallel-auditor.md`](adr/0001-hook-driven-parallel-auditor.md):
  the independent hook-driven auditor architecture.
- [`adr/0001-proposal-adoption-evaluation-implementation.md`](adr/0001-proposal-adoption-evaluation-implementation.md):
  local proposal/adoption evaluation storage, amended for exact-session evidence.
- [`adr/0002-device-routed-evaluation-dashboard.md`](adr/0002-device-routed-evaluation-dashboard.md):
  live device-routed dashboard without cloud replication.

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
- [`evidence/`](evidence/): publication and live-smoke evidence tied to the version named
  in each file, not statements about the current installed state.
- [`../rag/INDEX.md`](../rag/INDEX.md): dated external-spec snapshots and evaluation
  artifacts. The date and status in each entry bound its validity.
