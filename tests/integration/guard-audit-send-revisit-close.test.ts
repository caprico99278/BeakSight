// T44b（設計書 `doc/design/2026-10-21-beaksight-task-44-efficiency-precision-usability-design.md` の P1-1・P1-2）: 監査の段の送信の扱い
// `PASS_EXCEPT_DELETE` の残り。通す部品は本物（`BrowserContextFactory` と、その Guard と出口の中継）。Chromium はテストの既定の headless と、CLI の起動の
// 設定の両方。サイトは 127.0.0.1 の自前のサーバ（アプリ = 許可 Origin、サービス = 承認したサービスの Origin）。届いたかは、サーバの記録で数える。
// - P1-1: 幅の走査の Context（役割 `REVISIT`）でも、`PASS_EXCEPT_DELETE` なら、サービスの Origin への読み取り（iframe の文書、画像、fetch、Worker の fetch）と、
//   ページが出す送信（POST）が、最初の読み込みと同じく届く。サービスの Origin への要求は上限の部品（`service-request-budget`）で数え、届いた数は `perRun` を
//   超えない。`DELETE` と危険な語の送信は今どおり届かない。Run のキャッシュの有無によらない。Isolated Interaction Context は今どおり何も送らない。
//   既定（`READ_ONLY`）の幅の走査が送らないことは `guard-audit-stage-revisit.test.ts` が確かめる。
// - P1-2（設計の変更の履歴の「T44b の報告」の行）: `PASS_EXCEPT_DELETE` の最初の読み込みの Context（`PRIMARY`）は、持ち主が閉じるときに、認証の状態を
//   読み、ページを離れ（about:blank）、名前つきの短い時間（`AUDIT_SEND_CLOSE_SETTLE_MS`）だけ待ってから閉じる。ページを離れるときの送信（`pagehide`・
//   `visibilitychange`・`unload` の beacon と keepalive の fetch。普通の path）は届き、通した要求として記録される。`DELETE` と危険な語は届かない。閉じた後の
//   送信は届かない。about:blank への移動は、読み込みの間隔（pacer）とページの移動の数（DEF-129）に数えない。認証の状態は、ページを離れる前に読む（離れる
//   ときにページが消す値も、次の Context に渡る）。幅の走査の Context（`REVISIT`）と既定（`READ_ONLY`）は、待たずにページも離れず、何も届かない。止めるべき
//   要求は、回ごとにサーバの記録で数え、全部の回の後に名前つきの時間だけ待ってから数え直す。
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import { AUDIT_SEND_CLOSE_SETTLE_MS, BrowserContextFactory, type AuditStageServiceRequests } from '../../src/browser/context-factory.js';
import { ResourceCache, type ResourceDeliveryRole } from '../../src/browser/resource-delivery.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { createServiceRequestBudget } from '../../src/crawl/service-request-budget.js';
import {
  AuditStageMonitor,
  PAGE_LEAVE_REQUEST_LIMIT,
  PAGE_SUBRESOURCE_REQUEST_LIMIT,
  isPageLoadLimitReached,
  pageLoadFactsOf,
} from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { BROWSER_DEFAULT_FAVICON_PATH, launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { fastRunConfig } from '../helpers/run-harness.js';
import { TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

const LAUNCHERS: readonly (readonly [string, () => Promise<Browser>])[] = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI Chromium', () => launchCliChromium()],
];
const TEST_TIMEOUT_MS = 120_000;
const PAGE_TIMEOUT_MS = 30_000;
/** ページの要求の後に、遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 1_500;
/** 止めるべき要求を確かめる回の数（回ごとに新しい Context で読み込む）。 */
const ROUNDS = 2;
/** ページが作る、サービスの Origin の iframe の数。 */
const IFRAME_COUNT = 3;
const SMALL_PER_RUN = 3;
const DEFAULT_LIMITS = Object.freeze({ perMinute: 120, perRun: 600 });
const ADMIN_PATH = '/admin/s';
const WORKER_PATH = '/admin/worker.js';
/** P1-2: 閉じた後に出ようとする送信の時間（ms。読み込みから、待つ時間の後）。 */
const AFTER_CLOSE_SEND_DELAY_MS = AUDIT_SEND_CLOSE_SETTLE_MS + 1_500;
/** P1-2: ページが読み込みで localStorage に置き、離れるとき（`pagehide`）に消す値の名前（認証の状態をページを離れる前に読むかの確かめ）。 */
const STATE_KEY = 'beaksight-t44b-state';
/** P1-2: ページを離れるときに届くべき送信（並べ替えた形）。 */
const LEAVING_SENDS = Object.freeze([
  'POST /api/pagehide-beacon',
  'POST /api/pagehide-keepalive',
  'POST /api/unload-beacon',
  'POST /api/visibility-beacon',
]);
const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;

const WORKER_SOURCE = `onmessage = async (event) => { try { postMessage((await fetch(event.data)).status); } catch (error) { postMessage('err'); } };`;
const PAGE_HTML = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>管理</title></head><body><p>管理</p></body></html>';
/**
 * P1-2 のページ: 離れるときに、`pagehide` で beacon・keepalive の fetch（普通の path）と `DELETE` を、`visibilitychange`（hidden）で beacon と危険な語の beacon を、
 * `unload` で beacon を出す。読み込みで localStorage に値を置き、`pagehide` で消す。`AFTER_CLOSE_SEND_DELAY_MS` で、もう一度送ろうとする（閉じた後の送信）。
 */
const CLOSING_PAGE_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>閉じる</title></head><body><p>閉じる</p><script>
localStorage.setItem('${STATE_KEY}', 'kept');
addEventListener('pagehide', () => {
  localStorage.removeItem('${STATE_KEY}');
  navigator.sendBeacon('/api/pagehide-beacon', 'a');
  fetch('/api/pagehide-keepalive', { method: 'POST', body: 'b', keepalive: true }).catch(() => undefined);
  fetch('/api/pagehide-delete', { method: 'DELETE', keepalive: true }).catch(() => undefined);
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    navigator.sendBeacon('/api/visibility-beacon', 'c');
    navigator.sendBeacon('/api/logout', 'c');
  }
});
addEventListener('unload', () => { navigator.sendBeacon('/api/unload-beacon', 'e'); });
setTimeout(() => { navigator.sendBeacon('/api/after-close-beacon', 'd'); }, ${String(AFTER_CLOSE_SEND_DELAY_MS)});
</script></body></html>`;
const CLOSING_PAGE_PATH = '/admin/closing';
/** P1-2（DEF-130 の上限）: ページを離れるとき（`pagehide`）に beacon を 1 つ出すページ（アイコンの要求を出さない）。 */
const LIMIT_PAGE_PATH = '/admin/limit';
const LIMIT_PAGE_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>上限</title></head><body><p>上限</p><script>
addEventListener('pagehide', () => { navigator.sendBeacon('/api/limit-leave-beacon', 'a'); });
</script></body></html>`;

/**
 * T44R の I-1（Task 44 の設計書の履歴の「T44R …と設計者の判断」の行）: ページを離れた後の要求と文書の読み込みのページ（独立レビューの leave.exp.ts の A と C2）。
 * - A（`/admin/flood`）: 離れるとき（`pagehide`）に、keepalive の GET・普通の GET・beacon・画像を大量に出す（`/api/leave-*`）。
 * - C2（`/admin/popup2-opener`）: 空のポップアップを開いてから中身を書き、ポップアップが、離れた後の opener を元の Origin の画面（`/admin/return`）へ戻す。
 */
const FLOOD_PAGE_PATH = '/admin/flood';
const LEAVE_REQUEST_PATH_PREFIX = '/api/leave-';
const POPUP_OPENER_PAGE_PATH = '/admin/popup2-opener';
const POPUP_PAGE_PATH = '/admin/popup';
const RETURN_PAGE_PATH = '/admin/return';
const LEAVE_PAGES: Readonly<Record<string, string>> = Object.freeze({
  [FLOOD_PAGE_PATH]: `addEventListener('pagehide', () => {
  for (let i = 0; i < 400; i += 1) fetch('${LEAVE_REQUEST_PATH_PREFIX}ka?i=' + i, { keepalive: true }).catch(() => 0);
  for (let i = 0; i < 400; i += 1) fetch('${LEAVE_REQUEST_PATH_PREFIX}plain?i=' + i).catch(() => 0);
  for (let i = 0; i < 100; i += 1) navigator.sendBeacon('${LEAVE_REQUEST_PATH_PREFIX}beacon?i=' + i, 'b');
  for (let i = 0; i < 100; i += 1) { const image = new Image(); image.src = '${LEAVE_REQUEST_PATH_PREFIX}img?i=' + i; }
});`,
  [POPUP_OPENER_PAGE_PATH]: `const w = window.open('', 'pp2');
setTimeout(() => { try { w.location.href = location.origin + '${POPUP_PAGE_PATH}'; } catch (e) {} }, 200);`,
  [POPUP_PAGE_PATH]: `const timer = setInterval(() => {
  let blank = false;
  try { blank = opener.location.href === 'about:blank'; } catch (e) { blank = true; }
  if (blank) { clearInterval(timer); try { opener.location.href = location.origin + '${RETURN_PAGE_PATH}'; } catch (e) {} }
}, 20);`,
  [RETURN_PAGE_PATH]: `for (let i = 0; i < 50; i += 1) fetch('/api/return-get?i=' + i).catch(() => 0);
navigator.sendBeacon('/api/return-loaded', 'a');`,
});
const leavePageHtml = (script: string): string =>
  `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>t</title></head><body><p>t</p><script>${script}</script></body></html>`;

interface ServerRecord {
  readonly server: 'app' | 'service';
  readonly method: string;
  readonly path: string;
  readonly preflight: boolean;
}

/** ページの中で、サービスの Origin へ要求を出す（iframe の文書、画像、fetch、Worker の fetch、POST、止めるべき DELETE と危険な語の POST）。 */
const requestsSource = (service: string): string => `(async () => {
  for (let index = 0; index < ${String(IFRAME_COUNT)}; index += 1) {
    const frame = document.createElement('iframe'); frame.src = '${service}/frame' + index + '.html'; document.body.appendChild(frame);
  }
  const image = new Image(); image.src = '${service}/image.png'; document.body.appendChild(image);
  const fetched = await fetch('${service}/rest/v1/members').then((response) => response.status, () => 'err');
  const posted = await fetch('${service}/rest/v1/rpc/sync_state', { method: 'POST', body: 'x' }).then((response) => response.status, () => 'err');
  const deleted = await fetch('${service}/rest/v1/members?id=1', { method: 'DELETE' }).then((response) => response.status, () => 'err');
  const loggedOut = await fetch('${service}/auth/v1/logout', { method: 'POST', body: 'x' }).then((response) => response.status, () => 'err');
  const worker = new Worker('${WORKER_PATH}');
  const fromWorker = await new Promise((resolveWorker) => {
    worker.onmessage = (event) => resolveWorker(event.data);
    worker.onerror = () => resolveWorker('worker error');
    worker.postMessage('${service}/rest/v1/from-worker');
    setTimeout(() => resolveWorker('worker timeout'), 5000);
  });
  return { fetched, posted, deleted, loggedOut, fromWorker };
})()`;

describe.each(LAUNCHERS)('T44b: the audit send policy PASS_EXCEPT_DELETE on the width scan and at the Context close with %s', (_label, launch) => {
  let browser: Browser;
  let app: LoopbackHttpServer;
  let service: LoopbackHttpServer;
  const records: ServerRecord[] = [];

  const listenerOf = (server: ServerRecord['server']) => (request: IncomingMessage, response: ServerResponse): void => {
    request.on('data', () => undefined);
    request.on('end', () => {
      const method = request.method ?? 'GET';
      const preflight = method === 'OPTIONS' && request.headers['access-control-request-method'] !== undefined;
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== BROWSER_DEFAULT_FAVICON_PATH) {
        records.push({ server, method, path: url.pathname, preflight });
      }
      const cors = {
        'access-control-allow-origin': typeof request.headers.origin === 'string' ? request.headers.origin : '*',
        'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
      };
      if (method === 'OPTIONS') {
        response.writeHead(HTTP_NO_CONTENT, cors).end();
      } else if (url.pathname === WORKER_PATH) {
        response.writeHead(HTTP_OK, { 'content-type': 'text/javascript' }).end(WORKER_SOURCE);
      } else if (url.pathname === CLOSING_PAGE_PATH) {
        response.writeHead(HTTP_OK, { 'content-type': 'text/html; charset=utf-8' }).end(CLOSING_PAGE_HTML);
      } else if (url.pathname === LIMIT_PAGE_PATH) {
        response.writeHead(HTTP_OK, { 'content-type': 'text/html; charset=utf-8' }).end(LIMIT_PAGE_HTML);
      } else if (LEAVE_PAGES[url.pathname] !== undefined) {
        response.writeHead(HTTP_OK, { 'content-type': 'text/html; charset=utf-8' }).end(leavePageHtml(LEAVE_PAGES[url.pathname] ?? ''));
      } else if (url.pathname.endsWith('.html') || url.pathname === ADMIN_PATH) {
        response.writeHead(HTTP_OK, { ...cors, 'content-type': 'text/html; charset=utf-8' }).end(PAGE_HTML);
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

  const configOf = () => {
    const base = fastRunConfig(app.origin, ADMIN_PATH);
    return { ...base, site: { startUrl: `${app.origin}${ADMIN_PATH}`, allowedOrigins: [app.origin] } };
  };

  /** 認証つきの factory（スクリプトで送るログインの監査の段の口と、上限の部品）。`auditSend` が真なら `PASS_EXCEPT_DELETE` の指定も渡す。 */
  const authenticatedFactoryOf = (options: { readonly withCache: boolean; readonly perRun: number; readonly auditSend: boolean }) => {
    const limits = { perMinute: DEFAULT_LIMITS.perMinute, perRun: options.perRun };
    const budget = createServiceRequestBudget({ ...limits, now: () => Date.now() });
    const auditStage: AuditStageServiceRequests = {
      approvedServiceOrigins: [service.origin],
      auditReadRequests: [],
      scriptLogin: { origin: service.origin, path: '/auth/v1/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] },
      serviceRequestLimits: limits,
    };
    const factory = new BrowserContextFactory(browser, configOf(), () => new SafetyLedger(), {
      ...TEST_FACTORY_OPTIONS,
      ...(options.withCache ? { resourceCache: new ResourceCache() } : {}),
      authentication: {
        initialState: { cookies: [], origins: [] },
        filterState: (state) => state,
        auditExclusions: { excludedPathPrefixes: ['/logout'], auditPathPrefixes: ['/admin'], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
        auditStage,
      },
      serviceRequestBudget: budget,
      auditStageMonitor: new AuditStageMonitor(),
      ...(options.auditSend
        ? { auditSend: { policy: 'PASS_EXCEPT_DELETE' as const, approvedServiceOrigins: [service.origin], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS } }
        : {}),
    });
    return { factory, budget };
  };

  const serviceArrivals = (start: number): readonly string[] =>
    records.slice(start).filter(({ server, preflight }) => server === 'service' && !preflight).map(({ method, path }) => `${method} ${path}`);

  /** 幅の走査の Context（`REVISIT`）でページを開き、サービスの Origin へ要求を出す。届いた要求と Safety Ledger の記録を返す。 */
  const runRevisit = async (options: { readonly withCache: boolean; readonly perRun: number }) => {
    const { factory, budget } = authenticatedFactoryOf({ ...options, auditSend: true });
    const start = records.length;
    try {
      const config = configOf();
      const context = await factory.createPassiveContext(config.viewports.primaryDesktop, 'REVISIT');
      const page = await factory.createPassivePage(context);
      await page.goto(`${app.origin}${ADMIN_PATH}`, { timeout: PAGE_TIMEOUT_MS });
      const outcome = await page.evaluate(requestsSource(service.origin)) as Record<string, unknown>;
      await wait(LATE_REQUEST_WAIT_MS);
      const ledger = factory.getSafetyLedger(context).snapshot();
      return {
        outcome,
        arrivedAtService: serviceArrivals(start),
        blockedRequests: ledger.blockedRequests.map(({ method, url, reason }) => `${method} ${new URL(url).pathname} ${reason}`),
        passed: ledger.passedAuditSendRequests?.requests.map(({ method, path }) => `${method} ${path}`) ?? [],
        violations: ledger.invariantViolations,
        budget: budget.snapshot(),
      };
    } finally {
      await factory.close();
    }
  };

  it.each([true, false])('P1-1: sends the service origin reads and the page POST on a REVISIT context, and blocks DELETE and a dangerous term (with the Run cache: %s)', async (withCache) => {
    const expectedReads = [
      ...Array.from({ length: IFRAME_COUNT }, (_unused, index) => `GET /frame${String(index)}.html`),
      'GET /image.png',
      'GET /rest/v1/members',
      'GET /rest/v1/from-worker',
    ];
    for (let round = 0; round < ROUNDS; round += 1) {
      const result = await runRevisit({ withCache, perRun: DEFAULT_LIMITS.perRun });
      expect(result.violations).toEqual([]);
      expect([...result.arrivedAtService].sort()).toEqual([...expectedReads, 'POST /rest/v1/rpc/sync_state'].sort());
      expect(result.outcome).toMatchObject({ fetched: HTTP_OK, posted: HTTP_OK, fromWorker: HTTP_OK });
      expect(result.blockedRequests).not.toContain(expect.stringContaining('SERVICE_ORIGIN_REVISIT'));
      expect(result.blockedRequests).toEqual(expect.arrayContaining([
        'DELETE /rest/v1/members NON_READ_METHOD',
        'POST /auth/v1/logout NON_READ_METHOD',
      ]));
      expect(result.passed).toEqual(['POST /rest/v1/rpc/sync_state']);
      // サービスの Origin への要求は、上限の部品で数える（届いた読み取りと POST の数以上）。
      expect(result.budget.admitted).toBeGreaterThanOrEqual(expectedReads.length + 1);
    }
    const start = records.length;
    await wait(LATE_REQUEST_WAIT_MS);
    expect(serviceArrivals(start)).toEqual([]);
    expect(records.filter(({ server, method }) => server === 'service' && method === 'DELETE')).toEqual([]);
    expect(records.filter(({ server, path }) => server === 'service' && path === '/auth/v1/logout')).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('P1-1: counts the service origin requests of a REVISIT context with the budget, and the arrivals stay within perRun', async () => {
    const result = await runRevisit({ withCache: true, perRun: SMALL_PER_RUN });
    expect(result.violations).toEqual([]);
    expect(result.arrivedAtService.length).toBeLessThanOrEqual(SMALL_PER_RUN);
    expect(result.budget.admitted).toBe(SMALL_PER_RUN);
    expect(result.budget.refused).toBeGreaterThan(0);
    expect(result.blockedRequests).toEqual(expect.arrayContaining([expect.stringContaining('SERVICE_REQUEST_LIMIT_REACHED')]));
  }, TEST_TIMEOUT_MS);

  it('P1-1: keeps the Isolated Interaction Context sending nothing to the service origin even with PASS_EXCEPT_DELETE', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { factory } = authenticatedFactoryOf({ withCache: true, perRun: DEFAULT_LIMITS.perRun, auditSend: true });
      const start = records.length;
      try {
        const session = await factory.createInteractionSession(configOf().viewports.primaryDesktop);
        try {
          await session.page.goto(`${app.origin}${ADMIN_PATH}`, { timeout: PAGE_TIMEOUT_MS });
          await session.page.evaluate(requestsSource(service.origin));
          await wait(LATE_REQUEST_WAIT_MS);
          expect(serviceArrivals(start)).toEqual([]);
          expect(session.ledger.snapshot().invariantViolations).toEqual([]);
          expect(session.ledger.snapshot().passedAuditSendRequests).toBeUndefined();
        } finally {
          await session.close();
        }
      } finally {
        await factory.close();
      }
    }
  }, TEST_TIMEOUT_MS);

  /**
   * P1-2: Passive の Context（役割 `role`）で閉じるページを開き、すぐに持ち主が閉じる。認証つきの factory（localStorage を受け継ぐ）で、読み込みの間隔の部品
   * の記録の数を数える。閉じた後、同じ factory の次の Context で、受け継いだ値を読む。閉じるのにかかった時間、アプリに届いた読み取りでない要求、記録、
   * 読み込みの間隔の部品に記録した数（閉じる前と後）、ページの文書の要求の数（DEF-129）、受け継いだ値を返す。
   */
  const openAndClose = async (auditSend: boolean, role: ResourceDeliveryRole = 'PRIMARY', pageAuditLoad = true) => {
    let documentRequestsSent = 0;
    const config = fastRunConfig(app.origin, CLOSING_PAGE_PATH);
    const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), {
      ...TEST_FACTORY_OPTIONS,
      authentication: {
        initialState: { cookies: [], origins: [] },
        filterState: (state) => state,
        auditExclusions: { excludedPathPrefixes: [], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
      },
      navigationPacer: { recordDocumentRequestSent: (): void => { documentRequestsSent += 1; } },
      ...(auditSend
        ? { auditSend: { policy: 'PASS_EXCEPT_DELETE' as const, approvedServiceOrigins: [service.origin], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS } }
        : {}),
    });
    const start = records.length;
    try {
      // ページの監査の読み込み（Desktop と Mobile）の印は、ページの監査の読み込みの作り手だけが付ける（robots.txt などの PRIMARY の Context は付けない）。
      const context = await factory.createPassiveContext(config.viewports.primaryDesktop, role, pageAuditLoad ? { pageAuditLoad: true } : {});
      const page = await factory.createPassivePage(context);
      await page.goto(`${app.origin}${CLOSING_PAGE_PATH}`, { timeout: PAGE_TIMEOUT_MS });
      const pacerBeforeClose = documentRequestsSent;
      const closeStartedAt = Date.now();
      await factory.closePassiveContext(context);
      const closeMs = Date.now() - closeStartedAt;
      const pacerAfterClose = documentRequestsSent;
      const pageLoad = pageLoadFactsOf(page);
      await wait(LATE_REQUEST_WAIT_MS);
      const ledger = factory.getSafetyLedger(context).snapshot();
      const arrived = records.slice(start).filter(({ server, method }) => server === 'app' && method !== 'GET').map(({ method, path }) => `${method} ${path}`);
      // 受け継いだ状態（次の Context の、同じ Origin の localStorage）。読む前にサイトの記録を数え終えておく。
      const next = await factory.createPassiveContext(config.viewports.primaryDesktop, 'REVISIT');
      const nextPage = await factory.createPassivePage(next);
      await nextPage.goto(`${app.origin}${ADMIN_PATH}`, { timeout: PAGE_TIMEOUT_MS });
      const inherited = await nextPage.evaluate((key) => localStorage.getItem(key), STATE_KEY);
      await factory.closePassiveContext(next);
      return {
        closeMs,
        arrived,
        passed: ledger.passedAuditSendRequests?.requests.map(({ method, path }) => `${method} ${path}`) ?? [],
        blockedRequests: ledger.blockedRequests.map(({ method, url, reason }) => `${method} ${new URL(url).pathname} ${reason}`),
        violations: ledger.invariantViolations,
        pacerBeforeClose,
        pacerAfterClose,
        pageLoad,
        inherited,
      };
    } finally {
      await factory.close();
    }
  };

  it('P1-2: on a PRIMARY context, reads the state, leaves the page and waits before closing; the leaving beacons and keepalive fetch arrive and are recorded, DELETE, a dangerous term and the sends after the close never arrive', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const result = await openAndClose(true);
      expect(result.violations).toEqual([]);
      expect([...result.arrived].sort()).toEqual(LEAVING_SENDS);
      expect([...result.passed].sort()).toEqual(LEAVING_SENDS);
      expect([...result.blockedRequests].sort()).toEqual(['DELETE /api/pagehide-delete NON_READ_METHOD', 'POST /api/logout NON_READ_METHOD']);
      // about:blank への移動は、読み込みの間隔の部品にもページの文書の要求の数（DEF-129）にも数えない。
      expect(result.pacerAfterClose).toBe(result.pacerBeforeClose);
      expect(result.pageLoad).toMatchObject({ documentRequests: 1, limitReached: false });
      // 認証の状態は、ページを離れる前（`pagehide` が値を消す前）に読む。
      expect(result.inherited).toBe('kept');
      // 待つのは 1 回の閉じ方あたり名前つきの時間まで（閉じる処理そのものの時間の余裕を足した上限）。
      expect(result.closeMs).toBeGreaterThanOrEqual(AUDIT_SEND_CLOSE_SETTLE_MS - 50);
      expect(result.closeMs).toBeLessThan(AUDIT_SEND_CLOSE_SETTLE_MS + 10_000);
    }
    const start = records.length;
    await wait(AFTER_CLOSE_SEND_DELAY_MS);
    expect(records.slice(start).filter(({ method }) => method !== 'GET')).toEqual([]);
    expect(records.filter(({ path }) => ['/api/after-close-beacon', '/api/pagehide-delete', '/api/logout'].includes(path))).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it.each<readonly [string, boolean, ResourceDeliveryRole, boolean]>([
    ['the width scan (REVISIT) with PASS_EXCEPT_DELETE', true, 'REVISIT', true],
    ['a PRIMARY context that is not a page audit load (robots.txt and the like) with PASS_EXCEPT_DELETE', true, 'PRIMARY', false],
    ['the default (READ_ONLY) PRIMARY', false, 'PRIMARY', true],
  ])('P1-2: closes %s without the wait or leaving the page, and nothing of the page arrives', async (_name, auditSend, role, pageAuditLoad) => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const result = await openAndClose(auditSend, role, pageAuditLoad);
      expect(result.violations).toEqual([]);
      expect(result.arrived).toEqual([]);
      expect(result.passed).toEqual([]);
      expect(result.inherited).toBe('kept');
    }
    const start = records.length;
    await wait(AFTER_CLOSE_SEND_DELAY_MS);
    expect(records.slice(start).filter(({ method }) => method !== 'GET')).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // P1-2（設計者の判断の (2)）: ページを離れるときに通した送信は、そのページの読み取りの判定に使う数（DEF-130 の文書でない要求の数と上限）に入れない
  // （読み取りの判定は、ページを離れる前に終わっている）。通した送信の記録には、今どおり残す。上限ちょうどのページで確かめる。
  it('P1-2: does not count the leaving sends into the page subresource limit (DEF-130), so a page at the limit is not judged unread', async () => {
    const config = fastRunConfig(app.origin, LIMIT_PAGE_PATH);
    const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), {
      ...TEST_FACTORY_OPTIONS,
      auditSend: { policy: 'PASS_EXCEPT_DELETE', approvedServiceOrigins: [service.origin], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
    });
    const start = records.length;
    try {
      const context = await factory.createPassiveContext(config.viewports.primaryDesktop, 'PRIMARY', { pageAuditLoad: true });
      const page = await factory.createPassivePage(context);
      await page.goto(`${app.origin}${LIMIT_PAGE_PATH}`, { timeout: PAGE_TIMEOUT_MS });
      // 文書でない要求の数を、上限ちょうどまで足す（ページが出す GET。読み込みの後に数を読んでから足す）。
      const loaded = pageLoadFactsOf(page)?.subresourceRequests ?? 0;
      await page.evaluate(async (count) => {
        await Promise.all(Array.from({ length: count }, (_unused, index) =>
          fetch(`/api/fill?i=${String(index)}`).then((response) => response.text(), () => undefined)));
      }, PAGE_SUBRESOURCE_REQUEST_LIMIT - loaded);
      expect(pageLoadFactsOf(page)).toMatchObject({ subresourceRequests: PAGE_SUBRESOURCE_REQUEST_LIMIT, subresourceLimitReached: false });
      await factory.closePassiveContext(context);
      await wait(LATE_REQUEST_WAIT_MS);
      const facts = pageLoadFactsOf(page);
      expect(facts).toMatchObject({ subresourceRequests: PAGE_SUBRESOURCE_REQUEST_LIMIT, subresourceLimitReached: false });
      expect(facts === null ? true : isPageLoadLimitReached(facts)).toBe(false);
      const ledger = factory.getSafetyLedger(context).snapshot();
      expect(ledger.invariantViolations).toEqual([]);
      expect(ledger.blockedRequests.map(({ reason }) => reason)).not.toContain('PAGE_SUBRESOURCE_LIMIT_REACHED');
      expect(ledger.passedAuditSendRequests?.requests.map(({ method, path }) => `${method} ${path}`)).toEqual(['POST /api/limit-leave-beacon']);
      expect(records.slice(start).filter(({ method }) => method !== 'GET').map(({ method, path }) => `${method} ${path}`))
        .toEqual(['POST /api/limit-leave-beacon']);
    } finally {
      await factory.close();
    }
  }, TEST_TIMEOUT_MS);

  /** T44R の I-1: `PASS_EXCEPT_DELETE` のページの監査の読み込みでページを開いて閉じる。届いた要求、記録、ページの読み込みの事実を返す。 */
  const openAndCloseLeavePage = async (path: string, beforeClose?: (page: import('playwright').Page) => Promise<void>) => {
    const config = fastRunConfig(app.origin, path);
    const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), {
      ...TEST_FACTORY_OPTIONS,
      auditSend: { policy: 'PASS_EXCEPT_DELETE', approvedServiceOrigins: [service.origin], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
    });
    const start = records.length;
    try {
      const context = await factory.createPassiveContext(config.viewports.primaryDesktop, 'PRIMARY', { pageAuditLoad: true });
      const page = await factory.createPassivePage(context);
      await page.goto(`${app.origin}${path}`, { timeout: PAGE_TIMEOUT_MS });
      await wait(LATE_REQUEST_WAIT_MS);
      await beforeClose?.(page);
      const beforeLeave = records.length;
      let closeFailure: string | null = null;
      try {
        await factory.closePassiveContext(context);
      } catch (error) {
        closeFailure = String(error);
      }
      await wait(LATE_REQUEST_WAIT_MS);
      const ledger = factory.getSafetyLedger(context).snapshot();
      return {
        closeFailure,
        all: records.slice(start),
        afterLeave: records.slice(beforeLeave),
        facts: pageLoadFactsOf(page),
        blockedReasons: ledger.blockedRequests.map(({ reason }) => reason),
        violations: ledger.invariantViolations,
      };
    } finally {
      await factory.close();
    }
  };

  // T44R の I-1（A）: 上限ちょうどのページが、離れるときに大量の要求を出しても、離れた後の要求は名前つきの小さな上限（1 回の離れ方あたり）で止まり、
  // そのページの読み取りの判定（DEF-130 の数と上限の印）は変わらない。
  it('I-1 A: stops the leaving requests over the named small limit per leave, and keeps the read judgment of the page', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const result = await openAndCloseLeavePage(FLOOD_PAGE_PATH, async (page) => {
        const loaded = pageLoadFactsOf(page)?.subresourceRequests ?? 0;
        await page.evaluate(async (count) => {
          await Promise.all(Array.from({ length: count }, (_unused, index) =>
            fetch(`/api/fill?i=${String(index)}`).then((response) => response.text(), () => undefined)));
        }, PAGE_SUBRESOURCE_REQUEST_LIMIT - loaded);
      });
      expect(result.violations).toEqual([]);
      expect(result.closeFailure).toBeNull();
      const leaving = result.afterLeave.filter(({ path }) => path.startsWith(LEAVE_REQUEST_PATH_PREFIX));
      expect(leaving.length).toBeGreaterThan(0);
      expect(leaving.length).toBeLessThanOrEqual(PAGE_LEAVE_REQUEST_LIMIT);
      expect(result.blockedReasons).toContain('PAGE_LEAVE_REQUEST_LIMIT_REACHED');
      expect(result.facts).toMatchObject({ subresourceRequests: PAGE_SUBRESOURCE_REQUEST_LIMIT, subresourceLimitReached: false });
    }
    const start = records.length;
    await wait(LATE_REQUEST_WAIT_MS);
    expect(records.slice(start).filter(({ path }) => path.startsWith(LEAVE_REQUEST_PATH_PREFIX))).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // T44R の I-1（C2）: 離れた後に、ポップアップが opener を元の Origin の画面へ戻そうとしても、その文書の読み込みは止まり、戻った画面の要求は出ない。
  it('I-1 C2: blocks the main frame document load of the page after it left (a popup navigating the opener back)', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const result = await openAndCloseLeavePage(POPUP_OPENER_PAGE_PATH);
      expect(result.violations).toEqual([]);
      expect(result.closeFailure).toBeNull();
      expect(result.all.filter(({ path }) => path === POPUP_PAGE_PATH).length).toBeGreaterThan(0);
      expect(result.all.filter(({ path }) => path === RETURN_PAGE_PATH || path.startsWith('/api/return-'))).toEqual([]);
      expect(result.blockedReasons).toContain('PAGE_LEAVE_REQUEST_LIMIT_REACHED');
    }
    const start = records.length;
    await wait(LATE_REQUEST_WAIT_MS);
    expect(records.slice(start).filter(({ path }) => path === RETURN_PAGE_PATH || path.startsWith('/api/return-'))).toEqual([]);
  }, TEST_TIMEOUT_MS);
});
