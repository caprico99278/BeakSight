# C5b 指示書: DOM の可視テキストの修正（display:contents と見出し）

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: C5b
- 目的: C5 の報告で見つかった、DOM の可視テキストの2つの不具合を直す。
- 背景: 作業記録置き場の `C5-report.md` の発見事項1と3。設計書 `doc/design/2026-09-23-beaksight-foundation-corrections-design.md` 5.3、5.5。

同時に、ほかの実装者が C6（`src/evidence/layout-collector.ts`）を修正しています。担当範囲の外のファイルは変更しないでください。

## 変更してよいファイル

- `src/evidence/dom-collector.ts`
- テスト: `tests/component/dom-collector.test.ts`、および新規のテストファイル
- `fixtures/site/` への新しいページの追加

## 修正する内容

1. **display:contents**
   - テキストノードが可視かどうかを判定するときは、`display: contents` ではない最も近い祖先の要素に対して、`checkVisibility` を呼ぶ。
   - `display: contents` の要素は描画上の箱を持たないので、`checkVisibility` が false を返す。そのため、今は `display: contents` の要素の直下のテキストが、可視テキストから落ちている。
   - テストで、`<div style="display:contents">見える文</div>` の文が、可視テキストに含まれることを確かめる。
2. **見出しの可視判定**
   - 見出し（`headings`）も、可視テキストと同じ可視判定で、見えるものだけを集める。
   - 集め方は、innerText ではなく、可視テキストと同じ走査の考え方にそろえる。
   - 見出しが、今の形の項目（テキスト、レベルなど）を持つことは変えない。
   - テストで、`visibility:hidden` の見出しと、`display:none` の祖先を持つ見出しが含まれず、見える見出しが含まれることを確かめる。
3. 可視判定のオプションは、これまでどおり `VISIBILITY_CHECK_OPTIONS` を `evaluate` の引数として渡して使う。オプションの値は F04 で変わる予定なので、特定の値に依存するテストを書かない。

## 受け入れ条件

- 上の各項目について、修正前に RED、修正後に GREEN になる。
- `tests/component/dom-collector.test.ts` の既存のテストと、`npm run typecheck` の担当範囲が PASS する。

## 報告

共通ルールの形式で報告してください。
