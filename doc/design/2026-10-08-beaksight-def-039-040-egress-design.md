# BeakSight DEF-039・DEF-040 Interaction の出口の中継と、Worker の WebSocket 設計書

- 状態: 設計者の設計（2026-10-08）。ユーザーの判断「実サイトの Run の再開はしない。気になる点をクリアしたら Task 21 を閉じたい」を受け、Task 21 を閉じる前に直す。修正の後に独立レビューを受ける（安全の不変条件に関わるため必須）。
- 関係する文書: 不具合台帳の DEF-036、DEF-038、DEF-039、DEF-040、DEF-039-040 の調査の報告（作業記録置き場の `DEF-039-040-research-brief.md` と `progress.md` の 2026-10-08 の記録）、DEF-036 の設計書、DEF-038 の設計書、実装タスク指示（Safety Invariants。S04 ポップアップ、S07 WebSocket）、Task 11 の設計（Isolated Interaction）、UI 追補設計書（Safety の事象の表示）
- この設計書は、Interaction の Context の通信の経路（Guard の CDP の横取りと route の下に、ネットワークの層の遮断を加える）について、上の文書を拡張する。

## 1. 起きていること

### 1.1 DEF-039（Critical）

- Interaction の凍結中に、ページ自身が `window.open('about:blank')` で開いたポップアップに、`pagehide`・`unload` の `sendBeacon` と keepalive の `fetch` の POST を付け、ページ自身が `p.close()` で閉じると、その POST が Guard を通らずにサーバへ届く（同じ処理の中で閉じて 5/5、300 ms 後に閉じて 8/8）。DEF-036 の修正（Guard がポップアップを閉じない）では防げない。ページの側から target を閉じるので、Chromium が閉じる途中で、CDP の横取りを通らずに要求を出す（推測）。
- 調査で、Chromium の起動の引数（`--block-new-web-contents` は本番の `chrome.exe` で効かない）、スクリプトの段階での `window.open` の無効化（保存した参照、iframe の `contentWindow.open`、名前つきの target で回避できる）、Browser の CDP の Fetch、ポップアップの target のオフライン化は、どれも止められなかった。
- 止められたのは、Interaction の Context に BeakSight 自前の中継（proxy）を付け、凍結の後はすべての要求と CONNECT を拒み、凍結のときにそれまでの接続を切る方式だけ（`chrome.exe` 27 回、headless shell 9 回、計 36 回で漏れ 0）。

### 1.2 DEF-040（Critical）

- Worker（Dedicated Worker、Shared Worker）の中で開く `new WebSocket(...)` の接続（HTTP の Upgrade）が、Passive でも Interaction でも止まらず、記録にも残らない。Playwright の `routeWebSocket` は、ページに差し込むスクリプトで WebSocket を差し替える方式なので、Worker の中に効かない（推測）。Worker の target への CDP の `Network.setBlockedURLs` も効かなかった。
- Interaction の凍結の後は、1.1 の中継で止まる（12 回で漏れ 0）。
- Passive では、中継は `ws://` しか見分けられない（`https` と `wss` はどちらも CONNECT）。文書の始まりに meta の CSP（`connect-src http: https: data: blob:`）を `addInitScript` で入れてすぐ外す方式で、blob・data・入れ子・blob の SharedWorker の WebSocket は止まる。http(s) の script から作る Worker は、Worker の script の応答の CSP が使われるので漏れる。Worker の script の応答に CDP でヘッダを加えると止まるが、Guard と一緒に動かすと固まった（原因は未調査）。

### 1.3 実サイトの記録

- 本来の監査対象のサイトの Run（9 回の起動、119 ページ）では、ポップアップの遮断 0 件、WebSocket の遮断 0 件（`run.json` の `safety.blockedActions`）。Worker を使っているかは未確認。

## 2. 決めたこと

### 2.1 Interaction の出口の中継（DEF-039 と、Interaction の DEF-040）

#### 2.1.1 部品（`src/safety/egress-proxy.ts`。新設。owner）

- Node.js 標準の `http` と `net` だけで作る、HTTP の前方中継（forward proxy）。127.0.0.1 の空いたポートで待つ。依存は加えない。
- 受けるもの: 絶対形の HTTP の要求（`http://...`。上流へそのまま転送する。ヘッダは `Proxy-Connection` などのホップごとのヘッダを除いて転送する）、`CONNECT host:port`（上流へ TCP で接続し、`200 Connection Established` の後は両方向にそのまま流す。https と wss はこれを通る。中身は見ない）。それ以外（相対形の要求など）は `400` で拒む。
- 状態: `OPEN` → `FROZEN` → `CLOSED`。
  - `OPEN`: 転送する。上流の方針（`upstreamPolicy(host, port): boolean`。下）に合わないものは `403` で拒み、記録する。
  - `freeze()`: `FROZEN` にし、今つながっているすべてのソケット（クライアント側と上流側。CONNECT のトンネルと keep-alive を含む）を破棄する。`FROZEN` では、すべての要求と CONNECT を `403` で拒み、記録する（`onRejected`）。
  - `close()`: `CLOSED` にし、すべてのソケットを破棄して、待ち受けを閉じる。
- 記録の口: `onRejected({ method, url, phase: 'OPEN' | 'FROZEN' })`。`url` は、絶対形の要求ならその URL、CONNECT なら `host:port`（authority の形。https か wss かは分からない）。中継は Ledger を知らない（Ledger に書くのは factory）。
- 上流の方針: production は、すべての host を許す（ページが読み込むほかの Origin のリソースは、今も直接届いているので、中継を通しても露出は増えない）。テストは、127.0.0.1 だけを許す方針を注入する（実在の外部のサイトにアクセスしない決まり）。方針は factory の構築の引数で受ける（既定は production の方針）。
- 中継の失敗（待ち受けの失敗、`listen` の後の `error`）は、呼び出し側に知らせる（`onError`）。ソケットごとの失敗は、そのソケットを破棄するだけで、知らせない。
- HTTP/2 と HTTP/3: Chromium は HTTP の中継には HTTP/1.1 で話し、中継の先に QUIC を使わない（推測。Interaction の Context では HTTP/3 が使われなくなる）。

#### 2.1.2 factory（`src/browser/context-factory.ts`）

- `createInteractionSession` は、Context を作る前に中継を作り、`newContext` に `proxy: { server: 'http://127.0.0.1:<port>' }` を渡す（Playwright は `Target.createBrowserContext` の `proxyServer` で Context ごとの proxy を付け、`<-loopback>` を bypass に加えて、127.0.0.1 への通信も中継を通す）。Passive の Context には付けない（DEF-038 の修正で、Passive はページを個別に閉じないので、Context の route で足りる。Passive の Worker の WebSocket は 2.2）。
- 中継の `onRejected` は、その Context の Ledger の `recordBlockedInteractionRequest({ method, url, reason: 'INTERACTION_FROZEN_EGRESS' })` に写す（`FROZEN` の拒否）。`OPEN` の拒否（上流の方針に合わない）は、同じ記録に理由 `EGRESS_UPSTREAM_DENIED` で写す（production では起きない。テストの方針で起きる）。
- `activateInteractionFreeze`: 今までどおり Guard の凍結（`activateInteractionFreeze(page)`）を先に行い、その後に中継の `freeze()` を行う。Guard の凍結が失敗した（fail-closed で Context が無効になる）場合も、中継は `freeze()` する（その後の `close()` で閉じる）。順の理由: Guard の凍結の前に中継を凍結すると、まだ正当な要求（読み込みの残り）を中継が拒み、「Guard を通らずに出た要求」の記録と区別できなくなる。Guard の凍結の後、中継の凍結までの間に Guard を通らずに出た要求は止められない（2.4 の限界）。
- `close()`: 今までどおり Context を閉じ、その後（失敗しても）中継を `close()` する。
- 中継を作れなかった場合: Context を作らず、`ContextConstructionError` ではなく、その例外をそのまま投げる（Context の作成のそれ以外の失敗と同じ扱い）。中継の `onError`（待ち受けの後の失敗）は、違反 `EGRESS_PROXY_FAILED` を記録して Context を無効にする（Guard の `invalidateContext` と同じ経路。fail-closed）。
- 中継の作成と `freeze()`・`close()` にかかる時間は、Interaction の期限（`freezeActivationTimeoutMs`、Context を閉じる期限）の中に入る。

#### 2.1.3 記録の形（`src/core/evidence-types.ts`、スキーマ）

- `BlockedInteractionRequestEvent.reason` を、`INTERACTION_FROZEN`（Guard の route と CDP が止めたもの）、`INTERACTION_FROZEN_EGRESS`（凍結の後に中継が拒んだもの。Guard を通らずに出た要求の証拠）、`EGRESS_UPSTREAM_DENIED`（上流の方針で拒んだもの）の閉じた一覧にする（新しい定数 `BLOCKED_INTERACTION_REQUEST_REASONS`）。`BlockedInteractionNavigationEvent` の理由は `INTERACTION_FROZEN` のまま（別の型にする）。
- `schemas/page.schema.json` の `blockedInteractionRequestEvent` の `reason` の enum に 2 つを加える（`checkpoint.schema.json` は `$ref` で参照しているので、そのまま）。前の結果のファイルは、そのまま検証に通る。
- `run.json` の `safety.blockedActions.requests` は、`blockedInteractionRequests` の件数に含まれるので、形は変えない。
- 表示: 事象の種類は変えないので、表示カタログの種類は変えない。理由のコードは、今までどおり事象の理由をそのまま示す（理由の説明の文があれば、`messages.ts` に 2 つ加える。UI Gate が求めるかどうかは実装者が確かめる）。

#### 2.1.4 Gate とテスト

- `tests/integration/safety-gates.test.ts` の GATE-S04 に、「凍結中にページ自身が開いて閉じるポップアップの `pagehide` の beacon と keepalive の POST がサーバに届かない（くり返し）」と対照（Guard と中継なしで届く）を加える。GATE-S07 に、「Interaction の凍結の後に Worker の中で開く WebSocket の接続がサーバに届かない」と対照を加える。
- 中継の単体テスト（本物の `http` のクライアントで）: `OPEN` で絶対形の要求と CONNECT を 127.0.0.1 へ転送する。上流の方針で拒む。`freeze()` で既存のトンネルが切れ、以後は拒んで記録する。`close()` で待ち受けが閉じる。相対形の要求を拒む。
- Interaction の結合テスト（`isolated-interaction.test.ts`）: DEF-039 の 3 つの場面（同じ処理の中で閉じる、300 ms 後に閉じる、`unload` の beacon）を、本物の Guard と中継で、名前つきの回数くり返し、サーバに届かないこと、違反 0、`blockedPopups` 1 件以上。中継の記録（`INTERACTION_FROZEN_EGRESS`）が残る回があること（場面ごとに 1 回以上。残らない回は、要求そのものが出なかった回として許す。DEF-036 のテストの条件と同じ考え）。
- 既存の Interaction のテスト全体が、中継を通しても通ること（テストの factory には 127.0.0.1 だけの上流の方針を注入する）。
- `tests/helpers/gate-harness.ts` と、factory を作るテストの補助は、上流の方針を注入する。

### 2.2 Passive の Worker の WebSocket（DEF-040 の Passive。NP2 の調査で確定。2026-10-08）

- 方式: 「Context の `addInitScript` で、文書の始まりに meta の CSP（`connect-src http: https: data: blob:`）を入れてすぐ外す」と、「Guard の CDP の Fetch に `{ urlPattern: '*', resourceType: 'Other', requestStage: 'Response' }` の pattern を加え、`Other` のすべての応答に `Fetch.continueResponse`（`responseCode`・`responsePhrase`・`responseHeaders` を必ず 3 つとも渡す。`responseHeaders` は元のヘッダに 1 つ加えた配列）で同じ CSP のヘッダを加える」の組み合わせ。
  - 前の調査で固まった原因は、`Fetch.continueResponse` に `responseHeaders` だけを渡したこと（Chromium が拒み、要求が一時停止のまま残る）。Guard との競合ではない（正しい形で計 98 回、固まり 0、違反 0）。
  - CDP の Fetch に `resourceType: 'Worker'` はなく、Worker の script の応答は `Other` として来る。CSP のヘッダは文書と Worker 以外の応答には効かないので、`Other` の全部に加えてよい。
  - Document の応答にヘッダを加えても、文書の CSP としては効かない（network service の解析の後のため。推測）。meta が必要。
  - この組み合わせで、blob・data・入れ子・blank/srcdoc の iframe・head のない HTML・XHTML の Worker、http の script の Dedicated/Shared Worker、module Worker、`importScripts`、http の Worker の中の blob Worker の WebSocket が止まった（36/36、24/28、3/3。漏れたのは SVG 文書の 4 回だけ）。
- owner: CSP の policy の文字列と、meta を入れて外すスクリプト、ヘッダの注入は、Guard（`src/safety/passive-request-guard.ts`）が持つ。`addInitScript` は Guard の取り付け（`installPassiveRequestGuard`。ページを作る前）で行う。Passive と Interaction のすべての Context に適用する（Interaction の凍結の後は中継も止める）。OOPIF の子の session にも同じ pattern を付ける（同じ関数）。
- fail-closed: `continueResponse` が `Invalid InterceptionId` 以外で失敗した場合は、その応答を `failRequest`（`BlockedByClient`）し、違反 `WORKER_CONNECT_POLICY_INJECTION_FAILED` を記録して Context を無効にする（Worker が CSP なしで動くのを防ぐ）。
- 記録（best-effort。観察）: Guard の page の session で `Log.enable` し、`Log.entryAdded`（source `worker`。文 `Connecting to '<url>' violates the following Content Security Policy directive`）から URL を取り出し、Passive の段階なら `recordBlockedWebSocket`、凍結の段階なら `recordBlockedInteractionWebSocket` に、理由 `WORKER_CONNECT_POLICY` で記録する（理由の閉じた一覧とスキーマの enum に加える）。Shared Worker の違反は page の session に出ないので記録されない。止めるのは CSP で決定的、記録は観察で取りこぼしうる（README に書く）。`Network.webSocketCreated` は CSP で止まると出ないので使わない。Worker の target への自動の付与（`Audits.issueAdded`）は、Guard の付与の流れを変えるので、今回は行わない（将来の候補）。
- 監査への影響: DOM・console・network の Evidence に写らない（meta は入れてすぐ外す。Worker の中の CSP の違反は page の console に出ない。注入したヘッダは network の Evidence の名前の一覧にない）。http/https/data/blob の接続（fetch、XHR、beacon、EventSource、ping、img、script）は変わらない。`about:` などのそれ以外のスキームへの接続は止まる（もともと失敗する接続）。サイト自身の CSP に `report-uri` があっても、BeakSight の policy には報告先がないので、違反の報告は出ない（推測を含む）。
- 残る経路: SVG 文書（main と iframe）の中のスクリプトが作る Worker（meta を入れられない）。WebTransport（`https:` で許される。推測）。OOPIF の中の Worker（子の session の pattern で止まると推測。未確認）。Worker の中の fetch/XHR は Guard の route と CDP（DEF-042）が見る。

### 2.3 README

- 「読み取り専用の保証の範囲」の DEF-039 と DEF-040（Interaction）の箇条を、修正の後に直す（Interaction の通信は、Guard の下に中継があり、凍結の後は中継がすべて拒む。中継の記録の意味）。Passive の Worker の WebSocket は、2.2 の後に直す。
- 「サイトへの負荷」か「Interaction」の説明に、Interaction の Context の通信が BeakSight の中継を通ること（127.0.0.1 の中継。サイトから見える接続元は変わらない）を 1〜2 行で書く。

### 2.4 残る制約（限界）

- Guard の凍結の後、中継の凍結までの間（数 ms）に Guard を通らずに出た要求は、止められない。
- `OPEN` の間（凍結の前）に Guard を通らずに出た要求は、中継が転送する（凍結の前は Passive の分類で、GET 以外は Guard が止める。Guard を通らない経路は、凍結の前には観測されていない）。
- CONNECT の記録は `host:port` だけで、https か wss か、パスは分からない。
- Chromium 自身の通信（例: `CONNECT www.google.com:443`。Playwright の Context でも出る）は、`OPEN` では転送し（今も直接出ている）、`FROZEN` では拒んで記録する（Ledger に、ページの要求でないものが載る。README に書く）。
- headed での中継の振る舞いは、同じ CDP の仕組みなので同じと推測するが、テストは headless だけ。
- 中継は TLS を解かないので、中身の検査はしない（Guard の仕事）。

## 3. SSOT と安全性への影響

| 項目 | owner | 扱い |
| --- | --- | --- |
| 出口の中継（状態、転送、拒否、記録の口） | `src/safety/egress-proxy.ts`（新設） | 共通部品台帳に加える |
| 中継の作成・凍結・閉じ方と Ledger への写し | `src/browser/context-factory.ts` | 変更 |
| 操作中に遮断した要求の理由の閉じた一覧 | `src/core/evidence-types.ts`、`schemas/page.schema.json` | 変更（enum の追加） |

- 安全の不変条件: 強める（Interaction の凍結の後、CDP の横取りを通らない経路も、ネットワークの層で止める）。Guard の判定は変えない。
- 監査の結果: Interaction の結果の区分は変えない。Ledger の記録の種類は変えない（理由の値が 2 つ増える）。

## 4. 実装の順

| ID | 内容 | 依存 |
| --- | --- | --- |
| NP1 | 出口の中継（2.1.1〜2.1.4） | なし |
| NP2 | Passive の Worker の WebSocket の調査（2.2。読み取り専用） | なし（NP1 と並行） |
| NP3 | Passive の Worker の WebSocket の修正（2.2。Guard と Context の変更。DEF-042-fix と NP1 の後） | NP2、NP1、DEF-042-fix |
| NP4 | README（2.3）、表示カタログの説明、`playwright-errors.ts` の取り消しの文言、テストのコメントの直し。共通部品台帳は設計者 | NP1、NP3 |
| NPR | 独立レビュー（T21R と合わせる） | NP4 |

## 5. 設計変更履歴

| 日付 | 契機 | 変更内容 | 影響範囲 |
| --- | --- | --- | --- |
| 2026-10-08 | 初版（独立レビュー DEF-036R の C2・C3、DEF-039-040 の調査、ユーザーの判断） | - | `egress-proxy.ts`（新設）、`context-factory.ts`、`evidence-types.ts`、スキーマ、Gate、README |
| 2026-10-08 | NP2 の調査の報告 | 2.2 を確定した（meta の CSP + Other の応答へのヘッダの注入。固まった原因は命令の呼び方。記録は Log の観察で best-effort。理由 `WORKER_CONNECT_POLICY` と違反 `WORKER_CONNECT_POLICY_INJECTION_FAILED`） | `passive-request-guard.ts`、`evidence-types.ts`、スキーマ、Gate |
| 2026-10-08 | NP1 の報告 | 中継の `onError` の fail-closed は、Guard の `invalidateContext`（非公開）ではなく、違反 `EGRESS_PROXY_FAILED` の記録と factory の所有の閉じる処理（`closePassiveContext` を 1 回。session の `close()` はそれに合流）で行う（Guard を変えないため。無効化の段階は経ないが、Context は閉じる）。`blockedInteractionNavigations` はスキーマの `blockedInteractionNavigationEvent`（新設）を参照し、理由は `INTERACTION_FROZEN` だけ。テストの上流の方針は loopback（`127.0.0.1`、`localhost`、`[::1]`）。`catalog.ts` の `blockedInteractionRequests` の説明に `INTERACTION_FROZEN_EGRESS` の意味を加えるのは NP4 で行う。`ws://` も CONNECT を通るので、CONNECT の記録は ws/wss/https を区別しない | なし（記述）、NP4 |
| 2026-10-08 | DEF-042-fix の Blocker 2 | Guard の CDP の横取りの拡大で、DEF-039 の場面は中継より先に Guard が止める。2.1.4 の「中継の記録が場面ごとに 1 回以上」は「Guard の記録か中継の記録のどちらかが回ごとにある」に読み替える。中継が働く証拠は、Worker の WebSocket（GATE-S07 の DEF-040）と単体テスト | NP1 のテスト（DEF-042-fix-round-1 で直す） |
| 2026-10-08 | NP3 の報告 | 2.2 のとおり実装。理由 `WORKER_CONNECT_POLICY` は `BLOCKED_WEBSOCKET_REASONS` と新設の `BLOCKED_INTERACTION_WEBSOCKET_REASONS` に加えた。Worker の WebSocket は CSP が Worker の中で止めるので、凍結の後も中継に CONNECT は来ない。2.1.4 と 2.4 の「中継が働く証拠は GATE-S07 の Worker の WebSocket」は成り立たなくなり、証拠は中継の単体テスト（`egress-proxy.test.ts`）と factory の部品のテストになる（NP4 でテストのコメントを直す）。srcdoc の iframe の中の Worker の違反は Log が 2 回届き、記録が 2 件になる（重複は除かない）。`continueResponse` の `Invalid InterceptionId` の文言は `playwright-errors.ts` の一覧にないので NP4 で加える | NP4 |
| 2026-10-08 | NP5（DEF-044） | Shared Worker は起動の引数 `--disable-shared-workers` で無効にし、factory の自己検査（`SHARED_WORKER_OBSERVED`）で fail-closed にした（`2026-10-08-beaksight-def-044-046-review-fixes-design.md`）。2.2 の「Shared Worker の違反は記録されない」は、Shared Worker が存在しなくなったので当たらない。Worker の WebSocket の CSP は Dedicated Worker だけに働く | 記述 |
