// 書き込みの結果の判定の唯一の owner（Task 30 の設計書 3 章の「結果の判定」「登録の ID」「READ による照合」「予約の締め」。T30a）。純粋な関数。
// - 予約の締め方（`reservationSettlementOf`）: 送信の状態と応答の有無から、予約を `COMMITTED`・`UNKNOWN`・`RELEASED` のどれにするかを決める。
//   `RELEASED` は、Guard が POST を通さなかったことをワーカーが報告でき、応答もないときだけ。送った後に応答を受けたら `COMMITTED`。ほか
//   （応答がない、送ったか分からない、食い違う報告）は `UNKNOWN`（件数を使ったものとして数える。ユーザーの判断 2）。
// - `ActionResult`（`actionOutcomeOf`）: 照合できなければ `VERIFIED` にしない。結果が分からないのに成功と偽らない。送らずに止めたら `BLOCKED`。
//   照合の READ が成功の条件と食い違う（一致しない）ときは、ID の有無によらず `UNKNOWN`（登録されたか分からない）。`FAILED` は、入力の誤りと
//   429 だけ（5xx は `UNKNOWN`。T30a fix round 1）。
// - T31e fix round 1（Task 31 の設計書 3 章の「結果の判定」「更新の後の照合」）: UPDATE の書き込みは、成功の後に、更新の後の照合で一致しない欄が
//   あれば `UNKNOWN`（`UNEXPECTED_FIELD_CHANGE`）、取れた ID が対象の ID と違えば `UNKNOWN`（`RECORD_ID_MISMATCH`）、照合できない欄があれば
//   `PARTIAL`（`READ_VERIFICATION_UNDETERMINED`）。`VERIFIED` は、欄がすべて一致し、ID が対象と同じで、照合の READ が一致したときだけ。
// - T40c（Task 40 の設計書 7 章の「T40a の報告（API の検証の指定）」）: API の書き込みの応答の状態から結果の判定を決める唯一の口
//   （`apiResponseJudgementOf`）。今の閉じた一覧の値だけを返し、ID の判定は `actionOutcomeOf` に任せる。
// - 入出力を持たない。管理データ・画面・ブラウザ・ワーカーに触れない。
import {
  CLIENT_ERROR_HTTP_STATUS_RANGE,
  SERVER_ERROR_HTTP_STATUS_RANGE,
  SUCCESS_HTTP_STATUS_RANGE,
  TOO_MANY_REQUESTS_HTTP_STATUS,
  isHttpStatusInRange,
} from '../../core/http-status.js';
import { hasControlOrLineSeparator, hasLoneSurrogate } from '../../core/text.js';
import { MAX_RECORD_ID_LENGTH } from '../approval/scenario-contracts.js';
import type {
  ActionOutcome,
  ActionOutcomeInput,
  ActionOutcomeReason,
  ActionResult,
  ResponseJudgement,
  SettledReservationState,
  SubmissionState,
  WriteUpdateEvidence,
} from './action-contracts.js';

/**
 * 予約の締め方（純粋）。`responseReceived` は、送信の後の main frame の文書の応答を受けたか。
 * - `NOT_SENT` で応答なし → `RELEASED`。`NOT_SENT` で応答あり（食い違う報告）→ `UNKNOWN`（返さない側に倒す）。
 * - `SENT` で応答あり → `COMMITTED`。`SENT` で応答なし → `UNKNOWN`。
 * - `UNKNOWN` → `UNKNOWN`。
 */
export const reservationSettlementOf = (submission: SubmissionState, responseReceived: boolean): SettledReservationState => {
  if (submission === 'NOT_SENT') {
    return responseReceived ? 'UNKNOWN' : 'RELEASED';
  }
  return submission === 'SENT' && responseReceived ? 'COMMITTED' : 'UNKNOWN';
};

/**
 * 登録の ID として使える形の最大長（T30f。設計書 11 章の「登録の ID の形」。path の 1 区切りに入れる値として十分な長さ。`MAX_RECORD_ID_LENGTH` 以下）。
 */
export const MAX_SAFE_RECORD_ID_LENGTH = 64;

/**
 * 登録の ID として使える文字（T30f。英数字・`_`・`-` だけ。path の区切り・`.`・percent-encode・空白・非 ASCII を含まない）。CCX-28: スキーマの
 * 対象のレコードの ID の `pattern`（`source`）と最大長がこの値と `MAX_SAFE_RECORD_ID_LENGTH` に同じことを、`schema-enum-consistency.test.ts` が
 * 確かめるので公開する（`g`・`y` を持たないので `test` は状態を持たない）。
 */
export const SAFE_RECORD_ID_PATTERN = /^[A-Za-z0-9_-]+$/u;

/** 成果物（`action-run.json`）の `recordId` に記録してよい値か（1 文字以上、上限以下、制御文字・行の区切り・対でないサロゲートを含まない）。 */
const isRecordableRecordId = (recordId: string | null): recordId is string =>
  recordId !== null
  && recordId.length > 0
  && recordId.length <= MAX_RECORD_ID_LENGTH
  && !hasControlOrLineSeparator(recordId)
  && !hasLoneSurrogate(recordId);

/**
 * 登録の ID として使える値か（T30f で狭めた。Task 31 と共用する唯一の判定）: path の 1 区切りに入れて安全な閉じた形（英数字・`_`・`-`、1〜
 * `MAX_SAFE_RECORD_ID_LENGTH` 文字）。使えなければ、ID なしとして扱う。
 */
export const isUsableRecordId = (recordId: string | null): recordId is string =>
  recordId !== null && recordId.length <= MAX_SAFE_RECORD_ID_LENGTH && SAFE_RECORD_ID_PATTERN.test(recordId);

/** 記録する登録の ID（使える値ならその値、使えない値や null なら null。T30d: 記録の部品が使う）。 */
export const usableRecordIdOf = (recordId: string | null): string | null => (isUsableRecordId(recordId) ? recordId : null);

/**
 * 成果物（`action-run.json`）に書く登録の ID（T30f）。記録してよい値ならそのまま（使える形でなくても書き、判定は `RECORD_ID_UNSAFE` になる）、
 * 記録できない値（空、長すぎ、制御文字など）や null なら null（判定は `RECORD_ID_NOT_FOUND`）。ワーカーの書き込みの流れが使う。
 */
export const recordableRecordIdOf = (recordId: string | null): string | null => (isRecordableRecordId(recordId) ? recordId : null);

const outcomeOf = (result: ActionResult, reason: ActionOutcomeReason): ActionOutcome => Object.freeze({ result, reason });

/**
 * UPDATE の更新の後の照合の結果（純粋。T31e fix round 1 で締めの中に作り、T31g-2 でここへ移した。締め `scenario-store.ts` とワーカーの書き込みの
 * 流れが使う唯一の判定）: 一致しない欄があれば false、証拠がない・欄がない・照合できない欄があれば null、すべて一致なら true。
 */
export const fieldsMatchedOf = (evidence: WriteUpdateEvidence | null): boolean | null => {
  if (evidence === null || evidence.fields.length === 0) {
    return null;
  }
  if (evidence.fields.some(({ matched }) => matched === false)) {
    return false;
  }
  return evidence.fields.every(({ matched }) => matched === true) ? true : null;
};

/**
 * API の書き込みの応答の判定（純粋。T40c。Task 40 の設計書 7 章の「T40a の報告（API の検証の指定）」の設計者の判断）。送り手が応答を受けた
 * （`RESPONDED`）ときの状態から、今の閉じた一覧の値を決める（一覧は増やさない）。ワーカー（T40b）は、この関数を呼ぶだけにする。
 * - 2xx → `SUCCESS`（ID がない・安全でないときは、`actionOutcomeOf` が `RECORD_ID_NOT_FOUND`・`RECORD_ID_UNSAFE` にする。成功と偽らない）。
 * - 429 → `RATE_LIMITED`。ほかの 4xx → `INPUT_ERROR`。5xx → `SERVER_ERROR`（登録を済ませていることがあるので `UNKNOWN`）。
 * - それ以外（1xx・3xx、600 以上、整数でない値）→ `NO_CONDITION_MATCHED`（`UNKNOWN`）。応答がない（`NO_RESPONSE`）ときは呼ばない（判定は null）。
 * - 範囲と 429 は `src/core/http-status.ts` の共通の値（第二の定義を持たない）。
 */
export const apiResponseJudgementOf = (status: number): ResponseJudgement => {
  if (!Number.isSafeInteger(status)) {
    return 'NO_CONDITION_MATCHED';
  }
  if (isHttpStatusInRange(status, SUCCESS_HTTP_STATUS_RANGE)) {
    return 'SUCCESS';
  }
  if (status === TOO_MANY_REQUESTS_HTTP_STATUS) {
    return 'RATE_LIMITED';
  }
  if (isHttpStatusInRange(status, CLIENT_ERROR_HTTP_STATUS_RANGE)) {
    return 'INPUT_ERROR';
  }
  return isHttpStatusInRange(status, SERVER_ERROR_HTTP_STATUS_RANGE) ? 'SERVER_ERROR' : 'NO_CONDITION_MATCHED';
};

/** `ActionResult` とそれを決めた理由（純粋。凍結）。 */
export const actionOutcomeOf = (input: ActionOutcomeInput): ActionOutcome => {
  switch (input.submission) {
    case 'NOT_SENT':
      return outcomeOf('BLOCKED', input.blockReason);
    case 'UNKNOWN':
      return outcomeOf('UNKNOWN', 'NO_RESPONSE');
    case 'SENT':
      break;
  }
  const { responseJudgement, recordId, readVerification } = input;
  switch (responseJudgement) {
    case null:
      return outcomeOf('UNKNOWN', 'NO_RESPONSE');
    case 'INPUT_ERROR':
    case 'RATE_LIMITED':
      return outcomeOf('FAILED', responseJudgement);
    // T30a fix round 1（設計者の判断。設計書 11 章）: 5xx は、サーバが 5xx の前に登録を済ませていることがあるので `UNKNOWN`。
    case 'SERVER_ERROR':
    case 'NO_CONDITION_MATCHED':
    case 'MULTIPLE_CONDITIONS_MATCHED':
    case 'SESSION_LOST':
    case 'REPOST_REDIRECT':
    // T30R2-fix-1（M-b）: 応答をブラウザに返せなかった（今の画面は POST の応答ではない）。登録されたかは分からない。
    case 'RESPONSE_NOT_DELIVERED':
      return outcomeOf('UNKNOWN', responseJudgement);
    case 'SUCCESS':
      break;
  }
  if (readVerification === 'NOT_MATCHED') {
    return outcomeOf('UNKNOWN', 'READ_VERIFICATION_NOT_MATCHED');
  }
  // T31e fix round 1: UPDATE の更新の後の照合で一致しない欄（副作用の疑い）は、ID の有無によらず `UNKNOWN`。
  const { update } = input;
  if (update?.fieldsMatched === false) {
    return outcomeOf('UNKNOWN', 'UNEXPECTED_FIELD_CHANGE');
  }
  if (!isRecordableRecordId(recordId)) {
    return outcomeOf('PARTIAL', 'RECORD_ID_NOT_FOUND');
  }
  if (!isUsableRecordId(recordId)) {
    return outcomeOf('PARTIAL', 'RECORD_ID_UNSAFE');
  }
  // T31e fix round 1: UPDATE で、取れた ID が対象の ID と違う（どのレコードが変わったか分からない）。照合できない欄があれば `VERIFIED` にしない。
  if (update !== undefined && recordId !== update.targetRecordId) {
    return outcomeOf('UNKNOWN', 'RECORD_ID_MISMATCH');
  }
  // T31f: 更新の後の照合を判定できない（証拠がない・照合できない欄がある）ことは、照合の READ を判定できないこととは分けた理由にする。
  if (update !== undefined && update.fieldsMatched === null) {
    return outcomeOf('PARTIAL', 'UPDATE_POSTCHECK_UNDETERMINED');
  }
  return readVerification === 'MATCHED'
    ? outcomeOf('VERIFIED', 'READ_VERIFICATION_MATCHED')
    : outcomeOf('PARTIAL', 'READ_VERIFICATION_UNDETERMINED');
};
