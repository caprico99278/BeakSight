/**
 * UTC の日時の14桁の書式（`YYYYMMDDHHmmss`。時は24時間制。各項目は0埋め）の唯一の owner（ChatGPT 用バンドルのファイル名の設計書 2.1）。
 * - Run の ID（`src/orchestration/run-id.ts` の `createRunIdFromTime`。`RUN-YYYYMMDDHHmmss`）と、ChatGPT 用バンドルのファイル名
 *   （`src/core/artifact-layout.ts` の `bundleFileName`。`beaksight-audit-bundle_YYYYMMDDHHmmss.zip`）の両方が、ここを使う。
 *   ほかの場所で、この書式を組み立てない。
 * - 年が4桁（1000〜9999）の時刻だけを受ける。この範囲なら、書式は常に `COMPACT_UTC_TIMESTAMP_LENGTH` 桁の ASCII の数字になる。
 */

/** 4桁で表せる UTC の年の範囲。 */
const MIN_FOUR_DIGIT_YEAR = 1000;
const MAX_FOUR_DIGIT_YEAR = 9999;
/** 月、日、時、分、秒の桁の数。 */
const TWO_DIGIT_WIDTH = 2;

/** `formatCompactUtcTimestamp` が作る文字列の長さ（`YYYYMMDDHHmmss` の14桁）。 */
export const COMPACT_UTC_TIMESTAMP_LENGTH = 14;

/** `formatCompactUtcTimestamp` が作る形（ASCII の数字が `COMPACT_UTC_TIMESTAMP_LENGTH` 桁）。 */
const COMPACT_UTC_TIMESTAMP_PATTERN = new RegExp(`^[0-9]{${COMPACT_UTC_TIMESTAMP_LENGTH}}$`, 'u');

const twoDigits = (value: number): string => String(value).padStart(TWO_DIGIT_WIDTH, '0');

/**
 * 時刻を、UTC の14桁の文字列（`YYYYMMDDHHmmss`）にする。`subject` は、誤りの文で、何の時刻かを示す名前（例: `run start time`）。
 * 不正な `Date`（`Date` でない値を含む）は `${subject} must be a valid Date`、年が4桁でない時刻は
 * `${subject} must have a four-digit UTC year` の `RangeError` を投げる（呼び出し側の誤り。先頭の0が落ちて、形が崩れるため）。
 */
export function formatCompactUtcTimestamp(date: Date, subject: string): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new RangeError(`${subject} must be a valid Date`);
  }
  const year = date.getUTCFullYear();
  if (year < MIN_FOUR_DIGIT_YEAR || year > MAX_FOUR_DIGIT_YEAR) {
    throw new RangeError(`${subject} must have a four-digit UTC year`);
  }
  return [
    String(year),
    twoDigits(date.getUTCMonth() + 1),
    twoDigits(date.getUTCDate()),
    twoDigits(date.getUTCHours()),
    twoDigits(date.getUTCMinutes()),
    twoDigits(date.getUTCSeconds()),
  ].join('');
}

/** `formatCompactUtcTimestamp` が作る形（ASCII の数字が `COMPACT_UTC_TIMESTAMP_LENGTH` 桁）の文字列か。 */
export const isCompactUtcTimestamp = (value: string): boolean => COMPACT_UTC_TIMESTAMP_PATTERN.test(value);
