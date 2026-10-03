# F19 指示書: 押したことで変わる、tooltip や入力の種類の属性を根拠にしない

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: F19
- 目的: 確認のレビュー R7 の Important-1 と Minor-3 を直す。
- 設計書: `doc/design/2026-09-23-beaksight-foundation-corrections-design.md` の 4.4.1（「根拠にしない属性」）
- レビューの結果: 作業記録置き場の `R7-review-result.md`

このサブタスクは単独で実行します。

## 変更してよいファイル

- `src/evidence/interaction-collector.ts`
- `src/interaction/discover-candidates.ts`、`src/interaction/isolated-auditor.ts`（必要な場合に限る）
- テスト: `tests/integration/isolated-interaction.test.ts`
- `fixtures/site/` への新しいページの追加

## 修正する内容

1. **根拠にしない属性（Important-1）**
   - 名前を付けた定数 `INTERACTION_NON_EVIDENCE_ATTRIBUTES` を、1か所に定義する。
     - 置き場所は `src/evidence/interaction-collector.ts` とする。ほかの場所が適切なら、その理由を報告する。
     - 値は、設計書 4.4.1 の一覧のとおりにする。
   - これらの属性の変化は、`attributes` の根拠にしない。
   - `changedAttributes` に残すかどうかは、実装者が決めて報告する。
     - 根拠にしない属性であることが、Evidence から分かる形にすること。
     - 例: 根拠にした属性と、根拠にしなかった属性を、分けて記録する。
     - 型やスキーマの変更が必要な場合は、止まって報告する。
2. **回帰テスト**（レビューの再現の条件を fixture にする）
   - 次の3つの形で、何もしないボタンが NOT_VERIFIABLE になることを確かめる。修正前に VERIFIED（RED）、修正後に NOT_VERIFIABLE になること。
     - Radix Tooltip の形: hover で `data-state="delayed-open"` と `aria-describedby` が付き、pointerdown で閉じる。
     - tippy.js の形: mousedown で `aria-describedby` が外れる。
     - React Aria の形: プログラムから focus すると `data-focus-visible` が付き、pointerdown で外れる。
   - Radix のアコーディオンの形では、VERIFIED になることを確かめる。この形では、`data-state` と `aria-expanded` が一緒に変わる。
   - 既存の、何かが起きる部品のテストは、すべて PASS のままであること。
3. **Minor-3**
   - 持続の確認で `attributes` が根拠から外れた場合は、`changedAttributesTruncated` を false にする。型の説明（`evidence-types.ts:1269-1273` 付近）との食い違いをなくすためである。

## 受け入れ条件

- 各項目で、修正前に RED、修正後に GREEN になる。
- `tests/integration/isolated-interaction.test.ts` を2回続けて実行し、2回ともすべて PASS する。
- `npm run verify` が PASS する。このサブタスクでは build を実行してよい。

## 報告

共通ルールの形式で報告してください。
