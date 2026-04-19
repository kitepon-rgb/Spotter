# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Status

**v0.4.0 実装完了** (2026-04-19)。v0.1.x は deprecate 済、v0.2.0 で §18.4 の 5 層防御 + §18.5 session-scoped Haiku を実装、v0.2.1 で §18.6 A-2 Haiku ウォームアップを追加、v0.3.0 で daemon 増殖の主原因だった `postinstall` 自動登録を撤回し project-scoped install に変更。**v0.4.0 で §18.5 session-scoped Haiku を撤回して stateless に戻した** (Spotter 本体プロジェクトで 1 時間運用中に発生した Haiku role collapse 事故が契機)。詳細は [CHANGELOG.md](CHANGELOG.md)。

**v0.4 系の核心設計**: daemon は依然として session-scoped (hook イベント集約・used_tools 記録) だが、**Haiku 呼び出しは毎ターン stateless** (`--session-id <fresh UUID>` のみ、`--resume` 不使用)。これは下記 Architecture 節の「Claude 呼び出しは毎回 stateless」原則への回帰であり、session-scoped が引き起こした **Haiku が Bell 会話履歴を聞き続けて persona drift する問題**を構造的に排除する。5 層防御 (`SPOTTER_PARENT_PID` env / `agent_id` gate / `source=startup` 限定 / PID preexist check / 10 秒ウィンドウ) は維持。プラン §18.3 の都度起動型 (daemon レベルでの都度起動) は引き続き棄却、再議論しない。

### v0.4.0 時点の既知課題
- **cold-start latency の再発リスク**: v0.2.1 で warmup を導入した A-2 問題 (初回 Haiku spawn 44 秒超) が stateless 化で毎ターン発生する可能性。timeout 28s → 40-60s への延長が必要かは実運用観測で判断
- **カタログ毎ターン再送のコスト**: Anthropic prompt caching に依存。効かない場合は Claude Max plan の quota を圧迫しうる
- **カタログのツール名抽象**: `current_time` 等のエントリが実環境の `Bash:date` 等とマッピングされていない (持ち越し)。lint 拡張検討中

### Spotter 本体プロジェクトでの install に関する警告

**Spotter リポジトリで Spotter を install すると、Bell 側の会話が Spotter 自体の議論になり、Haiku が自己言及で混乱する**。v0.4 では stateless 化で会話履歴蓄積は解消されたが、1 ターンのプロンプトに「Spotter のロール」「カタログ改定」等が含まれると persona drift のきっかけにはなる。開発時は他プロジェクトで動作確認するか、install せず手動で `spotter catalog lint` を回すこと。

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
