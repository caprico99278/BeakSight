/**
 * MI-5（設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 3 章の判断 1、4.5、6 章の受け入れ条件 5）: 「書き込みにも使う」の画面のサーバの処理
 * （`src/server/write-mode-switch.ts`）を、管理データ（一時のフォルダ）で確かめる。
 * - 案: 認証つきの読み取りの監査で、認証の設定がある有効なプロファイルだけ。今と次の改訂、隔離が未確認か（`isolation-unverified-` で始まる参照）と参照、
 *   承認が外れるシナリオの数（FM2e と同じ部品の口）。公開・書き込みのモード・取り消し・認証の設定なしは `null`。
 * - 保存: 同じプロファイルが、モードだけを書き込みのモードにした次の改訂になる。認証の設定は中身を変えずに次の改訂に結びつけ直す（`CURRENT` のまま）。
 *   承認したサービスの Origin・設定のファイル・環境の証跡の参照・認証の方式は変わらない（手動のログインと自動ログインの両方）。
 * - 拒む: プロファイルがない、対象でない（公開、すでに書き込みのモード、取り消し）、改訂の衝突、認証の設定がない・古い、対象の設定を読めない。拒んだら何も
 *   書かない。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../../../tests/helpers/auth-setup-samples.js';
import { AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS, type AuthSetup } from '../../../src/control/auth/auth-setup-contracts.js';
import { MIN_PROFILE_REVISION, type SiteProfile } from '../../../src/control/contracts.js';
import { getAuthSetup, saveAuthSetup } from '../../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../../src/control/store/database-path.js';
import { createProfile, getProfile, retireProfile, updateProfile } from '../../../src/control/store/profile-store.js';
import {
  TEST_ORIGIN,
  TEST_TARGET_PATH,
  publicProfile,
  resolveTestContext,
  testAuthProfile,
  testWriteProfile,
} from '../../../tests/integration/control-profile-fixtures.js';
import { ISOLATION_UNVERIFIED_EVIDENCE_REF_PREFIX, isIsolationUnverifiedEvidenceRef, isolationUnverifiedEvidenceRefOf } from '../src/server/isolation-evidence-ref';
import { AUTOMATED_LOGIN_SETUP_REJECTION_REASONS } from '../src/server/credential-service';
import { PROFILE_AND_AUTH_SETUP_SAVE_REJECTION_REASONS, reasonOfProfileAndAuthSetupSaveRejection } from '../src/server/profile-auth-setup-save-rejection';
import {
  WRITE_MODE_SWITCH_REJECTION_REASONS,
  switchToWriteMode,
  writeModeSwitchProposalOf,
  type WriteModeSwitchDependencies,
} from '../src/server/write-mode-switch';

const PROFILE_ID = 'mi5-manual';
const AUTOMATED_PROFILE_ID = 'mi5-automated';
const NOW = new Date(Date.UTC(2026, 9, 26, 9, 0, 0));
const APPROVED_SCENARIOS = 3;
const SERVICE_ORIGIN = 'https://service.example.invalid';
const TARGET_CONFIG_TEXT = JSON.stringify({ target: { id: 'example-test' } });
const UNVERIFIED_REF = `${ISOLATION_UNVERIFIED_EVIDENCE_REF_PREFIX}20261026`;

/** 手動のログインの認証の設定。 */
const setupOf = (profileId: string, automated: boolean): AuthSetup => ({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId,
  profileRevision: MIN_PROFILE_REVISION,
  loginStartUrl: `${TEST_ORIGIN}/admin/login`,
  loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/admin/login' }],
  successCondition: { pathPrefix: '/admin/dashboard', selector: '#account-menu' },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: ['/admin/logout'],
  auditPathPrefixes: ['/admin/'],
  maxLoginAttempts: automated ? AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS : 2,
  allowedIdpOrigins: [],
  automatedLogin: automated
    ? {
      usernameSelector: '#email',
      passwordSelector: '#password',
      submitSelector: '#login',
      failureConditions: { invalidCredentials: { pathPrefix: '/admin/login', selector: '#error' }, accountLocked: null, mfaRequired: null, credentialExpired: null },
    }
    : null,
});

/** 承認したサービスの Origin を持つ、認証つきの読み取りの監査のプロファイル。 */
const passiveProfileOf = (profileId: string, overrides: Partial<SiteProfile> = {}): SiteProfile => ({
  ...testAuthProfile(profileId, MIN_PROFILE_REVISION),
  approvedServiceOrigins: [SERVICE_ORIGIN],
  ...overrides,
});

let root = '';
let database: ControlDatabase;
const countedProfiles: string[] = [];

const deps = (): WriteModeSwitchDependencies => ({
  database,
  now: () => NOW,
  approvedScenarioCount: async (stored) => {
    countedProfiles.push(stored.profile.profileId);
    return APPROVED_SCENARIOS;
  },
});

const create = (profile: SiteProfile, setup: AuthSetup | null): void => {
  expect(createProfile(database, profile, { resolveContext: resolveTestContext }).ok).toBe(true);
  if (setup !== null) {
    expect(saveAuthSetup(database, setup, { resolveContext: resolveTestContext }).ok).toBe(true);
  }
};

const switchOf = (profileId: string, expectedRevision = MIN_PROFILE_REVISION, isolationEvidenceRef?: string) =>
  switchToWriteMode(deps(), { profileId, expectedRevision, ...(isolationEvidenceRef === undefined ? {} : { isolationEvidenceRef }) },
    { resolveContext: resolveTestContext });

/** 前の状態（今の改訂、認証つきの読み取りの監査、認証の設定は `CURRENT` のまま）が残っているか。 */
const expectUnchanged = (profileId: string, revision = MIN_PROFILE_REVISION): void => {
  const stored = getProfile(database, profileId);
  expect(stored?.profile.revision).toBe(revision);
  expect(stored?.profile.mode).toBe('TEST_AUTH_PASSIVE');
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'beaksight-mi5-write-mode-'));
  mkdirSync(dirname(join(root, TEST_TARGET_PATH)), { recursive: true });
  writeFileSync(join(root, TEST_TARGET_PATH), TARGET_CONFIG_TEXT, 'utf8');
  database = openControlDatabase(resolveControlDatabasePath(root));
  countedProfiles.length = 0;
});

afterEach(async () => {
  closeControlDatabase(database);
  await rm(root, { recursive: true, force: true });
});

describe('MI-5: the isolation reference that shows the isolation is not verified yet', () => {
  it('is a reference that starts with isolation-unverified-', () => {
    expect(ISOLATION_UNVERIFIED_EVIDENCE_REF_PREFIX).toBe('isolation-unverified-');
    expect(isIsolationUnverifiedEvidenceRef(UNVERIFIED_REF)).toBe(true);
    expect(isIsolationUnverifiedEvidenceRef('evidence/example-test-env/isolation-check-1')).toBe(false);
    expect(isIsolationUnverifiedEvidenceRef('x-isolation-unverified-20261026')).toBe(false);
    expect(isIsolationUnverifiedEvidenceRef(null)).toBe(false);
  });
});

describe('MI-5: the proposal of "use for writes too" (the values of the confirmation dialog)', () => {
  it('gives the revisions, the isolation reference and the approvals to lose for an authenticated passive profile with an auth setup', async () => {
    create(passiveProfileOf(PROFILE_ID), setupOf(PROFILE_ID, false));
    expect(await writeModeSwitchProposalOf(deps(), PROFILE_ID)).toEqual({
      profileRevision: MIN_PROFILE_REVISION,
      nextProfileRevision: MIN_PROFILE_REVISION + 1,
      authSetupCurrent: true,
      environmentEvidenceRef: 'evidence/example-test-env/isolation-check-1',
      isolationUnverified: false,
      approvedScenarioCount: APPROVED_SCENARIOS,
    });
    expect(countedProfiles).toEqual([PROFILE_ID]);
  });

  it('shows that the isolation is not verified yet, for an isolation-unverified- reference', async () => {
    create(passiveProfileOf(PROFILE_ID, { environmentEvidenceRef: UNVERIFIED_REF }), setupOf(PROFILE_ID, false));
    expect(await writeModeSwitchProposalOf(deps(), PROFILE_ID)).toMatchObject({ environmentEvidenceRef: UNVERIFIED_REF, isolationUnverified: true });
  });

  it('says the auth setup is not current when the profile revision moved after the setup was saved', async () => {
    create(passiveProfileOf(PROFILE_ID), setupOf(PROFILE_ID, false));
    const stored = getProfile(database, PROFILE_ID);
    if (stored === null) throw new Error('no profile');
    expect(updateProfile(database, { profile: { ...stored.profile, revision: MIN_PROFILE_REVISION + 1 }, expectedRevision: MIN_PROFILE_REVISION },
      { resolveContext: resolveTestContext }).ok).toBe(true);
    expect(await writeModeSwitchProposalOf(deps(), PROFILE_ID)).toMatchObject({ authSetupCurrent: false, profileRevision: MIN_PROFILE_REVISION + 1 });
  });

  it('is null for a public profile, a write mode profile, a retired profile, a profile without an auth setup and an unknown profile', async () => {
    create(publicProfile('mi5-public', MIN_PROFILE_REVISION), null);
    create(testWriteProfile('mi5-write', MIN_PROFILE_REVISION), setupOf('mi5-write', false));
    create(passiveProfileOf('mi5-retired'), setupOf('mi5-retired', false));
    expect(retireProfile(database, { profileId: 'mi5-retired', expectedRevision: MIN_PROFILE_REVISION }).ok).toBe(true);
    create(passiveProfileOf('mi5-no-setup'), null);
    for (const profileId of ['mi5-public', 'mi5-write', 'mi5-retired', 'mi5-no-setup', 'not-there']) {
      expect(await writeModeSwitchProposalOf(deps(), profileId), profileId).toBeNull();
    }
    expect(countedProfiles).toEqual([]);
  });
});

describe('MI-5: saving "use for writes too"', () => {
  it.each([
    ['the manual login', PROFILE_ID, false],
    ['the automated login', AUTOMATED_PROFILE_ID, true],
  ] as const)('makes the next revision of the same profile in the write mode, and keeps everything else (%s)', (_case, profileId, automated) => {
    const before = passiveProfileOf(profileId, automated ? { auth: 'AUTOMATED_LOGIN' } : {});
    const setup = setupOf(profileId, automated);
    create(before, setup);

    expect(switchOf(profileId)).toEqual({ ok: true, profileRevision: MIN_PROFILE_REVISION + 1 });
    const after = getProfile(database, profileId);
    // モードと改訂が変わる（認証の方式・承認したサービスの Origin・設定のファイル・許可 Origin は同じ）。PL-5（設計書
    // `2026-10-26-beaksight-plain-ui-design.md` 6 章の 6）: 隔離の扱いは確認のダイアログの 2 択で、既定（参照を送らない）は「まだ確かめていない」。確定の日の
    // 未確認の参照で、前の参照を置き換える。
    expect(after?.profile).toEqual({
      ...before, revision: MIN_PROFILE_REVISION + 1, mode: 'TEST_APPROVED_WRITE', environmentEvidenceRef: isolationUnverifiedEvidenceRefOf(NOW),
    });
    expect(after?.status).toBe('ACTIVE');
    // 認証の設定は中身を変えずに、次の改訂に結びつけ直す（古いにならない）。
    const savedSetup = getAuthSetup(database, profileId);
    expect(savedSetup?.freshness).toBe('CURRENT');
    expect(savedSetup?.setup).toEqual({ ...setup, profileRevision: MIN_PROFILE_REVISION + 1 });
    // 書き込みのモードになったので、もう一度は出さない。
    expect(switchOf(profileId, MIN_PROFILE_REVISION + 1)).toEqual({ ok: false, reason: 'NOT_OFFERED', authSetupErrors: [] });
  });

  // PL-5（設計書 6 章の 6）: 「確かめた記録がある」を選ぶと、入れた参照（前後の空白を除く）を保存する。
  it('saves the reference of the isolation record that the dialog sent, in place of the reference of the creation', () => {
    create(passiveProfileOf(PROFILE_ID, { environmentEvidenceRef: UNVERIFIED_REF }), setupOf(PROFILE_ID, false));
    expect(switchOf(PROFILE_ID, MIN_PROFILE_REVISION, '  isolation-check-2026-10-27  ')).toEqual({ ok: true, profileRevision: MIN_PROFILE_REVISION + 1 });
    expect(getProfile(database, PROFILE_ID)?.profile.environmentEvidenceRef).toBe('isolation-check-2026-10-27');
    expect(isIsolationUnverifiedEvidenceRef(getProfile(database, PROFILE_ID)?.profile.environmentEvidenceRef ?? null)).toBe(false);
  });

  it('rejects a blank reference of the isolation record, and writes nothing', () => {
    create(passiveProfileOf(PROFILE_ID, { environmentEvidenceRef: UNVERIFIED_REF }), setupOf(PROFILE_ID, false));
    expect(switchOf(PROFILE_ID, MIN_PROFILE_REVISION, '   ')).toEqual({ ok: false, reason: 'ISOLATION_REFERENCE_INVALID', authSetupErrors: [] });
    expectUnchanged(PROFILE_ID);
    expect(getProfile(database, PROFILE_ID)?.profile.environmentEvidenceRef).toBe(UNVERIFIED_REF);
  });

  // PL-F 修正の 1 回目（PL-REV の Minor 2）: 秘密に見える参照は、保存の前に拒み、何も書かない。
  it.each([
    ['a secret-like name and its value', 'password=hunter2'],
    ['a Bearer scheme and its value', 'Bearer abcdefghijklmnopqrstuvwxyz0123456789'],
    ['a URL with userinfo', 'https://user:pass@example.invalid/x'],
  ])('rejects a secret-like reference of the isolation record (%s), and writes nothing', (_name, reference) => {
    create(passiveProfileOf(PROFILE_ID, { environmentEvidenceRef: UNVERIFIED_REF }), setupOf(PROFILE_ID, false));
    expect(switchOf(PROFILE_ID, MIN_PROFILE_REVISION, reference)).toEqual({ ok: false, reason: 'ISOLATION_REFERENCE_SECRET_LIKE', authSetupErrors: [] });
    expectUnchanged(PROFILE_ID);
    expect(getProfile(database, PROFILE_ID)?.profile.environmentEvidenceRef).toBe(UNVERIFIED_REF);
    expect(getAuthSetup(database, PROFILE_ID)?.setup).toEqual(setupOf(PROFILE_ID, false));
  });

  it('rejects a profile that is not offered (public, already in the write mode, retired) or not found, and writes nothing', () => {
    create(publicProfile('mi5-public', MIN_PROFILE_REVISION), null);
    create(testWriteProfile('mi5-write', MIN_PROFILE_REVISION), setupOf('mi5-write', false));
    create(passiveProfileOf('mi5-retired'), setupOf('mi5-retired', false));
    expect(retireProfile(database, { profileId: 'mi5-retired', expectedRevision: MIN_PROFILE_REVISION }).ok).toBe(true);
    expect(switchOf('not-there')).toEqual({ ok: false, reason: 'PROFILE_NOT_FOUND', authSetupErrors: [] });
    expect(switchOf('mi5-public')).toEqual({ ok: false, reason: 'NOT_OFFERED', authSetupErrors: [] });
    expect(switchOf('mi5-write')).toEqual({ ok: false, reason: 'NOT_OFFERED', authSetupErrors: [] });
    expect(switchOf('mi5-retired', MIN_PROFILE_REVISION + 1)).toEqual({ ok: false, reason: 'NOT_OFFERED', authSetupErrors: [] });
    expect(getProfile(database, 'mi5-public')?.profile.revision).toBe(MIN_PROFILE_REVISION);
    expect(getProfile(database, 'mi5-write')?.profile.revision).toBe(MIN_PROFILE_REVISION);
  });

  it('rejects a profile without an auth setup or with a stale one, and writes nothing', () => {
    create(passiveProfileOf('mi5-no-setup'), null);
    expect(switchOf('mi5-no-setup')).toEqual({ ok: false, reason: 'AUTH_SETUP_NOT_CURRENT', authSetupErrors: [] });
    expectUnchanged('mi5-no-setup');

    create(passiveProfileOf(PROFILE_ID), setupOf(PROFILE_ID, false));
    const stored = getProfile(database, PROFILE_ID);
    if (stored === null) throw new Error('no profile');
    expect(updateProfile(database, { profile: { ...stored.profile, revision: MIN_PROFILE_REVISION + 1 }, expectedRevision: MIN_PROFILE_REVISION },
      { resolveContext: resolveTestContext }).ok).toBe(true);
    expect(switchOf(PROFILE_ID, MIN_PROFILE_REVISION + 1)).toEqual({ ok: false, reason: 'AUTH_SETUP_NOT_CURRENT', authSetupErrors: [] });
    expectUnchanged(PROFILE_ID, MIN_PROFILE_REVISION + 1);
  });

  it('rejects the revision conflict and an unreadable target configuration, and writes nothing', () => {
    create(passiveProfileOf(PROFILE_ID), setupOf(PROFILE_ID, false));
    expect(switchOf(PROFILE_ID, MIN_PROFILE_REVISION + 1)).toEqual({ ok: false, reason: 'PROFILE_REVISION_CONFLICT', authSetupErrors: [] });
    expect(switchToWriteMode(deps(), { profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION }, { resolveContext: () => undefined }))
      .toEqual({ ok: false, reason: 'TARGET_CONFIG_UNAVAILABLE', authSetupErrors: [] });
    expectUnchanged(PROFILE_ID);
    expect(getAuthSetup(database, PROFILE_ID)?.setup).toEqual(setupOf(PROFILE_ID, false));
  });

  it('lists the closed reasons in a frozen list', () => {
    expect(Object.isFrozen(WRITE_MODE_SWITCH_REJECTION_REASONS)).toBe(true);
    expect(WRITE_MODE_SWITCH_REJECTION_REASONS).toEqual([
      'PROFILE_NOT_FOUND',
      'NOT_OFFERED',
      'PROFILE_REVISION_CONFLICT',
      'AUTH_SETUP_NOT_CURRENT',
      'TARGET_CONFIG_UNAVAILABLE',
      'ISOLATION_REFERENCE_INVALID',
      'ISOLATION_REFERENCE_SECRET_LIKE',
      'PROFILE_INVALID',
      'AUTH_SETUP_INVALID',
      'SAVE_FAILED',
    ]);
  });
});

// MI-C（CC-115）: 管理データの保存の部品（`saveProfileAndAuthSetup`）の拒否を操作の理由に写す変換は、1 つの部品（`profile-auth-setup-save-rejection.ts`）に
// まとめ、「書き込みにも使う」と「次から自動でログインする」（`credential-service.ts`）の両方が使う。
describe('MI-C (CC-115): the reason of a rejected save of the profile and the auth setup', () => {
  const rejected = (part: 'PROFILE' | 'AUTH_SETUP', reason: string): Parameters<typeof reasonOfProfileAndAuthSetupSaveRejection>[0] =>
    ({ ok: false, part, reason, detail: 'detail', errors: [] }) as unknown as Parameters<typeof reasonOfProfileAndAuthSetupSaveRejection>[0];

  it('gives the revision conflict, the unavailable target configuration, the auth setup or the profile', () => {
    expect(reasonOfProfileAndAuthSetupSaveRejection(rejected('PROFILE', 'PROFILE_REVISION_CONFLICT'))).toBe('PROFILE_REVISION_CONFLICT');
    expect(reasonOfProfileAndAuthSetupSaveRejection(rejected('AUTH_SETUP', 'TARGET_CONFIG_UNAVAILABLE'))).toBe('TARGET_CONFIG_UNAVAILABLE');
    expect(reasonOfProfileAndAuthSetupSaveRejection(rejected('PROFILE', 'TARGET_CONFIG_UNAVAILABLE'))).toBe('TARGET_CONFIG_UNAVAILABLE');
    expect(reasonOfProfileAndAuthSetupSaveRejection(rejected('AUTH_SETUP', 'AUTH_SETUP_INVALID'))).toBe('AUTH_SETUP_INVALID');
    expect(reasonOfProfileAndAuthSetupSaveRejection(rejected('PROFILE', 'PROFILE_INVALID'))).toBe('PROFILE_INVALID');
    expect(reasonOfProfileAndAuthSetupSaveRejection(rejected('PROFILE', 'PROFILE_NOT_FOUND'))).toBe('PROFILE_INVALID');
    expect(PROFILE_AND_AUTH_SETUP_SAVE_REJECTION_REASONS).toEqual(['PROFILE_REVISION_CONFLICT', 'TARGET_CONFIG_UNAVAILABLE', 'AUTH_SETUP_INVALID', 'PROFILE_INVALID']);
  });

  it('is the reason list that both rejection lists contain', () => {
    for (const reason of PROFILE_AND_AUTH_SETUP_SAVE_REJECTION_REASONS) {
      expect(WRITE_MODE_SWITCH_REJECTION_REASONS, reason).toContain(reason);
      expect(AUTOMATED_LOGIN_SETUP_REJECTION_REASONS, reason).toContain(reason);
    }
  });
});
