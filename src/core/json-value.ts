// 作った値（文字列）を、API の本文の鍵の JSON の型に変える唯一の部品（Task 38 の設計書 3.6。T38e）。純粋な関数。
// - 値は今どおり DOM の欄に入れ、ページの JS が JSON を組み立てる。ここは、作った値が鍵の JSON の型で送られるときの値を求める（Task 39 の Guard の
//   照合（`src/safety/api-write-payload-policy.ts`）と、入力の規則の判定（`field-evaluation.ts`）・生成（`scenario-data.ts`）が使う）。ブラウザの部品を
//   import しない。
// - T39a: `src/safety/` は `src/control/` を import できない（Gate `control-boundary` の (a)）ので、T38e の `src/control/data-rules/json-value.ts` から
//   ここへ移した（control の入力の規則の部品は、`src/control/data-rules/json-value.ts` の公開し直しを通して、今までどおり読む）。
// - string: そのまま（空の文字列を含む）。
// - number: 正規の 10 進の形だけ（`-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?`。先頭の 0、小数部の末尾の 0、指数、`+`、`-0`、空白、16 進を拒む）。桁（符号と
//   小数点を除く数字の数）は `MAX_JSON_NUMBER_DIGITS` まで（IEEE 754 の倍精度で、10 進の値が変わらない桁の数）。JSON にした文字列が元の文字列と
//   同じでない値（`0.0000001` は `1e-7` になる）も拒む。
// - boolean: `true`・`false` だけ。null: 値を作らない（null）だけ。値を作らない（null）は、ほかの型では `VALUE_MISSING`。
// - object・array には変えない（`NOT_A_SCALAR_TYPE`）。
import type { ApiJsonValueType } from './api-request-shape.js';

/** 変えられる JSON の型（閉じた一覧。object・array は変えない）。 */
export const JSON_SCALAR_VALUE_TYPES = Object.freeze(['string', 'number', 'boolean', 'null'] as const satisfies readonly ApiJsonValueType[]);
export type JsonScalarValueType = (typeof JSON_SCALAR_VALUE_TYPES)[number];

/**
 * 変えられない理由（閉じた一覧）。
 * - `VALUE_MISSING`: 値を作らない（null）のに、型が null でない。
 * - `NOT_A_NUMBER`: 数として読めない（空、空白だけ、`Infinity`・`NaN`、全角の数字、区切りの記号など）。
 * - `NOT_CANONICAL_NUMBER`: 数として読めるが、正規の形でない（先頭の 0、小数部の末尾の 0、指数、`+`、`-0`、空白、16 進、JSON で指数の表記になる値）。
 * - `TOO_MANY_DIGITS`: 数字が `MAX_JSON_NUMBER_DIGITS` より多い。
 * - `NOT_A_BOOLEAN`: `true`・`false` でない。
 * - `NOT_NULL`: 型が null なのに、値を作った。
 * - `NOT_A_SCALAR_TYPE`: 型が object・array。
 */
export const JSON_VALUE_CONVERSION_FAILURES = Object.freeze([
  'VALUE_MISSING',
  'NOT_A_NUMBER',
  'NOT_CANONICAL_NUMBER',
  'TOO_MANY_DIGITS',
  'NOT_A_BOOLEAN',
  'NOT_NULL',
  'NOT_A_SCALAR_TYPE',
] as const);
export type JsonValueConversionFailure = (typeof JSON_VALUE_CONVERSION_FAILURES)[number];

/** 数の桁の上限（符号と小数点を除く数字の数。倍精度で 10 進の 15 桁までは値が変わらない）。 */
export const MAX_JSON_NUMBER_DIGITS = 15;

/** 変えた値か、変えられない理由。 */
export type JsonValueConversion =
  | { readonly ok: true; readonly value: string | number | boolean | null }
  | { readonly ok: false; readonly reason: JsonValueConversionFailure };

/** 正規の 10 進の数の形（`-0` は別に拒む）。 */
const CANONICAL_NUMBER_PATTERN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/u;
const NEGATIVE_ZERO_TEXT = '-0';
const MINUS_SIGN = '-';
const DECIMAL_POINT = '.';
const TRUE_TEXT = 'true';
const FALSE_TEXT = 'false';

const converted = (value: string | number | boolean | null): JsonValueConversion => Object.freeze({ ok: true, value });
const failed = (reason: JsonValueConversionFailure): JsonValueConversion => Object.freeze({ ok: false, reason });

/** 数の文字列の数字の数（符号と小数点を除く）。 */
const digitCountOf = (text: string): number =>
  text.length - (text.startsWith(MINUS_SIGN) ? MINUS_SIGN.length : 0) - (text.includes(DECIMAL_POINT) ? DECIMAL_POINT.length : 0);

const numberOf = (text: string): JsonValueConversion => {
  const number = Number(text);
  if (text.trim().length === 0 || !Number.isFinite(number)) {
    return failed('NOT_A_NUMBER');
  }
  if (!CANONICAL_NUMBER_PATTERN.test(text) || text === NEGATIVE_ZERO_TEXT) {
    return failed('NOT_CANONICAL_NUMBER');
  }
  if (digitCountOf(text) > MAX_JSON_NUMBER_DIGITS) {
    return failed('TOO_MANY_DIGITS');
  }
  return JSON.stringify(number) === text ? converted(number) : failed('NOT_CANONICAL_NUMBER');
};

/** 作った値（null は値を作らない）を、鍵の JSON の型の値に変える（純粋。凍結した結果）。 */
export const jsonValueOf = (value: string | null, type: ApiJsonValueType): JsonValueConversion => {
  switch (type) {
    case 'null':
      return value === null ? converted(null) : failed('NOT_NULL');
    case 'object':
    case 'array':
      return failed('NOT_A_SCALAR_TYPE');
    case 'string':
    case 'number':
    case 'boolean':
      break;
  }
  if (value === null) {
    return failed('VALUE_MISSING');
  }
  if (type === 'string') {
    return converted(value);
  }
  if (type === 'number') {
    return numberOf(value);
  }
  return value === TRUE_TEXT ? converted(true) : value === FALSE_TEXT ? converted(false) : failed('NOT_A_BOOLEAN');
};

/** 値が、鍵の JSON の型に変えられるか。 */
export const isJsonValueConvertible = (value: string | null, type: ApiJsonValueType): boolean => jsonValueOf(value, type).ok;

/** 正規の数の形の、整数部の数字の数と小数部の数字の数。 */
const partsOf = (text: string): { readonly integerDigits: number; readonly fractionDigits: number } => {
  const unsigned = text.startsWith(MINUS_SIGN) ? text.slice(MINUS_SIGN.length) : text;
  const point = unsigned.indexOf(DECIMAL_POINT);
  return point < 0
    ? { integerDigits: unsigned.length, fractionDigits: 0 }
    : { integerDigits: point, fractionDigits: unsigned.length - point - DECIMAL_POINT.length };
};

/**
 * 数の範囲（最小・最大・刻み。刻みは最小から数える）の値が、どれも number の鍵の値に変えられる見込みか（入力の規則の判定が使う）。端と刻みが
 * 正規の形で、範囲の中の値の数字の数（最も大きい端の整数部と、最小と刻みの小数部の長い方）が `MAX_JSON_NUMBER_DIGITS` まで。絶対値が 0.000001
 * 未満の値は JSON で指数の表記になるので、生成でも確かめる（`scenario-data.ts`）。
 */
export const jsonNumberRangeFits = (min: string, max: string, step: string): boolean => {
  if (![min, max, step].every((text) => isJsonValueConvertible(text, 'number'))) {
    return false;
  }
  const integerDigits = Math.max(partsOf(min).integerDigits, partsOf(max).integerDigits);
  const fractionDigits = Math.max(partsOf(min).fractionDigits, partsOf(step).fractionDigits);
  return integerDigits + fractionDigits <= MAX_JSON_NUMBER_DIGITS;
};
