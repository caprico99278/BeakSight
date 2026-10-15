// 書き込みの結果の表（管理データの版 8 の `write_results`）の行の読み方と読み出しの唯一の owner（Task 30 の設計書 3 章の「記録」「`UNKNOWN` の後」。
// T30d）。読むだけ（SQL の書き込みの文を持たない）。
// - 書くのは `src/control/approval/scenario-store.ts` だけ（予約の締めと同じトランザクションで書くため。版 6 の表に書くのは、そのファイルだけ。
//   Architecture Gate `control-store-boundary.test.ts` の (l)(m)）。そのファイルも、行の形はここの `writeResultViewOf` で読む。
// - 生成の履歴（`writeGenerationHistoryIn`。読む口は `scenario-store.ts` の `readScenarioWriteGenerationHistory`。CCX-28 で、src から使われなく
//   なった `readWriteGenerationHistory` を消した）: シナリオの使った一意にする欄の組（`unique_key`）と、プロファイルの使った電話番号
//   （`phone_numbers`）。結果によらず、記録したすべての行から読む（`UNKNOWN`・`BLOCKED` を含む。送ったか分からない値も、送らなかった値も、
//   使った値として二度と作らない。Task 30 の設計書 3 章の「`UNKNOWN` の後」）。読む順は記録の順。
// - T31e（Task 31 の設計書 3 章の「証拠と記録」「対象の選び方」、4 章の「台帳の読み出し」。管理データの版 9）: 行に、書き込みの種類（`CREATE`・
//   `UPDATE`）、対象のレコードの ID（UPDATE だけ）、UPDATE の証拠（`WriteUpdateEvidence`）を足した。UPDATE の対象にできるレコードの台帳
//   （`verifiedRegistrationsIn`。参照した CREATE のシナリオの `VERIFIED` の登録）と、生成の履歴の鍵の求め直し（`writeGenerationHistoryIn`。使った
//   値（CREATE の登録と UPDATE で送った値）から、そのシナリオの一意にする欄の組で `uniqueKeyOf` を求め直す）を足した。
// - 行の値が契約の形に合わなければ、データベースの誤り（`DATABASE_INTEGRITY_FAILED`）。
import { isNonNegativeSafeInteger, isPositiveSafeInteger, isRecord } from '../../core/guards.js';
import { deepFreeze } from '../../core/immutable.js';
import { READ_CHECK_RESULTS, type ReadCheckResult } from '../../discovery/read-check-contracts.js';
import { uniqueKeyOf, type SeedRecord } from '../data-rules/scenario-data.js';
import { SCENARIO_KINDS, type ScenarioKind } from '../approval/scenario-contracts.js';
import type { UpdateTargetCandidate } from '../approval/execution-grant.js';
import type { ControlDatabase } from '../store/control-database.js';
import type { SqliteConnection } from '../store/sqlite-module.js';
import { storedRowIntegrityError } from '../store/store-errors.js';
import { withReadTransaction } from '../store/transaction.js';
import {
  ACTION_BLOCK_REASONS,
  ACTION_OUTCOME_REASONS,
  ACTION_RESULTS,
  RESPONSE_JUDGEMENTS,
  SETTLED_RESERVATION_STATES,
  SUBMISSION_STATES,
  UPDATE_EVIDENCE_FIELD_ROLES,
  type ActionBlockReason,
  type ActionOutcomeReason,
  type ActionResult,
  type ResponseJudgement,
  type SettledReservationState,
  type SubmissionState,
  type WriteUpdateEvidence,
  type WriteUpdateFieldEvidence,
} from './action-contracts.js';
import { isUsableRecordId } from './action-outcome.js';

/** 表の名前（誤りの文に使う）。 */
const TABLE = 'write_results';

/** 書き込みの結果の行（列の名前のまま）。 */
export interface WriteResultRow {
  readonly job_id: string;
  readonly grant_id: string;
  readonly profile_id: string;
  readonly scenario_id: string;
  readonly scenario_revision: number;
  readonly write_kind: string;
  readonly target_record_id: string | null;
  readonly seed_record: string | null;
  readonly submitted_values: string;
  readonly unique_key: string | null;
  readonly phone_numbers: string;
  readonly submission: string | null;
  readonly block_reason: string | null;
  readonly http_status: number | null;
  readonly response_judgement: string | null;
  readonly record_id: string | null;
  readonly read_verification: string | null;
  readonly update_evidence: string | null;
  readonly result: string | null;
  readonly reason: string | null;
  readonly reservation_state: string | null;
  readonly recorded_at: string;
  readonly submitted_at: string | null;
  readonly settled_at: string | null;
}

/** 行の列（この順）。 */
export const WRITE_RESULT_COLUMNS = [
  'job_id', 'grant_id', 'profile_id', 'scenario_id', 'scenario_revision', 'write_kind', 'target_record_id', 'seed_record', 'submitted_values',
  'unique_key', 'phone_numbers', 'submission', 'block_reason', 'http_status', 'response_judgement', 'record_id', 'read_verification',
  'update_evidence', 'result', 'reason', 'reservation_state', 'recorded_at', 'submitted_at', 'settled_at',
].join(', ');

/**
 * 書き込みの結果 1 件（凍結。日時は UTC の 14 桁）。締める前は、送信の状態から締めの時刻までが null。回復で値なしに足した行は、seed の記録が null、
 * 送った値が空、一意にする欄の組が null、電話番号が空。
 */
export interface WriteResultView {
  readonly jobId: string;
  readonly grantId: string;
  readonly profileId: string;
  readonly scenarioId: string;
  readonly scenarioRevision: number;
  /** 書き込みの種類（T31e。版 9 の前の行は `CREATE`）。 */
  readonly writeKind: ScenarioKind;
  /** 対象のレコードの ID（T31e。UPDATE だけ。実行の許可の対象の写し）。 */
  readonly targetRecordId: string | null;
  readonly seedRecord: SeedRecord | null;
  readonly submittedValues: Readonly<Record<string, string>>;
  readonly uniqueKey: string | null;
  readonly phoneNumbers: readonly string[];
  readonly submission: SubmissionState | null;
  readonly blockReason: ActionBlockReason | null;
  readonly httpStatus: number | null;
  readonly responseJudgement: ResponseJudgement | null;
  readonly recordId: string | null;
  readonly readVerification: ReadCheckResult | null;
  /** UPDATE の証拠（T31e。UPDATE の締めた行だけ。なければ null）。 */
  readonly updateEvidence: WriteUpdateEvidence | null;
  readonly result: ActionResult | null;
  readonly reason: ActionOutcomeReason | null;
  readonly reservationState: SettledReservationState | null;
  readonly recordedAt: string;
  readonly submittedAt: string | null;
  readonly settledAt: string | null;
}

/** 書き込みの種類の UPDATE（T31e）。 */
const UPDATE_WRITE_KIND = 'UPDATE' satisfies ScenarioKind;

/** 生成の履歴（Task 29 の生成の部品 `generateScenarioData` に渡す。凍結）。 */
export interface WriteGenerationHistory {
  /** シナリオの使った一意にする欄の組（`uniqueKeyOf` の値。重なりを除く。記録の順）。 */
  readonly usedUniqueKeys: readonly string[];
  /** プロファイルの使った電話番号（重なりを除く。記録の順）。 */
  readonly usedPhoneNumbers: readonly string[];
}

const SELECT_JOB_SQL = `SELECT ${WRITE_RESULT_COLUMNS} FROM write_results WHERE job_id = ?`;
const SELECT_GRANT_SQL = `SELECT ${WRITE_RESULT_COLUMNS} FROM write_results WHERE grant_id = ?`;
const SELECT_SCENARIO_SQL = `SELECT ${WRITE_RESULT_COLUMNS} FROM write_results WHERE scenario_id = ? ORDER BY recorded_at, job_id`;
const SELECT_PROFILE_PHONES_SQL = `SELECT phone_numbers FROM write_results
  WHERE profile_id = (SELECT profile_id FROM scenarios WHERE scenario_id = ?) ORDER BY recorded_at, job_id`;
/** シナリオの一覧の書き込みの結果（T31e。生成の履歴。`json_each` の配列の中のシナリオの id。記録の順）。 */
const SELECT_SCENARIOS_SQL = `SELECT ${WRITE_RESULT_COLUMNS} FROM write_results
  WHERE scenario_id IN (SELECT value FROM json_each(?)) ORDER BY recorded_at, job_id`;
/** 参照した CREATE のシナリオの、照合まで済んだ登録（T31e。UPDATE の対象にできるレコードの台帳）。 */
const SELECT_VERIFIED_REGISTRATIONS_SQL = `SELECT record_id, submitted_at, job_id FROM write_results
  WHERE scenario_id = ? AND write_kind = ? AND result = ? ORDER BY submitted_at DESC, job_id DESC`;
/** 照合まで済んだ登録の書き込みの種類と結果（T31e）。 */
const CREATE_WRITE_KIND = 'CREATE' satisfies ScenarioKind;
const VERIFIED_RESULT = 'VERIFIED' satisfies ActionResult;

/** 閉じた一覧の値か（null は null のまま）。合わなければ、データベースの誤り。 */
const oneOf = <T extends string>(list: readonly T[], value: string | null, column: string): T | null => {
  if (value === null) {
    return null;
  }
  if (!(list as readonly string[]).includes(value)) {
    throw storedRowIntegrityError(TABLE, `${column} is not in the closed list`);
  }
  return value as T;
};

const parsed = (text: string, column: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw storedRowIntegrityError(TABLE, `${column} is not JSON`, error);
  }
};

/** seed の記録（契約の形の近似の確かめ。中身の意味は Task 29 の生成の部品が持つ）。 */
const seedRecordOf = (text: string | null): SeedRecord | null => {
  if (text === null) {
    return null;
  }
  const value = parsed(text, 'seed_record');
  if (!isRecord(value) || typeof value.seed !== 'string' || !isRecord(value.seedInput) || typeof value.baseDate !== 'string'
    || !isNonNegativeSafeInteger(value.attempt)) {
    throw storedRowIntegrityError(TABLE, 'seed_record does not match the contract');
  }
  return value as unknown as SeedRecord;
};

const submittedValuesOf = (text: string): Readonly<Record<string, string>> => {
  const value = parsed(text, 'submitted_values');
  if (!isRecord(value) || Object.values(value).some((item) => typeof item !== 'string')) {
    throw storedRowIntegrityError(TABLE, 'submitted_values is not an object of strings');
  }
  return value as Readonly<Record<string, string>>;
};

const phoneNumbersOf = (text: string): readonly string[] => {
  const value = parsed(text, 'phone_numbers');
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw storedRowIntegrityError(TABLE, 'phone_numbers is not an array of strings');
  }
  return value as readonly string[];
};

/** UPDATE の証拠の欄 1 つの形か（T31e）。`CHANGED` は前の値と新しい値の文字列を持ち、`KEPT` はどちらも null。 */
const isUpdateFieldEvidence = (value: unknown): value is WriteUpdateFieldEvidence => {
  if (!isRecord(value) || typeof value.fieldName !== 'string' || value.fieldName.length === 0
    || !(UPDATE_EVIDENCE_FIELD_ROLES as readonly unknown[]).includes(value.role)
    || (value.matched !== null && typeof value.matched !== 'boolean')) {
    return false;
  }
  return value.role === 'CHANGED'
    ? typeof value.previousValue === 'string' && typeof value.newValue === 'string'
    : value.previousValue === null && value.newValue === null;
};

/**
 * UPDATE の証拠の形を確かめた凍結した写し（T31e。純粋）。形が違う（欄の形、同じ名前の欄が 2 つ、欄の項目の余り）なら null。記録の口
 * （`scenario-store.ts` の締め）と、行の読み出しが共用する。
 */
export const updateEvidenceOf = (value: unknown): WriteUpdateEvidence | null => {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !Array.isArray(value.fields) || !value.fields.every(isUpdateFieldEvidence)) {
    return null;
  }
  const fields = value.fields as readonly WriteUpdateFieldEvidence[];
  if (new Set(fields.map(({ fieldName }) => fieldName)).size !== fields.length) {
    return null;
  }
  return deepFreeze({
    fields: fields.map(({ fieldName, role, previousValue, newValue, matched }) => ({ fieldName, role, previousValue, newValue, matched })),
  });
};

/** 保存した UPDATE の証拠（null は null。形が違えば、データベースの誤り）。 */
const storedUpdateEvidenceOf = (text: string | null): WriteUpdateEvidence | null => {
  if (text === null) {
    return null;
  }
  const evidence = updateEvidenceOf(parsed(text, 'update_evidence'));
  if (evidence === null) {
    throw storedRowIntegrityError(TABLE, 'update_evidence does not match the contract');
  }
  return evidence;
};

/** 行を形にする（凍結）。 */
export const writeResultViewOf = (row: WriteResultRow): WriteResultView => {
  if (!isPositiveSafeInteger(row.scenario_revision)) {
    throw storedRowIntegrityError(TABLE, 'scenario_revision is not a positive integer');
  }
  const writeKind = oneOf(SCENARIO_KINDS, row.write_kind, 'write_kind');
  if (writeKind === null || (row.target_record_id !== null && !isUsableRecordId(row.target_record_id))
    || (writeKind === UPDATE_WRITE_KIND) !== (row.target_record_id !== null)) {
    throw storedRowIntegrityError(TABLE, 'write_kind and target_record_id do not match the contract');
  }
  return deepFreeze({
    jobId: row.job_id,
    grantId: row.grant_id,
    profileId: row.profile_id,
    scenarioId: row.scenario_id,
    scenarioRevision: row.scenario_revision,
    writeKind,
    targetRecordId: row.target_record_id,
    seedRecord: seedRecordOf(row.seed_record),
    submittedValues: submittedValuesOf(row.submitted_values),
    uniqueKey: row.unique_key,
    phoneNumbers: phoneNumbersOf(row.phone_numbers),
    submission: oneOf(SUBMISSION_STATES, row.submission, 'submission'),
    blockReason: oneOf(ACTION_BLOCK_REASONS, row.block_reason, 'block_reason'),
    httpStatus: row.http_status,
    responseJudgement: oneOf(RESPONSE_JUDGEMENTS, row.response_judgement, 'response_judgement'),
    recordId: row.record_id,
    readVerification: oneOf(READ_CHECK_RESULTS, row.read_verification, 'read_verification'),
    updateEvidence: storedUpdateEvidenceOf(row.update_evidence),
    result: oneOf(ACTION_RESULTS, row.result, 'result'),
    reason: oneOf(ACTION_OUTCOME_REASONS, row.reason, 'reason'),
    reservationState: oneOf(SETTLED_RESERVATION_STATES, row.reservation_state, 'reservation_state'),
    recordedAt: row.recorded_at,
    submittedAt: row.submitted_at,
    settledAt: row.settled_at,
  });
};

/** ジョブの書き込みの結果の行（なければ `undefined`。呼び出し側のトランザクションの中で読む）。 */
export const writeResultRowOfJob = (connection: SqliteConnection, jobId: string): WriteResultRow | undefined =>
  connection.prepare(SELECT_JOB_SQL).get(jobId) as WriteResultRow | undefined;

/** 許可の書き込みの結果の行（なければ `undefined`。呼び出し側のトランザクションの中で読む）。 */
export const writeResultRowOfGrant = (connection: SqliteConnection, grantId: string): WriteResultRow | undefined =>
  connection.prepare(SELECT_GRANT_SQL).get(grantId) as WriteResultRow | undefined;

/** ジョブの書き込みの結果（なければ null）。 */
export const readWriteResult = (database: ControlDatabase, jobId: string): WriteResultView | null =>
  withReadTransaction(database, (connection) => {
    const row = writeResultRowOfJob(connection, jobId);
    return row === undefined ? null : writeResultViewOf(row);
  });

/** シナリオの書き込みの結果の一覧（記録の順）。 */
export const readWriteResults = (database: ControlDatabase, scenarioId: string): readonly WriteResultView[] =>
  withReadTransaction(database, (connection) => Object.freeze(
    (connection.prepare(SELECT_SCENARIO_SQL).all(scenarioId) as unknown as WriteResultRow[]).map(writeResultViewOf),
  ));

/** 重なりを除いた一覧（最初の順）。 */
const distinct = (values: readonly string[]): readonly string[] => Object.freeze([...new Set(values)]);

/**
 * 生成の履歴を、呼び出し側のトランザクションの中で読む（T31e）。
 * - 一意にする欄の組の鍵: `scenarioId` の記録の `unique_key`（記録したときの鍵）と、`uniqueKeyFieldNames` があれば、`scenarioIds`（`scenarioId` と、
 *   同じ台帳の CREATE と UPDATE のシナリオ。呼び出し側が決める）の記録の使った値（CREATE の登録の値と、UPDATE で送った値）から、その欄の組で
 *   `uniqueKeyOf` を求め直した鍵（ほかのシナリオの鍵の文字列は、そのまま渡さない）。値なしの行（回復で足した行）は鍵を作らない。
 * - 電話番号: `scenarioId` のプロファイルの使った電話番号（今のまま）。
 */
export const writeGenerationHistoryIn = (
  connection: SqliteConnection,
  scenarioId: string,
  scenarioIds: readonly string[],
  uniqueKeyFieldNames: readonly string[] | null,
): WriteGenerationHistory => {
  const own = connection.prepare(SELECT_SCENARIO_SQL).all(scenarioId) as unknown as WriteResultRow[];
  const family = uniqueKeyFieldNames === null || uniqueKeyFieldNames.length === 0
    ? []
    : connection.prepare(SELECT_SCENARIOS_SQL).all(JSON.stringify([...new Set([scenarioId, ...scenarioIds])])) as unknown as WriteResultRow[];
  const phones = connection.prepare(SELECT_PROFILE_PHONES_SQL).all(scenarioId) as unknown as { readonly phone_numbers: string }[];
  const recomputed = family.flatMap((row) => {
    const values = submittedValuesOf(row.submitted_values);
    return Object.keys(values).length === 0 || uniqueKeyFieldNames === null ? [] : [uniqueKeyOf(values, uniqueKeyFieldNames)];
  });
  return Object.freeze({
    usedUniqueKeys: distinct([...own.flatMap(({ unique_key: uniqueKey }) => (uniqueKey === null ? [] : [uniqueKey])), ...recomputed]),
    usedPhoneNumbers: distinct(phones.flatMap(({ phone_numbers: text }) => phoneNumbersOf(text))),
  });
};

/**
 * 参照した CREATE のシナリオの、照合まで済んだ登録（T31e。UPDATE の対象にできるレコードの台帳。登録の時刻の新しい順。呼び出し側の
 * トランザクションの中で読む）。登録の ID が登録の ID の形（`isUsableRecordId`）でない行は、データベースの誤り。
 */
export const verifiedRegistrationsIn = (connection: SqliteConnection, createScenarioId: string): readonly UpdateTargetCandidate[] =>
  Object.freeze((connection.prepare(SELECT_VERIFIED_REGISTRATIONS_SQL).all(createScenarioId, CREATE_WRITE_KIND, VERIFIED_RESULT) as unknown as {
    readonly record_id: string | null;
    readonly submitted_at: string | null;
    readonly job_id: string;
  }[]).map((row) => {
    if (row.record_id === null || !isUsableRecordId(row.record_id) || row.submitted_at === null) {
      throw storedRowIntegrityError(TABLE, 'a verified registration has no usable record id or no submission time');
    }
    return Object.freeze({ recordId: row.record_id, registeredAt: row.submitted_at, jobId: row.job_id });
  }));

// ---------------------------------------------------------------------------------------------------------------
// T32g（Task 32 の設計書 4.1 の「監査済みデータの台帳」。ロードマップ 13.4）: 監査済みデータの台帳（画面だけ。書き出しのファイルは作らない）
// ---------------------------------------------------------------------------------------------------------------

/** 台帳の行の seed の記録の ID と digest（実行の許可の ID と、入力の規則の集まりの digest。seed の値・基準日・試行の番号は返さない）。 */
export interface AuditedSeedReference {
  readonly executionGrantId: string;
  readonly ruleSetDigest: string;
}

/** 台帳の行の登録の ID への UPDATE（回数と最後の 1 回。最後の 1 回の結果は、締める前なら null）。 */
export interface AuditedRecordUpdates {
  readonly count: number;
  readonly last: { readonly jobId: string; readonly result: ActionResult | null; readonly recordedAt: string } | null;
}

/** 監査済みデータの台帳の 1 行（CREATE の書き込み 1 件。凍結。日時は UTC の 14 桁）。 */
export interface AuditedDataLedgerEntry {
  readonly jobId: string;
  /** ジョブの Run の ID（ジョブの行がない・Run を始めていなければ null）。 */
  readonly runId: string | null;
  readonly grantId: string;
  readonly scenarioId: string;
  readonly scenarioRevision: number;
  /** 登録の ID（取れていなければ null）。 */
  readonly recordId: string | null;
  /** seed の記録の ID と digest（回復で値なしに足した行は null）。 */
  readonly seed: AuditedSeedReference | null;
  readonly submission: SubmissionState | null;
  readonly result: ActionResult | null;
  readonly readVerification: ReadCheckResult | null;
  readonly reservationState: SettledReservationState | null;
  readonly recordedAt: string;
  readonly submittedAt: string | null;
  /** その ID への UPDATE（UPDATE のシナリオの版が参照する CREATE のシナリオの登録にだけ数える。送らずに止めた回は数えない。ID がなければ 0 回）。 */
  readonly updates: AuditedRecordUpdates;
}

/** 送らずに止めた送信の状態（台帳の行にも UPDATE の回数にも入れない。データを作っても変えてもいない）。 */
const NOT_SENT_SUBMISSION = 'NOT_SENT' satisfies SubmissionState;

/**
 * プロファイルの CREATE の書き込みのうち、データを作ったかもしれないもの（送らずに止めた回を除く。締める前の回を含む）と、ジョブの Run の ID
 * （新しい順）。
 */
const SELECT_LEDGER_REGISTRATIONS_SQL = `SELECT ${WRITE_RESULT_COLUMNS}, (SELECT run_id FROM jobs WHERE jobs.job_id = write_results.job_id) AS run_id
  FROM write_results WHERE profile_id = ? AND write_kind = ? AND (submission IS NULL OR submission <> ?) ORDER BY recorded_at DESC, job_id DESC`;
/**
 * プロファイルの UPDATE の書き込みのうち、送ったかもしれないもの（CREATE の行と同じく、送らずに止めた回を除く。送ったか分からない回と締める前の回を
 * 含む）と、その版が参照する CREATE のシナリオ（記録の順）。
 */
const SELECT_LEDGER_UPDATES_SQL = `SELECT write_results.job_id AS job_id, write_results.target_record_id AS target_record_id,
  write_results.result AS result, write_results.recorded_at AS recorded_at,
  json_extract(scenario_revisions.document, '$.update.targetCreateScenarioId') AS create_scenario_id
  FROM write_results JOIN scenario_revisions
    ON scenario_revisions.scenario_id = write_results.scenario_id AND scenario_revisions.revision = write_results.scenario_revision
  WHERE write_results.profile_id = ? AND write_results.write_kind = ?
    AND (write_results.submission IS NULL OR write_results.submission <> ?) ORDER BY write_results.recorded_at, write_results.job_id`;

/** UPDATE の行（台帳の読み出しの形）。 */
interface LedgerUpdateRow {
  readonly job_id: string;
  readonly target_record_id: string | null;
  readonly result: string | null;
  readonly recorded_at: string;
  readonly create_scenario_id: unknown;
}

/** 登録の鍵（CREATE のシナリオと登録の ID。区切りは ID に入らない NUL）。 */
const ledgerKeyOf = (scenarioId: string, recordId: string): string => `${scenarioId}\u0000${recordId}`;

/** UPDATE がない登録の値。 */
const NO_UPDATES: AuditedRecordUpdates = deepFreeze({ count: 0, last: null });

/**
 * プロファイルの監査済みデータの台帳（T32g。読むだけ。新しい順）。行は、CREATE の書き込みのうち、データを作ったかもしれないもの（送らずに止めた
 * `NOT_SENT` を除く。結果が分からない回と締める前の回を含む）。UPDATE の回数と最後の結果は、UPDATE のシナリオの版が参照する CREATE のシナリオの、
 * 同じ登録の ID にだけ数える（T32R M-1: UPDATE も、送らずに止めた `NOT_SENT` の回は数えない）。プロファイルや行がなければ空。行の値が契約に合わなければ、データベースの誤り。
 */
export const readAuditedDataLedger = (database: ControlDatabase, profileId: string): readonly AuditedDataLedgerEntry[] =>
  withReadTransaction(database, (connection) => {
    const registrations = connection.prepare(SELECT_LEDGER_REGISTRATIONS_SQL).all(profileId, CREATE_WRITE_KIND, NOT_SENT_SUBMISSION) as unknown as
      (WriteResultRow & { readonly run_id: string | null })[];
    const updateRows = connection.prepare(SELECT_LEDGER_UPDATES_SQL).all(profileId, UPDATE_WRITE_KIND, NOT_SENT_SUBMISSION) as unknown as
      LedgerUpdateRow[];
    const updates = new Map<string, AuditedRecordUpdates>();
    for (const row of updateRows) {
      if (row.target_record_id === null || typeof row.create_scenario_id !== 'string') {
        throw storedRowIntegrityError(TABLE, 'an UPDATE write has no target record or no referenced CREATE scenario');
      }
      const key = ledgerKeyOf(row.create_scenario_id, row.target_record_id);
      updates.set(key, {
        count: (updates.get(key)?.count ?? 0) + 1,
        last: { jobId: row.job_id, result: oneOf(ACTION_RESULTS, row.result, 'result'), recordedAt: row.recorded_at },
      });
    }
    return deepFreeze(registrations.map((row) => {
      const view = writeResultViewOf(row);
      return {
        jobId: view.jobId,
        runId: row.run_id,
        grantId: view.grantId,
        scenarioId: view.scenarioId,
        scenarioRevision: view.scenarioRevision,
        recordId: view.recordId,
        seed: view.seedRecord === null
          ? null
          : { executionGrantId: view.seedRecord.seedInput.executionGrantId, ruleSetDigest: view.seedRecord.seedInput.ruleSetDigest },
        submission: view.submission,
        result: view.result,
        readVerification: view.readVerification,
        reservationState: view.reservationState,
        recordedAt: view.recordedAt,
        submittedAt: view.submittedAt,
        updates: view.recordId === null ? NO_UPDATES : updates.get(ledgerKeyOf(view.scenarioId, view.recordId)) ?? NO_UPDATES,
      };
    }));
  });
