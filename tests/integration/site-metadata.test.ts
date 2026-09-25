// R15b（Task 14〜17 の設計書 5.6.2）: robots.txt と sitemap.xml を、Guard の付いた Passive Context の GET のナビゲーションで取得し、
// `metadata` の Evidence にする。sitemap の `<loc>` は、切り詰める前の本文から取り出して正規化する。
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { AuditConfig } from '../../src/config/types.js';
import type { EvidenceRecordFor } from '../../src/core/contracts.js';
import type { NormalizedHttpUrlEvidence } from '../../src/core/evidence-types.js';
import { MAX_SITE_METADATA_TEXT_LENGTH, MAX_SITEMAP_URLS } from '../../src/core/limits.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import {
  collectSiteMetadata,
  SITE_METADATA_DEFAULT_LIMITS,
  type SiteMetadataOptions,
  type SiteMetadataResult,
} from '../../src/crawl/site-metadata.js';
import { IdAllocator } from '../../src/orchestration/id-allocator.js';
import {
  PASSIVE_PAGE_CLOSE_DEADLINE_MESSAGE,
  PassiveContextCloseDeadlineError,
} from '../../src/orchestration/passive-session-close.js';
import { PASSIVE_SESSION_OPEN_DEADLINE_MESSAGE } from '../../src/orchestration/passive-session-open.js';
import { skippedPageResult } from '../../src/orchestration/skipped-page.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { startFixtureServer, type FixtureServer, type FixtureServerOptions } from '../../fixtures/server.js';
import { browserOpeningPageAfterNewContext } from '../helpers/browser-opening-page.js';
import { useHeadlessChromium } from '../helpers/chromium.js';
import { createTestConfig } from '../helpers/test-config.js';

const TEST_TIMEOUT_MS = 120_000;
const SHORT_NAVIGATION_TIMEOUT_MS = 1_000;
/** 注入する短い期限（ms。DEF-008、R15r-4）。実際の期限（`PAGE_CLOSE_TIMEOUT_MS` など）を待たない。 */
const INJECTED_TIMEOUT_MS = 300;
/** 期限を過ぎてから戻るまでの余裕。既定の期限（5 秒）を待った場合と区別できるよう、それより短くする。 */
const RETURN_MARGIN_MS = 3_000;
/** 期限のテストの上限。期限を守らない（既定の期限を待つか、止まり続ける）場合は、この時間で失敗する。 */
const DEADLINE_TEST_TIMEOUT_MS = 2 * INJECTED_TIMEOUT_MS + RETURN_MARGIN_MS + 2_000;
const OBSERVED_AT = new Date('2026-09-24T00:00:00.000Z');

let browser: Browser;
const fixtureServers: FixtureServer[] = [];
const customServers: Server[] = [];

useHeadlessChromium((launched) => {
  browser = launched;
});

afterEach(async () => {
  // 監査の後に Context が残っていたら、閉じたうえでテストを失敗にする。
  const leftoverContexts = browser.contexts();
  for (const context of leftoverContexts) {
    await context.close();
  }
  for (const server of fixtureServers.splice(0)) {
    await server.close();
  }
  for (const server of customServers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  expect(leftoverContexts, 'Contexts left in the browser after the test').toHaveLength(0);
});

async function startServer(options: FixtureServerOptions = {}): Promise<FixtureServer> {
  const server = await startFixtureServer(options);
  fixtureServers.push(server);
  return server;
}

/** テストだけで使う応答。`status` と `body` を返す。`hang` なら応答しない。 */
interface CustomResponse {
  readonly status?: number;
  readonly contentType?: string;
  readonly body?: string;
  readonly hang?: boolean;
}

/**
 * `/robots.txt` と `/sitemap.xml` に、テストが決めた応答を返すローカルのサーバ（fixture のサーバは、sitemap.xml を1種類しか返さないため）。
 * 本文の `{{ORIGIN}}` は、このサーバの Origin に置き換える。GET・HEAD 以外のリクエストの数も数える。
 */
async function startCustomServer(
  responses: Readonly<Record<string, CustomResponse>>,
): Promise<{ readonly origin: string; readonly nonReadRequests: () => number }> {
  let nonReadRequests = 0;
  const server = createServer((request, response: ServerResponse) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      nonReadRequests += 1;
    }
    const pathname = (request.url ?? '/').split(/[?#]/u, 1)[0] ?? '/';
    const entry = responses[pathname];
    if (entry?.hang === true) {
      return;
    }
    const origin = `http://127.0.0.1:${request.socket.localPort ?? 0}`;
    const body = (entry?.body ?? 'not found\n').replaceAll('{{ORIGIN}}', origin);
    response.statusCode = entry === undefined ? 404 : entry.status ?? 200;
    response.setHeader('Content-Type', entry?.contentType ?? 'text/plain; charset=utf-8');
    response.setHeader('Content-Length', Buffer.byteLength(body));
    response.end(request.method === 'HEAD' ? undefined : body);
  });
  customServers.push(server);
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('custom server did not bind to a TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
  return { origin: `http://127.0.0.1:${port}`, nonReadRequests: () => nonReadRequests };
}

interface CollectRun {
  readonly result: SiteMetadataResult;
  readonly options: SiteMetadataOptions;
  readonly config: AuditConfig;
}

async function collect(
  origin: string,
  overrides: Partial<Pick<SiteMetadataOptions, 'limits' | 'deadlines'>> & {
    readonly navigationTimeoutMs?: number;
    readonly browser?: Browser;
    readonly createFactory?: (config: AuditConfig) => BrowserContextFactory;
  } = {},
): Promise<CollectRun> {
  const config = createTestConfig(
    origin,
    '/',
    overrides.navigationTimeoutMs === undefined ? {} : { crawl: { navigationTimeoutMs: overrides.navigationTimeoutMs } },
  );
  const allocator = new IdAllocator();
  const options: SiteMetadataOptions = {
    contextFactory: overrides.createFactory?.(config)
      ?? new BrowserContextFactory(overrides.browser ?? browser, config, () => new SafetyLedger()),
    origin,
    config,
    pageId: allocator.allocatePageId(),
    allocator,
    clock: () => OBSERVED_AT,
    ...(overrides.limits === undefined ? {} : { limits: overrides.limits }),
    ...(overrides.deadlines === undefined ? {} : { deadlines: overrides.deadlines }),
  };
  const result = await collectSiteMetadata(options);
  return { result, options, config };
}

function normalized(url: string): NormalizedHttpUrlEvidence {
  return url as NormalizedHttpUrlEvidence;
}

/** Evidence が、page のスキーマの `metadata` の Evidence に合うかを、開始の URL のページの結果に置いて確かめる。 */
async function expectValidPageEvidence(run: CollectRun): Promise<void> {
  const page = skippedPageResult(normalized(`${run.options.origin}/`), run.options.pageId, {
    code: 'MAX_PAGES_REACHED',
    detail: null,
  });
  const withEvidence = { ...page, evidence: [...run.result.records] };
  await expect(validateArtifact('page', JSON.parse(JSON.stringify(withEvidence)) as unknown)).resolves.toEqual({ ok: true });
}

function robotsOf(result: SiteMetadataResult): EvidenceRecordFor<'metadata'> {
  return result.records[0];
}

function sitemapOf(result: SiteMetadataResult): EvidenceRecordFor<'metadata'> {
  return result.records[1];
}

describe('collectSiteMetadata', () => {
  it('records robots.txt and sitemap.xml as OK and extracts the normalized sitemap URLs', async () => {
    const server = await startServer();
    const run = await collect(server.origin);
    const { result } = run;

    expect(result.records).toHaveLength(2);
    for (const record of result.records) {
      expect(record).toMatchObject({ type: 'metadata', pageId: run.options.pageId, viewport: null });
      expect(record.observedAt).toBe(OBSERVED_AT.toISOString());
    }
    expect(robotsOf(result).payload).toEqual({
      kind: 'ROBOTS_TXT',
      url: `${server.origin}/robots.txt`,
      outcome: 'OK',
      httpStatus: 200,
      text: `User-agent: *\nDisallow:\n\nSitemap: ${server.origin}/sitemap.xml\n`,
      textTruncated: false,
      sitemapUrls: null,
      sitemapUrlsTruncated: false,
    });
    const sitemapPayload = sitemapOf(result).payload;
    expect(sitemapPayload).toMatchObject({
      kind: 'SITEMAP_XML',
      url: `${server.origin}/sitemap.xml`,
      outcome: 'OK',
      httpStatus: 200,
      textTruncated: false,
      sitemapUrlsTruncated: false,
    });
    expect(sitemapPayload.text).toContain('<urlset');
    const expectedUrls = ['index', 'level-1', 'level-2', 'sitemap-only'].map((name) => `${server.origin}/crawl/${name}.html`);
    expect(sitemapPayload.sitemapUrls).toEqual(expectedUrls);
    expect(result.sitemap).toEqual({ evidenceId: sitemapOf(result).evidenceId, urls: expectedUrls, truncated: false });
    expect(result.unnormalizableSitemapUrlCount).toBe(0);
    expect(result.failures).toEqual([]);
    expect(result.closeFailures).toEqual([]);
    expect(result.ledgerSnapshot).not.toBeNull();
    expect(result.ledgerSnapshot?.invariantViolationCount).toBe(0);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.records)).toBe(true);
    await expectValidPageEvidence(run);
  }, TEST_TIMEOUT_MS);

  it('records NOT_FOUND for both files when the site has neither (404)', async () => {
    const server = await startServer({ siteMetadata: false });
    const run = await collect(server.origin);
    const { result } = run;

    for (const [record, kind] of [[robotsOf(result), 'ROBOTS_TXT'], [sitemapOf(result), 'SITEMAP_XML']] as const) {
      expect(record.payload).toEqual({
        kind,
        url: `${server.origin}/${kind === 'ROBOTS_TXT' ? 'robots.txt' : 'sitemap.xml'}`,
        outcome: 'NOT_FOUND',
        httpStatus: 404,
        text: null,
        textTruncated: false,
        sitemapUrls: null,
        sitemapUrlsTruncated: false,
      });
    }
    expect(result.sitemap).toBeNull();
    expect(result.failures).toEqual([]);
    await expectValidPageEvidence(run);
  }, TEST_TIMEOUT_MS);

  it('marks the text and the sitemap URLs as truncated at smaller limits, extracting URLs from the untruncated text', async () => {
    const server = await startServer();
    const textOnly = await collect(server.origin, { limits: { maxTextLength: 10 } });
    expect(robotsOf(textOnly.result).payload).toMatchObject({ text: 'User-agent', textTruncated: true });
    expect(robotsOf(textOnly.result).payload.text).toHaveLength(10);
    expect(sitemapOf(textOnly.result).payload).toMatchObject({ textTruncated: true, sitemapUrlsTruncated: false });
    expect(sitemapOf(textOnly.result).payload.text).toHaveLength(10);
    // 本文を切り詰めても、URL は切り詰める前の本文から取り出す。
    expect(sitemapOf(textOnly.result).payload.sitemapUrls).toHaveLength(4);
    expect(textOnly.result.sitemap?.truncated).toBe(false);
    await expectValidPageEvidence(textOnly);

    const urlLimit = await collect(server.origin, { limits: { maxSitemapUrls: 2 } });
    expect(sitemapOf(urlLimit.result).payload).toMatchObject({
      textTruncated: false,
      sitemapUrls: [`${server.origin}/crawl/index.html`, `${server.origin}/crawl/level-1.html`],
      sitemapUrlsTruncated: true,
    });
    expect(urlLimit.result.sitemap?.truncated).toBe(true);
    await expectValidPageEvidence(urlLimit);

    // 差し替えの口は、本番の既定値を変えない。
    expect(SITE_METADATA_DEFAULT_LIMITS).toEqual({
      maxTextLength: MAX_SITE_METADATA_TEXT_LENGTH,
      maxSitemapUrls: MAX_SITEMAP_URLS,
    });
    expect(Object.isFrozen(SITE_METADATA_DEFAULT_LIMITS)).toBe(true);
  }, TEST_TIMEOUT_MS);

  it('handles CDATA, entities, comments, external URLs and unnormalizable URLs in the sitemap', async () => {
    const sitemap = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!-- <loc>{{ORIGIN}}/in-comment.html</loc> -->',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      '  <url><loc>\n    {{ORIGIN}}/plain.html\n  </loc></url>',
      '  <url><loc><![CDATA[{{ORIGIN}}/cdata.html?q=1&x=<y>]]></loc></url>',
      '  <url><loc>{{ORIGIN}}/entity.html?a=1&amp;b=&#50;&#x33;#top</loc></url>',
      '  <url><loc>https://other.invalid/external.html</loc></url>',
      '  <url><loc>not a url</loc></url>',
      '  <url><loc>mailto:someone@other.invalid</loc></url>',
      '  <url><loc>http://user:secret@other.invalid/credentials.html</loc></url>',
      '  <url><loc></loc></url>',
      '  <url><sm:loc xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9">{{ORIGIN}}/prefixed.html</sm:loc></url>',
      '  <url><location>{{ORIGIN}}/not-loc.html</location></url>',
      '</urlset>',
    ].join('\n');
    const server = await startCustomServer({
      '/robots.txt': { body: 'User-agent: *\n' },
      '/sitemap.xml': { contentType: 'application/xml', body: sitemap },
    });
    const run = await collect(server.origin);
    const payload = sitemapOf(run.result).payload;

    expect(payload.outcome).toBe('OK');
    expect(payload.sitemapUrls).toEqual([
      `${server.origin}/plain.html`,
      // 設定の既定では、query を残さない（`crawl.allowedQueryParameters` が空）。
      `${server.origin}/cdata.html`,
      `${server.origin}/entity.html`,
      // 許可 Origin の外の URL も、事実として残す。
      'https://other.invalid/external.html',
      `${server.origin}/prefixed.html`,
    ]);
    expect(payload.sitemapUrlsTruncated).toBe(false);
    // 正規化できないもの（解析できない、http(s) 以外、認証情報を含む、空）は、捨てずに件数を数える。
    expect(run.result.unnormalizableSitemapUrlCount).toBe(4);
    expect(server.nonReadRequests()).toBe(0);
    await expectValidPageEvidence(run);
  }, TEST_TIMEOUT_MS);

  it('keeps the entities of the query when allowed query parameters are configured', async () => {
    const server = await startCustomServer({
      '/robots.txt': { body: 'User-agent: *\n' },
      '/sitemap.xml': {
        contentType: 'application/xml',
        body: '<urlset><url><loc>{{ORIGIN}}/entity.html?b=&#50;&#x33;&amp;a=1&amp;z=9</loc></url></urlset>',
      },
    });
    const config = createTestConfig(server.origin, '/', { crawl: { allowedQueryParameters: ['a', 'b'] } });
    const allocator = new IdAllocator();
    const result = await collectSiteMetadata({
      contextFactory: new BrowserContextFactory(browser, config, () => new SafetyLedger()),
      origin: server.origin,
      config,
      pageId: allocator.allocatePageId(),
      allocator,
      clock: () => OBSERVED_AT,
    });
    expect(sitemapOf(result).payload.sitemapUrls).toEqual([`${server.origin}/entity.html?a=1&b=23`]);
  }, TEST_TIMEOUT_MS);

  it('does not follow a sitemap index and leaves no page URLs, keeping the nested sitemap URLs in the text (R15d)', async () => {
    const server = await startCustomServer({
      '/robots.txt': { body: 'User-agent: *\n' },
      '/sitemap.xml': {
        contentType: 'application/xml',
        body: [
          '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
          '  <sitemap><loc>{{ORIGIN}}/sitemap-pages.xml</loc></sitemap>',
          '  <sitemap><loc>{{ORIGIN}}/sitemap-posts.xml</loc></sitemap>',
          '</sitemapindex>',
        ].join('\n'),
      },
      '/sitemap-pages.xml': {
        contentType: 'application/xml',
        body: '<urlset><url><loc>{{ORIGIN}}/nested.html</loc></url></urlset>',
      },
    });
    const run = await collect(server.origin);
    const payload = sitemapOf(run.result).payload;

    // 入れ子の sitemap の URL は、ページの URL ではない。そのため、`sitemapUrls` は null にし、Cross-page rule の sitemap の
    // 2つの Rule に判定させない（Task 14〜17 の設計書 5.6.2）。入れ子の URL は、本文に事実として残る。
    expect(payload).toMatchObject({ outcome: 'OK', httpStatus: 200, sitemapUrls: null, sitemapUrlsTruncated: false });
    expect(payload.text).toContain(`${server.origin}/sitemap-pages.xml`);
    expect(payload.text).toContain(`${server.origin}/sitemap-posts.xml`);
    expect(run.result.sitemap).toBeNull();
    expect(run.result.unnormalizableSitemapUrlCount).toBe(0);
    await expectValidPageEvidence(run);
  }, TEST_TIMEOUT_MS);

  it('does not extract URLs from a 2xx body that is not a sitemap', async () => {
    const server = await startCustomServer({
      '/robots.txt': { body: 'User-agent: *\n' },
      '/sitemap.xml': { contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>app</title><p>fallback</p>' },
    });
    const run = await collect(server.origin);
    expect(sitemapOf(run.result).payload).toMatchObject({
      outcome: 'OK',
      httpStatus: 200,
      sitemapUrls: null,
      sitemapUrlsTruncated: false,
    });
    expect(run.result.sitemap).toBeNull();
    await expectValidPageEvidence(run);
  }, TEST_TIMEOUT_MS);

  it('records 410 as NOT_FOUND, other statuses as FAILED, and a navigation timeout as FAILED', async () => {
    const statuses = await startCustomServer({
      '/robots.txt': { status: 410, body: 'gone\n' },
      '/sitemap.xml': { status: 500, body: 'error\n' },
    });
    const statusRun = await collect(statuses.origin);
    expect(robotsOf(statusRun.result).payload).toMatchObject({ outcome: 'NOT_FOUND', httpStatus: 410, text: null });
    expect(sitemapOf(statusRun.result).payload).toMatchObject({
      outcome: 'FAILED',
      httpStatus: 500,
      text: null,
      sitemapUrls: null,
    });
    expect(statusRun.result.failures).toEqual([]);
    await expectValidPageEvidence(statusRun);

    const hanging = await startCustomServer({
      '/robots.txt': { hang: true },
      '/sitemap.xml': { contentType: 'application/xml', body: '<urlset><url><loc>{{ORIGIN}}/a.html</loc></url></urlset>' },
    });
    const timeoutRun = await collect(hanging.origin, { navigationTimeoutMs: SHORT_NAVIGATION_TIMEOUT_MS });
    expect(robotsOf(timeoutRun.result).payload).toMatchObject({ outcome: 'FAILED', httpStatus: null, text: null });
    expect(timeoutRun.result.failures).toEqual([
      { kind: 'ROBOTS_TXT', timedOut: true, detail: expect.any(String) as unknown },
    ]);
    // 1つ目の失敗の後も、2つ目を取得する。終わらなかったナビゲーションを次のナビゲーションで中断しないので、Guard の違反にならない。
    expect(sitemapOf(timeoutRun.result).payload).toMatchObject({ outcome: 'OK', sitemapUrls: [`${hanging.origin}/a.html`] });
    expect(timeoutRun.result.ledgerSnapshot?.invariantViolationCount).toBe(0);
    expect(timeoutRun.result.closeFailures).toEqual([]);
    await expectValidPageEvidence(timeoutRun);
  }, TEST_TIMEOUT_MS);

  it('sends only GET requests for robots.txt and sitemap.xml, and does not follow sitemap URLs', async () => {
    const server = await startServer();
    server.resetCounters();
    server.resetRequestObservations();
    await collect(server.origin);

    const counters = server.getCounters();
    expect(counters).toMatchObject({ post: 0, put: 0, patch: 0, delete: 0, options: 0, other: 0, webSocketUpgrade: 0 });
    const requests = server.getRequestObservations().map(({ method, pathname }) => `${method} ${pathname}`);
    expect(requests.filter((request) => request !== 'GET /favicon.ico')).toEqual(['GET /robots.txt', 'GET /sitemap.xml']);
  }, TEST_TIMEOUT_MS);

  it('leaves no Context behind, and returns FAILED Evidence when the Passive Context cannot be constructed', async () => {
    const server = await startServer();
    await collect(server.origin);
    expect(browser.contexts()).toHaveLength(0);

    server.resetRequestObservations();
    const failing = await collect(server.origin, { browser: browserOpeningPageAfterNewContext(browser) });
    for (const record of failing.result.records) {
      expect(record.payload).toMatchObject({ outcome: 'FAILED', httpStatus: null, text: null, sitemapUrls: null });
    }
    expect(failing.result.sitemap).toBeNull();
    expect(failing.result.failures.map(({ kind }) => kind)).toEqual(['ROBOTS_TXT', 'SITEMAP_XML']);
    // Guard の取り付けの失敗は、Ledger の違反として残る。
    expect(failing.result.ledgerSnapshot?.invariantViolationCount).toBeGreaterThan(0);
    expect(server.getRequestObservations()).toEqual([]);
    expect(browser.contexts()).toHaveLength(0);
    await expectValidPageEvidence(failing);
  }, TEST_TIMEOUT_MS);

  // R15 の Minor-1（DEF-006 と同じ扱い）: 前の page を閉じる処理が終わらない場合は、`PAGE_CLOSE_TIMEOUT_MS` で見切り、
  // その Context での取得をやめて、Context を閉じる処理に進む。
  it('stops using the Context and closes it when closing the previous page does not finish before its deadline', async () => {
    const server = await startServer();
    class HangingPageCloseFactory extends BrowserContextFactory {
      override async closePassivePage(): Promise<void> {
        await new Promise<never>(() => undefined);
      }
    }
    server.resetRequestObservations();

    const startedAt = performance.now();
    const run = await collect(server.origin, {
      createFactory: (config) => new HangingPageCloseFactory(browser, config, () => new SafetyLedger()),
      // 期限は注入する（R15r-4。実際の 5 秒を待たない）。
      deadlines: { pageCloseTimeoutMs: INJECTED_TIMEOUT_MS },
    });
    const elapsedMs = performance.now() - startedAt;
    const { result } = run;
    expect(elapsedMs).toBeLessThan(INJECTED_TIMEOUT_MS + RETURN_MARGIN_MS);

    expect(result.closeFailures).toHaveLength(1);
    expect(result.closeFailures[0]?.step).toBe('page');
    expect((result.closeFailures[0]?.error as Error).message).toBe(PASSIVE_PAGE_CLOSE_DEADLINE_MESSAGE);
    expect(robotsOf(result).payload).toMatchObject({ outcome: 'OK', httpStatus: 200 });
    expect(sitemapOf(result).payload).toMatchObject({ outcome: 'FAILED', httpStatus: null, text: null, sitemapUrls: null });
    expect(result.failures).toEqual([{ kind: 'SITEMAP_XML', timedOut: false, detail: PASSIVE_PAGE_CLOSE_DEADLINE_MESSAGE }]);
    expect(result.ledgerSnapshot?.invariantViolationCount).toBe(0);
    expect(server.getRequestObservations().map(({ pathname }) => pathname)).not.toContain('/sitemap.xml');
    expect(browser.contexts()).toHaveLength(0);
    await expectValidPageEvidence(run);
  }, TEST_TIMEOUT_MS);

  // DEF-008（Task 18 の前の整理の設計書 4.4）: Context と page の作成、Context を閉じる処理が終わらない場合も、期限の中で戻る。
  // 作成が期限を過ぎた場合は、今の取得の失敗と同じく `FAILED` にする。閉じる処理の期限切れは、`closeFailures` に記録する。
  it('returns FAILED Evidence within the open deadline when creating the Passive Context does not finish', async () => {
    const server = await startServer();
    class HangingContextFactory extends BrowserContextFactory {
      override async createPassiveContext(): Promise<BrowserContext> {
        return new Promise<never>(() => undefined);
      }
    }
    server.resetRequestObservations();

    const startedAt = performance.now();
    const run = await collect(server.origin, {
      createFactory: (config) => new HangingContextFactory(browser, config, () => new SafetyLedger()),
      deadlines: { sessionOpenTimeoutMs: INJECTED_TIMEOUT_MS },
    });
    const elapsedMs = performance.now() - startedAt;
    const { result } = run;

    expect(elapsedMs).toBeLessThan(INJECTED_TIMEOUT_MS + RETURN_MARGIN_MS);
    for (const record of result.records) {
      expect(record.payload).toMatchObject({ outcome: 'FAILED', httpStatus: null, text: null, sitemapUrls: null });
    }
    expect(result.failures).toEqual([
      { kind: 'ROBOTS_TXT', timedOut: true, detail: PASSIVE_SESSION_OPEN_DEADLINE_MESSAGE },
      { kind: 'SITEMAP_XML', timedOut: true, detail: PASSIVE_SESSION_OPEN_DEADLINE_MESSAGE },
    ]);
    expect(result.sitemap).toBeNull();
    expect(result.ledgerSnapshot).toBeNull();
    expect(result.closeFailures).toEqual([]);
    expect(server.getRequestObservations()).toEqual([]);
    await expectValidPageEvidence(run);
  }, DEADLINE_TEST_TIMEOUT_MS);

  it('closes the Context and returns FAILED Evidence within the open deadline when creating the page does not finish', async () => {
    const server = await startServer();
    class HangingPageFactory extends BrowserContextFactory {
      override async createPassivePage(): Promise<Page> {
        return new Promise<never>(() => undefined);
      }
    }
    server.resetRequestObservations();

    const startedAt = performance.now();
    const run = await collect(server.origin, {
      createFactory: (config) => new HangingPageFactory(browser, config, () => new SafetyLedger()),
      deadlines: { sessionOpenTimeoutMs: INJECTED_TIMEOUT_MS },
    });
    const elapsedMs = performance.now() - startedAt;
    const { result } = run;

    expect(elapsedMs).toBeLessThan(INJECTED_TIMEOUT_MS + RETURN_MARGIN_MS);
    for (const record of result.records) {
      expect(record.payload).toMatchObject({ outcome: 'FAILED', httpStatus: null, text: null, sitemapUrls: null });
    }
    // page の作成が期限を過ぎたら、その Context での取得をやめる（Context は、部品が閉じた）。
    expect(result.failures).toEqual([
      { kind: 'ROBOTS_TXT', timedOut: true, detail: PASSIVE_SESSION_OPEN_DEADLINE_MESSAGE },
      { kind: 'SITEMAP_XML', timedOut: true, detail: PASSIVE_SESSION_OPEN_DEADLINE_MESSAGE },
    ]);
    expect(result.ledgerSnapshot?.invariantViolationCount).toBe(0);
    expect(result.closeFailures).toEqual([]);
    expect(server.getRequestObservations()).toEqual([]);
    expect(browser.contexts()).toHaveLength(0);
    await expectValidPageEvidence(run);
  }, DEADLINE_TEST_TIMEOUT_MS);

  it('records the Context close deadline in closeFailures when closing the Context does not finish', async () => {
    const server = await startServer();
    class HangingContextCloseFactory extends BrowserContextFactory {
      override async closePassiveContext(): Promise<void> {
        await new Promise<never>(() => undefined);
      }
    }

    const startedAt = performance.now();
    const run = await collect(server.origin, {
      createFactory: (config) => new HangingContextCloseFactory(browser, config, () => new SafetyLedger()),
      deadlines: { contextCloseTimeoutMs: INJECTED_TIMEOUT_MS },
    });
    const elapsedMs = performance.now() - startedAt;
    const { result } = run;
    // 閉じきれなかった Context は、テストが閉じる（後片付けの確認で、残った Context を失敗にするため）。
    for (const context of browser.contexts()) {
      await context.close();
    }

    expect(elapsedMs).toBeLessThan(INJECTED_TIMEOUT_MS + RETURN_MARGIN_MS);
    expect(robotsOf(result).payload).toMatchObject({ outcome: 'OK', httpStatus: 200 });
    expect(sitemapOf(result).payload).toMatchObject({ outcome: 'OK', httpStatus: 200 });
    expect(result.failures).toEqual([]);
    expect(result.closeFailures).toHaveLength(1);
    expect(result.closeFailures[0]?.step).toBe('context');
    expect(result.closeFailures[0]?.error).toBeInstanceOf(PassiveContextCloseDeadlineError);
    await expectValidPageEvidence(run);
  }, DEADLINE_TEST_TIMEOUT_MS);

  it('throws only for invalid arguments', async () => {
    const server = await startServer();
    await expect(collect(server.origin, { deadlines: { sessionOpenTimeoutMs: 0 } })).rejects.toThrow(RangeError);
    await expect(collect(server.origin, { deadlines: { contextCloseTimeoutMs: 1.5 } })).rejects.toThrow(RangeError);
    await expect(collect('not an origin')).rejects.toThrow(RangeError);
    await expect(collect(`${server.origin}/path`)).rejects.toThrow(RangeError);
    const config = createTestConfig(server.origin);
    const allocator = new IdAllocator();
    const base: SiteMetadataOptions = {
      contextFactory: new BrowserContextFactory(browser, config, () => new SafetyLedger()),
      origin: 'http://127.0.0.1:1',
      config,
      pageId: allocator.allocatePageId(),
      allocator,
      clock: () => OBSERVED_AT,
    };
    // 許可 Origin の外の Origin は、取得しない。
    await expect(collectSiteMetadata(base)).rejects.toThrow(RangeError);
    await expect(collectSiteMetadata({ ...base, origin: server.origin, limits: { maxSitemapUrls: -1 } })).rejects.toThrow(
      RangeError,
    );
    await expect(
      collectSiteMetadata({ ...base, origin: server.origin, clock: 'now' as unknown as () => Date }),
    ).rejects.toThrow(TypeError);
    expect(browser.contexts()).toHaveLength(0);
  }, TEST_TIMEOUT_MS);
});
