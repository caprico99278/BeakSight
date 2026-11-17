// DEF-225: 開くとダウンロードになるリンク（添付の形の JSON など）を読むと、Guard が止めたダウンロードのために main frame の読み取りの移動が `net::ERR_ABORTED`
// （応答を受けた後）で失敗する。凍結の前の段では、同じ page・同じ URL の Guard が止めたダウンロードと 1 対 1 に対応付けられた失敗を、予期した失敗として扱い、
// 違反（`HTTP_MAIN_FRAME_DELIVERY_FAILED`）にしない（Context を閉じない）。監査はその画面を理由（`DOWNLOAD_RESPONSE`）つきの読めなかった画面にして続ける。
// - 事象の順（2026-11-08 に 2 つの Chromium で確かめた）: `requestfailed` がいつも先に来て、`download` は 0.3〜4ms 後に来る。Guard は名前つきの短い待ち
//   （`PASSIVE_DOWNLOAD_EVIDENCE_WAIT_MS`）でダウンロードの記録を待つ。
// - 仮のサイト（一般の文言だけ）: 一覧の画面に、`Content-Disposition: attachment` の JSON を返すリンクと、普通の画面へのリンクがある。Chromium はテストの既定
//   だけ（TEST-POLICY の 3）。
// - 守り（fail-closed）: ダウンロードの記録のない `ERR_ABORTED`（応答を受けた後）、別の URL のダウンロード、1 つのダウンロードに 2 つ目の失敗、凍結の段は、今のまま違反。
import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, Download, Page, Request } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { wait, yieldMacrotask } from '../../src/core/deadline.js';
import type { BrowserLauncher } from '../../src/orchestration/preflight.js';
import {
  activateInteractionFreeze,
  awaitPassiveRequestGuardReady,
  closePassiveGuardedContext,
  HTTP_MAIN_FRAME_DELIVERY_FAILED_VIOLATION_CODE,
  installPassiveRequestGuard,
  isPassiveRequestGuardClosed,
  pageLoadFactsOf,
  PASSIVE_DOWNLOAD_EVIDENCE_WAIT_MS,
} from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { DEFAULT_CHROMIUM_LAUNCHERS, testContextsOf } from '../helpers/chromium.js';
import { fakeFrame, fakePlaywrightRequest } from '../helpers/fake-playwright-request.js';
import { createGateFactory, withGuardedPassivePage } from '../helpers/gate-harness.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { createGuardHarness, createHarnessPage } from '../helpers/passive-guard-harness.js';
import { runDiscoveryOnPlainSite } from '../helpers/plain-discovery-site-run.js';
import { fastRunConfig, runWithCoordinator } from '../helpers/run-harness.js';

const TEST_TIMEOUT_MS = 120_000;
const RUN_TEST_TIMEOUT_MS = 180_000;
/** 遅れて届く要求と事象を待つ時間（ms。ダウンロードの記録の待ちより長く）。 */
const SETTLE_MS = PASSIVE_DOWNLOAD_EVIDENCE_WAIT_MS * 3;
const ABORTED = 'net::ERR_ABORTED';
/** 偽の取り消しの失敗の後に、Guard の作業が済むまで待つ時間（ms）。 */
const QUIET_MS = 200;

const PATHS = Object.freeze({ list: '/items', download: '/items/export', detail: '/items/detail' });
const LIST_HTML = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>一覧</title><link rel="icon" href="data:,"></head>'
  + `<body><main><h1>一覧</h1><a id="export" href="${PATHS.download}">書き出す</a> <a id="detail" href="${PATHS.detail}">詳しく</a></main></body></html>`;
const DETAIL_HTML = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>詳しく</title><link rel="icon" href="data:,"></head>'
  + '<body><main><h1>詳しく</h1><p>中身の文です。</p></main></body></html>';
const DOWNLOAD_HEADERS = Object.freeze({
  'content-type': 'application/json',
  'content-disposition': 'attachment; filename="export.json"',
  'cache-control': 'no-store',
});
const DOWNLOAD_BODY = '{"items":[]}';


interface Hit {
  readonly method: string;
  readonly path: string;
}

/** 一覧・ダウンロード・普通の画面を返すサイト。届いた要求を `hits` に残す。 */
async function startDownloadSite(): Promise<{ readonly server: LoopbackHttpServer; readonly hits: Hit[] }> {
  const hits: Hit[] = [];
  const server = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    hits.push({ method: request.method ?? '', path });
    request.resume();
    if (path === PATHS.download) {
      response.writeHead(200, DOWNLOAD_HEADERS);
      response.end(DOWNLOAD_BODY);
      return;
    }
    const html = path === PATHS.list ? LIST_HTML : path === PATHS.detail ? DETAIL_HTML : null;
    if (html === null) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(html);
  });
  return { server, hits };
}

const hitsOf = (hits: readonly Hit[], path: string): string[] => hits.filter((hit) => hit.path === path).map((hit) => hit.method);

// TEST-SLIM D2（TEST-POLICY の 3）: 違反にするかの振る舞いの場面なので、既定の Chromium だけで流す。
describe.each(DEFAULT_CHROMIUM_LAUNCHERS)('DEF-225: the Guard, when a read of the main frame becomes a download (%s)', (_label, launch) => {
  let browser: Browser;
  let site: Awaited<ReturnType<typeof startDownloadSite>>;

  beforeAll(async () => {
    browser = await launch();
    site = await startDownloadSite();
  });

  afterAll(async () => {
    await browser?.close();
    await site?.server.close();
  });

  afterEach(() => {
    site.hits.splice(0);
  });

  const readAndExpectNoViolation = async (move: (page: Page) => Promise<unknown>): Promise<void> => {
    const factory = createGateFactory(browser, site.server.origin);
    try {
      await withGuardedPassivePage(factory, { width: 800, height: 600 }, async (page, context, ledger) => {
        await move(page);
        await wait(SETTLE_MS);
        const snapshot = ledger.snapshot();
        expect(snapshot.invariantViolations).toEqual([]);
        expect(isPassiveRequestGuardClosed(context)).toBe(false);
        expect(snapshot.blockedDownloads.map((event) => [new URL(event.url).pathname, event.reason])).toEqual([[PATHS.download, 'PASSIVE_DOWNLOAD']]);
        expect(pageLoadFactsOf(page)?.mainFrameDownloadBlocked).toBe(true);
        // ダウンロードの URL へ届いたのは GET の 1 回だけ。
        expect(hitsOf(site.hits, PATHS.download)).toEqual(['GET']);
        // Context はそのまま使える（同じ page で普通の画面を読める）。
        const detail = await page.goto(`${site.server.origin}${PATHS.detail}`);
        expect(detail?.status()).toBe(200);
        expect(ledger.snapshot().invariantViolations).toEqual([]);
      });
    } finally {
      await factory.close().catch(() => undefined);
    }
  };

  it('BeakSight\'s own load of the download URL is not a violation, and the Context stays usable', async () => {
    await readAndExpectNoViolation(async (page) => {
      await expect(page.goto(`${site.server.origin}${PATHS.download}`)).rejects.toThrow();
    });
  }, TEST_TIMEOUT_MS);

  it('a link on the list page that becomes a download is not a violation', async () => {
    await readAndExpectNoViolation(async (page) => {
      await page.goto(`${site.server.origin}${PATHS.list}`);
      await page.click('#export');
    });
  }, TEST_TIMEOUT_MS);
});

// 守りが緩んでいないこと（偽の page の Guard。順と対応付けを、事象を直接送って確かめる）。
const FAKE_ORIGIN = 'https://example.test';
const FAKE_URL = `${FAKE_ORIGIN}/items/export`;
const OTHER_URL = `${FAKE_ORIGIN}/items/other-export`;

interface FakeGuard {
  readonly ledger: SafetyLedger;
  readonly page: Page;
  readonly context: BrowserContext;
  emitDownload(url: string): void;
  emitRequestFailed(url: string): void;
}

const fakeGuards: BrowserContext[] = [];

async function startFakeGuard(): Promise<FakeGuard> {
  const harness = createGuardHarness();
  const ledger = new SafetyLedger();
  const handlers = new Map<string, (...arguments_: unknown[]) => void>();
  await installPassiveRequestGuard(harness.context, ledger, new Set([FAKE_ORIGIN]));
  const page = createHarnessPage(harness, { url: `${FAKE_ORIGIN}/items`, onEvent: (event, handler) => handlers.set(event, handler) });
  await awaitPassiveRequestGuardReady(page);
  fakeGuards.push(harness.context);
  return {
    ledger,
    page,
    context: harness.context,
    emitDownload: (url) => {
      handlers.get('download')?.({ url: () => url, suggestedFilename: () => 'export.json', cancel: async () => undefined } as unknown as Download);
    },
    emitRequestFailed: (url) => {
      const request: Request = fakePlaywrightRequest({
        method: 'GET',
        url,
        navigation: true,
        frame: fakeFrame(page),
        failureText: ABORTED,
        // 応答（ヘッダ）を受けた後の失敗。
        response: { status: () => 200 },
      });
      void harness.requestFailedHandler?.(request);
    },
  };
}

const violationCodesAfterSettle = async (guard: FakeGuard): Promise<string[]> => {
  await wait(SETTLE_MS);
  return guard.ledger.snapshot().invariantViolations.map((violation) => violation.code);
};

/**
 * SAFE-2 の 4（違反の区分の (3)。設計者の判断）: ダウンロードと対応付けられない読み取りの main frame の移動の失敗は、前は違反（`HTTP_MAIN_FRAME_DELIVERY_FAILED`）で
 * Context を閉じた。今は、読み取りなので違反にせず、読み取りの失敗の記録（`readNavigationFailures`）に残し、Context は閉じない。その記録の method と時点の一覧。
 */
const readFailuresAfterSettle = async (guard: FakeGuard): Promise<string[]> => {
  await wait(SETTLE_MS);
  return (guard.ledger.snapshot().readNavigationFailures?.events ?? []).map(({ method, phase }) => `${method} ${phase}`);
};

describe('DEF-225: the correlation of a blocked download and the failed main-frame read (fake page)', () => {
  afterEach(async () => {
    for (const context of fakeGuards.splice(0)) {
      await closePassiveGuardedContext(context).catch(() => undefined);
    }
  });

  it('baseline (the observed order): the failure first, the download of the same URL within the wait → not a violation', async () => {
    const guard = await startFakeGuard();
    guard.emitRequestFailed(FAKE_URL);
    await yieldMacrotask();
    guard.emitDownload(FAKE_URL);
    expect(await violationCodesAfterSettle(guard)).toEqual([]);
    expect(await readFailuresAfterSettle(guard)).toEqual([]);
    expect(isPassiveRequestGuardClosed(guard.context)).toBe(false);
  });

  it('the download first, then the failure of the same URL → not a violation', async () => {
    const guard = await startFakeGuard();
    guard.emitDownload(FAKE_URL);
    guard.emitRequestFailed(FAKE_URL);
    expect(await violationCodesAfterSettle(guard)).toEqual([]);
    expect(await readFailuresAfterSettle(guard)).toEqual([]);
  });

  // SAFE-2 の 4: 対応付けられない読み取りの失敗は、違反でなく読み取りの失敗の記録（Context を閉じない）。
  it('net::ERR_ABORTED after the response without a download is recorded as a read failure, not a violation', async () => {
    const guard = await startFakeGuard();
    guard.emitRequestFailed(FAKE_URL);
    expect(await violationCodesAfterSettle(guard)).toEqual([]);
    expect(await readFailuresAfterSettle(guard)).toEqual(['GET PASSIVE']);
    expect(isPassiveRequestGuardClosed(guard.context)).toBe(false);
  });

  it('a download of another URL does not excuse the failure of this URL (a read failure is recorded)', async () => {
    const guard = await startFakeGuard();
    guard.emitDownload(OTHER_URL);
    guard.emitRequestFailed(FAKE_URL);
    expect(await violationCodesAfterSettle(guard)).toEqual([]);
    expect(await readFailuresAfterSettle(guard)).toEqual(['GET PASSIVE']);
  });

  it('one download excuses one failure only (1 to 1): a second failure of the same URL is recorded as a read failure', async () => {
    const guard = await startFakeGuard();
    guard.emitDownload(FAKE_URL);
    guard.emitRequestFailed(FAKE_URL);
    await wait(SETTLE_MS);
    guard.emitRequestFailed(FAKE_URL);
    expect(await violationCodesAfterSettle(guard)).toEqual([]);
    expect(await readFailuresAfterSettle(guard)).toEqual(['GET PASSIVE']);
  });

  it('the download arrives after the wait: a read failure is recorded', async () => {
    const guard = await startFakeGuard();
    guard.emitRequestFailed(FAKE_URL);
    await wait(SETTLE_MS);
    guard.emitDownload(FAKE_URL);
    expect(await violationCodesAfterSettle(guard)).toEqual([]);
    expect(await readFailuresAfterSettle(guard)).toEqual(['GET PASSIVE']);
  });

  // 取り消しの失敗（`PASSIVE_DOWNLOAD_CANCEL_FAILED`）: Guard が Context を閉じ始めた後の、Context が消えた形の失敗だけは違反にしない（CLI の Chromium の監査で、
  // 監査が読み込みの失敗を受けて閉じ始めた後にダウンロードの事象が来ると起きる）。閉じる前の同じ失敗と、ほかの文言は、今のまま違反。
  const CONTEXT_GONE_MESSAGES = [
    'download.cancel: Protocol error (Browser.cancelDownload): Failed to find browser context for id CD6B413C25BE866EF6715CE11E08F30B',
    'download.cancel: Target page, context or browser has been closed',
  ];
  const cancelFailureCodes = async (message: string, closeFirst: boolean): Promise<string[]> => {
    const harness = createGuardHarness();
    const ledger = new SafetyLedger();
    const handlers = new Map<string, (...arguments_: unknown[]) => void>();
    await installPassiveRequestGuard(harness.context, ledger, new Set([FAKE_ORIGIN]));
    const page = createHarnessPage(harness, { url: `${FAKE_ORIGIN}/items`, onEvent: (event, handler) => handlers.set(event, handler) });
    await awaitPassiveRequestGuardReady(page);
    let rejectCancel!: (error: Error) => void;
    const cancel = new Promise<void>((_resolve, reject) => { rejectCancel = reject; });
    handlers.get('download')?.({ url: () => FAKE_URL, suggestedFilename: () => 'export.json', cancel: () => cancel } as unknown as Download);
    let closing: Promise<void> | undefined;
    if (closeFirst) {
      closing = closePassiveGuardedContext(harness.context).catch(() => undefined);
      await yieldMacrotask();
    }
    rejectCancel(new Error(message));
    await wait(QUIET_MS);
    const codes = ledger.snapshot().invariantViolations.map((violation) => violation.code);
    await (closing ?? closePassiveGuardedContext(harness.context).catch(() => undefined));
    return codes;
  };

  it.each(CONTEXT_GONE_MESSAGES)('a cancel failure in the context-gone form after the Guard started to close the Context is not a violation: %s', async (message) => {
    expect(await cancelFailureCodes(message, true)).toEqual([]);
  });

  it.each(CONTEXT_GONE_MESSAGES)('the same cancel failure before the close stays a violation: %s', async (message) => {
    expect(await cancelFailureCodes(message, false)).toEqual(['PASSIVE_DOWNLOAD_CANCEL_FAILED']);
  });

  it('another cancel failure after the close started stays a violation', async () => {
    expect(await cancelFailureCodes('download.cancel: Protocol error (Browser.cancelDownload): Something else', true)).toEqual(['PASSIVE_DOWNLOAD_CANCEL_FAILED']);
  });

  // SAFE-2 の 4: 凍結の段の読み取りの失敗も、違反でなく読み取りの失敗の記録（時点 `INTERACTION`）。ダウンロードは今どおり凍結で止める。
  it('during the interaction freeze, the failure is recorded as a read failure after the freeze', async () => {
    const guard = await startFakeGuard();
    await activateInteractionFreeze(guard.page);
    guard.emitDownload(FAKE_URL);
    guard.emitRequestFailed(FAKE_URL);
    const codes = await violationCodesAfterSettle(guard);
    expect(codes).not.toContain(HTTP_MAIN_FRAME_DELIVERY_FAILED_VIOLATION_CODE);
    expect(await readFailuresAfterSettle(guard)).toEqual(['GET INTERACTION']);
    expect(guard.ledger.snapshot().blockedDownloads.map((event) => event.reason)).toEqual(['INTERACTION_FROZEN']);
  });
});

describe.each(DEFAULT_CHROMIUM_LAUNCHERS)('DEF-225: the audit, with a link that becomes a download (%s)', (_label, launch) => {
  const runBrowsers: Browser[] = [];
  const workDirectories: string[] = [];
  const launchRunBrowser: BrowserLauncher = async () => {
    const launched = await launch();
    runBrowsers.push(launched);
    return launched;
  };

  afterEach(async () => {
    for (const launched of runBrowsers.splice(0)) {
      expect(testContextsOf(launched)).toHaveLength(0);
      await launched.close().catch(() => undefined);
    }
    for (const directory of workDirectories.splice(0)) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reads to the end: the download page is an unread page with a reason, the other page is read, no violation, one GET to the download URL', async () => {
    const { server, hits } = await startDownloadSite();
    try {
      const outputDirectory = await mkdtemp(join(tmpdir(), 'beaksight-def-225-'));
      workDirectories.push(outputDirectory);
      const result = await runWithCoordinator({
        config: fastRunConfig(server.origin, PATHS.list, { audit: { interactions: false } }),
        launchBrowser: launchRunBrowser,
        outputDirectory,
      });
      await wait(SETTLE_MS);

      expect(result.run.safety.invariantViolations).toEqual([]);
      expect(result.run.runStatus).not.toBe('ABORTED_BY_SAFETY');
      const pageOf = (path: string) => result.pages.find((page) => new URL(page.pageUrl).pathname === path);
      expect(pageOf(PATHS.list)?.status).toBe('AUDITED');
      expect(pageOf(PATHS.detail)?.status).toBe('AUDITED');
      const download = pageOf(PATHS.download);
      expect(download?.status).toBe('FAILED');
      expect(download?.viewports.desktop.status).toBe('FAILED');
      expect(download?.viewports.desktop.incompleteReasons).toEqual([{ code: 'DOWNLOAD_RESPONSE', detail: null }]);
      // モバイルの viewport は、同じ URL を読み直さない（理由つきで始めない）。
      expect(download?.viewports.mobile.status).toBe('SKIPPED');
      expect(download?.viewports.mobile.incompleteReasons).toEqual([{ code: 'DOWNLOAD_RESPONSE', detail: null }]);
      // ダウンロードの URL へ届いたのは GET の 1 回だけ（読み込みの回数は増えない）。
      expect(hitsOf(hits, PATHS.download)).toEqual(['GET']);
      expect(hits.filter((hit) => !READ_METHODS.has(hit.method))).toEqual([]);
    } finally {
      await server.close();
    }
  }, RUN_TEST_TIMEOUT_MS);
});

describe.each(DEFAULT_CHROMIUM_LAUNCHERS)('DEF-225: the discovery read stage, with a link that becomes a download (%s)', (_label, launch) => {
  it('does not stop at the download link, reads the other page, and sends one GET to the download URL', async () => {
    const run = await runDiscoveryOnPlainSite(launch, (path) => {
      if (path === PATHS.download) return { headers: DOWNLOAD_HEADERS, body: DOWNLOAD_BODY };
      return path === PATHS.list ? LIST_HTML : path === PATHS.detail ? DETAIL_HTML : null;
    }, PATHS.list, 3, 'job-def-225-discovery');
    expect(run.document.endReason).not.toBe('SAFETY_VIOLATION');
    const stateOf = (path: string): string | undefined => run.document.pages.find((entry) => new URL(entry.url).pathname === path)?.state;
    expect(stateOf(PATHS.list)).toBe('READ');
    expect(stateOf(PATHS.detail)).toBe('READ');
    expect(stateOf(PATHS.download)).not.toBe('READ');
    expect(run.seen.filter((hit) => hit.path === PATHS.download).map((hit) => hit.method)).toEqual(['GET']);
    expect(run.seen.filter((hit) => !READ_METHODS.has(hit.method))).toEqual([]);
  }, RUN_TEST_TIMEOUT_MS);
});
