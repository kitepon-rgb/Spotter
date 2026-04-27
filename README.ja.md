<p align="center">
  <img src=".github/og.png" alt="Spotter — Audit agent for Claude Code" width="100%">
</p>

# Spotter

[![npm version](https://img.shields.io/npm/v/claude-spotter.svg?style=flat-square)](https://www.npmjs.com/package/claude-spotter)
[![CI](https://github.com/kitepon-rgb/Spotter/actions/workflows/ci.yml/badge.svg)](https://github.com/kitepon-rgb/Spotter/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/node/v/claude-spotter.svg?style=flat-square)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)

**[English](README.md) · 日本語**

> **気づく役と実行する役を分離する。** Claude Code の横で並走し、Bell (主役の Claude) が**ツールを呼び忘れたとき**だけ静かに指摘する監査役。

Claude には「使えるツールがあるのに、使うべきタイミングで使わない」という構造的な弱点があります。現在時刻を推測で答える、`web_search` を呼ばずに古い情報で応答する、`read_file` を使わずにファイルの中身を推測する — **「分からないと自覚できない」から、ツールを取りに行けない**。

Spotter はツールカタログを完全に把握した別エージェント (Claude Haiku 4.5) をセッション毎に常駐させ、Bell の発話予定と応答を並走監査します。見落としを検出すると透明化された指摘として Bell に届け、補正応答を促します。**Bell が自覚して呼ぶ**設計は本プロダクトの存在意義を破壊するため、Bell から呼ぶのではなく hook 経由で Bell の意思と独立に検出する構造を取っています。

## 30 秒で見るポイント

Spotter が拾うのは、たとえばこういう瞬間です。

| 状況 | Bell の応答 | Spotter の指摘 |
|---|---|---|
| 「今日の天気を教えて」 | 推測で答えようとする | `web_search` の使用機会 |
| 「この設定ファイルの中身は？」 | 名前から推測で説明 | `read_file` の使用機会 |
| 「今何時？」 | 学習時点の情報で答える | `current_time` の使用機会 |
| 事実の断定 | 裏付けなしで「〜です」 | 検証用ツールの差し込み余地 |

判定軸は 2 段階:

- **入力時 (`stage=user_input`)**: ユーザー要請に対し、`when_to_use` の条件に明確に該当するツールを列挙する **要請充足チェック**
- **応答後 (`stage=turn_end`)**: Bell の最終応答に対し、事実の断定 / 記録すべき新情報 / 既知情報の参照それぞれに、カタログ上のツール (検証 / 登録 / 照会) を差し込める余地がないかを問う **ツール適用機会の監査**

## インストール

```bash
npm install -g claude-spotter
cd your-project
spotter install
```

`v0.3.0` 以降は**プロジェクト単位の明示的 install** を採用しています (v0.2 までの `postinstall` 自動登録はデーモン増殖の主因だったため撤回)。各プロジェクトの `.claude/settings.json` に hook を登録し、そのプロジェクトでの Claude Code セッションのみで有効になります。

```bash
spotter uninstall        # このプロジェクトの hook 登録を解除
```

## 動作要件

- **Node.js 22.5 以上**
- **Claude Code 2.0 以上**
- **Claude Max プラン** (`claude -p` で Haiku を起動するため)

## アーキテクチャ

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

監査対象のツール (name + description) は `<project>/.spotter/tool-db.json` (ローカル) に格納されます。**daemon が監査に使うのはローカル DB のみ** (v1.2.0 以降) で、グローバル DB `~/.spotter/tool-db.json` は他プロジェクトでの description 再利用キャッシュとしてのみ機能します (live fetch コスト削減のため初回 refresh で参照、結果は local に write-through)。各プロジェクトの local DB は **そのプロジェクトの現時点の discovery 結果と一致** (refresh 時に prune される) ため、過去にインストールしていた MCP / スキル / サブエージェントが他プロジェクトに混入することはありません。

**v1.1.0 以降、`spotter install` が初回 seed を自動実行し、Claude Code セッション起動ごとに SessionStart hook が bg で `spotter db refresh` を走らせる**ため、通常の運用で手動コマンドを叩く必要はありません。収集経路は (1) MCP サーバー: `claude mcp list` で集合を確定し、env / headers は Claude Code 公式 3 スコープ — User (`~/.claude.json` 直下 `mcpServers`) / Project (`<projectRoot>/.mcp.json`) / Local (`~/.claude.json` `projects[<root>].mcpServers`) — を precedence Local > Project > User で merge して取得 (v1.2.1 以降、互換のため legacy `~/.claude/.mcp.json` も最下位で参照)、各サーバーの `tools/list` を JSON-RPC で取得、HTTP/SSE transport にも対応、(2) スキル: user/project/プラグインの SKILL.md frontmatter から `{name, description}` を抽出、(3) サブエージェント: user/project/プラグインの agent .md frontmatter から抽出、(4) claude.ai baseline: OAuth proxy 経由の Gmail/Calendar/Drive 25 件は手書き baseline で補完 (v1.1.4 以降、`claude mcp list` に該当サーバーが存在する環境でのみ注入)。**手書きでツールリストを管理する必要はありません**。

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
spotter db list          # 現在のローカル tool-db (daemon が実際に audit に使う) を表示
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

<details>
<summary><strong>📋 v1.2.0 リリースノート (2026-04-26)</strong></summary>

**当該プロジェクトで使えないツールが提案される回帰を構造的に修正**。daemon が監査に使うカタログを**ローカル DB のみ**に変更し、グローバル DB は他プロジェクトでの description 再利用キャッシュに役割を限定。`resolveAll` 末尾に prune ループ追加で、現プロジェクトの discovery 結果に含まれない既存ローカルエントリを削除 (= 過去の別プロジェクトで discover された MCP / スキル / サブエージェントが居座る経路を遮断)。既 install プロジェクトは npm global update 後、次の SessionStart で自動 refresh が走り、次の次のセッションから幽霊が消える (即時反映は `spotter db refresh` 手動)。v1.1.0 からの柱 (install 時 tool-db 自動構築 + SessionStart での drift 自動追従) は継続。監査対象は v1.0.0 でユーザー追加分 (MCP / スキル / サブエージェント) に絞り込み済み。

詳細は [CHANGELOG](CHANGELOG.md) を参照。

</details>

## ライセンス

MIT — see [LICENSE](LICENSE).
