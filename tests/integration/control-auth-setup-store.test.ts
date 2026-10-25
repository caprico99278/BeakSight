// 認証の設定の保存（管理データの `auth_setups`。Task 25 の設計書 4.1 の「保存」。T25a round 1）の結合テスト。
// - 表は `STRICT` で、CHECK と外部キーを持つ（LG-2 で、前の版の管理データからの上げの確かめは捨てた）。
// - 保存（`saveAuthSetup`）の前に、保存してあるプロファイルを今の文脈で検証し直し、`validateAuthSetup` を通す。通らなければ書かない。
// - 保存と読み（`getAuthSetup`）の往復。プロファイルの改訂が変わった設定は、読むときに `STALE` と分かる。
// - 一時のフォルダだけを使い、終わったら消す。表の中身の確かめと壊れた文書の再現は、テストの側から生の接続で行う。
// - LG-3b（2026-10-24 のテストの組の設計 3.7.2）: 保存も読み出しも版 3（`beaksight-auth-setup/3`）だけ。版 1・版 2 の文書の行は、読み替えずに
//   `DATABASE_INTEGRITY_FAILED` で止まる（T26b の「版 1 を版 2 として読む」は捨てた）。自動ログインのプロファイルの設定の往復。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AUTH_SETUP_SCHEMA_VERSION_3,
  AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
  type AuthSetup,
} from '../../src/control/auth/auth-setup-contracts.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import {
  AUTH_SETUP_FRESHNESS_VALUES,
  AUTH_SETUP_STORE_REJECTION_REASONS,
  getAuthSetup,
  saveAuthSetup,
  type AuthSetupStoreResult,
} from '../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile, retireProfile, updateProfile } from '../../src/control/store/profile-store.js';
import { ControlStoreError } from '../../src/control/store/store-errors.js';
import { formatCompactUtcTimestamp } from '../../src/core/utc-timestamp.js';
import { FORM_NAVIGATION_SETUP_ITEMS, previousVersionSetupDocumentOf } from '../helpers/auth-setup-samples.js';
import {
  TEST_ORIGIN,
  publicProfile,
  resolveDriftedContext,
  resolveTestContext,
  testAuthProfile,
} from './control-profile-fixtures.js';

const PROFILE_ID = 'example-auth';
const PUBLIC_PROFILE_ID = 'example-public';
const NEXT_REVISION = MIN_PROFILE_REVISION + 1;
const SAVED_AT = new Date(Date.UTC(2026, 9, 10, 1, 2, 3));
const RESAVED_AT = new Date(Date.UTC(2026, 9, 10, 4, 5, 6));
const LEGACY_CREATED_AT = '20261009000000';

const AUTOMATED_PROFILE_ID = 'example-automated';

const setupFor = (profileRevision: number, overrides: Partial<AuthSetup> = {}): AuthSetup => ({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: PROFILE_ID,
  profileRevision,
  loginStartUrl: `${TEST_ORIGIN}/admin/login`,
  loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/admin/login' }],
  successCondition: { pathPrefix: '/admin/dashboard', selector: null },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: ['/admin/logout'],
  auditPathPrefixes: ['/admin/'],
  maxLoginAttempts: 2,
  allowedIdpOrigins: [],
  automatedLogin: null,
  ...overrides,
});

/** 自動ログインのプロファイルの設定。 */
const automatedSetupFor = (profileRevision: number): AuthSetup => setupFor(profileRevision, {
  profileId: AUTOMATED_PROFILE_ID,
  maxLoginAttempts: AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
  automatedLogin: {
    usernameSelector: '#username',
    passwordSelector: '#password',
    submitSelector: '#login-submit',
    failureConditions: {
      invalidCredentials: { pathPrefix: '/admin/login', selector: '.login-error' },
      accountLocked: { pathPrefix: '/admin/locked', selector: null },
      mfaRequired: null,
      credentialExpired: null,
    },
  },
});

let workDirectory = '';
let database: ControlDatabase | undefined;

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-control-auth-setups-'));
});

afterEach(() => {
  if (database !== undefined) {
    closeControlDatabase(database);
    database = undefined;
  }
  rmSync(workDirectory, { recursive: true, force: true });
});

const databasePath = (): string => resolveControlDatabasePath(workDirectory);

/** 今の版のデータベースを開き、認証つきのプロファイル（改訂 1）と公開のプロファイルを作る。 */
const openPrepared = (): ControlDatabase => {
  const opened = openControlDatabase(databasePath());
  database = opened;
  expect(createProfile(opened, testAuthProfile(PROFILE_ID, MIN_PROFILE_REVISION), { resolveContext: resolveTestContext }).ok).toBe(true);
  expect(createProfile(opened, publicProfile(PUBLIC_PROFILE_ID, MIN_PROFILE_REVISION), { resolveContext: resolveTestContext }).ok)
    .toBe(true);
  return opened;
};

const save = (opened: ControlDatabase, input: unknown, at = SAVED_AT, resolveContext = resolveTestContext): AuthSetupStoreResult =>
  saveAuthSetup(opened, input, { resolveContext, now: () => at });

const rejectionOf = (result: AuthSetupStoreResult): Extract<AuthSetupStoreResult, { ok: false }> => {
  if (result.ok) {
    throw new Error('the auth setup store accepted the setup');
  }
  return result;
};

interface AuthSetupRow {
  readonly profile_id: string;
  readonly profile_revision: number;
  readonly document: string;
  readonly updated_at: string;
}

const rowsOf = (opened: ControlDatabase): readonly AuthSetupRow[] =>
  opened.connection.prepare('SELECT * FROM auth_setups ORDER BY profile_id').all() as unknown as AuthSetupRow[];

// LG-2: 版 1〜16 の段は捨てた（前の版からの上げの確かめも捨てた）。認証の設定の表の今の形だけを、今の版の管理データで確かめる。
describe('Control store: the auth_setups table', () => {
  it('is STRICT, and rejects rows that break the CHECKs or the foreign key', () => {
    const opened = openPrepared();
    const strict = opened.connection.prepare("SELECT strict FROM pragma_table_list WHERE schema = 'main' AND name = 'auth_setups'").get();
    expect(strict).toEqual({ strict: 1 });
    const insert = opened.connection.prepare(
      'INSERT INTO auth_setups (profile_id, profile_revision, document, updated_at) VALUES (?, ?, ?, ?)',
    );
    const document = JSON.stringify(setupFor(MIN_PROFILE_REVISION));
    expect(() => insert.run(PROFILE_ID, 0, document, LEGACY_CREATED_AT)).toThrow();
    expect(() => insert.run(PROFILE_ID, MIN_PROFILE_REVISION, '{not json', LEGACY_CREATED_AT)).toThrow();
    expect(() => insert.run(PROFILE_ID, MIN_PROFILE_REVISION, document, '2026-10-10')).toThrow();
    expect(() => insert.run(PROFILE_ID, 'one', document, LEGACY_CREATED_AT)).toThrow();
    expect(() => insert.run('unknown-profile', MIN_PROFILE_REVISION, document, LEGACY_CREATED_AT)).toThrow();
    expect(rowsOf(opened)).toEqual([]);
  });
});

describe('saveAuthSetup and getAuthSetup', () => {
  it('saves a valid setup and reads it back as a frozen CURRENT setup', () => {
    const opened = openPrepared();
    const setup = setupFor(MIN_PROFILE_REVISION);
    const saved = save(opened, setup);
    expect(saved).toEqual({
      ok: true,
      stored: { setup, updatedAt: formatCompactUtcTimestamp(SAVED_AT, 'test'), freshness: 'CURRENT', profileRevision: MIN_PROFILE_REVISION },
    });
    expect(Object.isFrozen(saved)).toBe(true);
    const read = getAuthSetup(opened, PROFILE_ID);
    expect(read).toEqual(saved.ok ? saved.stored : null);
    expect(Object.isFrozen(read?.setup.loginPostEndpoints)).toBe(true);
    expect(rowsOf(opened)).toEqual([{
      profile_id: PROFILE_ID,
      profile_revision: MIN_PROFILE_REVISION,
      document: JSON.stringify(setup),
      updated_at: formatCompactUtcTimestamp(SAVED_AT, 'test'),
    }]);
    expect(opened.connection.isTransaction).toBe(false);
  });

  it('replaces the setup of the same profile (one row per profile)', () => {
    const opened = openPrepared();
    expect(save(opened, setupFor(MIN_PROFILE_REVISION)).ok).toBe(true);
    const changed = setupFor(MIN_PROFILE_REVISION, { maxLoginAttempts: 1, excludedPaths: ['/admin/logout', '/admin/export'] });
    expect(save(opened, changed, RESAVED_AT).ok).toBe(true);
    expect(rowsOf(opened)).toHaveLength(1);
    expect(getAuthSetup(opened, PROFILE_ID)?.setup).toEqual(changed);
    expect(getAuthSetup(opened, PROFILE_ID)?.updatedAt).toBe(formatCompactUtcTimestamp(RESAVED_AT, 'test'));
  });

  it('returns null when the profile has no setup', () => {
    const opened = openPrepared();
    expect(getAuthSetup(opened, PROFILE_ID)).toBeNull();
    expect(getAuthSetup(opened, 'unknown-profile')).toBeNull();
  });

  it('reads the setup of an older profile revision as STALE, and rejects saving the old revision again', () => {
    const opened = openPrepared();
    expect(save(opened, setupFor(MIN_PROFILE_REVISION)).ok).toBe(true);
    expect(updateProfile(opened, { profile: testAuthProfile(PROFILE_ID, NEXT_REVISION), expectedRevision: MIN_PROFILE_REVISION }, {
      resolveContext: resolveTestContext,
    }).ok).toBe(true);
    const stale = getAuthSetup(opened, PROFILE_ID);
    expect(stale?.freshness).toBe('STALE');
    expect(stale?.profileRevision).toBe(NEXT_REVISION);
    expect(stale?.setup.profileRevision).toBe(MIN_PROFILE_REVISION);

    const rejection = rejectionOf(save(opened, setupFor(MIN_PROFILE_REVISION)));
    expect(rejection.reason).toBe('AUTH_SETUP_INVALID');
    expect(rejection.errors.map(({ code }) => code)).toEqual(['AUTH_SETUP_PROFILE_REVISION_MISMATCH']);

    expect(save(opened, setupFor(NEXT_REVISION)).ok).toBe(true);
    expect(getAuthSetup(opened, PROFILE_ID)?.freshness).toBe('CURRENT');
  });

  it('reads the setup of a retired profile as STALE, and rejects saving it with PROFILE_RETIRED', () => {
    const opened = openPrepared();
    expect(save(opened, setupFor(MIN_PROFILE_REVISION)).ok).toBe(true);
    expect(retireProfile(opened, { profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION }).ok).toBe(true);
    expect(getAuthSetup(opened, PROFILE_ID)?.freshness).toBe('STALE');
    expect(rejectionOf(save(opened, setupFor(NEXT_REVISION))).reason).toBe('PROFILE_RETIRED');
  });

  it.each([
    ['an unknown profile', () => setupFor(MIN_PROFILE_REVISION, { profileId: 'unknown-profile' }), resolveTestContext, 'PROFILE_NOT_FOUND'],
    ['a profile whose target configuration cannot be resolved', () => setupFor(MIN_PROFILE_REVISION), () => undefined, 'TARGET_CONFIG_UNAVAILABLE'],
    ['a profile that no longer passes with the current target configuration', () => setupFor(MIN_PROFILE_REVISION), resolveDriftedContext, 'PROFILE_INVALID'],
    ['an invalid setup', () => setupFor(MIN_PROFILE_REVISION, { excludedPaths: ['/a/../b'] }), resolveTestContext, 'AUTH_SETUP_INVALID'],
    ['a value that is not plain JSON', () => ({ profileId: PROFILE_ID, read: () => undefined }), resolveTestContext, 'AUTH_SETUP_INVALID'],
    ['a setup without a profileId', () => ({ ...setupFor(MIN_PROFILE_REVISION), profileId: 7 }), resolveTestContext, 'AUTH_SETUP_INVALID'],
  ] as const)('rejects %s and writes nothing', (_name, inputOf, resolveContext, reason) => {
    const opened = openPrepared();
    const rejection = rejectionOf(save(opened, inputOf(), SAVED_AT, resolveContext));
    expect(rejection.reason).toBe(reason);
    expect(AUTH_SETUP_STORE_REJECTION_REASONS).toContain(rejection.reason);
    expect(rowsOf(opened)).toEqual([]);
    expect(opened.connection.isTransaction).toBe(false);
  });

  it('rejects with PROFILE_REVISION_CONFLICT when the profile changes after the validation and before the write', () => {
    const opened = openPrepared();
    let changed = false;
    const changingResolver = (targetConfigPath: string): ReturnType<typeof resolveTestContext> => {
      if (!changed) {
        changed = true;
        // 検証の文脈を用意する間に、別の変更がプロファイルの改訂を進めた（書き込みのトランザクションの外）。
        expect(updateProfile(opened, { profile: testAuthProfile(PROFILE_ID, NEXT_REVISION), expectedRevision: MIN_PROFILE_REVISION }, {
          resolveContext: resolveTestContext,
        }).ok).toBe(true);
      }
      return resolveTestContext(targetConfigPath);
    };
    expect(rejectionOf(save(opened, setupFor(MIN_PROFILE_REVISION), SAVED_AT, changingResolver)).reason).toBe('PROFILE_REVISION_CONFLICT');
    expect(rowsOf(opened)).toEqual([]);
    expect(opened.connection.isTransaction).toBe(false);
  });

  it('rejects a setup for a PUBLIC_PASSIVE profile with the validation errors', () => {
    const opened = openPrepared();
    const rejection = rejectionOf(save(opened, setupFor(MIN_PROFILE_REVISION, { profileId: PUBLIC_PROFILE_ID })));
    expect(rejection.reason).toBe('AUTH_SETUP_INVALID');
    expect(rejection.errors.map(({ code }) => code)).toContain('AUTH_SETUP_MODE_UNSUPPORTED');
    expect(rowsOf(opened)).toEqual([]);
  });

  it('stops with DATABASE_INTEGRITY_FAILED when the stored document is broken or does not match its row', () => {
    const opened = openPrepared();
    expect(save(opened, setupFor(MIN_PROFILE_REVISION)).ok).toBe(true);
    const update = opened.connection.prepare('UPDATE auth_setups SET document = ? WHERE profile_id = ?');
    for (const document of [
      JSON.stringify({ ...setupFor(MIN_PROFILE_REVISION), extra: true }),
      JSON.stringify(setupFor(NEXT_REVISION)),
    ]) {
      update.run(document, PROFILE_ID);
      let caught: unknown;
      try {
        getAuthSetup(opened, PROFILE_ID);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ControlStoreError);
      expect((caught as ControlStoreError).reason).toBe('DATABASE_INTEGRITY_FAILED');
      expect(opened.connection.isTransaction).toBe(false);
    }
  });

  it('reads through a transaction of its own (it does not nest inside another transaction)', () => {
    const opened = openPrepared();
    opened.connection.exec('BEGIN');
    try {
      expect(() => getAuthSetup(opened, PROFILE_ID)).toThrow(/must not nest/u);
    } finally {
      opened.connection.exec('ROLLBACK');
    }
  });

  // LG-3b: 前の版（版 1・版 2）の文書の行は、読み替えずに管理データの誤りで止まる（黙って版 3 として読まない）。
  it('stops with DATABASE_INTEGRITY_FAILED for a document of version 1 or version 2, or of another shape (LG-3)', () => {
    const opened = openPrepared();
    expect(save(opened, setupFor(MIN_PROFILE_REVISION)).ok).toBe(true);
    const update = opened.connection.prepare('UPDATE auth_setups SET document = ? WHERE profile_id = ?');
    const { automatedLogin: _omitted, ...withoutAutomatedLogin } = setupFor(MIN_PROFILE_REVISION);
    for (const document of [
      // 版 1 の文書（T25 の時点で保存された行の中身）。
      JSON.stringify(previousVersionSetupDocumentOf(setupFor(MIN_PROFILE_REVISION), 1)),
      // 版 2 の文書（T26b の時点で保存された行の中身）。
      JSON.stringify(previousVersionSetupDocumentOf(setupFor(MIN_PROFILE_REVISION), 2)),
      // 版 1 の文字列に、版 2 の項目を足した文書。
      JSON.stringify({ ...previousVersionSetupDocumentOf(setupFor(MIN_PROFILE_REVISION), 1), automatedLogin: null }),
      // 版 3 の文字列で、`automatedLogin` のない文書。
      JSON.stringify(withoutAutomatedLogin),
      // 知らない版。
      JSON.stringify({ ...setupFor(MIN_PROFILE_REVISION), schemaVersion: 'beaksight-auth-setup/4' }),
    ]) {
      update.run(document, PROFILE_ID);
      let caught: unknown;
      try {
        getAuthSetup(opened, PROFILE_ID);
      } catch (error) {
        caught = error;
      }
      expect(caught, document).toBeInstanceOf(ControlStoreError);
      expect((caught as ControlStoreError).reason).toBe('DATABASE_INTEGRITY_FAILED');
      expect(opened.connection.isTransaction).toBe(false);
    }
  });

  it('has closed lists of reasons and freshness values', () => {
    expect(Object.isFrozen(AUTH_SETUP_STORE_REJECTION_REASONS)).toBe(true);
    expect(AUTH_SETUP_FRESHNESS_VALUES).toEqual(['CURRENT', 'STALE']);
    expect(Object.isFrozen(AUTH_SETUP_FRESHNESS_VALUES)).toBe(true);
  });
});

// LG-3b: T26b の版 1 の行の読み替え（版 2 として読む・保存し直すまで書き換えない）の確かめは捨てた（上の `DATABASE_INTEGRITY_FAILED` の確かめ）。
describe('T26b: the auth setup in the store', () => {
  it('writes version 3 (automatedLogin null for a MANUAL_SESSION profile)', () => {
    const opened = openPrepared();
    expect(save(opened, setupFor(MIN_PROFILE_REVISION)).ok).toBe(true);
    const [row] = rowsOf(opened);
    const document = JSON.parse(row?.document ?? 'null') as Record<string, unknown>;
    expect(document['schemaVersion']).toBe(AUTH_SETUP_SCHEMA_VERSION_3);
    expect(Object.hasOwn(document, 'automatedLogin')).toBe(true);
    expect(document['automatedLogin']).toBeNull();
  });

  it.each([1, 2] as const)('rejects saving a version %s document and writes nothing (LG-3)', (version) => {
    const opened = openPrepared();
    const rejection = rejectionOf(save(opened, previousVersionSetupDocumentOf(setupFor(MIN_PROFILE_REVISION), version)));
    expect(rejection.reason).toBe('AUTH_SETUP_INVALID');
    expect([...new Set(rejection.errors.map(({ code }) => code))]).toEqual(['AUTH_SETUP_SCHEMA_INVALID']);
    expect(rowsOf(opened)).toEqual([]);
  });

  it('saves and reads back the automated login setup of an AUTOMATED_LOGIN profile', () => {
    const opened = openPrepared();
    expect(createProfile(opened, { ...testAuthProfile(AUTOMATED_PROFILE_ID, MIN_PROFILE_REVISION), auth: 'AUTOMATED_LOGIN' }, {
      resolveContext: resolveTestContext,
    }).ok).toBe(true);
    const setup = automatedSetupFor(MIN_PROFILE_REVISION);
    const saved = save(opened, setup);
    expect(saved, JSON.stringify(saved)).toMatchObject({ ok: true });
    const read = getAuthSetup(opened, AUTOMATED_PROFILE_ID);
    expect(read?.setup).toEqual(setup);
    expect(read?.freshness).toBe('CURRENT');
    expect(Object.isFrozen(read?.setup.automatedLogin?.failureConditions.invalidCredentials)).toBe(true);

    const required = rejectionOf(save(opened, { ...setup, automatedLogin: null }));
    expect(required.errors.map(({ code }) => code)).toEqual(['AUTH_SETUP_AUTOMATED_LOGIN_REQUIRED']);
    const notAllowed = rejectionOf(save(opened, { ...setupFor(MIN_PROFILE_REVISION), automatedLogin: setup.automatedLogin }));
    expect(notAllowed.errors.map(({ code }) => code)).toEqual(['AUTH_SETUP_AUTOMATED_LOGIN_NOT_ALLOWED']);
    expect(getAuthSetup(opened, AUTOMATED_PROFILE_ID)?.setup).toEqual(setup);
    expect(getAuthSetup(opened, PROFILE_ID)).toBeNull();
  });
});

// T34a（Task 34 の設計書 3.2）: 認証の設定の版 3 は、保存して、そのままの版で読む。
describe('T34a: the auth setup version 3 in the store', () => {
  const SCRIPT_PROFILE_ID = 'example-script';
  const SERVICE_ORIGIN = 'https://auth.example.invalid';

  const scriptSetupFor = (profileRevision: number): AuthSetup => ({
    ...setupFor(profileRevision),
    profileId: SCRIPT_PROFILE_ID,
    loginPostEndpoints: [],
    loginTransport: 'SCRIPT_REQUEST',
    scriptLogin: { origin: SERVICE_ORIGIN, path: '/auth/v1/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] },
    loginSideRequests: [{ origin: SERVICE_ORIGIN, path: '/rest/v1/rpc/resolve', method: 'POST', maxPerLoginStage: 1 }],
    successStorageKey: { origin: TEST_ORIGIN, prefix: 'sb-', suffix: '-auth-token' },
  } as AuthSetup);

  it('saves a version 3 setup of a profile with service origins and reads it back as version 3', () => {
    const opened = openPrepared();
    expect(createProfile(opened, { ...testAuthProfile(SCRIPT_PROFILE_ID, MIN_PROFILE_REVISION), approvedServiceOrigins: [SERVICE_ORIGIN] },
      { resolveContext: resolveTestContext }).ok).toBe(true);
    const setup = scriptSetupFor(MIN_PROFILE_REVISION);
    expect(save(opened, setup).ok).toBe(true);
    const row = rowsOf(opened).find(({ profile_id: profileId }) => profileId === SCRIPT_PROFILE_ID);
    expect(JSON.parse(row?.document ?? '{}')).toEqual(setup);
    expect(getAuthSetup(opened, SCRIPT_PROFILE_ID)).toMatchObject({ setup, freshness: 'CURRENT' });
  });

  it('rejects a script login setup for a profile without service origins', () => {
    const opened = openPrepared();
    const rejection = rejectionOf(save(opened, { ...scriptSetupFor(MIN_PROFILE_REVISION), profileId: PROFILE_ID }));
    expect(rejection.reason).toBe('AUTH_SETUP_INVALID');
    expect(rejection.errors.map(({ code }) => code)).toContain('AUTH_SETUP_SERVICE_ORIGIN_NOT_APPROVED');
  });
});
