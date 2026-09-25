# RT12c 指示書: body に overflow-x:hidden があるページの DOCUMENT_HORIZONTAL_OVERFLOW の誤検知

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: RT12c
- 目的: RT12a の発見事項4を直す。
- 設計書: `doc/design/2026-09-23-beaksight-task-12-13-rules-design.md` の 5.1.2 の「`DOCUMENT_HORIZONTAL_OVERFLOW`」
- 前の報告: 作業記録置き場の `RT12a-report.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

このサブタスクは単独で実行します。

## 変更してよいファイル

- `src/evidence/layout-collector.ts`
- `src/core/evidence-types.ts`（layout の型に限る）
- `schemas/page.schema.json`（layout の定義に限る）
- `src/audit/layout-rules.ts`
- テスト: `tests/component/layout-collector.test.ts`、`tests/component/layout-rules.test.ts`、`tests/integration/layout-accessibility.test.ts`、`tests/unit/schema-validator.test.ts`（layout の見本に限る）、`tests/unit/schema-enum-consistency.test.ts`（必要な場合に限る）

## 修正する内容

- layout の Evidence の `document` に、ビューポートの横方向の overflow を記録する。
  - これは、`html` と `body` から伝わる計算値である。CSS の仕様では、`html` の値が `visible` なら、`body` の値が使われる。
  - 値の一覧は、既存の `HORIZONTAL_CLIP_ANCESTOR_KINDS` を使えるなら使う。使えない場合は、理由を報告する。
- `DOCUMENT_HORIZONTAL_OVERFLOW` は、ビューポートの横方向の overflow が `hidden` か `clip` の場合、Finding を作らない。
  - 幅ごとの結果（`stressSweep`）にも、同じ決まりを当てはめる。
- fixture の `layout-body-overflow-hidden.html` と `layout-page-wrapper-overflow-hidden.html` で、次のことを確かめる。修正前に RED、修正後に GREEN になること。
  - body に `overflow-x:hidden` がある場合は、Finding ができない。
  - 外枠の要素だけに `overflow-x:hidden` があり、文書が本当に横へスクロールする場合は、Finding ができる。この場合は、はみ出しの量も確かめる。
- 本当に横へはみ出すページ（既存の fixture）では、引き続き Finding ができることを確かめる。

## 受け入れ条件

- 修正前に RED、修正後に GREEN になる。
- 既存のテストは、すべて PASS する。
- `npm run typecheck` が PASS する。
- `npm run verify` が PASS する。このサブタスクでは build を実行してよい。

## 報告

共通ルールの形式で、日本語で報告してください。
