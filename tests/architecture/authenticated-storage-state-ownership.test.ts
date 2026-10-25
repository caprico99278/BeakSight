/**
 * 認証済みの状態の形の Architecture Gate（PRE42-CC 組 S3。台帳の CC-060 の B）。
 * - 認証済みの状態（Playwright の `storageState` と同じ形。Cookie、Origin ごとの localStorage、DEF-139 からは IndexedDB）の形の型と、Cookie の `SameSite` の
 *   値の一覧は、純粋な core のファイル（`src/core/authenticated-storage-state.ts`。import を持たない）の 1 か所に置く。Context の作り手
 *   （`src/browser/context-factory.ts`）と、認証の状態の絞り込みの owner（`src/control/auth/authenticated-state.ts`）は、そこから読む（監査の本体は
 *   `src/control/` を読めず、`src/control/` は Playwright を読まないため、以前は同じ形を 2 か所に定義していた）。
 * - (a) owner は import を持たず、一覧（`Object.freeze(`）と形の型を定義する。
 * - (b) owner の外の `src/**` と `apps/local-ui/src/**` に、次の書き写しを置かない（コメントは数えない）。
 *   - Cookie の形（`httpOnly: boolean` の宣言）。
 *   - `SameSite` の値の型の並び（`'Strict' | 'Lax'` のような、値の文字列リテラルの `|` の並び）。
 *   - `SameSite` の値と同じ集合の、文字列リテラルだけの配列（順と重複は問わない。`field-type-lists-ownership` と同じ作り）。
 *   - IndexedDB のデータベースの形（`version: number` に続く `stores`）。
 *   - localStorage の項目の型の直書き（`localStorage: readonly { … }`）。
 * - (c) 2 つの元の場所は、owner を読む（定義し直さない）。
 * - Cookie の `partitionKey` は owner に置かない（今は絞り込みの owner だけが写し、Context の作り手は写さない。扱いは CC-060 の C で決める）。
 * - 判定は、Node.js 標準の `fs`、正規表現、文字列の検索だけで行う（近似の検査）。1 秒以内に終える。
 */
import { describe, expect, it } from 'vitest';
import { AUTHENTICATED_STATE_SAME_SITE_VALUES } from '../../src/core/authenticated-storage-state.js';
import {
  LOCAL_UI_SOURCE_DIRECTORY,
  MAX_GATE_MS,
  findModuleSpecifiers,
  readTypeScriptFilesUnder,
  scanSource,
  startCpuStopwatch,
  unusedExclusionsOf,
  type UnscannedFile,
} from './source-scan.js';

const MAX_MS = MAX_GATE_MS;

const ALL_FILES: readonly UnscannedFile[] = [...readTypeScriptFilesUnder('src'), ...readTypeScriptFilesUnder(LOCAL_UI_SOURCE_DIRECTORY)];

const OWNER = 'src/core/authenticated-storage-state.ts';
const OWNER_SPECIFIER = /(?:^|\/)core\/authenticated-storage-state\.js$/u;

/** (a) owner が定義する形の型。 */
const OWNER_TYPES: readonly string[] = [
  'AuthenticatedStorageCookie',
  'AuthenticatedStorageItem',
  'AuthenticatedIndexedDBDatabase',
  'AuthenticatedStorageOrigin',
  'AuthenticatedStorageState',
];

/** (c) owner を読む元の場所。 */
const USERS: readonly string[] = [
  'src/browser/context-factory.ts',
  'src/control/auth/authenticated-state.ts',
  // PRE42-CC 組 UI-K3（CC-060 の残り）: ログインの資格情報の守りの、引き継ぐ状態の形（`LoginCredentialCarriedState`）も、owner の型から取る（`Pick`）。
  'src/safety/login-credential-guard.ts',
];

/** (b) 形の書き写し（名前と、コメントを除いた本文で探す正規表現）。 */
const COPY_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['cookie shape', /\bhttpOnly\??\s*:\s*boolean\b/gu],
  ['SameSite union', /'(?:Strict|Lax|None)'\s*\|\s*'(?:Strict|Lax|None)'|"(?:Strict|Lax|None)"\s*\|\s*"(?:Strict|Lax|None)"/gu],
  ['IndexedDB database shape', /\bversion\??\s*:\s*number\s*[;,]\s*(?:readonly\s+)?stores\??\s*:/gu],
  // 組 UI-K3: 名前と中身だけの IndexedDB のデータベースの形の直書き（`{ readonly name: string; readonly stores: … }`。`Pick` で owner から取る）。
  ['IndexedDB name and stores shape', /\bname\??\s*:\s*string\s*[;,]\s*(?:readonly\s+)?stores\??\s*:/gu],
  ['localStorage item shape', /\blocalStorage\??\s*:\s*(?:readonly\s*)?(?:\{|Array\s*<\s*\{|ReadonlyArray\s*<\s*\{)/gu],
];

/**
 * (b) の除外（`<ファイル>: <名前>: <書いた形>`。使われない除外は落とす）。
 * - Context の作り手の `playwrightStorageState`: Playwright の `newContext` の `storageState` に渡す、書き換えのできる写しの型（Playwright の型に合わせた
 *   `readonly` のない形で、DEF-139 の `indexedDB` を足す）。Context への渡し方なので、この組では変えない。
 */
const EXCLUDED_COPIES: readonly string[] = [
  'src/browser/context-factory.ts: localStorage item shape: localStorage: {',
];

/** 文字列リテラルだけの配列（コメントを除いた本文）。 */
const STRING_ARRAY_PATTERN = /\[\s*(?:(?:'[^'\n]*'|"[^"\n]*")\s*,\s*)*(?:'[^'\n]*'|"[^"\n]*")\s*,?\s*\]/gu;
const STRING_LITERAL_PATTERN = /'([^'\n]*)'|"([^"\n]*)"/gu;

const sameSet = (left: readonly string[], right: readonly string[]): boolean => {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
};

/** (b) コメントを除いた本文の中の書き写し（`<名前>: <書いた形>`）。 */
const copiesOf = (code: string): readonly string[] => [
  ...COPY_PATTERNS.flatMap(([name, pattern]) => [...code.matchAll(pattern)].map(([found]) => `${name}: ${found.replace(/\s+/gu, ' ')}`)),
  ...[...code.matchAll(STRING_ARRAY_PATTERN)].flatMap(([array]) => {
    const values = [...array.matchAll(STRING_LITERAL_PATTERN)].map((match) => match[1] ?? match[2] ?? '');
    return sameSet(values, AUTHENTICATED_STATE_SAME_SITE_VALUES) ? [`SameSite list: ${array.replace(/\s+/gu, ' ')}`] : [];
  }),
];

const fileOf = (path: string): UnscannedFile | undefined => ALL_FILES.find((file) => file.path === path);

describe('Architecture Gate: the authenticated storage state shape (PRE42-CC group S3, CC-060 B)', () => {
  it('detects the copied shapes and lists, and ignores comments and the names of the owner', () => {
    const detected = copiesOf(scanSource([
      'interface A { readonly httpOnly: boolean; }',
      'type B = { httpOnly?: boolean };',
      "type C = 'Strict' | 'Lax' | 'None';",
      'type D = "None" | "Lax";',
      "const e = Object.freeze(['Lax', 'None', 'Strict']);",
      'const f = ["Strict", "Lax", "None", "Lax"];',
      'interface G {\n  readonly version: number;\n  readonly stores: readonly unknown[];\n}',
      'interface H { readonly localStorage: readonly { readonly name: string }[] }',
      'interface I { localStorage: Array<{ name: string }> }',
      "// type J = 'Strict' | 'Lax'; readonly httpOnly: boolean;",
      "const k = ['Strict', 'Lax'];",
      "const l = ['Strict', 'Lax', 'None', 'Other'];",
      'interface M { readonly localStorage: readonly AuthenticatedStorageItem[]; readonly httpOnlyCount: number; }',
      'interface N { readonly name: string; readonly stores: readonly unknown[] }',
    ].join('\n')).code);
    expect(detected).toEqual([
      'cookie shape: httpOnly: boolean',
      'cookie shape: httpOnly?: boolean',
      "SameSite union: 'Strict' | 'Lax'",
      'SameSite union: "None" | "Lax"',
      'IndexedDB database shape: version: number; readonly stores:',
      // 組 UI-K3: 名前と中身だけの形（`interface N`）も、書き写しとして数える（ログインの資格情報の守りの前の形）。
      'IndexedDB name and stores shape: name: string; readonly stores:',
      'localStorage item shape: localStorage: readonly {',
      'localStorage item shape: localStorage: Array<{',
      "SameSite list: ['Lax', 'None', 'Strict']",
      'SameSite list: ["Strict", "Lax", "None", "Lax"]',
    ]);
  });

  it('(a) defines the shape and the SameSite values in a pure core file', () => {
    const owner = fileOf(OWNER);
    expect(owner, OWNER).toBeDefined();
    const code = scanSource(owner?.content ?? '').code;
    expect(findModuleSpecifiers(code), `${OWNER} imports nothing`).toEqual([]);
    expect(code).toMatch(/\bexport\s+const\s+AUTHENTICATED_STATE_SAME_SITE_VALUES\s*=\s*Object\.freeze\(/u);
    expect(Object.isFrozen(AUTHENTICATED_STATE_SAME_SITE_VALUES)).toBe(true);
    expect([...AUTHENTICATED_STATE_SAME_SITE_VALUES]).toEqual(['Strict', 'Lax', 'None']);
    for (const name of OWNER_TYPES) {
      expect(code, name).toMatch(new RegExp(String.raw`\bexport\s+interface\s+${name}\b`, 'u'));
    }
    expect(code).not.toMatch(/\bpartitionKey\b/u);
  });

  it('(b) keeps no copy of the shape or the SameSite values outside the owner', () => {
    const stopwatch = startCpuStopwatch();
    expect(ALL_FILES.length).toBeGreaterThan(0);
    const found = ALL_FILES.filter(({ path }) => path !== OWNER)
      .flatMap(({ path, content }) => copiesOf(scanSource(content).code).map((copy) => `${path}: ${copy}`));
    expect(found.filter((copy) => !EXCLUDED_COPIES.includes(copy))).toEqual([]);
    expect(unusedExclusionsOf(EXCLUDED_COPIES, found), 'unused exclusions').toEqual([]);
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_MS);
  });

  it('(c) the context factory and the authenticated state owner read the owner', () => {
    for (const path of USERS) {
      const code = scanSource(fileOf(path)?.content ?? '').code;
      expect(findModuleSpecifiers(code).some((specifier) => OWNER_SPECIFIER.test(specifier)), `${path} imports ${OWNER}`).toBe(true);
    }
  });
});
