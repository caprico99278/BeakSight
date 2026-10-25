// T35c（Task 35 の設計書 3.5）: 認証つきの factory が Context の状態を読み直したときに、ログインの状態の鍵がなくなっていたら知らせる
// （`AuthenticatedContextOptions.sessionKeyPresent` と `BrowserContextFactoryOptions.onSessionKeyLost`）。値は読まない（判定は鍵の名前だけ）。
// 承認したサービスの Origin からの 401 の応答も知らせる（`onServiceUnauthorizedResponse`。応答の本文を読まない画面でも数える）。
// 通す部品は本物の factory と Guard、fixture（`startSpaAuthSite`）。Chromium はテストの既定の headless と、CLI の起動の設定の両方。
import type { Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { AuditConfig } from '../../src/config/types.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import { createServiceRequestBudget } from '../../src/crawl/service-request-budget.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { hasSuccessStorageKey } from '../../src/worker/login-stage-checks.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { fastRunConfig } from '../helpers/run-harness.js';
import {
  SPA_APP_PATHS,
  SPA_AUTH_STORAGE_KEY,
  SPA_BACKEND_PATHS,
  SPA_GRANT_TYPES,
  SPA_STATE_ELEMENTS,
  startSpaAuthSite,
  type SpaAuthSite,
  type SpaAuthSiteOptions,
} from '../helpers/spa-auth-site-fixture.js';
import { TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

const LAUNCHERS: readonly (readonly [string, () => Promise<Browser>])[] = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI Chromium', () => launchCliChromium()],
];
const TEST_TIMEOUT_MS = 120_000;
const UI_TIMEOUT_MS = 15_000;
const EXPIRED_TOKEN_LIFETIME_MS = 1;
const FIXTURE_KEY = Object.freeze({ prefix: 'fixture', suffix: '-auth-token' });
const SERVICE_REQUEST_LIMITS = Object.freeze({ perMinute: 120, perRun: 600 });

describe.each(LAUNCHERS)('T35c: the factory notices of the login state key and the 401 responses with %s', (_label, launch) => {
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

  /** 管理画面を 1 回読み、Context を閉じる（閉じるときに factory が状態を読み直す）。知らせの数を返す。 */
  const loadAdminOnce = async (options: SpaAuthSiteOptions, waitState: 'loaded' | 'error') => {
    spa = await startSpaAuthSite(options);
    const site = spa;
    site.addMember('既存花子');
    const base = fastRunConfig(site.appOrigin, SPA_APP_PATHS.admin);
    const config: AuditConfig = { ...base, site: { startUrl: `${site.appOrigin}${SPA_APP_PATHS.admin}`, allowedOrigins: [site.appOrigin] } };
    const notices = { keyLost: 0, unauthorized: 0 };
    const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), {
      ...TEST_FACTORY_OPTIONS,
      authentication: {
        initialState: { cookies: [], origins: [{ origin: site.appOrigin, localStorage: [{ name: SPA_AUTH_STORAGE_KEY, value: site.issueStoredSession() }] }] },
        filterState: (state) => filterAuthenticatedState(state, [site.appOrigin]),
        auditExclusions: { excludedPathPrefixes: [], auditPathPrefixes: [], dangerousTerms: [] },
        auditStage: {
          approvedServiceOrigins: [site.backendOrigin],
          auditReadRequests: [],
          scriptLogin: { origin: site.tokenOrigin, path: SPA_BACKEND_PATHS.token, requiredQuery: [{ name: 'grant_type', value: SPA_GRANT_TYPES.password }] },
          serviceRequestLimits: SERVICE_REQUEST_LIMITS,
        },
        sessionKeyPresent: (state) => hasSuccessStorageKey(state, { origin: site.appOrigin, ...FIXTURE_KEY }),
      },
      // T35R2-fix（T35R2 の C-1 の (a)）: 監査の段の口がある factory は、上限の部品がなければ Context を作らない（意図して足した）。
      serviceRequestBudget: createServiceRequestBudget({ ...SERVICE_REQUEST_LIMITS, now: () => Date.now() }),
      onSessionKeyLost: () => { notices.keyLost += 1; },
      onServiceUnauthorizedResponse: () => { notices.unauthorized += 1; },
    });
    factories.push(factory);
    const context = await factory.createPassiveContext(config.viewports.primaryDesktop);
    const page = await factory.createPassivePage(context);
    await page.goto(`${site.appOrigin}${SPA_APP_PATHS.admin}`);
    await page.locator(`#${SPA_STATE_ELEMENTS.members}[data-state="${waitState}"]`).waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
    await factory.closePassiveContext(context);
    loaded = { factory, site, config };
    return notices;
  };
  /** 最後に `loadAdminOnce` が使った factory と fixture と設定（AS-c の次の Context の確かめに使う）。 */
  let loaded: { readonly factory: BrowserContextFactory; readonly site: SpaAuthSite; readonly config: AuditConfig } | undefined;

  /** 次の Context が受け継いだ、ログインの状態の鍵の値があるか（アプリの Origin の資源を読み込み、ローカル ストレージを読む。値は出さない）。 */
  const nextContextHasKey = async (): Promise<boolean> => {
    if (loaded === undefined) {
      throw new Error('loadAdminOnce was not called');
    }
    const { factory, site, config } = loaded;
    const context = await factory.createPassiveContext(config.viewports.primaryDesktop);
    try {
      const page = await factory.createPassivePage(context);
      await page.goto(`${site.appOrigin}${SPA_APP_PATHS.script}`);
      return await page.evaluate((key) => localStorage.getItem(key) !== null, SPA_AUTH_STORAGE_KEY);
    } finally {
      await factory.closePassiveContext(context);
    }
  };

  it('notices nothing while the login state key stays', async () => {
    expect(await loadAdminOnce({}, 'loaded')).toEqual({ keyLost: 0, unauthorized: 0 });
  }, TEST_TIMEOUT_MS);

  it('notices the lost login state key when the page clears it', async () => {
    expect((await loadAdminOnce({ clearSessionAfterList: true }, 'loaded')).keyLost).toBeGreaterThan(0);
  }, TEST_TIMEOUT_MS);

  // AS-c の Blocker の判断 B2（設計書 5 章）: 鍵の判定がある設定で、読んだ状態に鍵がないときは、扱いによらず、次の Context に渡す状態を置き換えない（切れた状態で
  // 上書きしない。知らせは今どおり）。鍵が残っていれば、今どおり読んだ状態を受け継ぐ（T25c）。
  it('does not hand the state without the login state key to the next Context, and still hands a state with the key', async () => {
    expect((await loadAdminOnce({ clearSessionAfterList: true }, 'loaded')).keyLost).toBeGreaterThan(0);
    expect(await nextContextHasKey()).toBe(true);
    await loaded?.factory.close();
    await spa?.close();
    expect(await loadAdminOnce({}, 'loaded')).toEqual({ keyLost: 0, unauthorized: 0 });
    expect(await nextContextHasKey()).toBe(true);
  }, TEST_TIMEOUT_MS);

  it('notices the 401 response of the service origin even when the page does not read its body', async () => {
    expect((await loadAdminOnce({ tokenLifetimeMs: EXPIRED_TOKEN_LIFETIME_MS }, 'error')).unauthorized).toBe(1);
  }, TEST_TIMEOUT_MS);
});
