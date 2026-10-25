// T26g-1（Task 26 の設計書 4.4、変更履歴の「T26R」の行の C1、「Blocker: T26g-1」の行）: ログインの段で、ページの JS が入力の値を、許した POST の
// ほかの要求で送ろうとする形（レビューの実験の 23 の形を写した fixture）を、自動ログインの段（`runAutomatedLoginStage`）と手動のログインの段
// （`runLoginStage`）で確かめる。127.0.0.1 の fixture のサーバ（A と、別の Origin のサーバ C）だけ。Chromium は headless だけ（テストの既定と、
// CLI の起動の設定（`launchCliChromium`）の両方）。資格情報の目印は、実行ごとのランダムな値。
// - 自動ログイン: どの形でも、目印は、A にも C にも、許した POST の本文のほかに届かない。値が入った時点で送ろうとする形は、押す前に
//   `UNEXPECTED_LOGIN_REQUEST`（送信 `NO`。POST 0 回）、押したときに GET に変える形は `UNEXPECTED_LOGIN_REQUEST`（送信 `UNKNOWN`）で、成功を偽装
//   しない。値を運べない favicon（path がちょうど `/favicon.ico`）は理由に数えず、正当なログインは成功する。
// - 手動のログインの段: 許可 Origin の外（C）への要求は届かない（人の入力の代わりに、テストだけの口 `onLoginPageReady` で入れる）。
import { randomBytes } from 'node:crypto';
import type { Browser, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import {type AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import { runLoginStage } from '../../src/worker/authenticated-login.js';
import { runAutomatedLoginStage, type AutomatedLoginStageResult } from '../../src/worker/automated-login.js';
import {
  AUTOMATED_LOGIN_FIXTURE_CONDITIONS,
  AUTOMATED_LOGIN_FIXTURE_SELECTORS,
  AUTOMATED_LOGIN_INPUT_LEAK_VARIANTS,
  AUTOMATED_LOGIN_SUBMIT_LEAK_VARIANTS,
  startAutomatedLoginFixture,
  type AutomatedLoginFixture,
  type AutomatedLoginFixtureRequest,
  type AutomatedLoginFormVariant,
} from '../helpers/automated-login-fixture.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { createTestConfig } from '../helpers/test-config.js';

const LAUNCHERS = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI launch settings', () => launchCliChromium()],
] as const;
const OUTCOME = 'success';
const RESULT_TIMEOUT_MS = 3_000;
const POLL_INTERVAL_MS = 100;
const FORM_STEP_TIMEOUT_MS = 5_000;
/** 手動のログインの段を待つ時間（ms）。 */
const MANUAL_LOGIN_TIMEOUT_MS = 20_000;
/** 終わった後に、遅れて届く要求を待つ時間（ms）。 */
const QUIET_PERIOD_MS = 500;
const TEST_TIMEOUT_MS = 60_000;
const marker = (prefix: string): string => `${prefix}${randomBytes(12).toString('hex')}`;

describe.each(LAUNCHERS)('T26g-1: hostile login pages (%s)', (_name, launch) => {
  const username = marker('u');
  const password = marker('p');
  let fixture: AutomatedLoginFixture;
  const browsers: Browser[] = [];

  beforeAll(async () => {
    fixture = await startAutomatedLoginFixture({ username, password });
  });

  afterEach(async () => {
    await Promise.all(browsers.splice(0).map((browser) => browser.close().catch(() => undefined)));
  });

  afterAll(async () => {
    await fixture?.close();
  });

  const launcher = async (): Promise<Browser> => {
    const browser = await launch();
    browsers.push(browser);
    return browser;
  };

  const setupFor = (variant: AutomatedLoginFormVariant): AuthSetup => ({
    ...FORM_NAVIGATION_SETUP_ITEMS,
    profileId: 'example-auth',
    profileRevision: 1,
    loginStartUrl: fixture.formUrl(variant, OUTCOME),
    loginPostEndpoints: [{ origin: fixture.originA, path: fixture.authPath(OUTCOME) }],
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

  /** 許した POST の本文のほかに、目印が届いた要求（`<site> <method> <path>` の形。目印の値は伏せる）。 */
  const leaksIn = (requests: readonly AutomatedLoginFixtureRequest[]): readonly string[] => requests
    .filter((request) => {
      const allowedPost = request.site === 'A' && request.method === 'POST' && request.path === fixture.authPath(OUTCOME);
      const text = allowedPost ? request.path : `${request.path} ${request.body}`;
      return text.includes(username) || text.includes(password);
    })
    .map(({ site, method, path }) => `${site} ${method} ${new URL(path, 'http://fixture.invalid').pathname}`);

  const nonReadRequests = (requests: readonly AutomatedLoginFixtureRequest[]): readonly string[] =>
    requests.filter(({ method }) => !READ_METHODS.has(method)).map(({ site, method, path }) => `${site} ${method} ${path}`);

  async function runAutomated(variant: AutomatedLoginFormVariant): Promise<{
    readonly result: AutomatedLoginStageResult;
    readonly requests: readonly AutomatedLoginFixtureRequest[];
  }> {
    const start = fixture.requests.length;
    const config = createTestConfig(fixture.originA, '/');
    const result = await runAutomatedLoginStage({
      config,
      setup: setupFor(variant),
      approvedTestOrigins: [fixture.originA],
      expectedCredentialRevision: 1,
      readCredentialMetadata: async () => ({ credentialRevision: 1, loginOrigin: fixture.originA }),
      readCredential: async () => ({ credentialRevision: 1, username, password }),
      signal: new AbortController().signal,
    }, {
      launchAutomatedLoginBrowser: launcher,
      resultTimeoutMs: RESULT_TIMEOUT_MS,
      pollIntervalMs: POLL_INTERVAL_MS,
      formStepTimeoutMs: FORM_STEP_TIMEOUT_MS,
    });
    await wait(QUIET_PERIOD_MS);
    const requests = fixture.requests.slice(start);
    expect(JSON.stringify(result)).not.toContain(username);
    expect(JSON.stringify(result)).not.toContain(password);
    return { result, requests };
  }

  it('logs in on a page that sends nothing else (baseline)', async () => {
    const { result, requests } = await runAutomated('standard');
    expect(result.kind).toBe('AUTHENTICATED');
    expect(nonReadRequests(requests)).toEqual([`A POST ${fixture.authPath(OUTCOME)}`]);
    expect(leaksIn(requests)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('does not count the plain browser favicon (it cannot carry a value)', async () => {
    const { result, requests } = await runAutomated('favicon-plain');
    expect(result.kind).toBe('AUTHENTICATED');
    expect(nonReadRequests(requests)).toEqual([`A POST ${fixture.authPath(OUTCOME)}`]);
    expect(leaksIn(requests)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it.each(AUTOMATED_LOGIN_INPUT_LEAK_VARIANTS)('stops %s in the submission window before the click (UNEXPECTED_LOGIN_REQUEST, NO)', async (variant) => {
    const { result, requests } = await runAutomated(variant);
    expect(leaksIn(requests)).toEqual([]);
    expect(requests.filter(({ site }) => site === 'C')).toEqual([]);
    expect(result).toEqual({ kind: 'UNEXPECTED_LOGIN_REQUEST', submitted: 'NO', retryAfterUntil: null });
    expect(nonReadRequests(requests)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it.each(AUTOMATED_LOGIN_SUBMIT_LEAK_VARIANTS)('stops %s in the submission window after the click (UNEXPECTED_LOGIN_REQUEST)', async (variant) => {
    const { result, requests } = await runAutomated(variant);
    expect(leaksIn(requests)).toEqual([]);
    expect(requests.filter(({ site }) => site === 'C')).toEqual([]);
    expect(result).toEqual({ kind: 'UNEXPECTED_LOGIN_REQUEST', submitted: 'UNKNOWN', retryAfterUntil: null });
    expect(nonReadRequests(requests)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it.each(['leak-img-third', 'leak-iframe-third', 'leak-fetch-third', 'leak-css-third'] as const)(
    'keeps the manual login stage from reaching another origin (%s)',
    async (variant) => {
      const start = fixture.requests.length;
      const config = createTestConfig(fixture.originA, '/');
      const result = await runLoginStage({
        config,
        setup: { ...setupFor(variant), automatedLogin: null, maxLoginAttempts: 1 },
        approvedTestOrigins: [fixture.originA],
        signal: new AbortController().signal,
        onAwaitingLogin: () => undefined,
      }, {
        launchLoginBrowser: launcher,
        loginTimeoutMs: MANUAL_LOGIN_TIMEOUT_MS,
        pollIntervalMs: POLL_INTERVAL_MS,
        onLoginPageReady: async (page: Page) => {
          // 人の入力の代わり（テストだけの口）。
          await page.fill(AUTOMATED_LOGIN_FIXTURE_SELECTORS.username, username);
          await page.fill(AUTOMATED_LOGIN_FIXTURE_SELECTORS.password, password);
          await page.click(AUTOMATED_LOGIN_FIXTURE_SELECTORS.submit);
        },
      });
      await wait(QUIET_PERIOD_MS);
      const requests = fixture.requests.slice(start);
      expect(result.kind).toBe('AUTHENTICATED');
      expect(requests.filter(({ site }) => site === 'C')).toEqual([]);
      expect(leaksIn(requests)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});
