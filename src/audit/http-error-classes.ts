/**
 * AUD-7（整理の文書 `doc/design/2026-11-09-beaksight-audit-precision-triage.md` の AUD-7）: 4xx・5xx の応答の区分の唯一の決め方（純粋な関数）。
 * - 区分の閉じた一覧（`HTTP_ERROR_CLASSES`）と、応答の文脈（回復・やり直し・資格・画面の誤りの表示・承認したサービスか）の読み方を、このファイルの 1 か所に
 *   置く。Rule（`HTTP_4XX`・`RESOURCE_4XX`・`RESOURCE_5XX`）は、ここの結果で Finding にするかを決める（`EXPECTED_BRANCH` は Finding にしない）。
 * - 表示用モデルは、指摘ごとの区分と、Finding にしなかった応答の数と事実を、ここから読む（Rule のファイルは import できないため。ARCH07）。
 * - Rule が決めるのは `SITE_FAILURE`・`UNDETERMINED`・`EXPECTED_BRANCH`。`COLLECTION_CAUSED` は、BeakSight の遮断との関係（表示用モデルの 1 か所）が
 *   `CAUSED`・`POSSIBLE` の指摘に、表示用モデルが付ける（設計者の判断 2026-11-10）。
 * - 設計者の判断（2026-11-10）:
 *   - 同じ口の鍵は、メソッドと Origin と path（query は見ない）。同じ読み込み（同じ network の Evidence）の、後の同じ口の応答の状態の番号を、やり直しの
 *     結果とする。そのどれかが 2xx なら、回復した。
 *   - `EXPECTED_BRANCH` は 4xx だけ。5xx は、回復しても `SITE_FAILURE` か `UNDETERMINED`。
 *   - 手がかりがぶつかるとき（語はあるが回復している、回復しないが画面に誤りがない、など）は `UNDETERMINED`。
 * - 区分の表（実装者の判断。画面の誤りの表示は、データの要求（fetch・XHR）の手がかりにする。画像などの部品の欠けは画面に知らせが出ないため）:
 *   - 5xx: 回復したら `UNDETERMINED`、しなければ `SITE_FAILURE`。
 *   - 4xx で回復した: 画面に誤りがなければ `EXPECTED_BRANCH`、あるか分からなければ `UNDETERMINED`。
 *   - 4xx で回復しない: データの要求でなければ `SITE_FAILURE`。データの要求は、画面に誤りがあれば `SITE_FAILURE`、なければ・分からなければ `UNDETERMINED`。
 * - 前の版の記録（応答の文脈 `errorContext` がない）は、区分を付けない（今までどおり Finding にする）。
 */
import type { EvidenceRecord } from '../core/contracts.js';
import {
  CLIENT_ERROR_HTTP_STATUS_RANGE,
  SERVER_ERROR_HTTP_STATUS_RANGE,
  SUCCESS_HTTP_STATUS_RANGE,
  isHttpStatusInRange,
} from '../core/http-status.js';
import { requestEndpointKeyOf } from '../core/request-endpoint-key.js';
import type {
  ErrorDisplayEvidence,
  NetworkEvidence,
  NetworkResponseEvidence,
  ResponseBodySummaryEvidence,
} from '../core/evidence-types.js';

/** 区分の閉じた一覧（強い順。指摘の区分は、まとめた応答のうち、いちばん強いもの）。 */
export const HTTP_ERROR_CLASSES = Object.freeze(['SITE_FAILURE', 'COLLECTION_CAUSED', 'UNDETERMINED', 'EXPECTED_BRANCH'] as const);
export type HttpErrorClass = (typeof HTTP_ERROR_CLASSES)[number];
/** Rule が決める区分（`COLLECTION_CAUSED` は表示用モデルが付ける）。 */
export type HttpErrorRuleClass = Exclude<HttpErrorClass, 'COLLECTION_CAUSED'>;

/** 区分を持つ Rule の ID。 */
export const HTTP_ERROR_CLASS_RULE_IDS = Object.freeze(['HTTP_4XX', 'RESOURCE_4XX', 'RESOURCE_5XX'] as const);
export type HttpErrorClassRuleId = (typeof HTTP_ERROR_CLASS_RULE_IDS)[number];

/** 画面の誤りの表示の状態の閉じた一覧（あった・なかった・分からない）。 */
export const ERROR_DISPLAY_STATES = Object.freeze(['SHOWN', 'NOT_SHOWN', 'UNKNOWN'] as const);
export type ErrorDisplayState = (typeof ERROR_DISPLAY_STATES)[number];

/** データの要求とみなす資源の種類（Playwright の `resourceType`）。 */
const DATA_RESOURCE_TYPES: ReadonlySet<string> = new Set(['fetch', 'xhr']);

/** 区分を決める入力。 */
export interface HttpErrorClassInput {
  readonly status: number;
  readonly resourceType: string | null;
  readonly mainFrameNavigation: boolean;
  readonly recovered: boolean;
  readonly errorDisplay: ErrorDisplayState;
}

/** 区分の表（ファイルの先頭の表のとおり）。 */
export function httpErrorClassOf(input: HttpErrorClassInput): HttpErrorRuleClass {
  if (isHttpStatusInRange(input.status, SERVER_ERROR_HTTP_STATUS_RANGE)) {
    return input.recovered ? 'UNDETERMINED' : 'SITE_FAILURE';
  }
  if (input.recovered) {
    return input.errorDisplay === 'NOT_SHOWN' ? 'EXPECTED_BRANCH' : 'UNDETERMINED';
  }
  const dataRequest = !input.mainFrameNavigation && input.resourceType !== null && DATA_RESOURCE_TYPES.has(input.resourceType);
  if (!dataRequest) {
    return 'SITE_FAILURE';
  }
  return input.errorDisplay === 'SHOWN' ? 'SITE_FAILURE' : 'UNDETERMINED';
}

/** 画面の誤りの表示の状態（記録がない・読めなかったときは `UNKNOWN`）。 */
export const errorDisplayStateOf = (errorDisplay: ErrorDisplayEvidence | null | undefined): ErrorDisplayState => {
  if (errorDisplay === null || errorDisplay === undefined || errorDisplay.status !== 'OBSERVED') {
    return 'UNKNOWN';
  }
  return errorDisplay.matches.length > 0 ? 'SHOWN' : 'NOT_SHOWN';
};

/** 同じ読み込みの Evidence（ページ・ビューポート）の、画面の誤りの表示の手がかり（確かめ直しの段のものは使わない。最初の DOM の記録）。 */
export const errorDisplayOfRecords = (records: readonly EvidenceRecord[]): ErrorDisplayEvidence | null => {
  for (const record of records) {
    if (record.type === 'dom' && record.capture?.phase !== 'recheck' && record.payload.errorDisplay !== undefined) {
      return record.payload.errorDisplay;
    }
  }
  return null;
};

/** 要求に資格があったか（値は持たない。header を読めなかったときは `null`）。 */
export interface RequestCredentialsFacts {
  readonly cookie: boolean;
  readonly authorization: boolean;
}

/** 1 つの誤りの応答の事実（記録とバンドルにだけ出す。画面と HTML の本文には出さない）。 */
export interface HttpErrorFacts {
  readonly requestId: string;
  readonly url: string;
  readonly method: string | null;
  readonly status: number;
  readonly resourceType: string | null;
  readonly mainFrameNavigation: boolean;
  readonly credentials: RequestCredentialsFacts | null;
  readonly recovered: boolean;
  /** 同じ読み込みの、後の同じ口の応答の状態の番号（応答の順）。 */
  readonly retryStatuses: readonly number[];
  readonly errorDisplay: ErrorDisplayState;
  readonly approvedService: boolean;
  readonly bodySummary: ResponseBodySummaryEvidence;
}

/** 区分を付けた誤りの応答。 */
export interface ClassifiedHttpError {
  readonly ruleId: HttpErrorClassRuleId;
  readonly errorClass: HttpErrorRuleClass;
  readonly facts: HttpErrorFacts;
  /** もとの応答（Rule が、Finding にしない応答を見分けるため）。 */
  readonly response: NetworkResponseEvidence;
}

const isMainFrameNavigation = (response: NetworkResponseEvidence): boolean => response.isNavigationRequest && response.isMainFrame === true;

/** 応答の Rule（区分を持たない `HTTP_5XX` と、範囲の外は `null`）。 */
const ruleIdOf = (response: NetworkResponseEvidence): HttpErrorClassRuleId | null => {
  const clientError = isHttpStatusInRange(response.status, CLIENT_ERROR_HTTP_STATUS_RANGE);
  if (!clientError && !isHttpStatusInRange(response.status, SERVER_ERROR_HTTP_STATUS_RANGE)) {
    return null;
  }
  if (isMainFrameNavigation(response)) {
    return clientError ? 'HTTP_4XX' : null;
  }
  return clientError ? 'RESOURCE_4XX' : 'RESOURCE_5XX';
};

/** 口の鍵（メソッドと Origin と path。作り方は `requestEndpointKeyOf` の 1 か所）。 */
const endpointKeyOf = requestEndpointKeyOf;

/** 1 つの読み込み（network の Evidence）の、区分を付けた誤りの応答（応答の順。前の版の記録と、区分を持たない応答は除く）。 */
export function classifiedHttpErrorsOf(network: NetworkEvidence, errorDisplay: ErrorDisplayEvidence | null | undefined): readonly ClassifiedHttpError[] {
  const requests = new Map(network.requests.map((request) => [request.requestId, request]));
  const display = errorDisplayStateOf(errorDisplay);
  const keys = network.responses.map((response) => endpointKeyOf(requests.get(response.requestId)?.method ?? null, response.url));
  return network.responses.flatMap((response, index): ClassifiedHttpError[] => {
    const ruleId = ruleIdOf(response);
    const context = response.errorContext;
    if (ruleId === null || context === undefined) {
      return [];
    }
    const request = requests.get(response.requestId);
    const key = keys[index];
    // 設計者の判断 2026-11-11: 同じ口の成功した読み取りのくり返しをまとめた記録は、その最後の要求が誤りより後に始まっていれば、やり直しに数える（status を 1 つ）。
    const repeatedRetryStatuses = (network.repeatedReads ?? []).flatMap((repeated) => (
      endpointKeyOf(repeated.method, `${repeated.origin}${repeated.path}`) === key && repeated.lastStartTime > response.timing.startTime
        ? [repeated.status]
        : []));
    const retryStatuses = [
      ...network.responses.flatMap((later, laterIndex) => (laterIndex > index && keys[laterIndex] === key ? [later.status] : [])),
      ...repeatedRetryStatuses,
    ];
    const recovered = retryStatuses.some((status) => isHttpStatusInRange(status, SUCCESS_HTTP_STATUS_RANGE));
    const headerNames = request?.headers.status === 'OBSERVED' ? new Set(Object.keys(request.headers.values).map((name) => name.toLowerCase())) : null;
    const facts: HttpErrorFacts = {
      requestId: response.requestId,
      url: response.url,
      method: request?.method ?? null,
      status: response.status,
      resourceType: request?.resourceType ?? null,
      mainFrameNavigation: isMainFrameNavigation(response),
      credentials: headerNames === null ? null : { cookie: headerNames.has('cookie'), authorization: headerNames.has('authorization') },
      recovered,
      retryStatuses,
      errorDisplay: display,
      approvedService: context.approvedService,
      bodySummary: context.bodySummary,
    };
    return [{ ruleId, errorClass: httpErrorClassOf(facts), facts, response }];
  });
}

/** 指摘の区分（まとめた応答の区分のうち、いちばん強いもの。応答がなければ `null`）。 */
export const strongestHttpErrorClass = (classes: readonly HttpErrorClass[]): HttpErrorClass | null =>
  HTTP_ERROR_CLASSES.find((errorClass) => classes.includes(errorClass)) ?? null;
