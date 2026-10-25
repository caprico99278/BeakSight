// FM2e（手を減らす段 2 の設計書 3A.4）: 手動のログインの段の始めに、ログインの画面の 3 つの欄（ユーザー名・パスワード・送信）を検出し（値は読まない）、
// 成功したときに、その CSS の案をログインの段の観察（`loginObservation.loginFields`）に載せる。本物のワーカーのログインの段（`runLoginStage`。factory と
// Guard は本物）と、127.0.0.1 のログインの fixture（`startSpaAuthSite`）で確かめる。Chromium はテストの既定の headless と CLI の起動の設定の両方。
// 人の操作は、テストだけの口 `onLoginPageReady` で代える（目印の資格情報を入れて送る）。
// - 案は、ログインの画面の欄の一意な CSS（fixture の `SPA_LOGIN_FIELDS`）。
// - 案は IPC の契約（`AUTH_STATE`）を通り、ジョブの行のログインの段のまとめ（管理データ）に残る（認証の設定には保存しない）。
// - 入れた値（目印）は、結果、IPC のメッセージ、管理データのファイル（WAL を含む）、標準出力と標準エラーのどこにも出ない（この段は成果物を書かない）。
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import type { AuditConfig } from '../../src/config/types.js';
import { AUTH_SETUP_SCHEMA_VERSION_3, type AuthSetupV3 } from '../../src/control/auth/auth-setup-contracts.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import { createStartingJob, readJob, recordAuthState } from '../../src/control/job/job-store.js';
import { getAuthSetup, saveAuthSetup } from '../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { getProfile } from '../../src/control/store/profile-store.js';
import { WORKER_PROTOCOL_VERSION, validateWorkerToParentMessage } from '../../src/control/worker-protocol.js';
import { formatCompactUtcTimestamp } from '../../src/core/utc-timestamp.js';
import { runLoginStage, type LoginStageResult } from '../../src/worker/authenticated-login.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { fastRunConfig } from '../helpers/run-harness.js';
import { SPA_APP_PATHS, SPA_LOGIN_FIELDS, startSpaAuthSite, type SpaAuthSite } from '../helpers/spa-auth-site-fixture.js';
import { createForkTestProfile } from '../helpers/worker-fork-support.js';

const LAUNCHERS: readonly (readonly [string, () => Promise<Browser>])[] = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI Chromium', () => launchCliChromium()],
];
const TEST_TIMEOUT_MS = 120_000;
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
