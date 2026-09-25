import { isNonNegativeSafeInteger } from './guards.js';

export type TruncatedText = Readonly<{
  text: string;
  truncated: boolean;
}>;

/** 連続する空白を1つの半角空白にし、前後の空白を除く（`replace(/\s+/gu, ' ').trim()` と同じ）。 */
export const normalizeWhitespace = (value: string): string => value.replace(/\s+/gu, ' ').trim();

/**
 * `value` を UTF-16 のコード単位で `maxLength` 以内に切り詰め、切り詰めたかどうかも返す。
 * `value` が文字列でない場合は `TypeError` を、`maxLength` が0以上の安全な整数でない場合は `RangeError` を、
 * 呼び出し側の誤りとして投げる。
 */
export const truncateText = (value: string, maxLength: number): TruncatedText => {
  if (typeof value !== 'string') {
    throw new TypeError('text to truncate must be a string');
  }
  if (!isNonNegativeSafeInteger(maxLength)) {
    throw new RangeError('text maximum length must be a non-negative safe integer');
  }
  return value.length > maxLength
    ? Object.freeze({ text: value.slice(0, maxLength), truncated: true })
    : Object.freeze({ text: value, truncated: false });
};

/** ロケールに依存せず、UTF-16 のコード単位の順で比べる。 */
export const compareCodeUnits = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};
