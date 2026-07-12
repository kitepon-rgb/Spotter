---
sources:
  - https://learn.chatgpt.com/docs/hooks
  - "[[raw/codex-hooks-2026-07-12]]"
retrieved_at: 2026-07-12
certainty: high（公式仕様とローカル実測を分離して記載）
---

# Codex Hooks 現行仕様と Spotter の drift

## 公式仕様で確認したこと

- Hook は `~/.codex/hooks.json` / `~/.codex/config.toml` / repo-local
  `.codex/hooks.json` / `.codex/config.toml` から読み込まれる。
- 複数 source の matching hook は置換されず、すべて実行される。同一 event の command hook は
  並行起動される。
- non-managed command hook は定義 hash ごとの review / trust が必要で、未 review または変更済みの
  Hook は skip される。確認 UI は `/hooks`。
- `async:true` の command hook は未対応で、Codex が handler 自体を skip する。
- 現行 event には `SessionStart`、`PreToolUse`、`UserPromptSubmit`、`Stop` 等がある。
- Codex `Stop` は `decision:"block"` で turn を棄却するのではなく、`reason` を新しい continuation
  prompt として Codex を続行させる。
- `PreToolUse` は Bash、`apply_patch`、MCP の一部を intercept できるが、全 tool path を覆う
  enforcement boundary ではない。
- `transcript_path` は convenience であり、transcript format は stable hook interface ではない。

## 初回監査で確認した Spotter との相違点

- Spotter の正規 Codex adapter は user-global `~/.codex/hooks.json` に `codex-hook` 3 event を登録する。
  これは現行仕様でも有効だが、diagnostics は JSON 登録と feature flag だけを見て trust を確認しない。
- 修正前の Spotter generator は `SessionStart` に `async:true` を出力した。実機 UI も同 handler を
  `async hooks are not supported yet` として skip し、Codex hook-event に SessionStart は 0 件。
  自動 tool-db refresh は動かない一方、diagnostics は `available` と返す。
- repo-local の未コミット `.codex/hooks.json` は Claude 用 `spotter hook ...` を登録している。
  現在は trust state がなく未発火だが、trust すると正規 global adapter と並行実行される。
- 修正前の Codex used-tools parser は `function_call` だけを数えたが、現行 shell execution は実 transcript で
  `custom_tool_call exec` として記録され、short-skip 判定から漏れ得る。
- Spotter の 2026-05 文書は Codex Stop continuation が使えないことを pending queue 採用理由としている。
  pending delivery 自体は依然有効な設計選択だが、「Hook の制約で必須」という前提は再検証対象。

## 計画へ渡す論点

1. `registered` / `schema-valid` / `observed` を分離した diagnostics と install 後の `/hooks` 案内。
   trust は安定した機械 API がないため内部 state から断定しない。
2. repo-local Hook と user-global Hook の ownership を一本化し、二重稼働を防ぐ。
3. Codex Stop immediate continuation と pending delivery を実機 characterization で比較する。
4. Codex `PreToolUse` を telemetry に採用するか、transcript-only を契約として維持するか決める。

## 2026-07-12 修正と実機反映の境界

- `85e280a` で installer-owned `SessionStart` から `async:true` を除去し、再 install 時に旧 field を
  canonical `{type, command, timeout}` へ正規化した。他製品の Hook は保持する。
- `f22b46c` で diagnostics を feature / registered / compatible / canonical / observed / readiness に分けた。
  trust は安定 API がないため成功と断定せず、`/hooks` review を案内する。
- `1a2b407` で bounded current-turn transcript reader を導入し、現行 shell / MCP / agent call を認識する。
  欠落・巨大 turn・未知 schema は「tool 0件」とみなさず anomaly にする。`PreToolUse` の二重観測は増やさない。
- repo の生成器は直ったが、実機 global package はまだ `spotter 1.4.15`。`~/.codex/hooks.json` の
  Spotter `SessionStart` は依然 `async:true` で、`codex exec` でも同じ skip warning を再現した。
  release / global update / 各 project の `spotter install` / `/hooks` review までは実環境の警告は消えない。
- 未追跡 repo-local `.codex/hooks.json` は Claude adapter を Codex source に置いた別経路であり、
  user-global 正規 adapter と並行発火し得る。commit / trust せず、削除または正式化は owner 承認待ち。
