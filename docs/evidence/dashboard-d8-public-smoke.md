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
