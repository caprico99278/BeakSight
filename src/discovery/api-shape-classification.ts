// 送らずに観察した型の分類と、型の digest（T37b。Task 37 の設計書 3.3 の表、3.4 の `shapeDigest`。I21）。純粋な関数だけのファイル（ページを操作しない。
// Gate (w)）。Playwright、ブラウザ、`src/safety/`、`src/control/` を import しない（`tests/architecture/discovery-boundary.test.ts` の (x)）。
// - 上から順に当てる: `NO_REQUEST`（押した後に読み取りでない要求がない）→ `NOT_EXECUTABLE`（理由の閉じた一覧 `API_SHAPE_NOT_EXECUTABLE_REASONS`）→
//   `API_UPDATE` → `API_CREATE` → `NOT_EXECUTABLE`（`UNRECOGNIZED`）。
// - 1 回の押下で 2 つ以上の読み取りでない要求があれば、それより上の行（method、Origin、手続きの呼び出し、upsert、array、JSON でない本文）をどれかの型が
//   満たせばその理由、満たさなければ `MULTIPLE_REQUESTS`。それより下の行は、ただ 1 つの型で見る。
// - filter の書き方、閉じた一覧の query の名前（`select`）、upsert の印、手続きの呼び出しの path の区切りは、型の契約（`src/core/api-request-shape.ts`）の
//   1 か所で持つ。論理削除にあたる鍵は、状態の欄の名前の判定（`fieldNameHasStateWord`）を使う（書き写さない）。T37R-fix-A（I-3）: 型の作り手が伏せる前の
//   名前で見た真偽（`stateKeyPresent`）も見る。手続きの呼び出しの path は decode して畳んで比べ、鍵の切り詰めと伏せた鍵の名前は `SHAPE_TRUNCATED`。
//   T37R2-fix-A: 手続きの呼び出しの path は監査の除外と同じ形（`exclusionMatchPathFormsOf`）で比べ（M-1）、長すぎて伏せた path とヘッダの名前の
//   切り詰めも `SHAPE_TRUNCATED`、method の上書き（ヘッダの閉じた一覧 `API_METHOD_OVERRIDE_HEADER_NAMES` と本文の `_method`）は `METHOD_OVERRIDE`
//   （M-2）。入れ子の本文の論理削除の鍵は見ない（限界）。
//   DEF-147: 論理削除の鍵の判定は `apiShapeHasSoftDeleteKey`（公開の状態の鍵 status・is_published・published_at などだけなら論理削除にしない）。
//   観察の印 `stateKeyPresent` の意味（状態の欄の語）は、型の digest に入るので変えない。
// - T39R-fix（Task 39 の設計書 7 章の T39R の行の M-4・M-5）: 手続きの呼び出しの path の判定は契約（`hasApiProcedureCallSegment`）へ移した。
//   `Prefer` に閉じた一覧の外の項目がある型と、本文が照合の上限を超えて読めない型は、`API_UPDATE`・`API_CREATE` に当たらず `UNRECOGNIZED`。
// - 型の digest は、版の印（`API_SHAPE_DIGEST_FORMAT`）つきの正規化した型（並びを並べ直す。要求の種類は入れない（T37b fix round 1）。ヘッダの名前はページが付けた名前だけを入れる（v2。Task 38 の設計書 7 章））の SHA-256（`createSha256Fingerprint`。鍵を並べた JSON は
//   `sortedKeysJsonOf`）。Task 38 の承認の digest は、候補の識別の digest とこの digest を結ぶ。
import {
  API_METHOD_OVERRIDE_HEADER_NAMES,
  // T38R-fix の M-2: ページが付けたヘッダの名前の正規化は、契約の 1 か所。
  pageHeaderNamesOf,
  // T39R-fix の M-4: 手続きの呼び出しの path の判定は、契約の 1 か所（書き込みの段の照合も使う）。
  hasApiProcedureCallSegment,
  API_PREFER_KNOWN_VALUES,
  API_SELECTION_QUERY_NAMES,
  API_UPSERT_PREFER_PREFIX,
  API_UPSERT_QUERY_NAMES,
  type ApiRequestFilterShape,
  type ApiRequestShape,
} from '../core/api-request-shape.js';
import { createSha256Fingerprint } from '../core/ids.js';
import { REDACTED } from '../core/redaction.js';
import { sortedKeysJsonOf } from '../core/sorted-keys-json.js';
import { compareCodeUnits } from '../core/text.js';
import { isMethodOverrideFieldName } from './candidate-contracts.js';
import { fieldNameHasStateWord, isApiSoftDeleteKeyName } from './classify.js';

/** 型の digest の版の印。正規化の形を変えるときは版を上げる。 */
export const API_SHAPE_DIGEST_FORMAT = 'beaksight:api-shape/2';

/** 分類の結果の閉じた一覧（probe の結果の `NOT_OBSERVED` は、probe の側が持つ）。 */
export const API_SHAPE_CLASSIFICATIONS = Object.freeze(['NO_REQUEST', 'NOT_EXECUTABLE', 'API_UPDATE', 'API_CREATE'] as const);
export type ApiShapeClassificationKind = (typeof API_SHAPE_CLASSIFICATIONS)[number];

/** 実行できない理由の閉じた一覧（設計書 3.3 の表の順）。 */
export const API_SHAPE_NOT_EXECUTABLE_REASONS = Object.freeze([
  'DELETE_METHOD',
  'PUT_METHOD',
  // T37R2-fix-A（M-2 (b)）: method を上書きするヘッダか、本文の最上位の鍵 `_method` がある。
  'METHOD_OVERRIDE',
  'UNAPPROVED_ORIGIN',
  'PROCEDURE_CALL_PATH',
  'UPSERT',
  'ARRAY_BODY',
  'NON_JSON_BODY',
  'MULTIPLE_REQUESTS',
  'SOFT_DELETE_KEY',
  // T37R-fix-A（I-3）: 本文の鍵が上限で切り詰められたか、伏せた鍵の名前がある（分類が見られない鍵が残る）。
  'SHAPE_TRUNCATED',
  'FILTER_MISSING',
  'FILTER_MULTIPLE',
  'FILTER_NOT_PAGE_VALUE',
  'UNRECOGNIZED',
] as const);
export type ApiShapeNotExecutableReason = (typeof API_SHAPE_NOT_EXECUTABLE_REASONS)[number];

/** 分類の入力（観察の結果のうち、型と、読み取りでない要求の数）。 */
export interface ApiShapeObservation {
  readonly shapes: readonly ApiRequestShape[];
  readonly nonReadRequestCount: number;
}

/** 分類の結果（理由は `NOT_EXECUTABLE` のときだけ。型と digest は、分類が見た型があるときだけ）。 */
export interface ApiShapeClassification {
  readonly classification: ApiShapeClassificationKind;
  readonly reason: ApiShapeNotExecutableReason | null;
  readonly shape: ApiRequestShape | null;
  readonly shapeDigest: string | null;
}

const METHOD_DELETE = 'DELETE';
const METHOD_PUT = 'PUT';
const METHOD_PATCH = 'PATCH';
const METHOD_POST = 'POST';

/** method を上書きするヘッダ（閉じた一覧。記録したヘッダの名前で見る）か、本文の最上位の鍵 `_method` があるか（T37R2-fix-A の M-2 (b)）。 */
const hasMethodOverride = (shape: ApiRequestShape): boolean =>
  shape.headerNames.some((name) => (API_METHOD_OVERRIDE_HEADER_NAMES as readonly string[]).includes(name.toLowerCase()))
  || shape.body.keys.some(({ name }) => isMethodOverrideFieldName(name));

/**
 * 分類が見られない所が残る型か（T37R-fix-A の I-3、T37R2-fix-A の M-2 (a)）: 本文の鍵が上限で切り詰められた、伏せた鍵の名前がある、path が長すぎて
 * 全体を伏せた、ヘッダの名前が上限で切り詰められた（method の上書きのヘッダを見落とさないため）。
 */
const hasTruncatedShape = (shape: ApiRequestShape): boolean =>
  shape.body.omittedKeyCount > 0
  || shape.body.keys.some(({ name }) => name === REDACTED)
  || shape.pathShape === REDACTED
  || shape.omittedHeaderNameCount > 0;

/**
 * DEF-147（設計書 `2026-10-21-beaksight-api-state-keys-design.md` 2 章）: 型が、論理削除にあたる鍵を持つか（型の分類と、API のシナリオの下書きの確かめが
 * 使う唯一の判定）。次のどれかなら真。
 * - 見える鍵の名前が、論理削除にあたる（`isApiSoftDeleteKeyName`。公開の状態の語にだけ当たる鍵は当たらない）。
 * - 型の作り手が伏せる前の名前で見た状態の鍵の印（`stateKeyPresent`。観察の口が `fieldNameHasStateWord` で見る。型の digest に入るので、意味は変えない）
 *   が立っているのに、見える鍵では説明できない（伏せた・切り詰めた鍵がある、か見える鍵に状態の欄の語がない）。どの鍵か分からないので止める側。
 */
export const apiShapeHasSoftDeleteKey = (shape: ApiRequestShape): boolean => {
  const { keys } = shape.body;
  if (keys.some(({ name }) => isApiSoftDeleteKeyName(name))) {
    return true;
  }
  return shape.body.stateKeyPresent === true && (hasTruncatedShape(shape) || !keys.some(({ name }) => fieldNameHasStateWord(name)));
};

/** 1 つの型に当てる、`MULTIPLE_REQUESTS` より上の行（表の順）。 */
const SINGLE_SHAPE_RULES: readonly (readonly [ApiShapeNotExecutableReason, (shape: ApiRequestShape) => boolean])[] = Object.freeze([
  ['DELETE_METHOD', (shape) => shape.method === METHOD_DELETE],
  ['PUT_METHOD', (shape) => shape.method === METHOD_PUT],
  ['METHOD_OVERRIDE', (shape) => hasMethodOverride(shape)],
  ['UNAPPROVED_ORIGIN', (shape) => shape.origin.kind !== 'APPROVED_API'],
  ['PROCEDURE_CALL_PATH', (shape) => hasApiProcedureCallSegment(shape.pathShape)],
  ['UPSERT', (shape) => shape.prefer.some((value) => value.startsWith(API_UPSERT_PREFER_PREFIX))
    || shape.queryNames.some((name) => (API_UPSERT_QUERY_NAMES as readonly string[]).includes(name))],
  ['ARRAY_BODY', (shape) => shape.body.kind === 'ARRAY'],
  ['NON_JSON_BODY', (shape) => shape.body.kind === 'NOT_JSON'],
]);

/**
 * `Prefer` の項目が、閉じた一覧の値（`API_PREFER_KNOWN_VALUES`）だけか（T39R-fix の M-5）。一覧の外の項目（`other`・`return=other`）を持つ型は、
 * 書き込みの段の照合（承認の期待は閉じた一覧の値だけ）が通さないので、実行できるとしない（`UNRECOGNIZED`）。
 */
const onlyKnownPreferItems = (shape: ApiRequestShape): boolean =>
  shape.prefer.every((value) => (API_PREFER_KNOWN_VALUES as readonly string[]).includes(value));

/** query の名前が、閉じた一覧（`select`）だけか（`except` の filter の名前を 1 つ除く）。 */
const onlySelectionQueryNames = (shape: ApiRequestShape, except: ApiRequestFilterShape | null): boolean => {
  if (shape.omittedQueryNameCount > 0) {
    return false;
  }
  let skipped = except === null;
  return shape.queryNames.every((name) => {
    if (!skipped && except !== null && name === except.name) {
      skipped = true;
      return true;
    }
    return (API_SELECTION_QUERY_NAMES as readonly string[]).includes(name);
  });
};

const result = (
  classification: ApiShapeClassificationKind,
  reason: ApiShapeNotExecutableReason | null,
  shape: ApiRequestShape | null,
): ApiShapeClassification => Object.freeze({ classification, reason, shape, shapeDigest: shape === null ? null : apiShapeDigestOf(shape) });

/** 観察した型を分類する（純粋。入力を変えない）。 */
export const classifyApiShapeObservation = (observation: ApiShapeObservation): ApiShapeClassification => {
  const { shapes, nonReadRequestCount } = observation;
  if (nonReadRequestCount <= 0 && shapes.length === 0) {
    return result('NO_REQUEST', null, null);
  }
  for (const [reason, matches] of SINGLE_SHAPE_RULES) {
    const shape = shapes.find(matches);
    if (shape !== undefined) {
      return result('NOT_EXECUTABLE', reason, shape);
    }
  }
  const [shape] = shapes;
  if (Math.max(nonReadRequestCount, shapes.length) >= 2) {
    return result('NOT_EXECUTABLE', 'MULTIPLE_REQUESTS', shape ?? null);
  }
  if (shape === undefined) {
    return result('NOT_EXECUTABLE', 'UNRECOGNIZED', null);
  }
  // T37R-fix-A（I-3）: 論理削除の鍵は、型の作り手が伏せる前の名前で見た真偽と、残った名前の両方で見る。DEF-147: 公開の状態の鍵だけなら論理削除にしない
  // （`apiShapeHasSoftDeleteKey`）。
  if (apiShapeHasSoftDeleteKey(shape)) {
    return result('NOT_EXECUTABLE', 'SOFT_DELETE_KEY', shape);
  }
  if (hasTruncatedShape(shape)) {
    return result('NOT_EXECUTABLE', 'SHAPE_TRUNCATED', shape);
  }
  // T39R-fix（M-5）: 本文は、照合と同じ上限（`MAX_API_REQUEST_BODY_BYTES`）の中で読めた object だけ（超えた本文は「読めない」）。`Prefer` は閉じた一覧の値だけ。
  const executableForm = shape.body.kind === 'OBJECT' && onlyKnownPreferItems(shape);
  if (shape.method === METHOD_PATCH) {
    const [filter, ...rest] = shape.filters;
    if (filter === undefined) return result('NOT_EXECUTABLE', 'FILTER_MISSING', shape);
    if (rest.length > 0) return result('NOT_EXECUTABLE', 'FILTER_MULTIPLE', shape);
    if (filter.operator !== 'eq' || !filter.valueMatchesPagePath) return result('NOT_EXECUTABLE', 'FILTER_NOT_PAGE_VALUE', shape);
    if (executableForm && onlySelectionQueryNames(shape, filter)) return result('API_UPDATE', null, shape);
  }
  if (shape.method === METHOD_POST && shape.filters.length === 0 && executableForm && onlySelectionQueryNames(shape, null)) {
    return result('API_CREATE', null, shape);
  }
  return result('NOT_EXECUTABLE', 'UNRECOGNIZED', shape);
};

/** 並べた写し。 */
const sortedBy = <T>(values: readonly T[], compare: (left: T, right: T) => number): T[] => {
  const copy = [...values];
  copy.sort(compare);
  return copy;
};

/**
 * digest に入れる型の項目（T37b fix round 1。設計書 8 章の履歴の (2)）。要求の種類（`fetch`・`xhr`）とヘッダの名前の一覧（と、その超えた数）は、
 * 型には記録する（画面に出す）が、Chromium の伝え方と Chromium が足すヘッダで変わるので、そのままは digest に入れない。
 * 型の digest v2（Task 38 の設計書 7 章の最後の行）: ヘッダの名前のうち、ページが付けた名前（`isPageSuppliedHeaderName` を通した、小文字で並べた
 * 集合 `pageHeaderNames`）だけを入れる。ブラウザが付ける名前は入れない（Chromium の更新で変わらない）。ページが付けるヘッダが変われば型が変わり、
 * 承認の有効性で `CANDIDATE_SHAPE_CHANGED` になる。
 */
type ApiShapeDigestInput = Omit<ApiRequestShape, 'resourceType' | 'headerNames' | 'omittedHeaderNameCount'> & {
  readonly pageHeaderNames: readonly string[];
};

/** digest に入れる項目を取り出し、正規化する（並びを並べ直す）。 */
const normalizedShapeOf = (shape: ApiRequestShape): ApiShapeDigestInput => ({
  method: shape.method,
  pageHeaderNames: pageHeaderNamesOf(shape.headerNames),
  origin: shape.origin,
  pathShape: shape.pathShape,
  queryNames: sortedBy(shape.queryNames, compareCodeUnits),
  omittedQueryNameCount: shape.omittedQueryNameCount,
  filters: sortedBy(shape.filters, (left, right) => compareCodeUnits(left.name, right.name) || compareCodeUnits(left.operator, right.operator)
    || Number(left.valueMatchesPagePath) - Number(right.valueMatchesPagePath)),
  contentType: shape.contentType,
  prefer: sortedBy(shape.prefer, compareCodeUnits),
  body: {
    kind: shape.body.kind,
    keys: sortedBy(shape.body.keys, (left, right) => compareCodeUnits(left.name, right.name) || compareCodeUnits(left.type, right.type)),
    omittedKeyCount: shape.body.omittedKeyCount,
    markerKeys: sortedBy(
      shape.body.markerKeys.map(({ key, markers }) => ({ key, markers: sortedBy(markers, (left, right) => left - right) })),
      (left, right) => compareCodeUnits(left.key, right.key) || compareCodeUnits(left.markers.join(','), right.markers.join(',')),
    ),
    // T37R-fix-A（I-3）: 論理削除の鍵の真偽も、鍵の名前と同じく型の一部として digest に入れる。
    stateKeyPresent: shape.body.stateKeyPresent === true,
  },
});

/**
 * 型の digest（`sha256:<16 進 64 桁>`。版の印つきの、digest に入れる項目（method、Origin の区分と番号、path の型、query の名前、filter の形、
 * ページが付けたヘッダの名前の集合（v2）、`Content-Type` の媒体の型、`Prefer` の値、本文の最上位の形、鍵の名前と JSON の型、鍵と欄の対応）を
 * 正規化したものの SHA-256）。
 */
export const apiShapeDigestOf = (shape: ApiRequestShape): string =>
  createSha256Fingerprint(sortedKeysJsonOf({ format: API_SHAPE_DIGEST_FORMAT, shape: normalizedShapeOf(shape) }));
