/**
 * UI Gate（UI追補設計書 第6章、Task 14〜17 の設計書 6.1.7）。
 * - ファイルの一覧の取得と読み込みは、このファイルの読み込み時に1回だけ行い、各検査で共有する。
 * - ファイルの一覧の取得、読み込み、コメントの除去は、Architecture の Gate と共通の `source-scan.ts` の走査を使う
 *   （DEF-011。Task 18 の設計書 4.4）。文字列リテラルの取り出しも、その走査の `wholeLiterals` を使う（CC-030）。
 * - 判定は、Node.js 標準の `fs`、正規表現、文字列の検索だけで行う（AST・外部ツール・子プロセス・`dist/` を使わない）。
 * - ファイル全体を1秒以内に終える。
 */
import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_TYPES,
  FINDING_CATEGORIES,
  INTERACTION_STATUSES,
  PAGE_AUDIT_STATUSES,
  RUN_STATUSES,
  SEVERITIES,
  VIEWPORT_PROFILES,
} from '../../src/core/contracts.js';
import { INTERACTION_NOT_VERIFIABLE_KINDS, SAFETY_EVENT_KINDS } from '../../src/core/evidence-types.js';
import {
  DISPLAY_TONES,
  EVIDENCE_TYPE_CATALOG,
  FINDING_CATEGORY_CATALOG,
  INTERACTION_NOT_VERIFIABLE_KIND_CATALOG,
  INTERACTION_STATUS_CATALOG,
  PAGE_AUDIT_STATUS_CATALOG,
  RUN_STATUS_CATALOG,
  SAFETY_EVENT_KIND_CATALOG,
  SEVERITY_CATALOG,
  VIEWPORT_PROFILE_CATALOG,
} from '../../src/presentation/catalog.js';
import {
  formatBytes,
  formatCount,
  formatDateTime,
  formatDuration,
  formatInteger,
  formatNotObserved,
} from '../../src/presentation/format.js';
import { findImportSpecifiers, loadSourceFiles, scanSource, type ScannedSource, type SourceFile } from './source-scan.js';

/** `src/**` の TypeScript のファイル（1回だけ列挙して読み込み、走査したもの）。 */
const SOURCE_FILES: readonly SourceFile[] = loadSourceFiles();

// ---------------------------------------------------------------------------------------------------------------
// 検出の関数（近似。誤検知は、除外の一覧に理由を付けて加える）
// ---------------------------------------------------------------------------------------------------------------

/**
 * 16進数の色（設計書 6.1.7）: `#` の直後に16進数の3・4・6・8桁が続き、その後に識別子の文字が続かない。
 * private フィールド（`#name`）を誤って検出しないため、この形に限る。
 */
const HEX_COLOR_PATTERN = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9A-Za-z_$])/u;
/** 色の関数（`rgb(`、`rgba(`、`hsl(`、`hsla(`）。CSS の関数の名前は大文字と小文字を区別しない。 */
const COLOR_FUNCTION_PATTERN = /\b(?:rgba?|hsla?)\(/iu;

/** 色の値を含む行（1始まりの行番号と、その行）の一覧。 */
const findColorValues = (content: string): readonly string[] =>
  content
    .split('\n')
    .flatMap((line, index) =>
      HEX_COLOR_PATTERN.test(line) || COLOR_FUNCTION_PATTERN.test(line) ? [`${index + 1}: ${line.trim()}`] : [],
    );

/**
 * 文字列リテラル（`'…'`、`"…"`、`` `…` ``）の一覧。`source-scan.ts` の走査が分けた `wholeLiterals` を使う（CC-030。コメントの中は含まない）。
 * - 引用符を含めて書いたままの形である。テンプレートは、`${…}` で分けた固定の部分ごとではなく、1つのリテラルとして判定する
 *   （規則を広げない）。`${…}` の式は `${}` に置き換えてある。
 * - 式の中の文字列リテラルと、入れ子のテンプレートは、それぞれ1つのリテラルとして判定する（R18 の M4）。
 */
const stringLiteralsOf = (source: ScannedSource): readonly string[] => source.wholeLiterals;
/** HTML のタグ（開始、終了、`<!DOCTYPE`）。 */
const HTML_TAG_PATTERN = /<\/?[A-Za-z][A-Za-z0-9-]*(?:[\s/>]|$)|<!doctype/iu;

/** HTML のタグを含む文字列リテラルの一覧。 */
const findHtmlTagLiterals = (source: ScannedSource): readonly string[] =>
  stringLiteralsOf(source).filter((literal) => HTML_TAG_PATTERN.test(literal));

/**
 * GATE-UI01 の値（設計書 6.1.7: Run Status、Severity、各種 Status）。表示面のコードは、これらの値を文字列リテラルで書かずに、
 * カタログか core の一覧と関数を使う。
 */
const STATUS_VALUE_LITERALS: ReadonlySet<string> = new Set([
  ...RUN_STATUSES,
  ...PAGE_AUDIT_STATUSES,
  ...SEVERITIES,
  ...INTERACTION_STATUSES,
]);

/**
 * 状態や severity の値そのものである文字列リテラル（`'ERROR'`、`"COMPLETE"`、`` `SKIPPED` `` など）の一覧。
 * `${…}` を含むテンプレートは、`${}` を含むので、値そのものにはならない（固定の部分ごとには比べない）。
 */
const findStatusValueLiterals = (source: ScannedSource): readonly string[] =>
  stringLiteralsOf(source).filter((literal) => STATUS_VALUE_LITERALS.has(literal.slice(1, -1)));

/** `a.b.c` の形の式（`?.` を含む）で、末尾が `.severity` か `.category` のもの。 */
const SEVERITY_OR_CATEGORY_ACCESS = String.raw`[\w$]+(?:\??\.[\w$]+)*\??\.(?:severity|category)\b`;

/**
 * GATE-UI04 の表示用の集計（設計書 6.1.7: Finding を severity や category で数えたり分けたりする処理）の、近似の検出。
 * - `.severity` か `.category` との比較（`===`、`!==`、`==`、`!=`）
 * - `.severity` か `.category` を鍵にした添字（`counts[finding.severity]` など）
 * - `.severity` か `.category` の、集合・配列・表への所属の確認（`includes(…)`、`has(…)`、`get(…)`）
 * - `.severity` か `.category` による `switch`
 * - `Object.groupBy`、`Map.groupBy`
 * - 分割代入で `severity` か `category` を取り出す、アロー関数の引数（`({ severity }) =>`）と `for … of`
 *   （`for (const { severity } of …)`）。取り出した値での数え直しを、名前で追えないため、取り出すこと自体を検出する（R16f。設計書 6.1.11）。
 * - 文字列の鍵での参照（`x['severity']`、`x["category"]`、`` x[`severity`] ``。R16f）
 */
/** 入れ子の波括弧を含まない、オブジェクトの分割代入（`{ … }`）の中に、`severity` か `category` の名前がある。 */
const DESTRUCTURED_SEVERITY_OR_CATEGORY = String.raw`\{[^{}()]*\b(?:severity|category)\b[^{}()]*\}`;
const DISPLAY_AGGREGATION_PATTERNS: readonly RegExp[] = [
  /\.(?:severity|category)\b\s*[!=]==?/gu,
  new RegExp(String.raw`[!=]==?\s*${SEVERITY_OR_CATEGORY_ACCESS}`, 'gu'),
  new RegExp(String.raw`\[\s*${SEVERITY_OR_CATEGORY_ACCESS}\s*\]`, 'gu'),
  new RegExp(String.raw`\.(?:includes|has|get)\(\s*${SEVERITY_OR_CATEGORY_ACCESS}\s*\)`, 'gu'),
  new RegExp(String.raw`\bswitch\s*\(\s*${SEVERITY_OR_CATEGORY_ACCESS}\s*\)`, 'gu'),
  /\b(?:Object|Map)\.groupBy\s*\(/gu,
  // `({ severity }) =>`、`({ severity }: Finding) =>`、`({ severity }): boolean =>`
  new RegExp(String.raw`\(\s*${DESTRUCTURED_SEVERITY_OR_CATEGORY}\s*(?::[^()=]*)?\)\s*(?::[^()=]*)?=>`, 'gu'),
  // `for (const { severity } of …)`
  new RegExp(String.raw`\bfor\s*\(\s*(?:const|let|var)\s+${DESTRUCTURED_SEVERITY_OR_CATEGORY}\s+of\b`, 'gu'),
  // `x['severity']`、`x?.["category"]`
  /\[\s*(['"`])(?:severity|category)\1\s*\]/gu,
];

/** 表示用の集計にあたる式の一覧（コメントを除いた本文 `code` から）。 */
const findDisplayAggregations = (source: ScannedSource): readonly string[] =>
  DISPLAY_AGGREGATION_PATTERNS.flatMap((pattern) => [...source.code.matchAll(pattern)].map((match) => match[0].trim()));

/** 日本語の文字（ひらがな・カタカナ・漢字）。 */
const JAPANESE_CHARACTER_PATTERN = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;

/** 日本語の文字を含む文字列リテラルの一覧（GATE-UI06）。 */
const findJapaneseLiterals = (source: ScannedSource): readonly string[] =>
  stringLiteralsOf(source).filter((literal) => JAPANESE_CHARACTER_PATTERN.test(literal));

/**
 * 一覧の区切りの `、` で文字列を連ねる式（`.join('、')`、`.join("、")`、`` .join(`、`) ``）の一覧（コメントを除いた本文から。C17a、CC-016）。
 * 一覧の文言の書式は、`src/presentation/messages.ts` の `listText`・`truncatedListText` だけが持つ。
 */
const LIST_SEPARATOR_JOIN_PATTERN = /\.join\(\s*(['"`])、\1\s*\)/gu;
const findListSeparatorJoins = (source: ScannedSource): readonly string[] =>
  [...source.code.matchAll(LIST_SEPARATOR_JOIN_PATTERN)].map((match) => match[0]);

/**
 * `src/orchestration/**` を指す import の指定子（設計書 6.1.8: report は orchestration を import しない）の一覧。
 * import の指定子は、`source-scan.ts` の `findImportSpecifiers` で、コメントを除いた本文 `code` から取り出す。
 */
const ORCHESTRATION_SPECIFIER_PATTERN = /(?:^|\/)orchestration\//u;
const findOrchestrationImports = (source: ScannedSource): readonly string[] =>
  findImportSpecifiers(source.code).filter((specifier) => ORCHESTRATION_SPECIFIER_PATTERN.test(specifier));

// ---------------------------------------------------------------------------------------------------------------
// 対象と除外
// ---------------------------------------------------------------------------------------------------------------

/** GATE-UI02 の除外（設計書 6.1.7）。 */
const UI02_EXCLUDED_FILES: ReadonlyMap<string, string> = new Map([
  ['src/evidence/color-collector.ts', 'ページから取った色の値を扱う'],
  ['src/report/html-tokens.ts', '色の値を定義する唯一のファイル'],
]);

/** GATE-UI03 の除外（UI追補設計書 6.1）。 */
const UI03_EXCLUDED_FILES: ReadonlyMap<string, string> = new Map([
  ['src/report/html-components.ts', 'HTML の部品の唯一のファイル'],
]);

/** GATE-UI01 の対象（`src/report/**`、`src/cli/**`。UI追補設計書 6.1）。 */
const UI01_TARGET_DIRECTORIES: readonly string[] = ['src/report/', 'src/cli/'];

/** GATE-UI01 の除外（UI追補設計書 6.1）。 */
const UI01_EXCLUDED_FILES: ReadonlyMap<string, string> = new Map([
  ['src/cli/exit-codes.ts', 'Run Status から終了コードへの対応表の、唯一のファイル'],
]);

/** GATE-UI06 の除外（UI追補設計書 6.1）。`src/audit/*-rules.ts`（Rule の定義）は、`UI06_RULE_FILE_PATTERN` で除く。 */
const UI06_EXCLUDED_FILES: ReadonlyMap<string, string> = new Map([
  ['src/presentation/messages.ts', '利用者向けの文言の唯一のファイル'],
  ['src/presentation/catalog.ts', '表示用語彙の唯一のファイル'],
]);

/** GATE-UI06 の除外の、Rule の定義のファイル（Finding の `message` は Rule が持つ）。 */
const UI06_RULE_FILE_PATTERN = /^src\/audit\/[^/]+-rules\.ts$/u;

/** 一覧の文言の書式の owner（C17a、CC-016）。 */
const LIST_TEXT_OWNER_FILE = 'src/presentation/messages.ts';

/** GATE-UI04 の owner（表示用モデルの組み立ての、唯一のファイル）。 */
const UI04_OWNER_FILE = 'src/report/view-model.ts';

/**
 * GATE-UI04 の検出のうち、Finding の表示用の集計ではないもの（`<ファイル>: <検出した式>`）。近似の検出の誤検知として、理由を付けて除外する。
 */
const UI04_ALLOWED_MATCHES: ReadonlyMap<string, string> = new Map([
  ['src/audit/rule-engine.ts: !== owner.category', 'Rule の下書きの category が、持ち主の Rule の定義と一致するかの検査（表示ではない）'],
  ['src/evidence/performance-collector.ts: .category ===', 'Resource Timing の種類（Finding の category ではない）'],
  ['src/evidence/performance-collector.ts: [resource.category]', 'Resource Timing の種類ごとの集計（Finding の category ではない）'],
  ['src/safety/passive-request-guard.ts: .category ===', 'HTTP の安全判定の区分（Finding の category ではない）'],
  ['src/safety/passive-request-guard.ts: .category !==', 'WebSocket の安全判定の区分（Finding の category ではない）'],
  [
    'src/audit/layout-rules.ts: ({ ruleId, severity, message, evidenceId, identityFields }: LayoutDraftSpec): FindingDraft =>',
    'Layout の Rule が、Finding の下書きを組み立てるときに、Rule の定義の severity をそのまま写す（数えたり分けたりしない。R16f）',
  ],
]);

describe('UI Gate detectors', () => {
  it('detect hexadecimal colours of 3, 4, 6 and 8 digits and colour functions', () => {
    for (const line of ["const a = '#fff';", 'color: #FFFFFF;', "'#0a0b0c80'", "'#abcd'", 'rgb(0, 0, 0)', 'RGBA(1,2,3,0.5)', 'hsl(1 2% 3%)', 'hsla(1, 2%, 3%, 1)']) {
      expect(findColorValues(line), line).toHaveLength(1);
    }
  });

  it('do not mistake private fields, ids or other words for colours', () => {
    for (const line of ['this.#field = 1;', 'this.#abcdefgh();', '#ab', '#abcde', '#abcdef0', 'issue #12345', 'surgery(', 'ghrgb(']) {
      expect(findColorValues(line), line).toHaveLength(0);
    }
  });

  it('detect string literals that contain HTML tags, and ignore comments and generics', () => {
    expect(findHtmlTagLiterals(scanSource("const a = '<div>';"))).toHaveLength(1);
    expect(findHtmlTagLiterals(scanSource('const a = `<a href="${x}">`;'))).toHaveLength(1);
    expect(findHtmlTagLiterals(scanSource('const a = "</td>";'))).toHaveLength(1);
    expect(findHtmlTagLiterals(scanSource("const a = '<!DOCTYPE html>';"))).toHaveLength(1);
    expect(findHtmlTagLiterals(scanSource('const a: Readonly<Record<string, number>> = {};'))).toHaveLength(0);
    expect(findHtmlTagLiterals(scanSource('// returns <html lang="ja">\nconst a = 1;'))).toHaveLength(0);
    expect(findHtmlTagLiterals(scanSource('/** `<table>` */\nconst a = 1 < 2;'))).toHaveLength(0);
    expect(findHtmlTagLiterals(scanSource("const a = 'a < b';"))).toHaveLength(0);
  });

  it('detect string literals that are status or severity values, and ignore comments and other strings', () => {
    for (const line of ["if (s === 'ERROR') {}", 'const a = "COMPLETE";', 'const a = `SKIPPED`;', "x('NOT_VERIFIABLE')", "const g = 'SAFETY';"]) {
      expect(findStatusValueLiterals(scanSource(line)), line).toHaveLength(1);
    }
    for (const line of ["// 'ERROR'", "/** `'COMPLETE'` */", "const a = 'ERRORS';", "const a = 'critical';", "const a = 'error';"]) {
      expect(findStatusValueLiterals(scanSource(line)), line).toHaveLength(0);
    }
  });

  it('detect counting or grouping by severity or category, and ignore only reading them', () => {
    for (const line of [
      "if (finding.severity === 'ERROR') {}",
      "findings.filter((f) => f.category !== 'LINK');",
      'const same = SEVERITY === finding.severity;',
      'counts[finding.severity] += 1;',
      'bySection[f.finding.category].push(f);',
      'CRITICAL.has(finding.severity);',
      'categories.includes(finding?.category)',
      'switch (finding.severity) {}',
      'Object.groupBy(findings, (f) => f.category);',
      'Map.groupBy(findings, key);',
      // R16f（設計書 6.1.11）: 分割代入の形と、文字列の鍵の添字。
      'findings.filter(({ severity }) => CRITICAL.has(severity));',
      'findings.map(({ category }) => category);',
      'findings.filter(({ findingId, severity: level }) => level);',
      'findings.filter(({ severity }: Finding) => severity);',
      'findings.filter(({ severity }): boolean => true);',
      'for (const { severity } of findings) { counts.set(severity, 1); }',
      'for (let { category, message } of findings) {}',
      "counts[finding['severity']] += 1;",
      'const key = finding["category"];',
      'const key = finding?.[`severity`];',
    ]) {
      expect(findDisplayAggregations(scanSource(line)), line).toHaveLength(1);
    }
    for (const line of [
      'renderSeverityBadge(finding.severity)',
      'const label = FINDING_CATEGORY_CATALOG[category].label;',
      'category: rule.category,',
      '// finding.severity === x',
      'const severityOrder = 1;',
      // R16f: 分割代入でない引数と、severity・category でない名前の分割代入と文字列の鍵は、検出しない。
      'reasons.map(({ code, detail }) => ({ code, detail }));',
      'for (const { severityOrder } of rows) {}',
      'for (const [severity, count] of entries) {}',
      "const label = map['severityLabel'];",
      '// for (const { severity } of findings) {}',
    ]) {
      expect(findDisplayAggregations(scanSource(line)), line).toHaveLength(0);
    }
  });

  it('detect string literals that contain Japanese, and ignore comments and other strings', () => {
    for (const line of [
      "const a = '設定のエラー';",
      'const a = "ひらがな";',
      'const a = `カタカナ ${x}`;',
      "throw new Error(`failed: ${'漢字'}`);",
      "x('a', 'b', 'テスト');",
    ]) {
      expect(findJapaneseLiterals(scanSource(line)), line).toHaveLength(1);
    }
    for (const line of [
      '// 日本語のコメント',
      '/** 日本語の説明 `例`。 */',
      "const a = 'configuration error'; // 設定のエラー",
      "/* 'ブロック' */ const a = 'x';",
      "const a = '、。「」（）';",
    ]) {
      expect(findJapaneseLiterals(scanSource(line)), line).toHaveLength(0);
    }
  });

  it('detect joining with the list separator, and ignore comments, other separators and the separator inside a sentence', () => {
    for (const line of [
      "const a = values.join('、');",
      'const a = values.join("、");',
      'const a = values.join(`、`);',
      "const a = distinctSorted(values).join( '、' );",
    ]) {
      expect(findListSeparatorJoins(scanSource(line)), line).toHaveLength(1);
    }
    for (const line of [
      "// values.join('、')",
      "/** `values.join('、')` */",
      "const a = values.join(', ');",
      "const a = values.join('、 ');",
      'const a = `（URL: ${url}、理由: ${reason}）`;',
      'const a = listText(values);',
    ]) {
      expect(findListSeparatorJoins(scanSource(line)), line).toHaveLength(0);
    }
  });

  // DEF-011: 文字列の中の `/*` や `//` を、コメントの始まりとみなして、その後ろのコードを消してはならない。
  it('keep checking the code after a string literal that contains /* or // (DEF-011)', () => {
    const source = [
      "await context.route('**/*', handler);",
      "const a = values.join('、');",
      "const b = '設定のエラー';",
      "const c = 'http://x//y'; const d = items.join('、');",
      "if (finding.severity === 'ERROR') {}",
      "const e = '<div>';",
      "import { x } from '../orchestration/run-coordinator.js';",
      '/** 説明 */',
      "const f = values.join('、');",
    ].join('\n');

    expect(findListSeparatorJoins(scanSource(source))).toHaveLength(3);
    expect(findJapaneseLiterals(scanSource(source))).toEqual(["'設定のエラー'"]);
    expect(findDisplayAggregations(scanSource(source))).toEqual(['.severity ===']);
    expect(findStatusValueLiterals(scanSource(source))).toEqual(["'ERROR'"]);
    expect(findHtmlTagLiterals(scanSource(source))).toEqual(["'<div>'"]);
    expect(findOrchestrationImports(scanSource(source))).toEqual(['../orchestration/run-coordinator.js']);
  });

  // CC-030（R18 の M4）: 文字列リテラルは、`source-scan.ts` の走査で分けたものを使う。入れ子のテンプレートと、正規表現のリテラルの中の
  // 引用符を、取り違えない。
  it('take string literals from the source scan, including templates nested in a template substitution (CC-030)', () => {
    // `src/report/html-components.ts` の書き方（R18 の M4）。外側と内側のテンプレートを、それぞれ1つのリテラルとして扱う。
    const nested = "return trustedRow(`<tr${idAttribute}>${cells.map((cell) => `<td>${contentHtml(cell)}</td>`).join('')}</tr>`);";
    expect(findHtmlTagLiterals(scanSource(nested))).toEqual(['`<td>${}</td>`', '`<tr${}>${}</tr>`']);
    expect(findHtmlTagLiterals(scanSource('const a = `${items.map((item) => `<li>${item}</li>`).join(\'\')}`;')))
      .toEqual(['`<li>${}</li>`']);
    expect(findJapaneseLiterals(scanSource('const a = `${rows.map((row) => `${row}件`).join(\'\')}`;'))).toEqual(['`${}件`']);
    // 正規表現のリテラルの中の引用符を、文字列の始まりとみなさない。
    expect(findHtmlTagLiterals(scanSource("const r = /'/u; const s = '<div>';"))).toEqual(["'<div>'"]);
    expect(findStatusValueLiterals(scanSource("const r = /[\"']/u; const s = 'ERROR';"))).toEqual(["'ERROR'"]);
    // 置き換えの式の中の文字列リテラルも、1つのリテラルとして調べる。
    expect(findStatusValueLiterals(scanSource("const a = `${x === 'ERROR' ? a : b}`;"))).toEqual(["'ERROR'"]);
  });

  it('keep each string literal whole in the source scan (CC-030)', () => {
    expect(scanSource("const a = 'x' + \"y\"; // 'z'\nconst b = `t${f('u', `v${w}`)}s`;").wholeLiterals)
      .toEqual(["'x'", '"y"', "'u'", '`v${}`', '`t${}s`']);
    expect(scanSource('const a = /`/u; const b = `c`;').wholeLiterals).toEqual(['`c`']);
    // 閉じていないリテラルも、閉じる引用符なしで並べる。
    expect(scanSource("const a = 'x\nconst b = `y${z").wholeLiterals).toEqual(["'x", '`y${}']);
  });

  // CC-030: テンプレートは、`${…}` で分けた固定の部分ごとではなく、1つのリテラルとして判定する（規則を広げない）。
  it('judge a template as a whole, not each fixed part between substitutions (CC-030)', () => {
    for (const line of ['const a = `${prefix}ERROR`;', 'const a = `COMPLETE${suffix}`;', 'const a = `${a}SKIPPED${b}`;']) {
      expect(findStatusValueLiterals(scanSource(line)), line).toHaveLength(0);
    }
    // 置き換えの直前で終わるタグの名前は、タグとみなさない（前の取り出しと同じ）。
    for (const line of ['const a = `<td${attributes}>`;', 'const a = `<${tag}>`;']) {
      expect(findHtmlTagLiterals(scanSource(line)), line).toHaveLength(0);
    }
  });

  it('detect imports of src/orchestration/**, and ignore comments and other modules', () => {
    for (const line of [
      "import { x } from '../orchestration/run-coordinator.js';",
      'import type { Y } from "../orchestration/page-auditor.js";',
      "export { z } from '../orchestration/run-id.js';",
      "import '../orchestration/side-effect.js';",
      "const m = await import('../orchestration/lazy.js');",
      "import {\n  a,\n  b,\n} from '../../src/orchestration/id-allocator.js';",
    ]) {
      expect(findOrchestrationImports(scanSource(line)), line).toHaveLength(1);
    }
    for (const line of [
      "import { x } from '../core/artifact-layout.js';",
      "import { y } from '../presentation/orchestration-labels.js';",
      "// import { x } from '../orchestration/run-coordinator.js';",
      "/** `from '../orchestration/run-coordinator.js'` */",
      "const text = 'orchestration/';",
    ]) {
      expect(findOrchestrationImports(scanSource(line)), line).toHaveLength(0);
    }
  });
});

describe('UI Gate', () => {
  it('reads the source files once', () => {
    expect(SOURCE_FILES.length).toBeGreaterThan(0);
    expect(SOURCE_FILES.some((file) => file.path === 'src/report/html-components.ts')).toBe(true);
  });

  it('GATE-UI01: status and severity literals are not written in src/report/** and src/cli/** (except src/cli/exit-codes.ts)', () => {
    for (const excluded of UI01_EXCLUDED_FILES.keys()) {
      expect(SOURCE_FILES.some((file) => file.path === excluded), excluded).toBe(true);
    }
    const targetFiles = SOURCE_FILES.filter(
      (file) => UI01_TARGET_DIRECTORIES.some((directory) => file.path.startsWith(directory)) && !UI01_EXCLUDED_FILES.has(file.path),
    );
    for (const expected of ['src/report/view-model.ts', 'src/report/artifact-writer.ts', 'src/report/html-components.ts', 'src/cli/index.ts']) {
      expect(targetFiles.some((file) => file.path === expected), expected).toBe(true);
    }
    const violations = targetFiles.flatMap((file) =>
      findStatusValueLiterals(file).map((literal) => `${file.path}: ${literal}`),
    );
    expect(violations).toEqual([]);
  });

  it('GATE-UI02: colour values are written only in the token file (and the excluded collector)', () => {
    for (const excluded of UI02_EXCLUDED_FILES.keys()) {
      expect(SOURCE_FILES.some((file) => file.path === excluded), excluded).toBe(true);
    }
    const violations = SOURCE_FILES.filter((file) => !UI02_EXCLUDED_FILES.has(file.path)).flatMap((file) =>
      findColorValues(file.content).map((line) => `${file.path}:${line}`),
    );
    expect(violations).toEqual([]);
  });

  it('GATE-UI03: HTML tags are written in string literals only in the component file (src/report/**)', () => {
    const reportFiles = SOURCE_FILES.filter((file) => file.path.startsWith('src/report/'));
    expect(reportFiles.length).toBeGreaterThan(0);
    const violations = reportFiles
      .filter((file) => !UI03_EXCLUDED_FILES.has(file.path))
      .flatMap((file) => findHtmlTagLiterals(file).map((literal) => `${file.path}: ${literal}`));
    expect(violations).toEqual([]);
  });

  it('GATE-UI04: Findings are counted or grouped by severity or category only in src/report/view-model.ts', () => {
    expect(SOURCE_FILES.some((file) => file.path === UI04_OWNER_FILE), UI04_OWNER_FILE).toBe(true);
    const violations = SOURCE_FILES.filter((file) => file.path !== UI04_OWNER_FILE)
      .flatMap((file) => findDisplayAggregations(file).map((match) => `${file.path}: ${match}`))
      .filter((violation) => !UI04_ALLOWED_MATCHES.has(violation));
    expect(violations).toEqual([]);
  });

  it('GATE-UI05: the display catalogs have every value of the core lists', () => {
    const catalogs: readonly (readonly [readonly string[], Readonly<Record<string, { readonly label: string; readonly tone: string }>>])[] = [
      [SEVERITIES, SEVERITY_CATALOG],
      [RUN_STATUSES, RUN_STATUS_CATALOG],
      [PAGE_AUDIT_STATUSES, PAGE_AUDIT_STATUS_CATALOG],
      [INTERACTION_STATUSES, INTERACTION_STATUS_CATALOG],
      [INTERACTION_NOT_VERIFIABLE_KINDS, INTERACTION_NOT_VERIFIABLE_KIND_CATALOG],
      [FINDING_CATEGORIES, FINDING_CATEGORY_CATALOG],
      [EVIDENCE_TYPES, EVIDENCE_TYPE_CATALOG],
      [VIEWPORT_PROFILES, VIEWPORT_PROFILE_CATALOG],
      [SAFETY_EVENT_KINDS, SAFETY_EVENT_KIND_CATALOG],
    ];
    for (const [values, catalog] of catalogs) {
      expect(Object.keys(catalog).sort()).toEqual([...values].sort());
      for (const value of values) {
        expect(catalog[value]?.label.trim(), value).not.toBe('');
        expect(DISPLAY_TONES, value).toContain(catalog[value]?.tone);
      }
    }
  });

  it('GATE-UI05: the formatters never show a value that was not observed as 0 or an empty string', () => {
    const notObserved = formatNotObserved();
    expect(notObserved.trim()).not.toBe('');
    expect(notObserved).not.toMatch(/^0/u);
    for (const text of [formatDuration(null), formatBytes(null), formatCount(null), formatInteger(null), formatDateTime(null)]) {
      expect(text).toBe(notObserved);
    }
    for (const text of [formatDuration(0), formatBytes(0), formatCount(0), formatInteger(0)]) {
      expect(text).not.toBe(notObserved);
      expect(text).toMatch(/^0/u);
    }
  });

  it('src/report/** does not import src/orchestration/** (design 6.1.8: the report does not load Playwright)', () => {
    const reportFiles = SOURCE_FILES.filter((file) => file.path.startsWith('src/report/'));
    for (const expected of ['src/report/view-model.ts', 'src/report/artifact-writer.ts']) {
      expect(reportFiles.some((file) => file.path === expected), expected).toBe(true);
    }
    const violations = reportFiles.flatMap((file) =>
      findOrchestrationImports(file).map((specifier) => `${file.path}: ${specifier}`),
    );
    expect(violations).toEqual([]);
  });

  it('GATE-UI06: Japanese is written in string literals only in the message and display catalogs and the rule files', () => {
    for (const excluded of UI06_EXCLUDED_FILES.keys()) {
      expect(SOURCE_FILES.some((file) => file.path === excluded), excluded).toBe(true);
    }
    expect(SOURCE_FILES.some((file) => UI06_RULE_FILE_PATTERN.test(file.path))).toBe(true);
    // 除外したファイルは、日本語の文言を実際に持つ（検出の関数が、実際のファイルで働くことの確かめ）。
    const messages = SOURCE_FILES.find((file) => file.path === 'src/presentation/messages.ts');
    expect(findJapaneseLiterals(messages ?? scanSource('')).length).toBeGreaterThan(0);
    const violations = SOURCE_FILES.filter((file) => !UI06_EXCLUDED_FILES.has(file.path) && !UI06_RULE_FILE_PATTERN.test(file.path))
      .flatMap((file) => findJapaneseLiterals(file).map((literal) => `${file.path}: ${literal}`));
    expect(violations).toEqual([]);
  });

  it('CC-016: values are joined with the list separator only in the message catalog (listText and truncatedListText)', () => {
    const owner = SOURCE_FILES.find((file) => file.path === LIST_TEXT_OWNER_FILE);
    // owner は、実際に区切りで連ねている（検出の関数が、実際のファイルで働くことの確かめ）。
    expect(findListSeparatorJoins(owner ?? scanSource('')).length).toBeGreaterThan(0);
    const violations = SOURCE_FILES.filter((file) => file.path !== LIST_TEXT_OWNER_FILE).flatMap((file) =>
      findListSeparatorJoins(file).map((match) => `${file.path}: ${match}`),
    );
    expect(violations).toEqual([]);
  });
});
