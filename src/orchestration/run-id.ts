import type { RunId } from '../core/contracts.js';
import { createRunId } from '../core/ids.js';
import { formatCompactUtcTimestamp } from '../core/utc-timestamp.js';

/** 誤りの文で、時刻の名前として示す語。 */
const RUN_START_TIME_SUBJECT = 'run start time';

/**
 * Run の開始の時刻から、Run の ID を作る（Task 14〜17 の設計書 5.6.7）。形は `RUN-YYYYMMDDHHmmss`（UTC）。
 *
 * `RUN-` の接頭辞と桁の書式は、`src/core/ids.ts` の `createRunId` だけが持つ。UTC の時刻の14桁の数（`YYYYMMDDHHmmss`）は、
 * `src/core/utc-timestamp.ts` の `formatCompactUtcTimestamp` だけが作る（ChatGPT 用バンドルのファイル名と共用。バンドルのファイル名の
 * 設計書 2.1）。ここでは、その14桁の数を、`createRunId` に連番として渡す。年が4桁（1000〜9999）なら、14桁の数は `createRunId` の
 * ゼロ埋め（6桁）より長いので、そのままの桁で書かれる。
 *
 * 不正な `Date` と、年が4桁でない時刻は、呼び出し側の誤りとして `RangeError` を投げる（先頭の0が落ちて、形が崩れるため）。
 */
export function createRunIdFromTime(date: Date): RunId {
  return createRunId(Number(formatCompactUtcTimestamp(date, RUN_START_TIME_SUBJECT)));
}
