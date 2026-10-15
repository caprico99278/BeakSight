// T26d-1（Task 26 の設計書 4.4、4.5 の結果の閉じた一覧、4.7、調査 E2・E5・E7）: 自動ログインの段（`src/worker/automated-login.ts` の
// `runAutomatedLoginStage`）を、直接呼んで確かめる。127.0.0.1 の fixture のサーバ（`automated-login-fixture.ts`。届いた要求をすべて記録する）と、
// 偽の暗号化の部品で一時のフォルダに作った資格情報のファイル（`test-credential-store.ts`）を使う。Chromium は headless だけ（テストの既定と、
// CLI の起動の設定（`launchCliChromium`）の両方）。資格情報の目印は、実行ごとのランダムな値。
// - 結果の区別: 成功、資格情報の誤り、ロック、MFA、期限切れ、429（`Retry-After` の秒と日付）、500、どの条件にも当たらない、2 つの条件に当たる、
//   成功の後の状態が空、2 回目の POST を送ろうとする画面、フォームの確かめで止まる形、`fill` の失敗、止める印、改訂の番号の違い、復号の失敗。
// - 安全: サーバが受けた GET と HEAD 以外の要求は、許した送信先への POST 1 回だけ（フォームの確かめなどで止まる場合は 0 回）。すべての要求の
//   URL と、POST 以外の本文に、目印がない（許した POST の本文にだけある）。ページの JS の beacon・fetch・サブ frame の POST は届かない。
//   返す値・投げた誤り・テストで集めた console に、目印がない。
// - 成功の後の状態は、Task 25 と同じく、許可 Origin（`approvedTestOrigins`）の Cookie と localStorage だけに絞られる。
import { randomBytes } from 'node:crypto';
import type { Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';
import { AUTH_SETUP_SCHEMA_VERSION_2, type AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import {
  runAutomatedLoginStage,
  type AutomatedLoginStageDependencies,
  type AutomatedLoginStageRequest,
  type AutomatedLoginStageResult,
} from '../../src/worker/automated-login.js';
import {
  AUTOMATED_LOGIN_FIXTURE_CONDITIONS,
  AUTOMATED_LOGIN_FIXTURE_SELECTORS,
  FIXTURE_LOCAL_STORAGE_ITEM,
  FIXTURE_RETRY_AFTER_DATE_OFFSET_MS,
  FIXTURE_RETRY_AFTER_SECONDS,
  FIXTURE_SESSION_COOKIE,
  startAutomatedLoginFixture,
  type AutomatedLoginFixture,
  type AutomatedLoginFormVariant,
  type AutomatedLoginOutcome,
} from '../helpers/automated-login-fixture.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { createTestConfig } from '../helpers/test-config.js';
import { createTestCredentialStore, type TestCredentialStore } from '../helpers/test-credential-store.js';

const LAUNCHERS = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI launch settings', () => launchCliChromium()],
] as const;
const PROFILE_ID = 'example-auth';
const CHANGING_PROFILE_ID = 'changing-auth';
const MISSING_PROFILE_ID = 'missing-auth';
/** 結果を待つ時間（ms。どの条件にも当たらない場面は、これだけ待つ）。 */
const RESULT_TIMEOUT_MS = 3_000;
const POLL_INTERVAL_MS = 100;
/** フォームの 1 つの操作の時間の上限（ms）。 */
const FORM_STEP_TIMEOUT_MS = 5_000;
/** 入力できない欄の場面の、フォームの 1 つの操作の時間の上限（ms）。 */
const SHORT_FORM_STEP_TIMEOUT_MS = 1_000;
/** 終わった後に、遅れて届く要求を待つ時間（ms）。 */
const QUIET_PERIOD_MS = 300;
const TEST_TIMEOUT_MS = 60_000;
const SECOND_MS = 1_000;
const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;
/** 2 つの条件に当たる画面の場面の、ロックの条件。 */
const AMBIGUOUS_LOCKED_CONDITION = Object.freeze({ pathPrefix: '/home/both', selector: '#locked' });

const wait = (ms: number): Promise<void> => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const marker = (prefix: string): string => `${prefix}${randomBytes(12).toString('hex')}`;

/** 結果の条件ごとの、結果の区別。 */
const DISTINGUISHED: readonly (readonly [AutomatedLoginOutcome, AutomatedLoginStageResult['kind']])[] = [
  ['invalid', 'INVALID_CREDENTIALS'],
  ['locked', 'ACCOUNT_LOCKED'],
  ['mfa', 'MFA_REQUIRED'],
  ['expired', 'CREDENTIAL_EXPIRED'],
  ['error', 'AUTH_RESULT_UNKNOWN'],
  ['nomatch', 'AUTH_RESULT_UNKNOWN'],
  ['ambiguous', 'AUTH_RESULT_UNKNOWN'],
  ['nostate', 'UNSUPPORTED_AUTH_STATE'],
  ['resubmit', 'AUTH_RESULT_UNKNOWN'],
];

/**
 * フォームの確かめで止まる形（値を入れない。POST 0）と、その理由のコード（T26d-2: 結果に理由のコードを添える。`switch-to-get` は、値を入れた後の
 * 確かめ直しで止まる）。
 */
const INVALID_FORMS: readonly (readonly [AutomatedLoginFormVariant, string])[] = [
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
  ['switch-to-get', 'METHOD_NOT_POST'],
];

interface StageRun {
  readonly result: AutomatedLoginStageResult;
  readonly thrown: unknown;
  /** この実行の間にサーバに届いた要求。 */
  readonly requests: AutomatedLoginFixture['requests'];
  readonly launches: number;
}

describe.each(LAUNCHERS)('T26d-1: the automated login stage (%s)', (_name, launch) => {
  const username = marker('u');
  const password = marker('p');
  let fixture: AutomatedLoginFixture;
  let credentials: TestCredentialStore;
  let onSlowPost: (() => void) | undefined;
  const browsers: Browser[] = [];
  const consoleSpies: MockInstance[] = [];

  beforeAll(async () => {
    fixture = await startAutomatedLoginFixture({ username, password, onSlowPost: () => onSlowPost?.() });
    credentials = await createTestCredentialStore();
    for (const profileId of [PROFILE_ID, CHANGING_PROFILE_ID]) {
      await credentials.store.register({ profileId, loginOrigin: fixture.originA, username, password });
    }
    for (const method of CONSOLE_METHODS) {
      consoleSpies.push(vi.spyOn(console, method));
    }
  });

  afterEach(async () => {
    onSlowPost = undefined;
    await Promise.all(browsers.splice(0).map((browser) => browser.close().catch(() => undefined)));
  });

  afterAll(async () => {
    for (const spy of consoleSpies.splice(0)) {
      spy.mockRestore();
    }
    await fixture?.close();
    await credentials?.remove();
  });

  const setupFor = (variant: AutomatedLoginFormVariant, outcome: AutomatedLoginOutcome): AuthSetup => ({
    schemaVersion: AUTH_SETUP_SCHEMA_VERSION_2,
    profileId: PROFILE_ID,
    profileRevision: 1,
    loginStartUrl: fixture.formUrl(variant, outcome),
    loginPostEndpoints: [{ origin: fixture.originA, path: fixture.authPath(outcome) }],
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

  /** 自動ログインの段を 1 回動かす（既定は、登録した資格情報で、`standard` の形と `success` の結果）。 */
  async function runStage(input: {
    readonly variant?: AutomatedLoginFormVariant;
    readonly outcome?: AutomatedLoginOutcome;
    readonly request?: Partial<AutomatedLoginStageRequest>;
    readonly dependencies?: Partial<AutomatedLoginStageDependencies>;
  } = {}): Promise<StageRun> {
    const start = fixture.requests.length;
    const outcome = input.outcome ?? 'success';
    const base = setupFor(input.variant ?? 'standard', outcome);
    // 2 つの条件に当たる画面（`/home/both`）: 成功の条件（`/home` と `#home-ok`）に加え、ロックの条件もその画面に当たるようにする。
    const setup: AuthSetup = outcome === 'ambiguous' && base.automatedLogin !== null
      ? {
        ...base,
        automatedLogin: {
          ...base.automatedLogin,
          failureConditions: { ...base.automatedLogin.failureConditions, accountLocked: AMBIGUOUS_LOCKED_CONDITION },
        },
      }
      : base;
    const config = createTestConfig(fixture.originA, '/');
    let launches = 0;
    let result: AutomatedLoginStageResult = { kind: 'STOPPED', submitted: 'NO' };
    let thrown: unknown = null;
    try {
      result = await runAutomatedLoginStage({
        config: { ...config, site: { ...config.site, allowedOrigins: [fixture.originA, fixture.originB] } },
        setup,
        approvedTestOrigins: [fixture.originA],
        expectedCredentialRevision: 1,
        readCredentialMetadata: () => credentials.store.readMetadata(PROFILE_ID),
        readCredential: () => credentials.store.decrypt(PROFILE_ID, fixture.originA),
        signal: new AbortController().signal,
        ...input.request,
      }, {
        launchAutomatedLoginBrowser: async () => {
          launches += 1;
          const browser = await launch();
          browsers.push(browser);
          return browser;
        },
        resultTimeoutMs: RESULT_TIMEOUT_MS,
        pollIntervalMs: POLL_INTERVAL_MS,
        formStepTimeoutMs: FORM_STEP_TIMEOUT_MS,
        ...input.dependencies,
      });
    } catch (error) {
      thrown = error;
    }
    await wait(QUIET_PERIOD_MS);
    return { result, thrown, requests: fixture.requests.slice(start), launches };
  }

  const nonReadRequests = (run: StageRun): readonly string[] =>
    run.requests.filter(({ method }) => !READ_METHODS.has(method)).map(({ method, path }) => `${method} ${path}`);

  /** 目印が、許した POST の本文のほかに出ないこと（要求の URL と本文、返す値、投げた誤り、console）。 */
  const expectNoSecretLeak = (run: StageRun): void => {
    const secrets = [username, password];
    const leaks = (text: string): boolean => secrets.some((secret) => text.includes(secret));
    for (const request of run.requests) {
      expect(leaks(request.path), request.path).toBe(false);
      if (request.method !== 'POST') {
        expect(leaks(request.body), `${request.method} ${request.path}`).toBe(false);
      }
    }
    expect(leaks(JSON.stringify(run.result))).toBe(false);
    expect(leaks(String(run.thrown))).toBe(false);
    const consoleText = consoleSpies.flatMap((spy) => spy.mock.calls.flat().map((value) => String(value))).join('\n');
    expect(leaks(consoleText)).toBe(false);
    expect(run.thrown).toBeNull();
  };

  /** 許した送信先への POST がちょうど 1 回で、その本文に目印がある。 */
  const expectOneAllowedPost = (run: StageRun, outcome: AutomatedLoginOutcome): void => {
    expect(nonReadRequests(run)).toEqual([`POST ${fixture.authPath(outcome)}`]);
    const post = run.requests.find(({ method }) => method === 'POST');
    expect(post?.body).toContain(username);
    expect(post?.body).toContain(password);
  };

  it('logs in, and filters the state to the approved Origin (only one POST reaches the server)', async () => {
    const run = await runStage();
    expect(run.result.kind).toBe('AUTHENTICATED');
    if (run.result.kind === 'AUTHENTICATED') {
      expect(run.result.state.cookies.map(({ name }) => name)).toEqual([FIXTURE_SESSION_COOKIE]);
      expect(run.result.state.origins.map(({ origin }) => origin)).toEqual([fixture.originA]);
      expect(run.result.state.origins[0]?.localStorage.map(({ name }) => name)).toEqual([FIXTURE_LOCAL_STORAGE_ITEM]);
    }
    expectOneAllowedPost(run, 'success');
    expectNoSecretLeak(run);
  }, TEST_TIMEOUT_MS);

  it('drops the cookie of another Origin from the state (same filtering as Task 25)', async () => {
    const run = await runStage({ outcome: 'success-idp' });
    expect(run.result.kind).toBe('AUTHENTICATED');
    if (run.result.kind === 'AUTHENTICATED') {
      expect(run.result.state.cookies.map(({ name, domain }) => `${domain} ${name}`)).toEqual([`127.0.0.1 ${FIXTURE_SESSION_COOKIE}`]);
      expect(run.result.state.origins.every(({ origin }) => origin === fixture.originA)).toBe(true);
    }
    expect(run.requests.some(({ site }) => site === 'B')).toBe(true);
    expectOneAllowedPost(run, 'success-idp');
    expectNoSecretLeak(run);
  }, TEST_TIMEOUT_MS);

  it.each(DISTINGUISHED)('distinguishes the %s outcome as %s (submitted: YES)', async (outcome, kind) => {
    const run = await runStage({ outcome });
    expect(run.result).toEqual({ kind, submitted: 'YES', retryAfterUntil: null });
    expectOneAllowedPost(run, outcome);
    expectNoSecretLeak(run);
  }, TEST_TIMEOUT_MS);

  // DEF-099 fix round 1: 送った後に応答がない（接続の断）回は、結果に「応答がなかった」の印を付ける（親が試しを 2 回と数える）。送り方は変えないので、
  // Chromium がログインの POST を送り直すことがある（サーバに届くのは 1 件か 2 件）。応答があった回（上の 500 など）は印を付けない。
  it('marks an unanswered login submission (responseAfterSubmission: false)', async () => {
    const run = await runStage({ outcome: 'drop' });
    expect(run.result).toEqual({ kind: 'AUTH_RESULT_UNKNOWN', submitted: 'YES', retryAfterUntil: null, responseAfterSubmission: false });
    const posts = nonReadRequests(run).length;
    expect(posts).toBeGreaterThanOrEqual(1);
    expect(posts).toBeLessThanOrEqual(2);
    expectNoSecretLeak(run);
  }, TEST_TIMEOUT_MS);

  it.each([
    ['rate-seconds', FIXTURE_RETRY_AFTER_SECONDS * SECOND_MS],
    ['rate-date', FIXTURE_RETRY_AFTER_DATE_OFFSET_MS],
  ] as const)('reads Retry-After of a 429 response (%s)', async (outcome, delayMs) => {
    const before = Date.now();
    const run = await runStage({ outcome });
    const after = Date.now();
    expect(run.result.kind).toBe('RATE_LIMITED');
    if (run.result.kind === 'RATE_LIMITED') {
      expect(run.result.submitted).toBe('YES');
      const until = run.result.retryAfterUntil?.getTime() ?? 0;
      expect(until).toBeGreaterThanOrEqual(before + delayMs - SECOND_MS);
      expect(until).toBeLessThanOrEqual(after + delayMs + SECOND_MS);
    }
    expectOneAllowedPost(run, outcome);
    expectNoSecretLeak(run);
  }, TEST_TIMEOUT_MS);

  it('keeps the values of the page scripts (sub frame POST to the endpoint, beacon, fetch) from reaching the server', async () => {
    const run = await runStage({ variant: 'scripted' });
    // T26g-1: 値が入ったときのサブ frame から送信先への POST を、Guard が送信の窓の中で止めた。押さずに `UNEXPECTED_LOGIN_REQUEST` で終える
    // （T26d-1 では、押して送ってから `AUTH_RESULT_UNKNOWN` にしていた。厳しい側に変わった）。
    expect(run.result).toEqual({ kind: 'UNEXPECTED_LOGIN_REQUEST', submitted: 'NO', retryAfterUntil: null });
    expect(nonReadRequests(run)).toEqual([]);
    expectNoSecretLeak(run);
  }, TEST_TIMEOUT_MS);

  it('returns RATE_LIMITED with submitted NO when the login page itself answers 429 (nothing is filled or posted)', async () => {
    const before = Date.now();
    const run = await runStage({ variant: 'rate-limited' });
    const after = Date.now();
    expect(run.result.kind).toBe('RATE_LIMITED');
    if (run.result.kind === 'RATE_LIMITED') {
      expect(run.result.submitted).toBe('NO');
      const until = run.result.retryAfterUntil?.getTime() ?? 0;
      expect(until).toBeGreaterThanOrEqual(before + FIXTURE_RETRY_AFTER_SECONDS * SECOND_MS - SECOND_MS);
      expect(until).toBeLessThanOrEqual(after + FIXTURE_RETRY_AFTER_SECONDS * SECOND_MS + SECOND_MS);
    }
    expect(nonReadRequests(run)).toEqual([]);
    expectNoSecretLeak(run);
  }, TEST_TIMEOUT_MS);

  it.each(INVALID_FORMS)('stops at the form check of the %s form without filling or posting (LOGIN_FORM_INVALID, %s)', async (variant, formInvalidReason) => {
    const run = await runStage({ variant });
    expect(run.result).toEqual({ kind: 'LOGIN_FORM_INVALID', submitted: 'NO', retryAfterUntil: null, formInvalidReason });
    expect(nonReadRequests(run)).toEqual([]);
    expectNoSecretLeak(run);
  }, TEST_TIMEOUT_MS);

  it('replaces a fill failure with LOGIN_FORM_INPUT_FAILED (nothing is posted)', async () => {
    const run = await runStage({ variant: 'disabled-user', dependencies: { formStepTimeoutMs: SHORT_FORM_STEP_TIMEOUT_MS } });
    expect(run.result).toEqual({ kind: 'LOGIN_FORM_INPUT_FAILED', submitted: 'NO', retryAfterUntil: null });
    expect(nonReadRequests(run)).toEqual([]);
    expectNoSecretLeak(run);
  }, TEST_TIMEOUT_MS);

  it('returns STOPPED without launching when the stop signal came first', async () => {
    const controller = new AbortController();
    controller.abort();
    const run = await runStage({ request: { signal: controller.signal } });
    expect(run.result).toEqual({ kind: 'STOPPED', submitted: 'NO' });
    expect(run.launches).toBe(0);
    expect(run.requests).toEqual([]);
    expectNoSecretLeak(run);
  }, TEST_TIMEOUT_MS);

  it('returns STOPPED with submitted YES when the stop signal comes while waiting for the result', async () => {
    const controller = new AbortController();
    onSlowPost = () => controller.abort();
    const run = await runStage({ outcome: 'slow', request: { signal: controller.signal } });
    // DEF-099 fix round 1: 送った後に応答がないまま止めた回も「応答がなかった」の印を付ける（試しを 2 回と数える。少なく数えない側）。
    expect(run.result).toEqual({ kind: 'STOPPED', submitted: 'YES', responseAfterSubmission: false });
    expectOneAllowedPost(run, 'slow');
    expectNoSecretLeak(run);
  }, TEST_TIMEOUT_MS);

  it('returns CREDENTIAL_CHANGED before launching when the revision differs from the expected one', async () => {
    const run = await runStage({ request: { expectedCredentialRevision: 2 } });
    expect(run.result).toEqual({ kind: 'CREDENTIAL_CHANGED', submitted: 'NO', retryAfterUntil: null });
    expect(run.launches).toBe(0);
    expect(run.requests).toEqual([]);
    expectNoSecretLeak(run);
  }, TEST_TIMEOUT_MS);

  it('returns CREDENTIAL_CHANGED before launching when the login Origin of the file differs', async () => {
    const run = await runStage({
      request: { readCredentialMetadata: async () => ({ credentialRevision: 1, loginOrigin: fixture.originB }) },
    });
    expect(run.result).toEqual({ kind: 'CREDENTIAL_CHANGED', submitted: 'NO', retryAfterUntil: null });
    expect(run.launches).toBe(0);
    expectNoSecretLeak(run);
  }, TEST_TIMEOUT_MS);

  it('returns CREDENTIAL_CHANGED when the revision changed between the check and the decryption (nothing is posted)', async () => {
    const run = await runStage({
      request: {
        readCredentialMetadata: () => credentials.store.readMetadata(CHANGING_PROFILE_ID),
        readCredential: async () => {
          await credentials.store.change({ profileId: CHANGING_PROFILE_ID, loginOrigin: fixture.originA, password });
          return credentials.store.decrypt(CHANGING_PROFILE_ID, fixture.originA);
        },
      },
    });
    expect(run.result).toEqual({ kind: 'CREDENTIAL_CHANGED', submitted: 'NO', retryAfterUntil: null });
    expect(nonReadRequests(run)).toEqual([]);
    expectNoSecretLeak(run);
  }, TEST_TIMEOUT_MS);

  it('returns CREDENTIAL_UNAVAILABLE when the credential cannot be decrypted (nothing is posted)', async () => {
    const run = await runStage({ request: { readCredential: () => credentials.storeWithOtherProtector.decrypt(PROFILE_ID, fixture.originA) } });
    expect(run.result).toEqual({ kind: 'CREDENTIAL_UNAVAILABLE', submitted: 'NO', retryAfterUntil: null });
    expect(nonReadRequests(run)).toEqual([]);
    expectNoSecretLeak(run);
  }, TEST_TIMEOUT_MS);

  it('returns CREDENTIAL_UNAVAILABLE before launching when there is no credential file', async () => {
    const run = await runStage({ request: { readCredentialMetadata: () => credentials.store.readMetadata(MISSING_PROFILE_ID) } });
    expect(run.result).toEqual({ kind: 'CREDENTIAL_UNAVAILABLE', submitted: 'NO', retryAfterUntil: null });
    expect(run.launches).toBe(0);
    expectNoSecretLeak(run);
  }, TEST_TIMEOUT_MS);

  it('treats a missing automatedLogin setting as a caller error', async () => {
    const setup = { ...setupFor('standard', 'success'), automatedLogin: null };
    const config = createTestConfig(fixture.originA, '/');
    await expect(runAutomatedLoginStage({
      config,
      setup,
      approvedTestOrigins: [fixture.originA],
      expectedCredentialRevision: 1,
      readCredentialMetadata: () => credentials.store.readMetadata(PROFILE_ID),
      readCredential: () => credentials.store.decrypt(PROFILE_ID, fixture.originA),
      signal: new AbortController().signal,
    }, { launchAutomatedLoginBrowser: launch })).rejects.toThrow(TypeError);
  });
});
