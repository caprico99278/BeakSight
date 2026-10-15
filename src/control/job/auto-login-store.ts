// 自動ログインの試し・止めた状態・資格情報の変更の記録の読み書きの唯一の owner（管理データの版 4 の `auto_login_attempts`、
// `auto_login_holds`、`credential_events`。Task 26 の設計書 4.2 の「止めた状態との関係」「変更の記録」、4.5 の「止める」。T26c）。
// - 試し始めた記録は、ジョブの行を作る部品（`job-store.ts` の `createStartingJob`）が、ジョブの行と同じトランザクションで書く（Gate (g) の
//   ため。変更履歴の「Blocker: T26c」の行の (1)）。ここは、その後の結果・止める・解く・変更の記録と、読み出しを持つ。
// - 止める規則: 結果が `SUCCEEDED` でなく、送信が `NO` でない（`YES` か `UNKNOWN`）ときは、結果を書くのと同じトランザクションで、止める行を
//   作る（すでに止めていれば作らない）。送信の前に終わった場合（`NO`）は、ロックの心配がないので止めない。
// - 結果なしで終わった試し（ワーカーが落ちた、中断、画面のサーバが終わった）は、`AUTH_RESULT_UNKNOWN`・送信 `UNKNOWN` で閉じて止める
//   （ジョブの終わりは `closePendingAutoLoginAttempt`、起動のときの回復は `closeOrphanedAutoLoginAttempts`）。T30R-fix-1（M-2）: この閉じ方は
//   送信したかもしれない回なので、DEF-099 fix round 1 と同じく試しの行を 2 行書く（少なく数えない側。2 行目は `insertResentAttemptIn`）。
// - 解くのは、画面の明示の操作だけ（`clearAutoLoginHold`。解いた時刻と、`credential_events` の `HOLD_CLEARED`）。解いても、最小の間隔と
//   `Retry-After` は守る（判定は `auto-login-limits.ts`）。
// - どの入力も、資格情報の値（ユーザー名・パスワード）や、そのハッシュを受けない。書くのは、ID・閉じた一覧の値・時刻・改訂の番号だけ。
// - T26d-2: 結果に、フォームの確かめの理由のコード（`form_invalid_reason`。`LOGIN_FORM_INVALID` のときだけ。閉じた一覧）を足した。
// - 書き込みは、すべて `withWriteTransaction` の中。読むだけの関数は `withReadTransaction` を通す。生の接続を直接参照しない（Architecture Gate
//   `control-store-boundary.test.ts` の (f)(g)）。
import { deepFreeze } from '../../core/immutable.js';
import { formatCompactUtcTimestamp } from '../../core/utc-timestamp.js';
import {
  AUTOMATED_LOGIN_FAILURE_RESULTS,
  AUTOMATED_LOGIN_RATE_LIMITED_RESULT,
  AUTOMATED_LOGIN_RESULTS,
  AUTOMATED_LOGIN_SUBMISSION_NONE,
  AUTOMATED_LOGIN_SUBMISSION_SENT,
  AUTOMATED_LOGIN_SUBMISSION_UNKNOWN,
  AUTOMATED_LOGIN_SUBMISSIONS,
  AUTOMATED_LOGIN_SUCCEEDED,
  AUTOMATED_LOGIN_UNKNOWN_RESULT,
  type AutomatedLoginFailureResult,
  type AutomatedLoginResult,
  type AutomatedLoginSubmission,
} from '../auth/automated-login-results.js';
import type { ControlDatabase } from '../store/control-database.js';
import type { SqliteConnection } from '../store/sqlite-module.js';
import { ControlStoreError } from '../store/store-errors.js';
import { withReadTransaction, withWriteTransaction } from '../store/transaction.js';
import {
  WORKER_LOGIN_FORM_INVALID_REASONS,
  WORKER_LOGIN_FORM_INVALID_RESULT,
  type WorkerLoginFormInvalidReason,
} from '../worker-protocol.js';
import { AUTO_LOGIN_DAILY_WINDOW_MS, dateOfCompactUtcTimestamp } from './auto-login-limits.js';
import {
  ACTIVE_AUDIT_JOB_STATES,
  CREDENTIAL_EVENT_HOLD_CLEARED,
  CREDENTIAL_EVENT_KINDS,
  type CredentialEventKind,
} from './job-records.js';

// ---------------------------------------------------------------------------------------------------------------
// 形
// ---------------------------------------------------------------------------------------------------------------

/** 試しの記録 1 件（凍結。日時は UTC の 14 桁）。上限の判定（`AutoLoginAttemptForLimits`）にそのまま渡せる。 */
export interface AutoLoginAttemptView {
  readonly attemptId: number;
  readonly profileId: string;
  readonly jobId: string;
  readonly startedAt: string;
  readonly credentialRevision: number;
  /** 結果（`null` は未確定）。 */
  readonly result: AutomatedLoginResult | null;
  /** 送信したか（`null` は未確定）。 */
  readonly submitted: AutomatedLoginSubmission | null;
  readonly retryAfterUntil: string | null;
  readonly resultRecordedAt: string | null;
  /** フォームの確かめの理由のコード（T26d-2。`LOGIN_FORM_INVALID` のときだけ値を持ちうる）。 */
  readonly formInvalidReason: WorkerLoginFormInvalidReason | null;
}

/** 止めている行（凍結）。 */
export interface AutoLoginHoldView {
  readonly holdId: number;
  readonly profileId: string;
  /** 止めた試しの結果。 */
  readonly reason: AutomatedLoginFailureResult;
  readonly heldAt: string;
  readonly attemptId: number;
  /** 止めている行だけを返すので、常に `null`。 */
  readonly clearedAt: null;
}

/** 資格情報の変更の記録 1 件（凍結）。 */
export interface CredentialEventView {
  readonly eventId: number;
  readonly profileId: string;
  readonly recordedAt: string;
  readonly kind: CredentialEventKind;
  readonly credentialRevision: number | null;
}

/** 試しの結果の入力（T26d がワーカーの結果を受けて渡す）。値・誤りの文・URL を受けない。 */
export interface AutoLoginResultInput {
  readonly jobId: string;
  readonly result: AutomatedLoginResult;
  readonly submitted: AutomatedLoginSubmission;
  /** 429（`RATE_LIMITED`）のときだけ。`retryAfterUntilOf` で求めた期限（UTC の 14 桁）。ほかの結果では `null`。 */
  readonly retryAfterUntil: string | null;
  /**
   * フォームの確かめの理由のコード（T26d-2。`LOGIN_FORM_INVALID` のときだけ渡せる。省略は `null`）。秘密でない閉じた一覧の値。
   */
  readonly formInvalidReason?: WorkerLoginFormInvalidReason | null;
  /** 結果を記録する時刻（UTC の 14 桁）。止めるときは、止めた時刻にもなる。 */
  readonly at: string;
  /**
   * DEF-099 fix round 1: ログインの POST を送った後に応答があったか（送信 `YES` のときだけ渡せる。成功は `false` にできない。省略は応答あり）。
   * `false` の回は、試しの行を 2 行書く（2 行目も同じ結果・送信 `YES`・同じ試し始めた時刻。`RESENT_ATTEMPT_JOB_ID_PREFIX` の id）。
   */
  readonly responseAfterSubmission?: boolean;
}

/** 結果を書いた結果。`recorded` は未確定の試しを閉じたか、`held` はこの書き込みで止める行を作ったか。 */
export interface AutoLoginResultOutcome {
  readonly recorded: boolean;
  readonly held: boolean;
}

/** 資格情報の変更として記録する種類（停止の解除は `clearAutoLoginHold` か `clearHold` の選択で書く）。 */
export type CredentialChangeEventKind = Exclude<CredentialEventKind, typeof CREDENTIAL_EVENT_HOLD_CLEARED>;

/** 資格情報の変更の記録の入力（T26e が、T26a のファイルの置き換えが成功した後に渡す）。値を受けない。 */
export interface CredentialEventInput {
  readonly profileId: string;
  readonly kind: CredentialChangeEventKind;
  readonly at: string;
  /** 変更の後の改訂の番号（削除では `null` でよい）。 */
  readonly credentialRevision: number | null;
}

/** 資格情報の変更の記録の選択肢。 */
export interface CredentialEventOptions {
  /** 変更と一緒に、自動ログインの停止も解く（画面の明示の選択。設計書 4.2）。変更を書いた後に、解除を同じトランザクションで書く。 */
  readonly clearHold?: boolean;
}

/** 上限の判定に要る値（凍結）。 */
export interface AutoLoginLimitInputs {
  /** 今から 24 時間の窓の中に試し始めた記録と、`Retry-After` の期限が今より後の記録。 */
  readonly attempts: readonly AutoLoginAttemptView[];
  readonly hold: AutoLoginHoldView | null;
}

/** 最近の変更の記録を読む件数の既定。 */
export const DEFAULT_RECENT_CREDENTIAL_EVENTS = 20;

// ---------------------------------------------------------------------------------------------------------------
// SQL と行
// ---------------------------------------------------------------------------------------------------------------

interface AttemptRow {
  readonly attempt_id: number;
  readonly profile_id: string;
  readonly job_id: string;
  readonly started_at: string;
  readonly credential_revision: number;
  readonly result: string | null;
  readonly submitted: string | null;
  readonly retry_after_until: string | null;
  readonly result_recorded_at: string | null;
  readonly form_invalid_reason: string | null;
}

interface HoldRow {
  readonly hold_id: number;
  readonly profile_id: string;
  readonly reason: string;
  readonly held_at: string;
  readonly attempt_id: number;
}

interface EventRow {
  readonly event_id: number;
  readonly profile_id: string;
  readonly recorded_at: string;
  readonly kind: string;
  readonly credential_revision: number | null;
}

const ATTEMPT_COLUMNS = 'attempt_id, profile_id, job_id, started_at, credential_revision, result, submitted, retry_after_until, '
  + 'result_recorded_at, form_invalid_reason';
const SELECT_PENDING_ATTEMPT_SQL = `SELECT ${ATTEMPT_COLUMNS} FROM auto_login_attempts WHERE job_id = ? AND result IS NULL`;
const SELECT_ORPHANED_ATTEMPTS_SQL = `SELECT ${ATTEMPT_COLUMNS} FROM auto_login_attempts WHERE result IS NULL
  AND job_id NOT IN (SELECT job_id FROM jobs WHERE state IN (SELECT value FROM json_each(?))) ORDER BY attempt_id`;
const SELECT_LIMIT_ATTEMPTS_SQL = `SELECT ${ATTEMPT_COLUMNS} FROM auto_login_attempts
  WHERE profile_id = ? AND (started_at > ? OR retry_after_until > ?) ORDER BY started_at, attempt_id`;
const UPDATE_ATTEMPT_RESULT_SQL = `UPDATE auto_login_attempts SET result = ?, submitted = ?, retry_after_until = ?, result_recorded_at = ?,
  form_invalid_reason = ? WHERE attempt_id = ? AND result IS NULL`;
const SELECT_ACTIVE_HOLD_SQL =
  'SELECT hold_id, profile_id, reason, held_at, attempt_id FROM auto_login_holds WHERE profile_id = ? AND cleared_at IS NULL';
const INSERT_HOLD_SQL = 'INSERT INTO auto_login_holds (profile_id, reason, held_at, attempt_id) VALUES (?, ?, ?, ?)';
/** DEF-099 fix round 1: 応答のなかった送信の 2 行目（試し始めた記録と結果を一度に書く）。 */
const INSERT_RESENT_ATTEMPT_SQL = `INSERT INTO auto_login_attempts (profile_id, job_id, started_at, credential_revision, result, submitted,
  retry_after_until, result_recorded_at, form_invalid_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const UPDATE_HOLD_CLEARED_SQL = 'UPDATE auto_login_holds SET cleared_at = ? WHERE profile_id = ? AND cleared_at IS NULL';
const INSERT_EVENT_SQL = 'INSERT INTO credential_events (profile_id, recorded_at, kind, credential_revision) VALUES (?, ?, ?, ?)';
const SELECT_RECENT_EVENTS_SQL = `SELECT event_id, profile_id, recorded_at, kind, credential_revision FROM credential_events
  WHERE profile_id = ? ORDER BY recorded_at DESC, event_id DESC LIMIT ?`;
/** 資格情報の変更（停止の解除を除く）の最後の出来事の id（T28R-fix-1。I-1）。 */
const SELECT_LATEST_CHANGE_EVENT_SQL = 'SELECT max(event_id) AS event_id FROM credential_events WHERE profile_id = ? AND kind <> ?';

/** 終わっていないジョブの状態の SQL の値の一覧（`?` の位置に JSON の配列で渡す）。 */
const ACTIVE_STATES_JSON = JSON.stringify(ACTIVE_AUDIT_JOB_STATES);
/** 1 回の変更で書き換える行の数。 */
const ONE_ROW = 1;
/**
 * DEF-099 fix round 1: 応答のなかった送信の 2 行目の試しの id の前置き（ジョブの id の前に付ける）。ジョブの id（`WORKER_JOB_ID_PATTERN`）は
 * 英数字で始まるので、`-` で始まる id はどのジョブの id にもならない（ジョブの値の試しと結び付かず、上限の判定の数にだけ入る）。
 */
export const RESENT_ATTEMPT_JOB_ID_PREFIX = '-resent-';
/** 資格情報の変更として受ける種類（停止の解除を除く）。 */
const CREDENTIAL_CHANGE_EVENT_KINDS: readonly CredentialChangeEventKind[] = Object.freeze(
  CREDENTIAL_EVENT_KINDS.filter((kind): kind is CredentialChangeEventKind => kind !== CREDENTIAL_EVENT_HOLD_CLEARED),
);
/** 改訂の番号の最小値（資格情報のファイルの改訂は 1 から）。 */
const MIN_CREDENTIAL_REVISION = 1;

const NOT_RECORDED: AutoLoginResultOutcome = Object.freeze({ recorded: false, held: false });

const isOneOf = <Value extends string>(values: readonly Value[], value: unknown): value is Value =>
  typeof value === 'string' && (values as readonly string[]).includes(value);

const integrityError = (table: string, detail: string): ControlStoreError =>
  new ControlStoreError('DATABASE_INTEGRITY_FAILED', `stored ${table} row: ${detail}`);

// ---------------------------------------------------------------------------------------------------------------
// 入力の確かめ（呼び出し側の誤りは `RangeError`。書く前に確かめる）
// ---------------------------------------------------------------------------------------------------------------

/** UTC の 14 桁の実在する時刻か（`dateOfCompactUtcTimestamp` が `RangeError` を投げる）。 */
const requireTimestamp = (value: string): string => {
  dateOfCompactUtcTimestamp(value);
  return value;
};

const requireRevision = (value: number | null): number | null => {
  if (value !== null && (!Number.isSafeInteger(value) || value < MIN_CREDENTIAL_REVISION)) {
    throw new RangeError('the credential revision must be a safe integer of at least 1, or null');
  }
  return value;
};

/** 結果の入力の組み合わせを確かめる（設計書 4.4 の 5、4.5）。 */
const requireResult = (input: AutoLoginResultInput): void => {
  if (!isOneOf(AUTOMATED_LOGIN_RESULTS, input.result) || !isOneOf(AUTOMATED_LOGIN_SUBMISSIONS, input.submitted)) {
    throw new RangeError('the result and the submission must be in the closed lists');
  }
  if (input.result === AUTOMATED_LOGIN_SUCCEEDED && input.submitted !== AUTOMATED_LOGIN_SUBMISSION_SENT) {
    throw new RangeError('a successful login must have been sent');
  }
  if (input.retryAfterUntil !== null) {
    if (input.result !== AUTOMATED_LOGIN_RATE_LIMITED_RESULT) {
      throw new RangeError('only a rate limited result has a Retry-After deadline');
    }
    requireTimestamp(input.retryAfterUntil);
  }
  if (input.responseAfterSubmission !== undefined) {
    if (typeof input.responseAfterSubmission !== 'boolean' || input.submitted !== AUTOMATED_LOGIN_SUBMISSION_SENT) {
      throw new RangeError('only a sent login has the response after the submission');
    }
    if (input.result === AUTOMATED_LOGIN_SUCCEEDED && !input.responseAfterSubmission) {
      throw new RangeError('a successful login had a response');
    }
  }
  const formInvalidReason = input.formInvalidReason ?? null;
  if (formInvalidReason !== null) {
    if (input.result !== WORKER_LOGIN_FORM_INVALID_RESULT || !isOneOf(WORKER_LOGIN_FORM_INVALID_REASONS, formInvalidReason)) {
      throw new RangeError('only the form check result has a reason code of the closed list');
    }
  }
  requireTimestamp(input.at);
};

/** 止める結果か（成功でなく、送信が `NO` でない）。 */
const holdsAfter = (result: AutomatedLoginResult, submitted: AutomatedLoginSubmission): boolean =>
  result !== AUTOMATED_LOGIN_SUCCEEDED && submitted !== AUTOMATED_LOGIN_SUBMISSION_NONE;

// ---------------------------------------------------------------------------------------------------------------
// トランザクションの中の部品（公開しない。どれも `withWriteTransaction` の引数の中からだけ呼ぶ）
// ---------------------------------------------------------------------------------------------------------------

/** 止めている行を読む（トランザクションの中）。 */
const activeHoldRowOf = (connection: SqliteConnection, profileId: string): HoldRow | undefined =>
  connection.prepare(SELECT_ACTIVE_HOLD_SQL).get(profileId) as HoldRow | undefined;

/** 未確定の試しを閉じ、止める結果なら、止めていなければ止める（トランザクションの中）。 */
const closeAttemptIn = (connection: SqliteConnection, attempt: AttemptRow, input: Omit<AutoLoginResultInput, 'jobId'>): AutoLoginResultOutcome => {
  const changes = connection.prepare(UPDATE_ATTEMPT_RESULT_SQL)
    .run(input.result, input.submitted, input.retryAfterUntil, input.at, input.formInvalidReason ?? null, attempt.attempt_id).changes;
  if (Number(changes) !== ONE_ROW) {
    return NOT_RECORDED;
  }
  if (!holdsAfter(input.result, input.submitted) || activeHoldRowOf(connection, attempt.profile_id) !== undefined) {
    return Object.freeze({ recorded: true, held: false });
  }
  connection.prepare(INSERT_HOLD_SQL).run(attempt.profile_id, input.result, input.at, attempt.attempt_id);
  return Object.freeze({ recorded: true, held: true });
};

/**
 * DEF-099 fix round 1: 応答のなかった送信の 2 行目を書く（トランザクションの中。閉じた試しと同じプロファイル・試し始めた時刻・資格情報の改訂・結果）。
 * 止める行は 1 行目で作る（2 行目では作らない）。
 */
const insertResentAttemptIn = (connection: SqliteConnection, attempt: AttemptRow, input: Omit<AutoLoginResultInput, 'jobId'>): void => {
  connection.prepare(INSERT_RESENT_ATTEMPT_SQL).run(
    attempt.profile_id,
    `${RESENT_ATTEMPT_JOB_ID_PREFIX}${attempt.job_id}`,
    attempt.started_at,
    attempt.credential_revision,
    input.result,
    input.submitted,
    input.retryAfterUntil,
    input.at,
    input.formInvalidReason ?? null,
  );
};

/** 結果のない試しを閉じる値（設計書 4.5）。 */
const unknownResultAt = (at: string): Omit<AutoLoginResultInput, 'jobId'> => Object.freeze({
  result: AUTOMATED_LOGIN_UNKNOWN_RESULT,
  submitted: AUTOMATED_LOGIN_SUBMISSION_UNKNOWN,
  retryAfterUntil: null,
  at,
});

/**
 * T30R-fix-1（M-2）: 結果のない試しを `AUTH_RESULT_UNKNOWN`・送信 `UNKNOWN` で閉じ、2 行目を書く（トランザクションの中）。送信したかもしれない
 * （ログインの POST の後にワーカーが落ちた、画面のサーバが終わった）ので、ブラウザが送り直したかもしれない回として 2 回と数える
 * （DEF-099 fix round 1 の応答のなかった送信と同じ 2 行目の作り）。
 */
const closeUnknownAttemptIn = (connection: SqliteConnection, attempt: AttemptRow, at: string): AutoLoginResultOutcome => {
  const values = unknownResultAt(at);
  const outcome = closeAttemptIn(connection, attempt, values);
  if (outcome.recorded) {
    insertResentAttemptIn(connection, attempt, values);
  }
  return outcome;
};

/** 止めている行を解き、解いた記録を書く（トランザクションの中）。解いたかを返す。 */
const clearHoldIn = (connection: SqliteConnection, profileId: string, at: string, credentialRevision: number | null): boolean => {
  const changes = connection.prepare(UPDATE_HOLD_CLEARED_SQL).run(at, profileId).changes;
  if (Number(changes) !== ONE_ROW) {
    return false;
  }
  connection.prepare(INSERT_EVENT_SQL).run(profileId, at, CREDENTIAL_EVENT_HOLD_CLEARED, credentialRevision);
  return true;
};

// ---------------------------------------------------------------------------------------------------------------
// 書き込み
// ---------------------------------------------------------------------------------------------------------------

/**
 * 試しの結果を書く（そのジョブの未確定の試しだけ。確定した結果は上書きしない）。止める結果（成功でなく、送信が `NO` でない）なら、同じ
 * トランザクションで止める行を作る（すでに止めていれば作らない）。未確定の試しがなければ、何もしない（`recorded: false`）。
 */
export const recordAutoLoginResult = (database: ControlDatabase, input: AutoLoginResultInput): AutoLoginResultOutcome => {
  requireResult(input);
  const values = Object.freeze({
    result: input.result,
    submitted: input.submitted,
    retryAfterUntil: input.retryAfterUntil,
    formInvalidReason: input.formInvalidReason ?? null,
    at: input.at,
  });
  return withWriteTransaction(database, (connection) => {
    const attempt = connection.prepare(SELECT_PENDING_ATTEMPT_SQL).get(input.jobId) as AttemptRow | undefined;
    if (attempt === undefined) {
      return NOT_RECORDED;
    }
    const outcome = closeAttemptIn(connection, attempt, values);
    // DEF-099 fix round 1: 送った後に応答がなかった回は、試しを 2 回と数える（2 行目）。
    if (outcome.recorded && input.responseAfterSubmission === false) {
      insertResentAttemptIn(connection, attempt, values);
    }
    return outcome;
  });
};

/**
 * ジョブが結果なしで終わったときに、そのジョブの未確定の試しを `AUTH_RESULT_UNKNOWN`・送信 `UNKNOWN` で閉じて止める（ジョブの終わりで使う）。
 * 未確定の試しがなければ、何もしない。T30R-fix-1（M-2）: 試しの行を 2 行書く（`closeUnknownAttemptIn`）。
 */
export const closePendingAutoLoginAttempt = (database: ControlDatabase, jobId: string, at: string): AutoLoginResultOutcome => {
  requireTimestamp(at);
  return withWriteTransaction(database, (connection) => {
    const attempt = connection.prepare(SELECT_PENDING_ATTEMPT_SQL).get(jobId) as AttemptRow | undefined;
    return attempt === undefined ? NOT_RECORDED : closeUnknownAttemptIn(connection, attempt, at);
  });
};

/**
 * 終わっていないジョブ（`ACTIVE_AUDIT_JOB_STATES`）のものでない未確定の試しを、すべて `AUTH_RESULT_UNKNOWN`・送信 `UNKNOWN` で閉じて止める
 * （起動のときの回復。終わっていないジョブを中断に直した後に呼ぶ）。閉じた試しの数を返す（2 行目は数えない）。まだ動いているジョブの試しは残す。
 * T30R-fix-1（M-2）: 試しごとに 2 行書く（`closeUnknownAttemptIn`）。
 */
export const closeOrphanedAutoLoginAttempts = (database: ControlDatabase, at: string): number => {
  requireTimestamp(at);
  return withWriteTransaction(database, (connection) => {
    const orphaned = connection.prepare(SELECT_ORPHANED_ATTEMPTS_SQL).all(ACTIVE_STATES_JSON) as unknown as AttemptRow[];
    return orphaned.filter((attempt) => closeUnknownAttemptIn(connection, attempt, at).recorded).length;
  });
};

/**
 * 自動ログインの停止を解く（画面の明示の操作。設計書 4.2、4.5）。解いた時刻を書き、`credential_events` に `HOLD_CLEARED` を書く。止めて
 * いなければ、何もしない（`false`）。`credentialRevision` は、解いたときの資格情報の改訂の番号（分からなければ `null`）。
 */
export const clearAutoLoginHold = (
  database: ControlDatabase,
  profileId: string,
  at: string,
  credentialRevision: number | null = null,
): boolean => {
  requireTimestamp(at);
  requireRevision(credentialRevision);
  return withWriteTransaction(database, (connection) => clearHoldIn(connection, profileId, at, credentialRevision));
};

/**
 * 資格情報の変更の記録を書く（T26e が、T26a のファイルの置き換えか削除が成功した後に呼ぶ）。`clearHold` を選んだときは、同じトランザクションで
 * 自動ログインの停止も解く（変更の後に解除を書く。止めていなければ解除は書かない）。資格情報の変更を、自動では人の確かめとみなさない
 * （設計書 10 章の 3）。
 */
export const recordCredentialEvent = (
  database: ControlDatabase,
  event: CredentialEventInput,
  options: CredentialEventOptions = {},
): { readonly holdCleared: boolean } => {
  if (!isOneOf(CREDENTIAL_CHANGE_EVENT_KINDS, event.kind)) {
    throw new RangeError('the credential event kind must be a change kind of the closed list');
  }
  requireTimestamp(event.at);
  requireRevision(event.credentialRevision);
  const values = Object.freeze({ profileId: event.profileId, kind: event.kind, at: event.at, credentialRevision: event.credentialRevision });
  const clearHold = options.clearHold === true;
  return withWriteTransaction(database, (connection) => {
    connection.prepare(INSERT_EVENT_SQL).run(values.profileId, values.at, values.kind, values.credentialRevision);
    const holdCleared = clearHold && clearHoldIn(connection, values.profileId, values.at, values.credentialRevision);
    return Object.freeze({ holdCleared });
  });
};

// ---------------------------------------------------------------------------------------------------------------
// 読み出し
// ---------------------------------------------------------------------------------------------------------------

const attemptViewOf = (row: AttemptRow): AutoLoginAttemptView => {
  if (row.result !== null && !isOneOf(AUTOMATED_LOGIN_RESULTS, row.result)) {
    throw integrityError('auto_login_attempts', 'result is not in the closed list');
  }
  if (row.submitted !== null && !isOneOf(AUTOMATED_LOGIN_SUBMISSIONS, row.submitted)) {
    throw integrityError('auto_login_attempts', 'submitted is not in the closed list');
  }
  if (row.form_invalid_reason !== null && !isOneOf(WORKER_LOGIN_FORM_INVALID_REASONS, row.form_invalid_reason)) {
    throw integrityError('auto_login_attempts', 'form_invalid_reason is not in the closed list');
  }
  return deepFreeze({
    attemptId: row.attempt_id,
    profileId: row.profile_id,
    jobId: row.job_id,
    startedAt: row.started_at,
    credentialRevision: row.credential_revision,
    result: row.result,
    submitted: row.submitted,
    retryAfterUntil: row.retry_after_until,
    resultRecordedAt: row.result_recorded_at,
    formInvalidReason: row.form_invalid_reason,
  } as AutoLoginAttemptView);
};

const holdViewOf = (row: HoldRow): AutoLoginHoldView => {
  if (!isOneOf(AUTOMATED_LOGIN_FAILURE_RESULTS, row.reason)) {
    throw integrityError('auto_login_holds', 'reason is not in the closed list');
  }
  return deepFreeze({
    holdId: row.hold_id,
    profileId: row.profile_id,
    reason: row.reason,
    heldAt: row.held_at,
    attemptId: row.attempt_id,
    clearedAt: null,
  });
};

const eventViewOf = (row: EventRow): CredentialEventView => {
  if (!isOneOf(CREDENTIAL_EVENT_KINDS, row.kind)) {
    throw integrityError('credential_events', 'kind is not in the closed list');
  }
  return deepFreeze({
    eventId: row.event_id,
    profileId: row.profile_id,
    recordedAt: row.recorded_at,
    kind: row.kind,
    credentialRevision: row.credential_revision,
  });
};

/**
 * 開いているトランザクションの接続（`createStartingJob` の `guard` が受けたもの）で、上限の判定に要る値を読む（読むだけ。T26d が、ジョブを
 * 作るのと同じトランザクションの中で、上限を確かめ直すために使う）。
 */
export const readAutoLoginLimitInputsWith = (connection: SqliteConnection, profileId: string, now: Date): AutoLoginLimitInputs => {
  const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
  if (Number.isNaN(nowMs)) {
    throw new RangeError('now must be a valid Date');
  }
  const windowStart = formatCompactUtcTimestamp(new Date(nowMs - AUTO_LOGIN_DAILY_WINDOW_MS), 'auto login window start');
  const nowStamp = formatCompactUtcTimestamp(new Date(nowMs), 'auto login limit time');
  const rows = connection.prepare(SELECT_LIMIT_ATTEMPTS_SQL).all(profileId, windowStart, nowStamp) as unknown as AttemptRow[];
  const hold = activeHoldRowOf(connection, profileId);
  return Object.freeze({
    attempts: Object.freeze(rows.map(attemptViewOf)),
    hold: hold === undefined ? null : holdViewOf(hold),
  });
};

/** 上限の判定に要る値（止めている行と、窓の中か `Retry-After` の期限が今より後の試し）を読む。 */
export const readAutoLoginLimitInputs = (database: ControlDatabase, profileId: string, now: Date): AutoLoginLimitInputs =>
  withReadTransaction(database, (connection) => readAutoLoginLimitInputsWith(connection, profileId, now));

/** プロファイルの止めている行（止めていなければ `null`）。 */
export const readAutoLoginHold = (database: ControlDatabase, profileId: string): AutoLoginHoldView | null =>
  withReadTransaction(database, (connection) => {
    const hold = activeHoldRowOf(connection, profileId);
    return hold === undefined ? null : holdViewOf(hold);
  });

/** プロファイルの最近の資格情報の変更の記録（新しい順。`limit` 件まで）。 */
export const readRecentCredentialEvents = (
  database: ControlDatabase,
  profileId: string,
  limit: number = DEFAULT_RECENT_CREDENTIAL_EVENTS,
): readonly CredentialEventView[] => {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError('the limit must be a positive safe integer');
  }
  return withReadTransaction(database, (connection) =>
    Object.freeze((connection.prepare(SELECT_RECENT_EVENTS_SQL).all(profileId, limit) as unknown as EventRow[]).map(eventViewOf)));
};

/**
 * プロファイルの、資格情報の変更（登録・変更・削除。停止の解除を除く）の最後の出来事の id（なければ null。T28R-fix-1。独立レビュー T28R の
 * I-1）。出来事の id は、資格情報の保存・変更・削除のたびに増え、削除をまたいでも戻らないので、承認に縛る資格情報の事実に使う
 * （`src/control/approval-external-facts.ts`）。読むだけ。
 */
export const readLatestCredentialChangeEventId = (database: ControlDatabase, profileId: string): number | null =>
  withReadTransaction(database, (connection) => {
    const row = connection.prepare(SELECT_LATEST_CHANGE_EVENT_SQL).get(profileId, CREDENTIAL_EVENT_HOLD_CLEARED) as { readonly event_id: number | null } | undefined;
    return row?.event_id ?? null;
  });
