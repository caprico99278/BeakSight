// 送らずに観察する probe の、本番の要求の型（T37b。Task 37 の設計書 3.2 の「記録する型」の表、4 章）。純粋な関数と、型の契約の唯一の置き場所。
// - Guard（`src/safety/submission-observation.ts` を通して）が、凍結の段で止めた読み取りでない要求から型を作る。分類（`src/discovery/api-shape-classification.ts`）
//   と、その digest（`shapeDigest`）は、この型と、ここに置く契約（filter の書き方、閉じた一覧の query の名前、upsert の印、手続きの呼び出しの path の区切り、
//   `Prefer` の閉じた一覧）を読む。プラットフォームの名前を書かない一般の形として持つ（Target Isolation）。
// - 値は持たない（I22）: 本文の値、query の値、ヘッダの値、目印の値は、型にも例外の文にも残さない。名前（鍵、query、ヘッダ）も、値に見える
//   （`isValueLikeText`）、長すぎる（`MAX_API_SHAPE_NAME_LENGTH`）、目印を含む（大文字と小文字を区別しない）なら伏せる（`REDACTED`）。path は、値に
//   見える区切り（`redactValueLikePathSegments`）と、目印を含む区切りを伏せる。filter の値は、画面の path の最後の ID と同じかの真偽だけを残す（T37R-fix-A の M-1。列の名前は見ない限界）。
//   論理削除の鍵は、文脈の判定（`isStateKeyName`）で伏せる前の名前を見て、真偽（`stateKeyPresent`）だけを残す（T37R-fix-A の I-3）。
// - 本文は、メモリの中で 1 回だけ読む（UTF-8 の bytes が `MAX_API_REQUEST_BODY_BYTES` を超えたら読まずに「読めない」）。鍵と目印の対応は、最上位の鍵の値（文字列か
//   数）に目印が含まれるかで決め、目印の番号（渡された一覧の位置）だけを残す。
// - 画面の path の ID（設計書 3.2 の「画面の path の値に見える区切り」）: 値に見える区切り（`isValueLikePathSegment`）に加えて、UUID の形と、数字だけの
//   区切りを ID とみなす（`isRecordIdLikePathSegment`。実環境と fixture の更新の画面の path は数字か UUID の ID を持ち、値に見える区切りの判定はそれらを
//   伏せない（ID として残す）ため。T37b の実装者の解釈を、設計者が可とした（設計書 8 章、2026-10-17））。
// - Origin の区分（承認した API の Origin の番号、許可 Origin、そのほか）は、呼び出し側が Origin の判定の owner で決めて渡す（GATE-ARCH04。ここでは
//   Origin を比べない）。
// - import は同じ core の部品だけ（`src/discovery/` の純粋な部品からも読めるようにする）。
import { exclusionMatchPathFormsOf } from './audit-exclusion-forms.js';
import { MAX_HTTP_METHOD_LENGTH } from './limits.js';
import { REDACTED } from './redaction.js';
import { compareCodeUnits } from './text.js';
import { isUuidText, isValueLikePathSegment, isValueLikeText, redactValueLikePathSegments } from './url-path-redaction.js';

// ---------------------------------------------------------------------------------------------------------------
// 契約（filter の書き方と閉じた一覧。分類と型の作り手が共有する唯一の置き場所）
// ---------------------------------------------------------------------------------------------------------------

/** filter の演算子のうち、読むもの（今は `eq` だけ。ほかは `OTHER`）。 */
export const API_FILTER_OPERATORS = Object.freeze(['eq'] as const);
/** filter の演算子の型（読む演算子と、ほか）。 */
export type ApiFilterOperator = (typeof API_FILTER_OPERATORS)[number] | 'OTHER';
/** filter の値の書き方の、演算子と値の区切り（`<名前>=<演算子>.<値>`）。 */
export const API_FILTER_OPERATOR_SEPARATOR = '.';
/** filter でない、閉じた一覧の query の名前（取り出す列の指定）。 */
export const API_SELECTION_QUERY_NAMES = Object.freeze(['select'] as const);
/** upsert の印の query の名前（filter でない）。 */
export const API_UPSERT_QUERY_NAMES = Object.freeze(['on_conflict'] as const);
/** 手続きの呼び出しの path の区切り（`/rpc/`）。 */
export const API_PROCEDURE_PATH_SEGMENT = 'rpc';
/** `Prefer` のヘッダの名前（小文字）。 */
export const API_PREFER_HEADER_NAME = 'prefer';
/** `Content-Type` のヘッダの名前（小文字）。 */
export const API_CONTENT_TYPE_HEADER_NAME = 'content-type';
/**
 * method を上書きするヘッダの名前の閉じた一覧（小文字。T37R2-fix-A の M-2 (b)）。型のヘッダの名前（小文字）と比べ、当たる型は実行しない。本文の最上位の
 * 鍵 `_method` の判定は、`src/discovery/candidate-contracts.ts` の `isMethodOverrideFieldName`（CC-076 の owner）。
 */
export const API_METHOD_OVERRIDE_HEADER_NAMES = Object.freeze(['x-http-method-override', 'x-http-method', 'x-method-override'] as const);
/**
 * ブラウザ（Chromium）が要求に付けるヘッダの名前の閉じた一覧（小文字。Task 38 のユーザーの判断「ヘッダの名前は結ぶ。ブラウザが付ける名前は除く」）。ページが
 * 付ける名前だけを承認に結ぶ。`BROWSER_SUPPLIED_HEADER_NAME_PREFIXES` で始まる名前（`sec-fetch-*`・`sec-ch-*` など）も除く。T38b で
 * `src/control/approval/scenario-contracts.ts` に作り、T39a で、シナリオの下書きの確かめ（control）と、書き込みの段の照合（safety）の両方が読めるよう、
 * ここへ移した（scenario-contracts は再び export する）。
 */
export const BROWSER_SUPPLIED_HEADER_NAMES = Object.freeze(browserSuppliedHeaderNameList());

/**
 * ブラウザが付けるヘッダの名前の並び（HTTP のヘッダの名前の配列。`BROWSER_SUPPLIED_HEADER_NAMES` の中身。管理データの生の接続の名前と同じ語を含むので、
 * 配列のリテラルとして書く。Gate `control-store-boundary.test.ts` の (f) は、HTTP のヘッダの名前の配列を数えない）。
 */
function browserSuppliedHeaderNameList() {
  return [
    'accept',
    'accept-encoding',
    'accept-language',
    'cache-control',
    'connection',
    'content-length',
    'cookie',
    'host',
    'origin',
    'pragma',
    'priority',
    'referer',
    'user-agent',
  ] as const;
}
/** ブラウザが付けるヘッダの名前の始まり（小文字）。 */
export const BROWSER_SUPPLIED_HEADER_NAME_PREFIXES = Object.freeze(['sec-'] as const);

/** ページが付けたヘッダの名前か（ブラウザが付ける名前の閉じた一覧と始まりに当たらない。小文字で比べる）。 */
export const isPageSuppliedHeaderName = (name: string): boolean => {
  const lower = name.toLowerCase();
  return !(BROWSER_SUPPLIED_HEADER_NAMES as readonly string[]).includes(lower)
    && !BROWSER_SUPPLIED_HEADER_NAME_PREFIXES.some((prefix) => lower.startsWith(prefix));
};

/**
 * ページが付けたヘッダの名前の集合（T38R-fix の M-2: 型の digest（`api-shape-classification.ts`）と、シナリオの許すヘッダの名前（`scenario-policy.ts`）が
 * 使う唯一の正規化）。小文字にし、ブラウザが付ける名前（`isPageSuppliedHeaderName`）を除き、重なりを除いて UTF-16 のコード単位の順に並べる（凍結）。
 */
export const pageHeaderNamesOf = (headerNames: readonly string[]): readonly string[] =>
  Object.freeze([...new Set(headerNames.map((name) => name.toLowerCase()).filter(isPageSuppliedHeaderName))].sort(compareCodeUnits));

/**
 * 書き込みの API の要求の method の閉じた一覧（`POST` は CREATE、`PATCH` は UPDATE。probe の分類と同じ組）。T39a: シナリオの API の method
 * （`SCENARIO_API_METHODS`）と、書き込みの段で照合にかける要求の判定（`src/safety/request-policy.ts` の `isApiWriteCheckTarget`）が、この一覧を使う。
 */
export const API_WRITE_METHODS = Object.freeze(['POST', 'PATCH'] as const);

/** upsert の印の `Prefer` の値の始まり。 */
export const API_UPSERT_PREFER_PREFIX = 'resolution=';
/** `Prefer` の項目のうち、そのまま残す閉じた一覧の値（T39a: 書き込みの段の照合も、要求の `Prefer` の項目をこの一覧の値とだけ照らす）。 */
export const API_PREFER_KNOWN_VALUES = Object.freeze([
  'return=representation',
  'return=minimal',
  'return=headers-only',
  'resolution=merge-duplicates',
  'resolution=ignore-duplicates',
] as const);
/** 閉じた一覧にない `return=…`・`resolution=…` と、そのほかの項目の表記。 */
const API_PREFER_OTHER_VALUES = Object.freeze(['return=other', 'resolution=other', 'other'] as const);
/** 型に残す `Prefer` の値の閉じた一覧。 */
export const API_PREFER_SHAPES = Object.freeze([...API_PREFER_KNOWN_VALUES, ...API_PREFER_OTHER_VALUES]);
/** 型に残す `Prefer` の値。 */
export type ApiPreferShape = (typeof API_PREFER_SHAPES)[number];

// ---------------------------------------------------------------------------------------------------------------
// 上限
// ---------------------------------------------------------------------------------------------------------------

/** 名前（鍵、query、ヘッダ）の長さの上限（超えたら伏せる）。 */
export const MAX_API_SHAPE_NAME_LENGTH = 64;
/** 本文の最上位の鍵の数の上限（超えた分は数だけ）。 */
export const MAX_API_SHAPE_BODY_KEYS = 64;
/** query の名前の数の上限（超えた分は数だけ。filter の一覧も同じ上限）。 */
export const MAX_API_SHAPE_QUERY_NAMES = 32;
/** ヘッダの名前の数の上限（超えた分は数だけ）。 */
export const MAX_API_SHAPE_HEADER_NAMES = 64;
/** 目印の数の上限（超えたら型を作らない）。 */
export const MAX_API_SHAPE_MARKERS = 32;
/**
 * 本文の大きさの上限（UTF-8 の bytes）。型の作り手（超えたら読まずに「読めない」。分類は実行できない）と、書き込みの段の照合
 * （`src/safety/api-write-payload-policy.ts` の `MAX_API_WRITE_BODY_BYTES`。超えたら `BODY_TOO_LARGE`）が使う唯一の値（T39R-fix の M-5。照合が
 * 通さない大きさの本文の型を、分類で実行できるとしないため）。1 件の登録・更新の JSON（鍵は 64 まで）に余裕を見た値。
 */
export const MAX_API_REQUEST_BODY_BYTES = 65_536;
/** path の型の長さの上限（超えたら伏せる）。 */
export const MAX_API_SHAPE_PATH_LENGTH = 1_024;
/** `Content-Type` の媒体の型の長さの上限（超えたら伏せる）。 */
export const MAX_API_SHAPE_MEDIA_TYPE_LENGTH = 100;

// ---------------------------------------------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------------------------------------------

/** Origin の区分: 承認した API の Origin（渡された一覧の位置）、許可 Origin、そのほか。 */
export type ApiRequestOriginShape =
  | { readonly kind: 'APPROVED_API'; readonly index: number }
  | { readonly kind: 'ALLOWED' }
  | { readonly kind: 'OTHER' };

/** filter の形（値は持たない）。 */
export interface ApiRequestFilterShape {
  readonly name: string;
  readonly operator: ApiFilterOperator;
  /** 演算子が `eq` で、値が画面の path の ID（`isRecordIdLikePathSegment`）のどれかと同じか。 */
  readonly valueMatchesPagePath: boolean;
}

/** 本文の最上位の形（なし、読めない、JSON でない、object、array、JSON の文字列・数など）。 */
export const API_REQUEST_BODY_KINDS = Object.freeze(['NONE', 'UNREADABLE', 'NOT_JSON', 'OBJECT', 'ARRAY', 'SCALAR'] as const);
export type ApiRequestBodyKind = (typeof API_REQUEST_BODY_KINDS)[number];

/** 値の JSON の型。 */
export const API_JSON_VALUE_TYPES = Object.freeze(['string', 'number', 'boolean', 'null', 'object', 'array'] as const);
export type ApiJsonValueType = (typeof API_JSON_VALUE_TYPES)[number];

/** 本文の最上位の鍵（名前と値の JSON の型）。 */
export interface ApiRequestBodyKey {
  readonly name: string;
  readonly type: ApiJsonValueType;
}

/** 鍵と目印の対応（目印の番号は、渡された目印の一覧の位置）。 */
export interface ApiRequestMarkerKey {
  readonly key: string;
  readonly markers: readonly number[];
}

/** 本文の型（object のときだけ鍵と対応を持つ。ほかは空）。 */
export interface ApiRequestBodyShape {
  readonly kind: ApiRequestBodyKind;
  readonly keys: readonly ApiRequestBodyKey[];
  readonly omittedKeyCount: number;
  readonly markerKeys: readonly ApiRequestMarkerKey[];
  /**
   * T37R-fix-A（I-3）: 最上位の鍵のどれかが、論理削除にあたる状態の鍵か（文脈の `isStateKeyName` で、伏せる前・上限で切る前のすべての名前を見た結果の
   * 真偽だけ。名前は残さない）。判定を渡さない文脈では偽。
   */
  readonly stateKeyPresent: boolean;
}

/** 本番の要求の型（設計書 3.2 の「記録する型」の表。数の項目は観察の結果の側が持つ）。 */
export interface ApiRequestShape {
  readonly method: string;
  readonly resourceType: string;
  readonly origin: ApiRequestOriginShape;
  readonly pathShape: string;
  readonly queryNames: readonly string[];
  readonly omittedQueryNameCount: number;
  readonly filters: readonly ApiRequestFilterShape[];
  readonly headerNames: readonly string[];
  readonly omittedHeaderNameCount: number;
  readonly contentType: string | null;
  readonly prefer: readonly ApiPreferShape[];
  readonly body: ApiRequestBodyShape;
}

/** 要求の本文（Guard が CDP の項目から読んだもの。`src/safety/login-credential-guard.ts` の `RequestBodyText` と同じ形）。 */
export type ApiRequestBody =
  | { readonly kind: 'NONE' }
  | { readonly kind: 'TEXT'; readonly text: string }
  | { readonly kind: 'UNREADABLE' };

/** 型の作り手の入力（要求の事実）。 */
export interface ApiRequestShapeInput {
  readonly method: string;
  /** 要求の種類（Guard が閉じた一覧に正規化した値）。 */
  readonly resourceType: string;
  readonly url: string;
  /**
   * Origin の区分（呼び出し側が、Origin の判定の owner（`src/safety/request-policy.ts` の `hasAllowedOrigin`。GATE-ARCH04）で決めて渡す。この
   * ファイルは Origin を比べない）。
   */
  readonly origin: ApiRequestOriginShape;
  readonly headers: Readonly<Record<string, string>> | undefined;
  readonly body: ApiRequestBody;
}

/** 型の作り手の文脈（観察の口が持つ）。 */
export interface ApiRequestShapeContext {
  /** probe した画面の path（filter の値と比べる ID を取り出す）。 */
  readonly pagePath: string;
  /** 欄に入れた目印（値は型に残さない。番号だけを残す）。 */
  readonly markers: readonly string[];
  /**
   * T37R-fix-A（I-3）: 本文の鍵の名前が、論理削除にあたる状態の鍵か（観察の口が `src/discovery/classify.ts` の `fieldNameHasStateWord` を渡す。core は
   * 発見の部品を import しないため）。伏せる前の名前で呼ぶ。投げたら、状態の鍵があるとみなす（安全の側）。
   */
  readonly isStateKeyName?: ((name: string) => boolean) | undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// 部品
// ---------------------------------------------------------------------------------------------------------------

const PATH_SEPARATOR = '/';
const PREFER_ITEM_SEPARATOR = ',';
const MEDIA_TYPE_PARAMETER_SEPARATOR = ';';
/** method の形（英大文字だけ）。 */
const METHOD_SHAPE = /^[A-Z]+$/u;
/** 要求の種類の形（英小文字だけ）。 */
const RESOURCE_TYPE_SHAPE = /^[a-z]+$/u;
/** 要求の種類が形に合わないときの値。 */
const OTHER_RESOURCE_TYPE = 'other';
/** 媒体の型の形（`type/subtype`。RFC 9110 の token の文字）。 */
const MEDIA_TYPE_SHAPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u;
/** 数字だけの区切り（ID）。 */
const DECIMAL_DIGITS = /^[0-9]+$/u;

/**
 * `Prefer` の値を項目に分ける（`,` で区切り、前後の空白を除いて小文字にする。空の項目は除く）。型の作り手（`apiRequestShapeOf`）と書き込みの段の
 * 照合（`src/safety/api-write-payload-policy.ts`）が使う唯一の読み方（T39R-fix の M-5）。
 */
export const apiPreferItemsOf = (value: string): readonly string[] =>
  value.split(PREFER_ITEM_SEPARATOR).map((item) => item.trim().toLowerCase()).filter((item) => item.length > 0);

/** `Content-Type` の値の、媒体の型と引数。 */
export interface ApiContentTypeParts {
  /** 媒体の型（最初の `;` の前。前後の空白を除いて小文字にする）。 */
  readonly mediaType: string;
  /** 引数（`;` の後ろの、書かれたままの文字列）。 */
  readonly parameters: readonly string[];
}

/**
 * `Content-Type` の値を、媒体の型と引数に分ける。型の作り手（媒体の型だけを残す）と書き込みの段の照合（媒体の型と引数を照らす）が使う唯一の
 * 読み方（T39R-fix の M-5）。
 */
export const apiContentTypePartsOf = (value: string): ApiContentTypeParts => {
  const [mediaType = '', ...parameters] = value.split(MEDIA_TYPE_PARAMETER_SEPARATOR);
  return { mediaType: mediaType.trim().toLowerCase(), parameters };
};

/**
 * path に手続きの呼び出しの区切り（`API_PROCEDURE_PATH_SEGMENT`）があるか（T37R-fix-A の I-3、T37R2-fix-A の M-1。T39R-fix の M-4 で分類から
 * 契約へ移し、書き込みの段の照合の期待の確かめも使う）。監査の除外の比べと同じ path の形（`exclusionMatchPathFormsOf`。変わらなくなるまでの
 * percent-decode、連続した `/` のまとめ、区切りの `;` の引数を外す、`.` と `..` の解決、NFKC と大文字・小文字の畳み込み）のどれかの区切りが
 * `API_PROCEDURE_PATH_SEGMENT` なら真。形を作れない path は、手続きの呼び出しでないと言えないので真（安全の側）。
 */
export const hasApiProcedureCallSegment = (pathShape: string): boolean => {
  const forms = exclusionMatchPathFormsOf(pathShape);
  return forms === null || forms.some((form) => form.split(PATH_SEPARATOR).includes(API_PROCEDURE_PATH_SEGMENT));
};

const EMPTY_BODY = (kind: ApiRequestBodyKind): ApiRequestBodyShape => Object.freeze({
  kind,
  keys: Object.freeze([]),
  omittedKeyCount: 0,
  markerKeys: Object.freeze([]),
  stateKeyPresent: false,
});

/** 区切りを decode する（decode できなければ、そのまま）。 */
const decodedOf = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

/** 名前か文字列が、目印のどれかを含むか（大文字と小文字を区別しない）。 */
const carriesMarker = (text: string, markers: readonly string[]): boolean => {
  const folded = text.toLowerCase();
  return markers.some((marker) => folded.includes(marker.toLowerCase()));
};

/** 型に残してよい名前（値に見える、長すぎる、目印を含む名前は伏せる）。 */
const safeNameOf = (name: string, markers: readonly string[]): string =>
  name.length > MAX_API_SHAPE_NAME_LENGTH || isValueLikeText(name) || carriesMarker(name, markers) ? REDACTED : name;

/** 並べた写し（UTF-16 のコード単位の順）。 */
const sortedTexts = (values: readonly string[]): string[] => {
  const copy = [...values];
  copy.sort(compareCodeUnits);
  return copy;
};

/** 上限までの並べた名前と、超えた数。 */
const cappedNames = (names: readonly string[], limit: number): { readonly names: readonly string[]; readonly omitted: number } => {
  const sorted = sortedTexts(names);
  return { names: Object.freeze(sorted.slice(0, limit)), omitted: Math.max(0, sorted.length - limit) };
};

/**
 * 画面の path の区切りが、ID か（設計書 3.2 の「画面の path の値に見える区切り」の、T37b の実装者の解釈。設計者が可とした（設計書 8 章、2026-10-17））: 値に見える区切り（`isValueLikePathSegment`）、
 * UUID の形、数字だけの区切り。空の区切りは ID でない。
 */
export const isRecordIdLikePathSegment = (segment: string): boolean => {
  if (segment.length === 0) {
    return false;
  }
  const decoded = decodedOf(segment);
  return isValueLikePathSegment(segment) || isUuidText(decoded) || DECIMAL_DIGITS.test(decoded);
};

/**
 * 画面の path の最後の ID（decode した区切り。ID がなければ `null`）。T37R-fix-A（M-1）: filter の値は、画面の path の最後の ID とだけ比べる
 * （`/orgs/7/members/1/edit` では `1`。組織の ID `7` の filter は、画面の行の更新ではない）。列の名前は見ない（限界）。
 */
const lastPagePathIdOf = (pagePath: string): string | null => {
  const index = lastRecordIdLikePathSegmentIndexOf(pagePath);
  const last = index === null ? undefined : pagePath.split(PATH_SEPARATOR)[index];
  return last === undefined ? null : decodedOf(last);
};

/**
 * T41a（Task 41 の設計書 3.1 の「`{id}` の位置」「画面の path を型にした識別の digest」）: 画面の path の最後の ID（`isRecordIdLikePathSegment`）の区切りの
 * 位置（`path.split('/')` の位置。先頭の空の区切りが 0。ID がなければ null）。filter の値を比べる最後の ID（`lastPagePathIdOf`）、API の UPDATE の台帳の
 * 型の `{id}` の位置の確かめ（`scenario-policy.ts`）、form のない候補の型にした識別の digest（`src/discovery/fingerprint.ts`）が使う唯一の決まり。
 */
export const lastRecordIdLikePathSegmentIndexOf = (pagePath: string): number | null => {
  const segments = pagePath.split(PATH_SEPARATOR);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (isRecordIdLikePathSegment(segments[index] ?? '')) {
      return index;
    }
  }
  return null;
};

/** Origin の区分の写し（形が違えば「そのほか」）。 */
const originShapeOf = (origin: ApiRequestOriginShape): ApiRequestOriginShape => {
  if (origin?.kind === 'APPROVED_API' && Number.isSafeInteger(origin.index) && origin.index >= 0) {
    return Object.freeze({ kind: 'APPROVED_API', index: origin.index });
  }
  return origin?.kind === 'ALLOWED' ? Object.freeze({ kind: 'ALLOWED' }) : Object.freeze({ kind: 'OTHER' });
};

/** path の型（値に見える区切りと、目印を含む区切りを伏せる。長すぎれば全体を伏せる）。 */
const pathShapeOf = (pathname: string, markers: readonly string[]): string => {
  const shape = redactValueLikePathSegments(pathname)
    .split(PATH_SEPARATOR)
    .map((segment) => (carriesMarker(decodedOf(segment), markers) ? REDACTED : segment))
    .join(PATH_SEPARATOR);
  return shape.length > MAX_API_SHAPE_PATH_LENGTH ? REDACTED : shape;
};

/** query の名前と filter の形。 */
const queryShapeOf = (
  url: URL,
  context: ApiRequestShapeContext,
): Pick<ApiRequestShape, 'queryNames' | 'omittedQueryNameCount' | 'filters'> => {
  const lastId = lastPagePathIdOf(context.pagePath);
  const names: string[] = [];
  const filters: ApiRequestFilterShape[] = [];
  for (const [name, value] of url.searchParams) {
    const safeName = safeNameOf(name, context.markers);
    names.push(safeName);
    if ((API_SELECTION_QUERY_NAMES as readonly string[]).includes(name) || (API_UPSERT_QUERY_NAMES as readonly string[]).includes(name)) {
      continue;
    }
    const separator = value.indexOf(API_FILTER_OPERATOR_SEPARATOR);
    const operatorText = separator < 0 ? '' : value.slice(0, separator);
    const operator: ApiFilterOperator = (API_FILTER_OPERATORS as readonly string[]).includes(operatorText) ? operatorText as ApiFilterOperator : 'OTHER';
    const operand = separator < 0 ? '' : value.slice(separator + API_FILTER_OPERATOR_SEPARATOR.length);
    filters.push(Object.freeze({ name: safeName, operator, valueMatchesPagePath: operator !== 'OTHER' && lastId !== null && operand === lastId }));
  }
  filters.sort((left, right) => compareCodeUnits(left.name, right.name) || compareCodeUnits(left.operator, right.operator)
    || Number(left.valueMatchesPagePath) - Number(right.valueMatchesPagePath));
  const capped = cappedNames(names, MAX_API_SHAPE_QUERY_NAMES);
  return { queryNames: capped.names, omittedQueryNameCount: capped.omitted, filters: Object.freeze(filters.slice(0, MAX_API_SHAPE_QUERY_NAMES)) };
};

/** ヘッダの名前（小文字、並べる）と、`Content-Type` の媒体の型と、`Prefer` の閉じた一覧の値。 */
const headerShapeOf = (
  headers: Readonly<Record<string, string>> | undefined,
  markers: readonly string[],
): Pick<ApiRequestShape, 'headerNames' | 'omittedHeaderNameCount' | 'contentType' | 'prefer'> => {
  const entries = headers === undefined || headers === null || typeof headers !== 'object' ? [] : Object.entries(headers);
  const names = new Set<string>();
  let contentType: string | null = null;
  const prefer = new Set<ApiPreferShape>();
  for (const [rawName, value] of entries) {
    const name = rawName.toLowerCase();
    names.add(name);
    if (typeof value !== 'string') {
      continue;
    }
    if (name === API_CONTENT_TYPE_HEADER_NAME) {
      const { mediaType } = apiContentTypePartsOf(value);
      contentType = mediaType.length <= MAX_API_SHAPE_MEDIA_TYPE_LENGTH && MEDIA_TYPE_SHAPE.test(mediaType) && !carriesMarker(mediaType, markers)
        ? mediaType
        : REDACTED;
    } else if (name === API_PREFER_HEADER_NAME) {
      for (const item of apiPreferItemsOf(value)) {
        const shape = preferShapeOf(item);
        if (shape !== null) prefer.add(shape);
      }
    }
  }
  // 名前の重なりは、伏せる前の小文字の名前で除く（伏せた名前どうしは数のまま残す）。
  const capped = cappedNames([...names].map((name) => safeNameOf(name, markers)), MAX_API_SHAPE_HEADER_NAMES);
  return {
    headerNames: capped.names,
    omittedHeaderNameCount: capped.omitted,
    contentType,
    prefer: Object.freeze(sortedTexts([...prefer]) as ApiPreferShape[]),
  };
};

/** `Prefer` の 1 つの項目の閉じた一覧の値（空の項目は `null`）。 */
const preferShapeOf = (item: string): ApiPreferShape | null => {
  if (item.length === 0) {
    return null;
  }
  const known = API_PREFER_KNOWN_VALUES.find((value) => value === item);
  if (known !== undefined) {
    return known;
  }
  if (item.startsWith('return=')) {
    return 'return=other';
  }
  return item.startsWith(API_UPSERT_PREFER_PREFIX) ? 'resolution=other' : 'other';
};

/** 値の JSON の型。 */
const jsonTypeOf = (value: unknown): ApiJsonValueType => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    default:
      return 'object';
  }
};

const UTF8_ENCODER = new TextEncoder();

/**
 * 本文の文字列の UTF-8 の bytes が上限（`MAX_API_REQUEST_BODY_BYTES`）の中か。UTF-8 の bytes は UTF-16 の code unit の数より少なくならないので、
 * 文字の数が上限を超える本文は数えずに外す。
 */
const isWithinBodyLimit = (text: string): boolean =>
  text.length <= MAX_API_REQUEST_BODY_BYTES && UTF8_ENCODER.encode(text).byteLength <= MAX_API_REQUEST_BODY_BYTES;

/** 本文の型（メモリの中で 1 回だけ読む。値は残さない）。 */
const bodyShapeOf = (
  body: ApiRequestBody,
  markers: readonly string[],
  isStateKeyName: ((name: string) => boolean) | undefined,
): ApiRequestBodyShape => {
  if (body.kind === 'NONE') return EMPTY_BODY('NONE');
  if (body.kind !== 'TEXT' || typeof body.text !== 'string' || !isWithinBodyLimit(body.text)) return EMPTY_BODY('UNREADABLE');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    return EMPTY_BODY('NOT_JSON');
  }
  if (Array.isArray(parsed)) return EMPTY_BODY('ARRAY');
  if (parsed === null || typeof parsed !== 'object') return EMPTY_BODY('SCALAR');
  const keys: ApiRequestBodyKey[] = [];
  const markerKeys: ApiRequestMarkerKey[] = [];
  let stateKeyPresent = false;
  for (const [rawName, value] of Object.entries(parsed as Record<string, unknown>)) {
    // T37R-fix-A（I-3）: 論理削除の鍵の判定は、伏せる前・上限で切る前の名前で行い、真偽だけを残す。
    if (!stateKeyPresent && isStateKeyName !== undefined) {
      try {
        stateKeyPresent = isStateKeyName(rawName);
      } catch {
        stateKeyPresent = true;
      }
    }
    const name = safeNameOf(rawName, markers);
    keys.push(Object.freeze({ name, type: jsonTypeOf(value) }));
    if (typeof value === 'string' || typeof value === 'number') {
      const text = String(value);
      const matched = markers.flatMap((marker, index) => (text.includes(marker) ? [index] : []));
      if (matched.length > 0) markerKeys.push(Object.freeze({ key: name, markers: Object.freeze(matched) }));
    }
  }
  keys.sort((left, right) => compareCodeUnits(left.name, right.name) || compareCodeUnits(left.type, right.type));
  markerKeys.sort((left, right) => compareCodeUnits(left.key, right.key));
  return Object.freeze({
    kind: 'OBJECT',
    keys: Object.freeze(keys.slice(0, MAX_API_SHAPE_BODY_KEYS)),
    omittedKeyCount: Math.max(0, keys.length - MAX_API_SHAPE_BODY_KEYS),
    markerKeys: Object.freeze(markerKeys.slice(0, MAX_API_SHAPE_BODY_KEYS)),
    stateKeyPresent,
  });
};

/** 文脈の目印を確かめる（数の上限、文字列だけ。例外の文に値を入れない）。空の目印は比べない。 */
const markersOf = (markers: unknown): readonly string[] => {
  if (!Array.isArray(markers) || markers.length > MAX_API_SHAPE_MARKERS || !markers.every((marker) => typeof marker === 'string')) {
    throw new TypeError(`API request shape markers must be at most ${String(MAX_API_SHAPE_MARKERS)} strings`);
  }
  return (markers as readonly string[]).filter((marker) => marker.length > 0);
};

/**
 * 止めた本番の要求の型を作る（純粋。入力を変えない）。URL を読めなければ、Origin は「そのほか」、path は伏せ、query はない。目印の数が上限を超えるか、
 * 文字列でない目印があれば `TypeError`（値を文に入れない）。ほかの入力の誤りでは投げない。
 */
export function apiRequestShapeOf(input: ApiRequestShapeInput, context: ApiRequestShapeContext): ApiRequestShape {
  const markers = markersOf(context.markers);
  const scoped: ApiRequestShapeContext = { ...context, markers };
  const upperMethod = typeof input.method === 'string' ? input.method.toUpperCase() : '';
  const method = upperMethod.length <= MAX_HTTP_METHOD_LENGTH && METHOD_SHAPE.test(upperMethod) ? upperMethod : REDACTED;
  const resourceType = typeof input.resourceType === 'string' && RESOURCE_TYPE_SHAPE.test(input.resourceType) && input.resourceType.length <= MAX_API_SHAPE_NAME_LENGTH
    ? input.resourceType
    : OTHER_RESOURCE_TYPE;
  let url: URL | null;
  try {
    url = new URL(input.url);
  } catch {
    url = null;
  }
  const query = url === null
    ? { queryNames: Object.freeze([]), omittedQueryNameCount: 0, filters: Object.freeze([]) }
    : queryShapeOf(url, scoped);
  return Object.freeze({
    method,
    resourceType,
    origin: url === null ? Object.freeze({ kind: 'OTHER' as const }) : originShapeOf(input.origin),
    pathShape: url === null ? REDACTED : pathShapeOf(url.pathname, markers),
    ...query,
    ...headerShapeOf(input.headers, markers),
    body: bodyShapeOf(input.body, markers, typeof context.isStateKeyName === 'function' ? context.isStateKeyName : undefined),
  });
}
