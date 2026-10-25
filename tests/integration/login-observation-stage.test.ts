// T43d（Task 43 の設計書 3 章、4.4、5 章の 4・5）: 手動のログインで観察した要求の「登録する」と、成功の鍵の名前と成功の画面のセレクタの案を、本物の
// ワーカーのログインの段（`runLoginStage`。factory と Guard は本物）と fixture（`startSpaAuthSite`）で確かめる。Chromium はテストの既定の headless と
// CLI の起動の設定の両方。人の操作は、テストだけの口 `onLoginPageReady` で代える。管理データは一時のフォルダ（本物の保存の部品）。
// 流れ（利用者の「観察のためのログイン → 登録 → もう一度ログインの確かめ」の繰り返し）:
// 1. 前の認証の設定（フォームの送信。送信先はログインの画面の path）で手動のログインを試す。token の送信（別の Origin、`grant_type` の query）を Guard が
//    止め、ログインの段は時間切れ。止めた行に、query の名前と `grant_type` の値が残る。バックエンドに届いた token の送信は 0（保存の前は止まったまま）。
// 2. 行の「登録する」の下書き（token の送信先と、プロファイルに足す承認したサービスの Origin）で、プロファイルと認証の設定をまとめて保存する（成功の鍵の
//    形は、利用者がまだ知らないので仮の値）。もう一度のログインで token の送信が通り（届いた token の送信 1）、成功の鍵の形が違うので時間切れになるが、
//    ログインの画面の Origin に新しく出た鍵の名前が、成功の鍵の名前の案として残る（値は残らない）。
// 3. 案を認証の設定に入れて保存し、もう一度のログインで成功する。成功の画面のセレクタの案は、ログアウトのリンク（`#logout`）で、ログインの画面にもある
//    見出しのリンク（`SPA_SHARED_HEADER_LINK`。ログアウトの語を含む）は案にならない。
// 秘密の目印（資格情報、API の鍵、発行した token）は、どの結果と、管理データのファイル（WAL を含む）にも出ない。各場面の終わりに、名前つきの時間だけ待って
// から、サーバの記録で数え直す。
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import type { AuditConfig } from '../../src/config/types.js';
import { AUTH_SETUP_SCHEMA_VERSION_3, type AuthSetupV3 } from '../../src/control/auth/auth-setup-contracts.js';
import { DISCOVERY_LOGOUT_WORDS } from '../../src/discovery/classification-words.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import {
  approvedServiceOriginsToAdd,
  loginStageRegistrationOf,
  observedDraftOfObservation,
  observedDraftOfRegistration,
} from '../../src/control/login-observation-draft.js';
import { getAuthSetup, saveAuthSetup } from '../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { saveProfileAndAuthSetup } from '../../src/control/store/profile-auth-setup-store.js';
import { getProfile } from '../../src/control/store/profile-store.js';
import { runLoginStage, type LoginStageResult } from '../../src/worker/authenticated-login.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { fastRunConfig } from '../helpers/run-harness.js';
import {
  SPA_APP_PATHS,
  SPA_AUTH_STORAGE_KEY,
  SPA_BACKEND_PATHS,
  SPA_GRANT_TYPES,
  SPA_LOGIN_FIELDS,
  SPA_SHARED_HEADER_LINK,
  SPA_STATE_ELEMENTS,
  startSpaAuthSite,
  type SpaAuthSite,
} from '../helpers/spa-auth-site-fixture.js';
import { createForkTestProfile } from '../helpers/worker-fork-support.js';

const LAUNCHERS: readonly (readonly [string, () => Promise<Browser>])[] = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI Chromium', () => launchCliChromium()],
];
/** 1 つの場面の上限（ms。3 回のログインの段）。 */
const TEST_TIMEOUT_MS = 180_000;
const UI_TIMEOUT_MS = 15_000;
/** 成功する回のログインを待つ上限（ms）。 */
const LOGIN_TIMEOUT_MS = 30_000;
/** 成功しない回のログインを待つ上限（ms。短くする）。 */
const SHORT_LOGIN_TIMEOUT_MS = 8_000;
const LOGIN_POLL_MS = 100;
/** 各回の終わりに、遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 1_000;
const EXISTING_NAME = '既存花子';
/** 利用者がまだ成功の鍵の名前を知らないときの、仮の接頭辞（fixture の鍵に当たらない）。 */
const GUESSED_KEY_PREFIX = 'unknown-key';
/** fixture の鍵（`fixture-auth-token`）の、接頭辞と接尾辞の案（T43R-fix の C-1 (a)）。 */
// T43R2-fix（意図して直した期待）: 一般の語の側（`-token`）だけ。最初の部分（`fixture`）は一般の語でないので接頭辞は空。
const KEY_SHAPE = Object.freeze({ prefix: '', suffix: '-token' });

describe.each(LAUNCHERS)('T43d: registering what the manual login observed, with %s', (label, launch) => {
  let site: SpaAuthSite | undefined;
  let workDirectory: string | undefined;
  let database: ControlDatabase | undefined;
  const browsers: Browser[] = [];

  afterEach(async () => {
    await Promise.all(browsers.splice(0).map((browser) => browser.close().catch(() => undefined)));
    if (database !== undefined) closeControlDatabase(database);
    database = undefined;
    await site?.close();
    site = undefined;
    if (workDirectory !== undefined) await rm(workDirectory, { recursive: true, force: true });
    workDirectory = undefined;
  });

  // ML-a（設計書 `2026-10-19-beaksight-manual-login-pass-through-design.md` 2.1、2.3。ユーザーの判断で意図して直した期待）: 前は、登録の前の手動のログインの段が
  // token の送信を止め、止めた一覧の行から下書きを作った。今は、手動のログインの段は token の送信を止めずに通してログインでき、通した送信の一覧の行（同じ形）
  // から同じ部品で下書きを作る。
  it(`passes the token request before it is registered and records it, then logs in with the drafts, and proposes the key name and the selector (${label})`, async () => {
    const spa = await startSpaAuthSite({ sharedHeaderLink: true });
    site = spa;
    spa.addMember(EXISTING_NAME);
    workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-login-observation-'));
    const store = openControlDatabase(resolveControlDatabasePath(workDirectory));
    database = store;
    const profileId = `example-observed-${label.length}`;
    const targetConfigPath = `local/targets/${profileId}.json`;
    const config: AuditConfig = {
      ...fastRunConfig(spa.appOrigin, SPA_APP_PATHS.auth),
      site: { startUrl: `${spa.appOrigin}${SPA_APP_PATHS.auth}`, allowedOrigins: [spa.appOrigin] },
    };
    const resolveContext = (path: string): { readonly targetConfig: AuditConfig } | undefined => (path === targetConfigPath ? { targetConfig: config } : undefined);
    expect(createForkTestProfile(store, { profileId, targetConfigPath, auth: 'MANUAL_SESSION', approvedTestOrigins: [spa.appOrigin] }, resolveContext).ok).toBe(true);
    // 前の認証の設定（フォームの送信。送信先はログインの画面の path。成功の画面のセレクタはまだない）。
    const base = {
      schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
      profileId,
      loginStartUrl: `${spa.appOrigin}${SPA_APP_PATHS.auth}`,
      successCondition: { pathPrefix: SPA_APP_PATHS.admin, selector: null },
      sessionLostCondition: { pathPrefix: SPA_APP_PATHS.auth },
      excludedPaths: [SPA_APP_PATHS.logout],
      auditPathPrefixes: [],
      maxLoginAttempts: 1,
      allowedIdpOrigins: [],
      automatedLogin: null,
      loginSideRequests: [],
    } as const;
    const formSetup: AuthSetupV3 = {
      ...base, profileRevision: MIN_PROFILE_REVISION, loginPostEndpoints: [{ origin: spa.appOrigin, path: SPA_APP_PATHS.auth }],
      loginTransport: 'FORM_NAVIGATION', scriptLogin: null, successStorageKey: null,
    };
    expect(saveAuthSetup(store, formSetup, { resolveContext }).ok).toBe(true);

    /** 保存してある設定とプロファイルで、ログインの段を 1 回行う（人の操作の代わりに、正しい資格情報を入れて送る）。 */
    const login = async (timeoutMs: number): Promise<LoginStageResult> => {
      const profile = getProfile(store, profileId)?.profile;
      const setup = getAuthSetup(store, profileId)?.setup;
      if (profile === undefined || setup === undefined) throw new Error('the profile or the auth setup is missing');
      const result = await runLoginStage({
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
        loginTimeoutMs: timeoutMs,
        pollIntervalMs: LOGIN_POLL_MS,
        onLoginPageReady: async (page: Page) => {
          await page.locator(SPA_LOGIN_FIELDS.email).waitFor({ timeout: UI_TIMEOUT_MS });
          await spa.fillCredentials(async (selector, value) => page.locator(selector).fill(value));
          await page.locator(SPA_LOGIN_FIELDS.submit).click();
        },
      });
      await wait(LATE_REQUEST_WAIT_MS);
      return result;
    };
    /** バックエンドに届いた token の送信（事前確認でない POST）の数。 */
    const tokenPostsReached = (): number => spa.requests
      .filter((request) => request.origin !== 'app' && !request.preflight && request.method === 'POST' && request.path.startsWith(SPA_BACKEND_PATHS.token)).length;
    const results: LoginStageResult[] = [];

    // 1. 登録の前: 手動のログインの段は token の送信を通し（ML-a）、通した送信の行に query の名前と `grant_type` の値が残る。
    const first = await login(LOGIN_TIMEOUT_MS);
    results.push(first);
    expect(first.kind).toBe('AUTHENTICATED');
    expect(tokenPostsReached()).toBe(1);
    expect(first.blockedRequests).toBeUndefined();
    const tokenRow = first.passedRequests?.requests.find((request) => request.path === SPA_BACKEND_PATHS.token);
    expect(tokenRow).toMatchObject({
      origin: spa.tokenOrigin,
      reason: 'NON_READ_METHOD',
      query: { names: ['grant_type'], omitted: 0, values: [{ name: 'grant_type', value: SPA_GRANT_TYPES.password }] },
    });
    if (tokenRow === undefined) throw new Error('the token request was not listed');
    const registration = loginStageRegistrationOf(tokenRow);
    expect(registration.kind).toBe('TOKEN_TARGET');
    const tokenDraft = observedDraftOfRegistration(registration);
    const scriptLogin = tokenDraft?.scriptLogin;
    if (scriptLogin === undefined) throw new Error('no token target draft');
    const profileBefore = getProfile(store, profileId)?.profile;
    if (profileBefore === undefined) throw new Error('no profile');
    const added = approvedServiceOriginsToAdd({ scriptLogin }, { approvedTestOrigins: profileBefore.approvedTestOrigins, approvedServiceOrigins: [] });
    expect(added).toEqual([spa.tokenOrigin]);

    // 2. 下書きで、プロファイル（承認したサービスの Origin）と認証の設定をまとめて保存する（成功の鍵の形は仮の値）。
    const nextRevision = profileBefore.revision + 1;
    const scriptSetup: AuthSetupV3 = {
      ...base, profileRevision: nextRevision, loginPostEndpoints: [], loginTransport: 'SCRIPT_REQUEST',
      scriptLogin: { origin: scriptLogin.origin, path: scriptLogin.path, requiredQuery: scriptLogin.requiredQuery.map((query) => ({ ...query })) },
      successStorageKey: { origin: spa.appOrigin, prefix: GUESSED_KEY_PREFIX, suffix: '' },
    };
    const saved = saveProfileAndAuthSetup(store, {
      profile: { ...profileBefore, revision: nextRevision, approvedServiceOrigins: [...added] }, expectedRevision: profileBefore.revision, setup: scriptSetup,
    }, { resolveContext });
    expect(saved.ok, JSON.stringify(saved)).toBe(true);
    expect(getAuthSetup(store, profileId)?.freshness).toBe('CURRENT');

    const second = await login(SHORT_LOGIN_TIMEOUT_MS);
    results.push(second);
    expect(second.kind).toBe('LOGIN_TIMEOUT');
    expect(tokenPostsReached()).toBe(2);
    // T43R-fix の C-1 (a)（意図して直した期待）: 鍵の名前は、区切りで分けた最初と最後の部分だけを接頭辞と接尾辞の案にする（名前の全体は残さない）。
    expect(SPA_AUTH_STORAGE_KEY.startsWith(KEY_SHAPE.prefix) && SPA_AUTH_STORAGE_KEY.endsWith(KEY_SHAPE.suffix)).toBe(true);
    expect(second.loginObservation?.storageKeys).toEqual({ origin: spa.appOrigin, shapes: [KEY_SHAPE], omitted: 0 });
    expect(second.loginObservation?.successSelector).toBeUndefined();
    const keyDraft = second.loginObservation === undefined ? null : observedDraftOfObservation(second.loginObservation);
    expect(keyDraft).toEqual({ storageKey: { origin: spa.appOrigin, ...KEY_SHAPE } });

    // 3. 案を認証の設定に入れて保存し、もう一度のログインで成功する。
    const key = keyDraft?.storageKey;
    if (key === undefined) throw new Error('no key draft');
    expect(saveAuthSetup(store, { ...scriptSetup, successStorageKey: { origin: key.origin, prefix: key.prefix, suffix: key.suffix } }, { resolveContext }).ok)
      .toBe(true);
    const third = await login(LOGIN_TIMEOUT_MS);
    results.push(third);
    expect(third.kind).toBe('AUTHENTICATED');
    expect(tokenPostsReached()).toBe(3);
    expect(third.loginObservation?.storageKeys).toEqual({ origin: spa.appOrigin, shapes: [KEY_SHAPE], omitted: 0 });
    const selector = third.loginObservation?.successSelector;
    expect(selector).toMatchObject({ selector: '#logout', kind: 'LOGOUT_CONTROL' });
    expect(DISCOVERY_LOGOUT_WORDS as readonly (string | null | undefined)[]).toContain(selector?.logoutWord);
    // ログインの画面にもある見出しのリンクは案にならない（文書の順では先にあり、ログアウトの語を含む）。
    expect(JSON.stringify(third.loginObservation)).not.toContain(SPA_SHARED_HEADER_LINK.id);
    expect(JSON.stringify(third.loginObservation)).not.toContain(SPA_SHARED_HEADER_LINK.href);
    // 案のセレクタは、ログインの後の画面で一覧の要素と別に使える（成功の条件のセレクタの形として受ける）。
    expect(`#${SPA_STATE_ELEMENTS.members}`).not.toBe(selector?.selector);

    // 秘密の目印は、どの結果の記録（止めた一覧、数、観察）にも、管理データのファイル（WAL を含む）にも出ない。
    const markers = spa.secretValues();
    expect(markers.length).toBeGreaterThan(2);
    const records = JSON.stringify(results.map(({ kind, blockedRequests, passedRequests, scriptLogin: counts, loginObservation }) => ({ kind, blockedRequests, passedRequests, counts, loginObservation })));
    expect(markers.filter((marker) => records.includes(marker))).toEqual([]);
    const databasePath = resolveControlDatabasePath(workDirectory);
    const databaseBytes = [databasePath, `${databasePath}-wal`].filter((path) => existsSync(path)).map((path) => readFileSync(path).toString('latin1')).join('\n');
    expect(markers.filter((marker) => databaseBytes.includes(marker))).toEqual([]);
  }, TEST_TIMEOUT_MS);
});
