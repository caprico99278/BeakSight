# BeakSight サイトの不調で止めたときの診断の記録 設計書

- 状態: ユーザーの指示（2026-10-06「診断用の記録を残す改善も進めて」）を反映した設計。実装の後に独立レビューを受ける。
- 関係する文書: サイトが応答しないときに Run を止める設計書（`2026-10-05-beaksight-site-unavailability-stop-design.md`）、DEF-027 の設計書、実装タスク指示（Owner Matrix、ARCH08）、共通部品台帳

## 1. 目的

### 1.1 起きたこと

- Task 21 の3回目の Run（2026-10-06）の1回目の起動は、13ページ目のモバイルの Passive の読み込みに30秒応答がなく、サイトの不調として止まった。
- 原因（サイト側の一時的な停滞か、サイト側の防御か、BeakSight 側か）を、手元の記録で決められなかった。止まるきっかけのページは、設計どおり結果に残さずに捨てるので、その読み込みの記録が消えるためである。また、応答がない場合は、今の Network の Evidence からは、要求が実際にネットワークへ送られたかが分からない（Playwright の時刻の項目は、応答がないと -1 のまま）。

### 1.2 解決すること

- 次に同じことが起きたときに、少なくとも「要求がネットワークへ送られたのに応答がなかった（サイト側）」か「送られなかった（BeakSight 側か、接続の段階）」かを、記録で見分けられるようにする。
- 安全の不変条件と、監査の結果（`run.json`、`audit.json`、ページの結果）は変えない。診断の記録は、結果とは別のファイルにする。

## 2. 決めたこと

### 2.1 ページ本体の要求の観察（`src/browser/navigation-diagnostics.ts`。新設）

- Passive の各ビューポートの読み込み（`navigatePage`）の間、その page に、Guard とは別の CDP の session（`context.newCDPSession(page)`）を開き、`Network.enable` だけを行って、main frame の文書の要求の事象を観察する。Fetch の domain は使わない（要求を止めたり変えたりしない）。
- 記録する事実（main frame の文書の要求ごと。リダイレクトは、同じ要求の続きとして記録する）:
  - `Network.requestWillBeSent` を受けた時刻（ページの要求の発行）。
  - `Network.requestWillBeSentExtraInfo` を受けたか、その時刻（要求のヘッダがネットワークへ送られた）。
  - `Network.responseReceivedExtraInfo` と `Network.responseReceived` を受けたか、その時刻と status（応答のヘッダを受けた）。
  - `Network.loadingFinished` か `Network.loadingFailed`（`errorText`、`canceled`）と、その時刻。
  - 応答の接続先の IP アドレスと port（`responseReceived` の `remoteIPAddress`、`remotePort`。あれば）。
- **記録しないもの**: 要求と応答の header の中身（Cookie を含むため）、本文。
- 時刻は、`Date.now()` と同じ基準の ms（壁時計）で記録する（CDP の `wallTime` があれば使い、なければ受けた時刻）。
- 上限: 1つのビューポートで、文書の要求は最大 16 件、事象は最大 128 件まで覚える（超えた分は数だけ数える）。
- 観察の失敗（CDP の session を開けない、など）は、監査を止めない。記録に「観察できなかった」ことと理由を残す。
- 観察の session は、読み込みの後に必ず閉じる（`detach`）。page が閉じた場合も、例外を外に出さない。
- 判定はしない（サイトの不調の判定は `site-availability.ts`）。
- 観察の部品が自分で送る命令は `Page.getFrameTree`（読むだけ）と `Network.enable` だけである。ほかに、session を開くときと閉じるときに、Playwright 自身が `Target.attachToTarget`（root の session）、`Runtime.runIfWaitingForDebugger`、`Target.detachFromTarget` を送る。どれも要求を止めたり変えたりしない（2026-10-06 追補。独立レビュー PCR-DR の Minor-2）。

### 2.2 Page Auditor

- Passive の各ビューポートで、`navigatePage` の前に観察を始め、後に止め、結果をビューポートの中間の結果に持たせる。
- `PageAuditOutcome` に、ビューポートごとの観察の結果（例: `navigationDiagnostics`）を加える（ページの結果（`PageAuditResult`）と Evidence には入れない）。
- 幅の走査と Interaction の候補の読み込みも、対象にする（2026-10-07 改訂。ユーザーの指示。2026-10-06 の停止 4 件のうち 3 件が、幅の走査と Interaction の読み込みで起き、観察の対象外だったため）。robots.txt と sitemap.xml は、対象にしない。
  - 幅の走査: `collectStressLayout` は、各幅の `page.goto` の前に観察を始め、後に `finish` し、結果を受け口（例: `afterNavigation(observation, diagnostics)`）で Page Auditor に渡す。読み込みを始めなかった幅では渡さない。
  - Interaction: `loadInteractionTarget` は、候補の `page.goto` の前に観察を始め、後に `finish` し、結果を受け口（例: `afterTargetLoad(observation, diagnostics)`）で渡す。
  - 観察の開始と終わりは、その読み込みの期限を消費してよいが、長く待たない（`finish` は `detach` の終わりを待たない。D1 と同じ）。観察を始められなくても、読み込みは今までどおり行う。
  - 観察の結果は、`PageAuditOutcome.navigationDiagnostics` に、ビューポートごとに Passive の結果に加えて、幅ごと（幅の値つき）と候補ごと（候補の順の番号つき）の配列で持たせる。production の振る舞い（読み込み、判定、監査の結果、Evidence、Finding）は変えない。
  - 診断のファイルのスキーマ（2.3）に、幅ごとと候補ごとの観察の結果を加える。

### 2.3 診断のファイル（Run Coordinator と ArtifactWriter）

- Run Coordinator は、次の場合に、診断のファイルを1つ書く:
  - サイトの不調でページを捨てた場合（サイトが応答しないときに Run を止める設計書 3.2）。
  - 前の実行のきっかけのページが、また不調で、普通の結果として保存した場合（3.2.1）。
- 中身（JSON。スキーマ `schemas/site-unavailable-diagnostic.schema.json` で検証してから書く）:
  - `schemaVersion`、`runId`、何回目の実行か、書いた時刻
  - ページの ID、URL、不調の詳細（`siteUnavailableDetail`）
  - そのページの監査の結果（`PageAuditResult`。ページのスキーマのまま。捨てた試行の Evidence を含む）
  - ビューポートごとの、2.1 の観察の結果
- 置き場所: Run のディレクトリの `diagnostics/site-unavailable-<pageId>-<実行の番号>.json`（置き場所の名前は `artifact-layout.ts` の1か所で決める）。
- 書くのは `ArtifactWriter` だけ（ARCH08）。書くのに失敗しても、監査を止めない（Run の理由の `UNHANDLED_FAILURE` などにはせず、標準エラーにも出さない。診断は付けたしの情報のため）。失敗したことは、Run の理由にも残さない。
- `checkpoint/` の片付け（Run の終わり）で消さない（`checkpoint/` の外に置く）。
- robots.txt と sitemap.xml の段階で止めた場合は、このサブタスクでは書かない。

### 2.4 README

- 「サイトが応答しないとき」に、診断のファイルの置き場所と読み方（要求のヘッダが送られて応答がなければサイト側、送られていなければ BeakSight 側か接続の段階）を書く。

## 3. SSOT と安全性への影響

| 項目 | owner | 扱い |
| --- | --- | --- |
| ページ本体の要求の観察 | `src/browser/navigation-diagnostics.ts`（新設） | 共通部品台帳に加える |
| 診断のファイルの置き場所 | `src/core/artifact-layout.ts` | 加える |
| 診断のファイルの書き出し | `src/report/artifact-writer.ts` | 加える（ARCH08） |
| 診断のファイルの形 | `schemas/site-unavailable-diagnostic.schema.json`（新設） | ページのスキーマを参照する |

- 安全の不変条件: 変えない。観察の session は `Network.enable` だけで、要求を止めたり、変えたり、作ったりしない。Guard は変えない。
- 監査の結果: 変えない（`run.json`、`audit.json`、ページの結果、スキーマ）。

## 4. テスト設計

- 観察（実際の Chromium、Guard の付いた Context、127.0.0.1 のサーバ）:
  - ふつうの 200: 要求の発行、ヘッダの送信、応答、終わりが記録される。
  - 応答しないサーバ: ヘッダの送信は記録され、応答は記録されない。
  - 要求が送られない場合（テストの中で、別の CDP の session の Fetch で文書の要求を止めたままにする）: 発行は記録され、ヘッダの送信は記録されない。
  - 観察の session を開けない場合: 監査は続き、観察できなかったことが記録される。
  - 記録に header の中身がない。
- Run Coordinator（単体）: ページを捨てた場合と、きっかけのページを普通に保存した場合に、ArtifactWriter に診断の記録が渡る。書くのに失敗しても、Run の結果は変わらない。
- ArtifactWriter（単体か結合）: スキーマで検証してから書く。置き場所。
- 結合（`tests/integration/cli-site-unavailable.test.ts` に加える）: 応答しなくなる場面で、`diagnostics/` にファイルが1つでき、観察の結果に「ヘッダを送った、応答なし」が記録される。Run の終わりの片付けの後も残る。

## 5. 設計変更履歴

| 日付 | 契機 | 変更内容 | 影響範囲 |
| --- | --- | --- | --- |
| 2026-10-06 | 初版（ユーザーの指示。Task 21 の3回目の Run の1回目の停止の原因を、記録で決められなかった） | - | Page Auditor、Run Coordinator、ArtifactWriter、スキーマ、README |
| 2026-10-06 | 独立レビュー PCR-DR の Minor-2、Minor-3 | 2.1 に、Playwright が session の開閉で送る命令を書いた。README の「header の中身を記録しない」は、ページ本体の要求の観察についての説明と分かるように直す（`page` の network の Evidence には、出力のページの結果と同じく、許可した header の値が入る。Cookie は伏せ字） | README |
| 2026-10-07 | ユーザーの指示（停止 4 件のうち 3 件が観察の対象外だった） | 幅の走査と Interaction の候補の読み込みも観察の対象にした（2.2）。診断のファイルに幅ごと・候補ごとの観察を加える（2.3） | `layout-collector.ts`、`isolated-auditor.ts`、`page-auditor.ts`、`contracts.ts`、スキーマ、`run-coordinator.ts` |
| 2026-10-07 | D3 の報告 | `PageAuditOutcome.navigationDiagnostics` はビューポートごとに `{ passive, stressWidths, interactionCandidates }`。`null` は SKIPPED のビューポートだけで、Passive の Context を作れなかったビューポートは `passive: null` と空の配列。幅の記録の上限は `MAX_STRESS_WIDTH_NAVIGATION_DIAGNOSTICS`（64。`contracts.ts`）。診断のファイルの `schemaVersion` は 1.1（スキーマの内部の `$id` は 1.0 のまま。ほかから参照されない内部の識別子なので変えない） | なし（記述） |
