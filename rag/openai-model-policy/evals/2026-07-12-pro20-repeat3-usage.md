# Auditor model matrix — Pro20 repeat=3 with token usage

> 当時の実測記録。本文の「昇格判断は未完了」は実行時点の状態であり、その後Terra mediumをproduction採用した。

出典: [`2026-07-12-pro20-repeat3-usage.json`](2026-07-12-pro20-repeat3-usage.json)

取得日: 2026-07-12

確度: 実行・token usageは高、production昇格判断は未完了

## 実行条件

- Spotter: `1.4.18` development tree（Codex JSONL usage抽出版）
- Codex CLI: `codex-cli 0.144.1`
- fixture SHA-256: `5308c46c6c358d5c04c04463bb15e0ee916bfcfdf1f201e5130d8e10094a33cd`
- profiles: baseline / Luna low / Terra low
- repeat: 3（計36 run、`case → repeat → profile` 順）
- artifact SHA-256: `e343749f331200f1b17eda364e4e1bcbe6edd0401812de93673ef330f495e6e3`

## 品質・latency

| profile | schema | exact | FP | FN | p50 | p95 |
|---|---:|---:|---:|---:|---:|---:|
| baseline | 12/12 | 8/12 | 2 | 2 | 5232 ms | 6770 ms |
| luna | 12/12 | 9/12 | 3 | 0 | 4323 ms | 8115 ms |
| terra | 12/12 | 11/12 | 0 | 1 | 3491 ms | 4396 ms |

Terra lowは今回も最良だが、`user-input-miss` を1回見逃した。直前のrepeat=3と合算するとTerraは
23/24 exact、baselineは18/24、Lunaは17/24。Terraの優位は維持されたが、lowが完全合格という判断は撤回し、
正本の条件どおりTerra mediumを追加評価する。

## Token usage

Codex CLIのJSONL `turn.completed.usage` を全36 runで取得できた。artifactは本文やraw JSONLを保存せず、
正規化したtoken数だけを保持する。

| profile | observed | input | cached input | output | reasoning output | total | total/run p50 | p95 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| baseline | 12/12 | 192020 | 139776 | 1979 | 1410 | 193999 | 15888 | 17784 |
| luna | 12/12 | 202204 | 130816 | 1248 | 563 | 203452 | 16667 | 18582 |
| terra | 12/12 | 212688 | 102912 | 447 | 0 | 213135 | 17753 | 17815 |

`totalTokens` はCodexが返すinputとoutputの和で、cached inputを二重加算しない。ChatGPTプラン利用の
Codex CLIにはこのartifactから対応する金額を算出できないため、API価格を代入せず
`costStatus:not-available-chatgpt-plan` とする。

## 判断

- token usage取得のblockerは解消した。
- Terra lowは現時点の第一候補だがexact 100%ではなく、medium比較が必要。
- 金額costと合意SLOは未解決。production `gpt-5.4-mini × low` と`promotionEligible:false`を維持する。
