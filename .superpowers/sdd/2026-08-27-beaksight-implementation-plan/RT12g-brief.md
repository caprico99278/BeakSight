# RT12g 指示書: 文書の外へ動かしたスライドの中のリンクの誤検知と、テストの注記

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: RT12g
- 目的: 確認のレビュー RT12r3 の m1 と m2 を直す。
- 設計書: `doc/design/2026-09-23-beaksight-task-12-13-rules-design.md` の 5.1.2 の `ZERO_SIZE_INTERACTIVE_ELEMENT`（RT12r3 を受けて加えた箇所）
- レビューの結果: 作業記録置き場の `RT12r3-review-result.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

同時に、別の実装者（P14b）が、`src/orchestration/` の下に新しいファイルを作っています。担当のファイル以外は変更しないでください。`npm run typecheck` で、`src/orchestration/` の作業途中のエラーが出た場合は、担当のファイルにエラーがないことを確かめて報告してください。

## 変更してよいファイル

- `src/evidence/layout-collector.ts`
- `tests/integration/layout-accessibility.test.ts`
- `fixtures/site/` の layout の fixture への追記と、新しいページの追加

## 修正する内容

1. **m1**
   - `hasRenderedDescendant` の判定で、「文書の左か上の外に丸ごと置かれた子孫を数えない」扱いを、候補のリンク自身が文書の中にある場合に限る。
     - 文書の中にあるとは、文書の座標で、右端と下端が 0 より大きいことをいう。
   - fixture とテストで、次のことを確かめる。
     - 幅 600px の `overflow:hidden` の箱に、`transform:translate3d(-1200px,0,0)` のトラックを置き、スライドを4枚並べる。各スライドには、`display:block` のリンクを置き、その中に absolute の img と span を入れる。
       - この形では、どのリンクも報告されない。修正前は RED、修正後は GREEN になること。
     - `left:-9999px` のテキストだけを持つリンクは、引き続き報告される。対象は、ビューポートの中にあるリンクである。
2. **m2**
   - 1行の見出しのテストに、前提の注記を書く。
     - このテストは、Windows の既定のフォント（Meiryo など）で、上下に出た量の合計が行の高さの4分の1を超えることを前提にしている。
     - BeakSight は、Windows で使う前提である。
   - 前提が崩れた場合は、skip にしない。これまでどおり、前提の assert で失敗させる。

## 受け入れ条件

- m1 のテストは、修正前に RED、修正後に GREEN になる。
- 既存の layout のテストは、すべて PASS する。
- 担当のテストが PASS する。
- `npm run verify` は実行しない（並行作業のため）。全体の verify は、設計者が行う。

## 報告

共通ルールの形式で、日本語で報告してください。
