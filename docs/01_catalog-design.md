# カタログ設計思想 — ユーザー追加ツールだけを Haiku に渡す

この文書は現行 Claude-backed Haiku auditor path と Codex native hook path のカタログ設計を説明する。
`UserPromptSubmit` / `Stop` の primary auditor backend を Codex CLI / `codex-sidecar` に
移す計画は v1.4.3 で Codex host 側が完了済み。現行 backend policy は
[`02_spotter-claude-contract.md`](02_spotter-claude-contract.md) を参照し、完了済みの移行ログは
[`archive/SPOTTER_PRIMARY_BACKEND_TODO.md`](archive/SPOTTER_PRIMARY_BACKEND_TODO.md) に保持する。

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

例外として `claude.ai` ブランドの MCP サーバー (Gmail / Calendar / Drive) は OAuth proxy 経由で動いており、credentials を読まない方針の Spotter からは description を live fetch できない。[src/tool-db/claude-ai-baseline.mjs](../src/tool-db/claude-ai-baseline.mjs) に公式情報から起こした description を server 単位で手書きで保持し、[refresh.mjs](../src/tool-db/refresh.mjs) の `filterClaudeAiBaseline` で `claude mcp list` に該当サーバーが実在する環境のみ注入する (v1.1.4 以降)。これは例外であって規則ではない。

## description の取得フロー — 3 段階のキャッシュ DB

セッション開始時、Spotter は **その host セッションで使える MCP / スキル / サブエージェント の一覧 (名前)** を取得する。Claude と Codex は利用可能ツールが違うため、ローカル DB は host 別に分ける。

1. **プロジェクト host-local DB**
   - Claude: `<project>/.spotter/tool-db.json`
   - Codex: `<project>/.spotter/tool-db.codex.json`
2. **host-global DB**
   - Claude: `~/.spotter/tool-db.json`
   - Codex: `~/.spotter/tool-db.codex.json`
3. **どちらにも無ければ「調べる」** — 各提供者から description を取得。**取得結果はグローバルとローカルの両方に追記する**

```
[セッション開始]
   ↓
[使えるツール一覧を取得] (MCP / スキル / サブエージェント)
   ↓
各ツールについて:
   ┌─ host-local DB に有る? ─→ Yes: 採用
   │           ↓ No
   ├─ host-global DB に有る? ─→ Yes: 採用 + host-local にも書き写す (write-through)
   │           ↓ No
   └─ 調べる (MCP tools/list / SKILL.md / agent .md 読取) ─→ host-local & グローバル 両方に追記
```

### この設計の意図

- **作業負荷の軽減**: 毎セッション全部問い合わせると遅い・無駄。一度引いた description はキャッシュして使い回す
- **二重書き込みの理由 (v1.2.0 以降の役割再定義)**:
  - **host-local**: **各 host の監査が使う唯一の入力源**。Claude daemon は `.spotter/tool-db.json`、Codex hooks は `.spotter/tool-db.codex.json` を読み、その host / project の現時点の discovery 結果と一致する
  - **host-global**: **同じ host の他プロジェクトでの description 再利用キャッシュ**。Claude と Codex でも分離する。daemon / Codex hook の audit には混ぜない (混ぜると過去の別プロジェクトや別 host で discover したツールが現プロジェクトの監査視野に幻として漏れる)
- **グローバル → host-local の write-through**: 次セッションで host-local 単独ヒットになり余計な参照が走らない
- **drift 補正**: host-local と host-global で同一ツールの description が異なるとき、再調査して両方を上書きする。提供者の description が単一の真実源として優先される
- **明示的な無効化機構は持たない**: TTL や version tracking のような仕組みは入れない。drift 補正が間接的な無効化として機能する
- **host-local DB は prune される (v1.2.0 以降、host 分離は 2026-05-06 以降)**: refresh 時に「その host / project の discovery 結果に含まれない既存 host-local エントリ」は削除される。Claude refresh は Claude DB だけ、Codex refresh は Codex DB だけを prune するため、片方の環境が片方のツールリストを喪失させる経路を持たない。MCP サーバーをアンインストールした / スキルを消した / サブエージェントを別プロジェクトに移したケースで、過去のエントリが居座って監査視野に残る経路を塞ぐ。investigate が transient failure (auth / network / quota) で null を返した場合は、toolNames に含まれている限り既存値を保持して prune しない (audit 範囲を縮めない防御)
- **host-global DB は prune されない (v1.2.0 以降、host 分離は v1.4.5 以降)**: 同じ host の他プロジェクト用キャッシュとしての性格上、append-only で蓄積する。古いエントリは `spotter db rebuild --host-agent <host>` でしか消えない

## 収集経路 (v1.0.0)

| 対象 | 実装 | 取得元 |
|---|---|---|
| MCP (stdio / HTTP / SSE) | [investigate-mcp.mjs](../src/tool-db/investigate-mcp.mjs) + [investigate-mcp-http.mjs](../src/tool-db/investigate-mcp-http.mjs) | `claude mcp list` (membership 権威) + 公式 3 scope の env 込み merge: User (`~/.claude.json` 直下 `mcpServers`) / Project (`<projectRoot>/.mcp.json`) / Local (`~/.claude.json` `projects[<root>].mcpServers`)、precedence は Local > Project > User、加えて legacy `~/.claude/.mcp.json` を最下位で互換保持 (v1.2.1 以降)。各サーバーに `tools/list` JSON-RPC |
| claude.ai MCP (OAuth) | [claude-ai-baseline.mjs](../src/tool-db/claude-ai-baseline.mjs) + [refresh.mjs](../src/tool-db/refresh.mjs) の `filterClaudeAiBaseline` | 手書き baseline (Gmail / Calendar / Drive の 25 件) を server 単位で保持し、`claude mcp list` に該当サーバーが実在する環境のみ注入 (v1.1.4 以降) |
| スキル | [investigate-skills.mjs](../src/tool-db/investigate-skills.mjs) | user scope `~/.claude/skills/`、project scope `<projectRoot>/.claude/skills/`、有効化プラグインの `skills/` |
| サブエージェント | [investigate-agents.mjs](../src/tool-db/investigate-agents.mjs) | user scope `~/.claude/agents/`、project scope `<projectRoot>/.claude/agents/`、有効化プラグインの `agents/` |

Codex host の refresh は [investigate-codex.mjs](../src/tool-db/investigate-codex.mjs) で別経路を使う。MCP は `codex mcp list` / `codex mcp get` で membership と spawn 情報を取り、同じ JSON-RPC `tools/list` で description を取得する。Codex skills は `~/.codex/skills/.system/`、`~/.codex/skills/`、`<projectRoot>/.codex/skills/`、および `~/.codex/config.toml` で enabled な plugin cache の `skills/` から frontmatter description を読む。Claude の `.claude` 設定を Codex refresh の代替 source として使わない。

プラグインの有効化判定: user scope `~/.claude/settings.json` と project scope `.claude/settings.local.json` の `enabledPlugins` を両方見て、どちらかで `true` なら有効。`~/.claude/plugins/installed_plugins.json` の `installPath` から実体にアクセスする。

## 収集タイミング (v1.1.0 以降)

- **`spotter install` 時**: `refresh({projectRoot, hostAgent:"claude"})` を同期実行。初回 setup で Claude 用 tool-db.json を seed、install 完了時点で次セッションの daemon が audit に使える状態にする。Codex CLI が見える project install では Codex hooks 登録後に `refresh({projectRoot, hostAgent:"codex"})` も同期実行し、初回 Codex セッションから `.spotter/tool-db.codex.json` を読める状態にする。refresh throw 時は hook 登録も含めて install 自体を失敗扱い (§0 準拠)
- **SessionStart hook 発火時**: Claude SessionStart は `spotter db refresh --host-agent claude` を detached child として bg 起動 ([session-start.mjs](../src/hooks/session-start.mjs) の `spawnRefreshDetached`)。Codex native SessionStart は `spotter db refresh --host-agent codex` を detached child として bg 起動 ([codex-hook-cmd.mjs](../src/cli/codex-hook-cmd.mjs) の `runCodexSessionStartHook`)。hook 自体は即 return、drift 追従 (新規 MCP / スキル / サブエージェントの追加、削除) は**次セッション以降**に反映される。Claude daemon は起動時の Claude DB を固定保持し、Codex hooks は次 hook 実行時に Codex DB を読み直す
- **`spotter db refresh` CLI**: 明示的に叩いた場合も同じ refresh ロジック。`--host-agent codex` を付けると `.spotter/tool-db.codex.json` を更新し、Claude DB には触れない。Claude / Codex とも SessionStart の自動化が通常経路なので、手動実行は smoke / 修復 / 即時反映用
- **`spotter db rebuild` CLI**: host-local + host-global DB を wipe してから refresh。既定は Claude local + Claude global、`--host-agent codex` なら Codex local + Codex global。カタログ設計変更時 (v1.0.0 の切り替え等) のクリーンスレート用、通常運用では不使用

## 歴史

- v0.7.0〜v0.13.3: カタログは「MCP + Claude Code 組込み遅延ツール」17 件を手書き baseline で保持。理由は「遅延ツールは Bell が呼び忘れやすい」という仮定
- v1.0.0: 実測で「Claude Code 組込みツールは Bell が使いこなしており、呼び忘れ率は低い」と確認。遅延 / 即時の境界も Claude Code バージョンで動的に変わることが判明。**本体側は全面除外**、ユーザー追加分 (MCP + スキル + サブエージェント) のみに監査範囲を絞る設計転換
- v1.1.x: Claude 収集タイミングの自動化。install 時同期 seed + SessionStart bg refresh で手動 `spotter db refresh` を不要化、drift 自動追従を実現
- 2026-05-06 Codex native work: Codex host-local DB を `.spotter/tool-db.codex.json` に分離し、Codex native SessionStart で `spotter db refresh --host-agent codex` を bg 起動。Claude / Codex 間で tool list を上書きしない構造にした
- v1.4.6: `spotter install` が Codex CLI を検出して Codex hooks を登録した場合、Codex host-local DB も同期 seed するように変更。初回 Codex セッションが空 `.spotter/tool-db.codex.json` / SessionStart 非同期 refresh race に依存する穴を塞いだ
- v1.4.5: host-global DB も分離。Claude は `~/.spotter/tool-db.json`、Codex は `~/.spotter/tool-db.codex.json` を使い、refresh の local → global → investigate cache path でも Claude / Codex の description が混ざらないようにした
- v1.1.4: MCP 投資経路の 2 件の silent mismatch を修正。(1) `listMcpServers` / `getStdioConfig` の `claude mcp list / get` spawn 時に `cwd: projectRoot` を付与、名乗っている project scope と claude CLI が walk-up で見つける project scope の乖離を解消。(2) claude.ai baseline を server 単位構造に再編、`filterClaudeAiBaseline` で `claude mcp list` に該当サーバーが実在する環境のみ注入。隔離 `CLAUDE_CONFIG_DIR` / 未連携 / 部分連携環境で最大 25 件の幻ツールが catalog に残る問題を解消 (Bell 側実環境で 25 件消失を実測確認済み)
- v1.2.0: daemon の audit 入力をローカル DB のみに変更し、グローバル DB は他プロジェクトでの description 再利用キャッシュに役割を限定 (`readMerged` → `readLocal`)。同時に `resolveAll` 末尾に prune ループ追加で「現プロジェクトの discovery 結果に含まれない既存ローカルエントリ」を削除。過去の別プロジェクトで discover した MCP / スキル / サブエージェントが Haiku 視野に幻として漏れる構造的バグを解消
