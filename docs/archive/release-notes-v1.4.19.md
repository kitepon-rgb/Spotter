# claude-spotter v1.4.19

Spotterが呼び出した監査用AIの自由文を親セッションへ流さない、明示的な出力信頼境界を導入しました。

- `UserPromptSubmit`はcatalog照合・grammar検証済みtool IDだけを、固定・非命令形の助言へ変換します。
- `Stop` findingは構造Hook eventに留め、無関係な次turnへ持ち越しません。
- backend/providerのmessage・stdout・stderrは親モデルcontextへ反射しません。
- failureはallow-list済み固定診断へ写像し、入力消去や回答継続を起こさないnon-blocking契約を維持します。
- Claude/Codex共通projectorと回帰テストで同じ境界を保証します。

既にSpotterを導入済みのprojectでは`spotter install`の再実行は不要です。`npm install -g claude-spotter@1.4.19`後に新しいセッションを開いてください。
