// 汎用の規則（Task 29 の設計書 3 章の「型と制約で決まる」、4.2。T29b）。欄の型と制約だけから作れる値を、決定的な値の列から作る。純粋な関数。
// - 値の作り方は「値の空間」（値の数と、番号から値を作る関数）に分け、列から番号を一様に選ぶ（`DeterministicStream.nextIntInclusive`）。
//   判定（`checkGenericRule`）と生成（`generateGenericValue`）は、同じ値の空間の組み立てを使う（判定で作れると言えば、生成も作れる）。
// - number・range: min 以上 max 以下の、min を起点とする step の倍数（境界を含む）。小数は 10 進の整数に直して数える（浮動小数点の誤差を
//   作らない）。step の既定は 1。range は HTML の既定（min 0、max 100）を使う（値の空間がブラウザで決まっているため）。number は min・max
//   の両方が要る。step の `any`、指数の表記、0 以下の step、安全な整数を超える数の値は扱わない。
// - date・month・week・time・datetime-local: min・max の両方が要る。step は、各型の単位（日・月・週・秒）の正の整数（既定は date・month・
//   week が 1、time・datetime-local が 60 秒。HTML の既定）。min を起点とする step の倍数。time の min > max（日をまたぐ範囲）は扱わない。
//   範囲は欄の min・max だけで決める（設計書 10 章の 3）。基準日（実行の許可の発行日。Asia/Tokyo の日付）は、形を確かめて受けるだけで、
//   範囲を変えない（基準日からの範囲は、業務テンプレートと人の規則が決める。T29c）。
// - color: `#rrggbb`（小文字の 16 進）。
// - select・radio・checkbox: 選択肢の値（`CandidateField.options`）から、空の値（空白だけを含む）と危険な語の値（発見の分類と同じ比べ方。
//   `readParametersHaveDestructiveWord`）と無効化の語の値（T31a。`valueHasDisablingWord`）を除き、重なりを除いた値から選ぶ。select-multiple も
//   1 つだけ選ぶ。
// - ほかの型（text・search・textarea・email・tel・url・password・file・hidden）は `NOT_GENERIC_TYPE`（業務テンプレートか人の規則が要る。T29c）。
// - 作れない場合の理由は、契約の `NEEDS_RULE_INPUT` の細分（`rule-contracts.ts` の `NEEDS_RULE_INPUT_DETAILS`）の一部か、汎用の規則の対象の外の
//   印（`NOT_GENERIC_TYPE`。細分ではない。欄の判定（T29c）が業務テンプレートか人の規則に振り分ける）。
// - T29R-fix-1: 欄の step の格子の確かめ（`fieldStepFitOf`・`stepMultipleFitOf`・`alignUpToFieldStep`。M-1）と、値の一覧の間引き
//   （`genericValueSampleOf`。M-2）も、ここに置く（数と日時の読み書きの owner）。
// - `Math.random`、今の時刻を使わない（`tests/architecture/data-rules-determinism.test.ts`）。
import type { CandidateField, CandidateFieldType } from '../../discovery/candidate-contracts.js';
import { DISCOVERY_DISABLING_WORDS } from '../../discovery/classification-words.js';
import { fieldNameHasListedWord, readParametersHaveDestructiveWord } from '../../discovery/classify.js';
import { normalizeWhitespace } from '../../core/text.js';
import { DAY_MS, HOURS_PER_DAY, MINUTES_PER_HOUR, SECONDS_PER_DAY, SECONDS_PER_HOUR, SECONDS_PER_MINUTE } from '../../core/time-units.js';
import type { DeterministicStream } from './deterministic-stream.js';
import type { NeedsRuleInputDetail } from './rule-contracts.js';

/** 汎用の規則の対象の外の印（型から作れない。業務テンプレートか人の規則が要る）。契約の細分ではない（T29c の判定が振り分ける）。 */
export const NOT_GENERIC_TYPE = 'NOT_GENERIC_TYPE';

/**
 * 汎用の規則で作れない理由（契約の `NEEDS_RULE_INPUT` の細分の一部と、対象の外の印）。
 * - `RANGE_MISSING`: min か max がない。
 * - `RANGE_EMPTY`: min が max を超える。
 * - `CONSTRAINT_UNSUPPORTED`: min・max・step が扱える形でない（`any`、指数の表記、0 以下の step、ありえない日時、値の数が安全な整数を超える）。
 * - `NO_USABLE_OPTION`: 選択肢がないか、空の値と危険な語・無効化の語の値を除くと残らない。
 * - `NOT_GENERIC_TYPE`: 型から作れない（`NOT_GENERIC_TYPE`）。
 */
export type GenericRuleNeedsInputDetail = Extract<NeedsRuleInputDetail, 'RANGE_MISSING' | 'RANGE_EMPTY' | 'CONSTRAINT_UNSUPPORTED' | 'NO_USABLE_OPTION'>;
export type GenericRuleInputReason = GenericRuleNeedsInputDetail | typeof NOT_GENERIC_TYPE;

/** 汎用の規則の文脈。 */
export interface GenericRuleContext {
  /** 基準日（実行の許可の発行日。Asia/Tokyo の `YYYY-MM-DD`）。形が違えば `RangeError`。 */
  readonly baseDate: string;
}

/** 汎用の規則の結果。 */
export type GenericValueResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: GenericRuleInputReason };

/** 汎用の規則で値を作れる型（閉じた一覧）。 */
export const GENERIC_RULE_FIELD_TYPES = Object.freeze([
  'number',
  'range',
  'date',
  'month',
  'week',
  'time',
  'datetime-local',
  'color',
  'select-one',
  'select-multiple',
  'radio',
  'checkbox',
] as const satisfies readonly CandidateFieldType[]);
type GenericRuleFieldType = (typeof GENERIC_RULE_FIELD_TYPES)[number];

/** 値の空間（`count` 個の値。番号は 0 以上 `count` 未満）。 */
interface ValueSpace {
  readonly count: number;
  readonly valueAt: (index: number) => string;
}

type SpacePlan = ValueSpace | GenericRuleInputReason;

// ---------------------------------------------------------------------------------------------------------------
// 数（number・range）
// ---------------------------------------------------------------------------------------------------------------

/** HTML の range の既定の min・max（属性がないとき）。 */
const RANGE_DEFAULT_MIN = '0';
const RANGE_DEFAULT_MAX = '100';
/** HTML の number・range の既定の step。 */
const DEFAULT_NUMBER_STEP = '1';
/** 10 進の小数（符号、整数部、小数部。指数の表記は扱わない）。 */
const DECIMAL_PATTERN = /^(-?)(\d+)(?:\.(\d+))?$/u;
const DECIMAL_BASE = 10n;
const BIGINT_ZERO = 0n;
const BIGINT_ONE = 1n;
const DECIMAL_POINT = '.';
const MINUS_SIGN = '-';
const ZERO_DIGIT = '0';
/** 値の空間の数の上限（番号が安全な整数に収まる）。 */
const MAX_SPACE_COUNT = BigInt(Number.MAX_SAFE_INTEGER) + BIGINT_ONE;

interface ParsedDecimal {
  readonly negative: boolean;
  readonly integerDigits: string;
  readonly fractionDigits: string;
}

const parseDecimal = (text: string): ParsedDecimal | null => {
  const match = DECIMAL_PATTERN.exec(text);
  if (match === null) {
    return null;
  }
  return { negative: match[1] === MINUS_SIGN, integerDigits: match[2] ?? '', fractionDigits: match[3] ?? '' };
};

/** 小数を `scale` 桁の 10 進の整数にする（`1.5` を `scale` 2 で `150`）。 */
const scaledOf = (decimal: ParsedDecimal, scale: number): bigint => {
  const magnitude = BigInt(`${decimal.integerDigits}${decimal.fractionDigits.padEnd(scale, ZERO_DIGIT)}`);
  return decimal.negative ? -magnitude : magnitude;
};

/** `scale` 桁の 10 進の整数を、小数の文字列にする（小数部の末尾の 0 と、小数点だけの末尾を除く）。 */
const formatScaled = (value: bigint, scale: number): string => {
  const negative = value < BIGINT_ZERO;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, ZERO_DIGIT);
  const integerPart = digits.slice(0, digits.length - scale);
  let fractionPart = digits.slice(digits.length - scale);
  while (fractionPart.endsWith(ZERO_DIGIT)) {
    fractionPart = fractionPart.slice(0, -1);
  }
  const text = fractionPart.length > 0 ? `${integerPart}${DECIMAL_POINT}${fractionPart}` : integerPart;
  return negative ? `${MINUS_SIGN}${text}` : text;
};

const numberSpace = (minText: string | null, maxText: string | null, stepText: string | null): SpacePlan => {
  if (minText === null || maxText === null) {
    return 'RANGE_MISSING';
  }
  const min = parseDecimal(minText);
  const max = parseDecimal(maxText);
  const step = parseDecimal(stepText ?? DEFAULT_NUMBER_STEP);
  if (min === null || max === null || step === null || step.negative) {
    return 'CONSTRAINT_UNSUPPORTED';
  }
  const scale = Math.max(min.fractionDigits.length, max.fractionDigits.length, step.fractionDigits.length);
  const scaledMin = scaledOf(min, scale);
  const scaledMax = scaledOf(max, scale);
  const scaledStep = scaledOf(step, scale);
  if (scaledStep === BIGINT_ZERO) {
    return 'CONSTRAINT_UNSUPPORTED';
  }
  if (scaledMin > scaledMax) {
    return 'RANGE_EMPTY';
  }
  const count = (scaledMax - scaledMin) / scaledStep + BIGINT_ONE;
  if (count > MAX_SPACE_COUNT) {
    return 'CONSTRAINT_UNSUPPORTED';
  }
  return { count: Number(count), valueAt: (index) => formatScaled(scaledMin + BigInt(index) * scaledStep, scale) };
};

// ---------------------------------------------------------------------------------------------------------------
// 日時（date・month・week・time・datetime-local）
// ---------------------------------------------------------------------------------------------------------------

const MONTHS_PER_YEAR = 12;
const DAYS_PER_WEEK = 7;
/** HTML の日時の年の下限（0 年は扱わない）。4 桁の年だけを扱う。 */
const MIN_YEAR = 1;
const YEAR_WIDTH = 4;
const TWO_DIGIT_WIDTH = 2;
/** `toISOString` の日付の部分の長さ（`YYYY-MM-DD`）。 */
const ISO_DATE_LENGTH = 10;
/** 日の番号 0（1970-01-01）は木曜日。ISO の曜日（月曜日が 1）。 */
const EPOCH_ISO_WEEKDAY = 4;
const THURSDAY_ISO_WEEKDAY = 4;
const WEDNESDAY_ISO_WEEKDAY = 3;
const ISO_WEEKS_IN_LONG_YEAR = 53;
const ISO_WEEKS_IN_SHORT_YEAR = 52;
/** 週の 1 日目（月曜日）から木曜日までの日の数。 */
const MONDAY_TO_THURSDAY_DAYS = THURSDAY_ISO_WEEKDAY - 1;
/** 1 月 4 日を含む週が、ISO の第 1 週。 */
const FIRST_WEEK_ANCHOR_DAY = '-01-04';
const FIRST_DAY_OF_YEAR = '-01-01';
const LEAP_YEAR_EVERY = 4;
const LEAP_YEAR_SKIP_EVERY = 100;
const LEAP_YEAR_RESTORE_EVERY = 400;
/** HTML の既定の step（date・month・week は 1 単位、time・datetime-local は 60 秒）。 */
const DEFAULT_UNIT_STEP = 1;
const DEFAULT_TIME_STEP_SECONDS = SECONDS_PER_MINUTE;
/** step（各型の単位の正の整数）。 */
const POSITIVE_INTEGER_PATTERN = /^\d+$/u;
const UTC_MIDNIGHT_SUFFIX = 'T00:00:00Z';
const DATE_TIME_SEPARATOR = 'T';
const TIME_SEPARATOR = ':';
const WEEK_SEPARATOR = '-W';
const DATE_SEPARATOR = '-';

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const MONTH_PATTERN = /^(\d{4})-(\d{2})$/u;
const WEEK_PATTERN = /^(\d{4})-W(\d{2})$/u;
const TIME_PATTERN = /^(\d{2}):(\d{2})(?::(\d{2}))?$/u;
const DATE_TIME_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2})?)$/u;

const pad = (value: number, width: number): string => String(value).padStart(width, ZERO_DIGIT);
/** 負の数でも 0 以上 `divisor` 未満を返す剰余。 */
const modulo = (value: number, divisor: number): number => ((value % divisor) + divisor) % divisor;

/** 日の番号（1970-01-01 が 0）を `YYYY-MM-DD` にする。 */
const formatDay = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, ISO_DATE_LENGTH);

/** `YYYY-MM-DD` を日の番号にする（ありえない日付、0 年は null。繰り越さない）。 */
const parseDay = (text: string): number | null => {
  const match = DATE_PATTERN.exec(text);
  if (match === null || Number(match[1]) < MIN_YEAR) {
    return null;
  }
  const milliseconds = Date.parse(`${text}${UTC_MIDNIGHT_SUFFIX}`);
  if (Number.isNaN(milliseconds)) {
    return null;
  }
  const day = milliseconds / DAY_MS;
  return formatDay(day) === text ? day : null;
};

const yearOfDay = (day: number): number => Number(formatDay(day).slice(0, YEAR_WIDTH));

/** ISO の曜日（月曜日が 1、日曜日が 7）。 */
const isoWeekdayOf = (day: number): number => modulo(day + EPOCH_ISO_WEEKDAY - 1, DAYS_PER_WEEK) + 1;

const isLeapYear = (year: number): boolean =>
  (year % LEAP_YEAR_EVERY === 0 && year % LEAP_YEAR_SKIP_EVERY !== 0) || year % LEAP_YEAR_RESTORE_EVERY === 0;

/** ISO の第 1 週の月曜日の日の番号。 */
const firstIsoMondayOf = (year: number): number => {
  const anchor = parseDay(`${pad(year, YEAR_WIDTH)}${FIRST_WEEK_ANCHOR_DAY}`) ?? 0;
  return anchor - (isoWeekdayOf(anchor) - 1);
};

/** ISO の週の数（1 月 1 日が木曜日の年と、1 月 1 日が水曜日のうるう年は 53）。 */
const isoWeeksInYear = (year: number): number => {
  const firstDay = parseDay(`${pad(year, YEAR_WIDTH)}${FIRST_DAY_OF_YEAR}`) ?? 0;
  const weekday = isoWeekdayOf(firstDay);
  return weekday === THURSDAY_ISO_WEEKDAY || (weekday === WEDNESDAY_ISO_WEEKDAY && isLeapYear(year))
    ? ISO_WEEKS_IN_LONG_YEAR
    : ISO_WEEKS_IN_SHORT_YEAR;
};

/** 月の番号（年 × 12 + 月 - 1）。 */
const parseMonth = (text: string): number | null => {
  const match = MONTH_PATTERN.exec(text);
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  if (match === null || year < MIN_YEAR || month < 1 || month > MONTHS_PER_YEAR) {
    return null;
  }
  return year * MONTHS_PER_YEAR + month - 1;
};

const formatMonth = (index: number): string =>
  `${pad(Math.floor(index / MONTHS_PER_YEAR), YEAR_WIDTH)}${DATE_SEPARATOR}${pad(modulo(index, MONTHS_PER_YEAR) + 1, TWO_DIGIT_WIDTH)}`;

/** 週の番号（その週の月曜日の日の番号を 7 で割った値。月曜日の日の番号は、7 の倍数に `EPOCH_MONDAY_OFFSET` を足した値）。 */
const EPOCH_MONDAY_OFFSET = DAYS_PER_WEEK - (EPOCH_ISO_WEEKDAY - 1);

const parseWeek = (text: string): number | null => {
  const match = WEEK_PATTERN.exec(text);
  const year = Number(match?.[1]);
  const week = Number(match?.[2]);
  if (match === null || year < MIN_YEAR || week < 1 || week > isoWeeksInYear(year)) {
    return null;
  }
  const monday = firstIsoMondayOf(year) + (week - 1) * DAYS_PER_WEEK;
  return (monday - EPOCH_MONDAY_OFFSET) / DAYS_PER_WEEK;
};

const formatWeek = (index: number): string => {
  const monday = index * DAYS_PER_WEEK + EPOCH_MONDAY_OFFSET;
  const isoYear = yearOfDay(monday + MONDAY_TO_THURSDAY_DAYS);
  const week = (monday - firstIsoMondayOf(isoYear)) / DAYS_PER_WEEK + 1;
  return `${pad(isoYear, YEAR_WIDTH)}${WEEK_SEPARATOR}${pad(week, TWO_DIGIT_WIDTH)}`;
};

/** 0 時からの秒の数（`HH:MM` か `HH:MM:SS`。小数の秒は null）。 */
const parseTime = (text: string): number | null => {
  const match = TIME_PATTERN.exec(text);
  const hours = Number(match?.[1]);
  const minutes = Number(match?.[2]);
  const seconds = Number(match?.[3] ?? ZERO_DIGIT);
  if (match === null || hours >= HOURS_PER_DAY || minutes >= MINUTES_PER_HOUR || seconds >= SECONDS_PER_MINUTE) {
    return null;
  }
  return hours * SECONDS_PER_HOUR + minutes * SECONDS_PER_MINUTE + seconds;
};

/** 0 時からの秒の数を `HH:MM`（秒が 0 でなければ `HH:MM:SS`）にする。 */
const formatTime = (secondsOfDay: number): string => {
  const hours = Math.floor(secondsOfDay / SECONDS_PER_HOUR);
  const minutes = Math.floor(modulo(secondsOfDay, SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const seconds = modulo(secondsOfDay, SECONDS_PER_MINUTE);
  const hoursAndMinutes = `${pad(hours, TWO_DIGIT_WIDTH)}${TIME_SEPARATOR}${pad(minutes, TWO_DIGIT_WIDTH)}`;
  return seconds === 0 ? hoursAndMinutes : `${hoursAndMinutes}${TIME_SEPARATOR}${pad(seconds, TWO_DIGIT_WIDTH)}`;
};

/** 1970-01-01T00:00 からの秒の数。 */
const parseDateTime = (text: string): number | null => {
  const match = DATE_TIME_PATTERN.exec(text);
  const day = parseDay(match?.[1] ?? '');
  const time = parseTime(match?.[2] ?? '');
  return match === null || day === null || time === null ? null : day * SECONDS_PER_DAY + time;
};

const formatDateTime = (seconds: number): string =>
  `${formatDay(Math.floor(seconds / SECONDS_PER_DAY))}${DATE_TIME_SEPARATOR}${formatTime(modulo(seconds, SECONDS_PER_DAY))}`;

/** 日時の型の単位（番号の読み書きと、step の既定）。 */
interface TemporalUnit {
  readonly parse: (text: string) => number | null;
  readonly format: (index: number) => string;
  readonly defaultStep: number;
}

const TEMPORAL_UNITS: Readonly<Record<'date' | 'month' | 'week' | 'time' | 'datetime-local', TemporalUnit>> = Object.freeze({
  date: { parse: parseDay, format: formatDay, defaultStep: DEFAULT_UNIT_STEP },
  month: { parse: parseMonth, format: formatMonth, defaultStep: DEFAULT_UNIT_STEP },
  week: { parse: parseWeek, format: formatWeek, defaultStep: DEFAULT_UNIT_STEP },
  time: { parse: parseTime, format: formatTime, defaultStep: DEFAULT_TIME_STEP_SECONDS },
  'datetime-local': { parse: parseDateTime, format: formatDateTime, defaultStep: DEFAULT_TIME_STEP_SECONDS },
});

const temporalSpace = (unit: TemporalUnit, minText: string | null, maxText: string | null, stepText: string | null): SpacePlan => {
  if (minText === null || maxText === null) {
    return 'RANGE_MISSING';
  }
  const min = unit.parse(minText);
  const max = unit.parse(maxText);
  const step = stepText === null ? unit.defaultStep : POSITIVE_INTEGER_PATTERN.test(stepText) ? Number(stepText) : null;
  if (min === null || max === null || step === null || !Number.isSafeInteger(step) || step <= 0) {
    return 'CONSTRAINT_UNSUPPORTED';
  }
  if (min > max) {
    return 'RANGE_EMPTY';
  }
  return { count: Math.floor((max - min) / step) + 1, valueAt: (index) => unit.format(min + index * step) };
};

// ---------------------------------------------------------------------------------------------------------------
// 色と選択肢
// ---------------------------------------------------------------------------------------------------------------

/** `#rrggbb` の値の数（2^24）。 */
const COLOR_HEX_DIGITS = 6;
const HEXADECIMAL_RADIX = 16;
const COLOR_VALUE_COUNT = HEXADECIMAL_RADIX ** COLOR_HEX_DIGITS;
const COLOR_PREFIX = '#';

const COLOR_SPACE: ValueSpace = Object.freeze({
  count: COLOR_VALUE_COUNT,
  valueAt: (index: number) => `${COLOR_PREFIX}${index.toString(HEXADECIMAL_RADIX).padStart(COLOR_HEX_DIGITS, ZERO_DIGIT)}`,
});

/** 危険な語の比べにかける値の名前（空の名前。値だけを比べる）。 */
const OPTION_VALUE_ONLY_NAME = '';

/**
 * 使える選択肢の値（空の値と、危険な語・無効化の語の値を除き、重なりを除く。出てきた順）。T29c の欄の判定（固定の値と、通知の欄の「送らない」側）も
 * 使う。T31a: 無効化の語（`valueHasDisablingWord`）の値も除く（CREATE の生成にも効く）。
 */
export const usableOptionValues = (options: readonly string[] | null): readonly string[] => [...new Set((options ?? []).filter((value) =>
  normalizeWhitespace(value).length > 0 && !valueHasDestructiveWord(value) && !valueHasDisablingWord(value)))];

/** 値が、発見の分類の危険な語に当たるか（値だけを比べる。T29c の欄の判定が、人の固定の値にも使う）。 */
export function valueHasDestructiveWord(value: string): boolean {
  return readParametersHaveDestructiveWord({ [OPTION_VALUE_ONLY_NAME]: value });
}

/**
 * 値が、無効化の語（`DISCOVERY_DISABLING_WORDS`）に当たるか（T31a。値だけを比べる）。比べ方は欄の名前の語の比べの owner（`fieldNameHasListedWord`。
 * 英語の語は語の単位で `stopwatch` は `stop` に当たらない、日本語の語は部分一致）。欄の判定が、人の固定の値にも危険な語と同じく使う。
 */
export function valueHasDisablingWord(value: string): boolean {
  return fieldNameHasListedWord(value, DISCOVERY_DISABLING_WORDS);
}

const optionSpace = (options: readonly string[] | null): SpacePlan => {
  const values = usableOptionValues(options);
  return values.length === 0 ? 'NO_USABLE_OPTION' : { count: values.length, valueAt: (index) => values[index] ?? '' };
};

// ---------------------------------------------------------------------------------------------------------------
// 判定と生成
// ---------------------------------------------------------------------------------------------------------------

const isGenericRuleFieldType = (type: CandidateFieldType): type is GenericRuleFieldType =>
  (GENERIC_RULE_FIELD_TYPES as readonly CandidateFieldType[]).includes(type);

/** 基準日の形を確かめる（`YYYY-MM-DD` のありうる日付でなければ `RangeError`）。 */
const assertBaseDate = (context: GenericRuleContext): void => {
  if (parseDay(context.baseDate) === null) {
    throw new RangeError('generic rule base date must be a real YYYY-MM-DD date');
  }
};

/** 基準日が `YYYY-MM-DD` のありうる日付か（T29c。生成の入口が基準日を確かめる）。 */
export const isGenericBaseDate = (value: string): boolean => parseDay(value) !== null;

const planOf = (field: CandidateField): SpacePlan => {
  const { type, constraints, options } = field;
  if (!isGenericRuleFieldType(type)) {
    return NOT_GENERIC_TYPE;
  }
  switch (type) {
    case 'number':
      return numberSpace(constraints.min, constraints.max, constraints.step);
    case 'range':
      return numberSpace(constraints.min ?? RANGE_DEFAULT_MIN, constraints.max ?? RANGE_DEFAULT_MAX, constraints.step);
    case 'date':
    case 'month':
    case 'week':
    case 'time':
    case 'datetime-local':
      return temporalSpace(TEMPORAL_UNITS[type], constraints.min, constraints.max, constraints.step);
    case 'color':
      return COLOR_SPACE;
    case 'select-one':
    case 'select-multiple':
    case 'radio':
    case 'checkbox':
      return optionSpace(options);
  }
};

/** 2 つの 10 進の数の大小（読めなければ null）。 */
const compareDecimals = (left: string, right: string): number | null => {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  if (a === null || b === null) {
    return null;
  }
  const scale = Math.max(a.fractionDigits.length, b.fractionDigits.length);
  const difference = scaledOf(a, scale) - scaledOf(b, scale);
  return difference === BIGINT_ZERO ? 0 : difference > BIGINT_ZERO ? 1 : -1;
};

/** 日時の型の単位で、2 つの値の大小（読めなければ null）。 */
const compareTemporal = (unit: TemporalUnit, left: string, right: string): number | null => {
  const a = unit.parse(left);
  const b = unit.parse(right);
  return a === null || b === null ? null : Math.sign(a - b);
};

/** 選択肢の値を比べるときに試す日時の型の順。 */
const CHOICE_TEMPORAL_ORDER = Object.freeze(['datetime-local', 'date', 'time', 'month', 'week'] as const);

/**
 * 同じ欄の型の 2 つの値の大小（負・0・正。T29c の欄どうしの関係と範囲の確かめ）。number・range・text・search は 10 進の数、日時の型は各型の
 * 番号、select・radio は 10 進の数か、両方が同じ日時の形で読める値として比べる。読めなければ null（比べられない）。
 */
export const compareFieldValues = (type: CandidateFieldType, left: string, right: string): number | null => {
  switch (type) {
    case 'date':
    case 'month':
    case 'week':
    case 'time':
    case 'datetime-local':
      return compareTemporal(TEMPORAL_UNITS[type], left, right);
    case 'select-one':
    case 'select-multiple':
    case 'radio':
      return compareDecimals(left, right)
        ?? CHOICE_TEMPORAL_ORDER.map((unit) => compareTemporal(TEMPORAL_UNITS[unit], left, right)).find((order) => order !== null)
        ?? null;
    default:
      return compareDecimals(left, right);
  }
};

/** 10 進の整数の積（`left × right`。どちらかが小数・読めなければ null。T29c の合計 = 単価 × 数量）。 */
export const multiplyDecimalIntegers = (left: string, right: string): string | null => {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  if (a === null || b === null || a.fractionDigits.length > 0 || b.fractionDigits.length > 0) {
    return null;
  }
  return formatScaled(scaledOf(a, 0) * scaledOf(b, 0), 0);
};

/**
 * 汎用の規則で値を作れるか（作れれば null、作れなければ理由）。基準日は値の範囲を変えないので、判定には要らない（T29c の欄の判定は基準日なしで
 * 呼ぶ）。渡したときは形を確かめ、違えば `RangeError`。
 */
export const checkGenericRule = (field: CandidateField, context?: GenericRuleContext): GenericRuleInputReason | null => {
  if (context !== undefined) {
    assertBaseDate(context);
  }
  const plan = planOf(field);
  return typeof plan === 'string' ? plan : null;
};

/**
 * 汎用の規則の値の一覧（T29R-fix-1 の M-2。合計 = 単価 × 数量 の組み合わせを判定で確かめるため）。値の数が `maxCount` 以下ならすべて、超えれば
 * 値の空間を等しい間隔で `maxCount` 個に間引いた値（両端を含む。番号の順）。作れなければ null。
 */
export const genericValueSampleOf = (field: CandidateField, maxCount: number): readonly string[] | null => {
  const plan = planOf(field);
  if (typeof plan === 'string' || !Number.isSafeInteger(maxCount) || maxCount < 1) {
    return null;
  }
  if (plan.count <= maxCount) {
    return Object.freeze(Array.from({ length: plan.count }, (_unused, index) => plan.valueAt(index)));
  }
  const last = plan.count - 1;
  const divisor = Math.max(maxCount - 1, 1);
  const indexes = [...new Set(Array.from({ length: maxCount }, (_unused, position) => Math.floor((position * last) / divisor)))];
  return Object.freeze(indexes.map((index) => plan.valueAt(index)));
};

// ---------------------------------------------------------------------------------------------------------------
// 欄の step（T29R-fix-1 の M-1）
// ---------------------------------------------------------------------------------------------------------------

/**
 * 値が欄の step の格子に乗るか。
 * - `ON_STEP`: 乗る（step のない型、step が `any` を含む）。`OFF_STEP`: 乗らない。`UNSUPPORTED`: 値か step が読めない。
 * - 格子の起点は HTML と同じく欄の min（なければ型の既定の起点: number・range は 0、date は 1970-01-01、month は 1970-01、week は 1970-W01、
 *   time は 00:00、datetime-local は 1970-01-01T00:00。value の属性の起点は使わない。近似）。step の既定は、汎用の規則の既定と同じ。
 */
export type StepFit = 'ON_STEP' | 'OFF_STEP' | 'UNSUPPORTED';

/** HTML の step の、格子をなくす値。 */
const STEP_ANY = 'any';
/** 日時の型の、min がないときの格子の起点（HTML の既定の step base）。 */
const TEMPORAL_DEFAULT_STEP_BASES: Readonly<Record<keyof typeof TEMPORAL_UNITS, string>> = Object.freeze({
  date: '1970-01-01',
  month: '1970-01',
  week: '1970-W01',
  time: '00:00',
  'datetime-local': '1970-01-01T00:00',
});
/** number・range の、min がないときの格子の起点。 */
const NUMBER_DEFAULT_STEP_BASE = ZERO_DIGIT;

const isStepAny = (step: string | null): boolean => step !== null && step.trim().toLowerCase() === STEP_ANY;

/** 欄の格子（起点と step。整数に直した形）。格子のない欄は `ANY`、読めなければ null。 */
type StepGrid =
  | { readonly kind: 'NUMBER'; readonly base: ParsedDecimal; readonly step: ParsedDecimal }
  | { readonly kind: 'TEMPORAL'; readonly unit: TemporalUnit; readonly base: number; readonly step: number }
  | 'ANY'
  | null;

const stepGridOf = (field: CandidateField): StepGrid => {
  const { type, constraints } = field;
  if (isStepAny(constraints.step)) {
    return 'ANY';
  }
  if (type === 'number' || type === 'range') {
    const base = parseDecimal(constraints.min ?? (type === 'range' ? RANGE_DEFAULT_MIN : NUMBER_DEFAULT_STEP_BASE));
    const step = parseDecimal(constraints.step ?? DEFAULT_NUMBER_STEP);
    return base === null || step === null || step.negative || scaledOf(step, step.fractionDigits.length) === BIGINT_ZERO
      ? null
      : { kind: 'NUMBER', base, step };
  }
  if (type === 'date' || type === 'month' || type === 'week' || type === 'time' || type === 'datetime-local') {
    const unit = TEMPORAL_UNITS[type];
    const base = unit.parse(constraints.min ?? TEMPORAL_DEFAULT_STEP_BASES[type]);
    const step = constraints.step === null ? unit.defaultStep : POSITIVE_INTEGER_PATTERN.test(constraints.step) ? Number(constraints.step) : null;
    return base === null || step === null || !Number.isSafeInteger(step) || step <= 0 ? null : { kind: 'TEMPORAL', unit, base, step };
  }
  return 'ANY';
};

/** 値が欄の step の格子に乗るか（step のない型は `ON_STEP`）。 */
export const fieldStepFitOf = (field: CandidateField, value: string): StepFit => {
  const grid = stepGridOf(field);
  if (grid === 'ANY') {
    return 'ON_STEP';
  }
  if (grid === null) {
    return 'UNSUPPORTED';
  }
  if (grid.kind === 'TEMPORAL') {
    const index = grid.unit.parse(value);
    return index === null ? 'UNSUPPORTED' : modulo(index - grid.base, grid.step) === 0 ? 'ON_STEP' : 'OFF_STEP';
  }
  const parsed = parseDecimal(value);
  if (parsed === null) {
    return 'UNSUPPORTED';
  }
  const scale = Math.max(parsed.fractionDigits.length, grid.base.fractionDigits.length, grid.step.fractionDigits.length);
  return (scaledOf(parsed, scale) - scaledOf(grid.base, scale)) % scaledOf(grid.step, scale) === BIGINT_ZERO ? 'ON_STEP' : 'OFF_STEP';
};

/** 人の step が、欄の step の正の倍数か（欄の格子の上を、人の step で進めるか。step のない型は `ON_STEP`）。 */
export const stepMultipleFitOf = (field: CandidateField, step: string): StepFit => {
  const grid = stepGridOf(field);
  if (grid === 'ANY') {
    return 'ON_STEP';
  }
  if (grid === null) {
    return 'UNSUPPORTED';
  }
  if (grid.kind === 'TEMPORAL') {
    const value = POSITIVE_INTEGER_PATTERN.test(step) ? Number(step) : null;
    return value === null || !Number.isSafeInteger(value) || value <= 0 ? 'UNSUPPORTED' : value % grid.step === 0 ? 'ON_STEP' : 'OFF_STEP';
  }
  const parsed = parseDecimal(step);
  if (parsed === null || parsed.negative) {
    return 'UNSUPPORTED';
  }
  const scale = Math.max(parsed.fractionDigits.length, grid.step.fractionDigits.length);
  const scaled = scaledOf(parsed, scale);
  return scaled === BIGINT_ZERO ? 'UNSUPPORTED' : scaled % scaledOf(grid.step, scale) === BIGINT_ZERO ? 'ON_STEP' : 'OFF_STEP';
};

/** 値以上で、欄の step の格子に乗る最小の値（number・range だけ。格子のない欄と、ほかの型はそのまま。読めなければ null）。 */
export const alignUpToFieldStep = (field: CandidateField, value: string): string | null => {
  const grid = stepGridOf(field);
  if (grid === 'ANY' || (grid !== null && grid.kind === 'TEMPORAL' && fieldStepFitOf(field, value) === 'ON_STEP')) {
    return value;
  }
  if (grid === null || grid.kind === 'TEMPORAL') {
    return null;
  }
  const parsed = parseDecimal(value);
  if (parsed === null) {
    return null;
  }
  const scale = Math.max(parsed.fractionDigits.length, grid.base.fractionDigits.length, grid.step.fractionDigits.length);
  const base = scaledOf(grid.base, scale);
  const step = scaledOf(grid.step, scale);
  const offset = scaledOf(parsed, scale) - base;
  const steps = offset <= BIGINT_ZERO ? -((-offset) / step) : (offset + step - BIGINT_ONE) / step;
  return formatScaled(base + steps * step, scale);
};

/** 汎用の規則で値を作る（列から値の空間の番号を一様に選ぶ）。作れなければ理由。基準日の形が違えば `RangeError`。 */
export const generateGenericValue = (
  field: CandidateField,
  stream: DeterministicStream,
  context: GenericRuleContext,
): GenericValueResult => {
  assertBaseDate(context);
  const plan = planOf(field);
  if (typeof plan === 'string') {
    return Object.freeze({ ok: false, reason: plan });
  }
  return Object.freeze({ ok: true, value: plan.valueAt(stream.nextIntInclusive(0, plan.count - 1)) });
};
