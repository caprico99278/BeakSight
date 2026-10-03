# F02c 実装報告（要約。設計者が保存）

## 結論

完了。担当範囲の重複実装を、F01 の共通部品に置き換えた。対象は `isRecord`、`deepFreeze`、数値の述語、`compareCodeUnits`、許可Originの正規化、http/https の判定、`sha256:` の書式。振る舞いは変えていない。

- 担当範囲の10ファイル・154件は、置き換えの前後とも PASS した。
- `npx vitest run tests/unit tests/component` は25ファイル・308件、passive-request-guard と context-factory は136件が PASS した。typecheck も PASS した。
- `request-policy.ts` の `canonicalPassiveAllowedOrigins` は、名前を残したまま、中身を委譲にした。

## 発見事項と、設計者の判断

1. `src/core/ids.ts:33` の `formatSequence` の検査は、`isNonNegativeSafeInteger` と同じ意味である。→ C8 で置き換える。
2. `tests/unit/normalize-url.test.ts:120-127` は、委譲にしたことで同じ関数どうしを比べる形になり、必ず PASS するテストになった。→ C1 で、固定の期待値との比較に書き直す。
3. `validate-config.ts` と `request-policy.ts` が `crawl/normalize-url.ts` に依存するようになった。→ URLの意味のowner に依存するのは設計どおりなので、許容する。

## 未実行項目

- `npm run build` と、統合テストの大部分。F02a・F02b とまとめたあとの全体の検証で確かめる。
