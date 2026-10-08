# BeakSight DEF-044〜DEF-046 最終レビューの指摘の修正 設計書

- 状態: 設計者の設計（2026-10-08）。独立レビュー NPR-T21R2 の C1、I1、I2 への対応。修正の後に独立レビューを受ける。
- 関係する文書: 不具合台帳の DEF-044〜DEF-047、DEF-039・040 の設計書（出口の中継、Worker の WebSocket）、DEF-042 の設計書（2.4 の閉じる途中の扱い）、Task 11 の設計（Isolated Interaction の結果の区分）、`src/browser/chromium-launch.ts`（CLI の起動の引数の owner）

## 1. DEF-044 Shared Worker の中の送信

### 1.1 起きていること

- Playwright は `shared_worker` の target に session を付けないので、Shared Worker の中の要求は `context.route` を通らない。Guard の CDP の横取りも page と OOPIF の session だけ。Shared Worker の中の fetch・XHR・keepalive の POST が、Passive と凍結の前の Interaction で、両方の Chromium でサーバに届く（6/6）。記録なし、違反 0。

### 1.2 決めたこと

- **Shared Worker を、Chromium の起動の引数で無効にする**（`typeof SharedWorker` が `undefined` になる。ページは機能の検出で Dedicated Worker などに切り替える。切り替えないページでは、Shared Worker に依存する機能が動かない。監査の結果が変わりうるので、README に書く）。
  - 引数は `src/browser/chromium-launch.ts` の閉じた一覧 `CHROMIUM_SHARED_WORKERS_DISABLED_ARGS` に置く（`--disable-shared-workers` か `--disable-blink-features=SharedWorker`。両方の Chromium（headless shell と `chrome.exe`）で `typeof SharedWorker === 'undefined'` になるものを選ぶ。`--disable-blink-features` は Playwright の既定の値を上書きしないか確かめる。DEF-023 の `--enable-features` の教訓）。CLI の `chromiumLaunchOptions` と、テストの起動の補助 `tests/helpers/chromium.ts` の両方がこの一覧を使う（テストの Chromium にも付ける。付けないテストが要る場合は、明示の選択にする）。
  - 理由: Guard の層で Shared Worker の要求を横取りするには、Browser の CDP の session で `shared_worker` の target に自動で付き、所属の Context を `browserContextId` で対応づけて段階ごとに判定する必要があり、Guard の変更が大きい（将来の候補として記録。CC-051）。CSP の `worker-src` は Dedicated Worker も止めるので使えない。
- **fail-closed の自己検査**: factory が、Browser の CDP の session（`browser.newBrowserCDPSession()`）で `Target.setDiscoverTargets({ discover: true })` を行い、`Target.targetCreated` で `type === 'shared_worker'` の target を見たら、引数が効いていないとみなし、その時点で factory が所有するすべての Context の Ledger に違反 `SHARED_WORKER_OBSERVED` を記録して、その Context を閉じる（Run は `ABORTED_BY_SAFETY`）。所属の Context の対応づけはしない（同時に動く Context は 1 つなので、すべてを閉じる側に倒す）。Browser の session を開けない場合は、factory の構築の失敗（`TypeError` ではなく、その例外をそのまま投げる。Run は始まらない）。session は factory の `close()` で閉じる。
- Guard は変えない。

### 1.3 テスト

- RED: Shared Worker からの fetch POST・XHR POST・keepalive POST の fixture（レビュー担当の `scratchpad/npr/workers.mjs` の形）で、Passive の Context と凍結の前の Interaction で、両方の Chromium で POST が届く → 引数の後は、Shared Worker が作れず（`typeof SharedWorker === 'undefined'`。fixture が `data-*` に残す）、届かない、違反 0。Gate: GATE-S01/S02 に加える（両方の Chromium）。
- 自己検査: 引数なしで起動した Chromium（テストの中だけ。明示の選択）で Shared Worker を作ると、違反 `SHARED_WORKER_OBSERVED` が記録され Context が閉じる。引数ありでは記録されない。
- 既存: Dedicated Worker の場面（DEF-040 の Gate）が変わらない。`fixture-full-crawl`、`cli.test.ts`。

## 2. DEF-045 凍結の段階の閉じる途中の失敗

- `handlePausedRequest`（と Document の凍結の分岐）で、owner の close を始めた後（`FROZEN_CLOSING`、`FROZEN_INVALIDATING`、`closeAttempt` あり）に、命令が `isClosedTargetFailure` の形で失敗した場合は、違反にしない（記録は、止める前に記録しているなら残す）。owner の close を始める前の凍結の段階（`FROZEN_ACTIVE`）の同じ失敗は、今までどおり違反。
- テスト: 偽の harness で、凍結 → owner の close → 閉じた失敗、で違反 0。実機で、1 ms ごとに POST を出すページの凍結 → `session.close()` を名前つきの回数くり返し、違反 0、届いた要求 0（両方の Chromium）。

## 3. DEF-046 中継の記録と結果の区分

- `isolated-auditor.ts` の `hasFreezeEvent` は、`blockedInteractionRequests` のうち理由が `INTERACTION_FROZEN`（Guard が止めた、ページの要求）のものだけを数える。中継の記録（`INTERACTION_FROZEN_EGRESS`、`EGRESS_UPSTREAM_DENIED`）は数えない（Ledger には残す。理由: 中継はネットワークの層の記録で、Chromium 自身の通信を含み、ページの操作の証拠として使えない。ページの凍結中の操作は Guard の記録とポップアップの記録で捕らえる）。
- README: Interaction の環境の通信が中継を通ることの説明に、BeakSight の Node の process が Chromium の代わりに上流へ TCP 接続を開くこと（露出は増えない）と、Chromium 自身の通信が中継の記録に載りうるが結果の区分には使わないことを加える。
- テスト: `hasFreezeEvent` の単体（中継の記録だけでは BLOCKED にならない。Guard の記録なら BLOCKED）。GATE-S04 の DEF-039 の場面の期待（`BLOCKED_BY_SAFETY` は `blockedPopups` によるので変わらない）。


## 5. DEF-049 Service Worker の遮断の回避（2026-10-08 追補。NPR2 の C1）

### 5.1 起きていること

- Playwright の `serviceWorkers: 'block'` は init script で `navigator.serviceWorker.register` を上書きするだけで、`ServiceWorkerContainer.prototype.register.call(...)` や `delete` の後の呼び出しで回避できる。登録が成功すると、Service Worker の中の POST が Passive でも凍結の前でも届く（Guard の CDP と route は Service Worker の要求を見ない）。

### 5.2 決めたこと（二重の防御）

- **Browser の CDP の session で Service Worker の target を止める（主）**: factory の見張り（DEF-044 の session）に、`Target.setAutoAttach({ autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'service_worker', exclude: false }] })` を加える（`setDiscoverTargets` と併用できなければ、`attachedToTarget` の `type === 'service_worker'` を自己検査の引き金にする）。Service Worker の target が付いたら、**`Runtime.runIfWaitingForDebugger` を送らず、止めたままにする**（Service Worker の script は動かない。install の POST も出ない）。そのうえで、所有するすべての Context の Ledger に違反 `SERVICE_WORKER_OBSERVED` を記録して閉じる（fail-closed。DEF-044 と同じ経路）。Service Worker の script の GET は、target が付く前にブラウザが行うので止められない（読み取りの要求。残る制約として記録）。
- **Guard の init script で登録の入口を塞ぐ（従）**: Guard の `addInitScript`（DEF-040 の meta の CSP のスクリプトと同じ場所）で、`ServiceWorkerContainer.prototype.register` を、例外を投げて何もしない関数に置き換え、`Object.defineProperty` で書き換えられないようにする（`navigator.serviceWorker` の getter も同じく）。すべての frame（iframe、about:blank を含む）に効く。回避の試み（例外）は、ページの console に出る（Evidence に写る。それでよい）。
- テスト: GATE-S08 に、`prototype.register.call` と `delete` の後の呼び出しの 2 つの回避の場面（両方の Chromium）を加える。init script だけ（主を外した状態）と、主だけ（従を外した状態）のそれぞれで止まることを、部品のテストで確かめる（二重の防御の各層が単独で効くこと）。自己検査のテスト（引数ではなく、従を外した Chromium で登録 → `SERVICE_WORKER_OBSERVED` と Context が閉じ、install の POST が届かない）。

## 6. DEF-050 Document の閉じる途中の分岐（2026-10-08 追補。NPR2 の I1）

- `failPausedDocumentForLifecycle` で、閉じる処理が始まった後（owner の close、無効化。Passive と凍結の両方）の `isClosedTargetFailure` の失敗は、違反にしない（DEF-045 の `hasFrozenCloseStarted` と同じ考え。Passive の閉じる途中も含める）。閉じる処理の前の同じ失敗は、今までどおり違反。DEF-042 の設計書 2.2 の「Document の横取りは変えない」は、この点に限り置き換える。
- テスト: 偽の harness（Passive の閉じる途中、凍結の閉じる途中で違反 0。閉じる前は違反）。実機で、iframe の `src` を 1 ms ごとに変えるページで Context を閉じる（両方の Chromium。名前つきの回数）、違反 0、届いた要求 0。

## 7. M3（表示の説明）

- `catalog.ts` の `blockedInteractionRequests` の説明に、中継の記録には Chromium 自身の通信（例: Google への接続）が含まれうることを加える。

## 8. 設計変更履歴

| 日付 | 契機 | 変更内容 | 影響範囲 |
| --- | --- | --- | --- |
| 2026-10-08 | 初版（独立レビュー NPR-T21R2） | - | `chromium-launch.ts`、`tests/helpers/chromium.ts`、`context-factory.ts`、`passive-request-guard.ts`、`isolated-auditor.ts`、Gate、README |
| 2026-10-08 | NP5 の Blocker（factory の構築が同期、`close()` がない、既存の Shared Worker のテスト） | 1.2 を次のとおり確定: constructor で Browser の session を開き始め、最初の Context の作成の前に待つ（開けなければ Context の作成で失敗）。factory に `close()` を加える（production は `browser.close()` に任せる）。引数はテストの Chromium の既定にも付け、既存の Shared Worker の場面は「作れない」を期待する形に変える。自己検査のテストだけ引数を外す明示の選択。`#activeContexts` を `Set` に。引数は `--disable-shared-workers`（Playwright の既定と衝突しない） | `context-factory.ts`、`chromium-launch.ts`、`tests/helpers/chromium.ts`、Gate |
| 2026-10-08 | NP5-round-1 の報告 | factory の `close()` の後は Context を作らず例外にする（自己検査のない Context を作らないため。設計者が採用）。自己検査は target と Context を対応づけず、所有するすべての Context を閉じる。テストの補助に `sharedWorkers: 'disabled' | 'allow'` と `launchCliChromium` | 記述 |
| 2026-10-08 | 独立レビュー NPR2（C1、I1、M3） | 5（DEF-049: Service Worker の target を止めたままにする自己検査 + Guard の init script で `prototype.register` を塞ぐ）、6（DEF-050: Document の閉じる途中の閉じた失敗は違反にしない）、7（M3）を加えた | `context-factory.ts`、`passive-request-guard.ts`、`catalog.ts`、GATE-S08 |
| 2026-10-08 | NP6 の Blocker（Playwright 自身が Service Worker の target に `Runtime.runIfWaitingForDebugger` を送るので、止めたままにできない。`Target.closeTarget` でも POST が届く。init script は単独で全経路（prototype の呼び出し、delete の後、同じ Origin の iframe、about:blank・srcdoc の iframe、ポップアップ、定義し直し）を止めた） | 5.2 の主従を入れ替える: **主 = Guard の init script**（`ServiceWorkerContainer.prototype.register` を例外を投げる関数に置き換え `writable: false`・`configurable: false`、`Navigator.prototype.serviceWorker` の getter を `configurable: false`）。**自己検査 = Browser の session の `setAutoAttach`（`service_worker`）で `attachedToTarget` を受けたら、所有するすべての Context に `SERVICE_WORKER_OBSERVED` を記録して直ちに閉じる**（止める保証はなく、実験では 40/40 で POST の前に閉じた。検出と停止として扱い、README に書く）。Service Worker の script の GET は止められない（残る制約）。`serviceWorkers: 'allow'` + route の案は、Service Worker が動いて監査の振る舞いが変わるので採らない。テストの受け入れ条件: init script だけで 2 経路とも止まる（届いた要求 0、登録 0）。自己検査は、init script を外した状態で、違反の記録と Context が閉じることを確かめる（届いた要求の数は記録するが条件にしない） | NP6-round-1 |
| 2026-10-08 | 独立レビュー NPR3（承認。Minor 3 件） | 7 に追記: `INTERACTION_FROZEN` にも Chromium 自身の要求（`GET /favicon.ico`）が含まれうることは、DEF-047（Chromium 自身の通信の正体）を調べてから説明を直す（今は書かない）。GATE-S08 の回帰にポップアップと OOPIF の経路を加えるのは将来の候補 | なし（記述） |
