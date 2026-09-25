# C16c 指示書: JSON の書式と、artifact のパスの検証を1か所にする（CC-026、CC-027）

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。末尾の「一時ディレクトリの扱い」も守ってください。

## サブタスク

- ID: C16c
- 目的: Task 16 のレビューの前に、U16d の報告で見つかった2つの重複を直す。
- 共通化候補: 作業記録置き場の `commonization-candidates.md` の CC-026、CC-027
- 設計書: `doc/design/2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md` の 6.1.1、6.1.8、6.1.9
- 前の報告: 作業記録置き場の `U16d-report.md`、`C16a-report.md`
- 共通部品台帳: `doc/design/beaksight-shared-components.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

**このサブタスクは、U16c（HTML レポート）と並行で実行します。** U16c の実装者は、次のファイルを変更します。

- `src/report/html-report.ts`、`html-components.ts`、`html-tokens.ts`
- `src/presentation/messages.ts`
- `tests/helpers/audit-run-fixture.ts`
- それらの単体テスト

守ってほしいことは、次の3つです。

- 下の「変更してよいファイル」の外は、変更しないでください。
- `npm run verify` と `npm run build` は、実行しないでください。全体の verify は、設計者が行います。
- 担当のテストと `npm run typecheck` は、実行してかまいません。
  - 型のエラーが U16c の作業中のファイルから出ている場合は、自分のファイルのエラーでないことを確かめてください。そのうえで、報告に書いてください。

## 変更してよいファイル

- 新規:
  - `src/report/artifact-json.ts`
  - `tests/unit/artifact-json.test.ts`
- 次の2つ（CC-026 と CC-027 の置き換えに限る）:
  - `src/report/artifact-writer.ts`
  - `src/report/chatgpt-bundle.ts`
- `src/core/artifact-layout.ts`（検証の関数を加えることに限る）
- `src/evidence/screenshot-collector.ts`（CC-027 の置き換えに限る）
- テスト（対応するものに限る）:
  - `tests/unit/artifact-layout.test.ts`
  - `tests/unit/artifact-writer.test.ts`
  - `tests/unit/chatgpt-bundle.test.ts`
  - スクリーンショットの収集の既存の単体テスト

## 作るもの

1. **CC-026 JSON の書式**
   - `src/report/artifact-json.ts` に、artifact の JSON の書式の関数を1つ置く。
     - 書式は、字下げ2文字、末尾に LF である。
     - 文字列を返す関数と、UTF-8 のバイト列を返す関数を置く。必要なら、両方を置く。
   - `ArtifactWriter` とバンドルは、この関数を使う。元の private の関数は消す。
   - 書き出される JSON のバイト列は、変えない。既存のテストが、そのまま PASS すること。
2. **CC-027 artifact の相対パスの検証**
   - `src/core/artifact-layout.ts` に、Run のディレクトリからの相対パスが安全かどうかを確かめる関数を1つ置く。
     - 検証の規則は、3か所の規則のうち、いちばん厳しいものに合わせる。
       - 区切りは `/` である。
       - 空、`.`、`..` の区切りがない。
       - 絶対パス、ドライブ、URL のスキーム、バックスラッシュ、すべての制御文字を含まない。
     - 日本語は認める。
     - 不正な場合の振る舞いは、実装者が決めて報告する。
       - 例えば、`RangeError` を投げる関数か、真偽を返す関数か、その両方である。
       - 3か所の今の振る舞い（例外の種類と、呼び出し元への伝わり方）は、変えない。
   - 3か所は、この関数を使う。
     - `screenshot-collector.ts` の `portableRelativeArtifactPath`
     - `artifact-writer.ts` の `SAFE_PATH_SEGMENT` による検証
       - ID の区切り1つの検証の場合は、「区切り1つ」を確かめる関数として置いてもよい。
     - `chatgpt-bundle.ts` の `assertScreenshotEntryPath`
       - `pages/` で始まることは、バンドルの側の追加の条件として残す。
   - 規則を厳しくした結果、3か所のどこかで、今まで通っていた入力が拒まれるようになる場合は、報告してください。
     - 例: スクリーンショットの収集で、制御文字を含むパス
     - 撮る側のパスは `screenshotRelativePath` で作られるので、実際には起きないはずです。確かめて報告してください。

## テスト

- CC-026: 書式の関数の単体テストを書く。字下げ、末尾の LF、CR がないこと、UTF-8 の日本語を確かめる。
- CC-027: 検証の関数の単体テストを書く。
  - 認めるもの: 通常のパス、日本語のパス、`retry-<n>` を含むパス
  - 拒むもの: `..`、先頭の `/`、ドライブ、バックスラッシュ、空の区切り、`.`、NUL、そのほかの制御文字、URL のスキーム、末尾の `/`
- 既存のテスト（`artifact-writer`、`chatgpt-bundle`、スクリーンショットの収集）は、変更なしで PASS すること。

## 受け入れ条件

- 新しいテストが、修正前に RED、修正後に GREEN になる。
- 既存のテストのケースと期待値を、変えない。弱めない。
- 担当のテストと、`npm run typecheck`（自分のファイルについて）が PASS する。
- `npm run verify` は実行しない（並行作業のため）。

## 報告

共通ルールの形式で、日本語で報告してください。加えた関数のシグネチャを書いてください。
