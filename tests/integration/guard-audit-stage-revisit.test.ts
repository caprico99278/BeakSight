// T35R-fix（T35R の C-1）: 監査の段の Guard の、幅の走査と Interaction（`REVISIT`）の Context。レビュー担当の実験（T35R の `guard.t35r.test.ts` の
// B05）を写して、確かめの形にした。自前の 127.0.0.1 のサーバ 2 つ（アプリ = 許可 Origin、サービス = 承認したサービスの Origin）。Chromium はテストの
// 既定の headless と、CLI の起動の設定の両方。
// - `REVISIT` の Context では、承認したサービスの Origin へ何も届かない（iframe の文書 3 つ、fetch、画像、Worker の fetch）。Run のキャッシュの有無に
//   よらない（届け方の部品ではなく、Guard の判定で止める）。iframe の文書は `SERVICE_ORIGIN_REVISIT` で Safety Ledger に残る。違反は出ない。
// - 最初の読み込み（`PRIMARY`）の Context では、同じページのサービスの Origin への要求（sub frame の文書を含む）を上限の部品で数え、届いた数は
//   `perRun` を超えない。
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import { BrowserContextFactory, type AuditStageServiceRequests } from '../../src/browser/context-factory.js';
import type { ResourceDeliveryRole } from '../../src/browser/resource-delivery.js';
import { ResourceCache } from '../../src/browser/resource-delivery.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { createServiceRequestBudget } from '../../src/crawl/service-request-budget.js';
import { AuditStageMonitor } from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { launchCliChromium, launchHeadlessChromium, testContextsOf } from '../helpers/chromium.js';
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
/** ページが作る、サービスの Origin の iframe の数。 */
const IFRAME_COUNT = 3;
const SMALL_PER_RUN = 3;
const DEFAULT_LIMITS = Object.freeze({ perMinute: 120, perRun: 600 });
const ADMIN_PATH = '/admin/s';
const WORKER_PATH = '/admin/worker.js';
const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;

const WORKER_SOURCE = `onmessage = async (event) => { try { postMessage((await fetch(event.data)).status); } catch (error) { postMessage('err'); } };`;
const PAGE_HTML = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>管理</title></head><body><p>管理</p></body></html>';

interface ServerRecord {
  readonly server: 'app' | 'service';
  readonly path: string;
  readonly preflight: boolean;
}

/** ページの中で、サービスの Origin へ要求を出す（iframe の文書、fetch、画像、Worker の fetch）。 */
const requestsSource = (service: string): string => `(async () => {
  for (let index = 0; index < ${IFRAME_COUNT}; index += 1) {
    const frame = document.createElement('iframe'); frame.src = '${service}/frame' + index + '.html'; document.body.appendChild(frame);
  }
  const image = new Image(); image.src = '${service}/image.png'; document.body.appendChild(image);
  const fetched = await fetch('${service}/rest/v1/members').then((response) => response.status, () => 'err');
  const worker = new Worker('${WORKER_PATH}');
  const fromWorker = await new Promise((resolveWorker) => {
    worker.onmessage = (event) => resolveWorker(event.data);
    worker.onerror = () => resolveWorker('worker error');
    worker.postMessage('${service}/rest/v1/from-worker');
    setTimeout(() => resolveWorker('worker timeout'), 5000);
  });
  return { fetched, fromWorker };
})()`;

describe.each(LAUNCHERS)('T35R-fix: the audit stage Guard on the width scan and Interaction contexts with %s', (_label, launch) => {
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

  /** 役割の Context でページを開き、サービスの Origin へ要求を出す。届いた数と Safety Ledger の記録を返す。 */
  const runOn = async (role: ResourceDeliveryRole, options: { readonly withCache: boolean; readonly perRun: number }) => {
    const base = fastRunConfig(app.origin, ADMIN_PATH);
    const config = { ...base, site: { startUrl: `${app.origin}${ADMIN_PATH}`, allowedOrigins: [app.origin] } };
    const limits = { perMinute: DEFAULT_LIMITS.perMinute, perRun: options.perRun };
    const budget = createServiceRequestBudget({ ...limits, now: () => Date.now() });
    const auditStage: AuditStageServiceRequests = {
      approvedServiceOrigins: [service.origin],
      auditReadRequests: [],
      scriptLogin: { origin: service.origin, path: '/auth/v1/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] },
      serviceRequestLimits: limits,
    };
    const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), {
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
    });
    const start = records.length;
    try {
      const context = await factory.createPassiveContext(config.viewports.primaryDesktop, role);
      const page = await factory.createPassivePage(context);
      await page.goto(`${app.origin}${ADMIN_PATH}`, { timeout: PAGE_TIMEOUT_MS });
      await page.evaluate(requestsSource(service.origin));
      await wait(LATE_REQUEST_WAIT_MS);
      const ledger = factory.getSafetyLedger(context).snapshot();
      return {
        arrivedAtService: records.slice(start).filter(({ server, preflight }) => server === 'service' && !preflight),
        blockedReasons: ledger.blockedRequests.map(({ reason }) => reason),
        violations: ledger.invariantViolations,
        budget: budget.snapshot(),
      };
    } finally {
      await factory.close();
    }
  };

  it.each([true, false])('sends nothing to the service origin on a REVISIT context (with the Run cache: %s)', async (withCache) => {
    const result = await runOn('REVISIT', { withCache, perRun: DEFAULT_LIMITS.perRun });
    expect(result.arrivedAtService).toEqual([]);
    expect(result.blockedReasons.filter((reason) => reason === 'SERVICE_ORIGIN_REVISIT').length).toBeGreaterThanOrEqual(IFRAME_COUNT);
    expect(result.violations).toEqual([]);
    expect(result.budget.admitted).toBe(0);
  }, TEST_TIMEOUT_MS);

  it('counts the service origin requests including the sub frame documents on the PRIMARY context, within perRun', async () => {
    const result = await runOn('PRIMARY', { withCache: true, perRun: SMALL_PER_RUN });
    expect(result.arrivedAtService.length).toBeLessThanOrEqual(SMALL_PER_RUN);
    expect(result.budget.admitted).toBe(SMALL_PER_RUN);
    expect(result.budget.refused).toBeGreaterThan(0);
    expect(result.blockedReasons).toContain('SERVICE_REQUEST_LIMIT_REACHED');
  }, TEST_TIMEOUT_MS);

  // T35R2-fix（T35R2 の C-1 の (a)）: 監査の段の口があって、上限の部品を渡さない factory は、Context を作らずに投げる（数えずに通さない。fail-closed）。
  it.each<ResourceDeliveryRole>(['PRIMARY', 'REVISIT'])('throws without creating a %s context when the audit stage has no budget', async (role) => {
    const base = fastRunConfig(app.origin, ADMIN_PATH);
    const config = { ...base, site: { startUrl: `${app.origin}${ADMIN_PATH}`, allowedOrigins: [app.origin] } };
    const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), {
      ...TEST_FACTORY_OPTIONS,
      authentication: {
        initialState: { cookies: [], origins: [] },
        filterState: (state) => state,
        auditExclusions: { excludedPathPrefixes: ['/logout'], auditPathPrefixes: ['/admin'], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
        auditStage: {
          approvedServiceOrigins: [service.origin],
          auditReadRequests: [],
          scriptLogin: { origin: service.origin, path: '/auth/v1/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] },
          serviceRequestLimits: DEFAULT_LIMITS,
        },
      },
    });
    const contextsBefore = testContextsOf(browser).length;
    try {
      await expect(factory.createPassiveContext(config.viewports.primaryDesktop, role)).rejects.toThrow(/service request budget/u);
      expect(testContextsOf(browser)).toHaveLength(contextsBefore);
    } finally {
      await factory.close();
    }
  }, TEST_TIMEOUT_MS);
});
