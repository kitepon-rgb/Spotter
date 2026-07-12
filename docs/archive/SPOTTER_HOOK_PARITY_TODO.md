# Spotter Hook Behavior Parity TODO

> 完了済みの履歴台帳。現行仕様は [`../02_spotter-claude-contract.md`](../02_spotter-claude-contract.md)、
> 現在の課題は [`../open-issues.md`](../open-issues.md) を参照。

Codex host で改修した hook 挙動 (deferred delivery / short-skip / hook event JSONL) を Claude host
にも移植して、3 hook (UserPromptSubmit / PreToolUse / Stop) の挙動思想を揃える計画書兼進捗 TODO。
backend の取り扱いは [`SPOTTER_PRIMARY_BACKEND_TODO.md`](SPOTTER_PRIMARY_BACKEND_TODO.md)
で完了済み (v1.4.7) のため、ここでは扱わない。

## Document Map

- 正本: [`../../CLAUDE.md`](../../CLAUDE.md)
- 現状課題: [`../open-issues.md`](../open-issues.md)
- Claude hook / daemon / Haiku contract: [`../02_spotter-claude-contract.md`](../02_spotter-claude-contract.md)
- Backend port (完了済み): [`SPOTTER_PRIMARY_BACKEND_TODO.md`](SPOTTER_PRIMARY_BACKEND_TODO.md)

## Goal

Codex 改修で確定した「hook 単位での skip / deferred delivery / 構造化 event log」を Claude 側にも
持ち込み、両 host で同一の hook 思想に揃える。Claude 側固有の制約（Pre-Response hook 不在 /
session-scoped daemon が真実源 / decision:"block" が機能する）は維持しつつ、UX としての挙動を
Codex と一致させる。

| Item | Codex side (現状) | Claude side (target) |
|---|---|---|
| Stop short-skip | `shouldSkipShortCodexStop({finalResponse, usedTools})` で 120 chars / 0 tools skip | daemon `handleTurnEnd` 冒頭で同条件 skip。`SPOTTER_STOP_SHORT_FINAL_MAX_CHARS` で調整 |
| Stop deferred delivery | `.spotter/codex-pending/<sessionId>.json` に積み次 UserPromptSubmit で `additionalContext` 配信 | `.spotter/pending/<sessionId>.json` (host-neutral) に統一、`decision:"block"` 廃止 |
| Hook event JSONL | `.spotter/codex-hook-events.jsonl` schema `spotter.codex_hook_event.v1` | `.spotter/hook-events.jsonl` schema `spotter.hook_event.v1` (`host` フィールド追加)、Codex 側も移行 |

## Decisions Locked

ユーザー確認済みで再議論しない。

- **A short-skip**: daemon 側で実装（IPC 1 往復、`state.usedTools` を真実源として使う）。閾値は Codex と同じ 120 chars + 0 used_tools。
- **B deferred delivery**: pending payload は **指摘テキストのみ**。前ターン応答の引用は含めない。session memory が前ターン応答を保持しているので冗長。運用観測で必要なら上位互換に拡張。
- **D JSONL ファイル名**: 共有 `.spotter/hook-events.jsonl` + `host` フィールド。Codex 側も同ファイルへ移行。
- **D 正本**: hook JSONL と daemon log を両方残す。役割が異なる（hook 側 skip 理由 vs auditor 内部状態）。`spotter diagnostics logs` が両方を統合集計。
- **PreToolUse の transcript 化は scope 外**。Claude 側は daemon が `state.usedTools` を保持する構造を維持する。

## Background — なぜ deferred delivery か

`decision:"block"` は Claude Code 側で機能している（Bell 再応答サイクルが回る）が、UX として欠陥が残る:

1. Bell が「A について」最初の応答を生成 → transcript に残る
2. Spotter が `decision:"block"` で reason 送付
3. Bell が補正応答を出す → これが transcript の最終応答
4. 後から transcript を遡ると、最終応答は補正中心で **A の文脈が迷子になる**

`docs-lookup` agent (2026-05-08, agentId `af2ec440ac8d409f2`) で確認した結果、Claude Code に
Pre-Response hook 相当 (最終応答が UI に出る前に介入できる hook) は **存在しない**。
公式 hook event は `SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` /
`Notification` / `Stop` / `SubagentStop` / `PreCompact` / `SessionEnd` の 9 種で、
Stop hook は事後介入のみ。

そのため、当ターンの再応答ループは諦めて A の応答を transcript に残し、指摘は次ターンの
`additionalContext` として配信する deferred 化が現実的な最適解。Codex 側の deferred 化（block が
動かない事情）とは別の根拠（Claude UX 改善）で同じ形に到達する。

## Phases

### Phase A. Stop short-skip ✅ 完了 (2026-05-08)

- [x] [src/daemon/daemon.mjs](../../src/daemon/daemon.mjs) `handleTurnEnd` 冒頭に short-final + 0
  used_tools の skip 分岐を追加。`{pass:true, missing_tools:[], reason:"short_final_no_tools"}`
  を即返し、`state.usedTools` / `state.lastUserInput` も従来どおりリセット。
- [x] env override: `SPOTTER_STOP_SHORT_FINAL_MAX_CHARS` (default 120)。`<= 0` で無効化。
- [x] daemon log に `turn_end: pass=true, reason=short_final_no_tools, usedTools=0,
  finalChars=<n>, maxChars=<m>` を出力。
- [x] [test/daemon.test.mjs](../../test/daemon.test.mjs) に回帰テスト 5 件
  (短 final + 0 tools → skip / 短 final + tools あり → 通常 audit / 長 final + 0 tools → 通常 audit /
  `stopShortFinalMaxChars=0` で無効化 / state リセット)。
- [x] pure helper unit test 8 件 (`shouldSkipShortStop` の 5 軸 / `resolveStopShortFinalMaxChars`
  の env 解析 3 件)。
- [x] 既存 3 テスト (`turn_end per-turn prompt` / `turn_end role-collapse` / `mode=resumed log`)
  に `stopShortFinalMaxChars: 0` を追加して skip による干渉を回避。

Gate:

- [x] `node --test` 緑 (295 pass / 1 skip)。
- [x] 既存 daemon 挙動 (long final / tools あり) は無変更。

### Phase B. Stop deferred delivery ✅ 完了 (2026-05-08)

- [x] pending file path: `<projectRoot>/.spotter/pending/<sessionId>.json` (host-neutral)。
  既存 Codex 側 `<projectRoot>/.spotter/codex-pending/<sessionId>.json` も新パスへ移行
  (Codex 側 hook adapter の path だけ書き換え、schema は不変)。
- [x] [src/hooks/stop.mjs](../../src/hooks/stop.mjs):
  daemon が `pass:false` を返したら、`decision:"block"` を返さず pending file に
  指摘テキストを追記して exit 0 / no-output。`stop_hook_active:true` は daemon 早期 pass で
  受信側 (hook) は何も書かない。
- [x] [src/hooks/user-prompt.mjs](../../src/hooks/user-prompt.mjs):
  pending file を drain して `additionalContext` に追記。drain 後は file を削除。
  daemon の `pass:false` 結果と pending drain は同じ `additionalContext` に統合。短プロンプト
  早期 return 経路でも drain は走る (Codex 側と同じ)。
- [x] backend error (daemon `E_UNREACHABLE` 後の retry も失敗 / `E_INTERNAL` 等):
  hook は exit 1 + stderr (`exitCodeFor`)。pending queue 経路には混ぜない (Claude 側は daemon
  が真実源で hook 失敗 = ユーザー表面化が筋)。
- [x] pending file format: Codex 側互換の JSON 配列 `[<text>, <text>, ...]`、
  identical text は dedupe。
- [x] 共有ヘルパ作成: [src/hooks/pending-context.mjs](../../src/hooks/pending-context.mjs)
  (`pendingPath` / `appendPendingContext` / `drainPendingContexts` / `readPendingContexts`)。
- [x] Codex side 移行 ([src/cli/codex-hook-cmd.mjs](../../src/cli/codex-hook-cmd.mjs)):
  `codexPendingPath` / `appendCodexPendingContext` / `drainCodexPendingContexts` /
  `readCodexPendingContexts` を共有ヘルパに置換、`CODEX_PENDING_DIR` constant 撤去、
  未使用となった `unlink` import 削除。
- [x] [test/hooks.test.mjs](../../test/hooks.test.mjs) Phase B 回帰 13 件:
  pendingPath sanitize / append + dedupe / drain unlink / drain empty /
  Stop pass:true (write なし) / Stop pass:false (queue + 空 stdout) /
  Stop stop_hook_active 観察 / Stop transport failure (silent fallback 禁止) /
  UserPromptSubmit drain+pass:false merge / UserPromptSubmit short prompt + pending /
  UserPromptSubmit drain only / UserPromptSubmit noop。
- [x] Codex 側既存 test (`runCodexStopHook` queue path / backend error queue / short skip) は
  そのまま緑 (path 変更でも挙動は機能 E2E で固定済み)。

Gate:

- [x] `node --test` 緑 (308 pass / 1 skip)。
- [x] Claude `decision:"block"` を返す経路がコードベースから消えた (grep 確認)。
- [x] pending file が同 session 内で複数指摘を蓄積し、次 UserPromptSubmit で一括配信される。
- [x] daemon proliferation guard (`SPOTTER_PARENT_PID` / `SPOTTER_BACKEND` / marker / 10s window)
  はすべて変更なし。

### Phase D. Hook event JSONL ✅ 完了 (2026-05-08)

- [x] schema rename: `spotter.codex_hook_event.v1` → `spotter.hook_event.v1`。
  全 event に `host: "claude" | "codex"` フィールドを追加。
- [x] file path rename: `.spotter/codex-hook-events.jsonl` →
  `.spotter/hook-events.jsonl`。
- [x] 共有ヘルパ作成: [src/core/hook-event-log.mjs](../../src/core/hook-event-log.mjs)
  (`appendHookEvent` / `appendHookEventSafe` / `summarizeHookEvents` / `hookEventsPath` /
  `HOOK_EVENT_SCHEMA` / `HOOK_EVENTS_SUMMARY_SCHEMA`)。
- [x] Claude 側 hook 5 種に append (lib.mjs `recordClaudeHookEvent` 経由):
  - `SessionStart`: `{status:"spawned", durationMs}`
  - `UserPromptSubmit`: `{status:"skipped"|"success"|"error", reason?, pass?, missingTools?, code?, pendingContextCount, durationMs}`
  - `PreToolUse`: `{status:"recorded"|"error", toolName, code?, durationMs}`
  - `Stop`: `{status:"pass"|"queued"|"error", pass?, missingTools?, reason?, code?, durationMs}`
  - `SessionEnd`: `{status:"shutdown"|"error", code?, durationMs}`
- [x] Codex 側 `appendCodexHookEvent` を共有 helper の薄い wrapper にして既存 DI shape を維持
  (`recordHookEventFn` parameter)。`summarizeCodexHookEvents` は新ファイルを host=codex で
  filter する wrapper にして既存 export 名互換。`CODEX_HOOK_EVENTS_FILE` 定数撤去、
  未使用となった `appendFile` import 削除。
- [x] [src/cli/diagnostics-cmd.mjs](../../src/cli/diagnostics-cmd.mjs):
  `--project DIR` option 追加、`hookEvents` フィールドを summary に統合。
  text formatter に hook-events セクション追加 (events / parse_errors / avg / max /
  byHost / byHook / byStatus / byBackend)。既存 daemon log 集計は維持。
- [x] [test/hook-event-log.test.mjs](../../test/hook-event-log.test.mjs) 11 件:
  hookEventsPath / append (host validation, ISO timestamp, schema, append-multi) /
  appendHookEventSafe (write error swallowing) / summarizeHookEvents (empty /
  multi-host counters / parseErrors / recent cap / mkdir on demand)。

Gate:

- [x] `node --test` 緑 (319 pass / 1 skip)。
- [x] `<projectRoot>/.spotter/hook-events.jsonl` 1 ファイルに Claude / Codex 両方の event が
  時系列で書かれる (test で確認)。
- [x] `spotter diagnostics logs --json` 出力に `hookEvents` 集計セクションが追加され、
  `byHost` / `byHook` / `byStatus` / `byBackend` で読み分けできる。

### Phase Z. Release v1.4.8 ✅ 完了 (2026-05-08)

- [x] [CHANGELOG.md](../../CHANGELOG.md) v1.4.8 エントリ。
- [x] [package.json](../../package.json) `1.4.7` → `1.4.8`。
- [x] [CLAUDE.md](../../CLAUDE.md) Repository Status v1.4.8。
- [x] [02_spotter-claude-contract.md](../02_spotter-claude-contract.md):
  Stop hook 契約を deferred delivery に書き換え、JSONL log と pending host-neutral 化を追記。
- [x] [open-issues.md](../open-issues.md):
  Hook parity 進行中エントリを完了状態に更新、§12.4 (CLAUDE.md) を deferred 化で部分解消した
  状態に整理。
- [x] [README.md](../../README.md) / [README.ja.md](../../README.ja.md):
  Stop hook の振る舞いを deferred 化に追従、Mermaid フローも更新。
- [x] `node --test` 緑 (320 tests / 319 pass / 1 skip)。

Gate:

- [x] daemon proliferation guard なし変更で全 phase が緑。
- [x] `decision:"block"` のコード経路が完全消滅 (grep 確認、コメント上の歴史記述だけ残存)。
- [x] hidden fallback / silent pass の新規導入なし (backend / transport error は引き続き
  hook が exit 1 + stderr で表面化、pending queue へは混ぜない)。

## Out of Scope

- **PreToolUse の transcript 化**: Claude 側は daemon が `state.usedTools` を保持する構造を
  維持する。Codex は daemon を持たないので transcript-based、Claude は daemon-based のままで
  hook 挙動だけ揃える方針。
- **Backend の取り扱い**: Phase 5 / v1.4.7 で完了済み。
- **Pre-Response hook 相当の機能追加**: Claude Code 側公式 feature 追加待ち。Spotter 側で
  実装する経路はない。

## Risks / Notes

- pending payload に前ターン応答引用を含めない決定 → session 圧縮 / 長セッションで Bell が
  前ターン応答を要約版でしか覚えていないとき、文脈ロスが残る可能性。運用観測で目立つようなら
  上位互換 (引用付き payload) に拡張する漸進アプローチ。
- `decision:"block"` 廃止により Claude Code 側 `stop_hook_active:true` の max-1-loop 機構は
  使われなくなるが、daemon 側 early-pass コードは念のため維持 (将来 hook を block 系に戻す
  可能性は完全には排除しない)。
- `.spotter/pending/<sessionId>.json` の lifecycle 管理: 同 session 内のみ参照、SessionEnd で
  cleanup したい (daemon shutdown と一緒)。Phase B で SessionEnd 経路の cleanup も考慮。
- hook event JSONL は file size が増え続ける。rotation policy は Phase Z 以降の運用観測項目に
  残す (現状 Codex 側も rotation なしで運用中)。
