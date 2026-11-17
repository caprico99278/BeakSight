/**
 * RB-10: PageAuditor の段の順の純粋な関数（`src/orchestration/page-audit-plan.ts`）。始めない条件の順（違反 → 不調 → セッションの切れ → ダウンロード →
 * Run の時間の上限）と、当たったら後の確かめを呼ばないこと（違反の確かめは止めたことを記録するので、呼ぶ順に意味がある）。
 */
import { describe, expect, it } from 'vitest';
import {
  interactionCandidateStepOf,
  nextLoadMayStart,
  stressWidthAbortOf,
  viewportSkipReasonOf,
  waitsWithPageShown,
} from '../../src/orchestration/page-audit-plan.js';

/** 呼ばれた確かめの名前を順に残す関数を作る。 */
const recorder = (): { readonly calls: string[]; readonly check: (name: string, answer: boolean) => () => boolean } => {
  const calls: string[] = [];
  return { calls, check: (name, answer) => () => { calls.push(name); return answer; } };
};

describe('viewportSkipReasonOf: the order of the conditions not to start a viewport', () => {
  it('does not ask about a violation or the run time limit before the first viewport', () => {
    const { calls, check } = recorder();
    expect(viewportSkipReasonOf({
      earlierViewports: 0, violationRecorded: check('violation', true), siteUnavailable: false, sessionLost: false,
      downloadResponse: false, runTimeLimitPassed: check('time', true),
    })).toBeNull();
    expect(calls).toEqual([]);
  });

  it('prefers the violation to every other condition, and asks nothing after it', () => {
    const { calls, check } = recorder();
    expect(viewportSkipReasonOf({
      earlierViewports: 1, violationRecorded: check('violation', true), siteUnavailable: true, sessionLost: true,
      downloadResponse: true, runTimeLimitPassed: check('time', true),
    })?.code).toBe('SAFETY_VIOLATION_ABORT');
    expect(calls).toEqual(['violation']);
  });

  it.each([
    [{ siteUnavailable: true, sessionLost: true, downloadResponse: true }, 'SITE_UNAVAILABLE'],
    [{ siteUnavailable: false, sessionLost: true, downloadResponse: true }, 'AUTH_SESSION_LOST'],
    [{ siteUnavailable: false, sessionLost: false, downloadResponse: true }, 'DOWNLOAD_RESPONSE'],
  ] as const)('skips with the first condition that holds (%o → %s), without asking the run time limit', (facts, code) => {
    const { calls, check } = recorder();
    expect(viewportSkipReasonOf({
      earlierViewports: 1, violationRecorded: check('violation', false), runTimeLimitPassed: check('time', true), ...facts,
    })?.code).toBe(code);
    expect(calls).toEqual(['violation']);
  });

  it('skips with MAX_RUNTIME_REACHED last, and starts when nothing holds', () => {
    const facts = { earlierViewports: 1, violationRecorded: () => false, siteUnavailable: false, sessionLost: false, downloadResponse: false };
    expect(viewportSkipReasonOf({ ...facts, runTimeLimitPassed: () => true })?.code).toBe('MAX_RUNTIME_REACHED');
    expect(viewportSkipReasonOf({ ...facts, runTimeLimitPassed: () => false })).toBeNull();
  });
});

describe('stressWidthAbortOf: the checks before a stress width (before its pacing wait, DEF-209)', () => {
  it('checks the violation, then the site, then the session, and stops at the first that holds', () => {
    const { calls, check } = recorder();
    expect(stressWidthAbortOf({ violationRecorded: check('violation', false), siteUnavailable: true, sessionLost: check('session', true) }))
      .toBe('SITE_UNAVAILABLE');
    expect(calls).toEqual(['violation']);
    expect(stressWidthAbortOf({ violationRecorded: () => true, siteUnavailable: true, sessionLost: () => true })).toBe('SAFETY_VIOLATION_ABORT');
    expect(stressWidthAbortOf({ violationRecorded: () => false, siteUnavailable: false, sessionLost: () => true })).toBe('AUTH_SESSION_LOST');
    expect(stressWidthAbortOf({ violationRecorded: () => false, siteUnavailable: false, sessionLost: () => false })).toBeNull();
  });
});

describe('interactionCandidateStepOf: the checks before an interaction candidate (before its pacing wait)', () => {
  const free = { stopped: false, violationRecorded: () => false, siteUnavailable: false, index: 0, maxInteractionsPerPage: undefined };

  it('ends without a reason after the stages stopped, without asking about a violation', () => {
    const { calls, check } = recorder();
    expect(interactionCandidateStepOf({ ...free, stopped: true, violationRecorded: check('violation', true) })).toEqual({ kind: 'END' });
    expect(calls).toEqual([]);
  });

  it('stops for the violation, then the site, then the limit, in this order', () => {
    expect(interactionCandidateStepOf({ ...free, violationRecorded: () => true, siteUnavailable: true, index: 5, maxInteractionsPerPage: 1 }))
      .toEqual({ kind: 'STOP', reason: 'SAFETY_VIOLATION_ABORT' });
    expect(interactionCandidateStepOf({ ...free, siteUnavailable: true, index: 5, maxInteractionsPerPage: 1 }))
      .toEqual({ kind: 'STOP', reason: 'SITE_UNAVAILABLE' });
    expect(interactionCandidateStepOf({ ...free, index: 1, maxInteractionsPerPage: 1 })).toEqual({ kind: 'STOP', reason: 'limit' });
  });

  it('audits the candidates below the limit, and every candidate without a limit', () => {
    expect(interactionCandidateStepOf({ ...free, index: 0, maxInteractionsPerPage: 1 })).toEqual({ kind: 'AUDIT' });
    expect(interactionCandidateStepOf({ ...free, index: 99 })).toEqual({ kind: 'AUDIT' });
  });
});

describe('nextLoadMayStart and waitsWithPageShown: wait with the page shown only when a next load follows', () => {
  it('does not start a next load after the site, the session, the run time limit or a violation', () => {
    const facts = { siteUnavailable: false, sessionLost: false, runTimeLimitPassed: () => false, violationDetected: () => false };
    expect(nextLoadMayStart(facts)).toBe(true);
    expect(nextLoadMayStart({ ...facts, siteUnavailable: true })).toBe(false);
    expect(nextLoadMayStart({ ...facts, sessionLost: true })).toBe(false);
    expect(nextLoadMayStart({ ...facts, runTimeLimitPassed: () => true })).toBe(false);
    expect(nextLoadMayStart({ ...facts, violationDetected: () => true })).toBe(false);
  });

  it('asks whether a later load follows last, and only when the page may be shown', () => {
    const { calls, check } = recorder();
    const shown = { evidenceSettled: true, crashed: false };
    expect(waitsWithPageShown({ ...shown, downloadBlocked: check('download', false), nextLoadMayStart: check('next', true), laterLoadFollows: check('later', true) }))
      .toBe(true);
    expect(calls).toEqual(['download', 'next', 'later']);
    calls.length = 0;
    expect(waitsWithPageShown({ ...shown, crashed: true, downloadBlocked: check('download', false), nextLoadMayStart: check('next', true), laterLoadFollows: check('later', true) }))
      .toBe(false);
    expect(waitsWithPageShown({ ...shown, downloadBlocked: check('download', true), nextLoadMayStart: check('next', true), laterLoadFollows: check('later', true) }))
      .toBe(false);
    expect(waitsWithPageShown({ ...shown, downloadBlocked: () => false, nextLoadMayStart: check('next', false), laterLoadFollows: check('later', true) }))
      .toBe(false);
    expect(calls).toEqual(['download', 'next']);
  });
});
