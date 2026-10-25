// T36R-fix（Task 36 の独立レビュー T36R の C-1・C-2・I-1・M-8。設計書 7 章の T36R の行）: 自動ログインのスクリプトで送るログインの段の Guard の、
// 資格情報の持ち出しの守りを広げた所。通す部品（どれも本物。Chromium はテストの既定の headless と、CLI の起動の設定の両方）:
// `BrowserContextFactory.createLoginStageContext` に、スクリプトのログインの口と、入れる資格情報から作った部品（`credentialGuard`）を渡す。サイトは
// テストだけのサイト（`startCredentialLeakSite`。レビュー担当の実験を写した）。
// - C-1: 要求のヘッダ（`x-leak`、`pushState` の後の `Referer`）と、要求に付く Cookie（そのままと `encodeURIComponent` の形）に入れたパスワードが、
//   サーバに届かない。
// - C-2: ブラウザが一部の文字だけを % の形にする URL（値をそのまま query と path に連結。「空白と /」「' と @」「ä と @」）でも届かない。
// - I-1: 方針で止めた要求（許可 Origin への POST）の path にパスワードがあっても、止めた一覧に行を作らない（資格情報の数に回す）。
// - M-8（設計者の既定）: ユーザー名は、読み取りでない要求だけで比べる（ユーザー名で読む GET は届き、ユーザー名を入れた POST は届かない）。
// 届いたかはサーバの記録で数える（承認した token の送信は除く）。各場面の終わりに、名前つきの時間（`LATE_REQUEST_WAIT_MS`）だけ待ってから数え直す。
// 値は出力しない。
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { AuditConfig } from '../../src/config/types.js';
import { createLoginCredentialGuard } from '../../src/safety/login-credential-guard.js';
import { LoginStageMonitor } from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import {
  LEAK_SITE_PATHS,
  LEAK_SITE_PCT_WRAPPED_PATH,
  recordCarries,
  startCredentialLeakSite,
  type CredentialLeakSite,
  type LeakSiteScenario,
} from '../helpers/credential-leak-site.js';
import { fastRunConfig } from '../helpers/run-harness.js';
import { TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

const LAUNCHERS: readonly (readonly [string, () => Promise<Browser>])[] = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI Chromium', () => launchCliChromium()],
];
const TEST_TIMEOUT_MS = 120_000;
const UI_TIMEOUT_MS = 15_000;
/** 送信を押した後、ページの経路が動き終わるまで待つ時間（ms）。 */
const SCENARIO_SETTLE_MS = 2_500;
/** 各場面の終わりに、遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 1_000;
const ONE_LOGIN_POST = 1;
const ONE_SIDE_POST = 1;

/** 試す資格情報（どれも匿名の仮の値）。c2〜c4 は、ブラウザが一部の文字だけを % の形にする値（C-2）。 */
const CREDENTIALS = Object.freeze({
  c1: { username: 'synth.user01@example.invalid', password: 'Zq9Kx7Lp3Wm' },
  c2: { username: 'synthuser02', password: 'Zq9 Kx/7Lp' },
  c3: { username: 'synthuser03', password: "Zq9'Kx@7Lp" },
  c4: { username: 'synthuser04', password: 'Zqä9Kx@7Lp' },
} as const);
type CredentialKey = keyof typeof CREDENTIALS;

describe.each(LAUNCHERS)('T36R-fix: the credential guard on the headers, the cookies, the browser-encoded URLs and the blocked list with %s', (_label, launch) => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await launch();
  });

  afterAll(async () => {
    await browser?.close();
  });

  /** 場面を流し、サーバの記録と monitor を返す。 */
  const runScenario = async (scenario: LeakSiteScenario, credentialKey: CredentialKey) => {
    const credentials = CREDENTIALS[credentialKey];
    const site: CredentialLeakSite = await startCredentialLeakSite(credentials.username, credentials.password);
    const base = fastRunConfig(site.appOrigin, LEAK_SITE_PATHS.auth);
    const config: AuditConfig = { ...base, site: { startUrl: `${site.appOrigin}${LEAK_SITE_PATHS.auth}`, allowedOrigins: [site.appOrigin] } };
    const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
    const monitor = new LoginStageMonitor();
    try {
      const context = await factory.createLoginStageContext(config.viewports.primaryDesktop, {
        loginPostEndpoints: [],
        maxLoginPosts: ONE_LOGIN_POST,
        monitor,
        scriptRequest: {
          scriptLogin: { origin: site.tokenOrigin, path: LEAK_SITE_PATHS.token, requiredQuery: [{ name: 'grant_type', value: 'password' }] },
          loginSideRequests: [{ origin: site.sideOrigin, path: LEAK_SITE_PATHS.side, method: 'POST', maxPerLoginStage: ONE_SIDE_POST }],
          approvedServiceOrigins: [site.tokenOrigin, site.sideOrigin],
        },
        credentialGuard: createLoginCredentialGuard(credentials),
      });
      const page = await factory.createPassivePage(context);
      await page.goto(`${site.appOrigin}${LEAK_SITE_PATHS.auth}?s=${scenario}`);
      await page.locator('#u').waitFor({ timeout: UI_TIMEOUT_MS });
      await page.locator('#u').fill(credentials.username);
      await page.locator('#p').fill(credentials.password);
      await page.locator('#b').click();
      await wait(SCENARIO_SETTLE_MS);
      await wait(LATE_REQUEST_WAIT_MS);
      /** 承認した token の送信を除いて、値を運んで届いた要求の数。 */
      const carrying = (value: string): number => site.records
        .filter((record) => !(record.origin === 'T' && record.method === 'POST'))
        .filter((record) => recordCarries(value, record)).length;
      return {
        passwordCarried: carrying(credentials.password),
        usernameCarried: carrying(credentials.username),
        arrived: (path: string): number => site.records.filter((record) => record.url.startsWith(path)).length,
        monitor,
        credentials,
      };
    } finally {
      await factory.close();
      await site.close();
    }
  };

  it.each<LeakSiteScenario>(['hdrGet', 'hdrSide', 'cookie', 'cookieRaw', 'referer'])(
    'C-1: keeps the password in %s from the server, and counts the blocked request',
    async (scenario) => {
      const { passwordCarried, monitor } = await runScenario(scenario, 'c1');
      expect(passwordCarried).toBe(0);
      expect(monitor.credentialRequestsBlocked()).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );

  it.each<readonly [LeakSiteScenario, CredentialKey]>([
    ['rawQuery', 'c2'], ['rawQuery', 'c3'], ['rawQuery', 'c4'],
    ['rawPath', 'c2'], ['rawPath', 'c3'], ['rawPath', 'c4'],
  ])('C-2: keeps the password concatenated as is in %s (%s) from the server', async (scenario, credentialKey) => {
    const { passwordCarried, monitor } = await runScenario(scenario, credentialKey);
    expect(passwordCarried).toBe(0);
    expect(monitor.credentialRequestsBlocked()).toBeGreaterThan(0);
  }, TEST_TIMEOUT_MS);

  // T36R2-fix（寛容な `%XX` の戻し方）: 値の UTF-8 のバイトをすべて `%XX` にし、前後に戻せないバイト（`%FF`・`%FE`）を付けた URL でも届かない。
  it.each<CredentialKey>(['c1', 'c2', 'c4'])('C-2: keeps the password fully percent-encoded between undecodable bytes (%s) from the server', async (credentialKey) => {
    const { passwordCarried, monitor, arrived } = await runScenario('pctWrapped', credentialKey);
    expect(arrived(LEAK_SITE_PCT_WRAPPED_PATH)).toBe(0);
    expect(passwordCarried).toBe(0);
    expect(monitor.credentialRequestsBlocked()).toBeGreaterThan(0);
  }, TEST_TIMEOUT_MS);

  it('I-1: does not list the path of a request blocked by the policy when it carries the password', async () => {
    const { passwordCarried, monitor, credentials } = await runScenario('postPathA', 'c1');
    expect(passwordCarried).toBe(0);
    const listed = JSON.stringify(monitor.snapshot().blockedRequests);
    expect(listed.includes(credentials.password) || listed.toLowerCase().includes(encodeURIComponent(credentials.password).toLowerCase())).toBe(false);
    expect(monitor.credentialRequestsBlocked()).toBe(1);
  }, TEST_TIMEOUT_MS);

  it('M-8: lets a read with the user name through, and blocks a non-read request with the user name', async () => {
    const read = await runScenario('usernameRead', 'c1');
    expect(read.arrived('/r/profile')).toBe(1);
    expect(read.monitor.credentialRequestsBlocked()).toBe(0);
    const post = await runScenario('usernamePost', 'c1');
    expect(post.usernameCarried).toBe(0);
    expect(post.monitor.credentialRequestsBlocked()).toBe(1);
  }, TEST_TIMEOUT_MS);
});
