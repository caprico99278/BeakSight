# C4b 指示書: 内側のスクロール領域を検出して、偽の COMPLETE を防ぐ

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: C4b
- 目的: html と body の両方がスクロールせず、内側の要素だけがスクロールするページ（アプリの外枠によくある構成）で、controlled scroll がスクロールしないまま `COMPLETE` を返すことを防ぐ。
- 背景: 作業記録置き場の `C4-report.md` の発見事項6。実装タスク指示 第9章（fake completion の禁止）。設計書 `doc/design/2026-09-23-beaksight-foundation-corrections-design.md` 5.1。
- 方針（設計者の判断）: 内側のスクロール領域まで追う処理は、今回は作らない。そうした領域があることを検出したら、`PARTIAL` と理由（例: `INNER_SCROLL_CONTAINER_NOT_TRAVERSED`）を返す。

同時に、ほかの実装者が C3（interaction）と C5（dom・color・layout の collector）を修正しています。担当範囲の外のファイルは変更しないでください。

## 変更してよいファイル

- `src/browser/controlled-scroll.ts`
- テスト: `tests/integration/controlled-scroll.test.ts`
- `fixtures/site/` への新しいページの追加（例: html と body が `overflow:hidden; height:100%` で、内側の div がスクロールし、その中に遅延読み込みの内容があるページ）

## 修正する内容

- 文書（`scrollingElement` または body）がスクロールできないと判断して `COMPLETE` を返そうとするときに、内側のスクロール領域があるかを調べる。
  - 対象は、可視で、`overflow-y` が `auto` または `scroll`、かつ `scrollHeight > clientHeight` の要素。
  - 走査は、上限付きで行う。上限は既存の上限値の考え方に合わせ、`src/core/limits.ts` か controlled-scroll の上限の定義に置く。上限に達した場合は、その事実を記録する。
- 内側のスクロール領域が見つかった場合は、`PARTIAL` と理由を返す。見つかった領域の数と、代表の1つの大きさ（`clientHeight`、`scrollHeight`）を観測に記録する。
- 内側のスクロール領域がなく、文書が本当にビューポートに収まっている場合は、これまでどおり `COMPLETE` を返す。
- 可視判定は、`src/evidence/visibility.ts` の `VISIBILITY_CHECK_OPTIONS` を `evaluate` の引数として渡し、`element.checkVisibility()` で行う。

## 受け入れ条件

- 内側の div がスクロールするページで、修正前は `COMPLETE` が返ることを RED として確かめ、修正後は `PARTIAL` になる。
- 短いページ（内容がビューポートに収まる）では、引き続き `COMPLETE` になる。
- `tests/integration/controlled-scroll.test.ts` の既存のテストと、`npm run typecheck` の担当範囲が PASS する。

## 報告

共通ルールの形式で報告してください。
