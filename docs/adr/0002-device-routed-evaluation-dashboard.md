# ADR 0002: 評価dashboardは端末routing型のlive viewerとする

## 状態

Accepted — 2026-08-04

## 文脈

Spotterの評価storeは端末内かつproject横断であり、Latticeのproject単位dashboardと同じ
project selectorでは意味が合わない。一方、各端末の会話文脈をcloud databaseへ同期する必要もない。

## 決定

- 公開viewerの第一階層は端末とし、projectは選択端末内のfilterとする。
- 各端末のdevice serverがlocal evaluation storeをrequest時に読む。
- main-serverのhubは端末一覧とpath routingだけを所有し、評価データを保存しない。
- 端末間接続はLattice配備で実証済みのSSH reverse tunnelを使う。
- 外部境界はCloudflare Accessで制限し、製品内へaccount、token同期、独自認証DBを追加しない。
- 到達確認は端末一覧request時だけ行い、background監視・回収・retry機構は作らない。

## 帰結

端末がofflineならその端末だけがunavailableとなり、他端末の集計は表示できる。評価DBは端末外へ
複製されず、公開面はlive viewerとしてだけ機能する。
