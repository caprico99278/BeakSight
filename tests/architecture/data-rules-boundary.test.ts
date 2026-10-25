/**
 * 入力の規則の部品（`src/control/data-rules/`）の境界と、外部到達の語の一覧の owner の Architecture Gate（Task 29 の設計書 5 章、6 章の Gate。T29a）。
 * - (a) `src/control/data-rules/` は、`src/browser/`・`src/worker/`・`src/orchestration/`・Playwright を参照しない（型だけの import、`export … from`、
 *   動的 import、相対パスと Playwright の名前の文字列リテラルを含む）。実行時に読み込む import をたどった先にも現れない（書き込みの要求を送る部品に
 *   届かない）。
 * - (b) 外部到達の語の一覧（メール・電話・通知・住所の欄の名前の語と、autocomplete の値）は、owner
 *   （`src/control/data-rules/external-delivery-words.ts`）の外に書かない: owner の一覧の名前（`EXTERNAL_DELIVERY_*`）を owner の外で定義しない。
 *   owner の外のファイルの文字列リテラルのうち、一覧の語と同じものが `COPIED_WORD_LIST_THRESHOLD` 種類以上あれば、一覧の書き写しとみなす（欄の型の
 *   一覧の `'email'`・`'tel'` のような、1〜2 語の別の意味の使い方は許す。近似）。
 *   T29c で、通知の欄の「送らない」側の選択肢の値の一覧（`NOTIFICATION_OPT_OUT_OPTION_WORDS`）と判定も、owner にだけ定義する名前に足した。
 * - (c) 規則の集まりの digest は、`createSha256Fingerprint` と `sortedKeysJsonOf` で求める（SHA-256 と鍵の並べ方を書き写さない）。
 * - (e)（T29c fix round 1。ReDoS）`src/control/data-rules/` は正規表現を実行時に組み立てない（`RegExp` の呼び出しと `new RegExp` を書かない）。
 *   ページが書いた pattern は、閉じた単純な文法（`simple-pattern.ts`）で解釈する。
 * - (d)（T29c）業務テンプレートと意味の推しの語の一覧（意味の種類ごとの欄の名前の語、完全一致の名前、autocomplete の値、フリガナの印、人の名前で
 *   ない語）は、owner（`src/control/data-rules/business-templates.ts`）の外に書かない（(b) と同じ検出。書き写しとみなす種類の数は
 *   `COPIED_TEMPLATE_WORD_LIST_THRESHOLD`）。
 * - (f)（T29e）画面向けの公開し直し（`src/control/data-rules-view.ts`）は、`src/control/data-rules/` のものだけを公開し直し、定義の文を持たない
 *   （判断を持たない。`approval-ssot.test.ts` の (d) と同じ形）。
 * - (g)（PRE42-CC 組 4。CC-082 1′）ASCII だけの語の判定（英語の語は語の単位、日本語の語は部分一致で比べるための振り分け）は、欄の名前の語の比べの
 *   owner（`src/discovery/classify.ts`）の `isAsciiWord` だけに書く。`src/control/data-rules/` は、印字できる ASCII の範囲（`\x20-\x7e` など）を
 *   書き写さず、それを import する。
 * - 判定は、`fs`、正規表現、文字列の走査だけ（`source-scan.ts` の共通の部品）。`src/**` の読み込みは、このファイルの読み込み時に 1 回だけ。
 *   1 秒以内に終える。
 */
import { describe, expect, it } from 'vitest';
import {
  EXTERNAL_DELIVERY_AUTOCOMPLETE_TOKENS,
  EXTERNAL_DELIVERY_NAME_WORDS,
} from '../../src/control/data-rules/external-delivery-words.js';
import {
  KANA_MARKER_WORDS,
  NON_PERSON_NAME_WORDS,
  TEMPLATE_KIND_EXACT_NAMES,
  TEMPLATE_KIND_NAME_WORDS,
} from '../../src/control/data-rules/business-templates.js';
import {
  PLAYWRIGHT_PACKAGE_PATTERN,
  countDefinitions,
  countIdentifier,
  findModuleSpecifiers,
  findTransitiveForbiddenReferences,
  isPathUnder,
  isPathUnderAny,
  loadSourceFiles,
  pathReferenceCandidatesOf,
  refersUnderAny,
  resolveRelativeSpecifier,
  scanSource,
  sourceFileAt,
  type ScannedSource,
  type SourceFile,
} from './source-scan.js';

const SOURCE_FILES = loadSourceFiles();

const DATA_RULES_DIRECTORY = 'src/control/data-rules/';
const WORDS_OWNER = 'src/control/data-rules/external-delivery-words.ts';
const CONTRACTS_FILE = 'src/control/data-rules/rule-contracts.ts';
const DIGEST_OWNER = 'src/control/data-rules/rule-digest.ts';
const TEMPLATES_OWNER = 'src/control/data-rules/business-templates.ts';

/** (a) `src/control/data-rules/` から参照しないディレクトリ。 */
const FORBIDDEN_DIRECTORIES: readonly string[] = ['src/browser/', 'src/worker/', 'src/orchestration/'];

const isForbiddenPath = (path: string): boolean => isPathUnderAny(path, FORBIDDEN_DIRECTORIES);

/** (b)・(d) 語の一覧の owner（owner にだけ定義する名前、一覧の語、書き写しとみなす同じ語の文字列リテラルの種類の数）。 */
interface WordListOwner {
  readonly owner: string;
  readonly names: readonly string[];
  readonly words: ReadonlySet<string>;
  readonly threshold: number;
}

/** (b) 外部到達の語の一覧の書き写しとみなす、一覧の語と同じ文字列リテラルの種類の数。 */
const COPIED_WORD_LIST_THRESHOLD = 3;

/**
 * (d) 業務テンプレートの語の一覧の書き写しとみなす種類の数（T29c）。`name`・`title`・`none` のような、別の意味でよく使う語があるので、外部到達の
 * 語より多くする（今の `src/` で owner の外に同時に現れる種類は 3 まで）。
 */
const COPIED_TEMPLATE_WORD_LIST_THRESHOLD = 5;

/** (b) 外部到達の語の一覧の owner。 */
const EXTERNAL_WORD_OWNER: WordListOwner = {
  owner: WORDS_OWNER,
  names: [
    'EXTERNAL_DELIVERY_KINDS',
    'EXTERNAL_DELIVERY_NAME_WORDS',
    'EXTERNAL_DELIVERY_FIELD_TYPES',
    'EXTERNAL_DELIVERY_AUTOCOMPLETE_TOKENS',
    'NOTIFICATION_OPT_OUT_OPTION_WORDS',
    'externalDeliveryKindsOf',
    'externalDeliveryKindsOfName',
    'isNotificationOptOutValue',
    'NOTIFICATION_NEGATION_WORDS',
    'notificationFieldNameIsNegated',
  ],
  words: new Set([...Object.values(EXTERNAL_DELIVERY_NAME_WORDS).flat(), ...Object.values(EXTERNAL_DELIVERY_AUTOCOMPLETE_TOKENS).flat()]),
  threshold: COPIED_WORD_LIST_THRESHOLD,
};

/** (d) 業務テンプレートと意味の推しの語の一覧の owner（T29c）。 */
const TEMPLATE_WORD_OWNER: WordListOwner = {
  owner: TEMPLATES_OWNER,
  names: [
    'TEMPLATE_KIND_NAME_WORDS',
    'TEMPLATE_KIND_EXACT_NAMES',
    'TEMPLATE_AUTOCOMPLETE_KINDS',
    'KANA_MARKER_WORDS',
    'NON_PERSON_NAME_WORDS',
    'TEMPLATE_DEFAULT_RANGES',
    'inferSemanticKind',
  ],
  words: new Set([
    ...Object.values(TEMPLATE_KIND_NAME_WORDS).flat(),
    ...Object.values(TEMPLATE_KIND_EXACT_NAMES).flat(),
    ...KANA_MARKER_WORDS,
    ...NON_PERSON_NAME_WORDS,
  ]),
  threshold: COPIED_TEMPLATE_WORD_LIST_THRESHOLD,
};

const WORD_LIST_OWNERS: readonly WordListOwner[] = [EXTERNAL_WORD_OWNER, TEMPLATE_WORD_OWNER];

// ---------------------------------------------------------------------------------------------------------------
// 検出の関数（近似）
// ---------------------------------------------------------------------------------------------------------------

/**
 * (a) `text`（指定子か文字列リテラル）が禁止の対象を指すか: Playwright の名前か、指す先（相対なら解決したパス、相対でなければ文字列の中の
 * `src/` からのパス。`source-scan.ts` の `refersUnderAny`。PRE42-CC 組 G で最も広い形にそろえた）が禁止のフォルダの下か。
 */
const pointsToForbidden = (fromPath: string, text: string): boolean =>
  PLAYWRIGHT_PACKAGE_PATTERN.test(text) || refersUnderAny(fromPath, text, FORBIDDEN_DIRECTORIES);

/** (a) 禁止の対象を指す参照（指定子のすべてと、相対パス・`src/` のパス・Playwright の名前の文字列リテラル）。 */
const findForbiddenReferences = (path: string, source: ScannedSource): readonly string[] =>
  pathReferenceCandidatesOf(source, [PLAYWRIGHT_PACKAGE_PATTERN]).filter((text) => pointsToForbidden(path, text));

/** (a) 実行時の import をたどった先の、禁止の対象（`<始まり> -> … -> <先>`）。 */
const findTransitiveForbidden = (files: ReadonlyMap<string, ScannedSource>, starts: readonly string[]): readonly string[] =>
  findTransitiveForbiddenReferences(files, starts, isForbiddenPath, (specifier) => PLAYWRIGHT_PACKAGE_PATTERN.test(specifier));

// (b) 定義の数は `source-scan.ts` の `countDefinitions`（PRE42-CC 組 G。`class name` の定義も数える、最も広い形）。

/** (b)・(d) owner の外の違反（`パス: 名前` か `パス: [語, …]`）: owner の名前の定義と、一覧の語の文字列リテラルの書き写し。 */
const copiedWordListsOf = (
  files: readonly (Pick<SourceFile, 'path'> & ScannedSource)[],
  wordOwner: WordListOwner,
): readonly string[] =>
  files.filter((file) => file.path !== wordOwner.owner).flatMap((file) => {
    const definitions = wordOwner.names.filter((name) => countDefinitions(file.bare, name) > 0).map((name) => `${file.path}: ${name}`);
    const words = [...new Set(file.literals.filter((literal) => wordOwner.words.has(literal)))].sort();
    return [...definitions, ...(words.length >= wordOwner.threshold ? [`${file.path}: ${JSON.stringify(words)}`] : [])];
  });

/** (e) 正規表現を実行時に組み立てる呼び出し（`RegExp(…)`・`new RegExp(…)`。コメントと文字列の中は数えない）。 */
const findRegExpConstructions = (source: ScannedSource): readonly string[] =>
  [...source.bare.matchAll(/(?<![\w$.])(?:new\s+)?RegExp\s*\(/gu)].map((match) => match[0]);

/** (f) 画面向けの公開し直しのファイル（T29e）。 */
const DATA_RULES_VIEW_FILE = 'src/control/data-rules-view.ts';

/** (f) 公開し直しのファイルの違反（`<指定子>` か `<definition>`）: `src/control/data-rules/` の外からの公開し直しと、定義の文。 */
const dataRulesViewViolationsOf = (path: string, source: ScannedSource): readonly string[] => [
  ...findModuleSpecifiers(source.code)
    .filter((specifier) => {
      const resolved = resolveRelativeSpecifier(path, specifier);
      return resolved === null || !isPathUnder(resolved, DATA_RULES_DIRECTORY);
    })
    .map((specifier) => `<${specifier}>`),
  ...(/(?<![\w$])(?:function|class|let|var)\s|(?<![\w$])const\s+[\w$]+\s*[=:]/u.test(source.bare) ? ['<definition>'] : []),
];

/** (g) ASCII だけの語の判定の owner（PRE42-CC 組 4。CC-082 1′）と、その関数の名前。 */
const ASCII_WORD_OWNER = 'src/discovery/classify.ts';
const ASCII_WORD_FUNCTION = 'isAsciiWord';

/**
 * (g) 印字できる ASCII の文字の範囲（`\x20-\x7e`・` -~`・`\u{20}-\u{7e}`・` -~`。大文字と小文字を問わない）の書き写し（`code`。コメントは
 * 除き、文字列と正規表現は見る）。
 */
const findPrintableAsciiRanges = (source: ScannedSource): readonly string[] =>
  [...source.code.matchAll(/\\(?:x20|u0020|u\{0*20\})-\\(?:x7e|u007e|u\{0*7e\})|\[ -~\]/giu)].map((match) => match[0]);

// ---------------------------------------------------------------------------------------------------------------
// 検出の関数の単体テスト（違反の例で RED）
// ---------------------------------------------------------------------------------------------------------------

describe('data rules boundary detectors (T29a)', () => {
  it('(g) detects a copy of the printable ASCII range, not the comments (PRE42-CC 組 4。CC-082 1′)', () => {
    expect(findPrintableAsciiRanges(scanSource('const a = /^[\\x20-\\x7e]+$/u.test(word);'))).toEqual(['\\x20-\\x7e']);
    expect(findPrintableAsciiRanges(scanSource('const a = /^[\\u0020-\\u007E]+$/u;\nconst b = /^[\\u{20}-\\u{7e}]+$/u;'))).toHaveLength(2);
    expect(findPrintableAsciiRanges(scanSource('const a = /^[ -~]+$/u;'))).toEqual(['[ -~]']);
    expect(findPrintableAsciiRanges(scanSource('// /^[\\x20-\\x7e]+$/u\nconst a = isAsciiWord(word);'))).toEqual([]);
  });

  it('(f) reports a re-export from outside src/control/data-rules/ and a definition in the screen re-export (T29e)', () => {
    const violating = scanSource([
      "export { evaluateRuleSet } from './data-rules/field-evaluation.js';",
      "export { approveScenario } from './approval/scenario-store.js';",
      'export const usesRules = (mode) => mode === 1;',
    ].join('\n'));
    expect(dataRulesViewViolationsOf(DATA_RULES_VIEW_FILE, violating)).toEqual(['<./approval/scenario-store.js>', '<definition>']);
    const clean = scanSource([
      '// approveScenario は公開し直さない。',
      "export { SEMANTIC_KINDS } from './data-rules/rule-contracts.js';",
      "export type { FieldRule } from './data-rules/rule-contracts.js';",
    ].join('\n'));
    expect(dataRulesViewViolationsOf(DATA_RULES_VIEW_FILE, clean)).toEqual([]);
  });

  it('(e) detects a regular expression built at run time, and not a literal one (T29c fix round 1)', () => {
    for (const line of ["const pattern = new RegExp(text, 'v');", 'const pattern = RegExp(text);', 'const p = new  RegExp (text);']) {
      expect(findRegExpConstructions(scanSource(line)), line).toHaveLength(1);
    }
    for (const line of ['const pattern = /^[0-9]+$/u;', '// new RegExp(text)', "const note = 'new RegExp(text)';", 'const ok = MyRegExp(text);']) {
      expect(findRegExpConstructions(scanSource(line)), line).toHaveLength(0);
    }
  });

  it('(a) detects references to the browser, the worker, the orchestration and Playwright from src/control/data-rules/', () => {
    const path = 'src/control/data-rules/x.ts';
    for (const line of [
      "import { chromium } from 'playwright';",
      "import type { Page } from 'playwright-core';",
      "import { AxeBuilder } from '@axe-core/playwright';",
      "import { createContext } from '../../browser/context-factory.js';",
      "import type { WorkerRun } from '../../worker/read-check-run.js';",
      "export { runAudit } from '../../orchestration/run-coordinator.js';",
      "const worker = await import('../../worker/audit-worker.js');",
      "const directory = '../../worker/';",
      "const directory = 'src/orchestration/';",
      // PRE42-CC 組 G（新 Gate の 2）: `\` の区切りのパスも見る。
      "const entry = 'beaksight\\\\src\\\\worker\\\\audit-worker.ts';",
    ]) {
      expect(findForbiddenReferences(path, scanSource(line)), line).toHaveLength(1);
    }
    for (const line of [
      "import { createSha256Fingerprint } from '../../core/ids.js';",
      "import { SCENARIO_ID_PATTERN } from '../approval/scenario-contracts.js';",
      "import type { CandidateField } from '../../discovery/candidate-contracts.js';",
      "// import { chromium } from 'playwright';",
      "const note = 'a worker of the browser';",
    ]) {
      expect(findForbiddenReferences(path, scanSource(line)), line).toHaveLength(0);
    }
  });

  it('(a) follows runtime imports transitively, and skips type-only imports', () => {
    const files = new Map<string, ScannedSource>([
      ['src/control/data-rules/a.ts', scanSource("import { b } from '../b.js';\nimport type { T } from '../../worker/t.js';")],
      ['src/control/b.ts', scanSource("import { c } from '../browser/c.js';")],
      ['src/control/data-rules/clean.ts', scanSource("import { d } from '../../core/d.js';")],
      ['src/core/d.ts', scanSource("import { createHash } from 'node:crypto';")],
    ]);
    expect(findTransitiveForbidden(files, ['src/control/data-rules/a.ts'])).toEqual(['src/control/data-rules/a.ts -> src/control/b.ts -> src/browser/c.ts']);
    expect(findTransitiveForbidden(files, ['src/control/data-rules/clean.ts'])).toEqual([]);
  });

  it('(b) reports a copied word list and a definition of the owner names outside the owner, and not a use of one or two words', () => {
    const files = [
      { path: 'src/control/data-rules/generic-values.ts', ...scanSource("const CONTACT_WORDS = ['mail', 'tel', 'phone'];") },
      { path: 'src/control/x.ts', ...scanSource("const words = Object.freeze(['住所', '電話', 'メール']);") },
      { path: 'src/control/y.ts', ...scanSource("const AUTOCOMPLETE = new Set(['street-address', 'postal-code', 'address-line1']);") },
      { path: 'src/control/z.ts', ...scanSource('export const EXTERNAL_DELIVERY_NAME_WORDS = {};') },
      { path: 'src/discovery/candidate-contracts.ts', ...scanSource("const TYPES = ['text', 'email', 'tel', 'url'];") },
      { path: 'src/report/messages.ts', ...scanSource("const text = '電話・メール・住所の欄';\n// 'mail', 'tel', 'phone'") },
      { path: WORDS_OWNER, ...scanSource("export const EXTERNAL_DELIVERY_NAME_WORDS = { EMAIL: ['mail', 'email', 'メール'] };") },
      { path: 'src/control/data-rules/user.ts', ...scanSource([
        "import { EXTERNAL_DELIVERY_NAME_WORDS } from './external-delivery-words.js';",
        'const words = EXTERNAL_DELIVERY_NAME_WORDS.EMAIL;',
      ].join('\n')) },
    ];
    expect(copiedWordListsOf(files, EXTERNAL_WORD_OWNER)).toEqual([
      'src/control/data-rules/generic-values.ts: ["mail","phone","tel"]',
      'src/control/x.ts: ["メール","住所","電話"]',
      'src/control/y.ts: ["address-line1","postal-code","street-address"]',
      'src/control/z.ts: EXTERNAL_DELIVERY_NAME_WORDS',
    ]);
  });

  it('(d) reports a copied template word list and a definition of the template owner names, and not a few common words (T29c)', () => {
    const files = [
      { path: 'src/control/data-rules/field-evaluation.ts', ...scanSource("const NAME_WORDS = ['last_name', 'first_name', 'sei', 'mei', '氏名'];") },
      { path: 'src/control/data-rules/x.ts', ...scanSource("const kinds = new Set(['price', 'quantity', 'total', 'qty', '単価']);") },
      { path: 'src/control/data-rules/y.ts', ...scanSource('export const inferSemanticKind = (field) => null;') },
      { path: 'src/evidence/dom-collector.ts', ...scanSource("const keys = ['title', 'name', 'none', 'date'];") },
      { path: TEMPLATES_OWNER, ...scanSource("export const TEMPLATE_KIND_NAME_WORDS = { FULL_NAME: ['name', 'fullname', '氏名', '名前', '姓名'] };") },
    ];
    expect(copiedWordListsOf(files, TEMPLATE_WORD_OWNER)).toEqual([
      'src/control/data-rules/field-evaluation.ts: ["first_name","last_name","mei","sei","氏名"]',
      'src/control/data-rules/x.ts: ["price","qty","quantity","total","単価"]',
      'src/control/data-rules/y.ts: inferSemanticKind',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------------------------------------------

const fileOf = (path: string): SourceFile => sourceFileAt(SOURCE_FILES, path);

const DATA_RULES_FILES = SOURCE_FILES.filter((file) => file.path.startsWith(DATA_RULES_DIRECTORY));

describe('data rules boundary and the external delivery word owner (Task 29 design 5, 6)', () => {
  it('reads the data rules files once', () => {
    expect(DATA_RULES_FILES.map((file) => file.path)).toEqual(expect.arrayContaining([CONTRACTS_FILE, DIGEST_OWNER, WORDS_OWNER, TEMPLATES_OWNER]));
  });

  it('(a) src/control/data-rules/ does not refer to the browser, the worker, the orchestration or Playwright', () => {
    expect(DATA_RULES_FILES.flatMap((file) => findForbiddenReferences(file.path, file).map((text) => `${file.path}: ${text}`))).toEqual([]);
  });

  it('(a) nothing that src/control/data-rules/ loads at run time reaches them', () => {
    const files = new Map<string, ScannedSource>(SOURCE_FILES.map((file) => [file.path, file]));
    expect(findTransitiveForbidden(files, DATA_RULES_FILES.map((file) => file.path))).toEqual([]);
  });

  it.each(WORD_LIST_OWNERS.map((wordOwner) => [wordOwner.owner, wordOwner] as const))(
    '(b, d) defines the word lists of %s once, only in the owner, and no file outside copies them',
    (_owner, wordOwner) => {
      const owner = fileOf(wordOwner.owner);
      expect(wordOwner.names.map((name) => [name, countDefinitions(owner.bare, name)])).toEqual(wordOwner.names.map((name) => [name, 1]));
      // 読み方が実際のファイルで働いていることの確かめ（owner は一覧の語を文字列リテラルで持つ）。
      expect(owner.literals.filter((literal) => wordOwner.words.has(literal)).length).toBeGreaterThanOrEqual(wordOwner.threshold);
      expect(copiedWordListsOf(SOURCE_FILES, wordOwner)).toEqual([]);
    },
  );

  it('(f) the screen re-export publishes only names of src/control/data-rules/, without definitions (T29e)', () => {
    const view = fileOf(DATA_RULES_VIEW_FILE);
    // 読み方が実際のファイルで働いていることの確かめ（公開し直す名前が見えている）。
    expect(countIdentifier(view.bare, 'saveRuleSetAndAttach')).toBeGreaterThan(0);
    expect(dataRulesViewViolationsOf(view.path, view)).toEqual([]);
  });

  it('(e) builds no regular expression at run time in src/control/data-rules/ (T29c fix round 1)', () => {
    expect(DATA_RULES_FILES.flatMap((file) => findRegExpConstructions(file).map((text) => `${file.path}: ${text}`))).toEqual([]);
  });

  it('(g) judges the ASCII words with the owner of the field name words, without a copy (PRE42-CC 組 4。CC-082 1′)', () => {
    const owner = fileOf(ASCII_WORD_OWNER);
    expect(owner.bare).toMatch(new RegExp(`\\bexport\\s+const\\s+${ASCII_WORD_FUNCTION}\\s*=`, 'u'));
    expect(findPrintableAsciiRanges(owner)).toHaveLength(1);
    expect(DATA_RULES_FILES.flatMap((file) => findPrintableAsciiRanges(file).map((text) => `${file.path}: ${text}`))).toEqual([]);
    const words = fileOf(WORDS_OWNER);
    expect(findModuleSpecifiers(words.code)).toContain('../../discovery/classify.js');
    expect(countIdentifier(words.bare, ASCII_WORD_FUNCTION)).toBeGreaterThanOrEqual(2);
  });

  it('(c) computes the rule set digest with createSha256Fingerprint and sortedKeysJsonOf (not a copy of SHA-256)', () => {
    const digest = fileOf(DIGEST_OWNER);
    expect(countIdentifier(digest.bare, 'createSha256Fingerprint')).toBeGreaterThanOrEqual(2);
    expect(countIdentifier(digest.bare, 'sortedKeysJsonOf')).toBeGreaterThanOrEqual(2);
    expect(countIdentifier(digest.bare, 'createHash')).toBe(0);
  });
});
