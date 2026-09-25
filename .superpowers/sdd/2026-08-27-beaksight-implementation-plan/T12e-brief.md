# T12e 指示書: layout の Rule を、レスポンシブの幅ごとの結果にも当てはめる

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: T12e
- 目的: layout の5つの Rule を、`stressSweep` の結果にも当てはめる。
- 設計書: `doc/design/2026-09-23-beaksight-task-12-13-rules-design.md` の 5.1.1
- 前の報告: 作業記録置き場の `T12c-report.md`

T12c の変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

同時に、ほかの実装者（T12d0）が core の型を変えています。担当のファイル以外は変更しないでください。

`npm run typecheck` で担当外のファイルのエラーが出た場合は、次のようにしてください。

1. 時間を置いて、再実行する。
2. それでも残る場合は、エラーの内容を報告する。

## 変更してよいファイル

- `src/audit/layout-rules.ts`
- `tests/component/layout-rules.test.ts`

## 実装する内容

- 次の5つの Rule を、`LayoutEvidencePayload.stressSweep` の各結果の layout にも当てはめる。
  - `DOCUMENT_HORIZONTAL_OVERFLOW`
  - `ELEMENT_OUTSIDE_VIEWPORT`
  - `ELEMENT_OVERLAP`
  - `CONTENT_COLLISION`
  - `FIXED_ELEMENT_OCCLUSION`
- 判定に使う結果:
  - `COMPLETE` の結果を使う。
  - `PARTIAL` で layout が null でない結果は、集めた部分だけで判定する。
  - `FAILED` の結果と、layout が null の結果は、判定しない。
- 主要なビューポートの幅（`primary` の layout のビューポートの幅）と同じ幅の結果は、判定しない。
- 幅ごとの結果から作る Finding の決まり:
  - 同一性の要素 `stressWidth`（幅の10進の文字列）を持つ。
  - `primary` から作る Finding は、この要素を持たない。既存の fingerprint は変えない。
  - 文言には、幅（px）を含める。
- 判定の処理は、`primary` のものを使い回す。幅ごとに同じ判定を書き直さない。

## 受け入れ条件

- 次のテストがある。どれも、修正前に RED、修正後に GREEN になること。
  - 320 px の幅だけで横にはみ出すページで、`stressWidth: '320'` の `DOCUMENT_HORIZONTAL_OVERFLOW` が1件できる。
  - 主要な幅と同じ幅の結果からは、Finding を作らない。
  - `FAILED` の幅は、判定しない。
  - 5つの Rule のそれぞれで、幅ごとの結果から Finding ができる。
- 既存の layout のテストは、すべて PASS のまま。`primary` の Finding の fingerprint も変わらない。
- `npm run typecheck` と、担当のテストが PASS する。build と verify は実行しない。

## 報告

共通ルールの形式で、日本語で報告してください。
