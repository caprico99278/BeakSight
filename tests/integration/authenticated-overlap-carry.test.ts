// SFIX-1104（SREV-1104 の I-1。設計書 `doc/design/2026-11-04-beaksight-login-session-design.md` 3.1）: 次の Context へ渡す状態は、サイトの応答を最後に受けた
// Context の状態（同じなら最後に閉じた方）。読むたびにセッションの cookie を替え、前の値を無効にするサイト（`startAuthenticatedSite({ rotate: true })`）で、
// 本物の factory・Guard を使って確かめる。
// - Page Auditor の順（D を開いたまま Interaction の Context で対象の画面を読み、Interaction を閉じてから D を閉じる）。直す前は、最後に閉じた D の古い
//   cookie が次へ渡り、次の Context はログインの画面へ移される（その移動は Guard が止める）。
// - Context を重ねて開き、後で読んだ方を先に閉じる順（閉じる順を逆にした場面）。
// 届いたかはサーバの記録で数え（有効なセッションで管理画面を読んだか・ログインの画面への要求）、名前つきの時間だけ待って数え直す。Chromium はテストの既定の
// headless だけ（TEST-SLIM）。
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserContextFactory, type AuthenticatedStorageState } from '../../src/browser/context-factory.js';
import { wait } from '../../src/core/deadline.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { DEFAULT_CHROMIUM_LAUNCHERS } from '../helpers/chromium.js';
import {
  AUTH_SITE_PATHS,
  authenticatedStateFor,
  startAuthenticatedSite,
  type AuthenticatedSite,
} from '../helpers/authenticated-site-fixture.js';
import { createTestConfig, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

const VIEWPORT = { width: 1280, height: 800 };
const LATE_REQUEST_WAIT_MS = 1_000;
const TEST_TIMEOUT_MS = 120_000;

describe.each(DEFAULT_CHROMIUM_LAUNCHERS)('SFIX-1104: the next context inherits the state of the context that received the last site response (%s)', (_label, launch) => {
  let site: AuthenticatedSite | undefined;
  let browser: Browser | undefined;
  let factory: BrowserContextFactory | undefined;

  afterEach(async () => {
    await factory?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await site?.close();
    factory = undefined;
    browser = undefined;
    site = undefined;
  });

  /** 回すサイトと、認証つきの factory を用意する。 */
  const prepare = async (): Promise<{ readonly s: AuthenticatedSite; readonly f: BrowserContextFactory }> => {
    site = await startAuthenticatedSite({ rotate: true });
    const s = site;
    browser = await launch();
    const { state } = authenticatedStateFor(s);
    factory = new BrowserContextFactory(browser, createTestConfig(s.originA, AUTH_SITE_PATHS.admin), () => new SafetyLedger(), {
      ...TEST_FACTORY_OPTIONS,
      authentication: {
        initialState: state as AuthenticatedStorageState,
        filterState: (value) => filterAuthenticatedState(value, [s.originA]),
        auditExclusions: {
          excludedPathPrefixes: [AUTH_SITE_PATHS.adminLogout],
          auditPathPrefixes: [AUTH_SITE_PATHS.admin],
          dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS,
        },
      },
    });
    return { s, f: factory };
  };

  /** 管理画面を読む（読めた path。移動を Guard が止めたら `BLOCKED`）。 */
  const visit = async (s: AuthenticatedSite, page: Page): Promise<string> => {
    try {
      await page.goto(`${s.originA}${AUTH_SITE_PATHS.admin}`, { waitUntil: 'load' });
    } catch {
      return 'BLOCKED';
    }
    return new URL(page.url()).pathname;
  };

  const open = async (f: BrowserContextFactory): Promise<{ readonly context: BrowserContext; readonly page: Page }> => {
    const context = await f.createPassiveContext(VIEWPORT);
    return { context, page: await f.createPassivePage(context) };
  };

  /** 次の Context で管理画面を読み、サーバの記録（有効なセッションで読んだ数・ログインの画面への要求）を、待って数え直してから返す。 */
  const readNext = async (s: AuthenticatedSite, f: BrowserContextFactory): Promise<{ readonly path: string; readonly authenticatedReads: number }> => {
    const before = s.requests.filter(({ authenticated }) => authenticated).length;
    const next = await open(f);
    const path = await visit(s, next.page);
    await f.closePassiveContext(next.context);
    const counted = JSON.stringify(s.requests);
    await wait(LATE_REQUEST_WAIT_MS);
    expect(JSON.stringify(s.requests)).toBe(counted);
    return { path, authenticatedReads: s.requests.filter(({ authenticated }) => authenticated).length - before };
  };

  const loginRequests = (s: AuthenticatedSite): number => s.requests.filter(({ path }) => path.startsWith(AUTH_SITE_PATHS.login)).length;

  it('keeps the login after an Interaction context reads inside the open desktop context (the Page Auditor order)', async () => {
    const { s, f } = await prepare();
    const desktop = await open(f);
    expect(await visit(s, desktop.page)).toBe(AUTH_SITE_PATHS.admin);
    const session = await f.createInteractionSession(VIEWPORT);
    try {
      expect(await visit(s, session.page)).toBe(AUTH_SITE_PATHS.admin);
    } finally {
      await session.close();
    }
    await f.closePassiveContext(desktop.context);

    expect(await readNext(s, f)).toEqual({ path: AUTH_SITE_PATHS.admin, authenticatedReads: 1 });
    expect(loginRequests(s)).toBe(0);
    expect(f.authenticatedStateReadFailureCount()).toBe(0);
  }, TEST_TIMEOUT_MS);

  it('keeps the login when the context that read later closes first (the reversed close order)', async () => {
    const { s, f } = await prepare();
    const first = await open(f);
    expect(await visit(s, first.page)).toBe(AUTH_SITE_PATHS.admin);
    const second = await open(f);
    expect(await visit(s, second.page)).toBe(AUTH_SITE_PATHS.admin);
    await f.closePassiveContext(second.context);
    await f.closePassiveContext(first.context);

    expect(await readNext(s, f)).toEqual({ path: AUTH_SITE_PATHS.admin, authenticatedReads: 1 });
    expect(loginRequests(s)).toBe(0);
  }, TEST_TIMEOUT_MS);
});
