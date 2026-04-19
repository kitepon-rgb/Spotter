# Changelog

## 0.1.0 (Unreleased)

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
