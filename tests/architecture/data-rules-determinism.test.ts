/**
 * 入力の規則（`src/control/data-rules/`）の決定性の Architecture Gate（Task 29 の設計書 3 章の決定的な生成、5 章、6 章の Gate。T29b）。
 * - (a) `src/control/data-rules/` のファイル（入れ子を含む `.ts`）は、非決定的な部品を使わない:
 *   - 乱数: `Math.random`、`crypto.random…`（`randomInt`、`randomBytes`、`randomUUID`、`randomFill` など）、`getRandomValues`。
 *   - 今の時刻: `Date.now()`、引数のない `new Date()`（`new Date` を含む）、`performance.now()`、`process.hrtime`（時刻は引数で受ける）。
 *   - `node:crypto`（`crypto`）の参照（SHA-256 は `src/core/ids.ts` の部品を使う。乱数の部品を読み込まないため）。
 * - 判定は、`fs`、正規表現、文字列の走査だけ（`source-scan.ts` の共通の部品）。コメントと文字列の中は数えない（`bare`）。指定子は
 *   `findModuleSpecifiers` で取る。`src/**` の読み込みは、このファイルの読み込み時に 1 回だけ。1 秒以内に終える。
 */
import { describe, expect, it } from 'vitest';
import { findModuleSpecifiers, loadSourceFiles, scanSource, type ScannedSource } from './source-scan.js';

const SOURCE_FILES = loadSourceFiles();

const DATA_RULES_DIRECTORY = 'src/control/data-rules/';
/** 必ず走査の対象に入るファイル（空の走査で PASS しないための確かめ）。 */
const REQUIRED_FILES: readonly string[] = [
  'src/control/data-rules/deterministic-stream.ts',
  'src/control/data-rules/generic-values.ts',
  'src/control/data-rules/dictionaries/dictionaries.ts',
];

/** 非決定的な部品の形（`bare` に当てる）。 */
const NONDETERMINISTIC_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['Math.random', /(?<![\w$])Math\s*\.\s*random(?![\w$])/gu],
  ['crypto.random*', /(?<![\w$])crypto\s*\.\s*random\w*/gu],
  ['random* of node:crypto', /(?<![\w$])random(?:Int|Bytes|UUID|Uuid|Fill|FillSync|Prime|PrimeSync)(?![\w$])/gu],
  ['getRandomValues', /(?<![\w$])getRandomValues(?![\w$])/gu],
  ['Date.now', /(?<![\w$])Date\s*\.\s*now(?![\w$])/gu],
  ['new Date()', /(?<![\w$])new\s+Date\s*\(\s*\)/gu],
  ['new Date', /(?<![\w$])new\s+Date(?![\w$])(?!\s*\()/gu],
  ['performance.now', /(?<![\w$])performance\s*\.\s*now(?![\w$])/gu],
  ['process.hrtime', /(?<![\w$])process\s*\.\s*hrtime(?![\w$])/gu],
];

/** 参照してはいけないモジュール（乱数の部品を持つもの）。 */
const FORBIDDEN_MODULES: ReadonlySet<string> = new Set(['node:crypto', 'crypto']);

/** (a) ファイルの中の、非決定的な部品の使い方（`<形>` の一覧）。 */
const findNondeterminism = (source: ScannedSource): readonly string[] => [
  ...NONDETERMINISTIC_PATTERNS.flatMap(([label, pattern]) => [...source.bare.matchAll(pattern)].map(() => label)),
  ...findModuleSpecifiers(source.code).filter((specifier) => FORBIDDEN_MODULES.has(specifier)).map((specifier) => `import ${specifier}`),
];

describe('data rules determinism gate (Task 29, T29b)', () => {
  it('(a) detects random and current-time parts, and ignores comments, strings and other names', () => {
    const violating = [
      'const a = Math.random();',
      'const b = Math . random();',
      'const c = crypto.randomInt(0, 10);',
      'const d = crypto.randomUUID();',
      "import { randomBytes } from 'node:crypto';",
      "import { createHash } from 'crypto';",
      'globalThis.crypto.getRandomValues(buffer);',
      'const e = Date.now();',
      'const f = new Date();',
      'const g = new Date;',
      'const h = performance.now();',
      'const i = process.hrtime.bigint();',
    ];
    for (const line of violating) {
      expect(findNondeterminism(scanSource(line)), line).not.toHaveLength(0);
    }
    const allowed = [
      '// Math.random() and Date.now() in a comment',
      "const text = 'Math.random() Date.now() new Date()';",
      'const date = new Date(milliseconds);',
      'const parsed = Date.parse(text);',
      'const stream = createDeterministicStream(seed, purpose);',
      'const randomness = 0;',
      'const nowValue = context.now;',
      "import { sha256HexOfText } from '../../core/ids.js';",
    ];
    for (const line of allowed) {
      expect(findNondeterminism(scanSource(line)), line).toEqual([]);
    }
  });

  it('(a) src/control/data-rules/ uses no random or current-time parts', () => {
    const files = SOURCE_FILES.filter((file) => file.path.startsWith(DATA_RULES_DIRECTORY));
    const paths = files.map((file) => file.path);
    for (const required of REQUIRED_FILES) {
      expect(paths).toContain(required);
    }
    const violations = files.flatMap((file) => findNondeterminism(file).map((found) => `${file.path}: ${found}`));
    expect(violations).toEqual([]);
  });
});
