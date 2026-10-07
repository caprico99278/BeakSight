// DEF-027（設計書 `2026-10-05-beaksight-def-027-external-cancel-design.md`）: 読み込み中の main frame の文書の要求が、応答（ヘッダ）を
// 受ける前に、BeakSight の外の操作（タブを閉じる、停止、再読み込み、別の URL への移動）やページのスクリプト（`location.replace` の連続）で
// 取り消された場合は、Guard の違反（`HTTP_MAIN_FRAME_DELIVERY_FAILED`）にしない。違反にしないのは、Guard 自身の証拠（Guard の page の
// CDP の session で受けたもの）で、Guard が許可して進めた読み取りの文書の要求が、応答を1つも受けずにブラウザに取り消されたと確かめた
// 場合だけである。応答のヘッダの後の取り消し（204、ダウンロード）、凍結の段階、証拠がない場合、区別できない場合は、今のとおり違反にする
// （fail-closed）。
// 外からタブを閉じた場合は、読み込みの取り消しは違反にならないが、Guard の page の CDP の session が外れたことは、今のとおり
// `CDP_SESSION_DETACHED` の違反になりうる（設計書 2.4）。
//
// - Chromium は、CLI と同じ起動の設定（`chromiumLaunchOptions`。headless）で起動する（DEF-029-fix の発見: テストの補助の既定の
//   headless-shell では、振る舞いが CLI と違うことがある）。
// - Guard の付いた Passive Context は、製品と同じ `BrowserContextFactory`（`createGateFactory`）で作る。
// - サーバは、このテストの中の 127.0.0.1 の `node:http` のサーバだけを使う。
// - 証拠の部品の上限、session を閉じた後、区別できない場合は、偽の page の session と偽の Context で確かめる（DEF-026 のテストのやり方）。
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page, type Request } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromiumLaunchOptions } from '../../src/browser/chromium-launch.js';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { INVALID_INTERCEPTION_ID_FAILURE_TEXTS } from '../../src/browser/playwright-errors.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { wait, yieldMacrotask } from '../../src/core/deadline.js';
import { normalizeUrl } from '../../src/crawl/normalize-url.js';
import { IdAllocator } from '../../src/orchestration/id-allocator.js';
import { PageAuditor } from '../../src/orchestration/page-auditor.js';
import {
  activateInteractionFreeze,
  assertPassiveRequestGuardActive,
  awaitPassiveRequestGuardReady,
  CANCELED_DOCUMENT_EVIDENCE_RETENTION_MS,
  CANCELED_DOCUMENT_EVIDENCE_WAIT_MS,
  closePassiveGuardedContext,
  installPassiveRequestGuard,
  isPassiveRequestGuardClosed,
  MAX_CANCELED_DOCUMENT_EVIDENCE,
  PENDING_MAIN_FRAME_DOCUMENT_RETENTION_MS,
} from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { createDeferred } from '../helpers/deferred.js';
import { createGateFactory } from '../helpers/gate-harness.js';
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
const DELIVERY_FAILED = Object.freeze({ code: 'HTTP_MAIN_FRAME_DELIVERY_FAILED', message: ABORTED });
/** Guard の page の CDP の session が、page が開いたまま外れた違反（設計書 2.4。外からタブを閉じたときに記録されうる）。 */
const SESSION_DETACHED = Object.freeze({
  code: 'CDP_SESSION_DETACHED',
  message: 'Document interception session detached while its page remained active',
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
  browser = await chromium.launch(chromiumLaunchOptions({ headless: true }));
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
  const server = createServer((request, response: ServerResponse) => {
    const pathname = (request.url ?? '/').split(/[?#]/u, 1)[0] ?? '/';
    const received: ReceivedRequest = { method: request.method ?? '', pathname, abortedByClient: false };
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
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const getCount = (pathname: string): number =>
    requests.filter((entry) => entry.method === 'GET' && entry.pathname === pathname).length;
  const started: CancelServer = {
    origin: `http://127.0.0.1:${port}`,
    requests,
    received: (pathname) => {
      if (getCount(pathname) > 0) return Promise.resolve();
      const deferred = createDeferred<void>();
      waiters.push({ pathname, resolve: () => deferred.resolve() });
      return deferred.promise;
    },
    getCount,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
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
  const response = await page.goto(`${server.origin}${PATHS.start}`);
  expect(response?.status()).toBe(STATUS.ok);
  expect(ledger.snapshot().invariantViolations).toEqual([]);
}

/** 違反（`HTTP_MAIN_FRAME_DELIVERY_FAILED`）だけが記録され、Guard が Context を閉じることを確かめる。 */
async function expectDeliveryFailedViolation(context: BrowserContext, ledger: SafetyLedger): Promise<void> {
  await expect.poll(() => ledger.snapshot().invariantViolations, { timeout: VIOLATION_POLL_TIMEOUT_MS }).toEqual([DELIVERY_FAILED]);
  await expect.poll(() => isPassiveRequestGuardClosed(context), { timeout: VIOLATION_POLL_TIMEOUT_MS }).toBe(true);
}

/**
 * Page Auditor を通して外からタブを閉じた場合の違反を確かめる（設計書 2.4）。読み込みの取り消し（`net::ERR_ABORTED`）は
 * `HTTP_MAIN_FRAME_DELIVERY_FAILED` にならない。記録される違反は、Guard の page の CDP の session が、page が BeakSight 自身の閉じる途中で
 * ないのに外れたこと（`CDP_SESSION_DETACHED`）だけで、あれば1件である（0件か1件かは、Page Auditor が page を閉じる途中にするのと、session
 * が外れるのとの時刻の競争で決まる）。この違反は、決まりのとおり残す（session が外れると、一時停止中の要求が Guard を通らずにサーバに
 * 届くことがあるため。DEF-028 と合わせて後で考える）。
 */
function expectOnlySessionDetached(violations: readonly { readonly code: string; readonly message: string }[]): void {
  expect(violations, `Safety Ledger violations: ${JSON.stringify(violations)}`).not.toContainEqual(DELIVERY_FAILED);
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

  it('reloading from outside (Page.reload) while the next document is loading: no violation, and the Context stays usable', async () => {
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
      // 再読み込みは、確定した文書（`PATHS.start`）を読み込み直す。
      await expect.poll(() => server.getCount(PATHS.start)).toBe(2);
      await page.waitForLoadState('load');
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
    expect(browser.contexts()).toHaveLength(0);
  }, AUDIT_TEST_TIMEOUT_MS);
});

describe('DEF-027 controls: cancellations that stay violations (before and after the fix)', () => {
  // 応答のヘッダを受けた後の取り消し（Chromium が、204 を描かない、ダウンロードに切り替える）。
  it.each([
    { name: '204 No Content', path: PATHS.noContent },
    { name: 'Content-Disposition: attachment', path: PATHS.attachment },
    { name: 'application/octet-stream', path: PATHS.octetStream },
  ])('$name: the load is aborted after the response headers, so it stays a violation and invalidates the Context', async ({ path }) => {
    const server = await startCancelServer();
    await withGuardedPage(server, async (page, context, ledger) => {
      const url = `${server.origin}${path}`;
      const failed = observeRequestFailure(context, url);

      await expect(page.goto(url)).rejects.toThrow();

      expect(await failed).toBe(ABORTED);
      expect(server.getCount(path)).toBe(1);
      await expectDeliveryFailedViolation(context, ledger);
    });
  });

  // 設計書 2.1.1 の限界: DEF-027 の元の現象の形（ページのスクリプトが 0ms の間隔で `location.replace` を続ける）では、1回目の移動の要求は、
  // Guard が Request の段階で進める前に、2回目の移動で取り消される。(a)（Guard が許可して進めた）を満たさないので、今も違反のまま残る。
  // その要求はサーバに届かない（いちばん安全な場合が、違反のまま残る）。この限界を外すには、新しい安全の分析が要る（DEF-028 と合わせて後で
  // 考える）。
  it('limit (design 2.1.1): location.replace twice with a 0ms gap cancels the first move before the Guard continues it, so it stays a violation', async () => {
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
  it('a cancellation during the interaction freeze stays a violation and invalidates the Context', async () => {
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
  it('when the cancellation evidence never reaches the Guard, an outside stop stays a violation', async () => {
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

// ---------------------------------------------------------------------------------------------------------------
// 偽の page の session と偽の Context（証拠の部品の上限、session を閉じた後、区別できない場合。DEF-026 のテストのやり方）
// ---------------------------------------------------------------------------------------------------------------

/** 偽の Context と page の session の、事象の受け渡し。 */
class FakeEmitter {
  readonly #listeners = new Map<string, Set<(value: unknown) => void>>();

  on(event: string, listener: (value: unknown) => void): this {
    const listeners = this.#listeners.get(event) ?? new Set<(value: unknown) => void>();
    listeners.add(listener);
    this.#listeners.set(event, listeners);
    return this;
  }

  off(event: string, listener: (value: unknown) => void): this {
    this.#listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string, value?: unknown): void {
    for (const listener of [...(this.#listeners.get(event) ?? [])]) listener(value);
  }
}

const FAKE_ORIGIN = 'https://example.test';
const FAKE_ROOT_FRAME_ID = 'root-frame';

interface FakeCommand {
  readonly method: string;
  readonly params: { readonly requestId?: string } | undefined;
}

/** 偽の page の session の命令の応答を決める（`undefined` なら、成功）。 */
type FakeResponder = (method: string, params: FakeCommand['params']) => Promise<unknown> | undefined;

interface FakeGuard {
  readonly ledger: SafetyLedger;
  readonly page: Page;
  readonly context: BrowserContext;
  readonly commands: readonly FakeCommand[];
  /** Guard の page の session に、CDP の事象を送る。 */
  emitCdp(method: string, params?: unknown): void;
  /** Guard に、Playwright の `requestfailed` を送る。 */
  emitRequestFailed(request: Request): void;
}

/** 偽の Context に Guard を取り付け、偽の page を Guard の準備ができた状態にする。 */
async function startFakeGuard(respond: FakeResponder = () => undefined): Promise<FakeGuard> {
  const contextEvents = new FakeEmitter();
  const sessionEvents = new FakeEmitter();
  const commands: FakeCommand[] = [];
  const pages: Page[] = [];
  const session = {
    on: (event: string, listener: (value: unknown) => void) => sessionEvents.on(event, listener),
    off: (event: string, listener: (value: unknown) => void) => sessionEvents.off(event, listener),
    send: async (method: string, params?: FakeCommand['params']): Promise<unknown> => {
      commands.push({ method, params });
      const responded = respond(method, params);
      if (responded !== undefined) return responded;
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: FAKE_ROOT_FRAME_ID } } };
      return undefined;
    },
  };
  const context = {
    pages: () => pages,
    on: (event: string, listener: (value: unknown) => void) => contextEvents.on(event, listener),
    off: (event: string, listener: (value: unknown) => void) => contextEvents.off(event, listener),
    newCDPSession: async () => session as unknown as CDPSession,
    routeWebSocket: async () => undefined,
    route: async () => undefined,
    close: async () => undefined,
  } as unknown as BrowserContext;
  const page = {
    context: () => context,
    isClosed: () => false,
    url: () => `${FAKE_ORIGIN}/`,
    on: () => page,
    off: () => page,
  } as unknown as Page;
  const ledger = new SafetyLedger();
  await installPassiveRequestGuard(context, ledger, new Set([FAKE_ORIGIN]));
  pages.push(page);
  contextEvents.emit('page', page);
  await awaitPassiveRequestGuardReady(page);
  fakeGuards.push(context);
  return {
    ledger,
    page,
    context,
    commands,
    emitCdp: (method, params) => sessionEvents.emit(method, params),
    emitRequestFailed: (request) => contextEvents.emit('requestfailed', request),
  };
}

const fakeGuards: BrowserContext[] = [];

afterEach(async () => {
  for (const context of fakeGuards.splice(0)) {
    await closePassiveGuardedContext(context).catch(() => undefined);
  }
});

/** main frame の文書の要求（偽の Guard の、1つの要求）。 */
interface FakeDocument {
  readonly requestId: string;
  readonly networkId: string;
  readonly url: string;
  readonly method?: string;
}

const fakeDocument = (index: number, url = `${FAKE_ORIGIN}/document-${index}`): FakeDocument => ({
  requestId: `interception-${index}`,
  networkId: `network-${index}`,
  url,
});

/** Guard の page の session に、main frame の文書の要求の Request の段階の一時停止を送り、Guard が `Fetch.continueRequest` を送るまで待つ。 */
async function pauseAndContinue(guard: FakeGuard, document: FakeDocument): Promise<void> {
  const sentBefore = guard.commands.length;
  guard.emitCdp('Fetch.requestPaused', {
    requestId: document.requestId,
    networkId: document.networkId,
    frameId: FAKE_ROOT_FRAME_ID,
    request: { method: document.method ?? 'GET', url: document.url },
  });
  for (let turn = 0; turn < 10; turn += 1) {
    await yieldMacrotask();
    if (guard.commands.slice(sentBefore).some((command) => command.method === 'Fetch.continueRequest'
      && command.params?.requestId === document.requestId)) {
      // 命令の成功の処理（`await` の後）まで進める。
      await yieldMacrotask();
      return;
    }
  }
  throw new Error(`the Guard did not continue ${document.requestId}: ${JSON.stringify(guard.commands.slice(sentBefore))}`);
}

/** 同じ session の、文書の要求の取り消しの証拠（`Network.loadingFailed`）。 */
const canceledEvidence = (document: FakeDocument, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  requestId: document.networkId,
  canceled: true,
  type: 'Document',
  errorText: ABORTED,
  ...overrides,
});

/** Playwright の `requestfailed` が受ける、main frame のナビゲーションの要求。 */
const failedNavigation = (page: Page, document: FakeDocument, errorText = ABORTED): Request => ({
  isNavigationRequest: () => true,
  frame: () => ({ parentFrame: () => null, page: () => page }),
  method: () => document.method ?? 'GET',
  url: () => document.url,
  failure: () => ({ errorText }),
  response: async () => null,
}) as unknown as Request;

/** Guard の作業が終わり、記録された違反を返す（証拠を待つ時間より長く待つ）。 */
async function violationsAfterSettle(guard: FakeGuard): Promise<readonly { readonly code: string; readonly message: string }[]> {
  await wait(SETTLE_AFTER_CANCEL_MS);
  return guard.ledger.snapshot().invariantViolations;
}

describe('DEF-027: the Guard\'s evidence of a main-frame document canceled before any response (fake page session)', () => {
  it('baseline: continued, canceled with net::ERR_ABORTED, and no response → not a violation (the harness reaches the new path)', async () => {
    const guard = await startFakeGuard();
    const document = fakeDocument(1);
    await pauseAndContinue(guard, document);

    guard.emitCdp('Network.loadingFailed', canceledEvidence(document));
    guard.emitRequestFailed(failedNavigation(guard.page, document));

    expect(await violationsAfterSettle(guard)).toEqual([]);
    expect(isPassiveRequestGuardClosed(guard.context)).toBe(false);
  });

  it('the evidence arrives after the requestfailed event, within the wait: not a violation', async () => {
    const guard = await startFakeGuard();
    const document = fakeDocument(1);
    await pauseAndContinue(guard, document);

    guard.emitRequestFailed(failedNavigation(guard.page, document));
    await wait(CANCELED_DOCUMENT_EVIDENCE_WAIT_MS / 5);
    guard.emitCdp('Network.loadingFailed', canceledEvidence(document));

    expect(await violationsAfterSettle(guard)).toEqual([]);
  });

  // 8. 証拠がない場合。
  it('the evidence never arrives: a violation after the wait', async () => {
    const guard = await startFakeGuard();
    const document = fakeDocument(1);
    await pauseAndContinue(guard, document);

    guard.emitRequestFailed(failedNavigation(guard.page, document));

    expect(await violationsAfterSettle(guard)).toEqual([DELIVERY_FAILED]);
  });

  it('beyond the evidence limit: the canceled request\'s evidence is not remembered, so it stays a violation', async () => {
    const guard = await startFakeGuard();
    const document = fakeDocument(1);
    await pauseAndContinue(guard, document);
    for (let index = 0; index < MAX_CANCELED_DOCUMENT_EVIDENCE; index += 1) {
      guard.emitCdp('Network.loadingFailed', { requestId: `other-${index}`, canceled: true, type: 'Document', errorText: ABORTED });
    }

    guard.emitCdp('Network.loadingFailed', canceledEvidence(document));
    guard.emitRequestFailed(failedNavigation(guard.page, document));

    expect(await violationsAfterSettle(guard)).toEqual([DELIVERY_FAILED]);
  });

  it('beyond the main-frame document record limit: the request is not remembered, so its cancellation stays a violation', async () => {
    const guard = await startFakeGuard();
    // 応答を受けたまま終わっていない main frame の文書の要求で、記録を上限まで埋める（Response の段階の一時停止で、リダイレクトの
    // 対応付けの登録も消す）。
    for (let index = 0; index < MAX_CANCELED_DOCUMENT_EVIDENCE; index += 1) {
      const filler = fakeDocument(index);
      await pauseAndContinue(guard, filler);
      guard.emitCdp('Fetch.requestPaused', {
        requestId: filler.requestId,
        networkId: filler.networkId,
        frameId: FAKE_ROOT_FRAME_ID,
        request: { method: 'GET', url: filler.url },
        responseStatusCode: STATUS.ok,
        responseHeaders: [],
      });
      await yieldMacrotask();
    }
    expect(guard.ledger.snapshot().invariantViolations).toEqual([]);
    const document = fakeDocument(MAX_CANCELED_DOCUMENT_EVIDENCE);
    await pauseAndContinue(guard, document);

    guard.emitCdp('Network.loadingFailed', canceledEvidence(document));
    guard.emitRequestFailed(failedNavigation(guard.page, document));

    expect(await violationsAfterSettle(guard)).toEqual([DELIVERY_FAILED]);
  });

  it('the evidence is older than its retention: a violation', async () => {
    const guard = await startFakeGuard();
    const document = fakeDocument(1);
    await pauseAndContinue(guard, document);
    guard.emitCdp('Network.loadingFailed', canceledEvidence(document));

    // 時計だけを進める（Guard の待ちの setTimeout は、実際の時間で動かす）。
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + CANCELED_DOCUMENT_EVIDENCE_RETENTION_MS + 1);
    guard.emitRequestFailed(failedNavigation(guard.page, document));

    expect(await violationsAfterSettle(guard)).toEqual([DELIVERY_FAILED]);
  });

  it('the record of the continued request is older than its retention when it is canceled: a violation', async () => {
    const guard = await startFakeGuard();
    const document = fakeDocument(1);
    await pauseAndContinue(guard, document);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + PENDING_MAIN_FRAME_DOCUMENT_RETENTION_MS + 1);
    guard.emitCdp('Network.loadingFailed', canceledEvidence(document));
    guard.emitRequestFailed(failedNavigation(guard.page, document));

    expect(await violationsAfterSettle(guard)).toEqual([DELIVERY_FAILED]);
  });

  it('the session closes while the Guard waits for the evidence: still a violation, and later evidence is ignored', async () => {
    const guard = await startFakeGuard();
    const document = fakeDocument(1);
    await pauseAndContinue(guard, document);

    guard.emitRequestFailed(failedNavigation(guard.page, document));
    await yieldMacrotask();
    guard.emitCdp('close');
    guard.emitCdp('Network.loadingFailed', canceledEvidence(document));

    // session を閉じたこと自体の違反（`CDP_SESSION_DETACHED`）は、修正の前は記録されない（先に記録された違反で、Guard が閉じる途中に
    // なるため）。ここでは、取り消しの失敗が違反のままであることだけを確かめる。
    expect(await violationsAfterSettle(guard)).toContainEqual(DELIVERY_FAILED);
  });

  // 9. 区別できない場合。
  it('two continued requests with the same page, method and URL: the cancellation cannot be told apart, so it stays a violation', async () => {
    const guard = await startFakeGuard();
    const url = `${FAKE_ORIGIN}/same`;
    const first = fakeDocument(1, url);
    const second = fakeDocument(2, url);
    await pauseAndContinue(guard, first);
    await pauseAndContinue(guard, second);

    guard.emitCdp('Network.loadingFailed', canceledEvidence(first));
    guard.emitRequestFailed(failedNavigation(guard.page, first));

    expect(await violationsAfterSettle(guard)).toEqual([DELIVERY_FAILED]);
  });

  it('a request that finished (Network.loadingFinished) is no longer a candidate', async () => {
    const guard = await startFakeGuard();
    const url = `${FAKE_ORIGIN}/same`;
    const loaded = fakeDocument(1, url);
    const canceled = fakeDocument(2, url);
    await pauseAndContinue(guard, loaded);
    guard.emitCdp('Network.loadingFinished', { requestId: loaded.networkId });
    await pauseAndContinue(guard, canceled);

    guard.emitCdp('Network.loadingFailed', canceledEvidence(canceled));
    guard.emitRequestFailed(failedNavigation(guard.page, canceled));

    expect(await violationsAfterSettle(guard)).toEqual([]);
  });

  it('the evidence is used once: a second requestfailed for the same request is a violation', async () => {
    const guard = await startFakeGuard();
    const document = fakeDocument(1);
    await pauseAndContinue(guard, document);
    guard.emitCdp('Network.loadingFailed', canceledEvidence(document));

    guard.emitRequestFailed(failedNavigation(guard.page, document));
    await wait(SETTLE_AFTER_CANCEL_MS);
    expect(guard.ledger.snapshot().invariantViolations).toEqual([]);
    guard.emitRequestFailed(failedNavigation(guard.page, document));

    expect(await violationsAfterSettle(guard)).toEqual([DELIVERY_FAILED]);
  });

  // (c) 応答を1つでも受けた要求は、対象にしない。
  it.each([
    ['a Response-stage pause', (guard: FakeGuard, document: FakeDocument): void => guard.emitCdp('Fetch.requestPaused', {
      requestId: document.requestId,
      networkId: document.networkId,
      frameId: FAKE_ROOT_FRAME_ID,
      request: { method: 'GET', url: document.url },
      responseStatusCode: STATUS.noContent,
      responseHeaders: [],
    })],
    ['Network.responseReceived', (guard: FakeGuard, document: FakeDocument): void => guard.emitCdp('Network.responseReceived', {
      requestId: document.networkId,
      type: 'Document',
      frameId: FAKE_ROOT_FRAME_ID,
      response: { status: STATUS.ok },
    })],
    ['a redirect (Network.requestWillBeSent with redirectResponse)', (guard: FakeGuard, document: FakeDocument): void => guard.emitCdp(
      'Network.requestWillBeSent',
      { requestId: document.networkId, type: 'Document', frameId: FAKE_ROOT_FRAME_ID, redirectResponse: { status: 302 } },
    )],
  ] as const)('after %s, a cancellation stays a violation', async (_name, respond) => {
    const guard = await startFakeGuard();
    const document = fakeDocument(1);
    await pauseAndContinue(guard, document);

    respond(guard, document);
    await yieldMacrotask();
    guard.emitCdp('Network.loadingFailed', canceledEvidence(document));
    guard.emitRequestFailed(failedNavigation(guard.page, document));

    expect(await violationsAfterSettle(guard)).toEqual([DELIVERY_FAILED]);
  });

  // (b) 取り消しの証拠の形。
  it.each([
    ['not canceled', { canceled: false }],
    ['not a Document', { type: 'Other' }],
    ['another error text', { errorText: 'net::ERR_FAILED' }],
  ] as const)('a loadingFailed that is %s is not the evidence: a violation', async (_name, overrides) => {
    const guard = await startFakeGuard();
    const document = fakeDocument(1);
    await pauseAndContinue(guard, document);

    guard.emitCdp('Network.loadingFailed', canceledEvidence(document, overrides));
    guard.emitRequestFailed(failedNavigation(guard.page, document));

    expect(await violationsAfterSettle(guard)).toEqual([DELIVERY_FAILED]);
  });

  // (a) Guard が許可して進めた（`Fetch.continueRequest` が成功した）要求に限る。一時停止の間に取り消された要求への命令の失敗（DEF-026 で
  // 違反にしない）は、進めたことにならない。
  it('a request canceled while paused (the continue command failed, tolerated by DEF-026): its requestfailed stays a violation', async () => {
    const [invalidInterceptionId] = INVALID_INTERCEPTION_ID_FAILURE_TEXTS;
    const document = fakeDocument(1);
    let guardForEvidence: FakeGuard | undefined;
    const guard = await startFakeGuard((method) => (method === 'Fetch.continueRequest'
      ? Promise.resolve().then(() => {
        guardForEvidence?.emitCdp('Network.loadingFailed', canceledEvidence(document));
        throw new Error(invalidInterceptionId);
      })
      : undefined));
    guardForEvidence = guard;
    guard.emitCdp('Fetch.requestPaused', {
      requestId: document.requestId,
      networkId: document.networkId,
      frameId: FAKE_ROOT_FRAME_ID,
      request: { method: 'GET', url: document.url },
    });
    await expect.poll(() => guard.commands.some((command) => command.method === 'Fetch.continueRequest')).toBe(true);

    guard.emitRequestFailed(failedNavigation(guard.page, document));

    // DEF-026 のとおり、命令の失敗は違反にならない。main frame の失敗は、進めた証拠がないので違反のまま。
    expect(await violationsAfterSettle(guard)).toEqual([DELIVERY_FAILED]);
  });

  it('a request of a subframe is not a main-frame candidate: a main-frame failure with the same URL stays a violation', async () => {
    const guard = await startFakeGuard();
    const document = fakeDocument(1);
    const sentBefore = guard.commands.length;
    guard.emitCdp('Fetch.requestPaused', {
      requestId: document.requestId,
      networkId: document.networkId,
      frameId: 'child-frame',
      request: { method: 'GET', url: document.url },
    });
    await expect.poll(() => guard.commands.slice(sentBefore).some((command) => command.method === 'Fetch.continueRequest')).toBe(true);
    await yieldMacrotask();

    guard.emitCdp('Network.loadingFailed', canceledEvidence(document));
    guard.emitRequestFailed(failedNavigation(guard.page, document));

    expect(await violationsAfterSettle(guard)).toEqual([DELIVERY_FAILED]);
  });
});
