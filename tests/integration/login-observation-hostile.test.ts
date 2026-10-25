// T43R-fix の C-1（Task 43 の設計書 7 章の T43R の行）: ログインの段の観察が、利用者の名前を残さない。手動のログインの段（`runLoginStage`）と自動ログインの段
// （`runAutomatedLoginStage`）を、本物の factory と Guard で、テストの既定の headless と CLI の起動の設定の両方の Chromium で確かめる。
// - サイトは fixture（`startSpaAuthSite` の `hostileObservation`）。ログインの後の管理画面に、利用者の名前（`SPA_HOSTILE_OBSERVATION_USER`）の入る見出しの
//   リンク（`#profile-<名前>`、`a[href="/users/<名前>"]`）と、名前を間に持つローカル ストレージの鍵（`LibAuth.<client id>.<名前>.idToken` など）がある。
// - 観察の記録（ログインの段の結果）、IPC（`AUTH_STATE` の検証を通した形）、管理データ（ジョブの行。WAL を含むファイルのバイト）、下書き（`draft` の URL の
//   値）のどこにも、名前と client id が出ない。今の fixture の鍵（`fixture-auth-token`）とログアウトのリンク（`#logout`）は、接頭辞・接尾辞と CSS として出る。
// 値は出力しない。サーバは 127.0.0.1 だけで待ち受ける。管理データは一時のフォルダ。
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditConfig } from '../../src/config/types.js';
import { AUTH_SETUP_SCHEMA_VERSION_3, AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS, type AuthSetupV3 } from '../../src/control/auth/auth-setup-contracts.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import { createStartingJob, readJob, recordAuthState } from '../../src/control/job/job-store.js';
import { observedDraftOfObservation } from '../../src/control/login-observation-draft.js';
import { closeControlDatabase, openControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { WORKER_PROTOCOL_VERSION, validateWorkerToParentMessage, type WorkerLoginObservation } from '../../src/control/worker-protocol.js';
import { runLoginStage } from '../../src/worker/authenticated-login.js';
import { runAutomatedLoginStage } from '../../src/worker/automated-login.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { fastRunConfig } from '../helpers/run-harness.js';
import {
  SPA_APP_PATHS,
  SPA_BACKEND_PATHS,
  SPA_GRANT_TYPES,
  SPA_HOSTILE_OBSERVATION_END_USERS,
  SPA_HOSTILE_OBSERVATION_USER,
  SPA_LOGIN_FIELDS,
  SPA_STATE_ELEMENTS,
  startSpaAuthSite,
  type SpaAuthSite,
} from '../helpers/spa-auth-site-fixture.js';
import { createForkTestProfile } from '../helpers/worker-fork-support.js';

const LAUNCHERS: readonly (readonly [string, () => Promise<Browser>])[] = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI Chromium', () => launchCliChromium()],
];
const TEST_TIMEOUT_MS = 120_000;
const UI_TIMEOUT_MS = 15_000;
const LOGIN_TIMEOUT_MS = 30_000;
const RESULT_TIMEOUT_MS = 10_000;
const LOGIN_POLL_MS = 100;
const CREDENTIAL_REVISION = 1;
/** 鍵の名前の間の部分に入る client id（名前と同じく、どこにも出ない）。 */
const CLIENT_ID_MARKER = 'clientid0123456789abc';
/**
 * T43R2-fix（意図して直した期待）: 一般の語の側だけ（接頭辞は空）。新しい鍵は 7 つ（fixture の鍵、`LibAuth.…` の 2 つ、端に名前の入る 4 つ）で、案は
 * 重ならない 5 つのうち上限の 4 つ（`app.session.entryuser` と `….LastAuthUser` は両端とも一般の語でないので案にならない）。
 */
const EXPECTED_SHAPES = [
  { prefix: '', suffix: '-token' },
  { prefix: '', suffix: '.idToken' },
  { prefix: '', suffix: '.token' },
  { prefix: '', suffix: '/token' },
];
const EXPECTED_OMITTED = 3;

describe.each(LAUNCHERS)('T43R-fix C-1: the login observation keeps no user name (%s)', (_label, launch) => {
  let site: SpaAuthSite | undefined;
  let workDirectory: string | undefined;
  const browsers: Browser[] = [];

  afterEach(async () => {
    await Promise.all(browsers.splice(0).map((browser) => browser.close().catch(() => undefined)));
    await site?.close();
    site = undefined;
    if (workDirectory !== undefined) await rm(workDirectory, { recursive: true, force: true });
    workDirectory = undefined;
  });

  const configOf = (spa: SpaAuthSite): AuditConfig => ({
    ...fastRunConfig(spa.appOrigin, SPA_APP_PATHS.auth),
    site: { startUrl: `${spa.appOrigin}${SPA_APP_PATHS.auth}`, allowedOrigins: [spa.appOrigin] },
  });

  const setupOf = (spa: SpaAuthSite, automated: boolean): AuthSetupV3 => ({
    schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
    profileId: 'example-hostile',
    profileRevision: MIN_PROFILE_REVISION,
    loginStartUrl: `${spa.appOrigin}${SPA_APP_PATHS.auth}`,
    loginPostEndpoints: [],
    successCondition: { pathPrefix: SPA_APP_PATHS.admin, selector: `#${SPA_STATE_ELEMENTS.members}[data-state="loaded"]` },
    sessionLostCondition: { pathPrefix: SPA_APP_PATHS.auth },
    excludedPaths: [SPA_APP_PATHS.logout],
    auditPathPrefixes: [],
    maxLoginAttempts: automated ? AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS : 1,
    allowedIdpOrigins: [],
    automatedLogin: automated
      ? {
        usernameSelector: SPA_LOGIN_FIELDS.email,
        passwordSelector: SPA_LOGIN_FIELDS.password,
        submitSelector: SPA_LOGIN_FIELDS.submit,
        failureConditions: { invalidCredentials: null, accountLocked: null, mfaRequired: null, credentialExpired: null },
      }
      : null,
    loginTransport: 'SCRIPT_REQUEST',
    scriptLogin: { origin: spa.tokenOrigin, path: SPA_BACKEND_PATHS.token, requiredQuery: [{ name: 'grant_type', value: SPA_GRANT_TYPES.password }] },
    loginSideRequests: [],
    successStorageKey: { origin: spa.appOrigin, prefix: 'fixture-', suffix: '-token' },
  });

  /** 観察を、記録・IPC・管理データ（WAL を含む）・下書きの URL の値で確かめる。 */
  const expectNoUserName = async (spa: SpaAuthSite, observation: WorkerLoginObservation | undefined): Promise<void> => {
    expect(observation?.storageKeys).toEqual({ origin: spa.appOrigin, shapes: EXPECTED_SHAPES, omitted: EXPECTED_OMITTED });
    expect(observation?.successSelector).toMatchObject({ selector: '#logout', kind: 'LOGOUT_CONTROL' });
    const markers = [SPA_HOSTILE_OBSERVATION_USER, ...SPA_HOSTILE_OBSERVATION_END_USERS, CLIENT_ID_MARKER, 'LibAuth', 'hostile-token-value', 'profile-', '/users/'];
    const record = JSON.stringify(observation);
    expect(markers.filter((marker) => record.includes(marker))).toEqual([]);
    // IPC: `AUTH_STATE` の検証を通る形。
    const message = { protocol: WORKER_PROTOCOL_VERSION, type: 'AUTH_STATE', state: 'AUTHENTICATED', sessionLostUrl: null, loginObservation: observation };
    expect(validateWorkerToParentMessage(message).ok).toBe(true);
    // 管理データ: ジョブの行に残し、ファイル（WAL を含む）のバイトに名前がない。
    workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-observation-hostile-'));
    const databasePath = resolveControlDatabasePath(workDirectory);
    const database = openControlDatabase(databasePath);
    try {
      const config = configOf(spa);
      const targetConfigPath = 'local/targets/example-hostile.json';
      expect(createForkTestProfile(database, {
        profileId: 'example-hostile', targetConfigPath, auth: 'MANUAL_SESSION', approvedTestOrigins: [spa.appOrigin], approvedServiceOrigins: [spa.backendOrigin],
      }, (path) => (path === targetConfigPath ? { targetConfig: config } : undefined)).ok).toBe(true);
      expect(createStartingJob(database, {
        jobId: 'job-hostile', jobKind: 'AUDIT', profileId: 'example-hostile', profileRevision: MIN_PROFILE_REVISION, startNew: true, createdAt: '20261017010000',
      }, () => null)).toEqual({ ok: true });
      expect(recordAuthState(database, 'job-hostile', 'AUTHENTICATED', null, { scriptLogin: null, blockedRequests: null, ...(observation === undefined ? {} : { observation }) }))
        .toBe(true);
      expect(readJob(database, 'job-hostile')?.loginStage?.observation).toEqual(observation);
    } finally {
      closeControlDatabase(database);
    }
    const bytes = [databasePath, `${databasePath}-wal`].filter((path) => existsSync(path)).map((path) => readFileSync(path).toString('latin1')).join('\n');
    expect(markers.filter((marker) => bytes.includes(marker))).toEqual([]);
    // 下書き（認証の設定の画面の URL の `draft` の値）。
    const draft = observedDraftOfObservation(observation ?? {});
    expect(draft).toEqual({ storageKey: { origin: spa.appOrigin, ...EXPECTED_SHAPES[0] }, successSelector: '#logout' });
    const url = `/auth-setup/example-hostile?draft=${encodeURIComponent(JSON.stringify(draft))}`;
    expect(markers.filter((marker) => url.includes(marker) || decodeURIComponent(url).includes(marker))).toEqual([]);
  };

  it('keeps no user name after the manual login', async () => {
    const spa = await startSpaAuthSite({ hostileObservation: true });
    site = spa;
    const result = await runLoginStage({
      config: configOf(spa),
      setup: setupOf(spa, false),
      approvedTestOrigins: [spa.appOrigin],
      approvedServiceOrigins: [spa.backendOrigin],
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
    expect(result.kind).toBe('AUTHENTICATED');
    await expectNoUserName(spa, result.loginObservation);
  }, TEST_TIMEOUT_MS);

  it('keeps no user name after the automated login', async () => {
    const spa = await startSpaAuthSite({ hostileObservation: true });
    site = spa;
    const values: string[] = [];
    await spa.fillCredentials(async (_selector, value) => {
      values.push(value);
    });
    const [username = '', password = ''] = values;
    const result = await runAutomatedLoginStage({
      config: configOf(spa),
      setup: setupOf(spa, true),
      approvedTestOrigins: [spa.appOrigin],
      approvedServiceOrigins: [spa.backendOrigin],
      expectedCredentialRevision: CREDENTIAL_REVISION,
      readCredentialMetadata: async () => ({ credentialRevision: CREDENTIAL_REVISION, loginOrigin: spa.appOrigin }),
      readCredential: async () => ({ credentialRevision: CREDENTIAL_REVISION, username, password }),
      signal: new AbortController().signal,
    }, {
      launchAutomatedLoginBrowser: async () => {
        const browser = await launch();
        browsers.push(browser);
        return browser;
      },
      resultTimeoutMs: RESULT_TIMEOUT_MS,
    });
    expect(result.kind).toBe('AUTHENTICATED');
    expect(result.loginObservation?.credentialDiscarded).toBeUndefined();
    await expectNoUserName(spa, result.loginObservation);
    expect(spa.secretValues().filter((marker) => JSON.stringify(result.loginObservation).includes(marker))).toEqual([]);
  }, TEST_TIMEOUT_MS);
});
