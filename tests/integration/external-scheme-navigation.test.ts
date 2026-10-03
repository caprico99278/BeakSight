// C18a（DEF-012。Task 19 の前の整理の設計書 4.2）: ページのスクリプトによる外部スキームへの移動を、Guard が検出して
// Safety Ledger の `externalSchemeNavigations` に記録する。
// R7d（中断した Run の再開の設計書 4.10）: CLI の Chromium は、headless でも通常の Chromium の本体を使うので、headed と headless を
// 問わず、外部のアプリが起動しうる。そのため、この移動は、安全の不変条件の違反（`EXTERNAL_SCHEME_NAVIGATION_ATTEMPTED`）として
// 記録し、Guard が Context を閉じる。Guard は headed かどうかを受け取らないので、headed の設定の注入はしない。
//
// 厳守事項: Chromium は headless だけで起動する（`useHeadlessChromium`）。外部スキームの URL は、実在しない宛先だけを使う。
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
  createGateFactory,
  discoverInteractionCandidate,
  interactionAuditInput,
  openServerWindow,
  QUIET_PERIOD_MS,
  withGuardedPassivePage,
} from '../helpers/gate-harness.js';

const viewport: Viewport = Object.freeze({ width: 800, height: 600 });

/**
 * 設計書 4.1 の経路（`window.open` は、別の違反も加わるので別に確かめる）と、実在しない宛先の組み合わせ（厳守事項）。
 * 移動の試みは、fixture の静かなページ（`NAVIGATION_TARGET_PAGE`）を読み込んだ後に、`attemptExternalSchemeNavigation` で起こす。
 */
const CASES = EXTERNAL_SCHEME_ROUTES.flatMap((route) => EXTERNAL_SCHEME_KEYS.map((key) => [route, key] as const));

/** 外部スキームへの移動の試みの、不変条件の違反のコード（R7d。中断した Run の再開の設計書 4.10）。 */
const ATTEMPTED_VIOLATION_CODE = 'EXTERNAL_SCHEME_NAVIGATION_ATTEMPTED';

let browser: Browser;
let server: FixtureServer;
let headlessFactory: BrowserContextFactory;

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
  headlessFactory = createGateFactory(browser, server.origin);
});

const pageUrl = (): string => `${server.origin}${NAVIGATION_TARGET_PAGE}`;

/** Ledger に外部スキームへの移動が1件記録されるまで待ち、遅れて起きる事象のために、さらに少し待つ。 */
async function waitForRecord(ledger: SafetyLedger): Promise<void> {
  await expect.poll(() => ledger.snapshot().externalSchemeNavigations?.length ?? 0).toBeGreaterThan(0);
  await wait(QUIET_PERIOD_MS);
}

/**
 * 移動を試みた後、Guard が Context を閉じるまで待ち、移動の試みの記録（`expected`）と、不変条件の違反
 * （`EXTERNAL_SCHEME_NAVIGATION_ATTEMPTED`）が、それぞれ1件だけあることを確かめる。
 */
async function expectAttemptViolation(
  ledger: SafetyLedger,
  isClosed: () => boolean,
  expected: ExternalSchemeNavigationEvent,
): Promise<void> {
  await expect.poll(isClosed).toBe(true);
  const snapshot = ledger.snapshot();
  expect(snapshot.externalSchemeNavigations).toEqual([expected]);
  expect(snapshot.invariantViolations).toEqual([
    {
      code: ATTEMPTED_VIOLATION_CODE,
      message: `Navigation to the external scheme ${expected.scheme} was attempted; the browser may have launched an external application`,
    },
  ]);
}

describe('C18a / R7d: an external scheme navigation by the page is recorded, is an invariant violation, and closes the Context (headless)', () => {
  it.each(CASES)('Passive: %s to the %s scheme is recorded, records the violation, and the Guard closes the Context', async (route, key) => {
    await withGuardedPassivePage(headlessFactory, viewport, async (page, context, ledger) => {
      await page.goto(pageUrl(), { waitUntil: 'load' });

      await attemptExternalSchemeNavigation(page, route, EXTERNAL_SCHEME_TARGETS[key].url);

      await expectAttemptViolation(ledger, () => isPassiveRequestGuardClosed(context), externalSchemeAttemptRecord(route, key, 'PASSIVE'));
      // ブラウザは、外部スキームのページへ移動していない。
      expect(page.url()).toBe(pageUrl());
    });
  });

  it.each(CASES)('Interaction (after the freeze): %s to the %s scheme is recorded, records the violation, and the Guard closes the session', async (route, key) => {
    const session = await headlessFactory.createInteractionSession(viewport);
    try {
      await session.page.goto(pageUrl(), { waitUntil: 'load' });
      await session.activateInteractionFreeze();

      await attemptExternalSchemeNavigation(session.page, route, EXTERNAL_SCHEME_TARGETS[key].url);

      await expectAttemptViolation(session.ledger, () => session.isClosed(), externalSchemeAttemptRecord(route, key, 'INTERACTION'));
      expect(session.page.url()).toBe(pageUrl());
    } finally {
      if (!session.isClosed()) await session.close().catch(() => undefined);
    }
  });

  it('window.open to an external scheme keeps the existing FRAME_CLASSIFICATION_FAILED violation, adds the violation, and closes the Context', async () => {
    await withGuardedPassivePage(headlessFactory, viewport, async (page, context, ledger) => {
      await page.goto(pageUrl(), { waitUntil: 'load' });

      await page.evaluate((target) => {
        window.open(target);
      }, EXTERNAL_SCHEME_TARGETS.custom.url);
      await expect.poll(() => isPassiveRequestGuardClosed(context)).toBe(true);

      const snapshot = ledger.snapshot();
      expect(snapshot.invariantViolations.map(({ code }) => code)).toContain('FRAME_CLASSIFICATION_FAILED');
      expect(snapshot.invariantViolations.map(({ code }) => code)).toContain(ATTEMPTED_VIOLATION_CODE);
      // popup の navigation のリクエストは、frame ができる前に出るので、frame の種類が分からない。frame の種類を推し量って
      // 記録することはせず、違反（fail-closed）だけにする。
      expect(snapshot.externalSchemeNavigations).toEqual([]);
    });
  });

  it('a blocked external main-frame navigation (and the error page that follows it) is not an external scheme navigation', async () => {
    await withGuardedPassivePage(headlessFactory, viewport, async (page, context, ledger) => {
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

  it('an ordinary same-origin navigation is not a violation', async () => {
    await withGuardedPassivePage(headlessFactory, viewport, async (page, context, ledger) => {
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
// 止めて防げる経路なので、違反にしない（ページのスクリプトによる移動は違反にするのと違う。中断した Run の再開の設計書 4.10）。
// RC18a の再現では、記録が0件だった。
describe('C18g: a server redirect to an external scheme is stopped before it is followed, and recorded', () => {
  const redirectUrl = (key: ExternalSchemeKey): string => `${server.origin}${externalSchemeRedirectPath(key)}`;
  /**
   * page の frame の URL のうち、外部スキームのもの。止めた iframe は Chromium のエラーのページ（`chrome-error://`）になるので、
   * それは外部スキームへの移動として数えない（`NON_EXTERNAL_NAVIGATION_SCHEMES` とは別の、テストの観測の条件である）。
   */
  const externalFrameUrls = (page: Page): string[] =>
    page.frames().map((frame) => frame.url()).filter((url) => url !== '' && !/^(https?|about|chrome-error):/u.test(url));

  it.each(EXTERNAL_SCHEME_KEYS)('Passive: an iframe redirect to %s is stopped, recorded without a violation, and the page stays', async (key) => {
    await withGuardedPassivePage(headlessFactory, viewport, async (page, context, ledger) => {
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

  it.each(EXTERNAL_SCHEME_KEYS)('Passive: a main frame redirect to %s is stopped and recorded without a violation, and the navigation fails', async (key) => {
    await withGuardedPassivePage(headlessFactory, viewport, async (page, context, ledger) => {
      const window = openServerWindow(server);

      const navigation = await page.goto(redirectUrl(key)).then(() => 'RESOLVED', () => 'REJECTED');
      await waitForRecord(ledger);

      expect(navigation).toBe('REJECTED');
      const snapshot = ledger.snapshot();
      expect(snapshot.externalSchemeNavigations).toEqual([stoppedRedirectRecord(key, 'MAIN', 'PASSIVE')]);
      // この経路（止めたリダイレクト）は、ページのスクリプトによる移動の違反にしない。
      expect(snapshot.invariantViolations.map(({ code }) => code)).not.toContain(ATTEMPTED_VIOLATION_CODE);
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
// `BLOCKED_BY_SAFETY` にする。凍結の前（読み込みの間）の記録（`phase: 'PASSIVE'`）は、対象にしない。
// R7d（中断した Run の再開の設計書 4.10）: ページのスクリプトによる移動は、凍結の前でも後でも、不変条件の違反になり、Guard が
// session の Context を閉じる。そのため、凍結の前の記録が対象にならないことは、違反にならない記録（止めたサーバのリダイレクト）で確かめる。
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

  /**
   * Guard が閉じた session の Context を、`auditInteraction` が閉じようとしたときの違反（Guard が閉じた session の、今までの扱い。
   * `isolated-auditor.ts` の owner の close は、無効にした Context の close の失敗を記録する）。
   */
  const OWNER_CLOSE_OF_INVALIDATED_SESSION = Object.freeze({
    code: 'INTERACTION_OWNER_CLOSE_FAILED',
    message: 'Passive request guard context was invalidated',
  });

  it('a real click after the freeze that navigates to an external scheme makes the result BLOCKED_BY_SAFETY and is a violation', async () => {
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
    // 移動の試みは違反になり、Guard が session の Context を閉じる（R7d）。
    expect(result.safety.invariantViolations).toEqual([
      {
        code: ATTEMPTED_VIOLATION_CODE,
        message: 'Navigation to the external scheme tel was attempted; the browser may have launched an external application',
      },
      OWNER_CLOSE_OF_INVALIDATED_SESSION,
    ]);
    // 凍結の後の移動の扱い（結果を BLOCKED_BY_SAFETY にする）は変わらない。
    expect(result.status).toBe('BLOCKED_BY_SAFETY');
    expect(result.reason).toBe('SAFETY_FREEZE_BLOCKED');
  });

  it('a stopped redirect to an external scheme before the freeze (phase PASSIVE) does not make the result BLOCKED_BY_SAFETY', async () => {
    const path = '/accordion.html';
    const key: ExternalSchemeKey = 'mailto';
    const candidate = await discoverInteractionCandidate(headlessFactory, server.origin, viewport, path, 'Toggle details');
    const sessionFactory = async (sessionViewport: Viewport): Promise<InteractionGuardedSession> => {
      const session = await headlessFactory.createInteractionSession(sessionViewport);
      return Object.freeze({
        ...session,
        // 凍結の直前（読み込みの後）に、外部スキームへリダイレクトする iframe を加え、PASSIVE の記録を確かめてから凍結する。
        activateInteractionFreeze: async (): Promise<void> => {
          await session.page.evaluate((src) => {
            const frame = document.createElement('iframe');
            frame.src = src;
            document.body.append(frame);
          }, `${server.origin}${externalSchemeRedirectPath(key)}`);
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

    expect(result.safety.externalSchemeNavigations).toEqual([stoppedRedirectRecord(key, 'SUB', 'PASSIVE')]);
    expect(result.safety.invariantViolations).toEqual([]);
    expect(result.status).toBe('VERIFIED');
  });

  it('a script navigation to an external scheme before the freeze is a violation, and the Guard closes the session before the freeze', async () => {
    const path = '/accordion.html';
    const candidate = await discoverInteractionCandidate(headlessFactory, server.origin, viewport, path, 'Toggle details');
    const sessionFactory = async (sessionViewport: Viewport): Promise<InteractionGuardedSession> => {
      const session = await headlessFactory.createInteractionSession(sessionViewport);
      return Object.freeze({
        ...session,
        // 凍結の直前（読み込みの後）に、外部スキームへの移動を試み、Guard が session の Context を閉じてから凍結を試みる。
        activateInteractionFreeze: async (): Promise<void> => {
          await attemptExternalSchemeNavigation(session.page, 'location-href', EXTERNAL_SCHEME_TARGETS.mailto.url);
          await expect.poll(() => session.isClosed()).toBe(true);
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
    expect(result.safety.invariantViolations).toEqual([
      {
        code: ATTEMPTED_VIOLATION_CODE,
        message: 'Navigation to the external scheme mailto was attempted; the browser may have launched an external application',
      },
      OWNER_CLOSE_OF_INVALIDATED_SESSION,
    ]);
    // 凍結の前の記録（phase PASSIVE）は、凍結の後の事象として扱わない（SAFETY_FREEZE_BLOCKED にしない）。結果は、Guard が閉じた
    // session の、今までの扱い（owner の close の失敗による BLOCKED_BY_SAFETY）になる。
    expect(result.reason).not.toBe('SAFETY_FREEZE_BLOCKED');
    expect(result.status).toBe('BLOCKED_BY_SAFETY');
    expect(result.reason).toBe('OWNER_CLOSE_SAFETY_FAILURE');
  });
});
