# C16a 実装報告（要約。設計者が保存）

## 結論

完了した。実装者の報告では、`npm run verify` は PASS した（80ファイル、2711件。todo 1件）。UI Gate のファイルは、単独の実行で 314ms だった。

- artifact の配置を、`src/core/artifact-layout.ts` の1か所に移した。
  - `src/report/**` から `src/orchestration/**` への import は、なくなった。
  - UI Gate のファイルに、そのことを確かめるテストを加えた。
- CC-022: `requiredArtifactInvalidReason` を `src/core/status.ts` に置いた。Run Coordinator と `ArtifactWriter` の両方が、これを使う。
- 「重大な指摘」は、`SEVERITY_CATALOG` の `criticalSection` で選ぶ。
- スクリーンショットと Finding の関係づけを、設計書 6.1.8 の規則に広げた（`relateScreenshotsToFindings` の1か所）。

## `src/core/artifact-layout.ts`

- 定数
  - `RUN_ARTIFACT_FILE_NAMES`、`PAGE_ARTIFACT_FILE_NAMES`、`PageArtifactFile`
  - `PAGES_ARTIFACT_DIRECTORY`、`RETRY_ARTIFACT_DIRECTORY_PREFIX`、`SCREENSHOT_FILE_NAMES`
- 関数
  - `runArtifactDirectory(outputDirectory, runId)`
  - `pageArtifactRelativePath(pageId, file)`
  - `screenshotRelativePath(pageId, viewport, captureType, retryAttempt)`
  - `artifactFilePath(runDirectory, relativePath)`

## 実装者の判断と、設計者の判断

1. 既存のテスト2件の期待値を、6.1.8 の規則に合わせて変えた。→ 承認する。
   - 旧い期待値は、廃止した規則（直接の参照だけ）を固定していた。
   - 新しい期待値は、より多くの関係を求める。条件は弱めていない。
2. `FindingView.screenshots` の順は、次のとおりにした。→ 承認する。設計書 6.1.9 に書いた。
   1. 直接参照するもの（`evidenceRefs` の順）
   2. 同じページ・同じビューポートのもの（`page.json` の中の順）
3. `EvidenceLocationView.relatedFindingIds` は、直接の参照だけのままにした。→ 承認する。意味を分けて、設計書 6.1.9 に書いた。
   - `EvidenceLocationView.relatedFindingIds` は、その Evidence を直接参照する Finding である。どの種類の Evidence にもある。
   - `ScreenshotView.relatedFindingIds` は、6.1.8 の関係づけによる Finding である。
   - バンドルでは、次のように使う。
     - `evidence-index.json` には、前者を使う。
     - 入れるスクリーンショットの選び方には、後者を使う。
4. 表示用モデルのスクリーンショットのパスは、`ScreenshotEvidence.relativePath` をそのまま使った。→ 承認する。
   - 記録した事実を、唯一の出どころにする。
   - 組み立て直すと、同じパスが2か所になる。
   - 指示書の「表示用モデルは、それを使う」は、この判断で置き換える。
5. 統合テストの import の先を変えた。→ 承認する。
6. `AUDIT_ARTIFACT_SCHEMA_VERSION` と、ページの記録の関数を、report に残した。→ 承認する。配置ではないためである。
7. `screenshotRelativePath` の入力の検証（`RangeError`）。→ 承認する。
8. `status.ts` は、`ArtifactSchemaName` を型だけで import した。→ 承認する。

## 発見事項と、設計者の判断

1. 変更前は、同じスクリーンショットの ID を2回参照すると、2回入っていた。→ C16a で直り、テストで確かめた。
2. 共通部品台帳と、CC-022・CC-023 の状態の更新。→ 設計者が行った。
