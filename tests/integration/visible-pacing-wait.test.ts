// DEF-236（設計書 `doc/design/2026-11-09-beaksight-visible-pacing-wait-design.md` 3.1・7 章）: 監査の読み込みの境目（Desktop → 幅の走査の各幅 → Mobile → 次の
// ページ）で、証拠を集め終えた後に、前の画面を閉じずに見せたまま読み込みの間隔を待つ。本物の監査の流れ（`executeAuditRun`。factory・Guard・Page Auditor）で、
// 2 ページを監査する。
// - 待ちの間に、画面が自然に出す通信の代わりに、テストが画面のスクリプト（`window.__pacingWaitActivity`）を呼ぶ（鍵の更新・読み取り・DELETE・WebSocket）。
// - SD-2（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.4）: 待ちの間の DELETE はサーバに届き、止めた記録にも Finding にもならないこと。
// - `pacingWaitMs` が待った時間を含むこと、待ちの後の `beforeNavigation` が待たないこと、token の受け継ぎで使い回しがないこと、最後のページの後に待たないこと。
// Chromium は入口 `chromiumRunsOf` の組（遅い組は CLI の起動の設定の 1 つ、両方に広げる束でテストの既定の headless も）。
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { executeAuditRun } from '../../src/cli/audit-run.js';
import { wait } from '../../src/core/deadline.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import type { RunSummary } from '../../src/core/contracts.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import { createNavigationPacer, type NavigationPacer } from '../../src/crawl/navigation-pacer.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { hasSuccessStorageKey } from '../../src/worker/login-stage-checks.js';
import { chromiumRunsOf, launchCliChromium, launchHeadlessChromium, testContextsOf } from '../helpers/chromium.js';
import { PACING_WAIT_PATHS, PACING_WAIT_STORAGE_KEY, startPacingWaitSite, type PacingWaitSite } from '../helpers/pacing-wait-site.js';
import { createTestConfig } from '../helpers/test-config.js';

const LAUNCHERS: readonly (readonly [string, () => Promise<Browser>])[] = chromiumRunsOf([
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI Chromium', () => launchCliChromium()],
]);
const PAGES = 2;
/** 読み込みの間隔（ms）。証拠を集め終えた後に、残りを待つ。 */
const INTERVAL_MS = 2_500;
/** 待ちの間の通信の後、止めた DELETE と WebSocket の記録が残るまでの間（テストの包みが待ちの中で待つ）。 */
const ACTIVITY_SETTLE_MS = 400;
/** Run の後に、遅れて届く要求を待つ時間（数え直す）。 */
const LATE_REQUEST_WAIT_MS = 1_500;
const RUN_TIMEOUT_MS = 240_000;

/** テストの包みが記録する、pacer の呼び出し。 */
type PacerCall =
  | { readonly kind: 'before'; readonly waitedMs: number; readonly openAppPages: number }
  | { readonly kind: 'due'; readonly waitedMs: number; readonly openAppPages: number; readonly liveContexts: number; readonly activity: boolean };

/** SPEC-1: 要求の数は成果物に書かないので、ビューポートの状態だけを比べる。 */
interface ViewportFacts {
  readonly status: string;
}

interface PageFacts {
  readonly url: string;
  readonly viewports: Readonly<Record<string, ViewportFacts>>;
  readonly findings: readonly string[];
  readonly blockedDeletes: readonly { readonly phase: string; readonly url: string }[];
  readonly stressWidths: number;
}

interface AuditOutcome {
  readonly run: RunSummary;
  readonly pages: readonly PageFacts[];
  readonly calls: readonly PacerCall[];
}

describe.each(LAUNCHERS)('DEF-236: the audit waits for the next load with the previous page still shown (%s)', (_label, launch) => {
  let site: PacingWaitSite | undefined;
  let workDirectory = '';

  beforeAll(async () => {
    workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-visible-pacing-'));
  });

  afterEach(async () => {
    await site?.close();
    site = undefined;
  });

  afterAll(async () => {
    await rm(workDirectory, { recursive: true, force: true });
  });

  const audit = async (started: PacingWaitSite, intervalMs: number, activity: boolean): Promise<AuditOutcome> => {
    const calls: PacerCall[] = [];
    let browser: Browser | null = null;
    const appPages = (): Page[] => (browser === null ? [] : testContextsOf(browser))
      .flatMap((context) => context.pages())
      .filter((page) => !page.isClosed() && page.url().startsWith(`${started.appOrigin}${PACING_WAIT_PATHS.pagePrefix}`));
    const liveContexts = (): number => (browser === null ? 0 : testContextsOf(browser).filter((context) => context.pages().some((page) => !page.isClosed())).length);
    const inner = createNavigationPacer({ minIntervalMs: intervalMs, now: () => Date.now(), sleep: wait });
    const pacer: NavigationPacer = {
      beforeNavigation: async () => {
        const waitedMs = await inner.beforeNavigation();
        calls.push({ kind: 'before', waitedMs, openAppPages: appPages().length });
        return waitedMs;
      },
      waitUntilNextNavigationDue: async () => {
        const shown = appPages();
        const contexts = liveContexts();
        let ran = false;
        if (activity && shown.length === 1) {
          // 画面が自然に出す通信の代わり（待ちの間だけ）。
          ran = await (shown[0] as Page).evaluate(async () => (window as unknown as { __pacingWaitActivity: () => Promise<boolean> }).__pacingWaitActivity())
            .catch(() => false);
        }
        const waitedMs = await inner.waitUntilNextNavigationDue();
        if (ran) {
          await wait(ACTIVITY_SETTLE_MS);
        }
        calls.push({ kind: 'due', waitedMs, openAppPages: shown.length, liveContexts: contexts, activity: ran });
        return waitedMs;
      },
      snapshot: () => inner.snapshot(),
      raiseMinimumInterval: (ms) => inner.raiseMinimumInterval(ms),
      recordDocumentRequestSent: () => inner.recordDocumentRequestSent(),
    };
    const authentication: RunAuthentication = {
      initialState: {
        cookies: [],
        origins: [{ origin: started.appOrigin, localStorage: [{ name: PACING_WAIT_STORAGE_KEY, value: started.issueStoredSession() }] }],
      },
      approvedTestOrigins: [started.appOrigin],
      auditExclusions: { excludedPathPrefixes: ['/logout'], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
      sessionLostPathPrefix: PACING_WAIT_PATHS.auth,
      filterState: filterAuthenticatedState,
      auditStage: {
        approvedServiceOrigins: [started.svcOrigin],
        auditReadRequests: [],
        scriptLogin: { origin: started.svcOrigin, path: PACING_WAIT_PATHS.token, requiredQuery: [{ name: 'grant_type', value: 'password' }] },      },
      sessionKeyPresent: (state) => hasSuccessStorageKey(state, { origin: started.appOrigin, prefix: 'fixture', suffix: '-auth-token' }),
    };
    const label = `${String(intervalMs)}-${String(Date.now())}`;
    const config = createTestConfig(started.appOrigin, `${PACING_WAIT_PATHS.pagePrefix}1`, {
      target: { id: `def236-${String(intervalMs)}` },
      output: { directory: join(workDirectory, label) },
      crawl: { maxPages: PAGES, minNavigationIntervalMs: intervalMs },
      // SLIM-GROUP: 幅の走査は 1 つ（幅の境目の待ちを 1 回ずつ含める）。
      viewports: { stressWidths: [320] },
      audit: { sendPolicy: 'PASS_EXCEPT_DELETE', screenshots: false, performance: false, interactions: false },
    });
    const outcome = await executeAuditRun(config, {
      launchBrowser: async () => {
        browser = await launch();
        return browser;
      },
      clock: () => new Date(),
      now: () => Date.now(),
      authentication,
      navigationPacer: pacer,
    }, { startNew: true });
    if (outcome.kind !== 'RAN') {
      throw new Error(`the audit did not run: ${outcome.kind}`);
    }
    const run = JSON.parse(readFileSync(join(outcome.runDirectory, 'run.json'), 'utf8')) as RunSummary;
    const pagesDirectory = join(outcome.runDirectory, 'pages');
    const pages = readdirSync(pagesDirectory).sort().map((name): PageFacts => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const page = JSON.parse(readFileSync(join(pagesDirectory, name, 'page.json'), 'utf8')) as Record<string, any>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const evidence = page['evidence'] as Record<string, any>[];
      const viewports = Object.fromEntries(Object.entries(page['viewports'] as Record<string, ViewportFacts>).map(([key, value]) => [key, {
        status: value.status,
      }]));
      return {
        url: String(page['pageUrl']),
        viewports,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        findings: (page['findings'] as Record<string, any>[]).map((finding) => `${String(finding['ruleId'])}@${String(finding['viewport'])}`).sort(),
        blockedDeletes: evidence.filter((record) => record['type'] === 'safety')
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .flatMap((record) => (record['payload']['blockedRequests'] as Record<string, any>[]))
          .filter((event) => event['method'] === 'DELETE')
          .map((event) => ({ phase: String(event['phase']), url: String(event['url']) })),
        stressWidths: evidence.filter((record) => record['type'] === 'layout' && record['viewport'] === 'desktop')
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .reduce((total, record) => total + ((record['payload']['stressSweep'] as unknown[] | null)?.length ?? 0), 0),
      };
    });
    return { run, pages, calls };
  };

  it('shows the previous page during the wait, keeps the counts and findings, and records the DELETE without a finding', async () => {
    site = await startPacingWaitSite({ pages: PAGES, accessLifetimeMs: 120_000 });
    const started = site;
    // 待ちのある Run（待ちの間に、画面の通信を起こす）。SLIM-GROUP（設計書 `2026-11-14-beaksight-slim-and-simplify-design.md` 5.4）: 前は待ちのない Run
    // （間隔 0）も流し、各ビューポートの状態と Finding が同じことを比べた。比べは待ちの制御の確かめで守りではないので外し、待ちのある Run の 1 回にした。
    const paced = await audit(started, INTERVAL_MS, true);
    const serverRequests = started.requestLog.length;
    await wait(LATE_REQUEST_WAIT_MS);
    expect(started.requestLog.length).toBe(serverRequests);

    expect({ endReason: paced.run.executions.at(-1)?.endReason, audited: paced.run.auditedPageCount })
      .toEqual({ endReason: 'COMPLETED', audited: PAGES });
    expect(paced.run.safety.invariantViolationCount).toBe(0);

    // 待ちは、読み込みの境目ごとに 1 回（最後のページの後には待たない）。待ちの間は、前の画面が開いたまま（Context は 1 つ）。
    const auditLoads = paced.pages.reduce((total, page) => total + 2 + page.stressWidths, 0);
    const dues = paced.calls.filter((call): call is Extract<PacerCall, { kind: 'due' }> => call.kind === 'due');
    expect(dues).toHaveLength(auditLoads - 1);
    expect(dues.map((call) => [call.openAppPages, call.liveContexts])).toEqual(dues.map(() => [1, 1]));
    expect(dues.every((call) => call.activity)).toBe(true);
    expect(paced.calls.at(-1)?.kind).toBe('before');
    // 待ちの後の読み込みは、待たない（待ちは前の画面を見せたまま済んでいる）。新しい画面を作る前なので、開いた画面はない。
    paced.calls.forEach((call, index) => {
      if (call.kind === 'due') {
        const next = paced.calls[index + 1];
        expect(next?.kind).toBe('before');
        expect(next?.waitedMs).toBeLessThan(100);
      }
    });
    expect(paced.calls.filter((call) => call.kind === 'before').map((call) => call.openAppPages))
      .toEqual(paced.calls.filter((call) => call.kind === 'before').map(() => 0));
    // pacingWaitMs は、待ちの長さを含む。
    const dueWaitMs = dues.reduce((total, call) => total + call.waitedMs, 0);
    expect(dueWaitMs).toBeGreaterThan(0);
    expect(paced.run.load.pacingWaitMs).toBeGreaterThanOrEqual(dueWaitMs);

    // 待ちの間の通信: 読み取りと鍵の更新は届き、DELETE は届かない。
    const waitRequests = started.requestLog.filter((record) => record.duringWait);
    // 調べるときだけ、数をファイルに書く（環境変数 `DEF236_REPORT` にファイルの path を渡す）。
    const reportPath = process.env['DEF236_REPORT'];
    if (reportPath !== undefined && reportPath.length > 0) {
      const tally = (records: typeof started.requestLog): Record<string, number> => records.reduce<Record<string, number>>((counts, record) => {
        const key = `${record.origin}:${record.method}:${record.kind}:${String(record.status)}`;
        return { ...counts, [key]: (counts[key] ?? 0) + 1 };
      }, {});
      writeFileSync(reportPath, JSON.stringify({
        waits: dues.length, dueWaitMs, pacingWaitMs: paced.run.load.pacingWaitMs, duringWait: tally(waitRequests), all: tally(started.requestLog),
        viewports: paced.pages.map((page) => page.viewports), deletes: paced.pages.flatMap((page) => page.blockedDeletes).length,
      }));
    }
    expect(waitRequests.filter((record) => record.kind === 'items').length).toBeGreaterThan(0);
    // SD-2（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.4）: 待ちの間の画面の DELETE も届く。
    expect(waitRequests.filter((record) => record.method === 'DELETE').length).toBeGreaterThan(0);
    // token の受け継ぎ: 待ちの間に回した鍵を、次の読み込みが受け継ぐ（使い回しがない）。
    expect(started.refreshRecords.filter((record) => record.reason === 'wait').length).toBeGreaterThan(0);
    expect(started.revokedAtMs()).toBeNull();
    expect(started.refreshRecords.filter((record) => record.outcome !== 'ROTATED' || record.tokenIndex !== record.activeIndex)).toEqual([]);

    // 待ちの間の DELETE は止めた記録に残らず、Finding にもならない。
    expect(paced.pages.flatMap((page) => page.blockedDeletes)).toEqual([]);
    expect(paced.pages.flatMap((page) => page.findings).filter((finding) => finding.startsWith('SAFETY_'))).toEqual([]);
  }, RUN_TIMEOUT_MS);
});
