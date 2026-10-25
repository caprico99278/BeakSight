// FM2d（設計書 `2026-10-19-beaksight-fewer-manual-steps-design.md` 3A.1）: まとめて実行の段の間で持ち越す、サービスの Origin への要求の 1 分の窓の受け渡し
// （`src/orchestration/audit-stage-run.ts`）。実行の上限は段ごとに数える（前の段の数は数えない）。窓の判定は上限の部品の 1 か所のまま。
// 例の値は、匿名の値（`127.0.0.1`）だけを使う。
import { describe, expect, it } from 'vitest';
import type { AuditStageServiceRequests } from '../../src/browser/context-factory.js';
import { LOAD_PEAK_WINDOW_MS } from '../../src/crawl/load-meter.js';
import { createNavigationPacer } from '../../src/crawl/navigation-pacer.js';
import {
  createAuditStageRunState,
  intervalTrackingNavigationPacer,
  jobContextFactoryOptions,
  nextStageNavigationPacerOf,
  recordRunStageCarry,
  serviceRequestWindowOf,
  type RunStageCarried,
} from '../../src/orchestration/audit-stage-run.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';

const SERVICE_ORIGIN = 'http://127.0.0.1:5173';

const AUDIT_STAGE: AuditStageServiceRequests = Object.freeze({
  approvedServiceOrigins: [SERVICE_ORIGIN],
  auditReadRequests: [],
  scriptLogin: { origin: SERVICE_ORIGIN, path: '/token', requiredQuery: [] },
  serviceRequestLimits: { perMinute: 2, perRun: 2 },
});

const AUTHENTICATION: RunAuthentication = Object.freeze({
  initialState: { cookies: [], origins: [] },
  approvedTestOrigins: ['http://127.0.0.1:4173'],
  auditExclusions: { excludedPathPrefixes: [], auditPathPrefixes: [], dangerousTerms: [] },
  sessionLostPathPrefix: '/login',
  filterState: (state: RunAuthentication['initialState']) => state,
  auditStage: AUDIT_STAGE,
});

class FakeClock {
  nowMs = 2_000_000;
  readonly now = (): number => this.nowMs;
}

describe('FM2d: the per minute window carried over by the audit stage state', () => {
  it('starts the state with the carried window, and counts the run limit from zero', () => {
    const clock = new FakeClock();
    const first = createAuditStageRunState(AUDIT_STAGE, clock.now, undefined);
    expect([first.budget.tryConsume(), first.budget.tryConsume()]).toEqual([true, true]);
    const carried = serviceRequestWindowOf(first);
    expect(carried).toEqual([2_000_000, 2_000_000]);
    clock.nowMs += 1_000;
    const second = createAuditStageRunState(AUDIT_STAGE, clock.now, undefined, carried);
    expect(second.budget.waitBeforeNextLoadMs()).toBe(LOAD_PEAK_WINDOW_MS - 1_000);
    expect(second.budget.isLimitReached()).toBe(false);
  });

  it('gives the carried window to the job flows (discovery and READ check)', () => {
    const clock = new FakeClock();
    const { state } = jobContextFactoryOptions(AUTHENTICATION, clock.now, 'REGISTERED', [1_999_000, 1_999_500]);
    expect(state?.budget.waitBeforeNextLoadMs()).toBe(1_999_000 + LOAD_PEAK_WINDOW_MS - 2_000_000);
    // 持ち越しを渡さなければ、今のまま（窓は空から）。
    expect(jobContextFactoryOptions(AUTHENTICATION, clock.now, 'REGISTERED').state?.budget.waitBeforeNextLoadMs()).toBe(0);
  });

  // FM2R の C-1: 読み込みの間隔の持ち越し。
  it('starts the next stage pacer from the later of the last navigation and the stage end, with the raised interval', async () => {
    const clock = new FakeClock();
    const slept: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      slept.push(ms);
      clock.nowMs += ms;
    };
    // 前の段: 設定は 100 ms、確かめ直しで 400 ms に上げた。最後の読み込みは 2_000_000、段の終わりは 2_000_300。
    const tracking = intervalTrackingNavigationPacer(createNavigationPacer({ minIntervalMs: 100, now: clock.now, sleep }), 100);
    tracking.pacer.raiseMinimumInterval(400);
    tracking.pacer.raiseMinimumInterval(200);
    expect(tracking.minIntervalMs()).toBe(400);
    const pacer = nextStageNavigationPacerOf({ lastNavigationStartedAtMs: 2_000_000, stageEndedAtMs: 2_000_300, minIntervalMs: tracking.minIntervalMs() }, 100, clock.now, sleep);
    clock.nowMs = 2_000_350;
    // 段の終わりから、上げた間隔（400 ms）まで待つ。
    expect(await pacer.beforeNavigation()).toBe(350);
    expect(clock.nowMs).toBe(2_000_700);
    // その後も、上げた間隔のまま。
    expect(await pacer.beforeNavigation()).toBe(400);
    expect(slept).toEqual([350, 400]);
  });

  it('records the navigation carry at the end of the stage (the last start, the end time and the interval)', () => {
    const clock = new FakeClock();
    const carried: RunStageCarried[] = [];
    const pacer = { snapshot: () => ({ navigationCount: 3, totalWaitMs: 0, lastNavigationStartedAtMs: 1_999_000 }) };
    recordRunStageCarry({ serviceRequestWindowMs: [], record: (value) => carried.push(value) }, null, null, { pacer, minIntervalMs: 250, now: clock.now });
    expect(carried.map(({ navigation }) => navigation)).toEqual([{ lastNavigationStartedAtMs: 1_999_000, stageEndedAtMs: 2_000_000, minIntervalMs: 250 }]);
  });

  it('returns an empty window without the audit stage state', () => {
    expect(serviceRequestWindowOf(null)).toEqual([]);
    const { state } = jobContextFactoryOptions({ ...AUTHENTICATION, auditStage: undefined }, new FakeClock().now, 'REGISTERED', [1]);
    expect(state).toBeNull();
  });
});
