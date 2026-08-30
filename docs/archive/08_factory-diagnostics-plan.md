# Factory diagnostics — 完了済み実装記録

Status: **complete**。`spotter diagnostics factory`とopt-in local runtime error storeは
v1.4.23で公開済み。runtime error storeの詳細な完了記録は
[`BUGHUB_RUNTIME_ERROR_STORE_PLAN.md`](BUGHUB_RUNTIME_ERROR_STORE_PLAN.md)を参照する。

## 契約

- `spotter diagnostics factory` はread-onlyの単一行JSON snapshotを返す。
- exit 0はsnapshot JSONを生成できたことを表し、各診断の合否は`overall_status`と`checks`で判定する。
- 引数違反はexit 2。生path、marker/catalog内容、prompt/session、token、log、envは返さない。
- marker不在だけを`not_applicable`とし、破損・読取不能を対象外へ丸めない。

## 完了項目

- [x] 既存doctorのcontext inspectorとtool DB validatorを再利用する。
- [x] JSON-only factory diagnostics subcommandを追加する。
- [x] marker/catalogの不在・破損とprivacy attack fixtureを固定する。
- [x] CLIの有限語彙とexit codeの意味を固定する。
- [x] full test gateを再実行する。
