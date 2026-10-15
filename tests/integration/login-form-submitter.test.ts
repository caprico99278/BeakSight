// T26d-1（Task 26 の設計書 4.4 の 3・4、調査 E5・E7）: ログインのフォームへの入力の部品（`src/browser/login-form-submitter.ts`）を、直接呼んで
// 確かめる。本物の factory のログインの段の Context（Guard の回数の上限 1）と、127.0.0.1 の fixture のサーバ（`automated-login-fixture.ts`）を使う。
// Chromium は headless だけ（テストの既定と、CLI の起動の設定の両方）。
// - フォームを読むだけの確かめ: 形ごとの理由のコード（0 と 2 以上の要素、ユーザー名の欄、パスワードの欄、送信のボタン、別のフォーム、GET、
//   `formmethod`、別の Origin の action、`formaction`、`target`）。確かめは値を入れず、サーバに届くのは画面の GET だけ。DOM clobbering を受けない。
// - `fill` の失敗（入力できない欄）は、情報を持たない `{ ok: false }` で、目印が出ない（対照: Playwright の誤りの文そのものには、値が入る）。
// - 確かめが通った後の入力と送信で、サーバに届く GET と HEAD 以外の要求は、許した送信先への POST 1 回だけで、その本文にだけ目印がある。
import { randomBytes } from 'node:crypto';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import {
  LOGIN_FORM_INVALID_REASONS,
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
const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);
const OUTCOME = 'success';

const wait = (ms: number): Promise<void> => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
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
  ['password-text', 'PASSWORD_FIELD_INVALID'],
  ['username-textarea', 'USERNAME_FIELD_INVALID'],
  ['duplicate', 'SELECTOR_NOT_UNIQUE'],
  ['button-type-button', 'SUBMIT_BUTTON_INVALID'],
  ['target-blank', 'FORM_TARGET_NOT_SELF'],
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
