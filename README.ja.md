<p align="center">
  <img src=".github/og.png" alt="Spotter — Audit agent for Claude Code" width="100%">
</p>

# Spotter

[![npm version](https://img.shields.io/npm/v/claude-spotter.svg?style=flat-square)](https://www.npmjs.com/package/claude-spotter)
[![CI](https://github.com/kitepon-rgb/Spotter/actions/workflows/ci.yml/badge.svg)](https://github.com/kitepon-rgb/Spotter/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/node/v/claude-spotter.svg?style=flat-square)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)

**[English](README.md) · 日本語**

> **気づく役と実行する役を分離する。** Claude Code の横で並走し、主役の Claude が**ツールを呼び忘れたとき**だけ静かに指摘する監査役。

Claude には「使えるツールがあるのに、使うべきタイミングで使わない」という構造的な弱点があります。記録すべき決定を memory / caveat MCP に残さない、docs lookup MCP を呼ばずに古い知識で応答する、ブラウザ自動化 MCP で確認せず UI 状態を推測する — **「分からないと自覚できない」から、ツールを取りに行けない**。

Spotter はツールカタログを完全に把握した別の監査エージェントで、ユーザー入力と主役 AI の応答を並走監査します。自動選択では Claude host は Codex CLI があればそれを、なければ session-scoped Haiku を選び、Codex host は Codex CLI を既定にします。明示 backend override は host より優先しますが、runtime failure で別 backend へ黙って切り替えません。見落としは透明化された指摘として次に利用できる文脈へ届けます。**主役 AI が自覚して自己監査する**設計は本プロダクトの存在意義を破壊するため、hook 経由でその意思と独立に検出します。

<p align="center">
  <img src=".github/concept.svg" alt="Claude が答え、Spotter が見ている" width="80%">
</p>

<p align="center">
  <sub><b>Claude</b> が答える（実行する役） &nbsp;·&nbsp; <b>Spotter</b> が見ている（気づく役・沈黙監査）</sub>
</p>

## 30 秒で見るポイント

Spotter が拾うのは、たとえばこういう瞬間です。

| 状況 | Claude の応答 | Spotter の指摘 |
|---|---|---|
| 「この OAuth の落とし穴を覚えて」 | 了解だけして進める | memory / caveat MCP の使用機会 |
| 「このパッケージの最新版 API は？」 | 学習時点の知識で答える | docs lookup MCP の照会機会 |
| 「この危ない patch をレビューして」 | 自分だけで見直す | reviewer sub-agent の使用機会 |
| 事実の断定 | 裏付けなしで「〜です」 | 検証用ツールの差し込み余地 |
| 「この UI 今もちゃんと動く？」 | コード読みだけで結論 | ブラウザ自動化 MCP の使用機会 |
| 「以前何を決めたっけ？」 | 推測 / 失念のまま回答 | メモリ / ノート系 MCP の照会機会 |

判定軸は 2 段階:

- **入力時 (`stage=user_input`)**: ユーザー要請に対し、ローカルカタログの description から用途が明確に該当するツールを列挙する **要請充足チェック**
- **応答後 (`stage=turn_end`)**: Claude の最終応答に対し、事実の断定 / 記録すべき新情報 / 既知情報の参照それぞれに、カタログ上のツール (検証 / 登録 / 照会) を差し込める余地がないかを問う **ツール適用機会の監査**

## インストール

```bash
npm install -g claude-spotter
cd your-project
spotter install
```

macOS の Homebrew Node 環境では、Codex hook command の Node パスに現在の実体と一致する
安定 symlink (`/opt/homebrew/bin/node`) を使います。
`/opt/homebrew/Cellar/node/<version>/...` のような version 固定パスを書かないため、
Homebrew で Node が更新されても Codex hook が古い Node パスに取り残されません。

`v0.3.0` 以降は**プロジェクト単位の明示的 install** を採用しています (v0.2 までの `postinstall` 自動登録はデーモン増殖の主因だったため撤回)。各プロジェクトの `.claude/settings.json` に hook を登録し、そのプロジェクトでの Claude Code セッションのみで有効になります。
Codex CLI が使える環境では、同じ `spotter install` が user-level の Codex native hooks も登録します。実際に動くプロジェクトは `spotter install` が作る `.spotter/marker.json` で制限されるため、無関係な Codex セッションでは Spotter は起動しません。
Codex 側では現行の `[features].hooks = true` を有効化し、互換のため旧 `codex_hooks` diagnostics output も認識します。
Spotter が所有する Codex handler は現行の同期 command schema で生成します。install / upgrade 後は `/hooks` で review して新しい Codex session を開いてください。`spotter codex-hook diagnostics` は登録と readiness を診断しますが、trust を内部状態から推測しません。

Spotter を upgrade した後、release note で hook 設定変更が案内されている場合は、各 install 済みプロジェクトで `spotter install` を再実行してください。global package update でコード経路は変わりますが、既存 `.claude/settings.json` の timeout 値は自動では書き換わりません。

```bash
spotter uninstall        # このプロジェクトの hook 登録を解除
```

リリース時の npm install smoke:

```bash
npm uninstall -g claude-spotter
npm install -g claude-spotter
spotter --version
spotter install -y
spotter codex-hook install
```

## 動作要件

- **Node.js 22.5 以上**
- **Claude Code 2.0 以上**
- **Codex CLI**。Codex native hooks の既定 backend と Claude host の優先 auditor path で使います。自動選択後の runtime failure で Haiku へ fallback しません
- **Claude Max プラン**は Claude host が Haiku path を選ぶ場合だけ必要です（Codex CLI 不在、または `SPOTTER_AUDITOR_BACKEND=haiku` 明示時）

## アーキテクチャ

### 1 ターンの監査フロー

Claude Code と Codex では `Stop` の受け口が違います。下の図は Claude host の流れです。
Codex native `Stop` は遅延配送で、不足ツールの指摘を queue し、次の same-session
`UserPromptSubmit` で提示します。

```mermaid
flowchart TD
    U([User 発話]) --> UPH[UserPromptSubmit hook<br/>Spotter が発話とカタログから一次判定]
    UPH --> BT[Claude Thinking<br/>Spotter の推奨を<br/>additionalContext で受信]
    BT --> BA([Claude の最初の応答])
    BA --> SH[Stop hook<br/>応答と使用済みツールから最終チェック]
    SH --> DEC{見落とし<br/>あり?}
    DEC -->|なし| DONE([完了])
    DEC -->|あり| SB[.spotter/pending/ に積む<br/>v1.4.8 deferred delivery]
    SB --> NEXT([次の UserPromptSubmit で<br/>additionalContext として配信])
```

### カタログの収集経路

```mermaid
flowchart LR
    subgraph SRC[収集ソース]
      direction TB
      MCP[MCP サーバー<br/>claude mcp list で列挙]
      SK[スキル<br/>SKILL.md frontmatter]
      AG[サブエージェント<br/>agent .md frontmatter]
      BL[claude.ai baseline<br/>Gmail / Calendar / Drive<br/>存在時のみ注入]
    end
    subgraph SCOPES["MCP の env / headers — 4 スコープ、上位が衝突に勝つ"]
      direction TB
      L["Local — projects.&lt;root&gt;.mcpServers in ~/.claude.json"]
      P["Project — &lt;root&gt;/.mcp.json"]
      US["User — mcpServers in ~/.claude.json"]
      LG["Legacy — ~/.claude/.mcp.json"]
    end
    SCOPES -. merge .-> MCP
    MCP --> DB[(ホスト別ローカル tool-db<br/>name + description<br/>プロジェクト単位)]
    SK --> DB
    AG --> DB
    BL --> DB
    DB --> H[独立 auditor<br/>Codex CLI があれば優先<br/>なければ session-scoped Haiku]
```

監査対象のツール (name + description) は host-local に分離されます。Claude は `<project>/.spotter/tool-db.json`、Codex は `<project>/.spotter/tool-db.codex.json` を使います。**daemon が監査に使うのは Claude local DB のみ**で、Codex native hooks は Codex local DB を読みます。グローバル description cache も host ごとに分離され、Claude は `~/.spotter/tool-db.json`、Codex は `~/.spotter/tool-db.codex.json` を使います。これらは同じ host の他プロジェクト間でだけ再利用され、監査入力には混ぜません。各 host-local DB は **その host の現時点の discovery 結果と一致** (refresh 時に prune される) するため、別プロジェクトや別 host のツールリストで上書きされることはありません。

**`spotter install` が Claude catalog の初回 seed を自動実行し、Claude Code セッション起動ごとに SessionStart hook が bg で `spotter db refresh` を走らせる**ため、Claude 通常運用で手動コマンドを叩く必要はありません。Codex CLI が使える環境では、同じ `spotter install` が Codex native hooks も登録し、`.spotter/tool-db.codex.json` も同期 seed します。これにより初回 Codex セッションから catalog を読めます。以降の Codex `SessionStart` hook は `spotter db refresh --host-agent codex` を bg 起動して `.spotter/tool-db.codex.json` を更新します。Claude catalog には書き込みません。Claude discovery は `claude mcp list` と Claude skills / sub-agents、Codex discovery は `codex mcp list/get` と Codex skills を読むため、両 host の利用可能ツール差分を別 DB として保持できます。各 MCP サーバーの `tools/list` は JSON-RPC で取得 (HTTP / SSE / stdio transport 対応)、スキルとサブエージェントは frontmatter から直接抽出、claude.ai baseline (OAuth proxy 経由の Gmail / Calendar / Drive 25 件) は Claude 側でのみ `claude mcp list` に該当サーバーが存在する環境で注入されます。**手書きでツールリストを管理する必要はありません**。

## Throughline との関係

[Throughline](https://github.com/kitepon-rgb/Throughline) と Spotter は同じ作者が作った、**哲学を共有する別プロダクト**です。

|  | Throughline | Spotter |
|---|---|---|
| 思想 | 引き算 (要らないものを退避) | 足し算 (足りない動作に気づかせる) |
| 対象 | コンテキスト肥大化 | ツール取りこぼし |
| 仕組み | hook で記憶退避 | hook でサブエージェント並走 |

両者に共通するのは **「主体に頼らない仕組み」**。併用できます。

## よく使うコマンド

```bash
spotter db list          # 現在の Claude local tool-db を表示
spotter db list --host-agent codex
                         # 現在の Codex local tool-db を表示
spotter db refresh       # Claude MCP / スキル / サブエージェントから description を収集して Claude DB 更新
spotter db refresh --host-agent codex
                         # Codex MCP / スキルから description を収集して .spotter/tool-db.codex.json を更新
                         # (Claude は install + Claude SessionStart、Codex は spotter install 後の
                         #  Codex SessionStart で自動実行されるので通常は不要)
spotter db rebuild       # Claude local + Claude global DB を両方消してから refresh (カタログ設計変更時のクリーン用)
spotter status           # 稼働中の daemon 一覧
spotter doctor           # 環境診断 (Node / claude CLI / Codex readiness / tool-db 整合性)
spotter diagnostics logs # daemon log から pass=false / backend latency / anomaly signal を集計
spotter codex risk-check --findings findings.json --host-agent claude
                         # Spotter finding を codex-sidecar に渡して read-only risk analysis
spotter codex review|explore|opinion --findings findings.json --host-agent claude
                         # その他の read-only codex-sidecar second-pass workflow
spotter codex work --findings findings.json --instruction "docs 更新" --approve-work \
  --allowed-path docs/ --preserve-worktree
                         # 承認済み codex-sidecar work を isolated worktree で実行
spotter codex-hook install
                         # Codex native hooks の修復 / 明示登録 (通常は spotter install が実行)
spotter codex-hook diagnostics
                         # Codex hook の登録/readiness を診断。trust は /hooks で review
spotter uninstall        # hook 登録を解除 (~/.spotter は残す)
```

Codex risk dispatch を daemon から非同期に流す場合:

```bash
SPOTTER_CODEX_RISK_CHECK=1 spotter daemon start --session-id ... --project-root ...
```

有効時は daemon が `pass:false` finding を detached process の
`spotter codex risk-check` に渡します。hook 応答は Codex を待ちません。
配線だけ確認する場合は `SPOTTER_CODEX_RISK_CHECK_DRY_RUN=1` を併用します。

Primary auditor backend policy: Claude hooks の auto selection は PATH に Codex CLI があれば Codex CLI、
なければ Haiku compatibility path。Codex native hooks の auto selection は Codex CLI です。
`SPOTTER_AUDITOR_BACKEND` の明示 override はどちらの host でも優先し、runtime failure では別 backend へ
hidden fallback しません。
Codex 側の SessionStart hook は `.spotter/tool-db.codex.json` を bg refresh し、Claude DB には触れません。
Codex CLI auditor の子プロセスは、hook 判定を安く速く保つため既定で `gpt-5.4-mini` と
`model_reasoning_effort="low"` を明示指定します。実測や制御された実験では
`SPOTTER_CODEX_CLI_MODEL` / `SPOTTER_CODEX_CLI_REASONING_EFFORT` で上書きできます。
明示 smoke には `SPOTTER_AUDITOR_BACKEND=codex-sidecar` も使えます。

## 設計ドキュメント

- **現行設計 (カタログ / 収集経路 / 分類軸)**: [docs/01_catalog-design.md](docs/01_catalog-design.md) — v1.0.0 以降の真実源
- **現時点で塞がっていない穴 + 実測未検証の懸念**: [docs/open-issues.md](docs/open-issues.md) — 新規作業に入る前に必読
- **Runtime contract**: [docs/02_spotter-claude-contract.md](docs/02_spotter-claude-contract.md) — Claude hook / daemon / Haiku 契約と Codex native hook policy
- **実装規範と不変条件 (§0)**: [CLAUDE.md](CLAUDE.md) — フォールバック禁止 / silent fallback 禁止 / 暫定コード禁止
- **Archive**: [docs/archive/](docs/archive/) — 完了済み Codex rollout 計画、primary backend smoke log、v0.1 設計議事録

## 既知の制約

- v1.4.8 以降、Claude / Codex 両 host で `Stop` hook は **遅延配送 (deferred delivery)** に統一されています。`Stop` で見落としツールを検出した場合、Spotter は `<projectRoot>/.spotter/pending/<sessionId>.json` に指摘を積み、次の same-session `UserPromptSubmit` で `additionalContext` として配信します。当ターンの最初の応答は transcript にそのまま残ります
- pending ファイルは Claude / Codex が同じパス (`.spotter/pending/`) を共有します。host-neutral 設計です
- **Haiku の JSON スキーマ違反は v0.5.0 以降「想定済み異常」として session renew + `role_collapse_reset` で回復**します。**v1.4.15 以降、auditor/daemon の失敗はプロンプトをブロックしません**: `UserPromptSubmit` は `[Spotter からの警告]` を出して exit 0。v1.4.17 では `Stop` 失敗も warning pending に積み、次の same-session prompt で1回配信します。直後に session が終わる場合だけ、配送先となる次 prompt がありません

<details>
<summary><strong>📋 最近のハイライト</strong></summary>

- **daemon は異常死しても復活する** (v1.4.16) — daemon が graceful shutdown を経ず死んでも (マシンスリープ / 強制終了 / `SessionEnd` 前の crash)、残った Unix socket が以後の起動を塞がなくなった。`startDaemon` が bind 前に orphan socket を除去するので、次の `UserPromptSubmit` の auto-resurrect が `EADDRINUSE` で crash-loop せずに成功し、「そのセッションが永久に未監査」になる事態を防ぐ
- **失敗は声に出して縮退、host を固めない** (v1.4.15) — auditor backend が失敗したとき (例: codex のログイン失効) も、`UserPromptSubmit` hook はプロンプトを黙って消さずに `[Spotter からの警告]` を出して通す。codex ログイン失効時は直し方 (`codex login`) を明示する
- **プラグイン形式の MCP サーバー対応** — `plugin:everything-claude-code:context7` のように名前に内部コロンを含むサーバーを正しくパースし、配下のツールをカタログに取り込めるようになった (旧版はこの形式のサーバーをすべて単一の `"plugin"` に潰して、Claude の監査から silent に脱落させていた)
- **プロジェクト単位の監査隔離** — daemon が監査に使うのはローカル DB のみ。グローバル DB は description 再利用キャッシュに役割限定。**他プロジェクト**でインストールしたツールが現プロジェクトの監査に混入することはない
- **手放しでカタログ維持** — `spotter install` が Claude DB を自動 seed、Claude / Codex それぞれの SessionStart が host-local DB を bg refresh する。手書き管理は一切不要
- **Codex native hooks** — Codex host は primary auditor backend として Codex CLI を使い、`.spotter/tool-db.codex.json` を Claude DB と分離し、backend failure は Haiku fallback ではなく明示 error として扱う
- **監査対象** — ユーザー追加分 (MCP / スキル / サブエージェント) のみ。Claude Code 本体側のツールは意図的に対象外 (Claude は元から自発率が高いため)
- **実装規範** — フォールバック禁止 / silent fallback 禁止 / 暫定コード禁止 ([CLAUDE.md §0](CLAUDE.md))

リリース履歴の全文は [CHANGELOG](CHANGELOG.md) を参照。

</details>

## ライセンス

MIT — see [LICENSE](LICENSE).
