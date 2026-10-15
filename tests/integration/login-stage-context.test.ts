// T25d（Task 25 の設計書の変更履歴の 2026-10-10 の T25d の Blocker の行の (3)）: ログインの段の Context の入口
// （`BrowserContextFactory.createLoginStageContext`）。Context の作り方の owner を factory の 1 つに保ち、Guard にログインの段の指定
// （`loginStage`）を渡し、Worker の自己検査をかける。本物の factory と Guard と、127.0.0.1 の fixture のサーバで確かめる。Chromium は headless
// だけ（テストの既定と、CLI の起動の設定の両方）。
// - ログインの段の Context では、許した送信先への main frame の POST が、回数の上限まで届く。ほかの POST（管理画面の更新）は届かない。
// - 同じ factory の Passive の Context（今の監査の Context）では、ログインの POST も届かない（ログインの段の許可は、入口の外に漏れない）。
// - 認証つきの factory（監査の段）は、ログインの段の Context を作らない。形の違う指定も拒む（Context を作らない）。
// - Worker の自己検査: Shared Worker を無効にする引数を外した Chromium で、ログインの段の Context のページが Shared Worker を作ると、違反
//   `SHARED_WORKER_OBSERVED` を記録して、その Context を閉じる。
import type { Browser, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { Viewport } from '../../src/config/types.js';
import { isPassiveRequestGuardClosed, type GuardLoginStage } from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { sharedWorkerPostsPath } from '../helpers/gate-harness.js';
import { LOGIN_FIXTURE_PATHS, startLoginFixtureServer, type LoginFixtureServer } from '../helpers/login-fixture-server.js';
import { TEST_FACTORY_OPTIONS, createTestConfig } from '../helpers/test-config.js';

const LAUNCHERS = [
  ['the default test Chromium', (sharedWorkers?: 'allow') => launchHeadlessChromium(sharedWorkers === undefined ? {} : { sharedWorkers })],
  ['the CLI launch settings', (sharedWorkers?: 'allow') => launchCliChromium(sharedWorkers === undefined ? {} : { sharedWorkers })],
] as const;
const VIEWPORT: Viewport = Object.freeze({ width: 1280, height: 800 });
/** 読み込みの後に、遅れて届く要求を待つ時間（ms）。 */
const QUIET_PERIOD_MS = 300;
const NAVIGATION_SETTLE_TIMEOUT_MS = 10_000;

const wait = (ms: number): Promise<void> => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

describe.each(LAUNCHERS)('T25d: the login stage Context of the factory (%s)', (_name, launch) => {
  let browser: Browser;
  let server: LoginFixtureServer;
  const factories: BrowserContextFactory[] = [];

  beforeAll(async () => {
    browser = await launch();
  });

  afterEach(async () => {
    await Promise.all(factories.splice(0).map((factory) => factory.close()));
    await Promise.all(browser.contexts().map((context) => context.close().catch(() => undefined)));
    await server?.close();
  });

  afterAll(async () => {
    await browser?.close();
  });

  const factoryFor = (origin: string, authenticated = false): BrowserContextFactory => {
    const factory = new BrowserContextFactory(browser, createTestConfig(origin, '/'), () => new SafetyLedger(), {
      ...TEST_FACTORY_OPTIONS,
      ...(authenticated
        ? {
          authentication: {
            initialState: { cookies: [], origins: [] },
            filterState: (state) => state,
            auditExclusions: { excludedPathPrefixes: [], auditPathPrefixes: [], dangerousTerms: [] },
          },
        }
        : {}),
    });
    factories.push(factory);
    return factory;
  };

  const loginStageFor = (origin: string, maxLoginPosts: number): GuardLoginStage => ({
    loginPostEndpoints: [{ origin, path: LOGIN_FIXTURE_PATHS.login }],
    maxLoginPosts,
  });

  const submit = async (page: Page, selector: string): Promise<void> => {
    await Promise.all([
      page.waitForEvent('framenavigated', { timeout: NAVIGATION_SETTLE_TIMEOUT_MS }).catch(() => undefined),
      page.click(selector),
    ]);
    await page.waitForLoadState('load', { timeout: NAVIGATION_SETTLE_TIMEOUT_MS }).catch(() => undefined);
    await wait(QUIET_PERIOD_MS);
  };

  const postsTo = (path: string): number =>
    server.requests.filter(({ method, path: requested }) => method === 'POST' && requested.startsWith(path)).length;

  it('lets the login POST through on the login stage Context, and blocks the other POST', async () => {
    server = await startLoginFixtureServer();
    const factory = factoryFor(server.originA);
    const context = await factory.createLoginStageContext(VIEWPORT, loginStageFor(server.originA, 1));
    const page = await factory.createPassivePage(context);

    await page.goto(`${server.originA}${LOGIN_FIXTURE_PATHS.login}`);
    await server.fillCredentials((selector, value) => page.fill(selector, value));
    await submit(page, '#go');
    expect(server.successfulLogins).toBe(1);
    expect(new URL(page.url()).pathname).toBe(LOGIN_FIXTURE_PATHS.admin);

    await submit(page, '#update');
    expect(postsTo(LOGIN_FIXTURE_PATHS.adminUpdate)).toBe(0);
    expect(postsTo(LOGIN_FIXTURE_PATHS.login)).toBe(1);
    expect(factory.getSafetyLedger(context).snapshot().invariantViolationCount).toBe(0);
    await factory.closePassiveContext(context);
  });

  it('stops the login POST beyond the limit, and keeps the passive Context of the same factory without the login permission', async () => {
    server = await startLoginFixtureServer();
    const factory = factoryFor(server.originA);
    const context = await factory.createLoginStageContext(VIEWPORT, loginStageFor(server.originA, 1));
    const page = await factory.createPassivePage(context);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await page.goto(`${server.originA}${LOGIN_FIXTURE_PATHS.login}`);
      await page.fill('#user', 'wrong-user');
      await page.fill('#pass', 'wrong-pass');
      await submit(page, '#go');
    }
    expect(postsTo(LOGIN_FIXTURE_PATHS.login)).toBe(1);
    const blocked = factory.getSafetyLedger(context).snapshot().blockedRequests
      .filter(({ method, url }) => method === 'POST' && new URL(url).pathname === LOGIN_FIXTURE_PATHS.login);
    expect(blocked.length).toBeGreaterThan(0);
    await factory.closePassiveContext(context);

    const passive = await factory.createPassiveContext(VIEWPORT);
    const passivePage = await factory.createPassivePage(passive);
    await passivePage.goto(`${server.originA}${LOGIN_FIXTURE_PATHS.login}`);
    await server.fillCredentials((selector, value) => passivePage.fill(selector, value));
    await submit(passivePage, '#go');
    expect(postsTo(LOGIN_FIXTURE_PATHS.login)).toBe(1);
    expect(server.successfulLogins).toBe(0);
    await factory.closePassiveContext(passive);
  });

  it('does not create a login stage Context from an authenticated factory, nor from a malformed stage', async () => {
    server = await startLoginFixtureServer();
    await expect(factoryFor(server.originA, true).createLoginStageContext(VIEWPORT, loginStageFor(server.originA, 1)))
      .rejects.toThrow(TypeError);
    const factory = factoryFor(server.originA);
    for (const stage of [
      null,
      { loginPostEndpoints: 'x', maxLoginPosts: 1 },
      { loginPostEndpoints: [{ origin: server.originA }], maxLoginPosts: 1 },
      { loginPostEndpoints: [], maxLoginPosts: 1 },
      { loginPostEndpoints: [{ origin: server.originA, path: '/login' }], maxLoginPosts: 1.5 },
    ]) {
      await expect(factory.createLoginStageContext(VIEWPORT, stage as never), JSON.stringify(stage)).rejects.toThrow(TypeError);
    }
    expect(browser.contexts()).toHaveLength(0);
  });
});

describe.each(LAUNCHERS)('T25d: the Worker self-check covers the login stage Context (%s, without the Shared Worker disabling arguments)', (_name, launch) => {
  let allowingBrowser: Browser;
  let site: FixtureServer;

  beforeAll(async () => {
    site = await startFixtureServer();
    allowingBrowser = await launch('allow');
  });

  afterAll(async () => {
    await allowingBrowser?.close();
    await site?.close();
  });

  it('records SHARED_WORKER_OBSERVED and closes the login stage Context when its page creates a Shared Worker', async () => {
    const factory = new BrowserContextFactory(allowingBrowser, createTestConfig(site.origin, '/'), () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
    try {
      const context = await factory.createLoginStageContext(VIEWPORT, {
        loginPostEndpoints: [{ origin: site.origin, path: '/login' }],
        maxLoginPosts: 1,
      });
      const page = await factory.createPassivePage(context);
      await page.goto(`${site.origin}${sharedWorkerPostsPath('fetch')}`, { waitUntil: 'load' }).catch(() => undefined);

      await expect.poll(() => isPassiveRequestGuardClosed(context)).toBe(true);
      expect(factory.getSafetyLedger(context).snapshot().invariantViolations.map(({ code }) => code)).toContain('SHARED_WORKER_OBSERVED');
      await expect(factory.closePassiveContext(context)).resolves.toBeUndefined();
    } finally {
      await factory.close();
    }
  });
});
