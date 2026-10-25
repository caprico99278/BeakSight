// DEF-139（設計書 `2026-10-20-beaksight-login-state-carryover-design.md` 3 章の受け入れ条件 1）: ログインの状態の引き継ぎを、普通のブラウザに近づける。
// TDD の記録: IndexedDB の場面は、直す前に、ログインの段の状態に IndexedDB がないことで落ちた（RED）。親ドメインの Cookie の場面は、絞り込みの部品を
// 先に直した（単体テストで RED を確かめた）後に書いたので、この結合テストの RED は観察していない。
// - IndexedDB: fixture のログインの後の画面が IndexedDB に秘密の目印を書き、2 ページ目は、その記録がなければログインの画面へ移す。本物のログインの段
//   （`runLoginStage`。人の操作の代わりにテストだけの口が資格情報を入れる）で取った状態を、本物の Run Coordinator・factory・Guard の監査に渡し、2 ページ目
//   まで監査できる（直す前は、IndexedDB を引き継がず、2 ページ目でログインの画面へ移された）。ログインの段の名前の記録に、IndexedDB の名前の行が残る。
// - 親ドメインの Cookie: `*.localhost` の名前（Chromium はループバックに解決する）で、`app.beak.localhost` の応答が `Domain=beak.localhost` の Cookie を
//   作る。その状態を監査に渡すと、許可の host（`app.beak.localhost`）の画面に Cookie が付き（直す前は外した）、ほかのサブドメイン（`other.beak.localhost`）の
//   資源の要求には付かない（許可の host だけの Cookie に直して渡すため）。
// 秘密の目印（Cookie の値、localStorage の値、IndexedDB の値）は、Run の成果物に出ない。サーバは 127.0.0.1 だけで待ち受ける。
import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import type { AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { RunCoordinator } from '../../src/orchestration/run-coordinator.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { runLoginStage } from '../../src/worker/authenticated-login.js';
import {
  AUTH_SITE_INDEXED_DB,
  AUTH_SITE_LOGIN_FIELDS,
  AUTH_SITE_PATHS,
  randomSecretValue,
  startAuthenticatedSite,
  type AuthenticatedSite,
} from '../helpers/authenticated-site-fixture.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { filesUnder, placesWithMarkers } from '../helpers/leak-places.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { createTestConfig } from '../helpers/test-config.js';

const TEST_TIMEOUT_MS = 180_000;
const LOGIN_TIMEOUT_MS = 60_000;
const LOGIN_POLL_MS = 100;
const MAX_PAGES = 3;
const STATUS_OK = 200;
const STATUS_SEE_OTHER = 303;
const STATUS_NOT_FOUND = 404;

const LAUNCHERS = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI launch settings', () => launchCliChromium()],
] as const;

const runConfigOf = (origin: string, outputDirectory: string) => createTestConfig(origin, AUTH_SITE_PATHS.admin, {
  crawl: { maxPages: MAX_PAGES },
  viewports: { stressWidths: [] },
  audit: { screenshots: false, performance: false, accessibility: false },
  output: { directory: outputDirectory },
});

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
    const config = runConfigOf(site.originA, join(workDirectory, 'indexed-db'));
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
    const controlConfig = runConfigOf(site.originA, join(workDirectory, 'indexed-db-control'));
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
  }, TEST_TIMEOUT_MS);
});

/** 親ドメインの Cookie の試験の host（`*.localhost` はループバックに解決される）。 */
const PARENT_DOMAIN = 'beak.localhost';
const APP_HOST = `app.${PARENT_DOMAIN}`;
const OTHER_HOST = `other.${PARENT_DOMAIN}`;
const PARENT_COOKIE = 'psid';
const PARENT_PATHS = Object.freeze({ set: '/set', admin: '/admin', adminPixel: '/admin/pixel.svg', otherPixel: '/pixel.svg', login: '/login' } as const);

/** サーバに届いた要求（host、path、受け取った Cookie の名前。値は記録しない）。 */
interface ReceivedRequest {
  readonly host: string;
  readonly path: string;
  readonly cookieNames: readonly string[];
}

const cookieNamesOf = (request: IncomingMessage): readonly string[] =>
  (request.headers.cookie ?? '').split(';').map((part) => part.trim().split('=')[0] ?? '').filter((name) => name.length > 0);

describe.each(LAUNCHERS)('DEF-139: a parent domain cookie of the login state is carried to the approved host only (%s)', (_name, launchBrowser) => {
  let workDirectory: string;
  let server: LoopbackHttpServer;
  let port = 0;
  const requests: ReceivedRequest[] = [];
  const browsers: Browser[] = [];
  const cookieValue = randomSecretValue();

  beforeAll(async () => {
    workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-parent-domain-cookie-'));
    server = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
      const host = (request.headers.host ?? '').split(':')[0] ?? '';
      const path = new URL(request.url ?? '/', `http://${host}`).pathname;
      requests.push({ host, path, cookieNames: cookieNamesOf(request) });
      if (host === APP_HOST && path === PARENT_PATHS.set) {
        // ログインの代わり: 親ドメインの Cookie を作る。
        response.writeHead(STATUS_OK, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'set-cookie': `${PARENT_COOKIE}=${cookieValue}; Domain=${PARENT_DOMAIN}; Path=/; HttpOnly; SameSite=Lax`,
        });
        response.end('<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Set</title><link rel="icon" href="data:,"></head><body>SET</body></html>');
        return;
      }
      if (host === APP_HOST && path === PARENT_PATHS.admin) {
        if (!cookieNamesOf(request).includes(PARENT_COOKIE)) {
          response.writeHead(STATUS_SEE_OTHER, { location: PARENT_PATHS.login });
          response.end();
          return;
        }
        response.writeHead(STATUS_OK, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end('<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Admin</title><link rel="icon" href="data:,"></head>'
          + `<body><main><h1>ADMIN</h1><img src="${PARENT_PATHS.adminPixel}" alt=""><img src="http://${OTHER_HOST}:${port}${PARENT_PATHS.otherPixel}" alt="">`
          + '</main></body></html>');
        return;
      }
      if (path === PARENT_PATHS.adminPixel || path === PARENT_PATHS.otherPixel) {
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

  const launch = async (): Promise<Browser> => {
    const browser = await launchBrowser();
    browsers.push(browser);
    return browser;
  };

  it('sends the parent domain cookie to the approved host, and not to another subdomain', async () => {
    const origin = `http://${APP_HOST}:${port}`;
    // ログインの段の代わり: 普通の Context で親ドメインの Cookie を作り、状態を読む（Chromium が `*.localhost` でドメインの Cookie を作れることも確かめる）。
    const loginBrowser = await launch();
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
      output: { directory: join(workDirectory, `run-${Date.now()}`) },
    });
    const result = await new RunCoordinator({
      config,
      launchBrowser: launch,
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
    const appRequests = requests.filter(({ host, path }) => host === APP_HOST && (path === PARENT_PATHS.admin || path === PARENT_PATHS.adminPixel));
    expect(appRequests.length).toBeGreaterThan(0);
    expect(appRequests.filter(({ cookieNames }) => !cookieNames.includes(PARENT_COOKIE))).toEqual([]);
    // ほかのサブドメインの資源の要求は届いたが、Cookie は付かなかった（許可の host だけの Cookie にして渡した）。
    const otherRequests = requests.filter(({ host }) => host === OTHER_HOST);
    expect(otherRequests.length).toBeGreaterThan(0);
    expect(otherRequests.filter(({ cookieNames }) => cookieNames.includes(PARENT_COOKIE))).toEqual([]);
    expect(placesWithMarkers(filesUnder(config.output.directory), [cookieValue])).toEqual([]);
  }, TEST_TIMEOUT_MS);
});
