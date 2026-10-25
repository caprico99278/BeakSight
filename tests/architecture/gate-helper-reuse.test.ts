/**
 * Architecture Gate の補助の Gate（PRE42-CC の組 G。調べの「新 Gate」の 1〜13）。判定は `fs`、正規表現、文字列の走査だけ（`source-scan.ts` の
 * `readTypeScriptFilesUnder`・`scanFile` を共用する）。近似の検査である。
 * - 見る所: `tests/architecture/` の Gate のファイル（`source-scan.ts` と、このファイルを除く）。
 * - (a) Gate ごとに書き写していた補助は、`source-scan.ts` の 1 つを使う（書き写しの戻りを止める）: 時間の上限（`MAX_GATE_MS`。CPU の時間の
 *   測り `startCpuStopwatch` で測る。壁時計の形は `wall-clock-speed-checks.test.ts` が止める。TS-d）、フォルダの
 *   下かの判定（`isPathUnder`・`isPathUnderAny`）、`escapeRegExp`、定義の数（`countDefinitions`）、走査したファイルの作り（`sourceFileOf`・
 *   `sourceFileAt`）、`violationsOf`、括弧の対応（`matchingBracket`・`matchingParenthesis`）、除外の確かめ（`unusedExclusionsOf`・
 *   `judgeWithFileExceptions`）、テストと画面の読み込み（`readLfTypeScriptFilesUnder`・`loadLocalUiAppFiles`・`loadLocalUiSourceFiles`）、
 *   `createRequire` の変数の見分け（`createRequireBindingNamesOf`）、読み取りの method の写しの形（`readMethodCopiesIn`）、公開の名前
 *   （`exportedNamesOf`）。
 * - (b) 新 Gate の 2: 相対でない参照を当てる正規表現（`src/` のパスの形、Node の部品の名前の形）を Gate のファイルに書かない。
 *   `source-scan.ts` の `referencedPathsOf`・`refersUnderAny`・`pathReferenceCandidatesOf`・`modulePattern`・`isNodeBuiltinSpecifier`
 *   （今までの Gate のうち最も広い形）を使う。
 * - (c) 新 Gate の 12: `node:child_process` を参照してよいファイルの一覧は、`child-process-policy.ts` の 1 つ（各 Gate はそれに、Gate ごとの
 *   追加を足して読む）。ほかの Gate のファイルに、一覧を定義し直さない。
 * - 除外は閉じた一覧（ファイル → 形の名前 → 理由）。使われなくなった除外も誤りにする。
 * - 1 ファイル 1 秒以内に終える。
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_GATE_MS,
  readTypeScriptFilesUnder,
  scanFile,
  sourceFileOf,
  startCpuStopwatch,
  unusedExclusionsOf,
  type SourceFile,
} from './source-scan.js';

const ARCHITECTURE_DIRECTORY = 'tests/architecture';
const SOURCE_SCAN = `${ARCHITECTURE_DIRECTORY}/source-scan.ts`;
const THIS_GATE = `${ARCHITECTURE_DIRECTORY}/gate-helper-reuse.test.ts`;
const CHILD_PROCESS_POLICY = `${ARCHITECTURE_DIRECTORY}/child-process-policy.ts`;

/** 見る Gate のファイル（読み込みと走査は 1 回だけ）。 */
const GATE_FILES: readonly SourceFile[] = readTypeScriptFilesUnder(ARCHITECTURE_DIRECTORY)
  .filter(({ path }) => path !== SOURCE_SCAN && path !== THIS_GATE)
  .map((file) => scanFile(file));

/** 書き写しの形（名前、当てる本文、形）。`code` はコメントを除いた本文（文字列と正規表現は残る）、`bare` はさらに文字列の中身を除いた本文。 */
interface CopyShape {
  readonly name: string;
  readonly text: 'code' | 'bare';
  readonly pattern: RegExp;
  /** 形を書いてよい持ち主のファイル（あれば）。 */
  readonly owner?: string;
}

const definitionOf = (names: readonly string[]): RegExp =>
  new RegExp(String.raw`(?<![\w$.])(?:(?:const|let|var)\s+|function\s*\*?\s*)(?:${names.join('|')})(?![\w$])`, 'gu');

const COPY_SHAPES: readonly CopyShape[] = Object.freeze([
  // (a) 共通の補助の書き写し
  { name: 'gate time limit', text: 'bare', pattern: /(?<![\w$.])1_?000(?![\w$.])/gu },
  { name: 'path under a directory', text: 'code', pattern: /`\$\{[^`]*?\}\/`\s*\.\s*startsWith\s*\(/gu },
  { name: 'escapeRegExp', text: 'code', pattern: /\[\.\*\+\?\^\$\{\}\(\)\|\[\\\]\\\\\]/gu },
  { name: 'definition count', text: 'code', pattern: /function(?:\\\\|\\)s\*(?:\\\\|\\)\*\?(?:\\\\|\\)s\*\$\{/gu },
  { name: 'scanned file builder', text: 'code', pattern: /(?:=>\s*\(|\breturn\s+(?:[\w$]+\s*\?\?\s*)?)\{\s*path\b[^{}]*?\.\.\.\s*scanSource\s*\(/gu },
  { name: 'violations list', text: 'bare', pattern: /\bfind\s*\(\s*file\s*\)\s*\.\s*map\s*\(\s*\(\s*match\s*\)\s*=>/gu },
  { name: 'bracket depth', text: 'bare', pattern: /\bdepth\s*(?:\+=|-=)\s*1(?![\w$])|\bdepth\s*(?:\+\+|--)/gu },
  {
    name: 'unused exclusions by hand',
    text: 'bare',
    pattern: /(?:EXCEPTIONS|EXCLUSIONS|EXCLUDED_[A-Z_]+)\s*(?:\.\s*keys\s*\(\s*\)\s*)?\]?\s*\)?\s*\.\s*filter\s*\(\s*\(\s*[\w$]+\s*\)\s*=>\s*!|\bdeclared\s*\.\s*filter\s*\(|!\s*used(?:Exceptions)?\s*\.\s*has\s*\(|\bfor\s*\(\s*const\s+[\w$]+\s+of\s+[\w$]*(?:EXCEPTIONS|EXCLUSIONS)\b/gu,
  },
  { name: 'line ending normalization', text: 'code', pattern: /\.\s*replaceAll\s*\(\s*'\\r\\n'/gu },
  { name: 'directory listing', text: 'bare', pattern: /\breaddirSync\s*\(/gu },
  { name: 'createRequire binding', text: 'bare', pattern: /\bCREATE_REQUIRE_BINDING\w*/gu },
  { name: 'read method copy', text: 'code', pattern: /\(\?:GET\\1|\(\?:HEAD\\1|(?<![\w$])(?:eitherOrder|methodCompared)(?![\w$])/gu },
  { name: 'exported names', text: 'code', pattern: /\^export\\s\+\(\?:async\\s\+\)\?\(\?:function/gu },
  {
    name: 'shared helper definition',
    text: 'bare',
    pattern: definitionOf([
      'escapeRegExp', 'countDefinitions', 'isUnder', 'isPathUnder', 'isPathUnderAny', 'matchingBrace', 'matchingBracket', 'matchingParenthesis',
      'violationsOf', 'sourceFileOf', 'sourceFileAt', 'exportedNamesOf', 'unusedExclusionsOf', 'judgeWithFileExceptions', 'readMethodCopiesIn',
    ]),
  },
  // (b) 相対でない参照の正規表現
  { name: 'source path pattern', text: 'code', pattern: /\(\?:\^\|(?:\\\/|\[\\\\\/\]|\[\\\/\]|\/)\)\(?(?:src|\$\{)/gu },
  { name: 'node module pattern', text: 'code', pattern: /\(\?:node:\)\?|\^node:|startsWith\s*\(\s*'node:'\s*\)/gu },
  // (c) `node:child_process` の一覧
  {
    name: 'child process list',
    text: 'code',
    pattern: /\bCHILD_PROCESS_\w*\s*(?::[^=;]*)?=\s*(?:Object\.freeze\(\s*|new\s+Set\s*(?:<[^<>()]*>)?\(\s*)?\[\s*['"`]/gu,
    owner: CHILD_PROCESS_POLICY,
  },
]);

/** 形に当たった所（`<形の名前>: <当たった本文>`。空白は 1 つにそろえる）。持ち主のファイルの、その形は数えない。 */
const copiesOf = (file: Pick<SourceFile, 'path' | 'code' | 'bare'>): readonly string[] =>
  COPY_SHAPES.filter(({ owner }) => owner !== file.path)
    .flatMap(({ name, text, pattern }) => [...file[text].matchAll(pattern)].map((match) => `${name}: ${match[0].replace(/\s+/gu, ' ').trim()}`));

/** 除外（ファイル → 形の名前 → 理由）。寄せたら消す（組 UI-K2 の 3 つの Gate の除外は、G-F で寄せて消した）。 */
const COPY_EXCEPTIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  'tests/architecture/module-references.test.ts': Object.freeze({
    'directory listing': '`source-scan.ts` と Gate のファイルそのものを読む検査（走査の補助の自己確認。Gate のファイルの一覧を自分で作る）',
  }),
  'tests/architecture/target-isolation.test.ts': Object.freeze({
    'directory listing': '設定の JSON（`config/targets/`）を読む（TypeScript の読み込みの補助の対象の外）',
  }),
  'tests/architecture/test-suites.test.ts': Object.freeze({
    'directory listing': 'テストのファイルのパスの一覧だけを作る（本文を読まず、走査もしない。Vitest の project の glob との照合に使う）',
  }),
  'tests/architecture/llm-dependency.test.ts': Object.freeze({
    'node module pattern': 'パッケージの名前の取り出し（Node の部品と URL を除いて、残りをパッケージとみなす）。Node の部品の名前を広げると LLM の依存の検出が狭まるので、寄せない',
  }),
});

/** 見つけたものを、除外と違反に分ける（使った除外の `<ファイル>:<形の名前>` も返す）。 */
const judge = (files: readonly SourceFile[]): { readonly found: readonly string[]; readonly used: readonly string[] } => {
  const used: string[] = [];
  const found = files.flatMap((file) => copiesOf(file).filter((copy) => {
    const shape = copy.slice(0, copy.indexOf(': '));
    if (COPY_EXCEPTIONS[file.path]?.[shape] === undefined) {
      return true;
    }
    used.push(`${file.path}:${shape}`);
    return false;
  }).map((copy) => `${file.path}: ${copy}`));
  return { found, used };
};

const planted = (content: string): readonly string[] => copiesOf(sourceFileOf(`${ARCHITECTURE_DIRECTORY}/planted.test.ts`, content));

describe('Gate: the architecture gates use the shared gate helpers of source-scan.ts (PRE42-CC group G)', () => {
  it('reads the gate files and the shared helpers', () => {
    expect(GATE_FILES.map(({ path }) => path)).toEqual(expect.arrayContaining([
      `${ARCHITECTURE_DIRECTORY}/approval-ssot.test.ts`,
      `${ARCHITECTURE_DIRECTORY}/worker-boundary-policy.ts`,
      CHILD_PROCESS_POLICY,
    ]));
    const sourceScan = readTypeScriptFilesUnder(ARCHITECTURE_DIRECTORY).find(({ path }) => path === SOURCE_SCAN)?.content ?? '';
    for (const name of [
      'MAX_GATE_MS', 'startCpuStopwatch', 'isPathUnder', 'isPathUnderAny', 'escapeRegExp', 'countDefinitions', 'sourceFileOf', 'sourceFileAt', 'violationsOf',
      'matchingBracket', 'matchingParenthesis', 'unusedExclusionsOf', 'judgeWithFileExceptions', 'readLfTypeScriptFilesUnder', 'loadLocalUiAppFiles',
      'createRequireBindingNamesOf', 'readMethodCopiesIn', 'exportedNamesOf', 'referencedPathsOf', 'refersUnderAny', 'pathReferenceCandidatesOf',
      'modulePattern', 'nodeModuleTextPattern', 'isNodeBuiltinSpecifier', 'sourcePathsInText', 'TEST_SOURCE_DIRECTORIES', 'readLfTextFile',
    ]) {
      expect(sourceScan, name).toMatch(new RegExp(String.raw`^export const ${name}\b`, 'mu'));
    }
  });

  it('(a)(b)(c) the gate files do not copy the shared helpers and the reference patterns', () => {
    const stopwatch = startCpuStopwatch();
    const { found, used } = judge(GATE_FILES);
    expect(found).toEqual([]);
    const declared = Object.entries(COPY_EXCEPTIONS).flatMap(([path, shapes]) => Object.keys(shapes).map((shape) => `${path}:${shape}`));
    expect(unusedExclusionsOf(declared, used), 'exceptions that are no longer used').toEqual([]);
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_GATE_MS * GATE_FILES.length);
  });

  it('(c) only child-process-policy.ts defines the list of the files that may refer to node:child_process', () => {
    const policy = GATE_FILES.find(({ path }) => path === CHILD_PROCESS_POLICY);
    expect(policy?.content ?? '').toMatch(/^export const CHILD_PROCESS_RUNTIME_FILES\b/mu);
    for (const user of ['credential-boundary.test.ts', 'write-stage-boundary.test.ts']) {
      expect(GATE_FILES.find(({ path }) => path === `${ARCHITECTURE_DIRECTORY}/${user}`)?.code ?? '', user)
        .toMatch(/\bCHILD_PROCESS_RUNTIME_FILES\b/u);
    }
  });

  it('finds the shapes placed on purpose, and does not count the shared helpers, comments and strings (the control)', () => {
    expect(planted([
      'const MAX_MS_PER_FILE = 1_000;',
      'expect(elapsed).toBeLessThan(1000 * files.length);',
      'const isUnder = (path, directories) => directories.some((directory) => `${path}/`.startsWith(directory));',
      "const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\\]\\\\]/gu, '\\\\$&');",
      'const pattern = new RegExp(`(?<![\\\\w$])(?:function\\\\s*\\\\*?\\\\s*${escaped}(?![\\\\w$]))`, "gu");',
      'const sample = (path, content) => ({ path, content, ...scanSource(content) });',
      "const fileAt = (path) => { const file = FILES.find((f) => f.path === path); return file ?? { path, content: '', ...scanSource('') }; };",
      'const list = files.flatMap((file) => find(file).map((match) => `${file.path}: ${match}`));',
      'for (const c of text) { if (c === "{") { depth += 1; } else if (c === "}") { depth--; } }',
      'expect(Object.keys(MY_EXCEPTIONS).filter((path) => !used.has(path))).toEqual([]);',
      'expect([...MY_EXCLUSIONS.keys()].filter((entry) => !found.has(entry))).toEqual([]);',
      'const unused = declared.filter((entry) => !used.has(entry));',
      'for (const key of MY_EXCLUSIONS.keys()) { expect(found).toContain(key); }',
      "const files = read().map(({ path, content }) => ({ path, content: content.replaceAll('\\r\\n', '\\n') }));",
      "const names = readdirSync('apps/local-ui');",
      'const CREATE_REQUIRE_BINDING_BEFORE = /x/u;',
      "const either = eitherOrder('a', '&&', 'b');",
      'const names = [...text.matchAll(/^export\\s+(?:async\\s+)?(?:function\\s*\\*?|const)\\s+([A-Za-z_$][\\w$]*)/gmu)];',
      'const matchingBrace = (bare, open) => open;',
      'const forbidden = /(?:^|\\/)src\\/(?:browser|worker)(?:\\/|$)/u;',
      'const inside = new RegExp(`(?:^|/)${directory}(?:/|$)`, "u");',
      'const sqlite = /^(?:node:)?sqlite$/u;',
      "const nodeOnly = specifier.startsWith('node:');",
      "const CHILD_PROCESS_USERS: ReadonlySet<string> = new Set(['src/control/job/audit-job-manager.ts']);",
      "const CHILD_PROCESS_FILES: readonly string[] = ['src/control/credentials/dpapi-protector.ts'];",
    ].join('\n'))).toEqual([
      'gate time limit: 1_000',
      'gate time limit: 1000',
      'path under a directory: `${path}/`.startsWith(',
      'escapeRegExp: [.*+?^${}()|[\\]\\\\]',
      'definition count: function\\\\s*\\\\*?\\\\s*${',
      'scanned file builder: => ({ path, content, ...scanSource(',
      "scanned file builder: return file ?? { path, content: '', ...scanSource(",
      'violations list: find(file).map((match) =>',
      'bracket depth: depth += 1',
      'bracket depth: depth--',
      'unused exclusions by hand: EXCEPTIONS).filter((path) => !',
      'unused exclusions by hand: EXCLUSIONS.keys()].filter((entry) => !',
      'unused exclusions by hand: declared.filter(',
      'unused exclusions by hand: !used.has(',
      'unused exclusions by hand: for (const key of MY_EXCLUSIONS',
      "line ending normalization: .replaceAll('\\r\\n'",
      'directory listing: readdirSync(',
      'createRequire binding: CREATE_REQUIRE_BINDING_BEFORE',
      'read method copy: eitherOrder',
      'exported names: ^export\\s+(?:async\\s+)?(?:function',
      'shared helper definition: const isUnder',
      'shared helper definition: const escapeRegExp',
      'shared helper definition: const matchingBrace',
      'source path pattern: (?:^|\\/)src',
      'source path pattern: (?:^|/)${',
      'node module pattern: (?:node:)?',
      "node module pattern: startsWith('node:')",
      "child process list: CHILD_PROCESS_USERS: ReadonlySet<string> = new Set(['",
      "child process list: CHILD_PROCESS_FILES: readonly string[] = ['",
    ]);
    expect(planted([
      // 当たらない: 共通の補助の使い、コメント、文字列の中、ほかの数。
      "import { MAX_GATE_MS, isPathUnder, escapeRegExp, sourceFileOf, startCpuStopwatch } from './source-scan.js';",
      'expect(stopwatch.elapsedMs()).toBeLessThan(MAX_GATE_MS * files.length);',
      'const inside = isPathUnderAny(resolved, FORBIDDEN_DIRECTORIES);',
      'const file = sourceFileOf(path, content);',
      '// const MAX_MS = 1_000; depth += 1; readdirSync(root);',
      "const label = 'the gate takes 1_000 ms and calls readdirSync(';",
      'const LIMIT_MS = 10_000; const ITEMS = 1_0000; const ratio = 1000.5;',
      'const pattern = modulePattern([\'child_process\']);',
      'const users = new Set([...CHILD_PROCESS_RUNTIME_FILES, STORE_PATH]);',
    ].join('\n'))).toEqual([]);
  });
});
