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

/**
 * HTTP のステータスの範囲と、その判定。owner は `src/core/http-status.ts`（CCX-2。CC-042）。Rule の既存の import 元を保つため、
 * 同じものを今の名前のまま公開し直す（ここで別の値を定義しない）。
 */
export {
  CLIENT_ERROR_HTTP_STATUS_RANGE,
  ERROR_HTTP_STATUS_RANGE,
  SERVER_ERROR_HTTP_STATUS_RANGE,
  SUCCESS_HTTP_STATUS_RANGE,
  isHttpStatusInRange,
  type HttpStatusRange,
} from '../core/http-status.js';

/** 重複を除き、コード単位の順（`compareCodeUnits`）に並べた新しい配列。入力の順序が出力に影響しないようにするために使う。 */
export const distinctSorted = <T extends string>(values: Iterable<T>): T[] => [...new Set(values)].sort(compareCodeUnits);
