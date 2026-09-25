# BeakSight Task 14〜17 ページ監査・Run・レポート・CLI 設計書

作成日: 2026-09-23
状態: ユーザー承認済みの範囲内で設計者が確定（2026-09-23 のユーザーの開発指示に基づく）
対象範囲: 実装計画 Task 14（ページの監査の流れ）、Task 15（Run Coordinator）、Task 16（artifact・HTMLレポート・ChatGPT用バンドル）、Task 17（CLI）の詳細

## 1. 目的

実装計画の Task 14〜17 は、各モジュールの入口と処理の順序を定めている。しかし、次のことはまだ決まっていない。

- Evidence の ID の採番の持ち主
- ページの状態をまとめる規則
- 内部リンク切れの判定の置き場所
- 再試行の対象
- レポートとCLIの表示の分担

この設計書で、これらを決める。表示の分担は、UI追補設計書（`2026-09-23-beaksight-ui-ssot-design.md`）に従う。

## 2. 根拠となる文書と優先順位

- 従う文書: 実装タスク指示、実装計画 Task 14〜17、設計書（第9〜11章、第18〜22章、第26〜28章、第35章）、UI追補設計書、基盤修正の設計書、Task 12・13 の設計書。
- この設計書が置き換える箇所: Task 12・13 の設計書 5.1 の `BROKEN_INTERNAL_LINK` と `TARGET_NAVIGATION_FAILED` を、Cross-page rule に移す（第5.3節）。
- 引き続き守る不変条件:
  - Link は `discoverLinks()` で1回だけ抽出し、その結果を再利用する（ARCH03）。
  - Run Status は `deriveRunStatus()` だけが決める（ARCH05）。
  - JSON の検証は `validateArtifact()`、最終的な書き出しは `ArtifactWriter.writeRun()` だけが行う（ARCH08）。
  - Reporter は判定しない。
  - 実サイトにアクセスしない（開発中は fixture だけを使う）。

## 3. Evidence の ID の採番

- Evidence・Page・Finding の ID は、`src/core/ids.ts` の関数で作る。
- 連番は、Run ごとに1つの採番器（`IdAllocator` のような小さなクラス）が持つ。この採番器は Run Coordinator が作り、Page Auditor に注入する。
- 採番器を DI するのは、ID が Run の中で一意で、処理の順序に対して決定論的になるようにするためである。
- collector は ID を付けない。Page Auditor が、collector の出力を `EvidenceRecord`（ID 付き）に包む。

## 4. Task 14: ページの監査の流れ

### 4.1 処理の順序

`PageAuditor.audit(url, pageId, viewportProfile)` は、1つのビューポートについて、次の順に処理する（実装計画 Task 14 Step 2 に、基盤修正で加わった処理を足したもの）。

1. Passive Context を作る（ダウンロードは受け付けない）。
2. collector（network・console・performance）を取り付ける。
3. ナビゲーションする。
4. DOM の準備を待つ。
5. controlled scroll を行う。遅延読み込みを落ち着かせ、終わったら先頭に戻す。結果は、Evidence の種類 `scroll` として記録する（走査が上限に達したこと、PARTIAL の理由を含む）。
6. DOM、layout、配色、accessibility（期限付き）、performance を収集する。
7. スクリーンショットを撮る（先頭の位置で viewport、その後に full-page）。
8. Link を抽出する（`discoverLinks()` を Desktop のビューポートのときだけ呼ぶ。戻り値は `LinkDiscoveryEvidence` で、Evidence の種類 `link` として1回だけ記録する）。
9. page rule を評価する（`RuleEngine`）。
10. 設定で有効なら、Interaction を、隔離された Context で監査する（Desktop のときだけ）。
11. Context を閉じる（`finally` で必ず閉じる）。
12. 不変な結果を返す。

### 4.2 ページとビューポートの状態

- ページの結果は、ビューポートごとの状態（Desktop と Mobile）を持つ（基盤修正の C8）。
- ビューポートの状態が `AUDITED` になるのは、必須の collector がすべて COMPLETE で終わり、Rule の評価に失敗がない場合だけである。
- どれかが PARTIAL・失敗・期限切れの場合、そのビューポートは `PARTIAL` になり、構造化された理由を持つ。
- ナビゲーション自体が失敗した場合は、`FAILED` になる。
- ページ全体の状態は、ビューポートの状態の中で最も悪いものにする（`FAILED` ＞ `PARTIAL` ＞ `AUDITED`）。
  - `SKIPPED` の扱い（2026-09-24 P14a の判断を承認）
    - すべてのビューポートが `SKIPPED` の場合は、ページも `SKIPPED` にする。
    - 一部だけが `SKIPPED` の場合は、ほかが `AUDITED` でも `PARTIAL` にする。ほかに `FAILED` があれば `FAILED` にする。
    - 監査していない部分があるページを、完了と報告しないためである。
  - 集計は、`derivePageAuditStatus`（`src/core/status.ts`）だけが行う。ビューポートごとの状態と Finding は、ページ全体の集計の中に埋もれさせない（実装計画 Task 14 Step 3）。

### 4.3 Safety

- ページごとの Safety Ledger の事象は、Evidence として `PageAuditResult` に含める。Task 12・13 の設計書 5.4 の safety rule は、この Evidence を入力にする。
  - Evidence の形と単位は、Task 12・13 の設計書 5.4.1 に従う。1つの Ledger につき、`safety` の Evidence を1つ作る。
  - Page Auditor は、各 Ledger の snapshot から、Evidence を作る。
  - Interaction の Ledger の Evidence は、Desktop の Rule の入力に含める。
- Evidence の種類を加える場合は、次の3つも変更の対象に含める（T12d の発見事項）。
  - `src/core/ids.ts` の接頭辞の表
  - `tests/unit/schema-validator.test.ts` の見本の表
  - `schemas/page.schema.json` の分岐
- Context の構築に失敗した場合も、その Context の Ledger を、Safety の Evidence と `PageSafetySummary` の集計に含める（R14 の I2、R14r の Important-1）。Guard の取り付けの失敗は、Ledger に違反として記録されるためである。
  - `BrowserContextFactory` は、Context の構築に失敗した場合、Context が閉じられたかどうかに関係なく、`ContextConstructionError` を投げる。このエラーは、その Context の Ledger を持つ。
  - factory は、失敗した Context と Ledger の対応を消さない。
  - Passive、Interaction の session、幅の走査の session の、3つの経路のどれでも、この Ledger を集計する。
- Interaction の監査で `InteractionOwnerCleanupError` が起きた場合、Page Auditor は、エラーが保持する session で `close()` を1回試みる。そのうえで、ページを `PARTIAL` にし、理由を記録する。
- `close()` が reject しても、`isClosed()` が真なら、Context は閉じられている。この場合も異常として記録する（基盤修正の設計書 4.1）。

### 4.3.0 ナビゲーションの結果（2026-09-24 追加）

- Page Auditor は、ページとビューポートごとに、ナビゲーションの結果を記録し、`PageAuditResult` に含める。
  - 記録するのは、要求したURL、最終URL、結果の種類（`OK`、`TIMEOUT`、`FAILED`、`BLOCKED_EXTERNAL_REDIRECT`）である。
  - これは、Cross-page rule の `NAVIGATION_TIMEOUT` と `UNEXPECTED_ORIGIN_REDIRECT` の入力になる（Task 12・13 の設計書 第7章）。
- `BLOCKED_EXTERNAL_REDIRECT` は、次の2つの条件を満たすときに使う。
  - メインフレームのナビゲーションが、Guard の `EXTERNAL_MAIN_FRAME_NAVIGATION` で遮断された。
  - その遮断によって、ナビゲーションが失敗した。
- 結果の種類の一覧は、core に `as const` の配列として置く。（T13b で `NAVIGATION_OUTCOME_KINDS` として置いた）
- 結果の種類は、`ViewportAuditResult` に `navigationOutcome` として加える（T13b の判断を承認）。
  - 要求したURLと最終URLは、既存の `requestedUrl` と `finalUrl` を使う。
  - スキップしたビューポートでは、null にする。
  - `src/core/contracts.ts`、`schemas/page.schema.json`、enum の一致のテストの対応表を、あわせて直す。
  - 加えた後に、`src/audit/cross-page-rules.ts` の `CrossPageViewportResult` を、`ViewportAuditResult` の別名にする。
- ナビゲーションが失敗した場合（期限切れ、遮断、そのほかの失敗）も、Page Auditor は、そのビューポートの network の Evidence を必ず記録する。
  - Cross-page rule の `NAVIGATION_TIMEOUT` と `UNEXPECTED_ORIGIN_REDIRECT` は、network の Evidence を参照する。参照できる Evidence がないと、Finding を作らない。
  - このため、記録を欠かすと、ERROR の Finding が知らせなく消える。統合テストで確かめる。

### 4.3.1 Interaction の候補の渡し方

Page Auditor は、発見した Interaction の候補を、機械的に除外されるものも含めて、`auditInteraction()` の受け入れの判定（`classifyInteractionCandidate` とその記録）に渡す。除外される候補を、呼び出しの前に取り除いてはいけない。取り除くと、除外の事実が Safety Ledger に記録されず、実装タスク指示 第7章（ブロックした処理を隠さずに記録する）を満たせないためである（2026-09-23 R1 の申し送り）。

候補の件数の上限は、`INTERACTION_CANDIDATE_LIMITS` に従う。上限を超えた候補は、件数を記録する。

`auditInteraction()` には、設定の `crawl.navigationTimeoutMs`（読み込みの期限）と `crawl.interactionTimeoutMs`（読み込みの後の Interaction の期限）を渡す（基盤修正の設計書 4.4.1、F18）。

全体の期限（`deadlineAtMs`）は、次の3つの和以上にする（R7 の Minor-2）。そうしないと、読み込みの遅いページで、動くボタンが NOT_VERIFIABLE になる問題が、再び起きる。

- 呼び出した時刻からの、読み込みの期限（session を作る時間を含む）
- Interaction の期限
- 後片付けの時間

計算は、Page Auditor の中の1か所で行う。

### 4.4 Link の再利用

- `discoverLinks()` の結果（`LinkDiscoveryEvidence`）は、Evidence の種類 `link` として、`PageAuditResult` に1回だけ入れる。DOM の Evidence には、Link の複製を持たせない（2026-09-23 R'2 の m3）。
- Run Coordinator は、それを再利用してキューに入れる（ARCH03）。
- Link の再抽出はしない。

### 4.5 実装の詳細の決定（2026-09-24。Task 14 の着手前の調査を受けて追加）

着手前の調査で、部品をつなぐときの矛盾と、決まっていない点が見つかった。この節で、それらを決める。この節は、4.1〜4.4 と実装計画 Task 14 に優先する。

#### 4.5.1 入口と戻り値

- 入口は、`PageAuditor.audit(url, pageId): Promise<PageAuditOutcome>` とする。
  - 1回の呼び出しで、Desktop と Mobile の両方のビューポートを、この順に監査する。
  - 実装計画の `audit(url, pageId, viewportProfile)` を置き換える。理由は、`PageAuditResult.viewports` が両方のビューポートを必須にしていて、1回の呼び出しで正しい値を作れないためである。
  - ビューポートごとの処理は、内部の `auditViewport()` が行う。`auditViewport()` は、中間の結果を返す。
- `PageAuditOutcome` は、次の2つを持つ。
  - `result: PageAuditResult`
  - `safety: PageSafetySummary`
    - このページで作ったすべての Safety Ledger について、違反の件数と、記録が不完全かどうかを集計したもの。
    - `PageAuditResult` の外に置く。Evidence の中身には、違反を含めないためである（Task 12・13 の設計書 5.4.1）。
    - Run Coordinator は、これを Run Status の入力（`safetyInvariantViolations`、`safetyLedgerTruncated`）に集計する。

#### 4.5.2 ビューポートごとの処理の順序

4.1 の順序を、次のように改める。

1. Passive Context を作る。
2. collector を取り付ける（performance の init script、network、console）。
3. ナビゲーションする（4.5.4）。
   - ナビゲーションが失敗した場合は、次の3つを行ったうえで、6 に進む。
     - network と console の Evidence を記録する（4.3.0）。
     - ビューポートの状態を `FAILED` にする。
     - 以降の収集をしない。
4. DOM の準備を待ち、controlled scroll を行う。結果は、`scroll` の Evidence として記録する。
5. 収集を行う。
   - DOM、layout（Desktop では幅の走査を含む。4.5.6）、配色、accessibility、performance を集める。
   - スクリーンショットを撮る。
   - Link を抽出する（Desktop だけ）。
   - Interaction を監査する（Desktop だけ。設定で有効な場合）。
6. Safety の Evidence を作る。次の3種類の Ledger について、1つずつ作る。
   - Passive の Ledger
   - Interaction の Ledger（Desktop だけ）
   - 幅の走査の Ledger
7. page rule を評価する（`RuleEngine`）。
8. Passive Context を閉じる（`finally` で必ず閉じる）。

- 理由（実装計画の「rule の評価の後に Interaction」を改めた理由）: Rule を評価するときには、Interaction の Safety の Evidence が、Rule の入力にそろっていなければならない（4.3）。
- Interaction は、Passive Context とは別の、隔離された Context で行う。そのため、Passive Context を閉じる前に行っても、Passive の観測には影響しない。
- Link の抽出は、Interaction より前に行う。

#### 4.5.3 採番

- 採番器は、`src/orchestration/id-allocator.ts` の `IdAllocator` とする。
  - Page、Evidence（種類ごとではなく、Run で1つの連番）、Finding の連番を持つ。
  - Run Coordinator が作り、Page Auditor と Cross-page rule の呼び出しに注入する。
- Finding の採番は、次の手順で行う。
  1. 評価のたびに、`RuleEngine` を、採番器の現在の Finding の連番で作る。
  2. 評価の結果の `nextFindingSequence` を、採番器に戻す。
- `RuleEngine` のインスタンスを使い回さない。使い回すと、ID が重複するためである。
- `EvidenceRecord` の `observedAt` は、注入した時計（`() => Date`）の ISO 8601 の文字列にする。
- `EvidenceRecord` を組み立てる処理は、1つの関数にまとめる。

#### 4.5.4 ナビゲーションの結果

- ナビゲーションは、`page.goto(url, { waitUntil: 'domcontentloaded', timeout })` で行う。`timeout` は、設定の `navigationTimeoutMs` とする。
- 結果の種類は、次の規則で決める。
  - 応答を得た場合は、`OK` とする。`httpStatus` は、応答のステータスとする。4xx・5xx も `OK` である。4xx・5xx の判定は、Rule が行う。
  - Playwright の期限切れの場合は、`TIMEOUT` とする。
  - 失敗の前後で、Passive の Ledger の `blockedNavigations` が増えていた場合は、`BLOCKED_EXTERNAL_REDIRECT` とする。
  - それ以外は、`FAILED` とする。
- 最終URLは、`page.url()` を正規化したものとする。正規化できない場合は、null とする。
- `OK` 以外の場合の記録:
  - ビューポートの状態は、`FAILED` とする。
  - 理由は、`NAVIGATION_FAILED` とする。`detail` には、結果の種類を書く。
  - この決まりは、Cross-page rule（`isNavigationFailure`）の前提と一致させる。
- 描画プロセスが落ちた場合（crash）は、ビューポートの状態を `FAILED` にする（2026-09-23 の判断）。
  - 理由には、`PAGE_CRASHED` のコードを使う。crash したことを、結果から読み取れるようにするためである。crash した段階の理由は、`<段階>:PAGE_CRASHED` とする（2026-09-24 P14c の判断）。
  - 制約: 読み込みの途中で描画プロセスが落ちると、Playwright は `crash` ではなく `close` を出す。そのため、結果は `TIMEOUT` になり、crash したことは残らない（P14e）。まれな場合なので、受け入れる。
- `navigationOutcome` は、`ViewportAuditResult` に加える（4.3.0）。

#### 4.5.5 理由のコードと、例外を投げる collector

- 処理の段階の名前を、core に `PAGE_AUDIT_STAGES` として `as const` の配列で置く。
  - 例: `navigation`、`settling`、`scroll`、`dom`、`layout`、`stress-layout`、`color`、`accessibility`、`performance`、`screenshot`、`links`、`interaction-discovery`、`interaction`、`safety`、`rules`
- collector が PARTIAL を返した場合と、例外を投げた場合は、次のように扱う。
  - その段階の Evidence は、得られた分だけ記録する。
  - ビューポートの状態を、`PARTIAL` にする。
  - 理由は、`COLLECTOR_INCOMPLETE` とする。`detail` は `<段階>:<理由>` の形にする。
    - `<理由>` は、collector の PARTIAL の理由か、例外のときは `pageFailureReason(page)` の値とする。
- 例外として、次の段階は、既存の専用のコードを使う。
  - ナビゲーション: `NAVIGATION_FAILED`
  - DOM の準備: `DOM_READINESS_FAILED`
  - scroll: scroll の理由のコード
  - Rule の評価の失敗: `RULE_EVALUATION_FAILED`
- スクリーンショットが失敗した場合は、途中まで書いたファイルを消す（呼び出し側の責任。progress.md の申し送り）。
- Context の作成と、閉じる処理が失敗した場合は、理由を `UNHANDLED_FAILURE` とする。detail は `<場面>:<メッセージ>` とする。場面は、`passive-context`、`passive-page-close`、`passive-context-close`、`interaction-context-close` のいずれかである（P14c の判断を承認。`interaction-context-close` は P14f で追加）。
- ページ全体の理由は、両方のビューポートの理由を並べ、同じものを1つにまとめたものとする。Run Coordinator は、件数を、ビューポートの理由とページの理由の両方から数えない。
- スクリーンショットは、根のディレクトリの下の `pages/<pageId>/<ビューポート>/viewport.png` と `full-page.png` に置く（P14c）。Task 16 の artifact の配置は、これに合わせる。
- 必須の段階は、設定で有効な段階とする。
  - `audit.performance`、`audit.accessibility`、`audit.screenshots`、`audit.interactions` で無効にした段階は、実行しない。
  - 実行しなかった段階は、理由を付けない。
- `AUDITED` になるのは、次の2つを満たす場合だけである。
  - 必須の段階が、すべて COMPLETE で終わった。
  - Rule の評価の失敗がない。

#### 4.5.6 幅の走査（stress sweep）

- 幅の走査は、Desktop のビューポートの監査の中で、1回だけ行う。
- 結果は、Desktop の layout の Evidence の `stressSweep` に入れる。Mobile の `stressSweep` は、null とする。
- 走査する幅は、設定の `stressWidths` から、主要な2つのビューポートの幅（Desktop と Mobile）を除いたものとする。同じ事実から、主要なビューポートの Finding と、幅ごとの Finding の両方を作らないためである。
- 走査のセッションを作る部品を、本番のコードとして作る。現在はテストの中にしかない。
  - 置き場所は、`src/orchestration/stress-session.ts` とする。
  - 走査のセッションは、`BrowserContextFactory` の Passive Context を使う。そのため、Guard と Ledger が付く。
  - その Ledger も、Safety の Evidence（scope は `PASSIVE`、ビューポートは Desktop）と、違反の集計に含める。

#### 4.5.7 期限

- ページの Passive の段階の期限は、ビューポートごとに、開始の時刻に `overallPageTimeoutMs` を足した時刻とする。
- 各段階の期限は、ページの期限と「現在の時刻に段階の予算を足した時刻」の、早い方とする。
  - 段階の予算は、次のとおり。
    - ナビゲーション: `navigationTimeoutMs`
    - DOM の準備: `resourceSettlingTimeoutMs`
    - scroll: `resourceSettlingTimeoutMs` の4倍
    - そのほかの、期限を受け取る collector: ページの期限まで
  - 計算は、1つの関数（`stageDeadline`）にまとめる。
- Interaction の段階は、Passive の段階とは別の予算を持つ。
  - 候補の発見（`discoverInteractionCandidates`）は、Passive の page で行うので、Passive の段階の期限の中で行う。
  - 予算は、候補の発見が終わった時刻に、`overallPageTimeoutMs` を足した時刻とする（R14r の Minor-1。こうすると、設定の検証を通った設定なら、1件目の候補が予算に収まる）。
  - 候補ごとの期限（`deadlineAtMs`）は、次の2つの早い方とする。
    - 段階の期限
    - 現在の時刻に、`navigationTimeoutMs` と、`interactionTimeoutMs` の2倍を足した時刻
  - `interactionTimeoutMs` を2倍にするのは、`auditInteraction` の後片付けの上限が、後片付けを始めた時刻に `interactionTimeoutMs` を足した時刻になっているためである（P14a の発見事項。`isolated-auditor.ts` の `cleanupDeadlineAtMs`）。
    - 2倍のうち1つは操作の時間、もう1つは後片付けの上限である。
  - `INTERACTION_CLEANUP_ALLOWANCE_MS`（`src/core/limits.ts`）は、`InteractionOwnerCleanupError` のときに、Page Auditor が `close()` を試みる時間の上限として使う（4.5.8）。
  - 次の候補の予算が、段階の期限の中に収まらない場合は、そこで止める。残りの候補の件数を記録し、ビューポートを `PARTIAL` にする。理由は、`COLLECTOR_INCOMPLETE`、`interaction:budget` とする。
  - 候補の発見が上限に達した場合（`completeness` が `COMPLETE` 以外）も、`PARTIAL` にする。理由は、`interaction-discovery:<completeness>` とする。
  - 4.3.1 の「上限を超えた候補の件数」は、発見の結果に件数がないので、`completeness` の値で代える。
- ページの期限を守る（2026-09-24 R14 の I1 を受けて追加）。
  - Passive の段階は、期限を受け取らない collector を含めて、すべてページの期限まで待つ（`awaitBeforeDeadline`）。crash とも競わせる。
  - 期限を過ぎた場合は、次のようにする。
    - `<段階>:DEADLINE_EXCEEDED` を記録し、ビューポートを `PARTIAL` にする。
    - ページの中の残りの段階は、行わない。
    - Context を閉じる。メインスレッドが止まったページも、Context を閉じれば終わる。
    - それまでに集めた Evidence で、Safety の Evidence を作り、Rule を評価する。
  - 期限を過ぎた後に遅れて返る結果や例外は、封じ込める。
  - 期限を受け取る collector には、ページの期限から少しの余裕（`COLLECTOR_DEADLINE_MARGIN_MS`。`src/core/limits.ts`）を引いた時刻を、期限として渡す（R14r の Minor-2）。collector が期限で止まったときの、途中までの結果（PARTIAL の Evidence）を、捨てずに記録するためである。
  - Page Auditor に注入する `now` は、`Date.now` と同じ基準の時刻でなければならない。`awaitBeforeDeadline` が `Date.now` を使うためである。
- scroll と DOM の準備の待ち方の定数（刻み、待ち時間、安定の時間）は、`src/core/limits.ts` に、名前を付けて置く。
- 時間の設定（`maxRuntimeMs`、`navigationTimeoutMs`、`overallPageTimeoutMs`、`resourceSettlingTimeoutMs`）は、正の整数にする。
- Interaction が有効な設定では、`overallPageTimeoutMs` が、`navigationTimeoutMs` と `interactionTimeoutMs` の2倍の和以上でなければならない（R14 の m2）。
  - 満たさない設定では、候補を1つも監査できない。除外される候補も記録されない。
  - そのため、設定の検証で拒む。
  - 倍数（2）は、`src/core/limits.ts` の名前付きの定数にする。Page Auditor と設定の検証の両方が、これを使う。（`INTERACTION_TIMEOUT_COUNT_PER_CANDIDATE`）
  - 項目どうしの算術の関係は、JSON Schema では表せない。そのため、この条件は、設定の検証（`validate-config.ts`）だけで確かめる（P14e）。
  - 設定の検証とスキーマを、そのように直す（正の整数にすることは、スキーマでも表す）。
  - `auditInteraction` は正の整数を要求する。いまの検証では、整数でない値が通ってしまうためである。

#### 4.5.8 Interaction の後片付けの失敗

- `InteractionOwnerCleanupError` が起きた場合は、4.3 のとおりに扱う。
  - エラーが保持する session で、`close()` を1回試みる。
  - Desktop のビューポートを `PARTIAL` にし、理由を `COLLECTOR_INCOMPLETE`、`interaction:cleanup` とする。
  - エラーが保持する Safety の snapshot も、Evidence と違反の集計に含める。
- そのページの残りの候補は、監査しない。件数は、4.5.7 と同じように記録する。

#### 4.5.9 同時に行う共通化

- CC-014: `BlockedExternalActionEvent.reason` を、閉じた一覧にする。
- ビューポートの状態をまとめる関数（最も悪いものを取る）を、`src/core/status.ts` に置く。
- `src/audit/cross-page-rules.ts` の `CrossPageViewportResult` を、`ViewportAuditResult` の別名にする。

## 5. Task 15: Run Coordinator

### 5.1 実装計画どおりの部分

実装計画 Task 15 のとおりに作る。

- PREFLIGHT（設定、出力先、Chromium、Safety Guard、スキーマ、開始URL）を行う。
- robots.txt と sitemap.xml は、Evidence として扱う。取得は、Guard の付いた Passive Context で行う。
  - `SitemapEvidence`（`src/core/evidence-types.ts`）に、上限で切り詰めたかどうかの印を加える。切り詰めた場合は、Cross-page rule の `DISCOVERED_URL_NOT_IN_SITEMAP` を判定しない（Task 12・13 の設計書 第7章、RT12）。
- BFS で巡回する。同時実行数は1。
- URL の状態を持つ: `DISCOVERED | QUEUED | AUDITING | AUDITED | SKIPPED | FAILED`。
- ページ数・深さ・実行時間の上限に達したら、PARTIAL にし、具体的な理由を記録する。
- 再試行の記録を残す（最初の失敗の記録を消さない）。
- Cross-page の評価は、クロールの後に行う。
- Run Status は、実行の事実から導く。

### 5.2 再試行の対象

- 再試行するのは、次の一時的なナビゲーションの失敗だけにする。試行は合計で最大2回。
  - ナビゲーションの期限切れ
  - `net::ERR_CONNECTION_RESET`、`net::ERR_CONNECTION_CLOSED`、`net::ERR_EMPTY_RESPONSE`、`net::ERR_NETWORK_CHANGED`
- 次のものは再試行しない。
  - 4xx・5xx の応答
  - 安全のための遮断
  - 変更系の操作
  - それ以外のエラー
- 再試行の対象の一覧は、`src/orchestration/run-coordinator.ts` の中の1つの定数として定義する。

### 5.3 内部リンク切れの判定の置き場所

`BROKEN_INTERNAL_LINK` と `TARGET_NAVIGATION_FAILED` は、リンク元のページの Evidence だけでは判定できない。リンク先のページの監査結果が必要である。これはページをまたぐ判断なので、`evaluateCrossPageRules()` で判定する（category は `LINK` のまま）。

- 入力は、各ページの Link の Evidence（`LinkDiscoveryEvidence`）と、各URLの監査結果（ビューポートごとの identity の `httpStatus` とナビゲーションの失敗）である。
- リンク先が上限などで監査されなかった場合は、Finding を作らない。その件数を、Run の「検証できなかった内部リンク」として記録する。検証していないものを「リンク切れなし」とはみなさない。

### 5.4 Run Status の入力

`deriveRunStatus()` には、次の事実を渡す。

- ページの状態の集計
- 上限への到達
- Safety Ledger の違反の件数と、記録が不完全かどうか（基盤修正の C2）
- Rule の評価の失敗
- スキーマの検証の結果（Task 16）

Finding の件数は渡さない。

#### 5.4.1 Interaction の結果の反映（2026-09-24 P14d の報告を受けて追加）

実装タスク指示 第9章は、「not verified」と「failed」を隠してはいけないと定めている。設計書 7章は、`NOT_VERIFIABLE` を PASS 扱いしないと定めている。一方で、Interaction の検証は、偽の VERIFIED を防ぐことを優先している（基盤修正の設計書 4.4.4）。そのため、`NOT_VERIFIABLE` は多く出る。そこで、次のように分けて扱う。

- `EXECUTION_FAILED`: 作業の失敗とする。件数を、`failedRequiredWork` に入れる。
- `NOT_VERIFIABLE` のうち、確かめる作業そのものができなかったもの: 未確認の作業とする。件数を、`notVerifiedRequiredWork` に入れる。
  - 例: 読み込みの期限切れ、下準備の失敗、作業量の上限への到達
- `NOT_VERIFIABLE` のうち、確かめたが変化が見えなかったもの（`No observable change` の種類）: サイトの振る舞いの結果とする。
  - Run の完了を妨げない。
  - 件数は、`RunSummary.unverifiedInteractionCount` とレポートで、隠さずに示す。
- この区別のために、Interaction の Evidence に、構造化した理由のコードを持たせる。
  - いまの理由は、上限付きの文字列だけである。
  - Task 15 の前に、サブタスクとして行う。対象は、`isolated-auditor.ts`、`evidence-types.ts`、スキーマである。
- ページとビューポートの状態は、候補ごとの結果では変えない（P14d）。`PARTIAL` にするのは、段階そのものが終わらなかった場合だけである。


### 5.5 環境の事実

run.json に、次の環境の事実を記録する（設計書 18.1）。

- Node.js の版、OS、CPU のアーキテクチャ
- Playwright の版、Chromium の版
- headed と headless のどちらか
- ビューポート、locale、timezone
- 実際の User-Agent

### 5.6 実装の詳細の決定（2026-09-24。Task 15 の着手前の調査を受けて追加）

> 2026-09-25 追補（P18d。DEF-009）: Run Coordinator は、PREFLIGHT の前に、Run のディレクトリを排他的に作る（`createRunArtifactDirectory`）。作れなかった場合は、Browser を起動せず、理由 `RUN_DIRECTORY_UNAVAILABLE` で `FAILED` の Run を確定し、`RunDirectoryUnavailableError` で reject する。CLI は artifact を書かずに、日本語の文言と終了コード 1 で終える。詳しくは `doc/design/2026-09-25-beaksight-pre-task-18-cleanup-design.md` 第6章。

着手前の調査で、部品をつなぐときの障害と、まだ決まっていない点が見つかった。この節で、それらを決める。この節は、5.1〜5.5 と実装計画 Task 15 に優先する。

#### 5.6.1 入口と戻り値

- 入口は `RunCoordinator.run(): Promise<AuditRunResult>` とする。
  - 依存するものは、コンストラクタで注入する。
    - 設定
    - Chromium を起動する関数
    - 時計と現在の時刻
    - 出力先
    - `PageAuditor` を作る関数
    - サイトの metadata を取得する関数
- `AuditRunResult` は、Task 16 の artifact の書き出しに渡す、確定した Run である。次のものを持つ。
  - `run: RunSummary`
  - `pages: PageAuditResult[]`（URL の発見の順）
  - `findings: Finding[]`（Page rule と Cross-page rule のすべて）
- 実装計画の `RunCoordinator.run(config)` と `AuditRun` は、この形に読み替える。

#### 5.6.2 サイトの metadata（robots.txt と sitemap.xml）

- 取得には、`src/crawl/site-metadata.ts` の `collectSiteMetadata` を使う。
  - Guard の付いた Passive Context で、GET のナビゲーションで取得する。Node の `fetch` は使わない。
  - 本文は、ナビゲーションの応答（`response.text()`）から読む。
  - 本文の文字数と、sitemap の `<loc>` の件数には、上限を設ける。上限で切り詰めた場合は、その印を残す。
  - 取得に使った Context の Ledger も、Safety の集計に含める。
- Evidence の形:
  - 種類は、既存の `metadata` を使う。
  - payload（`MetadataEvidence`）を、次の項目に改める。
    - `kind`: `ROBOTS_TXT` か `SITEMAP_XML`
    - `url`
    - `outcome`: `OK`、`NOT_FOUND`、`FAILED` のいずれか
    - `httpStatus`
    - `text`（上限付き）と `textTruncated`
    - sitemap の場合だけ、`sitemapUrls`（上限付き）と `sitemapUrlsTruncated`
  - Cross-page rule に渡す `SitemapEvidence` は、この Evidence から作る。項目は、`evidenceId`、`urls`、`truncated` である。
    - `truncated` が真の場合、`DISCOVERED_URL_NOT_IN_SITEMAP` は判定しない（Task 12・13 の設計書 第7章）。
- Evidence の置き場所:
  - 開始の URL のページの `PageAuditResult.evidence` に置く。
  - `pageId` は開始の URL のページのもの、ビューポートは null とする。
  - 理由: Evidence はページに属する形しかない。artifact の中で、Cross-page の Finding が参照する ID の行き先を保つためである。
  - 開始の URL のページの ID は、metadata の取得の前に採番する。
- sitemap の index（`<sitemapindex>`）の扱い（2026-09-24 R15b の報告を受けて追加）
  - 入れ子の sitemap は、たどらない。これは制約である。
  - 入れ子の sitemap の URL は、ページの URL ではない。そのため、`sitemapUrls` は null にする。
    - その結果、Cross-page rule の sitemap の2つの Rule は、判定しない。
    - 入れ子の URL は、本文（`text`）に事実として残る。
- 取得は、ファイルごとに新しい page で行う（R15b）。期限切れのナビゲーションを、同じ page の次の `goto` で中断すると、Guard の違反になるためである。
- sitemap にだけある URL は、巡回しない（設計書 8.1）。

#### 5.6.3 URL の状態、深さ、上限

- 状態は、Coordinator が URL ごとに持つ。`DISCOVERED | QUEUED | AUDITING | AUDITED | SKIPPED | FAILED` のいずれかである。
  - `CrawlQueue` は、FIFO と重複の排除だけを受け持つ。
- 深さ:
  - 開始の URL を深さ0とする。
  - リンクをたどるたびに、深さを1増やす。
  - 深さが `maxDepth` を超える URL は、キューに入れない。状態を `SKIPPED` にし、理由を `MAX_DEPTH_REACHED` とする。
- 上限:
  - 次のページを始める前に、毎回、ページ数と実行時間を確かめる。
  - ページ数の上限に達した後の URL は、`SKIPPED` にする。理由は `MAX_PAGES_REACHED` とする。
  - 実行時間の上限に達した後の URL は、`SKIPPED` にする。理由は `MAX_RUNTIME_REACHED` とする。
  - 実行時間は、ページとページの間でだけ確かめる。そのため、1ページ分だけ、上限を超えることがある。
    - これは制約である。
    - 超えた場合は、`crawlLimits.maxRuntimeReached` を真にする。
    - 監査していない URL が残る場合は、`MAX_RUNTIME_REACHED` の理由を付け、それらを `SKIPPED` にする。
    - 最後のページで超え、監査していない URL が残らない場合は、理由を付けない（`PARTIAL` にしない）。事実として `crawlLimits` にだけ記録する（R15 の Minor-4）。
- 重複の排除: URL の状態（SKIPPED を含む）の管理は、Coordinator の `CrawlFrontier` の責務である。`CrawlQueue` の重複の排除は、二重の防御として残す（R15 の Minor-5）。
- 監査しなかった URL にも、`PageAuditResult` を作る。
  - 両方のビューポートを `SKIPPED` にし、`navigationOutcome` は null とする。
  - この結果は、`src/orchestration/skipped-page.ts` の関数で作る。
  - Cross-page rule は、これらを「検証できなかったリンク」として数える。
- 理由のコードは、コードの `MAX_PAGES_REACHED` などを正とする。設計書 8.3 の `CRAWL_PAGE_LIMIT_REACHED` などの名前は、読み替える。
- Link は、各ページの `link` の Evidence（Desktop）から取る。`INTERNAL_NAVIGABLE` のものだけを、キューに入れる（ARCH03）。

#### 5.6.4 再試行

- 再試行の判断に使うため、ナビゲーションが失敗したときの理由の detail を、次の形にする。
  - 期限切れの場合: `TIMEOUT`
  - 外部へのリダイレクトの遮断の場合: `BLOCKED_EXTERNAL_REDIRECT`
  - そのほかの失敗の場合: `FAILED:<Chromium のエラーのコード>`
    - エラーのコードの例は、`net::ERR_CONNECTION_RESET` である。
    - エラーのコードがない場合は、`FAILED` とする。
  - この変更は、Page Auditor で行う。
- 再試行するのは、Desktop のナビゲーションが、5.2 の一時的な失敗だった場合だけである。
  - 試行は、合計で2回まで。
  - ページの単位で、`PageAuditor.audit` を、同じ `pageId` でもう一度呼ぶ。
- 最初の試行の記録は、`RunSummary.retries` に残す。
  - 記録する項目は、`url`、`attempt`、`navigationOutcome`、`detail`、`evidenceIds` である。
  - 最初の試行の Evidence は、捨てずに、最終のページの `evidence` に残す（上位の設計書 10.1 の「最初の失敗 Evidence は保持する」。2026-09-24 R15 の Minor-6）。
    - `evidenceIds` は、その Evidence の ID の一覧である。
  - 最初の試行の Finding は、残さない。Rule は、最終の試行の Evidence で評価する。
  - `pages` には、最終の試行の結果を入れる。

#### 5.6.5 RunSummary の追加と、件数の数え方

- `RunSummary` とスキーマに、次の3つを加える。
  - `partialPageCount`
  - `unverifiedInternalLinkCount`
  - `retries`
- 件数の数え方:
  - `discoveredPageCount`: 発見した内部の URL の数。開始の URL を含む。
  - `auditedPageCount`、`partialPageCount`、`failedPageCount`、`skippedPageCount`: ページの状態ごとの数。
- Safety の集計（`RunSafetySummary`）:
  - Coordinator は、`createSafetyLedger` を包み、Run の間に作ったすべての Ledger を1か所に登録する（2026-09-24 R15 の I2）。
  - `blockedActions`、`blockedRequestsByMethod`、違反、記録の切り詰めは、この登録にあるすべての Ledger の snapshot からだけ集計する。
    - 対象は、PREFLIGHT、環境の事実、metadata の取得、各ページ（Passive、Interaction、幅の走査）、再試行の前の試行の Ledger である。
    - Page Auditor が例外を投げた場合も、その試行の Ledger は登録にあるので、漏れない。
  - ページの `safety` の Evidence は、Rule の入力として、そのまま残す。
  - `guardEnabled` は、PREFLIGHT で Guard の有効を確かめた場合に真とする。

#### 5.6.6 Run Status の入力

`deriveRunStatus` に渡す値を、次のとおりとする。Finding の件数は渡さない。

| 入力 | 値 |
| --- | --- |
| `preflightFailed` | PREFLIGHT が失敗した |
| `safetyInvariantViolations` | すべての Ledger の違反の件数の合計 |
| `safetyLedgerTruncated` | どれかの Ledger の記録が切り詰められた |
| `incompleteReasons` | Run の理由（上限への到達など） |
| `crawlLimitReached` | 上限のために、`SKIPPED` にした URL がある |
| `executionComplete` | クロールの繰り返しが、例外なく最後まで終わった |
| `unhandledFailures` | Coordinator が捕まえた、予期しない例外の件数 |
| `skippedRequiredWork` | `SKIPPED` のページの数 |
| `failedRequiredWork` | 次の2つの和<br>・`FAILED` のページの数<br>・`EXECUTION_FAILED` の Interaction の数 |
| `notVerifiedRequiredWork` | `NOT_VERIFIABLE` の Interaction のうち、区分が `CHECK_NOT_COMPLETED` のものの数（I15a） |
| `incompleteCollectorCount` | `PARTIAL` のビューポートの数 |
| `requiredArtifactsValid` | すべての `PageAuditResult` と Finding が、`validateArtifact` で page と finding のスキーマに合う |
| `timedOutRequiredWork`、`blockedRequiredWork`、`notObservedRequiredWork` | 0 |

- `timedOutRequiredWork` などを 0 にするのは、該当する事実が、すでに `PARTIAL` のビューポートと理由に含まれているためである。
- run.json そのもののスキーマの検証は、Task 16 の書き出しで行う。書き出しに失敗した場合は、CLI が終了コードで知らせる（第7章）。
  - `runStatus` を決めた後で run.json を検証する。そのため、順序は循環しない。

#### 5.6.7 PREFLIGHT、環境の事実、Run の ID

- PREFLIGHT は、`src/orchestration/preflight.ts` で行う。確かめることは、次のとおり。
  - 設定（`loadConfig` の検証済みの設定であること）
  - 出力先に書けること（ディレクトリを作り、一時ファイルを書いて消す）
  - Chromium を起動できること
  - Guard の付いた Passive Context を作れて、Guard が有効であること（作った Context はすぐに閉じる）
  - スキーマを読み込めること
  - 開始の URL が、`INTERNAL_NAVIGABLE` であること
- どれかが失敗した場合は、対象のサイトにアクセスせずに終える。
  - 違反が記録されていない場合、Run の状態は `FAILED` になる。
  - Guard の初期化の失敗などで違反が記録された場合は、`ABORTED_BY_SAFETY` になる（上位の設計書 9.5。2026-09-24 R15 の Minor-3）。
  - このため、`deriveRunStatus` は、違反の判定を、PREFLIGHT の失敗の判定より先に行う。
- 環境の事実は、`src/orchestration/environment.ts` で集める。
  - Node の版、OS、CPU のアーキテクチャは、`process` と `os` から取る。
  - Playwright の版は、Playwright の `package.json` から取る。
  - Chromium の版は、`browser.version()` から取る。
  - User-Agent は、ビューポートごとに Guard の付いた Passive Context で `about:blank` を開き、`navigator.userAgent` を読む。
  - `toolVersion` は、BeakSight の `package.json` から取る。
- `runId` は、開始の時刻（UTC）から作る。形は `RUN-YYYYMMDDHHmmss` である（スキーマの `^RUN-[0-9]{6,}$` に合う）。時計は注入する。

#### 5.6.8 fixture

- fixture のサーバの応答の種類を、次のように改める。
  - `.txt` は `text/plain; charset=utf-8`
  - `.xml` は `application/xml`
  - `.css` は `text/css`
  - いまは `application/octet-stream` で返しているため、ナビゲーションがダウンロードになる。
- クロールのテスト用の fixture を、`fixtures/site/crawl/` の下に置く。
  - 深さ2以上のリンクの連なり
  - 404 になる内部リンク
  - 同じページへの重複したリンク
  - 外部のリンク
- robots.txt と sitemap.xml も置く。既存のテストの前提を変えないように、置き場所を決める。

## 6. Task 16: artifact・HTMLレポート・ChatGPT用バンドル

- 出力の構成は、実装計画 Task 16 Step 1 のとおりにする。
- JSON は、メモリの上で組み立て、`validateArtifact()` で検証してから、一時ファイルを経由して書き出す（途中で壊れたファイルを残さない）。
- スクリーンショットの配置は、Page Auditor の配置（`pages/<pageId>/<ビューポート>/viewport.png`、`full-page.png`。4.5.5）に合わせる。
  - 再試行の前の試行のスクリーンショットは、`pages/<pageId>/retry-<n>/<ビューポート>/` に置く（DEF-007。2026-09-24）。
- 再試行したページの `evidence` には、最初の試行の Evidence も入っている（5.6.4）。
  - 表示用モデルは、`retries[].evidenceIds` を使って、最初の試行の Evidence を区別する。
  - 件数と、Finding の参照は、最終の試行の Evidence で扱う。
  - 最初の試行の Evidence は、「再試行の前の記録」として、別に示す。
- 書き出すテキストは、UTF-8 で、改行は LF にする。
- 必須の artifact がスキーマに合わない場合は、COMPLETE にしない（A10）。
- 表示に関わる owner と責務は、UI追補設計書 第4章のとおりにする。
  - `src/presentation/`: catalog、format、messages
  - `src/report/`: view-model、html-components、html-tokens、html-report、chatgpt-bundle、artifact-writer
- 表示用モデル（`view-model.ts`）は、確定した Run から1回だけ組み立てる。HTMLレポートと ChatGPT用バンドルと CLI は、どれもこの表示用モデルを使う。
- HTMLレポートは、日本語の静的なHTMLにする（`<html lang="ja">`）。
  - `mailto:` や `tel:` などの危険なURLは、リンクにしない。リンクにするかどうかは、`classifyUrl` で判断する。
  - Evidence の値は、すべてエスケープする。
- スクリーンショットの `relatedFindingIds` は、Finding の `evidenceRefs` とスクリーンショットの Evidence を突き合わせて付ける。
- ChatGPT用バンドルは、fflate で ZIP にする。
  - 生のレスポンス本文は含めない。
  - パスは決定論的にし、ファイル名は UTF-8 にする。
- UI Gate の GATE-UI01〜05 を作る（`tests/architecture/ui-ssot.test.ts`。1秒以内）。

### 6.1 実装の詳細の決定（2026-09-24。Task 16・17 の着手前の調査を受けて追加）

着手前の調査で、文書どうしの食い違いと、まだ決まっていない点が見つかった。この節で、それらを決める。この節は、第6章、第7章、実装計画 Task 16・17、上位の設計書 第18〜22章の出力の構成に優先する。優先する理由は、各項目に書く。

#### 6.1.1 スキーマの検証と Run Status（A10 と ARCH05）

- `AuditRunResult` に、書き出しの前の Run Status の入力（`statusInput: RunStatusInput`）を持たせる。
  - これはメモリの上だけの項目で、JSON には書かない。
  - Run Coordinator が、`deriveRunStatus` に渡したものと同じ値を入れる。
- `ArtifactWriter.writeRun(result)` は、次の順に処理する。
  1. 書き出すすべての JSON をメモリの上で組み立て、`validateArtifact` で検証する。対象は、run.json、audit.json、各ページの page.json である。
  2. どれかがスキーマに合わない場合は、`statusInput.requiredArtifactsValid` を偽にして、`deriveRunStatus` で Run Status を導き直す。
     - Run の理由に `REQUIRED_ARTIFACT_INVALID`（detail は `<スキーマ>:<場所>:<最初の誤り>`）を加える。
     - 導き直した Run Status で、run.json と audit.json を組み立て直す。
     - Run Status の値は、スキーマの検証の結果に影響しない。そのため、組み立て直しは1回で終わる。
  3. 一時ファイルに書いてから rename する。書き出すテキストは、UTF-8 と LF にする。
  4. 結果として、最終の `RunSummary`、書いたファイルの一覧、スキーマに合ったかどうかを返す。
- こうすると、Run Status を決めるのは、`deriveRunStatus` だけのままになる（ARCH05）。スキーマに合わない artifact があれば、`COMPLETE` にならない（A10）。
- スキーマに合わない JSON も、隠さずに書き出す。Run Status が `PARTIAL` になるので、偽の完了にはならない。
- ファイルの書き込みそのもの（入出力）が失敗した場合は、`writeRun` が例外を投げる。CLI は、終了コード 1（FAILED と同じ）で終え、日本語の文言で知らせる。

#### 6.1.2 出力の構成

- Run のディレクトリは、`runArtifactDirectory(outputDirectory, runId)` で求める（`<出力先>/<runId>`）。
  - `runId` には開始の時刻（UTC）が入るので、上位の設計書 第18章の `<timestamp>-<run-id>` の意図（時刻で並ぶ、重ならない）を満たす。
  - 出力先の既定値は、設定のまま（`artifacts`）とする。
- 置くファイル:
  - Run のディレクトリの直下: `run.json`、`audit.json`、`report.html`、`beaksight-audit-bundle.zip`
  - `pages/<pageId>/`: `page.json`、`visible-text.txt`
  - `pages/<pageId>/<ビューポート>/`: `viewport.png`、`full-page.png`（Page Auditor が撮る。Task 14 の設計 4.5.5）
  - 再試行の前の試行のスクリーンショット: `pages/<pageId>/retry-<n>/<ビューポート>/`（DEF-007）
- 上位の設計書 第18章と、実装計画 Task 16 との違い（読み替え）:
  - full-page のスクリーンショットの名前は、`full-page.png` とする（Task 14 の設計 4.5.5 で決め、実装済み）。
  - **Run の単位の `evidence/*.json` は書かない。**
    - Evidence は、`page.json`（`PageAuditResult.evidence`）の1か所にある。
    - 種類ごとのファイルを別に書くと、同じ Evidence が2か所になる。これは、上位の設計書 第27章（重複する artifact を持たない）と、SSOT の考え方に反する。
    - ChatGPT 用バンドルの `evidence-index.json` が、各 Evidence の ID と、それがある `page.json` の場所の対応を持つ。これで、Evidence の種類ごとにたどれる。
  - `page.json` の中身は、`PageAuditResult` そのものとする（page のスキーマで検証する）。上位の設計書 18.2 の節の構造は、`PageAuditResult` の Evidence の種類として表されている。
  - `visible-text.txt` は、Desktop の DOM の Evidence の可視テキストから作る。Desktop にない場合は Mobile から作る。どちらにもない場合は、書かない。
- ChatGPT 用バンドル（`beaksight-audit-bundle.zip`。fflate）に入れるもの:
  - `manifest.json`、`run.json`、`summary.json`、`findings.json`、`pages.json`、`evidence-index.json`
  - 問題に関係するスクリーンショット（Finding が参照するスクリーンショットの Evidence の画像）
  - `run.json` を入れるのは、上位の設計書 第19章に従うためである（実装計画の一覧にはない）。
  - 生のレスポンス本文は、入れない。
  - パスは決定論的にし、ファイル名は UTF-8 にする。

#### 6.1.3 表示用モデル

- 表示用モデル（`src/report/view-model.ts`）の入力は、`AuditRunResult`（最終の Run Status のもの）とする。出力は、HTML、バンドル、CLI のすべてが使う、1つのモデルである。
- Finding の件数と、Finding の一覧の出どころは、`AuditRunResult.findings` の1つだけとする。
  - `PageAuditResult.findings` は、ページの詳細の表示にも使わない。ページごとの Finding は、`AuditRunResult.findings` を `pageId` で絞って作る。
- 件数の集計は、次の2つに分ける（上位の設計書 13章）。
  - サイト品質（ERROR、WARN、INFO）
  - Safety（SAFETY）
- 再試行したページでは、`retries[].evidenceIds` にある Evidence を「再試行の前の記録」として区別する。件数と Finding の参照は、最終の試行の Evidence で扱う。
- スクリーンショットの対応:
  - `screenshotId` は、スクリーンショットの Evidence の ID とする。
  - `relatedFindingIds` は、Finding の `evidenceRefs` と、スクリーンショットの Evidence の ID を突き合わせて、表示用モデルの中で作る。
  - page のスキーマは変えない。`relatedFindingIds` は、表示用モデルとバンドルの `evidence-index.json` にだけ持つ。
- 表示用モデルは判定しない。Run Status は、`RunSummary.runStatus` をそのまま使う。

#### 6.1.4 表示のカテゴリ

- HTML レポートの節は、次の順とする。
  1. 要約
     - Run Status
     - ページの網羅（発見、監査、PARTIAL、失敗、スキップ）
     - サイト品質の件数（ERROR、WARN、INFO）
     - Safety の件数
     - 上限と、未完了の理由
  2. 重大な指摘（severity が ERROR の Finding。category を問わない）
  3. category ごとの節（`FINDING_CATEGORIES` の各値。順と日本語のラベルは、カタログが持つ）
  4. Interaction（候補ごとの結果。`notVerifiableKind` の区分を含む）
  5. Safety（遮断した事象、違反）
  6. ページの一覧（ページごとの状態、ビューポートごとの状態、スクリーンショット）
- 上位の設計書 第20章のカテゴリの名前（Network、JavaScript、Links など）は、`FINDING_CATEGORIES` のカタログのラベルで表す。
  - Network は HTTP と RESOURCE、JavaScript は JAVASCRIPT、Links は LINK、Pages は ページの一覧、に当たる。
  - 対応は、カタログの1か所に置く。

#### 6.1.5 文言と理由

- 理由のコード（`IncompleteReasonCode`）の日本語の説明は、`src/presentation/messages.ts` が持つ。
- 理由の `detail` と、Interaction の `reason` は、英数字の技術的な詳細として、エスケープして、そのまま示す。
  - これらを日本語に訳し直すことは、しない。理由のコードの整理（CC-009、CC-010）が保留中だからである。
  - Interaction の結果は、`status` と `notVerifiableKind` の日本語のラベルで示す。
- 設定のエラー（Task 17）:
  - `src/config/` に、設定のエラーを表すクラス（例: `ConfigError`）を置く。
  - このクラスは、エラーの種類のコードと、詳細の一覧を持つ。
  - CLI は、このクラスで CONFIG_ERROR を見分け、`messages.ts` の日本語の文言で示す。
  - 詳細の一覧（英語の検証エラー）は、技術的な詳細として、そのまま示す。

#### 6.1.6 URL の表示

- 表示する URL は、Evidence にある文字列をエスケープして、そのまま示す。表示のために正規化し直すことは、しない。
- リンクにするかどうかは、`classifyUrl(new URL(文字列), 許可 Origin)` の結果で決める。
  - リンクにするのは、`INTERNAL_NAVIGABLE` と `EXTERNAL_RECORD_ONLY`（http と https）の場合である。
  - 外部へのリンクには、`rel="noopener noreferrer"` を付ける。
  - `SPECIAL_SCHEME_RECORD_ONLY`（`mailto:`、`tel:` など）と `REJECTED_INVALID` は、リンクにせず、文字として示す。
  - `new URL` が失敗した場合も、文字として示す。
- 許可 Origin は、`RunSummary.allowedOrigins` から取る。

#### 6.1.7 UI Gate

- UI Gate は、`tests/architecture/ui-ssot.test.ts` に置く。Task 18 の ARCH Gate は、別のファイルに置く。
- GATE-UI01 の対象（`src/report/**`、`src/cli/**`）では、状態の値の比較が必要な処理に、カタログか core の関数を使う。対象は、Run Status、Severity、各種 Status である。
- GATE-UI02 の除外の一覧には、次の2つを明示する。
  - `src/evidence/color-collector.ts`（ページから取った色の値を扱うため）
  - `src/report/html-tokens.ts`
- GATE-UI02 の 16 進数の色の検出は、次の形に限る。private フィールド（`#name`）を誤って検出しないためである。
  - `#` の直後に、16 進数の3・4・6・8桁が続く。
  - その後に、識別子の文字が続かない。
- GATE-UI04 の「表示用の集計」は、Finding を severity や category で数えたり分けたりする処理とする。これは `view-model.ts` だけが行う。
  - `src/orchestration/run-aggregation.ts` の Run の事実の集計（ページの件数、Safety の件数）は、表示用の集計ではない。そのため、対象外とする。
- どの Gate のファイルも、1秒以内に終わる。所要時間を報告に書く。

#### 6.1.8 U16b の報告を受けた決定（2026-09-25）

この節は、6.1.1〜6.1.4 と、実装計画 U16c・U16d の該当する記述に優先する。

- **HTML とバンドルの書き出しの順序**
  - CLI が、次の順に呼ぶ。
    1. `ArtifactWriter.writeRun`
    2. `buildReportViewModel(written.result)`
    3. `renderHtmlReport(viewModel)` と `createChatGptBundle(viewModel, written.result, readArtifactFile)`（引数は 6.1.9）
    4. `ArtifactWriter.writePresentation(written, { reportHtml, bundle })`
  - `createChatGptBundle` は、ファイルを書かない。ZIP の中身を `Uint8Array` で返す。
  - HTML の描画も、文字列を返すだけにする。
  - ファイルを書くのは、`ArtifactWriter` だけである（ARCH08）。
  - この順序にする理由は、2つある。
    - 表示用モデルを、Run Status を導き直した後の Run から組み立てられる。
    - import の循環を避けられる。
- **artifact の配置の owner**
  - artifact のパスの組み立ては、`src/core/artifact-layout.ts` の1か所に置く。
    - Run のディレクトリ（`runArtifactDirectory`）
    - `pages` のディレクトリ
    - ファイルの名前
    - ページの artifact の相対パス
    - スクリーンショットの相対パス（`retry-<n>` を含む）
  - Page Auditor、Run Coordinator、`ArtifactWriter`、表示用モデルは、どれもここから取る。
  - `src/report/` は、`src/orchestration/` を import しない。report が Playwright を読み込まないようにするためである。
- **「重大な指摘」の選び方**
  - `SEVERITY_CATALOG` の明示の属性 `criticalSection` が真の severity を、「重大な指摘」の節に入れる。いまは ERROR だけが真である。
  - 色のトーンを、振り分けの根拠にしてはいけない。
- **スクリーンショットと Finding の関係づけ（`relatedFindingIds`）**。6.1.3 を広げる。
  - 最終の試行のスクリーンショットは、次のどちらかに当たる Finding に関係づける。
    - スクリーンショットの Evidence を、`evidenceRefs` で直接参照する。
    - スクリーンショットと同じページ・同じビューポートの Evidence（最終の試行のもの）を、`evidenceRefs` で参照する。
  - 再試行の前の試行のスクリーンショットは、直接の参照があるときだけ関係づける。
  - Finding の順は、`AuditRunResult.findings` の順とする。
  - バンドルの「問題に関係するスクリーンショット」は、`relatedFindingIds` が空でないスクリーンショットとする。
  - 広げる理由: いまの Rule は、スクリーンショットの Evidence を参照しない。直接の参照だけでは、HTML でもバンドルでも、Finding のスクリーンショットを示せない。


#### 6.1.9 C16a の報告を受けた決定と、HTML・バンドルの詳細（2026-09-25）

この節は、6.1.2、6.1.3、6.1.8、実装計画 Task 16 の Step 1・5 と、実装計画 Task 16・17 の U16c・U16d に優先する。

- **2つの `relatedFindingIds` の意味**
  - `EvidenceLocationView.relatedFindingIds`: その Evidence を、`evidenceRefs` で直接参照する Finding。どの種類の Evidence にもある。
  - `ScreenshotView.relatedFindingIds`: 6.1.8 の規則で関係づけた Finding。スクリーンショットにだけある。
  - `FindingView.screenshots` の順は、次のとおりとする。
    1. 直接参照するスクリーンショット（`evidenceRefs` の順）
    2. 同じページ・同じビューポートのスクリーンショット（`page.json` の中の順）
- **スクリーンショットのパス**
  - 表示用モデルは、`ScreenshotEvidence.relativePath`（記録した事実）をそのまま使う。組み立て直さない。
  - パスを組み立てるのは、撮る側（Page Auditor が `screenshotRelativePath` を使う）だけである。
- **ChatGPT 用の論理ビューは、ZIP の中にだけ置く**
  - 実装計画 Task 16 の Step 1 は、`chatgpt/*.json` を Run のディレクトリにも置くことにしていた。これは置かない。
    - ZIP の中と外に、同じ内容の2つの写しを持たないためである（上位の設計書 第27章）。
    - Task 19 の確認の手順の「ChatGPT logical view files」は、ZIP の中のファイルと読み替える。
- **`createChatGptBundle` の形**
  - シグネチャ: `createChatGptBundle(viewModel, result, readArtifactFile): Promise<Uint8Array>`
    - `readArtifactFile(relativePath): Promise<Uint8Array | null>` は、Run のディレクトリからの相対パスで、書き出し済みのファイルを読む関数である。CLI が、`artifactFilePath` と `readFile` で作って渡す。ファイルがなければ、`null` を返す。
    - バンドルの関数は、ファイルを書かない。書くのは、`ArtifactWriter.writePresentation` である（ARCH08）。
  - ZIP に入れるもの（パスは、この順に並べる）:
    - `manifest.json`
      - `bundleSchemaVersion: 'chatgpt-bundle/1.0'`、`runId`、`runStatus`、`toolVersion`
      - `generatedAt`: Run の `finishedAt`
      - `files`: ZIP の中の各ファイルの `path`、`byteLength`、`sha256`
      - `omittedFiles`: 入れられなかったファイルの `path` と `reason`
    - `run.json`: 書き出した `run.json` を、`readArtifactFile` で読んで、そのまま入れる。組み立て直さない。
    - `summary.json`: 表示用モデルの `summary`
    - `findings.json`: 各 Finding と、それが参照する Evidence の場所（`path`、`pointer`）、関係するスクリーンショットのパス
    - `pages.json`: 表示用モデルの `pages`
    - `evidence-index.json`: 表示用モデルの `evidence`（Evidence の ID、種類、ページ、ビューポート、`path`、`pointer`、`retryAttempt`、`relatedFindingIds`）
    - スクリーンショット: `ScreenshotView.relatedFindingIds` が空でないもの。パスは、Run のディレクトリの中と同じ相対パス（`pages/<pageId>/.../*.png`）とする。
  - JSON は、字下げ2文字、末尾に LF、UTF-8 にする。値は、英数字のコードのままとする。日本語のラベルは入れない。
  - 決定論:
    - 同じ入力からは、同じバイト列を作る。
    - ZIP の各項目の時刻は、固定の値にする。
    - 項目の順は、上の順とする。スクリーンショットは、パスの順に並べる。
  - 生のレスポンス本文は、入れない。
  - 読めなかったスクリーンショット（`null`）は、ZIP に入れない。`manifest.json` の `omittedFiles` に書く。
    - これは、バンドルが不完全であることの記録である。Run Status は変えない。Run Status を決めるのは `deriveRunStatus` だけで、バンドルの前に確定している。
- **HTML レポート（`renderHtmlReport(viewModel): string`）**
  - 節と順は、6.1.4 のとおりとする。
  - Finding から、Evidence（`page.json` への相対リンクと `pointer`）と、スクリーンショット（相対リンク）へたどれるようにする。
  - ページの一覧には、ページのアンカーを置く。Finding の行から、そのページへ移れるようにする。
  - 再試行したページでは、再試行の前の記録を、別の小見出しで示す。
  - 部品を組み合わせるだけにする。タグは、`html-components.ts` の外に書かない（UI03）。日本語の文言は、`messages.ts` に置く（UI06）。


#### 6.1.10 U16c の報告を受けた決定（2026-09-25）

この節は、6.1.3 と 6.1.4 の Safety の節と Interaction の節に優先する。

- **Safety の事象の一覧**。6.1.4 の「遮断した事象」を示すため、表示用モデルに加える。
  - 表示用モデルの `safety` に、`events` を加える。
    - 各ページの Safety の Evidence（`SafetyEventsEvidence`）の記録を、1つの一覧に並べる。
    - 対象の記録は、`blockedRequests`、`blockedNavigations`、`blockedWebSockets`、`blockedExternalActions`、`excludedInteractionCandidates`、`blockedInteractionRequests`、`blockedInteractionNavigations`、`blockedPopups`、`blockedDownloads` など、`SafetyEventsEvidence` にある事象の一覧のすべてである。
  - 各事象が持つもの:
    - `kind`: 記録の種類。`SafetyEventsEvidence` の項目の名前を、そのまま使う。
    - `evidenceId`、`pageId`、`viewport`、`scope`
    - `retryAttempt`: 再試行の前の試行の記録なら、その番号。最終の試行なら `null`。
    - `method`、`url`、`candidateId`: その記録にないものは `null` にする。
    - `reason`
  - 並びの順は、ページの順、Evidence の順、記録の種類の順（`SafetyEventsEvidence` の項目の順）、記録の中の順とする。
  - 記録の種類の値の一覧は、core が持つ（C16d の報告を受けて 2026-09-25 に決定）。
    - 置き場所: `src/core/evidence-types.ts` の `SAFETY_EVENT_KINDS`（`as const` の配列）と、`SafetyEventKind`
    - `SafetyEventsEvidence` の事象の一覧の項目と、書き漏れも余分もないことを、型で確かめる。
  - 記録の種類の日本語のラベルと、表示の順は、カタログ（`SAFETY_EVENT_KIND_CATALOG`）に置く。書き漏れは、型のエラーにする。UI05 の対象にする。
  - 各事象は、Evidence の場所（`location`）も持つ。HTML は、ID から場所を引き直さない。
  - HTML の事象の表の列は、次の8つとする。
    - 種類、ページ、ビューポート
    - メソッド、URL、候補（`candidateId`）
    - 理由、Evidence の参照
  - 記録の上限で記録されなかった件数（`recordLimits`）は、既存の `RunSafetySummary` の値で示す。一覧の件数から推し量らない。
  - 事象の一覧は、Run Status と件数の判定に使わない。表示のためだけのものである。
- **Interaction の Evidence の場所**
  - `InteractionView` に、`location: EvidenceLocationView | null` を加える。
  - HTML は、それを使う。ID から場所を引き直さない。
- **整数の書式**
  - `format.ts` に、`formatInteger` を加える。
  - HTML は、整数（リンクの深さの上限、HTTP ステータスなど）を、これで示す。

#### 6.1.11 R16 の指摘を受けた決定（2026-09-25）

この節は、6.1.6、6.1.9、6.1.10 に優先する。

- **Safety の事象の URL は、リンクにしない**
  - Safety の事象の表の URL は、`classifyUrl` の結果によらず、すべて文字（エスケープした文字列）で示す。
  - 対象は、遮断した要求・ナビゲーション・外部への作用・ダウンロード・ポップアップなど、すべての種類である。
  - 理由は、上位の設計書 第20章の「外部アクションURLはクリック可能リンクにせず、テキスト/コピー用途として表示する」にある。
    - 安全のために実行しなかった操作を、レポートから1回のクリックで実行できるようにしてはいけない。
  - 6.1.6 のリンクの規則は、Finding、ページ、Interaction の URL に使う。
- **HTML の相対リンクの検証**
  - 相対パスが安全かどうかは、`isPortableRelativeArtifactPath`（`src/core/artifact-layout.ts`）だけで確かめる。
  - HTML の部品には、href に固有の処理（区切りごとのパーセント符号化など）だけを置く。
- **空の表**
  - 行がない表でも、何の表かが分かるように、見出しを示す。
- **バンドルに、各ページの `page.json` を入れる**
  - `evidence-index.json` の `path` の先が、ZIP の中で見つかるようにする。上位の設計書 第19章の「`evidenceRef` で一次証跡へ追跡可能にする」を、バンドル単体で満たすためである。
  - 置き方:
    - `readArtifactFile` で読んだ `pages/<pageId>/page.json` を、そのまま入れる。
    - パスは、Run のディレクトリの中と同じにする。
    - 順は、`evidence-index.json` の後、スクリーンショットの前とする。
    - ページの並びは、パスの順とする。
  - 読めなかった `page.json` は、`omittedFiles` に書く。
  - `page.json` に入っているのは、一次の証拠（Evidence）である。そのため、バンドルに入れてよい。
    - 可視テキストが入っている。
    - 開始の URL のページには、robots.txt と sitemap の本文（metadata の Evidence の `text`。設計書 5.6.2）も入っている。
      - これは、意図して集める Evidence である。1つの文書あたり、`MAX_SITE_METADATA_TEXT_LENGTH` の上限がある。
      - sitemap が大きいと、ZIP も大きくなる。これは、上限の範囲の中の大きさとして受け入れる（R16f の報告を受けて 2026-09-25 に直した）。
    - 上位の計画が「含めない」とする生の本文は、ページの HTML などの、制御していない応答の本文である。ページの HTML の本文は、Evidence に記録しない。
- **スクリーンショットの大きさの上限**
  - `src/core/limits.ts` に、`CHATGPT_BUNDLE_SCREENSHOT_BUDGET_BYTES`（64 MiB）を置く。
  - 関係するスクリーンショットは、次の順に入れる。
    1. `VIEWPORT` のもの（パスの順）
    2. `FULL_PAGE` のもの（パスの順）
  - 合計の大きさが上限を超えるものは、入れない。
    - 入れなかったものは、`omittedFiles` に、理由 `BUNDLE_SIZE_LIMIT` で書く。
    - 上限を超えた後も、それより小さいものは入れてよい。どちらにしても、決定論的であること。
  - ZIP の中のスクリーンショットの並びは、今までどおりパスの順とする。
  - `manifest.json` に、上限の値（`screenshotBudgetBytes`）を書く。
- **UI04 の検出の規則**
  - 分割代入の形の数え直しも、検出する。
    - `({ severity }) => …`
    - `for (const { severity } of …)`
    - `x['severity']`
  - 近似の検査なので、誤検知が出た場合は、理由を付けて除外の一覧に加える。

## 7. Task 17: CLI

- 利用者に見せる文言は、すべて日本語にし、`src/presentation/messages.ts` から出す（UI追補設計書 第3章）。
- 終了コードは、`src/cli/exit-codes.ts` の表だけが決める。
  - COMPLETE は 0、FAILED は 1、PARTIAL は 2、ABORTED_BY_SAFETY は 3、CONFIG_ERROR は 4。
  - サイトの ERROR の Finding の件数では決めない。
- `--headed` と `--headless` を同時に指定した場合は、CONFIG_ERROR にする。
- 設定のエラーは、短い日本語の文言で表示する。スタックトレースは出さない。
- 実行の結果として、出力先のディレクトリと、件数の要約を表示する。件数の要約は、表示用モデルから取る。
- Windows PowerShell で、日本語の出力が読めることを確かめる。文字化けする場合は、出力の側で対処するか、利用者の環境の設定として README で案内する。どちらにするかは、Task 17 の実装者が確かめた結果をもとに、設計者が決める。
  - 決定（2026-09-25。U17a の確認の結果による）: **README で案内する。**
    - 確認の結果:
      - コンソールに直接表示する場合は、PowerShell 5.1 と cmd.exe のどちらでも読める。
      - PowerShell 5.1 でパイプかリダイレクトを使い、`[Console]::OutputEncoding` が既定（コードページ 932）のままの場合だけ、文字化けする。
    - README の案内:
      - パイプやリダイレクトの前に、`[Console]::OutputEncoding = [System.Text.Encoding]::UTF8` を実行する。
      - 結果は、UTF-8 の report.html と JSON で見ることも勧める。
    - CLI の側では、コンソールのコードページを変えない。利用者の環境を、実行の後まで変えてしまうためである。
- `--help` を受け付け、使い方を示して、終了コード 0 で終える（2026-09-25 追加）。
  - 使い方の表示に、`--help` も載せる。
- R17 の指摘を受けて、次のことを決める（2026-09-25）。
  - **出力先のエラー**: 標準出力と標準エラーの出力先が閉じた場合（EPIPE など）は、そのエラーを無視する。
    - 終了コードは、Run Status（または CONFIG_ERROR）のまま変えない。
    - スタックトレースは出さない。
  - **扱われない例外**: 扱われない reject と例外は、次のように処理する。
    - 日本語の短い文言と、例外のメッセージの1行を示し、終了コード 1 で終える。
    - スタックトレースは出さない。
    - Run Coordinator の `finally` の終わりは、待たない。Chromium の終了は、Playwright がプロセスの終了時に行う処理に任せる（R17f の判断3。R17r の Minor-1 を受けて、2026-09-25 に記述を直した）。
  - **導き直した Run Status**: 終了コードは、`ArtifactWriter.writeRun` が返した最終の Run（スキーマの検証で導き直した後の Run Status）から決める。
    - これを、確定した Run から書き出しと終了コードまでを行う関数として切り出し、テストで固定する。
  - **同じオプションの重複**: 値を取るオプション（`--config`、`--output`）を2回以上指定した場合は、CONFIG_ERROR にする。
    - 理由は、上位の計画 Task 17 の Step 3 の「Reject ambiguous CLI flags」である。
  - **BOM**: 設定のファイルの先頭の UTF-8 の BOM を1つだけ取り除いてから、JSON として読む。
    - 理由は、Windows PowerShell 5.1 は、既定で BOM を付けて書くためである。
- UI Gate の GATE-UI01（CLI の分）と GATE-UI06 を作る。

## 8. 対象外

- 実サイトでの smoke と full audit（Task 20・21）。機能が完成し、ユーザーがアクセスを許可するまで行わない。

## 9. 完了条件

- [ ] Task 14〜17 の実装計画の各 Step と、この設計書の内容が満たされている。
- [ ] fixture のサイトを、実際の CLI で最後まで巡回できる（Task 19 の前の段階で確かめる）。
- [ ] `npm run verify` が PASS する。
- [ ] Task 14 と Task 15 の後の独立レビューで、Critical 0・Important 0 である（実装タスク指示 第12章のチェックポイント）。

## 10. 設計変更履歴

| 日付 | 契機 | 変更内容 | 影響範囲 |
| --- | --- | --- | --- |
| 2026-09-23 | 初版 | - | Task 14〜17 |
| 2026-09-23 | R'2 の I-2・m3 | 4.1 の手順5と8、4.4、5.3 を、`scroll` の Evidence と `LinkDiscoveryEvidence` に合わせて直した | Task 14、15 |
| 2026-09-23 | R1 の申し送り | 4.3.1 に、Interaction の候補の渡し方を加えた | Task 14 |
| 2026-09-24 | T12b・T13b・T12d の報告 | 4.3 と 4.3.0 に、Safety の Evidence とナビゲーションの結果を加えた | Task 14 |
| 2026-09-24 | Task 16・17 の着手前の調査 | 6.1 を加えた。スキーマの検証と Run Status、出力の構成、表示用モデル、表示のカテゴリ、文言と理由、URL の表示、UI Gate を決めた | Task 16、17 |
| 2026-09-25 | P18d の報告 | 5.6 に、Run のディレクトリの排他的な作成（DEF-009）の追補を加えた | なし |
| 2026-09-25 | R17r | 第7章の、扱われない例外での Browser の後始末の記述を、実装に合わせて直した | P18d |
| 2026-09-25 | R17 | 第7章に、出力先のエラー、扱われない例外、導き直した Run Status、オプションの重複、BOM、使い方への `--help` の記載を加えた | R17f |
| 2026-09-25 | U17a の報告 | 第7章に、Windows PowerShell の日本語の表示の決定（README で案内する）と、`--help` を加えた | C17a、Task 19 |
| 2026-09-25 | R16 | 6.1.11 を加えた。Safety の事象の URL をリンクにしないこと、HTML の相対リンクの検証、空の表、バンドルへの page.json の追加、スクリーンショットの大きさの上限、UI04 の検出の規則を決めた | R16f |
| 2026-09-25 | C16d の報告 | 6.1.10 に、事象の種類の値の owner（core の `SAFETY_EVENT_KINDS`）、事象の `location`、HTML の表の列（候補を含む8列）を加えた | C16e |
| 2026-09-25 | U16c の報告 | 6.1.10 を加えた。Safety の事象の一覧、Interaction の Evidence の場所、整数の書式を決めた | C16d |
| 2026-09-25 | C16a の報告 | 6.1.9 を加えた。2つの `relatedFindingIds` の意味、スクリーンショットのパスの出どころ、論理ビューを ZIP の中にだけ置くこと、`createChatGptBundle` の形と ZIP の中身、HTML レポートの詳細を決めた | C16b、U16c、U16d、U17a、Task 19 |
| 2026-09-25 | U16b の報告 | 6.1.8 を加えた。書き出しの順序、artifact の配置の owner（`src/core/artifact-layout.ts`）、「重大な指摘」の選び方、スクリーンショットの関係づけの規則を決めた | C16a、U16c、U16d、U17a |
| 2026-09-24 | R15e の報告 | 5.6.5 の古い一文を消した。第6章に、再試行の前の試行のスクリーンショットの配置と、最初の試行の Evidence の区別を加えた | C15x、Task 16 |
| 2026-09-24 | R15 | 5.6.3 に実行時間の超過の記録と重複の排除、5.6.4 に最初の試行の Evidence の保持、5.6.5 に Ledger の登録からの集計、5.6.7 に PREFLIGHT の違反を加えた | R15e、C15x |
| 2026-09-24 | R15b の報告 | 5.6.2 に、sitemap の index の扱いと、ファイルごとの page を加えた | R15d |
| 2026-09-24 | Task 15 の着手前の調査 | 5.6 を加えた。入口、サイトの metadata、URL の状態と上限、再試行、RunSummary、Run Status の入力、PREFLIGHT、fixture を決めた | Task 15、16 |
| 2026-09-24 | P14f の報告 | 4.5.5 の場面の一覧に `interaction-context-close` を加えた | なし |
| 2026-09-24 | R14r | 4.3 の構築の失敗の扱い、4.5.7 の発見の期限と予算の数え始め、collector の期限の余裕、時計の前提を直した | P14f |
| 2026-09-24 | P14e の報告 | 4.5.4 に読み込みの途中の crash の制約を加えた。4.5.7 の設定の検証とスキーマの関係を直した | なし |
| 2026-09-24 | R14 | 4.3 に構築に失敗した Context の Ledger、4.5.7 にページの期限の守り方と設定の検証を加えた | P14e |
| 2026-09-24 | P14d の報告 | 5.4.1 に、Interaction の結果の Run Status への反映を加えた | Task 15、Interaction の理由のコードのサブタスク |
| 2026-09-24 | P14c の報告 | 4.5.4 に `PAGE_CRASHED`、4.5.5 に Context と閉じる処理の失敗、ページ全体の理由、スクリーンショットの配置を加えた。第6章に、スクリーンショットの配置を加えた | P14d、Task 15、16 |
| 2026-09-24 | P14a の報告 | 4.2 に SKIPPED の扱いを加えた。4.5.7 の候補ごとの期限を、後片付けの実際の上限に合わせて直した | P14d |
| 2026-09-24 | Task 14 の着手前の調査 | 4.5 を加えた。入口、処理の順序（Interaction を Rule の前にする）、採番、ナビゲーションの結果、理由のコード、幅の走査、期限、後片付けの失敗、共通化を決めた | Task 14、15 |
