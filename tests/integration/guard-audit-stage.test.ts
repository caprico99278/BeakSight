// 監査の段の Guard の結合の家（SAFE-B2 で、guard-audit-stage-revisit・guard-audit-send-policy・guard-audit-send-review-fixes をまとめた）。
// 通す部品（どれも本物。Chromium は `BOTH_CHROMIUM_LAUNCHERS`）: `BrowserContextFactory` と、その Guard と出口の中継。Chromium は describe ごとに 1 つ。
// 1. T35b（Task 35 の設計書 3.2、3.3、3.4、4 章、5 章の 1〜3）: スクリプトで送るログインの監査の段。サイトは fixture（`startSpaAuthSite`。アプリの Origin を
//    許可 Origin、token と API のバックエンドの Origin を承認したサービスの Origin にする。状態は、発行した token をアプリの Origin のローカル ストレージに入れたもの）。
//    - 登録した読み取りの手続きの呼び出しだけを通す。token の更新・サーバの関数・計測の送信・WebSocket は止める。
//    - 読む範囲を `/admin` に絞っても、範囲の外の静的な資源（`/app.js`）と fetch は読める。範囲の外の文書は止める。
//    - 幅の走査と Interaction（`REVISIT`）の読み込みでは、登録した手続きも通さない。
// 2. T35R-fix（T35R の C-1）: `REVISIT` の Context では、承認したサービスの Origin へ何も届かない（iframe の文書 3 つ、fetch、画像、Worker の fetch）。Run の
//    キャッシュの有無によらない（届け方の部品ではなく、Guard の判定で止める）。上限の部品のない factory は Context を作らない（fail-closed）。
// 3. AS-a（設計書 `doc/design/2026-10-19-beaksight-audit-send-policy-design.md` 2.2・2.3、受け入れ条件 2〜4）と AS-c fix round 1〜3: 監査の段の送信の扱い
//    `PASS_EXCEPT_DELETE`。サイトは 127.0.0.1 の 3 つのサーバ（許可 Origin、承認したサービスの Origin、ほかの Origin）。サーバと factory は describe で共有し、
//    場面ごとに記録を空にする。
//    - 通す: ページが自分で出す読み取りでない要求（fetch・XHR・beacon・ほかの Origin への POST・WebSocket）。形と数だけ記録する（値は記録しない）。
//    - SD-2（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.4）: `DELETE`（method の上書き `_method` を含む）と危険な語も止めない（代表は
//      `tests/contract/pass-through-paths.test.ts`）。凍結の後の Isolated Interaction Context は止める（守り 2）。
//    - 模擬を迂回した WebSocket・Worker の WebSocket は、ブラウザの事実から印つきで記録する（C-1・C-2）。事前確認（I-1）、307 の各段（I-D）、M-3。
// 届いたかはサーバ（fixture）の記録で数える。止めるべき要求は、名前つきの時間（`LATE_REQUEST_WAIT_MS`）だけ待ってから数え直す。値は出力しない。
// 撤廃した上限（L10・L11）の名残の場面は消した（別の所: `tests/unit/service-request-budget.test.ts`・`request-policy-audit-send.test.ts`・
// `audit-send-wider.test.ts`・`audit-send-review-fixes.test.ts`）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Browser, BrowserContext, Frame, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import type { AuditConfig } from '../../src/config/types.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import type { PassedAuditSendWebSocketsRecord } from '../../src/core/evidence-types.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import { BrowserContextFactory, type AuditStageServiceRequests } from '../../src/browser/context-factory.js';
import { ResourceCache, type ResourceDeliveryRole } from '../../src/browser/resource-delivery.js';
import { createServiceRequestBudget } from '../../src/crawl/service-request-budget.js';
import { announceOwnMainFrameNavigation, AuditStageMonitor } from '../../src/safety/passive-request-guard.js';
import { SafetyLedger, type SafetyLedgerSnapshot } from '../../src/safety/safety-ledger.js';
import {
  ARRIVAL_POLL_MS,
  ARRIVAL_TIMEOUT_MS,
  NO_CORS_PATH_PREFIX,
  PAGE_PATH,
  SILENT_PREFLIGHT_PATH_PREFIX,
  beaconFromPage,
  bypassWebSocketMock,
  corsFetchFromPage,
  fetchFromPage,
  nonReads,
  openWebSocketFromPage,
  openWebSocketFromWorker,
  redirectUrlOf,
  sendFromPage,
  startRecordingServer,
  waitForArrivals,
  webSocketOriginOf,
  xhrFromPage,
  type RecordingServer,
} from '../helpers/audit-send-site.js';
import { BOTH_CHROMIUM_LAUNCHERS, closeTestContexts, oopifTargetUrls, SITE_PER_PROCESS_ARGS, testContextsOf } from '../helpers/chromium.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
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

const TEST_TIMEOUT_MS = 120_000;
const UI_TIMEOUT_MS = 15_000;
/** 各場面の終わりに、遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 1_000;
/** 監査の段の token の更新までの時間（ms）。 */
const SHORT_REFRESH_MS = 100;
const ONE_PER_LOAD = 1;
const EXISTING_NAME = '既存花子';

/** バックエンドに届いた本番の（事前確認でない）要求（`<method> <path>`）。 */
const backendRequests = (site: SpaAuthSite, filter: (request: SpaAuthSiteRequest) => boolean = () => true): readonly string[] => site.requests
  .filter((request) => request.origin !== 'app' && !request.preflight && filter(request))
  .map(({ method, path }) => `${method} ${path}`);
const backendNonReads = (site: SpaAuthSite): readonly string[] =>
  backendRequests(site, (request) => request.method !== 'GET' && request.method !== 'HEAD');

describe.each(BOTH_CHROMIUM_LAUNCHERS)('T35b: the audit stage Guard of the script login audit with %s', (_label, launch) => {
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
  });

  /** 認証つきの factory で、管理画面を開く（`role` の読み込み）。 */
  const openAdmin = async (
    site: SpaAuthSite,
    options: {
      readonly auditStage?: AuditStageServiceRequests;
      readonly auditPathPrefixes?: readonly string[];
      readonly role?: 'PRIMARY' | 'REVISIT';
    } = {},
  ) => {
    const base = fastRunConfig(site.appOrigin, SPA_APP_PATHS.admin);
    const config: AuditConfig = { ...base, site: { startUrl: `${site.appOrigin}${SPA_APP_PATHS.admin}`, allowedOrigins: [site.appOrigin] } };
    const monitor = new AuditStageMonitor();
    const budget = createServiceRequestBudget({ now: () => Date.now() });
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
    return { page, monitor, ledger, blocked };
  };

  const waitForMembers = async (page: Page, state: 'loaded' | 'error'): Promise<void> => {
    await page.locator(`#${SPA_STATE_ELEMENTS.members}[data-state="${state}"]`).waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
  };
  /** ページの main world の JS で、API の鍵と Bearer つきの要求を送り、応答の状態を返す（届かなければ 0）。 */
  const bearerSendFromPage = (page: Page, url: string, method: string): Promise<number> => page.evaluate(async ({ target, verb, key }) => {
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

  // L11（設計書 `2026-11-09-beaksight-remove-limits-design.md` 4。設計者の判断 (b)）で直した: 登録した読み取りの手続きの呼び出しは、1 回の読み込みあたりの回数を
  // 数えずに何回でも通す（前は、同じ読み込みの 2 回目を `READ_REQUEST_OVER_LIMIT` で止めた）。
  it('reads the list by the registered RPC, and passes the second call of the same load too (L11)', async () => {
    const site = await startSite({ rpcReads: true });
    const { page, monitor, blocked } = await openAdmin(site, { auditStage: auditStageOf(site, [SPA_BACKEND_PATHS.rpcListMembers]) });
    await waitForMembers(page, 'loaded');
    expect(await page.locator(`#${SPA_STATE_ELEMENTS.members}`).textContent()).toContain(EXISTING_NAME);
    expect(await bearerSendFromPage(page, `${site.backendOrigin}${SPA_BACKEND_PATHS.rpcListMembers}`, 'POST')).not.toBe(0);
    await wait(LATE_REQUEST_WAIT_MS);
    expect(backendNonReads(site)).toEqual([`POST ${SPA_BACKEND_PATHS.rpcListMembers}`, `POST ${SPA_BACKEND_PATHS.rpcListMembers}`]);
    expect(blocked()).toEqual([]);
    expect(monitor.snapshot()).toMatchObject({ registeredReadRequestsAllowed: 2, tokenRefreshBlocked: 0, otherNonReadBlocked: 0 });
    expect(monitor.snapshot().blockedByReason.READ_REQUEST_OVER_LIMIT ?? 0).toBe(0);
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
    expect(await bearerSendFromPage(page, `${site.backendOrigin}${SPA_BACKEND_PATHS.functionSyncAccess}`, 'POST')).toBe(0);
    await wait(LATE_REQUEST_WAIT_MS);
    // RB-4b: WebSocket の Upgrade は止めない（下で数える）。それを除いて、読み取りでない要求は届かない。
    expect(backendNonReads(site).filter((line) => !line.startsWith('UPGRADE '))).toEqual([]);
    expect(site.refreshes).toBe(0);
    expect(site.rumBeacons).toBe(0);
    // RB-4b: WebSocket（リアルタイムの通信）は、送信の扱いによらず止めない（READ_ONLY でも）。
    expect(backendRequests(site, ({ method }) => method === 'UPGRADE').length).toBeGreaterThan(0);
    expect([...blocked()].sort()).toEqual([
      `POST ${site.appOrigin}${SPA_APP_PATHS.rum} NON_READ_METHOD`,
      `POST ${site.backendOrigin}${SPA_BACKEND_PATHS.functionSyncAccess} NON_READ_METHOD`,
      `POST ${site.tokenOrigin}${SPA_BACKEND_PATHS.token}?grant_type=${SPA_GRANT_TYPES.refresh} NON_READ_METHOD`,
    ].sort());
    expect(ledger().blockedWebSockets).toEqual([]);
    expect(monitor.snapshot()).toMatchObject({ tokenRefreshBlocked: 1, otherNonReadBlocked: 2 });
  }, TEST_TIMEOUT_MS);

  // BN-0（設計書 `2026-10-23-beaksight-bundle-beaksight-block-noise-design.md` 3.0）: 監査の段の Passive の Context では、ページが出す文書でない GET（fetch を
  // 含む）には読む範囲を当てない（読む）。読む範囲の外の文書の読み込み（iframe）は、今どおり止める。
  // SD-2: 読む範囲は main frame の文書の読み込みだけに当てる（子の frame の文書も届く）。
  it('reads the static app script, a fetch and a child frame document outside the read range /admin', async () => {
    const site = await startSite();
    const { page, ledger } = await openAdmin(site, { auditPathPrefixes: [SPA_APP_PATHS.admin] });
    await waitForMembers(page, 'loaded');
    expect(await bearerSendFromPage(page, `${site.appOrigin}/outside-range`, 'GET')).not.toBe(0);
    await page.evaluate((src) => {
      const frame = document.createElement('iframe');
      frame.src = src;
      document.body.append(frame);
    }, `${site.appOrigin}/outside-range-frame`);
    await expect.poll(() => site.requests.filter((request) => request.origin === 'app' && request.path === '/outside-range-frame').length).toBe(1);
    expect(site.requests.filter((request) => request.origin === 'app' && request.path === SPA_APP_PATHS.script)).toHaveLength(1);
    expect(site.requests.filter((request) => request.origin === 'app' && request.path === '/outside-range')).toHaveLength(1);
    expect(ledger().blockedAuditExclusions).toBeUndefined();
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

// 2. T35R-fix（もと guard-audit-stage-revisit）。レビュー担当の実験（T35R の B05）を写した形。自前の 127.0.0.1 のサーバ 2 つ（アプリ = 許可 Origin、
// サービス = 承認したサービスの Origin）。
/** REVISIT の場面で、ページの要求の後に遅れて届く要求を待つ時間（ms。iframe・Worker を含む）。 */
const REVISIT_LATE_REQUEST_WAIT_MS = 1_500;
const REVISIT_PAGE_TIMEOUT_MS = 30_000;
/** ページが作る、サービスの Origin の iframe の数。 */
const IFRAME_COUNT = 3;
const ADMIN_PATH = '/admin/s';
const WORKER_PATH = '/admin/worker.js';
const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;
const WORKER_SOURCE = `onmessage = async (event) => { try { postMessage((await fetch(event.data)).status); } catch (error) { postMessage('err'); } };`;
const ADMIN_PAGE_HTML = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>管理</title></head><body><p>管理</p></body></html>';

interface ServerRecord {
  readonly server: 'app' | 'service';
  readonly path: string;
  readonly preflight: boolean;
}

/** ページの中で、サービスの Origin へ要求を出す（iframe の文書、fetch、画像、Worker の fetch）。 */
const serviceRequestsSource = (serviceOrigin: string): string => `(async () => {
  for (let index = 0; index < ${IFRAME_COUNT}; index += 1) {
    const frame = document.createElement('iframe'); frame.src = '${serviceOrigin}/frame' + index + '.html'; document.body.appendChild(frame);
  }
  const image = new Image(); image.src = '${serviceOrigin}/image.png'; document.body.appendChild(image);
  const fetched = await fetch('${serviceOrigin}/rest/v1/members').then((response) => response.status, () => 'err');
  const worker = new Worker('${WORKER_PATH}');
  const fromWorker = await new Promise((resolveWorker) => {
    worker.onmessage = (event) => resolveWorker(event.data);
    worker.onerror = () => resolveWorker('worker error');
    worker.postMessage('${serviceOrigin}/rest/v1/from-worker');
    setTimeout(() => resolveWorker('worker timeout'), 5000);
  });
  return { fetched, fromWorker };
})()`;

describe.each(BOTH_CHROMIUM_LAUNCHERS)('T35R-fix: the audit stage Guard on the width scan and Interaction contexts with %s', (_label, launch) => {
  let browser: Browser;
  let app: LoopbackHttpServer;
  let service: LoopbackHttpServer;
  const records: ServerRecord[] = [];

  const listenerOf = (server: ServerRecord['server']) => (request: IncomingMessage, response: ServerResponse): void => {
    request.on('data', () => undefined);
    request.on('end', () => {
      const preflight = request.method === 'OPTIONS' && request.headers['access-control-request-method'] !== undefined;
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      records.push({ server, path: url.pathname, preflight });
      const cors = { 'access-control-allow-origin': typeof request.headers.origin === 'string' ? request.headers.origin : '*' };
      if (request.method === 'OPTIONS') {
        response.writeHead(HTTP_NO_CONTENT, cors).end();
      } else if (url.pathname === WORKER_PATH) {
        response.writeHead(HTTP_OK, { 'content-type': 'text/javascript' }).end(WORKER_SOURCE);
      } else if (url.pathname.endsWith('.html') || url.pathname === ADMIN_PATH) {
        response.writeHead(HTTP_OK, { ...cors, 'content-type': 'text/html; charset=utf-8' }).end(ADMIN_PAGE_HTML);
      } else {
        response.writeHead(HTTP_OK, { ...cors, 'content-type': 'application/json' }).end('{"ok":true}');
      }
    });
  };

  beforeAll(async () => {
    browser = await launch();
    app = await startLoopbackHttpServer(listenerOf('app'));
    service = await startLoopbackHttpServer(listenerOf('service'));
  });

  afterAll(async () => {
    await browser?.close();
    await Promise.all([app?.close(), service?.close()]);
  });

  const revisitConfigOf = (): AuditConfig => {
    const base = fastRunConfig(app.origin, ADMIN_PATH);
    return { ...base, site: { startUrl: `${app.origin}${ADMIN_PATH}`, allowedOrigins: [app.origin] } };
  };
  const auditStageOf = (): AuditStageServiceRequests => ({
    approvedServiceOrigins: [service.origin],
    auditReadRequests: [],
    scriptLogin: { origin: service.origin, path: '/auth/v1/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] },
  });
  const authenticationOf = () => ({
    initialState: { cookies: [], origins: [] },
    filterState: <T>(state: T): T => state,
    auditExclusions: { excludedPathPrefixes: ['/logout'], auditPathPrefixes: ['/admin'], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
    auditStage: auditStageOf(),
  });

  it.each([true, false])('sends nothing to the service origin on a REVISIT context (with the Run cache: %s)', async (withCache) => {
    const config = revisitConfigOf();
    const budget = createServiceRequestBudget({ now: () => Date.now() });
    const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), {
      ...TEST_FACTORY_OPTIONS,
      ...(withCache ? { resourceCache: new ResourceCache() } : {}),
      authentication: authenticationOf(),
      serviceRequestBudget: budget,
      auditStageMonitor: new AuditStageMonitor(),
    });
    const start = records.length;
    try {
      const context = await factory.createPassiveContext(config.viewports.primaryDesktop, 'REVISIT');
      const page = await factory.createPassivePage(context);
      await page.goto(`${app.origin}${ADMIN_PATH}`, { timeout: REVISIT_PAGE_TIMEOUT_MS });
      await page.evaluate(serviceRequestsSource(service.origin));
      await wait(REVISIT_LATE_REQUEST_WAIT_MS);
      const ledger = factory.getSafetyLedger(context).snapshot();
      expect(records.slice(start).filter(({ server, preflight }) => server === 'service' && !preflight)).toEqual([]);
      expect(ledger.blockedRequests.filter(({ reason }) => reason === 'SERVICE_ORIGIN_REVISIT').length).toBeGreaterThanOrEqual(IFRAME_COUNT);
      expect(ledger.invariantViolations).toEqual([]);
      expect(budget.snapshot().admitted).toBe(0);
    } finally {
      await factory.close();
    }
  }, TEST_TIMEOUT_MS);

  // T35R2-fix（T35R2 の C-1 の (a)）: 監査の段の口があって、上限の部品を渡さない factory は、Context を作らずに投げる（数えずに通さない。fail-closed）。
  it.each<ResourceDeliveryRole>(['PRIMARY', 'REVISIT'])('throws without creating a %s context when the audit stage has no budget', async (role) => {
    const config = revisitConfigOf();
    const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), { ...TEST_FACTORY_OPTIONS, authentication: authenticationOf() });
    const contextsBefore = testContextsOf(browser).length;
    try {
      await expect(factory.createPassiveContext(config.viewports.primaryDesktop, role)).rejects.toThrow(/service request budget/u);
      expect(testContextsOf(browser)).toHaveLength(contextsBefore);
    } finally {
      await factory.close();
    }
  }, TEST_TIMEOUT_MS);
});

// 3. AS-a と AS-c fix round 1〜3（もと guard-audit-send-policy・guard-audit-send-review-fixes）。
/** 止めるべき要求を確かめる回の数（回ごとに新しい Context で読み込む）。 */
const BLOCK_ROUNDS = 2;
/** AS-c fix round 2（I-C）: route の通過が照らし合わせの時間（`AUDIT_SEND_WEBSOCKET_MATCH_WINDOW_MS`）を過ぎるまで待つ時間（ms）。 */
const STALE_ADMISSION_WAIT_MS = 1_000;

/** 通した接続の記録の行を、比べやすい文字列にする（`<Origin><path> <数>` と印）。 */
const connectionRows = (record: PassedAuditSendWebSocketsRecord | undefined): readonly string[] =>
  (record?.connections ?? []).map(({ origin, path, count, outsideGuard, dangerous }) =>
    `${origin}${path} ${count}${outsideGuard === true ? ' OUTSIDE_GUARD' : ''}${dangerous === true ? ' DANGEROUS' : ''}`);

/** サーバに届いた WebSocket の接続の path。 */
const upgrades = (site: RecordingServer): readonly string[] => site.requests.filter((entry) => entry.startsWith('UPGRADE '));

describe.each(BOTH_CHROMIUM_LAUNCHERS)('AS-a and AS-c: the audit send policy PASS_EXCEPT_DELETE with %s', (_label, launch) => {
  let browser: Browser;
  let app: RecordingServer;
  let service: RecordingServer;
  let other: RecordingServer;
  /** 共有の factory（`PASS_EXCEPT_DELETE` の指定つき・指定なし）。出口の中継は Context ごとなので、場面の間で持ち越さない。 */
  let sendFactory: BrowserContextFactory;
  let readOnlyFactory: BrowserContextFactory;

  const configOf = (): AuditConfig => fastRunConfig(app.server.origin, PAGE_PATH);

  const newFactory = (send: boolean, target: Browser = browser): BrowserContextFactory => new BrowserContextFactory(target, configOf(), () => new SafetyLedger(), {
    ...TEST_FACTORY_OPTIONS,
    ...(send
      ? { auditSend: { policy: 'PASS_EXCEPT_DELETE', approvedServiceOrigins: [service.server.origin], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS } }
      : {}),
  });

  beforeAll(async () => {
    browser = await launch();
    [app, service, other] = await Promise.all([startRecordingServer(), startRecordingServer(), startRecordingServer()]);
    sendFactory = newFactory(true);
    readOnlyFactory = newFactory(false);
  });

  beforeEach(() => {
    for (const site of [app, service, other]) {
      site.requests.length = 0;
      site.preflights.length = 0;
    }
  });

  afterEach(async () => {
    await closeTestContexts(browser);
  });

  afterAll(async () => {
    await Promise.all([sendFactory, readOnlyFactory].filter((factory) => factory !== undefined).map((factory) => factory.close()));
    await browser?.close();
    await Promise.all([app, service, other].filter((site) => site !== undefined).map((site) => site.server.close()));
  });

  /** Passive の Context でページを開く。 */
  const openPage = async (factory: BrowserContextFactory): Promise<{ readonly page: Page; readonly ledger: () => SafetyLedgerSnapshot }> => {
    const context: BrowserContext = await factory.createPassiveContext(configOf().viewports.primaryDesktop);
    const page = await factory.createPassivePage(context);
    await page.goto(`${app.server.origin}${PAGE_PATH}`);
    await page.frameLocator('#child').locator('#frame-form').waitFor({ state: 'attached' });
    return { page, ledger: () => factory.getSafetyLedger(context).snapshot() };
  };

  /** ページの FormData（multipart。ファイルなし）の POST（応答の状態。届かなければ 0）。 */
  const formDataPost = (page: Page, url: string, method: string): Promise<number> => page.evaluate(async ({ target, override }) => {
    const form = new FormData();
    form.append('name', 'value');
    form.append('_method', override);
    try {
      return (await fetch(target, { method: 'POST', body: form })).status;
    } catch {
      return 0;
    }
  }, { target: url, override: method });

  /** Ledger の通した接続の数が `count` になるまで待つ（観察の事象は、接続が開いた後に届きうる）。 */
  const waitForPassedSockets = async (ledger: () => SafetyLedgerSnapshot, count: number): Promise<SafetyLedgerSnapshot> => {
    const deadline = Date.now() + ARRIVAL_TIMEOUT_MS;
    while (Date.now() < deadline && (ledger().passedAuditSendWebSockets?.count ?? 0) < count) {
      await wait(ARRIVAL_POLL_MS);
    }
    return ledger();
  };

  it('passes fetch, XHR and beacon POST, PUT, PATCH and OPTIONS to the allowed and the approved service Origin, and records them without values', async () => {
    const { page, ledger } = await openPage(sendFactory);
    const appUrl = (path: string): string => `${app.server.origin}${path}`;
    expect(await fetchFromPage(page, appUrl('/api/fetch-post?token=secret-value'), 'POST')).toBe(200);
    expect(await xhrFromPage(page, appUrl('/api/xhr-post'), 'POST')).toBe(200);
    expect(await fetchFromPage(page, appUrl('/api/put'), 'PUT')).toBe(200);
    expect(await fetchFromPage(page, appUrl('/api/patch'), 'PATCH')).toBe(200);
    expect(await fetchFromPage(page, appUrl('/api/options'), 'OPTIONS')).toBe(200);
    expect(await beaconFromPage(page, appUrl('/api/beacon'))).toBe(true);
    // サービスの Origin への POST（JSON。REV-RB14 の I-1: CORS の事前確認もサーバへ送り、その答えで満たす。本番の POST がサーバに届く）。
    expect(await fetchFromPage(page, `${service.server.origin}/api/service-write`, 'POST', 'application/json')).toBe(200);
    const appArrivals = await waitForArrivals(app, [
      'POST /api/fetch-post', 'POST /api/xhr-post', 'PUT /api/put', 'PATCH /api/patch', 'OPTIONS /api/options', 'POST /api/beacon',
    ]);
    expect(appArrivals.filter((entry) => !entry.startsWith('GET '))).toEqual([
      'POST /api/fetch-post', 'POST /api/xhr-post', 'PUT /api/put', 'PATCH /api/patch', 'OPTIONS /api/options', 'POST /api/beacon',
    ]);
    expect(await waitForArrivals(service, ['POST /api/service-write'])).toEqual(['POST /api/service-write']);
    const snapshot = ledger();
    expect(snapshot.invariantViolationCount).toBe(0);
    expect(snapshot.blockedRequests).toEqual([]);
    expect(snapshot.passedAuditSendRequests?.count).toBe(8);
    expect(snapshot.passedAuditSendRequests?.byMethod).toEqual({ POST: 4, PUT: 1, PATCH: 1, OPTIONS: 2 });
    expect(snapshot.passedAuditSendRequests?.requests.map(({ method, origin, path, count }) => `${method} ${origin}${path} ${count}`)).toEqual([
      `POST ${app.server.origin}/api/fetch-post 1`,
      `POST ${app.server.origin}/api/xhr-post 1`,
      `PUT ${app.server.origin}/api/put 1`,
      `PATCH ${app.server.origin}/api/patch 1`,
      `OPTIONS ${app.server.origin}/api/options 1`,
      `POST ${app.server.origin}/api/beacon 1`,
      `OPTIONS ${service.server.origin}/api/service-write 1`,
      `POST ${service.server.origin}/api/service-write 1`,
    ]);
    // 値（query の値）は記録しない。
    expect(JSON.stringify(snapshot)).not.toContain('secret-value');
  }, TEST_TIMEOUT_MS);

  // RB-4b: Isolated Interaction Context の押す前の段は、既定は通す（押す前の通り方の代表は `tests/contract/pass-through-paths.test.ts`）。ここでは、送信の扱いの
  // 口のある認証つきの factory でも、押した後（凍結の後）の POST が、テストの Origin・サービスの Origin・ほかの Origin のどれにも届かないこと（守り 2）だけを確かめる。
  it('blocks the POSTs after the freeze in the Isolated Interaction Context even if the factory has the policy (PROBE_FREEZE)', async () => {
    const session = await sendFactory.createInteractionSession(configOf().viewports.primaryDesktop);
    try {
      await session.page.goto(`${app.server.origin}${PAGE_PATH}`);
      await session.activateInteractionFreeze();
      await session.page.evaluate((targets) => {
        for (const target of targets) void fetch(target, { method: 'POST', body: 'payload' }).catch(() => undefined);
      }, [
        `${app.server.origin}/api/interaction-after-freeze`,
        `${service.server.origin}/api/interaction-service`,
        `${other.server.origin}/api/interaction-other`,
      ]);
      await wait(ARRIVAL_POLL_MS * 4);
      expect(session.ledger.snapshot().invariantViolationCount).toBe(0);
    } finally {
      await session.close();
    }
    await wait(LATE_REQUEST_WAIT_MS);
    expect(nonReads(app)).toEqual([]);
    expect(nonReads(service)).toEqual([]);
    expect(nonReads(other)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // AS-c（設計書 5 章の「ユーザーの言葉と選択（AS-c）」の行）: 送り先の Origin の制限をなくした。ほかの Origin への fetch・XHR の POST は、出口の中継を通って届き、
  // ほかの Origin へ通した数として記録する。
  it('passes the POST of the page to another Origin through the egress relay, and counts it as another Origin', async () => {
    const { page, ledger } = await openPage(sendFactory);
    expect(await fetchFromPage(page, `${other.server.origin}/api/other?token=secret-value`, 'POST')).toBe(200);
    expect(await xhrFromPage(page, `${other.server.origin}/api/other-xhr`, 'POST')).toBe(200);
    expect(await fetchFromPage(page, `${app.server.origin}/api/same`, 'POST')).toBe(200);
    expect(await waitForArrivals(other, ['POST /api/other', 'POST /api/other-xhr'])).toEqual(['POST /api/other', 'POST /api/other-xhr']);
    const snapshot = ledger();
    expect(snapshot.invariantViolationCount).toBe(0);
    expect(snapshot.blockedRequests).toEqual([]);
    expect(snapshot.passedAuditSendRequests).toMatchObject({ count: 3, otherOrigins: 2 });
    expect(JSON.stringify(snapshot)).not.toContain('secret-value');
  }, TEST_TIMEOUT_MS);

  // AS-c: WebSocket の接続は、通して形（Origin・path・数）だけを記録する。危険な語の path は今どおり止める（L10 の前の上限を超える数の場面は消した）。
  // SD-2: 危険な語の path の接続も通す（代表は `tests/contract/pass-through-paths.test.ts`）。ここでは形の記録だけを確かめる。
  it('passes WebSocket connections (also to another Origin) and records their shape, every round', async () => {
    for (let round = 0; round < BLOCK_ROUNDS; round += 1) {
      const since = { app: app.requests.length, other: other.requests.length };
      const { page, ledger } = await openPage(sendFactory);
      expect(await openWebSocketFromPage(page, `${webSocketOriginOf(app.server.origin)}/realtime?apikey=secret-value`)).toBe('open');
      expect(await openWebSocketFromPage(page, `${webSocketOriginOf(other.server.origin)}/socket`)).toBe('open');
      await wait(ARRIVAL_POLL_MS * 4);
      expect(app.requests.slice(since.app).filter((entry) => entry.startsWith('UPGRADE '))).toEqual(['UPGRADE /realtime']);
      expect(other.requests.slice(since.other).filter((entry) => entry.startsWith('UPGRADE '))).toEqual(['UPGRADE /socket']);
      const snapshot = ledger();
      expect(snapshot.invariantViolationCount).toBe(0);
      expect(snapshot.passedAuditSendWebSockets).toEqual({
        count: 2,
        connections: [
          { origin: webSocketOriginOf(app.server.origin), path: '/realtime', count: 1 },
          { origin: webSocketOriginOf(other.server.origin), path: '/socket', count: 1 },
        ],
        unlisted: 0,
        // AS-c fix round 1: route を通って開いた接続だけなので、印の数は 0。
        outsideGuard: 0,
        dangerous: 0,
      });
      expect(snapshot.blockedWebSockets).toEqual([]);
      expect(JSON.stringify(snapshot.passedAuditSendWebSockets)).not.toContain('secret-value');
    }
  }, TEST_TIMEOUT_MS);

  it('keeps the default (no policy) read-only for the same requests', async () => {
    const { page, ledger } = await openPage(readOnlyFactory);
    expect(await fetchFromPage(page, `${app.server.origin}/api/fetch-post`, 'POST')).toBe(0);
    expect(await fetchFromPage(page, `${service.server.origin}/api/service-write`, 'POST', 'application/json')).toBe(0);
    expect(await beaconFromPage(page, `${app.server.origin}/api/beacon`)).toBe(true);
    // AS-c: 既定では、ほかの Origin への POST も、今どおり届かない。RB-4b: WebSocket の接続は、READ_ONLY でも止めない（リアルタイムの通信）。
    expect(await fetchFromPage(page, `${other.server.origin}/api/other`, 'POST')).toBe(0);
    expect(await openWebSocketFromPage(page, `${webSocketOriginOf(app.server.origin)}/realtime`)).toBe('open');
    await wait(LATE_REQUEST_WAIT_MS);
    expect(nonReads(app)).toEqual(['UPGRADE /realtime']);
    expect(nonReads(service)).toEqual([]);
    expect(nonReads(other)).toEqual([]);
    const snapshot = ledger();
    expect(snapshot.invariantViolationCount).toBe(0);
    expect(snapshot.passedAuditSendRequests).toBeUndefined();
    expect(snapshot.passedAuditSendWebSockets).toBeUndefined();
    expect(snapshot.blockedWebSockets).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('I-2: keeps passing the overrides that are not DELETE', async () => {
    const { page, ledger } = await openPage(sendFactory);
    expect(await sendFromPage(page, `${app.server.origin}/api/put-override`, 'POST', { 'content-type': 'text/plain', 'X-HTTP-Method-Override': 'PUT' }, 'payload')).toBe(200);
    expect(await formDataPost(page, `${app.server.origin}/api/patch-form`, 'patch')).toBe(200);
    expect(await waitForArrivals(app, ['POST /api/put-override', 'POST /api/patch-form'])).toEqual(expect.arrayContaining(['POST /api/put-override', 'POST /api/patch-form']));
    expect(ledger().passedAuditSendRequests?.count).toBe(2);
  }, TEST_TIMEOUT_MS);

  // AS-c fix round 2（I-D。AS-R2 の B03・B07・F41）: リダイレクトの先の要求（route が呼ばれない段）も、CDP の層で通した要求として記録する。数えずに全部の段を
  // 通して記録する。
  it('I-D: records each hop of a 307 redirect, and passes every hop', async () => {
    const { page, ledger } = await openPage(sendFactory);
    expect(await sendFromPage(page, redirectUrlOf(app.server.origin, 307, 'b07', `${app.server.origin}/api/ok-b07`), 'POST', { 'content-type': 'text/plain' }, 'x')).toBe(200);
    expect(await sendFromPage(page, redirectUrlOf(app.server.origin, 307, 'b03', `${other.server.origin}/api/ok-b03`), 'POST', { 'content-type': 'text/plain' }, 'x')).toBe(200);
    await waitForArrivals(app, ['POST /api/ok-b07']);
    await waitForArrivals(other, ['POST /api/ok-b03']);
    const snapshot = ledger();
    expect(snapshot.passedAuditSendRequests?.count).toBe(4);
    expect(snapshot.passedAuditSendRequests?.requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'POST /redirect/307/b07',
      'POST /api/ok-b07',
      'POST /redirect/307/b03',
      'POST /api/ok-b03',
    ]);
    expect(snapshot.blockedRequests).toEqual([]);
    await wait(LATE_REQUEST_WAIT_MS);
    expect(nonReads(other)).toEqual(['POST /api/ok-b03']);
  }, TEST_TIMEOUT_MS);

  // AS-c fix round 3（AS-R3 の B03・W4）: ほかの Origin への 307 の先も、届いたら CDP の層で記録する（`redirectedRequestId` のない段も、同じ Network の
  // 要求の ID を手がかりにする）。
  it('I-D: records the hop of a 307 redirect to another Origin that arrives', async () => {
    const { page, ledger } = await openPage(sendFactory);
    expect(await sendFromPage(page, redirectUrlOf(app.server.origin, 307, 'w4', `${other.server.origin}/api/ok-w4`), 'POST', { 'content-type': 'text/plain' }, 'x')).toBe(200);
    expect(await waitForArrivals(other, ['POST /api/ok-w4'])).toContain('POST /api/ok-w4');
    const snapshot = ledger();
    expect(snapshot.passedAuditSendRequests?.requests.map(({ method, origin, path }) => `${method} ${origin}${path}`)).toEqual([
      `POST ${app.server.origin}/redirect/307/w4`,
      `POST ${other.server.origin}/api/ok-w4`,
    ]);
    expect(snapshot.passedAuditSendRequests).toMatchObject({ count: 2, otherOrigins: 1 });
  }, TEST_TIMEOUT_MS);

  it('C-1: records the connections that bypassed the WebSocket mock from the browser facts, with marks, without invalidating the Context', async () => {
    const { page, ledger } = await openPage(sendFactory);
    const appSocket = webSocketOriginOf(app.server.origin);
    const otherSocket = webSocketOriginOf(other.server.origin);
    // 今どおり route を通って開く接続（印なし）。出口の中継は、Guard が通した接続の宛先だけを通すので、ほかの Origin へも先に 1 本を開いておく。
    expect(await openWebSocketFromPage(page, `${appSocket}/ws/realtime`)).toBe('open');
    expect(await openWebSocketFromPage(page, `${otherSocket}/ws/other-realtime`)).toBe('open');
    // 模擬の迂回（AS-R の M01・M02・M04・M05）。止められない（届く）。
    await bypassWebSocketMock(page, `${appSocket}/ws/logout-m01`, 'apiConnect');
    await bypassWebSocketMock(page, `${appSocket}/ws/ok-m02`, 'urlSwap', `${appSocket}/ws/delete-m02`);
    await bypassWebSocketMock(page, `${otherSocket}/ws/remove-m04`, 'apiConnect');
    const child = page.frames().find((frame: Frame) => frame.url().endsWith('/frame'));
    expect(child).toBeDefined();
    await bypassWebSocketMock(child!, `${appSocket}/ws/logout-m05`, 'apiConnect');
    await waitForArrivals(app, ['UPGRADE /ws/realtime', 'UPGRADE /ws/logout-m01', 'UPGRADE /ws/delete-m02', 'UPGRADE /ws/logout-m05']);
    await waitForArrivals(other, ['UPGRADE /ws/other-realtime', 'UPGRADE /ws/remove-m04']);
    const arrived = upgrades(app).length + upgrades(other).length;
    expect(arrived).toBe(6);
    const snapshot = await waitForPassedSockets(ledger, arrived);
    // 記録の数は、ブラウザが実際に開いた接続の数と同じ。
    expect(snapshot.passedAuditSendWebSockets?.count).toBe(arrived);
    expect(connectionRows(snapshot.passedAuditSendWebSockets)).toEqual(expect.arrayContaining([
      `${appSocket}/ws/realtime 1`,
      `${otherSocket}/ws/other-realtime 1`,
      // SD-2: Guard の route が危険な語の接続も通すので、模擬を迂回しても route の通過と照らし合う（URL を差し替えた M02 だけが route の外）。危険な語の印は残す。
      `${appSocket}/ws/logout-m01 1 DANGEROUS`,
      `${appSocket}/ws/delete-m02 1 OUTSIDE_GUARD DANGEROUS`,
      `${otherSocket}/ws/remove-m04 1 DANGEROUS`,
      `${appSocket}/ws/logout-m05 1 DANGEROUS`,
    ]));
    expect(snapshot.passedAuditSendWebSockets).toMatchObject({ outsideGuard: 1, dangerous: 4 });
    // Context は無効にしない（ページは読み込める）。L10（設計者の判断 C）: ページが始めた移動は、同じ URL に戻ると輪として止めるので、確かめの読み込み直しは
    // BeakSight 自身の読み込みとして知らせてから行う（本番の読み込みの部品 `main-frame-load.ts` と同じ）。
    expect(snapshot.invariantViolationCount).toBe(0);
    announceOwnMainFrameNavigation(page);
    await page.reload();
    expect(await page.title()).toBe('p');
  }, TEST_TIMEOUT_MS);

  // AS-c fix round 2（I-C。AS-R2 の R07・R08x）: route が通した数との照らし合わせは、Guard が `connectToServer()` を呼んだ後の短い時間に観察した接続とだけ行う。
  // 照らせなかった route の通過（迂回で URL を差し替えた、先に開いていた）は残らず、後で同じ URL へ開いた接続は route の外（`outsideGuard`）になる。
  it('I-C: does not match a later connection with a stale admission of the route', async () => {
    const { page, ledger } = await openPage(sendFactory);
    const appSocket = webSocketOriginOf(app.server.origin);
    expect(await openWebSocketFromPage(page, `${appSocket}/ws/realtime`)).toBe('open');
    // R08x: route は ok-r08x を通したが、本物の接続は delete-r08 へ開いた（route の通過は使われずに残る）。
    await bypassWebSocketMock(page, `${appSocket}/ws/ok-r08x`, 'urlSwap', `${appSocket}/ws/delete-r08`);
    // R07: 模擬を迂回して先に開き、その後に route が通した。
    await bypassWebSocketMock(page, `${appSocket}/ws/ok-r07`, 'apiConnect');
    await wait(STALE_ADMISSION_WAIT_MS);
    expect(await openWebSocketFromWorker(page, `${appSocket}/ws/ok-r08x`)).toBe('open');
    expect(await openWebSocketFromWorker(page, `${appSocket}/ws/ok-r07`)).toBe('open');
    const snapshot = await waitForPassedSockets(ledger, 5);
    const rows = connectionRows(snapshot.passedAuditSendWebSockets);
    expect(rows).toEqual(expect.arrayContaining([
      `${appSocket}/ws/realtime 1`,
      `${appSocket}/ws/delete-r08 1 OUTSIDE_GUARD DANGEROUS`,
      `${appSocket}/ws/ok-r08x 1 OUTSIDE_GUARD`,
    ]));
    // 後で Worker から開いた ok-r07 は、route の外。
    expect(rows.filter((row) => row.startsWith(`${appSocket}/ws/ok-r07 `) && row.endsWith('OUTSIDE_GUARD')).length).toBeGreaterThanOrEqual(1);
    expect(rows.some((row) => row === `${appSocket}/ws/ok-r08x 1`)).toBe(false);
  }, TEST_TIMEOUT_MS);

  it('C-2: records the connections in a Worker from the browser facts, with marks (D14, D16)', async () => {
    const { page, ledger } = await openPage(sendFactory);
    const appSocket = webSocketOriginOf(app.server.origin);
    const otherSocket = webSocketOriginOf(other.server.origin);
    // 出口の中継は、Guard が通した接続の宛先だけを通すので、先にページから 1 本ずつ開いておく（Worker の接続は、その宛先へだけ届く）。
    expect(await openWebSocketFromPage(page, `${appSocket}/ws/realtime`)).toBe('open');
    expect(await openWebSocketFromPage(page, `${otherSocket}/ws/other-realtime`)).toBe('open');
    expect(await openWebSocketFromWorker(page, `${appSocket}/ws/logout-d14`)).toBe('open');
    expect(await openWebSocketFromWorker(page, `${appSocket}/ws/ok-d15`)).toBe('open');
    expect(await openWebSocketFromWorker(page, `${otherSocket}/ws/delete-d16`)).toBe('open');
    const snapshot = await waitForPassedSockets(ledger, 5);
    expect(snapshot.passedAuditSendWebSockets?.count).toBe(5);
    expect(connectionRows(snapshot.passedAuditSendWebSockets)).toEqual([
      `${appSocket}/ws/realtime 1`,
      `${otherSocket}/ws/other-realtime 1`,
      `${appSocket}/ws/logout-d14 1 OUTSIDE_GUARD DANGEROUS`,
      `${appSocket}/ws/ok-d15 1 OUTSIDE_GUARD`,
      `${otherSocket}/ws/delete-d16 1 OUTSIDE_GUARD DANGEROUS`,
    ]);
    expect(snapshot.invariantViolationCount).toBe(0);
  }, TEST_TIMEOUT_MS);

  // I-1（AS-R の P01・P02。設計書 5 章の「AS-c fix round 1 の Blocker」の行）: 通す見込みの要求の、ほかの Origin への CORS の事前確認は、Guard が同じ形の
  // 事前確認をサーバへ送り、その応答でブラウザの事前確認を満たす。CORS を許さないサーバには事前確認だけが届き、本番の要求は届かない。CORS を許すサーバには
  // 事前確認と本番の両方が届く。送った事前確認は、通した要求（`OPTIONS`。ほかの Origin）として記録する。
  it('I-1: sends the preflight to another Origin and answers the browser with the real response', async () => {
    const { page, ledger } = await openPage(sendFactory);
    expect(await corsFetchFromPage(page, `${other.server.origin}${NO_CORS_PATH_PREFIX}/p01`, 'PUT', 'omit')).toBe(0);
    expect(await corsFetchFromPage(page, `${other.server.origin}${NO_CORS_PATH_PREFIX}/p02`, 'POST', 'include')).toBe(0);
    expect(await corsFetchFromPage(page, `${other.server.origin}/api/cors-put`, 'PUT', 'omit')).toBe(200);
    await waitForArrivals(other, ['PUT /api/cors-put']);
    await wait(LATE_REQUEST_WAIT_MS);
    expect(other.preflights).toEqual([`${NO_CORS_PATH_PREFIX}/p01`, `${NO_CORS_PATH_PREFIX}/p02`, '/api/cors-put']);
    expect(nonReads(other)).toEqual(['PUT /api/cors-put']);
    const snapshot = ledger();
    expect(snapshot.invariantViolationCount).toBe(0);
    expect(snapshot.passedAuditSendRequests?.requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `OPTIONS ${NO_CORS_PATH_PREFIX}/p01`,
      `OPTIONS ${NO_CORS_PATH_PREFIX}/p02`,
      'OPTIONS /api/cors-put',
      'PUT /api/cors-put',
    ]);
    expect(snapshot.passedAuditSendRequests?.otherOrigins).toBe(4);
  }, TEST_TIMEOUT_MS);

  // I-1: サーバが事前確認に応答しない（時間切れ）ときは、拒む応答でブラウザの事前確認を満たす（本番の要求は届かない）。
  it('I-1: answers the browser with a rejection when the server does not answer the preflight in time', async () => {
    const { page, ledger } = await openPage(sendFactory);
    expect(await corsFetchFromPage(page, `${other.server.origin}${SILENT_PREFLIGHT_PATH_PREFIX}/put`, 'PUT', 'omit')).toBe(0);
    await wait(LATE_REQUEST_WAIT_MS);
    expect(other.preflights).toEqual([`${SILENT_PREFLIGHT_PATH_PREFIX}/put`]);
    expect(nonReads(other)).toEqual([]);
    const snapshot = ledger();
    expect(snapshot.invariantViolationCount).toBe(0);
    expect(snapshot.passedAuditSendRequests?.requests.map(({ method, path }) => `${method} ${path}`)).toEqual([`OPTIONS ${SILENT_PREFLIGHT_PATH_PREFIX}/put`]);
  }, TEST_TIMEOUT_MS);

  // REV-RB14 の I-1: 承認したサービスの Origin（AS-R の P05）と許可 Origin への事前確認も、サーバへ送って、その答えで満たす（前は Guard が返した）。サーバが
  // CORS のヘッダを返さない（拒む）ので、本番の要求はブラウザが送らない。既定の READ_ONLY は今のまま（事前確認も送らない）。
  it('I-1: sends the preflight to the approved service Origin to the server, so the request it refused never arrives, and keeps READ_ONLY', async () => {
    const { page } = await openPage(sendFactory);
    expect(await corsFetchFromPage(page, `${service.server.origin}${NO_CORS_PATH_PREFIX}/p05`, 'PATCH', 'include')).toBe(0);
    await wait(LATE_REQUEST_WAIT_MS);
    expect(service.preflights).toEqual([`${NO_CORS_PATH_PREFIX}/p05`]);
    expect(nonReads(service)).toEqual([]);
    const readOnly = await openPage(readOnlyFactory);
    expect(await corsFetchFromPage(readOnly.page, `${other.server.origin}${NO_CORS_PATH_PREFIX}/ro`, 'PUT', 'omit')).toBe(0);
    await wait(LATE_REQUEST_WAIT_MS);
    expect(other.preflights).toEqual([]);
    expect(nonReads(other)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // C-1: 別のプロセスの iframe（OOPIF）の中の接続も、観察の session が子の target に付いて数える。観察の付与は、Guard の OOPIF の横取り（止めて付ける）を
  // 妨げない（違反 0、iframe は読み込める）。この場面だけ、`--site-per-process` の Chromium と、その factory を作る。
  it('C-1: records the connections in an out-of-process iframe, and keeps the Guard of the iframe working', async () => {
    const isolated = await launch({ args: SITE_PER_PROCESS_ARGS });
    const factory = newFactory(true, isolated);
    try {
      const context: BrowserContext = await factory.createPassiveContext(configOf().viewports.primaryDesktop);
      const page = await factory.createPassivePage(context);
      await page.goto(`${app.server.origin}${PAGE_PATH}`);
      // 同じサーバの別のホスト名（`localhost`）の iframe は、別のサイトなので別のプロセス（OOPIF）になる。
      const crossSiteFrameUrl = `http://localhost:${String(app.server.port)}/frame`;
      await page.evaluate((source) => {
        const frame = document.createElement('iframe');
        frame.id = 'cross-site';
        frame.src = source;
        document.body.appendChild(frame);
      }, crossSiteFrameUrl);
      await page.frameLocator('#cross-site').locator('#frame-form').waitFor({ state: 'attached' });
      expect(await oopifTargetUrls(isolated)).toContain(crossSiteFrameUrl);
      const frame = page.frames().find((candidate) => candidate.url() === crossSiteFrameUrl);
      expect(frame).toBeDefined();
      const appSocket = webSocketOriginOf(app.server.origin);
      // 出口の中継が通す宛先にするため、ページから先に 1 本を開く。
      expect(await openWebSocketFromPage(page, `${appSocket}/ws/realtime`)).toBe('open');
      // SD-2: Guard の route は危険な語の接続も通すので、迂回した本物の接続も route の通過と照らし合う（危険な語の印は残す）。
      await bypassWebSocketMock(frame!, `${appSocket}/ws/logout-oopif`, 'apiConnect');
      expect(await waitForArrivals(app, ['UPGRADE /ws/logout-oopif'])).toContain('UPGRADE /ws/logout-oopif');
      const snapshot = await waitForPassedSockets(() => factory.getSafetyLedger(context).snapshot(), 2);
      expect(connectionRows(snapshot.passedAuditSendWebSockets)).toEqual([
        `${appSocket}/ws/realtime 1`,
        `${appSocket}/ws/logout-oopif 1 DANGEROUS`,
      ]);
      expect(snapshot.invariantViolationCount).toBe(0);
    } finally {
      await factory.close();
      await isolated.close();
    }
  }, TEST_TIMEOUT_MS);

  // M-3（AS-R の PX02）: about:blank のポップアップの realm の POST は、ブラウザから送られない（Playwright が進めない）。送った事実の時点（route の層が進める時点。
  // route を通らない送信は CDP の層が進める時点）で記録するので、届かない要求を通したと記録しない。Worker の送信と beacon は、今どおり届いて記録する。
  it('M-3: records a passed request when it is sent, not for a request in a fresh about:blank popup that never leaves the browser', async () => {
    const { page, ledger } = await openPage(sendFactory);
    const popupResult = await page.evaluate(async (target) => {
      const popup = window.open('about:blank');
      if (popup === null) return 'null';
      try {
        const sent = (popup as unknown as { fetch: typeof fetch }).fetch(target, { method: 'POST', body: 'x' });
        const response = await Promise.race([sent, new Promise<null>((resolveLater) => setTimeout(() => resolveLater(null), 3_000))]);
        return response === null ? 'pending' : `status:${response.status}`;
      } catch {
        return 'failed';
      }
    }, `${app.server.origin}/api/popup-px02`);
    expect(popupResult).not.toMatch(/^status:/u);
    const workerStatus = await page.evaluate((target) => new Promise<string>((resolveState) => {
      const source = 'self.onmessage=async(e)=>{try{const r=await fetch(e.data,{method:"POST",body:"x"});postMessage("status:"+r.status)}catch(x){postMessage("failed")}};';
      const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
      worker.onmessage = (event) => resolveState(String(event.data));
      worker.postMessage(target);
    }), `${app.server.origin}/api/worker-post`);
    expect(workerStatus).toBe('status:200');
    expect(await page.evaluate((target) => navigator.sendBeacon(target, 'x'), `${app.server.origin}/api/beacon`)).toBe(true);
    await waitForArrivals(app, ['POST /api/worker-post', 'POST /api/beacon']);
    await wait(LATE_REQUEST_WAIT_MS);
    expect(nonReads(app)).toEqual(['POST /api/worker-post', 'POST /api/beacon']);
    const snapshot = ledger();
    expect(snapshot.passedAuditSendRequests?.requests.map(({ method, path }) => `${method} ${path}`)).toEqual(['POST /api/worker-post', 'POST /api/beacon']);
    expect(snapshot.passedAuditSendRequests?.count).toBe(2);
  }, TEST_TIMEOUT_MS);

  // RB-4b: 既定（READ_ONLY）で、模擬の迂回と Worker の中の WebSocket が開かないことの場面は外した（READ_ONLY でもリアルタイムの通信を止めない。ユーザーの
  // 判断 2026-11-15）。止める先がないので、別の所の確かめはない。
});
