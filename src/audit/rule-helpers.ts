import type { EvidenceRecordFor, EvidenceType } from '../core/contracts.js';
import { compareCodeUnits } from '../core/text.js';
import type { PageRuleInput } from './rule.js';

/**
 * Rule が共有する補助処理（CC-013、Task 12・13 の設計書 5.1.1）。Rule のファイルに、同じ意味の処理を別に書かない。
 * このファイルには、日本語の文言を置かない（文言は各 Rule が持つ）。
 */

/**
 * 入力のビューポートで集めた、指定した種類の Evidence（入力の順）。
 * ビューポートが入力と異なる Evidence と、ビューポートによらない Evidence（`viewport` が null）は含めない。
 * 型 `TType` が総称のままでは、TypeScript が `EvidenceRecord` の和集合を `EvidenceRecordFor<TType>` に絞れないので、
 * `type` の一致を確かめたうえで、最後に型を付け直す。
 */
export const evidenceOfType = <TType extends EvidenceType>(
  input: Pick<PageRuleInput, 'viewport' | 'evidence'>,
  type: TType,
): readonly EvidenceRecordFor<TType>[] =>
  input.evidence.filter((record): record is Extract<typeof record, EvidenceRecordFor<TType>> =>
    record.type === type && record.viewport === input.viewport) as readonly EvidenceRecordFor<TType>[];

/** HTTP のステータスの範囲（両端を含む）。 */
export interface HttpStatusRange {
  readonly min: number;
  readonly max: number;
}

/** 成功（2xx）の HTTP ステータスの範囲。 */
export const SUCCESS_HTTP_STATUS_RANGE: HttpStatusRange = Object.freeze({ min: 200, max: 299 });
/** クライアントエラー（4xx）の HTTP ステータスの範囲。 */
export const CLIENT_ERROR_HTTP_STATUS_RANGE: HttpStatusRange = Object.freeze({ min: 400, max: 499 });
/** サーバエラー（5xx）の HTTP ステータスの範囲。 */
export const SERVER_ERROR_HTTP_STATUS_RANGE: HttpStatusRange = Object.freeze({ min: 500, max: 599 });
/** エラー（4xx・5xx）の HTTP ステータスの範囲。4xx の下端から 5xx の上端まで。 */
export const ERROR_HTTP_STATUS_RANGE: HttpStatusRange = Object.freeze({
  min: CLIENT_ERROR_HTTP_STATUS_RANGE.min,
  max: SERVER_ERROR_HTTP_STATUS_RANGE.max,
});

/** HTTP のステータスが範囲にあるか。観測できなかったステータス（`null`）は、どの範囲にも入らない。 */
export const isHttpStatusInRange = (status: number | null, range: HttpStatusRange): boolean =>
  status !== null && status >= range.min && status <= range.max;

/** 重複を除き、コード単位の順（`compareCodeUnits`）に並べた新しい配列。入力の順序が出力に影響しないようにするために使う。 */
export const distinctSorted = <T extends string>(values: Iterable<T>): T[] => [...new Set(values)].sort(compareCodeUnits);
