// OP-1（設計書 `doc/design/2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D3。DEF-181）: 手動のログインの段は、成功の条件がない（成功の画面の path も
// セレクタも空。開始の URL がログインの画面や `/` のときの案）とき、ログインが済んだことを BeakSight が判定する。手がかりは 2 つ:
// - ログインの画面を離れた（パスワードの欄が見えず、path がセッションの切れの path の外）。
// - 新しい状態の名前（Cookie・ローカル ストレージの鍵・IndexedDB の名前）が、ログインの画面を開いたときより増えた。
// 前は、空の成功の条件が、ログインの画面を開いた直後に当たり、人がログインする前に「成功」になっていた（DEF-181）。「ログインを終えた」は押さない。
// 通す部品は本物（`runLoginStage`、Guard、fixture）。Chromium はテストの既定の headless と、CLI の起動の設定の両方。値は出力しない。
import type { Browser, Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import type { AuditConfig } from '../../src/config/types.js';
import { SCRIPT_REQUEST_TRANSPORT, type AuthSetupV3 } from '../../src/control/auth/auth-setup-contracts.js';
import { runLoginStage, type LoginStageResult } from '../../src/worker/authenticated-login.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { fastRunConfig } from '../helpers/run-harness.js';
import { AUTH_SITE_LOGIN_FIELDS, AUTH_SITE_PATHS, startAuthenticatedSite, type AuthenticatedSite } from '../helpers/authenticated-site-fixture.js';
import { SPA_APP_PATHS, SPA_LOGIN_FIELDS, startSpaAuthSite, type SpaAuthSite } from '../helpers/spa-auth-site-fixture.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';

const LAUNCHERS: readonly (readonly [string, () => Promise<Browser>])[] = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI Chromium', () => launchCliChromium()],
];
const TEST_TIMEOUT_MS = 120_000;
const UI_TIMEOUT_MS = 15_000;
const LOGIN_STAGE_TIMEOUT_MS = 30_000;
const SHORT_LOGIN_STAGE_TIMEOUT_MS = 4_000;
const LOGIN_STAGE_POLL_MS = 100;
/** 人がログインを始めるまでの間（この間に「成功」にならないことを確かめる。確かめの間隔の数回分）。 */
const HUMAN_DELAY_MS = 1_500;

/** 成功の条件のない（path もセレクタも空の）認証の設定の共通の項目。 */
const NO_SUCCESS_CONDITION = Object.freeze({ pathPrefix: '', selector: null });

const formSetupOf = (site: AuthenticatedSite): AuthSetupV3 => ({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: 'example-form',
  profileRevision: 1,
  loginStartUrl: `${site.originA}${AUTH_SITE_PATHS.login}`,
  loginPostEndpoints: [{ origin: site.originA, path: AUTH_SITE_PATHS.login }],
  successCondition: NO_SUCCESS_CONDITION,
  sessionLostCondition: { pathPrefix: AUTH_SITE_PATHS.login },
  excludedPaths: [AUTH_SITE_PATHS.adminLogout],
  auditPathPrefixes: [],
  maxLoginAttempts: 1,
  allowedIdpOrigins: [],
  automatedLogin: null,
});

const spaSetupOf = (site: SpaAuthSite): AuthSetupV3 => ({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: 'example-spa',
  profileRevision: 1,
  loginStartUrl: `${site.appOrigin}${SPA_APP_PATHS.auth}`,
  loginPostEndpoints: [],
  successCondition: NO_SUCCESS_CONDITION,
  sessionLostCondition: { pathPrefix: SPA_APP_PATHS.auth },
  excludedPaths: [SPA_APP_PATHS.logout],
  auditPathPrefixes: [],
  maxLoginAttempts: 1,
  allowedIdpOrigins: [],
  automatedLogin: null,
  loginTransport: SCRIPT_REQUEST_TRANSPORT,
});

const configOf = (origin: string, startPath: string): AuditConfig => {
  const base = fastRunConfig(origin, startPath);
  return { ...base, site: { startUrl: `${origin}${startPath}`, allowedOrigins: [origin] } };
};

/** 結果の記録（状態を除く）に、値が出ていないこと。 */
const expectNoSecretsInRecords = (secrets: readonly string[], result: LoginStageResult): void => {
  const { state: _state, ...records } = result as LoginStageResult & { readonly state?: unknown };
  const text = JSON.stringify(records);
  for (const secret of secrets) {
    expect(text).not.toContain(secret);
  }
};

describe.each(LAUNCHERS)('OP-1 D3: the manual login stage detects the end of the login by itself with %s', (_label, launch) => {
  const closers: (() => Promise<void>)[] = [];

  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  const stage = (config: AuditConfig, setup: AuthSetupV3, origin: string, act: (page: Page) => Promise<void>, timeoutMs = LOGIN_STAGE_TIMEOUT_MS) =>
    runLoginStage({
      config,
      setup,
      approvedTestOrigins: [origin],
      approvedServiceOrigins: [],
      signal: new AbortController().signal,
      onAwaitingLogin: () => undefined,
    }, {
      launchLoginBrowser: () => launch(),
      loginTimeoutMs: timeoutMs,
      pollIntervalMs: LOGIN_STAGE_POLL_MS,
      onLoginPageReady: act,
    });

  it('form login: without a success condition, does not succeed before the login, and succeeds after it (no confirmation)', async () => {
    const site = await startAuthenticatedSite({ loginForm: true });
    closers.push(() => site.close());
    const loginsWhenEnded: number[] = [];
    const result = await stage(configOf(site.originA, AUTH_SITE_PATHS.login), formSetupOf(site), site.originA, async (page) => {
      await page.locator(AUTH_SITE_LOGIN_FIELDS.user).waitFor({ timeout: UI_TIMEOUT_MS });
      await wait(HUMAN_DELAY_MS);
      await site.fillCredentials(async (selector, value) => page.locator(selector).fill(value));
      await page.locator(AUTH_SITE_LOGIN_FIELDS.submit).click();
    });
    loginsWhenEnded.push(site.successfulLogins);
    expect(result.kind).toBe('AUTHENTICATED');
    expect(loginsWhenEnded).toEqual([1]);
    expectNoSecretsInRecords(site.secretValues(), result);
  }, TEST_TIMEOUT_MS);

  it('SPA login (the token comes from another origin): without a success condition, succeeds only after the login', async () => {
    const site = await startSpaAuthSite({ preLoginRpc: 'required' });
    closers.push(() => site.close());
    const result = await stage(configOf(site.appOrigin, SPA_APP_PATHS.auth), spaSetupOf(site), site.appOrigin, async (page) => {
      await page.locator(SPA_LOGIN_FIELDS.email).waitFor({ timeout: UI_TIMEOUT_MS });
      await wait(HUMAN_DELAY_MS);
      await site.fillCredentials(async (selector, value) => page.locator(selector).fill(value));
      await page.locator(SPA_LOGIN_FIELDS.submit).click();
    });
    expect(result.kind).toBe('AUTHENTICATED');
    expect(site.successfulLogins).toBe(1);
    expectNoSecretsInRecords(site.secretValues(), result);
  }, TEST_TIMEOUT_MS);

  it('DEF-181: without a success condition and without a login, does not succeed (waits until the time limit)', async () => {
    const site = await startAuthenticatedSite({ loginForm: true });
    closers.push(() => site.close());
    const result = await stage(configOf(site.originA, AUTH_SITE_PATHS.login), formSetupOf(site), site.originA, async () => undefined,
      SHORT_LOGIN_STAGE_TIMEOUT_MS);
    expect(result.kind).toBe('LOGIN_TIMEOUT');
    expect(site.successfulLogins).toBe(0);
  }, TEST_TIMEOUT_MS);
});
