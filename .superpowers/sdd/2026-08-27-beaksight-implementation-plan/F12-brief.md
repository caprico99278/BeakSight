# F12 指示書: スキーマの enum と TypeScript の値の一覧を1か所にそろえる

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: F12
- 目的: スキーマ（`schemas/*.json`）の enum と、TypeScript の型の値の一覧が、手で写した別々の定義になっている箇所を、1つの定義にそろえる（SSOT）。そのうえで、一致を1つのテストでまとめて確かめる。
- 背景: 作業記録置き場の `F11-report.md` の発見事項3。該当する箇所の一覧も、そこにある。

このサブタスクは単独で実行します。

## 変更してよいファイル

- `src/core/evidence-types.ts`、`src/core/contracts.ts`
- `src/browser/controlled-scroll.ts`（`SCROLL_TARGETS` の重複をなくすことと、下の項目3に限る）
- 各 collector と、`src/interaction/*`、`src/safety/interaction-policy.ts`（値の配列を core から import するように置き換えるだけ。処理は変えない）
- `schemas/*.json`（値を変えない。下の項目3の追加だけは可）
- テスト: `tests/unit/core-contracts.test.ts`、`tests/unit/schema-validator.test.ts`、新しいテストファイル（例: `tests/unit/schema-enum-consistency.test.ts`）、`tests/integration/controlled-scroll.test.ts`（項目3）

## 修正する内容

1. **値の一覧を1か所にそろえる**
   - `F11-report.md` の発見事項3の一覧にある型を、`src/core/` の `as const` の凍結した配列から導く形にする。一覧にない型でも、スキーマに enum がある型は、同じように扱う。
   - collector などに同じ値の配列がある場合は、core の配列を import する。値の配列を2か所に書かない。例えば、`controlled-scroll.ts:47` の `SCROLL_TARGETS` がこれに当たる。
   - 値は変えない。振る舞いも変えない。
2. **一致をまとめて確かめるテスト**
   - スキーマの各 enum と、対応する core の配列が一致することを確かめるテストを、1つのファイルにまとめる。
   - 対応表（スキーマの JSON Pointer と、TypeScript の配列の名前）をテストの中に置く。
   - あわせて、スキーマの中の enum のうち対応表に載っていないものがあれば、テストを失敗させる。スキーマを走査して見つける。これは、今後 enum を増やしたときに、対応づけを忘れないためである。
   - このテストは、ファイルを読むのを1回だけにし、1秒以内に終わるようにする（設計書 UI追補 第6章の速さの要件と同じ考え方）。
3. **スクロールの対象を切り替えた回数**
   - scroll の Evidence に、対象を切り替えた回数（例: `targetSwitchCount`）を加える。型、スキーマ、controlled-scroll を直す。
   - 切り替えが起きる fixture（`body-scroll-late-growth.html`）で、1が記録されることを確かめる。

## 受け入れ条件

- 対応表のすべての組で、スキーマの enum と core の配列が一致する。対応表の外に enum が残っていない。
- 値の配列が、`src/` の中で2か所に書かれていない。`grep` で確かめて報告する。
- 項目3は、修正前に RED、修正後に GREEN になる。
- `npm run verify` が PASS する（このサブタスクでは build を実行してよい）。一致のテストの所要時間を報告する。

## 報告

共通ルールの形式で報告してください。対応表の件数と、core に新しく置いた配列の一覧を書いてください。
