# Changelog

## 0.2.1

v0.2.0 の実セッション観測で `UserPromptSubmit` 経路に `E_HAIKU_TIMEOUT` が集中していることが判明 (20 分で 14 件、全て `handler error on user_input`)。Stop hook 側はタイムアウトゼロ。原因は初回 Haiku spawn (Windows: `cmd.exe /c claude.cmd -p --session-id ...`) のコールドスタートが 28s 超になるケースで、これが UserPromptSubmit hook のブロック中に直撃していた。

- **Haiku 非同期ウォームアップ (A-2)**: `startDaemon({ warmup: true })` オプションを追加。`daemon-cmd.mjs` (SessionStart 経由のエントリ) で `true` を渡す。daemon は `server.listen` 完了直後に fire-and-forget で `buildWarmupPrompt` を Haiku に送信し、`--session-id` での新規会話作成とカタログ読み込みを前倒しする。SessionStart hook の readiness ping は `daemon listening` 確認のみで完了するためユーザー体感の起動遅延ゼロ。
- **初回 `user_input` は `--resume` 経由**: ウォームアップ完了後、既存の `haikuChain` mutex が最初の real call に warmup の完了を待たせ、`isFirst=false` で `claude -p --resume` が走る。
- **warmup 後の 10 秒ウィンドウリセット**: ウォームアップも `claude -p` spawn なので `lastHaikuCallAt` を更新するが、完了時 (成否問わず) に 0 にリセットして layer 5 が warmup 直後の合法的 `user_input` を silent pass にしないようにする。SPOTTER_PARENT_PID env 他のレイヤーで recursion は遮断済みなのでリセットは安全。
- **`buildWarmupPrompt` 新設**: 既存の `buildFirstStagePrompt` を流用せず、Haiku に trivial pass (`{"pass":true,"missing_tools":[]}`) を返させる固定プロンプトを採用。`parseHaikuResponse` のスキーマチェックを通過する形で warmup が成功し、`haikuInitialized=true` が立つ。
- **失敗時は従来動作**: warmup が失敗すると `haikuInitialized=false` のまま残り、次の real call が `--session-id` で仕切り直す。悪化なし。

### 観測対象として残した課題 (v0.2.1 では未対応)

- **20 分で 28 daemon 生成**: 実セッション観測で §18.4 の 5 層防御がすり抜けている疑い (状況的には別 VSCode の旧 daemon 残存も仮説)。A-2 とは独立の bug 調査として次タスク化。
- **カタログのツール名抽象**: 実ツール名 (`current_time` カタログ記載 vs 実環境 `Bash:date`) のマッピング論点、v0.3 持ち越し。

## 0.2.0

Fixes the v0.1.x daemon proliferation by adding multiple defence layers that together prevent any
non-parent-session hook from re-entering the daemon spawn path.

- **Env-var gate (`SPOTTER_PARENT_PID`)**: the daemon injects its own PID when spawning `claude -p`
  for Haiku. Every hook checks this on startup and exits immediately when present — the primary
  fix for Spotter's own subprocess recursion.
- **`agent_id` gate**: hooks fired inside a Task subagent carry `agent_id` per the Claude Code
  hook contract. The hook entry-points exit on seeing this field, so subagent activity is never
  audited (matches v0.2's scope: top-level parent sessions only).
- **`source === 'startup'` gate on SessionStart**: `/compact`, `/clear`, `--resume`, `--continue`
  all fire SessionStart with a fresh session_id; without this gate they used to spawn a new
  daemon. Now they no-op.
- **PID-preexist check**: `startDaemon` asserts no live daemon already serves the session_id,
  throwing `DaemonAlreadyRunningError` so the caller exits cleanly.
- **10-second call window**: the daemon ignores `user_input` / `turn_end` events that arrive
  within 10 s of its own Haiku spawn. Final safety net; documented trade-off (a brief window of
  legitimate parent events may also be skipped).
- **Session-scoped Haiku conversation**: the daemon now generates one `haikuSessionId` UUID at
  startup. The first Haiku call uses `claude -p --session-id <uuid>`; subsequent calls use
  `--resume <uuid>`. The catalog is therefore sent to Haiku exactly once per parent session,
  realising plan §5.4's original economic intent. Prompts now distinguish first vs incremental
  form.
- **Mutex on Haiku calls**: a Promise chain serialises `callHaiku` so concurrent events cannot
  race on the `haikuInitialized` flag and double-send the catalog.

### Breaking

- `createHaikuCaller` now requires `haikuSessionId` (will throw without it).
- The returned `callHaiku` accepts `(prompt, { isFirst })`; callers that used `callHaiku(prompt)`
  should pass `{ isFirst: true }` (the lint flow does this).
- `buildFirstStagePrompt` / `buildFinalStagePrompt` accept `isFirst` (defaults to true, so
  existing callers that want full prompts continue working).

### Experimental-flag note

`claude -p --bare` was evaluated as a fifth layer but errors with "Not logged in" because it
skips auth auto-discovery. `--bare` is therefore NOT used. The env-var gate plus the other four
layers cover the same proliferation cases.

## 0.1.1 — ⚠️ DEPRECATED 2026-04-19

**Do not install this version.** Real-world testing against a live Claude Code session revealed that the "one daemon per session" model is based on a wrong assumption — `SessionStart` hooks fire per subagent (Task tool invocation), not only at top-level session startup. Within 41 seconds of install, 213 orphan daemons accumulated and Haiku API calls uniformly timed out. `npm uninstall -g` also did not execute `preuninstall`, leaving hook entries in `~/.claude/settings.json`. See [docs/spotter-plan.md §18](https://github.com/kitepon-rgb/Spotter/blob/main/docs/spotter-plan.md#18) for details and the v0.2 redesign plan.

## 0.1.1 (pre-deprecation notes)

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
