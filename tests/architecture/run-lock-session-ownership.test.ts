/**
 * 出力先の監査中の印（SPEC-2 の作り直し。OS が放す排他）、セッションの切れの判定、内部のリンクの取り出しの Architecture Gate（CCX-6。共通化の
 * 台帳の CC-070）。
 * - (a) 出力先の排他を取る `acquireRunExclusion(`（owner は `src/core/run-exclusion.ts`）を呼ぶのは、CLI の監査（`src/cli/audit-run.ts`）と
 *   ワーカーの Run の始め方（`src/worker/worker-run-session.ts`、発見の続きの Run `src/worker/discovery-run.ts`）だけ（閉じた一覧）。
 * - (d) セッションの切れの path の判定 `isSessionLostUrl(` を呼ぶのは、owner（`src/orchestration/authenticated-run.ts`）だけ。読み込みの後の
 *   判定 `sessionLostUrlOf(` を呼ぶのは、owner の時機の補助（`sessionLostUrlAt`。DF-3）と、書き込みのジョブの流れ（`src/worker/write-create-run.ts`。
 *   書き込みの段の判定で、読み取りの時機の一覧の外）だけ。時機の補助 `sessionLostUrlAt(` を呼ぶのは、Page Auditor とワーカーの 1 画面の読み込み
 *   （`src/worker/worker-run-session.ts`）だけ。
 * - (i) DF-3（DEF-167）: 確かめる時機は、owner の一覧（`SESSION_LOSS_CHECK_POINTS`）だけで決める。一覧を定義するのは owner だけ。補助の呼び出しの
 *   時機を文字列で書かない。Page Auditor とワーカーの 1 画面の読み込みは、決めた時機（下の `CHECK_POINT_READERS`）を一覧の名前で使い、発見の流れ
 *   （`src/worker/discovery-run.ts`）は、落ち着きの後の確かめ（`stopIfSessionLostAfterSettling(`）を呼ぶ。
 * - (e) Link の Evidence の受け入れの判定が `INTERNAL_NAVIGABLE` で正規化が `ok` のものを取り出す式（否定の形 `!== 'INTERNAL_NAVIGABLE' || !….ok`
 *   を含む）は、巡回の候補の取り出しの owner（`src/crawl/internal-navigable-links.ts` の `internalNavigableUrlsOf`）だけに書く（PRE42-CC 組 5b。
 *   CC-070 (b)。Run Coordinator・発見のワーカーの流れ・Cross-page rule は、この関数を呼ぶ）。
 * - (f) `isSessionLostUrl` という名前の関数を定義するのは、owner（`src/orchestration/authenticated-run.ts`）だけ。同じ名前の意味の違う関数を
 *   置かない（PRE42-CC 組 5b。CC-070 (c)。保存の行の URL の形の確かめは `job-store.ts` の `isRecordableSessionLostUrl`）。
 * - (g) 発見の 1 画面分の記録の形（`incompleteReasons: readonly IncompleteReason[]` と `candidates: readonly DiscoveryCandidate[]` を持つ型）を
 *   宣言するのは、純粋な成果物の部品（`src/discovery/discovery-result.ts` の `DiscoveryReadPageRecord`）だけ（PRE42-CC 組 5b。CC-070 (a)。
 *   発見の入口 `discover-page.ts` は、この型を使う）。
 * - (h) ファイルの排他的な作成（SR-1-F、DEF-168）: `open(…, 'wx')`（`writeFile(…, { flag: 'wx' })` を含む）で新しく作るのは、書き出しの途中の
 *   一時ファイル（第 1 引数が `temporary…` の名前）だけ。ファイルを `wx` で作ってから中身を書く形（中身のないファイルが外から見え、ロックに
 *   使うと古いと判定される）は、`src/` のどこにも書かない（SPEC-2 の作り直しで、ロックのファイルそのものもなくなった）。
 * - `src/**` の読み込みは、このファイルの読み込み時に 1 回だけ行う。判定は、`fs`、正規表現、文字列の走査だけで行う（AST・TypeScript の
 *   コンパイラ API・外部ツール・子プロセス・`dist/` を使わない）。呼び出しはコメントと文字列リテラルの中を見ない（近似の検査である）。
 */
import { describe, expect, it } from 'vitest';
import { findCallSites, loadSourceFiles, scanSource, sourceFileAt, unusedExclusionsOf, type SourceFile } from './source-scan.js';

const SOURCE_FILES = loadSourceFiles();

/** (a) 出力先の排他を取ってよいファイル（閉じた一覧）。 */
const RUN_EXCLUSION_USERS: readonly string[] = ['src/cli/audit-run.ts', 'src/worker/worker-run-session.ts', 'src/worker/discovery-run.ts'];
const AUTHENTICATED_RUN = 'src/orchestration/authenticated-run.ts';
const PAGE_AUDITOR = 'src/orchestration/page-auditor.ts';
const WORKER_RUN_SESSION = 'src/worker/worker-run-session.ts';
/** T30f: 書き込みのジョブの流れ（書き込みの段の Context の読み込みと、押した後の結果の判定で、セッションの切れを確かめる）。 */
const WRITE_CREATE_RUN = 'src/worker/write-create-run.ts';
/** (i) 発見のジョブの流れ（落ち着きの後の確かめを呼ぶ）。 */
const DISCOVERY_RUN = 'src/worker/discovery-run.ts';
/** (e) 巡回の候補の取り出しの owner（CC-070 (b)。`src/crawl/` の純粋な部品）。 */
const INTERNAL_NAVIGABLE_LINKS = 'src/crawl/internal-navigable-links.ts';
/** (e) 巡回の候補の取り出し（`internalNavigableUrlsOf(`）を呼ぶファイル（規則が古くなっていないことを確かめる）。 */
const INTERNAL_NAVIGABLE_USERS: readonly string[] = [
  'src/orchestration/run-coordinator.ts',
  'src/worker/discovery-run.ts',
  'src/audit/cross-page-rules.ts',
];
/** (g) 発見の 1 画面分の記録の形の owner（CC-070 (a)）。 */
const DISCOVERY_RESULT = 'src/discovery/discovery-result.ts';
/** (g) 発見の入口（記録の形を使う側）。 */
const DISCOVER_PAGE = 'src/discovery/discover-page.ts';

/** 呼んでよいファイルの決まり。 */
interface CallRule {
  readonly name: string;
  readonly allowed: readonly string[];
}

const CALL_RULES: readonly CallRule[] = [
  { name: 'acquireRunExclusion', allowed: RUN_EXCLUSION_USERS },
  { name: 'isSessionLostUrl', allowed: [AUTHENTICATED_RUN] },
  // DF-3: 読み取りの流れは、時機の補助（`sessionLostUrlAt`）を通す。書き込みのジョブは、書き込みの段の判定（DF-3 の範囲の外）なので今のまま。
  { name: 'sessionLostUrlOf', allowed: [AUTHENTICATED_RUN, WRITE_CREATE_RUN] },
  { name: 'sessionLostUrlAt', allowed: [PAGE_AUDITOR, WORKER_RUN_SESSION] },
];

/** (i) 確かめる時機の一覧の本文（owner の `SESSION_LOSS_CHECK_POINTS = Object.freeze({ … })`。`bare` に当てる）。 */
const CHECK_POINTS_PATTERN = /\bexport\s+const\s+SESSION_LOSS_CHECK_POINTS\s*=\s*Object\.freeze\(\s*\{([^{}]*)\}/u;

/** (i) 一覧の名前（`bare` の本文の `名前:`。値の文字列は `bare` では空）。 */
const checkPointNamesOf = (bare: string): readonly string[] =>
  [...(CHECK_POINTS_PATTERN.exec(bare)?.[1] ?? '').matchAll(/([\w$]+)\s*:/gu)].map(([, name = '']) => name);

/** (i) ファイルが一覧の名前で使う時機（`SESSION_LOSS_CHECK_POINTS.<名前>`。`bare` に当てる。一覧の順）。 */
const checkPointUsesOf = (bare: string, names: readonly string[]): readonly string[] =>
  names.filter((name) => new RegExp(String.raw`\bSESSION_LOSS_CHECK_POINTS\s*\.\s*${name}(?![\w$])`, 'u').test(bare));

/** (i) 時機の補助の呼び出しで、時機を文字列で書いたもの（`code` に当てる）。 */
const LITERAL_CHECK_POINT_PATTERN = /\bsessionLostUrlAt\s*\(\s*['"`]/gu;

/**
 * (i) 時機の補助を呼ぶファイルと、使う時機（DF-3 の指示書の 1）。監査は 4 つ全部（幅の走査の前と各幅の前、次のビューポートの前を含む）。ワーカーの
 * 1 画面の読み込みは 1 画面だけを読むので、次の読み込みの前（`beforeNextLoad`）は使わない（前の画面の終わりの確かめ `pageEnd` が同じ役）。
 */
const CHECK_POINT_READERS: readonly { readonly path: string; readonly points: readonly string[] }[] = [
  { path: PAGE_AUDITOR, points: ['navigation', 'settled', 'beforeNextLoad', 'pageEnd'] },
  { path: WORKER_RUN_SESSION, points: ['navigation', 'settled', 'pageEnd'] },
];

/** 関数の、ファイルの中の定義（`const name =`、`function name(`）。`bare` に当てる。 */
const localDefinitionPattern = (name: string): RegExp => new RegExp(String.raw`\b(?:const|let|var|function)\s+${name}(?![\w$])`, 'u');

/** `name(` の呼び出しの数（`bare` に当てる。定義は数えない）。 */
const callCount = (bare: string, name: string): number => findCallSites(bare, name).length;

/** 決まりに反する呼び出しの一覧（`<ファイル>: <名前>(`）。 */
const callViolations = (files: readonly Pick<SourceFile, 'path' | 'bare'>[], rule: CallRule): readonly string[] =>
  files
    .filter((file) => !rule.allowed.includes(file.path))
    .filter((file) => callCount(file.bare, rule.name) > 0)
    .map((file) => `${file.path}: ${rule.name}(`);

/** (f) owner の外で定義してはいけない関数の名前（同じ名前の意味の違う関数を置かない）。 */
const OWNED_FUNCTION_NAMES: readonly CallRule[] = [{ name: 'isSessionLostUrl', allowed: [AUTHENTICATED_RUN] }];

/** (f) 決まりに反する定義の一覧（`<ファイル>: <名前>`）。 */
const definitionViolations = (files: readonly Pick<SourceFile, 'path' | 'bare'>[], rule: CallRule): readonly string[] =>
  files
    .filter((file) => !rule.allowed.includes(file.path) && localDefinitionPattern(rule.name).test(file.bare))
    .map((file) => `${file.path}: ${rule.name}`);

/**
 * Link の Evidence から、`INTERNAL_NAVIGABLE` で正規化が `ok` のものを選ぶ式（`code` に当てる。文字列の中を含む）。
 * `….admission.kind === 'INTERNAL_NAVIGABLE' && ….normalized.ok`（順が逆のものを含む）と、その否定の形
 * `….admission.kind !== 'INTERNAL_NAVIGABLE' || !….normalized.ok`（順が逆のものを含む。CC-070 (b)。Cross-page rule にあった形）。
 */
const INTERNAL_NAVIGABLE_FILTER_PATTERNS: readonly RegExp[] = [
  /\bkind\s*===\s*(['"`])INTERNAL_NAVIGABLE\1\s*&&\s*[\w$.?]*normalized\s*\??\.\s*ok\b/gu,
  /\bnormalized\s*\??\.\s*ok\s*&&\s*[\w$.?]*kind\s*===\s*(['"`])INTERNAL_NAVIGABLE\1/gu,
  /\bkind\s*!==\s*(['"`])INTERNAL_NAVIGABLE\1\s*\|\|\s*!\s*[\w$.?]*normalized\s*\??\.\s*ok\b/gu,
  /!\s*[\w$.?]*normalized\s*\??\.\s*ok\s*\|\|\s*[\w$.?]*kind\s*!==\s*(['"`])INTERNAL_NAVIGABLE\1/gu,
];
const internalNavigableFilterCount = (code: string): number =>
  INTERNAL_NAVIGABLE_FILTER_PATTERNS.reduce((total, pattern) => total + [...code.matchAll(pattern)].length, 0);

/**
 * (g) 発見の 1 画面分の記録の形の宣言（`interface X {…}`・`type X = {…}` の、入れ子の `{}` のない本文に、`incompleteReasons` と `candidates` の
 * 両方の欄がある。順は問わない）。`bare` に当てる。
 */
const PAGE_RECORD_DECLARATION_PATTERN = /\b(?:interface\s+[\w$]+(?:\s+extends\s+[^{]+)?|type\s+[\w$]+\s*=)\s*\{([^{}]*)\}/gu;
const PAGE_RECORD_MEMBERS: readonly RegExp[] = [
  /\bincompleteReasons\s*\??\s*:\s*readonly\s+IncompleteReason\s*\[\s*\]/u,
  /\bcandidates\s*\??\s*:\s*readonly\s+DiscoveryCandidate\s*\[\s*\]/u,
];
const pageRecordDeclarationCount = (bare: string): number =>
  [...bare.matchAll(PAGE_RECORD_DECLARATION_PATTERN)]
    .filter(([, body = '']) => PAGE_RECORD_MEMBERS.every((member) => member.test(body)))
    .length;

/** (h) 書き手（一時ファイルを `wx` で作る）。 */
const ARTIFACT_WRITER = 'src/report/artifact-writer.ts';

/** (h) `wx` の文字列（`code` に当てる。コメントの中は見ない）。 */
const EXCLUSIVE_FLAG_PATTERN = /(['"`])wx\1/gu;
/** (h) 書き出しの途中の一時ファイル（第 1 引数が `temporary…` の名前）を `wx` で新しく作る呼び出し（`code` に当てる）。 */
const TEMPORARY_EXCLUSIVE_OPEN_PATTERN = /\b(?:open|writeFile)\s*\(\s*temporary[\w$]*\s*,[^;()]*?(['"`])wx\1/gu;

/** (h) 呼び出しでない `wx` の決まった除外（ファイル、当てる形、理由）。 */
interface ExclusiveFlagException {
  readonly path: string;
  readonly pattern: RegExp;
  readonly reason: string;
}

const EXCLUSIVE_FLAG_EXCEPTIONS: readonly ExclusiveFlagException[] = [
  {
    path: ARTIFACT_WRITER,
    pattern: /\bflags\s*:\s*(['"`])wx\1\s*\|\s*(['"`])r\2/gu,
    reason: '差し替えの口 `CheckpointFileOperations` の `open` の型（開き方の閉じた一覧）。',
  },
  {
    path: 'src/browser/chromium-launch.ts',
    pattern: /\bwriteFile\s*\(\s*join\s*\(\s*profileDirectory\b[^;]*?\bflag\s*:\s*(['"`])wx\1/gu,
    reason: 'EL-12: 一時のプロファイルの Preferences（ロックではない。BeakSight が作ったばかりの空のフォルダに 1 回だけ書く。件数 1）。',
  },
];

const exclusiveFlagExceptionCount = (file: Pick<SourceFile, 'path' | 'code'>): number =>
  EXCLUSIVE_FLAG_EXCEPTIONS
    .filter((exception) => exception.path === file.path)
    .reduce((total, exception) => total + [...file.code.matchAll(exception.pattern)].length, 0);

/** (h) 一時ファイルでないものを `wx` で作る所の一覧（`<ファイル>: <数>`）。 */
const exclusiveOpenViolations = (files: readonly Pick<SourceFile, 'path' | 'code'>[]): readonly string[] =>
  files.flatMap((file) => {
    const extra = [...file.code.matchAll(EXCLUSIVE_FLAG_PATTERN)].length
      - [...file.code.matchAll(TEMPORARY_EXCLUSIVE_OPEN_PATTERN)].length
      - exclusiveFlagExceptionCount(file);
    return extra > 0 ? [`${file.path}: ${String(extra)}`] : [];
  });

const sourceFile = (path: string): SourceFile => sourceFileAt(SOURCE_FILES, path);

describe('run lock and session lost ownership detectors (CCX-6)', () => {
  const asFile = (path: string, source: string): Pick<SourceFile, 'path' | 'bare'> => ({ path, bare: scanSource(source).bare });
  const rule = (name: string): CallRule => CALL_RULES.find((candidate) => candidate.name === name) ?? { name, allowed: [] };

  it('detects the exclusion taken outside the closed list of users', () => {
    const copy = asFile('src/worker/read-check-run.ts', 'const exclusion = await acquireRunExclusion(outputDirectory);');
    expect(callViolations([copy], rule('acquireRunExclusion'))).toEqual(['src/worker/read-check-run.ts: acquireRunExclusion(']);
  });

  it('detects the session lost judgement written outside the owner, as before CCX-6', () => {
    const auditorCopy = asFile(PAGE_AUDITOR, [
      'if (isSessionLostUrl(page.url(), prefix)) {',
      '  return true;',
      '}',
      'return events.some(({ mainFrameNavigation, url }) => mainFrameNavigation && isSessionLostUrl(url, prefix));',
    ].join('\n'));
    expect(callViolations([auditorCopy], rule('isSessionLostUrl'))).toEqual([`${PAGE_AUDITOR}: isSessionLostUrl(`]);
    expect(callViolations([asFile('src/worker/read-check-run.ts', 'const lost = sessionLostUrlOf(page, ledger, prefix);')], rule('sessionLostUrlOf')))
      .toEqual(['src/worker/read-check-run.ts: sessionLostUrlOf(']);
    // DF-3: Page Auditor が、時機の補助を通さずに判定を呼ぶ形（DF-3 の前の形）も見つける。
    expect(callViolations([asFile(PAGE_AUDITOR, 'return sessionLostUrlOf(page, ledger, prefix) !== null;')], rule('sessionLostUrlOf')))
      .toEqual([`${PAGE_AUDITOR}: sessionLostUrlOf(`]);
  });

  it('(i) reads the check point names, finds the points used by name, and finds a point written as a string', () => {
    const owner = scanSource([
      'export const SESSION_LOSS_CHECK_POINTS = Object.freeze({',
      "  navigation: 'navigation',",
      "  settled: 'settled',",
      '} as const);',
    ].join('\n'));
    expect(checkPointNamesOf(owner.bare)).toEqual(['navigation', 'settled']);
    const reader = scanSource([
      'const lost = sessionLostUrlAt(SESSION_LOSS_CHECK_POINTS.settled, page, ledger, prefix);',
      '// SESSION_LOSS_CHECK_POINTS.navigation はコメントの中なので数えない',
      "const copy = sessionLostUrlAt('page-end', page, ledger, prefix);",
    ].join('\n'));
    expect(checkPointUsesOf(reader.bare, ['navigation', 'settled', 'pageEnd'])).toEqual(['settled']);
    expect([...reader.code.matchAll(LITERAL_CHECK_POINT_PATTERN)]).toHaveLength(1);
  });

  it('ignores definitions, comments and strings', () => {
    const ignored = asFile('src/report/artifact-writer.ts', [
      'async writeRun(run: AuditRunResult): Promise<void> {',
      '  // acquireRunExclusion(outputDirectory) は呼び出し側',
      "  const text = 'isSessionLostUrl(url, prefix)';",
      '}',
      'export async function acquireRunExclusion(outputDirectory: string): Promise<RunExclusion> {',
      '}',
    ].join('\n'));
    expect(CALL_RULES.flatMap((candidate) => callViolations([ignored], candidate))).toEqual([]);
    expect(OWNED_FUNCTION_NAMES.flatMap((candidate) => definitionViolations([ignored], candidate))).toEqual([]);
  });

  it('(f) detects the same-name local function of another meaning, as before PRE42-CC (CC-070 (c))', () => {
    const sameName = asFile('src/control/job/job-store.ts', [
      'const isSessionLostUrl = (url: string): boolean => validate(url);',
      'if (row.session_lost_url !== null && !isSessionLostUrl(row.session_lost_url)) {',
      '}',
    ].join('\n'));
    expect(callViolations([sameName], rule('isSessionLostUrl'))).toEqual(['src/control/job/job-store.ts: isSessionLostUrl(']);
    expect(definitionViolations([sameName], OWNED_FUNCTION_NAMES[0] ?? rule('isSessionLostUrl')))
      .toEqual(['src/control/job/job-store.ts: isSessionLostUrl']);
    const functionForm = asFile('src/worker/example.ts', 'function isSessionLostUrl(url: string): boolean {\n  return false;\n}');
    expect(definitionViolations([functionForm], OWNED_FUNCTION_NAMES[0] ?? rule('isSessionLostUrl'))).toEqual(['src/worker/example.ts: isSessionLostUrl']);
    const renamed = asFile('src/control/job/job-store.ts', 'const isRecordableSessionLostUrl = (url: string): boolean => validate(url);');
    expect(definitionViolations([renamed], OWNED_FUNCTION_NAMES[0] ?? rule('isSessionLostUrl'))).toEqual([]);
  });

  it('detects the internal navigable link filter, including the negated form', () => {
    const code = (source: string): string => scanSource(source).code;
    expect(internalNavigableFilterCount(code(
      "(link.admission.kind === 'INTERNAL_NAVIGABLE' && link.normalized.ok ? [link.normalized.url] : [])",
    ))).toBe(1);
    expect(internalNavigableFilterCount(code("link.normalized.ok && link.admission.kind === 'INTERNAL_NAVIGABLE'"))).toBe(1);
    // CC-070 (b): Cross-page rule にあった否定の形（PRE42-CC の前の形）と、順が逆のもの。
    expect(internalNavigableFilterCount(code("if (link.admission.kind !== 'INTERNAL_NAVIGABLE' || !link.normalized.ok) {"))).toBe(1);
    expect(internalNavigableFilterCount(code("if (!link.normalized.ok || link.admission.kind !== 'INTERNAL_NAVIGABLE') {"))).toBe(1);
    expect(internalNavigableFilterCount(code("if (admission.kind === 'INTERNAL_NAVIGABLE') {"))).toBe(0);
    expect(internalNavigableFilterCount(code("if (admission.kind !== 'INTERNAL_NAVIGABLE') {"))).toBe(0);
    expect(internalNavigableFilterCount(code("// link.admission.kind === 'INTERNAL_NAVIGABLE' && link.normalized.ok"))).toBe(0);
    expect(internalNavigableFilterCount(code("// link.admission.kind !== 'INTERNAL_NAVIGABLE' || !link.normalized.ok"))).toBe(0);
  });

  it('(h) detects a lock file created with wx before its content is written, as before SR-1-F (DEF-168)', () => {
    const asCode = (path: string, source: string): Pick<SourceFile, 'path' | 'code'> => ({ path, code: scanSource(source).code });
    // SR-1-F の前の `#acquireLockFile` と、`#restoreMovedLock` の戻しの形。
    expect(exclusiveOpenViolations([asCode(ARTIFACT_WRITER, [
      'let handle: CheckpointFileHandle;',
      'try {',
      "  handle = await this.#fileOperations.open(path, 'wx');",
      '} catch (error) {',
      '}',
      "await writeAndSync(await this.#fileOperations.open(path, 'wx'), content);",
    ].join('\n'))])).toEqual([`${ARTIFACT_WRITER}: 2`]);
    expect(exclusiveOpenViolations([asCode('src/control/job/example.ts', "await writeFile(lockPath, JSON.stringify(lock), { flag: 'wx' });")]))
      .toEqual(['src/control/job/example.ts: 1']);
    // 一時ファイルを新しく作る形、型の除外、コメントは数えない。
    expect(exclusiveOpenViolations([asCode(ARTIFACT_WRITER, [
      "await writeAndSync(await operations.open(temporaryPath, 'wx'), data);",
      "open(path: string, flags: 'wx' | 'r'): Promise<CheckpointFileHandle>;",
      "// handle = await open(path, 'wx');",
    ].join('\n'))])).toEqual([]);
    expect(exclusiveOpenViolations([asCode('src/orchestration/preflight.ts', "await writeFile(temporaryFile, '', { flag: 'wx' });")])).toEqual([]);
    // 型の除外は、決まったファイルだけ。
    expect(exclusiveOpenViolations([asCode('src/worker/example.ts', "open(path: string, flags: 'wx' | 'r'): Promise<Handle>;")]))
      .toEqual(['src/worker/example.ts: 1']);
  });

  it('(g) detects the page record shape declared again, as before PRE42-CC (CC-070 (a))', () => {
    const bare = (source: string): string => scanSource(source).bare;
    // PRE42-CC の前の `discover-page.ts` の形（JSDoc を含む）。
    expect(pageRecordDeclarationCount(bare([
      '/** 成果物 `discovery.json` の 1 画面分の記録。 */',
      'export interface DiscoveryPageRecord {',
      '  /** 画面の Origin と path（読んだ時点の page の URL。http(s) でなければ null）。 */',
      '  readonly location: CandidateLocation | null;',
      '  /** 読み切れなかった理由（重複なし、`INCOMPLETE_REASONS` の順。読み切れたら空）。 */',
      '  readonly incompleteReasons: readonly IncompleteReason[];',
      '  /** 候補（probe の順: form（送信ボタンごと）、form の外のボタン）。 */',
      '  readonly candidates: readonly DiscoveryCandidate[];',
      '}',
    ].join('\n')))).toBe(1);
    expect(pageRecordDeclarationCount(bare(
      'type PageRecord = { readonly candidates: readonly DiscoveryCandidate[]; readonly incompleteReasons: readonly IncompleteReason[] };',
    ))).toBe(1);
    // 片方の欄だけの型、関数の引数、コメントの中は数えない。
    expect(pageRecordDeclarationCount(bare('interface CandidateView {\n  readonly incompleteReasons: readonly IncompleteReason[];\n}'))).toBe(0);
    expect(pageRecordDeclarationCount(bare(
      'const pageRecord = (incompleteReasons: readonly IncompleteReason[], candidates: readonly DiscoveryCandidate[]): Record => record;',
    ))).toBe(0);
    expect(pageRecordDeclarationCount(bare(
      '// interface Copy { readonly incompleteReasons: readonly IncompleteReason[]; readonly candidates: readonly DiscoveryCandidate[] }',
    ))).toBe(0);
  });
});

describe('run lock and session lost ownership (CCX-6, CC-070)', () => {
  it.each(CALL_RULES)('only the allowed files call $name(', (callRule) => {
    expect(callViolations(SOURCE_FILES, callRule)).toEqual([]);
  });

  it('the allowed users of the shared parts call them (the rules are not stale)', () => {
    for (const path of RUN_EXCLUSION_USERS) {
      expect(callCount(sourceFile(path).bare, 'acquireRunExclusion'), path).toBeGreaterThan(0);
    }
    expect(callCount(sourceFile(AUTHENTICATED_RUN).bare, 'isSessionLostUrl')).toBeGreaterThan(0);
    // DF-3: 判定は owner の時機の補助が呼び、Page Auditor とワーカーの 1 画面の読み込みは補助を呼ぶ。
    expect(callCount(sourceFile(AUTHENTICATED_RUN).bare, 'sessionLostUrlOf')).toBeGreaterThan(0);
    expect(callCount(sourceFile(PAGE_AUDITOR).bare, 'sessionLostUrlAt')).toBeGreaterThan(0);
    expect(callCount(sourceFile(WORKER_RUN_SESSION).bare, 'sessionLostUrlAt')).toBeGreaterThan(0);
  });

  it('(i) DF-3: the check points come only from the owner list, by name, and each reader uses its points', () => {
    const names = checkPointNamesOf(sourceFile(AUTHENTICATED_RUN).bare);
    // 一覧（SSOT）を変えたら、この表（`CHECK_POINT_READERS`）も合わせる。
    expect(names).toEqual(['navigation', 'settled', 'beforeNextLoad', 'pageEnd']);
    // 一覧を定義するのは owner だけ。
    expect(SOURCE_FILES.filter((file) => localDefinitionPattern('SESSION_LOSS_CHECK_POINTS').test(file.bare)).map((file) => file.path))
      .toEqual([AUTHENTICATED_RUN]);
    // 補助の時機を文字列で書かない。
    expect(SOURCE_FILES.filter((file) => [...file.code.matchAll(LITERAL_CHECK_POINT_PATTERN)].length > 0).map((file) => file.path)).toEqual([]);
    for (const { path, points } of CHECK_POINT_READERS) {
      expect(checkPointUsesOf(sourceFile(path).bare, names), path).toEqual(points);
    }
    // どの時機も、どこかの読み込みが使う（使われない時機を一覧に残さない）。
    expect(names.filter((name) => !CHECK_POINT_READERS.some(({ points }) => points.includes(name)))).toEqual([]);
    // 発見の流れは、落ち着きの後の確かめを呼ぶ（候補を読んだ後、リンクと probe の前）。
    expect(callCount(sourceFile(DISCOVERY_RUN).bare, 'stopIfSessionLostAfterSettling')).toBeGreaterThan(0);
  });

  it.each(OWNED_FUNCTION_NAMES)('(f) only the owner defines $name (no same-name function of another meaning)', (ownedRule) => {
    expect(definitionViolations(SOURCE_FILES, ownedRule)).toEqual([]);
    for (const path of ownedRule.allowed) {
      expect(localDefinitionPattern(ownedRule.name).test(sourceFile(path).bare), path).toBe(true);
    }
  });

  it('(e) only the crawl part filters the internal navigable links of the link Evidence, and the users call it', () => {
    const offenders = SOURCE_FILES
      .filter((file) => file.path !== INTERNAL_NAVIGABLE_LINKS && internalNavigableFilterCount(file.code) > 0)
      .map((file) => file.path);

    expect(offenders).toEqual([]);
    expect(internalNavigableFilterCount(sourceFile(INTERNAL_NAVIGABLE_LINKS).code)).toBe(1);
    // SD-1: 巡回で移る側（Run Coordinator・発見の流れ）は、削除の語のリンクを除く同じ部品の入口（`crawlableLinkUrlsOf`）を呼ぶ。
    expect(INTERNAL_NAVIGABLE_USERS.filter((path) => callCount(sourceFile(path).bare, 'internalNavigableUrlsOf') === 0
      && callCount(sourceFile(path).bare, 'crawlableLinkUrlsOf') === 0)).toEqual([]);
  });

  it('(h) creates with wx only temporary files in src/', () => {
    expect(exclusiveOpenViolations(SOURCE_FILES)).toEqual([]);
    // 除外は使われている（使われなくなった除外は誤り）。
    const exceptionKey = ({ path, reason }: ExclusiveFlagException): string => `${path}: ${reason}`;
    const usedExceptions = EXCLUSIVE_FLAG_EXCEPTIONS
      .filter((exception) => [...sourceFile(exception.path).code.matchAll(exception.pattern)].length > 0)
      .map(exceptionKey);
    expect(unusedExclusionsOf(EXCLUSIVE_FLAG_EXCEPTIONS.map(exceptionKey), usedExceptions)).toEqual([]);
    // 書き手は、一時ファイルを `wx` で作る（走査が空でない）。
    expect([...sourceFile(ARTIFACT_WRITER).code.matchAll(TEMPORARY_EXCLUSIVE_OPEN_PATTERN)].length).toBeGreaterThan(0);
  });

  it('(g) only the pure discovery result part declares the page record shape, and the discovery entry uses it', () => {
    const declarations = SOURCE_FILES
      .filter((file) => pageRecordDeclarationCount(file.bare) > 0)
      .map((file) => `${file.path}: ${String(pageRecordDeclarationCount(file.bare))}`);

    expect(declarations).toEqual([`${DISCOVERY_RESULT}: 1`]);
    expect(/\bDiscoveryReadPageRecord\b/u.test(sourceFile(DISCOVER_PAGE).bare)).toBe(true);
  });
});
