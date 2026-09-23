# BeakSight Task 11 Architecture Recovery Design

> 2026-09-20 correction: sections 4.4, 6, 8.2, 10, and 12 are superseded where they conflict with `doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-design.md`. The correction adds retryable non-terminal close ownership, a total DOM-work budget without whole-DOM selector enumeration, and separate structured work/lifecycle outcomes.

Date: 2026-08-31  
Status: User-approved approach; written design pending user review  
Scope: Task 11 mandatory checkpoint recovery only

## 1. Purpose

Task 11 の5回の局所修正後も、最終独立品質レビューで次の5件の Important が残った。

1. text-only `TreeWalker` は返却text node数しか数えず、大量の非text descendantを内部走査できる。
2. interaction freezeとowner close/invalidationを別フィールドで管理した結果、close時のlifecycle判定がfreeze記録より先に実行される。
3. ElementHandle取得直後の期限切れ分岐だけが共通dispose保護の外にある。
4. `EXECUTION_FAILED` が値として成立した後にowner closeも失敗すると、close例外が元のstatus/reason/evidenceを破棄する。
5. guard内部のredirect/request-failure相関情報がContext寿命中に無制限に保持され得る。

これらは、DOM作業量、guard lifecycle、非同期所有権、Handle所有権、結果とcleanup errorの伝播が複数の局所条件へ分散していることが共通原因である。本設計は個別条件を追加するのではなく、既存Task 5/11 owner内の境界を明示的な有限状態・有界所有・単一finalizationへ組み直す。

## 2. Authorities and constraints

次の既存authorityを維持する。

- passive HTTP判定: `src/safety/request-policy.ts`
- interaction admission: `src/safety/interaction-policy.ts`
- guarded BrowserContext lifecycle: `src/safety/passive-request-guard.ts`
- BrowserContext/interaction session ownership: `src/browser/context-factory.ts`
- candidate discovery/retained inspection: `src/interaction/discover-candidates.ts`
- isolated interaction orchestration: `src/interaction/isolated-auditor.ts`
- safety history: `src/safety/safety-ledger.ts`

新しいroute authority、request classifier、interaction entry point、DOM marker、site selector、target固有処理は追加しない。公開interface `discoverInteractionCandidates()`, `classifyInteractionCandidate()`, `auditInteraction()` は維持する。既存Task 5のserver-boundary safety semanticsを弱めない。

Git操作は禁止する。新規dependencyは不要であり、package/lockを変更しない。

## 3. Chosen architecture

承認された案1を採用する。

- guarded Contextの状態を一つのdiscriminated phaseとして扱う。
- async task、CDP redirect correlation、expected failure correlationを各ownerが明示的に有界所有する。
- browser-side text収集は返却text node数ではなく全訪問node数を制限する。
- ElementHandle取得後の全経路を一つのowner scopeへ入れる。
- work、freeze、owner closeを一つのfinalization関数で裁定し、成立済みstatus/reason/evidenceを破棄しない。

公開APIの第二入口は作らず、内部helperは各canonical ownerだけから使用する。

## 4. Guard lifecycle state machine

### 4.1 Phase model

現在の独立した `InstallationState`, `GuardMode`, owner-closing WeakSet判定を、guard state内の単一phaseへ置き換える。

```text
INSTALLING
PASSIVE_ACTIVE
FROZEN_ACTIVE
PASSIVE_CLOSING
FROZEN_CLOSING
PASSIVE_INVALIDATING
FROZEN_INVALIDATING
CLOSED
```

`FAILED` は別の曖昧なterminal phaseにせず、失敗原因をSafety Ledgerへ記録したうえで `*_INVALIDATING` または `CLOSED` へ遷移させる。phase遷移はmodule-local関数だけが行い、不可能な遷移は一度だけbounded invariantを記録してfail-closedにする。

### 4.2 Legal transitions

```text
INSTALLING -> PASSIVE_ACTIVE
PASSIVE_ACTIVE -> FROZEN_ACTIVE
PASSIVE_ACTIVE -> PASSIVE_CLOSING
FROZEN_ACTIVE -> FROZEN_CLOSING
PASSIVE_ACTIVE/PASSIVE_CLOSING -> PASSIVE_INVALIDATING
FROZEN_ACTIVE/FROZEN_CLOSING -> FROZEN_INVALIDATING
*_CLOSING -> CLOSED       only after successful owner close and owned-task drain
*_INVALIDATING -> CLOSED  only after successful invalidation close and owned-task drain
```

freezeは一方向である。`FROZEN_*` から `PASSIVE_*` へ戻らない。

### 4.3 Event precedence

各HTTP route、CDP paused Document、popup、download、frame navigation、WebSocket callbackは、最初にphase snapshotを一度取得して次の順序で裁定する。

1. `FROZEN_ACTIVE`, `FROZEN_CLOSING`, `FROZEN_INVALIDATING` なら、観測したinteraction activityをSafety Ledgerへ一度記録してからabort/cancel/closeする。
2. `PASSIVE_CLOSING`, `PASSIVE_INVALIDATING` なら、interaction eventを捏造せずfail-closedにする。
3. `PASSIVE_ACTIVE` だけが既存passive request policyへ進める。
4. `INSTALLING` 中にpage activityが現れた場合はinstallation invariantとしてfail-closedにする。

`CLOSED` へ遷移する前にowned listenerを解除し、既に開始されたcallbackをtask trackerでdrainするため、`CLOSED` phaseで新しいcallbackは存在してはならない。既にphase snapshotを取得済みのcallbackはtracked taskとしてclose完了前にsettleする。

これにより、owner close開始後に観測された実interaction activityが単なるlifecycle abortへ格下げされない。一方、通常のpassive owner teardownをinteraction violationとして誤記録しない。

### 4.4 Owner close and listener drain

guarded Context closeは次の一つの順序だけを持つ。

1. active phaseから対応する `*_CLOSING` へ同期遷移する。
2. ordinary page admissionを停止する。ただし既に設置済みのsafety callbackはclose中もeventを分類・記録できる。
3. `context.close()` を一度だけ実行する。
4. close中に開始されたguard-owned taskをstable-setでbounded drainする。
5. closeが成功した場合はowned listenerを解除し、task setが空であることを確認して `CLOSED` へ遷移する。
6. closeが失敗した場合は対応する `*_INVALIDATING` を維持し、close failureを記録して `closePassiveGuardedContext()` からrethrowする。`InteractionGuardedSession.close()` はそれをそのまま伝播し、`auditInteraction()` が捕捉して `BLOCKED_BY_SAFETY` resultへfinalizeする。factoryはContextをactiveへ戻さない。

drain deadlineは既存1,000 msを維持する。期限超過は `GUARD_PENDING_TASK_DRAIN_TIMEOUT` を一度だけ記録する。deadline後にordinary successを返さない。

## 5. Bounded guard ownership

### 5.1 Tracked tasks

module-local task trackerは `trackTask(purpose, factory)` 形式とし、Promise生成前にadmissionを行う。callback側が先にPromiseを作ってから登録する形は禁止する。

- active pending task上限はContextごとに256とする。
- 上限到達時は一度だけinvariantを記録し、Contextを対応するinvalidating phaseへ遷移させる。
- admissionされなかったordinary taskは開始しない。
- protocol requestを放置する必要がある場合はContext invalidationによりfail-closedを保証する。
- admissionされたtaskのresolve/rejectは必ず観測し、`finally`でowner setから削除する。

overflow時のContext invalidationは通常task setとは別のexactly-once reserved slotで所有する。既にowner close/invalidationが進行中なら二重closeを開始せず、その進行中closeにprotocol停止を委ねる。値は `MAX_PENDING_GUARD_TASKS = 256` としてmodule constant一箇所だけで定義する。

### 5.2 Expected CDP failure registry

`WeakMap<Page, ExpectedCdpFailure[]>` の生配列操作をmodule-local bounded registryへ置き換える。

- pageごとのentry数は64、retentionは1,000 msとする。
- insert前とlookup前に期限切れentryを削除する。
- exact method、exact URL、exact error textだけをconsumeする。
- methodは先頭32文字へsliceしてからuppercaseし、一時巨大文字列を作らない。ただし入力が32文字を超えた時点でcorrelation-ineligibleとする。
- URLが2,048文字を超える場合はtruncate aliasを作らずcorrelation-ineligibleとしてfail-closedにする。
- consume/remove後に空のpage entryを削除する。
- overflow時は一度だけinvariantを記録し、現在のrequestをfail-closedにしてContextをinvalidateする。

### 5.3 Redirect predecessor registry

CDP `requestId -> predecessor request facts` Mapもsessionごとに64 entries、retention 1,000 msの固定上限を持つ。

- `redirectedRequestId` を参照した時点でpredecessorをconsume/deleteする。
- insert/lookup時にexpired entryをpurgeする。
- exact identityに必要なmethod/URLだけをbounded validation後に保持する。
- cap到達時はevictionで処理を続けず、現在のDocumentをfail-closedにしてbounded invariantを記録する。
- session close時にregistryをclearする。

安全相関の欠落を「相関なしの成功」として扱わない。

## 6. Bounded browser traversal

candidate discoveryとretained-handle inspectionの両方で、descendant text収集を同一contractへ揃える。

- `TreeWalker` は `NodeFilter.SHOW_ALL` を用いる。
- `nextNode()` が返した全nodeを数え、text nodeだけでなくElement/Comment等も総訪問node上限へ含める。
- root群全体で512 visited nodesと1,024 charactersのbudgetを共有する。
- textは `Text.substringData(0, remaining)` だけで取得し、`textContent` と `nodeValue` は読まない。
- node budgetまたはcharacter budgetへ到達した時点で走査を終了する。
- NodeListはiterator/Array materializationを使わず、既存どおり先頭candidate上限だけを添字取得する。
- retained ordinal探索もcandidate上限までで停止し、範囲外はdisconnected/fail-closedとして扱う。

browser callbackをpage-visible global、string evaluation、DOM markerで共有しない。Playwrightのserialization境界により安全な共有ができないため、discoveryとretained inspectionのcallback本体の重複は維持する。ただし共通limit object、同じhostile tests、同じcontract assertionsでdriftを検出する。

## 7. ElementHandle ownership

`elementHandle()` がnon-nullを返した直後からdispose完了までを一つのowner scopeにする。

```text
acquire nullable handle
if null -> no-handle outcome
else -> enter owned-handle scope immediately
        all deadline/admission/click/observation returns occur inside
        dispose is caught and ledgered exactly once in the scope finalizer
```

期限切れ、admission rejection、click failure、identity loss、freeze、unexpected work errorのどの分岐にもscope外disposeを置かない。dispose rejectionは `INTERACTION_HANDLE_DISPOSE_FAILED` を記録し、既に成立したstatus/reason/evidenceを上書きしない。

handle acquisition自体がthrowした場合はhandleが存在しないためdisposeしない。

## 8. Interaction outcome finalization

### 8.1 Single outcome channel

`executeInteraction()` は成功・機械的拒否・not-verifiable・click failureをすべて `InteractionWorkOutcome` 値として返す。unexpected throwは `auditInteraction()` がbounded `EXECUTION_FAILED` outcomeへ一度だけ変換する。

work outcomeを確定してからowner closeを実行し、その後一つのpure finalizerが次を裁定する。

1. final Safety Ledgerにfreeze eventがあれば `BLOCKED_BY_SAFETY`。
2. owner closeがrejectした場合も `BLOCKED_BY_SAFETY`。
3. それ以外はwork outcomeを維持する。

### 8.2 Preserving prior work and close failure

owner close failureで元のwork outcomeを破棄しない。

- `evidence` は元のwork outcomeのimmutable evidenceをそのまま保持する。
- final reasonは `owner close failed` と元のstatus/reasonを含むbounded summaryとする。
- close errorはSafety Ledgerへ `INTERACTION_OWNER_CLOSE_FAILED` としてbounded記録する。Task 5 wrapperが記録した `GUARDED_CONTEXT_CLOSE_FAILED` も保持する。
- unexpected work errorは元のbounded `EXECUTION_FAILED` reasonとして保持し、close failureが重なってもreasonまたはledgerから両原因が観測可能である。
- final statusが `BLOCKED_BY_SAFETY` の結果を受けたcallerは、そのinteraction/page/runをclean successとして継続してはならない。Task 14/15はこの既存status semanticsを使用する。

session factoryが失敗してsession/ledgerを一度も取得できなかった場合だけは、`auditInteraction()` 自体がrejectする。この場合は保存可能なinteraction resultが存在しない。

### 8.3 Immutable snapshot boundary

owner close attemptとguard task drainが完了した後に一度だけfinal Safety Ledger snapshotを取得する。返却結果はdeep immutableであり、後続ledger mutationの参照を保持しない。owner closeが失敗した場合、このsnapshotは成功したterminal stateを主張するものではなく、close attempt/drain完了時点のcutoff evidenceである。`BLOCKED_BY_SAFETY` により後続処理がclean successとして継続することを禁止する。

## 9. Test design

すべてproduction変更前にgenuine REDを作る。

### 9.1 Lifecycle/freeze RED

- `FROZEN_ACTIVE -> FROZEN_CLOSING` 中にHTTP routeが到着し、interaction request/navigationが記録され、server hitが0、final statusが `BLOCKED_BY_SAFETY`。
- 同じraceをCDP paused Documentで再現する。
- `PASSIVE_CLOSING` 中のowner-generated failureはinteraction eventを捏造しない。
- freezeとclose/invalidationが競合してもphaseがpassiveへ戻らない。

### 9.2 Bounded registry RED

- expected CDP failuresをcap超過させ、entryが上限内、overflow invariantが一度、現在requestがfail-closed。
- expired/consumed entryが確実に削除され、mismatchはunrelated failureを抑制しない。
- redirect predecessorをcap超過させ、無制限保持せず現在Documentをfail-closed。
- overlong method/URLが巨大uppercase allocationやtruncate identity aliasを作らない。
- tracked task overflowがuntracked Promiseを開始しない。

private collectionのサイズそのものをtest-only exportで公開しない。fake CDP/session harnessのcommand数、ledger、close/invalidation、再利用拒否というpublic behaviorで証明する。

### 9.3 DOM-work RED

- 10万個の空Elementの後にtext nodeを置く hostile subtreeで、`SHOW_TEXT`なら内部走査する旧実装を失敗させる。
- patched `TreeWalker.nextNode()` の呼出し回数が総node上限を超えない。
- discovery/retained inspectionの両経路で同じ上限を証明する。
- `textContent`, `nodeValue`, NodeList iteratorが使われない既存試験を維持する。

### 9.4 Handle/result RED

- handle acquisitionが期限を消費し、そのhandleのdisposeもrejectする場合、final statusは `NOT_VERIFIABLE`、元reason/evidence保持、dispose invariantあり。
- clickが状態を変えてordinary Errorを返し、owner closeもrejectする場合、final statusは `BLOCKED_BY_SAFETY`、click reasonとobserved evidence保持、close errorはledgerに存在。
- unexpected work throwとowner close rejectionの双方が観測可能。
- safety-block outcomeとdispose rejectionが重なってもfreeze status/evidenceを維持する。

### 9.5 Regression verification

- Task 11 focused suites
- Task 5/6/11 adjacent suites
- typecheck
- build
- full repository suite
- package/lock hash
- forbidden site selector、DOM marker、string evaluation、live target scan
- S03-S08 fixture-server counters

最終的にfreshな独立spec reviewとcode-quality reviewを行う。Task 11 mandatory checkpointのPASS条件はCritical 0、Important 0、全required verification PASSである。

## 10. Files in scope

Production:

- `src/safety/passive-request-guard.ts`
- `src/interaction/discover-candidates.ts`
- `src/interaction/isolated-auditor.ts`

Tests/fixtures:

- `tests/integration/passive-request-guard.test.ts`
- `tests/integration/isolated-interaction.test.ts`
- `fixtures/site/hostile-candidates.html`

新しいinvariant codeは既存 `SafetyLedger.recordInvariantViolation()` で記録できるため、`src/safety/safety-ledger.ts` の変更は行わない。`src/safety/request-policy.ts`, `src/safety/interaction-policy.ts`, `src/browser/context-factory.ts` の公開semantic ownerも変更しない。consumer変更が必要になった場合は本設計の範囲逸脱として実装を停止し、再設計する。

## 11. Non-goals

- Task 12以降のRule Engine、page pipeline、crawler、reporter実装
- 新しいInteractionStatus
- retryによるunsafe interaction再実行
- site-specific candidate policy
- browser internals/private Playwright API
- live target access
- dependency追加・更新
- Task 5 passive policyの再実装

## 12. Completion criteria

Task 11 architecture recoveryは次をすべて満たした場合だけ完了する。

1. phaseがsingle sourceで、frozen closing/invalidation中の全観測activityがfreeze eventとして記録される。
2. passive owner teardownはinteraction eventを捏造しない。
3. guard-owned taskと全相関registryが有限で、overflowはfail-closedかつ一度だけledgeredされる。
4. candidate text収集の総訪問node数と文字数が両方有限である。
5. non-null ElementHandleの全寿命が一つのprotected owner scope内にある。
6. work outcome、freeze event、dispose error、owner close errorの優先順位が一つのfinalizerで決まり、元reason/evidenceが失われない。
7. S03-S08 server-boundary zero-delivery proofsが維持される。
8. focused、adjacent、typecheck、build、full suiteがfresh PASSする。
9. package/lock不変、Git操作なし、dependency操作なし、live targetなし。
10. 独立reviewでCritical 0、Important 0となる。
