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
  INTERACTION_CANDIDATE_LIMITS,
  type InteractionCandidate,
} from '../safety/interaction-policy.js';
import {
  discoverInteractionCandidates,
  inspectInteractionCandidateHandle,
  resolveInteractionCandidateHandle,
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
  readonly work: InteractionWorkOutcome;
  readonly lifecycle: InteractionLifecycleOutcome;
  readonly safety: SafetyLedgerSnapshot;
}

export interface InteractionWorkOutcome {
  readonly status: InteractionStatus;
  readonly reason: string;
  readonly evidence: InteractionChangeEvidence;
}

export type InteractionLifecycleOutcome =
  | { readonly status: 'CLOSED'; readonly reason: string | null }
  | { readonly status: 'NON_TERMINAL'; readonly reason: string };

const MAX_INTERACTION_REASON_LENGTH = 512;
const INTERACTION_OWNER_CLOSE_ATTEMPT_LIMIT = 2;
const INTERACTION_OWNER_CLEANUP_EXHAUSTED_MESSAGE = 'Interaction owner cleanup retry budget exhausted';
const INTERACTION_OWNER_CLOSE_TIMEOUT_REASON = 'Interaction owner close timed out before terminal Guard state';
const INTERACTION_OWNER_CLEANUP_DEADLINE_MESSAGE = 'Interaction owner cleanup deadline exceeded';
const INTERACTION_DOM_WORK_EXHAUSTED_REASON = 'Interaction-wide DOM work budget exhausted';
const UNINSPECTABLE_INTERACTION_ERROR_MESSAGE = 'Interaction error could not be safely normalized';

export interface InteractionCleanupFailure {
  readonly kind: 'DEADLINE_EXCEEDED' | 'ATTEMPT_BUDGET_EXHAUSTED';
  readonly attemptsStarted: number;
  readonly deadlineAtMs: number;
  readonly deadlineReached: boolean;
  readonly anomaly: 'TIMED_OUT' | 'REJECTED' | 'FULFILLED_NON_TERMINAL';
  readonly lastCloseRejected: boolean;
  readonly lastCloseError: unknown;
}

/** クリーンアップに許された時間を使い切った後、まだ生存しているセッションの所有権を引き継ぐ。 */
export class InteractionOwnerCleanupError extends Error {
  readonly session: InteractionAuditSession;
  readonly candidateId: string;
  readonly work: InteractionWorkOutcome;
  readonly lifecycle: Extract<InteractionLifecycleOutcome, { readonly status: 'NON_TERMINAL' }>;
  readonly safety: SafetyLedgerSnapshot;
  readonly lastCloseRejected: boolean;
  readonly lastCloseError: unknown;
  readonly cleanup: InteractionCleanupFailure;

  constructor(input: {
    readonly session: InteractionAuditSession;
    readonly candidateId: string;
    readonly work: InteractionWorkOutcome;
    readonly lifecycle: Extract<InteractionLifecycleOutcome, { readonly status: 'NON_TERMINAL' }>;
    readonly safety: SafetyLedgerSnapshot;
    readonly lastCloseRejected: boolean;
    readonly lastCloseError: unknown;
    readonly cleanup: InteractionCleanupFailure;
  }) {
    super(INTERACTION_OWNER_CLEANUP_EXHAUSTED_MESSAGE);
    this.name = 'InteractionOwnerCleanupError';
    this.session = input.session;
    this.candidateId = input.candidateId;
    this.work = input.work;
    this.lifecycle = input.lifecycle;
    this.safety = input.safety;
    this.lastCloseRejected = input.lastCloseRejected;
    this.lastCloseError = input.lastCloseError;
    this.cleanup = input.cleanup;
    Object.freeze(this);
  }
}

function errorMessage(error: unknown): string {
  try {
    if (error instanceof Error) {
      const message = error.message;
      return typeof message === 'string'
        ? message.slice(0, MAX_INTERACTION_REASON_LENGTH)
        : UNINSPECTABLE_INTERACTION_ERROR_MESSAGE;
    }
    return String(error).slice(0, MAX_INTERACTION_REASON_LENGTH);
  } catch {
    return UNINSPECTABLE_INTERACTION_ERROR_MESSAGE;
  }
}

function isTimeoutError(error: unknown): boolean {
  try {
    return error instanceof Error && error.name === 'TimeoutError';
  } catch {
    return false;
  }
}

function emptyEvidence(
  before: InteractionCandidate | null = null,
  identityStatus: 'MISSING' | 'AMBIGUOUS' | 'UNESTABLISHED' = 'UNESTABLISHED',
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

function closedLifecycle(
  reason: string | null,
): Extract<InteractionLifecycleOutcome, { readonly status: 'CLOSED' }> {
  return Object.freeze({
    status: 'CLOSED',
    reason: reason === null ? null : reason.slice(0, MAX_INTERACTION_REASON_LENGTH),
  });
}

function nonTerminalLifecycle(
  reason: string,
): Extract<InteractionLifecycleOutcome, { readonly status: 'NON_TERMINAL' }> {
  return Object.freeze({
    status: 'NON_TERMINAL',
    reason: reason.slice(0, MAX_INTERACTION_REASON_LENGTH),
  });
}

function clickFailureOutcome(
  clickError: unknown,
  evidence: InteractionChangeEvidence,
): InteractionWorkOutcome {
  const timedOut = isTimeoutError(clickError);
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

function finalizeInteractionOutcome(
  work: InteractionWorkOutcome,
  lifecycle: InteractionLifecycleOutcome,
  cleanupAnomaly: boolean,
  safety: SafetyLedgerSnapshot,
): { readonly status: InteractionStatus; readonly reason: string } {
  if (hasFreezeEvent(safety)) {
    return Object.freeze({
      status: 'BLOCKED_BY_SAFETY',
      reason: 'Interaction activity was blocked by safety freeze',
    });
  }
  if (lifecycle.status === 'NON_TERMINAL') {
    return Object.freeze({
      status: 'BLOCKED_BY_SAFETY',
      reason: 'Interaction owner lifecycle did not reach terminal state',
    });
  }
  if (cleanupAnomaly) {
    return Object.freeze({
      status: 'BLOCKED_BY_SAFETY',
      reason: 'Interaction owner close reported a safety failure',
    });
  }
  return Object.freeze({ status: work.status, reason: work.reason });
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

type CloseSettlement =
  | { readonly status: 'FULFILLED' }
  | { readonly status: 'REJECTED'; readonly error: unknown };

type BoundedCloseSettlement = CloseSettlement | { readonly status: 'TIMED_OUT' };

function containedCloseSettlement(session: InteractionAuditSession): Promise<CloseSettlement> {
  return Promise.resolve()
    .then(() => session.close())
    .then(
      (): CloseSettlement => Object.freeze({ status: 'FULFILLED' }),
      (error: unknown): CloseSettlement => Object.freeze({ status: 'REJECTED', error }),
    );
}

async function observeCloseUntil(
  settlement: Promise<CloseSettlement>,
  deadlineAtMs: number,
): Promise<BoundedCloseSettlement> {
  const remainingMs = Math.max(0, deadlineAtMs - Date.now());
  if (remainingMs === 0) return Object.freeze({ status: 'TIMED_OUT' });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      settlement,
      new Promise<BoundedCloseSettlement>((resolve) => {
        timer = setTimeout(() => resolve(Object.freeze({ status: 'TIMED_OUT' })), remainingMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function yieldMacrotask(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function executeInteraction(
  session: InteractionAuditSession,
  input: InteractionAuditInput,
  candidate: InteractionCandidate,
  effectiveDeadlineAtMs: number,
): Promise<InteractionWorkOutcome> {
  const remaining = (): number => Math.max(0, effectiveDeadlineAtMs - Date.now());
  let domWorkRemaining = INTERACTION_CANDIDATE_LIMITS.maxDomWork;
  const debitDomWork = (domWorkUsed: number): boolean => {
    if (!Number.isSafeInteger(domWorkUsed) || domWorkUsed < 0 || domWorkUsed > domWorkRemaining) {
      throw new Error('Interaction DOM work exceeded the remaining bounded contract');
    }
    domWorkRemaining -= domWorkUsed;
    return domWorkRemaining === 0;
  };
  const domWorkExhausted = (before: InteractionCandidate): InteractionWorkOutcome => outcome(
    'NOT_VERIFIABLE',
    INTERACTION_DOM_WORK_EXHAUSTED_REASON,
    emptyEvidence(before, 'UNESTABLISHED'),
  );
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

  const rediscoveredResult = await discoverInteractionCandidates(session.page, domWorkRemaining);
  if (debitDomWork(rediscoveredResult.domWorkUsed)) {
    return domWorkExhausted(candidate);
  }
  if (remaining() === 0) {
    return outcome('NOT_VERIFIABLE', 'Interaction deadline expired during candidate rediscovery', emptyEvidence(candidate));
  }
  const rediscovered = rediscoveredResult.candidates;
  const matching = rediscovered.filter((item) => item.candidateId === candidate.candidateId);
  if (matching.length === 0 && rediscoveredResult.completeness !== 'COMPLETE') {
    return outcome(
      'NOT_VERIFIABLE',
      `Candidate rediscovery was incomplete: ${rediscoveredResult.completeness}`,
      emptyEvidence(candidate, 'UNESTABLISHED'),
    );
  }
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
  const handleBudgetMs = remaining();
  if (handleBudgetMs === 0) {
    return outcome('NOT_VERIFIABLE', 'Interaction deadline expired before target handle acquisition', emptyEvidence(before));
  }
  const resolution = await resolveInteractionCandidateHandle(session.page, before.ordinal, domWorkRemaining);
  const resolutionExhaustedInteractionBudget = debitDomWork(resolution.domWorkUsed);
  if (resolution.status !== 'FOUND' && resolutionExhaustedInteractionBudget) {
    return domWorkExhausted(before);
  }
  if (resolution.status === 'MISSING') {
    return outcome('NOT_VERIFIABLE', 'Candidate target handle was not resolved', emptyEvidence(before, 'MISSING'));
  }
  if (resolution.status === 'DOM_WORK_BUDGET_REACHED') {
    return outcome(
      'NOT_VERIFIABLE',
      'Candidate target handle resolution exhausted DOM work budget',
      emptyEvidence(before, 'UNESTABLISHED'),
    );
  }
  const targetHandle = resolution.handle;

  try {
    if (resolutionExhaustedInteractionBudget) {
      return domWorkExhausted(before);
    }
    if (remaining() === 0) {
      return outcome('NOT_VERIFIABLE', 'Interaction deadline expired during target handle acquisition', emptyEvidence(before));
    }
    const resolvedSnapshot = await inspectInteractionCandidateHandle(targetHandle, before.ordinal, domWorkRemaining);
    if (debitDomWork(resolvedSnapshot.domWorkUsed)) {
      return domWorkExhausted(before);
    }
    if (remaining() === 0) {
      return outcome('NOT_VERIFIABLE', 'Interaction deadline expired during target fact collection', emptyEvidence(before));
    }
    if (resolvedSnapshot.status === 'DOM_WORK_BUDGET_REACHED') {
      return outcome(
        'NOT_VERIFIABLE',
        'Candidate target inspection exhausted DOM work budget',
        emptyEvidence(before, 'UNESTABLISHED'),
      );
    }
    if (resolvedSnapshot.status === 'CANDIDATE_LIMIT_REACHED') {
      return outcome(
        'NOT_VERIFIABLE',
        'Candidate target inspection reached candidate limit',
        emptyEvidence(before, 'UNESTABLISHED'),
      );
    }
    if (resolvedSnapshot.status === 'DISCONNECTED') {
      return outcome(
        'NOT_VERIFIABLE',
        'Candidate target disconnected before admission',
        emptyEvidence(before, 'MISSING'),
      );
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
        const retainedSnapshot = await inspectInteractionCandidateHandle(
          targetHandle,
          resolvedCandidate.ordinal,
          domWorkRemaining,
        );
        if (debitDomWork(retainedSnapshot.domWorkUsed)) {
          return domWorkExhausted(resolvedCandidate);
        }
        observationDeadlineExpired = remaining() === 0;
        if (retainedSnapshot.status === 'CONNECTED') {
          lastEvidence = collectInteractionChangeEvidence(resolvedCandidate, retainedSnapshot.candidate);
        } else if (retainedSnapshot.status === 'DOM_WORK_BUDGET_REACHED') {
          return outcome(
            'NOT_VERIFIABLE',
            'Retained candidate inspection exhausted DOM work budget',
            emptyEvidence(resolvedCandidate, 'UNESTABLISHED'),
          );
        } else if (retainedSnapshot.status === 'CANDIDATE_LIMIT_REACHED') {
          return outcome(
            'NOT_VERIFIABLE',
            'Retained candidate inspection reached candidate limit',
            emptyEvidence(resolvedCandidate, 'UNESTABLISHED'),
          );
        } else if (!observationDeadlineExpired) {
          const liveCandidatesResult = await discoverInteractionCandidates(session.page, domWorkRemaining);
          if (debitDomWork(liveCandidatesResult.domWorkUsed)) {
            return domWorkExhausted(resolvedCandidate);
          }
          if (liveCandidatesResult.completeness !== 'COMPLETE'
            && !liveCandidatesResult.candidates.some((item) => item.candidateId === resolvedCandidate.candidateId)) {
            return outcome(
              'NOT_VERIFIABLE',
              `Candidate rediscovery was incomplete: ${liveCandidatesResult.completeness}`,
              emptyEvidence(resolvedCandidate, 'UNESTABLISHED'),
            );
          }
          observationDeadlineExpired = remaining() === 0;
          lastEvidence = collectDisconnectedInteractionEvidence(resolvedCandidate, liveCandidatesResult.candidates);
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
  let workOutcome: InteractionWorkOutcome;
  try {
    workOutcome = await executeInteraction(session, input, candidate, effectiveDeadlineAtMs);
  } catch (error) {
    workOutcome = outcome('EXECUTION_FAILED', errorMessage(error), emptyEvidence(candidate));
  }

  let cleanupAnomaly = false;
  let latestCleanupAnomalyReason: string | null = null;
  let lastCloseRejected = false;
  let lastCloseError: unknown;
  let latestCleanupAnomaly: InteractionCleanupFailure['anomaly'] = 'FULFILLED_NON_TERMINAL';
  let attemptsStarted = 0;
  const cleanupStartedAtMs = Date.now();
  const cleanupDeadlineAtMs = cleanupStartedAtMs + input.timeoutMs;
  const firstAttemptDeadlineAtMs = cleanupStartedAtMs + Math.floor(input.timeoutMs / 2);
  const finishClosed = (): InteractionAuditResult => {
    const lifecycle = closedLifecycle(latestCleanupAnomalyReason);
    const finalSafety = session.ledger.snapshot();
    const finalOutcome = finalizeInteractionOutcome(workOutcome, lifecycle, cleanupAnomaly, finalSafety);
    return Object.freeze({
      candidateId: candidate.candidateId,
      status: finalOutcome.status,
      reason: finalOutcome.reason,
      evidence: workOutcome.evidence,
      work: workOutcome,
      lifecycle,
      safety: finalSafety,
    });
  };
  const throwCleanupFailure = (
    kind: InteractionCleanupFailure['kind'],
  ): never => {
    const deadlineReached = Date.now() >= cleanupDeadlineAtMs;
    if (kind === 'DEADLINE_EXCEEDED') {
      session.ledger.recordInvariantViolation({
        code: 'INTERACTION_OWNER_CLEANUP_DEADLINE_EXCEEDED',
        message: INTERACTION_OWNER_CLEANUP_DEADLINE_MESSAGE,
      });
    } else {
      session.ledger.recordInvariantViolation({
        code: 'INTERACTION_OWNER_CLEANUP_RETRY_EXHAUSTED',
        message: INTERACTION_OWNER_CLEANUP_EXHAUSTED_MESSAGE,
      });
    }
    const lifecycle = nonTerminalLifecycle(
      latestCleanupAnomalyReason ?? 'Interaction owner close fulfilled without terminal Guard state',
    );
    const finalSafety = session.ledger.snapshot();
    const cleanup: InteractionCleanupFailure = Object.freeze({
      kind,
      attemptsStarted,
      deadlineAtMs: cleanupDeadlineAtMs,
      deadlineReached,
      anomaly: latestCleanupAnomaly,
      lastCloseRejected,
      lastCloseError,
    });
    throw new InteractionOwnerCleanupError({
      session,
      candidateId: candidate.candidateId,
      work: workOutcome,
      lifecycle,
      safety: finalSafety,
      lastCloseRejected,
      lastCloseError,
      cleanup,
    });
  };
  for (let attempt = 0; attempt < INTERACTION_OWNER_CLOSE_ATTEMPT_LIMIT; attempt += 1) {
    lastCloseRejected = false;
    lastCloseError = undefined;
    attemptsStarted += 1;
    const attemptDeadlineAtMs = attempt === 0 ? firstAttemptDeadlineAtMs : cleanupDeadlineAtMs;
    const closeSettlement = await observeCloseUntil(containedCloseSettlement(session), attemptDeadlineAtMs);
    if (closeSettlement.status === 'REJECTED') {
      lastCloseRejected = true;
      lastCloseError = closeSettlement.error;
      cleanupAnomaly = true;
      latestCleanupAnomaly = 'REJECTED';
      latestCleanupAnomalyReason = errorMessage(closeSettlement.error);
      session.ledger.recordInvariantViolation({
        code: 'INTERACTION_OWNER_CLOSE_FAILED',
        message: latestCleanupAnomalyReason,
      });
    } else if (closeSettlement.status === 'TIMED_OUT') {
      cleanupAnomaly = true;
      latestCleanupAnomaly = 'TIMED_OUT';
      latestCleanupAnomalyReason = INTERACTION_OWNER_CLOSE_TIMEOUT_REASON;
      session.ledger.recordInvariantViolation({
        code: 'INTERACTION_OWNER_CLOSE_TIMED_OUT',
        message: latestCleanupAnomalyReason,
      });
    }

    const terminal = session.isClosed();
    if (closeSettlement.status === 'FULFILLED' && !terminal) {
      cleanupAnomaly = true;
      latestCleanupAnomaly = 'FULFILLED_NON_TERMINAL';
      latestCleanupAnomalyReason = 'Interaction owner close fulfilled without terminal Guard state';
      session.ledger.recordInvariantViolation({
        code: 'INTERACTION_OWNER_CLOSE_NON_TERMINAL',
        message: latestCleanupAnomalyReason,
      });
    }
    if (terminal) {
      return finishClosed();
    }
    if (attempt === 0) {
      await yieldMacrotask();
      if (session.isClosed()) {
        return finishClosed();
      }
      if (Date.now() >= cleanupDeadlineAtMs) {
        throwCleanupFailure('DEADLINE_EXCEEDED');
      }
    }
  }

  return throwCleanupFailure(
    Date.now() >= cleanupDeadlineAtMs ? 'DEADLINE_EXCEEDED' : 'ATTEMPT_BUDGET_EXHAUSTED',
  );
}
