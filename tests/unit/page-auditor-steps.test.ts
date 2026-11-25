/**
 * RB-10: Page Auditor の段の順を、偽の監査の読み込みの口（`tests/helpers/fake-audit-load-ports.ts`）で確かめる（ブラウザを使わない）。
 * - 間隔の待ち（守り 4）: 読み込み（ビューポート・幅・候補）の前に 1 回ずつ。始めない読み込みでは呼ばない（DEF-209）。
 * - 違反で次を始めない（C18f）と、DEF-191 の順（Desktop の Context を閉じてから幅の走査、その後に Mobile）。
 * - 段の失敗・閉じる失敗・Interaction の止め方の理由。
 * 本物の Chromium での読み込み・collector・Guard は、結合の代表（`tests/integration/page-auditor.test.ts` など）とずれの確かめが受け持つ。
 */
import { describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import type { IncompleteReason, PageId } from '../../src/core/contracts.js';
import type { LayoutEvidence, NormalizedHttpUrlEvidence } from '../../src/core/evidence-types.js';
import type { PageSamenessDecision, PageSamenessPort } from '../../src/orchestration/page-audit-plan.js';
import { dom } from '../helpers/audit-run-fixture.js';
import { ContextConstructionError } from '../../src/browser/context-factory.js';
import { PageAuditor, type AuditView, type PageAuditorDependencies } from '../../src/orchestration/page-auditor.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { PassiveContextCloseDeadlineError } from '../../src/orchestration/passive-session-close.js';
import { PassiveSessionOpenDeadlineError } from '../../src/orchestration/passive-session-open.js';
import type { TestConfigOverrides } from '../helpers/test-config.js';
import {
  EMPTY_STRESS_LAYOUT,
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
/** 見張りが幅を止める場面の、反応なしの長さ（ms。偽の段は、これより十分に短く終わる）。 */
const QUIET_LIMIT_MS = 100;

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
type Outcome = Awaited<ReturnType<PageAuditor['audit']>>;
/** Desktop の layout の Evidence の、幅の走査の幅（結果の順）。 */
const stressWidthsOf = (outcome: Outcome): readonly number[] | null => {
  const layout = outcome.result.evidence.find((record) => record.type === 'layout' && record.viewport === 'desktop');
  return layout?.type === 'layout' ? (layout.payload.stressSweep ?? []).map(({ width }) => width) : null;
};
/** 幅の走査の幅のフォーカスの確かめの Evidence の幅（記録の順）。 */
const focusWidthsOf = (outcome: Outcome): readonly number[] =>
  outcome.result.evidence.flatMap((record) => (record.type === 'focus' && record.payload.stressWidth !== undefined ? [record.payload.stressWidth] : []));
/** 幅の走査の safety の Evidence の読み込みの印（記録の順）。 */
const stressLoadsOf = (outcome: Outcome): readonly unknown[] =>
  outcome.result.evidence.flatMap((record) => (record.type === 'safety' && record.payload.load.kind === 'STRESS_WIDTH' ? [record.payload.load] : []));

describe('FRET: the window button check is the last step of a viewport (the press stop is held to the close)', () => {
  it('neither collects evidence nor loads on that page after the window button check', async () => {
    const { fake } = await run({}, NO_STRESS);
    for (const name of ['desktop', 'mobile']) {
      const calls = fake.calls.filter((call) => call.startsWith(`${name}:`)).map((call) => call.slice(name.length + 1));
      const at = calls.indexOf('checkDialogFocus');
      expect(at, name).toBeGreaterThanOrEqual(0);
      // 段の終わりの URL と位置の読み（`captureLocation`）は、段の記録の印で、証拠を集める段でない。
      expect(calls.slice(at + 1).filter((call) => /^(?:navigate|collect|capture(?!Location)|reveal|check|discover|dismiss|controlledScroll|waitForSettled|read|attach)/u
        .test(call)), name)
        .toEqual([]);
    }
  });
});

describe('the audit load ports', () => {
  it('is a TypeError to give the collectors with the audit load ports (they would be ignored)', () => {
    const fake = createFakeAuditLoadPorts({});
    expect(() => new PageAuditor(fakeAuditorDependencies(fake, { collectors: {} }, PLAIN))).toThrow(TypeError);
  });
});

describe('the order of the loads and the pacing waits (keep 4, DEF-191)', () => {
  // SWR: 幅の走査は、1 つの page を広い幅で 1 回だけ読み込み、広い順に大きさだけを変え、最後に一番狭い幅を読み込み直して照らし合わせる（ふだん 2 回）。
  it('waits before every load, sweeps the stress widths after the Desktop Context is closed with two loads, and then audits Mobile', async () => {
    const { fake, outcome } = await run({}, PLAIN);
    expect(fake.events).toEqual([
      'pacer', 'open:desktop', 'navigate:desktop', 'shown-wait:desktop', 'close:desktop',
      'pacer', 'open:stress-1024', 'resize:stress-1024:768', 'resize:stress-1024:320', 'shown-wait:stress-1024', 'close:stress-1024',
      'pacer', 'open:stress-320', 'shown-wait:stress-320', 'close:stress-320',
      'pacer', 'open:mobile', 'navigate:mobile', 'close:mobile',
    ]);
    expect([outcome.result.viewports.desktop.status, outcome.result.viewports.mobile.status]).toEqual(['AUDITED', 'AUDITED']);
    expect(stressWidthsOf(outcome)).toEqual([1024, 768, 320]);
    // 幅ごとの確かめ（フォーカス）は 1 回ずつ。照らし合わせだけの、大きさを変えた一番狭い幅は残さない。
    expect(focusWidthsOf(outcome)).toEqual([1024, 768, 320]);
    // 大きさを変えた Context の Ledger は 1 つで、大きさを変えて測り、結果を残した幅の一覧を付ける（REV-SWR の M-1。照らし合わせの幅は入れない）。
    // 読み込み直した幅は、今どおり幅ごと。
    expect(stressLoadsOf(outcome)).toEqual([{ kind: 'STRESS_WIDTH', width: 1024, widths: [1024, 768] }, { kind: 'STRESS_WIDTH', width: 320 }]);
  });

  it('goes back to loading each width when the narrowest width differs between the resized and the loaded page', async () => {
    const overflowing = { ...EMPTY_STRESS_LAYOUT, document: { ...EMPTY_STRESS_LAYOUT.document, horizontalOverflowPx: 40 } };
    const { fake, outcome } = await run({ stressLayout: (width, mode) => (width === 320 && mode === 'RESIZED' ? overflowing : EMPTY_STRESS_LAYOUT) }, PLAIN);
    expect(after(fake.events, 'close:stress-320')).toEqual([
      'pacer', 'open:stress-1024', 'shown-wait:stress-1024', 'close:stress-1024',
      'pacer', 'open:stress-768', 'shown-wait:stress-768', 'close:stress-768',
      'pacer', 'open:mobile', 'navigate:mobile', 'close:mobile',
    ]);
    expect(stressWidthsOf(outcome)).toEqual([1024, 768, 320]);
    // 大きさを変えて集めた幅の確かめは捨て、読み込み直した幅の確かめだけを残す。大きさを変えた Context の Ledger は、結果を残した幅を持たない（M-1）。
    expect(focusWidthsOf(outcome)).toEqual([320, 1024, 768]);
    expect(stressLoadsOf(outcome)[0]).toEqual({ kind: 'STRESS_WIDTH', width: 1024, widths: [] });
  });

  // REV-SWR の M-2: 一番狭い幅で見張りが走査を止めたときも、その幅の通知の枠の記録と押す期間の移動の印を残さない（結果のない幅）。
  it('keeps no notification record and no stopped move of the narrowest width when the watch stops the sweep there', async () => {
    let width = 1024;
    let moves = 0;
    const { outcome } = await run({
      afterStressResize: (resized) => { width = resized; },
      view: (name) => (name === 'stress-1024' ? {
        pressNavigations: () => moves,
        dismissNotificationFrames: async () => {
          if (width !== 320) {
            return { readStatus: 'READ', frames: [], pressCount: 0, navigated: false, truncated: false } as never;
          }
          moves += 1;
          return { readStatus: 'READ', frames: [{ digest: 'frame', dismissed: true, hidden: false }], pressCount: 1, navigated: false, truncated: false } as never;
        },
        // 一番狭い幅の照らし合わせの読み取りが、見張りの反応なしの長さより長く返らない。
        collectFocusChecks: async ({ stressWidth }) => {
          if (stressWidth === 320) {
            await wait(QUIET_LIMIT_MS * 4);
          }
          return { items: [], ...(stressWidth === null ? {} : { stressWidth }) } as never;
        },
      } : {}),
    }, PLAIN, () => ({ progressWatchQuietLimitMs: QUIET_LIMIT_MS }));
    expect(stressWidthsOf(outcome)).toEqual([1024, 768]);
    const layout = outcome.result.evidence.find((record) => record.type === 'layout' && record.viewport === 'desktop');
    expect(layout?.type === 'layout' ? (layout.payload.stressNotificationOverlays ?? []).map((row) => row.width) : null).toEqual([]);
    expect(codesOf(outcome.result.viewports.desktop.incompleteReasons)).not.toContain('NOTIFICATION_DISMISSAL_NAVIGATION_BLOCKED');
    expect(stressLoadsOf(outcome)).toEqual([{ kind: 'STRESS_WIDTH', width: 1024, widths: [1024, 768] }]);
  });

  // S-03a: 幅の走査で隠した枠の数を、主の読み込みの数と分けて残す。
  it('records the frames hidden in the stress sweep apart from the main load', async () => {
    const { outcome } = await run({
      view: (name) => (name === 'stress-1024' ? {
        dismissNotificationFrames: async () => ({
          readStatus: 'READ', frames: [{ digest: 'frame', dismissed: false, hidden: true, hiddenReason: 'NO_CLOSE_BUTTON' }], pressCount: 0, navigated: false, truncated: false,
        }) as never,
      } : {}),
    }, PLAIN);
    expect(outcome.result.viewports.desktop.notificationHandling).toMatchObject({ hiddenCount: 0, stressHiddenCount: 1 });
  });

  it('goes back to loading each width when a resized width fails', async () => {
    const { fake, outcome } = await run({ stressLayout: (width, mode) => (width === 768 && mode === 'RESIZED' ? null : EMPTY_STRESS_LAYOUT) }, PLAIN);
    expect(fake.events.filter((event) => event.startsWith('open:stress-'))).toEqual(['open:stress-1024', 'open:stress-1024', 'open:stress-768', 'open:stress-320']);
    expect(stressWidthsOf(outcome)).toEqual([1024, 768, 320]);
    expect(focusWidthsOf(outcome)).toEqual([1024, 768, 320]);
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

  it('does not start the next stress width, resized or loaded, after a violation in a stress session', async () => {
    let violated = false;
    const { fake, outcome } = await run({ afterStressOpen: () => { violated = true; } }, PLAIN, () => ({ safetyViolationRecorded: () => violated }));
    expect(after(fake.events, 'open:stress-1024')).toEqual(['close:stress-1024']);
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
    expect(after(fake.events, 'close:stress-1024')).toEqual([]);
    expect(fake.events.some((event) => event.startsWith('resize:'))).toBe(false);
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

  // SWR: 大きさを変えて回す page では、幅ごとに押す期間の移動の数の差を控えて、その幅だけを捨てる。
  it('keeps no result of a stress width whose press period had a stopped move, counted per width on the resized page', async () => {
    let moves = 0;
    const { outcome } = await run({
      afterStressResize: (width) => { moves += width === 768 ? 1 : 0; },
      view: (name) => (name === 'stress-1024' ? { pressNavigations: () => moves } : {}),
    }, PLAIN);
    expect(stressWidthsOf(outcome)).toEqual([1024, 320]);
    expect(focusWidthsOf(outcome)).toEqual([1024, 320]);
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

// DUP（ユーザーの判断 2026-11-18）: 同じ作りの 2 つ目以降は軽い点検（幅の走査・Interaction・性能・フォーカスの確かめ・Mobile の axe を省く）、中身も同じなら
// Desktop の layout と links の後の段をしない。決めた深さと鍵は、Run Coordinator の口に知らせる。
describe('DUP: the depth of the audit of a page of a known template', () => {
  const AXE_AND_INTERACTIONS: TestConfigOverrides = { audit: { screenshots: false, accessibility: true, performance: false, interactions: true } };
  const REFERENCE = 'PAGE-000009' as PageId;
  /**
   * Rule の見本: 渡された記録の種類ごとに 1 件の指摘を作る（`dom` は WARN、`network` は ERROR、`safety` は SAFETY。SAME のページでは、安全・通信・console の
   * 記録だけを渡す）。
   */
  const ruleFindings = (): NonNullable<PageAuditorDependencies['createRuleEngine']> => () => ({
    evaluate: ({ evidence }) => ({
      findings: [
        ...(evidence.some(({ type }) => type === 'dom') ? [{ severity: 'WARN', evidenceRefs: [] }] : []),
        ...(evidence.some(({ type }) => type === 'network') ? [{ severity: 'ERROR', evidenceRefs: [] }] : []),
        ...(evidence.some(({ type }) => type === 'safety') ? [{ severity: 'SAFETY', evidenceRefs: [] }] : []),
      ] as never,
      failures: [],
      nextFindingSequence: 1,
    }),
  });
  const runWithSameness = async (sameAs: PageId | null, layout: LayoutEvidence | null) => {
    const called: string[] = [];
    const decisions: PageSamenessDecision[] = [];
    const sameness: PageSamenessPort = { referenceOf: () => REFERENCE, sameContentAs: () => sameAs, decided: (decision) => decisions.push(decision) };
    const { fake, outcome } = await run({
      candidates: (name) => (name === 'desktop' ? ['a'] : ['a', 'm']),
      view: (name) => ({
        collectDomEvidence: async () => dom(1, FAKE_PAGE.pageId, 'desktop', '本文').payload,
        collectLayoutEvidence: async () => (layout === null ? { status: 'PARTIAL', reason: 'DEADLINE_EXCEEDED', layout: null } : { status: 'COMPLETE', layout }),
        collectAccessibilityEvidence: async () => { called.push(`axe:${name}`); return { status: 'COMPLETE', violations: [] } as never; },
        collectFocusChecks: async () => { called.push(`focus:${name}`); return { items: [] } as never; },
        discoverLinks: async () => { called.push(`links:${name}`); return { links: [] } as never; },
      }),
    }, AXE_AND_INTERACTIONS, () => ({ pageSameness: sameness, createRuleEngine: ruleFindings() }));
    return { events: fake.events, called, decisions, result: outcome.result };
  };

  it('audits lightly: no stress width, no interaction, no focus check and no Mobile axe, and records the first page of the template', async () => {
    const { events, called, decisions, result } = await runWithSameness(null, null);
    expect(events.filter((event) => event.startsWith('open:') || event.startsWith('interaction:'))).toEqual(['open:desktop', 'open:mobile']);
    expect([...new Set(called)]).toEqual(['axe:desktop', 'links:desktop', 'links:mobile']);
    expect(decisions).toEqual([expect.objectContaining({ pageId: FAKE_PAGE.pageId, depth: 'LIGHT', sameAs: REFERENCE, contentDigest: null })]);
    expect(result.sameness).toEqual({ depth: 'LIGHT', sameAs: REFERENCE });
  });

  it('stops after the Desktop layout and the links of a page whose content is the same, without Mobile, findings or a partial status', async () => {
    const same = 'PAGE-000008' as PageId;
    const { events, called, decisions, result } = await runWithSameness(same, EMPTY_STRESS_LAYOUT);
    expect(events.filter((event) => event.startsWith('open:') || event.startsWith('interaction:'))).toEqual(['open:desktop']);
    expect(called).toEqual(['links:desktop']);
    expect(decisions).toEqual([expect.objectContaining({ depth: 'SAME', sameAs: same })]);
    expect(result.sameness).toEqual({ depth: 'SAME', sameAs: same });
    expect(result.status).toBe('AUDITED');
    expect(result.incompleteReasons).toEqual([]);
    expect(result.viewports.mobile.status).toBe('SKIPPED');
    expect(codesOf(result.viewports.mobile.incompleteReasons)).toEqual([`SAME_CONTENT_AS_EARLIER_PAGE:${same}`]);
    expect(result.findings.map(({ severity }) => severity)).toEqual(['ERROR', 'SAFETY']);
  });
});
