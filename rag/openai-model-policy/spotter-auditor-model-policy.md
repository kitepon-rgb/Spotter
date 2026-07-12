# Spotter auditor model policy — GPT-5.6 検討

調査日: 2026-07-12

確度: **仕様判断は高、`gpt-5.6-terra × medium` は24/24 exactを根拠にproduction採用済み**

## 出典

- [OpenAI: Using GPT-5.6](raw/gpt-5-6-latest-model-2026-07-12.md)
- [OpenAI: Codex config reference](raw/codex-config-reference-2026-07-12.md)
- [`src/core/codex-cli-backend.mjs`](../../src/core/codex-cli-backend.mjs)
- `~/Developer/dotagents/docs/02_models.md`（ローカルの役割別モデル配置表）

## 現状

Spotter は auditor を起動するとき、`gpt-5.6-terra × medium` を versioned policy の production 値として明示し、
`SPOTTER_CODEX_CLI_MODEL` / `SPOTTER_CODEX_CLI_REASONING_EFFORT` で上書きできる。
Codex は `--ignore-user-config` で起動するため、親セッションや利用者設定から auditor の品質・費用・
latency が偶然変わらない。この隔離は維持すべき契約である。

OpenAI の現行仕様では `gpt-5.6` alias は flagship の `gpt-5.6-sol` へ向く。軽量・高頻度向けは
`gpt-5.6-luna`、性能と費用の均衡は `gpt-5.6-terra` とされる。Codex config の `model` は文字列であり、
`lightweight` / `balanced` のような安定した意味論 alias や、製品が依存できる model discovery API は
文書化されていない。

## 実装した設計

1. [`codex-auditor-model-policy.mjs`](../../src/core/codex-auditor-model-policy.mjs) を単一の正本にし、
   model slug を backend / diagnostics / eval へ散らさない。
2. policy は `policyVersion`、意味論的 role、検証済みの具体 model、effort、`verifiedAt`、必要なら
   最小 Codex version を持つ。
3. 優先順位は「明示 override（現行 env、将来の project config） > 製品 policy」とする。
4. 既定は検証済みの具体 model を pin する。`--model` を省略して Codex の current default に追従する
   `codex-default` policy は、drift を受け入れる明示 opt-in に限定する。
5. `doctor` / diagnostics と structured result に effective model、effort、選択元、policy version、
   検証状態を表示する。非 Codex backend では「not applicable」とし、dormant Codex 設定を評価しない。
6. model 不在・非対応時は構造化エラーで fail loud とし、別 model へ silent fallback しない。
7. 更新検知は公式仕様や利用可能 catalog から変更提案を作るところまで自動化できるが、自動昇格はしない。
   `~/.codex/models_cache.json` は未公開の内部 cache なので、runtime contract にはしない。
8. `spotter auditor model-matrix` が versioned fixture の SHA-256、Codex CLI version、effective selection、
   schema/JSON 遵守、exact match、FP/FN、p50/p95、timeout rate、filtered name / anomaly を bounded JSON に
   記録する。raw stdout / stderr / malformed object は保存しない。
9. artifact は常に `promotionEligible:false`。Codex JSONL `turn.completed.usage` からtoken usageをboundedに
   抽出する。ChatGPTプラン利用の金額costはAPI価格で代用せず、取得不能を明示する。コマンド単独では
   production policyを書き換えない。

## 最初の評価候補

- baseline: `gpt-5.4-mini × low`
- 第一候補: `gpt-5.6-luna × low`
- 比較対象: `gpt-5.6-terra × low`
- `medium` は low に品質不足の実測が出た場合だけ追加する
- `gpt-5.6` / `gpt-5.6-sol` は高頻度の分類監査に必要な改善が実測されない限り採用しない

Spotter の処理は高頻度・構造化された軽量監査なので、仕様だけからの初期第一候補は
`gpt-5.6-luna × low` とした。ただし後述のrepeat=3実測では再現性がなく、第一候補を
`gpt-5.6-terra × low` へ変更した。「新しいから採用」ではなく、評価を通過して初めて既定値へ昇格させる。

## 2026-07-12 operational smoke

同じ代表 fixture 4件を baseline / Luna / Terra に各1回、計12回実行した。artifact は
[`evals/2026-07-12-operational-smoke.json`](evals/2026-07-12-operational-smoke.json)、読み方と制約は
[`evals/2026-07-12-operational-smoke.md`](evals/2026-07-12-operational-smoke.md) に固定した。

全12件が `E_CODEX_CLI_EXIT`。bounded artifact の外で同条件を1回だけ安全に切り分けた結果、原因は
Codex CLI の usage limit であり、model 品質・model slug availability・schema 遵守は測れていない。
したがって error 所要時間を model latency と比較せず、production は `gpt-5.4-mini × low` のまま維持する。

## 2026-07-12 Pro20 quota recovery

`--ignore-user-config` を維持したbaseline 4件が全件成功したためquota回復を確認し、同一fixture SHAと
orderingでrepeat=3、計36 runを実行した。詳細artifactは
[`evals/2026-07-12-pro20-repeat3.json`](evals/2026-07-12-pro20-repeat3.json)、解釈は
[`evals/2026-07-12-pro20-repeat3.md`](evals/2026-07-12-pro20-repeat3.md) に固定した。

1回目は`terra × low`が12/12 exact、baseline 10/12、Luna 8/12。usage抽出後の2回目はTerra 11/12、
baseline 8/12、Luna 9/12だった。合算でTerra 23/24が最良のためLunaの初期第一候補を棄却し、Terraを
次候補とする。ただしlowの見逃しが再現したためmediumを追加評価する。token usageは36/36取得できたが、
ChatGPTプラン上の金額costとSLOは未合意なのでproduction defaultは変更しない。usage対応artifactは
[`evals/2026-07-12-pro20-repeat3-usage.json`](evals/2026-07-12-pro20-repeat3-usage.json)、解釈は
[`evals/2026-07-12-pro20-repeat3-usage.md`](evals/2026-07-12-pro20-repeat3-usage.md)。

## Terra medium verification

lowの見逃し再現を受け、policy version 2に`terra-medium`評価profileを追加した。同一fixtureでlowと
mediumを各12 run比較し、mediumだけをさらに12 run再確認した。mediumは合計24/24 exact、FP/FN 0、
timeout 0。p50は3.78〜3.84秒、p95は4.28〜4.36秒で、tokenもlow比較runより増えなかった。
技術候補を`gpt-5.6-terra × medium`へ更新する。詳細は
[`evals/2026-07-12-terra-medium-verification.md`](evals/2026-07-12-terra-medium-verification.md)。

## Production採用

2026-07-12、上記24/24 exact、FP/FN 0、timeout 0、安定したlatency、low比較でtoken増加なしを根拠に、
ownerが`gpt-5.6-terra × medium`のproduction採用を裁定した。policy version 3でproductionとbaselineを
同selectionへ更新し、Luna low / Terra lowは比較profileとして保持する。model-matrix artifactからの
自動昇格、CLI既定modelの暗黙継承、失敗時fallbackは禁止のまま維持する。ChatGPTプランの金額costは
取得不能として明示し、backend/stage別の実運用SLOは別の継続課題とする。

## リリース境界

Hook activation と未配布の stale-socket 修正を届ける v1.4.17 の RC code boundary は `1c67698`。
model policy / backend / eval commits はその後に置き、v1.4.18 development 境界を `e34fb49` で明示した。
ただし model commits 時点では package version がまだ 1.4.17 だったため、version 文字列だけでは分離できない。
v1.4.17 は `1c67698` 起点の `codex/release-v1.4.17` に v1.4.17 専用 README / CHANGELOG を置き、
candidate `6ea6a2b` を作成した。現 main の `auditor model-matrix` / v1.4.18 profile 記述は含めず、
candidate に実在する CLI / package / pack と照合済み。OS CI 後の最終 metadata SHA にも model commits を
含めない。live 評価とproduction昇格もさらに分離し、金額costとSLOの裁定前に既定modelを変更しない。
