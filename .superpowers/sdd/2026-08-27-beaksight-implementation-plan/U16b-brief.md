# U16b 指示書: 表示用モデルと、artifact の書き出し

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。末尾の「一時ディレクトリの扱い」も守ってください。

## サブタスク

- ID: U16b
- 目的:
  - 確定した Run から、表示用モデルを1回だけ組み立てる部品を作る。
  - artifact を書き出す唯一の owner（`ArtifactWriter.writeRun`）を作る。
- 設計書:
  - `doc/design/2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md` の第6章と 6.1（とくに 6.1.1〜6.1.3、6.1.7）
  - UI追補設計書 `doc/design/2026-09-23-beaksight-ui-ssot-design.md` の第4章
  - 実装タスク指示 `doc/design/2026-08-27-beaksight-implementation-tasks.md` の ARCH05 と ARCH08
- 実装計画: `doc/design/2026-09-24-beaksight-task-16-17-implementation-plan.md` の U16b
- 上位の計画: `doc/design/2026-08-27-beaksight-implementation-plan.md` の Task 16 の Step 1 と Step 2
- 前の報告: 作業記録置き場の次の3つ
  - `U16a-report.md`（カタログ、書式、部品のシグネチャ）
  - `R15d-report.md`
  - `C15x-report.md`（Run Coordinator と `runArtifactDirectory`）
- 共通部品台帳: `doc/design/beaksight-shared-components.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

このサブタスクは単独で実行します。

## 変更してよいファイル

- `src/core/contracts.ts`（`AuditRunResult.statusInput` を加えることに限る）
- `src/orchestration/run-coordinator.ts`（`statusInput` を入れることに限る）
- 新規: `src/report/view-model.ts`、`src/report/artifact-writer.ts`
- `tests/architecture/ui-ssot.test.ts`（UI04 を有効にし、UI01 の `src/report/**` の分を有効にすることに限る）
- テスト:
  - 新規: `tests/unit/view-model.test.ts`、`tests/unit/artifact-writer.test.ts`、`tests/integration/report-generation.test.ts`（書き出しの部分）
  - `tests/unit/run-coordinator.test.ts`（`statusInput` の確認に限る）

## 作るもの

1. **`AuditRunResult.statusInput`**（設計書 6.1.1）
   - メモリの上だけの項目として、`statusInput: RunStatusInput` を加える。JSON には書かない。
   - Run Coordinator は、`deriveRunStatus` に渡したものと同じ値を入れる。
   - audit.json に書くときは、この項目を除く。
2. **表示用モデル（`view-model.ts`）**（設計書 6.1.3）
   - 入口は、`buildReportViewModel(result: AuditRunResult)` とする。1回だけ組み立て、深く凍結する。
   - 持つもの:
     - Run の要約
       - Run Status
       - ページの網羅（発見、監査、PARTIAL、失敗、スキップ）
       - サイト品質の件数（ERROR、WARN、INFO）
       - Safety の件数
       - 上限と、未完了の理由（コードと、`messages.ts` の説明）
     - Finding の一覧と、その対応
       - 節ごと（重大な指摘、category の節）の Finding の一覧
       - Finding ごとの Evidence の参照
       - Finding ごとのスクリーンショットの参照
       - `relatedFindingIds` は、スクリーンショットの Evidence ごとに作る
     - ページの一覧
       - ページとビューポートの状態
       - スクリーンショット
       - 再試行の前の記録（`retries[].evidenceIds` で区別する）
     - Interaction の一覧（`status`、`notVerifiableKind`、`reason`）
     - Safety の一覧（`RunSafetySummary`）
   - Finding の件数と一覧の出どころは、`AuditRunResult.findings` の1つだけとする。
   - 表示用の集計（severity や category による分類と件数）は、このファイルだけで行う（UI04）。
   - 判定はしない。Run Status は、`RunSummary.runStatus` をそのまま使う。
   - ラベルと順は、カタログから取る。
     - ラベルそのものをモデルに入れるか、値とカタログの参照を入れるかは、実装者が決めて報告する。
     - どちらにする場合も、ラベルを2か所に書かない。
   - Evidence の参照の先（`page.json` の中の場所）とスクリーンショットの相対パスは、Run のディレクトリからの相対パスで持つ。
3. **`ArtifactWriter.writeRun(result, options)`**（設計書 6.1.1、6.1.2）
   - Run のディレクトリは、`runArtifactDirectory` で求める。
   - 書くファイル:
     - `run.json`
     - `audit.json`（`schemaVersion: 'audit-schema/1.0'` を付ける）
     - `pages/<pageId>/page.json`
     - `pages/<pageId>/visible-text.txt`
   - 書く前に、すべての JSON を `validateArtifact` で検証する。
   - どれかがスキーマに合わない場合は、次の3つを行う。
     1. `statusInput.requiredArtifactsValid` を偽にする。
     2. `deriveRunStatus` で、Run Status を導き直す。
     3. Run の理由に、`REQUIRED_ARTIFACT_INVALID` を加え、run.json と audit.json を組み立て直す。
   - スキーマに合わない JSON も、書き出す。
   - 一時ファイルに書いてから、rename する。UTF-8 と LF にする。
   - 戻り値には、次のものを入れる。
     - 最終の `AuditRunResult`（最終の Run Status のもの）
     - 書いたファイルの一覧
     - スキーマに合ったかどうか
   - HTML とバンドルは、U16c と U16d で作る。`writeRun` から呼ぶ形にするか、CLI から順に呼ぶ形にするかは、実装者が決めて報告する。
     - どちらにする場合も、最終の書き出しの owner は `ArtifactWriter` だけにする（ARCH08）。
     - `report.html` とバンドルのファイルも、`ArtifactWriter` を通して書く。
   - 入出力の失敗は、例外にする。
4. **UI Gate**（設計書 6.1.7）
   - UI04 を有効にする。Finding を severity や category で数えたり分けたりする処理は、`view-model.ts` だけにある、を確かめる。
   - UI01 のうち、`src/report/**` の分を有効にする。状態の値の文字列リテラルを、直接書かない、を確かめる。
   - Gate のファイルは、1秒以内に終わる。

## テスト

- 表示用モデル:
  - 件数、節の分け方、`relatedFindingIds`、再試行の前の記録の区別が、正しい。
  - Finding の出どころが1つである。
  - 深く凍結されている。
- `writeRun`:
  - ファイルの配置（設計書 6.1.2）と、UTF-8・LF。
  - スキーマに合わないページがある場合に、`PARTIAL` と `REQUIRED_ARTIFACT_INVALID` になる。この場合も、ファイルは書かれる。
  - 入出力の失敗で、例外になる。
  - 一時ファイルが残らない。
- 統合テスト（`report-generation.test.ts`）:
  - fixture のクロールの結果（Run Coordinator）を書き出す。
  - `run.json`、`audit.json`、各 `page.json` が、スキーマに合うことを確かめる。

## 受け入れ条件

- 各テストが、修正前に RED、修正後に GREEN になる。
- 共通部品台帳の部品を使い、同じ意味の処理を新しく書かない。
- UI Gate のファイルが、1秒以内に終わる。
- `npm run typecheck` が PASS する。
- `npm run verify` が PASS する。このサブタスクでは build を実行してよい。

## 報告

共通ルールの形式で、日本語で報告してください。U16c・U16d・U17a の実装者が使うので、表示用モデルの型と、`writeRun` のシグネチャを一覧にしてください。
