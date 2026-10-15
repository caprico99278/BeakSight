// 認証の設定の保存（管理データの版 3 の `auth_setups`。Task 25 の設計書 4.1 の「保存」。T25a round 1）の結合テスト。
// - 版 1 と版 2 のデータベースが、`openControlDatabase` で版 3 に上がる（前の版の行は残る）。表は `STRICT` で、CHECK と外部キーを持つ。
// - 保存（`saveAuthSetup`）の前に、保存してあるプロファイルを今の文脈で検証し直し、`validateAuthSetup` を通す。通らなければ書かない。
// - 保存と読み（`getAuthSetup`）の往復。プロファイルの改訂が変わった設定は、読むときに `STALE` と分かる。
// - 一時のフォルダだけを使い、終わったら消す。表の中身の確かめと壊れた文書の再現は、テストの側から生の接続で行う。
// - T26b（Task 26 の設計書 4.3）: 保存は版 2（`beaksight-auth-setup/2`）で書く。版 1 の文書の行は、読むときに `automatedLogin: null` の
//   版 2 として返し、行は書き換えない。自動ログインのプロファイルの版 2 の設定の往復。
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AUTH_SETUP_SCHEMA_VERSION,
  AUTH_SETUP_SCHEMA_VERSION_2,
  AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
  type AuthSetup,
  type AuthSetupV1,
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
import { CONTROL_MIGRATIONS, CONTROL_SCHEMA_VERSION, runControlMigrations } from '../../src/control/store/migrations.js';
import { createProfile, getProfile, retireProfile, updateProfile } from '../../src/control/store/profile-store.js';
import { ControlStoreError } from '../../src/control/store/store-errors.js';
import { formatCompactUtcTimestamp } from '../../src/core/utc-timestamp.js';
import {
  TEST_ORIGIN,
  publicProfile,
  resolveDriftedContext,
  resolveTestContext,
  testAuthProfile,
} from './control-profile-fixtures.js';

/** 版 3（認証の設定の表）。 */
const AUTH_SETUPS_SCHEMA_VERSION = 3;
/** 版 1（プロファイルの表）。 */
const PROFILES_SCHEMA_VERSION = 1;
/** 版 2（ジョブの表）。 */
const JOBS_SCHEMA_VERSION = 2;
const RAW_TIMEOUT_MS = 0;
const PROFILE_ID = 'example-auth';
const PUBLIC_PROFILE_ID = 'example-public';
const NEXT_REVISION = MIN_PROFILE_REVISION + 1;
const SAVED_AT = new Date(Date.UTC(2026, 9, 10, 1, 2, 3));
const RESAVED_AT = new Date(Date.UTC(2026, 9, 10, 4, 5, 6));
const LEGACY_CREATED_AT = '20261009000000';

const AUTOMATED_PROFILE_ID = 'example-automated';

const setupFor = (profileRevision: number, overrides: Partial<AuthSetup> = {}): AuthSetup => ({
  schemaVersion: AUTH_SETUP_SCHEMA_VERSION_2,
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

/** 版 1 の文書（T25 の時点で保存された行の中身）。 */
const v1SetupFor = (profileRevision: number): AuthSetupV1 => {
  const { automatedLogin: _omitted, ...rest } = setupFor(profileRevision);
  return { ...rest, schemaVersion: AUTH_SETUP_SCHEMA_VERSION };
};

/** 自動ログインのプロファイルの版 2 の設定。 */
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
const connections: DatabaseSync[] = [];

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-control-auth-setups-'));
});

afterEach(() => {
  if (database !== undefined) {
    closeControlDatabase(database);
    database = undefined;
  }
  for (const connection of connections.splice(0)) {
    if (connection.isOpen) {
      connection.close();
    }
  }
  rmSync(workDirectory, { recursive: true, force: true });
});

const databasePath = (): string => resolveControlDatabasePath(workDirectory);

const rawConnection = (): DatabaseSync => {
  const connection = new DatabaseSync(databasePath(), { timeout: RAW_TIMEOUT_MS, enableForeignKeyConstraints: true });
  connections.push(connection);
  return connection;
};

/** 版 3 のデータベースを開き、認証つきのプロファイル（改訂 1）と公開のプロファイルを作る。 */
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

const pragmaOf = (connection: DatabaseSync, name: string): unknown =>
  (connection.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>)[name];

const tableCount = (connection: DatabaseSync, name: string): number =>
  (connection.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name) as { n: number }).n;

/** `versions` 個の版だけを済ませたデータベースを作り、版 1 の表にプロファイルを 1 つ入れる（生の接続。閉じて返す）。 */
const prepareAtVersion = (versions: number): void => {
  mkdirSync(dirname(databasePath()), { recursive: true });
  const raw = rawConnection();
  raw.exec('PRAGMA journal_mode = WAL');
  expect(runControlMigrations(raw, CONTROL_MIGRATIONS.slice(0, versions))).toEqual({ foundSchemaVersion: 0, schemaVersion: versions });
  raw.prepare('INSERT INTO profiles (profile_id, revision, status, document, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(PROFILE_ID, MIN_PROFILE_REVISION, 'ACTIVE', JSON.stringify(testAuthProfile(PROFILE_ID, MIN_PROFILE_REVISION)), LEGACY_CREATED_AT);
  raw.close();
};

describe('Control store version 3: the auth_setups table', () => {
  // T26c（設計書の変更履歴の「Blocker: T26c」の行）: 版 4（自動ログインの表）を足したので、「版 3 が最新」の固定を、「版 3 が一覧の 3 番目にあり、
  // 中身が変わっていない」の確かめに移した（T25a round 1 の版 2 と同じ形。最新の版は `CONTROL_SCHEMA_VERSION` の定数で確かめる）。
  it('has version 3 as the third entry after versions 1 and 2, with its contents unchanged', () => {
    expect(CONTROL_MIGRATIONS.slice(0, AUTH_SETUPS_SCHEMA_VERSION).map(({ version }) => version))
      .toEqual([PROFILES_SCHEMA_VERSION, JOBS_SCHEMA_VERSION, AUTH_SETUPS_SCHEMA_VERSION]);
    expect(CONTROL_SCHEMA_VERSION).toBe(CONTROL_MIGRATIONS.at(-1)?.version);
    expect(CONTROL_SCHEMA_VERSION).toBeGreaterThanOrEqual(AUTH_SETUPS_SCHEMA_VERSION);
    const version3 = CONTROL_MIGRATIONS[AUTH_SETUPS_SCHEMA_VERSION - 1];
    expect(version3?.seed).toBeUndefined();
    const createdNames = (version3?.statements ?? [])
      .map((statement) => /^CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+(\w+)/u.exec(statement)?.[1])
      .filter((name) => name !== undefined);
    expect(createdNames).toEqual(['auth_setups', 'jobs_v3', 'jobs_single_active', 'jobs_created_at']);
  });

  it.each([
    ['version 1', PROFILES_SCHEMA_VERSION],
    ['version 2', JOBS_SCHEMA_VERSION],
  ])('upgrades a database at %s to the latest version (through version 3) and keeps the earlier rows', (_name, versions) => {
    prepareAtVersion(versions);
    const opened = openControlDatabase(databasePath());
    database = opened;
    expect(opened.foundSchemaVersion).toBe(versions);
    expect(opened.schemaVersion).toBe(CONTROL_SCHEMA_VERSION);
    expect(getProfile(opened, PROFILE_ID)?.profile.profileId).toBe(PROFILE_ID);
    expect(save(opened, setupFor(MIN_PROFILE_REVISION)).ok).toBe(true);
    closeControlDatabase(opened);
    database = undefined;
    const reopened = rawConnection();
    expect(pragmaOf(reopened, 'user_version')).toBe(CONTROL_SCHEMA_VERSION);
    expect(tableCount(reopened, 'auth_setups')).toBe(1);
    expect(tableCount(reopened, 'jobs')).toBe(1);
  });

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

  it('stops with DATABASE_INTEGRITY_FAILED for a document that is neither version 1 nor version 2 (T26b)', () => {
    const opened = openPrepared();
    expect(save(opened, setupFor(MIN_PROFILE_REVISION)).ok).toBe(true);
    const update = opened.connection.prepare('UPDATE auth_setups SET document = ? WHERE profile_id = ?');
    const { automatedLogin: _omitted, ...withoutAutomatedLogin } = setupFor(MIN_PROFILE_REVISION);
    for (const document of [
      // 版 1 の文字列に、版 2 の項目を足した文書。
      JSON.stringify({ ...v1SetupFor(MIN_PROFILE_REVISION), automatedLogin: null }),
      // 版 2 の文字列で、`automatedLogin` のない文書。
      JSON.stringify(withoutAutomatedLogin),
      // 知らない版。
      JSON.stringify({ ...setupFor(MIN_PROFILE_REVISION), schemaVersion: 'beaksight-auth-setup/3' }),
      // 版 1 の文書で、行と合わない。
      JSON.stringify(v1SetupFor(NEXT_REVISION)),
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

describe('T26b: the auth setup version 2 in the store', () => {
  /** 版 1 の文書を、テストの側から生の接続で行に書く（T25 の時点で保存された行の再現）。 */
  const writeV1Row = (opened: ControlDatabase, profileRevision: number): string => {
    const document = JSON.stringify(v1SetupFor(profileRevision));
    opened.connection.prepare('INSERT INTO auth_setups (profile_id, profile_revision, document, updated_at) VALUES (?, ?, ?, ?)')
      .run(PROFILE_ID, profileRevision, document, LEGACY_CREATED_AT);
    return document;
  };

  it('writes version 2 (automatedLogin null for a MANUAL_SESSION profile)', () => {
    const opened = openPrepared();
    expect(save(opened, setupFor(MIN_PROFILE_REVISION)).ok).toBe(true);
    const [row] = rowsOf(opened);
    const document = JSON.parse(row?.document ?? 'null') as Record<string, unknown>;
    expect(document['schemaVersion']).toBe(AUTH_SETUP_SCHEMA_VERSION_2);
    expect(Object.hasOwn(document, 'automatedLogin')).toBe(true);
    expect(document['automatedLogin']).toBeNull();
  });

  it('reads a version 1 row as version 2 with automatedLogin null, and does not rewrite the row', () => {
    const opened = openPrepared();
    const document = writeV1Row(opened, MIN_PROFILE_REVISION);
    const read = getAuthSetup(opened, PROFILE_ID);
    expect(read).toEqual({
      setup: setupFor(MIN_PROFILE_REVISION),
      updatedAt: LEGACY_CREATED_AT,
      freshness: 'CURRENT',
      profileRevision: MIN_PROFILE_REVISION,
    });
    expect(Object.keys(read?.setup ?? {})).toEqual(Object.keys(setupFor(MIN_PROFILE_REVISION)));
    expect(Object.isFrozen(read)).toBe(true);
    expect(Object.isFrozen(read?.setup)).toBe(true);
    expect(rowsOf(opened)).toEqual([{
      profile_id: PROFILE_ID,
      profile_revision: MIN_PROFILE_REVISION,
      document,
      updated_at: LEGACY_CREATED_AT,
    }]);
    expect(opened.connection.isTransaction).toBe(false);
  });

  it('keeps the CURRENT and STALE judgement for a version 1 row', () => {
    const opened = openPrepared();
    writeV1Row(opened, MIN_PROFILE_REVISION);
    expect(updateProfile(opened, { profile: testAuthProfile(PROFILE_ID, NEXT_REVISION), expectedRevision: MIN_PROFILE_REVISION }, {
      resolveContext: resolveTestContext,
    }).ok).toBe(true);
    const stale = getAuthSetup(opened, PROFILE_ID);
    expect(stale?.freshness).toBe('STALE');
    expect(stale?.profileRevision).toBe(NEXT_REVISION);
    expect(stale?.setup.schemaVersion).toBe(AUTH_SETUP_SCHEMA_VERSION_2);
    expect(stale?.setup.profileRevision).toBe(MIN_PROFILE_REVISION);
  });

  it('rewrites a version 1 row as version 2 only when the setup is saved again', () => {
    const opened = openPrepared();
    writeV1Row(opened, MIN_PROFILE_REVISION);
    const read = getAuthSetup(opened, PROFILE_ID);
    expect(read).not.toBeNull();
    expect(save(opened, read?.setup, RESAVED_AT).ok).toBe(true);
    expect(rowsOf(opened)).toEqual([{
      profile_id: PROFILE_ID,
      profile_revision: MIN_PROFILE_REVISION,
      document: JSON.stringify(setupFor(MIN_PROFILE_REVISION)),
      updated_at: formatCompactUtcTimestamp(RESAVED_AT, 'test'),
    }]);
  });

  it('rejects saving a version 1 document (the store turns version 1 into version 2 only when it reads)', () => {
    const opened = openPrepared();
    const rejection = rejectionOf(save(opened, v1SetupFor(MIN_PROFILE_REVISION)));
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
