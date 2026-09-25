import type { Browser, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { Viewport } from '../../src/config/types.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { launchHeadlessChromium, oopifTargetUrls, SITE_PER_PROCESS_ARGS, useHeadlessChromium } from '../helpers/chromium.js';
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
import { openServerWindow, withGuardedPassivePage, withUnguardedPage, type ServerWindow } from '../helpers/gate-harness.js';
import { createTestConfig } from '../helpers/test-config.js';

/**
 * Task 18（T18a）で加えた fixture が、期待どおりのリクエストを試みることを確かめる。
 *
 * - 遮断を確かめるのは、Safety の Gate（T18b）である。ここでは、Guard のない対照の Context で、fixture のリクエストが
 *   実際にサーバに届くことを確かめる。遮断の確認が空振りしない（fixture がそもそも何も送らない、ということがない）ためである。
 * - 移動とポップアップの先のページは、Passive の Context で直接開けば GET が記録されることも確かめる（DEF-010 の対照）。
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

  it('opens /popup-target.html from the popup button in an unguarded control Context', async () => {
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

  it('navigates to /navigation-target.html from the navigation button in an unguarded control Context', async () => {
    await withControlPage(async (page) => {
      await page.goto(`${server.origin}/navigation-button.html`);

      await page.getByRole('button', { name: 'Attempt navigation' }).click();
      await page.waitForURL(`${server.origin}${NAVIGATION_TARGET_PAGE}`);

      expect(await page.title()).toBe(NAVIGATION_TARGET_HEADING);
      expect(serverWindow.count('GET', NAVIGATION_TARGET_PAGE)).toBeGreaterThan(0);
    });
  });
});

describe('Task 18 fixtures: PATCH requests reach the server in an unguarded control Context', () => {
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

describe('Task 18 fixtures: DELETE requests reach the server in an unguarded control Context', () => {
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

// C18b（DEF-012、GATE-S03 の対照）: 外部スキームへの移動を試みる fixture は、Guard のない Context で、実際にその外部スキームの
// URL への移動のリクエストを出す（Playwright の `request` の事象に、その URL が来る）。Gate の「記録された」「届かなかった」の
// 確認が空振りしないためである。Chromium は headless だけで起動する（`useHeadlessChromium`。headless のバイナリには、外部の
// アプリへ URL を渡す仕組みがない）。宛先は、実在しないものだけである。
describe('C18b fixtures: pages that attempt a navigation to an external scheme', () => {
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
      expect(serverWindow.requestLines()).toEqual([
        `GET ${externalSchemeFixturePathname(route)}`,
      ]);
    });
  });
});

// C18g（RC18a の指摘1、GATE-S03 の対照）: サーバのリダイレクト（`302 Location: <外部スキーム>`）の fixture は、Guard のない
// Context では、リダイレクトをたどって、その外部スキームの URL への移動のリクエスト（`redirectedFrom` 付き）を出す。Gate の
// 「たどる前に止めた」の確認が空振りしないためである。Chromium は headless だけで起動する。宛先は、サーバの中の固定の一覧
// （実在しないもの）だけである。
describe('C18g fixtures: a server redirect to an external scheme', () => {
  it.each(EXTERNAL_SCHEME_KEYS)('iframe: the redirect to %s is followed to the external scheme URL in an unguarded control Context', async (key) => {
    await withControlPage(async (page) => {
      const redirected = collectRedirectedNavigations(page);

      await page.goto(`${server.origin}${externalSchemeRedirectFramePath(key)}`, { waitUntil: 'load' });

      await expect.poll(() => redirected).toEqual([
        `${EXTERNAL_SCHEME_TARGETS[key].url} <- ${server.origin}${externalSchemeRedirectPath(key)}`,
      ]);
      expect(serverWindow.requestLines()).toEqual([
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
      expect(serverWindow.requestLines()).toEqual([
        `GET ${EXTERNAL_SCHEME_REDIRECT_PATH}`,
      ]);
    });
  });
});

// C18i（RC18b の N1、GATE-S03 の対照）: 別のサイトの iframe の fixture（`cross-site-frame.html`）は、`--site-per-process` の
// Chromium では、別のプロセスの iframe（OOPIF）になる。その中のページ（`self-navigating-frame.html`）は、Guard のない Context では、
// 自分で移動してリダイレクトをたどり、POST を送り、一番上の frame を移動させる。Gate の「止めた」「届かなかった」の確認が空振りしない
// ためである。Chromium は headless だけで起動する（サイトの分離を無効にする引数は使わない）。宛先は、実在しないものだけである。
describe('C18i fixtures: a cross-site iframe that runs in a separate process (OOPIF) and navigates itself', () => {
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
      expect(serverWindow.requestLines()).toEqual([
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
      expect(serverWindow.requestLines()).toEqual([
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

describe('Task 18 fixtures: a Service Worker that sends a POST itself', () => {
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
