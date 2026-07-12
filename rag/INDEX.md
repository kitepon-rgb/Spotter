# RAG Index

現状エントリ:

- `codex-hooks/` — 2026-07-12 時点の公式 Codex Hook 仕様スナップショット、修正前 drift、repo 修正と実機反映の差、Stop deliveryのCLI/App実測
- `hook-output-safety/` — Claude / Codexの親コンテキスト境界、自由文を固定助言へ投影する安全契約、2026-07-12の注入事故実測
- `openai-model-policy/` — GPT-5.6 の公式モデル区分、Codex model/effort 設定、Spotter auditor の versioned policy と評価 artifact
- `openai-model-policy/evals/2026-07-12-throughline-context-evaluation.md` — Throughline L2のN/body cap実測、prompt v2反復評価、project canary候補（N=2 / 600 chars）

運用規約: 外部仕様・研究と出力物は dotagents/PLAN.md 原則10に従い、`rag/<topic>/raw/` の一次ソース、コンパイル記事、ここへの1行台帳で還流する。
