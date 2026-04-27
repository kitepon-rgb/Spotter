<p align="center">
  <img src=".github/og.png" alt="Spotter — Audit agent for Claude Code" width="100%">
</p>

# Spotter

[![npm version](https://img.shields.io/npm/v/claude-spotter.svg?style=flat-square)](https://www.npmjs.com/package/claude-spotter)
[![CI](https://github.com/kitepon-rgb/Spotter/actions/workflows/ci.yml/badge.svg)](https://github.com/kitepon-rgb/Spotter/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/node/v/claude-spotter.svg?style=flat-square)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)

**English · [日本語](README.ja.md)**

> **Separate the spotter from the doer.** Spotter runs alongside Claude Code and quietly flags the moments when Bell (your primary Claude) **forgets to use a tool it has access to**.

Claude has a structural blind spot: **it can't reach for a tool it doesn't realize it needs**. It will guess the current time instead of calling `current_time`, answer with stale knowledge instead of `web_search`, describe a config file from its name instead of `read_file`. The model can't always tell when it doesn't know — so the tool stays unused.

Spotter pins a second agent (Claude Haiku 4.5) next to Bell. The second agent has the full tool catalog memorized and audits both the user's prompt and Bell's reply in parallel. When it spots a missed tool, it injects a transparent recommendation into Bell's context and, if needed, asks Bell to amend its answer. **Bell is never asked to self-audit** — that would defeat the entire premise. Detection happens through hooks, independent of Bell's intent.

## See it in 30 seconds

Examples of what Spotter catches:

| Situation | What Bell would do | What Spotter flags |
|---|---|---|
| "What's the weather today?" | Guess from training data | Missed call to `web_search` |
| "What's in this config file?" | Describe based on the filename | Missed call to `read_file` |
| "What time is it?" | Answer from training-time knowledge | Missed call to `current_time` |
| Asserting a fact | Stating it without verification | Opportunity to call a verification tool |

Spotter audits in two stages:

- **`stage=user_input`** — given the user's prompt, list any tools whose `when_to_use` clearly applies. A *prompt-fulfillment* check
- **`stage=turn_end`** — given Bell's final reply, look for places where a catalog tool (verification / recording / lookup) could plug in. A *missed-opportunity* audit. Zero findings is fine; tools already used in this turn are not re-flagged

## Install

```bash
npm install -g claude-spotter
cd your-project
spotter install
```

Since `v0.3.0`, Spotter requires **explicit per-project install** (the earlier `postinstall` auto-registration was the leading cause of orphan daemons). `spotter install` writes hooks into the project's `.claude/settings.json`; the audit is then active only in Claude Code sessions for that project.

```bash
spotter uninstall        # remove hooks from this project
```

## Requirements

- **Node.js 22.5+**
- **Claude Code 2.0+**
- **Claude Max plan** (Spotter spawns Haiku via `claude -p`)

## Architecture

```
User prompt
  ↓
UserPromptSubmit hook → Spotter does a first pass against the catalog
  ↓
Bell thinking (receives Spotter's recommendations as additionalContext)
  ↓
Bell's final answer
  ↓
Stop hook → Spotter re-audits the answer + tools actually used
  ↓
If something was missed: send-back (max 1 round, guaranteed by Claude Code's stop_hook_active)
```

The audited tool catalog (name + description) lives in `<project>/.spotter/tool-db.json`. **Since v1.2.0 the daemon audits against the local DB only**; the global DB at `~/.spotter/tool-db.json` is a description-reuse cache shared across projects, not an audit source. Each project's local DB always matches the **current** discovery snapshot for that project (entries are pruned on refresh), so MCP servers, skills, or sub-agents installed in *other* projects can never bleed into this project's audit.

**Since v1.1.0, `spotter install` runs the initial seed automatically, and the SessionStart hook triggers a background `spotter db refresh` on every Claude Code session start** — so you don't need to invoke catalog commands by hand. The discovery sources are: (1) **MCP servers** — enumerated from `claude mcp list` (membership) and merged with all three official Claude Code scopes for env / headers: User (`~/.claude.json` direct `mcpServers`) / Project (`<projectRoot>/.mcp.json`) / Local (`~/.claude.json` `projects[<root>].mcpServers`), with precedence Local > Project > User (v1.2.1+); a legacy `~/.claude/.mcp.json` source is also read at the lowest priority for backward compatibility. Each server's `tools/list` is fetched via JSON-RPC (HTTP/SSE transport supported); (2) **skills** — `{name, description}` extracted from SKILL.md frontmatter at user / project / plugin scope; (3) **sub-agents** — same pattern from agent `.md` frontmatter; (4) **claude.ai baseline** — Gmail / Calendar / Drive (25 entries via OAuth proxy) injected from a hand-maintained baseline only when `claude mcp list` confirms the server is present (v1.1.4+). **You never have to maintain the tool list by hand.**

## Spotter and Throughline

[Throughline](https://github.com/kitepon-rgb/Throughline) is a sibling project from the same author. Different mechanism, **shared philosophy**.

|  | Throughline | Spotter |
|---|---|---|
| Direction | Subtraction — evict what isn't needed | Addition — surface what's missing |
| Target | Context bloat | Missed tool calls |
| Mechanism | Hook-driven memory eviction | Hook-driven sub-agent in parallel |

Both share the principle of **"don't rely on the primary agent (Bell) to do it itself."** They compose well — you can run them together.

## Common commands

```bash
spotter db list          # show the current local tool-db (what the daemon actually audits against)
spotter db refresh       # rediscover MCP / skills / sub-agents and update the DB
                         #   (run automatically on install and on SessionStart since v1.1.0,
                         #    so this is rarely needed by hand)
spotter db rebuild       # wipe both local + global DBs and refresh from scratch
                         #   (use after catalog-shape changes)
spotter status           # list running daemons
spotter doctor           # environment check (Node / claude CLI / tool-db integrity)
spotter uninstall        # remove hooks from this project (leaves ~/.spotter intact)
```

## Design docs

- **Current design** (catalog, discovery, classification axes): [docs/catalog-design.md](docs/catalog-design.md) — source of truth from v1.0.0
- **Open issues + unverified concerns**: [docs/open-issues.md](docs/open-issues.md) — read this before starting new work
- **Implementation invariants (§0)**: [CLAUDE.md](CLAUDE.md) — no fallbacks, no silent failures, no provisional code
- **Historical record (v0.1 design discussion)**: [docs/spotter-plan.md](docs/spotter-plan.md) — frozen design-discussion snapshot

## Known limitations

- The `Stop` hook fires **after** Bell's first answer has already been streamed to the user. When Spotter sends Bell back, the user sees both the original answer and the corrected one. Detection accuracy in `UserPromptSubmit` (the *pre-response* stage) is therefore Spotter's primary axis of quality
- **Since v0.5.0, JSON schema violations from Haiku are treated as expected-anomalies** (silent pass + session renew, logged as `role_collapse_reset`) — this is the role-collapse recovery path. **Haiku timeouts still throw**, which surfaces as `UserPromptSubmit` blocking the user's prompt from reaching Bell. Timeouts have been raised twice (30s in v0.5.0, 45s in v0.13.1); making timeouts fail-open is deferred until §0 is revisited

<details>
<summary><strong>📋 v1.2.0 release notes (2026-04-26)</strong></summary>

**Structural fix for a regression that suggested tools the current project can't actually use.** The catalog the daemon audits against is now **local-only**. The global DB has been demoted to a cross-project description-reuse cache. A prune step was added to the end of `resolveAll`: any local entry not present in the current project's discovery snapshot is removed. This closes the path through which MCP servers / skills / sub-agents discovered in other projects used to linger in this project's audit set.

For projects that already have Spotter installed, the next SessionStart after the npm global upgrade triggers an auto-refresh; the ghosts disappear from the session-after-next (immediate cleanup: run `spotter db refresh` by hand). The pillars introduced in v1.1.0 (auto-build of the tool DB at install, automatic drift tracking on SessionStart) are unchanged. The audit scope set in v1.0.0 (user-added MCP / skills / sub-agents) is unchanged.

Full notes: [CHANGELOG](CHANGELOG.md).

</details>

## License

MIT — see [LICENSE](LICENSE).
