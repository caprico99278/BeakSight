// FM2e（手を減らす段 2 の設計書 3A.4）: ログインの 3 つの欄（ユーザー名・パスワード・送信）の検出の部品（`readLoginFormFields`。入口の確かめと、手動の
// ログインの段の始めの観察が共用する。`src/worker/entry-check-page.ts`）を、本物の page（isolated world の読み取り）で確かめる。Chromium はテストの既定の
// headless と CLI の起動の設定の両方。
// - 各欄の見える候補がちょうど 1 つなら、その一意な CSS の案を出す。0 なら案なし（数は 0）。2 つ以上なら案なし（数は数える）。
// - 欄の値は読まない: 属性の `value` と、入れた値（目印）は、結果のどこにも出ない。
// 例の値は匿名の値だけ。
// FM2e（SLIM L-3 で前の login-field-proposal-stage をまとめた）: 手動のログインの段の始めに 3 つの欄を検出し（値は読まない）、成功したときに、その CSS の
// 案をログインの段の観察（`loginObservation.loginFields`）に載せる。本物のワーカーのログインの段（`runLoginStage`。factory と Guard は本物）と、127.0.0.1 の
// ログインの fixture（`startSpaAuthSite`）で確かめる。人の操作は、テストだけの口 `onLoginPageReady` で代える（目印の資格情報を入れて送る）。
// - 案は、ログインの画面の欄の一意な CSS（fixture の `SPA_LOGIN_FIELDS`）。IPC の契約（`AUTH_STATE`）を通り、ジョブの行のログインの段のまとめ（管理データ）に
//   残る（認証の設定には保存しない）。
// - 入れた値（目印）は、結果、IPC のメッセージ、管理データのファイル（WAL を含む）、標準出力と標準エラーのどこにも出ない（この段は成果物を書かない）。
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuditConfig } from '../../src/config/types.js';
import { AUTH_SETUP_SCHEMA_VERSION_3, type AuthSetupV3 } from '../../src/control/auth/auth-setup-contracts.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import { createStartingJob, readJob, recordAuthState } from '../../src/control/job/job-store.js';
import { getAuthSetup, saveAuthSetup } from '../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { getProfile } from '../../src/control/store/profile-store.js';
import { WORKER_PROTOCOL_VERSION, validateWorkerToParentMessage } from '../../src/control/worker-protocol.js';
import { wait } from '../../src/core/deadline.js';
import { formatCompactUtcTimestamp } from '../../src/core/utc-timestamp.js';
import { runLoginStage, type LoginStageResult } from '../../src/worker/authenticated-login.js';
import { readLoginFormFields } from '../../src/worker/entry-check-page.js';
import { chromiumRunsOf, launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { fastRunConfig } from '../helpers/run-harness.js';
import { SPA_APP_PATHS, SPA_LOGIN_FIELDS, startSpaAuthSite, type SpaAuthSite } from '../helpers/spa-auth-site-fixture.js';
import { createForkTestProfile } from '../helpers/worker-fork-support.js';

const LAUNCHERS: readonly (readonly [string, () => Promise<Browser>])[] = chromiumRunsOf([
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI Chromium', () => launchCliChromium()],
]);
const TEST_TIMEOUT_MS = 120_000;
/** 実行ごとの目印（値を出力しない。比べるときは真偽だけを見る）。 */
const VALUE_MARKER = `fm2e-value-${randomUUID()}`;
const TYPED_MARKER = `fm2e-typed-${randomUUID()}`;
/** 秘密に見える値（64 桁の 16 進。実行ごと）。 */
const SECRET_HEX = `${randomUUID()}${randomUUID()}`.split('-').join('');
/** 実行ごとの、案に入れてはいけない値の形（レビューの D5 の形。匿名の合成の値）。 */
const base64Of = (bytes: number): string => randomBytes(bytes).toString('base64').replace(/[+/=]/gu, 'x');
const SECRET_SHAPES: readonly (readonly [string, string])[] = [
  ['hex64', randomBytes(32).toString('hex')],
  ['hex32', randomBytes(16).toString('hex')],
  ['hex16', randomBytes(8).toString('hex')],
  ['uuid', randomUUID()],
  ['jwt-like', `eyJ${base64Of(18)}.eyJ${base64Of(24)}.${base64Of(24)}`],
  ['prefixed-hex', `user_${randomBytes(16).toString('hex')}`],
  ['bracket', `login[${randomBytes(16).toString('hex')}]`],
  ['email-like', 'someone@example.com'],
  ['digits-12', '482910374615'],
];
/** ふつうの名前と、その案（今どおり使う）。 */
const PLAIN_NAMES: readonly (readonly ['id' | 'name', string, string])[] = [
  ['id', 'username', '#username'],
  ['name', 'username', 'input[name="username"]'],
  ['name', 'login[email]', 'input[name="login[email]"]'],
  ['id', 'login-email-2', '#login-email-2'],
];

/** 3 つの欄がちょうど 1 つずつある画面（属性の `value` に目印を入れる）。 */
const ONE_EACH = `<form id="login-form" action="/session" method="post">
  <input id="email" name="email" type="email" value="${VALUE_MARKER}">
  <input name="password" type="password" value="${VALUE_MARKER}">
  <button type="submit">ログイン</button>
</form>`;

describe.each(LAUNCHERS)('FM2e: detecting the login fields without reading the values (%s)', (_label, launch) => {
  let browser: Browser | undefined;

  beforeAll(async () => {
    browser = await launch();
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await browser?.close();
  });

  const withPage = async <T>(html: string, use: (page: Page) => Promise<T>): Promise<T> => {
    const page = await (browser as Browser).newPage();
    try {
      await page.setContent(html);
      return await use(page);
    } finally {
      await page.close();
    }
  };

  it('proposes the unique CSS of each field with exactly one candidate, and never reads the values', async () => {
    const reading = await withPage(ONE_EACH, async (page) => {
      await page.locator('#email').fill(TYPED_MARKER);
      await page.locator('input[type="password"]').fill(TYPED_MARKER);
      return readLoginFormFields(page);
    });
    expect(reading?.fields).toEqual({
      username: { candidates: 1, selector: '#email' },
      password: { candidates: 1, selector: 'input[name="password"]' },
      submit: { candidates: 1, selector: 'button[type="submit"]' },
    });
    expect(reading?.placement).toBe('SAME');
    const text = JSON.stringify(reading);
    expect(text.includes(VALUE_MARKER)).toBe(false);
    expect(text.includes(TYPED_MARKER)).toBe(false);
  }, TEST_TIMEOUT_MS);

  it('proposes nothing for a field without a candidate', async () => {
    const reading = await withPage('<form><input id="q" name="q" type="search"><button type="submit">検索</button></form>', readLoginFormFields);
    expect(reading?.fields.username).toEqual({ candidates: 0, selector: null });
    expect(reading?.fields.password).toEqual({ candidates: 0, selector: null });
  }, TEST_TIMEOUT_MS);

  // FM2R の Minor 14（レビューの D3 の形）: 秘密に見える `id`・`name`（64 桁の 16 進など。判定は `isValueLikeText`）は、案の CSS に使わない。ほかの形
  // （`tag[type="…"]`）がちょうど 1 つに当たれば、それを案にする。値は、どの結果にも出ない。
  it('never puts a secret-looking id or name into the proposals, and falls back to another unique form', async () => {
    const reading = await withPage(`<form action="/session" method="post">
      <input id="t${SECRET_HEX}" type="text">
      <input name="p${SECRET_HEX}" type="password">
      <input id="pw-${SECRET_HEX}" name="pw_${SECRET_HEX}" type="hidden">
      <button id="go-${SECRET_HEX}" type="submit">ログイン</button>
    </form>`, readLoginFormFields);
    expect(JSON.stringify(reading).includes(SECRET_HEX)).toBe(false);
    expect(reading?.fields).toEqual({
      username: { candidates: 1, selector: 'input[type="text"]' },
      password: { candidates: 1, selector: 'input[type="password"]' },
      submit: { candidates: 1, selector: 'button[type="submit"]' },
    });
  }, TEST_TIMEOUT_MS);

  // FM2R の確かめ直しの R-2（レビューの D5 の形）: 値の形ごとに、`id` と `name` に入れても案に入らない（UUID、16 桁の 16 進、角括弧の中の 16 進、
  // 12 桁の数字などを含む）。ふつうの名前（`username`・`login[email]`）は、今どおり案に使う。
  it('never puts a value of any secret-looking shape into the proposals, and still uses the plain names', async () => {
    const carried: string[] = [];
    for (const [label, value] of SECRET_SHAPES) {
      for (const attribute of ['id', 'name'] as const) {
        const reading = await withPage(`<input type="text" class="other"><form action="/session" method="post">
          <input type="text" ${attribute}="${value.split('"').join('&quot;')}"><input type="password" name="pw"><button type="submit">ログイン</button>
        </form>`, readLoginFormFields);
        const text = JSON.stringify(reading);
        if (text.includes(value) || value.split(/[^A-Za-z0-9]+/u).some((part) => part.length >= 8 && text.includes(part))) {
          carried.push(`${label}/${attribute}`);
        }
      }
    }
    expect(carried).toEqual([]);
    for (const [attribute, value, selector] of PLAIN_NAMES) {
      const reading = await withPage(`<input type="text" class="other"><form action="/session" method="post">
        <input type="text" ${attribute}="${value}"><input type="password" name="pw"><button type="submit">ログイン</button>
      </form>`, readLoginFormFields);
      expect(reading?.fields.username.selector, `${attribute}=${value}`).toBe(selector);
    }
  }, TEST_TIMEOUT_MS);

  it('proposes nothing for a field with two or more candidates, and still proposes the other fields', async () => {
    const reading = await withPage(`<form>
      <input id="user" name="user" type="text"><input id="tenant" name="tenant" type="text">
      <input id="secret" name="secret" type="password">
      <button id="go" type="submit">ログイン</button><button id="again" type="submit">もう一度</button>
    </form>`, readLoginFormFields);
    expect(reading?.fields).toEqual({
      username: { candidates: 2, selector: null },
      password: { candidates: 1, selector: '#secret' },
      submit: { candidates: 2, selector: null },
    });
  }, TEST_TIMEOUT_MS);
});

const UI_TIMEOUT_MS = 15_000;
const LOGIN_TIMEOUT_MS = 30_000;
const LOGIN_POLL_MS = 100;
/** 終わりの後に、遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 1_000;

describe.each(LAUNCHERS)('FM2e: the login field proposals of the manual login stage, with %s', (label, launch) => {
  let site: SpaAuthSite | undefined;
  let workDirectory: string | undefined;
  let database: ControlDatabase | undefined;
  const browsers: Browser[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(browsers.splice(0).map((browser) => browser.close().catch(() => undefined)));
    if (database !== undefined) closeControlDatabase(database);
    database = undefined;
    await site?.close();
    site = undefined;
    if (workDirectory !== undefined) await rm(workDirectory, { recursive: true, force: true });
    workDirectory = undefined;
  });

  it(`puts the CSS of the three login fields in the observation of a successful manual login, without the typed values (${label})`, async () => {
    const spa = await startSpaAuthSite({});
    site = spa;
    workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-login-fields-'));
    const store = openControlDatabase(resolveControlDatabasePath(workDirectory));
    database = store;
    const profileId = `example-fields-${label.length}`;
    const targetConfigPath = `local/targets/${profileId}.json`;
    const config: AuditConfig = {
      ...fastRunConfig(spa.appOrigin, SPA_APP_PATHS.auth),
      site: { startUrl: `${spa.appOrigin}${SPA_APP_PATHS.auth}`, allowedOrigins: [spa.appOrigin] },
    };
    const resolveContext = (path: string): { readonly targetConfig: AuditConfig } | undefined => (path === targetConfigPath ? { targetConfig: config } : undefined);
    expect(createForkTestProfile(store, { profileId, targetConfigPath, auth: 'MANUAL_SESSION', approvedTestOrigins: [spa.appOrigin] }, resolveContext).ok).toBe(true);
    const formSetup: AuthSetupV3 = {
      schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
      profileId,
      profileRevision: MIN_PROFILE_REVISION,
      loginStartUrl: `${spa.appOrigin}${SPA_APP_PATHS.auth}`,
      loginPostEndpoints: [{ origin: spa.appOrigin, path: SPA_APP_PATHS.auth }],
      successCondition: { pathPrefix: SPA_APP_PATHS.admin, selector: null },
      sessionLostCondition: { pathPrefix: SPA_APP_PATHS.auth },
      excludedPaths: [SPA_APP_PATHS.logout],
      auditPathPrefixes: [],
      maxLoginAttempts: 1,
      allowedIdpOrigins: [],
      automatedLogin: null,
      loginSideRequests: [],
      loginTransport: 'FORM_NAVIGATION',
      scriptLogin: null,
      successStorageKey: null,
    };
    expect(saveAuthSetup(store, formSetup, { resolveContext }).ok).toBe(true);
    const profile = getProfile(store, profileId)?.profile;
    const setup = getAuthSetup(store, profileId)?.setup;
    if (profile === undefined || setup === undefined) throw new Error('the profile or the auth setup is missing');

    // 標準出力と標準エラー（ログ）を写す（目印が出ないことを確かめる。出力はそのまま流す）。
    const logged: string[] = [];
    for (const stream of [process.stdout, process.stderr]) {
      const write = stream.write.bind(stream);
      vi.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
        logged.push(String(chunk));
        return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof stream.write);
    }
    const result: LoginStageResult = await runLoginStage({
      config,
      setup,
      approvedTestOrigins: profile.approvedTestOrigins,
      approvedServiceOrigins: profile.approvedServiceOrigins ?? [],
      signal: new AbortController().signal,
      onAwaitingLogin: () => undefined,
    }, {
      launchLoginBrowser: async () => {
        const browser = await launch();
        browsers.push(browser);
        return browser;
      },
      loginTimeoutMs: LOGIN_TIMEOUT_MS,
      pollIntervalMs: LOGIN_POLL_MS,
      onLoginPageReady: async (page: Page) => {
        await page.locator(SPA_LOGIN_FIELDS.email).waitFor({ timeout: UI_TIMEOUT_MS });
        await spa.fillCredentials(async (selector, value) => page.locator(selector).fill(value));
        await page.locator(SPA_LOGIN_FIELDS.submit).click();
      },
    });
    await wait(LATE_REQUEST_WAIT_MS);
    vi.restoreAllMocks();

    expect(result.kind).toBe('AUTHENTICATED');
    // 案は、ログインの画面の欄の一意な CSS（値は持たない）。
    expect(result.loginObservation?.loginFields).toEqual({
      username: SPA_LOGIN_FIELDS.email,
      password: SPA_LOGIN_FIELDS.password,
      submit: SPA_LOGIN_FIELDS.submit,
    });

    // IPC の契約（`AUTH_STATE`）を通る。
    const message = {
      protocol: WORKER_PROTOCOL_VERSION,
      type: 'AUTH_STATE',
      state: 'AUTHENTICATED',
      sessionLostUrl: null,
      ...(result.passedRequests === undefined ? {} : { passedRequests: result.passedRequests }),
      ...(result.loginObservation === undefined ? {} : { loginObservation: result.loginObservation }),
    };
    expect(validateWorkerToParentMessage(JSON.parse(JSON.stringify(message)) as unknown).ok).toBe(true);

    // 管理データ: ジョブの行のログインの段のまとめに残る（ジョブの記録の自動の登録と同じ所で受ける形）。認証の設定は変えない。
    const jobId = `job-fm2e-${label.length}`;
    expect(createStartingJob(store, {
      jobId, jobKind: 'AUDIT', profileId, profileRevision: profile.revision, startNew: true,
      createdAt: formatCompactUtcTimestamp(new Date(), 'test job time'),
    }, () => null).ok).toBe(true);
    expect(recordAuthState(store, jobId, 'AUTHENTICATED', null, {
      scriptLogin: null,
      blockedRequests: null,
      ...(result.loginObservation === undefined ? {} : { observation: result.loginObservation }),
      ...(result.passedRequests === undefined ? {} : { passedRequests: result.passedRequests }),
    })).toBe(true);
    expect(readJob(store, jobId)?.loginStage?.observation?.loginFields).toEqual(result.loginObservation?.loginFields);
    expect(getAuthSetup(store, profileId)?.setup).toEqual(setup);

    // 入れた値（目印）は、どこにも出ない。
    const markers = spa.secretValues();
    expect(markers.length).toBeGreaterThan(2);
    const databasePath = resolveControlDatabasePath(workDirectory);
    // 結果の記録（ワーカーが親へ送る項目。ログインの後の状態はワーカーのメモリの中だけで、送らないので除く）。
    const { kind, blockedRequests, passedRequests, scriptLogin, loginObservation } = result;
    const places: readonly (readonly [string, string])[] = [
      ['result', JSON.stringify({ kind, blockedRequests, passedRequests, scriptLogin, loginObservation })],
      ['IPC', JSON.stringify(message)],
      ['job view', JSON.stringify(readJob(store, jobId))],
      ['management data', [databasePath, `${databasePath}-wal`].filter((path) => existsSync(path)).map((path) => readFileSync(path).toString('latin1')).join('\n')],
      ['log', logged.join('')],
    ];
    expect(places.flatMap(([place, text]) => markers.filter((marker) => text.includes(marker)).map(() => place))).toEqual([]);
  }, TEST_TIMEOUT_MS);
});
