# RT12b 指示書: Cross-page rule と Rule Engine の修正、テストの追加

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: RT12b
- 目的: 独立レビュー RT12 の I4・I5・M7・M8・M9 を直す。
- 設計書: `doc/design/2026-09-23-beaksight-task-12-13-rules-design.md` 第7章（RT12 を受けて加えた項目）、第6章
- レビューの結果: 作業記録置き場の `RT12-review-result.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

同時に、別の実装者（RT12a）が layout の collector と Rule、`src/core/evidence-types.ts`、`schemas/page.schema.json`、`tests/unit/schema-validator.test.ts` を作業しています。担当のファイル以外は変更しないでください。

## 変更してよいファイル

- `src/audit/cross-page-rules.ts`、`src/audit/rule-engine.ts`、`src/audit/rule-catalog.ts`、`src/audit/rule-helpers.ts`、`src/audit/technical-rules.ts`
- `schemas/finding.schema.json`
- テスト: `tests/component/cross-page-rules.test.ts`、`tests/component/rule-engine.test.ts`、`tests/component/technical-rules.test.ts`、`tests/unit/rule-helpers.test.ts`
- 新規: `tests/unit/finding-schema.test.ts`（finding のスキーマの検証のテストが必要な場合に限る）

## 修正する内容

1. **I4 1つの事実から1つの Finding**
   - `TARGET_NAVIGATION_FAILED` は、リンク先の `navigationOutcome` が `FAILED` の場合だけにする。
   - `TIMEOUT` は `NAVIGATION_TIMEOUT` だけで扱い、`BLOCKED_EXTERNAL_REDIRECT` は `UNEXPECTED_ORIGIN_REDIRECT` だけで扱う。
   - `navigationOutcome` が null の場合（スキップ）は、Finding にしない。
   - テストで、次のことを確かめる。修正前に RED、修正後に GREEN になること。
     - 外部の SSO にリダイレクトする `/login` へのリンクで、`TARGET_NAVIGATION_FAILED` ができない。
     - 期限切れのリンク先で、`TARGET_NAVIGATION_FAILED` ができない。
2. **I5 technical の Rule のビューポート**
   - technical の Rule が、別のビューポートの Evidence から Finding を作らないことを確かめるテストを加える。
   - テストは、次の2つの入力で確かめる。
     - desktop の入力に、mobile の Evidence を混ぜる。
     - mobile の入力で、desktop の Evidence だけを渡す。
   - `evidenceOfType` の代わりに、種類だけで絞る実装にした場合に、テストが失敗することを確かめる（RED の確認）。
3. **M7 `DUPLICATE_CANONICAL`**
   - canonical が自分自身かどうかは、`pageUrl` と、各ビューポートの正規化した最終URLの両方で比べる。
   - `/p` と `/p?ref=a` がどちらも `/p/` にリダイレクトし、`/p/` が自分自身を canonical にしているとき、WARN にならないことを確かめる。修正前に RED、修正後に GREEN になること。
4. **M8 検査**
   - `materializeFindingDrafts` で、下書きの `ruleVersion` と `category` が、持ち主の Rule の定義と一致するかを検査する。
     - 必要なら、`FindingDraftOwner` に `version` と `category` を加える。
     - 一致しない下書きは、その Rule の失敗とする。
   - `CROSS_PAGE_RULES` を、`freezeCatalog` と同じ検査にかける。検査するのは、ruleId の重複、`ruleIdPrefix`、Page rule との ruleId の衝突である。
     - 同じ検査を、2か所に書かない。
5. **M9**
   - `schemas/finding.schema.json` の `evidenceRefs` に、`minItems: 1` を加える。空の配列が拒否されることを、テストで確かめる。
   - HTTP のステータスの範囲の定数（`technical-rules.ts` と `cross-page-rules.ts` にあるもの）を、`rule-helpers.ts` の1か所にまとめる。

## 受け入れ条件

- 各項目で、修正前に RED、修正後に GREEN になる。
- 既存のテストは、すべて PASS する。変わってよい出力は、修正の対象の Finding だけである。
- `npm run typecheck` と、担当のテストが PASS する。
- build と verify は実行しない（並行作業のため）。

## 報告

共通ルールの形式で、日本語で報告してください。
