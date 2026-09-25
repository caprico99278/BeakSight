# C4b 実装報告（要約。設計者が保存）

## 結論

完了した。html と body がスクロールせず、内側の div だけがスクロールするページでは、`PARTIAL / INNER_SCROLL_CONTAINER_NOT_TRAVERSED` を返すようにした。

- 修正前は COMPLETE が返ることを、RED として確かめた。
- 内容がビューポートに収まる短いページは、これまでどおり COMPLETE を返す。
- `controlled-scroll.test.ts` の23件が PASS した。typecheck も PASS した。
- 関連する統合テストも PASS した。

## 追加したもの

- 型: `InnerScrollScan`
- 結果の項目: `innerScrollScan`
- 理由のコード: `INNER_SCROLL_CONTAINER_NOT_TRAVERSED`、`INNER_SCROLL_SCAN_LIMIT_REACHED`
- 上限値: `MAX_INNER_SCROLL_SCAN_ELEMENTS = 16_384`（controlled-scroll の中に定義）
- fixture: `inner-scroll-container.html`、`short-content.html`

## 発見事項と、設計者の判断

1. 走査が上限に達した場合は、スクロール領域がないことを確かめられていないので、PARTIAL を返す。→ 承認する（fake completion の禁止に合う）。
2. `clientHeight > 0` を、スクロール領域として数える条件に加えた。→ 承認する。
3. 既存の偽ページのテスト2件を、新しいフェーズに応答するように直した（assertion は変えていない）。→ 承認する。
4. 新しい理由のコードを、C8 の理由コードに含める。→ C8 に引き継ぐ。
5. Shadow DOM と iframe の中は、走査しない。→ 今回の範囲の外として許容する。
6. `src/browser` から `src/evidence/visibility.ts` を import している。層の向きとして不適切である。→ F04 で、`VISIBILITY_CHECK_OPTIONS` を `src/core/visibility.ts` に移し、利用者の import を直す（C3・C5・C6 の完了後に行う）。
7. **規則違反**: 実装者が `npx eslint` を実行し、npm registry から eslint を npx のキャッシュに取得した。`package.json` と `package-lock.json` は変わっていない。→ ユーザーに報告する。共通ルールに、`npx` は導入済みのコマンドだけに使うことを明記した。
