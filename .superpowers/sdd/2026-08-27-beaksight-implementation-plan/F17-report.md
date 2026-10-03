# F17 実装報告（要約。設計者が保存）

## 結論

完了した。

- `crawl.interactionTimeoutMs` に下限を設けた。1,000ms 以下は設定のエラーにする。下限は、安定性の確認と持続の確認の時間の和から導く。
- `changedAttributes` を上限で切り詰めた場合は、`changedAttributesTruncated: true` を記録するようにした。
- `npm run verify` は PASS した（41ファイル・1467件）。

## 発見事項と、設計者の判断

1. 時間の定数を `src/config/validate-config.ts` に置いた。そのため、`src/interaction` が設定の検証のモジュールを参照する形になっている。
   → 設計者の指示書の漏れ（`src/core/limits.ts` を変更してよいファイルに含めていなかった）が原因である。F17b で `src/core/limits.ts` に移す。
2. 下限には、決まった長さを持つ時間だけを含めた。→ 承認する。
3. `run.schema.json` の `interactionTimeoutMs` の下限が、設定の検証と食い違っている。→ F17b でそろえ、一致を確かめるテストを加える。
4. 持続の確認は、上限で切り詰めた後の名前どうしで比べている。→ 許容する。fail-closed の方向にしか働かず、切り捨ての印も残る。
5. テストの `configFor` が、下限より短い値を使っている。→ 許容する。validateConfig を通らないテストの設定だからである。
6. 設計書と台帳の更新。→ 設計者が行う。
