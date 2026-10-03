# F17b 実装報告（要約。設計者が保存）

## 結論

完了した。

- Interaction の時間の定数3つを、`src/core/limits.ts` に移した。値は変えていない。
- `src/interaction` から `src/config/validate-config.ts` への import は、なくなった。
- スキーマの `interactionTimeoutMs` の `minimum` を、1001 にした。この値が定数 + 1 と一致することは、定数を実行時に読んで比べるテストで確かめている。
- `npm run verify` は PASS した（41ファイル・1473件）。
