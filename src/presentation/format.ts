/**
 * 表示用の書式の唯一の owner（UI追補設計書 第4章）。文言の中の数値を、表示面や Rule の文言で同じ書き方にする。
 * - このファイルが import してよいのは、`src/core/**` と `src/config/types.ts` と、同じ表示の層の `src/presentation/**`
 *   （日本語の単位と「未観測」を、文言カタログ `messages.ts` から取るため）だけ（UI追補設計書の依存の向き）。
 * - 日本語の文言は置かない（文言は文言カタログと Rule の定義が持つ。GATE-UI06）。
 * - `formatDecimal`・`formatPixels`・`formatMilliseconds`・`formatPercent` は、値が有限の数であることを前提にする（Rule の文言用）。
 * - 日時・時間・データ量・件数・整数の書式（U16a、C16d で追加）は、観測できなかった値（`null`、有限でない数、負の数）を「未観測」と書く。
 *   0 や空文字にはしない（上位の設計書 14.11、GATE-UI05）。
 */
import { FORMAT_UNIT_TEXT, NOT_OBSERVED_TEXT } from './messages.js';

/** 文言に書く数値の、小数の最大の桁数の既定値。丸めるだけで、判定には使わない。 */
const DEFAULT_MAX_FRACTION_DIGITS = 3;

/** 割合（0〜1）を百分率で書くときの、小数の最大の桁数の既定値。 */
const DEFAULT_PERCENT_MAX_FRACTION_DIGITS = 1;

/** 割合から百分率への倍率。 */
const PERCENT_SCALE = 100;

/**
 * 数値を、小数 `maxFractionDigits` 桁までに四捨五入（`Math.round`）した10進の文字列にする。末尾の0は書かない（例: 12、0.1、1.235）。
 * -0 に丸まった値は `0` と書く。
 */
export const formatDecimal = (value: number, maxFractionDigits: number = DEFAULT_MAX_FRACTION_DIGITS): string => {
  const scale = 10 ** maxFractionDigits;
  return String(Math.round(value * scale) / scale);
};

/** px の値を、`formatDecimal` の書式に単位を付けて書く（例: `390 px`）。 */
export const formatPixels = (value: number): string => `${formatDecimal(value)} px`;

/** ミリ秒の値を、`formatDecimal` の書式に単位を付けて書く（例: `4000 ms`）。 */
export const formatMilliseconds = (value: number): string => `${formatDecimal(value)} ms`;

/**
 * 割合（1 が 100%）を、小数 `maxFractionDigits` 桁までの百分率で書く（例: 0.25 → `25%`、1/3 → `33.3%`）。
 * 丸めは、割合に `100 × 10^桁数` を一度だけ掛けてから行う（掛け算を分けると、浮動小数点の誤差で丸めの結果が変わるため）。
 */
export const formatPercent = (ratio: number, maxFractionDigits: number = DEFAULT_PERCENT_MAX_FRACTION_DIGITS): string => {
  const scale = 10 ** maxFractionDigits;
  return `${String(Math.round(ratio * (PERCENT_SCALE * scale)) / scale)}%`;
};

// ---------------------------------------------------------------------------------------------------------------
// 表示面の書式（UI追補設計書 4.1、U16a）
// ---------------------------------------------------------------------------------------------------------------

/** 表示の時間帯（UI追補設計書 第3章）。監査の対象の設定（`AuditConfig` の browser の timezone）とは別の、表示だけの決まり。 */
export const DISPLAY_TIME_ZONE = 'Asia/Tokyo';

/** 表示の時間帯の略称。`Asia/Tokyo` には夏時間がないので、固定の文字列でよい。 */
const DISPLAY_TIME_ZONE_ABBREVIATION = 'JST';

/** 1秒のミリ秒。 */
const MILLISECONDS_PER_SECOND = 1000;

/** 秒で書くときの、小数の最大の桁数。 */
const SECONDS_MAX_FRACTION_DIGITS = 1;

/** データ量の単位の倍率（1 KB = 1024 B）。 */
const BYTES_PER_KILOBYTE = 1024;

/** KB と MB で書くときの、小数の最大の桁数。 */
const BYTE_UNIT_MAX_FRACTION_DIGITS = 1;

/** 日時の各部分を、`Asia/Tokyo` の 24 時間制・2桁で取り出す。 */
const DATE_TIME_PARTS_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: DISPLAY_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** 件数の桁区切り（例: `1,234,567`）。 */
const COUNT_FORMAT = new Intl.NumberFormat('en-US', { useGrouping: true, maximumFractionDigits: 0 });

/** 観測した値として書ける数か（有限で、負でない）。負の値は、観測できなかったことの印（例: Resource Timing の -1）とみなす。 */
const isObservedQuantity = (value: number | null): value is number =>
  value !== null && Number.isFinite(value) && value >= 0;

/** 観測できなかった値の表示（「未観測」）。0 や空文字では代えない。 */
export const formatNotObserved = (): string => NOT_OBSERVED_TEXT;

/**
 * ISO 8601 の日時を、`Asia/Tokyo` の `YYYY-MM-DD HH:mm:ss JST` で書く（例: `2026-09-24 15:30:00 JST`）。
 * - `null` は「未観測」。
 * - 解析できない文字列は、記録されたままの文字列を返す（隠さない。HTML に入れるときは、部品がエスケープする）。
 */
export const formatDateTime = (isoTimestamp: string | null): string => {
  if (isoTimestamp === null) {
    return formatNotObserved();
  }
  const time = Date.parse(isoTimestamp);
  if (!Number.isFinite(time)) {
    return isoTimestamp;
  }
  const parts = new Map(DATE_TIME_PARTS_FORMAT.formatToParts(time).map((part) => [part.type, part.value]));
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.get(type) ?? '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')} ${DISPLAY_TIME_ZONE_ABBREVIATION}`;
};

/**
 * 時間（ミリ秒）を書く。1秒未満は整数の ms（例: `850 ms`）、1秒以上は小数1桁までの秒（例: `1.5秒`）。
 * 観測できなかった値は「未観測」。
 */
export const formatDuration = (milliseconds: number | null): string => {
  if (!isObservedQuantity(milliseconds)) {
    return formatNotObserved();
  }
  if (Math.round(milliseconds) < MILLISECONDS_PER_SECOND) {
    return formatMilliseconds(Math.round(milliseconds));
  }
  return `${formatDecimal(milliseconds / MILLISECONDS_PER_SECOND, SECONDS_MAX_FRACTION_DIGITS)}${FORMAT_UNIT_TEXT.seconds}`;
};

/**
 * データ量（バイト）を書く。1024 B 未満は整数の B、1024 KB 未満は小数1桁までの KB、それ以上は小数1桁までの MB
 * （例: `1023 B`、`1.5 KB`、`5.3 MB`）。観測できなかった値は「未観測」。
 */
export const formatBytes = (bytes: number | null): string => {
  if (!isObservedQuantity(bytes)) {
    return formatNotObserved();
  }
  if (bytes < BYTES_PER_KILOBYTE) {
    return `${formatDecimal(bytes, 0)} B`;
  }
  if (bytes < BYTES_PER_KILOBYTE ** 2) {
    return `${formatDecimal(bytes / BYTES_PER_KILOBYTE, BYTE_UNIT_MAX_FRACTION_DIGITS)} KB`;
  }
  return `${formatDecimal(bytes / BYTES_PER_KILOBYTE ** 2, BYTE_UNIT_MAX_FRACTION_DIGITS)} MB`;
};

/**
 * 整数（リンクの深さの上限、HTTP ステータスなど）を、桁区切りも単位も付けない10進の数字で書く（例: `3`、`404`。C16d）。
 * 整数でない値は、四捨五入（`Math.round`）する。-0 は `0` と書く。観測できなかった値（`null`、有限でない数、負の数）は、
 * ほかの表示面の書式と同じく「未観測」。
 */
export const formatInteger = (value: number | null): string => {
  if (!isObservedQuantity(value)) {
    return formatNotObserved();
  }
  return formatDecimal(value, 0);
};

/** 件数を、桁区切りと単位を付けて書く（例: `1,234件`）。観測できなかった値は「未観測」。 */
export const formatCount = (count: number | null): string => {
  if (!isObservedQuantity(count)) {
    return formatNotObserved();
  }
  return `${COUNT_FORMAT.format(count)}${FORMAT_UNIT_TEXT.count}`;
};
