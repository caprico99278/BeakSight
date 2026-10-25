// 欄の pattern の閉じた単純な文法（Task 29 の設計書 3 章の「単純な形（数字の桁数、英数字の長さ）以外は NEEDS_RULE_INPUT」。T29c fix round 1）。
// - ページが書いた pattern を正規表現にしない（悪意のある pattern で、管理の側の Node が止まらないため。ReDoS）。正規表現を作らずに、1 文字ずつ
//   読んで解釈し、受ける形のときだけ値に当てる。受けない形・長すぎる pattern は null（判定は `PATTERN_UNSUPPORTED`）。
// - 受ける形（閉じた一覧）:
//   - 文字の集まり: `\d`、`[…]`（中身は `SIMPLE_PATTERN_CLASS_ITEMS` の部品の並びだけ。`0-9`・`A-Z`・`a-z`・カタカナとひらがなの範囲・`ー`）。
//   - 区切り: `-`、`\-`（そのまま 1 文字と一致）。
//   - 量: なし（1 回）、`+`（1 回以上）、`{n}`、`{n,m}`（`n` ≤ `m` ≤ `MAX_SIMPLE_PATTERN_REPEAT`）。
//   - 先頭の `^` と末尾の `$` は読み飛ばす（HTML の pattern は、値の全体に当たる）。
//   - T29R-fix-1（M-3）: 回数が決まらない量の部品は `MAX_SIMPLE_PATTERN_VARIABLE_QUANTIFIERS` 個まで。当てる値は
//     `MAX_SIMPLE_PATTERN_VALUE_LENGTH` 文字まで（長い値は当たらない）。
// - 当て方: 部品ごとに、値の中で届く位置の集まりを進める（バックトラックなし）。T29R-fix-1（M-3）: 位置ごとに「その位置から部品の文字が続く長さ」
//   を後ろから 1 回で求め、届く位置の区間を差分の配列で足し合わせる（部品 1 つにつき値の長さに比例する手間。全体で値の長さ × 部品の数）。
import { MAX_OPTION_VALUE_LENGTH, type CandidateFieldConstraints } from '../../discovery/candidate-contracts.js';

/** 受ける pattern の最大長（UTF-16 のコード単位）。 */
export const MAX_SIMPLE_PATTERN_LENGTH = 64;

/** 量（`{n}`・`{n,m}`）の最大。 */
export const MAX_SIMPLE_PATTERN_REPEAT = 256;

/** 部品の最大の数。 */
export const MAX_SIMPLE_PATTERN_TOKENS = 16;

/**
 * 回数が決まらない量（`+` と、`n` < `m` の `{n,m}`）の部品の最大の数（T29R-fix-1 の M-3）。届く位置の集まりを広げるのはこの部品だけなので、
 * 当てる手間（値の長さの 2 乗 × 部品の数）の上限を小さく保つ。超えれば受けない（`PATTERN_UNSUPPORTED`）。
 */
export const MAX_SIMPLE_PATTERN_VARIABLE_QUANTIFIERS = 4;

/** 当てる値の最大長（UTF-16 のコード単位。T29R-fix-1 の M-3）。人の固定の値 1 つの最大長と同じ。これより長い値は当たらない。 */
export const MAX_SIMPLE_PATTERN_VALUE_LENGTH = MAX_OPTION_VALUE_LENGTH;

type CodeUnitRange = readonly [number, number];

/** 文字の範囲の部品（`low-high` の表記と、その範囲）。鍵は文字の番号から作る（日本語の文字を文字列に書かない。GATE-UI06）。 */
const rangeItemOf = (low: number, high: number): readonly [string, CodeUnitRange] =>
  [`${String.fromCharCode(low)}-${String.fromCharCode(high)}`, Object.freeze([low, high] as const)];

/** 数字の範囲（`0-9`。`\d` と同じ）。 */
const DIGIT_RANGE: CodeUnitRange = Object.freeze([0x30, 0x39] as const);
/** 長音の記号（`ー`。U+30FC）。 */
const PROLONGED_SOUND_MARK = 0x30fc;

/**
 * 文字の集まりの部品（`[…]` の中身に並べてよいもの。閉じた一覧）と、その文字の範囲（UTF-16 のコード単位の最小と最大）: `0-9`、`A-Z`、`a-z`、
 * カタカナ（ァ〜ヶ・ァ〜ヴ・ァ〜ン）、ひらがな（ぁ〜ん）、長音の記号。鍵の並びは、読むときに試す順。
 */
export const SIMPLE_PATTERN_CLASS_ITEMS: Readonly<Record<string, CodeUnitRange>> = Object.freeze(Object.fromEntries([
  rangeItemOf(DIGIT_RANGE[0], DIGIT_RANGE[1]),
  rangeItemOf(0x41, 0x5a),
  rangeItemOf(0x61, 0x7a),
  rangeItemOf(0x30a1, 0x30f6),
  rangeItemOf(0x30a1, 0x30f4),
  rangeItemOf(0x30a1, 0x30f3),
  rangeItemOf(0x3041, 0x3093),
  [String.fromCharCode(PROLONGED_SOUND_MARK), Object.freeze([PROLONGED_SOUND_MARK, PROLONGED_SOUND_MARK] as const)],
]));

/** 数字の集まり（`\d`）。 */
const DIGIT_RANGES: readonly CodeUnitRange[] = Object.freeze([DIGIT_RANGE]);
/** 区切りの 1 文字。 */
const HYPHEN = '-';
const ESCAPED_HYPHEN = '\\-';
const DIGIT_ESCAPE = '\\d';
const CLASS_OPEN = '[';
const CLASS_CLOSE = ']';
const ONE_OR_MORE = '+';
const REPEAT_OPEN = '{';
const REPEAT_CLOSE = '}';
const REPEAT_SEPARATOR = ',';
const START_ANCHOR = '^';
const END_ANCHOR = '$';
const DECIMAL_RADIX = 10;
const ZERO_CODE_UNIT = 0x30;
const NINE_CODE_UNIT = 0x39;
/** `{n,m}` の数の最大の桁の数（`MAX_SIMPLE_PATTERN_REPEAT` の桁の数）。 */
const MAX_REPEAT_DIGITS = String(MAX_SIMPLE_PATTERN_REPEAT).length;

/** 部品 1 つ（文字の範囲の集まりと、量）。 */
interface SimplePatternToken {
  readonly ranges: readonly CodeUnitRange[];
  readonly min: number;
  /** 上限（`+` は無限）。 */
  readonly max: number;
}

/** 解釈した pattern（凍結）。 */
export interface SimplePattern {
  readonly tokens: readonly SimplePatternToken[];
}

/** 数字だけの文字列を整数にする（数字でない文字か、桁が多すぎれば null）。 */
const smallIntegerOf = (text: string): number | null => {
  if (text.length === 0 || text.length > MAX_REPEAT_DIGITS) {
    return null;
  }
  let value = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < ZERO_CODE_UNIT || code > NINE_CODE_UNIT) {
      return null;
    }
    value = value * DECIMAL_RADIX + (code - ZERO_CODE_UNIT);
  }
  return value;
};

/** `[…]` の中身を、部品の並びとして読む（読めなければ null）。 */
const classRangesOf = (inner: string): readonly CodeUnitRange[] | null => {
  const items = Object.entries(SIMPLE_PATTERN_CLASS_ITEMS);
  const ranges: CodeUnitRange[] = [];
  let position = 0;
  while (position < inner.length) {
    const item = items.find(([text]) => inner.startsWith(text, position));
    if (item === undefined) {
      return null;
    }
    ranges.push(item[1]);
    position += item[0].length;
  }
  return ranges.length === 0 ? null : ranges;
};

/** 量を読む（`position` から。読んだ量と次の位置。読めなければ null）。 */
const quantifierAt = (pattern: string, position: number, end: number): { readonly min: number; readonly max: number; readonly next: number } | null => {
  if (position < end && pattern[position] === ONE_OR_MORE) {
    return { min: 1, max: Number.POSITIVE_INFINITY, next: position + 1 };
  }
  if (position >= end || pattern[position] !== REPEAT_OPEN) {
    return { min: 1, max: 1, next: position };
  }
  const close = pattern.indexOf(REPEAT_CLOSE, position);
  if (close < 0 || close >= end) {
    return null;
  }
  const body = pattern.slice(position + 1, close);
  const separator = body.indexOf(REPEAT_SEPARATOR);
  const min = smallIntegerOf(separator < 0 ? body : body.slice(0, separator));
  const max = separator < 0 ? min : smallIntegerOf(body.slice(separator + 1));
  if (min === null || max === null || min > max || max > MAX_SIMPLE_PATTERN_REPEAT || max === 0) {
    return null;
  }
  return { min, max, next: close + 1 };
};

/** 文字の集まりか区切りを読む（`position` から。範囲と次の位置。読めなければ null）。 */
const atomAt = (pattern: string, position: number, end: number): { readonly ranges: readonly CodeUnitRange[]; readonly next: number } | null => {
  if (pattern.startsWith(DIGIT_ESCAPE, position)) {
    return { ranges: DIGIT_RANGES, next: position + DIGIT_ESCAPE.length };
  }
  const hyphenCode = HYPHEN.charCodeAt(0);
  if (pattern.startsWith(ESCAPED_HYPHEN, position)) {
    return { ranges: [[hyphenCode, hyphenCode]], next: position + ESCAPED_HYPHEN.length };
  }
  if (pattern[position] === HYPHEN) {
    return { ranges: [[hyphenCode, hyphenCode]], next: position + 1 };
  }
  if (pattern[position] === CLASS_OPEN) {
    const close = pattern.indexOf(CLASS_CLOSE, position + 1);
    if (close < 0 || close >= end) {
      return null;
    }
    const ranges = classRangesOf(pattern.slice(position + 1, close));
    return ranges === null ? null : { ranges, next: close + 1 };
  }
  return null;
};

/** pattern を閉じた単純な文法で解釈する（受けない形・長すぎる pattern は null。正規表現を作らない）。 */
export const parseSimplePattern = (pattern: string): SimplePattern | null => {
  if (pattern.length === 0 || pattern.length > MAX_SIMPLE_PATTERN_LENGTH) {
    return null;
  }
  let position = pattern.startsWith(START_ANCHOR) ? START_ANCHOR.length : 0;
  const end = pattern.endsWith(END_ANCHOR) ? pattern.length - END_ANCHOR.length : pattern.length;
  const tokens: SimplePatternToken[] = [];
  let variableQuantifiers = 0;
  while (position < end) {
    const atom = atomAt(pattern, position, end);
    if (atom === null) {
      return null;
    }
    const quantifier = quantifierAt(pattern, atom.next, end);
    if (quantifier === null || tokens.length >= MAX_SIMPLE_PATTERN_TOKENS) {
      return null;
    }
    variableQuantifiers += quantifier.max > quantifier.min ? 1 : 0;
    if (variableQuantifiers > MAX_SIMPLE_PATTERN_VARIABLE_QUANTIFIERS) {
      return null;
    }
    tokens.push(Object.freeze({ ranges: atom.ranges, min: quantifier.min, max: quantifier.max }));
    position = quantifier.next;
  }
  return tokens.length === 0 ? null : Object.freeze({ tokens: Object.freeze(tokens) });
};

const inRanges = (ranges: readonly CodeUnitRange[], code: number): boolean => ranges.some(([low, high]) => code >= low && code <= high);

/** 値の全体が、解釈した pattern に当たるか（届く位置の集まりを進める。バックトラックなし）。 */
export const matchesSimplePattern = (pattern: SimplePattern, value: string): boolean => {
  if (value.length > MAX_SIMPLE_PATTERN_VALUE_LENGTH) {
    return false;
  }
  const { length } = value;
  /** 届く位置（0 から値の長さまで。1 は届く）。 */
  let reachable = new Uint8Array(length + 1);
  reachable[0] = 1;
  for (const token of pattern.tokens) {
    // 位置ごとの、その位置から部品の文字が続く長さ（後ろから 1 回で求める）。
    const run = new Int32Array(length + 1);
    for (let position = length - 1; position >= 0; position -= 1) {
      run[position] = inRanges(token.ranges, value.charCodeAt(position)) ? (run[position + 1] ?? 0) + 1 : 0;
    }
    // 届く位置 `start` から、`start + min` 以上 `start + min(max, 続く長さ)` 以下の位置へ届く（区間を差分の配列で足し合わせる）。
    const marks = new Int32Array(length + 2);
    let reached = false;
    for (let start = 0; start <= length; start += 1) {
      const longest = Math.min(token.max, run[start] ?? 0);
      if (reachable[start] === 1 && longest >= token.min) {
        marks[start + token.min] = (marks[start + token.min] ?? 0) + 1;
        marks[start + longest + 1] = (marks[start + longest + 1] ?? 0) - 1;
        reached = true;
      }
    }
    if (!reached) {
      return false;
    }
    const next = new Uint8Array(length + 1);
    let open = 0;
    for (let position = 0; position <= length; position += 1) {
      open += marks[position] ?? 0;
      next[position] = open > 0 ? 1 : 0;
    }
    reachable = next;
  }
  return reachable[length] === 1;
};

/**
 * 数字だけの固定の桁数の pattern（FM2c の「番号・コード」。`^\d{7}$`、`[0-9]{4}` など）なら、その桁数（純粋）。部品がちょうど 1 つで、文字の集まりが
 * 数字（`\d` か `[0-9]`）だけ、量が固定（`n` 回）のときだけ。ほかは null。
 */
export const fixedDigitCountOf = (pattern: SimplePattern): number | null => {
  const [only] = pattern.tokens;
  if (only === undefined || pattern.tokens.length !== 1 || only.min !== only.max) {
    return null;
  }
  return only.ranges.every(([low, high]) => low === DIGIT_RANGE[0] && high === DIGIT_RANGE[1]) ? only.min : null;
};

/** 欄の pattern（なければ undefined、受けない形なら null）。 */
export const simplePatternOf = (constraints: Pick<CandidateFieldConstraints, 'pattern'>): SimplePattern | null | undefined =>
  (constraints.pattern === null ? undefined : parseSimplePattern(constraints.pattern));
