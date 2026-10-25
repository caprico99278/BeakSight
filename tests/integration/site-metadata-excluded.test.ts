// T25c round 3（Task 25 の設計書 4.2、4.7 と、発見事項 3 の判断の案 1）: 認証つきの Run で、監査の段の除外に当たる robots.txt と sitemap.xml は、
// 取りに行かず、`metadata` の Evidence に結果 `EXCLUDED`（取らなかった）を残す。判定は呼び出し側が渡す関数（`isExcludedUrl`。Run Coordinator は
// 巡回の候補の判定 `isExcludedCrawlCandidate` を渡す）。渡さなければ、今のまま（公開監査）。127.0.0.1 の fixture のサーバと、本物の factory と
// Guard で確かめる。Chromium は headless だけ。
import type { Browser } from 'playwright';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { NormalizedHttpUrlEvidence } from '../../src/core/evidence-types.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { collectSiteMetadata, type SiteMetadataOptions, type SiteMetadataResult } from '../../src/crawl/site-metadata.js';
import { sitemapEvidenceFromMetadata } from '../../src/crawl/sitemap-evidence.js';
import { IdAllocator } from '../../src/orchestration/id-allocator.js';
import { skippedPageResult } from '../../src/orchestration/skipped-page.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { BROWSER_DEFAULT_FAVICON_PATH, launchCliChromium, launchHeadlessChromium, testContextsOf } from '../helpers/chromium.js';
import { NO_PACING_WAIT } from '../helpers/navigation-pacer.js';
import { createTestConfig } from '../helpers/test-config.js';

const OBSERVED_AT = new Date('2026-10-10T00:00:00.000Z');
const ROBOTS_PATH = '/robots.txt';
const SITEMAP_PATH = '/sitemap.xml';

const LAUNCHERS = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI launch settings', () => launchCliChromium()],
] as const;

describe.each(LAUNCHERS)('T25c round 3: collectSiteMetadata does not fetch excluded files (%s)', (_name, launch) => {
  let browser: Browser;
  let server: FixtureServer;
  const factories: BrowserContextFactory[] = [];

  beforeEach(async () => {
    browser = await launch();
    server = await startFixtureServer();
    server.resetRequestObservations();
  });

  afterEach(async () => {
    await Promise.all(factories.splice(0).map((factory) => factory.close()));
    await browser.close();
    await server.close();
  });

  async function collect(
    isExcludedUrl: SiteMetadataOptions['isExcludedUrl'],
    hooks: Pick<SiteMetadataOptions, 'beforeNavigation' | 'afterNavigation'> = { beforeNavigation: NO_PACING_WAIT },
  ): Promise<{ readonly result: SiteMetadataResult; readonly options: SiteMetadataOptions; readonly ledgers: SafetyLedger[] }> {
    const config = createTestConfig(server.origin, '/');
    const ledgers: SafetyLedger[] = [];
    const factory = new BrowserContextFactory(browser, config, () => {
      const ledger = new SafetyLedger();
      ledgers.push(ledger);
      return ledger;
    });
    factories.push(factory);
    const allocator = new IdAllocator();
    const options: SiteMetadataOptions = {
      contextFactory: factory,
      origin: server.origin,
      config,
      pageId: allocator.allocatePageId(),
      allocator,
      clock: () => OBSERVED_AT,
      ...hooks,
      ...(isExcludedUrl === undefined ? {} : { isExcludedUrl }),
    };
    return { result: await collectSiteMetadata(options), options, ledgers };
  }

  const serverPaths = (): string[] => server.getRequestObservations()
    .map(({ pathname }) => pathname)
    .filter((pathname) => pathname !== BROWSER_DEFAULT_FAVICON_PATH);

  async function expectValidPageEvidence(result: SiteMetadataResult, options: SiteMetadataOptions): Promise<void> {
    const page = skippedPageResult(`${options.origin}/` as NormalizedHttpUrlEvidence, options.pageId, { code: 'MAX_PAGES_REACHED', detail: null });
    await expect(validateArtifact('page', JSON.parse(JSON.stringify({ ...page, evidence: [...result.records] })) as unknown))
      .resolves.toEqual({ ok: true });
  }

  it('records EXCLUDED for both files without a Context, a navigation, a wait or a Guard record when both are excluded', async () => {
    let waits = 0;
    let observations = 0;
    const { result, options, ledgers } = await collect(() => true, {
      beforeNavigation: async () => {
        waits += 1;
        return 0;
      },
      afterNavigation: () => {
        observations += 1;
      },
    });

    for (const record of result.records) {
      expect(record.payload).toMatchObject({ outcome: 'EXCLUDED', httpStatus: null, text: null, textTruncated: false, sitemapUrls: null });
    }
    expect(result.records.map(({ payload }) => payload.kind)).toEqual(['ROBOTS_TXT', 'SITEMAP_XML']);
    expect(result.sitemap).toBeNull();
    expect(sitemapEvidenceFromMetadata(result.records[1])).toBeNull();
    expect(result.failures).toEqual([]);
    expect(result.ledgerSnapshot).toBeNull();
    expect(ledgers).toEqual([]);
    expect(waits).toBe(0);
    expect(observations).toBe(0);
    expect(serverPaths()).toEqual([]);
    expect(testContextsOf(browser)).toHaveLength(0);
    await expectValidPageEvidence(result, options);
  });

  it('fetches only the files that are not excluded (robots.txt fetched, sitemap.xml excluded)', async () => {
    const { result, options, ledgers } = await collect((url) => new URL(url).pathname === SITEMAP_PATH);

    expect(result.records[0].payload.outcome).not.toBe('EXCLUDED');
    expect(result.records[1].payload).toMatchObject({ kind: 'SITEMAP_XML', outcome: 'EXCLUDED', httpStatus: null, sitemapUrls: null });
    expect(result.sitemap).toBeNull();
    expect(serverPaths()).toEqual([ROBOTS_PATH]);
    expect(ledgers.every((ledger) => ledger.snapshot().blockedAuditExclusions === undefined)).toBe(true);
    await expectValidPageEvidence(result, options);
  });

  it('keeps the collection unchanged without the judgement (both files are fetched, no EXCLUDED)', async () => {
    const { result } = await collect(undefined);

    expect(result.records.map(({ payload }) => payload.outcome)).not.toContain('EXCLUDED');
    expect(serverPaths()).toEqual([ROBOTS_PATH, SITEMAP_PATH]);
  });

  it('rejects a judgement that is not a function with a TypeError, before creating a Context', async () => {
    await expect(collect('yes' as unknown as SiteMetadataOptions['isExcludedUrl'])).rejects.toThrow(TypeError);
    expect(testContextsOf(browser)).toHaveLength(0);
    expect(serverPaths()).toEqual([]);
  });
});
