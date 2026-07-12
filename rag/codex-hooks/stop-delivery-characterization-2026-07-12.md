# Codex Stop delivery characterization — 2026-07-12

- 出典: Codex CLI 0.144.1 isolated実測、Codex App task/app-server実測、公式Hook仕様スナップショット
- 取得日: 2026-07-12
- 確度: 高（CLI）、高（App background/app-serverでStop未発火）、中（active Appのblockは未注入）
- 構造化artifact: [`evals/2026-07-12-stop-delivery.json`](evals/2026-07-12-stop-delivery.json)

## 結果

isolated projectで同じ最終回答 `FIRST` に対し、Stop出力だけを変えた。

| 出力 | CLI JSONL / Hook入力 | 結果 |
|---|---|---|
| `{}`（現行pending相当の無介入） | Stop 1回、`stop_hook_active:false` | `FIRST`で終了 |
| `systemMessage` | Stop 1回、`stop_hook_active:false` | `FIRST`で終了。`codex exec --json`にはmessageが現れない |
| `decision:"block"` + `reason` | 同一session/turnでStop 2回。false → true | `FIRST`の後に`SECOND`を返し、2回目は継続しない |

CLIでは現行仕様どおり綺麗なmax-1 continuationになった。`transcript_path`は`codex exec`ではnullだが、
JSONLには2つのagent messageが順に出る。

Codex App connectorで作ったbackground taskと、handoff skillのapp-server taskはいずれも
`SessionStart` / `UserPromptSubmit`を実行して正常終了したが、Stop hookを実行しなかった。
一時追加したprobeもSpotter Stop eventも0件だった。global hooksは事前tar backupを作り、実験後に
SHA-256 `bd46677c7228f0ca49c562cdc7e12007c99bfa0ad4240bfee1a7af41d50067a0`へ完全復元した。

active Codex App taskでは既存ログからStop発火を確認できるが、進行中task自身へblock probeを注入すると
作業turnを改変するため実施していない。したがってactive Appのmax-1をCLI結果だけで断定しない。

## 製品判断

background/app-serverではStop自体が発火しないため、immediate blockもpending queueも生成できない。
`systemMessage`はmachine-readableな結果へ現れず、finding配送には弱い。Stopが発火したsurfaceでは
現行pendingが次のsame-session UserPromptSubmitへ明示的に配送され、既存contractとも一致する。

よってv1.4.18ではpendingを維持する。根拠はactive Appのblock continuationが未確認であることと、
復旧releaseで既存delivery contractを変更しないことにある。
将来の変更条件は、active Appでmax-1を再現し、background/app-serverのStop非発火が仕様化または解消され、
既存pendingとのUI差をownerが個別承認すること。
