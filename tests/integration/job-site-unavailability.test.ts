// DEF-136（発見と READ の確かめのジョブの、サイトの不調とエラーの画面の扱い。設計書 `2026-10-18-beaksight-job-site-unavailability-design.md` の
// 5 章の受け入れ条件 1〜4）: 発見のジョブ（`executeDiscoveryRun`）と READ の確かめのジョブ（`executeReadCheckRun`）を、同じ process の中で、本物の
// Chromium と 127.0.0.1 の fixture（`discovery-site-fixture.ts` の `setPageFault`）で確かめる結合テスト。
// - 読み込みごとに、読み取りの監査と同じ不調の判定（`siteUnavailabilityOf`）をかける。不調なら、その画面の結果を捨て、待ってから（テストは注入した短い
//   待ち。本番は読み取りの監査の最初の待ち）同じ画面を 1 回だけ確かめ直す。まだ不調ならジョブを止め（`SITE_UNAVAILABLE`）、次の画面は読み込まない
//   （サーバの記録で数え、名前つきの時間だけ待って数え直す）。通ったら続け、読み込みの間隔を 2 倍にする（知らせで確かめる）。
// - 503（毎回と 1 回だけ）、接続を切る、応答しない、の 4 つの形。
// - 発見のジョブは、500・404 の画面から候補もリンクも拾わず（`HTTP_ERROR_STATUS`）、次の画面へ進む。
// - Guard の変更ではないので、テストの既定の Chromium で確かめる。止めた後の読み込みが 0 回であることだけは、CLI の Chromium でも確かめる。
// - DEF-166: 止めた回は、BeakSight の読み込み（Context の文書の要求）の数を、どちらの Chromium でも確かめる。CLI の Chromium は、接続を切った画面の要求を
//   ネットワークの層が自分で送り直すので、その画面のサーバの記録だけは、BeakSight の読み込みの 2 倍までを認める（`expectLoadsAndArrivals`）。
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, BrowserContextOptions } from 'playwright';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import type { AuditConfig } from '../../src/config/types.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import type { WorkerStartReadCheck } from '../../src/control/worker-protocol.js';
import { DISCOVERY_ARTIFACT_FILE_NAME, READ_EVIDENCE_ARTIFACT_FILE_NAME, artifactFilePath } from '../../src/core/artifact-layout.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import type { DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import type { ReadEvidenceDocument } from '../../src/discovery/read-check-evaluation.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { executeDiscoveryRun } from '../../src/worker/discovery-run.js';
// DEF-141: ジョブの知らせは、承認したサービスへの要求の待ちの知らせも含む（`JobRunNotice`）。この fixture には監査の段の口がないので、出るのは不調の知らせだけ。
import type { JobRunNotice as JobSiteNotice } from '../../src/worker/job-site-availability.js';
import { executeReadCheckRun } from '../../src/worker/read-check-run.js';
import { overrideBrowser } from '../helpers/browser-proxies.js';
import { isCliChromiumSelected, launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import {
  DISCOVERY_SITE_FAULT_LINK,
  DISCOVERY_SITE_LOCAL_STORAGE_ITEM,
  DISCOVERY_SITE_PATHS,
  DISCOVERY_SITE_SESSION_COOKIE,
  startDiscoverySite,
  type DiscoverySite,
  type DiscoverySitePageFault,
} from '../helpers/discovery-site-fixture.js';
import { createTestConfig } from '../helpers/test-config.js';

const TEST_TIMEOUT_MS = 120_000;
/** 読み込みの最小の間隔（ms。ループバックの fixture なので短くする）。 */
const NAVIGATION_INTERVAL_MS = 300;
/** 読み込みの時間切れ（ms。応答しない画面を短く確かめる）。 */
const NAVIGATION_TIMEOUT_MS = 3_000;
/** 確かめ直しの前の待ち（ms。テストの注入。本番は読み取りの監査の最初の待ち）。 */
const RECHECK_DELAY_MS = 500;
/** 止めた後に、遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 1_500;
const ENOUGH_PAGES = 30;
const P = DISCOVERY_SITE_PATHS;

const STATUS_503: DiscoverySitePageFault = { kind: 'STATUS', status: 503 };
const STATUS_503_ONCE: DiscoverySitePageFault = { kind: 'STATUS', status: 503, times: 1 };

// 4 つ目は、その回の Chromium が CLI の起動の設定か（DEF-166。テストの既定の Chromium は、`BEAKSIGHT_TEST_DEFAULT_CHROMIUM=cli` のとき CLI の設定）。
describe.each([
  ['the default test Chromium', () => launchHeadlessChromium(), true, isCliChromiumSelected()],
  ['the CLI Chromium', () => launchCliChromium(), false, true],
] as const)('DEF-136: the site unavailability of the discovery and READ check jobs (%s)', (_label, launch, everyCase, cliChromium) => {
  let site: DiscoverySite;
  let outputDirectory: string;

  beforeEach(async () => {
    loads.length = 0;
    outputDirectory = await mkdtemp(join(tmpdir(), 'beaksight-job-site-unavailable-'));
    site = await startDiscoverySite();
  });

  afterEach(async () => {
    await site?.close();
    await rm(outputDirectory, { recursive: true, force: true });
  });

  const configFor = (): AuditConfig => createTestConfig(site.origin, P.admin, {
    crawl: { maxPages: ENOUGH_PAGES, minNavigationIntervalMs: NAVIGATION_INTERVAL_MS, navigationTimeoutMs: NAVIGATION_TIMEOUT_MS },
    audit: { screenshots: false },
    output: { directory: outputDirectory },
  });

  const authenticationFor = (): RunAuthentication => ({
    initialState: {
      cookies: [{
        name: DISCOVERY_SITE_SESSION_COOKIE, value: site.issueSession(), domain: new URL(site.origin).hostname, path: '/', expires: -1, httpOnly: true,
        secure: false, sameSite: 'Lax',
      }],
      origins: [{ origin: site.origin, localStorage: [{ name: DISCOVERY_SITE_LOCAL_STORAGE_ITEM, value: 'seed' }] }],
    },
    approvedTestOrigins: [site.origin],
    auditExclusions: { excludedPathPrefixes: [P.logout], auditPathPrefixes: [P.admin], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
    sessionLostPathPrefix: P.login,
    filterState: filterAuthenticatedState,
  });

  /** サーバに届いた管理画面の HTML の要求（path だけ。届いた順）。 */
  const adminDocuments = (): readonly string[] => site.requests.filter((request) => request.adminDocument).map(({ path }) => path.split('?')[0] ?? path);

  /**
   * DEF-166: BeakSight 自身が読み込んだ管理画面の文書の要求（Context の `request` の文書。path だけ。出した順）。Chromium のネットワークの層が自分で
   * 送り直した要求は、Playwright の新しい要求にならないので、ここには出ない（BeakSight の読み込みの数を、ブラウザの別によらず数える）。
   */
  const loads: string[] = [];
  const observedLaunch = async (): Promise<Browser> => {
    const real = await launch();
    return overrideBrowser(real, {
      newContext: async (options?: BrowserContextOptions): Promise<BrowserContext> => {
        const context = await real.newContext(options);
        context.on('request', (request) => {
          const url = new URL(request.url());
          if (request.resourceType() === 'document' && url.origin === site.origin && (url.pathname === P.admin || url.pathname.startsWith(`${P.admin}/`))) {
            loads.push(url.pathname);
          }
        });
        return context;
      },
    });
  };

  /**
   * DEF-166: 不調の画面で止めた回の、読み込みと届いた要求の確かめ。BeakSight の読み込み（`loads`）は、どちらの Chromium でも `expected`（確かめ直しは
   * 1 回だけ。上限の内）。サーバに届いた要求も、ふつうは同じ。ただし CLI の Chromium は、応答なしで切られた要求（`REFUSE`）を、ネットワークの層が
   * 自分で送り直す（2026-10-24 DF-2 の観察: 各回、約 10ms 後に同じ要求がもう 1 つ届き、Playwright の要求は 1 つのまま）ので、切られた画面 `refused` だけは、
   * BeakSight の読み込みの 2 倍まで届きうる。ほかの画面の要求は同じ数で、止めた後の画面は 0 回のまま。
   */
  const expectLoadsAndArrivals = (expected: readonly string[], refused: string | undefined): void => {
    expect(loads).toEqual(expected);
    const arrivals = adminDocuments();
    if (!cliChromium || refused === undefined) {
      expect(arrivals).toEqual(expected);
      return;
    }
    expect(arrivals.filter((path) => path !== refused)).toEqual(expected.filter((path) => path !== refused));
    const refusedLoads = expected.filter((path) => path === refused).length;
    const refusedArrivals = arrivals.filter((path) => path === refused).length;
    expect(refusedArrivals).toBeGreaterThanOrEqual(refusedLoads);
    expect(refusedArrivals).toBeLessThanOrEqual(refusedLoads * 2);
  };

  const discover = async (): Promise<{ readonly document: DiscoveryDocument; readonly notices: readonly JobSiteNotice[] }> => {
    const notices: JobSiteNotice[] = [];
    const outcome = await executeDiscoveryRun({
      config: configFor(), jobId: 'job-def136-discovery', authentication: authenticationFor(), launchBrowser: observedLaunch, clock: () => new Date(),
      now: () => Date.now(), stopSignal: new AbortController().signal, siteUnavailableRecheckDelayMs: RECHECK_DELAY_MS,
    }, { onRunStarted: () => undefined, onSessionLost: () => undefined, onNotice: (notice) => notices.push(notice) });
    if (outcome.kind !== 'RAN') throw new Error(`the discovery did not run: ${outcome.kind}`);
    await wait(LATE_REQUEST_WAIT_MS);
    const document = JSON.parse(readFileSync(artifactFilePath(outcome.runDirectory, DISCOVERY_ARTIFACT_FILE_NAME), 'utf8')) as DiscoveryDocument;
    expect((await validateArtifact('discovery', document)).ok).toBe(true);
    expect(outcome.runStatus).toBe(document.runStatus);
    return { document, notices };
  };

  const stateOf = (document: DiscoveryDocument, path: string): string | undefined => {
    const page = document.pages.find((entry) => new URL(entry.url).pathname === path);
    return page === undefined ? undefined : page.state === 'READ' ? 'READ' : `NOT_READ/${page.reason}`;
  };

  // 受け入れ条件 1・2: 2 つ目の画面（一覧）が不調のままなら、確かめ直しを 1 回だけ行って止め、3 つ目の画面は読み込まない。
  it.each<[string, DiscoverySitePageFault]>([
    ['503', STATUS_503],
    ...(everyCase ? [['a refused connection', { kind: 'REFUSE' }], ['no response', { kind: 'HANG' }]] as [string, DiscoverySitePageFault][] : []),
  ])('stops the discovery when the second page stays unavailable (%s), after one recheck, and reads no third page', async (_name, fault) => {
    site.setPageFault(P.list, fault);
    const { document, notices } = await discover();
    expect(document).toMatchObject({ endReason: 'SITE_UNAVAILABLE', runStatus: 'PARTIAL' });
    expect(stateOf(document, P.admin)).toBe('READ');
    expect(stateOf(document, P.list)).toBe('NOT_READ/SITE_UNAVAILABLE');
    expect(stateOf(document, P.search)).toBe('NOT_READ/SITE_UNAVAILABLE');
    expectLoadsAndArrivals([P.admin, P.list, P.list], fault.kind === 'REFUSE' ? P.list : undefined);
    expect(notices).toEqual([{ kind: 'SITE_UNAVAILABLE_RECHECK', url: `${site.origin}${P.list}`, delayMs: RECHECK_DELAY_MS, attempt: 1, maxAttempts: 1 }]);
  }, TEST_TIMEOUT_MS);

  if (!everyCase) {
    return;
  }

  // 受け入れ条件 1: 確かめ直しで戻れば続け、読み込みの間隔を 2 倍にする。
  it('continues the discovery when the recheck passes, and doubles the navigation interval', async () => {
    site.setPageFault(P.list, STATUS_503_ONCE);
    const { document, notices } = await discover();
    expect(document).toMatchObject({ endReason: 'COMPLETED' });
    expect(stateOf(document, P.list)).toBe('READ');
    expect(stateOf(document, P.detail)).toBe('READ');
    expect(adminDocuments().filter((path) => path === P.list)).toHaveLength(2);
    expect(notices).toEqual([
      { kind: 'SITE_UNAVAILABLE_RECHECK', url: `${site.origin}${P.list}`, delayMs: RECHECK_DELAY_MS, attempt: 1, maxAttempts: 1 },
      { kind: 'SITE_UNAVAILABLE_SLOWDOWN', minIntervalMs: NAVIGATION_INTERVAL_MS * 2 },
    ]);
  }, TEST_TIMEOUT_MS);

  // 受け入れ条件 3: 500・404 の画面から、候補とリンクを拾わず、次の画面へ進む。
  it('picks neither candidates nor links from a 500 or 404 page (HTTP_ERROR_STATUS) and goes on', async () => {
    site.setPageFault(P.list, { kind: 'STATUS', status: 500 });
    site.setPageFault(P.search, { kind: 'STATUS', status: 404 });
    const { document, notices } = await discover();
    expect(document.endReason).toBe('COMPLETED');
    expect(stateOf(document, P.list)).toBe('NOT_READ/HTTP_ERROR_STATUS');
    expect(stateOf(document, P.search)).toBe('NOT_READ/HTTP_ERROR_STATUS');
    expect(stateOf(document, DISCOVERY_SITE_FAULT_LINK)).toBeUndefined();
    // 一覧からだけリンクされる詳細の画面は、見つけていない。
    expect(stateOf(document, P.detail)).toBeUndefined();
    expect(stateOf(document, P.create)).toBe('READ');
    expect(adminDocuments().filter((path) => path === P.list || path === P.search)).toEqual([P.list, P.search]);
    expect(notices).toEqual([]);
    expect(document.runStatus).toBe('PARTIAL');
  }, TEST_TIMEOUT_MS);

  // 受け入れ条件 4: READ の確かめのジョブでも同じ（画面の path の定義。2 つ目の定義の画面が不調）。
  const pageCheck = (readCheckId: string, path: string): WorkerStartReadCheck => ({
    readCheckId, readCheckRevision: 1, targetPage: { origin: site.origin, path },
    definition: { targetPagePath: path, parameters: {}, expectations: [{ kind: 'TEXT_CONTAINS', text: 'x' }] },
  });
  const readChecks = (): readonly WorkerStartReadCheck[] => [pageCheck('read-list', P.list), pageCheck('read-search', P.search), pageCheck('read-create', P.create)];

  const checkReads = async (): Promise<{ readonly document: ReadEvidenceDocument; readonly notices: readonly JobSiteNotice[] }> => {
    const notices: JobSiteNotice[] = [];
    const outcome = await executeReadCheckRun({
      config: configFor(), jobId: 'job-def136-read', authentication: authenticationFor(), readChecks: readChecks(), launchBrowser: observedLaunch,
      clock: () => new Date(), now: () => Date.now(), stopSignal: new AbortController().signal, siteUnavailableRecheckDelayMs: RECHECK_DELAY_MS,
    }, { onRunStarted: () => undefined, onSessionLost: () => undefined, onNotice: (notice) => notices.push(notice) });
    if (outcome.kind !== 'RAN') throw new Error(`the READ check did not run: ${outcome.kind}`);
    await wait(LATE_REQUEST_WAIT_MS);
    const document = JSON.parse(readFileSync(artifactFilePath(outcome.runDirectory, READ_EVIDENCE_ARTIFACT_FILE_NAME), 'utf8')) as ReadEvidenceDocument;
    expect((await validateArtifact('read-evidence', document)).ok).toBe(true);
    return { document, notices };
  };
  const outcomesOf = (document: ReadEvidenceDocument): readonly string[] =>
    document.checks.map((check) => (check.state === 'EXECUTED' ? `${check.readCheckId}:EXECUTED` : `${check.readCheckId}:${check.reason}`));

  it.each<[string, DiscoverySitePageFault]>([
    ['503', STATUS_503],
    ['a refused connection', { kind: 'REFUSE' }],
    ['no response', { kind: 'HANG' }],
  ])('stops the READ checks when a page stays unavailable (%s), after one recheck, and loads no later page', async (_name, fault) => {
    site.setPageFault(P.search, fault);
    const { document, notices } = await checkReads();
    expect(document).toMatchObject({ endReason: 'SITE_UNAVAILABLE', runStatus: 'PARTIAL' });
    expect(outcomesOf(document)).toEqual(['read-list:EXECUTED', 'read-search:SITE_UNAVAILABLE', 'read-create:SITE_UNAVAILABLE']);
    expectLoadsAndArrivals([P.list, P.search, P.search], fault.kind === 'REFUSE' ? P.search : undefined);
    expect(notices).toEqual([{ kind: 'SITE_UNAVAILABLE_RECHECK', url: `${site.origin}${P.search}`, delayMs: RECHECK_DELAY_MS, attempt: 1, maxAttempts: 1 }]);
  }, TEST_TIMEOUT_MS);

  it('continues the READ checks when the recheck passes', async () => {
    site.setPageFault(P.search, STATUS_503_ONCE);
    const { document, notices } = await checkReads();
    expect(document.endReason).toBe('COMPLETED');
    expect(outcomesOf(document)).toEqual(['read-list:EXECUTED', 'read-search:EXECUTED', 'read-create:EXECUTED']);
    expect(adminDocuments()).toEqual([P.list, P.search, P.search, P.create]);
    expect(notices.map(({ kind }) => kind)).toEqual(['SITE_UNAVAILABLE_RECHECK', 'SITE_UNAVAILABLE_SLOWDOWN']);
  }, TEST_TIMEOUT_MS);
});
