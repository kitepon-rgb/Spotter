# ADR 0001 — 提案採用観測をLattice工程で実装する

- Status: Accepted
- Date: 2026-08-04

## Decision

Spotterが実際に提示したtool itemについて、同じ親turnで呼び出された確率を端末内SQLiteへ記録する。
提案しなかったturnは採用率の母数から除外し、結果不明itemは`outcome_missing`として率からも除外する。
提案率は成功UserPromptSubmitに対する提案turnの割合として別に表示する。

提案時情報は、auditorへ実際に渡したrequestと、同時点の既存Throughline
`observer-read` snapshotを分離して保存する。Throughline側は変更しない。実行ToDo、依存、状態、
完了証拠の正本はLattice plan `proposal-adoption-eval`とする。

2026-08-05 amendment: v1.5.4以降、auditorへ渡す本文は現在のrequestだけで履歴文脈は渡さない。
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
