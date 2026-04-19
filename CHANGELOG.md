# Changelog

## 0.1.1

- `npm install -g claude-spotter` now registers hooks at user level automatically via the `postinstall` lifecycle — no separate `spotter install` step needed
- `npm uninstall -g claude-spotter` removes hook entries from `~/.claude/settings.json` via `preuninstall`
- Opt-out: set `CLAUDE_SPOTTER_NO_AUTO_INSTALL=1` before install, or install in an environment where `CI=true` (CI is auto-skipped)

## 0.1.0

Initial release.

### Features

- Session-scoped daemon that audits tool usage alongside Claude Code (Bell)
- 5 hooks wired: SessionStart / UserPromptSubmit / PreToolUse / Stop / SessionEnd
- YAML tool catalog with 2-stage context (purpose/when_to_use first, usage/examples after)
- Structured JSON I/O with Claude Haiku 4.5
- Cross-platform socket transport (Unix domain socket / Windows Named Pipe via Node `net`)
- `spotter install / uninstall / catalog edit / catalog lint / status / doctor` CLI

### Dependencies

- `js-yaml` (4.x) — required for catalog parsing. Node has no built-in YAML support, and hand-rolling a parser adds subtle bugs that violate §14.2 "no shim code" discipline. This is the single exception to the zero-dependency goal (§15.2).

### Design

All non-negotiable design decisions — including transparency vs invisibility, JSON I/O, socket abstraction, message envelope, SessionStart readiness — are documented in [docs/spotter-plan.md](docs/spotter-plan.md).
