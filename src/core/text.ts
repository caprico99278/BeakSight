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

// ---------------------------------------------------------------------------------------------------------------
// 文字の種類の判定（CCX-3。共通化の台帳の CC-052、CC-053）。制御文字・行と段落の区切り・向きを変える文字・対になっていないサロゲートの
// 判定と正規表現は、ここだけに置く（`tests/architecture/text-character-classes.test.ts` の Gate）。「Cc だけ」と「Cc と Zl・Zp」は
// 意味が違うので、名前を付けた変種として分けて置く。どれを使うかは、呼び出す側が決める。
// 正規表現は外に出さない（`g` の正規表現の `lastIndex` を、呼び出す側どうしで共有しないため）。
// ---------------------------------------------------------------------------------------------------------------

/** 制御文字（Unicode の一般カテゴリ Cc。C0、DEL、C1。NUL、TAB、LF、CR を含む）。 */
const CONTROL_CHARACTER = /\p{Cc}/u;
const CONTROL_CHARACTERS = /\p{Cc}/gu;

/** 制御文字（Cc）と、行・段落の区切り（一般カテゴリ Zl、Zp。U+2028、U+2029）。 */
const CONTROL_OR_LINE_SEPARATOR = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const CONTROL_OR_LINE_SEPARATORS = /[\p{Cc}\p{Zl}\p{Zp}]/gu;

/**
 * 表示の向きを変える文字（双方向の制御文字）: 向きの印の ALM（U+061C）・LRM（U+200E）・RLM（U+200F）、埋め込みと上書き
 * （U+202A〜U+202E）、分離（U+2066〜U+2069）。U+061C を含める（`CC-plan.md` の「設計者の判断」の 2。拒む側に寄せる）。
 */
export const BIDI_CONTROL_CHARACTERS: readonly string[] = Object.freeze([
  '\u061c', '\u200e', '\u200f', '\u202a', '\u202b', '\u202c', '\u202d', '\u202e', '\u2066', '\u2067', '\u2068', '\u2069',
]);
const BIDI_CONTROL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

/** 対になっていないサロゲート（孤立した上位・下位サロゲート）。`u` フラグでは、対になったサロゲートには一致しない。 */
const LONE_SURROGATES = /[\ud800-\udfff]/gu;

/** 制御文字（Cc だけ）を含むか。 */
export const hasControlCharacter = (value: string): boolean => CONTROL_CHARACTER.test(value);

/** 制御文字（Cc）か、行・段落の区切り（Zl、Zp）を含むか。 */
export const hasControlOrLineSeparator = (value: string): boolean => CONTROL_OR_LINE_SEPARATOR.test(value);

/** 表示の向きを変える文字（`BIDI_CONTROL_CHARACTERS`）を含むか。 */
export const hasBidiControl = (value: string): boolean => BIDI_CONTROL.test(value);

/** 対になっていないサロゲートを含むか（`!value.isWellFormed()` と同じ意味）。 */
export const hasLoneSurrogate = (value: string): boolean => !value.isWellFormed();

/** 制御文字（Cc だけ）を、1 文字ずつ `replacement` に置き換える。 */
export const replaceControlCharacters = (value: string, replacement: string): string =>
  value.replace(CONTROL_CHARACTERS, () => replacement);

/** 制御文字（Cc）と、行・段落の区切り（Zl、Zp）を、1 文字ずつ `replacement` に置き換える。 */
export const replaceControlOrLineSeparators = (value: string, replacement: string): string =>
  value.replace(CONTROL_OR_LINE_SEPARATORS, () => replacement);

/** 表示の向きを変える文字（`BIDI_CONTROL_CHARACTERS`）を除く。 */
export const removeBidiControls = (value: string): string => value.replace(BIDI_CONTROLS, '');

/** 対になっていないサロゲートを除く（対になったサロゲートは残す）。 */
export const removeLoneSurrogates = (value: string): string => value.replace(LONE_SURROGATES, '');

/**
 * 対になっていないサロゲートを、1 つずつ U+FFFD に置き換える（`value.toWellFormed()` と同じ。長さは変わらない）。PRE42-CC（CC-052・053 の残り）:
 * `toWellFormed()` の呼び出しは、ここと `truncateWellFormed` だけに書く（`tests/architecture/text-character-classes.test.ts` の Gate）。
 */
export const replaceLoneSurrogates = (value: string): string => value.toWellFormed();

/**
 * `value` を UTF-16 のコード単位で `maxLength` 以内に切り、対になっていないサロゲート（切った位置で割れた対を含む）を U+FFFD に置き換える
 * （`value.slice(0, maxLength).toWellFormed()` と同じ。`toWellFormed()` の後に切って、もう一度 `toWellFormed()` をかけた形とも同じになる）。
 * 結果は `maxLength` 以内で、対になっていないサロゲートを含まない。
 */
export const truncateWellFormed = (value: string, maxLength: number): string => value.slice(0, maxLength).toWellFormed();

/**
 * 比べるための畳み込み（CCX-15。共通化の台帳の CC-069）: Unicode の正規化（NFKC）の後に、`toUpperCase` の後に `toLowerCase` をかけた形。
 * `ſ`（U+017F）は `s` に、ケルビン記号（U+212A）は `k` に、全角の英字と記号（`／`、`；` を含む）は ASCII に、`ß` は `ss` に、合字（U+FB01）は
 * `fi` になる（順序は変えない。`toLowerCase` だけでは `ß` が残る）。ロケールに依存しない。要求の判定の owner の、除外のパスと危険な語の
 * 比べ（`src/safety/request-policy.ts`）と、発見の候補の分類（`src/discovery/classify.ts`）が使う。NFKC の正規化は、ここだけに書く
 * （`tests/architecture/text-character-classes.test.ts` の Gate）。
 */
export const foldNfkcCase = (value: string): string => value.normalize('NFKC').toUpperCase().toLowerCase();

/** 結合文字（Unicode の一般カテゴリ M）。 */
const COMBINING_MARKS = /\p{M}/gu;

/**
 * 結合文字を除いた形（T41a。Task 41 の設計書 3.1 の「秘密に見える名前の語」）: Unicode の正規化（NFD）の後に、結合文字（アクセント・濁点・重ね書きの記号
 * など）を除く。`tóken` は `token` に、`ド` は `ト` になる。秘密に見える名前の方針 6 の比べ（`src/discovery/classify.ts` の `isApiWriteKeyNameSecretLike`）が、
 * 名前と語の両方をこの形にしても比べる。正規化は、ここだけに書く（`foldNfkcCase` と同じ Gate）。
 */
export const stripCombiningMarks = (value: string): string => value.normalize('NFD').replace(COMBINING_MARKS, '');

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
