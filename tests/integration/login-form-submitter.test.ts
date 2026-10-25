// T26d-1（Task 26 の設計書 4.4 の 3・4、調査 E5・E7）: ログインのフォームへの入力の部品（`src/browser/login-form-submitter.ts`）を、直接呼んで
// 確かめる。本物の factory のログインの段の Context（Guard の回数の上限 1）と、127.0.0.1 の fixture のサーバ（`automated-login-fixture.ts`）を使う。
// Chromium は headless だけ（テストの既定と、CLI の起動の設定の両方）。
// - フォームを読むだけの確かめ: 形ごとの理由のコード（0 と 2 以上の要素、ユーザー名の欄、パスワードの欄、送信のボタン、別のフォーム、GET、
//   `formmethod`、別の Origin の action、`formaction`、`target`）。確かめは値を入れず、サーバに届くのは画面の GET だけ。DOM clobbering を受けない。
// - `fill` の失敗（入力できない欄）は、情報を持たない `{ ok: false }` で、目印が出ない（対照: Playwright の誤りの文そのものには、値が入る）。
// - 確かめが通った後の入力と送信で、サーバに届く GET と HEAD 以外の要求は、許した送信先への POST 1 回だけで、その本文にだけ目印がある。
// - T36a（Task 36 の設計書 3.2）: スクリプトで送るログイン（`submission: 'SCRIPT_REQUEST'`）では、form の `action` と `method` を確かめない（スクリプトが
//   送るため）。3 つの要素がちょうど 1 つずつ、欄の種類、同じ form の中、送信の先が同じ page は今どおり。form の要素がない画面は止める（設計者の既定）。
//   `startSpaAuthSite` の `/auth`（action も method もない form）は、スクリプトで送るログインなら通り、フォームの送信のログインなら今どおり止まる。
import { randomBytes } from 'node:crypto';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import {
  LOGIN_FORM_INVALID_REASONS,
  LOGIN_FORM_SUBMISSIONS,
  clickLoginSubmit,
  fillLoginForm,
  inspectLoginForm,
  type LoginFormInvalidReason,
  type LoginFormTarget,
} from '../../src/browser/login-form-submitter.js';
import { canonicalPassiveAllowedOrigins, isLoginEndpointPost } from '../../src/safety/request-policy.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { loginStageLocator } from '../../src/worker/login-stage-checks.js';
import {
  AUTOMATED_LOGIN_FIXTURE_SELECTORS,
  startAutomatedLoginFixture,
  type AutomatedLoginFixture,
  type AutomatedLoginFormVariant,
} from '../helpers/automated-login-fixture.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import {
  SPA_APP_PATHS,
  SPA_LOGIN_FIELDS,
  SPA_LOGIN_LAYOUTS,
  startSpaAuthSite,
  type SpaAuthSite,
  type SpaLoginLayout,
} from '../helpers/spa-auth-site-fixture.js';
import { createTestConfig } from '../helpers/test-config.js';

const LAUNCHERS = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI launch settings', () => launchCliChromium()],
] as const;
/** 入力できない欄で、`fill` が待つ時間（ms）。 */
const SHORT_STEP_TIMEOUT_MS = 500;
const NAVIGATION_SETTLE_TIMEOUT_MS = 10_000;
/** 読み込みの後に、遅れて届く要求を待つ時間（ms）。 */
const QUIET_PERIOD_MS = 300;
const OUTCOME = 'success';
const marker = (prefix: string): string => `${prefix}${randomBytes(12).toString('hex')}`;

/** 形ごとの、フォームを読むだけの確かめの結果（`null` は通る）。 */
const INSPECTIONS: readonly (readonly [AutomatedLoginFormVariant, LoginFormInvalidReason | null])[] = [
  ['standard', null],
  ['button-outside', null],
  ['clobbered', null],
  ['scripted', null],
  ['disabled-user', null],
  ['switch-to-get', null],
  ['get', 'METHOD_NOT_POST'],
  ['formmethod-get', 'METHOD_NOT_POST'],
  ['other-origin', 'ACTION_NOT_ALLOWED'],
  ['formaction', 'ACTION_NOT_ALLOWED'],
  ['split', 'NOT_SAME_FORM'],
  ['no-form', 'NOT_SAME_FORM'],
  ['password-text', 'PASSWORD_FIELD_INVALID'],
  ['username-textarea', 'USERNAME_FIELD_INVALID'],
  ['duplicate', 'SELECTOR_NOT_UNIQUE'],
  ['button-type-button', 'SUBMIT_BUTTON_INVALID'],
  ['target-blank', 'FORM_TARGET_NOT_SELF'],
];

/**
 * T36a: スクリプトで送るログインの確かめの結果（`null` は通る）。action と method の形（GET、`formmethod`、別の Origin の action、`formaction`）は
 * 通り、ほかの理由は今どおり。
 */
const SCRIPT_INSPECTIONS: readonly (readonly [AutomatedLoginFormVariant, LoginFormInvalidReason | null])[] = [
  ['standard', null],
  ['button-outside', null],
  ['clobbered', null],
  ['get', null],
  ['formmethod-get', null],
  ['other-origin', null],
  ['formaction', null],
  ['split', 'NOT_SAME_FORM'],
  // T36R-fix（ユーザーの判断。意図して直した期待）: 3 つが form の外の画面は、スクリプトで送るログインなら通る（T36a は止めていた）。
  ['no-form', null],
  ['password-text', 'PASSWORD_FIELD_INVALID'],
  ['username-textarea', 'USERNAME_FIELD_INVALID'],
  ['duplicate', 'SELECTOR_NOT_UNIQUE'],
  ['button-type-button', 'SUBMIT_BUTTON_INVALID'],
  ['target-blank', 'FORM_TARGET_NOT_SELF'],
];

/**
 * T36R-fix（ユーザーの判断「ログインの画面に form の要素がなければ止めるのでは監査が開始できない」）: スクリプトで送るログインの、form の要素のない
 * ログインの画面（`startSpaAuthSite` の `loginLayout`）の確かめの結果（`null` は通る）。3 つがすべて form の外なら、それぞれちょうど 1 つ、見えている、
 * 欄は編集できる、送信の要素は押せる（`button`・`input[type=submit|button]`・`role=button`。`href` のある `a` は止める）ときに通る。一部だけ form の中、
 * 別々の form は `NOT_SAME_FORM`。
 */
const FORMLESS_INSPECTIONS: readonly (readonly [SpaLoginLayout, LoginFormInvalidReason | null])[] = [
  ['formless', null],
  ['roleButton', null],
  ['partialForm', 'NOT_SAME_FORM'],
  ['separateForms', 'NOT_SAME_FORM'],
  ['linkSubmit', 'SUBMIT_BUTTON_INVALID'],
  // T36R2-fix（設計者の判断: 止める）: 送信の要素そのものに `href` がなくても、祖先に `href` のある `a` があれば止める（押すとページが移りうる）。
  ['linkWrappedSubmit', 'SUBMIT_BUTTON_INVALID'],
  ['duplicateFields', 'SELECTOR_NOT_UNIQUE'],
  ['hiddenPassword', 'PASSWORD_FIELD_INVALID'],
  ['readonlyUsername', 'USERNAME_FIELD_INVALID'],
  ['disabledSubmit', 'SUBMIT_BUTTON_INVALID'],
];

describe.each(LAUNCHERS)('T26d-1: the login form submitter (%s)', (_name, launch) => {
  const username = marker('u');
  const password = marker('p');
  let browser: Browser;
  let fixture: AutomatedLoginFixture;
  const factories: BrowserContextFactory[] = [];

  beforeAll(async () => {
    browser = await launch();
    fixture = await startAutomatedLoginFixture({ username, password });
  });

  afterEach(async () => {
    await Promise.all(factories.splice(0).map((factory) => factory.close().catch(() => undefined)));
  });

  afterAll(async () => {
    await fixture?.close();
    await browser?.close();
  });

  /** ログインの段の Context（回数の上限 1）で、ログインの画面を開く。 */
  const openForm = async (variant: AutomatedLoginFormVariant): Promise<{ page: Page; context: BrowserContext; target: LoginFormTarget }> => {
    const config = createTestConfig(fixture.originA, '/', {});
    const factory = new BrowserContextFactory(browser, { ...config, site: { ...config.site, allowedOrigins: [fixture.originA, fixture.originB] } },
      () => new SafetyLedger());
    factories.push(factory);
    const loginPostEndpoints = [{ origin: fixture.originA, path: fixture.authPath(OUTCOME) }];
    const context = await factory.createLoginStageContext(config.viewports.primaryDesktop, { loginPostEndpoints, maxLoginPosts: 1 });
    const page = await factory.createPassivePage(context);
    await page.goto(fixture.formUrl(variant, OUTCOME));
    const allowedOrigins = canonicalPassiveAllowedOrigins(new Set([fixture.originA, fixture.originB]));
    const target: LoginFormTarget = {
      username: loginStageLocator(page, AUTOMATED_LOGIN_FIXTURE_SELECTORS.username),
      password: loginStageLocator(page, AUTOMATED_LOGIN_FIXTURE_SELECTORS.password),
      submit: loginStageLocator(page, AUTOMATED_LOGIN_FIXTURE_SELECTORS.submit),
      // T32j-4: 事前の確かめは、同じセレクタで isolated world の中で探し直す。
      selectors: AUTOMATED_LOGIN_FIXTURE_SELECTORS,
      isAllowedAction: (actionUrl) => isLoginEndpointPost(actionUrl, allowedOrigins, loginPostEndpoints),
    };
    return { page, context, target };
  };

  const nonReadRequestsSince = (start: number) => fixture.requests.slice(start).filter(({ method }) => !READ_METHODS.has(method));
  const expectNoMarkerOutsidePostBodies = (start: number): void => {
    for (const request of fixture.requests.slice(start)) {
      expect(request.path.includes(username) || request.path.includes(password), request.path).toBe(false);
      if (request.method !== 'POST') {
        expect(request.body.includes(username) || request.body.includes(password)).toBe(false);
      }
    }
  };

  it('closes the list of the reasons in the order of the checks', () => {
    expect(LOGIN_FORM_INVALID_REASONS).toEqual([
      'SELECTOR_NOT_UNIQUE', 'USERNAME_FIELD_INVALID', 'PASSWORD_FIELD_INVALID', 'SUBMIT_BUTTON_INVALID', 'NOT_SAME_FORM', 'METHOD_NOT_POST',
      'ACTION_NOT_ALLOWED', 'FORM_TARGET_NOT_SELF', 'FORM_UNREADABLE',
    ]);
  });

  it.each(INSPECTIONS)('inspects the %s form by reading only (reason: %s)', async (variant, reason) => {
    const start = fixture.requests.length;
    const { target } = await openForm(variant);
    expect(await inspectLoginForm(target)).toEqual(reason === null ? { ok: true } : { ok: false, reason });
    await wait(QUIET_PERIOD_MS);
    expect(nonReadRequestsSince(start)).toEqual([]);
    expectNoMarkerOutsidePostBodies(start);
  });

  it('T36a: has the closed list of the submissions, and the form navigation is the default', async () => {
    expect(LOGIN_FORM_SUBMISSIONS).toEqual(['FORM_NAVIGATION', 'SCRIPT_REQUEST']);
    expect(Object.isFrozen(LOGIN_FORM_SUBMISSIONS)).toBe(true);
    const { target } = await openForm('get');
    expect(await inspectLoginForm({ ...target, submission: 'FORM_NAVIGATION' })).toEqual({ ok: false, reason: 'METHOD_NOT_POST' });
    expect(await inspectLoginForm(target)).toEqual({ ok: false, reason: 'METHOD_NOT_POST' });
  });

  it.each(SCRIPT_INSPECTIONS)('T36a: inspects the %s form of a script login without the action and the method (reason: %s)', async (variant, reason) => {
    const start = fixture.requests.length;
    const { target } = await openForm(variant);
    expect(await inspectLoginForm({ ...target, submission: 'SCRIPT_REQUEST' })).toEqual(reason === null ? { ok: true } : { ok: false, reason });
    await wait(QUIET_PERIOD_MS);
    expect(nonReadRequestsSince(start)).toEqual([]);
    expectNoMarkerOutsidePostBodies(start);
  });

  it('rejects selectors that match no element', async () => {
    const { page, target } = await openForm('standard');
    expect(await inspectLoginForm({ ...target, username: loginStageLocator(page, '#missing') })).toEqual({ ok: false, reason: 'SELECTOR_NOT_UNIQUE' });
  });

  it('replaces a fill failure with an outcome that carries nothing (the raw Playwright error would carry the value)', async () => {
    const { target } = await openForm('disabled-user');
    const outcome = await fillLoginForm(target, { username, password }, SHORT_STEP_TIMEOUT_MS);
    expect(outcome).toEqual({ ok: false });
    expect(JSON.stringify(outcome)).not.toContain(username);
    // 対照: 部品を通さない `fill` の誤りの文には、値が入る（調査 E7。置き換えの意味の確かめ）。
    const raw = await target.username.fill(username, { timeout: SHORT_STEP_TIMEOUT_MS }).then(() => '', (error: unknown) => String(error));
    expect(raw).toContain(username);
  });

  it('fills and submits a valid form: the only non-read request is the one allowed POST, and only its body has the values', async () => {
    const start = fixture.requests.length;
    const { page, target } = await openForm('standard');
    expect(await inspectLoginForm(target)).toEqual({ ok: true });
    expect(await fillLoginForm(target, { username, password })).toEqual({ ok: true });
    expect(await inspectLoginForm(target)).toEqual({ ok: true });
    await Promise.all([
      page.waitForURL((url) => url.pathname === '/home', { timeout: NAVIGATION_SETTLE_TIMEOUT_MS }),
      clickLoginSubmit(target).then((outcome) => expect(outcome).toEqual({ ok: true })),
    ]);
    await wait(QUIET_PERIOD_MS);
    const posts = nonReadRequestsSince(start);
    expect(posts.map(({ method, path }) => `${method} ${path}`)).toEqual([`POST ${fixture.authPath(OUTCOME)}`]);
    expect(posts[0]?.body).toContain(username);
    expect(posts[0]?.body).toContain(password);
    expectNoMarkerOutsidePostBodies(start);
  });

  it('notices a form that the page switched to GET after the values were filled (inspected again before the click)', async () => {
    const start = fixture.requests.length;
    const { target } = await openForm('switch-to-get');
    expect(await inspectLoginForm(target)).toEqual({ ok: true });
    expect(await fillLoginForm(target, { username, password })).toEqual({ ok: true });
    expect(await inspectLoginForm(target)).toEqual({ ok: false, reason: 'METHOD_NOT_POST' });
    await wait(QUIET_PERIOD_MS);
    expect(nonReadRequestsSince(start)).toEqual([]);
    expectNoMarkerOutsidePostBodies(start);
  });
});

describe.each(LAUNCHERS)('T36a: the login form of the script login site (%s)', (_name, launch) => {
  let browser: Browser;
  let site: SpaAuthSite;
  const factories: BrowserContextFactory[] = [];

  beforeAll(async () => {
    browser = await launch();
    site = await startSpaAuthSite();
  });

  afterEach(async () => {
    await Promise.all(factories.splice(0).map((factory) => factory.close().catch(() => undefined)));
  });

  afterAll(async () => {
    await site?.close();
    await browser?.close();
  });

  /** ログインの段の Context（読むだけ。フォームの送信先は形のために `/auth` を渡す）で、`/auth`（action も method もない form）を開く。 */
  const openSpaLogin = async (): Promise<LoginFormTarget> => {
    const config = createTestConfig(site.appOrigin, SPA_APP_PATHS.auth, {});
    const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger());
    factories.push(factory);
    const context = await factory.createLoginStageContext(config.viewports.primaryDesktop, {
      loginPostEndpoints: [{ origin: site.appOrigin, path: SPA_APP_PATHS.auth }],
      maxLoginPosts: 1,
    });
    const page = await factory.createPassivePage(context);
    await page.goto(`${site.appOrigin}${SPA_APP_PATHS.auth}`);
    const selectors = { username: SPA_LOGIN_FIELDS.email, password: SPA_LOGIN_FIELDS.password, submit: SPA_LOGIN_FIELDS.submit };
    return {
      username: loginStageLocator(page, selectors.username),
      password: loginStageLocator(page, selectors.password),
      submit: loginStageLocator(page, selectors.submit),
      selectors,
      isAllowedAction: () => false,
    };
  };

  it('passes the form of the script login, and stops the same form as a form navigation login (no action, no method)', async () => {
    const target = await openSpaLogin();
    expect(await inspectLoginForm({ ...target, submission: 'SCRIPT_REQUEST' })).toEqual({ ok: true });
    expect(await inspectLoginForm(target)).toEqual({ ok: false, reason: 'METHOD_NOT_POST' });
    expect(site.requests.filter(({ method }) => !READ_METHODS.has(method))).toEqual([]);
  });
});

describe.each(LAUNCHERS)('T36R-fix: the login page without a form element for the script login (%s)', (_name, launch) => {
  let browser: Browser;
  const sites: SpaAuthSite[] = [];
  const factories: BrowserContextFactory[] = [];

  beforeAll(async () => {
    browser = await launch();
  });

  afterEach(async () => {
    await Promise.all(factories.splice(0).map((factory) => factory.close().catch(() => undefined)));
    await Promise.all(sites.splice(0).map((site) => site.close()));
  });

  afterAll(async () => {
    await browser?.close();
  });

  /** その形のログインの画面を、ログインの段の Context（読むだけ）で開く。 */
  const openLayout = async (loginLayout: SpaLoginLayout): Promise<{ readonly site: SpaAuthSite; readonly target: LoginFormTarget }> => {
    const site = await startSpaAuthSite({ loginLayout });
    sites.push(site);
    const config = createTestConfig(site.appOrigin, SPA_APP_PATHS.auth, {});
    const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger());
    factories.push(factory);
    const context = await factory.createLoginStageContext(config.viewports.primaryDesktop, {
      loginPostEndpoints: [{ origin: site.appOrigin, path: SPA_APP_PATHS.auth }],
      maxLoginPosts: 1,
    });
    const page = await factory.createPassivePage(context);
    await page.goto(`${site.appOrigin}${SPA_APP_PATHS.auth}`);
    const selectors = { username: SPA_LOGIN_FIELDS.email, password: SPA_LOGIN_FIELDS.password, submit: SPA_LOGIN_FIELDS.submit };
    return {
      site,
      target: {
        username: loginStageLocator(page, selectors.username),
        password: loginStageLocator(page, selectors.password),
        submit: loginStageLocator(page, selectors.submit),
        selectors,
        isAllowedAction: () => false,
      },
    };
  };

  it('has a layout for each case of the inspection', () => {
    expect(FORMLESS_INSPECTIONS.map(([layout]) => layout)).toEqual([...SPA_LOGIN_LAYOUTS]);
  });

  it.each(FORMLESS_INSPECTIONS)('inspects the %s layout of a script login by reading only (reason: %s)', async (layout, reason) => {
    const { site, target } = await openLayout(layout);
    expect(await inspectLoginForm({ ...target, submission: 'SCRIPT_REQUEST' })).toEqual(reason === null ? { ok: true } : { ok: false, reason });
    await wait(QUIET_PERIOD_MS);
    expect(site.requests.filter(({ method }) => !READ_METHODS.has(method))).toEqual([]);
  });

  // フォームの送信のログインは今どおり（送信のボタンが `type="button"` の形は、送信のボタンの確かめで止まる。3 つが form の外の形の `NOT_SAME_FORM` は、
  // 上の T26d-1 の `no-form`）。
  it('stops the form-less layouts as a form navigation login, as before', async () => {
    const { target } = await openLayout('formless');
    expect(await inspectLoginForm(target)).toEqual({ ok: false, reason: 'SUBMIT_BUTTON_INVALID' });
    const roleButton = await openLayout('roleButton');
    expect(await inspectLoginForm(roleButton.target)).toEqual({ ok: false, reason: 'SUBMIT_BUTTON_INVALID' });
  });
});
