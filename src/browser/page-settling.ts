import type { Page } from 'playwright';
import type { IncompleteReasonCode, PartialFailureReason } from '../core/contracts.js';
import { awaitBeforeDeadline, wait } from '../core/deadline.js';
import { isPositiveFiniteNumber } from '../core/guards.js';
import { pageFailureReason } from './page-failure.js';

export interface PageSettlingPolicy {
  readonly deadlineAtMs: number;
  readonly pollIntervalMs: number;
  readonly stableWindowMs: number;
}

export interface PageSettlingObservation {
  readonly observedAtMs: number;
  readonly readyState: DocumentReadyState;
  readonly scrollHeight: number;
}

export type PageSettlingResult = Readonly<{
  readonly status: 'SETTLED';
  readonly reason: 'DOM_AND_HEIGHT_STABLE';
  readonly observations: readonly Readonly<PageSettlingObservation>[];
}> | Readonly<{
  readonly status: 'PARTIAL';
  readonly reason: PartialFailureReason | Extract<IncompleteReasonCode, 'DOM_READINESS_FAILED'>;
  readonly observations: readonly Readonly<PageSettlingObservation>[];
}>;

function validatePolicy(policy: PageSettlingPolicy): void {
  if (!Number.isFinite(policy.deadlineAtMs)) {
    throw new Error('Page settling deadline must be finite');
  }
  if (!isPositiveFiniteNumber(policy.pollIntervalMs)) {
    throw new Error('Page settling poll interval must be positive and finite');
  }
  if (!isPositiveFiniteNumber(policy.stableWindowMs)) {
    throw new Error('Page settling stable window must be positive and finite');
  }
}

function immutableResult(result: PageSettlingResult): PageSettlingResult {
  const observations = Object.freeze(result.observations.map((observation) => Object.freeze({ ...observation })));
  return Object.freeze({ ...result, observations });
}

function partial(
  reason: Extract<PageSettlingResult, { readonly status: 'PARTIAL' }>['reason'],
  observations: readonly PageSettlingObservation[],
): PageSettlingResult {
  return immutableResult({ status: 'PARTIAL', reason, observations });
}

function settledBeforeDeadline(
  deadlineAtMs: number,
  observations: readonly PageSettlingObservation[],
): PageSettlingResult {
  if (Date.now() >= deadlineAtMs) {
    return partial('DEADLINE_EXCEEDED', observations);
  }
  const settled = immutableResult({
    status: 'SETTLED',
    reason: 'DOM_AND_HEIGHT_STABLE',
    observations,
  });
  return Date.now() >= deadlineAtMs
    ? partial('DEADLINE_EXCEEDED', observations)
    : settled;
}

export async function waitForPageSettled(
  page: Page,
  policy: PageSettlingPolicy,
): Promise<PageSettlingResult> {
  validatePolicy(policy);
  const deadlineAtMs = policy.deadlineAtMs;
  const pollIntervalMs = policy.pollIntervalMs;
  const stableWindowMs = policy.stableWindowMs;
  const observations: PageSettlingObservation[] = [];

  if (page.isClosed()) {
    return partial('PAGE_CLOSED', observations);
  }

  const domReady = await awaitBeforeDeadline(
    page.waitForLoadState('domcontentloaded', { timeout: Math.max(1, deadlineAtMs - Date.now()) }),
    deadlineAtMs,
  );
  if (domReady.status === 'DEADLINE_EXCEEDED') {
    return partial('DEADLINE_EXCEEDED', observations);
  }
  if (domReady.status === 'REJECTED') {
    return partial(page.isClosed() ? 'PAGE_CLOSED' : 'DOM_READINESS_FAILED', observations);
  }

  let stableHeight: number | undefined;
  let stableSinceMs: number | undefined;
  while (Date.now() < deadlineAtMs) {
    if (page.isClosed()) {
      return partial('PAGE_CLOSED', observations);
    }
    const evaluated = await awaitBeforeDeadline(page.evaluate(() => ({
      readyState: document.readyState,
      scrollHeight: document.documentElement.scrollHeight,
    })), deadlineAtMs);
    if (evaluated.status === 'REJECTED') {
      return partial(pageFailureReason(page), observations);
    }
    if (evaluated.status === 'DEADLINE_EXCEEDED') {
      return partial('DEADLINE_EXCEEDED', observations);
    }
    const documentState = evaluated.value;

    const observedAtMs = Date.now();
    if (observedAtMs >= deadlineAtMs) {
      return partial('DEADLINE_EXCEEDED', observations);
    }
    observations.push({ observedAtMs, ...documentState });
    if (documentState.readyState === 'loading') {
      stableHeight = undefined;
      stableSinceMs = undefined;
    } else if (stableHeight === documentState.scrollHeight) {
      stableSinceMs ??= observedAtMs;
      if (observedAtMs - stableSinceMs >= stableWindowMs) {
        return settledBeforeDeadline(deadlineAtMs, observations);
      }
    } else {
      stableHeight = documentState.scrollHeight;
      stableSinceMs = observedAtMs;
    }

    const remainingMs = deadlineAtMs - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    await wait(Math.min(pollIntervalMs, remainingMs));
  }

  return partial('DEADLINE_EXCEEDED', observations);
}
