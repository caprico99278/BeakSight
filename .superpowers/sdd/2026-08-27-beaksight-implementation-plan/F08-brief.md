# F08 指示書: 再レビュー R4 の指摘の修正（スクロールの対象、form の外の入力欄、ほか）

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: F08
- 目的: 基盤修正の後の再レビュー R4 で見つかった Important 2件と Minor 3件を直す。あわせて、前回の V13 を直す。
- レビューの結果: 作業記録置き場の `R4-review-result.md`
- 前回の V13: 作業記録置き場の `task-06-10-review-2026-09-23.md`

このサブタスクは単独で実行します。

## 変更してよいファイル

- `src/browser/controlled-scroll.ts`
- `src/evidence/dom-collector.ts`、`src/evidence/accessibility-collector.ts`、`src/evidence/layout-collector.ts`
- `src/core/evidence-types.ts`、`src/core/contracts.ts`（理由のコードを加える場合）、`schemas/page.schema.json`、`schemas/run.schema.json`（理由のコードを加える場合）
- テスト: 上のファイルに対応するテスト、`tests/component/context-factory.test.ts`（V13 のテストの追加だけ）、`tests/unit/schema-validator.test.ts`、`tests/unit/core-contracts.test.ts`
- `fixtures/site/` への新しいページの追加

## 修正する内容

1. **N1（偽の COMPLETE。設計書 5.1）**
   - スクロールの対象の決め方を改める。
     - 候補は、文書（`scrollingElement`）、body、内側のスクロール領域（上限付きの走査。C4b の走査を使う）とする。
     - スクロールできる量（`scrollHeight - clientHeight`）が最も大きい候補を選ぶ。
   - 最も大きい候補が文書か body なら、その要素をたどる。
   - 最も大きい候補が内側の領域なら、その領域はたどらず、`PARTIAL / INNER_SCROLL_CONTAINER_NOT_TRAVERSED` を返す。
   - 再現の2つの場合を、fixture に加える。
     - (1) `html{height:100%;overflow:hidden}`・`body{height:100%;overflow:auto}` で、body の余白が既定（8px）のまま、中に高さ 5000px の div があるページ。body をたどって最下部まで達すること。
     - (2) body の余白が既定のまま、`<div style="height:100vh;overflow:auto">` の中に高さ 5000px の要素があるページ。PARTIAL になること。
   - どちらも、修正前は COMPLETE になる（RED）ことを確かめる。
   - 既存の fixture（余白が0のもの）のテストが、引き続き PASS すること。
2. **N2（設計書 5.4）**
   - 入力欄を、`document.forms` の中だけでなく、form に属さない入力欄（`input`、`select`、`textarea`）も、上限付きで記録する。
   - 入力欄ごとに、可視判定の結果（`checkVisibility` と `VISIBILITY_CHECK_OPTIONS`）を記録する。
   - form に属さない入力欄の置き場所（例: `unassociatedFields`）と、切り捨ての件数は、型とスキーマに加える。
   - `<div><input required type=email></div>` が記録されることを確かめる（修正前に RED、修正後に GREEN）。
3. **M1（設計書 5.2）**
   - DOM と accessibility の Evidence に、収集した時点の `scrollPosition` を加える。
   - 型とスキーマもあわせて直す。
4. **M2**
   - layout で、比較回数の上限（`overlapComparisonLimitReached`）に達した場合は、`PARTIAL` と理由（例: `LAYOUT_COMPARISON_LIMIT_REACHED`）を返す。
   - DOM の走査で、ノード数の上限に達したことを表す印と、文字数による切り詰めの印を、別の項目に分ける。
5. **M3**
   - layout の重なりの候補を集めるとき、祖先の overflow（`hidden`、`clip`、`scroll`、`auto`）による切り取りを考慮する。
   - 切り取った後に見える面積が0の要素は、候補から除く。
   - 祖先の走査は、`MAX_SELECTOR_DEPTH` などの既存の上限の範囲に限る。
   - 高さ0で overflow が hidden の要素の中にある要素が、候補に入らないことを確かめる。
6. **V13**
   - `tests/component/context-factory.test.ts` に、実ブラウザで次の2つを確かめるテストを加える。
     - Service Worker の登録が遮断されること（fixture の `service-worker.html`）。
     - locale と timezone が、ブラウザの中で実際に効いていること（`navigator.language` と `Intl.DateTimeFormat().resolvedOptions().timeZone`）。
   - production のコードの変更が必要になった場合は、止まって報告する。

## 受け入れ条件

- 各項目で、修正前に RED、修正後に GREEN になる。
- `npm run verify` が PASS する（このサブタスクでは build を実行してよい）。

## 報告

共通ルールの形式で報告してください。変更した Evidence の形を一覧にしてください。

## 追加の指示（F07 の報告を受けて）

変更してよいファイルに、次のファイルを加える。

- `src/crawl/discover-links.ts`
- `src/evidence/screenshot-collector.ts`
- `src/browser/context-factory.ts`（44行目付近のチェックだけ）
- テスト: `tests/component/dom-collector.test.ts`、`tests/component/discover-links.test.ts`、`tests/integration/screenshot-collector.test.ts`

このとき、F06b が同時に `src/interaction/*` と `tests/integration/isolated-interaction.test.ts` を変更している。これらは変更しないこと。

7. **Link の入口を1つにする**（実装タスク指示 4.2「No Parallel Entry Points」）
   - F07 で、`discoverLinks()`（`readonly LinkEvidence[]` を返す薄い関数）と `discoverLinkEvidence()`（`LinkDiscoveryEvidence` を返す）の2つの入口ができている。
   - これを1つにまとめる。正式な入口 `discoverLinks()` が `LinkDiscoveryEvidence`（`{links, omittedLinkCount}`）を返すようにし、`discoverLinkEvidence()` は削除する。
   - 利用者はすべて直す。対象は、`src/**` の利用者、`tests/component/dom-collector.test.ts:51` 付近、`tests/component/discover-links.test.ts`。
   - `grep` で `discoverLinkEvidence` が残っていないことを確かめる。
8. **DOM の Evidence のリンクの切り捨て**
   - `DomTruncationEvidence` に、リンクの切り捨ての件数（`omittedLinkCount`）を加える。
   - DOM の Evidence に渡した Link の結果の `omittedLinkCount` を、そのまま記録する。
   - 型とスキーマも直す。
9. **スクリーンショットの viewport の型**
   - `ScreenshotEvidence.viewport` を `ViewportProfile` にする。
   - `screenshot-collector.ts` と、型・スキーマもあわせて直す。
10. **context-factory のチェック**
    - `src/browser/context-factory.ts:44` 付近で、ビューポートの値を「正の有限の数」として確かめている。これを `isPositiveSafeInteger` に直す。
    - 小数のビューポートが拒否されることを確かめる。修正前に RED、修正後に GREEN になること。
