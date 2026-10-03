# DEF-002 指示書: Evidence の ID の接頭辞の表が、Object の既定のプロパティ名を受け付ける不具合

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: DEF-002（既存不具合の修正）
- 不具合台帳: 作業記録置き場の `defects.md` の DEF-002

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。不具合がいつから存在したかを確かめるために、HEAD に戻すことも禁止です。

同時に、別の実装者（P14c）が、`src/orchestration/page-auditor.ts` と、その統合テストを新しく作っています。担当のファイル以外は変更しないでください。

## 変更してよいファイル

- `src/core/ids.ts`
- `tests/unit/core-contracts.test.ts`（ID の生成のテストがある場合）か、新しく作る `tests/unit/ids.test.ts`
- 同じ形の不具合が、`src/core/` のほかの表にもある場合は、そのファイルとテスト（見つけたら、直す前に報告に書く）

## 修正する内容

1. まず、不具合を再現するテストを書き、RED を確かめる。
   - 対象は、`createEvidenceId('constructor' as EvidenceType, 1)` と `'toString'`、`'__proto__'`。
   - 期待する結果は、`RangeError` になること。
2. 最小の修正で、GREEN にする。
   - 表の引き方を、`Object.hasOwn` で確かめる形にする。または、`EVIDENCE_TYPES` に含まれるかで確かめる。
3. `src/core/` と `src/safety/` の中で、実行時の文字列でオブジェクトの表を引いている箇所を探す。
   - 同じ形の不具合があれば、同じ方法で直し、テストを加える。
   - 探した範囲と結果を、報告に書く。

## 受け入れ条件

- 修正前に RED、修正後に GREEN になる。
- 既存のテストは、すべて PASS する。
- `npm run typecheck` と、担当のテストが PASS する。
- `npm run verify` は実行しない（並行作業のため）。

## 報告

共通ルールの形式で、日本語で報告してください。
