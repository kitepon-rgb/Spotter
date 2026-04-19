# カタログ設計思想 — 遅延ツールと MCP ツールを DB として Haiku に渡す

## 背景: Bell から見たツールには 2 種類ある

Claude Code (Bell) が利用可能なツールは、**Bell 自身がプロンプト時点で呼び方 (schema) を知っているかどうか**で 2 つに分かれる。

### 即時利用可能ツール

プロンプト先頭に schema が常時ロードされている。Bell は名前も引数の形も例も知っているので、迷わず呼べる。**ここで「呼び忘れる」ことは稀**。

該当: `Agent` / `Bash` / `PowerShell` / `Read` / `Write` / `Edit` / `Glob` / `Grep` / `ScheduleWakeup` / `Skill` / `ToolSearch`

### 遅延ツール / MCP ツール

名前だけ告知されている。schema は `ToolSearch` で取得して初めて呼べる。**Bell 自身が「あるのは知ってるが、呼び方を知らない」状態**で会話に入っている。

つまり Bell にとっては「思い出さなければ存在ごと忘れる」もの。Caveat に過去ナレッジを記録すべき場面で `web_search` に走る、Gmail で検索すべき場面で「メールは見られません」と答える、などの典型的な見落としパターンがここで発生する。

該当 (Claude Code 組込み 遅延): `AskUserQuestion`, `TodoWrite`, `WebFetch`, `WebSearch`, `NotebookEdit`, `EnterPlanMode`/`ExitPlanMode`, `EnterWorktree`/`ExitWorktree`, `Monitor`, `PushNotification`, `CronCreate`/`CronDelete`/`CronList`, `RemoteTrigger`, `TaskOutput`/`TaskStop`

該当 (MCP):
- `caveat`: get, list_recent, pull, record, search, update
- `Gmail`: create_draft, create_label, get_thread, label_message, label_thread, list_drafts, list_labels, search_threads, unlabel_message, unlabel_thread
- `Google Calendar`: create_event, delete_event, get_event, list_calendars, list_events, respond_to_event, suggest_time, update_event
- `Google Drive`: create_file, download_file_content, get_file_metadata, get_file_permissions, list_recent_files, read_file_content, search_files
- `x-api (Twitter)`: count_tweets, fetch_timeline, fetch_tweet, get_list_tweets, get_quote_tweets, get_retweeted_by, get_trends, search_tweets, search_tweets_all

(参考: Skill 経由のスキルもあるが、これはツールというより「使い方の手順書」を呼び出す機構なので本ドキュメントの DB 対象外とする)

## Spotter にとっての含意

**Bell が見落としやすいのは後者 (遅延 / MCP) である**。即時ツールは Bell の手の届くところにあり、`Bash` や `Read` の存在を忘れることはまずない。一方、遅延 / MCP は「言われないと存在を思い出さない」ものが大半。

したがって **Spotter の監査範囲は遅延 / MCP に集中させる**。即時ツールを完全に無視するわけではないが、見落としリスクの大半はこちら側にある。

## Haiku に渡す情報の最小モデル

Haiku は「Bell が呼び忘れているツールがあれば、その名前と理由を返す」役。**schema までは要らない**。呼び方を知るのは Bell の責任 (Bell が `ToolSearch` で schema を取りに行く)。

したがって Haiku に渡すべきは **`{ツール名, 説明}` のペアだけ**。これを DB として preamble に投入する。

```
caveat_record: 過去の解決済みナレッジを記録する
caveat_search: 過去のナレッジを検索する
WebSearch:     Web 検索で最新情報を取得する
TodoWrite:     複数ステップのタスクを管理する
...
```

これが**一つの思想**:

> **Haiku には「あるよ」を教える。「どう呼ぶか」は Bell が `ToolSearch` で解決する。**

役割分業。Haiku は気づきの装置、Bell は実行の装置。schema を Haiku に渡すのは責任の越境であり、preamble サイズも無駄に膨らむ。

## DB の最小スキーマ

```
{
  "tools": [
    {
      "name": "<実ツール名 (Bell が ToolSearch で見つけたときの名前と一致)>",
      "description": "<自然言語の用途説明文 (Haiku が一次判定で使える粒度)>"
    },
    ...
  ]
}
```

- `name`: Bell が ToolSearch の検索結果として手にする名前と完全一致させる (例: `mcp__caveat__caveat_record`, `WebSearch`)。Haiku の指摘がそのまま Bell に通じることが、§14.4 が警告する「守られてる気がして実は素」状態を防ぐ第一条件
- `description`: **ツールが何をするものかを自然言語で説明した文章**。API schema (引数の型・必須項目・呼び出し例) ではない。Haiku は「呼ぶか呼ばないか」だけを判断するので、人間が読んで意味が分かる説明があれば足りる

`when_to_use` / `usage` / `examples` / `keywords` / `category` のような既存カタログの追加フィールドは、本 DB の対象外とする (将来必要なら別レイヤで足す)。**まずは name + description のペアだけ**で動かす。

## description の出どころ — MCP は MCP サーバーから直接取得する

description を**手書きで起こすのは MCP ツールに関しては禁止**。MCP プロトコルは各ツールに自然言語の `description` フィールドを必ず持たせており (`tools/list` レスポンスで取得可能)、これがそのまま Haiku に渡せる粒度の説明文になっている。

```
MCP サーバー (例: caveat) の tools/list レスポンス
  └─ tools[]
       ├─ name: "caveat_record"
       └─ description: "Create a new caveat: a record of an external-spec trap..."
```

この `description` を**そのまま** DB に積む。Spotter が手書きで言い換えたり要約したりしない。理由:

- **二重管理になる**: MCP サーバー側が説明文を更新したら追従が必要になる
- **ニュアンスが落ちる**: ツール作者が一番よく分かっているはずの説明を人間が再解釈する意味がない
- **責任の所在が明確になる**: description の品質は MCP サーバー作者の責任。Spotter は中継者に徹する

Bell も内部的には ToolSearch 経由でほぼ同じ description を見ているはずで、Bell ↔ Haiku の認識を揃える意味でも MCP サーバーの description が単一の真実源 (single source of truth) になる。

### Claude Code 組込みの遅延ツール (WebSearch / TodoWrite / 他) の扱い

これらは MCP サーバー由来ではなく Claude Code 自身が提供するツールで、ToolSearch 経由でしか schema が来ない点は MCP と同じ。description の取得方法は別途決める必要がある (本ドキュメントのスコープ外、次の思想で扱う)。

## description の取得フロー — 3 段階のキャッシュ DB

セッション開始時、Spotter は **そのセッションで使える遅延 / MCP ツールの一覧 (名前)** を取得する。各ツールの description は以下の順で探す:

1. **プロジェクトローカル DB** (例: `<project>/.spotter/tool-db.*`)
2. **グローバル DB** (例: `~/.spotter/tool-db.*`)
3. **どちらにも無ければ「調べる」** — MCP の場合は MCP サーバーの `tools/list` を叩いて description を取得。**取得結果はグローバルとローカルの両方に追記する**

```
[セッション開始]
   ↓
[使えるツール一覧を取得]
   ↓
各ツールについて:
   ┌─ ローカル DB に有る? ─→ Yes: 採用
   │           ↓ No
   ├─ グローバル DB に有る? ─→ Yes: 採用 + ローカルにも書き写す (write-through)
   │           ↓ No
   └─ 調べる (MCP サーバー問い合わせ等) ─→ ローカル & グローバル 両方に追記
```

### この設計の意図

- **作業負荷の軽減**: 毎セッション MCP サーバー全部に問い合わせると遅い・無駄。一度引いた description はキャッシュして使い回す
- **二重書き込みの理由**:
  - **グローバル**: 他のプロジェクトでも同じツールが出てきたときに即ヒットさせる (1 回調べたら全プロジェクトで効く)
  - **ローカル**: そのプロジェクト固有のスナップショットを残す。グローバルが後で書き換えられても、このプロジェクトで動いていた DB はローカルに保全される
- **グローバル → ローカル の write-through**: 次セッションでローカル単独ヒットになり余計な参照が走らない。グローバル更新の追従ができなくなる懸念は下記の drift 補正でカバー

### 確定した方針

- **DB フォーマット: JSON**。標準ライブラリだけで読み書き可能、人間が読める/編集できる、stdlib 内で完結 (依存追加なし)。既存の `tools.yaml` と二形式併存になるが、こちらは自動生成キャッシュなので YAML の人間可読性メリットは薄く、純粋な保存効率と扱いやすさで JSON を採用
- **drift 補正**: ローカルとグローバルで同一ツールの description が異なるとき、再調査 (MCP サーバー再問い合わせ等) して、新しい結果でローカルとグローバル**両方**を上書きする。MCP サーバーの description が単一の真実源として優先される
- **明示的な無効化機構は持たない**: TTL や version tracking のような仕組みは入れない。drift 補正が間接的な無効化として機能する
- **ツールが利用可能リストから消えても DB エントリは削除しない**: 削除作業のコストに対して得るものがない (ディスク容量は無視できる、ツールが復活すれば再利用できる)。「わざわざ消す意味」を見出せないので消さない

## 対象外として明記しておくこと (本ドキュメントのスコープ外)

- ~~DB をどこに保存するか~~ → ローカル + グローバルの 2 層構造で確定
- ~~DB をどう生成するか~~ → 3 段階フォールバック (ローカル → グローバル → 調査して両方に追記)
- ~~DB のフォーマット~~ → JSON
- ~~drift / 無効化方針~~ → drift 補正で間接対応、明示的無効化機構なし
- 「調べる」ステップの具体実装 — **次の思想で必ず着手する** (MCP サーバーへの問い合わせ方、Claude Code 組込み遅延ツールの description 取得経路、それぞれ別議論)
- preamble にどういう書式で投入するか
- 実装の段階分け (どのカテゴリから着手するか)
- DB ファイルの正確なパス (`.spotter/tool-db.json` 等)

これらは次の思想で順次決める。
