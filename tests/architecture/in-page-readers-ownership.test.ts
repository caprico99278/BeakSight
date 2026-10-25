/**
 * ページの中で読む部品の Gate（CC-068。Task 32 の設計書 4.4 の「CC-068 の設計」の 1。T32j-2）。判定は `fs`、正規表現、文字列の走査だけ
 * （`source-scan.ts` の `loadSourceFiles`・`scanSource` を共用する）。近似の検査である（名前を実行時に組み立てる形は数えない）。
 * - (a) ページの中の関数は、自分で `getOwnPropertyDescriptor` を書かない: `src/**` のコード（コメントを除き、文字列リテラルは残した本文。
 *   `Object['getOwnPropertyDescriptor']` の形と、文字列で組み立てる初期化のスクリプトも数える）に `getOwnPropertyDescriptor` を書くのは、
 *   部品のモジュール（`src/browser/in-page-readers.ts`）と、閉じた除外の一覧（理由つき。ページの中の読み取りでないもの）だけ。使われなく
 *   なった除外も誤りにする。
 * - (b) 部品に置き換えたページの中の関数のファイル（`COMPOSED_FILES`。15 関数・11 ファイル）は、部品のモジュールの `composeInPage` を使う
 *   （置き換えが戻らない）。一覧のファイルがすべてある。
 * - (c) open な shadow root を、ページの中の関数が自分でたどらない（PRE42-CC 組 5b。CC-099 の気づき）: `src/**` のコード（コメントを除き、文字列
 *   リテラルは残した本文）で、`shadowRoot` の getter を名前（`'shadowRoot'`）で取り出すのは、部品のモジュール（`openRoots`・`queryAllInRoots`）と、
 *   閉じた除外の一覧（理由つき。平たい CSS の一覧ではなく、要素ごとに木をたどるもの）だけ。使われなくなった除外も誤りにする。
 * - 1 ファイルを 1 秒以内に終える（読み込みは `loadSourceFiles()` の 1 回だけ）。
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_GATE_MS,
  findCallSites,
  findNamedImports,
  loadSourceFiles,
  resolveRelativeSpecifier,
  scanSource,
  startCpuStopwatch,
  withoutModuleExtension,
  type SourceFile,
} from './source-scan.js';

// 測りは、検査の本体（`src/**` の 1 回の読み込みと判定）の直前に始める（import の読み込みと変換は、この行の前に済む。CPU の時間。TS-d。
// DEF-153: 壁時計では、並行の混雑で毎回上限を越えた）。
const GATE_STOPWATCH = startCpuStopwatch();
const SOURCE_FILES: readonly SourceFile[] = loadSourceFiles();
// このファイルの判定の上限（ms）は、`source-scan.ts` の `MAX_GATE_MS`（PRE42-CC 組 G）。

/** 部品のモジュール（`getOwnPropertyDescriptor` を書く唯一のページの中の部品）。 */
const IN_PAGE_READERS_FILE = 'src/browser/in-page-readers.ts';
/** 組み立ての関数の名前。 */
const COMPOSE_FUNCTION_NAME = 'composeInPage';

/** (a) の除外（閉じた一覧。ページの中の関数の読み取りでないもの）。 */
const NON_READER_DESCRIPTOR_USES: Readonly<Record<string, string>> = Object.freeze({
  // Node の側（Playwright が返した応答のヘッダの object の、自身のプロパティを確かめる）。ページの中で動かない。
  'src/evidence/performance-collector.ts': 'Node-side header projection',
  // Context の初期化のスクリプト（文字列）。読み取りではなく、Service Worker の登録の入口を塞ぐために `Navigator.prototype` の記述子を
  // 書き直す（Guard の owner。部品の関数を組み込めない、文書の始まりで動く文字列）。
  'src/safety/passive-request-guard.ts': 'Service Worker registration block init script',
});

/** (b) 部品に置き換えたページの中の関数のファイル（関数の名前は `src/browser/in-page-readers.ts` の冒頭と報告の一覧）。 */
const COMPOSED_FILES: readonly string[] = [
  'src/browser/controlled-scroll.ts',
  'src/browser/login-form-submitter.ts',
  'src/browser/page-settling.ts',
  'src/browser/write-form-submitter.ts',
  'src/crawl/discover-links.ts',
  'src/discovery/probe.ts',
  'src/discovery/read-executor.ts',
  'src/evidence/color-collector.ts',
  'src/evidence/dom-collector.ts',
  'src/evidence/layout-collector.ts',
  'src/interaction/discover-candidates.ts',
];

/**
 * (c) の除外（閉じた一覧。`shadowRoot` の getter を自分で取り出して、要素ごとに木をたどるもの）。CSS で平たく集めるもの（link の取り出しなど）は、
 * 部品の `openRoots`・`queryAllInRoots` を使う。
 */
const OWN_SHADOW_ROOT_WALKERS: Readonly<Record<string, string>> = Object.freeze({
  // スクロールの容器を、shadow root の中の子を light DOM の子より先に、深さ優先でたどる（要素ごとの高さを読み、上限の数に含める）。
  'src/browser/controlled-scroll.ts': 'depth-first scroll container walk (shadow children before light children)',
  // form と候補のボタンの読み取り（要素の位置と、shadow root の host への移りを、要素ごとに見る）。
  'src/discovery/probe.ts': 'per-element candidate probe walk with the shadow host chain',
  // DOM の Evidence の木（子の node・slot の割り当てを、要素ごとに写す）。
  'src/evidence/dom-collector.ts': 'DOM Evidence tree with slots',
});

/** (c) link の取り出し（getter がないときは shadow root を飛ばす根の取り出しを使う）。 */
const LINK_EXTRACTION_FILE = 'src/crawl/discover-links.ts';

/** (c) `shadowRoot` の getter を名前で取り出す文字列（`'shadowRoot'`。`code` に当てる）を書いた行（`<path>:<行> <行の本文>`）。 */
const SHADOW_ROOT_GETTER_NAME = /(['"`])shadowRoot\1/u;
const shadowRootGetterLines = (file: Pick<SourceFile, 'path' | 'code'>): readonly string[] =>
  file.code.split('\n').flatMap((line, index) => (SHADOW_ROOT_GETTER_NAME.test(line) ? [`${file.path}:${String(index + 1)} ${line.trim()}`] : []));

/** `getOwnPropertyDescriptor`（複数形を含む）を書いた行（`<path>:<行> <行の本文>`）。 */
const DESCRIPTOR_TEXT = /getOwnPropertyDescriptor/u;
const descriptorLines = (file: Pick<SourceFile, 'path' | 'code'>): readonly string[] =>
  file.code.split('\n').flatMap((line, index) => (DESCRIPTOR_TEXT.test(line) ? [`${file.path}:${String(index + 1)} ${line.trim()}`] : []));

/** `composeInPage` を部品のモジュールから import しているか。 */
const importsCompose = (file: Pick<SourceFile, 'path' | 'code'>): boolean =>
  findNamedImports(file.code).some(({ specifier, names }) => (
    names.includes(COMPOSE_FUNCTION_NAME)
    && withoutModuleExtension(resolveRelativeSpecifier(file.path, specifier) ?? '') === withoutModuleExtension(IN_PAGE_READERS_FILE)
  ));

describe('Gate: only the in-page readers module reads property descriptors (CC-068)', () => {
  it('(a) writes getOwnPropertyDescriptor only in the in-page readers module and the closed list of non-reader uses', () => {
    const found = SOURCE_FILES.filter(({ path }) => path !== IN_PAGE_READERS_FILE).flatMap(descriptorLines);
    const pathOf = (line: string): string => line.slice(0, line.indexOf(':'));
    expect(found.filter((line) => NON_READER_DESCRIPTOR_USES[pathOf(line)] === undefined)).toEqual([]);
    // 使われなくなった除外を残さない。
    expect(Object.keys(NON_READER_DESCRIPTOR_USES).filter((path) => !found.some((line) => pathOf(line) === path))).toEqual([]);
    // 部品のモジュールは、標準の getter を取り出す（持ち主がある）。
    const owner = SOURCE_FILES.find(({ path }) => path === IN_PAGE_READERS_FILE);
    expect(owner === undefined ? [] : descriptorLines(owner)).not.toEqual([]);
  });

  it('(b) the replaced in-page function files use composeInPage from the in-page readers module', () => {
    const byPath = new Map(SOURCE_FILES.map((file) => [file.path, file] as const));
    expect(COMPOSED_FILES.filter((path) => !byPath.has(path))).toEqual([]);
    expect(COMPOSED_FILES.filter((path) => {
      const file = byPath.get(path);
      return file === undefined || !importsCompose(file);
    })).toEqual([]);
  });

  it('(c) reads the shadowRoot getter only in the in-page readers module and the closed list of own tree walkers', () => {
    const found = SOURCE_FILES.filter(({ path }) => path !== IN_PAGE_READERS_FILE).flatMap(shadowRootGetterLines);
    const pathOf = (line: string): string => line.slice(0, line.indexOf(':'));
    expect(found.filter((line) => OWN_SHADOW_ROOT_WALKERS[pathOf(line)] === undefined)).toEqual([]);
    // 使われなくなった除外を残さない。
    expect(Object.keys(OWN_SHADOW_ROOT_WALKERS).filter((path) => !found.some((line) => pathOf(line) === path))).toEqual([]);
    // 部品のモジュールは、shadow root をたどる（持ち主がある）。
    const owner = SOURCE_FILES.find(({ path }) => path === IN_PAGE_READERS_FILE);
    expect(owner === undefined ? [] : shadowRootGetterLines(owner)).not.toEqual([]);
    // link の取り出しは、getter がなければ shadow root を飛ばす根の取り出し（`optionalOpenRoots`）を使う（例外にして発見を止めない）。
    const links = SOURCE_FILES.find(({ path }) => path === LINK_EXTRACTION_FILE);
    expect(links === undefined ? [] : findCallSites(links.bare, 'optionalOpenRoots')).not.toEqual([]);
    expect(links === undefined ? [] : findCallSites(links.bare, 'openRoots')).toEqual([]);
  });

  it('(c) finds the own shadow root walk of the link extraction before PRE42-CC, and does not count comments (the control)', () => {
    const linesOf = (source: string): readonly string[] => shadowRootGetterLines({ path: 'src/crawl/discover-links.ts', ...scanSource(source) });
    for (const source of [
      // PRE42-CC の前の `discover-links.ts` の `extractAnchorsReader` の形。
      "const shadowRootGetterOf = R.optionalStandardGetter<ShadowRoot | null>(Element.prototype, 'shadowRoot');",
      'const shadowRootOf = standardGetter<ShadowRoot | null>(Element.prototype, "shadowRoot");',
      'const shadowRootOf = getterOf(Element.prototype, `shadowRoot`);',
    ]) {
      expect(linesOf(source), source).toHaveLength(1);
    }
    for (const source of [
      "// R.optionalStandardGetter(Element.prototype, 'shadowRoot')",
      'const roots = R.openRoots();',
      "const label = 'shadowRootOf';",
    ]) {
      expect(linesOf(source), source).toEqual([]);
    }
  });

  it('finds the shapes placed on purpose, and does not count comments (the control)', () => {
    const linesOf = (source: string): readonly string[] => descriptorLines({ path: 'src/control.ts', ...scanSource(source) });
    for (const source of [
      'const getter = Object.getOwnPropertyDescriptor(Element.prototype, name)?.get;',
      "const read = Object['getOwnPropertyDescriptor'](prototype, name);",
      'const all = Object.getOwnPropertyDescriptors(prototype);',
      'const viaReflect = Reflect.getOwnPropertyDescriptor(prototype, name);',
      'const script = `(() => Object.getOwnPropertyDescriptor(Navigator.prototype, "x"))()`;',
    ]) {
      expect(linesOf(source), source).toHaveLength(1);
    }
    for (const source of ['// Object.getOwnPropertyDescriptor(prototype, name)', '/* getOwnPropertyDescriptor */ const x = 1;']) {
      expect(linesOf(source), source).toEqual([]);
    }
    const imports = (source: string): boolean => importsCompose({ path: 'src/evidence/example.ts', ...scanSource(source) });
    expect(imports("import { composeInPage } from '../browser/in-page-readers.js';")).toBe(true);
    expect(imports("import { composeInPage, type StandardReaders } from '../browser/in-page-readers.js';")).toBe(true);
    expect(imports("import { composeInPage } from './in-page-readers.js';")).toBe(false);
    expect(imports("import { other } from '../browser/in-page-readers.js';")).toBe(false);
  });

  it('finishes the gate within the time limit', () => {
    expect(GATE_STOPWATCH.elapsedMs()).toBeLessThan(MAX_GATE_MS);
  });
});
