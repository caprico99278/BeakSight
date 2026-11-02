/**
 * MI-F3 項目 6（ユーザーの指示 2026-10-26「フォームやボタンは増やさない。基本的に自動化を厳守する」。設計書
 * `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.7.1 の終わりの段落）: 使えないプロファイル（取り消していない、認証の方式が自動ログインで、
 * 認証の設定がない。MI より前に作られた形）を、画面のサーバの起動のときに 1 回だけ自動で取り消す。
 * - 処理（`src/server/unusable-profile-retirement.ts` の `retireUnusableProfiles`）を、管理データ（一時のフォルダ）で確かめる: 対象だけを今の取り消しの保存の部品で
 *   取り消し、残った資格情報の片付けを呼ぶ。設定のある自動ログインのプロファイル、手動のプロファイル、動いているジョブのあるプロファイルは取り消さない。2 回目は
 *   何もしない。判定は `src/control/unusable-profile.ts` の 1 か所。
 * - 本物の起動の部品（ビルドした画面のサーバ、一時の root）: 起動の後に対象が取り消され、画面のサーバのログ（標準出力）に、取り消したプロファイルの ID と理由が
 *   1 行ずつ残る。ほかのプロファイルは取り消されない。2 回目の起動では、何もしない（ログの行もない）。画面には、新しい表示もボタンも足さない。
 * 監査の対象のサイトへは要求を送らない（ジョブを始めない。対象の設定の Origin は使わない 127.0.0.1 の port）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../../../tests/helpers/auth-setup-samples.js';
import { loadConfig } from '../../../src/config/load-config.js';
import { AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS, type AuthSetup } from '../../../src/control/auth/auth-setup-contracts.js';
import { MIN_PROFILE_REVISION, type SiteProfile } from '../../../src/control/contracts.js';
import { saveAuthSetup } from '../../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../../src/control/store/database-path.js';
import { createProfile, getProfile } from '../../../src/control/store/profile-store.js';
import { createStartingJob } from '../../../src/control/job/job-store.js';
import { WORKER_AUDIT_JOB_KIND } from '../../../src/core/audit-job-values.js';
import { formatCount } from '../../../src/presentation/format.js';
import { LOCAL_UI_JOB_CONSOLE_TEXT, LOCAL_UI_UNUSABLE_PROFILE_TEXT } from '../../../src/presentation/messages.js';
import {
  TEST_ORIGIN,
  TEST_TARGET_PATH,
  resolveTestContext,
  testAuthProfile,
} from '../../../tests/integration/control-profile-fixtures.js';
import { retireUnusableProfiles, unusableProfileRetirementLinesOf } from '../src/server/unusable-profile-retirement';
import { writeAuditTargetConfig } from './helpers/audit-site.ts';
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
import { createProfileInStore } from './helpers/profile-store-setup.ts';
import { callServerFunction, readServerFunctionIds } from './helpers/server-functions.ts';

const UNUSABLE = 'mi-f3-unusable';
const AUTOMATED_WITH_SETUP = 'mi-f3-automated';
const MANUAL = 'mi-f3-manual';
const ACTIVE_JOB = 'mi-f3-active-job';
const TARGET_CONFIG_TEXT = JSON.stringify({ target: { id: 'example-test' } });

/** 自動ログインの認証の設定（`profileId` に結びつく）。 */
const automatedSetupOf = (profileId: string, origin: string): AuthSetup => ({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId,
  profileRevision: MIN_PROFILE_REVISION,
  loginStartUrl: `${origin}/admin/login`,
  loginPostEndpoints: [{ origin, path: '/admin/login' }],
  successCondition: { pathPrefix: '/admin/dashboard', selector: '#account-menu' },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: ['/admin/logout'],
  auditPathPrefixes: ['/admin/'],
  maxLoginAttempts: AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
  allowedIdpOrigins: [],
  automatedLogin: {
    usernameSelector: '#email',
    passwordSelector: '#password',
    submitSelector: '#login',
    failureConditions: { invalidCredentials: { pathPrefix: '/admin/login', selector: '#error' }, accountLocked: null, mfaRequired: null, credentialExpired: null },
  },
});

describe('MI-F3: retiring the unusable profiles (the control store in a temporary folder)', () => {
  let root = '';
  let database: ControlDatabase;
  const cleaned: string[] = [];

  const automatedProfileOf = (profileId: string): SiteProfile => ({ ...testAuthProfile(profileId, MIN_PROFILE_REVISION), auth: 'AUTOMATED_LOGIN' });
  const run = () => retireUnusableProfiles({
    database,
    hasActiveJob: (profileId) => profileId === ACTIVE_JOB,
    removeCredential: async (profileId) => {
      cleaned.push(profileId);
      return 'REMOVED';
    },
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'beaksight-mi-f3-unusable-'));
    mkdirSync(dirname(join(root, TEST_TARGET_PATH)), { recursive: true });
    writeFileSync(join(root, TEST_TARGET_PATH), TARGET_CONFIG_TEXT, 'utf8');
    database = openControlDatabase(resolveControlDatabasePath(root));
    cleaned.length = 0;
    for (const profile of [automatedProfileOf(UNUSABLE), automatedProfileOf(AUTOMATED_WITH_SETUP), testAuthProfile(MANUAL, MIN_PROFILE_REVISION), automatedProfileOf(ACTIVE_JOB)]) {
      expect(createProfile(database, profile, { resolveContext: resolveTestContext }).ok).toBe(true);
    }
    expect(saveAuthSetup(database, automatedSetupOf(AUTOMATED_WITH_SETUP, TEST_ORIGIN), { resolveContext: resolveTestContext }).ok).toBe(true);
  });

  afterEach(async () => {
    closeControlDatabase(database);
    await rm(root, { recursive: true, force: true });
  });

  it('retires only the automated login profile without an auth setup and no active job, and cleans up its credential', async () => {
    expect(await run()).toEqual([{ profileId: UNUSABLE, reason: 'AUTOMATED_LOGIN_WITHOUT_AUTH_SETUP', credentialCleanup: 'REMOVED' }]);
    expect(getProfile(database, UNUSABLE)?.status).toBe('RETIRED');
    for (const profileId of [AUTOMATED_WITH_SETUP, MANUAL, ACTIVE_JOB]) {
      expect(getProfile(database, profileId)?.status, profileId).toBe('ACTIVE');
      expect(getProfile(database, profileId)?.profile.revision, profileId).toBe(MIN_PROFILE_REVISION);
    }
    expect(cleaned).toEqual([UNUSABLE]);
  });

  it('does nothing the second time', async () => {
    await run();
    const retired = getProfile(database, UNUSABLE);
    cleaned.length = 0;
    expect(await run()).toEqual([]);
    expect(getProfile(database, UNUSABLE)).toEqual(retired);
    expect(cleaned).toEqual([]);
  });

  it('writes one log line for each retired profile, with its ID and the reason (and the credential left behind)', () => {
    const text = LOCAL_UI_UNUSABLE_PROFILE_TEXT;
    expect(unusableProfileRetirementLinesOf([
      { profileId: UNUSABLE, reason: 'AUTOMATED_LOGIN_WITHOUT_AUTH_SETUP', credentialCleanup: 'NONE' },
      { profileId: ACTIVE_JOB, reason: 'AUTOMATED_LOGIN_WITHOUT_AUTH_SETUP', credentialCleanup: 'FAILED' },
    ])).toEqual([
      text.retired(UNUSABLE, text.reasons.AUTOMATED_LOGIN_WITHOUT_AUTH_SETUP, false),
      text.retired(ACTIVE_JOB, text.reasons.AUTOMATED_LOGIN_WITHOUT_AUTH_SETUP, true),
    ]);
    expect(unusableProfileRetirementLinesOf([])).toEqual([]);
  });
});

describe('MI-F3: the local UI server retires the unusable profiles when it starts', () => {
  /** 使わない 127.0.0.1 の port（要求を送らない。対象の設定の Origin の形のためだけ）。 */
  const UNUSED_ORIGIN = 'http://127.0.0.1:9';
  let root: TemporaryUiRoot | undefined;
  let server: StartedServer | undefined;

  const rootOf = (): TemporaryUiRoot => {
    if (root === undefined) {
      throw new Error('一時の root がない');
    }
    return root;
  };

  /** 起動し、プロファイルの状態を Server Function で読み、止める（標準出力を返す）。 */
  const startAndRead = async (): Promise<{ readonly statuses: Readonly<Record<string, string>>; readonly output: string }> => {
    server = await startLauncher(rootOf(), await findFreePort());
    const exchange = await rawRequest(server.port, `${server.tokenUrl.pathname}${server.tokenUrl.search}`);
    const cookie = parseSetCookie(exchange.headers['set-cookie'])?.pair ?? '';
    const ids = readServerFunctionIds(`${rootOf().root}/apps/local-ui/dist/server/server.js`);
    const statuses: Record<string, string> = {};
    for (const profileId of [UNUSABLE, AUTOMATED_WITH_SETUP, MANUAL]) {
      const result = await callServerFunction({ port: server.port, origin: server.origin, cookie, ids }, 'getProfileFn', 'GET', { profileId });
      expect(result.response.status).toBe(200);
      statuses[profileId] = (result.value as { status: string }).status;
    }
    const output = server.output();
    await stopServer(server);
    server = undefined;
    return { statuses, output };
  };

  beforeAll(async () => {
    root = createTemporaryUiRoot('built');
    const profileOf = (profileId: string, auth: 'MANUAL_SESSION' | 'AUTOMATED_LOGIN'): Record<string, unknown> => ({
      schemaVersion: 'beaksight-profile/1',
      profileId,
      revision: MIN_PROFILE_REVISION,
      targetConfigPath: writeAuditTargetConfig(rootOf().root, profileId, UNUSED_ORIGIN, { minNavigationIntervalMs: 0, screenshots: false }),
      environment: 'TEST',
      mode: 'TEST_AUTH_PASSIVE',
      auth,
      approvedTestOrigins: [UNUSED_ORIGIN],
      environmentEvidenceRef: 'mi-f3-evidence',
    });
    // MI より前に作られた形（今の画面の道では作れない）は、テストの準備として保存の部品で直接作る。
    for (const profile of [profileOf(UNUSABLE, 'AUTOMATED_LOGIN'), profileOf(AUTOMATED_WITH_SETUP, 'AUTOMATED_LOGIN'), profileOf(MANUAL, 'MANUAL_SESSION')]) {
      expect(await createProfileInStore(rootOf().root, profile)).toMatchObject({ ok: true });
    }
    const database = openControlDatabase(resolveControlDatabasePath(rootOf().root));
    try {
      const path = profileOf(AUTOMATED_WITH_SETUP, 'AUTOMATED_LOGIN')['targetConfigPath'] as string;
      const targetConfig = await loadConfig(`${rootOf().root}/${path}`);
      expect(saveAuthSetup(database, automatedSetupOf(AUTOMATED_WITH_SETUP, UNUSED_ORIGIN), {
        resolveContext: (requested) => (requested === path ? { targetConfig } : undefined),
      }).ok).toBe(true);
    } finally {
      closeControlDatabase(database);
    }
  });

  afterAll(async () => {
    await stopServer(server);
    root?.remove();
  });

  it('retires the unusable profile after the start, logs its ID and the reason, and leaves the others', async () => {
    const text = LOCAL_UI_UNUSABLE_PROFILE_TEXT;
    const first = await startAndRead();
    expect(first.statuses).toEqual({ [UNUSABLE]: 'RETIRED', [AUTOMATED_WITH_SETUP]: 'ACTIVE', [MANUAL]: 'ACTIVE' });
    const line = text.retired(UNUSABLE, text.reasons.AUTOMATED_LOGIN_WITHOUT_AUTH_SETUP, false);
    expect(first.output.split(/\r?\n/u).filter((row) => row === line)).toHaveLength(1);
    for (const profileId of [AUTOMATED_WITH_SETUP, MANUAL]) {
      expect(first.output).not.toContain(profileId);
    }
    // 2 回目の起動では、何もしない（ログの行もない）。
    const second = await startAndRead();
    expect(second.statuses).toEqual(first.statuses);
    expect(second.output).not.toContain(line);
  }, 120_000);
});

// MI-F5（再レビュー MI-R2 の Minor M-2）: 起動の時に自動で取り消したプロファイルの、中断に直したジョブについて、同じ起動のログに「前回の続きから再開する」の
// 案内を出さない（取り消したプロファイルでは再開できない）。終わっていないジョブは同時に 1 つだけなので、取り消すプロファイルのジョブ 1 つで確かめる（取り消して
// いないプロファイルの中断に直したジョブの案内は今どおり。`audit-ui-flows.test.ts`）。
describe('MI-F5: the start log does not offer to resume the jobs of the profiles it retired', () => {
  const UNUSED_ORIGIN = 'http://127.0.0.1:9';
  const RETIRED_WITH_JOB = 'mi-f5-retired-with-job';
  let root: TemporaryUiRoot | undefined;
  let server: StartedServer | undefined;

  beforeAll(async () => {
    root = createTemporaryUiRoot('built');
    const rootPath = root.root;
    expect(await createProfileInStore(rootPath, {
      schemaVersion: 'beaksight-profile/1',
      profileId: RETIRED_WITH_JOB,
      revision: MIN_PROFILE_REVISION,
      targetConfigPath: writeAuditTargetConfig(rootPath, RETIRED_WITH_JOB, UNUSED_ORIGIN, { minNavigationIntervalMs: 0, screenshots: false }),
      environment: 'TEST',
      mode: 'TEST_AUTH_PASSIVE',
      auth: 'AUTOMATED_LOGIN',
      approvedTestOrigins: [UNUSED_ORIGIN],
      environmentEvidenceRef: 'mi-f5-evidence',
    })).toMatchObject({ ok: true });
    // 前の画面のサーバで終わっていなかったジョブ（テストの準備。管理データに直接書く。ワーカーは起動しない）。
    const database = openControlDatabase(resolveControlDatabasePath(rootPath));
    try {
      expect(createStartingJob(database, {
        jobId: 'job-mi-f5-retired', jobKind: WORKER_AUDIT_JOB_KIND, profileId: RETIRED_WITH_JOB, profileRevision: MIN_PROFILE_REVISION, startNew: true,
        createdAt: '20261026010000',
      }, () => null)).toEqual({ ok: true });
    } finally {
      closeControlDatabase(database);
    }
  });

  afterAll(async () => {
    await stopServer(server);
    root?.remove();
  });

  it('retires the profile of the recovered job, and does not offer to resume the job', async () => {
    if (root === undefined) throw new Error('一時の root がない');
    server = await startLauncher(root, await findFreePort());
    const lines = server.output().split(/\r?\n/u);
    await stopServer(server);
    server = undefined;
    const text = LOCAL_UI_UNUSABLE_PROFILE_TEXT;
    expect(lines).toContain(text.retired(RETIRED_WITH_JOB, text.reasons.AUTOMATED_LOGIN_WITHOUT_AUTH_SETUP, false));
    expect(lines).not.toContain(LOCAL_UI_JOB_CONSOLE_TEXT.recoveredJobs(formatCount(1)));
  }, 120_000);
});
