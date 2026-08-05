# Spotter端末横断Web dashboard実装計画

状態: **実装・公開・4端末配布完了**。現行npm配布版は`claude-spotter@1.5.7`。

## 目的

`https://spotter.kitepon.dev/`でSpotterを利用している端末を選び、選択端末の
提案率・tool採用率・project別内訳・非採用case詳細を、各端末の
`~/.spotter/evaluation.db`から表示する。

工程状態と依存関係の正本はLattice plan `spotter-device-dashboard`とし、本書は思想、
設計判断、非目標、受入条件だけを持つ。

## 設計

Lattice dashboardと同じく、評価データはcloudへ同期しない。各端末でloopbackの
Spotter device serverを動かし、SSH reverse tunnelでmain-serverへ届ける。
main-serverのSpotter hubは端末一覧を表示し、`/devices/<device-id>/`以下を対応する
device serverへproxyする。Caddyと既存Cloudflare Tunnelはhubだけを公開する。

```text
browser
  -> Cloudflare Access
  -> Cloudflare Tunnel
  -> Caddy
  -> Spotter hub (main-server)
       -> main-server device server
       -> Mac reverse tunnel -> Mac device server
       -> FOX WSL2 reverse tunnel -> WSL2 device server
       -> FOX Windows reverse tunnel -> Windows device server
```

device serverはrequestごとに既存EvaluationStoreをreadし、HTMLをserver-side renderする。
hubのonline表示は端末一覧request時のhealth取得だけで決め、background monitorや同期workerを
作らない。UIは依存なしのHTML/CSSとし、project・期間filterはGET queryで扱う。

## 表示面

- 端末一覧: Mac、main-server、FOX WSL2、FOX Windows nativeと到達状態
- 端末概要: 対象ターン、ツール提案あり、提案ツール数、利用判定済み、実際に使用、判定不能
- 提案率は「ツール提案あり ÷ 対象ターン」、採用率は「実際に使用 ÷ 利用判定済み」と表示する
- project別内訳とtool別内訳
- 非採用case一覧
- case詳細: request、監査履歴なしを示す互換欄、任意のThroughline評価文脈、提案ID、利用ID、item結果

## 役割分解

- F: 公開URL、端末routing、Cloudflare Access、Caddy/Tunnel、release・4端末配布を親が裁定する。
- A: dashboard projection、HTML renderer、device/hub server、CLI、focused testは非交差scopeへ分ける。
- H: 既存Cloudflare/Caddy/端末serviceへの本番反映は、ownerが明示した本依頼の公開範囲で親が実行する。

## 非目標

- 評価DBのcloud同期・複製
- dashboard用DBやaccount system
- background health monitor、retry queue、reconciler、内部logicの常時validator
- Lattice本体の変更
- 集計式または既存hook lifecycleの変更

## 既知の罠

- `spotter.kitepon.dev`は会話文脈を表示するため、Latticeの公開工程表と違いCloudflare Accessを外部境界に置く。
- reverse tunnelのremote portは端末ごとに固定し、device serverは各端末のloopbackだけへbindする。
- Windows nativeはPowerShell/Task Scheduler経路を使い、POSIX専用service定義を流用しない。
- Lattice `todo done --evidence`にはrepo相対のdescriptor JSONを渡す。絶対pathは使わない。

## 受入条件

1. fixture DBで率、project内訳、非採用case、requestと任意のThroughline評価文脈がHTMLに正しく表示される。
2. hubで4端末を選択でき、offline端末は一覧で到達不能と分かる。
3. Macとmain-serverの実DBを公開URLから端末別に閲覧できる。
4. FOX WSL2とFOX Windows nativeは導入・tunnel設定後、online時は実DBを表示し、offline時はhub全体を壊さない。
5. `spotter.kitepon.dev`はCloudflare Access通過後にHTTPS 200、未認証requestはAccessへ送られる。
6. focused test、関連test、OS CI、npm package smokeがgreenである。
7. npm、GitHub tag/Release、4端末のglobal install、常駐service反映まで完了する。
