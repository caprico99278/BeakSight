// T33c（Task 33 の設計書 `2026-10-16-beaksight-task-33-observation-fixture-design.md` 3.3、6 章の G33 の 3）: スクリプトで送るログインの SPA
// （`tests/helpers/spa-auth-site-fixture.ts`）に対する、**今の** BeakSight のログインの段と監査の段の振る舞いを固定するテスト。期待は今の
// 振る舞いで、Task 34（スクリプトで送るログイン）・Task 35（API の読み取り）で意図して変わる（describe の名前に `baseline` と付ける）。
// 通す部品（どれも本物。Chromium はテストの既定の headless と、CLI の起動の設定の両方）:
// - C1 ログインの段: (a) `BrowserContextFactory.createLoginStageContext`（今のログインの段の Context と Guard。止めた記録は、その Context の
//   Safety Ledger で読む）。(b) ワーカーのログインの段の関数 `runLoginStage`（人の操作は、テストだけの口 `onLoginPageReady` で代える。ログインの
//   画面のための Browser も、テストが渡す launcher で起動する）。認証の設定の送信先には、token の送信先（`tokenOrigin` の `/auth/v1/token`）を
//   登録する。T34b: (a) と C7 は、スクリプトで送るログインの段の口（`scriptRequest`。token の送信先と、承認したサービスの Origin）を渡した
//   Context で流す（Task 34 の設計書 5 章の 4 のとおり、C1a・C7 の期待を意図して直した）。T34c: (b) は、認証の設定の版 3 のスクリプトで送るログイン
//   （token の送信先と成功の鍵の形。承認したサービスの Origin は token の送信先）で流す（C1b の期待を意図して直した）。
// - C2〜C6 監査の段: 監査の中核 `executeAuditRun`（認証つきの Run の指定 `RunAuthentication` で、ワーカーと同じ形。状態は `issueStoredSession()` の
//   値を、アプリの Origin の localStorage に入れたもの。絞り込みは `filterAuthenticatedState`）。Run のディレクトリの成果物（`page.json` の Safety の
//   Evidence、`visible-text.txt`、ほかのすべてのファイル）を読む。
// - C7（ログインの段）・C8（監査の段）: 実テスト環境の観察の形（ログインの前後の、テナントを決める手続きの呼び出し、ログインの直後のサーバの関数の
//   呼び出し、アプリの Origin への計測の送信）を、fixture の指定（`preLoginRpc`・`postLoginFunction`・`rumBeacon`）で再現して固定する。
// 全部の回の後に、名前つきの時間（`LATE_REQUEST_WAIT_MS`）だけ待ってから、fixture の記録を数え直す。値（資格情報、token、API の鍵）は出力しない。
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import { executeAuditRun } from '../../src/cli/audit-run.js';
import type { AuditConfig } from '../../src/config/types.js';
import {  AUTH_SETUP_SCHEMA_VERSION_3,
  type AuthSetup,
  type AuthSetupV3,
} from '../../src/control/auth/auth-setup-contracts.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { PAGES_ARTIFACT_DIRECTORY } from '../../src/core/artifact-layout.js';
import type { SafetyEventsEvidence } from '../../src/core/evidence-types.js';
import { REDACTED } from '../../src/core/redaction.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { runLoginStage } from '../../src/worker/authenticated-login.js';
import { closeTestContexts, launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { filesUnder, placesWithMarkers } from '../helpers/leak-places.js';
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
  type SpaAuthSiteOptions,
  type SpaAuthSiteRequest,
} from '../helpers/spa-auth-site-fixture.js';
import { TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

const LAUNCHERS: readonly (readonly [string, () => Promise<Browser>])[] = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI Chromium', () => launchCliChromium()],
];
/** 1 つの場面の上限（ms。監査の中核の Run を含む）。 */
const TEST_TIMEOUT_MS = 180_000;
/** 画面の状態を待つ上限（ms）。 */
const UI_TIMEOUT_MS = 15_000;
/** 全部の回の後に、遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 1_000;
/** `runLoginStage` の、ログインを待つ上限と、確かめの間隔（ms。止められて成功しないので短くする）。 */
const LOGIN_STAGE_TIMEOUT_MS = 8_000;
const LOGIN_STAGE_POLL_MS = 100;
/** ログインの送信の回数の上限（認証の設定の値）。 */
const MAX_LOGIN_ATTEMPTS = 1;
/** 監査の段の token の更新までの時間（ms。ページの監査の間に送られる短さ）。 */
const SHORT_REFRESH_MS = 100;
/** 監査するページの数（`/admin` だけ）。 */
const AUDIT_MAX_PAGES = 1;
/** fixture の既存の会員の名前（一覧が出たかを、見えている文字で確かめる）。 */
const EXISTING_NAME = '既存花子';

const passwordTokenPath = `${SPA_BACKEND_PATHS.token}?grant_type=${SPA_GRANT_TYPES.password}`;
const refreshTokenPath = `${SPA_BACKEND_PATHS.token}?grant_type=${SPA_GRANT_TYPES.refresh}`;
/** T35c: 成果物では、承認したサービスの Origin の URL の query の値をすべて伏せる（名前は残す）。 */
const redactedRefreshTokenPath = `${SPA_BACKEND_PATHS.token}?grant_type=${REDACTED}`;
const listPath = `${SPA_BACKEND_PATHS.members}?select=*`;

/** アプリの Origin でない Origin（バックエンド・認証・ほか）に届いた要求。 */
const backendRequestsOf = (spa: SpaAuthSite): readonly SpaAuthSiteRequest[] => spa.requests.filter((request) => request.origin !== 'app');

/** 監査とログインの設定（開始の URL と、許可 Origin。許可 Origin は、アプリと token・API のバックエンドの 2 つ）。 */
const configOf = (spa: SpaAuthSite, startPath: string, base: AuditConfig): AuditConfig => ({
  ...base,
  site: { startUrl: `${spa.appOrigin}${startPath}`, allowedOrigins: [spa.appOrigin, spa.tokenOrigin] },
});

/** 認証の設定（送信先に token の送信先を登録する。成功の条件は管理画面の一覧の表）。 */
const setupOf = (spa: SpaAuthSite): AuthSetup => ({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: 'example-spa',
  profileRevision: 1,
  loginStartUrl: `${spa.appOrigin}${SPA_APP_PATHS.auth}`,
  loginPostEndpoints: [{ origin: spa.tokenOrigin, path: SPA_BACKEND_PATHS.token }],
  successCondition: { pathPrefix: SPA_APP_PATHS.admin, selector: `#${SPA_STATE_ELEMENTS.members}` },
  sessionLostCondition: { pathPrefix: SPA_APP_PATHS.auth },
  excludedPaths: [SPA_APP_PATHS.logout],
  // 読む範囲は絞らない（絞ると、範囲の外のアプリのスクリプトも止まる。C2b で固定する）。
  auditPathPrefixes: [],
  maxLoginAttempts: MAX_LOGIN_ATTEMPTS,
  allowedIdpOrigins: [],
  automatedLogin: null,
});

/** ログインの画面に正しい資格情報を入れて、ログインのボタンを押す。 */
const submitLogin = async (spa: SpaAuthSite, page: Page): Promise<void> => {
  await spa.fillCredentials(async (selector, value) => page.locator(selector).fill(value));
  await page.locator(SPA_LOGIN_FIELDS.submit).click();
};

/** Run のディレクトリの、すべての `page.json` の Safety の Evidence。 */
const safetyEvidenceOf = (runDirectory: string): readonly SafetyEventsEvidence[] => {
  const pagesDirectory = join(runDirectory, PAGES_ARTIFACT_DIRECTORY);
  return readdirSync(pagesDirectory).flatMap((pageId) => {
    const document = JSON.parse(readFileSync(join(pagesDirectory, pageId, 'page.json'), 'utf8')) as {
      readonly evidence: readonly { readonly type: string; readonly payload: unknown }[];
    };
    return document.evidence.filter(({ type }) => type === 'safety').map(({ payload }) => payload as SafetyEventsEvidence);
  });
};

/** Run のディレクトリの、すべてのページの見えている文字（つないだもの）。 */
const visibleTextOf = (runDirectory: string): string => {
  const pagesDirectory = join(runDirectory, PAGES_ARTIFACT_DIRECTORY);
  return readdirSync(pagesDirectory)
    .filter((pageId) => existsSync(join(pagesDirectory, pageId, 'visible-text.txt')))
    .map((pageId) => readFileSync(join(pagesDirectory, pageId, 'visible-text.txt'), 'utf8')).join('\n');
};

describe.each(LAUNCHERS)('T33c: the script login SPA, the current BeakSight baseline (Task 34/35 will change) with %s', (_label, launch) => {
  let browser: Browser;
  let spa: SpaAuthSite | undefined;
  let workDirectory = '';
  const factories: BrowserContextFactory[] = [];

  beforeAll(async () => {
    browser = await launch();
    workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-spa-baseline-'));
  });

  afterEach(async () => {
    await Promise.all(factories.splice(0).map((factory) => factory.close()));
    await closeTestContexts(browser);
    await spa?.close();
    spa = undefined;
  });

  afterAll(async () => {
    await browser?.close();
    await rm(workDirectory, { recursive: true, force: true });
  });

  const startSite = async (options: SpaAuthSiteOptions = {}): Promise<SpaAuthSite> => {
    spa = await startSpaAuthSite(options);
    spa.addMember(EXISTING_NAME);
    return spa;
  };

  /** 監査の中核で、認証済みの状態（localStorage）から `/admin` を監査する。Run のディレクトリを返す。 */
  /**
   * T35c（Task 35 の設計書 3.2〜3.4、5 章の 1・2）: `scriptAudit` を渡すと、スクリプトで送るログインの監査の Run（許可 Origin はアプリの Origin だけ、
   * token と API のバックエンドは承認したサービスの Origin、監査の段の口 `auditStage` に登録した読み取りの手続きの呼び出し `reads`）で監査する。
   */
  const auditAdmin = async (
    site: SpaAuthSite,
    name: string,
    auditPathPrefixes: readonly string[] = [],
    scriptAudit?: { readonly reads: readonly string[] },
  ): Promise<string> => {
    const setup = setupOf(site);
    const approvedTestOrigins = scriptAudit === undefined ? [site.appOrigin, site.tokenOrigin] : [site.appOrigin];
    const authentication: RunAuthentication = {
      initialState: { cookies: [], origins: [{ origin: site.appOrigin, localStorage: [{ name: SPA_AUTH_STORAGE_KEY, value: site.issueStoredSession() }] }] },
      approvedTestOrigins,
      auditExclusions: { excludedPathPrefixes: setup.excludedPaths, auditPathPrefixes, dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
      sessionLostPathPrefix: SPA_APP_PATHS.auth,
      filterState: filterAuthenticatedState,
      ...(scriptAudit === undefined
        ? {}
        : {
          auditStage: {
            approvedServiceOrigins: [site.tokenOrigin],
            auditReadRequests: scriptAudit.reads.map((path) => ({ origin: site.backendOrigin, path, method: 'POST', maxPerPageLoad: 1 })),
            scriptLogin: { origin: site.tokenOrigin, path: SPA_BACKEND_PATHS.token, requiredQuery: [{ name: 'grant_type', value: SPA_GRANT_TYPES.password }] },
            serviceRequestLimits: { perMinute: 120, perRun: 600 },
          },
        }),
    };
    const base = fastRunConfig(site.appOrigin, SPA_APP_PATHS.admin, {
      target: { id: `spa-${name}` }, output: { directory: join(workDirectory, name) }, crawl: { maxPages: AUDIT_MAX_PAGES },
    });
    const config: AuditConfig = scriptAudit === undefined
      ? configOf(site, SPA_APP_PATHS.admin, base)
      : { ...base, site: { startUrl: `${site.appOrigin}${SPA_APP_PATHS.admin}`, allowedOrigins: [site.appOrigin] } };
    const outcome = await executeAuditRun(config, {
      launchBrowser: () => launch(), clock: () => new Date(), now: () => Date.now(), authentication,
    }, { startNew: true });
    expect(outcome.kind).toBe('RAN');
    if (outcome.kind !== 'RAN') {
      throw new Error(`the audit did not run: ${outcome.kind}`);
    }
    await wait(LATE_REQUEST_WAIT_MS);
    return outcome.runDirectory;
  };

  /** C6: Run のディレクトリのすべてのファイル（ZIP の中身を含む）に、資格情報と token の目印が出ない。API の鍵が出た場所を返す（固定する）。 */
  const expectNoSecretIn = (site: SpaAuthSite, runDirectory: string): readonly string[] => {
    const places = filesUnder(runDirectory);
    expect(places.length).toBeGreaterThan(0);
    const apiKey = site.apiKeyMarker();
    const others = site.secretValues().filter((value) => value !== apiKey);
    expect(placesWithMarkers(places, others)).toEqual([]);
    return placesWithMarkers(places, [apiKey]).map((place) => place.slice(runDirectory.length + 1).split('\\').join('/'));
  };

  /**
   * T34b（Task 34 の設計書 3.3、5 章の 4）: スクリプトで送るログインの段の Context（factory と Guard は本物）で `/auth` を開く。許可 Origin はアプリの
   * Origin だけ、token と API のバックエンドは承認したサービスの Origin として段の口（`scriptRequest`）に渡す（ログインに伴う送信は登録しない）。
   * 止めた記録は、その Context の Safety Ledger で読む。
   */
  const openLoginStage = async (site: SpaAuthSite) => {
    const base = fastRunConfig(site.appOrigin, SPA_APP_PATHS.auth);
    const config: AuditConfig = { ...base, site: { startUrl: `${site.appOrigin}${SPA_APP_PATHS.auth}`, allowedOrigins: [site.appOrigin] } };
    const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
    factories.push(factory);
    const context = await factory.createLoginStageContext(config.viewports.primaryDesktop, {
      loginPostEndpoints: [],
      maxLoginPosts: MAX_LOGIN_ATTEMPTS,
      scriptRequest: {
        scriptLogin: { origin: site.tokenOrigin, path: SPA_BACKEND_PATHS.token, requiredQuery: [{ name: 'grant_type', value: SPA_GRANT_TYPES.password }] },
        loginSideRequests: [],
        approvedServiceOrigins: [site.tokenOrigin],
      },
    });
    const page = await factory.createPassivePage(context);
    await page.goto(`${site.appOrigin}${SPA_APP_PATHS.auth}`);
    const blocked = (): readonly string[] => factory.getSafetyLedger(context).snapshot().blockedRequests
      .map(({ method, url, reason }) => `${method} ${url} ${reason}`);
    return { factory, context, page, blocked };
  };

  // T34b で意図して直した期待（Task 34 の設計書 5 章の 4）: 前は、Guard が token の POST を止めて記録し、token の送信先に何も届かなかった。
  it('C1a: the script login stage Context passes the registered token POST once; the token is stored and the list is read', async () => {
    const site = await startSite();
    const { factory, context, page, blocked } = await openLoginStage(site);
    expect(await page.locator(SPA_LOGIN_FIELDS.email).count()).toBe(1);
    await submitLogin(site, page);
    await page.locator(`#${SPA_STATE_ELEMENTS.members}[data-state="loaded"]`).waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
    await wait(LATE_REQUEST_WAIT_MS);
    // token の POST は 1 回だけ届く（事前確認は Guard が満たし、届かない）。一覧は承認したサービスの Origin から Bearer つきで読む。
    const backend = backendRequestsOf(site);
    expect(backend.filter((request) => request.method === 'POST')).toEqual([
      expect.objectContaining({ origin: 'backend', path: passwordTokenPath, preflight: false }),
    ]);
    expect(backend.filter((request) => request.method !== 'POST'))
      .toEqual([expect.objectContaining({ method: 'GET', path: listPath, bearerValid: true })]);
    expect(site.successfulLogins).toBe(1);
    expect(await page.evaluate((key) => localStorage.getItem(key) !== null, SPA_AUTH_STORAGE_KEY)).toBe(true);
    const snapshot = factory.getSafetyLedger(context).snapshot();
    expect(blocked()).toEqual([]);
    expect(snapshot.blockedInteractionRequests).toEqual([]);
    expect(snapshot.invariantViolationCount).toBe(0);
    await factory.closePassiveContext(context);
  }, TEST_TIMEOUT_MS);

  // T34c で意図して直した期待（Task 34 の設計書 5 章の 4）: 前は、止めた token の POST が、許可 Origin のログインの送信先への POST として数えられ、
  // 回数の上限を超えたとみなされた（`LOGIN_ATTEMPTS_EXCEEDED`。token の送信先には何も届かなかった）。
  it('C1b: the worker login stage (runLoginStage) of the script login logs in; the token POST reaches the token origin once', async () => {
    const site = await startSite();
    const base = fastRunConfig(site.appOrigin, SPA_APP_PATHS.auth);
    const config: AuditConfig = { ...base, site: { startUrl: `${site.appOrigin}${SPA_APP_PATHS.auth}`, allowedOrigins: [site.appOrigin] } };
    const scriptSetup: AuthSetupV3 = {
      ...setupOf(site),
      schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
      loginPostEndpoints: [],
      loginTransport: 'SCRIPT_REQUEST',
      scriptLogin: { origin: site.tokenOrigin, path: SPA_BACKEND_PATHS.token, requiredQuery: [{ name: 'grant_type', value: SPA_GRANT_TYPES.password }] },
      loginSideRequests: [],
      // fixture の鍵の名前（`SPA_AUTH_STORAGE_KEY`）に当たる形（接頭辞と接尾辞は重ならない）。
      successStorageKey: { origin: site.appOrigin, prefix: 'fixture', suffix: '-auth-token' },
    };
    expect(SPA_AUTH_STORAGE_KEY).toBe(`${scriptSetup.successStorageKey?.prefix ?? ''}${scriptSetup.successStorageKey?.suffix ?? ''}`);
    const result = await runLoginStage({
      config,
      setup: scriptSetup,
      approvedTestOrigins: [site.appOrigin],
      approvedServiceOrigins: [site.tokenOrigin],
      signal: new AbortController().signal,
      onAwaitingLogin: () => undefined,
    }, {
      launchLoginBrowser: () => launch(),
      loginTimeoutMs: LOGIN_STAGE_TIMEOUT_MS,
      pollIntervalMs: LOGIN_STAGE_POLL_MS,
      onLoginPageReady: async (page) => {
        await page.locator(SPA_LOGIN_FIELDS.email).waitFor({ timeout: UI_TIMEOUT_MS });
        // 押した後の画面は読まない（成功を確かめた時点で、ログインの段はログイン用の Browser を閉じて終わる）。
        await submitLogin(site, page);
      },
    });
    await wait(LATE_REQUEST_WAIT_MS);
    // 成功（成功の条件の画面と、Node の側の状態の成功の鍵）。token の POST は 1 回だけ届く（事前確認は Guard が満たし、届かない）。
    expect(result.kind).toBe('AUTHENTICATED');
    expect(result.kind === 'AUTHENTICATED'
      ? result.state.origins.filter(({ origin }) => origin === site.appOrigin).flatMap(({ localStorage }) => localStorage.map(({ name }) => name))
      : []).toEqual([SPA_AUTH_STORAGE_KEY]);
    expect(backendRequestsOf(site).filter((request) => request.method === 'POST')).toEqual([
      expect.objectContaining({ origin: 'backend', path: passwordTokenPath, preflight: false }),
    ]);
    expect(site.successfulLogins).toBe(1);
    expect(result.kind === 'STOPPED' ? undefined : result.scriptLogin?.tokenRequestsAllowed).toBe(1);
  }, TEST_TIMEOUT_MS);

  // T34b で、スクリプトで送るログインの段で流すように意図して直した（Task 34 の設計書 5 章の 4）。登録しない手続きの呼び出しと計測の送信は、前と
  // 同じく止まる（登録すれば通ることは `guard-script-login.test.ts` で確かめる）。
  it('C7a: on the script login stage, the Guard blocks the unregistered tenant RPC before the login (required), so the screen refuses the login; nothing reaches the backend', async () => {
    const site = await startSite({ preLoginRpc: 'required', rumBeacon: true });
    const { page, blocked } = await openLoginStage(site);
    await page.locator(`#${SPA_STATE_ELEMENTS.tenant}[data-state="error"]`).waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
    await submitLogin(site, page);
    const error = page.locator(`#${SPA_STATE_ELEMENTS.loginError}[data-state="shown"]`);
    await error.waitFor({ timeout: UI_TIMEOUT_MS });
    // 手続きの呼び出しが届かないので、画面はログインを送らない（token の POST を試みもしない）。
    expect(await error.getAttribute('data-reason')).toBe('tenant');
    await wait(LATE_REQUEST_WAIT_MS);
    expect(backendRequestsOf(site)).toEqual([]);
    // 計測の送信（アプリと同じ Origin の POST）も止める。止めた記録は、手続きの呼び出しと計測の送信の 2 つ（事前確認は記録しない）。
    expect(site.requests.filter((request) => request.method === 'POST')).toEqual([]);
    expect([...blocked()].sort()).toEqual([
      `POST ${site.appOrigin}${SPA_APP_PATHS.rum} NON_READ_METHOD`,
      `POST ${site.backendOrigin}${SPA_BACKEND_PATHS.rpcResolveTenant} NON_READ_METHOD`,
    ].sort());
  }, TEST_TIMEOUT_MS);

  // T34b で意図して直した期待（Task 34 の設計書 5 章の 4）: 前は、token の POST が最初に止まり、ログインの後のサーバの関数の呼び出しは試みられも
  // しなかった。
  it('C7b: on the script login stage, with the tenant RPC optional, the token POST passes once; the unregistered RPC and server function are blocked', async () => {
    const site = await startSite({ preLoginRpc: 'optional', postLoginFunction: 'continueOnFailure' });
    const { page, blocked } = await openLoginStage(site);
    await page.locator(`#${SPA_STATE_ELEMENTS.tenant}[data-state="error"]`).waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
    await submitLogin(site, page);
    // サーバの関数の呼び出しが止まっても続ける画面なので、管理画面へ移り、一覧を読む（手続きの呼び出しは任意）。
    await page.locator(`#${SPA_STATE_ELEMENTS.members}[data-state="loaded"]`).waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
    await wait(LATE_REQUEST_WAIT_MS);
    expect(backendRequestsOf(site).filter((request) => request.method === 'POST')).toEqual([
      expect.objectContaining({ origin: 'backend', path: passwordTokenPath, preflight: false }),
    ]);
    expect(site.successfulLogins).toBe(1);
    expect(site.functionCalls).toBe(0);
    // `/auth` と `/admin` の手続きの呼び出し（登録していない）と、ログインの直後のサーバの関数の呼び出し（登録していない）を止めて記録する。
    expect([...blocked()].sort()).toEqual([
      `POST ${site.backendOrigin}${SPA_BACKEND_PATHS.functionSyncAccess} NON_READ_METHOD`,
      `POST ${site.backendOrigin}${SPA_BACKEND_PATHS.rpcResolveTenant} NON_READ_METHOD`,
      `POST ${site.backendOrigin}${SPA_BACKEND_PATHS.rpcResolveTenant} NON_READ_METHOD`,
    ].sort());
  }, TEST_TIMEOUT_MS);

  it('C2: the audit stage from the stored state reads the list with the Bearer from the backend; preflights never reach it', async () => {
    const site = await startSite();
    const runDirectory = await auditAdmin(site, 'c2');
    const backend = backendRequestsOf(site);
    expect(backend.length).toBeGreaterThan(0);
    // 届いたのは一覧の GET だけ（Bearer つき）。事前確認は Guard が満たし、バックエンドに届かない。
    expect(backend.filter((request) => !(request.origin === 'backend' && request.method === 'GET' && request.path === listPath && !request.preflight)))
      .toEqual([]);
    expect(backend.every((request) => request.bearerValid === true)).toBe(true);
    expect(visibleTextOf(runDirectory)).toContain(EXISTING_NAME);
    for (const safety of safetyEvidenceOf(runDirectory)) {
      expect(safety.blockedRequests).toEqual([]);
      expect(safety.blockedWebSockets).toEqual([]);
    }
    expect(expectNoSecretIn(site, runDirectory)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // T35c で意図して直した期待（Task 35 の設計書 3.3、5 章の 1）: 前は、範囲の外のアプリのスクリプトが監査の段の除外で止まり、一覧を読まなかった。
  // スクリプトで送るログインの監査の Run では、範囲の外の静的な資源は読む。
  it('C2b: with the read range narrowed to /admin, the script login audit still reads the app script outside the range and the list', async () => {
    const site = await startSite();
    const runDirectory = await auditAdmin(site, 'c2b', [SPA_APP_PATHS.admin], { reads: [] });
    expect(site.requests.filter((request) => request.origin === 'app' && request.path === SPA_APP_PATHS.script).length).toBeGreaterThan(0);
    expect(backendRequestsOf(site).filter((request) => !(request.method === 'GET' && request.path === listPath && request.bearerValid === true)))
      .toEqual([]);
    const excluded = safetyEvidenceOf(runDirectory).flatMap((safety) => safety.blockedAuditExclusions?.events ?? []);
    expect(excluded.some(({ url }) => url === `${site.appOrigin}${SPA_APP_PATHS.script}`)).toBe(false);
    expect(visibleTextOf(runDirectory)).toContain(EXISTING_NAME);
    expect(expectNoSecretIn(site, runDirectory)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // T35c で意図して直した期待（Task 35 の設計書 3.6・3.7、5 章の 2）: 止めた token の更新の数が、`run.json` の `authentication` にも残る（スクリプトで
  // 送るログインの監査の Run）。止めて page.json に記録することは前のまま。token の Origin は承認したサービスの Origin なので、page.json の URL は
  // query の値を伏せる（前は `grant_type` の値が見えた）。
  it('C3: the token refresh POST of the audit stage is blocked, recorded in page.json and counted in run.json; it never reaches the backend', async () => {
    const site = await startSite({ refreshAfterMs: SHORT_REFRESH_MS });
    const runDirectory = await auditAdmin(site, 'c3', [], { reads: [] });
    const run = JSON.parse(readFileSync(join(runDirectory, 'run.json'), 'utf8')) as { readonly authentication?: { readonly tokenRefreshBlocked: number } };
    expect(run.authentication?.tokenRefreshBlocked).toBeGreaterThan(0);
    expect(backendRequestsOf(site).filter((request) => request.method !== 'GET')).toEqual([]);
    expect(site.refreshes).toBe(0);
    const blocked = safetyEvidenceOf(runDirectory).flatMap((safety) => safety.blockedRequests);
    expect(blocked.length).toBeGreaterThan(0);
    expect(new Set(blocked.map(({ method, url, reason }) => JSON.stringify([method, url, reason]))))
      .toEqual(new Set([JSON.stringify(['POST', `${site.tokenOrigin}${redactedRefreshTokenPath}`, 'NON_READ_METHOD'])]));
    expect(visibleTextOf(runDirectory)).toContain(EXISTING_NAME);
    expect(expectNoSecretIn(site, runDirectory)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // T35c で意図して直した期待（Task 35 の設計書 3.2、5 章の 2）: 前は、RPC の読み取りの POST が止まり、一覧を読まなかった。登録した読み取りの手続きの
  // 呼び出しは、Desktop と Mobile の読み込みで 1 回ずつ届き、一覧を読む。止めた要求はない。
  it('C4: the registered RPC read POST reaches the backend on the Desktop and Mobile loads, and the list is shown', async () => {
    const site = await startSite({ rpcReads: true });
    const runDirectory = await auditAdmin(site, 'c4', [], { reads: [SPA_BACKEND_PATHS.rpcListMembers] });
    expect(backendRequestsOf(site).map(({ method, path }) => `${method} ${path}`))
      .toEqual([`POST ${SPA_BACKEND_PATHS.rpcListMembers}`, `POST ${SPA_BACKEND_PATHS.rpcListMembers}`]);
    expect(safetyEvidenceOf(runDirectory).flatMap((safety) => safety.blockedRequests)).toEqual([]);
    expect(visibleTextOf(runDirectory)).toContain(EXISTING_NAME);
    expect(expectNoSecretIn(site, runDirectory)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('C5: the WebSocket of the admin screen is blocked by the current Guard rule and recorded; no UPGRADE reaches the backend', async () => {
    const site = await startSite({ websocket: true });
    const runDirectory = await auditAdmin(site, 'c5');
    expect(backendRequestsOf(site).filter((request) => request.method === 'UPGRADE')).toEqual([]);
    const blocked = safetyEvidenceOf(runDirectory).flatMap((safety) => safety.blockedWebSockets);
    expect(blocked.length).toBeGreaterThan(0);
    expect(new Set(blocked.map(({ url }) => new URL(url).pathname))).toEqual(new Set([SPA_BACKEND_PATHS.realtime]));
    expect(visibleTextOf(runDirectory)).toContain(EXISTING_NAME);
    expect(expectNoSecretIn(site, runDirectory)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  /** Run のディレクトリの、すべてのページの止めた要求（`<method> <URL> <理由>` の集合）。 */
  const blockedRequestSetOf = (runDirectory: string): ReadonlySet<string> => new Set(safetyEvidenceOf(runDirectory)
    .flatMap((safety) => safety.blockedRequests).map(({ method, url, reason }) => `${method} ${url} ${reason}`));

  // T35c で意図して直した期待（Task 35 の設計書 3.2、5 章の 2）: 前は、テナントを決める手続きの呼び出し（必須）が止まり、一覧を読まなかった。登録すれば
  // Desktop と Mobile の読み込みで 1 回ずつ届き、一覧を読む。止めて記録するのは計測の送信だけ（今どおり）。
  it('C8a: on the audit stage, the registered tenant RPC (required) reaches the backend and the list is read; the measurement beacon is blocked', async () => {
    const site = await startSite({ preLoginRpc: 'required', rumBeacon: true, postLoginFunction: 'continueOnFailure' });
    const runDirectory = await auditAdmin(site, 'c8a', [], { reads: [SPA_BACKEND_PATHS.rpcResolveTenant] });
    expect(backendRequestsOf(site).filter(({ method }) => method === 'POST').map(({ path }) => path))
      .toEqual([SPA_BACKEND_PATHS.rpcResolveTenant, SPA_BACKEND_PATHS.rpcResolveTenant]);
    expect(site.rumBeacons).toBe(0);
    // サーバの関数の呼び出しは、ログインの直後だけに出る（`/admin` の読み込みでは出ない）ので、監査の段の記録にない。
    expect(site.functionCalls).toBe(0);
    expect(blockedRequestSetOf(runDirectory)).toEqual(new Set([`POST ${site.appOrigin}${SPA_APP_PATHS.rum} NON_READ_METHOD`]));
    expect(visibleTextOf(runDirectory)).toContain(EXISTING_NAME);
    expect(expectNoSecretIn(site, runDirectory)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // T35c: スクリプトで送るログインの監査の Run で、手続きの呼び出しを登録しないときは、前と同じく止まる（期待は前のまま）。
  it('C8b: on the audit stage, with the tenant RPC optional, the RPC and the beacon are blocked but the list is read with the Bearer', async () => {
    const site = await startSite({ preLoginRpc: 'optional', rumBeacon: true });
    const runDirectory = await auditAdmin(site, 'c8b', [], { reads: [] });
    const backend = backendRequestsOf(site);
    expect(backend.length).toBeGreaterThan(0);
    expect(backend.filter((request) => !(request.method === 'GET' && request.path === listPath && request.bearerValid === true))).toEqual([]);
    expect(blockedRequestSetOf(runDirectory)).toEqual(new Set([
      `POST ${site.appOrigin}${SPA_APP_PATHS.rum} NON_READ_METHOD`,
      `POST ${site.backendOrigin}${SPA_BACKEND_PATHS.rpcResolveTenant} NON_READ_METHOD`,
    ]));
    expect(visibleTextOf(runDirectory)).toContain(EXISTING_NAME);
    expect(expectNoSecretIn(site, runDirectory)).toEqual([]);
  }, TEST_TIMEOUT_MS);
});
