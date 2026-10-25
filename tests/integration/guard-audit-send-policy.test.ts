// AS-a（設計書 `doc/design/2026-10-19-beaksight-audit-send-policy-design.md` 2.2・2.3、受け入れ条件 2〜4）: 監査の段の送信の扱い
// `PASS_EXCEPT_DELETE`（factory の指定 `auditSend`。Guard の口 `PassiveRequestGuardOptions.auditSend`）。
// 通す部品（どれも本物。Chromium はテストの既定の headless と、CLI の起動の設定の両方）: `BrowserContextFactory` と、その Guard と出口の中継。サイトは
// 127.0.0.1 の 3 つのサーバ（許可 Origin、承認したサービスの Origin、ほかの Origin）。届いたかは、サーバの記録で数える。
// - 通す: 許可 Origin とサービスの Origin への、ページが自分で出す読み取りでない要求（fetch・XHR・`sendBeacon` の POST、PUT・PATCH・OPTIONS。サービスの
//   Origin への POST は CORS の事前確認つき）。Safety Ledger に、method・Origin・path・回数を記録する（値は記録しない）。
// - 止める: `DELETE`、危険な語の path、ほかの Origin への POST、main frame のフォームの POST、iframe のフォームの POST、上限を超えた要求。止めるべき
//   要求は、回ごとにサーバに届かないこと・違反 0 を確かめ、全部の回の後に名前つきの時間（`LATE_REQUEST_WAIT_MS`）だけ待ってから数え直す。
// - Isolated Interaction Context は、factory に指定があっても、今のまま読み取りだけ。
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AuditConfig } from '../../src/config/types.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { SafetyLedger, type SafetyLedgerSnapshot } from '../../src/safety/safety-ledger.js';
import {
  ARRIVAL_POLL_MS,
  PAGE_PATH,
  beaconFromPage,
  fetchFromPage,
  nonReads,
  openWebSocketFromPage,
  startRecordingServer,
  wait,
  waitForArrivals,
  webSocketOriginOf,
  xhrFromPage,
  type RecordingServer,
} from '../helpers/audit-send-site.js';
import { closeTestContexts, launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { fastRunConfig } from '../helpers/run-harness.js';
import { TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

const LAUNCHERS: readonly (readonly [string, () => Promise<Browser>])[] = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI Chromium', () => launchCliChromium()],
];
const TEST_TIMEOUT_MS = 120_000;
/** 止めるべき要求の、全部の回の後に、遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 1_000;
/** 止めるべき要求を確かめる回の数（回ごとに新しい Context で読み込む）。 */
const BLOCK_ROUNDS = 2;
/** 上限の場面の、この読み込み（Context）で通す数の上限と、ページが送る数。 */
const SMALL_LIMIT = 2;
const OVER_LIMIT_SENDS = 4;

describe.each(LAUNCHERS)('AS-a: the audit send policy PASS_EXCEPT_DELETE with %s', (_label, launch) => {
  let browser: Browser;
  let app: RecordingServer;
  let service: RecordingServer;
  let other: RecordingServer;
  const factories: BrowserContextFactory[] = [];

  beforeAll(async () => {
    browser = await launch();
  });

  afterEach(async () => {
    await Promise.all(factories.splice(0).map((factory) => factory.close()));
    await closeTestContexts(browser);
    await Promise.all([app, service, other].filter((site) => site !== undefined).map((site) => site.server.close()));
  });

  afterAll(async () => {
    await browser?.close();
  });

  const startSites = async (): Promise<void> => {
    [app, service, other] = await Promise.all([startRecordingServer(), startRecordingServer(), startRecordingServer()]);
  };

  const configOf = (): AuditConfig => fastRunConfig(app.server.origin, PAGE_PATH);

  /** factory（`auditSend` の指定つき。`undefined` なら指定なし）。 */
  const factoryOf = (auditSend: { readonly maxPassedPerContext?: number; readonly maxWebSocketsPerContext?: number } | undefined): BrowserContextFactory => {
    const factory = new BrowserContextFactory(browser, configOf(), () => new SafetyLedger(), {
      ...TEST_FACTORY_OPTIONS,
      ...(auditSend === undefined
        ? {}
        : {
          auditSend: {
            policy: 'PASS_EXCEPT_DELETE',
            approvedServiceOrigins: [service.server.origin],
            dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS,
            ...auditSend,
          },
        }),
    });
    factories.push(factory);
    return factory;
  };

  /** Passive の Context でページを開く。 */
  const openPage = async (factory: BrowserContextFactory): Promise<{ readonly page: Page; readonly ledger: () => SafetyLedgerSnapshot }> => {
    const context: BrowserContext = await factory.createPassiveContext(configOf().viewports.primaryDesktop);
    const page = await factory.createPassivePage(context);
    await page.goto(`${app.server.origin}${PAGE_PATH}`);
    await page.frameLocator('#child').locator('#frame-form').waitFor({ state: 'attached' });
    return { page, ledger: () => factory.getSafetyLedger(context).snapshot() };
  };

  it('passes fetch, XHR and beacon POST, PUT, PATCH and OPTIONS to the allowed and the approved service Origin, and records them without values', async () => {
    await startSites();
    const factory = factoryOf({});
    const { page, ledger } = await openPage(factory);
    const appUrl = (path: string): string => `${app.server.origin}${path}`;
    expect(await fetchFromPage(page, appUrl('/api/fetch-post?token=secret-value'), 'POST')).toBe(200);
    expect(await xhrFromPage(page, appUrl('/api/xhr-post'), 'POST')).toBe(200);
    expect(await fetchFromPage(page, appUrl('/api/put'), 'PUT')).toBe(200);
    expect(await fetchFromPage(page, appUrl('/api/patch'), 'PATCH')).toBe(200);
    expect(await fetchFromPage(page, appUrl('/api/options'), 'OPTIONS')).toBe(200);
    expect(await beaconFromPage(page, appUrl('/api/beacon'))).toBe(true);
    // サービスの Origin への POST（JSON。CORS の事前確認は Guard が満たし、本番の POST がサーバに届く）。
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
    expect(snapshot.passedAuditSendRequests?.count).toBe(7);
    expect(snapshot.passedAuditSendRequests?.byMethod).toEqual({ POST: 4, PUT: 1, PATCH: 1, OPTIONS: 1 });
    expect(snapshot.passedAuditSendRequests?.requests.map(({ method, origin, path, count }) => `${method} ${origin}${path} ${count}`)).toEqual([
      `POST ${app.server.origin}/api/fetch-post 1`,
      `POST ${app.server.origin}/api/xhr-post 1`,
      `PUT ${app.server.origin}/api/put 1`,
      `PATCH ${app.server.origin}/api/patch 1`,
      `OPTIONS ${app.server.origin}/api/options 1`,
      `POST ${app.server.origin}/api/beacon 1`,
      `POST ${service.server.origin}/api/service-write 1`,
    ]);
    // 値（query の値）は記録しない。
    expect(JSON.stringify(snapshot)).not.toContain('secret-value');
  }, TEST_TIMEOUT_MS);

  it('blocks DELETE, dangerous terms (also to another Origin) and form POSTs of the main frame and an iframe, every round, and they never arrive', async () => {
    await startSites();
    const factory = factoryOf({});
    for (let round = 0; round < BLOCK_ROUNDS; round += 1) {
      const { page, ledger } = await openPage(factory);
      expect(await fetchFromPage(page, `${app.server.origin}/api/item`, 'DELETE')).toBe(0);
      expect(await fetchFromPage(page, `${app.server.origin}/api/item`, 'delete')).toBe(0);
      expect(await fetchFromPage(page, `${app.server.origin}/api/logout`, 'POST')).toBe(0);
      expect(await fetchFromPage(page, `${service.server.origin}/api/remove-member`, 'POST', 'application/json')).toBe(0);
      expect(await fetchFromPage(page, `${app.server.origin}/api/save?action=cancel`, 'PUT')).toBe(0);
      // AS-c: ほかの Origin への DELETE と危険な語の POST も止める（ほかの Origin への送信そのものは通す。下の AS-c の場面）。
      expect(await fetchFromPage(page, `${other.server.origin}/api/other`, 'DELETE')).toBe(0);
      expect(await xhrFromPage(page, `${other.server.origin}/api/other-logout`, 'POST')).toBe(0);
      // iframe のフォームを先に送る（main frame のフォームの送信の後は、iframe がなくなりうる）。
      await page.frameLocator('#child').locator('#frame-form').evaluate((form) => (form as HTMLFormElement).submit());
      await page.evaluate(() => (document.getElementById('main-form') as HTMLFormElement).submit());
      await wait(ARRIVAL_POLL_MS * 4);
      expect(nonReads(app)).toEqual([]);
      expect(nonReads(service)).toEqual([]);
      expect(nonReads(other)).toEqual([]);
      const snapshot = ledger();
      expect(snapshot.invariantViolationCount).toBe(0);
      expect(snapshot.passedAuditSendRequests).toBeUndefined();
      expect(snapshot.blockedRequests.map(({ method, url, reason }) => `${method} ${new URL(url).pathname} ${reason}`).sort()).toEqual([
        'DELETE /api/item NON_READ_METHOD',
        'DELETE /api/item NON_READ_METHOD',
        'DELETE /api/other NON_READ_METHOD',
        'POST /api/logout NON_READ_METHOD',
        'POST /api/other-logout NON_READ_METHOD',
        'POST /api/remove-member NON_READ_METHOD',
        'POST /form-target NON_READ_METHOD',
        'POST /frame-target NON_READ_METHOD',
        'PUT /api/save NON_READ_METHOD',
      ]);
    }
    await wait(LATE_REQUEST_WAIT_MS);
    expect(nonReads(app)).toEqual([]);
    expect(nonReads(service)).toEqual([]);
    expect(nonReads(other)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('blocks the requests over the limit of the load (Context) with AUDIT_SEND_OVER_LIMIT, and a new load counts again', async () => {
    await startSites();
    const factory = factoryOf({ maxPassedPerContext: SMALL_LIMIT });
    for (let round = 0; round < BLOCK_ROUNDS; round += 1) {
      const { page, ledger } = await openPage(factory);
      const statuses: number[] = [];
      for (let index = 0; index < OVER_LIMIT_SENDS; index += 1) {
        statuses.push(await fetchFromPage(page, `${app.server.origin}/api/repeat`, 'POST'));
      }
      expect(statuses).toEqual([200, 200, 0, 0]);
      const expected = Array.from({ length: SMALL_LIMIT * (round + 1) }, () => 'POST /api/repeat');
      await waitForArrivals(app, ['POST /api/repeat']);
      await wait(ARRIVAL_POLL_MS * 4);
      expect(nonReads(app)).toEqual(expected);
      const snapshot = ledger();
      expect(snapshot.invariantViolationCount).toBe(0);
      expect(snapshot.passedAuditSendRequests?.count).toBe(SMALL_LIMIT);
      expect(snapshot.blockedRequests.map(({ method, reason }) => `${method} ${reason}`)).toEqual([
        'POST AUDIT_SEND_OVER_LIMIT',
        'POST AUDIT_SEND_OVER_LIMIT',
      ]);
    }
    await wait(LATE_REQUEST_WAIT_MS);
    expect(nonReads(app)).toEqual(Array.from({ length: SMALL_LIMIT * BLOCK_ROUNDS }, () => 'POST /api/repeat'));
  }, TEST_TIMEOUT_MS);

  it('keeps the Isolated Interaction Context read-only even if the factory has the policy', async () => {
    await startSites();
    const factory = factoryOf({});
    for (let round = 0; round < BLOCK_ROUNDS; round += 1) {
      const session = await factory.createInteractionSession(configOf().viewports.primaryDesktop);
      try {
        await session.page.goto(`${app.server.origin}${PAGE_PATH}`);
        expect(await fetchFromPage(session.page, `${app.server.origin}/api/interaction-before-freeze`, 'POST')).toBe(0);
        expect(await fetchFromPage(session.page, `${service.server.origin}/api/interaction-service`, 'POST')).toBe(0);
        await session.activateInteractionFreeze();
        await session.page.evaluate((target) => {
          void fetch(target, { method: 'POST', body: 'payload' }).catch(() => undefined);
        }, `${app.server.origin}/api/interaction-after-freeze`);
        await wait(ARRIVAL_POLL_MS * 4);
        expect(nonReads(app)).toEqual([]);
        expect(nonReads(service)).toEqual([]);
        const snapshot = session.ledger.snapshot();
        expect(snapshot.invariantViolationCount).toBe(0);
        expect(snapshot.passedAuditSendRequests).toBeUndefined();
      } finally {
        await session.close();
      }
    }
    await wait(LATE_REQUEST_WAIT_MS);
    expect(nonReads(app)).toEqual([]);
    expect(nonReads(service)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // AS-c（設計書 5 章の「ユーザーの言葉と選択（AS-c）」の行）: 送り先の Origin の制限をなくした。ほかの Origin への fetch・XHR の POST は、出口の中継を通って届き、
  // ほかの Origin へ通した数として記録する。
  it('passes the POST of the page to another Origin through the egress relay, and counts it as another Origin', async () => {
    await startSites();
    const factory = factoryOf({});
    const { page, ledger } = await openPage(factory);
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

  // AS-c: WebSocket の接続は、通して形（Origin・path・数）だけを記録する。危険な語の path は今どおり止め、上限を超えた接続は `AUDIT_SEND_OVER_LIMIT` で止める。
  it('passes WebSocket connections (also to another Origin), blocks a dangerous path and the connections over the limit, every round', async () => {
    await startSites();
    const factory = factoryOf({ maxWebSocketsPerContext: SMALL_LIMIT });
    for (let round = 0; round < BLOCK_ROUNDS; round += 1) {
      const since = { app: app.requests.length, other: other.requests.length };
      const { page, ledger } = await openPage(factory);
      expect(await openWebSocketFromPage(page, `${webSocketOriginOf(app.server.origin)}/logout/socket`)).not.toBe('open');
      expect(await openWebSocketFromPage(page, `${webSocketOriginOf(app.server.origin)}/realtime?apikey=secret-value`)).toBe('open');
      expect(await openWebSocketFromPage(page, `${webSocketOriginOf(other.server.origin)}/socket`)).toBe('open');
      expect(await openWebSocketFromPage(page, `${webSocketOriginOf(app.server.origin)}/over-limit`)).not.toBe('open');
      await wait(ARRIVAL_POLL_MS * 4);
      expect(app.requests.slice(since.app).filter((entry) => entry.startsWith('UPGRADE '))).toEqual(['UPGRADE /realtime']);
      expect(other.requests.slice(since.other).filter((entry) => entry.startsWith('UPGRADE '))).toEqual(['UPGRADE /socket']);
      const snapshot = ledger();
      expect(snapshot.invariantViolationCount).toBe(0);
      expect(snapshot.passedAuditSendWebSockets).toEqual({
        count: SMALL_LIMIT,
        connections: [
          { origin: webSocketOriginOf(app.server.origin), path: '/realtime', count: 1 },
          { origin: webSocketOriginOf(other.server.origin), path: '/socket', count: 1 },
        ],
        unlisted: 0,
        // AS-c fix round 1: route を通って開いた接続だけなので、印の数は 0。
        outsideGuard: 0,
        dangerous: 0,
      });
      expect(snapshot.blockedWebSockets.map(({ url, reason }) => `${new URL(url).pathname} ${reason}`)).toEqual([
        '/logout/socket PASSIVE_WEBSOCKET',
        '/over-limit AUDIT_SEND_OVER_LIMIT',
      ]);
      expect(JSON.stringify(snapshot.passedAuditSendWebSockets)).not.toContain('secret-value');
    }
    await wait(LATE_REQUEST_WAIT_MS);
    expect(app.requests.filter((entry) => entry.startsWith('UPGRADE '))).toEqual(Array.from({ length: BLOCK_ROUNDS }, () => 'UPGRADE /realtime'));
    expect(other.requests.filter((entry) => entry.startsWith('UPGRADE '))).toEqual(Array.from({ length: BLOCK_ROUNDS }, () => 'UPGRADE /socket'));
  }, TEST_TIMEOUT_MS);

  // AS-c: Isolated Interaction Context（BeakSight が押す操作）では、factory に指定があっても、WebSocket とほかの Origin への POST は届かない。
  it('keeps blocking WebSockets and POSTs to another Origin in the Isolated Interaction Context', async () => {
    await startSites();
    const factory = factoryOf({});
    for (let round = 0; round < BLOCK_ROUNDS; round += 1) {
      const session = await factory.createInteractionSession(configOf().viewports.primaryDesktop);
      try {
        await session.page.goto(`${app.server.origin}${PAGE_PATH}`);
        expect(await openWebSocketFromPage(session.page, `${webSocketOriginOf(app.server.origin)}/realtime`)).not.toBe('open');
        expect(await fetchFromPage(session.page, `${other.server.origin}/api/interaction-other`, 'POST')).toBe(0);
        await wait(ARRIVAL_POLL_MS * 4);
        expect(nonReads(app)).toEqual([]);
        expect(nonReads(other)).toEqual([]);
        const snapshot = session.ledger.snapshot();
        expect(snapshot.invariantViolationCount).toBe(0);
        expect(snapshot.passedAuditSendWebSockets).toBeUndefined();
        expect(snapshot.passedAuditSendRequests).toBeUndefined();
      } finally {
        await session.close();
      }
    }
    await wait(LATE_REQUEST_WAIT_MS);
    expect(nonReads(app)).toEqual([]);
    expect(nonReads(other)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('keeps the default (no policy) read-only for the same requests', async () => {
    await startSites();
    const factory = factoryOf(undefined);
    const { page, ledger } = await openPage(factory);
    expect(await fetchFromPage(page, `${app.server.origin}/api/fetch-post`, 'POST')).toBe(0);
    expect(await fetchFromPage(page, `${service.server.origin}/api/service-write`, 'POST', 'application/json')).toBe(0);
    expect(await beaconFromPage(page, `${app.server.origin}/api/beacon`)).toBe(true);
    // AS-c: 既定では、ほかの Origin への POST と WebSocket の接続も、今どおり届かない。
    expect(await fetchFromPage(page, `${other.server.origin}/api/other`, 'POST')).toBe(0);
    expect(await openWebSocketFromPage(page, `${webSocketOriginOf(app.server.origin)}/realtime`)).not.toBe('open');
    await wait(LATE_REQUEST_WAIT_MS);
    expect(nonReads(app)).toEqual([]);
    expect(nonReads(service)).toEqual([]);
    expect(nonReads(other)).toEqual([]);
    const snapshot = ledger();
    expect(snapshot.invariantViolationCount).toBe(0);
    expect(snapshot.passedAuditSendRequests).toBeUndefined();
    expect(snapshot.passedAuditSendWebSockets).toBeUndefined();
    expect(snapshot.blockedWebSockets.map(({ reason }) => reason)).toEqual(['PASSIVE_WEBSOCKET']);
  }, TEST_TIMEOUT_MS);
});
