// 自動ログインの上限の判定の唯一の owner（Task 26 の設計書 3 章の「ロックを誘発しない上限」、4.5、10 章の 4。T26c）。純粋な関数だけ。
// - 名前つきの定数（ユーザー承認済み）: 1 回のジョブでログインの POST は 1 回だけ、自動ログインどうしの最小の間隔 5 分（プロファイルごと）、
//   24 時間の上限 10 回（プロファイルごと。成功を含む。試し始めた記録で数える）、`Retry-After` の上限 24 時間、結果を待つ時間 30 秒。
// - 数え方: 最小の間隔は、最後に試し始めた時刻から（記録の時刻は秒の単位）。24 時間の上限は、今から 24 時間の窓（今より 24 時間前の時刻は
//   窓の外）の中の、試し始めた記録の数。`Retry-After` は、記録された期限のうち最も遅いもの。
// - 止めている間は `AUTO_LOGIN_HELD`（次に始められる時刻はない。人が画面で解くまで）。解いた後も、最小の間隔と `Retry-After` は守る
//   （設計書 4.2）。
// - `Retry-After` の値の読み方（秒の数か HTTP の日付。読めない値、負の値、過去の日付、上限を超える値は上限とみなす）、その上限、結果を待つ
//   時間は、ワーカーからも届くように `src/control/auth/automated-login-timing.ts` に置き（T26d-1 で移した）、ここから同じものを公開する。
// - 日時は、管理データと同じ UTC の 14 桁（`formatCompactUtcTimestamp`）。SQL を書かない。
import { AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS } from '../auth/auth-setup-contracts.js';
import type { AutomatedLoginFailureResult } from '../auth/automated-login-results.js';
import { ceilToWholeSecondMs } from '../auth/automated-login-timing.js';
import { DAY_MS, MINUTE_MS } from '../../core/time-units.js';
import { dateOfCompactUtcTimestamp, formatCompactUtcTimestamp } from '../../core/utc-timestamp.js';
import type { AuditJobStartRejectionReason } from './job-records.js';

export { AUTO_LOGIN_MAX_RETRY_AFTER_MS, AUTO_LOGIN_RESULT_TIMEOUT_MS, retryAfterUntilOf } from '../auth/automated-login-timing.js';

/** 1 回のジョブで送ってよいログインの POST の数（認証の設定の版 2 の自動ログインの回数と同じ）。 */
export const AUTO_LOGIN_MAX_LOGIN_POSTS_PER_JOB = AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS;

/** 自動ログインどうしの最小の間隔（ms。プロファイルごと。最後に試し始めた時刻から）。 */
export const AUTO_LOGIN_MIN_INTERVAL_MS = 5 * MINUTE_MS;

/** 回数の上限を数える窓の長さ（ms）。 */
export const AUTO_LOGIN_DAILY_WINDOW_MS = DAY_MS;

/** 窓の中で試し始めてよい回数の上限（プロファイルごと。成功を含む）。 */
export const AUTO_LOGIN_DAILY_MAX_ATTEMPTS = 10;

/** 上限の判定に要る、試しの記録 1 件（管理データの `auto_login_attempts` の行から。日時は UTC の 14 桁）。 */
export interface AutoLoginAttemptForLimits {
  readonly startedAt: string;
  /** 429 の `Retry-After` から求めた期限（なければ `null`）。 */
  readonly retryAfterUntil: string | null;
}

/** 上限の判定に要る、止めている行（なければ `null` を渡す）。 */
export interface AutoLoginHoldForLimits {
  readonly reason: AutomatedLoginFailureResult;
  readonly heldAt: string;
}

/** 上限の判定の入力。 */
export interface AutoLoginLimitInput {
  readonly attempts: readonly AutoLoginAttemptForLimits[];
  readonly hold: AutoLoginHoldForLimits | null;
  readonly now: Date;
}

/** 上限の判定で拒む理由（開始を拒む理由の一部）。 */
export const AUTO_LOGIN_LIMIT_REJECTION_REASONS = Object.freeze([
  'AUTO_LOGIN_HELD',
  'AUTO_LOGIN_RATE_LIMITED',
] as const satisfies readonly AuditJobStartRejectionReason[]);
export type AutoLoginLimitRejectionReason = (typeof AUTO_LOGIN_LIMIT_REJECTION_REASONS)[number];

/** 上限の判定の結果。拒むときは、次に始められる時刻（UTC の 14 桁。止めているときは `null`）。 */
export type AutoLoginLimitDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'AUTO_LOGIN_HELD'; readonly nextAllowedAt: null }
  | { readonly ok: false; readonly reason: 'AUTO_LOGIN_RATE_LIMITED'; readonly nextAllowedAt: string };

// ---------------------------------------------------------------------------------------------------------------
// 日時
// ---------------------------------------------------------------------------------------------------------------

// UTC の 14 桁の読み戻し（形が違う、またはありえない日時は `RangeError`）は、書式の owner の `src/core/utc-timestamp.ts` に移した（CC-063。
// CCX-11）。ここからも同じものを公開する（管理データの各部品が、ここから読み込んでいるため）。
export { dateOfCompactUtcTimestamp };

const timeOf = (value: string): number => dateOfCompactUtcTimestamp(value).getTime();

const stampOf = (timeMs: number): string => formatCompactUtcTimestamp(new Date(timeMs), 'auto login limit time');

// ---------------------------------------------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------------------------------------------

/**
 * 自動ログインを始めてよいか（設計書 4.5）。止めている行があれば `AUTO_LOGIN_HELD`。なければ、最小の間隔・24 時間の上限・`Retry-After` の
 * それぞれで次に始められる時刻を求め、今より後のものがあれば `AUTO_LOGIN_RATE_LIMITED`（最も遅い時刻）。
 */
export const decideAutoLoginStart = (input: AutoLoginLimitInput): AutoLoginLimitDecision => {
  const nowMs = input.now instanceof Date ? input.now.getTime() : Number.NaN;
  if (Number.isNaN(nowMs)) {
    throw new RangeError('now must be a valid Date');
  }
  const starts = input.attempts.map((attempt) => timeOf(attempt.startedAt)).sort((left, right) => left - right);
  const retryDeadlines = input.attempts.flatMap((attempt) => (attempt.retryAfterUntil === null ? [] : [timeOf(attempt.retryAfterUntil)]));
  if (input.hold !== null) {
    return Object.freeze({ ok: false, reason: 'AUTO_LOGIN_HELD', nextAllowedAt: null });
  }

  const candidates: number[] = [];
  const lastStart = starts.at(-1);
  if (lastStart !== undefined) {
    candidates.push(lastStart + AUTO_LOGIN_MIN_INTERVAL_MS);
  }
  const inWindow = starts.filter((start) => start + AUTO_LOGIN_DAILY_WINDOW_MS > nowMs);
  if (inWindow.length >= AUTO_LOGIN_DAILY_MAX_ATTEMPTS) {
    // 窓の中の数が上限より 1 少なくなる時刻（古い方から数えて、上限を超えた分の次の記録が窓を出る時刻）。
    const leaving = inWindow[inWindow.length - AUTO_LOGIN_DAILY_MAX_ATTEMPTS] ?? nowMs;
    candidates.push(leaving + AUTO_LOGIN_DAILY_WINDOW_MS);
  }
  candidates.push(...retryDeadlines);

  const next = Math.max(nowMs, ...candidates);
  return next > nowMs
    ? Object.freeze({ ok: false, reason: 'AUTO_LOGIN_RATE_LIMITED', nextAllowedAt: stampOf(ceilToWholeSecondMs(next)) })
    : Object.freeze({ ok: true });
};

