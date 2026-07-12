# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 必読: Open Issues

**新規作業に入る前に [docs/open-issues.md](docs/open-issues.md) を必ず読むこと**。Spotter で現時点で塞がっていない穴と実測未検証の懸念を優先度別 (P0/P1/P2) に集約した唯一の真実源。バージョンごとのリリースノート (下記 Repository Status / [CHANGELOG.md](CHANGELOG.md)) は歴史記録であって、現状把握には使わない。

課題を解決したら open-issues.md から項目を消し、CHANGELOG にリリース番号とともに記録する運用。

復旧・配布・model評価計画は完了し、
[docs/archive/03_current-state-recovery-plan.md](docs/archive/03_current-state-recovery-plan.md) へ退避した。
現行の運用基準は [docs/04_operational-slo.md](docs/04_operational-slo.md)、残課題は
[docs/open-issues.md](docs/open-issues.md) を正とする。
`docs/archive/SPOTTER_HOOK_PARITY_TODO.md` は実装済みの履歴台帳。

## Repository Status

**v1.4.19 (published 2026-07-12)**: 親セッションとの出力信頼境界を修正する。監査用AIの
`reason` / `raw`、backend message、provider stdout / stderr は Hook 出力へ渡さず、Claude / Codex
共通のルールベース projector が catalog 照合済みの安全なツールIDだけを固定・非命令形の助言へ
変換する。`Stop` finding / failure の次ターン pending 配送は廃止し、finding は構造Hook event、failureは
allow-list済み固定 `systemMessage`・固定stderr・構造eventへ分離する。旧 pending は内容を読まずに
same-session fileだけ削除する。`decision:"block"` / exit 2による継続や入力消去は追加しない。
公開SHAは`5393919`、CIはmacOS/Linux/Windows × Node 22.5/22.xの6/6 green。`v1.4.19` tag、
npm `latest`、GitHub Release、このMacのregistry由来global installを1.4.19へ同期した。

**v1.4.18 (released 2026-07-12)**: Codex auditor model を versioned policy に集約し、production default を
反復 fixture 評価で24/24 exact・FP/FN 0・timeout 0だった `gpt-5.6-terra × medium` へ昇格した。
`gpt-5.6-luna × low` / `gpt-5.6-terra × low` は比較 profile として残す。backend は model selection を生成時に一度だけ解決し、
成功・失敗・diagnostics に effective
selection と検証状態を残す。`spotter auditor model-matrix` は versioned fixture の hash、Codex CLI
version、schema / exact、FP/FN、p50/p95、timeout、anomaly を bounded artifact に記録するが、
`promotionEligible:false` 固定で production を自動変更しない。2026-07-12 の初回live smokeはCodex CLI
usage limitで全12 runが失敗したが、Pro20回復後のrepeat=3を2回実行し、Terra lowが合算23/24 exactで
baseline 18/24、Luna low 17/24より最良だった。2回目でTerraも1件見逃したためmediumを追加評価する。
Codex JSONL token usageは取得済み。Terra mediumは追加検証で24/24 exact・FP/FN 0・timeout 0となり、
owner裁定でproductionへ採用した。ChatGPTプランの金額costは取得不能として明示した。backend/stage別の
実運用SLOは `docs/04_operational-slo.md` に固定した。非対応model専用エラーと公式2-source更新監視も追加し、
provider本文のredactと評価なしの自動昇格禁止を維持する。詳細は
[RAG](rag/openai-model-policy/spotter-auditor-model-policy.md)。Codex CLI利用上限は
`E_CODEX_CLI_USAGE_LIMIT` として認証失効・generic exitから分離し、リセット待ち／プラン確認を案内する。

**v1.4.17 (published 2026-07-12)**: Codex `SessionStart async:true` を canonical sync command
handler へ修正し、upgrade normalization と readiness diagnostics を追加。Claude / Codex Stop backend
failure は warning pending を次の same-session prompt へ1回配送する。Codex used-tools は current-turn の
shell / MCP / agent call を bounded に認識し、未知 transcript を anomaly にする。clean pack / temp install
smoke は RC boundary `1c67698` で green。main HEAD は既に v1.4.18 development なので、v1.4.17 は
`1c67698` 起点の `codex/release-v1.4.17` に **v1.4.17 専用** README / CHANGELOG を置き、candidate
`6ea6a2b` を作成済み。main の `auditor model-matrix` / v1.4.18 profile 記述は含まず、CLI help /
58-entry pack / 383 tests と照合済み。OS CI 6/6 green 後、最終 metadata SHA `7987f2a` を tag / npm /
GitHub Release へ公開し、npm `latest` とこの Mac の global install は `1.4.17` に一致。Spotter project の
Codex hooks は各1件・canonical・`async` なしへ正規化済み。残る実機確認は `/hooks` review と新規 task の
`SessionStart` 1回観測。

**v1.4.16** (2026-06-04): **daemon 異常死後の stale socket で永久に起動不能になる回復経路バグを根治**。
daemon が graceful shutdown を経ず死ぬ (SIGKILL / crash / マシンスリープで SessionEnd 未発火) と
`stop()` の socket unlink が走らず `~/.spotter/runtime/session-<id>.sock` が orphan として残り、以後の
auto-resurrect (v0.12.0) / SessionStart は `assertNoLiveDaemon` (PID 死亡確認) 通過後の `server.listen` で
`EADDRINUSE` 死 → `daemon listening` 未到達 → 毎 resurrect crash-loop = そのセッションが永久に未監査
(「Spotter 監査は一時無効のまま」) になっていた。実セッション (Kikoeru `83d7aa04`) で異常死後 5 回の
restart が listen 未到達で停止、hook が毎ターン `E_UNREACHABLE` / `E_RESURRECT_FAILED` で degraded する
のを daemon ログで確認。修正: [transport.mjs](src/daemon/transport.mjs) に `removeStaleSocketFile`
(Unix のみ unlink、ENOENT no-op、Windows named pipe は no-op、§0 準拠で他エラーは rethrow) を新設し、
[daemon.mjs](src/daemon/daemon.mjs) の `startDaemon` が `assertNoLiveDaemon` 通過後・`listen` 前に呼ぶ。
異常死は避けられない前提で「死んでも次の resurrect で確実に復活」を保証 (auto-resurrect v0.12.0 が stale
socket に対しても初めて機能)。回帰テスト 3 件 (EADDRINUSE 再現→解消 / ENOENT no-op / Windows no-op)、
付随で `package-lock.json` の 1.4.14 drift を 1.4.16 に同期。`node --test` 348 pass / 2 skip 緑。詳細は
[CHANGELOG.md](CHANGELOG.md)。

**v1.4.15** (2026-06-02): **codex ログイン失効でサイレントに死に host が無反応になるバグを根治 +
hook 失敗を die(exit 2) から loud degradation (exit 0 + 警告) に転換**。codex auditor のログイン失効
(`token_revoked` / `refresh_token_reused` / `401`) 時、codex の異常終了を一律 `E_CODEX_CLI_EXIT` に潰して
auth を区別せず、かつ `UserPromptSubmit` hook が daemon エラーを `die(exit 2)` していた。Claude Code は
入力時 hook の exit 2 を **プロンプト消去** として扱うため、失効が続く限り毎ターン入力が消え「Claude が
一切反応しない」状態になっていた。修正: (A) [codex-cli-backend.mjs](src/core/codex-cli-backend.mjs) で
非ゼロ終了時に stdout+stderr をスキャンし、失効痕跡があれば新コード `E_CODEX_CLI_AUTH` (`codex login` を
案内) を投げる (新 export `isCodexAuthFailure`、分類は非ゼロ終了経路のみ)。(B) [user-prompt.mjs](src/hooks/user-prompt.mjs)
は daemon/transport/resurrect 失敗で `die(exit 2)` をやめ、`formatSpotterWarning` ([lib.mjs](src/hooks/lib.mjs)
新設) を `additionalContext` で出して **exit 0 でプロンプトを通す** `degrade()` に置換。失効に限らず全監査
失敗で host が固まらない。(C) [stop.mjs](src/hooks/stop.mjs) は backend エラー / marker 消失で継続強制
(exit 2) をやめ `degraded` 記録 + exit 0。(D) [pre-tool-use.mjs](src/hooks/pre-tool-use.mjs) は記録失敗で
ツール拒否 (exit 2) をやめ exit 0 (許可)。exit 2 は malformed envelope 専用に限定。loud degradation は
§0 の silent-fallback 禁止に抵触しない (黙って pass せず、毎ターン警告を出し対処法を示す)。残課題: Stop
失敗がセッション最終ターンだと deferred-delivery の性質上サイレント (open-issues.md P2)。`node --test`
344 pass / 1 skip 緑。詳細は [CHANGELOG.md](CHANGELOG.md)。

**v1.4.13** (2026-05-23): **Spotter 監査文面の末尾「監査役を明示してください」念押し行を削除**。
`formatTransparentContext` / `formatTransparentBlockReason` の末尾 2 行
(UserPromptSubmit:「使う場合は『Spotter の推奨に従い〜』のように監査役の指摘を明示してください。」、
Stop deferred delivery:「応答には『Spotter からの指摘を受けて〜』のように監査役の介入を明示してください。」)
が、毎ターン主役 AI の文脈に積もって邪魔という運用上のフィードバックを反映して削除。
ヘッダー `[Spotter からの推奨ツール]` / `[Spotter からの指摘]` 自体が出典明示を担うため、
§12.2 / §12.3 の透明化原則はヘッダーで維持。Claude / Codex 両 host が同じフォーマッタを
共有しているので hook parity は自動的に維持される。`node --test` 334 / 333 pass / 1 skip 緑。

**v1.4.10** (2026-05-08): **Claude host primary auditor を availability-based 2 段選択に変更**。
v1.4.7 までは `SPOTTER_AUDITOR_BACKEND_POLICY=next` を立てた Claude セッションだけが Codex CLI
primary auditor を使い、それ以外は無条件で Haiku を呼んでいた。Phase 4 matrix smoke
(2026-05-06: `claude.codex-cli=10041ms` vs Haiku `user_input ~14.3s / turn_end ~16.6s`) で
Codex CLI の latency 優位は確定済みだったため、opt-in を撤廃して既定動作を「Codex CLI が PATH
で検出できれば CLI、なければ Haiku」に変更する。検出は configuration-time
(`isCodexCliAvailable` が `env.PATH` を同期 walk、subprocess は spawn しない、Windows は PATHEXT
相当の `.cmd` / `.exe` / `.bat` を試行)。一度選ばれた backend が runtime で落ちた場合は従来通り
`AuditorBackendError` を throw し、別 backend への silent retry はしない (§0 fallback 禁止維持)。
codex-sidecar は `spotter codex *` の明示 second-pass workflow 専用に固定 (primary chain には
入れない)。`SPOTTER_AUDITOR_BACKEND_POLICY` 環境変数は legacy 値 (`current` / `next`) を
back-compat で受理するが selection には影響しない。`SPOTTER_AUDITOR_BACKEND=haiku` の明示固定は
引き続き有効。Codex host の auto-selected primary backend (`codex-cli`) と監査用子プロセスのモデル指定
(`gpt-5.4-mini` / `model_reasoning_effort="low"`) は変更なし。

**v1.4.9** (2026-05-08): **Codex hooks feature 名の現行 CLI 追従**。現行 Codex CLI は
hook 機能を `hooks stable true` として公開しているが、Spotter の `codex-hook diagnostics` は
旧名 `codex_hooks` だけを見ていたため、`~/.codex/hooks.json` の 3 hook が installed でも
`availability:"unavailable"` と誤判定していた。修正: diagnostics は `hooks` / `codex_hooks`
両方を enabled evidence として認識し、install は `[features].hooks = true` を書く。旧
`codex_hooks = true` が残る環境では削除せず、現行 key を追加する。Codex primary auditor /
host-local DB / pending queue / hook event JSONL の契約は v1.4.8 から変更なし。

**v1.4.8** (2026-05-08): **Hook 挙動 parity (Codex → Claude) 移植**。Codex 側で確定していた
3 つの hook 挙動を Claude 側にも移植し、両 host で同じ思想で動くよう揃えた。
(A) **Stop short-skip**: daemon `handleTurnEnd` 冒頭で短い final response (≤120 chars) かつ
used_tools 0 件のとき auditor を呼ばずに即 pass (`SPOTTER_STOP_SHORT_FINAL_MAX_CHARS` で調整可)。
(B) **Stop deferred delivery**: Claude `decision:"block"` を完全撤去。指摘テキストを
`<projectRoot>/.spotter/pending/<sessionId>.json` に積み、次の UserPromptSubmit が drain して
`additionalContext` で配信する。当ターンの最終応答は transcript にそのまま残るため「最後の
ログを見ても A という文脈が迷子になる」UX 欠陥を解消。Codex 側 pending path も
host-neutral `.spotter/pending/` へ移行 (旧 `.spotter/codex-pending/`)。
(D) **Hook event JSONL log**: schema `spotter.hook_event.v1` + `host` フィールドの
`<projectRoot>/.spotter/hook-events.jsonl` に Claude / Codex 両 host の hook event を時系列で
書く。`spotter diagnostics logs --json` (`--project DIR` 追加) は hookEvents を
`byHost` / `byHook` / `byStatus` / `byBackend` で集計表示。recursive hook / daemon
proliferation guard、auditor backend 取り扱い (v1.4.7) は変更なし。

**v1.4.7** (2026-05-08): **Claude host の opt-in `next` policy を Codex CLI primary auditor に切り替え (Phase 5)**。
`SPOTTER_AUDITOR_BACKEND_POLICY=next` を立てた Claude セッションは `policy_next_claude_codex_cli` で
`codex exec` 経由の auditor を呼び、Phase 4 matrix で latency 優位だった Codex CLI を採用する。
`current` policy と `SPOTTER_AUDITOR_BACKEND=haiku` 明示時のみ Haiku 互換を維持。Codex CLI が
unavailable / timeout / schema invalid / non-zero exit の場合は hidden fallback せず
`AuditorBackendError` を構造化エラーとして hook に伝搬する。recursive hook / daemon
proliferation guard (`SPOTTER_PARENT_PID` / `SPOTTER_BACKEND` / `SPOTTER_CHILD_BACKEND` /
`agent_id` / `source === "startup"` / marker / PID preexist / 10 秒 call window) は変更なし。

**v1.4.6** (2026-05-07): **Codex 初回セッション用 tool-db を install 時に同期 seed**。
Codex CLI が見える `spotter install` は Codex hooks 登録後に
`refresh({hostAgent:"codex"})` も同期実行し、`.spotter/tool-db.codex.json` を初回 Codex
セッション前に作る。Codex `SessionStart` の detached refresh は以後の drift 追従用として残す。
初回 `UserPromptSubmit` が空 / 未作成 Codex DB を読む race を塞いだ。

**v1.4.5** (2026-05-06): **Codex global tool-db を Claude global tool-db から分離**。Claude は
local `<project>/.spotter/tool-db.json` + global `~/.spotter/tool-db.json`、Codex は
local `<project>/.spotter/tool-db.codex.json` + global `~/.spotter/tool-db.codex.json` を使う。
refresh の local → global → investigate cache path でも Claude / Codex の description を混ぜない。
`spotter db rebuild --host-agent codex` は Codex local + Codex global だけを wipe する。

**v1.4.4** (2026-05-06): Codex CLI auditor child は Codex CLI の暗黙 default model に依存せず、
`--model gpt-5.4-mini` と `model_reasoning_effort="low"` を明示指定する。Spotter の hook 判定は
高頻度・低遅延・低コストの構造化 JSON 監査なので、frontier model を暗黙に使わない。
`SPOTTER_CODEX_CLI_MODEL` / `SPOTTER_CODEX_CLI_REASONING_EFFORT` は実測用 override として維持する。

**v1.4.3** (2026-05-06): **Codex native hooks を npm 配布可能な完成状態へ昇格**。Codex host は `spotter install` が Codex CLI を検出した時点で `SessionStart` / `UserPromptSubmit` / `Stop` を user-level に登録し、primary auditor backend は既定で Codex CLI (`codex exec`) を使う。Codex tool catalog は `.spotter/tool-db.codex.json` に分離し、Codex `SessionStart` が `spotter db refresh --host-agent codex` を detached 起動するため、Claude DB を上書きしない。Codex CLI 子プロセスは read-only sandbox / stdin ignore / `model_reasoning_effort="low"` / 20s hook timeout / schema-valid last-message timeout escape / `SPOTTER_PARENT_PID` + `SPOTTER_BACKEND` + `SPOTTER_CHILD_BACKEND` 再入ガードを持つ。`codex-sidecar` は primary auditor の明示 backend と second-pass / work workflow として維持。npm release では `bin.spotter` を `bin/spotter.mjs` に正規化し、global install 後の必要手順を各プロジェクトの `spotter install` に集約した。v1.4.2 以降は既存 hook command path も現在の npm global package path へ更新する。詳細は [CHANGELOG.md](CHANGELOG.md)。

**v1.3.0** (2026-05-04): **WSL2 で観測された CPU 100% 飽和 + 孤児 `npm exec` プロセス累積 + チャット入力無反応 の根本原因を断つ**。Spotter 自身が動く WSL2 で `ps -eo pid,ppid,pcpu,etime,cmd --sort=-pcpu` 上位に etime 3〜10 秒の `npm exec @modelcontextprotocol/server-*` 等が大量並走、親 PID は `claude -p --resume <uuid> --model claude-haiku-4-5-20251001` (= Spotter daemon の Haiku caller) と判明。`sanitizeHaikuEnv` (v1.1.6) で `CLAUDE_CONFIG_DIR` を strip してデフォルト `~/.claude/` で Haiku を起動していたが、デフォルト config dir には User scope MCP + plugin MCP がフル登録されており claude CLI 2.1.x は `--print` 起動時に全 MCP server を eager spawn する仕様。Haiku は `{name, description}` カタログ監査しか必要としないのに 60+ 個の MCP server が毎回 spawn → 終了 → 再 spawn して CPU 飽和、`daemon-702a677d-...log` で同 sessionId の sudden death + auto-resurrect が 15 分間に 8 回観測された (cgroup OOM 推定)。修正: [src/daemon/haiku-caller.mjs](src/daemon/haiku-caller.mjs) の `buildSpawnArgs` に `--strict-mcp-config --mcp-config <empty>` を必ず付ける + `ensureWorkdir` で `~/.spotter/workdir/empty-mcp.json` (`{"mcpServers":{}}`) を idempotent 生成 + `mcpConfigPath` を必須引数化。回帰ガード 5 件追加、既存 2 件追従。詳細は [CHANGELOG.md](CHANGELOG.md)。

**v1.2.6** (2026-05-04): **チャット入力が無視される実害バグの根治** — Chime プロジェクトのセッションで Spotter daemon の Haiku 呼び出しが `E_INTERNAL: haiku exited with code 1` を繰り返し、Claude Code 側 hook timeout (30s) に貼り付いて入力無反応が頻発していた。実プロジェクト同条件 (`tools=357 件 / preamble=93 KB`) で最小再現したところ、claude CLI 2.1.126 が `--print` モードで stdin 最初の read attempt が約 3 秒以内に間に合わないと「stdin 無し」と判定して exit 1 する仕様と、Spotter が `child.stdin.end(prompt)` で 93 KB を pipe (Linux pipe buffer 64 KB) に投げて drain 待ちさせていた実装の組合せが原因と確定。修正: [src/daemon/haiku-caller.mjs](src/daemon/haiku-caller.mjs) に新規 `preparePromptFile` を追加し prompt を `os.tmpdir()` の tempfile に書いて fd を `stdio[0]` に渡す方式に変更 (file は kernel が即時 readable と判定するので CLI 側の 3s タイマーに引っかからず、pipe buffer 制約からも独立)。settle 経路 3 種 (close / error / timeout) に `settleAfterCleanup` を入れて tempfile leak 防止。回帰ガード 6 件追加。Chime 同条件の実測で `child.stdin.end → 17s exit 1` から `tempfile fd → 24-32s exit 0` に改善を確認。詳細は [CHANGELOG.md](CHANGELOG.md)。

**v1.2.5** (2026-04-29): **ECC プラグイン経由の MCP 6 サーバー (context7 / exa / github / memory / playwright / sequential-thinking) のツール群 (61 件) がカタログから silent に欠落していた二重構造バグを修正**。実プロジェクト (Web) で `spotter install` 実行時のログに ``mcp investigate failed for "plugin": Command failed: cmd.exe /c claude mcp get plugin`` が **6 連発** で出ていたのを契機に発見、これらの呼び忘れを Spotter が検出できない状態だった。修正は 2 段階: (1) [investigate-mcp.mjs](src/tool-db/investigate-mcp.mjs) `parseMcpListOutput` の name 区切りを `indexOf(':')` から `indexOf(': ')` (コロン + スペース) に変更してフルネーム (`plugin:everything-claude-code:context7`) を抽出可能に、(2) ただし実測で **プラグイン MCP は `claude mcp get <フルネーム>` でも `No MCP server found` を返す**ことが判明 (`mcp list` には出るが `mcp get` 対象外) のため、CLI 出力行から `command` / `args` を直接 tokenize して `hasFullConfig` 分岐で再 query を skip させた。Web プロジェクトの rebuild 実測で 309 → 370 件、プラグイン由来 61 件が live fetch でカタログに追加されることを確認。詳細は [CHANGELOG.md](CHANGELOG.md)。

**v1.2.4** (2026-04-27): **v1.2.3 の `normalizeProjectPath` 挙動変更で、対になる test の expectation 更新を漏らして macOS CI が fail していた hot-fix**。`normalizeProjectPath: separator / trailing slash / Windows case` ([test/tool-db.test.mjs:678](test/tool-db.test.mjs#L678)) が「backslash は常に forward slash になる」旧仕様の expectation を残しており、POSIX で `'C:\\Users\\u\\proj'` を literal で返す v1.2.3 の挙動と矛盾。Linux CI は v1.2.3 で緑化、macOS が v1.2.3 commit の matrix 実行で同じ test で fail。修正: POSIX 側 expectation を v1.2.3 確定ルール (POSIX で backslash は literal) に追従させ、両 test の整合理由をコメント化。ソースは v1.2.3 から無変更、test だけ追従。詳細は [CHANGELOG.md](CHANGELOG.md)。

**v1.2.3** (2026-04-27): **v1.2.1 で追加した `normalizeProjectPath` が Linux CI で Windows path key と POSIX path をマッチさせて test を落としていた回帰を修正 + 未 release だった v1.2.1/v1.2.2 を backfill**。`replace(/\\/g, '/')` をプラットフォーム条件なしで実行していたため、Linux 上で `'C:\Users\u\proj'` (Windows 表記の literal key) と `'C:/Users/u/proj'` が `C:/Users/u/proj` 同士に正規化されてマッチし、`findLocalScopeServers: separator variant matches on Windows only` test ([test/tool-db.test.mjs:716](test/tool-db.test.mjs#L716)) が POSIX で `{foo:{command:'x'}}` を返して期待値 `{}` に対して fail。CI のみ赤、実運用 (Windows) は元から正しく動いていたので機能影響なし。修正: [mcp-config.mjs](src/tool-db/mcp-config.mjs) の separator 変換 + lower-case 化を `process.platform === 'win32'` ブランチに閉じ込め、POSIX では trailing slash 除去のみ実施。同時に v1.2.1 / v1.2.2 の tag + GitHub Release を CHANGELOG から流用して backfill (Latest = v1.2.3)。詳細は [CHANGELOG.md](CHANGELOG.md)。

**v1.2.2** (2026-04-27): **Windows で npm-global の `.cmd` 配布 MCP サーバ (例: `claude-mermaid`) が investigate 時に ENOENT で落ちる回帰を修正**。`buildStdioSpawn` が `.cmd`/`.bat` 拡張子を**明示**したコマンドしか cmd.exe で wrap しておらず、MCP の標準的な登録形 (拡張子なしの裸名 = `claude-mermaid`) では発火せず Node の `spawn` が PATHEXT 解決できず ENOENT で即死していた (`.exe` 配布や `.cmd` 明示は影響なし)。修正: [investigate-mcp.mjs](src/tool-db/investigate-mcp.mjs) の Windows 分岐条件を「絶対 `.exe` パス以外は `cmd.exe /c` で包む」に拡張、export 追加。テスト 4 件追加。これは Spotter v0.7.0→v0.8.0 で claude CLI 起動経路で自分で踏んで直した bug の MCP investigate 経路への横展開漏れ (own caveat: `windows-node-spawn-claude-fails-with-enoent-because-claude-is-a-cmd-wrapper`)。詳細は [CHANGELOG.md](CHANGELOG.md)。

**v1.2.1** (2026-04-27): **Claude Code 公式の MCP scope 3 段 (User / Project / Local) に完全対応**。v1.2.0 までは project (`<projectRoot>/.mcp.json`) + 非公式 legacy (`~/.claude/.mcp.json`) しか読んでおらず、公式の User scope (`~/.claude.json` 直下 `mcpServers`) と Local scope (`~/.claude.json` `projects[<root>].mcpServers`) を読み損ねていた。結果、`claude mcp add -s user -e KEY=val ...` 等で登録した MCP は `claude mcp list` で発見されるが env が拾えず、stdio は API キー無しで spawn / HTTP は 401 → tools/list 空 → `resolveAll` の prune で catalog 削除、という silent な脱落が起きていた。修正: [mcp-config.mjs](src/tool-db/mcp-config.mjs) の `readMcpServers` を 4 ソース merge (`legacy < user < project < local`) に拡張、`projects[]` キーは Windows の separator / 大小 / 末尾スラッシュの揺れを正規化して照合 (fuzzy / prefix マッチは別プロジェクトの secrets 混入を避けるため意図的に外した)。テスト 13 件追加。詳細は [CHANGELOG.md](CHANGELOG.md)。

**v1.2.0** (2026-04-26): **当該プロジェクトで使えないツールが提案される回帰を構造的に修正**。daemon が監査に使うカタログを**ローカル DB のみ**に変更し、グローバル DB は他プロジェクトでの description 再利用のためのキャッシュ層に役割を限定。`readMerged` (`{...global.tools, ...local.tools}` で local-wins マージ) が global の幻ツールを Haiku 視野に流し込んでいた経路と、`resolveAll` が snapshot にもう存在しないローカルエントリを削除しなかった経路の二重バグの組合せで、過去の別プロジェクトで discover した MCP / スキル / サブエージェントが居座っていた。修正: (1) [refresh.mjs](src/tool-db/refresh.mjs) の `readMerged` を `readLocal` にリネームし local DB 限定実装に変更、(2) [lookup.mjs](src/tool-db/lookup.mjs) の `resolveAll` 末尾に prune ループ追加 (toolNames に含まれない既存ローカルエントリを削除、investigate 失敗時は既存値保持で audit 範囲を縮めない)、(3) [daemon.mjs](src/daemon/daemon.mjs) と [db-cmd.mjs](src/cli/db-cmd.mjs) を `readLocal` に切替、(4) [index.mjs](src/index.mjs) の public export 名変更 (programmatic API 破壊変更のため minor bump)、(5) テスト 3 件追加。既 install プロジェクトは npm global update 後、次の SessionStart で `spawnRefreshDetached` が prune 入り refresh を実行し、次の次のセッションから幽霊が消える (v1.1.0 の detached 仕様、即時反映は `spotter db refresh` 手動)。詳細は [CHANGELOG.md](CHANGELOG.md)。

**v1.1.6** (2026-04-20): **Bell の isolated `CLAUDE_CONFIG_DIR` が Spotter haiku の auth を破壊する bug を修正**。bellbot 等で `CLAUDE_CONFIG_DIR=~/.bellbot-claude-config` + `--dangerously-skip-permissions` として Bell を spawn する隔離運用 (user scope MCP 流入防止 / credentials 分離) で、hook → daemon → haiku の spawn 連鎖で Bell の isolated config が継承され、Spotter haiku が credentials 不在の config を読みに行き exit 1 → 同じ session-id が claude CLI 側で "Session ID ... is already in use" と判定されて失敗が固定化 → user_input hook が非 0 exit し続けてベル本体のプロンプト処理が破綻していた (Discord 上では Bell がメッセージを無視しているように見える)。外部指摘 (2026-04-20) + daemon log 実測 + コード監査で確認。修正: (1) [haiku-caller.mjs](src/daemon/haiku-caller.mjs) に `sanitizeHaikuEnv` 純粋関数を新設、spawn env から `CLAUDE_CONFIG_DIR` のみ strip (Haiku は常にデフォルト `~/.claude/` で起動、監査対象の `claude mcp list` は Bell の env を尊重する整合性を維持)、(2) [daemon.mjs](src/daemon/daemon.mjs) の `runHaikuJudgment` で E_INTERNAL / E_HAIKU_TIMEOUT 時も `callHaiku.reset()` で session を rotate してから throw (auth 以外の将来バグ — network / quota / CLI crash — でも session 固定化を防ぐ構造的防御)。詳細は [CHANGELOG.md](CHANGELOG.md)。

**v1.1.5** (2026-04-20): **Windows で refresh 毎に cmd.exe console window が flash + 入力フォーカスを奪う UX 回帰を修正**。[investigate-mcp.mjs](src/tool-db/investigate-mcp.mjs) の `execClaude` ヘルパが `cmd.exe /c claude mcp list/get` を spawn する際に `windowsHide: true` を付けていなかった穴を塞いだ。SessionStart 毎の bg refresh で MCP サーバー N 個なら **1 + N 回** の flash が発生していた。修正は helper 層で `windowsHide: true` を強制する 1 箇所のみ (call site 毎に書かせる方針より防御堅牢)。他 5 spawn サイト (daemon / refresh detached / haiku-caller / MCP stdio spawn / doctor) は元から `windowsHide: true` 済みを監査で確認、これで残る穴はゼロ。詳細は [CHANGELOG.md](CHANGELOG.md)。

**v1.1.4** (2026-04-20): **MCP 投資経路の 2 件の silent mismatch を修正**。(1) [investigate-mcp.mjs](src/tool-db/investigate-mcp.mjs) の `listMcpServers` / `getStdioConfig` が `projectRoot` を受け取りながら `claude mcp list / get` spawn 時に `cwd` を付けていなかったため、`.mcp.json` 読み込みと claude CLI の walk-up が別プロジェクトを指す可能性があった穴を塞いだ (通常は `process.cwd() === projectRoot` で表面化しないが意味論を一致)。(2) [claude-ai-baseline.mjs](src/tool-db/claude-ai-baseline.mjs) の 25 件 (Gmail/Calendar/Drive) が `claude mcp list` の実在確認なしに全環境で無条件注入されていた bug を修正。baseline を server 単位構造に再編し [refresh.mjs](src/tool-db/refresh.mjs) で `filterClaudeAiBaseline` (named export, 3 件テスト付き) により現実に存在するサーバーのみ注入。隔離 `CLAUDE_CONFIG_DIR` / 未連携 / 部分連携環境で最大 25 件の幻ツールが catalog に残っていた状態を解消。詳細は [CHANGELOG.md](CHANGELOG.md)。

**v1.1.3** (2026-04-20): **v1.1.x の実装進展にドキュメントを追従させる docs-only リリース**。コード変更なし、npm package tarball 同梱の README が古い手順を指していたため再 publish。[README.md](README.md) のバナー / install 手順 / カタログ収集経路 / コマンド表 / 設計ドキュメント節 / timeout 記述を v1.1.2 時点に更新、[docs/01_catalog-design.md](docs/01_catalog-design.md) に「収集タイミング (v1.1.0 以降)」節を新設 (install 同期 seed / SessionStart bg refresh / db refresh / db rebuild の 4 経路を整理)、[docs/archive/spotter-plan.md](docs/archive/spotter-plan.md) 冒頭に v0.1 設計議事録である旨のブリッジ追加。詳細は [CHANGELOG.md](CHANGELOG.md)。

**v1.1.2** (2026-04-20): **v1.1.1 の code-review で発見した 2 件を修正**。Spotter 自身が監査役として指摘し実装を補正する自己ドッグフーディング。変更: [install.mjs](src/cli/install.mjs) の `refresh` 呼び出しを try/catch で包み throw 直前に stderr で復旧経路 (`spotter db refresh`) を露出 (§0 fallback 禁止は守りつつ「hook 登録済み + tool-db なし」状態のユーザーに次の一手を示す診断メッセージ)、`runInstall` に `refreshFn` DI パラメータ追加、[test/install.test.mjs](test/install.test.mjs) に回帰ガード 2 件追加 (2 回目 install でも refresh 呼ばれる / refresh 失敗時に stderr 復旧ヒント)、[docs/open-issues.md](docs/open-issues.md) P2 に「tool-db.json の並列書き込み race condition」追記 (実害観測なしなので放置判断)。詳細は [CHANGELOG.md](CHANGELOG.md)。

**v1.1.1** (2026-04-20): **既 install プロジェクトで refresh が skip される bug の hot-fix**。v1.1.0 で追加した tool-db 自動構築が、hook 登録済みの場合に [install.mjs](src/cli/install.mjs) の早期 return に引っかかって走らない穴があった。if/else 構造に組み直して **settings.json の差分有無に関わらず refresh が走る** ようにした。v1.1.0 升級後の既 install プロジェクトでも `spotter install` 再実行で tool-db.json が seed される。詳細は [CHANGELOG.md](CHANGELOG.md)。

**v1.1.0** (2026-04-20): **`spotter install` が tool-db を自動構築 + SessionStart hook が bg refresh**。install 直後から audit 対象が揃い、以降のセッションでも MCP / スキル / サブエージェントの追加・削除が自動追従する。v1.0.0 までは install が hook 登録だけで tool-db を作らず、`spotter db refresh` の手動実行が必要 = 初回セッションで daemon が空 DB を掴む穴があった。変更: [install.mjs](src/cli/install.mjs) で settings 書き込み後に project-mode の `refresh({projectRoot})` を同期実行 (失敗時 §0 準拠 throw、`skipRefresh` オプション新設でテストから除外)、[session-start.mjs](src/hooks/session-start.mjs) で daemon readiness 後に `spawnRefreshDetached({projectRoot})` を発火 (detached + unref で hook 遅延させず、反映は次セッション)、[spawn-daemon.mjs](src/hooks/spawn-daemon.mjs) に `spawnRefreshDetached` export 追加。当初 user 指示は rebuild (local+global wipe + 全再スキャン) だったが、(1) 既適用プロジェクトの global cache を毎 SessionStart で破壊する副作用、(2) 並列セッションの書き込み競合リスク、から refresh に変更。description drift のみ取りこぼすが手動 `spotter db rebuild` でカバー。詳細は [CHANGELOG.md](CHANGELOG.md)。

**v1.0.0** (2026-04-20): **監査対象をユーザー追加分 (MCP / スキル / サブエージェント) に絞り込み**。Claude Code 本体側ツール (即時 + 遅延) は全面除外。設計転換の major bump。実運用と設計会議で 2 点判明: (1) Bell は本体側ツールを使いこなしていて呼び忘れ率が低い (WebSearch / WebFetch / TodoWrite 等は自発率十分)、(2) 即時 / 遅延の境界が Claude Code バージョンで動的に変わり手書き baseline が構造的に drift する (実セッションで `AskUserQuestion` / `TodoWrite` 等 6 件が即時扱いと判明)。そこで本体側 17 件手書き baseline を撤去し、ユーザーが能動的に追加する 3 種 (MCP + スキル + サブエージェント) のみに監査範囲を絞り込み。新規に SKILL.md / agent .md の YAML frontmatter から `{name, description}` を収集する仕組みを追加 ([investigate-skills.mjs](src/tool-db/investigate-skills.mjs) / [investigate-agents.mjs](src/tool-db/investigate-agents.mjs) / [frontmatter.mjs](src/tool-db/frontmatter.mjs))。結果 `buildInvestigationSnapshot` で **268 件 resolved** (MCP 40 + skills 181 + agents/bare 47、ECC プラグインが大半)、preamble 初回 15-25K tokens (Haiku 200K 枠内)。破壊変更: `DEFERRED_TOOL_BASELINE` / `getDeferredDescription` / `listDeferredNames` export 削除、`spotter db rebuild` が global DB も wipe する仕様変更、設計ドキュメントを [docs/01_catalog-design.md](docs/01_catalog-design.md) にリネーム + 全書き直し。詳細は [CHANGELOG.md](CHANGELOG.md)。

**v0.13.1** (2026-04-20): **Haiku timeout 30s → 45s 緩和 + hook IPC timeout 整合**。実セッションで `E_HAIKU_TIMEOUT: haiku did not respond within 30000ms` を観測、line 20 も 20.9s と timeout 70% 域に達しており 30s が狭すぎた。合わせて [src/hooks/stop.mjs](src/hooks/stop.mjs) の IPC timeout が 15s で Haiku 側 30s と不整合だった既存バグも同時解消。調査で Haiku 4.5 は **effort 非対応 / adaptive thinking 非対応 / extended thinking は対応だが CLI フラグ無し**と判明、「Haiku を速くするダイヤル」が存在せず timeout 緩和しか打ち手が無いことを公式 docs で確定。daemon 突然死問題は未対処、[docs/open-issues.md](docs/open-issues.md) P0 に残置。詳細は [CHANGELOG.md](CHANGELOG.md)。

**v0.13.0** (2026-04-20): **Stop 判定軸を「ツール適用機会の監査」に転換**。従来の `stage=turn_end` は「user_input で要請されたツールが used_tools に含まれているか」= 要請充足チェックだった。この軸は Bell が Stop hook 到達後に新しく導入したい動作 (例: 事実断定の裏付け、新知見の `caveat_record`、過去議論の `caveat_search`) を拾えない。新軸は `<final_response>` + `<used_tools>` のみを Haiku に渡し、応答内容に対しカタログ上のツールを差し込める余地 (検証 / 登録 / 照会) があるかを問う。指摘ゼロは歓迎、`used_tools` 既含は再指摘しない、迷ったら pass:true の非対称設計。`buildFinalStagePrompt` から `userInput` 引数を削除、`SHARED_HEADER` の few-shot を 4 件 (検証/登録/照会/pass) に拡張。Stop hook の入力契約 (`final_response` のみ) はもともと user_input を含まないので hook 側の変更なし。詳細は [CHANGELOG.md](CHANGELOG.md)。

**v0.12.0** (2026-04-19): **親 PID watch を heartbeat 方式に置換 + UserPromptSubmit auto-resurrect**。v0.6.2 で導入した `--parent-pid` watch が VSCode native extension 環境で誤爆する問題 (`process.ppid` が短命ラッパーを指して 5 秒で ESRCH → daemon 自死) を解消。daemon 側は envelope 受信ごとに `setTimeout(selfShutdown, 30min)` を re-arm する heartbeat 方式に変更、OS / 環境依存ゼロ。誤自死しても次の UserPromptSubmit で `E_UNREACHABLE` を検知して spawn + retry する auto-resurrect も合わせて入れたため、孤児発生時のユーザー影響は「次の入力時に一瞬の起動 latency」だけになる。`--parent-pid` 引数と関連 watch ロジックは完全削除 (minor bump 相当の API 変更)。詳細は [CHANGELOG.md](CHANGELOG.md)。

**v0.11.0** (2026-04-19): **短プロンプトの Haiku スキップ**。ユーザー入力が trim 後 10 文字 (コードポイント) 以下なら UserPromptSubmit hook で早期 return し、daemon へ `user_input` を送らない。結果、daemon は `state.lastUserInput=null` のまま維持され、次の turn_end が `reason=no_user_input` で自動 pass する。挨拶・相槌・短い質問 ("今何時?" "ありがとう" "ok done" 等) でレイテンシ 0、preamble 57 件の無駄打ちを回避。daemon 側に閾値ロジックを足さず hook 層だけで閉じる最小実装。詳細は [CHANGELOG.md](CHANGELOG.md)。

**v0.10.0** (2026-04-19): **project scope `.mcp.json` 対応**。v0.9.0 は user scope (`~/.claude/.mcp.json`) だけ読んでいたため、プロジェクト直下の `.mcp.json` に登録された MCP サーバー (project 固有) の env / headers を拾えなかった。`<projectRoot>/.mcp.json` も読んで user scope に merge (project 勝ち = Claude Code precedence と整合)。`readMcpServers({projectRoot})` シグネチャ変更 + `refresh` → `investigate` → `mcp-config` の経路で projectRoot を伝搬。詳細は [CHANGELOG.md](CHANGELOG.md)。

**v0.9.0** (2026-04-19): **`.mcp.json` を真実源として読み込み、user-registered MCP の認証情報を live fetch に活用**。v0.8.0 の HTTP transport 実装後も `claude mcp list` / `claude mcp get` は secrets を CLI 出力に含めないため x-api が 401 で落ちていた。ユーザー指摘で `~/.claude/.mcp.json` を直接読めば stdio の env / HTTP の headers が手に入ると判明。`src/tool-db/mcp-config.mjs` を新設、`listMcpServers` を CLI + `.mcp.json` 併用に、`spawnAndQuery` が env を merge、`listToolsHttp` が headers を受理。結果 x-api の 9 ツール (get_trends / search_tweets 等) が live fetch で投入されるようになり、手書き baseline 不要に。`.mcp.json` はユーザー自身が secrets を書いた設定ファイル = `.credentials.json` (Anthropic OAuth) とは性格が違い、v0.8.0 の境界線に抵触しない。詳細は [CHANGELOG.md](CHANGELOG.md)。

**v0.8.0** (2026-04-19): **HTTP/SSE MCP transport 対応 + Windows `.cmd` 経路 fix + claude.ai 系 MCP の hardcoded baseline**。v0.7.0 を新規セッションで実測したら (1) Windows で `spotter db refresh` が `spawn claude ENOENT` で起動すらせず、(2) fix 後も Gmail / Calendar / Drive / x-api の 4 サーバーが `transport not yet supported` で全部スキップされ Haiku 視野に入らず、(3) `claude.ai ...` 系は `claude mcp get` が `No MCP server found` を返し OAuth proxy 経由で動いている (Spotter は credentials を読まない方針) と判明。3 本同時に解決: MCP Streamable HTTP transport 実装 (`src/tool-db/investigate-mcp-http.mjs`)、Windows `.cmd` は `cmd.exe /c` 経由 (`execClaude` / `buildStdioSpawn`)、claude.ai 系 25 件を deferred-baseline と同じパターンで手書き (`src/tool-db/claude-ai-baseline.mjs`)。`spotter db rebuild` で **48 tools resolved** (deferred 17 + claude.ai 25 + caveat 6)。live HTTP fetch は 401/403 で落ちるが baseline が吸収。詳細は [CHANGELOG.md](CHANGELOG.md)。

**v0.7.0** (2026-04-19): **カタログを tool-db に置き換え**。手書きの `tools.yaml` (current_time / web_search 等 5 件の抽象ツール) を廃止し、**実際にセッションで使える MCP ツール + Claude Code 組込み 遅延ツールの name + description を自動収集してキャッシュする** 仕組みに切り替え。Haiku に渡すのは `{name, description}` のペアだけ — schema は不要 (どう呼ぶかは Bell が ToolSearch で解決する役割分業)。MCP description は MCP サーバーから JSON-RPC `tools/list` で直接取得。3 段階キャッシュ (ローカル → グローバル → 調査して両方に追記)、drift 補正、明示的無効化なし。これで Caveat 等の MCP ツールが Haiku の視野に入る。詳細は [CHANGELOG.md](CHANGELOG.md) と設計思想 [docs/01_catalog-design.md](docs/01_catalog-design.md) (v1.0.0 でリネーム、旧名 `catalog-design-deferred-mcp.md`)。

**v0.6.2** (2026-04-19): **親プロセス watch で孤児 daemon を自動回収**。SessionEnd が発火しない経路 (Claude Code crash / kill / IDE reload) で daemon が永久に残る問題への対処。SessionStart hook が `--parent-pid <process.ppid>` (Claude Code 本体 PID) を daemon に渡し、daemon は 5 秒間隔で `process.kill(parentPid, 0)` を ping、ESRCH なら自身を shutdown。実運用で 9 daemon 中 8 個が孤児だった (手動 kill 必要) 状態を解消。詳細は [CHANGELOG.md](CHANGELOG.md)。**(v0.12.0 で heartbeat 方式に置換 — VSCode native extension で `process.ppid` が短命ラッパーを指して誤爆していた)**

**v0.6.0** (2026-04-19): **Preamble-once 化**。v0.5.2 で可視化した duration_ms を実測したところ、`first=7.4s → resumed=12.5s → resumed=20.2s` と resumed のほうが遅いという設計意図と逆の結果。真因は「`--resume` で session を継いでいるのに毎回 full prompt (role + schema + catalog + few-shot) を再送して session を肥大化させていた」こと。`buildPreamble({ catalog })` を新設、初回 1 回だけ送って以降は per-turn delta (stage マーカー + 入力タグ) のみにした。同作者の OpenClaw が Discord → Claude 長期セッションで使っているパターンを持ち込んだ。role collapse 耐性は既存 reset 機構がそのまま機能する (reset 時に preamble 再送)。詳細は [CHANGELOG.md](CHANGELOG.md)。

**v0.5.2** (2026-04-19): Haiku 呼び出しレイテンシ可視化。daemon ログに `mode=first|resumed, duration_ms=<N>` を追加し、`--resume` 経路の cold-start 削減効果 / role collapse 回復時間 / timeout 余裕を観測可能にした。機能変更なし、`isFirstCall` getter 追加 + ログフォーマット拡張のみ。これで v0.5.0/v0.5.1 の既知課題 (resume 実効削減量未検証、role collapse 実発生頻度未観測) が数値で判断できる状態になる。詳細は [CHANGELOG.md](CHANGELOG.md)。

**v0.5.1** (2026-04-19): v0.5.0 の `buildSpawnArgs` が `--session-id` と `--resume` を併用していたバグの hot-fix。claude CLI は `--fork-session` なしの両立を拒否するため、resume 時は `--resume <uuid>` 単独に修正。これにより v0.5.0 の session-scoped 機構が実際に生きた状態で動き出した。

**v0.5.0 実装完了** (2026-04-19)。**v0.4.0 で捨てた session-scoped Haiku を事後回復機構付きで復活**。v0.4.x stateless の毎ターン cold-start 問題 (Bell 応答後に 30 秒前後動きが止まる) を解消するため、`claude -p --session-id <uuid> --resume <uuid>` で同一セッション再接続。v0.4.0 で session-scoped を捨てた理由の **Haiku role collapse** (persona drift で JSON 契約破棄) は、構造的予防ではなく **JSON パース失敗検知 → session renew + silent pass** の事後回復で処理する方針へ変更。これは §0 の「想定済み異常 = 記録 + 正常リターン」の分類変更であり、silent fallback 新規導入ではない。詳細は [CHANGELOG.md](CHANGELOG.md)。

**v0.4.4** (2026-04-19): Stop hook が **Bell の最終応答を Haiku に渡していなかったバグ**を修正。`input.final_response` (存在しないフィールド) を廃止し、`input.transcript_path` から JSONL 末尾の assistant text だけを抽出する `getLastAssistantText()` を新設 ([src/hooks/transcript-reader.mjs](src/hooks/transcript-reader.mjs))。thinking / tool_use ブロックは除外、ユーザーが見た最終応答テキストのみ Haiku に渡る。Throughline から移植 (MIT, 同作者)。

**v0.5.0 の核心設計**: daemon は session-scoped (hook イベント集約・used_tools 記録)。**Haiku 呼び出しも session-scoped** (`--session-id` を daemon 生存期間中保持、2 回目以降は `--resume` で再接続)。再帰ガード 5 層 (`SPOTTER_PARENT_PID` env / `agent_id` gate / `source=startup` 限定 / PID preexist check / 10 秒ウィンドウ) と、v0.3.0 以降の project marker gate (`.spotter/marker.json`) は維持。プラン §18.3 の都度起動型 (daemon レベルでの都度起動) は引き続き棄却、再議論しない。

### v0.5.0 で投入した対策

- **Session-scoped Haiku** (`createHaikuCaller` @ [haiku-caller.mjs](src/daemon/haiku-caller.mjs)): closure で `currentSessionId` と `isFirstCall` を保持。初回は `--session-id` のみ、以降は `--session-id + --resume`。2 回目以降の cold-start を消す。
- **Role-collapse recovery** (`runHaikuJudgment` @ [daemon.mjs](src/daemon/daemon.mjs)): `parseHaikuResponse` が `E_HAIKU_SCHEMA` を throw したら `callHaiku.reset()` で session-id を renew し、当該ターンは `{pass: true, reason: 'role_collapse_reset'}` で silent pass。次ターンから fresh session で監査再開。
- **Timeout 短縮** (60s → 30s): v0.5.0 時点では、2 回目以降は cold-start がないので延長不要、初回だけは 30s 以内に終わる想定だった。現行の daemon timeout は v0.13.1 以降 45s。
- **Warmup 削除**: stateless 対策だったので不要。

### v0.5.0 時点の既知課題 (歴史記録)

この時点の未解決項目は現在 [docs/open-issues.md](docs/open-issues.md) に統合されている (`--resume` 実効 spawn 削減量 / preamble caching コスト / role collapse 発生頻度)。カタログのツール名抽象問題は v0.7.0 の tool-db 置換で消滅済み。

### Spotter 本体プロジェクトでの install に関する警告

**Spotter リポジトリで Spotter を install すると、Bell 側の会話が Spotter 自体の議論になり、Haiku が自己言及で混乱する**。v0.5.0 で session-scoped に戻したため、過去より persona drift リスクが高い環境。開発時は他プロジェクトで動作確認するか、install せず `node --test` / `spotter db refresh` などの明示コマンドで確認すること。

## Product Concept (一行)

**Bell (主役の Claude) が呼び忘れるツールを、カタログを完全把握した別エージェント (Spotter) が並走監査して検出する。** 気づく役と実行する役の分離。

### 判定軸 (v0.13.0 で 2 軸化)

- **stage=user_input**: ユーザー要請に対し、ローカル tool-db の `{name, description}` から用途が明確に該当するツールを列挙する **要請充足チェック**。挨拶・雑談は pass
- **stage=turn_end**: Bell の最終応答に対し、事実の断定 / 記録すべき新情報 / 既知情報の参照 それぞれに、カタログ上のツール (検証 / 登録 / 照会) を差し込める余地がないか監査する **ツール適用機会の監査**。指摘ゼロは歓迎、`used_tools` 既含は再指摘しない

## Architecture の核 (実装判断に効く部分)

- **並走デーモン型**: SessionStart で 1 プロセス起動、SessionEnd で shutdown。Bell から呼ぶのではなく、hook 経由で **Bell の意思と独立に** user_input / tool_used / turn_end を受け取る。「Bell が自覚して呼ぶ」設計は **本プロダクトの存在意義を破壊する**ので却下されている。
- **Claude 呼び出しは session-scoped + preamble-once + 事後回復** (v0.6.0 で更新): `claude -p --session-id <uuid>` で初回セッション確立、以降 `--resume` で再接続。**初回のみ preamble (role + schema + few-shot + catalog) を送り、以降は per-turn delta のみ**送ることで session を肥大化させない (v0.5.x は毎回 full 送信していて resumed が first より遅いという逆の結果が出ていた)。role collapse は `parseHaikuResponse` が `E_HAIKU_SCHEMA` を返した瞬間に `callHaiku.reset()` で session-id を rotate、次回呼び出しで preamble が新 session に自動で再送される。当該ターンは silent pass。**これは §0 の silent fallback 禁止違反ではなく、「想定済み異常 = 記録 + 正常リターン」の適用**。
- **隔離実行**: Spotter の workdir (`~/.spotter/workdir/`) には **CLAUDE.md を置かない**。プロジェクト文脈に引きずられないことが品質保証の要件。
- **ツールカタログは host-local tool-db**: Claude daemon が監査に使うのは `<project>/.spotter/tool-db.json` の `{name, description}` だけ。Codex native hooks は `<project>/.spotter/tool-db.codex.json` だけを読む。グローバル DB も host 別の description 再利用キャッシュで、Claude は `~/.spotter/tool-db.json`、Codex は `~/.spotter/tool-db.codex.json` を使う。global は audit 入力には混ぜない。Claude refresh は `claude mcp list` と Claude skills / sub-agents、Codex refresh は `codex mcp list/get` と Codex skills を discovery し、片方の refresh がもう片方の local / global DB を prune / overwrite してはいけない。
- **Stop hook の介入**: Claude / Codex とも immediate block / continuation / deferred model-context
  delivery を行わない。finding は catalog 照合済みtool IDの構造Hook eventとして記録し、failureは
  allow-list済み固定 `systemMessage`・固定stderr・構造eventへ出す。監査用AIの自由文やprovider出力を
  親モデルへ渡さず、`.spotter/pending/`への新規書込みもしない。`stop_hook_active:true` は再入を即 pass。

## §0 実装規範 (最重要)

コードを書く前にこの 3 点を内面化すること。プラン §14 の詳細版だが、実装時に効くのはここ:

1. **フォールバック禁止**. daemon 起動失敗 / socket 疎通失敗 / auditor 呼び出し失敗 / tool-db / frontmatter パース失敗を `pass` に偽装しない。core は structured error を throw し、別 backend / model へ silent retry しない。host hook はその error を catch して `degraded` event + user-visible warning に変換し、host 自体を凍結しない。SessionEnd cleanup と telemetry は non-blocking だが失敗を stderr / event log に残す。
2. **「daemon が死んでたら pass」は最悪の失敗モード**. ユーザーは Spotter が守っていると思うのに実は未監査、という状況を作らない。UserPromptSubmit / Stop の failure は allow-list済み固定 `systemMessage`・固定stderr・構造event + exit 0 を出し、プロンプト消去や回答継続を避ける。これはHook出力契約であり、全Codex App/background面でのUI可視性までは保証しない。backend messageやprovider出力を `additionalContext` へ反射してはならない。exit 2 は malformed hook envelope に限定する。
3. **動かすためだけの暫定コード禁止**. スタブ・TODO のみの関数・型が曖昧なコードを本流に混ぜない。MVP スコープを狭めるのは OK (v0.2 に送る)、**範囲内は常に完成形**。暫定コードを書く必要があるなら代替設計と一緒に提示してから書く。

想定済み異常 (例: カタログに該当ツールなし) は記録 + 正常リターン。**想定外**は core で throw し、
hook boundary が event 契約に従って loud degradation へ変換する。exit code 2 は malformed hook envelope
など host が処理を続けてはいけない入力契約違反に限定する。この分類を曖昧にしない。

## Current Stack / Runtime Requirements

現行実装はこれらを満たすこと:

- **Node.js 22.5+** (組み込み fetch, test runner 使用)
- **Claude Code 2.0+**
- **Codex CLI** (Codex host の auto-selected primary backend。Claude host でも PATH にあれば既定で選択)
- **Claude Max plan** (`SPOTTER_AUDITOR_BACKEND=haiku` または Codex CLI 不在時の Claude fallback path が `claude -p` を使う場合)
- **ゼロ依存志向**. 依存追加時は理由をコミットログに記録。
- パッケージング: npm package は `claude-spotter`、global install は `npm install -g claude-spotter`、CLI 名は `spotter`、MIT ライセンス。

## Current Commands

現行のユーザー向け command surface:

```
spotter install / uninstall
spotter db list / refresh / rebuild
spotter status / doctor
spotter diagnostics logs [--json]
spotter codex risk-check --findings <file> [--host-agent <agent>]
spotter codex review / explore / opinion --findings <file> [--host-agent <agent>]
spotter codex work --findings <file> --instruction <text> --approve-work --allowed-path <path> (--preserve-worktree | --remove-worktree)
spotter codex-hook install / uninstall / diagnostics   # Codex native hooks; SessionStart refreshes Codex DB
spotter auditor judge / matrix                         # experimental primary-backend smoke
spotter auditor model-matrix --fixtures <file>         # pinned model profiles の再現可能な比較 eval
spotter daemon start              # 内部用 (hook から呼ばれる)
spotter hook <event>              # 内部用 (Claude Code hook から呼ばれる)
```

`spotter catalog *` は v0.1 設計時の YAML catalog 時代のコマンドで、現行実装には存在しない。現行の catalog は host-local DB で扱い、Claude は `.spotter/tool-db.json`、Codex は `.spotter/tool-db.codex.json` を正本にする。CLI では `spotter db * --host-agent codex` で Codex 側を明示する。
`spotter codex *` は `SpotterFinding[]` を `codex-sidecar` に渡す explicit second-pass workflow であり、
`UserPromptSubmit` / `Stop` の primary auditor backend 置換ではない。primary backend migration は
[docs/02_spotter-claude-contract.md](docs/02_spotter-claude-contract.md) の primary backend policy を参照する。
完了済みの移行計画と実測ログは [docs/archive/SPOTTER_PRIMARY_BACKEND_TODO.md](docs/archive/SPOTTER_PRIMARY_BACKEND_TODO.md)
に保持する。
`spotter codex-hook *` は Codex native hooks 用の adapter であり、Codex host の
primary auditor backend は既定で Codex CLI (`codex exec`) を使う。監査専用の子 Codex は versioned
auditor policy の production selection（現在 `gpt-5.6-terra × medium`）と hook auditor timeout 20s を使い、短い Codex `Stop`
応答は重複監査せず skip する。Codex `SessionStart` は `spotter db refresh --host-agent codex`
を detached 起動し、Claude DB には触れない。`SPOTTER_CODEX_CLI_MODEL` /
`SPOTTER_CODEX_CLI_REASONING_EFFORT` / `SPOTTER_CODEX_HOOK_AUDITOR_TIMEOUT_MS` /
`SPOTTER_CODEX_STOP_SHORT_FINAL_MAX_CHARS` で実測用に上書き可能。
model override は unverified として diagnostics に残る。`gpt-5.6-luna × low` / `gpt-5.6-terra × low` /
`gpt-5.6-terra × medium` は model-matrix から明示選択でき、eval artifact から自動で production へ昇格しない。

テストランナーは Node 組み込み (`node --test`)。現行 CI は `.github/workflows/ci.yml` で Node 22.5 / 22.x の Linux / Windows / macOS matrix を `node --test` で走らせる。

`.claude/settings.json` は端末固有の生成物として追跡しない。hook 登録は `spotter install -y` で再生成し、読み取り系 allowlist が必要な環境では `fewer-permission-prompts` で生成してから内容を確認する。

## Historical MVP Scope Boundary

以下は v0.1 設計時の歴史記録。詳細な議事録は [docs/archive/spotter-plan.md](docs/archive/spotter-plan.md) に移動済み。現行作業の優先順位は [docs/open-issues.md](docs/open-issues.md) と、このファイル上部の Repository Status を参照する。

- v0.1: SessionStart/UserPromptSubmit/**PreToolUse**/Stop/SessionEnd hook + 手動 YAML 1 ファイル + 同期実装 + 差し戻し 1 回 + `spotter catalog lint` (test_cases を Haiku 実呼びで検証)。これは歴史記録であり、現行実装は tool-db + `spotter db *` に移行済み。
- v0.2: 孤児プロセス cleanup + Haiku JSON 遵守率計測 + リトライ設計 (必要時)
- v0.3: MCP サーバー列挙によるカタログ自動生成 + カタログ分割 + `/ask-spotter` スラッシュコマンド
- v0.4+: async hook, ドメイン別カタログ, CI 回帰テスト整備

「ついでに v0.2 の機能も入れておく」は棄却する。(2026-04-19 監査反映: PreToolUse は used_tools 空による誤検出回避のため v0.1 に前倒し)

## 決着済みの設計判断 (2026-04-19)

プラン §12.2 / §12.3 の未解決論点 + 実装方針の確定事項。これらは**再議論しない**:

- **指摘の届け方**: UserPromptSubmit は、共通projectorがcatalog照合済みtool IDだけから作る固定・
  非命令形の助言を `additionalContext` へ出す。監査用AIの `reason` は親へ渡さない。Stop findingは
  構造Hook eventに限定し、次ターンのモデル入力へ配送しない。プラン §12.2 / §12.3 の旧透明化書式は
  v1.4.19でこの安全境界に置換した。
- **Haiku への入出力**: 構造化 JSON で固定 (`{pass: bool, missing_tools: [{name, reason}]}`)。自由記述不採用、**リトライなし**。JSON スキーマ不遵守は §14.1 に従って throw。プラン §5.5 参照
- **OS 間 socket 抽象**: Node.js `net` モジュールで Windows (Named Pipe `\\.\pipe\spotter-<id>`) と macOS/Linux (Unix socket `~/.spotter/runtime/session-<id>.sock`) を同一 API で扱い、`process.platform === 'win32'` でパスのみ分岐。プラン §5.6 参照
- **hook ⇄ daemon メッセージ契約**: 改行区切り JSON 1 行。envelope `{id, event, session_id, payload}` / response `{id, ok, result|error}`。タイムアウト表と error code (`E_CATALOG_MISSING | E_HAIKU_SCHEMA | E_HAIKU_TIMEOUT | E_INTERNAL`) を固定。プラン §5.7 参照
- **SessionStart の daemon 起動**: readiness ping が通るまで最大 3 秒ブロック、通らなければ throw。UserPromptSubmit 側で retry しない。プラン §9.1 参照
- **PreToolUse を v0.1 に前倒し**: 当初 v0.2 予定だったが、used_tools が空のまま Stop 判定すると既使用ツール再指摘の誤検出が頻発するため v0.1 に移動 (2026-04-19 監査反映)

## 未解決論点 (設計上の開かれた選択)

プラン §12 のうち、実装段階ではなく **設計思想レベルで開いたまま** の論点。独断で決めずユーザーに確認すること。実装レベルの穴 (Spotter の現コードに存在する技術的課題) は [docs/open-issues.md](docs/open-issues.md) を参照。

- **最初の応答を取り消せない仕様への中長期対応** (§12.4): v1.4.19で Stop hook のblockと
  deferred model-context deliveryをともに使わず、findingは構造Hook eventに限定した。親セッションの
  安全性を優先するため、Stop後にモデルへ補正文を差し込まない。残る論点は「ユーザーが最初の応答を
  **見てから次の入力をするまで**、モデル入力を汚さず安全に指摘を知らせるhost機能が無い」点。Pre-Response
  hook 相当の feature が Claude Code 側で公式追加された場合、`docs-lookup` で確認した通り 2026-05-08
  時点では未提供 ([SPOTTER_HOOK_PARITY_TODO.md](docs/archive/SPOTTER_HOOK_PARITY_TODO.md) 参照)、
  追加されれば再評価する

§12.1 (カタログ初期構築の手動 vs 自動列挙) は v0.7.0 の tool-db 置換で完全に自動側に確定したため、未解決から削除済み。

## Related Project

**Throughline** ([github.com/kitepon-rgb/Throughline](https://github.com/kitepon-rgb/Throughline)) — 同じ作者の既存プロダクト。思想は逆 (引き算=退避 vs 足し算=気づかせ) だが、**「主体に頼らない仕組み」** という哲学と §0 実装規範を共有する。このリポジトリの `.vscode/tasks.json` が起動している `token-monitor` は Throughline のもの。
