# ADR 0001 — 提案採用観測をLattice工程で実装する

> **v1.5.5補正**: 本ADRの`observer-read`採用は撤回した。評価文脈は既存Throughline
> `auditor-context`へ提案元のexact sessionとtranscriptを渡して取得する。SQLite schemaと
> 監査入力からの分離は維持する。

- Status: Accepted
- Date: 2026-08-04

## Decision

Spotterが実際に提示したtool itemについて、同じ親turnで呼び出された確率を端末内SQLiteへ記録する。
提案しなかったturnは採用率の母数から除外し、結果不明itemは`outcome_missing`として率からも除外する。
提案率は成功UserPromptSubmitに対する提案turnの割合として別に表示する。

提案時情報は、auditorへ実際に渡したrequestと、提案元のexact session / host / transcriptを指定して
既存Throughline `auditor-context`から取得したsnapshotを分離して保存する。Throughline側は変更しない。実行ToDo、依存、状態、
完了証拠の正本はLattice plan `proposal-adoption-eval`とする。

2026-08-05 amendment: v1.5.4以降、auditorへ渡す本文は現在のrequestだけで履歴文脈は渡さない。

2026-08-18 amendment (v1.5.12): Stop未観測のまま次UserPromptSubmitが来たopen turnは
`outcome_missing`で廃棄せず、収集済み`used_tool_ids`で`adopted` / `not_adopted`へ採点して閉じる。
`usage_status=incomplete`のturnだけ`outcome_missing`を維持する。A/C率の表示名は
「提案適合率（上限）」とし、Spotter起因の成果指標としては表示しない。
互換列`auditor_seen_context`は`null`とし、Throughline snapshotは評価・改善用の別証拠に限定する。
Throughlineの状態は監査可否・監査結果・親向け助言へ影響させない。

この実装は既存hookの提案内容、親向け文面、model、prompt、runtime context量を変えない。
新しいturn ID、background collector、retry/reconciliation、network送信、常時validatorは追加しない。

## Orchestration lane

受入が保存層、Claude/Codex lifecycle、CLI集計、live確認へ多段連鎖するため統括レーンとする。
Fは保存schema、同一turnの帰属、率の母数、既存hook契約、release裁定。Aは境界が固定された各実装と
focused test。Hは公開・install・実projectでのlive確認だけとし、実行前にowner承認の範囲を再確認する。

並行実装はLatticeが検証した非交差frontierだけを使う。契約クリティカルな統合差分はPhase完了時に
一度だけ独立反証し、同じ検証を常時または反復して回さない。

## Acceptance

受入条件と固定集計fixtureは
[`docs/09_proposal-adoption-evaluation-plan.md`](../09_proposal-adoption-evaluation-plan.md)を正とする。
