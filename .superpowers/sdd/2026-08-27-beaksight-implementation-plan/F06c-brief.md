# F06c 指示書: passive-request-guard のテストの偽の handle に scrollIntoViewIfNeeded を加える

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: F06c
- 目的: F06b で、Interaction の凍結の前に対象を画面内へスクロールする下準備を加えた。これにより、`tests/integration/passive-request-guard.test.ts` の2件（`drains deferred download/popup cleanup failure into the final interaction audit snapshot`）が FAIL するようになった。この2件を直す。
- 原因: このテストの偽の `elementHandle`（1829行目付近）に `scrollIntoViewIfNeeded` がない。そのため下準備のスクロールが失敗し、audit が早く終わる。その結果、click が行われず、ダウンロードとポップアップも起きない。
- 背景: 作業記録置き場の `F06b-report.md`

同時に、ほかの実装者（F08）が `src/browser/controlled-scroll.ts`、`src/browser/context-factory.ts`、`src/evidence/*`、`src/crawl/discover-links.ts`、`src/core/*`、`schemas/*`、`tests/component/context-factory.test.ts` などを変更しています。これらは変更しないでください。

## 変更してよいファイル

- `tests/integration/passive-request-guard.test.ts`（偽の handle の定義の修正だけ）

## 修正する内容

- 偽の `elementHandle` に、`scrollIntoViewIfNeeded: async () => undefined,` を加える。
- テストが確かめている意図は、変えない。意図とは、凍結の後の後片付けの失敗を、最終の snapshot に残すことである。修正の後は、click・ダウンロード・ポップアップが、修正前の意図どおりに起きていることを、テストの expect で確かめる。
- ほかにも、このファイルの偽の handle で同じ原因によって失敗するものがあれば、同じように直す。

## 受け入れ条件

- `npx vitest run tests/integration/passive-request-guard.test.ts` がすべて PASS する。
- expect を変えていない。

## 報告

共通ルールの形式で報告してください。
