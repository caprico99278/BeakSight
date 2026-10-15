// T25c（Task 25 の設計書 `2026-10-10-beaksight-task-25-manual-login-session-design.md` 4.3 と、変更履歴の 2026-10-10 の Blocker の行）:
// `BrowserContextFactory` の、認証済みの状態の注入の入口と、世代つきの受け継ぎ。本物の factory と Guard と、127.0.0.1 の fixture のサーバ
// （`tests/helpers/authenticated-site-fixture.ts`）で確かめる。Chromium は headless だけ。テストの既定（headless shell）と、CLI の起動の設定
// （`launchCliChromium`）の両方で確かめる。
// - 注入: 指定した状態（絞り込んだもの）で、管理画面を読める。Context を作るだけでは、サーバに要求を送らない。指定のない factory は今のまま
//   （状態を持たない）。
// - 世代つきの受け継ぎ: Desktop の Context を開いたまま、幅の走査の Context を順に開け閉めし、Desktop を閉じてから Mobile を作る（Page Auditor の
//   順）。回転するサーバでも、すべての Context で認証が保たれる。生きている Context の状態を読む間に、サーバへの要求はない（別の Origin の
//   iframe を含むページ）。
// - 別の Origin の Cookie（調査の E7）: 絞り込んだ状態では、別の Origin の部品の要求に、状態の Cookie が付かない（対照: 絞らなければ付く）。
// - Guard に監査の段の除外の指定が渡る（ログアウトは届かない）。
// - 状態を取り出せなかったときは、前の状態のまま進み、その回数を数える（値は記録しない）。
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BrowserContextFactory,
  type AuthenticatedContextOptions,
  type AuthenticatedStorageState,
} from '../../src/browser/context-factory.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/control/auth/auth-setup-contracts.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import type { Viewport } from '../../src/config/types.js';
import type { AuditExclusionPolicy } from '../../src/safety/request-policy.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import {
  AUTH_SITE_LOCAL_STORAGE_ITEM,
  AUTH_SITE_OTHER_ORIGIN_COOKIE,
  AUTH_SITE_PATHS,
  AUTH_SITE_SESSION_COOKIE,
  authenticatedStateFor,
  startAuthenticatedSite,
  type AuthenticatedSite,
  type AuthenticatedSiteOptions,
} from '../helpers/authenticated-site-fixture.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { createTestConfig, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

const DESKTOP: Viewport = Object.freeze({ width: 1280, height: 800 });
const STRESS: Viewport = Object.freeze({ width: 600, height: 800 });
const MOBILE: Viewport = Object.freeze({ width: 390, height: 844 });
/** 幅の走査の幅の数（Desktop の Context の中で、順に開け閉めする Context の数）。 */
const NESTED_STRESS_CONTEXTS = 2;

const LAUNCHERS = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI launch settings', () => launchCliChromium()],
] as const;

/** 監査の段の除外（ログアウトを除外のパスに、管理画面を読む範囲に、危険な語は既定の一覧）。 */
const EXCLUSIONS: AuditExclusionPolicy = Object.freeze({
  excludedPathPrefixes: Object.freeze([AUTH_SITE_PATHS.adminLogout]),
  auditPathPrefixes: Object.freeze([AUTH_SITE_PATHS.admin]),
  dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS,
});

describe.each(LAUNCHERS)('T25c: authenticated state injection and inheritance in BrowserContextFactory (%s)', (_name, launch) => {
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

  function factoryWith(authentication?: AuthenticatedContextOptions): BrowserContextFactory {
    const factory = new BrowserContextFactory(
      browser,
      createTestConfig(site.originA, AUTH_SITE_PATHS.admin),
      () => new SafetyLedger(),
      { ...TEST_FACTORY_OPTIONS, ...(authentication === undefined ? {} : { authentication }) },
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

  /** `path` を読み、main frame の最後の path を返す。 */
  async function visit(page: Page, path: string): Promise<string> {
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

  it('keeps the authentication in every nested and later Context on a rotating server (generation inheritance)', async () => {
    await startSite({ rotate: true });
    const { state } = authenticatedStateFor(site);
    const factory = factoryWith(authenticationFor(state));
    const finalPaths: string[] = [];

    // Page Auditor の順: Desktop を開いたまま、幅の走査の Context を順に開け閉めし、Desktop を閉じてから Mobile を作る。これを 2 ページ分。
    for (let pageIndex = 0; pageIndex < 2; pageIndex += 1) {
      const desktop = await open(factory, DESKTOP);
      finalPaths.push(await visit(desktop.page, AUTH_SITE_PATHS.admin));
      for (let index = 0; index < NESTED_STRESS_CONTEXTS; index += 1) {
        const stress = await open(factory, STRESS);
        finalPaths.push(await visit(stress.page, AUTH_SITE_PATHS.admin));
        await factory.closePassiveContext(stress.context);
      }
      await factory.closePassiveContext(desktop.context);
      const mobile = await open(factory, MOBILE);
      finalPaths.push(await visit(mobile.page, AUTH_SITE_PATHS.adminSecond));
      await factory.closePassiveContext(mobile.context);
    }

    const expectedPerPage = [AUTH_SITE_PATHS.admin, ...Array.from({ length: NESTED_STRESS_CONTEXTS }, () => AUTH_SITE_PATHS.admin), AUTH_SITE_PATHS.adminSecond];
    expect(finalPaths).toEqual([...expectedPerPage, ...expectedPerPage]);
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

  it('does not send the other Origin cookie of the state to the other Origin when the state is filtered (E7)', async () => {
    await startSite();
    const { state } = authenticatedStateFor(site);
    const filtered = factoryWith(authenticationFor(state));
    const desktop = await open(filtered, DESKTOP);
    expect(await visit(desktop.page, AUTH_SITE_PATHS.adminFrames)).toBe(AUTH_SITE_PATHS.adminFrames);
    await filtered.closePassiveContext(desktop.context);
    const otherOriginRequests = site.requests.filter(({ site: origin }) => origin === 'B');
    expect(otherOriginRequests.map(({ path }) => path).sort()).toEqual([AUTH_SITE_PATHS.otherFrame, AUTH_SITE_PATHS.otherPixel]);
    expect(otherOriginRequests.every(({ cookieNames }) => cookieNames.length === 0)).toBe(true);

    // 対照: 絞らない状態では、別の Origin の部品の要求に、その Cookie が付く（このテストが漏れを見分けられることの確かめ）。
    const before = site.requests.length;
    const unfiltered = factoryWith(authenticationFor(authenticatedStateFor(site).state, (value) => value));
    const control = await open(unfiltered, DESKTOP);
    expect(await visit(control.page, AUTH_SITE_PATHS.adminFrames)).toBe(AUTH_SITE_PATHS.adminFrames);
    await unfiltered.closePassiveContext(control.context);
    expect(site.requests.slice(before).filter(({ site: origin }) => origin === 'B').some(({ cookieNames }) =>
      cookieNames.includes(AUTH_SITE_OTHER_ORIGIN_COOKIE))).toBe(true);
  });

  it('passes the audit exclusions to the Guard of the authenticated Context (the logout never reaches the server)', async () => {
    await startSite();
    const { state } = authenticatedStateFor(site);
    const factory = factoryWith(authenticationFor(state));
    const { context, page } = await open(factory, DESKTOP);
    const ledger = factory.getSafetyLedger(context);

    await page.goto(`${site.originA}${AUTH_SITE_PATHS.adminLogout}`).catch(() => undefined);
    await factory.closePassiveContext(context);
    // セッションは壊れていない（次の Context でも管理画面を読める）。
    const next = await open(factory, DESKTOP);
    expect(await visit(next.page, AUTH_SITE_PATHS.admin)).toBe(AUTH_SITE_PATHS.admin);
    await factory.closePassiveContext(next.context);

    expect(site.requests.filter(({ path }) => path.startsWith(AUTH_SITE_PATHS.adminLogout))).toEqual([]);
    const snapshot = ledger.snapshot();
    expect(snapshot.blockedAuditExclusions?.count).toBe(1);
    expect(snapshot.invariantViolationCount).toBe(0);
  });

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
});
