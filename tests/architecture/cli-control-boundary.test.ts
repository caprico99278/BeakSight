/**
 * 監査の CLI と管理データの境界の Architecture Gate（Task 23 の設計書 4.5「今の CLI の監査のコマンドは、この確かめも `node:sqlite` も
 * 読み込まない」、7 章「環境の確かめ」。T23d）。
 * - (i) `src/cli/` のファイルが、`src/control/store/` と `src/control/environment/` を、直接にも、実行時の import をたどった先にも
 *   参照しない。`node:sqlite` にも届かない（型だけの import はたどらない。実行時に消えるため）。
 * - `control-boundary.test.ts` の (a)（`src/control/` の外は `src/control/` を import しない）が、直接の参照を広く止めている。この Gate は、
 *   監査の CLI の入口から実際にたどって、管理データの部品と `node:sqlite` に届かないことを、別に確かめる（(a) の例外が将来できても守る）。
 * - 判定は、`fs`、正規表現、文字列の走査だけで行う（`source-scan.ts` の走査を共用する。AST・子 process を使わない）。近似の検査である。
 * - CCX-9（台帳の CC-054、CC-056）: 指定子の取り出し（`findModuleSpecifiers`）、import のたどり（`findImportChains`・`reachableFiles`）、
 *   相対の指定子の解決（`resolveRelativeSpecifier`）は、`source-scan.ts` の共通の部品を使う（指定子を取り出す正規表現は、このファイルに書かない）。
 */
import { describe, expect, it } from 'vitest';
import {
  findTransitiveForbiddenReferences,
  isPathUnderAny,
  loadSourceFiles,
  modulePattern,
  pathReferenceCandidatesOf,
  reachableFiles,
  refersUnderAny,
  scanSource,
  type ScannedSource,
} from './source-scan.js';

const CLI_DIRECTORY = 'src/cli/';
/** (i): 監査の CLI から届いてはならないフォルダ。 */
const FORBIDDEN_DIRECTORIES: readonly string[] = ['src/control/store/', 'src/control/environment/'];
/** `node:sqlite`（`source-scan.ts` の `modulePattern`。`node:` のない形、下位のパス、文字列の中の `node:sqlite` も当てる。PRE42-CC 組 G）。 */
const NODE_SQLITE_PATTERN = modulePattern(['sqlite']);

// ---------------------------------------------------------------------------------------------------------------
// 検出の関数（近似）
// ---------------------------------------------------------------------------------------------------------------

/** 指定子のすべて（型だけの import を含む）と、相対パス・`src/` のパス・`node:sqlite` の文字列リテラル。 */
const referencesOf = (source: ScannedSource): readonly string[] => pathReferenceCandidatesOf(source, [NODE_SQLITE_PATTERN]);

const isForbidden = (path: string): boolean => isPathUnderAny(path, FORBIDDEN_DIRECTORIES);

/** (i) 直接: 禁止のフォルダ（相対でない参照は、文字列の中の `src/` からのパス）か `node:sqlite` を指す参照。 */
const findDirectReferences = (path: string, source: ScannedSource): readonly string[] =>
  referencesOf(source).filter((text) => NODE_SQLITE_PATTERN.test(text) || refersUnderAny(path, text, FORBIDDEN_DIRECTORIES));

/**
 * (i) 間接: 実行時の相対の import を、`source-scan.ts` の `findImportChains`（CCX-9）でたどり、禁止のフォルダ（`.js` などは `.ts` に
 * 読み替えたパス。たどった先のファイルが禁止のフォルダでも同じ）か `node:sqlite` に届いたら `<始まり> -> … -> <先>`。
 */
const findTransitiveReferences = (files: ReadonlyMap<string, ScannedSource>, starts: readonly string[]): readonly string[] =>
  // `node:sqlite` は相対でないので、相対でない指定子の判定に渡す（CCX-27）。
  findTransitiveForbiddenReferences(files, starts, isForbidden, (specifier) => NODE_SQLITE_PATTERN.test(specifier));

// ---------------------------------------------------------------------------------------------------------------
// 検出の関数の単体テスト
// ---------------------------------------------------------------------------------------------------------------

describe('CLI and control store boundary detectors', () => {
  it('(i) detects direct references to the control store, the environment check and node:sqlite', () => {
    const path = 'src/cli/main.ts';
    for (const line of [
      "import { openControlDatabase } from '../control/store/control-database.js';",
      "import type { ControlDatabase } from '../control/store/control-database.js';",
      "import { checkControlEnvironment } from '../control/environment/control-environment.js';",
      "const m = await import('../control/store/sqlite-module.js');",
      'const m = await import(`../control/store/${name}.js`);',
      "import { DatabaseSync } from 'node:sqlite';",
      "const sqlite = process.getBuiltinModule('node:sqlite');",
      "const directory = '../control/environment/';",
      // PRE42-CC 組 G（新 Gate の 2）: 相対でない `src/` のパスと、`node:` のない `sqlite`、下位のパスも見る。
      "const entry = 'beaksight/src/control/store/control-database.js';",
      "const sqlite = require('sqlite');",
    ]) {
      expect(findDirectReferences(path, scanSource(line)), line).toHaveLength(1);
    }
    for (const line of [
      "import { runCli } from './main.js';",
      "import { validateConfig } from '../config/validate-config.js';",
      "// import { openControlDatabase } from '../control/store/control-database.js';",
      "const label = 'node:sqlite-like';",
    ]) {
      expect(findDirectReferences(path, scanSource(line)), line).toHaveLength(0);
    }
  });

  it('(i) follows runtime imports transitively, and skips type-only imports', () => {
    const files = new Map<string, ScannedSource>([
      ['src/cli/index.ts', scanSource("import { a } from '../config/a.js';\nimport type { T } from '../control/store/t.js';")],
      ['src/config/a.ts', scanSource("import { b } from '../core/b.js';")],
      ['src/core/b.ts', scanSource("import { c } from '../control/environment/control-environment.js';")],
      ['src/cli/clean.ts', scanSource("import { d } from '../core/d.js';")],
      ['src/core/d.ts', scanSource("import { readFileSync } from 'node:fs';")],
      ['src/cli/sqlite.ts', scanSource("import { e } from '../core/e.js';")],
      ['src/core/e.ts', scanSource("import { DatabaseSync } from 'node:sqlite';")],
    ]);
    expect(findTransitiveReferences(files, ['src/cli/index.ts'])).toEqual([
      'src/cli/index.ts -> src/config/a.ts -> src/core/b.ts -> src/control/environment/control-environment.ts',
    ]);
    expect(findTransitiveReferences(files, ['src/cli/clean.ts'])).toEqual([]);
    expect(findTransitiveReferences(files, ['src/cli/sqlite.ts'])).toEqual(['src/cli/sqlite.ts -> src/core/e.ts -> node:sqlite']);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------------------------------------------

const SOURCE_FILES = loadSourceFiles();
const CLI_FILES = SOURCE_FILES.filter((file) => file.path.startsWith(CLI_DIRECTORY));

describe('CLI and control store boundary (Task 23 design 4.5)', () => {
  it('reads src/cli/ once', () => {
    expect(CLI_FILES.map((file) => file.path)).toEqual(expect.arrayContaining(['src/cli/index.ts', 'src/cli/main.ts']));
  });

  it('(i) src/cli/ never refers to src/control/store/, src/control/environment/ or node:sqlite', () => {
    expect(CLI_FILES.flatMap((file) => findDirectReferences(file.path, file).map((text) => `${file.path}: ${text}`))).toEqual([]);
  });

  it('(i) nothing the audit CLI loads at run time reaches the control store, the environment check or node:sqlite', () => {
    const files = new Map<string, ScannedSource>(SOURCE_FILES.map((file) => [file.path, file]));
    expect(findTransitiveReferences(files, CLI_FILES.map((file) => file.path))).toEqual([]);
    // たどり方が実際のファイルで働いていることの確かめ（CLI から src/config/ までは届く）。
    expect(reachableFiles(files, 'src/cli/index.ts').some((path) => path.startsWith('src/config/'))).toBe(true);
  });
});
