// T25c（Task 25 の設計書 `2026-10-10-beaksight-task-25-manual-login-session-design.md` 4.3 と、変更履歴の 2026-10-10 の Blocker の行）:
// `BrowserContextFactory` の、認証済みの状態の注入の入口と、世代つきの受け継ぎ。本物の factory と Guard と、127.0.0.1 の fixture のサーバ
// （`tests/helpers/authenticated-site-fixture.ts`）で確かめる。Chromium は headless だけ。テストの既定（headless shell）と、CLI の起動の設定
// （`launchCliChromium`）の両方で確かめる。
// - 注入: 指定した状態（絞り込んだもの）で、管理画面を読める。Context を作るだけでは、サーバに要求を送らない。指定のない factory は今のまま
//   （状態を持たない）。
// - 受け継ぎ（DEF-191 の後。設計書 `2026-11-04-beaksight-login-session-design.md` 3.1）: Desktop を閉じてから、幅の走査の Context を順に開け閉めし、
//   その後に Mobile を作る（Page Auditor の順）。回転するサーバでも、すべての Context で認証が保たれる。受け継ぐのは、最後に閉じた Context の状態（作った順の
//   世代でなく、閉じた順）。生きている Context の状態を読む間に、サーバへの要求はない（別の Origin の iframe を含むページ）。
// - 別の Origin の Cookie（調査の E7）は、Cookie の範囲の結合の 1 本 `authenticated-host-only-cookies.test.ts` へ移した（SLIM L-3）。
// - Guard に監査の段の除外の指定が渡る（ログアウトは届かない）。
// - 状態を取り出せなかったときは、前の状態のまま進み、その回数を数える（値は記録しない）。
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BrowserContextFactory,
  type AuthenticatedContextOptions,
  type AuthenticatedStorageState,
} from '../../src/browser/context-factory.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import type { Viewport } from '../../src/config/types.js';
import { announceOwnMainFrameNavigation, WriteStageMonitor } from '../../src/safety/passive-request-guard.js';
import type { AuditExclusionPolicy } from '../../src/safety/request-policy.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import {
  AUTH_SITE_LOCAL_STORAGE_ITEM,
  AUTH_SITE_PATHS,
  AUTH_SITE_SESSION_COOKIE,
  authenticatedStateFor,
  startAuthenticatedSite,
  type AuthenticatedSite,
  type AuthenticatedSiteOptions,
} from '../helpers/authenticated-site-fixture.js';
import { BOTH_CHROMIUM_LAUNCHERS } from '../helpers/chromium.js';
import { createTestConfig, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

const DESKTOP: Viewport = Object.freeze({ width: 1280, height: 800 });
const STRESS: Viewport = Object.freeze({ width: 600, height: 800 });
const MOBILE: Viewport = Object.freeze({ width: 390, height: 844 });
/** 幅の走査の幅の数（Desktop の Context を閉じた後に、順に開け閉めする Context の数）。 */
const NESTED_STRESS_CONTEXTS = 2;

/** 監査の段の除外（ログアウトを除外のパスに、管理画面を読む範囲に、危険な語は既定の一覧）。 */
const EXCLUSIONS: AuditExclusionPolicy = Object.freeze({
  excludedPathPrefixes: Object.freeze([AUTH_SITE_PATHS.adminLogout]),
  auditPathPrefixes: Object.freeze([AUTH_SITE_PATHS.admin]),
  dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS,
});

describe.each(BOTH_CHROMIUM_LAUNCHERS)('T25c: authenticated state injection and inheritance in BrowserContextFactory (%s)', (_name, launch) => {
  let browser: Browser;
  let site: AuthenticatedSite;
  const factories: BrowserContextFactory[] = [];

  beforeEach(async () => {
    browser = await launch();
  });

  afterEach(async () => {
    await Promise.all(factories.splice(0).map((factory) => factory.close()));
    await browser.close();
    await site?.close();
  });

  async function startSite(options: AuthenticatedSiteOptions = {}): Promise<AuthenticatedSite> {
    site = await startAuthenticatedSite(options);
    return site;
  }

  function factoryWith(authentication?: AuthenticatedContextOptions, writeJob = false): BrowserContextFactory {
    const factory = new BrowserContextFactory(
      browser,
      createTestConfig(site.originA, AUTH_SITE_PATHS.admin),
      () => new SafetyLedger(),
      { ...TEST_FACTORY_OPTIONS, ...(authentication === undefined ? {} : { authentication }), ...(writeJob ? { writeJob: true as const } : {}) },
    );
    factories.push(factory);
    return factory;
  }

  function authenticationFor(
    initialState: AuthenticatedStorageState,
    filterState: AuthenticatedContextOptions['filterState'] = (state) => filterAuthenticatedState(state, [site.originA]),
  ): AuthenticatedContextOptions {
    return { initialState, filterState, auditExclusions: EXCLUSIONS };
  }

  async function open(factory: BrowserContextFactory, viewport: Viewport): Promise<{ context: BrowserContext; page: Page }> {
    const context = await factory.createPassiveContext(viewport);
    const page = await factory.createPassivePage(context);
    return { context, page };
  }

  /**
   * `path` を読み、main frame の最後の path を返す。BeakSight 自身の読み込みと同じく、読み込みの前に Guard に知らせる（L10: 知らせない同じ URL の 2 回目は、
   * ページが始めた移動の輪として止まる）。
   */
  async function visit(page: Page, path: string): Promise<string> {
    announceOwnMainFrameNavigation(page);
    await page.goto(`${site.originA}${path}`, { waitUntil: 'load' });
    return new URL(page.url()).pathname;
  }

  it('reads the admin page with the injected (filtered) state, and creating the Context sends nothing to the server', async () => {
    await startSite();
    const { state } = authenticatedStateFor(site);
    const factory = factoryWith(authenticationFor(state));

    const { context, page } = await open(factory, DESKTOP);
    expect(site.requests).toEqual([]);
    expect(await visit(page, AUTH_SITE_PATHS.admin)).toBe(AUTH_SITE_PATHS.admin);
    expect(await page.evaluate((name) => window.localStorage.getItem(name) !== null, AUTH_SITE_LOCAL_STORAGE_ITEM)).toBe(true);
    await factory.closePassiveContext(context);

    expect(site.requests.filter(({ path }) => path === AUTH_SITE_PATHS.admin))
      .toEqual([expect.objectContaining({ site: 'A', method: 'GET', authenticated: true, cookieNames: [AUTH_SITE_SESSION_COOKIE] })]);
    expect(factory.authenticatedStateReadFailureCount()).toBe(0);
  });

  it('keeps the factory without the authentication unchanged (no state, redirected to the login page)', async () => {
    await startSite();
    const factory = factoryWith();

    const { context, page } = await open(factory, DESKTOP);
    expect(await visit(page, AUTH_SITE_PATHS.admin)).toBe(AUTH_SITE_PATHS.login);
    await factory.closePassiveContext(context);

    expect(site.requests.every(({ cookieNames }) => cookieNames.length === 0)).toBe(true);
    expect(factory.authenticatedStateReadFailureCount()).toBe(0);
  });

  it('keeps the authentication in every later Context on a rotating server (the Page Auditor order after DEF-191)', async () => {
    await startSite({ rotate: true });
    const { state } = authenticatedStateFor(site);
    const factory = factoryWith(authenticationFor(state));
    const finalPaths: string[] = [];

    // Page Auditor の順（DEF-191 の後）: Desktop を閉じてから、幅の走査の Context を順に開け閉めし、その後に Mobile を作る。これを 2 ページ分。
    for (let pageIndex = 0; pageIndex < 2; pageIndex += 1) {
      const desktop = await open(factory, DESKTOP);
      finalPaths.push(await visit(desktop.page, AUTH_SITE_PATHS.admin));
      await factory.closePassiveContext(desktop.context);
      for (let index = 0; index < NESTED_STRESS_CONTEXTS; index += 1) {
        const stress = await open(factory, STRESS);
        finalPaths.push(await visit(stress.page, AUTH_SITE_PATHS.admin));
        await factory.closePassiveContext(stress.context);
      }
      const mobile = await open(factory, MOBILE);
      finalPaths.push(await visit(mobile.page, AUTH_SITE_PATHS.adminSecond));
      await factory.closePassiveContext(mobile.context);
    }

    const expectedPerPage = [AUTH_SITE_PATHS.admin, ...Array.from({ length: NESTED_STRESS_CONTEXTS }, () => AUTH_SITE_PATHS.admin), AUTH_SITE_PATHS.adminSecond];
    expect(finalPaths).toEqual([...expectedPerPage, ...expectedPerPage]);
    expect(site.requests.filter(({ path }) => path.startsWith(AUTH_SITE_PATHS.login))).toEqual([]);
    expect(factory.authenticatedStateReadFailureCount()).toBe(0);
  });

  // DEF-191（設計書 3.1 の 2）: 受け継ぐのは、最後に閉じた Context の状態（作った順の世代でなく、閉じた順）。先に作った A を開いたまま B を作り（B は A の
  // 生きている状態を受け継ぐ）、その後に A が回した値（前の値は無効）を、A を最後に閉じたので、次の Context が受け継ぐ。直す前は、A の世代が B より古いので
  // A の状態を捨て、無効になった値が次へ渡ってログインの画面へ移った。
  it('passes the state of the Context closed last, not of the Context created last (DEF-191)', async () => {
    await startSite({ rotate: true });
    const { state } = authenticatedStateFor(site);
    const factory = factoryWith(authenticationFor(state));

    const first = await open(factory, DESKTOP);
    expect(await visit(first.page, AUTH_SITE_PATHS.admin)).toBe(AUTH_SITE_PATHS.admin);
    const second = await open(factory, STRESS);
    // A がもう一度読む（サーバが値を回し、B が受け継いだ値は無効になる）。B は読まない。
    expect(await visit(first.page, AUTH_SITE_PATHS.admin)).toBe(AUTH_SITE_PATHS.admin);
    await factory.closePassiveContext(second.context);
    await factory.closePassiveContext(first.context);

    const next = await open(factory, MOBILE);
    expect(await visit(next.page, AUTH_SITE_PATHS.adminSecond)).toBe(AUTH_SITE_PATHS.adminSecond);
    await factory.closePassiveContext(next.context);
    expect(site.requests.filter(({ path }) => path.startsWith(AUTH_SITE_PATHS.login))).toEqual([]);
    expect(factory.authenticatedStateReadFailureCount()).toBe(0);
  });

  it('sends nothing to the server while it reads the state of a live Context (a page with an iframe of another Origin)', async () => {
    await startSite({ rotate: true });
    const { state } = authenticatedStateFor(site);
    const factory = factoryWith(authenticationFor(state));

    const desktop = await open(factory, DESKTOP);
    expect(await visit(desktop.page, AUTH_SITE_PATHS.adminFrames)).toBe(AUTH_SITE_PATHS.adminFrames);
    await desktop.page.waitForLoadState('load');
    const before = site.requests.length;
    // 生きている Desktop の状態（別の Origin の iframe の Origin を含む）を読んでから、新しい Context を作る。page はまだ読み込まない。
    const nested = await open(factory, STRESS);
    expect(site.requests.slice(before)).toEqual([]);
    expect(await visit(nested.page, AUTH_SITE_PATHS.admin)).toBe(AUTH_SITE_PATHS.admin);
    const beforeClose = site.requests.length;
    await factory.closePassiveContext(nested.context);
    await factory.closePassiveContext(desktop.context);
    expect(site.requests.slice(beforeClose)).toEqual([]);
    expect(factory.authenticatedStateReadFailureCount()).toBe(0);
    // 状態を読む処理（別の Origin の localStorage を読む、通信をしない隠れた page を含む）は、Guard の違反を起こさない。
    expect(factory.getSafetyLedger(desktop.context).snapshot().invariantViolationCount).toBe(0);
    expect(factory.getSafetyLedger(nested.context).snapshot().invariantViolationCount).toBe(0);
  });

  // FIN-1（SD-2 の 2.4）: 「監査の除外を Guard に渡し、ログアウトの main frame の移動を Guard が止める」場面は消した。main frame の移動は読む範囲の外でも
  // Guard が止めない。BeakSight の巡回がログアウトの URL へ移らないことは、単体 `authenticated-run.test.ts`（除外の path と語）と、操作の前の判定
  // （`destructive-action-guard.test.ts`）が確かめる。

  it('keeps the previous state and counts the failure when the state of a closing Context cannot be taken', async () => {
    await startSite();
    const { state } = authenticatedStateFor(site);
    let filterCalls = 0;
    const factory = factoryWith(authenticationFor(state, (value) => {
      filterCalls += 1;
      // 1 回目（最初の状態）は絞る。2 回目（閉じる Context の状態）は、取り出しの失敗として投げる。
      if (filterCalls === 2) throw new Error('state could not be filtered');
      return filterAuthenticatedState(value, [site.originA]);
    }));

    const first = await open(factory, DESKTOP);
    expect(await visit(first.page, AUTH_SITE_PATHS.admin)).toBe(AUTH_SITE_PATHS.admin);
    await factory.closePassiveContext(first.context);
    expect(factory.authenticatedStateReadFailureCount()).toBe(1);

    const second = await open(factory, DESKTOP);
    expect(await visit(second.page, AUTH_SITE_PATHS.admin)).toBe(AUTH_SITE_PATHS.admin);
    await factory.closePassiveContext(second.context);
    expect(factory.authenticatedStateReadFailureCount()).toBe(1);
  });

  // FM2d（設計書 `2026-10-19-beaksight-fewer-manual-steps-design.md` 3A.1）: まとめて実行の次の段へ渡す、最新の状態を読むだけの口。
  it('returns the latest (rotated) state, which a new factory can use, and returns null without the authentication', async () => {
    await startSite({ rotate: true });
    const { state } = authenticatedStateFor(site);
    const factory = factoryWith(authenticationFor(state));
    expect(factory.latestAuthenticatedState()).toEqual(filterAuthenticatedState(state, [site.originA]));
    const first = await open(factory, DESKTOP);
    expect(await visit(first.page, AUTH_SITE_PATHS.admin)).toBe(AUTH_SITE_PATHS.admin);
    await factory.closePassiveContext(first.context);
    const latest = factory.latestAuthenticatedState();
    expect(latest).not.toBeNull();
    expect(Object.isFrozen(latest)).toBe(true);
    // 回転した後の状態（最初の状態は無効になった）。
    expect(latest).not.toEqual(filterAuthenticatedState(state, [site.originA]));
    const before = site.requests.length;
    // 読むだけの口は、サイトへ要求を出さない。
    factory.latestAuthenticatedState();
    expect(site.requests.length).toBe(before);

    const next = factoryWith(authenticationFor(latest ?? state));
    const second = await open(next, DESKTOP);
    expect(await visit(second.page, AUTH_SITE_PATHS.admin)).toBe(AUTH_SITE_PATHS.admin);
    await next.closePassiveContext(second.context);
    expect(site.requests.filter(({ path }) => path.startsWith(AUTH_SITE_PATHS.login))).toEqual([]);

    expect(factoryWith().latestAuthenticatedState()).toBeNull();
  });

  // LU-SFIX2-B（LU-SREV2 の Important-1）: 書き込みの段の Context の後の Context（照合の READ）には、書き込みの段の Context を作る直前に受け継いでいた
  // localStorage と IndexedDB を渡す（書き込みの段でページが書いた値を受け継がない）。Cookie はサーバが決める値なので、書き込みの段の後の値を受け継ぐ
  // （回転するサーバでは、前の世代の Cookie は無効になっているため）。localStorage に持つ token（前の世代の値）で、後の Context もログインしたまま読める。
  it('passes the pre-write localStorage and the post-write cookie to the Context after the write stage on a rotating server (LU-SFIX2-B)', async () => {
    await startSite({ rotate: true });
    const { state } = authenticatedStateFor(site);
    const factory = factoryWith(authenticationFor(state));
    const tokenBefore = state.origins.find(({ origin }) => origin === site.originA)?.localStorage[0]?.value;
    const draftKey = 'lu_sfix2b_draft';

    const writeStage = await factory.createWriteStageContext(DESKTOP, {
      expectation: {
        request: { origin: site.originA, path: '/__write', enctype: 'application/x-www-form-urlencoded' },
        submittedFields: [{ name: 'name', value: 'v' }],
        passthroughFieldNames: [],
        emptyFileFieldNames: [],
      },
      monitor: new WriteStageMonitor(),
    });
    const writePage = await factory.createPassivePage(writeStage);
    // 書き込みの段で管理画面を読む（回転するサーバは Cookie を替え、前の値を無効にする）。ページは token を書き換え、下書きを保存する。
    expect(await visit(writePage, AUTH_SITE_PATHS.admin)).toBe(AUTH_SITE_PATHS.admin);
    await writePage.evaluate(([tokenName, draft]) => {
      window.localStorage.setItem(tokenName, 'rewritten-by-the-page');
      window.localStorage.setItem(draft, 'saved-by-the-page');
    }, [AUTH_SITE_LOCAL_STORAGE_ITEM, draftKey] as const);
    await factory.closePassiveContext(writeStage);

    const verification = await open(factory, DESKTOP);
    expect(await visit(verification.page, AUTH_SITE_PATHS.admin)).toBe(AUTH_SITE_PATHS.admin);
    const storage = await verification.page.evaluate(([tokenName, draft]) => ({
      token: window.localStorage.getItem(tokenName), draft: window.localStorage.getItem(draft),
    }), [AUTH_SITE_LOCAL_STORAGE_ITEM, draftKey] as const);
    await factory.closePassiveContext(verification.context);

    expect(storage).toEqual({ token: tokenBefore, draft: null });
    expect(site.requests.filter(({ path }) => path.startsWith(AUTH_SITE_PATHS.login))).toEqual([]);
    expect(factory.authenticatedStateReadFailureCount()).toBe(0);
  });

  // LU-SFIX3-B（LU-SREV3 の Important-1）: 書き込みの段の後の Context に渡す cookie は、HttpOnly のものと、サーバの `Set-Cookie` で来た値のものだけを後の値に
  // する。ページのスクリプトが書いた cookie（`document.cookie`）は渡さない。HttpOnly でないログインの cookie をサーバが回す形でも、`Set-Cookie` で来た値を
  // 受け継ぐので、後の Context はログインしたまま読める。
  it('passes the server-set non-HttpOnly cookie and drops the cookie that the page wrote, after the write stage (LU-SFIX3-B)', async () => {
    await startSite({ rotate: true, rotateReadable: true });
    const { state } = authenticatedStateFor(site);
    const readable = { ...state, cookies: state.cookies.map((cookie) => ({ ...cookie, httpOnly: false })) };
    const factory = factoryWith(authenticationFor(readable));
    const pageCookie = 'lu_sfix3b_draft';

    const writeStage = await factory.createWriteStageContext(DESKTOP, {
      expectation: {
        request: { origin: site.originA, path: '/__write', enctype: 'application/x-www-form-urlencoded' },
        submittedFields: [{ name: 'name', value: 'v' }],
        passthroughFieldNames: [],
        emptyFileFieldNames: [],
      },
      monitor: new WriteStageMonitor(),
    });
    const writePage = await factory.createPassivePage(writeStage);
    // 回転するサーバは、HttpOnly でない新しいセッションの cookie を `Set-Cookie` で返し、前の値を無効にする。ページは、ほかの cookie を書く。
    expect(await visit(writePage, AUTH_SITE_PATHS.admin)).toBe(AUTH_SITE_PATHS.admin);
    await writePage.evaluate((name) => {
      document.cookie = `${name}=saved-by-the-page; path=/; max-age=600`;
    }, pageCookie);
    expect((await writeStage.cookies()).map(({ name }) => name).sort()).toEqual([AUTH_SITE_SESSION_COOKIE, pageCookie].sort());
    await factory.closePassiveContext(writeStage);

    const verification = await open(factory, DESKTOP);
    expect((await verification.context.cookies()).map(({ name }) => name)).toEqual([AUTH_SITE_SESSION_COOKIE]);
    expect(await visit(verification.page, AUTH_SITE_PATHS.admin)).toBe(AUTH_SITE_PATHS.admin);
    await factory.closePassiveContext(verification.context);

    expect(site.requests.filter(({ path }) => path.startsWith(AUTH_SITE_PATHS.login))).toEqual([]);
    expect(factory.authenticatedStateReadFailureCount()).toBe(0);
  });

  // LU-SFIX5（LU-SREV4 の Important-1）: 書き込みのジョブの factory（`writeJob`）は、書き込みの段の Context でない Passive の Context（送る前の READ など）の後でも、
  // ページのスクリプトが書いた localStorage と cookie を次の Context へ渡さない（ジョブの始まりの世代のまま）。HttpOnly のログインの cookie はサーバが回した後の値を
  // 受け継ぐので、次の Context もログインしたまま読める。書き込みのジョブでない factory は、今のとおりページが書いた値も受け継ぐ（対照）。
  it.each<readonly [string, boolean]>([['a write job factory', true], ['an audit factory (the control)', false]])(
    'passes or drops the values that the page wrote in a passive Context, with %s (LU-SFIX5)',
    async (_label, writeJob) => {
      await startSite({ rotate: true });
      const { state } = authenticatedStateFor(site);
      const factory = factoryWith(authenticationFor(state), writeJob);
      const tokenBefore = state.origins.find(({ origin }) => origin === site.originA)?.localStorage[0]?.value;
      const draftKey = 'lu_sfix5_first_open';
      const pageCookie = 'lu_sfix5_page_cookie';

      const first = await open(factory, DESKTOP);
      expect(await visit(first.page, AUTH_SITE_PATHS.admin)).toBe(AUTH_SITE_PATHS.admin);
      await first.page.evaluate(([tokenName, draft, cookie]) => {
        window.localStorage.setItem(tokenName, 'rewritten-by-the-page');
        window.localStorage.setItem(draft, 'saved-by-the-page');
        document.cookie = `${cookie}=saved-by-the-page; path=/; max-age=600`;
      }, [AUTH_SITE_LOCAL_STORAGE_ITEM, draftKey, pageCookie] as const);
      await factory.closePassiveContext(first.context);

      const second = await open(factory, DESKTOP);
      try {
        expect(await visit(second.page, AUTH_SITE_PATHS.admin)).toBe(AUTH_SITE_PATHS.admin);
        const storage = await second.page.evaluate(([tokenName, draft]) => ({
          token: window.localStorage.getItem(tokenName), draft: window.localStorage.getItem(draft),
        }), [AUTH_SITE_LOCAL_STORAGE_ITEM, draftKey] as const);
        const cookieNames = (await second.context.cookies()).map(({ name }) => name);
        expect(storage).toEqual(writeJob ? { token: tokenBefore, draft: null } : { token: 'rewritten-by-the-page', draft: 'saved-by-the-page' });
        expect(cookieNames.includes(pageCookie)).toBe(!writeJob);
        expect(cookieNames).toContain(AUTH_SITE_SESSION_COOKIE);
      } finally {
        await factory.closePassiveContext(second.context);
      }
      expect(site.requests.filter(({ path }) => path.startsWith(AUTH_SITE_PATHS.login))).toEqual([]);
      expect(factory.authenticatedStateReadFailureCount()).toBe(0);
    },
  );

  // LU-SFIX5: 書き込みのジョブの factory でも、HttpOnly でないログインの cookie をサーバが `Set-Cookie` で回す形は、来た値を受け継ぐ（次の Context もログインしたまま）。
  it('passes the server-set non-HttpOnly cookie after a passive Context of a write job factory (LU-SFIX5)', async () => {
    await startSite({ rotate: true, rotateReadable: true });
    const { state } = authenticatedStateFor(site);
    const readable = { ...state, cookies: state.cookies.map((cookie) => ({ ...cookie, httpOnly: false })) };
    const factory = factoryWith(authenticationFor(readable), true);
    const first = await open(factory, DESKTOP);
    expect(await visit(first.page, AUTH_SITE_PATHS.admin)).toBe(AUTH_SITE_PATHS.admin);
    await factory.closePassiveContext(first.context);
    const second = await open(factory, DESKTOP);
    try {
      expect(await visit(second.page, AUTH_SITE_PATHS.admin)).toBe(AUTH_SITE_PATHS.admin);
    } finally {
      await factory.closePassiveContext(second.context);
    }
    expect(site.requests.filter(({ path }) => path.startsWith(AUTH_SITE_PATHS.login))).toEqual([]);
    expect(factory.authenticatedStateReadFailureCount()).toBe(0);
  });
});
