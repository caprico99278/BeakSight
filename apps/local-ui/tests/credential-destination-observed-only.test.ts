/**
 * MI-F5（設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.7.1 の 6・7。再レビュー MI-R2 の Critical C-A・Important I-A・Minor M-1）: ログインの
 * 送信先は、入口の確かめと手動のログインの観察からだけ入る（方式によらない）。ビルドした画面のサーバ（一時の root）の Server Function を HTTP で直接送り、
 * 画面の道は headless の Chromium（`tests/helpers/chromium.ts` の既定）で確かめる。監査のジョブは始めない（サイトへは要求を送らない）。値は匿名
 * （`example.invalid` とループバック）。資格情報はこのテストだけの値。
 * - 3a: 手動のログインのプロファイルの認証の設定の画面の保存で、token の送信先の path・必須の query・ログインに伴う送信を変える保存を拒む（切り替えの後も、
 *   観察した送信先のまま）。送信先でない欄の保存は受ける。
 * - 3b: 自動 → 手動に戻した後の、認証の設定の画面の保存で送信先を変える保存を拒む。
 * - 3c: 行から開いた下書きの保存は、行の Origin だけでなく、path と必須の query も照らす（違えば拒む。同じなら受ける）。画面（手で作った URL）でも拒む。
 * - 最初の保存: 認証の設定がまだないときは、送信先の項目が入口の確かめの案と同じか、送信先のない形（ログインの画面の URL だけ）のときだけ受ける（入口の確かめの
 *   ないプロファイルで token の送信先を入れる保存と、設定のない自動ログインのプロファイルへの最初の保存は拒む）。
 * - 3d（I-A）: プロファイルの編集の口の判定は、トランザクションの中で読んだ値に対して行う（同時の 2 つの要求で、手動へ戻す要求と、自動へ＋設定のファイルを
 *   広げる要求が、1 回でも両方通れば失敗）。
 * - M-1: 下書きの保存は、画面が読んだ改訂と今の改訂を先に照らす（同時の別の保存を、古い値で黙って戻さない）。
 * - 7: 認証の設定があるときは、送信先の項目を入力の欄にせず、読むだけで出す。
 * - PL-S（設計書 `2026-10-26-beaksight-plain-ui-design.md` 10 章の PL-S の 8。MI 4.7.1 の 6 の持ち越し）: token の送信先・必須の query・ログインに伴う送信は、
 *   設定がないときも読むだけで出す。送り方の案がない（入口の確かめがない）ときの既定は送信先のない形で、画面の最初の保存がそのまま通る。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Browser, BrowserContext } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTH_SETUP_SCHEMA_VERSION_3, AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS } from '../../../src/control/auth/auth-setup-contracts.js';
import { createStartingJob, recordAuthState, recordEnded, type AuditJobLoginStageSummary, type NewAuditJob } from '../../../src/control/job/job-store.js';
import { closeControlDatabase, openControlDatabase } from '../../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../../src/control/store/database-path.js';
import { WORKER_AUDIT_JOB_KIND } from '../../../src/core/audit-job-values.js';
import { AUTH_SETUP_STORE_REJECTION_DESCRIPTIONS, LOCAL_UI_AUTH_TEXT } from '../../../src/presentation/messages.js';
import { launchHeadlessChromium } from '../../../tests/helpers/chromium.js';
import { REMOVED_ADD_BUTTON_LABELS, openAuthSetupAdvancedSettings } from './helpers/auth-setup-page.ts';
import { writeAuthTargetConfig } from './helpers/auth-worker.ts';
import {
  createTemporaryUiRoot,
  findFreePort,
  parseSetCookie,
  rawRequest,
  startLauncher,
  stopServer,
  type StartedServer,
  type TemporaryUiRoot,
} from './helpers/local-server.ts';
import { createProfileInStore, saveAuthSetupInStore, saveProfileAndAuthSetupInStore } from './helpers/profile-store-setup.ts';
import { callServerFunction, readServerFunctionIds } from './helpers/server-functions.ts';

const SCENARIO_TIMEOUT_MS = 180_000;
const UI_TIMEOUT_MS = 15_000;
const MAX_PAGES = 3;
/** 競合の試しの回数の上限（1 回でも口の判定を抜ければ失敗）。 */
const RACE_TRIES = 20;
const TEST_ORIGIN = 'http://127.0.0.1:4173';
const OTHER_TEST_ORIGIN = 'http://127.0.0.1:4174';
const SERVICE_ORIGIN = 'https://service.example.invalid';
const OBSERVED_ORIGIN = 'https://observed.example.invalid';
const TOKEN_PATH = '/auth/v1/token';
const GRANT = Object.freeze({ name: 'grant_type', value: 'password' });
const STATUS_OK = 200;
const OBSERVED_ONLY = 'CREDENTIAL_DESTINATION_OBSERVED_ONLY';
const PROFILES = Object.freeze({
  gap: 'mif5-gap',
  roundTrip: 'mif5-round-trip',
  draft: 'mif5-draft',
  screenDraft: 'mif5-screen-draft',
  first: 'mif5-first',
  /** PL-S: 入口の確かめも設定もない、手動のログインのプロファイル（認証の設定の画面の最初の保存を、画面の道で確かめる）。 */
  firstScreen: 'mif5-first-screen',
  firstAutomated: 'mif5-first-automated',
  race: 'mif5-race',
  stale: 'mif5-stale',
});
const WIDE_CONFIG = 'mif5-wide';
const JOBS = Object.freeze({ draft: 'job-mif5-draft', screenDraft: 'job-mif5-screen-draft', stale: 'job-mif5-stale' });
const USER = 'mif5-user-0001';
const PASSWORD = 'mif5-pass-0001';

let root: TemporaryUiRoot | undefined;
let server: StartedServer | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let cookie = '';
let ids: ReadonlyMap<string, string> = new Map();

const started = (): StartedServer => {
  if (server === undefined) throw new Error('サーバが起動していない');
  return server;
};
const rootOf = (): TemporaryUiRoot => {
  if (root === undefined) throw new Error('一時の root がない');
  return root;
};
const valueOf = async <T = Record<string, unknown>>(name: string, method: 'GET' | 'POST', data?: unknown): Promise<T> => {
  const result = await callServerFunction({ port: started().port, origin: started().origin, cookie, ids }, name, method, data);
  expect(result.response.status, `${name} ${result.response.body.slice(0, 200)}`).toBe(STATUS_OK);
  return result.value as T;
};

interface PageProfile {
  readonly profileId: string;
  readonly revision: number;
  readonly auth: string;
  readonly targetConfigPath: string;
  readonly approvedTestOrigins: readonly string[];
  readonly approvedServiceOrigins?: readonly string[];
  readonly environmentEvidenceRef?: string | null;
  readonly [key: string]: unknown;
}
type Setup = Record<string, unknown>;
const profileOf = async (profileId: string): Promise<PageProfile> =>
  (await valueOf<{ readonly profile: PageProfile }>('getProfileFn', 'GET', { profileId })).profile;
const setupOf = async (profileId: string): Promise<Setup | null> =>
  (await valueOf<{ readonly stored: { readonly setup: Setup } | null }>('getAuthSetupFn', 'GET', { profileId })).stored?.setup ?? null;
const storedSetupOf = async (profileId: string): Promise<Setup> => {
  const setup = await setupOf(profileId);
  if (setup === null) throw new Error(`no auth setup: ${profileId}`);
  return setup;
};

const AUTOMATED_LOGIN = Object.freeze({
  usernameSelector: '#email', passwordSelector: '#password', submitSelector: '#login',
  failureConditions: { invalidCredentials: null, accountLocked: null, mfaRequired: null, credentialExpired: null },
});

/** スクリプトで送るログインの認証の設定（手動のログインの観察の後の形。token の送信先は承認したサービスの Origin）。 */
const scriptSetupOf = (profileId: string, profileRevision: number, automated: boolean): Setup => ({
  schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
  profileId,
  profileRevision,
  loginStartUrl: `${TEST_ORIGIN}/auth`,
  loginPostEndpoints: [],
  successCondition: { pathPrefix: '/admin', selector: null },
  sessionLostCondition: { pathPrefix: '/auth' },
  excludedPaths: ['/auth/logout'],
  auditPathPrefixes: [],
  maxLoginAttempts: automated ? AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS : 1,
  allowedIdpOrigins: [],
  automatedLogin: automated ? AUTOMATED_LOGIN : null,
  loginTransport: 'SCRIPT_REQUEST',
  scriptLogin: { origin: SERVICE_ORIGIN, path: TOKEN_PATH, requiredQuery: [GRANT] },
  loginSideRequests: [{ origin: SERVICE_ORIGIN, path: '/rpc/tenant', method: 'POST', maxPerLoginStage: 2 }],
  successStorageKey: { origin: TEST_ORIGIN, prefix: '', suffix: '-token' },
});

const profileDocumentOf = (profileId: string, auth: string, targetConfig: string = profileId) => ({
  schemaVersion: 'beaksight-profile/1', profileId, revision: 1, targetConfigPath: `config/targets/${targetConfig}.json`, environment: 'TEST',
  mode: 'TEST_AUTH_PASSIVE', auth, approvedTestOrigins: [TEST_ORIGIN], approvedServiceOrigins: [SERVICE_ORIGIN], environmentEvidenceRef: `${profileId}-evidence`,
});

/** 手動のログインのジョブの止めた行（token の送信先 `OBSERVED_ORIGIN` の `TOKEN_PATH`、必須の query `grant_type=password`）。 */
const MANUAL_SUMMARY: AuditJobLoginStageSummary = {
  scriptLogin: null,
  blockedRequests: {
    requests: [{
      origin: OBSERVED_ORIGIN, path: TOKEN_PATH, resourceType: 'fetch', reason: 'NON_READ_METHOD', count: 1,
      query: { names: ['grant_type'], omitted: 0, values: [GRANT] },
    }],
    unlisted: 0,
  },
  observation: { storageKeys: { origin: TEST_ORIGIN, shapes: [{ prefix: '', suffix: '-token' }], omitted: 0 } },
};

/** テストの準備（管理データの保存の部品を直接呼ぶ。手動のログインの観察と切り替えの後の形）。 */
const seedProfile = async (profileId: string, auth: string, withSetup: boolean, targetConfig: string = profileId): Promise<void> => {
  expect(await createProfileInStore(rootOf().root, profileDocumentOf(profileId, auth, targetConfig))).toMatchObject({ ok: true });
  if (withSetup) {
    expect(await saveAuthSetupInStore(rootOf().root, scriptSetupOf(profileId, 1, auth === 'AUTOMATED_LOGIN'))).toMatchObject({ ok: true });
  }
};

const seedManualJob = (jobId: string, profileId: string): void => {
  const database = openControlDatabase(resolveControlDatabasePath(rootOf().root));
  try {
    const job: Pick<NewAuditJob, 'jobId' | 'jobKind' | 'profileId'> = { jobId, jobKind: WORKER_AUDIT_JOB_KIND, profileId };
    expect(createStartingJob(database, { ...job, profileRevision: 1, startNew: true, createdAt: '20261026010000' }, () => null)).toEqual({ ok: true });
    expect(recordAuthState(database, jobId, 'LOGIN_TIMEOUT', null, MANUAL_SUMMARY)).toBe(true);
    expect(recordEnded(database, jobId, { state: 'FAILED', reason: 'LOGIN_TIMEOUT', exitCode: null, at: '20261026011000' })).toBe(true);
  } finally {
    closeControlDatabase(database);
  }
};

/** 2 つのテストの Origin を許す対象の設定（設定のファイルを広げる道の確かめ）。 */
const writeWideTargetConfig = (): void => {
  mkdirSync(`${rootOf().root}/config/targets`, { recursive: true });
  writeFileSync(`${rootOf().root}/config/targets/${WIDE_CONFIG}.json`, `${JSON.stringify({
    target: { id: WIDE_CONFIG }, site: { startUrl: `${TEST_ORIGIN}/admin`, allowedOrigins: [TEST_ORIGIN, OTHER_TEST_ORIGIN] },
    crawl: { minNavigationIntervalMs: 0, maxPages: MAX_PAGES }, viewports: { stressWidths: [] },
    audit: { performance: false, accessibility: false, interactions: false, screenshots: false }, output: { directory: `mif5-output-${WIDE_CONFIG}` },
  }, null, 2)}\n`, 'utf8');
};

const switchToAutomated = async (profileId: string) => {
  const profile = await profileOf(profileId);
  return valueOf('setUpAutomatedLoginFn', 'POST', {
    profileId, expectedRevision: profile.revision, usernameSelector: '#email', passwordSelector: '#password', submitSelector: '#login',
    username: USER, password: PASSWORD, passwordConfirmation: PASSWORD,
  });
};

beforeAll(async () => {
  root = createTemporaryUiRoot('built');
  for (const profileId of Object.values(PROFILES)) {
    writeAuthTargetConfig(root.root, profileId, TEST_ORIGIN, '/admin', MAX_PAGES);
  }
  writeWideTargetConfig();
  ids = readServerFunctionIds(`${root.root}/apps/local-ui/dist/server/server.js`);
  browser = await launchHeadlessChromium();
  server = await startLauncher(root, await findFreePort());
  context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(server.tokenUrl.href, { waitUntil: 'networkidle' });
  await page.close();
  const exchange = await rawRequest(server.port, `${server.tokenUrl.pathname}${server.tokenUrl.search}`);
  cookie = parseSetCookie(exchange.headers['set-cookie'])?.pair ?? '';
  for (const profileId of [PROFILES.gap, PROFILES.roundTrip, PROFILES.draft, PROFILES.screenDraft, PROFILES.stale]) {
    await seedProfile(profileId, 'MANUAL_SESSION', true);
  }
  await seedProfile(PROFILES.race, 'AUTOMATED_LOGIN', true);
  await seedProfile(PROFILES.first, 'MANUAL_SESSION', false);
  await seedProfile(PROFILES.firstScreen, 'MANUAL_SESSION', false);
  // 設定のない自動ログインのプロファイル（MI より前の形。起動の後に作るので、起動の時の取り消しには当たらない）。
  await seedProfile(PROFILES.firstAutomated, 'AUTOMATED_LOGIN', false);
  seedManualJob(JOBS.draft, PROFILES.draft);
  seedManualJob(JOBS.screenDraft, PROFILES.screenDraft);
  seedManualJob(JOBS.stale, PROFILES.stale);
}, SCENARIO_TIMEOUT_MS);

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await stopServer(server);
  root?.remove();
});

describe('MI-F5: the screen save of the auth setup does not change the login destination of a MANUAL_SESSION profile (3a)', () => {
  it.each([
    ['the token target path', (setup: Setup) => ({ ...setup, scriptLogin: { origin: SERVICE_ORIGIN, path: '/evil/token', requiredQuery: [GRANT] } })],
    ['the required query', (setup: Setup) => ({ ...setup, scriptLogin: { origin: SERVICE_ORIGIN, path: TOKEN_PATH, requiredQuery: [] } })],
    ['a new login side request to the test origin', (setup: Setup) => ({
      ...setup, loginSideRequests: [{ origin: TEST_ORIGIN, path: '/collect', method: 'POST', maxPerLoginStage: 1 }],
    })],
    ['the login page URL', (setup: Setup) => ({ ...setup, loginStartUrl: `${TEST_ORIGIN}/other-auth` })],
  ])('rejects the save that changes %s, and the switch keeps the observed destination', async (_name, change) => {
    const before = await storedSetupOf(PROFILES.gap);
    expect(await valueOf('saveAuthSetupFn', 'POST', { setup: change(before) })).toMatchObject({ ok: false, reason: OBSERVED_ONLY });
    expect(await storedSetupOf(PROFILES.gap)).toEqual(before);
  });

  it('still saves the fields that are not destinations, and the switch to the automated login uses the observed destination', async () => {
    const before = await storedSetupOf(PROFILES.gap);
    expect(await valueOf('saveAuthSetupFn', 'POST', { setup: { ...before, excludedPaths: ['/auth/logout', '/danger'], auditPathPrefixes: ['/admin'] } }))
      .toMatchObject({ ok: true });
    expect(await switchToAutomated(PROFILES.gap)).toMatchObject({ ok: true });
    expect(await storedSetupOf(PROFILES.gap)).toMatchObject({
      scriptLogin: { origin: SERVICE_ORIGIN, path: TOKEN_PATH, requiredQuery: [GRANT] },
      loginSideRequests: [{ origin: SERVICE_ORIGIN, path: '/rpc/tenant', method: 'POST', maxPerLoginStage: 2 }],
    });
  }, SCENARIO_TIMEOUT_MS);
});

describe('MI-F5: back to the manual login, the screen save still does not change the destination (3b)', () => {
  it('rejects the save that changes the token target path after the profile went back to MANUAL_SESSION', async () => {
    expect(await switchToAutomated(PROFILES.roundTrip)).toMatchObject({ ok: true });
    const automated = await profileOf(PROFILES.roundTrip);
    expect(await valueOf('updateProfileFn', 'POST', {
      profile: { ...automated, revision: automated.revision + 1, auth: 'MANUAL_SESSION' }, expectedRevision: automated.revision,
    })).toMatchObject({ ok: true });
    const manual = await profileOf(PROFILES.roundTrip);
    const before = await storedSetupOf(PROFILES.roundTrip);
    expect(await valueOf('saveAuthSetupFn', 'POST', {
      setup: { ...before, profileRevision: manual.revision, automatedLogin: null, maxLoginAttempts: 1, scriptLogin: { origin: SERVICE_ORIGIN, path: '/evil/token', requiredQuery: [] } },
    })).toMatchObject({ ok: false, reason: OBSERVED_ONLY });
    expect((await storedSetupOf(PROFILES.roundTrip))['scriptLogin']).toEqual(before['scriptLogin']);
  }, SCENARIO_TIMEOUT_MS);
});

describe('MI-F5: the draft save checks the path and the required query of the row (3c)', () => {
  const draftSave = async (scriptLogin: Setup) => {
    const profile = await profileOf(PROFILES.draft);
    const setup = { ...(await storedSetupOf(PROFILES.draft)), profileRevision: profile.revision + 1, scriptLogin };
    return valueOf('saveAuthSetupWithServiceOriginsFn', 'POST', { setup, expectedRevision: profile.revision, row: { jobId: JOBS.draft, passed: false, index: 0 } });
  };

  it.each([
    ['another path', { origin: OBSERVED_ORIGIN, path: '/evil', requiredQuery: [GRANT] }],
    ['no required query', { origin: OBSERVED_ORIGIN, path: TOKEN_PATH, requiredQuery: [] }],
    ['another value of the required query', { origin: OBSERVED_ORIGIN, path: TOKEN_PATH, requiredQuery: [{ name: 'grant_type', value: 'client_credentials' }] }],
  ])('rejects the token target with %s than the row, and saves nothing', async (_name, scriptLogin) => {
    const profile = await profileOf(PROFILES.draft);
    const setup = await storedSetupOf(PROFILES.draft);
    expect(await draftSave(scriptLogin)).toMatchObject({ ok: false, reason: OBSERVED_ONLY });
    expect(await profileOf(PROFILES.draft)).toEqual(profile);
    expect(await storedSetupOf(PROFILES.draft)).toEqual(setup);
  });

  it('saves the token target that is the same as the row', async () => {
    expect(await draftSave({ origin: OBSERVED_ORIGIN, path: TOKEN_PATH, requiredQuery: [GRANT] })).toMatchObject({ ok: true });
    expect(await profileOf(PROFILES.draft)).toMatchObject({ approvedServiceOrigins: [SERVICE_ORIGIN, OBSERVED_ORIGIN] });
    expect((await storedSetupOf(PROFILES.draft))['scriptLogin']).toEqual({ origin: OBSERVED_ORIGIN, path: TOKEN_PATH, requiredQuery: [GRANT] });
  });

  it('rejects the save of a hand-made draft URL whose path is not the one of the row, on the screen', async () => {
    const draft = encodeURIComponent(JSON.stringify({ scriptLogin: { origin: OBSERVED_ORIGIN, path: '/evil', requiredQuery: [] } }));
    const row = encodeURIComponent(JSON.stringify({ jobId: JOBS.screenDraft, passed: false, index: 0 }));
    const page = await (context as BrowserContext).newPage();
    try {
      await page.goto(`${started().origin}/auth-setup/${PROFILES.screenDraft}?draft=${draft}&row=${row}`, { waitUntil: 'networkidle' });
      await openAuthSetupAdvancedSettings(page, UI_TIMEOUT_MS);
      await page.getByTestId('auth-setup-form').waitFor({ timeout: UI_TIMEOUT_MS });
      await page.getByRole('button', { name: LOCAL_UI_AUTH_TEXT.setup.save }).click();
      const rejection = page.getByTestId('auth-setup-rejection');
      await rejection.waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await rejection.getAttribute('data-reason')).toBe(OBSERVED_ONLY);
      expect(await rejection.textContent()).toBe(AUTH_SETUP_STORE_REJECTION_DESCRIPTIONS[OBSERVED_ONLY].description);
    } finally {
      await page.close();
    }
    expect(await profileOf(PROFILES.screenDraft)).toMatchObject({ approvedServiceOrigins: [SERVICE_ORIGIN] });
    expect((await storedSetupOf(PROFILES.screenDraft))['scriptLogin']).toEqual({ origin: SERVICE_ORIGIN, path: TOKEN_PATH, requiredQuery: [GRANT] });
  }, SCENARIO_TIMEOUT_MS);
});

describe('MI-F5: the first save of the auth setup is the proposal or has no destination', () => {
  it('rejects a first save with a token target that no entry check proposed, and accepts the one with the login page URL only', async () => {
    const setup = scriptSetupOf(PROFILES.first, 1, false);
    expect(await valueOf('saveAuthSetupFn', 'POST', { setup })).toMatchObject({ ok: false, reason: OBSERVED_ONLY });
    expect(await valueOf('saveAuthSetupFn', 'POST', { setup: { ...setup, loginSideRequests: [], scriptLogin: { origin: SERVICE_ORIGIN, path: '/evil', requiredQuery: [] } } }))
      .toMatchObject({ ok: false, reason: OBSERVED_ONLY });
    expect(await setupOf(PROFILES.first)).toBeNull();
    expect(await valueOf('saveAuthSetupFn', 'POST', { setup: { ...setup, scriptLogin: null, loginSideRequests: [], successStorageKey: null } }))
      .toMatchObject({ ok: true });
  });

  it('rejects the first save of an AUTOMATED_LOGIN profile without an auth setup (the form before MI)', async () => {
    const setup = { ...scriptSetupOf(PROFILES.firstAutomated, 1, true), scriptLogin: { origin: SERVICE_ORIGIN, path: '/evil/token', requiredQuery: [] } };
    expect(await valueOf('saveAuthSetupFn', 'POST', { setup })).toMatchObject({ ok: false, reason: OBSERVED_ONLY });
    expect(await setupOf(PROFILES.firstAutomated)).toBeNull();
  });
});

describe('MI-F5: the gate of the profile update is checked in the transaction (3d, I-A)', () => {
  it('never lets both of the concurrent requests (back to manual, and to automated with a wider configuration) through', async () => {
    let passed = 0;
    for (let attempt = 0; attempt < RACE_TRIES; attempt += 1) {
      const before = await profileOf(PROFILES.race);
      if (before.auth !== 'AUTOMATED_LOGIN') {
        // テストの準備（保存の部品で直接。手動から自動へは保存の部品の層では当たらない）: 自動ログインに戻す。
        const setup = await storedSetupOf(PROFILES.race);
        expect(await saveProfileAndAuthSetupInStore(rootOf().root, { ...before, revision: before.revision + 1, auth: 'AUTOMATED_LOGIN' }, before.revision, {
          ...setup, profileRevision: before.revision + 1, automatedLogin: AUTOMATED_LOGIN, maxLoginAttempts: AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
        })).toMatchObject({ ok: true });
      }
      const current = await profileOf(PROFILES.race);
      const revision = current.revision;
      await Promise.all([
        valueOf('updateProfileFn', 'POST', { profile: { ...current, revision: revision + 1, auth: 'MANUAL_SESSION' }, expectedRevision: revision }),
        valueOf('updateProfileFn', 'POST', {
          profile: {
            ...current, revision: revision + 2, auth: 'AUTOMATED_LOGIN', targetConfigPath: `config/targets/${WIDE_CONFIG}.json`,
            approvedTestOrigins: [TEST_ORIGIN, OTHER_TEST_ORIGIN],
          },
          expectedRevision: revision + 1,
        }),
      ]);
      const after = await profileOf(PROFILES.race);
      if (after.auth === 'AUTOMATED_LOGIN' && after.targetConfigPath.endsWith(`${WIDE_CONFIG}.json`)) {
        passed += 1;
        break;
      }
    }
    expect(passed).toBe(0);
  }, SCENARIO_TIMEOUT_MS);
});

describe('MI-F5: the draft save checks the revision the screen read first (M-1)', () => {
  it('never writes the draft save on a stale profile over a concurrent profile save', async () => {
    let lost = 0;
    for (let attempt = 0; attempt < RACE_TRIES; attempt += 1) {
      // テストの準備: 観察した Origin を外し、token の送信先を元に戻す（保存の部品で直接）。
      const before = await profileOf(PROFILES.stale);
      if ((before.approvedServiceOrigins ?? []).includes(OBSERVED_ORIGIN)) {
        const setup = await storedSetupOf(PROFILES.stale);
        expect(await saveProfileAndAuthSetupInStore(rootOf().root, { ...before, revision: before.revision + 1, approvedServiceOrigins: [SERVICE_ORIGIN] }, before.revision, {
          ...setup, profileRevision: before.revision + 1, scriptLogin: { origin: SERVICE_ORIGIN, path: TOKEN_PATH, requiredQuery: [GRANT] },
        })).toMatchObject({ ok: true });
      }
      const current = await profileOf(PROFILES.stale);
      const revision = current.revision;
      const setup = await storedSetupOf(PROFILES.stale);
      const evidence = `mif5-stale-evidence-${String(attempt)}`;
      const [edited, drafted] = await Promise.all([
        valueOf<{ ok: boolean }>('updateProfileFn', 'POST', { profile: { ...current, revision: revision + 1, environmentEvidenceRef: evidence }, expectedRevision: revision }),
        valueOf<{ ok: boolean }>('saveAuthSetupWithServiceOriginsFn', 'POST', {
          setup: { ...setup, profileRevision: revision + 2, scriptLogin: { origin: OBSERVED_ORIGIN, path: TOKEN_PATH, requiredQuery: [GRANT] } },
          expectedRevision: revision + 1,
          row: { jobId: JOBS.stale, passed: false, index: 0 },
        }),
      ]);
      const after = await profileOf(PROFILES.stale);
      if (edited.ok && drafted.ok && after.environmentEvidenceRef !== evidence) {
        lost += 1;
        break;
      }
    }
    expect(lost).toBe(0);
  }, SCENARIO_TIMEOUT_MS);
});

describe('MI-F5: the auth setup screen shows the destination read-only when an auth setup exists (7)', () => {
  it('has no input for the destination items, and keeps the inputs of the other fields', async () => {
    const page = await (context as BrowserContext).newPage();
    try {
      await page.goto(`${started().origin}/auth-setup/${PROFILES.draft}`, { waitUntil: 'networkidle' });
      await openAuthSetupAdvancedSettings(page, UI_TIMEOUT_MS);
      await page.getByTestId('auth-setup-form').waitFor({ timeout: UI_TIMEOUT_MS });
      for (const name of ['loginStartUrl', 'loginTransport', 'loginPostEndpoints', 'scriptOrigin', 'scriptPath', 'requiredQueryName0', 'sideRequestOrigin0', 'sideRequestPath0']) {
        expect(await page.locator(`[name="${name}"]`).count(), name).toBe(0);
      }
      expect(await page.getByTestId('auth-setup-destination-locked').textContent()).toBe(LOCAL_UI_AUTH_TEXT.setup.destinationLockedNote);
      // PL-4（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 3。前は読むだけの値で出していた）: 変えられない送信先は、読むだけの値でも出さない。
      expect(await page.locator('main [data-testid^="auth-setup-destination-"]:not([data-testid="auth-setup-destination-locked"])').count()).toBe(0);
      expect(await page.getByRole('main').innerText()).not.toContain(TOKEN_PATH);
      for (const name of ['excludedPaths', 'auditPathPrefixes', 'successPathPrefix', 'storagePrefix']) {
        expect(await page.locator(`[name="${name}"]`).count(), name).toBe(1);
      }
    } finally {
      await page.close();
    }
  }, SCENARIO_TIMEOUT_MS);
});

describe('PL-S: the token target, the required query and the side requests are read-only without an auth setup too (MI 4.7.1 の 6)', () => {
  it('shows the draft without a destination (no entry check) read-only, and its first save on the screen passes', async () => {
    const page = await (context as BrowserContext).newPage();
    try {
      await page.goto(`${started().origin}/auth-setup/${PROFILES.firstScreen}`, { waitUntil: 'networkidle' });
      await openAuthSetupAdvancedSettings(page, UI_TIMEOUT_MS);
      await page.getByTestId('auth-setup-form').waitFor({ timeout: UI_TIMEOUT_MS });
      // 送り方の案がないときの既定は、送信先のない形（スクリプトの送信）。設定がないので、ログインの画面の URL と送り方は入力の欄のまま。
      expect(await page.locator('input[name="loginTransport"][value="SCRIPT_REQUEST"]').isChecked()).toBe(true);
      expect(await page.locator('[name="loginStartUrl"]').count()).toBe(1);
      expect(await page.getByTestId('auth-setup-destination-locked').count()).toBe(0);
      // token の送信先・必須の query・ログインに伴う送信は、入力の欄を出さず、読むだけ（観察が入れる）。
      for (const name of ['scriptOrigin', 'scriptPath', 'requiredQueryName0', 'sideRequestOrigin0', 'sideRequestPath0']) {
        expect(await page.locator(`[name="${name}"]`).count(), name).toBe(0);
      }
      // OP-DEF の 5: 足すボタンの文言はカタログから消した（使い先がない）。前の名前のボタンが出ないことは、今も確かめる。
      for (const label of REMOVED_ADD_BUTTON_LABELS) {
        expect(await page.getByRole('button', { name: label }).count(), label).toBe(0);
      }
      // PL-4（前は読むだけの値「なし」で出していた）: 読むだけの値も出さない。
      for (const testId of ['auth-setup-destination-script-origin', 'auth-setup-destination-script-path', 'auth-setup-destination-required-query',
        'auth-setup-destination-side-requests']) {
        expect(await page.getByTestId(testId).count(), testId).toBe(0);
      }
      // 最初の保存: ログインの画面の URL と、ログインが済んだと判定するパスだけを入れて保存すると、そのまま通る（送信先のない形）。
      await page.locator('[name="loginStartUrl"]').fill(`${TEST_ORIGIN}/auth`);
      await page.locator('[name="successPathPrefix"]').fill('/admin');
      await page.getByRole('button', { name: LOCAL_UI_AUTH_TEXT.setup.save }).click();
      await page.locator('[data-testid="auth-setup-saved"], [data-testid="auth-setup-rejection"]').first().waitFor({ timeout: UI_TIMEOUT_MS });
      expect(await page.getByTestId('auth-setup-rejection').count()).toBe(0);
      expect(await setupOf(PROFILES.firstScreen)).toMatchObject({ loginTransport: 'SCRIPT_REQUEST', scriptLogin: null, loginSideRequests: [], loginPostEndpoints: [] });
    } finally {
      await page.close();
    }
  }, SCENARIO_TIMEOUT_MS);
});
