# Spotter Claude / Codex Dual Support TODO

> Archived: この文書は完了済み dual-support phase gate の記録です。
> 現行仕様は [`../02_spotter-claude-contract.md`](../02_spotter-claude-contract.md)、
> 現行課題は [`../open-issues.md`](../open-issues.md) を参照してください。

この文書は `docs/archive/SPOTTER_CODEX_DUAL_SUPPORT.md` に基づく作業計画書兼 TODO。
`CLAUDE.md` を正本とし、Spotter の Claude-first workflow を維持したまま Codex
adapter を追加する。

## Source Of Truth

- 正本: [`../../CLAUDE.md`](../../CLAUDE.md)
- Claude contract: [`../02_spotter-claude-contract.md`](../02_spotter-claude-contract.md)
- 現状課題: [`../open-issues.md`](../open-issues.md)
- Dual-support 方針: [`SPOTTER_CODEX_DUAL_SUPPORT.md`](SPOTTER_CODEX_DUAL_SUPPORT.md)
- 次段階の primary auditor backend migration: [`SPOTTER_PRIMARY_BACKEND_TODO.md`](SPOTTER_PRIMARY_BACKEND_TODO.md)
- この文書: 実装順序、TODO、現時点の所見
- Sidecar consuming repo 設定: [`../../.codex-sidecar.yml`](../../.codex-sidecar.yml)

この文書の実装対象は完了済みの second-pass `codex-sidecar` workflow です。
`UserPromptSubmit` / `Stop` の主判定 backend を Codex CLI / `codex-sidecar` に移す作業は
[`SPOTTER_PRIMARY_BACKEND_TODO.md`](SPOTTER_PRIMARY_BACKEND_TODO.md) を参照してください。

## 現在の Spotter 機能整理

Spotter は Claude Code の hook から独立 daemon を起動し、Bell の意図に依存せず
tool-use を監査する。

- `spotter install` が `.claude/settings.json` に hook を登録し、`.spotter/marker.json`
  と project-local `tool-db.json` を用意する。
- `SessionStart` で daemon を起動し、`UserPromptSubmit` / `PreToolUse` / `Stop` /
  `SessionEnd` が daemon と newline-delimited JSON で通信する。
- daemon は project-local tool-db のみを読み、MCP / skills / agents の
  `{name, description}` catalog を Claude Haiku に渡す。
- Haiku は `user_input` stage で要請充足を、`turn_end` stage で最終応答への
  tool 適用機会を判定し、`{pass, missing_tools}` JSON を返す。
- `UserPromptSubmit` は additionalContext を、`Stop` は `decision:"block"` を返す。
- Haiku spawn は isolated workdir + empty MCP config で動き、Bell 側 MCP を eager load
  しない。
- Spotter は過去に daemon 増殖事故を起こしている。`docs/archive/spotter-plan.md` §18 に記録があり、
  `SessionStart` が subagent ごとに発火して 213 daemon が spawn した。現行版は
  `SPOTTER_PARENT_PID` / `agent_id` gate / `source=startup` 限定 / PID preexist check /
  10 秒 Haiku call window の再帰ガード 5 層に、`.spotter/marker.json` による
  project gate を重ねて回避している。

## 現時点の所見

Spotter の中核である「主役に自己監査させない」は強い。特に project-local DB 限定、
hook-driven daemon、empty MCP config による Haiku 隔離は、Claude-first のまま
agent-neutral 化する土台として良い。

一方で、dual support の前に回帰テスト化 / snapshot 化したい点がある。

- 現在の「finding」は実質 `missing_tools` で、neutral core の stable schema ではない。
  Codex に渡すなら `SpotterFinding` / `SpotterJudgment` 相当を導入し、Claude report は
  その projection にするのが自然。
- `turn_end` prompt の few-shot は、以前 `Read` / `current_time` など catalog 対象外の例で
  Haiku を catalog-external 名へ誘導し得る状態だった。矛盾監査で、例示カタログに存在する
  tool 名だけを使う形へ修正済み。今後は prompt snapshot でこの性質を回帰テスト化する。
- `turn_end` は意図的に `user_input` を渡さないため、応答内容だけを見た過検出に寄りやすい。
  open issues の過検出率観測と合わせ、finding に category / confidence / stage を持たせて
  後段の Codex risk-check が扱いやすい形にしたい。
- role-collapse の silent pass は既に CLAUDE.md で例外分類されているが、Codex 側へ渡す
  structured result では anomaly として保存できるようにした方が透明性が高い。
- 現コードには Claude background subagent を `Agent` で呼ぶ実装は見当たらない。最初に移す
  対象は既存 Haiku auditor の置換ではなく、finding の second-pass risk / review / opinion
  を担う Codex adapter が適切。
- Spotter は consuming repo として `.codex-sidecar.yml` を持つ。`codex-sidecar diagnostics
  --project /home/kite/projects/Spotter --preset review --json` は 2026-05-06 時点で成功済み。

## Safety Invariants

Dual-support 実装では、`docs/archive/spotter-plan.md` §18 の daemon 増殖事故を最優先で保護する。
絶対条件は「recursive hook / daemon proliferation を再発させない」こと。現行の
再帰ガード 5 層 + project marker gate は実証済み baseline として扱うが、同等以上に単純・堅牢・効率的な手段が
あるなら置き換えてよい。その場合は、どの failure path を防ぐのか、なぜ同等以上と
言えるのか、どの regression test で守るのかを先に明記する。

### Daemon Proliferation Baseline

- `SPOTTER_PARENT_PID`: Spotter 自身が起動した `claude -p` の子 hook は即 return する。
- `agent_id` gate: Bell の Task subagent 内 hook は即 return し、subagent を監査対象にしない。
- `source === "startup"`: `/compact` / `/clear` / `--resume` / `--continue` 由来の
  `SessionStart` では daemon を起動しない。
- `.spotter/marker.json`: install 済み project 外では hook が即 return する。
- PID preexist check: 同一 `session_id` の daemon が生きていれば新規 daemon を起動しない。
- 10 秒 Haiku call window: 上記をすり抜けた recursive hook の最終防衛線として
  `user_input` / `turn_end` を pass する。

### Daemon Lifecycle Baseline

VSCode native Claude Code extension では `process.ppid` が短命 wrapper を指すため、
parent PID watch は使わない。現行の app-level heartbeat を維持する。

- daemon は envelope を受けるたび heartbeat self-shutdown timer を reset する。
- 30 分無通信なら daemon は自分で shutdown する。
- `UserPromptSubmit` は `E_UNREACHABLE` で daemon を auto-resurrect し、再送する。
- Codex sidecar / worktree 実装でも、親 PID 監視を復活させない。

### Codex Safety Boundary

Codex sidecar integration は、この安全保証の外側に置く。特に `codex_work` や isolated
worktree execution を追加する場合、sidecar が Claude / Spotter hook を再発火させる経路を
先に潰す。

- sidecar 起動時の env / cwd / marker policy を明示する。
- sidecar が `claude -p` 相当を呼ぶ設計にする場合、Spotter hook gate と同等の再帰遮断を先に入れる。
- subagent 監査を復活させる提案は、この事故の再発リスクと trade-off を明記し、
  現行 baseline と同等以上の代替策を示すまで実装しない。

## Work Strategy

実装順は「安全 contract を回帰テスト化する → neutral schema を作る → Claude projection を維持する →
Codex projection を足す → sidecar execution を足す」。Codex を動かす前に、まず Spotter の
現在の Claude behavior を回帰テスト化する。

各 phase は次の gate を満たすまで次へ進まない。

- contract doc がある。
- regression test または fixture snapshot がある。
- 既存 Claude workflow を壊していない。
- daemon proliferation / lifecycle safety に影響がある場合、代替安全保証が明文化されている。

## TODO

### Phase 0. Baseline Documents

- [x] Root `AGENTS.md` を追加し、`CLAUDE.md` 正本方針を明文化する。
- [x] この TODO 文書を作成する。
- [x] daemon 増殖事故 (`docs/archive/spotter-plan.md` §18) と、同等以上の代替を許す安全保証を明文化する。
- [x] VSCode native extension の `process.ppid` trap を反映し、heartbeat + auto-resurrect を safety invariant に含める。
- [x] `README.md` / `README.ja.md` の Design docs に
  `docs/archive/SPOTTER_CODEX_DUAL_SUPPORT.md` とこの TODO への導線を追加する。
  Phase 0 ではリンク追加だけを行い、Codex projection / execution の説明追加は後続 phase に回す。
- [x] `.codex-sidecar.yml` を追加し、Spotter repo が `codex-sidecar diagnostics --project <repo> --preset review`
  を実行可能な consuming repo であることを確認する。

Deliverable:

- `AGENTS.md`
- この TODO
- `docs/02_spotter-claude-contract.md`
- README design docs への導線
- `.codex-sidecar.yml`

### Phase 1a. Current Claude Contract Capture

目的: Codex のために Claude behavior を accidentally change しない状態を作る。
ここでは現時点の contract を回帰テスト / fixture / snapshot に落とす。Phase 1b の prompt precision fix は
矛盾監査で先行して入ったため、snapshot 対象は修正後の現在挙動とする。

- [x] 既存 command contract を棚卸しする:
  `install`, `uninstall`, `db list`, `db refresh`, `db rebuild`, `status`, `doctor`,
  internal `daemon`, internal `hook`。
- [x] hook 入出力 contract を棚卸しする:
  `UserPromptSubmit` additionalContext、`Stop` block reason、`PreToolUse` recording、
  `SessionStart` daemon readiness、`SessionEnd` shutdown。
- [x] daemon 増殖防止 contract を棚卸しする:
  `SPOTTER_PARENT_PID`, `agent_id`, `source=startup`, marker gate, PID preexist,
  10 秒 Haiku call window。
- [x] daemon lifecycle contract を棚卸しする:
  heartbeat self-shutdown、`UserPromptSubmit` auto-resurrect、parent PID watch 非採用。
- [x] daemon IPC contract を棚卸しする:
  envelope `{id,event,session_id,payload}` と response `{id,ok,result|error}`。
- [x] Haiku prompt / response contract を棚卸しする:
  preamble-once、stage prompt、`parseHaikuResponse` schema、catalog filtering。
- [x] `--help` / `--version` / unknown command / unknown hook event の CLI contract test を追加する。
- [x] `SessionStart` が `agent_id` あり / `source !== "startup"` / `SPOTTER_PARENT_PID` あり /
  marker なしで daemon spawn しない test を追加する。
- [x] `UserPromptSubmit` auto-resurrect と heartbeat timeout の既存 test coverage を確認し、
  不足分として `E_UNREACHABLE` → daemon spawn → retry の hook test を追加する。
- [x] hook output wording (`formatTransparentContext`, `formatTransparentBlockReason`) を exact string test にする。
- [x] prompt builder snapshot を追加する:
  `buildPreamble`, `buildFirstStagePrompt`, `buildFinalStagePrompt` を小さな fixture catalog で回帰テスト化する。
  `buildPreamble` / `buildFirstStagePrompt` / `buildFinalStagePrompt` は exact string test 追加済み。

Gate:

- `node --test`
- Claude-facing output wording と hook gates が回帰テスト化されている。
- Haiku prompt builders が fixture catalog で snapshot 化されている。

### Phase 1b. Prompt Precision Fix

目的: Phase 1a で回帰テスト化した現行 contract との差分を、意図的な品質修正として扱う。

- [x] `turn_end` few-shot から catalog-external な `Read` / `current_time` 例を外すか、
  fixture catalog に含まれる tool だけで構成した example、または catalog に依存しない pass example に
  置き換える。Phase 2 の schema fixture 作成前に完了する。
- [x] prompt builder snapshot を更新し、catalog-external な `"current_time"` / `"Read"` 名を誘導しないことを確認する。

Gate:

- `node --test`
- Haiku prompt examples が catalog-external 名を誘導しない。

### Phase 2. Agent-Neutral Finding Core

目的: `missing_tools` を Claude prompt の中間表現から Spotter core の finding へ昇格する。

- [x] `missing_tools` をそのまま外へ出す前に、neutral な `SpotterFinding` schema を定義する。
- [x] 最低限の field を決める:
  `id`, `stage`, `toolName`, `reason`, `category`, `severity`, `confidence`,
  `references`, `source`, `raw`。
  `category`, `severity`, `confidence` は根拠が無い場合 optional または `unknown` とする。
  `references` は根拠が無い場合 optional または empty array とし、架空の path / line を作らない。
  推定・抽出した field は `source` / `raw` に根拠を残す。
- [x] `SpotterJudgment` schema を定義する:
  `pass`, `findings`, `anomalies`, `meta`。
- [x] Haiku parse result から `SpotterJudgment` への変換を pure function として切り出す。
- [x] `anomalies` の扱いを既存 hook behavior と整合させる:
  `role_collapse_reset` / `hallucination_filtered` は normal judgment 側に載せてよい。
  `E_HAIKU_TIMEOUT` / `E_INTERNAL` は従来通り throw し、normal `SpotterJudgment` に変換しない。
  必要な診断は throw 前の daemon log に残し、将来の side-channel result は Phase 7 で追加する。
- [x] 既存 Claude output は `SpotterFinding[]` から生成する projection に変える。
- [x] 既存 report wording は維持し、snapshot / unit test で回帰テスト化する。

Gate:

- [x] Claude output が Phase 1a / 1b の fixture と一致する。
- [x] `SpotterFinding` / `SpotterJudgment` の unit test がある。

### Phase 3. Codex Context Adapter, No Execution

目的: まず Codex を起動せず、Spotter findings を machine-readable context として渡せる形にする。

- [x] `SpotterFinding[]` から `SidecarContextBlock` を作る変換層を追加する。
- [x] dedicated kind が無い間は `kind:"manual_note"`, `source:"spotter"`,
  `trust:"local"` を使う。
- [x] Spotter 側ではまず local JSON schema / fixture として `SidecarContextBlock` 互換 shape を定義する。
  `codex-sidecar-core` を runtime dependency に追加するかは Phase 4 で判断し、Phase 3 では
  sidecar 不在でも unit tests が動くことを優先する。
- [x] context block fixture を追加し、path / line / ruleId / severity の serialize を回帰テスト化する。
  `severity` が未知の場合は `unknown` または field omission のどちらかに統一する。
  `ruleId` は detector-backed finding のみ optional で持つ。tool-miss finding では omitted、
  または stable generic kind (`spotter.tool_miss`) に限定し、架空 detector ID を作らない。
- [x] Codex `SidecarResult` を prose scraping なしで保存する schema を決める。
- [x] `codex-sidecar` が無くてもこの adapter の unit tests が通るようにする。
- [x] dual-support docs に「Codex execution はまだしない projection phase」と明記する。
  README は Phase 0 のリンク追加に留め、詳細説明は docs 側に置く。

Gate:

- [x] Codex binary / sidecar 不在環境で test が通る。
- [x] Claude workflow に runtime dependency を増やしていない。

### Phase 4. Execution Policy And Availability

目的: sidecar を呼んでよい条件を明確化し、sidecar unavailable を hidden fallback ではなく
explicit skipped / compatibility result にする。

- [x] host agent を `claude`, `codex`, `automation`, `unknown` として判定または明示設定できるようにする。
- [x] `codex-sidecar diagnostics --project <repo> --preset review` を availability check の正本にする。
  Spotter repo 自体には `.codex-sidecar.yml` があり、manual diagnostics は成功済み。
  Phase 4 では command builder と state classifier を実装する。実際の diagnostics 実行と
  cached availability 読み書きは CLI / daemon wiring 時に追加し、`UserPromptSubmit` / `Stop`
  の latency-sensitive path では実行しない。
- [x] availability state を実装する:
  `unavailable`, `configured`, `operational`, `work-capable`, `explicitly disabled`。
- [x] availability state と diagnostics failure reason を structured result に残す。
- [x] Claude host では independent review / risk / explore / opinion に Codex sidecar を優先する。
- [x] Codex host では isolation / durable structured result / explicit second-pass がある場合だけ
  Codex sidecar を使い、通常は current Codex session に findings を渡す。
- [x] Codex sidecar 起動時に Spotter hook が再帰発火しない env / cwd / marker policy を決める。
- [x] `codex-sidecar` unavailable 時は second-pass workflow を `status:"skipped"` として明示 result 化し、
  既存 Claude-backed Haiku auditor behavior は変更しない。
- [x] Unknown / automation mode は explicit config なしに recursive delegation を推測しない。
- [x] read-only sidecar 起動でも Spotter hook が再帰発火しない regression test / smoke を追加する。
  test oracle は diagnostics 成功だけにしない。unit test では hook 関数を harness から呼び、
  spawn function mock が呼ばれないことを確認する。integration / smoke では daemon PID file 数や
  daemon count が増えないことを確認する。hook gate reason logging は optional instrumentation とし、
  oracle の必須条件にしない。

Gate:

- [x] sidecar absent / diagnostics failure / explicitly disabled の fixture がある。
- [x] Codex primary で無意味な Codex-on-Codex recursion が発生しない policy test がある。
- [x] sidecar 起動が Spotter hook を再帰発火させないことが Phase 5 前に検証済み。

### Phase 5. Read-Only Codex Workflows

目的: 書き込みを伴わない independent second pass から開始する。

- [x] `codex_risk_check`: finding を deeper risk analysis に変換する read-only workflow。
  明示 CLI `spotter codex risk-check --findings FILE` を追加し、`SpotterFinding[]` を
  context-file 経由で `codex-sidecar risk-check --preset risk-check` に渡す。
  結果は `spotter.sidecar_result.v1` として保存 / stdout 出力する。
- [x] daemon の `pass:false` finding から `codex_risk_check` へ非同期 dispatch する opt-in 経路を追加する。
  `SPOTTER_CODEX_RISK_CHECK=1` のときだけ有効化し、detached process で
  `spotter codex risk-check` を起動する。hook hot path は Codex を待たない。
  smoke / 配線確認には `SPOTTER_CODEX_RISK_CHECK_DRY_RUN=1` を使う。
- [x] `codex_review`: diff review に Spotter findings を context として渡す workflow。
  明示 CLI `spotter codex review --findings FILE` を追加し、`codex-sidecar review`
  に context-file を渡す。
- [x] `codex_explore`: finding が trigger した理由を調査する workflow。
  明示 CLI `spotter codex explore --findings FILE` を追加し、`codex-sidecar explore`
  に context-file を渡す。
- [x] `codex_opinion`: remediation plan への independent critique workflow。
  明示 CLI `spotter codex opinion --findings FILE` を追加し、`codex-sidecar opinion`
  に context-file を渡す。
- [x] read-only smoke test を追加する。理想は `codex_risk_check`。
  通常の `node --test` には実 sidecar smoke を混ぜない。smoke は明示 env
  (`SPOTTER_CODEX_SIDECAR_SMOKE=1` など) または `spotter doctor` 系に分離する。
  2026-05-06 に `spotter codex risk-check --dry-run --host-agent claude` で実 CLI dry-run 成功済み。

Gate:

- [x] read-only workflows が structured result を保存し、prose scraping に依存しない。
  `codex_risk_check` / `codex_review` / `codex_explore` / `codex_opinion` は共通 runner で
  `spotter.sidecar_result.v1` として保存 / stdout 出力する。
- [x] `codex-sidecar` unavailable で Claude-backed Haiku auditor behavior が維持される。
  second-pass workflow は hidden fallback せず `status:"skipped"` の structured result として返す。
  Codex host の primary auditor backend unavailable 時に Haiku fallback する、という意味ではない。

### Phase 6. Work-Capable Codex Workflow

目的: 明示許可された場合だけ isolated worktree で scoped fix を行う。

- [x] `codex_work`: 明示許可 + `work-capable` の場合だけ isolated worktree で scoped fix。
  `spotter codex work` は `--approve-work`、`--instruction`、`--allowed-path`、
  cleanup policy を必須にし、`codex-sidecar work --preset work` を呼ぶ。
- [x] allowed paths / write scope / cleanup policy を必須にする。
  Spotter が一時 scoped config を作り、承認された `--allowed-path` だけを sidecar
  `allowed_paths` に渡す。結果の `changedFiles` も Spotter 側で再検査する。
- [x] approved scope が dirty / untracked の場合は sidecar 起動前に止める。
  isolated worktree は `HEAD` から作られるため、main 側の未コミット docs / src を
  sidecar が見失う。`codex_work_dirty_approved_scope` structured error で明示停止する。
- [x] sidecar worktree 内で Spotter hook / Claude hook が再帰発火しないことを検証する。
  work runner も `buildSidecarSpawnOptions({ marker:"codex-work" })` 経由で
  `SPOTTER_PARENT_PID` / `SPOTTER_SIDECAR` を付ける。hook recursion guard test は
  read-only / work 共通 policy として固定済み。
- [x] worktree-backed fix の result schema に changed files / tests / diagnostics を含める。
  `spotter.sidecar_result.v1` の `result` に sidecar が返す `changedFiles`,
  `tests`, `diagnostics`, `worktreePath`, `worktreePreserved` を保持する。

Gate:

- [x] work-capable smoke が通る。
  `codex-sidecar diagnostics --preset work` の normalized request を検査し、
  worktree / allowed paths 条件を満たす場合だけ `work-capable` に昇格する。
- [x] daemon proliferation safety の regression test が通る。

### Phase 7. Precision Work Before Broad Adoption

目的: dual support の前後で検出品質を落とさない。

- [x] open issues の過検出率観測と接続し、finding に category / confidence を持たせる。
  `SpotterFinding` は `category` / `confidence` を持ち、`docs/open-issues.md` の観測タスクは
  `spotter diagnostics logs --json` で集計する運用に接続済み。
- [x] Haiku anomaly を structured diagnostics として記録する。
  `role_collapse_reset` / `hallucination_filtered` は normal judgment diagnostics、
  timeout / internal error は throw を維持したうえで side-channel diagnostics に残す。
  timeout / internal error は daemon log の既存記録を `spotter.daemon_log_summary.v1` として
  read-only 集計する。
- [x] frontmatter block scalar 非対応を解消する。
  `description: >` / `description: |` を zero-deps parser のまま読み取り、
  skill discovery の silent skip 回帰を `test/tool-db.test.mjs` で固定済み。
- [x] Unix daemon IPC permission を owner-only に固定する。
  `~/.spotter/runtime` は `0700`、Unix socket は listen 後に `0600`。
  Windows Named Pipe DACL は Node 標準 API だけでは同粒度に扱えないため、
  `docs/open-issues.md` に P2 として残す。
- [x] MCP text parse の具体的な tokenizer 穴を縮める。
  `claude mcp list --json` は 2026-05-06 時点のローカル CLI で未提供だったため、
  text format 依存の上位課題は残しつつ、空白入り Windows 実行ファイルパスと
  quoted args の parser regression を塞いだ。
- [x] daemon log から pass=false / missing tool / dropped catalog-external / role collapse / timeout を集計する
  read-only diagnostics を追加する。
  `spotter diagnostics logs [--json]` が daemon log を読み、stage 別 pass=false、
  missing tool 内訳、duration、catalog-external drop、role collapse、Haiku failure、
  handler error、fatal、Codex risk dispatch signal を structured summary にする。

### Done Definition

- [x] 既存 Claude workflow が通る。
  `npm test` は 2026-05-06 時点で `211 pass / 1 skipped / 0 fail`。
- [x] Claude hook 実環境相当の smoke が通る。
  2026-05-06 に project-local `spotter install -y` 後、Claude Code の新セッションで
  `UserPromptSubmit` が `mcp__caveat__caveat_search` を推奨し、Claude が実際に
  caveat search / memory search を実行した。daemon log
  `daemon-a01044fe-98a3-424a-a2fd-48ea78a80faf.log` では
  `user_input: pass=false, missing=mcp__caveat__caveat_search`,
  `tool_used: mcp__caveat__caveat_search`, `turn_end: pass=true` を確認済み。
- [x] Spotter findings を Codex が structured context として consume できる。
  `SpotterFinding[]` は `SidecarContextBlock` 互換 JSON として context-file に渡される。
- [x] Codex risk / review result を prose scraping なしで保存できる。
  `codex_risk_check` / `codex_review` / `codex_explore` / `codex_opinion` は
  `spotter.sidecar_result.v1` を stdout / `.spotter/sidecar-results/` に保存する。
- [x] Codex work result を isolated worktree + scoped write policy で保存できる。
  `codex_work` は明示承認、allowed paths、cleanup policy、work-capable diagnostics を必須にし、
  `spotter.sidecar_result.v1` に `changedFiles` / `tests` / `diagnostics` を保持する。
- [x] Codex primary mode が意味のない recursive Codex delegation を避ける。
  policy test で Codex-on-Codex guard を固定済み。明示 second-pass / structured boundary がある場合だけ許可。
- [x] `codex-sidecar` unavailable environment では既存 Claude-backed Haiku auditor behavior が維持される。
  これは second-pass `codex-sidecar` workflow の unavailable を指す。unavailable は hidden fallback せず
  `status:"skipped"` structured result として残し、Claude-backed Haiku auditor は現状維持する。
  Codex host の primary auditor backend unavailable 時に Haiku fallback する、という意味ではない。
- [x] いつ Codex sidecar が有用で、いつ current-agent direct handling がよいか docs に説明されている。
  `docs/archive/SPOTTER_CODEX_DUAL_SUPPORT.md` の host / availability policy に反映済み。
- [x] daemon proliferation と daemon lifecycle の安全保証が、docs と regression tests の両方で守られている。
  `SPOTTER_PARENT_PID` / `agent_id` / startup source / marker / PID preexist /
  Haiku call window / heartbeat を docs と tests で固定済み。
