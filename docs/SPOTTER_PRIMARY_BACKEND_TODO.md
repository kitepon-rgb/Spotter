# Spotter Primary Backend Migration TODO

この文書は、Spotter の auditor backend を host agent ごとに切り替えるための
作業計画書兼 TODO。`CLAUDE.md` を正本とし、既存の Claude hook contract と
daemon proliferation safety を壊さない。

## Document Map

- 正本: [`../CLAUDE.md`](../CLAUDE.md)
- 現状課題: [`open-issues.md`](open-issues.md)
- Claude hook / daemon / Haiku contract: [`SPOTTER_CLAUDE_CONTRACT.md`](SPOTTER_CLAUDE_CONTRACT.md)
- 完了済みの Claude / Codex second-pass workflow 計画: [`SPOTTER_CODEX_DUAL_SUPPORT_TODO.md`](SPOTTER_CODEX_DUAL_SUPPORT_TODO.md)
- second-pass workflow の設計ブリーフ: [`SPOTTER_CODEX_DUAL_SUPPORT.md`](SPOTTER_CODEX_DUAL_SUPPORT.md)
- 歴史的な daemon 増殖事故: [`spotter-plan.md`](spotter-plan.md) §18

この文書は、完了済みの `codex_risk_check` / `codex_review` / `codex_work` を
`UserPromptSubmit` / `Stop` の主判定 backend と混同しないための次段階計画です。

## Goal

最終 default は Phase 4 の backend matrix evaluation で決める。
現時点の初期仮説は次の通り。

| Host | Primary auditor backend | Compatibility / fallback |
|---|---|---|
| Codex | Codex CLI (`codex exec`) | なし。失敗は structured error |
| Claude | `codex-sidecar` を第一候補。ただし `Claude + Codex CLI` も評価対象 | 明示 compatibility mode の場合だけ現行 Claude Haiku |
| Unknown / automation | 明示設定がある場合のみ | 明示設定なしなら structured error |

ここでいう backend は、`UserPromptSubmit` / `Stop` 相当の主判定
(`{pass, missing_tools}` / `SpotterJudgment`) を返す auditor のこと。
前回完了した `codex_risk_check` / `codex_review` / `codex_work` は
second-pass workflow であり、primary backend 置換ではない。

## Current Understanding

- 現行 Spotter の主判定は Claude Haiku。
- Spotter は既に `SpotterJudgment` / `SpotterFinding` を持つので、backend 差し替えの
  contract surface は作れている。
- `codex-sidecar` は structured result / worktree / sidecar config を扱えるが、Claude host の
  second-pass 用に足した経路であり、primary auditor としてはまだ使っていない。
- ローカル Codex CLI は `codex-cli 0.128.0-alpha.1`。
- `codex exec` には `--json`, `--output-schema <FILE>`, `--ephemeral`,
  `--output-last-message <FILE>`, `--ignore-user-config`, `--ignore-rules`,
  `--sandbox read-only`, `--cd <DIR>` がある。
  したがって、Codex CLI は primary auditor backend 候補として検証できる。

## Opinion

「Codex host のときは codex-sidecar より Codex CLI が効率的」という仮説は筋が良い。
理由は、同じ Codex 系モデルを使うなら sidecar の app-server / config shaping /
result wrapping を挟まず、`codex exec --output-schema` で直接 JSON 判定を取れる可能性が
あるため。

ただし、これはまだ実測前の仮説。採用条件は以下を満たすこと。

- `codex exec --output-schema` が Spotter の小さい JSON 判定を安定して返す。
- `codex exec --ephemeral --sandbox read-only` で session / worktree / MCP 副作用を持たない。
- Haiku first / resumed と比較して、latency と process cost が許容範囲。
- Codex host から Codex CLI を呼んでも recursive delegation / session proliferation を起こさない。

重要な運用前提として、Claude 環境では Spotter による遅延がすでに UX に影響している。
そのため latency tuning は Claude hook 上でいきなり詰めない。まず Codex native 環境に
Spotter を適用し、Codex CLI backend を前提に小さい判定・cache・async 化・skip 条件を
詰める。その後、効果が実測できたものだけを Claude host に移植する。Claude は最後に
移植・比較する対象であり、最初の実験場にはしない。

## Concerns

### 1. Codex CLI は alpha

`codex-cli 0.128.0-alpha.1` なので、CLI option と JSONL event shape は drift し得る。
`--output-schema` があるのは強いが、Spotter 側では parser / diagnostics を
version-aware にし、unknown event shape を hidden fallback しない。
`--output-last-message <FILE>` も使えるため、primary auditor では final JSON の正本を
last-message file に寄せ、JSONL は duration / event diagnostics の補助として扱う方が実装しやすい。

2026-05-06 の smoke では、`codex exec --json --output-schema --output-last-message --ephemeral
--ignore-user-config --ignore-rules --sandbox read-only --cd <repo>` が schema-valid
`{"pass":true,"missing_tools":[]}` を last-message file に書くことを確認した。一方で、
stdin が pipe と見なされると `Reading additional input from stdin...` が出るため、backend spawn は
stdin を明示的に `ignore` する必要がある。また `--ignore-user-config` 指定時でも plugin / skill
manifest warning と analytics 403 が stderr に出たので、stderr は失敗判定の正本にせず、bounded
diagnostics として扱う。
config / auth 隔離を検討する場合も、`CODEX_HOME` を安易に差し替えると認証情報まで見えなくなる
可能性があるため、auth path を明示確認したうえで別 spike にする。

### 2. Codex-on-Codex の再帰

Codex host で Spotter が Codex CLI を呼ぶと、構図は `Codex primary -> Spotter -> Codex CLI`。
これはユーザーの希望する方向だが、無制限にやると Claude 時代の daemon 増殖事故と同じ種類の
事故になり得る。Codex backend spawn には必ず `SPOTTER_PARENT_PID`,
`SPOTTER_BACKEND=codex-cli`、`SPOTTER_CHILD_BACKEND=codex-cli` 相当の marker を付け、
Spotter hook / Codex plugin / future Codex integration が再入しない gate を置く。
`SPOTTER_SIDECAR=1` は `codex-sidecar` 子プロセス向けの既存 marker なので、Codex CLI
backend では名前を混同しない。

### 3. Codex host integration の入口が未確定

Claude Code には hooks があるが、Codex 側で同等の `SessionStart` /
`UserPromptSubmit` / `PreToolUse` / `Stop` event があるとは限らない。
Codex 対応はまず以下のどちらかを明確にする。

- Codex plugin / MCP / wrapper として Spotter を明示実行する。
- Codex CLI の app-server / exec-server / future hook surface に接続する。

Codex 側 event model が未確定のまま、Claude hook 前提の daemon を流用しない。

### 4. Claude host の latency

Claude host で primary backend を Codex 系 backend (`codex-sidecar` または Codex CLI) にすると、
UserPromptSubmit / Stop が Codex を待つ。現行 Haiku でも first 10-30s があり、選択 backend が
それを上回るなら体感悪化する。Claude host では選択 backend を sync hook に入れる前に、
timeout budget と observed latency を必ず測る。

この問題は最重要だが、解決順序は「Codex native で最適化 → Claude に移植」。Claude hook は
UX への影響が直撃するため、backend 実験の場にしない。Claude host での変更は、Codex native
で latency / schema success / false positive の改善が確認できてから opt-in で入れる。

### 5. Fallback の扱い

ユーザー方針として hidden fallback は禁止。Claude host で選択された Codex backend が無い場合に
Haiku を使うのは「現状維持 compatibility mode」として明示された policy の場合だけにする。
Codex host では Codex CLI が無い場合に Haiku へ落とさない。Codex 対応を謳うなら、
Codex backend の不在は structured error にする。

## TODO

### Phase 0. Terminology And Contract

- [x] `docs/SPOTTER_CLAUDE_CONTRACT.md` に "primary auditor backend" と
  "second-pass sidecar workflow" の違いを追記する。
- [x] `docs/SPOTTER_CODEX_DUAL_SUPPORT.md` に、現状は second-pass 完了であり
  primary backend migration はこの文書の対象である、と明記する。
- [x] `AGENTS.md` にこの TODO への導線を追加する。
- [x] backend selection policy の初期仮説を文書化する:
  `host=codex -> codex-cli`, `host=claude -> matrix-selected codex backend -> compatibility_haiku`,
  `host=unknown -> explicit config required`。

Gate:

- [x] docs 上で「TODO 完了 = codex-sidecar が主 backend」だと読める矛盾がない。

### Phase 1. Backend Interface

- [ ] `src/core/auditor-backend.mjs` を追加し、backend-neutral interface を定義する。
  入力は `stage`, `catalog`, `userInput`, `usedTools`, `finalResponse`, `meta`。
  出力は `SpotterJudgment`。ただし Haiku は preamble-once / session reset を持つ stateful backend
  なので、単純な stateless function にはしない。
- [ ] backend interface は `createAuditorBackend({backend, catalog, projectRoot, env, logger})`
  のような factory にし、戻り値は `judge(input)`, `reset()`, `dispose?()`, `name` を持つ。
  Haiku は factory 時に `buildPreamble({tools:catalog})` と `createHaikuCaller` を初期化する。
- [ ] `catalog` は daemon startup 時点の project-local `readLocal` 結果を正本にし、
  per-turn で再読込しない。これは現行 preamble-once behavior と一致させるため。
- [ ] auditor response parser を backend-neutral にする。
  現行 `parseHaikuResponse` の JSON schema check は `parseAuditorResponse` /
  `validateAuditorResponse` として切り出し、Codex CLI backend でも同じ schema check を使う。
  既存 export 名は compatibility wrapper として残してよい。
- [ ] catalog-external filtering は parser から独立した backend-neutral post-parse step として残す。
  現行 `filterCatalogMisses(parsed, catalogNames)` の pass-flip semantics と observability を維持し、
  Haiku adapter / Codex CLI adapter の両方から同じ関数を通す。
- [ ] prompt / catalog formatting の共有境界を決める。
  `SpotterJudgment` schema、catalog `{name,description}` の列挙、stage 入力タグは共有してよいが、
  Haiku の preamble-once prompt を Codex CLI にそのまま流用しない。Codex CLI 用には
  stateless / small prompt を別 builder にし、snapshot で固定する。
- [ ] 現行 Haiku 呼び出しを `haiku` backend adapter として包む。
  `E_HAIKU_SCHEMA` の role-collapse recovery、`E_HAIKU_TIMEOUT` / `E_INTERNAL` の throw 前 reset、
  catalog-external filtering、duration meta を既存挙動と同じにする。
- [ ] `AuditorBackendError` の structured error shape を定義する。
  最低限 `code`, `backend`, `stage`, `message`, `diagnostics?`, `cause?` を持たせ、
  hook / daemon transport へ投影するときに hidden fallback や silent pass に潰さない。
- [ ] daemon は backend adapter 経由で判定し、既存 Haiku behavior は完全一致させる。
  ただし short prompt skip、`turn_end` の `no_user_input` pass、`PreToolUse` の記録専用処理は
  backend の外側に残し、現行 hook latency と挙動を変えない。
- [ ] host detection は `codex-sidecar-policy.mjs` から独立した neutral module に移すか、
  primary backend 側から sidecar policy を import しない wrapper を用意する。
  `detectHostAgent` は sidecar 固有 policy ではなく auditor backend selection の基礎情報として扱う。
- [ ] backend selection は pure function にする。
  入力は `hostAgent`, `env`, `projectConfig?`, `stage`、出力は
  `{backend, mode, compatibility, reason}`。ここでは spawn / diagnostics を実行しない。
- [ ] `SPOTTER_AUDITOR_BACKEND` で明示 override できるようにする。
  値は `haiku`, `codex-cli`, `codex-sidecar`, `auto` に限定し、未知値は structured error。
  ただし `codex-sidecar` primary auditor adapter は Phase 4 の auditor workflow が存在するまで
  `E_BACKEND_NOT_IMPLEMENTED` として扱い、Haiku へ hidden fallback しない。
- [ ] `auto` は policy / host default へ委譲するだけの値とし、backend availability check や
  fallback 実行はしない。`hostAgent=unknown|automation` で明示 backend が無い場合は
  `E_BACKEND_HOST_UNKNOWN` を返す。
- [ ] `SPOTTER_AUDITOR_BACKEND_POLICY` は rollout preset (`current`, `next`) として扱い、
  `SPOTTER_AUDITOR_BACKEND` の明示 override と混同しない。優先順位を
  explicit backend > policy preset > host default として test で固定する。
- [ ] Phase 1 時点の preset は `current=現行 Haiku behavior`、
  `next=Codex host だけ codex-cli opt-in / Claude host は現行 Haiku` として固定する。
  Claude host の `next` を Codex 系 backend に切り替えるのは Phase 5 以降に限定する。
- [ ] daemon log には Phase 1 から `backend=<name>` を出す。
  既存 diagnostics parser の backend 集計拡張は Phase 6 でよいが、Phase 2-4 の実測に使う
  raw signal は最初に入れる。
- [ ] unit test は少なくとも backend selector、unknown env の structured error、
  Haiku adapter compatibility、parser / catalog filtering の分離を固定する。

Gate:

- [ ] 既存 `npm test` が通る。
- [ ] Claude hook 実セッション smoke が現行と同じ挙動。
- [ ] Haiku backend adapter は既存 prompt snapshot と response schema を変えない。
- [ ] `createHaikuCaller` の preamble-once / reset semantics が adapter 経由でも維持される。
- [ ] Codex CLI 用 prompt builder を追加しても、Haiku prompt snapshot は変わらない。
- [ ] primary backend module が `codex-sidecar-policy.mjs` に直接依存しない。

### Phase 2. Codex CLI Backend Spike

- [ ] `codex exec --output-schema` 用の JSON schema を追加する。
  schema は現行 Haiku response と同じ `{pass, missing_tools:[{name,reason}]}` をまず要求する。
- [ ] Codex CLI backend は schema-valid final JSON を backend-neutral parser に通してから
  `SpotterJudgment` に変換する。Haiku と Codex で missing tool filtering / anomaly shape を分岐させない。
- [ ] `codex exec --json --output-schema <schema> --output-last-message <tmpfile> --ephemeral --sandbox read-only --cd <project>`
  の最小 smoke を作る。
- [ ] Codex CLI final response は `--output-last-message` の JSON を正本として読む。
  stdout JSONL parser は diagnostics / timing / raw transcript 保存の補助にし、final response 取得を
  event shape に依存させすぎない。
- [ ] invalid JSON / schema mismatch / non-zero exit / timeout を structured error にする。
- [ ] Codex CLI spawn は stdin を明示的に `ignore` する。hook stdin や daemon stdin を継承すると
  Codex CLI が追加 prompt として読む可能性がある。
- [ ] Codex CLI stderr は bounded diagnostics として capture する。
  analytics 403 HTML や plugin / skill manifest warning が出ても、それだけでは backend failure にしない。
  ただし non-zero exit / schema invalid / no final JSON は structured error にする。
- [ ] `--ignore-user-config` / `--ignore-rules` でも plugin / skill manifest scan が完全には止まらない
  可能性を前提に、cold latency と stderr volume を測る。必要なら `CODEX_HOME` / feature disable /
  minimal profile の選択肢を別 spike に切る。ただし `CODEX_HOME` 変更は auth 断絶を起こし得るので、
  認証済みの最小 profile を作れることを確認してから採用する。
- [ ] last-message file / schema file / raw JSONL capture の temp path と cleanup policy を決める。
  timeout / abort 時も tempfile を漏らさず、diagnostics に必要な場合だけ approved log dir へ保存する。
- [ ] timeout は process close だけで判定しない。もし last-message file に schema-valid final JSON が
  書かれているなら、その時点で success として扱えるかを検証する。これは `claude -p` の
  `type:result` 後も process が残る既知罠と同型の timeout 誤判定を避けるため。
- [ ] Codex CLI spawn env に recursion marker を入れる:
  `SPOTTER_PARENT_PID`, `SPOTTER_BACKEND=codex-cli`, `SPOTTER_CHILD_BACKEND=codex-cli`。
- [ ] 将来の Codex plugin / wrapper 側も `SPOTTER_BACKEND` / `SPOTTER_CHILD_BACKEND` を見て
  再入しない gate を持つ。Claude hook の `SPOTTER_PARENT_PID` だけに依存しない。
- [ ] Codex CLI backend が Spotter hooks / daemon を増殖させないことを unit / smoke で確認する。
- [ ] Codex CLI spawn option の unit test で `stdio[0] === 'ignore'`、read-only sandbox、
  recursion marker env、tempfile cleanup、stderr cap を固定する。
- [ ] Haiku backend と Codex CLI backend の latency / process count / output validity を同じ fixture で比較する。

Gate:

- [ ] `codex exec` が stable schema output を返す。
- [ ] `--output-last-message` と `--output-schema` の組み合わせで final JSON を安定取得できる。
- [ ] Codex CLI が stdin を読まず、stderr noise を bounded diagnostics に閉じ込められる。
- [ ] `codex exec` が Haiku より十分に遅い場合、Codex host primary 採用を再検討する。
- [ ] Codex CLI unavailable は Codex host で structured error。Haiku fallback しない。
- [ ] `SPOTTER_AUDITOR_BACKEND=codex-sidecar` は Phase 4 の auditor workflow 実装前なら
  `E_BACKEND_NOT_IMPLEMENTED` を返す。`codex-sidecar` second-pass workflow の存在をもって
  primary auditor 実装済みとは判定しない。

### Phase 3. Codex Native UX Tuning

- [ ] Codex host detection を定義する。
  既存 `detectHostAgent` の env marker だけで足りるか、Codex plugin / wrapper 側の
  明示 `--host-agent codex` が必要かを決める。
- [ ] Codex 側 event source を調査する:
  plugin, MCP, wrapper, app-server, exec-server のどれで Spotter を呼ぶか。
- [ ] Codex 用の input contract を定義する。
  Claude hook JSON をそのまま要求しない。Codex 側で自然に渡せる形にする。
- [ ] Codex 側 event source が未確定でも実装を進められるように、明示 CLI の
  `spotter auditor judge --stage user_input|turn_end --input FILE --host-agent codex --backend codex-cli`
  相当の smoke entrypoint を先に用意するか判断する。追加する場合は user-facing command にする前に
  internal / experimental と明記する。
- [ ] Codex event source が未確定の間は、この smoke entrypoint だけで
  「Codex native integration 完了」とは呼ばない。Phase 3 gate の実セッション smoke は、
  実際の Codex 側入口から Spotter が呼ばれたことを条件にする。
- [ ] Codex host では primary backend default を Codex CLI にする。
- [ ] Codex host では `codex-sidecar` を primary backend default にしない。
- [ ] Codex host で Codex CLI unavailable のとき、明示 error を返す。
- [ ] Codex native 環境で latency tuning を行う:
  short prompt skip、catalog compression、backend warm path、per-stage timeout、
  cache / memoization、async advisory 化できる箇所を実測する。
- [ ] Codex native で `UserPromptSubmit` 相当の体感遅延を記録する。
- [ ] Codex native での改善策を「Claude に移植可能」「Codex 固有」に分類する。

Gate:

- [ ] Codex 環境で実セッション smoke が通る。
- [ ] Codex host で recursive Codex-on-Codex が起きない。
- [ ] Codex host で Spotter が使えない場合、silent pass ではなく明示 error になる。
- [ ] Codex native で latency の改善・悪化を数値で説明できる。

### Phase 4. Backend Matrix Evaluation

- [ ] `codex-sidecar` を primary auditor 候補として測る場合は、matrix 測定の前に
  `codex-sidecar` 側の auditor preset / workflow を追加または利用可能にする。
  既存 risk / review ではなく、`user_input` / `turn_end` 判定専用 workflow が必要。
- [ ] `codex-sidecar diagnostics --preset auditor` 相当の availability check を定義する。
- [ ] 4 象限を同じ fixture で測る:
  `Claude + Codex CLI`, `Claude + codex-sidecar`,
  `Codex + Codex CLI`, `Codex + codex-sidecar`。
- [ ] primary auditor と second-pass / work の評価を分ける。
- [ ] primary auditor では latency / schema success / process count / recursion safety を測る。
- [ ] second-pass / work では durable result / worktree / diagnostics / review quality を測る。
- [ ] Claude host の primary default を `codex-sidecar` にするか `codex-cli` にするかは、
  この matrix evaluation で決める。
- [ ] Codex host の primary default は Codex CLI 優先。ただし sidecar の方が
  measurable に優れるケースがあれば用途限定で残す。

Gate:

- [ ] `codex-sidecar` の存在意義を primary auditor 以外の workflow boundary として説明できる。
- [ ] Claude host に移植する backend policy が、Codex native 実測に基づいている。

### Phase 5. Claude Host Port

- [ ] Phase 4 で選んだ Claude host 向け backend policy を Claude hook に移植する。
  初期候補は `codex-sidecar` だが、`Claude + Codex CLI` が primary auditor として優位なら
  `codex-cli` を default にする。
- [ ] Phase 4 で `codex-sidecar` を Claude primary default に選んだ場合は、
  Phase 4 で追加した auditor workflow / diagnostics preset を Claude hook policy から使う。
- [ ] 選択 backend unavailable の場合に Haiku compatibility mode へ入るかどうかを
  Phase 4 の結果に基づいて policy 固定する。
  hidden fallback は不可。互換 mode を許す場合も daemon log と diagnostics に明示する。
- [ ] compatibility mode は daemon log と diagnostics に明示する。
- [ ] Claude hook timeout budget 内に収まるか実測する。
- [ ] `Stop` hook で選択 backend が遅い場合の扱いを決める。
  hidden fallback は不可。timeout なら timeout error または明示 compatibility mode のどちらかを
  事前 policy で固定する。

Gate:

- [ ] Claude 実セッション smoke が通る。
- [ ] 選択 backend available 時に Haiku が呼ばれないことを log / test で確認。
- [ ] 選択 backend unavailable 時の error / compatibility mode が明示される。
- [ ] Claude host の体感遅延が現行 Haiku より悪化していない、または悪化が明示的に許容されている。

### Phase 6. Diagnostics And Operations

- [ ] `spotter diagnostics logs` に backend 別集計を追加する:
  `haiku`, `codex-cli`, `codex-sidecar`, `compatibility_haiku`。
- [ ] Phase 1 の `backend=<name>` log を前提に、daemon log / diagnostics parser を拡張し、
  mode, duration, timeout, availability state を backend 別に集計できるようにする。
- [ ] `spotter doctor` に Codex CLI / codex-sidecar backend readiness を追加する。
- [ ] README / README.ja に backend policy を短く追記する。
- [ ] `docs/open-issues.md` の Haiku レイテンシ観測を backend 比較観測へ更新する。

Gate:

- [ ] ユーザーが「今どの backend で判定されたか」を logs / diagnostics から説明できる。

### Phase 7. Rollout

- [ ] 初期 rollout は env opt-in にする:
  `SPOTTER_AUDITOR_BACKEND_POLICY=next` など。
- [ ] Codex host smoke を行う。
- [ ] Codex native で数日運用し、UX 遅延・false positive・failure を先に詰める。
- [ ] Spotter repo と別プロジェクトで Claude host smoke を行う。
- [ ] 数日分の diagnostics を見て、latency / false positive / failures を比較する。
- [ ] 問題なければ default policy を切り替える。

Gate:

- [ ] daemon proliferation なし。
- [ ] backend failure が hidden fallback になっていない。
- [ ] Claude host / Codex host の両方で実セッション smoke が通る。

## Non-Goals

- Codex host で Haiku に fallback すること。
- Claude host で選択 backend 不在時に silent pass すること。
- Codex CLI に write permission を与えること。primary auditor は read-only 判定専用。
- `codex_work` を primary auditor に混ぜること。

## Open Questions

- Codex host integration の自然な入口は plugin / MCP / wrapper / app-server / exec-server のどれか。
- `codex exec --output-schema` の final response 取り出しは、version drift にどこまで耐えるか。
- `codex exec --ephemeral` が本当に session file / project state を汚さないか。
- Claude host で選択 backend が hook timeout 内に安定して収まるか。
- `codex-sidecar` 側に auditor 専用 preset / workflow を追加する必要があるか。

## Audit Snapshot

2026-05-06 に計画書と関連 docs を再監査した。

- README / README.ja / Claude contract / dual-support docs / open issues から、この文書への導線を確認済み。
- `SPOTTER_CLAUDE_CONTRACT.md` に primary auditor backend と second-pass workflow の境界を追記済み。
- local `codex-cli 0.128.0-alpha.1` で `codex exec --json --output-schema --ephemeral --ignore-user-config --ignore-rules --sandbox read-only --cd` が存在することを確認済み。
- Phase 4 の matrix evaluation と矛盾しないよう、Claude host の default は `codex-sidecar` 固定ではなく
  `codex-sidecar` / Codex CLI の実測結果で決める表現に統一済み。
- Codex CLI backend の再帰 marker は `SPOTTER_SIDECAR=1` と混同せず、
  `SPOTTER_BACKEND=codex-cli` / `SPOTTER_CHILD_BACKEND=codex-cli` として扱う方針に修正済み。
- 追加の横断監査で、`codex-sidecar unavailable` は second-pass workflow の
  `status:"skipped"` / compatibility result であり、Codex host primary backend の Haiku fallback
  ではない、と dual-support docs / AGENTS / Claude contract に明記済み。
- `CLAUDE.md` の Current Commands を README / Claude contract と合わせ、
  `spotter diagnostics logs` と `spotter codex *` を現行 command surface に追記済み。
- `open-issues.md` の `Read` 過検出記述を、現行カタログ対象外の hallucination として整理済み。
- README / README.ja / CLAUDE.md の Claude Max 要件は、現行 Claude-backed auditor path の要件として
  scope を明記済み。
- 実装可能性監査で、`parseHaikuResponse` と `filterCatalogMisses` の実コード上の責務分離に合わせ、
  parser / post-parse filtering の切り出し単位を修正済み。
- 実装可能性監査で、primary backend 側が `codex-sidecar-policy.mjs` に直接依存しないよう、
  host detection の neutral module 化を Phase 1 に追加済み。
- `codex exec --output-schema --output-last-message` smoke で last-message file の schema-valid JSON を確認し、
  stdin ignore、stderr bounded diagnostics、`CODEX_HOME` auth 隔離リスクを Phase 2 に追加済み。
- `codex-sidecar` primary auditor adapter は Phase 4 の auditor workflow 実装前なら
  `E_BACKEND_NOT_IMPLEMENTED` とし、second-pass workflow の存在と混同しない方針に固定済み。
- `SPOTTER_AUDITOR_BACKEND=auto` と `SPOTTER_AUDITOR_BACKEND_POLICY=current|next` の初期挙動を
  testable な selector contract として固定済み。

現時点で文書上の blocking contradiction はない。残る unchecked item は実装・実測・smoke が必要な
作業項目であり、試験予定として残してよい。実装可能性監査としても、現時点の計画書に
blocking finding はない。
