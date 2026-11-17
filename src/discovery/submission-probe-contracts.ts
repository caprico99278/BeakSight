// 送らずに観察する probe の契約と純粋な部品（T37c。Task 37 の設計書 3.2 の「対象」「入力」、3.4、5 章）。純粋な関数だけのファイル（ページを操作しない。
// Gate (w)。Playwright、ブラウザ、`src/safety/`、`src/control/` を import しない。`tests/architecture/discovery-boundary.test.ts` の (x)）。押す部品は
// `src/interaction/submission-probe.ts`（ページを操作してよいファイルの閉じた一覧 (q) の 1 つ）で、この契約を使う。
// - 対象（`isSubmissionProbeTarget`）: 分類が `NEEDS_BINDING`（JS の結び付き）で、送信ボタンの語に削除の語（`DISCOVERY_DESTRUCTIVE_WORDS`）がなく、画面と送信先が
//   許可 Origin の中（`isInsideAllowedOrigins`。分類と同じ判定）で、画面がログインの画面でない（呼び出し側が認証の設定のログインの path で決めて渡す。発見の
//   流れは監査の段の除外の画面も渡す）候補。
// - 押す順（`submissionProbePressOrderOf`）: DEF-142 で、登録・更新の語（`SUBMISSION_PROBE_PRIORITY_WORDS`）のあるもの、文字のあるそのほか、文字の
//   ないもの、の順（同じ段の中は文書の順。要素の位置 `compareElementPaths`）。T44c: 送信の語（「送信」「確定」「submit」。probe だけが読む印 `hasSubmitWord`）の
//   あるものを、登録・更新の語の次の段に置く。DEF-208-2: 登録・更新の語の段を、確定の語（`SUBMISSION_PROBE_CONFIRM_WORDS`）と、行を足す語・開き手の語に分け、
//   確定の語、送信の語、行を足す語・開き手の語の順にする。COV-1: 押す数の上限はない（押す部品が、状態の鍵で終える）。
// - 欄（`submissionProbeFieldActionOf`）: text 系の `input`（`SUBMISSION_PROBE_FILL_FIELD_TYPES`）と `textarea` に目印を入れ、`select` は空でない最初の選択肢を
//   選ぶ。`password`・`file`・`hidden`・`checkbox`・`radio` とほかの型は触らない（触らなかった欄の数を記録する）。
// - 目印（`submissionProbeMarkerOf`）: 欄ごとに違う乱数（`node:crypto`）。型に合わせる（email は `@example.invalid`、url は `https://example.invalid/`、number と
//   tel は数字だけ、date は固定の月日で欄ごとに年を 1 つずつ進める）。ほかの目印を含まず、ほかの目印に含まれない（型の作り手が目印の番号を正しく対応させるため）。
//   L13: 1 回の押下の目印の数に上限はない（前は `MAX_API_SHAPE_MARKERS` まで）。目印は秘密でないが、記録・成果物・管理データ・IPC・画面には出さない（I22）。値そのものは記録しない。
// - 結果（`SubmissionProbeRecord`。候補の任意の項目 `submissionProbe`）: 観察の結果を T37b の分類（`classifyApiShapeObservation`）で写した結果・理由・型・型の
//   digest と、数（読み取りでない要求、止めた読み取り、型を受けなかった要求、入れた欄、触らなかった欄）。観察しなかったときは `NOT_OBSERVED` と理由
//   （`SUBMISSION_PROBE_NOT_OBSERVED_REASONS`）。候補の識別の digest と規則の digest は変えない（`withSubmissionProbes`）。
import { randomBytes } from 'node:crypto';
import { createSha256Fingerprint } from '../core/ids.js';
import { PRODUCTION_OBSERVATION_WINDOWS } from '../core/observation-windows.js';
import {
  API_FILTER_OPERATORS,
  apiArrayElementPathOf,
  type ApiJsonValueType,
  type ApiRequestShape,
} from '../core/api-request-shape.js';
import { API_SHAPE_NOT_EXECUTABLE_REASONS, classifyApiShapeObservation, type ApiShapeNotExecutableReason } from './api-shape-classification.js';
import {
  SELECT_FIELD_TYPES,
  type CandidateFieldType,
  type CandidateLocation,
  type DiscoveryCandidate,
} from './candidate-contracts.js';
import {
  DISCOVERY_CREATE_WORDS,
  DISCOVERY_DESTRUCTIVE_WORDS,
  DISCOVERY_OPENER_WORDS,
  DISCOVERY_ROW_ADD_WORDS,
  DISCOVERY_UPDATE_WORDS,
} from './classification-words.js';
import { isInsideAllowedOrigins } from './classify.js';
import type { DiscoveryOptionChoiceRecord, DiscoveryReadPageRecord } from './discovery-result.js';
import { stateStructureKeyOf, type StateStructureField } from './state-keys.js';
import { pageTemplatePathOf } from './fingerprint.js';
import { compareCodeUnits } from '../core/text.js';

// ---------------------------------------------------------------------------------------------------------------
// 名前つきの定数と閉じた一覧
// ---------------------------------------------------------------------------------------------------------------

// COV-1（網羅の設計書 `2026-11-09-beaksight-coverage-by-state-design.md` 3.3）: 1 画面で押す回数の上限（前は 3）は撤廃した（押す部品は状態の鍵で終える。
// 定数は LZ-1 で消した）。
/** 押した後、ページの要求が静まるまで待つ時間（ms。設計書 3.2 の既定。RB-2: 観察の窓の一式の `afterPress.probeQuietWaitMs`）。 */
export const SUBMISSION_PROBE_QUIET_WAIT_MS = PRODUCTION_OBSERVATION_WINDOWS.afterPress.probeQuietWaitMs;

/** probe の結果（T37b の分類の 4 つと、観察しなかった `NOT_OBSERVED`）。 */
export const SUBMISSION_PROBE_RESULTS = Object.freeze(['API_CREATE', 'API_UPDATE', 'NOT_EXECUTABLE', 'NO_REQUEST', 'NOT_OBSERVED'] as const);
export type SubmissionProbeResult = (typeof SUBMISSION_PROBE_RESULTS)[number];

/**
 * 書き込みの probe の結果ごとの、シナリオの種類と method（T38R-fix の M-2。下書きの確かめ・索引の型の digest・画面の案が使う唯一の対応）。
 * `API_CREATE` は登録（`POST`）、`API_UPDATE` は更新（`PATCH`）。ほかの結果は書き込みの probe でない。
 */
export const SUBMISSION_PROBE_WRITE_RESULTS = Object.freeze({
  API_CREATE: Object.freeze({ kind: 'CREATE', method: 'POST' } as const),
  API_UPDATE: Object.freeze({ kind: 'UPDATE', method: 'PATCH' } as const),
} as const);
export type SubmissionProbeWrite = (typeof SUBMISSION_PROBE_WRITE_RESULTS)[keyof typeof SUBMISSION_PROBE_WRITE_RESULTS];

/** 書き込みの probe の結果なら、その種類と method（ほかの結果は null）。 */
export const submissionProbeWriteOf = (result: SubmissionProbeResult): SubmissionProbeWrite | null =>
  (result === 'API_CREATE' || result === 'API_UPDATE' ? SUBMISSION_PROBE_WRITE_RESULTS[result] : null);

/**
 * 観察しなかった理由（閉じた一覧）。
 * - `PAGE_CHANGED`: 押した後に main frame の URL が変わった（その押下と、その画面の残りの対象）。
 * - `PRESS_LIMIT_REACHED`: 1 画面の押す回数の上限を超えた対象（COV-1 の前の成果物だけ。今の押す部品は書かない）。
 * - `TARGET_NOT_FOUND`: 押す前の読み直しで、同じ識別の候補か、押せる要素（送信ボタン）が見つからなかった。
 * - `PRESS_FAILED`: 欄に入れるか押す操作が失敗した、か凍結の段でなかった（押していないか、押したかが分からない）。
 * - `CONTEXT_CLOSED_BY_GUARD`: DEF-144（設計書 `2026-10-20-beaksight-probe-external-scheme-design.md` 2.3）: Guard が Context を閉じ始めた（安全の違反の
 *   後の無効化）。その押下と、その画面の残りの対象（`PAGE_CHANGED` と分けて記録する）。
 * - `SAME_IDENTITY_PRESSED`: LU-4（設計書 `2026-11-02-beaksight-list-row-update-design.md` 4.0 の D7、5.1 の 1）: 同じ識別の digest の候補（一覧の行ごとの
 *   「編集」など）のうち、文書の順で最初の 1 つだけを押す対象に残したので、押さなかった（押す回数を使わない）。
 * - `SAME_WORDS_NO_REQUEST`: DEF-208-2（設計書 `2026-11-05-beaksight-discovery-coverage-design.md` 3.3）: 同じ画面で、同じ送信ボタンの語の組
 *   （`submissionProbeWordsKeyOf`）の対象を押して何も送らなかった（`NO_REQUEST`）ので、同じ語の組の 2 つ目からは押さなかった（押す回数を使わない。語のない
 *   対象には当てない）。
 * - `DISABLED_SUBMITTER`: DEF-208-2（設計書 3.4）: 欄に入れた後に読んだ送信ボタンが押せない（disabled か `aria-disabled="true"`。Playwright の
 *   押せるかの判定）ので、押さなかった（押す回数を使わない。押せるようになるのを待たない）。
 * - `DISABLED_FILL_LIMIT_REACHED`: SREV-1105-3 の再レビューの Minor-A: 欄に入れたのに押せなかった回が 1 画面の上限に達した後に、入れる前は押せたボタンに欄を
 *   入れたら、押せなくなった（押していない）。COV-1 で上限を外したので、今の押す部品は書かない（前の成果物だけ）。
 * - `SHARED_LAYOUT_PRESSED`: DEF-208-4（設計書 3.7 の A）: 共通の枠のボタン（`sharedLayoutIdentityDigestOf`）で、同じ識別のボタンを前の画面で押したので、
 *   押さなかった（押す回数を使わない）。
 * - `SAME_STATE_PRESSED`: COV-2（網羅の設計書 `2026-11-09-beaksight-coverage-by-state-design.md` 3.3）: 同じ構造の鍵の状態（番号だけ違う同じ作りの画面
 *   など）で、同じ候補（型にした識別と構造の中の位置の手がかり、同じ中の順番）を、操作さがしの中で前に押したので、押さなかった。
 */
export const SUBMISSION_PROBE_NOT_OBSERVED_REASONS = Object.freeze([
  'PAGE_CHANGED',
  'PRESS_LIMIT_REACHED',
  'TARGET_NOT_FOUND',
  'PRESS_FAILED',
  'CONTEXT_CLOSED_BY_GUARD',
  'SAME_IDENTITY_PRESSED',
  'SAME_WORDS_NO_REQUEST',
  'DISABLED_SUBMITTER',
  'SHARED_LAYOUT_PRESSED',
  'DISABLED_FILL_LIMIT_REACHED',
  'SAME_STATE_PRESSED',
  // L6/L3-1（設計書 `2026-11-09-beaksight-remove-limits-design.md` 5 の 1）: 1 画面の進みの見張り（L0）が画面を終えたので、押しにかかった対象と残りの対象を
  // 押せなかった（全く反応がない・静まらない。理由の名前は L0 の理由と同じ）。
  'STAGE_UNRESPONSIVE',
  'STAGE_NEVER_QUIET',
  // L6/L3-1 の続き（設計者の判断 A の案 A1）: 押す前に、送信ボタンの中心の位置の最前面の要素が、送信ボタンかその子孫でなかった（モーダルの窓の後ろ・ほかの
  // 表示に覆われている・操作を受け付けない）ので、押さなかった（押す回数を使わない。`submitterHitJudgementOf`）。
  'COVERED_BY_OTHER',
  // SD-1（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.3）: 押す前の判定（`isDestructiveAction`）で削除に関する操作だったので、押さなかった。
  'DESTRUCTIVE_ACTION_SKIPPED',
] as const);
export type SubmissionProbeNotObservedReason = (typeof SUBMISSION_PROBE_NOT_OBSERVED_REASONS)[number];
/** L6/L3-1 の続き（A1）: ほかの表示に覆われていたので押さなかった理由。 */
export const COVERED_BY_OTHER_PROBE_REASON = 'COVERED_BY_OTHER' satisfies SubmissionProbeNotObservedReason;

/** L6/L3-1 の続き（A1）: 送信ボタンの中心の位置の最前面の要素と、送信ボタンとの関係（`TARGET`・`DESCENDANT`・`OTHER`。最前面の要素がなければ `NONE`）。 */
export type SubmitterHitTopRelation = 'TARGET' | 'DESCENDANT' | 'OTHER' | 'NONE';

/**
 * L6/L3-1 の続き（A1）: hit-test の四隅の点を、矩形の内側へ寄せる量の上限（px）。寄せる量は、この値と各辺の 4 分の 1 の小さい方。監査の側（AUD-3b）の
 * `LAYOUT_THRESHOLDS.hitTestPointInsetPx`（`src/evidence/layout-collector.ts`）と同じ値（純粋な部品から `src/evidence/` は読めないので、値が同じことを単体テストで
 * 確かめる。共通化の候補）。
 */
export const SUBMISSION_PROBE_HIT_POINT_INSET_PX = 4;

/** L6/L3-1 の続き（A1）: 矩形（viewport の座標。px）と、表示の範囲の大きさ。 */
export interface SubmitterHitRectangle {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** L6/L3-1 の続き（A1）: hit-test の点（viewport の座標）。 */
export type SubmitterHitPoint = readonly [number, number];

/**
 * L6/L3-1 の続き（設計者の判断 A の案 A1。点の決め方はここだけ）: 押す前の hit-test の点（純粋）。送信ボタンの矩形の中心が表示の範囲の外なら、点なし（押す 1 手が
 * スクロールしてから押すので、ここでは決めない）。中にあれば、監査の側（AUD-3b）と同じく、表示の範囲の中の部分の中心と、内側に寄せた四隅の 5 点（中心が先）。
 */
export const submitterHitPointsOf = (
  rect: SubmitterHitRectangle,
  viewport: { readonly width: number; readonly height: number },
): readonly SubmitterHitPoint[] => {
  const centreX = (rect.left + rect.right) / 2;
  const centreY = (rect.top + rect.bottom) / 2;
  if (!(rect.right > rect.left && rect.bottom > rect.top && centreX >= 0 && centreY >= 0 && centreX < viewport.width && centreY < viewport.height)) {
    return [];
  }
  const left = Math.max(rect.left, 0);
  const top = Math.max(rect.top, 0);
  const right = Math.min(rect.right, viewport.width);
  const bottom = Math.min(rect.bottom, viewport.height);
  const insetX = Math.min(SUBMISSION_PROBE_HIT_POINT_INSET_PX, (right - left) / 4);
  const insetY = Math.min(SUBMISSION_PROBE_HIT_POINT_INSET_PX, (bottom - top) / 4);
  return [
    [(left + right) / 2, (top + bottom) / 2],
    [left + insetX, top + insetY],
    [right - insetX, top + insetY],
    [left + insetX, bottom - insetY],
    [right - insetX, bottom - insetY],
  ];
};

/** L6/L3-1 の続き（A1）: 点ごとの、最前面の要素と送信ボタンとの関係（点の座標と組にする）。 */
export type SubmitterHitPointFact = readonly [number, number, SubmitterHitTopRelation];

/** L6/L3-1 の続き（A1）: 押す前の hit-test の判定。届く点があれば、その点（viewport の座標）。 */
export type SubmitterHitJudgement =
  | { readonly kind: 'REACHABLE'; readonly point: SubmitterHitPoint }
  | { readonly kind: 'COVERED' }
  | { readonly kind: 'UNKNOWN' };

/**
 * L6/L3-1 の続き（設計者の判断 A の案 A1。判定はここだけ）: 押す前の hit-test の判定（純粋）。監査の側の hit-test（`src/audit/fixed-overlap-classes.ts` の
 * `hitTestJudgementOf`）と同じ考え方で、最前面が送信ボタンかその子孫になる点は押下が届く。点の順（中心が先）で最初に届く点を押す（`REACHABLE`）。どの点も
 * 届かなければ覆われている（`COVERED`。押さない）。点がない（中心が表示の範囲の外）なら決めない（`UNKNOWN`。押す 1 手に任せる）。
 */
export const submitterHitJudgementOf = (points: readonly SubmitterHitPointFact[]): SubmitterHitJudgement => {
  if (points.length === 0) return { kind: 'UNKNOWN' };
  const reachable = points.find(([, , relation]) => relation === 'TARGET' || relation === 'DESCENDANT');
  return reachable === undefined ? { kind: 'COVERED' } : { kind: 'REACHABLE', point: [reachable[0], reachable[1]] };
};
/** T44c: 押す数の上限で押さなかった理由（成果物の数 `pressLimitProbesOf` が数える理由）。 */
export const PRESS_LIMIT_PROBE_REASON = 'PRESS_LIMIT_REACHED' satisfies SubmissionProbeNotObservedReason;
/** DEF-144: Guard が Context を閉じたので押せなかった理由（発見の流れが、読み込み直して押す残りの候補を選ぶ）。 */
export const CONTEXT_CLOSED_BY_GUARD_PROBE_REASON = 'CONTEXT_CLOSED_BY_GUARD' satisfies SubmissionProbeNotObservedReason;
/** LU-4（D7）: 同じ識別の候補を 1 つだけ押す対象に残したので、押さなかった理由。 */
export const SAME_IDENTITY_PRESSED_PROBE_REASON = 'SAME_IDENTITY_PRESSED' satisfies SubmissionProbeNotObservedReason;
/** DEF-208-2（C）: 同じ語の組の対象が何も送らなかったので、押さなかった理由。 */
export const SAME_WORDS_NO_REQUEST_PROBE_REASON = 'SAME_WORDS_NO_REQUEST' satisfies SubmissionProbeNotObservedReason;
/** DEF-208-2（D）: 送信ボタンが押せないので、押さなかった理由。 */
export const DISABLED_SUBMITTER_PROBE_REASON = 'DISABLED_SUBMITTER' satisfies SubmissionProbeNotObservedReason;
/** SD-1: 押す前の判定で、削除に関する操作だったので押さなかった理由。 */
export const DESTRUCTIVE_ACTION_SKIPPED_PROBE_REASON = 'DESTRUCTIVE_ACTION_SKIPPED' satisfies SubmissionProbeNotObservedReason;
/** DEF-208-4（A）: 共通の枠のボタンを前の画面で押したので、押さなかった理由。 */
export const SHARED_LAYOUT_PRESSED_PROBE_REASON = 'SHARED_LAYOUT_PRESSED' satisfies SubmissionProbeNotObservedReason;
/** COV-2: 同じ構造の鍵の状態で同じ候補を前に押したので、押さなかった理由。 */
export const SAME_STATE_PRESSED_PROBE_REASON = 'SAME_STATE_PRESSED' satisfies SubmissionProbeNotObservedReason;

/**
 * DEF-144: 押さない理由（probe だけの、実行できない理由）。`EXTERNAL_SCHEME`: 送信ボタンか祖先の `<a>`・`<area>` の `href`、または form の `action`・
 * `formaction` が http(s) でないスキーム（`mailto:`・`tel:`・独自のスキームなど）を指す（押す前に見分けた）か、押下で外部スキームへ移ろうとした（Guard が
 * 止めて違反を記録した）。押す回数は使わない。
 */
export const SUBMISSION_PROBE_ONLY_NOT_EXECUTABLE_REASONS = Object.freeze(['EXTERNAL_SCHEME', 'OPENER_SIDE_REQUEST'] as const);
export type SubmissionProbeOnlyNotExecutableReason = (typeof SUBMISSION_PROBE_ONLY_NOT_EXECUTABLE_REASONS)[number];
/** DEF-144: 外部スキームで押さなかった理由（成果物の数 `externalSchemeProbesOf` が数える理由）。 */
export const EXTERNAL_SCHEME_PROBE_REASON = 'EXTERNAL_SCHEME' satisfies SubmissionProbeOnlyNotExecutableReason;
/**
 * DEF-186（設計書 `2026-11-02-beaksight-list-row-update-design.md` 5.1 の 4）: 開き手の側の要求。開き手の語（`DISCOVERY_OPENER_WORDS`）だけを持ち登録の語の
 * ない候補の押下が、登録の形（`API_CREATE`）を出した（開くとサイトが自動で下書きなどを送る作り）。登録にしない（型は残す）。押した後に開いた窓の中の保存は、
 * 何も送らなかった押下と同じく読み直して押す（`src/interaction/submission-probe.ts`）。
 */
export const OPENER_SIDE_REQUEST_PROBE_REASON = 'OPENER_SIDE_REQUEST' satisfies SubmissionProbeOnlyNotExecutableReason;

/**
 * LU-4（fix round 1）: 押さなかった（押す回数を使っていない）ことを表す理由（閉じた一覧。押す前に見つからない・見えない、押す数の上限、外部スキーム、Guard が
 * Context を閉じた、同じ識別を先に押した）。`PAGE_CHANGED`・`PRESS_FAILED` は押した（か押したかが分からない）ので入れない。成果物から押した数を数える
 * 部品は、この一覧を使う。
 */
export const SUBMISSION_PROBE_NOT_PRESSED_REASONS = Object.freeze([
  'TARGET_NOT_FOUND',
  PRESS_LIMIT_PROBE_REASON,
  EXTERNAL_SCHEME_PROBE_REASON,
  CONTEXT_CLOSED_BY_GUARD_PROBE_REASON,
  SAME_IDENTITY_PRESSED_PROBE_REASON,
  SAME_WORDS_NO_REQUEST_PROBE_REASON,
  DISABLED_SUBMITTER_PROBE_REASON,
  SHARED_LAYOUT_PRESSED_PROBE_REASON,
  SAME_STATE_PRESSED_PROBE_REASON,
  // L6/L3-1 の続き（A1）: 覆われていたので押さなかった。
  COVERED_BY_OTHER_PROBE_REASON,
  // SD-1: 削除に関する操作なので押さなかった。
  DESTRUCTIVE_ACTION_SKIPPED_PROBE_REASON,
] as const satisfies readonly (SubmissionProbeNotObservedReason | SubmissionProbeOnlyNotExecutableReason)[]);

/** 実行できない理由（T37b の分類の理由と、probe だけの理由）。 */
export const SUBMISSION_PROBE_NOT_EXECUTABLE_REASONS = Object.freeze([
  ...API_SHAPE_NOT_EXECUTABLE_REASONS,
  ...SUBMISSION_PROBE_ONLY_NOT_EXECUTABLE_REASONS,
] as const);

/** probe の理由（実行できない理由と、観察しなかった理由）。 */
export const SUBMISSION_PROBE_REASONS = Object.freeze([...SUBMISSION_PROBE_NOT_EXECUTABLE_REASONS, ...SUBMISSION_PROBE_NOT_OBSERVED_REASONS] as const);
export type SubmissionProbeReason = ApiShapeNotExecutableReason | SubmissionProbeOnlyNotExecutableReason | SubmissionProbeNotObservedReason;

// DEF-144 の読み込み直しの回数の上限の定数（前は 1 画面 1 回）は、どこからも使われなくなったので LZ-1 で消した。

/** 型の filter の演算子の表記（読む演算子と `OTHER`。成果物のスキーマの enum）。 */
export const SUBMISSION_PROBE_FILTER_OPERATORS = Object.freeze([...API_FILTER_OPERATORS, 'OTHER'] as const);

/** 目印を入れる欄の型（text 系の `input` と `textarea`）。 */
export const SUBMISSION_PROBE_FILL_FIELD_TYPES = Object.freeze([
  'text',
  'search',
  'email',
  'url',
  'tel',
  'number',
  'date',
  'textarea',
] as const satisfies readonly CandidateFieldType[]);

/** 欄への操作（目印を入れる、選ぶ、触らない）。 */
export type SubmissionProbeFieldAction = 'FILL' | 'SELECT' | 'SKIP';

// ---------------------------------------------------------------------------------------------------------------
// 結果の形
// ---------------------------------------------------------------------------------------------------------------

/** 観察の数（値を持たない）。 */
export interface SubmissionProbeObservationCounts {
  readonly nonReadRequestCount: number;
  readonly readRequestCount: number;
  readonly unrecordedShapeCount: number;
}

/** 欄の数（目印を入れたか選んだ欄と、触らなかった欄）。 */
export interface SubmissionProbeFieldCounts {
  readonly filledFieldCount: number;
  readonly skippedFieldCount: number;
}

// LZ-2: 欄の CSS の長さの上限（前は `MAX_SUBMISSION_PROBE_FIELD_SELECTOR_LENGTH` 512。超える CSS は記録しなかった）は撤廃した。

/**
 * T38a（Task 38 の設計書 3.1）: probe が押す前に入れた欄（目印を入れた欄と、選択肢を選んだ欄）の識別。値は持たない。
 * - `name`: 欄の `name` の属性（ないか空なら null）。
 * - `selector`: その画面でちょうど 1 つの欄に当たる CSS（T43c の組み立て `entrySelectorCandidatesOf`。Playwright が解釈できる形
 *   `isPlaywrightCssShape`。作れなければ null）。
 * - `type`: 欄の種類（候補の欄の型）。
 * - `marker`: その押下の目印の番号（型の `markerKeys` の番号。押下ごとに 0 から振る）。選択肢を選んだ欄は null。
 */
export interface SubmissionProbeInputField {
  readonly name: string | null;
  readonly selector: string | null;
  readonly type: CandidateFieldType;
  readonly marker: number | null;
}

/** 候補の任意の項目 `submissionProbe`（`schemas/control/candidate.schema.json` の `$defs/submissionProbe`）。値を持たない。 */
export interface SubmissionProbeRecord extends SubmissionProbeObservationCounts, SubmissionProbeFieldCounts {
  readonly result: SubmissionProbeResult;
  /** `NOT_EXECUTABLE` は実行できない理由、`NOT_OBSERVED` は観察しなかった理由、ほかは null。 */
  readonly reason: SubmissionProbeReason | null;
  /** 分類が見た型（T37b の型。値なし）。`API_CREATE`・`API_UPDATE` は必ずある。`NO_REQUEST`・`NOT_OBSERVED` は null。 */
  readonly shape: ApiRequestShape | null;
  /** 型の digest（`apiShapeDigestOf`。型があるときだけ）。 */
  readonly shapeDigest: string | null;
  /**
   * T38a: 押す前に入れた欄（候補の欄の範囲。`BUTTON` の候補では form の外の欄。入れた順）。T38a の後の probe は必ず持つ（押さなかった対象は空）。
   * T38a の前の成果物の probe は持たない（目印の番号が押下ごとに振り直されていないので、型で行を引く口は使わない）。
   */
  readonly inputFields?: readonly SubmissionProbeInputField[];
  /**
   * LU-4（設計書 `2026-11-02-beaksight-list-row-update-design.md` 5.1 の 2）: 開き手（一覧の行の「編集」など）を押した後の読み直しで押した対象の、開き手の
   * 事実（`submissionProbeOpenerOf`。値は持たない）。読み直しで押していない記録と、LU-4 の前の成果物は持たない。
   */
  readonly opener?: SubmissionProbeOpener;
  /**
   * COV-1（DEF-238 の設計書 3.1 の 2）: 押して画面が変わった後の段（2 段目から）で押した・見た記録の、段の番号と、この押下の前に同じ画面で押した押下の並び
   * （段の番号・候補の識別の digest・同じ digest の中の順番。値は持たない）。1 段目の記録と、COV-1 の前の成果物は持たない。
   */
  readonly stage?: SubmissionProbeStage;
  /**
   * COV-2c（SREV-COV の I-1）: この押下は、画面にもうある作りの部品を足しただけ（新しい作りの印 `scrollStructureSignaturesOf` が出ない）だったので、押した後の画面を
   * 新しい状態とみなさず、押下の鎖をここで閉じた（`NO_NEW_STRUCTURE`）。値は持たない。ほかの記録と、COV-2c の前の成果物は持たない。
   */
  readonly chainEnd?: SubmissionProbeChainEnd;
}

/** COV-2c: 押下の鎖を閉じた理由の閉じた一覧（同じ作りの部品が増えただけ）。 */
export const SUBMISSION_PROBE_CHAIN_ENDS = Object.freeze(['NO_NEW_STRUCTURE'] as const);
export type SubmissionProbeChainEnd = (typeof SUBMISSION_PROBE_CHAIN_ENDS)[number];

/** COV-2c: 押下の鎖を閉じた印を付けた写し（純粋）。 */
export const withSubmissionProbeChainEnd = (record: SubmissionProbeRecord, chainEnd: SubmissionProbeChainEnd): SubmissionProbeRecord =>
  Object.freeze({ ...record, chainEnd });

/** COV-1: 押下 1 回（どの段で、どの候補を押したか。値は持たない）。 */
export interface SubmissionProbePressStep {
  readonly stage: number;
  readonly identityDigest: string;
  readonly ordinal: number;
}

/** COV-1: 段の記録。 */
export interface SubmissionProbeStage {
  /** 段の番号（1 から。画面の状態（構造の鍵）が初めて出た順）。記録に書くのは 2 から。 */
  readonly number: number;
  /** この押下の前に、同じ画面で押した押下の並び（押した順）。 */
  readonly priorPresses: readonly SubmissionProbePressStep[];
}

/**
 * COV-1: probe の記録の強さ（段をまたいで同じ候補を押したとき、強い記録を残す。純粋）。書き込みの形（`NO_REQUEST` でない観察）が 4、何も送らなかった観察が
 * 3、押したが観察しなかった（押す操作の失敗など）が 2、押していない理由（見つからない、画面が変わった、同じ識別・同じ語・共通の枠で飛ばした、押せない
 * ボタン、前の上限）が 1。
 */
export const submissionProbeStrengthOf = (record: SubmissionProbeRecord): number => {
  if (record.result !== 'NOT_OBSERVED') {
    return record.result === 'NO_REQUEST' ? 3 : 4;
  }
  return record.reason !== null && NOT_PRESSED_REASONS.has(record.reason) ? 1 : 2;
};

/** COV-1: 押していないことを表す、観察しなかった理由。 */
const NOT_PRESSED_REASONS: ReadonlySet<SubmissionProbeReason> = new Set<SubmissionProbeReason>([
  'PAGE_CHANGED', 'PRESS_LIMIT_REACHED', 'TARGET_NOT_FOUND', 'SAME_IDENTITY_PRESSED', 'SAME_WORDS_NO_REQUEST', 'DISABLED_SUBMITTER',
  'SHARED_LAYOUT_PRESSED', 'DISABLED_FILL_LIMIT_REACHED', 'SAME_STATE_PRESSED',
]);

/** COV-1: 段の記録を付けた写し（1 段目は付けない）。 */
export const withSubmissionProbeStage = (record: SubmissionProbeRecord, stage: SubmissionProbeStage): SubmissionProbeRecord =>
  (stage.number <= 1 ? record : Object.freeze({
    ...record,
    stage: Object.freeze({ number: stage.number, priorPresses: Object.freeze(stage.priorPresses.map((step) => Object.freeze({ ...step }))) }),
  }));

/**
 * LU-4: 開き手の事実（値・行の中身は持たない）。
 * - `identityDigest`: 開き手の候補の識別の digest。
 * - `hasName`: 開き手に名前（見える文字・`aria-label`・`title`）があるか（probe の読み直しの `hasSubmitterText`）。
 * - `openerWords`: 開き手の送信ボタンの語のうち、開き手の語（`DISCOVERY_OPENER_WORDS`）。
 */
export interface SubmissionProbeOpener {
  readonly identityDigest: string;
  readonly hasName: boolean;
  readonly openerWords: readonly (typeof DISCOVERY_OPENER_WORDS)[number][];
}

/** 観察の結果（観察の口の結果のうち、分類と数に使うもの。`src/safety/submission-observation.ts` の `SubmissionObservationResult` と同じ形）。 */
export interface SubmissionProbeObservation extends SubmissionProbeObservationCounts {
  readonly shapes: readonly ApiRequestShape[];
}

const NO_FIELDS: SubmissionProbeFieldCounts = Object.freeze({ filledFieldCount: 0, skippedFieldCount: 0 });

const OPENER_WORDS: ReadonlySet<string> = new Set(DISCOVERY_OPENER_WORDS);
const CREATE_WORDS: ReadonlySet<string> = new Set(DISCOVERY_CREATE_WORDS);

/**
 * DEF-186（設計書 `2026-11-02-beaksight-list-row-update-design.md` 4.0.1 の K2）: 送信ボタンの語が、開き手の語（`DISCOVERY_OPENER_WORDS`）を持ち、登録の語
 * （`DISCOVERY_CREATE_WORDS`）と削除の語（`DISCOVERY_DESTRUCTIVE_WORDS`）を持たないか。
 */
export const isOpenerOnlySubmitter = (submitterWords: readonly string[]): boolean =>
  submitterWords.some((word) => OPENER_WORDS.has(word))
  && !submitterWords.some((word) => CREATE_WORDS.has(word) || DESTRUCTIVE_WORDS.has(word));

/** LU-4: 開き手の事実を作る（純粋。送信ボタンの語のうち、開き手の語だけを残す）。 */
export const submissionProbeOpenerOf = (identityDigest: string, hasName: boolean, submitterWords: readonly string[]): SubmissionProbeOpener =>
  Object.freeze({
    identityDigest,
    hasName,
    openerWords: Object.freeze(DISCOVERY_OPENER_WORDS.filter((word) => submitterWords.includes(word))),
  });

/** LU-4: 開き手の事実の凍結した写し（項目を選んで写す。ないときは項目ごと省く）。 */
const openerEntryOf = (opener: SubmissionProbeOpener | undefined): { readonly opener?: SubmissionProbeOpener } =>
  (opener === undefined ? {} : { opener: submissionProbeOpenerOf(opener.identityDigest, opener.hasName, opener.openerWords) });

/**
 * 観察した押下の結果（T37b の分類に写す。入力を変えない）。DEF-186: `submitterWords` は押した候補の送信ボタンの語（probe の記録を作るのはこの 1 か所。
 * 後ろの部品はみな、この結果を使う）。開き手の語だけの候補（`isOpenerOnlySubmitter`）の押下が `API_CREATE` なら、`NOT_EXECUTABLE`・
 * `OPENER_SIDE_REQUEST`（型と型の digest は残す）。LU-4（設計書 5.1 の 2、5.2 の 3）: 開き手を押した後に押した対象は `opener` を写し、分類に
 * `openedFromRow` を渡す（行から開いた窓の保存。filter の値が番号の形の PATCH を更新にする）。
 */
export const observedSubmissionProbeOf = (
  observation: SubmissionProbeObservation,
  fields: SubmissionProbeFieldCounts,
  inputFields: readonly SubmissionProbeInputField[] = [],
  submitterWords: readonly string[] = [],
  opener?: SubmissionProbeOpener,
): SubmissionProbeRecord => {
  const classified = classifyApiShapeObservation({
    shapes: observation.shapes,
    nonReadRequestCount: observation.nonReadRequestCount,
    openedFromRow: opener !== undefined,
  });
  const openerSide = classified.classification === 'API_CREATE' && isOpenerOnlySubmitter(submitterWords);
  return Object.freeze({
    result: openerSide ? 'NOT_EXECUTABLE' : classified.classification,
    reason: openerSide ? OPENER_SIDE_REQUEST_PROBE_REASON : classified.reason,
    shape: classified.shape,
    shapeDigest: classified.shapeDigest,
    nonReadRequestCount: observation.nonReadRequestCount,
    readRequestCount: observation.readRequestCount,
    unrecordedShapeCount: observation.unrecordedShapeCount,
    filledFieldCount: fields.filledFieldCount,
    skippedFieldCount: fields.skippedFieldCount,
    inputFields: frozenInputFieldsOf(inputFields),
    ...openerEntryOf(opener),
  });
};

/** 欄の識別の凍結した写し（項目を選んで写す）。 */
const frozenInputFieldsOf = (inputFields: readonly SubmissionProbeInputField[]): readonly SubmissionProbeInputField[] =>
  Object.freeze(inputFields.map(({ name, selector, type, marker }) => Object.freeze({ name, selector, type, marker })));

/** 観察しなかった対象の結果（型なし、要求の数は 0。T38a: 押す前に入れた欄があれば、その識別。LU-4: 開き手の後に押しにかかった対象は `opener`）。 */
export const notObservedSubmissionProbeOf = (
  reason: SubmissionProbeNotObservedReason,
  fields: SubmissionProbeFieldCounts = NO_FIELDS,
  inputFields: readonly SubmissionProbeInputField[] = [],
  opener?: SubmissionProbeOpener,
): SubmissionProbeRecord => Object.freeze({
  result: 'NOT_OBSERVED',
  reason,
  shape: null,
  shapeDigest: null,
  nonReadRequestCount: 0,
  readRequestCount: 0,
  unrecordedShapeCount: 0,
  filledFieldCount: fields.filledFieldCount,
  skippedFieldCount: fields.skippedFieldCount,
  inputFields: frozenInputFieldsOf(inputFields),
  ...openerEntryOf(opener),
});

/** DEF-144: 外部スキームを指す（か、押下で外部スキームへ移ろうとした）ので押さなかった対象の結果（型なし、数は 0。押していない）。 */
export const externalSchemeSubmissionProbeOf = (opener?: SubmissionProbeOpener): SubmissionProbeRecord => Object.freeze({
  result: 'NOT_EXECUTABLE',
  reason: EXTERNAL_SCHEME_PROBE_REASON,
  shape: null,
  shapeDigest: null,
  nonReadRequestCount: 0,
  readRequestCount: 0,
  unrecordedShapeCount: 0,
  filledFieldCount: 0,
  skippedFieldCount: 0,
  inputFields: Object.freeze([]),
  // LU-4: 開き手の後に押しにかかった対象は、開き手の事実を写す。
  ...openerEntryOf(opener),
});

/** T38a: 本文の鍵と、その鍵に入った目印の欄（`submissionProbeKeyFieldsOf` の 1 件）。 */
export interface SubmissionProbeKeyField {
  readonly key: string;
  /** 鍵の値の JSON の型。 */
  readonly type: ApiJsonValueType;
  /** 鍵の値に、ちょうど 1 つの欄の目印が入っていたときの、その欄（ほかは null。ページが決める値など）。 */
  readonly field: SubmissionProbeInputField | null;
  /**
   * ARR-4（設計書 `2026-11-09-beaksight-api-array-rows-design.md` 2.3）: 一覧の要素の位置の欄のときだけ持つ、本文の一覧の鍵と位置（`key` は道
   * `apiArrayElementPathOf(element.key, element.index)`）。
   */
  readonly element?: { readonly key: string; readonly index: number; readonly name?: string };
  /**
   * ARR-5 fix round 1（SREV-ARR2 の M1）: 一覧の位置の道が、本文のほかの鍵かほかの道と重なるので分けなかった一覧の鍵だけが持つ（欄は null。承認は
   * `SCENARIO_API_ARRAY_PATH_CONFLICT` で拒む）。
   */
  readonly pathConflict?: true;
}

/**
 * ARR-4（設計書 2.3）: 欄の印が 2 つ以上入る一覧の鍵を、印の位置ごとの欄の鍵（道 `key[i]`）に分ける（分けられなければ null）。型の記録の位置の情報があり、
 * 印の入った位置ごとに印がちょうど 1 つで、印が欄に対応し、道が本文の鍵と重ならないときだけ分ける（L13: 道の長さは見ない）。ほかの形は
 * 今のまま欄のない 1 つの鍵（承認は `SCENARIO_API_ARRAY_MULTIPLE_FIELDS` で拒む）。
 */
const arrayElementKeyFieldsOf = (
  shape: ApiRequestShape,
  name: string,
  inputFields: readonly SubmissionProbeInputField[],
): readonly SubmissionProbeKeyField[] | typeof PATH_CONFLICT | null => {
  const positions = shape.body.keys.find((key) => key.name === name && key.type === 'array')?.elements?.positions;
  // ARR-5: object と scalar の混ざる一覧は分けない（承認は入れ子として拒む）。
  if (positions === undefined || (positions.some(({ type }) => type === 'object') && positions.some(({ type }) => type !== 'object'))) {
    return null;
  }
  const bodyKeys = new Set(shape.body.keys.map((key) => key.name));
  const entries: SubmissionProbeKeyField[] = [];
  let conflict = false;
  /** 印の入った値 1 つ（行の位置か、ARR-5: 行の中の鍵）を欄の鍵にする（分けられなければ偽）。 */
  const add = (markers: readonly number[], index: number, innerName?: string): boolean => {
    if (markers.length === 0) return true;
    const [marker] = markers;
    const field = markers.length === 1 ? inputFields.find((input) => input.marker === marker) ?? null : null;
    const path = apiArrayElementPathOf(name, index, innerName);
    // ARR-5 fix round 1（SREV-ARR2 の M1）: 道が本文の鍵か、同じ一覧のほかの道と重なれば、重なりとして分けない。
    if (bodyKeys.has(path) || entries.some(({ key }) => key === path)) {
      conflict = true;
      return false;
    }
    // L13（N25）: 道の長さでは分けるのをやめない（前は `MAX_API_SHAPE_NAME_LENGTH` を超えたら分けなかった）。
    if (field === null) {
      return false;
    }
    const element = innerName === undefined ? { key: name, index } : { key: name, index, name: innerName };
    entries.push(Object.freeze({ key: path, type: 'array' as const, field, element: Object.freeze(element) }));
    return true;
  };
  for (const [index, { markers, keys, type }] of positions.entries()) {
    // ARR-5（設計書 2.4 の 1）: object の行は、中の鍵ごとに道 `key[i].name` の欄の鍵にする。
    // 中の鍵を残さない object の行（上限の超過）は分けない。
    if ((type === 'object' && keys === undefined) || !add(markers, index) || !(keys ?? []).every((inner) => add(inner.markers, index, inner.name))) {
      return conflict ? PATH_CONFLICT : null;
    }
  }
  return entries.length === 0 ? null : entries;
};

/** ARR-5 fix round 1（SREV-ARR2 の M1）: 一覧の位置の道が、ほかの鍵かほかの道と重なる印。 */
const PATH_CONFLICT = 'PATH_CONFLICT' as const;

/**
 * T38a（Task 38 の設計書 3.1）: probe の結果から、本文の鍵ごとの欄の対応を組み立てる（純粋。本文の鍵の順）。型の `markerKeys`（鍵と目印の番号）と、
 * `inputFields`（目印の番号と欄の識別）を、目印の番号で結ぶ。型がない結果と、欄の範囲を持たない結果（T38a の前の成果物。番号が押下ごとに振り直されて
 * いない）は空。
 */
export const submissionProbeKeyFieldsOf = (probe: SubmissionProbeRecord): readonly SubmissionProbeKeyField[] => {
  const { shape, inputFields } = probe;
  if (shape === null || inputFields === undefined) {
    return Object.freeze([]);
  }
  const markersOf = (name: string, type: ApiJsonValueType): readonly number[] => {
    const markerKey = shape.body.markerKeys.find(({ key }) => key === name);
    // ARR-1（設計書 `2026-11-08-beaksight-api-array-keys-design.md` 3.3 の 1）: 一覧の中で見つかった目印は一覧の鍵（型 array）に、最上位の値で
    // 見つかった目印はそれ以外の鍵に対応づける。印と鍵の型が食い違う記録は対応づけない。
    const agrees = markerKey !== undefined && (markerKey.inArray === true) === (type === 'array');
    return agrees ? markerKey.markers : [];
  };
  // ARR-4: 欄の印が 2 つ以上入る一覧は、印の位置ごとの欄の鍵（道 `key[i]`）に分ける。
  // ARR-5: object の行のある一覧は、印が 1 つでも行の中の鍵ごとに分ける。
  const splits = new Map(shape.body.keys.map(({ name, type }) => {
    const markers = markersOf(name, type);
    const hasObjectRows = shape.body.keys.some((key) => key.name === name && key.elements?.positions?.some(({ keys }) => keys !== undefined) === true);
    return [name, type === 'array' && (markers.length >= 2 || (markers.length === 1 && hasObjectRows))
      ? arrayElementKeyFieldsOf(shape, name, inputFields)
      : null] as const;
  }));
  // ARR-5 fix round 1（SREV-ARR2 の M1）: 別の一覧から作った道どうしが重なれば、その一覧はどちらも分けない（重なりの印を持つ）。
  const pathCounts = new Map<string, number>();
  for (const split of splits.values()) {
    if (Array.isArray(split)) for (const { key } of split) pathCounts.set(key, (pathCounts.get(key) ?? 0) + 1);
  }
  return Object.freeze(shape.body.keys.flatMap(({ name, type }) => {
    const split = splits.get(name) ?? null;
    const conflict = split === PATH_CONFLICT || (Array.isArray(split) && split.some(({ key }) => (pathCounts.get(key) ?? 0) > 1));
    if (conflict) {
      return [Object.freeze({ key: name, type, field: null, pathConflict: true as const })];
    }
    if (Array.isArray(split)) {
      return split;
    }
    const markers = markersOf(name, type);
    const [only] = markers;
    const field = markers.length === 1 ? inputFields.find(({ marker }) => marker === only) ?? null : null;
    return [Object.freeze({ key: name, type, field })];
  }));
};

/**
 * 画面の記録の候補に、probe の結果を付ける（純粋。入力を変えない。鍵は候補の一覧の位置）。付けた候補だけ `submissionProbe` を持ち、ほかの項目
 * （識別の digest と規則の digest を含む）は変えない。結果がなければ、同じ記録を返す。
 */
export const withSubmissionProbes = (
  record: DiscoveryReadPageRecord,
  probes: ReadonlyMap<number, SubmissionProbeRecord>,
): DiscoveryReadPageRecord => {
  if (probes.size === 0) {
    return record;
  }
  return Object.freeze({
    location: record.location,
    incompleteReasons: record.incompleteReasons,
    candidates: Object.freeze(record.candidates.map((candidate, index) => {
      const probe = probes.get(index);
      return probe === undefined ? candidate : Object.freeze({ ...candidate, submissionProbe: probe });
    })),
    // OP-K（K1）: 画面の名前は写す（前は落としていた。押して確かめた画面の一覧の行の名前が取れなかった）。
    ...(record.screenName === undefined ? {} : { screenName: record.screenName }),
    // COV-3: 選択肢を選んだ欄の記録も写す。
    ...(record.optionChoices === undefined ? {} : { optionChoices: record.optionChoices }),
  });
};

/** COV-3: 選択肢を選んだ欄の記録を、記録の末尾に足す（純粋。足すものがなければ、同じ記録を返す）。 */
export const withOptionChoices = (
  record: DiscoveryReadPageRecord,
  choices: readonly DiscoveryOptionChoiceRecord[],
): DiscoveryReadPageRecord => (choices.length === 0
  ? record
  : Object.freeze({ ...record, optionChoices: Object.freeze([...(record.optionChoices ?? []), ...choices]) }));

// ---------------------------------------------------------------------------------------------------------------
// 対象と押す順
// ---------------------------------------------------------------------------------------------------------------

/** 対象の選び方の決まり。 */
export interface SubmissionProbeTargetPolicy {
  /** 許可 Origin（分類と同じ。プロファイルの `approvedTestOrigins`）。 */
  readonly allowedOrigins: ReadonlySet<string>;
  /**
   * 押さない画面か（ログインの画面。呼び出し側が、認証の設定のログインの path で決める）。発見の流れは、巡回の候補の除外の判定（`isExcludedCrawlCandidate`。
   * セッションの切れの path（ログインの画面）と、監査の段の除外）を渡す（除外に当たる画面も押さない。安全側）。
   */
  readonly isExcludedPage: (page: CandidateLocation) => boolean;
}

const DESTRUCTIVE_WORDS: ReadonlySet<string> = new Set(DISCOVERY_DESTRUCTIVE_WORDS);

/** probe の対象か（ファイルの先頭の説明。分類を偽った入力でも、削除の語・外部・ログインの画面は押さない）。 */
export const isSubmissionProbeTarget = (candidate: DiscoveryCandidate, policy: SubmissionProbeTargetPolicy): boolean =>
  candidate.classification === 'NEEDS_BINDING'
  && !candidate.submitterWords.some((word) => DESTRUCTIVE_WORDS.has(word))
  && isInsideAllowedOrigins(candidate.page.origin, policy)
  && (candidate.action === null || isInsideAllowedOrigins(candidate.action.origin, policy))
  && !policy.isExcludedPage(candidate.page);

/** 要素の位置の比べ（文書の順。番号の並びを前から比べ、祖先は子孫より前）。 */
export const compareElementPaths = (left: readonly number[], right: readonly number[]): number => {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return left.length - right.length;
};

/**
 * DEF-142（設計書 `2026-10-20-beaksight-probe-press-priority-design.md` 2 章）: 先に押す、登録・更新の語（閉じた一覧）。分類の語の一覧の、更新の語
 * （`DISCOVERY_UPDATE_WORDS`）と登録の語（`DISCOVERY_CREATE_WORDS`）を、この順につないだもの（同じ意味の一覧を使う。危険な語とは重ならない）。
 */
export const SUBMISSION_PROBE_PRIORITY_WORDS: readonly string[] = Object.freeze([...DISCOVERY_UPDATE_WORDS, ...DISCOVERY_CREATE_WORDS]);

const PRIORITY_WORDS: ReadonlySet<string> = new Set(SUBMISSION_PROBE_PRIORITY_WORDS);

/**
 * DEF-208-2（設計書 `2026-11-05-beaksight-discovery-coverage-design.md` 3.2）: 確定の語（保存・登録・更新など）。登録・更新の語（`SUBMISSION_PROBE_PRIORITY_WORDS`）
 * から、行を足す語（`DISCOVERY_ROW_ADD_WORDS`）と開き手の語（`DISCOVERY_OPENER_WORDS`）を除いたもの（一覧を新しく持たず、ここで組み立てる）。
 */
export const SUBMISSION_PROBE_CONFIRM_WORDS: readonly string[] = Object.freeze(SUBMISSION_PROBE_PRIORITY_WORDS.filter((word) =>
  !(DISCOVERY_ROW_ADD_WORDS as readonly string[]).includes(word) && !(DISCOVERY_OPENER_WORDS as readonly string[]).includes(word)));

const CONFIRM_WORDS: ReadonlySet<string> = new Set(SUBMISSION_PROBE_CONFIRM_WORDS);

/**
 * DEF-145（設計書 `2026-10-21-beaksight-probe-navigation-and-dialog-design.md` 2.2）: 送信ボタンの語に、登録・更新の語（`SUBMISSION_PROBE_PRIORITY_WORDS`）が
 * あるか（押下で開いたダイアログの中から、先に押す対象を選ぶ）。
 */
export const hasSubmissionProbePriorityWord = (submitterWords: readonly string[]): boolean =>
  submitterWords.some((word) => PRIORITY_WORDS.has(word));

/**
 * DEF-221（設計書 `2026-11-08-beaksight-same-origin-api-and-spa-routes-design.md` 3.2 の 3）: 送信ボタンの語に、確定の語（`SUBMISSION_PROBE_CONFIRM_WORDS`）が
 * あるか（押下で新しく現れた、開いた窓の外のボタンから、DEF-145 の読み直しで押す対象を選ぶ）。
 */
export const hasSubmissionProbeConfirmWord = (submitterWords: readonly string[]): boolean =>
  submitterWords.some((word) => CONFIRM_WORDS.has(word));

/** DEF-208-4（A）: 共通の枠のボタンの識別の digest の形の名前。 */
export const SHARED_LAYOUT_IDENTITY_DIGEST_FORMAT = 'beaksight-shared-layout-identity/1';

/** DEF-208-4（A）: 共通の枠のボタンの識別の事実（値と画面の path を持たない）。 */
export interface SharedLayoutIdentityFacts {
  readonly kind: string;
  readonly submitterWords: readonly string[];
  readonly hasSubmitterText: boolean;
  /** 送信ボタンの祖先の、枠の目印（`nav`・`aside`・`header`・`footer` と、その role の目印。内から外の順）。 */
  readonly landmarks: readonly string[];
}

/**
 * DEF-208-4（設計書 `2026-11-05-beaksight-discovery-coverage-design.md` 3.7 の A）: 共通の枠のボタンの識別の digest（純粋）。語の組（重ねずに並べ替える）・種類・
 * 文字があるか・祖先の枠の目印の形から作り、画面の path と値は入れない。枠の目印がない（本文の）ボタンは null（共通の枠のボタンにしない）。
 */
export const sharedLayoutIdentityDigestOf = (facts: SharedLayoutIdentityFacts): string | null =>
  (facts.landmarks.length === 0
    ? null
    : createSha256Fingerprint(JSON.stringify([
      SHARED_LAYOUT_IDENTITY_DIGEST_FORMAT,
      facts.kind,
      [...new Set(facts.submitterWords)].sort(),
      facts.hasSubmitterText,
      facts.landmarks,
    ])));

/**
 * COV-1・SLK-1: 共通の枠のボタンの押した印の形の印（版つき）。SLK-1 で、画面全体の構造の鍵との組から、枠の部分の構造の鍵との組に変えたので 2（前の版の
 * 印は読み替えない。checkpoint に残った前の版の印は、どの印とも一致せず使われない＝押し直す側）。
 */
export const SHARED_LAYOUT_STATE_KEY_FORMAT = 'beaksight-shared-layout-state/3';

/**
 * SLK-1（網羅の設計書 6 章の 2026-11-16）: 共通の枠の部分の構造の事実（文字の値を持たない）。枠の部分は、送信ボタンの祖先の枠の目印のうち最も外のもの
 * （`sharedLayoutIdentityDigestOf` の目印と同じ基準）。
 */
export interface SharedLayoutStructureFacts {
  /** 枠の中の候補の、共通の枠のボタンの識別の digest（`sharedLayoutIdentityDigestOf`。画面の path を入れない）。 */
  readonly candidateIdentityDigests: readonly string[] | null;
  /** 枠の中の見える欄。 */
  readonly fields: readonly StateStructureField[] | null;
  /** 画面に開いた窓・区画があるか。 */
  readonly openedDialogOrRegion: boolean | null;
  /** 枠の中の見える見出しの段。 */
  readonly headingLevels: readonly number[] | null;
  /** REV-SD の M-4: 枠の中のリンクの移る先の path（鍵には path の型の集合だけを入れる。文字の値は入れない）。 */
  readonly linkPaths: readonly string[] | null;
  /** REV-SD の M-4: 枠の中に開閉の印（`aria-expanded`）のある要素があるか。 */
  readonly hasExpandToggle: boolean | null;
}

/** REV-SD の M-4: 枠の部分の構造の鍵の形の印（版つき）。 */
const SHARED_LAYOUT_STRUCTURE_KEY_FORMAT = 'beaksight-shared-layout-structure/1';

/**
 * SLK-1: 共通の枠の部分の構造の鍵（純粋）。状態の鍵の唯一の部品（`stateStructureKeyOf`）で作り、枠の部分の外の事実（画面の path・query の名前・landmark・
 * 状態の語）は入れない（どれも同じ値。画面全体の作りが違っても、枠の部分の作りが同じなら同じ鍵）。REV-SD の M-4: 枠の中のリンクの path の型
 * （`pageTemplatePathOf`。番号は `{id}`）の集合と、開閉の印の有無も入れる。
 */
export const sharedLayoutStructureKeyOf = (facts: SharedLayoutStructureFacts): string => createSha256Fingerprint(JSON.stringify([
  SHARED_LAYOUT_STRUCTURE_KEY_FORMAT,
  stateStructureKeyOf({
    path: null,
    queryNames: null,
    candidateIdentityDigests: facts.candidateIdentityDigests,
    fields: facts.fields,
    openedDialogOrRegion: facts.openedDialogOrRegion,
    headingLevels: facts.headingLevels,
    landmarkRoles: null,
    stateWords: null,
  }),
  facts.linkPaths === null ? null : [...new Set(facts.linkPaths.map((path) => pageTemplatePathOf(path) ?? path))].sort(compareCodeUnits),
  facts.hasExpandToggle,
]));

/**
 * COV-1（網羅の設計書 3.2 の 5）・SLK-1（同 6 章の 2026-11-16）: 共通の枠のボタンの押した印（純粋）。（枠の部分の構造の鍵 `sharedLayoutStructureKeyOf`・共通の
 * 枠のボタンの識別の digest）の digest。発見の流れは中身を見ずに文字列として持つ（`SubmissionProbeOptions.sharedLayout`）。枠の部分の作りが前に押した時と
 * 同じなら同じ印（押し直さない）、枠の中の候補・欄などが違えば別の印になる（押す）。
 */
export const sharedLayoutStateKeyOf = (layoutStructureKey: string, layoutDigest: string): string =>
  createSha256Fingerprint(JSON.stringify([SHARED_LAYOUT_STATE_KEY_FORMAT, layoutStructureKey, layoutDigest]));

/**
 * DEF-208-2（設計書 3.3）: 同じ語の組の見分けの鍵（送信ボタンの語を、重ねずに並べ替えてつないだもの。純粋）。語のない対象は null（語で見分けられないので、
 * 何も送らなかった押下の後も押す）。SREV-1105-3 の Minor-1: 範囲の鍵（`scope`。同じ form か、どちらも form の外か。呼び出し側が決める）も入れる（別の form の
 * 同じ語のボタンは、別の組）。
 */
export const submissionProbeWordsKeyOf = (submitterWords: readonly string[], scope = ''): string | null =>
  (submitterWords.length === 0 ? null : JSON.stringify([scope, [...new Set(submitterWords)].sort()]));

/** 押す順を決める対象の事実（送信ボタンの位置、送信ボタンの語、送信ボタンに文字があるか）。 */
export interface SubmissionProbePressEntry {
  readonly path: readonly number[];
  readonly submitterWords: readonly string[];
  /** 送信ボタンの文言（probe が読むボタンの文字・`aria-label`・`title`）が空でないか。 */
  readonly hasSubmitterText: boolean;
  /**
   * T44c（設計者の判断）: 送信ボタンの文言に、送信の語（「送信」「確定」「submit」）があるか（probe の読み直しの `hasSubmitWord`。省略は偽）。候補の語では
   * ないので、識別の digest には入らない。
   */
  readonly hasSubmitWord?: boolean;
}

/**
 * 押す順の段（小さいほど先）: DEF-208-2（設計書 `2026-11-05-beaksight-discovery-coverage-design.md` 3.2）で、登録・更新の語の段を 2 つに分けた。
 * 0. 確定の語（`SUBMISSION_PROBE_CONFIRM_WORDS`）のあるもの。
 * 1. 送信の語の印のあるもの（T44c。確定の語の次で、行を足す語・開き手の語より先）。
 * 2. 行を足す語・開き手の語だけの、登録・更新の語のあるもの。
 * 3. 文字のあるそのほか。4. 文字のないもの。
 */
const pressRankOf = (entry: SubmissionProbePressEntry): number => {
  if (entry.submitterWords.some((word) => CONFIRM_WORDS.has(word))) {
    return 0;
  }
  if (entry.hasSubmitWord === true) {
    return 1;
  }
  if (hasSubmissionProbePriorityWord(entry.submitterWords)) {
    return 2;
  }
  return entry.hasSubmitterText ? 3 : 4;
};

/**
 * 押す順（DEF-142。純粋。入力を変えない）: 登録・更新の語（`SUBMISSION_PROBE_PRIORITY_WORDS`）のあるもの、送信の語の印のあるもの（T44c）、文字のある
 * そのほか、文字のないもの、の順に並べる。同じ段の中は文書の順（`compareElementPaths`）。危険な語（`DISCOVERY_DESTRUCTIVE_WORDS`）のある対象は並べない（押さない。対象の選び方
 * `isSubmissionProbeTarget` と重ねた守り）。押す回数の上限は置かない（COV-1）。
 */
export const submissionProbePressOrderOf = <Entry extends SubmissionProbePressEntry>(entries: readonly Entry[]): readonly Entry[] => {
  const ordered = entries.filter((entry) => !entry.submitterWords.some((word) => DESTRUCTIVE_WORDS.has(word)));
  ordered.sort((left, right) => pressRankOf(left) - pressRankOf(right) || compareElementPaths(left.path, right.path));
  return Object.freeze(ordered);
};

// ---------------------------------------------------------------------------------------------------------------
// 欄と目印
// ---------------------------------------------------------------------------------------------------------------

/** 欄への操作（ファイルの先頭の説明）。 */
export const submissionProbeFieldActionOf = (type: CandidateFieldType): SubmissionProbeFieldAction => {
  if ((SUBMISSION_PROBE_FILL_FIELD_TYPES as readonly CandidateFieldType[]).includes(type)) {
    return 'FILL';
  }
  return (SELECT_FIELD_TYPES as readonly CandidateFieldType[]).includes(type) ? 'SELECT' : 'SKIP';
};

/** 目印の頭（text 系の目印と、email・url の目印の名前の部分）。 */
const MARKER_PREFIX = 'bsprobe';
/** 目印の乱数のバイト数（16 進で 12 桁）。 */
const MARKER_RANDOM_BYTES = 6;
/** email の目印の後ろ（解決できない予約のドメイン）。 */
const EMAIL_MARKER_SUFFIX = '@example.invalid';
/** url の目印の頭（解決できない予約のドメイン）。 */
const URL_MARKER_PREFIX = 'https://example.invalid/';
/** 数字だけの目印の桁の数。 */
const DIGITS_MARKER_LENGTH = 9;
/** date の目印の始まりの年（月日は固定 `DATE_MARKER_MONTH_DAY`。欄ごとに 1 年ずつ進める。L13: 目印の数に上限はないので、8,000 個目の目印からは 5 桁の年（日付の欄に入らない値）になる。既知の限界）。 */
const DATE_MARKER_BASE_YEAR = 2001;
/** date の目印の月日（`-MM-DD`）。 */
const DATE_MARKER_MONTH_DAY = '-02-03';
/** 重なった目印を引き直す回数の上限。 */
const MAX_MARKER_DRAWS = 16;
const HEX_RADIX = 16;
const DECIMAL_RADIX = 10;

/** 既定の乱数（16 進の 12 桁）。 */
const defaultRandomHex = (): string => randomBytes(MARKER_RANDOM_BYTES).toString('hex');

/** 16 進の乱数から、数字だけの目印（先頭は 1〜9）。 */
const digitsOf = (hex: string): string => Array.from({ length: DIGITS_MARKER_LENGTH }, (_value, index) => {
  const value = Number.parseInt(hex[index % hex.length] ?? '0', HEX_RADIX);
  return String(index === 0 ? (value % (DECIMAL_RADIX - 1)) + 1 : value % DECIMAL_RADIX);
}).join('');

/** 型の目印の候補（date は使った目印の数で年を進める）。 */
const markerCandidateOf = (type: CandidateFieldType, used: readonly string[], hex: string): string => {
  switch (type) {
    case 'email':
      return `${MARKER_PREFIX}${hex}${EMAIL_MARKER_SUFFIX}`;
    case 'url':
      return `${URL_MARKER_PREFIX}${MARKER_PREFIX}${hex}`;
    case 'number':
    case 'tel':
      return digitsOf(hex);
    case 'date':
      return `${String(DATE_MARKER_BASE_YEAR + used.length)}${DATE_MARKER_MONTH_DAY}`;
    default:
      return `${MARKER_PREFIX}${hex}`;
  }
};

/** ほかの目印と重ならない（含まず、含まれない）か。 */
const overlapsAny = (marker: string, used: readonly string[]): boolean =>
  used.some((other) => other.includes(marker) || marker.includes(other));

/**
 * 欄の目印を作る（`used` は、その押下で使った目印。T38a: 目印の番号は押下ごとに 0 から振る。L13: 数の上限は置かない）。
 * `avoided` は、その画面の前の押下で使った目印（T38a: 同じ値・重なる値を使わない。上限には数えない）。重なれば引き直す。上限に達しているか、引き直しても
 * 重なれば `RangeError`（値を文に入れない）。`randomHex` は試験のための差し替え（本番は省略して `node:crypto`）。
 */
export const submissionProbeMarkerOf = (
  type: CandidateFieldType,
  used: readonly string[],
  randomHex: () => string = defaultRandomHex,
  avoided: readonly string[] = [],
): string => {
  // L13（N25）: 1 回の押下の目印の数に上限を置かない（前は `MAX_API_SHAPE_MARKERS` で RangeError）。
  const known = [...avoided, ...used];
  for (let draw = 0; draw < MAX_MARKER_DRAWS; draw += 1) {
    const marker = markerCandidateOf(type, known, randomHex());
    if (!overlapsAny(marker, known)) {
      return marker;
    }
  }
  throw new RangeError('A submission probe marker overlapped the markers in use');
};
