// T33b（Task 33 の設計書 3.2、6 章の G33 の 2）: スクリプトで送るログインの SPA の fixture（`tests/helpers/spa-auth-site-fixture.ts`）の振る舞いを、
// Guard のない Playwright のブラウザ（テストの既定の headless と、CLI の起動の設定の Chromium の両方）で確かめる。BeakSight の部品は通さない（fixture
// そのものの確かめ。今の BeakSight の振る舞いは T33c）。
// - ログイン（token の POST と、その事前確認がバックエンドに届く。ローカル ストレージに保存して `/admin` へ移る）、誤ったパスワードの誤りの表示、一覧、
//   登録、更新（前の値の読み取り）、削除、論理削除、token の更新、RPC の読み取り、WebSocket、認証の Origin を分ける指定、敵対的なログインの要求の形、
//   ログアウト、記録に秘密の値が出ないこと。
// fixture は 127.0.0.1 だけ。Chromium は headless だけ。値（資格情報・token・API の鍵）は出力しない。
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import {
  SPA_API_KEY_HEADER,
  SPA_APP_PATHS,
  SPA_AUTH_STORAGE_KEY,
  SPA_BACKEND_PATHS,
  SPA_GRANT_TYPES,
  SPA_LOGIN_ERROR_TEXT,
  SPA_LOGIN_FIELDS,
  SPA_MEMBER_FIELDS,
  SPA_PREFER_HEADER,
  SPA_REFRESH_LOOP_COUNT,
  SPA_STATE_ELEMENTS,
  spaMemberEditPathOf,
  startSpaAuthSite,
  type SpaAuthSite,
  type SpaAuthSiteOptions,
  type SpaAuthSiteRequest,
  type SpaHostileLogin,
} from '../helpers/spa-auth-site-fixture.js';

/** 1 つの場面の上限（ms）。 */
const TEST_TIMEOUT_MS = 60_000;
/** 画面の状態を待つ上限（ms）。 */
const UI_TIMEOUT_MS = 15_000;
/** token の更新までの時間（ms。短くする）。 */
const SHORT_REFRESH_MS = 300;
/** 既存の会員の名前と、登録・更新で入れる値（匿名の合成の値）。 */
const EXISTING_NAME = '既存花子';
const CREATED = Object.freeze({ name: '登録一郎', email: 'created0001@example.invalid', note: '登録の備考' });
const UPDATED_NAME = '更新太郎';

/** 確かめる 2 つの Chromium（テストの既定の headless と、CLI の起動の設定）。 */
const BROWSERS: readonly (readonly [string, () => Promise<Browser>])[] = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI Chromium', () => launchCliChromium()],
];

const passwordTokenPath = `${SPA_BACKEND_PATHS.token}?grant_type=${SPA_GRANT_TYPES.password}`;
const refreshTokenPath = `${SPA_BACKEND_PATHS.token}?grant_type=${SPA_GRANT_TYPES.refresh}`;

/** 本番の要求（事前確認を除く）のうち、`origin` に届いた `method path` の形。 */
const shapesOf = (requests: readonly SpaAuthSiteRequest[], origin: SpaAuthSiteRequest['origin']): readonly string[] =>
  requests.filter((request) => request.origin === origin && !request.preflight).map(({ method, path }) => `${method} ${path}`);

/** `method path` の本番の要求（最初の 1 つ）。 */
const requestOf = (requests: readonly SpaAuthSiteRequest[], method: string, path: string): SpaAuthSiteRequest | undefined =>
  requests.find((request) => !request.preflight && request.method === method && request.path === path);

/** 事前確認の要求（`path` への）があるか。 */
const hasPreflight = (requests: readonly SpaAuthSiteRequest[], path: string): boolean =>
  requests.some((request) => request.preflight && request.method === 'OPTIONS' && request.path === path);

describe.each(BROWSERS)('T33b: the SPA auth site fixture with %s (no Guard)', (_label, launch) => {
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let site: SpaAuthSite | undefined;

  beforeAll(async () => {
    browser = await launch();
  });

  afterEach(async () => {
    await context?.close();
    context = undefined;
    await site?.close();
    site = undefined;
  });

  afterAll(async () => {
    await browser?.close();
  });

  /** fixture を起動し、新しい Context の新しいページを返す。 */
  const open = async (options: SpaAuthSiteOptions = {}): Promise<{ readonly spa: SpaAuthSite; readonly page: Page }> => {
    if (browser === undefined) {
      throw new Error('Chromium がない');
    }
    site = await startSpaAuthSite(options);
    context = await browser.newContext();
    return { spa: site, page: await context.newPage() };
  };

  /** ログインの画面でログインする（`password` を渡すと、その値で送る）。 */
  const login = async (spa: SpaAuthSite, page: Page, password?: string): Promise<void> => {
    await page.goto(`${spa.appOrigin}${SPA_APP_PATHS.auth}`);
    await spa.fillCredentials(async (selector, value) => page.locator(selector).fill(value));
    if (password !== undefined) {
      await page.locator(SPA_LOGIN_FIELDS.password).fill(password);
    }
    await page.locator(SPA_LOGIN_FIELDS.submit).click();
  };

  /** ログインして、一覧を読み終えるまで待つ。 */
  const loginToAdmin = async (spa: SpaAuthSite, page: Page): Promise<void> => {
    await login(spa, page);
    await page.waitForURL(`${spa.appOrigin}${SPA_APP_PATHS.admin}`, { timeout: UI_TIMEOUT_MS });
    await page.locator(`#${SPA_STATE_ELEMENTS.members}[data-state="loaded"]`).waitFor({ timeout: UI_TIMEOUT_MS });
  };

  /** ローカル ストレージの、ログインの状態の最上位の鍵の名前（なければ null）。 */
  const storedKeys = (page: Page): Promise<readonly string[] | null> => page.evaluate((key) => {
    const text = localStorage.getItem(key);
    return text === null ? null : Object.keys(JSON.parse(text) as Record<string, unknown>).sort();
  }, SPA_AUTH_STORAGE_KEY);

  it('logs in by the script: the token POST and its preflight reach the backend, the state is stored, and the list is read with the Bearer', async () => {
    const { spa, page } = await open();
    spa.addMember(EXISTING_NAME);
    await loginToAdmin(spa, page);
    expect(spa.successfulLogins).toBe(1);
    expect(hasPreflight(spa.requests, passwordTokenPath)).toBe(true);
    const token = requestOf(spa.requests, 'POST', passwordTokenPath);
    expect(token).toMatchObject({ origin: 'backend', bearerValid: null, bodyKeys: ['email', 'password'] });
    expect(token?.headerNames).toEqual(expect.arrayContaining([SPA_API_KEY_HEADER, 'content-type', 'origin']));
    expect(await storedKeys(page)).toEqual(['access_token', 'expires_at', 'expires_in', 'refresh_token', 'token_type']);
    const list = requestOf(spa.requests, 'GET', `${SPA_BACKEND_PATHS.members}?select=*`);
    expect(list).toMatchObject({ origin: 'backend', bearerValid: true });
    expect(list?.headerNames).toEqual(expect.arrayContaining([SPA_API_KEY_HEADER, 'authorization']));
    expect(hasPreflight(spa.requests, `${SPA_BACKEND_PATHS.members}?select=*`)).toBe(true);
    // 画面は、ページの移動だけでアプリの Origin に要求する（ログインと一覧は、どちらもバックエンドへのスクリプトの要求）。
    expect(shapesOf(spa.requests, 'app')).toEqual([
      `GET ${SPA_APP_PATHS.auth}`, `GET ${SPA_APP_PATHS.script}`, `GET ${SPA_APP_PATHS.admin}`, `GET ${SPA_APP_PATHS.script}`,
    ]);
    const rows = page.locator(`#${SPA_STATE_ELEMENTS.members} tbody tr`);
    expect(await rows.count()).toBe(1);
    expect(await rows.first().textContent()).toContain(EXISTING_NAME);
    expect(await page.locator('#new-member').getAttribute('href')).toBe(SPA_APP_PATHS.memberNew);
    expect(await rows.first().locator('a').getAttribute('href')).toBe(spaMemberEditPathOf(1));
  }, TEST_TIMEOUT_MS);

  it('shows the error for a wrong password, stores nothing and stays on the login screen', async () => {
    const { spa, page } = await open();
    await login(spa, page, 'wrong-password');
    const error = page.locator(`#${SPA_STATE_ELEMENTS.loginError}[data-state="shown"]`);
    await error.waitFor({ timeout: UI_TIMEOUT_MS });
    expect(await error.textContent()).toBe(SPA_LOGIN_ERROR_TEXT);
    expect(spa.successfulLogins).toBe(0);
    expect(requestOf(spa.requests, 'POST', passwordTokenPath)).toMatchObject({ bodyKeys: ['email', 'password'] });
    expect(await storedKeys(page)).toBeNull();
    expect(new URL(page.url()).pathname).toBe(SPA_APP_PATHS.auth);
  }, TEST_TIMEOUT_MS);

  it('sends the admin screen without a stored state back to the login screen, and reads nothing from the backend', async () => {
    const { spa, page } = await open();
    await page.goto(`${spa.appOrigin}${SPA_APP_PATHS.admin}`);
    await page.waitForURL(`${spa.appOrigin}${SPA_APP_PATHS.auth}`, { timeout: UI_TIMEOUT_MS });
    expect(spa.requests.filter((request) => request.origin !== 'app')).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('creates a member with a JSON POST that asks for the representation', async () => {
    const { spa, page } = await open();
    await loginToAdmin(spa, page);
    await page.locator('#new-member').click();
    await page.locator('#member-form[data-state="ready"]').waitFor({ timeout: UI_TIMEOUT_MS });
    await page.locator(SPA_MEMBER_FIELDS.name).fill(CREATED.name);
    await page.locator(SPA_MEMBER_FIELDS.email).fill(CREATED.email);
    await page.locator(SPA_MEMBER_FIELDS.note).fill(CREATED.note);
    await page.locator(SPA_MEMBER_FIELDS.submit).click();
    await page.waitForURL(`${spa.appOrigin}${SPA_APP_PATHS.admin}`, { timeout: UI_TIMEOUT_MS });
    await page.locator(`#${SPA_STATE_ELEMENTS.members}[data-state="loaded"] tbody tr`).first().waitFor({ timeout: UI_TIMEOUT_MS });
    const created = requestOf(spa.requests, 'POST', SPA_BACKEND_PATHS.members);
    expect(created).toMatchObject({ origin: 'backend', bearerValid: true, bodyKeys: ['email', 'name', 'note'] });
    expect(created?.headerNames).toEqual(expect.arrayContaining([SPA_API_KEY_HEADER, 'authorization', 'content-type', SPA_PREFER_HEADER.name]));
    expect(hasPreflight(spa.requests, SPA_BACKEND_PATHS.members)).toBe(true);
    expect(spa.memberCount).toBe(1);
    expect(spa.memberOf(1)).toEqual({ id: 1, ...CREATED, deleted: false });
  }, TEST_TIMEOUT_MS);

  it('updates a member after reading the previous values, deletes logically with the deleted field, and deletes with DELETE', async () => {
    const { spa, page } = await open();
    const id = spa.addMember(EXISTING_NAME);
    await loginToAdmin(spa, page);
    await page.locator(`tr[data-member-id="${String(id)}"] a`).click();
    await page.locator('#member-form[data-state="ready"]').waitFor({ timeout: UI_TIMEOUT_MS });
    // 前の値の読み取り（`id=eq.<id>`）と、画面の欄の前の値。
    expect(requestOf(spa.requests, 'GET', `${SPA_BACKEND_PATHS.members}?id=eq.${String(id)}`)).toMatchObject({ bearerValid: true });
    expect(await page.locator(SPA_MEMBER_FIELDS.name).inputValue()).toBe(EXISTING_NAME);
    expect(await page.locator(SPA_MEMBER_FIELDS.deleted).isChecked()).toBe(false);

    await page.locator(SPA_MEMBER_FIELDS.name).fill(UPDATED_NAME);
    await page.locator(SPA_MEMBER_FIELDS.submit).click();
    await page.locator(`#${SPA_STATE_ELEMENTS.member}[data-state="updated"]`).waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
    const patches = spa.requests.filter((request) => !request.preflight && request.method === 'PATCH');
    expect(patches.map(({ path, bodyKeys, bearerValid }) => [path, bodyKeys, bearerValid]))
      .toEqual([[`${SPA_BACKEND_PATHS.members}?id=eq.${String(id)}`, ['deleted', 'email', 'name', 'note'], true]]);
    expect(patches[0]?.headerNames).toEqual(expect.arrayContaining([SPA_PREFER_HEADER.name]));
    expect(spa.memberOf(id)).toMatchObject({ name: UPDATED_NAME, deleted: false });

    // 論理削除（`deleted` の欄）。
    await page.locator(SPA_MEMBER_FIELDS.deleted).check();
    await page.locator(SPA_MEMBER_FIELDS.submit).click();
    await expect.poll(() => spa.memberOf(id)?.deleted, { timeout: UI_TIMEOUT_MS }).toBe(true);
    expect(spa.requests.filter((request) => !request.preflight && request.method === 'PATCH')).toHaveLength(2);

    // 削除（`DELETE`）。
    await page.locator(SPA_MEMBER_FIELDS.remove).click();
    await page.waitForURL(`${spa.appOrigin}${SPA_APP_PATHS.admin}`, { timeout: UI_TIMEOUT_MS });
    expect(requestOf(spa.requests, 'DELETE', `${SPA_BACKEND_PATHS.members}?id=eq.${String(id)}`)).toMatchObject({ bearerValid: true, bodyKeys: [] });
    expect(spa.memberOf(id)).toBeUndefined();
  }, TEST_TIMEOUT_MS);

  it('refreshes the token after refreshAfterMs with a refresh_token POST, and stores the new state', async () => {
    const { spa, page } = await open({ refreshAfterMs: SHORT_REFRESH_MS });
    await loginToAdmin(spa, page);
    const before = await page.evaluate((key) => localStorage.getItem(key), SPA_AUTH_STORAGE_KEY);
    await page.locator(`#${SPA_STATE_ELEMENTS.refresh}[data-state="refreshed"]`).waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
    expect(spa.refreshes).toBe(1);
    expect(requestOf(spa.requests, 'POST', refreshTokenPath)).toMatchObject({ origin: 'backend', bearerValid: null, bodyKeys: ['refresh_token'] });
    expect(hasPreflight(spa.requests, refreshTokenPath)).toBe(true);
    expect(await page.evaluate((key) => localStorage.getItem(key), SPA_AUTH_STORAGE_KEY)).not.toBe(before);
  }, TEST_TIMEOUT_MS);

  it('reads the list with the RPC POST (rpcReads)', async () => {
    const { spa, page } = await open({ rpcReads: true });
    spa.addMember(EXISTING_NAME);
    await loginToAdmin(spa, page);
    expect(requestOf(spa.requests, 'POST', SPA_BACKEND_PATHS.rpcListMembers)).toMatchObject({ bearerValid: true, bodyKeys: [] });
    expect(requestOf(spa.requests, 'GET', `${SPA_BACKEND_PATHS.members}?select=*`)).toBeUndefined();
    expect(await page.locator(`#${SPA_STATE_ELEMENTS.members} tbody tr`).count()).toBe(1);
  }, TEST_TIMEOUT_MS);

  it('connects the WebSocket from the admin screen (websocket)', async () => {
    const { spa, page } = await open({ websocket: true });
    await loginToAdmin(spa, page);
    await page.locator(`#${SPA_STATE_ELEMENTS.websocket}[data-state="open"]`).waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
    expect(spa.requests.filter((request) => request.method === 'UPGRADE').map(({ origin, path }) => [origin, path]))
      .toEqual([['backend', SPA_BACKEND_PATHS.realtime]]);
  }, TEST_TIMEOUT_MS);

  it('sends the token POST to the separate auth origin and the API to the backend (separateAuthOrigin)', async () => {
    const { spa, page } = await open({ separateAuthOrigin: true });
    await loginToAdmin(spa, page);
    expect(spa.tokenOrigin).toBe(spa.authOrigin);
    expect(shapesOf(spa.requests, 'auth')).toEqual([`POST ${passwordTokenPath}`]);
    expect(shapesOf(spa.requests, 'backend')).toEqual([`GET ${SPA_BACKEND_PATHS.members}?select=*`]);
    expect(spa.requests.some((request) => request.origin === 'auth' && request.preflight)).toBe(true);
  }, TEST_TIMEOUT_MS);

  it.each<readonly [SpaHostileLogin, (spa: SpaAuthSite) => readonly (readonly [SpaAuthSiteRequest['origin'], string])[], boolean]>([
    ['loginTwice', () => [['backend', `POST ${passwordTokenPath}`], ['backend', `POST ${passwordTokenPath}`]], true],
    ['loginOtherGrant', () => [['backend', `POST ${SPA_BACKEND_PATHS.token}?grant_type=${SPA_GRANT_TYPES.other}`]], false],
    ['loginToThirdOrigin', () => [['other', `POST ${passwordTokenPath}`]], true],
    ['loginExtraPost', () => [['backend', `POST ${passwordTokenPath}`], ['backend', `POST ${SPA_BACKEND_PATHS.rpcLogLogin}`]], true],
    ['refreshLoop', () => [['backend', `POST ${passwordTokenPath}`],
      ...Array.from({ length: SPA_REFRESH_LOOP_COUNT }, () => ['backend', `POST ${refreshTokenPath}`] as const)], true],
  ])('sends the hostile login %s in its own shape', async (hostileLogin, expectedOf, succeeds) => {
    const { spa, page } = await open({ hostileLogin });
    if (succeeds) {
      await loginToAdmin(spa, page);
    } else {
      await login(spa, page);
      await page.locator(`#${SPA_STATE_ELEMENTS.loginError}[data-state="shown"]`).waitFor({ timeout: UI_TIMEOUT_MS });
    }
    const loginPosts = spa.requests
      .filter((request) => request.origin !== 'app' && !request.preflight && request.method === 'POST')
      .map(({ origin, path }) => [origin, `POST ${path}`]);
    expect(loginPosts).toEqual(expectedOf(spa));
    // 送ったどの要求にも、事前確認が先に届いた（スクリプトの JSON の要求）。
    for (const [origin, shape] of expectedOf(spa)) {
      const path = shape.slice('POST '.length);
      expect(spa.requests.some((request) => request.origin === origin && request.preflight && request.path === path), shape).toBe(true);
    }
    if (hostileLogin === 'refreshLoop') {
      expect(spa.refreshes).toBe(SPA_REFRESH_LOOP_COUNT);
    }
  }, TEST_TIMEOUT_MS);

  it('logs out by removing the stored state and going back to the login screen', async () => {
    const { spa, page } = await open();
    await loginToAdmin(spa, page);
    const requestsBefore = spa.requests.filter((request) => request.origin !== 'app').length;
    await page.locator('#logout').click();
    await page.waitForURL(`${spa.appOrigin}${SPA_APP_PATHS.auth}`, { timeout: UI_TIMEOUT_MS });
    expect(await storedKeys(page)).toBeNull();
    // ログアウトは画面の中だけ（バックエンドに要求しない）。
    expect(spa.requests.filter((request) => request.origin !== 'app')).toHaveLength(requestsBefore);
  }, TEST_TIMEOUT_MS);

  it('builds an authenticated state for the tests (issueStoredSession), and keeps no secret value in the records', async () => {
    const { spa, page } = await open({ refreshAfterMs: SHORT_REFRESH_MS });
    spa.addMember(EXISTING_NAME);
    await loginToAdmin(spa, page);
    await page.locator(`#${SPA_STATE_ELEMENTS.refresh}[data-state="refreshed"]`).waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
    // テストが組み立てた認証済みの状態（ローカル ストレージ）で、ログインせずに一覧を読める。
    const stored = spa.issueStoredSession();
    const other = await context?.newPage();
    if (other === undefined) {
      throw new Error('ページがない');
    }
    await other.goto(`${spa.appOrigin}${SPA_APP_PATHS.auth}`);
    await other.evaluate(([key, value]) => localStorage.setItem(key ?? '', value ?? ''), [SPA_AUTH_STORAGE_KEY, stored]);
    await other.goto(`${spa.appOrigin}${SPA_APP_PATHS.admin}`);
    await other.locator(`#${SPA_STATE_ELEMENTS.members}[data-state="loaded"]`).waitFor({ timeout: UI_TIMEOUT_MS });
    // 目印: メール、パスワード、API の鍵、発行した token（4 つ以上）。記録（JSON にしたもの）に、どの値も出ない。
    const secrets = spa.secretValues();
    expect(secrets.length).toBeGreaterThanOrEqual(7);
    const recorded = JSON.stringify(spa.requests);
    expect(secrets.filter((secret) => recorded.includes(secret))).toEqual([]);
    // 対照: API の鍵は、本物の SPA と同じく、アプリのスクリプトに入っている（記録には入らない）。
    const script = await (await fetch(`${spa.appOrigin}${SPA_APP_PATHS.script}`)).text();
    expect(secrets.filter((secret) => script.includes(secret))).toHaveLength(1);
  }, TEST_TIMEOUT_MS);

  // T33c（実テスト環境の観察の形）: ログインの前後の手続きの呼び出し、ログインの直後のサーバの関数の呼び出し、アプリの Origin への計測の送信。
  it('calls the tenant RPC with the API key only before the login and with the Bearer after it (preLoginRpc)', async () => {
    const { spa, page } = await open({ preLoginRpc: 'required' });
    await loginToAdmin(spa, page);
    await page.locator(`#${SPA_STATE_ELEMENTS.tenant}[data-state="resolved"]`).waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
    const calls = spa.requests.filter((request) => !request.preflight && request.path === SPA_BACKEND_PATHS.rpcResolveTenant);
    expect(calls.map(({ origin, method, bearerValid }) => [origin, method, bearerValid])).toEqual([['backend', 'POST', null], ['backend', 'POST', true]]);
    expect(calls[0]?.headerNames).toEqual(expect.arrayContaining([SPA_API_KEY_HEADER, 'content-type']));
    expect(hasPreflight(spa.requests, SPA_BACKEND_PATHS.rpcResolveTenant)).toBe(true);
  }, TEST_TIMEOUT_MS);

  it('calls the server function right after the login, with the Bearer, before going to /admin (postLoginFunction)', async () => {
    const { spa, page } = await open({ postLoginFunction: 'stopOnFailure' });
    await loginToAdmin(spa, page);
    expect(spa.functionCalls).toBe(1);
    const posts = spa.requests.filter((request) => request.origin === 'backend' && !request.preflight && request.method === 'POST').map(({ path }) => path);
    expect(posts).toEqual([passwordTokenPath, SPA_BACKEND_PATHS.functionSyncAccess]);
    expect(requestOf(spa.requests, 'POST', SPA_BACKEND_PATHS.functionSyncAccess)).toMatchObject({ bearerValid: true, bodyKeys: ['event'] });
    expect(hasPreflight(spa.requests, SPA_BACKEND_PATHS.functionSyncAccess)).toBe(true);
  }, TEST_TIMEOUT_MS);

  it('sends the measurement beacon to the app origin on /auth and /admin, without a preflight (rumBeacon)', async () => {
    const { spa, page } = await open({ rumBeacon: true });
    await loginToAdmin(spa, page);
    await expect.poll(() => spa.rumBeacons, { timeout: UI_TIMEOUT_MS }).toBe(2);
    const beacons = spa.requests.filter((request) => request.path === SPA_APP_PATHS.rum);
    expect(beacons.map(({ origin, method, preflight, bodyKeys }) => [origin, method, preflight, bodyKeys]))
      .toEqual([['app', 'POST', false, ['event']], ['app', 'POST', false, ['event']]]);
  }, TEST_TIMEOUT_MS);
});
