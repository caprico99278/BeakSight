import type { RunId } from '../core/contracts.js';
import { createRunId } from '../core/ids.js';

/** 4桁で表せる UTC の年の範囲。この範囲なら、`YYYYMMDDHHmmss` は常に14桁の数になる。 */
const MIN_FOUR_DIGIT_YEAR = 1000;
const MAX_FOUR_DIGIT_YEAR = 9999;
const TWO_DIGIT_WIDTH = 2;

const twoDigits = (value: number): string => String(value).padStart(TWO_DIGIT_WIDTH, '0');

/**
 * Run の開始の時刻から、Run の ID を作る（Task 14〜17 の設計書 5.6.7）。形は `RUN-YYYYMMDDHHmmss`（UTC）。
 *
 * `RUN-` の接頭辞と桁の書式は、`src/core/ids.ts` の `createRunId` だけが持つ。ここでは、UTC の時刻を14桁の数
 * （`YYYYMMDDHHmmss`）にして、`createRunId` に連番として渡す。年が4桁（1000〜9999）なら、14桁の数は `createRunId` の
 * ゼロ埋め（6桁）より長いので、そのままの桁で書かれる。
 *
 * 不正な `Date` と、年が4桁でない時刻は、呼び出し側の誤りとして `RangeError` を投げる（先頭の0が落ちて、形が崩れるため）。
 */
export function createRunIdFromTime(date: Date): RunId {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new RangeError('run start time must be a valid Date');
  }
  const year = date.getUTCFullYear();
  if (year < MIN_FOUR_DIGIT_YEAR || year > MAX_FOUR_DIGIT_YEAR) {
    throw new RangeError('run start time must have a four-digit UTC year');
  }
  const timestamp = [
    String(year),
    twoDigits(date.getUTCMonth() + 1),
    twoDigits(date.getUTCDate()),
    twoDigits(date.getUTCHours()),
    twoDigits(date.getUTCMinutes()),
    twoDigits(date.getUTCSeconds()),
  ].join('');
  return createRunId(Number(timestamp));
}
