// プロファイルの保存の結合テスト（Task 23 の設計書 4.3 の「表（版 1）」「保存の前に」「取り消し」、7 章の「書き込み」。T23c）。
// - 一時のフォルダの SQLite で、作成・取得・一覧・更新・取り消し・状態を確かめる。終わったら消す。
// - 表の中身の確かめと、壊れた文書の再現は、テストの側から生の接続（`database.connection`）で行う（`src/` の外。Gate の対象外）。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIN_PROFILE_REVISION, type SiteProfile } from '../../src/control/contracts.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { isAcceptedTargetConfigPath, validateSiteProfile } from '../../src/control/profile-policy.js';
import { CONTROL_SCHEMA_VERSION } from '../../src/control/store/migrations.js';
import { PROFILE_CHANGE_KINDS, PROFILE_STATUSES, STORE_META_KEYS } from '../../src/control/store/profile-records.js';
import {
  PROFILE_STORE_REJECTION_REASONS,
  createProfile,
  getProfile,
  listProfiles,
  retireProfile,
  updateProfile,
  type ProfileContextResolver,
  type ProfileStoreResult,
  type ProfileStoreRejectionReason,
  type ProfileWriteOptions,
} from '../../src/control/store/profile-store.js';
import { getStoreStatus } from '../../src/control/store/store-status.js';
import { ControlStoreError } from '../../src/control/store/store-errors.js';
import { formatCompactUtcTimestamp, isCompactUtcTimestamp } from '../../src/core/utc-timestamp.js';
import {
  DRIFTED_CONTEXT,
  OTHER_TEST_ORIGIN,
  PROFILE_CONTEXT,
  SECOND_PUBLIC_TARGET_PATH,
  UNKNOWN_TARGET_PATH,
  publicProfile,
  resolveDriftedContext,
  resolveTestContext,
  testAuthProfile,
} from './control-profile-fixtures.js';

/** 記録の日時を決めるための固定の時刻。 */
const CREATED_AT = new Date(Date.UTC(2026, 9, 9, 1, 2, 3));
const UPDATED_AT = new Date(Date.UTC(2026, 9, 9, 4, 5, 6));
const RETIRED_AT = new Date(Date.UTC(2026, 9, 10, 7, 8, 9));
const NEXT_REVISION = MIN_PROFILE_REVISION + 1;
const THIRD_REVISION = MIN_PROFILE_REVISION + 2;

let workDirectory = '';
let database: ControlDatabase;

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-control-profiles-'));
  database = openControlDatabase(resolveControlDatabasePath(workDirectory));
});

afterEach(() => {
  closeControlDatabase(database);
  rmSync(workDirectory, { recursive: true, force: true });
});

const optionsAt = (date: Date): ProfileWriteOptions => ({ resolveContext: resolveTestContext, now: () => date });

const timestampOf = (date: Date): string => formatCompactUtcTimestamp(date, 'test time');

interface ProfileRow {
  readonly profile_id: string;
  readonly revision: number;
  readonly status: string;
  readonly document: string;
  readonly updated_at: string;
}

interface RevisionRow {
  readonly profile_id: string;
  readonly revision: number;
  readonly document: string;
  readonly change_kind: string;
  readonly recorded_at: string;
}

const profileRows = (): readonly ProfileRow[] =>
  database.connection.prepare('SELECT * FROM profiles ORDER BY profile_id').all() as unknown as ProfileRow[];

const revisionRows = (): readonly RevisionRow[] =>
  database.connection.prepare('SELECT * FROM profile_revisions ORDER BY profile_id, revision').all() as unknown as RevisionRow[];

/** 拒否の理由（受けたら失敗にする）。 */
const rejectionOf = (result: ProfileStoreResult): Extract<ProfileStoreResult, { ok: false }> => {
  if (result.ok) {
    throw new Error('the profile store accepted the change');
  }
  return result;
};

const acceptedOf = (result: ProfileStoreResult): Extract<ProfileStoreResult, { ok: true }> => {
  if (!result.ok) {
    throw new Error(`the profile store rejected the change: ${result.reason} ${result.detail}`);
  }
  return result;
};

/** 表の中身の写し（変わっていないことの確かめ用）。 */
const snapshot = (): string => JSON.stringify({ profiles: profileRows(), revisions: revisionRows() });

const create = (profile: SiteProfile, date = CREATED_AT): ProfileStoreResult => createProfile(database, profile, optionsAt(date));

describe('Control store version 1 tables (design 4.3)', () => {
  it('creates profiles, profile_revisions and store_meta as STRICT tables', () => {
    const tables = database.connection.prepare("SELECT name, strict FROM pragma_table_list WHERE schema = 'main' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    expect(tables).toEqual([
      // T28c: 管理データの版 6 の承認と撤回の記録の表（Task 28 の設計書 4.2）。
      { name: 'approval_receipts', strict: 1 },
      // T25a: 管理データの版 3 の認証の設定の表（Task 25 の設計書 4.1）。
      { name: 'auth_setups', strict: 1 },
      // T26c: 管理データの版 4 の自動ログインの試しと止めた状態の表（Task 26 の設計書 4.5）。
      { name: 'auto_login_attempts', strict: 1 },
      { name: 'auto_login_holds', strict: 1 },
      // T24h-4: 管理データの版 2 の管理のロックの表（画面のサーバを 1 つだけにする。DEF-061）。
      { name: 'control_instance', strict: 1 },
      // T26c: 管理データの版 4 の資格情報の変更の記録の表（Task 26 の設計書 4.5）。
      { name: 'credential_events', strict: 1 },
      // T27c: 管理データの版 5 の候補の索引の表（Task 27 の設計書 4.6）。
      { name: 'discovery_candidates', strict: 1 },
      // T27d: 管理データの版 5 の、索引に記録した発見のジョブの表（Task 27 の設計書の変更履歴「Blocker: T27d」の行）。
      { name: 'discovery_jobs', strict: 1 },
      // T28c: 管理データの版 6 の実行の許可の表（Task 28 の設計書 4.2。書く口は T28d）。
      { name: 'execution_grants', strict: 1 },
      // T24e: 管理データの版 2 の監査のジョブの表（Task 24 の設計書 4.4）。
      { name: 'jobs', strict: 1 },
      { name: 'profile_revisions', strict: 1 },
      { name: 'profiles', strict: 1 },
      // T27c: 管理データの版 5 の READ の確かめの結果と定義の表（Task 27 の設計書 4.6）。
      { name: 'read_check_results', strict: 1 },
      { name: 'read_checks', strict: 1 },
      // T29d: 管理データの版 7 の入力の規則の集まりと、その版の写しの表（Task 29 の設計書 4.3）。
      { name: 'rule_set_revisions', strict: 1 },
      { name: 'rule_sets', strict: 1 },
      // T28c: 管理データの版 6 のシナリオの版の写しとシナリオの表（Task 28 の設計書 4.2）。
      { name: 'scenario_revisions', strict: 1 },
      { name: 'scenarios', strict: 1 },
      { name: 'store_meta', strict: 1 },
      // T28c: 管理データの版 6 の件数の予約の表（Task 28 の設計書 4.2。書く口は T28d）。
      { name: 'write_reservations', strict: 1 },
      // T30d: 管理データの版 8 の書き込みの結果の表（Task 30 の設計書 3 章の「記録」）。
      { name: 'write_results', strict: 1 },
    ]);
  });

  it('records the creating version and time in store_meta', () => {
    const rows = database.connection.prepare('SELECT key, value FROM store_meta ORDER BY key').all() as { key: string; value: string }[];
    const meta = new Map(rows.map((row) => [row.key, row.value]));
    expect([...meta.keys()].sort()).toEqual([...Object.values(STORE_META_KEYS)].sort());
    expect(meta.get(STORE_META_KEYS.createdSchemaVersion)).toBe(String(CONTROL_SCHEMA_VERSION));
    expect(isCompactUtcTimestamp(meta.get(STORE_META_KEYS.createdAt) ?? '')).toBe(true);
  });

  it('rejects values outside the closed lists and wrong types at the table level', () => {
    const insert = database.connection.prepare(
      'INSERT INTO profiles (profile_id, revision, status, document, updated_at) VALUES (?, ?, ?, ?, ?)',
    );
    const document = JSON.stringify(publicProfile('example-raw', MIN_PROFILE_REVISION));
    const stamp = timestampOf(CREATED_AT);
    expect(() => insert.run('example-raw', MIN_PROFILE_REVISION, 'DELETED', document, stamp)).toThrow();
    expect(() => insert.run('example-raw', 'one', 'ACTIVE', document, stamp)).toThrow();
    expect(() => insert.run('example-raw', 0, 'ACTIVE', document, stamp)).toThrow();
    expect(() => insert.run('example-raw', MIN_PROFILE_REVISION, 'ACTIVE', '{not json', stamp)).toThrow();
    expect(() => insert.run('example-raw', MIN_PROFILE_REVISION, 'ACTIVE', document, '2026-10-09')).toThrow();
    expect(profileRows()).toEqual([]);
  });

  it('has closed lists for the status and the change kind', () => {
    expect(PROFILE_STATUSES).toEqual(['ACTIVE', 'RETIRED']);
    expect(PROFILE_CHANGE_KINDS).toEqual(['CREATED', 'UPDATED', 'RETIRED']);
    expect(PROFILE_STORE_REJECTION_REASONS).toEqual([
      'PROFILE_INVALID',
      'TARGET_CONFIG_UNAVAILABLE',
      'PROFILE_REVISION_NOT_INITIAL',
      'PROFILE_ALREADY_EXISTS',
      'PROFILE_NOT_FOUND',
      'PROFILE_RETIRED',
      'PROFILE_REVISION_CONFLICT',
      'PROFILE_REVISION_NOT_ADVANCED',
      'STORED_PROFILE_INVALID',
    ] satisfies readonly ProfileStoreRejectionReason[]);
    for (const list of [PROFILE_STATUSES, PROFILE_CHANGE_KINDS, PROFILE_STORE_REJECTION_REASONS]) {
      expect(Object.isFrozen(list)).toBe(true);
    }
  });
});

describe('createProfile', () => {
  it('saves a valid profile as ACTIVE at the first revision, with a CREATED history row', () => {
    const result = acceptedOf(create(publicProfile('example-public', MIN_PROFILE_REVISION)));
    expect(result.stored).toEqual({
      profile: publicProfile('example-public', MIN_PROFILE_REVISION),
      status: 'ACTIVE',
      updatedAt: timestampOf(CREATED_AT),
    });
    expect(Object.isFrozen(result.stored)).toBe(true);
    expect(Object.isFrozen(result.stored.profile)).toBe(true);
    expect(profileRows()).toEqual([{
      profile_id: 'example-public',
      revision: MIN_PROFILE_REVISION,
      status: 'ACTIVE',
      document: JSON.stringify(publicProfile('example-public', MIN_PROFILE_REVISION)),
      updated_at: timestampOf(CREATED_AT),
    }]);
    expect(revisionRows()).toEqual([{
      profile_id: 'example-public',
      revision: MIN_PROFILE_REVISION,
      document: JSON.stringify(publicProfile('example-public', MIN_PROFILE_REVISION)),
      change_kind: 'CREATED',
      recorded_at: timestampOf(CREATED_AT),
    }]);
  });

  it('saves a test environment profile whose origins are inside the target', () => {
    acceptedOf(create(testAuthProfile('example-test-env', MIN_PROFILE_REVISION)));
    expect(getProfile(database, 'example-test-env')?.profile).toEqual(testAuthProfile('example-test-env', MIN_PROFILE_REVISION));
  });

  it('does not save an invalid profile, and returns the validation errors', () => {
    const invalid = { ...publicProfile('example-public', MIN_PROFILE_REVISION), mode: 'TEST_APPROVED_WRITE' };
    const rejection = rejectionOf(createProfile(database, invalid, optionsAt(CREATED_AT)));
    expect(rejection.reason).toBe('PROFILE_INVALID');
    expect(rejection.errors.map((error) => error.code)).toEqual(expect.arrayContaining(['PROFILE_MODE_ENVIRONMENT_MISMATCH']));
    expect(profileRows()).toEqual([]);
    expect(revisionRows()).toEqual([]);
  });

  it('does not save values that are not a profile', () => {
    for (const input of [null, 'profile', 42, [], {}, { ...publicProfile('example-public', MIN_PROFILE_REVISION), targetConfigPath: 7 }]) {
      const rejection = rejectionOf(createProfile(database, input, optionsAt(CREATED_AT)));
      expect(rejection.reason, JSON.stringify(input)).toBe('PROFILE_INVALID');
      expect(rejection.errors.length).toBeGreaterThan(0);
      expect(rejection.errors.every((error) => error.code === 'PROFILE_SCHEMA_INVALID')).toBe(true);
    }
    expect(profileRows()).toEqual([]);
  });

  it('stops with TARGET_CONFIG_UNAVAILABLE when the caller cannot resolve the target configuration', () => {
    const rejection = rejectionOf(create(publicProfile('example-public', MIN_PROFILE_REVISION, UNKNOWN_TARGET_PATH)));
    expect(rejection.reason).toBe('TARGET_CONFIG_UNAVAILABLE');
    expect(profileRows()).toEqual([]);
  });

  it('starts at the minimum revision', () => {
    const rejection = rejectionOf(create(publicProfile('example-public', NEXT_REVISION)));
    expect(rejection.reason).toBe('PROFILE_REVISION_NOT_INITIAL');
    expect(profileRows()).toEqual([]);
  });

  it('rejects a second profile with the same profileId, active or retired', () => {
    acceptedOf(create(publicProfile('example-public', MIN_PROFILE_REVISION)));
    const before = snapshot();
    expect(rejectionOf(create(publicProfile('example-public', MIN_PROFILE_REVISION))).reason).toBe('PROFILE_ALREADY_EXISTS');
    expect(snapshot()).toBe(before);

    acceptedOf(retireProfile(database, { profileId: 'example-public', expectedRevision: MIN_PROFILE_REVISION }, optionsAt(RETIRED_AT)));
    const afterRetire = snapshot();
    expect(rejectionOf(create(publicProfile('example-public', MIN_PROFILE_REVISION))).reason).toBe('PROFILE_ALREADY_EXISTS');
    expect(snapshot()).toBe(afterRetire);
  });

  it('records the time from the current clock when no clock is given', () => {
    const before = timestampOf(new Date());
    const result = acceptedOf(createProfile(database, publicProfile('example-public', MIN_PROFILE_REVISION), { resolveContext: resolveTestContext }));
    const after = timestampOf(new Date());
    expect(result.stored.updatedAt >= before && result.stored.updatedAt <= after).toBe(true);
  });
});

describe('getProfile and listProfiles', () => {
  it('returns null for an unknown profile', () => {
    expect(getProfile(database, 'example-missing')).toBeNull();
  });

  it('lists every profile in profileId order, retired ones included with their status', () => {
    acceptedOf(create(publicProfile('example-b', MIN_PROFILE_REVISION)));
    acceptedOf(create(publicProfile('example-a', MIN_PROFILE_REVISION)));
    acceptedOf(retireProfile(database, { profileId: 'example-b', expectedRevision: MIN_PROFILE_REVISION }, optionsAt(RETIRED_AT)));
    const list = listProfiles(database);
    expect(list.map((stored) => [stored.profile.profileId, stored.status, stored.profile.revision])).toEqual([
      ['example-a', 'ACTIVE', MIN_PROFILE_REVISION],
      ['example-b', 'RETIRED', NEXT_REVISION],
    ]);
    expect(Object.isFrozen(list)).toBe(true);
    expect(listProfiles(database)).toEqual(list);
  });

  it('stops with DATABASE_INTEGRITY_FAILED when a stored document is not a profile', () => {
    acceptedOf(create(publicProfile('example-public', MIN_PROFILE_REVISION)));
    database.connection.prepare("UPDATE profiles SET document = '{\"profileId\":\"example-public\"}' WHERE profile_id = 'example-public'").run();
    for (const read of [() => getProfile(database, 'example-public'), () => listProfiles(database)]) {
      let caught: unknown;
      try {
        read();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ControlStoreError);
      expect((caught as ControlStoreError).reason).toBe('DATABASE_INTEGRITY_FAILED');
    }
  });

  it('stops with DATABASE_INTEGRITY_FAILED when the document does not match its row', () => {
    acceptedOf(create(publicProfile('example-public', MIN_PROFILE_REVISION)));
    database.connection.prepare('UPDATE profiles SET revision = ? WHERE profile_id = ?').run(NEXT_REVISION, 'example-public');
    expect(() => getProfile(database, 'example-public')).toThrow(ControlStoreError);
  });
});

describe('updateProfile', () => {
  beforeEach(() => {
    acceptedOf(create(publicProfile('example-public', MIN_PROFILE_REVISION)));
  });

  const update = (profile: unknown, expectedRevision: number, date = UPDATED_AT): ProfileStoreResult =>
    updateProfile(database, { profile, expectedRevision }, optionsAt(date));

  it('saves the next revision and records an UPDATED history row', () => {
    const next = publicProfile('example-public', NEXT_REVISION, SECOND_PUBLIC_TARGET_PATH);
    const result = acceptedOf(update(next, MIN_PROFILE_REVISION));
    expect(result.stored).toEqual({ profile: next, status: 'ACTIVE', updatedAt: timestampOf(UPDATED_AT) });
    expect(getProfile(database, 'example-public')).toEqual(result.stored);
    expect(revisionRows().map((row) => [row.revision, row.change_kind, row.recorded_at, JSON.parse(row.document)])).toEqual([
      [MIN_PROFILE_REVISION, 'CREATED', timestampOf(CREATED_AT), publicProfile('example-public', MIN_PROFILE_REVISION)],
      [NEXT_REVISION, 'UPDATED', timestampOf(UPDATED_AT), next],
    ]);
  });

  it('rejects a stale expected revision as a revision conflict, and changes nothing', () => {
    acceptedOf(update(publicProfile('example-public', NEXT_REVISION, SECOND_PUBLIC_TARGET_PATH), MIN_PROFILE_REVISION));
    const before = snapshot();
    const rejection = rejectionOf(update(publicProfile('example-public', NEXT_REVISION), MIN_PROFILE_REVISION));
    expect(rejection.reason).toBe('PROFILE_REVISION_CONFLICT');
    expect(snapshot()).toBe(before);
  });

  it('rejects a revision that does not advance', () => {
    const before = snapshot();
    const rejection = rejectionOf(update(publicProfile('example-public', MIN_PROFILE_REVISION, SECOND_PUBLIC_TARGET_PATH), MIN_PROFILE_REVISION));
    expect(rejection.reason).toBe('PROFILE_REVISION_NOT_ADVANCED');
    expect(rejection.errors.map((error) => error.code)).toContain('PROFILE_REVISION_NOT_ADVANCED');
    expect(snapshot()).toBe(before);
  });

  it('does not save an invalid profile', () => {
    const before = snapshot();
    const invalid = { ...publicProfile('example-public', NEXT_REVISION), auth: 'AUTOMATED_LOGIN' };
    const rejection = rejectionOf(update(invalid, MIN_PROFILE_REVISION));
    expect(rejection.reason).toBe('PROFILE_INVALID');
    expect(rejection.errors.map((error) => error.code)).toContain('PROFILE_AUTH_MISMATCH');
    expect(snapshot()).toBe(before);
  });

  it('stops with TARGET_CONFIG_UNAVAILABLE for an unresolvable target', () => {
    const before = snapshot();
    expect(rejectionOf(update(publicProfile('example-public', NEXT_REVISION, UNKNOWN_TARGET_PATH), MIN_PROFILE_REVISION)).reason)
      .toBe('TARGET_CONFIG_UNAVAILABLE');
    expect(snapshot()).toBe(before);
  });

  it('rejects an unknown profile', () => {
    expect(rejectionOf(update(publicProfile('example-missing', NEXT_REVISION), MIN_PROFILE_REVISION)).reason).toBe('PROFILE_NOT_FOUND');
    expect(revisionRows()).toHaveLength(1);
  });

  it('rejects updating a retired profile', () => {
    acceptedOf(retireProfile(database, { profileId: 'example-public', expectedRevision: MIN_PROFILE_REVISION }, optionsAt(RETIRED_AT)));
    const before = snapshot();
    expect(rejectionOf(update(publicProfile('example-public', THIRD_REVISION), NEXT_REVISION)).reason).toBe('PROFILE_RETIRED');
    expect(snapshot()).toBe(before);
  });

  // T23c round 1: 前の改訂は保存してあった値なので、形と行との一致だけを確かめ、今の規則やターゲット設定で検証し直さない
  // （Task 22 の `assertProfileRevisionAdvance` の決まり）。次の改訂は `validateSiteProfile` を通す。
  it('(a) updates a stored profile that the current target configuration would reject, to a valid next revision', () => {
    acceptedOf(create(testAuthProfile('example-test-env', MIN_PROFILE_REVISION)));
    // ターゲット設定が変わり、保存してある Origin（TEST_ORIGIN）が範囲の外になった。
    expect(validateSiteProfile(testAuthProfile('example-test-env', MIN_PROFILE_REVISION), DRIFTED_CONTEXT).ok).toBe(false);
    const next = testAuthProfile('example-test-env', NEXT_REVISION, OTHER_TEST_ORIGIN);
    const result = acceptedOf(updateProfile(
      database,
      { profile: next, expectedRevision: MIN_PROFILE_REVISION },
      { resolveContext: resolveDriftedContext, now: () => UPDATED_AT },
    ));
    expect(result.stored.profile).toEqual(next);
    expect(revisionRows().filter((row) => row.profile_id === 'example-test-env').map((row) => row.change_kind))
      .toEqual(['CREATED', 'UPDATED']);
  });

  it('(a) still validates the next revision against the current target configuration', () => {
    acceptedOf(create(testAuthProfile('example-test-env', MIN_PROFILE_REVISION)));
    const before = snapshot();
    const rejection = rejectionOf(updateProfile(
      database,
      { profile: testAuthProfile('example-test-env', NEXT_REVISION), expectedRevision: MIN_PROFILE_REVISION },
      { resolveContext: resolveDriftedContext, now: () => UPDATED_AT },
    ));
    expect(rejection.reason).toBe('PROFILE_INVALID');
    expect(rejection.errors.map((error) => error.code)).toContain('PROFILE_TEST_ORIGIN_OUTSIDE_TARGET');
    expect(snapshot()).toBe(before);
  });

  it('(a) updates a stored document whose shape is right but whose combination breaks the rules', () => {
    // 形は正しいが、組み合わせの規則に反する文書（外から書き換えられた場合の再現）。次の改訂が正しければ、直すための更新ができる。
    const tampered = { ...publicProfile('example-public', MIN_PROFILE_REVISION), mode: 'TEST_APPROVED_WRITE' };
    database.connection.prepare('UPDATE profiles SET document = ? WHERE profile_id = ?').run(JSON.stringify(tampered), 'example-public');
    const next = publicProfile('example-public', NEXT_REVISION);
    expect(acceptedOf(update(next, MIN_PROFILE_REVISION)).stored.profile).toEqual(next);
  });

  it('(d) stops with STORED_PROFILE_INVALID when the stored document does not match the schema', () => {
    database.connection.prepare('UPDATE profiles SET document = ? WHERE profile_id = ?')
      .run(JSON.stringify({ ...publicProfile('example-public', MIN_PROFILE_REVISION), mode: 'UNKNOWN_MODE' }), 'example-public');
    const before = snapshot();
    const rejection = rejectionOf(update(publicProfile('example-public', NEXT_REVISION), MIN_PROFILE_REVISION));
    expect(rejection.reason).toBe('STORED_PROFILE_INVALID');
    expect(rejection.errors.map((error) => error.code)).toContain('PROFILE_SCHEMA_INVALID');
    expect(snapshot()).toBe(before);
  });

  it('stops with STORED_PROFILE_INVALID when the stored document does not match its row', () => {
    database.connection.prepare('UPDATE profiles SET document = ? WHERE profile_id = ?')
      .run(JSON.stringify(publicProfile('example-other', MIN_PROFILE_REVISION)), 'example-public');
    const before = snapshot();
    expect(rejectionOf(update(publicProfile('example-public', NEXT_REVISION), MIN_PROFILE_REVISION)).reason).toBe('STORED_PROFILE_INVALID');
    expect(snapshot()).toBe(before);
  });
});

describe('retireProfile', () => {
  beforeEach(() => {
    acceptedOf(create(publicProfile('example-public', MIN_PROFILE_REVISION)));
  });

  const retire = (expectedRevision: number, profileId = 'example-public'): ProfileStoreResult =>
    retireProfile(database, { profileId, expectedRevision }, optionsAt(RETIRED_AT));

  it('keeps the row, advances the revision by one, sets RETIRED and records a RETIRED history row', () => {
    const result = acceptedOf(retire(MIN_PROFILE_REVISION));
    expect(result.stored).toEqual({
      profile: publicProfile('example-public', NEXT_REVISION),
      status: 'RETIRED',
      updatedAt: timestampOf(RETIRED_AT),
    });
    expect(profileRows().map((row) => [row.profile_id, row.revision, row.status])).toEqual([['example-public', NEXT_REVISION, 'RETIRED']]);
    expect(revisionRows().map((row) => [row.revision, row.change_kind])).toEqual([
      [MIN_PROFILE_REVISION, 'CREATED'],
      [NEXT_REVISION, 'RETIRED'],
    ]);
  });

  it('rejects retiring twice', () => {
    acceptedOf(retire(MIN_PROFILE_REVISION));
    const before = snapshot();
    expect(rejectionOf(retire(NEXT_REVISION)).reason).toBe('PROFILE_RETIRED');
    expect(snapshot()).toBe(before);
  });

  it('rejects a stale expected revision as a revision conflict', () => {
    acceptedOf(updateProfile(
      database,
      { profile: publicProfile('example-public', NEXT_REVISION, SECOND_PUBLIC_TARGET_PATH), expectedRevision: MIN_PROFILE_REVISION },
      optionsAt(UPDATED_AT),
    ));
    const before = snapshot();
    expect(rejectionOf(retire(MIN_PROFILE_REVISION)).reason).toBe('PROFILE_REVISION_CONFLICT');
    expect(snapshot()).toBe(before);
  });

  it('rejects an unknown profile', () => {
    expect(rejectionOf(retire(MIN_PROFILE_REVISION, 'example-missing')).reason).toBe('PROFILE_NOT_FOUND');
  });

  // T23c round 1: 取り消しは、今のターゲット設定を読まない（文脈を求めない）。保存してあった値の形と行との一致だけを確かめ、
  // 改訂を 1 つ進めた写しは Task 22 の `retiredRevisionOf` が作る。
  it('(b) retires a stored profile that the current target configuration would reject, without resolving the target', () => {
    acceptedOf(create(testAuthProfile('example-test-env', MIN_PROFILE_REVISION)));
    const result = acceptedOf(retireProfile(
      database,
      { profileId: 'example-test-env', expectedRevision: MIN_PROFILE_REVISION },
      { now: () => RETIRED_AT },
    ));
    expect(result.stored).toEqual({
      profile: testAuthProfile('example-test-env', NEXT_REVISION),
      status: 'RETIRED',
      updatedAt: timestampOf(RETIRED_AT),
    });
  });

  it('(b) retires a stored document whose shape is right but whose combination breaks the rules', () => {
    const tampered = { ...publicProfile('example-public', MIN_PROFILE_REVISION), auth: 'MANUAL_SESSION' };
    database.connection.prepare('UPDATE profiles SET document = ? WHERE profile_id = ?').run(JSON.stringify(tampered), 'example-public');
    const result = acceptedOf(retire(MIN_PROFILE_REVISION));
    expect(result.stored.status).toBe('RETIRED');
    expect(result.stored.profile).toEqual({ ...tampered, revision: NEXT_REVISION });
  });

  it('(d) stops with STORED_PROFILE_INVALID when the stored document does not match the schema', () => {
    database.connection.prepare('UPDATE profiles SET document = ? WHERE profile_id = ?')
      .run(JSON.stringify({ ...publicProfile('example-public', MIN_PROFILE_REVISION), extra: true }), 'example-public');
    const before = snapshot();
    const rejection = rejectionOf(retire(MIN_PROFILE_REVISION));
    expect(rejection.reason).toBe('STORED_PROFILE_INVALID');
    expect(rejection.errors.map((error) => error.code)).toContain('PROFILE_SCHEMA_INVALID');
    expect(snapshot()).toBe(before);
  });

  it('(d) stops with STORED_PROFILE_INVALID when the stored document does not match its row', () => {
    database.connection.prepare('UPDATE profiles SET document = ? WHERE profile_id = ?')
      .run(JSON.stringify(publicProfile('example-public', NEXT_REVISION)), 'example-public');
    const before = snapshot();
    expect(rejectionOf(retire(MIN_PROFILE_REVISION)).reason).toBe('STORED_PROFILE_INVALID');
    expect(snapshot()).toBe(before);
  });

  it('stops with PROFILE_REVISION_NOT_ADVANCED when the revision cannot be advanced (the upper bound)', () => {
    const last = { ...publicProfile('example-public', MIN_PROFILE_REVISION), revision: Number.MAX_SAFE_INTEGER };
    database.connection.prepare('UPDATE profiles SET revision = ?, document = ? WHERE profile_id = ?')
      .run(Number.MAX_SAFE_INTEGER, JSON.stringify(last), 'example-public');
    const before = snapshot();
    expect(rejectionOf(retire(Number.MAX_SAFE_INTEGER)).reason).toBe('PROFILE_REVISION_NOT_ADVANCED');
    expect(snapshot()).toBe(before);
  });
});

// T23c round 1（c）: 受けないパスでは、文脈の解決（呼び出し側がファイルを読む関数）を呼ばない。結果は、`validateSiteProfile` が
// 同じパスを拒否するときと同じ理由の値と Task 22 の誤り（`PROFILE_INVALID`、`PROFILE_TARGET_PATH_INVALID`）。
describe('the target path is checked before resolveContext is called', () => {
  const REJECTED_PATHS: readonly string[] = [
    '../outside.json',
    'config/targets/../../outside.json',
    '/etc/targets/example.json',
    'C:/targets/example.json',
    'other/targets/example.json',
    'config/targets/example.txt',
  ];

  /** 呼ばれた回数を数える resolver（呼ばれたら、知っている文脈を返す）。 */
  const countingResolver = (): { readonly resolveContext: ProfileContextResolver; readonly calls: () => number } => {
    let count = 0;
    return {
      resolveContext: (targetConfigPath) => {
        count += 1;
        return resolveTestContext(targetConfigPath) ?? PROFILE_CONTEXT;
      },
      calls: () => count,
    };
  };

  /** 保存の部品の拒否が、`validateSiteProfile` の同じパスの拒否と同じ理由の値と誤りのコードであること。 */
  const expectSameAsPolicy = (input: SiteProfile, result: ProfileStoreResult): void => {
    const rejection = rejectionOf(result);
    const policy = validateSiteProfile(input, PROFILE_CONTEXT);
    expect(rejection.reason).toBe('PROFILE_INVALID');
    expect(rejection.errors.map((error) => error.code)).toEqual(['PROFILE_TARGET_PATH_INVALID']);
    expect(policy.ok ? [] : policy.errors.map((error) => error.code)).toEqual(['PROFILE_TARGET_PATH_INVALID']);
  };

  it('(c) createProfile does not call resolveContext for a path that the policy rejects', () => {
    for (const targetConfigPath of REJECTED_PATHS) {
      expect(isAcceptedTargetConfigPath(targetConfigPath), targetConfigPath).toBe(false);
      const counter = countingResolver();
      const input = publicProfile('example-public', MIN_PROFILE_REVISION, targetConfigPath);
      expectSameAsPolicy(input, createProfile(database, input, { resolveContext: counter.resolveContext, now: () => CREATED_AT }));
      expect(counter.calls(), targetConfigPath).toBe(0);
    }
    expect(profileRows()).toEqual([]);
  });

  it('(c) updateProfile does not call resolveContext for a path that the policy rejects', () => {
    acceptedOf(create(publicProfile('example-public', MIN_PROFILE_REVISION)));
    const before = snapshot();
    for (const targetConfigPath of REJECTED_PATHS) {
      const counter = countingResolver();
      const input = publicProfile('example-public', NEXT_REVISION, targetConfigPath);
      expectSameAsPolicy(input, updateProfile(
        database,
        { profile: input, expectedRevision: MIN_PROFILE_REVISION },
        { resolveContext: counter.resolveContext, now: () => UPDATED_AT },
      ));
      expect(counter.calls(), targetConfigPath).toBe(0);
    }
    expect(snapshot()).toBe(before);
  });

  it('(c) calls resolveContext once for an accepted path', () => {
    const counter = countingResolver();
    acceptedOf(createProfile(database, publicProfile('example-public', MIN_PROFILE_REVISION), {
      resolveContext: counter.resolveContext,
      now: () => CREATED_AT,
    }));
    expect(counter.calls()).toBe(1);
  });
});

describe('getStoreStatus', () => {
  it('reports the location, the SQLite version, the schema version, the counts by status and quick_check', () => {
    acceptedOf(create(publicProfile('example-a', MIN_PROFILE_REVISION)));
    acceptedOf(create(publicProfile('example-b', MIN_PROFILE_REVISION)));
    acceptedOf(create(testAuthProfile('example-c', MIN_PROFILE_REVISION)));
    acceptedOf(retireProfile(database, { profileId: 'example-b', expectedRevision: MIN_PROFILE_REVISION }, optionsAt(RETIRED_AT)));
    const status = getStoreStatus(database);
    expect(status).toEqual({
      path: resolveControlDatabasePath(workDirectory),
      sqliteVersion: process.versions.sqlite,
      schemaVersion: CONTROL_SCHEMA_VERSION,
      latestSchemaVersion: CONTROL_SCHEMA_VERSION,
      createdSchemaVersion: CONTROL_SCHEMA_VERSION,
      createdAt: expect.stringMatching(/^\d{14}$/u),
      profileCounts: { ACTIVE: 2, RETIRED: 1 },
      quickCheck: { ok: true, messages: ['ok'] },
    });
    expect(Object.isFrozen(status)).toBe(true);
  });

  it('reports zero for each status of an empty store', () => {
    expect(getStoreStatus(database).profileCounts).toEqual({ ACTIVE: 0, RETIRED: 0 });
  });
});
