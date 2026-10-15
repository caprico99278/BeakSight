// 管理データの版の管理（migration）の唯一の owner（Task 23 の設計書 4.3 の 6、7。T23a）。
// - 版の一覧（`CONTROL_MIGRATIONS`）は 1 から始まり 1 ずつ増える。表を足すときは、版を 1 つ足すだけにする（設計書 6）。
//   版 1 の表（`profiles`、`profile_revisions`、`store_meta`。設計書 4.3）は T23c で入れた（版 1 はまだ公開していないので、
//   版 2 にせず版 1 の中身を変えた。公開した後の版の中身は変えない）。版 1 は Task 23 で公開したので、Task 24 のジョブの表（`jobs`）は
//   版 2 として足した（T24e。版 1 の中身は変えていない）。版 2 は Task 24 で公開したので、Task 25 の認証の設定の表（`auth_setups`）は
//   版 3 として足した（T25a。版 1 と版 2 の中身は変えていない）。版 3 は未公開なので、T25d の認証の状態の列とジョブの失敗の理由の
//   追加（ジョブの表の作り直し）も、版 3 の中に足した（版 2 の CHECK は、公開した時点の一覧の写しで固定した）。版 3 は Task 25 で公開した
//   ので、Task 26 のジョブの種類と自動ログインの表は、版 4 として足した（T26c。版 1〜3 の中身は変えていない）。版 4 は Task 26 で公開したので、
//   Task 27 のジョブの種類（`DISCOVERY`・`READ_CHECK`）、候補の索引、READ の確かめの表は、版 5 として足した（T27c。版 1〜4 の中身は変えていない。
//   版 4 の CHECK の値の一覧は、版 4 を公開した時点の写しで固定した）。版 5 は Task 27 で公開したので、Task 28 のシナリオ・版の写し・承認と撤回の
//   記録・実行の許可・件数の予約の表は、版 6 として足した（T28c。版 1〜5 の中身は変えていない。版 5 の CHECK の値の一覧は、版 5 を公開した時点の
//   写しで固定した）。版 6 は Task 28 で公開した（G28）ので、Task 29 の入力の規則の表（`rule_sets`・`rule_set_revisions`）は、版 7 として足した
//   （T29d。版 1〜6 の中身は変えていない。版 6 の CHECK の値の一覧と数値は、版 6 を公開した時点の写しで固定した）。版 7 は Task 29 で公開した（G29）
//   ので、Task 30 のジョブの種類 `WRITE_CREATE`・書き込みのジョブの失敗の理由（ジョブの表の作り直し）と、書き込みの結果の表（`write_results`）は、
//   版 8 として足した（T30d。版 1〜7 の中身は変えていない。版 7 の数値は、版 7 を公開した時点の写しで固定した）。版 8 は G30 で公開したので、
//   Task 31 のジョブの種類 `WRITE_UPDATE`（ジョブの表の作り直し）、書き込みの結果の表の作り直し（書き込みの種類・対象のレコードの ID・UPDATE の
//   証拠）、発見の索引の型にした識別の digest の一覧、実行の許可の対象のレコードの ID は、版 9 として足した（T31e。版 1〜8 の中身は変えていない。
//   版 8 の CHECK の値の一覧と数値は、版 8 を公開した時点の写しで固定した）。版 9 は G31 で公開したので、Task 32 の書き込みのジョブの報告の確かめの
//   結果の列は、版 10 として足した（T32g。版 1〜9 の中身は変えていない。版 9 の CHECK の値の一覧と数値は、版 9 を公開した時点の写しで固定した）。
// - 公開した版の CHECK と索引が参照する値の一覧は、すべて公開した時点の写し（`VERSION_<N>_…`）で固定する（T26c。設計書の変更履歴の
//   「Blocker: T26c」の行の (2)）。名前つきの一覧に後から値を足しても、公開済みの版の文は変わらない。最新の未公開の版の文は、今の一覧を参照する。
// - 版ごとに、書き込みの唯一の入口（`withWriteTransaction`。`BEGIN IMMEDIATE`）の中で、DDL → `PRAGMA user_version = N` を行う。
//   失敗したら、その版のトランザクションは元に戻る（表も版も `application_id` も）。
// - トランザクションの中で版を読み直す（別の process が同じ版を先に済ませていたら、二重に作らない）。
// - 誰のデータベースかの確かめ（`assertControlDatabaseIdentity`）は、何も書かないうちに行う（ほかのプログラムのファイルを変えない）。
import { createSha256Fingerprint } from '../../core/ids.js';
import { COMPACT_UTC_TIMESTAMP_LENGTH, formatCompactUtcTimestamp } from '../../core/utc-timestamp.js';
import type { ActionResult, ResponseJudgement, SettledReservationState, SubmissionState } from '../actions/action-contracts.js';
import type { ScenarioKind } from '../approval/scenario-contracts.js';
import { MIN_PROFILE_REVISION } from '../contracts.js';
import { CONTROL_INSTANCE_SLOT, MAX_CONTROL_INSTANCE_PORT, MIN_CONTROL_INSTANCE_PORT, WRITE_REPORT_CHECKS } from '../job/job-records.js';
import {
  MAX_WORKER_EXIT_CODE,
  MAX_WORKER_MESSAGE_PATH_LENGTH,
  MAX_WORKER_NOTICE_URL_LENGTH,
  WORKER_WRITE_JOB_KINDS,
} from '../worker-protocol.js';
import type { ReadCheckResult } from '../../discovery/read-check-contracts.js';
import { STORE_META_KEYS } from './profile-records.js';
import { ControlStoreError, toControlStoreError } from './store-errors.js';
import type { SqliteConnection } from './sqlite-module.js';
import { withWriteTransaction } from './transaction.js';

/** 移行の値を書く関数に渡す文脈。 */
export interface ControlMigrationContext {
  /** この移行を行った日時（UTC の 14 桁。`formatCompactUtcTimestamp`）。 */
  readonly appliedAt: string;
  /** 走らせている版の一覧の最新の版。 */
  readonly latestVersion: number;
}

/**
 * 版 1 つ分の移行。`statements` は DDL などの SQL（トランザクションの文と `user_version`・`application_id` は書かない。走らせる側が持つ）。
 * `seed` は、DDL の後に、同じトランザクションの中で初めの値を書く（任意）。
 */
export interface ControlMigration {
  readonly version: number;
  readonly statements: readonly string[];
  readonly seed?: (connection: SqliteConnection, context: ControlMigrationContext) => void;
}

/** 閉じた一覧の値を、SQL の `IN (…)` の中身にする（値は一覧の定数だけ。大文字と `_` だけなので、引用の中に引用符は入らない）。 */
const sqlListOf = (values: readonly string[]): string => values.map((value) => `'${value}'`).join(', ');

/** UTC の 14 桁の日時の列の CHECK（`formatCompactUtcTimestamp` の形）。 */
const compactUtcTimestampCheck = (column: string): string =>
  `length(${column}) = ${COMPACT_UTC_TIMESTAMP_LENGTH} AND ${column} NOT GLOB '*[^0-9]*'`;

/** 改訂の番号の最小値（Task 22 の `MIN_PROFILE_REVISION` と同じ。表の CHECK に使う）。 */
const MIN_STORED_REVISION = MIN_PROFILE_REVISION;

// ---------------------------------------------------------------------------------------------------------------
// 公開した時点の値の一覧の写し（T26c）。公開済みの版の文は、ここだけを参照する（名前つきの一覧は参照しない）。
// 今の名前つきの一覧が、この写しで始まることは、テスト（`tests/integration/control-store-v4.test.ts`。版 4 の写しは `control-store-v5.test.ts`、
// 版 5 の写しは `control-store-v6.test.ts`）で確かめる。
// ---------------------------------------------------------------------------------------------------------------

/** 版 1 を公開した時点の `PROFILE_STATUSES`（`profiles.status`）。 */
const VERSION_1_PROFILE_STATUSES: readonly string[] = Object.freeze(['ACTIVE', 'RETIRED']);
/** 版 1 を公開した時点の `PROFILE_CHANGE_KINDS`（`profile_revisions.change_kind`）。 */
const VERSION_1_PROFILE_CHANGE_KINDS: readonly string[] = Object.freeze(['CREATED', 'UPDATED', 'RETIRED']);
/** 版 2 と版 3 を公開した時点の `AUDIT_JOB_STATES`（`jobs.state`。版 2 と版 3 で同じ）。 */
const VERSION_3_AUDIT_JOB_STATES: readonly string[] = Object.freeze(['STARTING', 'RUNNING', 'STOPPING', 'FINISHED', 'FAILED', 'INTERRUPTED']);
/** 版 2 と版 3 を公開した時点の `ACTIVE_AUDIT_JOB_STATES`（一意の部分索引）。 */
const VERSION_3_ACTIVE_AUDIT_JOB_STATES: readonly string[] = Object.freeze(['STARTING', 'RUNNING', 'STOPPING']);
/** 版 2 と版 3 を公開した時点の `FINAL_AUDIT_JOB_STATES`。 */
const VERSION_3_FINAL_AUDIT_JOB_STATES: readonly string[] = Object.freeze(['FINISHED', 'FAILED', 'INTERRUPTED']);
/** 版 2 と版 3 を公開した時点の `AUDIT_JOB_STATES_WITH_REASON`。 */
const VERSION_3_AUDIT_JOB_STATES_WITH_REASON: readonly string[] = Object.freeze(['FAILED', 'INTERRUPTED']);
/** 版 2 と版 3 を公開した時点の `RUN_STATUSES`（`jobs.run_status`）。 */
const VERSION_3_RUN_STATUSES: readonly string[] = Object.freeze(['COMPLETE', 'PARTIAL', 'FAILED', 'ABORTED_BY_SAFETY']);
/** 版 2 と版 3 を公開した時点の `WORKER_OUTCOME_KINDS`（`jobs.end_kind`）。 */
const VERSION_3_WORKER_OUTCOME_KINDS: readonly string[] = Object.freeze([
  'RAN', 'RUN_ACTIVE', 'VERSION_MISMATCH', 'RUN_DIRECTORY_UNAVAILABLE', 'RESUME_UNAVAILABLE',
]);
/** 版 3 を公開した時点の `AUDIT_JOB_FAILURE_REASONS`（T25d の認証の理由を含み、T26c の自動ログインの結果を含まない）。 */
const VERSION_3_AUDIT_JOB_FAILURE_REASONS: readonly string[] = Object.freeze([
  'CONFIG_ERROR',
  'ARTIFACT_WRITE_FAILED',
  'UNEXPECTED_FAILURE',
  'PROTOCOL_VIOLATION',
  'START_TIMEOUT',
  'CONFIG_CHANGED',
  'AUTH_SETUP_CHANGED',
  'AUTH_SETUP_REQUIRED',
  'UNSUPPORTED_AUTH_STATE',
  'LOGIN_TIMEOUT',
  'LOGIN_ATTEMPTS_EXCEEDED',
  'WORKER_START_FAILED',
  'WORKER_NOT_READY',
  'WORKER_EXITED',
  'WORKER_UNRESPONSIVE',
  'STOP_TIMEOUT',
  'SERVER_RESTARTED',
  'SERVER_SHUTDOWN',
]);
/** 版 3 を公開した時点の `WORKER_AUTH_STATES`（`jobs.last_auth_state`）。 */
const VERSION_3_WORKER_AUTH_STATES: readonly string[] = Object.freeze([
  'AWAITING_LOGIN',
  'AUTHENTICATED',
  'AUTH_SETUP_REQUIRED',
  'UNSUPPORTED_AUTH_STATE',
  'SESSION_LOST',
  'LOGIN_TIMEOUT',
  'LOGIN_ATTEMPTS_EXCEEDED',
]);

/** 版 4 を公開した時点の `AUTOMATED_LOGIN_FAILURE_RESULTS`（`auto_login_holds.reason`。T27c で固定）。 */
const VERSION_4_AUTOMATED_LOGIN_FAILURE_RESULTS: readonly string[] = Object.freeze([
  'INVALID_CREDENTIALS',
  'ACCOUNT_LOCKED',
  'MFA_REQUIRED',
  'CREDENTIAL_EXPIRED',
  'RATE_LIMITED',
  'AUTH_RESULT_UNKNOWN',
  'LOGIN_FORM_INVALID',
  'LOGIN_FORM_INPUT_FAILED',
  'CREDENTIAL_CHANGED',
  'CREDENTIAL_UNAVAILABLE',
  'UNEXPECTED_LOGIN_REQUEST',
]);
/** 版 4 を公開した時点の `AUTOMATED_LOGIN_SUCCEEDED`（成功の結果）。 */
const VERSION_4_AUTOMATED_LOGIN_SUCCEEDED = 'SUCCEEDED';
/** 版 4 を公開した時点の `AUTOMATED_LOGIN_RESULTS`（`auto_login_attempts.result`。成功と、成功以外の結果）。 */
const VERSION_4_AUTOMATED_LOGIN_RESULTS: readonly string[] = Object.freeze([
  VERSION_4_AUTOMATED_LOGIN_SUCCEEDED,
  ...VERSION_4_AUTOMATED_LOGIN_FAILURE_RESULTS,
]);
/** 版 4 を公開した時点の `AUTOMATED_LOGIN_SUBMISSION_SENT`（送った）。 */
const VERSION_4_AUTOMATED_LOGIN_SUBMISSION_SENT = 'YES';
/** 版 4 を公開した時点の `AUTOMATED_LOGIN_SUBMISSIONS`（`auto_login_attempts.submitted`）。 */
const VERSION_4_AUTOMATED_LOGIN_SUBMISSIONS: readonly string[] = Object.freeze([VERSION_4_AUTOMATED_LOGIN_SUBMISSION_SENT, 'NO', 'UNKNOWN']);
/** 版 4 を公開した時点の `AUTOMATED_LOGIN_RATE_LIMITED_RESULT`（`Retry-After` の期限を持てる結果）。 */
const VERSION_4_AUTOMATED_LOGIN_RATE_LIMITED_RESULT = 'RATE_LIMITED';
/** 版 4 を公開した時点の `WORKER_LOGIN_FORM_INVALID_RESULT`（フォームの確かめの理由のコードを持てる結果）。 */
const VERSION_4_WORKER_LOGIN_FORM_INVALID_RESULT = 'LOGIN_FORM_INVALID';
/** 版 4 を公開した時点の `WORKER_LOGIN_FORM_INVALID_REASONS`（`auto_login_attempts.form_invalid_reason`）。 */
const VERSION_4_WORKER_LOGIN_FORM_INVALID_REASONS: readonly string[] = Object.freeze([
  'SELECTOR_NOT_UNIQUE',
  'USERNAME_FIELD_INVALID',
  'PASSWORD_FIELD_INVALID',
  'SUBMIT_BUTTON_INVALID',
  'NOT_SAME_FORM',
  'METHOD_NOT_POST',
  'ACTION_NOT_ALLOWED',
  'FORM_TARGET_NOT_SELF',
  'FORM_UNREADABLE',
]);
/** 版 4 を公開した時点の `AUDIT_JOB_FAILURE_REASONS`（版 3 の一覧の後ろに、自動ログインの成功以外の結果。T27c の理由を含まない）。 */
const VERSION_4_AUDIT_JOB_FAILURE_REASONS: readonly string[] = Object.freeze([
  ...VERSION_3_AUDIT_JOB_FAILURE_REASONS,
  ...VERSION_4_AUTOMATED_LOGIN_FAILURE_RESULTS,
]);
/** 版 4 を公開した時点の `WORKER_AUTH_STATES`（`jobs.last_auth_state`。版 3 の一覧の後ろに、自動ログインの失敗）。 */
const VERSION_4_WORKER_AUTH_STATES: readonly string[] = Object.freeze([...VERSION_3_WORKER_AUTH_STATES, 'AUTOMATED_LOGIN_FAILED']);
/** 版 4 を公開した時点の `AUDIT_JOB_KINDS`（`jobs.job_kind`。T27c の種類を含まない）。 */
const VERSION_4_AUDIT_JOB_KINDS: readonly string[] = Object.freeze(['AUDIT', 'LOGIN_CHECK']);
/** 版 4 を公開した時点の `CREDENTIAL_EVENT_KINDS`（`credential_events.kind`）。 */
const VERSION_4_CREDENTIAL_EVENT_KINDS: readonly string[] = Object.freeze([
  'CREATED',
  'USERNAME_CHANGED',
  'PASSWORD_CHANGED',
  'BOTH_CHANGED',
  'DELETED',
  'HOLD_CLEARED',
]);

/** 版 5 を公開した時点の `AUDIT_JOB_STATES`（`jobs.state`。T28c で固定。版 2〜4 と同じ値）。 */
const VERSION_5_AUDIT_JOB_STATES: readonly string[] = VERSION_3_AUDIT_JOB_STATES;
/** 版 5 を公開した時点の `ACTIVE_AUDIT_JOB_STATES`（一意の部分索引）。 */
const VERSION_5_ACTIVE_AUDIT_JOB_STATES: readonly string[] = VERSION_3_ACTIVE_AUDIT_JOB_STATES;
/** 版 5 を公開した時点の `FINAL_AUDIT_JOB_STATES`。 */
const VERSION_5_FINAL_AUDIT_JOB_STATES: readonly string[] = VERSION_3_FINAL_AUDIT_JOB_STATES;
/** 版 5 を公開した時点の `AUDIT_JOB_STATES_WITH_REASON`。 */
const VERSION_5_AUDIT_JOB_STATES_WITH_REASON: readonly string[] = VERSION_3_AUDIT_JOB_STATES_WITH_REASON;
/** 版 5 を公開した時点の `RUN_STATUSES`（`jobs.run_status`）。 */
const VERSION_5_RUN_STATUSES: readonly string[] = VERSION_3_RUN_STATUSES;
/** 版 5 を公開した時点の `WORKER_OUTCOME_KINDS`（`jobs.end_kind`）。 */
const VERSION_5_WORKER_OUTCOME_KINDS: readonly string[] = VERSION_3_WORKER_OUTCOME_KINDS;
/** 版 5 を公開した時点の `AUDIT_JOB_FAILURE_REASONS`（版 4 の一覧の後ろに、Task 27 の理由）。 */
const VERSION_5_AUDIT_JOB_FAILURE_REASONS: readonly string[] = Object.freeze([
  ...VERSION_4_AUDIT_JOB_FAILURE_REASONS,
  'JOB_KIND_NOT_SUPPORTED',
  'DISCOVERY_RESULT_INVALID',
  'READ_CHECK_RESULT_INVALID',
]);
/** 版 5 を公開した時点の `WORKER_AUTH_STATES`（`jobs.last_auth_state`。版 4 と同じ値）。 */
const VERSION_5_WORKER_AUTH_STATES: readonly string[] = VERSION_4_WORKER_AUTH_STATES;
/** 版 5 を公開した時点の `AUDIT_JOB_KINDS`（`jobs.job_kind`。版 4 の一覧の後ろに、Task 27 の種類）。 */
const VERSION_5_AUDIT_JOB_KINDS: readonly string[] = Object.freeze([...VERSION_4_AUDIT_JOB_KINDS, 'DISCOVERY', 'READ_CHECK']);
/** 版 5 を公開した時点の `CANDIDATE_CLASSIFICATIONS`（`discovery_candidates.classification`）。 */
const VERSION_5_CANDIDATE_CLASSIFICATIONS: readonly string[] = Object.freeze([
  'READ',
  'CREATE',
  'UPDATE',
  'NOT_EXECUTABLE',
  'NEEDS_BINDING',
  'UNSUPPORTED_READ_TRANSPORT',
  'BLOCKED_EXTERNAL',
  'DISPLAY_ONLY',
]);
/**
 * 版 5 を公開した時点の `CANDIDATE_REASON_CODES` と `CANDIDATE_REASON_CLASSIFICATIONS`（`discovery_candidates.reason_code` と、理由のコードと分類の
 * 組み合わせの CHECK。`[理由のコード, 分類]` の組の、理由のコードの一覧の順）。
 */
const VERSION_5_CANDIDATE_REASON_CLASSIFICATIONS: readonly (readonly [string, string])[] = Object.freeze([
  ['ACTION_OUTSIDE_ALLOWED_ORIGINS', 'BLOCKED_EXTERNAL'],
  ['DESTRUCTIVE', 'NOT_EXECUTABLE'],
  ['READ_GET_FORM', 'READ'],
  ['GET_WITH_PASSWORD_FIELD', 'UNSUPPORTED_READ_TRANSPORT'],
  ['GET_WITH_MULTIPART', 'UNSUPPORTED_READ_TRANSPORT'],
  ['POST_SEARCH', 'UNSUPPORTED_READ_TRANSPORT'],
  ['GRAPHQL_ENDPOINT', 'UNSUPPORTED_READ_TRANSPORT'],
  ['JS_BOUND', 'NEEDS_BINDING'],
  ['JS_DELEGATED', 'NEEDS_BINDING'],
  ['NO_KNOWN_ACTION', 'DISPLAY_ONLY'],
  ['DIALOG_METHOD', 'DISPLAY_ONLY'],
  ['METHOD_OVERRIDE_UNRECOGNIZED', 'DISPLAY_ONLY'],
  ['UPDATE_METHOD', 'UPDATE'],
  ['UPDATE_WORD', 'UPDATE'],
  ['CREATE_WORD', 'CREATE'],
  ['UNCLASSIFIED', 'DISPLAY_ONLY'],
  ['DUPLICATE_IDENTITY_CONFLICT', 'DISPLAY_ONLY'],
] as const);
/** 版 5 を公開した時点の `CANDIDATE_REASON_CODES`（組の一覧から）。 */
const VERSION_5_CANDIDATE_REASON_CODES: readonly string[] = Object.freeze(VERSION_5_CANDIDATE_REASON_CLASSIFICATIONS.map(([code]) => code));
/** 版 5 を公開した時点の `FORM_METHODS`（`discovery_candidates.form_method`）。 */
const VERSION_5_FORM_METHODS: readonly string[] = Object.freeze(['GET', 'POST', 'DIALOG']);
/** 版 5 を公開した時点の `METHOD_OVERRIDE_VALUES`（`discovery_candidates.method_override`）。 */
const VERSION_5_METHOD_OVERRIDE_VALUES: readonly string[] = Object.freeze(['PUT', 'PATCH', 'DELETE']);
/** 版 5 を公開した時点の `READ_CHECK_RESULTS`（`read_check_results.result`）。 */
const VERSION_5_READ_CHECK_RESULTS: readonly string[] = Object.freeze([
  'MATCHED',
  'NOT_MATCHED',
  'UNDETERMINED',
  'READ_BLOCKED_BY_POLICY',
  'READ_CANDIDATE_DRIFTED',
  'READ_CANDIDATE_NOT_READ',
]);
/** 版 5 を公開した時点の `MAX_DISCOVERY_READ_PAGE_PATHS`（`discovery_jobs.read_page_paths` の件数の上限）。 */
const VERSION_5_MAX_DISCOVERY_READ_PAGE_PATHS = 10_000;
/** 版 5 を公開した時点の `MAX_CANDIDATE_URL_PART_LENGTH`（画面と送信先の path の長さの上限）。 */
const VERSION_5_MAX_CANDIDATE_URL_PART_LENGTH = 2_048;

/** 版 1 の表（設計書 4.3）。すべて `STRICT`。 */
const VERSION_1_STATEMENTS: readonly string[] = Object.freeze([
  `CREATE TABLE profiles (
    profile_id TEXT PRIMARY KEY NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= ${MIN_STORED_REVISION}),
    status TEXT NOT NULL CHECK (status IN (${sqlListOf(VERSION_1_PROFILE_STATUSES)})),
    document TEXT NOT NULL CHECK (json_valid(document)),
    updated_at TEXT NOT NULL CHECK (${compactUtcTimestampCheck('updated_at')})
  ) STRICT`,
  `CREATE TABLE profile_revisions (
    profile_id TEXT NOT NULL REFERENCES profiles (profile_id),
    revision INTEGER NOT NULL CHECK (revision >= ${MIN_STORED_REVISION}),
    document TEXT NOT NULL CHECK (json_valid(document)),
    change_kind TEXT NOT NULL CHECK (change_kind IN (${sqlListOf(VERSION_1_PROFILE_CHANGE_KINDS)})),
    recorded_at TEXT NOT NULL CHECK (${compactUtcTimestampCheck('recorded_at')}),
    PRIMARY KEY (profile_id, revision)
  ) STRICT`,
  `CREATE TABLE store_meta (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  ) STRICT`,
]);

/** 版 1 の初めの値: 作ったときの版と日時（診断用）。 */
const seedVersion1 = (connection: SqliteConnection, context: ControlMigrationContext): void => {
  const insert = connection.prepare('INSERT INTO store_meta (key, value) VALUES (?, ?)');
  insert.run(STORE_META_KEYS.createdSchemaVersion, String(context.latestVersion));
  insert.run(STORE_META_KEYS.createdAt, context.appliedAt);
};

/** 版 2〜4 の、終わっていないジョブの状態の `IN (…)`（一意の部分索引。公開した時点の写し。版 2〜4 で同じ値）。 */
const VERSION_3_ACTIVE_JOB_STATES_SQL = sqlListOf(VERSION_3_ACTIVE_AUDIT_JOB_STATES);

/** 版 5 の、終わっていないジョブの状態の `IN (…)`（一意の部分索引。版 5 を公開した時点の写し。T28c）。 */
const VERSION_5_ACTIVE_JOB_STATES_SQL = sqlListOf(VERSION_5_ACTIVE_AUDIT_JOB_STATES);

/** 値を持たないか、UTC の 14 桁の日時の列の CHECK。 */
const optionalTimestampCheck = (column: string): string => `${column} IS NULL OR (${compactUtcTimestampCheck(column)})`;

/**
 * 版 2 の `jobs.failure_reason` の CHECK の値（T25d）。版 2 を公開した時点の `AUDIT_JOB_FAILURE_REASONS` の写しで、版 2 の中身を変えないために
 * 固定する（後から足した理由、たとえば T25d の認証の理由は含めない）。今の一覧の CHECK は、版 3 でジョブの表を作り直して入れる。
 */
const VERSION_2_AUDIT_JOB_FAILURE_REASONS: readonly string[] = Object.freeze([
  'CONFIG_ERROR',
  'ARTIFACT_WRITE_FAILED',
  'UNEXPECTED_FAILURE',
  'PROTOCOL_VIOLATION',
  'START_TIMEOUT',
  'CONFIG_CHANGED',
  'WORKER_START_FAILED',
  'WORKER_NOT_READY',
  'WORKER_EXITED',
  'WORKER_UNRESPONSIVE',
  'STOP_TIMEOUT',
  'SERVER_RESTARTED',
  'SERVER_SHUTDOWN',
]);

/**
 * 版 2 の表（Task 24 の設計書 4.4。T24e）: 監査のジョブ。`STRICT`。版 1 は公開済みなので変えない。
 * - 状態・理由・結果の種類・Run の状態の一覧は、名前つきの一覧（`job-records.ts`、`worker-protocol.ts`、`RUN_STATUSES`）を版 2 を公開した
 *   時点で写したもの（`VERSION_3_…`。版 2 と版 3 で同じ値。T26c）から組み立てる。
 * - 終わっていないジョブ（`ACTIVE_AUDIT_JOB_STATES`）は、全体で 1 行まで（一意の部分索引。同時に 1 つのジョブの、最後の守り）。
 * - 終わりの状態だけが `finished_at` を持ち、`FAILED` と `INTERRUPTED` だけが理由を持つ。
 * - 形の細かい確かめ（ジョブの ID の形、Run の ID の形、進み具合の JSON の形）は、書く前と読んだ後にジョブの管理が契約の部品で行う。
 */
const VERSION_2_STATEMENTS: readonly string[] = Object.freeze([
  `CREATE TABLE jobs (
    job_id TEXT PRIMARY KEY NOT NULL CHECK (length(job_id) > 0 AND job_id NOT GLOB '*[^a-z0-9-]*'),
    profile_id TEXT NOT NULL REFERENCES profiles (profile_id),
    profile_revision INTEGER NOT NULL CHECK (profile_revision >= ${MIN_STORED_REVISION}),
    state TEXT NOT NULL CHECK (state IN (${sqlListOf(VERSION_3_AUDIT_JOB_STATES)})),
    start_new INTEGER NOT NULL CHECK (start_new IN (0, 1)),
    run_id TEXT CHECK (run_id IS NULL OR length(run_id) > 0),
    run_directory TEXT CHECK (run_directory IS NULL OR length(run_directory) BETWEEN 1 AND ${MAX_WORKER_MESSAGE_PATH_LENGTH}),
    exit_code INTEGER CHECK (exit_code IS NULL OR exit_code BETWEEN 0 AND ${MAX_WORKER_EXIT_CODE}),
    run_status TEXT CHECK (run_status IS NULL OR run_status IN (${sqlListOf(VERSION_3_RUN_STATUSES)})),
    end_kind TEXT CHECK (end_kind IS NULL OR end_kind IN (${sqlListOf(VERSION_3_WORKER_OUTCOME_KINDS)})),
    last_progress TEXT CHECK (last_progress IS NULL OR json_valid(last_progress)),
    last_notice TEXT CHECK (last_notice IS NULL OR json_valid(last_notice)),
    worker_pid INTEGER CHECK (worker_pid IS NULL OR worker_pid > 0),
    created_at TEXT NOT NULL CHECK (${compactUtcTimestampCheck('created_at')}),
    started_at TEXT CHECK (${optionalTimestampCheck('started_at')}),
    finished_at TEXT CHECK (${optionalTimestampCheck('finished_at')}),
    last_heartbeat_at TEXT CHECK (${optionalTimestampCheck('last_heartbeat_at')}),
    stop_requested_at TEXT CHECK (${optionalTimestampCheck('stop_requested_at')}),
    failure_reason TEXT CHECK (failure_reason IS NULL OR failure_reason IN (${sqlListOf(VERSION_2_AUDIT_JOB_FAILURE_REASONS)})),
    CHECK ((state IN (${sqlListOf(VERSION_3_FINAL_AUDIT_JOB_STATES)})) = (finished_at IS NOT NULL)),
    CHECK ((state IN (${sqlListOf(VERSION_3_AUDIT_JOB_STATES_WITH_REASON)})) = (failure_reason IS NOT NULL))
  ) STRICT`,
  `CREATE UNIQUE INDEX jobs_single_active ON jobs ((state IN (${VERSION_3_ACTIVE_JOB_STATES_SQL}))) WHERE state IN (${VERSION_3_ACTIVE_JOB_STATES_SQL})`,
  'CREATE INDEX jobs_created_at ON jobs (created_at)',
  // 管理のロック（画面のサーバを 1 つだけにする。独立レビュー T24R の C1、DEF-061。T24h-4）。1 行だけ（`slot` は決まった値）。中身は Run の
  // ロック（`src/core/process-lock.ts` の `RunLock`）と同じ項目と、分かれば持ち主の port。読み・判定・置き換え・消すは、どれもジョブの管理の
  // 部品（`src/control/job/instance-lock.ts`）が `withWriteTransaction` の中で行う（取り直しは原子的）。版 2 は未公開なので、版 2 に足した。
  `CREATE TABLE control_instance (
    slot INTEGER PRIMARY KEY NOT NULL CHECK (slot = ${CONTROL_INSTANCE_SLOT}),
    process_id INTEGER NOT NULL CHECK (process_id > 0),
    booted_at_ms INTEGER NOT NULL CHECK (booted_at_ms >= 0),
    acquired_at_ms INTEGER NOT NULL CHECK (acquired_at_ms >= 0),
    heartbeat_at_ms INTEGER NOT NULL CHECK (heartbeat_at_ms >= 0),
    port INTEGER CHECK (port IS NULL OR port BETWEEN ${MIN_CONTROL_INSTANCE_PORT} AND ${MAX_CONTROL_INSTANCE_PORT})
  ) STRICT`,
]);

/** 版 2 のジョブの表の列（版 3 の作り直しで、行を写す列）。 */
const VERSION_2_JOB_COLUMNS = [
  'job_id', 'profile_id', 'profile_revision', 'state', 'start_new', 'run_id', 'run_directory', 'exit_code', 'run_status', 'end_kind',
  'last_progress', 'last_notice', 'worker_pid', 'created_at', 'started_at', 'finished_at', 'last_heartbeat_at', 'stop_requested_at',
  'failure_reason',
].join(', ');

/**
 * 版 3 の表（Task 25 の設計書 4.1 の「保存」。T25a）: 認証の設定の文書。プロファイルごとに 1 行。`STRICT`。表は文書の版を問わない
 * （`json_valid` だけ）。Task 25 で保存した行は版 1（`beaksight-auth-setup/1`）で、Task 26 の T26b からは版 2（`beaksight-auth-setup/2`）で
 * 書く。版 1 の行は、読むときに保存の部品が版 2 に直す（書き換えない）。
 * 版 1 と版 2 は公開済みなので変えない。文書の形の細かい確かめ（スキーマ、行との一致）と、保存の前の検証（`validateAuthSetup`）は、
 * 保存の部品（`auth-setup-store.ts`）が行う。秘密（Cookie、localStorage、パスワード）は、この表に置かない（設計書 3 章）。
 * あわせて、ジョブの表を作り直す（T25d。下の説明）。秘密は、ジョブの表にも置かない（認証の状態は値を含まない）。
 */
const VERSION_3_STATEMENTS: readonly string[] = Object.freeze([
  `CREATE TABLE auth_setups (
    profile_id TEXT PRIMARY KEY NOT NULL REFERENCES profiles (profile_id),
    profile_revision INTEGER NOT NULL CHECK (profile_revision >= ${MIN_STORED_REVISION}),
    document TEXT NOT NULL CHECK (json_valid(document)),
    updated_at TEXT NOT NULL CHECK (${compactUtcTimestampCheck('updated_at')})
  ) STRICT`,
  // T25d（Task 25 の設計書の変更履歴の 2026-10-10 の T25d の Blocker の行の (4)）: ジョブの表を作り直す。SQLite は CHECK を ALTER で変えられない
  // ので、新しい表を作り、行を写し、古い表を消して名前を戻し、索引を作り直す。新しい表は、`failure_reason` の CHECK を今の一覧
  // （`AUDIT_JOB_FAILURE_REASONS`。認証の理由を含む）にし、最後の認証の状態（`last_auth_state`。値なし）と、セッションが切れて止まった
  // ページの URL（`session_lost_url`。Ledger の URL と同じ伏せ字の後の値）の列を足す。ほかの列と CHECK は版 2 と同じ。
  // T26c: 版 3 は公開済みなので、CHECK と索引の値の一覧は、版 3 を公開した時点の写し（`VERSION_3_…`）で固定した（生成される文は同じ）。
  `CREATE TABLE jobs_v3 (
    job_id TEXT PRIMARY KEY NOT NULL CHECK (length(job_id) > 0 AND job_id NOT GLOB '*[^a-z0-9-]*'),
    profile_id TEXT NOT NULL REFERENCES profiles (profile_id),
    profile_revision INTEGER NOT NULL CHECK (profile_revision >= ${MIN_STORED_REVISION}),
    state TEXT NOT NULL CHECK (state IN (${sqlListOf(VERSION_3_AUDIT_JOB_STATES)})),
    start_new INTEGER NOT NULL CHECK (start_new IN (0, 1)),
    run_id TEXT CHECK (run_id IS NULL OR length(run_id) > 0),
    run_directory TEXT CHECK (run_directory IS NULL OR length(run_directory) BETWEEN 1 AND ${MAX_WORKER_MESSAGE_PATH_LENGTH}),
    exit_code INTEGER CHECK (exit_code IS NULL OR exit_code BETWEEN 0 AND ${MAX_WORKER_EXIT_CODE}),
    run_status TEXT CHECK (run_status IS NULL OR run_status IN (${sqlListOf(VERSION_3_RUN_STATUSES)})),
    end_kind TEXT CHECK (end_kind IS NULL OR end_kind IN (${sqlListOf(VERSION_3_WORKER_OUTCOME_KINDS)})),
    last_progress TEXT CHECK (last_progress IS NULL OR json_valid(last_progress)),
    last_notice TEXT CHECK (last_notice IS NULL OR json_valid(last_notice)),
    worker_pid INTEGER CHECK (worker_pid IS NULL OR worker_pid > 0),
    created_at TEXT NOT NULL CHECK (${compactUtcTimestampCheck('created_at')}),
    started_at TEXT CHECK (${optionalTimestampCheck('started_at')}),
    finished_at TEXT CHECK (${optionalTimestampCheck('finished_at')}),
    last_heartbeat_at TEXT CHECK (${optionalTimestampCheck('last_heartbeat_at')}),
    stop_requested_at TEXT CHECK (${optionalTimestampCheck('stop_requested_at')}),
    failure_reason TEXT CHECK (failure_reason IS NULL OR failure_reason IN (${sqlListOf(VERSION_3_AUDIT_JOB_FAILURE_REASONS)})),
    last_auth_state TEXT CHECK (last_auth_state IS NULL OR last_auth_state IN (${sqlListOf(VERSION_3_WORKER_AUTH_STATES)})),
    session_lost_url TEXT CHECK (session_lost_url IS NULL OR length(session_lost_url) BETWEEN 1 AND ${MAX_WORKER_NOTICE_URL_LENGTH}),
    CHECK ((state IN (${sqlListOf(VERSION_3_FINAL_AUDIT_JOB_STATES)})) = (finished_at IS NOT NULL)),
    CHECK ((state IN (${sqlListOf(VERSION_3_AUDIT_JOB_STATES_WITH_REASON)})) = (failure_reason IS NOT NULL))
  ) STRICT`,
  `INSERT INTO jobs_v3 (${VERSION_2_JOB_COLUMNS}) SELECT ${VERSION_2_JOB_COLUMNS} FROM jobs`,
  'DROP TABLE jobs',
  'ALTER TABLE jobs_v3 RENAME TO jobs',
  `CREATE UNIQUE INDEX jobs_single_active ON jobs ((state IN (${VERSION_3_ACTIVE_JOB_STATES_SQL}))) WHERE state IN (${VERSION_3_ACTIVE_JOB_STATES_SQL})`,
  'CREATE INDEX jobs_created_at ON jobs (created_at)',
]);

/** 版 3 のジョブの表の列（版 4 の作り直しで、行を写す列）。 */
const VERSION_3_JOB_COLUMNS = `${VERSION_2_JOB_COLUMNS}, last_auth_state, session_lost_url`;

/** 版 4 の作り直しで、版 3 までのジョブの行に付ける種類（版 3 までのジョブは、すべて監査。版 4 を公開した時点の写し）。 */
const VERSION_3_JOB_KIND = 'AUDIT';

/** ジョブの ID の形の CHECK（`jobs.job_id` と同じ。小文字の英数字とハイフン）。 */
const jobIdCheck = (column: string): string => `length(${column}) > 0 AND ${column} NOT GLOB '*[^a-z0-9-]*'`;

/** 資格情報の改訂の番号の最小値（T26a の資格情報のファイルの `credentialRevision` は 1 から。プロファイルの改訂と同じ値）。 */
const MIN_STORED_CREDENTIAL_REVISION = MIN_STORED_REVISION;

/**
 * 版 4 の表（Task 26 の設計書 4.5 の「管理データの版 4」。T26c）。版 1〜3 は公開済みなので変えない。どの表も `STRICT`。
 * T27c: 版 4 は公開済みなので、CHECK と索引の値の一覧と 1 つの値の定数は、版 4 を公開した時点の写し（`VERSION_3_…`・`VERSION_4_…`）で固定した
 * （生成される文は、T27c の変更の前の `dist` の文とバイトで同じ。`tests/integration/control-store-v5.test.ts` の SHA-256）。
 * どの表も、資格情報の値・値のハッシュ・ユーザー名を持たない（資格情報の有無と改訂の番号の正は、資格情報のファイル。設計書 4.5）。
 * - ジョブの表を作り直す（版 3 と同じ手順）。`job_kind`（`AUDIT_JOB_KINDS`。NOT NULL、既定の値なし。作る側が必ず明示する）を足し、版 3 までの
 *   行は `AUDIT` で写す。`failure_reason` の CHECK は今の一覧（自動ログインの成功以外の結果を含む）。ほかの列と CHECK と索引は版 3 と同じ。
 * - `auto_login_attempts`: 自動ログインの試し（1 つのジョブで 1 つまで）。結果と送信したかは、どちらも `null`（未確定）か、どちらも値。
 *   `Retry-After` の期限は 429（`RATE_LIMITED`）のときだけ。成功は送ったときだけ。行を作るのはジョブの行を作る部品（`job-store.ts`）で、
 *   同じトランザクションの中。ジョブの表は版ごとに作り直すので、ジョブの表への外部キーは持たない（作り直しの `DROP TABLE` を妨げないため）。
 *   T26d-2（版 4 は未公開なので足した。設計書の変更履歴の「T26d-1 の報告」の行の (3)）: フォームの確かめの理由のコード（`form_invalid_reason`。
 *   null か閉じた一覧 `WORKER_LOGIN_FORM_INVALID_REASONS`。値を持てるのは `LOGIN_FORM_INVALID` のときだけ。秘密でない）。
 * - `auto_login_holds`: 自動ログインを止めた記録。1 つのプロファイルで、止めている（`cleared_at` が null の）行は 1 つまで（部分一意の索引）。
 * - `credential_events`: 資格情報の変更の記録（`CREDENTIAL_EVENT_KINDS`。改訂の番号は null 可）。
 */
const VERSION_4_STATEMENTS: readonly string[] = Object.freeze([
  `CREATE TABLE jobs_v4 (
    job_id TEXT PRIMARY KEY NOT NULL CHECK (${jobIdCheck('job_id')}),
    profile_id TEXT NOT NULL REFERENCES profiles (profile_id),
    profile_revision INTEGER NOT NULL CHECK (profile_revision >= ${MIN_STORED_REVISION}),
    state TEXT NOT NULL CHECK (state IN (${sqlListOf(VERSION_3_AUDIT_JOB_STATES)})),
    start_new INTEGER NOT NULL CHECK (start_new IN (0, 1)),
    run_id TEXT CHECK (run_id IS NULL OR length(run_id) > 0),
    run_directory TEXT CHECK (run_directory IS NULL OR length(run_directory) BETWEEN 1 AND ${MAX_WORKER_MESSAGE_PATH_LENGTH}),
    exit_code INTEGER CHECK (exit_code IS NULL OR exit_code BETWEEN 0 AND ${MAX_WORKER_EXIT_CODE}),
    run_status TEXT CHECK (run_status IS NULL OR run_status IN (${sqlListOf(VERSION_3_RUN_STATUSES)})),
    end_kind TEXT CHECK (end_kind IS NULL OR end_kind IN (${sqlListOf(VERSION_3_WORKER_OUTCOME_KINDS)})),
    last_progress TEXT CHECK (last_progress IS NULL OR json_valid(last_progress)),
    last_notice TEXT CHECK (last_notice IS NULL OR json_valid(last_notice)),
    worker_pid INTEGER CHECK (worker_pid IS NULL OR worker_pid > 0),
    created_at TEXT NOT NULL CHECK (${compactUtcTimestampCheck('created_at')}),
    started_at TEXT CHECK (${optionalTimestampCheck('started_at')}),
    finished_at TEXT CHECK (${optionalTimestampCheck('finished_at')}),
    last_heartbeat_at TEXT CHECK (${optionalTimestampCheck('last_heartbeat_at')}),
    stop_requested_at TEXT CHECK (${optionalTimestampCheck('stop_requested_at')}),
    failure_reason TEXT CHECK (failure_reason IS NULL OR failure_reason IN (${sqlListOf(VERSION_4_AUDIT_JOB_FAILURE_REASONS)})),
    last_auth_state TEXT CHECK (last_auth_state IS NULL OR last_auth_state IN (${sqlListOf(VERSION_4_WORKER_AUTH_STATES)})),
    session_lost_url TEXT CHECK (session_lost_url IS NULL OR length(session_lost_url) BETWEEN 1 AND ${MAX_WORKER_NOTICE_URL_LENGTH}),
    job_kind TEXT NOT NULL CHECK (job_kind IN (${sqlListOf(VERSION_4_AUDIT_JOB_KINDS)})),
    CHECK ((state IN (${sqlListOf(VERSION_3_FINAL_AUDIT_JOB_STATES)})) = (finished_at IS NOT NULL)),
    CHECK ((state IN (${sqlListOf(VERSION_3_AUDIT_JOB_STATES_WITH_REASON)})) = (failure_reason IS NOT NULL))
  ) STRICT`,
  `INSERT INTO jobs_v4 (${VERSION_3_JOB_COLUMNS}, job_kind) SELECT ${VERSION_3_JOB_COLUMNS}, '${VERSION_3_JOB_KIND}' FROM jobs`,
  'DROP TABLE jobs',
  'ALTER TABLE jobs_v4 RENAME TO jobs',
  `CREATE UNIQUE INDEX jobs_single_active ON jobs ((state IN (${VERSION_3_ACTIVE_JOB_STATES_SQL}))) WHERE state IN (${VERSION_3_ACTIVE_JOB_STATES_SQL})`,
  'CREATE INDEX jobs_created_at ON jobs (created_at)',
  `CREATE TABLE auto_login_attempts (
    attempt_id INTEGER PRIMARY KEY NOT NULL,
    profile_id TEXT NOT NULL REFERENCES profiles (profile_id),
    job_id TEXT NOT NULL UNIQUE CHECK (${jobIdCheck('job_id')}),
    started_at TEXT NOT NULL CHECK (${compactUtcTimestampCheck('started_at')}),
    credential_revision INTEGER NOT NULL CHECK (credential_revision >= ${MIN_STORED_CREDENTIAL_REVISION}),
    result TEXT CHECK (result IS NULL OR result IN (${sqlListOf(VERSION_4_AUTOMATED_LOGIN_RESULTS)})),
    submitted TEXT CHECK (submitted IS NULL OR submitted IN (${sqlListOf(VERSION_4_AUTOMATED_LOGIN_SUBMISSIONS)})),
    retry_after_until TEXT CHECK (${optionalTimestampCheck('retry_after_until')}),
    result_recorded_at TEXT CHECK (${optionalTimestampCheck('result_recorded_at')}),
    form_invalid_reason TEXT CHECK (form_invalid_reason IS NULL OR form_invalid_reason IN (${sqlListOf(VERSION_4_WORKER_LOGIN_FORM_INVALID_REASONS)})),
    CHECK (form_invalid_reason IS NULL OR result = '${VERSION_4_WORKER_LOGIN_FORM_INVALID_RESULT}'),
    CHECK ((result IS NULL) = (submitted IS NULL)),
    CHECK ((result IS NULL) = (result_recorded_at IS NULL)),
    CHECK (retry_after_until IS NULL OR result = '${VERSION_4_AUTOMATED_LOGIN_RATE_LIMITED_RESULT}'),
    CHECK (result IS NULL OR result <> '${VERSION_4_AUTOMATED_LOGIN_SUCCEEDED}' OR submitted = '${VERSION_4_AUTOMATED_LOGIN_SUBMISSION_SENT}')
  ) STRICT`,
  'CREATE INDEX auto_login_attempts_profile_started ON auto_login_attempts (profile_id, started_at)',
  `CREATE TABLE auto_login_holds (
    hold_id INTEGER PRIMARY KEY NOT NULL,
    profile_id TEXT NOT NULL REFERENCES profiles (profile_id),
    reason TEXT NOT NULL CHECK (reason IN (${sqlListOf(VERSION_4_AUTOMATED_LOGIN_FAILURE_RESULTS)})),
    held_at TEXT NOT NULL CHECK (${compactUtcTimestampCheck('held_at')}),
    attempt_id INTEGER NOT NULL CHECK (attempt_id > 0),
    cleared_at TEXT CHECK (${optionalTimestampCheck('cleared_at')})
  ) STRICT`,
  'CREATE UNIQUE INDEX auto_login_holds_single_active ON auto_login_holds (profile_id) WHERE cleared_at IS NULL',
  `CREATE TABLE credential_events (
    event_id INTEGER PRIMARY KEY NOT NULL,
    profile_id TEXT NOT NULL REFERENCES profiles (profile_id),
    recorded_at TEXT NOT NULL CHECK (${compactUtcTimestampCheck('recorded_at')}),
    kind TEXT NOT NULL CHECK (kind IN (${sqlListOf(VERSION_4_CREDENTIAL_EVENT_KINDS)})),
    credential_revision INTEGER CHECK (credential_revision IS NULL OR credential_revision >= ${MIN_STORED_CREDENTIAL_REVISION})
  ) STRICT`,
  'CREATE INDEX credential_events_profile_recorded ON credential_events (profile_id, recorded_at)',
]);

/** 版 4 のジョブの表の列（版 5 の作り直しで、行を写す列）。 */
const VERSION_4_JOB_COLUMNS = `${VERSION_3_JOB_COLUMNS}, job_kind`;

/** 指紋の例（`createSha256Fingerprint` の結果。`sha256:` と小文字の 16 進）。指紋の形の長さと前置きは、owner の関数の結果から求める。 */
const SAMPLE_FINGERPRINT = createSha256Fingerprint('');
/** 指紋の前置きと 16 進の区切り。 */
const FINGERPRINT_SEPARATOR = ':';
/** 指紋の前置き（`sha256:`）。 */
const FINGERPRINT_PREFIX = SAMPLE_FINGERPRINT.slice(0, SAMPLE_FINGERPRINT.indexOf(FINGERPRINT_SEPARATOR) + FINGERPRINT_SEPARATOR.length);

/** 指紋の形の CHECK（`sha256:<小文字の16進64桁>`。`isSha256Fingerprint` と同じ形）。 */
const fingerprintCheck = (column: string): string =>
  `length(${column}) = ${SAMPLE_FINGERPRINT.length} AND substr(${column}, 1, ${FINGERPRINT_PREFIX.length}) = '${FINGERPRINT_PREFIX}' `
  + `AND substr(${column}, ${FINGERPRINT_PREFIX.length + 1}) NOT GLOB '*[^0-9a-f]*'`;

/** path の始まり（`URL.pathname` の形）。 */
const PATH_START = '/';

/** 画面と送信先の path の CHECK（`/` で始まり、候補の契約の上限まで。版 5 を公開した時点の上限の写し）。 */
const candidatePathCheck = (column: string): string =>
  `length(${column}) BETWEEN 1 AND ${VERSION_5_MAX_CANDIDATE_URL_PART_LENGTH} AND substr(${column}, 1, ${PATH_START.length}) = '${PATH_START}'`;

/** 理由のコードと分類の組み合わせの CHECK（版 5 を公開した時点の `CANDIDATE_REASON_CLASSIFICATIONS` の写し。1 つのコードは 1 つの分類だけ）。 */
const reasonClassificationCheck = (): string =>
  `classification = CASE reason_code ${VERSION_5_CANDIDATE_REASON_CLASSIFICATIONS
    .map(([code, classification]) => `WHEN '${code}' THEN '${classification}'`).join(' ')} END`;

/** READ の確かめの定義の版の最小値（プロファイルの改訂と同じく 1 から）。 */
const MIN_STORED_READ_CHECK_REVISION = MIN_STORED_REVISION;

/**
 * 版 5 の表（Task 27 の設計書 4.6 の「管理データの版 5」。T27c）。版 1〜4 は公開済みなので変えない。どの表も `STRICT`。
 * T28c: 版 5 は公開済みなので、CHECK と索引の値の一覧と数値の上限は、版 5 を公開した時点の写し（`VERSION_3_…`〜`VERSION_5_…`）で固定した
 * （生成される文は、T28c の変更の前の `dist` の文とバイトで同じ。`tests/integration/control-store-v6.test.ts` の SHA-256）。
 * - ジョブの表を作り直す（版 3・4 と同じ手順）。`job_kind` の CHECK を今の一覧（`DISCOVERY`・`READ_CHECK` を含む）に、`failure_reason` の CHECK を
 *   今の一覧（`JOB_KIND_NOT_SUPPORTED` を含む）にする。行は、すべての列を今の値のまま写す。ほかの列と CHECK と索引は版 4 と同じ。
 * - `discovery_candidates`: 候補の索引（プロファイルと識別の digest で一意）。規則の digest、分類と理由のコード（組み合わせは
 *   `CANDIDATE_REASON_CLASSIFICATIONS`）、画面と送信先の path、form の method と `_method` の上書き（実際の method の判定は分類の owner
 *   `src/discovery/classify.ts` が持つので、ここでは 2 つの列のまま持つ）、状態の欄の印、最初に見た・最後に見たジョブと時刻、最後に変わった
 *   （規則の digest・分類・理由・状態の欄の印が前と違った）ジョブ。値・label・ボタンの文言・欄の名前は持たない。消えた候補は消さない（最後に
 *   見たジョブで分かる）。書き込みは `src/control/job/discovery-index-store.ts`。
 * - `discovery_jobs`（T27d。設計書の変更履歴「Blocker: T27d」の行の (2)）: 索引に記録した発見のジョブ（ジョブの ID が主キー。同じジョブの 2 回目の
 *   記録は主キーで拒む）、プロファイル、記録した時刻、そのジョブで読み切れた画面の path の一覧（JSON の配列。上限
 *   `MAX_DISCOVERY_READ_PAGE_PATHS`）。最後のジョブと、`MISSING`（読んだ画面にあって今回ない）と `NOT_REVISITED`（読まなかった画面）の区別は、
 *   この表で決める。候補が 0 件のジョブも、この表の行で分かる。ジョブの表は版ごとに作り直すので、ジョブの表への外部キーは持たない。書き込みは
 *   `src/control/job/discovery-index-store.ts`。
 * - `read_checks`: READ の確かめの定義（人が決める）。送る値（JSON の object。名前 → 値。テスト環境のテスト用の値を平文で持つ。設計書 4.5、
 *   10 章の 4）、期待（JSON の配列）、版（改訂の番号）、作った・変えた・取り消した時刻。取り消しても消さない。書き込みは
 *   `src/control/job/read-check-store.ts`。
 * - `read_check_results`: READ の確かめの結果（ジョブ、定義、定義の版、閉じた一覧の結果、時刻）。ジョブと定義の組で 1 行。ジョブの表は版ごとに
 *   作り直すので、ジョブの表への外部キーは持たない（`auto_login_attempts` と同じ）。
 */
const VERSION_5_STATEMENTS: readonly string[] = Object.freeze([
  `CREATE TABLE jobs_v5 (
    job_id TEXT PRIMARY KEY NOT NULL CHECK (${jobIdCheck('job_id')}),
    profile_id TEXT NOT NULL REFERENCES profiles (profile_id),
    profile_revision INTEGER NOT NULL CHECK (profile_revision >= ${MIN_STORED_REVISION}),
    state TEXT NOT NULL CHECK (state IN (${sqlListOf(VERSION_5_AUDIT_JOB_STATES)})),
    start_new INTEGER NOT NULL CHECK (start_new IN (0, 1)),
    run_id TEXT CHECK (run_id IS NULL OR length(run_id) > 0),
    run_directory TEXT CHECK (run_directory IS NULL OR length(run_directory) BETWEEN 1 AND ${MAX_WORKER_MESSAGE_PATH_LENGTH}),
    exit_code INTEGER CHECK (exit_code IS NULL OR exit_code BETWEEN 0 AND ${MAX_WORKER_EXIT_CODE}),
    run_status TEXT CHECK (run_status IS NULL OR run_status IN (${sqlListOf(VERSION_5_RUN_STATUSES)})),
    end_kind TEXT CHECK (end_kind IS NULL OR end_kind IN (${sqlListOf(VERSION_5_WORKER_OUTCOME_KINDS)})),
    last_progress TEXT CHECK (last_progress IS NULL OR json_valid(last_progress)),
    last_notice TEXT CHECK (last_notice IS NULL OR json_valid(last_notice)),
    worker_pid INTEGER CHECK (worker_pid IS NULL OR worker_pid > 0),
    created_at TEXT NOT NULL CHECK (${compactUtcTimestampCheck('created_at')}),
    started_at TEXT CHECK (${optionalTimestampCheck('started_at')}),
    finished_at TEXT CHECK (${optionalTimestampCheck('finished_at')}),
    last_heartbeat_at TEXT CHECK (${optionalTimestampCheck('last_heartbeat_at')}),
    stop_requested_at TEXT CHECK (${optionalTimestampCheck('stop_requested_at')}),
    failure_reason TEXT CHECK (failure_reason IS NULL OR failure_reason IN (${sqlListOf(VERSION_5_AUDIT_JOB_FAILURE_REASONS)})),
    last_auth_state TEXT CHECK (last_auth_state IS NULL OR last_auth_state IN (${sqlListOf(VERSION_5_WORKER_AUTH_STATES)})),
    session_lost_url TEXT CHECK (session_lost_url IS NULL OR length(session_lost_url) BETWEEN 1 AND ${MAX_WORKER_NOTICE_URL_LENGTH}),
    job_kind TEXT NOT NULL CHECK (job_kind IN (${sqlListOf(VERSION_5_AUDIT_JOB_KINDS)})),
    CHECK ((state IN (${sqlListOf(VERSION_5_FINAL_AUDIT_JOB_STATES)})) = (finished_at IS NOT NULL)),
    CHECK ((state IN (${sqlListOf(VERSION_5_AUDIT_JOB_STATES_WITH_REASON)})) = (failure_reason IS NOT NULL))
  ) STRICT`,
  `INSERT INTO jobs_v5 (${VERSION_4_JOB_COLUMNS}) SELECT ${VERSION_4_JOB_COLUMNS} FROM jobs`,
  'DROP TABLE jobs',
  'ALTER TABLE jobs_v5 RENAME TO jobs',
  `CREATE UNIQUE INDEX jobs_single_active ON jobs ((state IN (${VERSION_5_ACTIVE_JOB_STATES_SQL}))) WHERE state IN (${VERSION_5_ACTIVE_JOB_STATES_SQL})`,
  'CREATE INDEX jobs_created_at ON jobs (created_at)',
  `CREATE TABLE discovery_candidates (
    profile_id TEXT NOT NULL REFERENCES profiles (profile_id),
    identity_digest TEXT NOT NULL CHECK (${fingerprintCheck('identity_digest')}),
    rule_digest TEXT NOT NULL CHECK (${fingerprintCheck('rule_digest')}),
    classification TEXT NOT NULL CHECK (classification IN (${sqlListOf(VERSION_5_CANDIDATE_CLASSIFICATIONS)})),
    reason_code TEXT NOT NULL CHECK (reason_code IN (${sqlListOf(VERSION_5_CANDIDATE_REASON_CODES)})),
    page_path TEXT NOT NULL CHECK (${candidatePathCheck('page_path')}),
    action_path TEXT CHECK (action_path IS NULL OR (${candidatePathCheck('action_path')})),
    form_method TEXT CHECK (form_method IS NULL OR form_method IN (${sqlListOf(VERSION_5_FORM_METHODS)})),
    method_override TEXT CHECK (method_override IS NULL OR method_override IN (${sqlListOf(VERSION_5_METHOD_OVERRIDE_VALUES)})),
    has_state_field INTEGER NOT NULL CHECK (has_state_field IN (0, 1)),
    first_seen_job_id TEXT NOT NULL CHECK (${jobIdCheck('first_seen_job_id')}),
    first_seen_at TEXT NOT NULL CHECK (${compactUtcTimestampCheck('first_seen_at')}),
    last_seen_job_id TEXT NOT NULL CHECK (${jobIdCheck('last_seen_job_id')}),
    last_seen_at TEXT NOT NULL CHECK (${compactUtcTimestampCheck('last_seen_at')}),
    last_changed_job_id TEXT CHECK (last_changed_job_id IS NULL OR (${jobIdCheck('last_changed_job_id')})),
    PRIMARY KEY (profile_id, identity_digest),
    CHECK (${reasonClassificationCheck()}),
    CHECK ((action_path IS NULL) = (form_method IS NULL)),
    CHECK (method_override IS NULL OR form_method IS NOT NULL),
    CHECK (first_seen_at <= last_seen_at)
  ) STRICT`,
  'CREATE INDEX discovery_candidates_profile_last_seen ON discovery_candidates (profile_id, last_seen_at)',
  `CREATE TABLE discovery_jobs (
    job_id TEXT PRIMARY KEY NOT NULL CHECK (${jobIdCheck('job_id')}),
    profile_id TEXT NOT NULL REFERENCES profiles (profile_id),
    recorded_at TEXT NOT NULL CHECK (${compactUtcTimestampCheck('recorded_at')}),
    read_page_paths TEXT NOT NULL CHECK (json_valid(read_page_paths) AND json_type(read_page_paths) = 'array'
      AND json_array_length(read_page_paths) <= ${VERSION_5_MAX_DISCOVERY_READ_PAGE_PATHS})
  ) STRICT`,
  'CREATE INDEX discovery_jobs_profile_recorded ON discovery_jobs (profile_id, recorded_at)',
  `CREATE TABLE read_checks (
    read_check_id TEXT PRIMARY KEY NOT NULL CHECK (${jobIdCheck('read_check_id')}),
    profile_id TEXT NOT NULL REFERENCES profiles (profile_id),
    target_identity_digest TEXT NOT NULL CHECK (${fingerprintCheck('target_identity_digest')}),
    parameters TEXT NOT NULL CHECK (json_valid(parameters) AND json_type(parameters) = 'object'),
    expectations TEXT NOT NULL CHECK (json_valid(expectations) AND json_type(expectations) = 'array'),
    revision INTEGER NOT NULL CHECK (revision >= ${MIN_STORED_READ_CHECK_REVISION}),
    created_at TEXT NOT NULL CHECK (${compactUtcTimestampCheck('created_at')}),
    updated_at TEXT NOT NULL CHECK (${compactUtcTimestampCheck('updated_at')}),
    canceled_at TEXT CHECK (${optionalTimestampCheck('canceled_at')}),
    CHECK (created_at <= updated_at)
  ) STRICT`,
  'CREATE INDEX read_checks_profile_created ON read_checks (profile_id, created_at)',
  `CREATE TABLE read_check_results (
    result_id INTEGER PRIMARY KEY NOT NULL,
    job_id TEXT NOT NULL CHECK (${jobIdCheck('job_id')}),
    read_check_id TEXT NOT NULL REFERENCES read_checks (read_check_id),
    read_check_revision INTEGER NOT NULL CHECK (read_check_revision >= ${MIN_STORED_READ_CHECK_REVISION}),
    result TEXT NOT NULL CHECK (result IN (${sqlListOf(VERSION_5_READ_CHECK_RESULTS)})),
    recorded_at TEXT NOT NULL CHECK (${compactUtcTimestampCheck('recorded_at')}),
    UNIQUE (job_id, read_check_id)
  ) STRICT`,
  'CREATE INDEX read_check_results_check_recorded ON read_check_results (read_check_id, recorded_at)',
]);

// T29d: 版 6 は G28 で公開したので、版 6 の CHECK が参照する値の一覧と数値は、版 6 を公開した時点の写しで固定する（T28a の名前つきの一覧と
// 定数は参照しない。今の一覧がこの写しで始まることと、文の SHA-256 は `tests/integration/control-store-v7.test.ts` で確かめる）。
/** シナリオの状態（T28a の `SCENARIO_STATES` の、版 6 を公開した時点の写し）。 */
const VERSION_6_SCENARIO_STATES: readonly string[] = Object.freeze(['DRAFT', 'APPROVED', 'REVOKED']);
/** 承認の記録の種類（T28a の `APPROVAL_RECEIPT_KINDS` の写し）。 */
const VERSION_6_APPROVAL_RECEIPT_KINDS: readonly string[] = Object.freeze(['APPROVAL', 'REVOCATION']);
/** 件数の予約の状態（T28a の `WRITE_RESERVATION_STATES` の写し）。 */
const VERSION_6_WRITE_RESERVATION_STATES: readonly string[] = Object.freeze(['RESERVED', 'RELEASED', 'COMMITTED', 'UNKNOWN']);
/** シナリオの版の最小値（T28a の `MIN_SCENARIO_REVISION` の写し。照らす READ の定義の版と承認の記録の版も同じ）。 */
const MIN_STORED_SCENARIO_REVISION = 1;
/** 予約の件数の最小と、1 回の Run の上限（T28a の `MIN_SCENARIO_LIMIT`・`DEFAULT_MAX_CREATES_PER_RUN` の写し）。 */
const VERSION_6_MIN_SCENARIO_LIMIT = 1;
const VERSION_6_MAX_CREATES_PER_RUN = 1;
/** シナリオの下書きの状態（承認の記録を持たなくてよい、ただ 1 つの状態）。 */
const SCENARIO_DRAFT_STATE = 'DRAFT';
/** 承認の記録の種類（承認と撤回）。 */
const APPROVAL_RECEIPT_KIND = 'APPROVAL';
const REVOCATION_RECEIPT_KIND = 'REVOCATION';
/** 予約中（決着の時刻を持たない、ただ 1 つの予約の状態）。 */
const RESERVED_WRITE_STATE = 'RESERVED';

/** JSON の object の列の CHECK。 */
const jsonObjectCheck = (column: string): string => `json_valid(${column}) AND json_type(${column}) = 'object'`;

/**
 * 版 6 の表（Task 28 の設計書 4.2 の「管理データの版 6」。T28c）。版 1〜5 は公開済みなので変えない。版 6 は G28 で公開したので、T29d で、CHECK の
 * 値の一覧と数値を公開した時点の写し（`VERSION_6_…`）にした（生成される文は前と同じ。`tests/integration/control-store-v6.test.ts`・
 * `control-store-v7.test.ts` の SHA-256）。
 * どの表も `STRICT`、プロファイルへの外部キーを持ち、ジョブへの外部キーは持たない（ジョブの表は版ごとに作り直すため）。値・トークン・label・
 * 資格情報の列は持たない（設計書 4.7）。
 * - `scenarios`: シナリオの今の行（今の版、状態、最後の承認の記録の id、作った・変えた時刻）。`DRAFT` のほかの状態は、最後の承認の記録の id を持つ。
 *   書き込みは `src/control/approval/scenario-store.ts`。
 * - `scenario_revisions`: 版ごとの変えない写し（シナリオの版の文書、発見の根拠の写し（候補の契約の形の JSON）、写した発見のジョブ、時刻）。追記だけ。
 * - `approval_receipts`: 承認と撤回の記録（文書の JSON と、引くための列）。追記だけ（UPDATE・DELETE をしない。Architecture Gate
 *   `control-store-boundary.test.ts` の (k)）。承認だけが版・承認の digest・期限を持ち、撤回だけが対象の承認の記録の id を持つ。1 つの承認の撤回は
 *   1 つまで（部分一意の索引）。
 * - `execution_grants`: 実行の許可（シナリオ、版、承認の記録、ジョブの id（一意。ジョブへの外部キーは持たない）、発行・期限・消費・無効にした時刻）。
 *   消費していない有効な（消費も無効化もしていない）許可は、1 つのシナリオに 1 つまで（部分一意の索引）。書く口は T28d。
 * - `write_reservations`: 件数の予約（許可、シナリオ、件数（1 回の Run の既定の上限まで）、状態、予約と決着の時刻）。`RESERVED` だけが決着の時刻を
 *   持たない。1 つの許可に予約は 1 件（一意の索引。T28R-fix-1）。書く口は T28d（`COMMITTED`・`UNKNOWN` は Task 30）。
 */
const VERSION_6_STATEMENTS: readonly string[] = Object.freeze([
  `CREATE TABLE scenarios (
    scenario_id TEXT PRIMARY KEY NOT NULL CHECK (${jobIdCheck('scenario_id')}),
    profile_id TEXT NOT NULL REFERENCES profiles (profile_id),
    revision INTEGER NOT NULL CHECK (revision >= ${MIN_STORED_SCENARIO_REVISION}),
    state TEXT NOT NULL CHECK (state IN (${sqlListOf(VERSION_6_SCENARIO_STATES)})),
    last_approval_receipt_id TEXT CHECK (last_approval_receipt_id IS NULL OR (${jobIdCheck('last_approval_receipt_id')})),
    created_at TEXT NOT NULL CHECK (${compactUtcTimestampCheck('created_at')}),
    updated_at TEXT NOT NULL CHECK (${compactUtcTimestampCheck('updated_at')}),
    CHECK (created_at <= updated_at),
    CHECK (state = '${SCENARIO_DRAFT_STATE}' OR last_approval_receipt_id IS NOT NULL)
  ) STRICT`,
  'CREATE INDEX scenarios_profile_created ON scenarios (profile_id, created_at)',
  `CREATE TABLE scenario_revisions (
    scenario_id TEXT NOT NULL REFERENCES scenarios (scenario_id),
    revision INTEGER NOT NULL CHECK (revision >= ${MIN_STORED_SCENARIO_REVISION}),
    profile_id TEXT NOT NULL REFERENCES profiles (profile_id),
    document TEXT NOT NULL CHECK (${jsonObjectCheck('document')}),
    evidence TEXT NOT NULL CHECK (${jsonObjectCheck('evidence')}),
    discovery_job_id TEXT NOT NULL CHECK (${jobIdCheck('discovery_job_id')}),
    recorded_at TEXT NOT NULL CHECK (${compactUtcTimestampCheck('recorded_at')}),
    PRIMARY KEY (scenario_id, revision)
  ) STRICT`,
  `CREATE TABLE approval_receipts (
    receipt_id TEXT PRIMARY KEY NOT NULL CHECK (${jobIdCheck('receipt_id')}),
    profile_id TEXT NOT NULL REFERENCES profiles (profile_id),
    scenario_id TEXT NOT NULL REFERENCES scenarios (scenario_id),
    kind TEXT NOT NULL CHECK (kind IN (${sqlListOf(VERSION_6_APPROVAL_RECEIPT_KINDS)})),
    scenario_revision INTEGER CHECK (scenario_revision IS NULL OR scenario_revision >= ${MIN_STORED_SCENARIO_REVISION}),
    approval_digest TEXT CHECK (approval_digest IS NULL OR (${fingerprintCheck('approval_digest')})),
    target_receipt_id TEXT REFERENCES approval_receipts (receipt_id),
    recorded_at TEXT NOT NULL CHECK (${compactUtcTimestampCheck('recorded_at')}),
    expires_at TEXT CHECK (${optionalTimestampCheck('expires_at')}),
    document TEXT NOT NULL CHECK (${jsonObjectCheck('document')}),
    CHECK ((kind = '${APPROVAL_RECEIPT_KIND}') = (scenario_revision IS NOT NULL)),
    CHECK ((kind = '${APPROVAL_RECEIPT_KIND}') = (approval_digest IS NOT NULL)),
    CHECK ((kind = '${APPROVAL_RECEIPT_KIND}') = (expires_at IS NOT NULL)),
    CHECK ((kind = '${REVOCATION_RECEIPT_KIND}') = (target_receipt_id IS NOT NULL)),
    CHECK (expires_at IS NULL OR recorded_at < expires_at)
  ) STRICT`,
  'CREATE INDEX approval_receipts_scenario_recorded ON approval_receipts (scenario_id, recorded_at)',
  'CREATE UNIQUE INDEX approval_receipts_single_revocation ON approval_receipts (target_receipt_id) WHERE target_receipt_id IS NOT NULL',
  `CREATE TABLE execution_grants (
    grant_id TEXT PRIMARY KEY NOT NULL CHECK (${jobIdCheck('grant_id')}),
    profile_id TEXT NOT NULL REFERENCES profiles (profile_id),
    scenario_id TEXT NOT NULL REFERENCES scenarios (scenario_id),
    scenario_revision INTEGER NOT NULL CHECK (scenario_revision >= ${MIN_STORED_SCENARIO_REVISION}),
    approval_receipt_id TEXT NOT NULL REFERENCES approval_receipts (receipt_id),
    job_id TEXT NOT NULL UNIQUE CHECK (${jobIdCheck('job_id')}),
    issued_at TEXT NOT NULL CHECK (${compactUtcTimestampCheck('issued_at')}),
    expires_at TEXT NOT NULL CHECK (${compactUtcTimestampCheck('expires_at')}),
    consumed_at TEXT CHECK (${optionalTimestampCheck('consumed_at')}),
    invalidated_at TEXT CHECK (${optionalTimestampCheck('invalidated_at')}),
    CHECK (issued_at < expires_at),
    CHECK (consumed_at IS NULL OR invalidated_at IS NULL),
    CHECK (consumed_at IS NULL OR consumed_at >= issued_at),
    CHECK (invalidated_at IS NULL OR invalidated_at >= issued_at)
  ) STRICT`,
  'CREATE UNIQUE INDEX execution_grants_single_open ON execution_grants (scenario_id) WHERE consumed_at IS NULL AND invalidated_at IS NULL',
  `CREATE TABLE write_reservations (
    reservation_id INTEGER PRIMARY KEY NOT NULL,
    grant_id TEXT NOT NULL REFERENCES execution_grants (grant_id),
    profile_id TEXT NOT NULL REFERENCES profiles (profile_id),
    scenario_id TEXT NOT NULL REFERENCES scenarios (scenario_id),
    count INTEGER NOT NULL CHECK (count BETWEEN ${VERSION_6_MIN_SCENARIO_LIMIT} AND ${VERSION_6_MAX_CREATES_PER_RUN}),
    state TEXT NOT NULL CHECK (state IN (${sqlListOf(VERSION_6_WRITE_RESERVATION_STATES)})),
    reserved_at TEXT NOT NULL CHECK (${compactUtcTimestampCheck('reserved_at')}),
    settled_at TEXT CHECK (${optionalTimestampCheck('settled_at')}),
    CHECK ((state = '${RESERVED_WRITE_STATE}') = (settled_at IS NULL)),
    CHECK (settled_at IS NULL OR settled_at >= reserved_at)
  ) STRICT`,
  'CREATE INDEX write_reservations_scenario_state ON write_reservations (scenario_id, state)',
  // T28R-fix-1（独立レビュー T28R の M-4。版 6 は未公開なので足した）: 1 つの許可に予約は 1 件。
  'CREATE UNIQUE INDEX write_reservations_single_per_grant ON write_reservations (grant_id)',
]);

/**
 * 入力の規則の集まりの版の最小値（T29a の `MIN_RULE_SET_REVISION` の、版 7 を公開した時点の写し。T30d で固定した。今の値がこの写しと同じことは
 * `tests/integration/control-store-v8.test.ts` で確かめる）。
 */
const VERSION_7_MIN_RULE_SET_REVISION = 1;
const MIN_STORED_RULE_SET_REVISION = VERSION_7_MIN_RULE_SET_REVISION;

/**
 * 版 7 の表（Task 29 の設計書 4.3 の「管理データの版 7」。T29d）。版 1〜6 は公開済みなので変えない。どの表も `STRICT`、プロファイルとシナリオへの
 * 外部キーを持つ。版 7 は G29 で公開したので、T30d で、数値を公開した時点の写し（`VERSION_7_…`）にした（生成される文は前と同じ。
 * `tests/integration/control-store-v7.test.ts`・`control-store-v8.test.ts` の SHA-256）。
 * - `rule_sets`: 入力の規則の集まり（シナリオごとに 1 つ。シナリオの id で一意）。今の版と、作った・変えた時刻。書き込みは
 *   `src/control/data-rules/rule-store.ts`。
 * - `rule_set_revisions`: 版ごとの変えない写し（規則の集まりの版の文書（`schemas/control/data-rule.schema.json` の形）と、その digest
 *   （`computeRuleSetDigest`）と時刻）。追記だけ（Architecture Gate `control-store-boundary.test.ts` の (k)）。
 */
const VERSION_7_STATEMENTS: readonly string[] = Object.freeze([
  `CREATE TABLE rule_sets (
    rule_set_id TEXT PRIMARY KEY NOT NULL CHECK (${jobIdCheck('rule_set_id')}),
    scenario_id TEXT NOT NULL UNIQUE REFERENCES scenarios (scenario_id),
    profile_id TEXT NOT NULL REFERENCES profiles (profile_id),
    revision INTEGER NOT NULL CHECK (revision >= ${MIN_STORED_RULE_SET_REVISION}),
    created_at TEXT NOT NULL CHECK (${compactUtcTimestampCheck('created_at')}),
    updated_at TEXT NOT NULL CHECK (${compactUtcTimestampCheck('updated_at')}),
    CHECK (created_at <= updated_at)
  ) STRICT`,
  'CREATE INDEX rule_sets_profile_created ON rule_sets (profile_id, created_at)',
  `CREATE TABLE rule_set_revisions (
    rule_set_id TEXT NOT NULL REFERENCES rule_sets (rule_set_id),
    revision INTEGER NOT NULL CHECK (revision >= ${MIN_STORED_RULE_SET_REVISION}),
    scenario_id TEXT NOT NULL REFERENCES scenarios (scenario_id),
    profile_id TEXT NOT NULL REFERENCES profiles (profile_id),
    document TEXT NOT NULL CHECK (${jsonObjectCheck('document')}),
    digest TEXT NOT NULL CHECK (${fingerprintCheck('digest')}),
    recorded_at TEXT NOT NULL CHECK (${compactUtcTimestampCheck('recorded_at')}),
    PRIMARY KEY (rule_set_id, revision)
  ) STRICT`,
]);

// T31e: 版 8 は G30 で公開したので、版 8 の CHECK と索引が参照する値の一覧と数値は、版 8 を公開した時点の写しで固定する（今の名前つきの一覧と
// 定数は参照しない。今の一覧がこの写しで始まることと、文の SHA-256 は `tests/integration/control-store-v9.test.ts` で確かめる）。
/** 版 8 を公開した時点の `AUDIT_JOB_STATES`。 */
const VERSION_8_AUDIT_JOB_STATES: readonly string[] = Object.freeze(['STARTING', 'RUNNING', 'STOPPING', 'FINISHED', 'FAILED', 'INTERRUPTED']);
/** 版 8 を公開した時点の `ACTIVE_AUDIT_JOB_STATES`。 */
const VERSION_8_ACTIVE_AUDIT_JOB_STATES: readonly string[] = Object.freeze(['STARTING', 'RUNNING', 'STOPPING']);
/** 版 8 を公開した時点の `FINAL_AUDIT_JOB_STATES`。 */
const VERSION_8_FINAL_AUDIT_JOB_STATES: readonly string[] = Object.freeze(['FINISHED', 'FAILED', 'INTERRUPTED']);
/** 版 8 を公開した時点の `AUDIT_JOB_STATES_WITH_REASON`。 */
const VERSION_8_AUDIT_JOB_STATES_WITH_REASON: readonly string[] = Object.freeze(['FAILED', 'INTERRUPTED']);
/** 版 8 を公開した時点の `AUDIT_JOB_FAILURE_REASONS`。 */
const VERSION_8_AUDIT_JOB_FAILURE_REASONS: readonly string[] = Object.freeze([
  'CONFIG_ERROR', 'ARTIFACT_WRITE_FAILED', 'UNEXPECTED_FAILURE', 'PROTOCOL_VIOLATION', 'START_TIMEOUT', 'CONFIG_CHANGED', 'AUTH_SETUP_CHANGED',
  'AUTH_SETUP_REQUIRED', 'UNSUPPORTED_AUTH_STATE', 'LOGIN_TIMEOUT', 'LOGIN_ATTEMPTS_EXCEEDED', 'WORKER_START_FAILED', 'WORKER_NOT_READY',
  'WORKER_EXITED', 'WORKER_UNRESPONSIVE', 'STOP_TIMEOUT', 'SERVER_RESTARTED', 'SERVER_SHUTDOWN', 'INVALID_CREDENTIALS', 'ACCOUNT_LOCKED',
  'MFA_REQUIRED', 'CREDENTIAL_EXPIRED', 'RATE_LIMITED', 'AUTH_RESULT_UNKNOWN', 'LOGIN_FORM_INVALID', 'LOGIN_FORM_INPUT_FAILED', 'CREDENTIAL_CHANGED',
  'CREDENTIAL_UNAVAILABLE', 'UNEXPECTED_LOGIN_REQUEST', 'JOB_KIND_NOT_SUPPORTED', 'DISCOVERY_RESULT_INVALID', 'READ_CHECK_RESULT_INVALID',
  'WRITE_GRANT_REJECTED', 'WRITE_RESULT_INVALID',
]);
/** 版 8 を公開した時点の `AUDIT_JOB_KINDS`。 */
const VERSION_8_AUDIT_JOB_KINDS: readonly string[] = Object.freeze(['AUDIT', 'LOGIN_CHECK', 'DISCOVERY', 'READ_CHECK', 'WRITE_CREATE']);
/** 版 8 を公開した時点の `WORKER_RUN_STATUSES`。 */
const VERSION_8_RUN_STATUSES: readonly string[] = Object.freeze(['COMPLETE', 'PARTIAL', 'FAILED', 'ABORTED_BY_SAFETY']);
/** 版 8 を公開した時点の `WORKER_OUTCOME_KINDS`。 */
const VERSION_8_WORKER_OUTCOME_KINDS: readonly string[] = Object.freeze([
  'RAN', 'RUN_ACTIVE', 'VERSION_MISMATCH', 'RUN_DIRECTORY_UNAVAILABLE', 'RESUME_UNAVAILABLE',
]);
/** 版 8 を公開した時点の `WORKER_AUTH_STATES`。 */
const VERSION_8_WORKER_AUTH_STATES: readonly string[] = Object.freeze([
  'AWAITING_LOGIN', 'AUTHENTICATED', 'AUTH_SETUP_REQUIRED', 'UNSUPPORTED_AUTH_STATE', 'SESSION_LOST', 'LOGIN_TIMEOUT', 'LOGIN_ATTEMPTS_EXCEEDED',
  'AUTOMATED_LOGIN_FAILED',
]);
/** 版 8 を公開した時点の `SUBMISSION_STATES`。 */
const VERSION_8_SUBMISSION_STATES: readonly string[] = Object.freeze(['NOT_SENT', 'SENT', 'UNKNOWN']);
/** 版 8 を公開した時点の `ACTION_BLOCK_REASONS`。 */
const VERSION_8_ACTION_BLOCK_REASONS: readonly string[] = Object.freeze(['PAYLOAD_MISMATCH', 'PRECHECK_FAILED']);
/** 版 8 を公開した時点の `RESPONSE_JUDGEMENTS`。 */
const VERSION_8_RESPONSE_JUDGEMENTS: readonly string[] = Object.freeze([
  'SUCCESS', 'INPUT_ERROR', 'RATE_LIMITED', 'SERVER_ERROR', 'NO_CONDITION_MATCHED', 'MULTIPLE_CONDITIONS_MATCHED', 'SESSION_LOST', 'REPOST_REDIRECT',
  'RESPONSE_NOT_DELIVERED',
]);
/** 版 8 を公開した時点の `READ_CHECK_RESULTS`。 */
const VERSION_8_READ_CHECK_RESULTS: readonly string[] = Object.freeze([
  'MATCHED', 'NOT_MATCHED', 'UNDETERMINED', 'READ_BLOCKED_BY_POLICY', 'READ_CANDIDATE_DRIFTED', 'READ_CANDIDATE_NOT_READ',
]);
/** 版 8 を公開した時点の `ACTION_RESULTS`。 */
const VERSION_8_ACTION_RESULTS: readonly string[] = Object.freeze(['VERIFIED', 'PARTIAL', 'BLOCKED', 'UNKNOWN', 'FAILED']);
/** 版 8 を公開した時点の `ACTION_OUTCOME_REASONS`。 */
const VERSION_8_ACTION_OUTCOME_REASONS: readonly string[] = Object.freeze([
  'PAYLOAD_MISMATCH', 'PRECHECK_FAILED', 'NO_RESPONSE', 'INPUT_ERROR', 'RATE_LIMITED', 'SERVER_ERROR', 'NO_CONDITION_MATCHED',
  'MULTIPLE_CONDITIONS_MATCHED', 'SESSION_LOST', 'REPOST_REDIRECT', 'RESPONSE_NOT_DELIVERED', 'RECORD_ID_NOT_FOUND', 'RECORD_ID_UNSAFE',
  'READ_VERIFICATION_MATCHED', 'READ_VERIFICATION_NOT_MATCHED', 'READ_VERIFICATION_UNDETERMINED',
]);
/** 版 8 を公開した時点の `SETTLED_RESERVATION_STATES`。 */
const VERSION_8_SETTLED_RESERVATION_STATES: readonly string[] = Object.freeze(['COMMITTED', 'UNKNOWN', 'RELEASED']);
/** 版 8 を公開した時点の HTTP の状態の最小と最大（`MIN_HTTP_STATUS`・`MAX_HTTP_STATUS`）と、登録の ID の最大長（`MAX_RECORD_ID_LENGTH`）。 */
const VERSION_8_MIN_HTTP_STATUS = 100;
const VERSION_8_MAX_HTTP_STATUS = 599;
const VERSION_8_MAX_RECORD_ID_LENGTH = 256;

/** 版 8 の作り直したジョブの表の、今の行を移す列（版 5 と同じ列）。 */
const VERSION_8_JOB_COLUMNS = VERSION_4_JOB_COLUMNS;
/** 版 8 の終わっていないジョブの状態（一意の部分索引）。 */
const VERSION_8_ACTIVE_JOB_STATES_SQL = sqlListOf(VERSION_8_ACTIVE_AUDIT_JOB_STATES);

/** 書き込みの結果の、送らずに止めた送信の状態・止めた結果・返した予約・照合まで済んだ結果と、その判定と照合の結果（版 8・9 の CHECK の値）。 */
const NOT_SENT_SUBMISSION = 'NOT_SENT' satisfies SubmissionState;
const BLOCKED_RESULT = 'BLOCKED' satisfies ActionResult;
const RELEASED_SETTLEMENT = 'RELEASED' satisfies SettledReservationState;
const VERIFIED_RESULT = 'VERIFIED' satisfies ActionResult;
const SUCCESS_JUDGEMENT = 'SUCCESS' satisfies ResponseJudgement;
const MATCHED_READ_RESULT = 'MATCHED' satisfies ReadCheckResult;

/** JSON の配列の列の CHECK。 */
const jsonArrayCheck = (column: string): string => `json_valid(${column}) AND json_type(${column}) = 'array'`;

/**
 * 版 8 の表（Task 30 の設計書 3 章の「記録」「予約の締め」。T30d）。版 1〜7 は公開済みなので変えない。版 8 は G30 で公開したので、T31e で、CHECK の
 * 値の一覧と数値を公開した時点の写し（`VERSION_8_…`）にした（生成される文は前と同じ。`tests/integration/control-store-v8.test.ts`・
 * `control-store-v9.test.ts` の SHA-256）。
 * - ジョブの表を作り直す（版 5 と同じ手順と列。今の行を移す）。ジョブの種類に `WRITE_CREATE`、失敗の理由に書き込みのジョブの理由
 *   （`WRITE_GRANT_REJECTED`・`WRITE_RESULT_INVALID`）を足した今の一覧の CHECK にする。
 * - `write_results`: 書き込みのジョブ 1 回の結果（ジョブの id で一意。許可で一意）。送る前に、プロファイル・シナリオと版・許可・seed の記録・送った値
 *   （合成のテストデータなので平文の JSON の object）・一意にする欄の組・作った電話番号（JSON の配列）・記録の時刻を書き（結果の列は null）、締める
 *   ときに、送信の状態・止めた理由・HTTP の状態・結果の判定・登録の ID・照合の結果・`ActionResult` と理由・予約の締めの状態・送信と締めの時刻を
 *   1 回だけ書く（`src/control/approval/scenario-store.ts`。予約の締めと同じトランザクション）。追記と締めだけ（Architecture Gate
 *   `control-store-boundary.test.ts` の (m)）。資格情報・Cookie・CSRF のトークン・hidden の値の列は持たない。生成の履歴（使った一意の組と
 *   電話番号）は、この表から読む（別の表を持たない）。ジョブの表は版ごとに作り直すので、ジョブへの外部キーは持たない。
 *   CHECK: 締めた時刻と結果・理由・予約の締め・送信の状態は、そろって null か、そろってある。締める前は、結果の列を持たない。`NOT_SENT` は止めた
 *   理由を持ち、`BLOCKED`・`RELEASED` で、応答・登録の ID・照合・送信の時刻を持たない。送った（か分からない）記録は `BLOCKED` にも `RELEASED` にも
 *   ならない。`VERIFIED` は、成功の判定・登録の ID・照合の一致を持つ。
 */
const VERSION_8_STATEMENTS: readonly string[] = Object.freeze([
  `CREATE TABLE jobs_v8 (
    job_id TEXT PRIMARY KEY NOT NULL CHECK (${jobIdCheck('job_id')}),
    profile_id TEXT NOT NULL REFERENCES profiles (profile_id),
    profile_revision INTEGER NOT NULL CHECK (profile_revision >= ${MIN_STORED_REVISION}),
    state TEXT NOT NULL CHECK (state IN (${sqlListOf(VERSION_8_AUDIT_JOB_STATES)})),
    start_new INTEGER NOT NULL CHECK (start_new IN (0, 1)),
    run_id TEXT CHECK (run_id IS NULL OR length(run_id) > 0),
    run_directory TEXT CHECK (run_directory IS NULL OR length(run_directory) BETWEEN 1 AND ${MAX_WORKER_MESSAGE_PATH_LENGTH}),
    exit_code INTEGER CHECK (exit_code IS NULL OR exit_code BETWEEN 0 AND ${MAX_WORKER_EXIT_CODE}),
    run_status TEXT CHECK (run_status IS NULL OR run_status IN (${sqlListOf(VERSION_8_RUN_STATUSES)})),
    end_kind TEXT CHECK (end_kind IS NULL OR end_kind IN (${sqlListOf(VERSION_8_WORKER_OUTCOME_KINDS)})),
    last_progress TEXT CHECK (last_progress IS NULL OR json_valid(last_progress)),
    last_notice TEXT CHECK (last_notice IS NULL OR json_valid(last_notice)),
    worker_pid INTEGER CHECK (worker_pid IS NULL OR worker_pid > 0),
    created_at TEXT NOT NULL CHECK (${compactUtcTimestampCheck('created_at')}),
    started_at TEXT CHECK (${optionalTimestampCheck('started_at')}),
    finished_at TEXT CHECK (${optionalTimestampCheck('finished_at')}),
    last_heartbeat_at TEXT CHECK (${optionalTimestampCheck('last_heartbeat_at')}),
    stop_requested_at TEXT CHECK (${optionalTimestampCheck('stop_requested_at')}),
    failure_reason TEXT CHECK (failure_reason IS NULL OR failure_reason IN (${sqlListOf(VERSION_8_AUDIT_JOB_FAILURE_REASONS)})),
    last_auth_state TEXT CHECK (last_auth_state IS NULL OR last_auth_state IN (${sqlListOf(VERSION_8_WORKER_AUTH_STATES)})),
    session_lost_url TEXT CHECK (session_lost_url IS NULL OR length(session_lost_url) BETWEEN 1 AND ${MAX_WORKER_NOTICE_URL_LENGTH}),
    job_kind TEXT NOT NULL CHECK (job_kind IN (${sqlListOf(VERSION_8_AUDIT_JOB_KINDS)})),
    CHECK ((state IN (${sqlListOf(VERSION_8_FINAL_AUDIT_JOB_STATES)})) = (finished_at IS NOT NULL)),
    CHECK ((state IN (${sqlListOf(VERSION_8_AUDIT_JOB_STATES_WITH_REASON)})) = (failure_reason IS NOT NULL))
  ) STRICT`,
  `INSERT INTO jobs_v8 (${VERSION_8_JOB_COLUMNS}) SELECT ${VERSION_8_JOB_COLUMNS} FROM jobs`,
  'DROP TABLE jobs',
  'ALTER TABLE jobs_v8 RENAME TO jobs',
  `CREATE UNIQUE INDEX jobs_single_active ON jobs ((state IN (${VERSION_8_ACTIVE_JOB_STATES_SQL}))) WHERE state IN (${VERSION_8_ACTIVE_JOB_STATES_SQL})`,
  'CREATE INDEX jobs_created_at ON jobs (created_at)',
  `CREATE TABLE write_results (
    job_id TEXT PRIMARY KEY NOT NULL CHECK (${jobIdCheck('job_id')}),
    grant_id TEXT NOT NULL UNIQUE REFERENCES execution_grants (grant_id),
    profile_id TEXT NOT NULL REFERENCES profiles (profile_id),
    scenario_id TEXT NOT NULL REFERENCES scenarios (scenario_id),
    scenario_revision INTEGER NOT NULL CHECK (scenario_revision >= ${MIN_STORED_SCENARIO_REVISION}),
    seed_record TEXT CHECK (seed_record IS NULL OR (${jsonObjectCheck('seed_record')})),
    submitted_values TEXT NOT NULL CHECK (${jsonObjectCheck('submitted_values')}),
    unique_key TEXT CHECK (unique_key IS NULL OR length(unique_key) > 0),
    phone_numbers TEXT NOT NULL CHECK (${jsonArrayCheck('phone_numbers')}),
    submission TEXT CHECK (submission IS NULL OR submission IN (${sqlListOf(VERSION_8_SUBMISSION_STATES)})),
    block_reason TEXT CHECK (block_reason IS NULL OR block_reason IN (${sqlListOf(VERSION_8_ACTION_BLOCK_REASONS)})),
    http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN ${VERSION_8_MIN_HTTP_STATUS} AND ${VERSION_8_MAX_HTTP_STATUS}),
    response_judgement TEXT CHECK (response_judgement IS NULL OR response_judgement IN (${sqlListOf(VERSION_8_RESPONSE_JUDGEMENTS)})),
    record_id TEXT CHECK (record_id IS NULL OR length(record_id) BETWEEN 1 AND ${VERSION_8_MAX_RECORD_ID_LENGTH}),
    read_verification TEXT CHECK (read_verification IS NULL OR read_verification IN (${sqlListOf(VERSION_8_READ_CHECK_RESULTS)})),
    result TEXT CHECK (result IS NULL OR result IN (${sqlListOf(VERSION_8_ACTION_RESULTS)})),
    reason TEXT CHECK (reason IS NULL OR reason IN (${sqlListOf(VERSION_8_ACTION_OUTCOME_REASONS)})),
    reservation_state TEXT CHECK (reservation_state IS NULL OR reservation_state IN (${sqlListOf(VERSION_8_SETTLED_RESERVATION_STATES)})),
    recorded_at TEXT NOT NULL CHECK (${compactUtcTimestampCheck('recorded_at')}),
    submitted_at TEXT CHECK (${optionalTimestampCheck('submitted_at')}),
    settled_at TEXT CHECK (${optionalTimestampCheck('settled_at')}),
    CHECK ((settled_at IS NULL) = (result IS NULL)),
    CHECK ((result IS NULL) = (reason IS NULL)),
    CHECK ((result IS NULL) = (reservation_state IS NULL)),
    CHECK ((result IS NULL) = (submission IS NULL)),
    CHECK (result IS NOT NULL OR (block_reason IS NULL AND http_status IS NULL AND response_judgement IS NULL AND record_id IS NULL
      AND read_verification IS NULL AND submitted_at IS NULL)),
    CHECK (submission IS NULL OR (submission = '${NOT_SENT_SUBMISSION}') = (block_reason IS NOT NULL)),
    CHECK (submission IS NOT '${NOT_SENT_SUBMISSION}' OR (result = '${BLOCKED_RESULT}' AND reservation_state = '${RELEASED_SETTLEMENT}'
      AND http_status IS NULL AND response_judgement IS NULL AND record_id IS NULL AND read_verification IS NULL AND submitted_at IS NULL)),
    CHECK (submission IS NULL OR submission = '${NOT_SENT_SUBMISSION}'
      OR (result IS NOT '${BLOCKED_RESULT}' AND reservation_state IS NOT '${RELEASED_SETTLEMENT}')),
    CHECK (result IS NOT '${VERIFIED_RESULT}' OR (response_judgement = '${SUCCESS_JUDGEMENT}' AND record_id IS NOT NULL
      AND read_verification = '${MATCHED_READ_RESULT}')),
    CHECK (submitted_at IS NULL OR submitted_at >= recorded_at),
    CHECK (settled_at IS NULL OR settled_at >= recorded_at)
  ) STRICT`,
  'CREATE INDEX write_results_scenario_recorded ON write_results (scenario_id, recorded_at)',
  'CREATE INDEX write_results_profile ON write_results (profile_id)',
]);

/** 版 9 の作り直したジョブの表の、今の行を移す列（版 5〜8 と同じ列）。 */
const VERSION_9_JOB_COLUMNS = VERSION_8_JOB_COLUMNS;

// T32g: 版 9 は G31 で公開したので、版 9 の CHECK と索引が参照する値の一覧と数値は、版 9 を公開した時点の写しで固定する（今の名前つきの一覧と
// 定数は参照しない。今の一覧がこの写しで始まることと、文の SHA-256 は `tests/integration/control-store-v10.test.ts` で確かめる）。版 8 と同じ値の
// 一覧は、版 8 の写しをそのまま使う。
/** 版 9 を公開した時点の `AUDIT_JOB_STATES`・`ACTIVE_AUDIT_JOB_STATES`・`FINAL_AUDIT_JOB_STATES`・`AUDIT_JOB_STATES_WITH_REASON`（版 8 と同じ）。 */
const VERSION_9_AUDIT_JOB_STATES = VERSION_8_AUDIT_JOB_STATES;
const VERSION_9_ACTIVE_AUDIT_JOB_STATES = VERSION_8_ACTIVE_AUDIT_JOB_STATES;
const VERSION_9_FINAL_AUDIT_JOB_STATES = VERSION_8_FINAL_AUDIT_JOB_STATES;
const VERSION_9_AUDIT_JOB_STATES_WITH_REASON = VERSION_8_AUDIT_JOB_STATES_WITH_REASON;
/** 版 9 を公開した時点の `AUDIT_JOB_FAILURE_REASONS`（版 8 と同じ）。 */
const VERSION_9_AUDIT_JOB_FAILURE_REASONS = VERSION_8_AUDIT_JOB_FAILURE_REASONS;
/** 版 9 を公開した時点の `AUDIT_JOB_KINDS`（版 8 に `WRITE_UPDATE` を足した）。 */
const VERSION_9_AUDIT_JOB_KINDS: readonly string[] = Object.freeze([...VERSION_8_AUDIT_JOB_KINDS, 'WRITE_UPDATE']);
/** 版 9 を公開した時点の `WORKER_RUN_STATUSES`・`WORKER_OUTCOME_KINDS`・`WORKER_AUTH_STATES`（版 8 と同じ）。 */
const VERSION_9_RUN_STATUSES = VERSION_8_RUN_STATUSES;
const VERSION_9_WORKER_OUTCOME_KINDS = VERSION_8_WORKER_OUTCOME_KINDS;
const VERSION_9_WORKER_AUTH_STATES = VERSION_8_WORKER_AUTH_STATES;
/** 版 9 を公開した時点の `SCENARIO_KINDS`。 */
const VERSION_9_SCENARIO_KINDS: readonly string[] = Object.freeze(['CREATE', 'UPDATE']);
/** 版 9 を公開した時点の `SUBMISSION_STATES`・`ACTION_BLOCK_REASONS`・`RESPONSE_JUDGEMENTS`・`READ_CHECK_RESULTS`・`ACTION_RESULTS`（版 8 と同じ）。 */
const VERSION_9_SUBMISSION_STATES = VERSION_8_SUBMISSION_STATES;
const VERSION_9_ACTION_BLOCK_REASONS = VERSION_8_ACTION_BLOCK_REASONS;
const VERSION_9_RESPONSE_JUDGEMENTS = VERSION_8_RESPONSE_JUDGEMENTS;
const VERSION_9_READ_CHECK_RESULTS = VERSION_8_READ_CHECK_RESULTS;
const VERSION_9_ACTION_RESULTS = VERSION_8_ACTION_RESULTS;
/** 版 9 を公開した時点の `ACTION_OUTCOME_REASONS`（版 8 に UPDATE の 3 つの理由を足した）。 */
const VERSION_9_ACTION_OUTCOME_REASONS: readonly string[] = Object.freeze([
  ...VERSION_8_ACTION_OUTCOME_REASONS, 'RECORD_ID_MISMATCH', 'UNEXPECTED_FIELD_CHANGE', 'UPDATE_POSTCHECK_UNDETERMINED',
]);
/** 版 9 を公開した時点の `SETTLED_RESERVATION_STATES`（版 8 と同じ）。 */
const VERSION_9_SETTLED_RESERVATION_STATES = VERSION_8_SETTLED_RESERVATION_STATES;
/** 版 9 を公開した時点の HTTP の状態の最小と最大と登録の ID の最大長（版 8 と同じ）と、使える登録の ID の最大長（`MAX_SAFE_RECORD_ID_LENGTH`）。 */
const VERSION_9_MIN_HTTP_STATUS = VERSION_8_MIN_HTTP_STATUS;
const VERSION_9_MAX_HTTP_STATUS = VERSION_8_MAX_HTTP_STATUS;
const VERSION_9_MAX_RECORD_ID_LENGTH = VERSION_8_MAX_RECORD_ID_LENGTH;
const VERSION_9_MAX_SAFE_RECORD_ID_LENGTH = 64;

/** 版 9 の終わっていないジョブの状態（一意の部分索引）。 */
const VERSION_9_ACTIVE_JOB_STATES_SQL = sqlListOf(VERSION_9_ACTIVE_AUDIT_JOB_STATES);
/** 版 8 の書き込みの結果の表の列（版 9 に移す列。この順）。 */
const VERSION_8_WRITE_RESULT_COLUMNS = 'job_id, grant_id, profile_id, scenario_id, scenario_revision, seed_record, submitted_values, unique_key, '
  + 'phone_numbers, submission, block_reason, http_status, response_judgement, record_id, read_verification, result, reason, reservation_state, '
  + 'recorded_at, submitted_at, settled_at';
/** 書き込みの種類（シナリオの kind と同じ一覧。版 9 の `write_results.write_kind`）。版 8 の行は、すべて登録（`CREATE`）として移す。 */
const CREATE_WRITE_KIND = 'CREATE' satisfies ScenarioKind;
const UPDATE_WRITE_KIND = 'UPDATE' satisfies ScenarioKind;

/**
 * 登録の ID として使える形の CHECK（`src/control/actions/action-outcome.ts` の `isUsableRecordId` と同じ形。英数字・`_`・`-`、1〜
 * `MAX_SAFE_RECORD_ID_LENGTH` 文字。GLOB の文字の組は大文字と小文字を区別する）。
 */
const usableRecordIdCheck = (column: string): string =>
  `length(${column}) BETWEEN 1 AND ${VERSION_9_MAX_SAFE_RECORD_ID_LENGTH} AND ${column} NOT GLOB '*[^A-Za-z0-9_-]*'`;

/**
 * 版 9 の表（Task 31 の設計書 3 章の「対象の選び方」「証拠と記録」「記録」、11 章の T31b の Blocker の判断。T31e）。版 1〜8 は公開済みなので変えない。
 * 版 9 は G31 で公開したので、T32g で、CHECK の値の一覧と数値を公開した時点の写し（`VERSION_9_…`）にした（生成される文は前と同じ。
 * `tests/integration/control-store-v9.test.ts`・`control-store-v10.test.ts` の SHA-256）。
 * - ジョブの表を作り直す（版 5〜8 と同じ手順と列。今の行を移す）。ジョブの種類に `WRITE_UPDATE` を足した今の一覧の CHECK にする。
 * - `write_results` を作り直す（版 8 の行は、すべて登録 `CREATE` として移す）。足す列は 3 つ。
 *   - `write_kind`: 書き込みの種類（`SCENARIO_KINDS`。`CREATE`・`UPDATE`）。
 *   - `target_record_id`: 対象のレコードの ID（`UPDATE` だけが持ち、`UPDATE` は必ず持つ。形は `isUsableRecordId`）。実行の許可の対象の ID の写し。
 *   - `update_evidence`: UPDATE の証拠（JSON の object。変えた欄の前の値と新しい値、欄ごとの後の照合の一致の真偽。保つ欄の値・hidden の値は持たない）。
 *     `UPDATE` の締めた行だけが持てる（締めで書く。Architecture Gate `control-store-boundary.test.ts` の (m) の締めの列）。`UPDATE` の `VERIFIED` は
 *     必ず持つ。
 *   ほかの列と CHECK と索引は版 8 と同じ。追記と締めだけ（Gate (m)）。
 * - `discovery_candidates` に `templated_identity_digests`（型にした識別の digest の一覧。JSON の配列。digest だけで、欄の名前は持たない）を足す。
 *   版 9 の前の行は null（一覧なし。UPDATE の承認の有効性は止める側）。次の発見で、親が候補の全体から求めて書く。
 * - `execution_grants` に `target_record_id`（UPDATE の許可の対象のレコードの ID。発行の中で選んで結ぶ。形は `isUsableRecordId`。CREATE の許可は
 *   null）を足す。予約は許可に 1 件（版 6 の一意の索引）なので、予約は許可を通して対象に結び付く（予約の表は変えない）。
 */
const VERSION_9_STATEMENTS: readonly string[] = Object.freeze([
  `CREATE TABLE jobs_v9 (
    job_id TEXT PRIMARY KEY NOT NULL CHECK (${jobIdCheck('job_id')}),
    profile_id TEXT NOT NULL REFERENCES profiles (profile_id),
    profile_revision INTEGER NOT NULL CHECK (profile_revision >= ${MIN_STORED_REVISION}),
    state TEXT NOT NULL CHECK (state IN (${sqlListOf(VERSION_9_AUDIT_JOB_STATES)})),
    start_new INTEGER NOT NULL CHECK (start_new IN (0, 1)),
    run_id TEXT CHECK (run_id IS NULL OR length(run_id) > 0),
    run_directory TEXT CHECK (run_directory IS NULL OR length(run_directory) BETWEEN 1 AND ${MAX_WORKER_MESSAGE_PATH_LENGTH}),
    exit_code INTEGER CHECK (exit_code IS NULL OR exit_code BETWEEN 0 AND ${MAX_WORKER_EXIT_CODE}),
    run_status TEXT CHECK (run_status IS NULL OR run_status IN (${sqlListOf(VERSION_9_RUN_STATUSES)})),
    end_kind TEXT CHECK (end_kind IS NULL OR end_kind IN (${sqlListOf(VERSION_9_WORKER_OUTCOME_KINDS)})),
    last_progress TEXT CHECK (last_progress IS NULL OR json_valid(last_progress)),
    last_notice TEXT CHECK (last_notice IS NULL OR json_valid(last_notice)),
    worker_pid INTEGER CHECK (worker_pid IS NULL OR worker_pid > 0),
    created_at TEXT NOT NULL CHECK (${compactUtcTimestampCheck('created_at')}),
    started_at TEXT CHECK (${optionalTimestampCheck('started_at')}),
    finished_at TEXT CHECK (${optionalTimestampCheck('finished_at')}),
    last_heartbeat_at TEXT CHECK (${optionalTimestampCheck('last_heartbeat_at')}),
    stop_requested_at TEXT CHECK (${optionalTimestampCheck('stop_requested_at')}),
    failure_reason TEXT CHECK (failure_reason IS NULL OR failure_reason IN (${sqlListOf(VERSION_9_AUDIT_JOB_FAILURE_REASONS)})),
    last_auth_state TEXT CHECK (last_auth_state IS NULL OR last_auth_state IN (${sqlListOf(VERSION_9_WORKER_AUTH_STATES)})),
    session_lost_url TEXT CHECK (session_lost_url IS NULL OR length(session_lost_url) BETWEEN 1 AND ${MAX_WORKER_NOTICE_URL_LENGTH}),
    job_kind TEXT NOT NULL CHECK (job_kind IN (${sqlListOf(VERSION_9_AUDIT_JOB_KINDS)})),
    CHECK ((state IN (${sqlListOf(VERSION_9_FINAL_AUDIT_JOB_STATES)})) = (finished_at IS NOT NULL)),
    CHECK ((state IN (${sqlListOf(VERSION_9_AUDIT_JOB_STATES_WITH_REASON)})) = (failure_reason IS NOT NULL))
  ) STRICT`,
  `INSERT INTO jobs_v9 (${VERSION_9_JOB_COLUMNS}) SELECT ${VERSION_9_JOB_COLUMNS} FROM jobs`,
  'DROP TABLE jobs',
  'ALTER TABLE jobs_v9 RENAME TO jobs',
  `CREATE UNIQUE INDEX jobs_single_active ON jobs ((state IN (${VERSION_9_ACTIVE_JOB_STATES_SQL}))) WHERE state IN (${VERSION_9_ACTIVE_JOB_STATES_SQL})`,
  'CREATE INDEX jobs_created_at ON jobs (created_at)',
  `CREATE TABLE write_results_v9 (
    job_id TEXT PRIMARY KEY NOT NULL CHECK (${jobIdCheck('job_id')}),
    grant_id TEXT NOT NULL UNIQUE REFERENCES execution_grants (grant_id),
    profile_id TEXT NOT NULL REFERENCES profiles (profile_id),
    scenario_id TEXT NOT NULL REFERENCES scenarios (scenario_id),
    scenario_revision INTEGER NOT NULL CHECK (scenario_revision >= ${MIN_STORED_SCENARIO_REVISION}),
    write_kind TEXT NOT NULL CHECK (write_kind IN (${sqlListOf(VERSION_9_SCENARIO_KINDS)})),
    target_record_id TEXT CHECK (target_record_id IS NULL OR (${usableRecordIdCheck('target_record_id')})),
    seed_record TEXT CHECK (seed_record IS NULL OR (${jsonObjectCheck('seed_record')})),
    submitted_values TEXT NOT NULL CHECK (${jsonObjectCheck('submitted_values')}),
    unique_key TEXT CHECK (unique_key IS NULL OR length(unique_key) > 0),
    phone_numbers TEXT NOT NULL CHECK (${jsonArrayCheck('phone_numbers')}),
    submission TEXT CHECK (submission IS NULL OR submission IN (${sqlListOf(VERSION_9_SUBMISSION_STATES)})),
    block_reason TEXT CHECK (block_reason IS NULL OR block_reason IN (${sqlListOf(VERSION_9_ACTION_BLOCK_REASONS)})),
    http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN ${VERSION_9_MIN_HTTP_STATUS} AND ${VERSION_9_MAX_HTTP_STATUS}),
    response_judgement TEXT CHECK (response_judgement IS NULL OR response_judgement IN (${sqlListOf(VERSION_9_RESPONSE_JUDGEMENTS)})),
    record_id TEXT CHECK (record_id IS NULL OR length(record_id) BETWEEN 1 AND ${VERSION_9_MAX_RECORD_ID_LENGTH}),
    read_verification TEXT CHECK (read_verification IS NULL OR read_verification IN (${sqlListOf(VERSION_9_READ_CHECK_RESULTS)})),
    update_evidence TEXT CHECK (update_evidence IS NULL OR (${jsonObjectCheck('update_evidence')})),
    result TEXT CHECK (result IS NULL OR result IN (${sqlListOf(VERSION_9_ACTION_RESULTS)})),
    reason TEXT CHECK (reason IS NULL OR reason IN (${sqlListOf(VERSION_9_ACTION_OUTCOME_REASONS)})),
    reservation_state TEXT CHECK (reservation_state IS NULL OR reservation_state IN (${sqlListOf(VERSION_9_SETTLED_RESERVATION_STATES)})),
    recorded_at TEXT NOT NULL CHECK (${compactUtcTimestampCheck('recorded_at')}),
    submitted_at TEXT CHECK (${optionalTimestampCheck('submitted_at')}),
    settled_at TEXT CHECK (${optionalTimestampCheck('settled_at')}),
    CHECK ((settled_at IS NULL) = (result IS NULL)),
    CHECK ((result IS NULL) = (reason IS NULL)),
    CHECK ((result IS NULL) = (reservation_state IS NULL)),
    CHECK ((result IS NULL) = (submission IS NULL)),
    CHECK (result IS NOT NULL OR (block_reason IS NULL AND http_status IS NULL AND response_judgement IS NULL AND record_id IS NULL
      AND read_verification IS NULL AND submitted_at IS NULL)),
    CHECK (submission IS NULL OR (submission = '${NOT_SENT_SUBMISSION}') = (block_reason IS NOT NULL)),
    CHECK (submission IS NOT '${NOT_SENT_SUBMISSION}' OR (result = '${BLOCKED_RESULT}' AND reservation_state = '${RELEASED_SETTLEMENT}'
      AND http_status IS NULL AND response_judgement IS NULL AND record_id IS NULL AND read_verification IS NULL AND submitted_at IS NULL)),
    CHECK (submission IS NULL OR submission = '${NOT_SENT_SUBMISSION}'
      OR (result IS NOT '${BLOCKED_RESULT}' AND reservation_state IS NOT '${RELEASED_SETTLEMENT}')),
    CHECK (result IS NOT '${VERIFIED_RESULT}' OR (response_judgement = '${SUCCESS_JUDGEMENT}' AND record_id IS NOT NULL
      AND read_verification = '${MATCHED_READ_RESULT}')),
    CHECK (submitted_at IS NULL OR submitted_at >= recorded_at),
    CHECK (settled_at IS NULL OR settled_at >= recorded_at),
    CHECK ((write_kind = '${UPDATE_WRITE_KIND}') = (target_record_id IS NOT NULL)),
    CHECK (update_evidence IS NULL OR (write_kind = '${UPDATE_WRITE_KIND}' AND result IS NOT NULL)),
    CHECK (write_kind IS NOT '${UPDATE_WRITE_KIND}' OR result IS NOT '${VERIFIED_RESULT}' OR update_evidence IS NOT NULL)
  ) STRICT`,
  `INSERT INTO write_results_v9 (${VERSION_8_WRITE_RESULT_COLUMNS}, write_kind)
    SELECT ${VERSION_8_WRITE_RESULT_COLUMNS}, '${CREATE_WRITE_KIND}' FROM write_results`,
  'DROP TABLE write_results',
  'ALTER TABLE write_results_v9 RENAME TO write_results',
  'CREATE INDEX write_results_scenario_recorded ON write_results (scenario_id, recorded_at)',
  'CREATE INDEX write_results_profile ON write_results (profile_id)',
  `ALTER TABLE discovery_candidates ADD COLUMN templated_identity_digests TEXT
    CHECK (templated_identity_digests IS NULL OR (${jsonArrayCheck('templated_identity_digests')}))`,
  `ALTER TABLE execution_grants ADD COLUMN target_record_id TEXT
    CHECK (target_record_id IS NULL OR (${usableRecordIdCheck('target_record_id')}))`,
]);

/**
 * 版 10 の表（Task 32 の設計書 4.1 の「報告の確かめの記録」。T32g）。版 1〜9 は公開済みなので変えない。版 10 は未公開なので、CHECK の値の一覧は今の
 * 名前つきの一覧を参照する（今の文は `tests/integration/control-store-v10.test.ts` の SHA-256 で固定している）。
 * - ジョブの表に、書き込みのジョブの報告の確かめの結果の列（`write_report_check`）を足す（表は作り直さない。今の行は残り、列は null）。値は
 *   `WRITE_REPORT_CHECKS`（`VALID` か理由のコード）。書き込みのジョブ（`WORKER_WRITE_JOB_KINDS`）だけが持てる。ジョブの管理が、書き込みの結果の締めと
 *   同じ時点で 1 回だけ書く（`job-store.ts` の `recordWriteReportCheck`）。画面は、この列で報告を配るかを決める。
 * - `write_results` と、その書き手（`scenario-store.ts`）は変えない。
 */
const VERSION_10_STATEMENTS: readonly string[] = Object.freeze([
  `ALTER TABLE jobs ADD COLUMN write_report_check TEXT
    CHECK (write_report_check IS NULL OR (write_report_check IN (${sqlListOf(WRITE_REPORT_CHECKS)})
      AND job_kind IN (${sqlListOf(WORKER_WRITE_JOB_KINDS)})))`,
]);

/** 版の一覧（凍結）。 */
export const CONTROL_MIGRATIONS: readonly ControlMigration[] = Object.freeze([
  Object.freeze({ version: 1, statements: VERSION_1_STATEMENTS, seed: seedVersion1 }),
  Object.freeze({ version: 2, statements: VERSION_2_STATEMENTS }),
  Object.freeze({ version: 3, statements: VERSION_3_STATEMENTS }),
  Object.freeze({ version: 4, statements: VERSION_4_STATEMENTS }),
  Object.freeze({ version: 5, statements: VERSION_5_STATEMENTS }),
  Object.freeze({ version: 6, statements: VERSION_6_STATEMENTS }),
  Object.freeze({ version: 7, statements: VERSION_7_STATEMENTS }),
  Object.freeze({ version: 8, statements: VERSION_8_STATEMENTS }),
  Object.freeze({ version: 9, statements: VERSION_9_STATEMENTS }),
  Object.freeze({ version: 10, statements: VERSION_10_STATEMENTS }),
]);

/** この BeakSight が知る最新の版。 */
export const CONTROL_SCHEMA_VERSION: number = CONTROL_MIGRATIONS.at(-1)?.version ?? 0;

/**
 * BeakSight の管理データの印（`PRAGMA application_id`。32 bit の符号つきの正の整数）。
 * ASCII の `BkSt`（0x42 0x6B 0x53 0x74）。
 */
export const CONTROL_DB_APPLICATION_ID = 0x426b5374;

/** `application_id` が書かれていない（新しいファイル）ときの値。 */
const UNSET_APPLICATION_ID = 0;
/** 版の管理を始める前の `user_version`。 */
const UNVERSIONED = 0;
/** 版の一覧の最初の版。 */
const FIRST_SCHEMA_VERSION = 1;

/** データベースが誰のものか、どの版かの事実。 */
export interface ControlDatabaseIdentity {
  readonly applicationId: number;
  readonly userVersion: number;
  /** `sqlite_schema` の行の数（表、索引、view、trigger）。 */
  readonly schemaObjectCount: number;
}

/** 版の管理の選択肢。 */
export interface ControlMigrationOptions {
  /** 今の時刻（既定は `new Date()`）。`store_meta` などの日時に使う。 */
  readonly now?: () => Date;
}

/** 版の管理の結果。 */
export interface ControlMigrationOutcome {
  /** 開いたときの版（0 は、まだ版の管理が始まっていない新しいデータベース）。 */
  readonly foundSchemaVersion: number;
  /** 版の管理の後の版。 */
  readonly schemaVersion: number;
}

/** 1 行 1 列の結果の整数を読む。整数でなければ、壊れているとみなす。 */
const readInteger = (connection: SqliteConnection, sql: string, column: string): number => {
  const row = connection.prepare(sql).get() as Record<string, unknown> | undefined;
  const value = row?.[column];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new ControlStoreError('DATABASE_INTEGRITY_FAILED', `${sql} did not return an integer`);
  }
  return value;
};

/** データベースが誰のものか、どの版かを読む（読むだけ。書かない）。 */
export const readControlDatabaseIdentity = (connection: SqliteConnection): ControlDatabaseIdentity => ({
  applicationId: readInteger(connection, 'PRAGMA application_id', 'application_id'),
  userVersion: readInteger(connection, 'PRAGMA user_version', 'user_version'),
  schemaObjectCount: readInteger(connection, 'SELECT count(*) AS object_count FROM sqlite_schema', 'object_count'),
});

/**
 * BeakSight の管理データとして扱ってよいかを確かめる（何も書かない）。
 * - `application_id` が別の値 → `NOT_A_BEAKSIGHT_DATABASE`。
 * - `application_id` が未設定（0）なのに、版や表がある → ほかのプログラムのデータベース（`NOT_A_BEAKSIGHT_DATABASE`）。
 * - `user_version` が `latestVersion` より大きい → `DATABASE_FROM_NEWER_VERSION`。
 * - `user_version` が 0 なのに表がある → `NOT_A_BEAKSIGHT_DATABASE`（設計書 4.3 の 7）。
 */
export const assertControlDatabaseIdentity = (identity: ControlDatabaseIdentity, latestVersion: number): void => {
  const { applicationId, userVersion, schemaObjectCount } = identity;
  if (applicationId !== UNSET_APPLICATION_ID && applicationId !== CONTROL_DB_APPLICATION_ID) {
    throw new ControlStoreError('NOT_A_BEAKSIGHT_DATABASE', `application_id ${applicationId} is not the BeakSight control database`);
  }
  if (applicationId === UNSET_APPLICATION_ID && userVersion !== UNVERSIONED) {
    throw new ControlStoreError('NOT_A_BEAKSIGHT_DATABASE', `user_version ${userVersion} is set without the BeakSight application_id`);
  }
  if (userVersion > latestVersion) {
    throw new ControlStoreError(
      'DATABASE_FROM_NEWER_VERSION',
      `user_version ${userVersion} is newer than the latest known version ${latestVersion}`,
    );
  }
  if (userVersion === UNVERSIONED && schemaObjectCount > 0) {
    throw new ControlStoreError('NOT_A_BEAKSIGHT_DATABASE', `user_version is 0 but ${schemaObjectCount} schema objects exist`);
  }
};

/** 版の一覧が 1 から始まり 1 ずつ増えるか（呼び出し側の誤りは `RangeError`）。 */
const assertMigrationList = (migrations: readonly ControlMigration[]): void => {
  if (migrations.length === 0) {
    throw new RangeError('the control migration list must not be empty');
  }
  migrations.forEach((migration, index) => {
    if (migration.version !== FIRST_SCHEMA_VERSION + index) {
      throw new RangeError(`the control migration at index ${index} must be version ${FIRST_SCHEMA_VERSION + index}`);
    }
  });
};

/**
 * 版の管理を行う。足りない版だけを、版ごとに 1 つのトランザクションで行う。
 * 失敗したら、その版のトランザクションを元に戻し、`MIGRATION_FAILED`（busy なら `DATABASE_LOCKED` など、分類できる理由）で止める。
 */
export const runControlMigrations = (
  connection: SqliteConnection,
  migrations: readonly ControlMigration[] = CONTROL_MIGRATIONS,
  options: ControlMigrationOptions = {},
): ControlMigrationOutcome => {
  const now = options.now ?? ((): Date => new Date());
  assertMigrationList(migrations);
  const latestVersion = migrations.length;
  const found = readControlDatabaseIdentity(connection);
  assertControlDatabaseIdentity(found, latestVersion);

  for (const migration of migrations) {
    if (migration.version <= found.userVersion) {
      continue;
    }
    try {
      withWriteTransaction({ connection }, (writer) => {
        // 待っている間に、別の process が済ませたかもしれない。トランザクションの中で読み直す。
        const current = readControlDatabaseIdentity(writer);
        assertControlDatabaseIdentity(current, latestVersion);
        if (current.userVersion >= migration.version) {
          return;
        }
        writer.exec(`PRAGMA application_id = ${CONTROL_DB_APPLICATION_ID}`);
        for (const statement of migration.statements) {
          writer.exec(statement);
        }
        migration.seed?.(writer, {
          appliedAt: formatCompactUtcTimestamp(now(), 'control store migration time'),
          latestVersion,
        });
        writer.exec(`PRAGMA user_version = ${migration.version}`);
      });
    } catch (error) {
      throw toControlStoreError(error, 'MIGRATION_FAILED', `migration to version ${migration.version} failed`);
    }
  }

  return Object.freeze({
    foundSchemaVersion: found.userVersion,
    schemaVersion: readInteger(connection, 'PRAGMA user_version', 'user_version'),
  });
};
