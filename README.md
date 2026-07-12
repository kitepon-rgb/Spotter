<p align="center">
  <img src=".github/og.png" alt="Spotter — Audit agent for Claude Code" width="100%">
</p>

# Spotter

[![npm version](https://img.shields.io/npm/v/claude-spotter.svg?style=flat-square)](https://www.npmjs.com/package/claude-spotter)
[![CI](https://github.com/kitepon-rgb/Spotter/actions/workflows/ci.yml/badge.svg)](https://github.com/kitepon-rgb/Spotter/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/node/v/claude-spotter.svg?style=flat-square)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)

**English · [日本語](README.ja.md)**

> **Separate the spotter from the doer.** Spotter runs alongside Claude Code and quietly flags the moments when your primary Claude **forgets to use a tool it has access to**.

Claude has a structural blind spot: **it can't reach for a tool it doesn't realize it needs**. It may skip a project memory MCP when a decision should be recorded, answer from stale memory instead of a docs-lookup MCP, or reason about UI state without a browser-automation MCP. The model can't always tell when it doesn't know — so the tool stays unused.

Spotter runs a separate auditor with the full tool catalog and checks both the user's prompt and the primary agent's reply. Automatic selection uses Codex CLI on a Claude host when available, otherwise the session-scoped Haiku path; on a Codex host it defaults to Codex CLI. An explicit backend override takes precedence, but a runtime failure never silently switches backend. Before the primary reply, validated tool IDs may become fixed, non-directive advice; after the reply, findings remain structured events and are not injected into a later turn. Auditor prose never enters the parent session. **The primary agent is never asked to self-audit** — that would defeat the premise. Detection happens through hooks, independent of the primary agent's intent.

<p align="center">
  <img src=".github/concept.svg" alt="Claude answers · Spotter watches" width="80%">
</p>

<p align="center">
  <sub><b>Claude</b> answers (the doer) &nbsp;·&nbsp; <b>Spotter</b> watches (the auditor, silent)</sub>
</p>

## See it in 30 seconds

Examples of what Spotter catches:

| Situation | What Claude would do | What Spotter flags |
|---|---|---|
| "Please remember this OAuth gotcha" | Acknowledge and move on | Missed call to a memory / caveat MCP |
| "How does this package API work in the latest version?" | Answer from training-time knowledge | Missed call to a docs-lookup MCP |
| "Review this risky patch" | Self-review only | Missed call to a reviewer sub-agent |
| Asserting a fact | State it without verification | Opportunity to call a verification tool |
| "Does this UI still render correctly?" | Reason from source code alone | Missed call to a browser-automation MCP |
| "What did we decide about X earlier?" | Guess or admit forgetting | Missed call to a memory / notes MCP |

Spotter audits in two stages:

- **`stage=user_input`** — given the user's prompt, list any local catalog tools whose description clearly applies. A *prompt-fulfillment* check
- **`stage=turn_end`** — given Claude's final reply, look for places where a catalog tool (verification / recording / lookup) could plug in. A *missed-opportunity* audit. Zero findings is fine; tools already used in this turn are not re-flagged

## Install

```bash
npm install -g claude-spotter
cd your-project
spotter install
```

On macOS with Homebrew Node, Codex hook commands use the stable
`/opt/homebrew/bin/node` symlink when it resolves to the current Node binary,
instead of a versioned `/opt/homebrew/Cellar/node/<version>/...` path. That keeps
Codex hooks working across Homebrew Node upgrades.

Since `v0.3.0`, Spotter requires **explicit per-project install** (the earlier `postinstall` auto-registration was the leading cause of orphan daemons). `spotter install` writes hooks into the project's `.claude/settings.json`; the audit is then active only in Claude Code sessions for that project.
When the Codex CLI is available, the same `spotter install` also registers user-level Codex native hooks. Project activation still depends on the same per-project `.spotter/marker.json`, so unrelated Codex sessions do not trigger Spotter.
For Codex, install enables the current `[features].hooks = true` flag and still recognizes older `codex_hooks` diagnostics output for compatibility.
Installer-owned Codex handlers use the current synchronous command schema. After install or upgrade, review them with `/hooks`, then open a fresh Codex session; `spotter codex-hook diagnostics` reports registration/readiness but does not guess hook trust.

After upgrading Spotter, re-run `spotter install` in each installed project when release notes mention hook setting changes. The global package update changes the code path, but existing `.claude/settings.json` timeout values are not rewritten automatically.
`v1.4.19` changes runtime output projection only, so already installed projects do not need another `spotter install`; update the global package and open a fresh Claude/Codex session.

```bash
spotter uninstall        # remove hooks from this project
```

Release install smoke:

```bash
npm uninstall -g claude-spotter
npm install -g claude-spotter
spotter --version
spotter install -y
spotter codex-hook install
```

## Requirements

- **Node.js 22.5+**
- **Claude Code 2.0+**
- **Codex CLI** for the default Codex-native backend and the preferred Claude-host auditor path. The auto-selected Codex backend does not fall back to Haiku after a runtime failure
- **Claude Max plan** only when a Claude host selects the Haiku path (Codex CLI is absent or `SPOTTER_AUDITOR_BACKEND=haiku` is explicit)

## Architecture

### Audit flow per turn

Claude Code and Codex share the same safe parent-output projector. Auditor prose stays
internal; only validated tool IDs can become fixed, non-imperative advice on
`UserPromptSubmit`. `Stop` records structured findings without injecting them into a later turn.

```mermaid
flowchart TD
    U([User prompt]) --> UPH[UserPromptSubmit hook<br/>Spotter audits prompt against catalog]
    UPH --> BT[Host model<br/>may receive fixed advisory<br/>with validated tool IDs]
    BT --> BA([Claude's first answer])
    BA --> SH[Stop hook<br/>Spotter re-audits answer + tools used]
    SH --> DEC{Missed<br/>tool?}
    DEC -->|No| DONE([Done])
    DEC -->|Yes| EVT[Record structured Hook event<br/>no next-turn injection]
```

### Catalog discovery

```mermaid
flowchart LR
    subgraph SRC[Discovery sources]
      direction TB
      MCP[MCP servers<br/>via claude mcp list]
      SK[Skills<br/>SKILL.md frontmatter]
      AG[Sub-agents<br/>agent .md frontmatter]
      BL[claude.ai baseline<br/>Gmail / Calendar / Drive<br/>injected when present]
    end
    subgraph SCOPES["MCP env / headers — 4 scopes, top wins on collision"]
      direction TB
      L["Local — projects.&lt;root&gt;.mcpServers in ~/.claude.json"]
      P["Project — &lt;root&gt;/.mcp.json"]
      US["User — mcpServers in ~/.claude.json"]
      LG["Legacy — ~/.claude/.mcp.json"]
    end
    SCOPES -. merged into .-> MCP
    MCP --> DB[(Host-local tool-db<br/>name + description<br/>per project)]
    SK --> DB
    AG --> DB
    BL --> DB
    DB --> H[Independent auditor<br/>Codex CLI when available<br/>otherwise session-scoped Haiku]
```

The audited catalog is host-local: Claude uses `<project>/.spotter/tool-db.json`, while Codex uses `<project>/.spotter/tool-db.codex.json`. **The daemon audits against the Claude local DB only**, and Codex native hooks read the Codex local DB. Global description caches are host-specific too: Claude uses `~/.spotter/tool-db.json`, while Codex uses `~/.spotter/tool-db.codex.json`. They are shared only across projects for the same host and are never audit sources. Each host-local DB matches that host's **current** discovery snapshot for the project (stale entries are pruned on refresh), so tools from another project or another host cannot overwrite this session's audit catalog.

**`spotter install` seeds the Claude catalog automatically, and the SessionStart hook runs a background `spotter db refresh` on every Claude Code session start** — so you don't need to invoke Claude catalog commands by hand. When Codex CLI is available, the same `spotter install` registers Codex native hooks and seeds `.spotter/tool-db.codex.json` synchronously, so the first Codex session has a catalog too. Later Codex `SessionStart` hooks start `spotter db refresh --host-agent codex` in the background, updating `.spotter/tool-db.codex.json` without touching the Claude catalog. Claude discovery reads `claude mcp list` plus Claude skills / sub-agents; Codex discovery reads `codex mcp list/get` plus Codex skills. Each MCP server's `tools/list` is fetched via JSON-RPC (HTTP / SSE / stdio transports supported); skill and sub-agent metadata comes straight from frontmatter; the claude.ai baseline (25 hand-curated entries for Gmail / Calendar / Drive over OAuth proxy) is injected only for Claude when `claude mcp list` confirms the server is present. **You never have to maintain the tool list by hand.**

## Spotter and Throughline

[Throughline](https://github.com/kitepon-rgb/Throughline) is a sibling project from the same author. Different mechanism, **shared philosophy**.

|  | Throughline | Spotter |
|---|---|---|
| Direction | Subtraction — evict what isn't needed | Addition — surface what's missing |
| Target | Context bloat | Missed tool calls |
| Mechanism | Hook-driven memory eviction | Hook-driven sub-agent in parallel |

Both share the principle of **"don't rely on the primary agent to do it itself."** They compose well — you can run them together.

### Throughline auditor context (default-on)

When `spotter install` can resolve Throughline on PATH to an absolute executable,
auditor context is enabled by default. A normal reinstall migrates legacy markers
whose disabled state came from the old default. An explicit project opt-out is
stored with `origin: explicit` and is never silently re-enabled. Disable it with:

```bash
spotter install -y --auditor-context disabled
```

When automatic discovery is unavailable, configure a direct absolute Throughline
executable and any leading arguments with repeatable `--throughline-arg`:

```bash
spotter install -y --auditor-context throughline \
  --throughline-command /absolute/path/to/throughline
```

On Windows, `.cmd` and `.bat` wrappers are deliberately rejected to avoid shell
injection. Point at an absolute `node.exe` and pass the absolute
`throughline.mjs` path as a repeated argument instead:

```powershell
spotter install -y --auditor-context throughline `
  --throughline-command 'C:\Program Files\nodejs\node.exe' `
  --throughline-arg 'C:\absolute\path\to\throughline\bin\throughline.mjs'
```

The connector is Codex CLI-only. It sends no context in argv: the bounded
projection is supplied to that AI over stdin. Haiku does not support this
context path and is never called for it. Only a `fresh` Throughline result is
eligible for an AI call; every other status skips AI. An enabled connector
failure becomes a fixed warning, not a hidden fallback.

Throughline contributes only fresh, completed L2 user/assistant pairs: two
recent pairs (N=2), each body capped at 600 characters and 4,000 characters in
total. Spotter never reflects Throughline L2, `reason`, or `raw` to the parent.
The parent receives only fixed non-imperative advice built from safe catalog tool
IDs. `spotter doctor` displays the auditor-context mode and a fixed availability
detail without printing its command or arguments.

The v2 model-matrix can make the context choice explicit:

```bash
spotter auditor model-matrix --fixtures test/fixtures/auditor-model-matrix.v2.json \
  --recent-turns 2 --body-cap 600
```

The evaluated setting is N=2 / 600. Default-on operation now collects the 7-day,
30-fresh-result sample used to decide whether to keep, adjust, or roll back the default.

## Common commands

```bash
spotter db list          # show the current Claude local tool-db
spotter db list --host-agent codex
                         # show the current Codex local tool-db
spotter db refresh       # rediscover Claude MCP / skills / sub-agents and update the Claude DB
spotter db refresh --host-agent codex
                         # rediscover Codex MCP / skills and update .spotter/tool-db.codex.json
                         #   (Claude refresh is automatic on install + Claude SessionStart;
                         #    Codex refresh is automatic on Codex SessionStart after spotter install)
spotter db rebuild       # wipe Claude local + Claude global DBs and refresh from scratch
                         #   (use after catalog-shape changes)
spotter status           # list running daemons
spotter doctor           # environment check (Node / claude CLI / Codex readiness / tool-db integrity)
spotter diagnostics logs # summarize daemon logs for pass=false / backend latency / anomaly signals
spotter codex risk-check --findings findings.json --host-agent claude
                         # run read-only codex-sidecar risk analysis for Spotter findings
spotter codex review|explore|opinion --findings findings.json --host-agent claude
                         # run other read-only codex-sidecar second-pass workflows
spotter codex work --findings findings.json --instruction "Update docs" --approve-work \
  --allowed-path docs/ --preserve-worktree
                         # run approved codex-sidecar work in an isolated worktree
spotter codex-hook install
                         # repair / explicitly register Codex native hooks (normally handled by spotter install)
spotter codex-hook diagnostics
                         # check Codex hook registration/readiness; trust is reviewed with /hooks
spotter auditor model-matrix --fixtures test/fixtures/auditor-model-matrix.v2.json --recent-turns 2 --body-cap 600
                         # experimental reproducible comparison of pinned auditor model profiles
spotter uninstall        # remove hooks from this project (leaves ~/.spotter intact)
```

Optional async Codex risk dispatch:

```bash
SPOTTER_CODEX_RISK_CHECK=1 spotter daemon start --session-id ... --project-root ...
```

When enabled, the daemon dispatches `pass:false` findings to `spotter codex risk-check`
in a detached process. Hook responses do not wait for Codex. Add
`SPOTTER_CODEX_RISK_CHECK_DRY_RUN=1` to exercise the wiring without calling Codex.

Primary auditor backend policy: Claude hooks automatically select Codex CLI when it is available on PATH,
otherwise the Haiku-compatible path. Codex native hooks automatically select Codex CLI. An explicit
`SPOTTER_AUDITOR_BACKEND` override wins on either host; runtime failure never triggers a hidden fallback.
The Codex SessionStart hook refreshes `.spotter/tool-db.codex.json` in the background
without touching the Claude DB.
Codex CLI auditor child processes use a versioned product policy. The production selection is
`gpt-5.6-terra × medium`, promoted after repeated fixture evaluation. `gpt-5.6-luna × low` and
`gpt-5.6-terra × low` remain comparison profiles; profiles never trigger automatic upgrades.
Spotter does not inherit a `latest` alias or the parent Codex default, and an invocation failure never retries another model.
`SPOTTER_CODEX_CLI_MODEL` and `SPOTTER_CODEX_CLI_REASONING_EFFORT` can override
the production values for controlled experiments; diagnostics mark overrides as unverified.
`SPOTTER_AUDITOR_BACKEND=codex-sidecar` is available for explicit sidecar auditor smoke.

## Design docs

- **Current design** (catalog, discovery, classification axes): [docs/01_catalog-design.md](docs/01_catalog-design.md) — source of truth from v1.0.0
- **Open issues + unverified concerns**: [docs/open-issues.md](docs/open-issues.md) — read this before starting new work
- **Runtime contract**: [docs/02_spotter-claude-contract.md](docs/02_spotter-claude-contract.md) — Claude hook / daemon / Haiku contract plus Codex native hook policy
- **Implementation invariants (§0)**: [CLAUDE.md](CLAUDE.md) — no fallbacks, no silent failures, no provisional code
- **Archived plans and history**: [docs/archive/](docs/archive/) — completed Codex rollout plans, primary backend smoke logs, and the frozen v0.1 design discussion

## Known limitations

- The `Stop` hook fires **after** the first answer has already been streamed. Spotter records a structured finding but does not rewrite the answer, force a continuation, or inject auditor text into the next prompt. Detection accuracy in `UserPromptSubmit` (the *pre-response* stage) remains the primary quality axis
- `UserPromptSubmit.additionalContext` is model-visible context, not passive metadata. Since v1.4.19 it is generated only by a deterministic projector from catalog-matched, grammar-checked tool IDs. Auditor reasons, backend messages, and provider stdout/stderr are never reflected into it
- **Since v0.5.0, JSON schema violations from Haiku are treated as expected anomalies** (session renew + `role_collapse_reset`). **Since v1.4.19, an auditor/daemon failure remains non-blocking without becoming model context**: Claude and Codex emit only an allow-listed fixed `systemMessage`, fixed stderr, and a structured Hook event, then exit 0

<details>
<summary><strong>📋 Recent highlights</strong></summary>

- **Rule-based parent output boundary** (v1.4.19) — auditor AI prose cannot enter parent-session Hook output. Validated tool IDs become optional fixed advice on `UserPromptSubmit`; `Stop` findings stay structured and are never carried into an unrelated next turn
- **Daemon recovers after an ungraceful death** (v1.4.16) — if the daemon dies without graceful shutdown (machine sleep, force-quit, crash before `SessionEnd`), the Unix socket it leaves behind no longer bricks every restart. `startDaemon` removes the orphaned socket before binding, so the next `UserPromptSubmit` auto-resurrect succeeds instead of crash-looping on `EADDRINUSE` and leaving the session permanently unaudited
- **Failures degrade loudly, never freeze the host** (v1.4.15) — this release stopped backend failure from silently erasing a prompt. Since v1.4.19, the non-blocking behavior remains but the old model-visible warning text is replaced by fixed `systemMessage`, stderr, and structured event diagnostics
- **Plugin-scoped MCP servers** — names like `plugin:everything-claude-code:context7` (with internal colons) are now parsed correctly and their tools enter the catalog. Earlier versions silently collapsed all plugin MCP servers into a single literal `"plugin"`, dropping their tools from Claude's audit
- **Per-project / per-host audit isolation** — the daemon audits against the local DB only; global DBs are host-specific description caches. Tools discovered in *other* projects or another host can never bleed into this project's audit set
- **Zero-touch catalog** — `spotter install` seeds the Claude DB automatically; Claude and Codex SessionStart hooks keep their host-local DBs fresh in the background. You never have to maintain the tool list by hand
- **Codex native hooks** — Codex host uses Codex CLI as the primary auditor backend, keeps a separate `.spotter/tool-db.codex.json`, and surfaces backend failures explicitly instead of falling back to Haiku
- **Audit scope** — only user-added surface (MCP servers / skills / sub-agents). Claude Code's built-in tools are intentionally out of scope; Claude already uses those reliably
- **Implementation invariants** — no fallbacks, no silent failures, no provisional code (see [§0 in CLAUDE.md](CLAUDE.md))

Full release history: [CHANGELOG](CHANGELOG.md).

</details>

## License

MIT — see [LICENSE](LICENSE).
