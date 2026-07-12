# Open Issues

Spotter で現時点（v1.4.18 development tree、2026-07-12）に **塞がっていない穴** と
**実測未検証の懸念** を優先度付きで記録する。repo で修正済みでも、未配布・未 install なら
実環境では未解決として扱う。

**この doc は「今ここにある課題」の唯一の真実源**。バージョンごとのリリースノート ([CHANGELOG.md](../CHANGELOG.md)) は歴史記録なので、現状把握はここを参照し、新規作業に入る前に必ず目を通すこと。

## 運用ルール

- 新課題追加: 優先度 (P0/P1/P2) + 背景 + 必要な次アクションの 3 点を明示
- 解決したら: 該当項目を消し、commit / リリース番号を CHANGELOG に記録
- 優先度:
  - **P0** — 次に実装着手する前に解決したい。放置が怖い
  - **P1** — 次の patch / 実測レーンで塞ぎたい
  - **P2** — 機会があれば

---

## P0 — 配布と実環境 activation

### repo の修正が npm / global install / Hook 設定へ届いていない

**背景**: v1.4.16 の stale Unix socket recovery、v1.4.17 candidate の Codex Hook canonicalization /
readiness diagnostics / Stop warning delivery / current-turn used-tools は repo と test では実装済み。
しかし 2026-07-12 の実機 `/opt/homebrew/bin/spotter` は `1.4.15` のまま。global
`~/.codex/hooks.json` の Spotter `SessionStart` には旧 `async:true` が残り、現行 Codex CLI は
`async hooks are not supported yet` として skip する。スクリーンショットと `codex exec` の両方で再現した。
repo の generator が直っていても、global package update と再 install なしに実機警告は消えない。

**影響**: Codex `UserPromptSubmit` / `Stop` は旧 global entry で動き得るが、`SessionStart` refresh は停止し、
Codex tool-db drift が自動追従しない。v1.4.16 の永久 resurrect 不能修正も通常利用者へ届いていない。

**現在地**: v1.4.17 RC code boundary `1c67698` から `codex/release-v1.4.17` を作り、v1.4.17 専用
README / CHANGELOG を `6ea6a2b` に commit した。現 main の `auditor model-matrix` / v1.4.18 model profile
記述は含まない。CLI help、package=1.4.17、58-entry pack、383 tests / 381 pass / 2 skip / 0 fail を確認済み。

**次アクション**: `6ea6a2b` で OS CI matrix を通す。green と owner の明示承認後、CHANGELOG の
unreleased marker を外す最終 metadata commit の SHA を tag / npm / GitHub Release 対象に固定する。
main HEAD は既に v1.4.18 development なので v1.4.17 の CI / tag 対象にしない。実機 `~/.codex/` を backup して global package を更新し、各 project で `spotter install` を
再実行、`/hooks` review、新 session で `SessionStart: refresh_spawned` が1件だけ記録されることを確認する。
既存 Throughline / Caveat / Callout hook を保持する。publish / push / global 書換えは未承認。

---

## P1 — backend / daemon の信頼性と SLO

### Primary auditor の latency / failure / cost SLO が未確定

**背景**: auto selection では Claude host は Codex CLI が PATH にあれば `codex-cli`、なければ Haiku、
Codex host は `codex-cli` を選ぶ。明示 backend override は host より優先し、一度選択した backend が
失敗しても別 backend へ fallback しない。2026-07-12 の
project-local Codex event では UserPromptSubmit p50 約5.8s、平均7.4s、最大20.0s。daemon logs の
codex-cli 949 calls は平均6.3s、timeout 3、auth 6。Haiku fallback path には過去 20〜45s 域の
first/resumed 観測がある。backend ごと・stage ごとの合意 SLO がないため、timeout / model / workload の
変更を成功と判定できない。

v1.4.18 の `spotter auditor model-matrix` で `gpt-5.4-mini × low`、`gpt-5.6-luna × low`、
`gpt-5.6-terra × low` を同一 fixture で計測できる基盤は入った。ただし初回 operational smoke 12件は
Codex CLI usage limit で全て `E_CODEX_CLI_EXIT`。model 品質・availability・latency は未測定で、
token / cost も `not-available`。generic exit code では quota の対処が artifact だけから分からない。

2026-07-12 15:39〜15:41 JST の再試行では、通常 CLI と `--ignore-user-config` を外した同一 auditor
probe は成功した一方、本番同条件の isolated CLI は usage limit（16:41 再試行案内）のままだった。
`service_tier="default"` の明示だけでは解消しない。user config 全体の再読込は auditor の品質・費用・
再帰隔離契約を変えるため、回避策として採用しない。

**次アクション**: isolated CLI の quota 回復後に同一 fixture / hash / ordering で再実行する。
schema 100%、baseline 非劣化、
p50/p95、timeout rate、token/cost の SLO を先に合意し、通過した selection だけを独立 commit で昇格する。
`E_CODEX_CLI_USAGE_LIMIT` のような bounded actionable classification は model 昇格と別 commit で検討する。
timeout 延長や別 model retry だけで解決扱いにしない。

### daemon プロセスが shutdown ログなしに死ぬ (v1.3.0 で根因が大半解消した可能性、再観測中)

**背景**: ローカル実測ログ `daemon-80b5c0af-700f-47af-a3ac-796144823a7d.log` line 15 (E_HAIKU_TIMEOUT) の 53 秒後、同じ `session_id` で **shutdown ログなしに daemon が再起動** している (line 16-19 の `tool-db loaded` → `daemon listening` → `heartbeat armed` → `started`)。SessionEnd も heartbeat expire も走っていない。

v0.12.0 の UserPromptSubmit auto-resurrect が次のユーザー入力で `E_UNREACHABLE` を拾って spawn し直したと推定されるが、**auto-resurrect で救われている分、sudden death 自体は観測されないまま積もる**。その間の turn_end / PreToolUse が届かない = 見えない欠落ターン。

**v1.3.0 で根因の大半が解消した可能性 (2026-05-04 観測)**: WSL2 で CPU 100% 飽和 + チャット入力無反応の症状調査で、Spotter daemon 3 並走 × 各 Haiku 呼出が `--strict-mcp-config` なしに spawn されて user/project の MCP server 60+ 個を毎回 spawn → 終了 → 再 spawn のサイクルで OS リソースを食いつぶしていた。同期間の `daemon-702a677d-...log` で同 sessionId に `tool-db loaded` が 15 分間に 8 回記録 = sudden death + auto-resurrect が高頻度発生。WSL2 cgroup OOM kill が daemon 自体を巻き込んでいた可能性が高い。v1.3.0 の `--strict-mcp-config --mcp-config <empty>` 強制で Haiku spawn が MCP server を 1 つも load しなくなり、CPU 食いつぶしが構造的に消えた。これにより daemon sudden death の主因が消えたはず。

**v0.13.2 で投入済みの診断 handler は引き続き残置**:
- [src/cli/daemon-cmd.mjs](../src/cli/daemon-cmd.mjs) に `process.on('uncaughtException')` / `'unhandledRejection')` handler を登録、**同期 `writeFileSync` で log に書いてから exit**。残った sudden death は stack trace + 種別が必ず残る
- [src/daemon/haiku-caller.mjs](../src/daemon/haiku-caller.mjs) の `child.stdin/stdout/stderr` に防御的 error listener 追加

**残: v1.3.0 後の再観測**。実運用で daemon 突然死頻度が下がるかを daemon ログで集計。`spotter diagnostics logs --json` の `daemon.restartSignals` / `daemon.toolDbLoaded` / `daemon.stops` を見て、1 セッションあたり何回再起動が起きるかを観測する。下がっていなければ別の真因 (Node 内部例外 / WSL 仮想化レイヤ等) を疑う。

**2026-06-04 更新 (回復経路の修正)**: 突然死の「頻度」とは別に、**死んだ後に二度と起動できなくなる**回復経路のバグを発見・修正した (解決済みテーブル v1.4.16 参照)。異常死で stale socket が残ると `server.listen` が `EADDRINUSE` で crash-loop し、auto-resurrect しても永久に未監査になっていた。`startDaemon` が listen 前に stale socket を unlink するようにしたので、突然死が起きても**次の resurrect で確実に復活する**ようになった。突然死の根因 (なぜ死ぬか) の観測は引き続き本項目で継続。実測の異常死は MacBook スリープ / Claude Code 強制終了で SessionEnd が走らなかったケース (graceful shutdown ログなし) が `83d7aa04` で確認された。

---

## P1 — 判定品質の実運用観測

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
Codex native に Spotter を適用して先に最適化し、実測できた改善だけを Claude host に移植する方針。
現行 backend policy は [`02_spotter-claude-contract.md`](02_spotter-claude-contract.md) を正とし、
完了済みの primary backend migration ログは
[`archive/SPOTTER_PRIMARY_BACKEND_TODO.md`](archive/SPOTTER_PRIMARY_BACKEND_TODO.md) に保持する。

**2026-05-08 更新 (v1.4.7 Phase 5)**: Claude host の opt-in `next` policy を Codex CLI に
切り替えた。`SPOTTER_AUDITOR_BACKEND_POLICY=next` を設定した Claude セッションは
`policy_next_claude_codex_cli` で `codex exec` 経由の primary auditor を呼ぶ。Codex CLI
unavailable / timeout / schema invalid / non-zero exit は hidden fallback せず、
`AuditorBackendError` を構造化エラーとして hook に伝搬する。`current` policy は既存互換の
Haiku を維持。Haiku 明示利用は `SPOTTER_AUDITOR_BACKEND=haiku` か `current` policy のみ。
別プロジェクトでの Claude 実セッション smoke と数日分 diagnostics は Phase 7 rollout 観測で
追って計測する。

**2026-05-08 更新 (v1.4.10 availability-based primary auditor)**: v1.4.7 の opt-in `next` policy を
撤廃し、Claude host の primary auditor は既定で「Codex CLI が PATH にあれば CLI、なければ Haiku」
の 2 段選択に変更した。検出は `isCodexCliAvailable` が `env.PATH` を同期 walk
(spawn 無し、Windows は PATHEXT 相当を試行)、selection-time のみ。一度選ばれた backend が runtime で
落ちた場合は従来通り `AuditorBackendError` を throw し、別 backend へ silent retry しない
(§0 fallback 禁止維持)。`SPOTTER_AUDITOR_BACKEND_POLICY=next` を export していたユーザーは設定を
外して構わない (受理はするが selection には影響しない)。`SPOTTER_AUDITOR_BACKEND=haiku` の明示固定
は引き続き有効。codex-sidecar は `spotter codex *` の明示 second-pass workflow 専用で primary
chain には入れない (現セッションでも `[caveat:codex-sidecar] advisory unavailable: sidecar
command failed` を観測)。Codex host の auto selection (`codex-cli`) と監査用子プロセスのモデル指定
(`gpt-5.4-mini` / `model_reasoning_effort="low"`) は変更なし。

**2026-05-08 完了 (v1.4.8 Hook behavior parity)**: Codex 改修で確定した hook 挙動 3 種を
Claude 側にも移植完了。
(A) Stop short-skip = daemon `handleTurnEnd` で短い final + 0 used_tools のとき auditor を呼ばずに即 pass。
(B) Stop deferred delivery = `decision:"block"` 撤去、`.spotter/pending/<sessionId>.json` 経由で
次 UserPromptSubmit の `additionalContext` として配信。Codex 側 pending path も
host-neutral `.spotter/pending/` に移行 (旧 `.spotter/codex-pending/`)。
(D) Hook event JSONL = `.spotter/hook-events.jsonl` (schema `spotter.hook_event.v1` + `host` フィールド)
に Claude / Codex 両 host の hook event を時系列で記録、`spotter diagnostics logs --json` で
集計表示。設計判断と検証ログは [`SPOTTER_HOOK_PARITY_TODO.md`](SPOTTER_HOOK_PARITY_TODO.md)。
別プロジェクトでの実セッション smoke と数日分 diagnostics は rollout 観測フェーズで実施する。

**2026-05-06 更新**: `spotter diagnostics logs --json` は backend 別集計 (`backends`,
`stages.*.backends`) を持つようになった。Haiku first/resumed だけでなく、Codex CLI /
codex-sidecar primary auditor の duration / pass=false / missing 件数を同じ summary で比較できる。

**2026-05-06 更新**: Codex CLI auditor child は、Codex CLI の暗黙 default model に依存せず、
`gpt-5.4-mini` + `model_reasoning_effort="low"` を明示指定する方針にした。Spotter の hook 判定は
高頻度・低遅延・低コストの構造化 JSON 監査なので、frontier model を暗黙に使うより
mini model を固定し、必要な smoke / 実験だけ `SPOTTER_CODEX_CLI_MODEL` で上書きする。

**2026-05-07 方針メモ**: Codex native hook の timeout は `UserPromptSubmit` と `Stop` を同一に
扱わない。`UserPromptSubmit` はユーザー入力直後の体感 UX に直撃するため短く保つ。一方 Codex
`Stop` は回答後監査で、現行実装では immediate block ではなく `.spotter/pending/` への
deferred delivery なので、多少長くても UX 影響は相対的に小さい。`Stop` で有用な指摘を timeout
で落とす損失のほうが大きい可能性があるため、実運用で `E_CODEX_CLI_TIMEOUT` が再発する場合は
`UserPromptSubmit` は 10-20s 程度、`Stop` は 30-45s 程度の非対称 timeout を検討する。無制限には
しない。長い `Stop` が次 turn の pending context 配送に間に合わないケースと、プロセス滞留は
別途 diagnostics で観測する。

**2026-05-06 v1.4.3 Codex native hook 実機 smoke**: Spotter repo の新 Codex thread で
`spotter --version` が `spotter 1.4.3`、`spotter codex-hook diagnostics --project
/home/kite/projects/Spotter` が `availability=available` / `codexHooksFeature=enabled` /
`SessionStart`・`UserPromptSubmit`・`Stop` installed を返すことを確認。`~/.codex/hooks.json` と
`.claude/settings.json` の Spotter hook command はどちらも global npm 版
`/home/kite/.npm-global/lib/node_modules/claude-spotter/bin/spotter.mjs` を参照していた。
`.spotter/hook-events.jsonl` は同 thread の `UserPromptSubmit` で
`2026-05-06T13:17:19.799Z` / `2026-05-06T13:17:20.154Z` に更新され、Codex CLI backend の
`pass=false` → `pass=true` を記録。daemon log 側の同時刻更新はなかったが、Codex native hook
event path としては新規記録が増えている。Claude DB `.spotter/tool-db.json` は 366 tools、
Codex DB `.spotter/tool-db.codex.json` は 25 tools で別ファイルのまま維持され、相互上書きの形跡なし。

**次アクション**: v1.3.0 以降の daemon ログを `spotter diagnostics logs --json` で集計し、
`backends.haiku`, `backends.codex-cli`, `backends.codex-sidecar` と
`stages.user_input.backends.*` / `stages.turn_end.backends.*` の duration を見る。
40s 付近に張り付く backend があれば (a) description truncate、(b) timeout 調整、
(c) プラグイン単位の選別機構、(d) Codex native 側での skip / cache 条件追加、のどれかを検討。
timeout 突破頻発なら緊急対処。

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

プラン [docs/archive/spotter-plan.md](archive/spotter-plan.md) §9 のスコープ順に沿った未消化項目。優先度低いが、実装決定時に参照。

### `/ask-spotter` スラッシュコマンド (v0.3 予定)

ユーザーが明示的に Spotter に問い合わせできるスラッシュコマンド。現状は hook 由来の `additionalContext` / pending queue のみが介入経路で、ユーザー発案の問い合わせは不可。

### async hook 化 (v0.4+)

現状 Stop hook は daemon の Haiku 呼び出しを同期的に待つ (daemon 45s、hook IPC 50s、install が書く Claude Code 側 timeout は 60s)。async hook 対応が Claude Code 側で来たら、体感レイテンシを隠蔽できる。

### Codex Stop の immediate block 不在

Codex native `Stop` は現状 immediate block ではなく deferred delivery。`Stop` で見つかった不足ツールは `.spotter/pending/` に保存され、次の same-session `UserPromptSubmit` の `additionalContext` で Codex に提示される。2026-05-06 の実測では `decision:"block"` を返すと final answer 後に `Stop Blocked` / exit code 1 となり、Claude Code のような綺麗な継続応答にはならなかったため、Caveat と同じ pending queue 方式を採用している。v1.4.8 以降は Claude / Codex で host-neutral pending queue を共有する。

**2026-07-12 更新**: 現行 Codex Hook 仕様は `Stop` の `reason` を continuation prompt として扱う。
したがって「Codex に continuation surface がない」という旧前提は失効した。ただし旧実機の
`Stop Blocked` 観測も残るため、文書だけを根拠に pending を置き換えない。

**次アクション**: isolated project で `systemMessage` / `reason` continuation / pending delivery の
UI・transcript・`stop_hook_active` max-1 を Codex CLI と app の両方で characterization する。挙動差を
明文化して個別承認を得るまでは deferred delivery を維持する。

### repo-local `.codex/hooks.json` の ownership 未確定

**背景**: 未追跡 `.codex/hooks.json` は Codex source に Claude 用 `spotter hook ...` 4経路を置いた
ローカル試作。正規 user-global `spotter codex-hook ...` 3経路と ownership / payload / transcript contract が
異なる。Codex は複数 source の matching Hook を全て実行するため、trust すると二重監査・異種 adapter
並行・再帰リスクになる。

**次アクション**: 現状は commit / trust せず保持する。正規 generator と重複しない形で削除するか、
正式 adapter へ置換するかを owner が明示裁定する。global Hook 修復の代用には使わない。

### CI 回帰テスト整備 (v0.4+)

現行 `.github/workflows/ci.yml` は Node 22.5 / 22.x と Linux / Windows / macOS の `node --test` matrix。lint フロー・PR ゲートは未整備。導入するなら `node --test` に加えて `eslint` 相当の最小 lint を CI に載せる。

### tool-db.json の並列書き込み race condition (2026-04-20 v1.1.1 review で発見)

**背景**: v1.1.0 で `spotter install` と `SessionStart` hook 両方から `refresh({projectRoot})` が走る構造になった。同一プロジェクトで `spotter install` 実行中に別 Claude Code セッションが SessionStart で bg refresh を起動すると、両者が Claude host-local `localDbPath(cwd, "claude")` を同時に書き込む。`saveDb` は tmp+rename で atomic なのでファイル corruption は起きないが、last-writer-wins で一方の snapshot が失われる可能性。2026-05-06 以降、Codex refresh は `.spotter/tool-db.codex.json` を使うため、Claude / Codex 間で互いのツールリストを prune / overwrite する問題は別ファイル化で解消済み。

**影響**: 失われた差分は次回 refresh で再投入されるので最終的に収束 = 一時的な snapshot 後退のみ。実運用では install はユーザーが対話的に 1 回叩く想定 = 並列発生頻度は極低。`spotter db refresh` / `spotter db rebuild` と SessionStart bg refresh の間も同じ構造。

**次アクション**: P2 (機会があれば)。対処するなら (a) file lock (`~/.spotter/runtime/tool-db.lock`) で refresh を mutex、(b) saveDb 層で既存ファイルとの merge 差分書き込み、のどちらか。現状は実害観測なしなので放置で可。

### Stop 失敗がセッション最終ターンだとサイレント非監査 (2026-06-02 v1.4.15 review で発見)

**背景**: v1.4.17 candidate で Claude / Codex 両 Stop の backend/transport failure を warning pending に
積み、次の same-session `UserPromptSubmit` が finding と同時に1回 drain するよう修正した。これで
「backend が次 turn までに回復したため過去の失敗通知が消える」穴は解消した。一方、セッションがその後の
`UserPromptSubmit` を迎えず終了すると、配送先が存在しないため最終ターンの Stop failure は surface できない。

**影響**: 最終ターン 1 回分の「監査できなかった」通知欠落のみ。pass を偽装する silent fallback ではない (verdict は生成されていない)。§12.4 の「応答後に surface する手段がない」限界と同じクラス。

**次アクション**: P2。Claude / Codex の `Stop` で non-blocking user-visible notice を安全に出せる
surface を実機 characterization し、使える場合だけ即時 warning を検討する。それまでは最終 turn 限界を
contract に明記して許容する。

---

## 解決済み (参照用)

| 課題 | 解決版 |
|---|---|
| Codex `SessionStart` に `async:true` を生成して現行 CLI が handler を skip し、diagnostics も `available` と誤成功していた。installer-owned entry を canonical `{type,command,timeout}` へ正規化し、feature / registered / compatible / canonical / observed / readiness を分離。trust は `/hooks` review を案内 | v1.4.17 candidate (repo 修正済み・実機反映待ち) |
| Claude Stop backend failure が degraded event だけで warning pending を積まず、backend が回復した次 turn に過去の未監査を通知できなかった。Claude / Codex 両 host で warning を host-neutral pending に dedupe 保存し、次 prompt で finding と同時に1回 drain。pending / stderr / event writer failure も non-blocking かつ loud | v1.4.17 candidate |
| Codex used-tools が legacy `function_call` だけを読み、現行 shell `custom_tool_call`、MCP、agent call を数えず short Stop を誤 skip し得た。bounded current-turn readerで全既知形を認識し、missing / oversize / schema drift は anomaly として監査を継続 | v1.4.17 candidate |
| auditor model slug が backend に直接 pin され、次世代 model の比較・昇格 gate がなかった。versioned policy、semantic evaluation profiles、effective selection diagnostics、safe model-matrix artifact を追加。production は評価完了まで `gpt-5.4-mini × low` を維持 | v1.4.18 development |
| daemon が異常死 (SIGKILL / crash / マシンスリープで SessionEnd 未発火) すると graceful `stop()` の socket unlink が走らず、`~/.spotter/runtime/session-<id>.sock` が orphan として残留。以後の resurrect / SessionStart は `assertNoLiveDaemon` (PID 死亡を確認) を通過して `server.listen(path)` に進むが、stale socket で `EADDRINUSE` → `daemon listening` 到達前に die → **auto-resurrect しても毎回同じ socket で crash-loop = そのセッションが永久に未監査**。実測: Kikoeru session `83d7aa04` が 16:26 起動後に異常死、18:43–19:14 の 5 回 restart が全部 backend 選択直後で停止、hook は毎ターン `E_UNREACHABLE` / `E_RESURRECT_FAILED` で degraded (「一時無効のまま」)。修正: `transport.mjs` に `removeStaleSocketFile` を新設し、`startDaemon` が `assertNoLiveDaemon` 通過後・`listen` 前に stale socket を unlink (Unix only、ENOENT は no-op、Windows named pipe は owner 終了で自動消滅するので no-op)。回帰テスト 3 件 (EADDRINUSE 再現→解消 / ENOENT no-op / Windows no-op) | v1.4.16 (実装済・未リリース) |
| codex auditor のログイン失効 (`token_revoked` / `refresh_token_reused` / `401`) で codex が異常終了すると、(A) 失効痕跡を捨てて全部 `E_CODEX_CLI_EXIT` に潰し auth を区別せず、(B) `UserPromptSubmit` hook が daemon エラーを `die(exit 2)` していたため、Claude Code が入力時 hook の exit 2 を **プロンプト消去** 扱いして毎ターン入力が消え「Claude が一切反応しない」状態になっていた bug。codex 非ゼロ終了の stdout+stderr をスキャンして `E_CODEX_CLI_AUTH` (`codex login` 案内) に分類 + hook 失敗を `die(exit 2)` から `[Spotter からの警告]` additionalContext + exit 0 の loud degradation に転換 (UserPromptSubmit / Stop / PreToolUse) | v1.4.15 |
| Codex hooks 登録後の初回 Codex セッションが、`SessionStart` の detached refresh 完了前に `UserPromptSubmit` を走らせると空 / 未作成の `.spotter/tool-db.codex.json` で監査し得た問題。Codex CLI が見える `spotter install` で Codex hooks 登録後に `refresh({hostAgent:"codex"})` も同期 seed し、SessionStart refresh は以後の drift 追従に限定 | v1.4.6 |
| Codex native hooks が npm 未配布で、Codex host では Codex CLI primary auditor / host-local `.spotter/tool-db.codex.json` / SessionStart refresh / structured backend error / recursion guard が使えなかった問題。Codex host default を Codex CLI にし、Codex CLI がある環境では `spotter install` が Codex hooks も登録する。既存 hook command path も npm global 版へ更新する。`codex-sidecar` は explicit primary auditor と second-pass / work workflow として残した | v1.4.2 |
| MCP initialize の `clientInfo.version` が `0.10.0` hardcode のまま package.json と drift していた cosmetic issue。`src/version.mjs` の package version を stdio / HTTP MCP investigate の `clientInfo.version` に使うよう修正 | v1.4.2 |
| `parseMcpListOutput` の stdio tokenizer が `beforeStatus.split(/\s+/)` で、`C:\Program Files\nodejs\node.exe --foo ...` のような空白入り Windows 実行ファイルパスを `C:\Program` に壊していた問題。unquoted Windows absolute executable path (`.exe` / `.cmd` / `.bat`) の抽出と quoted arg 対応を追加し、プラグイン MCP の list-line 由来 spawn descriptor を壊しにくくした | v1.4.2 |
| Unix daemon IPC が `~/.spotter/runtime` の umask 継承と socket mode 任せで、同一ユーザー外プロセスから connect できる可能性があった問題。runtime dir を `0700`、Unix socket を daemon listen 後に `0600` へ固定し、transport test で mode を検証 | v1.4.2 |
| frontmatter parser が `description: >` / `description: |` の YAML block scalar に非対応で、block scalar を使う SKILL.md / agent md が description 空扱いになり recall から silent skip され得た問題。zero-deps の最小 parser のまま folded (`>`) / literal (`|`) block scalar を読み取り、skill discovery の回帰テストを追加 | v1.4.2 |
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
