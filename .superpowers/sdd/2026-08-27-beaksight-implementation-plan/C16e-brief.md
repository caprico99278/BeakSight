# C16e 指示書: Safety の事象の種類の owner を core に移す、UI05 の対象の追加、「候補」の列

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。末尾の「一時ディレクトリの扱い」も守ってください。

## サブタスク

- ID: C16e
- 目的: C16d の報告を受けて、Safety の事象の種類の値の一覧を core に置き、表示の側はそれを使う形にする。
- 設計書: `doc/design/2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md` の 6.1.10（C16d の報告を受けて直した）
- 前の報告: 作業記録置き場の `C16d-report.md`（とくに判断1と3、発見事項1）
- 共通部品台帳: `doc/design/beaksight-shared-components.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

このサブタスクは単独で実行します。

## 変更してよいファイル

- `src/core/evidence-types.ts`（`SAFETY_EVENT_KINDS` と `SafetyEventKind` を加えることに限る）
- `src/presentation/catalog.ts`、`src/report/view-model.ts`、`src/report/html-report.ts`（種類の一覧の置き換えと、「候補」の列に限る）
- `src/presentation/messages.ts`（「候補」の列の見出しに限る）
- `tests/architecture/ui-ssot.test.ts`（UI05 の対象の追加に限る）
- `tests/helpers/audit-run-fixture.ts`（`safetyEventListNames` などを、core の一覧を使う形にすることに限る）
- テスト（対応するものに限る）:
  - `tests/unit/core-contracts.test.ts`
  - `tests/unit/presentation-catalog.test.ts`
  - `tests/unit/view-model.test.ts`
  - `tests/unit/html-report.test.ts`

## 作るもの

1. **種類の値の一覧を core に置く**
   - `src/core/evidence-types.ts` に、次の2つを置く。
     - `SAFETY_EVENT_KINDS`（`as const` の配列）
     - `SafetyEventKind`（その配列から導く型）
   - 配列の中身は、`SafetyEventsEvidence` の事象の一覧の項目の名前にする。
     - 並びの順は、`SafetyEventsEvidence` の項目の順と同じにする。
     - 書き漏れも余分も、型のエラーになる形にする。例えば、配列の要素の型と、`SafetyEventsEvidence` の配列の項目の鍵の型が、互いに等しいことを確かめる型である。
   - カタログの `SafetyEventKind` 型と、表示用モデルの `SAFETY_EVENT_FIELDS` から作っていた実行時の並びは、core の一覧を使う形にする。同じ一覧を、ほかに持たない。
     - 表示用モデルで、種類ごとに記録から項目を取り出す処理（`SAFETY_EVENT_FIELDS` の値の部分）が必要なら、鍵を `SafetyEventKind` にした `satisfies Record<…>` の形で残してよい。
   - テストの補助の `safetyEventListNames` なども、core の一覧を使う形にする。
2. **UI05 の対象**
   - `tests/architecture/ui-ssot.test.ts` の `catalogs` の一覧に、`SAFETY_EVENT_KIND_CATALOG` と `SAFETY_EVENT_KINDS` の組を加える。
   - UI05 の書式の検査に、`formatInteger(null)`（観測できなかった値）を加える。
   - UI Gate のファイルは、1秒以内に終わること。
3. **「候補」の列**
   - HTML の Safety の事象の表に、「候補」の列（`candidateId`）を加える。
   - 列の順は、次のとおりにする（設計書 6.1.10）。
     1. 種類、ページ、ビューポート
     2. メソッド、URL、候補
     3. 理由、Evidence の参照
   - 値のない欄の示し方は、メソッドや URL の欄と同じにする。

## テスト

- `SAFETY_EVENT_KINDS` が、`SafetyEventsEvidence` の事象の一覧の項目と一致する。
  - 実行時の検査: 空の Ledger から作った記録の項目と比べる。
  - 型の検査: `@ts-expect-error` などで確かめる。
- カタログに、すべての種類がある（UI05）。
- HTML の事象の表に、「候補」の列と、その値がある。候補の ID はエスケープされる。
- 既存のテストが、変更なしで PASS する。
  - 例外は、列が増えたことで行の中身の期待値が変わるテストだけである。その場合は、どのテストかを報告する。

## 受け入れ条件

- 各テストが、修正前に RED、修正後に GREEN になる。構造の移動のように RED を作れないものは、代わりの確かめ方を報告に書く。
- UI Gate のファイルが、1秒以内に終わる。
- `npm run typecheck` が PASS する。
- `npm run verify` が PASS する。

## 報告

共通ルールの形式で、日本語で報告してください。
