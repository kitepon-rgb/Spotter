# AGENTS.md

Spotterで働く全AIエージェント共通のプロジェクト正典。`CLAUDE.md`は`@AGENTS.md`だけを読む
import入口である。

## 製品の役割と自律所有

Spotterは、host-local catalogからユーザー追加ツールを把握し、主役AIとは独立したhook駆動監査で
呼び忘れを検出する製品である。host標準ツールは提案対象ではなく、追加ツールとの比較基準にだけ使う。

このrepoはSpotterを単独で導入、実行、診断、復旧、更新、releaseできる情報と実装を所有する。
Spotterのsource、install、設定、state、schema、migration、正規診断、復旧、更新、releaseは
Spotter側だけを正本とする。dotagentsは任意の工場統合、host配線、互換性確認、BugHubへのread-only投影を
統括するが、Spotterの動作条件でも制御者でもない。工場設定が無い環境でも、工場連携以外の製品機能を
失ってはならない。

## 文書の寿命

- 現行文書の地図は[docs/00_overview.md](docs/00_overview.md)を正とする。
- 現行契約は`README.md`／`README.ja.md`、`docs/01_catalog-design.md`、
  `docs/02_spotter-claude-contract.md`、`docs/04_operational-slo.md`、
  `docs/11_dashboard-operations.md`、`docs/open-issues.md`だけに置く。
- 完了、撤回、置換済みのplanとrollout記録は`docs/archive/`へ移し、通常作業の必読にしない。
  release履歴は`CHANGELOG.md`へ一本化し、本書へ複製しない。
- ADRは不変Decision、`docs/evidence/`と`rag/`は時点証拠であり、現行仕様として読まない。
- 同じ意味の現行文書を増やさない。既存の契約文書へ統合してから重複文書をarchiveへ移す。

コード変更前に本書と[docs/open-issues.md](docs/open-issues.md)を読む。Claude / Codex両対応は
[docs/02_spotter-claude-contract.md](docs/02_spotter-claude-contract.md)、catalog / tool-dbは
[docs/01_catalog-design.md](docs/01_catalog-design.md)も読む。実挙動の権威はsourceとtestであり、
文書と矛盾したら文書欠陥として直す。

## 実装境界

### Claude-firstとhost adapter

Claude Code、Bell、Haiku、既存hook workflowを第一級のまま維持する。CodexとCursor対応は
agent-neutral coreのadapterであり、detector、reporting、stateをhost別に複製しない。

- OS依存は`src/platform/`だけが所有する。process起動は`spawn.mjs`、socket / pipeは`ipc.mjs`、
  path正規化と実行体探索は`paths.mjs`に置く。
- host依存の決定点は`src/host/adapters.mjs`だけが所有する。host固有実装は専用moduleへ閉じ、
  業務ロジックへ`process.platform`やhost別分岐を散らさない。
- Claude、Codex、Cursorのtool DBはhost-localかつ別fileで所有し、一方のrefreshで他方を
  pruneまたはoverwriteしない。global DBはdescription cacheだけで、audit入力へ混ぜない。
- `codex-sidecar`は明示second-pass workflowであり、primary auditorのhidden fallbackにしない。

### 再帰安全

Spotter自身の子backendからhook / daemonを増殖させない。次の現行guardを弱めない。

- `SPOTTER_PARENT_PID`、`SPOTTER_BACKEND`、`SPOTTER_CHILD_BACKEND`
- `agent_id`、`source === "startup"`、`.spotter/marker.json`
- 同一sessionのPID事前確認と10秒call window

daemon lifecycleはapp-level heartbeatとUserPromptSubmit auto-resurrectを使う。
`process.ppid`監視を戻さない。guardを置換する時は同等以上の保証、対象failure path、回帰testを同じ変更に含める。

### 失敗契約

1. daemon、transport、auditor、tool-db、frontmatterの失敗を`pass`へ偽装しない。coreは構造化errorを返し、
   hook境界は固定warningと構造eventによるloud degradationへ変換する。別backend / modelへsilent retryしない。
2. UserPromptSubmit / Stopの想定外失敗はallow-list済み固定`systemMessage`、固定stderr、構造eventを出して
   exit 0とする。ユーザー入力を消すexit 2はmalformed envelopeだけに使う。auditor prose、provider出力、
   exception本文をmodel contextへ反射しない。
3. SessionEnd cleanupとtelemetryはnon-blockingでも失敗記録を残す。暫定stub、TODOだけの関数、
   型が曖昧なmainline実装を入れない。

想定済み異常は記録して正常returnし、想定外はcoreでthrowする。この分類をfallbackで曖昧にしない。

### 親出力と評価証拠

- UserPromptSubmit監査は現在のrequestとhost-local catalogだけで実行する。Throughlineの導入、設定、
  freshness、取得成否を監査条件または監査入力にしない。
- Throughline `auditor-context`は提案確定後、exact session / host / transcriptから評価用snapshotを
  一度だけ取得できる。失敗は`context_unavailable`として記録し、監査結果と親出力を変えない。
- Claude / CodexのStop findingは構造eventだけに残す。即時block、継続強制、次turnへのmodel-context配送、
  `.spotter/pending/`への新規書込みを行わない。
- 親向け助言はcatalog照合済みtool IDから共通projectorが作る固定・非命令形の文だけとし、
  auditorの自由文を渡さない。

### daemonとcatalog

- daemonはsession-scopedで、SessionStartからSessionEndまでhook eventとused toolsを集約する。
- Claude呼出しはsession-scoped、preamble-once、schema失敗時のsession renewを使う。
- 隔離workdir `~/.spotter/workdir/`へ`CLAUDE.md`を置かない。
- Claudeは`.spotter/tool-db.json`、Codexは`.spotter/tool-db.codex.json`、Cursorは
  `.spotter/tool-db.cursor.json`だけを監査入力にする。

公開CLI、hook / daemon IPC、runtime error store、evaluation、dashboardの現行contractとtest対応表は
[docs/02_spotter-claude-contract.md](docs/02_spotter-claude-contract.md)を正とする。未解決事項は
[docs/open-issues.md](docs/open-issues.md)、運用判定は[docs/04_operational-slo.md](docs/04_operational-slo.md)を正とする。

## 実装と検証

- Node.js 22.13以上を使い、依存追加は必要性を説明する。npm packageは`claude-spotter`、CLIは`spotter`。
- 既存Claude command、hook、prompt、daemon IPC、report文言、fixtureを、明示された破壊変更なしに変えない。
- exact fileを直接読んでから編集する。変更に直結する`node --test`のfocused testを先に通し、
  最終gateはpackage scriptsとCI契約に従う。
- Spotter repo自身へ`spotter install`して会話監査を自己言及させない。開発確認はtestまたは別projectで行う。
- commitは独立revert可能な単位にし、並行作業中はpathspecを明示する。

## 未解決の設計論点

回答後から次入力までに、model contextを汚さずfindingを見せるhost機能は現時点で無い。
公式のPre-Response相当機能が追加された場合だけ再評価し、それまではStopの構造event契約を維持する。
