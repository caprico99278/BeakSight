// ML-a（設計書 `2026-10-19-beaksight-manual-login-pass-through-design.md` 2.1〜2.3、受け入れ条件 1〜5・7）: 手動のログインの段は、ページの送信を
// 止めずに通して形だけ記録し、成功の条件か「ログインを終えた」で終わる。通した記録から組み立てた認証の設定（版 3）で、自動ログインの段と同じ厳しさの
// Guard（登録した送信だけ、回数の上限）が働く。通す部品（どれも本物。Chromium はテストの既定の headless と、CLI の起動の設定の両方）:
// - ワーカーのログインの段の関数 `runLoginStage`（人の操作は、テストだけの口 `onLoginPageReady` で代える）。認証の設定はフォームの送信のまま（LG-3b: 版 3）、
//   許可 Origin はアプリの Origin だけ（実テスト環境の形。token の送信先とテナントを決める手続きの呼び出しは、別の Origin のバックエンド）。
// - 組み立ての部品 `manualLoginRegistrationOf`（今の「登録する」の部品を使う）と、自動ログインと同じ口の Guard（`createLoginStageContext` に
//   `loginStageGuardOf` の口を渡し、手動の印を付けない）。
// 届いたかは fixture の記録で数える。値（資格情報、token、API の鍵）は、結果と記録に出ないことを確かめる（出力しない）。
import type { Browser, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { AuditConfig } from '../../src/config/types.js';
import {
  AUTH_SETUP_SCHEMA_VERSION_3,
  SCRIPT_REQUEST_TRANSPORT,
  type AuthSetupV3,
} from '../../src/control/auth/auth-setup-contracts.js';
import { manualLoginRegistrationOf } from '../../src/control/manual-login-registration.js';
import { LoginStageMonitor } from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { runLoginStage, type LoginStageResult } from '../../src/worker/authenticated-login.js';
import { loginStageGuardOf } from '../../src/worker/login-stage-checks.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { fastRunConfig } from '../helpers/run-harness.js';
import {
  SPA_APP_PATHS,
  SPA_AUTH_STORAGE_KEY,
  SPA_BACKEND_PATHS,
  SPA_GRANT_TYPES,
  SPA_LOGIN_FIELDS,
  SPA_STATE_ELEMENTS,
  startSpaAuthSite,
  type SpaAuthSite,
} from '../helpers/spa-auth-site-fixture.js';
import { TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';

const LAUNCHERS: readonly (readonly [string, () => Promise<Browser>])[] = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI Chromium', () => launchCliChromium()],
];
const TEST_TIMEOUT_MS = 120_000;
const UI_TIMEOUT_MS = 15_000;
const LATE_REQUEST_WAIT_MS = 1_000;
const LOGIN_STAGE_TIMEOUT_MS = 30_000;
const LOGIN_STAGE_POLL_MS = 100;

/** フォームの送信の認証の設定（フォームの送信先はアプリの Origin の `/login`。token の送信先は登録していない）。 */
const setupOf = (site: SpaAuthSite, successPathPrefix: string): AuthSetupV3 => ({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: 'example-spa',
  profileRevision: 1,
  loginStartUrl: `${site.appOrigin}${SPA_APP_PATHS.auth}`,
  loginPostEndpoints: [{ origin: site.appOrigin, path: '/login' }],
  successCondition: { pathPrefix: successPathPrefix, selector: `#${SPA_STATE_ELEMENTS.members}` },
  sessionLostCondition: { pathPrefix: SPA_APP_PATHS.auth },
  excludedPaths: [SPA_APP_PATHS.logout],
  auditPathPrefixes: [],
  maxLoginAttempts: 1,
  allowedIdpOrigins: [],
  automatedLogin: null,
});

const configOf = (site: SpaAuthSite): AuditConfig => {
  const base = fastRunConfig(site.appOrigin, SPA_APP_PATHS.auth);
  return { ...base, site: { startUrl: `${site.appOrigin}${SPA_APP_PATHS.auth}`, allowedOrigins: [site.appOrigin] } };
};

const submitLogin = async (site: SpaAuthSite, page: Page): Promise<void> => {
  await page.locator(SPA_LOGIN_FIELDS.email).waitFor({ timeout: UI_TIMEOUT_MS });
  await site.fillCredentials(async (selector, value) => page.locator(selector).fill(value));
  await page.locator(SPA_LOGIN_FIELDS.submit).click();
};

/** バックエンドに届いた POST（`<path>`。query を除く）。 */
const backendPosts = (site: SpaAuthSite): readonly string[] =>
  site.requests.filter((request) => request.origin !== 'app' && request.method === 'POST' && !request.preflight).map(({ path }) => path.split('?')[0] ?? '');

/** 結果の記録（状態を除く）に、値が出ていないこと。 */
const expectNoSecretsInRecords = (site: SpaAuthSite, result: LoginStageResult): void => {
  const { state: _state, ...records } = result as LoginStageResult & { readonly state?: unknown };
  const text = JSON.stringify(records);
  for (const secret of site.secretValues()) {
    expect(text).not.toContain(secret);
  }
};

describe.each(LAUNCHERS)('ML-a: the manual login stage passes the page requests with %s', (_label, launch) => {
  let browser: Browser;
  let spa: SpaAuthSite | undefined;
  const factories: BrowserContextFactory[] = [];

  beforeAll(async () => {
    browser = await launch();
  });

  afterEach(async () => {
    await Promise.all(factories.splice(0).map((factory) => factory.close()));
    await spa?.close();
    spa = undefined;
  });

  afterAll(async () => {
    await browser?.close();
  });

  const startSite = async (): Promise<SpaAuthSite> => {
    spa = await startSpaAuthSite({ preLoginRpc: 'required' });
    return spa;
  };

  const manualLogin = (
    site: SpaAuthSite,
    setup: AuthSetupV3,
    confirm?: { confirmed: boolean },
    approvedServiceOrigins: readonly string[] = [],
  ) => runLoginStage({
    config: configOf(site),
    setup,
    approvedTestOrigins: [site.appOrigin],
    approvedServiceOrigins,
    signal: new AbortController().signal,
    onAwaitingLogin: () => undefined,
    ...(confirm === undefined ? {} : { loginConfirmed: () => confirm.confirmed }),
  }, {
    launchLoginBrowser: () => launch(),
    loginTimeoutMs: LOGIN_STAGE_TIMEOUT_MS,
    pollIntervalMs: LOGIN_STAGE_POLL_MS,
    onLoginPageReady: async (page) => {
      await submitLogin(site, page);
      if (confirm !== undefined) {
        // ログインの後の画面へ移った（token を受けて状態を保存した）ら、利用者が「ログインを終えた」を押す。
        await page.waitForURL((url) => url.pathname.startsWith(SPA_APP_PATHS.admin), { timeout: UI_TIMEOUT_MS });
        confirm.confirmed = true;
      }
    },
  });

  it('delivers the procedure call and the token request with a form login setup, ends at the success condition and records the passed requests without values', async () => {
    const site = await startSite();
    const result = await manualLogin(site, setupOf(site, SPA_APP_PATHS.admin));
    await wait(LATE_REQUEST_WAIT_MS);
    expect(result.kind).toBe('AUTHENTICATED');
    expect(backendPosts(site)).toEqual(expect.arrayContaining([SPA_BACKEND_PATHS.rpcResolveTenant, SPA_BACKEND_PATHS.token]));
    expect(site.successfulLogins).toBe(1);
    const rows = result.kind === 'STOPPED' ? [] : result.passedRequests?.requests ?? [];
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ origin: site.tokenOrigin, path: SPA_BACKEND_PATHS.token, query: { names: ['grant_type'], omitted: 0, values: [{ name: 'grant_type', value: SPA_GRANT_TYPES.password }] } }),
      expect.objectContaining({ origin: site.backendOrigin, path: SPA_BACKEND_PATHS.rpcResolveTenant }),
    ]));
    // ML-a-fix（ML-R の I-1）: ログインの画面のテナントの手続きの呼び出しは token の送信より前に最初に見たので印を持ち、token の行は持たない。
    expect(rows.find(({ path }) => path === SPA_BACKEND_PATHS.rpcResolveTenant)?.beforeToken).toBe(true);
    expect(rows.find(({ path }) => path === SPA_BACKEND_PATHS.token)?.beforeToken).toBeUndefined();
    expectNoSecretsInRecords(site, result);
  }, TEST_TIMEOUT_MS);

  it('ends with the login confirmation when the success condition does not match', async () => {
    const site = await startSite();
    const confirm = { confirmed: false };
    const result = await manualLogin(site, setupOf(site, '/never-matches'), confirm);
    expect(result.kind).toBe('AUTHENTICATED');
    expect(result.kind === 'AUTHENTICATED'
      ? result.state.origins.filter(({ origin }) => origin === site.appOrigin).flatMap(({ localStorage }) => localStorage.map(({ name }) => name))
      : []).toEqual([SPA_AUTH_STORAGE_KEY]);
    expectNoSecretsInRecords(site, result);
  }, TEST_TIMEOUT_MS);

  // T44e（Task 44 の設計書 P2-8）: 手動のログインのプロファイルは、スクリプトで送るログインの設定を、token の送信先と成功の鍵なしで保存できる（入口の確かめの
  // 案のまま）。手動のログインの段は今どおり送信を通して記録し（Guard の決まりは変えない）、成功の条件の画面で終わり、成功の後の自動の登録が空の欄を埋める。
  it('T44e: with a script login setup without the target and the success key, passes the requests, ends at the success condition, and the registration fills them', async () => {
    const site = await startSite();
    const empty: AuthSetupV3 = {
      ...setupOf(site, SPA_APP_PATHS.admin),
      schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
      loginPostEndpoints: [],
      loginTransport: SCRIPT_REQUEST_TRANSPORT,
      scriptLogin: null,
      loginSideRequests: [],
      successStorageKey: null,
    };
    const result = await manualLogin(site, empty);
    await wait(LATE_REQUEST_WAIT_MS);
    expect(result.kind).toBe('AUTHENTICATED');
    if (result.kind === 'STOPPED') return;
    // 送信は止めずに通した（token の送信がサーバに届き、形だけを記録した）。
    expect(backendPosts(site)).toContain(SPA_BACKEND_PATHS.token);
    expect(site.successfulLogins).toBe(1);
    expect(result.passedRequests?.requests.some(({ path }) => path === SPA_BACKEND_PATHS.token)).toBe(true);
    const built = manualLoginRegistrationOf({
      setup: empty,
      profile: { approvedTestOrigins: [site.appOrigin], approvedServiceOrigins: [] },
      passedRequests: result.passedRequests,
      observation: result.loginObservation,
      nextProfileRevision: 2,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.setup.scriptLogin).toEqual({ origin: site.tokenOrigin, path: SPA_BACKEND_PATHS.token, requiredQuery: [{ name: 'grant_type', value: SPA_GRANT_TYPES.password }] });
    expect(built.setup.successStorageKey?.origin).toBe(site.appOrigin);
    expect(built.addServiceOrigins).toEqual([site.backendOrigin]);
    expectNoSecretsInRecords(site, result);
  }, TEST_TIMEOUT_MS);

  // T44R の M-1（設計書の履歴の T44R の行）: token の送信先がまだない設定でも、手動のログインの段で、プロファイルの承認したサービスの Origin への読み取り（GET）を
  // 通す（ログインの後の画面が API から一覧を読める）。読み取りでない要求は、今どおり通して記録する。
  it('T44R M-1: passes the reads of the approved service origin with a script login setup without the target', async () => {
    const site = await startSite();
    const empty: AuthSetupV3 = {
      ...setupOf(site, SPA_APP_PATHS.admin),
      schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
      loginPostEndpoints: [],
      loginTransport: SCRIPT_REQUEST_TRANSPORT,
      scriptLogin: null,
      loginSideRequests: [],
      successStorageKey: null,
    };
    const result = await manualLogin(site, empty, undefined, [site.backendOrigin]);
    await wait(LATE_REQUEST_WAIT_MS);
    expect(result.kind).toBe('AUTHENTICATED');
    // ログインの後の画面（`/admin`）が、サービスの Origin から一覧を読んだ（GET が届いた）。
    expect(site.requests.some(({ origin, method, path, preflight }) =>
      origin === 'backend' && method === 'GET' && !preflight && path.split('?')[0] === SPA_BACKEND_PATHS.members)).toBe(true);
    // 読み取りでない要求（token の送信）は、今どおり通して形を記録する。
    expect(backendPosts(site)).toContain(SPA_BACKEND_PATHS.token);
    expect(result.kind === 'STOPPED' ? [] : result.passedRequests?.requests.map(({ path }) => path) ?? []).toContain(SPA_BACKEND_PATHS.token);
    expectNoSecretsInRecords(site, result);
  }, TEST_TIMEOUT_MS);

  // T44R の M-1: 承認したサービスの Origin の口は、手動のログインの段の、スクリプトの指定がない形だけが受ける（自動ログインの段は今どおり拒む）。
  it('T44R M-1: accepts the service origins for the reads only with the manual stage without the script target', async () => {
    const site = await startSite();
    const config = configOf(site);
    const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
    factories.push(factory);
    const viewport = config.viewports.primaryDesktop;
    const base = { loginPostEndpoints: [], maxLoginPosts: 1, manualServiceReadOrigins: [site.backendOrigin] };
    const script = {
      scriptLogin: { origin: site.tokenOrigin, path: SPA_BACKEND_PATHS.token, requiredQuery: [] },
      loginSideRequests: [],
      approvedServiceOrigins: [site.backendOrigin],
    };
    await expect(factory.createLoginStageContext(viewport, base)).rejects.toThrow(TypeError);
    await expect(factory.createLoginStageContext(viewport, { ...base, scriptRequest: script })).rejects.toThrow(TypeError);
    await expect(factory.createLoginStageContext(viewport, { ...base, manualPassThrough: true, scriptRequest: script })).rejects.toThrow(TypeError);
    await expect(factory.createLoginStageContext(viewport, { ...base, manualPassThrough: true, manualServiceReadOrigins: [1] as never }))
      .rejects.toThrow(TypeError);
    const context = await factory.createLoginStageContext(viewport, { ...base, manualPassThrough: true });
    await factory.closePassiveContext(context);
  }, TEST_TIMEOUT_MS);

  it('builds a script login setup from the manual login, and the strict login stage Guard with it passes only the registered requests within the limits', async () => {
    const site = await startSite();
    const result = await manualLogin(site, setupOf(site, SPA_APP_PATHS.admin));
    expect(result.kind).toBe('AUTHENTICATED');
    if (result.kind === 'STOPPED') return;
    const built = manualLoginRegistrationOf({
      setup: setupOf(site, SPA_APP_PATHS.admin),
      profile: { approvedTestOrigins: [site.appOrigin], approvedServiceOrigins: [] },
      passedRequests: result.passedRequests,
      observation: result.loginObservation,
      nextProfileRevision: 2,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(JSON.stringify(built)).not.toContain(site.secretValues()[1] ?? 'unused');
    expect(built.setup.scriptLogin).toEqual({ origin: site.tokenOrigin, path: SPA_BACKEND_PATHS.token, requiredQuery: [{ name: 'grant_type', value: SPA_GRANT_TYPES.password }] });
    expect(built.setup.loginSideRequests.map(({ path }) => path)).toContain(SPA_BACKEND_PATHS.rpcResolveTenant);
    expect(built.setup.loginSideRequests.map(({ path }) => path)).not.toContain(SPA_APP_PATHS.logout);
    expect(built.addServiceOrigins).toEqual([site.backendOrigin]);

    // 自動ログインと同じ口（手動の印なし）の Guard で、ログインの画面をもう一度開いてログインする。
    const before = backendPosts(site).length;
    const config = configOf(site);
    const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
    factories.push(factory);
    const monitor = new LoginStageMonitor();
    const guard = loginStageGuardOf(built.setup, built.addServiceOrigins);
    const context = await factory.createLoginStageContext(config.viewports.primaryDesktop, {
      loginPostEndpoints: guard.loginPostEndpoints,
      maxLoginPosts: built.setup.maxLoginAttempts,
      monitor,
      ...(guard.scriptRequest === undefined ? {} : { scriptRequest: guard.scriptRequest }),
    });
    const page = await factory.createPassivePage(context);
    await page.goto(`${site.appOrigin}${SPA_APP_PATHS.auth}`);
    await submitLogin(site, page);
    // ML-a-fix-2: 登録したテナントの呼び出しの回数の上限は閉じた上限なので、ログインの後の呼び出しも通り、一覧が読み込まれる。
    await page.locator(`#${SPA_STATE_ELEMENTS.members}[data-state="loaded"]`).waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
    // 登録していない読み取りでない要求と、上限を超えた token の送信は止まる。
    await page.evaluate(async ([origin, members, token]) => {
      await fetch(`${origin}${members}`, { method: 'POST', body: '{}' }).catch(() => undefined);
      await fetch(`${origin}${token}?grant_type=password`, { method: 'POST', body: '{}' }).catch(() => undefined);
    }, [site.backendOrigin, SPA_BACKEND_PATHS.members, SPA_BACKEND_PATHS.token] as const);
    await wait(LATE_REQUEST_WAIT_MS);
    const delivered = backendPosts(site).slice(before);
    expect(delivered.filter((path) => path === SPA_BACKEND_PATHS.token)).toHaveLength(1);
    expect(delivered).not.toContain(SPA_BACKEND_PATHS.members);
    const snapshot = monitor.snapshot();
    expect(snapshot.scriptRequest.tokenRequestsAllowed).toBe(1);
    expect(snapshot.scriptRequest.blockedByScriptReason.TOKEN_REQUEST_OVER_LIMIT).toBe(1);
    expect(snapshot.scriptRequest.blockedByScriptReason.UNREGISTERED_NON_READ).toBeGreaterThanOrEqual(1);
    expect(snapshot.passedRequests.requests).toEqual([]);
  }, TEST_TIMEOUT_MS);
});
