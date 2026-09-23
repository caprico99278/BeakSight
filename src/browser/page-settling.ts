import type { Page } from 'playwright';

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
  readonly reason: 'DEADLINE_EXCEEDED' | 'PAGE_CLOSED' | 'DOM_READINESS_FAILED' | 'EVALUATION_FAILED';
  readonly observations: readonly Readonly<PageSettlingObservation>[];
}>;

const DEADLINE = Symbol('deadline');
type OperationOutcome<T> =
  | { readonly status: 'FULFILLED'; readonly value: T }
  | { readonly status: 'REJECTED'; readonly reason: unknown };

function validatePolicy(policy: PageSettlingPolicy): void {
  if (!Number.isFinite(policy.deadlineAtMs)) {
    throw new Error('Page settling deadline must be finite');
  }
  if (!Number.isFinite(policy.pollIntervalMs) || policy.pollIntervalMs <= 0) {
    throw new Error('Page settling poll interval must be positive and finite');
  }
  if (!Number.isFinite(policy.stableWindowMs) || policy.stableWindowMs <= 0) {
    throw new Error('Page settling stable window must be positive and finite');
  }
}

async function beforeDeadline<T>(operation: Promise<T>, deadlineAtMs: number): Promise<T | typeof DEADLINE> {
  const outcome = operation.then<OperationOutcome<T>, OperationOutcome<T>>(
    (value) => ({ status: 'FULFILLED', value }),
    (reason: unknown) => ({ status: 'REJECTED', reason }),
  );
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) {
    return DEADLINE;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      outcome,
      new Promise<typeof DEADLINE>((resolve) => {
        timer = setTimeout(() => resolve(DEADLINE), remainingMs);
      }),
    ]);
    if (result === DEADLINE || Date.now() >= deadlineAtMs) {
      return DEADLINE;
    }
    if (result.status === 'REJECTED') {
      throw result.reason;
    }
    return result.value;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
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

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
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

  try {
    const domReady = await beforeDeadline(
      page.waitForLoadState('domcontentloaded', { timeout: Math.max(1, deadlineAtMs - Date.now()) }),
      deadlineAtMs,
    );
    if (domReady === DEADLINE) {
      return partial('DEADLINE_EXCEEDED', observations);
    }
  } catch {
    return partial(page.isClosed() ? 'PAGE_CLOSED' : 'DOM_READINESS_FAILED', observations);
  }

  let stableHeight: number | undefined;
  let stableSinceMs: number | undefined;
  while (Date.now() < deadlineAtMs) {
    if (page.isClosed()) {
      return partial('PAGE_CLOSED', observations);
    }
    let documentState: { readonly readyState: DocumentReadyState; readonly scrollHeight: number } | typeof DEADLINE;
    try {
      documentState = await beforeDeadline(page.evaluate(() => ({
        readyState: document.readyState,
        scrollHeight: document.documentElement.scrollHeight,
      })), deadlineAtMs);
    } catch {
      return partial(page.isClosed() ? 'PAGE_CLOSED' : 'EVALUATION_FAILED', observations);
    }
    if (documentState === DEADLINE) {
      return partial('DEADLINE_EXCEEDED', observations);
    }

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
