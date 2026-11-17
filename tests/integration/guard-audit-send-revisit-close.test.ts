// T44b（設計書 `doc/design/2026-10-21-beaksight-task-44-efficiency-precision-usability-design.md` の P1-1・P1-2）: 監査の段の送信の扱い
// `PASS_EXCEPT_DELETE` の残り。通す部品は本物（`BrowserContextFactory` と、その Guard と出口の中継）。Chromium はテストの既定の headless と、CLI の起動の
// 設定の両方。サイトは 127.0.0.1 の自前のサーバ（アプリ = 許可 Origin、サービス = 承認したサービスの Origin）。届いたかは、サーバの記録で数える。
// - P1-1: 幅の走査の Context（役割 `REVISIT`）でも、`PASS_EXCEPT_DELETE` なら、サービスの Origin への読み取り（iframe の文書、画像、fetch、Worker の fetch）と、
//   ページが出す送信（POST）が、最初の読み込みと同じく届く。サービスの Origin への要求は数える部品（`service-request-budget`）で数える。SD-2（設計書
//   `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.4）: `DELETE` と危険な語の送信も届く（Run のキャッシュの有無は Guard の判定に関係しないので、
//   本番と同じキャッシュありの 1 通りで確かめる）。Isolated Interaction Context は今どおり何も送らない。既定（`READ_ONLY`）の幅の走査が送らないことは
//   `guard-audit-stage.test.ts` の T35R-fix が確かめる。
// - P1-2（設計の変更の履歴の「T44b の報告」の行）: `PASS_EXCEPT_DELETE` の Context は、持ち主が閉じるときに、認証の状態を
//   読み、ページを離れ（about:blank）、名前つきの短い時間（`AUDIT_SEND_CLOSE_SETTLE_MS`）だけ待ってから閉じる。ページを離れるときの送信（`pagehide`・
//   `visibilitychange`・`unload` の beacon と keepalive の fetch。SD-2: `DELETE` と危険な語も）は届き、通した要求として記録される。閉じた後の
//   送信は届かない。about:blank への移動は、読み込みの間隔（pacer）とページの移動の数（DEF-129）に数えない。認証の状態は、ページを離れる前に読む（離れる
//   ときにページが消す値も、次の Context に渡る）。SD-2: 幅の走査の Context（`REVISIT`）と印のない `PRIMARY` も離れる。既定（`READ_ONLY`）は、待たずにページも
//   離れず、何も届かない。止めるべき
//   要求は、回ごとにサーバの記録で数え、Context を閉じた後はサーバの受けている途中の要求がなくなるまで待って（`settleLateDeliveries`）数え直す。開いたままの
//   ページは、判定が揃う（届くべき要求が届く）まで poll する。
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
  pageLoadFactsOf,
} from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { BOTH_CHROMIUM_LAUNCHERS, BROWSER_DEFAULT_FAVICON_PATH } from '../helpers/chromium.js';
import { settleLateDeliveries, startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { fastRunConfig } from '../helpers/run-harness.js';
import { TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

const TEST_TIMEOUT_MS = 120_000;
const PAGE_TIMEOUT_MS = 30_000;
/** ページの要求の後に、遅れて届く要求を待つ時間（ms。閉じた後は `settleLateDeliveries` の上限）。 */
const LATE_REQUEST_WAIT_MS = 1_500;
/** 開いたままのページで、届くべき要求が届くまで poll する上限（ms）。 */
const ARRIVAL_POLL_TIMEOUT_MS = 10_000;
/** 止めるべき要求を確かめる回の数（回ごとに新しい Context で読み込む）。 */
const ROUNDS = 2;
/** ページが作る、サービスの Origin の iframe の数。 */
const IFRAME_COUNT = 3;
const ADMIN_PATH = '/admin/s';
const WORKER_PATH = '/admin/worker.js';
/** P1-2: 閉じた後に出ようとする送信の時間（ms。読み込みから、待つ時間の後）。 */
const AFTER_CLOSE_SEND_DELAY_MS = AUDIT_SEND_CLOSE_SETTLE_MS + 1_500;
/** P1-2: ページが読み込みで localStorage に置き、離れるとき（`pagehide`）に消す値の名前（認証の状態をページを離れる前に読むかの確かめ）。 */
const STATE_KEY = 'beaksight-t44b-state';
/** P1-2: ページを離れるときに届くべき送信（並べ替えた形）。 */
const LEAVING_SENDS = Object.freeze([
  'DELETE /api/pagehide-delete',
  'POST /api/logout',
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
/**
 * T44R の I-1（Task 44 の設計書の履歴の「T44R …と設計者の判断」の行）: ページを離れた後の文書の読み込みのページ（独立レビューの leave.exp.ts の C2）。
 * - C2（`/admin/popup2-opener`）: 空のポップアップを開いてから中身を書き、ポップアップが、離れた後の opener を元の Origin の画面（`/admin/return`）へ戻す。
 * SPEC-1: 離れた後の要求の数の上限（L10 で撤廃）の場面 A と、その画面（`/admin/flood`）は消した。
 */
const POPUP_OPENER_PAGE_PATH = '/admin/popup2-opener';
const POPUP_PAGE_PATH = '/admin/popup';
const RETURN_PAGE_PATH = '/admin/return';
const LEAVE_PAGES: Readonly<Record<string, string>> = Object.freeze({
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

describe.each(BOTH_CHROMIUM_LAUNCHERS)('T44b: the audit send policy PASS_EXCEPT_DELETE on the width scan and at the Context close with %s', (_label, launch) => {
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

  /** 認証つきの factory（スクリプトで送るログインの監査の段の口と、数える部品と、Run のキャッシュ）と `PASS_EXCEPT_DELETE` の指定。 */
  const authenticatedFactoryOf = () => {
    const budget = createServiceRequestBudget({ now: () => Date.now() });
    const auditStage: AuditStageServiceRequests = {
      approvedServiceOrigins: [service.origin],
      auditReadRequests: [],
      scriptLogin: { origin: service.origin, path: '/auth/v1/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] },
    };
    const factory = new BrowserContextFactory(browser, configOf(), () => new SafetyLedger(), {
      ...TEST_FACTORY_OPTIONS,
      resourceCache: new ResourceCache(),
      authentication: {
        initialState: { cookies: [], origins: [] },
        filterState: (state) => state,
        auditExclusions: { excludedPathPrefixes: ['/logout'], auditPathPrefixes: ['/admin'], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
        auditStage,
      },
      serviceRequestBudget: budget,
      auditStageMonitor: new AuditStageMonitor(),
      auditSend: { policy: 'PASS_EXCEPT_DELETE', approvedServiceOrigins: [service.origin], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
    });
    return { factory, budget };
  };

  const serviceArrivals = (start: number): readonly string[] =>
    records.slice(start).filter(({ server, preflight }) => server === 'service' && !preflight).map(({ method, path }) => `${method} ${path}`);

  /** P1-1: 幅の走査の Context で、サービスの Origin に届くべき要求（並べ替えた形）。 */
  const expectedRevisitReads = [
    ...Array.from({ length: IFRAME_COUNT }, (_unused, index) => `GET /frame${String(index)}.html`),
    'GET /image.png',
    'GET /rest/v1/members',
    'GET /rest/v1/from-worker',
  ];
  /** SD-2: ページ自身の DELETE と危険な語の POST も届く。 */
  const expectedRevisitSends = ['POST /rest/v1/rpc/sync_state', 'DELETE /rest/v1/members', 'POST /auth/v1/logout'].sort();
  const expectedRevisitArrivals = [...expectedRevisitReads, ...expectedRevisitSends].sort();

  /** 幅の走査の Context（`REVISIT`）でページを開き、サービスの Origin へ要求を出す。届いた要求と Safety Ledger の記録を返す。 */
  const runRevisit = async () => {
    const { factory, budget } = authenticatedFactoryOf();
    const start = records.length;
    try {
      const config = configOf();
      const context = await factory.createPassiveContext(config.viewports.primaryDesktop, 'REVISIT');
      const page = await factory.createPassivePage(context);
      await page.goto(`${app.origin}${ADMIN_PATH}`, { timeout: PAGE_TIMEOUT_MS });
      const outcome = await page.evaluate(requestsSource(service.origin)) as Record<string, unknown>;
      // 判定が揃うまで待つ（届くべき読み取りと POST が届く。止めるべき DELETE と危険な語は、上の evaluate が応答を待って判定済み）。
      await expect.poll(() => [...serviceArrivals(start)].sort(), { timeout: ARRIVAL_POLL_TIMEOUT_MS }).toEqual(expectedRevisitArrivals);
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

  it('P1-1: sends the service origin reads and the page sends (SD-2: also DELETE and a dangerous term) on a REVISIT context', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const result = await runRevisit();
      expect(result.violations).toEqual([]);
      expect([...result.arrivedAtService].sort()).toEqual(expectedRevisitArrivals);
      expect(result.outcome).toMatchObject({ fetched: HTTP_OK, posted: HTTP_OK, deleted: HTTP_OK, loggedOut: HTTP_OK, fromWorker: HTTP_OK });
      expect(result.blockedRequests).toEqual([]);
      // DELETE のほかの Origin への CORS の事前確認も、サーバへ送って通した記録に残る（REV-RB14 の I-1）。
      expect([...result.passed].sort()).toEqual([...expectedRevisitSends, 'OPTIONS /rest/v1/members'].sort());
      // サービスの Origin への要求は、数える部品で数える（届いた読み取りと送信の数以上）。
      expect(result.budget.admitted).toBeGreaterThanOrEqual(expectedRevisitReads.length + expectedRevisitSends.length);
    }
    const start = records.length;
    await settleLateDeliveries(LATE_REQUEST_WAIT_MS, app, service);
    expect(serviceArrivals(start)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('P1-1: keeps the Isolated Interaction Context sending nothing to the service origin even with PASS_EXCEPT_DELETE', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { factory } = authenticatedFactoryOf();
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
      await settleLateDeliveries(LATE_REQUEST_WAIT_MS, app, service);
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
        blockedPhases: ledger.blockedRequests.map(({ phase }) => phase),
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

  it('P1-2: on a PRIMARY context, reads the state, leaves the page and waits before closing; the leaving beacons, keepalive fetch, DELETE and dangerous term arrive and are recorded, the sends after the close never arrive', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const result = await openAndClose(true);
      expect(result.violations).toEqual([]);
      expect([...result.arrived].sort()).toEqual(LEAVING_SENDS);
      expect([...result.passed].sort()).toEqual(LEAVING_SENDS);
      // SD-2: 離れるときのページの削除と危険な語も届き、止めた記録は出ない。
      expect(result.blockedRequests).toEqual([]);
      // about:blank への移動は、読み込みの間隔の部品にも、ページが始めた読み込みの判定（DEF-129）にも数えない。
      expect(result.pacerAfterClose).toBe(result.pacerBeforeClose);
      expect(result.pageLoad).toMatchObject({ limitReached: false });
      // 認証の状態は、ページを離れる前（`pagehide` が値を消す前）に読む。
      expect(result.inherited).toBe('kept');
      // 待つのは 1 回の閉じ方あたり名前つきの時間まで（閉じる処理そのものの時間の余裕を足した上限）。
      expect(result.closeMs).toBeGreaterThanOrEqual(AUDIT_SEND_CLOSE_SETTLE_MS - 50);
      expect(result.closeMs).toBeLessThan(AUDIT_SEND_CLOSE_SETTLE_MS + 10_000);
    }
    // ページは閉じたので、閉じた後の送信（`AFTER_CLOSE_SEND_DELAY_MS` の timer）は出られない。受けている途中の要求がなくなるまで待って数え直す。
    const start = records.length;
    await settleLateDeliveries(AFTER_CLOSE_SEND_DELAY_MS, app, service);
    expect(records.slice(start).filter(({ method }) => method !== 'GET')).toEqual([]);
    expect(records.filter(({ path }) => path === '/api/after-close-beacon')).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // SD-2（設計書 2.4）: ページを離れる手順は、ページの送信を通す全部の Context に広げた（幅の走査、印のない PRIMARY）。
  it.each<readonly [string, ResourceDeliveryRole, boolean]>([
    ['the width scan (REVISIT) with PASS_EXCEPT_DELETE', 'REVISIT', true],
    ['a PRIMARY context that is not a page audit load (robots.txt and the like) with PASS_EXCEPT_DELETE', 'PRIMARY', false],
  ])('P1-2: leaves the page before closing %s too, and the leaving sends arrive (SD-2)', async (_name, role, pageAuditLoad) => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const result = await openAndClose(true, role, pageAuditLoad);
      expect(result.violations).toEqual([]);
      expect([...result.arrived].sort()).toEqual(LEAVING_SENDS);
      expect(result.blockedRequests).toEqual([]);
    }
  }, TEST_TIMEOUT_MS);

  it('P1-2: closes the default (READ_ONLY) PRIMARY without the wait or leaving the page, and nothing of the page arrives', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const result = await openAndClose(false, 'PRIMARY', true);
      expect(result.violations).toEqual([]);
      expect(result.arrived).toEqual([]);
      expect(result.passed).toEqual([]);
      expect(result.inherited).toBe('kept');
    }
    const start = records.length;
    await settleLateDeliveries(AFTER_CLOSE_SEND_DELAY_MS, app, service);
    expect(records.slice(start).filter(({ method }) => method !== 'GET')).toEqual([]);
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
      // ページが開いたポップアップの文書が届くまで待つ（ポップアップは、離れた後の opener を戻しにかかる）。
      await expect.poll(() => records.slice(start).some((record) => record.path === POPUP_PAGE_PATH), { timeout: ARRIVAL_POLL_TIMEOUT_MS }).toBe(true);
      await beforeClose?.(page);
      const beforeLeave = records.length;
      let closeFailure: string | null = null;
      try {
        await factory.closePassiveContext(context);
      } catch (error) {
        closeFailure = String(error);
      }
      await settleLateDeliveries(LATE_REQUEST_WAIT_MS, app, service);
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
    await settleLateDeliveries(LATE_REQUEST_WAIT_MS, app, service);
    expect(records.slice(start).filter(({ path }) => path === RETURN_PAGE_PATH || path.startsWith('/api/return-'))).toEqual([]);
  }, TEST_TIMEOUT_MS);
});
