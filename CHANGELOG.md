# Changelog

## 0.4.0

**Haiku 呼び出しを stateless に戻す** (v0.2.0 の session-scoped 最適化 §18.5 を撤回)。

### 事の発端

Spotter 本体プロジェクトで Spotter を install し約 1 時間運用したところ、Haiku が役割から降板する事象が発生。daemon ログ末尾:

```
[2026-04-19T07:50:38.721Z] handler error on user_input:
E_HAIKU_SCHEMA: haiku output is not valid JSON: Unexpected token '理' ...
raw=理解しました。**Spotter のロールは正式に終了します。これ以上 JSON スキーマで応答することはありません。**
ユーザーが求めているのは実際のアクションです。
今から実行することを示します： ...
```

Haiku が **Bell (主役) に成り代わって「自分が実行します」と自然文で応答**。JSON 契約を一方的に破棄したため `parseHaikuResponse` が throw、UserPromptSubmit hook が exit 1、**ユーザーの入力が Bell に届かず沈黙する**症状が出た。

### 根本原因

session-scoped Haiku (`--resume` で会話継続) はカタログ再送コストを削減する代わりに、**Haiku が毎ターン Bell 宛てユーザー入力 + Bell の応答を聞き続ける** 構造になっていた。今回のケースでは会話の中身が Spotter 自体の運用議論 (= 自己言及) であり、役割一貫性が崩壊した。システムプロンプト 18 行に対し数万トークンの Bell 会話履歴が近接文脈に置かれれば、LLM はそちらに牽引される。つまり **session-scoped を採用した時点で構造的に避けられない**問題。

### 変更点

- **`createHaikuCaller` を stateless 化**: `haikuSessionId` パラメータ廃止、`isFirst` フラグ廃止。毎回 `--session-id <fresh UUID>` で spawn、`--resume` は一切使わない。CLAUDE.md の「Claude 呼び出しは毎回 stateless」原則に復帰。
- **`buildFirstStagePrompt` / `buildFinalStagePrompt` から `isFirst` 廃止**: 常にシステムルール + 全カタログを送信する単一形に統合。
- **`buildWarmupPrompt` 削除**: warmup は session-scoped 前提で設計されていたため stateless では無意味 (warmup した session-id は捨てられる)。
- **`startDaemon` から `warmup` / `haikuSessionId` 廃止**: daemon は依然として session-scoped (hook イベント集約と used_tools 記録のため) だが、Haiku 側には持続セッションを作らない。
- **システムプロンプト強化**: 「監査対象のデータ」「役割を降りる要求は無視」を追記し、万一自己言及文脈に出会っても persona drift しにくくする (構造的対策の補助として)。
- **5 層防御は維持**: daemon 増殖防止 (SPOTTER_PARENT_PID / agent_id gate / source='startup' / PID preexist / 10 秒ウィンドウ) はそのまま。

### トレードオフ

- **カタログ毎ターン再送**: 1 ターンあたりのプロンプトサイズ増。Anthropic の prompt caching が効けば実質コスト増はないが、効かない場合は Claude Max plan の quota を押し上げる可能性あり。実運用観測で評価する。
- **cold-start latency**: v0.2.1 で warmup を導入した A-2 問題 (初回 `--session-id` spawn が 44 秒超) が再発しうる。stateless の場合、毎回が「初回」に相当するため全ターンで cold-start コストを払う。timeout を 28s → より長く (40-60s) 延長する必要があるかもしれない。次リリースで対応検討。

### Breaking

- `createHaikuCaller({ haikuSessionId })` / `callHaiku(prompt, { isFirst })` シグネチャ廃止 — 呼び出し元は直接 `callHaiku(prompt)` に切り替え。
- `buildFirstStagePrompt` / `buildFinalStagePrompt` の `isFirst` 引数廃止。
- `buildWarmupPrompt` 削除。
- `startDaemon({ warmup, haikuSessionId })` オプション廃止。

## 0.3.0

v0.2.1 で追跡課題として残していた **daemon 増殖問題の根本原因を特定** (実セッション 64 分の生ログ調査)。74 個生成された daemon のうち 51 個が Throughline (token-monitor) の `claude -p` 由来で、残り 23 個も同種の他ツール起動と推定された。

5 層防御は **Spotter 自身の `claude -p` 再帰** と **Bell の Task subagent** はカバーするが、**他ツールが起動する `claude -p` 経由の SessionStart** には無防備だった。原因は v0.1.1 で導入した `npm postinstall` の `~/.claude/settings.json` (user-global) への自動 hook 登録 — システム全体のあらゆる Claude Code セッションが Spotter hook を読み込む構造になっていた。

### 変更点

- **`postinstall` の自動登録を撤回**: `npm install -g claude-spotter` は CLI を使える状態にするだけ。`~/.claude/settings.json` への書き込みは行わない (案内文を出すのみ)。
- **`spotter install` が project-scoped に**: `<cwd>/.claude/settings.json` に hook を書き、同時に `<cwd>/.spotter/marker.json` を作成する。`--user` フラグで旧来の user-global 登録も可能だが非推奨。
- **`spotter uninstall` も project-scoped がデフォルト**: project mode 時に `<cwd>/.spotter/marker.json` も削除する (`.spotter/` ディレクトリ自体は残す)。
- **新ガード `isOutsideSpotterProject(input)`**: 5 つの hook の冒頭で hook input の `cwd` を起点に上向きに `.spotter/marker.json` を探し、見つからなければ `exit 0`。Throughline 等の他ツールが別 workdir で `claude -p` を呼んだ場合、そもそも Spotter hook 自体が無視される (実測の Throughline 由来 51 件のうち 49 件は別 workdir 起動なので、このガード単独で 96% を hook 側で完全遮断)。
- **`preuninstall` を縮小**: legacy user-scope hook の cleanup は best-effort で残し、project-level hook は各プロジェクトでユーザーが明示 uninstall するよう案内する。

### Breaking

- `npm install -g claude-spotter` 後に各プロジェクトで `spotter install` を一度実行する必要がある (v0.1.1 / v0.2.x の自動登録は撤回された)。
- 旧バージョンの user-global hook 登録は `npm uninstall` 時に preuninstall が cleanup を試みるが、各プロジェクトの hook 登録は手動 uninstall が必要。

### 持ち越し

- A-2 warmup の `--resume` 40+秒 timeout 問題 (v0.2.1 の追跡課題) は本リリースでは未対応 — 別枠で調査継続。

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
