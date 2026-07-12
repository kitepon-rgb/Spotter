# Auditor model matrix operational smoke — 2026-07-12

出典: [`2026-07-12-operational-smoke.json`](2026-07-12-operational-smoke.json)

取得日: 2026-07-12

確度: 実行結果は高、model 品質判断は不能

## 実行条件

- Spotter: `1.4.18` development tree
- Codex CLI: `codex-cli 0.144.1`
- fixture schema: `spotter.auditor_model_fixtures.v1`
- fixture SHA-256: `5308c46c6c358d5c04c04463bb15e0ee916bfcfdf1f201e5130d8e10094a33cd`
- profiles: `gpt-5.4-mini × low` / `gpt-5.6-luna × low` / `gpt-5.6-terra × low`
- cases: user input pass/miss、turn end pass/miss の4件
- repeat: 1（計12 run）
- artifact SHA-256: `a2190d6c1b7ed698931d57767deccf8a5bd26c9c9a7f77ba0b0afe03e35feb83`

## 結果

| profile | success | error | schema success | exact match | timeout |
|---|---:|---:|---:|---:|---:|
| baseline | 0 | 4 | 0 | 0 | 0 |
| luna | 0 | 4 | 0 | 0 | 0 |
| terra | 0 | 4 | 0 | 0 | 0 |

全 run は `E_CODEX_CLI_EXIT`、exit code 1。artifact は stdout / stderr 本文を保存せず byte 数だけを
保持する。同条件を追加1回だけ実行し、usage-limit 文言だけを allow-list 抽出して原因を確認した。
原因は Codex CLI の利用枠上限であり、model 固有の失敗ではない。同時に、global
`~/.codex/hooks.json` の旧 Spotter `SessionStart async:true` warning も再現したが、これは skip warning で
あり exit 1 の根因ではない。

初回 artifact は safe-artifact review で絶対 path と dynamic error message の保存余地を検出したため
破棄した。sanitizer 修正と敵対 test 後、同じ matrix を再実行して本ファイルを生成した。保存版は fixture
path が project-relative、project root は非保存、error code / message / diagnostics は allow-list 定型だけで、
絶対 path / raw schema error / stdout / stderr 本文の scan は 0 件。

## 解釈してはいけない値

artifact に p50 / p95 は存在するが、今回は usage-limit error までの時間である。model 推論 latency、品質、
schema 能力、model slug availability の比較には使えない。token / cost も `not-available` である。

## 判断

- `promotionEligible:false` を維持する。
- production default `gpt-5.4-mini × low` を変更しない。
- quota 回復後、同一 fixture / profile / ordering で再実行する。
- schema 100%、baseline 非劣化、latency / timeout / token / cost の合意 SLO を満たすまで昇格しない。
- generic `E_CODEX_CLI_EXIT` から usage-limit を actionable code に分類する改善は、model 昇格とは別 TODO とする。

## 15:39〜15:41 JST の再開結果

同一 fixture の baseline 4件を本番同条件で再試行したが、4件とも `E_CODEX_CLI_EXIT` だった。安全な
追加 probe では `--ignore-user-config` ありの isolated CLI にだけ usage-limit 文言と 16:41 の再試行案内を
確認した。一方、通常 CLI と同フラグだけを除いた auditor probe は成功し、後者は miss case で期待した
`mcp__caveat__caveat_search` を返した。`service_tier="default"` を isolated CLI に明示しても失敗した。

この差は user config のどの設定に由来するか未確定である。`--ignore-user-config` を外すと本番の隔離条件が
変わるため、その結果で保存 artifact を上書きせず、全12件も続行しなかった。isolated CLI の quota 回復を
確認してから、元の条件のまま再実行する。
