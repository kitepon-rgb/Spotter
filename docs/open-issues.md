# Open Issues

Spotter v1.4.28（公開済み、2026-07-21）以後の未完事項だけを記録する。
完了済みの実装・過去バージョンの観測・採用しなかった案はCHANGELOGと`docs/archive/`を参照する。

## 運用ルール

- 実際に次の行動がある項目だけを置く。
- 「念のため観測」「機会があれば」だけの項目は置かず、実害が出た時に追加する。
- 解決した項目は本文へ残さず、CHANGELOGまたは完了計画へ移す。
- P0は現在のrollout判断、P1は次の運用窓、P2は既知だが未発生のplatform固有リスク。

## P0 — 提案採用のproject横断観測

現行`spotter.hook_event.v1`は提案tool IDを記録できるが、session/turn、実配送、同一turnの
利用tool一覧を持たない。このため、提案toolの採用確率も、非採用caseの提案時文脈も正確に復元できない。

### 完了条件

- 提案率 = 1件以上emitした成功UserPromptSubmit数 / 成功UserPromptSubmit数
- tool採用率 = 同一turnで呼び出されたemit済みtool item数 / outcome確定済みemit item数
- outcome未確定itemを非採用へ混ぜず、実数を併記
- project、tool、host別に集計
- `not_adopted` caseを、Spotterが見た文脈と既存`observer-read` snapshotを分けてdrilldown可能
- Throughlineに新しいI/F、turn ID、background collectorを追加しない
- instrumentation中は現行runtime context、model、prompt、projectorを変更しない

### 次の行動

Lattice plan `proposal-adoption-eval`を工程正本として実装中。
[`09_proposal-adoption-evaluation-plan.md`](09_proposal-adoption-evaluation-plan.md)の設計に従い、
proposal時刻と、その時点の既存Throughline `observer-read` snapshotをSpotterへ記録する。
非採用caseを確認するまで、runtimeへ追加する文脈を決めない。

`07_throughline-auditor-context-plan.md`は現行default-on connectorの設計正本として維持するが、
効果測定の基準は本P0と新計画へ置き換える。

## P1 — v1.4.21以降のPrimary auditor SLO判定

旧version・認証失効・usage limitを含む累積値ではなく、v1.4.21以降の7日移動窓かつ各Hook 50 call以上で
判定する。基準は[`04_operational-slo.md`](04_operational-slo.md)。

### 次の行動

母数到達後、UserPromptSubmit / Stopをbackend別に集計し、次を判定する。

- p50 6秒以下
- p95 15秒以下
- auditor timeout率1%以下
- auth / usage limitを除くbackend失敗率2%以下

未達時はHook重複、catalog/prompt workload、model/effortの順で直し、timeout延長だけで正常扱いしない。

## P2 — Windows Named PipeのDACL制限

Unix socketはowner-onlyだが、Windows Named Pipeは明示DACLを設定していない。同一マシンの別ユーザーから
接続できる可能性がある。現在まで実害報告はない。

### 次の行動

Windowsで他ユーザー接続を再現した時点でP1へ上げ、SECURITY_DESCRIPTOR設定または専用transport層を実装する。
再現がない間はrelease blockerにしない。
