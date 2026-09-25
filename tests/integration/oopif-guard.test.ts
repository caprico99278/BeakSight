// C18i（RC18b の N1。Task 19 の前の整理の設計書 4.2、4.2.1）: 別のプロセスで動く iframe（OOPIF）にも、Guard の CDP の横取り
// （Document の Request と Response の段階）を付ける。OOPIF の中の、外部スキームへのサーバのリダイレクトも、たどる前に止めて記録する。
// RC18b の再現では、OOPIF の中の移動のリダイレクトは、記録が0件、違反が0件だった（止まらなかった）。
//
// 厳守事項:
// - Chromium は headless だけで起動する。標準の headless は OOPIF を作らないので、`--site-per-process` を付ける。
//   サイトの分離を無効にする起動の引数は、使わない。
// - headed の扱いは、headless のブラウザのまま、factory の設定（`browser.headed: true`）で Guard に「headed である」と注入して確かめる。
// - 別のサイトの iframe は、同じ fixture のサーバの別のホスト名（`127.0.0.1` と `localhost`）で作る。インターネット上のサイトは使わない。
// - 外部スキームの宛先は、fixture のサーバの中の固定の一覧（実在しないもの）だけである。
import type { Browser, BrowserContext, CDPSession, Frame, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import type { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { Viewport } from '../../src/config/types.js';
import { wait } from '../../src/core/deadline.js';
import { isPassiveRequestGuardClosed } from '../../src/safety/passive-request-guard.js';
import { launchHeadlessChromium, oopifTargetUrls, SITE_PER_PROCESS_ARGS } from '../helpers/chromium.js';
import {
  CROSS_SITE_FRAME_PAGE,
  crossSiteFramePath,
  crossSiteOriginOf,
  EXTERNAL_SCHEME_KEYS,
  EXTERNAL_SCHEME_REDIRECT_PATH,
  externalSchemeRedirectPath,
  NAVIGATION_TARGET_HEADING,
  NAVIGATION_TARGET_PAGE,
  SELF_NAVIGATING_FRAME_PAGE,
  selfNavigatingFramePath,
  SLOW_REDIRECT_PATH,
  stoppedRedirectRecord,
} from '../helpers/external-scheme-fixture.js';
import {
  createModeFactories,
  factoryModeCases,
  NO_NON_READ_REQUESTS,
  openServerWindow,
  QUIET_PERIOD_MS,
  withGuardedPassivePage,
  type FactoryMode,
} from '../helpers/gate-harness.js';

const viewport: Viewport = Object.freeze({ width: 800, height: 600 });
/** GATE の上限の確かめで、同時に加える OOPIF の数（Guard の上限 64 を超える数）。 */
const OOPIF_OVER_LIMIT_COUNT = 65;
/** 1件ずつ加えて外す OOPIF の数（Guard の上限 64 を超える数。外した OOPIF の登録が消えることの確かめ）。 */
const OOPIF_CHURN_COUNT = 66;
/** 多くの OOPIF を扱うテストの上限（ms）。 */
const MANY_OOPIF_TEST_TIMEOUT_MS = 120_000;

let browser: Browser;
let server: FixtureServer;
let factories: Readonly<Record<FactoryMode, BrowserContextFactory>>;
let headlessFactory: BrowserContextFactory;
/** 別のホスト名（`localhost`）の、同じ fixture のサーバの Origin。 */
let crossSiteOrigin: string;

beforeAll(async () => {
  server = await startFixtureServer();
  crossSiteOrigin = crossSiteOriginOf(server.origin);
  // headless だけで起動する。`--site-per-process` は、別のサイトの iframe を別のプロセス（OOPIF）にする（サイトの分離を強める側の引数）。
  browser = await launchHeadlessChromium({ args: SITE_PER_PROCESS_ARGS });
  // headless のブラウザのまま、設定だけを headed にする factory も作る（Guard に「headed である」と注入する）。
  factories = createModeFactories(browser, server.origin);
  headlessFactory = factories.headless;
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const MODE_CASES = factoryModeCases(EXTERNAL_SCHEME_KEYS);

/** page の、別のホスト名（`localhost`）の frame。 */
const crossSiteFrames = (page: Page): Frame[] => page.frames().filter((frame) => frame.url().startsWith(`${crossSiteOrigin}/`));

/** Context の、失敗したリクエストを `<URL> <errorText>` で集める。 */
function collectFailedRequests(context: BrowserContext): string[] {
  const failed: string[] = [];
  context.on('requestfailed', (request) => {
    failed.push(`${request.url()} ${request.failure()?.errorText ?? ''}`);
  });
  return failed;
}

// Context の関数の差し替え（`vi.spyOn`）は、テストごとに元に戻す。
afterEach(() => {
  vi.restoreAllMocks();
});

describe('C18i: the fixture makes a cross-site iframe that runs in a separate process (OOPIF) under --site-per-process', () => {
  it('the localhost iframe of the 127.0.0.1 page is an OOPIF: an iframe CDP target exists and Playwright gives it its own CDP session', async () => {
    await withGuardedPassivePage(headlessFactory, viewport, async (page, context, ledger) => {
      await page.goto(`${server.origin}${crossSiteFramePath(NAVIGATION_TARGET_PAGE)}`, { waitUntil: 'load' });
      await expect.poll(() => crossSiteFrames(page).length).toBe(1);
      const [frame] = crossSiteFrames(page);

      expect(await oopifTargetUrls(browser)).toContain(`${crossSiteOrigin}${NAVIGATION_TARGET_PAGE}`);
      // Playwright は、別のプロセスの iframe にだけ、専用の CDP の session を作れる（同じプロセスの iframe では例外を投げる）。
      const frameSession = await context.newCDPSession(frame!);
      await frameSession.detach();
      expect(await frame!.title()).toBe(NAVIGATION_TARGET_HEADING);
      expect(ledger.snapshot().invariantViolations).toEqual([]);
    });
  });
});

describe('C18i: a server redirect to an external scheme, started by the OOPIF itself, is stopped before it is followed, and recorded', () => {
  it.each(MODE_CASES)('Passive (%s): the OOPIF navigates itself to the redirect to %s; it is stopped and recorded without a violation', async (mode, key) => {
    const window = openServerWindow(server);
    let failed: string[] = [];
    await withGuardedPassivePage(factories[mode], viewport, async (page, context, ledger) => {
      const url = `${server.origin}${crossSiteFramePath(selfNavigatingFramePath(key))}`;
      await page.goto(url, { waitUntil: 'load' });
      await expect.poll(() => ledger.snapshot().externalSchemeNavigations.length).toBeGreaterThan(0);
      await wait(QUIET_PERIOD_MS);

      const snapshot = ledger.snapshot();
      expect(snapshot.externalSchemeNavigations).toEqual([stoppedRedirectRecord(key, 'SUB')]);
      expect(snapshot.invariantViolations).toEqual([]);
      expect(isPassiveRequestGuardClosed(context)).toBe(false);
      expect(page.url()).toBe(url);
      // 元のリクエストは、Guard が止めた失敗（`net::ERR_BLOCKED_BY_CLIENT`）になる（止めなければ `net::ERR_ABORTED`）。
      expect(failed).toEqual([`${crossSiteOrigin}${externalSchemeRedirectPath(key)} net::ERR_BLOCKED_BY_CLIENT`]);
      // 移動は、別のプロセスの iframe（OOPIF）の中で始まった。
      expect((await oopifTargetUrls(browser)).some((target) => target.startsWith(`${crossSiteOrigin}/`))).toBe(true);
    }, {
      prepare: (context) => {
        failed = collectFailedRequests(context);
      },
    });
    expect(window.requestLines()).toEqual([
      `GET ${CROSS_SITE_FRAME_PAGE}`,
      `GET ${SELF_NAVIGATING_FRAME_PAGE}`,
      `GET ${EXTERNAL_SCHEME_REDIRECT_PATH}`,
    ]);
    expect(window.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
  });

  it.each(MODE_CASES)('Passive (%s): a nested OOPIF (127.0.0.1 in localhost in 127.0.0.1) navigates itself to the redirect to %s; it is stopped and recorded', async (mode, key) => {
    const window = openServerWindow(server);
    let failed: string[] = [];
    await withGuardedPassivePage(factories[mode], viewport, async (page, context, ledger) => {
      await page.goto(`${server.origin}${crossSiteFramePath(crossSiteFramePath(selfNavigatingFramePath(key)))}`, { waitUntil: 'load' });
      await expect.poll(() => ledger.snapshot().externalSchemeNavigations.length).toBeGreaterThan(0);
      await wait(QUIET_PERIOD_MS);

      const snapshot = ledger.snapshot();
      expect(snapshot.externalSchemeNavigations).toEqual([stoppedRedirectRecord(key, 'SUB')]);
      expect(snapshot.invariantViolations).toEqual([]);
      expect(isPassiveRequestGuardClosed(context)).toBe(false);
      expect(failed).toEqual([`${server.origin}${externalSchemeRedirectPath(key)} net::ERR_BLOCKED_BY_CLIENT`]);
      // 入れ子の iframe も、別のプロセスの iframe（OOPIF）である（localhost の OOPIF と、その中の 127.0.0.1 の OOPIF）。
      const targets = await oopifTargetUrls(browser);
      expect(targets.some((target) => target.startsWith(`${crossSiteOrigin}/`))).toBe(true);
      expect(targets.some((target) => target.startsWith(`${server.origin}/`))).toBe(true);
    }, {
      prepare: (context) => {
        failed = collectFailedRequests(context);
      },
    });
    expect(window.requestLines()).toEqual([
      `GET ${CROSS_SITE_FRAME_PAGE}`,
      `GET ${CROSS_SITE_FRAME_PAGE}`,
      `GET ${SELF_NAVIGATING_FRAME_PAGE}`,
      `GET ${EXTERNAL_SCHEME_REDIRECT_PATH}`,
    ]);
    expect(window.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
  });

  it('Passive: a slow same-origin redirect (1.5 s) inside the OOPIF is not a false violation, and the OOPIF reaches its target', async () => {
    const window = openServerWindow(server);
    await withGuardedPassivePage(headlessFactory, viewport, async (page, context, ledger) => {
      await page.goto(`${server.origin}${crossSiteFramePath(selfNavigatingFramePath('slow'))}`, { waitUntil: 'load' });
      await expect.poll(
        () => crossSiteFrames(page).map((frame) => frame.url()),
        { timeout: 10_000 },
      ).toEqual([`${crossSiteOrigin}${NAVIGATION_TARGET_PAGE}`]);
      await wait(QUIET_PERIOD_MS);

      expect(ledger.snapshot().invariantViolations).toEqual([]);
      expect(ledger.snapshot().externalSchemeNavigations).toEqual([]);
      expect(isPassiveRequestGuardClosed(context)).toBe(false);
    });
    expect(window.requestLines()).toEqual([
      `GET ${CROSS_SITE_FRAME_PAGE}`,
      `GET ${SELF_NAVIGATING_FRAME_PAGE}`,
      `GET ${SLOW_REDIRECT_PATH}`,
      `GET ${NAVIGATION_TARGET_PAGE}`,
    ]);
  });
});

describe('C18i: after the Interaction freeze, a navigation started by the OOPIF stops before the server', () => {
  it('Interaction (after the freeze): the OOPIF navigating itself is blocked as INTERACTION_FROZEN, without a violation', async () => {
    const session = await headlessFactory.createInteractionSession(viewport);
    try {
      await session.page.goto(`${server.origin}${crossSiteFramePath(selfNavigatingFramePath())}`, { waitUntil: 'load' });
      await expect.poll(() => crossSiteFrames(session.page).length).toBe(1);
      const [frame] = crossSiteFrames(session.page);
      await session.activateInteractionFreeze();
      const window = openServerWindow(server);
      const target = externalSchemeRedirectPath('custom');

      await frame!.evaluate((href) => {
        location.href = href;
      }, target);
      await expect.poll(() => session.ledger.snapshot().blockedInteractionNavigations).toContainEqual({
        method: 'GET',
        url: `${crossSiteOrigin}${target}`,
        reason: 'INTERACTION_FROZEN',
      });
      await wait(QUIET_PERIOD_MS);

      expect(session.ledger.snapshot().invariantViolations).toEqual([]);
      expect(session.ledger.snapshot().externalSchemeNavigations).toEqual([]);
      expect(session.isClosed()).toBe(false);
      expect(window.requestLines()).toEqual([]);
    } finally {
      if (!session.isClosed()) await session.close();
    }
  });
});

describe('C18i: the existing judgments still stop the OOPIF (navigation outside the allowed Origin, non-read methods)', () => {
  it('Passive: POST, sendBeacon, PUT and DELETE sent by the OOPIF on load are blocked and never reach the server', async () => {
    const window = openServerWindow(server);
    await withGuardedPassivePage(headlessFactory, viewport, async (page, _context, ledger) => {
      await page.goto(`${server.origin}${crossSiteFramePath('/page-auditor-non-read-requests.html')}`, { waitUntil: 'load' });
      await expect.poll(() => [...new Set(ledger.snapshot().blockedRequests.map((entry) => entry.method))].sort())
        .toEqual(['DELETE', 'POST', 'PUT']);
      await wait(QUIET_PERIOD_MS);

      const snapshot = ledger.snapshot();
      expect(snapshot.blockedRequests.every((entry) => entry.reason === 'NON_READ_METHOD')).toBe(true);
      expect(snapshot.blockedRequests.every((entry) => entry.url === `${crossSiteOrigin}/__mutation`)).toBe(true);
      expect(snapshot.invariantViolations).toEqual([]);
    });
    expect(window.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
  });

  it('Passive: a POST form submission (a navigation) by the OOPIF is blocked and never reaches the server', async () => {
    const window = openServerWindow(server);
    await withGuardedPassivePage(headlessFactory, viewport, async (page, _context, ledger) => {
      await page.goto(`${server.origin}${crossSiteFramePath(selfNavigatingFramePath('post-form'))}`, { waitUntil: 'load' });
      await expect.poll(() => ledger.snapshot().blockedRequests).toContainEqual({
        method: 'POST',
        url: `${crossSiteOrigin}/__mutation`,
        reason: 'NON_READ_METHOD',
      });
      await wait(QUIET_PERIOD_MS);

      expect(ledger.snapshot().invariantViolations).toEqual([]);
    });
    expect(window.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
    expect(window.count(null, '/__mutation')).toBe(0);
  });

  it('Passive: the OOPIF navigating the top frame outside the allowed Origin (by a real click) is blocked and never reaches the server', async () => {
    const window = openServerWindow(server);
    await withGuardedPassivePage(headlessFactory, viewport, async (page, _context, ledger) => {
      const url = `${server.origin}${crossSiteFramePath(selfNavigatingFramePath())}`;
      await page.goto(url, { waitUntil: 'load' });
      await expect.poll(() => crossSiteFrames(page).length).toBe(1);
      const [frame] = crossSiteFrames(page);

      await frame!.getByRole('button', { name: 'Navigate top' }).click();
      await expect.poll(() => ledger.snapshot().blockedNavigations).toContainEqual({
        method: 'GET',
        url: `${crossSiteOrigin}${NAVIGATION_TARGET_PAGE}`,
        reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION',
      });
      await wait(QUIET_PERIOD_MS);

      // 止めた main frame の移動の後は、Chromium のエラーのページになる（既存の扱い）。移動の先には、たどり着かない。
      expect(page.url()).not.toBe(`${crossSiteOrigin}${NAVIGATION_TARGET_PAGE}`);
      expect(ledger.snapshot().invariantViolations).toEqual([]);
    });
    expect(window.count('GET', NAVIGATION_TARGET_PAGE)).toBe(0);
    expect(window.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
  });
});

/**
 * OOPIF の session の命令（親の session の `Target.sendMessageToTarget`）に、偽の失敗を注入する page の session（C18i の fail-closed）。
 * - `SEND`: OOPIF の session に命令を送れない（`Target.sendMessageToTarget` が失敗する）。
 * - `FETCH_ENABLE`: OOPIF の session の `Fetch.enable` が、ブラウザから失敗の応答を受ける（命令の名前を、ない名前に変えて送る）。
 */
function sessionFailingOopifAttach(real: CDPSession, failure: 'SEND' | 'FETCH_ENABLE'): CDPSession {
  return new Proxy(real, {
    get(target, property, receiver): unknown {
      if (property === 'send') {
        return async (method: string, params?: { readonly sessionId?: string; readonly message?: string }): Promise<unknown> => {
          const send = target.send.bind(target) as (name: string, parameters?: object) => Promise<unknown>;
          if (method !== 'Target.sendMessageToTarget' || typeof params?.message !== 'string') {
            return send(method, params);
          }
          if (failure === 'SEND') {
            throw new Error('injected: the OOPIF session cannot receive commands');
          }
          const command = JSON.parse(params.message) as { readonly method: string };
          if (command.method !== 'Fetch.enable') {
            return send(method, params);
          }
          return send(method, { ...params, message: JSON.stringify({ ...command, method: 'Fetch.enableInjectedFailure' }) });
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

describe('C18i fail-closed: when the Guard cannot attach its interception to an OOPIF, it records a violation and closes the Context', () => {
  it.each(['SEND', 'FETCH_ENABLE'] as const)('%s failure: OOPIF_GUARD_ATTACH_FAILED is recorded, the Context closes, and the OOPIF never navigates', async (failure) => {
    const window = openServerWindow(server);
    await withGuardedPassivePage(headlessFactory, viewport, async (page, context, ledger) => {
      await page.goto(`${server.origin}${crossSiteFramePath(selfNavigatingFramePath('custom'))}`).catch(() => undefined);
      await expect.poll(() => isPassiveRequestGuardClosed(context)).toBe(true);

      expect(ledger.snapshot().invariantViolations.map(({ code }) => code)).toContain('OOPIF_GUARD_ATTACH_FAILED');
      expect(ledger.snapshot().externalSchemeNavigations).toEqual([]);
    }, {
      prepare: (context) => {
        const original = context.newCDPSession.bind(context);
        vi.spyOn(context, 'newCDPSession').mockImplementation(async (target) => sessionFailingOopifAttach(await original(target), failure));
      },
    });
    // OOPIF は、横取りを付けられなかったので、進めない（自分の移動を始めない）。
    expect(window.count(null, EXTERNAL_SCHEME_REDIRECT_PATH)).toBe(0);
    expect(window.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
  });
});

/**
 * page の session が受ける事象の値を、Guard の listener に届く前に `rewrite` で書き換える page の session（RC18c の M3）。
 * `rewrite` は、事象の名前と値を受け、Guard に渡す値を返す（書き換えない事象は、受けた値をそのまま返す）。
 * `off` には、`on` で渡されたのと同じ listener を渡せば、書き換えの listener が外れる。
 */
function sessionRewritingEvents(real: CDPSession, rewrite: (event: string, params: unknown) => unknown): CDPSession {
  type Listener = (params: unknown) => void;
  const wrapped = new Map<Listener, Listener>();
  const on = (event: string, listener: Listener): void => {
    const rewriting: Listener = (params) => listener(rewrite(event, params));
    wrapped.set(listener, rewriting);
    (real.on as (name: string, handler: Listener) => unknown).call(real, event, rewriting);
  };
  const off = (event: string, listener: Listener): void => {
    (real.off as (name: string, handler: Listener) => unknown).call(real, event, wrapped.get(listener) ?? listener);
  };
  return new Proxy(real, {
    get(target, property, receiver): unknown {
      if (property === 'on') {
        return (event: string, listener: Listener) => {
          on(event, listener);
          return receiver;
        };
      }
      if (property === 'off') {
        return (event: string, listener: Listener) => {
          off(event, listener);
          return receiver;
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** 事象の値（オブジェクト）の、`key` の値を `value` に置き換えた写し。 */
const withProperty = (params: unknown, key: string, value: unknown): unknown => ({ ...(params as object), [key]: value });

/**
 * RC18c の M3: C18i の fail-closed の分岐のうち、実際の Chromium では起きない3つの分岐を、page の session の事象の値を書き換えて
 * 起こす（Guard のコードは変えない）。
 * - iframe でない target が付いた（`Target.attachedToTarget` の `targetInfo.type` を iframe 以外にする）。
 * - 付いた target が止まっていない（`Target.attachedToTarget` の `waitingForDebugger` を偽にする）。
 * - OOPIF の session の応答が壊れている（最初の `Target.receivedMessageFromTarget` の `message` を、文字列でない値にする）。
 */
const INJECTED_OOPIF_EVENT_FAILURES = [
  [
    'a non-iframe target',
    'OOPIF_GUARD_ATTACH_FAILED',
    'An auto-attached target was not an iframe',
    (): ((event: string, params: unknown) => unknown) => (event, params) => (
      event === 'Target.attachedToTarget'
        ? withProperty(params, 'targetInfo', { ...(params as { readonly targetInfo?: object }).targetInfo, type: 'worker' })
        : params
    ),
  ],
  [
    'a target that is not waiting for the debugger',
    'OOPIF_GUARD_ATTACH_FAILED',
    'OOPIF target was attached after it had started running',
    (): ((event: string, params: unknown) => unknown) => (event, params) => (
      event === 'Target.attachedToTarget' ? withProperty(params, 'waitingForDebugger', false) : params
    ),
  ],
  [
    'a malformed message from the OOPIF session',
    'OOPIF_GUARD_PROTOCOL_FAILED',
    'OOPIF interception session message is not a string',
    (): ((event: string, params: unknown) => unknown) => {
      let rewritten = false;
      return (event, params) => {
        if (event !== 'Target.receivedMessageFromTarget' || rewritten) {
          return params;
        }
        rewritten = true;
        return withProperty(params, 'message', 42);
      };
    },
  ],
] as const;

describe('C18i fail-closed (RC18c M3): injected OOPIF event failures record a violation, close the Context, and the OOPIF never navigates', () => {
  it.each(INJECTED_OOPIF_EVENT_FAILURES)('%s: %s is recorded, the Context closes, and the OOPIF never navigates', async (
    _name,
    code,
    message,
    createRewrite,
  ) => {
    const window = openServerWindow(server);
    await withGuardedPassivePage(headlessFactory, viewport, async (page, context, ledger) => {
      await page.goto(`${server.origin}${crossSiteFramePath(selfNavigatingFramePath('custom'))}`).catch(() => undefined);
      await expect.poll(() => isPassiveRequestGuardClosed(context)).toBe(true);

      expect(ledger.snapshot().invariantViolations).toContainEqual({ code, message });
      expect(ledger.snapshot().externalSchemeNavigations).toEqual([]);
    }, {
      prepare: (context) => {
        const original = context.newCDPSession.bind(context);
        const rewrite = createRewrite();
        vi.spyOn(context, 'newCDPSession').mockImplementation(async (target) => sessionRewritingEvents(await original(target), rewrite));
      },
    });
    // OOPIF は、横取りを付けられなかったので、進めない（自分の移動を始めない）。
    expect(window.count(null, EXTERNAL_SCHEME_REDIRECT_PATH)).toBe(0);
    expect(window.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
  });
});

describe('C18i: the OOPIF sessions are bounded, and a closed OOPIF releases its session', () => {
  it(`more than the limit of simultaneous OOPIFs (${OOPIF_OVER_LIMIT_COUNT}) is OOPIF_GUARD_ATTACH_FAILED and closes the Context`, async () => {
    await withGuardedPassivePage(headlessFactory, viewport, async (page, context, ledger) => {
      await page.goto(`${server.origin}${NAVIGATION_TARGET_PAGE}`, { waitUntil: 'load' });
      // 1件ずつ、読み込みを待ってから加える（同時に読み込むと、page の session のリダイレクトの対応付けの上限 64 に先に達するため）。
      // 上限を超えた OOPIF は進めないので、その読み込みは終わらず、Guard が Context を閉じると、evaluate が失敗する。
      for (let index = 0; index < OOPIF_OVER_LIMIT_COUNT; index += 1) {
        const loaded = await page.evaluate(({ origin, frameIndex }) => new Promise<void>((resolve) => {
          const frame = document.createElement('iframe');
          frame.src = `${origin}/navigation-target.html?frame=${frameIndex}`;
          frame.addEventListener('load', () => resolve(), { once: true });
          document.body.append(frame);
        }), { origin: crossSiteOrigin, frameIndex: index }).then(() => true, () => false);
        if (!loaded) {
          break;
        }
      }
      await expect.poll(() => isPassiveRequestGuardClosed(context), { timeout: 30_000 }).toBe(true);

      expect(ledger.snapshot().invariantViolations).toContainEqual({
        code: 'OOPIF_GUARD_ATTACH_FAILED',
        message: 'OOPIF guard session limit reached',
      });
    });
  }, MANY_OOPIF_TEST_TIMEOUT_MS);

  it(`adding and removing OOPIFs one at a time (${OOPIF_CHURN_COUNT} times) does not reach the limit and is not a violation`, async () => {
    await withGuardedPassivePage(headlessFactory, viewport, async (page, context, ledger) => {
      await page.goto(`${server.origin}${NAVIGATION_TARGET_PAGE}`, { waitUntil: 'load' });
      for (let index = 0; index < OOPIF_CHURN_COUNT; index += 1) {
        await page.evaluate(({ origin, frameIndex }) => new Promise<void>((resolve) => {
          const frame = document.createElement('iframe');
          frame.src = `${origin}/navigation-target.html?frame=${frameIndex}`;
          frame.addEventListener('load', () => {
            frame.remove();
            resolve();
          }, { once: true });
          document.body.append(frame);
        }), { origin: crossSiteOrigin, frameIndex: index });
      }
      await wait(QUIET_PERIOD_MS);

      expect(ledger.snapshot().invariantViolations).toEqual([]);
      expect(isPassiveRequestGuardClosed(context)).toBe(false);
    });
  }, MANY_OOPIF_TEST_TIMEOUT_MS);
});
