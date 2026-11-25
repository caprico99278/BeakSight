/**
 * OP-2 の修正の 2 回目（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.2 の R1、判断 2）: サイトの画面の「登録・更新を試せる画面」の一覧の、行の値の閉じた
 * 一覧と、試せない理由のコードの振り分け（ブラウザ側からも読める値だけ。サーバの値はチェックの保存の `server/write-screen-functions.ts` が求める）。
 */
import {
  VERIFIED_ACTION_RESULT,
  type ActionBlockReason,
  type ActionResult,
  type PrecheckFailureDetail,
} from '../../../../src/control/actions/action-contracts.js';
import { apiArrayElementPathPartsOf, isRecordIdLikePathSegment } from '../../../../src/core/api-request-shape.js';
import { UPDATE_SCENARIO_KIND, type ScenarioKind } from '../../../../src/core/scenario-kind.js';
import { LOCAL_UI_SCENARIO_TEXT, LOCAL_UI_WRITE_SCREENS_TEXT } from '../../../../src/presentation/messages.js';
import type { ScenarioDraftRejectionReason } from '../../../../src/core/scenario-draft-rejection-reasons.js';

/** ARR-5: 並びの行の欄の鍵の、画面の見出し（あれば優先する。なければ、カタログの代わりの語）。 */
export interface ApiKeyPathHeadings {
  /** 並びの見出し（例: 資格、職歴）。 */
  readonly list?: string | null | undefined;
  /** まとまりの中の項目の見出し（例: 名前）。 */
  readonly inner?: string | null | undefined;
}

/**
 * ARR-5（DEF-234。設計書 `2026-11-09-beaksight-api-array-rows-design.md`）: 並びの行の欄の鍵（道 `key[i]`・`key[i].name`。読み方は ARR-3 の部品
 * `apiArrayElementPathPartsOf`）を、利用者に分かる言い方にする唯一の部品（例: 「資格（1 行目）」「職歴（2 行目）の 名前」。番号は 1 から）。英数字の鍵の
 * 名前と `[ ]`・`.` は出さない（見出しがなければ、カタログの代わりの語）。道でない鍵は null（呼び出し側が今の表示にする）。道の形かだけを見るので、本文の
 * 鍵そのものが `[` を含む形と見分けたいときは、呼び出し側が一覧の位置（`element`）を持つ鍵だけに使う（SREV-ARR2 の M4）。
 */
export const apiKeyPathDisplayText = (key: string, headings: ApiKeyPathHeadings = {}): string | null => {
  const parts = apiArrayElementPathPartsOf(key);
  if (parts === null) {
    return null;
  }
  const text = LOCAL_UI_SCENARIO_TEXT.api;
  const list = headings.list ?? text.arrayListFallback;
  const row = parts.index + 1;
  return parts.name === undefined ? text.arrayRow(list, row) : text.arrayRowInner(list, row, headings.inner ?? text.arrayInnerFallback);
};

/**
 * ARR-5: 欄の名前（書き込みの結果の差の表の行の見出し）の表示。並びの行の欄の鍵（道）は `apiKeyPathDisplayText` の言い方、ほかは名前の
 * まま（`path` が真のとき、行の言い方にした）。限界: 送り方を見ないので、form の欄の名前が道の形（例 `items[0]`）なら、それも行の言い方になる。
 * ARR-5 fix round 1（SREV-ARR2 の M4）: 書き込みの結果の差の表の view は、送り方と一覧の位置（`element`）を持たないので、名前の形で
 * 見分ける今の方法のままにした。
 */
export const fieldNameDisplayOf = (fieldName: string): { readonly text: string; readonly path: boolean } => {
  const pathText = apiKeyPathDisplayText(fieldName);
  return pathText === null ? { text: fieldName, path: false } : { text: pathText, path: true };
};

/** 画面の名前のもとにしない、path の区切り。 */
const SCREEN_WORD_SKIPPED: ReadonlySet<string> = new Set(['new', 'edit']);

/**
 * 画面の名前のもと（`LOCAL_UI_WRITE_SCREENS_TEXT.screenName` に渡す語）: path の区切りのうち、番号に見えず、`new`・`edit` でない最後のもの（なければ空）。
 * OP-3: サイトの画面の一覧と、作ったデータの一覧が、同じ 1 か所で求める（ふだんの画面にアドレスの後ろを出さないため）。
 */
export const writeScreenWordOf = (path: string): string =>
  [...path.split('/')].reverse().find((segment) => segment.length > 0 && !SCREEN_WORD_SKIPPED.has(segment) && !isRecordIdLikePathSegment(segment)) ?? '';

/** WDEDUP: 行の画面（画面の単位）と送信の形（分からない行は null。まとめない）と、チェック済み（承認済み）か。 */
export interface WriteScreenSendShape {
  readonly screen: string;
  readonly sendShape: string | null;
  readonly checked: boolean;
}

/**
 * WDEDUP: 「登録・更新を試せる画面」の一覧で、同じ画面の中の、同じ送信の形の行を 1 行にまとめる（見せ方だけ。記録・承認・書き込みの元は変えない）。代表は、
 * まとめる行にチェック済みの行があれば、その中で一覧の順で最初の行、なければ一覧の順で最初の行（まとめた行の位置は、一覧の順で最初の行の位置）。`count` は
 * まとめた行の数（ひとりの行は 1）、`checkedCount` はそのうちチェック済みの行の数。画面をまたいではまとめない（違う画面の同じ送信は、別の確かめになりうる）。
 */
export const writeScreenSameSendRowsOf = <T>(
  items: readonly T[],
  shapeOf: (item: T) => WriteScreenSendShape,
): readonly { readonly item: T; readonly count: number; readonly checkedCount: number }[] => {
  const groups = new Map<string, { item: T; count: number; checkedCount: number }>();
  const rows: { item: T; count: number; checkedCount: number }[] = [];
  for (const item of items) {
    const { screen, sendShape, checked } = shapeOf(item);
    const key = sendShape === null ? null : JSON.stringify([screen, sendShape]);
    const group = key === null ? undefined : groups.get(key);
    if (group !== undefined) {
      group.count += 1;
      if (checked) {
        if (group.checkedCount === 0) {
          group.item = item;
        }
        group.checkedCount += 1;
      }
      continue;
    }
    const row = { item, count: 1, checkedCount: checked ? 1 : 0 };
    rows.push(row);
    if (key !== null) {
      groups.set(key, row);
    }
  }
  return rows;
};

/**
 * OP-2 の修正の 2 回目（判断 2）: 試せない行の理由の種類（閉じた一覧。文言はカタログ `LOCAL_UI_WRITE_SCREENS_TEXT.notCheckable`。網羅は `catalog-coverage.ts`）。
 * - `SECRET_FIELD`: 秘密に見える欄がある。`DESTRUCTIVE`: 消す・取り消すなどの操作に当たる。`ANSWER_CHECK`: 答え合わせのしかたを決められない。
 * - `SITE_CHANGED`: 操作さがしの後にサイトの設定が変わった（もう一度点検すると試せる）。`UNSUPPORTED`: そのほか（BeakSight が扱えない入力のしかた）。
 * - OP-K（K2）: `SECRET_KEY`: 画面が自動で入れて送る項目に、秘密に見える名前のものがある。`FIELD_SHAPE`: 入れた値と送る中身の結び付きが分からない（1 つの欄の値を
 *   いくつもの項目に入れて送る、欄の値を別の形に変えて送るなど）。
 * - WBF（DEF-291 の B1）: `VALUES_NOT_SENT`: 欄に入れた値が、見た送信のどこにもない（保存の前に別の確かめを送る画面など。本当の保存を見ていない）。
 */
export const WRITE_SCREEN_NOT_CHECKABLE_KINDS = Object.freeze([
  'SECRET_FIELD', 'DESTRUCTIVE', 'ANSWER_CHECK', 'SITE_CHANGED', 'UNSUPPORTED', 'SECRET_KEY', 'FIELD_SHAPE', 'VALUES_NOT_SENT',
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
  // ARR-2: 登録の一覧の鍵の理由（今の「入力のしかたを扱えない」の 1 行）。
  SCENARIO_API_ARRAY_NESTED: 'UNSUPPORTED',
  SCENARIO_API_ARRAY_OVER_LIMIT: 'UNSUPPORTED',
  SCENARIO_API_ARRAY_ELEMENT_TYPE_MISMATCH: 'UNSUPPORTED',
  SCENARIO_API_ARRAY_ELEMENT_COUNT_MISMATCH: 'UNSUPPORTED',
  // ARR-3: 欄の印が 2 つ以上入る一覧（段 A2 まで、今の「入力のしかたを扱えない」の 1 行）。
  SCENARIO_API_ARRAY_MULTIPLE_FIELDS: 'UNSUPPORTED',
  // ARR-5: object の一覧の、行ごとに違う中の鍵と、扱えない中の鍵の名前。
  SCENARIO_API_ARRAY_ROW_KEYS_MISMATCH: 'UNSUPPORTED',
  SCENARIO_API_ARRAY_INNER_KEY_NOT_ALLOWED: 'UNSUPPORTED',
  // ARR-5 fix round 1: 一覧の行の欄の道の重なりと、本文の同じ鍵の 2 回。
  SCENARIO_API_ARRAY_PATH_CONFLICT: 'UNSUPPORTED',
  SCENARIO_API_BODY_KEY_DUPLICATE: 'UNSUPPORTED',
  // WBF（DEF-291 の B1）: 入れた値が送られるところを見届けられない登録の型。
  SCENARIO_API_FIELD_VALUES_NOT_SENT: 'VALUES_NOT_SENT',
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
  /**
   * LU-13: 最後の回が送る前の確かめで送らずに締めた（`PRECHECK_FAILED`）回なら、その具体的な理由（記録の `precheckDetail`。分からなければ null か省略）。
   * 画面には理由の値を出さず、一覧の行から開く更新の理由のときだけ、短い 1 文に変える（`writeScreenListRowUpdateNotSentTextOf`）。
   */
  readonly notSentDetail?: PrecheckFailureDetail | null;
}

/**
 * LU-13（設計書 `2026-11-02-beaksight-list-row-update-design.md` 5.6）: 一覧の行から開く更新で送らずに止めた理由（送らずに止めた理由の閉じた一覧
 * `PRECHECK_FAILURE_DETAILS` のうち、カタログ `LOCAL_UI_WRITE_SCREENS_TEXT.lastResult.listRowUpdateNotSent` に文があるもの。値の写しは持たない。
 * カタログの鍵が閉じた一覧の中にあることは、下の型で確かめる）。
 */
type WriteScreenListRowUpdateDetail = keyof typeof LOCAL_UI_WRITE_SCREENS_TEXT.lastResult.listRowUpdateNotSent;
const LIST_ROW_UPDATE_TEXT_KEYS_ARE_PRECHECK_DETAILS: [WriteScreenListRowUpdateDetail] extends [PrecheckFailureDetail] ? true : never = true;
void LIST_ROW_UPDATE_TEXT_KEYS_ARE_PRECHECK_DETAILS;

const isListRowUpdateDetail = (detail: PrecheckFailureDetail): detail is WriteScreenListRowUpdateDetail =>
  Object.hasOwn(LOCAL_UI_WRITE_SCREENS_TEXT.lastResult.listRowUpdateNotSent, detail);

/**
 * LU-13: 更新の回が、一覧の行から開く更新の理由で送らずに止まったときの短い 1 文（ほかは null。今の「前回は更新を試せませんでした」の 1 行のまま）。
 */
export const writeScreenListRowUpdateNotSentTextOf = (result: WriteScreenKindResultView | null): string | null => {
  const detail = result?.notSentReason == null ? null : result.notSentDetail ?? null;
  return detail !== null && isListRowUpdateDetail(detail) ? LOCAL_UI_WRITE_SCREENS_TEXT.lastResult.listRowUpdateNotSent[detail] : null;
};

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
    : updateReason !== null
      ? writeScreenListRowUpdateNotSentTextOf(result.update) ?? text.updateNotTriedLast(text.notSentReasons[updateReason])
      : null;
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
  /** LU-13 fix round 1（D3）: 同じ表の更新の画面が、名前のない開き手から開くものだけか（省略は偽）。真なら `NOT_DECIDABLE` の文を差し替える。 */
  readonly updateOpenerUnnamedOnly?: boolean;
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
    const updateText = row.updateState === 'NOT_DECIDABLE' && row.updateOpenerUnnamedOnly === true
      ? LOCAL_UI_WRITE_SCREENS_TEXT.updateOpenerUnnamed
      : LOCAL_UI_WRITE_SCREENS_TEXT.update[row.updateState];
    lines.push({ kind: 'UPDATE_STATE', text: updateText, updateState: row.updateState });
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
