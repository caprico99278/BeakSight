// DEF-102 fix（サイトへの負荷の手順書 `doc/spec/site-load.md` の「ページの読み込みの間隔」）: 自動ログインの段（`runAutomatedLoginStage`）の
// 読み込みも、ジョブと同じ読み込みの間隔の部品（`NavigationPacer`）を通る。127.0.0.1 の fixture のサーバ（`automated-login-fixture.ts`。届いた時刻を
// 記録する）と、偽の暗号化の部品の資格情報で、両方の Chromium（テストの既定と CLI の起動の設定）で確かめる。
// - ログインの画面の GET と、ログインの POST が、サーバに届く間隔は、設定の間隔以上である（POST の前にも間隔の待ちを通す）。
// - ログインの直後の最初の読み込み（ジョブと同じ順: 同じ pacer を渡した factory で Context を作り、間隔の待ちを通してから読み込む）が、
//   サーバに届くのは、ログインの段の最後の要求（ログインの POST と、その応答のリダイレクトの先の画面）が届いてから、設定の間隔以上後である
//   （ログインの段の Guard が、送った時刻と応答を受けた時刻を pacer に記録する）。
// - CCX-22（CC-085）: 監査（AUDIT）のジョブも同じ。Run Coordinator に、ログインの段と同じ pacer を渡すと、Run の最初の読み込み（robots.txt）が
//   サーバに届くのは、ログインの段の最後の要求が届いてから設定の間隔以上後で、Run の読み込みどうしも設定の間隔以上空く。`run.json` の負荷の
//   記録（読み込みの回数）には、ログインの段の読み込みを入れない。
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { AUTH_SETUP_SCHEMA_VERSION_2, type AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import { wait } from '../../src/core/deadline.js';
import { createNavigationPacer, type NavigationPacer } from '../../src/crawl/navigation-pacer.js';
import { RunCoordinator } from '../../src/orchestration/run-coordinator.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { runAutomatedLoginStage } from '../../src/worker/automated-login.js';
import {
  AUTOMATED_LOGIN_FIXTURE_CONDITIONS,
  AUTOMATED_LOGIN_FIXTURE_PATHS,
  AUTOMATED_LOGIN_FIXTURE_SELECTORS,
  startAutomatedLoginFixture,
  type AutomatedLoginFixture,
  type AutomatedLoginFixtureRequest,
} from '../helpers/automated-login-fixture.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { createTestConfig, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';
import { createTestCredentialStore, type TestCredentialStore } from '../helpers/test-credential-store.js';

const LAUNCHERS = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI launch settings', () => launchCliChromium()],
] as const;
const PROFILE_ID = 'pacing-auth';
/**
 * ページの読み込みの最小の間隔（ms）。ログインの画面を読んでから送るまで（フォームの確かめ、値の入力、送信の窓の待ち）と、ログインの段を閉じて
 * 次の Browser と Context を作るまでは、ループバックの fixture では、これより十分に短いので、pacer は間隔のちょうどまで待つ。
 */
const NAVIGATION_INTERVAL_MS = 2_000;
const TEST_TIMEOUT_MS = 60_000;
/** 監査の Run の test の時間の上限（ms。robots.txt、sitemap.xml、Desktop と Mobile の 4 回を、間隔ごとに読む）。 */
const RUN_TEST_TIMEOUT_MS = 120_000;
/** Chromium がページのアイコンを取りに行く path（Run の読み込みではないので、間隔の確かめから除く）。 */
const BROWSER_FAVICON_PATH = '/favicon.ico';
const p = AUTOMATED_LOGIN_FIXTURE_PATHS;

describe.each(LAUNCHERS)('DEF-102 fix: the automated login stage goes through the navigation pacing (%s)', (_name, launch) => {
  const username = `u${randomBytes(12).toString('hex')}`;
  const password = `p${randomBytes(12).toString('hex')}`;
  let fixture: AutomatedLoginFixture;
  let credentials: TestCredentialStore;
  const browsers: Browser[] = [];
  const temporaryDirectories: string[] = [];

  beforeAll(async () => {
    fixture = await startAutomatedLoginFixture({ username, password });
    credentials = await createTestCredentialStore();
    await credentials.store.register({ profileId: PROFILE_ID, loginOrigin: fixture.originA, username, password });
  });

  afterEach(async () => {
    await Promise.all(browsers.splice(0).map((browser) => browser.close().catch(() => undefined)));
    for (const directory of temporaryDirectories.splice(0)) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    await fixture?.close();
    await credentials?.remove();
  });

  const launched = async (): Promise<Browser> => {
    const browser = await launch();
    browsers.push(browser);
    return browser;
  };

  const setup = (): AuthSetup => ({
    schemaVersion: AUTH_SETUP_SCHEMA_VERSION_2,
    profileId: PROFILE_ID,
    profileRevision: 1,
    loginStartUrl: fixture.formUrl('standard', 'success'),
    loginPostEndpoints: [{ origin: fixture.originA, path: fixture.authPath('success') }],
    successCondition: AUTOMATED_LOGIN_FIXTURE_CONDITIONS.success,
    sessionLostCondition: { pathPrefix: null },
    excludedPaths: [],
    auditPathPrefixes: [],
    maxLoginAttempts: 1,
    allowedIdpOrigins: [],
    automatedLogin: {
      usernameSelector: AUTOMATED_LOGIN_FIXTURE_SELECTORS.username,
      passwordSelector: AUTOMATED_LOGIN_FIXTURE_SELECTORS.password,
      submitSelector: AUTOMATED_LOGIN_FIXTURE_SELECTORS.submit,
      failureConditions: {
        invalidCredentials: AUTOMATED_LOGIN_FIXTURE_CONDITIONS.invalidCredentials,
        accountLocked: AUTOMATED_LOGIN_FIXTURE_CONDITIONS.accountLocked,
        mfaRequired: AUTOMATED_LOGIN_FIXTURE_CONDITIONS.mfaRequired,
        credentialExpired: AUTOMATED_LOGIN_FIXTURE_CONDITIONS.credentialExpired,
      },
    },
  });

  /** 自動ログインの段を、`pacer` を渡して動かし、成功を確かめて、その間にサーバに届いた要求を返す。 */
  const logInWith = async (pacer: NavigationPacer): Promise<readonly AutomatedLoginFixtureRequest[]> => {
    const start = fixture.requests.length;
    const config = createTestConfig(fixture.originA, '/', { crawl: { minNavigationIntervalMs: NAVIGATION_INTERVAL_MS } });
    const result = await runAutomatedLoginStage({
      config,
      setup: setup(),
      approvedTestOrigins: [fixture.originA],
      expectedCredentialRevision: 1,
      readCredentialMetadata: () => credentials.store.readMetadata(PROFILE_ID),
      readCredential: () => credentials.store.decrypt(PROFILE_ID, fixture.originA),
      signal: new AbortController().signal,
      navigationPacer: pacer,
    }, { launchAutomatedLoginBrowser: launched });
    expect(result.kind).toBe('AUTHENTICATED');
    return fixture.requests.slice(start);
  };

  it('keeps the arrival intervals of the login page, the login POST and the first load after the login at least the interval', async () => {
    const start = fixture.requests.length;
    const config = createTestConfig(fixture.originA, '/', { crawl: { minNavigationIntervalMs: NAVIGATION_INTERVAL_MS } });
    // ワーカーの流れと同じく、ログインの段とジョブに同じ pacer を渡す。
    const pacer = createNavigationPacer({ minIntervalMs: NAVIGATION_INTERVAL_MS, now: () => Date.now(), sleep: wait });

    const loginRequests = await logInWith(pacer);

    // ログインの直後の最初の読み込み（ジョブと同じ順: pacer を渡した factory で Context と page を作り、間隔の待ちの後に読み込む）。
    const factory = new BrowserContextFactory(await launched(), config, () => new SafetyLedger(), { ...TEST_FACTORY_OPTIONS, navigationPacer: pacer });
    try {
      const context = await factory.createPassiveContext(config.viewports.primaryDesktop);
      const page = await factory.createPassivePage(context);
      await pacer.beforeNavigation();
      await page.goto(`${fixture.originA}${p.homePlain}`);
      await factory.closePassiveContext(context);
    } finally {
      await factory.close();
    }

    const arrivalOf = (requests: readonly AutomatedLoginFixtureRequest[], matches: (request: AutomatedLoginFixtureRequest) => boolean): number => {
      const found = requests.find(matches);
      if (found === undefined) {
        throw new Error('the expected request did not reach the fixture');
      }
      return found.atMs;
    };
    const formArrival = arrivalOf(loginRequests, ({ method, path }) => method === 'GET' && path.startsWith(p.form));
    const postArrival = arrivalOf(loginRequests, ({ method, path }) => method === 'POST' && path.startsWith(p.auth));
    // ログインの段の最後の要求（POST の応答のリダイレクトの先の画面を含む）。
    const lastLoginArrival = Math.max(...loginRequests.map(({ atMs }) => atMs));
    const nextArrival = arrivalOf(fixture.requests.slice(start + loginRequests.length), ({ method, path }) => method === 'GET' && path === p.homePlain);

    expect.soft(postArrival - formArrival, 'interval from the login page to the login POST').toBeGreaterThanOrEqual(NAVIGATION_INTERVAL_MS);
    expect.soft(nextArrival - lastLoginArrival, 'interval from the login stage to the first load after it').toBeGreaterThanOrEqual(NAVIGATION_INTERVAL_MS);
  }, TEST_TIMEOUT_MS);

  it('starts the audit Run at least the interval after the login stage when the Run Coordinator receives the same pacer (CCX-22)', async () => {
    const pacer = createNavigationPacer({ minIntervalMs: NAVIGATION_INTERVAL_MS, now: () => Date.now(), sleep: wait });
    const loginRequests = await logInWith(pacer);
    const loginNavigations = pacer.snapshot().navigationCount;
    const runStart = fixture.requests.length;
    const outputDirectory = await mkdtemp(join(tmpdir(), 'beaksight-login-run-pacing-'));
    temporaryDirectories.push(outputDirectory);

    const result = await new RunCoordinator({
      config: createTestConfig(fixture.originA, p.homePlain, {
        crawl: { minNavigationIntervalMs: NAVIGATION_INTERVAL_MS, maxPages: 1 },
        viewports: { stressWidths: [] },
        audit: { performance: false, accessibility: false, screenshots: false, interactions: false },
      }),
      launchBrowser: launched,
      createSafetyLedger: () => new SafetyLedger(),
      clock: () => new Date(),
      now: () => Date.now(),
      outputDirectory,
      navigationPacer: pacer,
    }).run();

    const runRequests = fixture.requests.slice(runStart).filter(({ path }) => path !== BROWSER_FAVICON_PATH);
    expect(runRequests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /robots.txt',
      'GET /sitemap.xml',
      `GET ${p.homePlain}`,
      `GET ${p.homePlain}`,
    ]);
    const lastLoginArrival = Math.max(...loginRequests.map(({ atMs }) => atMs));
    expect.soft((runRequests[0]?.atMs ?? Number.NaN) - lastLoginArrival, 'interval from the login stage to the first load of the Run')
      .toBeGreaterThanOrEqual(NAVIGATION_INTERVAL_MS);
    for (const [index, request] of runRequests.entries()) {
      if (index > 0) {
        expect.soft(request.atMs - (runRequests[index - 1]?.atMs ?? Number.NaN), `interval before ${request.path} (${index})`)
          .toBeGreaterThanOrEqual(NAVIGATION_INTERVAL_MS);
      }
    }
    // Run の負荷の記録は、Run の読み込みだけを数える（ログインの段の 2 回を入れない）。
    expect(loginNavigations).toBe(2);
    expect(result.run.load.navigationCount).toBe(runRequests.length);
    expect(pacer.snapshot().navigationCount).toBe(loginNavigations + runRequests.length);
    expect(result.pages.map((page) => page.status)).toEqual(['AUDITED']);
  }, RUN_TEST_TIMEOUT_MS);
});
