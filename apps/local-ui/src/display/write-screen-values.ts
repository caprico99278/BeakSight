/**
 * OP-2 の修正の 2 回目（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.2 の R1、判断 2）: サイトの画面の「登録・更新を試せる画面」の一覧の、行の値の閉じた
 * 一覧と、試せない理由のコードの振り分け（ブラウザ側からも読める値だけ。サーバの値はチェックの保存の `server/write-screen-functions.ts` が求める）。
 */
import { VERIFIED_ACTION_RESULT, type ActionBlockReason, type ActionResult } from '../../../../src/control/actions/action-contracts.js';
import { isRecordIdLikePathSegment } from '../../../../src/core/api-request-shape.js';
import { UPDATE_SCENARIO_KIND, type ScenarioKind } from '../../../../src/core/scenario-kind.js';
import { LOCAL_UI_WRITE_SCREENS_TEXT } from '../../../../src/presentation/messages.js';
import type { ScenarioDraftRejectionReason } from '../../../../src/core/scenario-draft-rejection-reasons.js';

/** 画面の名前のもとにしない、path の区切り。 */
const SCREEN_WORD_SKIPPED: ReadonlySet<string> = new Set(['new', 'edit']);

/**
 * 画面の名前のもと（`LOCAL_UI_WRITE_SCREENS_TEXT.screenName` に渡す語）: path の区切りのうち、番号に見えず、`new`・`edit` でない最後のもの（なければ空）。
 * OP-3: サイトの画面の一覧と、作ったデータの一覧が、同じ 1 か所で求める（ふだんの画面にアドレスの後ろを出さないため）。
 */
export const writeScreenWordOf = (path: string): string =>
  [...path.split('/')].reverse().find((segment) => segment.length > 0 && !SCREEN_WORD_SKIPPED.has(segment) && !isRecordIdLikePathSegment(segment)) ?? '';

/**
 * OP-2 の修正の 2 回目（判断 2）: 試せない行の理由の種類（閉じた一覧。文言はカタログ `LOCAL_UI_WRITE_SCREENS_TEXT.notCheckable`。網羅は `catalog-coverage.ts`）。
 * - `SECRET_FIELD`: 秘密に見える欄がある。`DESTRUCTIVE`: 消す・取り消すなどの操作に当たる。`ANSWER_CHECK`: 答え合わせのしかたを決められない。
 * - `SITE_CHANGED`: 操作さがしの後にサイトの設定が変わった（もう一度点検すると試せる）。`UNSUPPORTED`: そのほか（BeakSight が扱えない入力のしかた）。
 * - OP-K（K2）: `SECRET_KEY`: 画面が自動で入れて送る項目に、秘密に見える名前のものがある。`FIELD_SHAPE`: 入れた値と送る中身の結び付きが分からない（1 つの欄の値を
 *   いくつもの項目に入れて送る、欄の値を別の形に変えて送るなど）。
 */
export const WRITE_SCREEN_NOT_CHECKABLE_KINDS = Object.freeze([
  'SECRET_FIELD', 'DESTRUCTIVE', 'ANSWER_CHECK', 'SITE_CHANGED', 'UNSUPPORTED', 'SECRET_KEY', 'FIELD_SHAPE',
] as const);
export type WriteScreenNotCheckableKind = (typeof WRITE_SCREEN_NOT_CHECKABLE_KINDS)[number];

/** 理由のコードの種類（どのコードも 1 つの種類に振り分ける。型で網羅する）。 */
const NOT_CHECKABLE_KIND_OF_REASON: Readonly<Record<ScenarioDraftRejectionReason, WriteScreenNotCheckableKind>> = Object.freeze({
  SCENARIO_FIELD_SECRET_LIKE: 'SECRET_FIELD',
  SCENARIO_FORM_HAS_UNREADABLE_SECRET_FIELD: 'SECRET_FIELD',
  SCENARIO_UPDATE_FORM_HAS_SECRET_LIKE_FIELD: 'SECRET_FIELD',
  SCENARIO_UPDATE_FORM_HAS_SECRET_LIKE_STATE_FIELD: 'SECRET_FIELD',
  SCENARIO_API_PAGE_KEY_SECRET_LIKE: 'SECRET_KEY',
  SCENARIO_API_RECORD_ID_KEY_SECRET_LIKE: 'SECRET_FIELD',
  SCENARIO_FIELD_DANGEROUS_WORD: 'DESTRUCTIVE',
  SCENARIO_REMOVAL_FIELD_NOT_CHANGEABLE: 'DESTRUCTIVE',
  SCENARIO_CANDIDATE_NOT_WRITABLE: 'DESTRUCTIVE',
  SCENARIO_READ_CHECK_NOT_FOUND: 'ANSWER_CHECK',
  SCENARIO_READ_CHECK_CANCELED: 'ANSWER_CHECK',
  SCENARIO_READ_CHECK_REVISION_MISMATCH: 'ANSWER_CHECK',
  SCENARIO_VERIFICATION_PARAMETER_UNKNOWN: 'ANSWER_CHECK',
  SCENARIO_VERIFICATION_FIELD_NOT_SENT: 'ANSWER_CHECK',
  SCENARIO_VERIFICATION_READ_CHECK_PAGE_TARGET: 'ANSWER_CHECK',
  SCENARIO_API_READ_VERIFICATION_NOT_BOUND: 'ANSWER_CHECK',
  SCENARIO_API_DISCOVERY_PROFILE_STALE: 'SITE_CHANGED',
  SCENARIO_INPUT_INVALID: 'UNSUPPORTED',
  SCENARIO_CANDIDATE_UNKNOWN: 'UNSUPPORTED',
  SCENARIO_CANDIDATE_REQUEST_UNSUPPORTED: 'UNSUPPORTED',
  SCENARIO_FIELD_TYPE_NOT_SENDABLE: 'UNSUPPORTED',
  SCENARIO_FIELD_NOT_ALLOWED: 'UNSUPPORTED',
  SCENARIO_CREATE_DEFAULT_VALUE_FIELD_NOT_SENT: 'UNSUPPORTED',
  SCENARIO_UPDATE_SPEC_MISSING: 'UNSUPPORTED',
  SCENARIO_UPDATE_SPEC_NOT_ALLOWED: 'UNSUPPORTED',
  SCENARIO_UPDATE_TARGET_NOT_FOUND: 'UNSUPPORTED',
  SCENARIO_UPDATE_TARGET_NOT_CREATE: 'UNSUPPORTED',
  SCENARIO_UPDATE_PATH_MISMATCH: 'UNSUPPORTED',
  SCENARIO_UPDATE_RECORD_ID_UNSAFE: 'UNSUPPORTED',
  SCENARIO_UPDATE_PATH_NOT_BOUND_TO_LEDGER_ID: 'UNSUPPORTED',
  SCENARIO_STATE_FIELD_NOT_CHANGEABLE: 'UNSUPPORTED',
  SCENARIO_UPDATE_FIELD_ROLE_OVERLAP: 'UNSUPPORTED',
  SCENARIO_UPDATE_FIELD_ROLE_MISSING: 'UNSUPPORTED',
  SCENARIO_UPDATE_NO_CHANGED_FIELD: 'UNSUPPORTED',
  SCENARIO_LIMIT_ABOVE_DEFAULT: 'UNSUPPORTED',
  SCENARIO_LIMIT_INCONSISTENT: 'UNSUPPORTED',
  SCENARIO_TTL_ABOVE_DEFAULT: 'UNSUPPORTED',
  SCENARIO_API_CANDIDATE_NOT_API: 'UNSUPPORTED',
  SCENARIO_API_STATE_KEY: 'UNSUPPORTED',
  SCENARIO_API_METHOD_OVERRIDE: 'UNSUPPORTED',
  SCENARIO_API_HEADER_METHOD_OVERRIDE: 'UNSUPPORTED',
  SCENARIO_API_ORIGIN_NOT_APPROVED: 'UNSUPPORTED',
  SCENARIO_API_SHAPE_NOT_EXECUTABLE: 'UNSUPPORTED',
  SCENARIO_API_FIELD_KEY_MISMATCH: 'FIELD_SHAPE',
  SCENARIO_API_FIELD_TYPE_MISMATCH: 'UNSUPPORTED',
  SCENARIO_API_KEY_NOT_ALLOWED: 'UNSUPPORTED',
  SCENARIO_API_FILTER_MISMATCH: 'UNSUPPORTED',
  SCENARIO_API_PAGE_KEY_NOT_SCALAR: 'UNSUPPORTED',
  SCENARIO_API_PAGE_KEY_NOT_IDENTIFIABLE: 'UNSUPPORTED',
  SCENARIO_API_FILTER_NOT_BOUND_TO_LEDGER_ID: 'UNSUPPORTED',
});

/** 試せない理由のコードの、やさしい 1 行の種類。 */
export const writeScreenNotCheckableKindOf = (reason: ScenarioDraftRejectionReason): WriteScreenNotCheckableKind =>
  NOT_CHECKABLE_KIND_OF_REASON[reason];

/**
 * OP-2 の修正の 2 回目（R1）: 更新の 1 行の状態（閉じた一覧。文言はカタログ `LOCAL_UI_WRITE_SCREENS_TEXT.update`）。`NEXT_INSPECTION`: 更新の画面がまだ見つからない
 * （作ったデータがあれば、次の点検の操作さがしで見つかる）。`NOT_DECIDABLE`: 見つかったが、更新する欄を決められない（登録だけを試す）。
 * OP-F（M-3）: `MAY_NOTIFY`: 点検の中で見つかった更新の画面が知らせを送ることがあり、チェックがそれを確かめていない（更新は自動では承認しない。もう一度チェックすると試す）。
 */
export const WRITE_SCREEN_UPDATE_STATES = Object.freeze(['NEXT_INSPECTION', 'NOT_DECIDABLE', 'MAY_NOTIFY'] as const);
export type WriteScreenUpdateState = (typeof WRITE_SCREEN_UPDATE_STATES)[number];

/**
 * OP-F（設計者の判断の 4）: 前の点検の結果の、登録か更新の 1 つ。`tried` は最後に試した（送った・送ったか分からない）回の結果（なければ null）。`notSentReason` は、
 * 最後の回が送らずに締めた回なら、その理由（なければ null）。
 */
export interface WriteScreenKindResultView {
  readonly tried: ActionResult | null;
  readonly notSentReason: ActionBlockReason | null;
}

/** 前の点検の結果（登録・更新。どちらも書き込みの記録がなければ null）。 */
export interface WriteScreenLastResultView {
  readonly create: WriteScreenKindResultView | null;
  readonly update: WriteScreenKindResultView | null;
}

/**
 * 前の点検の結果の行（OP-F）。`notTried`: 最後の回が送らずに締めた回なら「前回は試せませんでした」と理由の 1 行（登録が先、更新だけなら更新の形）。`confirmed`:
 * 前に確かめた（試した）結果の 1 行（送らずに締めた回で隠さない）。OP-2 の修正の 2 回目（R1）: 更新の書き込みの手順がまだない行（`updatePending`）は、更新の結果を
 * 書かない（更新の 1 行が、次の点検で試すことを出す）。
 */
export const writeScreenLastResultLinesOf = (
  result: WriteScreenLastResultView,
  updatePending: boolean,
): { readonly notTried: string | null; readonly confirmed: string | null } => {
  const text = LOCAL_UI_WRITE_SCREENS_TEXT.lastResult;
  const createReason = result.create?.notSentReason ?? null;
  const updateReason = result.update?.notSentReason ?? null;
  const notTried = createReason !== null
    ? text.notTried(text.notSentReasons[createReason])
    : updateReason !== null ? text.updateNotTriedLast(text.notSentReasons[updateReason]) : null;
  const created = result.create?.tried ?? null;
  const updated = result.update?.tried ?? null;
  if (created === null) {
    return { notTried, confirmed: null };
  }
  if (created !== VERIFIED_ACTION_RESULT) {
    return { notTried, confirmed: text.createNotVerified };
  }
  if (updated === null && updatePending) {
    return { notTried, confirmed: text.createdOnly };
  }
  const update = updated === null ? text.updateNotTried : updated === VERIFIED_ACTION_RESULT ? text.updated : text.updateNotVerified;
  return { notTried, confirmed: text.line(text.created, update) };
};

/** OP-H: 行の結果の 1 行の種類（`LAST_NOT_TRIED`: 送らずに締めた回、`LAST_RESULT`: 前に確かめた結果、`UPDATE_STATE`: 更新の 1 行）。 */
export type WriteScreenResultLine =
  | { readonly kind: 'LAST_NOT_TRIED' | 'LAST_RESULT'; readonly text: string }
  | { readonly kind: 'UPDATE_STATE'; readonly text: string; readonly updateState: WriteScreenUpdateState };

/** 行の結果の文を決める、行の値（チェックの状態、前の点検の結果、更新の 1 行）。 */
export interface WriteScreenResultLinesInput {
  readonly state: string;
  readonly lastResult: WriteScreenLastResultView | null;
  readonly updateState: WriteScreenUpdateState | null;
}

/**
 * OP-H（撮影 UI-W4 の 2）: 一覧の行の結果の文の並び（文の組み立てと並びの唯一の置き場所）。送らずに締めた回の 1 行 → 前に確かめた結果（「登録しました。」
 * 「更新しました。」）→（あれば）更新の 1 行（「更新は、次の点検で試します。」など）。更新の 1 行は、チェックできる行にだけ出す。
 */
export const writeScreenRowResultLinesOf = (row: WriteScreenResultLinesInput): readonly WriteScreenResultLine[] => {
  const last = row.lastResult === null ? null : writeScreenLastResultLinesOf(row.lastResult, row.updateState !== null);
  const lines: WriteScreenResultLine[] = [];
  if (last?.notTried != null) {
    lines.push({ kind: 'LAST_NOT_TRIED', text: last.notTried });
  }
  if (last?.confirmed != null) {
    lines.push({ kind: 'LAST_RESULT', text: last.confirmed });
  }
  if (row.state !== 'NOT_CHECKABLE' && row.updateState !== null) {
    lines.push({ kind: 'UPDATE_STATE', text: LOCAL_UI_WRITE_SCREENS_TEXT.update[row.updateState], updateState: row.updateState });
  }
  return lines;
};

/**
 * OP-G（指示書の 3。完了の正直さ）: 点検の要点の書き込みの 1 行の種類（閉じた一覧。文言はカタログ `LOCAL_UI_WRITE_SCREENS_TEXT.inspectionWrite`）。点検が実際に送った
 * 書き込みの段と、その結果から決める（チェックしただけでは「行いました」にしない）。
 */
export const INSPECTION_WRITE_OUTCOMES = Object.freeze(['WROTE', 'CREATED', 'NOT_CONFIRMED', 'NOT_TRIED'] as const);
export type InspectionWriteOutcome = (typeof INSPECTION_WRITE_OUTCOMES)[number];

/** 点検の書き込みの段 1 つの事実（段の種類と、締めた結果。締めていなければ null）。 */
export interface InspectionWriteStageFact {
  readonly kind: ScenarioKind | null;
  readonly result: ActionResult | null;
}

/** 書き込みの段を 1 つも行わずに、チェックした画面を試せなかった連鎖の止まり方（`stage-chain-policy.ts` の `WRITE_NOT_TRIED`）。 */
const WRITE_NOT_TRIED_STOP_REASON = 'WRITE_NOT_TRIED';

/**
 * 点検の要点の書き込みの 1 行の種類（書き込みと関係のない点検は null）。
 * - 段がない: 試せなかった止まり方なら `NOT_TRIED`、ほかは null（チェックした画面がない点検）。
 * - 段のどれかが確かめられていない、または試せなかった画面が残った: `NOT_CONFIRMED`。
 * - すべて確かめられた: 更新の段があれば `WROTE`、登録だけなら `CREATED`。
 */
export const inspectionWriteOutcomeOf = (input: {
  readonly stopReason: string | null;
  readonly writes: readonly InspectionWriteStageFact[];
}): InspectionWriteOutcome | null => {
  const notTried = input.stopReason === WRITE_NOT_TRIED_STOP_REASON;
  if (input.writes.length === 0) {
    return notTried ? 'NOT_TRIED' : null;
  }
  if (notTried || input.writes.some(({ result }) => result !== VERIFIED_ACTION_RESULT)) {
    return 'NOT_CONFIRMED';
  }
  return input.writes.some(({ kind }) => kind === UPDATE_SCENARIO_KIND) ? 'WROTE' : 'CREATED';
};
