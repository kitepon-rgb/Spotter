# 05 親セッション安全化プラン

状態: 完了  
作成日: 2026-07-12  
対象: Claude / Codex の `UserPromptSubmit` と `Stop`

## 目的

Spotter の監査用 AI を、親セッションへ自由文を渡せる主体として扱わない。監査用 AI の出力は
Spotter 内部の構造化判定に限定し、親へ返す Hook 出力は Spotter プログラムが検証済みデータから
決定論的に生成する。親に見せる文面は命令ではなく、採否を親が独立判断できる短い助言にする。

## 確認済みの事故経路

- 監査用 AI が生成した `reason` を、そのまま強い命令文へ埋め込んでいた。
- `Stop` の指摘を文字列のまま保存し、次の無関係な `UserPromptSubmit` へ持ち越していた。
- backend failure の message に含まれる子プロセスの stdout / stderr を親コンテキストへ入れていた。
- Codex と Claude の `additionalContext` は、どちらも親モデルから見える developer / system 相当の
  コンテキストであり、単なる非拘束メタデータではない。

## 採用する安全契約

### 1. 監査用 AI 出力は信用しない

- AI 由来の `reason`、`raw`、backend message、stdout、stderr を親 Hook 出力へ含めない。
- 親へ提示できる値は、現在の host-local catalog に完全一致したツール ID だけとする。
- ツール ID は重複排除し、固定上限を設け、Spotter側の規則で安定順にする。
- 親へ表示できるIDはASCIIの`[A-Za-z0-9_.:/-]`だけ、1件160文字以下、最大5件、
  全助言2,000文字以下とする。catalog一致でも改行・制御文字・backtick・Markdown構文を拒否する。
- catalog 外、型不正、空文字、上限超過は親へ出さず診断記録にだけ残す。

### 2. 親向け文面は決定論的な助言だけ

- stdout は Hook API が要求する JSON object だけにする。
- `additionalContext` の文章は固定テンプレートから生成し、AI生成文を連結しない。
- 文面は「関連する可能性がある利用可能ツール」という事実・助言として書く。
- 「応答する前に使え」「補正せよ」「ユーザーへ伝えよ」などの命令形を使わない。
- 親が独立に適用可否を判断でき、無視しても契約違反にならないことを明記する。

### 3. 監査失敗をモデル入力へ混ぜない

- 認証失効、利用上限、timeout、generic failure は allow-list した理由コードだけで分類する。
- ユーザーに知らせる必要がある場合は、モデル可視の `additionalContext` ではなく、allow-listした
  理由コードだけから固定した`systemMessage`、固定stderr、構造Hook eventの3面へ同じ状態を出す。
- provider message や子プロセス出力はログでも既存の bounded / redact 契約を維持し、親へは出さない。
- `systemMessage`のUI可視性は公式仕様で保証された面に限定して主張する。Codex App / background等の
  未実測surfaceで見えない場合も、親モデルへ`additionalContext`で戻すfallbackは作らない。

### 4. Stop の次ターン持ち越しを廃止する

- `Stop` は次の `UserPromptSubmit` 用の文章を保存しない。
- `Stop` finding は Hook event log に構造データとして記録し、利用可能なら固定 `systemMessage` で
  非強制の通知を行う。回答の継続・再生成は強制しない。
- `Stop` backend failureはfindingと分離し、allow-list済み固定コードを`systemMessage`・stderr・
  Hook eventへ出す。AI文字列やprovider本文は含めない。
- 旧 `.spotter/pending/<sessionId>.json` は移行専用処理で内容を読まずにunlinkし、親コンテキストへ
  配送しない。`ENOENT`は成功、その他の削除失敗は固定診断だけを記録して親入力を止めない。
  新規pendingは作らない。

### 5. Claude / Codex parity と再帰防止を維持する

- 共通 projector を Claude / Codex の両アダプターから使う。
- `SPOTTER_PARENT_PID`、`SPOTTER_BACKEND`、`SPOTTER_CHILD_BACKEND`、`agent_id`、marker、
  SessionStart source、PID preexist、10秒 call window を弱めない。
- `decision:"block"` や exit 2 による親の継続・入力消去を追加しない。

## やらないこと

- 監査モデルやeffortの再変更
- tool-db discovery / catalog設計の変更
- Stopで親回答を自動再生成させること
- provider本文を親へ見せるdebug escape hatch
- npm publish（実装・検証・ローカル止血後に別途リリース裁定）

## TODO

- [x] 現行の注入経路と実ログを調査する
- [x] Codex / Claude の公式 Hook 出力仕様を確認する
- [x] 変更前ベースラインをgreenで取得する
- [x] 未コミット・stash・upstream差分がないことを確認する
- [x] 外部仕様を `rag/` に一次ソースと要約へ保存する
- [x] 共通の安全な host-advice projector の characterization / negative test を追加する
- [x] Claude `UserPromptSubmit` を固定助言＋固定 `systemMessage` へ変更する
- [x] Codex `UserPromptSubmit` を同じ契約へ変更する
- [x] Claude / Codex `Stop` の pending 新規作成と次ターン配送を廃止する
- [x] 旧 pending を注入せず読み捨てる移行テストを追加する
- [x] AI理由文・raw stdout/stderr・命令形がHook出力へ出ないnegative testを追加する
- [x] tool IDの改行・制御文字・backtick・Markdown・超長大・重複・件数超過を拒否するtestを追加する
- [x] Stop backend失敗が固定`systemMessage`・stderr・構造eventへ出るtestを追加する
- [x] `systemMessage`の確認済み範囲と未保証surfaceをcharacterizationする
  - 公式契約ではUI/event stream向けでmodel contextではない。isolated CLI JSONLでは非出現、App/backgroundのUI可視性は未保証。製品契約は固定Hook出力の生成までに限定する。
- [x] 再帰防止・marker・短prompt・非blocking failureの既存契約を回帰確認する
- [x] `docs/02_spotter-claude-contract.md` と `CLAUDE.md` を新契約へ更新する
- [x] `docs/open-issues.md` のP0を解決状態へ更新し、`CHANGELOG.md`へ記録する
- [x] targeted test、full `node --test`、`git diff --check`をgreenにする
- [x] 敵対的検証で「自由文が残る経路」と「注入再発経路」を再監査する
- [x] ローカルglobal installへ反映し、Hook診断とglobal Hook実行smokeで止血を確認する
  - 新規Codex taskの作成は行わず、global `spotter codex-hook user-prompt-submit`を直接実行した。

## 合格条件

1. 悪意ある／長大な auditor `reason` を与えても Hook stdout に1文字も現れない。
2. backend error に stdout / stderr を含めても親の `additionalContext` に現れない。
3. `Stop pass:false` 後の次の無関係な入力へ finding が配送されない。
4. 親へ見えるツール候補は catalog 完全一致、重複なし、固定上限内である。
5. Claude / Codex の助言文が同じ共通 projector から生成され、命令形を含まない。
6. Hook失敗は入力消去・回答継続・hidden fallbackを起こさない。
7. 再帰Hook / daemon proliferation防止テストが全てgreenである。
8. legacy pendingは内容がmalformedでも読み上げず、同一sessionのファイルをbest-effortで削除する。
9. Stop failureはAI文字列を漏らさず固定コードで診断でき、findingの次turn配送とは分離される。

## 根拠

- Codex公式Hook仕様（2026-07-12取得）: `UserPromptSubmit.additionalContext` は extra developer
  context。`systemMessage` はUIまたはevent streamへ出る警告。
- Claude Code公式Hook仕様（2026-07-12取得）: `additionalContext` はsystem reminderとして
  conversationへ入り、固定情報は imperative system instruction ではなく factual statement として書く。
- リポジトリ内実測: 2026-07-12 17:22のStop findingが、17:23の無関係なnpm質問へ
  `pendingContextCount:1` として配送された。
