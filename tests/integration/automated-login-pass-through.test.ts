// DEF-193（設計書 `doc/design/2026-11-04-beaksight-login-session-design.md` 3.2・5 章）: 自動ログインの段でも、監査の段の送信の扱い `PASS_EXCEPT_DELETE` を当てる
// （サイトが自動で送る通信は止めない。SD-2: 削除も届く）。本物の factory・Guard・出口の中継・資格情報の守りで、スクリプトで token を取るログインの後にページが送る
// 要求（`tests/helpers/login-pass-site.ts`）を確かめる。届いたかはサーバの記録で数え、名前つきの時間だけ待って数え直す。
// - `PASS_EXCEPT_DELETE`: サイトの 3 種の送信（サーバの関数、データの API、手続きの呼び出し）と token の更新は届く（ログインの送信の回数に数えない）。SD-2
//   （設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.4）: DELETE・DELETE の上書き・危険な語の path も届く。資格情報を含む要求と 2 回目の
//   ログインの送信は届かない。中継は、Guard が通した要求の写しだけを通す（中継が拒んだ記録はない）。
// - `READ_ONLY`（人が選んだとき）: 今のまま、登録のない送信と token の更新は届かない（直す前と同じ形。RED の形）。
// Chromium はテストの既定の headless と、CLI の起動の設定の両方。
import type { Browser } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { AuditSendPolicyName } from '../../src/core/audit-send-policy.js';
import { wait } from '../../src/core/deadline.js';
import { createLoginCredentialGuard } from '../../src/safety/login-credential-guard.js';
import { LoginStageMonitor } from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { BOTH_CHROMIUM_LAUNCHERS } from '../helpers/chromium.js';
import { LOGIN_PASS_SITE_PATHS, LOGIN_PASS_SITE_REPEATS, startLoginPassSite, type LoginPassSite } from '../helpers/login-pass-site.js';
import { createTestConfig, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

/** 押した後の結果を待つ上限。 */
const RESULT_TIMEOUT_MS = 30_000;
/** 遅れて届く要求を待つ時間（数え直す）。 */
const LATE_REQUEST_WAIT_MS = 1_000;
const TEST_TIMEOUT_MS = 120_000;
/** サイトが自動で送る 3 種。 */
const SITE_SENDS = [LOGIN_PASS_SITE_PATHS.functionCall, LOGIN_PASS_SITE_PATHS.dataApi, LOGIN_PASS_SITE_PATHS.procedure] as const;
/** 守りが残る要求の、ページの結果の名前。 */
const GUARDED_RESULTS = ['credBody', 'credQuery', 'credHeader', 'secondLogin'] as const;
/** SD-2: 届くようになった、削除と危険な語の要求の、ページの結果の名前。 */
const SELF_DELETE_RESULTS = ['deleteMethod', 'overrideDelete', 'dangerPath'] as const;

interface LoginStageOutcome {
  readonly results: Readonly<Record<string, number>>;
  /** 届いた要求（事前確認のほか）の `<method> <path> <grant_type>` の数。 */
  readonly arrived: Readonly<Record<string, number>>;
  readonly credentialArrivals: number;
  readonly monitor: ReturnType<LoginStageMonitor['snapshot']>;
  readonly credentialRequestsBlocked: number;
  readonly ledger: ReturnType<SafetyLedger['snapshot']>;
}

describe.each(BOTH_CHROMIUM_LAUNCHERS)('DEF-193: the automated login stage passes the site sends except the deletion (%s)', (_label, launch) => {
  let site: LoginPassSite | undefined;
  let browser: Browser | undefined;
  let factory: BrowserContextFactory | undefined;

  afterEach(async () => {
    await factory?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await site?.close();
    factory = undefined;
    browser = undefined;
    site = undefined;
  });

  const signIn = async (sendPolicy: AuditSendPolicyName): Promise<LoginStageOutcome> => {
    site = await startLoginPassSite();
    const started = site;
    browser = await launch();
    const config = createTestConfig(started.appOrigin, '/auth', { audit: { sendPolicy } });
    factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
    const monitor = new LoginStageMonitor();
    const context = await factory.createLoginStageContext(config.viewports.primaryDesktop, {
      loginPostEndpoints: [],
      maxLoginPosts: 1,
      monitor,
      scriptRequest: {
        scriptLogin: { origin: started.svcOrigin, path: LOGIN_PASS_SITE_PATHS.token, requiredQuery: [{ name: 'grant_type', value: 'password' }] },
        loginSideRequests: [],
        approvedServiceOrigins: [started.svcOrigin],
      },
      credentialGuard: createLoginCredentialGuard({ username: started.username, password: started.password }),
    });
    const page = await factory.createPassivePage(context);
    await page.goto(`${started.appOrigin}/auth`);
    await page.locator('#email').fill(started.username);
    await page.locator('#password').fill(started.password);
    await page.locator('#submit').click();
    await page.locator('#state[data-state="done"], #state[data-state="login-failed"]').waitFor({ state: 'attached', timeout: RESULT_TIMEOUT_MS });
    const results = JSON.parse((await page.locator('#state').getAttribute('data-results')) ?? '{}') as Record<string, number>;
    const count = (): Record<string, number> => started.records.filter(({ preflight }) => !preflight).reduce<Record<string, number>>((acc, record) => {
      const key = `${record.method} ${record.path} ${record.grantType ?? '-'}`;
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
    const arrived = count();
    // 名前つきの時間だけ待って、遅れて届く要求を数え直す。
    await wait(LATE_REQUEST_WAIT_MS);
    expect(count()).toEqual(arrived);
    const outcome: LoginStageOutcome = {
      results,
      arrived,
      credentialArrivals: started.records.filter(({ carriesCredential, preflight }) => carriesCredential && !preflight).length,
      monitor: monitor.snapshot(),
      credentialRequestsBlocked: monitor.credentialRequestsBlocked(),
      ledger: factory.getSafetyLedger(context).snapshot(),
    };
    await factory.closePassiveContext(context);
    return outcome;
  };

  it('delivers the three site sends, the deletion, the dangerous path and the token refresh, and keeps the credential and second login requests blocked', async () => {
    const outcome = await signIn('PASS_EXCEPT_DELETE');
    const { svcOrigin } = site as LoginPassSite;

    // サーバに届いたのは、ログインの送信 1 回、サイトの 3 種の各 2 回、SD-2 の削除・削除の上書き・危険な語の path、token の更新 1 回だけ。
    expect(outcome.arrived).toEqual({
      [`POST ${LOGIN_PASS_SITE_PATHS.token} password`]: 1,
      ...Object.fromEntries(SITE_SENDS.map((path) => [`POST ${path} -`, LOGIN_PASS_SITE_REPEATS])),
      [`POST ${LOGIN_PASS_SITE_PATHS.dataApi} -`]: LOGIN_PASS_SITE_REPEATS + 1,
      [`DELETE ${LOGIN_PASS_SITE_PATHS.dataApi} -`]: 1,
      [`POST ${LOGIN_PASS_SITE_PATHS.dangerous} -`]: 1,
      [`POST ${LOGIN_PASS_SITE_PATHS.token} refresh_token`]: 1,
    });
    expect(SELF_DELETE_RESULTS.map((name) => outcome.results[name])).toEqual(SELF_DELETE_RESULTS.map(() => 200));
    // 資格情報を含んで届いたのは、承認した token の送信だけ。
    expect(outcome.credentialArrivals).toBe(1);
    for (let index = 0; index < LOGIN_PASS_SITE_REPEATS; index += 1) {
      expect([outcome.results[`function${String(index)}`], outcome.results[`api${String(index)}`], outcome.results[`rpc${String(index)}`]]).toEqual([200, 200, 200]);
    }
    expect(outcome.results['tokenRefresh']).toBe(200);
    expect(GUARDED_RESULTS.map((name) => outcome.results[name])).toEqual(GUARDED_RESULTS.map(() => 0));

    // token の更新とサイトの送信は、ログインの送信の回数に数えない（通したのは承認した 1 回だけ。2 回目のログインの送信は上限で止めた）。
    const { scriptRequest, passedRequests, blockedRequests } = outcome.monitor;
    expect(scriptRequest.tokenRequestsAllowed).toBe(1);
    expect(scriptRequest.blockedByScriptReason.TOKEN_REQUEST_OVER_LIMIT).toBe(1);
    expect(scriptRequest.blockedByScriptReason.TOKEN_REQUEST_QUERY_MISMATCH).toBe(0);
    expect(outcome.credentialRequestsBlocked).toBe(3);
    // 通した送信は、通した一覧に、登録の対象でない理由で記録する（Origin と path と回数。値は持たない。DEF-194）。
    // SD-2: データの API の行には、DELETE と DELETE の上書きの 2 回も数える。危険な語の path も通した行になる。
    expect(passedRequests.requests.map(({ origin, path, count, reason }) => ({ origin, path, count, reason })).sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { origin: svcOrigin, path: LOGIN_PASS_SITE_PATHS.token, count: 1, reason: 'AUTOMATED_LOGIN_PASSED' },
      ...SITE_SENDS.map((path) => ({
        origin: svcOrigin, path, count: LOGIN_PASS_SITE_REPEATS + (path === LOGIN_PASS_SITE_PATHS.dataApi ? 2 : 0), reason: 'AUTOMATED_LOGIN_PASSED',
      })),
      { origin: svcOrigin, path: LOGIN_PASS_SITE_PATHS.dangerous, count: 1, reason: 'AUTOMATED_LOGIN_PASSED' },
    ].sort((a, b) => a.path.localeCompare(b.path)));
    expect(passedRequests.requests.some(({ beforeToken }) => beforeToken !== undefined)).toBe(false);
    // 止めた一覧: 2 回目のログインの送信だけ（SD-2: 決まりで止めた行 `AUTOMATED_LOGIN_RULE_BLOCKED` は出ない）。
    expect(blockedRequests.requests.map(({ path, count, reason }) => ({ path, count, reason }))).toEqual([
      { path: LOGIN_PASS_SITE_PATHS.token, count: 1, reason: 'TOKEN_REQUEST_OVER_LIMIT' },
    ]);
    // 中継は、Guard が通した要求の写しで通した（中継が拒んだ記録も、違反もない）。
    expect(outcome.ledger.blockedInteractionRequests).toEqual([]);
    expect(outcome.ledger.invariantViolationCount).toBe(0);
  }, TEST_TIMEOUT_MS);

  it('keeps the site sends and the token refresh blocked when the person chose READ_ONLY (the form before DEF-193)', async () => {
    const outcome = await signIn('READ_ONLY');
    expect(outcome.arrived).toEqual({ [`POST ${LOGIN_PASS_SITE_PATHS.token} password`]: 1 });
    expect(outcome.credentialArrivals).toBe(1);
    expect(outcome.results['tokenRefresh']).toBe(0);
    expect(outcome.monitor.scriptRequest.tokenRequestsAllowed).toBe(1);
    expect(outcome.monitor.passedRequests.requests).toEqual([]);
    expect(outcome.ledger.invariantViolationCount).toBe(0);
  }, TEST_TIMEOUT_MS);
});
