# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Status

**設計確定、実装未着手** (as of 2026-04-18). 現時点で存在するのは [docs/spotter-plan.md](docs/spotter-plan.md) (設計仕様書) と [.vscode/tasks.json](.vscode/tasks.json) (Throughline monitor 自動起動) のみ。ソースコード、`package.json`、テスト、ビルドスクリプトは**まだ存在しない**。

実装を始める前に、必ず [docs/spotter-plan.md](docs/spotter-plan.md) を通読すること。この CLAUDE.md はその要約ではなく、**プラン本文を読んだ後に効く操作規範**を記述する。

## Product Concept (一行)

**Bell (主役の Claude) の発話予定を、ツール一覧を完全把握した別エージェント (Spotter) が並走監査し、ツール呼び忘れを検出する。** 気づく役と実行する役の分離。

## Architecture の核 (実装判断に効く部分)

- **並走デーモン型**: SessionStart で 1 プロセス起動、SessionEnd で shutdown。Bell から呼ぶのではなく、hook 経由で **Bell の意思と独立に** user_input / tool_used / turn_end を受け取る。「Bell が自覚して呼ぶ」設計は **本プロダクトの存在意義を破壊する**ので却下されている。
- **Claude 呼び出しは毎回 stateless**: プロセスは維持するが、`claude -p --model claude-haiku-4-5-*` への呼び出しは**毎ターン独立プロンプト**。プロセス内メモリに持つのは `used_tools[]` 等の軽量記録のみ。ツールカタログの再送信コスト回避 × 判断の独立性を両立させるための核心設計。
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
