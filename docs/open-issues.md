# Open Issues

Spotter で現時点 (v1.3.0 時点, 2026-05-04) に **塞がっていない穴** と **実測未検証の懸念** を優先度付きで記録する。

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

**次アクション**: v0.13.1 リリース後の daemon ログで `E_HAIKU_TIMEOUT` が 45s でも発生するか集計。`spotter diagnostics logs --json` で `anomalies.haikuInvocationFailures.byCode.E_HAIKU_TIMEOUT` と duration を確認する。発生率が下がらなければ (b) retry or (c) 動的延長を検討。発生率がゼロに近ければこの項目は closable。

### daemon プロセスが shutdown ログなしに死ぬ (v1.3.0 で根因が大半解消した可能性、再観測中)

**背景**: [daemon-80b5c0af-700f-47af-a3ac-796144823a7d.log](../../.spotter/logs/daemon-80b5c0af-700f-47af-a3ac-796144823a7d.log) line 15 (E_HAIKU_TIMEOUT) の 53 秒後、同じ `session_id` で **shutdown ログなしに daemon が再起動** している (line 16-19 の `tool-db loaded` → `daemon listening` → `heartbeat armed` → `started`)。SessionEnd も heartbeat expire も走っていない。

v0.12.0 の UserPromptSubmit auto-resurrect が次のユーザー入力で `E_UNREACHABLE` を拾って spawn し直したと推定されるが、**auto-resurrect で救われている分、sudden death 自体は観測されないまま積もる**。その間の turn_end / PreToolUse が届かない = 見えない欠落ターン。

**v1.3.0 で根因の大半が解消した可能性 (2026-05-04 観測)**: WSL2 で CPU 100% 飽和 + チャット入力無反応の症状調査で、Spotter daemon 3 並走 × 各 Haiku 呼出が `--strict-mcp-config` なしに spawn されて user/project の MCP server 60+ 個を毎回 spawn → 終了 → 再 spawn のサイクルで OS リソースを食いつぶしていた。同期間の `daemon-702a677d-...log` で同 sessionId に `tool-db loaded` が 15 分間に 8 回記録 = sudden death + auto-resurrect が高頻度発生。WSL2 cgroup OOM kill が daemon 自体を巻き込んでいた可能性が高い。v1.3.0 の `--strict-mcp-config --mcp-config <empty>` 強制で Haiku spawn が MCP server を 1 つも load しなくなり、CPU 食いつぶしが構造的に消えた。これにより daemon sudden death の主因が消えたはず。

**v0.13.2 で投入済みの診断 handler は引き続き残置**:
- [src/cli/daemon-cmd.mjs](../src/cli/daemon-cmd.mjs) に `process.on('uncaughtException')` / `'unhandledRejection')` handler を登録、**同期 `writeFileSync` で log に書いてから exit**。残った sudden death は stack trace + 種別が必ず残る
- [src/daemon/haiku-caller.mjs](../src/daemon/haiku-caller.mjs) の `child.stdin/stdout/stderr` に防御的 error listener 追加

**残: v1.3.0 後の再観測**。実運用で daemon 突然死頻度が下がるかを daemon ログで集計。`spotter diagnostics logs --json` の `daemon.restartSignals` / `daemon.toolDbLoaded` / `daemon.stops` を見て、1 セッションあたり何回再起動が起きるかを観測する。下がっていなければ別の真因 (Node 内部例外 / WSL 仮想化レイヤ等) を疑う。

---

## P0 — 実運用観測タスク

v0.7.0 〜 v1.0.0 で tool-db が 5 件 (手書き抽象カタログ) → 57 件 (MCP + deferred + baseline) → **268 件** (MCP + スキル + サブエージェント) に拡大した。さらに v0.13.0 で Stop 判定軸を「要請充足チェック」から「ツール適用機会の監査」に転換、v1.0.0 でカタログ対象を Claude Code 本体側から切り離した。これらの変化を実測で評価する。

### v0.13.0 新軸 (ツール適用機会の監査) の過検出率 / pass 率

**背景**: v0.13.0 で stage=turn_end が user_input 非依存の「応答内容に対する適用機会監査」に転換した。判定面が広がったため、過検出が増える方向のリスクあり (監査で指摘済み)。想定シナリオ:
- 応答中の事実断定全部に `Read` 推奨が乱発されるような catalog-external hallucination
- `mcp__caveat__*` や `mcp__claude_ai_Gmail__*` 系が「登録/照会」カテゴリで誤爆する catalog-internal over-detection
- 「迷ったら pass」の指示が効かず Haiku が過提案に倒れる (前バージョンで AskUserQuestion 過提案傾向を実測済み)

**v0.13.3 / v1.0.0 で部分対処**: カタログ**外**のハルシネーション (例: `Skill(tl)`、training 記憶由来の架空ツール名、現行カタログ対象外の `Read`) は prompt 明示 + `filterCatalogMisses` の二重防御で遮断済み。v1.0.0 以降、Claude Code 本体側ツールは監査対象外。**カタログ内の過検出** (caveat / claude.ai baseline 等の誤爆) はそのまま残っているためこの項目は継続。

**2026-05-06 実セッション smoke**: Claude Code 新セッションで「過去のナレッジが知りたい」という入力に対し、Spotter は `mcp__caveat__caveat_search` を推奨。Claude は追加 context を受け入れて caveat search を 2 回実行し、続けて memory search も実行した。daemon log では `user_input: pass=false, missing=mcp__caveat__caveat_search` → `tool_used: mcp__caveat__caveat_search` → `turn_end: pass=true`。少なくともこのケースでは過検出ではなく、期待どおりの介入として機能。

**次アクション**: 数日の実運用 → `spotter diagnostics logs --json` で turn_end の `pass=false` 件数、missing 内訳、catalog-external drop を集計し、ユーザーが受け入れた指摘 / 却下した指摘の比率を観測。過検出が目立つなら (a) few-shot 増量、(b) カテゴリ別優先度付け、(c) カタログ description 側での「on-demand only」明示、のいずれかを検討。

### preamble 268 件時の Haiku 判定品質

**背景**: v1.0.0 で preamble が 57 件 → 268 件に急拡大 (MCP 40 + スキル 181 + サブエージェント等 47)。preamble-once で投入コストは初回のみだが、情報過多で Haiku が散漫にならないか。false positive (的外れな指摘) と false negative (本当に呼ぶべき時に見逃し) の両方を観測したい。ECC プラグインが 181 スキル占めているので、プラグイン 1 つで preamble の 7 割が埋まる偏りも評価対象。

**次アクション**: 数日の実運用 → daemon ログから指摘件数・指摘内容を集計 → 「ユーザーが無視した指摘」と「Bell が受け入れて実行した指摘」の比率を見る。誤検出率が許容範囲を超えたら対応策の候補 — (a) description 短縮で preamble 圧縮、(b) プラグイン単位の opt-in / opt-out 機構、(c) 低頻度ツールの取捨選択の仕組み — を検討。

### preamble 肥大による first call レイテンシ悪化

**背景**: v0.13.1 実測で first=22-32s、45s timeout に対して 50-70% 域。v1.0.0 で preamble が 4 倍以上に膨らんだため first の悪化が懸念される。prompt caching が効けば 2 回目以降は問題ないが、cold の first は直撃する。45s timeout を超えたら daemon が `E_HAIKU_TIMEOUT` で落ちる。

**2026-05-06 実セッション smoke**: Spotter repo の project-local tool-db 366 件で Claude Code 実セッションを起動。`user_input` first call は `duration_ms=11629`、その後の `turn_end` resumed call は `duration_ms=27746`。45s timeout には収まったが、first が 10 秒台に乗ることは確認済み。体感上は許容範囲だが継続観測対象。

**関連計画**: Claude 環境での Spotter 遅延は UX に影響しているため、backend / latency tuning は
[`SPOTTER_PRIMARY_BACKEND_TODO.md`](SPOTTER_PRIMARY_BACKEND_TODO.md) で扱う。順序は
Codex native に Spotter を適用して先に最適化し、実測できた改善だけを Claude host に移植する。

**次アクション**: v1.3.0 以降の daemon ログを `spotter diagnostics logs --json` で集計し、`stages.user_input.modes.first` / `stages.turn_end.modes.first` の duration を見る。40s 付近に張り付くようなら (a) description truncate、(b) daemon timeout 60s 緩和、(c) プラグイン単位の選別機構 のどれかを検討。timeout 突破頻発なら緊急対処。

### claude.ai MCP (Gmail/Calendar/Drive) の過検出率 — 連携環境でのみ残存

**背景**: v0.8.0 で Gmail 10 + Calendar 8 + Drive 7 = 25 件を hardcoded baseline として Haiku 視野に追加した。v1.1.4 で `filterClaudeAiBaseline` を入れ、`claude mcp list` に該当サーバーが実在する環境のみ注入する構造に変更 (Bell 側実環境で 25 件消失を実測確認済み、隔離 `CLAUDE_CONFIG_DIR` / 未連携 / 部分連携環境での幻ツール問題は解消)。**連携している環境では 25 件の注入は継続**するため、Bell のデフォルト行動として on-demand (「メール下書きして」等の明示指示がないと呼ばない) なこれらを Haiku が過剰に指摘する懸念は連携環境下で残る。

**次アクション**: claude.ai 連携ありの実運用環境で「Gmail/Calendar/Drive 関連の指摘が出た回数」と「そのうち妥当だったもの」を観測。誤検出が目立つなら 2 択 — (a) description に判定条件を強く書く (b) 優先度を下げる扱いの仕組みを新設 — から選択。(a) の baseline 削除は v1.1.4 の filter で部分的に既出。

### Haiku JSON schema 遵守率

**背景**: プラン §9 の v0.2 予定だった観測タスク。v0.5.0 で role-collapse-recovery を事後回復方式にしたが、発生頻度は未集計。頻発するなら予防機構 (N ターン毎の強制 renew 等) の追加を再検討する。

**次アクション**: `spotter diagnostics logs --json` で `roleCollapseReset` と handler error を集計し、頻発するなら予防機構 (N ターン毎の強制 renew 等) の追加を再検討する。

---

## P1 — 設計上の穴

### `claude mcp list` text パースの脆弱性

**背景**: [src/tool-db/investigate-mcp.mjs](../src/tool-db/investigate-mcp.mjs) の `parseMcpListOutput` は text フォーマットに依存。Claude Code CLI がフォーマット変更したら壊れる。2026-05-06 時点のローカル CLI では `claude mcp list --json` は `unknown option '--json'`。

**次アクション**: `claude mcp list --json` の有無を定期的に再確認し、提供されたら即切り替え。それまでは `.mcp.json` 直読み (v0.9.0 で導入) でカバー、CLI パースは fallback 扱いに格下げ済み。

### claude.ai baseline の自動追従機構なし

**背景**: [src/tool-db/claude-ai-baseline.mjs](../src/tool-db/claude-ai-baseline.mjs) (Gmail/Calendar/Drive 25 件) は手書き。OAuth proxy 経由のため credentials 非読方針の Spotter では live fetch できず、Anthropic 側で追加・変更があっても検知できない。

**補足**: v1.0.0 で deferred baseline (Claude Code 本体 17 件) は撤去されたので、本項目は claude.ai baseline にのみ残る課題。

**次アクション**: Gmail/Calendar/Drive は Anthropic 製品の一部、API 変更頻度は低い想定。半年に一度見直す運用で十分か要判断。頻度上がるなら自動監視スクリプトの導入を検討。

### Windows Named Pipe の DACL 制限なし (2026-04-20 監査で発見)

**背景**: Windows Named Pipe は DACL 未設定で default Everyone。daemon 側の認証は session_id 一致チェック ([src/daemon/daemon.mjs](../src/daemon/daemon.mjs)) のみで、session_id は pipe/socket 名から読めるため認証にならず。同一ユーザー内の別プロセスから `tool_used` 偽造で used_tools 汚染 → Haiku 指摘抑制、または偽 `user_input` で Haiku spend をドライブする攻撃経路が理論上成立する。OWASP A01 Broken Access Control。

**補足**: Spotter は個人用ローカル CLI で、同一ユーザー内の別プロセスが敵対的である想定は通常しない = blast radius は「同端末で別のマルウェアが動いている場合のみ」。それでも cheap fix があるので塞ぎたい。

**Unix 側は解決済み**: `~/.spotter/runtime` を `0700`、daemon listen 後の Unix socket を `0600` に固定した。

**次アクション**: P2。Windows 側 Named Pipe DACL 制限は `net.createServer` に pipeMode オプションがないため、プロセス起動時の SECURITY_DESCRIPTOR 設定か、別モジュール経由が必要。

### frontmatter パーサの quote escape 対応が最小 (2026-04-20 監査で発見)

**背景**: [src/tool-db/frontmatter.mjs](../src/tool-db/frontmatter.mjs) は Claude Code skill / agent の `name` / `description` 抽出に必要な最小 YAML frontmatter parser。`description: >` / `description: |` の block scalar は zero-deps のまま対応済みだが、double-quoted YAML escape (`\n`, `\"` 等) の完全展開までは行っていない。

**現状の影響**: quote escape 未展開は description の表記揺れに留まり、block scalar 非対応時のように skill / agent が `length === 0` で丸ごと silent skip される実害は確認していない。

**次アクション**: P2 (機会があれば)。実際の SKILL.md / agent frontmatter に escape-heavy な description が出た時点で、依存追加なしの `unquoteYamlString` を追加する。YAML ライブラリ追加はゼロ依存志向 (CLAUDE.md) に反するので最後の手段。

### `--resume` の実効 spawn 削減量未検証

**背景**: v0.5.0 で session-scoped Haiku を導入して resumed 経路を 30s → 30s (timeout) に短縮した想定。ただし `claude -p --resume` のプロセス起動・認証自体は毎回発生する可能性があり、ネットの仮定ほど削減できていないかも。

**次アクション**: `spotter diagnostics logs --json` で `mode=first/resumed, duration_ms` を集計。first と resumed の差が小さいなら session-scoped の意義を再評価。

---

## P2 — 元プランの未消化分

プラン [docs/spotter-plan.md](spotter-plan.md) §9 のスコープ順に沿った未消化項目。優先度低いが、実装決定時に参照。

### `/ask-spotter` スラッシュコマンド (v0.3 予定)

ユーザーが明示的に Spotter に問い合わせできるスラッシュコマンド。現状は Stop hook の `decision: "block"` のみが介入経路で、ユーザー発案の問い合わせは不可。

### async hook 化 (v0.4+)

現状 Stop hook は daemon の Haiku 呼び出しを同期的に待つ (daemon 45s、hook IPC 50s、install が書く Claude Code 側 timeout は 60s)。async hook 対応が Claude Code 側で来たら、体感レイテンシを隠蔽できる。

### CI 回帰テスト整備 (v0.4+)

現行 `.github/workflows/ci.yml` は Node 22.5 / 22.x と Linux / Windows / macOS の `node --test` matrix。lint フロー・PR ゲートは未整備。導入するなら `node --test` に加えて `eslint` 相当の最小 lint を CI に載せる。

### tool-db.json の並列書き込み race condition (2026-04-20 v1.1.1 review で発見)

**背景**: v1.1.0 で `spotter install` と `SessionStart` hook 両方から `refresh({projectRoot})` が走る構造になった。同一プロジェクトで `spotter install` 実行中に別 Claude Code セッションが SessionStart で bg refresh を起動すると、両者が `localDbPath(cwd)` を同時に書き込む。`saveDb` は tmp+rename で atomic なのでファイル corruption は起きないが、last-writer-wins で一方の snapshot が失われる可能性。

**影響**: 失われた差分は次回 refresh で再投入されるので最終的に収束 = 一時的な snapshot 後退のみ。実運用では install はユーザーが対話的に 1 回叩く想定 = 並列発生頻度は極低。`spotter db refresh` / `spotter db rebuild` と SessionStart bg refresh の間も同じ構造。

**次アクション**: P2 (機会があれば)。対処するなら (a) file lock (`~/.spotter/runtime/tool-db.lock`) で refresh を mutex、(b) saveDb 層で既存ファイルとの merge 差分書き込み、のどちらか。現状は実害観測なしなので放置で可。

### MCP clientInfo.version が package.json と drift (2026-04-20 監査で発見)

**背景**: [src/tool-db/investigate-mcp.mjs:250](../src/tool-db/investigate-mcp.mjs#L250) と [src/tool-db/investigate-mcp-http.mjs:90](../src/tool-db/investigate-mcp-http.mjs#L90) の `clientInfo: { name: 'spotter', version: '0.10.0' }` が hardcode で v1.0.0 と drift している。動作影響なし (MCP server 側が client version を使う実装はほぼない)、cosmetic 問題。MEMORY.md の "package.json bump 時は src/version.mjs も同期" の同類。

**次アクション**: [src/version.mjs](../src/version.mjs) から `SPOTTER_VERSION` を import して使う形に置換。次の bump のタイミングで同梱。

---

## 解決済み (参照用)

| 課題 | 解決版 |
|---|---|
| `parseMcpListOutput` の stdio tokenizer が `beforeStatus.split(/\s+/)` で、`C:\Program Files\nodejs\node.exe --foo ...` のような空白入り Windows 実行ファイルパスを `C:\Program` に壊していた問題。unquoted Windows absolute executable path (`.exe` / `.cmd` / `.bat`) の抽出と quoted arg 対応を追加し、プラグイン MCP の list-line 由来 spawn descriptor を壊しにくくした | unreleased |
| Unix daemon IPC が `~/.spotter/runtime` の umask 継承と socket mode 任せで、同一ユーザー外プロセスから connect できる可能性があった問題。runtime dir を `0700`、Unix socket を daemon listen 後に `0600` へ固定し、transport test で mode を検証 | unreleased |
| frontmatter parser が `description: >` / `description: |` の YAML block scalar に非対応で、block scalar を使う SKILL.md / agent md が description 空扱いになり recall から silent skip され得た問題。zero-deps の最小 parser のまま folded (`>`) / literal (`|`) block scalar を読み取り、skill discovery の回帰テストを追加 | unreleased |
| Haiku spawn 時に user/project の MCP server 60+ 個を毎回 load して CPU 100% 飽和 + 孤児 `npm exec` プロセス累積。WSL2 で daemon 3 並走 × 各 Haiku 呼出 = `npm exec @modelcontextprotocol/...` 等の MCP server を秒単位で spawn → 終了 → 再 spawn のサイクル → CPU/メモリ圧 → daemon 自体が cgroup OOM で死亡 → auto-resurrect ループ → 「Chime のチャット入力が無反応」体感症状。`buildSpawnArgs` に `--strict-mcp-config --mcp-config <empty>` 強制 + `ensureWorkdir` で `~/.spotter/workdir/empty-mcp.json` (`{"mcpServers":{}}`) を idempotent 生成。Haiku は `{name, description}` カタログ監査しか必要としないので副作用ゼロ | v1.3.0 |
| `install.mjs` の `HOOK_EVENTS` が settings.json に書く Stop/UserPromptSubmit timeout が 15s/30s のままで、v0.13.1 の Haiku timeout 緩和 (30→45s) が既存 install ユーザーに届かず Chime 等の重い環境で hook kill による「チャット入力無反応」を誘発していた問題。`HOOK_EVENTS` の該当 timeout を 60s に統一 (Haiku 45s + IPC 往復 + 余裕)。既存 project の settings は global update だけでは書き換わらないため、各 project で `spotter install` 再実行が必要 | v1.3.0 |
| Claude Code 公式の MCP scope 3 段 (User / Project / Local) のうち User (`~/.claude.json` 直下 `mcpServers`) と Local (`~/.claude.json` `projects[<root>].mcpServers`) を読み損ねていた構造バグ。`claude mcp add -s user -e KEY=val ...` 等で登録した MCP が `claude mcp list` で発見されるが env 抜きで spawn → tools/list 空 → `resolveAll` の prune でカタログから silent に脱落していた。`readMcpServers` を 4 ソース merge (`legacy < user < project < local`) に拡張、Windows の `projects[]` キー揺れ (separator / 大小 / 末尾スラッシュ) を正規化して照合 | v1.2.1 |
| 当該プロジェクトで使えないツールが Haiku 視野に幻として漏れる構造的バグ。`readMerged` が global DB の中身を local-wins マージで daemon の audit に流し込んでいた経路 + `resolveAll` が snapshot にもう存在しないローカルエントリを削除しなかった経路の二重バグ。daemon 入力を `readLocal` (local DB only) に切替 + `resolveAll` 末尾に prune ループ追加 (investigate 失敗時は既存値保持) | v1.2.0 |
| Bell の isolated `CLAUDE_CONFIG_DIR` (例 bellbot) が hook → daemon → haiku の spawn 連鎖で継承され、Spotter haiku が credentials 不在の config を読みに行き auth 失敗で exit 1 → 次 turn で同じ session-id が "already in use" で stuck し user_input hook が非 0 exit 連鎖する bug。`sanitizeHaikuEnv` で haiku spawn 時のみ `CLAUDE_CONFIG_DIR` を strip + `runHaikuJudgment` で E_INTERNAL / E_HAIKU_TIMEOUT 時も session を rotate してから throw | v1.1.6 |
| Windows で `execClaude` 経由の `cmd.exe /c claude mcp list/get` に `windowsHide: true` が付いておらず、SessionStart 毎の refresh で console window が flash + 入力フォーカスを奪う UX 回帰 | v1.1.5 |
| claude.ai baseline (Gmail/Calendar/Drive 25 件) が `claude mcp list` の実在確認なしに全環境で無条件注入 (隔離 `CLAUDE_CONFIG_DIR` / 未連携 / 部分連携環境で幻ツール) | v1.1.4 |
| `listMcpServers` / `getStdioConfig` が `projectRoot` を受けながら `claude mcp list / get` spawn 時に `cwd` を渡していなかった silent mismatch | v1.1.4 |
| カタログ対象を Claude Code 本体側から切り離し (deferred-baseline 撤去 + skill/agent 収集新設) | v1.0.0 |
| project scope `.mcp.json` 未対応 | v0.10.0 |
| x-api が 401 で Haiku 視野に入らない | v0.9.0 (`.mcp.json` 読み込み) |
| HTTP/SSE MCP transport 未実装 | v0.8.0 |
| Windows `.cmd` で `spawn claude ENOENT` | v0.8.0 |
| カタログのツール名抽象 (current_time 等) 問題 | v0.7.0 (tool-db 置換で消滅) |
| 毎ターン full prompt 再送による session 肥大 | v0.6.0 (preamble-once) |
| 孤児 daemon プロセスの自動回収 | v0.6.2 (親 PID watch) → v0.12.0 (heartbeat に置換、VSCode native ext 誤爆を解消) |
| Stop hook が Bell 最終応答を拾えていないバグ | v0.4.4 |
