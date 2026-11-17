// T25g-3（独立レビュー T25R の M2。Task 25 の設計書 4.3 の「渡す前に絞る」）: 認証つきの Run で、ログインの状態の Domain 属性つきの Cookie
// （ドメインの先頭が `.`）を、絞り込み（`filterAuthenticatedState`）が host だけの Cookie にして渡すので、許可 Origin のサブドメインの資源の要求に、
// その Cookie が付かない。本物の Run Coordinator、factory、Guard と、このファイルの 127.0.0.1 の小さなサーバで確かめる（Chromium は `*.localhost`
// をループバックに解決する。`app.localhost` が許可 Origin、`sub.app.localhost` がそのサブドメイン）。Chromium は headless だけ（テストの既定と、
// CLI の起動の設定の両方）。
// - 許可 Origin の管理画面と、その画面の中の許可 Origin の資源の要求には、Cookie が付く（認証は保たれる）。
// - サブドメインの資源の要求には、Cookie が付かない（直す前は付いた）。
// 同じ host の別の port には、Cookie の決まりで送られうる（防げない。手順書に書く）。このテストでは確かめない。
// SLIM L-3: Cookie の範囲の守りの結合はこの 1 本（単体 1 は `control-authenticated-state.test.ts`）。前の login-state-carryover（DEF-139 の親ドメインの
// Cookie と IndexedDB）と、authenticated-context-factory の E7（別の Origin の Cookie）をまとめた。
// - DEF-139（設計書 `2026-10-20-beaksight-login-state-carryover-design.md` 3 章の受け入れ条件 1）の親ドメインの Cookie: `app.beak.localhost` の応答が
//   `Domain=beak.localhost` の Cookie を作る。その状態を監査に渡すと、許可の host の画面に Cookie が付き（直す前は外した）、ほかのサブドメイン
//   （`other.beak.localhost`）の資源の要求には付かない。
// - E7（T25c の調査）: 絞り込んだ状態では、別の Origin の部品の要求に、状態の Cookie が付かない（対照: 絞らなければ付く）。
// - DEF-139 の IndexedDB: fixture のログインの後の画面が IndexedDB に秘密の目印を書き、2 ページ目は、その記録がなければログインの画面へ移す。本物の
//   ログインの段（`runLoginStage`。人の操作の代わりにテストだけの口が資格情報を入れる）で取った状態を、本物の Run Coordinator・factory・Guard の監査に
//   渡し、2 ページ目まで監査できる。ログインの段の名前の記録に、IndexedDB の名前の行が残る。
// 秘密の目印（Cookie の値、localStorage の値、IndexedDB の値）は、Run の成果物に出ない。サーバは 127.0.0.1 だけで待ち受ける。
import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BrowserContextFactory,
  type AuthenticatedContextOptions,
  type AuthenticatedStorageState,
} from '../../src/browser/context-factory.js';
import type { AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import type { Viewport } from '../../src/config/types.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { RunCoordinator } from '../../src/orchestration/run-coordinator.js';
import { announceOwnMainFrameNavigation } from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { runLoginStage } from '../../src/worker/authenticated-login.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import {
  AUTH_SITE_INDEXED_DB,
  AUTH_SITE_LOGIN_FIELDS,
  AUTH_SITE_OTHER_ORIGIN_COOKIE,
  AUTH_SITE_PATHS,
  authenticatedStateFor,
  randomSecretValue,
  startAuthenticatedSite,
  type AuthenticatedSite,
} from '../helpers/authenticated-site-fixture.js';
import { BOTH_CHROMIUM_LAUNCHERS, launchHeadlessChromium } from '../helpers/chromium.js';
import { filesUnder, placesWithMarkers } from '../helpers/leak-places.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { createTestConfig, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

/** 許可 Origin の host（`*.localhost` はループバックに解決される）と、そのサブドメイン。 */
const APP_HOST = 'app.localhost';
const SUB_HOST = `sub.${APP_HOST}`;
/** セッションの Cookie の名前。 */
const SESSION_COOKIE = 'sid';
const PATHS = Object.freeze({ admin: '/admin', adminPixel: '/admin/pixel.svg', subPixel: '/pixel.svg', login: '/login' } as const);
const STATUS_OK = 200;
const STATUS_SEE_OTHER = 303;
const STATUS_NOT_FOUND = 404;
const TEST_TIMEOUT_MS = 120_000;
/** DEF-139: 親ドメインの Cookie の試験の host（`*.localhost` はループバックに解決される）。 */
const PARENT_DOMAIN = 'beak.localhost';
const PARENT_APP_HOST = `app.${PARENT_DOMAIN}`;
const PARENT_OTHER_HOST = `other.${PARENT_DOMAIN}`;
const PARENT_COOKIE = 'psid';
const PARENT_PATHS = Object.freeze({ set: '/set', admin: '/admin', adminPixel: '/admin/pixel.svg', otherPixel: '/pixel.svg', login: '/login' } as const);
/** E7: factory の Context の幅。 */
const DESKTOP: Viewport = Object.freeze({ width: 1280, height: 800 });

/** サーバに届いた要求（host、path、受け取った Cookie の名前。値は記録しない）。 */
interface ReceivedRequest {
  readonly host: string;
  readonly path: string;
  readonly cookieNames: readonly string[];
}

const cookieNamesOf = (request: IncomingMessage): readonly string[] =>
  (request.headers.cookie ?? '').split(';').map((part) => part.trim().split('=')[0] ?? '').filter((name) => name.length > 0);

describe.each(BOTH_CHROMIUM_LAUNCHERS)('T25g-3: a domain cookie of the login state is not sent to a subdomain (%s)', (_name, launch) => {
  let workDirectory: string;
  let server: LoopbackHttpServer;
  let port = 0;
  const requests: ReceivedRequest[] = [];
  const browsers: Browser[] = [];
  const sessionValue = randomSecretValue();
  const parentCookieValue = randomSecretValue();

  beforeAll(async () => {
    workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-host-only-cookies-'));
    server = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
      const host = (request.headers.host ?? '').split(':')[0] ?? '';
      const path = new URL(request.url ?? '/', `http://${host}`).pathname;
      requests.push({ host, path, cookieNames: cookieNamesOf(request) });
      if (host === PARENT_APP_HOST && path === PARENT_PATHS.set) {
        // DEF-139 のログインの代わり: 親ドメインの Cookie を作る。
        response.writeHead(STATUS_OK, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'set-cookie': `${PARENT_COOKIE}=${parentCookieValue}; Domain=${PARENT_DOMAIN}; Path=/; HttpOnly; SameSite=Lax`,
        });
        response.end('<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Set</title><link rel="icon" href="data:,"></head><body>SET</body></html>');
        return;
      }
      if (host === PARENT_APP_HOST && path === PARENT_PATHS.admin) {
        if (!cookieNamesOf(request).includes(PARENT_COOKIE)) {
          response.writeHead(STATUS_SEE_OTHER, { location: PARENT_PATHS.login });
          response.end();
          return;
        }
        response.writeHead(STATUS_OK, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end('<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Admin</title><link rel="icon" href="data:,"></head>'
          + `<body><main><h1>ADMIN</h1><img src="${PARENT_PATHS.adminPixel}" alt=""><img src="http://${PARENT_OTHER_HOST}:${port}${PARENT_PATHS.otherPixel}" alt="">`
          + '</main></body></html>');
        return;
      }
      if (host === APP_HOST && path === PATHS.admin) {
        if (!cookieNamesOf(request).includes(SESSION_COOKIE)) {
          response.writeHead(STATUS_SEE_OTHER, { location: PATHS.login });
          response.end();
          return;
        }
        response.writeHead(STATUS_OK, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end('<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Admin</title><link rel="icon" href="data:,"></head>'
          + `<body><main><h1>ADMIN</h1><img src="${PATHS.adminPixel}" alt=""><img src="http://${SUB_HOST}:${port}${PATHS.subPixel}" alt="">`
          + '</main></body></html>');
        return;
      }
      if (path === PATHS.adminPixel || path === PATHS.subPixel) {
        response.writeHead(STATUS_OK, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
        response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
        return;
      }
      response.writeHead(STATUS_NOT_FOUND, { 'content-type': 'text/plain' });
      response.end('');
    });
    port = server.port;
  });

  afterEach(async () => {
    await Promise.all(browsers.splice(0).map((browser) => browser.close().catch(() => undefined)));
  });

  afterAll(async () => {
    await server.close();
    await rm(workDirectory, { recursive: true, force: true });
  });

  it('sends the cookie to the approved host only, and not to its subdomain', async () => {
    requests.length = 0;
    const origin = `http://${APP_HOST}:${port}`;
    const authentication: RunAuthentication = {
      initialState: {
        cookies: [{
          name: SESSION_COOKIE,
          value: sessionValue,
          domain: `.${APP_HOST}`,
          path: '/',
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
        }],
        origins: [],
      },
      approvedTestOrigins: [origin],
      auditExclusions: { excludedPathPrefixes: [], auditPathPrefixes: [PATHS.admin], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
      sessionLostPathPrefix: PATHS.login,
      filterState: filterAuthenticatedState,
    };
    const coordinator = new RunCoordinator({
      config: createTestConfig(origin, PATHS.admin, {
        crawl: { maxPages: 1 },
        viewports: { stressWidths: [] },
        audit: { screenshots: false, performance: false, accessibility: false },
      }),
      launchBrowser: async () => {
        const browser = await launch();
        browsers.push(browser);
        return browser;
      },
      createSafetyLedger: () => new SafetyLedger(),
      clock: () => new Date(),
      now: () => Date.now(),
      outputDirectory: join(workDirectory, `run-${Date.now()}`),
      authentication,
    });
    const result = await coordinator.run();

    // 許可 Origin の管理画面と、その中の資源の要求には、Cookie が付いた（認証は保たれた）。
    expect(result.run.incompleteReasons.map(({ code }) => code)).not.toContain('AUTH_SESSION_LOST');
    const appRequests = requests.filter(({ host, path }) => host === APP_HOST && (path === PATHS.admin || path === PATHS.adminPixel));
    expect(appRequests.length).toBeGreaterThan(0);
    expect(appRequests.filter(({ cookieNames }) => !cookieNames.includes(SESSION_COOKIE))).toEqual([]);
    // サブドメインの資源の要求は届いたが、Cookie は付かなかった。
    const subRequests = requests.filter(({ host }) => host === SUB_HOST);
    expect(subRequests.length).toBeGreaterThan(0);
    expect(subRequests.filter(({ cookieNames }) => cookieNames.includes(SESSION_COOKIE))).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // DEF-139（前の login-state-carryover）。TDD の記録: 絞り込みの部品を先に直した（単体テストで RED を確かめた）後に書いたので、この結合テストの RED は
  // 観察していない。
  it('DEF-139: sends the parent domain cookie to the approved host, and not to another subdomain', async () => {
    const origin = `http://${PARENT_APP_HOST}:${port}`;
    // ログインの段の代わり: 普通の Context で親ドメインの Cookie を作り、状態を読む（Chromium が `*.localhost` でドメインの Cookie を作れることも確かめる）。
    const loginBrowser = await launch();
    browsers.push(loginBrowser);
    const loginContext = await loginBrowser.newContext();
    const loginPage = await loginContext.newPage();
    await loginPage.goto(`${origin}${PARENT_PATHS.set}`);
    const raw = await loginContext.storageState();
    await loginContext.close();
    expect(raw.cookies.map(({ name, domain }) => [name, domain])).toEqual([[PARENT_COOKIE, `.${PARENT_DOMAIN}`]]);

    requests.length = 0;
    const config = createTestConfig(origin, PARENT_PATHS.admin, {
      crawl: { maxPages: 1 },
      viewports: { stressWidths: [] },
      audit: { screenshots: false, performance: false, accessibility: false },
      output: { directory: join(workDirectory, `parent-run-${Date.now()}`) },
    });
    const result = await new RunCoordinator({
      config,
      launchBrowser: async () => {
        const browser = await launch();
        browsers.push(browser);
        return browser;
      },
      createSafetyLedger: () => new SafetyLedger(),
      clock: () => new Date(),
      now: () => Date.now(),
      outputDirectory: config.output.directory,
      authentication: {
        initialState: raw,
        approvedTestOrigins: [origin],
        auditExclusions: { excludedPathPrefixes: [], auditPathPrefixes: [PARENT_PATHS.admin], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
        sessionLostPathPrefix: PARENT_PATHS.login,
        filterState: filterAuthenticatedState,
      },
    }).run();

    // 許可の host の管理画面と、その中の資源の要求には、親ドメインの Cookie が付いた（直す前は外したので、ログインの画面へ移された）。
    expect(result.run.incompleteReasons.map(({ code }) => code)).not.toContain('AUTH_SESSION_LOST');
    const appRequests = requests.filter(({ host, path }) => host === PARENT_APP_HOST && (path === PARENT_PATHS.admin || path === PARENT_PATHS.adminPixel));
    expect(appRequests.length).toBeGreaterThan(0);
    expect(appRequests.filter(({ cookieNames }) => !cookieNames.includes(PARENT_COOKIE))).toEqual([]);
    // ほかのサブドメインの資源の要求は届いたが、Cookie は付かなかった（許可の host だけの Cookie にして渡した）。
    const otherRequests = requests.filter(({ host }) => host === PARENT_OTHER_HOST);
    expect(otherRequests.length).toBeGreaterThan(0);
    expect(otherRequests.filter(({ cookieNames }) => cookieNames.includes(PARENT_COOKIE))).toEqual([]);
    expect(placesWithMarkers(filesUnder(config.output.directory), [parentCookieValue])).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // E7（前の authenticated-context-factory。T25c の調査の E7）: 本物の factory と Guard と、127.0.0.1 の fixture のサーバ
  // （`tests/helpers/authenticated-site-fixture.ts`）で確かめる。
  it('E7: does not send the other Origin cookie of the state to the other Origin when the state is filtered', async () => {
    const site: AuthenticatedSite = await startAuthenticatedSite();
    const browser = await launch();
    browsers.push(browser);
    const factories: BrowserContextFactory[] = [];
    try {
      const factoryWith = (initialState: AuthenticatedStorageState, filterState: AuthenticatedContextOptions['filterState']): BrowserContextFactory => {
        const factory = new BrowserContextFactory(browser, createTestConfig(site.originA, AUTH_SITE_PATHS.admin), () => new SafetyLedger(), {
          ...TEST_FACTORY_OPTIONS,
          authentication: {
            initialState,
            filterState,
            auditExclusions: { excludedPathPrefixes: [AUTH_SITE_PATHS.adminLogout], auditPathPrefixes: [AUTH_SITE_PATHS.admin], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
          },
        });
        factories.push(factory);
        return factory;
      };
      const open = async (factory: BrowserContextFactory): Promise<{ context: BrowserContext; page: Page }> => {
        const context = await factory.createPassiveContext(DESKTOP);
        return { context, page: await factory.createPassivePage(context) };
      };
      /** `path` を読み、main frame の最後の path を返す（BeakSight 自身の読み込みと同じく、読み込みの前に Guard に知らせる）。 */
      const visit = async (page: Page, path: string): Promise<string> => {
        announceOwnMainFrameNavigation(page);
        await page.goto(`${site.originA}${path}`, { waitUntil: 'load' });
        return new URL(page.url()).pathname;
      };

      const filtered = factoryWith(authenticatedStateFor(site).state, (state) => filterAuthenticatedState(state, [site.originA]));
      const desktop = await open(filtered);
      expect(await visit(desktop.page, AUTH_SITE_PATHS.adminFrames)).toBe(AUTH_SITE_PATHS.adminFrames);
      await filtered.closePassiveContext(desktop.context);
      const otherOriginRequests = site.requests.filter(({ site: origin }) => origin === 'B');
      expect(otherOriginRequests.map(({ path }) => path).sort()).toEqual([AUTH_SITE_PATHS.otherFrame, AUTH_SITE_PATHS.otherPixel]);
      expect(otherOriginRequests.every(({ cookieNames }) => cookieNames.length === 0)).toBe(true);

      // 対照: 絞らない状態では、別の Origin の部品の要求に、その Cookie が付く（このテストが漏れを見分けられることの確かめ）。
      const before = site.requests.length;
      const unfiltered = factoryWith(authenticatedStateFor(site).state, (value) => value);
      const control = await open(unfiltered);
      expect(await visit(control.page, AUTH_SITE_PATHS.adminFrames)).toBe(AUTH_SITE_PATHS.adminFrames);
      await unfiltered.closePassiveContext(control.context);
      expect(site.requests.slice(before).filter(({ site: origin }) => origin === 'B').some(({ cookieNames }) =>
        cookieNames.includes(AUTH_SITE_OTHER_ORIGIN_COOKIE))).toBe(true);
    } finally {
      await Promise.all(factories.map((factory) => factory.close()));
      await site.close();
    }
  }, TEST_TIMEOUT_MS);
});

const INDEXED_DB_TEST_TIMEOUT_MS = 180_000;
const LOGIN_TIMEOUT_MS = 60_000;
const LOGIN_POLL_MS = 100;
const INDEXED_DB_MAX_PAGES = 3;

const indexedDbRunConfigOf = (origin: string, outputDirectory: string) => createTestConfig(origin, AUTH_SITE_PATHS.admin, {
  crawl: { maxPages: INDEXED_DB_MAX_PAGES },
  viewports: { stressWidths: [] },
  audit: { screenshots: false, performance: false, accessibility: false },
  output: { directory: outputDirectory },
});

// DEF-139（前の login-state-carryover）。TDD の記録: 直す前に、ログインの段の状態に IndexedDB がないことで落ちた（RED）。
describe('DEF-139: the IndexedDB of the login is carried to the audit', () => {
  let site: AuthenticatedSite;
  let workDirectory: string;
  const browsers: Browser[] = [];

  beforeAll(async () => {
    site = await startAuthenticatedSite({ loginForm: true, indexedDbGate: true });
    workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-login-state-carryover-'));
  });

  afterEach(async () => {
    await Promise.all(browsers.splice(0).map((browser) => browser.close().catch(() => undefined)));
  });

  afterAll(async () => {
    await site?.close();
    await rm(workDirectory, { recursive: true, force: true });
  });

  const launch = async (): Promise<Browser> => {
    const browser = await launchHeadlessChromium();
    browsers.push(browser);
    return browser;
  };

  it('audits the second page that needs the IndexedDB written after the login, and records the IndexedDB name', async () => {
    const setup: AuthSetup = {
      ...FORM_NAVIGATION_SETUP_ITEMS,
      profileId: 'def139-indexed-db',
      profileRevision: MIN_PROFILE_REVISION,
      loginStartUrl: `${site.originA}${AUTH_SITE_PATHS.login}`,
      loginPostEndpoints: [{ origin: site.originA, path: AUTH_SITE_PATHS.login }],
      successCondition: { pathPrefix: AUTH_SITE_PATHS.admin, selector: '#admin-ok' },
      sessionLostCondition: { pathPrefix: AUTH_SITE_PATHS.login },
      excludedPaths: [AUTH_SITE_PATHS.adminLogout],
      auditPathPrefixes: [AUTH_SITE_PATHS.admin],
      maxLoginAttempts: 2,
      allowedIdpOrigins: [],
      automatedLogin: null,
    };
    const config = indexedDbRunConfigOf(site.originA, join(workDirectory, 'indexed-db'));
    const login = await runLoginStage({
      config,
      setup,
      approvedTestOrigins: [site.originA],
      signal: new AbortController().signal,
      onAwaitingLogin: () => undefined,
    }, {
      launchLoginBrowser: launch,
      loginTimeoutMs: LOGIN_TIMEOUT_MS,
      pollIntervalMs: LOGIN_POLL_MS,
      onLoginPageReady: async (page: Page) => {
        await site.fillCredentials(async (selector, value) => page.locator(selector).fill(value));
        await page.locator(AUTH_SITE_LOGIN_FIELDS.submit).click();
      },
    });
    if (login.kind !== 'AUTHENTICATED') {
      throw new Error(`the login stage ended with ${login.kind}`);
    }
    // ログインの段の状態に、許可 Origin の IndexedDB がある（直す前は、IndexedDB を読まなかった）。
    expect(login.state.origins.find(({ origin }) => origin === site.originA)?.indexedDB?.map(({ name }) => name)).toEqual([AUTH_SITE_INDEXED_DB.database]);
    // 名前の記録: IndexedDB のデータベースの行（`beak-session` の名前の形は、端の一般の語の `-session` だけ。値は持たない）。
    expect(login.stateNames?.indexedDB.rows).toEqual([{ origin: site.originA, shape: { prefix: '', suffix: '-session' }, outcome: 'CARRIED', count: 1 }]);
    expect(placesWithMarkers([['stateNames', Buffer.from(JSON.stringify(login.stateNames ?? null))]], site.secretValues())).toEqual([]);

    const requestsBefore = site.requests.length;
    const authentication: RunAuthentication = {
      initialState: login.state,
      approvedTestOrigins: [site.originA],
      auditExclusions: { excludedPathPrefixes: [AUTH_SITE_PATHS.adminLogout], auditPathPrefixes: [AUTH_SITE_PATHS.admin], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
      sessionLostPathPrefix: AUTH_SITE_PATHS.login,
      filterState: filterAuthenticatedState,
    };
    const result = await new RunCoordinator({
      config,
      launchBrowser: launch,
      createSafetyLedger: () => new SafetyLedger(),
      clock: () => new Date(),
      now: () => Date.now(),
      outputDirectory: config.output.directory,
      authentication,
    }).run();

    const auditRequests = site.requests.slice(requestsBefore);
    expect(result.run.incompleteReasons.map(({ code }) => code)).not.toContain('AUTH_SESSION_LOST');
    expect(auditRequests.filter(({ path }) => path === AUTH_SITE_PATHS.adminSecond).map(({ authenticated }) => authenticated)).toContain(true);
    // 2 ページ目は、IndexedDB の記録を見つけたので、ログインの画面へ移さなかった（移せば、セッションの切れで止まる。下の対照）。
    expect(placesWithMarkers(filesUnder(config.output.directory), site.secretValues())).toEqual([]);

    // 対照: IndexedDB を除いた状態（直す前に引き継いでいた形）では、2 ページ目がログインの画面へ移り、セッションの切れで止まる（fixture が IndexedDB を
    // 見ていることの確かめ）。
    const controlConfig = indexedDbRunConfigOf(site.originA, join(workDirectory, 'indexed-db-control'));
    const withoutIndexedDB = { ...login.state, origins: login.state.origins.map(({ origin, localStorage }) => ({ origin, localStorage })) };
    const controlBefore = site.requests.length;
    const control = await new RunCoordinator({
      config: controlConfig,
      launchBrowser: launch,
      createSafetyLedger: () => new SafetyLedger(),
      clock: () => new Date(),
      now: () => Date.now(),
      outputDirectory: controlConfig.output.directory,
      authentication: { ...authentication, initialState: withoutIndexedDB },
    }).run();
    // ログインの画面は監査の範囲の外なので、Guard が移動を止める（サーバには届かない）。セッションの切れとして止まる。
    expect(site.requests.slice(controlBefore).map(({ path }) => path)).toContain(AUTH_SITE_PATHS.adminSecond);
    expect(control.run.incompleteReasons.map(({ code }) => code)).toContain('AUTH_SESSION_LOST');
  }, INDEXED_DB_TEST_TIMEOUT_MS);
});
