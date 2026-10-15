/**
 * 決定的な値の取り出し（`src/control/data-rules/deterministic-stream.ts`。Task 29 の設計書 2 章の seed の式、3 章の決定的な生成、4.2。T29b）。
 * - 同じ seed で同じ列、seed の各要素の変化で別の列、用途（purpose）の違いで別の列。
 * - カウンタの継ぎ目: 1 つのブロック（SHA-256 の 32 バイト）から 32 ビットの語を順に取り出し、使い切ったらカウンタを進めた次のブロックに移る。
 * - 範囲の中の一様な整数（拒否のサンプリング）、配列から 1 つ選ぶ。多くの seed で範囲の両端まで出ること、偏りの簡単な検定。
 */
import { describe, expect, it } from 'vitest';
import {
  createDataSeed,
  createDeterministicStream,
  isDataSeed,
  STREAM_WORDS_PER_BLOCK,
  streamBlockWords,
  type DataSeedInput,
} from '../../src/control/data-rules/deterministic-stream.js';
import { createSha256Fingerprint } from '../../src/core/ids.js';

const BASE_INPUT: DataSeedInput = Object.freeze({
  profileId: 'PROFILE-1',
  scenarioId: 'SCENARIO-1',
  scenarioRevision: 1,
  ruleSetDigest: createSha256Fingerprint('rule-set-1'),
  executionGrantId: 'GRANT-1',
});

const PURPOSE = 'field:quantity';
/** 列を比べるときに取り出す語の数（2 ブロックをまたぐ）。 */
const COMPARED_WORDS = STREAM_WORDS_PER_BLOCK * 2 + 1;

const wordsOf = (input: DataSeedInput, purpose: string, count: number): readonly number[] => {
  const stream = createDeterministicStream(createDataSeed(input), purpose);
  return Array.from({ length: count }, () => stream.nextUint32());
};

describe('createDataSeed (Task 29 design 2)', () => {
  it('returns the same seed for the same input, and a seed shaped as 64 lowercase hex digits', () => {
    const first = createDataSeed(BASE_INPUT);
    expect(createDataSeed({ ...BASE_INPUT })).toBe(first);
    expect(isDataSeed(first)).toBe(true);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('changes the seed when any element of the seed input changes', () => {
    const variants: readonly DataSeedInput[] = [
      { ...BASE_INPUT, profileId: 'PROFILE-2' },
      { ...BASE_INPUT, scenarioId: 'SCENARIO-2' },
      { ...BASE_INPUT, scenarioRevision: 2 },
      { ...BASE_INPUT, ruleSetDigest: createSha256Fingerprint('rule-set-2') },
      { ...BASE_INPUT, executionGrantId: 'GRANT-2' },
    ];
    const seeds = new Set([BASE_INPUT, ...variants].map(createDataSeed));
    expect(seeds.size).toBe(variants.length + 1);
  });

  it('does not confuse the boundary between elements (each element is encoded separately)', () => {
    const left = createDataSeed({ ...BASE_INPUT, profileId: 'A', scenarioId: 'BC' });
    const right = createDataSeed({ ...BASE_INPUT, profileId: 'AB', scenarioId: 'C' });
    expect(left).not.toBe(right);
  });

  it('rejects an input that is not of the expected shape', () => {
    const invalid: readonly unknown[] = [
      { ...BASE_INPUT, profileId: '' },
      { ...BASE_INPUT, scenarioId: '' },
      { ...BASE_INPUT, executionGrantId: '' },
      { ...BASE_INPUT, scenarioRevision: 0 },
      { ...BASE_INPUT, scenarioRevision: 1.5 },
      { ...BASE_INPUT, ruleSetDigest: 'not-a-digest' },
    ];
    for (const input of invalid) {
      expect(() => createDataSeed(input as DataSeedInput), JSON.stringify(input)).toThrow(TypeError);
    }
  });

  it('accepts only 64 lowercase hex digits as a seed', () => {
    expect(isDataSeed('A'.repeat(64))).toBe(false);
    expect(isDataSeed('0'.repeat(63))).toBe(false);
    expect(isDataSeed(42)).toBe(false);
    expect(() => createDeterministicStream('0'.repeat(63) as never, PURPOSE)).toThrow(TypeError);
    expect(() => createDeterministicStream(createDataSeed(BASE_INPUT), '')).toThrow(TypeError);
  });
});

describe('createDeterministicStream (Task 29 design 3, 4.2)', () => {
  it('returns the same sequence for the same seed and purpose', () => {
    expect(wordsOf(BASE_INPUT, PURPOSE, COMPARED_WORDS)).toEqual(wordsOf({ ...BASE_INPUT }, PURPOSE, COMPARED_WORDS));
  });

  it('returns a different sequence when any element of the seed changes, or when the purpose changes', () => {
    const base = wordsOf(BASE_INPUT, PURPOSE, COMPARED_WORDS);
    const variants: readonly (readonly number[])[] = [
      wordsOf({ ...BASE_INPUT, profileId: 'PROFILE-2' }, PURPOSE, COMPARED_WORDS),
      wordsOf({ ...BASE_INPUT, scenarioId: 'SCENARIO-2' }, PURPOSE, COMPARED_WORDS),
      wordsOf({ ...BASE_INPUT, scenarioRevision: 2 }, PURPOSE, COMPARED_WORDS),
      wordsOf({ ...BASE_INPUT, ruleSetDigest: createSha256Fingerprint('rule-set-2') }, PURPOSE, COMPARED_WORDS),
      wordsOf({ ...BASE_INPUT, executionGrantId: 'GRANT-2' }, PURPOSE, COMPARED_WORDS),
      wordsOf(BASE_INPUT, 'field:price', COMPARED_WORDS),
    ];
    for (const variant of variants) {
      expect(variant).not.toEqual(base);
    }
  });

  it('reads the words of block 0 in order, then moves to block 1 at the seam (counter)', () => {
    const seed = createDataSeed(BASE_INPUT);
    const block0 = streamBlockWords(seed, PURPOSE, 0);
    const block1 = streamBlockWords(seed, PURPOSE, 1);
    expect(block0).toHaveLength(STREAM_WORDS_PER_BLOCK);
    expect(block1).toHaveLength(STREAM_WORDS_PER_BLOCK);
    expect(block1).not.toEqual(block0);
    const stream = createDeterministicStream(seed, PURPOSE);
    const drawn = Array.from({ length: STREAM_WORDS_PER_BLOCK * 2 }, () => stream.nextUint32());
    expect(drawn).toEqual([...block0, ...block1]);
    expect(stream.drawnWords).toBe(STREAM_WORDS_PER_BLOCK * 2);
  });

  it('returns 32-bit unsigned integers', () => {
    for (const word of wordsOf(BASE_INPUT, PURPOSE, COMPARED_WORDS)) {
      expect(Number.isInteger(word)).toBe(true);
      expect(word).toBeGreaterThanOrEqual(0);
      expect(word).toBeLessThan(2 ** 32);
    }
  });

  it('rejects a block counter that is not a non-negative safe integer', () => {
    const seed = createDataSeed(BASE_INPUT);
    expect(() => streamBlockWords(seed, PURPOSE, -1)).toThrow(RangeError);
    expect(() => streamBlockWords(seed, PURPOSE, 0.5)).toThrow(RangeError);
  });
});

/** 一様性の検定に使う seed の数（名前つきの回数）。 */
const UNIFORMITY_SEED_COUNT = 2_000;
/** 小さな範囲（両端と各値の出る回数を数える）。 */
const SMALL_RANGE_MIN = 3;
const SMALL_RANGE_MAX = 9;
/**
 * 各値の出る回数の許す幅（期待値に対する比）。2,000 回を 7 つの値に分けると期待値は約 286 回で、標準偏差は約 16 回。
 * 期待値の ±25%（約 ±71 回。4 標準偏差より広い）に入らなければ偏りとみなす（決定的な seed なので、結果は毎回同じ）。
 */
const UNIFORMITY_TOLERANCE_RATIO = 0.25;

const streamForIndex = (index: number) =>
  createDeterministicStream(createDataSeed({ ...BASE_INPUT, executionGrantId: `GRANT-${index}` }), PURPOSE);

describe('nextIntInclusive and pick (uniform, rejection sampling)', () => {
  it('reaches both ends of a small range over many seeds, and every value stays within the expected band', () => {
    const counts = new Map<number, number>();
    for (let index = 0; index < UNIFORMITY_SEED_COUNT; index += 1) {
      const value = streamForIndex(index).nextIntInclusive(SMALL_RANGE_MIN, SMALL_RANGE_MAX);
      expect(value).toBeGreaterThanOrEqual(SMALL_RANGE_MIN);
      expect(value).toBeLessThanOrEqual(SMALL_RANGE_MAX);
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    const valueCount = SMALL_RANGE_MAX - SMALL_RANGE_MIN + 1;
    expect(counts.size).toBe(valueCount);
    expect(counts.has(SMALL_RANGE_MIN)).toBe(true);
    expect(counts.has(SMALL_RANGE_MAX)).toBe(true);
    const expected = UNIFORMITY_SEED_COUNT / valueCount;
    for (const [value, count] of counts) {
      expect(Math.abs(count - expected), `value ${value}: ${count}`).toBeLessThanOrEqual(expected * UNIFORMITY_TOLERANCE_RATIO);
    }
  });

  it('reaches both halves of a range wider than 32 bits (53-bit draw)', () => {
    const min = 0;
    const max = Number.MAX_SAFE_INTEGER;
    const middle = Math.floor(max / 2);
    let low = 0;
    let high = 0;
    for (let index = 0; index < UNIFORMITY_SEED_COUNT; index += 1) {
      const value = streamForIndex(index).nextIntInclusive(min, max);
      expect(Number.isSafeInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(min);
      expect(value).toBeLessThanOrEqual(max);
      if (value <= middle) {
        low += 1;
      } else {
        high += 1;
      }
    }
    const expected = UNIFORMITY_SEED_COUNT / 2;
    expect(Math.abs(low - expected)).toBeLessThanOrEqual(expected * UNIFORMITY_TOLERANCE_RATIO);
    expect(Math.abs(high - expected)).toBeLessThanOrEqual(expected * UNIFORMITY_TOLERANCE_RATIO);
  });

  it('handles a range of one value, negative bounds, and the 32-bit edge', () => {
    const stream = streamForIndex(0);
    expect(stream.nextIntInclusive(5, 5)).toBe(5);
    const negative = stream.nextIntInclusive(-10, -8);
    expect(negative).toBeGreaterThanOrEqual(-10);
    expect(negative).toBeLessThanOrEqual(-8);
    const edge = stream.nextIntInclusive(0, 2 ** 32 - 1);
    expect(edge).toBeGreaterThanOrEqual(0);
    expect(edge).toBeLessThan(2 ** 32);
  });

  it('rejects an invalid range', () => {
    const stream = streamForIndex(0);
    expect(() => stream.nextIntInclusive(2, 1)).toThrow(RangeError);
    expect(() => stream.nextIntInclusive(0.5, 1)).toThrow(RangeError);
    expect(() => stream.nextIntInclusive(-1, Number.MAX_SAFE_INTEGER)).toThrow(RangeError);
  });

  it('picks every item of an array over many seeds, and rejects an empty array', () => {
    const items = ['a', 'b', 'c', 'd'] as const;
    const picked = new Set<string>();
    for (let index = 0; index < UNIFORMITY_SEED_COUNT; index += 1) {
      picked.add(streamForIndex(index).pick(items));
    }
    expect([...picked].sort()).toEqual([...items]);
    expect(() => streamForIndex(0).pick([])).toThrow(RangeError);
  });

  it('is deterministic for draws (same seed, same draws)', () => {
    const left = streamForIndex(7);
    const right = streamForIndex(7);
    const draw = (stream: ReturnType<typeof streamForIndex>) => [
      stream.nextIntInclusive(0, 6),
      stream.nextIntInclusive(0, Number.MAX_SAFE_INTEGER),
      stream.pick(['x', 'y', 'z']),
    ];
    expect(draw(left)).toEqual(draw(right));
  });
});
