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
 *   判定 `sessionLostUrlOf(` を呼ぶのは、Page Auditor とワーカーの 1 画面の読み込み（`src/worker/worker-run-session.ts`）だけ。
 * - (e) Link の Evidence の受け入れの判定が `INTERNAL_NAVIGABLE` で正規化が `ok` のものを取り出す式は、Run Coordinator
 *   （`internalNavigableUrlsOf`）だけに書く。
 * - `src/**` の読み込みは、このファイルの読み込み時に 1 回だけ行う。判定は、`fs`、正規表現、文字列の走査だけで行う（AST・TypeScript の
 *   コンパイラ API・外部ツール・子プロセス・`dist/` を使わない）。呼び出しはコメントと文字列リテラルの中を見ない（近似の検査である）。
 */
import { describe, expect, it } from 'vitest';
import { findCallSites, loadSourceFiles, scanSource, type SourceFile } from './source-scan.js';

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
const RUN_COORDINATOR = 'src/orchestration/run-coordinator.ts';

/**
 * 同じ名前の、意味の違う関数を定義して呼ぶファイル（呼び出しの検出から除く。値は理由）。除外が古くなっていないこと（そのファイルが、
 * 同じ名前の関数を自分で定義していること）を確かめる。
 */
const SAME_NAME_LOCAL_FUNCTIONS: ReadonlyMap<string, { readonly name: string; readonly reason: string }> = new Map([
  [
    'src/control/job/job-store.ts',
    {
      name: 'isSessionLostUrl',
      reason: '保存の行の `session_lost_url` が、IPC の契約の URL の形かの確かめ（`validateWorkerToParentMessage`）。セッションの切れの判定ではない',
    },
  ],
]);

/** 呼んでよいファイルの決まり。 */
interface CallRule {
  readonly name: string;
  readonly allowed: readonly string[];
}

const CALL_RULES: readonly CallRule[] = [
  { name: 'judgeRunLock', allowed: [PROCESS_LOCK_OWNER, OUTPUT_START_LOCK, RUN_CHECKPOINT_SESSION, INSTANCE_LOCK] },
  { name: 'takeOverStaleLock', allowed: [PROCESS_LOCK_OWNER, OUTPUT_START_LOCK, RUN_CHECKPOINT_SESSION] },
  { name: 'acquireLockTakingOverStale', allowed: [PROCESS_LOCK_OWNER, OUTPUT_START_LOCK, RUN_CHECKPOINT_SESSION] },
  { name: 'acquireOutputStartLock', allowed: [OUTPUT_START_LOCK] },
  { name: 'takeOverOutputStartLock', allowed: [OUTPUT_START_LOCK] },
  { name: 'readOutputStartLock', allowed: [OUTPUT_START_LOCK] },
  { name: 'releaseOutputStartLock', allowed: [OUTPUT_START_LOCK] },
  { name: 'rewriteOutputStartLock', allowed: [OUTPUT_START_LOCK] },
  { name: 'isSessionLostUrl', allowed: [AUTHENTICATED_RUN] },
  { name: 'sessionLostUrlOf', allowed: [PAGE_AUDITOR, WORKER_RUN_SESSION, WRITE_CREATE_RUN] },
];

/** 同じ名前の関数の、ファイルの中の定義（`const name =`、`function name(`）。`bare` に当てる。 */
const localDefinitionPattern = (name: string): RegExp => new RegExp(String.raw`\b(?:const|let|var|function)\s+${name}(?![\w$])`, 'u');

/** `name(` の呼び出しの数（`bare` に当てる。定義は数えない）。 */
const callCount = (bare: string, name: string): number => findCallSites(bare, name).length;

/** 決まりに反する呼び出しの一覧（`<ファイル>: <名前>(`）。 */
const callViolations = (files: readonly Pick<SourceFile, 'path' | 'bare'>[], rule: CallRule): readonly string[] =>
  files
    .filter((file) => !rule.allowed.includes(file.path))
    .filter((file) => SAME_NAME_LOCAL_FUNCTIONS.get(file.path)?.name !== rule.name)
    .filter((file) => callCount(file.bare, rule.name) > 0)
    .map((file) => `${file.path}: ${rule.name}(`);

/**
 * Link の Evidence から、`INTERNAL_NAVIGABLE` で正規化が `ok` のものを選ぶ式（`code` に当てる。文字列の中を含む）。
 * `….admission.kind === 'INTERNAL_NAVIGABLE' && ….normalized.ok`（順が逆のものを含む）。
 */
const INTERNAL_NAVIGABLE_FILTER_PATTERNS: readonly RegExp[] = [
  /\bkind\s*===\s*(['"`])INTERNAL_NAVIGABLE\1\s*&&\s*[\w$.?]*normalized\s*\??\.\s*ok\b/gu,
  /\bnormalized\s*\??\.\s*ok\s*&&\s*[\w$.?]*kind\s*===\s*(['"`])INTERNAL_NAVIGABLE\1/gu,
];
const internalNavigableFilterCount = (code: string): number =>
  INTERNAL_NAVIGABLE_FILTER_PATTERNS.reduce((total, pattern) => total + [...code.matchAll(pattern)].length, 0);

const sourceFile = (path: string): SourceFile => {
  const file = SOURCE_FILES.find((candidate) => candidate.path === path);
  expect(file, path).toBeDefined();
  return file ?? { path, content: '', ...scanSource('') };
};

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
  });

  it('ignores definitions, comments, strings and the same-name local function of another meaning', () => {
    const ignored = asFile('src/report/artifact-writer.ts', [
      'async acquireOutputStartLock(outputDirectory: string, lock: object): Promise<OutputStartLockAcquisition> {',
      '  // judgeRunLock(lock, judgement) は呼び出し側',
      "  const text = 'isSessionLostUrl(url, prefix)';",
      '}',
      'export function judgeRunLock(lock: unknown, current: RunLockJudgementInput): RunLockState {',
      '}',
    ].join('\n'));
    expect(CALL_RULES.flatMap((candidate) => callViolations([ignored], candidate))).toEqual([]);
    const sameName = asFile('src/control/job/job-store.ts', [
      'const isSessionLostUrl = (url: string): boolean => validate(url);',
      'if (!isSessionLostUrl(row.session_lost_url)) {',
      '}',
    ].join('\n'));
    expect(callViolations([sameName], rule('isSessionLostUrl'))).toEqual([]);
  });

  it('detects the internal navigable link filter', () => {
    const code = (source: string): string => scanSource(source).code;
    expect(internalNavigableFilterCount(code(
      "(link.admission.kind === 'INTERNAL_NAVIGABLE' && link.normalized.ok ? [link.normalized.url] : [])",
    ))).toBe(1);
    expect(internalNavigableFilterCount(code("link.normalized.ok && link.admission.kind === 'INTERNAL_NAVIGABLE'"))).toBe(1);
    expect(internalNavigableFilterCount(code("if (admission.kind === 'INTERNAL_NAVIGABLE') {"))).toBe(0);
    expect(internalNavigableFilterCount(code("// link.admission.kind === 'INTERNAL_NAVIGABLE' && link.normalized.ok"))).toBe(0);
  });
});

describe('run lock and session lost ownership (CCX-6, CC-070)', () => {
  it.each(CALL_RULES)('only the allowed files call $name(', (callRule) => {
    expect(callViolations(SOURCE_FILES, callRule)).toEqual([]);
  });

  it('the allowed users of the shared parts call them (the rules are not stale)', () => {
    expect(callCount(sourceFile(OUTPUT_START_LOCK).bare, 'judgeRunLock')).toBeGreaterThan(0);
    expect(callCount(sourceFile(OUTPUT_START_LOCK).bare, 'acquireLockTakingOverStale')).toBeGreaterThan(0);
    expect(callCount(sourceFile(OUTPUT_START_LOCK).bare, 'acquireOutputStartLock')).toBeGreaterThan(0);
    expect(callCount(sourceFile(AUTHENTICATED_RUN).bare, 'isSessionLostUrl')).toBeGreaterThan(0);
    expect(callCount(sourceFile(PAGE_AUDITOR).bare, 'sessionLostUrlOf')).toBeGreaterThan(0);
    expect(callCount(sourceFile(WORKER_RUN_SESSION).bare, 'sessionLostUrlOf')).toBeGreaterThan(0);
  });

  it('the same-name local functions of another meaning are still defined there (the exclusions are not stale)', () => {
    for (const [path, { name }] of SAME_NAME_LOCAL_FUNCTIONS) {
      expect(localDefinitionPattern(name).test(sourceFile(path).bare), path).toBe(true);
    }
  });

  it('only the Run Coordinator filters the internal navigable links of the link Evidence', () => {
    const offenders = SOURCE_FILES
      .filter((file) => file.path !== RUN_COORDINATOR && internalNavigableFilterCount(file.code) > 0)
      .map((file) => file.path);

    expect(offenders).toEqual([]);
    expect(internalNavigableFilterCount(sourceFile(RUN_COORDINATOR).code)).toBe(1);
  });
});
