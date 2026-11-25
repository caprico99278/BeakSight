/**
 * RB-10: PageAuditor の段の順の純粋な関数（`src/orchestration/page-audit-plan.ts`）。始めない条件の順（違反 → 不調 → セッションの切れ → ダウンロード →
 * Run の時間の上限）と、当たったら後の確かめを呼ばないこと（違反の確かめは止めたことを記録するので、呼ぶ順に意味がある）。
 */
import { describe, expect, it } from 'vitest';
import type { PageAuditResult, PageId } from '../../src/core/contracts.js';
import {
  acceptsAsSamenessReference,
  interactionCandidateStepOf,
  samenessAnswersOf,
  nextLoadMayStart,
  pageAuditDepthOf,
  pageAuditStagesOf,
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

// DUP（ユーザーの判断 2026-11-18）: 同じ作りの 2 つ目以降は軽い点検、中身も同じなら省く。
describe('pageAuditDepthOf: how deep a page is audited', () => {
  const PAGE_A = 'PAGE-000001' as PageId;
  const PAGE_B = 'PAGE-000002' as PageId;

  it('audits fully a page whose template cannot be judged or has no fully audited first page', () => {
    expect(pageAuditDepthOf({ templateKey: null, contentDigest: 'sha256:c', referenceOf: () => PAGE_A, sameContentAs: () => PAGE_A }))
      .toEqual({ depth: 'FULL', sameAs: null });
    expect(pageAuditDepthOf({ templateKey: 'sha256:t', contentDigest: 'sha256:c', referenceOf: () => null, sameContentAs: () => PAGE_A }))
      .toEqual({ depth: 'FULL', sameAs: null });
  });

  it('audits lightly a page of a known template (same as its first page), and skips it when its content is the same as an audited page', () => {
    expect(pageAuditDepthOf({ templateKey: 'sha256:t', contentDigest: 'sha256:c', referenceOf: () => PAGE_A, sameContentAs: () => null }))
      .toEqual({ depth: 'LIGHT', sameAs: PAGE_A });
    expect(pageAuditDepthOf({ templateKey: 'sha256:t', contentDigest: null, referenceOf: () => PAGE_A, sameContentAs: () => PAGE_B }))
      .toEqual({ depth: 'LIGHT', sameAs: PAGE_A });
    expect(pageAuditDepthOf({ templateKey: 'sha256:t', contentDigest: 'sha256:c', referenceOf: () => PAGE_A, sameContentAs: () => PAGE_B }))
      .toEqual({ depth: 'SAME', sameAs: PAGE_B });
  });
});

describe('DUP: the first page of a template and the read again of a page', () => {
  const PAGE_A = 'PAGE-000001' as PageId;
  const PAGE_B = 'PAGE-000002' as PageId;
  const result = (
    status: PageAuditResult['status'],
    desktopReasons: PageAuditResult['incompleteReasons'] = [],
    mobileStatus: PageAuditResult['status'] = 'AUDITED',
  ): PageAuditResult => ({
    status,
    incompleteReasons: desktopReasons,
    viewports: { desktop: { status, incompleteReasons: desktopReasons }, mobile: { status: mobileStatus, incompleteReasons: [] } },
  }) as unknown as PageAuditResult;

  it('takes as the first page an audited page, or a partial one not stopped on the way', () => {
    expect(acceptsAsSamenessReference(result('AUDITED'))).toBe(true);
    expect(acceptsAsSamenessReference(result('PARTIAL', [{ code: 'COLLECTOR_INCOMPLETE', detail: 'accessibility:EVALUATION_FAILED' }]))).toBe(true);
    expect(acceptsAsSamenessReference(result('PARTIAL', [{ code: 'MAX_RUNTIME_REACHED', detail: null }]))).toBe(false);
    expect(acceptsAsSamenessReference(result('FAILED'))).toBe(false);
    expect(acceptsAsSamenessReference(result('PARTIAL', [], 'FAILED'))).toBe(false);
  });

  // REV-DUP の I-1: 軽い点検で省く段を、1 回目で終えていなければ認めない（次の同じ作りの画面をしっかり点検する）。
  it('does not take as the first page a page whose stress sweep failed, so that the next page of the template is audited fully', () => {
    expect(acceptsAsSamenessReference(result('PARTIAL', [{ code: 'COLLECTOR_INCOMPLETE', detail: 'stress-layout:EVALUATION_FAILED' }]))).toBe(false);
    expect(acceptsAsSamenessReference(result('PARTIAL', [{ code: 'STAGE_UNRESPONSIVE', detail: 'interaction' }]))).toBe(false);
  });

  it('keeps the depth of a page that is read again (a light page stays light, a full page stays full)', () => {
    const table = { referenceOf: () => PAGE_A, sameContentAs: () => PAGE_B };
    const light = samenessAnswersOf(table, { depth: 'LIGHT', sameAs: PAGE_A });
    expect(pageAuditDepthOf({ templateKey: 'sha256:t', contentDigest: 'sha256:c', ...light })).toEqual({ depth: 'LIGHT', sameAs: PAGE_A });
    const full = samenessAnswersOf(table, { depth: 'FULL', sameAs: null });
    expect(pageAuditDepthOf({ templateKey: 'sha256:t', contentDigest: 'sha256:c', ...full })).toEqual({ depth: 'FULL', sameAs: null });
    expect(samenessAnswersOf(table, null)).toBe(table);
  });
});

describe('pageAuditStagesOf: the stages of each depth', () => {
  const ALL = {
    afterLayout: true, accessibility: true, performance: true, stressSweep: true, interactions: true, focusCheck: true, viewport: true, ruleEvidenceTypes: null,
  };
  const NONE = { ...ALL, afterLayout: false, accessibility: false, performance: false, stressSweep: false, interactions: false, focusCheck: false };

  it('runs every stage of a full audit', () => {
    expect(pageAuditStagesOf('FULL', 'desktop')).toEqual(ALL);
    expect(pageAuditStagesOf('FULL', 'mobile')).toEqual(ALL);
  });

  it('keeps the layout, the images, the recheck and the Desktop axe of a light audit, and drops the rest', () => {
    expect(pageAuditStagesOf('LIGHT', 'desktop')).toEqual({ ...NONE, afterLayout: true, accessibility: true });
    expect(pageAuditStagesOf('LIGHT', 'mobile')).toEqual({ ...NONE, afterLayout: true });
  });

  it('stops a skipped page after the Desktop layout, gives the rules only the safety, network and console records, and does not start Mobile', () => {
    expect(pageAuditStagesOf('SAME', 'desktop')).toEqual({ ...NONE, ruleEvidenceTypes: ['safety', 'network', 'console'] });
    expect(pageAuditStagesOf('SAME', 'mobile').viewport).toBe(false);
  });
});
