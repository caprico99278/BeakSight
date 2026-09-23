import { describe, expect, it } from 'vitest';
import { deriveRunStatus } from '../../src/core/status.js';

const completeInput = () => ({
  preflightFailed: false,
  safetyInvariantViolations: 0,
  incompleteReasons: [],
  unhandledFailures: 0,
  crawlLimitReached: false,
  requiredArtifactsValid: true,
  executionComplete: true,
  skippedRequiredWork: 0,
  blockedRequiredWork: 0,
  timedOutRequiredWork: 0,
  notObservedRequiredWork: 0,
  notVerifiedRequiredWork: 0,
  failedRequiredWork: 0,
  incompleteCollectorCount: 0,
});

describe('run status', () => {
  it('never reports COMPLETE when a required artifact is invalid', () => {
    expect(deriveRunStatus({ ...completeInput(), requiredArtifactsValid: false })).toBe('PARTIAL');
  });

  it('gives preflight failure priority over safety and incomplete execution facts', () => {
    expect(deriveRunStatus({ ...completeInput(), preflightFailed: true, safetyInvariantViolations: 1 })).toBe('FAILED');
  });

  it('gives a safety invariant violation priority over partial execution', () => {
    expect(deriveRunStatus({ ...completeInput(), safetyInvariantViolations: 1 })).toBe('ABORTED_BY_SAFETY');
  });

  it('fails closed when runtime input omits execution completeness facts', () => {
    expect(deriveRunStatus({
      preflightFailed: false,
      safetyInvariantViolations: 0,
      incompleteReasons: [],
      unhandledFailures: 0,
      crawlLimitReached: false,
      requiredArtifactsValid: true,
    } as never)).toBe('PARTIAL');
  });

  it('requires executionComplete to be affirmatively true', () => {
    expect(deriveRunStatus({ ...completeInput(), executionComplete: false })).toBe('PARTIAL');
  });

  it.each([
    'preflightFailed',
    'safetyInvariantViolations',
    'incompleteReasons',
    'unhandledFailures',
    'crawlLimitReached',
    'requiredArtifactsValid',
    'executionComplete',
    'skippedRequiredWork',
    'blockedRequiredWork',
    'timedOutRequiredWork',
    'notObservedRequiredWork',
    'notVerifiedRequiredWork',
    'failedRequiredWork',
    'incompleteCollectorCount',
  ] as const)('fails closed when required execution fact %s is omitted at runtime', (field) => {
    const input = completeInput();
    const { [field]: _omitted, ...missingFact } = input;

    expect(deriveRunStatus(missingFact as never)).toBe('PARTIAL');
  });

  it.each([
    'safetyInvariantViolations',
    'unhandledFailures',
    'skippedRequiredWork',
    'blockedRequiredWork',
    'timedOutRequiredWork',
    'notObservedRequiredWork',
    'notVerifiedRequiredWork',
    'failedRequiredWork',
    'incompleteCollectorCount',
  ] as const)('fails closed when counter %s is invalid at runtime', (field) => {
    for (const value of [-1, 0.5, Number.POSITIVE_INFINITY]) {
      expect(deriveRunStatus({ ...completeInput(), [field]: value })).toBe('PARTIAL');
    }
  });

  it.each([
    ['preflightFailed', 0],
    ['crawlLimitReached', 'false'],
    ['requiredArtifactsValid', 1],
    ['executionComplete', 'true'],
    ['incompleteReasons', 'none'],
  ] as const)('fails closed when required fact %s has an invalid runtime type', (field, value) => {
    expect(deriveRunStatus({ ...completeInput(), [field]: value } as never)).toBe('PARTIAL');
  });

  it.each([
    ['incompleteReasons', { incompleteReasons: ['a collector did not finish'] }],
    ['unhandledFailures', { unhandledFailures: 1 }],
    ['crawlLimitReached', { crawlLimitReached: true }],
    ['requiredArtifactsValid', { requiredArtifactsValid: false }],
  ] as const)('makes %s independently prevent completion', (_name, change) => {
    expect(deriveRunStatus({ ...completeInput(), ...change })).toBe('PARTIAL');
  });

  it.each([
    'skippedRequiredWork',
    'blockedRequiredWork',
    'timedOutRequiredWork',
    'notObservedRequiredWork',
    'notVerifiedRequiredWork',
    'failedRequiredWork',
    'incompleteCollectorCount',
  ] as const)('makes non-zero %s prevent completion', (field) => {
    expect(deriveRunStatus({ ...completeInput(), [field]: 1 })).toBe('PARTIAL');
  });

  it('ignores Finding counts when every execution fact is complete', () => {
    expect(deriveRunStatus({ ...completeInput(), findingCount: 53 })).toBe('COMPLETE');
  });
});
