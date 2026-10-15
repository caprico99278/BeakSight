/**
 * 画面のテストの補助の Gate（CCX-16。CC-066・CC-071・CC-081）。
 * - 画面のテストの補助（`apps/local-ui/tests/helpers/*.ts`）が公開する関数と、ページの補助（`helpers/ui-page.ts` の `createUiPageKit`）が返す関数と
 *   同じ名前の関数を、画面のテストのファイル（`apps/local-ui/tests/*.test.ts`）と、ほかの補助のファイルの中で定義し直さない（補助を使う）。
 *   補助の値を分割代入で受けるのは定義し直しではない（`const { openPage } = createUiPageKit(...)`）。
 * - 除外は、同じ名前で別の意味のものだけ（理由つきの閉じた一覧。使われなくなった除外も誤りにする）。
 * - 判定は、Node.js 標準の `fs`、正規表現、文字列の検索だけで行う。1 秒以内に終える。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const TESTS_DIRECTORY = 'apps/local-ui/tests';
const HELPERS_DIRECTORY = `${TESTS_DIRECTORY}/helpers`;
const PAGE_KIT_FILE = `${HELPERS_DIRECTORY}/ui-page.ts`;
/** 1 つのファイルの判定の上限（ms）。 */
const MAX_MS_PER_FILE = 1_000;

/** 同じ名前で別の意味の関数（ファイルの名前 → 名前と理由）。 */
const ALLOWED_REDEFINITIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  'auth-secret-markers.test.ts': Object.freeze({
    credentialsOf: '認証つきの fixture のサイト（AuthenticatedSite）の資格情報で、目印の一覧にも足す（発見の fixture のサイトの credentialsOf とは別の fixture）',
  }),
  'auth-ui-flows.test.ts': Object.freeze({
    credentialsOf: '認証つきの fixture のサイト（AuthenticatedSite）の資格情報（発見の fixture のサイトの credentialsOf とは別の fixture）',
  }),
});

interface SourceText {
  readonly name: string;
  readonly text: string;
}

const readTexts = (directory: string, suffix: string): readonly SourceText[] => readdirSync(directory)
  .filter((name) => name.endsWith(suffix))
  .sort()
  .map((name) => ({ name, text: readFileSync(join(directory, name), 'utf8').replaceAll('\r\n', '\n') }));

const TEST_FILES = readTexts(TESTS_DIRECTORY, '.test.ts');
const HELPER_FILES = readTexts(HELPERS_DIRECTORY, '.ts');

/** 補助のファイルが公開する関数と値の名前（`export const X`、`export function X`、`export async function X`）。 */
const exportedNamesOf = (text: string): readonly string[] =>
  [...text.matchAll(/^export\s+(?:async\s+)?(?:function\s*\*?|const)\s+([A-Za-z_$][\w$]*)/gmu)].map((match) => match[1] ?? '');

/** ページの補助が返す関数の名前（`createUiPageKit` の `return { ... };`）。 */
const pageKitNames = (): readonly string[] => {
  const text = HELPER_FILES.find(({ name }) => `${HELPERS_DIRECTORY}/${name}` === PAGE_KIT_FILE)?.text ?? '';
  const returned = /\n {2}return \{([^}]*)\};\n\};\n/u.exec(text)?.[1] ?? '';
  return returned.split(',').map((name) => name.trim()).filter((name) => name.length > 0);
};

/** 関数の定義（どの深さでも）: `function NAME`、`const NAME = (`・`async (`・`<T>(`・`x =>`・`function`。 */
const definesFunction = (text: string, name: string): boolean => new RegExp(
  `^[ \\t]*(?:export[ \\t]+)?(?:async[ \\t]+)?function[ \\t]*\\*?[ \\t]*${name}\\b`
  + `|^[ \\t]*(?:export[ \\t]+)?const[ \\t]+${name}[ \\t]*(?::[^=\\n]*)?=[ \\t]*(?:async[ \\t]*)?(?:\\(|<|[A-Za-z_$][\\w$]*[ \\t]*=>|function\\b)`,
  'mu',
).test(text);

/** 補助の名前（名前 → 定義した補助のファイル）。 */
const helperNames = (): ReadonlyMap<string, string> => {
  const names = new Map<string, string>();
  for (const { name, text } of HELPER_FILES) {
    for (const exported of exportedNamesOf(text)) {
      names.set(exported, name);
    }
  }
  for (const kitName of pageKitNames()) {
    names.set(kitName, 'ui-page.ts');
  }
  return names;
};

describe('Gate: the screen tests use the shared helpers (CCX-16)', () => {
  it('reads the names of the page kit and the exported helpers', () => {
    const kit = pageKitNames();
    expect(kit).toEqual(expect.arrayContaining(['openPage', 'recordPage', 'expectCleanPages', 'expectCleanAndClosePages', 'forgetPages', 'tabTo', 'screenshot']));
    const names = helperNames();
    for (const exported of ['filesUnder', 'leakedPlaces', 'textPlace', 'databaseRowsPlace', 'credentialsOf', 'placeNameOf', 'nonReadRequestsOf', 'createUiPageKit']) {
      expect(names.has(exported), exported).toBe(true);
    }
  });

  it('does not define again a function with the name of a shared helper in a screen test or another helper', () => {
    const started = performance.now();
    const names = helperNames();
    const found: string[] = [];
    const usedExceptions = new Set<string>();
    for (const { name: fileName, text } of TEST_FILES) {
      for (const helperName of names.keys()) {
        if (!definesFunction(text, helperName)) {
          continue;
        }
        if (ALLOWED_REDEFINITIONS[fileName]?.[helperName] !== undefined) {
          usedExceptions.add(`${fileName}:${helperName}`);
          continue;
        }
        found.push(`${fileName}: ${helperName} (${names.get(helperName) ?? ''})`);
      }
    }
    for (const { name: fileName, text } of HELPER_FILES) {
      for (const [helperName, owner] of names) {
        if (owner !== fileName && definesFunction(text, helperName)) {
          found.push(`helpers/${fileName}: ${helperName} (${owner})`);
        }
      }
    }
    expect(found).toEqual([]);
    // 使われなくなった除外を残さない。
    const declared = Object.entries(ALLOWED_REDEFINITIONS).flatMap(([fileName, entries]) => Object.keys(entries).map((helperName) => `${fileName}:${helperName}`));
    expect(declared.filter((entry) => !usedExceptions.has(entry))).toEqual([]);
    expect(performance.now() - started).toBeLessThan(MAX_MS_PER_FILE * (TEST_FILES.length + HELPER_FILES.length));
  });

  it('finds a redefinition that is placed on purpose (the control)', () => {
    expect(definesFunction('const openPage = async (path: string): Promise<Page> => {', 'openPage')).toBe(true);
    expect(definesFunction('  const tabTo = async (page: Page, target: Locator): Promise<void> => {', 'tabTo')).toBe(true);
    expect(definesFunction('async function filesUnder(directory: string) {', 'filesUnder')).toBe(true);
    expect(definesFunction('const leakedPlaces = <T>(places: T[]) => places;', 'leakedPlaces')).toBe(true);
    expect(definesFunction('const { openPage, tabTo } = createUiPageKit({', 'openPage')).toBe(false);
    expect(definesFunction('const openPages = async () => {};', 'openPage')).toBe(false);
    expect(definesFunction('const page = await openPage(path);', 'openPage')).toBe(false);
  });
});
