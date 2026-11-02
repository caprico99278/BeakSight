// OP-1（設計書 `doc/design/2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D1・D2。調べ FV-1 の案 L2）: 手動のログインの段は、頼まれたときだけ、人がログインの
// 画面で入れた ID とパスワードを隔離した世界で読み、ログインに成功し、かつ値が観察した送り先（Guard が通して記録した要求）の要求に入っていたときだけ、受け取った
// 資格情報を結果に付ける。値は、結果の記録（JSON）・文字列・ページの JS に出ない。
// 通す部品は本物（`runLoginStage`、Guard、fixture）。場面はフォームのログインと、SPA のログイン（token の送信先がアプリと別の Origin）。Chromium はテストの既定の
// headless と、CLI の起動の設定の両方。値は出力しない（比べは真偽だけ）。
import type { Browser, Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditConfig } from '../../src/config/types.js';
import { SCRIPT_REQUEST_TRANSPORT, type AuthSetupV3 } from '../../src/control/auth/auth-setup-contracts.js';
import { runLoginStage, type LoginStageResult } from '../../src/worker/authenticated-login.js';
import { CAPTURE_WORLD_NAME, withCapturedLoginCredential } from '../../src/worker/login-credential-capture.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { fastRunConfig } from '../helpers/run-harness.js';
import { AUTH_SITE_LOGIN_FIELDS, AUTH_SITE_PATHS, startAuthenticatedSite } from '../helpers/authenticated-site-fixture.js';
import { SPA_APP_PATHS, SPA_BACKEND_PATHS, SPA_LOGIN_FIELDS, startSpaAuthSite } from '../helpers/spa-auth-site-fixture.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';

const LAUNCHERS: readonly (readonly [string, () => Promise<Browser>])[] = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI Chromium', () => launchCliChromium()],
];
const TEST_TIMEOUT_MS = 120_000;
const UI_TIMEOUT_MS = 15_000;
const LOGIN_STAGE_TIMEOUT_MS = 30_000;
const LOGIN_STAGE_POLL_MS = 100;
/** 隔離した世界の binding の名前（ページの JS から見えないことを確かめる）。部品の名前と同じ。 */
const CAPTURE_BINDING_NAME = 'beaksightLoginCapture';

const configOf = (origin: string, startPath: string): AuditConfig => {
  const base = fastRunConfig(origin, startPath);
  return { ...base, site: { startUrl: `${origin}${startPath}`, allowedOrigins: [origin] } };
};

const baseSetup = Object.freeze({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileRevision: 1,
  auditPathPrefixes: [],
  maxLoginAttempts: 1,
  allowedIdpOrigins: [],
  automatedLogin: null,
});

/** 人の代わりに入れた値（メモリだけ。出力しない）。 */
interface Typed { username: string; password: string }

/** 値が結果の記録・文字列に出ていないこと（`state` は監査に渡す状態で、値を含まない検査は別のテストが行う）。 */
const expectNoValuesInRecords = (typed: Typed, result: LoginStageResult): void => {
  const { state: _state, ...records } = result as LoginStageResult & { readonly state?: unknown };
  const texts = [JSON.stringify(records), String((records as { capturedCredential?: unknown }).capturedCredential)];
  for (const text of texts) {
    expect(text.includes(typed.username)).toBe(false);
    expect(text.includes(typed.password)).toBe(false);
  }
};

/** 受け取った値が、入れた値と同じか（真偽だけ）。 */
const capturedMatches = async (result: LoginStageResult, typed: Typed): Promise<boolean> => {
  if (result.kind !== 'AUTHENTICATED' || result.capturedCredential === undefined) {
    return false;
  }
  return withCapturedLoginCredential(result.capturedCredential, async (values) => values.username === typed.username && values.password === typed.password);
};

describe.each(LAUNCHERS)('OP-1 D2: the manual login stage receives the typed credential with %s', (_label, launch) => {
  const closers: (() => Promise<void>)[] = [];

  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  const stage = (config: AuditConfig, setup: AuthSetupV3, origin: string, captureCredential: boolean, act: (page: Page) => Promise<void>) =>
    runLoginStage({
      config,
      setup,
      approvedTestOrigins: [origin],
      approvedServiceOrigins: [],
      signal: new AbortController().signal,
      onAwaitingLogin: () => undefined,
      captureCredential,
    }, {
      launchLoginBrowser: () => launch(),
      loginTimeoutMs: LOGIN_STAGE_TIMEOUT_MS,
      pollIntervalMs: LOGIN_STAGE_POLL_MS,
      onLoginPageReady: act,
    });

  /** 人の代わりに値を入れて送る（入れた値をメモリに受ける）。ページの JS から binding が見えるかも読む。 */
  const typeAndSubmit = (fillCredentials: (fill: (selector: string, value: string) => Promise<void>) => Promise<void>, fields: { user: string; submit: string },
    typed: Typed, seen: { pageSeesBinding: string | null }) => async (page: Page): Promise<void> => {
    await page.locator(fields.user).waitFor({ timeout: UI_TIMEOUT_MS });
    seen.pageSeesBinding = await page.evaluate((name) => typeof (globalThis as unknown as Record<string, unknown>)[name], CAPTURE_BINDING_NAME);
    await fillCredentials(async (selector, value) => {
      if (selector === fields.user) typed.username = value; else typed.password = value;
      await page.locator(selector).fill(value);
    });
    await page.locator(fields.submit).click();
  };

  it('form login: receives the typed values carried by the observed form post, and keeps them out of the records and the page', async () => {
    const site = await startAuthenticatedSite({ loginForm: true });
    closers.push(() => site.close());
    const typed: Typed = { username: '', password: '' };
    const seen = { pageSeesBinding: null as string | null };
    const setup: AuthSetupV3 = {
      ...baseSetup,
      profileId: 'example-form',
      loginStartUrl: `${site.originA}${AUTH_SITE_PATHS.login}`,
      loginPostEndpoints: [{ origin: site.originA, path: AUTH_SITE_PATHS.login }],
      successCondition: { pathPrefix: AUTH_SITE_PATHS.admin, selector: null },
      sessionLostCondition: { pathPrefix: AUTH_SITE_PATHS.login },
      excludedPaths: [AUTH_SITE_PATHS.adminLogout],
    };
    const result = await stage(configOf(site.originA, AUTH_SITE_PATHS.login), setup, site.originA, true,
      typeAndSubmit((fill) => site.fillCredentials(fill), { user: AUTH_SITE_LOGIN_FIELDS.user, submit: AUTH_SITE_LOGIN_FIELDS.submit }, typed, seen));
    expect(result.kind).toBe('AUTHENTICATED');
    expect(typed.username.length > 0 && typed.password.length > 0).toBe(true);
    expect(await capturedMatches(result, typed)).toBe(true);
    expect(result.kind === 'AUTHENTICATED' ? result.capturedCredential?.carriedBy : null).toEqual({ origin: site.originA, path: AUTH_SITE_PATHS.login });
    expect(seen.pageSeesBinding).toBe('undefined');
    expectNoValuesInRecords(typed, result);
  }, TEST_TIMEOUT_MS);

  it('SPA login (the token request goes to another origin): receives the values carried by the observed token request', async () => {
    const site = await startSpaAuthSite({ preLoginRpc: 'required' });
    closers.push(() => site.close());
    const typed: Typed = { username: '', password: '' };
    const seen = { pageSeesBinding: null as string | null };
    const setup: AuthSetupV3 = {
      ...baseSetup,
      profileId: 'example-spa',
      loginStartUrl: `${site.appOrigin}${SPA_APP_PATHS.auth}`,
      loginPostEndpoints: [],
      successCondition: { pathPrefix: '', selector: null },
      sessionLostCondition: { pathPrefix: SPA_APP_PATHS.auth },
      excludedPaths: [SPA_APP_PATHS.logout],
      loginTransport: SCRIPT_REQUEST_TRANSPORT,
    };
    const result = await stage(configOf(site.appOrigin, SPA_APP_PATHS.auth), setup, site.appOrigin, true,
      typeAndSubmit((fill) => site.fillCredentials(fill), { user: SPA_LOGIN_FIELDS.email, submit: SPA_LOGIN_FIELDS.submit }, typed, seen));
    expect(result.kind).toBe('AUTHENTICATED');
    expect(site.tokenOrigin).not.toBe(site.appOrigin);
    expect(await capturedMatches(result, typed)).toBe(true);
    expect(result.kind === 'AUTHENTICATED' ? result.capturedCredential?.carriedBy : null).toEqual({ origin: site.tokenOrigin, path: SPA_BACKEND_PATHS.token });
    expect(seen.pageSeesBinding).toBe('undefined');
    expectNoValuesInRecords(typed, result);
  }, TEST_TIMEOUT_MS);

  it('does not receive the values when the caller does not ask (the default)', async () => {
    const site = await startAuthenticatedSite({ loginForm: true });
    closers.push(() => site.close());
    const typed: Typed = { username: '', password: '' };
    const seen = { pageSeesBinding: null as string | null };
    const setup: AuthSetupV3 = {
      ...baseSetup,
      profileId: 'example-form',
      loginStartUrl: `${site.originA}${AUTH_SITE_PATHS.login}`,
      loginPostEndpoints: [{ origin: site.originA, path: AUTH_SITE_PATHS.login }],
      successCondition: { pathPrefix: AUTH_SITE_PATHS.admin, selector: null },
      sessionLostCondition: { pathPrefix: AUTH_SITE_PATHS.login },
      excludedPaths: [],
    };
    const result = await stage(configOf(site.originA, AUTH_SITE_PATHS.login), setup, site.originA, false,
      typeAndSubmit((fill) => site.fillCredentials(fill), { user: AUTH_SITE_LOGIN_FIELDS.user, submit: AUTH_SITE_LOGIN_FIELDS.submit }, typed, seen));
    expect(result.kind).toBe('AUTHENTICATED');
    expect(result.kind === 'AUTHENTICATED' ? result.capturedCredential : 'not authenticated').toBeUndefined();
    expectNoValuesInRecords(typed, result);
    expect(CAPTURE_WORLD_NAME.length).toBeGreaterThan(0);
  }, TEST_TIMEOUT_MS);
});
