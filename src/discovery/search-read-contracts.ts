// RCA-1（検索の確かめの設計書 `doc/design/2026-11-18-beaksight-search-check-design.md` 2.1）: 操作さがしが自分で起こした読み取り（押下・選択肢の選択・
// 打つだけの欄への入力の後に、凍結の Guard が通した GET・HEAD）の記録の契約の唯一の置き場。純粋な定義と関数だけ（core の部品だけを実行時に import する）。
// - 応答の状態の判定（`searchReadVerdictOf`）: 500・501・505〜599 は「検索の誤り」の材料（`SERVER_ERROR`）。429・502・503・504 はサイトの不調（DEF-136 と同じ
//   一覧 `SITE_UNAVAILABLE_HTTP_STATUSES`）。ほかの 4xx は誤りにしない（入力の確かめの正しい答えもある）。応答のない読み取りと、600 以上の決まっていない状態は
//   判定しない。
// - 読み取りの記録（`SearchReadRecord`）は形だけ: method、要求の種類、path の型と query の名前（型の作り手 `apiRequestShapeOf` で値と目印を伏せる）、値に目印を
//   含んだ query の名前、状態の番号。URL・値・本文は残さない。記録する要求の種類は、データの読み取り（`fetch`・`xhr`）だけ（画像などの部品の欠けは監査が見る）。
// - きっかけ（`DiscoverySearchTrigger`）: 押下（候補の識別の digest と同じ digest の中の順番、押す前に入れた欄）、選択肢の選択（欄と選択肢の番号）、打つだけの
//   欄への入力（欄の名前・画面で一意な CSS・型）。どれも、その状態の段の番号と、その前に同じ画面で押した押下の並びを持つ（段の画面を作り直すため）。値は持たない。
// - 画面の記録の任意の項目 `searchTriggers`（`withSearchTriggers` で末尾に足す）。読み取りを 1 つ以上起こしたきっかけだけを記録する。識別の digest には入れない。
import { apiRequestShapeOf, markerCarryingQueryNameShapesOf } from '../core/api-request-shape.js';
import type { CandidateFieldType } from '../core/candidate-field-types.js';
import {
  CLIENT_ERROR_HTTP_STATUS_RANGE,
  SERVER_ERROR_HTTP_STATUS_RANGE,
  SITE_UNAVAILABLE_HTTP_STATUSES,
  isHttpStatusInRange,
} from '../core/http-status.js';
import type { DiscoveryOptionFieldKind, DiscoveryReadPageRecord } from './discovery-result.js';
import type { SubmissionProbeInputField, SubmissionProbePressStep } from './submission-probe-contracts.js';

/**
 * 読み取りの状態の判定（閉じた一覧）。
 * - `SERVER_ERROR`: 500・501・505〜599（検索の誤りの材料）。
 * - `SITE_UNAVAILABLE`: 429・502・503・504（サイトの不調。誤りにしない）。
 * - `CLIENT_ERROR`: ほかの 4xx（誤りにしない）。
 * - `OK`: 100〜399。
 * - `NO_RESPONSE`: 応答を受けなかった（BeakSight が止めたものは記録しない）。
 * - `NON_STANDARD`: 600 以上の決まっていない状態（判定しない）。
 */
export const SEARCH_READ_VERDICTS = Object.freeze(['SERVER_ERROR', 'SITE_UNAVAILABLE', 'CLIENT_ERROR', 'OK', 'NO_RESPONSE', 'NON_STANDARD'] as const);
export type SearchReadVerdict = (typeof SEARCH_READ_VERDICTS)[number];

const SITE_UNAVAILABLE_STATUS_SET: ReadonlySet<number> = new Set(SITE_UNAVAILABLE_HTTP_STATUSES);

/** 読み取りの応答の状態の判定（純粋。`status` は観察した状態の番号、応答がなければ null）。 */
export const searchReadVerdictOf = (status: number | null): SearchReadVerdict => {
  if (status === null) {
    return 'NO_RESPONSE';
  }
  if (SITE_UNAVAILABLE_STATUS_SET.has(status)) {
    return 'SITE_UNAVAILABLE';
  }
  if (isHttpStatusInRange(status, SERVER_ERROR_HTTP_STATUS_RANGE)) {
    return 'SERVER_ERROR';
  }
  if (status > SERVER_ERROR_HTTP_STATUS_RANGE.max) {
    return 'NON_STANDARD';
  }
  return isHttpStatusInRange(status, CLIENT_ERROR_HTTP_STATUS_RANGE) ? 'CLIENT_ERROR' : 'OK';
};

/**
 * REV-RCA の M-1（検索の確かめの設計書 2.2）: きっかけが出した読み取りの状態の並びが、サイトの不調（429・502・503・504・応答なし）で確かめ直すものか（純粋）。
 * 5xx の誤りがあれば、誤りが先なので確かめ直さない。
 */
export const searchReadsNeedRecheck = (statuses: readonly (number | null)[]): boolean => {
  const verdicts = statuses.map(searchReadVerdictOf);
  return !verdicts.includes('SERVER_ERROR') && verdicts.some((verdict) => verdict === 'SITE_UNAVAILABLE' || verdict === 'NO_RESPONSE');
};

/** 記録する読み取りの method（閉じた一覧）。 */
export const SEARCH_READ_METHODS = Object.freeze(['GET', 'HEAD'] as const);
export type SearchReadMethod = (typeof SEARCH_READ_METHODS)[number];

/** 記録する要求の種類（データの読み取り。閉じた一覧）。 */
export const SEARCH_READ_RESOURCE_TYPES = Object.freeze(['fetch', 'xhr'] as const);
export type SearchReadResourceType = (typeof SEARCH_READ_RESOURCE_TYPES)[number];

/** 記録する読み取りか（method と要求の種類で決める唯一の判定）。 */
export const isSearchRead = (method: string, resourceType: string): boolean =>
  (SEARCH_READ_METHODS as readonly string[]).includes(method.toUpperCase())
  && (SEARCH_READ_RESOURCE_TYPES as readonly string[]).includes(resourceType);

/** 読み取り 1 つの記録（形だけ。値を持たない）。 */
export interface SearchReadRecord {
  readonly method: SearchReadMethod;
  readonly resourceType: SearchReadResourceType;
  /** path の型（値に見える区切りと目印を含む区切りを伏せ、最後の番号は `{id}`）。 */
  readonly pathShape: string;
  /** query の名前（値に見える・目印を含む名前は伏せる。並べる）。 */
  readonly queryNames: readonly string[];
  /** 値に目印を含んだ query の名前（同じ伏せ方。並べる）。 */
  readonly markerQueryNames: readonly string[];
  /** 応答の状態の番号（応答がなければ null）。 */
  readonly status: number | null;
}

/** 読み取りの事実（呼ぶ側が観察した値。URL はここで形にして捨てる）。 */
export interface SearchReadFacts {
  readonly method: string;
  readonly resourceType: string;
  readonly url: string;
  readonly status: number | null;
}

/** 形を作る文脈（画面の path と、そのきっかけで欄に入れた目印）。 */
export interface SearchReadContext {
  readonly pagePath: string;
  readonly markers: readonly string[];
}

/** 本文のない読み取り。 */
const NO_BODY = Object.freeze({ kind: 'NONE' as const });

/**
 * 読み取りの記録を作る（純粋）。記録しない読み取り（`isSearchRead` に当たらない）は呼ぶ側が除く。形にできない method・種類は `TypeError`（値を文に入れない）。
 */
export const searchReadRecordOf = (facts: SearchReadFacts, context: SearchReadContext): SearchReadRecord => {
  const method = facts.method.toUpperCase();
  if (!isSearchRead(method, facts.resourceType)) {
    throw new TypeError('a search read must be a GET or HEAD fetch or xhr');
  }
  const shape = apiRequestShapeOf(
    { method, resourceType: facts.resourceType, url: facts.url, origin: { kind: 'OTHER' }, headers: undefined, body: NO_BODY },
    { pagePath: context.pagePath, markers: context.markers },
  );
  return Object.freeze({
    method: method as SearchReadMethod,
    resourceType: facts.resourceType as SearchReadResourceType,
    pathShape: shape.pathShape,
    queryNames: shape.queryNames,
    markerQueryNames: markerCarryingQueryNameShapesOf(facts.url, context.markers),
    status: facts.status,
  });
};

/** きっかけの段（段の番号と、その前に同じ画面で押した押下の並び）。 */
interface SearchTriggerStage {
  readonly stage: number;
  readonly priorPresses: readonly SubmissionProbePressStep[];
}

/** 打つだけの欄（名前・画面で一意な CSS・型。値は持たない）。 */
export interface SearchTriggerField {
  readonly name: string | null;
  readonly selector: string | null;
  readonly type: CandidateFieldType;
}

/** きっかけの種類（閉じた一覧）。 */
export const SEARCH_TRIGGER_KINDS = Object.freeze(['PRESS', 'OPTION', 'TYPED'] as const);
export type SearchTriggerKind = (typeof SEARCH_TRIGGER_KINDS)[number];

/** 読み取りを起こしたきっかけ（値を持たない）。 */
export type DiscoverySearchTrigger =
  | (SearchTriggerStage & {
    readonly kind: 'PRESS';
    /** 押した候補の識別の digest と、同じ digest の中の順番。 */
    readonly identityDigest: string;
    readonly ordinal: number;
    /** 押す前に入れた欄（押下の記録の `inputFields` と同じ形）。 */
    readonly inputFields: readonly SubmissionProbeInputField[];
  })
  | (SearchTriggerStage & {
    readonly kind: 'OPTION';
    readonly field: { readonly kind: DiscoveryOptionFieldKind; readonly name: string | null; readonly ordinal: number };
    readonly optionIndex: number;
  })
  | (SearchTriggerStage & { readonly kind: 'TYPED'; readonly field: SearchTriggerField });

/** きっかけ 1 つと、それが起こした読み取り（1 つ以上。起きた順）。 */
export interface DiscoverySearchTriggerRecord {
  readonly trigger: DiscoverySearchTrigger;
  readonly reads: readonly SearchReadRecord[];
}

/** 読み取りに検索の誤りの材料（`SERVER_ERROR`）があるか。 */
export const hasSearchServerError = (record: DiscoverySearchTriggerRecord): boolean =>
  record.reads.some(({ status }) => searchReadVerdictOf(status) === 'SERVER_ERROR');

/** きっかけの記録を、画面の記録の末尾に足す（純粋。足すものがなければ同じ記録を返す）。 */
export const withSearchTriggers = (
  record: DiscoveryReadPageRecord,
  triggers: readonly DiscoverySearchTriggerRecord[],
): DiscoveryReadPageRecord => (triggers.length === 0
  ? record
  : Object.freeze({ ...record, searchTriggers: Object.freeze([...(record.searchTriggers ?? []), ...triggers]) }));
