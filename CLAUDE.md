# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Status

**v0.5.2** (2026-04-19): Haiku 呼び出しレイテンシ可視化。daemon ログに `mode=first|resumed, duration_ms=<N>` を追加し、`--resume` 経路の cold-start 削減効果 / role collapse 回復時間 / timeout 余裕を観測可能にした。機能変更なし、`isFirstCall` getter 追加 + ログフォーマット拡張のみ。これで v0.5.0/v0.5.1 の既知課題 (resume 実効削減量未検証、role collapse 実発生頻度未観測) が数値で判断できる状態になる。詳細は [CHANGELOG.md](CHANGELOG.md)。

**v0.5.1** (2026-04-19): v0.5.0 の `buildSpawnArgs` が `--session-id` と `--resume` を併用していたバグの hot-fix。claude CLI は `--fork-session` なしの両立を拒否するため、resume 時は `--resume <uuid>` 単独に修正。これにより v0.5.0 の session-scoped 機構が実際に生きた状態で動き出した。

**v0.5.0 実装完了** (2026-04-19)。**v0.4.0 で捨てた session-scoped Haiku を事後回復機構付きで復活**。v0.4.x stateless の毎ターン cold-start 問題 (Bell 応答後に 30 秒前後動きが止まる) を解消するため、`claude -p --session-id <uuid> --resume <uuid>` で同一セッション再接続。v0.4.0 で session-scoped を捨てた理由の **Haiku role collapse** (persona drift で JSON 契約破棄) は、構造的予防ではなく **JSON パース失敗検知 → session renew + silent pass** の事後回復で処理する方針へ変更。これは §0 の「想定済み異常 = 記録 + 正常リターン」の分類変更であり、silent fallback 新規導入ではない。詳細は [CHANGELOG.md](CHANGELOG.md)。

**v0.4.4** (2026-04-19): Stop hook が **Bell の最終応答を Haiku に渡していなかったバグ**を修正。`input.final_response` (存在しないフィールド) を廃止し、`input.transcript_path` から JSONL 末尾の assistant text だけを抽出する `getLastAssistantText()` を新設 ([src/hooks/transcript-reader.mjs](src/hooks/transcript-reader.mjs))。thinking / tool_use ブロックは除外、ユーザーが見た最終応答テキストのみ Haiku に渡る。Throughline から移植 (MIT, 同作者)。

**v0.5.0 の核心設計**: daemon は session-scoped (hook イベント集約・used_tools 記録)。**Haiku 呼び出しも session-scoped** (`--session-id` を daemon 生存期間中保持、2 回目以降は `--resume` で再接続)。5 層防御 (`SPOTTER_PARENT_PID` env / `agent_id` gate / `source=startup` 限定 / PID preexist check / 10 秒ウィンドウ) は維持。プラン §18.3 の都度起動型 (daemon レベルでの都度起動) は引き続き棄却、再議論しない。

### v0.5.0 で投入した対策

- **Session-scoped Haiku** (`createHaikuCaller` @ [haiku-caller.mjs](src/daemon/haiku-caller.mjs)): closure で `currentSessionId` と `isFirstCall` を保持。初回は `--session-id` のみ、以降は `--session-id + --resume`。2 回目以降の cold-start を消す。
- **Role-collapse recovery** (`runHaikuJudgment` @ [daemon.mjs](src/daemon/daemon.mjs)): `parseHaikuResponse` が `E_HAIKU_SCHEMA` を throw したら `callHaiku.reset()` で session-id を renew し、当該ターンは `{pass: true, reason: 'role_collapse_reset'}` で silent pass。次ターンから fresh session で監査再開。
- **Timeout 短縮** (60s → 30s): 2 回目以降は cold-start がないので延長の必要なし。初回だけは 30s 以内に終わる想定。
- **Warmup 削除**: stateless 対策だったので不要。

### 残る既知課題

- **`--resume` の実効 spawn 削減量未検証**: プロセス起動・認証自体は毎回発生する可能性。効果が薄ければ追加検討。
- **カタログ毎ターン再送のコスト**: prompt caching に依存。prefix 固定 (system rules + few-shot + catalog) なので効くはずだが実測未検証。
- **カタログのツール名抽象**: `current_time` 等のエントリが実環境の `Bash:date` 等とマッピングされていない (持ち越し)。lint 拡張検討中。
- **role collapse の実発生頻度**: 事後回復でカバーする方針なので、daemon ログの `role collapse detected, session reset` の頻度を観測し、多発するなら予防機構 (N ターン毎の強制 renew 等) の追加を検討。

### Spotter 本体プロジェクトでの install に関する警告

**Spotter リポジトリで Spotter を install すると、Bell 側の会話が Spotter 自体の議論になり、Haiku が自己言及で混乱する**。v0.5.0 で session-scoped に戻したため、過去より persona drift リスクが高い環境。開発時は他プロジェクトで動作確認するか、install せず手動で `spotter catalog lint` を回すこと。

## Product Concept (一行)

**Bell (主役の Claude) の発話予定を、ツール一覧を完全把握した別エージェント (Spotter) が並走監査し、ツール呼び忘れを検出する。** 気づく役と実行する役の分離。

## Architecture の核 (実装判断に効く部分)

- **並走デーモン型**: SessionStart で 1 プロセス起動、SessionEnd で shutdown。Bell から呼ぶのではなく、hook 経由で **Bell の意思と独立に** user_input / tool_used / turn_end を受け取る。「Bell が自覚して呼ぶ」設計は **本プロダクトの存在意義を破壊する**ので却下されている。
- **Claude 呼び出しは session-scoped + 事後回復** (v0.5.0 で更新): `claude -p --session-id <uuid>` で初回セッション確立、以降 `--resume` で再接続して cold-start を消す。プロンプト内容は毎回 full (system + catalog + delta) を送るので、Anthropic 側 session replay の取りこぼしに依存しない。role collapse は `parseHaikuResponse` が `E_HAIKU_SCHEMA` を返した瞬間に `callHaiku.reset()` で session-id を rotate し、当該ターンは silent pass。**これは §0 の silent fallback 禁止違反ではなく、「想定済み異常 = 記録 + 正常リターン」の適用**。
- **隔離実行**: Spotter の workdir (`~/.spotter/workdir/`) には **CLAUDE.md を置かない**。プロジェクト文脈に引きずられないことが品質保証の要件。
- **ツールカタログは YAML**: `purpose` / `when_to_use` / `keywords` (一次判定用) と `usage` / `examples` (確定後) を分離した 2 段階コンテキスト。`test_cases` フィールドで回帰検出する。
- **Stop hook の介入**: `decision: "block"` + `reason` で Bell に継続応答を生成させる。`stop_hook_active: true` を見たら即 pass することで max 1 回ループを担保 (Claude Code 側の機構で自動)。

## §0 実装規範 (最重要)

コードを書く前にこの 3 点を内面化すること。プラン §14 の詳細版だが、実装時に効くのはここ:

1. **フォールバック禁止**. daemon 起動失敗 / socket 疎通失敗 / Haiku 呼び出し失敗 / YAML パース失敗 / カタログ欠損は **全て throw**. `try/catch` で潰すコードはレビューで棄却される。例外は SessionEnd の cleanup 失敗 (warn ログのみ、セッション終了は止めない) と PostToolUse 等の非ブロッキング系のみ。
2. **「daemon が死んでたら pass」は最悪の失敗モード**. ユーザーは Spotter が守ってる気になって実は素の Bell、という状況は silent fallback で起こる。hook が daemon 疎通できなければ exit code 1 + stderr にメッセージ。
3. **動かすためだけの暫定コード禁止**. スタブ・TODO のみの関数・型が曖昧なコードを本流に混ぜない。MVP スコープを狭めるのは OK (v0.2 に送る)、**範囲内は常に完成形**。暫定コードを書く必要があるなら代替設計と一緒に提示してから書く。

想定済み異常 (例: カタログに該当ツールなし) は記録 + 正常リターン。**想定外**は throw + stderr + exit code 2。この分類を曖昧にしない。

## Planned Stack (実装時の拘束)

プラン §15 より、実装が始まったらこれらを満たすこと:

- **Node.js 22.5+** (組み込み fetch, test runner 使用)
- **Claude Code 2.0+** (Stop hook block 挙動, async hook 利用)
- **Claude Max plan** (`claude -p` で Haiku 起動)
- **ゼロ依存志向**. 依存追加時は理由をコミットログに記録。
- パッケージング: `npm install -g spotter`, CLI 名 `spotter`, MIT ライセンス。

## Planned Commands (実装後)

プラン §15.3 で定義済み。実装時はこの構成を逸脱しない:

```
spotter install / uninstall
spotter catalog edit / lint / refresh
spotter daemon start / stop       # 内部用 (hook から呼ばれる)
spotter status / doctor
```

テストランナーは Node 組み込み (`node --test`)、CI は `.github/workflows/ci.yml` で Node 22.5 / lint / test を走らせる想定。

## MVP スコープ境界

v0.1 に含める / 含めないの判断で迷ったらプラン §9 を参照。**越境禁止**:

- v0.1: SessionStart/UserPromptSubmit/**PreToolUse**/Stop/SessionEnd hook + 手動 YAML 1 ファイル + 同期実装 + 差し戻し 1 回 + `spotter catalog lint` (test_cases を Haiku 実呼びで検証)
- v0.2: 孤児プロセス cleanup + Haiku JSON 遵守率計測 + リトライ設計 (必要時)
- v0.3: MCP サーバー列挙によるカタログ自動生成 + カタログ分割 + `/ask-spotter` スラッシュコマンド
- v0.4+: async hook, ドメイン別カタログ, CI 回帰テスト整備

「ついでに v0.2 の機能も入れておく」は棄却する。(2026-04-19 監査反映: PreToolUse は used_tools 空による誤検出回避のため v0.1 に前倒し)

## 決着済みの設計判断 (2026-04-19)

プラン §12.2 / §12.3 の未解決論点 + 実装方針の確定事項。これらは**再議論しない**:

- **指摘の届け方**: 透明化採用。UserPromptSubmit の `additionalContext` も Stop hook の `reason` も、Bell が「Spotter からの指摘」を明示するよう書式を組む。プラン §12.2 / §12.3 参照
- **Haiku への入出力**: 構造化 JSON で固定 (`{pass: bool, missing_tools: [{name, reason}]}`)。自由記述不採用、**リトライなし**。JSON スキーマ不遵守は §14.1 に従って throw。プラン §5.5 参照
- **OS 間 socket 抽象**: Node.js `net` モジュールで Windows (Named Pipe `\\.\pipe\spotter-<id>`) と macOS/Linux (Unix socket `~/.spotter/runtime/session-<id>.sock`) を同一 API で扱い、`process.platform === 'win32'` でパスのみ分岐。プラン §5.6 参照
- **hook ⇄ daemon メッセージ契約**: 改行区切り JSON 1 行。envelope `{id, event, session_id, payload}` / response `{id, ok, result|error}`。タイムアウト表と error code (`E_CATALOG_MISSING | E_HAIKU_SCHEMA | E_HAIKU_TIMEOUT | E_INTERNAL`) を固定。プラン §5.7 参照
- **SessionStart の daemon 起動**: readiness ping が通るまで最大 3 秒ブロック、通らなければ throw。UserPromptSubmit 側で retry しない。プラン §9.1 参照
- **PreToolUse を v0.1 に前倒し**: 当初 v0.2 予定だったが、used_tools が空のまま Stop 判定すると既使用ツール再指摘の誤検出が頻発するため v0.1 に移動 (2026-04-19 監査反映)

## 未解決論点 (設計上の開かれた選択)

プラン §12 に未解決として残っているもの。実装中にこれらに触る判断をするときは、**独断で決めずユーザーに確認する**:

- カタログの初期構築: 手動 vs MCP 自動列挙 (v0.1 は手動確定、v0.3 で再検討) — §12.1
- 最初の応答を取り消せない仕様への中長期対応 (Pre-Response hook の feature request 等) — §12.4

## Related Project

**Throughline** ([github.com/kitepon-rgb/Throughline](https://github.com/kitepon-rgb/Throughline)) — 同じ作者の既存プロダクト。思想は逆 (引き算=退避 vs 足し算=気づかせ) だが、**「主体に頼らない仕組み」** という哲学と §0 実装規範を共有する。このリポジトリの `.vscode/tasks.json` が起動している `token-monitor` は Throughline のもの。
