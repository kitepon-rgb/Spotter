# Open Issues

Spotter で現時点 (v1.0.0 時点, 2026-04-20) に **塞がっていない穴** と **実測未検証の懸念** を優先度付きで記録する。

**この doc は「今ここにある課題」の唯一の真実源**。バージョンごとのリリースノート ([CHANGELOG.md](../CHANGELOG.md)) は歴史記録なので、現状把握はここを参照し、新規作業に入る前に必ず目を通すこと。

## 運用ルール

- 新課題追加: 優先度 (P0/P1/P2) + 背景 + 必要な次アクションの 3 点を明示
- 解決したら: 該当項目を消し、commit / リリース番号を CHANGELOG に記録
- 優先度:
  - **P0** — 次に実装着手する前に解決したい。放置が怖い
  - **P1** — v0.1x の範囲で塞ぎたい
  - **P2** — 機会があれば

---

## P0 — 緊急対処タスク (2026-04-20 実測で確認)

実セッションの daemon ログで確認済みの実害。観測タスクと違い、既に壊れている / 見えないターンを生む恐れがあるため、優先的に対処する。

### E_HAIKU_TIMEOUT の再発率観測 (v0.13.1 で 45s に緩和済み)

**背景**: v0.13.0 までの daemon は `DEFAULT_HAIKU_TIMEOUT_MS = 30_000` で Haiku 応答を待っていたが、[daemon-80b5c0af-700f-47af-a3ac-796144823a7d.log](../../.spotter/logs/daemon-80b5c0af-700f-47af-a3ac-796144823a7d.log) line 15 で `E_HAIKU_TIMEOUT` を観測。同ログ line 20 でも `mode=first, duration_ms=20948` と timeout の 70% 域まで達していた。v0.13.1 で Haiku timeout を 45s、hook 側 IPC timeout を 50s に引き上げ済み ([daemon.mjs:53](../src/daemon/daemon.mjs#L53), [hooks/user-prompt.mjs:24](../src/hooks/user-prompt.mjs#L24), [hooks/stop.mjs:18](../src/hooks/stop.mjs#L18))。

**Haiku 4.5 の高速化ダイヤル** (2026-04-20 公式 docs 確認):
- `--effort` は Opus 4.7 / Opus 4.6 / Sonnet 4.6 のみ対応、**Haiku 4.5 は effort 非対応** ([model-config docs](https://code.claude.com/docs/en/model-config#adjust-effort-level))
- Haiku 4.5 は **extended thinking 対応だが adaptive thinking 非対応** ([models/overview](https://platform.claude.com/docs/en/docs/about-claude/models/overview) 比較表)
- `claude -p` に thinking 直接フラグ無し。API デフォルトで thinking は OFF
- つまり「Haiku をさらに速くするつまみ」は存在せず、timeout 緩和しか打ち手が無い

**次アクション**: v0.13.1 リリース後の daemon ログで `E_HAIKU_TIMEOUT` が 45s でも発生するか集計。発生率が下がらなければ (b) retry or (c) 動的延長を検討。発生率がゼロに近ければこの項目は closable。

### daemon プロセスが shutdown ログなしに死ぬ (v0.13.2 で診断 handler 投入済み、真因特定は再現待ち)

**背景**: [daemon-80b5c0af-700f-47af-a3ac-796144823a7d.log](../../.spotter/logs/daemon-80b5c0af-700f-47af-a3ac-796144823a7d.log) line 15 (E_HAIKU_TIMEOUT) の 53 秒後、同じ `session_id` で **shutdown ログなしに daemon が再起動** している (line 16-19 の `tool-db loaded` → `daemon listening` → `heartbeat armed` → `started`)。SessionEnd も heartbeat expire も走っていない。

v0.12.0 の UserPromptSubmit auto-resurrect が次のユーザー入力で `E_UNREACHABLE` を拾って spawn し直したと推定されるが、**auto-resurrect で救われている分、sudden death 自体は観測されないまま積もる**。その間の turn_end / PreToolUse が届かない = 見えない欠落ターン。

**v0.13.2 で投入済み**:
- [src/cli/daemon-cmd.mjs](../src/cli/daemon-cmd.mjs) に `process.on('uncaughtException')` / `'unhandledRejection')` handler を登録、**同期 `writeFileSync` で log に書いてから exit**。次回死亡時は stack trace + 種別が必ず残る
- [src/daemon/haiku-caller.mjs](../src/daemon/haiku-caller.mjs) の `child.stdin/stdout/stderr` に防御的 error listener 追加。実証では Node v24 + Windows でこのパスは現状落ちないと確認済み (= 80b5c0af の死因はこれではない可能性高) だが defensive coding として残置

**残: 真因特定は再現待ち**。次に同セッション内で daemon が死亡したら fatal log を見て対処する。auto-resurrect が頻発する場合は「前プロセス死亡時刻 + 現セッションでの gap」を可視化する仕組みも検討。

---

## P0 — 実運用観測タスク

v0.7.0 〜 v1.0.0 で tool-db が 5 件 (手書き抽象カタログ) → 57 件 (MCP + deferred + baseline) → **268 件** (MCP + スキル + サブエージェント) に拡大した。さらに v0.13.0 で Stop 判定軸を「要請充足チェック」から「ツール適用機会の監査」に転換、v1.0.0 でカタログ対象を Claude Code 本体側から切り離した。これらの変化を実測で評価する。

### v0.13.0 新軸 (ツール適用機会の監査) の過検出率 / pass 率

**背景**: v0.13.0 で stage=turn_end が user_input 非依存の「応答内容に対する適用機会監査」に転換した。判定面が広がったため、過検出が増える方向のリスクあり (監査で指摘済み)。想定シナリオ:
- 応答中の事実断定全部に `Read` 推奨が乱発される
- `mcp__caveat__*` や `mcp__claude_ai_Gmail__*` 系が「登録/照会」カテゴリで誤爆する
- 「迷ったら pass」の指示が効かず Haiku が過提案に倒れる (前バージョンで AskUserQuestion 過提案傾向を実測済み)

**v0.13.3 で部分対処**: カタログ**外**のハルシネーション (例: `Skill(tl)`、training 記憶由来の架空ツール名) は prompt 明示 + `filterCatalogMisses` の二重防御で遮断済み。**カタログ内の過検出** (Read 乱発 / caveat 誤爆等) はそのまま残っているためこの項目は継続。

**次アクション**: 数日の実運用 → daemon ログから turn_end の `pass=false, missing=...` 件数と内訳を集計、ユーザーが受け入れた指摘 / 却下した指摘の比率を観測。過検出が目立つなら (a) few-shot 増量、(b) カテゴリ別優先度付け、(c) カタログ description 側での「on-demand only」明示、のいずれかを検討。v0.13.3 の `dropped catalog-external names: ...` ログで filter 発動回数も併せて観測可能。

### preamble 268 件時の Haiku 判定品質

**背景**: v1.0.0 で preamble が 57 件 → 268 件に急拡大 (MCP 40 + スキル 181 + サブエージェント等 47)。preamble-once で投入コストは初回のみだが、情報過多で Haiku が散漫にならないか。false positive (的外れな指摘) と false negative (本当に呼ぶべき時に見逃し) の両方を観測したい。ECC プラグインが 181 スキル占めているので、プラグイン 1 つで preamble の 7 割が埋まる偏りも評価対象。

**次アクション**: 数日の実運用 → daemon ログから指摘件数・指摘内容を集計 → 「ユーザーが無視した指摘」と「Bell が受け入れて実行した指摘」の比率を見る。誤検出率が許容範囲を超えたら対応策の候補 — (a) description 短縮で preamble 圧縮、(b) プラグイン単位の opt-in / opt-out 機構、(c) 低頻度ツールの取捨選択の仕組み — を検討。

### preamble 肥大による first call レイテンシ悪化

**背景**: v0.13.1 実測で first=22-32s、45s timeout に対して 50-70% 域。v1.0.0 で preamble が 4 倍以上に膨らんだため first の悪化が懸念される。prompt caching が効けば 2 回目以降は問題ないが、cold の first は直撃する。45s timeout を超えたら daemon が `E_HAIKU_TIMEOUT` で落ちる。

**次アクション**: v1.0.0 リリース後の daemon ログで `mode=first, duration_ms=N` を集計。40s 付近に張り付くようなら (a) description truncate、(b) timeout 60s 緩和、(c) プラグイン単位の選別機構 のどれかを検討。timeout 突破頻発なら緊急対処。

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

### claude.ai baseline の自動追従機構なし

**背景**: [src/tool-db/claude-ai-baseline.mjs](../src/tool-db/claude-ai-baseline.mjs) (Gmail/Calendar/Drive 25 件) は手書き。OAuth proxy 経由のため credentials 非読方針の Spotter では live fetch できず、Anthropic 側で追加・変更があっても検知できない。

**補足**: v1.0.0 で deferred baseline (Claude Code 本体 17 件) は撤去されたので、本項目は claude.ai baseline にのみ残る課題。

**次アクション**: Gmail/Calendar/Drive は Anthropic 製品の一部、API 変更頻度は低い想定。半年に一度見直す運用で十分か要判断。頻度上がるなら自動監視スクリプトの導入を検討。

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

---

## 解決済み (参照用)

| 課題 | 解決版 |
|---|---|
| カタログ対象を Claude Code 本体側から切り離し (deferred-baseline 撤去 + skill/agent 収集新設) | v1.0.0 |
| project scope `.mcp.json` 未対応 | v0.10.0 |
| x-api が 401 で Haiku 視野に入らない | v0.9.0 (`.mcp.json` 読み込み) |
| HTTP/SSE MCP transport 未実装 | v0.8.0 |
| Windows `.cmd` で `spawn claude ENOENT` | v0.8.0 |
| カタログのツール名抽象 (current_time 等) 問題 | v0.7.0 (tool-db 置換で消滅) |
| 毎ターン full prompt 再送による session 肥大 | v0.6.0 (preamble-once) |
| 孤児 daemon プロセスの自動回収 | v0.6.2 (親 PID watch) → v0.12.0 (heartbeat に置換、VSCode native ext 誤爆を解消) |
| Stop hook が Bell 最終応答を拾えていないバグ | v0.4.4 |
