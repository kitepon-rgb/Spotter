# Terra low / medium verification

出典:

- [`2026-07-12-terra-low-medium-repeat3.json`](2026-07-12-terra-low-medium-repeat3.json)
- [`2026-07-12-terra-medium-repeat3-confirm.json`](2026-07-12-terra-medium-repeat3-confirm.json)

取得日: 2026-07-12

確度: 実行・token usageは高、production昇格はSLO合意待ち

## 条件

- Codex CLI: `codex-cli 0.144.1`
- policy version: `2`
- fixture SHA-256: `5308c46c6c358d5c04c04463bb15e0ee916bfcfdf1f201e5130d8e10094a33cd`
- low / medium比較: 各12 run
- medium再確認: 追加12 run
- low / medium artifact SHA-256: `edcfccc4d176f635304495d33d8beea4147443dcdff262cb83e27f0f6020bf16`
- medium confirmation artifact SHA-256: `82463a095cde1e5062ef804a6412bedae2c10052e233ee9119b27ef012b54bce`

## 結果

| run | exact | FP | FN | p50 | p95 | token observed | total token |
|---|---:|---:|---:|---:|---:|---:|---:|
| Terra low | 11/12 | 0 | 1 | 3254 ms | 4411 ms | 12/12 | 214988 |
| Terra medium（比較） | 12/12 | 0 | 0 | 3781 ms | 4361 ms | 12/12 | 214577 |
| Terra medium（再確認） | 12/12 | 0 | 0 | 3836 ms | 4276 ms | 12/12 | 213391 |

Terra mediumは合計24/24 exact、schema 24/24、FP/FN 0、timeout 0。lowよりp50は約16〜18%遅いが、
p95は同等以下だった。mediumのtotal tokenは2回合計427968で、lowとの比較runではlowより411少ない。
reasoning outputは増えるが、全体tokenを押し上げる結果にはなっていない。

## 判断

- 技術的な昇格候補は `gpt-5.6-terra × medium`。
- `gpt-5.6-terra × low` と `gpt-5.6-luna × low` は品質再現性で劣るため不採用。
- 金額costはChatGPTプラン枠から算出できず、合意SLOも未定義。production変更はこのartifactだけでは行わない。
- production変更時はpolicy versionを別commitで上げ、baseline profile、verifiedAt、README、diagnostics、
  full suite、OS CIを同じ境界で更新する。

