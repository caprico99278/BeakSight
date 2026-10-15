/**
 * Architecture Gate の、モジュールの参照の取り出しと import のたどりの共通の部品（`source-scan.ts`）の検査（CCX-9。台帳の CC-054、CC-056）。
 * - 取り出し（`findModuleReferences`）: 静的な import と `export … from`、副作用の import、動的 import、`require`・`require.resolve`、
 *   `createRequire(…)(…)` と `createRequire(…)` を入れた変数の呼び出し、テンプレートの指定子（最初の `${` の前まで）、`getBuiltinModule`、
 *   `new URL(…, import.meta.url)`。型だけの import と、モジュールの全体を受け取る形を、印で分ける。
 * - たどり（`findImportChains`、`reachableFiles`）: 相対の指定子の解決、拡張子の補い、たどる範囲（`files` の中だけ）、循環で止まること。
 * - Gate の規則: 指定子を取り出す正規表現（`import\s`・`require\(` の形）を、`source-scan.ts` の外の Gate のファイルに書かない。
 * - ファイル全体を 1 秒以内に終える。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PLAYWRIGHT_PACKAGE_PATTERN,
  REPOSITORY_ROOT,
  findImportChains,
  findImportSpecifiers,
  findImportStatementRanges,
  findModuleReferences,
  findModuleSpecifiers,
  findNamedImports,
  findSpecifierRegexShapes,
  findRuntimeModuleSpecifiers,
  findTransitiveForbiddenReferences,
  importTargetCandidates,
  isRelativePathText,
  matchingParenthesis,
  moduleReferenceCandidatesOf,
  reachableFiles,
  resolveImportTarget,
  resolveRelativeSpecifier,
  scanSource,
  withoutModuleExtension,
  type ScannedSource,
} from './source-scan.js';

const ARCHITECTURE_DIRECTORY = 'tests/architecture/';
/** このファイル（共用の補助の書き直しの検査の、対照の文字列を含む）。 */
const THIS_FILE_PATH = 'tests/architecture/module-references.test.ts';

const codeOf = (text: string): string => scanSource(text).code;
const sourcesOf = (entries: readonly (readonly [string, string])[]): ReadonlyMap<string, ScannedSource> =>
  new Map(entries.map(([path, text]) => [path, scanSource(text)]));

// ---------------------------------------------------------------------------------------------------------------
// 取り出し
// ---------------------------------------------------------------------------------------------------------------

describe('module references (CCX-9)', () => {
  it('extracts every form of module reference, in source order', () => {
    const code = codeOf([
      "import { a } from './a.js';",
      "import type { T } from './t.js';",
      "import { type U } from './u.js';",
      "import * as all from './all.js';",
      "export { b } from './b.js';",
      "export * from './star.js';",
      "export * as named from './named-star.js';",
      "export type { V } from './v.js';",
      "import './side-effect.js';",
      "const c = await import('./c.js');",
      'const d = await import(`./d/${name}.js`);',
      "const e = require('./e.js');",
      "const f = require.resolve('./f.js');",
      'const g = require(`./g/${name}`);',
      "const h = createRequire(import.meta.url)('./h.js');",
      "const i = createRequire(new URL(import.meta.url)).resolve('./i.js');",
      'const load = module.createRequire(import.meta.url);',
      "const j = load('./j.js');",
      "const k = load.resolve('./k.js');",
      "const fs = process.getBuiltinModule('node:fs');",
      "const url = new URL('../../package.json', import.meta.url);",
      'const schema = new URL(`${directory}${name}.json`, import.meta.url);',
      "// import { x } from './comment.js';",
    ].join('\n'));
    expect(findModuleReferences(code).map(({ form, specifier, typeOnly, wholeModule, template }) =>
      [form, specifier, typeOnly, wholeModule, template] as const)).toEqual([
      ['static', './a.js', false, false, false],
      ['static', './t.js', true, false, false],
      ['static', './u.js', false, false, false],
      ['static', './all.js', false, true, false],
      ['static', './b.js', false, false, false],
      ['static', './star.js', false, true, false],
      ['static', './named-star.js', false, true, false],
      ['static', './v.js', true, false, false],
      ['side-effect', './side-effect.js', false, false, false],
      ['dynamic-import', './c.js', false, true, false],
      ['dynamic-import', './d/', false, true, true],
      ['require', './e.js', false, true, false],
      ['require', './f.js', false, false, false],
      ['require', './g/', false, true, true],
      ['create-require', './h.js', false, true, false],
      ['create-require', './i.js', false, false, false],
      ['create-require', './j.js', false, true, false],
      ['create-require', './k.js', false, false, false],
      ['builtin-module', 'node:fs', false, true, false],
      ['file-url', '../../package.json', false, false, false],
      ['file-url', '', false, false, true],
    ]);
  });

  it('keeps the written text of the whole-module forms (for the reports of GATE-ARCH08)', () => {
    const code = codeOf([
      "import * as validators from '../core/schema-validator.js';",
      "export * as v from '../core/schema-validator';",
      "const m = await import('../core/schema-validator.js');",
      "const r = require('./schema-validator.js');",
    ].join('\n'));
    expect(findModuleReferences(code).filter((reference) => reference.wholeModule).map((reference) => reference.text)).toEqual([
      "import * as validators from '../core/schema-validator.js'",
      "export * as v from '../core/schema-validator'",
      "import('../core/schema-validator.js'",
      "require('./schema-validator.js'",
    ]);
  });

  it('also extracts calls with more arguments or a concatenated specifier (the widest form of the former gates)', () => {
    const code = codeOf([
      "const a = await import('./a.js', { with: { type: 'json' } });",
      "const b = require('./b' + suffix);",
      "const c = process.getBuiltinModule('node:sqlite', extra);",
    ].join('\n'));
    expect(findModuleSpecifiers(code)).toEqual(['./a.js', './b', 'node:sqlite']);
  });

  it('does not extract look-alikes', () => {
    const code = codeOf([
      "const label = 'import';",
      'const value = obj.require;',
      "const other = myrequire('./x.js');",
      "const item = Array.from(list);",
      "const parsed = new URL('https://example.test/', base);",
      "/* const y = require('./y.js'); */",
    ].join('\n'));
    expect(findModuleReferences(code)).toEqual([]);
  });

  it('gives the runtime specifiers without the type-only imports and exports', () => {
    const code = codeOf([
      "import { a } from './x.js';",
      "import type { T } from './x.js';",
      "import type * as NS from './ns.js';",
      "export type { U } from './u.js';",
      "import { type V } from './v.js';",
      "type Lazy = import('./lazy.js').Lazy;",
    ].join('\n'));
    expect(findModuleSpecifiers(code)).toEqual(['./x.js', './x.js', './ns.js', './u.js', './v.js', './lazy.js']);
    expect(findRuntimeModuleSpecifiers(code)).toEqual(['./x.js', './v.js', './lazy.js']);
  });

  it('keeps findImportSpecifiers to the import and export statements and import()', () => {
    const code = codeOf([
      "import { a } from './a.js';",
      "import './b.js';",
      "const c = await import('./c.js');",
      'const d = await import(`./d/${x}`);',
      "const e = require('./e.js');",
      "const f = process.getBuiltinModule('node:fs');",
    ].join('\n'));
    expect(findImportSpecifiers(code)).toEqual(['./a.js', './b.js', './c.js']);
  });

  it('extracts the named import lists and the import statement ranges', () => {
    const scanned = scanSource([
      "import { a, type B, c as d } from '../safety/request-policy.js';",
      "import type { E } from './e.js';",
      "import Default, { f } from './f.js';",
      "import { g } from './g.js';",
    ].join('\n'));
    expect(findNamedImports(scanned.code)).toEqual([
      { specifier: '../safety/request-policy.js', names: ['a', 'B', 'c as d'] },
      { specifier: './g.js', names: ['g'] },
    ]);
    expect(findImportStatementRanges(scanned.bare).map(([start, end]) => scanned.bare.slice(start, end))).toEqual([
      "import { a, type B, c as d } from ''",
      "import type { E } from ''",
      "import Default, { f } from ''",
      "import { g } from ''",
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// たどり
// ---------------------------------------------------------------------------------------------------------------

describe('import traversal (CCX-9)', () => {
  it('resolves relative specifiers and completes the extensions', () => {
    expect(resolveRelativeSpecifier('src/control/a.ts', '../core/b.js')).toBe('src/core/b.js');
    expect(resolveRelativeSpecifier('src/control/a.ts', './store/../c')).toBe('src/control/c');
    expect(resolveRelativeSpecifier('src/control/a.ts', '..')).toBe('src');
    expect(resolveRelativeSpecifier('src/control/a.ts', 'node:fs')).toBeNull();
    expect(resolveRelativeSpecifier('src/control/a.ts', 'beaksight/src/control/a.js')).toBeNull();
    expect(withoutModuleExtension('src/core/b.mjs')).toBe('src/core/b');
    expect(importTargetCandidates('src/core/b.js')).toEqual([
      'src/core/b.js', 'src/core/b.ts', 'src/core/b.tsx', 'src/core/b/index.ts', 'src/core/b/index.tsx',
    ]);
    const files = sourcesOf([['src/core/b.ts', ''], ['src/view/v.tsx', ''], ['src/dir/index.ts', ''], ['src/core/m.ts', '']]);
    expect(resolveImportTarget(files, 'src/control/a.ts', '../core/b.js')).toBe('src/core/b.ts');
    expect(resolveImportTarget(files, 'src/control/a.ts', '../view/v')).toBe('src/view/v.tsx');
    expect(resolveImportTarget(files, 'src/control/a.ts', '../dir')).toBe('src/dir/index.ts');
    expect(resolveImportTarget(files, 'src/control/a.ts', '../core/m.mjs')).toBe('src/core/m.ts');
    expect(resolveImportTarget(files, 'src/control/a.ts', '../core/missing.js')).toBeUndefined();
    expect(resolveImportTarget(files, 'src/control/a.ts', 'playwright')).toBeUndefined();
  });

  it('follows the runtime imports breadth first, stops at a violation, skips type-only imports and ends on cycles', () => {
    const files = sourcesOf([
      ['src/a.ts', "import { b } from './b.js';\nimport type { T } from './t.js';\nimport { c } from './c.js';"],
      ['src/b.ts', "import { a } from './a.js';\nimport { d } from './d.js';"],
      ['src/c.ts', "const lazy = await import('./forbidden/x.js');\nimport { chromium } from 'playwright';"],
      ['src/d.ts', "import { b } from './b.js';"],
      ['src/t.ts', "import { x } from './forbidden/t.js';"],
      ['src/forbidden/x.ts', "import { y } from '../y.js';"],
      ['src/y.ts', ''],
    ]);
    const violations = findImportChains(files, ['src/a.ts'], ({ specifier, resolved }) => {
      if (specifier === 'playwright') {
        return specifier;
      }
      return resolved !== null && resolved.startsWith('src/forbidden/') ? resolved : undefined;
    });
    expect(violations).toEqual(['src/a.ts -> src/c.ts -> src/forbidden/x.js', 'src/a.ts -> src/c.ts -> playwright']);
    // 止めなければ、違反の先までたどる。型だけの import の先（`t.ts`）と、`files` にないファイルはたどらない。
    expect(reachableFiles(files, 'src/a.ts')).toEqual(['src/b.ts', 'src/c.ts', 'src/d.ts', 'src/forbidden/x.ts', 'src/y.ts']);
    expect(reachableFiles(files, 'src/missing.ts')).toEqual([]);
  });

  it('gives each step the chain, the specifier, the resolved path and the target in the files', () => {
    const files = sourcesOf([
      ['apps/ui/src/a.tsx', "import { b } from '../../../src/core/b.js';\nimport { readFile } from 'node:fs/promises';"],
      ['src/core/b.ts', "import { m } from './missing.js';"],
    ]);
    const steps: string[] = [];
    findImportChains(files, ['apps/ui/src/a.tsx'], ({ chain, specifier, resolved, target }) => {
      steps.push(`${chain.join(' > ')} | ${specifier} | ${resolved ?? '-'} | ${target ?? '-'}`);
      return undefined;
    });
    expect(steps).toEqual([
      'apps/ui/src/a.tsx | ../../../src/core/b.js | src/core/b.js | src/core/b.ts',
      'apps/ui/src/a.tsx | node:fs/promises | - | -',
      'apps/ui/src/a.tsx > src/core/b.ts | ./missing.js | src/core/missing.js | -',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Gate が共用する補助（CCX-27。台帳の CC-074、CC-082 の後半、CC-088）
// ---------------------------------------------------------------------------------------------------------------

describe('gate helpers shared by the boundary gates (CCX-27)', () => {
  it('tells a relative path text, and resolves only relative specifiers', () => {
    expect(['./a.js', '../a.js', '../../src/x'].map(isRelativePathText)).toEqual([true, true, true]);
    expect(['.', '..', 'a/./b', '.hidden', 'playwright', 'node:fs', '/abs'].map(isRelativePathText)).toEqual([false, false, false, false, false, false, false]);
    expect(resolveRelativeSpecifier('src/a/b.ts', '.')).toBe('src/a');
    expect(resolveRelativeSpecifier('src/a/b.ts', '..')).toBe('src');
    expect(resolveRelativeSpecifier('src/a/b.ts', '.hidden')).toBeNull();
  });

  it('lists the reference candidates: the specifiers first, then the relative and the extra literals in order, without duplicates', () => {
    const source = scanSource([
      "import { a } from './a.js';",
      "const b = require('../b.js');",
      "const path = './a.js';",
      "const other = '../c/d.ts';",
      "const name = 'playwright-core';",
      "const text = 'not/relative';",
      "// const hidden = './comment.js';",
    ].join('\n'));
    expect(moduleReferenceCandidatesOf(source)).toEqual(['./a.js', '../b.js', '../c/d.ts']);
    expect(moduleReferenceCandidatesOf(source, [PLAYWRIGHT_PACKAGE_PATTERN])).toEqual(['./a.js', '../b.js', '../c/d.ts', 'playwright-core']);
    expect(['playwright', 'playwright-core/lib', '@playwright/test', '@axe-core/playwright', 'playwrights', '@playwright'].map((name) =>
      PLAYWRIGHT_PACKAGE_PATTERN.test(name))).toEqual([true, true, true, true, false, false]);
  });

  it('follows the runtime imports to a forbidden package or a forbidden file (with the .ts reading and the target)', () => {
    const files = sourcesOf([
      ['src/a.ts', "import { b } from './b.js';\nimport { chromium } from 'playwright';\nimport type { T } from './forbidden/t.js';"],
      ['src/b.ts', "import { c } from './forbidden/c.js';\nimport { d } from './d.js';"],
      ['src/d.ts', "import { e } from './e';"],
      ['src/e/index.ts', ''],
      ['src/forbidden/c.ts', ''],
    ]);
    const isForbiddenPath = (path: string): boolean => path.startsWith('src/forbidden/') || path === 'src/e/index.ts';
    expect(findTransitiveForbiddenReferences(files, ['src/a.ts'], isForbiddenPath, (specifier) => PLAYWRIGHT_PACKAGE_PATTERN.test(specifier)))
      .toEqual(['src/a.ts -> playwright', 'src/a.ts -> src/b.ts -> src/forbidden/c.ts', 'src/a.ts -> src/b.ts -> src/d.ts -> src/e/index.ts']);
    expect(findTransitiveForbiddenReferences(files, ['src/d.ts'], () => false, () => false)).toEqual([]);
  });

  it('gives a static reference its statement, its default binding and its named bindings', () => {
    const shapes = findModuleReferences(codeOf([
      "import http, { request, type Agent as A } from 'node:http';",
      "import type Net from 'node:net';",
      "export { connect } from 'node:tls';",
      "import * as dgram from 'node:dgram';",
      "const m = require('node:https');",
    ].join('\n'))).map(({ form, statement, defaultBinding, namedBindings }) => [form, statement, defaultBinding, namedBindings]);
    expect(shapes).toEqual([
      ['static', { keyword: 'import', clause: 'http, { request, type Agent as A }' }, 'http', ['request', 'Agent as A']],
      ['static', { keyword: 'import', clause: 'Net' }, 'Net', []],
      ['static', { keyword: 'export', clause: '{ connect }' }, null, ['connect']],
      ['static', { keyword: 'import', clause: '* as dgram' }, null, []],
      ['require', null, null, []],
    ]);
  });

  it('finds the matching parenthesis in the bare text', () => {
    const bare = 'f(a, g(b), (c)) + h(';
    expect(matchingParenthesis(bare, bare.indexOf('('))).toBe(bare.indexOf(') +'));
    expect(matchingParenthesis(bare, bare.indexOf('g(') + 1)).toBe(bare.indexOf('b)') + 1);
    expect(matchingParenthesis(bare, bare.lastIndexOf('('))).toBe(-1);
  });

  // 共用の補助を、ほかの Gate のファイルに書き直さない（相対パスの判定の書き方と、Playwright のパッケージの名前の正規表現）。
  it('no gate file but source-scan.ts writes the relative path test or the Playwright package pattern again', () => {
    const relativeTest = new RegExp(String.raw`\.startsWith\(\s*(['"])\.\.?/\1\s*\)`, 'u');
    const playwrightPattern = new RegExp(['playwright', 'playwright-core'].join(String.raw`\|`), 'u');
    const paths = readdirSync(join(REPOSITORY_ROOT, ARCHITECTURE_DIRECTORY), { encoding: 'utf8' })
      .filter((name) => name.endsWith('.ts'))
      .map((name) => `${ARCHITECTURE_DIRECTORY}${name}`)
      .filter((path) => path !== SOURCE_SCAN_PATH && path !== THIS_FILE_PATH);
    const copies = paths.flatMap((path) => {
      const { code } = scanSource(readFileSync(join(REPOSITORY_ROOT, path), 'utf8'));
      return [
        ...(relativeTest.test(code) ? [`${path}: startsWith('./')`] : []),
        ...(playwrightPattern.test(code) ? [`${path}: playwright|playwright-core`] : []),
      ];
    });
    expect(copies).toEqual([]);
    // 形が、共通の部品の中の実際の書き方を見つけられることの確かめ。
    const { code } = scanSource(readFileSync(join(REPOSITORY_ROOT, SOURCE_SCAN_PATH), 'utf8'));
    expect(playwrightPattern.test(code)).toBe(true);
    expect(relativeTest.test("if (literal.startsWith('./') || literal.startsWith(\"../\")) {}")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Gate の規則: 指定子を取り出す正規表現は `source-scan.ts` の中だけ
// ---------------------------------------------------------------------------------------------------------------

const SOURCE_SCAN_PATH = 'tests/architecture/source-scan.ts';

/** 違反の例を、このファイル自身に違反の形が現れないように、2 つに分けて書く。 */
const joined = (...parts: readonly string[]): string => parts.join('');

describe('Gate rule: the specifier regular expressions live only in source-scan.ts (CCX-9)', () => {
  it('detects the specifier regular expressions, and ignores examples, comments and other expressions', () => {
    for (const line of [
      joined('const P = /(?<![\\w$.])req', 'uire(?:\\s*\\.\\s*resolve)?\\s*\\(\\s*([\'"])/gu;'),
      joined('const P = /\\bimp', 'ort\\s*\\(\\s*`([^`$]*)/gu;'),
      joined('const P = /\\b(?:imp', 'ort|export)\\s+type\\s+[^;]*?\\bfr', 'om\\s*([\'"])/gu;'),
      joined('const P = /\\bfr', 'om\\s*([\'"])([^\'"\\r\\n]+)\\1/gu;'),
      joined('const P = /(?<![\\w$])createReq', 'uire\\s*\\(/gu;'),
      joined('const P = /\\bimp', 'ort\\s*\\{([^}]*)\\}/gu;'),
      joined('const P = new RegExp(\'\\\\bimp', 'ort\\\\s*\\\\(\', \'gu\');'),
    ]) {
      expect(findSpecifierRegexShapes(scanSource(line)), line).not.toHaveLength(0);
    }
    for (const line of [
      "const example = \"import { a } from './a.js';\";",
      "const example = \"const e = require('./e.js');\";",
      joined('// const P = /\\bimp', 'ort\\s*\\(/gu;'),
      'const P = /^\\s*from\\b/u;',
      'const P = /\\bgetBuiltinModule\\s*\\(/gu;',
      "const items = Array.from(list);",
      'const P = /(?:^|\\/)schema-validator(?:\\.[cm]?[jt]s)?$/u;',
    ]) {
      expect(findSpecifierRegexShapes(scanSource(line)), line).toEqual([]);
    }
  });

  it('no gate file in tests/architecture/ but source-scan.ts writes a specifier regular expression', () => {
    const paths = readdirSync(join(REPOSITORY_ROOT, ARCHITECTURE_DIRECTORY), { encoding: 'utf8' })
      .filter((name) => name.endsWith('.ts'))
      .map((name) => `${ARCHITECTURE_DIRECTORY}${name}`)
      .sort();
    expect(paths).toEqual(expect.arrayContaining([SOURCE_SCAN_PATH, 'tests/architecture/control-boundary.test.ts']));
    // 規則の形が、共通の部品の中の実際の正規表現を見つけられることの確かめ。
    expect(findSpecifierRegexShapes(scanSource(readFileSync(join(REPOSITORY_ROOT, SOURCE_SCAN_PATH), 'utf8')))).not.toEqual([]);
    const violations = paths
      .filter((path) => path !== SOURCE_SCAN_PATH)
      .flatMap((path) => findSpecifierRegexShapes(scanSource(readFileSync(join(REPOSITORY_ROOT, path), 'utf8'))).map((shape) => `${path}: ${shape}`));
    expect(violations).toEqual([]);
  });
});
