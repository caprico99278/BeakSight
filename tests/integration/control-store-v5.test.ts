// T27c（Task 27 の設計書 4.6「管理データの版 5」、変更履歴「Blocker: T27c」の行）: 管理データの版 5 の結合テスト。
// - 版 4 の文の CHECK の値の一覧は、版 4 を公開した時点の写しで固定する（T26c と同じ教訓。ジョブの種類と失敗の理由に値を足しても、版 4 の文は
//   変わらない）。版 1〜4 の生成される SQL の文を、版ごとの SHA-256 で固定する（版 4 の値は、T27c の変更の前の `dist` の文から求めた）。
// - 版 1・2・3・4 のデータベースが、`openControlDatabase` で版 5 に上がる。ジョブの行は、種類を保って写る（版 3 までの行は版 4 で `AUDIT`）。
// - 版 5 のジョブの表: `job_kind` に `DISCOVERY`・`READ_CHECK`、失敗の理由に `JOB_KIND_NOT_SUPPORTED`。
// - 新しい表（`discovery_candidates`、`read_checks`、`read_check_results`）: STRICT、閉じた一覧と日時と digest の形の CHECK。索引の表は値・label・
//   ボタンの文言の列を持たない。
// 一時のフォルダだけを使い、終わったら消す。
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AUTOMATED_LOGIN_FAILURE_RESULTS,
  AUTOMATED_LOGIN_RESULTS,
  AUTOMATED_LOGIN_SUBMISSIONS,
} from '../../src/control/auth/automated-login-results.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import {
  AUDIT_JOB_FAILURE_REASONS,
  AUDIT_JOB_KINDS,
  CREDENTIAL_EVENT_KINDS,
} from '../../src/control/job/job-records.js';
import { closeControlDatabase, openControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { CONTROL_MIGRATIONS, CONTROL_SCHEMA_VERSION, runControlMigrations } from '../../src/control/store/migrations.js';
import { WORKER_AUTH_STATES, WORKER_LOGIN_FORM_INVALID_REASONS } from '../../src/control/worker-protocol.js';
import {
  CANDIDATE_CLASSIFICATIONS,
  CANDIDATE_REASON_CODES,
  FORM_METHODS,
  METHOD_OVERRIDE_VALUES,
} from '../../src/discovery/candidate-contracts.js';
import { MAX_DISCOVERY_READ_PAGE_PATHS } from '../../src/discovery/discovery-result.js';
import { READ_CHECK_RESULTS } from '../../src/discovery/read-check-contracts.js';
import { expectRowsCopiedThroughUpgrade, snapshotTableRows } from '../helpers/control-upgrade-rows.js';
import { publicProfile } from './control-profile-fixtures.js';

const RAW_TIMEOUT_MS = 0;
const AUTO_LOGIN_SCHEMA_VERSION = 4;
const DISCOVERY_SCHEMA_VERSION = 5;
const PROFILE_ID = 'example-v5';
const OTHER_PROFILE_ID = 'example-v5-other';
const CREATED_AT = '20261011000000';
const FINISHED_AT = '20261011000100';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const OTHER_DIGEST = `sha256:${'b'.repeat(64)}`;

// ---------------------------------------------------------------------------------------------------------------
// 公開した時点の値の一覧（版 4。ここを書き換えると、公開済みの版の中身が変わる）
// ---------------------------------------------------------------------------------------------------------------

const PUBLISHED_JOB_STATES = ['STARTING', 'RUNNING', 'STOPPING', 'FINISHED', 'FAILED', 'INTERRUPTED'];
const PUBLISHED_ACTIVE_JOB_STATES = ['STARTING', 'RUNNING', 'STOPPING'];
const PUBLISHED_FINAL_JOB_STATES = ['FINISHED', 'FAILED', 'INTERRUPTED'];
const PUBLISHED_JOB_STATES_WITH_REASON = ['FAILED', 'INTERRUPTED'];
const PUBLISHED_RUN_STATUSES = ['COMPLETE', 'PARTIAL', 'FAILED', 'ABORTED_BY_SAFETY'];
const PUBLISHED_OUTCOME_KINDS = ['RAN', 'RUN_ACTIVE', 'VERSION_MISMATCH', 'RUN_DIRECTORY_UNAVAILABLE', 'RESUME_UNAVAILABLE'];
const PUBLISHED_VERSION_4_AUTOMATED_LOGIN_FAILURE_RESULTS = [
  'INVALID_CREDENTIALS', 'ACCOUNT_LOCKED', 'MFA_REQUIRED', 'CREDENTIAL_EXPIRED', 'RATE_LIMITED', 'AUTH_RESULT_UNKNOWN', 'LOGIN_FORM_INVALID',
  'LOGIN_FORM_INPUT_FAILED', 'CREDENTIAL_CHANGED', 'CREDENTIAL_UNAVAILABLE', 'UNEXPECTED_LOGIN_REQUEST',
];
const PUBLISHED_VERSION_4_FAILURE_REASONS = [
  'CONFIG_ERROR', 'ARTIFACT_WRITE_FAILED', 'UNEXPECTED_FAILURE', 'PROTOCOL_VIOLATION', 'START_TIMEOUT', 'CONFIG_CHANGED',
  'AUTH_SETUP_CHANGED', 'AUTH_SETUP_REQUIRED', 'UNSUPPORTED_AUTH_STATE', 'LOGIN_TIMEOUT', 'LOGIN_ATTEMPTS_EXCEEDED',
  'WORKER_START_FAILED', 'WORKER_NOT_READY', 'WORKER_EXITED', 'WORKER_UNRESPONSIVE', 'STOP_TIMEOUT', 'SERVER_RESTARTED', 'SERVER_SHUTDOWN',
  ...PUBLISHED_VERSION_4_AUTOMATED_LOGIN_FAILURE_RESULTS,
];
const PUBLISHED_VERSION_4_AUTH_STATES = [
  'AWAITING_LOGIN', 'AUTHENTICATED', 'AUTH_SETUP_REQUIRED', 'UNSUPPORTED_AUTH_STATE', 'SESSION_LOST', 'LOGIN_TIMEOUT', 'LOGIN_ATTEMPTS_EXCEEDED',
  'AUTOMATED_LOGIN_FAILED',
];
const PUBLISHED_VERSION_4_JOB_KINDS = ['AUDIT', 'LOGIN_CHECK'];
const PUBLISHED_VERSION_4_AUTOMATED_LOGIN_RESULTS = ['SUCCEEDED', ...PUBLISHED_VERSION_4_AUTOMATED_LOGIN_FAILURE_RESULTS];
const PUBLISHED_VERSION_4_SUBMISSIONS = ['YES', 'NO', 'UNKNOWN'];
const PUBLISHED_VERSION_4_FORM_INVALID_REASONS = [
  'SELECTOR_NOT_UNIQUE', 'USERNAME_FIELD_INVALID', 'PASSWORD_FIELD_INVALID', 'SUBMIT_BUTTON_INVALID', 'NOT_SAME_FORM', 'METHOD_NOT_POST',
  'ACTION_NOT_ALLOWED', 'FORM_TARGET_NOT_SELF', 'FORM_UNREADABLE',
];
const PUBLISHED_VERSION_4_CREDENTIAL_EVENT_KINDS = ['CREATED', 'USERNAME_CHANGED', 'PASSWORD_CHANGED', 'BOTH_CHANGED', 'DELETED', 'HOLD_CLEARED'];

/** 版 4 の文の、`<列> IN (…)` の一覧のすべて（出てくる順）。 */
const PUBLISHED_VERSION_4_LISTS: readonly string[] = [
  `state: ${PUBLISHED_JOB_STATES.join(',')}`,
  'start_new: 0,1',
  `run_status: ${PUBLISHED_RUN_STATUSES.join(',')}`,
  `end_kind: ${PUBLISHED_OUTCOME_KINDS.join(',')}`,
  `failure_reason: ${PUBLISHED_VERSION_4_FAILURE_REASONS.join(',')}`,
  `last_auth_state: ${PUBLISHED_VERSION_4_AUTH_STATES.join(',')}`,
  `job_kind: ${PUBLISHED_VERSION_4_JOB_KINDS.join(',')}`,
  `state: ${PUBLISHED_FINAL_JOB_STATES.join(',')}`,
  `state: ${PUBLISHED_JOB_STATES_WITH_REASON.join(',')}`,
  `state: ${PUBLISHED_ACTIVE_JOB_STATES.join(',')}`,
  `state: ${PUBLISHED_ACTIVE_JOB_STATES.join(',')}`,
  `result: ${PUBLISHED_VERSION_4_AUTOMATED_LOGIN_RESULTS.join(',')}`,
  `submitted: ${PUBLISHED_VERSION_4_SUBMISSIONS.join(',')}`,
  `form_invalid_reason: ${PUBLISHED_VERSION_4_FORM_INVALID_REASONS.join(',')}`,
  `reason: ${PUBLISHED_VERSION_4_AUTOMATED_LOGIN_FAILURE_RESULTS.join(',')}`,
  `kind: ${PUBLISHED_VERSION_4_CREDENTIAL_EVENT_KINDS.join(',')}`,
];

/** 版の文をつなぐ区切り（SHA-256 を求めるときだけに使う。`control-store-v4.test.ts` と同じ）。 */
const STATEMENT_SEPARATOR = '\n;\n';

/**
 * 公開した時点の版 1〜4 の文（`statements` を `STATEMENT_SEPARATOR` でつないだ UTF-8）の SHA-256。版 1〜3 は T26c round 2 の値のまま。版 4 は、
 * T27c の変更の前の `dist`（2026-10-11 の build。`WORKER_JOB_KINDS` が `AUDIT`・`LOGIN_CHECK` の時点）の文から求めた。
 */
const PUBLISHED_STATEMENT_SHA256: readonly string[] = [
  '395a9e5ca76a83d65baefd11ca17bdfc23812c1fce80021aaff87c40001c46a3',
  '88983a8241dda2953669a50f629e30533801d0cabb815bcb53e6c8648339a12a',
  'db903270f5bede60bf89d46b5bd4556a6da24f4f7e192502d6375ac913776902',
  'c01a9cc2de065f758b0280b4294a5be917b9f1ad963db6128f8286ed97f91356',
];

// ---------------------------------------------------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------------------------------------------------

let workDirectory = '';
const connections: DatabaseSync[] = [];

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-control-v5-'));
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

const candidateRow = (row: Record<string, SqlValue> = {}): Record<string, SqlValue> => ({
  profile_id: PROFILE_ID,
  identity_digest: DIGEST,
  rule_digest: OTHER_DIGEST,
  classification: 'READ',
  reason_code: 'READ_GET_FORM',
  page_path: '/admin/items',
  action_path: '/admin/items',
  form_method: 'GET',
  method_override: null,
  has_state_field: 0,
  first_seen_job_id: 'job-1',
  first_seen_at: CREATED_AT,
  last_seen_job_id: 'job-1',
  last_seen_at: CREATED_AT,
  last_changed_job_id: null,
  ...row,
});

const readCheckRow = (row: Record<string, SqlValue> = {}): Record<string, SqlValue> => ({
  read_check_id: 'read-check-1',
  profile_id: PROFILE_ID,
  target_identity_digest: DIGEST,
  parameters: '{"q":"example"}',
  expectations: '[{"kind":"ROW_COUNT_AT_LEAST","count":1}]',
  revision: 1,
  created_at: CREATED_AT,
  updated_at: CREATED_AT,
  canceled_at: null,
  ...row,
});

const resultRow = (row: Record<string, SqlValue> = {}): Record<string, SqlValue> => ({
  job_id: 'job-1',
  read_check_id: 'read-check-1',
  read_check_revision: 1,
  result: 'MATCHED',
  recorded_at: FINISHED_AT,
  ...row,
});

// ---------------------------------------------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------------------------------------------

describe('Control store version 5 (T27c): the version list and the published versions', () => {
  // T28c: 版 6（Task 28）を足したので、版 5 が最新であることの確かめを、版 1〜5 の並びと「最新の版は `CONTROL_SCHEMA_VERSION`」の確かめに移した
  // （版 4 の `control-store-v4.test.ts` の T27c と同じ形。版 5 の文の固定は `control-store-v6.test.ts`）。
  it('is after versions 1 to 4, and the latest version is CONTROL_SCHEMA_VERSION', () => {
    expect(CONTROL_MIGRATIONS.slice(0, DISCOVERY_SCHEMA_VERSION).map(({ version }) => version))
      .toEqual([1, 2, 3, AUTO_LOGIN_SCHEMA_VERSION, DISCOVERY_SCHEMA_VERSION]);
    expect(CONTROL_SCHEMA_VERSION).toBe(CONTROL_MIGRATIONS.at(-1)?.version);
    expect(CONTROL_SCHEMA_VERSION).toBeGreaterThanOrEqual(DISCOVERY_SCHEMA_VERSION);
  });

  it('keeps every CHECK list of the published version 4 as the copy at the time version 4 was published', () => {
    expect(inListsOf(CONTROL_MIGRATIONS[AUTO_LOGIN_SCHEMA_VERSION - 1]?.statements ?? [])).toEqual(PUBLISHED_VERSION_4_LISTS);
  });

  // 値の一覧だけでなく、公開済みの版 1〜4 の文そのもの（数値の定数と 1 つの値の定数を含む）が変わらないことを、生成される SQL の文の
  // SHA-256 で固定する。版 4 の値を変えると（たとえば版 4 の文が今のジョブの種類の一覧を参照すると）、このテストが失敗する。
  it('keeps the generated statements of the published versions 1 to 4 byte for byte', () => {
    PUBLISHED_STATEMENT_SHA256.forEach((expected, index) => {
      const migration = CONTROL_MIGRATIONS[index];
      const actual = createHash('sha256').update((migration?.statements ?? []).join(STATEMENT_SEPARATOR), 'utf8').digest('hex');
      expect(actual, `version ${index + 1}: 公開済みの版の文は変えない。参照する値の一覧と定数は、公開した時点の写しで固定する`).toBe(expected);
    });
  });

  it('has copies that the named lists still start with (values are only appended to the named lists)', () => {
    for (const [named, published] of [
      [AUDIT_JOB_FAILURE_REASONS, PUBLISHED_VERSION_4_FAILURE_REASONS],
      [WORKER_AUTH_STATES, PUBLISHED_VERSION_4_AUTH_STATES],
      [AUDIT_JOB_KINDS, PUBLISHED_VERSION_4_JOB_KINDS],
      [AUTOMATED_LOGIN_RESULTS, PUBLISHED_VERSION_4_AUTOMATED_LOGIN_RESULTS],
      [AUTOMATED_LOGIN_SUBMISSIONS, PUBLISHED_VERSION_4_SUBMISSIONS],
      [WORKER_LOGIN_FORM_INVALID_REASONS, PUBLISHED_VERSION_4_FORM_INVALID_REASONS],
      [AUTOMATED_LOGIN_FAILURE_RESULTS, PUBLISHED_VERSION_4_AUTOMATED_LOGIN_FAILURE_RESULTS],
      [CREDENTIAL_EVENT_KINDS, PUBLISHED_VERSION_4_CREDENTIAL_EVENT_KINDS],
    ] as const) {
      expect(named.slice(0, published.length)).toEqual(published);
    }
    // T27c・T27d で足した値は、版 4 の文に入らない（公開済みの版の中身は変わらない）。T30d で足した値（版 8）と T31e で足した値（版 9）も同じ。
    expect(AUDIT_JOB_KINDS.slice(PUBLISHED_VERSION_4_JOB_KINDS.length)).toEqual(['DISCOVERY', 'READ_CHECK', 'WRITE_CREATE', 'WRITE_UPDATE']);
    expect(AUDIT_JOB_FAILURE_REASONS.slice(PUBLISHED_VERSION_4_FAILURE_REASONS.length))
      .toEqual(['JOB_KIND_NOT_SUPPORTED', 'DISCOVERY_RESULT_INVALID', 'READ_CHECK_RESULT_INVALID', 'WRITE_GRANT_REJECTED', 'WRITE_RESULT_INVALID']);
  });
});

describe('Control store version 5 (T27c): upgrades', () => {
  it.each([1, 2, 3, AUTO_LOGIN_SCHEMA_VERSION])('upgrades a database at version %i to the latest version (version 5 and later)', (versions) => {
    prepareAtVersion(versions).close();
    const database = openControlDatabase(databasePath());
    try {
      expect(database.foundSchemaVersion).toBe(versions);
      expect(database.schemaVersion).toBe(CONTROL_SCHEMA_VERSION);
    } finally {
      closeControlDatabase(database);
    }
    const reopened = rawConnection();
    for (const table of ['jobs', 'auth_setups', 'auto_login_attempts', 'discovery_candidates', 'read_checks', 'read_check_results']) {
      expect((reopened.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) as { n: number }).n, table)
        .toBe(1);
    }
    expect(countOf(reopened, 'profiles')).toBe(2);
  });

  it('copies the jobs of version 4 with their kinds and every column, keeping the indexes', () => {
    const raw = prepareAtVersion(AUTO_LOGIN_SCHEMA_VERSION);
    insertRow(raw, 'jobs', jobRow({
      job_id: 'job-old', job_kind: 'LOGIN_CHECK', state: 'FAILED', finished_at: FINISHED_AT, failure_reason: 'UNEXPECTED_LOGIN_REQUEST', exit_code: 1,
      last_auth_state: 'AUTOMATED_LOGIN_FAILED', session_lost_url: 'http://127.0.0.1/admin', run_id: 'RUN-000001',
    }));
    insertRow(raw, 'jobs', jobRow({ job_id: 'job-active', job_kind: 'AUDIT', state: 'RUNNING' }));
    insertRow(raw, 'auto_login_attempts', { profile_id: PROFILE_ID, job_id: 'job-old', started_at: CREATED_AT, credential_revision: 1 });
    // DEF-118: 版 4 の列の値がすべて写ることを確かめる（後の版で足された列は比べない。列の一覧は版 4 の表から読む）。
    const before = snapshotTableRows(raw, 'jobs', 'job_id');
    raw.close();
    closeControlDatabase(openControlDatabase(databasePath()));

    const reopened = rawConnection();
    expectRowsCopiedThroughUpgrade(reopened, 'jobs', 'job_id', before);
    expect(countOf(reopened, 'auto_login_attempts')).toBe(1);
    expect(jobIndexNamesOf(reopened)).toEqual(['jobs_created_at', 'jobs_single_active']);
    expect(() => insertRow(reopened, 'jobs', jobRow({ job_id: 'job-second-active', job_kind: 'DISCOVERY' }))).toThrow(/UNIQUE/u);
    expect((reopened.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name LIKE 'jobs_v%'").get() as { n: number }).n).toBe(0);
  });

  it('copies the jobs of version 3 as AUDIT jobs through versions 4 and 5', () => {
    const raw = prepareAtVersion(3);
    insertRow(raw, 'jobs', jobRow({ job_id: 'job-v3', state: 'FINISHED', finished_at: FINISHED_AT, last_auth_state: 'AUTHENTICATED' }));
    raw.close();
    closeControlDatabase(openControlDatabase(databasePath()));
    expect(rawConnection().prepare('SELECT job_id, job_kind, last_auth_state FROM jobs').all())
      .toEqual([{ job_id: 'job-v3', job_kind: 'AUDIT', last_auth_state: 'AUTHENTICATED' }]);
  });
});

describe('Control store version 5 (T27c): the jobs table', () => {
  it('has job_kind with DISCOVERY and READ_CHECK, no default value, and the current failure reasons', () => {
    const connection = latestConnection();
    const sql = tableSqlOf(connection, 'jobs');
    expect(sql).toMatch(/\)\s*STRICT\s*$/u);
    expect(checkListOf(sql, 'job_kind')).toEqual([...AUDIT_JOB_KINDS]);
    // T30d: 版 8 でジョブの表を作り直し、書き込みのジョブ `WRITE_CREATE` を足した。T31e: 最新の版（版 9）で作り直し、`WRITE_UPDATE` を足した。
    expect(checkListOf(sql, 'job_kind')).toEqual(['AUDIT', 'LOGIN_CHECK', 'DISCOVERY', 'READ_CHECK', 'WRITE_CREATE', 'WRITE_UPDATE']);
    expect(checkListOf(sql, 'failure_reason')).toEqual([...AUDIT_JOB_FAILURE_REASONS]);
    expect(checkListOf(sql, 'last_auth_state')).toEqual([...WORKER_AUTH_STATES]);
    expect(sql).not.toMatch(/\bDEFAULT\b/iu);

    insertRow(connection, 'jobs', jobRow({ job_id: 'job-discovery', job_kind: 'DISCOVERY', state: 'FINISHED', finished_at: FINISHED_AT }));
    insertRow(connection, 'jobs', jobRow({
      job_id: 'job-read', job_kind: 'READ_CHECK', state: 'FAILED', finished_at: FINISHED_AT, failure_reason: 'JOB_KIND_NOT_SUPPORTED',
    }));
    for (const [name, row] of [
      ['without job_kind', jobRow({ job_id: 'job-none', state: 'FINISHED', finished_at: FINISHED_AT })],
      ['an unknown job_kind', jobRow({ job_id: 'job-bad', job_kind: 'CREATE', state: 'FINISHED', finished_at: FINISHED_AT })],
      ['an unknown failure reason', jobRow({ job_id: 'job-bad-reason', job_kind: 'AUDIT', state: 'FAILED', finished_at: FINISHED_AT, failure_reason: 'MATCHED' })],
    ] as const) {
      expect(() => insertRow(connection, 'jobs', row), name).toThrow();
    }
    expect(countOf(connection, 'jobs')).toBe(2);
  });
});

describe('Control store version 5 (T27c): the discovery and READ check tables', () => {
  it('are STRICT, use the closed lists, and the index has no column for values, labels or button texts', () => {
    const connection = latestConnection();
    for (const table of ['discovery_candidates', 'read_checks', 'read_check_results']) {
      expect(tableSqlOf(connection, table), table).toMatch(/\)\s*STRICT\s*$/u);
    }
    expect(columnNamesOf(connection, 'discovery_candidates')).toEqual([
      'profile_id', 'identity_digest', 'rule_digest', 'classification', 'reason_code', 'page_path', 'action_path', 'form_method',
      'method_override', 'has_state_field', 'first_seen_job_id', 'first_seen_at', 'last_seen_job_id', 'last_seen_at', 'last_changed_job_id',
      // T31e（版 9）: 型にした識別の digest の一覧（digest だけ。欄の名前は持たない）。
      'templated_identity_digests',
    ]);
    expect(columnNamesOf(connection, 'discovery_candidates').filter((name) => /value|label|text|submitter|token|option|name/iu.test(name))).toEqual([]);
    const candidates = tableSqlOf(connection, 'discovery_candidates');
    expect(checkListOf(candidates, 'classification')).toEqual([...CANDIDATE_CLASSIFICATIONS]);
    expect(checkListOf(candidates, 'reason_code')).toEqual([...CANDIDATE_REASON_CODES]);
    expect(checkListOf(candidates, 'form_method')).toEqual([...FORM_METHODS]);
    expect(checkListOf(candidates, 'method_override')).toEqual([...METHOD_OVERRIDE_VALUES]);
    expect(checkListOf(tableSqlOf(connection, 'read_check_results'), 'result')).toEqual([...READ_CHECK_RESULTS]);
    expect(columnNamesOf(connection, 'read_checks')).toEqual([
      'read_check_id', 'profile_id', 'target_identity_digest', 'parameters', 'expectations', 'revision', 'created_at', 'updated_at', 'canceled_at',
    ]);
    expect(columnNamesOf(connection, 'read_check_results')).toEqual(['result_id', 'job_id', 'read_check_id', 'read_check_revision', 'result', 'recorded_at']);
  });

  it('accepts candidates in the right shape and rejects the rows that break the CHECKs', () => {
    const connection = latestConnection();
    insertRow(connection, 'discovery_candidates', candidateRow());
    insertRow(connection, 'discovery_candidates', candidateRow({ profile_id: OTHER_PROFILE_ID }));
    insertRow(connection, 'discovery_candidates', candidateRow({
      identity_digest: OTHER_DIGEST, classification: 'NOT_EXECUTABLE', reason_code: 'DESTRUCTIVE', form_method: 'POST', method_override: 'DELETE',
      has_state_field: 1, last_seen_job_id: 'job-2', last_seen_at: FINISHED_AT, last_changed_job_id: 'job-2',
    }));
    insertRow(connection, 'discovery_candidates', candidateRow({
      identity_digest: `sha256:${'c'.repeat(64)}`, classification: 'DISPLAY_ONLY', reason_code: 'NO_KNOWN_ACTION', action_path: null, form_method: null,
    }));
    for (const [name, row] of [
      ['the same profile and identity twice', candidateRow()],
      ['a digest of another shape', candidateRow({ identity_digest: 'a'.repeat(64) })],
      ['an upper case digest', candidateRow({ identity_digest: `sha256:${'A'.repeat(64)}` })],
      ['a rule digest of another shape', candidateRow({ identity_digest: `sha256:${'d'.repeat(64)}`, rule_digest: 'sha256:x' })],
      ['an unknown classification', candidateRow({ identity_digest: `sha256:${'e'.repeat(64)}`, classification: 'DELETE' })],
      ['a reason of another classification', candidateRow({ identity_digest: `sha256:${'e'.repeat(64)}`, reason_code: 'DESTRUCTIVE' })],
      ['an unknown method', candidateRow({ identity_digest: `sha256:${'e'.repeat(64)}`, form_method: 'PUT' })],
      ['an override without a form', candidateRow({ identity_digest: `sha256:${'e'.repeat(64)}`, action_path: null, form_method: null, method_override: 'PUT' })],
      ['an action without a method', candidateRow({ identity_digest: `sha256:${'e'.repeat(64)}`, form_method: null })],
      ['a path without the slash', candidateRow({ identity_digest: `sha256:${'e'.repeat(64)}`, page_path: 'admin' })],
      ['a state mark that is not 0 or 1', candidateRow({ identity_digest: `sha256:${'e'.repeat(64)}`, has_state_field: 2 })],
      ['a time that is not 14 digits', candidateRow({ identity_digest: `sha256:${'e'.repeat(64)}`, last_seen_at: '2026-10-11' })],
      ['a last time before the first', candidateRow({ identity_digest: `sha256:${'e'.repeat(64)}`, first_seen_at: FINISHED_AT, last_seen_at: CREATED_AT })],
      ['an upper case job id', candidateRow({ identity_digest: `sha256:${'e'.repeat(64)}`, last_seen_job_id: 'Job-1' })],
      ['an unknown profile', candidateRow({ profile_id: 'missing-profile' })],
    ] as const) {
      expect(() => insertRow(connection, 'discovery_candidates', row), name).toThrow();
    }
    expect(countOf(connection, 'discovery_candidates')).toBe(4);
  });

  it('accepts READ check definitions and results in the right shape and rejects the rows that break the CHECKs', () => {
    const connection = latestConnection();
    insertRow(connection, 'read_checks', readCheckRow());
    insertRow(connection, 'read_checks', readCheckRow({ read_check_id: 'read-check-2', revision: 2, updated_at: FINISHED_AT, canceled_at: FINISHED_AT }));
    for (const [name, row] of [
      ['the same id twice', readCheckRow()],
      ['parameters that are not an object', readCheckRow({ read_check_id: 'r-1', parameters: '["q"]' })],
      ['parameters that are not JSON', readCheckRow({ read_check_id: 'r-2', parameters: '{q' })],
      ['expectations that are not an array', readCheckRow({ read_check_id: 'r-3', expectations: '{}' })],
      ['a revision of 0', readCheckRow({ read_check_id: 'r-4', revision: 0 })],
      ['a text revision (STRICT)', readCheckRow({ read_check_id: 'r-5', revision: 'one' })],
      ['a digest of another shape', readCheckRow({ read_check_id: 'r-6', target_identity_digest: 'sha256:' })],
      ['an update before the creation', readCheckRow({ read_check_id: 'r-7', created_at: FINISHED_AT, updated_at: CREATED_AT })],
      ['a canceled time that is not 14 digits', readCheckRow({ read_check_id: 'r-8', canceled_at: 'now' })],
      ['an upper case id', readCheckRow({ read_check_id: 'Read-1' })],
      ['an unknown profile', readCheckRow({ read_check_id: 'r-9', profile_id: 'missing-profile' })],
    ] as const) {
      expect(() => insertRow(connection, 'read_checks', row), name).toThrow();
    }
    expect(countOf(connection, 'read_checks')).toBe(2);

    for (const result of READ_CHECK_RESULTS) {
      insertRow(connection, 'read_check_results', resultRow({ job_id: `job-${result.toLowerCase().split('_').join('-')}`, result }));
    }
    for (const [name, row] of [
      ['the same job and definition twice', resultRow({ job_id: 'job-matched' })],
      ['an unknown result', resultRow({ job_id: 'job-x', result: 'PASSED' })],
      ['an unknown definition', resultRow({ job_id: 'job-y', read_check_id: 'missing' })],
      ['a revision of 0', resultRow({ job_id: 'job-z', read_check_revision: 0 })],
      ['a time that is not 14 digits', resultRow({ job_id: 'job-w', recorded_at: '20261011' })],
      ['an upper case job id', resultRow({ job_id: 'JOB-1' })],
    ] as const) {
      expect(() => insertRow(connection, 'read_check_results', row), name).toThrow();
    }
    expect(countOf(connection, 'read_check_results')).toBe(READ_CHECK_RESULTS.length);
  });
});

describe('Control store version 5 (T27d): the discovery jobs table', () => {
  const discoveryJobRow = (row: Record<string, SqlValue> = {}): Record<string, SqlValue> => ({
    job_id: 'job-1',
    profile_id: PROFILE_ID,
    recorded_at: CREATED_AT,
    read_page_paths: '["/admin","/admin/items"]',
    ...row,
  });

  it('is STRICT, keeps the job, the profile, the time and the read page paths only, and is indexed by profile and time', () => {
    const connection = latestConnection();
    expect(tableSqlOf(connection, 'discovery_jobs')).toMatch(/\)\s*STRICT\s*$/u);
    expect(columnNamesOf(connection, 'discovery_jobs')).toEqual(['job_id', 'profile_id', 'recorded_at', 'read_page_paths']);
    expect(tableSqlOf(connection, 'discovery_jobs')).toContain(`json_array_length(read_page_paths) <= ${MAX_DISCOVERY_READ_PAGE_PATHS}`);
    const indexes = (connection.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'discovery_jobs' AND sql IS NOT NULL")
      .all() as { name: string }[]).map((row) => row.name);
    expect(indexes).toEqual(['discovery_jobs_profile_recorded']);
  });

  it('accepts a job row (also without read pages) and rejects the rows that break the CHECKs or repeat a job', () => {
    const connection = latestConnection();
    insertRow(connection, 'discovery_jobs', discoveryJobRow());
    insertRow(connection, 'discovery_jobs', discoveryJobRow({ job_id: 'job-2', profile_id: OTHER_PROFILE_ID, read_page_paths: '[]' }));
    for (const [name, row] of [
      ['the same job twice', discoveryJobRow()],
      ['the same job for another profile', discoveryJobRow({ profile_id: OTHER_PROFILE_ID })],
      ['an upper case job id', discoveryJobRow({ job_id: 'Job-3' })],
      ['a time that is not 14 digits', discoveryJobRow({ job_id: 'job-3', recorded_at: '2026-10-11' })],
      ['read page paths that are not JSON', discoveryJobRow({ job_id: 'job-3', read_page_paths: '[/admin' })],
      ['read page paths that are not an array', discoveryJobRow({ job_id: 'job-3', read_page_paths: '{"a":1}' })],
      ['too many read page paths', discoveryJobRow({ job_id: 'job-3', read_page_paths: JSON.stringify(Array.from({ length: MAX_DISCOVERY_READ_PAGE_PATHS + 1 }, (_value, index) => `/p/${index}`)) })],
      ['an unknown profile', discoveryJobRow({ job_id: 'job-3', profile_id: 'missing-profile' })],
    ] as const) {
      expect(() => insertRow(connection, 'discovery_jobs', row), name).toThrow();
    }
    expect(countOf(connection, 'discovery_jobs')).toBe(2);
  });
});
