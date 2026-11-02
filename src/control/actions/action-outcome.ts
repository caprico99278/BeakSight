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
// - PL-6a（設計書 `2026-10-26-beaksight-plain-ui-design.md` 8.1。調査 FV-0 の案 (b2)）: form の書き込みの結果の判定を、人が入れる条件（path の前方一致と
//   CSS セレクタ）から、構造の判定に変えた唯一の口（`formResultJudgementOf`）。4xx・5xx の扱いは API の判定と同じ部品（`errorResponseJudgementOf`）。
//   2xx・3xx は、照合（登録は答え合わせの READ、更新は更新の後の照合）で決め、一致しないときは、送った値を保った同じ「フォームの形」がもう一度出た
//   ときだけ入力の誤り（誤った失敗を出さないことを、判定できないが少し増えることより優先する）。送った後の URL から登録の ID を取る判定
//   （`recordIdOfResultUrl`）と、送る前の答え合わせの READ で送らずに止める判定（`preSubmitReadStopOf`）も、ここに置く。
// - 入出力を持たない。管理データ・画面・ブラウザ・ワーカーに触れない。
import { isRecordIdLikePathSegment } from '../../core/api-request-shape.js';
import {
  CLIENT_ERROR_HTTP_STATUS_RANGE,
  REDIRECTION_HTTP_STATUS_RANGE,
  SERVER_ERROR_HTTP_STATUS_RANGE,
  SUCCESS_HTTP_STATUS_RANGE,
  TOO_MANY_REQUESTS_HTTP_STATUS,
  isHttpStatusInRange,
} from '../../core/http-status.js';
import { recordIdOfPathPattern } from '../../core/record-id-path-pattern.js';
import { hasControlOrLineSeparator, hasLoneSurrogate } from '../../core/text.js';
import type { ReadCheckResult } from '../../discovery/read-check-contracts.js';
import { MAX_RECORD_ID_LENGTH } from '../approval/scenario-contracts.js';
import type {
  ActionOutcome,
  ActionOutcomeInput,
  ActionOutcomeReason,
  ActionResult,
  FormUpdatePostcheck,
  PrecheckFailureDetail,
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
  return errorResponseJudgementOf(status) ?? 'NO_CONDITION_MATCHED';
};

/**
 * 誤りの応答の状態の判定（純粋。PL-6a で API の判定から取り出し、form の判定 `formResultJudgementOf` と共有する唯一の部品）: 429 → `RATE_LIMITED`、
 * ほかの 4xx → `INPUT_ERROR`、5xx → `SERVER_ERROR`（登録を済ませていることがあるので `UNKNOWN`）。ほか（2xx・3xx、1xx、600 以上、整数でない値）は null。
 */
export const errorResponseJudgementOf = (status: number): ResponseJudgement | null => {
  if (!Number.isSafeInteger(status)) {
    return null;
  }
  if (status === TOO_MANY_REQUESTS_HTTP_STATUS) {
    return 'RATE_LIMITED';
  }
  if (isHttpStatusInRange(status, CLIENT_ERROR_HTTP_STATUS_RANGE)) {
    return 'INPUT_ERROR';
  }
  return isHttpStatusInRange(status, SERVER_ERROR_HTTP_STATUS_RANGE) ? 'SERVER_ERROR' : null;
};

/**
 * PL-6a: form の書き込みの、送信の後の文書の状態が、構造（照合とフォームの形）で判定する状態か（2xx・3xx。整数でない値は偽）。ワーカーは、この状態の
 * ときだけ、送った後の照合（登録の答え合わせの READ、更新の後の照合）を行う。
 */
export const isFormStructureStatus = (status: number): boolean => Number.isSafeInteger(status)
  && (isHttpStatusInRange(status, SUCCESS_HTTP_STATUS_RANGE) || isHttpStatusInRange(status, REDIRECTION_HTTP_STATUS_RANGE));

/**
 * PL-6a（設計書 8.1 の「判定の順」の 2）: 送った後の URL から、登録の ID を取る（純粋。取れなければ null）。ID の型（`{id}` の区切りを持つ path の型。
 * 契約は `MAX_FORM_RECORD_ID_PATTERNS` まで）を順に当て、最初に当たって、次をすべて満たす値: 区切りが ID の形（core の `isRecordIdLikePathSegment`。
 * 数字・UUID の形）、押す前の URL を同じ型に当てた値と違う、URL が押す前から変わった。当てるのは path だけ（query は見ない）。URL を読めなければ null。
 */
export const recordIdOfResultUrl = (pathPatterns: readonly string[], beforeUrl: string, afterUrl: string): string | null => {
  if (beforeUrl === afterUrl) {
    return null;
  }
  let beforePath: string;
  let afterPath: string;
  try {
    beforePath = new URL(beforeUrl).pathname;
    afterPath = new URL(afterUrl).pathname;
  } catch {
    return null;
  }
  for (const pattern of pathPatterns) {
    const recordId = recordIdOfPathPattern(afterPath, pattern);
    if (recordId !== null && isRecordIdLikePathSegment(recordId) && recordId !== recordIdOfPathPattern(beforePath, pattern)) {
      return recordId;
    }
  }
  return null;
};

/**
 * PL-6a（設計書 8.1 の「事前の確かめ」。設計者の判断）: form の登録を送る前に、同じ値で読んだ答え合わせの READ の結果から、送らずに止める理由を決める
 * （純粋）。値がもう見えていれば `VALUE_ALREADY_PRESENT`（照合に使えない。実験では、これがないと、登録していないのに `VERIFIED` になった）。判定できな
 * ければ `VERIFICATION_READ_UNAVAILABLE`（送った後の照合にも使えないので、件数を使って結果の分からない書き込みをしない）。見えていなければ null（送る）。
 */
export const preSubmitReadStopOf = (result: ReadCheckResult): PrecheckFailureDetail | null => {
  if (result === 'NOT_MATCHED') {
    return null;
  }
  return result === 'MATCHED' ? 'VALUE_ALREADY_PRESENT' : 'VERIFICATION_READ_UNAVAILABLE';
};

/**
 * PL-6a: form の書き込みの結果の判定の入力（送った後の観察。値は持たない）。
 * - `httpStatus`: 送信の後の main frame の最後の文書の状態（redirect の後。応答がなければ null）。
 * - `sameForm`: 送った後の画面に、送ったフォームと同じ「フォームの形」（`fingerprint.ts` の `formShapeKeyOf`）の候補があったか。
 * - `sameFormKeptValues`: その同じフォームが、送った値を保っていたか（読めなければ偽）。
 * - `recordId`: 送った後の URL から取った ID（`recordIdOfResultUrl`。なければ null）。
 * - `readVerification`: 登録の答え合わせの READ の結果（読まなかった・実行できなかったら null）。更新は見ない（更新の後の照合 `update.postcheck` で決める）。
 * - `update`: 更新だけ。対象の ID と、更新の後の照合の分け方。
 */
export interface FormResultFacts {
  readonly httpStatus: number | null;
  readonly sameForm: boolean;
  readonly sameFormKeptValues: boolean;
  readonly recordId: string | null;
  readonly readVerification: ReadCheckResult | null;
  readonly update?: { readonly targetRecordId: string; readonly postcheck: FormUpdatePostcheck } | undefined;
}

/** PL-6a: form の書き込みの判定（`action-run.json` の `responseJudgement` と `recordId`。応答がなければ判定は null）。 */
export interface FormResultJudgement {
  readonly responseJudgement: ResponseJudgement | null;
  readonly recordId: string | null;
}

const formJudgementOf = (responseJudgement: ResponseJudgement | null, recordId: string | null = null): FormResultJudgement =>
  Object.freeze({ responseJudgement, recordId });

/**
 * PL-6a（設計書 8.1 の「判定の順」。案 (b2)）: form の書き込みの結果の判定（純粋。登録・更新とも）。結果（`ActionResult`）は、この判定と照合の結果を
 * `actionOutcomeOf` に渡して決める（ワーカーと親の締めが同じ入力で同じ結果になる）。
 * 1. 応答がなければ判定なし（`NO_RESPONSE`）。4xx は入力の誤り（429 は回数の制限）、5xx は結果が分からない（`errorResponseJudgementOf`。API と共有）。
 *    2xx・3xx でない残り（1xx、600 以上）は `NO_CONDITION_MATCHED`。
 * 2. 2xx・3xx: 照合が一致すれば成功（登録は答え合わせの READ が `MATCHED`。ID は送った後の URL の ID。なければ null で `PARTIAL`。更新は更新の後の照合が
 *    `UPDATED`。ID は URL の ID があればそれ（対象と違えば `RECORD_ID_MISMATCH`）、なければ対象の ID）。
 * 3. 照合が一致しない（登録は READ が `NOT_MATCHED`、更新は `UNCHANGED`）ときは、送った値を保った同じフォームがもう一度出たときだけ入力の誤り。ほかは
 *    判定できない（`NO_CONDITION_MATCHED`）。登録で URL に新しい ID が出ていれば、成功の判定に ID を付けて返し、`actionOutcomeOf` が READ の不一致で
 *    `UNKNOWN`（`READ_VERIFICATION_NOT_MATCHED`）にする（失敗と言わない）。
 * 4. 照合を判定できない: 登録は、新しい ID があり同じフォームが出ていなければ、照合できない成功（`PARTIAL`・`READ_VERIFICATION_UNDETERMINED`）、ほかは
 *    判定できない。更新は、更新の後の照合を判定できなければ判定できない。更新の後の照合で、ほかの欄の変化（`CHANGED_OTHERWISE`）は、成功の判定に対象の
 *    ID を付けて返し、`actionOutcomeOf` が `UNEXPECTED_FIELD_CHANGE`（`UNKNOWN`）にする。
 */
export const formResultJudgementOf = (facts: FormResultFacts): FormResultJudgement => {
  const { httpStatus, sameForm, sameFormKeptValues, recordId, update } = facts;
  if (httpStatus === null) {
    return formJudgementOf(null);
  }
  if (!isFormStructureStatus(httpStatus)) {
    return formJudgementOf(errorResponseJudgementOf(httpStatus) ?? 'NO_CONDITION_MATCHED');
  }
  const inputErrorOrUndetermined = (): FormResultJudgement => formJudgementOf(sameForm && sameFormKeptValues ? 'INPUT_ERROR' : 'NO_CONDITION_MATCHED');
  if (update !== undefined) {
    if (update.postcheck === 'UPDATED' || update.postcheck === 'CHANGED_OTHERWISE') {
      return formJudgementOf('SUCCESS', recordId ?? update.targetRecordId);
    }
    return update.postcheck === 'UNCHANGED' ? inputErrorOrUndetermined() : formJudgementOf('NO_CONDITION_MATCHED');
  }
  if (facts.readVerification === 'MATCHED') {
    return formJudgementOf('SUCCESS', recordId);
  }
  if (facts.readVerification === 'NOT_MATCHED') {
    return recordId === null ? inputErrorOrUndetermined() : formJudgementOf('SUCCESS', recordId);
  }
  // 照合を判定できない（`UNDETERMINED`）・行わなかった（null）。
  return recordId !== null && !sameForm ? formJudgementOf('SUCCESS', recordId) : formJudgementOf('NO_CONDITION_MATCHED');
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
