import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  INCOMPLETE_REASON_CODES,
  PAGE_AUDIT_STAGES,
  PAGE_AUDIT_STATUSES,
  type IncompleteReason,
  type PageAuditStage,
  type PageAuditStatus,
  type ViewportAuditStatus,
} from '../../src/core/contracts.js';
import { ERROR_MESSAGE_FALLBACK } from '../../src/core/errors.js';
import { MAX_ERROR_MESSAGE_LENGTH } from '../../src/core/limits.js';
import {
  collectorIncompleteReason,
  derivePageAuditStatus,
  deriveRunStatus,
  requiredArtifactInvalidReason,
  ruleEvaluationFailureReason,
  unhandledFailureReason,
  type RunStatusInput,
} from '../../src/core/status.js';
import { runStatusInput } from '../helpers/audit-run-fixture.js';

describe('run status', () => {
  it('takes structured incomplete reasons as its input', () => {
    expectTypeOf<RunStatusInput['incompleteReasons']>().toEqualTypeOf<readonly IncompleteReason[]>();
  });

  it.each(INCOMPLETE_REASON_CODES)('makes a structured incomplete reason with code %s prevent completion', (code) => {
    expect(deriveRunStatus({ ...runStatusInput(), incompleteReasons: [{ code, detail: null }] })).toBe('PARTIAL');
  });

  it('never reports COMPLETE when a required artifact is invalid', () => {
    expect(deriveRunStatus({ ...runStatusInput(), requiredArtifactsValid: false })).toBe('PARTIAL');
  });

  // Task 14〜17 の設計書 5.6.7（R15 の Minor-3）: PREFLIGHT の Guard の失敗で違反が記録された場合は、`ABORTED_BY_SAFETY` にする。
  it('gives a safety invariant violation priority over a preflight failure', () => {
    expect(deriveRunStatus({ ...runStatusInput(), preflightFailed: true, safetyInvariantViolations: 1 })).toBe('ABORTED_BY_SAFETY');
  });

  it('keeps a preflight failure without a violation FAILED, ahead of incomplete execution facts', () => {
    expect(deriveRunStatus({ ...runStatusInput(), preflightFailed: true })).toBe('FAILED');
    expect(deriveRunStatus({
      ...runStatusInput(),
      preflightFailed: true,
      executionComplete: false,
      incompleteReasons: [{ code: 'PREFLIGHT_FAILED', detail: 'PASSIVE_GUARD' }],
      safetyLedgerTruncated: true,
    })).toBe('FAILED');
  });

  it('gives a safety invariant violation priority over partial execution', () => {
    expect(deriveRunStatus({ ...runStatusInput(), safetyInvariantViolations: 1 })).toBe('ABORTED_BY_SAFETY');
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
    expect(deriveRunStatus({ ...runStatusInput(), executionComplete: false })).toBe('PARTIAL');
  });

  it.each([
    'preflightFailed',
    'safetyLedgerTruncated',
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
    const input = runStatusInput();
    const { [field]: _omitted, ...missingFact } = input;

    expect(deriveRunStatus(missingFact as never)).toBe('PARTIAL');
  });

  it.each([
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
      expect(deriveRunStatus({ ...runStatusInput(), [field]: value })).toBe('PARTIAL');
    }
  });

  it.each([
    ['preflightFailed', 0],
    ['safetyLedgerTruncated', 'false'],
    ['crawlLimitReached', 'false'],
    ['requiredArtifactsValid', 1],
    ['executionComplete', 'true'],
    ['incompleteReasons', 'none'],
  ] as const)('fails closed when required fact %s has an invalid runtime type', (field, value) => {
    expect(deriveRunStatus({ ...runStatusInput(), [field]: value } as never)).toBe('PARTIAL');
  });

  it.each([
    ['incompleteReasons', { incompleteReasons: [{ code: 'COLLECTOR_INCOMPLETE', detail: 'a collector did not finish' }] }],
    ['unhandledFailures', { unhandledFailures: 1 }],
    ['crawlLimitReached', { crawlLimitReached: true }],
    ['requiredArtifactsValid', { requiredArtifactsValid: false }],
  ] as const)('makes %s independently prevent completion', (_name, change) => {
    expect(deriveRunStatus({ ...runStatusInput(), ...change })).toBe('PARTIAL');
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
    expect(deriveRunStatus({ ...runStatusInput(), [field]: 1 })).toBe('PARTIAL');
  });

  // R6: 安全違反の件数が有限の0以上の整数でない場合は、違反がないと証明できないので ABORTED_BY_SAFETY にする。
  it.each([
    ['Infinity', Number.POSITIVE_INFINITY],
    ['1.5', 1.5],
    ['-1', -1],
    ['NaN', Number.NaN],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['an unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ['a numeric string', '0'],
    ['null', null],
  ] as const)('fails closed to ABORTED_BY_SAFETY when safetyInvariantViolations is %s', (_name, value) => {
    expect(deriveRunStatus({ ...runStatusInput(), safetyInvariantViolations: value } as never)).toBe('ABORTED_BY_SAFETY');
  });

  it('fails closed to ABORTED_BY_SAFETY when safetyInvariantViolations is omitted at runtime', () => {
    const { safetyInvariantViolations: _omitted, ...missingFact } = runStatusInput();

    expect(deriveRunStatus(missingFact as never)).toBe('ABORTED_BY_SAFETY');
  });

  it('keeps preflight failure ahead of an invalid safety violation count', () => {
    expect(deriveRunStatus({
      ...runStatusInput(),
      preflightFailed: true,
      safetyInvariantViolations: Number.NaN,
    })).toBe('FAILED');
  });

  // R3: Safety Ledger の記録上限への到達は「記録が不完全」という事実であり、安全違反ではない。
  it('reports PARTIAL, not ABORTED_BY_SAFETY, when only the Safety Ledger record is truncated', () => {
    expect(deriveRunStatus({ ...runStatusInput(), safetyLedgerTruncated: true })).toBe('PARTIAL');
  });

  it('keeps a real safety violation ahead of a truncated Safety Ledger record', () => {
    expect(deriveRunStatus({
      ...runStatusInput(),
      safetyInvariantViolations: 1,
      safetyLedgerTruncated: true,
    })).toBe('ABORTED_BY_SAFETY');
  });

  it('ignores Finding counts when every execution fact is complete', () => {
    expect(deriveRunStatus({ ...runStatusInput(), findingCount: 53 })).toBe('COMPLETE');
  });
});

// P14a（Task 14〜17 の設計書 4.2、4.5.9）: ページ全体の状態は、ビューポートの状態の中で最も悪いもの。
describe('page audit status from the viewport statuses', () => {
  it.each([
    [['AUDITED', 'AUDITED'], 'AUDITED'],
    [['AUDITED', 'PARTIAL'], 'PARTIAL'],
    [['PARTIAL', 'AUDITED'], 'PARTIAL'],
    [['PARTIAL', 'PARTIAL'], 'PARTIAL'],
    [['AUDITED', 'FAILED'], 'FAILED'],
    [['FAILED', 'PARTIAL'], 'FAILED'],
    [['PARTIAL', 'FAILED'], 'FAILED'],
    [['FAILED', 'FAILED'], 'FAILED'],
  ] as const)('derives %j as %s (FAILED > PARTIAL > AUDITED)', (statuses, expected) => {
    expect(derivePageAuditStatus(statuses)).toBe(expected);
  });

  // SKIPPED は、そのビューポートの監査をしなかったことを表す。すべてのビューポートが SKIPPED のときだけ、ページも SKIPPED にする。
  // 一部のビューポートだけを監査した場合は、ページの監査を終えていないので、AUDITED にせず PARTIAL にする（完了の正直さ）。
  it.each([
    [['SKIPPED', 'SKIPPED'], 'SKIPPED'],
    [['AUDITED', 'SKIPPED'], 'PARTIAL'],
    [['SKIPPED', 'AUDITED'], 'PARTIAL'],
    [['SKIPPED', 'PARTIAL'], 'PARTIAL'],
    [['SKIPPED', 'FAILED'], 'FAILED'],
    [['FAILED', 'SKIPPED'], 'FAILED'],
  ] as const)('derives %j as %s', (statuses, expected) => {
    expect(derivePageAuditStatus(statuses)).toBe(expected);
  });

  it('does not depend on the order of the viewports', () => {
    for (const left of PAGE_AUDIT_STATUSES) {
      for (const right of PAGE_AUDIT_STATUSES) {
        expect(derivePageAuditStatus([left, right])).toBe(derivePageAuditStatus([right, left]));
      }
    }
  });

  it('rejects an empty list and a status outside the closed list instead of guessing', () => {
    expect(() => derivePageAuditStatus([])).toThrow(RangeError);
    expect(() => derivePageAuditStatus(['AUDITED', 'DONE' as ViewportAuditStatus])).toThrow(RangeError);
  });

  it('takes viewport statuses and returns a page status', () => {
    expectTypeOf(derivePageAuditStatus).parameters.toEqualTypeOf<[readonly ViewportAuditStatus[]]>();
    expectTypeOf(derivePageAuditStatus).returns.toEqualTypeOf<PageAuditStatus>();
  });
});

// P14a（Task 14〜17 の設計書 4.5.5）: collector の PARTIAL と例外の理由は、`COLLECTOR_INCOMPLETE` と `<段階>:<理由>` で記録する。
describe('collector incomplete reason', () => {
  it.each([
    ['layout', 'DEADLINE_EXCEEDED', 'layout:DEADLINE_EXCEEDED'],
    ['accessibility', 'PAGE_CLOSED', 'accessibility:PAGE_CLOSED'],
    ['interaction', 'budget', 'interaction:budget'],
    ['interaction', 'cleanup', 'interaction:cleanup'],
    ['interaction-discovery', 'LIMIT_REACHED', 'interaction-discovery:LIMIT_REACHED'],
  ] as const)('builds COLLECTOR_INCOMPLETE for the %s stage and the reason %s', (stage, reason, detail) => {
    const incomplete = collectorIncompleteReason(stage, reason);

    expect(incomplete).toEqual({ code: 'COLLECTOR_INCOMPLETE', detail });
    expect(Object.isFrozen(incomplete)).toBe(true);
  });

  it('accepts every page audit stage', () => {
    for (const stage of PAGE_AUDIT_STAGES) {
      expect(collectorIncompleteReason(stage, 'EVALUATION_FAILED').detail).toBe(`${stage}:EVALUATION_FAILED`);
    }
  });

  it('rejects a stage outside the closed list and an empty reason', () => {
    expect(() => collectorIncompleteReason('crawl' as PageAuditStage, 'DEADLINE_EXCEEDED')).toThrow(RangeError);
    expect(() => collectorIncompleteReason('layout', '')).toThrow(RangeError);
  });

  it('returns a structured incomplete reason', () => {
    expectTypeOf(collectorIncompleteReason).parameters.toEqualTypeOf<[PageAuditStage, string]>();
    expectTypeOf(collectorIncompleteReason).returns.toEqualTypeOf<IncompleteReason>();
  });
});

// CC-021: `UNHANDLED_FAILURE` の理由と、Rule の評価の失敗の理由の組み立ては、ここの関数だけで行う。
describe('unhandledFailureReason (CC-021)', () => {
  it('builds UNHANDLED_FAILURE with <scene>:<message> from an Error', () => {
    const reason = unhandledFailureReason('run-crawl', new Error('boom'));

    expect(reason).toEqual({ code: 'UNHANDLED_FAILURE', detail: 'run-crawl:boom' });
    expect(Object.isFrozen(reason)).toBe(true);
  });

  it('uses a string as the message as it is', () => {
    expect(unhandledFailureReason('passive-context', 'closed: cause').detail).toBe('passive-context:closed: cause');
  });

  it('bounds the message to MAX_ERROR_MESSAGE_LENGTH and keeps the scene whole', () => {
    const reason = unhandledFailureReason('browser-close', new Error('x'.repeat(MAX_ERROR_MESSAGE_LENGTH + 10)));

    expect(reason.detail).toBe(`browser-close:${'x'.repeat(MAX_ERROR_MESSAGE_LENGTH)}`);
  });

  it('keeps control characters in the message as safeErrorMessage does', () => {
    const message = `line1${String.fromCharCode(10)}line2${String.fromCharCode(0)}`;

    expect(unhandledFailureReason('run-validation', new Error(message)).detail).toBe(`run-validation:${message}`);
  });

  it('uses the fallback text for a value whose message cannot be read safely', () => {
    const unreadable = new Proxy({}, {
      get: () => {
        throw new Error('getter failed');
      },
    });

    expect(unhandledFailureReason('run-cross-page', unreadable).detail).toBe(`run-cross-page:${ERROR_MESSAGE_FALLBACK}`);
  });

  it('rejects an empty scene', () => {
    expect(() => unhandledFailureReason('', new Error('boom'))).toThrow(RangeError);
  });

  it('returns a structured incomplete reason', () => {
    expectTypeOf(unhandledFailureReason).returns.toEqualTypeOf<IncompleteReason>();
  });
});

describe('ruleEvaluationFailureReason (CC-021)', () => {
  it('builds the reason with the code of the failure and <ruleId>:<message>', () => {
    const reason = ruleEvaluationFailureReason({ code: 'RULE_EVALUATION_FAILED', ruleId: 'TECH_HTTP_5XX', message: 'boom' });

    expect(reason).toEqual({ code: 'RULE_EVALUATION_FAILED', detail: 'TECH_HTTP_5XX:boom' });
    expect(Object.isFrozen(reason)).toBe(true);
  });

  it('keeps the message as it is (the Rule Engine bounds it)', () => {
    const message = `a:b${String.fromCharCode(10)}c`;

    expect(ruleEvaluationFailureReason({ code: 'RULE_EVALUATION_FAILED', ruleId: 'R', message }).detail).toBe(`R:${message}`);
  });

  it('returns a structured incomplete reason', () => {
    expectTypeOf(ruleEvaluationFailureReason).returns.toEqualTypeOf<IncompleteReason>();
  });
});

describe('requiredArtifactInvalidReason (CC-022)', () => {
  it('builds REQUIRED_ARTIFACT_INVALID with <schema>:<ID>:<first error>', () => {
    const reason = requiredArtifactInvalidReason('page', 'PAGE-000002', ['/ must NOT have additional properties', '/x second']);

    expect(reason).toEqual({ code: 'REQUIRED_ARTIFACT_INVALID', detail: 'page:PAGE-000002:/ must NOT have additional properties' });
    expect(Object.isFrozen(reason)).toBe(true);
  });

  it('uses "invalid" when the validator gave no error', () => {
    expect(requiredArtifactInvalidReason('finding', 'FINDING-000001', []).detail).toBe('finding:FINDING-000001:invalid');
  });

  it('bounds the whole detail to MAX_ERROR_MESSAGE_LENGTH', () => {
    const reason = requiredArtifactInvalidReason('audit', 'RUN-1', ['e'.repeat(MAX_ERROR_MESSAGE_LENGTH)]);

    expect(reason.detail).toBe(`audit:RUN-1:${'e'.repeat(MAX_ERROR_MESSAGE_LENGTH)}`.slice(0, MAX_ERROR_MESSAGE_LENGTH));
    expect(reason.detail).toHaveLength(MAX_ERROR_MESSAGE_LENGTH);
  });

  it('builds the same reason for the same artifact, so that duplicates can be removed by code and detail', () => {
    const errors = ['/pages/1 must NOT have additional properties'];
    expect(requiredArtifactInvalidReason('run', 'RUN-1', errors)).toEqual(requiredArtifactInvalidReason('run', 'RUN-1', [...errors]));
  });

  it('returns a structured incomplete reason', () => {
    expectTypeOf(requiredArtifactInvalidReason).returns.toEqualTypeOf<IncompleteReason>();
  });
});
