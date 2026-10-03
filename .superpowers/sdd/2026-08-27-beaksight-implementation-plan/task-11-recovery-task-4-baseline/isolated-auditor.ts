import type { Page } from 'playwright';
import type { InteractionGuardedSession } from '../browser/context-factory.js';
import type { Viewport } from '../config/types.js';
import type { InteractionStatus } from '../core/contracts.js';
import {
  collectInteractionChangeEvidence,
  collectDisconnectedInteractionEvidence,
  type InteractionChangeEvidence,
} from '../evidence/interaction-collector.js';
import { type SafetyLedgerSnapshot } from '../safety/safety-ledger.js';
import {
  classifyInteractionCandidate,
  freezeInteractionCandidate,
  type InteractionCandidate,
} from '../safety/interaction-policy.js';
import {
  discoverInteractionCandidates,
  inspectInteractionCandidateHandle,
  INTERACTION_CANDIDATE_SELECTOR,
} from './discover-candidates.js';

export type InteractionAuditSession = InteractionGuardedSession;

export interface InteractionAuditInput {
  readonly sessionFactory: (viewport: Viewport) => Promise<InteractionAuditSession>;
  readonly targetUrl: string;
  readonly candidate: InteractionCandidate;
  readonly viewport: Viewport;
  readonly timeoutMs: number;
  readonly deadlineAtMs: number;
}

export interface InteractionAuditResult {
  readonly candidateId: string;
  readonly status: InteractionStatus;
  readonly reason: string;
  readonly evidence: InteractionChangeEvidence;
  readonly safety: SafetyLedgerSnapshot;
}

interface InteractionWorkOutcome {
  readonly status: InteractionStatus;
  readonly reason: string;
  readonly evidence: InteractionChangeEvidence;
}

const MAX_INTERACTION_REASON_LENGTH = 512;

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, MAX_INTERACTION_REASON_LENGTH);
}

function emptyEvidence(
  before: InteractionCandidate | null = null,
  identityStatus: 'MISSING' | 'AMBIGUOUS' = 'MISSING',
): InteractionChangeEvidence {
  return Object.freeze({
    before,
    after: null,
    identityStatus,
    changedFields: Object.freeze([]),
  });
}

function matchedPreInteractionEvidence(before: InteractionCandidate): InteractionChangeEvidence {
  return Object.freeze({
    before,
    after: null,
    identityStatus: 'MATCHED',
    changedFields: Object.freeze([]),
  });
}

function outcome(
  status: InteractionStatus,
  reason: string,
  evidence: InteractionChangeEvidence,
): InteractionWorkOutcome {
  return Object.freeze({ status, reason: reason.slice(0, MAX_INTERACTION_REASON_LENGTH), evidence });
}

function clickFailureOutcome(
  clickError: unknown,
  evidence: InteractionChangeEvidence,
): InteractionWorkOutcome {
  const timedOut = clickError instanceof Error && clickError.name === 'TimeoutError';
  return outcome(
    timedOut ? 'NOT_VERIFIABLE' : 'EXECUTION_FAILED',
    errorMessage(clickError),
    evidence,
  );
}

function hasFreezeEvent(snapshot: SafetyLedgerSnapshot): boolean {
  return snapshot.blockedInteractionRequests.length > 0
    || snapshot.blockedInteractionNavigations.length > 0
    || snapshot.blockedPopups.length > 0
    || snapshot.blockedDownloads.length > 0
    || snapshot.blockedInteractionWebSockets.length > 0;
}

function positiveFiniteInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite integer`);
  }
}

function immutableViewport(viewport: Viewport): Viewport {
  positiveFiniteInteger(viewport.width, 'Interaction viewport width');
  positiveFiniteInteger(viewport.height, 'Interaction viewport height');
  return Object.freeze({ width: viewport.width, height: viewport.height });
}

async function awaitInitialRender(page: Page, deadlineAtMs: number): Promise<boolean> {
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) {
    return false;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const observed = await Promise.race([
      page.evaluate(() => new Promise<true>((resolveFrame) => {
        requestAnimationFrame(() => resolveFrame(true));
      })),
      new Promise<false>((resolveDeadline) => {
        timer = setTimeout(() => resolveDeadline(false), remainingMs);
      }),
    ]);
    return observed && Date.now() < deadlineAtMs;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function executeInteraction(
  session: InteractionAuditSession,
  input: InteractionAuditInput,
  candidate: InteractionCandidate,
  effectiveDeadlineAtMs: number,
): Promise<InteractionWorkOutcome> {
  const remaining = (): number => Math.max(0, effectiveDeadlineAtMs - Date.now());
  const navigationBudgetMs = remaining();
  if (navigationBudgetMs === 0) {
    return outcome('NOT_VERIFIABLE', 'Interaction deadline expired before initial load', emptyEvidence(candidate));
  }
  await session.page.goto(input.targetUrl, {
    waitUntil: 'load',
    timeout: navigationBudgetMs,
  });
  if (remaining() === 0) {
    return outcome('NOT_VERIFIABLE', 'Interaction deadline expired after initial load', emptyEvidence(candidate));
  }
  if (!await awaitInitialRender(session.page, effectiveDeadlineAtMs)) {
    return outcome('NOT_VERIFIABLE', 'Interaction deadline expired before initial render', emptyEvidence(candidate));
  }
  await session.activateInteractionFreeze();
  if (remaining() === 0) {
    return outcome('NOT_VERIFIABLE', 'Interaction deadline expired after safety freeze', emptyEvidence(candidate));
  }

  const rediscovered = await discoverInteractionCandidates(session.page);
  if (remaining() === 0) {
    return outcome('NOT_VERIFIABLE', 'Interaction deadline expired during candidate rediscovery', emptyEvidence(candidate));
  }
  const matching = rediscovered.filter((item) => item.candidateId === candidate.candidateId);
  if (matching.length !== 1) {
    return outcome(
      'NOT_VERIFIABLE',
      matching.length === 0 ? 'Candidate identity was not rediscovered' : 'Candidate identity was ambiguous',
      emptyEvidence(candidate, matching.length === 0 ? 'MISSING' : 'AMBIGUOUS'),
    );
  }
  const before = matching[0] as InteractionCandidate;
  if (remaining() === 0) {
    return outcome('NOT_VERIFIABLE', 'Interaction deadline expired before target locator resolution', emptyEvidence(before));
  }
  const candidateLocator = session.page.locator(INTERACTION_CANDIDATE_SELECTOR);
  if (remaining() === 0) {
    return outcome('NOT_VERIFIABLE', 'Interaction deadline expired during target locator resolution', emptyEvidence(before));
  }
  const targetLocator = candidateLocator.nth(before.ordinal);
  if (remaining() === 0) {
    return outcome('NOT_VERIFIABLE', 'Interaction deadline expired during target ordinal resolution', emptyEvidence(before));
  }
  const handleBudgetMs = remaining();
  if (handleBudgetMs === 0) {
    return outcome('NOT_VERIFIABLE', 'Interaction deadline expired before target handle acquisition', emptyEvidence(before));
  }
  const targetHandle = await targetLocator.elementHandle({ timeout: handleBudgetMs });
  if (remaining() === 0) {
    await targetHandle?.dispose();
    return outcome('NOT_VERIFIABLE', 'Interaction deadline expired during target handle acquisition', emptyEvidence(before));
  }
  if (targetHandle === null) {
    return outcome('NOT_VERIFIABLE', 'Candidate target handle was not resolved', emptyEvidence(before));
  }

  try {
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
      if (clickFailed) {
        return clickFailureOutcome(clickError, lastEvidence);
      }
      if (identityLossReason !== undefined) {
        return outcome('NOT_VERIFIABLE', identityLossReason, lastEvidence);
      }
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
}

export async function auditInteraction(input: InteractionAuditInput): Promise<InteractionAuditResult> {
  if (typeof input.sessionFactory !== 'function') {
    throw new Error('An owner-managed interaction session factory is required');
  }
  positiveFiniteInteger(input.timeoutMs, 'Interaction timeout');
  if (!Number.isFinite(input.deadlineAtMs)) {
    throw new Error('Interaction deadline must be finite');
  }
  let targetUrl: URL;
  try {
    targetUrl = new URL(input.targetUrl);
  } catch {
    throw new Error('Interaction target URL must be absolute');
  }
  if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
    throw new Error('Interaction target URL must use HTTP(S)');
  }
  const candidate = freezeInteractionCandidate(input.candidate);
  const viewport = immutableViewport(input.viewport);
  const effectiveDeadlineAtMs = Math.min(input.deadlineAtMs, Date.now() + input.timeoutMs);
  if (effectiveDeadlineAtMs <= Date.now()) {
    throw new Error('Interaction deadline has already expired');
  }

  const session = await input.sessionFactory(viewport);
  let workFailed = false;
  let workError: unknown;
  let workOutcome: InteractionWorkOutcome | undefined;
  let closeFailed = false;
  let closeError: unknown;
  try {
    workOutcome = await executeInteraction(session, input, candidate, effectiveDeadlineAtMs);
  } catch (error) {
    workFailed = true;
    workError = error;
  } finally {
    try {
      await session.close();
    } catch (error) {
      closeFailed = true;
      closeError = error;
    }
  }
  if (workFailed && closeFailed) {
    throw new AggregateError([workError, closeError], 'Interaction work and owner close both failed');
  }
  if (closeFailed) {
    throw closeError;
  }
  if (workFailed) {
    const safety = session.ledger.snapshot();
    workOutcome = hasFreezeEvent(safety)
      ? outcome('BLOCKED_BY_SAFETY', errorMessage(workError), emptyEvidence(candidate))
      : outcome('EXECUTION_FAILED', errorMessage(workError), emptyEvidence(candidate));
  }
  if (workOutcome === undefined) {
    throw new Error('Interaction audit produced no outcome');
  }
  const finalSafety = session.ledger.snapshot();
  const finalOutcome = hasFreezeEvent(finalSafety)
    ? outcome('BLOCKED_BY_SAFETY', 'Interaction activity was blocked by safety freeze', workOutcome.evidence)
    : workOutcome;
  return Object.freeze({
    candidateId: candidate.candidateId,
    status: finalOutcome.status,
    reason: finalOutcome.reason,
    evidence: finalOutcome.evidence,
    safety: finalSafety,
  });
}
