// 決定的な値の取り出しの部品（Task 29 の設計書 2 章の seed の式、3 章の決定的な生成、4.2、5 章。T29b）。純粋な部品だけ。
// - seed: `stableHash(profileId, scenarioId, scenarioRevision, ruleSetDigest, executionGrantId)`（設計書 2 章の読み替え）。5 つの要素と形式の版を、
//   鍵を並べた JSON（`sortedKeysJsonOf`）にしてから SHA-256（`src/core/ids.ts` の `sha256HexOfText`）にかける（要素の境目がずれても同じ値に
//   ならない）。seed は小文字の 16 進 64 桁。
// - 列: seed と用途（`purpose`。欄の名前など、同じ seed から別の列を取り出すための印）とカウンタ（ブロックの番号。0 から）を、同じく鍵を
//   並べた JSON にして SHA-256 にかけ、その 32 バイトを 32 ビットの語 8 つ（ビッグエンディアン）として順に取り出す。語を使い切ったら、
//   カウンタを 1 進めた次のブロックに移る（継ぎ目）。
// - 範囲の中の一様な整数（`nextIntInclusive`）は、拒否のサンプリングで偏りを避ける（範囲の数で割り切れない端の値を捨てて取り直す）。
//   範囲の数が 2^32 以下なら語 1 つ、それより大きければ語 2 つ（53 ビット）を使う。
// - `Math.random`、`node:crypto` の乱数、今の時刻を使わない（`tests/architecture/data-rules-determinism.test.ts`）。
import { isNonNegativeSafeInteger, isPositiveSafeInteger } from '../../core/guards.js';
import { isSha256Fingerprint, sha256HexOfText } from '../../core/ids.js';
import { sortedKeysJsonOf } from '../../core/sorted-keys-json.js';

/** seed と列のブロックの形式の版（形式を変えたら上げる。同じ入力から前と違う値になるため）。 */
export const DATA_SEED_FORMAT_VERSION = 1;

/** seed の形（SHA-256 の小文字の 16 進 64 桁）。 */
const DATA_SEED_PATTERN = /^[0-9a-f]{64}$/u;

/** seed（`createDataSeed` が作る、小文字の 16 進 64 桁）。 */
export type DataSeed = string & { readonly __dataSeed: unique symbol };

/** seed の入力（設計書 2 章の式の要素）。 */
export interface DataSeedInput {
  readonly profileId: string;
  readonly scenarioId: string;
  /** シナリオの版（1 以上の整数）。 */
  readonly scenarioRevision: number;
  /** 規則の集まりの digest（`sha256:<小文字の16進64桁>`）。 */
  readonly ruleSetDigest: string;
  /** 実行の許可の id（許可は 1 回だけ使えるので、Run ごとに別の seed になる）。 */
  readonly executionGrantId: string;
}

/** 1 つのブロック（SHA-256 の 16 進 64 桁）から取り出す 32 ビットの語の数。 */
export const STREAM_WORDS_PER_BLOCK = 8;
/** 32 ビットの語 1 つの 16 進の桁の数。 */
const HEX_DIGITS_PER_WORD = 8;
const HEXADECIMAL_RADIX = 16;

/** 語 1 つのビットの数。 */
const WORD_BITS = 32;
/** 安全な整数のビットの数（`Number.MAX_SAFE_INTEGER` は 2^53 - 1）。 */
const SAFE_INTEGER_BITS = 53;
/** 32 ビットの語で表せる値の数（2^32）。 */
const UINT32_RANGE = 2 ** WORD_BITS;
/** 53 ビットで表せる値の数（2^53。`Number.MAX_SAFE_INTEGER + 1`）。 */
const UINT53_RANGE = 2 ** SAFE_INTEGER_BITS;
/** 53 ビットの値を作るとき、上位の語から捨てるビットの数（上位の語の 21 ビットと下位の語の 32 ビットを使う）。 */
const UPPER_WORD_SHIFT = WORD_BITS * 2 - SAFE_INTEGER_BITS;

/**
 * 拒否のサンプリングで取り直す回数の上限。1 回に捨てる確率は 1/2 未満なので、この回数を超える確率は 2^-64 未満（起きたら、決定的に
 * 同じ所で止まる誤りにする。終わらない繰り返しを作らない）。
 */
export const MAX_REJECTION_DRAWS = 64;

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** seed の形（小文字の 16 進 64 桁）の文字列か。 */
export const isDataSeed = (value: unknown): value is DataSeed => typeof value === 'string' && DATA_SEED_PATTERN.test(value);

/** seed を作る（設計書 2 章の式）。入力の形が違えば `TypeError`。 */
export const createDataSeed = (input: DataSeedInput): DataSeed => {
  if (
    !nonEmptyString(input.profileId)
    || !nonEmptyString(input.scenarioId)
    || !isPositiveSafeInteger(input.scenarioRevision)
    || !isSha256Fingerprint(input.ruleSetDigest)
    || !nonEmptyString(input.executionGrantId)
  ) {
    throw new TypeError('data seed input must have non-empty ids, a positive revision and a rule set digest');
  }
  return sha256HexOfText(sortedKeysJsonOf({
    version: DATA_SEED_FORMAT_VERSION,
    profileId: input.profileId,
    scenarioId: input.scenarioId,
    scenarioRevision: input.scenarioRevision,
    ruleSetDigest: input.ruleSetDigest,
    executionGrantId: input.executionGrantId,
  })) as DataSeed;
};

/** 列のブロック（カウンタ `block` の番号）の 32 ビットの語 `STREAM_WORDS_PER_BLOCK` 個（取り出す順）。 */
export const streamBlockWords = (seed: DataSeed, purpose: string, block: number): readonly number[] => {
  if (!isNonNegativeSafeInteger(block)) {
    throw new RangeError('stream block counter must be a non-negative safe integer');
  }
  const hex = sha256HexOfText(sortedKeysJsonOf({ version: DATA_SEED_FORMAT_VERSION, seed, purpose, block }));
  return Object.freeze(Array.from({ length: STREAM_WORDS_PER_BLOCK }, (_unused, index) =>
    Number.parseInt(hex.slice(index * HEX_DIGITS_PER_WORD, (index + 1) * HEX_DIGITS_PER_WORD), HEXADECIMAL_RADIX)));
};

/** 決定的な値の列（同じ seed と用途なら、同じ呼び出しの順で同じ値を返す）。 */
export interface DeterministicStream {
  readonly seed: DataSeed;
  readonly purpose: string;
  /** これまでに取り出した 32 ビットの語の数（拒否で捨てた語を含む）。 */
  readonly drawnWords: number;
  /** 次の 32 ビットの符号なし整数。 */
  nextUint32(): number;
  /**
   * `min` 以上 `max` 以下の一様な整数（拒否のサンプリング）。`min`・`max` は安全な整数で、`max - min` が `Number.MAX_SAFE_INTEGER` 以下
   * （でなければ `RangeError`）。
   */
  nextIntInclusive(min: number, max: number): number;
  /** 配列から 1 つを一様に選ぶ（空の配列は `RangeError`）。 */
  pick<T>(items: readonly T[]): T;
}

/** 拒否のサンプリング: `draw` の値（`0` 以上 `space` 未満の一様な整数）から、`0` 以上 `count` 未満の一様な整数を作る。 */
const uniformBelow = (count: number, space: number, draw: () => number): number => {
  const limit = space - (space % count);
  for (let attempt = 0; attempt < MAX_REJECTION_DRAWS; attempt += 1) {
    const value = draw();
    if (value < limit) {
      return value % count;
    }
  }
  throw new Error('deterministic stream rejected too many draws');
};

/** seed と用途から、決定的な値の列を作る。seed の形が違うか、用途が空なら `TypeError`。 */
export const createDeterministicStream = (seed: DataSeed, purpose: string): DeterministicStream => {
  if (!isDataSeed(seed) || !nonEmptyString(purpose)) {
    throw new TypeError('deterministic stream needs a data seed and a non-empty purpose');
  }
  let block = 0;
  let words = streamBlockWords(seed, purpose, block);
  let position = 0;
  let drawnWords = 0;

  const nextUint32 = (): number => {
    if (position >= STREAM_WORDS_PER_BLOCK) {
      block += 1;
      words = streamBlockWords(seed, purpose, block);
      position = 0;
    }
    const word = words[position];
    position += 1;
    drawnWords += 1;
    if (word === undefined) {
      throw new Error('deterministic stream block is shorter than expected');
    }
    return word;
  };

  const nextUint53 = (): number => (nextUint32() >>> UPPER_WORD_SHIFT) * UINT32_RANGE + nextUint32();

  const nextIntInclusive = (min: number, max: number): number => {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min || max - min > Number.MAX_SAFE_INTEGER) {
      throw new RangeError('deterministic stream range must be safe integers with min <= max and a safe span');
    }
    const count = max - min + 1;
    const offset = count <= UINT32_RANGE ? uniformBelow(count, UINT32_RANGE, nextUint32) : uniformBelow(count, UINT53_RANGE, nextUint53);
    return min + offset;
  };

  const pick = <T>(items: readonly T[]): T => {
    if (items.length === 0) {
      throw new RangeError('deterministic stream cannot pick from an empty list');
    }
    const item = items[nextIntInclusive(0, items.length - 1)];
    return item as T;
  };

  return {
    seed,
    purpose,
    get drawnWords() {
      return drawnWords;
    },
    nextUint32,
    nextIntInclusive,
    pick,
  };
};
