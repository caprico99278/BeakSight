// T26c（Task 26 の設計書 4.5 の「管理データの版 4」、変更履歴の「Blocker: T26c」の行）: 管理データの版 4 の結合テスト。
// - 公開済みの版 1〜3 の文の CHECK の値の一覧は、公開した時点の写しで固定する（後から一覧に値を足しても、版 1〜3 の文は変わらない）。
//   文そのもの（数値の定数を含む）も、生成される SQL の文の SHA-256 で固定する（T26c round 2）。
// - 版 1・2・3 のデータベースが、`openControlDatabase` で版 4 に上がる。版 2・版 3 のジョブの行は、種類 `AUDIT` で写る。前の行は残り、
//   索引は作り直される。
// - 版 4 のジョブの表: `job_kind`（`AUDIT_JOB_KINDS`。NOT NULL、既定の値なし）と、今の失敗の理由の一覧の CHECK。
// - 新しい表（`auto_login_attempts`、`auto_login_holds`、`credential_events`）: STRICT、閉じた一覧と日時の形の CHECK、止めている行は
//   1 つのプロファイルで 1 つまで。値・値のハッシュ・ユーザー名の列を持たない。
// 一時のフォルダだけを使い、終わったら消す。
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTOMATED_LOGIN_FAILURE_RESULTS, AUTOMATED_LOGIN_RESULTS, AUTOMATED_LOGIN_SUBMISSIONS } from '../../src/control/auth/automated-login-results.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import {
  ACTIVE_AUDIT_JOB_STATES,
  AUDIT_JOB_FAILURE_REASONS,
  AUDIT_JOB_KINDS,
  AUDIT_JOB_STATES,
  AUDIT_JOB_STATES_WITH_REASON,
  CREDENTIAL_EVENT_KINDS,
  FINAL_AUDIT_JOB_STATES,
} from '../../src/control/job/job-records.js';
import { closeControlDatabase, openControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { CONTROL_MIGRATIONS, CONTROL_SCHEMA_VERSION, runControlMigrations } from '../../src/control/store/migrations.js';
import { PROFILE_CHANGE_KINDS, PROFILE_STATUSES } from '../../src/control/store/profile-records.js';
import { WORKER_AUTH_STATES, WORKER_OUTCOME_KINDS } from '../../src/control/worker-protocol.js';
import { RUN_STATUSES } from '../../src/core/contracts.js';
import { publicProfile } from './control-profile-fixtures.js';

const RAW_TIMEOUT_MS = 0;
const JOBS_SCHEMA_VERSION = 2;
const AUTH_SETUPS_SCHEMA_VERSION = 3;
const AUTO_LOGIN_SCHEMA_VERSION = 4;
const PROFILE_ID = 'example-v4';
const OTHER_PROFILE_ID = 'example-v4-other';
const CREATED_AT = '20261010000000';
const FINISHED_AT = '20261010000100';

// ---------------------------------------------------------------------------------------------------------------
// 公開した時点の値の一覧（版 1〜3。ここを書き換えると、公開済みの版の中身が変わる）
// ---------------------------------------------------------------------------------------------------------------

const PUBLISHED_PROFILE_STATUSES = ['ACTIVE', 'RETIRED'];
const PUBLISHED_PROFILE_CHANGE_KINDS = ['CREATED', 'UPDATED', 'RETIRED'];
const PUBLISHED_JOB_STATES = ['STARTING', 'RUNNING', 'STOPPING', 'FINISHED', 'FAILED', 'INTERRUPTED'];
const PUBLISHED_ACTIVE_JOB_STATES = ['STARTING', 'RUNNING', 'STOPPING'];
const PUBLISHED_FINAL_JOB_STATES = ['FINISHED', 'FAILED', 'INTERRUPTED'];
const PUBLISHED_JOB_STATES_WITH_REASON = ['FAILED', 'INTERRUPTED'];
const PUBLISHED_RUN_STATUSES = ['COMPLETE', 'PARTIAL', 'FAILED', 'ABORTED_BY_SAFETY'];
const PUBLISHED_OUTCOME_KINDS = ['RAN', 'RUN_ACTIVE', 'VERSION_MISMATCH', 'RUN_DIRECTORY_UNAVAILABLE', 'RESUME_UNAVAILABLE'];
const PUBLISHED_VERSION_2_FAILURE_REASONS = [
  'CONFIG_ERROR', 'ARTIFACT_WRITE_FAILED', 'UNEXPECTED_FAILURE', 'PROTOCOL_VIOLATION', 'START_TIMEOUT', 'CONFIG_CHANGED',
  'WORKER_START_FAILED', 'WORKER_NOT_READY', 'WORKER_EXITED', 'WORKER_UNRESPONSIVE', 'STOP_TIMEOUT', 'SERVER_RESTARTED', 'SERVER_SHUTDOWN',
];
const PUBLISHED_VERSION_3_FAILURE_REASONS = [
  'CONFIG_ERROR', 'ARTIFACT_WRITE_FAILED', 'UNEXPECTED_FAILURE', 'PROTOCOL_VIOLATION', 'START_TIMEOUT', 'CONFIG_CHANGED',
  'AUTH_SETUP_CHANGED', 'AUTH_SETUP_REQUIRED', 'UNSUPPORTED_AUTH_STATE', 'LOGIN_TIMEOUT', 'LOGIN_ATTEMPTS_EXCEEDED',
  'WORKER_START_FAILED', 'WORKER_NOT_READY', 'WORKER_EXITED', 'WORKER_UNRESPONSIVE', 'STOP_TIMEOUT', 'SERVER_RESTARTED', 'SERVER_SHUTDOWN',
];
const PUBLISHED_VERSION_3_AUTH_STATES = [
  'AWAITING_LOGIN', 'AUTHENTICATED', 'AUTH_SETUP_REQUIRED', 'UNSUPPORTED_AUTH_STATE', 'SESSION_LOST', 'LOGIN_TIMEOUT', 'LOGIN_ATTEMPTS_EXCEEDED',
];

/** 版 2 と版 3 のジョブの表の CHECK の `IN (…)` の一覧（出てくる順）。 */
const publishedJobTableLists = (failureReasons: readonly string[], authStates: readonly string[] | null): readonly string[] => [
  `state: ${PUBLISHED_JOB_STATES.join(',')}`,
  'start_new: 0,1',
  `run_status: ${PUBLISHED_RUN_STATUSES.join(',')}`,
  `end_kind: ${PUBLISHED_OUTCOME_KINDS.join(',')}`,
  `failure_reason: ${failureReasons.join(',')}`,
  ...(authStates === null ? [] : [`last_auth_state: ${authStates.join(',')}`]),
  `state: ${PUBLISHED_FINAL_JOB_STATES.join(',')}`,
  `state: ${PUBLISHED_JOB_STATES_WITH_REASON.join(',')}`,
];
const PUBLISHED_ACTIVE_INDEX_LISTS = [`state: ${PUBLISHED_ACTIVE_JOB_STATES.join(',')}`, `state: ${PUBLISHED_ACTIVE_JOB_STATES.join(',')}`];

/** 版 1〜3 の文の、`<列> IN (…)` の一覧のすべて（出てくる順）。 */
const PUBLISHED_STATEMENT_LISTS: readonly (readonly string[])[] = [
  [`status: ${PUBLISHED_PROFILE_STATUSES.join(',')}`, `change_kind: ${PUBLISHED_PROFILE_CHANGE_KINDS.join(',')}`],
  [...publishedJobTableLists(PUBLISHED_VERSION_2_FAILURE_REASONS, null), ...PUBLISHED_ACTIVE_INDEX_LISTS],
  [...publishedJobTableLists(PUBLISHED_VERSION_3_FAILURE_REASONS, PUBLISHED_VERSION_3_AUTH_STATES), ...PUBLISHED_ACTIVE_INDEX_LISTS],
];

/** 版の文をつなぐ区切り（SHA-256 を求めるときだけに使う）。 */
const STATEMENT_SEPARATOR = '\n;\n';

/** 公開した時点の版 1・2・3 の文（`statements` を `STATEMENT_SEPARATOR` でつないだ UTF-8）の SHA-256（T26c round 2）。 */
const PUBLISHED_STATEMENT_SHA256: readonly string[] = [
  '395a9e5ca76a83d65baefd11ca17bdfc23812c1fce80021aaff87c40001c46a3',
  '88983a8241dda2953669a50f629e30533801d0cabb815bcb53e6c8648339a12a',
  'db903270f5bede60bf89d46b5bd4556a6da24f4f7e192502d6375ac913776902',
];

// ---------------------------------------------------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------------------------------------------------

let workDirectory = '';
const connections: DatabaseSync[] = [];

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-control-v4-'));
});

afterEach(() => {
  for (const connection of connections.splice(0)) {
    if (connection.isOpen) connection.close();
  }
  rmSync(workDirectory, { recursive: true, force: true });
});

const databasePath = (): string => resolveControlDatabasePath(workDirectory);

const rawConnection = (): DatabaseSync => {
  const connection = new DatabaseSync(databasePath(), { timeout: RAW_TIMEOUT_MS, enableForeignKeyConstraints: true });
  connections.push(connection);
  return connection;
};

/** 文の `<列> IN (…)` の一覧（`<列>: 値,値` の形。出てくる順）。 */
const inListsOf = (statements: readonly string[]): readonly string[] =>
  statements.flatMap((statement) => [...statement.matchAll(/\b(\w+) IN \(([^()]*)\)/gu)]
    .map((match) => `${match[1]}: ${(match[2] ?? '').split(',').map((value) => value.trim().replace(/^'|'$/gu, '')).join(',')}`));

/** `versions` の版までだけのデータベースを作り（プロファイルを 2 つ入れる）、生の接続を返す。 */
const prepareAtVersion = (versions: number): DatabaseSync => {
  mkdirSync(dirname(databasePath()), { recursive: true });
  const raw = rawConnection();
  raw.exec('PRAGMA journal_mode = WAL');
  expect(runControlMigrations(raw, CONTROL_MIGRATIONS.slice(0, versions))).toEqual({ foundSchemaVersion: 0, schemaVersion: versions });
  for (const profileId of [PROFILE_ID, OTHER_PROFILE_ID]) {
    raw.prepare('INSERT INTO profiles (profile_id, revision, status, document, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(profileId, MIN_PROFILE_REVISION, 'ACTIVE', JSON.stringify(publicProfile(profileId, MIN_PROFILE_REVISION)), CREATED_AT);
  }
  return raw;
};

/** 最新の版のデータベース（プロファイルを 2 つ入れた）の生の接続。 */
const latestConnection = (): DatabaseSync => {
  prepareAtVersion(1).close();
  closeControlDatabase(openControlDatabase(databasePath()));
  return rawConnection();
};

type SqlValue = string | number | null | Uint8Array;

const insertRow = (connection: DatabaseSync, table: string, row: Record<string, SqlValue>): void => {
  const columns = Object.keys(row);
  connection.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    .run(...columns.map((column) => row[column] ?? null));
};

const countOf = (connection: DatabaseSync, table: string): number =>
  (connection.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

const tableSqlOf = (connection: DatabaseSync, name: string): string =>
  String((connection.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name) as { sql: string }).sql);

const columnNamesOf = (connection: DatabaseSync, table: string): readonly string[] =>
  (connection.prepare('SELECT name FROM pragma_table_info(?)').all(table) as { name: string }[]).map((row) => row.name);

const checkListOf = (sql: string, column: string): readonly string[] => {
  const match = new RegExp(String.raw`\b${column} IN \(([^)]*)\)`, 'u').exec(sql);
  return (match?.[1] ?? '').split(',').map((value) => value.trim().replace(/^'|'$/gu, ''));
};

const jobIndexNamesOf = (connection: DatabaseSync): readonly string[] =>
  (connection.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'jobs' AND sql IS NOT NULL ORDER BY name").all() as { name: string }[])
    .map((row) => row.name);

const jobRow = (row: Record<string, SqlValue>): Record<string, SqlValue> =>
  ({ job_id: 'job-1', profile_id: PROFILE_ID, profile_revision: MIN_PROFILE_REVISION, state: 'STARTING', start_new: 0, created_at: CREATED_AT, ...row });

const attemptRow = (row: Record<string, SqlValue> = {}): Record<string, SqlValue> =>
  ({ profile_id: PROFILE_ID, job_id: 'job-1', started_at: CREATED_AT, credential_revision: 1, ...row });

// ---------------------------------------------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------------------------------------------

describe('Control store version 4 (T26c): the version list and the published versions', () => {
  // T27c: 版 5（Task 27）を足したので、版 4 が最新であることの確かめを、版 1〜4 の並びと「最新の版は `CONTROL_SCHEMA_VERSION`」の確かめに移した
  // （T26c と同じ形。版 5 は `control-store-v5.test.ts`）。
  it('is version 4, after versions 1 to 3', () => {
    expect(CONTROL_MIGRATIONS.slice(0, AUTO_LOGIN_SCHEMA_VERSION).map(({ version }) => version))
      .toEqual([1, JOBS_SCHEMA_VERSION, AUTH_SETUPS_SCHEMA_VERSION, AUTO_LOGIN_SCHEMA_VERSION]);
    expect(CONTROL_SCHEMA_VERSION).toBe(CONTROL_MIGRATIONS.at(-1)?.version);
    expect(CONTROL_SCHEMA_VERSION).toBeGreaterThanOrEqual(AUTO_LOGIN_SCHEMA_VERSION);
  });

  it('keeps every CHECK list of the published versions 1 to 3 as the copy at the time each version was published', () => {
    CONTROL_MIGRATIONS.slice(0, AUTH_SETUPS_SCHEMA_VERSION).forEach((migration, index) => {
      expect(inListsOf(migration.statements), `version ${migration.version}`).toEqual(PUBLISHED_STATEMENT_LISTS[index]);
    });
  });

  // T26c round 2: 値の一覧だけでなく、公開済みの版 1〜3 の文そのもの（数値の定数を含む）が変わらないことを、生成される SQL の文の SHA-256 で
  // 固定する。値は、T26c の変更の前の `dist` の文から求めた（変更の後の文と同じことを確かめた）。
  it('keeps the generated statements of the published versions 1 to 3 byte for byte', () => {
    PUBLISHED_STATEMENT_SHA256.forEach((expected, index) => {
      const migration = CONTROL_MIGRATIONS[index];
      const actual = createHash('sha256').update((migration?.statements ?? []).join(STATEMENT_SEPARATOR), 'utf8').digest('hex');
      expect(actual, `version ${index + 1}: 公開済みの版の文は変えない。参照する値の一覧と定数は、公開した時点の写しで固定する`).toBe(expected);
    });
  });

  it('has copies that the named lists still start with (values are only appended to the named lists)', () => {
    for (const [named, published] of [
      [PROFILE_STATUSES, PUBLISHED_PROFILE_STATUSES],
      [PROFILE_CHANGE_KINDS, PUBLISHED_PROFILE_CHANGE_KINDS],
      [AUDIT_JOB_STATES, PUBLISHED_JOB_STATES],
      [ACTIVE_AUDIT_JOB_STATES, PUBLISHED_ACTIVE_JOB_STATES],
      [FINAL_AUDIT_JOB_STATES, PUBLISHED_FINAL_JOB_STATES],
      [AUDIT_JOB_STATES_WITH_REASON, PUBLISHED_JOB_STATES_WITH_REASON],
      [RUN_STATUSES, PUBLISHED_RUN_STATUSES],
      [WORKER_OUTCOME_KINDS, PUBLISHED_OUTCOME_KINDS],
      [WORKER_AUTH_STATES, PUBLISHED_VERSION_3_AUTH_STATES],
      [AUDIT_JOB_FAILURE_REASONS, PUBLISHED_VERSION_3_FAILURE_REASONS],
    ] as const) {
      expect(named.slice(0, published.length)).toEqual(published);
    }
    // 版 4 で足した失敗の理由は、版 3 の文に入らない（公開済みの版の中身は変わらない）。
    expect(AUDIT_JOB_FAILURE_REASONS.length).toBeGreaterThan(PUBLISHED_VERSION_3_FAILURE_REASONS.length);
  });
});

describe('Control store version 4 (T26c): upgrades', () => {
  it.each([
    ['version 1', 1],
    ['version 2', JOBS_SCHEMA_VERSION],
    ['version 3', AUTH_SETUPS_SCHEMA_VERSION],
  ])('upgrades a database at %s to the latest version (version 4 and later)', (_name, versions) => {
    prepareAtVersion(versions).close();
    const database = openControlDatabase(databasePath());
    try {
      expect(database.foundSchemaVersion).toBe(versions);
      // T27c: 最新の版は版 5（版 4 の表は、版 5 の後も残る）。
      expect(database.schemaVersion).toBe(CONTROL_SCHEMA_VERSION);
    } finally {
      closeControlDatabase(database);
    }
    const reopened = rawConnection();
    for (const table of ['jobs', 'auth_setups', 'auto_login_attempts', 'auto_login_holds', 'credential_events']) {
      expect((reopened.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) as { n: number }).n, table)
        .toBe(1);
    }
    expect(countOf(reopened, 'profiles')).toBe(2);
  });

  it.each([
    ['version 2', JOBS_SCHEMA_VERSION, {}],
    ['version 3', AUTH_SETUPS_SCHEMA_VERSION, { last_auth_state: 'LOGIN_TIMEOUT' }],
  ] as const)('copies the jobs of %s as AUDIT jobs, keeping the rows and the indexes', (_name, versions, authColumns) => {
    const raw = prepareAtVersion(versions);
    insertRow(raw, 'jobs', jobRow({ job_id: 'job-old', state: 'FAILED', finished_at: FINISHED_AT, failure_reason: 'CONFIG_ERROR', exit_code: 4, ...authColumns }));
    insertRow(raw, 'jobs', jobRow({ job_id: 'job-active', state: 'RUNNING' }));
    raw.close();
    closeControlDatabase(openControlDatabase(databasePath()));

    const reopened = rawConnection();
    const rows = reopened.prepare('SELECT job_id, job_kind, state, failure_reason, exit_code, last_auth_state FROM jobs ORDER BY job_id').all();
    expect(rows).toEqual([
      { job_id: 'job-active', job_kind: 'AUDIT', state: 'RUNNING', failure_reason: null, exit_code: null, last_auth_state: null },
      {
        job_id: 'job-old', job_kind: 'AUDIT', state: 'FAILED', failure_reason: 'CONFIG_ERROR', exit_code: 4,
        last_auth_state: versions === AUTH_SETUPS_SCHEMA_VERSION ? 'LOGIN_TIMEOUT' : null,
      },
    ]);
    expect(jobIndexNamesOf(reopened)).toEqual(['jobs_created_at', 'jobs_single_active']);
    expect(() => insertRow(reopened, 'jobs', jobRow({ job_id: 'job-second-active', job_kind: 'AUDIT' }))).toThrow(/UNIQUE/u);
    expect((reopened.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name LIKE 'jobs_v%'").get() as { n: number }).n).toBe(0);
  });
});

describe('Control store version 4 (T26c): the jobs table', () => {
  it('has job_kind with the named list, no default value, and the current failure reasons', () => {
    const connection = latestConnection();
    const sql = tableSqlOf(connection, 'jobs');
    expect(sql).toMatch(/\)\s*STRICT\s*$/u);
    expect(checkListOf(sql, 'job_kind')).toEqual([...AUDIT_JOB_KINDS]);
    expect(checkListOf(sql, 'failure_reason')).toEqual([...AUDIT_JOB_FAILURE_REASONS]);
    expect(checkListOf(sql, 'last_auth_state')).toEqual([...WORKER_AUTH_STATES]);
    expect(sql).not.toMatch(/\bDEFAULT\b/iu);
    const kindColumn = connection.prepare("SELECT \"notnull\" AS not_null, dflt_value FROM pragma_table_info('jobs') WHERE name = 'job_kind'").get();
    expect(kindColumn).toEqual({ not_null: 1, dflt_value: null });

    insertRow(connection, 'jobs', jobRow({ job_id: 'job-audit', job_kind: 'AUDIT', state: 'FAILED', finished_at: FINISHED_AT, failure_reason: 'ACCOUNT_LOCKED' }));
    insertRow(connection, 'jobs', jobRow({ job_id: 'job-check', job_kind: 'LOGIN_CHECK' }));
    for (const [name, row] of [
      ['without job_kind', jobRow({ job_id: 'job-none', state: 'FINISHED', finished_at: FINISHED_AT })],
      ['an unknown job_kind', jobRow({ job_id: 'job-bad', job_kind: 'LOGIN', state: 'FINISHED', finished_at: FINISHED_AT })],
      ['an unknown failure reason', jobRow({ job_id: 'job-bad-reason', job_kind: 'AUDIT', state: 'FAILED', finished_at: FINISHED_AT, failure_reason: 'SUCCEEDED' })],
    ] as const) {
      expect(() => insertRow(connection, 'jobs', row), name).toThrow();
    }
    expect(countOf(connection, 'jobs')).toBe(2);
  });
});

describe('Control store version 4 (T26c): the auto login tables', () => {
  it('are STRICT and have no column for values, hashes or user names', () => {
    const connection = latestConnection();
    for (const table of ['auto_login_attempts', 'auto_login_holds', 'credential_events']) {
      expect(tableSqlOf(connection, table), table).toMatch(/\)\s*STRICT\s*$/u);
      expect(columnNamesOf(connection, table).filter((name) => /user|pass|hash|secret|value|cipher/iu.test(name)), table).toEqual([]);
    }
    expect(checkListOf(tableSqlOf(connection, 'auto_login_attempts'), 'result')).toEqual([...AUTOMATED_LOGIN_RESULTS]);
    expect(checkListOf(tableSqlOf(connection, 'auto_login_attempts'), 'submitted')).toEqual([...AUTOMATED_LOGIN_SUBMISSIONS]);
    expect(checkListOf(tableSqlOf(connection, 'auto_login_holds'), 'reason')).toEqual([...AUTOMATED_LOGIN_FAILURE_RESULTS]);
    expect(checkListOf(tableSqlOf(connection, 'credential_events'), 'kind')).toEqual([...CREDENTIAL_EVENT_KINDS]);
  });

  it('accepts attempts in the right shape and rejects the rows that break the CHECKs', () => {
    const connection = latestConnection();
    insertRow(connection, 'auto_login_attempts', attemptRow({ job_id: 'job-pending' }));
    insertRow(connection, 'auto_login_attempts', attemptRow({
      job_id: 'job-limited', result: 'RATE_LIMITED', submitted: 'YES', retry_after_until: FINISHED_AT, result_recorded_at: FINISHED_AT,
    }));
    insertRow(connection, 'auto_login_attempts', attemptRow({ job_id: 'job-ok', result: 'SUCCEEDED', submitted: 'YES', result_recorded_at: FINISHED_AT }));
    insertRow(connection, 'auto_login_attempts', attemptRow({ job_id: 'job-form', result: 'LOGIN_FORM_INVALID', submitted: 'NO', result_recorded_at: FINISHED_AT }));
    for (const [name, row] of [
      ['the same job twice', attemptRow({ job_id: 'job-pending' })],
      ['an unknown result', attemptRow({ job_id: 'j-1', result: 'LOCKED', submitted: 'YES', result_recorded_at: FINISHED_AT })],
      ['an unknown submission', attemptRow({ job_id: 'j-2', result: 'ACCOUNT_LOCKED', submitted: 'MAYBE', result_recorded_at: FINISHED_AT })],
      ['a result without the submission', attemptRow({ job_id: 'j-3', result: 'ACCOUNT_LOCKED', result_recorded_at: FINISHED_AT })],
      ['a submission without the result', attemptRow({ job_id: 'j-4', submitted: 'YES' })],
      ['a result without the recorded time', attemptRow({ job_id: 'j-5', result: 'ACCOUNT_LOCKED', submitted: 'YES' })],
      ['a recorded time without the result', attemptRow({ job_id: 'j-6', result_recorded_at: FINISHED_AT })],
      ['Retry-After for another result', attemptRow({
        job_id: 'j-7', result: 'ACCOUNT_LOCKED', submitted: 'YES', retry_after_until: FINISHED_AT, result_recorded_at: FINISHED_AT,
      })],
      ['a success that was not sent', attemptRow({ job_id: 'j-8', result: 'SUCCEEDED', submitted: 'NO', result_recorded_at: FINISHED_AT })],
      ['a start time that is not 14 digits', attemptRow({ job_id: 'j-9', started_at: '2026-10-10' })],
      ['a Retry-After deadline that is not 14 digits', attemptRow({
        job_id: 'j-10', result: 'RATE_LIMITED', submitted: 'YES', retry_after_until: 'tomorrow', result_recorded_at: FINISHED_AT,
      })],
      ['a credential revision of 0', attemptRow({ job_id: 'j-11', credential_revision: 0 })],
      ['a text revision (STRICT)', attemptRow({ job_id: 'j-12', credential_revision: 'one' })],
      ['an upper case job id', attemptRow({ job_id: 'Job-1' })],
      ['an unknown profile', attemptRow({ job_id: 'j-13', profile_id: 'missing-profile' })],
    ] as const) {
      expect(() => insertRow(connection, 'auto_login_attempts', row), name).toThrow();
    }
    expect(countOf(connection, 'auto_login_attempts')).toBe(4);
  });

  it('keeps at most one hold that is not cleared for each profile', () => {
    const connection = latestConnection();
    const hold = (row: Record<string, SqlValue>): Record<string, SqlValue> =>
      ({ profile_id: PROFILE_ID, reason: 'ACCOUNT_LOCKED', held_at: CREATED_AT, attempt_id: 1, ...row });
    insertRow(connection, 'auto_login_holds', hold({}));
    expect(() => insertRow(connection, 'auto_login_holds', hold({ attempt_id: 2 }))).toThrow(/UNIQUE/u);
    insertRow(connection, 'auto_login_holds', hold({ profile_id: OTHER_PROFILE_ID }));
    connection.prepare('UPDATE auto_login_holds SET cleared_at = ? WHERE profile_id = ?').run(FINISHED_AT, PROFILE_ID);
    insertRow(connection, 'auto_login_holds', hold({ attempt_id: 3, reason: 'AUTH_RESULT_UNKNOWN' }));
    for (const [name, row] of [
      ['SUCCEEDED as a reason', hold({ profile_id: OTHER_PROFILE_ID, reason: 'SUCCEEDED', cleared_at: FINISHED_AT })],
      ['an unknown reason', hold({ reason: 'LOCKED', cleared_at: FINISHED_AT })],
      ['a time that is not 14 digits', hold({ held_at: 'now', cleared_at: FINISHED_AT })],
      ['a cleared time that is not 14 digits', hold({ cleared_at: '2026' })],
      ['an unknown profile', hold({ profile_id: 'missing-profile', cleared_at: FINISHED_AT })],
    ] as const) {
      expect(() => insertRow(connection, 'auto_login_holds', row), name).toThrow();
    }
    expect(countOf(connection, 'auto_login_holds')).toBe(3);
  });

  it('accepts credential events of the closed list and rejects the others', () => {
    const connection = latestConnection();
    for (const kind of CREDENTIAL_EVENT_KINDS) {
      insertRow(connection, 'credential_events', { profile_id: PROFILE_ID, recorded_at: CREATED_AT, kind, credential_revision: kind === 'HOLD_CLEARED' ? null : 1 });
    }
    for (const [name, row] of [
      ['an unknown kind', { profile_id: PROFILE_ID, recorded_at: CREATED_AT, kind: 'RENAMED', credential_revision: 1 }],
      ['a revision of 0', { profile_id: PROFILE_ID, recorded_at: CREATED_AT, kind: 'CREATED', credential_revision: 0 }],
      ['a time that is not 14 digits', { profile_id: PROFILE_ID, recorded_at: '20261010', kind: 'CREATED', credential_revision: 1 }],
      ['an unknown profile', { profile_id: 'missing-profile', recorded_at: CREATED_AT, kind: 'CREATED', credential_revision: 1 }],
    ] as const) {
      expect(() => insertRow(connection, 'credential_events', row), name).toThrow();
    }
    expect(countOf(connection, 'credential_events')).toBe(CREDENTIAL_EVENT_KINDS.length);
  });
});
