# F21 指示書: 明示した tab では、属性の変化を根拠にしない

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: F21
- 目的: 確認のレビュー R9 の Important-1 を直す。
- 設計書: `doc/design/2026-09-23-beaksight-foundation-corrections-design.md` の 4.4.1（「focus をしない要素と、focus による状態の変化」の R9 の追加分）
- レビューの結果: 作業記録置き場の `R9-review-result.md`

F20 と F20b の変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

このサブタスクは単独で実行します。

## 変更してよいファイル

- `src/evidence/interaction-collector.ts`
- `src/interaction/isolated-auditor.ts`
- `src/interaction/discover-candidates.ts`（必要な場合に限る）
- テスト: `tests/integration/isolated-interaction.test.ts`
- `fixtures/site/focus-activated-tabs.html` への追記

## 修正する内容

1. **明示した tab では、`attributes` を根拠にしない**
   - `role="tab"` を明示した要素（`hasExplicitTabRole` が真のもの）では、対象の属性の変化を根拠にしない。
   - 根拠にするのは、次のものに限る。
     - ARIA の状態（`aria-selected`、`aria-expanded`、`aria-pressed`、`aria-checked` など、今の ARIA の根拠）
     - `aria-controls` の先の表示
     - 文字
     - disabled
     - visible
   - tab かどうかの判定は、下準備で focus を飛ばす判定と同じもの（`hasExplicitTabRole`）を使う。判定を2か所に書かない。
   - `changedAttributes` と `changedAttributesTruncated` は、根拠にしない場合、これまでの決まりどおり、空と false にする。
2. **回帰テスト**（fixture に roving tabindex の形を加える）
   - Radix の形のタブを作る。
     - 選ばれていないトリガーは `tabindex="-1"` にする。
     - focus と mousedown で、`tabindex` を `0` に変える。
     - 自動と手動の両方を作る。
   - 次のことを確かめる。
     - すでに選ばれているタブを押すと、自動と手動のどちらでも NOT_VERIFIABLE になる。修正前は VERIFIED（RED）であること。
     - 選ばれていないタブを押すと、VERIFIED になる。`changedAttributes` に `tabindex` が含まれないこと。
     - focus で `focused` 属性が付くタブと、focus で `style.boxShadow` が変わるタブで、すでに選ばれているものを押すと、NOT_VERIFIABLE になる。修正前は VERIFIED（RED）であること。
     - `role` を持たない要素の属性の変化（例: `.active` のトグル、`aria-pressed` のない class のトグル）は、引き続き VERIFIED になる。

## 受け入れ条件

- 各項目で、修正前に RED、修正後に GREEN になる。
- 既存のテストは、すべて PASS する。
- `tests/integration/isolated-interaction.test.ts` を2回続けて実行し、2回ともすべて PASS する。
- `npm run verify` が PASS する。このサブタスクでは build を実行してよい。

## 報告

共通ルールの形式で、日本語で報告してください。
