# Spotter: Claude / Codex 両対応計画

この文書は Spotter repository に貼り付けるための実装ブリーフです。目的は、Spotter を Claude Code と Codex の両方から安全に使える形へ育てることです。

この文書の範囲は、Claude-first を維持したまま Codex adapter / sidecar workflow を追加することです。
`UserPromptSubmit` / `Stop` の primary auditor backend を host agent ごとに切り替える次段階の計画は
[`SPOTTER_PRIMARY_BACKEND_TODO.md`](SPOTTER_PRIMARY_BACKEND_TODO.md) を参照してください。
実装済み phase と完了条件は [`SPOTTER_CODEX_DUAL_SUPPORT_TODO.md`](SPOTTER_CODEX_DUAL_SUPPORT_TODO.md)、
維持すべき Claude 側 contract は [`SPOTTER_CLAUDE_CONTRACT.md`](SPOTTER_CLAUDE_CONTRACT.md) にあります。

## 目標

Spotter は agent-neutral な detection / reporting infrastructure になるべきです。

Claude-oriented workflow での既存動作は維持しつつ、Spotter findings を Codex が structured context として consume し、`codex-sidecar` 経由で machine-readable な risk / review result を返せるようにします。

目指す形:

- Spotter core は特定 agent に依存しない。
- Claude integration は first-class のまま維持する。
- Codex integration は adapter と execution option として追加する。
- 既存の Claude command、report format、hook、prompt を壊さない。

## 優先順位

1. この project 内に background Claude subagent が存在するなら、その作業を棚卸しし、適切な範囲で Codex sidecar に移す。
2. 現コードで主に存在するのは Claude Code Task subagent ではなく Haiku auditor なので、まず Spotter 本体の finding / projection / sidecar context を整える。

最初の task は、自然に独立している background agent role が実際に存在するかを特定することです。現行 Spotter では Haiku auditor を置換対象にせず、audit 結果の risk-check、second-pass review、scoped verification などを Codex sidecar に渡す設計から始めます。

runtime environment で Codex が使えない場合は、現在の Claude-backed Haiku auditor behavior をそのまま維持します。Codex adapter が存在するからといって、既存の Claude path を削ったり劣化させたりしないでください。

## Architecture 方針

概念上、次の layer に分けます。

| Layer | Responsibility |
|---|---|
| Agent-neutral core | scan input、detector、finding、severity、reference、report |
| Claude adapter | Claude-facing command、hook、prompt、report rendering |
| Codex adapter | `codex_risk_check`、`codex_review`、`codex_explore` 向け context block、structured result handling |
| Shared fixtures | Claude / Codex adapter の両方で使う scan fixture と expected report |

Spotter を Claude 実装と Codex 実装に分岐させないでください。detector / reporting core は 1 つに保ち、複数の agent adapter を持つ形にします。

## Codex Sidecar Integration

Spotter は findings を plain JSON context block として Codex に渡せます。専用 kind がまだない場合は、dedicated Spotter context kind を導入するまで `manual_note` または `codegraph_context` を使ってください。

Phase 3 の実装範囲は projection のみです。Spotter は `SpotterFinding[]` から
`kind:"manual_note"`, `source:"spotter"`, `trust:"local"` の context block を作れるようにしますが、
この段階では Codex / `codex-sidecar` を起動しません。`codex-sidecar-core` も runtime dependency
には追加せず、local JSON fixture と unit test で互換 shape を固定します。

tool-miss finding では架空の `ruleId` や path / line を作りません。`ruleId` は detector-backed
finding で実在する場合だけ載せ、未知の `severity` / `confidence` は `unknown` に統一します。
Codex execution と availability check は Phase 4 以降で扱います。

Example:

```json
{
  "kind": "manual_note",
  "source": "spotter",
  "trust": "local",
  "summary": "Spotter found a high-risk OAuth callback surface and missing regression coverage.",
  "references": [
    {
      "path": "src/oauth/callback.ts",
      "line": 42,
      "label": "callback handler"
    }
  ],
  "data": {
    "detector": "oauth-callback-risk",
    "severity": "high",
    "ruleId": "SPOTTER-OAUTH-001"
  }
}
```

Codex-facing workflow では、Spotter findings を次の用途に使います。

- `codex_risk_check`: Spotter signal を deeper risk analysis に変換する。
- `codex_review`: Spotter findings を context に入れて diff を review する。
- `codex_explore`: detector が trigger した理由を調査する。
- `codex_opinion`: remediation plan を challenge する。
- `codex_work`: 明示的に許可された場合だけ、isolated worktree で小さな scoped fix を行う。

Phase 5 の read-only workflows は明示 CLI から実行できます。

```bash
spotter codex risk-check --findings findings.json --host-agent claude
spotter codex review --findings findings.json --host-agent claude
spotter codex explore --findings findings.json --host-agent claude
spotter codex opinion --findings findings.json --host-agent claude
```

`findings.json` は `SpotterFinding[]`, `{ "findings": [...] }`, または
`{ "judgment": { "findings": [...] } }` を受け付けます。Spotter はこれを
`SidecarContextBlock` 互換 JSON に変換し、一時 context-file 経由で
`codex-sidecar <workflow> --preset <preset>` を呼びます。結果は
`spotter.sidecar_result.v1` として stdout に出し、既定では
`<project>/.spotter/sidecar-results/` に保存します。

`codex-sidecar` が unavailable の場合は hidden fallback せず、`status:"skipped"` の
structured result を返します。既存 Claude-backed Haiku auditor path は変更しません。

daemon からの自動 dispatch は opt-in です。`SPOTTER_CODEX_RISK_CHECK=1` を設定した
daemon だけが `pass:false` finding を detached process の `spotter codex risk-check` に渡します。
hook hot path は Codex を待ちません。配線確認だけなら `SPOTTER_CODEX_RISK_CHECK_DRY_RUN=1`
を併用します。

Phase 6 の write-capable workflow は明示承認された場合だけ実行できます。

```bash
spotter codex work --findings findings.json \
  --instruction "Implement the approved scoped Spotter change" \
  --approve-work \
  --allowed-path docs/ \
  --preserve-worktree
```

`codex_work` は `work` preset の diagnostics が `workflow:"work"`, `readonly:false`,
`requireWorktree:true`, 非空 `allowedPaths` を返す場合だけ `work-capable` とみなします。
Spotter は実行時に一時 `.codex-sidecar.yml` を作り、承認された `--allowed-path` だけに
write scope を狭めます。cleanup policy は `--preserve-worktree` または
`--remove-worktree` のどちらかを明示必須にし、sidecar 結果の `changedFiles` も Spotter 側で
再検査します。

`codex_work` は approved scope が clean な場合だけ実行します。main worktree に未コミット変更や
未追跡ファイルがある path をそのまま isolated worktree に渡すと、`git worktree add HEAD`
で作られた sidecar 側が現在の作業状態を見失うためです。この場合 Spotter は
`codex_work_dirty_approved_scope` の structured error を返し、sidecar を起動しません。

## Precision Diagnostics

Phase 7 では、まず既存 daemon log を読むだけの診断を追加します。`spotter diagnostics logs`
は `~/.spotter/logs/daemon-*.log` から次の signal を structured summary に集計します。

- `user_input` / `turn_end` の `pass:false` 件数、missing tool 内訳、mode 別 duration
- catalog-external drop と `hallucination_filtered`
- role collapse reset
- `E_HAIKU_TIMEOUT` / `E_INTERNAL` などの Haiku invocation / handler error
- fatal exit と heartbeat timeout
- opt-in Codex risk dispatch の dispatched / skipped / failed 件数

この診断は Spotter 判定や hook hot path を変更しません。過検出率、timeout 再発率、
Codex dispatch の実用性を観測するための read-only surface として扱います。

## Claude Behavior を守る

コード変更の前に、現在の Claude contract を特定して文書化してください。

- command name と argument
- report format
- detector output schema
- hook behavior
- prompt template
- markdown / JSON field name
- Claude behavior を表す test / fixture

Codex のために Claude report shape を変更しないでください。Codex projection を追加します。

## Background Subagent Shift

Spotter が現在 background Claude subagent に finding inspection、detector validation、risk classification、remediation proposal などを任せている場合、task が独立しているなら Codex sidecar を優先します。現コードでこのような Claude Code Task subagent は見当たらないため、最初の移行対象は Haiku auditor の置換ではなく、Haiku が返した finding の second-pass risk / review / opinion です。

Codex sidecar に向いている task:

- Spotter findings の second-pass risk analysis
- detector changes の review
- finding が参照する files の exploration
- fixture / test の小さな worktree-backed fix
- remediation plan への independent critique

Claude-specific command flow や active conversation state に依存する task は Claude primary のまま維持します。

## 懸念: Codex が Codex を呼ぶ場合

ユーザーが Claude から Spotter を使っている場合、この形には価値があります。

```text
Claude primary -> Spotter -> codex-sidecar -> Codex second opinion
```

一方、ユーザーが Codex から Spotter を使っている場合、次の形を無条件で行わないでください。

```text
Codex primary -> Spotter -> codex-sidecar -> Codex again
```

Codex-on-Codex は具体的な境界がある場合だけ使います。

- isolated worktree execution
- Spotter が必要とする structured `SidecarResult`
- diagnostics に必要な raw App Server log
- risk analyst / critic など明確に異なる prompt role
- independent second pass を明示的に要求された場合

これらがない場合、Spotter は findings を現在の Codex session に直接渡すべきです。

Recommended policy:

| Host agent | Sidecar choice |
|---|---|
| Claude | independent review、risk、exploration、scoped fix には Codex sidecar を優先 |
| Codex | isolation、durable structured result、explicit second-pass analysis がある場合のみ Codex sidecar を使う |
| Unknown / automation | explicit config を要求し、recursive delegation を推測しない |

Availability policy:

| Codex availability | Behavior |
|---|---|
| `unavailable` | `codex-sidecar` が存在しない、実行不能、この repo 向けに未設定、または diagnostics 失敗。既存の Claude-backed Haiku auditor path を維持 |
| `configured` | `codex-sidecar diagnostics --project <repo>` が成功。request shaping、dry-run、docs、planned read-only integration は使ってよい |
| `operational` | `codex_explore` など read-only smoke が成功。approved review、explore、opinion、risk-check sidecar task に使ってよい |
| `work-capable` | `codex_work` smoke が成功し、allowed paths が設定済み。worktree-backed scoped edit に使ってよい |
| explicitly disabled | 既存の Claude-backed Haiku auditor path を維持 |

これは hidden fallback ではありません。互換モードです。Codex が使えない環境では、現在の Claude-backed Haiku auditor behavior を baseline とします。

Phase 4 ではこの判断を pure policy として固定します。`claude` host では availability が十分なら
independent read-only workflow に sidecar を使えます。`codex` host では isolated worktree、
durable structured result、明示 second-pass などの境界がある場合だけ sidecar を使い、境界がなければ
current Codex session に finding を直接渡します。`automation` / `unknown` は explicit config なしに
recursive delegation を推測しません。

sidecar 子プロセスには `SPOTTER_PARENT_PID` と `SPOTTER_SIDECAR=1` を渡します。これにより、
sidecar 配下で Claude hook が発火しても `SessionStart` は daemon を spawn せず即 return します。
これは marker gate だけに頼らない再帰遮断です。

「Codex が使える」の最小実用定義は、単に `codex` binary があることではありません。`codex-sidecar` が存在し、対象 repository で diagnostics を成功させられることです。`codex-sidecar` がない場合、Spotter は Codex unavailable と扱ってください。

Preferred health check:

```bash
codex-sidecar diagnostics --project <repo> --preset review
```

Development-path health check:

```bash
node /home/kite/projects/codex-sidecar/packages/cli/dist/index.js diagnostics \
  --project <repo> \
  --preset review
```

## Implementation Checklist

- 既存の Claude command、report、hook、fixture を audit する。
- 現在の Claude behavior を固定する test を追加する。
- stable Spotter finding schema を特定する。
- Spotter-to-`SidecarContextBlock` conversion path を追加する。
- Codex context block と `SidecarResult` consumption の fixture snapshot を追加する。
- Claude primary、Codex primary、automation mode の docs を追加する。
- 不要な Codex-on-Codex recursion を防ぐ execution policy を追加する。
- background Claude subagent task が実在する場合は、移す前に Codex availability check を入れる。sidecar absent または diagnostics failure なら Claude-backed Haiku auditor compatibility mode。
- `codex-sidecar` read-only smoke を追加する。理想は `codex_risk_check`。

## Done Definition

Spotter が dual-supported になったと言える条件:

- 既存の Claude workflow が通る。
- Spotter findings を Codex が structured context として consume できる。
- Codex risk / review result を prose scraping なしで保存できる。
- Codex primary mode が意味のない recursive Codex delegation を避ける。
- Codex-unavailable environment では既存の Claude-backed Haiku auditor behavior を維持する。
- いつ Codex sidecar が有用で、いつ current-agent direct handling がよいか docs に説明されている。
