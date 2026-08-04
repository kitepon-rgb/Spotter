# 04 — Spotter 運用サービス目標（SLO）

作成日: 2026-07-12

SLO（Service Level Objective）は「通常運用で、どの程度の速さ・成功率・判定品質なら正常とみなすか」の基準である。
単発の失敗を隠すための許容値ではなく、悪化を検知して直す順序を決めるために使う。

## 適用範囲

- production auditor: `gpt-5.6-terra × medium`（policy version 3）
- Codex native `UserPromptSubmit` / `Stop`
- Claude host の primary auditor（backend 別に集計し、Codex と混ぜない）

## 運用 SLO

7日移動窓かつ各 Hook 50 call 以上で判定する。50 call 未満は参考値であり、合否を断定しない。

| 項目 | UserPromptSubmit | Stop |
|---|---:|---:|
| p50（半数が収まる時間） | 6秒以下 | 6秒以下 |
| p95（95%が収まる時間） | 15秒以下 | 15秒以下 |
| auditor timeout率 | 1%以下 | 1%以下 |
| auth / usage limitを除くbackend失敗率 | 2%以下 | 2%以下 |

Codex nativeは外側Hook 60秒・auditor child 20秒、Claude hostは外側Hook 60秒・daemon/backend 45秒である。
SLOを満たさない時に上限だけを延ばして正常扱いにはしない。対応順は (1) Hook重複除去、
(2) catalog/prompt workload削減、(3) model/effort再評価、
(4) cache/skip条件、(5) 別承認でtimeout変更、とする。認証失効・利用上限・非対応modelは別障害として
fail-loudに通知し、別modelへ自動fallbackしない。

## リリース時の品質ゲート

versioned fixtureをrepeat=3で2回実行し、次をすべて満たすこと。

- schema成功率 100%
- exact match 100%、false positive / false negative ともに0
- timeout 0%
- p95 10秒以下
- effective model / effort / policy version が期待値と一致

2026-07-12のTerra mediumは24/24 exact、FP/FN 0、timeout 0、全体p95 4.361秒で合格した。
同一fixtureのworkload別では user input 12件がp50 3.514秒 / p95 4.076秒、turn end 12件が
p50 4.024秒 / p95 4.361秒だった。事後的なtimeout感度は3秒で23/24失敗相当、5秒・10秒・20秒で
0/24失敗相当である。5秒は余裕が小さいため製品既定にせず、20秒を維持する。

## 提案の観測評価

運用評価は意味的な妥当性や有用性を推定せず、実際の利用だけを測る。

- 提案率: auditorがvalidな判断を返したUserPromptSubmitのうち、1件以上のtoolを提示したturnの割合。
- tool採用率: 利用結果を確定できた提示tool itemのうち、同じ親turnで同じcanonical tool IDが
  1回以上呼び出された割合。
- 提案しなかったturnはtool採用率の母数に入れない。
- Stop欠落や利用記録不全は`outcome_missing`として率の母数から分離する。
- 呼び出されなかったitemは`not_adopted`と呼び、「不適切」「役に立たなかった」とは解釈しない。

非採用caseではrequest、提案tool、利用tool、提案時の任意Throughline snapshotを改善材料として表示する。
その情報から追加すべき監査文脈を検討できるが、現行の率自体へ人手ラベルは混ぜない。

## Throughline評価文脈

UserPromptSubmit監査はThroughlineの導入・設定・freshness・取得成否から独立して実行する。
Throughline `observer-read`は提案が出た時の改善用証拠を一度だけ取得する任意経路であり、失敗時は
`context_unavailable`として記録するだけで監査結果や親への助言を変更しない。監査coverageのSLOへ
Throughline statusを混ぜない。

## 2026-07-12 初期スナップショット

Codex project-local履歴は UserPromptSubmit 27件がp50 5.132秒 / p95 12.138秒 / timeout 1件、
Stop 17件がp50 4.336秒 / p95 20.035秒 / timeout 1件だった。旧model・認証失効・利用上限を含む混合集計で、
50件未満なので新SLOの合否判定には使わない。改善前の比較基準として保持する。

同履歴のmissingは3件中CodeGraphが1件（33%）。daemon長期履歴では55件中35件（64%）だった。
母数とmodelが異なるため過検出とは断定せず、上記ラベルが30件集まるまでcatalog変更を行わない。
