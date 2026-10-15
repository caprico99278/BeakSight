/**
 * UTC の日時の14桁の書式（`YYYYMMDDHHmmss`。時は24時間制。各項目は0埋め）の唯一の owner（ChatGPT 用バンドルのファイル名の設計書 2.1）。
 * - Run の ID（`src/orchestration/run-id.ts` の `createRunIdFromTime`。`RUN-YYYYMMDDHHmmss`）と、ChatGPT 用バンドルのファイル名
 *   （`src/core/artifact-layout.ts` の `bundleFileName`。`beaksight-audit-bundle_YYYYMMDDHHmmss.zip`）の両方が、ここを使う。
 *   ほかの場所で、この書式を組み立てない。
 * - 年が4桁（1000〜9999）の時刻だけを受ける。この範囲なら、書式は常に `COMPACT_UTC_TIMESTAMP_LENGTH` 桁の ASCII の数字になる。
 * - 読み戻し（`parseCompactUtcTimestamp`、`dateOfCompactUtcTimestamp`）もここだけに置く（CC-063。管理データ、画面のサーバが使う）。
 *   ありえない日時を繰り越して読まない（`Date.parse` の緩い読み戻しを使わない）。
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

/** 14 桁の中の各項目の位置（`YYYYMMDDHHmmss`。年、月、日、時、分、秒の順）。 */
const COMPACT_UTC_TIMESTAMP_FIELDS = Object.freeze([
  Object.freeze({ start: 0, end: 4 }),
  Object.freeze({ start: 4, end: 6 }),
  Object.freeze({ start: 6, end: 8 }),
  Object.freeze({ start: 8, end: 10 }),
  Object.freeze({ start: 10, end: 12 }),
  Object.freeze({ start: 12, end: COMPACT_UTC_TIMESTAMP_LENGTH }),
]);

/** `Date.UTC` の月は 0 から。 */
const MONTH_OFFSET = 1;

/**
 * UTC の 14 桁（`formatCompactUtcTimestamp` の形）を時刻に戻す（厳しい読み戻し。CC-063）。次の値は `null`（読み戻さない）:
 * 文字列でない値、形が違う値（ASCII の数字が `COMPACT_UTC_TIMESTAMP_LENGTH` 桁でない）、ありえない日時（2 月 30 日、13 月、24 時、60 分など。
 * 繰り越さない）、年が 4 桁でない値（`0999` など）。読み戻した時刻を `formatCompactUtcTimestamp` で書けば、元の文字列に戻る。
 */
export const parseCompactUtcTimestamp = (value: unknown): Date | null => {
  if (typeof value !== 'string' || !isCompactUtcTimestamp(value)) {
    return null;
  }
  const [year = 0, month = 0, day = 0, hours = 0, minutes = 0, seconds = 0] = COMPACT_UTC_TIMESTAMP_FIELDS
    .map(({ start, end }) => Number(value.slice(start, end)));
  if (year < MIN_FOUR_DIGIT_YEAR || year > MAX_FOUR_DIGIT_YEAR) {
    return null;
  }
  const date = new Date(Date.UTC(year, month - MONTH_OFFSET, day, hours, minutes, seconds));
  return !Number.isNaN(date.getTime()) && formatCompactUtcTimestamp(date, 'stored timestamp') === value ? date : null;
};

/**
 * `parseCompactUtcTimestamp` の、読み戻せない値を呼び出し側の誤りとする形（管理データの CHECK を通った値は、形が合う）。形が違えば
 * `the timestamp must be 14 ASCII digits of a UTC time`、ありえない日時（年が 4 桁でない値を含む）は `the timestamp is not a real UTC time`
 * の `RangeError` を投げる。
 */
export const dateOfCompactUtcTimestamp = (value: string): Date => {
  if (typeof value !== 'string' || !isCompactUtcTimestamp(value)) {
    throw new RangeError('the timestamp must be 14 ASCII digits of a UTC time');
  }
  const date = parseCompactUtcTimestamp(value);
  if (date === null) {
    throw new RangeError('the timestamp is not a real UTC time');
  }
  return date;
};
