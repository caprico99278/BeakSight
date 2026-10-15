// 監査のジョブの行（管理データの版 2 の `jobs`。版 3 で作り直し、最後の認証の状態と止まったページの URL の列を足した。T25d）の読み書きの
// 唯一の owner（Task 24 の設計書 4.4。T24e）。版 4 で作り直し、ジョブの種類（`job_kind`）の列を足した。ジョブを作るときは、自動ログインの
// 試し始めた記録（`auto_login_attempts` の行）も同じトランザクションで書く（T26c。試しの結果と止めた状態は `auto-login-store.ts`）。
// - 書き込みは、すべて `withWriteTransaction`（`BEGIN IMMEDIATE`）の中で行う。読むだけの関数（`readJob`、`readAllJobs`）は、読むだけの入口
//   `withReadTransaction`（deferred の `BEGIN` と `PRAGMA query_only`。T24e round 2）を通す（書き込みのロックを取らず、読む中の書き込みは
//   SQLite が拒む）。生の接続（`ControlDatabase` の接続）を、このファイルで直接参照しない（Architecture Gate
//   `control-store-boundary.test.ts` の (f)）。SQL の書き込みの文は、`withWriteTransaction` の引数の中でだけ使う（同じ Gate の (g)）。
// - 終わりの状態への書き換えは、終わっていない行だけを書き換える（2 回目以降は何もしない。終わりの状態を上書きしない）。
// - T26d-2: 画面に要る値に、ジョブの種類と、そのジョブの自動ログインの試しの結果（`auto_login_attempts` の行。結果・送信・`Retry-After` の期限・
//   フォームの確かめの理由のコード。値を持たない）を足した。ログインの検証の成功の終わり（`recordLoginCheckFinished`）と、プロファイルの終わって
//   いないジョブの有無（`hasActiveJobForProfile`。資格情報の変更の確かめ）も足した。
// - 読んだ行は、名前つきの一覧と契約の部品（`validateWorkerToParentMessage`、`isRunId`、`isPortableRelativeArtifactPath`）で確かめてから、
//   凍結した写しにする。壊れた行は `ControlStoreError`（`DATABASE_INTEGRITY_FAILED`）で止める。
import { isPortableRelativeArtifactPath } from '../../core/artifact-layout.js';
import { RUN_STATUSES, type RunId, type RunProgressReport, type RunStatus } from '../../core/contracts.js';
import { isRunId } from '../../core/ids.js';
import { deepFreeze } from '../../core/immutable.js';
import {
  AUTOMATED_LOGIN_RESULTS,
  AUTOMATED_LOGIN_SUBMISSIONS,
  type AutomatedLoginResult,
  type AutomatedLoginSubmission,
} from '../auth/automated-login-results.js';
import { MIN_PROFILE_REVISION } from '../contracts.js';
import type { ControlDatabase } from '../store/control-database.js';
import type { SqliteConnection } from '../store/sqlite-module.js';
import { ControlStoreError } from '../store/store-errors.js';
import { withReadTransaction, withWriteTransaction } from '../store/transaction.js';
import {
  WORKER_AUTH_STATES,
  WORKER_JOB_ID_PATTERN,
  WORKER_LOGIN_FORM_INVALID_REASONS,
  WORKER_OUTCOME_KINDS,
  WORKER_PROTOCOL_VERSION,
  WORKER_SESSION_LOST_STATE,
  WORKER_WRITE_JOB_KINDS,
  validateWorkerToParentMessage,
  type WorkerAuthState,
  type WorkerLoginFormInvalidReason,
  type WorkerOutcomeKind,
  type WorkerRunNotice,
  type WorkerRunOutcome,
} from '../worker-protocol.js';
import {
  ACTIVE_AUDIT_JOB_STATES,
  AUDIT_JOB_FAILURE_REASONS,
  AUDIT_JOB_KINDS,
  AUDIT_JOB_STATES,
  WRITE_REPORT_CHECKS,
  type AuditJobFailureReason,
  type AuditJobKind,
  type AuditJobState,
  type WriteReportCheck,
} from './job-records.js';

/**
 * ジョブの自動ログインの試しの結果（T26d-2。`auto_login_attempts` の行から。値を持たない）。結果と送信は、まだ決まっていなければ `null`。
 */
export interface AuditJobAutoLoginAttemptView {
  readonly result: AutomatedLoginResult | null;
  readonly submitted: AutomatedLoginSubmission | null;
  /** 429 のときだけ、次に試してよい時刻（UTC の 14 桁）。 */
  readonly retryAfterUntil: string | null;
  /** フォームの確かめで止まったときだけ、理由のコード。 */
  readonly formInvalidReason: WorkerLoginFormInvalidReason | null;
}

/** 画面に要る、ジョブの値（凍結）。 */
export interface AuditJobView {
  readonly jobId: string;
  /** ジョブの種類（T26d-2）。 */
  readonly jobKind: AuditJobKind;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly state: AuditJobState;
  readonly startNew: boolean;
  readonly runId: RunId | null;
  /** 出力先の中の Run のディレクトリの相対パス（区切りは `/`）。 */
  readonly runDirectory: string | null;
  readonly exitCode: number | null;
  /** 中核の結果の Run の状態のまま（書き換えない。I15）。 */
  readonly resultRunStatus: RunStatus | null;
  /** 中核の結果の種類（終わり方）。 */
  readonly endKind: WorkerOutcomeKind | null;
  readonly lastProgress: RunProgressReport | null;
  readonly lastNotice: WorkerRunNotice | null;
  /** 日時は UTC の 14 桁（`formatCompactUtcTimestamp`）。 */
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly lastHeartbeatAt: string | null;
  readonly stopRequestedAt: string | null;
  readonly failureReason: AuditJobFailureReason | null;
  /** 最後の認証の状態（認証つきの監査だけ。値と秘密を含まない。T25d）。 */
  readonly lastAuthState: WorkerAuthState | null;
  /**
   * セッションが切れて止まったページの URL（`SESSION_LOST` を受けたときだけ。Ledger の URL と同じ伏せ字の後の値。画面が「このページを
   * 読まないパスに足す」を案内するため。T25d）。
   */
  readonly sessionLostUrl: string | null;
  /** 自動ログインの試しの結果（T26d-2。自動ログインのジョブだけ。ほかは `null`）。 */
  readonly autoLoginAttempt: AuditJobAutoLoginAttemptView | null;
  /**
   * 書き込みのジョブの報告の確かめの結果（T32g。管理データの版 10。書き込みのジョブだけが持ち、締めるまでと、ほかの種類のジョブは `null`）。画面は
   * `VALID` のときだけ報告を配る。
   */
  readonly writeReportCheck: WriteReportCheck | null;
}

/** 作るジョブ（`STARTING`）。 */
export interface NewAuditJob {
  readonly jobId: string;
  /** ジョブの種類（T26c。既定の値はない。作る側が必ず明示する）。 */
  readonly jobKind: AuditJobKind;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly startNew: boolean;
  readonly createdAt: string;
  /**
   * 自動ログインの試し始めた記録（T26c。Task 26 の設計書 4.5）。あれば、ジョブの行と同じトランザクションで `auto_login_attempts` に
   * 書く（試し始めた時刻はジョブを作った時刻）。開始の前の確かめを通った自動ログインのジョブだけが渡す。
   */
  readonly autoLoginAttempt?: NewAutoLoginAttempt;
}

/** 自動ログインの試し始めた記録の値（T26c）。資格情報の値は受けない（改訂の番号だけ。秘密でない）。 */
export interface NewAutoLoginAttempt {
  /** 開始の前の確かめで読んだ、資格情報のファイルの改訂の番号。 */
  readonly credentialRevision: number;
}

/**
 * 作る前の確かめ（同じトランザクションの中で呼ぶ。拒むときは理由の値、受けるときは `null`）。トランザクションの接続を受ける（管理のロックを
 * 同じトランザクションの中で確かめるため。T24h-4）。読むだけに使い、書かない。
 */
export type NewAuditJobGuard<Reason extends string> = (connection: SqliteConnection) => Reason | null;

/** 作った結果。 */
export type NewAuditJobResult<Reason extends string> =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: Reason | 'JOB_ALREADY_ACTIVE' };

/** `jobs` の 1 行。 */
interface JobRow {
  readonly job_id: string;
  readonly profile_id: string;
  readonly profile_revision: number;
  readonly state: string;
  readonly start_new: number;
  readonly run_id: string | null;
  readonly run_directory: string | null;
  readonly exit_code: number | null;
  readonly run_status: string | null;
  readonly end_kind: string | null;
  readonly last_progress: string | null;
  readonly last_notice: string | null;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly last_heartbeat_at: string | null;
  readonly stop_requested_at: string | null;
  readonly failure_reason: string | null;
  readonly last_auth_state: string | null;
  readonly session_lost_url: string | null;
  readonly job_kind: string;
  readonly write_report_check: string | null;
  /** そのジョブの自動ログインの試しの行の ID（試しがなければ `null`。T26d-2）。 */
  readonly attempt_id: number | null;
  readonly attempt_result: string | null;
  readonly attempt_submitted: string | null;
  readonly attempt_retry_after_until: string | null;
  readonly attempt_form_invalid_reason: string | null;
}

/** 終わっていない状態の SQL の値の一覧（`?` の位置に JSON の配列で渡す）。 */
const ACTIVE_STATES_JSON = JSON.stringify(ACTIVE_AUDIT_JOB_STATES);
/** 真偽を表す整数（`start_new`）。 */
const SQL_TRUE = 1;
const SQL_FALSE = 0;
/** 1 回の変更で書き換える行の数。 */
const ONE_ROW = 1;

const JOB_COLUMNS = [
  'job_id', 'profile_id', 'profile_revision', 'state', 'start_new', 'run_id', 'run_directory', 'exit_code', 'run_status', 'end_kind',
  'last_progress', 'last_notice', 'created_at', 'started_at', 'finished_at', 'last_heartbeat_at', 'stop_requested_at', 'failure_reason',
  'last_auth_state', 'session_lost_url', 'job_kind', 'write_report_check',
].map((column) => `jobs.${column}`).join(', ');
/** そのジョブの自動ログインの試しの列（T26d-2。1 つのジョブで試しは 1 つまで。`job_id` は一意）。 */
const ATTEMPT_COLUMNS = [
  'attempts.attempt_id AS attempt_id',
  'attempts.result AS attempt_result',
  'attempts.submitted AS attempt_submitted',
  'attempts.retry_after_until AS attempt_retry_after_until',
  'attempts.form_invalid_reason AS attempt_form_invalid_reason',
].join(', ');
const SELECT_JOBS_FROM = `SELECT ${JOB_COLUMNS}, ${ATTEMPT_COLUMNS} FROM jobs LEFT JOIN auto_login_attempts AS attempts ON attempts.job_id = jobs.job_id`;
const SELECT_JOB_SQL = `${SELECT_JOBS_FROM} WHERE jobs.job_id = ?`;
const SELECT_ALL_JOBS_SQL = `${SELECT_JOBS_FROM} ORDER BY jobs.created_at DESC, jobs.job_id DESC`;
/** プロファイルの終わっていないジョブの数（T26d-2。資格情報の変更の確かめ）。 */
const COUNT_ACTIVE_PROFILE_JOBS_SQL =
  'SELECT count(*) AS active FROM jobs WHERE profile_id = ? AND state IN (SELECT value FROM json_each(?))';
const SELECT_ACTIVE_JOB_IDS_SQL = 'SELECT job_id FROM jobs WHERE state IN (SELECT value FROM json_each(?)) ORDER BY job_id';
const INSERT_JOB_SQL =
  'INSERT INTO jobs (job_id, profile_id, profile_revision, state, start_new, created_at, job_kind) VALUES (?, ?, ?, ?, ?, ?, ?)';
/** 自動ログインの試し始めた記録（T26c。結果は未確定の `null`）。 */
const INSERT_AUTO_LOGIN_ATTEMPT_SQL =
  'INSERT INTO auto_login_attempts (profile_id, job_id, started_at, credential_revision) VALUES (?, ?, ?, ?)';
const UPDATE_WORKER_PID_SQL = 'UPDATE jobs SET worker_pid = ? WHERE job_id = ?';
const UPDATE_RUN_STARTED_SQL = `UPDATE jobs SET state = CASE WHEN state = 'STARTING' THEN 'RUNNING' ELSE state END,
  run_id = ?, run_directory = ?, started_at = ? WHERE job_id = ? AND state IN (SELECT value FROM json_each(?))`;
const UPDATE_PROGRESS_SQL = 'UPDATE jobs SET last_progress = ? WHERE job_id = ? AND state IN (SELECT value FROM json_each(?))';
const UPDATE_NOTICE_SQL = 'UPDATE jobs SET last_notice = ? WHERE job_id = ? AND state IN (SELECT value FROM json_each(?))';
const UPDATE_AUTH_STATE_SQL = `UPDATE jobs SET last_auth_state = ?, session_lost_url = COALESCE(?, session_lost_url)
  WHERE job_id = ? AND state IN (SELECT value FROM json_each(?))`;
const UPDATE_HEARTBEAT_SQL = 'UPDATE jobs SET last_heartbeat_at = ? WHERE job_id = ? AND state IN (SELECT value FROM json_each(?))';
const UPDATE_STOPPING_SQL = `UPDATE jobs SET state = 'STOPPING', stop_requested_at = COALESCE(stop_requested_at, ?)
  WHERE job_id = ? AND state IN (SELECT value FROM json_each(?))`;
const UPDATE_FINISHED_SQL = `UPDATE jobs SET state = 'FINISHED', exit_code = ?, run_status = ?, end_kind = ?, finished_at = ?
  WHERE job_id = ? AND state IN (SELECT value FROM json_each(?))`;
const UPDATE_ENDED_SQL = `UPDATE jobs SET state = ?, failure_reason = ?, exit_code = COALESCE(?, exit_code), finished_at = ?
  WHERE job_id = ? AND state IN (SELECT value FROM json_each(?))`;
const UPDATE_EXIT_CODE_SQL = 'UPDATE jobs SET exit_code = ? WHERE job_id = ? AND exit_code IS NULL';
/** 書き込みのジョブの報告の確かめの結果（T32g。まだ記録していない書き込みのジョブの行だけ。1 回だけ書く）。 */
const UPDATE_WRITE_REPORT_CHECK_SQL = `UPDATE jobs SET write_report_check = ?
  WHERE job_id = ? AND write_report_check IS NULL AND job_kind IN (SELECT value FROM json_each(?))`;
/** 書き込みのジョブの種類（SQL の値の一覧。`?` の位置に JSON の配列で渡す）。 */
const WRITE_JOB_KINDS_JSON = JSON.stringify(WORKER_WRITE_JOB_KINDS);
/** ログインの検証の成功の終わり（T26d-2。Run を作らないので、Run の状態と結果の種類は `null` のまま）。 */
const UPDATE_LOGIN_CHECK_FINISHED_SQL = `UPDATE jobs SET state = 'FINISHED', exit_code = ?, finished_at = ?
  WHERE job_id = ? AND state IN (SELECT value FROM json_each(?))`;
const SELECT_UNOWNED_ACTIVE_JOBS_SQL = `SELECT job_id, worker_pid, created_at, last_heartbeat_at FROM jobs
  WHERE state IN (SELECT value FROM json_each(?)) AND job_id NOT IN (SELECT value FROM json_each(?)) ORDER BY job_id`;
const UPDATE_ONE_INTERRUPTED_SQL = `UPDATE jobs SET state = 'INTERRUPTED', failure_reason = ?, finished_at = ?
  WHERE job_id = ? AND state IN (SELECT value FROM json_each(?))`;

/** SQLite の一意の制約の違反か（終わっていないジョブの一意の部分索引）。 */
const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Error && /\bUNIQUE constraint failed\b/u.test(error.message);

const integrityError = (jobId: string, detail: string): ControlStoreError =>
  new ControlStoreError('DATABASE_INTEGRITY_FAILED', `stored job ${jobId}: ${detail}`);

const isOneOf = <Value extends string>(values: readonly Value[], value: unknown): value is Value =>
  typeof value === 'string' && (values as readonly string[]).includes(value);

/** 保存した JSON を、契約のメッセージに入れて確かめる（壊れていれば `null` ではなく誤り）。 */
const parseStoredJson = (jobId: string, column: string, text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw integrityError(jobId, `${column} is not JSON`);
  }
};

const progressOf = (row: JobRow): RunProgressReport | null => {
  if (row.last_progress === null) {
    return null;
  }
  const checked = validateWorkerToParentMessage({
    protocol: WORKER_PROTOCOL_VERSION,
    type: 'PROGRESS',
    report: parseStoredJson(row.job_id, 'last_progress', row.last_progress),
  });
  if (!checked.ok || checked.message.type !== 'PROGRESS') {
    throw integrityError(row.job_id, 'last_progress is not a progress report');
  }
  return checked.message.report;
};

const noticeOf = (row: JobRow): WorkerRunNotice | null => {
  if (row.last_notice === null) {
    return null;
  }
  const checked = validateWorkerToParentMessage({
    protocol: WORKER_PROTOCOL_VERSION,
    type: 'NOTICE',
    notice: parseStoredJson(row.job_id, 'last_notice', row.last_notice),
  });
  if (!checked.ok || checked.message.type !== 'NOTICE') {
    throw integrityError(row.job_id, 'last_notice is not a notice');
  }
  return checked.message.notice;
};

/** そのジョブの自動ログインの試しの結果（試しがなければ `null`。T26d-2）。 */
const autoLoginAttemptOf = (row: JobRow): AuditJobAutoLoginAttemptView | null => {
  if (row.attempt_id === null) {
    return null;
  }
  if (row.attempt_result !== null && !isOneOf(AUTOMATED_LOGIN_RESULTS, row.attempt_result)) {
    throw integrityError(row.job_id, 'the auto login result is not in the closed list');
  }
  if (row.attempt_submitted !== null && !isOneOf(AUTOMATED_LOGIN_SUBMISSIONS, row.attempt_submitted)) {
    throw integrityError(row.job_id, 'the auto login submission is not in the closed list');
  }
  if (row.attempt_form_invalid_reason !== null && !isOneOf(WORKER_LOGIN_FORM_INVALID_REASONS, row.attempt_form_invalid_reason)) {
    throw integrityError(row.job_id, 'the form check reason is not in the closed list');
  }
  return {
    result: row.attempt_result,
    submitted: row.attempt_submitted,
    retryAfterUntil: row.attempt_retry_after_until,
    formInvalidReason: row.attempt_form_invalid_reason,
  } as AuditJobAutoLoginAttemptView;
};

/** 止まったページの URL として記録できる値か（契約の `AUTH_STATE` の `SESSION_LOST` の規則で確かめる）。 */
const isSessionLostUrl = (url: string): boolean => validateWorkerToParentMessage({
  protocol: WORKER_PROTOCOL_VERSION,
  type: 'AUTH_STATE',
  state: WORKER_SESSION_LOST_STATE,
  sessionLostUrl: url,
}).ok;

/** 行を確かめて、画面に要る値にする。 */
const viewOf = (row: JobRow): AuditJobView => {
  const { job_id: jobId } = row;
  if (!WORKER_JOB_ID_PATTERN.test(jobId)) {
    throw integrityError(jobId, 'job_id is not a job id');
  }
  if (!isOneOf(AUDIT_JOB_STATES, row.state)) {
    throw integrityError(jobId, `state ${row.state} is not in the closed list`);
  }
  if (!isOneOf(AUDIT_JOB_KINDS, row.job_kind)) {
    throw integrityError(jobId, 'job_kind is not in the closed list');
  }
  if (!Number.isSafeInteger(row.profile_revision) || row.profile_revision < MIN_PROFILE_REVISION) {
    throw integrityError(jobId, 'profile_revision is not a revision');
  }
  if (row.run_id !== null && !isRunId(row.run_id)) {
    throw integrityError(jobId, 'run_id is not a run id');
  }
  if (row.run_directory !== null && !isPortableRelativeArtifactPath(row.run_directory)) {
    throw integrityError(jobId, 'run_directory is not a portable relative path');
  }
  if (row.run_status !== null && !isOneOf(RUN_STATUSES, row.run_status)) {
    throw integrityError(jobId, 'run_status is not a run status');
  }
  if (row.end_kind !== null && !isOneOf(WORKER_OUTCOME_KINDS, row.end_kind)) {
    throw integrityError(jobId, 'end_kind is not an outcome kind');
  }
  if (row.failure_reason !== null && !isOneOf(AUDIT_JOB_FAILURE_REASONS, row.failure_reason)) {
    throw integrityError(jobId, 'failure_reason is not in the closed list');
  }
  if (row.last_auth_state !== null && !isOneOf(WORKER_AUTH_STATES, row.last_auth_state)) {
    throw integrityError(jobId, 'last_auth_state is not in the closed list');
  }
  if (row.session_lost_url !== null && !isSessionLostUrl(row.session_lost_url)) {
    throw integrityError(jobId, 'session_lost_url is not a session lost URL');
  }
  if (row.write_report_check !== null && !isOneOf(WRITE_REPORT_CHECKS, row.write_report_check)) {
    throw integrityError(jobId, 'write_report_check is not in the closed list');
  }
  return deepFreeze({
    jobId,
    jobKind: row.job_kind,
    profileId: row.profile_id,
    profileRevision: row.profile_revision,
    state: row.state,
    startNew: row.start_new === SQL_TRUE,
    runId: row.run_id,
    runDirectory: row.run_directory,
    exitCode: row.exit_code,
    resultRunStatus: row.run_status,
    endKind: row.end_kind,
    lastProgress: progressOf(row),
    lastNotice: noticeOf(row),
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    stopRequestedAt: row.stop_requested_at,
    failureReason: row.failure_reason,
    lastAuthState: row.last_auth_state,
    sessionLostUrl: row.session_lost_url,
    autoLoginAttempt: autoLoginAttemptOf(row),
    writeReportCheck: row.write_report_check,
  } as AuditJobView);
};

const readRow = (connection: SqliteConnection, jobId: string): JobRow | undefined =>
  connection.prepare(SELECT_JOB_SQL).get(jobId) as JobRow | undefined;

const activeJobIdsOf = (connection: SqliteConnection): readonly string[] =>
  (connection.prepare(SELECT_ACTIVE_JOB_IDS_SQL).all(ACTIVE_STATES_JSON) as { job_id: string }[]).map((row) => row.job_id);

/** 変えた行の数が 1 か（終わっていない行だけを書き換える文で、書き換えたか）。 */
const changedOne = (changes: number | bigint): boolean => Number(changes) === ONE_ROW;

/**
 * `STARTING` のジョブを作る。同じトランザクションの中で、`guard`（プロファイルの確かめ直し）と、終わっていないジョブがないことを確かめる。
 * 終わっていないジョブがあれば（一意の部分索引の違反を含む）、`JOB_ALREADY_ACTIVE`。
 * T26c: ジョブの種類を必ず書く。自動ログインの試し始めた記録（`job.autoLoginAttempt`）があれば、同じトランザクションの中で書く（どちらかが
 * 書けなければ、両方とも元に戻る。Task 26 の設計書 4.5、変更履歴の「Blocker: T26c」の行の (1)）。
 */
export const createStartingJob = <Reason extends string>(
  database: ControlDatabase,
  job: NewAuditJob,
  guard: NewAuditJobGuard<Reason>,
): NewAuditJobResult<Reason> => {
  if (!isOneOf(AUDIT_JOB_KINDS, job.jobKind)) {
    throw new RangeError('the job kind must be in the closed list');
  }
  try {
    return withWriteTransaction(database, (connection): NewAuditJobResult<Reason> => {
      const rejection = guard(connection);
      if (rejection !== null) {
        return Object.freeze({ ok: false, reason: rejection });
      }
      if (activeJobIdsOf(connection).length > 0) {
        return Object.freeze({ ok: false, reason: 'JOB_ALREADY_ACTIVE' });
      }
      connection.prepare(INSERT_JOB_SQL).run(
        job.jobId, job.profileId, job.profileRevision, ACTIVE_AUDIT_JOB_STATES[0], job.startNew ? SQL_TRUE : SQL_FALSE, job.createdAt, job.jobKind,
      );
      if (job.autoLoginAttempt !== undefined) {
        connection.prepare(INSERT_AUTO_LOGIN_ATTEMPT_SQL).run(job.profileId, job.jobId, job.createdAt, job.autoLoginAttempt.credentialRevision);
      }
      return Object.freeze({ ok: true });
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return Object.freeze({ ok: false, reason: 'JOB_ALREADY_ACTIVE' });
    }
    throw error;
  }
};

/** ワーカーの process の ID を記録する。 */
export const recordWorkerPid = (database: ControlDatabase, jobId: string, workerPid: number): void => {
  withWriteTransaction(database, (connection) => {
    connection.prepare(UPDATE_WORKER_PID_SQL).run(workerPid, jobId);
  });
};

/** Run が始まった（`STARTING` なら `RUNNING` にする。`STOPPING` は変えない）。終わっていない行だけ。 */
export const recordRunStarted = (
  database: ControlDatabase,
  jobId: string,
  run: { readonly runId: RunId; readonly runDirectory: string; readonly startedAt: string },
): boolean => withWriteTransaction(database, (connection) =>
  changedOne(connection.prepare(UPDATE_RUN_STARTED_SQL).run(run.runId, run.runDirectory, run.startedAt, jobId, ACTIVE_STATES_JSON).changes));

/** 最後の進み具合を記録する。終わっていない行だけ。 */
export const recordProgress = (database: ControlDatabase, jobId: string, report: RunProgressReport): boolean =>
  withWriteTransaction(database, (connection) =>
    changedOne(connection.prepare(UPDATE_PROGRESS_SQL).run(JSON.stringify(report), jobId, ACTIVE_STATES_JSON).changes));

/** 最後の知らせを記録する。終わっていない行だけ。 */
export const recordNotice = (database: ControlDatabase, jobId: string, notice: WorkerRunNotice): boolean =>
  withWriteTransaction(database, (connection) =>
    changedOne(connection.prepare(UPDATE_NOTICE_SQL).run(JSON.stringify(notice), jobId, ACTIVE_STATES_JSON).changes));

/**
 * 最後の認証の状態を記録する（T25d）。止まったページの URL は、`SESSION_LOST` のときだけ渡す（`null` なら、前の値を残す）。終わっていない
 * 行だけ。値と秘密は受けない（契約の `AUTH_STATE` を検証してから呼ぶ）。
 */
export const recordAuthState = (database: ControlDatabase, jobId: string, state: WorkerAuthState, sessionLostUrl: string | null): boolean =>
  withWriteTransaction(database, (connection) =>
    changedOne(connection.prepare(UPDATE_AUTH_STATE_SQL).run(state, sessionLostUrl, jobId, ACTIVE_STATES_JSON).changes));

/** 生きている合図の時刻を記録する。終わっていない行だけ。 */
export const recordHeartbeat = (database: ControlDatabase, jobId: string, at: string): boolean =>
  withWriteTransaction(database, (connection) =>
    changedOne(connection.prepare(UPDATE_HEARTBEAT_SQL).run(at, jobId, ACTIVE_STATES_JSON).changes));

/** 止める要求を送った（`STOPPING`。最初の要求の時刻を残す）。終わっていない行だけ。 */
export const recordStopping = (database: ControlDatabase, jobId: string, at: string): boolean =>
  withWriteTransaction(database, (connection) =>
    changedOne(connection.prepare(UPDATE_STOPPING_SQL).run(at, jobId, ACTIVE_STATES_JSON).changes));

/**
 * 中核の結果を記録して `FINISHED` にする（Run の状態と終了コードは、結果のまま）。終わっていない行だけ。Run の ID と Run のディレクトリは、
 * `RUN_STARTED` で記録したものを書き換えない（T24h-1 の M1。結果の値は、ジョブの管理が `RUN_STARTED` の値と照らし合わせてある）。
 */
export const recordFinished = (database: ControlDatabase, jobId: string, outcome: WorkerRunOutcome, at: string): boolean =>
  withWriteTransaction(database, (connection) => changedOne(connection.prepare(UPDATE_FINISHED_SQL).run(
    outcome.exitCode, outcome.runStatus, outcome.kind, at, jobId, ACTIVE_STATES_JSON,
  ).changes));

/** `FAILED` か `INTERRUPTED` にする（理由と、分かれば終了コード）。終わっていない行だけ。 */
export const recordEnded = (
  database: ControlDatabase,
  jobId: string,
  ended: {
    readonly state: Extract<AuditJobState, 'FAILED' | 'INTERRUPTED'>;
    readonly reason: AuditJobFailureReason;
    readonly exitCode: number | null;
    readonly at: string;
  },
): boolean => withWriteTransaction(database, (connection) => changedOne(connection.prepare(UPDATE_ENDED_SQL).run(
  ended.state, ended.reason, ended.exitCode, ended.at, jobId, ACTIVE_STATES_JSON,
).changes));

/**
 * ログインの検証が成功で終わった（T26d-2）: `FINISHED` にする（終了コードは、分かればワーカーの process の終了コード。Run の状態と結果の種類は
 * 持たない）。終わっていない行だけ。
 */
export const recordLoginCheckFinished = (database: ControlDatabase, jobId: string, exitCode: number | null, at: string): boolean =>
  withWriteTransaction(database, (connection) =>
    changedOne(connection.prepare(UPDATE_LOGIN_CHECK_FINISHED_SQL).run(exitCode, at, jobId, ACTIVE_STATES_JSON).changes));

/** プロファイルに、終わっていないジョブがあるか（T26d-2。資格情報の変更と削除を拒むかの確かめ）。 */
export const hasActiveJobForProfile = (database: ControlDatabase, profileId: string): boolean =>
  withReadTransaction(database, (connection) =>
    Number((connection.prepare(COUNT_ACTIVE_PROFILE_JOBS_SQL).get(profileId, ACTIVE_STATES_JSON) as { active: number }).active) > 0);

/**
 * 書き込みのジョブの報告の確かめの結果を記録する（T32g。Task 32 の設計書 4.1 の「報告の確かめの記録」）。ジョブの管理が、書き込みの結果の締めと
 * 同じ時点で 1 回だけ呼ぶ。まだ記録していない書き込みのジョブの行だけを書き、書いたら真（2 回目と、書き込みでないジョブは書かずに偽）。閉じた一覧の
 * 外の値は、呼び出し側の誤り（`RangeError`）。
 */
export const recordWriteReportCheck = (database: ControlDatabase, jobId: string, check: WriteReportCheck): boolean => {
  if (!isOneOf(WRITE_REPORT_CHECKS, check)) {
    throw new RangeError('the write report check must be one of WRITE_REPORT_CHECKS');
  }
  return withWriteTransaction(database, (connection) =>
    changedOne(connection.prepare(UPDATE_WRITE_REPORT_CHECK_SQL).run(check, jobId, WRITE_JOB_KINDS_JSON).changes));
};

/** 終わったジョブに、まだ記録のない終了コードを記録する（`FAILED` を受けた後にワーカーが終わったときなど）。 */
export const recordExitCode = (database: ControlDatabase, jobId: string, exitCode: number): void => {
  withWriteTransaction(database, (connection) => {
    connection.prepare(UPDATE_EXIT_CODE_SQL).run(exitCode, jobId);
  });
};

/**
 * ほかの管理の、終わっていないジョブ（T24h-6。`interruptActiveJobs` の `stillRunning` に渡す）。
 * - `workerPid`: 記録したワーカーの process の ID（起動の前は `null`）。
 * - `lastSeenAt`: 最後にワーカーの合図を記録した時刻（なければ行を作った時刻。UTC の 14 桁）。
 */
export interface UnownedActiveJob {
  readonly jobId: string;
  readonly workerPid: number | null;
  readonly lastSeenAt: string;
}

/**
 * 終わっていないジョブ（`exceptJobIds` を除く）を、すべて `INTERRUPTED`（`reason`）にする。ただし `stillRunning` が真のジョブ（ほかの管理の
 * ワーカーがまだ動いている。T24h-6）は直さない。書き換えた行の数を返す。`allowed`（同じトランザクションの
 * 中の確かめ。管理のロックを持っているか。T24h-4）が偽なら、何も書き換えずに 0。
 */
export const interruptActiveJobs = (
  database: ControlDatabase,
  reason: AuditJobFailureReason,
  at: string,
  exceptJobIds: readonly string[],
  allowed: (connection: SqliteConnection) => boolean = () => true,
  stillRunning: (job: UnownedActiveJob) => boolean = () => false,
): number => withWriteTransaction(database, (connection) => {
  if (!allowed(connection)) {
    return 0;
  }
  const rows = connection.prepare(SELECT_UNOWNED_ACTIVE_JOBS_SQL).all(ACTIVE_STATES_JSON, JSON.stringify(exceptJobIds)) as unknown as {
    readonly job_id: string;
    readonly worker_pid: number | null;
    readonly created_at: string;
    readonly last_heartbeat_at: string | null;
  }[];
  let interrupted = 0;
  for (const row of rows) {
    const job: UnownedActiveJob = Object.freeze({
      jobId: row.job_id,
      workerPid: row.worker_pid,
      lastSeenAt: row.last_heartbeat_at ?? row.created_at,
    });
    if (!stillRunning(job)) {
      interrupted += Number(connection.prepare(UPDATE_ONE_INTERRUPTED_SQL).run(reason, at, row.job_id, ACTIVE_STATES_JSON).changes);
    }
  }
  return interrupted;
});

/** 1 つのジョブ。なければ `null`。 */
export const readJob = (database: ControlDatabase, jobId: string): AuditJobView | null =>
  withReadTransaction(database, (connection) => {
    const row = readRow(connection, jobId);
    return row === undefined ? null : viewOf(row);
  });

/** すべてのジョブ（新しい順）。 */
export const readAllJobs = (database: ControlDatabase): readonly AuditJobView[] =>
  withReadTransaction(database, (connection) =>
    Object.freeze((connection.prepare(SELECT_ALL_JOBS_SQL).all() as unknown as JobRow[]).map(viewOf)));
