# Task 11 terminal recovery — Task 1 fix round 1

Date: 2026-09-20. Scope: independent-review findings I1 and I2 only. Authority: the fixed round-1 brief, complete independent review, approved terminal-recovery design and Task 1 implementation plan. Independent re-review is controller-owned.

## Frozen baseline and genuine RED

Before test edits, all six source/test/package baseline hashes matched the fixed brief. After adding tests and running RED, both production hashes were rechecked and remained frozen:

- `src/safety/passive-request-guard.ts`: `0B4F289617A4FE148F5B75D2E384A2A095F68244D69DCBC5A832BD4A8D2305C2`.
- `src/browser/context-factory.ts`: `6690D8EBEDD061602B1D3417602F80E3E263D9A4FB6677AB304712EB782D0508`.

Exact focused command: `npm test -- --run tests/integration/passive-request-guard.test.ts -t "fix round 1"`.

Initial default-sandbox run: exit 1, 114 skipped; browser launch failed with `spawn EPERM`, followed by teardown on an uninitialized browser. This is environment evidence, not RED. The identical command using approved process-launch escalation with already-installed Chromium: exit 1, 5 failed / 109 skipped / 114 total. No package installation or download occurred.

| Test | Genuine failure / mutation killed |
| --- | --- |
| fix round 1 HTTP callback retains its SYNC_THROW raw-close failure until explicit retry | Received protocol abort error instead of first raw-close failure; kills reacquiring an invalidation attempt after immediate synchronous failure. |
| fix round 1 HTTP callback retains its DIRECT_REJECT raw-close failure until explicit retry | Same wrong causal outcome at direct rejected-Promise boundary; kills accidental retry hidden by async-adoption timing. |
| fix round 1 WEBSOCKET callback retains its SYNC_THROW raw-close failure until explicit retry | Callback fulfilled instead of rejecting; kills implicit second physical close and hidden first failure. |
| fix round 1 WEBSOCKET callback retains its DIRECT_REJECT raw-close failure until explicit retry | Callback fulfilled instead of rejecting; kills the corresponding direct Promise rejection race. |
| fix round 1 contains hostile raw-close rejection from an unobserved requestfailed event | Process observer captured `hostile error prototype access`; kills unsafe classification before bounded normalization. |

Each protocol case also requires exactly one raw call and non-terminal fail-closed state before an explicit owner retry, then exactly two calls and CLOSED after that retry. The event case requires both bounded raw-close and initiation-failure ledger entries, no escaped rejection, retained retryability, and terminal recovery through the owner. These exercise installed production callbacks; the close boundary alone is controlled. No source-mutating mutation run is claimed.

## Minimum correction and self-review

I1: the protocol task captures one `invalidateContext()` Promise in its existing synchronous promotion point after removing itself from pending work. Both immediate rejection containment and the callback's semantic wait observe this same Promise. The continuation no longer invokes the retry-capable owner again. A raw failure retains its original identity at the callback, even after the shared attempt reference has cleared.

I2: `containInvalidationFailure()` contains prototype-inspection exceptions before passing the original arbitrary rejection to the existing bounded `errorMessage()` normalizer. Both ordinary event initiation and the retained protocol Promise use that helper. Known drain timeout errors retain their existing no-duplicate-owner-ledger behavior; hostile values produce bounded owner-failure ledger entries without rejecting the containment Promise.

Self-review: the shared close owner, publication barrier, explicit retry entry points, phase transitions, raw-close confirmation, stable task drain, overflow owner, listener cleanup, factory/session release, and primary page/install cause handling are unchanged. Existing regressions verify these contracts. No type escape, new public interface, retry loop, retry policy, or lifecycle authority was added. The new callback-local Promise is observation of one attempt, not a lifecycle owner. No known unresolved I1/I2 concern remains; this is implementer assessment pending independent re-review. Historical deferred Minors are unchanged.

## Fresh GREEN and regression evidence

All commands below exited 0. Browser tests used approved process-launch escalation for already-installed Chromium and local fixture servers. Typecheck used the default sandbox. No warnings or unhandled errors appeared in final test results; npm's available-upgrade notice was informational and no upgrade occurred.

| Exact command | Result |
| --- | --- |
| `npm test -- --run tests/integration/passive-request-guard.test.ts -t "fix round 1"` | 1 file; 5 passed / 109 skipped / 114 total; 0.764 s |
| `npm test -- --run tests/integration/passive-request-guard.test.ts tests/component/context-factory.test.ts -t "retry\|drain-only\|retained close\|synchronous re-entry\|lifecycle priority\|round 5\|fix round 1"` | 2 files; 28 passed / 105 skipped / 133 total; 1.88 s |
| `npm test -- --run tests/component/context-factory.test.ts tests/integration/passive-request-guard.test.ts` | 2 files; 133 passed / 0 failed; 6.15 s |
| `npm run typecheck` | strict TypeScript check passed |
| `npm test` | 26 files; 454 passed / 0 failed; 15.54 s |

The expanded filter's Markdown table escapes pipes; the literal shell filter is `"retry|drain-only|retained close|synchronous re-entry|lifecycle priority|round 5|fix round 1"`. No additional production/test edit followed these successful runs.

## Final source/package hashes

| Path | SHA-256 | Round-1 disposition |
| --- | --- | --- |
| `src/safety/passive-request-guard.ts` | `E5E3DE0D7ABBE72D1786B5F1FA8EC920F98C7D6939656B8CFE2DB7FBAC1DECCB` | modified |
| `tests/integration/passive-request-guard.test.ts` | `F51487F71FED96760EA8FA36FC923D8648AE90CAE3EE54EDBE635138514D6BDF` | modified |
| `src/browser/context-factory.ts` | `6690D8EBEDD061602B1D3417602F80E3E263D9A4FB6677AB304712EB782D0508` | unchanged |
| `tests/component/context-factory.test.ts` | `F43C49FC11C9915987DF8031A31EA3F040F43ACA2209E793A6D05F087A11BDC9` | unchanged |
| `package.json` | `75E99161E042E79624E81CE5273C5D5C7A1F9A38814E6279D72E8F111911D233` | unchanged |
| `package-lock.json` | `A9396CA36AE11922A508EDEF54B290930AB711D77D893E7AB132CC1D944E365A` | unchanged |

Additional changed paths, all under `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/`: appended `task-11-terminal-recovery-task-1-report.md`, `task-11-recovery-task-5-report.md`, and `progress.md`; created this `task-11-terminal-recovery-task-1-fix-round-1-report.md` and `task-11-terminal-recovery-task-1-fix-round-1-manifest.md`. The new manifest pins the final report/ledger hashes without self-reference. Historical report text is preserved; the new append supersedes only prior claims contradicted by I1/I2. The failed review remains byte-identical at `9318B93745062A258948B00061692C5BB319275B38FA065BB64F9593E1C9FD4C`; the historical package index is untouched at `32597D2FB33DDEB31E564F6AE022232FEFE99DE176BBB3C9019B285E614DEE45`. Its original report hashes remain historical snapshots and are not rewritten.

## Status, remaining gates, constraints

Round-1 implementation and required executed verification complete; independent re-review pending. Task 1 checkpoint approval is not claimed. Task 2+ and Task 12 remain blocked.

NOT RUN — independent Task 1 re-review; reason: controller-owned and prohibited for this implementer; impact: I1/I2 adjudication and checkpoint approval remain pending; completion blocker: yes for Task 1 approval and Task 2 start.

NOT RUN — `npm run build`; reason: explicitly forbidden in this fix round; impact: no fresh emitted-output verification; completion blocker: no for this fix handoff, yes for eventual Task 11 approval.

NOT RUN — Task 2/3/4/12 implementation and their correction-specific gates; reason: outside fixed scope; impact: DOM-budget/structured-outcome/final acceptance work is not advanced; completion blocker: yes for Task 11 overall, no for this fix handoff.

Constraint confirmation: no Git operations; no dependency/library download, install, new import, or package mutation; no live-target access; no subagents/reviewers; no Task 2/3/4/12 work; no non-scoped source/test edits; unrelated changes preserved. Only `apply_patch` was used for file edits. TDD/systematic-debugging and verification-before-completion skills guided reproduction, minimum correction, and fresh evidence. No skill introduced an additional approval or unfinished implementation step.
