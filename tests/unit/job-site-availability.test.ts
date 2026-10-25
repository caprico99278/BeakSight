// DEF-136（設計書 `2026-10-18-beaksight-job-site-unavailability-design.md` の 3.1・3.2）: 発見と READ の確かめのジョブの、サイトの不調の扱いの部品
// （`src/worker/job-site-availability.ts`）。
// - 読み込みの判定の順（`pageLoadVerdictOf`）: 不調（読み取りの監査と同じ `siteUnavailabilityOf`）→ 読み込みの失敗 → エラーの状態（4xx・5xx）→ 読める。
//   セッションの切れは、読み込みの部品（`visitGuardedPage`）がこの判定の前に見分ける。
// - 確かめ直し（`createJobSiteRecheck`）: 不調なら、知らせを出し、待ってから同じ画面を 1 回だけ確かめ直す。まだ不調なら止める。通ったら、読み込みの
//   間隔を読み取りの監査と同じ部品（`slowedNavigationIntervalMs`）で上げる。待つ間に止める印が来たら、確かめ直さずに止める。
import { describe, expect, it } from 'vitest';
import type { MainFrameLoadObservation } from '../../src/browser/main-frame-load.js';
import type { NavigationPacer } from '../../src/crawl/navigation-pacer.js';
import { discoveryRunStatusOf } from '../../src/discovery/discovery-result.js';
import { readEvidenceRunStatusOf } from '../../src/discovery/read-check-evaluation.js';
import type { PageNavigationResult } from '../../src/orchestration/page-navigation.js';
import {
  SITE_UNAVAILABLE_RECHECK_DELAYS_MS,
  SITE_UNAVAILABLE_SLOWDOWN_FACTOR,
  SITE_UNAVAILABLE_SLOWDOWN_MAX_FACTOR,
  slowedNavigationIntervalMs,
} from '../../src/orchestration/site-availability.js';
import * as runCoordinator from '../../src/orchestration/run-coordinator.js';
import {
  JOB_SITE_UNAVAILABLE_RECHECK_DELAY_MS,
  createJobSiteRecheck,
  pageLoadVerdictOf,
  type JobSiteNotice,
} from '../../src/worker/job-site-availability.js';

const navigationOf = (observation: MainFrameLoadObservation): PageNavigationResult => Object.freeze({
  navigationOutcome: observation.navigationOutcome,
  httpStatus: observation.navigationOutcome === 'OK' ? observation.httpStatus : null,
  finalUrl: null,
  failureDetail: observation.failureDetail,
  loadObservation: observation,
});
const observed = (navigationOutcome: MainFrameLoadObservation['navigationOutcome'], httpStatus: number | null, failureDetail: string | null = null) =>
  navigationOf({ navigationOutcome, httpStatus, failureDetail });

describe('DEF-136: the verdict of a page load of a job (pageLoadVerdictOf)', () => {
  it.each<[string, PageNavigationResult, string]>([
    ['200', observed('OK', 200), 'READABLE'],
    ['302 kept as the final 200', observed('OK', 200), 'READABLE'],
    ['no status on OK', observed('OK', null), 'READABLE'],
    ['503', observed('OK', 503), 'SITE_UNAVAILABLE'],
    ['429', observed('OK', 429), 'SITE_UNAVAILABLE'],
    ['502', observed('OK', 502), 'SITE_UNAVAILABLE'],
    ['504', observed('OK', 504), 'SITE_UNAVAILABLE'],
    ['a timeout without a response', observed('TIMEOUT', null), 'SITE_UNAVAILABLE'],
    ['a refused connection', observed('FAILED', null, 'page.goto: net::ERR_CONNECTION_REFUSED at x'), 'SITE_UNAVAILABLE'],
    ['an empty response', observed('FAILED', null, 'page.goto: net::ERR_EMPTY_RESPONSE at x'), 'SITE_UNAVAILABLE'],
    ['a timeout after a 200 response', observed('TIMEOUT', 200), 'NAVIGATION_FAILED'],
    ['an aborted load', observed('FAILED', null, 'page.goto: net::ERR_ABORTED at x'), 'NAVIGATION_FAILED'],
    ['500', observed('OK', 500), 'HTTP_ERROR_STATUS'],
    ['404', observed('OK', 404), 'HTTP_ERROR_STATUS'],
    ['403', observed('OK', 403), 'HTTP_ERROR_STATUS'],
  ])('judges %s', (_name, navigation, expected) => {
    expect(pageLoadVerdictOf(navigation).kind).toBe(expected);
  });

  it('keeps the status of an error page and the detail of an unavailability', () => {
    expect(pageLoadVerdictOf(observed('OK', 500))).toEqual({ kind: 'HTTP_ERROR_STATUS', httpStatus: 500 });
    expect(pageLoadVerdictOf(observed('OK', 503))).toEqual({ kind: 'SITE_UNAVAILABLE', unavailability: { kind: 'HTTP_STATUS', detail: 'HTTP 503' } });
  });
});

describe('DEF-136: the slowdown shared with the read-only audit (slowedNavigationIntervalMs)', () => {
  it('doubles the interval up to the limit, and keeps 0 at 0', () => {
    expect(slowedNavigationIntervalMs(1_000, 1_000)).toBe(1_000 * SITE_UNAVAILABLE_SLOWDOWN_FACTOR);
    expect(slowedNavigationIntervalMs(1_000 * SITE_UNAVAILABLE_SLOWDOWN_MAX_FACTOR, 1_000)).toBe(1_000 * SITE_UNAVAILABLE_SLOWDOWN_MAX_FACTOR);
    expect(slowedNavigationIntervalMs(5_000, 1_000)).toBe(1_000 * SITE_UNAVAILABLE_SLOWDOWN_MAX_FACTOR);
    expect(slowedNavigationIntervalMs(0, 0)).toBe(0);
  });

  it('uses the first wait of the read-only audit (the same named constant), and the run coordinator re-exports the constants', () => {
    expect(JOB_SITE_UNAVAILABLE_RECHECK_DELAY_MS).toBe(SITE_UNAVAILABLE_RECHECK_DELAYS_MS[0]);
    expect(JOB_SITE_UNAVAILABLE_RECHECK_DELAY_MS).toBe(60_000);
    expect(runCoordinator.SITE_UNAVAILABLE_RECHECK_DELAYS_MS).toBe(SITE_UNAVAILABLE_RECHECK_DELAYS_MS);
    expect(runCoordinator.SITE_UNAVAILABLE_SLOWDOWN_FACTOR).toBe(SITE_UNAVAILABLE_SLOWDOWN_FACTOR);
    expect(runCoordinator.SITE_UNAVAILABLE_SLOWDOWN_MAX_FACTOR).toBe(SITE_UNAVAILABLE_SLOWDOWN_MAX_FACTOR);
  });
});

/** 間隔の引き上げを記録する pacer（ほかの操作は使わない）。 */
const recordingPacer = () => {
  const raised: number[] = [];
  const pacer: NavigationPacer = {
    beforeNavigation: () => Promise.resolve(0),
    snapshot: () => { throw new Error('not used'); },
    raiseMinimumInterval: (ms) => { raised.push(ms); },
    recordDocumentRequestSent: () => undefined,
  };
  return { pacer, raised };
};

describe('DEF-136: one recheck of an unavailable page (createJobSiteRecheck)', () => {
  const URL = 'http://127.0.0.1:4173/admin/list';
  const setup = (controller = new AbortController(), configuredMinIntervalMs = 400) => {
    const { pacer, raised } = recordingPacer();
    const notices: JobSiteNotice[] = [];
    const sleeps: number[] = [];
    const recheck = createJobSiteRecheck({
      delayMs: 50, stopSignal: controller.signal, pacer, configuredMinIntervalMs, onNotice: (notice) => notices.push(notice),
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    return { recheck, raised, notices, sleeps, controller };
  };
  const sequence = (results: readonly boolean[]) => {
    let calls = 0;
    return {
      visit: (): Promise<boolean> => Promise.resolve(results[Math.min(calls++, results.length - 1)] ?? false),
      get calls() {
        return calls;
      },
    };
  };

  it('does not wait when the page is available', async () => {
    const { recheck, notices, sleeps } = setup();
    const pages = sequence([false]);
    expect(await recheck.visit(URL, () => pages.visit(), (unavailable) => unavailable)).toEqual({ kind: 'DONE', value: false });
    expect([pages.calls, notices, sleeps]).toEqual([1, [], []]);
  });

  it('rechecks once after the wait, goes on when the page comes back, and doubles the interval each time it passes (up to the limit)', async () => {
    const { recheck, notices, sleeps, raised } = setup();
    const pages = sequence([true, false]);
    expect(await recheck.visit(URL, () => pages.visit(), (unavailable) => unavailable)).toEqual({ kind: 'DONE', value: false });
    expect([pages.calls, sleeps, raised]).toEqual([2, [50], [800]]);
    expect(notices).toEqual([
      { kind: 'SITE_UNAVAILABLE_RECHECK', url: URL, delayMs: 50, attempt: 1, maxAttempts: 1 },
      { kind: 'SITE_UNAVAILABLE_SLOWDOWN', minIntervalMs: 800 },
    ]);
    const again = sequence([true, false]);
    await recheck.visit(URL, () => again.visit(), (unavailable) => unavailable);
    expect(raised).toEqual([800, 1_600]);
  });

  it('stops when the page is still unavailable after the recheck', async () => {
    const { recheck, notices } = setup();
    const pages = sequence([true, true]);
    expect(await recheck.visit(URL, () => pages.visit(), (unavailable) => unavailable)).toEqual({ kind: 'SITE_UNAVAILABLE', value: true });
    expect(pages.calls).toBe(2);
    expect(notices.map(({ kind }) => kind)).toEqual(['SITE_UNAVAILABLE_RECHECK']);
  });

  it('stops without the recheck when the stop signal comes during the wait, or before it', async () => {
    const controller = new AbortController();
    const { pacer } = recordingPacer();
    const recheck = createJobSiteRecheck({
      delayMs: 50, stopSignal: controller.signal, pacer, configuredMinIntervalMs: 400,
      sleep: () => {
        controller.abort();
        return new Promise(() => undefined);
      },
    });
    const pages = sequence([true, false]);
    expect(await recheck.visit(URL, () => pages.visit(), (unavailable) => unavailable)).toEqual({ kind: 'STOPPED', value: true });
    expect(pages.calls).toBe(1);
    const stopped = sequence([true, false]);
    expect(await recheck.visit(URL, () => stopped.visit(), (unavailable) => unavailable)).toEqual({ kind: 'STOPPED', value: true });
    expect(stopped.calls).toBe(1);
  });

  it('does not raise the interval of a loopback test configuration (0)', async () => {
    const { recheck, raised, notices } = setup(new AbortController(), 0);
    const pages = sequence([true, false]);
    await recheck.visit(URL, () => pages.visit(), (unavailable) => unavailable);
    expect(raised).toEqual([]);
    expect(notices.map(({ kind }) => kind)).toEqual(['SITE_UNAVAILABLE_RECHECK']);
  });
});

describe('DEF-136: the run status of a job stopped by the site unavailability', () => {
  it('is PARTIAL for the discovery, and an error page counts as failed work', () => {
    expect(discoveryRunStatusOf({
      endReason: 'SITE_UNAVAILABLE', omittedUnreadPages: 0,
      pages: [{ url: 'http://127.0.0.1:4173/admin', state: 'NOT_READ', reason: 'SITE_UNAVAILABLE' }],
    })).toBe('PARTIAL');
    expect(discoveryRunStatusOf({
      endReason: 'COMPLETED', omittedUnreadPages: 0,
      pages: [{ url: 'http://127.0.0.1:4173/admin', state: 'NOT_READ', reason: 'HTTP_ERROR_STATUS' }],
    })).toBe('PARTIAL');
  });

  it('is PARTIAL for the READ checks', () => {
    expect(readEvidenceRunStatusOf({
      endReason: 'SITE_UNAVAILABLE',
      checks: [{ readCheckId: 'read-1', readCheckRevision: 1, targetKind: 'CANDIDATE', targetIdentityDigest: `sha256:${'a'.repeat(64)}`, state: 'NOT_EXECUTED', reason: 'SITE_UNAVAILABLE' }],
    } as Parameters<typeof readEvidenceRunStatusOf>[0])).toBe('PARTIAL');
  });
});
