### Task 4: Give ElementHandle and audit finalization one owner each

**Files:**
- Modify: `src/interaction/isolated-auditor.ts:137-375`
- Test: `tests/integration/isolated-interaction.test.ts:536-1218`

**Interfaces:**
- Consumes: unchanged `InteractionAuditSession`, `InteractionAuditInput`, `InteractionWorkOutcome`, `SafetyLedger`, and Task 1 final guard snapshot behavior.
- Produces: unchanged `auditInteraction(input): Promise<InteractionAuditResult>`; once a session exists it returns a result even when owner close rejects. Session-factory failure still rejects.

- [ ] **Step 1: Add the handle-acquisition deadline plus dispose-failure RED**

Extend the existing ElementHandle acquisition deadline test so `elementHandle()` advances the fake clock to the deadline and returns a handle whose `dispose()` throws.

```ts
expect(result.status).toBe('NOT_VERIFIABLE');
expect(result.reason).toBe('Interaction deadline expired during target handle acquisition');
expect(result.evidence.after).toBeNull();
expect(result.safety.invariantViolations).toContainEqual({
  code: 'INTERACTION_HANDLE_DISPOSE_FAILED',
  message: 'deadline handle dispose failed',
});
```

- [ ] **Step 2: Replace the old AggregateError expectation with work-outcome plus close-failure RED**

Change `preserves both work and owner-close failures` to require a returned safety result. Add a second case where click mutates evidence, throws an ordinary Error, and `session.close()` rejects.

```ts
expect(result.status).toBe('BLOCKED_BY_SAFETY');
expect(result.reason).toContain('EXECUTION_FAILED');
expect(result.reason).toContain('original click failure');
expect(result.evidence.changedFields).toContain('ariaExpanded');
expect(result.safety.invariantViolations).toContainEqual({
  code: 'INTERACTION_OWNER_CLOSE_FAILED',
  message: 'fixture close failed',
});
```

For an unexpected `goto()` throw plus close rejection, assert both messages are observable through final reason and Safety Ledger.

- [ ] **Step 3: Run the new tests and verify genuine RED**

Run:

```powershell
npm test -- --run tests/integration/isolated-interaction.test.ts -t "deadline handle dispose failed|work and owner-close failures|click failure and owner close"
```

Expected: current pre-`try` dispose rejection overwrites NOT_VERIFIABLE, and current close branch rejects/discards the encoded work outcome.

- [ ] **Step 4: Move every non-null Handle path under one finalizer**

After `elementHandle()` returns, check only `null` outside the owner scope. Put the deadline check and every later return inside:

```ts
if (targetHandle === null) {
  return outcome('NOT_VERIFIABLE', 'Candidate target handle was not resolved', emptyEvidence(before));
}
try {
  if (remaining() === 0) {
    return outcome(
      'NOT_VERIFIABLE',
      'Interaction deadline expired during target handle acquisition',
      emptyEvidence(before),
    );
  }
  const resolvedSnapshot = await inspectInteractionCandidateHandle(targetHandle, before.ordinal);
  if (remaining() === 0) {
    return outcome('NOT_VERIFIABLE', 'Interaction deadline expired during target fact collection', emptyEvidence(before));
  }
  if (!resolvedSnapshot.connected) {
    return outcome('NOT_VERIFIABLE', 'Candidate target disconnected before admission', emptyEvidence(before));
  }
  const resolvedCandidate = resolvedSnapshot.candidate;
  if (resolvedCandidate.candidateId !== before.candidateId) {
    return outcome('NOT_VERIFIABLE', 'Candidate target changed during exact-node resolution', emptyEvidence(before));
  }
  const exactAdmission = classifyInteractionCandidate(resolvedCandidate);
  if (remaining() === 0) {
    return outcome('NOT_VERIFIABLE', 'Interaction deadline expired during exact-node admission', emptyEvidence(before));
  }
  if (exactAdmission.action === 'REJECT') {
    if (['EXTERNAL_ACTION', 'NAVIGATION_HREF', 'DOWNLOAD'].includes(exactAdmission.reason)) {
      session.ledger.recordBlockedExternalAction({
        candidateId: resolvedCandidate.candidateId,
        url: resolvedCandidate.href,
        reason: exactAdmission.reason,
      });
    }
    return outcome('REJECTED_UNSAFE', exactAdmission.reason, matchedPreInteractionEvidence(resolvedCandidate));
  }

  const clickBudgetMs = remaining();
  if (clickBudgetMs === 0 || Date.now() >= effectiveDeadlineAtMs) {
    return outcome('NOT_VERIFIABLE', 'Interaction deadline expired before exact-node click', emptyEvidence(resolvedCandidate));
  }
  let clickFailed = false;
  let clickError: unknown;
  try {
    await targetHandle.click({ timeout: clickBudgetMs });
  } catch (error) {
    clickFailed = true;
    clickError = error;
  }

  let lastEvidence = emptyEvidence(resolvedCandidate);
  while (true) {
    let identityLossReason: string | undefined;
    let observationDeadlineExpired = false;
    const safety = session.ledger.snapshot();
    if (hasFreezeEvent(safety)) {
      return outcome('BLOCKED_BY_SAFETY', 'Interaction activity was blocked by safety freeze', lastEvidence);
    }
    if (clickFailed && remaining() === 0) {
      return clickFailureOutcome(clickError, lastEvidence);
    }
    if (remaining() === 0) {
      return outcome('NOT_VERIFIABLE', 'Interaction deadline expired before post-condition observation', lastEvidence);
    }
    try {
      const retainedSnapshot = await inspectInteractionCandidateHandle(targetHandle, resolvedCandidate.ordinal);
      observationDeadlineExpired = remaining() === 0;
      if (retainedSnapshot.connected) {
        lastEvidence = collectInteractionChangeEvidence(resolvedCandidate, retainedSnapshot.candidate);
      } else if (!observationDeadlineExpired) {
        const liveCandidates = await discoverInteractionCandidates(session.page);
        observationDeadlineExpired = remaining() === 0;
        lastEvidence = collectDisconnectedInteractionEvidence(resolvedCandidate, liveCandidates);
        identityLossReason = `Retained candidate identity became ${lastEvidence.identityStatus}`;
      }
    } catch (error) {
      if (hasFreezeEvent(session.ledger.snapshot())) {
        return outcome('BLOCKED_BY_SAFETY', 'Interaction activity was blocked by safety freeze', lastEvidence);
      }
      throw error;
    }
    const afterObservationSafety = session.ledger.snapshot();
    if (hasFreezeEvent(afterObservationSafety)) {
      return outcome('BLOCKED_BY_SAFETY', 'Interaction activity was blocked by safety freeze', lastEvidence);
    }
    if (clickFailed) return clickFailureOutcome(clickError, lastEvidence);
    if (identityLossReason !== undefined) return outcome('NOT_VERIFIABLE', identityLossReason, lastEvidence);
    if (observationDeadlineExpired || remaining() === 0) {
      return outcome('NOT_VERIFIABLE', 'Interaction deadline expired during post-condition observation', lastEvidence);
    }
    if (lastEvidence.identityStatus === 'MATCHED' && lastEvidence.changedFields.length > 0) {
      return outcome('VERIFIED', 'Observable interaction state changed', lastEvidence);
    }
    if (!await awaitInitialRender(session.page, effectiveDeadlineAtMs)) {
      return outcome('NOT_VERIFIABLE', 'No observable change before interaction deadline', lastEvidence);
    }
  }
} finally {
  try {
    await targetHandle.dispose();
  } catch (error) {
    session.ledger.recordInvariantViolation({
      code: 'INTERACTION_HANDLE_DISPOSE_FAILED',
      message: errorMessage(error),
    });
  }
}
```

Delete the old pre-`try` `remaining() === 0` branch and its optional dispose. This scope must be the only owner of the non-null Handle.

- [ ] **Step 5: Collapse audit work and close errors into one result finalizer**

Make `workOutcome` always exist before owner close:

```ts
let workOutcome: InteractionWorkOutcome;
try {
  workOutcome = await executeInteraction(session, input, candidate, effectiveDeadlineAtMs);
} catch (error) {
  workOutcome = outcome('EXECUTION_FAILED', errorMessage(error), emptyEvidence(candidate));
}

let closeError: unknown;
try {
  await session.close();
} catch (error) {
  closeError = error;
  session.ledger.recordInvariantViolation({
    code: 'INTERACTION_OWNER_CLOSE_FAILED',
    message: errorMessage(error),
  });
}

const finalSafety = session.ledger.snapshot();
const finalOutcome = finalizeInteractionOutcome(workOutcome, closeError, finalSafety);
```

The pure finalizer is:

```ts
function finalizeInteractionOutcome(
  work: InteractionWorkOutcome,
  closeError: unknown,
  safety: SafetyLedgerSnapshot,
): InteractionWorkOutcome {
  if (closeError !== undefined) {
    return outcome(
      'BLOCKED_BY_SAFETY',
      `Interaction owner close failed after ${work.status}: ${work.reason}`,
      work.evidence,
    );
  }
  if (hasFreezeEvent(safety)) {
    return outcome('BLOCKED_BY_SAFETY', 'Interaction activity was blocked by safety freeze', work.evidence);
  }
  return work;
}
```

Do not catch `input.sessionFactory()` failure because no session/evidence owner exists yet.

- [ ] **Step 6: Run all isolated interaction tests, focused Task 11, and typecheck**

Run:

```powershell
npm test -- --run tests/unit/interaction-policy.test.ts tests/integration/isolated-interaction.test.ts
npm test -- --run tests/unit/request-policy.test.ts tests/unit/safety-ledger.test.ts tests/component/context-factory.test.ts tests/integration/passive-request-guard.test.ts tests/integration/isolated-interaction.test.ts
npm run typecheck
```

Expected: all selected tests PASS; original click/timeout/freeze evidence precedence remains intact.

- [ ] **Step 7: Record the no-Git checkpoint and request fresh specification review**

Record hashes for `isolated-auditor.ts` and `isolated-interaction.test.ts`, plus RED/GREEN outputs. The reviewer must explicitly adjudicate pre-deadline disposal, encoded work plus close failure, session-factory rejection, immutable evidence, and final freeze precedence.

---

