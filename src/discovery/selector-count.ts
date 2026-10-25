// CSS の当たる数の数え方（T38a で `src/worker/entry-check-page.ts` から移した。振る舞いは変えない）。ブラウザの部品（`tests/architecture/discovery-boundary.test.ts`
// の `BROWSER_DISCOVERY_FILES`）。ページを操作しない（読むだけ。Gate (w)）。
// - 入口の確かめ（`src/worker/entry-check-page.ts`）、ログインの段の成功の画面のセレクタの案（`src/worker/login-stage-observation.ts`）、送らずに観察する probe の
//   欄の CSS（`src/interaction/submission-probe.ts`。T38a）が、同じ数え方を使う（書き写さない）。
// - 文書と、その中の open な shadow root ごとに CSS で探し（部品 `openRoots`・`queryAllInRoots`。CC-099）、当たった数と、ちょうど 1 つに当たったときに
//   それが読んだ要素（文書の根からの位置の要素）かを返す。標準の CSS でない値は、当たらない（数 0）とする。isolated world で動かす（呼ぶ側が
//   `readInIsolatedWorld` に渡す）。
import { isRecord } from '../core/guards.js';
import { composeInPage, type StandardReaders } from '../browser/in-page-readers.js';

/** 数える入力（要素ごとの、読んだ要素の位置と、数える CSS の並び）。 */
export interface SelectorCountInput {
  readonly checks: readonly { readonly path: readonly number[] | null; readonly selectors: readonly string[] }[];
}

/** 数えた結果（要素ごと、CSS ごとの、当たった数と、ちょうど 1 つに当たったときにそれが読んだ要素か）。 */
export type SelectorCountReading = readonly (readonly { readonly matches: number; readonly matchesElement: boolean }[])[];

/** ページの中で数える（isolated world で動く。外の値を参照しない）。 */
function countSelectorsReader(R: StandardReaders, input: SelectorCountInput): SelectorCountReading {
  // 文書と、その中の open な shadow root で探す（CC-099: 部品の `openRoots`・`queryAllInRoots`）。
  const roots = R.openRoots();
  const find = (selector: string): Node[] | null => {
    try {
      return R.queryAllInRoots(roots, selector);
    } catch {
      return null;
    }
  };
  return input.checks.map(({ path, selectors }) => {
    const element = path === null ? null : R.elementAtPath(path);
    return selectors.map((selector) => {
      const found = find(selector);
      if (found === null) return { matches: 0, matchesElement: false };
      return { matches: found.length, matchesElement: found.length === 1 && element !== null && found[0] === element };
    });
  });
}
export const countSelectorsInPage = composeInPage(countSelectorsReader);

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** 数えた結果の形を確かめる（要素ごとの CSS の数と合わなければ `null`）。 */
export const countReadingOf = (value: unknown, sizes: readonly number[]): SelectorCountReading | null =>
  Array.isArray(value) && value.length === sizes.length && value.every((row: unknown, index) =>
    Array.isArray(row) && row.length === sizes[index]
    && row.every((cell: unknown) => isRecord(cell) && isCount(cell['matches']) && typeof cell['matchesElement'] === 'boolean'))
    ? value as SelectorCountReading
    : null;
