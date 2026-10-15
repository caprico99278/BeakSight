/**
 * ビルドした画面を起動の部品（`launcher/serve.ts`）で 127.0.0.1 の空き port に起動し、画面のサーバの守りを確かめる
 * （Task 23 設計書 7 章「画面のサーバ」「画面」の一部。T23e）。先に `npm run build:ui` が要る。
 * T23f: 画面のサーバは起動の初めに管理データを準備するので、一時の root（`createTemporaryUiRoot`）に写して起動する
 * （リポジトリの `local-data/` を作らない）。Server Function の確かめは、画面からプロファイルを登録したときの要求を使う。
 */
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { Browser, Request as PlaywrightRequest } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCAL_UI_TEXT } from '../../../src/presentation/messages.js';
import { launchHeadlessChromium } from '../../../tests/helpers/chromium.js';
import { sessionCookieName } from '../launcher/request-guard.ts';
import {
  findFreePort,
  parseSetCookie,
  rawRequest,
  createTemporaryUiRoot,
  startLauncher,
  stopServer,
  type RawResponse,
  type StartedServer,
  type TemporaryUiRoot,
} from './helpers/local-server.ts';

/** すべての応答に付く header（値まで確かめるもの）。 */
const FIXED_SECURITY_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
});

/** CSP の nonce。 */
const CSP_NONCE_PATTERN = /'nonce-([A-Za-z0-9+/=]+)'/u;

/** 接続の試みを待つ上限（ミリ秒）。 */
const CONNECT_TIMEOUT_MS = 2_000;

/** Server Function の呼び出しを待つ上限（ミリ秒）。 */
const SERVER_FN_TIMEOUT_MS = 10_000;

const expectSecurityHeaders = (response: RawResponse, label: string): string => {
  for (const [name, value] of Object.entries(FIXED_SECURITY_HEADERS)) {
    expect(response.headers[name], `${label}: ${name}`).toBe(value);
  }
  const csp = response.headers['content-security-policy'];
  expect(typeof csp, `${label}: content-security-policy`).toBe('string');
  const cspText = String(csp);
  expect(cspText).toContain("default-src 'self'");
  expect(cspText).toContain("frame-ancestors 'none'");
  expect(cspText).not.toMatch(/unsafe-/u);
  return CSP_NONCE_PATTERN.exec(cspText)?.[1] ?? '';
};

/** `host:port` へ TCP で繋げるか（繋がらなければ誤りの code）。 */
const tryConnect = (host: string, port: number): Promise<string> =>
  new Promise((resolveResult) => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolveResult('TIMEOUT');
    }, CONNECT_TIMEOUT_MS);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolveResult('CONNECTED');
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolveResult(error.code ?? 'ERROR');
    });
  });

let root: TemporaryUiRoot | undefined;
let server: StartedServer | undefined;
let browser: Browser | undefined;
let cookie = '';
/** ブラウザが送った Server Function の要求（再送の確かめに使う）。 */
let serverFnCall: { readonly path: string; readonly headers: Readonly<Record<string, string>>; readonly body: string } | undefined;

const started = (): StartedServer => {
  if (server === undefined) {
    throw new Error('サーバが起動していない');
  }
  return server;
};

beforeAll(async () => {
  root = createTemporaryUiRoot('built');
  server = await startLauncher(root, await findFreePort());
  const exchange = await rawRequest(server.port, `${server.tokenUrl.pathname}${server.tokenUrl.search}`);
  cookie = parseSetCookie(exchange.headers['set-cookie'])?.pair ?? '';
  browser = await launchHeadlessChromium();
});

afterAll(async () => {
  await browser?.close();
  await stopServer(server);
  root?.remove();
});

describe('launcher: listening address', () => {
  it('listens on 127.0.0.1 only (::1 and LAN addresses do not connect)', async () => {
    const { port } = started();
    expect(await tryConnect('127.0.0.1', port)).toBe('CONNECTED');
    expect(await tryConnect('::1', port)).not.toBe('CONNECTED');
    const lanAddresses = Object.values(networkInterfaces())
      .flatMap((entries) => entries ?? [])
      .filter((entry) => !entry.internal)
      .map((entry) => entry.address);
    const results = await Promise.all(lanAddresses.map(async (address) => [address, await tryConnect(address, port)] as const));
    for (const [address, result] of results) {
      expect(result, address).not.toBe('CONNECTED');
    }
  });
});

describe('launcher: Host', () => {
  it('rejects localhost, other hosts and other ports with 421 (with the security headers)', async () => {
    const { port } = started();
    for (const host of [`localhost:${port}`, 'attacker.invalid', `attacker.invalid:${port}`, `127.0.0.1:${port + 1}`]) {
      const response = await rawRequest(port, '/', { host, headers: { cookie } });
      expect(response.status, host).toBe(421);
      expectSecurityHeaders(response, `421 ${host}`);
    }
  });
});

describe('launcher: token and cookie', () => {
  it('rejects requests without the cookie, and with a wrong token, with 401', async () => {
    const { port } = started();
    for (const path of ['/', '/assets/index.js', '/_serverFn/abc', '/?token=wrong']) {
      const response = await rawRequest(port, path, path.startsWith('/_serverFn') ? { method: 'POST', body: '{}' } : {});
      expect(response.status, path).toBe(401);
      expectSecurityHeaders(response, `401 ${path}`);
    }
    const wrongCookie = await rawRequest(port, '/', { headers: { cookie: `${sessionCookieName(port)}=wrong` } });
    expect(wrongCookie.status).toBe(401);
  });

  it('exchanges the console token for an HttpOnly, SameSite=Strict, Path=/ cookie and redirects with 303 without the token', async () => {
    const { port, tokenUrl } = started();
    const response = await rawRequest(port, `${tokenUrl.pathname}${tokenUrl.search}`);
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe('/');
    expectSecurityHeaders(response, '303');
    const setCookie = parseSetCookie(response.headers['set-cookie']);
    expect(setCookie?.pair.startsWith(`${sessionCookieName(port)}=`)).toBe(true);
    expect(setCookie?.attributes).toEqual(['HttpOnly', 'SameSite=Strict', 'Path=/']);
    expect(cookie).toBe(setCookie?.pair);
  });

  it('serves the page with the cookie; the CSP nonce changes per request and matches every inline script', async () => {
    const { port } = started();
    const first = await rawRequest(port, '/', { headers: { cookie, accept: 'text/html' } });
    const second = await rawRequest(port, '/', { headers: { cookie, accept: 'text/html' } });
    expect(first.status).toBe(200);
    const firstNonce = expectSecurityHeaders(first, '200');
    const secondNonce = expectSecurityHeaders(second, '200');
    expect(firstNonce).not.toBe('');
    expect(secondNonce).not.toBe(firstNonce);
    expect(first.body).toContain(LOCAL_UI_TEXT.pages.profiles);
    const scripts = [...first.body.matchAll(/<script\b([^>]*)>/gu)].map((match) => match[1] ?? '');
    const inlineScripts = scripts.filter((attributes) => !/\bsrc=/u.test(attributes));
    expect(inlineScripts.length).toBeGreaterThan(0);
    for (const attributes of scripts) {
      expect(attributes, attributes).toContain(`nonce="${firstNonce}"`);
    }
  });

  it('serves static files only with the cookie, and refuses paths outside dist/client', async () => {
    const { port } = started();
    const page = await rawRequest(port, '/', { headers: { cookie, accept: 'text/html' } });
    const asset = /src="(\/assets\/[^"]+\.js)"/u.exec(page.body)?.[1] ?? /href="(\/assets\/[^"]+\.js)"/u.exec(page.body)?.[1];
    expect(asset).toBeDefined();
    const withCookie = await rawRequest(port, asset ?? '/', { headers: { cookie } });
    expect(withCookie.status).toBe(200);
    expectSecurityHeaders(withCookie, 'static');
    expect((await rawRequest(port, asset ?? '/')).status).toBe(401);
    for (const path of ['/assets/..%2f..%2fserver%2fserver.js', '/..%2fserver%2fserver.js', '/assets/%2e%2e/%2e%2e/server/server.js']) {
      const response = await rawRequest(port, path, { headers: { cookie, accept: 'text/html' } });
      expect(response.status, path).toBe(404);
      expect(response.body).not.toContain('createServerEntry');
      expectSecurityHeaders(response, `404 ${path}`);
    }
  });
});

describe('launcher: browser and Server Function', () => {
  it('opens from the token URL in headless Chromium: the page renders, no CSP violation, no external request', async () => {
    const { origin, tokenUrl } = started();
    if (browser === undefined) {
      throw new Error('Chromium が起動していない');
    }
    const context = await browser.newContext();
    try {
      const requests: string[] = [];
      context.on('request', (request) => requests.push(request.url()));
      const page = await context.newPage();
      await page.addInitScript(() => {
        const violations: string[] = [];
        Object.defineProperty(window, '__cspViolations', { value: violations });
        document.addEventListener('securitypolicyviolation', (event) => violations.push(`${event.violatedDirective} ${event.blockedURI}`));
      });
      const consoleErrors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') {
          consoleErrors.push(message.text());
        }
      });
      page.on('pageerror', (error) => consoleErrors.push(String(error)));
      await page.goto(tokenUrl.href, { waitUntil: 'networkidle' });
      expect(page.url()).toBe(`${origin}/`);
      expect(await page.locator('h1').textContent()).toBe(LOCAL_UI_TEXT.pages.profiles);

      const cookies = await context.cookies(origin);
      expect(cookies).toHaveLength(1);
      expect(cookies[0]).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' });

      // 画面からプロファイルを登録し、そのときの Server Function（POST）の要求を記録する。
      await page.getByRole('link', { name: LOCAL_UI_TEXT.profileList.newProfile }).click();
      await page.getByLabel(LOCAL_UI_TEXT.profileForm.profileId).fill('t23e-csrf');
      await page.getByLabel(LOCAL_UI_TEXT.profileForm.targetConfigPath).selectOption('config/targets/example.json');
      const serverFnPost = page.waitForRequest(
        (request: PlaywrightRequest) => request.url().includes('/_serverFn/') && request.method() === 'POST',
        { timeout: SERVER_FN_TIMEOUT_MS },
      );
      await page.getByRole('button', { name: LOCAL_UI_TEXT.profileForm.save }).click();
      const sent = await serverFnPost;
      await page.getByText(LOCAL_UI_TEXT.profileForm.created).waitFor({ timeout: SERVER_FN_TIMEOUT_MS });
      const sentHeaders = await sent.allHeaders();
      serverFnCall = {
        path: new URL(sent.url()).pathname + new URL(sent.url()).search,
        headers: Object.fromEntries(Object.entries(sentHeaders).filter(([name]) => ['content-type', 'accept', 'x-tsr-serverfn'].includes(name))),
        body: sent.postData() ?? '',
      };

      const violations = await page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations);
      expect(violations).toEqual([]);
      expect(consoleErrors.filter((text) => /Content Security Policy/iu.test(text))).toEqual([]);
      expect(requests.filter((url) => !url.startsWith(`${origin}/`))).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it('Server Function: 200 from the same origin; 403 for cross-site, a different Origin, or neither (even with the cookie)', async () => {
    const { port, origin } = started();
    if (serverFnCall === undefined) {
      throw new Error('ブラウザの Server Function の要求を記録できていない');
    }
    const send = (extra: Readonly<Record<string, string>>): Promise<RawResponse> =>
      rawRequest(port, serverFnCall?.path ?? '/', { method: 'POST', headers: { ...serverFnCall?.headers, cookie, ...extra }, body: serverFnCall?.body ?? '' });

    const sameOrigin = await send({ 'sec-fetch-site': 'same-origin', origin });
    expect(sameOrigin.status).toBe(200);
    // 同じ登録の 2 回目なので、保存の部品が「既にある」で拒む（CSRF の確かめは通った）。
    expect(sameOrigin.body).toContain('PROFILE_ALREADY_EXISTS');
    expectSecurityHeaders(sameOrigin, 'serverFn 200');
    expect((await send({ origin })).status).toBe(200);

    for (const [label, extra] of [
      ['cross-site', { 'sec-fetch-site': 'cross-site', origin }],
      ['same-site', { 'sec-fetch-site': 'same-site', origin: `http://127.0.0.1:${port + 1}` }],
      ['origin mismatch', { origin: `http://127.0.0.1:${port + 1}` }],
      ['origin localhost', { origin: `http://localhost:${port}` }],
      ['neither', {}],
    ] as const) {
      const response = await send(extra);
      expect(response.status, label).toBe(403);
      expectSecurityHeaders(response, `serverFn 403 ${label}`);
    }
    const withoutCookie = await rawRequest(port, serverFnCall.path, { method: 'POST', headers: { ...serverFnCall.headers, 'sec-fetch-site': 'same-origin', origin }, body: serverFnCall.body });
    expect(withoutCookie.status).toBe(401);
  });
});
