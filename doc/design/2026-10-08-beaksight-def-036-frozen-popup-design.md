# BeakSight DEF-036 凍結中のポップアップの要求が Guard を通らずに届く 修正設計書

- 状態: 設計者の設計（2026-10-08）。修正の後に独立レビューを受ける（安全の不変条件に関わるため必須）。
- 関係する文書: 実装タスク指示（Safety Invariants。S04 ポップアップ、Interaction の凍結）、Task 11 の設計（Isolated Interaction）、不具合台帳の DEF-036、DEF-010、調査の報告（作業記録置き場の `DEF-036-investigation-brief.md` と、その報告の要約を `progress.md` に記録）

## 1. 起きていること

### 1.1 観測

- Interaction の凍結の段階で、ページがポップアップを開くと、Guard は `blockedPopups` に記録し、すぐに `page.close()` を呼ぶ（`passive-request-guard.ts` の `recordAndCloseFrozenPopup`。`onPage` と `onPopup` から）。
- Playwright 1.62.1 は、`page.close()` を呼んだ時点（`_closeWasCalled = true`）から、そのページの要求について、Context の `route` の処理を呼ばない（`BrowserContext._onRoute` の `if (page?._closeWasCalled || this.isClosed()) return;`）。
- Chromium は、ポップアップの target を閉じる処理（`Target.closeTarget`）の途中で、Fetch で止める前の要求を、そのままネットワークへ出すことがある（`Fetch.requestPaused` が出ないまま、`Network.requestWillBeSent` → `loadingFailed(canceled)` → サーバに届く。内部の仕組みは推測）。
- 結果として、ポップアップの中の要求が、Guard の記録なしにサーバへ届く。ポップアップの中のフォームの POST は、負荷の小さいときに 40 回中 37 回届いた（調査の再現）。GET の移動は、負荷の高いときにまれに届く（全体のテストの中の DEF-036 の失敗）。Ledger には `blockedPopups` だけが残り、違反は 0 件で、Guard は漏れを検知できない。
- ポップアップを閉じない対照では、Context の `route` がいつも呼ばれ、GET も POST も届かなかった（150 回と 100 回で 0）。Context をすぐに閉じる対照（ポップアップを閉じずに）でも、届かなかった（60 回で 0）。

### 1.2 影響

- 安全の不変条件（Interaction で、読み取りでない要求を送らない。ポップアップの先へ要求を届けない）が破れる。重大度は Critical。
- 本来の監査対象のサイトの Run（起動 1〜9、119 ページ）では、ポップアップの遮断の記録は 0 件で、この場面は起きていない（`run.json` の `safety.blockedActions.popups` が 0）。

## 2. 決めたこと

### 2.1 凍結中のポップアップを、すぐに閉じない

- 凍結の段階で開いたポップアップ（`onPage`、`onPopup`）は、今までどおり `blockedPopups` に記録する（理由 `INTERACTION_FROZEN`。1つのページにつき1回）。ただし、`page.close()` を呼ばない。
- ポップアップの中の要求は、Context の `route('**/*')`（凍結の段階では、すべての HTTP の要求を止めて `blockedInteractionRequests` に記録する）と `routeWebSocket` で止める。ポップアップには、Guard の page の CDP の横取り（`ensurePageGuard`）を付けない（今のまま）。
- ポップアップは、その Interaction の Context を閉じるとき（`session.close()` → Guard の Context の close）に、Context と一緒に閉じる。Guard と Interaction の側で、ポップアップだけを先に閉じる処理を置かない（ほかに `page.close()` でポップアップを閉じる箇所があれば、同じく除く）。
- `isolated-auditor.ts` は、`blockedPopups` の記録で、今までどおり `BLOCKED_BY_SAFETY` を返し、session を閉じる（今の流れのまま）。
- 違反のコードのうち、ポップアップを閉じる処理だけが使うもの（`INTERACTION_POPUP_CLOSE_FAILED`、`GUARD_POPUP_CLOSE_TASK_FAILED` など）は、使わなくなる。閉じた一覧（スキーマの enum など）からは除かない（前の結果のファイルとの互換のため）。使わなくなったことを、コードのコメントに書く。

### 2.2 変えないこと

- Passive の段階（凍結していない段階）の、ポップアップの扱い（Guard の準備のできていないページの要求は、違反として止め、Context を無効にする）は変えない。
- 凍結の段階で、ポップアップの要求を止めたときの記録（`blockedInteractionRequests`）の形は変えない。
- `run.json`、ページの結果、スキーマ、Ledger の形は変えない。

### 2.3 残る制約（限界）

- Context を閉じる処理（`BrowserContext.close`）の途中で出た要求が届かないことは、試した範囲（60 回で 0）で確かめただけで、Chromium の仕組みとして保証されたものではない。Playwright は、閉じ始めた Context の要求で `route` の処理を呼ばず、止めたまま Context ごと破棄する（`Target.disposeBrowserContext`）。ポップアップの target を個別に閉じる場合と違い、止めた要求を外す経路は観測されていない。限界として記録する。
- 修正の後のくり返し（POST の場面、内訳の分かる 190 回）で、1 回だけ、ポップアップの要求が Context の `request` の事象には現れたのに、route の処理を通らず、`net::ERR_ABORTED` で失敗した（サーバには届かず、違反 0。DEF-036-fix-round-1 の報告）。Context を閉じる途中で、Playwright が route の処理を呼ばずに止めたまま破棄した経路と推測するが、要求が出た時点（閉じ始めの前か後か）は再現できず未確認。サーバに届かないことは、回ごとと、全部の回の後の待ちの後に確かめる。

## 3. SSOT と安全性への影響

- owner: Guard（`src/safety/passive-request-guard.ts`）のまま。第二の owner は作らない。
- 安全の不変条件: 強める（漏れの経路を閉じる）。

## 4. テスト設計

- RED（修正の前に失敗する。実際の Chromium、本物の Guard、127.0.0.1 の fixture のサーバ）:
  - 凍結の後に、ポップアップの中のフォームが POST を送る fixture（例: `fixtures/site/popup-form-post.html`。クリックで `window.open('about:blank')` を開き、その文書にフォームを書いて送る。送り先は fixture のサーバの `/__mutation`）。`auditInteraction` を同じテストの中で複数回（例: 10 回。調査で 37/40 だったので、修正の前にはほぼ確実に失敗する回数）くり返し、どの回も、サーバに `POST /__mutation` が届かず、結果が `BLOCKED_BY_SAFETY`、`blockedPopups` が1件以上、`blockedInteractionRequests` に POST の記録があり、違反が 0 件であること。
  - 既存の `/popup-button.html`（GET）も、同じテストの中で複数回（例: 10 回）くり返し、`GET /popup-target.html` が届かないこと。修正の後は、`blockedInteractionRequests` に GET の記録があること（ポップアップの要求が route を通った証拠）。
- 既存のテスト: ポップアップをすぐに閉じることを確かめているテスト（Guard の単体・結合）は、決まりの変更として直す（閉じないこと、Context を閉じた後にポップアップが閉じていること、に変える）。表にする。
- 対照: Guard なしでは、同じ fixture の POST が届くこと（fixture が意味を持つことの確かめ。DEF-010 の教訓）。
- 関連: `tests/integration/safety-gates.test.ts` の GATE-S04、`tests/integration/isolated-interaction.test.ts` の全体、Guard の単体・結合のテスト。

## 5. 設計変更履歴

| 日付 | 契機 | 変更内容 | 影響範囲 |
| --- | --- | --- | --- |
| 2026-10-08 | 初版（DEF-036 の調査の報告） | - | `passive-request-guard.ts`、`isolated-auditor.ts`（必要なら）、fixture、テスト |
| 2026-10-08 | DEF-036-fix の Blocker（修正の後、POST の場面で 100 回中 6 回、`blockedInteractionRequests` に記録が残らなかった。その回は、Playwright の要求の事象もなく、サーバにも届いていない。`isolated-auditor.ts` が凍結の事象で直ちに Context を閉じるため、ポップアップのフォームが要求を出す前に閉じたと推測） | 4 のテストの条件を直した: 回ごとに「サーバに届かない、違反 0、`BLOCKED_BY_SAFETY`、`blockedPopups` 1 件以上」と「route の記録がある、または要求そのものが出なかった（Context の `request` の事象がない）」を求める。場面ごとに、route の記録がある回が少なくとも1回あることを求める。全部の回の後に、名前つきの待ち（例: 1 秒）の後で、サーバの記録を改めて確かめる（閉じた後に遅れて届く要求を見逃さないため。修正の前の漏れは、閉じた数 ms 後に届いた）。auditor の流れは変えない | DEF-036-fix-round-1 |
| 2026-10-08 | DEF-036-fix-round-1 の Blocker（POST の 190 回中 1 回、要求が route を通らずに `ERR_ABORTED` で失敗した。届いてはいない） | 2.3 に観測を加えた。4 のテストの条件: 回ごとに「route の記録がある」「要求が出なかった」「要求は出たが、応答を受けずに失敗した（Context の `requestfailed`。`response` も `requestfinished` もない）」のどれかを求め、要求が出て応答を受けた回は失敗にする。route の記録の回が場面ごとに1回以上、全部の回の後の待ちの後に届いていないこと、は変えない。route を通らなかった回の数は、テストの出力に残す。独立レビューで、この限界を判断する | DEF-036-fix-round-2 |
