# Spotter文書案内

Spotterの文書は、現行契約、進行中の仕事、履歴、証拠を分ける。通常作業では本書と現行契約だけを読み、
完了済み計画やrelease時点の記録を自動的に文脈へ入れない。

実挙動の権威はsourceとtestである。文書と実装が矛盾した場合は実装を確認し、現行文書を修正する。

## 現行契約

- [`../README.md`](../README.md)／[`../README.ja.md`](../README.ja.md): 単独導入、利用、診断、更新の入口
- [`01_catalog-design.md`](01_catalog-design.md): tool-dbとcatalog discovery
- [`02_spotter-claude-contract.md`](02_spotter-claude-contract.md): CLI、hook、daemon、auditor、
  runtime error store、evaluationの実装契約
- [`04_operational-slo.md`](04_operational-slo.md): latency、失敗率、品質、提案観測の運用基準
- [`11_dashboard-operations.md`](11_dashboard-operations.md): dashboardのservice、routing、公開運用
- [`adr/`](adr/): 置換されていない不変Decision

## 進行中の仕事

- [`open-issues.md`](open-issues.md): 現在の未完事項と次の行動の唯一の台帳

完了した項目は`open-issues.md`から外し、release差分は`CHANGELOG.md`、完了計画は`archive/`へ移す。

## 履歴

- [`archive/`](archive/): 完了、撤回、置換済みのplan、rollout、release時点の設計記録
- top-levelの「履歴参照stub」: immutable artifactが参照する旧pathを保つ案内。現行契約ではない
- [`migration/`](migration/): 旧pathとsource対応を固定したimmutable migration artifact。現行契約ではない
- [`../CHANGELOG.md`](../CHANGELOG.md): release履歴の正本

archive内の「現行」「TODO」「未実装」は記録時点の語であり、現在の契約へ読み替えない。

## 証拠

- [`evidence/`](evidence/): versionと観測時点に束縛された受入・公開smoke
- [`../rag/INDEX.md`](../rag/INDEX.md): 外部仕様のdated snapshotと評価artifact

証拠はDecisionや現在install済みversionの台帳ではない。

## 所有境界

Spotterのinstall、設定、state、schema、migration、診断、復旧、更新、releaseはこのrepoが所有する。
dotagentsは任意の工場統合とhost配線を統括するだけで、Spotterの実行条件や製品状態を所有しない。
Spotterを工場から切り離しても、READMEと本書から単独運用を完結できる状態を維持する。
