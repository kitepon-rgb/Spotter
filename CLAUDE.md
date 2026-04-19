# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 必読: Open Issues

**新規作業に入る前に [docs/open-issues.md](docs/open-issues.md) を必ず読むこと**。Spotter で現時点で塞がっていない穴と実測未検証の懸念を優先度別 (P0/P1/P2) に集約した唯一の真実源。バージョンごとのリリースノート (下記 Repository Status / [CHANGELOG.md](CHANGELOG.md)) は歴史記録であって、現状把握には使わない。

課題を解決したら open-issues.md から項目を消し、CHANGELOG にリリース番号とともに記録する運用。

## Repository Status

**v0.11.0** (2026-04-19): **短プロンプトの Haiku スキップ**。ユーザー入力が trim 後 10 文字 (コードポイント) 以下なら UserPromptSubmit hook で早期 return し、daemon へ `user_input` を送らない。結果、daemon は `state.lastUserInput=null` のまま維持され、次の turn_end が `reason=no_user_input` で自動 pass する。挨拶・相槌・短い質問 ("今何時?" "ありがとう" "ok done" 等) でレイテンシ 0、preamble 57 件の無駄打ちを回避。daemon 側に閾値ロジックを足さず hook 層だけで閉じる最小実装。詳細は [CHANGELOG.md](CHANGELOG.md)。

**v0.10.0** (2026-04-19): **project scope `.mcp.json` 対応**。v0.9.0 は user scope (`~/.claude/.mcp.json`) だけ読んでいたため、プロジェクト直下の `.mcp.json` に登録された MCP サーバー (project 固有) の env / headers を拾えなかった。`<projectRoot>/.mcp.json` も読んで user scope に merge (project 勝ち = Claude Code precedence と整合)。`readMcpServers({projectRoot})` シグネチャ変更 + `refresh` → `investigate` → `mcp-config` の経路で projectRoot を伝搬。詳細は [CHANGELOG.md](CHANGELOG.md)。

**v0.9.0** (2026-04-19): **`.mcp.json` を真実源として読み込み、user-registered MCP の認証情報を live fetch に活用**。v0.8.0 の HTTP transport 実装後も `claude mcp list` / `claude mcp get` は secrets を CLI 出力に含めないため x-api が 401 で落ちていた。ユーザー指摘で `~/.claude/.mcp.json` を直接読めば stdio の env / HTTP の headers が手に入ると判明。`src/tool-db/mcp-config.mjs` を新設、`listMcpServers` を CLI + `.mcp.json` 併用に、`spawnAndQuery` が env を merge、`listToolsHttp` が headers を受理。結果 x-api の 9 ツール (get_trends / search_tweets 等) が live fetch で投入されるようになり、手書き baseline 不要に。`.mcp.json` はユーザー自身が secrets を書いた設定ファイル = `.credentials.json` (Anthropic OAuth) とは性格が違い、v0.8.0 の境界線に抵触しない。詳細は [CHANGELOG.md](CHANGELOG.md)。

**v0.8.0** (2026-04-19): **HTTP/SSE MCP transport 対応 + Windows `.cmd` 経路 fix + claude.ai 系 MCP の hardcoded baseline**。v0.7.0 を新規セッションで実測したら (1) Windows で `spotter db refresh` が `spawn claude ENOENT` で起動すらせず、(2) fix 後も Gmail / Calendar / Drive / x-api の 4 サーバーが `transport not yet supported` で全部スキップされ Haiku 視野に入らず、(3) `claude.ai ...` 系は `claude mcp get` が `No MCP server found` を返し OAuth proxy 経由で動いている (Spotter は credentials を読まない方針) と判明。3 本同時に解決: MCP Streamable HTTP transport 実装 (`src/tool-db/investigate-mcp-http.mjs`)、Windows `.cmd` は `cmd.exe /c` 経由 (`execClaude` / `buildStdioSpawn`)、claude.ai 系 25 件を deferred-baseline と同じパターンで手書き (`src/tool-db/claude-ai-baseline.mjs`)。`spotter db rebuild` で **48 tools resolved** (deferred 17 + claude.ai 25 + caveat 6)。live HTTP fetch は 401/403 で落ちるが baseline が吸収。詳細は [CHANGELOG.md](CHANGELOG.md)。

**v0.7.0** (2026-04-19): **カタログを tool-db に置き換え**。手書きの `tools.yaml` (current_time / web_search 等 5 件の抽象ツール) を廃止し、**実際にセッションで使える MCP ツール + Claude Code 組込み 遅延ツールの name + description を自動収集してキャッシュする** 仕組みに切り替え。Haiku に渡すのは `{name, description}` のペアだけ — schema は不要 (どう呼ぶかは Bell が ToolSearch で解決する役割分業)。MCP description は MCP サーバーから JSON-RPC `tools/list` で直接取得。3 段階キャッシュ (ローカル → グローバル → 調査して両方に追記)、drift 補正、明示的無効化なし。これで Caveat 等の MCP ツールが Haiku の視野に入る。詳細は [CHANGELOG.md](CHANGELOG.md) と設計思想 [docs/catalog-design-deferred-mcp.md](docs/catalog-design-deferred-mcp.md)。

**v0.6.2** (2026-04-19): **親プロセス watch で孤児 daemon を自動回収**。SessionEnd が発火しない経路 (Claude Code crash / kill / IDE reload) で daemon が永久に残る問題への対処。SessionStart hook が `--parent-pid <process.ppid>` (Claude Code 本体 PID) を daemon に渡し、daemon は 5 秒間隔で `process.kill(parentPid, 0)` を ping、ESRCH なら自身を shutdown。実運用で 9 daemon 中 8 個が孤児だった (手動 kill 必要) 状態を解消。詳細は [CHANGELOG.md](CHANGELOG.md)。

**v0.6.0** (2026-04-19): **Preamble-once 化**。v0.5.2 で可視化した duration_ms を実測したところ、`first=7.4s → resumed=12.5s → resumed=20.2s` と resumed のほうが遅いという設計意図と逆の結果。真因は「`--resume` で session を継いでいるのに毎回 full prompt (role + schema + catalog + few-shot) を再送して session を肥大化させていた」こと。`buildPreamble({ catalog })` を新設、初回 1 回だけ送って以降は per-turn delta (stage マーカー + 入力タグ) のみにした。同作者の OpenClaw が Discord → Claude 長期セッションで使っているパターンを持ち込んだ。role collapse 耐性は既存 reset 機構がそのまま機能する (reset 時に preamble 再送)。詳細は [CHANGELOG.md](CHANGELOG.md)。

**v0.5.2** (2026-04-19): Haiku 呼び出しレイテンシ可視化。daemon ログに `mode=first|resumed, duration_ms=<N>` を追加し、`--resume` 経路の cold-start 削減効果 / role collapse 回復時間 / timeout 余裕を観測可能にした。機能変更なし、`isFirstCall` getter 追加 + ログフォーマット拡張のみ。これで v0.5.0/v0.5.1 の既知課題 (resume 実効削減量未検証、role collapse 実発生頻度未観測) が数値で判断できる状態になる。詳細は [CHANGELOG.md](CHANGELOG.md)。

**v0.5.1** (2026-04-19): v0.5.0 の `buildSpawnArgs` が `--session-id` と `--resume` を併用していたバグの hot-fix。claude CLI は `--fork-session` なしの両立を拒否するため、resume 時は `--resume <uuid>` 単独に修正。これにより v0.5.0 の session-scoped 機構が実際に生きた状態で動き出した。

**v0.5.0 実装完了** (2026-04-19)。**v0.4.0 で捨てた session-scoped Haiku を事後回復機構付きで復活**。v0.4.x stateless の毎ターン cold-start 問題 (Bell 応答後に 30 秒前後動きが止まる) を解消するため、`claude -p --session-id <uuid> --resume <uuid>` で同一セッション再接続。v0.4.0 で session-scoped を捨てた理由の **Haiku role collapse** (persona drift で JSON 契約破棄) は、構造的予防ではなく **JSON パース失敗検知 → session renew + silent pass** の事後回復で処理する方針へ変更。これは §0 の「想定済み異常 = 記録 + 正常リターン」の分類変更であり、silent fallback 新規導入ではない。詳細は [CHANGELOG.md](CHANGELOG.md)。

**v0.4.4** (2026-04-19): Stop hook が **Bell の最終応答を Haiku に渡していなかったバグ**を修正。`input.final_response` (存在しないフィールド) を廃止し、`input.transcript_path` から JSONL 末尾の assistant text だけを抽出する `getLastAssistantText()` を新設 ([src/hooks/transcript-reader.mjs](src/hooks/transcript-reader.mjs))。thinking / tool_use ブロックは除外、ユーザーが見た最終応答テキストのみ Haiku に渡る。Throughline から移植 (MIT, 同作者)。

**v0.5.0 の核心設計**: daemon は session-scoped (hook イベント集約・used_tools 記録)。**Haiku 呼び出しも session-scoped** (`--session-id` を daemon 生存期間中保持、2 回目以降は `--resume` で再接続)。5 層防御 (`SPOTTER_PARENT_PID` env / `agent_id` gate / `source=startup` 限定 / PID preexist check / 10 秒ウィンドウ) は維持。プラン §18.3 の都度起動型 (daemon レベルでの都度起動) は引き続き棄却、再議論しない。

### v0.5.0 で投入した対策

- **Session-scoped Haiku** (`createHaikuCaller` @ [haiku-caller.mjs](src/daemon/haiku-caller.mjs)): closure で `currentSessionId` と `isFirstCall` を保持。初回は `--session-id` のみ、以降は `--session-id + --resume`。2 回目以降の cold-start を消す。
- **Role-collapse recovery** (`runHaikuJudgment` @ [daemon.mjs](src/daemon/daemon.mjs)): `parseHaikuResponse` が `E_HAIKU_SCHEMA` を throw したら `callHaiku.reset()` で session-id を renew し、当該ターンは `{pass: true, reason: 'role_collapse_reset'}` で silent pass。次ターンから fresh session で監査再開。
- **Timeout 短縮** (60s → 30s): 2 回目以降は cold-start がないので延長の必要なし。初回だけは 30s 以内に終わる想定。
- **Warmup 削除**: stateless 対策だったので不要。

### v0.5.0 時点の既知課題 (歴史記録)

この時点の未解決項目は現在 [docs/open-issues.md](docs/open-issues.md) に統合されている (`--resume` 実効 spawn 削減量 / preamble caching コスト / role collapse 発生頻度)。カタログのツール名抽象問題は v0.7.0 の tool-db 置換で消滅済み。

### Spotter 本体プロジェクトでの install に関する警告

**Spotter リポジトリで Spotter を install すると、Bell 側の会話が Spotter 自体の議論になり、Haiku が自己言及で混乱する**。v0.5.0 で session-scoped に戻したため、過去より persona drift リスクが高い環境。開発時は他プロジェクトで動作確認するか、install せず手動で `spotter catalog lint` を回すこと。

## Product Concept (一行)

**Bell (主役の Claude) の発話予定を、ツール一覧を完全把握した別エージェント (Spotter) が並走監査し、ツール呼び忘れを検出する。** 気づく役と実行する役の分離。

## Architecture の核 (実装判断に効く部分)

- **並走デーモン型**: SessionStart で 1 プロセス起動、SessionEnd で shutdown。Bell から呼ぶのではなく、hook 経由で **Bell の意思と独立に** user_input / tool_used / turn_end を受け取る。「Bell が自覚して呼ぶ」設計は **本プロダクトの存在意義を破壊する**ので却下されている。
- **Claude 呼び出しは session-scoped + preamble-once + 事後回復** (v0.6.0 で更新): `claude -p --session-id <uuid>` で初回セッション確立、以降 `--resume` で再接続。**初回のみ preamble (role + schema + few-shot + catalog) を送り、以降は per-turn delta のみ**送ることで session を肥大化させない (v0.5.x は毎回 full 送信していて resumed が first より遅いという逆の結果が出ていた)。role collapse は `parseHaikuResponse` が `E_HAIKU_SCHEMA` を返した瞬間に `callHaiku.reset()` で session-id を rotate、次回呼び出しで preamble が新 session に自動で再送される。当該ターンは silent pass。**これは §0 の silent fallback 禁止違反ではなく、「想定済み異常 = 記録 + 正常リターン」の適用**。
- **隔離実行**: Spotter の workdir (`~/.spotter/workdir/`) には **CLAUDE.md を置かない**。プロジェクト文脈に引きずられないことが品質保証の要件。
- **ツールカタログは YAML**: `purpose` / `when_to_use` / `keywords` (一次判定用) と `usage` / `examples` (確定後) を分離した 2 段階コンテキスト。`test_cases` フィールドで回帰検出する。
- **Stop hook の介入**: `decision: "block"` + `reason` で Bell に継続応答を生成させる。`stop_hook_active: true` を見たら即 pass することで max 1 回ループを担保 (Claude Code 側の機構で自動)。

## §0 実装規範 (最重要)

コードを書く前にこの 3 点を内面化すること。プラン §14 の詳細版だが、実装時に効くのはここ:

1. **フォールバック禁止**. daemon 起動失敗 / socket 疎通失敗 / Haiku 呼び出し失敗 / YAML パース失敗 / カタログ欠損は **全て throw**. `try/catch` で潰すコードはレビューで棄却される。例外は SessionEnd の cleanup 失敗 (warn ログのみ、セッション終了は止めない) と PostToolUse 等の非ブロッキング系のみ。
2. **「daemon が死んでたら pass」は最悪の失敗モード**. ユーザーは Spotter が守ってる気になって実は素の Bell、という状況は silent fallback で起こる。hook が daemon 疎通できなければ exit code 1 + stderr にメッセージ。
3. **動かすためだけの暫定コード禁止**. スタブ・TODO のみの関数・型が曖昧なコードを本流に混ぜない。MVP スコープを狭めるのは OK (v0.2 に送る)、**範囲内は常に完成形**。暫定コードを書く必要があるなら代替設計と一緒に提示してから書く。

想定済み異常 (例: カタログに該当ツールなし) は記録 + 正常リターン。**想定外**は throw + stderr + exit code 2。この分類を曖昧にしない。

## Planned Stack (実装時の拘束)

プラン §15 より、実装が始まったらこれらを満たすこと:

- **Node.js 22.5+** (組み込み fetch, test runner 使用)
- **Claude Code 2.0+** (Stop hook block 挙動, async hook 利用)
- **Claude Max plan** (`claude -p` で Haiku 起動)
- **ゼロ依存志向**. 依存追加時は理由をコミットログに記録。
- パッケージング: `npm install -g spotter`, CLI 名 `spotter`, MIT ライセンス。

## Planned Commands (実装後)

プラン §15.3 で定義済み。実装時はこの構成を逸脱しない:

```
spotter install / uninstall
spotter catalog edit / lint / refresh
spotter daemon start / stop       # 内部用 (hook から呼ばれる)
spotter status / doctor
```

テストランナーは Node 組み込み (`node --test`)、CI は `.github/workflows/ci.yml` で Node 22.5 / lint / test を走らせる想定。

## MVP スコープ境界

v0.1 に含める / 含めないの判断で迷ったらプラン §9 を参照。**越境禁止**:

- v0.1: SessionStart/UserPromptSubmit/**PreToolUse**/Stop/SessionEnd hook + 手動 YAML 1 ファイル + 同期実装 + 差し戻し 1 回 + `spotter catalog lint` (test_cases を Haiku 実呼びで検証)
- v0.2: 孤児プロセス cleanup + Haiku JSON 遵守率計測 + リトライ設計 (必要時)
- v0.3: MCP サーバー列挙によるカタログ自動生成 + カタログ分割 + `/ask-spotter` スラッシュコマンド
- v0.4+: async hook, ドメイン別カタログ, CI 回帰テスト整備

「ついでに v0.2 の機能も入れておく」は棄却する。(2026-04-19 監査反映: PreToolUse は used_tools 空による誤検出回避のため v0.1 に前倒し)

## 決着済みの設計判断 (2026-04-19)

プラン §12.2 / §12.3 の未解決論点 + 実装方針の確定事項。これらは**再議論しない**:

- **指摘の届け方**: 透明化採用。UserPromptSubmit の `additionalContext` も Stop hook の `reason` も、Bell が「Spotter からの指摘」を明示するよう書式を組む。プラン §12.2 / §12.3 参照
- **Haiku への入出力**: 構造化 JSON で固定 (`{pass: bool, missing_tools: [{name, reason}]}`)。自由記述不採用、**リトライなし**。JSON スキーマ不遵守は §14.1 に従って throw。プラン §5.5 参照
- **OS 間 socket 抽象**: Node.js `net` モジュールで Windows (Named Pipe `\\.\pipe\spotter-<id>`) と macOS/Linux (Unix socket `~/.spotter/runtime/session-<id>.sock`) を同一 API で扱い、`process.platform === 'win32'` でパスのみ分岐。プラン §5.6 参照
- **hook ⇄ daemon メッセージ契約**: 改行区切り JSON 1 行。envelope `{id, event, session_id, payload}` / response `{id, ok, result|error}`。タイムアウト表と error code (`E_CATALOG_MISSING | E_HAIKU_SCHEMA | E_HAIKU_TIMEOUT | E_INTERNAL`) を固定。プラン §5.7 参照
- **SessionStart の daemon 起動**: readiness ping が通るまで最大 3 秒ブロック、通らなければ throw。UserPromptSubmit 側で retry しない。プラン §9.1 参照
- **PreToolUse を v0.1 に前倒し**: 当初 v0.2 予定だったが、used_tools が空のまま Stop 判定すると既使用ツール再指摘の誤検出が頻発するため v0.1 に移動 (2026-04-19 監査反映)

## 未解決論点 (設計上の開かれた選択)

プラン §12 のうち、実装段階ではなく **設計思想レベルで開いたまま** の論点。独断で決めずユーザーに確認すること。実装レベルの穴 (Spotter の現コードに存在する技術的課題) は [docs/open-issues.md](docs/open-issues.md) を参照。

- **最初の応答を取り消せない仕様への中長期対応** (§12.4): Stop hook で差し戻せるが、ユーザーが最初の応答を一瞬でも目にする点は Claude Code 側の仕様で変えられない。Pre-Response hook 相当の feature が来たら全面見直しの可能性

§12.1 (カタログ初期構築の手動 vs 自動列挙) は v0.7.0 の tool-db 置換で完全に自動側に確定したため、未解決から削除済み。

## Related Project

**Throughline** ([github.com/kitepon-rgb/Throughline](https://github.com/kitepon-rgb/Throughline)) — 同じ作者の既存プロダクト。思想は逆 (引き算=退避 vs 足し算=気づかせ) だが、**「主体に頼らない仕組み」** という哲学と §0 実装規範を共有する。このリポジトリの `.vscode/tasks.json` が起動している `token-monitor` は Throughline のもの。
