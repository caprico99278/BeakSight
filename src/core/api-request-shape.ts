// 送らずに観察する probe の、本番の要求の型（T37b。Task 37 の設計書 3.2 の「記録する型」の表、4 章）。純粋な関数と、型の契約の唯一の置き場所。
// - Guard（`src/safety/submission-observation.ts` を通して）が、凍結の段で止めた読み取りでない要求から型を作る。分類（`src/discovery/api-shape-classification.ts`）
//   と、その digest（`shapeDigest`）は、この型と、ここに置く契約（filter の書き方、閉じた一覧の query の名前、upsert の印、手続きの呼び出しの path の区切り、
//   `Prefer` の閉じた一覧）を読む。プラットフォームの名前を書かない一般の形として持つ（Target Isolation）。
// - 値は持たない（I22）: 本文の値、query の値、ヘッダの値、目印の値は、型にも例外の文にも残さない。名前（鍵、query、ヘッダ）も、値に見える
//   （`isValueLikeText`）、目印を含む（大文字と小文字を区別しない）なら伏せる（`REDACTED`。L13: 長さでは伏せない）。path は、値に
//   見える区切り（`redactValueLikePathSegments`）と、目印を含む区切りを伏せる。filter の値は、画面の path の最後の ID と同じかの真偽だけを残す（T37R-fix-A の M-1。列の名前は見ない限界）。
//   論理削除の鍵は、文脈の判定（`isStateKeyName`）で伏せる前の名前を見て、真偽（`stateKeyPresent`）だけを残す（T37R-fix-A の I-3）。
// - 本文は、メモリの中で 1 回だけ読む（L13: 大きさでは「読めない」にしない）。名前・鍵・目印の数でも切らない（L13）。鍵と目印の対応は、最上位の鍵の値（文字列か
//   数）に目印が含まれるかで決め、目印の番号（渡された一覧の位置）だけを残す。ARR-1（設計書 `2026-11-08-beaksight-api-array-keys-design.md` 3.2）:
//   最上位の値が一覧（array）なら、要素の情報（型の集合・数・入れ子。`apiArrayElementsOf`）を鍵に足し、要素（文字か数。入れ子の中は
//   見ない）に入った目印を、一覧の中の印（`inArray`）つきで残す。一覧の上限は置かない（L13 fix round 1）。
// - 画面の path の ID（設計書 3.2 の「画面の path の値に見える区切り」）: 値に見える区切り（`isValueLikePathSegment`）に加えて、UUID の形と、数字だけの
//   区切りを ID とみなす（`isRecordIdLikePathSegment`。実環境と fixture の更新の画面の path は数字か UUID の ID を持ち、値に見える区切りの判定はそれらを
//   伏せない（ID として残す）ため。T37b の実装者の解釈を、設計者が可とした（設計書 8 章、2026-10-17））。
// - Origin の区分（承認した API の Origin の番号、許可 Origin、そのほか）は、呼び出し側が Origin の判定の owner で決めて渡す（GATE-ARCH04。ここでは
//   Origin を比べない）。
// - import は同じ core の部品だけ（`src/discovery/` の純粋な部品からも読めるようにする）。
import { exclusionMatchPathFormsOf } from './audit-exclusion-forms.js';
import { MAX_HTTP_METHOD_LENGTH } from './limits.js';
import { PATH_TEMPLATE_ID_SEGMENT } from './record-id-path-pattern.js';
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
/**
 * DEF-208-3（設計書 `2026-11-05-beaksight-discovery-coverage-design.md` 3.6 の H）: 手続きの呼び出しの path の区切りの閉じた一覧（`/rpc/` と、サーバの関数の
 * 呼び出し `/functions/`）。判定は `hasApiProcedureCallSegment` の 1 か所。
 */
export const API_PROCEDURE_PATH_SEGMENTS: readonly string[] = Object.freeze([API_PROCEDURE_PATH_SEGMENT, 'functions']);
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

// 上限: L13（N25）と L13 fix round 1 で、名前の長さ・鍵・query の名前・ヘッダの名前・目印の数・本文の大きさ・媒体の型の長さ・path の長さ・一覧（array）
// の要素の数・文字の長さ・中の鍵・葉の上限を撤廃した（照合は承認との完全な一致で止める）。定数は LZ-1 で消した。

// ---------------------------------------------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------------------------------------------

/**
 * Origin の区分: 承認した API の Origin（承認したサービスの Origin の一覧 `approvedServiceOrigins` の位置）、承認したテストの Origin（DEF-220。設計書
 * `2026-11-08-beaksight-same-origin-api-and-spa-routes-design.md` 3.1。テスト用のサイト自身の API。承認したテストの Origin の一覧 `approvedTestOrigins` の位置）、
 * 許可 Origin、そのほか。2 つの番号は別の一覧の位置なので、混ぜずに `apiShapeApprovedOriginOf` で解く。
 */
export type ApiRequestOriginShape =
  | { readonly kind: 'APPROVED_API'; readonly index: number }
  | { readonly kind: 'APPROVED_TEST'; readonly index: number }
  | { readonly kind: 'ALLOWED' }
  | { readonly kind: 'OTHER' };

/** 番号を持つ、承認した Origin の区分（DEF-220）。 */
export const APPROVED_API_SHAPE_ORIGIN_KINDS = Object.freeze(['APPROVED_API', 'APPROVED_TEST'] as const);
/** DEF-227: 承認した Origin の区分の閉じた集合（上の一覧から作る。区分の値の判定で、URL の許可ではない）。 */
const APPROVED_API_SHAPE_ORIGIN_KIND_SET: ReadonlySet<string> = new Set<string>(APPROVED_API_SHAPE_ORIGIN_KINDS);

/** 型の Origin の番号を Origin に解く一覧（プロファイルの一覧の順。省けば空と同じ）。 */
export interface ApiShapeOriginLists {
  readonly approvedServiceOrigins?: readonly string[] | undefined;
  readonly approvedTestOrigins?: readonly string[] | undefined;
}

/**
 * DEF-220: 型の Origin の区分が、承認した Origin（`APPROVED_API`・`APPROVED_TEST`）か。分類（`UNAPPROVED_ORIGIN`）が使う唯一の判定。
 */
export const isApprovedApiShapeOrigin = ({ kind }: ApiRequestOriginShape): boolean => APPROVED_API_SHAPE_ORIGIN_KIND_SET.has(kind);

/**
 * DEF-220: 型の Origin の区分の番号を、Origin の文字列に解く唯一の部品（分類の後の、シナリオの方針・承認の有効性・事実の索引・自動の下書きが使う）。
 * `APPROVED_API` は承認したサービスの Origin の一覧の位置、`APPROVED_TEST` は承認したテストの Origin の一覧の位置で解く（番号の意味を混ぜない）。ほかの区分と、
 * 一覧にない位置は undefined。
 */
export const apiShapeApprovedOriginOf = (origin: ApiRequestOriginShape, lists: ApiShapeOriginLists): string | undefined => {
  switch (origin.kind) {
    case 'APPROVED_API':
      return lists.approvedServiceOrigins?.[origin.index];
    case 'APPROVED_TEST':
      return lists.approvedTestOrigins?.[origin.index];
    default:
      return undefined;
  }
};

/** filter の形（値は持たない）。 */
export interface ApiRequestFilterShape {
  readonly name: string;
  readonly operator: ApiFilterOperator;
  /** 演算子が `eq` で、値が画面の path の ID（`isRecordIdLikePathSegment`）のどれかと同じか。 */
  readonly valueMatchesPagePath: boolean;
  /**
   * LU-2（設計書 `2026-11-02-beaksight-list-row-update-design.md` 5.2 の 2）: 演算子が閉じた一覧の値で、値が番号の形（数字だけか UUID。
   * `isRecordNumberLikeText`）か。値そのものは型に入れない。一覧の行から開いた入力の更新の分類が使う。
   */
  readonly valueIsRecordIdLike: boolean;
}

/** 本文の最上位の形（なし、読めない、JSON でない、object、array、JSON の文字列・数など）。 */
export const API_REQUEST_BODY_KINDS = Object.freeze(['NONE', 'UNREADABLE', 'NOT_JSON', 'OBJECT', 'ARRAY', 'SCALAR'] as const);
export type ApiRequestBodyKind = (typeof API_REQUEST_BODY_KINDS)[number];

/** 値の JSON の型。 */
export const API_JSON_VALUE_TYPES = Object.freeze(['string', 'number', 'boolean', 'null', 'object', 'array'] as const);
export type ApiJsonValueType = (typeof API_JSON_VALUE_TYPES)[number];

/**
 * ARR-3（設計書 `2026-11-09-beaksight-api-array-rows-design.md` 2.2 の 1）: 一覧の要素の位置 1 つの情報（値は持たない。I22）。目印の番号（渡された一覧の
 * 位置。要素が文字か数のときだけ見る）、空の値（`""` か `null`）か、要素の JSON の型。
 */
export interface ApiRequestArrayPosition {
  readonly markers: readonly number[];
  readonly empty: boolean;
  readonly type: ApiJsonValueType;
  /**
   * ARR-5（設計書 2.4 の 1）: 要素が object のときだけ持つ、中の鍵ごとの情報（名前の順。名前は最上位の鍵と同じ伏せ方）。L13 fix round 1 の前の記録では、
   * 中の鍵が上限（16）を超える行は持たなかった。
   */
  readonly keys?: readonly ApiRequestArrayInnerKey[];
}

/** ARR-5（設計書 2.4 の 1）: object の行の中の鍵 1 つの情報（値は持たない。I22）。中の文字が上限より長ければ `textOverLimit`。 */
export interface ApiRequestArrayInnerKey {
  readonly name: string;
  readonly markers: readonly number[];
  readonly empty: boolean;
  readonly type: ApiJsonValueType;
  readonly textOverLimit?: true;
}

/**
 * ARR-1（設計書 `2026-11-08-beaksight-api-array-keys-design.md` 3.2 の 1）: 一覧の形の値（array）の要素の情報。値は持たない（I22）。
 */
export interface ApiRequestArrayElements {
  /** 要素の JSON の型の集合（重なりなし、コード単位の順に並べる）。 */
  readonly types: readonly ApiJsonValueType[];
  /** 要素の数。 */
  readonly count: number;
  /** 要素に object か array があるか（入れ子。入れ子の中は見ない）。 */
  readonly nested: boolean;
  /**
   * 前は、文字の要素のどれかが上限（200）より長いか。L13 fix round 1 で上限を撤廃したので、今の作り手は常に偽。型の digest に入るので残す（前の記録の型
   * の digest を変えないため。LZ-1）。
   */
  readonly textOverLimit: boolean;
  /**
   * ARR-3（設計書 `2026-11-09-beaksight-api-array-rows-design.md` 2.2 の 1・5）: 位置ごとの情報（要素の順）。一覧の中に目印があり、要素の数が 2 つ以上
   * （L13 fix round 1: 上限なし）のときだけ持つ（要素 1 つの一覧（DEF-226 の形）と、目印のない一覧は持たない。型の digest も変えない）。
   */
  readonly positions?: readonly ApiRequestArrayPosition[];
}

/**
 * ARR-3（設計書 2.2 の 2）: 欄に対応づけた一覧の鍵の、位置ごとの役（承認と送る前の照合が共用する閉じた一覧）。`FIELD` は欄の生成した値、
 * `EMPTY_STRING` は `""`、`EMPTY_NULL` は `null`（空の位置。承認した空の値と一致を求める）。
 */
export const API_ARRAY_FIELD_POSITIONS = Object.freeze(['FIELD', 'EMPTY_STRING', 'EMPTY_NULL'] as const);
export type ApiArrayFieldPosition = (typeof API_ARRAY_FIELD_POSITIONS)[number];

/** ARR-3: 一覧の要素の位置の道の形（`<鍵>[<番号>]`。番号は 0 か 0 で始まらない 10 進）。段 C で `<鍵>[<番号>].<中の鍵>` へ広げる。 */
const API_ARRAY_ELEMENT_PATH = /^(.+?)\[(0|[1-9][0-9]*)\](?:\.(.+))?$/su;

/**
 * ARR-3（設計書 2.1）: 一覧の要素の位置の道 `key[i]` を作る唯一の部品（型の記録・承認・digest・照合・データの規則が共用する）。ARR-5（設計書 2.4 の 1）:
 * object の行の中の鍵は `key[i].name`（`name` を渡したとき）。
 */
export const apiArrayElementPathOf = (key: string, index: number, name?: string): string =>
  `${key}[${String(index)}]${name === undefined ? '' : `.${name}`}`;

/** ARR-3（設計書 2.1）: 道 `key[i]`（ARR-5: `key[i].name`）を鍵と番号（と中の鍵）に読む唯一の部品（形が違えば null）。 */
export const apiArrayElementPathPartsOf = (path: string): { readonly key: string; readonly index: number; readonly name?: string } | null => {
  const match = API_ARRAY_ELEMENT_PATH.exec(path);
  const [, key, index, name] = match ?? [];
  if (key === undefined || index === undefined || !Number.isSafeInteger(Number(index))) {
    return null;
  }
  return name === undefined ? { key, index: Number(index) } : { key, index: Number(index), name };
};

/**
 * ARR-3（設計書 2.2 の 2）: 欄に対応づけた一覧の要素の、位置ごとの役（純粋）。目印がちょうど 1 つ入った文字の位置を欄（`FIELD`）、ほかの空の値の位置を空の
 * 位置にする。要素 1 つで位置の情報を持たない一覧（DEF-226 の形）は `['FIELD']`。位置の情報のない 2 つ以上の一覧・目印が 2 つ入った位置・同じ目印が 2 つの
 * 位置に入る・空でない値が混ざる・欄の位置が文字でない形は null（受けない。理由は承認の owner が決める）。ARR-4（設計書 2.3）: 欄の位置は 1 つ以上（目印は
 * 位置ごとに違う）。1 つの鍵として欄に対応づける一覧（要素の鍵を持たない）は、呼び出し側が欄の位置 1 つを求める。
 */
export const apiArrayFieldPositionsOf = (elements: ApiRequestArrayElements): readonly ApiArrayFieldPosition[] | null => {
  const { positions } = elements;
  if (positions === undefined) {
    return elements.count === 1 ? Object.freeze(['FIELD' as const]) : null;
  }
  const marked = positions.flatMap(({ markers }) => markers);
  if (positions.length !== elements.count || marked.length === 0 || new Set(marked).size !== marked.length) {
    return null;
  }
  const roles: ApiArrayFieldPosition[] = [];
  for (const { markers, empty, type } of positions) {
    if (markers.length > 0) {
      if (markers.length !== 1 || type !== 'string') return null;
      roles.push('FIELD');
    } else if (empty && (type === 'string' || type === 'null')) {
      roles.push(type === 'string' ? 'EMPTY_STRING' : 'EMPTY_NULL');
    } else {
      return null;
    }
  }
  return Object.freeze(roles);
};

/** ARR-5（設計書 2.4）: object の一覧の行ごとの、中の鍵と役（中の鍵の名前の順）。 */
export interface ApiArrayRowRole {
  readonly name: string;
  readonly role: ApiArrayFieldPosition;
}

/**
 * ARR-5: object の一覧を行と中の鍵の役にできない理由（承認の owner が理由の値にする）。`NOT_OBJECT_ROWS`: object の行でない（scalar の一覧）。`NESTED`:
 * 2 段より深い入れ子か、object と scalar の混ざり。`OVER_LIMIT`: 行・中の鍵・葉・文字の上限の超過。`ROW_KEYS`: 行ごとに中の鍵の集合が違う。`FIELD_TYPE`:
 * 欄の値が文字でない。`NOT_EMPTY`: 欄でない値が空でない、1 つの値に目印が 2 つ、同じ目印が 2 か所。
 */
export type ApiArrayObjectRowsProblem = 'NOT_OBJECT_ROWS' | 'NESTED' | 'OVER_LIMIT' | 'ROW_KEYS' | 'FIELD_TYPE' | 'NOT_EMPTY';

/**
 * ARR-5（設計書 2.4 の 3・4・5）: object の一覧の、行ごとの中の鍵の役（純粋。型の記録の位置の情報から）。目印がちょうど 1 つ入った文字の値を欄、ほかの空の
 * 値を空の位置にする。中の鍵の名前の検査（秘密に見える名前・状態の語・伏せた名前）は、発見の部品を使う承認の owner が行う。上限はこのファイルの定数。
 */
export const apiArrayObjectRowsOf = (
  elements: ApiRequestArrayElements,
): { readonly ok: true; readonly rows: readonly (readonly ApiArrayRowRole[])[] } | { readonly ok: false; readonly problem: ApiArrayObjectRowsProblem } => {
  const fail = (problem: ApiArrayObjectRowsProblem) => ({ ok: false as const, problem });
  const { positions } = elements;
  if (!elements.types.includes('object')) {
    return fail('NOT_OBJECT_ROWS');
  }
  if (elements.types.some((type) => type !== 'object')) {
    return fail('NESTED');
  }
  // L13 fix round 1: 行・中の鍵・葉の数と文字の長さの上限（前は `MAX_API_ARRAY_ELEMENTS`・`_OBJECT_KEYS`・`_LEAVES`・`_ELEMENT_TEXT_LENGTH`）は置かない。
  if (positions === undefined || positions.length !== elements.count) {
    return fail('NESTED');
  }
  // 中の鍵を持たない行は、上限で中の鍵を残さなかった前の記録だけ（今の型の作り手は必ず持つ）。前の記録は今どおり受けない。
  if (positions.some(({ keys }) => keys === undefined)) {
    return fail('OVER_LIMIT');
  }
  const rows = positions.map(({ keys }) => keys ?? []);
  const leaves = rows.flat();
  if (leaves.some(({ type }) => type === 'object' || type === 'array')) {
    return fail('NESTED');
  }
  const namesOf = (row: readonly ApiRequestArrayInnerKey[]): string => JSON.stringify(row.map(({ name }) => name));
  const firstNames = namesOf(rows[0] ?? []);
  if (rows.some((row) => namesOf(row) !== firstNames || new Set(row.map(({ name }) => name)).size !== row.length)) {
    return fail('ROW_KEYS');
  }
  const marked = leaves.flatMap(({ markers }) => markers);
  if (new Set(marked).size !== marked.length) {
    return fail('NOT_EMPTY');
  }
  const roles: ApiArrayRowRole[][] = [];
  for (const row of rows) {
    const rowRoles: ApiArrayRowRole[] = [];
    for (const { name, markers, empty, type } of row) {
      if (markers.length > 1) return fail('NOT_EMPTY');
      if (markers.length === 1) {
        if (type !== 'string') return fail('FIELD_TYPE');
        rowRoles.push({ name, role: 'FIELD' });
      } else if (empty && (type === 'string' || type === 'null')) {
        rowRoles.push({ name, role: type === 'string' ? 'EMPTY_STRING' : 'EMPTY_NULL' });
      } else {
        return fail('NOT_EMPTY');
      }
    }
    roles.push(rowRoles);
  }
  return { ok: true, rows: roles };
};

/** ARR-3（設計書 2.2 の 4）: 位置の役が求める値（欄は生成した値、空の位置は承認した空の値）。照合が使う唯一の対応。 */
export const apiArrayFieldPositionValueOf = (position: ApiArrayFieldPosition, generated: string): string | null => {
  switch (position) {
    case 'FIELD':
      return generated;
    case 'EMPTY_STRING':
      return '';
    case 'EMPTY_NULL':
      return null;
  }
};

/** 本文の最上位の鍵（名前と値の JSON の型。型が array のときだけ、要素の情報 `elements` を持つ（ARR-1））。 */
export interface ApiRequestBodyKey {
  readonly name: string;
  readonly type: ApiJsonValueType;
  readonly elements?: ApiRequestArrayElements;
}

/**
 * 鍵と目印の対応（目印の番号は、渡された目印の一覧の位置）。ARR-1: 鍵の値が一覧で、その要素（文字か数）に目印が入ったときは `inArray: true`
 * （一覧の中で見つかった印）。最上位の値（文字か数）で見つかったときは持たない。
 */
export interface ApiRequestMarkerKey {
  readonly key: string;
  readonly markers: readonly number[];
  readonly inArray?: true;
}

/** 本文の型（object のときだけ鍵と対応を持つ。ほかは空）。 */
export interface ApiRequestBodyShape {
  readonly kind: ApiRequestBodyKind;
  readonly keys: readonly ApiRequestBodyKey[];
  /** 前は、鍵の数の上限で省いた鍵の数。L13（N25）の後の作り手は常に 0。型の digest に入るので残す（LZ-1）。 */
  readonly omittedKeyCount: number;
  readonly markerKeys: readonly ApiRequestMarkerKey[];
  /**
   * T37R-fix-A（I-3）: 最上位の鍵のどれかが、論理削除にあたる状態の鍵か（文脈の `isStateKeyName` で、伏せる前・上限で切る前のすべての名前を見た結果の
   * 真偽だけ。名前は残さない）。判定を渡さない文脈では偽。
   */
  readonly stateKeyPresent: boolean;
  /** ARR-5 fix round 1（SREV-ARR2 の M2）: 本文の object（最上位と、一覧の中）に同じ鍵が 2 回あるときだけ真で持つ（`jsonTextHasDuplicateObjectKeys`）。 */
  readonly duplicateKeyPresent?: true;
}

/** 本番の要求の型（設計書 3.2 の「記録する型」の表。数の項目は観察の結果の側が持つ）。 */
export interface ApiRequestShape {
  readonly method: string;
  readonly resourceType: string;
  readonly origin: ApiRequestOriginShape;
  readonly pathShape: string;
  readonly queryNames: readonly string[];
  /** 前は、query の名前の数の上限で省いた数。L13（N25）の後の作り手は常に 0。型の digest に入るので残す（LZ-1）。 */
  readonly omittedQueryNameCount: number;
  readonly filters: readonly ApiRequestFilterShape[];
  readonly headerNames: readonly string[];
  /**
   * 前は、ヘッダの名前の数の上限で省いた数。L13（N25）の後の作り手は常に 0。digest には入らないが、管理データの候補の schema（`candidate.schema.json`）が
   * 求める項目で、前の記録を読むために残す（LZ-1）。
   */
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
 * `API_PROCEDURE_PATH_SEGMENT` なら真。形を作れない path は、手続きの呼び出しでないと言えないので真（安全の側）。DEF-208-3（H）: 区切りは
 * `API_PROCEDURE_PATH_SEGMENTS`（`/functions/` の下のサーバの関数の呼び出しも、手続きの呼び出しとして扱う）。
 */
export const hasApiProcedureCallSegment = (pathShape: string): boolean => {
  const forms = exclusionMatchPathFormsOf(pathShape);
  return forms === null || forms.some((form) => form.split(PATH_SEPARATOR).some((segment) => API_PROCEDURE_PATH_SEGMENTS.includes(segment)));
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

/** 型に残してよい名前（値に見える、目印を含む名前は伏せる。L13（N25）: 長さでは伏せない。前は `MAX_API_SHAPE_NAME_LENGTH` を超えたら伏せた）。 */
const safeNameOf = (name: string, markers: readonly string[]): string =>
  isValueLikeText(name) || carriesMarker(name, markers) ? REDACTED : name;

/** 並べた写し（UTF-16 のコード単位の順）。 */
const sortedTexts = (values: readonly string[]): string[] => {
  const copy = [...values];
  copy.sort(compareCodeUnits);
  return copy;
};

/**
 * filter の形の並べ方（名前、演算子、画面の path の値と同じか、番号の形か）。型の作り手と、型の digest の正規化（`src/discovery/api-shape-classification.ts`）
 * が使う唯一の並べ方。
 */
export const compareApiFilterShapes = (left: ApiRequestFilterShape, right: ApiRequestFilterShape): number =>
  compareCodeUnits(left.name, right.name) || compareCodeUnits(left.operator, right.operator)
  || Number(left.valueMatchesPagePath) - Number(right.valueMatchesPagePath)
  || Number(left.valueIsRecordIdLike === true) - Number(right.valueIsRecordIdLike === true);


/**
 * 画面の path の区切りが、ID か（設計書 3.2 の「画面の path の値に見える区切り」の、T37b の実装者の解釈。設計者が可とした（設計書 8 章、2026-10-17））: 値に見える区切り（`isValueLikePathSegment`）、
 * UUID の形、数字だけの区切り。空の区切りは ID でない。
 */
export const isRecordIdLikePathSegment = (segment: string): boolean => {
  if (segment.length === 0) {
    return false;
  }
  return isValueLikePathSegment(segment) || isRecordNumberLikeText(decodedOf(segment));
};

/**
 * LU-2: decode した文字が、番号の形（UUID の形か、数字だけ）か。path の型の最後の `{id}` の区切り（`pathShapeOf`）と、filter の値が番号の形か
 * （`valueIsRecordIdLike`）の唯一の決まり。値に見える区切り（`isValueLikePathSegment`）は型で伏せるので、ここには入れない。
 */
const isRecordNumberLikeText = (decoded: string): boolean => isUuidText(decoded) || DECIMAL_DIGITS.test(decoded);

/**
 * LU-2（設計書 5.2 の 4・5）: path の型の最後の区切りが `{id}`（`PATH_TEMPLATE_ID_SEGMENT`）か。分類（filter のない PATCH の更新、番号のある送り先への
 * POST）が使う。
 */
export const pathShapeEndsWithRecordId = (pathShape: string): boolean =>
  pathShape.split(PATH_SEPARATOR).at(-1) === PATH_TEMPLATE_ID_SEGMENT;

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
  // DEF-220: 承認したテストの Origin の区分も、番号ごと写す。
  if (origin?.kind === 'APPROVED_TEST' && Number.isSafeInteger(origin.index) && origin.index >= 0) {
    return Object.freeze({ kind: 'APPROVED_TEST', index: origin.index });
  }
  return origin?.kind === 'ALLOWED' ? Object.freeze({ kind: 'ALLOWED' }) : Object.freeze({ kind: 'OTHER' });
};

/**
 * path の型（値に見える区切りと、目印を含む区切りを伏せる。URL-LEN: 長さでは伏せない（前は 1,024 を超えたら全体を伏せた）。LU-2（設計書 5.2 の 1）: 伏せた後の**最後の区切り**が番号の形
 * （`isRecordNumberLikeText`）なら `{id}` にする（行ごとに型と digest が変わらないように）。途中の区切りの番号と、伏せ字の区切りは変えない。
 * `url-path-redaction.ts` の伏せ方は変えない（ログインの段と IPC も使うため）。
 */
const pathShapeOf = (pathname: string, markers: readonly string[]): string => {
  const segments = redactValueLikePathSegments(pathname)
    .split(PATH_SEPARATOR)
    .map((segment) => (carriesMarker(decodedOf(segment), markers) ? REDACTED : segment));
  const lastIndex = segments.length - 1;
  const last = segments[lastIndex] ?? '';
  if (lastIndex > 0 && last !== REDACTED && last.length > 0 && isRecordNumberLikeText(decodedOf(last))) {
    segments[lastIndex] = PATH_TEMPLATE_ID_SEGMENT;
  }
  return segments.join(PATH_SEPARATOR);
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
    filters.push(Object.freeze({
      name: safeName,
      operator,
      valueMatchesPagePath: operator !== 'OTHER' && lastId !== null && operand === lastId,
      valueIsRecordIdLike: operator !== 'OTHER' && isRecordNumberLikeText(operand),
    }));
  }
  filters.sort(compareApiFilterShapes);
  // L13（N25）: 名前と filter は数で切らない（前は `MAX_API_SHAPE_QUERY_NAMES` まで。省いた数の項目は 0 のまま。digest に入るので残す）。
  return { queryNames: Object.freeze(sortedTexts(names)), omittedQueryNameCount: 0, filters: Object.freeze(filters) };
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
      // L13（N25）: 長さでは伏せない（前は `MAX_API_SHAPE_MEDIA_TYPE_LENGTH` を超えたら伏せた）。
      contentType = MEDIA_TYPE_SHAPE.test(mediaType) && !carriesMarker(mediaType, markers)
        ? mediaType
        : REDACTED;
    } else if (name === API_PREFER_HEADER_NAME) {
      for (const item of apiPreferItemsOf(value)) {
        const shape = preferShapeOf(item);
        if (shape !== null) prefer.add(shape);
      }
    }
  }
  // 名前の重なりは、伏せる前の小文字の名前で除く（伏せた名前どうしは数のまま残す）。L13（N25）: 数で切らない（前は `MAX_API_SHAPE_HEADER_NAMES` まで）。
  return {
    headerNames: Object.freeze(sortedTexts([...names].map((name) => safeNameOf(name, markers)))),
    omittedHeaderNameCount: 0,
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

/**
 * ARR-1（設計書 `2026-11-08-beaksight-api-array-keys-design.md` 3.2 の 1）: 一覧の形の値の要素の情報（純粋。値は残さない）。型の記録と、書き込みの段の
 * 照合（ARR-2）が共用する唯一の数え方。入れ子の中は見ない。
 */
export const apiArrayElementsOf = (values: readonly unknown[]): ApiRequestArrayElements => {
  const types = new Set<ApiJsonValueType>();
  for (const value of values) {
    types.add(jsonTypeOf(value));
  }
  return Object.freeze({
    types: Object.freeze([...types].sort(compareCodeUnits)),
    count: values.length,
    nested: types.has('object') || types.has('array'),
    // L13 fix round 1: 文字の長さの上限は置かないので、常に偽。型の digest に入るので項目は残す（LZ-1: digest の版の決まりがないため、消さない）。
    textOverLimit: false,
  });
};

/** 文字か数の値に含まれる目印の番号（渡された一覧の位置）。 */
const markersInScalarOf = (value: unknown, markers: readonly string[]): number[] => {
  if (typeof value !== 'string' && typeof value !== 'number') return [];
  const text = String(value);
  return markers.flatMap((marker, index) => (text.includes(marker) ? [index] : []));
};

/**
 * ARR-5（設計書 2.4 の 1・5）: object の行の中の鍵の情報（名前の順。値は残さない）。中の値が object・array なら型だけを残す（中は見ない）。L13 fix round 1:
 * 中の鍵の数と文字の長さの上限（前は `MAX_API_ARRAY_OBJECT_KEYS`・`MAX_API_ARRAY_ELEMENT_TEXT_LENGTH`）は置かない。
 */
const innerKeysOf = (row: Readonly<Record<string, unknown>>, markers: readonly string[]): readonly ApiRequestArrayInnerKey[] => {
  const keys = Object.entries(row).map(([rawName, inner]) => Object.freeze({
    name: safeNameOf(rawName, markers),
    markers: Object.freeze(markersInScalarOf(inner, markers)),
    empty: inner === '' || inner === null,
    type: jsonTypeOf(inner),
  }));
  keys.sort((left, right) => compareCodeUnits(left.name, right.name));
  return Object.freeze(keys);
};

/** 本文の型（メモリの中で 1 回だけ読む。値は残さない）。 */
const bodyShapeOf = (
  body: ApiRequestBody,
  markers: readonly string[],
  isStateKeyName: ((name: string) => boolean) | undefined,
): ApiRequestBodyShape => {
  if (body.kind === 'NONE') return EMPTY_BODY('NONE');
  // L13（N25）: 大きさでは「読めない」にしない（前は `MAX_API_REQUEST_BODY_BYTES` を超えたら読まなかった）。
  if (body.kind !== 'TEXT' || typeof body.text !== 'string') return EMPTY_BODY('UNREADABLE');
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
    if (Array.isArray(value)) {
      // ARR-1: 一覧の鍵は要素の情報を持ち、要素（文字か数。入れ子の中は見ない）に入った目印を、一覧の中の印つきで残す。
      const elements = apiArrayElementsOf(value);
      const matched = new Set<number>();
      const positions: ApiRequestArrayPosition[] = [];
      let hasObjectRow = false;
      for (const element of value as readonly unknown[]) {
        const type = jsonTypeOf(element);
        if (type === 'object') {
          // ARR-5（設計書 2.4 の 1）: object の行は、中の鍵ごとの名前（伏せ方は最上位の鍵と同じ）・目印・空の値か・型を持つ（値は持たない）。
          hasObjectRow = true;
          const inner = innerKeysOf(element as Record<string, unknown>, markers);
          for (const index of inner.flatMap(({ markers: found }) => found)) matched.add(index);
          positions.push(Object.freeze({ markers: Object.freeze([]), empty: false, type, keys: inner }));
          continue;
        }
        const found = markersInScalarOf(element, markers);
        for (const index of found) matched.add(index);
        positions.push(Object.freeze({ markers: Object.freeze(found), empty: element === '' || element === null, type }));
      }
      // ARR-3（設計書 `2026-11-09-beaksight-api-array-rows-design.md` 2.2 の 1・5）: 一覧の中に目印があり、要素が 2 つ以上のときだけ位置の情報を持つ
      // （L13 fix round 1: 要素の数の上限は置かない）。ARR-5: object の行のある一覧は、行が 1 つでも持つ（中の鍵の対応のため）。
      const withPositions = matched.size > 0 && (elements.count >= 2 || hasObjectRow);
      keys.push(Object.freeze({ name, type: 'array' as const, elements: withPositions ? Object.freeze({ ...elements, positions: Object.freeze(positions) }) : elements }));
      if (matched.size > 0) {
        markerKeys.push(Object.freeze({ key: name, markers: Object.freeze([...matched].sort((left, right) => left - right)), inArray: true as const }));
      }
      continue;
    }
    keys.push(Object.freeze({ name, type: jsonTypeOf(value) }));
    const matched = markersInScalarOf(value, markers);
    if (matched.length > 0) markerKeys.push(Object.freeze({ key: name, markers: Object.freeze(matched) }));
  }
  keys.sort((left, right) => compareCodeUnits(left.name, right.name) || compareCodeUnits(left.type, right.type));
  markerKeys.sort((left, right) => compareCodeUnits(left.key, right.key));
  // L13（N25）: 鍵は数で切らない（前は `MAX_API_SHAPE_BODY_KEYS` まで。省いた数の項目は 0 のまま。digest に入るので残す）。
  return Object.freeze({
    kind: 'OBJECT',
    keys: Object.freeze(keys),
    omittedKeyCount: 0,
    markerKeys: Object.freeze(markerKeys),
    stateKeyPresent,
    // ARR-5 fix round 1（SREV-ARR2 の M2）: 本文の object（最上位と行の中）に同じ鍵が 2 回ある型は、印を持つ（ないときは項目を持たない。digest は変わらない）。
    ...(jsonTextHasDuplicateObjectKeys(body.text) ? { duplicateKeyPresent: true as const } : {}),
  });
};

/** 正しい JSON の文字列の、`start`（`"`）からの表記の終わり（閉じる `"` の次の位置。閉じなければ -1）。 */
const endOfJsonStringAt = (text: string, start: number): number => {
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
 * ARR-5（SREV-ARR2 の M2）: 正しい JSON の表記の中の object のどれかに、同じ鍵（escape を解いた名前）が 2 回あるか（`JSON.parse` は最後の鍵だけを残すので、
 * 表記で数える）。型の記録と、書き込みの段の照合（`src/safety/api-write-payload-policy.ts`）が共用する唯一の数え方。読めない表記は真（止める側）。
 */
export const jsonTextHasDuplicateObjectKeys = (text: string): boolean => {
  const stack: ({ readonly keys: Set<string>; expectKey: boolean } | null)[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      const end = endOfJsonStringAt(text, index);
      if (end < 0) return true;
      const top = stack[stack.length - 1];
      if (top !== undefined && top !== null && top.expectKey) {
        let key: unknown;
        try {
          key = JSON.parse(text.slice(index, end));
        } catch {
          return true;
        }
        if (typeof key !== 'string' || top.keys.has(key)) return true;
        top.keys.add(key);
        top.expectKey = false;
      }
      index = end;
      continue;
    }
    if (char === '{') {
      stack.push({ keys: new Set(), expectKey: true });
    } else if (char === '[') {
      stack.push(null);
    } else if (char === '}' || char === ']') {
      stack.pop();
    } else if (char === ',') {
      const top = stack[stack.length - 1];
      if (top !== undefined && top !== null) top.expectKey = true;
    }
    index += 1;
  }
  return false;
};

/** 文脈の目印を確かめる（文字列だけ。例外の文に値を入れない）。空の目印は比べない。L13（N25）: 数の上限（前は `MAX_API_SHAPE_MARKERS`）は置かない。 */
const markersOf = (markers: unknown): readonly string[] => {
  if (!Array.isArray(markers) || !markers.every((marker) => typeof marker === 'string')) {
    throw new TypeError('API request shape markers must be strings');
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
  const resourceType = typeof input.resourceType === 'string' && RESOURCE_TYPE_SHAPE.test(input.resourceType)
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
