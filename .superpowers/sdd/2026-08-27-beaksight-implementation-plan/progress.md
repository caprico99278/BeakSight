# SDD ledger — plan: doc/design/2026-08-27-beaksight-implementation-plan.md

## Authority

- Binding spec: `doc/design/2026-08-27-beaksight-web-audit-design.md`.
- Binding execution instructions: `doc/design/2026-08-27-beaksight-implementation-tasks.md`.
- The execution instructions explicitly override conflicting Architecture / SSOT Invariants and concrete task details in the older implementation plan.
- Git operations are prohibited by the user. Task boundaries use filesystem manifests, SHA-256 hashes, focused test evidence, implementer reports, and independent read-only reviews instead of commits or Git diffs.

## Environment

- Workspace: `C:\Develop\github-repo\BeakSight`.
- Initial contents: the three approved design/implementation documents only.
- Runtime detected: Node.js `v24.15.0`, npm `11.12.1`.
- No usable pre-existing repository/worktree was present.
- `.git-sandbox-backup` contains Git metadata created and then safely moved aside before the user prohibited Git operations. It is not part of the implementation and must not be touched during this plan.

## Pre-flight rulings

- Ruling: Treat the fresh workspace itself as isolated — there was no pre-existing source tree or user branch to protect, and Git/worktree operations are now forbidden — if wrong, task changes would need to be moved manually into a user-selected checkout.
- Ruling: Use `config/targets/本来の監査対象のサイト-public.json` with mandatory unique `target.id`, superseding every older `config/本来の監査対象のサイト.json` reference — the execution instructions declare Target Isolation and the owner matrix authoritative — if wrong, CLI examples and tests would need a path migration.
- Ruling: The initial `target.id` is `本来の監査対象のサイト-public`; `DEFAULT_CONFIG` remains generic and never fabricates a target identity, while `loadConfig()` resolves the final immutable `AuditConfig` — this keeps Target Isolation and Configuration SSOT compatible — if wrong, the target identifier and config input types would need migration.
- Ruling: `loadConfig(path, overrides?)` is the sole production configuration authority; CLI parsing supplies typed overrides but performs no merge or target-file reading itself — this is required by Configuration SSOT — if wrong, CLI wiring would need to move merge behavior.
- Ruling: `discoverLinks()` is the sole anchor/href extractor; Task 8 DOM collection consumes/reuses its `LinkEvidence[]` instead of extracting links again — this resolves the Task 3/Task 8 duplication conflict — if wrong, DOM collector contracts and integration tests would need adjustment.
- Ruling: Finding fingerprint generation lives only in `src/core/ids.ts`; Rule Engine calls `createFindingFingerprint()` and never owns fingerprint semantics — this supersedes Task 12's looser wording — if wrong, rule-engine contracts would need relocation.
- Ruling: Page rules are registered exactly once in `src/audit/rule-catalog.ts`; `RuleEngine` consumes `RULE_CATALOG`, while cross-page rules remain exclusively behind `evaluateCrossPageRules()` — this adds the mandated catalog owner absent from the older file tree — if wrong, registration tests and imports would need consolidation.
- Ruling: `deriveRunStatus()` remains the only status authority; artifact/schema failures are execution facts passed into it, never status decisions inside reporters — this satisfies both A10 and Run Status SSOT — if wrong, finalization orchestration would require redesign.
- Ruling: `validateArtifact()` is the only JSON Schema validation entry point and `ArtifactWriter.writeRun()` is the only final serializer; CLI and coordinator depend on those typed interfaces — this resolves Task 2/16/17 ownership overlap — if wrong, report composition would need rework.
- Ruling: Task 18 includes `GATE-ARCH01` through `GATE-ARCH08` in `tests/architecture/target-isolation.test.ts` and `tests/architecture/semantic-ownership.test.ts`, in addition to S01-S10 and A01-A10 — the execution instructions explicitly require these gates — if wrong, only the acceptance suite layout changes.
- Ruling: Mandatory review checkpoints are the union of both documents: Tasks 3, 5, 11, 14, 15, 18, and 21 — the newer execution instructions add 3 and 14 — if wrong, this only adds review effort and does not alter production behavior.
- Ruling: Task 20/21 commands use the canonical target config path and never hard-code target identity/URL in commands or `src/**` — required by Target Isolation — if wrong, operational documentation would need path edits.

## Pre-flight task self-consistency scan

| Task | Produces / verifies | Internal consistency and ruling |
|---|---|---|
| 1 | package, strict TS, config owner, CLI stub, target config | Conflict: older path lacks `target.id` and `loadConfig` overrides. Apply authoritative rulings above; otherwise internally consistent. |
| 2 | contracts, IDs, status, schemas, validator | Conflict: generic `EvidenceRecord<T = unknown>` must not become a broad unbounded production escape hatch; use bounded typed payload contracts/unions where consumers require them. |
| 3 | URL normalization, admission, queue, link owner | Internally consistent when external/special links are recorded as canonical `LinkEvidence` and only internal HTTP(S) URLs reach the queue. |
| 4 | fixture server and mutation counters | Internally consistent; its direct `fetch` is test-only and does not violate production browser-network authority. |
| 5 | passive request policy, ledger, redaction | Internally consistent; server-boundary counters are the authority for proving blocked mutations. |
| 6 | guarded contexts, settling, scrolling | Internally consistent if every context is created with injected config and Safety Ledger dependencies. |
| 7 | network/console collectors | Internally consistent; collectors emit evidence only and share header redaction from Task 5. |
| 8 | DOM/content/screenshots | Conflict with link SSOT resolved by consuming Task 3 `discoverLinks()` output, not querying anchors locally. |
| 9 | layout/accessibility/color evidence | Internally consistent; deterministic geometry candidates remain Evidence until rules evaluate them. |
| 10 | performance/telemetry evidence | Internally consistent; missing vitals remain explicit states and browser-observable telemetry is not called private APM/RUM. |
| 11 | interaction policy and isolated auditor | Internally consistent if freeze is installed after passive load and before the candidate action, with fail-closed capability handling. |
| 12 | deterministic page rules | Conflict with owner matrix resolved by central `RULE_CATALOG` and `createFindingFingerprint()` delegation. |
| 13 | cross-page rules | Internally consistent; only `evaluateCrossPageRules()` owns cross-page semantics. |
| 14 | page audit pipeline | Conflict with Task 8 resolved by reusing canonical `LinkEvidence[]`; all collector results precede rule evaluation. |
| 15 | coordinator, BFS, metadata, completion | Internally consistent if `deriveRunStatus()` alone finalizes status and guarded BrowserContexts are used for metadata. |
| 16 | artifacts, HTML, ZIP | Potential status/validation cycle resolved by validator result becoming an input fact to `deriveRunStatus()` before final canonical serialization. |
| 17 | production CLI | Conflict with Config SSOT resolved by CLI parsing only explicit typed overrides and calling `loadConfig(path, overrides)`. |
| 18 | fixture/gate completion | Older plan omitted architecture gates; add ARCH01-ARCH08 exactly as required by execution instructions. |
| 19 | full verification, browser install, fixture crawl, README | Internally consistent after canonical target config path updates. Browser install is dependency setup already authorized by the user. |
| 20 | target smoke | Older path updated. Access is strictly gated by fresh Safety/Auditor/Architecture pass evidence. |
| 21 | full target audit | Older path updated. Full audit runs only after smoke PASS and must report honest completion state. |

## Cross-task interface/file scan

| Tasks | Producer -> consumer / shared surface | Finding |
|---|---|---|
| 1 -> 3, 6, 15, 17, 20, 21 | `AuditConfig`, defaults, `loadConfig()` | Single config authority; all consumers receive immutable config by DI. |
| 1 -> 17 | `src/cli/index.ts` stub -> production CLI | Intentional replacement; Task 17 must remove the stub without creating a second entry point. |
| 1 -> 19, 20, 21 | target config -> docs/smoke/full runs | Canonical path and `target.id` ruling applies to all consumers. |
| 2 -> 3-21 | core contracts and branded IDs | Consumers import contracts; no local redefinition of IDs/status/evidence/finding semantics. |
| 2 -> 12 | `createFindingFingerprint()` -> Rule Engine | Fingerprint owner remains `src/core/ids.ts`. |
| 2 -> 15, 16, 17, 18 | `deriveRunStatus()` -> coordinator/report/CLI/gates | Only Task 15/finalization invokes the owner; reporters/CLI map or display the result. |
| 2 -> 16, 18 | `validateArtifact()` -> ArtifactWriter/A10/ARCH08 | All schema checks delegate to the same owner. |
| 3 -> 8, 14, 15, 18 | `LinkEvidence[]` and URL semantics | Link extraction happens once; models are reused through page result, crawl, rules, and report. |
| 3 -> 15 | `CrawlQueue`, `normalizeUrl`, `classifyUrl` | Coordinator owns sequencing but not URL semantics or queue internals. |
| 4 -> 5, 7, 11, 18, 19 | fixture server/site extended across tasks | Later tasks extend the same fixture authority; mutation counters remain server-side. |
| 5 -> 6, 11, 15, 18 | request policy, Safety Ledger, redaction | Contexts/auditors/coordinator depend on injected safety interfaces; no local method checks. |
| 6 -> 9, 10, 11, 14, 15 | context factory/settling/scroll | All browser lifecycles flow through the factory; no alternate unguarded context path. |
| 7 -> 10, 12, 14, 16 | network/console evidence | Redacted network evidence is reused for telemetry/rules/reports. |
| 8 -> 14, 16 | DOM and screenshot evidence | PageAuditor owns ordering; reporter joins findings to screenshot evidence later. |
| 9 -> 12, 14, 18 | layout/a11y/color evidence | Collectors do not emit findings; catalog rules map normalized evidence. |
| 10 -> 12, 14, 16 | performance evidence | Missing metrics stay explicit through rule/report layers. |
| 11 -> 14, 18 | interaction audit results | Page pipeline optionally invokes isolated auditor; acceptance gates prove fail-closed behavior. |
| 12 -> 14, 15, 18 | `RULE_CATALOG` / Rule Engine | Page rules come only from catalog; coordinator does not evaluate page rules. |
| 13 -> 15, 18 | `evaluateCrossPageRules()` | Coordinator invokes once after crawl; reporters do not reevaluate. |
| 14 -> 15 | `PageAuditResult` | Coordinator reuses all canonical evidence, especially links, without re-extraction. |
| 15 -> 16, 17, 18, 19-21 | `AuditRun` | Artifacts/CLI/gates/real runs consume the same run model and honest status facts. |
| 16 -> 17, 18, 19-21 | `ArtifactWriter.writeRun()` | Sole final serialization path for fixture and target runs. |
| 17 -> 19-21 | built CLI | Fixture, smoke, and full audit exercise the production entry point only. |
| 18 -> 20 | all S/A/ARCH gates | Target access remains blocked unless every required gate passes freshly. |
| 20 -> 21 | smoke evidence -> full-audit permission | Any safety invariant violation or smoke failure prevents Task 21. |

## Progress

- Setup: complete (Git-free workspace, authority review, pre-flight scan, and rulings recorded).
- Task 1: fix round 1/5 (5 findings addressed, 0 open; Git-free reviewed hashes recorded in `task-1-fix-round-1-review-package.md`).
- Task 1: complete (Git prohibited; independent spec/quality review plus scoped re-review clean; typecheck PASS, 16/16 focused tests PASS, build PASS).
- Task 1: minor (deferred): `deepMerge` retains and later freezes caller-owned override arrays; final review must decide whether cloning is required.
- Task 1: minor (deferred): contradictory `--headed --headless` currently resolves to headed; Task 17 explicitly owns rejection and must remove this behavior.
- Task 2: review found 3 Critical and 4 Important issues; fix round 1/5 in progress with original implementer.
- Task 2: fix round 1/5 (5 addressed, 2 open — omitted required-work counters can still fail open; fingerprint input non-mutation test missing; Git-free hashes in `task-2-fix-round-1-review-package.md`).
- Task 2: fix round 2/5 in progress with original implementer.
- Task 2: fix round 2/5 (2 addressed, 0 open; Git-free hashes in `task-2-fix-round-2-review-package.md`).
- Task 2: complete (Git prohibited; independent review plus two scoped fix re-reviews clean; typecheck PASS, 62/62 focused tests PASS, build PASS).
- Task 3: in progress (mandatory URL/Link SSOT checkpoint after review).
- Task 3: review found 1 Critical and 5 Important issues; mandatory SSOT checkpoint not yet passed; fix round 1/5 in progress.
- Task 3: Ruling: do not add URL normalization/admission logic to `CrawlQueue`; canonical owners issue a typed admitted URL, while the queue validates queue-local facts (depth), clones/freezes candidates, and rejects structurally invalid runtime input — this preserves SSOT while closing aliasing — if wrong, queue boundary typing/runtime checks would need redesign.
- Task 3: fix round 1/5 (5 addressed, 1 open — admission can mint a normalized brand from arbitrary `URL`; hashes in `task-3-fix-round-1-review-package.md`).
- Task 3: fix round 2/5 in progress.
- Task 3: fix round 2/5 (1 addressed, 0 open; hashes in `task-3-fix-round-2-review-package.md`).
- Task 3: complete (Git prohibited; focused tests 24/24 PASS, typecheck PASS, build PASS).
- Task 3 mandatory checkpoint: PASS — URL canonicalization, URL admission, Link extraction, queue authority, and canonical LinkEvidence reuse readiness each have one owner; fresh source scan found exactly one production `a[href]` extraction.
- Task 4: in progress.
- Task 4: review found 2 Important issues; fix round 1/5 in progress.
- Task 4: minor (deferred): add direct cases for malformed percent encoding, encoded backslash, and double-encoded traversal during final fixture-security triage.
- Task 4: minor (deferred): keep an upgrade client open through `close()` as an explicit cleanup regression if the chosen upgrade handling permits a persistent upgraded socket.
- Task 4: fix round 1/5 (2 addressed, 0 open; hashes in `task-4-fix-round-1-review-package.md`).
- Task 4: complete (Git prohibited; fixture integration 9/9 PASS, typecheck PASS, build PASS; independent review and scoped re-review clean).
- Task 5: in progress (mandatory network authority/mutation-prevention checkpoint after review).
- Task 5: independent review found 2 Critical, 6 Important, and 2 Minor issues; mandatory checkpoint currently FAILS on native browser-security preservation, transactional guard installation, invariant truthfulness, and redaction breadth; fix round 1/5 in progress.
- Task 5 Critical: approved requests are reissued through `APIRequestContext` via `route.fetch()`/`route.fulfill()`, which can strengthen credentials, lose request-specific security headers, auto-follow direct-subresource redirects, and replace native browser CORS/CSP/referrer semantics.
- Task 5 Critical: main-frame redirect-inspection delivery errors are outside the invariant-failure handler, so DNS/timeout/body/fulfill failures can leave `invariantViolations = 0`.
- Task 5 Important: WebSocket `close()` uncertainty is not represented truthfully even though refusing `connectToServer()` keeps the network boundary fail-closed.
- Task 5 Important: guard installation is not transactional; an HTTP-route installation failure can leave a partially configured context without invalidation/invariant evidence.
- Task 5 Important: successful `route.fetch()` responses are not disposed and can accumulate response bodies for the context lifetime.
- Task 5 Important: the caller-owned mutable `allowedOrigins` set is retained, allowing authority to be widened after installation.
- Task 5 Important: redaction misses API-key-like names including `Ocp-Apim-Subscription-Key`, `X-Auth-Key`, and `X-API-Secret`.
- Task 5 Important: risky-path coverage is incomplete, including native HEAD/credential behavior, multi-hop redirects, navigation/frame distinctions, delivery failures, and repeat/partial installation.
- Task 5 minor (deferred): redirect classification should use actual redirect status codes rather than every 300-399 response with `Location`.
- Task 5 minor (deferred): add null-prototype and `__proto__`/`constructor` header-map redaction tests during final security triage.
- Task 5 Ruling: an allowed ordinary/subresource request must remain a native browser request; the adapter may use a routing primitive such as `route.fallback()`/`route.continue()` only after an integration test proves redirect follow-ups are still guarded. Any main-frame redirect-inspection exception must preserve request credentials/headers and browser security semantics, dispose temporary responses, and record every delivery uncertainty — if no sound Playwright path exists, fail closed with an explicit invariant rather than silently weakening the browser boundary.
- Task 5 Ruling: snapshot `allowedOrigins` at installation and make installation fail-closed/transactional; if rollback cannot be proven, invalidate/close the partially configured context and ledger the installation invariant — if wrong, the Task 6 context-factory ownership boundary would need redesign.
- Task 5 Ruling: WebSocket delivery prevention is proved by never calling `connectToServer()`; ledger the policy block independently from best-effort page-side closure, and record a detectable closure failure as a separate invariant — this avoids treating close-callback observability as network authority.
- Task 5 Ruling: fix-round coverage must include server-counter proof for GET/HEAD and credentials omission, direct external navigation, a multi-hop external redirect, nested-frame distinction, route delivery/abort failures, and repeat/partial installation. Popup/download capability containment belongs to Task 11; large/streaming response coverage is required in Task 5 only if the corrected adapter still buffers via `route.fetch()`.
- Task 5 Characterization: real Chromium proved both `route.fallback()` and main-frame `route.fetch({ maxRedirects: 0 })` + `route.fulfill()` bypass context-route interception on redirected follow-ups; the latter reached an external fixture through an internal middle hop. Those delivery models are rejected for navigation authority.
- Task 5 Ruling: use request-stage Chromium CDP `Fetch` interception for Document redirect hops while retaining the BrowserContext guard for initial requests/non-read methods. The CDP path is accepted only because a real-browser characterization observed primary -> internal middle -> external, kept the external counter at zero, preserved native external subresources and `credentials: 'omit'`, and allowed a nested external frame. Unsupported setup, detach, continuation, or blocking uncertainty must invalidate/close the context and ledger an invariant — if wrong, passive navigation must be marked implementation-blocked because Playwright Route alone cannot meet the binding external-redirect rule.
- Task 5 Characterization: page-event CDP setup is not guaranteed to finish before an immediate `newPage(); goto(...)`; awaiting setup inside an already-paused Playwright route enables CDP too late for that redirect chain and allowed external delivery. Timing-based implicit readiness is rejected.
- Task 5 Ruling: add an explicit per-page passive-guard readiness API. Every production page-creation/navigation owner must await readiness before the first network navigation; Task 6's guarded browser lifecycle will own that call. A navigation attempted before readiness must be rejected fail-closed and recorded as an invariant, never delayed and then silently allowed — if wrong, browser-level Chromium auto-attach would be required instead.
- Task 5 fix round 1/5 implementation verified: the adapter now exports `awaitPassiveRequestGuardReady(page)`; native browser delivery is retained with `route.fallback()`; request-stage Chromium CDP guards every Document redirect hop; immediate pre-readiness navigation invalidates the context before fixture delivery; focused Task 5 verification is 74/74 PASS, typecheck/build PASS, and repository regression is 176/176 PASS. Independent re-review remains pending.
- Task 5 production contract/concern: after guard installation, every page owner must execute `const page = await context.newPage(); await awaitPassiveRequestGuardReady(page);` before the first navigation. Task 6 must make that sequence the only guarded lifecycle; bypass attempts are deliberately fatal to the context and ledger `PASSIVE_GUARD_PAGE_NOT_READY`.
- Task 5 production contract/concern: redirect-chain authority currently depends on Chromium CDP `Fetch` request-stage Document interception. CDP setup, detach, continue, or fail uncertainty invalidates the context and records an invariant; a non-Chromium or non-attached runtime must not degrade to Playwright routing alone.
- Task 5 fix round 1/5 re-review: 7 original findings addressed, 1 original Important coverage finding remains open, and 1 new Important ledger-truthfulness defect was reproduced; mandatory checkpoint remains FAIL.
- Task 5 Important: owner-initiated `page.close()` while an allowed main-frame request is pending emits `requestfailed` before the current expected-close marker is visible, falsely records `HTTP_MAIN_FRAME_DELIVERY_FAILED: net::ERR_ABORTED`, and can prohibit `COMPLETE` during normal cleanup.
- Task 5 Important: focused coverage is still missing for CDP setup failure, unexpected CDP detach, both CDP page-lookup failure branches, and expected page/context closure during a pending allowed navigation.
- Task 5 fix round 2/5 in progress with the original implementer. The fix must distinguish a genuinely failed allowed delivery from owner-initiated page/context teardown without globally ignoring `net::ERR_ABORTED`, and must close the enumerated CDP lifecycle coverage gaps.
- Task 5 fix round 2/5 implementation verified: pending owner `page.close()` and `context.close()` no longer create false delivery invariants; an active-page `net::ERR_ABORTED` still records `HTTP_MAIN_FRAME_DELIVERY_FAILED` and invalidates after a bounded 100 ms close-signal classification window, while connection refusal remains immediate. CDP setup failure at all three stages, unexpected detach, both page-lookup branches, pending page/context close, and genuine abort now have focused coverage. Task 5 tests 84/84 PASS, typecheck/build PASS, repository regression 186/186 PASS; independent re-review remains pending.
- Task 5 lifecycle ruling: Playwright emits `requestfailed(net::ERR_ABORTED)` before its owner-close event, and real Chromium showed that a single next-event-loop turn is insufficient for `page.close()`. Classification therefore races the actual page close signal against a fixed 100 ms bound; closure inside the bound is cleanup, while an active page at expiry is a delivery invariant and invalidates the context. This is not a global `ERR_ABORTED` exemption.
- Task 5 fix round 2/5 re-review: both entering findings addressed, but 2 new Important ledger-truthfulness issues found; mandatory checkpoint remains FAIL.
- Task 5 Important: the 100 ms classifier and `expectedPageClosures` currently treat any page close as owner cleanup, so an unexpected renderer/target/page-side loss near `ERR_ABORTED` can suppress both the true delivery invariant and unexpected CDP detach.
- Task 5 Important: `expectedCdpFailures` is a Page-level count rather than a request-correlated record; the next unrelated main-frame `requestfailed` can consume it without method, URL, or failure-reason agreement and hide a genuine allowed-request failure.
- Task 5 fix round 3/5 in progress with the original implementer. Owner teardown must be explicitly marked/wrapped before close and Task 6 must own those lifecycle APIs; unexpected close remains an invariant. Remove CDP failure suppression if policy classification already identifies the blocked request, otherwise correlate it to method, URL, and expected failure reason with concurrent-request tests.
- Task 5 fix round 3/5 implementation verified: `closePassiveGuardedPage()` and `closePassiveGuardedContext()` now pre-mark owner teardown; only those wrappers suppress their expected pending-navigation abort/CDP detach, while unmarked idle or pending close records invariants and invalidates. Close rejection records a dedicated invariant, clears intent, and leaves the guard invalidated/fail-closed. Focused lifecycle/correlation verification is 13/13 PASS, Task 5 is 92/92 PASS, typecheck/build PASS, and repository regression is 194/194 PASS; independent re-review remains pending.
- Task 5 redirect-failure characterization: Chromium CDP blocks the external redirect target before Playwright creates its Request, so Playwright reports `net::ERR_BLOCKED_BY_CLIENT` against the preceding allowed redirect Request. The former Page-wide count is replaced by a one-shot bounded record keyed to the CDP `redirectedRequestId` predecessor's normalized method, exact URL, and exact expected failure reason. A mismatched concurrent allowed failure remains an invariant and invalidates.
- Task 5 forward lifecycle contract: Task 6 must centralize guard installation, page creation, `awaitPassiveRequestGuardReady(page)`, `closePassiveGuardedPage(page)`, and `closePassiveGuardedContext(context)`. Direct Playwright page/context close is intentionally treated as unexpected and fail-closed.
- Task 5 fix round 3/5 re-review: both entering findings addressed, but 1 new Important fail-closed lifecycle gap was reproduced; mandatory checkpoint remains FAIL.
- Task 5 Important: the CDP `Fetch.requestPaused` handler does not check invalidated/owner-closing state. After `closePassiveGuardedContext()` rejects and leaves the guard invalidated, a later allowed Document pause still executes `Fetch.continueRequest`, contradicting the fail-closed lifecycle contract.
- Task 5 fix round 4/5 in progress with the original implementer. Any CDP pause observed after guard invalidation, safety invalidation, guarded Context close start, or guarded Page close start must never continue; it must be failed/left fail-closed with truthful invariant handling and focused race/rejected-close coverage.
- Task 5 fix round 4/5 implementation verified: every CDP Document pause now checks invalidated/owner-closing/safety-invalidating state before classification and again immediately before native continuation. Lifecycle pauses use `Fetch.failRequest(BlockedByClient)` without claiming a policy block; failRequest uncertainty records `CDP_LIFECYCLE_FAIL_REQUEST_FAILED` and does not retry an already-invalidated Context close. Pending/rejected Page and Context close plus in-progress/complete safety invalidation are covered. Focused lifecycle races 7/7 PASS, Task 5 99/99 PASS, typecheck/build PASS, and repository regression 201/201 PASS; independent re-review remains pending.
- Task 5 fix round 4/5 re-review: entering finding addressed, but 1 new Important lifecycle-correlation defect reproduced; mandatory checkpoint remains FAIL.
- Task 5 Important: a successful lifecycle `Fetch.failRequest(BlockedByClient)` is not correlated with its later Playwright `requestfailed`. After the owner Context close marker clears, `net::ERR_BLOCKED_BY_CLIENT` falls through as `HTTP_MAIN_FRAME_DELIVERY_FAILED` and can invoke `context.close()` a second time; the current tests stop after the CDP command and do not feed the resulting failure event back to the handler.
- Task 5 fix round 5/5 in progress with the original implementer. Lifecycle failRequest must register a bounded one-shot exact request correlation before sending, remove it if the CDP fail command fails, and consume only its matching Playwright failure without policy-block claims or recursive close. Tests must drive the full paused -> failRequest -> requestfailed sequence for owner Context/Page close and safety invalidation plus mismatches.
- Task 5 fix round 5/5 implementation verified: lifecycle failRequest now registers a bounded one-shot exact Playwright-visible failure record before sending. Direct pauses use normalized current method/exact URL; redirect pauses use the `redirectedRequestId` predecessor; both require exact `net::ERR_BLOCKED_BY_CLIENT`. Exact match consumes once, mismatch/expiry do not suppress, and failRequest rejection removes only its record before ledgering `CDP_LIFECYCLE_FAIL_REQUEST_FAILED`. Full-sequence tests prove owner Context close count remains one, guarded Page close keeps Context reuse, safety invalidation gains no false invariant, and neither correlation path claims a policy block. Focused sequences 10/10 PASS, Task 5 102/102 PASS, typecheck/build PASS, repository regression 204/204 PASS; final independent re-review remains pending.
- Task 5 fix round 5/5 final independent re-review: PASS — manifest 12/12 matched, entering lifecycle-correlation finding addressed, no new Critical/Important findings; scoped real-Chromium verification 10/10 PASS.
- Task 5: complete (Git prohibited; independent review plus five bounded fix/re-review rounds complete; focused Task 5 102/102 PASS, typecheck PASS, build PASS, repository regression 204/204 PASS).
- Task 5 mandatory checkpoint: PASS — non-read HTTP and passive WebSocket delivery are blocked at the fixture server boundary; ordinary/subresource/nested-frame reads retain native browser semantics; direct and multi-hop external main-frame navigation is blocked before external delivery; installation/readiness/close/CDP lifecycle uncertainty is fail-closed and truthfully ledgered; required sensitive headers are redacted.
- Task 6: in progress. Browser lifecycle must consume Task 5's full guarded contract: `serviceWorkers: 'block'`, install before page creation, await page readiness before navigation, and use guarded Page/Context close wrappers for owner teardown.
- Task 6 Ruling: preserve the planned `createPassiveContext(viewport): Promise<BrowserContext>` interface and add factory-owned `createPassivePage(context)`, guarded Page/Context close delegation, and Context-to-SafetyLedger lookup. All later production page creation/teardown must use these factory methods; direct `newPage()`/`page.close()`/`context.close()` remains confined to the factory/Task 5 adapter and test characterization — if wrong, Task 14/15 lifecycle APIs would need migration to a session facade.
- Task 6 Ruling: `waitForPageSettled()` owns DOM-ready plus bounded height-stability observation, while `controlledScroll()` owns progressive human-scale movement, lazy-height growth tracking, bottom-plus-stable-window completion, and explicit `PARTIAL` deadline results. Neither function may use `networkidle` as its sole completion condition — if wrong, Task 14 ordering would need redesign.
- Task 6 implementation verified pending independent review: factory owns guarded Context/Page/readiness/close/ledger lifecycle; settling and controlled scroll use a shared absolute-deadline contract and immutable COMPLETE/PARTIAL evidence. Focused 10/10 PASS, request-policy regression 19/19 PASS, typecheck/build PASS, repository regression 214/214 PASS.
- Task 6 independent review: NEEDS FIXES — 1 Critical, 4 Important, and 2 Minor findings; fix round 1/5 in progress.
- Task 6 Critical: settling/scrolling can return SETTLED/COMPLETE with a final observation after the absolute deadline because successful operations are not post-checked; mutating `page.evaluate()` can also execute after a deadline PARTIAL was already returned.
- Task 6 Important: factory raw-closes Context after Task 5 installation/readiness failures even though Task 5 already invalidates/closes, causing double close and bypassing guarded lifecycle ownership.
- Task 6 Important: Task 5 Context invalidation is not synchronized with factory active ownership; guarded Page-close failure or asynchronous safety invalidation can leave the factory willing to create another Page before readiness rejects.
- Task 6 Important: controlled scroll resets bottom stability only on height growth; a height shrink can be misclassified as a stable bottom and return false COMPLETE.
- Task 6 Important: the factory accepts a ledger dependency that returns the same mutable SafetyLedger for multiple Contexts, merging safety accounting instead of enforcing isolation.
- Task 6 minor (deferred): add direct risk-path coverage for disappearing documents and malformed/NaN/negative browser geometry during final browser-lifecycle triage.
- Task 6 minor (deferred): validate page-derived numeric geometry as finite/nonnegative before using it in settling/scroll completion calculations.
- Task 6 Ruling: factory active ownership must consult Task 5's guard-state authority before raw `newPage()`; add a narrow read-only Task 5 assertion/query rather than duplicating installation-state semantics in the factory. Factory failure cleanup must delegate to Task 5 when the guard exists and must not issue a second raw close after Task 5 installation failure — if wrong, Task 5/6 ownership would need a combined session object.
- Task 6 fix round 1/5 re-review: 4 Important findings addressed; the Critical deadline finding remains partially open; no separate new Critical/Important findings.
- Task 6 Critical (remaining): an operation that rejects after the absolute deadline can bypass the fulfilled-result clock check and be mislabeled `DOM_READINESS_FAILED`/`EVALUATION_FAILED` instead of authoritative `DEADLINE_EXCEEDED`; terminal SETTLED/COMPLETE construction also needs a final deadline check after observation processing.
- Task 6 fix round 2/5 in progress with the original implementer. Deadline racers must normalize fulfillment/rejection into an outcome, adjudicate the clock before rethrowing an error, and recheck immediately before and after terminal immutable result construction so no successful terminal result crosses the authority boundary.
- Task 6 fix round 2/5 implementation verified: fulfillment/rejection is normalized before deadline adjudication; late rejection now reports authoritative `DEADLINE_EXCEEDED`, strictly pre-deadline rejection retains its genuine failure reason, and terminal SETTLED/COMPLETE is clock-checked both before construction and after freezing. Source-targeted 6/6 PASS, Task 5+6 regression 115/115 PASS, typecheck/build PASS, repository regression 228/228 PASS; independent scoped re-review remains pending.
- Task 6 fix round 2/5 independent re-review: PASS — manifest 9/9 matched, entering Critical deadline remainder addressed, no new Critical/Important findings.
- Task 6: complete (Git prohibited; independent review plus two scoped fix/re-review rounds complete; focused Task 5+6 regression 115/115 PASS, typecheck PASS, build PASS, repository regression 228/228 PASS).
- Task 7: in progress. Collectors must attach before navigation, own/detach only their listeners, return immutable snapshots, preserve request/response/failure/redirect/resource/timing/size and console warn/error/pageerror separately, redact selected headers through the existing redaction SSOT, and never create Findings.
- Task 7 implementation verified pending independent review: collector-local passive listeners normalize request/response/failure/redirect/resource/final Request timing and console warning/error/pageerror facts; snapshots are repeatable and deeply immutable; detach is idempotent and state-isolated; selected headers delegate to `redactHeaders()` and no response body or Finding is created. Focused Task 7 4/4 PASS, Task 5-7 adjacent regression 115/115 PASS, typecheck/build PASS, repository regression 232/232 PASS.
- Task 7 API ruling: browser network timing uses only public `Request.timing()`, refreshed on public `requestfinished`; browser `Response.timing()` does not exist and no cast/internal API is permitted. Task 14 must assemble these raw normalized observations into canonical Evidence records and IDs rather than adding a collector-side parallel `EvidenceRecord` path.
- Task 7 independent review: NEEDS FIXES — 0 Critical, 2 Important, 2 Minor; fix round 1/5 in progress.
- Task 7 Important: synchronous browser `Request.headers()` / `Response.headers()` omit security/cookie headers, so the allowlist and mocked redaction tests claim facts the real API cannot supply; real-browser omission was incorrectly accepted as successful redaction.
- Task 7 Important: selected headers omit `traceparent`, `tracestate`, and request/correlation IDs required as browser-visible Network Evidence for Task 10, risking an SSOT-breaking second collection path.
- Task 7 minor (deferred): add response-first and failure-first component ordering cases around `ensureRequest()` during final collector triage.
- Task 7 minor (deferred): add console-specific double-detach, multi-handle isolation, late-pageerror, and exact-listener coverage during final collector triage.
- Task 7 Ruling: use public async `Request.allHeaders()` / `Response.allHeaders()` with an explicit async snapshot/quiescence contract; event correlation/order remains synchronous, pending header reads are awaited by snapshot, async failure is represented truthfully rather than silently omitted, and detach prevents later events while allowing already-observed work to settle — if wrong, Task 14 collector finalization must introduce a separate bounded drain protocol.
- Task 7 fix round 1/5 must prove real-browser Authorization/Cookie/Set-Cookie-style values are actually observed then redacted (not merely absent), unselected values remain absent, trace/correlation headers survive selection, async completion cannot reorder/cross-contaminate records, detach handles in-flight observations consistently, and header-read rejection is explicit.
- Task 7 fix round 1/5 independent re-review: PASS — manifest 10/10 matched, both entering Important findings addressed, no new Critical/Important findings.
- Task 7: complete (Git prohibited; independent review plus one scoped fix/re-review round complete; focused 6/6 PASS, Task 5-7 adjacent 117/117 PASS, typecheck/build PASS, repository regression 234/234 PASS).
- Task 8: in progress. DOM collection must reuse canonical `LinkEvidence[]` from Task 3 and must not evaluate `a[href]`; all non-link DOM facts should be captured in one browser evaluation, and screenshots must write only the requested artifact paths without baseline comparison.
- Task 7 fix round 1/5 implementation verified pending independent re-review: collector handles now expose async snapshots; request/response event identity and order are fixed synchronously, invocation-boundary snapshots await already-observed public `allHeaders()` reads, detach excludes later events while draining owned in-flight reads, and header failure is explicit rather than an empty success. Real Chromium plus server observations prove Authorization/Cookie/Set-Cookie/X-Api-Key were actually sent/received then stored as `[REDACTED]`; traceparent/tracestate/request-id/correlation-id styles remain visible and unselected headers remain absent. Focused 6/6 PASS, Task 5-7 adjacent regression 117/117 PASS, typecheck/build PASS, and fresh repository rerun 234/234 PASS; independent re-review remains pending.
- Task 7 fix round 1/5 verification note: the first full-suite run was 233/234 because the existing Task 6 40 ms deadline test expired before its first geometry observation and asserted a non-undefined `finalSnapshot`; the exact test passed alone and the unchanged fresh full-suite rerun passed 234/234. No Task 6 file was changed.
- Task 8 implementation verified pending independent review: `collectDomEvidence(page, pageId, links)` reuses an immutable copy of Task 3 canonical Link evidence and collects every non-link DOM fact in one read-only browser evaluation; `captureScreenshots(page, paths)` validates relative artifact metadata before either write, writes exactly the requested viewport/full-page PNG captures, and returns raw metadata only after both succeed. Focused 5/5 PASS, Task 3/5/6/7/8 adjacent regression 123/123 PASS, typecheck/build PASS, and repository regression 239/239 PASS.
- Task 8 boundary note: collectors create neither Findings nor canonical Evidence/Screenshot IDs; Task 14 retains record assembly and ID authority. If the second screenshot write fails after the first succeeds, the function rejects without returning evidence and leaves partial-artifact cleanup to the later artifact writer/coordinator rather than silently deleting or claiming success.
- Task 8 independent review: NEEDS FIXES — 0 Critical, 4 Important, 1 Minor; fix round 1/5 in progress.
- Task 8 Important: relative screenshot metadata accepts traversal, dot, and Windows drive-relative forms, while viewport/full-page output and metadata targets may alias; the second capture can overwrite the first while two success records are returned.
- Task 8 Important: DOM normalization collapses present-empty and missing title/meta/canonical/lang plus missing versus explicit-empty image alt, preventing later rules such as `MISSING_TITLE` and `EMPTY_TITLE` from distinguishing facts.
- Task 8 Important: submit controls are selected by DOM descendants rather than HTML form ownership, missing external `form=id` controls and misattributing descendants owned by another form; raw invalid method is reported instead of browser effective `get`.
- Task 8 Important: concatenating every nested semantic landmark's `innerText` duplicates visible text, e.g. a form nested in main.
- Task 8 minor (deferred): broaden direct proof of every frozen DOM layer/read-only mutation resistance and second-write screenshot failure/exact output count during final DOM/screenshot triage.
- Task 8 Ruling: artifact metadata is canonical portable POSIX-relative syntax with no empty/dot/dot-dot segments, backslashes, NUL, URI/drive prefixes, or normalized alias; viewport/full-page metadata and resolved output paths must be distinct before the first write — if wrong, artifact writer path authority must be pulled forward and Task 8's public path contract redesigned.
- Task 8 Ruling: preserve missing as `null` and present-empty as `''` for title/meta/canonical/lang and image src/alt; use browser-effective `form.method` and `form.elements` ownership for controls; keep every semantic region separately but build combined semantic text only from outermost observed landmarks so nested text occurs once.
- Task 8 fix round 1/5 re-review: path aliasing, missing-vs-empty, and nested landmark findings addressed; form ownership partially addressed; 1 new Important remains, so fix round 2/5 is in progress.
- Task 8 Important (remaining): Chromium excludes `input[type=image]` from `HTMLFormElement.elements`, making the public image-submit evidence branch unreachable for both internal and external form-associated image controls.
- Task 8 Ruling: submit-control ownership must use the browser's `control.form === form` association over document-order button/input candidates, rather than assuming `form.elements` is exhaustive; this must include internal/external image submitters and exclude controls associated to another form while retaining a single browser evaluation.
- Task 8 fix round 1/5 implementation verified pending independent re-review: portable artifact metadata now rejects empty/dot/dot-dot/traversal/empty-segment/backslash/NUL/URI/drive forms, and metadata plus resolved output identities must be distinct before either screenshot write. DOM evidence preserves missing `null` versus present-empty `''`, uses browser form ownership/effective method for submitters, and combines only outermost landmark text while retaining every region record. Focused 10/10 PASS, Task 3/5/6/7/8 adjacent regression 128/128 PASS, typecheck/build PASS, and repository regression 244/244 PASS.
- Task 8 fix round 1/5 scope note: Task 3 remains the sole `a[href]` owner and its hash is unchanged. The independent-review Minor coverage finding remains deferred; no dependency or Git operation was used.
- Task 8 fix round 2/5 implementation verified pending independent re-review: the sole DOM evaluation now enumerates document-order `button,input` submitter candidates and uses browser `control.form === form` ownership, including internal/external `input[type=image]`, excluding controls associated to another form, and retaining deterministic order. Targeted real-Chromium 1/1 PASS, Task 8 focused 11/11 PASS, fresh Task 3/5/6/7/8 adjacent regression 129/129 PASS, typecheck/build PASS, and repository regression 245/245 PASS.
- Task 8 fix round 2/5 verification note: the first adjacent run was 128/129 on the unchanged known Task 6 40 ms deadline assertion after correct `PARTIAL / DEADLINE_EXCEEDED` returned before an initial geometry snapshot. The exact test passed alone and the unchanged fresh adjacent rerun passed 129/129; no Task 6 file was modified. Task 3 Link SSOT and the deferred Task 8 Minor remain unchanged.
- Task 8 fix round 2/5 independent re-review: PASS — manifest 7/7 matched, image-submitter ownership finding addressed, no new Critical/Important findings.
- Task 8: complete (Git prohibited; independent review plus two scoped fix/re-review rounds complete; focused 11/11 PASS, adjacent 129/129 PASS, typecheck/build PASS, repository regression 245/245 PASS).
- Task 9: in progress. Layout, responsive-stress, accessibility, and contrast collectors must return normalized immutable evidence only; they must not create Findings or perform baseline comparisons, and browser manipulation is limited to explicit caller-requested viewport sampling.
- Task 9 implementation verified pending independent review: focused 13/13 PASS, Task 5-9 adjacent 107/107 PASS, typecheck/build PASS, and single-worker repository 258/258 PASS. Standard parallel repository runs were 257/258 only on the unchanged known Task 6 40 ms assertion; Task 9 tests had no failures.
- Task 9 independent review: NEEDS FIXES — 0 Critical, 7 Important, 2 Minor; fix round 1/5 in progress.
- Task 9 Important: layout visibility is not ancestor-aware and incorrectly treats `aria-hidden` as visual hiding, corrupting geometry candidate membership.
- Task 9 Important: caller-supplied viewport dimensions are recorded/used as observed facts without validating actual `window.innerWidth/innerHeight`.
- Task 9 Important: ordinary vertical-flow elements can fill the bounded outside-box list before later horizontal/positioned candidates.
- Task 9 Important: fixed/sticky overlap Cartesian products admit self/ancestor containment and pairs wholly outside the viewport.
- Task 9 Important: contrast ratios ignore element/ancestor partial opacity and can claim unsupported rendered colors.
- Task 9 Important: color distribution uses full bounding rectangles instead of viewport/overflow-ancestor-clipped visible area and can retain fully clipped descendants.
- Task 9 Important: unsupported modern computed foreground colors abort the entire collector instead of producing explicit unavailable evidence.
- Task 9 minor (deferred): use explicit presence flags so `Promise.reject(undefined)` work/close failures remain distinguishable and aggregatable during final responsive-lifecycle triage.
- Task 9 minor (deferred): add one real Task 5/6-to-stress lifecycle binding test plus direct malformed browser geometry and nested axe target coverage during final evidence-lifecycle triage.
- Task 9 Ruling: collect actual browser viewport dimensions inside the sole layout evaluation, use those dimensions for all geometry, and reject a caller/actual mismatch before returning evidence. Layout visual visibility must walk ancestors for hidden/display/visibility/opacity while recording but not treating ARIA-hidden as visual suppression.
- Task 9 Ruling: retain bounded vertical outside facts only after priority horizontal or fixed/sticky offscreen candidates, so ordinary flow cannot starve higher-risk facts; fixed-heading overlap must exclude identical/containment pairs and require both rectangles to intersect the actual viewport.
- Task 9 Ruling: color samples must compute viewport- and overflow-ancestor-clipped visible area for distribution; any positive-but-partial element/ancestor opacity makes contrast explicitly unavailable rather than falsely exact. Unsupported foreground serialization becomes bounded explicit `INVALID_COLOR` evidence while other samples continue; no internal browser API or DOM mutation is permitted.
- Task 9 fix round 1/5 implementation verified pending independent re-review: all seven Important findings have focused real-Chromium RED/GREEN coverage; Task 9 focused 20/20 PASS, Task 5-9 adjacent 114/114 PASS, typecheck/build PASS, and both single-worker and standard repository runs 265/265 PASS.
- Task 9 fix round 1/5 independent re-review: PASS — manifest 12/12 matched, all seven Important findings addressed, no new Critical/Important findings; focused reviewer rerun 20/20 PASS.
- Task 9: complete (Git prohibited; independent review plus one scoped fix/re-review round complete; focused 20/20 PASS, adjacent 114/114 PASS, typecheck/build PASS, repository regression 265/265 PASS).
- Cross-task verification stability: in progress. The unchanged Task 6 40 ms PARTIAL-metadata test repeatedly failed only under parallel full-suite load because its deadline could expire before the first geometry observation; production correctly returned `PARTIAL / DEADLINE_EXCEEDED`. Stabilize the test deterministically without weakening the production deadline contract.
- Cross-task verification stability: complete — only the Task 6 assertion changed; no-observation expiry requires empty observations and `finalSnapshot: null`, while any snapshot must be strictly pre-deadline and non-bottom. Independent review PASS; Task 6 focused 24/24 and standard repository 265/265 PASS; production hash unchanged.
- Task 9 implementation verified pending independent review: layout/accessibility/color collectors retain bounded deeply immutable evidence only; responsive stress validates all widths up front and uses a fresh injected guarded-ready owner session with exactly-once owner close per width; axe runs unfiltered through the locked dependency and retains color contrast; ambiguous CSS backgrounds remain explicit. Focused 13/13 PASS, Task 5–9 adjacent regression 107/107 PASS, typecheck/build PASS, and repository regression 258/258 PASS with one worker. The standard parallel full-suite command twice reached 257/258 only because the unchanged known Task 6 40 ms assertion required a first geometry snapshot; that exact test passed alone, and no Task 6 file changed. Independent review remains pending.
- Task 9 fix round 1/5 implementation verified pending independent re-review: all 7 Important findings have focused real-Chromium RED/GREEN proof. Layout now uses ancestor-aware visual visibility without ARIA suppression, actual browser viewport facts with mismatch rejection, priority retention for horizontal/fixed offscreen candidates, and identity/containment/viewport gates for fixed-heading pairs. Color now makes partial opacity contrast unavailable, weights only viewport/overflow-clipped visible area, excludes fully clipped samples, and retains bounded explicit INVALID_COLOR foreground evidence without aborting other samples. Focused 20/20 PASS, Task 5–9 adjacent 114/114 PASS, typecheck/build PASS, single-worker repository 265/265 PASS, and standard repository 265/265 PASS. Both review Minors remain deferred; no dependency or Git operation was used; independent re-review remains pending.
- Cross-task verification stability maintenance verified: Task 6's 40 ms deadline assertion now accepts the truthful no-observation `PARTIAL / DEADLINE_EXCEEDED` shape while requiring any present final snapshot to be strictly pre-deadline and non-bottom. Production Task 6 hashes are unchanged. Exact test passed 4/4 concurrent runs before and after the assertion edit, Task 6 focused 24/24 PASS, typecheck PASS, and a fresh standard parallel repository run passed 265/265. No Git/dependency operation was used; this does not change task completion status.
- Task 10 implementation verified pending independent review: the collector installs the existing local `web-vitals` 6.1.0 attribution IIFE idempotently before navigation, consumes canonical Task 7 `NetworkEvidence` without a second observer/header/redaction path, and returns bounded deeply immutable Web Vital/timing/Server-Timing/resource-summary/telemetry-candidate evidence with honest unsupported/not-observed/partial deadline states. Focused 12/12 PASS, Task 5–10 adjacent 164/164 PASS, typecheck/build PASS, and standard repository 277/277 PASS. No dependency download, package drift, target access, or Git operation occurred.
- Task 10 independent review: NEEDS FIXES — 0 Critical, 8 Important, 0 Minor; manifest 10/10 matched and focused component 11/11 PASS. Fix round 1/5 is in progress.
- Task 10 Important: INP/TTFB support predicates diverge from the installed library; unavailable/invalid Vital collection is falsely relabeled `NOT_OBSERVED`; NetworkEvidence is traversed before deadline and reread after await; malformed timing containers can return COMPLETE; duplicate URLs can bind Resource Timing to a document/incompatible request; `css` initiator is mislabeled stylesheet; and finite resource sizes can overflow summaries to Infinity.
- Task 10 Ruling: partial unavailable/invalid Vital collection uses nullable `webVitals`, never speculative metric states. Check deadline before input traversal; create one bounded frozen NetworkEvidence projection before await and use it exclusively. Malformed timing containers are invalid, Resource Timing excludes document/incompatible ambiguous correlation, CSS initiator alone remains unknown, and overflow makes summaries unavailable with `PARTIAL / INVALID_BROWSER_DATA` rather than clamped/fabricated totals.
- Task 10 fix round 1/5 implementation verified pending independent re-review: all eight entering Important findings have RED/GREEN coverage. A root self-review additionally reproduced and fixed heterogeneous known/unknown duplicate-URL ambiguity. Task 10 component 23/23, guarded/capability Chromium 3/3, Task 5–10 adjacent 178/178, typecheck/build, and standard repository 291/291 PASS. Package/lock remain unchanged; no Git/download/live-target operation occurred.
- Cross-task Task 6 stability maintenance: fresh Task 10 adjacent verification consistently reproduced lazy scrolling completing with zero growth because Chromium accepted programmatic scroll before its first rendering opportunity without dispatching the fixture's scroll event. Deadline-raced first-frame readiness was added inside the existing reset evaluation; deadline is rechecked before mutation, so late callbacks remain non-mutating. Task 6 production changed, its test/fixture did not; focused 13/13 and adjacent/full regressions PASS. Independent review is pending with Task 10 re-review.
- Task 10 fix round 1/5 re-review: NEEDS FIXES — 0 Critical, 2 Important, 1 Minor; manifest 13/13 matched. Six entering findings are ADDRESSED and Task 6 first-frame maintenance PASS. Deadline-bounded projection and duplicate URL correlation remain PARTIAL.
- Task 10 Important (round 2): requests getter can reach the deadline before responses is read, yet responses is still accessed; projected scalar fields are not length-bounded. Unknown-initiator fetch/xhr duplicates share an aggregate category but do not identify one actual request, so request ID/type must remain null.
- Task 10 fix round 2/5 implementation verified pending independent re-review: top-level/scalar projection reads are deadline-checked; all retained scalars are bounded; overlong URLs are excluded from exact correlation without truncation alias; unknown-initiator duplicates require identical raw resource types. New RED/GREEN coverage brings component to 26/26; Task 10+6 browser focused 16/16, adjacent 181/181, typecheck/build, and full repository 294/294 PASS. The dead-code Minor was removed. No Git/dependency/live-target operation occurred.
- Task 10 fix round 2/5 re-review: NEEDS FIXES — 0 Critical, 2 Important, 0 Minor; manifest 13/13 matched. Six original findings and Task 6 maintenance remain PASS, but fine-grained projection deadline gates and raw-type truncation alias remain blocking.
- Task 10 Important (round 3): repeated array length/header container reads and missing post-index/status/own-property checks can access another caller field after an accessor reaches the deadline. Distinct overlong raw resource types can alias after the 512-character display truncation and falsely bind an unknown-initiator resource.
- Task 10 Ruling (round 3): cache each caller container/length once and deadline-check after every accessor boundary before another caller read. Keep display scalars separate from exact correlation discriminators; overlong raw resource types are correlation-ineligible rather than truncated into an identity.
- Task 10 fix round 3/5 implementation verified pending independent re-review: accessor-driven RED 6/6 became GREEN; containers/lengths are cached, every caller read boundary is deadline-gated, HeaderEvidence values is read once, and overlong raw resource types cannot become correlation identities. Component 32/32, Task 10+6 browser focused 16/16, adjacent 187/187, typecheck/build, and full repository 300/300 PASS. No Git/dependency/live-target operation occurred.
- Task 10 fix round 3/5 re-review: NEEDS FIXES — 0 Critical, 2 Important, 0 Minor; manifest 13/13 matched. Overlong raw-type identity and prior findings remain addressed, but `for...in` performs an ungated ownKeys-to-descriptor transition and known fetch initiator still accepts xhr through aggregate category compatibility.
- Task 10 Ruling (round 4): snapshot own keys as one caller boundary, deadline-check, then separately gate descriptor and selected-value reads. Exact request identity uses initiator-specific raw type compatibility; aggregate category remains summary fallback only and cannot justify a request ID/type.
- Task 10 fix round 4/5 implementation verified pending independent re-review: two focused RED failures became GREEN. Header projection gates `ownKeys`, descriptor, and selected-value boundaries separately without reading unselected values; known initiators correlate only to exact raw request types, so `fetch` cannot claim `xhr` identity. Component 34/34, Task 10+6 browser focused 16/16, adjacent 189/189, typecheck/build, and full repository 302/302 PASS. No Git/dependency/live-target operation occurred.
- Task 10 fix round 4/5 independent re-review: PASS — manifest 13/13 matched, both remaining Important findings addressed, no Critical/Important/Minor findings, prior findings and Task 6 first-frame maintenance remain PASS.
- Task 10: complete (Git prohibited; independent review plus four scoped fix/re-review rounds complete; component 34/34, browser focused 16/16, adjacent 189/189, typecheck/build PASS, repository regression 302/302 PASS).
- Task 11: in progress. Dynamic candidates and isolated interaction audit must be site-selector-free, mechanically reject unsafe admission before clicking, switch to a fail-closed all-new-activity freeze only after initial passive load, prove S03–S08 at fixture server boundaries, and destroy each isolated context.
- Task 11 architectural ruling: extend Task 5's existing guarded-context authority with a one-way interaction-freeze mode. Do not stack an unrelated route that would conflict with Task 5 expected-failure adjudication, and do not duplicate request-policy logic. The owner-managed disposable session must complete its passive initial load before freeze, then audit at most one rediscovered generic candidate and close exactly once.
- Task 11 status/result ruling: mechanical rejection precedes click; any recorded post-freeze activity yields `BLOCKED_BY_SAFETY`; only a bounded observable ARIA/visibility/state/layout change can yield `VERIFIED`; timeout/no proof is `NOT_VERIFIABLE`; genuine failure is `EXECUTION_FAILED`. Server-boundary counters, not merely browser events, prove S03–S08.
- Task 11 implementation verified pending independent reviews: implementer focused 40/40, Task 5/6/11 adjacent 151/151, full repository 338/338, typecheck/build PASS. Root fresh focused 40/40 plus typecheck/build PASS. Fixed 27-file specification-review manifest prepared; no Git/dependency/live-target operation occurred.
- Task 11 independent specification review: NEEDS FIXES — manifest 27/27 matched; 1 Critical, 2 Important, 1 Minor. Fix round 1/5 is in progress.
- Task 11 Critical: rediscovery/classification uses detached candidate facts, but click re-resolves the generic ordinal; DOM reorder can make it click an unclassified unsafe node. Bind fact collection, admission, click, and post-condition to one retained ElementHandle.
- Task 11 Important: target resolution can cross the absolute deadline before click without another gate; exact handle resolution and fact collection must be deadline-checked immediately before click dispatch.
- Task 11 Important: clone replacement with the same stable candidate ID can be treated as MATCHED/VERIFIED. Preserve exact node identity and report explicit REPLACED; add non-vacuous MISSING/AMBIGUOUS/REPLACED tests.
- Task 11 Minor (fix now): admitted data download never requests `/__download`, making that server-path assertion vacuous. Separate data-event cancellation proof from an admitted HTTP download zero-delivery proof.
- Task 11 fix round 1/5 implementation verified pending independent re-review: one retained ElementHandle now binds exact-node facts, admission, click, and post-condition; stable semantic identity survives unrelated reorder; all target-resolution boundaries are deadline-gated; disconnected nodes report MISSING/REPLACED/AMBIGUOUS and never VERIFIED; data and HTTP download proofs are separate. Focused 47/47, adjacent 158/158, full 345/345, typecheck/build PASS; root fresh focused 47/47 plus typecheck/build PASS. No Git/dependency/live-target operation occurred.
- Task 11 fix round 1/5 independent re-review: NEEDS FIXES — manifest 30/30 matched; entering Critical and both Important findings ADDRESSED; 0 Critical, 2 new Important, 1 Minor. Fix round 2/5 is in progress.
- Task 11 Important (round 2): non-visible generic candidates and same-node hide transitions produce valid zero-size rectangles, but the candidate contract requires positive dimensions and throws, aborting discovery/post evidence. Allow finite consistent zero-size geometry only when `visible === false`; visible candidates remain positive-size.
- Task 11 Important (round 2): initial duplicate semantic identity returns an ambiguous reason but default MISSING evidence. Normalize zero matches as MISSING and multiple matches as AMBIGUOUS.
- Task 11 Minor (fix round 2): real data-download coverage observes the ledger event but would pass if `download.cancel()` were removed. Add direct resolved fake-Download cancel invocation coverage while preserving separate real-browser/data and HTTP server proofs.
- Task 11 fix round 2/5 implementation verified pending independent re-review: hidden candidates now retain valid finite zero-size evidence and reject as NOT_VISIBLE without aborting discovery; same retained node self-hide produces VERIFIED visibility/layout evidence; initial duplicate reason/evidence are both AMBIGUOUS; direct fake Download proves cancel invocation. Focused 50/50, adjacent 162/162, full 349/349, typecheck/build PASS; root fresh focused 50/50 plus typecheck/build PASS. No Git/dependency/live-target operation occurred.
- Task 11 fix round 2/5 independent re-review: NEEDS FIXES — manifest 33/33 matched; entering findings ADDRESSED; 0 Critical, 2 new Important, 0 Minor. Fix round 3/5 is in progress.
- Task 11 Important (round 3): changed evidence is evaluated before click failure, so a click that mutates then throws TimeoutError can be mislabeled VERIFIED. Freeze events remain first, but click failure must precede VERIFIED; timeout is NOT_VERIFIABLE and other error EXECUTION_FAILED with evidence retained.
- Task 11 Important (round 3): valid unresolved `aria-controls` produces null controlled state but the candidate contract demands booleans and aborts all discovery. Allow null/null unknown state; require observed boolean pairs to be exact inverses; reject mixed or inconsistent pairs.
- Task 11 fix round 3/5 implementation verified pending independent re-review: post-observation precedence is freeze event > click failure > identity/deadline > VERIFIED; timeout and ordinary click failures retain observed evidence but cannot verify. Unresolved aria-controls is valid null/null evidence; observed booleans must be exact inverses. Targeted 9/9, focused 59/59, adjacent 171/171, full 358/358, typecheck/build PASS; root fresh focused 59/59 plus typecheck/build PASS. No Git/dependency/live-target operation occurred.
- Task 11 fix round 3/5 independent re-review: NEEDS FIXES — manifest 34/34 matched; aria-controls ADDRESSED; click-failure precedence PARTIAL at click-consumes-deadline boundary; 0 Critical, 1 Important, 0 Minor. Fix round 4/5 is in progress.
- Task 11 Important (round 4): if click itself reaches the deadline and throws ordinary Error, the post-loop deadline return overrides EXECUTION_FAILED. After the first safety snapshot, an already-expired failed click must be classified before post evaluation/deadline, retaining its reason and issuing zero post evaluations.
- Task 11 fix round 4/5 implementation verified pending independent re-review: after the first safety snapshot, expired click failure is classified before generic deadline; ordinary Error remains EXECUTION_FAILED, TimeoutError remains NOT_VERIFIABLE, original reason is retained, and zero post evaluations occur. Targeted 5/5, focused 61/61, adjacent 173/173, full 360/360, typecheck/build PASS; root fresh focused 61/61 plus typecheck/build PASS. No Git/dependency/live-target operation occurred.
- Task 11 fix round 4/5 independent specification re-review: PASS — derived manifest 34/34 matched; 0 Critical, 0 Important, 0 Minor; targeted 5/5, focused 61/61, adjacent 173/173, full 360/360, typecheck PASS. Final independent code-quality review is pending.
- Task 11 final independent code-quality review: NEEDS FIXES — derived manifest 34/34 matched; 0 Critical, 5 Important, 2 Minor. Fix round 5/5 is in progress.
- Task 11 Quality Important: guard-owned popup/download/CDP/invalidation listener promises are not drained before owner close/final snapshot, allowing late safety failures to disappear from returned evidence.
- Task 11 Quality Important: candidate NodeLists and descendant text are fully materialized before public bounds; index only the first candidate limit and walk text nodes only to explicit node/character limits in both discovery and retained inspection.
- Task 11 Quality Important: Task 5 Safety Ledger arrays, invariant strings/events, method keys, and counters remain unbounded; apply consistent bounded/saturating behavior to every category with one explicit overflow invariant.
- Task 11 Quality Important: final freeze precedence excludes REJECTED_UNSAFE, producing status/safety contradiction when close records a freeze event. Every late freeze event must be authoritative.
- Task 11 Quality Important: ElementHandle dispose rejection can overwrite established click/safety outcome and evidence. Record cleanup failure without discarding original status/reason/evidence, and preserve both errors when no outcome exists.
- Task 11 Quality Minor (fix): validate rectangle x/left and y/top consistency. Browser-side fact-extraction duplication may remain documented only if safe consolidation would require a page-visible/string-evaluated authority.
- Task 11 fix round 5/5 implementation verified pending final independent quality re-review: all five entering Important findings and rectangle consistency have genuine RED/GREEN coverage. Guard tasks are bounded-drained into the final audit snapshot; hostile candidate/text work and every ledger category are bounded; every late freeze is authoritative; disposal failure preserves prior outcome/evidence. Implementer focused 167/167, adjacent 191/191, typecheck/build PASS, and repeated full repository 378/378 PASS after one worker-process exit with no test failure. Root fresh unit 30/30, browser integration 103/103, Task 5/11 focused 163/163, typecheck/build PASS. A fixed 35-entry SHA-256 quality-review manifest is prepared. No Git/dependency/live-target operation occurred.
- Task 11 fix round 5/5 final independent quality re-review: NEEDS FIXES — manifest 35/35 matched; fresh unit 30/30, Chromium integration 103/103, typecheck PASS; 0 Critical, 5 Important, 2 Minor. Async drain, ledger bounds, rectangle consistency, and most entering corrections are addressed. Remaining Important gaps are total DOM traversal work, frozen-versus-closing event authority, pre-try handle disposal, encoded outcome plus close failure preservation, and bounded guard correlation bookkeeping.
- Task 11 architectural stop: five correction rounds have exposed repeated cross-cutting lifecycle/error/bounds defects. Per Superpowers systematic-debugging, do not attempt a sixth patch without user-approved architectural direction. Task 11 mandatory checkpoint remains FAIL; Tasks 12+ remain NOT STARTED.
- Task 11 architecture recovery approach approved by the user on 2026-08-31. The architectural design is written and self-reviewed at `doc/design/2026-08-31-beaksight-task-11-architecture-recovery-design.md` (SHA-256 `D0F8CFDC961A4BC6C5E3CAF5C3F6ABDE4071223845781608262098714085BC18`). It defines a single guarded phase machine, bounded async/correlation ownership, total-node browser traversal bounds, single ElementHandle ownership, and one outcome/cleanup finalizer. Placeholder, consistency, ambiguity, and scope scans PASS. User review of the written design remains required before writing the implementation plan; no production, Git, dependency, or live-target action occurred.
- Task 11 architecture recovery design approved by the user. The TDD implementation plan is written and author-self-reviewed at `doc/design/2026-08-31-beaksight-task-11-architecture-recovery-implementation-plan.md` (SHA-256 `994D8C02919CE34752CD5DDC36717DAEDE6C131DFF4170B0677A1FF415E82A25`). Five independently reviewable tasks cover the phase machine, bounded task/correlation owners, all-node DOM traversal, Handle/result finalization, and listener/full-gate integration. Spec coverage, placeholder, helper-definition, and type-name audits PASS. Git commit steps are replaced with SHA-256 checkpoints; no production, dependency, Git, or live-target action occurred.
- Task 11 architecture recovery execution mode: user selected Superpowers Subagent-Driven Development. The bundled `task-brief` Bash script could not run because this Windows host has no `bash`; its Task 1 heading range was mechanically extracted with PowerShell to `task-11-recovery-task-1-brief.md` (291 lines; SHA-256 `126A1D53433A1DEFA9B0AA73E2AB3ADC7325A04BA6AFA3E64D9C3DF142DEFDF1`). This is a tooling fallback only; the approved plan text is unchanged.
- Task 11 recovery Task 1 baseline (Git prohibited): `src/safety/passive-request-guard.ts` SHA-256 `1C0E00688A903895D265CAADCFB13D142752918BD7CEAA99EA4CBC197ACA8A3B`; `tests/integration/passive-request-guard.test.ts` SHA-256 `3D4C7694B763C6B0824F0204555DFCD7808F13F0292898910A3E7D2D5C9EB636`.

## Task 11 architecture recovery pre-flight dependency scan

| Tasks | Producer / consumer or shared surface | Finding |
| --- | --- | --- |
| Task 1 self-check | New RED lifecycle tests -> single `GuardState.phase` implementation -> focused/Task 5 regression/typecheck | Consistent; passive close is an explicit characterization while frozen close cases must fail before production correction. |
| Task 2 self-check | RED overflow/correlation tests -> bounded admission and registries -> focused/typecheck | Consistent; exact limits and retention are fixed in the approved design. |
| Task 3 self-check | Hostile fixture and SHOW_ALL spy -> both discovery/retained callbacks -> focused/typecheck | Consistent; total visited-node and retained-character limits are tested at both paths. |
| Task 4 self-check | Dispose/close RED cases -> one Handle scope and one outcome finalizer -> focused/typecheck | Consistent; session-factory rejection remains outside result finalization by design. |
| Task 5 self-check | Listener teardown RED -> cleanup ownership -> full gates and fixed manifest | Consistent; no checkpoint completion occurs before both independent reviews are clean. |
| Tasks 1 -> 2 | `GuardState.phase`, `isFrozenPhase()`, `invalidatingPhase()` in `passive-request-guard.ts`; shared guard tests | Ordered dependency is explicit; Task 2 must not recreate lifecycle authority. |
| Tasks 1 -> 4 | Frozen closing/invalidation remains authoritative in Task 4 final Safety Ledger snapshot; shared interaction integration tests | Interfaces agree; Task 4 consumes the final guard evidence without changing guard policy. |
| Tasks 1 -> 5 | Guard phase/listener callbacks and shared guard/interaction tests | Ordered dependency is explicit; Task 5 adds teardown only after close/drain semantics are stable. |
| Tasks 2 -> 5 | Bounded task/correlation owners and listener-owned tasks in `passive-request-guard.ts` | Interfaces agree; teardown must drain the bounded owner before terminal `CLOSED`. |
| Tasks 3 -> 4 | `inspectInteractionCandidateHandle()`/discovery evidence and shared isolated-interaction tests | Interfaces agree; Task 4 changes Handle lifetime, not browser fact semantics. |
| Tasks 3 -> 5 | Hostile traversal regression in shared isolated-interaction tests | No conflict; Task 5 reruns and packages the Task 3 proof without changing its bounds. |
| Tasks 4 -> 5 | Final audit outcome/evidence and shared isolated-interaction tests | Interfaces agree; Task 5 listener cleanup may add final ledger evidence but must not discard Task 4 work evidence. |

- Pre-flight ruling: Git-specific SDD BASE/HEAD, commits, worktree, and diff-package steps are replaced by explicit before/after SHA-256 manifests and fixed review packages because the user prohibited every Git operation. The cost if this ruling is wrong is reduced automatic diff provenance; immutable file hashes plus task-scoped packages retain the review boundary.
- Task 11 recovery Task 1: in progress. A fresh implementer must perform genuine RED before modifying production and must stop before Task 2.
- Task 11 recovery Task 1 implementation verified pending independent review: genuine RED was 2 expected failures with 2 passive/aggregate characterizations passing; implementer and controller focused GREEN 4/4, adjacent 94/94, and typecheck PASS. Current hashes: guard `8A0F29FA8ED39A21C7514D38957502B0BFF481FB1D32FD151564EE18815C7D11`; guard integration test `07BFB22681157C811FD925231507FF7C5DD431483470260369AC4615068A9424`; package/lock unchanged. Fixed review package SHA-256 `1860D8BA4B70BE1DC74704507FC0CD59C703BE2C76D5B3E77A976C25BD0B2C55`.
- Task 11 recovery Task 1 specification review: FAIL — manifest matched; 0 Critical, 3 Important, 0 Minor. Fix round 1/5 is in progress.
- Task 11 recovery Task 1 Important (round 1): installation completion can illegally reactivate `PASSIVE_INVALIDATING` as `PASSIVE_ACTIVE` after installation-time activity triggers invalidation.
- Task 11 recovery Task 1 Important (round 1): successful safety invalidation does not drain owned tasks or transition `*_INVALIDATING -> CLOSED`.
- Task 11 recovery Task 1 Important (round 1): frozen HTTP/CDP evidence is recorded after abort/`Fetch.failRequest`, so an enforcement rejection can erase the observed interaction evidence despite record-first precedence.
- Task 11 recovery Task 1 fix round 1/5 re-review: 2 addressed, 1 open. Illegal installation reactivation and HTTP/CDP record-first precedence are ADDRESSED. Successful invalidation completion is NOT ADDRESSED because the correction launches an unowned `void` drain and returns before owned tasks settle/`CLOSED` is reached. No new separate Critical/Important finding; fix round 2/5 is in progress.
- Task 11 recovery Task 1 fix round 2/5 re-review: invalidation completion remains open. GuardState now owns an awaitable completion and call sites avoid self-await, but the owner is published only after the async completion invokes `context.close()`. Synchronous close side effects can re-enter invalidation while phase is invalidating and owner is still undefined, receiving an already-resolved promise before close/drain. 0 Critical, 1 Important, 0 Minor; fix round 3/5 is in progress.
- Task 11 recovery Task 1 fix round 3/5 re-review: PASS — invalidation owner publication race ADDRESSED; completion is stored before the gate allows the first re-entrant `context.close()` side effect, all re-entry shares that owner, guarded Context close failure publishes before invalidating and resolves only after drain. 0 Critical, 0 Important, 0 Minor. Specification gate is clean; fresh full Task 1 code-quality review is pending.
- Task 11 recovery Task 1 final code-quality review: FAIL — manifest matched; 0 Critical, 2 Important, 2 Minor. Fix round 4/5 uses a fresh higher-capability implementer per SDD.
- Task 11 recovery Task 1 Important (round 4): installation can fulfill after installation-time invalidation/CLOSED, causing unchanged `context-factory.ts` to register an unusable Context as active; non-INSTALLING final phase must reject after awaiting invalidation completion.
- Task 11 recovery Task 1 Important (round 4): safety invalidation drains owned tasks only on successful Context close; failed close can return before late ledger mutation, so drain must run regardless while CLOSED remains success-only.
- Task 11 recovery Task 1 minor (deferred): correlate lifecycle-phase HTTP aborts in `expectedRouteFailures` to avoid false passive-teardown `HTTP_MAIN_FRAME_DELIVERY_FAILED`.
- Task 11 recovery Task 1 minor (deferred): make `emitFailedMainFrameRequest()` return its async handler result so tests can avoid timing-based microtask/timer waits.
- Task 11 recovery Task 1 fix round 4/5 re-review: PASS — both Important findings ADDRESSED; non-INSTALLING installation completion now awaits invalidation and rejects, failed invalidation close now still bounded-drains while CLOSED remains success-only. Exact fix introduced 0 Critical, 0 Important, 0 Minor; the two entering Minors remain deferred.
- Task 11 recovery Task 1: complete (Git prohibited; final production SHA-256 `898D0D371C384D7CFA417570D84FA7DC5CAAB8A0005894B5611107CFB01CE3FD`; guard integration test SHA-256 `7CD8FF1B90E9608D68EB97D006DE3B8C063A67FDE5C3F292B30F10FDED2117B6`; focused 12/12 PASS, adjacent 102/102 PASS, typecheck PASS; specification findings and quality Importants closed after four reviewed fix rounds; 2 Minors deferred).
- Task 11 recovery Task 2: in progress. Bound guard-owned task admission, expected CDP failure correlation, and redirect predecessor correlation without changing the Task 1 phase authority.
- Task 11 recovery Task 2 brief mechanically extracted on Windows (463 lines; SHA-256 `A5895957D9BEDA83D1BF7022DFEB65876E02D02776424F1A8B548BE99F679871`). Baseline hashes: guard `898D0D371C384D7CFA417570D84FA7DC5CAAB8A0005894B5611107CFB01CE3FD`; guard integration test `7CD8FF1B90E9608D68EB97D006DE3B8C063A67FDE5C3F292B30F10FDED2117B6`.
- Task 11 recovery Task 2 Ruling: the brief's illustrative `GuardState` shape predates Task 1 review corrections and omits the now-required `invalidationCompletion`. Retain that Task 1 field and route overflow invalidation through the same published exactly-once Context invalidation owner while keeping `overflowInvalidation` as its reserved admission/retention slot. Do not create a second close path or set an invalidating phase before an owner is published. This follows the approved single-owner phase design; if wrong, the cost is reworking the overflow owner rather than regressing Task 1's reviewed re-entry/evidence-cutoff guarantees.
- Task 11 recovery Task 2 carry-forward: the deferred Task 1 lifecycle-abort correlation Minor and async `emitFailedMainFrameRequest()` helper Minor are in files/surfaces Task 2 touches. They remain non-blocking; resolve them only where Task 2's exact registry/consume tests naturally require the same correction, and report the disposition.
- Task 11 recovery Task 2 implementation verified pending review: focused registry 5/5, Task 1 lifecycle 12/12, adjacent 115/115, and typecheck PASS. Production SHA-256 `1B364A7C29B53F227E23228734D315657D4A6A0B5D94A94A5BA6C06DA48FF001`; test SHA-256 `79F193D97440BC292E4A61494B77129501CCA7C8FC8CF8FE9FEE086B0AC998B6`; package/lock unchanged.
- Task 11 recovery Task 2 independent review: FAIL — manifest matched; 0 Critical, 3 Important, 1 Minor. Fix round 1/5 is in progress. Controller resolves the review's evidence-warning from fresh exact-hash outputs: focused 5/5, lifecycle 12/12, adjacent 115/115, typecheck exit 0; it is not an implementation gap.
- Task 11 recovery Task 2 Important (round 1): tracked paused-Document factories await invalidation whose stable drain includes the same task, forcing timeout and allowing false terminal behavior.
- Task 11 recovery Task 2 Important (round 1): redirect predecessor lookup does not validate the 256-character ID bound and treats invalid/missing/expired/consumed predecessor as no redirect instead of failing the current Document closed.
- Task 11 recovery Task 2 Important (round 1): harness/tests do not retain CDP command parameters and therefore do not directly prove exact predecessor consume, the specific overflow/invalid request failed, or exactly-one invalidation.
- Task 11 recovery Task 2 minor (deferred): restore consistent indentation inside the page-guard task factory to make concurrency ownership reviewable.
- Task 11 recovery Task 2 fix round 1/5 re-review: PASS — all 3 Important findings ADDRESSED; tracked factories initiate without self-await, redirect lookup is bounded/discriminated/fail-closed, and exact CDP command/requestId assertions prove consume/overflow/invalidation. 0 new Critical, 0 Important, 0 Minor.
- Task 11 recovery Task 2: complete (Git prohibited; production SHA-256 `D95DB8414C8E4239EFAC501A30F33F365075DD4D26D451B4FCBF584C121D40DB`; guard integration test SHA-256 `6F6D13681EAF3EF71DEE9E80B21B7D2D2D2E4209D3C018BF62EAECFC0A07957A`; Task 2 original focused 5/5, fix focused 5/5, Task 1 lifecycle 12/12, adjacent 120/120, typecheck PASS; 3 Minors deferred across Task 1/2).
- Task 11 recovery Task 3: in progress. Bound total browser traversal work in both candidate-discovery and retained-handle inspection paths.
- Task 11 recovery Task 3 brief mechanically extracted (128 lines; SHA-256 `2BA3BC9C9EA4D8AC8788EE6C12DA94AC58FDA8E6811EECA8DC64ADDF981541E5`). Baselines: `discover-candidates.ts` `1546FF3482EA43A374E4EF4E60147B9735D95D262C715DA49B0DA0F4366BB9E2`; hostile fixture `57E90F400E219C1F8D5D51E5A7B536AD06ABEC9CA38095DE38A9889116B1BBF1`; isolated interaction test `FD07D0DC94E7388CF8BC0EFBB196AC11E83AFF0E2F148CB258FFD798E6E0146D`.
- Task 11 recovery Task 3 systematic-debugging result: focused traversal 2/2, interaction-policy 22/22, and typecheck PASS, but full isolated suite was 44/45 on the unchanged double-freeze error assertion. Exact single-test reproduction consistently receives `Interaction freeze transition is invalid from FROZEN_ACTIVE` while the test expects legacy `INTERACTION_FROZEN`. The assertion predates Task 1's approved removal of `GuardMode`; Task 1 production correctly reports the sole `GuardPhase` value.
- Task 11 recovery Task 3 Ruling: update only the stale integration expectation from `INTERACTION_FROZEN` to `FROZEN_ACTIVE`; do not restore the removed mode name in production. This follows the approved single-phase authority. If wrong, the cost is a one-line test-contract reversion, whereas changing production would reintroduce a second lifecycle vocabulary.
- Task 11 recovery Task 3 independent review: FAIL — all 13 fixed-package hashes matched; production traversal semantics, fixture, one-line Task 1 expectation maintenance, focused/full/unit/typecheck evidence are compliant; 0 Critical, 1 Important, 0 Minor. The focused hostile tests use a one-element roots array, so they do not kill a `visitedNodes` reset-per-root mutation. Fix round 1/5 is in progress and is limited to both-path multi-root aggregate-budget coverage (or an equivalent mutation proof).
- Task 11 recovery Task 3 fix round 1/5 re-review: PASS — all 12 fixed correction hashes matched; multi-root discovery and retained-handle tests each prove one aggregate 512-node budget across two 300-descendant roots and kill reset-per-root at return 513; original hostile tests remain unchanged; production was restored byte-for-byte. Fresh combined focus 4/4, full isolated 47/47, interaction-policy 22/22, and typecheck PASS; 0 Critical, 0 Important, 0 Minor.
- Task 11 recovery Task 3: complete (Git prohibited; production SHA-256 `E1056A659152770E0CD86036C55C6F5D47CED9572E11512420D0F18769EFC9F1`; hostile fixture `755A6F10B14968EF7FF637110625F327D689F98E1A8EC54BEC25873B49B1B79F`; multi-root fixture `9870AECCC9B4830C2C89E778FC7B929A7888F64BCF17238CCB07C430D9FB9919`; isolated test `9B2605E13CEEB4B7026ED19B4AE88592213D3D4C7F3FE19AD31E58CAA40FB87E`; fixed focus/full/unit/typecheck and independent review clean).
- Task 11 recovery Task 4: in progress. Give every non-null ElementHandle one finalizer and preserve established work outcome/evidence when Handle dispose or owner close fails.
- Task 11 recovery Task 4 brief mechanically extracted from the approved plan (236 lines; SHA-256 `04B7EDC8072155913033884135944105AE617A73E5B1D0082FEB4E1EB60912AD`). Git-free immutable baselines are byte-identical to dispatch HEAD: `src/interaction/isolated-auditor.ts` and its copy SHA-256 `BD8FCB49BB765D27BBB18E8CC4562185B87BDDC326F96549A9C626558291BED0`; `tests/integration/isolated-interaction.test.ts` and its copy SHA-256 `9B2605E13CEEB4B7026ED19B4AE88592213D3D4C7F3FE19AD31E58CAA40FB87E`.
- Task 11 recovery Task 4 implementation verified pending independent review: genuine focused RED 3/3 intended failures; GREEN focused 3/3, isolated+policy 70/70, adjacent 168/168, maintained repository 405/405, typecheck/build PASS. Controller process-artifact ruling: historical `.superpowers/**/*.test.ts` snapshots caused unscoped Vitest collection failures; preserve their fixed paths/hashes and constrain `vitest.config.ts` discovery to actual maintained `tests/**/*.test.ts`. Unscoped full suite then passed 405/405. No Git/dependency/live-target operation occurred.
- Task 11 recovery Task 4 independent review: FAIL — all fixed hashes matched; 0 Critical, 3 Important, 1 Minor. Fix round 1/5 must separate close-failure state from arbitrary rejection values (including `undefined`), make rejection normalization total/bounded for hostile work/dispose/close values, restore approved design freeze-before-close precedence, and directly prove exactly-once cleanup/invariant behavior.
- Task 11 recovery Task 4 Ruling: approved architecture design section 8.1 is authoritative over the conflicting Task 4 plan code sample. Final result precedence is final freeze evidence first, then owner-close rejection, then work outcome. The plan's close-first sample must not override this user-approved architectural contract; if wrong, the cost is a small pure-finalizer reorder rather than silently violating the final Guard snapshot authority.
- Task 11 recovery Task 4 fix round 1/5 re-review: PASS — arbitrary close rejection values, total bounded hostile normalization, design-authoritative freeze-first, and exactly-once cleanup/invariant proof are all addressed; no new breakage. Fresh focus 11/11, unscoped/explicit full 410/410, typecheck PASS; 0 Critical, 0 Important, 0 Minor.
- Task 11 recovery Task 4: complete (Git prohibited; production SHA-256 `DE9C73B1A1B9601C62C3A59B7B8C111620AFE678B383DAA8433D80C684DC8814`; isolated test `E3A1948BB72346195F511347D34029A25C16C46564F3CB30FE749BC29BF2170B`; Vitest config `095BD4B5600B4B08C462DAEE36AD77EEA44A9E5A744CC84BDF29086EE1095184`; full gates and independent review clean).
- Task 11 recovery Task 5: in progress. Integrate exactly-once lifecycle listener teardown, run final full verification, and close the Task 11 recovery checkpoint with fixed review evidence.
- Task 11 recovery Task 5 brief mechanically extracted from the approved plan (168 lines; SHA-256 `2360AE3AA9D84FBDDF8EB90769EBC48E4B46B73BE5DCE3947144D07235FA00E3`). Git-free immutable dispatch baselines are byte-identical: guard `D95DB8414C8E4239EFAC501A30F33F365075DD4D26D451B4FCBF584C121D40DB`; guard integration test `6F6D13681EAF3EF71DEE9E80B21B7D2D2D2E4209D3C018BF62EAECFC0A07957A`; isolated interaction test `E3A1948BB72346195F511347D34029A25C16C46564F3CB30FE749BC29BF2170B`.
- Task 11 recovery Task 5 implementation verified pending final reviews: listener RED/undefined-close RED genuine; focused 199/199, adjacent 47/47, full 414/414 first run, typecheck/build PASS, forbidden scan clean, package/config unchanged. Guard/test final hashes `5B51E854FD09165BB21CDA5FAAAE10F7587E7B179C31157C426D459D76A9CCDF` / `5780BDE5F3A00EAF51E16A92AE6B67A1FF054A35E1EA2AAFFC60C6B76513998F`.
- Task 11 recovery final specification review: FAIL — manifest 48/48; 0 Critical, 1 Important, 4 Minor. Drain timeout incorrectly records an invariant then returns ordinary success/CLOSED with live tasks, and the existing test inverts the approved design proof.
- Task 11 recovery final quality review: FAIL — manifest 48/48; 0 Critical, 4 Important, 3 Minor. Accepted blockers: owner close cannot join an existing invalidation owner; flat listener cleanup ownership is unbounded/retains closed pages; guard error normalization is not total for hostile values. Controller rejects querySelectorAll/ancestor-work as a Task 11 blocker because approved design §6 explicitly retained querySelectorAll plus bounded indexed NodeList access; changing DOM selection is a future redesign, not this checkpoint.
- Task 11 recovery Task 5 fix round 1/5 is in progress for drain timeout failure semantics, invalidation-owner join, bounded lifetime listener ownership, and total bounded guard error normalization. Task 12 remains blocked.
- Task 11 recovery Task 5 fix round 1/5 implementation verified pending dual re-review: accepted blockers have genuine RED/GREEN and combined 9/9; focused 207/207, adjacent 47/47, full 422/422 first run, root full 422/422, typecheck/build PASS, forbidden scan clean, package/config unchanged. Final Guard/test hashes `D0E521349C5DB3DF5357CBD7658C8029829831765BA177B34DC9CD29A0487943` / `3A3A545FDF5614EF07B36CB23114F61686F7CEAEF7FFD9F8FE6ABF1B8FB903AA`.
- Task 11 recovery fix round 1 dual re-review: FAIL — spec 0 Critical/1 Important/4 Minor; quality 0 Critical/3 Important/5 Minor. Accepted blockers are real factory-path invalidation join bypass, overflow invalidation unhandled timeout rejection, and readiness-admission partial listener-group leak. Fix round 2/5 is in progress; also close the related undefined-abort and BigInt-normalization Minors.
- Task 11 recovery fix round 2 dual re-review: specification PASS (0 Critical/0 Important/5 Minor), quality FAIL (0 Critical/2 Important/3 historical Minors). The five requested round-2 corrections pass, but an intervening active-only operation can still discard factory close ownership during invalidation, and successful invalidation yields timing-dependent public close success/failure that can lose `BLOCKED_BY_SAFETY` precedence. Fix round 3/5 is in progress; Task 12 remains blocked.
- Task 11 recovery Fix round 3 remains unreviewed/incomplete. User rejected Task 11 approval: CLOSING currently discards later invalidation, factory releases ownership on non-terminal close failure, and session becomes non-retryable before terminal confirmation. Fix round 4/5 is in progress under the binding `invalidation > normal close` priority rule and terminal-only owner release; Task 12 remains blocked.
- Task 11 recovery Fix round 4 independent review: FAIL — specification 0 Critical/1 Important/5 Minor; quality 0 Critical/2 Important/4 Minor. Open Importants are unreachable ownership after construction-time failed close, uncontained failed-request invalidation rejection, and HTTP/WebSocket callback work outside the stable drain/evidence cutoff. Fix round 5/5 is in progress; Task 12 remains blocked.
- Task 11 recovery Fix round 5 implementation verified: construction-time non-terminal Context ownership is retained and exposed through immutable `ContextConstructionError` for the existing factory close/join path; event-driven invalidation contains its initiation view while preserving the public owner rejection; HTTP/WebSocket protocol callbacks share the bounded Guard task owner, remove themselves before synchronous invalidation promotion, and admit no post-terminal protocol/evidence work. Genuine RED 7/7 became GREEN; combined lifecycle focus 12/12, Guard/factory/auditor 177/177, Task 11 226/226, adjacent 47/47, repository 441/441, typecheck, and build PASS. No Git, dependency, or live-target operation occurred.
- Task 11 recovery Fix round 5 independent reviews: PASS — specification 0 Critical/0 Important/6 Minor (5 historical/deferred, 1 new test-strength-only); quality 0 Critical/0 Important/5 historical/deferred Minor and 0 new Minor. All three entering findings are ADDRESSED; review-package manifest 48/48 matched with exactly 6 substitutions and 42 unchanged entries. Specification review SHA-256 `628C4BE984B538C00A21C5850927CA0BC8918E9A780B9C85EEE7640916E70724`; quality review SHA-256 `20689F473672042FA0A163FC34950C979F1BA824C882274661FC8D21FDEC5664`.
- Task 11 recovery technical checkpoint: complete and ready for user approval. The binding `invalidation > normal close` rule, CLOSING-time invalidation retention, terminal-only factory/session owner release, failed-close ownership retention, and required close/invalidation order regressions are implemented and independently accepted. Task 11 remains user-unapproved and Task 12 remains blocked until the user explicitly accepts this report.
- Task 11 recovery final controller verification after both review artifacts were fixed: lifecycle/round-5 focus 12/12 PASS; six-file Task 11 regression 226/226 PASS; `npm run typecheck` exit 0; `npm run build` exit 0. The initial sandboxed browser launch failed with environment `spawn EPERM`; the same existing-browser commands passed outside that process-launch restriction. No download, dependency mutation, Git operation, or Task 12 work occurred.
- Task 11 user rejection after Fix round 5: Critical 0 / Important 3. Open load-bearing findings are (1) no canonical retry owner can move a failed raw Context close from `*_INVALIDATING` to terminal `CLOSED`; (2) candidate discovery/inspection still performs unbounded whole-DOM `querySelectorAll()` work and unbudgeted visibility ancestor walks instead of one shared total DOM-work budget; (3) owner-close failure collapses the original work status/reason into a final reason string instead of retaining work and lifecycle/cleanup outcomes as separate structured axes. Task 11 remains unapproved and Task 12 remains blocked.
- NOT RUN — Task 11 post-correction gates: command: Task 11 focus tests; reason: correction design and implementation not yet approved/executed; impact: corrected behavior unverified; completion blocker: yes.
- NOT RUN — Task 11 post-correction gates: command: isolated-interaction full regression; reason: correction design and implementation not yet approved/executed; impact: interaction regression state unknown after future correction; completion blocker: yes.
- NOT RUN — Task 11 post-correction gates: command: lifecycle race tests; reason: retry lifecycle RED/GREEN has not been implemented; impact: terminal recovery and single-flight ownership unproven; completion blocker: yes.
- NOT RUN — Task 11 post-correction gates: command: DOM budget tests; reason: total DOM-work budget contract has not been designed/implemented; impact: bounded discovery/inspection unproven; completion blocker: yes.
- NOT RUN — Task 11 post-correction gates: command: `npm run typecheck`; reason: no correction implementation exists yet; impact: future type-surface changes unverified; completion blocker: yes.
- NOT RUN — Task 11 post-correction gates: command: `npm run build`; reason: no correction implementation exists yet; impact: future build output unverified; completion blocker: yes.
- NOT RUN — Task 11 post-correction gates: command: independent specification and quality review; reason: no fixed correction package exists yet; impact: Task 11 approval gate remains open; completion blocker: yes.
- Task 11 three-finding correction design: written specification created at `doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-design.md`; it defines retryable single-flight close/drain attempts, a shared `maxDomWork = 16_384` contract without whole-DOM selector enumeration, and additive structured `work`/`lifecycle` result axes. Written design is pending user review; implementation planning and production/test edits have not started. Task 12 remains blocked.
- Task 11 three-finding correction design approved by the user. The written specification now records a typed `CloseAttemptResult` so invalidation precedence survives the atomic transition to `CLOSED` without adding a second lifecycle authority.
- Task 11 three-finding correction implementation plan created at `doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-implementation-plan.md`. It defines four reviewed TDD units: retryable lifecycle, total DOM budget and bounded Handle resolution, structured work/lifecycle result, and final verification/dual review. Plan is pending user review; production/test edits have not started and all previously listed post-correction gates remain NOT RUN. Task 12 remains blocked.
- Task 11 three-finding correction implementation plan approved by the user; execution started with Task 1 only. The bundled `task-brief` extractor could not run because `bash` is unavailable in this Windows environment, so an equivalent fixed routing brief was created with `apply_patch` at `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-task-1-brief.md`, including the approved plan/design hashes and six-file no-Git baseline. Task 2+, Task 12, dependencies, Git, and live targets remain untouched.
- Task 11 correction Task 1 initial implementation independent review: FAIL — Critical 0 / Important 2 / new Minor 0. Demonstrated blockers are (I1) one protocol callback can implicitly consume a second retry after synchronous/direct raw-close rejection and reach `CLOSED` without an explicit owner retry, and (I2) hostile raw-close rejection can throw from `instanceof GuardTaskDrainTimeoutError` and escape event containment as `unhandledRejection`. Fix round 1 is in progress from a frozen no-Git baseline; Task 2+ and Task 12 remain blocked.
- Task 11 correction Task 1 fix round 1 independent re-review: PASS — Critical 0 / Important 0 / new Minor 0; I1 and I2 ADDRESSED, fixed manifest 15/15. Task 1 is complete. Task 2 total-DOM-work correction is now in progress from a frozen no-Git baseline; Task 3+, Task 12, dependencies, Git, and live targets remain untouched.
- Task 1 controller ruling before production edits: raw-close failure ends the attempt promptly, retaining pending tasks/listeners/owner for a later explicit retry; wrapper page-close/installation errors retain their primary cause; readiness failure hands off `ContextConstructionError` without implicit retry, and session construction rethrows that handoff unchanged. Superseded late-evidence tests are rewritten to prove retained work drains during the next successful attempt. TDD now resumed; evidence: `task-11-terminal-recovery-task-1-report.md`.
- Task 1 implementation verified, independent review pending: canonical single-flight raw-close/drain attempt retries failed non-terminal close, retries drain alone after confirmed physical close, preserves sticky invalidation and terminal-only release, and retains construction cause/owner without implicit retry. Pre-production RED command `npm test -- --run tests/integration/passive-request-guard.test.ts tests/component/context-factory.test.ts -t "retry|drain-only|retained close|synchronous re-entry"` exited 1 with 13 intended failures / 2 passed / 110 skipped; ordinary-overlap RED command `npm test -- --run tests/integration/passive-request-guard.test.ts -t "overlapping ordinary close"` exited 1 with 1 intended failure / 106 skipped. Final expanded GREEN command adds `|lifecycle priority|round 5` to the first filter and exits 0 with 23 passed / 105 skipped. Final regression `npm test -- --run tests/component/context-factory.test.ts tests/integration/passive-request-guard.test.ts`: exit 0, 128/128. `npm run typecheck`: exit 0. `npm test`: exit 0, 26 files / 449 tests passed. Full evidence and all intermediate failures are in `task-11-terminal-recovery-task-1-report.md`.
- Task 1 frozen final SHA-256: Guard `0B4F289617A4FE148F5B75D2E384A2A095F68244D69DCBC5A832BD4A8D2305C2`; factory `6690D8EBEDD061602B1D3417602F80E3E263D9A4FB6677AB304712EB782D0508`; Guard test `A2CC7C652C6A1838EA51231AA817825F12468840A90B11EE0C843552B1C8DDD1`; factory test `F43C49FC11C9915987DF8031A31EA3F040F43ACA2209E793A6D05F087A11BDC9`. Package hashes remain `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` / `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A`. Review index: `task-11-terminal-recovery-task-1-manifest.md`.
- NOT RUN — independent Task 1 specification/quality review: controller-owned; approval-blocking and Task 2 start remains blocked. NOT RUN — `npm run build`: outside Task 1 fixed emitted-file scope, deferred to later final verification; blocks final Task 11 approval, not implementation handoff. Task 2+ correction gates remain NOT RUN/out of scope. No Git, dependency download/install/import/package mutation, live-target access, subagent/reviewer spawning, or Task 2/3/4/12 work occurred.
- Task 1 fix round 1 I1/I2 implemented: protocol callback retains one invalidation Promise; hostile raw-close rejection classification is contained before bounded normalization. Genuine RED `npm test -- --run tests/integration/passive-request-guard.test.ts -t "fix round 1"`: exit 1, 5 failed / 109 skipped, production frozen; initial sandbox EPERM excluded. Identical GREEN: exit 0, 5 passed / 109 skipped. Expanded focus `npm test -- --run tests/integration/passive-request-guard.test.ts tests/component/context-factory.test.ts -t "retry|drain-only|retained close|synchronous re-entry|lifecycle priority|round 5|fix round 1"`: exit 0, 28 passed / 105 skipped. Scoped regression `npm test -- --run tests/component/context-factory.test.ts tests/integration/passive-request-guard.test.ts`: exit 0, 133 passed. `npm test`: exit 0, 26 files / 454 passed. `npm run typecheck`: exit 0.
- Round-1 hashes: Guard `E5E3DE0D7ABBE72D1786B5F1FA8EC920F98C7D6939656B8CFE2DB7FBAC1DECCB`; Guard test `F51487F71FED96760EA8FA36FC923D8648AE90CAE3EE54EDBE635138514D6BDF`; factory/test/packages/authorities/failed review/historical manifest unchanged. Full evidence: `task-11-terminal-recovery-task-1-fix-round-1-report.md`; fixed package: `task-11-terminal-recovery-task-1-fix-round-1-manifest.md`. Earlier contradicted success claims are superseded, historical evidence retained.
- Round-1 NOT RUN — independent re-review: controller-owned; blocks Task 1 approval/Task 2 start. NOT RUN — build: forbidden in fix round, no fresh emitted-output verification; blocks eventual Task 11 approval, not handoff. Task 2/3/4/12 remain untouched. No Git, dependency/library download/install/new import/package mutation, live-target access, subagents/reviewers, or out-of-scope edits; historical deferred Minors unchanged.
- Task 11 correction Task 2 DOM-budget implementation verified pending controller-owned independent review: hidden-host 20,000-parent and preserved 8,000/9,000 combined fixtures pass without renderer crash; Task 2 focus 11/11, isolated-interaction 68/68, authorized passive-request-guard 114/114, repository 465/465, typecheck/build PASS. Production has one `maxDomWork = 16_384`, no whole-DOM selector enumeration or locator escape hatch, and structured COMPLETE/CANDIDATE_LIMIT_REACHED/DOM_WORK_BUDGET_REACHED plus FOUND/MISSING/DISCONNECTED outcomes. Final hashes and complete evidence are in `task-11-terminal-recovery-task-2-report.md`; Task 3+, Task 12, Git, dependencies, live targets, and subagents remain untouched.
- Task 11 correction Task 2 independent review: FAIL — Critical 0 / Important 7 / new Minor 3. I1–I6 require retained-budget boundary repair, live exact-node reorder preservation, total resolver property ownership/cleanup, runtime envelope validation, root-candidate preservation, and unestablished identity for incomplete work. I7 is an original Task 2 behavioral-RED evidence gap. Fix round 1/5 is in progress; Task 3+, Task 12 remain blocked.
- Task 11 correction Task 2 fix round 1/5 implementation verified pending re-review: test-only state typechecked, then genuine current-production RED was 25 failed / 4 passed / 68 skipped with frozen production hashes. I1–I6 and M1–M3 corrections are GREEN: correction focus 29/29, combined DOM focus 40/40, isolated-interaction 97/97, passive-request-guard 114/114, lifecycle race focus 6/6, repository 494/494, typecheck/build PASS, forbidden scan clean. Historical I7 is not retroactively repaired: Ruling — preserve it as an irreversible evidence deviation rather than manufacture or relabel later RED; cost if wrong is that Task 2 cannot satisfy the original temporal TDD record despite current mutation-proof coverage. Evidence: `task-11-terminal-recovery-task-2-fix-round-1-report.md`.
- NOT RUN — Task 2 fix round 1 independent re-review: controller-owned; impact: I1–I6/M1–M3 remain unaccepted by fresh review; completion blocker: yes for Task 2 and Task 3 start. NOT RUN — correction Task 3/4 and product Task 12+: explicitly outside scope and blocked on Task 2 clean review. No Git, dependency/package mutation, live-target access, or out-of-scope implementation occurred.
- Task 11 correction Task 2 fix round 1 independent re-review: FAIL — Critical 0 / Important 3 / new Minor 0. Open findings are invocation-wide secondary text-node ownership, preservation of `undefined` as a present resolver primary rejection, and neutral `UNESTABLISHED` evidence whenever complete absence was not proved. Fix round 2/5 is in progress; historical I7 remains an adjudicated irreversible evidence deviation, and Task 3+/Task 12 remain blocked.
- Task 11 correction Task 2 fix round 2/5 implementation verified pending re-review: frozen package 17/17 matched; test-only typecheck passed; genuine current-production RED was 10 failed / 3 passed / 97 skipped with production/package hashes unchanged. Minimal GREEN adds one secondary text counter per discovery/inspection invocation, separates resolver primary presence from value, and makes neutral evidence `UNESTABLISHED` with `MISSING` only at complete-absence sites. Fresh focus 13/13, combined DOM focus 53/53, isolated-interaction 110/110, Guard 114/114, lifecycle focus 6/6, repository 507/507, typecheck/build PASS, forbidden scan clean. Evidence: `task-11-terminal-recovery-task-2-fix-round-2-report.md`.
- Task 11 correction Task 2 fix round 2/5 historical deviation: original Task 2 pre-implementation discovery/inspection behavioral RED remains unavailable. This later RED is correction-only and was not relabeled; controller I7 adjudication remains unchanged.
- NOT RUN — Task 2 fix round 2 independent re-review: controller-owned; impact: the three Important findings remain unaccepted until fresh review; completion blocker: yes for Task 2/Task 3 start. NOT RUN — correction Task 3/4 and product Task 12+: explicitly outside scope and blocked. No Git, dependency/library download/install/update/new import/package mutation, live-target access, subagent/reviewer spawning, or out-of-scope implementation occurred.
- Task 11 correction Task 3 implementation verified pending independent review: all 16 fixed baselines matched; test-only typecheck passed; accepted pre-production RED was 6/6 failures for structured axes plus 5/5 failures for undefined rejection/freeze combinations, with production hashes unchanged. Minimal GREEN adds canonical `isClosed`, immutable work/lifecycle axes, explicit close-failure presence, terminal-truth lifecycle classification, fulfilled-non-terminal invariant recording, and freeze-first finalization without work-string encoding. Fresh focus 15/15, isolated-interaction 113/113, context-factory 19/19, Guard 114/114, lifecycle focus 11/11, Task 2 DOM focus 53/53, repository 510/510, typecheck/build PASS, forbidden scans clean. Evidence: `task-11-terminal-recovery-task-3-report.md`.
- Task 11 correction Task 3 preserves Task 2 historical I7 as an adjudicated irreversible evidence deviation; no later RED is relabeled as its missing original temporal evidence.
- NOT RUN — Task 3 independent specification/quality review: controller-owned; impact: structured outcome implementation remains unaccepted until fresh review; completion blocker: yes for Task 3/Task 4. NOT RUN — correction Task 4/final dual review and product Task 12+: explicitly outside scope and blocked. No Git, dependency/library download/install/update/new import/package mutation, live-target access, subagent/reviewer spawning, or out-of-scope implementation occurred.
- Task 11 correction Task 3 independent review: PASS — Critical 0 / Important 0 / new Minor 0; fixed package 26/26 matched. Structured work/lifecycle axes, canonical terminal truth, arbitrary rejection presence, freeze-first precedence, immutable aliasing, and Task 1/2 non-regression were independently accepted. Task 4 is unblocked; Task 11 and Task 12 remain blocked on final checkpoint review and user approval.
- Task 11 correction Task 4 fresh verification: starting package 25/25 matched. Exact three-file focus passed 40 with 206 skipped after one excluded restricted Chromium `spawn EPERM`; isolated-interaction 113/113; lifecycle race 35 passed / 98 skipped; DOM budget 23 passed / 90 skipped; six-file regression 295/295; typecheck/build exit 0; adjacent 47/47; repository 26 files / 510 tests; both forbidden scans clean; package/lock fixed hashes match. No named failure or worker-process exit occurred.
- Task 11 correction Task 4 package comparison: prior package 48 entries / 48 unique, 11 substitutions / 37 unchanged / 0 missing. Fixed correction package retains all 48 and adds 37 paths: 85 entries / 85 unique / 0 removals / 0 duplicates. Historical Task 2 I7 remains explicitly adjudicated and unrepaired.
- NOT RUN — independent Task 11 correction specification review. Reason: controller-owned after fixed-package handoff; verifier self-review prohibited. Impact: final specification acceptance remains unproved. Completion blocker: yes.
- NOT RUN — independent Task 11 correction code-quality review. Reason: controller-owned after fixed-package handoff; verifier self-review prohibited. Impact: final quality acceptance remains unproved. Completion blocker: yes.
- NOT RUN — Task 11 approval and product Task 12+ implementation. Reason: dual reviews and explicit user approval remain required. Impact: Task 11 remains unapproved; Task 12 remains blocked. Completion blocker: yes.
- Task 4 constraints: no Git, dependency/library download/install/update/new import, package mutation, live target, production/test/spec/plan edit, reviewer/subagent delegation, or Task 12+ work. Full evidence: `task-11-terminal-recovery-task-4-report.md`; fixed package: `task-11-terminal-recovery-review-package.md`.
- Task 11 final dual review gate: specification PASS — Critical 0 / Important 0; quality FAIL — Critical 0 / Important 1. Open I1: exact retained identity found at live ordinal 100 was mislabeled `DISCONNECTED`, causing false disconnected rediscovery. Task 12 remains blocked.
- Task 11 final quality fix round 1 implemented pending dual re-review: all 19 frozen hashes matched; genuine behavioral RED was 4 failed / 5 passed / 111 skipped with production frozen; minimal GREEN adds payload-free `CANDIDATE_LIMIT_REACHED`, exact envelope validation, and direct pre/post auditor mapping to `NOT_VERIFIABLE` / `UNESTABLISHED`. True detach and actual DOM budget remain distinct.
- Fix round 1 fresh gates: ordinal-cap focus 9/9; isolated-interaction 120/120; exact Task 4 focus 40 passed / 213 skipped; lifecycle race 35 passed / 98 skipped; DOM budget plus ordinal boundary 30 passed / 90 skipped; six-file regression 302/302; repository 26 files / 517 tests; typecheck/build PASS; both forbidden scans clean; package/lock fixed hashes unchanged. Initial restricted Chromium `spawn EPERM` is excluded and the identical approved RED command ran behaviorally.
- Historical Task 2 I7 remains an adjudicated irreversible original behavioral-RED deviation. This fix-round RED proves only the ordinal-cap correction and is not relabeled as retroactive repair.
- NOT RUN — fresh independent Task 11 specification and code-quality re-reviews. Reason: controller-owned after fixed-package handoff. Impact: final fix remains independently unaccepted. Completion blocker: yes.
- NOT RUN — Task 11 approval and Task 12+ implementation. Reason: clean dual re-review and explicit user approval remain required. Impact: Task 12 remains blocked. Completion blocker: yes.
- Final quality fix round 1 constraints: no Git, dependency/library download/install/update/new import, package mutation, live target, subagent/reviewer dispatch, or Task 12+ work. Full evidence: `task-11-terminal-recovery-final-quality-fix-round-1-report.md`.
- Task 11 owner-retention/requestfailed correction implemented: all 20 frozen baselines matched; accepted unchanged-production RED was 8 behavioral failures / 2 passes / 250 skips with production/package hashes still frozen. The owner has exactly two total close attempts, terminal-only normal return, and frozen `InteractionOwnerCleanupError` handoff with exact session and arbitrary rejection presence/value. `requestfailed` is synchronous/void and uses the existing bounded Guard Task Registry plus terminal drain; no second registry exists.
- Correction fresh verification: focused correction 10/10; exact close retry 1/1; retained owner recovery 5/5; Task 11 focus 49/49; lifecycle race 44/44; Guard bound 5/5; requestfailed race 6/6; DOM budget 23/23; isolated interaction 124/124; passive Guard 117/117; context factory 19/19; six-file regression 309/309; repository 26 files / 524 tests; typecheck/build PASS; forbidden scans clean; package/lock unchanged. Restricted Chromium `spawn EPERM` and one malformed scan-quoting attempt were excluded and replaced with successful identical/corrected runs.
- Final correction source hashes: factory `454261DD6964756E9C06C4B9FD1C1CB80E14FDA5D458CCDC06549E6C973B6D6D`; auditor `0A030F675C5CCE748416006A5B2FA1EBD2016EA633C4B27A9C88BDBA11A63059`; Guard `49921091F4A92C5C7D9ADBE8CBA3621C6542B657E64217DFA5407B49CB02B7E3`. Detailed report `task-11-owner-retention-requestfailed-report.md` hash `1F045D678F01BD63F219163777C7AE5973B88FFFDF4BECB1FA706FB14D1AB532`.
- Historical Task 2 I7 remains an adjudicated irreversible original-RED deviation; no correction evidence is relabeled. No Git, dependency/library mutation, new import, live target, Task 12+, subagent, or reviewer work occurred.
- NOT RUN — independent Task 11 specification and code-quality reviews. Reason: controller-owned after fixed-package handoff. Impact: correction remains independently unaccepted. Completion blocker: yes for Task 11 approval.
- NOT RUN — Task 11 approval and product Task 12+ implementation. Reason: clean independent review and explicit user approval remain required. Impact: Task 12 remains blocked. Completion blocker: yes.

### 2026-09-23 表示の共通化とSSOT: 追補設計書を作成（実装は未着手）

- 内容: ユーザーの決定を受けて、`doc/design/2026-09-23-beaksight-ui-ssot-design.md`（UI追補設計書）と `doc/design/beaksight-shared-components.md`（共通部品台帳）を作成した。コードは変更していない。
- ユーザーの決定: (1) 表示言語は日本語。(2) 表示に関わるownerの追加を承認し、`doc/` 配下に文書として作成する。(3) UIの共通化は自動検査で確かめるが、検査は速さを要件にする（遅い検査は生産性を下げるので不可）。(4) 共通化候補 CC-001〜CC-012 は、別途開発指示があるまで保留。
- 判断（Ruling）: 表示に関わるownerを `src/presentation/`（catalog / format / messages）、`src/report/`（view-model / html-components / html-tokens）、`src/cli/exit-codes.ts` に置く。`src/presentation/**` は `src/core/**` と `src/config/types.ts` だけに依存する。理由は、Task 16（レポート）とTask 17（CLI）と設定エラーの文言が同じ定義を共有でき、表示の定義が監査処理の内部構造に依存しないため。誤っていた場合は、Task 16・17の設計の前に追補設計書を改訂する必要がある。
- 判断（Ruling）: UI Gate（GATE-UI01〜06）は `tests/architecture/ui-ssot.test.ts` に置き、1ファイル1秒以内、`fs` と正規表現だけで判定する。AST解析や外部ツールは使わない。誤っていた場合（近似の誤検知が多すぎる場合）は、除外一覧の追加で対処し、検査を重くはしない。
- 検証: 文書の作成のみのため、テストとビルドは実行していない。
- 次の作業: Task 11の独立レビューとユーザー承認を待つ。Task 12以降の設計では、UI追補設計書を前提にする。

### 2026-09-23 正式な開発指示と、作業開始時の基準の検証

- 内容: ユーザーから、実装計画・実装タスク指示・UI追補設計書・共通部品台帳に基づいてBeakSightを完成させるよう、正式な指示を受けた。記載の範囲はすべて承認済みとして扱ってよい。作業の順序は、Task 11の独立レビュー、Task 1〜10のレビューと必要な修正、共通化候補の計画と実施、Task 12以降の実装。本来の監査対象のサイトへのアクセスは機能完成まで禁止（Task 20・21の前で止め、ユーザーに確認する）。
- 検証: `npm run verify` を実行し、終了コード0。typecheck PASS、Vitest 26ファイル / 532テスト PASS（所要86.55秒）、build PASS。
- 次の作業: Task 11の仕様レビューと品質レビュー、Task 1〜5のレビュー、Task 6〜10のレビューを、読み取り専用のサブエージェント4体で並行して実施中。

### 2026-09-23 Task 1〜11 の独立レビュー結果と、基盤修正の設計

- 内容: 読み取り専用のレビュー担当4体が、Task 11（仕様・品質）、Task 1〜5、Task 6〜10 をレビューした。4つとも「修正が必要」。Critical 0、Important は合計15（Task 11: 仕様3・品質2、Task 1〜5: 4、Task 6〜10: 9。うち1件は Task 11 仕様の M3 と Task 6〜10 の V1 が同じ）。記録は `task-11-review-2026-09-23-spec.md`、`task-11-review-2026-09-23-quality.md`、`task-01-05-review-2026-09-23.md`、`task-06-10-review-2026-09-23.md`。
- 設計: `doc/design/2026-09-23-beaksight-foundation-corrections-design.md` と実装計画 `...-implementation-plan.md` を作成した。
- 判断（Ruling）: `session.close()` は、Guard が invalidation を経て終端に達した場合、factory と同じく reject する（9-20設計 §4.3 と実装タスク指示 第9章を優先）。誤っていた場合は、上位層の回収処理が reject を異常として扱う分の手間が増えるだけで、安全側に倒れる。
- 判断（Ruling）: 2026-09-22 にユーザーが brief で承認したクリーンアップの自動再試行（2回、期限付き）を、設計書 4.2 で正式な設計とし、9-20設計の該当箇所を置き換える。cleanup deadline 修正の RED と report が存在しない件は、取り戻せない記録の逸脱として扱い、今回のテストの存在と PASS を改めて検証する。
- 判断（Ruling）: 可視判定は Chromium 標準の `checkVisibility()` に統一する。祖先をたどる `visibility` の判定は誤りであるため。
- 判断（Ruling）: 共通化候補の実施時期を決めた。CC-001〜007、009、011 と CC-008 の可視判定は今回、CC-008 の discover-candidates 内の整理は Task 18 の後、CC-010・012 は Task 16・17。
- 判断（Ruling）: スキーマの版は 1.0 のまま拡張する。まだ artifact を出力したことがなく、1.0 の利用者がいないため。
- 次の作業: F01（共通部品の新設）を実装者に依頼した。

### 2026-09-23 F01・F02a・F02b・F02c 完了（共通部品の新設と移行）

- 内容: F01 で共通部品（`src/core/` の deadline・errors・guards・immutable・text・limits、`src/evidence/visibility.ts`、ids・contracts・normalize-url への追加）を新設した。F02a・F02b・F02c で、既存の重複を共通部品に置き換えた。各報告は `F01-report.md`、`F02a-report.md`、`F02b-report.md`、`F02c-report.md` にある。
- 判断（Ruling）: CC-001 のうち3か所（`awaitInitialRender`、`observeCloseUntil`、`drainGuardTasks`）は共通化しない。安全判定の、期限の境界での意味が変わるため（設計書 3.2）。
- 判断（Ruling）: 振る舞いの変化として、network-collector と isolated-auditor のエラーの文字列化を許容する（設計書 3.2）。代替文言は場所ごとに保った。
- 検証: `npm run verify` の終了コードは0。typecheck PASS、Vitest 33ファイル・605件 PASS、build PASS。
- 次の作業: F03（テスト補助の共通化）。その後、C1・C2・C4・C7 を並列で進める。C1・C2・C7 の指示書には、F02 の報告を受けた追加の指示を加えた。

### 2026-09-23 F03 完了（テスト補助の共通化）

- 内容: `tests/helpers/` に、テスト補助を4つ作った。12個のテストファイルの準備処理と後片付けを、それを使う形に置き換えた。報告は `F03-report.md` にある。
- 検証: 置き換えの前後とも33ファイル・605件が PASS した。テスト名の集合も一致した。typecheck も PASS した。
- 次の作業: C1・C2・C4・C7 を並行して起動する。`layout-accessibility.test.ts` の競合を避けるため、C7 には、新しいテストファイルを使うよう指示した。

### 2026-09-23 C1・C2・C4・C7 完了（第4段）

- 内容: C1（設定・クロール）、C2（安全まわり）、C4（スクロールと収集位置）、C7（performance・network・console・axe）が完了した。報告は、作業記録置き場の各 `*-report.md` にある。
- 検証: C7 の完了時点で、テスト全体が36ファイル・760件 PASS した。typecheck も PASS した。
- 判断（Ruling）: C2 の実装者が判断した3点を承認した（長すぎる文字列は件数を数えるだけにする、Passive のダウンロードも取り消す、違反の件数がない場合は ABORTED_BY_SAFETY にする）。
- 判断（Ruling）: C4 の発見事項6（内側の div だけがスクロールするページで、偽の COMPLETE になる）に対して、C4b を加える。内側のスクロール領域を検出したら PARTIAL を返す。
- 判断（Ruling）: C7 の報告を受けて、CC-007 の方針を改訂した。`limits.ts` に、Evidence の収集の上限も置く。
- 次の作業: C3・C4b・C5 を並行して起動する。

### 2026-09-23 C3・C4b・C5・C5b・C6 完了（第5〜6段）

- 内容: C3（Task 11 の修正）、C4b（内側のスクロール領域の検出）、C5（可視判定と DOM の Evidence）、C5b（display:contents と見出し）、C6（layout の Evidence と性能）が完了した。報告は、作業記録置き場の各 `*-report.md` にある。
- 判断（Ruling）: 可視判定のオプション `contentVisibilityAuto` を false に改めた（C5 の発見事項。F04 で値を変更する）。
- 判断（Ruling）: `display: contents` の要素の visibility の扱いを承認した（C5b）。
- 判断（Ruling）: CC-007 の上限値の置き場所を明確にした。複数の collector で共有する上限は `limits.ts`、1つの collector だけが使う上限はその collector に置く。
- 判断（Ruling）: 大きさ0の Interaction 候補を visible=false にしてよいことを承認した。
- 判断（Ruling）: 描画プロセスが落ちるページ（入れ子の深いページ）は、Task 14 で FAILED として扱う。
- 検証: `npm run verify` の終了コードは0。typecheck PASS、Vitest 37ファイル・851件 PASS、build PASS。
- 次の作業: F04（小さな整理と、可視判定のオプションの値の変更）を単独で進める。その後、C8（型とスキーマの整備）を進める。

### 2026-09-23 F04・C8 完了、DEF-001 の登録、設計者の手順の誤り

- 内容:
  - F04（小さな整理、可視判定のオプションの値の変更）と C8（型とスキーマの整備）が完了した。C8 の完了時点で、`npm run verify` は 38ファイル・967件が PASS した。
  - C8 の実装者が、既存の不具合を見つけた。axe を実行すると、Passive Context が安全違反として閉じられる。これを DEF-001 として台帳に登録し、設計書 8.1 で修正の方針を決めた。
- 設計者の手順の誤り:
  - 何が起きたか: DEF-001 と F05 の指示書を書き出すスクリプトが、シェルの引用符の誤りで失敗した。それに気づかないまま、実装者を2人起動した。
  - 実害の有無: 2人とも指示書がないことを確かめ、何も変更せずに Blocker として停止した。実害はない。
  - 対応: 指示書を書き出し、ファイルがあることを確かめてから、2人を起動し直した。
  - 再発の防止: スクリプトは、先にファイルに書いてから実行する。指示書のファイルがあることを確かめてから、実装者を起動する。
- 次の作業: DEF-001 と F05 の完了を待つ。その後、独立レビューの R（Task 11 の仕様と品質、Task 1〜10 の修正全体）を行う。

### 2026-09-23 DEF-001・F05・DEF-001b 完了（基盤修正の実装がすべて完了）

- 内容:
  - DEF-001（axe をレガシーの方式で実行する）を完了した。
  - F05（型の定義元を1か所にする。Run Status の入力を構造化する）を完了した。
  - DEF-001b（accessibility の Evidence に `frameScope` を加える。`INTERACTION_HREF_KINDS` を加える）を完了した。
  - これで、基盤修正の実装計画の実装のサブタスクは、すべて完了した。
- 検証: `npm run verify` の終了コードは0。typecheck PASS、Vitest 39ファイル・1022件 PASS、build PASS。
- 次の作業: 独立レビュー R を行う。担当は4人で、Task 11 の仕様、Task 11 の品質、Task 1〜5 と型・スキーマ、Task 6〜10 を分担し、並行して進める。

### 2026-09-23 独立レビュー R1〜R4 の結果

- 結果:
  - R1（Task 11 の仕様）: 承認。Minor 3件。
  - R2（Task 11 の品質）: 修正が必要。Important 1件（内側の要素がスクロールするページで、何もしないボタンが VERIFIED になる）、Minor 3件。
  - R3（Task 1〜5 と型・スキーマ）: 承認。Minor 7件。
  - R4（Task 6〜10）: 修正が必要。Important 2件（body の余白によって偽の COMPLETE になる、form の外の入力欄が記録されない）、Minor 4件。V13 が未解消。
- 判断（Ruling）:
  - R2 の N1 に対応するため、設計書 4.4 を改訂した。座標を補正するのをやめ、変化を観測する前に、対象を画面内にスクロールしておく。
  - V13 が漏れていたのは、設計者の割り当ての漏れである。F08 に含めた。
- 次の作業:
  - F06（Interaction）と F07（型・スキーマ・設定・Link）を並行して進める。
  - その後に F08（スクロールの対象、form の外の入力欄、ほか）を進める。
  - 最後に、修正箇所の確認のレビュー R' を行う。

### 2026-09-23 F06・F06b・F06c・F07・F08 完了（再レビューの指摘の修正）

- 内容: 再レビュー R1〜R4 の指摘を修正した。
  - F06・F06b・F06c: Interaction の修正。凍結の前に、対象を画面内にスクロールしておく。
  - F07: 型・スキーマ・設定・Link の修正。
  - F08: スクロールする対象の決め方、form の外の入力欄、V13 など。
- 判断（Ruling）:
  - 設計書 4.4 を再改訂した（選択肢 A: 凍結の前に下準備をする）。
  - Link の入口を `discoverLinks()` の1つにした。
  - 文書をたどった後に、内側の領域を調べる走査が上限に達しても、COMPLETE のままにする。上限に達したことは、Evidence に記録する。
- 検証: `npm run verify` の終了コードは0。typecheck PASS、Vitest 39ファイル・1124件 PASS、build PASS。
- 次の作業: 修正を確認するレビュー R'1（Interaction）と R'2（型・collector）を並行して進める。どちらも Critical 0・Important 0 なら、Task 11 のチェックポイントを通過したとして、Task 12 に進む。

### 2026-09-23 F09〜F12 完了（確認のレビューの指摘の修正）

- 内容:
  - F09: R'2 の指摘を修正した。スクロールの対象を測り直す。scroll の Evidence を加える。shadow root の中も走査する。Link を1か所だけに格納する。設定の検証を直す。
  - F10: R'1 の指摘を修正した。click のときにスクロールが起きた場合は、位置の変化を根拠にしない。
  - F11: scroll の観測の件数に上限を設けた。理由の一覧を1か所にそろえた。
  - F12: スキーマの enum の59件を、core の配列と1対1に対応させた。一致の確認は1つのテストで行う（約0.24秒）。
- 検証: `npm run verify` の終了コードは0。typecheck は PASS、Vitest は40ファイル・1275件が PASS、build も PASS。
- 次の作業: F09〜F12 について、最後の確認のレビュー（R''1、R''2）を行う。

### 2026-09-23 F13・F13b・F13c・F14・F14b 完了（最後の確認のレビューの指摘の修正）

- 内容:
  - F13: 設定の locale と timezone の検証、Evidence の ID の接頭辞をスキーマの分岐ごとに限る、DOM の文書の項目ごとの切り詰めの印、を直した。
  - F13b・F13c: timezone の判定を、Chromium が受け付ける値とそろえた。
  - F14: 対象の平行移動だけの変化を、VERIFIED の根拠にしないようにした。
  - F14b: 失敗の理由の整形を、1つの関数にまとめた。
- 判断（Ruling）:
  - 位置の変化による偽の VERIFIED が3回続いたので、場合を1つずつ塞ぐのをやめた。平行移動は根拠にしないという方針に改めた（設計書 4.4.1）。
  - 自分の位置を動かすことだけが効果のボタンは、NOT_VERIFIABLE になる。これは正直な結果として許容する。
- 検証: `npm run verify` の終了コードは0。typecheck は PASS、Vitest は41ファイル・1360件が PASS、build も PASS。
- 次の作業: 最後の確認のレビュー R''' を行う。Critical 0・Important 0 なら、Task 11 のチェックポイントを通過とし、Task 12 に進む。

### 2026-09-23 F15 完了、R5 の結果、F16 に着手

- 内容: F15 を完了した。対象の位置と大きさの変化だけでは VERIFIED の根拠にしない。対象自身の属性の変化を根拠に加える。下準備で hover する。検証の結果は、1395件がすべて PASS だった。
- R5 の結果: 修正が必要（Important 3件）。
  - タイマーや hover intent で起きる属性の変化で、VERIFIED になってしまう。
  - `<details>` が NOT_VERIFIABLE になる。
  - focus や ripple で付く class で、VERIFIED になってしまう。
- 判断（Ruling）: 設計書 4.4.1 に次の4つを加え、F16 で実装する。
  - focus: 下準備で、hover に加えて focus もする。
  - 安定性の確認: 凍結の前に一定の時間観測し、その間に変わった項目は根拠にしない。
  - 持続の確認: click の後の変化は、一定の時間続いた場合だけ根拠にする。
  - `<details>`: 親の `details` の `open` を、開閉の状態として扱う。
- 判断（Ruling）: 対象の外の要素（親、body）の属性だけを切り替える部品は、NOT_VERIFIABLE とする。これは制約として許容する（設計書 4.4.4）。
- 所見: Interaction の検証の方式の修正が、6回続いている。どれも偽の VERIFIED、つまり偽の完了を防ぐための修正なので、続ける。
- 次の作業: F16 が完了したら、確認のレビューを行う。Critical 0・Important 0 なら、Task 11 のチェックポイントを通過とし、T12a に進む。

### 2026-09-24 F16・F17・F17b 完了

- 内容:
  - F16: 下準備で focus する。安定性の確認と持続の確認を加える。`<details>` の開閉を記録する。hover の後の状態を目印にする。変わった属性の名前を残す。理由の整形を直す。
  - F17: Interaction の期限の下限を設ける。変わった属性の名前を切り捨てたことを記録する。
  - F17b: 時間の定数を `src/core/limits.ts` に移す。スキーマの下限を定数とそろえる。
- 検証: `npm run verify` は終了コード0で終わった。typecheck は PASS、Vitest は41ファイル・1473件がすべて PASS、build も PASS。
- 次の作業: 確認のレビュー R6（F16・F17・F17b）を行う。

### 2026-09-24 F18 完了、R6 の結果と収束の方針

- R6 の結果: 修正が必要（Important 2件）。1件目は、CSS の変数を残す ripple で偽の VERIFIED になるもの。2件目は、読み込みの時間が Interaction の期限を食うもの。
- F18: R6 の I-1・I-2・M-2・M-3・M-4 を直した。`npm run verify` は PASS した（1519件）。
- 判断（Ruling）: Interaction の検証は推定であるため、収束のための判定基準を決め、`R-review-common.md` に書いた。
  - Important 以上にするのは、次の2つに限る。
    - 設計書の方針に反する、明確な欠陥
    - よく使われる部品で起きる、偽の VERIFIED、または安全の後退
  - まれな場合は、設計書 4.4.4 の制約として受け入れる。
- 次の作業: 確認のレビュー R7 を行う。

### 2026-09-24 R7 の結果と F19 の起動

- R7 の結果: 修正が必要（Important 1件、Minor 3件）。R6 の指摘は、すべて解消した。
- 判断: tooltip や入力の種類を表す属性（`aria-describedby`、`data-state`、`data-focus-visible` など）の変化は、根拠にしない。設計書 4.4.1 を更新した。
- 設計書 4.4.4 に、ripple の制約と、type のない button の網羅の限界を書き加えた。
- Task 14 の設計書 4.3.1 に、`deadlineAtMs` の決め方を書き加えた。
- F19（Important-1 と Minor-3 の修正）を起動した。

### 2026-09-24 F19 完了

- tooltip や入力の種類を表す10個の属性の変化を、根拠から外した。あわせて Minor-3 を直した。`npm run verify` は PASS した（1537件）。
- 共通部品台帳に `INTERACTION_NON_EVIDENCE_ATTRIBUTES` を追記した。
- 次の作業: 確認のレビュー R8 を行う。Task 11 のチェックポイントの判定を兼ねる。

### 2026-09-24 R8 の結果と F20 の起動

- R8 の結果: 修正が必要（Important 2件、Minor 1件）。R7 の指摘は解消した。
- 判断
  - `data-headlessui-state` と、名前に `focus` か `hover` を含む `data-*` 属性と class の名前を、根拠にしない。
  - `role="tab"` を明示した要素には、下準備の focus をしない。それ以外で focus によって状態が変わった場合は、区別できる理由の NOT_VERIFIABLE にする。
  - 設計書 4.4.1、4.4.2、4.4.4 を更新した。
- F20 を起動した。

### 2026-09-24 セッションの再開

- セッションを再開し、beaksight-dev スキルが登録されたことを確かめた。
- 前のセッションの終了で止まった F20 の実装者に、作業の再開を依頼した。作業ツリーの現在の状態を確かめてから、続きを行う。

### 2026-09-24 F20 の Blocker と F20b の起動

- F20 は実装を終えたが、`passive-request-guard.test.ts` の偽の handle が属性の記録を返さないため、2件が失敗して Blocker になった。
- 判断
  - 偽の handle を、本物の記録の形に合わせて直す。
  - あわせて、長い class を class 専用の上限（4096文字）で記録し、切り詰められた可能性がある場合は fail-closed にする。
  - 設計書 4.4.1 を更新した。
- F20b を起動した。

### 2026-09-24 F20b 完了

- F20 の Blocker を解消した。あわせて、長い class を class 専用の上限（4096文字）で記録し、比べられない場合は fail-closed にした。
- 実装者の報告では、`npm run verify` が PASS した（1587件）。設計者も `npm run verify` を実行し直して確かめる。
- 共通部品台帳を更新した。
- 次の作業: 確認のレビュー R9 を行う。

### 2026-09-24 設計者による検証と R9 の起動

- 設計者が `npm run verify` を実行し直した。typecheck、41ファイル・1587件のテスト、build がすべて PASS し、終了コードは0だった（テストの所要時間は約283秒）。
- 確認のレビュー R9 を起動した。

### 2026-09-24 R9 の結果と F21 の起動

- R9 の結果: 修正が必要（Important 1件、Minor 1件）。R8 の指摘は、すべて解消した。
- Important-1: tab に focus をしないため、roving tabindex などの属性の変化が差に出る。その結果、選ばれているタブを押すと偽の VERIFIED になる。
- 判断:
  - 明示した tab では、属性の変化を根拠にしない。設計書 4.4.1 を更新した。
  - Minor-1（理由の文字列の取り違え）は、受け入れる。
- F21 を起動した。

### 2026-09-24 F21 完了

- 明示した tab では、ARIA の状態の属性以外の属性の変化を、根拠にしないようにした。
- 実装者の報告では、`npm run verify` が PASS した（1602件）。設計者も `npm run verify` を実行し直して確かめる。
- 実装者の判断2件を承認した。設計書 4.4.1 に書き加えた。
- 次の作業: 確認のレビュー R10 を行う。

### 2026-09-24 設計者による F21 の検証と R10 の起動

- 設計者が `npm run verify` を実行し直した。結果は PASS（終了コード0）。テストは41ファイル・1602件で、所要時間は約301秒だった。
- 確認のレビュー R10 を起動した。

### 2026-09-24 Task 11 のチェックポイントを通過、T12a を起動

- R10 の結果: 承認（Critical 0、Important 0、Minor 2）。これで Task 11 のチェックポイントを通過した。
- 次の Task に進むことについて:
  - ユーザーの正式な開発指示に、「記載の範囲においては全て、私の承認済として扱ってよい」とある。
  - そのため、チェックポイントの後のユーザーの承認は得たものとして進める。
- Minor の扱い:
  - Minor-1 は、設計書 4.4.4 の制約に加えた。
  - Minor-2 は、F22 として登録した。F22 では、Bootstrap、MUI、Headless UI の形のタブの回帰テストを加える。Task 13 の後、Task 14 の前に行う。
- 次の作業:
  - T12a（Rule の契約、Rule Catalog、Rule Engine）を起動した。
  - T12a が終わったら、T12b、T12c、T12d、T13 を並行で起動する。起動の前に、それぞれが変更するファイルが重ならないことを確かめる。

### 2026-09-24 T12a 完了、T12a2 を起動

- T12a: Rule の契約、`RULE_CATALOG`、`RuleEngine` を作った。`npm run verify` は PASS した（1617件）。
- 判断:
  - ビューポートを予約名 `viewport` の同一性の要素として、fingerprint に含める方法を承認した。
  - 下書きの ruleId が Rule の ruleId と一致するかを検査するため、`ruleIdPrefix` を加える。
  - Cross-page rule と Page rule で、下書きから Finding への変換が重複しないよう、`materializeFindingDrafts` に共通化する。
  - 設計書 第6章を更新した。T12b〜T13 の指示書も、T12a2 の後の型を前提にするよう更新した。
- T12a2 を起動した。
- T12a2 の後に、T12b、T12c、T12d、T13 を並行で起動する。変更するファイルは、それぞれの Rule のファイルとテストだけで、重ならない。build も実行しないので、dist を取り合うこともない。

### 2026-09-24 T12a2 完了

- `materializeFindingDrafts` に、下書きを Finding に変える処理をまとめた。あわせて、`ruleIdPrefix` と ruleId の決まりを加えた。
- 実装者の報告では、`npm run verify` が PASS した（1631件）。
- 実装者の判断4件を承認した。共通部品台帳に、Rule の契約と Catalog を登録した。
- 次の作業: T12b、T12c、T12d、T13 を並行で起動する。

### 2026-09-24 T12d の Blocker と、その対応の決定

- T12d は Blocker で止まった。Safety の Evidence の種類がまだない。加えるには、範囲外の `ids.ts` とスキーマの見本のテストも変える必要があった。ファイルは変更していない。
- 判断:
  - 選択肢 B を採る。前段のサブタスク T12d0 で、Evidence の種類 `safety` を加える。
    - 事象の型の定義を core にまとめ、Ledger の型はその別名にする。
    - 除外理由の一覧も core に移す。
  - Rule の設計書 5.4.1 に、次のことを決めた。
    - Evidence の単位（Ledger ごと）と中身（違反は含めない）
    - Rule との対応（凍結中の GET とナビゲーションは Finding にしない）
    - 件数の数え方
  - Task 14 の設計書 4.3 にも書き加えた。
  - T12d の指示書を、T12d0 の後の型を前提に書き直した。
- 実行の順序:
  - T12d0 は core の型を変える。このため、並行して実行中の T12b、T12c、T13 がすべて終わってから起動する。
  - T12d0 の後に、T12d を起動する。

### 2026-09-24 T12b（一部完了）と、2つの Rule の移動

- T12b では、20個の Rule を実装し、登録した。担当のテスト46件は PASS した。
- `NAVIGATION_TIMEOUT` と `UNEXPECTED_ORIGIN_REDIRECT` は、Blocker になった。
- 判断:
  - 2つの Rule を、Cross-page rule に移す。どちらも、ナビゲーションの結果と許可Originから判断するため。
  - Rule の設計書 5.1 と第7章、Task 14 の設計書 4.3.0 を更新した。
  - T13 の後に、T13b で実装する。
- 実装者の判断4件を承認した。
- 残る確認: SVG 画像の `naturalWidth` の確認を、Task 14 の統合テストの確認項目に加えた。

### 2026-09-24 T13 完了

- T13: Cross-page rule 9件を実装し、`CROSS_PAGE_RULES` に登録した。担当のテスト26件は PASS した。
- 実装者の判断5件を承認した。
- 次の2つは、T13b で直す。
  - Rule の例外の封じ込め。例外を失敗に変える関数を共通化して使う。
  - sitemap の型を core に移すこと。
- 実行の順序:
  - T12c が終わるのを待つ。
  - T12c の後に、T12d0 を起動する。T12d0 は、core の型を変える。
  - T12d0 の後に、T12d と T13b を並行で起動する。両者が変更するファイルは重ならない。

### 2026-09-24 T12c 完了、T12d0 と T12e を起動

- T12c: layout 9個、accessibility 2個、performance 5個の Rule を実装した。担当のテスト57件と `npm run typecheck` は PASS した。
- 判断:
  - レスポンシブの幅ごとの結果にも、layout の5つの Rule を当てはめる（上位の設計書 14.9）。T12e で行う。
  - 共通化の候補を、CC-013 として登録した。T12f で行う。
    - Evidence を取り出す処理を、`rule-helpers.ts` にまとめる。
    - 数値の書式を、`presentation/format.ts` にまとめる。
  - Rule の設計書に 5.1.1 を加えた。
- T12d0（Safety の Evidence）と T12e（幅ごとの結果）を、並行で起動した。変更するファイルは重ならない。
- 次の作業:
  - T12d0 の後に、T12d と T13b を起動する。
  - その後に、T12f を行う。
  - 最後に、設計者が `npm run verify` を実行し、Task 12・13 のレビューを行う。

### 2026-09-24 T12e 完了

- layout の5つの Rule が、レスポンシブの幅ごとの結果も判定するようになった。担当のテスト36件は PASS した。
- 実装者の判断1件を承認した。
- T12d0 の完了を待っている。

### 2026-09-24 T12d0 完了、T12d と T13b を起動

- T12d0 で、Evidence の種類 `safety` を加えた。`npm run verify` は PASS した（1819件）。
- 発見事項を、CC-014（Task 14 で行う）と CC-015（Task 15 で行う）として登録した。
- T12d（Safety の Rule）と T13b（2つの Rule の移動、例外の封じ込め、sitemap の型の移動）を、並行で起動した。変更するファイルは重ならない。

### 2026-09-24 T12d 完了（型チェックは T13b の後に確かめる）

- Safety の Rule 7つを実装し、担当のテスト24件は PASS した。
- `npm run typecheck` のエラーは1件で、T13b が作業中のテストファイルから出ている。
- 判断:
  - scope では絞らず、項目ごとに数える方法を承認した。設計書 5.4.1 を直した。
  - 重複を除いて並べる処理を、CC-013 に加えた。

### 2026-09-24 T13b 完了、T12f を起動

- T13b で、`NAVIGATION_TIMEOUT` と `UNEXPECTED_ORIGIN_REDIRECT` を Cross-page rule として登録した。あわせて、Rule の例外の封じ込めと、sitemap の型の core への移動を終えた。担当のテスト61件は PASS した。
- 設計者が `npm run typecheck` を実行し、PASS を確かめた。すべての並行作業が終わった後の状態である。
- 判断:
  - ナビゲーションの結果の種類を、Task 14 で `ViewportAuditResult` に加える。ナビゲーションが失敗した場合も、network の Evidence を記録する。この2つを、Task 14 の設計書 4.3.0 に書いた。
  - `INCONSISTENT_ORIGIN` を、canonical だけに絞る。Rule の設計書 第7章を直した。
- T12f を起動した。内容は次の3つである。
  - CC-013（`rule-helpers.ts` と `presentation/format.ts`）
  - 比較の関数の export
  - `INCONSISTENT_ORIGIN` の整理

### 2026-09-24 T12f 完了（CC-013 完了）

- `rule-helpers.ts` と `presentation/format.ts` に、補助処理をまとめた。
- `INCONSISTENT_ORIGIN` を、canonical だけを判定するように絞った。
- 実装者の報告では、`npm run verify` が PASS した（1864件）。
- 実装者の判断3件を承認した。
- 発見事項を CC-016 として登録した。Task 16 で行う。
- 共通部品台帳を更新した。
- 次の作業:
  - 設計者が `npm run verify` を実行し直す。
  - その後、Task 12・13 の独立レビューを行う。

### 2026-09-24 Task 14 の設計の追補と実装計画

- 着手前の調査で、15件の障害を見つけた。主なものは次のとおり。
  - 戻り値の形が合わない。
  - 処理の順序が矛盾している。
  - 採番器と、状態の集計の関数がない。
  - 期限の配り方が決まっていない。
- 判断: Task 14〜17 の設計書に 4.5 を加え、次のことを決めた。
  - `audit(url, pageId)` で、両方のビューポートを扱う。
  - Interaction を、Rule の評価の前に行う。
  - `IdAllocator` を作る。
  - ナビゲーションの結果の判定の規則
  - `PAGE_AUDIT_STAGES` と `COLLECTOR_INCOMPLETE` の `detail`
  - 幅の走査は Desktop で1回だけ行い、主要な幅を除く。
  - 段階ごとの期限と、Interaction の予算
  - 後片付けの失敗の扱い
- 実装計画 `doc/design/2026-09-24-beaksight-task-14-implementation-plan.md` を書いた。サブタスクは P14a〜P14d で、この順に行う。
- P14a は、RT12 の結果を見てから起動する。P14a は `cross-page-rules.ts` の型の別名を変えるので、RT12 の指摘の修正と重ならないようにするためである。

### 2026-09-24 RT12 の結果と修正の起動

- RT12（Task 12・13 の独立レビュー）の結果は、修正が必要（Important 5件、Minor 4件）だった。
- 判断:
  - layout の誤検知3件は、collector の Evidence に事実を足して直す。足す事実は、切り取る祖先、テキストの境界のまたぎ、描画された子孫である。
  - 1つの事実から作る Finding は、1つだけにする。
  - canonical の比較で、最終URLも見る。
  - Engine の検査を増やす。
  - テストを足す。
  - sitemap の切り詰めは、Task 15 で扱う。
- 設計書を更新した。更新したのは、Rule の設計書の 5.1.2 と第7章、Task 14〜17 の設計書の 5.1 である。
- RT12a（layout）と RT12b（Cross-page、Engine、technical のテスト、スキーマ）を、並行で起動した。変更するファイルは重ならない。
- 2つが終わったら、設計者が `npm run verify` を実行し、確認のレビューを行う。その後で、P14a を起動する。

### 2026-09-24 RT12b 完了

- 次の指摘を直した。担当のテスト454件は PASS した。
  - I4（1つの事実から1つの Finding）
  - I5（ビューポートのテスト）
  - M7（canonical の比較）
  - M8（検査）
  - M9（スキーマと定数）
- 判断: `isLinkTargetVerified` の条件を、`navigationOutcome` を使う形に変える。P14a で行う。共通部品台帳を更新した。
- RT12a の完了を待っている。

### 2026-09-24 RT12a 完了、RT12c を起動

- layout の誤検知3件（I1〜I3）と、しきい値のテスト（M6）を直した。担当のテスト474件は PASS した。
- 実装者の判断3件を承認した。
  - 横にはみ出す祖先だけを除く。
  - `kind` と、走査の上限を加える。
  - ruleVersion は 1 のままにする。
- 設計書と共通部品台帳を更新した。
- 実装者が発見事項として挙げたものを、Important とした。body に `overflow-x:hidden` を付けたページでも、`DOCUMENT_HORIZONTAL_OVERFLOW` が誤って出る。RT12c で直す。
- 次の作業:
  - RT12c の後に、設計者が `npm run verify` を実行する。
  - その後で、RT12 の確認のレビューを行う。

### 2026-09-24 RT12c 完了

- body に `overflow-x:hidden` を付けたページで、`DOCUMENT_HORIZONTAL_OVERFLOW` が誤って出る問題を直した。実装者の報告では、`npm run verify` が PASS した（1927件）。
- 実装者の判断3件を承認した。そのうち1件は、制約として設計書に書いた。
- 設計者は、`npm run verify` を実行し直している。その後で、確認のレビュー RT12r を行う。

### 2026-09-24 設計者による検証と RT12r の起動

- 設計者が `npm run verify` を実行し直した。結果は PASS（終了コード0）。テストは51ファイル・1927件で、build も通った。
- 確認のレビュー RT12r を起動した。

### 2026-09-24 RT12r の結果と RT12d の起動

- RT12r の結果: 修正が必要（Important 2件、Minor 3件）。Cross-page と Engine の修正は、解消した。
- 判断:
  - N1: 見切れの判定を改める。改める点は次の3つである。
    - 4分の1の割合を超えてまたぐ場合だけ、見切れとする。
    - 縦に丸ごと隠れた行も数える。
    - 見える行がない箱は、判定しない。
  - N2: 切り取る祖先の中の、幅の広い画像は、制約として受け入れる。
  - N3〜N5: 直す。
- 設計書 5.1.2 を更新した。RT12d を起動した。

### 2026-09-24 RT12d 完了、RT12e を起動

- RT12d で、N1・N3・N4・N5 を直した。実装者の報告では、`npm run verify` が PASS した（1937件）。
- 判断:
  - 表と埋め込みを覆う固定要素の Finding は、受け入れる。
  - 横方向の見切れのしきい値は、2 px の固定の値にする。RT12e で行う。
  - 設計書 5.1.2 を更新した。
- RT12e の後に、RT12d と RT12e をまとめて確認のレビューにかける（RT12r2）。

### 2026-09-24 RT12e 完了

- 横方向の見切れのしきい値を、2 px にした。実装者の報告では、`npm run verify` が PASS した（1939件）。
- 発見事項（コメントが古い）は、P14a の指示書に加えた。
- 次の作業:
  - 設計者が `npm run verify` を実行し直す。
  - その後、確認のレビュー RT12r2 を行う。

### 2026-09-24 設計者による検証と RT12r2 の起動

- 設計者が `npm run verify` を実行し直した。結果は PASS（終了コード0）。テストは51ファイル・1939件で、build も通った。
- 確認のレビュー RT12r2 を起動した。

### 2026-09-24 RT12r2 の結果と RT12f の起動

- RT12r2 の結果: 修正が必要（Important 1件、Minor 3件）。N3〜N5 は解消した。
- 判断:
  - I1: 見切れの判定で、上と下を別々に比べる。
  - M1: 見えない子孫のテキストを、判定から除く。意図して隠した形は、制約とする。
  - M2: 画面の外に置いた子孫を、描画された子孫として数えない。
  - M3: 制約とする。
- 設計書 5.1.2 を更新した。RT12f を起動した。

### 2026-09-24 P14a を、RT12f と並行で起動

- 変更するファイルは重ならない。
- 全体のテストが途中の状態を含むので、P14a では verify を実行しない。設計者が、2つの作業の後に実行する。

### 2026-09-24 RT12f 完了（verify は P14a の後に確かめる）

- 見切れの判定で、上下を片側ずつ比べるようにした。あわせて、見えないテキストと、画面の外の子孫の扱いを直した。layout のテストは PASS した。
- verify の失敗は、並行して作業中の P14a の途中の状態によるものである。
- 反省: 指示書に「単独で実行する」と書いたサブタスクと並行して、別のサブタスクを起動した。今後は、並行にするときは、両方の指示書に並行であることを書く。

### 2026-09-24 P14a 完了（CC-014 完了）

- Task 14 の土台を作った。作ったものは次のとおりである。
  - 型: ナビゲーションの結果、`PAGE_AUDIT_STAGES`、`PageAuditOutcome`
  - 関数: 状態の集計、Safety の集計
  - 定数
  - 時間の設定の整数化
  - `IdAllocator`
  - CC-014
- 担当のテスト1005件と typecheck は PASS した。
- 実装者の判断5件を承認した。設計書の 4.2 と 4.5.7 を直した。共通部品台帳を更新した。
- 設計者は、RT12f と P14a の後の全体の `npm run verify` を実行している。

### 2026-09-24 全体の検証と、RT12r3・P14b の起動

- 設計者が `npm run verify` を実行した。RT12f と P14a の後の状態である。結果は PASS（終了コード0）。テストは52ファイル・2051件で、build も通った。
- RT12f の確認のレビュー RT12r3 と、P14b を、並行で起動した。
  - RT12r3 は、読み取り専用である。
  - P14b は、新しいファイルだけを作る。
  - 両方の指示書に、並行であることを書いた。

### 2026-09-24 Task 12・13 完了（RT12r3 承認）

- RT12r3 の結果は、承認（Critical 0、Important 0、Minor 2）だった。これで Task 12・13 を完了とする。
- Minor の2件は、RT12g で直す。
  - m1: 画面の外の子孫の扱いを、候補が文書の中にある場合に限る。
  - m2: テストに、Windows のフォントが前提であることを注記する。
- 設計書 5.1.2 を更新した。
- RT12g を、P14b と並行で起動した。変更するファイルは重ならない。両方の指示書に、並行であることを書いた。

### 2026-09-24 P14b 完了

- 次の4つの部品を作った。新しいテスト55件と typecheck は PASS した。
  - `navigatePage`
  - `createStressSessionFactory`
  - `createEvidenceRecord`
  - `stageDeadline`
- 発見事項への判断:
  - 期限切れの判定の重複を、CC-017 として登録した。実施は、Task 14 のチェックポイントの後である。
  - ID の接頭辞の表の不具合を、DEF-002 として登録した。
  - Ledger の上限の件は、受け入れる。
- 次の作業:
  - RT12g の後に、設計者が verify を実行する。
  - その後、P14c と DEF-002 を並行で起動する。

### 2026-09-24 RT12g の Blocker と、設計の修正

- Blocker の内容: 設計書の「文書の中」の定義（右端と下端が 0 より大きい）では、大きさ0の候補が文書の端（座標 0）にある場合を区別できない。そのため、m1 と、既存の M2 のテストを両立できない。
- 判断: 選択肢 A を採った。「文書の外」は、次のどちらかが成り立つ場合とする。設計書 5.1.2 を直した。
  - 左端が負で、かつ右端が 0 以下である。
  - 上端が負で、かつ下端が 0 以下である。
- 同じ実装者に、続きを依頼した。

### 2026-09-24 RT12g 完了

- 選択肢 A の定義で、m1 を直した。m2 の注記も入れた。layout のテスト84件は PASS した。
- これで、Task 12・13 のレビューの修正は、すべて終わった。
- 設計者が、全体の verify を実行している。その後、P14c と DEF-002 を並行で起動する。

### 2026-09-24 全体の検証と、P14c・DEF-002 の起動

- 設計者が `npm run verify` を実行した。結果は PASS（終了コード0）。テストは56ファイル・2108件で、build も通った。
- P14c（Passive の段階の Page Auditor）と DEF-002（ID の接頭辞の表の不具合）を、並行で起動した。
  - 両方の指示書に、並行であることを書いた。
  - 変更するファイルは重ならない。

### 2026-09-24 DEF-002 完了

- ID の接頭辞の表と、`validateArtifact` のスキーマ名の表の不具合を直した。どちらも、継承したプロパティ名を受け付けていた。テストは、全体の2119件が PASS した。
- 同じ形の書き方が、`interactionRejectionLedgerRecord` にも残っていた。これを DEF-003 として登録した。Task 14 のチェックポイントの後に、CC-017 と一緒に直す。
- P14c の完了を待っている。

### 2026-09-24 P14c 完了

- `PageAuditor` の Passive の段階を作った。統合テスト19件と typecheck は PASS した。
- 大きさの指定のない SVG 画像で、誤検知は出なかった。これは、T12b の未確認事項を確かめたものである。
- 実装者の判断8件のうち、7件を承認した。
- crash の理由のコードは、`PAGE_CRASHED` を加えて直す（P14d）。
- 設計書の 4.5.4、4.5.5、第6章を更新した。
- 閉じる処理の重複を、CC-018 として登録した。CC-017 と DEF-003 と、同じサブタスクで行う。
- 設計者は、全体の verify を実行している。その後、P14d を起動する。

### 2026-09-24 P14d 完了（Task 14 の実装を完了）

- Interaction の段階と、`PAGE_CRASHED` を加えた。実装者の報告では、`npm run verify` が PASS した（2148件）。
- 判断:
  - 候補ごとの結果では、ビューポートの状態を変えない。
  - Run Status への反映は、Task 15 で `NOT_VERIFIABLE` を2種類に分けて扱う（設計書 5.4.1）。
    - 確かめる作業ができなかったもの: 未確認の作業とする。
    - 確かめたが、変化が見えなかったもの: 結果とする。
    - この区別のために、Interaction の Evidence に、構造化した理由のコードを加える。Task 15 の前に、サブタスクとして行う。
  - 定数の移動と、コメントの修正は、チェックポイントの後の整理のサブタスクに加えた。
- 次の作業:
  - 設計者が verify を実行する。
  - その後、Task 14 のチェックポイントの独立レビュー R14 を行う。

### 2026-09-24 R14 の結果と P14e の起動

- 設計者が `npm run verify` を実行した。結果は PASS（58ファイル、2148件）。
- R14（Task 14 のチェックポイント）の結果: 修正が必要（Important 2件、Minor 4件）。
  - 安全の性質、ID の一意性、後片付けは、問題がないと確かめられた。
  - I1: 期限のない段階が、止まったページで戻らない。
  - I2: 構築に失敗した Context の Ledger が、集計から漏れる。
- 判断:
  - 全段階をページの期限まで待つ。期限を過ぎたら `DEADLINE_EXCEEDED` を記録し、Context を閉じる。
  - 構築に失敗した Context の Ledger も、集計に含める。
  - m1（crash）、m2（設定の検証）、m4（テスト）も直す。
  - m3（台帳）は、設計者が更新した。
- 設計書の 4.3 と 4.5.7 を更新した。P14e を起動した。

### 2026-09-24 P14e 完了

- R14 の I1、I2、m2、m4 を直した。m1 は一部を確かめた。実装者の報告では、`npm run verify` が PASS した（2159件）。
- 実装者の判断3件を承認した。
- 発見事項（読み込みの途中の crash、スキーマの表現）を、設計書に反映した。
- 共通部品台帳を更新した。
- 次の作業:
  - 設計者が verify を実行する。
  - その後、確認のレビュー R14r を行う。

### 2026-09-24 R14r の結果と P14f の起動

- 設計者が `npm run verify` を実行した。結果は PASS だった（2159件）。
- R14r の結果: 修正が必要（Important 1件、Minor 3件）。I1、m1、m4 は解消した。
- 判断:
  - Important-1: Context の構築に失敗した場合は、必ず Ledger を持つ `ContextConstructionError` を投げる。factory は、Ledger との対応を消さない。
  - Minor-1: 候補の発見は、Passive の期限の中で行う。Interaction の予算は、発見の後から数える。P14e の判断1を改める。
  - Minor-2: collector の期限に、余裕を持たせる。
  - Minor-3: 場面の名前と、時計の前提を直す。
- 設計書の 4.3 と 4.5.7 を更新し、P14f を起動した。

### 2026-09-24 P14f 完了

- R14r の Important-1 と Minor-1〜3 を直した。実装者の報告では、`npm run verify` が PASS した（2169件）。
- 実装者の判断2件を承認した。
- テスト用の Proxy の重複を、CC-019 として登録し、C14x に加えた。
- 台帳と設計書 4.5.5 を更新した。
- 改行が CRLF になっていないことを、設計者が確かめた。
- 次の作業:
  - 設計者が verify を実行する。
  - その後、確認のレビュー R14r2 を行う。

### 2026-09-24 設計者による検証と R14r2 の起動

- 設計者が `npm run verify` を実行した。結果は PASS（終了コード0）。テストは58ファイル・2169件で、build も通った。
- 確認のレビュー R14r2 を起動した。

### 2026-09-24 Task 14 のチェックポイントを通過（R14r2 承認）

- R14r2 の結果は、承認（Critical 0、Important 0、Minor 3）だった。これで Task 14 のチェックポイントを通過した。
- 次の Task に進むことについて:
  - ユーザーの正式な開発指示に、「記載の範囲においては全て、私の承認済として扱ってよい」とある。
  - そのため、チェックポイントの後のユーザーの承認は、得たものとして進める。
- Minor の3件は、C14x に加えた。
- 次の作業:
  - C14x を行う。内容は、CC-017、CC-018、CC-019、DEF-003、R14r2 の Minor である。
  - その後、I15a を行う。内容は、Interaction の NOT_VERIFIABLE の区分である。
  - その後、Task 15 の設計と実装に進む。

### 2026-09-24 Task 15 の設計の追補と実装計画

- 着手前の調査で、15件の障害を見つけた。主なものは次のとおり。
  - Run 全体の Evidence の置き場所がない。
  - 再試行の判断の情報がない。
  - 監査しなかった URL の結果を作る部品がない。
  - Run Status の入力の対応が決まっていない。
  - PREFLIGHT と環境の事実を扱う部品がない。
  - fixture が足りない。
- 判断: Task 14〜17 の設計書に 5.6 を加え、次のことを決めた。
  - robots と sitemap の Evidence は、`metadata` の payload を改めたものとし、開始の URL のページに置く。
  - 再試行は、detail の `FAILED:<エラーのコード>` で判断し、ページの単位で行う。記録は `RunSummary.retries` に残す。
  - 監査しなかった URL にも、`SKIPPED` の結果を作る。
  - Run Status の各入力の対応
  - PREFLIGHT、環境の事実、`runId` の作り方
  - fixture の応答の種類
- 実装計画 `doc/design/2026-09-24-beaksight-task-15-implementation-plan.md` を書いた。サブタスクは、I15a → R15a → R15b・R15c（並行）→ R15d の順に行う。

### 2026-09-24 C14x 完了

- 次のものを直した。実装者の報告では、`npm run verify` が PASS した（2197件）。
  - CC-017（期限切れの判定）
  - CC-018（閉じる処理）
  - CC-019（テスト用の Proxy）
  - DEF-003（除外理由の表）
  - R14r2 の Minor 3件
- 振る舞いの変化の可能性がある2件を、承認した。
- 共通部品台帳、共通化候補の台帳、不具合台帳を更新した。
- 次の作業:
  - 設計者が verify を実行し直す。
  - その後、I15a を起動する。

### 2026-09-24 ユーザーによるコミット

- ファイルの変更が200を超えたため、ユーザーがコミットした（`feb56d5 作業保存`）。
- コミットの時点で、作業ツリーに変更は残っていない。
- 実行中の I15a の変更は、このコミットの後の差分として残る。I15a がコミットの前に書いた変更は、コミットに含まれている可能性がある。
- 設計者と実装者は、これまでどおりコミットと push をしない。HEAD に戻す操作もしない。

### 2026-09-24 I15a 完了

- Interaction の NOT_VERIFIABLE を、2つの区分に分けた。区分は `OBSERVED_NO_CHANGE` と `CHECK_NOT_COMPLETED` である。
- 対応表を、1か所にまとめた。実装者の報告では、`npm run verify` が PASS した（2220件）。
- 変更の範囲は、`git status` で確かめた。許可したファイルの中に収まっていた。
- 実装者の判断4件を承認した。
  - 同じボタンが2つあるサイトで、Run が PARTIAL になりやすいことを、Task 19 以降の確認項目に加えた。
- 共通部品台帳を更新した。
- 次の作業:
  - 設計者が verify を実行する。
  - その後、R15a を起動する。

### 2026-09-24 R15a 完了、DEF-004 の登録、R15b・R15c・DEF-004 の起動

- R15a で、次のものを作った。実装者の報告では、`npm run verify` が PASS した（2316件）。
  - Task 15 の型とスキーマ
  - `skippedPageResult`
  - ナビゲーションの失敗の detail
  - fixture
- 実装者の判断8件を承認した。共通部品台帳を更新した。
- 実装者の発見事項（接続拒否で、Guard が違反を記録する）を、既存不具合 DEF-004 として登録した。
  - 許可した GET と HEAD の、ネットワークの層の失敗だけを、閉じた一覧で違反から外す。
- R15b（サイトの metadata）、R15c（PREFLIGHT と環境の事実）、DEF-004 を、並行で起動した。
  - 変更するファイルは、重ならない。
  - 3つの指示書のすべてに、並行であることを書いた。
- 3つの後に、次のことを行う。
  - 設計者が verify を実行する。
  - DEF-004 の Guard の変更について、独立レビューを行う。
  - その後、R15d に進む。

### 2026-09-24 DEF-004 の Blocker と、設計者の承認

- Blocker の内容: 既存の Guard のテストの約10件が、今回直す振る舞いを期待値やきっかけに使っていた。対象は、接続拒否やリセットを違反とする振る舞いである。そのため、「既存のテストは、すべて PASS のまま」の条件と両立しなかった。
- 判断: 選択肢1を承認した。
  - 3785行目のテストは、期待値を修正後の振る舞いに変える。あわせて、`ERR_FAILED` の違反のテストを加える。
  - ほかのテストは、きっかけのコードを、一覧にない `ERR_FAILED` に変える。確かめる意図は、保たれる。
  - 指示書に、承認を書き加えた。
- 同じ実装者に、続きを依頼した。

### 2026-09-24 R15c 完了

- PREFLIGHT、環境の事実、`runId` を作った。担当のテスト23件と typecheck は PASS した。
- 実装者の判断7件を、承認した。
- ビューポートの対応づけの重複を、CC-020 として登録した。R15d で行う。
- 共通部品台帳を更新した。
- R15b と DEF-004 の完了を待っている。

### 2026-09-24 R15b 完了

- `collectSiteMetadata` を作った。統合テスト11件と typecheck は PASS した。
- 実装者の判断6件を、承認した。
- sitemap の index の扱いを、決めた。
  - `sitemapUrls` は null にし、sitemap の Rule では判定しない。
  - 入れ子の sitemap は、たどらない（制約）。
  - 設計書 5.6.2 に書いた。
- 直すのは、R15d で行う。対象は、sitemap の index の扱いと、コメントの食い違いである。
- 共通部品台帳を更新した。
- R15d の指示書を書いた。
- DEF-004 の完了を待っている。

### 2026-09-24 DEF-004 完了

- Guard の `requestfailed` の処理に、条件を1つ加えた。
  - 許可した読み取りの、ネットワークの層の失敗だけを、違反から外す。
  - 閉じた一覧は、`src/safety/network-layer-failure.ts` にある。
- 関係する12ファイル・1144件のテストは、PASS した。
- 不具合台帳と、共通部品台帳を更新した。
- 次の作業:
  - 設計者が verify を実行する。
  - その後、Guard の独立レビュー RDEF4 と、R15d を並行で起動する。
    - RDEF4 は、読み取り専用である。
    - R15d は、Guard に触れない。

### 2026-09-24 全体の検証と、RDEF4・R15d の起動

- 設計者が `npm run verify` を実行した。結果は PASS（終了コード0）。テストは68ファイル・2410件で、build も通った。
- Guard の独立レビュー RDEF4 と、R15d（Run Coordinator）を、並行で起動した。
  - RDEF4 は、読み取り専用である。
  - R15d は、`src/safety/` に触れない。

### 2026-09-24 RDEF4 承認、DEF-004b の起動

- Guard の独立レビュー RDEF4 の結果は、承認だった（Critical 0、Important 0、Minor 2）。安全の不変条件は、後退していない。
- Minor-1 への判断: 違反から外すのを、凍結中でない場合に限る。DEF-004b を、R15d と並行で起動した（`src/safety/` だけを変える）。
- Minor-2 への判断: 一覧にないネットワークの失敗は、fail-closed のままにする。観察の対象として、不具合台帳に記録した。

### 2026-09-24 DEF-004b 完了

- 凍結中は、ネットワークの層の失敗も違反とするようにした。Guard のテスト146件が PASS した。
- R15d の完了を待っている。

### 2026-09-24 R15d（実装は完了）、DEF-005 の登録と起動

- R15d で、`RunCoordinator` を作った。単体テスト34件、統合テスト11件、typecheck、build は PASS した。
- 実装者の判断9件を、承認した。そのうち1件は、TDD の順序の逸脱である。
  - テストより先に実装を書いた。
  - 代わりに、実装をわざと壊し、10通りでテストが失敗することを確かめた。
  - これを、逸脱として記録した。
- 重複の候補を、CC-021 として登録した。Task 16 の前に行う。
- 共通部品台帳を更新した。
- `page-navigation.test.ts` の1件が、後片付けで止まる。
  - 設計者も再現した。
  - 既存不具合 DEF-005 として登録し、調査と修正を依頼した。
  - 製品のコードで、閉じる処理が止まる問題かどうかを確かめる。
- DEF-005 の後に、次のことを行う。
  - 設計者が verify を実行する。
  - その後、Task 15 のチェックポイントの独立レビューを行う。

### 2026-09-24 DEF-005 完了、DEF-006 の登録

- DEF-005 の原因は、製品のコードではなかった。
  - エラーページで、2回目のナビゲーションが失敗した直後に `page.close()` を呼ぶと、Chromium は page を閉じない。これは、Guard の有無に関係しない。
  - テストの後片付けを、Context を閉じる形に直した。
  - 実装者の報告では、`npm run verify` が PASS した（2466件）。
- `page.close()` に期限がないことを、潜在的な不具合 DEF-006 として登録した。直すのは、Task 16 の前の整理のサブタスクである。
- 次の作業:
  - 設計者が verify を実行する。
  - その後、Task 15 のチェックポイントの独立レビュー R15 を行う。

### 2026-09-24 R15 の結果と R15e の起動

- 設計者が `npm run verify` を実行した。結果は PASS だった（71ファイル、2466件）。
- R15（Task 15 のチェックポイント）の結果: 修正が必要（Important 2件、Minor 6件）。
- 判断:
  - I1: テストを加える。
  - I2: すべての Ledger を登録し、その登録からだけ集計する。
  - Minor-3: 違反の判定を、PREFLIGHT の失敗より先に行う（上位の設計書 9.5 に合わせる）。
  - Minor-4: 実行時間の超過を、`crawlLimits` に記録する。
  - Minor-6: 最初の試行の Evidence を保持する（上位の設計書 10.1 に合わせる）。
  - Minor-1・2: C15x に加える。
  - Minor-5: 受け入れる。
- 設計書 5.6.3〜5.6.7 を直した。R15e を起動した。その後に C15x を行う。
- レビュー担当が、一時ディレクトリにリポジトリの `node_modules` へのジャンクションを作っていた。
  - 設計者が、ジャンクションだけを外してから、コピーを削除した。リポジトリは無事だった。
  - 共通ルールに、リンクを作らない決まりを加えた。

### 2026-09-24 R15e 完了、DEF-007 の登録

- R15 の I1、I2、Minor-3、Minor-4、Minor-6 を直した。実装者の報告では、`npm run verify` が PASS した（2487件）。
- 実装者の判断1件を、承認した。
- 設計書 5.6.5 の古い一文を、消した。
- 設計書 第6章に、最初の試行の Evidence の区別と、スクリーンショットの配置を書いた。
- 再試行でスクリーンショットが上書きされる不具合を、DEF-007 として登録した。
- DEF-007 と、古いコメントの修正を、C15x に加えた。
- 次の作業:
  - 設計者が verify を実行する。
  - その後、C15x を起動する。

### 2026-09-24 Task 16・17 の設計の追補と実装計画

- 着手前の調査で、18件の障害と食い違いを見つけた。主なものは、次の2つである。
  - スキーマの検証を Run Status に反映する経路がない。
  - 出力の構成が、文書どうしで食い違っている。
- 判断: Task 14〜17 の設計書に 6.1 を加え、次のことを決めた。
  - `AuditRunResult.statusInput` を使って、書き出しで Run Status を導き直す（A10 と ARCH05 の両方を満たす）。
  - Run の単位の `evidence/*.json` は、書かない（page.json の1か所）。
  - ZIP には、`run.json` を入れる。
  - `relatedFindingIds` は、表示用モデルで作る。
  - 表示のカテゴリ、文言と理由、URL の表示、UI Gate の範囲を決めた。
- 実装計画 `doc/design/2026-09-24-beaksight-task-16-17-implementation-plan.md` を書いた。
  - サブタスクは、U16a → U16b → U16c・U16d（並行）→ U17a の順に行う。

### 2026-09-24 C15x 完了

- 次のものを直した。実装者の報告では、`npm run verify` が PASS した（2511件）。
  - CC-021（理由の組み立て）
  - DEF-006（page と Browser を閉じる処理の期限）
  - DEF-007（再試行のスクリーンショット）
  - R15 の Minor-1・2
  - 古いコメント
- 実装者の判断5件を、承認した。
- 共通部品台帳、共通化候補の台帳、不具合台帳を、更新した。
- 次の作業:
  - 設計者が verify を実行する。
  - その後、確認のレビュー R15r を行い、Task 15 のチェックポイントを判定する。

### 2026-09-24 R15r と U16a の起動

- 設計者が `npm run verify` を実行した。結果は PASS（71ファイル、2511件）。
- 確認のレビュー R15r（Task 15 のチェックポイントの判定）を起動した。
- U16a（表示の語彙と部品の土台）を、並行で起動した。
  - U16a が変更するのは、新しいファイルだけである。Task 15 のファイルとは、重ならない。
  - R15r は、読み取り専用である。

### 2026-09-24 Task 15 のチェックポイントを通過（R15r 承認）

- R15r の結果は、承認（Critical 0、Important 0、Minor 4）だった。これで、Task 15 のチェックポイントを通過した。
- 次の Task に進むことについて:
  - ユーザーの正式な開発指示に、「記載の範囲においては全て、私の承認済として扱ってよい」とある。
  - そのため、チェックポイントの後のユーザーの承認は、得たものとして進める。
- Minor の扱い:
  - Minor-1: DEF-008 として登録した。Task 18 の前に行う。
  - Minor-2: U17a（CLI）で扱う。
  - Minor-3・4: Task 18 の前の整理で行う。
- U16a は、実行中である。

### 2026-09-24 U16a 完了

- 表示の語彙、文言、書式、トークン、HTML の部品、UI Gate の UI02・UI03・UI05 を作った。
  - 全体のテストは、2635件が PASS した。
  - UI Gate のファイルは、13ms で終わった。
- 実装者の判断9件を、承認した。UI追補設計書に、同じ表示の層の中の import の補足を書いた。共通部品台帳を更新した。
- 次の作業:
  - 設計者が verify を実行する。
  - その後、U16b を起動する。

### 2026-09-24 U16a の後の verify、U16b の起動

- 設計者が `npm run verify` を実行し、PASS した（76ファイル、2635件が PASS、3件は todo）。
- U16b（表示用モデルと artifact の書き出し）の実装者を、単独で起動した。

### 2026-09-25 U16b 完了、C16a の用意

- U16b の報告を受け取った。実装者の報告では、verify が PASS した（79ファイル、2688件）。
  - 設計者の verify は、1回目がユーザーの中断で止まった。テストの開始の直後で止まっており、テストの失敗ではない。いま実行し直している。
- 実装者の判断6件のうち、5件を承認した。
  - 「重大な指摘」を色のトーンで選ぶ判断は、承認しなかった。
- 範囲外のテストの1行の修正を、承認した。
- 設計書 6.1.8 を加えた。
  - 書き出しの順序
  - artifact の配置の owner（`src/core/artifact-layout.ts`）
  - 「重大な指摘」の選び方
  - スクリーンショットの関係づけ
- 実装計画に、C16a を追補した。U16d の `createChatGptBundle` は、`Uint8Array` を返す。
- 共通化候補の CC-022（detail の組み立て）と CC-023（artifact の配置）を登録した。どちらも C16a で直す。
- 共通部品台帳に、表示用モデルと書き出しを登録した。
- 次の作業:
  - 設計者の verify を終える。
  - その後、C16a を起動する。

### 2026-09-25 設計者の verify（U16b の後）、C16a の起動

- 設計者が `npm run verify` を実行し直し、PASS した（79ファイル、2688件が PASS、1件は todo）。
- C16a の実装者を、単独で起動した。

### 2026-09-25 C16a 完了、C16b の用意

- C16a を完了した。実装者の報告では、verify が PASS した（80ファイル、2711件）。
  - artifact の配置の owner（`src/core/artifact-layout.ts`）
  - CC-022
  - 「重大な指摘」の属性
  - スクリーンショットの関係づけ
- 実装者の判断8件を、すべて承認した。既存のテスト2件の期待値の変更も、承認した。
- 設計書 6.1.9 を加えた。
  - 2つの `relatedFindingIds` の意味
  - スクリーンショットのパスの出どころ
  - 論理ビューは ZIP の中にだけ置くこと
  - バンドルの形と中身
  - HTML の詳細
- 表示のテストの見本の複製を、CC-024 として登録した。C16b で、U16c・U16d の前にまとめる。
- 共通部品台帳と、CC-022・CC-023 の状態（完了）を更新した。
- 次の作業:
  - 設計者が verify を実行する。
  - その後、C16b を起動する。

### 2026-09-25 C16b 完了、U16c ∥ U16d の起動

- C16b を完了した。実装者の報告では、verify が PASS した（81ファイル、2732件）。
  - 設計者は、関連の3ファイル（68件）と typecheck を実行し、PASS を確かめた。
  - 全体の verify は、U16c・U16d の後に行う。この2つを並行で動かすため、同時に verify を実行しない。
- 実装者の判断4件を、承認した。
- 共通部品台帳に、テストの補助を登録した。CC-024 を完了にした。CC-025 を登録した（Task 18 の前に行う）。
- U16c（HTML）と U16d（バンドル）を、並行で起動した。
  - 変更してよいファイルが重ならないことは、2つの指示書で確かめた。
  - どちらの指示書にも、並行であることと、verify を実行しないことを書いた。

### 2026-09-25 U16d 完了

- ChatGPT 用バンドル（`createChatGptBundle`）を作った。
  - 担当のテスト（25件）と typecheck が PASS した。
  - 並行作業のため、verify は実行していない。U16c の後に、設計者が行う。
- 実装者の判断8件を、承認した。
- CC-026（JSON の書式）と CC-027（パスの検証）を登録した。どちらも C16c で行う。C16c は、U16c の後、Task 16 のレビューの前に行う。
- 設計書 6.1.8 の古い呼び方を直した。共通部品台帳を更新した。

### 2026-09-25 C16c の起動（U16c と並行）

- C16c（CC-026 と CC-027）を、U16c と並行で起動した。
  - 変更してよいファイルが U16c と重ならないことは、2つの指示書で確かめた。
  - どちらも verify を実行しない。全体の verify は、2つが終わった後に、設計者が行う。

### 2026-09-25 U16c 完了、C16d の用意

- HTML レポート（`renderHtmlReport`）を作った。
  - 担当のテスト（243件）と typecheck が PASS した。
  - 並行作業のため、verify は実行していない。
- 実装者の判断5件のうち、3件を承認した。
- 残りの2件と、Safety の事象の一覧がないという設計の漏れは、C16d で直す。
  - Interaction の Evidence の場所
  - 整数の書式
- 設計書 6.1.10 を加えた。実装計画を追補した。共通部品台帳を更新した。
- 次の作業:
  - C16c の完了を待つ。
  - その後、設計者が verify を実行する。
  - それから、C16d を起動する。

### 2026-09-25 C16c 完了

- JSON の書式（CC-026）と、相対パスの検証（CC-027）を、1か所にした。
  - 担当のテストと typecheck が PASS した。
  - 並行作業のため、verify は実行していない。
- 判断1（`ArtifactWriter` の ID の検証が緩くなった）は、承認しなかった。
  - C16d に、`isRunId`・`isPageId` による検証を加えた。
- 厳しくした規則で拒むようになった入力は、承認した。実際には起きない。
- CC-026・CC-027 を完了にした。共通部品台帳を更新した。
- 次の作業:
  - U16c・U16d・C16c がそろったので、設計者が verify を実行する。
  - その後、C16d を起動する。

### 2026-09-25 C16d 完了、C16e の用意

- 次のものを作った。実装者の報告では、verify が PASS した（84ファイル、2909件）。
  - Safety の事象の一覧
  - `InteractionView.location`
  - `formatInteger`
  - `isRunId` と `isPageId`
- 実装者の判断5件のうち、3件を承認した。
  - 事象の種類の値の一覧は、core に移す。
  - HTML の表には、「候補」の列を加える。
  - この2つと、UI05 の対象の追加を、C16e で行う。
- 設計書 6.1.10 を直した。実装計画と共通部品台帳を更新した。
- R16 の指示書を用意した。C16e の後に起動する。

### 2026-09-25 C16e 完了

- 次の3つを行った。実装者の報告では、verify が PASS した（84ファイル、2912件）。
  - Safety の事象の種類の値の一覧を、core（`SAFETY_EVENT_KINDS`）に置いた。
  - UI05 に、新しいカタログと `formatInteger` の検査を加えた。
  - HTML の事象の表に、「候補」の列を加えた。
- 実装者の判断3件を、承認した。
- CC-028（Ledger の分類の名前の型）を登録した。DEF-008 と同じく、Task 18 の前の整理で行う。
- 次の作業:
  - 設計者が verify を実行する。
  - その後、Task 16 の独立レビュー R16 を起動する。

### 2026-09-25 R16 の起動、U17a の用意

- 設計者が verify を実行し、PASS した（84ファイル、2912件、todo 1件）。
- Task 16 の独立レビュー R16 を起動した。
- 設計書の 6.1.8〜6.1.10 が、第10章の後ろ（ファイルの末尾）にあった。設計者が挿入の位置を誤っていたので、6.1.7 と第7章の間に移した。
- UI06 の対象に、今のコードで違反がないことを、近似の走査で確かめた。
- U17a（CLI）の指示書を用意した。R16 の後に起動する。
- CC-016（文言の中の一覧の書式）は、まだ行っていない。Rule のファイルと messages.ts に触れるので、U17a の後に行う。

### 2026-09-25 R16 の結果

- 総合判定は、修正が必要（Critical 0件、Important 1件、Minor 5件）。
- Important: Safety の事象の表で、遮断した操作の URL がリンクになる。
  - 上位の設計書 第20章に反する。
  - 原因は、設計者が 6.1.10 で表を加えたときに、第20章を確かめなかったことである。
- 指摘1・2・3・5・6 は、R16f で直す。設計書 6.1.11 を加えた。
- 指摘4（同じ秒の Run のディレクトリ）は、DEF-009 として登録した。Task 18 の前の整理で直す。
- R16f の確認は、R17 で一緒に行う。

### 2026-09-25 R16f 完了

- R16 の指摘の1・2・3・5・6 を直した。実装者の報告では、verify が PASS した（84ファイル、2950件）。
- 実装者の判断4件を、承認した。
- 発見事項（`page.json` に robots.txt と sitemap の本文がある）は、受け入れた。
  - 設計書 6.1.11 の誤った記述を、設計者が直した。
- 共通部品台帳を更新した。
- 次の作業:
  - 設計者が verify を実行する。
  - その後、U17a を起動する。

### 2026-09-25 設計者の verify（R16f の後）、U17a の起動

- 設計者が `npm run verify` を実行し、PASS した（84ファイル、2950件が PASS、1件は todo）。
- U17a（CLI）の実装者を、単独で起動した。

### 2026-09-25 U17a 完了、C17a の用意

- 本番の CLI を作った。実装者の報告では、verify が PASS した（87ファイル、3002件）。
  - 作ったもの: `run`、`validate-config`、終了コードの表、`ConfigError`、UI01 の CLI の分と UI06
- Windows PowerShell の日本語の表示は、README で案内すると決めた。設計書 第7章に書いた。
- 実装者の判断6件のうち、4件を承認した。
  - `--help` と、要約の文言の名前は、C17a で直す。
- CC-012 を完了にした。
- CC-016 の実施の時期を、C17a に変えた。
- 共通部品台帳を更新した。
- 次の作業:
  - 設計者が verify を実行する。
  - その後、C17a を起動する。

### 2026-09-25 C17a 完了

- 次のものを行った。実装者の報告では、verify が PASS した（87ファイル、3016件）。
  - `--help`
  - `RUN_SUMMARY_TEXT`
  - `severitiesInGroup`
  - 一時ビルドの `package.json`
  - CC-016
- 表示される文字が変わっていないことは、11項目の出力の、バイト単位の一致で確かめた。
- 次の2つは、R17 の結果と合わせて直す。
  - 使い方の表示に `--help` を載せる。
  - `SUCCESS_EXIT_CODE` の説明を直す。
- CC-016 を完了にした。共通部品台帳を更新した。
- 次の作業:
  - 設計者が verify を実行する。
  - その後、R17 を起動する。

### 2026-09-25 共通化候補の状態の見直し

- CC-001〜007、009、011 は、2026-09-23 の基盤修正（F01〜F03、C5、C8）で実施済みだった。
  - 台帳の状態の欄が更新されていなかったので、直した。
- CC-008 の残り（`discover-candidates.ts` の中の複製）と CC-010 の残り（理由のコードと英文の混在）は、Task 18 の後、Task 19 の前に行う。
- CC-015 は、Task 15 で行われていなかった。Task 18 の前の整理で、CC-028 と DEF-008 と一緒に行う。
- R17 を実行中である。

### 2026-09-25 R17 の結果

- 総合判定は、修正が必要（Critical 0件、Important 2件、Minor 2件）。
- R16 の指摘1・2・3・5・6 は、すべて解消した。
- Important:
  - 出力先のパイプが閉じると、スタックトレースが出て終了コードが 1 になる。
  - 導き直した Run Status で終了コードが決まることを、テストが確かめていない。
- 4件とも、R17f で直す。C17a の持ち越し2件も、R17f に含めた。
- 設計書 第7章に、決定を加えた。
- R17f の後に、確認のレビュー R17r を行う。

### 2026-09-25 Task 18 の前の整理の設計

- DEF-008 の呼び出し箇所を、読み取り専用の調査で洗い出した（期限のない箇所が約20か所）。
- `context.close()` が終わらない間も、Guard はリクエストを止め続けることを確かめた。
- 設計書 `doc/design/2026-09-25-beaksight-pre-task-18-cleanup-design.md` と実装計画を書いた。
  - 期限は、呼び出す側で付ける（DEF-006 と同じ形）。Guard と factory の振る舞いは変えない。
  - 期限を過ぎたことは、違反ではなく、未完了の理由にする。
  - 順序: P18a ∥ P18b → P18c ∥ P18d → RP18（Guard の独立レビュー） → P18e
- P18a と P18b の指示書を書いた。R17f と R17r の後に起動する。

### 2026-09-25 R17f 完了

- R17 の指摘4件と、C17a の持ち越し2件を直した。実装者の報告では、verify が PASS した（88ファイル、3030件）。
- Important の2件は、どちらも修正の前に RED になることを確かめてある。
- 実装者の判断5件を、承認した。共通部品台帳を更新した。
- 次の作業:
  - 設計者が verify を実行する。
  - その後、確認のレビュー R17r を行う。
  - R17r で Critical 0・Important 0 なら、P18a ∥ P18b を起動する。

### 2026-09-25 R17r 承認。Task 16・17 完了

- R17r の総合判定は、承認（Critical 0件、Important 0件、Minor 3件）。
- R17 の4件の指摘は、すべて解消した。
- Task 16 と Task 17 を完了とする。
  - チェックポイントは Task 18 なので、ユーザーの承認は、Task 18 の後にまとめて受ける。
- Minor の扱い:
  - Minor-1: 設計書は、設計者が直した。コードのコメントは、P18d で直す。
  - Minor-2: P18d で行う。
  - Minor-3: P18e で行う。
- 次の作業: P18a ∥ P18b を起動する。

### 2026-09-25 P18b 完了（一部）

- CC-015 は、完了した。
- CC-028 は、事象の記録の分類の名前だけを絞った。
  - 残り（数えられなかった遮断の分類の名前）は、閉じたテンプレートの型にする（案(a)）。P18e で行う。
- 実装者の判断3件を、処理した。
- 並行作業のため、verify は P18a の後に、設計者が行う。

### 2026-09-25 P18a 完了

- Context と page の作成・終了に期限を付ける部品を作った。PREFLIGHT、環境、サイトの metadata、幅の走査に使った。
  - 担当のテスト 117件と、typecheck が PASS した。
- 期限のテストの実時間の待ちを、大きく減らした（10.1秒から0.4秒など）。
- 実装者の判断6件を、処理した。
  - 遅れて届いた Context の結果は、捨てる。設計書 4.2 を直した。
  - `passiveTimeoutMs` の名前と置き場所は、P18e で直す。
- 残りの実時間の待ちの3件は、P18c・P18d・P18e に割り当てた。
- 共通部品台帳と不具合台帳を更新した。
- 次の作業:
  - 設計者が verify を実行する（P18a と P18b がそろった状態）。
  - その後、P18c ∥ P18d を起動する。

### 2026-09-25 設計者の verify（P18a・P18b の後）、P18c ∥ P18d の起動

- 設計者が `npm run verify` を実行し、PASS した（89ファイル、3087件）。
- Guard と factory のファイルに、変更がないことを確かめた（変更は P18b の `safety-ledger.ts` だけ）。
- P18c と P18d の指示書に、期限の注入と実時間を待つテストの修正を加えた。P18e には、`passiveTimeoutMs` の移動とテスト補助の期限の注入を加えた。
- P18c と P18d を、並行で起動した。
- RP18（Guard の独立レビュー）の指示書を用意した。

### 2026-09-25 P18d 完了

- DEF-009、R15r-3、R17r の Minor-1・2、Run Coordinator の期限の注入を行った。
  - 担当のテスト 939件、unit と architecture の全体 1793件、typecheck が PASS した。
- 実装者の判断5件を、承認した。
- 設計書 5.6 に追補を加えた。共通部品台帳を更新した。DEF-009 を修正済みにした。
- P18c は、作業中である。

### 2026-09-25 P18c 完了

- Page Auditor と Interaction の、作成・終了・凍結を待つ処理に、期限を付けた。
  - 担当のテスト 611件と typecheck が PASS した。
  - Guard と factory は、変えていない。
- 実装者の判断5件を、承認した。共通部品台帳を更新した。DEF-008 を修正済みにした（RP18 で確かめる）。
- 次の作業:
  - 設計者が verify を実行する（P18c と P18d がそろった状態）。
  - その後、RP18 を起動する。

### 2026-09-25 Task 18 の設計

- Gate の現状を、読み取り専用の調査で洗い出した。
  - 名前付きの Gate は、UI Gate だけである。ARCH01〜08 は、静的な検査がない。
- 既存のテストの欠陥（ポップアップと移動の先の確認が常に真）を、DEF-010 として登録した。
- 設計書 `doc/design/2026-09-25-beaksight-task-18-acceptance-gates-design.md` と実装計画を書いた。
  - 順序: T18a（fixture と DEF-010） → T18b ∥ T18c ∥ T18d → R18（チェックポイント）
- RP18 を実行中である。

### 2026-09-25 RP18 の結果

- 総合判定は、修正が必要（Critical 0件、Important 1件、Minor 4件）。
- 安全の境界は、保たれている。
  - 実際の Chromium で、閉じる処理を止めた状態でも、リクエストが1件も届かないことを確かめてもらった。
  - 止まり続ける経路は、なかった。
- Important: 環境の読み取りの、Context の終了の期限切れが記録されず、Run が COMPLETE になる。
  - P18e で直す。
- 設計書 4.2 に、次の2つを明確にした。
  - 閉じる処理の期限切れでは、Run を COMPLETE にしない。作成の期限切れは、呼び出し元ごとに扱う。
  - Run とページの違反の件数の食い違いを、受け入れる。
- 指摘2・3は P18e で直す。指摘4は T18b で扱う。指摘5は受け入れた。
- P18e の後に、確認のレビュー RP18r を行う。

### 2026-09-25 P18e 完了

- RP18 の指摘1〜3と、持ち越しの項目（期限の値の検証の置き場所、テスト補助の期限、CC-025、CC-028、BOM の表記）を直した。
  - 実装者の報告では、verify が PASS した（89ファイル、3141件）。
- RP18 の Important は、実際の Chromium を使う Run 全体のテストで固定した。修正の前の状態では、このテストが失敗する。
- 実装者の判断5件を、承認した。
- CC-025 と CC-028 を完了にした。共通部品台帳を更新した。
- 次の作業:
  - 設計者が verify を実行する。
  - その後、RP18r ∥ T18a を起動する。

### 2026-09-25 設計者の verify（P18e の後）、RP18r ∥ T18a の起動

- 設計者が `npm run verify` を実行し、PASS した（89ファイル、3141件）。Guard と factory に変更はない。
- Task 18 の設計書 4.2 に、RP18 の指摘4（本物の Guard での凍結の確認）を加えた。
- 確認のレビュー RP18r と、T18a（fixture の追加と DEF-010）を、並行で起動した。
  - T18a が変えるのは fixture と `isolated-interaction.test.ts` だけで、RP18r の対象とは重ならない。
  - レビュー担当には、並行作業があることを伝えた。

### 2026-09-25 RP18r 承認。Task 18 の前の整理の完了

- RP18r の総合判定は、承認（Critical 0件、Important 0件、Minor 2件）。
- RP18 の指摘1・2・3は、すべて解消した。安全の境界は、変わっていない。
- Task 18 の前の整理を、完了とする。
- Minor-1・2 は、Task 18 の後の整理で行う。
  - 共通部品台帳には、Minor-1 の例外を明記した。
- T18a は、作業中である。

### 2026-09-25 T18d の起動（T18a と並行）

- T18d（Architecture の Gate）を、T18a と並行で起動した。変えるファイルは、`tests/architecture/` の新しいファイルだけで、T18a と重ならない。
- T18d には、ARCH01 のために、`config/targets/*.json` を読むことだけを許可した。中の URL へのアクセス、その設定での実行、中身の書き写しは禁止した。
- T18a の実装者に、並行作業があることを連絡した。

### 2026-09-25 T18a 完了、T18b ∥ T18c の起動

- fixture を6つ加え、DEF-010 を直した。実装者の報告では、verify が PASS した（90ファイル、3148件）。
  - DEF-010 のパスを直した後も、遮断のテストは PASS した。遮断は働いている。
- 実装者の判断3件を、承認した。DEF-010 を修正済みにした。
- T18b（Safety の Gate）と T18c（Auditor の Gate）を、並行で起動した。T18d は作業中である。
  - 3つとも、変えるファイルが重ならない。どれも verify は実行しない。

### 2026-09-25 T18d の Blocker（ARCH04）と、T18e の用意

- T18d は、ARCH04 だけで止まった。ほかの7つの Architecture の Gate は、PASS した（各ファイル 309ms・408ms）。
- ARCH04 の違反: `cross-page-rules.ts` の3か所が、Origin の判定を別に実装している。
  - → 案(a)にした。URL の owner の判定を使う形に直す（T18e）。除外の一覧には加えない。
- UI Gate のコメントの除去の誤りを、DEF-011 として登録した。T18e で、共通の走査を使う形に直す。
- `safety-rules.ts` の `example` という識別子は、違反ではないと判断した。設計書 4.4 に明記した。
- T18e は、T18b と T18c が終わってから起動する。T18c は、Cross-page の Finding を確かめているためである。

### 2026-09-25 T18c 完了

- Auditor の Gate（A01〜A10）の16件が、すべて PASS した（約53秒）。監査の誤りは、見つからなかった。
  - すべての Gate に、対照の確認を置いた。
  - ERROR の Finding があっても、ほかに未完了の理由がなければ `COMPLETE` になることを確かめた。
- 実装者の判断5件を、処理した。
  - 設計書 4.5 の実行時間の目安を、ファイルごとに1分程度に直した。
  - 補助の重複を、CC-029 として登録した（Task 18 の後の整理）。
- T18b は、作業中である。

### 2026-09-25 T18b 完了、T18e の起動の準備

- Safety の Gate（S01〜S10）の35件が、すべて PASS した（約30秒）。安全の不変条件が破られている形跡は、なかった。
  - どの Gate も、サーバの境界で数え、対照の確認を置いた。
  - S09（artifact の機密のヘッダ）と S10（Guard の初期化の失敗。終了コード 3 を最後まで通す）も確かめた。
  - RP18 の指摘4も、本物の Guard で確かめた。
- 実装者の判断7件を、処理した。
  - 判断1（DELETE の fixture がない）は、fixture を加える形に直す。T18e に加えた。
- CC-029 に、補助の重複を加えた。共通部品台帳に `gate-harness.ts` を加えた。
- 次の作業: T18e を起動する。

### 2026-09-25 T18e 完了

- 次の3つを行った。実装者の報告では、verify が PASS した（94ファイル、3234件）。
  - ARCH04: `cross-page-rules.ts` の判定を、`classifyUrl` に委ねた。除外の一覧には、何も加えていない。
  - DEF-011: UI Gate も、共通の走査を使う形にした。
  - DELETE の fixture を加えた。
- 実装者の判断3件を、承認した。
- DEF-011 の、抜け落ちていた範囲の記述を、事実に合わせて直した。実際は、`normalize-url.ts` の1行だった。
- CC-030 を登録した（Task 18 の後の整理）。共通部品台帳に `source-scan.ts` を加えた。
- 次の作業:
  - 設計者が verify を実行する。
  - その後、Task 18 のチェックポイントの独立レビュー R18 を起動する。

### 2026-09-25 設計者の verify（T18e の後）、R18 の起動

- 設計者が `npm run verify` を実行し、PASS した（94ファイル、3234件、todo なし）。
- テストの中の Gate の名前が、34個（S01〜S10、A01〜A10、ARCH01〜08、UI01〜06）そろっていることを確かめた。
- Task 18 のチェックポイントの独立レビュー R18 を起動した。

### 2026-09-25 R18 承認。Task 18 完了

- R18 の総合判定は、承認（Critical 0件、Important 0件、Minor 4件）。
- Gate の34個が、すべてそろって PASS した。実装タスク指示 第11章の条件を、満たしている。
- レビュー担当が、一時ビルドの CLI で fixture を最後まで監査した。
  - COMPLETE、終了コード 0 だった。
  - 違反は0件で、届いたのは GET だけだった。
  - artifact は、すべてスキーマに合った。
- チェックポイントの承認: Task 11・14・15 と同じく、ユーザーの正式な指示に基づき、承認済みとして扱う（Task 16〜18）。ユーザーに、その旨を伝えた。
- Minor と参考の指摘は、Task 19 の前の整理（C18）で行う。
  - M3（スクリプトによる外部スキームへの移動）は、安全に関わるので、C18 の最初に調べる。Task 20 が headed で行うためである。
  - `example` の変数名は、名前を変える。

### 2026-09-25 外部スキームへの移動の調査と、DEF-012

- R18 の M3 を、読み取り専用の調査（headless だけ）で確かめた。
  - Guard は、ページのスクリプトによる外部スキームへの移動を、止めも記録もしない（8つの経路、3つのスキーム）。
  - headless では、外部のアプリは起動しない（バイナリに、その仕組みがない）。
  - headed では、起動しうる（推定。確度は高い。`mailto:` は確認なしで渡る）。
- DEF-012 として登録した。
- Task 19 の前の整理の設計書と実装計画を書いた（`doc/design/2026-09-25-beaksight-pre-task-19-cleanup-*.md`）。
  - 検出して記録する。headed では違反にして、Context を閉じる。headless では記録だけにする。
  - GATE-S03 を広げる。Guard の独立レビューを行う。
  - 順序: C18a → C18b ∥ C18c → RC18a → C18d → C18e → RC18
- Task 20 の headed の実行について、ユーザーの判断が必要になることを、ユーザーに伝えた。Task 20 の前に止まったときに尋ねる。
- C18a の指示書を書いた。

### 2026-09-25 ユーザーの判断: Task 20 の smoke は headed で行う

- ユーザーから「smoke を headed で行うでよい」との指示を受けた。
- headed の smoke で外部のアプリが起動しうること（DEF-012）を受け入れた扱いとする。起きた場合は、違反として記録され、Run は ABORTED_BY_SAFETY になる。
- DEF-012 の対策（検出、記録、headed での違反）は、予定どおり実装する。
- 設計書 4.3 に記録した。Task 20 の実行の前に、この扱いを改めてユーザーに示す。

### 2026-09-25 ユーザーの指示: 実サイトへの接続は、明示の承認まで禁止

- ユーザーから「本来の監査対象のサイトへの接続は私の明示承認があるまでNG。他のタスクは迂回可能であれば進めてよい」との指示を受けた。
- headed の smoke への合意は、接続の承認ではない。Task 20・21 は、ユーザーの明示の承認を得てから始める。
- それまでは、実サイトが要らない作業を進める（C18 の整理、Task 19 の fixture の監査と README）。

### 2026-09-25 C18a の中間の報告と、続きの依頼

- C18a は、実装を終えたが、範囲外のテスト2ファイルの件数の期待値の更新が必要で止まった（listener の数 2→3、見本の件数 12→13）。
- 設計者の判断: 件数の更新を承認した。判断1〜6も承認した。
- 追加の2件を、同じ実装者に依頼した。
  - `hasFreezeEvent` に `externalSchemeNavigations`（INTERACTION の段階）を加え、凍結の後の外部スキームへの移動を `BLOCKED_BY_SAFETY` にする。
  - HTML の Safety の事象の表の見出しを、遮断と記録の両方を含む意味にする。
- 実装者の報告: Vitest のワーカーが1回、異常終了した（2回目では起きなかった）。再発するかを見る。

### 2026-09-25 C18a 完了

- 外部スキームへの移動の検出と記録、headed での違反、Interaction の結果への反映、HTML の見出しの修正を行った。
  - 実装者の報告では、verify が PASS した（95ファイル、3319件）。
- 実装者の判断6件を、承認した。
- 共通部品台帳と、DEF-012 の進み具合を更新した。
- 次の作業:
  - 設計者が verify を実行する。
  - その後、C18b ∥ C18c を起動する。

### 2026-09-25 設計者の verify（C18a の後）、C18b ∥ C18c の起動

- 設計者が `npm run verify` を実行し、PASS した（95ファイル、3319件）。Vitest のワーカーの異常終了は、再発しなかった。
- C18b（GATE-S03 の拡張、GATE-S08 の click の確認）と C18c（小さな修正のまとめ）を、並行で起動した。変えるファイルは重ならない。

### 2026-09-25 C18c 完了

- 6つの小さな修正を行った。
  - ARCH04 の検出を広げた。
  - `example` の名前を変えた。
  - PREFLIGHT のメッセージを直した。
  - 幅の走査の理由を直した。
  - BOM の表記を直した。
  - CC-030 を行った。
- Architecture と UI の Gate は、各ファイル 0.3〜0.5秒で PASS した。
- 実装者の判断4件を、承認した。CC-030 を完了にした。
- C18b は、作業中である。

### 2026-09-25 C18b 完了

- GATE-S03 を、7経路 × 3スキーム × 4段階に広げた。GATE-S08 には、click と登録の試みの確認を加えた。
  - `safety-gates.test.ts` の63件が PASS した（約47秒）。
- 実装者の判断4件を、承認した。
- 重複を、CC-029 に加えた。
- 次の作業:
  - 設計者が verify を実行する（C18b と C18c がそろった状態）。
  - GATE-S09 の一度だけの失敗が、再発しないかも見る。
  - その後、RC18a（Guard の独立レビュー）を起動する。

### 2026-09-25 設計者の verify（C18b・C18c の後）、RC18a の起動

- 設計者が `npm run verify` を実行し、PASS した（95ファイル、3375件）。GATE-S09 の一度だけの失敗は、再発しなかった。
- Guard の独立レビュー RC18a を起動した。

### 2026-09-25 RC18a の結果

- 総合判定は、修正が必要（Critical 0件、Important 2件、Minor 2件）。
- Important 1: サーバのリダイレクトで外部スキームへ移る経路を、検出できない。
  - → C18g で、リダイレクトをたどる前に止めて記録する。止められる経路なので、headed でも違反にしない。
- Important 2: headed で違反が起きても、Run が止まらず、危険を繰り返す。
  - → C18f で、違反を検出した後は、新しい監査を始めない。
- 設計書に、次のものを加えた。
  - 4.1.1（訂正）
  - 4.2 のリダイレクトの扱い
  - 4.2.1（止められる経路と、止められない経路の整理）
  - 4.5（違反の後は監査を続けない）
- 実装計画に、C18g、C18f、RC18b を加えた。C18g と C18f は、変えるファイルが重ならないので、並行で行う。

### 2026-09-25 C18g ∥ C18f の起動

- C18g（外部スキームへのリダイレクトを、たどる前に止めて記録する）と C18f（違反の後は監査を続けない）を、並行で起動した。
- `schemas/page.schema.json` は、両方が触れる可能性がある。変える部分を分け（C18g は事象の定義、C18f は理由のコードの一覧）、編集の前に読み直すよう指示した。

### 2026-09-25 C18f の中間の報告と、続きの依頼

- 違反を検出した後は、新しいページ、次のビューポート、幅の走査の次の幅、Interaction の次の候補を始めなくなった。RC18a の再現で、違反は6件から1件になった。
- 新しい理由のコード: `SAFETY_VIOLATION_ABORT`。
- 設計者の判断:
  - 違反の後の再試行も止める（既存のテストの期待値の変更を承認）。
  - 幅の走査の次の幅も止めることは、承認した。
  - `safetyViolationRecorded` を、Page Auditor の必須の依存にする。
  - 環境の段階の違反の後は、robots.txt と sitemap の取得も始めない。
- 同じ実装者に、続きを依頼した。

### 2026-09-25 C18g の中間の報告と、続きの依頼

- サーバのリダイレクト（3xx の `Location` が外部スキーム）を、Guard が Response stage でたどる前に止め、`EXTERNAL_SCHEME_REDIRECT_BLOCKED` で記録するようになった。
  - 広い範囲のテスト（92ファイル、3407件）が PASS した。
- 設計者の判断:
  - main frame で Guard 自身が止めたリクエストの失敗は、予期した失敗として、`HTTP_MAIN_FRAME_DELIVERY_FAILED` の違反にしない。止めたリクエストに限る、正確な緩め方にする。
  - 判断1〜5は、承認した。5（試験用のパスの定数の重複）は、CC-029 に加えた。
  - 発見事項6（リダイレクトの対応付けの1秒の期限切れ）は、DEF-013 として登録した。fixture で再現を確かめる。
- 同じ実装者に、続きを依頼した。

### 2026-09-25 C18g 完了、DEF-013 の再現

- C18g の続きの A を完了した。main frame で Guard 自身が止めたリクエストの失敗を、正確に、予期した失敗として扱うようにした。
- B: DEF-013 を再現した。1.5秒の普通の 302 で、偽の違反になり、Run が止まる。
  - 実サイトで問題になるので、Task 20 の前に直す。
- 設計書に 4.6 を加えた。期限を、リダイレクトの応答を受けた時点から数える形にする。
- 実装計画に C18h を加えた。C18f の全体のテストが終わってから起動する（Guard を途中で変えると、結果が乱れるため）。

### 2026-09-25 C18f 完了

- 違反の後は、次のものを始めないようにした。RC18a の再現で、違反は6件から1件になった。
  - 新しいページ、次のビューポート、幅、候補
  - 再試行
  - metadata の取得
- `safetyViolationRecorded` を、Page Auditor の必須の依存にした。
- 新しい理由のコード `SAFETY_VIOLATION_ABORT` を加えた。
- 実装者の判断5件を、承認した。
- 小さな残りのケース（Mobile のスクリーンショットの置き場所の名前）は、受け入れた。
- 共通部品台帳を更新した。
- 次の作業:
  - 設計者が verify を実行する（C18f と C18g がそろった状態）。
  - その後、C18h（DEF-013）を起動する。

### 2026-09-25 設計者の verify（C18f・C18g の後）、C18h の起動

- 設計者が `npm run verify` を実行し、PASS した（95ファイル、3467件）。C18f の報告の15件の失敗は、C18g の途中の状態によるもので、今は起きていない。
- C18h（DEF-013。遅いリダイレクトの偽の違反）を、単独で起動した。

### 2026-09-25 C18h 完了（DEF-013）

- 遅いリダイレクトの偽の違反を直した。リダイレクトの応答を受けた時点で、対応付けを登録し直す。
  - 実装者の報告では、verify が PASS した（96ファイル、3,479件）。
- 対応付けの本当の欠落と、上限を超えた場合は、今までどおり違反のままである。
- 実装者の判断5件を、承認した。DEF-013 を修正済みにした（RC18b で確かめる）。
- 次の作業:
  - 設計者が verify を実行する。
  - その後、RC18b を起動する。

### 2026-09-25 設計者の verify（C18h の後）、RC18b の起動

- 設計者が `npm run verify` を実行し、PASS した（96ファイル、3479件）。
- Guard の確認のレビュー RC18b を起動した（RC18a の指摘の解消と、DEF-013 の修正の確認）。

### 2026-09-25 RC18b の結果

- 総合判定は、修正が必要（Critical 0件、Important 1件、Minor 2件）。
- RC18a の指摘の判定:
  - 指摘2・3・4 と DEF-013 は、解消した。
  - 指摘1 は、一部解消（OOPIF の中のリダイレクトが残る）。
- N1（Important）: 別のプロセスの iframe（OOPIF）の中のリダイレクトを、止めも記録もできない。
  - headed で使う完全版の Chromium は、別のサイトの iframe を OOPIF にする。
  - テストの headless は OOPIF を作らないので、Gate で検出できなかった。
  - → C18i で、OOPIF にも CDP の横取りを付ける。付けられなければ、fail-closed にする。サイトの分離を無効にする引数は使わない。
- N2 は C18i で直す。N3 は、設計書 4.5 に制約として書いた。
- 設計書 4.2.1 と DEF-012 に、OOPIF の制約を書いた。実装計画に、C18i と RC18c を加えた。
- C18i の指示書を書いた。

### 2026-09-25 C18i の起動

- C18i（OOPIF への CDP の横取りの付与と、幅の走査の理由）を、単独で起動した。サイトの分離を無効にする起動の引数は、使わないよう指示した。

### 2026-09-25 ユーザーのコミット（0997f8c）

- ユーザーが、ここまでの作業をコミットした（0997f8c「作業保存」）。設計者と実装者は、今後もコミットとプッシュをしない。
- コミットの時点で、C18i の実装者が作業中だった。C18i の途中の変更がコミットに含まれている可能性がある。C18i の完了の後の verify とレビューで、全体を確かめる。

### 2026-09-25 C18i 完了

- OOPIF にも、Guard の横取りを付けた。`Target.setAutoAttach` と `waitForDebuggerOnStart` を使うので、横取りの前に移動が進む時間の窓はない。
  - 実装者の報告では、verify が PASS した（97ファイル、3,516件）。
- 付けられなかった場合は、`OOPIF_GUARD_ATTACH_FAILED` で fail-closed にする。
- GATE-S03 に、OOPIF の経路を加えた。
- N2 を直した。
- 実装者の判断5件を、承認した。
- 実サイトで偽の違反になりうる点を、監視の項目 DEF-014 として登録した。Task 20 の結果を見て決める。
- 次の作業:
  - 設計者が verify を実行する。
  - その後、RC18c を起動する。

### 2026-09-25 設計者の verify（C18i の後）、RC18c の起動

- 設計者が `npm run verify` を実行し、PASS した（97ファイル、3516件）。
- Guard の確認のレビュー RC18c を起動した（RC18b の N1・N2 の解消と、OOPIF への付与の確認）。

### 2026-09-25 RC18c 承認。DEF-012 への対応の完了

- RC18c の総合判定は、承認（Critical 0件、Important 0件、Minor 3件）。
- N1（OOPIF）と N2 は、解消した。
  - `--site-per-process` と `channel: 'chromium'` の headless で、42通りを確かめた。
  - 時間の窓がないことも、確かめた。
- DEF-012 を修正済みにした。
  - 残る制約: headed でのスクリプトによる移動の最初の1回、fenced frame と先読み、DEF-014
- M1（設計書の記述が古い）は、設計者が直した。
- M2・M3（テストの追加）は、C18d の指示書に加えた。
- 次の作業: C18d（テストの補助の共通化、ハブのページ、M2・M3）を起動する。

### 2026-09-25 C18d の起動

- C18d（テストの補助の共通化 CC-029、共通のハブのページ、RC18c の M2・M3）を、単独で起動した。

### 2026-09-25 ユーザーの判断: smoke の対象は demo.playwright.dev/todomvc

- ユーザーから「smokeテストはhttps://demo.playwright.dev/todomvc/を使用することにして。本来の監査対象のサイトは完成までアクセスNGで」との指示を受けた。
- Task 20 の smoke は、https://demo.playwright.dev/todomvc/ で、headed で行う。上位の実装計画の Task 20 の対象（`config/targets/example.json`）を、この対象に読み替える。
- smoke の専用の target の設定の置き場所と形は、Task 20 の着手の前に設計する。
- 本来の監査対象のサイトへは、機能の完成までアクセスしない。Task 21 は、完成とユーザーの明示の承認の後に行う。
- 設計書（Task 19 の前の整理）4.3 と、メモリに記録した。

### 2026-09-25 C18d 完了、C18e ∥ C18k の起動の準備

- テストの補助を、`tests/helpers/` の3つのファイルにまとめた（CC-029 を完了）。
  - 実装者の報告では、verify が PASS した（97ファイル、3,520件）。
- ハブのページで、Auditor の Gate の Run を8から5に減らした（53秒から43秒）。
- RC18c の M2・M3 のテストを加えた。
- 実装者の判断6件を、承認した。
- 範囲の外に残った重複を CC-031 として登録し、C18k とした。C18e と並行で行う。
- 共通部品台帳を更新した。

### 2026-09-25 C18e ∥ C18k の起動

- C18e（CC-008 の残りの実装と、CC-010 の残りの調査）と C18k（CC-031）を、並行で起動した。
- C18e の指示書を、並行作業に合わせて直した（verify を実行しない、C18k のファイルを変えない）。

### 2026-09-25 C18k の完了と、修正の回 1 の起動

- C18k（CC-031）が完了した。報告は `C18k-report.md`。
  - 設計者の確認: 変更は指示の範囲に収まっている。`tests/` の中で、要求された値を Chromium にそのまま渡す起動はなくなった（`preflight.test.ts:156` は、起動せずに例外を投げる模造）。
  - 全体の verify は、C18e の完了の後に設計者が行う。
- 実装者の確認の求めへの判断:
  1. `fixtures/server.ts` が `tests/helpers/` を import する向きは、逆にする。宛先の値は `fixtures/external-scheme-targets.ts` に置き、補助がそれを export し直す（C18k-fix-round-1）。
  2. 題名の表記 `headed (injected)` は、そのままでよい。
  3. `oopif-guard` の Mock を `afterEach` で戻す形は、そのままでよい。
  4. 共通部品台帳の `gate-harness.ts` の行を、設計者が更新した。
- 実装者の発見事項の扱い:
  - `slow-redirect.test.ts:26` の `QUIET_PERIOD_MS` は、C18k-fix-round-1 で置き換える。
  - Guard の付いた Passive の page を開いて閉じる形の残りは、CC-032 として登録した。C18e の後で RC18 の前に、C18m として行う。
  - headed の注入を個別に書いている3か所（`passive-request-guard.test.ts:27`、`crawl-run.test.ts:454`、`page-auditor.test.ts:1484`）は、Guard の取り付けの指定や Run の設定であり、`FACTORY_MODES` と意味が違う。重複ではないので、対象にしない。
- C18k-fix-round-1 を起動した（C18e と並行。変更するファイルは重ならない）。

### 2026-09-25 C18k-fix-round-1 の完了

- 宛先の値を `fixtures/external-scheme-targets.ts` に移した。`fixtures/` は `tests/` を import しない。`slow-redirect` の `QUIET_PERIOD_MS` を共通の定数にした。報告は `C18k-fix-round-1-report.md`。
- 実装者の検証: 4ファイル103件が、変更の前と後で PASS。`npm run typecheck` が PASS。
- 設計者の確認: `fixtures/*.ts` の import に `tests/` がないことを確かめた。共通部品台帳の外部スキームの行を2つに分けて更新した。
- テストの期待値やデータに直接書かれた宛先の値は、独立した確かめとして残す（共通化候補にしない）。
- CC-031 は、これで完了とする。全体の verify は、C18e の完了の後に行う。

### 2026-09-25 C18e の完了と、CC-010 の残りの判断

- C18e の第1段階（CC-008 の残り）が完了した。`discover-candidates.ts` のブラウザ内の処理を `interactionCandidateProbe` にまとめた（1324行 → 1194行）。256件の fixture のページで、まとめる前と後の候補、作業量、状態が同じことを、実装者が確かめた。報告は `C18e-report.md`。
- 実装者の判断（`resolveInteractionCandidateHandle` もまとめた、2つ目の引数の有無で入力を見分ける）は、受け入れた。
- 第2段階（CC-010 の残り）: 案A を採った。設計書 5.1 を加えた。
  - `reason` を閉じた一覧のコードにし、`reasonDetail` を加える。`work`、`lifecycle` も同じ形にする。
  - スキーマの版は上げない（未公開。この整理の中のほかの変更でも上げていない）。
  - 日本語の説明は `messages.ts` に置く。表示の言語は UI 追補設計書で承認済み。
  - 実装は C18n（Evidence、スキーマ、`isolated-auditor.ts`）→ C18o（説明と表示）。C18m（CC-032）は C18n の後に、C18o と並行で行う。
- 共通部品台帳に `interactionCandidateProbe` を載せた。CC-008 を完了にした。

### 2026-09-25 設計者の verify（C18e・C18k の後）と C18n の起動

- `npm run verify`: 終了コード 0。98ファイル、3,523件が PASS。ビルド PASS。
- CC-031 と CC-008 の完了を、全体の verify で確かめた。
- C18n（CC-010 の残りの1）を起動した。指示書は `C18n-brief.md`。並行の作業はない。

### 2026-09-25 C18n の Blocker と対応

- C18n が Blocker で止まった（ファイルの変更はなし）。Evidence の形を変えると、変えてよいファイルの一覧に無い4つのテスト（`run-coordinator`、`page-auditor`、`audit-run-fixture`、`schema-enum-consistency`）で、型チェックかテストが失敗する。
- 原因: 設計者の指示書の、変えてよいファイルの一覧の漏れ（見本や期待値として英文や自由な文字列を入れているテストを、洗い出していなかった）。
- 対応: 実装者の案1を採った。4つを変えてよいファイルに加える。確かめる内容は弱めず、コードの一致と `reasonDetail` の一致に移す。
- 実装者の洗い出しで分かったことを、設計書 5.1 に反映した:
  - NOT_VERIFIABLE のコードは55個（設計書の54個は誤り）。
  - lifecycle のコードに `OWNER_CLOSE_NON_TERMINAL` を加える（Ledger の既存のコードと名前をそろえる）。
  - `InteractionOwnerCleanupError` の `lifecycle` も同じ形にする。
  - Safety Ledger の違反の文言は変えない。
- 同じ実装者に、判断を伝えて再開させた。

### 2026-09-25 C18n の完了と、C18o ∥ C18m の起動

- C18n が完了した。Interaction の理由を閉じた一覧のコード（69個、lifecycle 4個）と `reasonDetail` に分けた。報告は `C18n-report.md`。
  - 実装者の verify: 98ファイル、3,621件 PASS。
  - 設計者の確認: 変更の範囲、`src/` に英文の理由が残らないこと、typecheck PASS、スキーマ・表示・Gate の9ファイル733件 PASS。
  - `html-report.test.ts` の `HOSTILE_TEXT` のエスケープの確かめは、C18o まで一時的に替えてある。C18o の受け入れ条件に、戻すことを加えた。
- C18o（説明と表示）と C18m（CC-032）を並行で起動した。変えるファイルは重ならない（C18o は `src/presentation`、`src/report`、`tests/unit` の表示のテスト。C18m は `tests/integration/`）。全体の verify は、両方の後に設計者が行う。

### 2026-09-25 C18o の完了

- C18o が完了した。Interaction の理由（69個）と lifecycle の理由（4個）に日本語の説明を置き、HTML で未完了の理由と同じ部品（`reasonParts`）で示す。報告は `C18o-report.md`。
- 設計者の確認: `html-report.test.ts` で `HOSTILE_TEXT` のエスケープの確かめが戻ったことを見た。
- CC-010 を完了にした。共通部品台帳に、コードの一覧、説明、`reasonParts`・`ReasonView<TCode>` を載せた。
- C18m の完了を待ち、全体の verify を行う。

### 2026-09-25 C18m の完了

- C18m（CC-032）が完了した。8ファイルで71件を `withGuardedPassivePage` に置き換えた。15ファイル661件の件数と名前が前と後で同じ。報告は `C18m-report.md`。
- 発見事項の判断: 閉じる処理の失敗を探索のテストで拾わなくなる点は受け入れた（専用のテストで確かめている）。補助を広げる案は採らない。CC-032 を完了にした。
- 全体の verify を実行中。

### 2026-09-25 設計者の verify（C18n・C18o・C18m の後）と RC18 の起動

- `npm run verify`: 終了コード 0。98ファイル、3,629件 PASS。ビルド PASS。
- 整理の全体の確認のレビュー RC18 を起動した（読み取り専用。指示書は `RC18-review-brief.md`）。

### 2026-09-25 RC18 の結果と C18p の起動

- RC18 は承認（Critical 0、Important 0、Minor 8）。結果は `RC18-review-result.md`。レビュー担当の意見: Task 19 に進んでよい。
- 設計者が直したもの: M2（設計書 5.1.2 に制限の方法を明記）、M6（CC-033 を登録。`selectorFor` は共通化しない）、M7（共通部品台帳）、M8（設計書 第8章、CC-031）。
- C18p を起動した（M1 説明の文、M3 型の分け方、M4 探索のテストの違反の確かめ、M5 CLI のテストの `--headless`、M6 矩形の型の別名、M8 使われない lifecycle の説明を消す）。
- C18p の後に設計者が verify を行い、整理を完了とする。その後、Task 19 に進む。

### 2026-09-25 Task 19 の設計

- 設計書 `2026-09-25-beaksight-task-19-fixture-full-crawl-readme-design.md` と実装計画を書いた。
  - 上位の計画の Step 2（`npx playwright install chromium`）は行わない。Chromium（`chromium-1234`）と headless shell はすでに入っている。
  - Step 3 は、専用の fixture のサイト（`fixtures/site/full-crawl/`）と、本物の CLI を別のプロセスで動かす結合テストとして残す。設定に巡回をパスで絞る仕組みがないので、危険な fixture のページにたどり着かない専用のサイトにする。
  - README は日本語で書き直す（T19b）。独立の確認（RT19）を受ける。
- T19a の指示書を書いた（C18p の完了と verify の後に起動する）。

### 2026-09-26 C18p の完了、DEF-015、Task 19 の前の整理の完了

- C18p が完了した（RC18 の M1・M3・M4・M5・M6・M8）。報告は `C18p-report.md`。
- 設計者の verify: 1回目は vitest のワーカーの異常終了で終了コード 1（失敗のテストは 0件）。再実行で 100ファイル、3,632件 PASS、ビルド PASS、型チェック PASS。異常終了は DEF-015（監視）として登録した。
- Task 19 の前の整理を完了とした（RC18 承認、Minor を直した、全体の検証 PASS）。
- T19a を起動する。

### 2026-09-26 T19a の完了と修正の回 1

- T19a が完了した。専用の fixture のサイトと、本物の CLI の結合テスト（15件）。`COMPLETE`、期待した Finding、違反 0件、GET だけ。実装者の verify: 101ファイル、3,647件 PASS。報告は `T19a-report.md`。
- 発見事項の判断: sitemap の INFO は、fixture のサーバに metadata のディレクトリを選ぶ指定を加えて解消する（T19a-fix-round-1）。幅の走査のはみ出しの viewport は README で説明する。text/plain の 404 の雑音は DEF-016（Task 20 の後に決める）。
- T19a-fix-round-1 を、同じ実装者に伝えて始めた。

### 2026-09-26 本来の監査対象のサイトの名前をリポジトリから消したことと、T19a-fix-round-1 の完了

- ユーザーの指示（2026-09-26）: 本来の監査対象のサイトの名称を Git に載せない。
  - 作業ツリーの `doc/`（2ファイル）と `.superpowers/`（32ファイル）から、名前を「本来の監査対象のサイト」に置き換えた。今後、指示書などにも名前を書かない。
  - コミット feb56d5 の設計書に名前があり、`origin/feature/20260923-01` に push 済み。履歴の書き換えはユーザーの判断（設計者は git の書き込みの操作が禁止）。
- T19a-fix-round-1 が完了した。fixture のサーバに `siteMetadataDirectory` を加え、対照のページの例外をなくした。報告は `T19a-fix-round-1-report.md`。
- クラウドのセッションへ移す準備中（ユーザーの依頼。作業記録を含める）。`.claude/` のスキルとフックも、Git の対象外のため、含めるには `-f` が要る（`settings.local.json` は含めない）。

### 2026-09-26 設計者の verify（T19a-fix-round-1 の後）

- 型チェック PASS、全テスト 101ファイル、3,659件 PASS、ビルド PASS。DEF-015 の異常終了は起きなかった。
- T19a を完了とする。次は T19b（README）。クラウドへ移す場合は、移した先で T19b を起動する。

### 2026-09-26 クラウドのセッションでの T19b と RT19

- クラウドの環境の確認:
  - Node は v22.22.2（`engines` は 24）。`npm ci` を、ユーザーの承認を得て行った（lockfile のとおり。版の変更なし）。
  - Playwright 1.62.1 の Chromium（revision 1234）がない（環境にあるのは 1194）。取得の承認を得たが、ネットワークの設定で `cdn.playwright.dev` が拒否された。ユーザーが許可のリストに加えた後も、このコンテナでは 403 のままだった（新しいセッションで有効になる見込み。未確認）。
  - 設計者の verify（クラウド、Chromium なし）: 型チェック PASS、ビルド PASS。テストは 101ファイル、3,659件のうち、PASS 2,394件、失敗 72件、skip 1,193件。失敗の34ファイルは、どれも Chromium の実行ファイルがないことによる起動の失敗だった。期待値の不一致は、ブラウザの起動の失敗の結果として起きたものだけ。全体の `npm run verify` の PASS は未確認（Windows で行う）。DEF-015 の異常終了は起きなかった。
- T19b（README の書き直し）が完了した。報告は `T19b-report.md`。指示書に「クラウドの環境での追補」を加えた（ブラウザを起動しない、PowerShell の表示は設計書 第7章を出どころにする）。
- RT19（独立の確認）: Critical 0、Important 1、Minor 7。結果は `RT19-review.md`。
  - I-1: headless でも、新しいウィンドウで外部スキームを開こうとすると `FRAME_CLASSIFICATION_FAILED` の違反になる。README が「headless では違反にしない」と断定していた。
- T19b 修正の回 1: I-1、M-1〜M-7 を直した。報告は `T19b-fix-round-1-report.md`。設計者が確かめたこと: 変更は `README.md` だけ。README の URL は `https://example.com` だけ。I-1 の記述がコードと設計書 4.2.1 に合う。
- 発見事項の登録: DEF-017（`--headless` の説明の不足）、DEF-018（単体テストの置き場所のテストが Chromium を起動する）。共通化の候補の新規はなし。共通部品台帳への新規の部品はなし（更新履歴だけ加えた）。
- ユーザーの指示（2026-09-26）: クラウドの環境では、設計者がコミットとプッシュをしてよい。`.claude/hooks/block-git-commit-push.mjs` を、`CLAUDE_CODE_REMOTE=true` のときは止めないように変え、`settings.json` の Bash の deny を外した。`SKILL.md` 第2章に例外を書いた。実装者とレビュー担当には、これまでどおり禁止する。
- 未実行: `npm run verify` の全体、`fixture-full-crawl.test.ts`、幅の走査の結果の `report.html` での見え方、I-1 の振る舞いの実行での確認。Chromium のある環境（Windows、または Chromium を取得できる新しいクラウドのセッション）で行う。
- 次: Chromium のある環境で verify を行い、Task 19 を完了とする。その後、Task 20（ユーザーの Windows の PC。headed）。

### 2026-09-26 クラウドのセッション（2回目）での Chromium の取得の失敗（Task 19 は未完了）

- `npm ci` を行った（lockfile のとおり。版の変更なし。Node は v22.22.2）。
- `npx playwright install chromium chromium-headless-shell` は失敗した。`cdn.playwright.dev` への接続が、環境のネットワークの方針で 403 で拒否された（`request blocked: no rule or allowlist entry allows host "cdn.playwright.dev"`）。予備の `playwright.download.prss.microsoft.com` も 403 だった。プロキシの状態でも、両方のホストが `connect_rejected` と記録された。ユーザーが許可のリストに加えた設定は、このセッションのコンテナには反映されていない。
- 指示どおり、ここで止めた。型チェック、テスト、ビルドはこのセッションでは実行していない（前のセッションの結果は上の項目のとおり）。
- 未実行: `npm run verify` の全体、`fixture-full-crawl.test.ts`、幅の走査の結果の `report.html` での見え方、RT19 の I-1 の振る舞いの実行での確認。
- Task 19 は未完了のまま。次: 環境の Network access の設定（許可するドメインに `cdn.playwright.dev` があるか、または広いアクセスの段階か）を確かめ、設定が反映された新しいセッションで、Chromium を取得して verify を行う。または Windows で verify を行う。
