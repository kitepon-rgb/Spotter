# 提案採用観測・評価 実装計画

## 0. 状態

- 状態: **実装・受入完了**
- v1.5.8文書監査: `src/core/evaluation-*`、Claude/Codex lifecycle、CLI、dashboard consumerと照合済み。
- 現行補正: v1.5.4でThroughlineを監査条件・監査入力から撤去。v1.5.5で評価文脈を
  exact-session `auditor-context`へ戻した。
- 工程正本: Lattice plan `proposal-adoption-eval`。本文書は目的、設計判断、非目標、受入条件を持つ。
- 実装対象repo: `/Users/kite/Developer/Spotter`
- 外部依存: Throughlineの既存read-only I/F `throughline auditor-context`。Throughline側は変更しない。
- 対象範囲: 各端末内にあるproject横断の観測と集計。評価store自体はnetwork送信しない。
  後続のread-only dashboardは[`10_spotter-dashboard-plan.md`](10_spotter-dashboard-plan.md)で別に実装した。
- 実装開始裁定: 2026-08-04。Latticeのready frontierとPhase gateに従って実装・検証した。

## 1. 測るもの

評価対象はownerが指定した次の2点に限る。

1. **提案率**: Spotterが処理できたUserPromptSubmitのうち、1件以上のtoolを実際に提示した割合。
2. **tool採用率**: 提示したtool itemのうち、同じ親turnで実際に呼び出された割合。

記号を次で固定する。

- `S`: auditorがvalidな判断を返したUserPromptSubmit数。passも含む。
- `P`: safe projector後のtool IDを1件以上親へ提示したturn数。
- `I`: 提示したtool item総数。
- `C`: 同じturnの利用結果を確定できた提示tool item数。
- `A`: `C`のうち、同じcanonical tool IDが1回以上呼び出されたitem数。
- `M`: Stop欠落や利用記録不全により結果を確定できなかった提示tool item数。`I = C + M`。

表示する式は次の2つである。

- 提案率: `P / S`
- tool採用率: `A / C`

提案しなかったturnはtool採用率の母数に入れない。複数toolを提示したturnはtoolごとに数え、
一部だけ使われた場合もitem単位で数える。`M`は`outcome_missing`として実数を併記し、非採用へ
混ぜない。

呼び出されなかった結果は`not_adopted`と呼ぶ。「不適切」「役に立たなかった」「却下」とは
呼ばない。提案の意味的な妥当性、utility、task成功、提案しなかったtoolの反実仮想は推定しない。

## 2. Throughlineの既存I/Fを使う

新しいThroughline API、turn ID、DB schemaは作らない。proposalが確定した時点で、既存I/Fを1回使う。

```text
throughline auditor-context \
  --session <exact-session-id> \
  --project <canonical-absolute-project> \
  --host <claude|codex> \
  --transcript <host-transcript-or-rollout> \
  --recent-turns 2 \
  --max-body-chars 600 \
  --max-total-chars 4000 \
  --json
```

`auditor-context`はhost transcriptから提案元sessionの直前完了pairを特定し、Throughline側の同じ
session / pairへ照合したfreshなbounded contextだけを返す。主に次を保存する。

- `schema`, `status`, `reason`, `stats`。
- `turns[].originSessionId`, `turnNumber`, `user`, `assistant`, `createdAt`。

呼出位置は、auditor結果をsafe projectorへ通してproposal tool IDsが確定した後、親へhook結果を返す前。
この時点では親AIの当該turnはまだ始まっていないため、返る`turns[]`は提案時点の独立した前文脈になる。
同時に`recorded_at_ms = Date.now()`を記録する。Throughlineとの対応に新しいturn IDは使わない。

このsnapshotは、auditor入力と別に保存する。v1.5.4以降、auditorへ渡す本文は`request_text`だけで、
履歴文脈は渡さない。互換列`auditor_seen_context`は`null`を保存する。これにより非採用caseでは、
「現在のrequestだけで出した提案」と「同時点でThroughlineログI/Fから得られた前文脈」を比較できる。

`auditor-context`がfresh以外またはerrorなら、proposalと採用結果の記録は続け、評価文脈だけ
`context_unavailable`とする。retry、定期回収、別経路fallbackは行わない。project-wide latest threadを
読む`observer-read`は使わない。exact sessionとhost transcriptを入口で指定し、別threadの文脈を
提案時文脈として保存しない。

この計画では、cursorを使った後続delta回収やfinal assistant responseの取得は行わない。「結果」は
Spotterが既に観測できる、提案toolが同じturnで使われたかどうかである。

## 3. 最小構成

```text
UserPromptSubmit
  -> observation IDと記録時刻を生成
  -> 既存auditorを実行
  -> safe projector後の実提示tool IDを確定
  -> proposalがある時だけThroughline auditor-contextをexact sessionで1回取得
  -> local DBへdecision / proposal / request / 任意の評価文脈を記録

同じturnのtool invocation
  -> 既存usedToolsへcanonical tool IDを蓄積

Stop
  -> turn-end auditorより先にproposal itemの結果を1回だけ確定

spotter evaluation report / cases
  -> local DBだけを読む
```

保存面は`~/.spotter/evaluation.db`のSQLite 1個とする。project pathを各行に持つため、project registryや
projectごとの収集fileは作らない。複数projectのhookが同時に書く通常利用だけを考慮し、短いtransaction、
WAL、bounded busy timeoutを使う。retry worker、reconciliation daemon、常時validatorは作らない。

通常のOSユーザー境界で十分であり、専用ACL、owner検査、symlink検査、暗号化、network exportは
実装しない。

## 4. 保存schema

### `evaluation_turns`

- `observation_id`: UserPromptSubmit hookが生成するUUID。
- `recorded_at_ms`, `completed_at_ms`。
- `project_path`, `host`, `session_id`。
- `audit_status`: `success | error | skipped`。
- `request_text`。
- `auditor_seen_context`: 互換列。v1.5.4以降は履歴を渡さないため`null`。
- `observer_context_status`, `observer_snapshot_json`。
- `used_tool_ids`。
- `usage_status`: `open | complete | incomplete`。
- `backend`, `model`, `spotter_version`。

### `evaluation_items`

- `observation_id`, `tool_id`の複合key。
- `outcome`: `open | adopted | not_adopted | outcome_missing`。

passも`evaluation_turns`へ1行記録するがitemは0件とする。これが提案率の分母`S`になる。
`request_text`、`auditor_seen_context`、Throughline評価文脈（互換列`observer_snapshot_json`）は、
改善分析に必要なproposal turnだけ保存する。

監査失敗は`audit_status=error`として件数を確認できるようにするが`S`へは入れない。DB記録失敗は
既存の監査結果を書き換えず、stderrへ1回明示して終える。後追い修復はしない。

## 5. turnの開始と終了

### 共通

- UserPromptSubmit hookが入力を読んだ直後に`observation_id`を生成する。
- auditor結果とsafe projector後のtool IDsを同じ行へ記録する。
- proposal tool IDsは、親向け出力生成に使う配列そのものを保存する。raw findingは保存しない。
- Stop findingは親へtool提案として提示する経路ではないため、この集計へ入れない。
- 新しいUserPromptSubmit開始時に同じsessionの古いopen rowがあれば、そのitemsを`outcome_missing`で閉じる。
- 最終turnなどでStopも次のUserPromptSubmitも来ないopen proposalは、daemonのidle lifetimeと同じ30分を
  経過した後、report時にだけ`outcome_missing`として投影する。DBを書き換える常時回収処理は置かない。

### Claude

- hookが生成した`observation_id`をdaemonの`user_input` payloadへ渡し、daemonのactive stateに置く。
- PreToolUseでtoolをcanonical IDへ変換してから`usedTools`へ加える。
- PreToolUseをdaemonへ記録できなかった場合はactive rowを`usage_status=incomplete`にする。
- Stopではshort-final skipやturn-end auditor呼出より前にactive rowを閉じる。
- `completed_at_ms IS NULL`のrowだけを更新し、二重Stopで結果を上書きしない。

### Codex

- 現行hook入力に保証されない`turn_id`へ依存しない。
- UserPromptSubmitで同じ`session_id`の最新rowをactiveにする。
- Stopのcurrent-turn transcript readerが返す`usedTools`で、そのsessionの最新open rowを閉じる。
- transcript unavailable、incomplete、current-turn上限超過など、利用なしと断定できない状態は
  `usage_status=incomplete`として全itemを`outcome_missing`にする。

採用とはtool invocationが1回以上あったこととする。成功終了、出力内容、呼出回数は条件にしない。
代替toolの利用は、提案toolの採用には数えない。

## 6. tool IDを最初から揃える

提案側と利用側を、同じ小さなcanonicalize関数へ通す。

- MCP: catalog IDの`mcp__server__tool`へ揃える。
- Claude Skill: PreToolUseの`tool_input`内skill selectorをcatalog IDへ揃える。
- Claude sub-agent: PreToolUseの`tool_input.subagent_type`をcatalog IDへ揃える。
- Codex MCP: current-turn transcriptの識別子をcatalog IDへ揃える。現行Codexのouter `exec`が
  `tools.mcp__...(...)`を実行する形も、文字列・comment内の言及を除外して実callだけ認識する。
- Codex Skill: current-turnの`exec` / `exec_command`が、提案済みskillの正規root配下にある実在
  `SKILL.md`をreadした時だけ、frontmatter nameとplugin prefixからcatalog IDへ揃える。

別identity DB、catalog sidecar、collision監視は作らない。Claude/Codexの実fixtureで、現在proposal対象に
なり得るtool種別を一意に変換できることを実装時に固定する。変換不能な種類を`not_adopted`として
出荷せず、そのhost/kindの実装を完了させてから収集を開始する。

## 7. CLI

### 集計

```text
spotter evaluation report [--project <path>] [--from <ISO>] [--to <ISO>] [--json]
```

既定はlocal DB内の全projectをまとめ、次を分子・分母付きで表示する。

- `S`, `P`, proposal rate `P/S`。
- `I`, `C`, `A`, tool adoption rate `A/C`。
- `M`（`outcome_missing`）の実数。
- project別、tool ID別、host別の同じ集計。
- backend、model、Spotter versionはfilter用metadataとして使えるようにする。

### 非採用case

```text
spotter evaluation cases --outcome not-adopted [filters] [--json]
spotter evaluation case <observation-id> [--json]
```

case表示は次の順で分ける。

1. 記録時刻、project、host、backend/model。
2. `request_text`。
3. `auditor_seen_context`: v1.5.4以降は`null`。履歴文脈を監査へ渡していないことを示す。
4. `observer_snapshot_json.turns`: 同時点に既存Throughline I/Fから得た任意の前文脈。
5. 実際に親へ提示したtool IDs。
6. `used_tool_ids`とitemごとの`adopted / not_adopted`。

改善候補は、非採用caseでThroughline snapshotにありrequest単体では分からなかった情報を見てから考える。
比較用に同じtoolの採用caseもfilterで開けるようにする。

## 8. 実装構成

実行ToDo、依存、状態、完了証拠はLattice plan `proposal-adoption-eval`だけを正本にする。以下は設計上の
Phase境界であり、進捗台帳ではない。

### Phase 1 — local storeとThroughline reader

対象:

- 新規`src/core/evaluation-store.mjs`
- 新規`src/core/evaluation-context.mjs`
- 既存`src/core/auditor-context.mjs`のThroughline command設定を再利用

SQLite 2 tableと、既存`loadAuditorContext`を評価証拠専用に再利用するadapterを実装する。
Throughline repoは変更しない。

### Phase 2 — Claude / Codex lifecycle

対象:

- `src/hooks/user-prompt.mjs`
- `src/hooks/pre-tool-use.mjs`
- `src/hooks/stop.mjs`
- `src/daemon/daemon.mjs`
- `src/cli/codex-hook-cmd.mjs`
- `src/core/codex-transcript.mjs`

observation ID、実提示tool IDs、usedTools、item outcomeを接続する。既存のauditor判断、親向け文面、
hook timeout、再帰防止は変更しない。

### Phase 3 — reportとcase表示

対象:

- 新規`src/core/evaluation-report.mjs`
- 新規`src/cli/evaluation-cmd.mjs`
- `bin/spotter.mjs`

reportとcaseは保存済みDBだけを読み、Throughlineへ再問い合わせしない。

### Phase 4 — 一度だけの受入確認

- focused testを通す。
- 別projectでClaudeとCodexを各1turnずつ実行する。
- 実際の非採用caseを各hostで1件開き、request、任意のexact-session評価文脈、proposal、usedToolsを確認する。
- 2projectのfixtureで横断reportを確認する。
- 既存hook出力とauditor挙動が変わっていないことを確認する。
- install後にbaseline収集を開始する。

常時validatorや定期smokeは置かない。正しさは単一の記録経路、focused test、release前の一度の
live確認で作る。

## 9. 必須テストと受入条件

### focused test

- passを`S`へ入れ、`P`へ入れない。
- proposalだけを`I`へ入れる。
- 複数提案の全採用、一部採用、全非採用。
- 同じtoolの複数callを1 itemの採用1件へ畳む。
- Stop欠落と利用記録不全を`outcome_missing`として率から除く。
- Claude daemonの連続turnでobservation IDとusedToolsが混ざらない。
- Stop早期returnと二重Stopでも同じrowを正しく1回だけ閉じる。
- Codex sessionの最新open rowだけをStopで閉じる。
- MCP / Skill / Agentのcanonical ID変換。
- `auditor-context`のfresh bounded contextとcontext unavailable responseの保存。
- case表示でSpotter入力とThroughline snapshotを混ぜない。
- 2つのprojectから同じSQLiteへ並行writeできる。

### 固定集計fixture

- valid audit `S=10`
- proposal turn `P=4`
- proposal item `I=6`
- outcome確定 `C=5`
- adopted `A=2`
- outcome missing `M=1`

期待表示:

- proposal rate `4/10 = 40%`
- tool adoption rate `2/5 = 40%`
- outcome missing `1`

`2/10`のように提案しなかったturnを採用率の母数へ混ぜない。`2/6`のように結果不明を非採用扱い
しない。率だけでなく必ず実数も表示する。

### campaign受入条件

- 全project、project別、tool別で提案率とtool採用率を再計算できる。
- 非採用caseから、Spotterが見た文脈、既存Throughline I/Fの別文脈、提案tool、実使用toolを読める。
- Throughlineは既存`auditor-context`だけを使い、新規I/F、turn ID、background収集へ依存しない。
- measurement追加が既存の提案内容、親向け文面、model、prompt、runtime contextを変えない。

## 10. 受入結果

- 固定集計fixtureは`S=10 P=4 I=6 C=5 A=2 M=1`、提案率40%、tool採用率40%で一致した。
- 568 tests、macOS / Linux / Windows × Node 22.13 / 22.xのCI run `30913375991`は6/6 green。
- 75-file npm packにevaluation store / context / report / CLIと関連testが含まれることを確認した。
- 別projectの実Codex turnでThroughlineのfresh contextを保存し、提案した
  `mcp__caveat__caveat_search`の利用を`S=1 P=1 I=1 C=1 A=1 M=0`として記録した。
- Claudeは別projectの実turnで成功pass rowを記録し、proposal / PreToolUse / Stopの採用経路は
  focused fixtureで確認した。既存hookの親向け文面とauditor判定は変更していない。
- live受入で作った観測DBは確認後に削除し、利用開始時の端末DBへfixtureを混ぜていない。
- baseline期間中はmodel、prompt、context量を固定する。

baselineが十分に溜まった後、ownerがreportと非採用caseを見て次を決める。

- 現状のまま継続する。
- Throughline文脈から判明した追加情報を別変更として入れ、別期間で再測定する。
- 採用率と提案率が許容できなければSpotterを終了する。

計測コード自身に自動の存廃判定やcontext変更はさせない。

## 11. 実装中も行わないこと

- Throughline側のsource、DB schema、I/F変更。
- 新しいturn ID、background collector、retry worker、reconciliation daemon、常時validator。
- network送信、共有server、dashboard、専用ACL、暗号化。
- baseline結果を待たずにmodel、prompt、runtime context量を変更すること。
