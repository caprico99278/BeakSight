# BeakSight DEF-042 Guard の CDP の横取りをすべての要求に広げる 修正設計書

- 状態: 設計者の設計（2026-10-08）。修正の後に独立レビューを受ける（安全の不変条件の中核の変更のため必須）。
- 関係する文書: 不具合台帳の DEF-042（独立レビュー T21R の C1）、DEF-042 の調査の報告（作業記録置き場の `DEF-042-research-brief.md`、`progress.md` の 2026-10-08 の記録、scratchpad の `def042/`）、DEF-036・DEF-038 の設計書、DEF-026・DEF-027 の設計書（Guard の Document の横取りと `expectedCdpFailures`）、実装タスク指示（Safety Invariants。S01・S02 Passive の読み取り専用）、共通部品台帳

## 1. 起きていること

- Guard は、CDP の Fetch で Document の要求だけを横取りし（Request と Response の段階）、それ以外の要求は Playwright の `context.route('**/*')` で止める。
- ページを離れるときの送信（`pagehide` の `sendBeacon`、keepalive の `fetch`、`fetchLater()`）は、CDP の `Fetch.requestPaused` に **`networkId` が付かず、`Network.requestWillBeSent` も来ない**。Playwright の `_onRequestPaused` は、`networkId` のない要求を、route の処理を呼ばずに `Fetch.continueRequest` する。そのため Guard の route は呼ばれず、POST がサーバに届く（headless shell と `chrome.exe` の両方。DEF-036・DEF-038 の「`page.close()` の後」とは別の仕組み）。
- 同じ仕組みで、Guard 自身が許可 Origin の外への main frame の移動を `BlockedByClient` で止めたときも、エラーページ（`chrome-error://chromewebdata/`）が確定して `pagehide` が起き、送信が許可 Origin へ届く（調査の実験 7。3/3）。Interaction の凍結の前（候補のページの読み込みの後）も同じ（実験 4）。
- Chromium の設定（`--disable-features=KeepAliveInBrowserMigration` など）では止まらない。2 回目の main frame の移動を止める案は、`Aborted` でしか効かず、subframe の自己移動と `fetchLater` が残る。
- 実サイトの記録: ページの中からの 2 回目の main frame の移動は 0 件（237 ビューポート）。起きていない。

## 2. 決めたこと

### 2.1 Guard の CDP の Fetch を、すべての要求の Request の段階に広げる（`src/safety/passive-request-guard.ts`）

- `Fetch.enable` の pattern に `{ urlPattern: '*', requestStage: 'Request' }` を加える（Document の Request と Response の pattern はそのまま）。page の session と OOPIF の子の session は同じ関数で有効にするので、両方に広がる。
- `Fetch.requestPaused` の処理で、`resourceType` が `Document` でない要求を、Guard が CDP の段階で判定する:
  - Passive の段階（`PASSIVE_ACTIVE`）: 今の分類（`classifyPassiveRequest`。`isNavigationRequest: false`、`isMainFrame: false`）で、許可するものは `Fetch.continueRequest`、止めるものは `Fetch.failRequest`（`BlockedByClient`）と、**今と同じ記録**（`recordBlockedRequest`。理由は分類のもの。記録の種類と理由は変えない。スキーマの変更なし）。
  - 凍結の段階（`FROZEN_*`）: `Fetch.failRequest` と `recordBlockedInteractionRequest`（理由 `INTERACTION_FROZEN`）。
  - 閉じる途中・無効化の段階: `Fetch.failRequest`（記録は今の route の扱いに合わせる）。
  - 分類に必要な情報（method、URL）が取れない要求は、fail-closed で止める（今の Document の扱いに合わせる）。
- Playwright の route（`context.route('**/*')`）と `routeWebSocket` は、そのまま残す（二重の網。Run 全体のキャッシュから返す処理もここ）。Guard の CDP が止めた要求は route に来ない（Guard が `failRequest` する前に Playwright の session が止める順になる場合があるかは未確認。実装で確かめ、記録の重複と `Invalid InterceptionId` の扱いを報告する。`Invalid InterceptionId` は既存の `isInvalidInterceptionIdFailure` で、ブラウザが先に取り消した要求として扱う）。
- 記録の重複を避ける: 同じ要求が CDP と route の両方で判定されうる場合、記録は 1 回にする（CDP で止めたものは route に来ないので、原則として重複しない。許可した要求は、どちらも記録しない）。
- 性能: 調査で 602 要求のページで中央値 +0〜90 ms。実サイトの 1 ページ（100〜300 要求）で数十 ms と推測。受け入れる。

### 2.2 変えないこと

- Document の横取り（DEF-026、DEF-027、C18g の外部スキームのリダイレクトの判定、`expectedCdpFailures`）は変えない。
- main frame の移動を止めるときの `errorReason`（`BlockedByClient`）は、今回は変えない。`Aborted` に変えると、エラーページが確定せず DOM が残るが、DEF-027 の外部からの取り消し（`ERR_ABORTED`）の判定と `expectedCdpFailures` の `errorText` の対応に関わるので、別の不具合（DEF-043。監査の証拠の質の問題。送信の漏れは 2.1 で止まる）として扱う。
- Guard の route の判定、Ledger の記録の種類と理由、スキーマ、`run.json` の形は変えない。

### 2.3 残る制約

- Fetch の domain を通らない要求（Worker の WebSocket = DEF-040、外部スキーム）は、この修正の対象外。
- OOPIF の子の session を Guard が付ける前の要求（`waitForDebuggerOnStart` で止めるので起きないはず。推測）。
- headed での同じ振る舞いは、同じ CDP の仕組みなので同じと推測する（テストは headless だけ）。
- Context の破棄で、止めたままの要求が届かないことは、試した範囲の確かめ（DEF-038 の Gate、両方の Chromium）で、Chromium の仕組みとしての保証ではない。
- Document の横取りの閉じる途中の失敗には、2.4 の「閉じた target」の扱いを適用していない（Document の横取りは変えない決まり。起きれば今までどおり違反。テストでは起きていない）。


### 2.4 DEF-042-fix の Blocker への判断（2026-10-08）

- **閉じる途中の命令の失敗（Blocker 1）**: Guard が閉じる途中・無効化の段階（owner の close を始めた後）で、一時停止した要求への命令（`failRequest`、`continueRequest`）が、session か target が閉じたことによる失敗（Playwright の `Target page, context or browser has been closed` の形。既存の閉じた誤りの判定があればそれを使う）で終わった場合は、target とともに消えた要求として扱い、違反にしない。根拠: Context の破棄で、止めたままの要求は届かない（DEF-038 の Gate で、両方の Chromium で 0 件。試した範囲の確かめで、Chromium の仕組みとしての保証ではない。2.3 に加える）。閉じる途中でない段階での失敗は、今までどおり違反。
- **Guard の作業の上限（Blocker 1 の (b)）**: すべての要求が Guard の作業（`trackGuardTask`）になるので、同時に一時停止する要求の数が `MAX_PENDING_GUARD_TASKS`（256）を超えうる。要求の横取りの作業には、別の上限 `MAX_PENDING_GUARD_REQUEST_TASKS`（`src/core/limits.ts`。例: 4,096。理由をコメントに）を設け、超えたときは今までどおり fail-closed（違反 `GUARD_TASK_LIMIT_REACHED` と同じ扱い）。ほかの作業の上限は変えない。600 以上の資源を一度に読むページで超えないことをテストで確かめる。
- **CORS の事前確認（OPTIONS）**: Playwright は、横取りがあるとき、CORS の事前確認（`Network.requestWillBeSent` の `initiator.type` が `preflight` の `OPTIONS`）を自分で `204` と CORS のヘッダで満たし、サーバに送らない。Guard の CDP が先に見るようになったので、Guard が同じことをする: 事前確認（`initiator.type === 'preflight'`。取れない場合は `OPTIONS` かつ `Access-Control-Request-Method` ヘッダあり）は `Fetch.fulfillRequest`（`204`。`Access-Control-Allow-Origin` は要求の `Origin` か `*`、`Allow-Methods` と `Allow-Headers` は要求のもの、`Allow-Credentials: true`。Playwright と同じ値）で満たし、記録しない（今までも記録していない。サーバに届かないので読み取り専用は保たれる）。事前確認でない `OPTIONS` は、今までどおり止めて記録する。許可 Origin の外の API を独自ヘッダつきの GET で読む fixture で、本体の GET が進み、`OPTIONS` がサーバに届かないことを確かめる。
- **出口の中継との重なり（Blocker 2）**: Guard の CDP が、opener の page の session で `about:blank` のポップアップの送信も横取りするようになり、DEF-039 の場面では中継より先に Guard が止める（理由 `INTERACTION_FROZEN`）。安全の条件は満たす。NP1 のテストの「中継の記録が 1 回以上」は、「Guard の記録（`INTERACTION_FROZEN`）か中継の記録（`INTERACTION_FROZEN_EGRESS`）のどちらかが、回ごとにある。届いた回は 0。違反 0」に変える。中継が実際に働く証拠は、Fetch の domain を通らない Worker の WebSocket（GATE-S07 の DEF-040。CONNECT の記録 `INTERACTION_FROZEN_EGRESS`）と、中継の単体テストで示す。設計書 `2026-10-08-beaksight-def-039-040-egress-design.md` の 2.1.4 も同じく読み替える（設計者が履歴に書く）。

## 3. SSOT と安全性への影響

- owner: Guard（`src/safety/passive-request-guard.ts`）のまま。判定は `classifyPassiveRequest`（`src/safety/request-policy.ts`）のまま。第二の owner は作らない。
- 安全の不変条件: 強める（Playwright の route を通らない要求も、CDP の段階で止める）。

## 4. テスト設計

- RED（実際の Chromium、本物の Guard、127.0.0.1 の fixture のサーバ。headless shell と、CLI の起動の設定 `chromiumLaunchOptions` の `chrome.exe` の両方で確かめる）:
  - ページを離れるときの送信の fixture（既存の `unload-beacon.html` を使うか、`location.href` で別の文書へ移る版を加える）で、ページ自身の移動の後に、`POST` がサーバに届かず、`blockedRequests` に記録され、違反 0。くり返し（名前つきの回数）と、全部の回の後の待ち（既存の定数）。
  - `fetchLater()` の場面。
  - Guard が許可 Origin の外への main frame の移動を止めた場面（実験 7）で、送信が届かない。
  - Interaction の凍結の前にページ自身が移動した場面（実験 4）で、送信が届かない。
  - OOPIF の自己移動（`tests/helpers/external-scheme-fixture.ts` と同じ `localhost` の iframe の方式で可能なら）。
- 対照: Guard なしでは届く（既存の対照の形）。
- Gate: GATE-S01/S02 に、ページを離れる移動の場面と対照を加える。
- 既存のテスト: Guard の単体・結合、Interaction、Page Auditor、fixture の full crawl、Gate 全体。CDP の記録の重複と、`Invalid InterceptionId` の扱いを確かめるテスト。

## 5. 設計変更履歴

| 日付 | 契機 | 変更内容 | 影響範囲 |
| --- | --- | --- | --- |
| 2026-10-08 | 初版（独立レビュー T21R の C1、DEF-042 の調査） | - | `passive-request-guard.ts`、fixture、Gate、Guard のテスト |
| 2026-10-08 | DEF-042-fix の Blocker 2 件と OPTIONS の懸念 | 2.4 を加えた（閉じる途中の命令の失敗は違反にしない、要求の横取りの作業の別の上限、CORS の事前確認は Guard が満たす、中継との重なりはどちらかの記録で可） | `passive-request-guard.ts`、`limits.ts`、NP1 のテスト |
| 2026-10-08 | DEF-042-fix-round-1 の報告 | 閉じた誤りの判定は Guard の `isClosedTargetFailure`（完全一致の閉じた一覧）。作業の種類 `GuardTaskKind`（`GENERAL`/`REQUEST`）で上限を分ける。事前確認は `PreflightInitiatorRegistry`（`Network.requestWillBeSent` の `initiator.type`。1,000 ms・256 件）と `Access-Control-Request-Method` の補助で判定。新しい違反のコード `CDP_REQUEST_FACTS_INVALID`、`CDP_REQUEST_PHASE_INVALID`、`CDP_PREFLIGHT_FULFILL_FAILED`。`fixture-full-crawl` の所要時間は前後で同じ（約 39 秒） | なし（記述） |
