// CCX-12（台帳の CC-078 の後半）: 鍵を並べた JSON の owner（`src/core/sorted-keys-json.ts` の `sortedKeysJsonOf`）。
// - オブジェクトの鍵を、UTF-16 のコード単位の順に並べる（入れ子も）。配列の順は変えない。プリミティブの値はそのまま。
// - 置き換える前の 2 か所（`worker-protocol.ts` の `.sort()` と、`auth-setup-digest.ts` の `.sort(compareCodeUnits)`）の写しと、同じ文字列になる。
import { describe, expect, it } from 'vitest';
import { isRecord } from '../../src/core/guards.js';
import { sortedKeysJsonOf } from '../../src/core/sorted-keys-json.js';
import { compareCodeUnits } from '../../src/core/text.js';

/** 置き換える前の `worker-protocol.ts` の `withSortedKeys`（`.sort()`）の写し。 */
const legacyWorkerProtocolSorted = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(legacyWorkerProtocolSorted);
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, legacyWorkerProtocolSorted(value[key])]));
  }
  return value;
};

/** 置き換える前の `auth-setup-digest.ts` の `withSortedKeys`（`.sort(compareCodeUnits)`）の写し。 */
const legacyAuthSetupSorted = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(legacyAuthSetupSorted);
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort(compareCodeUnits).map((key) => [key, legacyAuthSetupSorted(value[key])]));
  }
  return value;
};

/** 鍵（U+FF61 と、サロゲートの対の U+1F600。コード単位の順では U+1F600 が先、コードポイントの順では後）。 */
const HALFWIDTH_STOP = '｡';
const GRINNING_FACE = '\u{1F600}';

/** 値と、鍵を並べた JSON（固定の文字列）。 */
const TABLE: readonly (readonly [label: string, value: unknown, json: string])[] = [
  ['a flat object', { b: 1, a: 2 }, '{"a":2,"b":1}'],
  ['nested objects in arrays (the array order is kept)', { z: [{ d: 1, c: 2 }, 3], y: { b: null, a: 'x' } }, '{"y":{"a":"x","b":null},"z":[{"c":2,"d":1},3]}'],
  ['integer-like keys', { b: 1, 10: 2, 2: 3, a: 4 }, '{"2":3,"10":2,"a":4,"b":1}'],
  ['upper-case before lower-case', { b: 1, B: 2, _: 3 }, '{"B":2,"_":3,"b":1}'],
  ['keys outside the BMP (UTF-16 code units)', { [HALFWIDTH_STOP]: 1, [GRINNING_FACE]: 2 }, `{"${GRINNING_FACE}":2,"${HALFWIDTH_STOP}":1}`],
  ['an array at the top', [{ b: 1, a: 2 }, 'x', null], '[{"a":2,"b":1},"x",null]'],
  ['an undefined value (dropped by JSON)', { b: undefined, a: 1 }, '{"a":1}'],
  ['a string', 'example', '"example"'],
  ['a number', 1, '1'],
  ['null', null, 'null'],
];

describe('CC-078: sortedKeysJsonOf (the owner in src/core/sorted-keys-json.ts)', () => {
  it.each(TABLE)('sorts the keys of %s', (_label, value, json) => {
    expect(sortedKeysJsonOf(value)).toBe(json);
  });

  it.each(TABLE)('matches both former copies for %s', (_label, value) => {
    expect(sortedKeysJsonOf(value)).toBe(JSON.stringify(legacyWorkerProtocolSorted(value)));
    expect(sortedKeysJsonOf(value)).toBe(JSON.stringify(legacyAuthSetupSorted(value)));
  });

  it('does not change the given value', () => {
    const value = { b: [{ d: 1, c: 2 }], a: 1 };
    sortedKeysJsonOf(value);
    expect(Object.keys(value)).toEqual(['b', 'a']);
    expect(Object.keys(value.b[0] ?? {})).toEqual(['d', 'c']);
  });
});
