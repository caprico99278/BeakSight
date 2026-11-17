/**
 * MI-F3 項目 6（ユーザーの指示 2026-10-26「フォームやボタンは増やさない。基本的に自動化を厳守する」。設計書
 * `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.7.1 の終わりの段落）: 使えないプロファイル（取り消していない、認証の方式が自動ログインで、
 * 認証の設定がない。MI より前に作られた形）を、画面のサーバの起動のときに 1 回だけ自動で取り消す処理
 * （`src/server/unusable-profile-retirement.ts` の `retireUnusableProfiles`）を、管理データ（一時のフォルダ）で確かめる: 対象だけを今の取り消しの保存の部品で
 * 取り消し、残った資格情報の片付けを呼ぶ。設定のある自動ログインのプロファイル、手動のプロファイル、動いているジョブのあるプロファイルは取り消さない。2 回目は
 * 何もしない。判定は `src/control/unusable-profile.ts` の 1 か所。
 * SLIM-GROUP UI-1: 画面のサーバを起こす `unusable-profile-retirement.test.ts` から、同じ process の場面だけを速い組へ移した（起動の部品がこの処理を呼ぶ場面は、
 * MI より前の形のプロファイルが開発の PC にしかない名残なので消した）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../../../tests/helpers/auth-setup-samples.js';
import { AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS, type AuthSetup } from '../../../src/control/auth/auth-setup-contracts.js';
import { MIN_PROFILE_REVISION, type SiteProfile } from '../../../src/control/contracts.js';
import { saveAuthSetup } from '../../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../../src/control/store/database-path.js';
import { createProfile, getProfile } from '../../../src/control/store/profile-store.js';
import { LOCAL_UI_UNUSABLE_PROFILE_TEXT } from '../../../src/presentation/messages.js';
import {
  TEST_ORIGIN,
  TEST_TARGET_PATH,
  resolveTestContext,
  testAuthProfile,
} from '../../../tests/integration/control-profile-fixtures.js';
import { retireUnusableProfiles, unusableProfileRetirementLinesOf } from '../src/server/unusable-profile-retirement';

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
