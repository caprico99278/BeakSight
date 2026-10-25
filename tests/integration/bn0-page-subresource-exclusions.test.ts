// BN-0（設計書 `doc/design/2026-10-23-beaksight-bundle-beaksight-block-noise-design.md` 3.0。ユーザーの判断 2026-10-23）: 監査の段の Passive の Context では、
// ページが出す文書でない GET・HEAD に、危険な語と読まないパス・読む範囲（`AUDIT_EXCLUDED_URL`）の決まりを当てない。本物の `BrowserContextFactory` と Guard、
// 127.0.0.1 の自前のサーバ。Chromium はテストの既定の headless と、CLI の起動の設定の両方。届いたかは、サーバの記録で数える。
// - ページ自身の script（path に危険な語）・画像（path に危険な語）・データの GET（読まないパスの中、読む範囲の外）・HEAD は、サーバに届き、止まらない
//   （`READ_ONLY` と `PASS_EXCEPT_DELETE` の両方）。
// - 同じ除外の URL への文書の移動（`location.href`、BeakSight 自身の移動 = 巡回、iframe）は、今どおり止まり、届かない。
// - Isolated Interaction Context では、ページ自身の GET も今どおり止まり、届かない。
// - 読み取りでない送信の決まりは変わらない（`READ_ONLY` の POST は届かない）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import { CHROMIUM_CHANNEL } from '../../src/browser/chromium-launch.js';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
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
/** ページの要求がそろうのを待つ上限（ms）と、遅れて届く要求を待つ時間（ms）。 */
const IN_PAGE_SETTLE_TIMEOUT_MS = 10_000;
const LATE_REQUEST_WAIT_MS = 1_500;
const HTTP_OK = 200;

const PAGE_PATH = '/admin/page';
const EXCLUDED_DOCUMENT_PATH = '/private/page';
const EXCLUDED_FRAME_PATH = '/private/frame.html';
/** ページ自身が出す、除外に当たる文書でない GET・HEAD（path に危険な語、読まないパス、読む範囲の外）。 */
const PAGE_SUBRESOURCE_PATHS = Object.freeze([
  '/admin/assets/delete-helper.js',
  '/admin/assets/logout-icon.png',
  '/private/data.json',
  '/api/items',
  '/private/head-check',
]);
const POST_PATH = '/private/post';

/** 除外に当たる script・画像・fetch の GET と HEAD を読み、終わったら `data-done` を付ける画面。`nav` の query があれば、続けて除外の文書へ移る。 */
const PAGE_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>管理</title>
<script src="/admin/assets/delete-helper.js"></script></head><body><main><h1>管理</h1><img alt="i" src="/admin/assets/logout-icon.png"></main><script>
(async () => {
  await fetch('/private/data.json').then((r) => r.text(), () => 'err');
  await fetch('/api/items').then((r) => r.text(), () => 'err');
  await fetch('/private/head-check', { method: 'HEAD' }).then(() => 0, () => 0);
  await fetch('${POST_PATH}', { method: 'POST', body: 'x' }).then(() => 0, () => 0);
  const frame = document.createElement('iframe'); frame.src = '${EXCLUDED_FRAME_PATH}'; document.body.appendChild(frame);
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  document.documentElement.dataset.done = '1';
  if (location.search.includes('nav')) location.href = '${EXCLUDED_DOCUMENT_PATH}';
})();
</script></body></html>`;

/** BN-R0 fix round 1（I-1）: speculation rules の prerender だけを指定する画面と、その先（危険な語の URL）。 */
const PRERENDER_PAGE_PATH = '/admin/prerender-start';
const PRERENDER_TARGET_PATH = '/admin/prerender/logout';
const PRERENDER_PAGE_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>先読み</title>
<script type="speculationrules">{"prerender":[{"source":"list","urls":["${PRERENDER_TARGET_PATH}"],"eagerness":"immediate"}]}</script></head>
<body><main><h1>先読み</h1></main></body></html>`;
/** 先読みが起きるのを待つ時間（ms）。 */
const PRERENDER_SETTLE_MS = 3_000;

interface ServerRecord {
  readonly method: string;
  readonly path: string;
}

describe.each(LAUNCHERS)('BN-0: the page subresource reads and the audit stage exclusions with %s', (_label, launch) => {
  let browser: Browser;
  let app: LoopbackHttpServer;
  const records: ServerRecord[] = [];

  beforeAll(async () => {
    browser = await launch();
    app = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
      request.on('data', () => undefined);
      request.on('end', () => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (url.pathname !== BROWSER_DEFAULT_FAVICON_PATH) {
          records.push({ method: request.method ?? 'GET', path: url.pathname });
        }
        if (url.pathname === PRERENDER_PAGE_PATH) {
          response.writeHead(HTTP_OK, { 'content-type': 'text/html; charset=utf-8' }).end(PRERENDER_PAGE_HTML);
        } else if (url.pathname === PAGE_PATH || url.pathname === EXCLUDED_DOCUMENT_PATH || url.pathname === EXCLUDED_FRAME_PATH) {
          response.writeHead(HTTP_OK, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE_HTML);
        } else if (url.pathname.endsWith('.js')) {
          response.writeHead(HTTP_OK, { 'content-type': 'text/javascript' }).end('window.__helper = 1;');
        } else if (url.pathname.endsWith('.png')) {
          response.writeHead(HTTP_OK, { 'content-type': 'image/png' }).end();
        } else {
          response.writeHead(HTTP_OK, { 'content-type': 'application/json' }).end('{}');
        }
      });
    });
  });

  afterAll(async () => {
    await browser?.close();
    await app?.close();
  });

  /** 認証つきの factory（監査の段の除外: 読まないパス `/private`、読む範囲 `/admin`、既定の危険な語）。`auditSend` が真なら `PASS_EXCEPT_DELETE`。 */
  const factoryOf = (auditSend: boolean): BrowserContextFactory => {
    const config = fastRunConfig(app.origin, PAGE_PATH);
    return new BrowserContextFactory(browser, { ...config, site: { startUrl: `${app.origin}${PAGE_PATH}`, allowedOrigins: [app.origin] } }, () => new SafetyLedger(), {
      ...TEST_FACTORY_OPTIONS,
      authentication: {
        initialState: { cookies: [], origins: [] },
        filterState: (state) => state,
        auditExclusions: { excludedPathPrefixes: ['/private'], auditPathPrefixes: ['/admin'], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
      },
      ...(auditSend
        ? { auditSend: { policy: 'PASS_EXCEPT_DELETE' as const, approvedServiceOrigins: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS } }
        : {}),
    });
  };

  const arrivedSince = (start: number): readonly string[] => records.slice(start).map(({ method, path }) => `${method} ${path}`);

  it.each([false, true])('lets the page subresource GETs and HEAD that hit an exclusion reach the server on a page audit load (PASS_EXCEPT_DELETE: %s)', async (auditSend) => {
    const factory = factoryOf(auditSend);
    const start = records.length;
    try {
      const config = fastRunConfig(app.origin, PAGE_PATH);
      const context = await factory.createPassiveContext(config.viewports.primaryDesktop, 'PRIMARY', { pageAuditLoad: true });
      const page = await factory.createPassivePage(context);
      await page.goto(`${app.origin}${PAGE_PATH}`, { timeout: PAGE_TIMEOUT_MS });
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset['done']), { timeout: IN_PAGE_SETTLE_TIMEOUT_MS }).toBe('1');
      await wait(LATE_REQUEST_WAIT_MS);
      const snapshot = factory.getSafetyLedger(context).snapshot();
      const arrived = arrivedSince(start);
      expect(snapshot.invariantViolations).toEqual([]);
      // ページ自身の文書でない GET と HEAD は届き、除外の記録にない。
      for (const path of PAGE_SUBRESOURCE_PATHS) {
        expect(arrived.some((entry) => entry.endsWith(` ${path}`)), path).toBe(true);
      }
      const excludedPaths = (snapshot.blockedAuditExclusions?.events ?? []).map(({ url }) => new URL(url).pathname);
      expect(excludedPaths.filter((path) => PAGE_SUBRESOURCE_PATHS.includes(path))).toEqual([]);
      // 除外の子の frame の文書は、今どおり止まり、届かない。
      expect(snapshot.blockedAuditExclusions?.events.map(({ url, mainFrameNavigation, phase }) => ({ path: new URL(url).pathname, mainFrameNavigation, phase })))
        .toContainEqual({ path: EXCLUDED_FRAME_PATH, mainFrameNavigation: false, phase: 'LOAD' });
      expect(arrived).not.toContain(`GET ${EXCLUDED_FRAME_PATH}`);
      // 読み取りでない送信の決まりは変わらない（READ_ONLY は止める。PASS_EXCEPT_DELETE は読まないパスの POST を通さない）。
      expect(arrived).not.toContain(`POST ${POST_PATH}`);
      expect(snapshot.blockedRequests.map(({ method, url }) => `${method} ${new URL(url).pathname}`)).toContain(`POST ${POST_PATH}`);
      await factory.closePassiveContext(context);
    } finally {
      await factory.close();
    }
  }, TEST_TIMEOUT_MS);

  it('still stops the document loads of an excluded URL: the page navigation (location.href) and BeakSight own navigation (the crawl)', async () => {
    const factory = factoryOf(false);
    const start = records.length;
    try {
      const config = fastRunConfig(app.origin, PAGE_PATH);
      const context = await factory.createPassiveContext(config.viewports.primaryDesktop, 'PRIMARY', { pageAuditLoad: true });
      const page = await factory.createPassivePage(context);
      await page.goto(`${app.origin}${PAGE_PATH}?nav=1`, { timeout: PAGE_TIMEOUT_MS });
      await expect.poll(() => factory.getSafetyLedger(context).snapshot().blockedAuditExclusions?.events
        .some(({ url, mainFrameNavigation }) => mainFrameNavigation && new URL(url).pathname === EXCLUDED_DOCUMENT_PATH) ?? false,
      { timeout: IN_PAGE_SETTLE_TIMEOUT_MS }).toBe(true);
      // BeakSight 自身の移動（巡回の行き先）も止まる。
      await expect(page.goto(`${app.origin}${EXCLUDED_DOCUMENT_PATH}?via=crawl`, { timeout: PAGE_TIMEOUT_MS })).rejects.toThrow();
      await wait(LATE_REQUEST_WAIT_MS);
      const snapshot = factory.getSafetyLedger(context).snapshot();
      expect(snapshot.invariantViolations).toEqual([]);
      expect(snapshot.blockedAuditExclusions?.events.filter(({ url, mainFrameNavigation }) =>
        mainFrameNavigation && new URL(url).pathname === EXCLUDED_DOCUMENT_PATH)).toHaveLength(2);
      expect(arrivedSince(start)).not.toContain(`GET ${EXCLUDED_DOCUMENT_PATH}`);
      await factory.closePassiveContext(context);
    } finally {
      await factory.close();
    }
  }, TEST_TIMEOUT_MS);

  // BN-R0 fix round 1（I-1）: Guard を迂回した要求の 2 段目の守り。先読みを止める起動の引数のない Chromium（Playwright の既定の起動）では、speculation rules の
  // prerender の代わりの prefetch（`Sec-Purpose: prefetch;prerender`）が Guard を通らずに中継に来る。http の要求なら、中継は、Guard が通していない除外の URL への
  // GET を拒んで記録する（BN-0 の後も、中継は除外の URL への読み取りを、Guard の知らせがなければ通さない）。
  it('rejects at the egress a document prefetch to an excluded URL that bypasses the Guard (a Chromium launched without the preloading switches)', async () => {
    const raw = await chromium.launch(_label === 'the CLI Chromium' ? { headless: true, channel: CHROMIUM_CHANNEL } : { headless: true });
    const start = records.length;
    try {
      const config = fastRunConfig(app.origin, PAGE_PATH);
      const factory = new BrowserContextFactory(raw, { ...config, site: { startUrl: `${app.origin}${PAGE_PATH}`, allowedOrigins: [app.origin] } }, () => new SafetyLedger(), {
        ...TEST_FACTORY_OPTIONS,
        authentication: {
          initialState: { cookies: [], origins: [] },
          filterState: (state) => state,
          auditExclusions: { excludedPathPrefixes: ['/private'], auditPathPrefixes: ['/admin'], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
        },
      });
      try {
        const context = await factory.createPassiveContext(config.viewports.primaryDesktop, 'PRIMARY', { pageAuditLoad: true });
        const page = await factory.createPassivePage(context);
        await page.goto(`${app.origin}${PRERENDER_PAGE_PATH}`, { timeout: PAGE_TIMEOUT_MS });
        await wait(PRERENDER_SETTLE_MS);
        const snapshot = factory.getSafetyLedger(context).snapshot();
        expect(arrivedSince(start)).not.toContain(`GET ${PRERENDER_TARGET_PATH}`);
        expect(snapshot.blockedInteractionRequests.map(({ method, url, reason }) => `${method} ${new URL(url).pathname} ${reason}`))
          .toContain(`GET ${PRERENDER_TARGET_PATH} GUARD_BYPASS_EGRESS`);
        await factory.closePassiveContext(context);
      } finally {
        await factory.close();
      }
    } finally {
      await raw.close();
    }
    await wait(LATE_REQUEST_WAIT_MS);
    expect(arrivedSince(start)).not.toContain(`GET ${PRERENDER_TARGET_PATH}`);
  }, TEST_TIMEOUT_MS);

  it('still stops the page subresource GETs that hit an exclusion in the Isolated Interaction Context', async () => {
    const factory = factoryOf(true);
    const start = records.length;
    try {
      const config = fastRunConfig(app.origin, PAGE_PATH);
      const session = await factory.createInteractionSession(config.viewports.primaryDesktop);
      try {
        await session.page.goto(`${app.origin}${PAGE_PATH}`, { timeout: PAGE_TIMEOUT_MS });
        await expect.poll(() => session.page.evaluate(() => document.documentElement.dataset['done']), { timeout: IN_PAGE_SETTLE_TIMEOUT_MS }).toBe('1');
        await wait(LATE_REQUEST_WAIT_MS);
        const snapshot = session.ledger.snapshot();
        expect(snapshot.invariantViolations).toEqual([]);
        const excludedPaths = (snapshot.blockedAuditExclusions?.events ?? []).map(({ url }) => new URL(url).pathname);
        const arrived = arrivedSince(start);
        for (const path of PAGE_SUBRESOURCE_PATHS) {
          expect(excludedPaths, path).toContain(path);
          expect(arrived.some((entry) => entry.endsWith(` ${path}`)), path).toBe(false);
        }
      } finally {
        await session.close();
      }
    } finally {
      await factory.close();
    }
    await wait(LATE_REQUEST_WAIT_MS);
    expect(arrivedSince(start).filter(({ length }) => length > 0).filter((entry) => PAGE_SUBRESOURCE_PATHS.some((path) => entry.endsWith(` ${path}`)))).toEqual([]);
  }, TEST_TIMEOUT_MS);
});
