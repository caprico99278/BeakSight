// 時間の単位の定数の唯一の owner（CCX-19。CC-046・CC-075）。ms と秒の倍率、秒・分・時・日の換算を、ここにだけ書く（Gate
// `tests/architecture/time-units-ownership.test.ts`: 時間の単位の掛け算と、同じ名前の単位の定数を、このファイルの外に書かない）。
// - 名前つきの長さ（「5 分」「24 時間」など）は、使う所がこの定数を掛けて作る（`5 * MINUTE_MS`）。
// - 暦の 1 日は `DAY_MS`（UTC の 24 時間。夏時間を考えない）。
// 純粋な定義だけのファイル（import なし）。

/** 1 秒のミリ秒の数。 */
export const MILLISECONDS_PER_SECOND = 1_000;
/** 1 分の秒の数。 */
export const SECONDS_PER_MINUTE = 60;
/** 1 時間の分の数。 */
export const MINUTES_PER_HOUR = 60;
/** 1 日の時間の数。 */
export const HOURS_PER_DAY = 24;

/** 1 時間の秒の数。 */
export const SECONDS_PER_HOUR = SECONDS_PER_MINUTE * MINUTES_PER_HOUR;
/** 1 日の秒の数。 */
export const SECONDS_PER_DAY = SECONDS_PER_HOUR * HOURS_PER_DAY;

/** 1 秒の長さ（ms）。 */
export const SECOND_MS = MILLISECONDS_PER_SECOND;
/** 1 分の長さ（ms）。 */
export const MINUTE_MS = SECONDS_PER_MINUTE * SECOND_MS;
/** 1 時間の長さ（ms）。 */
export const HOUR_MS = MINUTES_PER_HOUR * MINUTE_MS;
/** 1 日の長さ（ms。UTC の 24 時間）。 */
export const DAY_MS = HOURS_PER_DAY * HOUR_MS;
