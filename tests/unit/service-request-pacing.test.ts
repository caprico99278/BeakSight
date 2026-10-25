// DEF-141（設計書 `2026-10-20-beaksight-service-request-pacing-design.md` 2.2、2.4）: 承認したサービスの Origin への要求の 1 分あたりの上限で、次の読み込みの
// 前に待つ部品。
// - 読み込みの間隔の部品（`NavigationPacer`）を包む 1 つの部品（`withAdditionalNavigationWait`。`src/crawl/navigation-pacer.ts`）: 次の読み込みの前に、待つ
//   時間の口（`waitBeforeNextLoadMs`）が返す時間だけ待ってから、間隔の部品の待ちに進む（重ねる。長い方を待つ）。待った時間の合計を返す。記録・保存・
//   間隔の上げ方・送った時刻の記録は、包んだ部品のまま。
// - Run Coordinator・発見・READ の確かめが共用する口（`serviceRequestPacedNavigationPacer`。`src/orchestration/audit-stage-run.ts`）: 監査の段の状態が
//   なければ包まない。待ったら、回数と合計の時間を状態に足し、知らせ（`SERVICE_REQUEST_PACING_WAIT`。Run の全体の回数と合計）を出す。数は `run.json`・
//   発見・READ の結果の `authentication` と、再開の保存に残る（前の実行の数に足す）。
// 時刻と待ちは注入する（実際には待たない）。例の値は、匿名の値（`example.invalid`）だけを使う。
import { describe, expect, it } from 'vitest';
import type { AuditStageServiceRequests } from '../../src/browser/context-factory.js';
import { LOAD_PEAK_WINDOW_MS } from '../../src/crawl/load-meter.js';
import { createNavigationPacer, withAdditionalNavigationWait, type NavigationPacer } from '../../src/crawl/navigation-pacer.js';
import { sameJobAuthenticationSummary } from '../../src/discovery/discovery-result.js';
import {
  auditStageCountsOf,
  createAuditStageRunState,
  runAuthenticationSummaryOf,
  serviceRequestPacedNavigationPacer,
  type ServiceRequestPacingNotice,
} from '../../src/orchestration/audit-stage-run.js';

const START_MS = 5_000_000;
const INTERVAL_MS = 5_000;
const SERVICE_ORIGIN = 'https://service.example.invalid';

/** 偽の時計。`sleep(ms)` は、すぐに時刻を `ms` だけ進めて終わる。 */
class FakeTime {
  nowMs = START_MS;
  readonly sleeps: number[] = [];
  readonly now = (): number => this.nowMs;
  readonly sleep = async (ms: number): Promise<void> => {
    this.sleeps.push(ms);
    this.nowMs += ms;
    await Promise.resolve();
  };
}

const fixedSource = (waits: readonly number[]): { readonly waitBeforeNextLoadMs: () => number; calls: number } => {
  const source = {
    calls: 0,
    waitBeforeNextLoadMs: (): number => {
      const value = waits[source.calls] ?? 0;
      source.calls += 1;
      return value;
    },
  };
  return source;
};

describe('DEF-141: the additional wait before the next load, layered on the navigation pacer', () => {
  it('does not wait when the source returns 0, and returns the wait of the pacer', async () => {
    const time = new FakeTime();
    const pacer = createNavigationPacer({ minIntervalMs: INTERVAL_MS, now: time.now, sleep: time.sleep });
    const waits: number[] = [];
    const paced = withAdditionalNavigationWait(pacer, { source: fixedSource([0, 0]), sleep: time.sleep, onWait: (ms) => waits.push(ms) });
    expect(await paced.beforeNavigation()).toBe(0);
    expect(await paced.beforeNavigation()).toBe(INTERVAL_MS);
    expect(waits).toEqual([]);
    expect(time.sleeps).toEqual([INTERVAL_MS]);
    expect(paced.snapshot()).toEqual(pacer.snapshot());
  });

  it('waits the longer of the source and the pacer (the source is longer)', async () => {
    const time = new FakeTime();
    const pacer = createNavigationPacer({ minIntervalMs: INTERVAL_MS, now: time.now, sleep: time.sleep });
    const waits: number[] = [];
    const paced = withAdditionalNavigationWait(pacer, { source: fixedSource([0, 30_000]), sleep: time.sleep, onWait: (ms) => waits.push(ms) });
    await paced.beforeNavigation();
    const startedAt = time.nowMs;
    expect(await paced.beforeNavigation()).toBe(30_000);
    expect(time.nowMs - startedAt).toBe(30_000);
    // 間隔の部品は、待った後には待たない（重ねる）。間隔の待ちの記録は、間隔の部品の待ちだけ。
    expect(time.sleeps).toEqual([30_000]);
    expect(waits).toEqual([30_000]);
    expect(pacer.snapshot()).toMatchObject({ navigationCount: 2, totalWaitMs: 0 });
  });

  it('waits the longer of the source and the pacer (the pacer is longer)', async () => {
    const time = new FakeTime();
    const pacer = createNavigationPacer({ minIntervalMs: INTERVAL_MS, now: time.now, sleep: time.sleep });
    const paced = withAdditionalNavigationWait(pacer, { source: fixedSource([0, 1_000]), sleep: time.sleep, onWait: () => undefined });
    await paced.beforeNavigation();
    const startedAt = time.nowMs;
    expect(await paced.beforeNavigation()).toBe(INTERVAL_MS);
    expect(time.nowMs - startedAt).toBe(INTERVAL_MS);
    expect(time.sleeps).toEqual([1_000, INTERVAL_MS - 1_000]);
  });

  it('passes the other operations to the pacer', () => {
    const calls: string[] = [];
    const pacer: NavigationPacer = {
      beforeNavigation: async () => 0,
      snapshot: () => ({ navigationCount: 7, totalWaitMs: 8, lastNavigationStartedAtMs: 9 }),
      raiseMinimumInterval: (ms) => { calls.push(`raise ${String(ms)}`); },
      recordDocumentRequestSent: () => { calls.push('sent'); },
    };
    const paced = withAdditionalNavigationWait(pacer, { source: fixedSource([]), sleep: async () => undefined, onWait: () => undefined });
    paced.raiseMinimumInterval(10);
    paced.recordDocumentRequestSent();
    expect(calls).toEqual(['raise 10', 'sent']);
    expect(paced.snapshot()).toEqual({ navigationCount: 7, totalWaitMs: 8, lastNavigationStartedAtMs: 9 });
    expect(Object.isFrozen(paced)).toBe(true);
  });

  it.each([-1, 1.5, Number.NaN, LOAD_PEAK_WINDOW_MS + 1])('rejects a wait of %s from the source without loading', async (value) => {
    const time = new FakeTime();
    const pacer = createNavigationPacer({ minIntervalMs: 0, now: time.now, sleep: time.sleep });
    const paced = withAdditionalNavigationWait(pacer, { source: fixedSource([value]), sleep: time.sleep, onWait: () => undefined });
    await expect(paced.beforeNavigation()).rejects.toThrow(RangeError);
    expect(pacer.snapshot().navigationCount).toBe(0);
  });

  it('handles overlapping calls one by one', async () => {
    const time = new FakeTime();
    const pacer = createNavigationPacer({ minIntervalMs: 0, now: time.now, sleep: time.sleep });
    const source = fixedSource([10_000, 20_000]);
    const paced = withAdditionalNavigationWait(pacer, { source, sleep: time.sleep, onWait: () => undefined });
    const results = await Promise.all([paced.beforeNavigation(), paced.beforeNavigation()]);
    expect(results).toEqual([10_000, 20_000]);
    expect(time.sleeps).toEqual([10_000, 20_000]);
  });
});

describe('DEF-141: the paced pacer shared by the Run Coordinator, the discovery and the read check', () => {
  const auditStage: AuditStageServiceRequests = {
    approvedServiceOrigins: [SERVICE_ORIGIN],
    auditReadRequests: [],
    scriptLogin: { origin: SERVICE_ORIGIN, path: '/auth/v1/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] },
    serviceRequestLimits: { perMinute: 2, perRun: 100 },
  };

  it('does not wrap the pacer without the audit stage', () => {
    const time = new FakeTime();
    const pacer = createNavigationPacer({ minIntervalMs: 0, now: time.now, sleep: time.sleep });
    expect(serviceRequestPacedNavigationPacer(pacer, null, time.sleep, () => undefined)).toBe(pacer);
  });

  it('waits by the per minute limit before the next load, records the counts and notifies the totals of the whole Run', async () => {
    const time = new FakeTime();
    const previous = {
      registeredReadRequestsAllowed: 0,
      tokenRefreshBlocked: 0,
      otherNonReadBlocked: 0,
      serviceUnauthorizedResponses: 0,
      serviceRequestsAdmitted: 4,
      serviceRequestLimitRefused: 0,
      allowedOriginDataRequestsBlocked: 0,
      serviceRequestPacingWaits: 2,
      serviceRequestPacingWaitMs: 70_000,
    };
    const state = createAuditStageRunState(auditStage, time.now, previous);
    const pacer = createNavigationPacer({ minIntervalMs: 0, now: time.now, sleep: time.sleep });
    const notices: ServiceRequestPacingNotice[] = [];
    const paced = serviceRequestPacedNavigationPacer(pacer, state, time.sleep, (notice) => notices.push(notice));
    expect(await paced.beforeNavigation()).toBe(0);
    // 1 回の読み込みで、上限を超える数を出した（断らない）。
    expect([state.budget.tryConsume(), state.budget.tryConsume(), state.budget.tryConsume()]).toEqual([true, true, true]);
    time.nowMs += 10_000;
    expect(await paced.beforeNavigation()).toBe(LOAD_PEAK_WINDOW_MS - 10_000);
    expect(notices).toEqual([{ kind: 'SERVICE_REQUEST_PACING_WAIT', waitMs: LOAD_PEAK_WINDOW_MS - 10_000, waitCount: 3, totalWaitMs: 120_000 }]);
    expect(Object.isFrozen(notices[0])).toBe(true);
    expect(auditStageCountsOf(state)).toMatchObject({ serviceRequestsAdmitted: 7, serviceRequestPacingWaits: 3, serviceRequestPacingWaitMs: 120_000 });
    const summary = runAuthenticationSummaryOf(state);
    expect(summary).toMatchObject({ serviceRequestLimitReached: false, serviceRequestPacingWaits: 3, serviceRequestPacingWaitMs: 120_000 });
    // 待った後は、窓の中の数が上限を下回るので、待たない。
    expect(await paced.beforeNavigation()).toBe(0);
    expect(notices).toHaveLength(1);
  });

  // LG-4: 数のない前の版の保存は読まない（`checkpoint` のスキーマが数を必須にした）ので、0 から数える確かめは捨てた。
  it('compares the counts of the waits between the summary of the IPC and the artifact', () => {
    const base = {
      registeredReadRequestsAllowed: 0,
      tokenRefreshBlocked: 0,
      otherNonReadBlocked: 0,
      serviceUnauthorizedResponses: 0,
      serviceRequestLimitReached: false,
      allowedOriginDataRequestsBlocked: 0,
      serviceRequestPacingWaits: 1,
      serviceRequestPacingWaitMs: 1_000,
    };
    expect(sameJobAuthenticationSummary(base, { ...base })).toBe(true);
    expect(sameJobAuthenticationSummary(base, { ...base, serviceRequestPacingWaits: 2 })).toBe(false);
    expect(sameJobAuthenticationSummary(base, { ...base, serviceRequestPacingWaitMs: 2_000 })).toBe(false);
  });
});
