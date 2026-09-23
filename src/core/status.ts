import type { RunStatus } from './contracts.js';

export interface RunStatusInput {
  readonly preflightFailed: boolean;
  readonly safetyInvariantViolations: number;
  readonly incompleteReasons: readonly string[];
  readonly unhandledFailures: number;
  readonly crawlLimitReached: boolean;
  readonly requiredArtifactsValid: boolean;
  readonly executionComplete: boolean;
  readonly skippedRequiredWork: number;
  readonly blockedRequiredWork: number;
  readonly timedOutRequiredWork: number;
  readonly notObservedRequiredWork: number;
  readonly notVerifiedRequiredWork: number;
  readonly failedRequiredWork: number;
  readonly incompleteCollectorCount: number;
  readonly findingCount?: number;
}

const isNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isValidRunStatusInput = (input: RunStatusInput): boolean =>
  typeof input.preflightFailed === 'boolean'
  && isNonNegativeSafeInteger(input.safetyInvariantViolations)
  && Array.isArray(input.incompleteReasons)
  && input.incompleteReasons.every((reason) => typeof reason === 'string')
  && isNonNegativeSafeInteger(input.unhandledFailures)
  && typeof input.crawlLimitReached === 'boolean'
  && typeof input.requiredArtifactsValid === 'boolean'
  && typeof input.executionComplete === 'boolean'
  && isNonNegativeSafeInteger(input.skippedRequiredWork)
  && isNonNegativeSafeInteger(input.blockedRequiredWork)
  && isNonNegativeSafeInteger(input.timedOutRequiredWork)
  && isNonNegativeSafeInteger(input.notObservedRequiredWork)
  && isNonNegativeSafeInteger(input.notVerifiedRequiredWork)
  && isNonNegativeSafeInteger(input.failedRequiredWork)
  && isNonNegativeSafeInteger(input.incompleteCollectorCount);

export const deriveRunStatus = (input: RunStatusInput): RunStatus => {
  if (input?.preflightFailed === true) {
    return 'FAILED';
  }

  if (isNonNegativeSafeInteger(input?.safetyInvariantViolations) && input.safetyInvariantViolations > 0) {
    return 'ABORTED_BY_SAFETY';
  }

  if (!isValidRunStatusInput(input)) {
    return 'PARTIAL';
  }

  if (
    input.executionComplete !== true
    || input.incompleteReasons.length > 0
    || input.unhandledFailures > 0
    || input.crawlLimitReached
    || !input.requiredArtifactsValid
    || input.skippedRequiredWork > 0
    || input.blockedRequiredWork > 0
    || input.timedOutRequiredWork > 0
    || input.notObservedRequiredWork > 0
    || input.notVerifiedRequiredWork > 0
    || input.failedRequiredWork > 0
    || input.incompleteCollectorCount > 0
  ) {
    return 'PARTIAL';
  }

  return 'COMPLETE';
};
