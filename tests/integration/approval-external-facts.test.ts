// T28R-fix-1（独立レビュー T28R の I-1、台帳の CC-080 (a)）: 承認の判定に渡す管理データの外の事実（`src/control/approval-external-facts.ts`）。
// - 認証の設定の digest は、保存した認証の設定と、自動ログインのプロファイルなら資格情報の事実（資格情報のファイルの版と、管理データの
//   `credential_events` の、そのプロファイルの資格情報の変更の最後の出来事の id）から求める。資格情報を削除して別の値で登録し直すと、版は 1 に
//   戻るが、出来事の id は増えるので、承認は `AUTH_SETUP_CHANGED` で再承認になる。
// - ターゲットの設定の digest は、プロファイルが指す設定のファイルの内容から求める。読めなければ null（fail-closed）。
// - 資格情報の値は読まない（メタデータだけ）。
// 一時のフォルダだけを使い、終わったら消す。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { approvalExternalFactsOf, type ApprovalExternalFactsDependencies } from '../../src/control/approval-external-facts.js';
import { approveScenario, readScenarioApprovalStatus } from '../../src/control/approval/scenario-store.js';
import { AUTH_SETUP_SCHEMA_VERSION_2, AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS, type AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import type { CredentialMetadata } from '../../src/control/credentials/credential-store.js';
import { discoveryIndexEntryOf, recordDiscoveryCandidates } from '../../src/control/job/discovery-index-store.js';
import { readLatestCredentialChangeEventId, recordCredentialEvent } from '../../src/control/job/auto-login-store.js';
import { saveAuthSetup } from '../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile, getProfile, type StoredProfile } from '../../src/control/store/profile-store.js';
import { discoveryReadPagePaths, mergeDiscoveryCandidates } from '../../src/discovery/discovery-result.js';
import { CREATE_CANDIDATE, UPDATE_CANDIDATE } from '../unit/approval-samples.js';
import { TEST_ORIGIN, TEST_TARGET_PATH, resolveTestContext, testWriteProfile } from './control-profile-fixtures.js';
import { DISCOVERED_AT, DISCOVERY_JOB_ID, GRANT_PROFILE_ID, discoveryDocumentOf, prepareScenario } from './execution-grant-fixtures.js';

const APPROVED_AT = '20261012020000';
const IN_TTL = new Date(Date.parse('2026-10-13T00:00:00Z'));

const AUTOMATED_SETUP: AuthSetup = Object.freeze({
  schemaVersion: AUTH_SETUP_SCHEMA_VERSION_2,
  profileId: GRANT_PROFILE_ID,
  profileRevision: MIN_PROFILE_REVISION,
  loginStartUrl: `${TEST_ORIGIN}/admin/login`,
  loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/admin/login' }],
  successCondition: { pathPrefix: '/admin/dashboard', selector: '#account-menu' },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: ['/admin/logout'],
  auditPathPrefixes: ['/admin/'],
  maxLoginAttempts: AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
  allowedIdpOrigins: [],
  automatedLogin: {
    usernameSelector: '#username',
    passwordSelector: '#password',
    submitSelector: '#login-submit',
    failureConditions: { invalidCredentials: { pathPrefix: '/admin/login', selector: '.login-error' }, accountLocked: null, mfaRequired: null, credentialExpired: null },
  },
});

let repositoryRoot = '';
let database: ControlDatabase;
/** 資格情報のファイルのメタデータ（偽物。値は持たない）。null は資格情報がない。 */
let credentialRevision: number | null = null;
let metadataReadable = true;

const deps = (): ApprovalExternalFactsDependencies => ({
  database,
  repositoryRoot,
  credentialStore: {
    readMetadata: async (profileId: string) => {
      if (!metadataReadable) {
        throw new Error('the metadata cannot be read');
      }
      return credentialRevision === null ? null : ({ profileId, credentialRevision } as unknown as CredentialMetadata);
    },
  },
});

const storedProfile = (): StoredProfile => {
  const stored = getProfile(database, GRANT_PROFILE_ID);
  if (stored === null) throw new Error('no profile');
  return stored;
};

beforeEach(() => {
  repositoryRoot = mkdtempSync(join(tmpdir(), 'beaksight-approval-facts-'));
  const targetPath = join(repositoryRoot, TEST_TARGET_PATH);
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, '{"example":"target"}');
  database = openControlDatabase(resolveControlDatabasePath(repositoryRoot));
  credentialRevision = null;
  metadataReadable = true;
  expect(createProfile(database, { ...testWriteProfile(GRANT_PROFILE_ID, MIN_PROFILE_REVISION), auth: 'AUTOMATED_LOGIN' }, { resolveContext: resolveTestContext }).ok)
    .toBe(true);
  expect(saveAuthSetup(database, AUTOMATED_SETUP, { resolveContext: resolveTestContext }).ok).toBe(true);
});

afterEach(() => {
  closeControlDatabase(database);
  rmSync(repositoryRoot, { recursive: true, force: true });
});

const recordEvent = (kind: 'CREATED' | 'DELETED', at: string, revision: number | null): void => {
  recordCredentialEvent(database, { profileId: GRANT_PROFILE_ID, kind, at, credentialRevision: revision });
};

describe('approval external facts (T28R-fix-1, I-1)', () => {
  it('reads the latest credential change event of a profile, without the hold clearances', () => {
    expect(readLatestCredentialChangeEventId(database, GRANT_PROFILE_ID)).toBeNull();
    recordEvent('CREATED', '20261012000100', 1);
    const created = readLatestCredentialChangeEventId(database, GRANT_PROFILE_ID);
    expect(created).toEqual(expect.any(Number));
    recordEvent('DELETED', '20261012000200', 1);
    expect(readLatestCredentialChangeEventId(database, GRANT_PROFILE_ID)).toBeGreaterThan(created ?? 0);
    expect(readLatestCredentialChangeEventId(database, 'other-profile')).toBeNull();
  });

  it('requires a new approval after the credential was deleted and registered again at revision 1', async () => {
    const candidates = [CREATE_CANDIDATE, UPDATE_CANDIDATE];
    const latest = discoveryDocumentOf(DISCOVERY_JOB_ID, candidates);
    recordDiscoveryCandidates(database, {
      profileId: GRANT_PROFILE_ID, jobId: DISCOVERY_JOB_ID, at: DISCOVERED_AT,
      entries: mergeDiscoveryCandidates(candidates).map(discoveryIndexEntryOf), readPagePaths: discoveryReadPagePaths(latest),
    });
    recordEvent('CREATED', '20261012000100', 1);
    credentialRevision = 1;
    // T30d: このテストはプロファイルの準備（照合の READ の定義を作る `prepareGrantProfile`）を通らないので、検証の指定を入れない（承認の確かめだけ）。
    const scenario = prepareScenario(database, latest, 'scenario-1', { approve: false, verification: null });
    const facts = await approvalExternalFactsOf(storedProfile(), deps());
    expect(facts).not.toBeNull();
    if (facts === null) return;
    const status = readScenarioApprovalStatus(database, 'scenario-1', facts, IN_TTL);
    expect(approveScenario(database, {
      scenarioId: 'scenario-1', expectedRevision: scenario.revision, expectedApprovalDigest: status?.approvalDigest ?? '', receiptId: 'receipt-1',
      external: facts, at: APPROVED_AT,
    }).ok).toBe(true);
    expect(readScenarioApprovalStatus(database, 'scenario-1', facts, IN_TTL)?.validity.approved).toBe(true);

    // 削除する（資格情報のファイルがなくなり、削除の出来事を記録する）。
    recordEvent('DELETED', '20261012030000', 1);
    credentialRevision = null;
    const deleted = await approvalExternalFactsOf(storedProfile(), deps());
    expect(deleted === null ? null : readScenarioApprovalStatus(database, 'scenario-1', deleted, IN_TTL)?.validity)
      .toEqual({ approved: false, reasons: ['AUTH_SETUP_CHANGED'] });

    // 別の値で登録し直す（版は 1 に戻る）。
    recordEvent('CREATED', '20261012040000', 1);
    credentialRevision = 1;
    const registered = await approvalExternalFactsOf(storedProfile(), deps());
    expect(registered?.authSetupDigest).not.toBe(facts.authSetupDigest);
    expect(registered === null ? null : readScenarioApprovalStatus(database, 'scenario-1', registered, IN_TTL)?.validity)
      .toEqual({ approved: false, reasons: ['AUTH_SETUP_CHANGED'] });
  });

  it('returns null when the target config or the credential metadata cannot be read (fail-closed)', async () => {
    metadataReadable = false;
    expect(await approvalExternalFactsOf(storedProfile(), deps())).toBeNull();
    metadataReadable = true;
    expect(await approvalExternalFactsOf(storedProfile(), deps())).not.toBeNull();
    rmSync(join(repositoryRoot, TEST_TARGET_PATH));
    expect(await approvalExternalFactsOf(storedProfile(), deps())).toBeNull();
  });
});
