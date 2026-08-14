# Spotter評価dashboard運用

現行npm配布版: **v1.5.10**（2026-08-14）。v1.5.10は非Claude Hook入力の副作用前no-op releaseであり、
dashboard routing構成はv1.5.3から変更していない。

この文書はservice設定の正本であり、各端末に現在installされているnpm versionの台帳ではない。
端末versionは対象端末で`spotter --version`を実行して確認する。

## 固定構成

各端末のdevice serverはloopbackだけで待ち受ける。main-server、Mac、FOX WSL2は
`127.0.0.1:53940`、FOX Windows nativeはWSL2 localhost relayとの衝突を避けて
`127.0.0.1:53944`を使う。main-serverのhubは
Docker Caddyから到達できる`172.18.0.1:53940`で待ち受ける。評価DBは各端末の
`~/.spotter/evaluation.db`をその場で読み、端末外へ複製しない。

| 端末 | device ID | main-server側upstream |
|---|---|---|
| main-server Ubuntu | `main-server` | `127.0.0.1:53940` |
| Mac | `mac` | `127.0.0.1:53941` |
| FOX WSL2 | `fox-wsl` | `127.0.0.1:53942` |
| FOX Windows native | `fox-windows` | `127.0.0.1:53943` |

hub設定の正本は`ops/dashboard/hub-config.json`である。hubは一覧request時に各upstreamの
healthを1回だけ確認し、端末をonline/offline表示する。常時監視、再試行queue、DB同期は行わない。

## Mac

`ops/dashboard/launchd/`の2 plistを`~/Library/LaunchAgents/`へ配置する。既存labelを更新する時は
`launchctl bootout gui/$(id -u) <plist>`の後、`launchctl bootstrap gui/$(id -u) <plist>`を実行する。
deviceはMac実DB、tunnelはmain-serverの`53941`へ接続する。

確認:

```sh
curl --fail http://127.0.0.1:53940/_spotter/health
ssh main-server curl --fail http://127.0.0.1:53941/_spotter/health
```

## main-server Ubuntu

`ops/dashboard/systemd/spotter-dashboard-device.service`と
`spotter-dashboard-hub.service`を`~/.config/systemd/user/`へ配置する。
`~/.config/spotter/dashboard-device.env`は次の2行、hub configはrepo正本をコピーする。

```ini
SPOTTER_DEVICE_ID=main-server
SPOTTER_DEVICE_NAME=main-server
```

device envと同じPATHを`~/.config/spotter/dashboard-hub.env`にも置く。main-serverの例:

```ini
PATH=/home/kite/.nvm/versions/node/v24.14.1/bin:/usr/local/bin:/usr/bin:/bin
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now spotter-dashboard-device.service spotter-dashboard-hub.service
curl --fail http://127.0.0.1:53940/_spotter/health
curl --fail http://172.18.0.1:53940/
```

device envにも同じPATH行を置く。値は各端末で実測したnpm binを使い、別の起動経路へfallbackしない。

## FOX WSL2

device unitとtunnel unitを`~/.config/systemd/user/`へ配置する。device env:

```ini
SPOTTER_DEVICE_ID=fox-wsl
SPOTTER_DEVICE_NAME=FOX-WSL2
```

tunnel env:

```ini
SPOTTER_REMOTE_FORWARD=127.0.0.1:53942:127.0.0.1:53940
SPOTTER_TUNNEL_TARGET=main-server
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now spotter-dashboard-device.service spotter-dashboard-tunnel.service
```

## FOX Windows native

管理者権限は不要。`ops/dashboard/windows/`を固定pathへ配置し、Windows側から解決できる
main-serverのSSH host名またはIPを明示して次を1回実行する。

```powershell
.\install-dashboard-tasks.ps1 -MainServer '<main-server-host-or-ip>'
```

登録される2 taskはログオン時にdevice serverとreverse tunnelを起動する。確認:

```powershell
Invoke-RestMethod http://127.0.0.1:53944/_spotter/health
Get-ScheduledTask -TaskName 'Spotter dashboard *' | Get-ScheduledTaskInfo
```

## 公開経路

Caddyへ次を追加する。`spotter.kitepon.dev`はcase詳細に会話文脈を含むため、Cloudflare側では
同hostname全体をAccess applicationの対象にし、owner emailだけをallowする。

```caddyfile
spotter.kitepon.dev {
  import cf-origin-tls
  import security-headers-base
  reverse_proxy 172.18.0.1:53940
}
```

既存Cloudflare Tunnelのcatch-all 404より前に、hostname `spotter.kitepon.dev`、service
`https://caddy:443`、`noTLSVerify: true`、`matchSNItoHost: true`のingressを追加する。
DNSは同tunnel UUIDの`cfargotunnel.com`へCNAMEする。

## 受入と切り分け

確認順序はdevice loopback、main-serverの各upstream、hub、Caddy、Cloudflare Tunnel、Accessとする。
端末がofflineならhub一覧のその端末だけがofflineになる。選択時の502は該当upstreamのserviceまたは
reverse tunnelを確認する。hubや別端末を再起動する必要はない。

公開受入:

1. 未認証`https://spotter.kitepon.dev/`がCloudflare Accessへredirectされる。
2. 認証後の`/`が4端末を表示する。
3. online端末のoverview、project/tool内訳、非採用case、case詳細を表示できる。
4. 1端末を停止しても一覧と他端末が表示でき、停止端末だけoffline/502になる。
