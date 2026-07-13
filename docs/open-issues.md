# Open Issues

Spotter v1.4.24（published / rollout 3 host installed、2026-07-14）の未完事項だけを記録する。
完了済みの実装・過去バージョンの観測・採用しなかった案はCHANGELOGと`docs/archive/`を参照する。

## 運用ルール

- 実際に次の行動がある項目だけを置く。
- 「念のため観測」「機会があれば」だけの項目は置かず、実害が出た時に追加する。
- 解決した項目は本文へ残さず、CHANGELOGまたは完了計画へ移す。
- P0は現在のrollout判断、P1は次の運用窓、P2は既知だが未発生のplatform固有リスク。

## P0 — Throughline文脈default-onの効果測定

v1.4.21で、Throughlineを解決できるproject installは監査文脈が既定ONになった。旧既定disabledは
再install時に移行し、明示OFFは`origin:explicit`として維持する。fresh以外では監査AIを呼ばず、
親へは検証済みtool ID由来の固定助言だけを返す。

### 完了条件

- 7日以上かつfresh監査30件以上
- 期待finding 10件以上、期待pass 10件以上
- 人手ラベル: `妥当 / 過検出 / 見逃し / context不足`
- `stale率 / connector latency / 過検出 / 見逃し`を集計
- L2本文は評価ログへ保存しない

### 次の行動

default-onは確定済みで、母数到達後にON/OFFを再審査しない。過検出・見逃しがあれば精度改善ToDoを
起票し、なければ測定完了として閉じる。`spotter install -y --auditor-context disabled`はproject所有者の
明示opt-out機能として維持する。

正本: [`07_throughline-auditor-context-plan.md`](07_throughline-auditor-context-plan.md)

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
