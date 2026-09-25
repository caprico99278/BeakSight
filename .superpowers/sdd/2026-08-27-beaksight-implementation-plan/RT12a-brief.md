# RT12a 指示書: layout の誤検知を避けるための Evidence の追加と、Rule の修正

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: RT12a
- 目的: 独立レビュー RT12 の I1・I2・I3・M6 を直す。
- 設計書: `doc/design/2026-09-23-beaksight-task-12-13-rules-design.md` の 5.1.2
- レビューの結果: 作業記録置き場の `RT12-review-result.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

同時に、別の実装者（RT12b）が、Cross-page rule、Rule Engine、technical の Rule を作業しています。担当のファイル以外は変更しないでください。

## 変更してよいファイル

- `src/evidence/layout-collector.ts`
- `src/core/evidence-types.ts`（layout の型に限る）
- `schemas/page.schema.json`（layout の定義に限る）
- `src/audit/layout-rules.ts`
- テスト: layout の collector のテスト（`tests/component/layout-collector.test.ts`、`tests/integration/layout-accessibility.test.ts` など、既存のもの）、`tests/component/layout-rules.test.ts`、`tests/unit/schema-validator.test.ts`（layout の見本に限る）、`tests/unit/schema-enum-consistency.test.ts`（新しい enum を加える場合に限る）
- `fixtures/site/` への新しいページの追加

## 修正する内容

1. **I1 `ELEMENT_OUTSIDE_VIEWPORT`**
   - `OutsideViewportEvidence` に、次の2つを加える。
     - `horizontalClipAncestor`: `NONE`、`CLIPPED`、`SCROLLABLE` のいずれか。一覧は、core の `as const` の配列にする。
     - 一覧の中の、最も近い祖先の番号（ない場合は null）
   - Rule は、次の条件をすべて満たす要素だけを報告する。
     - `horizontalClipAncestor` が `NONE` であること
     - kind が `other` でないこと
     - 一覧に祖先がないこと
   - fixture で、次のことを確かめる。修正前に RED、修正後に GREEN になること。
     - `overflow:hidden` の中のカルーセル、`overflow-x:auto` の表、`body` に `overflow-x:hidden` を付けたページでは、Finding ができない。
     - `table` の入れ子（`tbody`、`tr`、`td`）で、Finding が重ならない。
   - 本当に横へはみ出す主要要素（例: 固定の幅の画像）は、引き続き Finding になることを確かめる。
2. **I2 `TEXT_CLIPPING`**
   - `ClippedTextEvidence` に、`partiallyClippedText` を加える。これは、子孫のテキストの行の矩形（`Range.getClientRects` など）の1つ以上が、要素の箱の境界をまたいでいるかを表す。
   - 走査するテキストのノードの数には、上限を設ける。上限に達した場合は、判定できないものとして false にし、切り詰めの記録に残す。
   - Rule は、これが真の場合だけ報告する。
   - fixture で、次のことを確かめる。
     - カルーセルの外枠、ページ全体の `overflow-x:hidden`、画像を拡大するカードでは、Finding ができない。
     - 本当にテキストが切れている箱では、Finding ができる。
3. **I3 `ZERO_SIZE_INTERACTIVE_ELEMENT`**
   - `ZeroSizeInteractiveEvidence` に、`hasRenderedDescendant` を加える。
   - Rule は、これが真の要素を除く。
   - fixture で、次のことを確かめる。
     - float の画像だけを包むリンクと、absolute の子だけを包むリンクでは、Finding ができない。
     - 本当に中身がない、大きさ0のボタンでは、Finding ができる。
4. **M6 しきい値ちょうどの値**
   - 0.25、0.3、0.1 などのしきい値について、ちょうどその値では Finding を作らないことを確かめるテストを加える。
   - しきい値をわずかに超える値では、Finding を作ることも確かめる。

型とスキーマの変更に合わせて、スキーマの見本と、enum の一致のテストを直す。

## 受け入れ条件

- 各項目で、修正前に RED、修正後に GREEN になる。
- 既存の layout のテストは、すべて PASS する。
- `npm run typecheck` と、担当のテストが PASS する。
- build と verify は実行しない（並行作業のため）。

## 報告

共通ルールの形式で、日本語で報告してください。
