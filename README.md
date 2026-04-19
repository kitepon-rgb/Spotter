# Spotter

> **v0.6.2 released 2026-04-19**. v0.4 で stateless に回帰したが cold-start レイテンシ (毎ターン 30 秒前後の待ち) が運用で問題化したため、v0.5.0 で **session-scoped Haiku を「JSON パース失敗検知 → session renew + silent pass」の事後回復機構付き**で復活。v0.6.0 で **preamble (role + schema + catalog + few-shot) を初回のみ送信** する形 (preamble-once) に変更して `--resume` 経由の resumed 呼び出しが first より遅くなる v0.5.x の逆転現象を解消。v0.6.2 で **親プロセス (Claude Code) の死を 5 秒間隔で検知して daemon を自動 shutdown** する watch を追加し、SessionEnd が発火しない経路 (crash / kill / IDE reload) での孤児 daemon 残存を解消。詳細は [CHANGELOG](CHANGELOG.md)。

**気づく役と実行する役を分離する。** Spotter は Claude Code の横で静かに並走し、Bell (主役の Claude) が**ツールを呼び忘れたとき**に指摘する監査役です。

> Claude には「使えるツールがあるのに、使うべきタイミングで使わない」という構造的な弱点があります。現在時刻を推測で答える、web_search を呼ばずに古い情報で応答する、read_file を使わずにファイルの中身を推測する — 「分からないと自覚できない」から、ツールを取りに行けない。

Spotter は、ツールカタログを完全に把握した別エージェント (Claude Haiku 4.5) をセッション毎にプロセスとして常駐させ、Bell の発話予定と応答を並走監査します。見落としを検出すると、透明化された指摘として Bell に届け、補正応答を促します。Haiku 呼び出しは session-scoped (`--resume`) で同一セッションに再接続して cold-start を削減し、初回のみ preamble を送って以降は per-turn delta だけ送ることで session 肥大化を防ぎます。role collapse (persona drift で JSON 契約破棄) は構造的に予防せず、検知した瞬間に session を切り直して fresh state から再開する事後回復機構で長時間運用に耐えます。

## インストール

```bash
npm install -g claude-spotter
cd your-project
spotter install
```

v0.3.0 以降は**プロジェクト単位の明示的 install** を採用しています (v0.2 までの `postinstall` 自動登録はデーモン増殖の主因だったため撤回)。各プロジェクトの `.claude/settings.json` に hook を登録し、そのプロジェクトでの Claude Code セッションのみで有効になります。

```bash
spotter uninstall        # このプロジェクトの hook 登録を解除
```

## 動作要件

- Node.js **22.5 以上**
- Claude Code **2.0 以上**
- Claude **Max プラン** (`claude -p` で Haiku を起動するため)

## コンセプト

```
User 発話
  ↓
UserPromptSubmit hook → Spotter がカタログと発話を見て一次判定
  ↓
Bell Thinking (Spotter の推奨を additionalContext で受け取る)
  ↓
Bell 最終応答
  ↓
Stop hook → Spotter が応答と使用済みツールを見て最終チェック
  ↓
見落としあれば差し戻し (max 1 回、Claude Code の stop_hook_active で自動担保)
```

`~/.spotter/tool-catalog/tools.yaml` に監査対象のツール用途を記述します。`current_time` / `web_search` / `read_file` / `list_directory` / `run_command` の雛形付き。

## Throughline との関係

[Throughline](https://github.com/kitepon-rgb/Throughline) と Spotter は同じ作者が作った、**哲学を共有する別プロダクト**です。

|  | Throughline | Spotter |
|---|---|---|
| 思想 | 引き算 (要らないものを退避) | 足し算 (足りない動作に気づかせる) |
| 対象 | コンテキスト肥大化 | ツール取りこぼし |
| 仕組み | hook で記憶退避 | hook でサブエージェント並走 |

両者に共通するのは **「主体 (Bell) に頼らない仕組み」**。併用できます。

## よく使うコマンド

```bash
spotter catalog edit     # ツールカタログを $EDITOR で開く
spotter catalog lint     # YAML 検証 + test_cases を Haiku 実呼びで検証
spotter status           # 稼働中の daemon 一覧
spotter doctor           # 環境診断 (Node / claude CLI / カタログ整合性)
spotter uninstall        # hook 登録を解除 (~/.spotter は残す)
```

## 設計ドキュメント

全ての設計判断 — 透明化 vs 不可視化、JSON I/O、socket 抽象、メッセージ契約、SessionStart の readiness 戦略、§0 実装規範 — は [docs/spotter-plan.md](docs/spotter-plan.md) に記載しています。**実装を変更する前に必ず参照してください。**

## 既知の制約

- Stop hook は Bell の最初の応答が**出力された後**に発火するため、Spotter が Stop で差し戻した場合、ユーザーは「最初の応答 + 補正応答」の 2 連続を見ます (Claude Code の hook 仕様による制約)。UserPromptSubmit 段階での先回り検出を精度の軸にしています
- **JSON スキーマ違反は v0.5.0 以降「想定済み異常」として silent pass + session renew で回復**します (role collapse 検知パス、daemon ログに `role_collapse_reset` を残す)。一方 **Haiku timeout は引き続き throw** され、UserPromptSubmit がブロックされてユーザー入力が Bell に届かない症状として顕在化します (timeout は v0.5.0 で 30s に短縮)。timeout の fail-open 化 (pass 扱い) は §0 改訂とセットで今後検討

## ライセンス

MIT — see [LICENSE](LICENSE).
