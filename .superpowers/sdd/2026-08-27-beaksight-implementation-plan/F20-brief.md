# F20 指示書: 根拠にしない名前の決まりと、tab に下準備の focus をしないこと

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: F20
- 目的: 確認のレビュー R8 の Important-1 と Important-2 を直す。
- 設計書: `doc/design/2026-09-23-beaksight-foundation-corrections-design.md` の次の箇所
  - 4.4.1: 「根拠にしない属性」の追加分と、「focus をしない要素と、focus による状態の変化」
  - 4.4.2: 手順4
- レビューの結果: 作業記録置き場の `R8-review-result.md`

このサブタスクは単独で実行します。

## 変更してよいファイル

- `src/evidence/interaction-collector.ts`
- `src/interaction/isolated-auditor.ts`
- `src/interaction/discover-candidates.ts`
- テスト: `tests/integration/isolated-interaction.test.ts`
- `fixtures/site/` への新しいページの追加と、`non-evidence-attribute-buttons.html` への追記

## 修正する内容

1. **Important-1: 根拠にしない名前**
   - `INTERACTION_NON_EVIDENCE_ATTRIBUTES` に、`data-headlessui-state` を加える。
   - 名前を付けた定数 `INTERACTION_NON_EVIDENCE_NAME_PATTERN` を、1か所に定義する。
     - 名前に `focus` か `hover` を含むことを判定する。大文字と小文字は区別しない。
     - 置き場所は、同じ `interaction-collector.ts` とする。
   - この決まりを、次の2つに当てはめる。
     - `data-*` 属性の名前: 当てはまる属性の変化は、根拠にしない。
     - class の中の名前: 当てはまる名前の増減は、根拠にしない。
   - `active` を含む class の名前（例: `.active`、`is-active`）は、引き続き根拠にする。
   - 回帰テストとして、次の2つの形の何もしないボタンが、NOT_VERIFIABLE になることを確かめる。修正前は VERIFIED（RED）であること。
     - Headless UI v2 の形: `data-headlessui-state` が、focus の後に `"hover focus"`、pointerdown の後に `"hover"` になる。
     - MUI の形: focus で `Mui-focusVisible` の class が付き、pointerdown で外れる。
   - `.active` の class を切り替えるトグルは、VERIFIED のままであることを確かめる。
2. **Important-2: tab に下準備の focus をしない**
   - 下準備の手順4では、`role="tab"` を明示した要素（`getAttribute('role')` の値を空白で分けたときに `tab` を含むもの）には、focus をしない。hover はする。
   - それ以外の要素では、focus の前後で、対象の ARIA の状態と `aria-controls` の先の表示の状態を比べる。
     - 変わった場合は、NOT_VERIFIABLE にして、凍結せずに終える。
     - 理由は、名前を付けた定数にし、区別できる文字列にする（例: `Target state changed on focus during preparation`）。
     - 比べるための読み取りの作業量は、共有の上限から差し引く。比べられない場合は、fail-closed で NOT_VERIFIABLE にする。
   - 回帰テストでは、次の3つを確かめる。
     - 自動で切り替わる形のタブ（`role="tab"`、onFocus で `aria-selected` と、`aria-controls` の先の表示を切り替える）が、VERIFIED になること。修正前は NOT_VERIFIABLE（RED）であること。
     - 手動で切り替わる形のタブも、VERIFIED のままであること。
     - `role` を持たないのに、focus で `aria-expanded` が変わるボタンは、上の理由の NOT_VERIFIABLE になること。
   - 凍結の順序（下準備、handle の破棄、凍結）、BLOCKED の優先、fail-closed は、変えない。

## 受け入れ条件

- 各項目で、修正前に RED、修正後に GREEN になる。
- 既存のテストは、すべて PASS のまま。
- `tests/integration/isolated-interaction.test.ts` を2回続けて実行し、2回ともすべて PASS する。
- `npm run verify` が PASS する。このサブタスクでは build を実行してよい。

## 報告

共通ルールの形式で報告してください。
