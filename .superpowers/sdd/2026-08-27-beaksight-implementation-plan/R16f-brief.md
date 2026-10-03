# R16f 指示書: R16 の指摘の修正（Safety の事象の URL、相対リンク、空の表、バンドル、UI04）

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。末尾の「一時ディレクトリの扱い」も守ってください。

## サブタスク

- ID: R16f
- 目的: Task 16 の独立レビュー R16 の指摘の1、2、3、5、6 を直す。
- 設計書: `doc/design/2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md` の 6.1.11（今回の決定）
  - 関係する節: 6.1.6、6.1.9、6.1.10
- レビューの結果: 作業記録置き場の `R16-review-result.md`
- 前の報告: 作業記録置き場の `U16c-report.md`、`U16d-report.md`、`C16c-report.md`〜`C16e-report.md`
- 共通部品台帳: `doc/design/beaksight-shared-components.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

このサブタスクは単独で実行します。

## 変更してよいファイル

- `src/report/html-report.ts`、`src/report/html-components.ts`
- `src/report/chatgpt-bundle.ts`
- `src/core/limits.ts`（`CHATGPT_BUNDLE_SCREENSHOT_BUDGET_BYTES` を加えることに限る）
- `src/core/artifact-layout.ts`（相対リンクの検証に必要な場合に限る。既存の関数の振る舞いは変えない）
- `src/presentation/messages.ts`（空の表の見出しなど、文言を加えることに限る）
- `tests/architecture/ui-ssot.test.ts`（UI04 の検出の規則に限る）
- テスト:
  - `tests/unit/html-report.test.ts`
  - `tests/unit/report-html-components.test.ts`
  - `tests/unit/chatgpt-bundle.test.ts`
  - `tests/unit/artifact-layout.test.ts`
  - `tests/helpers/audit-run-fixture.ts`（見本を加えることに限る）

## 直すもの

1. **Safety の事象の URL を、リンクにしない**（指摘1。Important）
   - Safety の事象の表の URL は、`classifyUrl` の結果によらず、すべて文字で示す。
   - 文字で示す部品がなければ、`html-components.ts` に加える。
   - 6.1.6 のリンクの規則（Finding、ページ、Interaction の URL）は、変えない。
   - テスト:
     - 事象の表に、http(s) の URL を持つ次の記録を入れて描く。
       - 外部への作用、ダウンロード、遮断した POST、ポップアップ
     - 事象の表の中に、`<a` の要素が URL として出ないことを確かめる。
     - Evidence の参照とページのアンカーのリンクは、残る。
   - 修正の前に RED になること。
2. **UI04 の検出の規則**（指摘2）
   - 分割代入の形の数え直しも、検出する。
     - `({ severity }) =>`
     - `for (const { severity } of …)`
     - `x['severity']`
     - category も同じにする。
   - 規則の関数の単体テスト（検出の関数のテスト）に、これらの形を加え、検出されることを確かめる。
   - 今のコードに誤検知が出た場合は、理由を付けて除外の一覧に加える。
   - UI Gate のファイルは、1秒以内に終わること。
3. **HTML の相対リンクの検証**（指摘3）
   - `html-components.ts` の `SAFE_RELATIVE_HREF_PATTERN` による検証をやめる。
     - 相対パスが安全かどうかは、`isPortableRelativeArtifactPath` で確かめる。
     - href に固有の処理（区切りごとのパーセント符号化など）だけを、部品に置く。
   - 日本語を含むパスも、リンクにできる。href はパーセント符号化し、示す文字はエスケープした元の文字列とする。
   - 安全でないパスは、今までどおりリンクにせず、文字で示す。
4. **空の表**（指摘5）
   - 行がない表でも、何の表かが分かるように、見出しを示す。
   - 対象は、Safety の節のメソッドの表と違反の表、その他の同じ形の表である。
   - テストで、行がない表に見出しがあることを確かめる。
5. **バンドル**（指摘6。設計書 6.1.11）
   - 各ページの `page.json` を、ZIP に入れる。
     - `readArtifactFile` で読んだものを、そのまま入れる。パスは、Run のディレクトリの中と同じにする。
     - 順は、`evidence-index.json` の後、スクリーンショットの前にする。ページの並びは、パスの順にする。
     - 読めなかったものは、`omittedFiles` に書く。
     - `manifest.json` の `files` に含める。
   - スクリーンショットの大きさの上限（`CHATGPT_BUNDLE_SCREENSHOT_BUDGET_BYTES` = 64 MiB。`src/core/limits.ts`）
     - 入れる順と、入れなかったものの扱いは、設計書 6.1.11 のとおりにする。
     - `manifest.json` に、`screenshotBudgetBytes` を書く。
   - テスト:
     - `evidence-index.json` の各項目の `path` と `pointer` を、ZIP の中の `page.json` だけでたどれる。
     - 上限を超える場合に、決まったものが `omittedFiles`（`BUNDLE_SIZE_LIMIT`）に入る。
       - テストでは、上限を注入できる形にする。例えば、関数の省略できる引数であり、既定値が定数になる。
     - 決定論のテストは、今までどおり PASS する。
     - 生の本文を含まないテストは、今までどおり PASS する。
       - page.json を入れることで、このテストの前提が変わる場合は、何を確かめるテストにしたかを報告する。

## 受け入れ条件

- 各修正のテストが、修正前に RED、修正後に GREEN になる。
- 既存のテストのケースと期待値を、弱めない。
  - バンドルの中身の一覧が変わるテストは、期待値を新しい仕様に合わせて直してよい。直したテストは、報告に書く。
- UI Gate のファイルが、1秒以内に終わる。
- `npm run typecheck` が PASS する。
- `npm run verify` が PASS する。

## 報告

共通ルールの形式で、日本語で報告してください。指摘の番号ごとに、何をどう直したかを書いてください。
