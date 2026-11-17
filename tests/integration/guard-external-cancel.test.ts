// DEF-027（設計書 `2026-10-05-beaksight-def-027-external-cancel-design.md`）: 読み込み中の main frame の文書の要求が、応答（ヘッダ）を
// 受ける前に、BeakSight の外の操作（タブを閉じる、停止、再読み込み、別の URL への移動）やページのスクリプト（`location.replace` の連続）で
// 取り消された場合は、Guard の違反（`HTTP_MAIN_FRAME_DELIVERY_FAILED`）にしない。違反にしないのは、Guard 自身の証拠（Guard の page の
// CDP の session で受けたもの）で、Guard が許可して進めた読み取りの文書の要求が、応答を1つも受けずにブラウザに取り消されたと確かめた
// 場合だけである。応答のヘッダの後の取り消し、凍結の段階、証拠がない場合、区別できない場合は、今のとおり違反にする
// （fail-closed）。ただし DEF-225: 応答のヘッダの後の取り消しのうち、Guard 自身が止めたダウンロード（同じ page・同じ URL）と対応付けたものは、違反にしない
// （対照の describe の説明を見る）。204 は、Chromium 156 では取り消しでなく終わった要求として報告され、違反にならない（DEF-163。対照の describe の説明を見る）。
// 外からタブを閉じた場合は、読み込みの取り消しは違反にならないが、Guard の page の CDP の session が外れたことは、今のとおり
// `CDP_SESSION_DETACHED` の違反になりうる（設計書 2.4）。
//
// - Chromium は、CLI と同じ起動の設定（`chromiumLaunchOptions`。headless）で起動する（DEF-029-fix の発見: テストの補助の既定の
//   headless-shell では、振る舞いが CLI と違うことがある）。
// - Guard の付いた Passive Context は、製品と同じ `BrowserContextFactory`（`createGateFactory`）で作る。
// - サーバは、このテストの中の 127.0.0.1 の `node:http` のサーバだけを使う。
// - 証拠の部品の上限、session を閉じた後、区別できない場合は、偽の page の session と偽の Context で確かめる（DEF-026 のテストのやり方。SLIM-GROUP で
//   `tests/component/guard-external-cancel-evidence.test.ts` へ移した。このファイルは Chromium の版を上げるときの束 `CHROMIUM_UPGRADE_TEST_FILES`）。
import { mkdtemp, rm } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, CDPSession, Page, Request } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { wait } from '../../src/core/deadline.js';
import { normalizeUrl } from '../../src/crawl/normalize-url.js';
import { IdAllocator } from '../../src/orchestration/id-allocator.js';
import { PageAuditor } from '../../src/orchestration/page-auditor.js';
import {
  activateInteractionFreeze,
  announceOwnMainFrameNavigation,
  assertPassiveRequestGuardActive,
  CANCELED_DOCUMENT_EVIDENCE_WAIT_MS,
  CDP_SESSION_DETACHED_MESSAGE,
  isPassiveRequestGuardClosed,
  pageLoadFactsOf,
} from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { launchCliChromium, testContextsOf, withoutBrowserFaviconRequestLines } from '../helpers/chromium.js';
import { createDeferred } from '../helpers/deferred.js';
import { createGateFactory } from '../helpers/gate-harness.js';
import { nonReadRequestsOf } from '../helpers/leak-places.js';
import { startLoopbackHttpServer } from '../helpers/loopback-server.js';
import { createTestNavigationPacer } from '../helpers/navigation-pacer.js';
import { closePassiveResources } from '../helpers/passive-cleanup.js';
import { fastRunConfig } from '../helpers/run-harness.js';

/** ブラウザが文書の要求を取り消したときの、失敗の理由（Playwright の `requestfailed` と CDP の `Network.loadingFailed` の `errorText`）。 */
const ABORTED = 'net::ERR_ABORTED';
/** 違反にならない取り消しを確かめた後に待つ時間（ms）。Guard が証拠を待つ時間の後に記録される違反と、Context を閉じる処理も見逃さない。 */
const SETTLE_AFTER_CANCEL_MS = CANCELED_DOCUMENT_EVIDENCE_WAIT_MS * 2;
/** 違反が記録されるのを待つ上限（ms）。Guard が証拠を待つ時間を過ぎてから記録される違反を待つ。 */
const VIOLATION_POLL_TIMEOUT_MS = CANCELED_DOCUMENT_EVIDENCE_WAIT_MS * 4;
/** Page Auditor を通すテストの上限（ms）。 */
const AUDIT_TEST_TIMEOUT_MS = 120_000;
/**
 * ページのスクリプトが、1回目の `location.replace` から2回目の `location.replace` までに待つ時間（ms）。1回目の移動の要求が、Guard に
 * 許可されてサーバに届いた（数 ms）後に、2回目の移動で取り消すための余裕である（届いたことは、テストがサーバの記録で確かめる）。
 */
const REPLACE_CHAIN_SECOND_DELAY_MS = 300;
/**
 * DEF-027 の元の現象の形（設計書 2.1.1 の限界）で、ページのスクリプトが、1回目の `location.replace` から2回目の `location.replace` まで
 * に待つ時間（ms。`setTimeout(…, 0)`）。Guard が1回目の移動の要求を Request の段階で進める前に、2回目の移動で取り消される（独立レビューの
 * 実験で 12/12。その要求は、サーバに届かなかった）。
 */
const REPLACE_CHAIN_IMMEDIATE_DELAY_MS = 0;

/** 違反の記録（Ledger の snapshot の `invariantViolations` の要素）。 */
// DEF-145（設計書 `2026-10-21-beaksight-probe-navigation-and-dialog-design.md` 2.1）: この違反は、失敗した main frame の要求の method と path（と Origin）を持つ。
const DELIVERY_FAILED = Object.freeze({
  code: 'HTTP_MAIN_FRAME_DELIVERY_FAILED',
  message: ABORTED,
  request: expect.objectContaining({ method: expect.any(String), path: expect.any(String) }),
});
/** Guard の page の CDP の session が、page が開いたまま外れた違反（設計書 2.4。外からタブを閉じたときに記録されうる）。 */
const SESSION_DETACHED = Object.freeze({
  code: 'CDP_SESSION_DETACHED',
  // L10: 文は実態に合わせた（`CDP_SESSION_DETACHED_MESSAGE`。判定は変えない）。
  message: CDP_SESSION_DETACHED_MESSAGE,
});

const HTML_TYPE = Object.freeze({ 'Content-Type': 'text/html; charset=utf-8' });
const pageHtml = (title: string, body = ''): string => '<!doctype html><html lang="en"><head><meta charset="utf-8">'
  + `<title>${title}</title></head><body><main><h1>${title}</h1></main>${body}</body></html>`;

/** サーバのパス（パスごとに応答の種類が決まる。`startCancelServer`）。 */
const PATHS = Object.freeze({
  start: '/',
  other: '/other',
  /** この接頭辞のパスには、応答しない（テストの終わりに接続を閉じる）。 */
  hangPrefix: '/hang/',
  replaceChain: '/replace-chain',
  /** `PATHS.replaceChain` と同じ形で、2回目の移動までの間隔が `REPLACE_CHAIN_IMMEDIATE_DELAY_MS` のページ。 */
  replaceChainImmediate: '/replace-chain-immediate',
  noContent: '/no-content',
  attachment: '/attachment',
  octetStream: '/octet-stream',
  /** 1回目の要求には応答せず、2回目からは小さな HTML（200）を返す（Page Auditor の Desktop だけを止める）。 */
  auditPage: '/audit-page',
});

/** `location.replace` の連続のページの、1回目の移動の先（応答しない）。 */
const REPLACE_CHAIN_FIRST_PATH = `${PATHS.hangPrefix}replace-chain`;
/** 間隔が 0ms の `location.replace` の連続のページの、1回目の移動の先（応答しない）。 */
const REPLACE_CHAIN_IMMEDIATE_FIRST_PATH = `${PATHS.hangPrefix}replace-chain-immediate`;

/** `location.replace` で `firstPath` へ移り、`secondDelayMs` 後に、もう一度 `location.replace` で `PATHS.other` へ移るページ。 */
const replaceChainHtml = (firstPath: string, secondDelayMs: number): string => pageHtml('Replace chain', '<script>'
  + `location.replace(${JSON.stringify(firstPath)});`
  + `setTimeout(function () { location.replace(${JSON.stringify(PATHS.other)}); }, ${secondDelayMs});`
  + '</script>');

const STATUS = Object.freeze({ ok: 200, noContent: 204 });

interface ReceivedRequest {
  readonly method: string;
  readonly pathname: string;
  /** 応答を返し終える前に、ブラウザが接続を閉じた（要求を取り消した）。 */
  abortedByClient: boolean;
}

interface CancelServer {
  readonly origin: string;
  /** 受けた要求（受けた順）。 */
  readonly requests: readonly ReceivedRequest[];
  /** `pathname` への GET を受けるまで待つ。 */
  received(pathname: string): Promise<void>;
  /** `pathname` への GET の件数。 */
  getCount(pathname: string): number;
  close(): Promise<void>;
}

const servers: CancelServer[] = [];
let browser: Browser;

beforeAll(async () => {
  // CLI と同じ起動の設定（headless）。
  // EL-12: 本番と同じ起動の部品（`launchCliChromium`）で起動する。
  browser = await launchCliChromium();
});

afterAll(async () => {
  await browser?.close();
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/**
 * 取り消しの確かめに使う、127.0.0.1 のサーバ。
 * - `PATHS.start`・`PATHS.other`: 小さな HTML（200）。
 * - `PATHS.hangPrefix` で始まるパス: 応答しない。
 * - `PATHS.replaceChain`: `location.replace` で `REPLACE_CHAIN_FIRST_PATH` へ移り、`REPLACE_CHAIN_SECOND_DELAY_MS` 後に、もう一度
 *   `location.replace` で `PATHS.other` へ移るページ。`PATHS.replaceChainImmediate` は、`REPLACE_CHAIN_IMMEDIATE_FIRST_PATH` へ移り、
 *   `REPLACE_CHAIN_IMMEDIATE_DELAY_MS` 後に `PATHS.other` へ移る。
 * - `PATHS.noContent`: 204。`PATHS.attachment`: `Content-Disposition: attachment` の HTML。`PATHS.octetStream`: `application/octet-stream`。
 * - `PATHS.auditPage`: 1回目は応答しない。2回目からは小さな HTML。
 */
async function startCancelServer(): Promise<CancelServer> {
  const requests: ReceivedRequest[] = [];
  const waiters: Array<{ readonly pathname: string; readonly resolve: () => void }> = [];
  const server = await startLoopbackHttpServer((request, response: ServerResponse) => {
    const pathname = (request.url ?? '/').split(/[?#]/u, 1)[0] ?? '/';
    const received: ReceivedRequest ={ method: request.method ?? '', pathname, abortedByClient: false };
    requests.push(received);
    response.on('close', () => {
      if (!response.writableFinished) received.abortedByClient = true;
    });
    for (const waiter of waiters.filter((entry) => entry.pathname === pathname && received.method === 'GET')) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
    if (pathname.startsWith(PATHS.hangPrefix)) {
      return;
    }
    switch (pathname) {
      case PATHS.start:
      case PATHS.other:
        response.writeHead(STATUS.ok, HTML_TYPE);
        response.end(pageHtml(pathname));
        return;
      case PATHS.replaceChain:
        response.writeHead(STATUS.ok, HTML_TYPE);
        response.end(replaceChainHtml(REPLACE_CHAIN_FIRST_PATH, REPLACE_CHAIN_SECOND_DELAY_MS));
        return;
      case PATHS.replaceChainImmediate:
        response.writeHead(STATUS.ok, HTML_TYPE);
        response.end(replaceChainHtml(REPLACE_CHAIN_IMMEDIATE_FIRST_PATH, REPLACE_CHAIN_IMMEDIATE_DELAY_MS));
        return;
      case PATHS.noContent:
        response.writeHead(STATUS.noContent);
        response.end();
        return;
      case PATHS.attachment:
        response.writeHead(STATUS.ok, { ...HTML_TYPE, 'Content-Disposition': 'attachment; filename="attachment.html"' });
        response.end(pageHtml('Attachment'));
        return;
      case PATHS.octetStream: {
        const body = Buffer.alloc(2_048, 1);
        response.writeHead(STATUS.ok, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length) });
        response.end(body);
        return;
      }
      case PATHS.auditPage:
        if (requests.filter((entry) => entry.pathname === PATHS.auditPage).length === 1) {
          return;
        }
        response.writeHead(STATUS.ok, HTML_TYPE);
        response.end(pageHtml('Audit page'));
        return;
      default:
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('not found\n');
    }
  });
  const getCount = (pathname: string): number =>
    requests.filter((entry) => entry.method === 'GET' && entry.pathname === pathname).length;
  const started: CancelServer = {
    origin: server.origin,
    requests,
    received: (pathname) => {
      if (getCount(pathname) > 0) return Promise.resolve();
      const deferred = createDeferred<void>();
      waiters.push({ pathname, resolve: () => deferred.resolve() });
      return deferred.promise;
    },
    getCount,
    close: server.close,
  };
  servers.push(started);
  return started;
}

/** 応答しないパス。 */
const hangPath = (name: string): string => `${PATHS.hangPrefix}${name}`;

/** Context の `requestfailed` のうち、`url` の要求の最初のものの失敗の理由を返す（タブを閉じた後も受けられるよう、Context で受ける）。 */
function observeRequestFailure(context: BrowserContext, url: string): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    const onFailed = (request: Request): void => {
      if (request.url() !== url) return;
      context.off('requestfailed', onFailed);
      resolve(request.failure()?.errorText);
    };
    context.on('requestfailed', onFailed);
  });
}

/** Context の `requestfinished` のうち、`url` の要求の最初のものを待つ（DEF-163: Chromium 156 の 204 の文書の読み込みの事象）。 */
function observeRequestFinished(context: BrowserContext, url: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const onFinished = (request: Request): void => {
      if (request.url() !== url) return;
      context.off('requestfinished', onFinished);
      resolve();
    };
    context.on('requestfinished', onFinished);
  });
}

/** BeakSight の外から、page の CDP の session（Guard の session とは別のもの）で、命令を送る（調査と同じやり方）。 */
async function sendFromOutside(context: BrowserContext, page: Page, method: 'Page.stopLoading' | 'Page.reload'): Promise<void>;
async function sendFromOutside(context: BrowserContext, page: Page, method: 'Page.navigate', params: { readonly url: string }): Promise<void>;
async function sendFromOutside(
  context: BrowserContext,
  page: Page,
  method: 'Page.stopLoading' | 'Page.reload' | 'Page.navigate',
  params?: { readonly url: string },
): Promise<void> {
  const outside = await context.newCDPSession(page);
  try {
    if (method === 'Page.navigate') {
      await outside.send(method, { url: params?.url ?? '' });
    } else {
      await outside.send(method);
    }
  } finally {
    await outside.detach().catch(() => undefined);
  }
}

/** page の target の ID（外からタブを閉じるときに使う）。 */
async function targetIdOf(context: BrowserContext, page: Page): Promise<string> {
  const outside = await context.newCDPSession(page);
  try {
    const { targetInfo } = await outside.send('Target.getTargetInfo');
    return targetInfo.targetId;
  } finally {
    await outside.detach().catch(() => undefined);
  }
}

/** BeakSight の外から、ブラウザの CDP の session の `Target.closeTarget` で、タブを閉じる（調査と同じやり方）。 */
async function closeTargetFromOutside(targetId: string): Promise<void> {
  const session = await browser.newBrowserCDPSession();
  try {
    await session.send('Target.closeTarget', { targetId });
  } finally {
    await session.detach().catch(() => undefined);
  }
}

/** `withGuardedPage` の指定。 */
interface GuardedPageOptions {
  /** Context を作った直後（page を開く前）に呼ぶ（例: Guard の CDP の session の差し替え）。 */
  readonly prepare?: (context: BrowserContext) => void;
}

/** Guard の付いた Passive の page を開いて `run` に渡し、終わったら閉じる。 */
async function withGuardedPage(
  server: CancelServer,
  run: (page: Page, context: BrowserContext, ledger: SafetyLedger) => Promise<void>,
  options: GuardedPageOptions = {},
): Promise<void> {
  const factory = createGateFactory(browser, server.origin);
  const context = await factory.createPassiveContext(DEFAULT_CONFIG.viewports.primaryDesktop);
  let page: Page | undefined;
  try {
    options.prepare?.(context);
    page = await factory.createPassivePage(context);
    await run(page, context, factory.getSafetyLedger(context));
  } finally {
    await closePassiveResources({ factory, context, page });
  }
}

/** Guard が証拠を待つ時間の後まで待ってから、違反が0件で、Guard が Context を閉じていないことを確かめる。 */
async function expectNoViolationAfterSettle(context: BrowserContext, ledger: SafetyLedger): Promise<void> {
  await wait(SETTLE_AFTER_CANCEL_MS);
  const { invariantViolations } = ledger.snapshot();
  expect(invariantViolations, `Safety Ledger violations: ${JSON.stringify(invariantViolations)}`).toEqual([]);
  expect(isPassiveRequestGuardClosed(context)).toBe(false);
}

/** 後続の許可した読み込みが通り、違反が0件のままであることを確かめる（Context が使えるまま）。 */
async function expectNextLoadSucceeds(server: CancelServer, page: Page, context: BrowserContext, ledger: SafetyLedger): Promise<void> {
  expect(() => assertPassiveRequestGuardActive(context)).not.toThrow();
  // DEF-129: factory の Passive の Context は、ページが始めた main frame の読み込みの数に上限を置く。この読み込みは BeakSight 自身の読み込みの代わり
  // なので、本番の読み込みの部品（`settleMainFrameLoad`）と同じく、読み込む前に Guard に知らせる。
  announceOwnMainFrameNavigation(page);
  const response = await page.goto(`${server.origin}${PATHS.start}`);
  expect(response?.status()).toBe(STATUS.ok);
  expect(ledger.snapshot().invariantViolations).toEqual([]);
}

/**
 * SAFE-2 の 4（違反の区分の (3)）: 取り消しを確かめられない読み取りの main frame の移動の失敗は、前は違反（`HTTP_MAIN_FRAME_DELIVERY_FAILED`）で Guard が Context を
 * 閉じた。今は、違反にせず読み取りの失敗の記録（`readNavigationFailures`）に残し、Context は閉じないことを確かめる。
 */
async function expectDeliveryFailedViolation(context: BrowserContext, ledger: SafetyLedger): Promise<void> {
  await expect.poll(() => ledger.snapshot().readNavigationFailures?.events.length ?? 0, { timeout: VIOLATION_POLL_TIMEOUT_MS }).toBeGreaterThan(0);
  expect(ledger.snapshot().invariantViolations).not.toContainEqual(expect.objectContaining({ code: DELIVERY_FAILED.code }));
  expect(isPassiveRequestGuardClosed(context)).toBe(false);
}

/**
 * Page Auditor を通して外からタブを閉じた場合の違反を確かめる（設計書 2.4）。読み込みの取り消し（`net::ERR_ABORTED`）は
 * `HTTP_MAIN_FRAME_DELIVERY_FAILED` にならない。記録される違反は、Guard の page の CDP の session が、page が BeakSight 自身の閉じる途中で
 * ないのに外れたこと（`CDP_SESSION_DETACHED`）だけで、あれば1件である（0件か1件かは、Page Auditor が page を閉じる途中にするのと、session
 * が外れるのとの時刻の競争で決まる）。この違反は、決まりのとおり残す（session が外れると、一時停止中の要求が Guard を通らずにサーバに
 * 届くことがあるため。DEF-028 と合わせて後で考える）。
 */
function expectOnlySessionDetached(violations: readonly { readonly code: string; readonly message: string }[]): void {
  expect(violations, `Safety Ledger violations: ${JSON.stringify(violations)}`).not.toContainEqual(expect.objectContaining({ code: DELIVERY_FAILED.code }));
  expect([[], [SESSION_DETACHED]], `Safety Ledger violations: ${JSON.stringify(violations)}`).toContainEqual(violations);
}

describe('DEF-027: a main-frame document request canceled before any response is not a Guard violation', () => {
  it('closing the tab from outside (Target.closeTarget) while the main-frame document is loading: the cancellation is not HTTP_MAIN_FRAME_DELIVERY_FAILED, and only the session detachment (CDP_SESSION_DETACHED) stays a violation', async () => {
    const server = await startCancelServer();
    await withGuardedPage(server, async (page, context, ledger) => {
      const path = hangPath('close-tab');
      const url = `${server.origin}${path}`;
      const failed = observeRequestFailure(context, url);
      const targetId = await targetIdOf(context, page);
      const navigation = page.goto(url).then(() => 'RESOLVED' as const, () => 'REJECTED' as const);
      await server.received(path);

      await closeTargetFromOutside(targetId);

      // 実際に取り消しが起きた（Guard が許可した GET がサーバに届き、応答の前にブラウザが取り消した）。
      expect(await failed).toBe(ABORTED);
      expect(await navigation).toBe('REJECTED');
      await expect.poll(() => page.isClosed()).toBe(true);
      await wait(SETTLE_AFTER_CANCEL_MS);
      // 修正の前は、ここで `HTTP_MAIN_FRAME_DELIVERY_FAILED` が記録される（RED）。修正の後は、Guard の page の session が外れたことの
      // `CDP_SESSION_DETACHED` の1件だけが記録される（設計書 2.4）。BeakSight が page を閉じないこのテストでは、session が外れたときに、
      // page はいつも BeakSight 自身の閉じる途中ではないので、0件にはならない。
      const { invariantViolations } = ledger.snapshot();
      expect(invariantViolations, `Safety Ledger violations: ${JSON.stringify(invariantViolations)}`).toEqual([SESSION_DETACHED]);
      expect(server.getCount(path)).toBe(1);
      expect(server.requests.find((entry) => entry.pathname === path)?.abortedByClient).toBe(true);
    });
  });

  it('stopping the load from outside (Page.stopLoading): no violation, and the Context stays usable', async () => {
    const server = await startCancelServer();
    await withGuardedPage(server, async (page, context, ledger) => {
      const path = hangPath('stop');
      const url = `${server.origin}${path}`;
      const failed = observeRequestFailure(context, url);
      const navigation = page.goto(url).then(() => 'RESOLVED' as const, () => 'REJECTED' as const);
      await server.received(path);

      await sendFromOutside(context, page, 'Page.stopLoading');

      expect(await failed).toBe(ABORTED);
      expect(await navigation).toBe('REJECTED');
      // 修正の前は、ここで `HTTP_MAIN_FRAME_DELIVERY_FAILED` が記録され、Guard が Context を閉じる（RED）。
      await expectNoViolationAfterSettle(context, ledger);
      expect(server.getCount(path)).toBe(1);
      await expectNextLoadSucceeds(server, page, context, ledger);
    });
  });

  // L10 の S4（設計者の判断。2026-11-12）: 輪は、同じ移りのくり返しで止める。外からの読み込み直し（start → hang → start）は 1 回目の移りなので、通って届く。
  // 取り消しが違反にならないことと、Context が使えることを確かめる。
  it('reloading from outside (Page.reload) while the next document is loading: no violation, the reload is delivered once, and the Context stays usable (L10)', async () => {
    const server = await startCancelServer();
    await withGuardedPage(server, async (page, context, ledger) => {
      expect((await page.goto(`${server.origin}${PATHS.start}`))?.status()).toBe(STATUS.ok);
      const path = hangPath('reload');
      const url = `${server.origin}${path}`;
      const failed = observeRequestFailure(context, url);
      const navigation = page.goto(url).then(() => 'RESOLVED' as const, () => 'REJECTED' as const);
      await server.received(path);

      await sendFromOutside(context, page, 'Page.reload');

      expect(await failed).toBe(ABORTED);
      expect(await navigation).toBe('REJECTED');
      // 修正の前は、ここで `HTTP_MAIN_FRAME_DELIVERY_FAILED` が記録され、Guard が Context を閉じる（RED）。
      await expectNoViolationAfterSettle(context, ledger);
      // 再読み込みは、確定した文書（`PATHS.start`）へ 1 回だけ届く。
      await expect.poll(() => server.getCount(PATHS.start)).toBe(2);
      expect(server.getCount(path)).toBe(1);
      await expectNextLoadSucceeds(server, page, context, ledger);
    });
  });

  it('navigating to another URL from outside (Page.navigate) while the document is loading: no violation', async () => {
    const server = await startCancelServer();
    await withGuardedPage(server, async (page, context, ledger) => {
      const path = hangPath('navigate');
      const url = `${server.origin}${path}`;
      const otherUrl = `${server.origin}${PATHS.other}`;
      const failed = observeRequestFailure(context, url);
      const navigation = page.goto(url).then(() => 'RESOLVED' as const, () => 'REJECTED' as const);
      await server.received(path);

      await sendFromOutside(context, page, 'Page.navigate', { url: otherUrl });

      expect(await failed).toBe(ABORTED);
      expect(await navigation).toBe('REJECTED');
      // 修正の前は、ここで `HTTP_MAIN_FRAME_DELIVERY_FAILED` が記録され、Guard が Context を閉じる（RED）。
      await expectNoViolationAfterSettle(context, ledger);
      await expect.poll(() => page.url()).toBe(otherUrl);
      await page.waitForLoadState('load');
      expect(server.getCount(path)).toBe(1);
      expect(server.getCount(PATHS.other)).toBe(1);
      await expectNextLoadSucceeds(server, page, context, ledger);
    });
  });

  it('a page script that calls location.replace twice in a row (the first move is canceled by the second): no violation', async () => {
    const server = await startCancelServer();
    await withGuardedPage(server, async (page, context, ledger) => {
      const firstUrl = `${server.origin}${REPLACE_CHAIN_FIRST_PATH}`;
      const otherUrl = `${server.origin}${PATHS.other}`;
      const failed = observeRequestFailure(context, firstUrl);

      await page.goto(`${server.origin}${PATHS.replaceChain}`, { waitUntil: 'commit' });

      expect(await failed).toBe(ABORTED);
      // 修正の前は、ここで `HTTP_MAIN_FRAME_DELIVERY_FAILED` が記録され、Guard が Context を閉じる（RED）。
      await expectNoViolationAfterSettle(context, ledger);
      await expect.poll(() => page.url()).toBe(otherUrl);
      await page.waitForLoadState('load');
      // 1回目の移動の要求は、Guard に許可されてサーバに届いてから、2回目の移動で取り消された。
      expect(server.getCount(REPLACE_CHAIN_FIRST_PATH)).toBe(1);
      expect(server.requests.find((entry) => entry.pathname === REPLACE_CHAIN_FIRST_PATH)?.abortedByClient).toBe(true);
      expect(server.getCount(PATHS.other)).toBe(1);
      await expectNextLoadSucceeds(server, page, context, ledger);
    });
  });
});

describe('DEF-027: Page Auditor, when the tab is closed from outside while a viewport is loading', () => {
  const workDirectories: string[] = [];

  afterEach(async () => {
    for (const directory of workDirectories.splice(0)) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('records no HTTP_MAIN_FRAME_DELIVERY_FAILED, and at most the session detachment (CDP_SESSION_DETACHED), in the page safety summary and every Safety Ledger (the investigation\'s reproduction)', async () => {
    const server = await startCancelServer();
    const config = fastRunConfig(server.origin, PATHS.auditPage, { audit: { interactions: false } });
    const ledgers: SafetyLedger[] = [];
    const factory = new BrowserContextFactory(browser, config, () => {
      const ledger = new SafetyLedger();
      ledgers.push(ledger);
      return ledger;
    });
    const screenshotRootDirectory = await mkdtemp(join(tmpdir(), 'beaksight-def-027-'));
    workDirectories.push(screenshotRootDirectory);
    const allocator = new IdAllocator();
    const auditor = new PageAuditor({
      contextFactory: factory,
      config,
      allocator,
      clock: () => new Date(),
      now: () => Date.now(),
      screenshotRootDirectory,
      navigationPacer: createTestNavigationPacer(config),
      // 本番と同じく、違反が記録されたら、次の監査を始めない（Run Coordinator が渡す関数と同じ答え方）。
      safetyViolationRecorded: () => ledgers.some((ledger) => ledger.snapshot().invariantViolationCount > 0),
    });
    const normalized = normalizeUrl(`${server.origin}${PATHS.auditPage}`, `${server.origin}${PATHS.auditPage}`, new Set());
    if (!normalized.ok) throw new Error('the audit page URL must normalize');

    const audit = auditor.audit(normalized.url, allocator.allocatePageId());
    // 最初のビューポートの読み込みの要求が、Guard に許可されてサーバに届いたら（サーバは応答しない）、そのタブを外から閉じる。
    await server.received(PATHS.auditPage);
    const browserSession = await browser.newBrowserCDPSession();
    try {
      const { targetInfos } = await browserSession.send('Target.getTargets');
      const pageTargets = targetInfos.filter((target) => target.type === 'page');
      expect(pageTargets, JSON.stringify(pageTargets)).toHaveLength(1);
      await browserSession.send('Target.closeTarget', { targetId: pageTargets[0]?.targetId ?? '' });
    } finally {
      await browserSession.detach().catch(() => undefined);
    }
    const outcome = await audit;
    await wait(SETTLE_AFTER_CANCEL_MS);

    // 実際に取り消しが起きた（Guard が許可した GET がサーバに届き、応答の前にブラウザが接続を閉じた）。
    const [first] = server.requests.filter((entry) => entry.pathname === PATHS.auditPage);
    expect(first?.abortedByClient).toBe(true);
    // 修正の前は、ここで `HTTP_MAIN_FRAME_DELIVERY_FAILED` が記録される（RED）。修正の後は、記録される違反があれば、Guard の page の
    // session が外れたことの `CDP_SESSION_DETACHED` だけである（設計書 2.4）。Page Auditor は、読み込みの失敗の直後に page を閉じる途中に
    // するので、それが session の切断より先なら、違反にならない。どちらが先かは時刻の競争なので、0件と1件のどちらも認める。
    expectOnlySessionDetached(outcome.safety.invariantViolations);
    expect(outcome.safety.invariantViolationCount).toBe(outcome.safety.invariantViolations.length);
    expectOnlySessionDetached(ledgers.flatMap((ledger) => ledger.snapshot().invariantViolations));
    expect(testContextsOf(browser)).toHaveLength(0);
  }, AUDIT_TEST_TIMEOUT_MS);
});

describe('DEF-027 controls: cancellations that stay violations (before and after the fix)', () => {
  // DEF-163（DF-1 の設計者の判断）: 204 の文書の読み込みは、ページを替えない応答で、サーバに届くのは読み取りの GET 1 件だけである。Chromium 156
  // （Playwright 1.64.1）では、`page.goto` は `net::ERR_ABORTED` で失敗するが、その要求の事象は `requestfailed` でなく `requestfinished` になり（Guard の
  // ない Context でも同じ。DF-1 の scratchpad の実験 `probe-204.test.ts`）、Guard は違反にしない。前の「違反のまま」は、ブラウザが `requestfailed` を
  // 出していたことによる結果で、守りの決まりではない。ここでは、届いたのが GET 1 件だけ、読み取りでない要求が 0、違反がなく Context が閉じないこと
  // （今の振る舞い）、Guard の記録（通した main frame の文書の要求の数）にこの GET が残ることを確かめる。
  it('204 No Content: the load ends without a page change; only the read GET reaches the server, and it is not a violation', async () => {
    const server = await startCancelServer();
    await withGuardedPage(server, async (page, context, ledger) => {
      const url = `${server.origin}${PATHS.noContent}`;
      const finished = observeRequestFinished(context, url);

      await expect(page.goto(url)).rejects.toThrow(ABORTED);

      await finished;
      await expectNoViolationAfterSettle(context, ledger);
      expect(withoutBrowserFaviconRequestLines(server.requests.map(({ method, pathname }) => `${method} ${pathname}`)))
        .toEqual([`GET ${PATHS.noContent}`]);
      expect(nonReadRequestsOf(server.requests.map(({ method, pathname }) => ({ method, path: pathname })))).toEqual([]);
      // SPEC-1: 文書の要求の数は Guard が数えない（届いた数は上のサーバの記録で確かめる）。Guard が文書を受けたことだけを見る。
      expect(pageLoadFactsOf(page)).not.toBeNull();
    });
  });

  // 応答のヘッダを受けた後の取り消し（Chromium が、ダウンロードに切り替える）。DEF-225（設計者の判断。指示書 DEF-225-brief.md）: 前は違反のままだったが、
  // Guard 自身が止めたダウンロード（同じ page・同じ URL。`PASSIVE_DOWNLOAD`）と 1 対 1 に対応付けられた失敗は、予期した失敗として違反にしない（Context は閉じない）。
  // ダウンロードの記録のない応答の後の `net::ERR_ABORTED` が違反のままであることは、`def-225-download-link.test.ts` で確かめる。
  it.each([
    { name: 'Content-Disposition: attachment', path: PATHS.attachment },
    { name: 'application/octet-stream', path: PATHS.octetStream },
  ])('$name: the load is aborted after the response headers by the download the Guard blocked, so it is not a violation (DEF-225)', async ({ path }) => {
    const server = await startCancelServer();
    await withGuardedPage(server, async (page, context, ledger) => {
      const url = `${server.origin}${path}`;
      const failed = observeRequestFailure(context, url);

      await expect(page.goto(url)).rejects.toThrow();

      expect(await failed).toBe(ABORTED);
      expect(server.getCount(path)).toBe(1);
      await expectNoViolationAfterSettle(context, ledger);
      expect(ledger.snapshot().blockedDownloads.map((event) => [event.url, event.reason])).toEqual([[url, 'PASSIVE_DOWNLOAD']]);
      expect(pageLoadFactsOf(page)?.mainFrameDownloadBlocked).toBe(true);
    });
  });

  // 設計書 2.1.1 の限界: DEF-027 の元の現象の形（ページのスクリプトが 0ms の間隔で `location.replace` を続ける）では、1回目の移動の要求は、
  // Guard が Request の段階で進める前に、2回目の移動で取り消される。(a)（Guard が許可して進めた）を満たさないので、今も違反のまま残る。
  // その要求はサーバに届かない（いちばん安全な場合が、違反のまま残る）。この限界を外すには、新しい安全の分析が要る（DEF-028 と合わせて後で
  // 考える）。
  it('limit (design 2.1.1): location.replace twice with a 0ms gap cancels the first move before the Guard continues it, so it is recorded as a read failure (SAFE-2)', async () => {
    const server = await startCancelServer();
    await withGuardedPage(server, async (page, context, ledger) => {
      const failed = observeRequestFailure(context, `${server.origin}${REPLACE_CHAIN_IMMEDIATE_FIRST_PATH}`);

      await page.goto(`${server.origin}${PATHS.replaceChainImmediate}`, { waitUntil: 'commit' });

      // 実際に1回目の移動が取り消された。
      expect(await failed).toBe(ABORTED);
      await expectDeliveryFailedViolation(context, ledger);
      // 1回目の移動の要求は、サーバに届いていない（Guard が進める前に取り消された）。
      expect(server.getCount(REPLACE_CHAIN_IMMEDIATE_FIRST_PATH)).toBe(0);
    });
  });

  // 凍結の段階での取り消し（DEF-029 の凍結の確かめ方に合わせる。凍結の前に要求をサーバに届け、凍結の後に外から止める）。
  it('a cancellation during the interaction freeze is recorded as a read failure and keeps the Context (SAFE-2)', async () => {
    const server = await startCancelServer();
    await withGuardedPage(server, async (page, context, ledger) => {
      expect((await page.goto(`${server.origin}${PATHS.start}`))?.status()).toBe(STATUS.ok);
      const path = hangPath('frozen');
      const failed = observeRequestFailure(context, `${server.origin}${path}`);

      await page.evaluate((target) => { location.href = target; }, path);
      await server.received(path);
      await activateInteractionFreeze(page);
      await sendFromOutside(context, page, 'Page.stopLoading');

      expect(await failed).toBe(ABORTED);
      await expectDeliveryFailedViolation(context, ledger);
    });
  });

  // 証拠（Guard の page の session の `Network.loadingFailed`）が Guard に届かない場合。Guard のコードは変えず、Guard の CDP の session を
  // Proxy で包み、Guard が付ける `Network.loadingFailed` の listener を付けずに捨てる（DEF-026 の対照と同じやり方）。
  it('when the cancellation evidence never reaches the Guard, an outside stop is recorded as a read failure (SAFE-2)', async () => {
    const server = await startCancelServer();
    await withGuardedPage(server, async (page, context, ledger) => {
      const path = hangPath('no-evidence');
      const url = `${server.origin}${path}`;
      const failed = observeRequestFailure(context, url);
      const navigation = page.goto(url).then(() => 'RESOLVED' as const, () => 'REJECTED' as const);
      await server.received(path);

      await sendFromOutside(context, page, 'Page.stopLoading');

      expect(await failed).toBe(ABORTED);
      expect(await navigation).toBe('REJECTED');
      await expectDeliveryFailedViolation(context, ledger);
    }, {
      prepare: (context) => {
        const original = context.newCDPSession.bind(context);
        vi.spyOn(context, 'newCDPSession').mockImplementation(async (target) => dropLoadingFailed(await original(target)));
      },
    });
  });
});

/** Guard の page の CDP の session を包み、`Network.loadingFailed` の listener を付けずに捨てる Proxy。 */
function dropLoadingFailed(real: CDPSession): CDPSession {
  return new Proxy(real, {
    get(target, property, receiver): unknown {
      if (property === 'on' || property === 'off') {
        const original = (Reflect.get(target, property, receiver) as (event: string, listener: unknown) => unknown).bind(target);
        return (event: string, listener: unknown): unknown => (event === 'Network.loadingFailed' ? receiver : original(event, listener));
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

// SLIM-GROUP: 偽の page の session と偽の Context の場面（証拠の部品の上限、session を閉じた後、区別できない場合）は、区切りで流すよう
// `tests/component/guard-external-cancel-evidence.test.ts` へ移した（このファイルは Chromium の版を上げるときの束）。
