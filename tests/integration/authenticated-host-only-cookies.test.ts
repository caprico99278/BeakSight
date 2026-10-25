// T25g-3（独立レビュー T25R の M2。Task 25 の設計書 4.3 の「渡す前に絞る」）: 認証つきの Run で、ログインの状態の Domain 属性つきの Cookie
// （ドメインの先頭が `.`）を、絞り込み（`filterAuthenticatedState`）が host だけの Cookie にして渡すので、許可 Origin のサブドメインの資源の要求に、
// その Cookie が付かない。本物の Run Coordinator、factory、Guard と、このファイルの 127.0.0.1 の小さなサーバで確かめる（Chromium は `*.localhost`
// をループバックに解決する。`app.localhost` が許可 Origin、`sub.app.localhost` がそのサブドメイン）。Chromium は headless だけ（テストの既定と、
// CLI の起動の設定の両方）。
// - 許可 Origin の管理画面と、その画面の中の許可 Origin の資源の要求には、Cookie が付く（認証は保たれる）。
// - サブドメインの資源の要求には、Cookie が付かない（直す前は付いた）。
// 同じ host の別の port には、Cookie の決まりで送られうる（防げない。手順書に書く）。このテストでは確かめない。
import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { RunCoordinator } from '../../src/orchestration/run-coordinator.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { randomSecretValue } from '../helpers/authenticated-site-fixture.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { createTestConfig } from '../helpers/test-config.js';

const LAUNCHERS = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI launch settings', () => launchCliChromium()],
] as const;
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

/** サーバに届いた要求（host、path、受け取った Cookie の名前。値は記録しない）。 */
interface ReceivedRequest {
  readonly host: string;
  readonly path: string;
  readonly cookieNames: readonly string[];
}

const cookieNamesOf = (request: IncomingMessage): readonly string[] =>
  (request.headers.cookie ?? '').split(';').map((part) => part.trim().split('=')[0] ?? '').filter((name) => name.length > 0);

describe.each(LAUNCHERS)('T25g-3: a domain cookie of the login state is not sent to a subdomain (%s)', (_name, launch) => {
  let workDirectory: string;
  let server: LoopbackHttpServer;
  let port = 0;
  const requests: ReceivedRequest[] = [];
  const browsers: Browser[] = [];
  const sessionValue = randomSecretValue();

  beforeAll(async () => {
    workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-host-only-cookies-'));
    server = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
      const host = (request.headers.host ?? '').split(':')[0] ?? '';
      const path = new URL(request.url ?? '/', `http://${host}`).pathname;
      requests.push({ host, path, cookieNames: cookieNamesOf(request) });
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
});
