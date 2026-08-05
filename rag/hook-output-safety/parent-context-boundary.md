---
sources:
  - https://learn.chatgpt.com/docs/hooks
  - https://code.claude.com/docs/en/hooks
  - "[[../codex-hooks/raw/codex-hooks-2026-07-12]]"
  - "[[raw/claude-hooks-2026-07-12]]"
retrieved_at: 2026-08-05（Codex公式Hooks再照合、Claude sourceは2026-07-12 snapshot）
certainty: high（公式仕様2件とローカル実装・実ログを照合）
---

# Spotter Hookの親コンテキスト境界

## 公式仕様から確定したこと

- Codex `UserPromptSubmit` のplain stdoutと
  `hookSpecificOutput.additionalContext` はextra developer contextとして親モデルへ入る。
- Claude Codeの`additionalContext`はsystem reminderとしてconversationへ挿入される。
- Claude Code公式は、変化しない命令をHookへ置くのでなく正典へ置き、Hook contextはimperativeな
  system instructionではなくfactual statementとして書くよう案内している。
- Codex / Claudeとも、`systemMessage`はユーザー向けUIまたはevent streamの警告surfaceであり、
  モデルへ作業命令を与える用途ではない。
- Hook stdoutの外側はJSONで構造化できるが、モデルへ渡る`additionalContext`自体は文字列である。
  任意JSONを文字列化して親に解釈させても、信頼境界は親モデルへ移るだけで安全化にならない。

## Spotterへ適用する結論

1. 監査用AIは内部の構造化判定だけを返す。AI由来の`reason` / `raw` / provider出力を親へ渡さない。
2. Spotterプログラムがhost-local catalogと完全一致したtool IDだけを再検証する。
3. 親向け`additionalContext`は固定テンプレートで、関連候補という事実と任意の助言だけを表す。
4. backend failureはallow-listしたreason codeから固定`systemMessage`を生成し、生messageを含めない。
5. Stop結果を次の入力へ持ち越さない。findingは構造ログ、必要な通知は固定`systemMessage`へ分離する。

## ローカル実測

- 2026-07-12 08:22:54Z: Codex Stopが`mcp__codegraph__codegraph_explore`不足をpendingへ保存。
- 2026-07-12 08:23:37Z: 次の無関係なnpm質問で`pendingContextCount:1`として配送。
- Kikoeruの旧pendingには`E_CODEX_CLI_TIMEOUT`と子Codex stdout / stderrが文字列保存されていた。
- Hook重複、`async:true`、稼働中Spotter daemon増殖は現在の設定では確認されず、主因は出力境界。

## 実装ポインタ

- 親向け固定助言と固定failure: `src/hooks/parent-output-projector.mjs`
- legacy pendingは`src/hooks/pending-context.mjs`が内容を読まず削除するだけで、新規配送はしない
- Claude adapter: `src/hooks/user-prompt.mjs`、`src/hooks/stop.mjs`
- Codex adapter: `src/cli/codex-hook-cmd.mjs`
- 完了プラン: `docs/archive/05_parent-session-safety-plan.md`
