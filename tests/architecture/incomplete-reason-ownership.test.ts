/**
 * 未完了の理由の確かめと、保存からの巡回の記録の作り直しの Architecture Gate（CCX-1。共通化の台帳の CC-034、CC-040）。
 * - (a) 未完了の理由のコードの閉じた一覧（`INCOMPLETE_REASON_CODES`）に入っているかの確かめは、owner（`src/core/contracts.ts`）の
 *   `isIncompleteReasonCode`・`isIncompleteReason` だけが行う。owner の外の `src/**` に、`INCOMPLETE_REASON_CODES` に対する
 *   `.includes(`・`.indexOf(`・`.has(`（型の言い換え `as …` と括弧を挟むものを含む）と、`new Set(INCOMPLETE_REASON_CODES)` を書かない。
 *   owner の外に、同じ名前の確かめの関数（`isIncompleteReasonCode` など）を定義しない。
 * - (b) 再開のときに待ち行列に戻す理由の Set（`new Set(RESUME_REQUEUE_SKIP_REASON_CODES)`）は、`src/orchestration/run-checkpoint.ts` に
 *   1つだけ置く。
 * - (c) 保存からの巡回の記録の作り直し（`CrawlFrontier.restore(`）は、`src/orchestration/run-checkpoint.ts` の
 *   `restoreRunCheckpointCrawl` の1か所だけが呼ぶ。Run Coordinator と整合の確かめは、`restoreRunCheckpointCrawl` を呼ぶ。
 * - (d) 元の場所（`skipped-page.ts`、`crawl-frontier.ts`）は、owner の確かめの関数を呼ぶ。
 * - `src/**` の読み込みは、このファイルの読み込み時に 1 回だけ行う。判定は、`fs`、正規表現、文字列の走査だけで行う（AST・TypeScript の
 *   コンパイラ API・外部ツール・子プロセス・`dist/` を使わない）。コメントと文字列リテラルの中身は見ない（近似の検査である）。
 */
import { describe, expect, it } from 'vitest';
import { countIdentifier, findCallSites, loadSourceFiles, scanSource, type SourceFile } from './source-scan.js';

const SOURCE_FILES = loadSourceFiles();

/** 未完了の理由のコードの閉じた一覧と、その確かめの関数の owner。 */
const INCOMPLETE_REASON_OWNER = 'src/core/contracts.ts';
/** 待ち行列に戻す理由の Set と、保存からの巡回の記録の作り直しの owner。 */
const CRAWL_RESTORE_OWNER = 'src/orchestration/run-checkpoint.ts';
const RUN_COORDINATOR = 'src/orchestration/run-coordinator.ts';
const SKIPPED_PAGE = 'src/orchestration/skipped-page.ts';
const CRAWL_FRONTIER = 'src/orchestration/crawl-frontier.ts';

/** 保存からの巡回の記録の作り直しの関数（owner が export する）。 */
const CRAWL_RESTORE_FUNCTION = 'restoreRunCheckpointCrawl';

/** owner の確かめの関数の名前（owner の外では定義しない）。 */
const OWNER_CHECK_FUNCTIONS: readonly string[] = ['isIncompleteReasonCode', 'isIncompleteReasonDetail', 'isIncompleteReason'];

/**
 * `INCOMPLETE_REASON_CODES` の要素の確かめ（`bare` に当てる）。`INCOMPLETE_REASON_CODES.includes(`、
 * `(INCOMPLETE_REASON_CODES as readonly string[]).includes(`、`.indexOf(`、`.has(` と、Set への写し（`new Set(…INCOMPLETE_REASON_CODES`）。
 */
const INCOMPLETE_REASON_MEMBERSHIP_PATTERNS: readonly RegExp[] = [
  /(?<![\w$])INCOMPLETE_REASON_CODES(?:\s+as\s+[\w\s.<>[\]|]+?)?\s*\)?\s*\??\.\s*(?:includes|indexOf|has)\s*\(/gu,
  /\bnew\s+Set\s*(?:<[^<>()]*>)?\s*\(\s*(?:\[\s*\.\.\.\s*)?INCOMPLETE_REASON_CODES(?![\w$])/gu,
];

/** 待ち行列に戻す理由の Set（`bare` に当てる）。 */
const REQUEUE_SET_PATTERN = /\bnew\s+Set\s*(?:<[^<>()]*>)?\s*\(\s*(?:\[\s*\.\.\.\s*)?RESUME_REQUEUE_SKIP_REASON_CODES(?![\w$])/gu;

/** 保存からの巡回の記録の作り直しの呼び出し（`bare` に当てる）。 */
const CRAWL_FRONTIER_RESTORE_PATTERN = /(?<![\w$])CrawlFrontier\s*\.\s*restore\s*\(/gu;

/** owner の確かめの関数の定義（`const name =`、`function name(`、`let name =`）。`bare` に当てる。 */
const definitionPattern = (name: string): RegExp => new RegExp(String.raw`\b(?:const|let|var|function)\s+${name}(?![\w$])`, 'gu');

const countMatches = (text: string, pattern: RegExp): number => [...text.matchAll(pattern)].length;

const findMembershipChecks = (bare: string): number =>
  INCOMPLETE_REASON_MEMBERSHIP_PATTERNS.reduce((total, pattern) => total + countMatches(bare, pattern), 0);

const findOwnerCheckDefinitions = (bare: string): readonly string[] =>
  OWNER_CHECK_FUNCTIONS.filter((name) => countMatches(bare, definitionPattern(name)) > 0);

const bareOf = (source: string): string => scanSource(source).bare;

const sourceFile = (path: string): SourceFile => {
  const file = SOURCE_FILES.find((candidate) => candidate.path === path);
  expect(file, path).toBeDefined();
  return file ?? { path, content: '', ...scanSource('') };
};

describe('incomplete reason ownership detectors (CCX-1)', () => {
  it('detects membership checks against INCOMPLETE_REASON_CODES, as written before CC-034', () => {
    expect(findMembershipChecks(bareOf('typeof value === \'string\' && (INCOMPLETE_REASON_CODES as readonly string[]).includes(value);'))).toBe(1);
    expect(findMembershipChecks(bareOf('|| !(INCOMPLETE_REASON_CODES as readonly unknown[]).includes(reason.code)'))).toBe(1);
    expect(findMembershipChecks(bareOf('INCOMPLETE_REASON_CODES.includes(code)'))).toBe(1);
    expect(findMembershipChecks(bareOf('INCOMPLETE_REASON_CODES.indexOf(code) >= 0'))).toBe(1);
    expect(findMembershipChecks(bareOf('const CODES = new Set(INCOMPLETE_REASON_CODES);\nCODES.has(code);'))).toBe(1);
    expect(findMembershipChecks(bareOf('const CODES: ReadonlySet<string> = new Set<string>([...INCOMPLETE_REASON_CODES]);'))).toBe(1);
  });

  it('ignores other uses of INCOMPLETE_REASON_CODES, comments and strings', () => {
    expect(findMembershipChecks(bareOf('export type IncompleteReasonCode = (typeof INCOMPLETE_REASON_CODES)[number];'))).toBe(0);
    expect(findMembershipChecks(bareOf('INCOMPLETE_REASON_CODES.map((code) => code);'))).toBe(0);
    expect(findMembershipChecks(bareOf('// INCOMPLETE_REASON_CODES.includes(code)\nconst a = 1;'))).toBe(0);
    expect(findMembershipChecks(bareOf("const text = 'INCOMPLETE_REASON_CODES.includes(code)';"))).toBe(0);
    expect(findMembershipChecks(bareOf('OTHER_INCOMPLETE_REASON_CODES.includes(code)'))).toBe(0);
  });

  it('detects local definitions of the owner check functions', () => {
    expect(findOwnerCheckDefinitions(bareOf('const isIncompleteReasonCode = (value: unknown): value is IncompleteReasonCode =>'))).toEqual([
      'isIncompleteReasonCode',
    ]);
    expect(findOwnerCheckDefinitions(bareOf('function isIncompleteReason(value: unknown) {}'))).toEqual(['isIncompleteReason']);
    expect(findOwnerCheckDefinitions(bareOf('import { isIncompleteReason } from \'../core/contracts.js\';\nisIncompleteReason(x);'))).toEqual([]);
  });

  it('detects the requeue Set and the direct crawl frontier restoration, as written before CC-040', () => {
    expect(countMatches(
      bareOf('const SET: ReadonlySet<IncompleteReasonCode> = new Set(RESUME_REQUEUE_SKIP_REASON_CODES);'),
      REQUEUE_SET_PATTERN,
    )).toBe(1);
    expect(countMatches(bareOf('const frontier = CrawlFrontier.restore(saved.frontier, {'), CRAWL_FRONTIER_RESTORE_PATTERN)).toBe(1);
    expect(countMatches(bareOf('static restore(snapshot: StoredCrawlFrontierSnapshot): CrawlFrontier {'), CRAWL_FRONTIER_RESTORE_PATTERN)).toBe(0);
  });
});

describe('incomplete reason ownership (CCX-1, CC-034)', () => {
  it('keeps membership checks against INCOMPLETE_REASON_CODES in the owner only', () => {
    const offenders = SOURCE_FILES
      .filter((file) => file.path !== INCOMPLETE_REASON_OWNER && findMembershipChecks(file.bare) > 0)
      .map((file) => file.path);

    expect(offenders).toEqual([]);
    expect(findMembershipChecks(sourceFile(INCOMPLETE_REASON_OWNER).bare)).toBeGreaterThan(0);
  });

  it('defines the incomplete reason check functions in the owner only', () => {
    const offenders = SOURCE_FILES
      .filter((file) => file.path !== INCOMPLETE_REASON_OWNER)
      .flatMap((file) => findOwnerCheckDefinitions(file.bare).map((name) => `${file.path}: ${name}`));

    expect(offenders).toEqual([]);
    expect(findOwnerCheckDefinitions(sourceFile(INCOMPLETE_REASON_OWNER).bare)).toEqual(OWNER_CHECK_FUNCTIONS);
  });

  it('makes the skipped page result and the crawl frontier restoration use the owner checks', () => {
    expect(findCallSites(sourceFile(SKIPPED_PAGE).bare, 'isIncompleteReason').length).toBeGreaterThan(0);
    expect(findCallSites(sourceFile(CRAWL_FRONTIER).bare, 'isIncompleteReasonCode').length).toBeGreaterThan(0);
    expect(findCallSites(sourceFile(CRAWL_FRONTIER).bare, 'isIncompleteReasonDetail').length).toBeGreaterThan(0);
  });
});

describe('crawl restoration ownership (CCX-1, CC-040)', () => {
  it('keeps the Set of RESUME_REQUEUE_SKIP_REASON_CODES once, in run-checkpoint.ts', () => {
    const sets = SOURCE_FILES
      .filter((file) => countMatches(file.bare, REQUEUE_SET_PATTERN) > 0)
      .map((file) => `${file.path} (${countMatches(file.bare, REQUEUE_SET_PATTERN)})`);

    expect(sets).toEqual([`${CRAWL_RESTORE_OWNER} (1)`]);
  });

  it('restores the crawl frontier from a checkpoint in restoreRunCheckpointCrawl only', () => {
    const restorations = SOURCE_FILES
      .filter((file) => countMatches(file.bare, CRAWL_FRONTIER_RESTORE_PATTERN) > 0)
      .map((file) => `${file.path} (${countMatches(file.bare, CRAWL_FRONTIER_RESTORE_PATTERN)})`);

    expect(restorations).toEqual([`${CRAWL_RESTORE_OWNER} (1)`]);
  });

  it('makes the Run Coordinator and the consistency check use restoreRunCheckpointCrawl', () => {
    expect(findCallSites(sourceFile(RUN_COORDINATOR).bare, CRAWL_RESTORE_FUNCTION).length).toBeGreaterThan(0);
    expect(countIdentifier(sourceFile(RUN_COORDINATOR).bare, 'RESUME_REQUEUE_SKIP_REASON_CODES')).toBe(0);
    expect(findCallSites(sourceFile(CRAWL_RESTORE_OWNER).bare, CRAWL_RESTORE_FUNCTION).length).toBeGreaterThan(0);
  });
});
