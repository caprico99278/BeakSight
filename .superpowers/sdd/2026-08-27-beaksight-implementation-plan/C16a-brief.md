# C16a 指示書: 表示の前の整理（artifact の配置の owner、CC-022、重大な指摘、スクリーンショットの関係づけ）

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。末尾の「一時ディレクトリの扱い」も守ってください。

## サブタスク

- ID: C16a
- 目的: U16b の報告を受けて、U16c・U16d の前に、表示の土台を整える。
- 設計書: `doc/design/2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md` の 6.1.8（今回の決定）、6.1.2、6.1.3
- 実装計画: `doc/design/2026-09-24-beaksight-task-16-17-implementation-plan.md` の末尾の追補（C16a）
- 前の報告: 作業記録置き場の `U16b-report.md`
- 共通化候補: 作業記録置き場の `commonization-candidates.md` の CC-022、CC-023
- 共通部品台帳: `doc/design/beaksight-shared-components.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

このサブタスクは単独で実行します。

## 変更してよいファイル

- 新規: `src/core/artifact-layout.ts`、`tests/unit/artifact-layout.test.ts`
- `src/core/status.ts`（CC-022 の関数を加えることに限る）
- `src/presentation/catalog.ts`（`SEVERITY_CATALOG` に `criticalSection` を加えることに限る）
- `src/orchestration/page-auditor.ts`、`src/orchestration/run-coordinator.ts`（配置と CC-022 を、新しい owner から取る形にすることに限る）
- `src/report/artifact-writer.ts`、`src/report/view-model.ts`
- テスト（対応するものに限る）:
  - `tests/unit/status.test.ts`
  - `tests/unit/view-model.test.ts`
  - `tests/unit/artifact-writer.test.ts`
  - `tests/unit/run-coordinator.test.ts`
  - `tests/unit/presentation-*.test.ts`
  - `tests/architecture/ui-ssot.test.ts`
  - スクリーンショットのパスを確かめている既存のテスト（import の先を変える場合に限る）

## 作るもの

1. **artifact の配置の owner（`src/core/artifact-layout.ts`。CC-023）**
   - 次のものを、ここに移す。
     - `runArtifactDirectory`（`run-coordinator.ts` から）
     - `pages` のディレクトリの名前
     - `RUN_ARTIFACT_FILE_NAMES`、`PAGE_ARTIFACT_FILE_NAMES`、`pageArtifactRelativePath`（`artifact-writer.ts` から）
     - スクリーンショットのパス（`page-auditor.ts` の `screenshotCapturePaths` の、パスを組み立てる部分）
       - 接頭辞の `retry-` と、ファイルの名前（`viewport.png`、`full-page.png`）を含む。
       - Run のディレクトリからの相対パスを作る関数も、ここに置く。表示用モデルは、それを使う。
   - 移した後は、元のファイルに同じ名前やパスを残さない。再 export もしない。
   - 使う側は、どれもここから import する。
     - Page Auditor
     - Run Coordinator
     - `ArtifactWriter`
     - 表示用モデル
   - `src/report/**` から `src/orchestration/**` への import が、なくなること。
     - これを確かめるテストを、UI Gate のファイルに1件加える。`fs` と正規表現だけで判定し、1秒以内に収める。
   - スクリーンショットの実際の配置（ファイルのパス）は、変えない。既存のテストが、そのまま PASS すること。
2. **CC-022**
   - `REQUIRED_ARTIFACT_INVALID` の detail（`<スキーマ>:<ID>:<最初の誤り>`）を組み立てる関数を、`src/core/status.ts` に1つ置く。
   - Run Coordinator と `ArtifactWriter` は、この関数を使う。
   - 重複した理由を除く処理が、今までどおり働くこと。
3. **「重大な指摘」（設計書 6.1.8）**
   - `SEVERITY_CATALOG` の各値に、`criticalSection: boolean` を加える。ERROR だけを真にする。
   - 表示用モデルの `criticalFindings` は、この属性で選ぶ。色のトーンでは選ばない。
4. **スクリーンショットの関係づけ（設計書 6.1.8）**
   - 最終の試行のスクリーンショットは、次のどちらかに当たる Finding に関係づける。
     - スクリーンショットの Evidence を、直接参照する。
     - 同じページ・同じビューポートの、最終の試行の Evidence を参照する。
   - 再試行の前の試行のスクリーンショットは、直接の参照だけで関係づける。
   - Finding の順は、`AuditRunResult.findings` の順にする。重複は入れない。
   - `FindingView.screenshots` と、`ScreenshotView.relatedFindingIds` の両方が、この規則に合うこと。
   - 関係づけの処理は、表示用モデルの中の1か所にする。

## テスト

- 配置:
  - 移した関数が、これまでと同じパスを返す（Windows の区切りと、相対パスの `/` の区切りを含む）。
  - `src/report/**` が、`src/orchestration/**` を import しない。
- CC-022: 組み立ての関数の単体テストを書く。重複した理由を除く処理の、既存のテストが PASS する。
- 重大な指摘:
  - `criticalSection` が真の severity の Finding だけが、選ばれる。
  - カタログの書き漏れが、型のエラーになる。
- 関係づけ:
  - 同じページ・同じビューポートの Evidence を参照する Finding に、スクリーンショットが関係づく。
  - 別のビューポートや、別のページのスクリーンショットには、関係づかない。
  - 再試行の前の試行のスクリーンショットは、直接の参照がない限り、関係づかない。
  - Cross-page の Finding のように、ページの Evidence を参照する場合も、上の規則で関係づく。

## 受け入れ条件

- 新しいテストが、修正前に RED、修正後に GREEN になる。構造の移動のように RED を作れないものは、代わりの確かめ方を報告に書く。
- 既存のテストは、import の先を変える以外に変えない。テストの条件を弱めない。
- UI Gate のファイルが、1秒以内に終わる。
- `npm run typecheck` が PASS する。
- `npm run verify` が PASS する。このサブタスクでは build を実行してよい。

## 報告

共通ルールの形式で、日本語で報告してください。U16c と U16d の実装者が使うので、`src/core/artifact-layout.ts` の関数と定数の一覧を、シグネチャ付きで書いてください。
