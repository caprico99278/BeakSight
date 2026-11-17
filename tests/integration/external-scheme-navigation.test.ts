// C18a（DEF-012。Task 19 の前の整理の設計書 4.2）: ページのスクリプトによる外部スキームへの移動を、Guard が検出して
// Safety Ledger の `externalSchemeNavigations` に記録する。
// SAFE-2 の 4（違反の区分の (3)。設計者の判断）: 前は R7d で、この移動を不変条件の違反にし、Guard が Context を閉じた。本番の Chromium は移動を止め、外部の
// アプリへ渡さない（EL-12）ので、今は記録だけを残す（違反にせず、Context も閉じない）。
//
// 厳守事項: Chromium は headless だけで起動する（`useHeadlessChromium`）。外部スキームの URL は、実在しない宛先だけを使う。
import type { Browser } from 'playwright';
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

/** 移動を試みた後、移動の試みの記録（`expected`）が 1 件だけ残ることを確かめる（SAFE-2 の 4 から、違反にせず、Context も閉じない）。 */
async function expectAttemptRecorded(ledger: SafetyLedger, expected: ExternalSchemeNavigationEvent): Promise<void> {
  await waitForRecord(ledger);
  expect(ledger.snapshot().externalSchemeNavigations).toEqual([expected]);
}

// SAFE-2 の 4（違反の区分の (3)。設計者の判断）: 前は、移動の試みを違反（`EXTERNAL_SCHEME_NAVIGATION_ATTEMPTED`）にし、Guard が Context を閉じた。今は、ブラウザが
// 移動を止めていて外へは何も渡っていないので、記録だけを残す。Passive の段の経路とスキームの組は、safety-gates の GATE-S03 Passive（サーバの境界も確かめる）と
// 重なるので、ここでは凍結の後だけを確かめる。
describe('C18a after SAFE-2: an external scheme navigation by the page is recorded (headless)', () => {
  it.each(CASES)('Interaction (after the freeze): %s to the %s scheme is recorded and the page stays', async (route, key) => {
    const session = await headlessFactory.createInteractionSession(viewport);
    try {
      await session.page.goto(pageUrl(), { waitUntil: 'load' });
      await session.activateInteractionFreeze();

      await attemptExternalSchemeNavigation(session.page, route, EXTERNAL_SCHEME_TARGETS[key].url);

      await expectAttemptRecorded(session.ledger, externalSchemeAttemptRecord(route, key, 'INTERACTION'));
      expect(session.page.url()).toBe(pageUrl());
    } finally {
      if (!session.isClosed()) await session.close().catch(() => undefined);
    }
  });

  // SAFE-2 の 4: popup（`window.open`）の移動は frame の種類が分からないので、frame の判定の失敗の記録（`frameClassificationFailures`）に残す（前は違反）。
  it('window.open to an external scheme is recorded as a frame classification failure', async () => {
    await withGuardedPassivePage(headlessFactory, viewport, async (page, _context, ledger) => {
      await page.goto(pageUrl(), { waitUntil: 'load' });

      await page.evaluate((target) => {
        window.open(target);
      }, EXTERNAL_SCHEME_TARGETS.custom.url).catch(() => undefined);
      await expect.poll(() => ledger.snapshot().frameClassificationFailures?.events
        .some(({ url, phase }) => url === EXTERNAL_SCHEME_TARGETS.custom.url && phase === 'PASSIVE') ?? false).toBe(true);
    });
  });

  // FIN-1（SD-2 の 2.4）: 許可 Origin の外への http の main frame の移動は止めない（止めた記録もない）。その移動と、続く誤りの画面は、外のスキームの移動ではない。
  it('an external http main-frame navigation (and the error page that follows it) is not an external scheme navigation', async () => {
    await withGuardedPassivePage(headlessFactory, viewport, async (page, context, ledger) => {
      await page.goto(pageUrl(), { waitUntil: 'load' });
      const externalUrl = 'http://127.0.0.2:9/not-stopped';

      await page.evaluate((target) => {
        window.location.href = target;
      }, externalUrl);
      await expect.poll(() => page.url()).not.toBe(pageUrl());
      await wait(QUIET_PERIOD_MS);

      expect(ledger.snapshot().blockedNavigations).toEqual([]);
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

  // TS-f（B1・B2）: Passive の iframe と main frame のリダイレクトの場面（止めた記録、違反 0、Context を閉じない、サーバに届く要求、外部スキームの
  // frame がない、main frame の移動の失敗）は、同じ確かめをしていた `safety-gates.test.ts` の GATE-S03 に、1 か所にまとめた。

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

  // L10 の後の安全の側の設計の変更（設計者の判断）: Isolated Interaction Context でも、凍結の後の読み取り（子の frame の文書の GET を含む。`isFrozenReadAdmissible`）
  // を通す。前は、子の frame の文書の要求を凍結で止め（`INTERACTION_FROZEN`）、サーバに届かなかった。今は、文書の GET はサーバに届き、外部スキームへの
  // リダイレクトは、凍結の前と同じく、たどる前に止めて記録する（`EXTERNAL_SCHEME_REDIRECT_BLOCKED`。時点は凍結の後 `INTERACTION`）。
  it.each(EXTERNAL_SCHEME_KEYS)('Interaction (after the freeze): an iframe to the redirect of %s reaches the server as a frozen read, and the redirect is stopped before it is followed', async (key) => {
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
      await waitForRecord(session.ledger);

      const snapshot = session.ledger.snapshot();
      // 読み取り（子の frame の文書の GET）はサーバに届いた（凍結で止めていない）。
      // サーバの記録の行は、query を含まない path。
      expect(window.requestLines()).toEqual([`GET ${new URL(redirectUrl(key)).pathname}`]);
      expect(snapshot.blockedInteractionNavigations.filter(({ url }) => url === redirectUrl(key))).toEqual([]);
      // 外部スキームへのリダイレクトは、たどる前に止めて記録した（外部スキームの frame はない）。違反にしない。
      expect(snapshot.externalSchemeNavigations).toEqual([stoppedRedirectRecord(key, 'SUB', 'INTERACTION')]);
      expect(snapshot.invariantViolations).toEqual([]);
    } finally {
      if (!session.isClosed()) await session.close();
    }
  });
});

// C18a（設計者の追加の指示 3）: 凍結の後の外部スキームへの移動の試みは、ほかの凍結の後の事象と同じく、Interaction の結果を
// `BLOCKED_BY_SAFETY` にする。凍結の前（読み込みの間）の記録（`phase: 'PASSIVE'`）は、対象にしない。
// 凍結の後に押して外部スキームへ移る場面（結果が BLOCKED_BY_SAFETY）は、safety-gates の GATE-S03 Interaction と重なるので、ここには置かない（SAFE-2 の 4 で整理）。
describe('C18a: the Interaction result with external scheme navigations (headless)', () => {
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
    expect(result.status).toBe('VERIFIED');
  });
});
