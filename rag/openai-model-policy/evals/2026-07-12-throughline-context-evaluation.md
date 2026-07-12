# Throughline auditor context 評価（2026-07-12）

- 出典: 同ディレクトリの `2026-07-12-context-*.json`
- 取得日: 2026-07-12
- 確度: 高（Codex CLI 0.144.1 / `gpt-5.6-terra × medium` の実測）
- 保存内容: case ID、期待/実際のtool ID、FP/FN、latency、token usageのみ。会話本文・hash・provider rawはartifactへ保存しない。

## 結論

Spotterのproject限定canary候補は、直近完了pair `N=2`、per-body `600 chars`、total `4,000 chars`。
全プロジェクトのproduction既定化は、7日以上かつfresh監査30件以上のcanaryとowner裁定まで行わない。

## 探索過程

初期prompt/fixtureでは、N=0は17/27 exact（FN 12）、N=1は19/27（FN 8）、N=2は25/27（FN 2）。
N=3はrun1で27/27だったがrun2は26/27（FN 1）で、反復安定性gateを満たさなかった。

この失敗から、短い「続けて」「再開」がrecent context上の未解決操作を継承すること、複数の独立した未解決操作を
部分列挙しないことをprompt v2へ明記した。また「既知の罠DB検索」と「進行中障害の原因調査」の説明が重なる
fixtureを、実際の責務に合わせて排他的にした。修正前artifactは探索履歴として残し、最終比較には使わない。

## 最終比較

fixture SHA-256 `bc4197b533eabc94b52888de4cd4cec09fb451da2998ccb381699f74c790671e`、
prompt version `2`、N=2、repeat=3で測定した。

| body cap | 実行 | exact | FP | FN | auditor p95 | token p95 |
|---:|---:|---:|---:|---:|---:|---:|
| 600 | 1 | 27/27 | 0 | 0 | 6,236 ms | 18,285 |
| 1,200 | 1 | 27/27 | 0 | 0 | 8,836 ms | 20,096 |
| 1,200 | 2 | 27/27 | 0 | 0 | 8,714 ms | 19,974 |
| 2,400 | 1 | 27/27 | 0 | 0 | 6,773 ms | 18,307 |

品質が同率なので、データ最小化を優先して600 charsを選ぶ。fixture本文が短いためlatency/token差はノイズを含み、
600の速度優位を一般化しない。auditor p95は全最終実行で10秒以内だった。

prompt v2で既存v1 fixtureもrepeat=3（12 run）し、exact 12/12、FP/FN 0を確認した。
v1単体のp95は11.589秒だったが、採用候補のcontext-aware fixture p95は6.236〜8.836秒で10秒gate内だった。

## 未完了gate

- Spotter `execFile` → Throughline CLI → Codex rollout freshness → read-only DB → Spotter schema検証の実環境20回は
  fresh 20/20、p50 98.68ms、p95 107.52ms、max 110.95msで、connector p95 250ms以下を達成した。
- 実運用での期待finding 10件以上・期待pass 10件以上を含むfresh監査30件は未観測。
- ChatGPT plan利用のため金額costは取得不能。token usageは全runで取得済み。
