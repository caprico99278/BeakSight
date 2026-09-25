# F18 指示書: R6 の指摘の修正（期限の数え始め、CSS の変数、class の名前ごとの比較、ほか）

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: F18
- 目的: 確認のレビュー R6 の指摘を直す。対象は、Important の I-1・I-2 と、Minor の M-2・M-3・M-4 である。
- 設計書: `doc/design/2026-09-23-beaksight-foundation-corrections-design.md` の 4.4.1（R6 を受けて追加した項目）
- レビューの結果: 作業記録置き場の `R6-review-result.md`

このサブタスクは単独で実行します。

## 変更してよいファイル

- `src/interaction/isolated-auditor.ts`、`src/interaction/discover-candidates.ts`
- `src/evidence/interaction-collector.ts`
- `src/core/limits.ts`（コメントの修正に限る）
- `src/core/evidence-types.ts`、`schemas/page.schema.json`（`<details>` の前後の値を Evidence に残す変更に限る）
- テスト: `tests/integration/isolated-interaction.test.ts`、`tests/integration/passive-request-guard.test.ts`、`tests/unit/schema-validator.test.ts`、`tests/unit/core-contracts.test.ts`
- `fixtures/site/` への新しいページの追加

## 修正する内容

1. **I-2: 期限の数え始め**
   - Interaction の期限（`timeoutMs`）は、隔離された Context での読み込みと初期描画が終わった時点から数え始める。
   - 読み込み（`goto`）には、別の期限を使う。呼び出す側から渡される値か、設定の `navigationTimeoutMs` を使う。どこから受け取るかは、今の `auditInteraction` の入力を確かめて決め、報告する。入力を変える必要があり、そのために `src/**` のほかのファイルの変更が必要になる場合は、止まって報告する。
   - 読み込みの期限切れは、これまでどおり区別できる理由で NOT_VERIFIABLE にする。
   - 再現の条件を fixture にする。画像を1.8秒遅らせて load を遅くしたページで、class を切り替えるボタンを使う。修正前は NOT_VERIFIABLE になる（RED）こと、修正後は VERIFIED になることを確かめる。画像を遅らせる仕組みがなければ、fixture サーバの既存の遅延の仕組みか、ページの中の方法で load を遅らせる。
2. **I-1: CSS の変数だけの style の変化**
   - style 属性の変化が、CSS のカスタムプロパティ（`--` で始まる名前）の追加・変更・削除だけの場合は、根拠にしない。
   - style の宣言を分解して比べる。分解できない場合は、今の比べ方を使う（fail-closed の方向で扱う）。
   - pointerdown で `style.setProperty('--rp-start', …)` を実行し、class を225ms後に外すページで確かめる。修正前は VERIFIED（RED）、修正後は NOT_VERIFIABLE になること。
   - click で `width` などの通常のプロパティを変えるボタンは、引き続き VERIFIED になることを確かめる。
3. **M-2: class の名前ごとの比較**
   - 安定性の確認で、class の中の名前ごとに、変わったかどうかを記録する。
   - click の後の比較でも、名前ごとに比べる。安定していた名前が増えたり減ったりした場合は、根拠にする。
   - タイマーが別の class の名前を切り替えている要素の上のトグルで確かめる。修正前は NOT_VERIFIABLE（RED）、修正後は VERIFIED になること。
4. **M-3: 理由の整形**
   - LRM（U+200E）、RLM（U+200F）、ALM（U+061C）と、孤立したサロゲートを取り除く。
5. **M-4: `<details>` の開閉の前後の値**
   - click の前後の `open` の値を、Interaction の Evidence に残す。
   - 型とスキーマを直す。
   - `limits.ts:47-53` のコメントを、定数がこのファイルにある現状に合わせて直す。

## 受け入れ条件

- 各項目で、修正前に RED、修正後に GREEN になる。
- R6 のレビューで VERIFIED になった部品と、NOT_VERIFIABLE になった何もしないボタンの結果が、変わらないこと。既存のテストで確かめる。
- `tests/integration/isolated-interaction.test.ts` を2回続けて実行し、2回ともすべて PASS する。
- `npm run verify` が PASS する（このサブタスクでは build を実行してよい）。

## 報告

共通ルールの形式で報告してください。
