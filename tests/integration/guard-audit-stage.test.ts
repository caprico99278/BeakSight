// T35b（Task 35 の設計書 3.2、3.3、3.4、4 章、5 章の 1〜3）: 監査の段の Guard（スクリプトで送るログインの監査）。
// 通す部品（どれも本物。Chromium はテストの既定の headless と、CLI の起動の設定の両方）: 認証つきの `BrowserContextFactory`（認証の指定の監査の段の口
// `auditStage`、要求の上限の部品 `serviceRequestBudget`、監査の段の記録 `auditStageMonitor`）と、その Guard と中継。サイトは fixture
// （`startSpaAuthSite`。アプリの Origin を許可 Origin、token と API のバックエンドの Origin を承認したサービスの Origin にする。状態は、発行した
// token をアプリの Origin のローカル ストレージに入れたもの）。
// - 登録した読み取りの手続きの呼び出しだけを、読み込み（Context）ごとの回数の中で通す。token の更新・サーバの関数・計測の送信・WebSocket は止める。
// - 読む範囲を `/admin` に絞っても、範囲の外の静的な資源（`/app.js`）は読める。範囲の外の fetch は止める。
// - 承認したサービスの Origin への要求は、上限の部品で数え、1 回の Run あたりの上限を超えた要求は `SERVICE_REQUEST_LIMIT_REACHED` で止める。
//   DEF-141・DEF-156: 1 分あたりの上限では断らず（届く）、次の読み込みの前に待つ時間を返す。
// 届いたかは fixture の記録で数える。各場面の終わりに、名前つきの時間（`LATE_REQUEST_WAIT_MS`）だけ待ってから数え直す。値は出力しない。
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import type { AuditConfig } from '../../src/config/types.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import { BrowserContextFactory, type AuditStageServiceRequests } from '../../src/browser/context-factory.js';
import { LOAD_PEAK_WINDOW_MS } from '../../src/crawl/load-meter.js';
import { createServiceRequestBudget, type ServiceRequestBudget } from '../../src/crawl/service-request-budget.js';
import { AuditStageMonitor } from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { closeTestContexts, launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { fastRunConfig } from '../helpers/run-harness.js';
import {
  SPA_APP_PATHS,
  SPA_AUTH_STORAGE_KEY,
  SPA_BACKEND_PATHS,
  SPA_GRANT_TYPES,
  SPA_STATE_ELEMENTS,
  startSpaAuthSite,
  type SpaAuthSite,
  type SpaAuthSiteOptions,
  type SpaAuthSiteRequest,
} from '../helpers/spa-auth-site-fixture.js';
import { TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

const LAUNCHERS: readonly (readonly [string, () => Promise<Browser>])[] = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI Chromium', () => launchCliChromium()],
];
const TEST_TIMEOUT_MS = 120_000;
const UI_TIMEOUT_MS = 15_000;
/** 各場面の終わりに、遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 1_000;
/** 監査の段の token の更新までの時間（ms）。 */
const SHORT_REFRESH_MS = 100;
/** 承認したサービスの Origin への要求の上限（設定の上限の値と、小さな上限）。 */
const DEFAULT_LIMITS = Object.freeze({ perMinute: 120, perRun: 600 });
const SMALL_PER_MINUTE = 2;
const SMALL_PER_RUN = 2;
/** 小さな上限の場面で、ページの JS が足して送る読み取りの数。 */
const EXTRA_READS = 3;
const ONE_PER_LOAD = 1;
const EXISTING_NAME = '既存花子';

/** バックエンドに届いた本番の（事前確認でない）要求（`<method> <path>`）。 */
const backendRequests = (site: SpaAuthSite, filter: (request: SpaAuthSiteRequest) => boolean = () => true): readonly string[] => site.requests
  .filter((request) => request.origin !== 'app' && !request.preflight && filter(request))
  .map(({ method, path }) => `${method} ${path}`);
const backendNonReads = (site: SpaAuthSite): readonly string[] =>
  backendRequests(site, (request) => request.method !== 'GET' && request.method !== 'HEAD');

describe.each(LAUNCHERS)('T35b: the audit stage Guard of the script login audit with %s', (_label, launch) => {
  let browser: Browser;
  let spa: SpaAuthSite | undefined;
  const factories: BrowserContextFactory[] = [];

  beforeAll(async () => {
    browser = await launch();
  });

  afterEach(async () => {
    await Promise.all(factories.splice(0).map((factory) => factory.close()));
    await closeTestContexts(browser);
    await spa?.close();
    spa = undefined;
  });

  afterAll(async () => {
    await browser?.close();
  });

  const startSite = async (options: SpaAuthSiteOptions = {}): Promise<SpaAuthSite> => {
    spa = await startSpaAuthSite(options);
    spa.addMember(EXISTING_NAME);
    return spa;
  };

  /** 監査の段の口（登録した読み取りの手続きの呼び出しは、バックエンドの path と読み込みあたりの上限）。 */
  const auditStageOf = (site: SpaAuthSite, reads: readonly string[] = [], maxPerPageLoad = ONE_PER_LOAD): AuditStageServiceRequests => ({
    approvedServiceOrigins: [site.backendOrigin],
    auditReadRequests: reads.map((path) => ({ origin: site.backendOrigin, path, method: 'POST', maxPerPageLoad })),
    scriptLogin: { origin: site.tokenOrigin, path: SPA_BACKEND_PATHS.token, requiredQuery: [{ name: 'grant_type', value: SPA_GRANT_TYPES.password }] },
    serviceRequestLimits: DEFAULT_LIMITS,
  });

  /** 認証つきの factory で、管理画面を開く（`role` の読み込み）。 */
  const openAdmin = async (
    site: SpaAuthSite,
    options: {
      readonly auditStage?: AuditStageServiceRequests;
      readonly auditPathPrefixes?: readonly string[];
      readonly budget?: ServiceRequestBudget;
      readonly role?: 'PRIMARY' | 'REVISIT';
    } = {},
  ) => {
    const base = fastRunConfig(site.appOrigin, SPA_APP_PATHS.admin);
    const config: AuditConfig = { ...base, site: { startUrl: `${site.appOrigin}${SPA_APP_PATHS.admin}`, allowedOrigins: [site.appOrigin] } };
    const monitor = new AuditStageMonitor();
    const budget = options.budget ?? createServiceRequestBudget({ ...DEFAULT_LIMITS, now: () => Date.now() });
    const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), {
      ...TEST_FACTORY_OPTIONS,
      authentication: {
        initialState: { cookies: [], origins: [{ origin: site.appOrigin, localStorage: [{ name: SPA_AUTH_STORAGE_KEY, value: site.issueStoredSession() }] }] },
        filterState: (state) => filterAuthenticatedState(state, [site.appOrigin]),
        auditExclusions: {
          excludedPathPrefixes: [SPA_APP_PATHS.logout],
          auditPathPrefixes: options.auditPathPrefixes ?? [],
          dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS,
        },
        auditStage: options.auditStage ?? auditStageOf(site),
      },
      serviceRequestBudget: budget,
      auditStageMonitor: monitor,
    });
    factories.push(factory);
    const context: BrowserContext = await factory.createPassiveContext(config.viewports.primaryDesktop, options.role ?? 'PRIMARY');
    const page: Page = await factory.createPassivePage(context);
    await page.goto(`${site.appOrigin}${SPA_APP_PATHS.admin}`);
    const ledger = () => factory.getSafetyLedger(context).snapshot();
    const blocked = (): readonly string[] => ledger().blockedRequests.map(({ method, url, reason }) => `${method} ${url} ${reason}`);
    return { page, monitor, budget, ledger, blocked };
  };

  const waitForMembers = async (page: Page, state: 'loaded' | 'error'): Promise<void> => {
    await page.locator(`#${SPA_STATE_ELEMENTS.members}[data-state="${state}"]`).waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
  };
  /** ページの main world の JS で、API の鍵と Bearer つきの要求を送り、応答の状態を返す（届かなければ 0）。 */
  const sendFromPage = (page: Page, url: string, method: string): Promise<number> => page.evaluate(async ({ target, verb, key }) => {
    const stored = JSON.parse(localStorage.getItem(key) ?? '{}') as { access_token?: string };
    try {
      const response = await fetch(target, {
        method: verb,
        headers: { authorization: `Bearer ${stored.access_token ?? ''}`, 'content-type': 'application/json' },
        ...(verb === 'GET' ? {} : { body: '{}' }),
      });
      return response.status;
    } catch {
      return 0;
    }
  }, { target: url, verb: method, key: SPA_AUTH_STORAGE_KEY });

  it('reads the list by the registered RPC within the limit per load, and blocks the second call of the same load', async () => {
    const site = await startSite({ rpcReads: true });
    const { page, monitor, blocked } = await openAdmin(site, { auditStage: auditStageOf(site, [SPA_BACKEND_PATHS.rpcListMembers]) });
    await waitForMembers(page, 'loaded');
    expect(await page.locator(`#${SPA_STATE_ELEMENTS.members}`).textContent()).toContain(EXISTING_NAME);
    expect(await sendFromPage(page, `${site.backendOrigin}${SPA_BACKEND_PATHS.rpcListMembers}`, 'POST')).toBe(0);
    await wait(LATE_REQUEST_WAIT_MS);
    expect(backendNonReads(site)).toEqual([`POST ${SPA_BACKEND_PATHS.rpcListMembers}`]);
    expect(blocked()).toEqual([`POST ${site.backendOrigin}${SPA_BACKEND_PATHS.rpcListMembers} NON_READ_METHOD`]);
    expect(monitor.snapshot()).toMatchObject({
      registeredReadRequestsAllowed: 1,
      tokenRefreshBlocked: 0,
      otherNonReadBlocked: 1,
      blockedByReason: { READ_REQUEST_OVER_LIMIT: 1 },
    });
  }, TEST_TIMEOUT_MS);

  it('blocks the unregistered RPC read and records it; the list is not read', async () => {
    const site = await startSite({ rpcReads: true });
    const { page, monitor, blocked } = await openAdmin(site);
    await waitForMembers(page, 'error');
    await wait(LATE_REQUEST_WAIT_MS);
    expect(backendNonReads(site)).toEqual([]);
    expect(blocked()).toEqual([`POST ${site.backendOrigin}${SPA_BACKEND_PATHS.rpcListMembers} NON_READ_METHOD`]);
    expect(monitor.snapshot()).toMatchObject({ registeredReadRequestsAllowed: 0, blockedByReason: { UNREGISTERED_NON_READ: 1 } });
  }, TEST_TIMEOUT_MS);

  it('passes the registered tenant RPC (required) of /admin and reads the list', async () => {
    const site = await startSite({ preLoginRpc: 'required' });
    const { page, blocked } = await openAdmin(site, { auditStage: auditStageOf(site, [SPA_BACKEND_PATHS.rpcResolveTenant]) });
    await waitForMembers(page, 'loaded');
    await wait(LATE_REQUEST_WAIT_MS);
    expect(backendNonReads(site)).toEqual([`POST ${SPA_BACKEND_PATHS.rpcResolveTenant}`]);
    expect(blocked()).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('blocks the token refresh, the server function, the measurement beacon and the WebSocket, and counts the token refresh', async () => {
    const site = await startSite({ refreshAfterMs: SHORT_REFRESH_MS, rumBeacon: true, websocket: true });
    const { page, monitor, ledger, blocked } = await openAdmin(site);
    await waitForMembers(page, 'loaded');
    await page.locator(`#${SPA_STATE_ELEMENTS.refresh}[data-state="error"]`).waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
    expect(await sendFromPage(page, `${site.backendOrigin}${SPA_BACKEND_PATHS.functionSyncAccess}`, 'POST')).toBe(0);
    await wait(LATE_REQUEST_WAIT_MS);
    expect(backendNonReads(site)).toEqual([]);
    expect(site.refreshes).toBe(0);
    expect(site.rumBeacons).toBe(0);
    expect(backendRequests(site, ({ method }) => method === 'UPGRADE')).toEqual([]);
    expect([...blocked()].sort()).toEqual([
      `POST ${site.appOrigin}${SPA_APP_PATHS.rum} NON_READ_METHOD`,
      `POST ${site.backendOrigin}${SPA_BACKEND_PATHS.functionSyncAccess} NON_READ_METHOD`,
      `POST ${site.tokenOrigin}${SPA_BACKEND_PATHS.token}?grant_type=${SPA_GRANT_TYPES.refresh} NON_READ_METHOD`,
    ].sort());
    expect(ledger().blockedWebSockets.length).toBeGreaterThan(0);
    expect(monitor.snapshot()).toMatchObject({ tokenRefreshBlocked: 1, otherNonReadBlocked: 2 });
  }, TEST_TIMEOUT_MS);

  // BN-0（設計書 `2026-10-23-beaksight-bundle-beaksight-block-noise-design.md` 3.0）: 監査の段の Passive の Context では、ページが出す文書でない GET（fetch を
  // 含む）には読む範囲を当てない（読む）。読む範囲の外の文書の読み込み（iframe）は、今どおり止める。
  it('reads the static app script and a fetch outside the read range /admin, and blocks a child frame document outside the range', async () => {
    const site = await startSite();
    const { page, ledger } = await openAdmin(site, { auditPathPrefixes: [SPA_APP_PATHS.admin] });
    await waitForMembers(page, 'loaded');
    expect(await sendFromPage(page, `${site.appOrigin}/outside-range`, 'GET')).not.toBe(0);
    await page.evaluate((src) => {
      const frame = document.createElement('iframe');
      frame.src = src;
      document.body.append(frame);
    }, `${site.appOrigin}/outside-range-frame`);
    await expect.poll(() => (ledger().blockedAuditExclusions?.events ?? []).map(({ method, url }) => `${method} ${url}`))
      .toContain(`GET ${site.appOrigin}/outside-range-frame`);
    await wait(LATE_REQUEST_WAIT_MS);
    expect(site.requests.filter((request) => request.origin === 'app' && request.path === SPA_APP_PATHS.script)).toHaveLength(1);
    expect(site.requests.filter((request) => request.origin === 'app' && request.path === '/outside-range')).toHaveLength(1);
    expect(site.requests.filter((request) => request.origin === 'app' && request.path === '/outside-range-frame')).toEqual([]);
    expect((ledger().blockedAuditExclusions?.events ?? []).map(({ method, url }) => `${method} ${url}`)).not.toContain(`GET ${site.appOrigin}/outside-range`);
  }, TEST_TIMEOUT_MS);

  /** 管理画面の読み込み（バックエンドへの読み取り 1 件）の後に、ページの JS で `EXTRA_READS` 件の読み取りを足して送り、応答の状態を返す。 */
  const sendExtraReads = async (site: SpaAuthSite, page: Page): Promise<readonly number[]> => {
    const statuses: number[] = [];
    for (let index = 0; index < EXTRA_READS; index += 1) {
      statuses.push(await sendFromPage(page, `${site.backendOrigin}${SPA_BACKEND_PATHS.members}?select=*&n=${index}`, 'GET'));
    }
    // 全部の後に、もう一度待って数え直す。
    await wait(LATE_REQUEST_WAIT_MS);
    await wait(LATE_REQUEST_WAIT_MS);
    return statuses;
  };

  // DEF-156: 今の決まり（DEF-141）では、止めるのは 1 回の Run あたりの上限だけ。上限を超えた要求がバックエンドに届かないことを、サーバの記録で確かめる。
  it('blocks the requests to the service origin over a small limit per Run; no more than the limit reach the backend', async () => {
    const site = await startSite();
    const budget = createServiceRequestBudget({ perMinute: DEFAULT_LIMITS.perMinute, perRun: SMALL_PER_RUN, now: () => Date.now() });
    const { page, blocked } = await openAdmin(site, { budget });
    await waitForMembers(page, 'loaded');
    const statuses = await sendExtraReads(site, page);
    expect(backendRequests(site)).toHaveLength(SMALL_PER_RUN);
    expect(statuses.filter((status) => status === 0)).toHaveLength(EXTRA_READS + 1 - SMALL_PER_RUN);
    expect(budget.isLimitReached()).toBe(true);
    expect(budget.snapshot()).toMatchObject({ admitted: SMALL_PER_RUN, refused: EXTRA_READS + 1 - SMALL_PER_RUN, limitReached: true });
    expect(blocked().filter((entry) => entry.endsWith('SERVICE_REQUEST_LIMIT_REACHED'))).toHaveLength(EXTRA_READS + 1 - SMALL_PER_RUN);
  }, TEST_TIMEOUT_MS);

  // DEF-156: 1 分あたりの上限では、読み込みの途中の要求を断らない（届く。止めた記録もない）。代わりに、次の読み込みの前に待つ時間を返す（DEF-141）。
  it('does not refuse the requests over a small limit per minute; they reach the backend, and the next load waits', async () => {
    const site = await startSite();
    const budget = createServiceRequestBudget({ perMinute: SMALL_PER_MINUTE, perRun: DEFAULT_LIMITS.perRun, now: () => Date.now() });
    const { page, blocked } = await openAdmin(site, { budget });
    await waitForMembers(page, 'loaded');
    const statuses = await sendExtraReads(site, page);
    expect(backendRequests(site)).toHaveLength(EXTRA_READS + 1);
    expect(statuses.filter((status) => status === 0)).toEqual([]);
    expect(budget.isLimitReached()).toBe(false);
    expect(budget.snapshot()).toMatchObject({ admitted: EXTRA_READS + 1, refused: 0, limitReached: false });
    expect(blocked().filter((entry) => entry.endsWith('SERVICE_REQUEST_LIMIT_REACHED'))).toEqual([]);
    const waitMs = budget.waitBeforeNextLoadMs();
    expect(waitMs).toBeGreaterThan(0);
    expect(waitMs).toBeLessThanOrEqual(LOAD_PEAK_WINDOW_MS);
  }, TEST_TIMEOUT_MS);

  it('does not pass a registered RPC on a revisit load (the stress sweep and the Interaction)', async () => {
    const site = await startSite({ rpcReads: true });
    const { page, monitor } = await openAdmin(site, { auditStage: auditStageOf(site, [SPA_BACKEND_PATHS.rpcListMembers]), role: 'REVISIT' });
    await waitForMembers(page, 'error');
    await wait(LATE_REQUEST_WAIT_MS);
    expect(backendNonReads(site)).toEqual([]);
    expect(monitor.snapshot()).toMatchObject({ registeredReadRequestsAllowed: 0, blockedByReason: { READ_REQUEST_OVER_LIMIT: 1 } });
  }, TEST_TIMEOUT_MS);
});
