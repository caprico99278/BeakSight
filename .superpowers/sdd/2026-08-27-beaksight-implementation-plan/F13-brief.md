# F13 指示書: 最後の確認のレビュー R''2 の指摘の修正

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: F13
- 目的: 最後の確認のレビュー R''2 で見つかった指摘を直す。対象は、Important の I-1 と、Minor の m2・m3（コメント）・m4 である。
- レビューの結果: 作業記録置き場の `Rpp2-review-result.md`

## 変更してよいファイル

- `src/config/validate-config.ts`
- `src/core/evidence-types.ts`（m3 のコメントの修正と、m4 の型の追加）
- `src/evidence/dom-collector.ts`（m4）
- `schemas/page.schema.json`
- テスト: `tests/unit/config.test.ts`、`tests/unit/schema-validator.test.ts`、`tests/unit/core-contracts.test.ts`、`tests/unit/schema-enum-consistency.test.ts`、`tests/component/dom-collector.test.ts`

## 修正する内容

1. **I-1（locale と timezone の検証）**
   - 設定の検証が、Chromium（Playwright）が受け付けない値を拒否するようにする。
   - timezone は、次の2つを満たす場合だけ受け付ける。
     - IANA の名前の形であること。`+09:00`・`-0530` のようなオフセットの形は拒否する。
     - `new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone` が、入力と大文字・小文字まで一致すること。`asia/tokyo` は、ここで拒否される。
   - locale は、次の3つを満たす場合だけ受け付ける。
     - `Intl.getCanonicalLocales(locale)[0]` が、入力と一致すること。
     - `und` ではないこと。
     - 言語の部分があること。
   - レビューの反例（timezone の `+09:00`・`-0530`・`asia/tokyo`、locale の `und`）が拒否されることを、テストで確かめる。修正前に RED、修正後に GREEN になること。
   - 既定値（`ja-JP`、`Asia/Tokyo`）と、代表的な正しい値（`en-US`、`de-CH`、`Pacific/Auckland`、`UTC`）が受け付けられることも確かめる。
   - 可能なら、実際の Chromium で、受け付けた値で Context と page を作れることを確かめる component テストを1件加える。そのテストは `setContent` だけを使う。
2. **m2（Evidence の ID の接頭辞）**
   - `page.schema.json` の Evidence の各分岐（`oneOf`）で、`evidenceId` の pattern を、その種類の接頭辞に限る。例えば、scroll なら `^EV-SCROLL-`。
   - 接頭辞の値は、`src/core/ids.ts` の対応と一致させる。
   - 一致を確かめるテストを加える。テストは、`ids.ts` の対応を実行時に読み、スキーマの pattern と比べる。
   - 種類と接頭辞が合わない Evidence（例: `type:"scroll"` で `EV-DOM-000001`）をスキーマが拒否することを、テストで確かめる。
3. **m3（コメント）**
   - `src/core/evidence-types.ts:105` 付近のコメントに、`tests/unit/schema-enum-consistency.test.ts` を加える。
4. **m4（canonical の切り詰め）**
   - DOM の Evidence で、文書の項目（title、description、canonical、lang）ごとに、切り詰めたかどうかの印を持たせる。
   - これまでの共通の印（`truncation.documentFields`）を残すか、項目ごとの印に置き換えるかは、実装者が決めて報告する。どちらの場合も、型とスキーマを一致させる。
   - 長すぎる canonical の URL を持つページで、canonical の印が立つことを確かめる。

## 受け入れ条件

- 各項目で、修正前に RED、修正後に GREEN になる（m3 はコメントだけなので、テストは不要）。
- `npm run verify` が PASS する（このサブタスクでは build を実行してよい）。

## 報告

共通ルールの形式で報告してください。
