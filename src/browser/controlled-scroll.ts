import type { Page } from 'playwright';

export interface ControlledScrollOptions {
  readonly deadlineAtMs: number;
  readonly stepViewportFraction: number;
  readonly stepWaitMs: number;
  readonly stableWindowMs: number;
}

export interface ScrollObservation {
  readonly observedAtMs: number;
  readonly scrollY: number;
  readonly viewportHeight: number;
  readonly scrollHeight: number;
  readonly heightGrew: boolean;
  readonly atBottom: boolean;
}

interface ScrollResultBase {
  readonly heightGrowthCount: number;
  readonly observations: readonly Readonly<ScrollObservation>[];
}

export type ScrollResult = Readonly<ScrollResultBase & {
  readonly status: 'COMPLETE';
  readonly reason: 'BOTTOM_AND_HEIGHT_STABLE';
  readonly finalSnapshot: Readonly<ScrollObservation>;
}> | Readonly<ScrollResultBase & {
  readonly status: 'PARTIAL';
  readonly reason: 'DEADLINE_EXCEEDED' | 'PAGE_CLOSED' | 'EVALUATION_FAILED';
  readonly finalSnapshot: Readonly<ScrollObservation> | null;
}>;

const DEADLINE = Symbol('deadline');
const BOTTOM_EPSILON_PX = 1;
const MAX_STEP_VIEWPORT_FRACTION = 0.9;
type OperationOutcome<T> =
  | { readonly status: 'FULFILLED'; readonly value: T }
  | { readonly status: 'REJECTED'; readonly reason: unknown };

function validateOptions(options: ControlledScrollOptions): void {
  if (!Number.isFinite(options.deadlineAtMs)) {
    throw new Error('Controlled scroll deadline must be finite');
  }
  if (
    !Number.isFinite(options.stepViewportFraction)
    || options.stepViewportFraction <= 0
    || options.stepViewportFraction > MAX_STEP_VIEWPORT_FRACTION
  ) {
    throw new Error(`Controlled scroll step fraction must be greater than zero and at most ${MAX_STEP_VIEWPORT_FRACTION}`);
  }
  if (!Number.isFinite(options.stepWaitMs) || options.stepWaitMs <= 0) {
    throw new Error('Controlled scroll step wait must be positive and finite');
  }
  if (!Number.isFinite(options.stableWindowMs) || options.stableWindowMs <= 0) {
    throw new Error('Controlled scroll stable window must be positive and finite');
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

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function immutableResult(result: ScrollResult): ScrollResult {
  const observations = Object.freeze(result.observations.map((observation) => Object.freeze({ ...observation })));
  const finalSnapshot = result.finalSnapshot === null ? null : Object.freeze({ ...result.finalSnapshot });
  return Object.freeze({ ...result, observations, finalSnapshot }) as ScrollResult;
}

function partial(
  reason: Extract<ScrollResult, { readonly status: 'PARTIAL' }>['reason'],
  observations: readonly ScrollObservation[],
  heightGrowthCount: number,
): ScrollResult {
  return immutableResult({
    status: 'PARTIAL',
    reason,
    observations,
    heightGrowthCount,
    finalSnapshot: observations.at(-1) ?? null,
  });
}

function completeBeforeDeadline(
  deadlineAtMs: number,
  observations: readonly ScrollObservation[],
  heightGrowthCount: number,
  finalSnapshot: ScrollObservation,
): ScrollResult {
  if (Date.now() >= deadlineAtMs) {
    return partial('DEADLINE_EXCEEDED', observations, heightGrowthCount);
  }
  const complete = immutableResult({
    status: 'COMPLETE',
    reason: 'BOTTOM_AND_HEIGHT_STABLE',
    observations,
    heightGrowthCount,
    finalSnapshot,
  });
  return Date.now() >= deadlineAtMs
    ? partial('DEADLINE_EXCEEDED', observations, heightGrowthCount)
    : complete;
}

async function measure(
  page: Page,
  deadlineAtMs: number,
  previousHeight: number | undefined,
): Promise<ScrollObservation | typeof DEADLINE> {
  const state = await beforeDeadline(page.evaluate(() => ({
    scrollY: window.scrollY,
    viewportHeight: window.innerHeight,
    scrollHeight: document.documentElement.scrollHeight,
  })), deadlineAtMs);
  if (state === DEADLINE) {
    return DEADLINE;
  }
  const observedAtMs = Date.now();
  if (observedAtMs >= deadlineAtMs) {
    return DEADLINE;
  }
  return {
    observedAtMs,
    ...state,
    heightGrew: previousHeight !== undefined && state.scrollHeight > previousHeight,
    atBottom: state.scrollY + state.viewportHeight >= state.scrollHeight - BOTTOM_EPSILON_PX,
  };
}

export async function controlledScroll(page: Page, options: ControlledScrollOptions): Promise<ScrollResult> {
  validateOptions(options);
  const deadlineAtMs = options.deadlineAtMs;
  const stepWaitMs = options.stepWaitMs;
  const stableWindowMs = options.stableWindowMs;
  const stepViewportFraction = options.stepViewportFraction;
  const observations: ScrollObservation[] = [];
  let heightGrowthCount = 0;

  if (page.isClosed()) {
    return partial('PAGE_CLOSED', observations, heightGrowthCount);
  }

  try {
    const reset = await beforeDeadline(page.evaluate(async ({ absoluteDeadlineMs }) => {
      if (typeof requestAnimationFrame === 'function') {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      if (Date.now() >= absoluteDeadlineMs) {
        return 'DEADLINE_EXCEEDED' as const;
      }
      window.scrollTo(0, 0);
      return 'MUTATED' as const;
    }, { absoluteDeadlineMs: deadlineAtMs }), deadlineAtMs);
    if (reset === DEADLINE || reset === 'DEADLINE_EXCEEDED') {
      return partial('DEADLINE_EXCEEDED', observations, heightGrowthCount);
    }
  } catch {
    return partial(page.isClosed() ? 'PAGE_CLOSED' : 'EVALUATION_FAILED', observations, heightGrowthCount);
  }

  let previousHeight: number | undefined;
  let bottomStableSinceMs: number | undefined;
  while (Date.now() < deadlineAtMs) {
    let observation: ScrollObservation | typeof DEADLINE;
    try {
      observation = await measure(page, deadlineAtMs, previousHeight);
    } catch {
      return partial(page.isClosed() ? 'PAGE_CLOSED' : 'EVALUATION_FAILED', observations, heightGrowthCount);
    }
    if (observation === DEADLINE) {
      return partial('DEADLINE_EXCEEDED', observations, heightGrowthCount);
    }
    observations.push(observation);
    const heightChanged = previousHeight !== undefined && observation.scrollHeight !== previousHeight;
    if (observation.heightGrew) {
      heightGrowthCount += 1;
    }

    if (observation.atBottom && !heightChanged) {
      bottomStableSinceMs ??= observation.observedAtMs;
      if (observation.observedAtMs - bottomStableSinceMs >= stableWindowMs) {
        return completeBeforeDeadline(deadlineAtMs, observations, heightGrowthCount, observation);
      }
    } else {
      bottomStableSinceMs = undefined;
    }
    previousHeight = observation.scrollHeight;

    try {
      const moved = await beforeDeadline(page.evaluate(({ fraction, absoluteDeadlineMs }) => {
        const step = Math.max(1, Math.floor(window.innerHeight * fraction));
        if (Date.now() >= absoluteDeadlineMs) {
          return 'DEADLINE_EXCEEDED' as const;
        }
        window.scrollBy(0, Math.min(step, Math.max(0, document.documentElement.scrollHeight - window.innerHeight - window.scrollY)));
        return 'MUTATED' as const;
      }, { fraction: stepViewportFraction, absoluteDeadlineMs: deadlineAtMs }), deadlineAtMs);
      if (moved === DEADLINE || moved === 'DEADLINE_EXCEEDED') {
        return partial('DEADLINE_EXCEEDED', observations, heightGrowthCount);
      }
    } catch {
      return partial(page.isClosed() ? 'PAGE_CLOSED' : 'EVALUATION_FAILED', observations, heightGrowthCount);
    }

    const remainingMs = deadlineAtMs - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    await wait(Math.min(stepWaitMs, remainingMs));
  }

  return partial('DEADLINE_EXCEEDED', observations, heightGrowthCount);
}
