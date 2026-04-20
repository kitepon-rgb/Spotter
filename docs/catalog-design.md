# カタログ設計思想 — ユーザー追加ツールだけを Haiku に渡す

## 背景: Bell の視野にあるツールの分類

Claude Code (Bell) が利用可能なツールは、**誰が追加したものか**で 2 つに分かれる。

### Claude Code 本体が提供するもの

Claude Code のバイナリに組込みで存在する即時ツール + 遅延ツール。

- **即時ツール** (プロンプト先頭に schema が常時ロード): `Read` / `Write` / `Edit` / `Bash` / `PowerShell` / `Grep` / `Glob` / `Agent` / `Skill` / `ToolSearch` / `ScheduleWakeup`
- **遅延ツール** (`ToolSearch` で schema を取得): `WebSearch` / `WebFetch` / `NotebookEdit` / `Monitor` / `PushNotification` / `CronCreate`/`CronDelete`/`CronList` / `RemoteTrigger` / `EnterWorktree`/`ExitWorktree` / `EnterPlanMode`/`ExitPlanMode` / `TodoWrite` / `AskUserQuestion` / `TaskOutput`/`TaskStop`

即時 / 遅延の境界は Claude Code のバージョンで動的に変わる。

### ユーザーが追加するもの

ユーザーの設定・プラグイン・個別ファイルで足されるツール類。

- **外部サービス連携 (MCP)**: `.mcp.json` で登録された MCP サーバーが提供するツール (Bell からは `mcp__<server>__<tool>` として見える)
- **スキル**: `<root>/skills/<name>/SKILL.md` で定義される定型手順書 (Bell からは `Skill` ツール経由で呼ばれる。プラグイン由来は `<plugin>:<skill>`、ユーザー / プロジェクト由来は素の名前)
- **サブエージェント**: `<root>/agents/<name>.md` で定義される別役エージェント (Bell からは `Agent` ツールの `subagent_type` 引数で指定される)

## Spotter の監査対象 — ユーザー追加分のみ

Bell は Claude Code 本体が提供するツールを**使いこなしている**。`Read` や `WebSearch` が存在することを忘れることは稀で、使うべき場面では自発的に選ぶ。

一方、ユーザーが追加したものは **Bell にとって「言われないと思い出さない」**状態で会話に入っている。Caveat に過去ナレッジを記録すべき場面で記録されない、ECC の `council` スキルで合議すべき場面で合議されない、`code-reviewer` サブエージェントで裏付けすべき場面で自前で進める、といった典型的な見落としがここで発生する。

したがって **Spotter の監査範囲はユーザー追加分 (MCP / スキル / サブエージェント) に集中させる**。Claude Code 本体側は完全に視野外とする。

## Haiku に渡す情報の最小モデル

Haiku は「Bell が呼び忘れているツールがあれば、その名前と理由を返す」役。**schema までは要らない**。呼び方を知るのは Bell の責任 (Bell が `ToolSearch` などで schema を取りに行く)。

したがって Haiku に渡すべきは **`{ツール名, 説明}` のペアだけ**。これを DB として preamble に投入する。

```
mcp__caveat__caveat_record: 過去の解決済みナレッジを記録する
ecc:council:                合議で判断をつける
code-reviewer:              書いたコードのレビュー専門家
...
```

これが**一つの思想**:

> **Haiku には「あるよ」を教える。「どう呼ぶか」は Bell が解決する。**

役割分業。Haiku は気づきの装置、Bell は実行の装置。schema を Haiku に渡すのは責任の越境であり、preamble サイズも無駄に膨らむ。

## DB の最小スキーマ

```
{
  "tools": [
    {
      "name": "<Bell から見えるツール名>",
      "description": "<自然言語の用途説明文>"
    },
    ...
  ]
}
```

- `name`: Bell がツール呼び出し時に使う名前と完全一致させる
  - MCP: `mcp__<server-id>__<tool>` (例: `mcp__caveat__caveat_record`)
  - スキル (プラグイン由来): `<plugin>:<skill>` (例: `ecc:council`)
  - スキル (ユーザー / プロジェクト由来): 素の名前
  - サブエージェント: 素の名前 (例: `code-reviewer`、project > user > plugin の優先順で衝突解決)
- `description`: **ツールが何をするものかを自然言語で説明した文章**。API schema ではない。Haiku は「呼ぶか呼ばないか」だけを判断するので、人間が読んで意味が分かる説明があれば足りる

`when_to_use` / `usage` / `examples` / `keywords` のような追加フィールドは DB の対象外。**name + description のペアだけ**で動かす。

## description の出どころ — 真実源は各ツール提供者

description を**手書きで起こすのは禁止**。各提供者が自然言語の説明を既に書いている:

- **MCP**: サーバーの `tools/list` レスポンスの `description` フィールド (プロトコル仕様で必須)
- **スキル**: `SKILL.md` の YAML frontmatter の `description` フィールド
- **サブエージェント**: `.md` の YAML frontmatter の `description` フィールド

この description を**そのまま** DB に積む。Spotter が書き換えたり要約したりしない。理由:

- **二重管理になる**: 提供者が説明文を更新したら追従が必要になる
- **ニュアンスが落ちる**: ツール作者が一番よく分かっているはずの説明を人間が再解釈する意味がない
- **責任の所在が明確になる**: description の品質は提供者の責任。Spotter は中継者に徹する

例外として `claude.ai` ブランドの MCP サーバー (Gmail / Calendar / Drive) は OAuth proxy 経由で動いており、credentials を読まない方針の Spotter からは description を live fetch できない。[src/tool-db/claude-ai-baseline.mjs](../src/tool-db/claude-ai-baseline.mjs) に公式情報から起こした description を手書きで置いている。これは例外であって規則ではない。

## description の取得フロー — 3 段階のキャッシュ DB

セッション開始時、Spotter は **そのセッションで使える MCP / スキル / サブエージェント の一覧 (名前)** を取得する。各ツールの description は以下の順で探す:

1. **プロジェクトローカル DB** (`<project>/.spotter/tool-db.json`)
2. **グローバル DB** (`~/.spotter/tool-db.json`)
3. **どちらにも無ければ「調べる」** — 各提供者から description を取得。**取得結果はグローバルとローカルの両方に追記する**

```
[セッション開始]
   ↓
[使えるツール一覧を取得] (MCP / スキル / サブエージェント)
   ↓
各ツールについて:
   ┌─ ローカル DB に有る? ─→ Yes: 採用
   │           ↓ No
   ├─ グローバル DB に有る? ─→ Yes: 採用 + ローカルにも書き写す (write-through)
   │           ↓ No
   └─ 調べる (MCP tools/list / SKILL.md / agent .md 読取) ─→ ローカル & グローバル 両方に追記
```

### この設計の意図

- **作業負荷の軽減**: 毎セッション全部問い合わせると遅い・無駄。一度引いた description はキャッシュして使い回す
- **二重書き込みの理由**:
  - **グローバル**: 他のプロジェクトでも同じツールが出てきたときに即ヒットさせる
  - **ローカル**: そのプロジェクト固有のスナップショットを残す
- **グローバル → ローカル の write-through**: 次セッションでローカル単独ヒットになり余計な参照が走らない
- **drift 補正**: ローカルとグローバルで同一ツールの description が異なるとき、再調査して両方を上書きする。提供者の description が単一の真実源として優先される
- **明示的な無効化機構は持たない**: TTL や version tracking のような仕組みは入れない。drift 補正が間接的な無効化として機能する
- **ツールが利用可能リストから消えても DB エントリは削除しない**: 削除作業のコストに対して得るものがない

## 収集経路 (v1.0.0)

| 対象 | 実装 | 取得元 |
|---|---|---|
| MCP (stdio / HTTP / SSE) | [investigate-mcp.mjs](../src/tool-db/investigate-mcp.mjs) + [investigate-mcp-http.mjs](../src/tool-db/investigate-mcp-http.mjs) | `claude mcp list` + `<projectRoot>/.mcp.json` + `~/.claude/.mcp.json` merge、各サーバーに `tools/list` |
| claude.ai MCP (OAuth) | [claude-ai-baseline.mjs](../src/tool-db/claude-ai-baseline.mjs) | 手書き baseline (Gmail / Calendar / Drive の 25 件) |
| スキル | [investigate-skills.mjs](../src/tool-db/investigate-skills.mjs) | user scope `~/.claude/skills/`、project scope `<projectRoot>/.claude/skills/`、有効化プラグインの `skills/` |
| サブエージェント | [investigate-agents.mjs](../src/tool-db/investigate-agents.mjs) | user scope `~/.claude/agents/`、project scope `<projectRoot>/.claude/agents/`、有効化プラグインの `agents/` |

プラグインの有効化判定: user scope `~/.claude/settings.json` と project scope `.claude/settings.local.json` の `enabledPlugins` を両方見て、どちらかで `true` なら有効。`~/.claude/plugins/installed_plugins.json` の `installPath` から実体にアクセスする。

## 歴史

- v0.7.0〜v0.13.3: カタログは「MCP + Claude Code 組込み遅延ツール」17 件を手書き baseline で保持。理由は「遅延ツールは Bell が呼び忘れやすい」という仮定
- v1.0.0: 実測で「Claude Code 組込みツールは Bell が使いこなしており、呼び忘れ率は低い」と確認。遅延 / 即時の境界も Claude Code バージョンで動的に変わることが判明。**本体側は全面除外**、ユーザー追加分 (MCP + スキル + サブエージェント) のみに監査範囲を絞る設計転換
