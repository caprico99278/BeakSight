/**
 * MI-F1（設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.7.1。独立レビュー MI-R の Critical C-1・Important I-1・Minor 2）: 人が手動の
 * ログインで観察していない送信先へ、資格情報が送られうる道を、画面のサーバの Server Function を HTTP で直接送って確かめる（ビルドした画面のサーバ、一時の
 * root。ブラウザとワーカーは起動しない。サイトへは接続しない）。値は匿名（`example.invalid` とループバック）。
 * - C-1: 自動ログインのプロファイルを、編集で手動に戻して観察していない Origin X を足し、編集で自動ログインに戻し、認証の設定の保存で token の送信先を X に
 *   する道。どの段も、何も保存せずに拒む。
 * - 承認したサービスの Origin を足すのは観察からだけ: 編集（方式によらず）と作成は足さない。認証の設定の画面の下書きからの保存は、ブラウザの送る Origin を
 *   信用せず、ジョブの記録と行から組み立て直した Origin だけを足す（ジョブの記録に結びつかない下書きからは足さない）。
 * - 自動ログインへは切り替えだけで入る: 作成と編集で、方式を `AUTOMATED_LOGIN` にする保存を拒む。手動へ戻すのは受ける。
 * - I-1: 自動ログインのプロファイルで、送信先を変える認証の設定の保存・プロファイルの保存を拒む。送信先でない欄（読まないパス）の保存は受ける。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTH_SETUP_SCHEMA_VERSION_3, AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS } from '../../../src/control/auth/auth-setup-contracts.js';
import { loadConfig } from '../../../src/config/load-config.js';
import { createStartingJob, recordAuthState, recordEnded, type AuditJobLoginStageSummary, type NewAuditJob } from '../../../src/control/job/job-store.js';
import { saveAuthSetup } from '../../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase } from '../../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../../src/control/store/database-path.js';
import { createProfile } from '../../../src/control/store/profile-store.js';
import { WORKER_AUDIT_JOB_KIND } from '../../../src/core/audit-job-values.js';
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
import { callServerFunction, readServerFunctionIds } from './helpers/server-functions.ts';

const SCENARIO_TIMEOUT_MS = 120_000;
const MAX_PAGES = 3;
const TEST_ORIGIN = 'http://127.0.0.1:4173';
const SERVICE_ORIGIN = 'https://service.example.invalid';
const UNOBSERVED_ORIGIN = 'https://unobserved.example.invalid';
const OBSERVED_ORIGIN = 'https://observed.example.invalid';
const AUTO_PROFILE = 'mif1-auto';
const MANUAL_PROFILE = 'mif1-manual';
const NEW_PROFILE = 'mif1-new';
const WIDE_CONFIG = 'mif1-auto-wide';
const MANUAL_JOB = 'job-mif1-manual';
const TOKEN_PATH = '/auth/v1/token';
const STATUS_OK = 200;
const STATUS_BAD_REQUEST = 400;

const REASONS = Object.freeze({
  locked: 'CREDENTIAL_DESTINATION_LOCKED',
  notObserved: 'SERVICE_ORIGIN_ADD_NOT_OBSERVED',
  switchOnly: 'AUTOMATED_LOGIN_SWITCH_REQUIRED',
  automatedContext: 'NEW_TARGET_FROM_AUTOMATED_LOGIN',
});

let root: TemporaryUiRoot | undefined;
let server: StartedServer | undefined;
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
const call = (name: string, method: 'GET' | 'POST', data?: unknown) =>
  callServerFunction({ port: started().port, origin: started().origin, cookie, ids }, name, method, data);
const valueOf = async <T = Record<string, unknown>>(name: string, method: 'GET' | 'POST', data?: unknown): Promise<T> => {
  const result = await call(name, method, data);
  expect(result.response.status, name).toBe(STATUS_OK);
  return result.value as T;
};

interface PageProfile {
  readonly profileId: string;
  readonly revision: number;
  readonly auth: string;
  readonly targetConfigPath: string;
  readonly approvedTestOrigins: readonly string[];
  readonly approvedServiceOrigins?: readonly string[];
  readonly [key: string]: unknown;
}
const profileOf = async (profileId: string): Promise<PageProfile> =>
  (await valueOf<{ readonly profile: PageProfile }>('getProfileFn', 'GET', { profileId })).profile;
const setupOf = async (profileId: string): Promise<Record<string, unknown>> =>
  (await valueOf<{ readonly stored: { readonly setup: Record<string, unknown> } }>('getAuthSetupFn', 'GET', { profileId })).stored.setup;

const AUTOMATED_LOGIN = Object.freeze({
  usernameSelector: '#email', passwordSelector: '#password', submitSelector: '#login',
  failureConditions: { invalidCredentials: null, accountLocked: null, mfaRequired: null, credentialExpired: null },
});

const scriptSetupOf = (profileId: string, profileRevision: number, automated: boolean) => ({
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
  scriptLogin: { origin: SERVICE_ORIGIN, path: TOKEN_PATH, requiredQuery: [{ name: 'grant_type', value: 'password' }] },
  loginSideRequests: [],
  successStorageKey: { origin: TEST_ORIGIN, prefix: '', suffix: '-token' },
});

const profileDocumentOf = (profileId: string, auth: string, approvedServiceOrigins: readonly string[]) => ({
  schemaVersion: 'beaksight-profile/1', profileId, revision: 1, targetConfigPath: `config/targets/${profileId}.json`, environment: 'TEST',
  mode: 'TEST_AUTH_PASSIVE', auth, approvedTestOrigins: [TEST_ORIGIN], approvedServiceOrigins, environmentEvidenceRef: `${profileId}-evidence`,
});

/** 手動のログインのジョブの止めた行（今と違う token の送信先 `OBSERVED_ORIGIN`）。 */
const MANUAL_SUMMARY: AuditJobLoginStageSummary = {
  scriptLogin: null,
  blockedRequests: {
    requests: [{
      origin: OBSERVED_ORIGIN, path: TOKEN_PATH, resourceType: 'fetch', reason: 'NON_READ_METHOD', count: 1,
      query: { names: ['grant_type'], omitted: 0, values: [{ name: 'grant_type', value: 'password' }] },
    }],
    unlisted: 0,
  },
  observation: { storageKeys: { origin: TEST_ORIGIN, shapes: [{ prefix: '', suffix: '-token' }], omitted: 0 } },
};

/** テストの準備（管理データの保存の部品を直接呼ぶ。作成と切り替えの口の守りは画面のサーバ。設計書 4.7.1 の 4）。 */
const prepareStore = async (): Promise<void> => {
  const database = openControlDatabase(resolveControlDatabasePath(rootOf().root));
  try {
    for (const [profileId, auth] of [[AUTO_PROFILE, 'AUTOMATED_LOGIN'], [MANUAL_PROFILE, 'MANUAL_SESSION']] as const) {
      const profile = profileDocumentOf(profileId, auth, [SERVICE_ORIGIN]);
      const targetConfig = await loadConfig(`${rootOf().root}/${profile.targetConfigPath}`);
      const resolveContext = () => ({ targetConfig });
      expect(createProfile(database, profile, { resolveContext }).ok).toBe(true);
      expect(saveAuthSetup(database, scriptSetupOf(profileId, 1, auth === 'AUTOMATED_LOGIN'), { resolveContext })).toMatchObject({ ok: true });
    }
    const job: Pick<NewAuditJob, 'jobId' | 'jobKind' | 'profileId'> = { jobId: MANUAL_JOB, jobKind: WORKER_AUDIT_JOB_KIND, profileId: MANUAL_PROFILE };
    expect(createStartingJob(database, { ...job, profileRevision: 1, startNew: true, createdAt: '20261026010000' }, () => null)).toEqual({ ok: true });
    expect(recordAuthState(database, MANUAL_JOB, 'LOGIN_TIMEOUT', null, MANUAL_SUMMARY)).toBe(true);
    expect(recordEnded(database, MANUAL_JOB, { state: 'FAILED', reason: 'LOGIN_TIMEOUT', exitCode: null, at: '20261026011000' })).toBe(true);
  } finally {
    closeControlDatabase(database);
  }
};

beforeAll(async () => {
  root = createTemporaryUiRoot('built');
  for (const name of [AUTO_PROFILE, MANUAL_PROFILE, NEW_PROFILE]) {
    writeAuthTargetConfig(root.root, name, TEST_ORIGIN, '/admin', MAX_PAGES);
  }
  ids = readServerFunctionIds(`${root.root}/apps/local-ui/dist/server/server.js`);
  server = await startLauncher(root, await findFreePort());
  const exchange = await rawRequest(server.port, `${server.tokenUrl.pathname}${server.tokenUrl.search}`);
  cookie = parseSetCookie(exchange.headers['set-cookie'])?.pair ?? '';
  await prepareStore();
}, SCENARIO_TIMEOUT_MS);

afterAll(async () => {
  await stopServer(server);
  root?.remove();
});

describe('MI-F1: the C-1 path (manual and back to automated, then the token target to an unobserved origin) is closed', () => {
  it('rejects every step and keeps the token target', async () => {
    const before = await profileOf(AUTO_PROFILE);
    const setupBefore = await setupOf(AUTO_PROFILE);
    // 1. 手動のログインに戻すと同時に、観察していない Origin X を足す（方式によらず、足す保存を拒む）。
    expect(await valueOf('updateProfileFn', 'POST', {
      profile: { ...before, revision: before.revision + 1, auth: 'MANUAL_SESSION', approvedServiceOrigins: [SERVICE_ORIGIN, UNOBSERVED_ORIGIN] },
      expectedRevision: before.revision,
    })).toMatchObject({ ok: false, reason: REASONS.notObserved });
    // 2. 編集で自動ログインへ（切り替えだけで入る）。手動へ戻すのは受けるので、先に戻してから確かめる。
    expect(await valueOf('updateProfileFn', 'POST', {
      profile: { ...before, revision: before.revision + 1, auth: 'MANUAL_SESSION' },
      expectedRevision: before.revision,
    })).toMatchObject({ ok: true });
    const manual = await profileOf(AUTO_PROFILE);
    expect(await valueOf('updateProfileFn', 'POST', {
      profile: { ...manual, revision: manual.revision + 1, auth: 'AUTOMATED_LOGIN' },
      expectedRevision: manual.revision,
    })).toMatchObject({ ok: false, reason: REASONS.switchOnly });
    expect((await profileOf(AUTO_PROFILE)).auth).toBe('MANUAL_SESSION');
    expect((await profileOf(AUTO_PROFILE)).approvedServiceOrigins).toEqual([SERVICE_ORIGIN]);
    expect((await setupOf(AUTO_PROFILE))['scriptLogin']).toEqual(setupBefore['scriptLogin']);
  });
});

describe('MI-F1: approved service origins are added from the observation only', () => {
  it('rejects a profile update that adds a service origin to a MANUAL_SESSION profile, and accepts the one that removes it', async () => {
    const before = await profileOf(MANUAL_PROFILE);
    expect(await valueOf('updateProfileFn', 'POST', {
      profile: { ...before, revision: before.revision + 1, approvedServiceOrigins: [SERVICE_ORIGIN, UNOBSERVED_ORIGIN] },
      expectedRevision: before.revision,
    })).toMatchObject({ ok: false, reason: REASONS.notObserved });
    expect(await profileOf(MANUAL_PROFILE)).toEqual(before);
  });

  it('rejects creating a profile with approved service origins, and creating an AUTOMATED_LOGIN profile (Minor 2)', async () => {
    expect(await valueOf('createProfileFn', 'POST', { profile: profileDocumentOf(NEW_PROFILE, 'MANUAL_SESSION', [SERVICE_ORIGIN]) }))
      .toMatchObject({ ok: false, reason: REASONS.notObserved });
    const { approvedServiceOrigins: _omitted, ...withoutServices } = profileDocumentOf(NEW_PROFILE, 'AUTOMATED_LOGIN', []);
    expect(await valueOf('createProfileFn', 'POST', { profile: withoutServices })).toMatchObject({ ok: false, reason: REASONS.switchOnly });
    expect(await valueOf('getProfileFn', 'GET', { profileId: NEW_PROFILE })).toBeNull();
  });

  it('does not trust the origins the screen sends: a hand-made draft without a job row cannot add an origin', async () => {
    const before = await profileOf(MANUAL_PROFILE);
    const setup = { ...(await setupOf(MANUAL_PROFILE)), profileRevision: before.revision + 1, scriptLogin: { origin: UNOBSERVED_ORIGIN, path: TOKEN_PATH, requiredQuery: [] } };
    // 今の形（ブラウザの送る `addServiceOrigins`）は受けない（入力の形の誤り）。
    const legacy = await call('saveAuthSetupWithServiceOriginsFn', 'POST', { setup, expectedRevision: before.revision, addServiceOrigins: [UNOBSERVED_ORIGIN] });
    expect(legacy.response.status).toBe(STATUS_BAD_REQUEST);
    // ジョブの行が観察した Origin と違う Origin を足す保存は拒む。
    expect(await valueOf('saveAuthSetupWithServiceOriginsFn', 'POST', {
      setup, expectedRevision: before.revision, row: { jobId: MANUAL_JOB, passed: false, index: 0 },
    })).toMatchObject({ ok: false, reason: REASONS.notObserved });
    expect(await profileOf(MANUAL_PROFILE)).toEqual(before);
  });

  it('adds the origin rebuilt from the job row of the manual login (the draft from the job page)', async () => {
    const before = await profileOf(MANUAL_PROFILE);
    const setup = {
      ...(await setupOf(MANUAL_PROFILE)),
      profileRevision: before.revision + 1,
      scriptLogin: { origin: OBSERVED_ORIGIN, path: TOKEN_PATH, requiredQuery: [{ name: 'grant_type', value: 'password' }] },
    };
    expect(await valueOf('saveAuthSetupWithServiceOriginsFn', 'POST', {
      setup, expectedRevision: before.revision, row: { jobId: MANUAL_JOB, passed: false, index: 0 },
    })).toMatchObject({ ok: true, stored: { freshness: 'CURRENT' } });
    expect(await profileOf(MANUAL_PROFILE)).toMatchObject({ revision: before.revision + 1, approvedServiceOrigins: [SERVICE_ORIGIN, OBSERVED_ORIGIN] });
  });
});

describe('MI-F1: the credential destination of an AUTOMATED_LOGIN profile does not change (I-1)', () => {
  const AUTO_LOCKED = 'mif1-auto-locked';

  beforeAll(async () => {
    writeAuthTargetConfig(rootOf().root, AUTO_LOCKED, TEST_ORIGIN, '/admin', MAX_PAGES);
    writeAuthTargetConfig(rootOf().root, WIDE_CONFIG, TEST_ORIGIN, '/admin', MAX_PAGES);
    const database = openControlDatabase(resolveControlDatabasePath(rootOf().root));
    try {
      const profile = profileDocumentOf(AUTO_LOCKED, 'AUTOMATED_LOGIN', [SERVICE_ORIGIN]);
      const targetConfig = await loadConfig(`${rootOf().root}/${profile.targetConfigPath}`);
      const resolveContext = () => ({ targetConfig });
      expect(createProfile(database, profile, { resolveContext }).ok).toBe(true);
      expect(saveAuthSetup(database, scriptSetupOf(AUTO_LOCKED, 1, true), { resolveContext })).toMatchObject({ ok: true });
    } finally {
      closeControlDatabase(database);
    }
  });

  it.each([
    ['the token target path', (setup: Record<string, unknown>) => ({ ...setup, scriptLogin: { origin: SERVICE_ORIGIN, path: '/other/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] } })],
    ['the required query', (setup: Record<string, unknown>) => ({ ...setup, scriptLogin: { origin: SERVICE_ORIGIN, path: TOKEN_PATH, requiredQuery: [{ name: 'grant_type', value: 'client_credentials' }] } })],
    ['a new login side request', (setup: Record<string, unknown>) => ({ ...setup, loginSideRequests: [{ origin: SERVICE_ORIGIN, path: '/rpc/x', method: 'POST', maxPerLoginStage: 3 }] })],
    ['the form endpoint', (setup: Record<string, unknown>) => ({
      ...setup, loginTransport: 'FORM_NAVIGATION', scriptLogin: null, successStorageKey: null, loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/collect' }],
    })],
  ])('rejects the auth setup save that changes %s', async (_name, change) => {
    const before = await setupOf(AUTO_LOCKED);
    expect(await valueOf('saveAuthSetupFn', 'POST', { setup: change(before) })).toMatchObject({ ok: false, reason: REASONS.locked });
    expect(await setupOf(AUTO_LOCKED)).toEqual(before);
  });

  it('rejects the profile save that changes the target configuration or adds a test origin', async () => {
    const before = await profileOf(AUTO_LOCKED);
    expect(await valueOf('updateProfileFn', 'POST', {
      profile: { ...before, revision: before.revision + 1, targetConfigPath: `config/targets/${WIDE_CONFIG}.json` },
      expectedRevision: before.revision,
    })).toMatchObject({ ok: false, reason: REASONS.locked });
    expect(await profileOf(AUTO_LOCKED)).toEqual(before);
  });

  it('still saves the excluded paths (the audit start screen), which are not a destination', async () => {
    const before = await setupOf(AUTO_LOCKED);
    expect(await valueOf('saveAuthSetupFn', 'POST', { setup: { ...before, excludedPaths: ['/auth/logout', '/danger'] } })).toMatchObject({ ok: true });
  });
});
