// READ の確かめの定義と結果の読み書きの唯一の owner（管理データの版 5 の `read_checks`、`read_check_results`。Task 27 の設計書 4.5、4.6。T27c）。
// - 定義: 作成（版 1）、変更（画面が読んだ版と同じときだけ。版を 1 つ上げる）、取り消し（消さずに、取り消した時刻を書く。取り消した定義は変えない）。
//   1 つのプロファイルの、取り消していない定義の数は `MAX_READ_CHECK_DEFINITIONS_PER_PROFILE` まで（数えるのは、作るのと同じトランザクションの中）。
//   T27f（T27c の申し送り 6）: 取り消したプロファイルでは、作らない・変えない（`READ_CHECK_PROFILE_RETIRED`。同じトランザクションの中で確かめる）。
//   取り消しはできる。T28b fix round 1: READ の確かめを許さないモードと認証の方式のプロファイル（`execution-policy.ts` の `READ_CHECK` の行にない。
//   例: 公開の監査）でも、作らない・変えない（`READ_CHECK_PROFILE_NOT_ELIGIBLE`。同じトランザクションの中で確かめる）。
// - 書く前に、定義の形と秘密に見える名前を確かめ直す（`assertStorableReadCheckDefinition`）。候補に照らした確かめ（送れる欄、分類が READ）は、
//   候補を持つ呼び出し側が `validateReadCheckDefinition` で行う（T27f。設計書の変更履歴「Blocker: T27c」の行の (4)）。
// - 送る値は、設計どおり平文で保存する（テスト環境のテスト用の値だけ。設計書 4.5、10 章の 4）。入力の型に、資格情報・トークン・label の口はない。
//   定義は、契約の 3 つの項目だけを選んで書く（余分な項目は書かない）。T37d: 対象は、候補の識別の digest（列 `target_identity_digest`）か画面の
//   path（管理データの版 12 の列 `target_page_path`）のどちらか 1 つ。
// - 結果: ジョブ・定義・定義の版・閉じた一覧の結果（`READ_CHECK_RESULTS`）・時刻。ジョブと定義の組で 1 行。T27e（T27c の申し送り 11）: 定義の版が、
//   今の版と違う結果（実行の間に定義が変わった）は書かない（`recordReadCheckResult` は `RangeError`、まとめて書く `recordReadCheckResults` は、その
//   結果だけを書かずに数える）。
// - 書き込みは、すべて `withWriteTransaction` の中。読むだけの関数は `withReadTransaction` を通す。生の接続を直接参照しない（Architecture Gate
//   `control-store-boundary.test.ts` の (f)(g)）。呼び出し側の誤り（形の違う入力、前の時刻、同じ ID）は `RangeError`。
import { deepFreeze } from '../../core/immutable.js';
import {
  MAX_READ_CHECK_DEFINITIONS_PER_PROFILE,
  READ_CHECK_RESULTS,
  type ReadCheckDefinition,
  type ReadCheckResult,
} from '../../discovery/read-check-contracts.js';
import { isProfileOperationAllowed, type ProfileOperation } from '../execution-policy.js';
import { assertStorableReadCheckDefinition, type ReadCheckDefinitionRejectionReason } from '../read-check-policy.js';
import type { ControlDatabase } from '../store/control-database.js';
import { ACTIVE_PROFILE_STATUS } from '../store/profile-records.js';
import type { SqliteConnection } from '../store/sqlite-module.js';
import { ControlStoreError } from '../store/store-errors.js';
import { withReadTransaction, withWriteTransaction } from '../store/transaction.js';
import { WORKER_JOB_ID_PATTERN } from '../worker-protocol.js';
import { dateOfCompactUtcTimestamp } from './auto-login-limits.js';

// ---------------------------------------------------------------------------------------------------------------
// 形
// ---------------------------------------------------------------------------------------------------------------

/** 定義 1 件（凍結。日時は UTC の 14 桁）。 */
export interface ReadCheckView {
  readonly readCheckId: string;
  readonly profileId: string;
  readonly definition: ReadCheckDefinition;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** 取り消した時刻（取り消していなければ null）。 */
  readonly canceledAt: string | null;
}

/** 定義の作成の入力。`definition` は、呼び出し側が候補に照らして確かめたもの（`validateReadCheckDefinition`）。 */
export interface NewReadCheck {
  /** 定義の ID（ジョブの ID と同じ形。`WORKER_JOB_ID_PATTERN`）。 */
  readonly readCheckId: string;
  readonly profileId: string;
  readonly definition: ReadCheckDefinition;
  readonly at: string;
}

/** 定義の変更の入力。 */
export interface ReadCheckChange {
  readonly readCheckId: string;
  /** 画面が読んだ版（保存されている版と違えば `READ_CHECK_REVISION_CONFLICT`）。 */
  readonly expectedRevision: number;
  readonly definition: ReadCheckDefinition;
  readonly at: string;
}

/** 定義の取り消しの入力。 */
export interface ReadCheckCancel {
  readonly readCheckId: string;
  readonly expectedRevision: number;
  readonly at: string;
}

/** 定義の保存の結果（拒むときは、閉じた一覧の理由）。 */
export type ReadCheckStoreResult =
  | { readonly ok: true; readonly readCheck: ReadCheckView }
  | { readonly ok: false; readonly reason: ReadCheckDefinitionRejectionReason };

/** 一覧の読み出しの選択肢。 */
export interface ReadCheckListOptions {
  /** 取り消した定義も含めるか（既定は含めない）。 */
  readonly includeCanceled?: boolean;
}

/** 結果の記録の入力。 */
export interface ReadCheckResultInput {
  readonly jobId: string;
  readonly readCheckId: string;
  /** 実行したときの定義の版（今の版より新しくしない）。 */
  readonly readCheckRevision: number;
  readonly result: ReadCheckResult;
  readonly at: string;
}

/** 結果 1 件（凍結）。 */
export interface ReadCheckResultView {
  readonly jobId: string;
  readonly readCheckId: string;
  readonly readCheckRevision: number;
  readonly result: ReadCheckResult;
  readonly recordedAt: string;
}

/** 最近の結果を読む件数の既定。 */
export const DEFAULT_RECENT_READ_CHECK_RESULTS = 50;

// ---------------------------------------------------------------------------------------------------------------
// SQL と行
// ---------------------------------------------------------------------------------------------------------------

interface ReadCheckRow {
  readonly read_check_id: string;
  readonly profile_id: string;
  /** READ の候補の識別の digest（画面の path の定義は null。T37d）。 */
  readonly target_identity_digest: string | null;
  /** 画面の path（候補の定義は null。管理データの版 12。T37d）。 */
  readonly target_page_path: string | null;
  readonly parameters: string;
  readonly expectations: string;
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly canceled_at: string | null;
}

interface ResultRow {
  readonly job_id: string;
  readonly read_check_id: string;
  readonly read_check_revision: number;
  readonly result: string;
  readonly recorded_at: string;
}

const READ_CHECK_COLUMNS =
  'read_check_id, profile_id, target_identity_digest, target_page_path, parameters, expectations, revision, created_at, updated_at, canceled_at';
const SELECT_READ_CHECK_SQL = `SELECT ${READ_CHECK_COLUMNS} FROM read_checks WHERE read_check_id = ?`;
const SELECT_PROFILE_READ_CHECKS_SQL = `SELECT ${READ_CHECK_COLUMNS} FROM read_checks WHERE profile_id = ?
  AND (? OR canceled_at IS NULL) ORDER BY created_at, read_check_id`;
/** プロファイルの状態（T27f。ないプロファイルは行なし）。 */
/** プロファイルの状態と、モードと認証の方式（T28b fix round 1。READ の確かめを許すかの判定に使う。値は `execution-policy.ts` が確かめる）。 */
const SELECT_PROFILE_STATUS_SQL =
  "SELECT status, json_extract(document, '$.mode') AS mode, json_extract(document, '$.auth') AS auth FROM profiles WHERE profile_id = ?";
const SELECT_ACTIVE_COUNT_SQL = 'SELECT count(*) AS n FROM read_checks WHERE profile_id = ? AND canceled_at IS NULL';
const INSERT_READ_CHECK_SQL = `INSERT INTO read_checks (${READ_CHECK_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`;
const UPDATE_READ_CHECK_SQL = `UPDATE read_checks SET target_identity_digest = ?, target_page_path = ?, parameters = ?, expectations = ?, revision = ?,
  updated_at = ? WHERE read_check_id = ? AND revision = ? AND canceled_at IS NULL`;
const UPDATE_CANCELED_SQL = `UPDATE read_checks SET canceled_at = ?, updated_at = ?
  WHERE read_check_id = ? AND revision = ? AND canceled_at IS NULL`;
const INSERT_RESULT_SQL = `INSERT INTO read_check_results (job_id, read_check_id, read_check_revision, result, recorded_at)
  VALUES (?, ?, ?, ?, ?)`;
const SELECT_RECENT_RESULTS_SQL = `SELECT r.job_id, r.read_check_id, r.read_check_revision, r.result, r.recorded_at
  FROM read_check_results AS r JOIN read_checks AS c ON c.read_check_id = r.read_check_id
  WHERE c.profile_id = ? ORDER BY r.recorded_at DESC, r.result_id DESC LIMIT ?`;

/** 定義の版の最小値（作ったときの版）。 */
const FIRST_READ_CHECK_REVISION = 1;
/** 1 回の変更で書き換える行の数。 */
const ONE_ROW = 1;
/** SQLite の真偽の値。 */
const SQL_TRUE = 1;
const SQL_FALSE = 0;

const isOneOf = <Value extends string>(values: readonly Value[], value: unknown): value is Value =>
  typeof value === 'string' && (values as readonly string[]).includes(value);

const integrityError = (table: string, detail: string): ControlStoreError =>
  new ControlStoreError('DATABASE_INTEGRITY_FAILED', `stored ${table} row: ${detail}`);

const rejected = (reason: ReadCheckDefinitionRejectionReason): ReadCheckStoreResult => Object.freeze({ ok: false, reason });

// 定義を作り・変えてよいプロファイルの状態（T27f。T27c の申し送り 6: 取り消したプロファイルでは作らない・変えない）は、owner の
// `profile-records.ts` の `ACTIVE_PROFILE_STATUS` から読む（CC-109）。

/** READ の確かめの操作（T28b fix round 1。許すモードと認証の方式は `execution-policy.ts` の `READ_CHECK` の行だけで決める）。 */
const READ_CHECK_OPERATION = 'READ_CHECK' satisfies ProfileOperation;

/**
 * プロファイルの状態からの拒否の理由（ない → `READ_CHECK_PROFILE_NOT_FOUND`、取り消した → `READ_CHECK_PROFILE_RETIRED`、READ の確かめを許さない
 * モードと認証の方式（T28b fix round 1。例: 公開の監査）→ `READ_CHECK_PROFILE_NOT_ELIGIBLE`、ほかは null）。
 */
const profileRejectionOf = (connection: SqliteConnection, profileId: string): ReadCheckDefinitionRejectionReason | null => {
  const row = connection.prepare(SELECT_PROFILE_STATUS_SQL).get(profileId) as
    { readonly status: string; readonly mode: unknown; readonly auth: unknown } | undefined;
  if (row === undefined) {
    return 'READ_CHECK_PROFILE_NOT_FOUND';
  }
  if (row.status !== ACTIVE_PROFILE_STATUS) {
    return 'READ_CHECK_PROFILE_RETIRED';
  }
  return isProfileOperationAllowed(READ_CHECK_OPERATION, row.mode, row.auth) ? null : 'READ_CHECK_PROFILE_NOT_ELIGIBLE';
};

// ---------------------------------------------------------------------------------------------------------------
// 入力の確かめ（呼び出し側の誤りは `RangeError`。書く前に確かめる）
// ---------------------------------------------------------------------------------------------------------------

const requireId = (value: string, subject: string): string => {
  if (typeof value !== 'string' || !WORKER_JOB_ID_PATTERN.test(value)) {
    throw new RangeError(`the ${subject} must match the job id pattern`);
  }
  return value;
};

const requireTimestamp = (value: string): string => {
  dateOfCompactUtcTimestamp(value);
  return value;
};

const requireRevision = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < FIRST_READ_CHECK_REVISION) {
    throw new RangeError('the READ check revision must be a safe integer of at least 1');
  }
  return value;
};

/**
 * 定義の契約の 3 つの項目だけを選び（余分な項目は写さない）、形と秘密に見える名前を確かめた凍結した写し。T37d: 対象は、候補の識別の digest か
 * 画面の path の、渡された方（両方を渡せば形の誤り）。
 */
const requireDefinition = (definition: ReadCheckDefinition): ReadCheckDefinition => assertStorableReadCheckDefinition({
  ...(definition.targetIdentityDigest === undefined ? {} : { targetIdentityDigest: definition.targetIdentityDigest }),
  ...(definition.targetPagePath === undefined ? {} : { targetPagePath: definition.targetPagePath }),
  parameters: definition.parameters,
  expectations: definition.expectations,
} as ReadCheckDefinition);

/** 定義の対象の列の値（候補の識別の digest と、画面の path。どちらか一方は null。T37d）。 */
const targetColumnsOf = (definition: ReadCheckDefinition): readonly [string | null, string | null] =>
  [definition.targetIdentityDigest ?? null, definition.targetPagePath ?? null];

// ---------------------------------------------------------------------------------------------------------------
// 行から形へ
// ---------------------------------------------------------------------------------------------------------------

const parsedJson = (text: string, detail: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ControlStoreError('DATABASE_INTEGRITY_FAILED', `stored read_checks row: ${detail} is not JSON`, { cause: error });
  }
};

const readCheckViewOf = (row: ReadCheckRow): ReadCheckView => {
  let definition: ReadCheckDefinition;
  try {
    // T37d: 対象の列は、どちらか一方だけが値を持つ（表の CHECK）。値のある方を契約の項目にする（両方あれば形の誤り）。
    definition = assertStorableReadCheckDefinition({
      ...(row.target_identity_digest === null ? {} : { targetIdentityDigest: row.target_identity_digest }),
      ...(row.target_page_path === null ? {} : { targetPagePath: row.target_page_path }),
      parameters: parsedJson(row.parameters, 'parameters') as ReadCheckDefinition['parameters'],
      expectations: parsedJson(row.expectations, 'expectations') as ReadCheckDefinition['expectations'],
    } as ReadCheckDefinition);
  } catch (error) {
    if (error instanceof ControlStoreError) {
      throw error;
    }
    throw new ControlStoreError('DATABASE_INTEGRITY_FAILED', 'stored read_checks row: the definition does not match the contract', { cause: error });
  }
  return deepFreeze({
    readCheckId: row.read_check_id,
    profileId: row.profile_id,
    definition,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    canceledAt: row.canceled_at,
  });
};

const resultViewOf = (row: ResultRow): ReadCheckResultView => {
  if (!isOneOf(READ_CHECK_RESULTS, row.result)) {
    throw integrityError('read_check_results', 'result is not in the closed list');
  }
  return deepFreeze({
    jobId: row.job_id,
    readCheckId: row.read_check_id,
    readCheckRevision: row.read_check_revision,
    result: row.result,
    recordedAt: row.recorded_at,
  });
};

// ---------------------------------------------------------------------------------------------------------------
// トランザクションの中の部品（公開しない。`withWriteTransaction` の引数の中からだけ呼ぶ）
// ---------------------------------------------------------------------------------------------------------------

const readCheckRowOf = (connection: SqliteConnection, readCheckId: string): ReadCheckRow | undefined =>
  connection.prepare(SELECT_READ_CHECK_SQL).get(readCheckId) as ReadCheckRow | undefined;

/** 変える・取り消す前の確かめ（ない、取り消した、版が違う）。拒む理由か、今の行。 */
const changeableRowOf = (
  connection: SqliteConnection,
  readCheckId: string,
  expectedRevision: number,
  at: string,
): ReadCheckRow | ReadCheckDefinitionRejectionReason => {
  const row = readCheckRowOf(connection, readCheckId);
  if (row === undefined) {
    return 'READ_CHECK_NOT_FOUND';
  }
  if (row.canceled_at !== null) {
    return 'READ_CHECK_CANCELED';
  }
  if (row.revision !== expectedRevision) {
    return 'READ_CHECK_REVISION_CONFLICT';
  }
  if (at < row.updated_at) {
    throw new RangeError('the time must not be before the last change of the READ check');
  }
  return row;
};

const createIn = (connection: SqliteConnection, input: NewReadCheck): ReadCheckStoreResult => {
  if (readCheckRowOf(connection, input.readCheckId) !== undefined) {
    throw new RangeError('the READ check id is already used');
  }
  const profileRejection = profileRejectionOf(connection, input.profileId);
  if (profileRejection !== null) {
    return rejected(profileRejection);
  }
  if ((connection.prepare(SELECT_ACTIVE_COUNT_SQL).get(input.profileId) as { readonly n: number }).n >= MAX_READ_CHECK_DEFINITIONS_PER_PROFILE) {
    return rejected('READ_CHECK_LIMIT_EXCEEDED');
  }
  const { definition } = input;
  connection.prepare(INSERT_READ_CHECK_SQL).run(
    input.readCheckId, input.profileId, ...targetColumnsOf(definition), JSON.stringify(definition.parameters),
    JSON.stringify(definition.expectations), FIRST_READ_CHECK_REVISION, input.at, input.at,
  );
  const row = readCheckRowOf(connection, input.readCheckId);
  if (row === undefined) {
    throw integrityError('read_checks', 'the created row was not found');
  }
  return Object.freeze({ ok: true, readCheck: readCheckViewOf(row) });
};

const updateIn = (connection: SqliteConnection, input: ReadCheckChange): ReadCheckStoreResult => {
  const current = changeableRowOf(connection, input.readCheckId, input.expectedRevision, input.at);
  if (typeof current === 'string') {
    return rejected(current);
  }
  // T27f: 取り消したプロファイルの定義は変えない（取り消しはできる）。
  const profileRejection = profileRejectionOf(connection, current.profile_id);
  if (profileRejection !== null) {
    return rejected(profileRejection);
  }
  const { definition } = input;
  const changes = connection.prepare(UPDATE_READ_CHECK_SQL).run(
    ...targetColumnsOf(definition), JSON.stringify(definition.parameters), JSON.stringify(definition.expectations), current.revision + 1,
    input.at, input.readCheckId, current.revision,
  ).changes;
  const row = readCheckRowOf(connection, input.readCheckId);
  if (Number(changes) !== ONE_ROW || row === undefined) {
    throw integrityError('read_checks', 'the changed row was not found');
  }
  return Object.freeze({ ok: true, readCheck: readCheckViewOf(row) });
};

const cancelIn = (connection: SqliteConnection, input: ReadCheckCancel): ReadCheckStoreResult => {
  const current = changeableRowOf(connection, input.readCheckId, input.expectedRevision, input.at);
  if (typeof current === 'string') {
    return rejected(current);
  }
  const changes = connection.prepare(UPDATE_CANCELED_SQL).run(input.at, input.at, input.readCheckId, current.revision).changes;
  const row = readCheckRowOf(connection, input.readCheckId);
  if (Number(changes) !== ONE_ROW || row === undefined) {
    throw integrityError('read_checks', 'the canceled row was not found');
  }
  return Object.freeze({ ok: true, readCheck: readCheckViewOf(row) });
};

/** 結果の定義の版が、今の版と同じか（定義がなければ偽。T27e）。 */
const isCurrentRevision = (connection: SqliteConnection, input: ReadCheckResultInput): boolean =>
  readCheckRowOf(connection, input.readCheckId)?.revision === input.readCheckRevision;

const recordResultIn = (connection: SqliteConnection, input: ReadCheckResultInput): void => {
  const row = readCheckRowOf(connection, input.readCheckId);
  if (row !== undefined && input.readCheckRevision !== row.revision) {
    throw new RangeError('the READ check revision of the result must be the current revision of the definition');
  }
  // 定義がなければ、外部キーの誤りで書かない。
  connection.prepare(INSERT_RESULT_SQL).run(input.jobId, input.readCheckId, input.readCheckRevision, input.result, input.at);
};

// ---------------------------------------------------------------------------------------------------------------
// 書き込み
// ---------------------------------------------------------------------------------------------------------------

/**
 * 定義を作る（版 1）。プロファイルがなければ `READ_CHECK_PROFILE_NOT_FOUND`、取り消していない定義が上限に達していれば
 * `READ_CHECK_LIMIT_EXCEEDED`（どちらも何も書かない）。同じ ID は `RangeError`。
 */
export const createReadCheck = (database: ControlDatabase, input: NewReadCheck): ReadCheckStoreResult => {
  const values: NewReadCheck = Object.freeze({
    readCheckId: requireId(input.readCheckId, 'READ check id'),
    profileId: input.profileId,
    definition: requireDefinition(input.definition),
    at: requireTimestamp(input.at),
  });
  return withWriteTransaction(database, (connection) => createIn(connection, values));
};

/** 定義を変える（画面が読んだ版と同じときだけ。版を 1 つ上げる）。ない・取り消した・版が違うときは、理由を返して何も書かない。 */
export const updateReadCheck = (database: ControlDatabase, input: ReadCheckChange): ReadCheckStoreResult => {
  const values: ReadCheckChange = Object.freeze({
    readCheckId: input.readCheckId,
    expectedRevision: requireRevision(input.expectedRevision),
    definition: requireDefinition(input.definition),
    at: requireTimestamp(input.at),
  });
  return withWriteTransaction(database, (connection) => updateIn(connection, values));
};

/** 定義を取り消す（消さずに、取り消した時刻を書く。版は変えない）。ない・取り消した・版が違うときは、理由を返して何も書かない。 */
export const cancelReadCheck = (database: ControlDatabase, input: ReadCheckCancel): ReadCheckStoreResult => {
  const values: ReadCheckCancel = Object.freeze({
    readCheckId: input.readCheckId,
    expectedRevision: requireRevision(input.expectedRevision),
    at: requireTimestamp(input.at),
  });
  return withWriteTransaction(database, (connection) => cancelIn(connection, values));
};

/** 結果の入力を確かめた凍結した写し（呼び出し側の誤りは `RangeError`）。 */
const requireResultInput = (input: ReadCheckResultInput): ReadCheckResultInput => {
  if (!isOneOf(READ_CHECK_RESULTS, input.result)) {
    throw new RangeError('the READ check result must be in the closed list');
  }
  return Object.freeze({
    jobId: requireId(input.jobId, 'job id'),
    readCheckId: input.readCheckId,
    readCheckRevision: requireRevision(input.readCheckRevision),
    result: input.result,
    at: requireTimestamp(input.at),
  });
};

/** READ の確かめの結果を書く（ジョブと定義の組で 1 行。同じ組の 2 回目、ない定義、今の版と違う版は書かない）。 */
export const recordReadCheckResult = (database: ControlDatabase, input: ReadCheckResultInput): void => {
  const values = requireResultInput(input);
  withWriteTransaction(database, (connection) => recordResultIn(connection, values));
};

/** まとめて書いた結果（T27e）。 */
export interface ReadCheckResultsRecording {
  /** 書いた結果の定義の ID（入力の順）。 */
  readonly recorded: readonly string[];
  /** 定義の版が今の版と違う（または定義がない）ので、書かなかった結果の定義の ID（入力の順）。 */
  readonly rejectedStale: readonly string[];
}

/**
 * READ の確かめのジョブ 1 回の結果を、1 つのトランザクションで書く（T27e）。定義の版が今の版と違う結果（実行の間に定義が変わった・ない）は、
 * 書かずに `rejectedStale` に数える（ほかの結果は書く）。形の違う入力、同じ組の 2 回目は `RangeError` などで、何も書かない。
 */
export const recordReadCheckResults = (database: ControlDatabase, inputs: readonly ReadCheckResultInput[]): ReadCheckResultsRecording => {
  const values = inputs.map(requireResultInput);
  return withWriteTransaction(database, (connection) => {
    const recorded: string[] = [];
    const rejectedStale: string[] = [];
    for (const input of values) {
      if (!isCurrentRevision(connection, input)) {
        rejectedStale.push(input.readCheckId);
        continue;
      }
      recordResultIn(connection, input);
      recorded.push(input.readCheckId);
    }
    return Object.freeze({ recorded: Object.freeze(recorded), rejectedStale: Object.freeze(rejectedStale) });
  });
};

// ---------------------------------------------------------------------------------------------------------------
// 読み出し
// ---------------------------------------------------------------------------------------------------------------

/** 定義 1 件（なければ null）。 */
export const readReadCheck = (database: ControlDatabase, readCheckId: string): ReadCheckView | null =>
  withReadTransaction(database, (connection) => {
    const row = connection.prepare(SELECT_READ_CHECK_SQL).get(readCheckId) as ReadCheckRow | undefined;
    return row === undefined ? null : readCheckViewOf(row);
  });

/** プロファイルの定義の一覧（作った順。既定は取り消していないものだけ）。 */
export const listReadChecks = (
  database: ControlDatabase,
  profileId: string,
  options: ReadCheckListOptions = {},
): readonly ReadCheckView[] => {
  return withReadTransaction(database, (connection) => listReadChecksIn(connection, profileId, options));
};

/**
 * プロファイルの定義の一覧（`listReadChecks` と同じ形と順）を、呼び出し側のトランザクションの中で読む（CCX-17。CC-078。読むだけ。呼び出し側の
 * `withReadTransaction`・`withWriteTransaction` の中から呼ぶ）。
 */
export const listReadChecksIn = (
  connection: SqliteConnection,
  profileId: string,
  options: ReadCheckListOptions = {},
): readonly ReadCheckView[] => {
  const includeCanceled = options.includeCanceled === true ? SQL_TRUE : SQL_FALSE;
  return Object.freeze(
    (connection.prepare(SELECT_PROFILE_READ_CHECKS_SQL).all(profileId, includeCanceled) as unknown as ReadCheckRow[]).map(readCheckViewOf),
  );
};

/** プロファイルの最近の結果（新しい順。`limit` 件まで）。 */
export const readRecentReadCheckResults = (
  database: ControlDatabase,
  profileId: string,
  limit: number = DEFAULT_RECENT_READ_CHECK_RESULTS,
): readonly ReadCheckResultView[] => {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError('the limit must be a positive safe integer');
  }
  return withReadTransaction(database, (connection) => Object.freeze(
    (connection.prepare(SELECT_RECENT_RESULTS_SQL).all(profileId, limit) as unknown as ResultRow[]).map(resultViewOf),
  ));
};
