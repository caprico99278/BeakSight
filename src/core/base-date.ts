// 入力の規則の基準日の唯一の owner（CCX-20。CC-083。Task 29 の設計書 3 章: 基準日は実行の許可の発行日（Asia/Tokyo の `YYYY-MM-DD`））。
// - ジョブの管理（`src/control/job/write-job-start.ts` の `writeBaseDateOf`。実行の許可の発行の時刻から）と、画面のサーバ（入力の規則の画面の
//   データの例。サーバの今日から）が、同じ関数で求める。日時の書式の部品なので `src/core/` に置く（画面のサーバと管理の両方から届く。入力の
//   規則の部品（`src/control/data-rules/`）は時刻を読まない純粋な部品のままにする）。
// 純粋な関数と名前つきの定数だけ。今の時刻を読まない（呼び出し側が時刻を渡す）。

/** 基準日の時刻帯。 */
export const BASE_DATE_TIME_ZONE = 'Asia/Tokyo';
/** `YYYY-MM-DD` の形で日付を書く地域の書式。 */
const ISO_DATE_LOCALE = 'en-CA';
/** 日付の書式の、年・月・日の桁。 */
const NUMERIC_YEAR = 'numeric';
const TWO_DIGITS = '2-digit';

const BASE_DATE_FORMAT = new Intl.DateTimeFormat(ISO_DATE_LOCALE, {
  timeZone: BASE_DATE_TIME_ZONE,
  year: NUMERIC_YEAR,
  month: TWO_DIGITS,
  day: TWO_DIGITS,
});

/** 時刻 `time` の、基準日の時刻帯（Asia/Tokyo）の `YYYY-MM-DD`。時刻が正しくなければ `RangeError`。 */
export const baseDateOf = (time: Date): string => BASE_DATE_FORMAT.format(time);
