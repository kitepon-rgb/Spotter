# Windows dashboard hidden起動 — v1.5.11実測

> 2026-08-15のFOX Windows nativeにおける点時点の配布・runtime証拠。
> 現在の端末online状態やinstall versionを表す台帳ではない。

- 公開版: `claude-spotter@1.5.11`、tag / GitHub Release `v1.5.11`、release commit
  `bd2f8a865b4674bf44258d71a07590a658c7c328`
- CI: GitHub Actions run `31834856969`。macOS native、Linux native、Windows native、WSL2が成功
- 配布: npm registryからglobal installし、`spotter 1.5.11`を確認
- task定義: `Spotter dashboard device`と`Spotter dashboard tunnel`のPowerShell actionに
  `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass`を確認
- user契約: 両taskのprincipalは`Interactive`を維持し、npm shimとSSH設定をFOXの
  ユーザープロファイルから読む
- device runtime: taskは`Running` / result `267009`、
  `http://127.0.0.1:53944/_spotter/health`は`{"ok":true,"deviceId":"fox-windows"}`
- window実測: deviceの`powershell.exe`、`cmd.exe`、`node.exe`はいずれも
  `MainWindowHandle = 0`
- tunnel runtime: hidden actionへの更新は確認したが、この時点では既存SSH接続側のresult `255`で
  `Ready`。tunnel疎通の成功証拠には数えない
- reboot境界: Windows自体の再起動は行わず、更新したAtLogOn taskの手動起動でhidden actionと
  runtime processを検証した

## 更新時の切り分け

既存taskのACLは`BUILTIN\Administrators`所有で、通常PowerShellからの上書きは
`Access is denied`になった。同じinstallerを昇格PowerShellから実行し、task定義を更新した。
これは常時のRunLevelを上げる変更ではなく、更新操作だけの権限である。

task停止後も旧deviceの`node.exe`が残り53944を保持したため、新taskはresult `2`で終了していた。
listener PIDのcommand lineが`claude-spotter ... dashboard device --port 53944`であることを確認して
その旧PIDだけを停止し、新しいtaskを起動した。再起動後はtaskの`Running`、healthのdevice ID、
3 processの`MainWindowHandle = 0`を再確認した。
