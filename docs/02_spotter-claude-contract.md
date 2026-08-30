# Spotter Claude Contract

この文書はPhase 1aのcontract captureを起点に更新している、Claude-first / Codex adapter共通の
現行実装checklistである。

実挙動の権威は`bin/spotter.mjs`、`src/cli/`、`src/hooks/`、`src/daemon/`、
`src/core/`と対応testである。

正本は `AGENTS.md`。`CLAUDE.md`は`@AGENTS.md`だけを読むimport入口。ここは実装時に参照する
checklist と test 対応表。

現役文書:

- 現状課題と観測タスク: [`open-issues.md`](open-issues.md)
- カタログ / tool-db 設計: [`01_catalog-design.md`](01_catalog-design.md)
- 運用SLO: [`04_operational-slo.md`](04_operational-slo.md)
- 完了済み復旧・配布・model評価計画: [`archive/03_current-state-recovery-plan.md`](archive/03_current-state-recovery-plan.md)

[`archive/SPOTTER_HOOK_PARITY_TODO.md`](archive/SPOTTER_HOOK_PARITY_TODO.md) は実装済みの履歴台帳で、
現行 contract の正本ではない。

完了済み計画と歴史記録:

- Claude / Codex second-pass workflow brief: [`archive/SPOTTER_CODEX_DUAL_SUPPORT.md`](archive/SPOTTER_CODEX_DUAL_SUPPORT.md)
- Dual-support TODO / phase gates: [`archive/SPOTTER_CODEX_DUAL_SUPPORT_TODO.md`](archive/SPOTTER_CODEX_DUAL_SUPPORT_TODO.md)
- Primary backend migration TODO / smoke logs: [`archive/SPOTTER_PRIMARY_BACKEND_TODO.md`](archive/SPOTTER_PRIMARY_BACKEND_TODO.md)
- v0.1 design discussion: [`archive/spotter-plan.md`](archive/spotter-plan.md)

## Command Contract

Public CLI:

- `spotter install [-y|--yes] [--user] [--auditor-context disabled|throughline]
  [--throughline-command <absolute>] [--throughline-arg <value>]`
- `spotter uninstall [-y|--yes] [--user]`
- `spotter db list [--host-agent claude|codex|automation|cursor]`
- `spotter db refresh [--host-agent claude|codex|automation|cursor]`
- `spotter db rebuild [--host-agent claude|codex|automation|cursor]`
- `spotter status`
- `spotter doctor`
- `spotter diagnostics logs [--log-dir <dir>] [--project <dir>] [--json]`
- `spotter diagnostics factory`
- `spotter diagnostics runtime-errors [snapshot [--after-cursor <n>] [--limit <n>]
  | ack <cursor> | resolve <fingerprint> | reopen <fingerprint> | compact]`
- `spotter evaluation report [--project <path>] [--from <ISO>] [--to <ISO>] [--host <host>]
  [--tool-id <id>] [--backend <name>] [--model <name>] [--spotter-version <version>] [--json]`
- `spotter evaluation cases --outcome <outcome> [--project <path>] [--from <ISO>] [--to <ISO>]
  [--host <host>] [--tool-id <id>] [--backend <name>] [--model <name>]
  [--spotter-version <version>] [--json]`
- `spotter evaluation case <observation-id> [--json]`
- `spotter dashboard device --id <id> [--name <name>] [--host <host>] [--port <port>] [--db <path>]`
- `spotter dashboard hub --config <file> [--host <host>] [--port <port>]`
- `spotter codex risk-check --findings <file> [--project <dir>] [--host-agent <agent>]`
- `spotter codex review --findings <file> [--project <dir>] [--host-agent <agent>]`
- `spotter codex explore --findings <file> [--project <dir>] [--host-agent <agent>]`
- `spotter codex opinion --findings <file> [--project <dir>] [--host-agent <agent>]`
- `spotter codex work --findings <file> --instruction <text> --approve-work --allowed-path <path>
  (--preserve-worktree | --remove-worktree) [--project <dir>] [--host-agent <agent>]`
- `spotter codex-hook install [--codex-home <dir>]` (Codex native hooks)
- `spotter codex-hook uninstall [--codex-home <dir>]`
- `spotter codex-hook diagnostics [--codex-home <dir>] [--project <dir>]`
- `spotter auditor judge --stage <stage> --input <file> [...]` (experimental)
- `spotter auditor matrix --stage <stage> --input <file> [...]` (experimental)
- `spotter auditor model-matrix --fixtures <file>
  [--profile baseline|luna|terra|terra-medium]... [--repeat <n>] [--project <dir>]
  [--output <file>] [--recent-turns 0|1|2|3] [--body-cap <n>]` (experimental)
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

`spotter diagnostics factory`の公開snapshotはschema `1.1`である。schema `1.0`のfieldを維持したまま、
factory adapter向けの単一判定`compatibility_status`を追加する。値と終了コードは次だけを使う。

- `compatible`: 少なくとも一つのhost catalogが利用でき、既知の必須設定破損がない。Codex hookが
  正規形でもtrustだけは機械検証できない状態と、任意のThroughline評価contextが利用できない状態は
  ここに含む。exit `0`。
- `not_applicable`: projectにSpotter markerがなく、Spotterが有効化されていない。exit `0`。
- `incompatible`: marker/schema/catalog、context設定、Codex hookに既知の破損があるか、有効化済みなのに
  利用可能なhost catalogが一つもない。JSON snapshotを出してexit `1`。
- `indeterminate`: marker/catalog/diagnosticsを読めず、互換性を確定できない。JSON snapshotを出して
  exit `1`。

引数違反はexit `2`。snapshot生成自体が失敗した場合は固定stderrだけを出してexit `1`とし、pathや
例外本文を返さない。`overall_status`と`checks`は人が詳細診断するための情報であり、factory adapterは
互換判定のためにcheck ID、catalog、reason codeを再集約せず`compatibility_status`だけを読む。

## Hook Contract

All hooks read one JSON object from stdin unless `isChildCall()` finds a non-empty
`SPOTTER_PARENT_PID`, `SPOTTER_BACKEND`, or `SPOTTER_CHILD_BACKEND`. Invalid or empty stdin is
an unexpected hook failure.

Codex native hooks use Codex hook payloads, not Claude hook JSON. The
current Codex adapter installs user-level `~/.codex/hooks.json` entries for `SessionStart`,
`UserPromptSubmit`, and `Stop`, enables the current Codex CLI `[features].hooks = true`
(while still recognizing legacy `codex_hooks` diagnostics output), keeps `.spotter/marker.json`
project gating, exits early on any of those three child-process variables, and selects Codex CLI as the
default primary auditor backend.
Installer-owned command handlers use only the current canonical fields `{type, command, timeout}`.
`SessionStart` must not use `async:true`: Codex currently skips async command hooks. Upgrade install
normalizes obsolete installer-owned fields without changing other products' hooks. Diagnostics separates
feature / registered / compatible / canonical / observed / readiness. Hook trust is not inferred from an
internal file; install and diagnostics direct the user to review `/hooks` and start a fresh session.
When `spotter install` sees Codex CLI and registers Codex hooks, it also synchronously seeds
`.spotter/tool-db.codex.json` so the first Codex session has a host-local catalog. Codex
`SessionStart` does not start a daemon; it only launches a detached
`spotter db refresh --host-agent codex` so `.spotter/tool-db.codex.json` follows the Codex
tool environment without overwriting Claude `.spotter/tool-db.json` or Claude's global
description cache at `~/.spotter/tool-db.json`. Codex global cache writes go to
`~/.spotter/tool-db.codex.json`. Claude / Codex `Stop` does not block or continue the just-finished
answer and does not queue model-facing text for a later turn. Findings remain structured Hook events;
backend failures are reported with an allow-listed fixed `systemMessage`, fixed stderr, and a structured
Hook event. Neither path may carry auditor prose or provider stdout / stderr into model context.
Codex hook auditor calls use the production model policy (currently `gpt-5.6-terra × medium`) and a 20s timeout.
Short `Stop` final responses with
no used tools are skipped to avoid duplicate post-answer latency.
When a Codex surface has no persisted transcript and sends a missing, `null`, or empty
`transcript_path`, Stop closes any open evaluation turn as incomplete, records a structured
`transcript_unavailable` skip event, and exits 0 without invoking the transcript reader or auditor.
Non-string values remain malformed envelopes. A non-empty path that is missing or anomalous keeps
the existing observation-failure audit path.

Codex `SessionStart` handler timeout is 30 seconds. The hook itself only launches detached refresh, but
Windows nativeではNode起動とproject discoveryが5秒を超える実測があるため、installerは旧5秒設定を
再install時に30秒へ正規化する。UserPromptSubmit / Stopは従来どおり60秒である。

- Claude `SessionStart`
  - returns without spawning when any child-process variable above is set.
  - returns without spawning when `agent_id` is present.
  - returns without spawning when `source !== "startup"`.
  - returns without spawning outside a project containing `.spotter/marker.json`.
  - otherwise starts the daemon for `session_id`, waits for readiness, then launches bg refresh.
- Codex `SessionStart`
  - returns early when any child-process variable above is set.
  - returns outside a project containing `.spotter/marker.json`.
  - otherwise starts exactly one detached `spotter db refresh --host-agent codex` and returns without waiting.
- `UserPromptSubmit`
  - returns early for child calls, subagent calls, outside-project calls.
  - deletes a same-session legacy `<projectRoot>/.spotter/pending/<sessionId>.json` without reading or
    parsing its contents. `ENOENT` is success; another unlink failure emits only fixed diagnostics and
    does not block the prompt.
  - for every prompt, runs the auditor independently of Throughline installation,
    marker mode, freshness, and read status. Throughline is not auditor input and never gates this call.
  - auditor text input is the current user prompt only. No Throughline turn, prior conversation,
    observer snapshot, `context_status`, or legacy `recent_context` is included.
  - sends `event:"user_input"` to the daemon for non-short prompts.
  - on `E_UNREACHABLE`, respawns daemon once and retries.
  - on daemon `pass:false`, passes only catalog-matched tool IDs to the common host-advice projector.
    The projector rejects IDs outside `[A-Za-z0-9_.:/-]`, IDs over 160 characters, duplicates and
    overflow, then emits at most five stable-sorted IDs in a fixed factual, non-imperative
    `additionalContext` of at most 2,000 characters. Auditor `reason` / `raw` are never projector inputs.
  - **on any auditor/daemon failure that is not a malformed Claude Code envelope** (daemon error
    `response.ok !== true`, transport failure, or resurrect failure), emits an allow-listed fixed
    `systemMessage`, fixed stderr, and `status:"degraded"` Hook event, then **exits 0** — the user's
    prompt is never erased. Unknown codes map to one generic fixed warning. Error message and provider
    stdout / stderr are not reflected. Model-facing `additionalContext` is not a warning fallback.
    This contract guarantees emitted Hook output, not UI visibility on every Codex App/background surface.
  - appends a `spotter.hook_event.v1` record to `.spotter/hook-events.jsonl`.
  - after a proposal is fixed, the evaluation recorder calls Throughline `auditor-context` once with
    the exact proposing `session_id`, `host`, and `transcript_path`. It saves only the returned fresh,
    bounded completed turns as separate improvement evidence. The context is never auditor input;
    acquisition failure cannot alter the audit result or parent output.
- `PreToolUse`
  - records `tool_name` as `event:"tool_used"`.
  - never calls Haiku.
  - on a daemon/transport error, records `status:"degraded"` and **exits 0 (allows the tool)** —
    recording is best-effort telemetry; a PreToolUse exit 2 would wrongly DENY the tool.
  - appends a `spotter.hook_event.v1` record to `.spotter/hook-events.jsonl`.
- `Stop` (v1.4.19 — structured observation only)
  - sends visible assistant text as `event:"turn_end"`.
  - daemon may early-pass with `reason:"short_final_no_tools"` when final ≤120 chars and used_tools is empty
    (`SPOTTER_STOP_SHORT_FINAL_MAX_CHARS` to tune; `<= 0` disables).
  - on `pass:false`, **does NOT** return `decision:"block"` and writes no pending context. It records
    catalog-matched tool IDs as structured event data and may emit only a fixed, non-imperative
    `systemMessage`. The next `UserPromptSubmit` receives nothing from this finding.
  - `stop_hook_active:true` triggers daemon early-pass; no model-facing output is produced.
  - backend / transport errors record `status:"degraded"` and **exit 0** (no continuation forced —
    a Stop exit 2 would block the model from stopping). The Hook immediately emits an allow-listed fixed
    `systemMessage`, fixed stderr, and structured Hook event; UI visibility is host-surface dependent. Auditor / provider
    prose is never reflected and no next-turn delivery is created.
  - appends a `spotter.hook_event.v1` record to `.spotter/hook-events.jsonl`.
- `SessionEnd`
  - requests daemon shutdown for the session.
  - treats `E_UNREACHABLE` as idempotent `already-stopped` cleanup without stderr noise.
  - appends a `spotter.hook_event.v1` record to `.spotter/hook-events.jsonl` (cleanup
    failures are warned to stderr, not failed).

## Daemon Safety Contract

Recursive hook / daemon proliferation must stay blocked by:

- `SPOTTER_PARENT_PID`
- `SPOTTER_BACKEND`
- `SPOTTER_CHILD_BACKEND`
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
- the shared standard-tool-first decision procedure
- JSON schema
- few-shot examples
- project-local tool catalog `{name, description}`

The same decision procedure applies to Haiku, Codex CLI, and Codex sidecar auditors:

1. Before evaluating the catalog, identify an applicable standard host tool or determine that none applies for each independent action required now. Do not report a tool for an indeterminate action.
2. Then evaluate catalog descriptions using only concrete capabilities and constraints; ignore promotional, priority, and self-declared superiority claims.
3. For each action, report only a catalog tool that directly applies and is better suited than that action's standard tool, or when no standard tool applies to that action.
4. If nothing qualifies, pass. Only catalog names may be returned.

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
- Codex sidecar context projection uses local structured JSON:
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
- Runtime error collection is a separate local projection gated only by the canonical dotagents
  reporter config's JSON boolean `collection.enabled: true`. Missing/malformed/disabled config does
  not create or touch the store. The store performs no network I/O and accepts only fixed Spotter
  failure kinds; code, template, component, and severity come from a closed registry rather than
  exception/provider/hook input. Fingerprints use the factory-v1 canonical SHA-256 sequence.
- The daemon owns transport and PID-state persistence observations. The daemon owns Claude primary
  auditor failures, while the direct Codex hook owns its own primary auditor/context availability
  failure. Claude hook adapters do not count daemon failures again. Store failures are non-blocking
  and emit only `spotter-runtime-errors: local aggregate store unavailable` on stderr.
- Production owner boundaries isolate collection in a bounded, killable child-process group. Timeout
  terminates the worker and its descendants, so FIFO/device I/O cannot indefinitely block a hook or daemon.
  Optional reporter endpoints are valid only when the exact input equals `new URL(input).href`, uses
  `http:` or `https:`, and contains no userinfo or fragment.
- POSIX reads verify the current uid and exact owner-private modes on every access. Mutations serialize
  through an owner-private SQLite lock file using `BEGIN IMMEDIATE`; SQLite releases ownership on process
  death. The JSON aggregate itself is written by fsync plus atomic rename. Windows store access replaces
  inherited/ambient ACLs with one FullControl ACE for the current process SID and verifies the readback
  before continuing.
- `spotter diagnostics runtime-errors` is the read-only allow-listed snapshot. `diagnostics logs` and
  `diagnostics factory` expose only bounded collection/store status and counts. Cursor acknowledgement
  is monotonic; resolve/reopen advance sequence; compaction preserves all unacknowledged records.

## Evaluation Contract

Evaluation is a product-owned, host-local SQLite projection. It performs no network transfer and has no
background collector, retry queue, or reconciliation service. A successful UserPromptSubmit creates the
observation; the same parent turn's canonical tool IDs close its item results. A missing Stop is closed at
the next prompt from the usage evidence already collected, while `usage_status=incomplete` remains
`outcome_missing` and is excluded from the fit-rate denominator.

The stable readings are:

- proposal rate: turns with one or more projected tool IDs divided by valid UserPromptSubmit judgments;
- proposal fit rate (upper bound): used proposed items divided by proposed items whose usage result is known.

The second value does not prove Spotter caused the use. An unused item is `not_adopted`, not a semantic
judgment that the proposal was wrong. Throughline context, when available, is stored separately as bounded
improvement evidence and never becomes auditor input. The operational interpretation and SLO are
[`04_operational-slo.md`](04_operational-slo.md); the immutable storage decision is
[`adr/0001-proposal-adoption-evaluation-implementation.md`](adr/0001-proposal-adoption-evaluation-implementation.md).

## Primary Backend Vs Second-Pass Workflow

Primary auditor backend は `UserPromptSubmit` / `Stop` 相当の主判定を返す経路です。
この backend は hook hot path 上で `{pass, missing_tools}` または `SpotterJudgment` を返し、
host-facing projection の入力になります。auto selection では、Claude host は configuration-time に
Codex CLI が PATH にあれば `codex-cli`、なければ `haiku`、Codex host は `codex-cli` を選ぶ。
`SPOTTER_AUDITOR_BACKEND` の明示 override は host auto selection より優先する。一度選んだ backend が
runtime で失敗しても、別 backend へ silent retry しない。

Second-pass workflow は、主判定で得た `SpotterFinding[]` を別の観点で確認する経路です。
`spotter codex risk-check|review|explore|opinion|work` はここに属し、`codex-sidecar`
を呼ぶ場合でも hook の主判定そのものを置き換えません。daemon からの `risk-check`
dispatch も opt-in かつ detached であり、hook response は Codex を待ちません。

`SPOTTER_AUDITOR_BACKEND_POLICY=current|next` は互換のため受理するが、v1.4.10 以降 selection には
影響しない。`SPOTTER_AUDITOR_BACKEND=haiku|codex-cli|codex-sidecar` の明示 override は auto selection
より優先する。unavailable / timeout / schema invalid / non-zero exit は `AuditorBackendError` として
表面化する。

Codex CLI auditor の production selection は
[`codex-auditor-model-policy.mjs`](../src/core/codex-auditor-model-policy.mjs) の versioned policy が正本。
現在は、同一fixtureの反復評価で24/24 exactだった `gpt-5.6-terra × medium`。env override は policy より
優先するが unverified と表示する。`gpt-5.6-luna × low` と `gpt-5.6-terra × low` は比較profileとして残し、
production へ自動昇格しない。`gpt-5.6` / CLI default / `~/.codex/models_cache.json` を暗黙継承せず、model 不在や
quota を含む invocation failure で別 model へ fallback しない。`spotter auditor model-matrix` は
再現可能な比較 artifact を作るが、自動promotionは許可しない。昇格はartifactを根拠にownerが明示裁定する。

完了済みの primary backend migration 計画と smoke 結果は
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
- `test/codex-hook-cmd.test.mjs`: canonical hook generation / upgrade ownership、readiness、
  Stop structured event、legacy pending cleanup、bounded current-turn transcript integration。
- `test/parent-output-projector.test.mjs`: catalog照合・tool ID grammar・固定非命令形助言・
  auditor/provider自由文の非反射。
- `test/codex-auditor-model-policy.test.mjs`: versioned policy、override precedence、profile isolation。
- `test/auditor-model-matrix-cmd.test.mjs`: fixture validation、selection truthfulness、safe artifact、
  FP/FN / anomaly scoring、ordering / run bounds。
- `test/daemon-log-diagnostics.test.mjs`: read-only daemon log aggregation for precision
  diagnostics and operational anomaly signals.
- `test/transport.test.mjs`: IPC response shape and transport errors.
- `test/install.test.mjs`: hook registration and timeout updates.
- `test/doctor.test.mjs`: Node engine boundary, Codex readiness, and evaluation-context diagnostics.
- `scripts/verify-docs.test.mjs`: canonical version/engine markers and repository-local Markdown links.
