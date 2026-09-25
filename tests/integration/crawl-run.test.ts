// R15d（Task 14〜17 の設計書 5.6、実装計画 Task 15）: fixture の /crawl/ を、実際の Chromium で Run Coordinator がクロールする。
// 実行時間を抑えるため、幅の走査（`stressWidths`）とスクリーンショットは行わない設定にする（Interaction の段階は既定のまま有効）。
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import type { SafetyLedgerFactory } from '../../src/browser/context-factory.js';
import type { AuditRunResult } from '../../src/core/contracts.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { deriveRunStatus } from '../../src/core/status.js';
import { PASSIVE_CONTEXT_CLOSE_DEADLINE_MESSAGE } from '../../src/orchestration/passive-session-close.js';
import type { BrowserLauncher } from '../../src/orchestration/preflight.js';
import type { RunCoordinatorDependencies } from '../../src/orchestration/run-coordinator.js';
import { ArtifactWriter } from '../../src/report/artifact-writer.js';
import { buildReportViewModel } from '../../src/report/view-model.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { browserStallingContextClose } from '../helpers/browser-proxies.js';
import { EXTERNAL_SCHEME_TARGETS } from '../helpers/external-scheme-fixture.js';
import {
  createRunLauncher,
  expectOnlyReadRequests,
  expectSchemaValid,
  fastRunConfig,
  findingsOf,
  runWithCoordinator,
} from '../helpers/run-harness.js';
import type { TestConfigOverrides } from '../helpers/test-config.js';

const RUN_TEST_TIMEOUT_MS = 300_000;
const START_PATH = '/crawl/index.html';

let server: FixtureServer;
const workDirectories: string[] = [];
/** Run Coordinator が起動する headless の Chromium（起動した Browser が後に残っていないことを確かめる）。 */
const runLauncher = createRunLauncher();

beforeAll(async () => {
  server = await startFixtureServer();
});

afterAll(async () => {
  await server.close();
});

afterEach(async () => {
  // 後片付け。残っていた Browser は閉じたうえで、テストを失敗にする。
  const leftovers = await runLauncher.closeAll();
  for (const directory of workDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
  expect(leftovers, 'Browsers left connected after the Run').toBe(0);
});

async function runCrawl(
  overrides: TestConfigOverrides = {},
  createSafetyLedger: SafetyLedgerFactory = () => new SafetyLedger(),
  site: { readonly origin: string; readonly startPath: string } = { origin: server.origin, startPath: START_PATH },
  injected: Partial<Pick<RunCoordinatorDependencies, 'launchBrowser' | 'deadlines'>> = {},
): Promise<AuditRunResult & { readonly outputDirectory: string }> {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'beaksight-crawl-run-'));
  workDirectories.push(outputDirectory);
  const result = await runWithCoordinator({
    config: fastRunConfig(site.origin, site.startPath, overrides),
    launchBrowser: injected.launchBrowser ?? runLauncher.launcher,
    createSafetyLedger,
    outputDirectory,
    ...(injected.deadlines === undefined ? {} : { deadlines: injected.deadlines }),
  });
  return { ...result, outputDirectory };
}

const urlOf = (path: string): string => `${server.origin}${path}`;
const pathsOf = (result: AuditRunResult): string[] => result.pages.map((page) => new URL(page.pageUrl).pathname);
/** fixture のサーバに、GET と HEAD 以外のリクエストが1件も届いていない（`resetCounters` の後の記録）。 */
const expectNoNonReadRequests = (): void => expectOnlyReadRequests(server.getCounters(), server.getRequestObservations());

describe('RunCoordinator: crawling the fixture site with Chromium (R15d)', () => {
  let result: AuditRunResult;
  let requestedPaths: Set<string>;

  beforeAll(async () => {
    server.resetCounters();
    server.resetRequestObservations();
    result = await runCrawl();
    requestedPaths = new Set(server.getRequestObservations().map(({ pathname }) => pathname));
  }, RUN_TEST_TIMEOUT_MS);

  it('audits every internal page down to depth 3, in discovery order', () => {
    expect(pathsOf(result)).toEqual([
      '/crawl/index.html',
      '/crawl/level-1.html',
      '/crawl/missing.html',
      '/crawl/level-2.html',
      '/crawl/level-3.html',
    ]);
    expect(result.pages.map((page) => page.pageId)).toEqual([
      'PAGE-000001',
      'PAGE-000002',
      'PAGE-000003',
      'PAGE-000004',
      'PAGE-000005',
    ]);
    const deepest = result.pages[4];
    expect(deepest?.status).not.toBe('SKIPPED');
    expect(deepest?.viewports.desktop.navigationOutcome).toBe('OK');
    expect(result.run.discoveredPageCount).toBe(5);
    expect(result.run.crawlLimits).toEqual({ maxPagesReached: false, maxDepthReached: false, maxRuntimeReached: false });
  });

  it('reports the 404 link target as BROKEN_INTERNAL_LINK', () => {
    const missing = result.pages.find((page) => page.pageUrl === urlOf('/crawl/missing.html'));
    expect(missing?.viewports.desktop.httpStatus).toBe(404);
    const broken = findingsOf(result, 'BROKEN_INTERNAL_LINK');
    expect(broken).toHaveLength(1);
    expect(broken[0]?.pageUrl).toBe(urlOf('/crawl/index.html'));
    expect(broken[0]?.message).toContain(urlOf('/crawl/missing.html'));
  });

  it('does not visit external links, mailto: links, or URLs that are only in the sitemap', () => {
    expect(result.pages.every((page) => page.pageUrl.startsWith(`${server.origin}/`))).toBe(true);
    expect(requestedPaths.has('/crawl/sitemap-only.html')).toBe(false);
    expect(pathsOf(result)).not.toContain('/crawl/sitemap-only.html');
    // 外部のリンクと mailto: は、Link の Evidence に記録だけされる。
    const startLinks = result.pages[0]?.evidence.flatMap((record) => (record.type === 'link' ? record.payload.links : []));
    expect(startLinks?.map((link) => link.admission.kind)).toEqual([
      'INTERNAL_NAVIGABLE',
      'INTERNAL_NAVIGABLE',
      'INTERNAL_NAVIGABLE',
      'EXTERNAL_RECORD_ONLY',
      'SPECIAL_SCHEME_RECORD_ONLY',
    ]);
  });

  it('reports the sitemap disagreements as they are', () => {
    expect(findingsOf(result, 'SITEMAP_URL_NOT_DISCOVERED').map((finding) => finding.message)).toEqual([
      expect.stringContaining(urlOf('/crawl/sitemap-only.html')),
    ]);
    const notInSitemap = findingsOf(result, 'DISCOVERED_URL_NOT_IN_SITEMAP').map((finding) => finding.pageUrl).sort();
    expect(notInSitemap).toEqual([urlOf('/crawl/level-3.html'), urlOf('/crawl/missing.html')].sort());
  });

  it('puts the robots.txt and sitemap.xml Evidence on the start page', () => {
    const metadata = result.pages[0]?.evidence.flatMap((record) => (record.type === 'metadata' ? [record] : []));
    expect(metadata?.map((record) => [record.payload.kind, record.payload.outcome, record.viewport, record.pageId])).toEqual([
      ['ROBOTS_TXT', 'OK', null, 'PAGE-000001'],
      ['SITEMAP_XML', 'OK', null, 'PAGE-000001'],
    ]);
    const others = result.pages.slice(1).flatMap((page) => page.evidence.filter((record) => record.type === 'metadata'));
    expect(others).toEqual([]);
  });

  it('finishes the full fixture crawl COMPLETE (the site Findings do not make it incomplete)', () => {
    expect(result.run.runStatus).toBe('COMPLETE');
    expect(result.run.incompleteReasons).toEqual([]);
    expect(result.run.auditedPageCount).toBe(5);
    expect(result.findings.length).toBeGreaterThan(0);
  });

  it('keeps every page, Finding and the run summary valid against the schemas', async () => {
    await expectSchemaValid(result);
    expect(result.run.safety.guardEnabled).toBe(true);
    expect(result.run.safety.invariantViolationCount).toBe(0);
    expect(result.run.environment.chromiumVersion).not.toBeNull();
  });

  it('sends only GET and HEAD to the server', () => {
    expectNoNonReadRequests();
  });

  it('leaves no Chromium running after the Run', () => {
    expect(runLauncher.browsers.length).toBeGreaterThan(0);
    expect(runLauncher.browsers.every((browser) => !browser.isConnected())).toBe(true);
  });
});

describe('RunCoordinator: crawl limits against the fixture site (R15d)', () => {
  it('is PARTIAL with MAX_DEPTH_REACHED when maxDepth is small', async () => {
    const result = await runCrawl({ crawl: { maxDepth: 1 } });

    expect(result.run.runStatus).toBe('PARTIAL');
    expect(result.run.incompleteReasons).toContainEqual({ code: 'MAX_DEPTH_REACHED', detail: null });
    expect(result.run.crawlLimits.maxDepthReached).toBe(true);
    const level2 = result.pages.find((page) => page.pageUrl === urlOf('/crawl/level-2.html'));
    expect(level2?.status).toBe('SKIPPED');
    expect(level2?.incompleteReasons).toEqual([{ code: 'MAX_DEPTH_REACHED', detail: null }]);
    expect(pathsOf(result)).not.toContain('/crawl/level-3.html');
    await expectSchemaValid(result);
  }, RUN_TEST_TIMEOUT_MS);

  it('is PARTIAL with MAX_PAGES_REACHED when maxPages is small', async () => {
    const result = await runCrawl({ crawl: { maxPages: 2 } });

    expect(result.run.runStatus).toBe('PARTIAL');
    expect(result.run.incompleteReasons).toContainEqual({ code: 'MAX_PAGES_REACHED', detail: null });
    expect(result.run.crawlLimits.maxPagesReached).toBe(true);
    expect(result.pages.filter((page) => page.status !== 'SKIPPED')).toHaveLength(2);
    expect(result.pages.find((page) => page.pageUrl === urlOf('/crawl/missing.html'))?.incompleteReasons).toEqual([
      { code: 'MAX_PAGES_REACHED', detail: null },
    ]);
    // リンク先を監査していない内部リンクは、Finding にせず、検証できなかったリンクとして数える。
    expect(result.run.unverifiedInternalLinkCount).toBeGreaterThan(0);
    await expectSchemaValid(result);
  }, RUN_TEST_TIMEOUT_MS);
});

describe('RunCoordinator: the Safety summary of the Run counts every Ledger of the Run (R15e, design 5.6.5)', () => {
  it('counts a record in every Ledger that the Run created through the injected factory', async () => {
    // 注入する factory が作るすべての Ledger に、目印の遮断を1件ずつ記録する。Run の集計は、そのすべてを数えなければならない。
    const created: SafetyLedger[] = [];
    const marker = 'PROPFIND';
    const result = await runCrawl({ crawl: { maxPages: 1 } }, () => {
      const ledger = new SafetyLedger();
      ledger.recordBlockedRequest({ method: marker, url: urlOf('/__ledger-marker'), reason: 'NON_READ_METHOD' });
      created.push(ledger);
      return ledger;
    });

    // PREFLIGHT（1）、環境の事実（ビューポートごとに1）、metadata の取得（1）、開始のページ（ビューポートごとに1以上）。
    expect(created.length).toBeGreaterThanOrEqual(6);
    expect(result.run.safety.blockedRequestsByMethod[marker]).toBe(created.length);
    expect(result.run.safety.invariantViolationCount).toBe(0);
    expect(result.run.safety.guardEnabled).toBe(true);
    await expectSchemaValid(result);
  }, RUN_TEST_TIMEOUT_MS);
});

// RP18 の指摘1・2（Task 18 の前の整理の設計書 4.2）: 実際の Chromium で、環境の読み取りの Context を閉じる処理だけが終わらない場合も、
// Run は注入した期限の中で確定して返り、Browser は閉じる。閉じる処理の期限切れは Run の理由になり、Run は COMPLETE にならない。
describe('RunCoordinator: the environment Context close does not finish (RP18 findings 1 and 2)', () => {
  /** リンクのない fixture のページ。 */
  const SINGLE_PAGE_PATH = '/clipped-text.html';
  /** 注入する、Context を閉じる処理の期限（ms）。実際の `CONTEXT_CLOSE_TIMEOUT_MS` を待たない。 */
  const INJECTED_CONTEXT_CLOSE_TIMEOUT_MS = 500;

  /**
   * 起動した Chromium の `newContext` を包み、`hangingContextNumbers` の順番（1から数える）で作った Context の `close()` を、終わらない
   * ようにする（`browserStallingContextClose` を解かない）。Run の Context は、PREFLIGHT（1）、環境の事実の Desktop（2）と
   * Mobile（3）の順に作られる。Browser を閉じれば、止まった Context も閉じる。
   */
  const launcherWithHangingContextClose = (hangingContextNumbers: ReadonlySet<number>): BrowserLauncher => runLauncher.wrapped(
    (browser) => browserStallingContextClose(browser, { contextNumbers: hangingContextNumbers }).browser,
  );

  it('settles the Run, not COMPLETE, with the Context close deadline as a Run reason and closes the Browser', async () => {
    server.resetCounters();
    // リンクのないページ1つの Run（閉じる処理が止まらなければ、COMPLETE になる）。
    // 置き換えの前と同じ設定（`audit` は、スクリーンショットを既定のまま撮る）。
    const result = await runCrawl(
      { audit: { interactions: false, screenshots: true } },
      () => new SafetyLedger(),
      { origin: server.origin, startPath: SINGLE_PAGE_PATH },
      {
        launchBrowser: launcherWithHangingContextClose(new Set([2, 3])),
        deadlines: { contextCloseTimeoutMs: INJECTED_CONTEXT_CLOSE_TIMEOUT_MS },
      },
    );

    // User-Agent は読めた（閉じる処理の失敗は、値を変えない）。
    expect(result.run.environment.userAgents.desktop).toMatch(/^Mozilla\/5\.0 .*Chrome\//u);
    expect(result.run.environment.userAgents.mobile).toMatch(/^Mozilla\/5\.0 .*Chrome\//u);
    expect(result.run.runStatus).not.toBe('COMPLETE');
    expect(result.run.runStatus).toBe('PARTIAL');
    expect(result.run.auditedPageCount).toBe(1);
    expect(result.run.incompleteReasons).toEqual([
      { code: 'UNHANDLED_FAILURE', detail: `environment-context-close:${PASSIVE_CONTEXT_CLOSE_DEADLINE_MESSAGE}` },
      { code: 'UNHANDLED_FAILURE', detail: `environment-context-close:${PASSIVE_CONTEXT_CLOSE_DEADLINE_MESSAGE}` },
    ]);
    // 期限を過ぎても、Guard はリクエストを止め続けるので、違反は記録されない。
    expect(result.run.safety.invariantViolationCount).toBe(0);
    expectNoNonReadRequests();
    // Browser は閉じた（後片付けの `afterEach` でも、残っていないことを確かめる）。
    expect(runLauncher.browsers.at(-1)?.isConnected()).toBe(false);
    await expectSchemaValid(result);
  }, RUN_TEST_TIMEOUT_MS);
});

// DEF-007: 再試行の前の試行のスクリーンショットは、`pages/<pageId>/retry-<n>/<ビューポート>/` に置き、最終の試行のものは、
// これまでの場所に置く。最初の試行の `screenshot` の Evidence は、最初の試行の画像を指す。
describe('RunCoordinator: screenshots of the attempt before a retry (DEF-007)', () => {
  const FLAKY_PATH = '/flaky.html';
  /** 撮影した画像を区別できるよう、応答ごとに背景の色を変える。 */
  const pageWithBackground = (color: string): string =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Flaky</title></head>`
    + `<body style="margin:0;background:${color}"><main><h1>Flaky page</h1></main></body></html>`;

  /**
   * `FLAKY_PATH` の1回目の GET では、応答せずに接続を切る（`net::ERR_EMPTY_RESPONSE`。再試行の対象）。
   * 2回目（最初の試行の Mobile）は赤、3回目以降（再試行）は青の背景のページを返す。ほかのパスは 404。
   */
  async function startFlakyServer(): Promise<{ readonly origin: string; readonly close: () => Promise<void> }> {
    let flakyRequests = 0;
    const flaky = createServer((request, response) => {
      const pathname = (request.url ?? '/').split(/[?#]/u, 1)[0];
      if (pathname !== FLAKY_PATH) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('not found');
        return;
      }
      flakyRequests += 1;
      if (flakyRequests === 1) {
        request.socket.destroy();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' });
      response.end(pageWithBackground(flakyRequests === 2 ? '#ff0000' : '#0000ff'));
    });
    const port = await new Promise<number>((resolvePort, reject) => {
      flaky.once('error', reject);
      flaky.listen({ host: '127.0.0.1', port: 0 }, () => {
        const address = flaky.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('flaky server did not bind to a TCP port'));
          return;
        }
        resolvePort(address.port);
      });
    });
    return {
      origin: `http://127.0.0.1:${port}`,
      close: async () => {
        flaky.closeAllConnections();
        await new Promise<void>((resolveClose) => flaky.close(() => resolveClose()));
      },
    };
  }

  it('keeps the screenshots of the first attempt under retry-1 and the final ones in the usual place', async () => {
    const flaky = await startFlakyServer();
    try {
      const result = await runCrawl(
        { viewports: { stressWidths: [] }, audit: { screenshots: true, interactions: false } },
        () => new SafetyLedger(),
        { origin: flaky.origin, startPath: FLAKY_PATH },
      );

      expect(result.run.retries).toHaveLength(1);
      const [retry] = result.run.retries;
      const [page] = result.pages;
      expect(page?.pageUrl).toBe(`${flaky.origin}${FLAKY_PATH}`);
      const pageId = page?.pageId as string;
      const screenshots = (page?.evidence ?? []).filter((record) => record.type === 'screenshot');
      const firstAttemptIds = new Set(retry?.evidenceIds);
      const firstAttempt = screenshots.filter((record) => firstAttemptIds.has(record.evidenceId));
      const finalAttempt = screenshots.filter((record) => !firstAttemptIds.has(record.evidenceId));

      // 最初の試行は、Desktop のナビゲーションが失敗したので、Mobile のスクリーンショットだけがある。
      expect(firstAttempt.map((record) => record.type === 'screenshot' && record.payload.relativePath).sort()).toEqual([
        `pages/${pageId}/retry-1/mobile/full-page.png`,
        `pages/${pageId}/retry-1/mobile/viewport.png`,
      ]);
      expect(finalAttempt.map((record) => record.type === 'screenshot' && record.payload.relativePath).sort()).toEqual([
        `pages/${pageId}/desktop/full-page.png`,
        `pages/${pageId}/desktop/viewport.png`,
        `pages/${pageId}/mobile/full-page.png`,
        `pages/${pageId}/mobile/viewport.png`,
      ]);
      // 最初の試行の画像（赤）は、最終の試行の画像（青）に上書きされていない。
      const firstImage = await readFile(join(result.outputDirectory, result.run.runId, 'pages', pageId, 'retry-1', 'mobile', 'viewport.png'));
      const finalImage = await readFile(join(result.outputDirectory, result.run.runId, 'pages', pageId, 'mobile', 'viewport.png'));
      expect(firstImage.length).toBeGreaterThan(0);
      expect(finalImage.length).toBeGreaterThan(0);
      expect(firstImage.equals(finalImage)).toBe(false);
      await expectSchemaValid(result);
    } finally {
      await flaky.close();
    }
  }, RUN_TEST_TIMEOUT_MS);
});

// C18f（Task 19 の前の整理の設計書 4.5、RC18a の指摘2）: 違反を検出した後は、新しいページとビューポートを始めない。
// RC18a の再現: 読み込みの後に外部スキームへ移動するページが3つあるサイトを、headed で実行すると、違反が6件（3ページ × 2ビューポート）
// 起きた。修正の後は、最初の違反のページの Desktop の1件だけになる。
// 厳守事項: Chromium は headless だけで起動する。headed の扱いは、設定（`browser.headed: true`）で Guard に「headed である」と
// 注入して確かめる（起動する関数は、要求された `headless: false` を無視して、いつも headless で起動する）。外部スキームの宛先は、
// 実在しないもの（`.invalid`）だけを使う。
describe('RunCoordinator: no new page or viewport after a safety invariant violation (C18f, design 4.5)', () => {
  const HUB_PATH = '/hub.html';
  const VIOLATING_PATHS = ['/x1.html', '/x2.html', '/x3.html'] as const;
  /** 実在しない宛先（RFC 2606 の `.invalid`）。 */
  const EXTERNAL_SCHEME_TARGET = EXTERNAL_SCHEME_TARGETS.mailto.url;

  const htmlPage = (title: string, body: string): string =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main>${body}</main></body></html>`;

  interface ViolatingSite {
    readonly origin: string;
    /** 受けた GET のパス（受けた順）。 */
    readonly gets: string[];
    /** 受けた GET 以外のリクエスト（`<メソッド> <パス>`）。 */
    readonly nonGets: string[];
    readonly close: () => Promise<void>;
  }

  /**
   * 開始のページ（`HUB_PATH`）は、違反を起こす3つのページへのリンクを持つ。違反を起こすページは、読み込みの後に、ページのスクリプトが
   * 外部スキームへ移動する（headed では、Guard が違反として Context を閉じる）。ほかのパスは 404。
   */
  async function startViolatingSite(): Promise<ViolatingSite> {
    const gets: string[] = [];
    const nonGets: string[] = [];
    const site = createServer((request, response) => {
      const pathname = (request.url ?? '/').split(/[?#]/u, 1)[0] ?? '/';
      if (request.method === 'GET') {
        gets.push(pathname);
      } else {
        nonGets.push(`${request.method ?? ''} ${pathname}`);
      }
      const send = (html: string): void => {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(html);
      };
      if (pathname === HUB_PATH) {
        send(htmlPage('Hub', `<h1>Hub</h1>${VIOLATING_PATHS.map((path) => `<a href="${path}">${path}</a>`).join(' ')}`));
        return;
      }
      if ((VIOLATING_PATHS as readonly string[]).includes(pathname)) {
        send(htmlPage(pathname, `<h1>${pathname}</h1><script>window.addEventListener('load', () => {`
          + `setTimeout(() => { location.href = '${EXTERNAL_SCHEME_TARGET}'; }, 0); });</script>`));
        return;
      }
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('not found');
    });
    const port = await new Promise<number>((resolvePort, reject) => {
      site.once('error', reject);
      site.listen({ host: '127.0.0.1', port: 0 }, () => {
        const address = site.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('violating site did not bind to a TCP port'));
          return;
        }
        resolvePort(address.port);
      });
    });
    return {
      origin: `http://127.0.0.1:${port}`,
      gets,
      nonGets,
      close: async () => {
        site.closeAllConnections();
        await new Promise<void>((resolveClose) => site.close(() => resolveClose()));
      },
    };
  }

  it('records the violation only once, skips the rest with SAFETY_VIOLATION_ABORT, and writes schema-valid artifacts', async () => {
    const site = await startViolatingSite();
    // launcher は、要求された `headless` を記録し、いつも headless で起動する（実際の headed のブラウザは起動しない）。
    const callsBefore = runLauncher.calls.length;
    try {
      const result = await runCrawl(
        { browser: { headed: true }, audit: { interactions: false, screenshots: false } },
        () => new SafetyLedger(),
        { origin: site.origin, startPath: HUB_PATH },
        { launchBrowser: runLauncher.launcher },
      );

      // headed が注入された（起動の要求は headed だった）。
      const requestedHeadless = runLauncher.calls.slice(callsBefore).map(({ headless }) => headless);
      expect(requestedHeadless.length).toBeGreaterThan(0);
      expect(requestedHeadless.every((headless) => !headless)).toBe(true);
      expect(result.run.effectiveConfig.browser.headed).toBe(true);

      // 違反は、最初の違反のページの Desktop の1件だけである（修正の前は6件）。
      expect(result.run.safety.invariantViolationCount).toBe(1);
      expect(result.run.safety.invariantViolations.map((violation) => violation.code))
        .toEqual(['EXTERNAL_SCHEME_NAVIGATION_IN_HEADED_MODE']);
      // 2つ目以降の違反のページは、サーバに要求していない。
      expect(site.gets.filter((path) => path === '/x1.html')).toHaveLength(1);
      expect(site.gets).not.toContain('/x2.html');
      expect(site.gets).not.toContain('/x3.html');
      expect(site.nonGets).toEqual([]);

      const byPath = new Map(result.pages.map((page) => [new URL(page.pageUrl).pathname, page]));
      expect([...byPath.keys()]).toEqual([HUB_PATH, ...VIOLATING_PATHS]);
      expect(byPath.get(HUB_PATH)?.status).toBe('AUDITED');
      // 違反のページの Mobile は始めず、理由付きの SKIPPED にする。
      const first = byPath.get('/x1.html');
      expect(first?.viewports.desktop.navigationOutcome).toBe('OK');
      expect(first?.viewports.mobile).toMatchObject({
        status: 'SKIPPED',
        incompleteReasons: [{ code: 'SAFETY_VIOLATION_ABORT', detail: null }],
        navigationOutcome: null,
      });
      // 残りのページは、理由付きの SKIPPED にする。
      for (const path of ['/x2.html', '/x3.html']) {
        expect(byPath.get(path)?.status).toBe('SKIPPED');
        expect(byPath.get(path)?.incompleteReasons).toEqual([{ code: 'SAFETY_VIOLATION_ABORT', detail: null }]);
      }
      expect(result.run.skippedPageCount).toBe(2);
      expect(result.run.incompleteReasons).toContainEqual({ code: 'SAFETY_VIOLATION_ABORT', detail: null });

      // Run Status は、`deriveRunStatus` が導いた ABORTED_BY_SAFETY である。
      expect(result.run.runStatus).toBe('ABORTED_BY_SAFETY');
      expect(deriveRunStatus(result.statusInput)).toBe('ABORTED_BY_SAFETY');
      await expectSchemaValid(result);

      // 書き出しは、今までどおり行い、スキーマに合う。表示用モデルも組み立てられる。
      const written = await new ArtifactWriter().writeRun(result, { outputDirectory: result.outputDirectory });
      expect(written.schemaValid).toBe(true);
      expect(written.invalidArtifacts).toEqual([]);
      expect(written.result.run.runStatus).toBe('ABORTED_BY_SAFETY');
      const writtenRun = JSON.parse(await readFile(join(written.runDirectory, 'run.json'), 'utf8')) as unknown;
      await expect(validateArtifact('run', writtenRun)).resolves.toEqual({ ok: true });
      expect(() => buildReportViewModel(written.result)).not.toThrow();

      // Browser は閉じた（後片付けの `afterEach` でも、残っていないことを確かめる）。
      expect(runLauncher.browsers.at(-1)?.isConnected()).toBe(false);
    } finally {
      await site.close();
    }
  }, RUN_TEST_TIMEOUT_MS);
});
