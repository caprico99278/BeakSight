/**
 * SLIM-1: 流すテストを選ぶ判断のうち、ファイルを読まない部分（`tests/related-tests.mjs` が使う。単体 `tests/unit/related-selection.test.ts`）。
 * このファイルは何も import しない（`node tests/run-suite.mjs` が型の取り除きでそのまま読む）。
 */

/** 部品と、それを確かめるテスト（`tests/component-test-ledger.ts` の行と同じ形）。 */
export interface LedgerEntry {
  readonly component: string;
  readonly tests: readonly string[];
}

const uniqueSorted = (items: readonly string[]): string[] => [...new Set(items)].sort();

/** `path` が部品 `component`（`/` で終われば、その下の全部）に入るか。 */
export const isUnderComponent = (path: string, component: string): boolean =>
  component.endsWith('/') ? path.startsWith(component) : path === component;

/** 変えたファイルのうち台帳の部品に入るもの（`matched`）と、その部品の組のテスト（`tests`）。 */
export const ledgerSelectionOf = (changed: readonly string[], ledger: readonly LedgerEntry[]): { readonly matched: string[]; readonly tests: string[] } => {
  const hit = ledger.filter(({ component }) => changed.some((path) => isUnderComponent(path, component)));
  return {
    matched: changed.filter((path) => hit.some(({ component }) => isUnderComponent(path, component))),
    tests: uniqueSorted(hit.flatMap(({ tests }) => tests)),
  };
};

/** テストのファイルの中の、通る部品の印（1 行。例: `// covers: src/discovery/, src/control/job/`）。 */
const COVERS_MARK = /^\/\/\s*covers:\s*(.*)$/mu;

/** 印に書いた部品。印がなければ `undefined`。 */
export const coversOf = (content: string): readonly string[] | undefined => {
  const text = COVERS_MARK.exec(content)?.[1];
  return text === undefined ? undefined : text.split(',').map((item) => item.trim()).filter((item) => item !== '');
};

/** ビルドした本番（CLI・ワーカー・画面のサーバ）を子の process で動かすテストの候補。 */
export interface BuiltProductTest {
  readonly path: string;
  /** 通る部品の印。なければ `undefined`。 */
  readonly covers: readonly string[] | undefined;
  /** 変えたファイルが、このテストの動かす本番の入口から import でたどれるか（印のないときの選び方）。 */
  readonly touchesEntry: boolean;
}

/** 候補のうち選ぶもの。印があれば、印の部品に入る変えたファイルがあるとき。印がなければ、変えたファイルが入口からたどれるとき。 */
export const builtProductTestsFor = (changed: readonly string[], candidates: readonly BuiltProductTest[]): string[] =>
  uniqueSorted(candidates
    .filter(({ covers, touchesEntry }) => (covers === undefined ? touchesEntry : changed.some((path) => covers.some((component) => isUnderComponent(path, component)))))
    .map(({ path }) => path));

/** テストを速い組と遅い組に分ける（`slow` は遅い組の一覧 `SLOW_TEST_FILES`）。 */
export const splitByGroup = (tests: readonly string[], slow: readonly string[]): { readonly fast: string[]; readonly slow: string[] } => {
  const slowSet = new Set(slow);
  const all = uniqueSorted(tests);
  return { fast: all.filter((test) => !slowSet.has(test)), slow: all.filter((test) => slowSet.has(test)) };
};
