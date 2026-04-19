# Open Issues

Spotter で現時点 (v0.11.0 時点, 2026-04-19) に **塞がっていない穴** と **実測未検証の懸念** を優先度付きで記録する。

**この doc は「今ここにある課題」の唯一の真実源**。バージョンごとのリリースノート ([CHANGELOG.md](../CHANGELOG.md)) は歴史記録なので、現状把握はここを参照し、新規作業に入る前に必ず目を通すこと。

## 運用ルール

- 新課題追加: 優先度 (P0/P1/P2) + 背景 + 必要な次アクションの 3 点を明示
- 解決したら: 該当項目を消し、commit / リリース番号を CHANGELOG に記録
- 優先度:
  - **P0** — 次に実装着手する前に解決したい。放置が怖い
  - **P1** — v0.1x の範囲で塞ぎたい
  - **P2** — 機会があれば

---

## P0 — 実運用観測タスク

v0.7.0 〜 v0.10.0 で tool-db が 5 件 (手書き抽象カタログ) → **57 件** (実 MCP + deferred + baseline) に膨らんだ。この変化を実測で評価する。

### preamble 57 件時の Haiku 判定品質

**背景**: v0.6.0 で preamble-once 化したため、57 件全部が初回 preamble に載る。5 件時代と比べて情報過多で Haiku が散漫にならないか。false positive (的外れな指摘) と false negative (本当に呼ぶべき時に見逃し) の両方を観測したい。

**次アクション**: 数日の実運用 → daemon ログから指摘件数・指摘内容を集計 → 「ユーザーが無視した指摘」と「Bell が受け入れて実行した指摘」の比率を見る。誤検出率が許容範囲を超えたら description 強化 (when_to_use の明文化) を検討。

### preamble 肥大による first call レイテンシ悪化

**背景**: v0.6.1 の実測で first=22.4s だった。preamble が 5 件 → 57 件に膨らんで first がさらに伸びていないか未検証。prompt caching が効いていれば 2 回目以降は問題ないはずだが、cold の first は直撃する。

**次アクション**: daemon ログの `mode=first, duration_ms=N` を v0.10.0 後の新規セッションで集計、v0.6.1 時点の数字と比較。閾値 (例: 30s 超) を超えたら preamble 圧縮 (description 短縮 / 低頻度ツール除外) を検討。

### claude.ai MCP (Gmail/Calendar/Drive) の過検出率

**背景**: v0.8.0 で Gmail 10 + Calendar 8 + Drive 7 = 25 件を hardcoded baseline として Haiku 視野に追加した。ただし Bell のデフォルト行動としてこれらは on-demand (「メール下書きして」等の明示指示がないと呼ばない) なので、Haiku が過剰に「Gmail 呼び忘れ」を指摘する懸念あり (2026-04-19 のセッションで議論済み)。

**次アクション**: 実運用で「Gmail/Calendar/Drive 関連の指摘が出た回数」と「そのうち妥当だったもの」を観測。誤検出が目立つなら 3 択 — (a) baseline 削除 (b) description に判定条件を強く書く (c) 優先度を下げる扱いの仕組みを新設 — から選択。

### Haiku JSON schema 遵守率

**背景**: プラン §9 の v0.2 予定だった観測タスク。v0.5.0 で role-collapse-recovery を事後回復方式にしたが、発生頻度は未集計。頻発するなら予防機構 (N ターン毎の強制 renew 等) の追加を再検討する。

**次アクション**: daemon ログの `role collapse detected, session reset` 件数と、JSON パース成功率を集計する仕組みを足す。

---

## P1 — 設計上の穴

### local scope (`settings.local.json` の mcpServers) 未対応

**背景**: v0.10.0 で user scope + project scope の 2 段 merge まで実装したが、`<projectRoot>/.claude/settings.local.json` の `mcpServers` フィールド (マシンローカル・git 非管理) は未読み込み。Claude Code 本体はこの層も見ている。

**次アクション**: `readMcpServers` に local scope 読み込みを追加 (local > project > user の precedence)。実装自体は既存パターンの拡張なので小さい。

### `claude mcp list` text パースの脆弱性

**背景**: [src/tool-db/investigate-mcp.mjs](../src/tool-db/investigate-mcp.mjs) の `parseMcpListOutput` は text フォーマットに依存。Claude Code CLI がフォーマット変更したら壊れる。現時点で `--json` 出力は未提供。

**次アクション**: `claude mcp list --json` の有無を定期的に再確認し、提供されたら即切り替え。それまでは `.mcp.json` 直読み (v0.9.0 で導入) でカバー、CLI パースは fallback 扱いに格下げ済み。

### baseline の自動追従機構なし

**背景**: [src/tool-db/deferred-baseline.mjs](../src/tool-db/deferred-baseline.mjs) (Claude Code 組込み遅延ツール 17 件) と [src/tool-db/claude-ai-baseline.mjs](../src/tool-db/claude-ai-baseline.mjs) (Gmail/Calendar/Drive 25 件) は手書き。Anthropic 側で追加・変更があっても検知できず、手で追う必要あり。

**次アクション**:
- deferred: Claude Code のリリースノートを watch する仕組み (スラッシュコマンド / CI ジョブ) を検討
- claude.ai: Gmail/Calendar/Drive は Anthropic 製品の一部、API 変更頻度は低い想定。半年に一度見直す運用で十分か要判断

### `--resume` の実効 spawn 削減量未検証

**背景**: v0.5.0 で session-scoped Haiku を導入して resumed 経路を 30s → 30s (timeout) に短縮した想定。ただし `claude -p --resume` のプロセス起動・認証自体は毎回発生する可能性があり、ネットの仮定ほど削減できていないかも。

**次アクション**: daemon ログから `mode=first/resumed, duration_ms` を集計 (v0.5.2 で可視化済み)。first と resumed の差が小さいなら session-scoped の意義を再評価。

---

## P2 — 元プランの未消化分

プラン [docs/spotter-plan.md](spotter-plan.md) §9 のスコープ順に沿った未消化項目。優先度低いが、実装決定時に参照。

### `/ask-spotter` スラッシュコマンド (v0.3 予定)

ユーザーが明示的に Spotter に問い合わせできるスラッシュコマンド。現状は Stop hook の `decision: "block"` のみが介入経路で、ユーザー発案の問い合わせは不可。

### async hook 化 (v0.4+)

現状 Stop hook が Haiku 呼び出しを同期的に待つ (30s timeout)。async hook 対応が Claude Code 側で来たら、体感レイテンシを隠蔽できる。

### CI 回帰テスト整備 (v0.4+)

`.github/workflows/ci.yml` は Node 22.5 / lint / test の想定だが、実装時の lint フロー・PR ゲートは未整備。`node --test` + `eslint` の最小 CI を立ち上げる。

### 孤児 daemon cleanup の追加対策 (v0.2 予定 → v0.6.2 で部分対応)

v0.6.2 で親 PID watch を実装したが、watch 頻度 5 秒は攻撃的に短くするかユーザー設定にするか要判断。

---

## 解決済み (参照用)

| 課題 | 解決版 |
|---|---|
| project scope `.mcp.json` 未対応 | v0.10.0 |
| x-api が 401 で Haiku 視野に入らない | v0.9.0 (`.mcp.json` 読み込み) |
| HTTP/SSE MCP transport 未実装 | v0.8.0 |
| Windows `.cmd` で `spawn claude ENOENT` | v0.8.0 |
| カタログのツール名抽象 (current_time 等) 問題 | v0.7.0 (tool-db 置換で消滅) |
| 毎ターン full prompt 再送による session 肥大 | v0.6.0 (preamble-once) |
| 孤児 daemon プロセスの自動回収 | v0.6.2 (親 PID watch) |
| Stop hook が Bell 最終応答を拾えていないバグ | v0.4.4 |
