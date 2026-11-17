// T30b（Task 30 の設計書 `2026-10-13-beaksight-task-30-approved-create-design.md` 4 章の「factory の入口」）: 書き込みの段の Context の入口
// （`BrowserContextFactory.createWriteStageContext`）。本物の factory と Guard と、127.0.0.1 の fixture のサーバで確かめる。Chromium は headless
// だけ（テストの既定と、CLI の起動の設定の両方）。
// - 認証つきの factory（ログインの後の状態を持つ）だけが作る。状態（Cookie）は Context に渡る。
// - 書き込みの段の Context では、承認の要求の形の POST が届く。送信の報告は `SENT` と応答（2 回目が届かないことは guard-write-stage）。
// - 中継へ直に送った承認の形の POST は、窓の前も後も届かない（LU-SFIX2-B。api-write-submission の中継の予算の場面をここに寄せた）。
// - 同じ factory の Passive の Context（認証つきの監査の Context）では、承認の形の POST も届かない（書き込みの段の許可は、入口の外に漏れない）。
// - 認証のない factory、形の違う指定、別の Guard に付けた部品、は拒む（Context を作らない）。
import { request as httpRequest } from 'node:http';
import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { Viewport } from '../../src/config/types.js';
import { wait } from '../../src/core/deadline.js';
import { WriteStageMonitor, type GuardWriteStage } from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import type { WritePayloadExpectation } from '../../src/safety/write-payload-policy.js';
import { overrideBrowser } from '../helpers/browser-proxies.js';
import { BOTH_CHROMIUM_LAUNCHERS, closeTestContexts, testContextsOf } from '../helpers/chromium.js';
import { QUIET_PERIOD_MS } from '../helpers/gate-harness.js';
import { TEST_FACTORY_OPTIONS, createTestConfig } from '../helpers/test-config.js';
import { WRITE_FIXTURE_PATHS, startWriteFixtureServer, type WriteFixtureServer } from '../helpers/write-fixture-server.js';

const VIEWPORT: Viewport = Object.freeze({ width: 1280, height: 800 });
const NAVIGATION_SETTLE_TIMEOUT_MS = 10_000;
/** 全部の試みの後に、遅れて届く要求を見逃さないために待つ時間（ms）。 */
const LATE_DELIVERY_SETTLE_MS = 2_000;
/** 認証つきの Run の状態の Cookie（テストの仮の値。ログインの後の状態の代わり）。 */
const SESSION_COOKIE_NAME = 'sid';
const SESSION_COOKIE_VALUE = 'test-session-t30b';

describe.each(BOTH_CHROMIUM_LAUNCHERS)('T30b: the write stage Context of the factory (%s)', (_name, launch) => {
  let realBrowser: Browser;
  let browser: Browser;
  let server: WriteFixtureServer;
  /** LU-SFIX2-B: 中継に直に送る確かめのため、Context の proxy の server を覚える（製品のコードは変えない）。 */
  const proxyServers = new WeakMap<BrowserContext, string>();
  const factories: BrowserContextFactory[] = [];

  beforeAll(async () => {
    realBrowser = await launch();
    browser = overrideBrowser(realBrowser, {
      newContext: async (options?: BrowserContextOptions): Promise<BrowserContext> => {
        const context = await realBrowser.newContext(options);
        if (options?.proxy?.server !== undefined) proxyServers.set(context, options.proxy.server);
        return context;
      },
    });
  });

  afterEach(async () => {
    await Promise.all(factories.splice(0).map((factory) => factory.close()));
    await closeTestContexts(realBrowser);
    await server?.close();
  });

  afterAll(async () => {
    await realBrowser?.close();
  });

  const factoryFor = (origin: string, authenticated: boolean): BrowserContextFactory => {
    const factory = new BrowserContextFactory(browser, createTestConfig(origin, '/'), () => new SafetyLedger(), {
      ...TEST_FACTORY_OPTIONS,
      ...(authenticated
        ? {
          authentication: {
            initialState: {
              cookies: [{
                name: SESSION_COOKIE_NAME,
                value: SESSION_COOKIE_VALUE,
                domain: '127.0.0.1',
                path: '/',
                expires: -1,
                httpOnly: true,
                secure: false,
                sameSite: 'Lax' as const,
              }],
              origins: [],
            },
            filterState: (state) => state,
            auditExclusions: { excludedPathPrefixes: [], auditPathPrefixes: [], dangerousTerms: [] },
          },
        }
        : {}),
    });
    factories.push(factory);
    return factory;
  };

  const expectationFor = (origin: string): WritePayloadExpectation => ({
    request: { origin, path: WRITE_FIXTURE_PATHS.create, enctype: 'application/x-www-form-urlencoded' },
    submittedFields: [{ name: 'customer_name', value: '山田 太郎' }, { name: 'memo', value: 'メモ' }],
    passthroughFieldNames: ['csrf_token', 'serial'],
    emptyFileFieldNames: [],
  });

  const submit = async (page: Page, monitor?: WriteStageMonitor): Promise<void> => {
    await page.goto(server.formUrl('plain'));
    await monitor?.openSubmissionWindow(page);
    await page.fill('#customer_name', '山田 太郎');
    await page.fill('#memo', 'メモ');
    // T40R-fix-A: 値を入れる間は窓の観察の段。押す直前に送信の段を開く（書き込みの入力の部品と同じ順）。
    monitor?.openSubmissionPhase();
    await Promise.all([
      page.waitForEvent('framenavigated', { timeout: NAVIGATION_SETTLE_TIMEOUT_MS }).catch(() => undefined),
      page.click('#go'),
    ]);
    await page.waitForLoadState('load', { timeout: NAVIGATION_SETTLE_TIMEOUT_MS }).catch(() => undefined);
    await wait(QUIET_PERIOD_MS);
  };

  const posts = (): string[] => server.requests.filter((entry) => entry.method === 'POST').map((entry) => `${entry.site} ${entry.path}`);

  it('carries the authenticated state, delivers the approved POST once, and keeps the permission inside the write stage Context', async () => {
    server = await startWriteFixtureServer();
    const factory = factoryFor(server.originA, true);
    const monitor = new WriteStageMonitor();
    const context = await factory.createWriteStageContext(VIEWPORT, { expectation: expectationFor(server.originA), monitor });
    const page = await factory.createPassivePage(context);
    expect((await context.cookies()).map((cookie) => cookie.name)).toEqual([SESSION_COOKIE_NAME]);

    await submit(page, monitor);
    expect(posts()).toEqual([`A ${WRITE_FIXTURE_PATHS.create}`]);
    expect(new URL(page.url()).pathname).toBe(WRITE_FIXTURE_PATHS.created);
    expect(monitor.submissionReport()).toEqual({ submission: 'SENT', responseReceived: true, responseStatus: 303, sendAttempts: 1, sendOutcome: 'RESPONDED' });
    // SLIM: 同じ Context の 2 回目の POST が届かないことは、書き込みの段（form）の家 guard-write-stage の「delivers the approved urlencoded POST once …」
    // （a second POST）で確かめる。ここは入口の端から端の 1 本（状態が渡る・許可が入口の外に漏れない・中継へ直）。
    const ledger = factory.getSafetyLedger(context);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    await factory.closePassiveContext(context);

    // 同じ factory の Passive の Context では、承認の形の POST も届かない。
    const passive = await factory.createPassiveContext(VIEWPORT);
    const passivePage = await factory.createPassivePage(passive);
    await submit(passivePage);
    await wait(LATE_DELIVERY_SETTLE_MS);
    expect(posts()).toEqual([`A ${WRITE_FIXTURE_PATHS.create}`]);
    expect(factory.getSafetyLedger(passive).snapshot().blockedRequests.map((entry) => `${entry.method} ${new URL(entry.url).pathname}`)).toEqual([
      `POST ${WRITE_FIXTURE_PATHS.create}`,
    ]);
    await factory.closePassiveContext(passive);
  });

  /** LU-SFIX2-B: 中継に直に、絶対形の HTTP の承認の形の POST を送り、status を返す（届かなければ 0）。 */
  const postToRelay = (context: BrowserContext): Promise<number> => {
    const proxy = new URL(proxyServers.get(context) ?? 'http://127.0.0.1:9');
    return new Promise<number>((resolvePromise) => {
      const request = httpRequest({
        host: proxy.hostname, port: Number(proxy.port), method: 'POST', path: `${server.originA}${WRITE_FIXTURE_PATHS.create}`,
        headers: { host: new URL(server.originA).host, 'content-type': 'application/x-www-form-urlencoded', connection: 'close' },
      }, (response) => {
        response.resume();
        response.on('end', () => resolvePromise(response.statusCode ?? 0));
      });
      request.on('error', () => resolvePromise(0));
      request.end('customer_name=x&memo=y');
    });
  };

  // LU-SFIX2-B（LU-SREV2 の Minor-2 と同じ考え方）: フォームの書き込みの段の中継も、承認の送信先への POST は、Guard が通した要求の写しに当たるものだけを
  // 通す。Guard を通らずに中継へ直に送った承認の形の POST は、窓を開く前も、開いた後も、Guard が通した後も 403 で、サーバに届かない。Guard が通した POST は
  // 今のとおり 1 件だけ届く。
  it('rejects the approved POST sent straight to the relay before and after the window opens, and delivers only the one that the Guard passed (LU-SFIX2-B)', async () => {
    server = await startWriteFixtureServer();
    const factory = factoryFor(server.originA, true);
    const monitor = new WriteStageMonitor();
    const context = await factory.createWriteStageContext(VIEWPORT, { expectation: expectationFor(server.originA), monitor });
    const page = await factory.createPassivePage(context);
    await page.goto(server.formUrl('plain'));
    const beforeWindow = await postToRelay(context);
    await monitor.openSubmissionWindow(page);
    const inWindow = await postToRelay(context);
    monitor.openSubmissionPhase();
    const inPhase = await postToRelay(context);
    const reachedBeforeGuard = posts();
    await page.fill('#customer_name', '山田 太郎');
    await page.fill('#memo', 'メモ');
    await Promise.all([
      page.waitForEvent('framenavigated', { timeout: NAVIGATION_SETTLE_TIMEOUT_MS }).catch(() => undefined),
      page.click('#go'),
    ]);
    await page.waitForLoadState('load', { timeout: NAVIGATION_SETTLE_TIMEOUT_MS }).catch(() => undefined);
    await wait(QUIET_PERIOD_MS);
    const after = await postToRelay(context);
    expect([beforeWindow, inWindow, inPhase, after]).toEqual([403, 403, 403, 403]);
    expect(reachedBeforeGuard).toEqual([]);
    expect(posts()).toEqual([`A ${WRITE_FIXTURE_PATHS.create}`]);
    expect(monitor.submissionReport()).toEqual({ submission: 'SENT', responseReceived: true, responseStatus: 303, sendAttempts: 1, sendOutcome: 'RESPONDED' });
    await wait(LATE_DELIVERY_SETTLE_MS);
    expect(posts()).toEqual([`A ${WRITE_FIXTURE_PATHS.create}`]);
    expect(factory.getSafetyLedger(context).snapshot().blockedInteractionRequests
      .filter(({ method, url, reason }) => method === 'POST' && new URL(url).pathname === WRITE_FIXTURE_PATHS.create && reason === 'GUARD_BYPASS_EGRESS'))
      .toHaveLength(4);
    await factory.closePassiveContext(context);
  });

  it('refuses a factory without the authenticated state, malformed stages and a monitor attached to another Guard', async () => {
    server = await startWriteFixtureServer();
    const unauthenticated = factoryFor(server.originA, false);
    await expect(unauthenticated.createWriteStageContext(VIEWPORT, { expectation: expectationFor(server.originA), monitor: new WriteStageMonitor() }))
      .rejects.toThrow(TypeError);

    const factory = factoryFor(server.originA, true);
    const malformed: readonly unknown[] = [
      undefined,
      {},
      { expectation: expectationFor(server.originA) },
      { expectation: expectationFor(server.originA), monitor: {} },
      { expectation: null, monitor: new WriteStageMonitor() },
      { expectation: { ...expectationFor(server.originA), request: { origin: 1, path: '/items', enctype: 'application/x-www-form-urlencoded' } }, monitor: new WriteStageMonitor() },
      { expectation: { ...expectationFor(server.originA), submittedFields: 'x' }, monitor: new WriteStageMonitor() },
      // LU-SFIX3-B: 守る型は、送信先の path の最後の区切りを `{id}` にした形だけ。
      { expectation: expectationFor(server.originA), monitor: new WriteStageMonitor(), guardedPathShape: '/other/{id}' },
      { expectation: expectationFor(server.originA), monitor: new WriteStageMonitor(), guardedPathShape: 1 },
    ];
    for (const stage of malformed) {
      await expect(factory.createWriteStageContext(VIEWPORT, stage as GuardWriteStage), JSON.stringify(stage)).rejects.toThrow(TypeError);
    }
    const monitor = new WriteStageMonitor();
    const context = await factory.createWriteStageContext(VIEWPORT, { expectation: expectationFor(server.originA), monitor });
    await expect(factory.createWriteStageContext(VIEWPORT, { expectation: expectationFor(server.originA), monitor })).rejects.toThrow(TypeError);
    await factory.closePassiveContext(context);
    expect(testContextsOf(realBrowser)).toEqual([]);
  });
});
