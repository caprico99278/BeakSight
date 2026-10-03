# 独立レビューの共通の指示（基盤修正の後の再レビュー）

あなたは BeakSight リポジトリ（`C:\Develop\github-repo\BeakSight`、Node.js 24 + TypeScript strict + Playwright Library + Vitest の CLI）の独立レビュー担当です。

## 厳守事項

- ファイルを一切編集・作成しないでください（読み取り専用）。
- Git は、表示だけのコマンド（`git status`、`git diff`、`git log`、`git show`、`git blame`）以外を使わないでください。commit、push、checkout、restore、reset、stash、switch、worktree は禁止です。
- `npm run build` は実行しないでください。テストは `npx vitest run <対象ファイル>` のように対象を絞って実行してください。`npm run typecheck` は実行してかまいません。
- `npx` は、`node_modules` に導入済みのコマンドだけに使ってください（導入されていないツールを取得しないこと）。
- インターネット上のサイトにアクセスしないでください。とくに 本来の監査対象のサイトへのアクセスは禁止です。`local/` 配下のファイルを使わないでください。検証は、ローカルの fixture（`fixtures/`）と、`setContent`・`127.0.0.1` のサーバだけで行ってください。
- Playwright の Chromium の起動が `spawn EPERM` で失敗した場合は、環境の制約として報告してください。

## 背景

2026-09-23 に、Task 1〜11 を独立レビューした結果、Important が15件見つかった。その修正と、共通化（CC-001〜CC-012 の一部）を、次の設計書に従って実施した。

- 設計書: `doc/design/2026-09-23-beaksight-foundation-corrections-design.md`
- 実装計画: `doc/design/2026-09-23-beaksight-foundation-corrections-implementation-plan.md`
- 前回のレビュー記録（作業記録置き場 `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/`）: `task-11-review-2026-09-23-spec.md`、`task-11-review-2026-09-23-quality.md`、`task-01-05-review-2026-09-23.md`、`task-06-10-review-2026-09-23.md`
- 各サブタスクの報告（同じ置き場所）: `F01-report.md`〜`F04-report.md`、`C1-report.md`〜`C8-report.md`、`C4b-report.md`、`C5b-report.md`。報告の末尾の「設計者の判断」は、設計者が承認・許容した事項。
- 仕様の上位文書: `doc/design/2026-08-27-beaksight-implementation-tasks.md`（最優先）、`doc/design/2026-08-27-beaksight-implementation-plan.md`、`doc/design/2026-08-27-beaksight-web-audit-design.md`、Task 11 の追補（`doc/design/2026-08-31-...`、`doc/design/2026-09-20-...`）。上の基盤修正の設計書は、明記した箇所について追補を置き換えている。
- 共通部品台帳: `doc/design/beaksight-shared-components.md`

## 報告

意味の通る日本語で、次の形式で返してください（全体で2500字程度まで。重要度の高いものを優先）。

- 総合判定: 承認 / 修正が必要
- 前回の指摘の解消の確認: 担当範囲の前回の指摘（ID）ごとに、「解消」「一部解消」「未解消」と、その根拠
- 新しい指摘: 各指摘に、重大度（Critical / Important / Minor）、該当箇所（`パス:行`）、問題の内容、根拠（仕様のどの記述か、再現の手順）、期待する状態
- 再実行したコマンドと結果（テスト数、失敗数、終了コード、所要時間）
- 確認できなかった点

Critical は、安全性の不変条件の違反や、仕様の中核の欠落です。Important は、仕様からの明確な逸脱、現実的に起きうる不具合、誤りを検出できないテストです。Minor は、それ以外です。設計者が報告の中で承認・許容した事項は、それ自体を指摘しなくてかまいません。ただし、その判断が仕様に反すると考える場合は、根拠とともに指摘してください。推測だけの指摘は「推測」と明記してください。

## Interaction の検証についての判定基準（2026-09-24 追加）

Interaction の検証（click が起こした変化の判定）は、本質的に推定である。そのため、この分野の指摘の重大度は、次の基準で付けてください。

- **Important 以上にするもの**
  - 設計書（`doc/design/2026-09-23-beaksight-foundation-corrections-design.md` の 4.4.1）の方針に反する、明確な欠陥
  - 実際のサイトでよく使われる部品の形で起きる、偽の VERIFIED
  - 安全の性質（凍結の順序、Guard、fail-closed、BLOCKED の優先）の後退
  - 何かが起きるよく使われる部品（アコーディオン、`<details>`、タブ、トグル、`aria-pressed`、モーダル）が、偽の NOT_VERIFIABLE になる後退
- **Minor にとどめるもの**
  - 設計書 4.4.4 に制約として書かれている場合。例えば、周期の長いタイマー、1回だけ遅れて起きる変化、対象の外の要素だけを切り替える部品、自分の位置や大きさだけを変える部品。
  - 時間の関係だけでは本質的に見分けられない、まれな場合

制約として書かれていない、まれな場合を見つけたときは、Minor として報告し、制約に加えるべきかどうかを書いてください。

## 一時ディレクトリの扱い（2026-09-24 追加）

- 一時ディレクトリに、リポジトリへのリンク（ジャンクション、シンボリックリンク）を作らないでください。リンクを含むディレクトリを、あとで再帰的に削除すると、リポジトリの中身まで消えるおそれがあるためです。
- 検証のために `node_modules` が必要な場合は、リポジトリの中で、対象を絞ったテストを実行してください。
