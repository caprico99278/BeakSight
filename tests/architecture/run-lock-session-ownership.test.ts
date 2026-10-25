/**
 * 出力先の開始のロック、ロックの判定、セッションの切れの判定、内部のリンクの取り出しの Architecture Gate（CCX-6。共通化の台帳の CC-070）。
 * - (a) ロックの判定 `judgeRunLock(` を呼ぶのは、owner（`src/core/process-lock.ts`）と、決まった利用者（出力先の開始のロックと動いている Run の
 *   確かめ `src/orchestration/output-start-lock.ts`、Run のロックの保存のセッション `run-checkpoint-session.ts`、画面のサーバのロック
 *   `src/control/job/instance-lock.ts`）だけ。CLI の監査とワーカーの Run は、`output-start-lock.ts` を呼ぶ。
 * - (b) 古いロックの取り直し（`takeOverStaleLock(`、`acquireLockTakingOverStale(`）を呼ぶのは、owner と `output-start-lock.ts`、
 *   `run-checkpoint-session.ts` だけ。
 * - (c) 書き手の出力先の開始のロックの口（`acquireOutputStartLock(`、`takeOverOutputStartLock(`、`readOutputStartLock(`、
 *   `releaseOutputStartLock(`、`rewriteOutputStartLock(`）を呼ぶのは、`output-start-lock.ts` だけ（定義は `ArtifactWriter`）。
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
 * - (h) ロックのファイルの作成（SR-1-F、DEF-168）: `open(…, 'wx')`（`writeFile(…, { flag: 'wx' })` を含む）で新しく作るのは、書き出しの途中の
 *   一時ファイル（第 1 引数が `temporary…` の名前）だけ。ロックのファイルそのものを `wx` で作ってから中身を書く形（中身のないロックが外から
 *   見える）は、`src/` のどこにも書かない。ロックのファイルは、部品 `createLockFileExclusively`（`src/core/lock-file.ts`。一時ファイルに書いて
 *   `link` で作る）で作り、それを呼ぶのは書き手（`src/report/artifact-writer.ts`。作成と、動かしてしまった他人のロックの戻しと、取り直しの札
 *   の作成。DEF-170）だけ。
 * - `src/**` の読み込みは、このファイルの読み込み時に 1 回だけ行う。判定は、`fs`、正規表現、文字列の走査だけで行う（AST・TypeScript の
 *   コンパイラ API・外部ツール・子プロセス・`dist/` を使わない）。呼び出しはコメントと文字列リテラルの中を見ない（近似の検査である）。
 */
import { describe, expect, it } from 'vitest';
import { findCallSites, loadSourceFiles, scanSource, sourceFileAt, unusedExclusionsOf, type SourceFile } from './source-scan.js';

const SOURCE_FILES = loadSourceFiles();

const PROCESS_LOCK_OWNER = 'src/core/process-lock.ts';
const OUTPUT_START_LOCK = 'src/orchestration/output-start-lock.ts';
const RUN_CHECKPOINT_SESSION = 'src/orchestration/run-checkpoint-session.ts';
const INSTANCE_LOCK = 'src/control/job/instance-lock.ts';
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
  { name: 'judgeRunLock', allowed: [PROCESS_LOCK_OWNER, OUTPUT_START_LOCK, RUN_CHECKPOINT_SESSION, INSTANCE_LOCK] },
  // DEF-172: 猶予つきの判定（判定の部品は 1 つ）を呼ぶのは、owner と出力先の確かめだけ（保存のセッションは `takeOverStaleLock` を通す）。
  { name: 'judgeRunLockWithGrace', allowed: [PROCESS_LOCK_OWNER, OUTPUT_START_LOCK] },
  // SR-1-F5: いくつものロックをまとめて判定する形（待つのは 1 回だけ）も、同じ決まり。
  { name: 'judgeRunLocksWithGrace', allowed: [PROCESS_LOCK_OWNER, OUTPUT_START_LOCK] },
  { name: 'takeOverStaleLock', allowed: [PROCESS_LOCK_OWNER, OUTPUT_START_LOCK, RUN_CHECKPOINT_SESSION] },
  { name: 'acquireLockTakingOverStale', allowed: [PROCESS_LOCK_OWNER, OUTPUT_START_LOCK, RUN_CHECKPOINT_SESSION] },
  { name: 'acquireOutputStartLock', allowed: [OUTPUT_START_LOCK] },
  { name: 'takeOverOutputStartLock', allowed: [OUTPUT_START_LOCK] },
  { name: 'readOutputStartLock', allowed: [OUTPUT_START_LOCK] },
  { name: 'releaseOutputStartLock', allowed: [OUTPUT_START_LOCK] },
  { name: 'rewriteOutputStartLock', allowed: [OUTPUT_START_LOCK] },
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

/** (h) ロックのファイルの作成の部品の owner と、書き手（ファイルの操作を渡して呼ぶ唯一のファイル）。 */
const LOCK_FILE_OWNER = 'src/core/lock-file.ts';
const ARTIFACT_WRITER = 'src/report/artifact-writer.ts';
/**
 * (h) 書き手が部品を呼ぶ数（ロックの作成 `#acquireLockFile`、動かしてしまった他人のロックの戻し `#restoreMovedLock`、取り直しの札の作成
 * `createExclusiveFile`。DEF-170）。
 */
const ARTIFACT_WRITER_LOCK_CREATIONS = 3;

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

  it('detects the lock judgement and the takeover written outside the owners, as before CCX-6', () => {
    const cliCopy = asFile('src/cli/audit-run.ts', [
      'if (judgeRunLock(lock, { nowMs: host.nowMs, bootedAtMs: host.bootedAtMs, isProcessRunning }) === \'ACTIVE\') {',
      '  const takeover = await takeOverStaleLock({ acquire, takeOver }, acquisition.existing, lock, judgement);',
      '}',
    ].join('\n'));
    const workerCopy = asFile('src/worker/worker-run-session.ts', [
      'const result = await acquireLockTakingOverStale({',
      '  acquire: async (value) => await writer.acquireOutputStartLock(outputDirectory, value),',
      '  takeOver: async (judged, value) => writer.takeOverOutputStartLock(outputDirectory, judged, value),',
      '}, lock, judgement);',
      'if (isOwnRunLock(await writer.readOutputStartLock(outputDirectory), lock)) {',
      '  await writer.releaseOutputStartLock(outputDirectory, createdDirectory);',
      '}',
    ].join('\n'));
    expect(callViolations([cliCopy], rule('judgeRunLock'))).toEqual(['src/cli/audit-run.ts: judgeRunLock(']);
    expect(callViolations([cliCopy], rule('takeOverStaleLock'))).toEqual(['src/cli/audit-run.ts: takeOverStaleLock(']);
    expect(CALL_RULES.flatMap((candidate) => callViolations([workerCopy], candidate))).toEqual([
      'src/worker/worker-run-session.ts: acquireLockTakingOverStale(',
      'src/worker/worker-run-session.ts: acquireOutputStartLock(',
      'src/worker/worker-run-session.ts: takeOverOutputStartLock(',
      'src/worker/worker-run-session.ts: readOutputStartLock(',
      'src/worker/worker-run-session.ts: releaseOutputStartLock(',
    ]);
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
      'async acquireOutputStartLock(outputDirectory: string, lock: object): Promise<OutputStartLockAcquisition> {',
      '  // judgeRunLock(lock, judgement) は呼び出し側',
      "  const text = 'isSessionLostUrl(url, prefix)';",
      '}',
      'export function judgeRunLock(lock: unknown, current: RunLockJudgementInput): RunLockState {',
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
    // DEF-172: 出力先の開始のロックと動いている Run の確かめは、猶予つきの判定（`judgeRunLockWithGrace`）を使う。
    expect(callCount(sourceFile(OUTPUT_START_LOCK).bare, 'judgeRunLocksWithGrace')).toBeGreaterThan(0);
    expect(callCount(sourceFile(OUTPUT_START_LOCK).bare, 'acquireLockTakingOverStale')).toBeGreaterThan(0);
    expect(callCount(sourceFile(OUTPUT_START_LOCK).bare, 'acquireOutputStartLock')).toBeGreaterThan(0);
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
    expect(INTERNAL_NAVIGABLE_USERS.filter((path) => callCount(sourceFile(path).bare, 'internalNavigableUrlsOf') === 0)).toEqual([]);
  });

  it('(h) creates with wx only temporary files in src/, and creates the lock files only through createLockFileExclusively', () => {
    expect(exclusiveOpenViolations(SOURCE_FILES)).toEqual([]);
    // 除外は使われている（使われなくなった除外は誤り）。
    const exceptionKey = ({ path, reason }: ExclusiveFlagException): string => `${path}: ${reason}`;
    const usedExceptions = EXCLUSIVE_FLAG_EXCEPTIONS
      .filter((exception) => [...sourceFile(exception.path).code.matchAll(exception.pattern)].length > 0)
      .map(exceptionKey);
    expect(unusedExclusionsOf(EXCLUSIVE_FLAG_EXCEPTIONS.map(exceptionKey), usedExceptions)).toEqual([]);
    // 書き手は、一時ファイルを `wx` で作る（走査が空でない）。
    expect([...sourceFile(ARTIFACT_WRITER).code.matchAll(TEMPORARY_EXCLUSIVE_OPEN_PATTERN)].length).toBeGreaterThan(0);
    expect(SOURCE_FILES.filter((file) => callCount(file.bare, 'createLockFileExclusively') > 0).map((file) => file.path)).toEqual([ARTIFACT_WRITER]);
    expect(callCount(sourceFile(ARTIFACT_WRITER).bare, 'createLockFileExclusively')).toBe(ARTIFACT_WRITER_LOCK_CREATIONS);
    expect(localDefinitionPattern('createLockFileExclusively').test(sourceFile(LOCK_FILE_OWNER).bare)).toBe(true);
    // 部品は、一時ファイルに書いてから `link` で作る（`open` で作らない）。
    expect(/\boperations\.writeNew\s*\([\s\S]*?\boperations\.link\s*\(/u.test(sourceFile(LOCK_FILE_OWNER).bare)).toBe(true);
    expect(/\bopen\s*\(/u.test(sourceFile(LOCK_FILE_OWNER).bare)).toBe(false);
  });

  it('(g) only the pure discovery result part declares the page record shape, and the discovery entry uses it', () => {
    const declarations = SOURCE_FILES
      .filter((file) => pageRecordDeclarationCount(file.bare) > 0)
      .map((file) => `${file.path}: ${String(pageRecordDeclarationCount(file.bare))}`);

    expect(declarations).toEqual([`${DISCOVERY_RESULT}: 1`]);
    expect(/\bDiscoveryReadPageRecord\b/u.test(sourceFile(DISCOVER_PAGE).bare)).toBe(true);
  });
});
