// C18a（DEF-012。Task 19 の前の整理の設計書 4.2）: ページのスクリプトによる外部スキームへの移動を、Guard が検出して
// Safety Ledger の `externalSchemeNavigations` に記録する。headed では、不変条件の違反として Context を閉じる。
//
// 厳守事項: Chromium は headless だけで起動する（`useHeadlessChromium`）。headed の扱いは、headless のブラウザのまま、
// factory の設定（`browser.headed: true`）で Guard に「headed である」と注入して確かめる。外部スキームの URL は、実在しない宛先だけを使う。
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import type { BrowserContextFactory, InteractionGuardedSession } from '../../src/browser/context-factory.js';
import type { Viewport } from '../../src/config/types.js';
import { wait } from '../../src/core/deadline.js';
import type { ExternalSchemeNavigationEvent } from '../../src/core/evidence-types.js';
import { auditInteraction } from '../../src/interaction/isolated-auditor.js';
import { isPassiveRequestGuardClosed } from '../../src/safety/passive-request-guard.js';
import type { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { useHeadlessChromium } from '../helpers/chromium.js';
import {
  attemptExternalSchemeNavigation,
  EXTERNAL_SCHEME_KEYS,
  EXTERNAL_SCHEME_REDIRECT_FRAME_PAGE,
  EXTERNAL_SCHEME_REDIRECT_PATH,
  EXTERNAL_SCHEME_ROUTES,
  EXTERNAL_SCHEME_TARGETS,
  externalSchemeAttemptRecord,
  externalSchemeRedirectFramePath,
  externalSchemeRedirectPath,
  NAVIGATION_TARGET_PAGE,
  stoppedRedirectRecord,
  type ExternalSchemeKey,
} from '../helpers/external-scheme-fixture.js';
import {
  createModeFactories,
  discoverInteractionCandidate,
  factoryModeCases,
  interactionAuditInput,
  openServerWindow,
  QUIET_PERIOD_MS,
  withGuardedPassivePage,
  type FactoryMode,
} from '../helpers/gate-harness.js';

const viewport: Viewport = Object.freeze({ width: 800, height: 600 });

/**
 * 設計書 4.1 の経路（`window.open` は、別の違反になるので別に確かめる）と、実在しない宛先の組み合わせ（厳守事項）。
 * 移動の試みは、fixture の静かなページ（`NAVIGATION_TARGET_PAGE`）を読み込んだ後に、`attemptExternalSchemeNavigation` で起こす。
 */
const CASES = EXTERNAL_SCHEME_ROUTES.flatMap((route) => EXTERNAL_SCHEME_KEYS.map((key) => [route, key] as const));

let browser: Browser;
let server: FixtureServer;
let factories: Readonly<Record<FactoryMode, BrowserContextFactory>>;
let headlessFactory: BrowserContextFactory;
let headedFactory: BrowserContextFactory;

beforeAll(async () => {
  server = await startFixtureServer();
});

afterAll(async () => {
  await server?.close();
});

// afterAll は登録の逆順に実行されるので、ブラウザを閉じてから、サーバを閉じる。
useHeadlessChromium((launched) => {
  browser = launched;
});

beforeAll(() => {
  // headless のブラウザのまま、設定だけを headed にする factory も作る（Guard に「headed である」と注入する）。
  factories = createModeFactories(browser, server.origin);
  headlessFactory = factories.headless;
  headedFactory = factories['headed (injected)'];
});

const pageUrl = (): string => `${server.origin}${NAVIGATION_TARGET_PAGE}`;

/** Ledger に外部スキームへの移動が1件記録されるまで待ち、遅れて起きる事象のために、さらに少し待つ。 */
async function waitForRecord(ledger: SafetyLedger): Promise<void> {
  await expect.poll(() => ledger.snapshot().externalSchemeNavigations?.length ?? 0).toBeGreaterThan(0);
  await wait(QUIET_PERIOD_MS);
}

describe('C18a: external scheme navigations are detected and recorded by the Guard (headless)', () => {
  it.each(CASES)('Passive: %s to the %s scheme is recorded, without a violation, and the page stays', async (route, key) => {
    await withGuardedPassivePage(headlessFactory, viewport, async (page, context, ledger) => {
      await page.goto(pageUrl(), { waitUntil: 'load' });

      await attemptExternalSchemeNavigation(page, route, EXTERNAL_SCHEME_TARGETS[key].url);
      await waitForRecord(ledger);

      const snapshot = ledger.snapshot();
      expect(snapshot.externalSchemeNavigations).toEqual([externalSchemeAttemptRecord(route, key, 'PASSIVE')]);
      expect(snapshot.invariantViolations).toEqual([]);
      expect(page.url()).toBe(pageUrl());
      expect(isPassiveRequestGuardClosed(context)).toBe(false);
    });
  });

  it.each(CASES)('Interaction (after the freeze): %s to the %s scheme is recorded, without a violation', async (route, key) => {
    const session = await headlessFactory.createInteractionSession(viewport);
    try {
      await session.page.goto(pageUrl(), { waitUntil: 'load' });
      await session.activateInteractionFreeze();

      await attemptExternalSchemeNavigation(session.page, route, EXTERNAL_SCHEME_TARGETS[key].url);
      await waitForRecord(session.ledger);

      const snapshot = session.ledger.snapshot();
      expect(snapshot.externalSchemeNavigations).toEqual([externalSchemeAttemptRecord(route, key, 'INTERACTION')]);
      expect(snapshot.invariantViolations).toEqual([]);
      expect(session.page.url()).toBe(pageUrl());
      expect(session.isClosed()).toBe(false);
    } finally {
      if (!session.isClosed()) await session.close();
    }
  });

  it('window.open to an external scheme keeps the existing FRAME_CLASSIFICATION_FAILED violation and closes the Context', async () => {
    await withGuardedPassivePage(headlessFactory, viewport, async (page, context, ledger) => {
      await page.goto(pageUrl(), { waitUntil: 'load' });

      await page.evaluate((target) => {
        window.open(target);
      }, EXTERNAL_SCHEME_TARGETS.custom.url);
      await expect.poll(() => isPassiveRequestGuardClosed(context)).toBe(true);

      const snapshot = ledger.snapshot();
      expect(snapshot.invariantViolations.map(({ code }) => code)).toContain('FRAME_CLASSIFICATION_FAILED');
      expect(snapshot.invariantViolations.map(({ code }) => code)).not.toContain('EXTERNAL_SCHEME_NAVIGATION_IN_HEADED_MODE');
      // popup の navigation のリクエストは、frame ができる前に出るので、frame の種類が分からない。frame の種類を推し量って
      // 記録することはせず、既存の違反（fail-closed）だけにする。
      expect(snapshot.externalSchemeNavigations).toEqual([]);
    });
  });
});

describe('C18a: in headed mode (injected into a headless browser), an external scheme navigation is an invariant violation', () => {
  /** headed の注入の Context で、移動を試みた後、Guard が Context を閉じるまで待つ。 */
  async function expectHeadedViolation(
    ledger: SafetyLedger,
    isClosed: () => boolean,
    expected: ExternalSchemeNavigationEvent,
  ): Promise<void> {
    await expect.poll(isClosed).toBe(true);
    const snapshot = ledger.snapshot();
    expect(snapshot.externalSchemeNavigations).toEqual([expected]);
    expect(snapshot.invariantViolations).toEqual([
      expect.objectContaining({ code: 'EXTERNAL_SCHEME_NAVIGATION_IN_HEADED_MODE' }),
    ]);
  }

  it.each(EXTERNAL_SCHEME_KEYS)('Passive: location.href to the %s scheme records the violation and closes the Context', async (key) => {
    const { url, scheme } = EXTERNAL_SCHEME_TARGETS[key];
    await withGuardedPassivePage(headedFactory, viewport, async (page, context, ledger) => {
      await page.goto(pageUrl(), { waitUntil: 'load' });

      await attemptExternalSchemeNavigation(page, 'location-href', url);

      await expectHeadedViolation(ledger, () => isPassiveRequestGuardClosed(context), {
        url,
        scheme,
        frame: 'MAIN',
        phase: 'PASSIVE',
        reason: 'EXTERNAL_SCHEME_NAVIGATION',
      });
    });
  });

  it('Passive: an iframe src to an external scheme is also a violation in headed mode', async () => {
    await withGuardedPassivePage(headedFactory, viewport, async (page, context, ledger) => {
      await page.goto(pageUrl(), { waitUntil: 'load' });

      await attemptExternalSchemeNavigation(page, 'iframe-src', EXTERNAL_SCHEME_TARGETS.mailto.url);

      await expectHeadedViolation(ledger, () => isPassiveRequestGuardClosed(context), {
        url: EXTERNAL_SCHEME_TARGETS.mailto.url,
        scheme: EXTERNAL_SCHEME_TARGETS.mailto.scheme,
        frame: 'SUB',
        phase: 'PASSIVE',
        reason: 'EXTERNAL_SCHEME_NAVIGATION',
      });
    });
  });

  it('Interaction (after the freeze): a real click to an external scheme records the violation and closes the session', async () => {
    const session = await headedFactory.createInteractionSession(viewport);
    try {
      await session.page.goto(pageUrl(), { waitUntil: 'load' });
      await session.activateInteractionFreeze();

      await attemptExternalSchemeNavigation(session.page, 'button-click', EXTERNAL_SCHEME_TARGETS.tel.url);

      await expectHeadedViolation(session.ledger, () => session.isClosed(), {
        url: EXTERNAL_SCHEME_TARGETS.tel.url,
        scheme: EXTERNAL_SCHEME_TARGETS.tel.scheme,
        frame: 'MAIN',
        phase: 'INTERACTION',
        reason: 'EXTERNAL_SCHEME_NAVIGATION',
      });
    } finally {
      if (!session.isClosed()) await session.close().catch(() => undefined);
    }
  });

  it('window.open to an external scheme keeps FRAME_CLASSIFICATION_FAILED and adds the headed violation', async () => {
    await withGuardedPassivePage(headedFactory, viewport, async (page, context, ledger) => {
      await page.goto(pageUrl(), { waitUntil: 'load' });

      await page.evaluate((target) => {
        window.open(target);
      }, EXTERNAL_SCHEME_TARGETS.custom.url);
      await expect.poll(() => isPassiveRequestGuardClosed(context)).toBe(true);

      const codes = ledger.snapshot().invariantViolations.map(({ code }) => code);
      expect(codes).toContain('FRAME_CLASSIFICATION_FAILED');
      expect(codes).toContain('EXTERNAL_SCHEME_NAVIGATION_IN_HEADED_MODE');
    });
  });

  it('a blocked external main-frame navigation (and the error page that follows it) is not an external scheme navigation', async () => {
    await withGuardedPassivePage(headedFactory, viewport, async (page, context, ledger) => {
      await page.goto(pageUrl(), { waitUntil: 'load' });
      const externalUrl = 'http://127.0.0.2:9/blocked-by-guard';

      await page.evaluate((target) => {
        window.location.href = target;
      }, externalUrl);
      await expect.poll(() => ledger.snapshot().blockedNavigations.length).toBeGreaterThan(0);
      await wait(QUIET_PERIOD_MS);

      expect(ledger.snapshot().blockedNavigations).toEqual([
        { method: 'GET', url: externalUrl, reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION' },
      ]);
      expect(ledger.snapshot().externalSchemeNavigations).toEqual([]);
      expect(ledger.snapshot().invariantViolations).toEqual([]);
      expect(isPassiveRequestGuardClosed(context)).toBe(false);
    });
  });

  it('an ordinary same-origin navigation is not a violation in headed mode', async () => {
    await withGuardedPassivePage(headedFactory, viewport, async (page, context, ledger) => {
      await page.goto(pageUrl(), { waitUntil: 'load' });
      await page.goto(`${server.origin}/mailto-link.html`, { waitUntil: 'load' });
      await wait(QUIET_PERIOD_MS);

      expect(ledger.snapshot().externalSchemeNavigations).toEqual([]);
      expect(ledger.snapshot().invariantViolations).toEqual([]);
      expect(isPassiveRequestGuardClosed(context)).toBe(false);
    });
  });
});

// C18g（RC18a の指摘1・3。Task 19 の前の整理の設計書 4.2「サーバのリダイレクトは、たどる前に止める」、4.2.1）:
// サーバのリダイレクト（3xx の Location が外部スキーム）は、Guard が Document の応答の段階で、たどる前に止める。止めたことは
// `externalSchemeNavigations` に、理由 `EXTERNAL_SCHEME_REDIRECT_BLOCKED` で記録する（スクリプトによる移動の試みと区別する）。
// 止めて防げる経路なので、headed（headless のブラウザへの注入）でも違反にしない。RC18a の再現では、記録が0件だった。
describe('C18g: a server redirect to an external scheme is stopped before it is followed, and recorded', () => {
  const MODE_CASES = factoryModeCases(EXTERNAL_SCHEME_KEYS);

  const redirectUrl = (key: ExternalSchemeKey): string => `${server.origin}${externalSchemeRedirectPath(key)}`;
  /**
   * page の frame の URL のうち、外部スキームのもの。止めた iframe は Chromium のエラーのページ（`chrome-error://`）になるので、
   * それは外部スキームへの移動として数えない（`NON_EXTERNAL_NAVIGATION_SCHEMES` とは別の、テストの観測の条件である）。
   */
  const externalFrameUrls = (page: Page): string[] =>
    page.frames().map((frame) => frame.url()).filter((url) => url !== '' && !/^(https?|about|chrome-error):/u.test(url));

  it.each(MODE_CASES)('Passive (%s): an iframe redirect to %s is stopped, recorded without a violation, and the page stays', async (mode, key) => {
    const factory = factories[mode];
    await withGuardedPassivePage(factory, viewport, async (page, context, ledger) => {
      const window = openServerWindow(server);
      const url = `${server.origin}${externalSchemeRedirectFramePath(key)}`;

      await page.goto(url, { waitUntil: 'load' });
      await waitForRecord(ledger);

      const snapshot = ledger.snapshot();
      expect(snapshot.externalSchemeNavigations).toEqual([stoppedRedirectRecord(key, 'SUB', 'PASSIVE')]);
      expect(snapshot.invariantViolations).toEqual([]);
      expect(isPassiveRequestGuardClosed(context)).toBe(false);
      expect(page.url()).toBe(url);
      expect(externalFrameUrls(page)).toEqual([]);
      // リダイレクトの元のリクエストはサーバに届き、外部スキームへの移動は起きない。
      expect(window.requestLines()).toEqual([`GET ${EXTERNAL_SCHEME_REDIRECT_FRAME_PAGE}`, `GET ${EXTERNAL_SCHEME_REDIRECT_PATH}`]);
    });
  });

  it.each(MODE_CASES)('Passive (%s): a main frame redirect to %s is stopped and recorded without a violation, and the navigation fails', async (mode, key) => {
    const factory = factories[mode];
    await withGuardedPassivePage(factory, viewport, async (page, context, ledger) => {
      const window = openServerWindow(server);

      const navigation = await page.goto(redirectUrl(key)).then(() => 'RESOLVED', () => 'REJECTED');
      await waitForRecord(ledger);

      expect(navigation).toBe('REJECTED');
      const snapshot = ledger.snapshot();
      expect(snapshot.externalSchemeNavigations).toEqual([stoppedRedirectRecord(key, 'MAIN', 'PASSIVE')]);
      // headed でも、この経路（止めたリダイレクト）の違反は記録しない。
      expect(snapshot.invariantViolations.map(({ code }) => code)).not.toContain('EXTERNAL_SCHEME_NAVIGATION_IN_HEADED_MODE');
      // RC18a の指摘3（設計者の判断）: Guard 自身が止めた main frame のリクエストの失敗は、予期した失敗なので、
      // `HTTP_MAIN_FRAME_DELIVERY_FAILED` の違反にしない。ナビゲーションは失敗し（上の REJECTED）、Context は閉じない。
      expect(snapshot.invariantViolations).toEqual([]);
      expect(isPassiveRequestGuardClosed(context)).toBe(false);
      expect(window.requestLines()).toEqual([`GET ${EXTERNAL_SCHEME_REDIRECT_PATH}`]);
    });
  });

  it.each(EXTERNAL_SCHEME_KEYS)('Interaction (before the freeze): an iframe redirect to %s during the load is recorded with phase PASSIVE', async (key) => {
    const session = await headlessFactory.createInteractionSession(viewport);
    try {
      await session.page.goto(`${server.origin}${externalSchemeRedirectFramePath(key)}`, { waitUntil: 'load' });
      await waitForRecord(session.ledger);
      await session.activateInteractionFreeze();

      const snapshot = session.ledger.snapshot();
      expect(snapshot.externalSchemeNavigations).toEqual([stoppedRedirectRecord(key, 'SUB', 'PASSIVE')]);
      expect(snapshot.invariantViolations).toEqual([]);
      expect(session.isClosed()).toBe(false);
    } finally {
      if (!session.isClosed()) await session.close();
    }
  });

  it.each(EXTERNAL_SCHEME_KEYS)('Interaction (after the freeze): an iframe to the redirect of %s keeps stopping at INTERACTION_FROZEN, before the server', async (key) => {
    const session = await headlessFactory.createInteractionSession(viewport);
    try {
      await session.page.goto(pageUrl(), { waitUntil: 'load' });
      await session.activateInteractionFreeze();
      const window = openServerWindow(server);

      await session.page.evaluate((src) => {
        const frame = document.createElement('iframe');
        frame.src = src;
        document.body.append(frame);
      }, redirectUrl(key));
      await expect.poll(() => session.ledger.snapshot().blockedInteractionNavigations.length).toBeGreaterThan(0);
      await wait(QUIET_PERIOD_MS);

      const snapshot = session.ledger.snapshot();
      expect(snapshot.blockedInteractionNavigations).toContainEqual({ method: 'GET', url: redirectUrl(key), reason: 'INTERACTION_FROZEN' });
      expect(snapshot.externalSchemeNavigations).toEqual([]);
      expect(snapshot.invariantViolations).toEqual([]);
      expect(window.requestLines()).toEqual([]);
    } finally {
      if (!session.isClosed()) await session.close();
    }
  });
});

// C18a（設計者の追加の指示 3）: 凍結の後の外部スキームへの移動の試みは、ほかの凍結の後の事象と同じく、Interaction の結果を
// `BLOCKED_BY_SAFETY` にする。凍結の前（読み込みの間）の試み（`phase: 'PASSIVE'`）は、対象にしない。
describe('C18a: the Interaction result with external scheme navigations (headless)', () => {
  /**
   * 押した control の click を、capture の段階で横取りして、外部スキームへ移動させるスクリプト。fixture の DOM は変えないので、
   * 探索した候補と同じ候補を、`auditInteraction` が本物の click で押す。
   */
  const redirectClickToExternalScheme = (url: string): string => `window.addEventListener('click', (event) => {
  if (event.target instanceof HTMLButtonElement) {
    event.stopImmediatePropagation();
    window.location.href = ${JSON.stringify(url)};
  }
}, { capture: true });`;

  it('a real click after the freeze that navigates to an external scheme makes the result BLOCKED_BY_SAFETY', async () => {
    const path = '/navigation-button.html';
    const candidate = await discoverInteractionCandidate(headlessFactory, server.origin, viewport, path, 'Attempt navigation');
    const sessionFactory = async (sessionViewport: Viewport): Promise<InteractionGuardedSession> => {
      const session = await headlessFactory.createInteractionSession(sessionViewport);
      await session.page.addInitScript({ content: redirectClickToExternalScheme(EXTERNAL_SCHEME_TARGETS.tel.url) });
      return session;
    };

    const result = await auditInteraction(interactionAuditInput({
      factory: headlessFactory,
      origin: server.origin,
      viewport,
      path,
      candidate,
      sessionFactory,
    }));

    expect(result.safety.externalSchemeNavigations).toEqual([{
      url: EXTERNAL_SCHEME_TARGETS.tel.url,
      scheme: EXTERNAL_SCHEME_TARGETS.tel.scheme,
      frame: 'MAIN',
      phase: 'INTERACTION',
      reason: 'EXTERNAL_SCHEME_NAVIGATION',
    }]);
    // 横取りしたので、fixture の本来の移動（/navigation-target.html）は起きない。外部スキームへの移動の試みだけで決まる。
    expect(result.safety.blockedInteractionNavigations).toEqual([]);
    expect(result.safety.blockedInteractionRequests).toEqual([]);
    expect(result.safety.invariantViolations).toEqual([]);
    expect(result.status).toBe('BLOCKED_BY_SAFETY');
  });

  it('an external scheme navigation before the freeze (phase PASSIVE) does not make the result BLOCKED_BY_SAFETY', async () => {
    const path = '/accordion.html';
    const candidate = await discoverInteractionCandidate(headlessFactory, server.origin, viewport, path, 'Toggle details');
    const sessionFactory = async (sessionViewport: Viewport): Promise<InteractionGuardedSession> => {
      const session = await headlessFactory.createInteractionSession(sessionViewport);
      return Object.freeze({
        ...session,
        // 凍結の直前（読み込みの後）に、外部スキームへの移動を試み、PASSIVE の記録を確かめてから凍結する。
        activateInteractionFreeze: async (): Promise<void> => {
          await attemptExternalSchemeNavigation(session.page, 'location-href', EXTERNAL_SCHEME_TARGETS.mailto.url);
          await expect.poll(() => session.ledger.snapshot().externalSchemeNavigations.length).toBe(1);
          await session.activateInteractionFreeze();
        },
      });
    };

    const result = await auditInteraction(interactionAuditInput({
      factory: headlessFactory,
      origin: server.origin,
      viewport,
      path,
      candidate,
      sessionFactory,
    }));

    expect(result.safety.externalSchemeNavigations).toEqual([{
      url: EXTERNAL_SCHEME_TARGETS.mailto.url,
      scheme: EXTERNAL_SCHEME_TARGETS.mailto.scheme,
      frame: 'MAIN',
      phase: 'PASSIVE',
      reason: 'EXTERNAL_SCHEME_NAVIGATION',
    }]);
    expect(result.safety.invariantViolations).toEqual([]);
    expect(result.status).toBe('VERIFIED');
  });
});
