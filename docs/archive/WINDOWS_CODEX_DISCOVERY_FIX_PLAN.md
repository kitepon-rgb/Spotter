# Windows Codex CLI実行経路修正計画

## 目的

Windowsで`codex.cmd`がPowerShellから利用可能でも、Nodeの直接spawnがnpm shimを解決できず、
SpotterがCodexを未導入扱いする欠陥を直す。install時の検出だけでなく、doctorとCodex CLI
auditor本体も同じWindows実行契約へ揃え、「生成は成功するがhook実行は失敗する」半端な修正を防ぐ。

## TODO

- [x] FOX Windows nativeで外側の`codex --version`成功とSpotter内検出失敗を再現する。
- [x] Windowsでは`cmd.exe /c codex --version`、POSIXでは従来の直接spawnを使う。
- [x] 両platformのcommand/args/exit判定をfixtureで固定する。
- [x] `spotter doctor`のCodex診断を同じWindows実行契約へ揃える。
- [x] Codex hook / factory diagnosticsの`codex features list`も同じWindows実行契約へ揃える。
- [x] Codex CLI auditorのspawnを同じWindows実行契約へ揃え、stdin・timeout・exit診断を維持する。
- [x] npm shimのNode entrypointを安全に解決し、`cmd.exe`によるproject path再解釈を監査経路から除く。
- [x] Windows shim経由のtimeoutはtree終了完了を待ち、失敗を別codeでfail-loudにする。
- [x] full test、pack smoke、Windows実機のinstall/diagnostics/verifyを通す。
- [x] patch releaseを公開し、計画を`docs/archive/`へ退避する。

## rollback

変更commitをrevertし、直前npm版へ明示再installする。Windows側で生成済みのCodex hooksとcatalogは
Spotter所有の正規生成物なので、rollback時も無断削除しない。
