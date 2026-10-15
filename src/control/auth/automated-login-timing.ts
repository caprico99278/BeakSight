// 自動ログインの結果を待つ時間と、429 の `Retry-After` の読み方の SSOT（Task 26 の設計書 4.4 の 5、4.5、10 章の 4。T26c で作り、T26d-1 で
// `src/control/job/auto-login-limits.ts` からここへ移した）。
// - ワーカー（`src/worker/automated-login.ts`）が、結果を待つ時間と `Retry-After` の期限を使う。ワーカーの許可の一覧はファイルの単位で、
//   `src/control/job/` には届かないので、`src/control/auth/` に置く（`automated-login-results.ts` と同じ理由）。
// - 上限の判定（`auto-login-limits.ts`）は、ここから import して、同じものを公開する（定義は 1 か所）。
// - 純粋な関数と名前つきの定数だけ。SQL・秘密・Playwright を持たない。
import { DAY_MS, SECOND_MS } from '../../core/time-units.js';
import { formatCompactUtcTimestamp } from '../../core/utc-timestamp.js';

/** `Retry-After` の上限（ms）。これより長い値、読めない値、負の値は、この長さとみなす。 */
export const AUTO_LOGIN_MAX_RETRY_AFTER_MS = DAY_MS;

/** ログインの送信の後に、結果を待つ時間（ms。ユーザー承認済み）。 */
export const AUTO_LOGIN_RESULT_TIMEOUT_MS = 30 * SECOND_MS;

/** 秒の単位に切り上げた時刻（ms）。期限を、相手が求めたより早くしない。 */
export const ceilToWholeSecondMs = (timeMs: number): number => Math.ceil(timeMs / SECOND_MS) * SECOND_MS;

/** 秒の数の形（RFC 9110 の delay-seconds。符号・小数点なし）。 */
const DELAY_SECONDS_PATTERN = /^[0-9]+$/u;

/** HTTP の日付の形（RFC 9110 の IMF-fixdate だけを受ける。古い形は読めない値として上限にする）。 */
const IMF_FIXDATE_PATTERN = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/u;

/** `Retry-After` の値から、待つ時間（ms）。読めない値、負の値（過去の日付）、上限を超える値は上限。 */
const retryAfterDelayMsOf = (value: string | null, nowMs: number): number => {
  if (typeof value !== 'string') {
    return AUTO_LOGIN_MAX_RETRY_AFTER_MS;
  }
  const trimmed = value.trim();
  if (DELAY_SECONDS_PATTERN.test(trimmed)) {
    const delayMs = Number(trimmed) * SECOND_MS;
    return Number.isSafeInteger(delayMs) && delayMs <= AUTO_LOGIN_MAX_RETRY_AFTER_MS ? delayMs : AUTO_LOGIN_MAX_RETRY_AFTER_MS;
  }
  if (IMF_FIXDATE_PATTERN.test(trimmed)) {
    const dateMs = Date.parse(trimmed);
    // ありえない日付（2 月 31 日など）は、`Date.parse` が繰り越すので、書き戻して同じ文字列かで確かめる。
    if (Number.isNaN(dateMs) || new Date(dateMs).toUTCString() !== trimmed) {
      return AUTO_LOGIN_MAX_RETRY_AFTER_MS;
    }
    const delayMs = dateMs - nowMs;
    return delayMs >= 0 && delayMs <= AUTO_LOGIN_MAX_RETRY_AFTER_MS ? delayMs : AUTO_LOGIN_MAX_RETRY_AFTER_MS;
  }
  return AUTO_LOGIN_MAX_RETRY_AFTER_MS;
};

/**
 * 429 の応答の `Retry-After` の値（ヘッダがなければ `null`）から、次に試してよい時刻（秒の単位に切り上げる）を求める（設計書 4.5）。
 * 秒の数か HTTP の日付（IMF-fixdate）を読む。読めない値、ヘッダがない、負の値、過去の日付、上限（`AUTO_LOGIN_MAX_RETRY_AFTER_MS`）を超える
 * 値は、上限とみなす（安全の側）。`now` が正しい時刻でなければ `RangeError`（呼び出し側の誤り）。ワーカーの結果の `retryAfterUntil` に使う。
 */
export const retryAfterUntilDateOf = (value: string | null, now: Date): Date => {
  const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
  if (Number.isNaN(nowMs)) {
    throw new RangeError('now must be a valid Date');
  }
  return new Date(ceilToWholeSecondMs(nowMs + retryAfterDelayMsOf(value, nowMs)));
};

/**
 * `retryAfterUntilDateOf` の期限を、管理データと同じ UTC の 14 桁（`formatCompactUtcTimestamp`）で返す（結果を記録するときに使う）。
 */
export const retryAfterUntilOf = (value: string | null, now: Date): string =>
  formatCompactUtcTimestamp(retryAfterUntilDateOf(value, now), 'auto login limit time');
