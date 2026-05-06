# Spotter Primary Backend Migration TODO

この文書は、Spotter の auditor backend を host agent ごとに切り替えるための
作業計画書兼 TODO。`CLAUDE.md` を正本とし、既存の Claude hook contract と
daemon proliferation safety を壊さない。

## Goal

最終形は次の通り。

| Host | Primary auditor backend | Compatibility / fallback |
|---|---|---|
| Codex | Codex CLI (`codex exec`) | なし。失敗は structured error |
| Claude | `codex-sidecar` | `codex-sidecar` unavailable の場合だけ現行 Claude Haiku |
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
  `--ignore-user-config`, `--ignore-rules`, `--sandbox read-only`, `--cd <DIR>` がある。
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

## Concerns

### 1. Codex CLI は alpha

`codex-cli 0.128.0-alpha.1` なので、CLI option と JSONL event shape は drift し得る。
`--output-schema` があるのは強いが、Spotter 側では parser / diagnostics を
version-aware にし、unknown event shape を hidden fallback しない。

### 2. Codex-on-Codex の再帰

Codex host で Spotter が Codex CLI を呼ぶと、構図は `Codex primary -> Spotter -> Codex CLI`。
これはユーザーの希望する方向だが、無制限にやると Claude 時代の daemon 増殖事故と同じ種類の
事故になり得る。Codex backend spawn には必ず `SPOTTER_PARENT_PID`,
`SPOTTER_SIDECAR` 相当の marker、`SPOTTER_BACKEND=codex-cli` を付け、Spotter hook /
Codex plugin / future Codex integration が再入しない gate を置く。

### 3. Codex host integration の入口が未確定

Claude Code には hooks があるが、Codex 側で同等の `SessionStart` /
`UserPromptSubmit` / `PreToolUse` / `Stop` event があるとは限らない。
Codex 対応はまず以下のどちらかを明確にする。

- Codex plugin / MCP / wrapper として Spotter を明示実行する。
- Codex CLI の app-server / exec-server / future hook surface に接続する。

Codex 側 event model が未確定のまま、Claude hook 前提の daemon を流用しない。

### 4. Claude host の latency

Claude host で primary backend を `codex-sidecar` にすると、UserPromptSubmit / Stop が
Codex を待つ。現行 Haiku でも first 10-30s があり、Codex sidecar がそれを上回るなら
体感悪化する。Claude host では `codex-sidecar` primary を sync hook に入れる前に、
timeout budget と observed latency を必ず測る。

### 5. Fallback の扱い

ユーザー方針として hidden fallback は禁止。Claude host で `codex-sidecar` が無い場合に
Haiku を使うのは「現状維持 compatibility mode」として明示する。Codex host では
Codex CLI が無い場合に Haiku へ落とさない。Codex 対応を謳うなら、Codex backend の不在は
structured error にする。

## TODO

### Phase 0. Terminology And Contract

- [ ] `docs/SPOTTER_CLAUDE_CONTRACT.md` に "primary auditor backend" と
  "second-pass sidecar workflow" の違いを追記する。
- [x] `docs/SPOTTER_CODEX_DUAL_SUPPORT.md` に、現状は second-pass 完了であり
  primary backend migration はこの文書の対象である、と明記する。
- [x] `AGENTS.md` にこの TODO への導線を追加する。
- [x] backend selection policy を文書化する:
  `host=codex -> codex-cli`, `host=claude -> codex-sidecar -> haiku`,
  `host=unknown -> explicit config required`。

Gate:

- [ ] docs 上で「TODO 完了 = codex-sidecar が主 backend」だと読める矛盾がない。

### Phase 1. Backend Interface

- [ ] `src/core/auditor-backend.mjs` を追加し、backend-neutral interface を定義する。
  入力は `stage`, `catalog`, `userInput`, `usedTools`, `finalResponse`, `meta`。
  出力は `SpotterJudgment`。
- [ ] 現行 Haiku 呼び出しを `haiku` backend adapter として包む。
- [ ] daemon は backend adapter 経由で判定し、既存 Haiku behavior は完全一致させる。
- [ ] backend selection は pure function にする。
- [ ] `SPOTTER_AUDITOR_BACKEND` で明示 override できるようにする。

Gate:

- [ ] 既存 `npm test` が通る。
- [ ] Claude hook 実セッション smoke が現行と同じ挙動。
- [ ] Haiku backend adapter は既存 prompt snapshot と response schema を変えない。

### Phase 2. Codex CLI Backend Spike

- [ ] `codex exec --output-schema` 用の JSON schema を追加する。
  schema は現行 Haiku response と同じ `{pass, missing_tools:[{name,reason}]}` をまず要求する。
- [ ] `codex exec --json --output-schema <schema> --ephemeral --sandbox read-only --cd <project>`
  の最小 smoke を作る。
- [ ] Codex CLI stdout JSONL parser を実装する。final response 以外の event shape に依存しすぎない。
- [ ] invalid JSON / schema mismatch / non-zero exit / timeout を structured error にする。
- [ ] Codex CLI spawn env に recursion marker を入れる:
  `SPOTTER_PARENT_PID`, `SPOTTER_BACKEND=codex-cli`, `SPOTTER_SIDECAR=1`。
- [ ] Codex CLI backend が Spotter hooks / daemon を増殖させないことを unit / smoke で確認する。
- [ ] Haiku backend と Codex CLI backend の latency / process count / output validity を同じ fixture で比較する。

Gate:

- [ ] `codex exec` が stable schema output を返す。
- [ ] `codex exec` が Haiku より十分に遅い場合、Codex host primary 採用を再検討する。
- [ ] Codex CLI unavailable は Codex host で structured error。Haiku fallback しない。

### Phase 3. Codex Host Support

- [ ] Codex host detection を定義する。
  既存 `detectHostAgent` の env marker だけで足りるか、Codex plugin / wrapper 側の
  明示 `--host-agent codex` が必要かを決める。
- [ ] Codex 側 event source を調査する:
  plugin, MCP, wrapper, app-server, exec-server のどれで Spotter を呼ぶか。
- [ ] Codex 用の input contract を定義する。
  Claude hook JSON をそのまま要求しない。Codex 側で自然に渡せる形にする。
- [ ] Codex host では primary backend を Codex CLI にする。
- [ ] Codex host では `codex-sidecar` を primary backend にしない。
- [ ] Codex host で Codex CLI unavailable のとき、明示 error を返す。

Gate:

- [ ] Codex 環境で実セッション smoke が通る。
- [ ] Codex host で recursive Codex-on-Codex が起きない。
- [ ] Codex host で Spotter が使えない場合、silent pass ではなく明示 error になる。

### Phase 4. Claude Host Primary `codex-sidecar`

- [ ] Claude host の backend selection を `codex-sidecar` 優先にする。
- [ ] `codex-sidecar` primary auditor workflow を追加する。
  既存 risk / review ではなく、`user_input` / `turn_end` 判定専用 workflow が必要。
- [ ] `codex-sidecar diagnostics --preset auditor` 相当の availability check を定義する。
- [ ] `codex-sidecar` unavailable の場合のみ Haiku compatibility mode に入る。
- [ ] compatibility mode は daemon log と diagnostics に明示する。
- [ ] Claude hook timeout budget 内に収まるか実測する。
- [ ] `Stop` hook で `codex-sidecar` が遅い場合の扱いを決める。
  hidden fallback は不可。timeout なら timeout error または明示 compatibility mode のどちらかを
  事前 policy で固定する。

Gate:

- [ ] Claude 実セッション smoke が通る。
- [ ] `codex-sidecar` available 時に Haiku が呼ばれないことを log / test で確認。
- [ ] `codex-sidecar` unavailable 時に Haiku compatibility mode が明示される。

### Phase 5. Diagnostics And Operations

- [ ] `spotter diagnostics logs` に backend 別集計を追加する:
  `haiku`, `codex-cli`, `codex-sidecar`, `compatibility_haiku`。
- [ ] daemon log に backend, mode, duration, timeout, availability state を出す。
- [ ] `spotter doctor` に Codex CLI / codex-sidecar backend readiness を追加する。
- [ ] README / README.ja に backend policy を短く追記する。
- [ ] `docs/open-issues.md` の Haiku レイテンシ観測を backend 比較観測へ更新する。

Gate:

- [ ] ユーザーが「今どの backend で判定されたか」を logs / diagnostics から説明できる。

### Phase 6. Rollout

- [ ] 初期 rollout は env opt-in にする:
  `SPOTTER_AUDITOR_BACKEND_POLICY=next` など。
- [ ] Spotter repo と別プロジェクトで Claude host smoke を行う。
- [ ] Codex host smoke を行う。
- [ ] 数日分の diagnostics を見て、latency / false positive / failures を比較する。
- [ ] 問題なければ default policy を切り替える。

Gate:

- [ ] daemon proliferation なし。
- [ ] backend failure が hidden fallback になっていない。
- [ ] Claude host / Codex host の両方で実セッション smoke が通る。

## Non-Goals

- Codex host で Haiku に fallback すること。
- Claude host で `codex-sidecar` 不在時に silent pass すること。
- Codex CLI に write permission を与えること。primary auditor は read-only 判定専用。
- `codex_work` を primary auditor に混ぜること。

## Open Questions

- Codex host integration の自然な入口は plugin / MCP / wrapper / app-server / exec-server のどれか。
- `codex exec --output-schema` の final response 取り出しは、version drift にどこまで耐えるか。
- `codex exec --ephemeral` が本当に session file / project state を汚さないか。
- Claude host で `codex-sidecar` primary が hook timeout 内に安定して収まるか。
- `codex-sidecar` 側に auditor 専用 preset / workflow を追加する必要があるか。
