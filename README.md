# Spotter

> **v1.1.4 released 2026-04-20**. **MCP 投資経路の 2 件の silent mismatch を修正**。(1) `claude mcp list / get` spawn 時の `cwd: projectRoot` 未指定、(2) claude.ai baseline (Gmail/Calendar/Drive 25 件) の無条件注入 — `claude mcp list` の実在確認を入れ、隔離 `CLAUDE_CONFIG_DIR` / 未連携環境で最大 25 件の幻ツールが catalog に残っていた状態を解消 (Bell 側実環境で 25 件消失を実測確認済み)。v1.1.0 からの柱 (install 時 tool-db 自動構築 + SessionStart での drift 自動追従) は継続、手動 `spotter db refresh` は通常不要。監査対象は v1.0.0 でユーザー追加分 (MCP / スキル / サブエージェント) に絞り込み済み、本プロジェクトでの実測で 268 件 resolved (MCP 40 + skills 181 + agents/bare 47)。設計思想は [docs/catalog-design.md](docs/catalog-design.md)、変更詳細は [CHANGELOG](CHANGELOG.md)。

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

監査対象のツール (name + description) は `~/.spotter/tool-db.json` (グローバル) と `<project>/.spotter/tool-db.json` (ローカル) に格納されます。**v1.1.0 以降、`spotter install` が初回 seed を自動実行し、Claude Code セッション起動ごとに SessionStart hook が bg で `spotter db refresh` を走らせる**ため、通常の運用で手動コマンドを叩く必要はありません。収集経路は (1) MCP サーバー: user/project scope の `.mcp.json` + `claude mcp list` で列挙、各サーバーの `tools/list` を JSON-RPC で取得、HTTP/SSE transport にも対応、(2) スキル: user/project/プラグインの SKILL.md frontmatter から `{name, description}` を抽出、(3) サブエージェント: user/project/プラグインの agent .md frontmatter から抽出、(4) claude.ai baseline: OAuth proxy 経由の Gmail/Calendar/Drive 25 件は手書き baseline で補完 (v1.1.4 以降、`claude mcp list` に該当サーバーが存在する環境でのみ注入)。**手書きでツールリストを管理する必要はありません**。

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
spotter db list          # 現在の tool-db (local + global merged) を表示
spotter db refresh       # MCP / スキル / サブエージェントから description を収集して DB 更新
                         # (v1.1.0 以降、install 時と SessionStart 時に自動実行されるので通常は不要)
spotter db rebuild       # local + global DB を両方消してから refresh (カタログ設計変更時のクリーン用)
spotter status           # 稼働中の daemon 一覧
spotter doctor           # 環境診断 (Node / claude CLI / tool-db 整合性)
spotter uninstall        # hook 登録を解除 (~/.spotter は残す)
```

## 設計ドキュメント

- **現行設計 (カタログ / 収集経路 / 分類軸)**: [docs/catalog-design.md](docs/catalog-design.md) — v1.0.0 以降の真実源
- **現時点で塞がっていない穴 + 実測未検証の懸念**: [docs/open-issues.md](docs/open-issues.md) — 新規作業に入る前に必読
- **実装規範と不変条件 (§0)**: [CLAUDE.md](CLAUDE.md) — フォールバック禁止 / silent fallback 禁止 / 暫定コード禁止
- **歴史記録 (v0.1 時点の設計議事録)**: [docs/spotter-plan.md](docs/spotter-plan.md) — 作成時点で固定された議論過程のスナップショット、現行設計は上記 3 点を参照

## 既知の制約

- Stop hook は Bell の最初の応答が**出力された後**に発火するため、Spotter が Stop で差し戻した場合、ユーザーは「最初の応答 + 補正応答」の 2 連続を見ます (Claude Code の hook 仕様による制約)。UserPromptSubmit 段階での先回り検出を精度の軸にしています
- **JSON スキーマ違反は v0.5.0 以降「想定済み異常」として silent pass + session renew で回復**します (role collapse 検知パス、daemon ログに `role_collapse_reset` を残す)。一方 **Haiku timeout は引き続き throw** され、UserPromptSubmit がブロックされてユーザー入力が Bell に届かない症状として顕在化します (timeout は v0.5.0 で 30s、v0.13.1 で 45s に拡張)。timeout の fail-open 化 (pass 扱い) は §0 改訂とセットで今後検討

## ライセンス

MIT — see [LICENSE](LICENSE).
