# Spotter auditor model policy — GPT-5.6 検討

調査日: 2026-07-12

確度: **仕様判断は高、`gpt-5.6-luna × low` の採用判断は live 評価未完了の候補**

## 出典

- [OpenAI: Using GPT-5.6](raw/gpt-5-6-latest-model-2026-07-12.md)
- [OpenAI: Codex config reference](raw/codex-config-reference-2026-07-12.md)
- [`src/core/codex-cli-backend.mjs`](../../src/core/codex-cli-backend.mjs)
- `~/Developer/dotagents/docs/02_models.md`（ローカルの役割別モデル配置表）

## 現状

Spotter は auditor を起動するとき、`gpt-5.4-mini × low` を versioned policy の production 値として明示し、
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
9. artifact は常に `promotionEligible:false`。token / cost を取得できない間は `not-available` と明示し、
   コマンド単独では production policy を書き換えない。

## 最初の評価候補

- baseline: `gpt-5.4-mini × low`
- 第一候補: `gpt-5.6-luna × low`
- 比較対象: `gpt-5.6-terra × low`
- `medium` は low に品質不足の実測が出た場合だけ追加する
- `gpt-5.6` / `gpt-5.6-sol` は高頻度の分類監査に必要な改善が実測されない限り採用しない

Spotter の処理は高頻度・構造化された軽量監査なので、現時点の第一候補は `gpt-5.6-luna × low`。
ただし「新しいから採用」ではなく、上記評価を通過して初めて既定値へ昇格させる。

## 2026-07-12 operational smoke

同じ代表 fixture 4件を baseline / Luna / Terra に各1回、計12回実行した。artifact は
[`evals/2026-07-12-operational-smoke.json`](evals/2026-07-12-operational-smoke.json)、読み方と制約は
[`evals/2026-07-12-operational-smoke.md`](evals/2026-07-12-operational-smoke.md) に固定した。

全12件が `E_CODEX_CLI_EXIT`。bounded artifact の外で同条件を1回だけ安全に切り分けた結果、原因は
Codex CLI の usage limit であり、model 品質・model slug availability・schema 遵守は測れていない。
したがって error 所要時間を model latency と比較せず、production は `gpt-5.4-mini × low` のまま維持する。

## リリース境界

Hook activation と未配布の stale-socket 修正を届ける v1.4.17 の RC code boundary は `1c67698`。
model policy / backend / eval commits はその後に置き、v1.4.18 development 境界を `e34fb49` で明示した。
ただし model commits 時点では package version がまだ 1.4.17 だったため、version 文字列だけでは分離できない。
v1.4.17 は `1c67698` 起点の release branch で v1.4.17 専用 README / CHANGELOG を作る。現 main の
`auditor model-matrix` / v1.4.18 profile 記述は backport せず、release SHA に実在する CLI と照合する。
model commits を含めずに release SHA を固定する。live 評価と production 昇格もさらに分離し、quota 回復・SLO 合意・token/cost
観測前に既定 model を変更しない。
