# Spotter Claude Contract

この文書は Phase 1a の contract capture。Codex adapter を足す前に、Claude-first の
既存動作を変えないための実装契約を短く固定する。

正本は `CLAUDE.md`。ここは実装時に参照する checklist と test 対応表。

現役文書:

- 現状課題と観測タスク: [`open-issues.md`](open-issues.md)
- カタログ / tool-db 設計: [`catalog-design.md`](catalog-design.md)
- 進行中の hook parity 移植 TODO: [`SPOTTER_HOOK_PARITY_TODO.md`](SPOTTER_HOOK_PARITY_TODO.md)

完了済み計画と歴史記録:

- Claude / Codex second-pass workflow brief: [`archive/SPOTTER_CODEX_DUAL_SUPPORT.md`](archive/SPOTTER_CODEX_DUAL_SUPPORT.md)
- Dual-support TODO / phase gates: [`archive/SPOTTER_CODEX_DUAL_SUPPORT_TODO.md`](archive/SPOTTER_CODEX_DUAL_SUPPORT_TODO.md)
- Primary backend migration TODO / smoke logs: [`archive/SPOTTER_PRIMARY_BACKEND_TODO.md`](archive/SPOTTER_PRIMARY_BACKEND_TODO.md)
- v0.1 design discussion: [`archive/spotter-plan.md`](archive/spotter-plan.md)

## Command Contract

Public CLI:

- `spotter install [-y|--yes] [--user]`
- `spotter uninstall [-y|--yes] [--user]`
- `spotter db list [--host-agent claude|codex|automation]`
- `spotter db refresh [--host-agent claude|codex|automation]`
- `spotter db rebuild [--host-agent claude|codex|automation]`
- `spotter status`
- `spotter doctor`
- `spotter diagnostics logs [--log-dir <dir>] [--json]`
- `spotter codex risk-check --findings <file> [--project <dir>] [--host-agent <agent>]`
- `spotter codex review --findings <file> [--project <dir>] [--host-agent <agent>]`
- `spotter codex explore --findings <file> [--project <dir>] [--host-agent <agent>]`
- `spotter codex opinion --findings <file> [--project <dir>] [--host-agent <agent>]`
- `spotter codex work --findings <file> --instruction <text> --approve-work --allowed-path <path>
  (--preserve-worktree | --remove-worktree) [--project <dir>] [--host-agent <agent>]`
- `spotter codex-hook install [--codex-home <dir>]` (Codex native hooks)
- `spotter codex-hook uninstall [--codex-home <dir>]`
- `spotter codex-hook diagnostics [--codex-home <dir>] [--project <dir>]`
- `spotter --help | -h`
- `spotter --version | -v`

Internal CLI:

- `spotter daemon start --session-id <id>`
- `spotter hook session-start`
- `spotter hook user-prompt`
- `spotter hook pre-tool-use`
- `spotter hook stop`
- `spotter hook session-end`
- `spotter codex-hook session-start`
- `spotter codex-hook user-prompt-submit`
- `spotter codex-hook stop`

Unknown public command, unknown `db` subcommand, unknown `daemon` subcommand, and unknown
hook event exit with code `2` and print usage / error to stderr.

## Hook Contract

All hooks read one JSON object from stdin, unless `SPOTTER_PARENT_PID` is set. Invalid or
empty stdin is an unexpected hook failure.

Codex native hooks use Codex hook payloads, not Claude hook JSON. The
current Codex adapter installs user-level `~/.codex/hooks.json` entries for `SessionStart`,
`UserPromptSubmit`, and `Stop`, keeps `.spotter/marker.json` project gating, exits early when
`SPOTTER_PARENT_PID` is set, and selects Codex CLI as the default primary auditor backend.
When `spotter install` sees Codex CLI and registers Codex hooks, it also synchronously seeds
`.spotter/tool-db.codex.json` so the first Codex session has a host-local catalog. Codex
`SessionStart` does not start a daemon; it only launches a detached
`spotter db refresh --host-agent codex` so `.spotter/tool-db.codex.json` follows the Codex
tool environment without overwriting Claude `.spotter/tool-db.json` or Claude's global
description cache at `~/.spotter/tool-db.json`. Codex global cache writes go to
`~/.spotter/tool-db.codex.json`. Codex `Stop` does not
block the just-finished answer. It uses deferred delivery: Spotter context is queued under
`.spotter/pending/` (host-neutral, shared with Claude Stop deferred delivery as of v1.4.8) and surfaced on the next same-session `UserPromptSubmit`.
This is intentional. Real Codex hook smoke showed that `decision:"block"` after final
answer becomes `Stop Blocked` / exit code 1 rather than a clean continuation, so the
Codex adapter follows the pending-queue pattern until Codex exposes a non-blocking
Stop continuation / additional-context surface. Backend errors are also written to
stderr so one-shot `codex exec` runs do not hide the failure. Codex hook auditor calls use
`--model gpt-5.4-mini`, `model_reasoning_effort="low"`, and a 20s timeout by default. Short `Stop` final responses with
no used tools are skipped to avoid duplicate post-answer latency.

- Claude `SessionStart`
  - returns without spawning when `SPOTTER_PARENT_PID` is set.
  - returns without spawning when `agent_id` is present.
  - returns without spawning when `source !== "startup"`.
  - returns without spawning outside a project containing `.spotter/marker.json`.
  - otherwise starts the daemon for `session_id`, waits for readiness, then launches bg refresh.
- Codex `SessionStart`
  - returns early when `SPOTTER_PARENT_PID` is set.
  - returns outside a project containing `.spotter/marker.json`.
  - otherwise starts detached `spotter db refresh --host-agent codex` and returns without waiting.
- `UserPromptSubmit`
  - returns early for child calls, subagent calls, outside-project calls.
  - drains `<projectRoot>/.spotter/pending/<sessionId>.json` before deciding short-prompt skip.
  - on short prompt (≤10 chars trimmed), emits drained pending context (if any) and returns.
  - sends `event:"user_input"` to the daemon for non-short prompts.
  - on `E_UNREACHABLE`, respawns daemon once and retries.
  - merges drained pending context with daemon `pass:false` finding into one `additionalContext`.
  - appends a `spotter.hook_event.v1` record to `.spotter/hook-events.jsonl`.
- `PreToolUse`
  - records `tool_name` as `event:"tool_used"`.
  - never calls Haiku.
  - appends a `spotter.hook_event.v1` record to `.spotter/hook-events.jsonl`.
- `Stop` (Phase B / v1.4.8 — deferred delivery)
  - sends visible assistant text as `event:"turn_end"`.
  - daemon may early-pass with `reason:"short_final_no_tools"` when final ≤120 chars and used_tools is empty
    (`SPOTTER_STOP_SHORT_FINAL_MAX_CHARS` to tune; `<= 0` disables).
  - on `pass:false`, **does NOT** return `decision:"block"`. Appends the same transparent
    block-reason wording to `<projectRoot>/.spotter/pending/<sessionId>.json` (JSON array,
    de-duplicated) and exits 0 with no stdout. Pending entries surface on the next same-session
    UserPromptSubmit's `additionalContext`.
  - `stop_hook_active:true` triggers daemon early-pass; nothing is queued.
  - backend / transport errors still exit 1 + stderr (silent fallback forbidden).
  - appends a `spotter.hook_event.v1` record to `.spotter/hook-events.jsonl`.
- `SessionEnd`
  - requests daemon shutdown for the session.
  - appends a `spotter.hook_event.v1` record to `.spotter/hook-events.jsonl` (cleanup
    failures are warned to stderr, not failed).

## Daemon Safety Contract

Recursive hook / daemon proliferation must stay blocked by:

- `SPOTTER_PARENT_PID`
- `agent_id`
- `source === "startup"`
- `.spotter/marker.json`
- PID preexist check
- 10 second Haiku call window

Lifecycle cleanup uses heartbeat + `UserPromptSubmit` auto-resurrect. Do not restore
`process.ppid` parent-watch cleanup.

## IPC Contract

Hook to daemon transport is newline-delimited JSON over a Unix socket / Windows named pipe.

Request envelope:

```json
{"id":"<uuid>","event":"<event>","session_id":"<session>","payload":{}}
```

Success response:

```json
{"id":"<same uuid>","ok":true,"result":{}}
```

Error response:

```json
{"id":"<same uuid or null>","ok":false,"error":{"code":"E_*","message":"..."}}
```

Client-side transport errors use:

- `E_UNREACHABLE`
- `E_TIMEOUT`
- `E_INTERNAL`

## Haiku Contract

Haiku receives the full preamble only on the first call of a session. Resumed calls receive
only the per-turn delta. This avoids transcript bloat with `claude --resume`.

Preamble contains:

- role / output rules
- JSON schema
- few-shot examples
- project-local tool catalog `{name, description}`

Per-turn prompts:

- `stage=user_input` contains only `<user_input>`.
- `stage=turn_end` contains only `<used_tools>` and `<final_response>`.
- `stage=turn_end` intentionally does not include user input.

Haiku response schema:

```json
{"pass":true,"missing_tools":[]}
```

or:

```json
{"pass":false,"missing_tools":[{"name":"<catalog tool name>","reason":"<reason>"}]}
```

Schema violations throw `E_HAIKU_SCHEMA` and trigger role-collapse recovery. Catalog-external
tool names are filtered out after parse. `E_HAIKU_TIMEOUT` and `E_INTERNAL` continue to throw.

## Neutral Projection Contract

Haiku parse results are converted to `SpotterJudgment` before being projected back to the
existing Claude-facing `{pass, missing_tools, reason?}` shape.

- `SpotterFinding` fields: `id`, `stage`, `toolName`, `reason`, `category`, `severity`,
  `confidence`, `references`, `source`, `raw`.
- `role_collapse_reset` and `hallucination_filtered` are represented as normal judgment
  `anomalies`, then projected back to the existing `reason` field.
- `E_HAIKU_TIMEOUT` and `E_INTERNAL` are not normal judgments. They continue to surface
  as thrown daemon errors after session reset.
- Codex context projection uses local JSON compatibility only in Phase 3:
  `kind:"manual_note"`, `source:"spotter"`, `trust:"local"`.
- Codex sidecar policy for second-pass workflows is explicit: `unavailable` and
  `explicitly disabled` return a skipped / compatibility result for the sidecar workflow,
  Codex host does not call Codex sidecar without an independent boundary, and sidecar
  children are spawned with `SPOTTER_PARENT_PID` so Claude hooks do not start nested
  Spotter daemons. This does not define primary auditor backend fallback behavior.
- `spotter codex risk-check|review|explore|opinion` are explicit read-only sidecar
  workflows. They read `SpotterFinding[]`, build a temporary context-file, invoke the
  matching `codex-sidecar` workflow, and store `spotter.sidecar_result.v1`.
  `risk-check` can be dispatched from the daemon only through the opt-in async path below.
- Daemon-side risk dispatch is opt-in only. With `SPOTTER_CODEX_RISK_CHECK=1`, `pass:false`
  judgments are written under `.spotter/sidecar-inputs/` and dispatched through a detached
  `spotter codex risk-check` process. Hook responses do not wait for Codex. Use
  `SPOTTER_CODEX_RISK_CHECK_DRY_RUN=1` for wiring smoke.
- `spotter codex work` is write-capable and explicit only. It requires `--approve-work`,
  an instruction, at least one `--allowed-path`, and an explicit cleanup policy. Spotter
  writes a temporary scoped sidecar config that narrows `allowed_paths`, invokes
  `codex-sidecar work --preset work`, and then validates returned `changedFiles` against
  the approved scope before marking the result successful.
- `spotter diagnostics logs` is read-only. It parses daemon log files and reports
  `pass:false`, missing-tool counts, duration summaries, catalog-external drops,
  role-collapse resets, Haiku failures, handler errors, fatal exits, and Codex risk
  dispatch signals without changing daemon behavior.

## Primary Backend Vs Second-Pass Workflow

Primary auditor backend は `UserPromptSubmit` / `Stop` 相当の主判定を返す経路です。
この backend は hook hot path 上で `{pass, missing_tools}` または `SpotterJudgment` を返し、
Claude-facing projection の入力になります。現行 default は Claude Haiku です。

Second-pass workflow は、主判定で得た `SpotterFinding[]` を別の観点で確認する経路です。
`spotter codex risk-check|review|explore|opinion|work` はここに属し、`codex-sidecar`
を呼ぶ場合でも hook の主判定そのものを置き換えません。daemon からの `risk-check`
dispatch も opt-in かつ detached であり、hook response は Codex を待ちません。

Codex host の primary auditor backend は v1.4.5 時点で Codex CLI (`codex exec`) が既定です。
Claude host の `current` policy は現行 Haiku-compatible path を既定として維持します。
v1.4.7 以降、Claude host の opt-in `next` policy
(`SPOTTER_AUDITOR_BACKEND_POLICY=next`) は primary auditor を Codex CLI に切り替えます
(reason `policy_next_claude_codex_cli`)。Codex CLI が unavailable / timeout / schema invalid /
non-zero exit の場合は `AuditorBackendError` を hidden fallback せず構造化エラーとして表面化します。
Claude host で Haiku を選べるのは `current` policy または `SPOTTER_AUDITOR_BACKEND=haiku`
明示時のみです。完了済みの migration 計画と smoke 結果は
[`archive/SPOTTER_PRIMARY_BACKEND_TODO.md`](archive/SPOTTER_PRIMARY_BACKEND_TODO.md) に保管しています。

## Regression Coverage

- `test/hooks.test.mjs`: hook wording, marker gate, child/subagent/non-startup gates.
- `test/haiku-caller.test.mjs`: prompt builders, catalog-only rule, parse/filter schema.
- `test/daemon.test.mjs`: daemon event behavior, heartbeat, role-collapse recovery, call window.
- `test/judgment.test.mjs`: neutral finding / judgment schema and Claude legacy projection.
- `test/sidecar-context.test.mjs`: Codex context block projection and structured result record.
- `test/codex-sidecar-policy.test.mjs`: host / availability policy, Codex-on-Codex guard,
  and sidecar env hook recursion guard.
- `test/codex-sidecar-runner.test.mjs`: read-only Codex sidecar runners, work-capable
  scoped workflow, context-file handoff, unavailable structured skip, and findings JSON
  input shapes.
- `test/codex-risk-dispatch.test.mjs`: daemon-side detached dispatch input files, env gates,
  and recursion-blocking child env.
- `test/daemon-log-diagnostics.test.mjs`: read-only daemon log aggregation for precision
  diagnostics and operational anomaly signals.
- `test/transport.test.mjs`: IPC response shape and transport errors.
- `test/install.test.mjs`: hook registration and timeout updates.
