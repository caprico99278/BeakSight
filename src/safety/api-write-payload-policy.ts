/**
 * 書き込みの段の、承認した API の要求の照合（T39a。Task 39 の設計書 `2026-10-17-beaksight-task-39-api-write-guard-design.md` 3.2、4 章）。純粋な関数で、
 * Guard が CDP の `Fetch.requestPaused`（サブリソースの Request の段階）の事実を渡して呼ぶ（Guard の組み込みは T39b）。form の照合
 * （`write-payload-policy.ts`）と同じ形で、JSON の本文を読むのは、このファイルだけ。
 *
 * 判定（`checkApiWritePayload`。上から順に調べ、最初に当たった理由を返す）:
 * - 承認した API の指定・生成した値・台帳の ID（`ApiWritePayloadExpectation`）が正しくなければ `EXPECTATION_INVALID`（fail-closed）: method が
 *   `API_WRITE_METHODS` でない、CREATE（`POST`）に filter・台帳の ID がある、UPDATE（`PATCH`）に filter・台帳の ID がない、Origin が Origin の形でない、
 *   path の型が `/` で始まらないか伏せた区切り（`REDACTED`）・query・fragment を含む、query の名前が `select` のほか、`Prefer` が閉じた一覧
 *   （`API_PREFER_KNOWN_VALUES`）のほか、鍵の重なり・空の鍵・method の上書きの鍵、鍵の型が JSON の値の型（string・number・boolean・null）でない、
 *   ページが決める鍵の名前が秘密に見える（`isSecretUrlQueryParameterName`。承認と同じ方針）、ヘッダの名前が小文字でないか method の上書きの名前、
 *   欄の鍵の生成した値がないか、鍵の型に変えられない（`jsonValueOf`）。T39R-fix（M-4。I21）: `Prefer` に upsert の印（`resolution=`）がある、path に
 *   手続きの呼び出しの区切りがある（分類と同じ契約の部品 `hasApiProcedureCallSegment`）。`Prefer` の項目の分け方と `Content-Type` の媒体の型の
 *   取り出し、本文の上限は、型の作り手と同じ契約（`src/core/api-request-shape.ts`）の 1 か所（M-5）。
 * - `METHOD_MISMATCH`: method が承認の method と書かれたままの形で一致しない（`PUT`、CREATE への `PATCH`、小文字の `patch` を含む）。
 * - `METHOD_OVERRIDE_PRESENT`: method を上書きするヘッダ（`API_METHOD_OVERRIDE_HEADER_NAMES`）がある。本文の最上位の鍵 `_method`
 *   （`isMethodOverrideFieldName`）は、本文を読んだ後に同じ理由で止める。
 * - `ENDPOINT_MISMATCH`: Origin と path が承認の型と完全に一致しない（要求の判定の owner の `isApiWriteEndpointUrl`。認証情報を含む URL も）。
 * - `QUERY_MISMATCH`: query の名前の集合が、承認の名前（`select`）と UPDATE の filter の名前の集合と一致しない（足りない、多い、同じ名前が 2 回、
 *   upsert の印 `on_conflict`）。`select` の値は照らさない（取り出す列の指定）。
 * - `FILTER_MISMATCH`: UPDATE の filter の値が `eq.<台帳の ID>` と完全に一致しない（`neq`・`in` などの演算子、値の書き換え）。
 * - `HEADER_NOT_ALLOWED`: ページが付けたヘッダの名前（ブラウザが付ける名前 `isPageSuppliedHeaderName` を除いた、小文字の名前）が、承認した名前の
 *   集合の中にない。
 * - `CONTENT_TYPE_MISMATCH`: `Content-Type` の媒体の型（小文字）が承認と一致しない、ない、引数が `charset=utf-8` のほか。
 * - `PREFER_MISMATCH`: `Prefer` の項目（小文字、`,` で区切る）が閉じた一覧の値でない（upsert の `resolution=` を含む）か、項目の集合が承認と一致しない。
 * - 本文: `BODY_UNAVAILABLE`（bytes がない）、`BODY_TOO_LARGE`（`MAX_API_WRITE_BODY_BYTES` を超える。decode する前に長さで調べる）、
 *   `BODY_MALFORMED`（UTF-8 でない、BOM、JSON でない）、`BODY_NOT_OBJECT`（最上位が object でない）、`BODY_DUPLICATE_KEY`（同じ鍵が 2 回。escape の
 *   違う書き方も同じ鍵）、`BODY_VALUE_NOT_SCALAR`（値が array か object。I21）、`BODY_KEY_UNEXPECTED`・`BODY_KEY_MISSING`（鍵の集合が、欄の鍵と
 *   ページが決める鍵の集合と完全に一致しない）、`BODY_VALUE_TYPE_MISMATCH`（値の JSON の型が承認の型と違う）、`BODY_VALUE_MISMATCH`（欄の鍵の値が、
 *   生成した値を `jsonValueOf` で変えたものと一致しない。number は正規の JSON の表記（`JSON.stringify`）と、本文の書かれたままの表記を比べるので、
 *   `42.0`・`4.2e1`・`-0` は止まる。string は escape を解いた値で比べる）。
 * T41c（Task 41 の設計書 3.3。API の更新）: 期待の `keptKeys`（保つ鍵と前の値）と `pageKeyPriorValues`（UPDATE のページが決める鍵の前の値）。保つ鍵は
 * 本文にあれば前の値と、UPDATE のページが決める鍵は必ず前の値と、欄の鍵と同じ比べ方で照らす（違えば `BODY_VALUE_TYPE_MISMATCH`・`BODY_VALUE_MISMATCH`）。
 * 保つ鍵が本文になくても通す。承認の鍵の集合の外の状態の語の鍵は `BODY_STATE_KEY_UNEXPECTED`（`BODY_KEY_UNEXPECTED` より先）。UPDATE の結果の
 * `pageKeyValues` は空（値は前の値と同じなので、前の値を記録に残さない）。前の値は、結果にも例外の文にも残さない。
 * 一致したら `ALLOW` と、ページが決める鍵の値（鍵ごとの JSON の値。Task 38 の判断 (1)。書き込みの結果の記録に残すもの）を返す。それ以外の値（生成した値、
 * ヘッダの値、query の値、台帳の ID）は、結果にも例外の文にも残さない。どの入力でも投げない（予期しない例外は `EXPECTATION_INVALID`）。
 */
import {
  API_CONTENT_TYPE_HEADER_NAME,
  API_FILTER_OPERATOR_SEPARATOR,
  API_METHOD_OVERRIDE_HEADER_NAMES,
  API_PREFER_HEADER_NAME,
  API_PREFER_KNOWN_VALUES,
  API_SELECTION_QUERY_NAMES,
  API_UPSERT_PREFER_PREFIX,
  API_UPSERT_QUERY_NAMES,
  API_WRITE_METHODS,
  MAX_API_REQUEST_BODY_BYTES,
  apiContentTypePartsOf,
  apiPreferItemsOf,
  hasApiProcedureCallSegment,
  isPageSuppliedHeaderName,
  type ApiJsonValueType,
  type ApiPreferShape,
} from '../core/api-request-shape.js';
import { isRecord } from '../core/guards.js';
import { jsonValueOf } from '../core/json-value.js';
import { REDACTED } from '../core/redaction.js';
import { isSecretUrlQueryParameterName } from '../core/secret-query-names.js';
import { canonicalHttpOriginOf } from '../crawl/normalize-url.js';
import { isMethodOverrideFieldName } from '../discovery/candidate-contracts.js';
import { fieldNameHasStateWord } from '../discovery/classify.js';
import { isApiWriteEndpointUrl } from './request-policy.js';
import { WRITE_PAYLOAD_BLOCK_REASONS, type WritePayloadBlockReason } from './write-payload-policy.js';

/**
 * 本文の大きさの上限（bytes）。超えたら decode せずに止める。T39R-fix の M-5: 型の作り手と同じ値（`MAX_API_REQUEST_BODY_BYTES`。超えた本文の型は、
 * 分類で実行できない）。
 */
export const MAX_API_WRITE_BODY_BYTES = MAX_API_REQUEST_BODY_BYTES;

/** 照合の結果（閉じた一覧）。`ALLOW` のほかは止めた理由（判定の順）。 */
export const API_WRITE_PAYLOAD_DECISIONS = Object.freeze([
  'ALLOW',
  'EXPECTATION_INVALID',
  'METHOD_MISMATCH',
  'METHOD_OVERRIDE_PRESENT',
  'ENDPOINT_MISMATCH',
  'QUERY_MISMATCH',
  'FILTER_MISMATCH',
  'HEADER_NOT_ALLOWED',
  'CONTENT_TYPE_MISMATCH',
  'PREFER_MISMATCH',
  'BODY_UNAVAILABLE',
  'BODY_TOO_LARGE',
  'BODY_MALFORMED',
  'BODY_NOT_OBJECT',
  'BODY_DUPLICATE_KEY',
  'BODY_VALUE_NOT_SCALAR',
  'BODY_KEY_MISSING',
  'BODY_KEY_UNEXPECTED',
  'BODY_VALUE_TYPE_MISMATCH',
  'BODY_VALUE_MISMATCH',
  // T41c（Task 41 の設計書 3.3）: 承認の鍵の集合（変える鍵・保つ鍵・ページが決める鍵）の外の、状態の語の鍵（重ねの守り。理由を分けて記録する）。
  'BODY_STATE_KEY_UNEXPECTED',
] as const);
export type ApiWritePayloadDecision = (typeof API_WRITE_PAYLOAD_DECISIONS)[number];
/** 止めた理由（`ALLOW` を除く）。 */
export type ApiWritePayloadBlockReason = Exclude<ApiWritePayloadDecision, 'ALLOW'>;
export const API_WRITE_PAYLOAD_BLOCK_REASONS = Object.freeze(
  API_WRITE_PAYLOAD_DECISIONS.filter((decision): decision is ApiWritePayloadBlockReason => decision !== 'ALLOW'),
);

/** 書き込みの段の送る中身の照合の理由（form の照合と API の照合）。 */
export type WriteStagePayloadBlockReason = WritePayloadBlockReason | ApiWritePayloadBlockReason;
/**
 * Guard の要約の送る中身の照合の理由の鍵（`ActionGuardSummary.blockedByPayloadReason`。Schema `action-evidence` の
 * `guardSummary.blockedByPayloadReason` の鍵の一覧）。form の照合の理由の後に、API の照合の理由のうち form の一覧にないものを足す（同じ名前の理由は
 * 同じ意味で 1 つの鍵）。
 */
export const WRITE_STAGE_PAYLOAD_BLOCK_REASONS: readonly WriteStagePayloadBlockReason[] = Object.freeze([
  ...WRITE_PAYLOAD_BLOCK_REASONS,
  ...API_WRITE_PAYLOAD_BLOCK_REASONS.filter((reason) => !(WRITE_PAYLOAD_BLOCK_REASONS as readonly string[]).includes(reason)),
]);

/** JSON の値（object・array を除く）。 */
export type ApiJsonScalarValue = string | number | boolean | null;

/**
 * 照合が照らす、承認した API の指定の項目（シナリオの API の指定 `ScenarioApiSpec`（`src/control/approval/scenario-contracts.ts`）の部分の形）。
 * `src/safety/` は `src/control/` を import できない（Gate `control-boundary` の (a)）ので、型は呼び出し側から構造で受ける。`ScenarioApiSpec` がこの形に
 * 当てはまることは `tests/unit/api-write-payload-policy.test.ts` の型の確かめが見る（形が離れたら型の確かめで気づく）。
 */
export interface ApiWriteCheckSpec {
  readonly request: {
    readonly method: string;
    readonly origin: string;
    readonly pathShape: string;
    readonly queryNames: readonly string[];
    readonly contentType: string | null;
    readonly prefer: readonly ApiPreferShape[];
  };
  /** 欄の鍵（鍵と JSON の型。欄の識別は照らさない）。 */
  readonly keyFields: readonly { readonly key: string; readonly type: ApiJsonValueType }[];
  /** ページが決める鍵（鍵と JSON の型。値は照らさず、返す）。 */
  readonly pageKeys: readonly { readonly key: string; readonly type: ApiJsonValueType }[];
  /** 許すヘッダの名前（ページが付ける名前だけ。小文字）。 */
  readonly headerNames: readonly string[];
  /** UPDATE の filter の名前（CREATE は null）。 */
  readonly filterName: string | null;
}

/**
 * T41c（Task 41 の設計書 3.3）: 更新の、ワーカーが送る前に画面から読んだ鍵の値（前の値。JSON の scalar に変えた形）。照合の期待としてメモリの中だけで
 * 渡し、記録しない（結果にも誤りの文にも入れない）。
 */
export interface ApiWritePriorValue {
  readonly key: string;
  readonly value: ApiJsonScalarValue;
}

/** 照合の期待（承認した API の指定のうち照らす項目、生成した値、台帳の ID、更新の前の値）。 */
export interface ApiWritePayloadExpectation {
  readonly spec: ApiWriteCheckSpec;
  /** 欄の鍵ごとの生成した値（null は値を作らない）。欄の鍵のほかの項目は見ない。 */
  readonly values: Readonly<Record<string, string | null>>;
  /** UPDATE の台帳の ID（CREATE は null）。 */
  readonly recordId: string | null;
  /**
   * T41c: UPDATE の保つ鍵と前の値（シナリオの API の指定の `keptKeys` の鍵ごとに 1 つ）。本文にあれば前の値と完全一致を求め、なければ通す（ユーザーの
   * 判断 1）。変える鍵（`spec.keyFields`）・ページが決める鍵と重なれば期待の誤り。CREATE は省くか空（ほかは期待の誤り）。省いた UPDATE は保つ鍵なし。
   */
  readonly keptKeys?: readonly ApiWritePriorValue[] | undefined;
  /**
   * T41c: UPDATE のページが決める鍵（`spec.pageKeys`）ごとの前の値（欄から読んだ値。すべての鍵にちょうど 1 つ、宣言の型と同じ JSON の型）。本文の値は
   * 前の値と完全一致を求める（ユーザーの判断 2）。前の値のない鍵があれば期待の誤り。CREATE は省くか空（ほかは期待の誤り。値を照らさずに返す）。
   */
  readonly pageKeyPriorValues?: readonly ApiWritePriorValue[] | undefined;
}

/** 一時停止した要求の事実。 */
export interface ApiWriteRequestFacts {
  readonly method: string;
  readonly url: string;
  /** 要求のヘッダ（名前は大文字と小文字を問わない）。 */
  readonly headers: Readonly<Record<string, string>>;
  /** 本文の bytes（なければ、または読み切れなければ null）。 */
  readonly body: Uint8Array | null;
}

/** 照合の結果（一致ならページが決める鍵の値。止めたなら理由だけ）。 */
export type ApiWritePayloadCheck =
  | { readonly decision: 'ALLOW'; readonly pageKeyValues: Readonly<Record<string, ApiJsonScalarValue>> }
  | { readonly decision: ApiWritePayloadBlockReason };

/** 変えられる JSON の型（object・array は承認しない）。 */
const SCALAR_TYPES: readonly ApiJsonValueType[] = Object.freeze(['string', 'number', 'boolean', 'null']);
/** UPDATE の filter の演算子（`<名前>=eq.<台帳の ID>`）。 */
const FILTER_EQUALS_OPERATOR = 'eq';
/** `Content-Type` で許す引数（`charset=utf-8`。大文字と小文字を問わない。引用符で囲んでもよい）。 */
const CHARSET_PARAMETER_NAME = 'charset';
const UTF8_CHARSET = 'utf-8';
const PARAMETER_VALUE_SEPARATOR = '=';
/** 同じ名前のヘッダの値をつなぐ区切り（HTTP の一覧の書き方）。 */
const HEADER_VALUE_LIST_SEPARATOR = ',';
const PATH_SEPARATOR = '/';

/** 期待の欄の鍵 1 つ（照らす型と、照らす値の表記）。 */
interface ExpectedKeyField {
  readonly type: ApiJsonValueType;
  /** string なら値そのもの、ほかの型なら JSON の表記。 */
  readonly text: string;
}

/** 確かめた期待。 */
interface AcceptedExpectation {
  readonly method: string;
  readonly origin: string;
  readonly path: string;
  readonly queryNames: readonly string[];
  readonly filterName: string | null;
  readonly recordId: string | null;
  readonly contentType: string | null;
  readonly prefer: ReadonlySet<string>;
  readonly headerNames: ReadonlySet<string>;
  readonly keyFields: ReadonlyMap<string, ExpectedKeyField>;
  readonly pageKeys: ReadonlyMap<string, ApiJsonValueType>;
  /** T41c: 保つ鍵ごとの前の値の照らす形（本文にあれば完全一致。なければ通す）。CREATE は空。 */
  readonly keptKeys: ReadonlyMap<string, ExpectedKeyField>;
  /** T41c: UPDATE のページが決める鍵ごとの前の値の照らす形（完全一致）。CREATE は空（値を照らさずに返す）。 */
  readonly pageKeyPriors: ReadonlyMap<string, ExpectedKeyField>;
}

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isScalarType = (value: unknown): value is ApiJsonValueType => (SCALAR_TYPES as readonly unknown[]).includes(value);
const hasDuplicates = (values: readonly string[]): boolean => new Set(values).size !== values.length;

/** Origin の正規の直列化か（URL の意味の owner の `canonicalHttpOriginOf`。path・認証情報・既定のポートの書き方などを含まない）。 */
const isOriginText = (text: string): boolean => canonicalHttpOriginOf(text) !== undefined;

/** path の型か（`/` で始まり、`//` で始まらず、伏せた区切り・query・fragment を含まない）。 */
const isPathShape = (path: unknown): path is string => typeof path === 'string'
  && path.startsWith(PATH_SEPARATOR) && !path.startsWith(`${PATH_SEPARATOR}${PATH_SEPARATOR}`)
  && !path.includes('?') && !path.includes('#') && !path.includes(REDACTED);

/** 欄の鍵の生成した値の、照らす表記（変えられなければ null）。 */
const expectedKeyFieldOf = (value: unknown, type: ApiJsonValueType): ExpectedKeyField | null => {
  if (value !== null && typeof value !== 'string') {
    return null;
  }
  const converted = jsonValueOf(value, type);
  if (!converted.ok) {
    return null;
  }
  return { type, text: typeof converted.value === 'string' ? converted.value : JSON.stringify(converted.value) };
};

/** JSON の scalar の値の型（scalar でない値と、有限でない数は null）。 */
const scalarTypeOf = (value: unknown): ApiJsonValueType | null => {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'boolean':
      return 'boolean';
    case 'number':
      return Number.isFinite(value) ? 'number' : null;
    default:
      return null;
  }
};

/**
 * T41c: 更新の前の値の一覧を確かめ、鍵ごとの照らす形にする（省けば空。一覧でない、鍵が空・重なる・method の上書きの鍵、値が JSON の scalar でなければ
 * null）。照らす形は欄の鍵の生成した値と同じ（string は値そのもの、ほかの型は正規の JSON の表記）。
 */
const priorValuesOf = (list: unknown): ReadonlyMap<string, ExpectedKeyField> | null => {
  if (list === undefined) {
    return new Map();
  }
  if (!Array.isArray(list)) {
    return null;
  }
  const priors = new Map<string, ExpectedKeyField>();
  for (const entry of list as readonly unknown[]) {
    if (!isRecord(entry) || !isNonEmptyString(entry.key) || isMethodOverrideFieldName(entry.key) || priors.has(entry.key) || !Object.hasOwn(entry, 'value')) {
      return null;
    }
    const type = scalarTypeOf(entry.value);
    if (type === null) {
      return null;
    }
    priors.set(entry.key, { type, text: typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value) });
  }
  return priors;
};

/** 期待を確かめる（正しくなければ null）。 */
const acceptedExpectationOf = (expectation: unknown): AcceptedExpectation | null => {
  if (!isRecord(expectation) || !isRecord(expectation.spec) || !isRecord(expectation.values)) {
    return null;
  }
  const { spec, values, recordId, keptKeys: keptKeyList, pageKeyPriorValues } = expectation as unknown as ApiWritePayloadExpectation;
  const { request } = spec;
  if (!isRecord(request) || !(API_WRITE_METHODS as readonly unknown[]).includes(request.method)) {
    return null;
  }
  const isUpdate = request.method === 'PATCH';
  const filterName = spec.filterName;
  if (isUpdate ? !isNonEmptyString(filterName) || !isNonEmptyString(recordId) : filterName !== null || recordId !== null) {
    return null;
  }
  const approvedOrigin: unknown = request.origin;
  // T39R-fix（M-4）: 手続きの呼び出しの path は、分類と同じ部品（decode と大文字・小文字の畳み込み）で見て、期待の誤りにする（I21）。
  if (typeof approvedOrigin !== 'string' || !isOriginText(approvedOrigin) || !isPathShape(request.pathShape)
    || hasApiProcedureCallSegment(request.pathShape)) {
    return null;
  }
  const queryNames = request.queryNames as unknown;
  if (!Array.isArray(queryNames) || !queryNames.every((name) => (API_SELECTION_QUERY_NAMES as readonly unknown[]).includes(name))
    || hasDuplicates(queryNames as string[])) {
    return null;
  }
  if (isUpdate && ([...API_SELECTION_QUERY_NAMES, ...API_UPSERT_QUERY_NAMES] as readonly unknown[]).includes(filterName)) {
    return null;
  }
  const prefer = request.prefer as unknown;
  // T39R-fix（M-4）: upsert の印（`resolution=`）の項目は、閉じた一覧の値でも期待の誤り（I21）。
  if (!Array.isArray(prefer) || !prefer.every((item) => (API_PREFER_KNOWN_VALUES as readonly unknown[]).includes(item)
    && !(item as string).startsWith(API_UPSERT_PREFER_PREFIX))) {
    return null;
  }
  if (request.contentType !== null && !isNonEmptyString(request.contentType)) {
    return null;
  }
  const headerNames = spec.headerNames as unknown;
  if (!Array.isArray(headerNames) || !headerNames.every((name) => isNonEmptyString(name) && name === name.toLowerCase()
    && !(API_METHOD_OVERRIDE_HEADER_NAMES as readonly string[]).includes(name))) {
    return null;
  }
  const keyFieldList = spec.keyFields as unknown;
  const pageKeyList = spec.pageKeys as unknown;
  if (!Array.isArray(keyFieldList) || !Array.isArray(pageKeyList)) {
    return null;
  }
  const keyFields = new Map<string, ExpectedKeyField>();
  const pageKeys = new Map<string, ApiJsonValueType>();
  const usableKey = (entry: unknown): entry is { readonly key: string; readonly type: ApiJsonValueType } => isRecord(entry)
    && isNonEmptyString(entry.key) && isScalarType(entry.type) && !isMethodOverrideFieldName(entry.key)
    && !keyFields.has(entry.key) && !pageKeys.has(entry.key);
  for (const entry of keyFieldList) {
    if (!usableKey(entry) || !Object.hasOwn(values, entry.key)) {
      return null;
    }
    const expected = expectedKeyFieldOf(values[entry.key], entry.type);
    if (expected === null) {
      return null;
    }
    keyFields.set(entry.key, expected);
  }
  for (const entry of pageKeyList) {
    if (!usableKey(entry) || isSecretUrlQueryParameterName(entry.key)) {
      return null;
    }
    pageKeys.set(entry.key, entry.type);
  }
  // T41c: 更新の前の値（保つ鍵、ページが決める鍵）。CREATE は持たない。保つ鍵は変える鍵・ページが決める鍵と重ならない。UPDATE のページが決める鍵は、
  // すべてに宣言の型と同じ型の前の値が要る（ユーザーの判断 2）。
  const keptKeys = priorValuesOf(keptKeyList);
  const pageKeyPriors = priorValuesOf(pageKeyPriorValues);
  if (keptKeys === null || pageKeyPriors === null || (!isUpdate && (keptKeys.size > 0 || pageKeyPriors.size > 0))
    || [...keptKeys.keys()].some((key) => keyFields.has(key) || pageKeys.has(key))
    || (isUpdate && (pageKeyPriors.size !== pageKeys.size || [...pageKeys].some(([key, type]) => pageKeyPriors.get(key)?.type !== type)))) {
    return null;
  }
  return {
    method: request.method,
    origin: approvedOrigin,
    path: request.pathShape,
    queryNames: isUpdate ? [...queryNames as string[], filterName as string] : [...queryNames as string[]],
    filterName: isUpdate ? filterName : null,
    recordId: isUpdate ? recordId : null,
    contentType: request.contentType === null ? null : request.contentType.toLowerCase(),
    prefer: new Set(prefer as string[]),
    headerNames: new Set(headerNames as string[]),
    keyFields,
    pageKeys,
    keptKeys,
    pageKeyPriors,
  };
};

/** ヘッダの名前（小文字）と値の一覧（形が違えば空）。 */
const headerEntriesOf = (headers: unknown): readonly (readonly [string, string])[] => (isRecord(headers)
  ? Object.entries(headers).flatMap(([name, value]) => (typeof value === 'string' ? [[name.toLowerCase(), value] as const] : []))
  : []);

/** `Content-Type` の値が、承認の媒体の型と一致するか（引数は `charset=utf-8` だけ許す）。 */
const contentTypeMatches = (value: string | undefined, expected: string | null): boolean => {
  if (expected === null || value === undefined) {
    return expected === null && value === undefined;
  }
  // T39R-fix（M-5）: 媒体の型と引数の分け方は、型の作り手と同じ契約の関数。
  const { mediaType, parameters } = apiContentTypePartsOf(value);
  if (mediaType !== expected) {
    return false;
  }
  return parameters.every((parameter) => {
    const separator = parameter.indexOf(PARAMETER_VALUE_SEPARATOR);
    const name = (separator < 0 ? parameter : parameter.slice(0, separator)).trim().toLowerCase();
    const raw = separator < 0 ? '' : parameter.slice(separator + PARAMETER_VALUE_SEPARATOR.length).trim().toLowerCase();
    const unquoted = raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    return name === CHARSET_PARAMETER_NAME && unquoted === UTF8_CHARSET;
  }) && parameters.length <= 1;
};

/** `Prefer` の項目の集合が、承認の集合と一致するか（項目は閉じた一覧の値だけ）。 */
const preferMatches = (value: string | undefined, expected: ReadonlySet<string>): boolean => {
  // T39R-fix（M-5）: 項目の分け方は、型の作り手と同じ契約の関数。
  const items = apiPreferItemsOf(value ?? '');
  if (!items.every((item) => (API_PREFER_KNOWN_VALUES as readonly string[]).includes(item))) {
    return false;
  }
  const actual = new Set(items);
  return actual.size === expected.size && [...actual].every((item) => expected.has(item));
};

/** 本文の最上位の鍵 1 つ（escape を解いた鍵、値の JSON の型、書かれたままの表記、値）。 */
interface BodyEntry {
  readonly key: string;
  readonly type: ApiJsonValueType;
  readonly raw: string;
  readonly value: ApiJsonScalarValue;
}

type BodyScan =
  | { readonly ok: true; readonly entries: readonly BodyEntry[] }
  | { readonly ok: false; readonly reason: ApiWritePayloadBlockReason };

const JSON_WHITE_SPACE = /[ \t\n\r]*/uy;
const JSON_NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/uy;
const JSON_LITERALS: ReadonlyMap<string, ApiJsonScalarValue> = new Map<string, ApiJsonScalarValue>([['true', true], ['false', false], ['null', null]]);

/** 正しい JSON の文字列の、`start`（`"`）からの文字列の表記の終わり（閉じる `"` の次の位置）。 */
const endOfJsonString = (text: string, start: number): number => {
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') {
      index += 2;
    } else if (char === '"') {
      return index + 1;
    } else {
      index += 1;
    }
  }
  return -1;
};

/**
 * 本文を読む（メモリの中で 1 回だけ。値は返す鍵の中にだけ持つ）。UTF-8 として読めない、BOM、JSON でない、最上位が object でない、同じ鍵が 2 回、値が
 * array か object なら、その理由を返す。JSON として正しいことを `JSON.parse` で確かめてから、最上位の object の鍵と値の書かれたままの表記を順に読む。
 */
const scanBody = (bytes: Uint8Array): BodyScan => {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { ok: false, reason: 'BODY_MALFORMED' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'BODY_MALFORMED' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'BODY_NOT_OBJECT' };
  }
  const skip = (index: number): number => {
    JSON_WHITE_SPACE.lastIndex = index;
    JSON_WHITE_SPACE.exec(text);
    return JSON_WHITE_SPACE.lastIndex;
  };
  const malformed: BodyScan = { ok: false, reason: 'BODY_MALFORMED' };
  const entries: BodyEntry[] = [];
  const seen = new Set<string>();
  let index = skip(0) + 1;
  index = skip(index);
  if (text[index] === '}') {
    return { ok: true, entries };
  }
  for (;;) {
    if (text[index] !== '"') return malformed;
    const keyEnd = endOfJsonString(text, index);
    if (keyEnd < 0) return malformed;
    const key = JSON.parse(text.slice(index, keyEnd)) as string;
    if (seen.has(key)) {
      return { ok: false, reason: 'BODY_DUPLICATE_KEY' };
    }
    seen.add(key);
    index = skip(keyEnd);
    if (text[index] !== ':') return malformed;
    index = skip(index + 1);
    const first = text[index];
    if (first === '{' || first === '[') {
      return { ok: false, reason: 'BODY_VALUE_NOT_SCALAR' };
    }
    let raw: string;
    let type: ApiJsonValueType;
    let value: ApiJsonScalarValue;
    if (first === '"') {
      const end = endOfJsonString(text, index);
      if (end < 0) return malformed;
      raw = text.slice(index, end);
      type = 'string';
      value = JSON.parse(raw) as string;
    } else {
      const literal = [...JSON_LITERALS.keys()].find((name) => text.startsWith(name, index));
      if (literal !== undefined) {
        raw = literal;
        value = JSON_LITERALS.get(literal) ?? null;
        type = value === null ? 'null' : 'boolean';
      } else {
        JSON_NUMBER.lastIndex = index;
        const match = JSON_NUMBER.exec(text);
        if (match === null) return malformed;
        raw = match[0];
        type = 'number';
        value = Number(raw);
      }
    }
    entries.push({ key, type, raw, value });
    index = skip(index + raw.length);
    if (text[index] === ',') {
      index = skip(index + 1);
    } else if (text[index] === '}') {
      return { ok: true, entries };
    } else {
      return malformed;
    }
  }
};

/** 本文の鍵と値を、期待に照らす（一致ならページが決める鍵の値）。 */
const checkBody = (accepted: AcceptedExpectation, entries: readonly BodyEntry[]): ApiWritePayloadCheck => {
  if (entries.some(({ key }) => isMethodOverrideFieldName(key))) {
    return { decision: 'METHOD_OVERRIDE_PRESENT' };
  }
  const keys = new Set(entries.map(({ key }) => key));
  // T41c: 承認の鍵の集合は、変える鍵・ページが決める鍵・保つ鍵。集合の外の鍵のうち、状態の語の鍵（状態の欄の名前の判定の owner
  // `fieldNameHasStateWord`）は理由を分けて止める（重ねの守り）。
  const approved = (key: string): boolean => accepted.keyFields.has(key) || accepted.pageKeys.has(key) || accepted.keptKeys.has(key);
  if (entries.some(({ key }) => !approved(key) && fieldNameHasStateWord(key))) {
    return { decision: 'BODY_STATE_KEY_UNEXPECTED' };
  }
  if (entries.some(({ key }) => !approved(key))) {
    return { decision: 'BODY_KEY_UNEXPECTED' };
  }
  // 保つ鍵は、本文になくても通す（ユーザーの判断 1）。
  if ([...accepted.keyFields.keys(), ...accepted.pageKeys.keys()].some((key) => !keys.has(key))) {
    return { decision: 'BODY_KEY_MISSING' };
  }
  const pageKeyValues: [string, ApiJsonScalarValue][] = [];
  for (const entry of entries) {
    // T41c: 照らす値は、変える鍵なら生成した値、保つ鍵と UPDATE のページが決める鍵なら前の値。CREATE のページが決める鍵は照らさずに返す。
    const expected = accepted.keyFields.get(entry.key) ?? accepted.keptKeys.get(entry.key) ?? accepted.pageKeyPriors.get(entry.key);
    const expectedType = expected?.type ?? accepted.pageKeys.get(entry.key);
    if (entry.type !== expectedType) {
      return { decision: 'BODY_VALUE_TYPE_MISMATCH' };
    }
    if (expected === undefined) {
      pageKeyValues.push([entry.key, entry.value]);
    } else if ((entry.type === 'string' ? entry.value : entry.raw) !== expected.text) {
      return { decision: 'BODY_VALUE_MISMATCH' };
    }
  }
  return { decision: 'ALLOW', pageKeyValues: Object.freeze(Object.fromEntries(pageKeyValues)) };
};

/** 照合の本体（例外は呼び出し側が封じる）。 */
const check = (expectation: ApiWritePayloadExpectation, facts: ApiWriteRequestFacts): ApiWritePayloadCheck => {
  const accepted = acceptedExpectationOf(expectation);
  if (accepted === null) {
    return { decision: 'EXPECTATION_INVALID' };
  }
  const requestFacts: Partial<ApiWriteRequestFacts> = isRecord(facts) ? facts : {};
  if (requestFacts.method !== accepted.method) {
    return { decision: 'METHOD_MISMATCH' };
  }
  const headers = headerEntriesOf(requestFacts.headers);
  if (headers.some(([name]) => (API_METHOD_OVERRIDE_HEADER_NAMES as readonly string[]).includes(name))) {
    return { decision: 'METHOD_OVERRIDE_PRESENT' };
  }
  const url = typeof requestFacts.url === 'string' ? requestFacts.url : '';
  if (!isApiWriteEndpointUrl(url, { origin: accepted.origin, path: accepted.path })) {
    return { decision: 'ENDPOINT_MISMATCH' };
  }
  const query = [...new URL(url).searchParams];
  const queryNames = query.map(([name]) => name);
  if (hasDuplicates(queryNames) || queryNames.length !== accepted.queryNames.length
    || !queryNames.every((name) => accepted.queryNames.includes(name))) {
    return { decision: 'QUERY_MISMATCH' };
  }
  if (accepted.filterName !== null) {
    const filterValue = query.find(([name]) => name === accepted.filterName)?.[1];
    if (filterValue !== `${FILTER_EQUALS_OPERATOR}${API_FILTER_OPERATOR_SEPARATOR}${accepted.recordId ?? ''}`) {
      return { decision: 'FILTER_MISMATCH' };
    }
  }
  if (headers.some(([name]) => isPageSuppliedHeaderName(name) && !accepted.headerNames.has(name))) {
    return { decision: 'HEADER_NOT_ALLOWED' };
  }
  const headerValueOf = (name: string): string | undefined => {
    const values = headers.filter(([headerName]) => headerName === name).map(([, value]) => value);
    return values.length === 0 ? undefined : values.join(HEADER_VALUE_LIST_SEPARATOR);
  };
  if (!contentTypeMatches(headerValueOf(API_CONTENT_TYPE_HEADER_NAME), accepted.contentType)) {
    return { decision: 'CONTENT_TYPE_MISMATCH' };
  }
  if (!preferMatches(headerValueOf(API_PREFER_HEADER_NAME), accepted.prefer)) {
    return { decision: 'PREFER_MISMATCH' };
  }
  const body = requestFacts.body;
  if (!(body instanceof Uint8Array)) {
    return { decision: 'BODY_UNAVAILABLE' };
  }
  if (body.byteLength > MAX_API_WRITE_BODY_BYTES) {
    return { decision: 'BODY_TOO_LARGE' };
  }
  const scanned = scanBody(body);
  return scanned.ok ? checkBody(accepted, scanned.entries) : { decision: scanned.reason };
};

/**
 * 一時停止した要求を、承認した API の指定と生成した値に照らす（純粋。入力を変えない。投げない）。判定の順と理由はファイルの説明のとおり。結果は閉じた
 * 一覧の理由だけか、`ALLOW` とページが決める鍵の値だけ。
 */
export function checkApiWritePayload(expectation: ApiWritePayloadExpectation, facts: ApiWriteRequestFacts): ApiWritePayloadCheck {
  try {
    return Object.freeze(check(expectation, facts));
  } catch {
    return Object.freeze({ decision: 'EXPECTATION_INVALID' });
  }
}
