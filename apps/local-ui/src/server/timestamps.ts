/**
 * 管理データの日時（UTC の 14 桁。`formatCompactUtcTimestamp`）を、画面に返す ISO 8601 にする（T23f で作り、T24f でプロファイルと監査のジョブの
 * 共用にした）。表示の書式は、画面の側で `formatDateTime` にかける。
 * - 読み戻しは、core の厳しい読み戻し（`parseCompactUtcTimestamp`）だけを使う（CC-063。CCX-11）。`Date.parse` の緩い読み戻し（2 月 30 日を
 *   3 月 2 日に繰り越すなど）を使わない。読み戻せない値は、日時の書式の「未観測」（`formatNotObserved`）として示す。
 */
import { formatNotObserved } from '../../../../src/presentation/format.js';
import { formatCompactUtcTimestamp, parseCompactUtcTimestamp } from '../../../../src/core/utc-timestamp.js';

/**
 * 今の時刻（管理データの UTC の 14 桁。`label` は誤りの文に入れる時刻の名前）。FM2R の Minor 13: 画面のサーバの保存の口が、それぞれに書いていた
 * `nowStamp` を、ここの 1 か所にまとめた。
 */
export const nowCompactTimestamp = (label: string): string => formatCompactUtcTimestamp(new Date(), label);

/** ISO 8601 の秒までの部分の長さ（`YYYY-MM-DDTHH:mm:ss`）。`toISOString` のミリ秒を除く。 */
const ISO_SECONDS_LENGTH = 'YYYY-MM-DDTHH:mm:ss'.length;
/** UTC を表す ISO 8601 の末尾。 */
const ISO_UTC_SUFFIX = 'Z';

/**
 * 保存の日時（UTC の 14 桁）を ISO 8601（秒まで。例: `2026-10-11T09:03:00Z`）にする。読み戻せない値（形が違う、ありえない日時）は、
 * 「未観測」の文言（`formatDateTime` がそのまま示す）。
 */
export const isoTimestampOf = (compact: string): string => {
  const date = parseCompactUtcTimestamp(compact);
  return date === null ? formatNotObserved() : `${date.toISOString().slice(0, ISO_SECONDS_LENGTH)}${ISO_UTC_SUFFIX}`;
};

/** `isoTimestampOf` の、値がないこと（`null`）を許す形。 */
export const isoTimestampOrNull = (compact: string | null): string | null => (compact === null ? null : isoTimestampOf(compact));

/** 保存の日時（UTC の 14 桁）の時刻（ms）。読み戻せない値（形が違う、ありえない日時）は `null`。 */
export const compactTimestampMs = (compact: string): number | null => parseCompactUtcTimestamp(compact)?.getTime() ?? null;
