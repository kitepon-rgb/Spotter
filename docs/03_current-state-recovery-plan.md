# 03 — Spotter Current State Audit and Recovery Plan

作成日: 2026-07-12

状態: **Phase 0〜7 完了（archive待ち）**

## 目的

Spotter が現在の Claude Code / Codex Hook 環境でどこまで実動し、どの契約・実装・設定・運用が
壊れているかを、コード・テスト・ローカル実機状態・現行公式仕様から判定する。その上で、
Claude-first の製品契約と再帰防止保証を維持した復旧順序を確定する。

## 今回の範囲

- 現在のリポジトリ、未コミット差分、テスト基準線、ローカル install / Hook / daemon 状態の棚卸し
- Claude / Codex の Hook 入出力と Spotter adapter の整合性監査
- daemon lifecycle、再帰防止、backend 選択、pending delivery、tool-db の主要経路監査
- 問題を「確認済み不具合」「仕様 drift」「運用未検証」「文書 drift」に分類し、優先順位を付ける
- 実装フェーズ、検証ゲート、revert 境界を持つ復旧プランの策定
- auditor model / reasoning effort の更新方針と GPT-5.6 評価レーンの策定

## 初回監査フェーズでは行わなかったこと

以下は監査時の保全境界。2026-07-12 にプラン承認後、明示された実装・独立 commit へ移行した。

- Spotter 本体コードの修正
- Hook の install / uninstall、global config の書き換え、daemon の kill
- 既存未コミット変更の破棄・上書き・コミット
- npm release、push、履歴変更

## 保全条件

- Claude-first の既存 contract と prompt / IPC / report wording を、明示承認なしに破壊しない。
- `SPOTTER_PARENT_PID`、`SPOTTER_BACKEND`、`SPOTTER_CHILD_BACKEND`、`agent_id`、
  `source === "startup"`、marker、PID preexist、call window の再帰防止を弱めない。
- 着手時の未コミットは由来を確認し、`.codegraph/.gitignore` は local-state 除外として採用、危険な
  repo-local `.codex/hooks.json` は owner 承認後に削除した。
- 現行仕様と旧仕様の差を、コード不具合と文書不整合へ分けて報告する。

## 監査 TODO

- [x] `CLAUDE.md`、`docs/open-issues.md`、Claude contract、catalog design、Hook parity 台帳を読む
- [x] 現行 Codex Hook 公式仕様を確認する
- [x] git / release / 未コミット変更の由来と完成度を棚卸しする
- [x] `node --test` の基準線を取り、失敗を環境要因とコード要因に分ける
- [x] Claude Hook → daemon → auditor → pending delivery の実装を追跡する
- [x] Codex Hook → auditor → delivery の実装を現行 Hook schema と照合する
- [x] install / diagnostics / generated config が実際の CLI 仕様と一致するか確認する
- [x] ローカルの global install、CLI version、Hook trust、設定、daemon / log 状態を読み取り専用で確認する
- [x] 再帰・多重 daemon・stale socket・失敗時 degradation の回帰テスト範囲を確認する
- [x] open issues と現コードの drift、新たな未記載課題、解決済み課題の残骸を整理する
- [x] 重要な指摘を反対仮説で再検証し、誤検出を棄却する
- [x] 問題一覧、優先順位、実行フェーズ、検証ゲート、やらないことを本書へ確定する
- [x] 未コミット変更ごとの推奨処置を確定する

## 結論

Spotter のコード全体が壊れているわけではない。着手時 `node --test` は **348 tests / 346 pass /
2 platform skip / 0 fail**、v1.4.18 release前の最終suiteは **439 tests / 437 pass / 2 skip /
0 fail**。Claude daemon の再帰防止・heartbeat・resurrect・stale socket 回復にも実装と回帰テストがある。

repo では `SessionStart async:true`、diagnostics 誤成功、Stop warning 欠落、Codex used-tools drift を
独立 commit で修正し、v1.4.17 clean pack / temp install smoke まで完了した。model policy と safe eval
基盤は v1.4.18 development 境界へ分離した。v1.4.17 は最終 SHA `7987f2a` を tag / npm / GitHub Release
へ公開し、この Mac の global package も `spotter 1.4.17` へ更新した。Spotter project で再 install 後、
`~/.codex/hooks.json` の3 entry は各1件・canonical・`async` なし。`/hooks`画面で3件ともTrusted / active、
新規taskの`SessionStart`が1回であることまで実機確認した。

2026-07-12 の最初のmodel operational smokeはbaseline / Luna / Terra × 4 fixtureの全12件が
Codex CLI usage limitで失敗した。この時点のartifactは
[`rag/openai-model-policy/evals/2026-07-12-operational-smoke.json`](../rag/openai-model-policy/evals/2026-07-12-operational-smoke.json)
に固定した。

同日 15:39〜15:41 JST に再開したところ、通常の Codex CLI と `--ignore-user-config` だけを外した
auditor probe は成功したが、本番同条件の isolated CLI は引き続き usage limit（16:41 再試行案内）だった。
`service_tier="default"` の明示だけでも解消しない。したがって user config を無断で再読込して得た結果を
本番相当とは扱わず、隔離契約を維持したまま quota 境界を再確認する。

その後Pro20回復後に同一fixtureで比較を再開し、Terra mediumは2回合計24/24 exact、FP/FN 0、
timeout 0を記録した。owner裁定によりproductionを`gpt-5.6-terra × medium`へ昇格した。金額costは
ChatGPTプランから取得不能として明示した。backend/stage別の実運用SLO、品質gate、改善順は
[`docs/04_operational-slo.md`](04_operational-slo.md)へ正本化した。

したがって現状は **「v1.4.17の配布と実機Hook確認はgreen。v1.4.18はmodel昇格、専用失敗分類、
公式model更新監視、SLO、Stop surface比較まで実装・検証済みで、release作業だけが残る」** と判定する。

重要指摘は独立反証にかけた。反証後、async SessionStart / diagnostics は「初回 seed と手動 refresh が
ある」ため P0 から P1 へ、未追跡 repo-local Hook は product bug でないため P2 へ下げた。一方、現行
transcript で shell tool call を数えない問題は実データで確認できたため P1 へ上げた。P0 に残したのは
既知の永久 resurrect 不能修正が未配布である問題だけである。

## 状態サマリー

| 領域 | 判定 | 根拠 |
|---|---|---|
| Node unit / integration test | green | 現在 439 tests、437 pass、2 platform skip、0 fail |
| Claude daemon safety | 実装・回帰あり | 再帰 guard、heartbeat、auto-resurrect、stale socket test |
| Codex `UserPromptSubmit` / `Stop` | 稼働あり | project hook-event 14 件中両 event を観測 |
| Codex `SessionStart` refresh | green | global entryはcanonical・`async`なし、新規taskで1回観測 |
| Codex diagnostics | green / trustはUI確認済み | 3 hooks各1件、compatible / canonical、`/hooks`でTrusted / active |
| 配布 | **同期済み** | tag / npm latest / GitHub Release / global install = v1.4.17 |
| 応答性能 | SLO確定 / 観測継続 | 7日・各50 call、p50 6s / p95 15s / timeout 1%以下 |
| model 評価 | **採用済み** | production=`gpt-5.6-terra × medium`、24/24 exact、token取得済み |
| 文書 | 主要正典同期済み | Hook parity TODO移動済み、本計画はrelease後にarchiveする |

## 初回監査で確認した P0

### P0-1. v1.4.16 は tag / source にあるが、実配布されていない

- `package.json` は v1.4.16、remote tag `v1.4.16` は release commit `61c7401` を指す。
- `main` / `origin/main` は tag 後の docs commit を含む `8d68a8c` で一致する。
- 2026-07-12 の npm registry は `latest=1.4.15`、`claude-spotter@1.4.16` は 404。
- GitHub Release `v1.4.16` も存在しない。
- 実機 `/opt/homebrew/bin/spotter` は v1.4.15。

**影響**: v1.4.16 で修正した「異常死後の stale socket で永久に resurrect 不能」が、通常の
global install 利用者には届いていない。コード上の解決済みと運用上の解決済みが一致していない。

## 初回監査で確認した P1

以下は defect 発見時の capture。各項目冒頭の「対応済み」注記があるものは、現在の repo 実装では解消し、
release / 実機反映だけが残る。

### P1-1. Codex `SessionStart` の自動 refresh が async 指定で停止し、diagnostics は見逃す

**repo 対応済み**: `85e280a` / `f22b46c`。実機反映は Phase 2 の release / global update 待ち。

**事実**:

- 修正前の [`mergeCodexHooks`](../src/cli/codex-hook-cmd.mjs) は `SessionStart` に
  `async:true` を生成する。
- 2026-07-12 時点の [公式 Codex Hook 仕様の保存版](../rag/codex-hooks/current-spec-and-spotter-drift.md)
  は async command hook を未対応として skip すると明記する。
- ユーザー提供の実機画面 (2026-07-12 11:40:16) に
  `skipping async hook in /Users/kite/.codex/hooks.json: async hooks are not supported yet`
  と表示された。
- `.spotter/hook-events.jsonl` の Codex event 14 件は `UserPromptSubmit=10` / `Stop=4` で、
  `SessionStart=0`。本来は [`runCodexSessionStartHook`](../src/cli/codex-hook-cmd.mjs#L87) が
  `refresh_spawned` を記録する。
- `.spotter/tool-db.codex.json` の更新時刻は 2026-05-21 のままである。
- 修正前の [`codexHookDiagnostics`](../src/cli/codex-hook-cmd.mjs) は feature flag と hooks.json 内の
  command 文字列しか確認せず、unsupported `async:true` でも `available` を返す。

**影響**: install 時の同期 seed と手動 `spotter db refresh --host-agent codex` は利用できるため、
初回から全停止する P0 ではない。一方、SessionStart ごとの drift refresh は恒常的に動かず、追加・削除した
MCP / skill / plugin が自動追従しない。diagnostics も見逃すため P1 とする。

diagnostics は `registered / schema-valid / observed` を分ける。trust の安定した機械 API は確認できないため、
内部 state を成功判定へ使わず、Codex `/hooks` での review を明示案内する。

### P1-2. Claude Stop 失敗の loud warning は次ターンにも届かない

**対応済み**: `f3c2234`。Claude / Codex 両 host の warning pending、dedupe、writer failure の
non-blocking loud degradation を回帰化。最終 turn で次 prompt がない限界だけ open issue に残した。

修正前の [`stop.mjs`](../src/hooks/stop.mjs) は backend / transport 失敗を degraded event に記録して
return するだけで warning を pending へ保存せず、[`user-prompt.mjs`](../src/hooks/user-prompt.mjs) は
finding pending だけを drain していた。

コメントと contract は「次の UserPromptSubmit が warning を配信」としているが、実装上は backend が
回復した次ターンには通知不能である。open issue の「最終ターンだけサイレント」は影響を過小評価している。
Codex adapter は同じ Stop backend error をすでに pending へ積んでおり、Claude parity の漏れである。

### P1-3. Codex used-tools parser が現行 shell tool call を数えない

**対応済み**: `1a2b407`。bounded current-turn reader と anomaly 契約を追加し、PreToolUse 二重観測は不採用。

修正前の [`readCodexUsedTools`](../src/core/codex-transcript.mjs) は transcript の
`response_item.payload.type === "function_call"` だけを数える。現行の実 transcript では shell 実行が
`custom_tool_call` (`name:"exec"`) として記録される。今回の root session では `custom_tool_call exec=45`
に対し、Spotter parser が数えたのは別種の `function_call=4` だけだった。

**影響**: shell だけを使った turn を `usedTools=[]` と誤認し、短い final response なら
`short_final_no_tools` で Stop 監査を誤 skip し得る。公式も transcript format を stable interface と
していない。実 transcript fixture を先に張り、PreToolUse の不完全な coverage も含めて observable hybrid
を検討する。

### P1-4. Codex hot path の latency と失敗率に SLO がない

project-local Codex event 14 件では UserPromptSubmit 10 件の p50 が約 5.8s、平均約 7.4s、最大 20.0s。
error は `E_CODEX_CLI_AUTH=1` / `E_CODEX_CLI_TIMEOUT=1`。daemon logs 全体では codex-cli 949 calls、
平均 6.3s、timeout 3、auth 6 だった。timeout は一過性で fail-loud に扱われており、それ自体を
Spotter のロジック bug とは断定しないが、入力直後の同期 Hook としては UX 予算が未定義である。

## 初回監査時の P2 / 設計・ローカル状態

### P2-1. 未コミット repo-local Hook は trust すると二重・異種経路になる

着手時に未追跡だった repo-local `.codex/hooks.json` は置き場所と JSON shape は現行 Codex に合うが、
`codex-hook ...` ではなく Claude 用 `spotter hook ...` を登録している。現行 Codex は user-global と
repo-local の matching hook をすべて並行実行するため、trust すると以下が同時発火する。

- global: stateless Codex adapter (`codex-hook user-prompt-submit|stop`)
- repo-local: Claude daemon adapter (`hook session-start|user-prompt|pre-tool-use|stop`)

repo-local Stop は Claude transcript parser を使い、Codex の `last_assistant_message` を使わない。
実機 Codex rollout に Claude parser を当てても assistant text は取得できなかった。したがって
「sync SessionStart にしたい」という方向は正しいが、このファイルは product bug ではなく危険なローカル試作である。
現在は未追跡なので、**commit / trust せず保全**する。

### P2-2. Codex Stop の delivery 判断が旧 Hook 制約を根拠にしたまま

2026-05 の contract は Codex `decision:"block"` が綺麗な continuation にならないことを pending
delivery の根拠にした。現行公式仕様は Stop の同出力を新しい continuation prompt として扱う。
pending delivery を直ちに捨てる根拠にはならないが、「Hook の制約で必須」ではなくなった。
`systemMessage` / continuation / pending の実機比較は有用だが、復旧 blocker にはしない。

### P2-3. 推奨品質のacceptance signal（定義済み・採取待ち）

daemon logs 949 calls 中 `pass:false=51`、missing 55 件。そのうち
`mcp__codegraph__codegraph_explore=35` (約64%) だが、実際に採用された比率は diagnostics から分からない。
過検出とはまだ断定できず、後続tool使用も推奨受諾を直接意味しない。`docs/04_operational-slo.md`で
妥当・過検出・見逃し・判定不能の人手ラベルを定義した。30 findingまではcatalogを変更しない。

### P2-4. auditor model更新ポリシーと評価ゲート（対応済み）

versioned policy、live model-matrix、専用失敗分類、公式2-source更新監視まで対応した。

[`codex-cli-backend.mjs`](../src/core/codex-cli-backend.mjs) はpolicyの`gpt-5.6-terra × medium`を既定とし、
env overrideを許す。pinと`--ignore-user-config`で親Codexの設定から隔離し、更新検知は評価提案まで、
production昇格はowner裁定まで行わない。

現行 OpenAI 仕様では `gpt-5.6` alias は `gpt-5.6-sol` を指し、軽量・高頻度向けは
`gpt-5.6-luna`、均衡型は `gpt-5.6-terra` である。当初はSpotterの高頻度な構造化監査に
`gpt-5.6-luna × low` を第一候補としたが、live比較後に`gpt-5.6-terra × medium`をproductionへ採用した。
調査と設計判断は [RAG 記録](../rag/openai-model-policy/spotter-auditor-model-policy.md) に固定した。

## 初回監査で確認した文書・台帳 drift（主要正典は対応済み）

- `CLAUDE.md` の旧 `decision:"block"` / `.spotter/codex-pending/` 契約は host-neutral pending へ修正済み。
- `docs/02_spotter-claude-contract.md` の Claude default / legacy policy は availability-based selection と
  versioned model policy へ修正済み。
- `docs/open-issues.md` は v1.4.18 development 現在へ更新し、最優先 SLO を backend-neutral 化済み。
- `docs/archive/SPOTTER_HOOK_PARITY_TODO.md` へ完了済み台帳を移動し、現役文書から分離した。

## 現在動いているもの / 棄却した疑い

- Claude daemon の再帰防止 8 系統、heartbeat、auto-resurrect、stale socket 回復はコードと test がある。
- logs は daemon starts=96 / stops=95 / fatals=0。1 session の 27 starts / 26 stops はあるが、
  現時点で EADDRINUSE crash-loop や大量 daemon proliferation を再現した証拠はない。
- `codex-sidecar auditor unavailable` は `doctor` の明示 warning だが、sidecar は second-pass 用であり、
  primary auditor の主故障ではない。
- `E_CODEX_CLI_TIMEOUT` は一過性の監査失敗として fail-loud に surface しており、今回の
  SessionStart skip とは別問題。timeout 延長だけを根治策にはしない。
- 親 Codex の `model_reasoning_effort="ultra"` は proactive delegation を増やし得る環境要因だが、
  Spotter 子 auditor は model / effort を明示する。今回の product bug と混同せず、設定変更もしない。

## 未コミット変更の処置

| Path | 判定 | 今回の処置 | 実装時の扱い |
|---|---|---|---|
| `.codex/hooks.json` | 危険なローカル試作 / P2 | owner承認後に削除済み | global installer-owned adapterだけを使用 |
| `.codegraph/.gitignore` | product と独立した hygiene | `!config.json` を明記して採用 | 独立 commit `6b7f772` で完了 |
| `docs/03_current-state-recovery-plan.md` | 今回の正本 | 採用 | 全TODO完了後 `docs/archive/` へ移動 |
| `rag/codex-hooks/` / `rag/openai-model-policy/` / `rag/INDEX.md` | 公式仕様の還流 | 採用 | Hook / model policy 更新時の根拠として維持 |

## 復旧プラン

### Phase 0. 証拠固定と characterization（本体挙動変更なし）

- [x] 着手前 baseline: `node --test` = 348 tests / 346 pass / 2 platform skip / 0 fail
- [x] fresh install が現行 schema `{type, command, timeout}` だけを生成する期待を test 化する
- [x] upgrade install が既存 `timeoutSec` / `async` / `statusMessage:null` を削除し、重複を作らない期待を test 化する
- [x] 他製品の global hooks の構造・値を完全保持する regression を追加する
- [x] diagnostics が `registered / compatible / canonical / observed` を分離する期待を追加する
- [x] 現行 transcript の `custom_tool_call exec` fixture と short-skip への影響を固定する
- [x] Claude Stop failure → backend 回復済みの次 turn でも warning が 1 回届く期待を追加する

Gate: targeted tests が赤になる理由が、上記の現行不具合だけで説明できること。

### Phase 1. 最優先 Hook activation 修正（挙動修正レーン 1）

- [x] `SessionStart` の command hook から `async:true` を撤去する
- [x] generator を現行 canonical fields (`timeout`) へ移し、既存 `timeoutSec` / `async` /
  `statusMessage:null` を再 install 時に正規化する
- [x] handler 自体は detached refresh を spawn して短時間 return する構造を維持する
- [x] diagnostics を `feature / registered / compatible / canonical / observed` に分離する
- [x] stable API がない trust は内部 state から推測せず、`/hooks で確認` と表示する
- [x] install / update 後の次手に `/hooks` review と新 session smoke を明示する

Gate (isolated Codex project):

- `/hooks` review 後に warning が消える
- `SessionStart: refresh_spawned` が **1 件だけ**記録される
- `.spotter/tool-db.codex.json` の更新時刻が進む
- UserPromptSubmit / Stop が各 1 経路だけ実行される
- Spotter daemon / `codex exec` の再帰増殖がない
- 既存 Throughline / Caveat / Callout hooks が完全保持される

### Phase 2. 配布を現実へ同期（挙動不変 + release レーン）

- [x] v1.4.16 tag を改変せず、未配布の stale-socket fix と Phase 1 を含む新しい patch version
  (推奨 v1.4.17) を作る
- [x] model policy より前の v1.4.17 RC code boundary を `1c67698` に固定する
- [x] `npm pack --dry-run` と temp prefix install で tarball 内容・CLI version・hook generator を smoke する
- [x] `node --test` を green にする
- [x] `1c67698` から `codex/release-v1.4.17` を作り、**v1.4.17 専用** README / CHANGELOG だけを
  `6ea6a2b` に固定する。
  v1.4.18 の model policy / profile / `auditor model-matrix` 記述と実装 commit を含めず、release SHA 上の
  CLI / backend contract と逐語照合した
- [x] `6ea6a2b` の `npm pack --dry-run` と CLI help で、README が v1.4.18-only command を広告しないこと、
  package=1.4.17、58 entries、`node --test`=383 / 381 pass / 2 skip / 0 fail を確認する
- [x] `6ea6a2b` で OS matrix CI 6/6 を green にする（main HEAD 1.4.18 の結果を流用しない）
- [x] CI green と owner 承認後、CHANGELOG の unreleased marker を外す最終 metadata commit を作り、
  tag / publish 対象の最終 SHA を固定する
- [x] 最終 SHA `7987f2a` を pushし、v1.4.17 tag / npm publish / GitHub Release を行う
- [x] `npm view claude-spotter version`、GitHub Release、fresh global install の三者一致を確認する
- [x] 実機 `~/.codex` を backupし、global package更新後にSpotter projectで`spotter install`を再実行する
- [x] Codex `/hooks` で現在の3 entryをreviewし、新規 taskで`SessionStart`を1回だけ観測する

Rollback: 実機 `~/.codex/` を事前 backup し、問題時は新 Spotter hook entry だけ uninstall、backup から
hooks 定義を戻す。既存 Throughline / Caveat / Callout hooks を巻き戻さない。

Release boundary note: candidate branch `codex/release-v1.4.17` は `6ea6a2b`、model policy commits
`e611a25` / `4c64933` と eval commit `cdf33ae` は
`1c67698` より後。package version の 1.4.18 bump はさらに後の `e34fb49` なので、version 文字列だけで
release scope を判定しない。v1.4.17 tag / publish 対象は release branch の固定 SHA とし、main HEAD を
直接 tag しない。現在の main README も v1.4.18-only surface を含むため、そのまま backport しない。

### Phase 3. Stop failure の通知契約を修復（挙動修正レーン 2）

- [x] Stop backend/transport failure → 次 UserPromptSubmit の連結 characterization を追加する
- [x] warning を session pending に永続化し、次 prompt で finding と同時 drain する
- [x] 同一 warning dedupe、auth の actionable text、短 prompt でも drain を固定する
- [x] 「最終ターンで次 prompt がない」限界だけを open issue として残す

Gate: 次 turn がある失敗は必ず warning が見え、最終 turn の限界だけが未解決であること。

### Phase 4. Codex used-tools coverage を修復（挙動修正レーン 3）

- [x] 現行 `function_call` / `custom_tool_call` / MCP / agent tool の transcript matrix を作る
- [x] Codex PreToolUse 追加のcoverage/costを比較し、現段階では二重観測を増やさないと決定する
- [x] bounded current-turn transcript readerを正とし、欠落・巨大turn・schema driftをanomaly化する
- [x] short-skip が実使用 tool を 0 件と誤認しない regression を追加する
- [x] transcript schema drift 時は silent に 0 件扱いせず、診断可能な anomaly を記録する

Gate: shell-only / MCP-only / agent-only turn の used-tools が期待どおりで、未知 schema は可視化される。

### Phase 5. Auditor model policy と GPT-5.6 移行（独立挙動変更レーン 4）

- [x] 現行 `gpt-5.4-mini × low` を代表 fixture で測り、移行 baseline を固定する
- [x] 第一候補 `gpt-5.6-luna × low` と比較対象 `gpt-5.6-terra × low` を同じ fixture で測る
- [x] `medium` は low に品質不足の実測がある場合だけ評価へ追加する（Terra mediumを2回、計24/24 exactで確認）
- [x] model slug を各所に散らさず、auditor policy manifest/module を単一の正本にする
- [x] policy に version、意味論的 role、具体 model、effort、`verifiedAt`、必要な互換条件を持たせる
- [x] 選択優先順位を「明示 override（env / 将来の project config） > 製品 policy」で固定する
- [x] `codex-default` を製品既定として暗黙継承しない（将来導入する場合も明示 opt-in のみ）
- [x] diagnostics に effective model / effort / 選択元 / policy version / 検証日を表示する
- [x] model 不在・非対応を含む失敗で effective selection と bounded diagnostics を残し、silent fallback しない
- [x] Codex CLI が安定した識別子を返すか実測し、model 不在専用の `E_CODEX_CLI_MODEL_UNAVAILABLE` を追加する
- [x] 公式仕様 / catalog の更新検知を変更提案まで自動化し、評価なしに既定 model を自動昇格しない
- [x] `~/.codex/models_cache.json` を安定した runtime contract として読まない
- [x] versioned fixture と `spotter auditor model-matrix` を追加し、選択真実性・safe artifact・
  FP/FN・anomaly・run bound を敵対的に回帰化する
- [x] repeat=1 の operational smoke を実行し、usage limit で全12件 error だった事実を artifact 化する
- [x] generic `E_CODEX_CLI_EXIT` から usage limit を bounded actionable code に分類する（model 昇格とは別 commit）
- [x] `--ignore-user-config` を維持した isolated CLI の quota 回復を確認する（通常 CLI の成功だけで代用しない）
- [x] isolated CLI quota 回復後に同一 fixture SHA / ordering で live 比較を再実行する
- [x] Codex JSONL `turn.completed.usage` をboundedに抽出し、profile別token usageをartifactへ記録する
- [x] 合格した model / effort だけを独立 commit で昇格し、変更理由と評価結果を記録する

2026-07-12 Pro20回復後の1回目repeat=3ではTerra lowが12/12 exact、usage抽出後の2回目は11/12。
合算23/24でbaseline 18/24、Luna low 17/24より最良だが、lowの品質不足が再現したためTerra mediumを
追加評価した。token usageは36/36取得済み。ChatGPTプラン上の金額costは取得不能として分離した。
詳細は [`rag/openai-model-policy/evals/2026-07-12-pro20-repeat3-usage.md`](../rag/openai-model-policy/evals/2026-07-12-pro20-repeat3-usage.md)。

Terra mediumは比較12 runと再確認12 runの合計24/24 exact、FP/FN 0、timeout 0。owner裁定により
`gpt-5.6-terra × medium`をproductionへ採用し、policy version 3で昇格した。詳細は
[`rag/openai-model-policy/evals/2026-07-12-terra-medium-verification.md`](../rag/openai-model-policy/evals/2026-07-12-terra-medium-verification.md)。

Gate: schema / JSON 遵守が 100%、既存 fixture の指摘品質が非劣化で、p50 / p95 / timeout rate /
token・cost が合意 SLO 内にあること。diagnostics が effective 値と選択元を正確に表示し、非対応 model が
fallback せず可視化されること。

この phase は v1.4.17 の release blocker にせず、独立した次 patch（推奨 v1.4.18）で扱う。

### Phase 6. 非 blocker の設計実験・性能・判定品質

- [x] isolated probe で Stop `systemMessage` / `decision:"block"` continuation / pending の UI・transcript を比較する
- [x] CLIでは`stop_hook_active` false→trueのmax-1を確認し、Codex app background/app-serverではStop自体が発火しないsurface差を確認する
- [x] delivery差を明文化し、active Appのblock未確認・既存契約維持のためv1.4.18ではpending維持と決定する（変更なし）
- [x] UserPromptSubmit / Stop 別の p50 / p95 / timeout rate の SLO を合意し、`docs/04_operational-slo.md`へ正本化する
- [x] Phase 5 の採用 model / effort を前提に timeout / workload の matrix を同じ fixture 24件で測定する
- [x] timeout 延長ではなく、まず監査 workload・model・Hook 重複を減らす対応順を固定する
- [x] acceptance を人手ラベルで定義し、単純な後続 tool 使用を受諾扱いしない
- [x] CodeGraph 推奨集中を再評価し、母数30 findingまではcatalogを変更しないと決定する

Stop実測の証跡は [`rag/codex-hooks/stop-delivery-characterization-2026-07-12.md`](../rag/codex-hooks/stop-delivery-characterization-2026-07-12.md)、
運用基準は [`docs/04_operational-slo.md`](04_operational-slo.md) を正とする。

この phase は v1.4.17 の release blocker にしない。

### Phase 7. 正典・open issues・未コミット整理

- [x] `CLAUDE.md` / Claude contract / README / open issues を実装と現行 Hook 仕様へ同期する
- [x] 完了済み Hook parity TODO を `docs/archive/` へ移す
- [x] Haiku 固有の最優先観測項目を backend-neutral latency / failure / cost SLO へ置き換える
- [x] repo-local `.codex/hooks.json` をowner承認後に削除し、global正式entryとの重複をなくす
- [ ] 本計画を完了チェック後に `docs/archive/` へ移す

`.codegraph/.gitignore` は product 復旧と別件として、tracked `config.json` の扱いを確認後に独立処理する。

## 実装単位と commit 境界

1. `fix(codex-hooks): 現行 schema で同期 SessionStart を生成する`
2. Codex diagnostics + install guidance
3. v1.4.17 package / release metadata
4. Claude Stop degradation delivery
5. Codex used-tools coverage
6. auditor model policy + GPT-5.6 評価基盤（policy/backend/eval を独立 commit、昇格は未実施）
7. optional delivery / performance experiments（承認済み項目ごと）
8. docs / open issues / archive

各単位で `node --test` を通し、並行作業時は pathspec を明示する。release / publish / push は
オーナーの明示指示まで行わない。

## やらないこと

- 削除済みの repo-local `.codex/hooks.json` を復元・trust・commitしない。
- `~/.codex/hooks.json` を手で `async:false` にするだけで済ませない（再 install で戻る）。
- Hook activation 修正と Stop delivery の挙動変更を同じ差分にしない。
- diagnostics で Codex の内部 trust state を安定 API として解釈しない。
- timeout を伸ばすだけで performance 問題を解決扱いにしない。
- model slug を source / test / docs の複数箇所へ個別に決め打ちしない。
- `gpt-5.6` alias や親 Codex の current default を製品既定として暗黙継承しない。
- 公式 latest 表示や `~/.codex/models_cache.json` の検知だけで auditor model を自動昇格しない。
- 指定 model が使えない時に別 model へ silent fallback しない。
- Claude entrypoint と Codex payload を characterization なしに共用しない。
- v1.4.16 tag を移動・改変しない。
- 再帰防止 guard や loud-failure 契約を弱めない。

## 完了条件

- 各指摘に file / command / log / official spec のいずれかの証拠がある。
- 「いま動くもの」「壊れているもの」「未検証のもの」を混同しない。
- P0 / P1 / P2 と、修正前に必要な characterization test が明記される。
- 各実装フェーズが独立に revert 可能で、検証コマンドと合格条件を持つ。
- 未コミット変更の扱いが、保持・修正候補・分離・棄却候補のいずれかで明示される。
