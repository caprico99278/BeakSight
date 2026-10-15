// CCX-7a（共通化の台帳の CC-045）: `page.goto` の結果を読み込みの終わり方（`MainFrameLoadSettlement`）に変える処理を
// `src/browser/main-frame-load.ts` に 1 つにまとめる前後で、3 つの呼ぶ側の観測（`observeMainFrameLoad` の結果）が変わらないことを固定する。
// - `navigatePage`（`src/orchestration/page-navigation.ts`。`waitUntil: 'domcontentloaded'`）
// - `collectSiteMetadata` の各ファイルの取得（`src/crawl/site-metadata.ts`。`waitUntil: 'domcontentloaded'`。受け口 `afterNavigation`）
// - `auditInteraction` の候補の読み込み（`src/interaction/isolated-auditor.ts`。`waitUntil: 'load'`。受け口 `afterTargetLoad`。
//   観測とともに、読み込みの直後に止めた診断の記録の結果を渡す）
// 終わり方の表: 応答あり（2xx・4xx・5xx）、応答なし（`null`。同じ文書の中のナビゲーション）、期限切れの例外、読み込みの失敗の例外
// （サーバが接続を切る）、ページを閉じた後。呼ぶ側の作りで起こせない行は、表に載せない（理由を各表に書く）。
// まとめた部品（`settleMainFrameLoad`）そのものの終わり方も、同じ行の表で確かめる。
// 実際の headless の Chromium（テストの既定と、CLI と同じ起動の設定の両方）と、テストの中の 127.0.0.1 のサーバで確かめる。
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { settleMainFrameLoad, type MainFrameLoadObservation } from '../../src/browser/main-frame-load.js';
import { isPlaywrightTimeoutError } from '../../src/browser/playwright-errors.js';
import type { Viewport } from '../../src/config/types.js';
import type { NavigationDiagnostics } from '../../src/core/contracts.js';
import { safeErrorMessage } from '../../src/core/errors.js';
import { MAX_ERROR_MESSAGE_LENGTH } from '../../src/core/limits.js';
import { collectSiteMetadata } from '../../src/crawl/site-metadata.js';
import { auditInteraction } from '../../src/interaction/isolated-auditor.js';
import { IdAllocator } from '../../src/orchestration/id-allocator.js';
import { chromiumNetErrorCode, navigatePage } from '../../src/orchestration/page-navigation.js';
import type { InteractionCandidate } from '../../src/safety/interaction-policy.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { discoverInteractionCandidate, interactionAuditInput } from '../helpers/gate-harness.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { NO_PACING_WAIT } from '../helpers/navigation-pacer.js';
import { createTestConfig, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

/** 1 つのテストの上限（ms）。Interaction の監査（session の作成、読み込み、閉じる処理）を含む。 */
const TEST_TIMEOUT_MS = 60_000;
/** 期限切れを起こす読み込みの期限（ms）。実際に期限切れを起こすので、短くする。 */
const SHORT_LOAD_TIMEOUT_MS = 1_000;
/** 期限切れを起こさない読み込みの期限（ms）。 */
const LOAD_TIMEOUT_MS = 10_000;

const OK_STATUS = 200;
const NOT_FOUND_STATUS = 404;
const SERVICE_UNAVAILABLE_STATUS = 503;
const HTML_CONTENT_TYPE = 'text/html; charset=utf-8';
const TEXT_CONTENT_TYPE = 'text/plain; charset=utf-8';
const CANDIDATE_NAME = 'Toggle details';
const viewport: Viewport = Object.freeze({ width: 900, height: 700 });

/** テストのサーバの、文書のパス（どれも accordion の fixture の文書を返す。応答しない・接続を切るパスを除く）。 */
const PATHS = Object.freeze({
  ok: '/ok.html',
  notFound: '/not-found.html',
  unavailable: '/unavailable.html',
  /** 接続を受けるが、何も返さない。 */
  hang: '/hang.html',
  /** 接続を受けて、何も返さずに切る。 */
  reset: '/reset.html',
});
type DocumentPath = (typeof PATHS)[keyof typeof PATHS];

/** robots.txt と sitemap.xml の応答の仕方（`collectSiteMetadata` の表の行）。 */
type MetadataMode = 'OK' | 'NOT_FOUND' | 'UNAVAILABLE' | 'HANG' | 'RESET';

/**
 * 観測の要約（失敗の詳細は、本文の代わりに種類にする）。
 * - `null`: 失敗の詳細がない。
 * - `net::ERR_…`: Chromium のネットワークのエラーのコード（`chromiumNetErrorCode`）。
 * - `TIMEOUT_MESSAGE`: Playwright の期限切れのメッセージ（`Timeout` を含む）。
 * - `CLOSED_MESSAGE`: 閉じたページ・Context・ブラウザのメッセージ（`closed` を含む）。
 * - `OTHER_MESSAGE`: そのほかのメッセージ。
 */
interface ObservationSummary {
  readonly navigationOutcome: MainFrameLoadObservation['navigationOutcome'];
  readonly httpStatus: number | null;
  readonly failureDetail: string | null;
  readonly frozen: boolean;
}

function detailKind(detail: string | null): string | null {
  if (detail === null) {
    return null;
  }
  expect(detail.length).toBeGreaterThan(0);
  expect(detail.length).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_LENGTH);
  const code = chromiumNetErrorCode(detail);
  if (code !== null) {
    return code;
  }
  if (/Timeout/u.test(detail)) {
    return 'TIMEOUT_MESSAGE';
  }
  return /closed/u.test(detail) ? 'CLOSED_MESSAGE' : 'OTHER_MESSAGE';
}

function summarize(observation: MainFrameLoadObservation): ObservationSummary {
  return {
    navigationOutcome: observation.navigationOutcome,
    httpStatus: observation.httpStatus,
    failureDetail: detailKind(observation.failureDetail),
    frozen: Object.isFrozen(observation),
  };
}

const ok = (httpStatus: number | null): ObservationSummary =>
  ({ navigationOutcome: 'OK', httpStatus, failureDetail: null, frozen: true });
const failed = (
  navigationOutcome: 'TIMEOUT' | 'FAILED',
  failureDetail: string,
  httpStatus: number | null = null,
): ObservationSummary => ({ navigationOutcome, httpStatus, failureDetail, frozen: true });

/** 受けた接続を、何も返さずに切る。 */
function resetConnection(request: IncomingMessage): void {
  request.socket.destroy();
}

function sendDocument(response: ServerResponse, status: number, body: string, contentType: string): void {
  response.writeHead(status, { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) });
  response.end(body);
}

/**
 * Interaction の session の文書の要求は、出口の中継（`src/safety/egress-proxy.ts`）を通る。中継は、その先のサーバが接続を切ると
 * 502 Bad Gateway（本文なし）を返す。その 502 の扱いは、Chromium の起動の設定で違う（2026-10-12 に確かめた今の振る舞い）。
 * - テストの既定の headless shell: 502 の応答として読み込みが終わる（`OK`、502）。
 * - CLI と同じ起動の設定（新しい headless）: 本文のない 502 で読み込みが失敗する（`FAILED`、`net::ERR_HTTP_RESPONSE_CODE_FAILURE`、502）。
 */
const BAD_GATEWAY_STATUS = 502;

interface Launcher {
  readonly launch: () => Promise<Browser>;
  /** Interaction の候補の読み込みで、サーバが接続を切ったときの観測。 */
  readonly interactionResetObservation: ObservationSummary;
}

const LAUNCHERS: readonly (readonly [string, Launcher])[] = [
  ['the default test Chromium', { launch: () => launchHeadlessChromium(), interactionResetObservation: ok(BAD_GATEWAY_STATUS) }],
  ['the CLI launch settings', {
    launch: () => launchCliChromium(),
    interactionResetObservation: failed('FAILED', 'net::ERR_HTTP_RESPONSE_CODE_FAILURE', BAD_GATEWAY_STATUS),
  }],
];

describe.each(LAUNCHERS)('the observations of the three callers of page.goto (CCX-7a, %s)', (_name, launcher) => {
  const { launch } = launcher;
  let browser: Browser;
  let server: LoopbackHttpServer;
  let accordion: string;
  let metadataMode: MetadataMode = 'OK';
  const plainContexts: BrowserContext[] = [];

  function respondMetadata(request: IncomingMessage, response: ServerResponse): void {
    switch (metadataMode) {
      case 'OK':
        sendDocument(response, OK_STATUS, 'User-agent: *\n', TEXT_CONTENT_TYPE);
        return;
      case 'NOT_FOUND':
        sendDocument(response, NOT_FOUND_STATUS, 'not found\n', TEXT_CONTENT_TYPE);
        return;
      case 'UNAVAILABLE':
        sendDocument(response, SERVICE_UNAVAILABLE_STATUS, 'maintenance\n', TEXT_CONTENT_TYPE);
        return;
      case 'HANG':
        return;
      case 'RESET':
        resetConnection(request);
        return;
    }
  }

  beforeAll(async () => {
    accordion = await readFile(resolve(process.cwd(), 'fixtures/site/accordion.html'), 'utf8');
    server = await startLoopbackHttpServer((request, response) => {
      const path = (request.url ?? '/').split(/[?#]/u, 1)[0] ?? '/';
      switch (path) {
        case PATHS.ok:
          sendDocument(response, OK_STATUS, accordion, HTML_CONTENT_TYPE);
          return;
        case PATHS.unavailable:
          sendDocument(response, SERVICE_UNAVAILABLE_STATUS, accordion, HTML_CONTENT_TYPE);
          return;
        case PATHS.hang:
          return;
        case PATHS.reset:
          resetConnection(request);
          return;
        case '/robots.txt':
        case '/sitemap.xml':
          respondMetadata(request, response);
          return;
        default:
          sendDocument(response, NOT_FOUND_STATUS, accordion, HTML_CONTENT_TYPE);
      }
    });
    browser = await launch();
  });

  afterAll(async () => {
    for (const context of plainContexts.splice(0)) {
      await context.close();
    }
    await browser?.close();
    await server?.close();
  });

  function factoryFor(): BrowserContextFactory {
    return new BrowserContextFactory(browser, createTestConfig(server.origin, PATHS.ok), () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
  }

  async function newPlainPage(): Promise<Page> {
    const context = await browser.newContext();
    plainContexts.push(context);
    return context.newPage();
  }

  /** 終わり方の要約（応答の status、応答なし、例外の種類）。 */
  type SettlementSummary =
    | Readonly<{ status: 'FULFILLED'; httpStatus: number | null; frozen: boolean }>
    | Readonly<{ status: 'REJECTED'; timeout: boolean; detail: string | null; frozen: boolean }>;

  async function settle(page: Page, path: string, timeoutMs: number = LOAD_TIMEOUT_MS): Promise<SettlementSummary> {
    const settlement = await settleMainFrameLoad(page, `${server.origin}${path}`, { waitUntil: 'domcontentloaded', timeoutMs });
    const frozen = Object.isFrozen(settlement);
    return settlement.status === 'FULFILLED'
      ? { status: 'FULFILLED', httpStatus: settlement.value?.status() ?? null, frozen }
      : {
        status: 'REJECTED',
        timeout: isPlaywrightTimeoutError(settlement.reason),
        detail: detailKind(safeErrorMessage(settlement.reason, MAX_ERROR_MESSAGE_LENGTH)),
        frozen,
      };
  }

  // 終わり方を作る部品そのものの表（読み込みの終わり方は、呼ぶ側の観測の表と同じ行）。
  describe('settleMainFrameLoad', () => {
    it.each([
      ['a 2xx response', PATHS.ok, OK_STATUS],
      ['a 4xx response', PATHS.notFound, NOT_FOUND_STATUS],
      ['a 5xx response', PATHS.unavailable, SERVICE_UNAVAILABLE_STATUS],
    ] as const)('settles %s as FULFILLED with the response', async (_case, path, httpStatus) => {
      const page = await newPlainPage();
      expect(await settle(page, path)).toEqual({ status: 'FULFILLED', httpStatus, frozen: true });
    }, TEST_TIMEOUT_MS);

    it('settles a same-document navigation as FULFILLED without a response', async () => {
      const page = await newPlainPage();
      await settle(page, PATHS.ok);
      expect(await settle(page, `${PATHS.ok}#part`)).toEqual({ status: 'FULFILLED', httpStatus: null, frozen: true });
    }, TEST_TIMEOUT_MS);

    it('settles the timeout exception as REJECTED without throwing', async () => {
      const page = await newPlainPage();
      expect(await settle(page, PATHS.hang, SHORT_LOAD_TIMEOUT_MS))
        .toEqual({ status: 'REJECTED', timeout: true, detail: 'TIMEOUT_MESSAGE', frozen: true });
    }, TEST_TIMEOUT_MS);

    it('settles the load failure exception as REJECTED without throwing', async () => {
      const page = await newPlainPage();
      expect(await settle(page, PATHS.reset))
        .toEqual({ status: 'REJECTED', timeout: false, detail: 'net::ERR_EMPTY_RESPONSE', frozen: true });
    }, TEST_TIMEOUT_MS);

    it('settles the exception after the page was closed as REJECTED without throwing', async () => {
      const page = await newPlainPage();
      await page.close();
      expect(await settle(page, PATHS.ok))
        .toEqual({ status: 'REJECTED', timeout: false, detail: 'CLOSED_MESSAGE', frozen: true });
    }, TEST_TIMEOUT_MS);
  });

  describe('navigatePage (waitUntil: domcontentloaded)', () => {
    async function navigate(page: Page, path: string, timeoutMs: number = LOAD_TIMEOUT_MS): Promise<MainFrameLoadObservation> {
      const result = await navigatePage(page, `${server.origin}${path}`, {
        timeoutMs,
        ledger: new SafetyLedger(),
        allowedQueryParameters: new Set(),
      });
      return result.loadObservation;
    }

    it.each([
      ['a 2xx response', PATHS.ok, ok(OK_STATUS)],
      ['a 4xx response', PATHS.notFound, ok(NOT_FOUND_STATUS)],
      ['a 5xx response', PATHS.unavailable, ok(SERVICE_UNAVAILABLE_STATUS)],
    ] as const)('observes %s', async (_case, path, expected) => {
      const page = await newPlainPage();
      expect(summarize(await navigate(page, path))).toEqual(expected);
    }, TEST_TIMEOUT_MS);

    // 追跡は呼び出しごとに付けるので、同じ文書の中のナビゲーション（文書の要求がない）では、追跡の値も `null` である。
    it('observes no HTTP status when page.goto resolves without a response (a same-document navigation)', async () => {
      const page = await newPlainPage();
      await navigate(page, PATHS.unavailable);
      expect(summarize(await navigate(page, `${PATHS.unavailable}#part`))).toEqual(ok(null));
    }, TEST_TIMEOUT_MS);

    it('observes the timeout exception', async () => {
      const page = await newPlainPage();
      expect(summarize(await navigate(page, PATHS.hang, SHORT_LOAD_TIMEOUT_MS))).toEqual(failed('TIMEOUT', 'TIMEOUT_MESSAGE'));
    }, TEST_TIMEOUT_MS);

    it('observes the load failure exception', async () => {
      const page = await newPlainPage();
      expect(summarize(await navigate(page, PATHS.reset))).toEqual(failed('FAILED', 'net::ERR_EMPTY_RESPONSE'));
    }, TEST_TIMEOUT_MS);

    it('observes the exception after the page was closed', async () => {
      const page = await newPlainPage();
      await page.close();
      expect(summarize(await navigate(page, PATHS.ok))).toEqual(failed('FAILED', 'CLOSED_MESSAGE'));
    }, TEST_TIMEOUT_MS);
  });

  // 取得する URL は robots.txt と sitemap.xml に決まっているので、同じ文書の中のナビゲーション（応答なしの `null`）は起こせない。
  describe('collectSiteMetadata (waitUntil: domcontentloaded, afterNavigation)', () => {
    /** Passive の page を作るたびに覚え、間隔の待ち（`beforeNavigation`）で閉じられるようにする factory。 */
    class PageRecordingFactory extends BrowserContextFactory {
      readonly pages: Page[] = [];

      override async createPassivePage(context: BrowserContext): Promise<Page> {
        const page = await super.createPassivePage(context);
        this.pages.push(page);
        return page;
      }
    }

    async function collectObservations(
      mode: MetadataMode,
      options: { readonly navigationTimeoutMs?: number; readonly closePageBeforeNavigation?: boolean } = {},
    ): Promise<readonly ObservationSummary[]> {
      metadataMode = mode;
      const config = createTestConfig(server.origin, '/', {
        crawl: { navigationTimeoutMs: options.navigationTimeoutMs ?? LOAD_TIMEOUT_MS },
      });
      const contextFactory = new PageRecordingFactory(browser, config, () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
      const allocator = new IdAllocator();
      const observations: MainFrameLoadObservation[] = [];
      await collectSiteMetadata({
        contextFactory,
        origin: server.origin,
        config,
        pageId: allocator.allocatePageId(),
        allocator,
        clock: () => new Date(0),
        beforeNavigation: options.closePageBeforeNavigation === true
          ? async () => {
            for (const page of contextFactory.pages) {
              await page.close();
            }
            return NO_PACING_WAIT();
          }
          : NO_PACING_WAIT,
        afterNavigation: (observation) => observations.push(observation),
      });
      return observations.map(summarize);
    }

    it.each([
      ['a 2xx response', 'OK', ok(OK_STATUS)],
      ['a 4xx response', 'NOT_FOUND', ok(NOT_FOUND_STATUS)],
      ['a 5xx response', 'UNAVAILABLE', ok(SERVICE_UNAVAILABLE_STATUS)],
    ] as const)('observes %s for robots.txt and sitemap.xml', async (_case, mode, expected) => {
      expect(await collectObservations(mode)).toEqual([expected, expected]);
    }, TEST_TIMEOUT_MS);

    it('observes the timeout exception for robots.txt and sitemap.xml', async () => {
      const expected = failed('TIMEOUT', 'TIMEOUT_MESSAGE');
      expect(await collectObservations('HANG', { navigationTimeoutMs: SHORT_LOAD_TIMEOUT_MS })).toEqual([expected, expected]);
    }, TEST_TIMEOUT_MS);

    it('observes the load failure exception for robots.txt and sitemap.xml', async () => {
      const expected = failed('FAILED', 'net::ERR_EMPTY_RESPONSE');
      expect(await collectObservations('RESET')).toEqual([expected, expected]);
    }, TEST_TIMEOUT_MS);

    // robots.txt の読み込みが閉じたページで失敗した後、sitemap.xml の読み込みは始めない（受け口は 1 回だけ呼ばれる）。
    it('observes the exception after the page was closed for robots.txt, and does not load sitemap.xml', async () => {
      expect(await collectObservations('OK', { closePageBeforeNavigation: true })).toEqual([failed('FAILED', 'CLOSED_MESSAGE')]);
    }, TEST_TIMEOUT_MS);
  });

  // 候補の読み込みは、session ごとに 1 回だけ（新しい page で始める）なので、同じ文書の中のナビゲーション（応答なしの `null`）は起こせない。
  describe('auditInteraction target load (waitUntil: load, afterTargetLoad)', () => {
    let candidate: InteractionCandidate;

    beforeAll(async () => {
      candidate = await discoverInteractionCandidate(factoryFor(), server.origin, viewport, PATHS.ok, CANDIDATE_NAME, {
        expectedCompleteness: 'COMPLETE',
      });
    }, TEST_TIMEOUT_MS);

    interface TargetLoad {
      readonly observations: readonly ObservationSummary[];
      /** 受け口に渡った診断の記録の状態（読み込みの直後に止めた観察の結果）。 */
      readonly diagnostics: readonly NavigationDiagnostics['status'][];
    }

    async function auditTarget(
      path: DocumentPath,
      options: { readonly navigationTimeoutMs?: number; readonly closePageBeforeLoad?: boolean } = {},
    ): Promise<TargetLoad> {
      const factory = factoryFor();
      const observations: MainFrameLoadObservation[] = [];
      const diagnostics: NavigationDiagnostics['status'][] = [];
      await auditInteraction({
        ...interactionAuditInput({ factory, origin: server.origin, viewport, path, candidate }),
        ...(options.navigationTimeoutMs === undefined ? {} : { navigationTimeoutMs: options.navigationTimeoutMs }),
        ...(options.closePageBeforeLoad === true
          ? {
            sessionFactory: async (sessionViewport: Viewport) => {
              const session = await factory.createInteractionSession(sessionViewport);
              await session.page.close();
              return session;
            },
          }
          : {}),
        afterTargetLoad: (observation, navigationDiagnostics) => {
          observations.push(observation);
          diagnostics.push(navigationDiagnostics.status);
        },
      });
      return { observations: observations.map(summarize), diagnostics };
    }

    it.each([
      ['a 2xx response', PATHS.ok, ok(OK_STATUS)],
      ['a 4xx response', PATHS.notFound, ok(NOT_FOUND_STATUS)],
      ['a 5xx response', PATHS.unavailable, ok(SERVICE_UNAVAILABLE_STATUS)],
    ] as const)('observes %s', async (_case, path, expected) => {
      expect(await auditTarget(path)).toEqual({ observations: [expected], diagnostics: ['OBSERVED'] });
    }, TEST_TIMEOUT_MS);

    it('observes the timeout exception', async () => {
      expect(await auditTarget(PATHS.hang, { navigationTimeoutMs: SHORT_LOAD_TIMEOUT_MS }))
        .toEqual({ observations: [failed('TIMEOUT', 'TIMEOUT_MESSAGE')], diagnostics: ['OBSERVED'] });
    }, TEST_TIMEOUT_MS);

    it('observes the load failure exception', async () => {
      expect(await auditTarget(PATHS.reset))
        .toEqual({ observations: [launcher.interactionResetObservation], diagnostics: ['OBSERVED'] });
    }, TEST_TIMEOUT_MS);

    it('observes the exception after the page was closed', async () => {
      expect(await auditTarget(PATHS.ok, { closePageBeforeLoad: true }))
        .toEqual({ observations: [failed('FAILED', 'CLOSED_MESSAGE')], diagnostics: ['NOT_OBSERVED'] });
    }, TEST_TIMEOUT_MS);
  });
});
