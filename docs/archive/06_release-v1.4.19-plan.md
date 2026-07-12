# 06 v1.4.19 リリースプラン

状態: 完了
作成日: 2026-07-12
対象: `main` / npm `claude-spotter@1.4.19` / GitHub Release / global install

## 目的

親セッション安全化を含むv1.4.19を、現役ドキュメント・GitHub `main`・npm `latest`・
このMacのglobal installで同一内容へ揃える。公開後はregistry tarballからのfresh installで検証する。

## リスクと戻し方

- npm公開版は同じversionへ上書きしない。公開後の不具合は新しいpatchで修正する。
- `main`はforce pushせず、問題時はrevert commitを使う。
- tagは公開対象commitへ新規作成し、既存tagを移動しない。
- local global installを`1.4.18`へ機能downgradeする操作自体は可能だが、今回塞いだ自由文注入・
  Stop pending配送を再導入するため安全なrollbackではない。公開後の不具合は`1.4.20`以降の
  forward fixを原則とする。

## TODO

- [x] sync、dirty、stash、ahead/behind、shallow、既存tagを確認する
- [x] npm package名・latest・whoamiとGitHub認証を確認する
- [x] npm scope罠を確認し、unscoped既存packageのため非該当と判定する
- [x] 現役ドキュメント全体をv1.4.19 release candidate状態へ同期する
- [x] full test、diff check、pack内容、秘密混入を再検証する
- [x] 敵対的release監査のrollback指摘を修正し、公開blocker 0を確認する
- [x] 文書更新をpathspec明示でコミットする
- [x] `main`をpushし、remote SHA一致を確認する
- [x] CIがgreenになるまで確認する
- [x] 公開対象SHAへ`v1.4.19` tagを作成・pushする
- [x] `npm publish`し、registry version・dist-tag・tarballを確認する
- [x] GitHub Releaseを作成し、tag・release・npmを照合する
- [x] npm公開版をglobal installし、version・主要ファイル・Hook診断を確認する
- [x] open issues / CHANGELOG / repository statusへ公開結果を記録する
- [x] 最終文書コミットをpushし、計画をarchiveへ移す

## 完了記録

- 公開SHA: `53939199fa8bcd68eb01705137538f754d1a2b17`
- CI: 6/6 green（macOS / Linux / Windows、Node 22.5 / 22.x）
- npm: `claude-spotter@1.4.19`、`latest=1.4.19`
- GitHub Release: `https://github.com/kitepon-rgb/Spotter/releases/tag/v1.4.19`
- global install: registry由来の通常directory、`spotter 1.4.19`
- Hook diagnostics: 3件installed / compatible / canonical、modelは`gpt-5.6-terra × medium`

## 合格条件

1. `origin/main`とlocal `main`が一致し、CIがgreen。
2. `v1.4.19` tagが公開対象commitを指す。
3. npm `latest`が`1.4.19`で、registry tarballのCLI・projectorが期待どおり動く。
4. GitHub Release、npm、global `spotter --version`が`1.4.19`で一致する。
5. 現役ドキュメントにdevelopment/local-only/npm未公開の誤記が残らない。
6. worktreeがcleanで、未push commitとstashが残らない。
