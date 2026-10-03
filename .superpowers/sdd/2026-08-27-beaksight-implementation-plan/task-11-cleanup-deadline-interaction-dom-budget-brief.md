# Task 11 bounded correction — cleanup deadline, retry yield, and interaction-wide DOM budget

Date: 2026-09-22. Root: `C:/Develop/github-repo/BeakSight`.

## Scope and binding authority

Correct only these three user-reported Task 11 Important findings:

1. the two-attempt `session.close()` policy is count-bounded but a never-settling close can wait forever;
2. the approved macrotask yield between non-terminal close attempts is missing;
3. `maxDomWork` is reset per discovery/resolution/inspection call instead of being shared by the complete `auditInteraction()` work phase.

The user approved this bounded design: one explicit cleanup deadline, at most two close calls, all concurrent calls joining the same Guard `closeAttempt`, one macrotask yield before retry, terminal recheck after that yield, and one interaction-wide DOM-work budget. Task 12+ remains forbidden.

## Frozen baseline

Verify every entry before test edits and stop on drift.

| Path | SHA-256 |
| --- | --- |
| `src/interaction/isolated-auditor.ts` | `0A030F675C5CCE748416006A5B2FA1EBD2016EA633C4B27A9C88BDBA11A63059` |
| `src/interaction/discover-candidates.ts` | `3A484C01FBDD8AE722476001040672AE0D70FFAA0D5501D7ED2447BA827614C9` |
| `src/browser/context-factory.ts` | `454261DD6964756E9C06C4B9FD1C1CB80E14FDA5D458CCDC06549E6C973B6D6D` |
| `src/safety/passive-request-guard.ts` | `49921091F4A92C5C7D9ADBE8CBA3621C6542B657E64217DFA5407B49CB02B7E3` |
| `src/safety/interaction-policy.ts` | `8C4A6A4C39B1D1D4D89E548E566D9CDB9789166E1E0A1D61E342B891ACA5BC9F` |
| `tests/integration/isolated-interaction.test.ts` | `86B9AACF119734289DABD98EF319AFF00D915E91C40C7184E82FEA241621019E` |
| `tests/integration/passive-request-guard.test.ts` | `9E7617A4A06E15067073FE0287DA7B72205D01A05B2346448889945DEF8D81C6` |
| `tests/component/context-factory.test.ts` | `6C89F85B0A0582C552EFBE4737F3C78B68767F6466B002CBB8BF2BBFE7AB1670` |
| `package.json` | `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` |
| `package-lock.json` | `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A` |
| `tsconfig.json` | `64FB9FDCD6CD95E15BEEF3C698CC5FACDD68ED4F60DA399A21790EEF68B9682E` |
| `tsconfig.build.json` | `6AB4E801BDF64CB78078446D5AFA87B336D295286E561E566CE84C5CCAB4E30D` |
| `vitest.config.ts` | `095BD4B5600B4B08C462DAEE36AD77EEA44A9E5A744CC84BDF29086EE1095184` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-review-package.md` | `6253DAB3BEA76CDAC3AF377B1DCDDD0107E83F1E7FB1A4F3CB66ACF625D72BF3` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-owner-retention-requestfailed-report.md` | `1F045D678F01BD63F219163777C7AE5973B88FFFDF4BECB1FA706FB14D1AB532` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-owner-retention-requestfailed-review.md` | `A33D0C54D0D387BE4CC48C20293E8AF22420BDAD50E7C3910160459416461977` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-recovery-task-5-report.md` | `CE8308D123583E53B74A3E326D3B884DB864FF1CC43769C3D84845AF655D1AD3` |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/progress.md` | `5441F9F2F10D1D47163ACA1DF33587CE35A83A3B2307B0806E411F825E7144F2` |
| `doc/design/2026-08-27-beaksight-implementation-tasks.md` | `1A5A131B916CE387A0AB89F799A303EE6EE61F530A8663E0AD80397A114A270B` |
| `doc/design/2026-09-20-beaksight-task-11-terminal-recovery-dom-budget-outcome-design.md` | `1DA1DD0FDE5784F6E078088924F54370A87D990304A7FEFAB27FE8B3CF8A962E` |

## Required correction 1 — wall-clock-bounded cleanup

- Cleanup starts after the work outcome is frozen. Set one explicit absolute cleanup deadline from the already validated `input.timeoutMs`: `cleanupDeadlineAtMs = Date.now() + input.timeoutMs`.
- Preserve `INTERACTION_OWNER_CLOSE_ATTEMPT_LIMIT = 2`.
- Give attempt 1 no more than the first half of the cleanup window; attempt 2 may use only the remaining total window. Never extend the absolute deadline.
- Convert each `session.close()` Promise into a rejection-contained discriminated settlement before racing it with the relevant timer. A timeout must not abandon a raw Promise that can later reject unobserved.
- A timed-out close is not cancellation. The Guard's existing `closeAttempt` remains canonical. If attempt 2 is started while attempt 1 is still pending, it must join that same Guard attempt; prove this with one raw `BrowserContext.close()` owner/count.
- No AbortController cancellation, second Guard close owner, background retry, global recovery table, or new registry.
- At total deadline with canonical non-terminal state, never return `InteractionAuditResult`. Throw `InteractionOwnerCleanupError` retaining the exact session owner.
- Keep terminal truth canonical: after every bounded wait, consult `session.isClosed()` before classifying the lifecycle.

## Required correction 2 — macrotask yield and post-yield terminal recheck

- When attempt 1 finishes/times out non-terminal, explicitly yield one macrotask before a possible second `session.close()` call. A microtask-only `Promise.resolve()` is insufficient.
- Immediately after the yield, call `session.isClosed()` again.
- If that post-yield query is terminal, return the conservative terminal result (`CLOSED`, cleanup anomaly retained, top-level `BLOCKED_BY_SAFETY`, original work preserved) and do not call `session.close()` a second time.
- If it remains non-terminal but the absolute cleanup deadline is reached, throw the structured safety error without starting attempt 2.
- Otherwise start attempt 2, which joins the existing Guard `closeAttempt` when the first physical close is still pending.

## Structured cleanup failure contract

Keep all existing public error fields for compatibility and add one frozen structured cleanup diagnostic, for example:

```ts
export interface InteractionCleanupFailure {
  readonly kind: 'DEADLINE_EXCEEDED' | 'ATTEMPT_BUDGET_EXHAUSTED';
  readonly attemptsStarted: number;
  readonly deadlineAtMs: number;
  readonly deadlineReached: boolean;
  readonly anomaly: 'TIMED_OUT' | 'REJECTED' | 'FULFILLED_NON_TERMINAL';
  readonly lastCloseRejected: boolean;
  readonly lastCloseError: unknown;
}
```

Equivalent naming is allowed only if the same states remain directly queryable. `InteractionOwnerCleanupError` must strongly retain the exact session, original frozen work/evidence, frozen non-terminal lifecycle, detached frozen safety snapshot, cleanup anomaly kind, attempts started, and deadline-reached state. Preserve arbitrary rejection presence separately from its value, including rejection value `undefined`.

Record a distinct deadline invariant before taking the safety snapshot. Continue recording retry exhaustion only when two settled/non-terminal attempts consume the count budget before the deadline.

## Required correction 3 — one DOM-work budget per interaction work phase

- `executeInteraction()` owns one `domWorkRemaining`, initialized once from `INTERACTION_CANDIDATE_LIMITS.maxDomWork`.
- Existing `domWorkUsed` is the accounting result. After every discovery, exact-handle resolution, initial retained inspection, repeated post-click retained inspection, and disconnected fallback rediscovery, subtract that invocation's `domWorkUsed` exactly once.
- Pass the current remaining limit into every DOM operation so no individual call can exceed the interaction remainder. `discoverInteractionCandidates`, `resolveInteractionCandidateHandle`, and `inspectInteractionCandidateHandle` may gain an optional bounded per-invocation limit whose default remains `INTERACTION_CANDIDATE_LIMITS.maxDomWork` for non-audit callers.
- Validate the supplied limit as a safe integer in `[0, maxDomWork]` and validate returned work against that exact supplied limit, not merely the global maximum.
- A zero limit performs no browser DOM traversal and returns the appropriate budget-reached result.
- If remaining reaches zero at any point, return `NOT_VERIFIABLE` with a stable interaction-wide budget reason before click, verification promotion, or any later DOM call. Exact consumption of the last unit is exhaustion for subsequent audit work.
- Keep the exact retained Handle owner/finalizer correct when exhaustion occurs after resolution. Do not leak or double-dispose the Handle.
- Preserve all existing per-call candidate/text/ordinal limits and removal of whole-DOM selector enumeration.

## Mandatory behavioral RED before production edits

Read `superpowers:test-driven-development` and its `writing-good-tests.md` reference before editing tests.

1. A raw `BrowserContext.close()` that never settles cannot keep `auditInteraction()` pending beyond the cleanup deadline. Two audit close calls may occur, but raw close ownership/count remains one. The thrown structured error retains the exact session and reports deadline reached; releasing the raw close later produces no unhandled rejection.
2. After attempt 1 times out, one macrotask yield occurs. A delayed Guard terminal transition observed after that yield prevents attempt 2.
3. A fulfilled/rejected non-terminal attempt also yields before retry; delayed Guard task/invalidation settlement can make the session terminal and suppress attempt 2.
4. A late arbitrary rejection, including `undefined`, is contained after timeout and remains structurally distinguishable if it is the latest observed rejection.
5. Multiple successful DOM calls whose individual usage is below 16,384 but whose sum reaches the interaction maximum stop with `NOT_VERIFIABLE`; the total observed accepted DOM work never exceeds 16,384.
6. Repeated post-click inspection and disconnected fallback rediscovery share the same remaining budget rather than receiving a reset.
7. Exhaustion immediately after handle resolution/inspection disposes the exact Handle once and does not click or promote `VERIFIED`.

Accepted RED must be behavioral assertion failures with current production hashes unchanged. Exclude Chromium `spawn EPERM`, compilation/import/harness failures, and unhandled rejection noise. Run test-only typecheck at the RED checkpoint; if it cannot run, record it honestly as NOT RUN.

## Production and test boundary

Expected production scope is `src/interaction/isolated-auditor.ts` and `src/interaction/discover-candidates.ts`. Change `context-factory.ts` or `passive-request-guard.ts` only if a RED proves the existing same-attempt join contract is insufficient; explain any such expansion before editing.

Expected tests are `tests/integration/isolated-interaction.test.ts`, with only narrowly necessary additions to Guard/Factory tests. Preserve requestfailed registry ownership, close/invalidation precedence, S03-S08, DOM traversal limits, structured work/lifecycle axes, and prior owner recovery.

Use `apply_patch` for edits. No Git operation. No dependency/library download, install, update, new import, or package mutation. No live target. No Task 12+. The implementer must not spawn subagents or reviewers.

## Required fresh verification

Report exact command, exit code, and counts for:

1. Task 11 focus tests.
2. raw close never settles / cleanup deadline focus.
3. close retry macrotask-yield focus, including post-timeout terminal recheck.
4. close/invalidation race focus.
5. requestfailed/close race focus.
6. `MAX_PENDING_GUARD_TASKS` focus.
7. unhandled-rejection containment focus.
8. interaction-wide DOM-work budget focus.
9. full `tests/integration/isolated-interaction.test.ts`.
10. full `tests/integration/passive-request-guard.test.ts`.
11. full `tests/component/context-factory.test.ts`.
12. six-file Task 11 regression.
13. repository full suite.
14. `npm run typecheck`.
15. `npm run build`.
16. current forbidden-boundary scans and package/lock hash check.

Every unrun item requires a NOT RUN block with command, reason, impact, and completion relevance.

## Deliverables

- `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-cleanup-deadline-interaction-dom-budget-report.md`
- replacement `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/task-11-terminal-recovery-review-package.md`
- append-only entries in `task-11-recovery-task-5-report.md` and `progress.md`

The replacement package must retain all 91 current manifest paths, add the prior independent review, this brief, and this report, then fresh-hash the complete self-nonreferential manifest. Report entries/unique/missing/mismatch/duplicate/self-reference plus substitutions/additions/removals versus the 91-entry package. Stop after implementation, verification, self-review, evidence, and package creation. Independent review is controller-owned.
