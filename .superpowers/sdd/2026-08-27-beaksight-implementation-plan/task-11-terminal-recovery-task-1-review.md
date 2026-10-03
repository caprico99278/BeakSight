# Task 11 terminal recovery — independent Task 1 review

Date: 2026-09-20. Reviewer: fresh independent Task 1 reviewer. Scope: the fixed no-Git Task 1 package and approved controller rulings.

## Verdict

**FAIL — Critical 0, Important 2, new Minor 0. Task 1 may not advance to Task 2.**

The canonical owner retry, ordinary/retry overlap, publication barrier, sticky invalidation, drain-only recovery, and terminal-only factory/session release are implemented. Two approval-blocking defects remain at the integration boundary between the new retryable attempt and existing invalidation callers: a protocol callback can implicitly start a second close after a fast rejection, and hostile raw-close rejection can escape event rejection containment. Both were reproduced against the unchanged production TypeScript, not inferred solely from the implementation report.

Historical/deferred Minors are inventoried separately below and are not counted as new Task 1 findings. Task 11 overall remains unapproved; this review does not adjudicate the future DOM-budget or structured-outcome implementations.

## Fixed-package verification

The manifest was read first. Before source review, all 11 entries were independently hashed with PowerShell `Get-FileHash -Algorithm SHA256` and compared to the manifest. Result: **11/11 match**. The following are the independently computed actual hashes, each identical to its expected hash:

| Path | Actual SHA-256 | Result |
| --- | --- | --- |
| `doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-design.md` | `1DA1DD0FDE5784F6E078088924F54370A87D990304A7FEFAB27FE8B3CF8A962E` | MATCH |
| `doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-implementation-plan.md` | `A5833C3DD729742E47E251AE9DF49DAB63DECB80B654BF6DCDA236038CF77E6D` | MATCH |
| `src/safety/passive-request-guard.ts` | `0B4F289617A4FE148F5B75D2E384A2A095F68244D69DCBC5A832BD4A8D2305C2` | MATCH |
| `src/browser/context-factory.ts` | `6690D8EBEDD061602B1D3417602F80E3E263D9A4FB6677AB304712EB782D0508` | MATCH |
| `tests/integration/passive-request-guard.test.ts` | `A2CC7C652C6A1838EA51231AA817825F12468840A90B11EE0C843552B1C8DDD1` | MATCH |
| `tests/component/context-factory.test.ts` | `F43C49FC11C9915987DF8031A31EA3F040F43ACA2209E793A6D05F087A11BDC9` | MATCH |
| `package.json` | `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` | MATCH |
| `package-lock.json` | `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A` | MATCH |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-1-report.md` | `1C98AE6F5B2CAB890948E312BD3108039AF6AE1984555DFA627D488FD12C219C` | MATCH |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-recovery-task-5-report.md` | `1F3642997763868C8558395051E3178B63F92ACA0FF6F9E6974FBF0B3FEDFCC1` | MATCH |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/progress.md` | `C13547F9C355DC4B141EBE2799A882FDD14A73554B0715BF0E0D703B73C9FB6E` | MATCH |

Read the approved design, implementation-plan introduction and complete Task 1 (lines 59–328), complete Task 1 report, both complete production files, and both complete scoped test files. Read the relevant historical/controller portions of the pinned reports/ledger. No Git provenance was used.

## Approval-blocking findings

### I1 — One protocol callback implicitly retries a fast failed close

Severity: **Important**. Primary location: `src/safety/passive-request-guard.ts:576–585`, particularly the two calls at **580 and 584**. Related attempt clearing: **481–486**. Test gap: `tests/integration/passive-request-guard.test.ts:222–230` and **2034–2058**.

`runGuardProtocolTask()` requests invalidation in its owned task's `finally`, discards that initiation Promise, and subsequently calls `invalidateContext()` again from `owned.then`. With the new retryable attempt, those are not guaranteed to observe the same attempt. If raw `context.close()` throws synchronously or returns an already-rejected Promise, the rejection handler clears `closeAttempt` before the later `owned.then` executes. The second call then starts another physical close without a new owner call.

The diagnostic invoked one ordinary blocked WebSocket callback whose socket close failed. Raw Context close failed on its first call and fulfilled on any later call. In both the synchronous-throw and direct-`Promise.reject` cases, it observed **two raw closes, canonical CLOSED, and a fulfilled callback**, with no explicit factory/session/Guard owner retry. Thus the failed attempt's outcome is also hidden from that callback. The violation is sequential accidental retry, not concurrent raw close.

The current supplemental HTTP/WebSocket tests do not reject this behavior: their `async close()` returns `Promise.reject(attempt.error)` at test line 228, introducing Promise-adoption turns. The identical diagnostic with that timing shape observed one raw close, a non-terminal Guard, and the original raw error, explaining their reported GREEN. The existing tests therefore establish only that timing case; the report's broader no-automatic-retry claim is unsupported.

This violates design §4.3's failed-attempt semantics and later explicit retry boundary, the controller's retained handoff rule, and Task 1 Step 9's requirement that protocol/event callers observe the current attempt. It is a demonstrated code-path defect under a valid immediate rejected-Promise close boundary. The diagnostic does not claim a live Chromium failure was induced or that every Playwright close failure has this timing.

### I2 — Hostile raw-close rejection escapes the supposedly contained initiation Promise

Severity: **Important**. Primary location: `src/safety/passive-request-guard.ts:500–506`, especially **502**. Raw-error propagation: **455–463**, **493–497**. Discarded-Promise callers include **580**, **928**, **1113**, **1152**, and **1215**; the async requestfailed listener also awaits it at **1257** and **1302**.

The new attempt deliberately rejects with the original arbitrary raw-close value. `initiateInvalidation()` first tests that value with `error instanceof GuardTaskDrainTimeoutError`. For a Proxy whose `getPrototypeOf` throws (already a supported hostile-error shape in `tests/integration/passive-request-guard.test.ts:96–106`), this check itself throws. The catch callback's returned Promise therefore rejects, and the listed void event/protocol callers do not observe it. An EventEmitter also does not own the Promise returned by its async requestfailed listener.

The diagnostic used that Proxy as the first raw-close rejection and retained the slower harness timing to isolate this defect from I1. It observed the original raw rejection at the public protocol callback, one raw close, a non-terminal Guard, and a separate process **`unhandledRejection: Error('hostile prototype')`**. The diagnostic installed an observer solely to record that escaped rejection; absent containment, it remains an unhandled process error.

The earlier `errorMessage()` invocation safely produces the bounded fallback at lines 155–161, and the raw-close ledger entry exists. That does not protect the later `instanceof`, which runs outside that normalization guard and throws before `GUARD_CONTEXT_INVALIDATION_OWNER_FAILED` can be recorded. Existing hostile-error tests cover cancellation, enforcement, cleanup, and bigint normalization with successful raw close (test lines 1275–1410); the event-containment test covers a known drain-timeout Error (2574–2617). Neither covers this newly propagated raw-close value.

This violates Task 1 Step 9's explicit preservation of initiation rejection containment and the required no-unhandled-rejection axis. It is demonstrated against production code, not a hypothetical failure of the normalizer.

## Requirement-by-requirement assessment

| Requirement | Assessment and evidence |
| --- | --- |
| Later explicit owner retry after raw-close failure | PASS for canonical owner path. Guard 455–486 preserves invalidating phase and clears the failed attempt; 834–848 admits a later attempt. Tests 1967–1979 verify first failure, second close, terminal state, and retained fail-closed admission. |
| One active attempt for overlapping retry callers | PASS. Guard 444 returns the published attempt; tests 1982–2008 gate the second physical close, hold both callers pending, and assert total count two. I1 is a separate sequential re-entry defect. |
| Ordinary close callers join the same attempt | PASS. Guard 843–845 avoids reapplying an invalid transition to an already-closing phase; tests 2011–2031 require two pending callers and one physical close. |
| Publication before synchronous re-entry | PASS. Guard 448–450 awaits the start barrier; 480 publishes before 489 starts it. Tests 897–969 hold the re-entrant waiter through close and drain; 2062–2087 exercise normal close plus immediate invalidation and failure/retry. |
| Invalidation permanently outranks normal close | PASS. Guard 496 promotes synchronously; 470–478 captures immutable terminal metadata before CLOSED; 841–848 rejects promoted ordinary close. Invalidating retries never call `ownerClosingPhase`. |
| Raw close succeeds, drain times out, retry drains only | PASS. Guard 454 records confirmation only after fulfillment; 451 skips physical close subsequently; 474–476 retains non-terminal invalidation on timeout. Tests 1627–1675 and 1681–1719 assert timeout, later CLOSED, and one raw close; first case also checks no repeated listener inverse. |
| Raw-close failure retains listeners, tasks, and owner | PASS in the canonical attempt. Guard throws at 463 before listener detach/drain; pending set is not cleared. Tests 755–820 hold retained work through later retry; 1413–1468 retain actual registered listeners after repeated Error/undefined failures. I1 can consume that retained opportunity implicitly from a protocol callback. |
| CLOSED only after confirmed raw close and successful stable drain | PASS. Guard 451–467 orders close before drain; 350–383 calls terminal callback only after final empty-set observation; 469–476 separates timeout from terminal. No second phase owner found. |
| Factory/session release only after canonical CLOSED | PASS. Factory 94–99, 134–136, 155–159, 174, and 185 consult Guard terminal state. Component tests 360–387 and 411–433 verify retained live page after failure, physical close after retry, and rejection of later owner calls. Session `closed` is terminal-derived release bookkeeping. |
| Construction-error handoff without implicit retry | PASS for the scoped installation/readiness handoffs. Factory 94–95 and 155–156 return the retained Context; 110 rethrows that handoff unchanged. Component tests 123–178 and 439–471 verify original cause, one initial attempt, retained Context, explicit recovery, and release. |
| Original page/install causes not masked | PASS. Guard 823–824, 1132–1133, and 1463–1464 contain secondary invalidation rejection and throw the primary error. Component tests 158–165 preserve installation identity/readiness cause chain; guard test 792 and component test 456 preserve page-close failure. |
| No accidental automatic retry | **FAIL — I1.** The attempt helper itself adds no timer/backoff/loop, but protocol initiation and subsequent join are two retry-capable calls. |
| No unhandled rejection | **FAIL — I2.** Timeout and ordinary Error containment are covered; hostile raw rejection defeats the `instanceof` boundary. |
| No second lifecycle authority | PASS. Phase remains the admission/terminal authority; `rawCloseConfirmed` is a physical fact; immutable `invalidated` is terminal return metadata. Factory delegates rather than defining a recovery manager. |

## Controller rulings and evidence audit

The applicable rulings are recorded consistently in Task 1 report **44–46**, Task 5 report **687–689**, and progress ledger **381**. They are consistent with the approved design and were assessed as follows:

1. Prompt raw-close rejection with retained pending tasks/listeners/owner: canonical attempt obeys it; the rewritten late-evidence test 755–820 tests pending work during explicit recovery rather than preserving the superseded failed-close drain wait.
2. Original page/installation error remains primary: wrapper catches observe the already-ledgered secondary rejection and rethrow the original; source and assertions support this ruling.
3. Readiness failure immediately hands off non-terminal Context rather than performing implicit cleanup retry: factory 154–159 implements it, including the existing-invalidation case tested at component 394–408.
4. Interaction-session construction preserves that handoff unchanged: factory 110 prevents another close attempt; real Context tests assert one initial raw close before receiving the handoff.

No controller ruling authorizes I1's second protocol-originated close or I2's escaped rejection. Historical permanent join/no-retry assertions are superseded only where the approved correction explicitly replaces them. Historical DOM-budget and structured-outcome rulings do not waive the later approved correction and are outside this Task 1 review.

The report distinguishes genuine pre-production REDs from the initial browser `spawn EPERM`, interrupted recursive Context assertion, intermediate obsolete-expectation failures, and supplemental already-green checks. That accounting is clear. Reported 23 focused / 128 two-file / 449 repository passes and typecheck exit 0 are implementer evidence, not reviewer reruns. The broad final invariant claims at Task 1 report 133–136 do not override the two reproduced failures.

## Test mutation strength

The explicit-owner tests kill permanent failed-attempt retention, per-waiter raw close, early caller settlement, failure to preserve invalidation through terminal transition, premature factory/session release, construction-time implicit cleanup retry, raw-close repetition after drain timeout, and masking primary page/installation errors. The gate assertions in retry/ordinary overlap are observably stronger than raw counts alone. The retained-task test proves a successful retry cannot finish while previous evidence work remains pending. Existing listener tests verify registered listener removal/retention, including undefined rejection.

Two important holes remain, included in I1/I2 rather than double-counted as separate Minors: the per-attempt rejection harness artificially delays failure at test 228, and raw-close hostile rejection never enters the event containment assertions. The no-edit diagnostic's matching asynchronous-adoption control proves why the supplemental tests can pass while immediate rejection fails. Report claims of mutation coverage are reasoned claims; no source-mutating mutation run was performed by this reviewer.

## Executed diagnostic and limitations

After static review identified the two doubts, the controller explicitly authorized one narrowly focused **no-edit Node/Vitest check**. Executed one Node stdin diagnostic (`node --input-type=module`, Node **v24.15.0**), exit **0**. It loaded the unchanged production `.ts` files using Node's built-in type stripping and a process-local built-in module resolver for existing relative `.js` imports. It imported no third-party package and used no browser, network, fixture server, build output, or file write. Its four cases shared the same actual installed Guard WebSocket handler. A process observer recorded escaped rejection rather than allowing the diagnostic process to terminate.

| Raw close first-call behavior | Raw close calls before any explicit retry | Guard CLOSED | Callback outcome | Escaped rejection |
| --- | --- | --- | --- | --- |
| synchronous throw of Error | 2 | true | fulfilled | none |
| direct `Promise.reject(Error)` | 2 | true | fulfilled | none |
| `async () => Promise.reject(Error)` adoption control | 1 | false | original raw error | none |
| async-adopted hostile Proxy rejection | 1 | false | original raw value | `hostile prototype` |

All later raw close calls in the diagnostic fulfill. The first two cases therefore prove an unwanted second attempt and callback success, not just a scheduling risk. The fourth isolates the containment defect. No claim is made about live-browser occurrence frequency.

Exact JavaScript payload, piped via a literal PowerShell here-string to `node --input-type=module`:

```js
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('.js') && context.parentURL?.startsWith('file:')) {
    const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
    if (candidate.pathname.includes('/BeakSight/src/') && existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
  }
  return nextResolve(specifier, context);
} });
const { installPassiveRequestGuard, isPassiveRequestGuardClosed } = await import('./src/safety/passive-request-guard.ts');
const { SafetyLedger } = await import('./src/safety/safety-ledger.ts');
const unhandled = [];
process.on('unhandledRejection', error => unhandled.push(error));
for (const mode of ['SYNC_THROW', 'DIRECT_REJECT', 'ASYNC_ADOPT_REJECT', 'HOSTILE_RAW_REJECTION']) {
  let count = 0;
  let websocket;
  const rawFailure = mode === 'HOSTILE_RAW_REJECTION'
    ? new Proxy({}, { get() { throw new Error('hostile property'); }, getPrototypeOf() { throw new Error('hostile prototype'); } })
    : new Error('first raw close failed');
  const rawContext = {
    pages: () => [], on() {}, off() {},
    async routeWebSocket(_pattern, handler) { websocket = handler; },
    async route() {},
    close() {
      count += 1;
      if (count > 1) return Promise.resolve();
      if (mode === 'SYNC_THROW') throw rawFailure;
      if (mode === 'ASYNC_ADOPT_REJECT' || mode === 'HOSTILE_RAW_REJECTION') return (async () => Promise.reject(rawFailure))();
      return Promise.reject(rawFailure);
    },
  };
  const ledger = new SafetyLedger();
  await installPassiveRequestGuard(rawContext, ledger, new Set(['https://example.test']));
  let result;
  await websocket({ url: () => 'wss://example.test/blocked', close: async () => { throw new Error('protocol close failed'); } }).then(
    () => { result = 'FULFILLED'; },
    error => { result = error === rawFailure ? 'ORIGINAL_RAW_FAILURE' : 'OTHER_REJECTION'; },
  );
  await new Promise(resolve => setImmediate(resolve));
  console.log(JSON.stringify({ mode, rawCloseCalls: count, closed: isPassiveRequestGuardClosed(rawContext), callback: result, unhandled: unhandled.map(error => error.message), codes: ledger.snapshot().invariantViolations.map(entry => entry.code) }));
  unhandled.length = 0;
}
```

No existing test suite was rerun. NOT RUN — focused/two-file/repository Vitest suites and `npm run typecheck`: this review used the pinned implementation evidence plus the single authorized diagnostic; impact: reported suite results were not independently re-executed; completion blocker: the two demonstrated Importants already block Task 1, and corrected code will need fresh verification. NOT RUN — `npm run build`: deferred by the Task 1 fixed scope; impact: no fresh emitted-output verification; completion blocker: final Task 11, not this review artifact. NOT RUN — Task 2+ implementation/gates: outside authorization; impact: no DOM-budget or structured-outcome acceptance; completion blocker: final Task 11.

## Historical/deferred Minor inventory — separate from new Task 1 counts

The pinned Task 5 report **684** explicitly carries five named items. This review preserves their disposition:

| Historical item | Fixed-package reference and current scoped location | Disposition |
| --- | --- | --- |
| Lifecycle-phase HTTP abort correlation omits `expectedRouteFailures` | Task 5 report 684; Guard **1391–1396**, compared with **1252–1253** | Historical Minor; not silently fixed or counted anew. |
| `emitFailedMainFrameRequest()` drops its async return | Task 5 report 684; Guard test **325–337** | Historical Minor; not counted anew. New tests still use it, but the independent diagnostic observes the actual callback directly. |
| Page-readiness task-factory indentation | Task 5 report 684; Guard **906–914**, **1109–1117** | Historical style Minor; no semantic correction requested here. |
| Isolated-auditor BigInt/String normalization | Task 5 report **684** | Historical out-of-package Minor; auditor source is not one of the two scoped production files, so this review does not claim fresh source-line verification or adjudication. |
| Old implementation-plan illustration drift | Task 5 report **684** | Historical non-runtime Minor concerning earlier recovery examples, not a new finding against approved Task 1. |

Progress ledger **366** additionally records the prior specification review's sixth, test-strength-only Minor, while the prior quality review counted five historical Minors. The fixed package does not identify that sixth item's precise original source location, so it is preserved as a historical recorded item rather than inventing a new finding or asserting it has been resolved. Historical count provenance is therefore **five named deferred items plus one separately recorded prior test-strength item**, not six new Task 1 Minors.

## Advancement and constraint confirmation

Task 1 cannot advance while I1/I2 remain open. The direct owner lifecycle improvements are accepted as implemented; acceptance of the overall Task 1 contract is withheld. No fix is proposed or implemented in this review. A corrected fixed package needs fresh relevant verification and independent re-review before Task 2 starts.

Only this requested review artifact was created. No production, tests, specification, plan, report, manifest, package, or lockfile was modified. No Git operation, dependency download/install/new third-party import, live-target access, browser launch, Task 2+ work, or subagent creation occurred. Diagnostic imports were Node built-ins and existing local source only. Manifest entries are rechecked at review handoff; the artifact hash is returned separately to avoid a self-referential digest.
