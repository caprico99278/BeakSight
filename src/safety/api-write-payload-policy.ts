/**
 * 書き込みの段の、承認した API の要求の照合（T39a。Task 39 の設計書 `2026-10-17-beaksight-task-39-api-write-guard-design.md` 3.2、4 章）。純粋な関数で、
 * Guard が CDP の `Fetch.requestPaused`（サブリソースの Request の段階）の事実を渡して呼ぶ（Guard の組み込みは T39b）。form の照合
 * （`write-payload-policy.ts`）と同じ形で、JSON の本文を読むのは、このファイルだけ。
 *
 * 判定（`checkApiWritePayload`。上から順に調べ、最初に当たった理由を返す）:
 * - 承認した API の指定・生成した値・台帳の ID（`ApiWritePayloadExpectation`）が正しくなければ `EXPECTATION_INVALID`（fail-closed）: method が
 *   `API_WRITE_METHODS` でない、CREATE（`POST`）に filter・台帳の ID がある、UPDATE（`PATCH`）に台帳の ID がない、UPDATE が filter と path の番号の区切り
 *   （`{id}`）のどちらか 1 つだけを持つ形でない（LU-5。下の「path の形の更新」）、Origin が Origin の形でない、
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
 * - `FILTER_MISMATCH`: UPDATE の filter の値が `eq.<台帳の ID>` と完全に一致しない（`neq`・`in` などの演算子、値の書き換え）。DEF-198: ほかの filter
 *   （`spec.otherFilterNames`）の値が `eq.<期待の otherFilterValues の値>` と完全に一致しない（ほかの filter の名前は query の名前の集合に入る）。
 * - `HEADER_NOT_ALLOWED`: ページが付けたヘッダの名前（ブラウザが付ける名前 `isPageSuppliedHeaderName` を除いた、小文字の名前）が、承認した名前の
 *   集合の中にない。
 * - `CONTENT_TYPE_MISMATCH`: `Content-Type` の媒体の型（小文字）が承認と一致しない、ない、引数が `charset=utf-8` のほか。
 * - `PREFER_MISMATCH`: `Prefer` の項目（小文字、`,` で区切る）が閉じた一覧の値でない（upsert の `resolution=` を含む）か、項目の集合が承認と一致しない。
 * - 本文: `BODY_UNAVAILABLE`（bytes がない）、`BODY_TOO_LARGE`（L12b で大きさの上限を撤廃したので今は出ない。前の記録の読み方のために一覧に残す）、
 *   `BODY_MALFORMED`（UTF-8 でない、BOM、JSON でない）、`BODY_NOT_OBJECT`（最上位が object でない）、`BODY_DUPLICATE_KEY`（同じ鍵が 2 回。escape の
 *   違う書き方も同じ鍵）、`BODY_VALUE_NOT_SCALAR`（値が array か object。I21）、`BODY_KEY_UNEXPECTED`・`BODY_KEY_MISSING`（鍵の集合が、欄の鍵と
 *   ページが決める鍵の集合と完全に一致しない）、`BODY_VALUE_TYPE_MISMATCH`（値の JSON の型が承認の型と違う）、`BODY_VALUE_MISMATCH`（欄の鍵の値が、
 *   生成した値を `jsonValueOf` で変えたものと一致しない。number は正規の JSON の表記（`JSON.stringify`）と、本文の書かれたままの表記を比べるので、
 *   `42.0`・`4.2e1`・`-0` は止まる。string は escape を解いた値で比べる）。
 * T41c（Task 41 の設計書 3.3。API の更新）: 期待の `keptKeys`（保つ鍵と前の値）と `pageKeyPriorValues`（UPDATE のページが決める鍵の前の値）。保つ鍵は
 * 本文にあれば前の値と、UPDATE のページが決める鍵は必ず前の値と、欄の鍵と同じ比べ方で照らす（違えば `BODY_VALUE_TYPE_MISMATCH`・`BODY_VALUE_MISMATCH`）。
 * 保つ鍵が本文になくても通す。承認の鍵の集合の外の状態の語の鍵は `BODY_STATE_KEY_UNEXPECTED`（`BODY_KEY_UNEXPECTED` より先）。UPDATE の結果の
 * `pageKeyValues` は空（値は前の値と同じなので、前の値を記録に残さない）。前の値は、結果にも例外の文にも残さない。
 * LU-9（設計書 `2026-11-02-beaksight-list-row-update-design.md` 5.3 の 2）: 前の値を後から入れる印（`deferredPriorValues`）のある期待は、前の値を入れる
 * （`apiWriteExpectationWithPriorValues`）まで `EXPECTATION_INVALID`。
 * ARR-2（設計書 `2026-11-08-beaksight-api-array-keys-design.md` 3.4）: 登録の一覧の鍵（array）。欄に対応づけた一覧の鍵（型 array）は、本文の値が
 * `[生成した値]`（要素は生成した文字 1 つ。生成した値の型は `apiKeyFieldValueTypeOf`）と完全一致すること（違えば `BODY_VALUE_MISMATCH`）。ページが決める
 * 一覧の鍵（型 array と承認した要素の形 `elements`）は、入れ子がなく（入れ子は `BODY_VALUE_NOT_SCALAR`）、要素の型の集合と数が承認と同じであること
 * （違えば `BODY_VALUE_MISMATCH`。L13 fix round 1: 数と文字の長さの上限は置かない）。値は照らさずに返す。数え方は型の作り手と同じ部品
 * （`apiArrayElementsOf`）。ARR-3（設計書 `2026-11-09-beaksight-api-array-rows-design.md` 2.2 の 4）: 位置の役（`positions`）を持つ欄の一覧の鍵は、位置ごとに
 * 欄は生成した値・空の位置は承認した空の値と完全一致し、要素の数が承認と同じこと（違えば `BODY_VALUE_MISMATCH`。役が閉じた一覧でない・欄がちょうど 1 つで
 * ない・scalar の鍵が役を持つのは期待の誤り）。承認していない一覧の鍵（scalar の鍵・承認の外の鍵の一覧）と object は、今のまま `BODY_VALUE_NOT_SCALAR`。期待の誤り:
 * ページが決める一覧の鍵に要素の形がない・形が上限の外か scalar でない型を持つ、scalar の鍵が要素の形を持つ、更新（`PATCH`）が一覧の鍵を持つ。
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
  API_ARRAY_FIELD_POSITIONS,
  type ApiArrayRowRole,
  apiArrayElementPathOf,
  jsonTextHasDuplicateObjectKeys,
  apiArrayElementsOf,
  apiArrayFieldPositionValueOf,
  type ApiArrayFieldPosition,
  apiContentTypePartsOf,
  apiPreferItemsOf,
  hasApiProcedureCallSegment,
  isPageSuppliedHeaderName,
  pathShapeEndsWithRecordId,
  type ApiJsonValueType,
  type ApiPreferShape,
} from '../core/api-request-shape.js';
import { isRecord } from '../core/guards.js';
import { apiKeyFieldValueTypeOf, jsonValueOf } from '../core/json-value.js';
import { PATH_TEMPLATE_ID_SEGMENT, isUsableRecordId } from '../core/record-id-path-pattern.js';
import { REDACTED } from '../core/redaction.js';
import { isSecretUrlQueryParameterName } from '../core/secret-query-names.js';
import { compareCodeUnits } from '../core/text.js';
import { canonicalHttpOriginOf } from '../crawl/normalize-url.js';
import { isMethodOverrideFieldName } from '../discovery/candidate-contracts.js';
import { fieldNameHasStateWord, isApiRowKeyNameUsable } from '../discovery/classify.js';
import { concretePathOfTemplate } from '../discovery/fingerprint.js';
import { isApiWriteEndpointUrl } from './request-policy.js';
import { WRITE_PAYLOAD_BLOCK_REASONS, indexedListCopyOf, type WritePayloadBlockReason } from './write-payload-policy.js';

/*
 * LU-5（設計書 `2026-11-02-beaksight-list-row-update-design.md` 4.0 の D1、5.3 の 1）: path の形の更新。filter のない UPDATE は、path の型の最後の区切りが
 * `{id}`（型にちょうど 1 つ）で、台帳の ID が登録の ID として使える形（`isUsableRecordId`）のときだけ受け、`{id}` を台帳の ID にした具体的な path で
 * `ENDPOINT_MISMATCH` の完全一致を行う（filter の照合はしない。query の名前の集合と本文の照合は今のまま）。filter と `{id}` の両方、`{id}` が 2 つ以上・
 * 最後でない、filter も `{id}` もない UPDATE は `EXPECTATION_INVALID`。
 */

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
/** ARR-2: 照合が返すページが決める鍵の値（scalar か、ページが決める一覧の鍵の scalar の一覧）。 */
export type ApiWritePageKeyValue = ApiJsonScalarValue | readonly ApiJsonScalarValue[];

/** ARR-2: ページが決める一覧の鍵の、承認した要素の形（シナリオの `ScenarioApiArrayElements` の構造）。 */
export interface ApiWriteArrayElements {
  readonly types: readonly ApiJsonValueType[];
  readonly count: number;
}

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
  /**
   * 欄の鍵（鍵と JSON の型。欄の識別は照らさない。ARR-2: 型 array は `[生成した値]`。ARR-3: 型 array で位置の役 `positions` を持てば、位置ごとに
   * 欄は生成した値・空の位置は承認した空の値）。
   */
  readonly keyFields: readonly {
    readonly key: string;
    readonly type: ApiJsonValueType;
    readonly positions?: readonly ApiArrayFieldPosition[] | undefined;
    /** ARR-4: 要素の位置の欄（`key` は道 `key[i]`）。同じ一覧の鍵の欄をまとめて、本文の一覧の位置ごとに照らす。ARR-5: 行の中の鍵は `name`（道 `key[i].name`）。 */
    readonly element?: { readonly key: string; readonly index: number; readonly name?: string | undefined } | undefined;
    /** ARR-5: 行の中の鍵の欄の、行ごとの中の鍵の役。 */
    readonly rows?: readonly (readonly ApiArrayRowRole[])[] | undefined;
  }[];
  /** ページが決める鍵（鍵と JSON の型。値は照らさず、返す。ARR-2: 型 array は承認した要素の形 `elements` を持つ）。 */
  readonly pageKeys: readonly { readonly key: string; readonly type: ApiJsonValueType; readonly elements?: ApiWriteArrayElements | undefined }[];
  /** 許すヘッダの名前（ページが付ける名前だけ。小文字）。 */
  readonly headerNames: readonly string[];
  /** UPDATE の filter の名前（CREATE と、LU-5 の path の形の更新（path の型の最後の区切りが `{id}`）は null）。 */
  readonly filterName: string | null;
  /**
   * DEF-198（設計書 `2026-11-02-beaksight-list-row-update-design.md` 5.9 の 3・4）: UPDATE の、番号の filter のほかの filter の名前（所属の絞り込みなど。
   * 省けばなし）。照らす値は期待の `otherFilterValues`。
   */
  readonly otherFilterNames?: readonly string[] | undefined;
  /**
   * DEF-203（設計書 `2026-11-02-beaksight-list-row-update-design.md` 5.10 の 1）: UPDATE の、台帳の登録の値と照らすページが決める鍵の名前（ほかの filter のある
   * 更新だけ。省けばなし）。照らす値は期待の `ledgerKeyValues`。
   */
  readonly ledgerPageKeys?: readonly string[] | undefined;
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
  /** UPDATE の台帳の ID（CREATE は null）。LU-5 の path の形の更新では、登録の ID として使える形（`isUsableRecordId`）。 */
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
  /**
   * LU-9（設計書 `2026-11-02-beaksight-list-row-update-design.md` 4.0.1 の K1、5.3 の 2）: 前の値を後から入れる印（一覧の行から開く更新）。印のある期待は、
   * 前の値（`keptKeys`・`pageKeyPriorValues`）を持たず、照合は前の値を入れるまで `EXPECTATION_INVALID` で止める（fail-closed）。前の値は
   * `apiWriteExpectationWithPriorValues` で 1 回だけ入れる（Guard の口は `WriteStageMonitor.supplyApiPriorValues`）。鍵の集合は、期待を作る時に決まる。
   */
  readonly deferredPriorValues?: ApiWriteDeferredPriorValues | undefined;
  /**
   * DEF-198（設計書 5.9 の 3・4）: ほかの filter（`spec.otherFilterNames`）ごとの照らす値（同じ点検で BeakSight が登録した行の、同じ名前のページが決めた値。
   * string か number。名前ごとにちょうど 1 つ）。query の値は `eq.<値>` と完全一致、本文の同じ名前のページが決める鍵の前の値はこの値と同じ表記であること、
   * 本文の番号の filter と同じ名前のページが決める鍵の前の値は台帳の ID と同じ表記であることを求める。ほかの filter のない期待は省く（持てば期待の誤り）。
   * メモリの中だけで渡し、記録しない（結果にも誤りの文にも入れない）。
   */
  readonly otherFilterValues?: readonly ApiWritePriorValue[] | undefined;
  /**
   * DEF-203（設計書 5.10 の 1）: 台帳の登録の値と照らす鍵（`spec.ledgerPageKeys`）ごとの値（同じ点検で BeakSight が登録した行の、同じ名前のページが決めた値。
   * JSON の scalar。名前ごとにちょうど 1 つで、型はページが決める鍵の宣言の型と同じ）。その鍵の前の値（`pageKeyPriorValues`）はこの値と型も表記も同じであることを
   * 求める（本文の値は、その前の値と完全一致を求める）。照らす鍵のない期待は省く（持てば期待の誤り）。メモリの中だけで渡し、記録しない。
   */
  readonly ledgerKeyValues?: readonly ApiWritePriorValue[] | undefined;
}

/**
 * LU-9: 前の値を後から入れる印の中身。`keptKeys` は保つ鍵の名前（承認の時の保つ欄の名前。重ならない空でない名前）。ページが決める鍵の名前は、承認した API の
 * 指定の `spec.pageKeys`。後から入れられるのは値だけで、鍵を足す・減らす・違う鍵の集合は拒む。
 */
export interface ApiWriteDeferredPriorValues {
  readonly keptKeys: readonly string[];
}

/** LU-9: 後から入れる前の値（形は `ApiWritePayloadExpectation` の `keptKeys`・`pageKeyPriorValues` と同じ）。 */
export interface ApiWriteSuppliedPriorValues {
  readonly keptKeys: readonly ApiWritePriorValue[];
  readonly pageKeyPriorValues: readonly ApiWritePriorValue[];
}

/**
 * T41c・LU-SFIX1（LU-SREV1 の Minor-1・2）: 更新の前の値の一覧の写し（唯一の写し方。Guard の期待の写しと前の値の口、`apiWriteExpectationWithPriorValues`
 * が使う）。項目ごとに `key` と `value` を 1 回だけ読み、凍らせる。値は scalar だけを残し、ほかは照合が拒む空の object にする。一覧でなければ照合が拒む
 * 空の object（`{}`）。項目が object でなければ、そのまま（照合が拒む）。
 */
export const apiWritePriorValuesCopyOf = (list: unknown): unknown => indexedListCopyOf(list, (entry) => {
  if (typeof entry !== 'object' || entry === null) {
    return entry;
  }
  const hasValue = Object.hasOwn(entry, 'value');
  const { key, value } = entry as { readonly key?: unknown; readonly value?: unknown };
  const scalar = value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === undefined;
  return Object.freeze(hasValue
    ? { key: typeof key === 'string' ? key : null, value: scalar ? value : Object.freeze({}) }
    : { key: typeof key === 'string' ? key : null });
}) ?? Object.freeze({});

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
  | { readonly decision: 'ALLOW'; readonly pageKeyValues: Readonly<Record<string, ApiWritePageKeyValue>> }
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
  /** string なら値そのもの、ほかの型なら JSON の表記。ARR-2: 型 array（欄の一覧）は、欄の位置の要素の文字そのもの。 */
  readonly text: string;
  /**
   * ARR-3・ARR-4: 型 array（欄の一覧）の、位置ごとに求める値（要素の順。欄の位置は生成した値、空の位置は承認した空の値）。省けば `[text]`（欄の要素 1 つ。
   * DEF-226 の形）。
   */
  readonly elements?: readonly (string | null)[];
  /** ARR-5: 型 array（object の行の一覧）の、行ごとの中の鍵と求める値（行の順、中の鍵の名前の順）。行の数・中の鍵の集合・値を完全一致で照らす。 */
  readonly rows?: readonly (readonly { readonly name: string; readonly value: string | null }[])[];
}

/** ARR-2: ページが決める一覧の鍵の、確かめた要素の形（型の集合はコード単位の順の表記）。 */
interface ExpectedArrayElements {
  readonly typesText: string;
  readonly count: number;
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
  /** ARR-2: ページが決める一覧の鍵ごとの、承認した要素の形（登録だけ）。 */
  readonly pageArrays: ReadonlyMap<string, ExpectedArrayElements>;
  /** T41c: 保つ鍵ごとの前の値の照らす形（本文にあれば完全一致。なければ通す）。CREATE は空。 */
  readonly keptKeys: ReadonlyMap<string, ExpectedKeyField>;
  /** T41c: UPDATE のページが決める鍵ごとの前の値の照らす形（完全一致）。CREATE は空（値を照らさずに返す）。 */
  readonly pageKeyPriors: ReadonlyMap<string, ExpectedKeyField>;
  /** DEF-198: ほかの filter ごとの照らす形（`eq.<表記>` と完全一致）。ほかの filter のない期待は空。 */
  readonly otherFilters: ReadonlyMap<string, ExpectedKeyField>;
}

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isScalarType = (value: unknown): value is ApiJsonValueType => (SCALAR_TYPES as readonly unknown[]).includes(value);
const hasDuplicates = (values: readonly string[]): boolean => new Set(values).size !== values.length;

/** ARR-2: 一覧の JSON の型。 */
const ARRAY_TYPE: ApiJsonValueType = 'array';

/** ARR-2: 要素の型の集合の比べる表記（コード単位の順に並べた JSON）。 */
const elementTypesTextOf = (types: readonly string[]): string => JSON.stringify([...types].sort(compareCodeUnits));

/** ARR-3: 1 つの鍵の欄の一覧の、位置ごとに求める値（役の値は契約の 1 か所 `apiArrayFieldPositionValueOf`）。 */
const expectedElementsOf = (positions: readonly ApiArrayFieldPosition[], text: string): readonly (string | null)[] =>
  Object.freeze(positions.map((position) => apiArrayFieldPositionValueOf(position, text)));

/**
 * ARR-3（設計書 `2026-11-09-beaksight-api-array-rows-design.md` 2.2 の 4）: 欄の鍵の位置の役を確かめる（省けば undefined。型が array で、2 つ以上の
 * 閉じた一覧の役の並びで、欄 `FIELD` がちょうど 1 つならその写し。ほかは null（期待の誤り。scalar の鍵の役を含む））。L13 fix round 1: 数の上限（前は
 * `MAX_API_ARRAY_ELEMENTS`）は置かない（本文の一覧は、役の数と完全に一致することを `fieldListMatches` が求める）。
 */
const expectedPositionsOf = (type: ApiJsonValueType, positions: unknown, singleField = true): readonly ApiArrayFieldPosition[] | undefined | null => {
  if (positions === undefined) {
    return undefined;
  }
  if (type !== ARRAY_TYPE || !Array.isArray(positions) || positions.length < 2
    || !positions.every((position) => (API_ARRAY_FIELD_POSITIONS as readonly unknown[]).includes(position))) {
    return null;
  }
  // ARR-4: 要素の位置の欄（`singleField` が偽）は、欄の位置が 1 つ以上。1 つの鍵の欄の一覧は、ちょうど 1 つ。
  const fields = positions.filter((position) => position === 'FIELD').length;
  if (singleField ? fields !== 1 : fields < 1) {
    return null;
  }
  return Object.freeze([...positions as ApiArrayFieldPosition[]]);
};

/** ARR-4: 要素の位置の欄の、本文の一覧の鍵と位置（期待の項目 `element` を確かめた形。形が違えば null）。 */
const expectedElementOf = (
  entry: { readonly key: string; readonly type: ApiJsonValueType },
  element: unknown,
): { readonly key: string; readonly index: number; readonly name?: string } | null => {
  if (!isRecord(element) || !isNonEmptyString(element.key) || typeof element.index !== 'number' || !Number.isInteger(element.index)
    // L13 fix round 1: 位置の上限（前は `element.index >= MAX_API_ARRAY_ELEMENTS`）は置かない。負でないことは今どおり求める。
    || element.index < 0 || entry.type !== ARRAY_TYPE || isMethodOverrideFieldName(element.key)
    || (element.name !== undefined && !isNonEmptyString(element.name))) {
    return null;
  }
  // ARR-5: 行の中の鍵の欄は、道 `key[i].name`。
  const name = element.name as string | undefined;
  if (entry.key !== apiArrayElementPathOf(element.key, element.index, name)) {
    return null;
  }
  return name === undefined ? { key: element.key, index: element.index } : { key: element.key, index: element.index, name };
};

/**
 * ARR-5（設計書 `2026-11-09-beaksight-api-array-rows-design.md` 2.4 の 3・5）: 行の中の鍵の欄の、行ごとの中の鍵の役を確かめる（形が違えば null）。行は 1 つ以上、
 * 1 行の中の鍵は 1 つ以上（名前は空でなく重ならず、コード単位の順で、どの行も同じ組）、役は閉じた一覧の値で、欄は 1 つ以上。L13 fix round 1: 行・中の鍵・
 * 葉の数の上限（前は `MAX_API_ARRAY_ELEMENTS`・`MAX_API_ARRAY_OBJECT_KEYS`・`MAX_API_ARRAY_LEAVES`）は置かない（本文の行は `objectRowsMatch` が完全な一致を求める）。
 */
const expectedRowsOf = (rows: unknown): readonly (readonly ApiArrayRowRole[])[] | null => {
  if (!Array.isArray(rows) || rows.length < 1) {
    return null;
  }
  const copy: ApiArrayRowRole[][] = [];
  let firstNames: string | null = null;
  for (const row of rows as readonly unknown[]) {
    if (!Array.isArray(row) || row.length < 1
      || !row.every((inner) => isRecord(inner) && isNonEmptyString(inner.name) && (API_ARRAY_FIELD_POSITIONS as readonly unknown[]).includes(inner.role)
        // ARR-5 fix round 1（SREV-ARR2 の I1）: 中の鍵の名前は、承認と同じ唯一の判定で使える名前だけ（重ねの守り）。
        && isApiRowKeyNameUsable(inner.name))) {
      return null;
    }
    const roles = (row as readonly { readonly name: string; readonly role: ApiArrayFieldPosition }[]).map(({ name, role }) => ({ name, role }));
    const names = roles.map(({ name }) => name);
    const namesText = JSON.stringify(names);
    if (hasDuplicates(names) || namesText !== JSON.stringify([...names].sort(compareCodeUnits)) || (firstNames !== null && namesText !== firstNames)) {
      return null;
    }
    firstNames = namesText;
    copy.push(roles);
  }
  const leaves = copy.flat();
  return !leaves.some(({ role }) => role === 'FIELD') ? null : Object.freeze(copy.map((row) => Object.freeze(row)));
};

/**
 * ARR-2: ページが決める鍵の要素の形を確かめる（型が array でなく形もなければ undefined。型が array で、形が scalar の型の重ならない集合と、
 * 0 以上の数ならその形。ほかは null（期待の誤り））。L13 fix round 1: 数の上限（前は `MAX_API_ARRAY_ELEMENTS`）は置かない（本文の要素の数は承認と同じことを求める）。
 */
const expectedArrayElementsOf = (type: ApiJsonValueType, elements: unknown): ExpectedArrayElements | undefined | null => {
  if (type !== ARRAY_TYPE) {
    return elements === undefined ? undefined : null;
  }
  if (!isRecord(elements) || !Array.isArray(elements.types) || !elements.types.every(isScalarType) || hasDuplicates(elements.types as string[])
    || typeof elements.count !== 'number' || !Number.isInteger(elements.count) || elements.count < 0
    || (elements.count === 0) !== (elements.types.length === 0)) {
    return null;
  }
  return { typesText: elementTypesTextOf(elements.types as string[]), count: elements.count };
};

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

/**
 * DEF-198（設計書 `2026-11-02-beaksight-list-row-update-design.md` 5.9 の 3）: ほかの filter の名前と照らす値を確かめ、名前ごとの照らす形にする（どちらも
 * 省けば空。正しくなければ null）。名前は UPDATE の filter の更新だけが持て、空でない重ならない名前で、番号の filter・閉じた一覧の query の名前・upsert の印・
 * 伏せた名前と重ならない。値は名前ごとにちょうど 1 つの、空でない string か number（前の値と同じ写し方 `priorValuesOf`）。
 */
const otherFiltersOf = (
  names: unknown,
  values: unknown,
  isUpdate: boolean,
  filterName: string | null,
): ReadonlyMap<string, ExpectedKeyField> | null => {
  if (names === undefined) {
    return values === undefined ? new Map() : null;
  }
  const reserved: readonly unknown[] = [...API_SELECTION_QUERY_NAMES, ...API_UPSERT_QUERY_NAMES, REDACTED];
  if (!isUpdate || filterName === null || !Array.isArray(names) || names.length === 0 || !names.every(isNonEmptyString)
    || hasDuplicates(names as string[]) || names.some((name) => name === filterName || reserved.includes(name) || isMethodOverrideFieldName(name as string))) {
    return null;
  }
  const priors = priorValuesOf(values);
  if (priors === null || values === undefined || priors.size !== names.length || (names as string[]).some((name) => {
    const prior = priors.get(name);
    return prior === undefined || (prior.type !== 'string' && prior.type !== 'number') || prior.text.length === 0;
  })) {
    return null;
  }
  return priors;
};

/**
 * DEF-203（設計書 5.10 の 1）: 台帳の登録の値と照らす鍵の名前と値を確かめ、名前ごとの照らす形にする（どちらも省けば空。正しくなければ null）。名前はほかの filter
 * のある UPDATE だけが持て、空でない重ならない名前で、ページが決める鍵の中の、番号の filter・ほかの filter と重ならない名前。値は名前ごとにちょうど 1 つの JSON の
 * scalar で、型はページが決める鍵の宣言の型と同じ（前の値と同じ写し方 `priorValuesOf`）。
 */
const ledgerPageKeysOf = (
  names: unknown,
  values: unknown,
  isUpdate: boolean,
  filterName: string | null,
  otherFilters: ReadonlyMap<string, ExpectedKeyField>,
  pageKeys: ReadonlyMap<string, ApiJsonValueType>,
): ReadonlyMap<string, ExpectedKeyField> | null => {
  if (names === undefined) {
    return values === undefined ? new Map() : null;
  }
  if (!isUpdate || otherFilters.size === 0 || !Array.isArray(names) || names.length === 0 || !names.every(isNonEmptyString)
    || hasDuplicates(names as string[]) || (names as string[]).some((name) => name === filterName || otherFilters.has(name) || !pageKeys.has(name))) {
    return null;
  }
  const priors = priorValuesOf(values);
  if (priors === null || values === undefined || priors.size !== names.length
    || (names as string[]).some((name) => priors.get(name)?.type !== pageKeys.get(name))) {
    return null;
  }
  return priors;
};

/**
 * 照らす path（正しくなければ null）。CREATE と filter の更新は、承認の path の型のまま。LU-5（設計書 5.3 の 1。D1）: filter のない更新（path に番号が
 * 入る形）は、型の最後の区切りが `{id}`（`PATH_TEMPLATE_ID_SEGMENT`。型にちょうど 1 つ。分類と同じ部品 `pathShapeEndsWithRecordId`）で、台帳の ID が
 * 登録の ID として使える形（`isUsableRecordId`。path の 1 区切りに入れて安全な閉じた形）のときだけ受け、`{id}` を台帳の ID にした具体的な path（型の
 * owner の `concretePathOfTemplate`）にする（どの 1 区切りにも当てる照合にはしない）。filter の更新の型に `{id}` があれば期待の誤り（filter と path の
 * 番号の両方を持つ期待）。
 */
const approvedPathOf = (pathShape: string, isUpdate: boolean, filterName: string | null, recordId: string | null): string | null => {
  if (!isUpdate) {
    return pathShape;
  }
  if (filterName !== null) {
    return pathShape.includes(PATH_TEMPLATE_ID_SEGMENT) ? null : pathShape;
  }
  if (!isUsableRecordId(recordId) || !pathShapeEndsWithRecordId(pathShape)) {
    return null;
  }
  return concretePathOfTemplate(pathShape, recordId);
};

/**
 * LU-5（設計書 5.3 の 1、fix round 1 の案 A）: 照合へ回す要求の path（Guard の要求の判定 `isAllowedApiWrite` と、中継の承認の送信の数え方が完全一致で
 * 比べる path）。照合が照らす path と同じ部品（`approvedPathOf`）の唯一の公開の口。path の形の更新は `{id}` を台帳の ID にした具体的な path、ほか
 * （CREATE と filter の更新）は承認の path の型のまま。期待の形が読めない、または path の形の更新の期待が正しくないときは null（呼び出し側は、照らす
 * path がないものとして fail-closed に扱う）。投げない。窓の前の「承認した送信先とその下」の守りは、型の path（`pathShape`）のまま使う。
 */
export const apiWriteCheckPathOf = (expectation: ApiWritePayloadExpectation): string | null => {
  try {
    const request: unknown = isRecord(expectation) && isRecord(expectation.spec) ? expectation.spec.request : undefined;
    if (!isRecord(request) || !isPathShape(request.pathShape)) {
      return null;
    }
    const filterName: unknown = expectation.spec.filterName;
    const recordId: unknown = expectation.recordId;
    return approvedPathOf(
      request.pathShape,
      request.method === 'PATCH',
      typeof filterName === 'string' ? filterName : null,
      typeof recordId === 'string' ? recordId : null,
    );
  } catch {
    return null;
  }
};

/** 期待を確かめる（正しくなければ null）。 */
const acceptedExpectationOf = (expectation: unknown): AcceptedExpectation | null => {
  if (!isRecord(expectation) || !isRecord(expectation.spec) || !isRecord(expectation.values)) {
    return null;
  }
  const {
    spec, values, recordId, keptKeys: keptKeyList, pageKeyPriorValues, deferredPriorValues, otherFilterValues, ledgerKeyValues,
  } = expectation as unknown as ApiWritePayloadExpectation;
  // LU-9: 前の値を後から入れる印のある期待は、前の値を入れるまで照らせない（fail-closed）。
  if (deferredPriorValues !== undefined) {
    return null;
  }
  const { request } = spec;
  if (!isRecord(request) || !(API_WRITE_METHODS as readonly unknown[]).includes(request.method)) {
    return null;
  }
  const isUpdate = request.method === 'PATCH';
  const filterName = spec.filterName;
  if (isUpdate ? !isNonEmptyString(recordId) || (filterName !== null && !isNonEmptyString(filterName))
    : filterName !== null || recordId !== null) {
    return null;
  }
  const approvedOrigin: unknown = request.origin;
  // T39R-fix（M-4）: 手続きの呼び出しの path は、分類と同じ部品（decode と大文字・小文字の畳み込み）で見て、期待の誤りにする（I21）。
  if (typeof approvedOrigin !== 'string' || !isOriginText(approvedOrigin) || !isPathShape(request.pathShape)
    || hasApiProcedureCallSegment(request.pathShape)) {
    return null;
  }
  const path = approvedPathOf(request.pathShape, isUpdate, filterName, recordId);
  if (path === null) {
    return null;
  }
  const queryNames = request.queryNames as unknown;
  if (!Array.isArray(queryNames) || !queryNames.every((name) => (API_SELECTION_QUERY_NAMES as readonly unknown[]).includes(name))
    || hasDuplicates(queryNames as string[])) {
    return null;
  }
  if (isUpdate && filterName !== null && ([...API_SELECTION_QUERY_NAMES, ...API_UPSERT_QUERY_NAMES] as readonly unknown[]).includes(filterName)) {
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
  const pageArrays = new Map<string, ExpectedArrayElements>();
  // ARR-4: 期待の欄の鍵の名前（道を含む）と、要素の位置の欄の本文の一覧の鍵ごとのまとまり。
  const seenKeys = new Set<string>();
  const listFields = new Map<string, { readonly positions: readonly ApiArrayFieldPosition[]; readonly texts: Map<number, string> }>();
  // ARR-5: 行の中の鍵の欄の、本文の一覧の鍵ごとのまとまり（`[行, 中の鍵]` の JSON ごとの生成した値）。
  const rowFields = new Map<string, { readonly rows: readonly (readonly ApiArrayRowRole[])[]; readonly texts: Map<string, string> }>();
  // ARR-2: 一覧の鍵（array）は登録だけ。
  const usableKey = (entry: unknown): entry is { readonly key: string; readonly type: ApiJsonValueType } => isRecord(entry)
    && isNonEmptyString(entry.key) && (isScalarType(entry.type) || (entry.type === ARRAY_TYPE && !isUpdate)) && !isMethodOverrideFieldName(entry.key)
    && !keyFields.has(entry.key) && !pageKeys.has(entry.key) && !seenKeys.has(entry.key);
  for (const entry of keyFieldList) {
    if (!usableKey(entry) || !Object.hasOwn(values, entry.key)) {
      return null;
    }
    // ARR-2: 欄の一覧の鍵の生成した値は、要素の文字（`apiKeyFieldValueTypeOf`）。照らす形は、型 array と、ただ 1 つの要素の文字。
    const expected = expectedKeyFieldOf(values[entry.key], apiKeyFieldValueTypeOf(entry.type));
    const rawElement = (entry as { readonly element?: unknown }).element;
    const rawRows = (entry as { readonly rows?: unknown }).rows;
    // ARR-3: 欄の一覧の位置の役（省けば要素 1 つ）。ARR-4: 要素の位置の欄は、一覧の全体の役（欄の位置は 1 つ以上）を必ず持つ。
    const positions = expectedPositionsOf(entry.type, (entry as { readonly positions?: unknown }).positions, rawElement === undefined);
    if (expected === null || positions === null || seenKeys.has(entry.key)) {
      return null;
    }
    seenKeys.add(entry.key);
    if (rawRows !== undefined || (isRecord(rawElement) && rawElement.name !== undefined)) {
      // ARR-5（設計書 2.4）: 行の中の鍵の欄（道 `key[i].name`）は、行の役を必ず持ち（位置の役は持たない）、本文の一覧の鍵ごとにまとめる。同じ一覧の欄は
      // 同じ行の役を持ち、その中の鍵は欄で、欄ごとにちょうど 1 つ。
      const element = expectedElementOf(entry, rawElement);
      const rows = expectedRowsOf(rawRows);
      if (element?.name === undefined || rows === null || positions !== undefined || listFields.has(element.key)
        || rows[element.index]?.some(({ name, role }) => name === element.name && role === 'FIELD') !== true) {
        return null;
      }
      const group = rowFields.get(element.key) ?? { rows, texts: new Map<string, string>() };
      const slot = JSON.stringify([element.index, element.name]);
      if (JSON.stringify(group.rows) !== JSON.stringify(rows) || group.texts.has(slot)) {
        return null;
      }
      group.texts.set(slot, expected.text);
      rowFields.set(element.key, group);
      continue;
    }
    if (rawElement === undefined) {
      keyFields.set(entry.key, { type: entry.type, text: expected.text, ...(positions === undefined ? {} : { elements: expectedElementsOf(positions, expected.text) }) });
      continue;
    }
    // ARR-4（設計書 `2026-11-09-beaksight-api-array-rows-design.md` 2.3）: 要素の位置の欄（道 `key[i]`）は、本文の一覧の鍵ごとにまとめる。同じ一覧の欄は同じ
    // 役を持ち、その位置は欄の位置で、欄の位置ごとにちょうど 1 つ。
    const element = expectedElementOf(entry, rawElement);
    if (element === null || positions === undefined || positions[element.index] !== 'FIELD' || rowFields.has(element.key)) {
      return null;
    }
    const group = listFields.get(element.key) ?? { positions, texts: new Map<number, string>() };
    if (JSON.stringify(group.positions) !== JSON.stringify(positions) || group.texts.has(element.index)) {
      return null;
    }
    group.texts.set(element.index, expected.text);
    listFields.set(element.key, group);
  }
  for (const [listKey, { positions, texts }] of listFields) {
    const fieldIndexes = positions.flatMap((position, index) => (position === 'FIELD' ? [index] : []));
    if (keyFields.has(listKey) || seenKeys.has(listKey) || fieldIndexes.length !== texts.size
      || fieldIndexes.some((index) => !texts.has(index))) {
      return null;
    }
    keyFields.set(listKey, {
      type: ARRAY_TYPE,
      text: '',
      elements: Object.freeze(positions.map((position, index) => apiArrayFieldPositionValueOf(position, texts.get(index) ?? ''))),
    });
  }
  // ARR-5: 行の中の鍵の欄のまとまり。行の役の欄ごとに、ちょうど 1 つの欄の鍵がある。
  for (const [listKey, { rows, texts }] of rowFields) {
    const slots = rows.flatMap((row, index) => row.flatMap(({ name, role }) => (role === 'FIELD' ? [JSON.stringify([index, name])] : [])));
    if (keyFields.has(listKey) || seenKeys.has(listKey) || listFields.has(listKey) || slots.length !== texts.size || slots.some((slot) => !texts.has(slot))) {
      return null;
    }
    keyFields.set(listKey, {
      type: ARRAY_TYPE,
      text: '',
      rows: Object.freeze(rows.map((row, index) => Object.freeze(row.map(({ name, role }) => Object.freeze({
        name,
        value: apiArrayFieldPositionValueOf(role, texts.get(JSON.stringify([index, name])) ?? ''),
      }))))),
    });
  }
  for (const entry of pageKeyList) {
    if (!usableKey(entry) || isSecretUrlQueryParameterName(entry.key)) {
      return null;
    }
    // ARR-2: ページが決める一覧の鍵は、承認した要素の形を持つ（scalar の鍵は持たない）。
    const elements = expectedArrayElementsOf(entry.type, (entry as { readonly elements?: unknown }).elements);
    if (elements === null) {
      return null;
    }
    if (elements !== undefined) {
      pageArrays.set(entry.key, elements);
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
  // DEF-198（設計書 5.9 の 3・4）: ほかの filter の名前と照らす値。ほかの filter があるときは、本文の番号の filter と同じ名前のページが決める鍵の前の値は台帳の ID、
  // ほかの filter と同じ名前のページが決める鍵の前の値はその filter の値と同じ表記であること（違えば期待の誤り。本文の値はこの前の値と完全一致を求める）。
  const otherFilters = otherFiltersOf(spec.otherFilterNames, otherFilterValues, isUpdate, filterName);
  if (otherFilters === null || [...otherFilters.keys()].some((name) => (queryNames as readonly unknown[]).includes(name))) {
    return null;
  }
  if (otherFilters.size > 0 && [...pageKeys.keys()].some((key) => (key === filterName && pageKeyPriors.get(key)?.text !== recordId)
    || (otherFilters.has(key) && pageKeyPriors.get(key)?.text !== otherFilters.get(key)?.text))) {
    return null;
  }
  // DEF-203（設計書 5.10 の 1）: 台帳の登録の値と照らす鍵は、前の値がその値と型も表記も同じであること（違えば期待の誤り。本文の値はこの前の値と完全一致を求める）。
  const ledgerKeys = ledgerPageKeysOf(spec.ledgerPageKeys, ledgerKeyValues, isUpdate, filterName, otherFilters, pageKeys);
  if (ledgerKeys === null || [...ledgerKeys].some(([key, expected]) => {
    const prior = pageKeyPriors.get(key);
    return prior === undefined || prior.type !== expected.type || prior.text !== expected.text;
  })) {
    return null;
  }
  return {
    method: request.method,
    origin: approvedOrigin,
    path,
    queryNames: isUpdate && filterName !== null ? [...queryNames as string[], filterName, ...otherFilters.keys()] : [...queryNames as string[]],
    filterName: isUpdate ? filterName : null,
    recordId: isUpdate ? recordId : null,
    contentType: request.contentType === null ? null : request.contentType.toLowerCase(),
    prefer: new Set(prefer as string[]),
    headerNames: new Set(headerNames as string[]),
    keyFields,
    pageKeys,
    pageArrays,
    keptKeys,
    pageKeyPriors,
    otherFilters,
  };
};

/**
 * LU-9（設計書 5.3 の 2）: 前の値を後から入れる印のある期待に、前の値を入れた期待（印を外し、`keptKeys`・`pageKeyPriorValues` を持つ）。入れられないときは
 * null（純粋。入力を変えない。投げない）。
 * - 期待が UPDATE（`PATCH`）で印を持ち、前の値をまだ持たないこと。印の保つ鍵の名前は、空でない重ならない文字の一覧であること。
 * - 入れる保つ鍵の名前の集合が、印の名前の集合と完全に一致すること（足す・減らす・違う集合は拒む）。ページが決める鍵の集合が承認の鍵と一致することと、値の形
 *   （JSON の scalar、宣言の型、重ならない鍵）は、照合の期待の確かめ（`acceptedExpectationOf`）に任せる（決まりを 2 つ持たない）。
 * LU-SFIX1（LU-SREV1 の Minor-2）: 受けた前の値は、確かめる前に写して凍らせ（`apiWritePriorValuesCopyOf`）、返す期待はその写しを持つ（受けた一覧を参照しない）。
 */
export const apiWriteExpectationWithPriorValues = (
  expectation: ApiWritePayloadExpectation,
  supplied: ApiWriteSuppliedPriorValues,
): ApiWritePayloadExpectation | null => {
  try {
    if (!isRecord(expectation) || !isRecord(expectation.spec) || !isRecord(supplied)) {
      return null;
    }
    const { spec, values, recordId, keptKeys, pageKeyPriorValues, deferredPriorValues } = expectation as unknown as ApiWritePayloadExpectation;
    const names: unknown = indexedListCopyOf(isRecord(deferredPriorValues) ? deferredPriorValues.keptKeys : undefined, (name) => name);
    if (keptKeys !== undefined || pageKeyPriorValues !== undefined || !isRecord(spec.request) || spec.request.method !== 'PATCH'
      || !Array.isArray(names) || !names.every(isNonEmptyString) || hasDuplicates(names as string[])) {
      return null;
    }
    // LU-SFIX1（LU-SREV1 の Minor-2）: 受けた前の値は、確かめる前に写して凍らせる（getter や Proxy で後から値が変わっても、確かめた値と返す値は同じ）。
    const suppliedKept: unknown = apiWritePriorValuesCopyOf(supplied.keptKeys);
    const suppliedPage: unknown = apiWritePriorValuesCopyOf(supplied.pageKeyPriorValues);
    if (!Array.isArray(suppliedKept) || !Array.isArray(suppliedPage)) {
      return null;
    }
    const suppliedNames = (suppliedKept as readonly unknown[]).map((entry) => (isRecord(entry) ? entry.key : undefined));
    const expectedNames = new Set(names as string[]);
    if (suppliedNames.length !== expectedNames.size || !suppliedNames.every((name) => typeof name === 'string' && expectedNames.has(name))
      || hasDuplicates(suppliedNames as string[])) {
      return null;
    }
    const merged: ApiWritePayloadExpectation = {
      spec,
      values,
      recordId,
      keptKeys: suppliedKept as readonly ApiWritePriorValue[],
      pageKeyPriorValues: suppliedPage as readonly ApiWritePriorValue[],
    };
    return acceptedExpectationOf(merged) === null ? null : merged;
  } catch {
    return null;
  }
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
  /** ARR-2: 承認した一覧の鍵の値は、解いた一覧（要素は照らすまで確かめない）。 */
  readonly value: ApiJsonScalarValue | readonly unknown[];
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
 * ARR-2: 正しい JSON の一覧の、`start`（`[`）からの表記の終わり（閉じる `]` の次の位置）。文字列の中の括弧は数えない。入れ子の一覧と object も括弧の
 * 深さで飛ばす（入れ子かは、解いた値で照合が確かめる）。
 */
const endOfJsonArray = (text: string, start: number): number => {
  let depth = 0;
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      const end = endOfJsonString(text, index);
      if (end < 0) return -1;
      index = end;
      continue;
    }
    if (char === '[' || char === '{') {
      depth += 1;
    } else if (char === ']' || char === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return -1;
};

/**
 * 本文を読む（メモリの中で 1 回だけ。値は返す鍵の中にだけ持つ）。UTF-8 として読めない、BOM、JSON でない、最上位が object でない、同じ鍵が 2 回、値が
 * array か object なら、その理由を返す。JSON として正しいことを `JSON.parse` で確かめてから、最上位の object の鍵と値の書かれたままの表記を順に読む。
 * ARR-2: 承認した一覧の鍵（`isArrayKey`）の値の一覧だけは、解いた一覧として読む（中身は照合が確かめる）。
 */
const scanBody = (bytes: Uint8Array, isArrayKey: (key: string) => boolean): BodyScan => {
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
    if (first === '{' || (first === '[' && !isArrayKey(key))) {
      return { ok: false, reason: 'BODY_VALUE_NOT_SCALAR' };
    }
    let raw: string;
    let type: ApiJsonValueType;
    let value: ApiJsonScalarValue | readonly unknown[];
    if (first === '[') {
      const end = endOfJsonArray(text, index);
      if (end < 0) return malformed;
      raw = text.slice(index, end);
      type = ARRAY_TYPE;
      value = JSON.parse(raw) as readonly unknown[];
    } else if (first === '"') {
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

/** ARR-3・ARR-4: 欄の一覧の本文の値が、位置ごとに求める値と完全に一致するか（要素の数も同じ）。 */
const fieldListMatches = (expected: ExpectedKeyField, values: readonly unknown[]): boolean => {
  const elements = expected.elements ?? [expected.text];
  return values.length === elements.length && elements.every((element, index) => values[index] === element);
};

/** ARR-5: object の行の一覧の本文の値が、行ごとの中の鍵と求める値に完全に一致するか（行の数、中の鍵の集合も同じ）。 */
const objectRowsMatch = (rows: NonNullable<ExpectedKeyField['rows']>, values: readonly unknown[]): boolean =>
  values.length === rows.length && rows.every((row, index) => {
    const value = values[index];
    return isRecord(value) && Object.keys(value).length === row.length
      && row.every(({ name, value: expected }) => Object.hasOwn(value, name) && value[name] === expected);
  });

/** ARR-5: 一覧の表記の中の object に同じ鍵が 2 回あるか（数え方は型の記録と共用する契約の 1 か所 `jsonTextHasDuplicateObjectKeys`）。 */
const hasDuplicateObjectKeys = (text: string): boolean => jsonTextHasDuplicateObjectKeys(text);

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
  const pageKeyValues: [string, ApiWritePageKeyValue][] = [];
  for (const entry of entries) {
    // T41c: 照らす値は、変える鍵なら生成した値、保つ鍵と UPDATE のページが決める鍵なら前の値。CREATE のページが決める鍵は照らさずに返す。
    const expected = accepted.keyFields.get(entry.key) ?? accepted.keptKeys.get(entry.key) ?? accepted.pageKeyPriors.get(entry.key);
    const expectedType = expected?.type ?? accepted.pageKeys.get(entry.key);
    if (entry.type !== expectedType) {
      return { decision: 'BODY_VALUE_TYPE_MISMATCH' };
    }
    if (Array.isArray(entry.value)) {
      // ARR-2: 一覧の鍵（数え方は型の作り手と同じ部品）。入れ子は今のまま止める。
      const values = entry.value as readonly unknown[];
      // ARR-5: 一覧の中の object に同じ鍵が 2 回ある本文は送らない（解いた値は最後の鍵だけになり、サーバの読み方と違いうる）。
      if (hasDuplicateObjectKeys(entry.raw)) {
        return { decision: 'BODY_DUPLICATE_KEY' };
      }
      if (expected?.rows !== undefined) {
        // ARR-5（設計書 2.4 の 3）: object の行の一覧は、行の数・行ごとの中の鍵の集合・値が承認と完全一致（深い値は一致しない）。
        if (!objectRowsMatch(expected.rows, values)) {
          return { decision: 'BODY_VALUE_MISMATCH' };
        }
        continue;
      }
      const elements = apiArrayElementsOf(values);
      if (elements.nested) {
        return { decision: 'BODY_VALUE_NOT_SCALAR' };
      }
      const approved = accepted.pageArrays.get(entry.key);
      const matches = expected === undefined
        // ページが決める一覧: 要素の型の集合と数が承認と同じ（値は照らさずに返す。入れ子は上で止めた）。L13 fix round 1: 数と文字の長さの上限
        // （前は `apiArrayElementsWithinLimits`）は置かない。
        ? approved !== undefined && elements.count === approved.count
          && elementTypesTextOf(elements.types) === approved.typesText
        // 欄の一覧: 位置ごとに完全一致（ARR-3。欄の位置は生成した値、空の位置は承認した空の値、要素の数は承認と同じ）。役を省いた鍵は
        // `[生成した値]`（DEF-226 の形）。
        : fieldListMatches(expected, values);
      if (!matches) {
        return { decision: 'BODY_VALUE_MISMATCH' };
      }
      if (expected === undefined) {
        pageKeyValues.push([entry.key, Object.freeze([...values] as ApiJsonScalarValue[])]);
      }
      continue;
    }
    const scalar = entry.value as ApiJsonScalarValue;
    if (expected === undefined) {
      pageKeyValues.push([entry.key, scalar]);
    } else if ((entry.type === 'string' ? scalar : entry.raw) !== expected.text) {
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
  // DEF-198（設計書 5.9 の 3）: ほかの filter は、それぞれ（同じ名前は上で 1 回だけ）`eq.<登録の時のページの値>` と完全一致（`neq`・`in`・別の値は止める）。
  for (const [name, expected] of accepted.otherFilters) {
    if (query.find(([queryName]) => queryName === name)?.[1] !== `${FILTER_EQUALS_OPERATOR}${API_FILTER_OPERATOR_SEPARATOR}${expected.text}`) {
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
  // L12b（設計書 `2026-11-09-beaksight-remove-limits-design.md` 6.2。S18）: 本文の大きさの上限（前は 64KiB で `BODY_TOO_LARGE`）は
  // 置かない（承認した型との照合は今のまま）。
  // ARR-2: 一覧として読むのは、承認した一覧の鍵（欄の一覧とページが決める一覧）だけ。
  const scanned = scanBody(body, (key) => accepted.keyFields.get(key)?.type === ARRAY_TYPE || accepted.pageArrays.has(key));
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
