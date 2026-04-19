# Spotter 計画書

**作成日**: 2026-04-18
**作成者**: クオ (@QuoLu) + ベル
**ステータス**: 設計確定、実装未着手

---

## 1. 問題認識

Claude を含む LLM には、**「使えるツールがあるのに、使うべきタイミングで使わない」** という構造的な弱点がある。

具体例:
- 現在時刻に言及するときに `current_time` ツールを呼ばない
- 過去のツール入出力を参照すべきときに retrieval を呼ばない
- 最新情報を要求された時に web_search を呼ばない

LLM は「呼び出しが必要」という自覚が生まれないと、ツールを呼ばない。「分からないことを、分からないと自覚できない」状態では、取りに行く動機が発生しないため。

MCP 時代に入ってツール数は爆増しており、この「気づけない問題」は構造的に深刻化している。

## 2. 既存ソリューションの限界

市場調査の結論: **この問題を真正面から解決したプロダクトは存在しない**。

| カテゴリ | 代表例 | 限界 |
|---|---|---|
| Observability | LangSmith, Langfuse, Datadog | 事後観察のみ、発話前には介入できない |
| Self-Reflection | Reflexion, Self-RAG | 同じ AI が自己検閲するので自覚が切れたら破綻 |
| Supervisor Agent | LangGraph Supervisor | 出力後に評価してやり直し、発話前ではない |
| Planner 系 | TOPGUN, TPE | タスク分解用で、日常対話のツール取りこぼし監視ではない |

世の中のツール関連プロダクトは概ね **「ツールを集めた」「ツールを観察した」** で止まっている。

## 3. コンセプト

**「Bell (主役の Claude) の発話予定を、ツール一覧を完全把握した別エージェントが事前にチェックし、ツールを呼び忘れていないか教える」**

気づく役と実行する役を分離する。Bell は発話を作ることに集中し、Spotter は**ツール呼び出し漏れの検出という一点に特化**する。

## 4. 既存プロダクトとの関係

| | Throughline | Spotter |
|---|---|---|
| 思想 | 引き算 (要らないものを退避) | 足し算 (足りない動作に気づかせる) |
| 対象 | コンテキスト肥大化 | ツール取りこぼし |
| アーキテクチャ | hook で記憶退避 | hook でサブエージェント並走 |

思想の方向が逆なので**別プロダクト**とする。ただし両者に共通する哲学: **「主体(Bell)に頼らない仕組み」**。

## 5. アーキテクチャ

### 5.1 処理フロー

```
User発話
  ↓
UserPromptSubmit hook で Spotter エージェント起動 (隔離環境)
  → 全ツール用途カタログ + User発話 だけを見て一次判定
  ↓
Bell Thinking
  ← Spotter の判定結果を additionalContext で受け取って思考
  ↓
Bell 最終判断
  ↓
Stop hook で Spotter 最終チェック
  ↓
見落としあれば差し戻し (max 1回、無限ループ防止)
  ↓
Bell 出力
```

### 5.2 Spotter の実行環境

**隔離**が設計の核:

- 実行ディレクトリ: `~/.spotter/workdir/`
- **CLAUDE.md は置かない** (プロジェクト文脈に引きずられない)
- Bell 本体の会話履歴も見せない
- 見るのは **「ツールカタログ + 今ターンの限定情報」だけ**

プロジェクト文脈で動くのは Bell の仕事。Spotter は「発話に対してツール使用が妥当か」だけを評価する監査役に徹する。

### 5.3 LLM 選定

- **Claude Haiku 4.5**
- `claude -p --model claude-haiku-4-5-*` で起動
- Claude Max 契約を流用 (Throughline と同じパターン)
- 軽量・高速・安価

### 5.4 並走アーキテクチャ: セッション単位デーモン

Spotter は **セッション単位で1プロセスが常駐する監査役デーモン** として動く。Bell から呼ぶのではなく、**監査役が独立して発話・ツール使用・停止を監視する並走モデル**。

#### なぜデーモン型か (「Bell から呼ぶ」を却下した理由)

- 「Bell が必要に応じて Spotter ツールを呼ぶ」は **Bell の自覚に依存** する設計 = 気づかない AI 問題の再発
- Spotter の存在意義は Bell が気づけない状況での監査。Bell から呼ぶモデルでは存在意義が失われる
- 監査役は Bell の意思とは独立して動き続ける必要がある

#### 都度起動 vs 維持型の比較

都度起動 (UserPromptSubmit/Stop ごとに `claude -p` を叩く) と維持型 (セッション1プロセス) を比較:

| 観点 | 都度起動 | 維持型 (採用) |
|---|---|---|
| トークン消費 | 毎回ツールカタログ (約5万トークン) を再送信。1ターン3〜5イベント × 5万 = 15〜25万トークン/ターン | ツールカタログはプロセス起動時1回のみロード。毎回は可変情報のみ送信 |
| プロセス起動コスト | Node.js + Claude CLI 起動が毎回数百ms〜数秒 | セッション起動時の1回のみ |
| デバッグ性 | 毎回ログが独立、単純 | プロセス内状態が増える、やや複雑 |
| 障害モード | hook 単位で独立、片方失敗しても次は影響なし | プロセス死活管理・孤児プロセス・session衝突などのケース追加 |

**経済性はおよそ10倍の差。維持型が圧倒的に有利**。障害モード管理のコード追加は受け入れるトレードオフ。

#### プロセスライフサイクル

```
SessionStart hook
  └→ spotter-daemon 起動 (tool-catalog.yaml をメモリロード、socket 待機)

[ターン開始] UserPromptSubmit hook
  └→ daemon に "user_input" イベント送信
     daemon: claude -p 呼び出し (ツールカタログ + user_input のみ)
     daemon: 判定結果を hook 経由で additionalContext に注入

[ターン中] PreToolUse hook (Bell がツール使った)
  └→ daemon に "tool_used" イベント送信
     daemon: 内部状態 used_tools に追加 (Claude 呼び出しなし、軽量記録のみ)

[ターン終了] Stop hook
  └→ daemon に "turn_end" イベント送信 (+ final_response)
     daemon: claude -p 呼び出し (ツールカタログ + used_tools + final_response)
       ※ v0.13.0 で user_input を渡さない形に変更: 判定軸が「要請充足チェック」から
         「ツール適用機会の監査」に転換 (Bell の応答内容そのものを見る)
     daemon: 見落とし判定、必要なら decision: "block" を hook から返す
     daemon: ターン状態クリア (used_tools 等をリセット)

SessionEnd hook
  └→ daemon に shutdown 通知、プロセス終了
```

#### Spotter が受け取る3情報 (各ターンで)

1. **ユーザー入力** (UserPromptSubmit 起点)
   - ツールをどう使うべきか判断して Bell にアドバイス
2. **Bell がツールを使った情報** (PreToolUse 起点)
   - 「これは使った」と記録するだけ (Claude 呼び出しなし)
   - Stop 時点で「既に使ったツール」は指摘対象から除外される
3. **Bell の最終応答** (Stop 起点)
   - 応答内容を見て、未使用ツールで補うべきものがあるかアドバイス

#### コンテキスト蓄積の回避

Spotter は各 claude 呼び出しを **毎回独立したプロンプト** として送る。Claude の会話履歴は積まない:

```
[ツールカタログ (固定) ]
[今ターンの情報 (可変、ターンごとにクリア) ]
  - ユーザー入力
  - 使用済みツール一覧
  - 最終応答 (Stop 時のみ)
```

プロセスは維持するが、**Claude 側のコンテキストは毎ターン空**。プロセス内メモリが持つのは `used_tools[]` のような軽量な記録のみ。これにより:

- ツールカタログの再送信が不要 (経済性)
- Claude の思考が過去ターンに引きずられない (判断の独立性)
- プロセスメモリは数KB レベル (リソース効率)

### 5.5 Haiku への入出力契約 — 決着済 (2026-04-19)

Spotter daemon が `claude -p --model claude-haiku-4-5-*` を呼ぶ際、入力と出力は**構造化 JSON 形式で固定**する。

**入力**: プロンプト末尾に「以下のツールカタログとユーザー入力を見て、呼ぶべきツールがあれば下記 JSON スキーマで返してください」と明示。

**出力 (必須スキーマ)**:

```json
{
  "pass": false,
  "missing_tools": [
    {
      "name": "current_time",
      "reason": "ユーザーが現在時刻を尋ねているため"
    }
  ]
}
```

- `pass: true` なら `missing_tools: []`。指摘なし。
- `pass: false` なら `missing_tools` に 1 件以上。

**理由**: `test_cases` の自動合否判定 (§11) と Stop hook の差し戻しロジック (§8) の両方が「特定ツール名を機械的に取り出せること」を前提にしている。自由記述だと後工程のパースが不安定になり、§14.3 の想定外/想定済みの境界判定が曖昧になる。

**異常系**: Haiku がスキーマを外した出力を返した場合は §14.1 に従って throw (silent fallback 禁止)。JSON パース失敗は想定外扱い。

**リトライ方針**: **リトライなし**。Haiku のネットワーク失敗 / スキーマ違反 / タイムアウトは全て §14.3 の想定外扱いで即 throw。リトライは silent fallback 誘発の温床であり §14.1 の禁止対象。再発率が運用計測で想定下振れした場合のみ、v0.2 で「回数上限付きリトライ + 失敗時 hard throw」を別途設計する。

**プロンプト側の防衛**: JSON 遵守率を上げるため、system prompt で「他のテキストを一切出さず、指定スキーマの JSON オブジェクトのみを返せ」を明記する。Haiku 4.5 の JSON 出力遵守率は実測未検証であり、v0.1 運用初期で下振れた場合はユーザーが hook error を頻繁に見る可能性を受容する (§14.4「silent fallback より露出 throw」の帰結)。

**タイムアウト**: hook 側タイムアウトから数秒の余裕を引いた値を Haiku 呼び出しのハードリミットとする。詳細は §5.7 の表。

### 5.6 クロスプラットフォーム socket 抽象 — 決着済 (2026-04-19)

hook ⇄ daemon 間通信は Node.js `net` モジュールで実装し、**パスだけ OS 判定で分岐**する。`net.createServer()` / `net.connect()` は Windows の Named Pipe と Unix domain socket を**同一 API で扱える**ため、通信コードは 1 本で済む。

| OS | パス形式 |
|---|---|
| macOS / Linux | `~/.spotter/runtime/session-<session_id>.sock` (§10 の設計通り) |
| Windows | `\\.\pipe\spotter-<session_id>` (Named Pipe 名前空間) |

`process.platform === 'win32'` で分岐する以外、ロジックの差分はない。`~/.spotter/runtime/` ディレクトリは Windows でも作成するが、Windows 環境では実際の socket ファイルはそこに作られず Named Pipe 名前空間に存在する (ログや PID ファイルの置き場としては使う)。

### 5.7 hook ⇄ daemon メッセージ契約 — 決着済 (2026-04-19)

socket (Named Pipe / Unix socket) 上を流れるメッセージは **改行区切り JSON 1 行** で固定する。実装者が hook ごとに自由形式を決められないよう規定し、§14.1 の境界判定が運用で骨抜きになるのを防ぐ。

**共通 envelope (hook → daemon)**:

```json
{
  "id": "<uuid-v4>",
  "event": "session_start | user_input | tool_used | turn_end | shutdown",
  "session_id": "<claude-code-session-id>",
  "payload": { }
}
```

**共通 response (daemon → hook)**:

```json
{ "id": "<リクエスト id と一致>", "ok": true,  "result": { } }
```

または:

```json
{
  "id": "<リクエスト id と一致>",
  "ok": false,
  "error": {
    "code": "E_CATALOG_MISSING | E_HAIKU_SCHEMA | E_HAIKU_TIMEOUT | E_INTERNAL",
    "message": "..."
  }
}
```

**タイムアウト基準値**:

| event | hook 側 (§7.2) | daemon 側 | 備考 |
|---|---|---|---|
| session_start (readiness ping) | 3000ms | - | daemon 起動完了待ち |
| user_input | 30000ms | 28000ms | Haiku 呼び出し含む |
| tool_used | 1000ms | 500ms | 記録のみ、Haiku 呼び出しなし |
| turn_end | 15000ms | 13000ms | Haiku 呼び出し含む |
| shutdown | 2000ms | 1000ms | cleanup 完了待ち |

daemon 側タイムアウトを hook 側より短く取るのは、hook が待ち続けて孤児化する前に daemon から明示的に `E_HAIKU_TIMEOUT` を返すため。

**異常時の扱い** (§14.3 / §14.4 の分類に完全準拠):

- daemon が `ok: false` を返した場合 → hook が exit code 2 + stderr に error.code/message を吐いて throw (想定外)
- 応答が来ない (hook 側 timeout) → exit code 2 + stderr で「daemon unresponsive」(想定外)
- socket 疎通自体の失敗 (ENOENT / ECONNREFUSED) → exit code 1 + stderr で「daemon unreachable」(§14.4 想定済み異常)

silent fallback (exit code 0 で握り潰す) は §14.1 禁止対象。

## 6. ツールカタログ設計

### 6.1 形式: YAML

md ではなく YAML を採用する理由:

| | md (自由記述) | YAML (構造化) |
|---|---|---|
| 粒度 | ブレる | 固定 |
| バリデーション | 不可 | 可能 |
| フィールド抽出 | 困難 | 容易 |
| 重複検出 | 不可 | 可能 |
| 差分管理 | 読みにくい | 読みやすい |
| テストケース記述 | 困難 | 容易 |

特に「一次判定には用途だけ、詳細は使う時だけ」という**2段階コンテキスト**を実現するには、フィールド分離が必須。

### 6.2 スキーマ

```yaml
version: 1
tools:
  - name: current_time
    category: time
    purpose: >
      現在の日時を正確に取得する。LLMは会話の流れから時刻を推測する癖があるが
      不正確。時刻に言及する全ての場面で必ず呼ぶ。
    when_to_use:
      - 「今何時」「今日は何日」等の直接質問
      - 時間に言及する発話を出す前（「もう深夜だね」等）
      - 時間依存の判断をする時（営業時間、締切、等）
    usage: current_time [timezone]
    examples:
      - input: "もう夜遅いね"
        call: current_time Asia/Tokyo
    keywords: [今, 現在, 時刻, 日付, now, today]
    test_cases:
      - user_input: "今何時?"
        expected_tool: current_time
      - user_input: "今日の祝日は?"
        expected_tool: holidays_jp  # current_time ではなく
```

**v0.1 で Haiku に渡すフィールド**: `name` / `purpose` / `when_to_use` (一次判定)、`usage` / `examples` (確定後)。
**v0.1 で雛形に書くが Haiku に渡さないフィールド**: `category` / `keywords`。v0.3 のドメイン別カタログ分割と高速事前フィルタで使用予定。v0.1 実装で不要と判明した場合は v0.2 で雛形から除外するか維持するか再判断する。

### 6.3 2段階コンテキスト

- **一次判定**: `purpose` + `when_to_use` + `keywords` だけ Spotter に渡す
- **確定後**: `usage` + `examples` を追加で渡す

フィールド構造で自然に実現される。

### 6.4 テストケース

`test_cases` フィールドを各ツールに持つ。プロンプトやツール定義を変更した時の**回帰検出**に使う。Throughline の「想定外は silent に呑まず throw する」思想と同じ。

## 7. Claude Code Hook 機構

### 7.1 利用する機構 (2026/04 時点)

- `UserPromptSubmit` hook: User 発話直後に発火
- `Stop` hook: Bell の応答が**出力された後**に発火 (後述 7.5 参照)
- `async: true` (2026/01/25 追加): fire-and-forget でバックグラウンド実行
- `type: "agent"` (2026/03 頃): サブエージェントを hook として起動
- `additionalContext`: Bell に追加コンテキストを注入する仕組み
- `stop_hook_active`: Stop hook 入力フィールド、無限ループ防止用

### 7.2 hook 設定例

```json
{
  "hooks": {
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "spotter audit-prompt",
        "timeout": 30
      }]
    }],
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "spotter audit-final",
        "timeout": 15
      }]
    }]
  }
}
```

### 7.3 既知の hook バグ (実装時に注意)

- **Issue #8810**: `UserPromptSubmit` がサブディレクトリで発火しない問題
  - 回避: プロジェクト側 `.claude/settings.json` に書く
- **Issue #32551**: `async: true` の完了メッセージが表示される
  - `silent` オプション未実装、verbose mode 切らない限り出る
- **Issue #10463**: `Stop` hook の JSON 出力 regression
  - 2.0.28 時点で発生中、動作確認必須

### 7.4 同期 vs 非同期の選択

初期実装は **同期** (`async: false`)。理由:

- async hook の結果は**次のターン**で届く仕様のため、その場で Bell に伝えられない
- Extended Thinking 文化のユーザーはレイテンシに慣れており、「Thinking 中」に紛れる
- MVP では確実に動く方を優先

### 7.5 Stop hook のタイミングと介入機構

Claude Code のドキュメント上、Stop hook は **「Claude が応答を出力し終わった後」** に発火する。つまり **ユーザーは既に Bell の応答を読める状態** になっている。

ただし、Stop hook は「発話後のログ記録」だけの hook ではなく、**Bell の停止を止めて会話を継続させる** 介入手段を持つ:

| 返り値 | 効果 |
|---|---|
| exit code 0 / 特になし | Bell は停止、ターン終了 |
| exit code 2 | Bell は停止せず、stderr の内容を受け取って継続応答を生成 |
| JSON `{"decision": "block", "reason": "..."}` | 同上、`reason` を Bell が受け取って継続応答を生成 |

つまり Stop hook が「Spotter の指摘」を `block` で返すと、**Bell は一度応答を出した後に、追加で継続応答を生成する**。ユーザーから見ると「最初の応答 + 訂正/補足の応答」という流れになる。

#### 無限ループ防止の機構

Stop hook の入力に `stop_hook_active: boolean` フィールドがある。

- 通常の発火時: `stop_hook_active: false`
- Spotter の差し戻しで Bell が継続応答 → その後の Stop hook 発火時: `stop_hook_active: true`

Spotter は `stop_hook_active: true` を見たら **即座に pass する** 実装にすれば、差し戻しは自動的に 1 回に制限される。Claude Code 側の機構で max 1 回ループ制限が担保される。

#### Stop hook が「発言済み後」であることの UX 影響

ユーザー視点では:

1. Bell が応答を出す
2. Spotter が「ツール使い忘れ」を検出
3. Bell が「追加考慮の結果、ツールを使って再回答すると〜」と続ける

これは「最初の応答を取り消す」ことは**できない**。Claude Code の hook 仕様上、Bell の素のテキスト応答を出力前に止める機構は存在しない (PreToolUse はツール呼び出し限定)。

したがって Spotter の介入は **「事後訂正として自然に見せる」** か **「監査役からの指摘として明示する」** かを選ぶ必要がある (§12.2 / §12.3 で**透明化採用に決着**、2026-04-19)。

## 8. Stop hook 差し戻しの詳細 (決着済 §12.3)

Bell が応答を出力した後、Stop hook で Spotter が「見落としあり」と判定した場合の挙動。

### 8.1 採用する方式 (論点 3-C)

- Stop hook が `decision: "block"` + `reason: "Spotter からの指摘: ..."` を返す
- Bell は停止せず、継続応答を生成する
- 継続応答時の Stop hook では `stop_hook_active: true` が入るので、Spotter はそこで pass する
- 結果として **差し戻しは max 1 回**、Claude Code の hook 機構で自動的に担保される

### 8.2 ユーザー体験

ユーザー視点では 2 つの応答が連続する:

1. Bell の最初の応答 (ツール使い忘れている可能性あり)
2. Bell の継続応答 (Spotter の指摘を受けて補正された内容)

**最初の応答は取り消せない**。Claude Code には Bell の素のテキスト応答を出力前にブロックする hook が存在しない (PreToolUse はツール呼び出し限定、UserPromptSubmit は入力時限定)。したがって Spotter の介入は常に「事後訂正」の形を取る。

### 8.3 Spotter の指摘を Bell に届ける書式

`decision: "block"` の `reason` に載せるテキストは、Bell が継続応答を組み立てる際のプロンプトになる。書式は 2 方向:

- **透明化**: 「Spotter からの指摘: `current_time` を呼ぶべきでした。呼び直してください。」
  - Bell が「Spotter からの指摘によると〜」と明示的に触れる可能性が高い
  - ユーザーは監査役の存在を認識する
- **不可視化**: 「`current_time` ツールを使って時刻を確認してから再回答してください。」
  - Bell は「改めて確認しました」程度の自然な書き出しで続ける
  - ユーザーは二重応答を「Bell が自発的に補足した」と認識する

**決着**: §12.3 で透明化を採用 (2026-04-19)。不可視化は「Spotter が壊れたときユーザーが気づけない」失敗モード (§14.4) を招くため棄却。

## 9. MVP スコープと段階設計

### v0.1 (最小動作版) — ⚠️ 2026-04-19 deprecate 済

**v0.1.0 / v0.1.1 は実環境で daemon 増殖事故を起こしたため npm 上で deprecate** (詳細は §18)。以下は歴史記録として残す。

- **セッション単位デーモン実装** (SessionStart で起動、SessionEnd で shutdown)
  - `SessionStart` hook で daemon を spawn し、**socket readiness ping が通るまで最大 3 秒ブロック**。通らなければ §14.3 に従い exit code 2 + stderr で throw
  - `SessionEnd` hook で shutdown 通知。応答失敗は warn ログのみ (§14.1 例外)
- `UserPromptSubmit` hook → daemon に `user_input` 通知、一次判定、`additionalContext` で Bell に注入 (透明化書式、§12.2)
- **`PreToolUse` hook → daemon に `tool_used` 通知 (軽量記録のみ、Haiku 呼び出しなし)** ← 当初 v0.2 予定だったが v0.1 に前倒し (2026-04-19 監査反映)。理由: Stop 判定で `used_tools` が空だと既使用ツールの再指摘誤検出が頻発し、§13 哲学「予測できないものを予測しない」に反する
- `Stop` hook → daemon に `turn_end` 通知、最終チェック、必要なら `decision: "block"` で差し戻し (透明化書式、§12.3)
- YAML カタログは手動で1ファイル作成 (`tools.yaml` のみ)、daemon 起動時にメモリロード
- daemon は Haiku を毎ターン独立プロンプトで呼ぶ (コンテキスト蓄積なし、§5.4)
- 入出力は §5.5 の JSON スキーマ、通信は §5.7 の envelope で固定
- 差し戻し (Stop で `decision: "block"`) + `stop_hook_active: true` で max 1 回ループ自動担保 (§7.5)
- **プロセス死活管理**: 全 hook で socket 疎通確認、通らなければ exit code で throw (silent fail 禁止)
  - daemon 起動失敗 / 応答 `ok: false` / 応答なし (timeout) → exit code 2 + stderr (§14.3 想定外)
  - socket 疎通自体の失敗 (ENOENT / ECONNREFUSED) → exit code 1 + stderr (§14.4 想定済み異常)
  - 例外: SessionEnd での shutdown 失敗は warn ログのみ (§14.1 例外、セッション終了は止めない)
- **test_cases 実行基盤**: `spotter catalog lint` で YAML スキーマ検証 + test_cases 実行 (Haiku 実呼び)。v0.1 完了判定 = catalog lint 全通過 (§11)

### v0.2

- 孤児プロセス cleanup (起動時タイムスタンプ比較で stale daemon を掃除)
- Haiku JSON 出力遵守率の計測 (§5.5 で v0.1 は「リトライなし」確定。下振れ時は本 v0.2 で「上限付きリトライ + 失敗時 hard throw」を設計)
- daemon 側のリソース使用量計測 (メモリ、socket 接続数、Haiku 呼び出し回数)

### v0.3

- ツールカタログの自動生成 (MCP サーバー列挙で動的構築)
- Bell 側からも呼べる `/ask-spotter` スラッシュコマンド (併用、自覚的な相談用)

### v0.4 以降

- async hook 対応 (Stop 後の補足通知など)
- ドメイン別カタログ (コーディング / DevOps / データ分析で出し分け)
- 回帰テスト CI 整備

## 10. ディレクトリ構造

```
~/.spotter/
├── config.json                # Spotter 設定
├── tool-catalog/              # ツール用途カタログ
│   └── tools.yaml             # メインカタログ (v0.1 は 1 ファイルに全ツール記載)
│                              # カタログ分割 (mcp-tools.yaml / builtin-tools.yaml) は
│                              # v0.3 の MCP 自動列挙時に設計 (YAGNI)
├── workdir/                   # 隔離実行ディレクトリ
│   └── (CLAUDE.md 置かない)
├── bin/
│   ├── daemon.mjs             # セッション常駐デーモン本体
│   └── hook-client.mjs        # hook からデーモンへ通知するクライアント
├── hooks/
│   ├── session-start.mjs      # SessionStart hook (デーモン起動)
│   ├── user-prompt.mjs        # UserPromptSubmit hook
│   ├── pre-tool-use.mjs       # PreToolUse hook (v0.2)
│   ├── stop.mjs               # Stop hook
│   └── session-end.mjs        # SessionEnd hook (デーモン shutdown)
├── runtime/                   # セッション単位の動的データ
│   └── session-<id>.sock      # デーモンとの通信 socket
└── logs/                      # 監査ログ
    ├── daemon-<session_id>.log
    └── audit.log
```

## 11. 成功指標

「ツール呼び出し漏れ検出」をどう測るか。

- **単体指標**: YAML の `test_cases` 合格率。実行は `spotter catalog lint` 経由で Haiku を**実呼び**して検証する (モックは使わない、§14.1 silent fallback 禁止の思想に従い実運用と同経路で検証)
- **実運用指標**:
  - 「Spotter が指摘した」回数 / 「指摘に Bell が従った」回数 / 「結果ユーザーが納得した」回数
  - 「UserPromptSubmit で先回り検出」率 / 「Stop で事後差し戻し」率 (透明化採用で 2 応答連続が発生するため、先回り率の最大化が UX 上重要)
  - Haiku JSON 出力遵守率 (v0.2 のリトライ設計判断材料)
- **体感指標**: 「AI が時刻・過去ターン・最新情報を忘れる問題」の体感頻度

v0.1 完了判定 = **`spotter catalog lint` 全通過**。単体指標に絞り、実運用指標は v0.1 リリース後の計測対象とする。

## 12. 未解決論点

実装開始までに詰める必要がある論点:

### 12.1 ツールカタログの初期構築方法

- 手動 YAML 記述 vs MCP サーバー自動列挙
- v0.1 は手動、v0.3 で自動化を検討

### 12.2 Spotter の指摘を Bell にどう届けるか (UserPromptSubmit 段階) — 決着済 (2026-04-19)

**決定: 明示 (透明化)**。`additionalContext` に「Spotter からの推奨ツール: `current_time` (理由: ...)」の形式で載せる。Bell は「Spotter の推奨に従い〜」と明示的に触れるように応答を組み立てる。

**理由**: §13 哲学「主体に頼らない仕組み」との一貫性。監査役の存在を隠すと Spotter が壊れたときユーザーが気づけず、§14.4 が警告する「守られてる気がして実は素の Bell」状態に陥る失敗モードが発生する。

(棄却) 暗黙化 (Bell が自発的に呼んだように見せる): 体験は滑らかだが、失敗時の検知不能リスクを優先して棄却。

### 12.3 Stop hook での差し戻し: 透明化 vs 不可視化 — 決着済 (2026-04-19)

**決定: 透明化**。§8.3 の「透明化」方式 (「Spotter からの指摘: `current_time` を呼ぶべきでした。呼び直してください。」) を採用。

**理由**: §12.2 と同根 — Throughline が L3 退避を明示しているのと同じ思想で、監査役の存在を隠さないことで信頼性を担保する。体験の滑らかさより信頼性を優先する。

### 12.4 Stop hook の最初の応答を取り消せない問題への対応

Claude Code の仕様上、Bell が応答を出す前に介入する手段が UserPromptSubmit の事前注入しかない。

- **短期**: UserPromptSubmit の精度を上げて、Stop 段階での差し戻しを最小化する
- **中期**: Anthropic に Pre-Response hook の追加要望を出す (feature request)
- **長期**: ストリーミング応答への介入 API が出れば乗り換え

MVP ではこの制約を受け入れ、「Spotter が最初から指摘できれば理想、取りこぼしたら Stop で事後訂正」という 2 段構えで運用する。

## 13. 哲学との整合

クオの一貫した哲学と、本プロダクトでの表れ方:

- **主体に頼らない仕組み**: Spotter は Bell の自覚に頼らず独立して並走
- **気づく役と実行する役の分離**: Bell は発話を作る、Spotter は漏れを検出する
- **予測できないものを予測しない**: Spotter は余計な推論せず、ツール取りこぼし検出に特化
- **引き算の設計**: Spotter は CLAUDE.md を持たない、毎ターンのコンテキストもクリアする
- **想定外は throw**: silent に呑まない、ルールは §0 と同じ
- **必要により柔軟になる**: Throughline では都度起動/stateless を選んだが、Spotter では維持型が合理的な場合に躊躇なく採用する (問題の性質に応じた最適化)

## 14. §0 実装規範

Throughline の §0 と同じ思想を Spotter にも適用する。実装者 (クオおよび Claude Code) は以下を厳守する。

### 14.1 フォールバック禁止 (やむを得ない場合を除く)

想定外の状態を silent に呑み込んではいけない。

- daemon 起動失敗 → throw
- socket 疎通失敗 → throw
- Claude (Haiku) 呼び出し失敗 → throw
- YAML パース失敗 → throw
- ツールカタログ欠損 → throw
- **「動かないなら throw して原因を露出させる」が基本**

「やむを得ない場合」とは以下に限る:
- **セッション終了時の cleanup 失敗**: SessionEnd は止められないのでログ警告のみ
- **hook の非ブロッキング系イベント**: PostToolUse の記録失敗など、Bell の動作に影響しないもののみ warn ログ

上記以外で try/catch で潰すコードは **コードレビューで棄却する**。

### 14.2 動かすためだけのゴミコード禁止

「とりあえず動かすために書いた」コードは残さない。

- 仮実装・TODO だけのスタブを本流に混ぜない
- エラーを握り潰してリターンする関数を書かない
- 型や構造が曖昧なまま「そのうち直す」前提で進めない
- **動かすための暫定コードは、代替設計と一緒に提示してから書く**

MVP の範囲を狭めるのは OK (v0.2 以降に送る)。**範囲内は常に完成形**。

### 14.3 想定外は throw、想定済みはログ

Throughline §0 と同じ分類:

| 状況 | 処理 |
|---|---|
| 想定済みの正常系 | 通常処理 |
| 想定済みの異常系 (例: YAML に該当ツールなし) | 記録 + 正常リターン |
| 想定外 | throw、stderr 出力、exit code 2 |

### 14.4 daemon の異常系

daemon が落ちた / 起動してない状態で hook が発火した場合、Spotter の判定は**スキップせず、Claude Code 側にエラーを返す**。

- hook は daemon が生きてることを確認できなければ exit code 1 (非ブロッキングエラー、stderr にメッセージ)
- Claude Code は「hook error」としてトランスクリプトに表示
- ユーザーが気づいて daemon を再起動 / 調査する
- **「daemon が死んでるから pass しよう」という silent fallback は禁止**

Spotter の価値は「ツール呼び忘れを検出すること」。daemon が動いてないのに Bell の応答が通ってしまうと、ユーザーは Spotter が守ってる気になって実は素の Bell、という状況になる。これは**最悪の失敗モード**で、silent fallback で起こる。

## 15. 配布とパッケージング

### 15.1 配布形態

Throughline と同じモデル:

- **GitHub public リポジトリ** (MIT ライセンス)
- **npm パッケージ** として公開
- グローバルインストール: `npm install -g spotter`
- CLI コマンド名: `spotter` (単体コマンド想定)
- リポジトリ名も同じ: `spotter`

### 15.2 要件

Throughline と足並みを揃える:

- Node.js 22.5+ (組み込み fetch, テスト runner 等のため)
- Claude Code 2.0+ (Stop hook の block 挙動、async hook 利用のため)
- Claude Max プラン (`claude -p` で Haiku を起動するため)
- ゼロ依存を目指す (やむを得ない場合のみ依存追加、追加時は理由をコミットログに記録)

### 15.3 CLI コマンド構成

```
spotter install        # ~/.spotter/ 作成、雛形配置、hook 登録を .claude/settings.json に提案
spotter uninstall      # 逆の操作
spotter catalog edit   # ツールカタログを $EDITOR で開く
spotter catalog lint   # YAML スキーマ検証 + test_cases 実行 (Haiku 実呼び、v0.1 完了判定)
spotter daemon start   # (内部用) SessionStart hook から呼ばれる
spotter daemon stop    # (内部用) SessionEnd hook から呼ばれる
spotter status         # 現在のセッションの daemon 状態確認
spotter doctor         # 環境診断 (Node/Claude Code/socket/カタログ整合性)

# v0.3 で追加予定:
# spotter catalog refresh  # MCP サーバー列挙で tools.yaml を自動生成
```

### 15.4 セットアップフロー (ユーザー視点)

```
$ npm install -g spotter
$ spotter install
  → ~/.spotter/ 作成
  → tool-catalog/tools.yaml に雛形配置
  → .claude/settings.json (または ~/.claude/settings.json) に hook 登録を提案 (diff を表示、y/n で確認)
  → 登録完了、「次回 Claude Code 起動時から有効」表示

$ claude
  → SessionStart hook が daemon を起動
  → ユーザーは普通に Claude と話す
  → Spotter が裏でツール呼び忘れを監視
```

### 15.5 リポジトリ構造 (GitHub)

```
spotter/
├── package.json                   # npm メタデータ、bin エントリ
├── README.md                      # 使い方、コンセプト、Throughline との違い
├── LICENSE                        # MIT
├── CHANGELOG.md
├── PLAN.md                        # この計画書 (開発中のドキュメント)
├── bin/
│   └── spotter.mjs    # CLI エントリ (install/daemon/catalog/doctor のディスパッチ)
├── src/
│   ├── daemon/
│   │   ├── daemon.mjs             # デーモン本体 (イベント受信 → 責務分岐、used_tools 管理)
│   │   ├── transport.mjs          # hook ⇄ daemon 通信 (§5.6 socket 抽象 / §5.7 envelope)
│   │   └── haiku-caller.mjs       # claude -p 呼び出しラッパー (プロンプト組立 + JSON スキーマ検証)
│   ├── hooks/
│   │   ├── session-start.mjs
│   │   ├── user-prompt.mjs
│   │   ├── pre-tool-use.mjs       # v0.2
│   │   ├── stop.mjs
│   │   └── session-end.mjs
│   ├── catalog/
│   │   ├── schema.mjs             # YAML スキーマ定義とバリデーション
│   │   ├── loader.mjs             # catalog の読み込みとキャッシュ
│   │   └── lint.mjs               # catalog lint + test_cases runner
│   └── cli/
│       ├── install.mjs
│       ├── uninstall.mjs
│       ├── doctor.mjs
│       └── status.mjs
├── templates/
│   └── tools.yaml                 # install 時に配置される雛形カタログ
├── test/
│   ├── catalog.test.mjs
│   ├── daemon.test.mjs
│   └── hooks.test.mjs
└── .github/
    └── workflows/
        └── ci.yml                 # Node 22.5 / lint / test
```

### 15.6 バージョニング方針

Throughline と同じく:

- SemVer を採用 (`0.x.y` は破壊的変更を許容、`1.0.0` は破壊的変更を避ける)
- `0.1.0` = v0.1 完成、npm publish 可能な最初のバージョン
- パッチ積みはフィードバック反映に使う (Throughline が `0.3.1 → 0.3.19` と刻んだのと同じ)

### 15.7 README に書くべきこと

- 一行で何のプロダクトか (「AI がツールを使い忘れるのを防ぐ監査役」)
- Throughline との関係 (別プロダクト、思想は逆、併用可)
- インストール手順 (3行で動くこと)
- コンセプト (気づく役と実行する役の分離)
- デモ GIF or 動画 (時刻合成を Spotter が捕捉する例など)
- 制約 (Claude Max 必須、Node 22.5+、Claude Code 2.0+)
- ライセンス

## 16. 命名

### 16.1 プロダクト名の選定

**Spotter** を採用。

- **由来**: ボルダリング用語。登攀者の下に立ち、落下時に体を受け止める / 危険を声で知らせる役。射撃・狙撃における着弾観測員も Spotter と呼ばれる。
- **本質との一致**: Spotter の役割は「登る人が気づかない危険に、下から備える」。本プロダクトは「Bell が気づかないツール取りこぼしに、並走して気づく」。機能と語義が正確に対応する。
- **選定の経緯**: 抽象系 (Undertone, Backchannel) と機能メタファー系 (Spotter, Wingman) の候補から、**「気づけない AI を見守る役」という問題意識と最も直結する**として Spotter を選択。
- **Throughline との関係**: Throughline が「貫く線」という抽象命名だったのに対し、Spotter はメタファー命名。ただしどちらも**機能を直訳せず本質を示す**点では一貫する。

### 16.2 衝突確認

- プロダクト名 `Spotter` 自体は一般名詞なので、他ツールとの機能的衝突は問題になりにくい
- npm パッケージ名 `spotter` の空き状況は **publish 前に必ず確認** (`npm view spotter`)
- 取られていた場合の代替案:
  - `@kitepon/spotter` (スコープ付き、最短)
  - `claude-spotter` (用途明示)
  - `bell-spotter` (内部コードネーム活用)
- GitHub リポジトリ: `github.com/kitepon-rgb/spotter` (Throughline と同じアカウント)

### 16.3 ローカルフォルダ・コマンド名

- ローカル開発フォルダ: `spotter/`
- ユーザー側の設定ディレクトリ: `~/.spotter/`
- CLI コマンド: `spotter`
- デーモンプロセス名: `spotter-daemon`

## 17. 次のアクション

### Phase A: 着手前の並列タスク

- **npm パッケージ名の空き確認** (`npm view spotter`)
- YAML カタログ雛形作成 (`templates/tools.yaml`、v0.1 用ツール 5〜10 種: current_time, web_search, retrieval 等)
- **Claude Code の Stop hook JSON regression (Issue #10463) 疎通 spike** — 差し戻しロジックが依存するので着手前に 1 時間で動作確認

### Phase B: 骨格実装 (順次)

- `daemon.mjs` / `transport.mjs` / `haiku-caller.mjs` の 3 分離実装 (§15.5 の責務境界、§0 準拠で例外は全て throw)
- 5 つの hook スクリプト実装: `session-start.mjs` / `user-prompt.mjs` / `pre-tool-use.mjs` / `stop.mjs` / `session-end.mjs`。疎通失敗は §14.3 / §14.4 の分類で exit code を使い分け

### Phase C: CLI とビルド (並列可)

- `install` / `uninstall` コマンド (雛形配置、hook 登録 diff 提案)
- `catalog lint` コマンド (schema + test_cases 実行、v0.1 完了判定)
- `package.json` と `bin` エントリ整備

### Phase D: 検証と配布

- `npm link` で手元の Claude Code に接続して動作確認
- **異常系テスト**: daemon kill 時に全 hook が throw することを確認、silent fail が発生しないことを確認
- GitHub リポジトリ作成、README 執筆
- `0.1.0` タグ打ちと npm publish

### Phase E: 運用計測 (v0.2 設計材料)

- 1 週間運用して、実際にツール呼び出し漏れを何件捕捉できたかを測定
- Haiku JSON 出力遵守率を記録 (下振れ時は v0.2 でリトライ設計)
- UserPromptSubmit 先回り率 vs Stop 差し戻し率の比率を記録 (透明化 UX の検証)
- 結果を元に v0.2 設計 (孤児プロセス cleanup、リトライ、リソース計測) に進む

---

## 18. v0.1 実運用事故と設計見直し (2026-04-19 追記)

v0.1.0 / v0.1.1 を npm 公開後、実 Claude Code 環境で動作検証したところ、**プラン §5.4 の中核前提が破綻していることが判明**した。両バージョンとも npm 上で **deprecate 済** (`npm deprecate claude-spotter@0.1.x`)。

### 18.1 観測された事故

手元の Claude Code セッションで `npm install -g claude-spotter` 後 41 秒以内に:

- **daemon プロセスが 213 個 spawn** — プラン §5.4 の「セッション中 1 プロセス常駐」前提に対して桁違いの実数
- 各 daemon は独立した UUID session_id で起動、1 回の UserPromptSubmit を受け取った後 **Haiku 28s タイムアウトで終了**
- 同時並走による Anthropic API saturation で Haiku 呼び出しが全滅
- `npm uninstall -g` では **preuninstall ライフスクリプトが走らず**、hook が `~/.claude/settings.json` に残存

### 18.2 根本原因

Claude Code の `SessionStart` hook は、**トップレベルセッション開始時の 1 回だけではなく、subagent (Task tool) 呼び出し毎にも発火**する。session_id はその subagent セッション固有の新 UUID になる。

プランは「SessionStart = ユーザーが claude を立ち上げた瞬間の 1 回」という単純化モデルを採用していたが、現実は:

- トップレベルセッション: 1 件の session_id (source=`startup`)
- 各 subagent: 独自の session_id (source は subagent 種別に依存)
- `/compact` / `/clear` / `resume`: それぞれ SessionStart 発火

v0.1 のように「session_id をキーに daemon を立てる」と、subagent 使用回数に比例して daemon が増殖する。cleanup 機構は v0.2 送り (§9.2) だったため、孤児累積が直撃した。

### 18.3 v0.2 の設計見直し方針

プラン §5.4 で却下していた**都度起動型**を再評価する:

| 観点 | 維持型 (v0.1) | 都度起動型 (v0.2 候補) |
|---|---|---|
| daemon 管理 | セッション単位プロセス | プロセスなし (hook 毎に `claude -p`) |
| ツールカタログ送信 | 1 回ロード後メモリ常駐 | 毎回 stdin で送信 |
| token コスト | 低 (カタログ非再送) | 高 (毎回送信) |
| subagent 問題 | **破綻** (daemon 増殖) | 起こらない (状態なし) |
| 孤児プロセス | 発生 | 発生しない |
| 実装複雑度 | 高 (socket / pipe / PID 管理) | 低 |

「維持型 10 倍の経済性」という §5.4 の試算は **subagent 非発生前提** の値。現実は subagent 数 × 維持型コスト で計算が逆転する可能性がある。

**代替案**: subagent session を検出したら daemon 起動を **スキップ** する条件分岐 (hook input の `source` や `agent_id` フィールドで判定) を入れる。ただしこれは subagent の発話を監査対象から外すことを意味し、設計目的とトレードオフ。

### 18.4 v0.2 で採用した防御多層 (2026-04-19 実装済)

18.2 で棚上げしていた「都度起動型への全面書き換え」は棄却し、**原設計の維持型 daemon を保ったまま複数の独立した防御層で再発を防ぐ**方針に確定した。ユーザー判断 (2026-04-19):

> daemon があったほうが都合がいいのなら daemon は否定しない。daemon が親セッションと新たに作ったセッションの紐づけ (親と子) を把握し、子からの呼び出しであれば無視すればいい。これはもっとも簡単な実装だ。

実装された 5 層 (+ セッション維持機構):

1. **`SPOTTER_PARENT_PID` env var** (primary): daemon が `claude -p` 起動時に自身の PID を env に立てる。子プロセスで起動する全 hook は env を見て即 `exit 0`。Spotter 自身の再帰的 daemon spawn を遮断
2. **`agent_id` フィールド判定**: Bell が Task tool で呼び出した subagent の hook は `agent_id` を持つ。各 hook はこれを検出して即 `exit 0` (subagent は監査対象外)
3. **`source === 'startup'` 限定**: `/compact` / `/clear` / `--resume` / `--continue` は SessionStart を新 session_id で発火させるが、`source=startup` でない限り daemon spawn をスキップ
4. **PID preexist check**: daemon 起動時に `pidFilePath(sessionId)` を確認、既存 PID が生きていれば `DaemonAlreadyRunningError` を throw。CLI は exit 0 で撤退 (既存 daemon がそのまま機能する)
5. **10 秒 Haiku call ウィンドウ**: daemon は自身の claude -p spawn 時刻を記録、直後 10 秒に来る `user_input` / `turn_end` は pass を即返す。1〜4 をすり抜けたケースの最終防衛線。10 秒以内の正当なターン終了判定が空振りするトレードオフはユーザー了承済み (「失うのは最適利用能力 1 回」)

### 18.5 §5.4 経済性の復活 (session-scoped Haiku)

上記とは別に、§5.4 の「カタログ 1 回ロード、毎回は可変情報のみ」という経済性の主張を v0.2 で**真に実現**した:

- daemon 起動時に `haikuSessionId = randomUUID()` を 1 個生成
- 初回 Haiku 呼び出し: `claude -p --session-id <haikuSessionId>` で新規 Haiku 会話を作成、システムルール + カタログ + user_input をプロンプトに含める
- 2 回目以降: `claude -p --resume <haikuSessionId>` で同 Haiku 会話を継続、**カタログは送信せず** user_input / used_tools / final_response だけを送る
- `--bare` は auth 状態を読まない仕様のため使えないと判明、env 経由の hook 遮断で代替
- 並行リクエスト race による初回プロンプト 2 重送信は Promise chain ベースの mutex で防止

監査役 Haiku の生存期間 = 親セッション単位、という設計が成立。

### 18.6 A-2 Haiku ウォームアップ (v0.2.1 改修)

v0.2.0 の実運用観測で **UserPromptSubmit 経路でのみ `E_HAIKU_TIMEOUT` が多発** することを確認した (観測: 20 分で 14 件、全て `handler error on user_input`)。Stop hook (`turn_end`) でのタイムアウトはゼロ。

#### 原因

`user_input` は daemon にとって最初の Haiku 呼び出し (新 session_id = 新 daemon = 初回 spawn) になるケースが多く、Windows 上で `cmd.exe /c claude.cmd -p --session-id <uuid> --model haiku ...` を起動してから JSON 応答が返るまでに 28 秒を超えることがある。対して `turn_end` は `--resume` 経由で会話が温まっているため応答が速い。28 秒 timeout が不当に厳しいのではなく、**初回 spawn の場所が UserPromptSubmit hook のブロック中に置かれている**のが本質。

#### 採用した対策 — 非同期ウォームアップ (A-2)

SessionStart → `spotter daemon start` で起動する daemon に `warmup: true` オプションを渡す。daemon は `server.listen` 完了・PID ファイル書き込み後に、**fire-and-forget で Haiku を 1 回呼ぶ** (`claude -p --session-id <uuid>` で新規会話作成、`buildWarmupPrompt` で固定の trivial prompt を送る)。

- SessionStart hook の readiness ping は `daemon listening` 確認だけで即完了 → **ユーザー体感の SessionStart 遅延はゼロ**
- ユーザーが最初のプロンプトを入力するまでの数秒〜数十秒の間に裏で Haiku がコールドスタートを終える
- 最初の `user_input` は既存の mutex (`haikuChain`) で warmup 完了を待ち、その後 `--resume` で高速応答
- warmup 失敗時は `haikuInitialized=false` のままなので、次の real call が仕切り直し (従来動作に戻るだけ、悪化なし)
- warmup 完了後は `lastHaikuCallAt = 0` にリセットして、10 秒ウィンドウ (layer 5) が warmup 直後の合法的 user_input を潰さないようにする。SPOTTER_PARENT_PID env 他のレイヤーで recursion は既に遮断されているのでこのリセットは安全

#### 却下した代替案

- **A-1 同期ウォーム**: SessionStart で warmup 完了を待つ → Bell 起動が 15〜25 秒遅くなる体感悪化、却下
- **A-3 CLI 常駐化**: `claude -p` を毎回 spawn せず stdin/stdout ストリーミングで受け渡し → Claude CLI の streaming API 仕様依存が強く Windows 安定性未検証、v0.3 以降の選択肢として棚上げ
- **A-4 Anthropic API 直叩き**: 認証移植の制約、棚上げ
- **timeout 値を伸ばす**: UserPromptSubmit hook の 30 秒境界に先に当たるため単独では無効、根本解決にならない

#### 非採用: subagent スキップの追加実装

A-2 とは別に観測された「20 分で 28 daemon 生成」問題 (§18.4 の 5 層防御がすり抜けている疑い) は、既存層のバグ調査として別タスク化。A-2 実装自体は新規層の追加ではなく初回 spawn の前倒しなので、increase 数を直接減らす効果はない (各セッションのコールドスタートを SessionStart 時に移しているだけ)。

### 18.7 作業ログ

- 2026-04-19 02:18 UTC: v0.1.0 publish
- 2026-04-19 02:30 UTC: v0.1.1 publish (postinstall 追加)
- 2026-04-19 02:40 UTC: 手元で `npm install -g` 実行 → 41 秒で 213 daemon 累積、Haiku 全滅を確認
- 2026-04-19 02:55 UTC: 全 daemon kill、settings.json 手動修復、`npm deprecate` 実施
- 2026-04-19 03:XX UTC: v0.2.0 設計監査 (CRITICAL 2 / HIGH 3 / MEDIUM 3 / LOW 2)、抜け穴を 5 層構成で補完
- 2026-04-19 04:XX UTC: C2 実機検証 (--bare + --session-id 組み合わせが "Not logged in" で失敗することを確認、--session-id / --resume の組み合わせで会話維持成立することを確認)
- 2026-04-19 04:XX UTC: v0.2.0 実装完了、tests 52 pass / 1 skip / 0 fail
- 2026-04-19 13:XX JST: v0.2.0 実セッション観測 — `user_input` 経路の Haiku timeout が 20 分で 14 件 / 全 daemon 28 個生成・4 個残存。A-2 非同期ウォーム + warmup 後の 10 秒ウィンドウリセットを実装 (v0.2.1)、tests 56 pass / 1 skip / 0 fail

## Appendix A: 参考資料

- Throughline GitHub: https://github.com/kitepon-rgb/Throughline
- Claude Code hooks reference: https://code.claude.com/docs/en/hooks
- Reflexion 論文: https://arxiv.org/pdf/2303.11366
- LangGraph Reflection Agents: https://blog.langchain.com/reflection-agents/
- LLM Agents Hallucinations Survey: https://arxiv.org/html/2509.18970v1

## Appendix B: 議論の記録

この計画書は 2026-04-18 夜、クオとベルの議論から生まれた。きっかけは「Claude が現在時刻を間違える」という具体的な体験。そこから「ツールに気づけない AI」という普遍問題に抽象化され、別プロダクト構想に展開した。

- 22:59 JST: ベルが「深夜1時」と時刻を合成して誤断言
- クオが「なぜ Claude には時刻がないのか」と問う
- 「ツールに外出し」の弱点が浮上
- クオが「別エージェントで並走監査する」案を提示
- 市場調査でこの切り口が未着手であることを確認
- 2 時間の議論で設計確定、本計画書作成に至る
- **深夜: 「Bell から呼ぶ vs 並走型」論争、並走型採用決定**
- **深夜: 「都度起動 vs 維持型デーモン」論争、維持型採用決定**
  - トークン消費の経済性 (約10倍の差)
  - プロセス起動コスト削減
  - 「コンテキスト蓄積を避ける」要件は「Claude 呼び出しを毎回独立プロンプトに」することで両立
  - クオの一言: 「必要により柔軟になるのが俺だ」 — Throughline の stateless 思想に縛られず、問題の性質に応じて最適解を選ぶ姿勢を明示
- **深夜: §0 実装規範の明文化** (フォールバック禁止、ゴミコード量産禁止)
- **深夜: OSS/npm 配布方針確定** (Throughline と同形態: GitHub public + MIT + グローバルインストール)
- **深夜: プロダクト名を `Spotter` に決定** (ボルダリング由来、「気づけない人の傍で備える役」という機能直結の命名)
