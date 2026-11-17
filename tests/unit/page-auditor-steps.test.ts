/**
 * RB-10: Page Auditor の段の順を、偽の監査の読み込みの口（`tests/helpers/fake-audit-load-ports.ts`）で確かめる（ブラウザを使わない）。
 * - 間隔の待ち（守り 4）: 読み込み（ビューポート・幅・候補）の前に 1 回ずつ。始めない読み込みでは呼ばない（DEF-209）。
 * - 違反で次を始めない（C18f）と、DEF-191 の順（Desktop の Context を閉じてから幅の走査、その後に Mobile）。
 * - 段の失敗・閉じる失敗・Interaction の止め方の理由。
 * 本物の Chromium での読み込み・collector・Guard は、結合の代表（`tests/integration/page-auditor.test.ts` など）とずれの確かめが受け持つ。
 */
import { describe, expect, it } from 'vitest';
import type { IncompleteReason } from '../../src/core/contracts.js';
import type { NormalizedHttpUrlEvidence } from '../../src/core/evidence-types.js';
import { ContextConstructionError } from '../../src/browser/context-factory.js';
import { PageAuditor, type AuditView, type PageAuditorDependencies } from '../../src/orchestration/page-auditor.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { PassiveContextCloseDeadlineError } from '../../src/orchestration/passive-session-close.js';
import { PassiveSessionOpenDeadlineError } from '../../src/orchestration/passive-session-open.js';
import type { TestConfigOverrides } from '../helpers/test-config.js';
import {
  FAKE_PAGE,
  createFakeAuditLoadPorts,
  fakeAuditorDependencies,
  type FakeAuditLoad,
  type FakeAuditScript,
} from '../helpers/fake-audit-load-ports.js';

/** 画像・axe・性能を集めず、Interaction もしない設定（段の順だけを見る）。 */
const PLAIN: TestConfigOverrides = { audit: { screenshots: false, accessibility: false, performance: false, interactions: false } };
const NO_STRESS: TestConfigOverrides = { ...PLAIN, viewports: { stressWidths: [] } };
const INTERACTIONS: TestConfigOverrides = { ...NO_STRESS, audit: { ...PLAIN.audit, interactions: true } };

const run = async (
  script: FakeAuditScript,
  configOverrides: TestConfigOverrides,
  overrides: (fake: FakeAuditLoad) => Partial<PageAuditorDependencies> = () => ({}),
): Promise<{ readonly fake: FakeAuditLoad; readonly outcome: Awaited<ReturnType<PageAuditor['audit']>> }> => {
  const fake = createFakeAuditLoadPorts(script);
  const auditor = new PageAuditor(fakeAuditorDependencies(fake, overrides(fake), configOverrides));
  const outcome = await auditor.audit(FAKE_PAGE.url as NormalizedHttpUrlEvidence, FAKE_PAGE.pageId);
  return { fake, outcome };
};

const codesOf = (reasons: readonly IncompleteReason[]): readonly string[] => reasons.map(({ code, detail }) => (detail === null ? code : `${code}:${detail}`));
const after = (events: readonly string[], event: string): readonly string[] => events.slice(events.indexOf(event) + 1);

describe('the audit load ports', () => {
  it('is a TypeError to give the collectors with the audit load ports (they would be ignored)', () => {
    const fake = createFakeAuditLoadPorts({});
    expect(() => new PageAuditor(fakeAuditorDependencies(fake, { collectors: {} }, PLAIN))).toThrow(TypeError);
  });
});

describe('the order of the loads and the pacing waits (keep 4, DEF-191)', () => {
  it('waits before every load, sweeps the stress widths after the Desktop Context is closed, and then audits Mobile', async () => {
    const { fake, outcome } = await run({}, PLAIN);
    expect(fake.events).toEqual([
      'pacer', 'open:desktop', 'navigate:desktop', 'shown-wait:desktop', 'close:desktop',
      'pacer', 'open:stress-320', 'shown-wait:stress-320', 'close:stress-320',
      'pacer', 'open:stress-768', 'shown-wait:stress-768', 'close:stress-768',
      'pacer', 'open:stress-1024', 'shown-wait:stress-1024', 'close:stress-1024',
      'pacer', 'open:mobile', 'navigate:mobile', 'close:mobile',
    ]);
    expect([outcome.result.viewports.desktop.status, outcome.result.viewports.mobile.status]).toEqual(['AUDITED', 'AUDITED']);
  });

  it('waits with the last page shown only when the Run Coordinator says a next page follows', async () => {
    const fake = createFakeAuditLoadPorts({});
    const auditor = new PageAuditor(fakeAuditorDependencies(fake, {}, NO_STRESS));
    await auditor.audit(FAKE_PAGE.url as NormalizedHttpUrlEvidence, FAKE_PAGE.pageId, { attempt: 1, precedesRetry: () => false, nextPageFollows: () => true });
    expect(after(fake.events, 'navigate:mobile')).toEqual(['shown-wait:mobile', 'close:mobile']);
  });
});

describe('no next load after a safety violation (C18f)', () => {
  it('starts no stress width and no Mobile, without pacing waits, after a violation in Desktop', async () => {
    const { fake, outcome } = await run({}, PLAIN, (current) => ({ safetyViolationRecorded: () => current.events.includes('close:desktop') }));
    expect(after(fake.events, 'close:desktop')).toEqual([]);
    expect(codesOf(outcome.result.viewports.desktop.incompleteReasons)).toContain('COLLECTOR_INCOMPLETE:stress-layout:SAFETY_VIOLATION_ABORT');
    expect(outcome.result.viewports.mobile).toMatchObject({ status: 'SKIPPED', incompleteReasons: [{ code: 'SAFETY_VIOLATION_ABORT', detail: null }] });
  });

  it('does not start the next stress width after a violation in a stress session', async () => {
    let violated = false;
    const { fake, outcome } = await run({ afterStressOpen: () => { violated = true; } }, PLAIN, () => ({ safetyViolationRecorded: () => violated }));
    expect(after(fake.events, 'close:stress-320')).toEqual([]);
    expect(codesOf(outcome.result.viewports.desktop.incompleteReasons)).toContain('COLLECTOR_INCOMPLETE:stress-layout:SAFETY_VIOLATION_ABORT');
    expect(outcome.result.viewports.mobile.status).toBe('SKIPPED');
  });
});

describe('the conditions not to start the next viewport', () => {
  it('marks Desktop FAILED on site unavailability, does not collect, and skips Mobile without a pacing wait', async () => {
    let collected = 0;
    const { fake, outcome } = await run({
      load: () => ({ navigationOutcome: 'OK', httpStatus: 503, failureDetail: null }),
      view: () => ({ collectDomEvidence: async () => { collected += 1; return {} as never; } }),
    }, PLAIN);
    expect(collected).toBe(0);
    expect(outcome.result.viewports.desktop.status).toBe('FAILED');
    expect(outcome.result.viewports.mobile).toMatchObject({ status: 'SKIPPED', incompleteReasons: [{ code: 'SITE_UNAVAILABLE' }] });
    expect(fake.events.filter((event) => event === 'pacer')).toHaveLength(1);
    expect(outcome.siteUnavailableDetail).toMatch(/^desktop:passive:/u);
  });

  it('starts no next stress width and no Mobile after a 503 of the first stress width', async () => {
    const { fake, outcome } = await run({ stressLoad: () => ({ navigationOutcome: 'OK', httpStatus: 503, failureDetail: null }) }, PLAIN);
    expect(after(fake.events, 'close:stress-320')).toEqual([]);
    expect(outcome.result.viewports.mobile).toMatchObject({ status: 'SKIPPED', incompleteReasons: [{ code: 'SITE_UNAVAILABLE' }] });
    expect(outcome.siteUnavailableDetail).toMatch(/^desktop:stress-layout:/u);
  });

  it('starts no next interaction candidate and no Mobile after a 503 of the first candidate load', async () => {
    const { fake, outcome } = await run({
      candidates: (name) => (name === 'desktop' ? ['a', 'b'] : []),
      interaction: (input) => {
        input.afterTargetLoad?.({ navigationOutcome: 'OK', httpStatus: 503, failureDetail: null });
        return { kind: 'AUDITED', result: { candidateId: input.candidate.candidateId, status: 'VERIFIED', safety: new SafetyLedger().snapshot() } as never };
      },
    }, INTERACTIONS);
    expect(fake.events.filter((event) => event.startsWith('interaction:'))).toEqual(['interaction:a']);
    expect(codesOf(outcome.result.viewports.desktop.incompleteReasons)).toContain('COLLECTOR_INCOMPLETE:interaction:SITE_UNAVAILABLE:remaining=1');
    expect(outcome.result.viewports.mobile.status).toBe('SKIPPED');
  });

  it('audits Desktop with a 200 and marks Mobile FAILED for a 503, with the Mobile detail', async () => {
    const { outcome } = await run({ load: (profile) => ({ navigationOutcome: 'OK', httpStatus: profile === 'mobile' ? 503 : 200, failureDetail: null }) }, NO_STRESS);
    expect([outcome.result.viewports.desktop.status, outcome.result.viewports.mobile.status]).toEqual(['AUDITED', 'FAILED']);
    expect(outcome.siteUnavailableDetail).toMatch(/^mobile:passive:/u);
  });

  it('skips Mobile with MAX_RUNTIME_REACHED after the run time limit', async () => {
    const { outcome } = await run({}, NO_STRESS, (fake) => ({ runDeadlineAtMs: 10, now: () => (fake.events.includes('close:desktop') ? 20 : 0) }));
    expect(outcome.result.viewports.mobile).toMatchObject({ status: 'SKIPPED', incompleteReasons: [{ code: 'MAX_RUNTIME_REACHED' }] });
  });
});

describe('stage failures, crashes, rules and the Context close', () => {
  it('records a collector that throws as <stage>:<reason> and a PARTIAL collector, and goes on to the next stages', async () => {
    let linksRead = false;
    const { outcome } = await run({
      view: (): Partial<AuditView> => ({
        collectDomEvidence: async () => { throw new Error('dom failed'); },
        collectLayoutEvidence: async () => ({ status: 'PARTIAL', reason: 'DEADLINE_EXCEEDED' }) as never,
        discoverLinks: async () => { linksRead = true; return { links: [] } as never; },
      }),
    }, NO_STRESS);
    expect(codesOf(outcome.result.viewports.desktop.incompleteReasons)).toEqual(expect.arrayContaining([
      'COLLECTOR_INCOMPLETE:dom:EVALUATION_FAILED',
      'COLLECTOR_INCOMPLETE:layout:DEADLINE_EXCEEDED',
    ]));
    expect(outcome.result.viewports.desktop.status).toBe('PARTIAL');
    expect(linksRead).toBe(true);
  });

  it('does not run the stages that the settings disable', async () => {
    const called: string[] = [];
    await run({
      view: () => ({
        collectAccessibilityEvidence: async () => { called.push('accessibility'); return {} as never; },
        collectPerformance: async () => { called.push('performance'); return {} as never; },
        captureScreenshots: async () => { called.push('screenshot'); return []; },
        discoverInteractionCandidates: async () => { called.push('interaction'); return { candidates: [], completeness: 'COMPLETE', domWorkUsed: 0 }; },
      }),
    }, NO_STRESS);
    expect(called).toEqual([]);
  });

  it('marks the viewport FAILED with <stage>:PAGE_CRASHED and runs no later stage after a crash', async () => {
    let linksRead = false;
    const { outcome } = await run({
      view: (_name, emit) => ({
        collectDomEvidence: async () => { emit.crash(); return new Promise<never>(() => undefined); },
        discoverLinks: async () => { linksRead = true; return { links: [] } as never; },
      }),
    }, NO_STRESS);
    expect(outcome.result.viewports.desktop.status).toBe('FAILED');
    expect(codesOf(outcome.result.viewports.desktop.incompleteReasons)).toContain('COLLECTOR_INCOMPLETE:dom:PAGE_CRASHED');
    expect(linksRead).toBe(false);
  });

  it('marks the viewport PARTIAL with RULE_EVALUATION_FAILED when the rules throw', async () => {
    const { outcome } = await run({}, NO_STRESS, () => ({ createRuleEngine: () => ({ evaluate: () => { throw new Error('rule failed'); } }) }));
    expect(outcome.result.viewports.desktop).toMatchObject({ status: 'PARTIAL', incompleteReasons: [{ code: 'RULE_EVALUATION_FAILED' }] });
  });

  it('records a failure to close the Passive Context, and a Context that is not created before the deadline', async () => {
    const closed = await run({ closeFailure: (profile) => (profile === 'desktop' ? new Error('close failed') : null) }, NO_STRESS);
    expect(codesOf(closed.outcome.result.viewports.desktop.incompleteReasons)).toEqual(['UNHANDLED_FAILURE:passive-context-close:close failed']);
    const late = await run({ open: () => 'DEADLINE_EXCEEDED' }, NO_STRESS);
    expect(late.outcome.result.viewports.desktop).toMatchObject({ status: 'FAILED', incompleteReasons: [{ code: 'DEADLINE_EXCEEDED', detail: 'passive-context' }] });
  });

  it('keeps the Ledger of a Context that failed to be built, and writes the whole cause in the detail', async () => {
    const violating = new SafetyLedger();
    violating.recordInvariantViolation({ code: 'TEST_CONSTRUCTION_VIOLATION', message: 'injected' });
    const cause = `long-cause-${'x'.repeat(2_049)}`;
    const { outcome } = await run({
      open: (profile) => (profile === 'desktop' ? 'FAILED' : 'OPENED'),
      openFailure: () => ({ error: new ContextConstructionError({} as never, violating, new Error(cause)), ledger: violating }),
    }, NO_STRESS);
    const [reason] = outcome.result.viewports.desktop.incompleteReasons;
    expect(reason?.code).toBe('UNHANDLED_FAILURE');
    expect(reason?.detail?.startsWith('passive-context:')).toBe(true);
    expect(reason?.detail).toContain(cause);
    expect(outcome.safety.invariantViolationCount).toBe(1);
    expect(outcome.result.evidence.filter((record) => record.type === 'safety' && record.viewport === 'desktop')).toHaveLength(1);
    expect(outcome.result.viewports.mobile.status).toBe('AUDITED');
  });

  it.each([
    ['a close deadline', new PassiveContextCloseDeadlineError(), 'stress-layout:CLOSE_DEADLINE_EXCEEDED'],
    ['a close deadline inside nested AggregateErrors', new AggregateError(
      [new Error('work failed'), new AggregateError([new Error('page close failed'), new PassiveContextCloseDeadlineError()])], 'both failed',
    ), 'stress-layout:CLOSE_DEADLINE_EXCEEDED'],
    ['other failures', new AggregateError([new Error('work failed'), new Error('close failed')], 'both failed'), 'stress-layout:EVALUATION_FAILED'],
    ['an open deadline', new PassiveSessionOpenDeadlineError('context'), 'stress-layout:EVALUATION_FAILED'],
  ])('records the stress sweep that throws %s as %s', async (_label, error, detail) => {
    const { outcome } = await run({ stressLayoutError: () => error }, PLAIN);
    expect(codesOf(outcome.result.viewports.desktop.incompleteReasons).filter((code) => code.includes('stress-layout:')))
      .toEqual([`COLLECTOR_INCOMPLETE:${detail}`]);
  });

  it('passes the collectors the stage watch and no page deadline', async () => {
    const received: unknown[] = [];
    await run({
      view: () => ({ collectAccessibilityEvidence: async (options) => { received.push(options?.watch?.progress !== undefined); return { status: 'COMPLETE', violations: [] } as never; } }),
    }, { ...NO_STRESS, audit: { ...PLAIN.audit, accessibility: true } });
    expect(received.length).toBeGreaterThan(0);
    expect(received.every((hasProgress) => hasProgress === true)).toBe(true);
  });

  it('keeps the Ledger of a Context whose page is not created before the deadline in the safety Evidence', async () => {
    const { outcome } = await run({ open: () => 'PAGE_DEADLINE_EXCEEDED' }, NO_STRESS);
    expect(outcome.result.evidence.filter((record) => record.type === 'safety').map((record) => record.viewport)).toEqual(['desktop', 'mobile']);
  });
});

describe('the notification frames and the end of the session (wiring of the Page Auditor)', () => {
  it('does not scroll or measure a viewport whose close press tried to move the page, and marks it PARTIAL', async () => {
    const called: string[] = [];
    const { outcome } = await run({
      view: () => ({
        dismissNotificationFrames: async () => ({
          readStatus: 'READ', frames: [{ digest: 'frame', dismissed: true, hidden: false }], pressCount: 1, navigated: true, truncated: false,
        }) as never,
        controlledScroll: async () => { called.push('scroll'); return {} as never; },
        collectDomEvidence: async () => { called.push('dom'); return {} as never; },
      }),
    }, NO_STRESS);
    expect(called).toEqual([]);
    expect(outcome.result.viewports.desktop).toMatchObject({ status: 'PARTIAL', incompleteReasons: [{ code: 'NOTIFICATION_DISMISSAL_NAVIGATION_BLOCKED' }] });
  });

  it('drops the measured Evidence and the stress sweep of a viewport whose press period had a stopped move', async () => {
    const { fake, outcome } = await run({ view: (name) => (name === 'desktop' ? { pressNavigations: () => 1 } : {}) }, PLAIN);
    expect(fake.events.some((event) => event.startsWith('open:stress-'))).toBe(false);
    expect(outcome.result.evidence.filter((record) => record.viewport === 'desktop').map((record) => record.type)).not.toContain('dom');
    expect(codesOf(outcome.result.viewports.desktop.incompleteReasons)).toContain('NOTIFICATION_DISMISSAL_NAVIGATION_BLOCKED');
  });

  it('keeps no result of a stress width whose press period had a stopped move', async () => {
    const { outcome } = await run({ view: (name) => (name === 'stress-768' ? { pressNavigations: () => 1 } : {}) }, PLAIN);
    const layout = outcome.result.evidence.find((record) => record.type === 'layout' && record.viewport === 'desktop');
    expect(layout?.type === 'layout' ? layout.payload.stressSweep?.map(({ width }) => width) : null).toEqual([320, 1024]);
  });

  it('marks the viewport FAILED with AUTH_SESSION_LOST when the page lands on the login path, and skips Mobile', async () => {
    const { outcome } = await run({ view: () => ({ url: () => 'https://site.test/login' }) }, NO_STRESS, () => ({ sessionLostPathPrefix: '/login' }));
    expect(outcome.result.viewports.desktop).toMatchObject({ status: 'FAILED', incompleteReasons: [{ code: 'AUTH_SESSION_LOST' }] });
    expect(outcome.result.viewports.mobile).toMatchObject({ status: 'SKIPPED', incompleteReasons: [{ code: 'AUTH_SESSION_LOST' }] });
    expect(outcome.authSessionLostDetail).toBe('desktop:passive');
  });
});

describe('the interaction candidates', () => {
  const pacedCandidates = (events: readonly string[]): number => events.filter((event, index) => event === 'pacer' && events[index + 1]?.startsWith('interaction:')).length;

  it('audits up to maxInteractionsPerPage candidates, without pacing waits for the rest', async () => {
    const { fake, outcome } = await run({ candidates: (name) => (name === 'desktop' ? ['a', 'b', 'c'] : []) }, { ...INTERACTIONS, crawl: { maxInteractionsPerPage: 1 } });
    expect(fake.events.filter((event) => event.startsWith('interaction:'))).toEqual(['interaction:a']);
    expect(pacedCandidates(fake.events)).toBe(1);
    expect(codesOf(outcome.result.viewports.desktop.incompleteReasons)).toContain('COLLECTOR_INCOMPLETE:interaction:limit:remaining=2');
  });

  it('stops before the next candidate after a violation, with the remaining count', async () => {
    const { fake, outcome } = await run(
      { candidates: (name) => (name === 'desktop' ? ['a', 'b', 'c'] : []) },
      INTERACTIONS,
      (current) => ({ safetyViolationRecorded: () => current.events.includes('interaction:a') }),
    );
    expect(fake.events.filter((event) => event.startsWith('interaction:'))).toEqual(['interaction:a']);
    expect(codesOf(outcome.result.viewports.desktop.incompleteReasons)).toContain('COLLECTOR_INCOMPLETE:interaction:SAFETY_VIOLATION_ABORT:remaining=2');
  });

  it('records the cleanup failure with its snapshot and the construction failure with the Ledger of its Context', async () => {
    const violating = new SafetyLedger();
    const cleanup = await run({
      candidates: (name) => (name === 'desktop' ? ['a', 'b'] : []),
      interaction: () => ({ kind: 'CLEANUP_FAILED', safety: violating.snapshot() }),
    }, INTERACTIONS);
    expect(codesOf(cleanup.outcome.result.viewports.desktop.incompleteReasons)).toContain('COLLECTOR_INCOMPLETE:interaction:cleanup:remaining=1');
    expect(cleanup.fake.events.filter((event) => event.startsWith('interaction:'))).toEqual(['interaction:a']);
    const construction = await run({
      candidates: (name) => (name === 'desktop' ? ['a'] : []),
      interaction: () => ({
        kind: 'CONSTRUCTION_FAILED',
        error: new ContextConstructionError({} as never, violating, new Error('guard failed')),
        closeFailures: [{ step: 'context', error: new Error('close failed') }],
        safety: violating.snapshot(),
      }),
    }, INTERACTIONS);
    expect(codesOf(construction.outcome.result.viewports.desktop.incompleteReasons)).toEqual(expect.arrayContaining([
      'UNHANDLED_FAILURE:interaction-context-close:close failed',
      'COLLECTOR_INCOMPLETE:interaction:EVALUATION_FAILED',
    ]));
    expect(construction.outcome.result.evidence.filter((record) => record.type === 'safety')).toHaveLength(3);
  });

  it('presses on Mobile only the candidates that Desktop did not have', async () => {
    const { fake } = await run({ candidates: (name) => (name === 'desktop' ? ['a'] : ['a', 'm']) }, INTERACTIONS);
    expect(fake.events.filter((event) => event.startsWith('interaction:'))).toEqual(['interaction:a', 'interaction:m']);
  });
});
