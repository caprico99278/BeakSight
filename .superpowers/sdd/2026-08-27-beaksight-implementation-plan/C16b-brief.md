# C16b 指示書: 表示のテストの Run の見本を、共通のテスト補助にまとめる（CC-024）

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。末尾の「一時ディレクトリの扱い」も守ってください。

## サブタスク

- ID: C16b
- 目的:
  - `tests/unit/view-model.test.ts` と `tests/unit/artifact-writer.test.ts` に複製されている、Run の見本の組み立てを、1つのテスト補助にまとめる。
  - この後の U16c（HTML）、U16d（バンドル）、U17a（CLI）は、その補助を使う。
- 共通化候補: 作業記録置き場の `commonization-candidates.md` の CC-024
- 設計書: `doc/design/2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md` の 6.1.3、6.1.8、6.1.9
- 共通部品台帳: `doc/design/beaksight-shared-components.md`（テスト補助の行）

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

このサブタスクは単独で実行します。

## 変更してよいファイル

- 新規: `tests/helpers/audit-run-fixture.ts`、`tests/unit/audit-run-fixture.test.ts`
- `tests/unit/view-model.test.ts`、`tests/unit/artifact-writer.test.ts`（見本の組み立てを、補助の import に置き換えることに限る）

`src/**` は変更しません。

## 作るもの

1. **`tests/helpers/audit-run-fixture.ts`**
   - 2つのテストファイルにある組み立ての関数を、1つにまとめる。
     - Evidence の見本: 汎用の `record`、`dom`、`screenshot`、`interaction` など
     - `finding`、ビューポートの結果、`page`、`runSummary`、`auditRun`（`statusInput` を含む）
   - 2つのファイルで引数や既定値が違う関数は、両方の使い方をまかなえる形にする。例えば、省略できる引数や、上書きの引数である。
     - まとめ方は、実装者が決めて報告する。
   - 見本は、どれもスキーマに合う形で作る。
     - `auditRun()` の既定の結果から作った run.json、audit.json、page.json が、`validateArtifact` に合うこと。
   - スクリーンショットの `relativePath` は、`screenshotRelativePath`（`src/core/artifact-layout.ts`）で作る。
   - HTML とバンドルのテストで使えるように、次の値を含む見本も、簡単に作れるようにする。
     - 危険な文字列（`<script>`、`"onerror=`、`javascript:`）
     - `mailto:` と `tel:` の URL
     - 日本語
     - 再試行したページ
2. **置き換え**
   - 2つのテストファイルは、補助を import する形にする。ファイルの中の組み立ての関数は、消す。
   - テストのケースと期待値は、変えない。件数も同じのままにする。
3. **補助のテスト（`tests/unit/audit-run-fixture.test.ts`）**
   - 既定の見本が、スキーマに合うことを確かめる。
   - 上書きが効くことを確かめる。

## 受け入れ条件

- 置き換えの前後で、2つのテストファイルの PASS の件数が同じである。前後の件数を報告に書く。
- テストのケースと期待値を、削除したり弱めたりしていない。
- `npm run typecheck` が PASS する。
- `npm run verify` が PASS する。

## 報告

共通ルールの形式で、日本語で報告してください。U16c・U16d・U17a の実装者が使うので、補助の関数の一覧を、シグネチャと既定値の要点付きで書いてください。
