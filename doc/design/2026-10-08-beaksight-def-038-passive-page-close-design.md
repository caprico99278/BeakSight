# BeakSight DEF-038 Passive のページを閉じるときの送信の漏れ 修正設計書

- 状態: 設計者の設計（2026-10-08）。修正の後に独立レビューを受ける（安全の不変条件に関わるため必須）。
- 関係する文書: DEF-036 の設計書（`2026-10-08-beaksight-def-036-frozen-popup-design.md`。同じ仕組み）、DEF-005・DEF-006（page を閉じる処理の期限）、CC-018（閉じる手順の1か所）、不具合台帳の DEF-038

## 1. 起きていること

- `closePassivePageAndContext` は、Guard の付いたページを `page.close()` で先に閉じ、その後に Context を閉じる。ページを閉じると、ページの `pagehide`・`visibilitychange`・`unload` の処理が動き、`navigator.sendBeacon` と keepalive の `fetch` の POST が出る。Playwright は、閉じ始めたページの要求で Context の route の処理を呼ばないので、Guard は止めも記録もできず、要求はサーバに届く（DEF-036 と同じ仕組み）。
- Context だけを閉じる（`Target.disposeBrowserContext`）場合は、同じ送信が届かなかった（レビュー担当と設計者の実験で計 8 回中 0）。

## 2. 決めたこと

- Guard の付いた Passive のページを、個別に `page.close()` で閉じない。`closePassivePageAndContext` は、Context を閉じる（ページは Context と一緒に閉じる）。ページの引数は、呼び出し側の互換のために受けてよいが、閉じる手順には使わない（使わなくなるなら、引数ごと整理してよい。呼び出し側の形の直しは範囲に含める）。
- factory の持ち物の記録（`#ownedPages`）は、Context を閉じたときに、その Context のページを外す。
- `closePassiveGuardedPage`（Guard）と `closePassivePage`（factory）は、使う箇所がなくなる。除くか、残すなら「Guard の付いたページを個別に閉じると、ページを離れるときの送信が Guard を通らずに出る（DEF-038）。使わない」とコメントに書く。どちらにするかは、Architecture Gates と既存のテストへの影響で決め、報告する。
- page を閉じる期限（`PAGE_CLOSE_TIMEOUT_MS`。DEF-006）は、使わなくなる。定数の扱いも同じく整理する。
- Interaction の Context の閉じ方（Context だけ）は変えない。

## 3. 残る制約

- headed で、利用者がブラウザの画面を閉じた場合（DEF-027）は、ページの target が外から閉じられるので、同じ送信が出る可能性がある。BeakSight の側では防げない。README の headed の注意に加える（設計者が書く）。
- Context の破棄の途中の要求が届かないことは、試した範囲の確かめである（DEF-036 の設計書 2.3 と同じ）。

## 4. テスト設計

- RED（実際の Chromium、本物の Guard、127.0.0.1 の fixture のサーバ）: `pagehide` と `visibilitychange` で `sendBeacon` と keepalive の `fetch` の POST を送る fixture のページ（例: `fixtures/site/unload-beacon.html`）を、Guard の付いた Passive の Context で開き、`closePassivePageAndContext` で閉じる。名前つきの回数（例: 5 回）くり返し、名前つきの待ち（`FROZEN_POPUP_LATE_DELIVERY_SETTLE_MS` と同じ考え）の後に、サーバに POST が1件も届いていないこと、違反 0。修正の前は届く（実験で 5/5）。
- 対照: Guard なしの Context で、同じページを `page.close()` で閉じると、POST が届く（fixture が意味を持つことの確かめ）。
- Gate: `safety-gates.test.ts` に、Passive の読み取り専用（S01 か S02 の近く）として、ページを閉じるときの送信が届かない場面を加える（場所は Gate の設計に合わせて実装者が提案し、報告する）。
- 既存のテスト: page を先に閉じることや、page を閉じる期限（DEF-006）を確かめているテストは、決まりの変更として直す（表にする）。
- 関連: Page Auditor、幅の走査、PREFLIGHT、環境、robots.txt と sitemap.xml の結合テスト。

## 5. 設計変更履歴

| 日付 | 契機 | 変更内容 | 影響範囲 |
| --- | --- | --- | --- |
| 2026-10-08 | 初版（独立レビュー DEF-036R の C1） | - | `passive-session-close.ts`、`context-factory.ts`、`passive-request-guard.ts`、`limits.ts`、fixture、テスト |
| 2026-10-08 | DEF-038-fix の Blocker（`src/crawl/site-metadata.ts` が、robots.txt のページを sitemap.xml のページを開く前に個別に閉じている。テストの後片付けの補助 `tests/helpers/passive-cleanup.ts` もページを先に閉じる。期限の項目と関数を除くと範囲外のファイルが多い） | (1) `site-metadata.ts`: 前のページを閉じずに残し、最後に Context と一緒に閉じる（ページは最大 2 枚。残したページの要求も route を通る）。ページを閉じる処理の期限切れで残りの取得をやめる分岐は、使わなくなるので除く（そのテストは決まりの変更として直す）。(2) `passive-cleanup.ts` を Context だけを閉じる形に直す。(3) `pageCloseTimeoutMs` と `PAGE_CLOSE_TIMEOUT_MS` は、今回は残して使わない（コメントで DEF-038 を示す。整理は CC-049）。(4) `closePassivePage`、`closePassiveGuardedPage`、`closePassivePageBeforeDeadline` は残し、DEF-038 の注意をコメントに書く。production（`src/**` のうち、定義のファイルを除く）から呼ばないことを、Architecture Gate（正規表現の検査。速さの決まりを守る）で固定する | DEF-038-fix-round-1 |
