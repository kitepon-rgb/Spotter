# Spotter dashboard 公開smoke — 2026-08-04

- 公開版: `claude-spotter@1.5.2`、tag `v1.5.2`、release commit `17baa3e`
- CI: GitHub Actions run `30919882717`。macOS / Linux / Windows × Node 22.13 / 22.x の6 jobが成功
- 配布: Mac、main-server Ubuntu、FOX WSL2、FOX Windows nativeで`spotter 1.5.2`を確認
- device upstream: main-server=`main-server`、53941=`mac`、53942=`fox-wsl`、53943=`fox-windows`
- hub: 4端末すべてonline。端末選択画面と、選択後に端末一覧へ戻る導線を確認
- 実データ: Macで`S=4 P=4 I=4 C=2 A=1 M=2`、提案率100% (4/4)、採用率50% (1/2)
- 内訳: project別、tool別、実際の非採用case 1件を表示
- case詳細: request、auditorへ渡したcontext、Throughline observer snapshot、提案ID、利用ID、item結果を別欄で表示
- Caddy origin: `spotter.kitepon.dev`を直接解決してHTTP 200、4端末onlineを確認
- Cloudflare: tunnel ingressはcatch-all 404より前、DNSは同tunnelへのproxied CNAME、Accessはhostname全体をowner email allowに設定
- 公開外形: 未認証`https://spotter.kitepon.dev/`はCloudflare Access loginへHTTP 302
- ブラウザ: hubと同じorigin HTMLをChromeで表示し、端末一覧、実集計、内訳、非採用case、case詳細のDOMとレイアウトを確認

評価SQLiteの複製、background monitor、retry queue、reconcilerは追加していない。

## v1.5.3 指標名修正の再受入

- 公開版: `claude-spotter@1.5.3`、tag / GitHub Release `v1.5.3`、release commit `fae7e5a`
- CI: GitHub Actions run `30921200287`のmacOS / Linux / Windows × Node 22.13 / 22.xの6 jobが成功
- 配布: Mac、main-server、FOX WSL2、FOX Windows nativeで`spotter 1.5.3`を確認し、各device serviceを再起動
- device upstream: 53940–53943の4端末がすべてhealth 200、device IDも設定と一致
- 実HTML: 4端末すべてで「対象ターン」「ツール提案あり」「提案ツール数」
  「利用判定済み」「実際に使用」「判定不能」と、2種類の率の日本語分子/分母を確認
- 旧表示: cardの`S/P/I/C/A/M`と率の`P/S`・`A/C`は4端末のHTMLに残っていない
- Windows: 旧device child processがTask停止後も残り新起動がport競合していたため、旧PIDだけを停止し、
  Scheduled Taskからv1.5.3を再起動して稼働HTMLを再確認
- 公開外形: 未認証`https://spotter.kitepon.dev/`はCloudflare Access loginへHTTP 302。
  Caddy / Tunnel / Accessは変更せず、既存の認証済み200証跡とhub originの実HTMLを継続使用
