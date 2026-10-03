# C16d 指示書: Safety の事象の一覧、Interaction の Evidence の場所、整数の書式、ID の形の検証

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。末尾の「一時ディレクトリの扱い」も守ってください。

## サブタスク

- ID: C16d
- 目的: U16c の報告を受けて、HTML レポートの Safety の節と Interaction の節を、設計書のとおりにする。
- 設計書:
  - `doc/design/2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md` の 6.1.10（今回の決定）
  - 同じ設計書の 6.1.3、6.1.4、6.1.9
  - UI追補設計書 `doc/design/2026-09-23-beaksight-ui-ssot-design.md` の第4章
- 前の報告: 作業記録置き場の次の4つ
  - `U16c-report.md`
  - `U16d-report.md`
  - `C16a-report.md`
  - `C16c-report.md`（とくに判断1）
- 共通部品台帳: `doc/design/beaksight-shared-components.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

このサブタスクは単独で実行します。

## 変更してよいファイル

- `src/report/view-model.ts`
- `src/report/html-report.ts`
- `src/presentation/catalog.ts`（`SAFETY_EVENT_KIND_CATALOG` を加えることに限る）
- `src/presentation/format.ts`（`formatInteger` を加えることに限る）
- `src/presentation/messages.ts`（Safety の事象の表の文言を加えることに限る）
- `src/report/html-components.ts`（部品が足りない場合に、加えることに限る）
- `src/core/ids.ts`（`isRunId` と `isPageId` を加えることに限る）
- `src/report/artifact-writer.ts`（ID の形の検証に限る）
- テスト:
  - `tests/unit/view-model.test.ts`
  - `tests/unit/html-report.test.ts`
  - `tests/unit/presentation-catalog.test.ts`
  - `tests/unit/presentation-format.test.ts`
  - `tests/unit/report-html-components.test.ts`
  - `tests/unit/chatgpt-bundle.test.ts`（表示用モデルの変更で、期待値の形が変わる場合に限る）
  - `tests/helpers/audit-run-fixture.ts`（Safety の事象の見本を加えることに限る）
  - `tests/unit/core-contracts.test.ts`（`isRunId` と `isPageId` のテストに限る）
  - `tests/unit/artifact-writer.test.ts`（ID の形の検証のテストに限る）

`src/report/chatgpt-bundle.ts` は、変更しません。

- 表示用モデルの変更で、バンドルの出力（`summary.json`、`pages.json`、`evidence-index.json`、`findings.json`）が変わる場合は、止まって報告してください。
- 変わらないことを、既存のバンドルのテストが変更なしで PASS することで確かめてください。

## 作るもの

1. **Safety の事象の一覧**（設計書 6.1.10）
   - 表示用モデルの `safety` に、`events` を加える。
     - 形は、6.1.10 のとおりにする。
     - 記録の種類は、`SafetyEventsEvidence` の事象の一覧の項目のすべてにする。
     - 項目の一覧は、型から書き漏れが分かる形にする。例えば、`satisfies Record<…>` や、`keyof` を使う。
   - `SAFETY_EVENT_KIND_CATALOG` を、カタログに加える。
     - 記録の種類ごとに、日本語のラベルと表示の順を持たせる。
     - 書き漏れは、型のエラーにする。
     - UI Gate の UI05（カタログにすべての値がある）の対象にも加える。
       - `tests/architecture/ui-ssot.test.ts` が変更の範囲にないので、UI05 の対象の一覧が1か所で決まっている場合は、報告だけでよい。
   - HTML の Safety の節に、事象の表を加える。
     - 列: 種類、ページ（アンカーへのリンク）、ビューポート、メソッド、URL（`renderUrl`）、理由、Evidence の参照
     - 再試行の前の試行の記録は、そのことが分かるように示す。
     - 事象がない場合は、「なし」と示す。
2. **Interaction の Evidence の場所**
   - `InteractionView` に、`location: EvidenceLocationView | null` を加える。
   - HTML は、`location` を使う。`html-report.ts` の中で ID から場所を引き直す処理は、消す。
3. **整数の書式**
   - `format.ts` に、`formatInteger` を加える。
     - 観測できなかった値の扱いは、ほかの書式と同じにする。
   - HTML の整数（リンクの深さの上限、HTTP ステータスなど）は、これで示す。
   - `formatDecimal(値, 0)` の使い方は、なくす。

4. **ID の形の検証**（C16c の判断1を直す）
   - `src/core/ids.ts` に、`isRunId(value): value is RunId` と `isPageId(value): value is PageId` を加える。
     - 判定の形は、`createRunId` と `createPageId` が作る形と、スキーマの pattern に合わせる。
       - `RUN-` と、6桁以上の数字
       - `PAGE-` と、6桁以上の数字
     - 形の定義は、ids.ts の中で1か所にする。
   - `ArtifactWriter` は、runId と pageId を、この判定で確かめる。
     - 形の違う値は、何も書かずに `RangeError` にする。C16c の前と同じ振る舞いである。
   - パスの区切りとして安全かどうかの検証（`isPortableArtifactPathSegment`）は、残してよい。二重の守りになる。
   - C16c の報告で、通るようになった値は、どれも `RangeError` になること。
     - 例: `ページ`、`a.b`、`_x`、`-x`、`a b`、`PAGE-1`（桁が足りない）

## テスト

- 表示用モデル:
  - Safety の Evidence の各種類の記録が、`events` に正しい形と順で入る。
  - 再試行の前の試行の記録に、`retryAttempt` が付く。
  - `location` が、Interaction の Evidence の場所と一致する。
- HTML:
  - Safety の節に事象の表があり、URL がエスケープされ、`mailto:` と `tel:` がリンクにならない。
  - 事象がない場合は、「なし」と示される。
  - Interaction の Evidence の参照が、`location` から描かれる。
- カタログ:
  - すべての記録の種類に、ラベルがある。
  - 書き漏れが、型のエラーになる（`@ts-expect-error`）。
- 書式: `formatInteger` の単体テストを書く。
- 既存のバンドルのテストが、変更なしで PASS する。
- ID の形: `isRunId` と `isPageId` の単体テストを書く。`ArtifactWriter` が、形の違う ID を `RangeError` で拒むことを確かめる。

## 受け入れ条件

- 各テストが、修正前に RED、修正後に GREEN になる。
- UI Gate のファイルが、1秒以内に終わる。
- `npm run typecheck` が PASS する。
- `npm run verify` が PASS する。このサブタスクでは build を実行してよい。

## 報告

共通ルールの形式で、日本語で報告してください。表示用モデルに加えた型を書いてください。
