import type { Browser, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { Viewport } from '../../src/config/types.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import {
  BROWSER_DEFAULT_FAVICON_PATH,
  isCliChromiumSelected,
  launchCliChromium,
  launchHeadlessChromium,
  oopifTargetUrls,
  SITE_PER_PROCESS_ARGS,
  useHeadlessChromium,
  withoutBrowserFaviconRequestLines,
} from '../helpers/chromium.js';
import {
  collectRedirectedNavigations,
  CROSS_SITE_FRAME_PAGE,
  crossSiteFramePath,
  crossSiteOriginOf,
  EXTERNAL_SCHEME_BUTTON_NAME,
  EXTERNAL_SCHEME_KEYS,
  EXTERNAL_SCHEME_REDIRECT_FRAME_PAGE,
  EXTERNAL_SCHEME_REDIRECT_PATH,
  EXTERNAL_SCHEME_ROUTES,
  EXTERNAL_SCHEME_TARGETS,
  externalSchemeFixturePath,
  externalSchemeFixturePathname,
  externalSchemeRedirectFramePath,
  externalSchemeRedirectPath,
  externalSchemeRequestUrl,
  NAVIGATION_TARGET_HEADING,
  NAVIGATION_TARGET_PAGE,
  SELF_NAVIGATING_FRAME_PAGE,
  selfNavigatingFramePath,
  SLOW_REDIRECT_PATH,
} from '../helpers/external-scheme-fixture.js';
import {
  attemptPostNavigationAndFetch,
  closeUnguardedUnloadBeaconPage,
  leaveUnguardedUnloadBeaconPage,
  openServerWindow,
  POPUP_SELF_CLOSE_BEACON_PAGE,
  POPUP_SELF_CLOSE_SAME_TASK_BUTTON,
  openUnguardedWorkerWebSocketPage,
  readServiceWorkerBypassState,
  readSharedWorkerFixtureState,
  SERVICE_WORKER_BYPASS_FRAMES,
  SERVICE_WORKER_BYPASS_WAYS,
  SERVICE_WORKER_BYPASS_WORKER_PATH,
  serviceWorkerBypassPath,
  SHARED_WORKER_POST_KINDS,
  sharedWorkerPostsPath,
  UNAVAILABLE_WORKER_WEBSOCKET_KINDS,
  pageUrlIs,
  readFetchLaterState,
  UNLOAD_BEACON_FETCH_LATER_PAGE,
  UNLOAD_BEACON_PAGE,
  UNLOAD_BEACON_TARGET_PATH,
  unloadBeaconSelfNavigationPath,
  withGuardedPassivePage,
  withUnguardedPage,
  WORKER_WEBSOCKET_BUTTON,
  WORKER_WEBSOCKET_KINDS,
  WORKER_WEBSOCKET_PAGE,
  WORKER_WEBSOCKET_PASSIVE_PAGE,
  workerWebSocketScriptRequestLines,
  type ServerWindow,
} from '../helpers/gate-harness.js';
import { createTestConfig } from '../helpers/test-config.js';

/**
 * Task 18（T18a）で加えた fixture が、期待どおりのリクエストを試みることを確かめる。
 *
 * - 遮断を確かめるのは、Safety の Gate（T18b）である。ここでは、Guard のない対照の Context で、fixture のリクエストが
 *   実際にサーバに届くことを確かめる。遮断の確認が空振りしない（fixture がそもそも何も送らない、ということがない）ためである。
 * - 移動とポップアップの先のページは、Passive の Context で直接開けば GET が記録されることも確かめる（DEF-010 の対照）。
 * - TS-f（設計書 `2026-10-24-beaksight-test-suite-tiers-design.md` 3.6・3.7.4）: Guard のない対照は、このファイルの 1 か所にまとめる。
 *   `safety-gates.test.ts` の「control: without the Guard」と、`passive-session-close`・`guard-unload-requests`・`auditor-gates`・
 *   `guard-worker-websocket` の同じ対照を、ここに寄せた（GATE-S10 の対照は CLI の Run なので `safety-gates.test.ts` に残す）。
 * - TS-f: Guard のない対照は、CLI の回（`BEAKSIGHT_TEST_DEFAULT_CHROMIUM=cli`）では流さない（`describeControl`・`itControl`。DEF-126 の再発を防ぐ）。
 *   CLI の Chromium での対照は、前に CLI の Chromium でも流していた場面（DEF-042・DEF-040・DEF-044・DEF-049）だけ、既定の回で、
 *   このファイルの中の `describe.each` で両方の Chromium を流して確かめる。
 */

const viewport: Viewport = { width: 800, height: 600 };
let browser: Browser;
let server: FixtureServer;
/** テストごとに起動する fixture のサーバの、起動の時点からの記録。 */
let serverWindow: ServerWindow;

useHeadlessChromium((launched) => {
  browser = launched;
});

beforeEach(async () => {
  server = await startFixtureServer();
  serverWindow = openServerWindow(server);
});

afterEach(async () => {
  await server.close();
});

/** Guard を取り付けない、対照の Context の page を開いて `run` に渡し、終わったら（失敗しても）Context を閉じる。 */
const withControlPage = (run: (page: Page) => Promise<void>): Promise<void> => withUnguardedPage(browser, viewport, run);

/**
 * TS-f（設計書 3.6）: Guard のない対照の describe と it。CLI の回（`BEAKSIGHT_TEST_DEFAULT_CHROMIUM=cli`）では飛ばす。対照は、Guard の判定を
 * 確かめるものではなく、fixture が要求を出すことの確かめなので、CLI の回で新しく確かめるものとしない（DEF-126 の再発を防ぐ）。
 * 両方の Chromium を `describe.each` で流す対照も、CLI の回では同じ CLI の Chromium を 2 回流すだけなので、同じく飛ばす（7c）。
 */
const describeControl = describe.skipIf(isCliChromiumSelected());
const itControl = it.skipIf(isCliChromiumSelected());

/**
 * TS-f: 前に CLI の Chromium でも流していた対照（`guard-unload-requests`・`guard-worker-websocket` の `describe.each`）を、ここでも両方の
 * Chromium で流すための起動の仕方。
 */
const CONTROL_CHROMIUM_LAUNCHES = [
  { name: 'the headless shell', launch: (): Promise<Browser> => launchHeadlessChromium() },
  { name: 'the CLI Chromium', launch: (): Promise<Browser> => launchCliChromium() },
] as const;

/**
 * 対照の確認で使う、click を数えて既定の動作を止めるスクリプト（GATE-S03。TS-f で `safety-gates.test.ts` から移した）。Guard のない
 * Context で `mailto:` や `tel:` を実際に開くと、端末の外部のアプリが起動しうるので、対照の確認では既定の動作を止める。
 */
const COUNT_CLICKS_PREVENTING_DEFAULT_SCRIPT = `globalThis.__gateClicks = 0;
document.addEventListener('click', (event) => { globalThis.__gateClicks += 1; event.preventDefault(); }, { capture: true });`;

describe('Task 18 fixtures: targets of blocked navigation and popups (DEF-010 control)', () => {
  it.each([
    ['/popup-target.html', 'Fixture Popup Target'],
    [NAVIGATION_TARGET_PAGE, NAVIGATION_TARGET_HEADING],
  ] as const)('records a GET for %s when a guarded Passive Context opens it directly', async (path, title) => {
    const factory = new BrowserContextFactory(browser, createTestConfig(server.origin), () => new SafetyLedger());
    await withGuardedPassivePage(factory, viewport, async (page, _context, ledger) => {
      const window = openServerWindow(server);

      const response = await page.goto(`${server.origin}${path}`);

      expect(response?.status()).toBe(200);
      expect(await page.title()).toBe(title);
      expect(window.requestLines()).toEqual([`GET ${path}`]);
      expect(ledger.snapshot().invariantViolations).toEqual([]);
    });
  });

  itControl('opens /popup-target.html from the popup button in an unguarded control Context', async () => {
    await withControlPage(async (page) => {
      await page.goto(`${server.origin}/popup-button.html`);

      const popupEvent = page.waitForEvent('popup');
      await page.getByRole('button', { name: 'Open popup' }).click();
      const popup = await popupEvent;
      await popup.waitForURL(`${server.origin}/popup-target.html`);

      expect(await popup.title()).toBe('Fixture Popup Target');
      expect(serverWindow.count('GET', '/popup-target.html')).toBeGreaterThan(0);
    });
  });

  itControl('sends POST /__mutation from the form written into the popup in an unguarded control Context (DEF-036)', async () => {
    await withControlPage(async (page) => {
      await page.goto(`${server.origin}/popup-form-post.html`);
      await page.waitForLoadState('load');
      expect(server.getCounters().post).toBe(0);

      const popupEvent = page.waitForEvent('popup');
      await page.getByRole('button', { name: 'Open popup form' }).click();
      await popupEvent;

      await expect.poll(() => serverWindow.count('POST', '/__mutation')).toBe(1);
      expect(server.getCounters()).toMatchObject({ post: 1, put: 0, patch: 0, delete: 0 });
    });
  });

  itControl('navigates to /navigation-target.html from the navigation button in an unguarded control Context', async () => {
    await withControlPage(async (page) => {
      await page.goto(`${server.origin}/navigation-button.html`);

      await page.getByRole('button', { name: 'Attempt navigation' }).click();
      await page.waitForURL(`${server.origin}${NAVIGATION_TARGET_PAGE}`);

      expect(await page.title()).toBe(NAVIGATION_TARGET_HEADING);
      expect(serverWindow.count('GET', NAVIGATION_TARGET_PAGE)).toBeGreaterThan(0);
    });
  });
});

describeControl('DEF-038 fixture: a page that sends POST requests only while it is being left', () => {
  it('sends nothing while it loads, and POST /__mutation when the page is closed, in an unguarded control Context', async () => {
    const window = await closeUnguardedUnloadBeaconPage(browser, server, viewport);

    expect(serverWindow.requestLines().filter((line) => line.startsWith('GET '))).toContain(`GET ${UNLOAD_BEACON_PAGE}`);
    expect(window.count('POST', UNLOAD_BEACON_TARGET_PATH)).toBeGreaterThan(0);
    expect(window.nonReadCounters()).toMatchObject({ put: 0, patch: 0, delete: 0 });
  });
});

// DEF-042 の対照: ページ自身が別の文書へ移る fixture は、Guard のない Context では、ページを離れるときの POST（`pagehide` の beacon と
// keepalive の `fetch`、`fetchLater()` の予約）をサーバに届ける。Gate と Guard のテストの「届かなかった」の確認が空振りしないためである。
// TS-f: `guard-unload-requests.test.ts` の両方の Chromium の対照をここにまとめたので、両方の Chromium で流す。
describeControl.each(CONTROL_CHROMIUM_LAUNCHES)('DEF-042 fixtures: pages that send POST requests only while they leave by themselves, with $name', ({ launch }) => {
  let leavingBrowser: Browser;

  beforeAll(async () => {
    leavingBrowser = await launch();
  });

  afterAll(async () => {
    await leavingBrowser?.close();
  });

  it('delivers POST /__mutation when the page leaves by itself to the same site (pagehide beacon, keepalive fetch), in an unguarded control Context', async () => {
    const window = await leaveUnguardedUnloadBeaconPage(
      leavingBrowser,
      server,
      viewport,
      unloadBeaconSelfNavigationPath('same-site'),
      pageUrlIs(`${server.origin}${NAVIGATION_TARGET_PAGE}`),
    );

    expect(window.count('POST', UNLOAD_BEACON_TARGET_PATH)).toBeGreaterThan(0);
    expect(window.count('GET', NAVIGATION_TARGET_PAGE)).toBe(1);
    expect(window.nonReadCounters()).toMatchObject({ put: 0, patch: 0, delete: 0 });
  });

  it('delivers POST /__mutation to the allowed Origin when the page leaves by itself to the other host name (cross-site), in an unguarded control Context', async () => {
    const crossSiteTarget = `${crossSiteOriginOf(server.origin)}${NAVIGATION_TARGET_PAGE}`;
    const window = await leaveUnguardedUnloadBeaconPage(
      leavingBrowser,
      server,
      viewport,
      unloadBeaconSelfNavigationPath('cross-site'),
      pageUrlIs(crossSiteTarget),
    );

    expect(window.count('POST', UNLOAD_BEACON_TARGET_PATH)).toBeGreaterThan(0);
    expect(window.count('GET', NAVIGATION_TARGET_PAGE)).toBe(1);
  });

  it('schedules a fetchLater() POST and delivers POST /__mutation when the page leaves by itself, in an unguarded control Context', async () => {
    const window = await leaveUnguardedUnloadBeaconPage(
      leavingBrowser,
      server,
      viewport,
      UNLOAD_BEACON_FETCH_LATER_PAGE,
      pageUrlIs(`${server.origin}${NAVIGATION_TARGET_PAGE}`),
      { afterDomContentLoaded: async (page) => expect(await readFetchLaterState(page)).toBe('scheduled') },
    );

    expect(window.count('POST', UNLOAD_BEACON_TARGET_PATH)).toBeGreaterThan(0);
    expect(window.nonReadCounters()).toMatchObject({ put: 0, patch: 0, delete: 0 });
  });
});

describeControl('Task 18 fixtures: PATCH requests reach the server in an unguarded control Context', () => {
  it('sends PATCH /__mutation from the page script without any user action (Passive phase fixture)', async () => {
    await withControlPage(async (page) => {
      await page.goto(`${server.origin}/passive-patch-request.html`);

      await expect.poll(() => server.getCounters().patch).toBe(1);
      expect(serverWindow.count('PATCH', '/__mutation')).toBeGreaterThan(0);
      expect(server.getCounters()).toMatchObject({ post: 0, put: 0, delete: 0 });
    });
  });

  it('sends PATCH /__mutation only after the button is clicked (Interaction phase fixture)', async () => {
    await withControlPage(async (page) => {
      await page.goto(`${server.origin}/patch-request.html`);
      await page.waitForLoadState('load');
      expect(server.getCounters().patch).toBe(0);

      await page.getByRole('button', { name: 'Send PATCH' }).click();

      await expect.poll(() => server.getCounters().patch).toBe(1);
      expect(serverWindow.count('PATCH', '/__mutation')).toBeGreaterThan(0);
      expect(server.getCounters()).toMatchObject({ post: 0, put: 0, delete: 0 });
    });
  });
});

describeControl('Task 18 fixtures: DELETE requests reach the server in an unguarded control Context', () => {
  it('sends DELETE /__mutation once only after the button is clicked (Interaction phase fixture)', async () => {
    await withControlPage(async (page) => {
      await page.goto(`${server.origin}/delete-request.html`);
      await page.waitForLoadState('load');
      expect(server.getCounters().delete).toBe(0);

      await page.getByRole('button', { name: 'Send DELETE' }).click();

      await expect.poll(() => server.getCounters().delete).toBe(1);
      expect(serverWindow.count('DELETE', '/__mutation')).toBeGreaterThan(0);
      expect(server.getCounters()).toMatchObject({ post: 0, put: 0, patch: 0 });
    });
  });
});

// TS-f: GATE-S01・S02 の対照（`safety-gates.test.ts` の Passive と Interaction の対照、`auditor-gates.test.ts` の GATE-A08 の対照）を
// ここにまとめた。
describeControl('Task 18 fixtures: POST, PUT and DELETE requests reach the server in an unguarded control Context', () => {
  it('sends POST (fetch and sendBeacon), PUT and DELETE /__mutation from the page script without any user action (Passive phase fixture)', async () => {
    await withControlPage(async (page) => {
      await page.goto(`${server.origin}/page-auditor-non-read-requests.html`, { waitUntil: 'load' });

      // DELETE は、読み込みの後に遅れて送られるので、届くのを待つ。
      await expect.poll(() => {
        const counters = serverWindow.nonReadCounters();
        return counters.post > 0 && counters.put > 0 && counters.delete > 0;
      }).toBe(true);
      expect(serverWindow.count('POST', '/__mutation')).toBeGreaterThan(0);
      expect(serverWindow.count('PUT', '/__mutation')).toBeGreaterThan(0);
      expect(serverWindow.count('DELETE', '/__mutation')).toBeGreaterThan(0);
    });
  });

  it('sends POST /__mutation once only after the button is clicked (Interaction phase fixture)', async () => {
    await withControlPage(async (page) => {
      await page.goto(`${server.origin}/mutation-button.html`);
      await page.waitForLoadState('load');
      expect(server.getCounters().post).toBe(0);

      await page.getByRole('button', { name: 'Attempt mutation' }).click();

      await expect.poll(() => server.getCounters().post).toBe(1);
      expect(serverWindow.count('POST', '/__mutation')).toBeGreaterThan(0);
      expect(server.getCounters()).toMatchObject({ put: 0, patch: 0, delete: 0 });
    });
  });

  it('sends PUT /__mutation once only after the button is clicked (Interaction phase fixture)', async () => {
    await withControlPage(async (page) => {
      await page.goto(`${server.origin}/put-request.html`);
      await page.waitForLoadState('load');
      expect(server.getCounters().put).toBe(0);

      await page.getByRole('button', { name: 'Send PUT' }).click();

      await expect.poll(() => server.getCounters().put).toBe(1);
      expect(serverWindow.count('PUT', '/__mutation')).toBeGreaterThan(0);
      expect(server.getCounters()).toMatchObject({ post: 0, patch: 0, delete: 0 });
    });
  });
});

// TS-f: GATE-S03 の対照（`safety-gates.test.ts` から移した）。Guard のない Context では、`mailto:`・`tel:` のリンクの click が、リンクに届く
// （外部のアプリが起動しないよう、テストが既定の動作を止める）。
describeControl('GATE-S03 fixtures: mailto: and tel: links', () => {
  it.each([
    ['/mailto-link.html', 'Email fixture'],
    ['/tel-link.html', 'Call fixture'],
  ] as const)('the click on %s reaches the link in an unguarded control Context (the default action is prevented by the test)', async (path, name) => {
    await withControlPage(async (page) => {
      await page.addInitScript({ content: COUNT_CLICKS_PREVENTING_DEFAULT_SCRIPT });
      await page.goto(`${server.origin}${path}`, { waitUntil: 'load' });

      await page.getByRole('button', { name }).click();

      await expect.poll(() => page.evaluate(() => (globalThis as { __gateClicks?: number }).__gateClicks ?? 0)).toBe(1);
    });
  });
});

// TS-f: GATE-S04（DEF-039）の対照（`safety-gates.test.ts` から移した）。
describeControl('DEF-039 fixture: a popup that the page opens and closes by itself', () => {
  it('delivers POST /__mutation when the popup closes itself in the same task, in an unguarded control Context', async () => {
    await withControlPage(async (page) => {
      await page.goto(`${server.origin}${POPUP_SELF_CLOSE_BEACON_PAGE}`, { waitUntil: 'load' });

      await page.getByRole('button', { name: POPUP_SELF_CLOSE_SAME_TASK_BUTTON }).click();

      await expect.poll(() => serverWindow.count('POST', '/__mutation')).toBeGreaterThan(0);
    });
  });
});

// TS-f: GATE-S05 の対照（`safety-gates.test.ts` から移した）。
describeControl('Task 18 fixtures: an HTTP download', () => {
  it('delivers GET /__download from the download button in an unguarded control Context', async () => {
    await withControlPage(async (page) => {
      await page.goto(`${server.origin}/download-button.html`, { waitUntil: 'load' });

      await page.getByRole('button', { name: 'Attempt HTTP download' }).click();

      await expect.poll(() => serverWindow.count('GET', '/__download') > 0 && serverWindow.counters().download > 0).toBe(true);
    });
  });
});

// TS-f: GATE-S06（RP18-4）の対照（`safety-gates.test.ts` から移した）。Gate と同じ試み（`attemptPostNavigationAndFetch`）を、Guard のない Context で行う。
describeControl('RP18-4 fixtures: POST, navigation and fetch from the page script', () => {
  it('delivers the POST, the fetch and the navigation in an unguarded control Context', async () => {
    await withControlPage(async (page) => {
      await page.goto(`${server.origin}/navigation-button.html`, { waitUntil: 'load' });
      const window = openServerWindow(server);

      const attempts = await attemptPostNavigationAndFetch(page);

      expect(attempts).toEqual({ post: 'sent', fetch: 'sent' });
      await expect.poll(() => window.count('GET', NAVIGATION_TARGET_PAGE)).toBeGreaterThan(0);
      expect(window.count('POST', '/__mutation')).toBe(1);
      expect(window.count('GET', '/popup-target.html')).toBe(1);
    });
  });
});

// TS-f: GATE-S07 の対照（`safety-gates.test.ts` から移した）。
describeControl('Task 18 fixtures: WebSockets opened by a button', () => {
  it.each([
    ['/websocket.html', 'Open WebSocket'],
    [WORKER_WEBSOCKET_PAGE, WORKER_WEBSOCKET_BUTTON],
  ] as const)('%s: the click delivers the WebSocket upgrade in an unguarded control Context', async (path, name) => {
    await withControlPage(async (page) => {
      await page.goto(`${server.origin}${path}`, { waitUntil: 'load' });
      const window = openServerWindow(server);

      await page.getByRole('button', { name }).click();

      await expect.poll(() => window.counters().webSocketUpgrade).toBeGreaterThan(0);
    });
  });
});

// C18b（DEF-012、GATE-S03 の対照）: 外部スキームへの移動を試みる fixture は、Guard のない Context で、実際にその外部スキームの
// URL への移動のリクエストを出す（Playwright の `request` の事象に、その URL が来る）。Gate の「記録された」「届かなかった」の
// 確認が空振りしないためである。Chromium は headless だけで起動する（`useHeadlessChromium`。headless のバイナリには、外部の
// アプリへ URL を渡す仕組みがない）。宛先は、実在しないものだけである。
describeControl('C18b fixtures: pages that attempt a navigation to an external scheme', () => {
  const cases = EXTERNAL_SCHEME_ROUTES.flatMap((route) => EXTERNAL_SCHEME_KEYS.map((key) => [route, key] as const));

  it.each(cases)('%s to %s: the external scheme navigation request is made in an unguarded control Context', async (route, key) => {
    await withControlPage(async (page) => {
      const navigationRequests: string[] = [];
      page.on('request', (request) => {
        if (request.isNavigationRequest()) {
          navigationRequests.push(request.url());
        }
      });
      const expectedUrl = externalSchemeRequestUrl(route, key);

      await page.goto(`${server.origin}${externalSchemeFixturePath(route, key)}`, { waitUntil: 'load' });
      if (route === 'button-click') {
        // ボタンのページは、押されるまで移動を試みない（Interaction の段階の fixture）。
        expect(navigationRequests).not.toContain(expectedUrl);
        await page.getByRole('button', { name: EXTERNAL_SCHEME_BUTTON_NAME }).click();
      }

      await expect.poll(() => navigationRequests).toContain(expectedUrl);
      // 外部スキームの宛先は、fixture が決めた、実在しないものだけである。
      expect(navigationRequests.filter((url) => !url.startsWith(server.origin))).toEqual([expectedUrl]);
      // DEF-126: CLI の Chromium がブラウザ自身で取りに行く `/favicon.ico` は、fixture の要求ではないので除いて比べる。
      expect(withoutBrowserFaviconRequestLines(serverWindow.requestLines())).toEqual([
        `GET ${externalSchemeFixturePathname(route)}`,
      ]);
    });
  });
});

// C18g（RC18a の指摘1、GATE-S03 の対照）: サーバのリダイレクト（`302 Location: <外部スキーム>`）の fixture は、Guard のない
// Context では、リダイレクトをたどって、その外部スキームの URL への移動のリクエスト（`redirectedFrom` 付き）を出す。Gate の
// 「たどる前に止めた」の確認が空振りしないためである。Chromium は headless だけで起動する。宛先は、サーバの中の固定の一覧
// （実在しないもの）だけである。
describeControl('C18g fixtures: a server redirect to an external scheme', () => {
  it.each(EXTERNAL_SCHEME_KEYS)('iframe: the redirect to %s is followed to the external scheme URL in an unguarded control Context', async (key) => {
    await withControlPage(async (page) => {
      const redirected = collectRedirectedNavigations(page);

      await page.goto(`${server.origin}${externalSchemeRedirectFramePath(key)}`, { waitUntil: 'load' });

      await expect.poll(() => redirected).toEqual([
        `${EXTERNAL_SCHEME_TARGETS[key].url} <- ${server.origin}${externalSchemeRedirectPath(key)}`,
      ]);
      // DEF-126: ブラウザ自身の `/favicon.ico` は除いて比べる。
      expect(withoutBrowserFaviconRequestLines(serverWindow.requestLines())).toEqual([
        `GET ${EXTERNAL_SCHEME_REDIRECT_FRAME_PAGE}`,
        `GET ${EXTERNAL_SCHEME_REDIRECT_PATH}`,
      ]);
    });
  });

  it.each(EXTERNAL_SCHEME_KEYS)('main frame: the redirect to %s is followed to the external scheme URL in an unguarded control Context', async (key) => {
    await withControlPage(async (page) => {
      const redirected = collectRedirectedNavigations(page);

      // 外部スキームへの移動は、ブラウザの中で失敗する（headless のバイナリには、外部のアプリへ URL を渡す仕組みがない）。
      await page.goto(`${server.origin}${externalSchemeRedirectPath(key)}`).catch(() => undefined);

      await expect.poll(() => redirected).toEqual([
        `${EXTERNAL_SCHEME_TARGETS[key].url} <- ${server.origin}${externalSchemeRedirectPath(key)}`,
      ]);
      // DEF-126: ブラウザ自身の `/favicon.ico` は除いて比べる。
      expect(withoutBrowserFaviconRequestLines(serverWindow.requestLines())).toEqual([
        `GET ${EXTERNAL_SCHEME_REDIRECT_PATH}`,
      ]);
    });
  });
});

// C18i（RC18b の N1、GATE-S03 の対照）: 別のサイトの iframe の fixture（`cross-site-frame.html`）は、`--site-per-process` の
// Chromium では、別のプロセスの iframe（OOPIF）になる。その中のページ（`self-navigating-frame.html`）は、Guard のない Context では、
// 自分で移動してリダイレクトをたどり、POST を送り、一番上の frame を移動させる。Gate の「止めた」「届かなかった」の確認が空振りしない
// ためである。Chromium は headless だけで起動する（サイトの分離を無効にする引数は使わない）。宛先は、実在しないものだけである。
describeControl('C18i fixtures: a cross-site iframe that runs in a separate process (OOPIF) and navigates itself', () => {
  let isolatedBrowser: Browser | undefined;

  beforeAll(async () => {
    isolatedBrowser = await launchHeadlessChromium({ args: SITE_PER_PROCESS_ARGS });
  });

  afterAll(async () => {
    await isolatedBrowser?.close();
  });

  const crossSiteOrigin = (): string => crossSiteOriginOf(server.origin);
  const crossSiteFrameUrl = (framePath: string): string => `${server.origin}${crossSiteFramePath(framePath)}`;

  /** `--site-per-process` のブラウザで、Guard を取り付けない、対照の Context の page を開き、`run` に渡す。 */
  const withIsolatedControlPage = (run: (page: Page) => Promise<void>): Promise<void> =>
    withUnguardedPage(isolatedBrowser!, viewport, run);

  it.each(EXTERNAL_SCHEME_KEYS)('the OOPIF navigates itself and follows the redirect to %s in an unguarded control Context', async (key) => {
    await withIsolatedControlPage(async (page) => {
      const redirected = collectRedirectedNavigations(page);

      await page.goto(crossSiteFrameUrl(selfNavigatingFramePath(key)), { waitUntil: 'load' });

      await expect.poll(() => redirected).toEqual([
        `${EXTERNAL_SCHEME_TARGETS[key].url} <- ${crossSiteOrigin()}${externalSchemeRedirectPath(key)}`,
      ]);
      expect((await oopifTargetUrls(isolatedBrowser!)).some((url) => url.startsWith(`${crossSiteOrigin()}/`))).toBe(true);
      // DEF-126: ブラウザ自身の `/favicon.ico` は除いて比べる。
      expect(withoutBrowserFaviconRequestLines(serverWindow.requestLines())).toEqual([
        `GET ${CROSS_SITE_FRAME_PAGE}`,
        `GET ${SELF_NAVIGATING_FRAME_PAGE}`,
        `GET ${EXTERNAL_SCHEME_REDIRECT_PATH}`,
      ]);
    });
  });

  it('the OOPIF follows the slow redirect to /navigation-target.html in an unguarded control Context', async () => {
    await withIsolatedControlPage(async (page) => {
      await page.goto(crossSiteFrameUrl(selfNavigatingFramePath('slow')), { waitUntil: 'load' });

      await expect.poll(
        () => page.frames().map((frame) => frame.url()).filter((url) => url.startsWith(`${crossSiteOrigin()}/`)),
        { timeout: 10_000 },
      ).toEqual([`${crossSiteOrigin()}${NAVIGATION_TARGET_PAGE}`]);
      // DEF-126: ブラウザ自身の `/favicon.ico` は除いて比べる。
      expect(withoutBrowserFaviconRequestLines(serverWindow.requestLines())).toEqual([
        `GET ${CROSS_SITE_FRAME_PAGE}`,
        `GET ${SELF_NAVIGATING_FRAME_PAGE}`,
        `GET ${SLOW_REDIRECT_PATH}`,
        `GET ${NAVIGATION_TARGET_PAGE}`,
      ]);
    });
  });

  it('the OOPIF submits the POST form, and POST /__mutation reaches the server, in an unguarded control Context', async () => {
    await withIsolatedControlPage(async (page) => {
      await page.goto(crossSiteFrameUrl(selfNavigatingFramePath('post-form')), { waitUntil: 'load' });

      await expect.poll(() => server.getCounters().post).toBe(1);
      expect(serverWindow.count('POST', '/__mutation')).toBeGreaterThan(0);
    });
  });

  it('the OOPIF button navigates the top frame to its own Origin, which reaches the server, in an unguarded control Context', async () => {
    await withIsolatedControlPage(async (page) => {
      await page.goto(crossSiteFrameUrl(selfNavigatingFramePath()), { waitUntil: 'load' });
      const frame = page.frames().find((candidate) => candidate.url().startsWith(`${crossSiteOrigin()}/`));
      expect(frame).toBeDefined();

      await frame!.getByRole('button', { name: 'Navigate top' }).click();
      await page.waitForURL(`${crossSiteOrigin()}${NAVIGATION_TARGET_PAGE}`);

      expect(serverWindow.count('GET', NAVIGATION_TARGET_PAGE)).toBeGreaterThan(0);
    });
  });
});

/**
 * DEF-040（NP3）の fixture: 読み込みのときに Worker（blob、http の script、Shared、module、入れ子、srcdoc の iframe）の中で WebSocket を開く
 * ページと、WebSocket 以外の接続を行う対照のページが、Guard のない Context で実際にサーバへ届く（遮断の確認が空振りしない）。
 * TS-f: `safety-gates.test.ts` の GATE-S07 の対照と、`guard-worker-websocket.test.ts` の両方の Chromium の対照をここにまとめたので、両方の
 * Chromium で流す。
 */
describeControl.each(CONTROL_CHROMIUM_LAUNCHES)('DEF-040 fixtures: pages that open a WebSocket from inside a Worker while they load, and the connection controls, with $name', ({ launch }) => {
  let workerBrowser: Browser;

  beforeAll(async () => {
    workerBrowser = await launch();
  });

  afterAll(async () => {
    await workerBrowser?.close();
  });

  // DEF-044（NP5）: テストの Chromium は Shared Worker を無効にして起動するので、Shared の場面は、Shared Worker が作れず（fixture が
  // `unavailable` を残す）、Upgrade は届かない。
  it.each(WORKER_WEBSOCKET_KINDS)('delivers the WebSocket upgrade from inside the %s Worker, and the Worker script GETs, in an unguarded control Context, except the Shared Worker that cannot be created', async (kind) => {
    const window = await openUnguardedWorkerWebSocketPage(workerBrowser, server, viewport, kind);

    if (UNAVAILABLE_WORKER_WEBSOCKET_KINDS.includes(kind)) {
      expect(window.counters().webSocketUpgrade).toBe(0);
    } else {
      expect(window.counters().webSocketUpgrade).toBeGreaterThan(0);
    }
    expect(window.requestLines()).toEqual(expect.arrayContaining([
      `GET ${WORKER_WEBSOCKET_PASSIVE_PAGE}`,
      ...workerWebSocketScriptRequestLines(kind),
    ]));
  });

  it('delivers the GET connections (fetch, XHR, EventSource, img, script, Worker fetch) and the POST (beacon, ping) of the controls page, in an unguarded control Context', async () => {
    await withUnguardedPage(workerBrowser, viewport, async (page) => {
      await page.goto(`${server.origin}/worker-connect-policy-controls.html`, { waitUntil: 'load' });

      await expect.poll(() => serverWindow.count('POST', '/__mutation')).toBeGreaterThanOrEqual(2);
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset['workerFetch'])).toBe('done');
      for (const path of ['/external-script.js', '/short-content.html', '/robots.txt', '/sitemap.xml', '/unsized-image.svg', '/resource-item.css']) {
        expect(serverWindow.count('GET', path), path).toBeGreaterThan(0);
      }
      expect(await page.evaluate(() => ({ ...document.documentElement.dataset }))).toMatchObject({
        fetchGet: 'done',
        xhrGet: 'done',
        eventSource: 'done',
        image: 'done',
        script: 'done',
        dataFetch: 'ok',
        blobFetch: 'ok',
        workerFetch: 'done',
        beacon: 'queued',
        ping: 'clicked',
      });
      // TS-f（`guard-worker-websocket.test.ts` から寄せた）: ブラウザ自身の favicon の要求は、多くても 1 件である。
      expect(serverWindow.requestLines().filter((line) => line === `GET ${BROWSER_DEFAULT_FAVICON_PATH}`).length).toBeLessThanOrEqual(1);
    });
  });
});

describeControl('Task 18 fixtures: a Service Worker that sends a POST itself', () => {
  it('registers the worker, which sends POST /__mutation from inside the worker, in an unguarded control Context', async () => {
    await withControlPage(async (page) => {
      await page.goto(`${server.origin}/service-worker-post.html`);

      await expect.poll(() => page.evaluate(async () => (
        (await navigator.serviceWorker.getRegistrations()).length
      ))).toBe(1);
      await expect.poll(() => server.getCounters().post).toBe(1);
      expect(serverWindow.count('GET', '/service-worker-post-worker.js')).toBeGreaterThan(0);
      expect(serverWindow.count('POST', '/__mutation')).toBeGreaterThan(0);
      // ページのスクリプトは POST を送らない。POST は Worker の install の処理だけが送る。
      expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toMatch(/method:\s*'POST'/u);
    });
  });
});

/**
 * DEF-044（NP5。設計書 `2026-10-08-beaksight-def-044-046-review-fixes-design.md` 1.3）の対照: Shared Worker を無効にする引数
 * （`CHROMIUM_SHARED_WORKERS_DISABLED_ARGS`）を外した Chromium（`tests/helpers/chromium.ts` の明示の選択 `sharedWorkers: 'allow'`）では、`shared-worker-posts.html` の
 * Shared Worker が作られ、その中の fetch・XHR・keepalive の POST が、Guard のない Context でサーバに届く（遮断の確かめが空振りしない）。
 * テストの既定の headless shell と、CLI の起動の設定（`chromiumLaunchOptions`）から引数を外したものの両方で確かめる。
 * TS-f（7c）: 両方の Chromium をこの中で流すので、CLI の回では飛ばす（`describeControl`）。
 */
describeControl.each([
  { name: 'the headless shell', launch: (): Promise<Browser> => launchHeadlessChromium({ sharedWorkers: 'allow' }) },
  { name: 'the CLI Chromium', launch: (): Promise<Browser> => launchCliChromium({ sharedWorkers: 'allow' }) },
])('DEF-044 fixtures: a Shared Worker posts from inside, with $name launched without the Shared Worker disabling arguments', ({ launch }) => {
  let allowingBrowser: Browser;

  beforeAll(async () => {
    allowingBrowser = await launch();
  });

  afterAll(async () => {
    await allowingBrowser?.close();
  });

  it.each(SHARED_WORKER_POST_KINDS)('creates the Shared Worker and delivers its %s POST to /__mutation in an unguarded control Context', async (kind) => {
    await withUnguardedPage(allowingBrowser, viewport, async (page) => {
      await page.goto(`${server.origin}${sharedWorkerPostsPath(kind)}`, { waitUntil: 'load' });

      await expect.poll(() => readSharedWorkerFixtureState(page)).toEqual({ type: 'function', state: 'started' });
      await expect.poll(() => serverWindow.count('POST', '/__mutation')).toBeGreaterThan(0);
    });
  });
});

/**
 * DEF-049（NP6。設計書 `2026-10-08-beaksight-def-044-046-review-fixes-design.md` 5）の対照: Guard のない Context では、factory と同じ
 * `serviceWorkers: 'block'` を付けていても、`service-worker-bypass.html` の 2 つの迂回（`prototype.register.call`、`delete` の後の
 * 呼び出し）が、ページの文書、同じ Origin の iframe、about:blank の iframe のどこからでも Service Worker を登録し、その install と
 * activate の POST がサーバに届く（GATE-S08 の迂回の確かめが空振りしない）。テストの既定の headless shell と、CLI の起動の設定の両方で
 * 確かめる。
 * UPG-SW: Playwright 1.64.1（Chromium 156）の `serviceWorkers: 'block'` は、インスタンスではなく `ServiceWorkerContainer.prototype.register` を
 * 置き換える（microsoft/playwright の PR #43134）。そのため、Guard がなくても、`block` の Context では 2 つの迂回は登録せずに解決する（両方の
 * Chromium で確かめた）。対照は、ブラウザが登録を許す Context（`serviceWorkers: 'allow'`、Guard なし）で、fixture の迂回の経路が登録し、
 * POST が届くことを確かめる（GATE-S08 の迂回の確かめで 0 になるのが、fixture の不具合でないことの確認）。
 * TS-f（7c）: 両方の Chromium をこの中で流すので、CLI の回では飛ばす（`describeControl`）。
 */
describeControl.each([
  { name: 'the headless shell', launch: (): Promise<Browser> => launchHeadlessChromium() },
  { name: 'the CLI Chromium', launch: (): Promise<Browser> => launchCliChromium() },
])('DEF-049 fixtures: the Service Worker registration bypasses register a worker when the browser allows registration, with $name', ({ launch }) => {
  let bypassBrowser: Browser;

  beforeAll(async () => {
    bypassBrowser = await launch();
  });

  afterAll(async () => {
    await bypassBrowser?.close();
  });

  it.each(SERVICE_WORKER_BYPASS_WAYS.flatMap((way) => SERVICE_WORKER_BYPASS_FRAMES.map((where) => ({ way, where }))))(
    'registers the worker with the $way bypass in the $where frame, and its POST reaches /__mutation in an unguarded control Context',
    async ({ way, where }) => {
      const context = await bypassBrowser.newContext({ viewport, serviceWorkers: 'allow' });
      try {
        const page = await context.newPage();
        await page.goto(`${server.origin}${serviceWorkerBypassPath(way, where)}`, { waitUntil: 'load' });

        await expect.poll(() => readServiceWorkerBypassState(page)).toBe('registered');
        await expect.poll(() => serverWindow.count('POST', '/__mutation')).toBeGreaterThan(0);
        expect(serverWindow.count('GET', SERVICE_WORKER_BYPASS_WORKER_PATH)).toBeGreaterThan(0);
      } finally {
        await context.close();
      }
    },
  );
});
