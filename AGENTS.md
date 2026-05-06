# AGENTS.md

This repository is Claude-first. `CLAUDE.md` is the canonical instruction file and
must stay the source of truth for product philosophy, architecture, invariants,
commands, hooks, error handling, and release workflow.

## Required Reading Order

1. Read `CLAUDE.md` before changing code.
2. Read `docs/open-issues.md` before starting new work.
3. For Claude / Codex dual-support work, also read
   `docs/SPOTTER_CODEX_DUAL_SUPPORT.md`.
4. For the executable dual-support TODO and phase gates, read
   `docs/SPOTTER_CODEX_DUAL_SUPPORT_TODO.md`.

If this file conflicts with `CLAUDE.md`, follow `CLAUDE.md` and update this file
only as a pointer or clarification.

## Project Stance

- Do not bend Spotter into a Codex-primary project. Claude Code, Bell, Haiku, and
  the existing hook-driven workflow remain first-class.
- Add Codex support as an adapter / execution option around the existing
  agent-neutral core. Do not fork detector or reporting behavior into separate
  Claude and Codex implementations.
- Preserve existing Claude command names, hook behavior, prompt contracts,
  daemon IPC contracts, report wording, and test fixtures unless the user
  explicitly approves a breaking change.
- Before changing dual-support behavior, document the current Claude contract and
  add regression coverage for it.

## Critical Safety Note

Spotter has a known high-impact failure mode: recursive hook / daemon proliferation.
The historical incident is documented in `docs/spotter-plan.md` section 18. The
product contract is to prevent that class of incident. The current proven
baseline is:

- `SPOTTER_PARENT_PID` blocks hooks spawned by Spotter's own `claude -p`.
- `agent_id` blocks Bell Task subagent hooks.
- `source === "startup"` is required before `SessionStart` may spawn a daemon.
- `.spotter/marker.json` keeps hooks scoped to installed projects.
- PID preexist checks prevent duplicate daemons for the same session.
- The 10-second Haiku call window is the final recursion guard.
- Daemon lifecycle uses app-level heartbeat plus UserPromptSubmit
  auto-resurrect. Do not restore `process.ppid` parent-watch cleanup; VSCode
  native Claude Code can report a short-lived wrapper as the parent.

Do not weaken or bypass this safety guarantee when adding Codex support,
sidecars, isolated worktrees, or new hook paths. Replacing any current guard is
allowed only when the replacement gives an equal or stronger guarantee, explains
which failure path it covers, and adds regression coverage.

## Implementation Rules For Agents

- Follow `CLAUDE.md` section 0: no hidden fallback, no silent failure, no
  provisional implementation in the mainline.
- Treat Codex-unavailable behavior as an explicit compatibility mode only when
  the design says so. Surface diagnostics clearly.
- Avoid recursive Codex-on-Codex delegation unless there is a concrete boundary:
  isolated worktree execution, durable structured result, raw diagnostics, a
  distinct critic / risk role, or an explicit second-pass request.
- Verify exact file contents directly before editing. Do not rely solely on
  summaries or generated context.
- Use the existing Node test runner (`node --test`) and keep tests focused on the
  changed contract.
