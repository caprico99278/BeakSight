// R15b（Task 14〜17 の設計書 5.6.2）: robots.txt と sitemap.xml を、Guard の付いた Passive Context の GET のナビゲーションで取得し、
// `metadata` の Evidence にする。sitemap の `<loc>` は、切り詰める前の本文から取り出して正規化する。
import { readFile } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chromiumLaunchOptions } from '../../src/browser/chromium-launch.js';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { MainFrameLoadObservation } from '../../src/browser/main-frame-load.js';
import type { AuditConfig } from '../../src/config/types.js';
import type { EvidenceRecordFor } from '../../src/core/contracts.js';
import { wait } from '../../src/core/deadline.js';
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
import { PassiveContextCloseDeadlineError } from '../../src/orchestration/passive-session-close.js';
import { PASSIVE_SESSION_OPEN_DEADLINE_MESSAGE } from '../../src/orchestration/passive-session-open.js';
import { siteUnavailabilityOf } from '../../src/orchestration/site-availability.js';
import { skippedPageResult } from '../../src/orchestration/skipped-page.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { startFixtureServer, type FixtureServer, type FixtureServerOptions } from '../../fixtures/server.js';
import { browserOpeningPageAfterNewContext } from '../helpers/browser-opening-page.js';
import { BROWSER_DEFAULT_FAVICON_PATH, useHeadlessChromium } from '../helpers/chromium.js';
import {
  FROZEN_POPUP_LATE_DELIVERY_SETTLE_MS,
  QUIET_PERIOD_MS,
  UNLOAD_BEACON_CLOSE_ROUNDS,
  UNLOAD_BEACON_PAGE,
  UNLOAD_BEACON_ROUNDS_TEST_TIMEOUT_MS,
} from '../helpers/gate-harness.js';
import { createTestConfig } from '../helpers/test-config.js';

const TEST_TIMEOUT_MS = 120_000;
/** 取得するファイルの数（robots.txt と sitemap.xml）。結果の `records` の長さと同じ。 */
const SITE_METADATA_FILE_COUNT = 2;
const SHORT_NAVIGATION_TIMEOUT_MS = 1_000;
/** 注入する短い期限（ms。DEF-008、R15r-4）。実際の期限（`PAGE_CLOSE_TIMEOUT_MS` など）を待たない。 */
const INJECTED_TIMEOUT_MS = 300;
/** 期限を過ぎてから戻るまでの余裕。既定の期限（5 秒）を待った場合と区別できるよう、それより短くする。 */
const RETURN_MARGIN_MS = 3_000;
/** 期限のテストの上限。期限を守らない（既定の期限を待つか、止まり続ける）場合は、この時間で失敗する。 */
const DEADLINE_TEST_TIMEOUT_MS = 2 * INJECTED_TIMEOUT_MS + RETURN_MARGIN_MS + 2_000;
const OBSERVED_AT = new Date('2026-09-24T00:00:00.000Z');
/**
 * 待たない、ページの読み込みの間隔の待ち（RL-fix。RL の Minor-5）。metadata の取得の間隔の待ちは省略できないので、間隔を確かめない
 * テストは、待たないことを、この関数で明示して渡す。
 */
const NO_PACING_WAIT = async (): Promise<number> => 0;

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

/**
 * テストだけで使う応答。`status` と `body` を返す。`hang` なら応答しない。`stallAfterHeaders` なら、ヘッダ（長さは書かない）と本文の始まり
 * （`STALLED_HTML_START`）を送り、本文を止める（`end` しない）。
 */
interface CustomResponse {
  readonly status?: number;
  readonly contentType?: string;
  readonly body?: string;
  readonly hang?: boolean;
  readonly stallAfterHeaders?: boolean;
}

/** 本文を止める応答で送る、本文の始まり（HTML の文書の途中）。 */
const STALLED_HTML_START = '<!doctype html><html><head><title>stalled</title></head><body><p>the first part</p>';

/**
 * `/robots.txt` と `/sitemap.xml` に、テストが決めた応答を返すローカルのサーバ（fixture のサーバは、sitemap.xml を1種類しか返さないため）。
 * 本文の `{{ORIGIN}}` は、このサーバの Origin に置き換える。GET・HEAD 以外のリクエストの数と、受けた要求のパス（受けた順）も記録する。
 */
async function startCustomServer(
  responses: Readonly<Record<string, CustomResponse>>,
): Promise<{
  readonly origin: string;
  readonly nonReadRequests: () => number;
  /** 受けた要求のパス（受けた順。ブラウザ自身のアイコンの要求 `BROWSER_DEFAULT_FAVICON_PATH` は除く）。 */
  readonly requestedPaths: () => readonly string[];
}> {
  let nonReadRequests = 0;
  const requestedPaths: string[] = [];
  const server = createServer((request, response: ServerResponse) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      nonReadRequests += 1;
    }
    const pathname = (request.url ?? '/').split(/[?#]/u, 1)[0] ?? '/';
    if (pathname !== BROWSER_DEFAULT_FAVICON_PATH) {
      requestedPaths.push(pathname);
    }
    const entry = responses[pathname];
    if (entry?.hang === true) {
      return;
    }
    if (entry?.stallAfterHeaders === true) {
      response.writeHead(entry.status ?? 200, { 'Content-Type': entry.contentType ?? 'text/html; charset=utf-8' });
      response.write(STALLED_HTML_START);
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
  return {
    origin: `http://127.0.0.1:${port}`,
    nonReadRequests: () => nonReadRequests,
    requestedPaths: () => [...requestedPaths],
  };
}

interface CollectRun {
  readonly result: SiteMetadataResult;
  readonly options: SiteMetadataOptions;
  readonly config: AuditConfig;
}

async function collect(
  origin: string,
  overrides: Partial<Pick<SiteMetadataOptions, 'limits' | 'deadlines' | 'beforeNavigation' | 'afterNavigation'>> & {
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
    // 間隔の待ちは省略できない（RL-fix）。間隔を確かめないテストは、待たないことを明示して渡す。
    beforeNavigation: overrides.beforeNavigation ?? NO_PACING_WAIT,
    ...(overrides.afterNavigation === undefined ? {} : { afterNavigation: overrides.afterNavigation }),
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
      beforeNavigation: NO_PACING_WAIT,
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

  // DEF-038（設計書 `2026-10-08-beaksight-def-038-passive-page-close-design.md` の変更履歴の DEF-038-fix の Blocker）: robots.txt を
  // HTML として返し、そのページが離れるとき（`pagehide`・`visibilitychange`）に POST を送っても、サーバに届かない。前の page
  // （robots.txt）は個別に閉じず、最後に Context と一緒に閉じる。`UNLOAD_BEACON_CLOSE_ROUNDS` 回くり返し、全部の回の後に
  // `FROZEN_POPUP_LATE_DELIVERY_SETTLE_MS` 待ってから、改めて確かめる。
  it('delivers no POST sent while the robots.txt page (served as HTML) is being left, and records no violation (DEF-038)', async () => {
    const unloadBeaconHtml = await readFile(new URL(`../../fixtures/site${UNLOAD_BEACON_PAGE}`, import.meta.url), 'utf8');
    const server = await startCustomServer({
      '/robots.txt': { contentType: 'text/html; charset=utf-8', body: unloadBeaconHtml },
      '/sitemap.xml': { contentType: 'application/xml', body: '<urlset><url><loc>{{ORIGIN}}/a.html</loc></url></urlset>' },
    });
    const failedRounds: unknown[] = [];

    for (let round = 0; round < UNLOAD_BEACON_CLOSE_ROUNDS; round += 1) {
      const before = server.nonReadRequests();
      const { result } = await collect(server.origin);
      await wait(QUIET_PERIOD_MS);
      const summary = {
        round,
        delivered: server.nonReadRequests() - before,
        robots: robotsOf(result).payload.outcome,
        sitemap: sitemapOf(result).payload.outcome,
        invariantViolations: result.ledgerSnapshot?.invariantViolations,
        closeFailures: result.closeFailures.map(({ step, error }) => ({ step, error: String(error) })),
        contexts: browser.contexts().length,
      };
      if (
        summary.delivered !== 0
        || summary.robots !== 'OK'
        || summary.sitemap !== 'OK'
        || summary.invariantViolations?.length !== 0
        || summary.closeFailures.length !== 0
        || summary.contexts !== 0
      ) {
        failedRounds.push(summary);
      }
    }
    await wait(FROZEN_POPUP_LATE_DELIVERY_SETTLE_MS);

    expect(failedRounds).toEqual([]);
    expect(server.nonReadRequests()).toBe(0);
  }, UNLOAD_BEACON_ROUNDS_TEST_TIMEOUT_MS);

  it('sends only GET requests for robots.txt and sitemap.xml, and does not follow sitemap URLs', async () => {
    const server = await startServer();
    server.resetCounters();
    server.resetRequestObservations();
    await collect(server.origin);

    const counters = server.getCounters();
    expect(counters).toMatchObject({ post: 0, put: 0, patch: 0, delete: 0, options: 0, other: 0, webSocketUpgrade: 0 });
    const requests = server.getRequestObservations().map(({ method, pathname }) => `${method} ${pathname}`);
    expect(requests.filter((request) => request !== `GET ${BROWSER_DEFAULT_FAVICON_PATH}`)).toEqual(['GET /robots.txt', 'GET /sitemap.xml']);
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

  // DEF-038（決まりの変更。以前は R15 の Minor-1: 前の page を閉じる処理が終わらない場合は、期限で見切り、その Context での取得を
  // やめることを確かめていた）: 前の page（robots.txt）は個別に閉じずに残し、最後に Context と一緒に閉じる。page を閉じる処理を
  // 呼ばないので、それが止まる場合も待たず、sitemap.xml も取得する。
  it('does not close the previous page by itself, so a page close that would not finish neither delays nor stops the collection (DEF-038)', async () => {
    const server = await startServer();
    const pageCloseCalls: number[] = [];
    const openPages: Page[] = [];
    class HangingPageCloseFactory extends BrowserContextFactory {
      override async createPassivePage(context: BrowserContext): Promise<Page> {
        const page = await super.createPassivePage(context);
        openPages.push(page);
        return page;
      }

      override async closePassivePage(): Promise<void> {
        pageCloseCalls.push(performance.now());
        await new Promise<never>(() => undefined);
      }
    }
    server.resetRequestObservations();
    const pagesOpenWhenSitemapLoads: boolean[] = [];

    const startedAt = performance.now();
    const run = await collect(server.origin, {
      createFactory: (config) => new HangingPageCloseFactory(browser, config, () => new SafetyLedger()),
      // 期限は注入する（R15r-4。以前のこの場面で、実際の 5 秒を待たないため。今は読まない。DEF-038）。
      deadlines: { pageCloseTimeoutMs: INJECTED_TIMEOUT_MS },
      afterNavigation: () => {
        // 2つ目（sitemap.xml）の読み込みの時点で、前の page（robots.txt）が開いたままであること。
        if (openPages.length === SITE_METADATA_FILE_COUNT) {
          pagesOpenWhenSitemapLoads.push(...openPages.map((page) => !page.isClosed()));
        }
      },
    });
    const elapsedMs = performance.now() - startedAt;
    const { result } = run;
    expect(elapsedMs).toBeLessThan(INJECTED_TIMEOUT_MS + RETURN_MARGIN_MS);

    expect(pageCloseCalls).toEqual([]);
    expect(pagesOpenWhenSitemapLoads).toEqual([true, true]);
    expect(openPages.every((page) => page.isClosed())).toBe(true);
    expect(result.closeFailures).toEqual([]);
    expect(robotsOf(result).payload).toMatchObject({ outcome: 'OK', httpStatus: 200 });
    expect(sitemapOf(result).payload).toMatchObject({ outcome: 'OK', httpStatus: 200 });
    expect(result.failures).toEqual([]);
    expect(result.ledgerSnapshot?.invariantViolationCount).toBe(0);
    expect(server.getRequestObservations().map(({ pathname }) => pathname)).toContain('/sitemap.xml');
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
      beforeNavigation: NO_PACING_WAIT,
    };
    // 許可 Origin の外の Origin は、取得しない。
    await expect(collectSiteMetadata(base)).rejects.toThrow(RangeError);
    await expect(collectSiteMetadata({ ...base, origin: server.origin, limits: { maxSitemapUrls: -1 } })).rejects.toThrow(
      RangeError,
    );
    await expect(
      collectSiteMetadata({ ...base, origin: server.origin, clock: 'now' as unknown as () => Date }),
    ).rejects.toThrow(TypeError);
    await expect(
      collectSiteMetadata({ ...base, origin: server.origin, beforeNavigation: 'wait' as unknown as () => Promise<number> }),
    ).rejects.toThrow(TypeError);
    expect(browser.contexts()).toHaveLength(0);
  }, TEST_TIMEOUT_MS);
});

// L2（サイトへの負荷の制御の設計書 4.1、4.4）: robots.txt と sitemap.xml の読み込みの直前に、ページの読み込みの間隔の待ち
// （`beforeNavigation`）を呼ぶ。各ファイルの期限は、待った後の時刻から数える。
describe('collectSiteMetadata navigation pacing (load control design 4.1, 4.4)', () => {
  /** 待ちの呼び出しの時点で、サーバが受け取っていた robots.txt と sitemap.xml の要求の数。 */
  const metadataRequestsAt = (server: FixtureServer): { readonly robots: number; readonly sitemap: number } => {
    const observations = server.getRequestObservations();
    return {
      robots: observations.filter(({ pathname }) => pathname === '/robots.txt').length,
      sitemap: observations.filter(({ pathname }) => pathname === '/sitemap.xml').length,
    };
  };

  // RL-fix（RL の Minor-5）: 間隔の待ちは、省略できない引数である（Page Auditor の pacer と同じ）。渡し忘れると間隔を空けずに
  // 読み込む、という形を残さない。待たない呼び出し側は、それを明示する関数（`async () => 0`）を渡す。
  it('is a type error and a TypeError to collect the site metadata without beforeNavigation, before creating a Context', async () => {
    const server = await startServer();
    server.resetRequestObservations();
    const config = createTestConfig(server.origin);
    const allocator = new IdAllocator();
    const withoutPacing = {
      contextFactory: new BrowserContextFactory(browser, config, () => new SafetyLedger()),
      origin: server.origin,
      config,
      pageId: allocator.allocatePageId(),
      allocator,
      clock: () => OBSERVED_AT,
    };

    // @ts-expect-error: ページの読み込みの間隔の待ち（`beforeNavigation`）を渡さないと、型のエラーになる。
    await expect(collectSiteMetadata(withoutPacing)).rejects.toThrow(TypeError);
    await expect(collectSiteMetadata({ ...withoutPacing, beforeNavigation: undefined as unknown as () => Promise<number> }))
      .rejects.toThrow(TypeError);
    expect(browser.contexts()).toHaveLength(0);
    expect(metadataRequestsAt(server)).toEqual({ robots: 0, sitemap: 0 });
  }, TEST_TIMEOUT_MS);

  it('waits right before the navigation of each file', async () => {
    const server = await startServer();
    server.resetRequestObservations();
    const atEachWait: { readonly robots: number; readonly sitemap: number }[] = [];

    const run = await collect(server.origin, {
      beforeNavigation: async () => {
        atEachWait.push(metadataRequestsAt(server));
        return 0;
      },
    });

    // 1回目の待ちは robots.txt の要求の前、2回目の待ちは robots.txt の後で sitemap.xml の前に呼ばれる。
    expect(atEachWait).toEqual([{ robots: 0, sitemap: 0 }, { robots: 1, sitemap: 0 }]);
    expect(metadataRequestsAt(server)).toEqual({ robots: 1, sitemap: 1 });
    expect(robotsOf(run.result).payload).toMatchObject({ outcome: 'OK', httpStatus: 200 });
    expect(sitemapOf(run.result).payload).toMatchObject({ outcome: 'OK', httpStatus: 200 });
  }, TEST_TIMEOUT_MS);

  it('counts the deadline of each file from the end of the wait, so that a wait longer than the timeout does not fail it', async () => {
    const server = await startServer();
    const waitedMs = SHORT_NAVIGATION_TIMEOUT_MS + 500;
    let waits = 0;

    const run = await collect(server.origin, {
      navigationTimeoutMs: SHORT_NAVIGATION_TIMEOUT_MS,
      beforeNavigation: async () => {
        waits += 1;
        await new Promise((resolve) => setTimeout(resolve, waitedMs));
        return waitedMs;
      },
    });

    expect(waits).toBe(2);
    expect(run.result.failures).toEqual([]);
    expect(robotsOf(run.result).payload).toMatchObject({ outcome: 'OK', httpStatus: 200 });
    expect(sitemapOf(run.result).payload).toMatchObject({ outcome: 'OK', httpStatus: 200 });
    await expectValidPageEvidence(run);
  }, TEST_TIMEOUT_MS);

  it('records FAILED without navigating when the wait fails', async () => {
    const server = await startServer();
    server.resetRequestObservations();

    const run = await collect(server.origin, {
      beforeNavigation: async () => {
        throw new Error('injected pacing failure');
      },
    });

    expect(metadataRequestsAt(server)).toEqual({ robots: 0, sitemap: 0 });
    for (const record of run.result.records) {
      expect(record.payload).toMatchObject({ outcome: 'FAILED', httpStatus: null, text: null });
    }
    expect(run.result.failures).toEqual([
      { kind: 'ROBOTS_TXT', timedOut: false, detail: 'injected pacing failure' },
      { kind: 'SITEMAP_XML', timedOut: false, detail: 'injected pacing failure' },
    ]);
    await expectValidPageEvidence(run);
  }, TEST_TIMEOUT_MS);
});

// SU3b（サイトが応答しないときに Run を止める設計書 2.1、3.1）: robots.txt と sitemap.xml の読み込みの観測を、省略できる受け口
// （`afterNavigation`）に渡す。観測は `src/browser/main-frame-load.ts` の部品で作り、この部品は判定をしない。読み込みを始めなかった
// ファイルでは、受け口を呼ばない。
describe('collectSiteMetadata observations of the main frame load (site unavailability design 2.1, SU3b)', () => {
  /** 本文を止める応答の、Playwright の読み込みの期限（ms。設計書 2.2 の既知の限界のため、2 秒以上にする）。 */
  const STALL_AFTER_HEADERS_TIMEOUT_MS = 2_000;
  /** 本文のある 503 の応答（標準の headless では、読み込みは応答として終わる）。 */
  const MAINTENANCE_RESPONSE: CustomResponse = { status: 503, body: 'maintenance\n' };
  /** 包んだ間隔の待ちが、不調を検知した後に投げる例外のメッセージ（Run Coordinator の包み方を模す）。 */
  const SKIPPED_AFTER_UNAVAILABILITY = 'site metadata skipped after the site unavailability';

  /** 受け口に渡った観測を、渡った順に記録する。 */
  function observationRecorder(): {
    readonly observations: MainFrameLoadObservation[];
    readonly afterNavigation: (observation: MainFrameLoadObservation) => void;
  } {
    const observations: MainFrameLoadObservation[] = [];
    return { observations, afterNavigation: (observation) => observations.push(observation) };
  }

  it('passes the observation of each file to afterNavigation: HTTP 200 for robots.txt and HTTP 503 for sitemap.xml', async () => {
    const server = await startCustomServer({
      '/robots.txt': { body: 'User-agent: *\n' },
      '/sitemap.xml': MAINTENANCE_RESPONSE,
    });
    const { observations, afterNavigation } = observationRecorder();

    const run = await collect(server.origin, { afterNavigation });

    expect(observations).toEqual([
      { navigationOutcome: 'OK', httpStatus: 200, failureDetail: null },
      { navigationOutcome: 'OK', httpStatus: 503, failureDetail: null },
    ]);
    for (const observation of observations) {
      expect(Object.isFrozen(observation)).toBe(true);
    }
    // 受け口は判定をしないので、記録は今のとおり（503 は FAILED で、応答の status を持つ）。
    expect(robotsOf(run.result).payload).toMatchObject({ outcome: 'OK', httpStatus: 200 });
    expect(sitemapOf(run.result).payload).toMatchObject({ outcome: 'FAILED', httpStatus: 503, text: null, sitemapUrls: null });
    expect(run.result.failures).toEqual([]);
    expect(server.requestedPaths()).toEqual(['/robots.txt', '/sitemap.xml']);

    // 受け口を省略しても、記録は同じ（今のとおり動く）。
    const without = await collect(server.origin);
    expect(without.result.records.map(({ payload }) => payload)).toEqual(run.result.records.map(({ payload }) => payload));
    expect(without.result.failures).toEqual(run.result.failures);
    await expectValidPageEvidence(run);
  }, TEST_TIMEOUT_MS);

  it('passes a TIMEOUT without an HTTP status when robots.txt does not respond, and then the observation of sitemap.xml', async () => {
    const server = await startCustomServer({
      '/robots.txt': { hang: true },
      '/sitemap.xml': { contentType: 'application/xml', body: '<urlset><url><loc>{{ORIGIN}}/a.html</loc></url></urlset>' },
    });
    const { observations, afterNavigation } = observationRecorder();

    const run = await collect(server.origin, { navigationTimeoutMs: SHORT_NAVIGATION_TIMEOUT_MS, afterNavigation });

    expect(observations).toEqual([
      { navigationOutcome: 'TIMEOUT', httpStatus: null, failureDetail: expect.any(String) as unknown },
      { navigationOutcome: 'OK', httpStatus: 200, failureDetail: null },
    ]);
    expect(robotsOf(run.result).payload).toMatchObject({ outcome: 'FAILED', httpStatus: null, text: null });
    expect(run.result.failures).toEqual([{ kind: 'ROBOTS_TXT', timedOut: true, detail: expect.any(String) as unknown }]);
    expect(sitemapOf(run.result).payload).toMatchObject({ outcome: 'OK', sitemapUrls: [`${server.origin}/a.html`] });
    expect(run.result.ledgerSnapshot?.invariantViolationCount).toBe(0);
    await expectValidPageEvidence(run);
  }, TEST_TIMEOUT_MS);

  it('does not call afterNavigation for a file whose navigation did not start', async () => {
    const server = await startServer();
    server.resetRequestObservations();

    // 間隔の待ちが失敗した（読み込みを始めない）。
    const failedWait = observationRecorder();
    await collect(server.origin, {
      beforeNavigation: async () => {
        throw new Error('injected pacing failure');
      },
      afterNavigation: failedWait.afterNavigation,
    });
    expect(failedWait.observations).toEqual([]);

    // Passive Context を作れなかった（page を開かない）。
    const failedContext = observationRecorder();
    await collect(server.origin, {
      browser: browserOpeningPageAfterNewContext(browser),
      afterNavigation: failedContext.afterNavigation,
    });
    expect(failedContext.observations).toEqual([]);
    expect(server.getRequestObservations()).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('rejects an afterNavigation that is not a function with a TypeError, before creating a Context', async () => {
    const server = await startCustomServer({ '/robots.txt': { body: 'User-agent: *\n' } });

    await expect(collect(server.origin, {
      afterNavigation: 'observe' as unknown as (observation: MainFrameLoadObservation) => void,
    })).rejects.toThrow(TypeError);

    expect(browser.contexts()).toHaveLength(0);
    expect(server.requestedPaths()).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('does not load sitemap.xml when the wrapped beforeNavigation throws after the unavailability of robots.txt, and records it as FAILED', async () => {
    const server = await startCustomServer({
      '/robots.txt': { hang: true },
      '/sitemap.xml': { contentType: 'application/xml', body: '<urlset><url><loc>{{ORIGIN}}/a.html</loc></url></urlset>' },
    });
    const { observations, afterNavigation } = observationRecorder();
    // Run Coordinator の包み方を模す: 受け口で不調を検知したら、次のファイルの前の待ちで、待たずに例外を投げる。
    let unavailable = false;
    let waits = 0;

    const run = await collect(server.origin, {
      navigationTimeoutMs: SHORT_NAVIGATION_TIMEOUT_MS,
      afterNavigation: (observation) => {
        afterNavigation(observation);
        unavailable ||= siteUnavailabilityOf(observation) !== null;
      },
      beforeNavigation: async () => {
        waits += 1;
        if (unavailable) {
          throw new Error(SKIPPED_AFTER_UNAVAILABILITY);
        }
        return 0;
      },
    });

    expect(waits).toBe(2);
    expect(observations).toHaveLength(1);
    // sitemap.xml の読み込みは、サーバに届かない。
    expect(server.requestedPaths()).toEqual(['/robots.txt']);
    expect(sitemapOf(run.result).payload).toMatchObject({ outcome: 'FAILED', httpStatus: null, text: null, sitemapUrls: null });
    expect(run.result.failures).toEqual([
      { kind: 'ROBOTS_TXT', timedOut: true, detail: expect.any(String) as unknown },
      { kind: 'SITEMAP_XML', timedOut: false, detail: SKIPPED_AFTER_UNAVAILABILITY },
    ]);
    expect(run.result.sitemap).toBeNull();
    expect(run.result.ledgerSnapshot?.invariantViolationCount).toBe(0);
    await expectValidPageEvidence(run);
  }, TEST_TIMEOUT_MS);

  // DEF-029 の設計書 2.3: 読み込みが例外で終わっても、観測の status が 2xx でなければ、その status の応答として扱う。2xx なら、今のとおり
  // 応答を得られなかった失敗にする。
  it('records the status of a timeout after the headers of a non-2xx response, and keeps a timeout after a 2xx response as before', async () => {
    const server = await startCustomServer({
      '/robots.txt': { stallAfterHeaders: true },
      '/sitemap.xml': { status: 503, stallAfterHeaders: true },
    });
    const { observations, afterNavigation } = observationRecorder();

    const run = await collect(server.origin, { navigationTimeoutMs: STALL_AFTER_HEADERS_TIMEOUT_MS, afterNavigation });

    expect(observations).toEqual([
      { navigationOutcome: 'TIMEOUT', httpStatus: 200, failureDetail: expect.any(String) as unknown },
      { navigationOutcome: 'TIMEOUT', httpStatus: 503, failureDetail: expect.any(String) as unknown },
    ]);
    expect(robotsOf(run.result).payload).toMatchObject({ outcome: 'FAILED', httpStatus: null, text: null });
    expect(sitemapOf(run.result).payload).toMatchObject({ outcome: 'FAILED', httpStatus: 503, text: null, sitemapUrls: null });
    // 503 は応答として扱うので、応答を得られなかった取得（`failures`）には入らない。
    expect(run.result.failures).toEqual([{ kind: 'ROBOTS_TXT', timedOut: true, detail: expect.any(String) as unknown }]);
    expect(run.result.ledgerSnapshot?.invariantViolationCount).toBe(0);
    await expectValidPageEvidence(run);
  }, TEST_TIMEOUT_MS);
});

// DEF-029 の設計書 2.3、DEF-030: CLI と同じ起動の設定の Chromium は、本文が空の 4xx・5xx の読み込みを、応答を受けた後に
// `net::ERR_HTTP_RESPONSE_CODE_FAILURE` で失敗にする（テストの既定の headless-shell では、この失敗が起きない）。その場合も、観測の
// status から、`NOT_FOUND`（404）と `FAILED`（503。`httpStatus` は 503）を導く。
describe('collectSiteMetadata with the Chromium of the CLI: failures after the response (DEF-029 design 2.3, SU3b)', () => {
  let cliBrowser: Browser;

  beforeAll(async () => {
    cliBrowser = await chromium.launch(chromiumLaunchOptions({ headless: true }));
  });

  afterAll(async () => {
    await cliBrowser?.close();
  });

  it('records an empty 404 robots.txt as NOT_FOUND and an empty 503 sitemap.xml as FAILED with HTTP 503', async () => {
    const server = await startCustomServer({
      '/robots.txt': { status: 404, body: '' },
      '/sitemap.xml': { status: 503, body: '' },
    });
    const observations: MainFrameLoadObservation[] = [];

    const run = await collect(server.origin, { browser: cliBrowser, afterNavigation: (observation) => observations.push(observation) });

    // 読み込みは、応答を受けた後に例外で終わった（この Chromium の振る舞いが、このテストの前提）。
    const responseCodeFailure = expect.stringContaining('net::ERR_HTTP_RESPONSE_CODE_FAILURE') as unknown;
    expect(observations).toEqual([
      { navigationOutcome: 'FAILED', httpStatus: 404, failureDetail: responseCodeFailure },
      { navigationOutcome: 'FAILED', httpStatus: 503, failureDetail: responseCodeFailure },
    ]);
    expect(robotsOf(run.result).payload).toEqual({
      kind: 'ROBOTS_TXT',
      url: `${server.origin}/robots.txt`,
      outcome: 'NOT_FOUND',
      httpStatus: 404,
      text: null,
      textTruncated: false,
      sitemapUrls: null,
      sitemapUrlsTruncated: false,
    });
    expect(sitemapOf(run.result).payload).toMatchObject({ outcome: 'FAILED', httpStatus: 503, text: null, sitemapUrls: null });
    expect(run.result.failures).toEqual([]);
    expect(run.result.ledgerSnapshot?.invariantViolationCount).toBe(0);
    expect(server.requestedPaths()).toEqual(['/robots.txt', '/sitemap.xml']);
    expect(cliBrowser.contexts()).toHaveLength(0);
    await expectValidPageEvidence(run);
  }, TEST_TIMEOUT_MS);
});
