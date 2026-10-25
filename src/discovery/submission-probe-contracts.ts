// 送らずに観察する probe の契約と純粋な部品（T37c。Task 37 の設計書 3.2 の「対象」「入力」、3.4、5 章）。純粋な関数だけのファイル（ページを操作しない。
// Gate (w)。Playwright、ブラウザ、`src/safety/`、`src/control/` を import しない。`tests/architecture/discovery-boundary.test.ts` の (x)）。押す部品は
// `src/interaction/submission-probe.ts`（ページを操作してよいファイルの閉じた一覧 (q) の 1 つ）で、この契約を使う。
// - 対象（`isSubmissionProbeTarget`）: 分類が `NEEDS_BINDING`（JS の結び付き）で、送信ボタンの語に削除の語（`DISCOVERY_DESTRUCTIVE_WORDS`）がなく、画面と送信先が
//   許可 Origin の中（`isInsideAllowedOrigins`。分類と同じ判定）で、画面がログインの画面でない（呼び出し側が認証の設定のログインの path で決めて渡す。発見の
//   流れは監査の段の除外の画面も渡す）候補。
// - 押す順（`submissionProbePressOrderOf`）: DEF-142 で、登録・更新の語（`SUBMISSION_PROBE_PRIORITY_WORDS`）のあるもの、文字のあるそのほか、文字の
//   ないもの、の順（同じ段の中は文書の順。要素の位置 `compareElementPaths`）。T44c: 送信の語（「送信」「確定」「submit」。probe だけが読む印 `hasSubmitWord`）の
//   あるものを、登録・更新の語の次の段に置く。1 画面あたり `MAX_SUBMISSION_PROBE_PRESSES_PER_PAGE` 回まで押し（押す前に
//   見えない対象は、回数を使わずに飛ばす）、残りは押さない（`NOT_OBSERVED`、`PRESS_LIMIT_REACHED`）。
// - 欄（`submissionProbeFieldActionOf`）: text 系の `input`（`SUBMISSION_PROBE_FILL_FIELD_TYPES`）と `textarea` に目印を入れ、`select` は空でない最初の選択肢を
//   選ぶ。`password`・`file`・`hidden`・`checkbox`・`radio` とほかの型は触らない（触らなかった欄の数を記録する）。
// - 目印（`submissionProbeMarkerOf`）: 欄ごとに違う乱数（`node:crypto`）。型に合わせる（email は `@example.invalid`、url は `https://example.invalid/`、number と
//   tel は数字だけ、date は固定の月日で欄ごとに年を 1 つずつ進める）。ほかの目印を含まず、ほかの目印に含まれない（型の作り手が目印の番号を正しく対応させるため）。
//   1 画面で `MAX_API_SHAPE_MARKERS` まで。目印は秘密でないが、記録・成果物・管理データ・IPC・画面には出さない（I22）。値そのものは記録しない。
// - 結果（`SubmissionProbeRecord`。候補の任意の項目 `submissionProbe`）: 観察の結果を T37b の分類（`classifyApiShapeObservation`）で写した結果・理由・型・型の
//   digest と、数（読み取りでない要求、止めた読み取り、型を受けなかった要求、入れた欄、触らなかった欄）。観察しなかったときは `NOT_OBSERVED` と理由
//   （`SUBMISSION_PROBE_NOT_OBSERVED_REASONS`）。候補の識別の digest と規則の digest は変えない（`withSubmissionProbes`）。
import { randomBytes } from 'node:crypto';
import { API_FILTER_OPERATORS, MAX_API_SHAPE_MARKERS, type ApiJsonValueType, type ApiRequestShape } from '../core/api-request-shape.js';
import { API_SHAPE_NOT_EXECUTABLE_REASONS, classifyApiShapeObservation, type ApiShapeNotExecutableReason } from './api-shape-classification.js';
import {
  SELECT_FIELD_TYPES,
  type CandidateFieldType,
  type CandidateLocation,
  type DiscoveryCandidate,
} from './candidate-contracts.js';
import { DISCOVERY_CREATE_WORDS, DISCOVERY_DESTRUCTIVE_WORDS, DISCOVERY_UPDATE_WORDS } from './classification-words.js';
import { isInsideAllowedOrigins } from './classify.js';
import type { DiscoveryReadPageRecord } from './discovery-result.js';

// ---------------------------------------------------------------------------------------------------------------
// 名前つきの定数と閉じた一覧
// ---------------------------------------------------------------------------------------------------------------

/** 1 画面で押す回数の上限（ユーザーの確認 2026-10-16「1 画面 3 回まで、読み込み直しなし」）。 */
export const MAX_SUBMISSION_PROBE_PRESSES_PER_PAGE = 3;
/** 押した後、ページの要求が静まるまで待つ時間（ms。設計書 3.2 の既定）。 */
export const SUBMISSION_PROBE_QUIET_WAIT_MS = 2_000;

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
 * - `PRESS_LIMIT_REACHED`: 1 画面の押す回数の上限を超えた対象。
 * - `TARGET_NOT_FOUND`: 押す前の読み直しで、同じ識別の候補か、押せる要素（送信ボタン）が見つからなかった。
 * - `PRESS_FAILED`: 欄に入れるか押す操作が失敗した、か凍結の段でなかった（押していないか、押したかが分からない）。
 * - `CONTEXT_CLOSED_BY_GUARD`: DEF-144（設計書 `2026-10-20-beaksight-probe-external-scheme-design.md` 2.3）: Guard が Context を閉じ始めた（安全の違反の
 *   後の無効化）。その押下と、その画面の残りの対象（`PAGE_CHANGED` と分けて記録する）。
 */
export const SUBMISSION_PROBE_NOT_OBSERVED_REASONS = Object.freeze([
  'PAGE_CHANGED',
  'PRESS_LIMIT_REACHED',
  'TARGET_NOT_FOUND',
  'PRESS_FAILED',
  'CONTEXT_CLOSED_BY_GUARD',
] as const);
export type SubmissionProbeNotObservedReason = (typeof SUBMISSION_PROBE_NOT_OBSERVED_REASONS)[number];
/** T44c: 押す数の上限で押さなかった理由（成果物の数 `pressLimitProbesOf` が数える理由）。 */
export const PRESS_LIMIT_PROBE_REASON = 'PRESS_LIMIT_REACHED' satisfies SubmissionProbeNotObservedReason;
/** DEF-144: Guard が Context を閉じたので押せなかった理由（発見の流れが、読み込み直して押す残りの候補を選ぶ）。 */
export const CONTEXT_CLOSED_BY_GUARD_PROBE_REASON = 'CONTEXT_CLOSED_BY_GUARD' satisfies SubmissionProbeNotObservedReason;

/**
 * DEF-144: 押さない理由（probe だけの、実行できない理由）。`EXTERNAL_SCHEME`: 送信ボタンか祖先の `<a>`・`<area>` の `href`、または form の `action`・
 * `formaction` が http(s) でないスキーム（`mailto:`・`tel:`・独自のスキームなど）を指す（押す前に見分けた）か、押下で外部スキームへ移ろうとした（Guard が
 * 止めて違反を記録した）。押す回数は使わない。
 */
export const SUBMISSION_PROBE_ONLY_NOT_EXECUTABLE_REASONS = Object.freeze(['EXTERNAL_SCHEME'] as const);
export type SubmissionProbeOnlyNotExecutableReason = (typeof SUBMISSION_PROBE_ONLY_NOT_EXECUTABLE_REASONS)[number];
/** DEF-144: 外部スキームで押さなかった理由（成果物の数 `externalSchemeProbesOf` が数える理由）。 */
export const EXTERNAL_SCHEME_PROBE_REASON = 'EXTERNAL_SCHEME' satisfies SubmissionProbeOnlyNotExecutableReason;

/** 実行できない理由（T37b の分類の理由と、probe だけの理由）。 */
export const SUBMISSION_PROBE_NOT_EXECUTABLE_REASONS = Object.freeze([
  ...API_SHAPE_NOT_EXECUTABLE_REASONS,
  ...SUBMISSION_PROBE_ONLY_NOT_EXECUTABLE_REASONS,
] as const);

/** probe の理由（実行できない理由と、観察しなかった理由）。 */
export const SUBMISSION_PROBE_REASONS = Object.freeze([...SUBMISSION_PROBE_NOT_EXECUTABLE_REASONS, ...SUBMISSION_PROBE_NOT_OBSERVED_REASONS] as const);
export type SubmissionProbeReason = ApiShapeNotExecutableReason | SubmissionProbeOnlyNotExecutableReason | SubmissionProbeNotObservedReason;

/**
 * DEF-144: probe の段で外部スキームへの移動の違反が起きた画面を、残りの候補を押すために読み込み直す回数の上限（1 画面あたり。ユーザーの判断 2026-10-20）。
 * 押す回数の上限（`MAX_SUBMISSION_PROBE_PRESSES_PER_PAGE`）は、読み込み直しの前と後を合わせて数える。
 */
export const MAX_SUBMISSION_PROBE_RELOADS_PER_PAGE = 1;

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

/** T38a: 欄の CSS の最大長（UTF-16 のコード単位。超える CSS は記録しない）。 */
export const MAX_SUBMISSION_PROBE_FIELD_SELECTOR_LENGTH = 512;

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
}

/** 観察の結果（観察の口の結果のうち、分類と数に使うもの。`src/safety/submission-observation.ts` の `SubmissionObservationResult` と同じ形）。 */
export interface SubmissionProbeObservation extends SubmissionProbeObservationCounts {
  readonly shapes: readonly ApiRequestShape[];
}

const NO_FIELDS: SubmissionProbeFieldCounts = Object.freeze({ filledFieldCount: 0, skippedFieldCount: 0 });

/** 観察した押下の結果（T37b の分類に写す。入力を変えない）。 */
export const observedSubmissionProbeOf = (
  observation: SubmissionProbeObservation,
  fields: SubmissionProbeFieldCounts,
  inputFields: readonly SubmissionProbeInputField[] = [],
): SubmissionProbeRecord => {
  const classified = classifyApiShapeObservation({ shapes: observation.shapes, nonReadRequestCount: observation.nonReadRequestCount });
  return Object.freeze({
    result: classified.classification,
    reason: classified.reason,
    shape: classified.shape,
    shapeDigest: classified.shapeDigest,
    nonReadRequestCount: observation.nonReadRequestCount,
    readRequestCount: observation.readRequestCount,
    unrecordedShapeCount: observation.unrecordedShapeCount,
    filledFieldCount: fields.filledFieldCount,
    skippedFieldCount: fields.skippedFieldCount,
    inputFields: frozenInputFieldsOf(inputFields),
  });
};

/** 欄の識別の凍結した写し（項目を選んで写す）。 */
const frozenInputFieldsOf = (inputFields: readonly SubmissionProbeInputField[]): readonly SubmissionProbeInputField[] =>
  Object.freeze(inputFields.map(({ name, selector, type, marker }) => Object.freeze({ name, selector, type, marker })));

/** 観察しなかった対象の結果（型なし、要求の数は 0。T38a: 押す前に入れた欄があれば、その識別）。 */
export const notObservedSubmissionProbeOf = (
  reason: SubmissionProbeNotObservedReason,
  fields: SubmissionProbeFieldCounts = NO_FIELDS,
  inputFields: readonly SubmissionProbeInputField[] = [],
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
});

/** DEF-144: 外部スキームを指す（か、押下で外部スキームへ移ろうとした）ので押さなかった対象の結果（型なし、数は 0。押していない）。 */
export const externalSchemeSubmissionProbeOf = (): SubmissionProbeRecord => Object.freeze({
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
});

/** T38a: 本文の鍵と、その鍵に入った目印の欄（`submissionProbeKeyFieldsOf` の 1 件）。 */
export interface SubmissionProbeKeyField {
  readonly key: string;
  /** 鍵の値の JSON の型。 */
  readonly type: ApiJsonValueType;
  /** 鍵の値に、ちょうど 1 つの欄の目印が入っていたときの、その欄（ほかは null。ページが決める値など）。 */
  readonly field: SubmissionProbeInputField | null;
}

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
  return Object.freeze(shape.body.keys.map(({ name, type }) => {
    const markers = shape.body.markerKeys.find(({ key }) => key === name)?.markers ?? [];
    const [only] = markers;
    const field = markers.length === 1 ? inputFields.find(({ marker }) => marker === only) ?? null : null;
    return Object.freeze({ key: name, type, field });
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
  });
};

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
 * DEF-145（設計書 `2026-10-21-beaksight-probe-navigation-and-dialog-design.md` 2.2）: 送信ボタンの語に、登録・更新の語（`SUBMISSION_PROBE_PRIORITY_WORDS`）が
 * あるか（押下で開いたダイアログの中から、先に押す対象を選ぶ）。
 */
export const hasSubmissionProbePriorityWord = (submitterWords: readonly string[]): boolean =>
  submitterWords.some((word) => PRIORITY_WORDS.has(word));

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

/** 押す順の段（小さいほど先）: 登録・更新の語のあるもの、送信の語のあるもの（T44c）、文字のあるそのほか、文字のないもの。 */
const pressRankOf = (entry: SubmissionProbePressEntry): number => {
  if (hasSubmissionProbePriorityWord(entry.submitterWords)) {
    return 0;
  }
  if (entry.hasSubmitWord === true) {
    return 1;
  }
  return entry.hasSubmitterText ? 2 : 3;
};

/**
 * 押す順（DEF-142。純粋。入力を変えない）: 登録・更新の語（`SUBMISSION_PROBE_PRIORITY_WORDS`）のあるもの、送信の語の印のあるもの（T44c）、文字のある
 * そのほか、文字のないもの、の順に並べる。同じ段の中は文書の順（`compareElementPaths`）。危険な語（`DISCOVERY_DESTRUCTIVE_WORDS`）のある対象は並べない（押さない。対象の選び方
 * `isSubmissionProbeTarget` と重ねた守り）。上限（`MAX_SUBMISSION_PROBE_PRESSES_PER_PAGE`）は、押す部品が、押した回数で数える（押す前に見えない対象は
 * 数えない）。
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
/** date の目印の始まりの年（月日は固定 `DATE_MARKER_MONTH_DAY`。欄ごとに 1 年ずつ進める。`MAX_API_SHAPE_MARKERS` 個でも 4 桁の年に収まる）。 */
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
 * 欄の目印を作る（`used` は、その押下で使った目印。T38a: 目印の番号は押下ごとに 0 から振るので、上限 `MAX_API_SHAPE_MARKERS` は 1 回の押下の数）。
 * `avoided` は、その画面の前の押下で使った目印（T38a: 同じ値・重なる値を使わない。上限には数えない）。重なれば引き直す。上限に達しているか、引き直しても
 * 重なれば `RangeError`（値を文に入れない）。`randomHex` は試験のための差し替え（本番は省略して `node:crypto`）。
 */
export const submissionProbeMarkerOf = (
  type: CandidateFieldType,
  used: readonly string[],
  randomHex: () => string = defaultRandomHex,
  avoided: readonly string[] = [],
): string => {
  if (used.length >= MAX_API_SHAPE_MARKERS) {
    throw new RangeError(`A press has at most ${String(MAX_API_SHAPE_MARKERS)} submission probe markers`);
  }
  const known = [...avoided, ...used];
  for (let draw = 0; draw < MAX_MARKER_DRAWS; draw += 1) {
    const marker = markerCandidateOf(type, known, randomHex());
    if (!overlapsAny(marker, known)) {
      return marker;
    }
  }
  throw new RangeError('A submission probe marker overlapped the markers in use');
};
