# C5 指示書: 可視判定と DOM の Evidence の修正

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: C5
- 目的: レビュー指摘 V4、V5（DOM の分）、V7（dom・color・layout の可視判定）、V9（dom・color の上限と切り捨ての記録）、V14 を修正する。
- 設計書: `doc/design/2026-09-23-beaksight-foundation-corrections-design.md` の 5.3、5.4（DOM の分）、5.5（dom・color・layout の分）、5.8（dom・color の分）、5.9（V14）
- 実装計画: `doc/design/2026-09-23-beaksight-foundation-corrections-implementation-plan.md` の C5
- レビュー記録（指摘の詳細と再現条件）: 作業記録置き場（`.superpowers/sdd/2026-08-27-beaksight-implementation-plan/`）の `task-06-10-review-2026-09-23.md`（V4、V5、V7、V9、V14）
- 共通部品: `doc/design/beaksight-shared-components.md`、`src/core/`（deadline・errors・guards・immutable・text・limits）、`src/evidence/visibility.ts`
- これまでの修正の報告: 作業記録置き場の `F01-report.md`、`F02a-report.md`、`F02b-report.md`、`F02c-report.md`、および `C4-report.md`（C4 で layout・color に収集位置の記録が加わっている）

同時に、ほかの実装者が C3（interaction）を修正しています。担当範囲の外のファイルは変更しないでください。

## 変更してよいファイル

- `src/evidence/dom-collector.ts`
- `src/evidence/color-collector.ts`
- `src/evidence/layout-collector.ts`（可視判定の置き換えだけ。重なりの候補や性能の修正は C6 が担当する）
- テスト: `tests/component/dom-collector.test.ts`、`tests/component/layout-collector.test.ts`、`tests/integration/layout-accessibility.test.ts`、および新規のテストファイル
- `fixtures/site/` への新しいページの追加

## 修正する内容

- **V7**（設計書 5.5）: dom・color・layout の可視判定を、`element.checkVisibility(VISIBILITY_CHECK_OPTIONS)` に統一する（オプションは `src/evidence/visibility.ts` の値を `evaluate` の引数として渡す）。祖先をたどって `visibility` を判定する処理（`layout-collector.ts:324-331`、`color-collector.ts:288-295` 付近）はなくす。大きさが0の要素は、可視判定とは別の事実として扱う。`aria-hidden` は可視判定に使わず、必要な collector が別の項目として記録する（DOM の可視テキストでは、`aria-hidden` の区画のテキストも、目に見えるなら可視テキストに含める。その区画が `aria-hidden` であることを別の項目で記録する）。再現条件: (A) `body{opacity:0}` で、DOM が本文を可視テキストとして返す。(B) 祖先が `visibility:hidden` で子が `visible` の場合に、layout と配色の標本が0件になる。(C) `<main aria-hidden="true">` の場合に、DOM と配色の扱いが食い違う。
- **V4**（5.3）: 可視テキストの区分で、どの landmark（header、nav、main、aside、footer、form）にも属さない可視テキストを「その他」の区分として保持する。`main` がないページで本文が落ちないことをテストで確かめる。再現条件: header と footer はあるが本文が `<div>` のページで、結果が `"Site Header Footer text"` だけになる。
- **V5（DOM の分）**（5.4）: 重複している `id` の値と件数を、上限付きで記録する。入力欄ごとに、`labels`、`aria-label`、`aria-labelledby`、`title` の有無を記録する（`dom-collector.ts:134-138` 付近。アクセシブルネームがあるかどうかの判定は Rule 側で行うので、collector は事実だけを記録する）。
- **V9（dom・color の分）**（5.8）: dom と color の collector で、上限により切り捨てた場合は、切り捨てた件数か印を Evidence に残す。
- **V14**（5.9）: 画像の Evidence に、解決済みのURL（`img.currentSrc` または `img.src`）を加える。

## 受け入れ条件

- 上の各項目について、修正前に RED になるテストを先に書き、修正後に GREEN になる。レビュー記録の「実測」の条件を、テストの入力に使う。
- 担当範囲の既存のテストと、`npm run typecheck` が PASS する。
- 変更した Evidence の形を、報告に一覧で示す（C8 で型を整えるときに使う）。

## 報告

共通ルールの形式で報告してください。各項目（例: Q1、V4）ごとに、RED と GREEN の結果を示してください。
