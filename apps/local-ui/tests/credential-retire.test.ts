/**
 * T26g-2（T26R の I1。Task 26 の設計書 4.1、変更履歴の「T26R」）: プロファイルを取り消したら、資格情報のファイルを消して `DELETED` を記録する
 * （`src/server/credential-service.ts` の `removeCredentialOfRetiredProfile`。消す処理は今の `removeCredential` を通す）。
 * - 取り消した後だけ消す（有効なプロファイルでは何もしない）。ファイルがなければ何もしない（記録もしない）。
 * - 削除に失敗したら `FAILED`（取り消しは巻き戻さない。画面は「資格情報の画面から消してください」の案内を出す）。
 * - 管理データは一時のフォルダ、資格情報のファイルの部品は偽の暗号化の部品（`tests/helpers/test-credential-store.ts`）。本物の DPAPI は使わない。
 * - 値を出さない: 応答と管理データのファイルに、目印の値がない（真偽だけを確かめる）。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AUTH_SETUP_SCHEMA_VERSION_2,
  AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
  type AuthSetup,
} from '../../../src/control/auth/auth-setup-contracts.js';
import { SITE_PROFILE_SCHEMA_VERSION, type SiteProfile } from '../../../src/control/contracts.js';
import { CredentialStoreError, credentialFilePathFor, type CredentialStore } from '../../../src/control/credentials/credential-store.js';
import type { CredentialChangeCheck } from '../../../src/control/job/audit-job-manager.js';
import { readRecentCredentialEvents, recordAutoLoginResult } from '../../../src/control/job/auto-login-store.js';
import { createStartingJob, hasActiveJobForProfile, recordEnded } from '../../../src/control/job/job-store.js';
import type { ProfileValidationContext } from '../../../src/control/profile-policy.js';
import { saveAuthSetup } from '../../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../../src/control/store/database-path.js';
import { createProfile, getProfile, retireProfile } from '../../../src/control/store/profile-store.js';
import { formatCompactUtcTimestamp } from '../../../src/core/utc-timestamp.js';
import { createTestConfig } from '../../../tests/helpers/test-config.js';
import { createTestCredentialStore, type TestCredentialStore } from '../../../tests/helpers/test-credential-store.js';
import {
  RETIRED_CREDENTIAL_CLEANUPS,
  changeCredential,
  credentialPageOf,
  registerCredential,
  removeCredential,
  removeCredentialOfRetiredProfile,
  type CredentialServiceDependencies,
} from '../src/server/credential-service';

const TEST_ORIGIN = 'https://app.example.invalid';
const AUTO_PROFILE = 't26g2-auto';
const MANUAL_PROFILE = 't26g2-manual';
const TARGET_PATH = 'config/targets/t26g2.json';
const FIRST_REVISION = 1;
const NOW = new Date(Date.UTC(2026, 9, 11, 9, 0, 0));
/** 実行ごとの目印（値を出力しない。比べるときは `includes` の真偽だけを見る）。 */
const RUN = `${process.pid}-${Date.now()}`;
const USER = `t26g2-user-${RUN}`;
const PASS = `t26g2-pass-${RUN}`;
const MARKERS = Object.freeze([USER, PASS]);

const context: ProfileValidationContext = {
  targetConfig: { ...createTestConfig(TEST_ORIGIN), site: { startUrl: `${TEST_ORIGIN}/`, allowedOrigins: [TEST_ORIGIN] } },
};
const resolveContext = (path: string): ProfileValidationContext | undefined => (path === TARGET_PATH ? context : undefined);

const profileOf = (profileId: string, auth: SiteProfile['auth']): SiteProfile => ({
  schemaVersion: SITE_PROFILE_SCHEMA_VERSION,
  profileId,
  revision: FIRST_REVISION,
  targetConfigPath: TARGET_PATH,
  environment: 'TEST',
  mode: 'TEST_AUTH_PASSIVE',
  auth,
  approvedTestOrigins: [TEST_ORIGIN],
  environmentEvidenceRef: 'evidence/t26g2',
});

const automatedSetup: AuthSetup = {
  schemaVersion: AUTH_SETUP_SCHEMA_VERSION_2,
  profileId: AUTO_PROFILE,
  profileRevision: FIRST_REVISION,
  loginStartUrl: `${TEST_ORIGIN}/login`,
  loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/login' }],
  successCondition: { pathPrefix: '/home', selector: '#home' },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: ['/logout'],
  auditPathPrefixes: ['/home'],
  maxLoginAttempts: AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
  allowedIdpOrigins: [],
  automatedLogin: {
    usernameSelector: '#user',
    passwordSelector: '#pass',
    submitSelector: '#go',
    failureConditions: { invalidCredentials: { pathPrefix: '/login-error', selector: null }, accountLocked: null, mfaRequired: null, credentialExpired: null },
  },
};

let root = '';
let database: ControlDatabase;
let credentials: TestCredentialStore;
const responses: unknown[] = [];

const deps = (store: CredentialStore = credentials.store): CredentialServiceDependencies => ({
  database,
  store,
  checkCredentialChange: (profileId): CredentialChangeCheck =>
    hasActiveJobForProfile(database, profileId) ? { ok: false, reason: 'CREDENTIAL_IN_USE' } : { ok: true },
  platformSupported: () => true,
  environment: async () => 'AVAILABLE',
  now: () => NOW,
});

const kept = async <T>(promise: Promise<T>): Promise<T> => {
  const value = await promise;
  responses.push(value);
  return value;
};

const credentialPath = (): string => credentialFilePathFor(credentials.store.directory, AUTO_PROFILE);
const eventKinds = (profileId = AUTO_PROFILE): readonly string[] =>
  readRecentCredentialEvents(database, profileId).map((event) => event.kind).reverse();

const registerAndRetire = async (): Promise<void> => {
  expect(await kept(registerCredential(deps(), { profileId: AUTO_PROFILE, username: USER, password: PASS, passwordConfirmation: PASS })))
    .toMatchObject({ ok: true });
  expect(retireProfile(database, { profileId: AUTO_PROFILE, expectedRevision: FIRST_REVISION }).ok).toBe(true);
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'beaksight-t26g2-retire-'));
  database = openControlDatabase(resolveControlDatabasePath(root));
  credentials = await createTestCredentialStore();
  responses.length = 0;
  expect(createProfile(database, profileOf(AUTO_PROFILE, 'AUTOMATED_LOGIN'), { resolveContext }).ok).toBe(true);
  expect(createProfile(database, profileOf(MANUAL_PROFILE, 'MANUAL_SESSION'), { resolveContext }).ok).toBe(true);
  expect(saveAuthSetup(database, automatedSetup, { resolveContext })).toMatchObject({ ok: true });
});

afterEach(async () => {
  const serialized = JSON.stringify(responses);
  expect(MARKERS.filter((marker) => serialized.includes(marker)).length).toBe(0);
  closeControlDatabase(database);
  const dataDirectory = join(root, 'local-data');
  for (const name of existsSync(dataDirectory) ? readdirSync(dataDirectory) : []) {
    const bytes = readFileSync(join(dataDirectory, name));
    expect(MARKERS.filter((marker) => bytes.includes(Buffer.from(marker, 'utf8'))).length, name).toBe(0);
  }
  await credentials.remove();
  await rm(root, { recursive: true, force: true });
});

describe('T26g-2 (I1): removing the credential of a retired profile', () => {
  it('fixes the closed list of the outcomes', () => {
    expect(RETIRED_CREDENTIAL_CLEANUPS).toEqual(['REMOVED', 'NONE', 'FAILED']);
    expect(Object.isFrozen(RETIRED_CREDENTIAL_CLEANUPS)).toBe(true);
  });

  it('removes the file of the retired profile and records DELETED with the last revision', async () => {
    await registerAndRetire();
    expect(existsSync(credentialPath())).toBe(true);
    expect(await kept(removeCredentialOfRetiredProfile(deps(), AUTO_PROFILE))).toBe('REMOVED');
    expect(existsSync(credentialPath())).toBe(false);
    expect(eventKinds()).toEqual(['CREATED', 'DELETED']);
    expect(readRecentCredentialEvents(database, AUTO_PROFILE)[0]).toMatchObject({ kind: 'DELETED', credentialRevision: 1 });
    expect(getProfile(database, AUTO_PROFILE)?.status).toBe('RETIRED');
  });

  it('does nothing when the retired profile has no file (no record)', async () => {
    expect(retireProfile(database, { profileId: AUTO_PROFILE, expectedRevision: FIRST_REVISION }).ok).toBe(true);
    expect(await kept(removeCredentialOfRetiredProfile(deps(), AUTO_PROFILE))).toBe('NONE');
    expect(eventKinds()).toEqual([]);
  });

  it('does nothing for a profile that is not retired (the retirement failed or did not happen)', async () => {
    expect(await kept(registerCredential(deps(), { profileId: AUTO_PROFILE, username: USER, password: PASS, passwordConfirmation: PASS })))
      .toMatchObject({ ok: true });
    expect(await kept(removeCredentialOfRetiredProfile(deps(), AUTO_PROFILE))).toBe('NONE');
    expect(existsSync(credentialPath())).toBe(true);
    expect(eventKinds()).toEqual(['CREATED']);
    expect(await kept(removeCredentialOfRetiredProfile(deps(), 'not-there'))).toBe('NONE');
  });

  it('does nothing for a manual login profile', async () => {
    expect(retireProfile(database, { profileId: MANUAL_PROFILE, expectedRevision: FIRST_REVISION }).ok).toBe(true);
    expect(await kept(removeCredentialOfRetiredProfile(deps(), MANUAL_PROFILE))).toBe('NONE');
    expect(eventKinds(MANUAL_PROFILE)).toEqual([]);
  });

  it('reports FAILED when the removal fails, keeping the retirement and recording nothing', async () => {
    await registerAndRetire();
    const failing: CredentialStore = {
      ...credentials.store,
      remove: async () => {
        throw new CredentialStoreError('CREDENTIAL_DELETE_FAILED');
      },
    };
    expect(await kept(removeCredentialOfRetiredProfile(deps(failing), AUTO_PROFILE))).toBe('FAILED');
    expect(existsSync(credentialPath())).toBe(true);
    expect(eventKinds()).toEqual(['CREATED']);
    expect(getProfile(database, AUTO_PROFILE)?.status).toBe('RETIRED');
  });

  it('removes a credential file left for a profile that is no longer an automated login profile, when it is retired', async () => {
    expect(await credentials.store.register({ profileId: MANUAL_PROFILE, loginOrigin: TEST_ORIGIN, username: USER, password: PASS }))
      .toMatchObject({ credentialRevision: 1 });
    expect(retireProfile(database, { profileId: MANUAL_PROFILE, expectedRevision: FIRST_REVISION }).ok).toBe(true);
    expect(await kept(removeCredentialOfRetiredProfile(deps(), MANUAL_PROFILE))).toBe('REMOVED');
    expect(existsSync(credentialFilePathFor(credentials.store.directory, MANUAL_PROFILE))).toBe(false);
    expect(eventKinds(MANUAL_PROFILE)).toEqual(['DELETED']);
  });

  it('reports FAILED while a job of the profile runs (the current rule of the retirement is unchanged)', async () => {
    expect(await kept(registerCredential(deps(), { profileId: AUTO_PROFILE, username: USER, password: PASS, passwordConfirmation: PASS })))
      .toMatchObject({ ok: true });
    expect(createStartingJob(database, {
      jobId: 'job-running',
      jobKind: 'LOGIN_CHECK',
      profileId: AUTO_PROFILE,
      profileRevision: FIRST_REVISION,
      startNew: false,
      createdAt: '20261011085900',
      autoLoginAttempt: { credentialRevision: 1 },
    }, () => null)).toEqual({ ok: true });
    expect(retireProfile(database, { profileId: AUTO_PROFILE, expectedRevision: FIRST_REVISION }).ok).toBe(true);
    expect(await kept(removeCredentialOfRetiredProfile(deps(), AUTO_PROFILE))).toBe('FAILED');
    expect(existsSync(credentialPath())).toBe(true);
    expect(eventKinds()).toEqual(['CREATED']);
  });
});

// T26g-2 round 1（設計者の判断 (3)）: 削除は、資格（自動ログインのプロファイルか）で拒まない。ファイルが残っていれば消せる。資格で拒むのは、
// 登録・変更・入れ直しだけ。ジョブが動いている間の拒否（`CREDENTIAL_IN_USE`）とリンクの確かめは、そのまま。
describe('T26g-2 round 1: removing a credential does not depend on the eligibility', () => {
  const leaveCredentialForManualProfile = async (): Promise<void> => {
    expect(await credentials.store.register({ profileId: MANUAL_PROFILE, loginOrigin: TEST_ORIGIN, username: USER, password: PASS }))
      .toMatchObject({ credentialRevision: 1 });
  };

  it('shows the credential left for a manual login profile on the credential page (not eligible, removal only)', async () => {
    await leaveCredentialForManualProfile();
    expect(await kept(credentialPageOf(deps(), MANUAL_PROFILE))).toMatchObject({
      eligible: false,
      credential: { loginOrigin: TEST_ORIGIN, credentialRevision: 1, lastChangeKind: 'CREATED' },
      readError: null,
      currentLoginOrigin: null,
      hold: null,
      inUse: false,
    });
  });

  it('removes the credential left for a manual login profile and records DELETED, while saving stays refused', async () => {
    await leaveCredentialForManualProfile();
    expect(await kept(registerCredential(deps(), { profileId: MANUAL_PROFILE, username: USER, password: PASS, passwordConfirmation: PASS })))
      .toEqual({ ok: false, reason: 'CREDENTIAL_NOT_ELIGIBLE', field: null });
    expect(await kept(removeCredential(deps(), MANUAL_PROFILE))).toEqual({ ok: true, credential: null, holdCleared: false });
    expect(existsSync(credentialFilePathFor(credentials.store.directory, MANUAL_PROFILE))).toBe(false);
    expect(eventKinds(MANUAL_PROFILE)).toEqual(['DELETED']);
    expect(await kept(removeCredential(deps(), MANUAL_PROFILE))).toEqual({ ok: false, reason: 'CREDENTIAL_MISSING', field: null });
  });

  it('still refuses the removal while a job of the profile runs, and for a missing profile', async () => {
    await leaveCredentialForManualProfile();
    const inUse: CredentialServiceDependencies = { ...deps(), checkCredentialChange: () => ({ ok: false, reason: 'CREDENTIAL_IN_USE' }) };
    expect(await kept(removeCredential(inUse, MANUAL_PROFILE))).toEqual({ ok: false, reason: 'CREDENTIAL_IN_USE', field: null });
    expect(existsSync(credentialFilePathFor(credentials.store.directory, MANUAL_PROFILE))).toBe(true);
    expect(await kept(removeCredential(deps(), 'not-there'))).toEqual({ ok: false, reason: 'PROFILE_NOT_FOUND', field: null });
  });
});

// DEF-078: 資格情報の変更の記録（`credential_events`）と、停止の解除の時刻は、すべて画面のサーバの依存の時計（`deps.now`）から取る。資格情報の
// ファイルの部品の時計（ファイルの `updatedAt`）と混ぜると、時計がずれたとき（テストの固定の時刻と実際の時刻など）に、記録の順が逆になる。
// 依存の時計を、ファイルの部品の時計（実際の時刻）から遠い時刻に固定して、どの記録もその時刻であることを、時刻によらず決まって確かめる。
describe('DEF-078: every credential event and the hold clearing take their time from the dependency clock', () => {
  const FIRST = new Date(Date.UTC(2030, 0, 1, 0, 0, 0));
  const MINUTE_MS = 60_000;
  const stamp = (date: Date): string => formatCompactUtcTimestamp(date, 'test time');

  it('records CREATED, the changes, HOLD_CLEARED and DELETED at the dependency clock, in the order they happened', async () => {
    let now = FIRST;
    const clocked = (): CredentialServiceDependencies => ({ ...deps(), now: () => now });
    const at = (minutes: number): Date => new Date(FIRST.getTime() + minutes * MINUTE_MS);

    expect(await kept(registerCredential(clocked(), { profileId: AUTO_PROFILE, username: USER, password: PASS, passwordConfirmation: PASS })))
      .toMatchObject({ ok: true });
    now = at(1);
    expect(await kept(changeCredential(clocked(), {
      profileId: AUTO_PROFILE, username: null, password: PASS, passwordConfirmation: PASS, clearHold: false,
    }))).toMatchObject({ ok: true });
    // 止めた状態を作り（ジョブの管理の記録）、変更と一緒に解く。
    expect(createStartingJob(database, {
      jobId: 'job-def078', jobKind: 'LOGIN_CHECK', profileId: AUTO_PROFILE, profileRevision: FIRST_REVISION, startNew: false,
      createdAt: stamp(at(2)), autoLoginAttempt: { credentialRevision: 2 },
    }, () => null)).toEqual({ ok: true });
    recordAutoLoginResult(database, { jobId: 'job-def078', result: 'INVALID_CREDENTIALS', submitted: 'YES', retryAfterUntil: null, at: stamp(at(2)) });
    recordEnded(database, 'job-def078', { state: 'FAILED', reason: 'INVALID_CREDENTIALS', exitCode: null, at: stamp(at(2)) });
    now = at(3);
    expect(await kept(changeCredential(clocked(), {
      profileId: AUTO_PROFILE, username: USER, password: null, passwordConfirmation: null, clearHold: true,
    }))).toMatchObject({ ok: true, holdCleared: true });
    now = at(4);
    expect(await kept(removeCredential(clocked(), AUTO_PROFILE))).toMatchObject({ ok: true });

    const events = [...readRecentCredentialEvents(database, AUTO_PROFILE)].reverse();
    expect(events.map((event) => [event.kind, event.recordedAt])).toEqual([
      ['CREATED', stamp(FIRST)],
      ['PASSWORD_CHANGED', stamp(at(1))],
      ['USERNAME_CHANGED', stamp(at(3))],
      ['HOLD_CLEARED', stamp(at(3))],
      ['DELETED', stamp(at(4))],
    ]);
  });
});
