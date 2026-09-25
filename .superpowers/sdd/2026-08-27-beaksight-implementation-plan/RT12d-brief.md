# RT12d 指示書: layout の見切れの判定の改善と、はみ出しの候補の修正

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: RT12d
- 目的: 確認のレビュー RT12r の N1・N3・N4・N5 を直す。N2 は、制約として受け入れたので、直さない。
- 設計書: `doc/design/2026-09-23-beaksight-task-12-13-rules-design.md` の 5.1.2（RT12r を受けて改めた箇所）
- レビューの結果: 作業記録置き場の `RT12r-review-result.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

このサブタスクは単独で実行します。

## 変更してよいファイル

- `src/evidence/layout-collector.ts`
- `src/core/evidence-types.ts`（layout の型に限る）
- `schemas/page.schema.json`（layout の定義に限る）
- `src/audit/layout-rules.ts`
- テスト: `tests/component/layout-collector.test.ts`、`tests/component/layout-rules.test.ts`、`tests/integration/layout-accessibility.test.ts`、`tests/integration/layout-evidence-scale.test.ts`、`tests/unit/schema-validator.test.ts`（layout の見本に限る）、`tests/unit/schema-enum-consistency.test.ts`（必要な場合に限る）
- `fixtures/site/` への新しいページの追加と、既存の layout の fixture への追記

## 修正する内容

1. **N1 `partiallyClippedText` の判定**（設計書 5.1.2 の判定の方法）
   - 次のどちらかに当たれば、真とする。
     - 行の矩形のうち、箱の外に出た量が、その行の大きさ（切り取る方向）の4分の1を超える。
     - 縦方向に切り取る箱で、行の矩形が箱の上か下に丸ごと出ていて、横方向に箱と重なる。
   - ただし、箱の中に見える行が1つもない場合は、偽とする。
   - 4分の1の割合は、名前を付けた定数にする。
   - fixture とテストで、次のことを確かめる。修正前に RED、修正後に GREEN になること。
     - 誤検知: 高さが auto の `overflow:hidden` の箱で、行の高さが小さい場合（例: Arial 32px、line-height 1）に、Finding ができない。
     - 見逃し: 行の高さ 24px の4行のテキストを、高さ 48px の `overflow:hidden` の箱に入れた場合に、Finding ができる。
     - 横方向に隠れたスライドと、高さ 0 の閉じたパネルでは、Finding ができない。
     - これまでの fixture（`#clipped-caption` など）の結果は、変わらない。
2. **N3 主要要素の種類**
   - `LAYOUT_ELEMENT_KINDS` に、`table` と `media` を加える。`media` は、iframe、video、embed、object、canvas とする。
   - collector の種類の判定を直す。
   - ほかの Rule（`ELEMENT_OVERLAP` など）で、kind の一覧から対象を決めている箇所がある。その箇所の結果を変えないようにし、変わる場合は報告する。
   - スキーマと enum の一致のテストを直す。
   - fixture とテストで、幅の広い表と iframe が横にはみ出すとき、Finding ができることを確かめる。
3. **N4 候補の優先**
   - はみ出しの候補の件数の上限の中では、`horizontalClipAncestor` が `NONE` の候補を、優先して残す。
   - 文書の順の決定論は保つ。
   - 12枚のスライドを持つカルーセルを2つ置いた後に、幅 600px の画像があるページで、その画像の Finding ができることを確かめる。
4. **N5 1 px 以下の子孫**
   - `hasRenderedDescendant` の判定で、幅か高さが 1 px 以下の子孫を数えない。
   - 値は、layout の Rule の `VISUALLY_HIDDEN_MAX_DIMENSION_PX` と同じ意味の定数にする。定義は1か所にまとめる。core か collector の、両方から使える場所に置く。
   - visually hidden のテキストだけを含む、大きさ0のリンクで、Finding ができることを確かめる。

## 受け入れ条件

- 各項目で、修正前に RED、修正後に GREEN になる。
- 既存の layout のテストは、すべて PASS する。変わってよい期待値は、この修正の対象だけである。
- 規模のテストの時間が、目安（1秒）に収まる。所要時間を報告する。
- `npm run typecheck` と、担当のテストが PASS する。
- `npm run verify` が PASS する。このサブタスクでは build を実行してよい。

## 報告

共通ルールの形式で、日本語で報告してください。
