/**
 * GATE-ARCH02〜08 Semantic Ownership（実装タスク指示 第5章・第10章、Task 18 の設計書 4.4）。
 * - `src/**` の読み込みは、このファイルの読み込み時に1回だけ行い、各検査で共有する。
 * - 判定は、`fs`、正規表現、文字列の走査だけで行う（AST・TypeScript のコンパイラ API・外部ツール・子プロセス・`dist/` を使わない）。
 * - 近似の検査である。誤検知は、下の `EXCLUSIONS` に理由を付けて加える（除外の一覧は、このファイルの中の1か所だけ）。
 */
import { describe, expect, it } from 'vitest';
import { RUN_STATUSES } from '../../src/core/contracts.js';
import {
  countIdentifier,
  findCallSites,
  findImportSpecifiers,
  loadSourceFiles,
  scanSource,
  splitTopLevelArguments,
  type ScannedSource,
  type SourceFile,
} from './source-scan.js';

const SOURCE_FILES = loadSourceFiles();

// ---------------------------------------------------------------------------------------------------------------
// 検出の関数（近似）
// ---------------------------------------------------------------------------------------------------------------

/** `patterns` のそれぞれに一致した式の一覧（前後の空白を除く）。 */
const matchesOf = (text: string, patterns: readonly RegExp[]): readonly string[] =>
  patterns.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[0].trim()));

/** `name(…)` の呼び出しを、`name(` の形で返す（コメントと文字列の中は数えない）。 */
const callsOf = (source: ScannedSource, name: string): readonly string[] => findCallSites(source.bare, name).map(() => `${name}(`);

/** 指定子の最後の部分（拡張子 `.js`・`.ts` を除く）が `pattern` に一致する import の指定子。 */
const importsMatching = (source: ScannedSource, pattern: RegExp): readonly string[] =>
  findImportSpecifiers(source.code).filter((specifier) => pattern.test(specifier.replace(/\.[cm]?[jt]s$/u, '').split('/').at(-1) ?? ''));

/** ARCH02: `loadConfig(…)` の呼び出し。 */
const findLoadConfigCalls = (source: ScannedSource): readonly string[] => callsOf(source, 'loadConfig');

/** ARCH02: `load-config` の import。 */
const findLoadConfigImports = (source: ScannedSource): readonly string[] => importsMatching(source, /^load-config$/u);

/**
 * ARCH03: anchor と href の抽出にあたる式（`code`。文字列の中を含む）。
 * - `getAttribute('href')`、セレクタの `a[href`、`document.links`、`getElementsByTagName('a')`、
 *   `querySelector(All)`・`locator`・`$`・`$$`・`closest`・`matches` の `'a'`、`HTMLAnchorElement`
 */
const LINK_EXTRACTION_PATTERNS: readonly RegExp[] = [
  /\bgetAttribute\s*\(\s*(['"`])href\1\s*\)/gu,
  /(?<![\w$<-])a\[href\b/gu,
  /\bdocument\s*\.\s*links\b/gu,
  /\bgetElementsByTagName\s*\(\s*(['"`])a\1\s*\)/giu,
  /(?<![\w$])(?:querySelectorAll|querySelector|locator|closest|matches|\$\$|\$)\s*\(\s*(['"`])a\1\s*\)/gu,
  /\bHTMLAnchorElement\b/gu,
];
const findLinkExtractions = (source: ScannedSource): readonly string[] => matchesOf(source.code, LINK_EXTRACTION_PATTERNS);

/** ARCH03: Link の抽出の入口（`discover-links` の import と、`discoverLinks` の参照）。 */
const findLinkDiscoveryReferences = (source: ScannedSource): readonly string[] => [
  ...importsMatching(source, /^discover-links$/u),
  ...Array.from({ length: countIdentifier(source.bare, 'discoverLinks') }, () => 'discoverLinks'),
];

/** ARCH03: `link` の Evidence（`…EvidenceOfType(…, 'link', …)`）を選び、その `links` を読んでいるか。 */
const readsLinkEvidence = (source: ScannedSource): boolean =>
  /EvidenceOfType\s*\([^()]*(['"`])link\1/u.test(source.code) && /\.\s*links\b/u.test(source.bare);

/**
 * ARCH04: URL の正規化にあたる式（近似）。
 * - URL の部分への代入（`.hash =`、`.search =`、`.pathname =`、`.hostname =`、`.host =`、`.protocol =`、`.port =`、`.username =`、`.password =`）
 * - query の組み替え（`searchParams.delete|set|append|sort(`、`new URLSearchParams(`）
 * - 部分からの組み立て（`${….protocol}//`、`.protocol + '//'`、`${….origin}${….pathname}`）
 * - fragment の切り落とし（`.split('#')`、`.replace(/#…`）
 * - ホスト名の小文字化（`.hostname|host|origin.toLowerCase(`）
 */
const URL_NORMALIZATION_BARE_PATTERNS: readonly RegExp[] = [
  /\.\s*(?:hash|search|pathname|hostname|host|protocol|port|username|password)\s*=(?![=>])/gu,
  /\bsearchParams\s*\.\s*(?:delete|set|append|sort)\s*\(/gu,
  /\bnew\s+URLSearchParams\s*\(/gu,
  /\.\s*(?:hostname|host|origin)\s*\.\s*toLowerCase\s*\(/gu,
];
const URL_NORMALIZATION_CODE_PATTERNS: readonly RegExp[] = [
  /\.protocol\s*\}\s*\/\//gu,
  /\.protocol\s*\+\s*(['"`])\/\//gu,
  /\.(?:origin|host)\s*\}\s*\$\{[^}]*\.pathname\b/gu,
  /\.split\s*\(\s*(['"`])#\1\s*\)/gu,
  /\.replace\s*\(\s*\/#/gu,
];
const findUrlNormalizations = (source: ScannedSource): readonly string[] => [
  ...matchesOf(source.bare, URL_NORMALIZATION_BARE_PATTERNS),
  ...matchesOf(source.code, URL_NORMALIZATION_CODE_PATTERNS),
];

/**
 * ARCH04: URL の受け入れの判定にあたる式（近似）。
 * - Origin の集合・配列への所属の確認: メソッドの呼び出し `.has(…)`・`.includes(…)`（`?.` を含む）で、引数に `origin` の語
 *   （大文字と小文字を区別しない）を含むもの。引数が式や呼び出しでもよい（`.has(new URL(url).origin)`、`.has(originOf(url))`。R18 の M1）。
 *   検出した式は `.has(<引数>)` の形で返す（引数の中の空白の並びは、1つの空白にまとめる）。
 * - Origin の比較（`.origin ===`、`!== x.origin` など）
 */
const ORIGIN_MEMBERSHIP_METHODS: readonly string[] = ['has', 'includes'];
const ORIGIN_WORD = /origin/iu;
/** 直前が `.` か `?.` である（メソッドの呼び出し。関数の呼び出しとメソッドの定義を除く）。 */
const MEMBER_ACCESS_BEFORE = /\??\.\s*$/u;
const URL_ADMISSION_PATTERNS: readonly RegExp[] = [
  /\.origin\s*[!=]==?/gu,
  /[!=]==?\s*[\w$.?]+\.origin\b/gu,
];
const findOriginMemberships = (source: ScannedSource): readonly string[] =>
  ORIGIN_MEMBERSHIP_METHODS.flatMap((method) =>
    findCallSites(source.bare, method)
      .filter(({ index, argumentText }) =>
        MEMBER_ACCESS_BEFORE.test(source.bare.slice(Math.max(0, index - 8), index)) && ORIGIN_WORD.test(argumentText))
      .map(({ argumentText }) => `.${method}(${argumentText.replace(/\s+/gu, ' ').trim()})`));
const findUrlAdmissions = (source: ScannedSource): readonly string[] => [
  ...findOriginMemberships(source),
  ...matchesOf(source.bare, URL_ADMISSION_PATTERNS),
];

/** ARCH05: `deriveRunStatus(…)` の呼び出し。 */
const findRunStatusDerivations = (source: ScannedSource): readonly string[] => callsOf(source, 'deriveRunStatus');

const RUN_STATUS_ASSIGNMENT_PATTERN = /(?<![\w$])runStatus\s*\??\s*(?::|=(?![=>]))\s*([^,;\n)}]*)/gu;
/** Run Status の値（`RUN_STATUSES`）。 */
const RUN_STATUS_VALUES: ReadonlySet<string> = new Set(RUN_STATUSES);
/** `runStatus` に入れてよい値: `deriveRunStatus(…)` の結果、決まった Run Status の写し（`….runStatus`）、型の注記（`RunStatus`）。 */
const ALLOWED_RUN_STATUS_VALUES: readonly RegExp[] = [/^deriveRunStatus\s*\(/u, /^[\w$.?]*\.runStatus$/u, /^RunStatus$/u];
/** 文字列リテラル1つだけの値（表示の文言の鍵など）。Run Status の値そのものでなければ、許す。 */
const SINGLE_STRING_LITERAL = /^(['"`])((?:(?!\1)[^\\]|\\.)*)\1$/u;

/**
 * ARCH05: `deriveRunStatus` 以外で Run Status を決めている式（近似。`code` から）。
 * - `runStatus` への代入（`runStatus: …`、`runStatus = …`）で、値が上の許す形でないもの
 * - Run Status を返す関数の宣言（`): RunStatus =>`、`): RunStatus {`）
 * - Run Status への型の読み替え（`as RunStatus`、`satisfies RunStatus`）
 */
const findRunStatusDecisions = (source: ScannedSource): readonly string[] => {
  const assignments = [...source.code.matchAll(RUN_STATUS_ASSIGNMENT_PATTERN)].flatMap((match) => {
    const value = (match[1] ?? '').trim();
    if (ALLOWED_RUN_STATUS_VALUES.some((pattern) => pattern.test(value))) {
      return [];
    }
    const literal = SINGLE_STRING_LITERAL.exec(value);
    if (literal !== null && !RUN_STATUS_VALUES.has(literal[2] ?? '')) {
      return [];
    }
    return [match[0].trim()];
  });
  return [...assignments, ...matchesOf(source.bare, [/\)\s*:\s*RunStatus\s*(?:=>|\{)/gu, /\b(?:as|satisfies)\s+RunStatus\b/gu])];
};

/** ARCH06: `createFindingFingerprint(…)` の呼び出し。 */
const findFingerprintCreations = (source: ScannedSource): readonly string[] => callsOf(source, 'createFindingFingerprint');

const FINGERPRINT_ASSIGNMENT_PATTERN = /(?<![\w$])fingerprint\s*\??\s*(?::|=(?![=>]))\s*([^,;\n)}]*)/gu;
/** `fingerprint` に入れてよい値: `createFindingFingerprint(…)` の結果、作った fingerprint の写し（`….fingerprint`）、型の注記（`string`）。 */
const ALLOWED_FINGERPRINT_VALUES: readonly RegExp[] = [/^createFindingFingerprint\s*\(/u, /^[\w$.?]*\.fingerprint$/u, /^string$/u];

/**
 * ARCH06: fingerprint の組み立てにあたる式（近似）。
 * - ハッシュの計算（`createHash(`、`.digest(`、`subtle.digest(`）
 * - `sha256` を含む文字列リテラル（`'sha256:'` の接頭辞など）
 * - `fingerprint` への代入で、値が上の許す形でないもの
 */
const findFingerprintConstructions = (source: ScannedSource): readonly string[] => [
  ...matchesOf(source.bare, [/(?<![\w$])createHash\s*\(/gu, /\.\s*digest\s*\(/gu]),
  ...source.literals.filter((literal) => /sha-?256/iu.test(literal)).map((literal) => `literal ${JSON.stringify(literal)}`),
  ...[...source.code.matchAll(FINGERPRINT_ASSIGNMENT_PATTERN)]
    .filter((match) => !ALLOWED_FINGERPRINT_VALUES.some((pattern) => pattern.test((match[1] ?? '').trim())))
    .map((match) => match[0].trim()),
];

/** ARCH07: `RULE_CATALOG` の宣言。 */
const findRuleCatalogDeclarations = (source: ScannedSource): readonly string[] =>
  matchesOf(source.bare, [/\b(?:const|let|var)\s+RULE_CATALOG\b/gu]);

/** ARCH07: `RULE_CATALOG` の宣言の、`freezeCatalog([…])` の配列の項目。 */
const findRuleCatalogEntries = (source: ScannedSource): readonly string[] => {
  const declaration = /\b(?:const|let|var)\s+RULE_CATALOG\b/u.exec(source.bare);
  if (declaration === null) {
    return [];
  }
  const rest = source.bare.slice(declaration.index);
  const [site] = findCallSites(rest, 'freezeCatalog');
  const [array] = site === undefined ? [] : splitTopLevelArguments(site.argumentText);
  if (array === undefined || !array.startsWith('[') || !array.endsWith(']')) {
    return [];
  }
  return splitTopLevelArguments(array.slice(1, -1));
};

/** ARCH07: page rule のファイルが公開する Rule の配列（`export const <NAME>_RULES`）の名前。 */
const findPageRuleArrayDeclarations = (source: ScannedSource): readonly string[] =>
  [...source.bare.matchAll(/\bexport\s+const\s+([A-Z][A-Z0-9_]*_RULES)\b/gu)].map((match) => match[1] ?? '');

/** ARCH07: page rule のファイル（`*-rules`。`cross-page-rules` を除く）の import。 */
const findPageRuleFileImports = (source: ScannedSource): readonly string[] =>
  importsMatching(source, /^(?!cross-page-rules$)[\w-]+-rules$/u);

/** ARCH07: `new RuleEngine({ … catalog … })`（Rule Engine に、RULE_CATALOG の代わりの一覧を渡す）。 */
const findRuleEngineCatalogOverrides = (source: ScannedSource): readonly string[] =>
  findCallSites(source.bare, 'RuleEngine')
    .filter((site) => /\bnew\s*$/u.test(source.bare.slice(Math.max(0, site.index - 10), site.index)))
    .filter((site) => /(?<![\w$.])catalog\b/u.test(site.argumentText))
    .map(() => 'new RuleEngine({ catalog })');

/** ARCH07: `evaluateCrossPageRules(…)` の呼び出しと、その引数の数（2つ目の引数は、評価する Rule の一覧の差し替え）。 */
const findCrossPageEvaluations = (source: ScannedSource): readonly string[] =>
  findCallSites(source.bare, 'evaluateCrossPageRules').map((site) => {
    const count = splitTopLevelArguments(site.argumentText).length;
    return `evaluateCrossPageRules(${count} ${count === 1 ? 'argument' : 'arguments'})`;
  });

/** ARCH07: Cross-page rule の定義（`category: 'CROSS_PAGE'`）。 */
const findCrossPageRuleDefinitions = (source: ScannedSource): readonly string[] =>
  matchesOf(source.code, [/\bcategory\s*:\s*(['"`])CROSS_PAGE\1/gu]);

/** ARCH07: Rule の評価の部品（Rule Engine、Rule の一覧、Cross-page の評価、Rule の `evaluate`）への参照。 */
const RULE_EVALUATION_IDENTIFIERS: readonly RegExp[] = [
  /(?<![\w$])(?:RuleEngine|evaluateCrossPageRules|materializeFindingDrafts|RULE_CATALOG|[A-Z][A-Z0-9_]*_RULES)(?![\w$])/gu,
  /\.\s*evaluate\s*\(/gu,
];
const findRuleEvaluationReferences = (source: ScannedSource): readonly string[] => [
  ...importsMatching(source, /^(?:rule-engine|rule-catalog|[\w-]+-rules)$/u),
  ...matchesOf(source.bare, RULE_EVALUATION_IDENTIFIERS),
];

/** ARCH08: `validateArtifact(…)` の呼び出し。 */
const findArtifactValidations = (source: ScannedSource): readonly string[] => callsOf(source, 'validateArtifact');

/** ARCH08: スキーマの検証の部品（Ajv）を直接使う式（`ajv` の import と、`Ajv` の参照）。 */
const findSchemaValidatorUses = (source: ScannedSource): readonly string[] => [
  ...findImportSpecifiers(source.code).filter((specifier) => /^ajv(?:$|[/-])/u.test(specifier)),
  ...matchesOf(source.bare, [/(?<![\w$])Ajv(?![\w$])/gu]),
];

/**
 * ARCH08: ファイルへの書き込み（近似）。
 * - `writeFile`、`writeFileSync`、`appendFile(Sync)`、`createWriteStream`、`rename(Sync)`、`copyFile(Sync)`、`cp(Sync)` の呼び出し
 * - Playwright の、ファイルへの書き出し（`screenshot({ … path: … })`、`pdf({ … path: … })`、`saveAs(`）
 */
const FILE_WRITE_BARE_PATTERNS: readonly RegExp[] = [
  /(?<![\w$])(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|renameSync|rename|copyFileSync|copyFile|cpSync|cp)\s*\(/gu,
  /\.\s*saveAs\s*\(/gu,
];
const FILE_WRITE_CODE_PATTERNS: readonly RegExp[] = [/\.\s*(?:screenshot|pdf)\s*\(\s*\{[^}]*\bpath\s*:/gu];
const findFinalFileWrites = (source: ScannedSource): readonly string[] => [
  ...matchesOf(source.bare, FILE_WRITE_BARE_PATTERNS),
  ...matchesOf(source.code, FILE_WRITE_CODE_PATTERNS),
];

// ---------------------------------------------------------------------------------------------------------------
// 検出の関数の単体テスト（違反の例と、違反でない例）
// ---------------------------------------------------------------------------------------------------------------

const detects = (detector: (source: ScannedSource) => readonly string[], line: string): readonly string[] => detector(scanSource(line));

describe('source scanner', () => {
  it('separates comments and string literals, and keeps regular expression literals', () => {
    const scanned = scanSource([
      "const a = 'x // y'; // comment 'z'",
      'const b = /["\']\\/*/u.test(c); /* block',
      "loadConfig('q') */ const d = `t${e('f')}u`;",
      "await context.route('**/*', handler); writeFile(p);",
    ].join('\n'));
    expect(scanned.literals).toEqual(['x // y', 't', 'f', 'u', '**/*']);
    expect(scanned.code).not.toContain('comment');
    expect(scanned.code).not.toContain("loadConfig('q')");
    expect(scanned.code).toContain('/["\']\\/*/u');
    expect(scanned.bare).toContain("const a = '';");
    expect(scanned.bare).toContain("`${e('')}`");
    expect(scanned.bare).toContain('writeFile(p);');
    expect(scanned.code.split('\n')).toHaveLength(4);
  });

  it('finds calls, and ignores function and method definitions', () => {
    const bare = scanSource([
      'export function loadConfig(path) { return x; }',
      'class A { evaluate(input: I): R { return loadConfig(input); } }',
      'const c = await loadConfig<Config>(a, { b: f(1) });',
      'const d = loadConfigLater(a);',
    ].join('\n')).bare;
    expect(findCallSites(bare, 'loadConfig').map((site) => site.argumentText)).toEqual(['input', 'a, { b: f(1) }']);
    expect(findCallSites(bare, 'evaluate')).toEqual([]);
    expect(splitTopLevelArguments('a, { b: f(1, 2) }, [c, d]')).toEqual(['a', '{ b: f(1, 2) }', '[c, d]']);
    expect(countIdentifier(bare, 'loadConfig')).toBe(3);
  });

  it('finds import specifiers in the code without comments', () => {
    const code = scanSource("import { a } from './a.js';\n// import { b } from './b.js';\nconst c = await import('./c.js');").code;
    expect(findImportSpecifiers(code)).toEqual(['./a.js', './c.js']);
  });
});

describe('GATE-ARCH02〜08 detectors', () => {
  it('ARCH02: detect calls and imports of loadConfig', () => {
    for (const line of ['const c = await loadConfig(path, overrides);', 'const c = await config.loadConfig();']) {
      expect(detects(findLoadConfigCalls, line), line).toHaveLength(1);
    }
    for (const line of ['// loadConfig(path)', '/** `loadConfig` で検証済み */', "const t = 'loadConfig(x)';", 'export const loadConfig = async (path) => x;']) {
      expect(detects(findLoadConfigCalls, line), line).toHaveLength(0);
    }
    expect(detects(findLoadConfigImports, "import { loadConfig } from '../config/load-config.js';")).toHaveLength(1);
    expect(detects(findLoadConfigImports, "import type { AuditConfig } from '../config/types.js';")).toHaveLength(0);
  });

  it('ARCH03: detect anchor and href extraction, and references to the link discovery', () => {
    for (const line of [
      "const links = await page.locator('a[href]').evaluateAll(f);",
      'const href = element.getAttribute("href");',
      'const all = document.links;',
      "const anchors = document.getElementsByTagName('a');",
      "const anchors = document.querySelectorAll('a');",
      'const anchor = element as HTMLAnchorElement;',
    ]) {
      expect(detects(findLinkExtractions, line), line).toHaveLength(1);
    }
    for (const line of [
      "const title = element.getAttribute('title');",
      '// a[href] の要素',
      "const links = payload.links;",
      "const b = document.querySelectorAll('button');",
      '`<a href="${x}">`',
    ]) {
      expect(detects(findLinkExtractions, line), line).toHaveLength(0);
    }
    for (const line of ["import { discoverLinks } from '../crawl/discover-links.js';", 'const l = await collectors.discoverLinks(page);', 'const f = discoverLinks;']) {
      expect(detects(findLinkDiscoveryReferences, line), line).not.toHaveLength(0);
    }
    expect(detects(findLinkDiscoveryReferences, '// discoverLinks()')).toHaveLength(0);
    expect(readsLinkEvidence(scanSource("viewportEvidenceOfType(result, 'link', ['desktop']).flatMap(({ payload }) => payload.links)"))).toBe(true);
    expect(readsLinkEvidence(scanSource("viewportEvidenceOfType(result, 'dom', ['desktop'])"))).toBe(false);
  });

  it('ARCH04: detect URL normalization and admission outside the owners', () => {
    for (const line of [
      "url.hash = '';",
      'parsed.search = query.toString();',
      "url.searchParams.delete('utm_source');",
      'const q = new URLSearchParams();',
      'const origin = `${url.protocol}//${url.host}`;',
      "const origin = url.protocol + '//' + url.host;",
      'const key = `${url.origin}${url.pathname}`;',
      "const withoutFragment = raw.split('#')[0];",
      "const withoutFragment = raw.replace(/#.*$/u, '');",
      'const host = url.hostname.toLowerCase();',
    ]) {
      expect(detects(findUrlNormalizations, line), line).toHaveLength(1);
    }
    for (const line of [
      'if (url.hash === expected) {}',
      'const parsed = new URL(raw);',
      'const text = `${url.pathname}`;',
      "// url.hash = '';",
      "const entries = [...url.searchParams.entries()];",
      "const a = raw.split(',');",
    ]) {
      expect(detects(findUrlNormalizations, line), line).toHaveLength(0);
    }
    for (const line of [
      'if (allowedOrigins.has(url.origin)) {}',
      'return origins.includes(origin);',
      'return new URL(a).origin === new URL(b).origin;',
      'if (parsed.origin !== expected) {}',
      'if (expected === parsed.origin) {}',
      // R18 の M1: 引数が式や呼び出しでも、`origin` を含めば検出する。
      'if (allowedOrigins.has(new URL(url).origin)) {}',
      'if (allowedOrigins.has(originOf(url))) {}',
      'return origins.includes(parsed?.origin ?? fallback);',
      'return allowed?.has(canonicalOrigin(new URL(raw)));',
      'return allowedOrigins.has(\n  new URL(url).origin,\n);',
    ]) {
      expect(detects(findUrlAdmissions, line), line).toHaveLength(1);
    }
    expect(detects(findUrlAdmissions, 'if (allowedOrigins.has(new URL(url).origin)) {}')).toEqual(['.has(new URL(url).origin)']);
    expect(detects(findUrlAdmissions, 'return allowedOrigins.has(\n  new URL(url).origin,\n);')).toEqual(['.has(new URL(url).origin,)']);
    for (const line of [
      'const admission = classifyUrl(url, policy);',
      'const origin = new URL(raw).origin;',
      "if (origin === 'null') {}",
      'set.has(url.href);',
      '// allowedOrigins.has(url.origin)',
      '// allowedOrigins.has(new URL(url).origin)',
      "const text = 'allowedOrigins.has(originOf(url))';",
      'visited.has(normalizeUrl(url, base, allowed));',
      'if (has(origin)) {}',
      'class OriginSet { has(origin: string): boolean { return true; } }',
    ]) {
      expect(detects(findUrlAdmissions, line), line).toHaveLength(0);
    }
  });

  it('ARCH05: detect calls of deriveRunStatus and other decisions of the Run Status', () => {
    expect(detects(findRunStatusDerivations, 'runStatus: deriveRunStatus(statusInput),')).toHaveLength(1);
    expect(detects(findRunStatusDerivations, 'export const deriveRunStatus = (input: RunStatusInput): RunStatus => {')).toHaveLength(0);
    for (const line of [
      "const run = { runStatus: 'PARTIAL' };",
      "run.runStatus = 'FAILED';",
      "const summary = { runStatus: failed ? 'FAILED' : status };",
      'const summary = { runStatus: status };',
      'const pick = (input: X): RunStatus => input.value;',
      'function pick(input: X): RunStatus { return x; }',
      "const status = 'COMPLETE' as RunStatus;",
      "const status = 'COMPLETE' satisfies RunStatus;",
    ]) {
      expect(detects(findRunStatusDecisions, line), line).toHaveLength(1);
    }
    for (const line of [
      'runStatus: deriveRunStatus(statusInput),',
      'runStatus: run.runStatus,',
      'readonly runStatus: RunStatus;',
      "runStatus: 'Run の状態',",
      'if (run.runStatus === status) {}',
      'const exit = (status: RunStatus): number => 1;',
      "// runStatus: 'FAILED'",
    ]) {
      expect(detects(findRunStatusDecisions, line), line).toHaveLength(0);
    }
  });

  it('ARCH06: detect calls of createFindingFingerprint and other SHA-256 fingerprints', () => {
    expect(detects(findFingerprintCreations, 'fingerprint: createFindingFingerprint({ ruleId }),')).toHaveLength(1);
    expect(detects(findFingerprintCreations, 'export const createFindingFingerprint = (input: X): string => {')).toHaveLength(0);
    for (const line of [
      "const h = createHash('sha1');",
      "const digest = await crypto.subtle.digest('SHA-1', bytes);",
      'const hex = hash.digest(encoding);',
      "const prefix = 'sha256:';",
      "const finding = { fingerprint: `x:${id}` };",
      'finding.fingerprint = hashOf(draft);',
    ]) {
      expect(detects(findFingerprintConstructions, line), line).not.toHaveLength(0);
    }
    for (const line of [
      'fingerprint: createFindingFingerprint({ ruleId }),',
      'fingerprint: finding.fingerprint,',
      'readonly fingerprint: string;',
      "// createHash('sha256')",
      'textFingerprint: createSha256Fingerprint(text),',
      "import { randomUUID } from 'node:crypto';",
    ]) {
      expect(detects(findFingerprintConstructions, line), line).toHaveLength(0);
    }
  });

  it('ARCH07: detect the rule registry, page rule imports, rule engine overrides and cross-page evaluation', () => {
    const catalog = scanSource([
      'export const RULE_CATALOG: readonly AuditRule[] = freezeCatalog([',
      '  ...TECHNICAL_RULES,',
      '  ...LAYOUT_RULES,',
      '  ...TECHNICAL_RULES,',
      ']);',
    ].join('\n'));
    expect(findRuleCatalogDeclarations(catalog)).toHaveLength(1);
    expect(findRuleCatalogEntries(catalog)).toEqual(['...TECHNICAL_RULES', '...LAYOUT_RULES', '...TECHNICAL_RULES']);
    expect(detects(findRuleCatalogDeclarations, 'const rules = RULE_CATALOG;')).toHaveLength(0);
    expect(detects(findPageRuleArrayDeclarations, 'export const LAYOUT_RULES: readonly AuditRule[] = Object.freeze([')).toEqual(['LAYOUT_RULES']);
    expect(detects(findPageRuleArrayDeclarations, 'const LOCAL_RULES = [];')).toEqual([]);
    for (const line of ["import { LAYOUT_RULES } from './layout-rules.js';", "import { SAFETY_RULES } from '../audit/safety-rules.js';"]) {
      expect(detects(findPageRuleFileImports, line), line).toHaveLength(1);
    }
    for (const line of ["import { evaluateCrossPageRules } from '../audit/cross-page-rules.js';", "import { evidenceOfType } from './rule-helpers.js';", "import type { AuditRule } from './rule.js';"]) {
      expect(detects(findPageRuleFileImports, line), line).toHaveLength(0);
    }
    expect(detects(findRuleEngineCatalogOverrides, 'new RuleEngine({ targetId, catalog: rules })')).toHaveLength(1);
    expect(detects(findRuleEngineCatalogOverrides, 'new RuleEngine({ targetId, catalog })')).toHaveLength(1);
    expect(detects(findRuleEngineCatalogOverrides, 'new RuleEngine({ targetId: config.target.id, firstFindingSequence })')).toHaveLength(0);
    expect(detects(findCrossPageEvaluations, 'const r = evaluateCrossPageRules({ pages, evidence });')).toEqual(['evaluateCrossPageRules(1 argument)']);
    expect(detects(findCrossPageEvaluations, 'const r = evaluateCrossPageRules(input, rules);')).toEqual(['evaluateCrossPageRules(2 arguments)']);
    expect(detects(findCrossPageEvaluations, 'export const evaluateCrossPageRules = (input, rules = CROSS_PAGE_RULES) => x;')).toEqual([]);
    expect(detects(findCrossPageRuleDefinitions, "{ ruleId: 'X', version: 1, category: 'CROSS_PAGE', severity: 'WARN' }")).toHaveLength(1);
    expect(detects(findCrossPageRuleDefinitions, "const categories = ['CROSS_PAGE'];")).toHaveLength(0);
    for (const line of [
      "import { RuleEngine } from '../audit/rule-engine.js';",
      "import { RULE_CATALOG } from '../audit/rule-catalog.js';",
      "import { evaluateCrossPageRules } from '../audit/cross-page-rules.js';",
      "import { TECHNICAL_RULES } from '../audit/technical-rules.js';",
      'const r = rule.evaluate(input);',
      'const all = CROSS_PAGE_RULES.length;',
    ]) {
      expect(detects(findRuleEvaluationReferences, line), line).not.toHaveLength(0);
    }
    for (const line of [
      "import { evidenceOfType } from '../audit/rule-helpers.js';",
      "import { distinctSorted } from '../audit/rule-helpers.js';",
      '// RuleEngine',
      "const label = 'RULE_CATALOG';",
    ]) {
      expect(detects(findRuleEvaluationReferences, line), line).toHaveLength(0);
    }
  });

  it('ARCH08: detect artifact validation, direct schema validation and file writes', () => {
    expect(detects(findArtifactValidations, 'const result = await validateArtifact(schema, value);')).toHaveLength(1);
    expect(detects(findArtifactValidations, 'export const validateArtifact = async (name, value) => x;')).toHaveLength(0);
    for (const line of ["import { Ajv } from 'ajv';", "import addFormats from 'ajv-formats';", 'const ajv = new Ajv({ strict: true });']) {
      expect(detects(findSchemaValidatorUses, line), line).not.toHaveLength(0);
    }
    expect(detects(findSchemaValidatorUses, "import { validateArtifact } from '../core/schema-validator.js';")).toHaveLength(0);
    for (const line of [
      'await writeFile(path, data);',
      'writeFileSync(path, data);',
      'await fs.rename(from, to);',
      'await appendFile(path, data);',
      'const stream = createWriteStream(path);',
      'await copyFile(from, to);',
      "await page.screenshot({ path: out, type: 'png' });",
      'await download.saveAs(path);',
    ]) {
      expect(detects(findFinalFileWrites, line), line).toHaveLength(1);
    }
    for (const line of [
      'await writeFileAtomically(path, data);',
      'const text = await readFile(path);',
      '// await writeFile(path, data);',
      "const label = 'writeFile(path)';",
      'const shot = await page.screenshot();',
      'await stream.write(text);',
    ]) {
      expect(detects(findFinalFileWrites, line), line).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 持ち主（owner）と除外
// ---------------------------------------------------------------------------------------------------------------

/** GATE の検出の1件。 */
interface Detection {
  readonly path: string;
  readonly match: string;
}

/** 除外の単位（Gate と、その中の確認）。 */
type ExclusionScope =
  | 'ARCH02'
  | 'ARCH03-extraction'
  | 'ARCH03-discovery'
  | 'ARCH04'
  | 'ARCH05'
  | 'ARCH06'
  | 'ARCH07-registry'
  | 'ARCH07-cross-page'
  | 'ARCH07-reporter'
  | 'ARCH08';

/**
 * 除外の一覧（GATE-ARCH02〜08 の除外は、ここに1か所だけ置く）。値は、除外の理由。
 * - 鍵が `<ファイル>` の場合は、そのファイルの検出をすべて除く（ファイルがあることを確かめる）。
 * - 鍵が `<ファイル>: <検出した式>` の場合は、その式の検出だけを除く（除外が使われていること、つまり古くなっていないことを確かめる）。
 */
const EXCLUSIONS: Readonly<Record<ExclusionScope, ReadonlyMap<string, string>>> = {
  ARCH02: new Map([
    ['src/config/load-config.ts', '`loadConfig` の定義の場所（Effective configuration の owner。呼び出し元ではない）'],
  ]),
  'ARCH03-extraction': new Map([
    [
      "src/evidence/dom-collector.ts: getAttribute('href')",
      '`<link rel="canonical">` の href を、DOM の Evidence（canonicalUrl）として読む。anchor のリンクの抽出ではない',
    ],
    [
      "src/interaction/discover-candidates.ts: getAttribute('href')",
      'Interaction の候補の Evidence（hrefKind の判定の入力）として読む。クロールのリンクの抽出ではない',
    ],
    [
      'src/evidence/layout-collector.ts: a[href',
      'レイアウトの要素の種類（link）の分類と、大きさ0の操作できる要素の判定のセレクタ。href の値を読まない',
    ],
  ]),
  'ARCH03-discovery': new Map(),
  ARCH04: new Map([
    [
      'src/safety/request-policy.ts: .has(candidate.origin)',
      'Passive HTTP の遮断の判定（SSOT Owner Matrix の Passive HTTP authority の owner）。許可 Origin の正規化は `canonicalizeAllowedOrigins` に委ねている',
    ],
    [
      'src/config/validate-config.ts: .has(startUrl.origin)',
      '設定の値どうしの整合の検証（開始の URL の Origin が許可 Origin に含まれるか）。許可 Origin の正規化は `canonicalizeAllowedOrigins` に委ね、開始の URL の受け入れの判定そのものは PREFLIGHT が `classifyUrl` で行う',
    ],
    [
      'src/crawl/site-metadata.ts: .origin !==',
      '引数が Origin の直列化であるかの入力の検証。取得する URL の受け入れの判定は、直後に `classifyUrl` で行う',
    ],
    [
      'src/evidence/performance-collector.ts: .origin ===',
      'Resource Timing の大きさが、別 Origin のために隠されたかの判定（ブラウザの same-origin の規則）。URL の受け入れではない',
    ],
    [
      'src/interaction/discover-candidates.ts: .origin ===',
      'Interaction の候補の hrefKind（文書と同じ Origin か）の Evidence。Interaction の受け入れの owner は `src/safety/interaction-policy.ts`',
    ],
    [
      'src/audit/technical-rules.ts: .origin ===',
      '`normalizeUrl` が受け入れなかったリンク（正規化した URL がなく、`classifyUrl` にかけられない）を、ページと同じ Origin かで内部とみなす Rule の判定。page rule の入力には許可 Origin がない',
    ],
  ]),
  ARCH05: new Map(),
  ARCH06: new Map(),
  'ARCH07-registry': new Map([
    [
      'src/audit/cross-page-rules.ts: RULE_CATALOG',
      'Cross-page rule の ruleId が page rule と重ならないかを、`freezeCatalog(rules, RULE_CATALOG)` で検査するために読むだけ。page rule を評価しない',
    ],
  ]),
  'ARCH07-cross-page': new Map(),
  'ARCH07-reporter': new Map(),
  ARCH08: new Map([
    [
      'src/evidence/screenshot-collector.ts: .screenshot({ path:',
      'スクリーンショットの PNG は、collector が Evidence の取得として直接書く（最終の JSON・HTML・バンドルの書き出しではない。設計書 4.4）',
    ],
    [
      'src/orchestration/preflight.ts: writeFile(',
      'PREFLIGHT が、出力先に書けるかを、空の一時ファイルを新しく作ってすぐ消して確かめる（artifact ではない）',
    ],
  ]),
};

const detectionKey = ({ path, match }: Detection): string => `${path}: ${match}`;

/** `files` の検出から、`gate` の除外を除いたもの（`<ファイル>: <検出した式>` の形）。あわせて、除外が古くなっていないことを確かめる。 */
const violationsAfterExclusions = (gate: ExclusionScope, detections: readonly Detection[]): readonly string[] => {
  const exclusions = EXCLUSIONS[gate];
  for (const key of exclusions.keys()) {
    const isFileKey = !key.includes(': ');
    const used = isFileKey
      ? SOURCE_FILES.some((file) => file.path === key)
      : detections.some((detection) => detectionKey(detection) === key);
    expect(used, `${gate} の除外が古くなっている: ${key}`).toBe(true);
  }
  return detections
    .filter((detection) => !exclusions.has(detection.path) && !exclusions.has(detectionKey(detection)))
    .map(detectionKey);
};

/** `detector` を、`files` のそれぞれにかけた検出。 */
const detectIn = (files: readonly SourceFile[], detector: (source: ScannedSource) => readonly string[]): readonly Detection[] =>
  files.flatMap((file) => detector(file).map((match) => ({ path: file.path, match })));

const sourceFile = (path: string): SourceFile => {
  const file = SOURCE_FILES.find((candidate) => candidate.path === path);
  expect(file, path).toBeDefined();
  return file ?? { path, content: '', ...scanSource('') };
};

const filesOtherThan = (paths: readonly string[]): readonly SourceFile[] => SOURCE_FILES.filter((file) => !paths.includes(file.path));

const CLI_DIRECTORY = 'src/cli/';
const REPORT_DIRECTORY = 'src/report/';

// 持ち主（実装タスク指示 第5章 SSOT Owner Matrix）と、決まった呼び出し元。
const LINK_EXTRACTION_OWNER = 'src/crawl/discover-links.ts';
const PAGE_AUDITOR = 'src/orchestration/page-auditor.ts';
const RUN_COORDINATOR = 'src/orchestration/run-coordinator.ts';
const URL_CANONICALIZATION_OWNER = 'src/crawl/normalize-url.ts';
const URL_ADMISSION_OWNER = 'src/crawl/admission-policy.ts';
const RUN_STATUS_OWNER = 'src/core/status.ts';
const ARTIFACT_WRITER = 'src/report/artifact-writer.ts';
const FINGERPRINT_OWNER = 'src/core/ids.ts';
const RULE_ENGINE = 'src/audit/rule-engine.ts';
const RULE_CATALOG_OWNER = 'src/audit/rule-catalog.ts';
const CROSS_PAGE_RULES_OWNER = 'src/audit/cross-page-rules.ts';
const SCHEMA_VALIDATION_OWNER = 'src/core/schema-validator.ts';
const PREFLIGHT = 'src/orchestration/preflight.ts';

/** page rule のファイル（`src/audit/*-rules.ts`。Cross-page rule のファイルを除く）。 */
const isPageRuleFile = (path: string): boolean => /^src\/audit\/[^/]+-rules\.ts$/u.test(path) && path !== CROSS_PAGE_RULES_OWNER;

// ---------------------------------------------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------------------------------------------

describe('GATE-ARCH02〜08 Semantic Ownership', () => {
  it('reads the source files once', () => {
    expect(SOURCE_FILES.length).toBeGreaterThan(0);
  });

  it('GATE-ARCH02: only src/cli/** calls or imports loadConfig', () => {
    expect(findLoadConfigCalls(sourceFile('src/cli/main.ts')).length).toBeGreaterThan(0);
    const files = SOURCE_FILES.filter((file) => !file.path.startsWith(CLI_DIRECTORY));
    const violations = violationsAfterExclusions('ARCH02', [
      ...detectIn(files, findLoadConfigCalls),
      ...detectIn(files, findLoadConfigImports),
    ]);
    expect(violations).toEqual([]);
  });

  it('GATE-ARCH03: only src/crawl/discover-links.ts extracts anchors and hrefs', () => {
    expect(findLinkExtractions(sourceFile(LINK_EXTRACTION_OWNER)).length).toBeGreaterThan(0);
    const violations = violationsAfterExclusions('ARCH03-extraction', detectIn(filesOtherThan([LINK_EXTRACTION_OWNER]), findLinkExtractions));
    expect(violations).toEqual([]);
  });

  it('GATE-ARCH03: only the Page Auditor runs the link discovery, and the Run Coordinator reuses its link Evidence', () => {
    expect(findLinkDiscoveryReferences(sourceFile(PAGE_AUDITOR)).length).toBeGreaterThan(0);
    const violations = violationsAfterExclusions(
      'ARCH03-discovery',
      detectIn(filesOtherThan([LINK_EXTRACTION_OWNER, PAGE_AUDITOR]), findLinkDiscoveryReferences),
    );
    expect(violations).toEqual([]);
    expect(readsLinkEvidence(sourceFile(RUN_COORDINATOR))).toBe(true);
  });

  it('GATE-ARCH04: URLs are normalized and admitted only by normalizeUrl and classifyUrl', () => {
    const owners = [URL_CANONICALIZATION_OWNER, URL_ADMISSION_OWNER];
    // 検出の関数が、実際の owner のファイルで働くことの確かめ。
    expect(findUrlNormalizations(sourceFile(URL_CANONICALIZATION_OWNER)).length).toBeGreaterThan(0);
    expect(findUrlAdmissions(sourceFile(URL_ADMISSION_OWNER)).length).toBeGreaterThan(0);
    const files = filesOtherThan(owners);
    const violations = violationsAfterExclusions('ARCH04', [
      ...detectIn(files, findUrlNormalizations),
      ...detectIn(files, findUrlAdmissions),
    ]);
    expect(violations).toEqual([]);
  });

  it('GATE-ARCH05: only deriveRunStatus decides the final Run Status', () => {
    const callers = [RUN_COORDINATOR, ARTIFACT_WRITER];
    for (const caller of callers) {
      expect(findRunStatusDerivations(sourceFile(caller)).length, caller).toBeGreaterThan(0);
    }
    expect(findRunStatusDecisions(sourceFile(RUN_STATUS_OWNER)).length).toBeGreaterThan(0);
    const violations = violationsAfterExclusions('ARCH05', [
      ...detectIn(filesOtherThan(callers), findRunStatusDerivations),
      ...detectIn(filesOtherThan([RUN_STATUS_OWNER]), findRunStatusDecisions),
    ]);
    expect(violations).toEqual([]);
  });

  it('GATE-ARCH06: only createFindingFingerprint creates Finding fingerprints', () => {
    expect(findFingerprintCreations(sourceFile(RULE_ENGINE)).length).toBeGreaterThan(0);
    expect(findFingerprintConstructions(sourceFile(FINGERPRINT_OWNER)).length).toBeGreaterThan(0);
    const violations = violationsAfterExclusions('ARCH06', [
      ...detectIn(filesOtherThan([RULE_ENGINE]), findFingerprintCreations),
      ...detectIn(filesOtherThan([FINGERPRINT_OWNER]), findFingerprintConstructions),
    ]);
    expect(violations).toEqual([]);
  });

  it('GATE-ARCH07: page rules are registered once in RULE_CATALOG, and the Rule Engine uses only it', () => {
    const catalog = sourceFile(RULE_CATALOG_OWNER);
    expect(SOURCE_FILES.flatMap((file) => findRuleCatalogDeclarations(file).map(() => file.path))).toEqual([RULE_CATALOG_OWNER]);
    const pageRuleFiles = SOURCE_FILES.filter((file) => isPageRuleFile(file.path));
    expect(pageRuleFiles.length).toBeGreaterThan(0);
    const pageRuleArrays = pageRuleFiles.flatMap((file) => findPageRuleArrayDeclarations(file));
    expect(pageRuleArrays).toHaveLength(pageRuleFiles.length);
    // 各 Rule のファイルの配列が、RULE_CATALOG に1回ずつだけ並ぶ（ほかの項目がない）。
    expect([...findRuleCatalogEntries(catalog)].sort()).toEqual(pageRuleArrays.map((name) => `...${name}`).sort());
    const violations = violationsAfterExclusions('ARCH07-registry', [
      // page rule のファイルを import するのは、RULE_CATALOG のファイルだけ。
      ...detectIn(filesOtherThan([RULE_CATALOG_OWNER]), findPageRuleFileImports),
      // Rule Engine に、RULE_CATALOG の代わりの一覧を渡さない。
      ...detectIn(SOURCE_FILES, findRuleEngineCatalogOverrides),
      // RULE_CATALOG を参照するのは、登録先と Rule Engine だけ。
      ...filesOtherThan([RULE_CATALOG_OWNER, RULE_ENGINE]).flatMap((file) =>
        Array.from({ length: countIdentifier(file.bare, 'RULE_CATALOG') }, () => ({ path: file.path, match: 'RULE_CATALOG' }))),
    ]);
    expect(violations).toEqual([]);
    expect(countIdentifier(sourceFile(RULE_ENGINE).bare, 'RULE_CATALOG')).toBeGreaterThan(0);
  });

  it('GATE-ARCH07: cross-page rules are evaluated only through evaluateCrossPageRules()', () => {
    expect(findCrossPageEvaluations(sourceFile(RUN_COORDINATOR))).toEqual(['evaluateCrossPageRules(1 argument)']);
    expect(findCrossPageRuleDefinitions(sourceFile(CROSS_PAGE_RULES_OWNER)).length).toBeGreaterThan(0);
    const violations = violationsAfterExclusions('ARCH07-cross-page', [
      ...detectIn(filesOtherThan([RUN_COORDINATOR]), findCrossPageEvaluations),
      ...detectIn(filesOtherThan([CROSS_PAGE_RULES_OWNER]), findCrossPageRuleDefinitions),
      ...filesOtherThan([CROSS_PAGE_RULES_OWNER]).flatMap((file) =>
        Array.from({ length: countIdentifier(file.bare, 'CROSS_PAGE_RULES') }, () => ({ path: file.path, match: 'CROSS_PAGE_RULES' }))),
    ]);
    expect(violations).toEqual([]);
  });

  it('GATE-ARCH07: src/report/** and src/cli/** do not evaluate rules', () => {
    const files = SOURCE_FILES.filter((file) => file.path.startsWith(REPORT_DIRECTORY) || file.path.startsWith(CLI_DIRECTORY));
    expect(files.some((file) => file.path === ARTIFACT_WRITER)).toBe(true);
    const violations = violationsAfterExclusions('ARCH07-reporter', detectIn(files, findRuleEvaluationReferences));
    expect(violations).toEqual([]);
  });

  it('GATE-ARCH08: JSON validation is delegated to validateArtifact, and only ArtifactWriter writes the final artifacts', () => {
    const validators = [PREFLIGHT, RUN_COORDINATOR, ARTIFACT_WRITER];
    for (const caller of validators) {
      expect(findArtifactValidations(sourceFile(caller)).length, caller).toBeGreaterThan(0);
    }
    expect(findSchemaValidatorUses(sourceFile(SCHEMA_VALIDATION_OWNER)).length).toBeGreaterThan(0);
    expect(findFinalFileWrites(sourceFile(ARTIFACT_WRITER)).length).toBeGreaterThan(0);
    const violations = violationsAfterExclusions('ARCH08', [
      ...detectIn(filesOtherThan(validators), findArtifactValidations),
      ...detectIn(filesOtherThan([SCHEMA_VALIDATION_OWNER]), findSchemaValidatorUses),
      ...detectIn(filesOtherThan([ARTIFACT_WRITER]), findFinalFileWrites),
    ]);
    expect(violations).toEqual([]);
  });
});
