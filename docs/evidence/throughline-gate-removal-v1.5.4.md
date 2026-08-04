# Throughline監査ゲート撤去 — v1.5.4

- 修正commit: `047cac34780738b794d59d6aae9cb77925a41e63`
- 公開: npm `claude-spotter@1.5.4`、git tag / GitHub Release `v1.5.4`
- 監査入力: Claude / Codexとも現在のユーザー入力とhost-local tool catalogだけを使用する
- Throughline: `observer-read`は提案評価用snapshotの取得だけに使用し、disabled、stale、設定失敗、provider失敗のいずれも監査を止めない
- 旧payload互換: `audit:false`、`context_status`、`recent_context`はdaemonの監査実行可否と入力へ影響しない
- focused test: 166 pass
- full test: 588 tests、586 pass、platform skip 2、fail 0
- CI: GitHub Actions run `30924231511`、macOS / Linux / Windows × Node 22.13 / 22.xの6 jobが成功
- package: `npm pack --dry-run`でversion 1.5.4、90 filesを確認。npm shasum `dd52b9f8ac02f7727ca7b7ac3e20bf798a58347c`
- 配布: Mac、main-server Ubuntu、FOX WSL2、FOX Windows nativeで`spotter 1.5.4`を確認
- 端末診断: CodexのSessionStart / UserPromptSubmit / Stopは各1件、canonical。過去ログの`context_disabled` skipは旧版の履歴として残るが、新版の実行条件には存在しない

評価DBを汚す合成ターンは作成していない。次の実ターンから新しいhook実体が使われる。
