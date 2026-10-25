/**
 * ジョブの管理のテストの補助の Gate（CCX-18。CC-072。CCX-16 の `ui-test-helper-reuse` と同じ作り）。
 * - ジョブの管理のテストの補助（`tests/helpers/job-test-support.ts`、`tests/helpers/worker-fork.ts`）が公開する関数と同じ名前の関数を、
 *   結合のテストのファイル（`tests/integration/*.test.ts`）の中で定義し直さない（補助を使う）。
 * - ジョブの管理の時間の設定（`AuditJobTiming`）の全体を書き写さない（`ipcDrainWaitMs: AUDIT_JOB_IPC_DRAIN_WAIT_MS` を書くのは補助だけ。
 *   違う時間は、補助の設定の写しを上書きする）。
 * - PRE42-CC 組 6b（CC-072 の残り）: 結合のテストは、次を書き写さない（コメントは見ない）。
 *   - 偽のワーカーに埋め込む値の共通の組（`protocolVersion: WORKER_PROTOCOL_VERSION`、`exitCodes: { … }`）。`fakeWorkerValuesOf` を使う。
 *   - 偽のワーカーのジョブの管理の作り方（`createAuditJobManager(…)` の引数に `CONTROL_JOB_TEST_TIMING` を書く）。`createFakeWorkerJobManager` を使う。
 *   - 文脈の出力先の上書き（`...context.targetConfig, output:`）。`withOutputDirectory` を使う。
 * - PRE42-CC 組 UI-T（CC-072 の残り）: 範囲を画面のテスト（`apps/local-ui/tests/*.test.ts`）に広げる。画面のテストも、偽のワーカーの値の組と、
 *   偽のワーカーのジョブの管理の作り方を書き写さない。
 * - PRE42-CC 組 UI-K（CC-112）: 画面のテストで、画面のサーバの関数（`getAuditJobFn`）を通してジョブを読み直して待つ補助は、
 *   `apps/local-ui/tests/helpers/server-function-job-wait.ts` の `waitForJobViaServerFunctions` 1 つにした（補助の `waitForJob` とぶつからない名前）。
 *   その補助も調べる補助に加え、画面のテストが `waitForJob` を定義し直す除外（3 件）を消した。
 * - PRE42-CC 組 UI-K2（CC-112 の続き）: 画面のテストと画面のテストの補助（`apps/local-ui/tests/helpers/*.ts`。補助そのものを除く）は、名前に
 *   よらず、`getAuditJobFn` を読み直す繰り返し（`for (;;) { … }`・`while (…) { … }`・`expect.poll(…)` の中で読む形）を書かない。
 *   `waitForJobViaServerFunctions` を使う（待つ間の記録は、その `onPending` で渡す）。
 * - 除外は、同じ名前で別の意味の関数だけ（閉じた一覧。足すときは理由を書く）。
 * - 判定は、Node.js 標準の `fs`、正規表現、文字列の検索だけで行う。1 ファイル 1 秒以内に終える。
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_GATE_MS,
  exportedNamesOf,
  findCallSites,
  matchingBracket,
  readLfTypeScriptFilesUnder,
  scanSource,
  startCpuStopwatch,
  unusedExclusionsOf,
} from './source-scan.js';

/** 調べるテストのフォルダ（結合のテストと、組 UI-T から画面のテスト）。 */
const TEST_DIRECTORIES = Object.freeze(['tests/integration', 'apps/local-ui/tests']);
const HELPER_FILES = Object.freeze([
  'tests/helpers/job-test-support.ts',
  'tests/helpers/worker-fork.ts',
  // 組 UI-K（CC-112）: 画面のサーバの関数を通してジョブを読み直して待つ補助。
  'apps/local-ui/tests/helpers/server-function-job-wait.ts',
]);
/** 時間の設定の全体を書き写した印（補助のほかに書かない）。 */
const TIMING_COPY_MARK = 'ipcDrainWaitMs: AUDIT_JOB_IPC_DRAIN_WAIT_MS';
/** 1 つのファイルの判定の上限（ms。`source-scan.ts` の `MAX_GATE_MS`。PRE42-CC 組 G）。 */
const MAX_MS_PER_FILE = MAX_GATE_MS;

/** 組 6b: 偽のワーカーに埋め込む値の共通の組を書き写した印（コメントを除いた本文で探す）。 */
const FAKE_WORKER_VALUES_COPY_MARKS: readonly RegExp[] = Object.freeze([
  /\bprotocolVersion\s*:\s*WORKER_PROTOCOL_VERSION\b/u,
  /\bexitCodes\s*:\s*\{/u,
]);
/** 組 6b: 文脈の出力先の上書きを書き写した印。 */
const OUTPUT_OVERRIDE_COPY_MARK = /\.\.\.\s*context\.targetConfig\s*,\s*output\s*:/u;
/** 組 6b: 偽のワーカーのジョブの管理を、補助を通さずに作った印（`createAuditJobManager(…)` の引数に、テストの時間の設定がある）。 */
const JOB_MANAGER_FACTORY = 'createAuditJobManager';
const TEST_TIMING_NAME = 'CONTROL_JOB_TEST_TIMING';

/** 組 6b: 書き写しの一覧（ファイルの名前つき）。 */
const copiesIn = (fileName: string, text: string): readonly string[] => {
  const { code, bare } = scanSource(text);
  const found: string[] = [];
  for (const mark of FAKE_WORKER_VALUES_COPY_MARKS) {
    if (mark.test(code)) {
      found.push(`${fileName}: the fake worker values (${mark.source})`);
    }
  }
  if (OUTPUT_OVERRIDE_COPY_MARK.test(code)) {
    found.push(`${fileName}: the output directory override`);
  }
  if (findCallSites(bare, JOB_MANAGER_FACTORY).some(({ argumentText }) => new RegExp(String.raw`(?<![\w$])${TEST_TIMING_NAME}(?![\w$])`, 'u').test(argumentText))) {
    found.push(`${fileName}: a job manager with the test timing`);
  }
  return found;
};

/**
 * 同じ名前で別の意味の関数（リポジトリの root からのファイルのパス → 名前と理由）。組 UI-K（CC-112）: 画面のテストの `waitForJob` の 3 件は、
 * 補助 `waitForJobViaServerFunctions` に寄せたので消した（今は 0 件）。
 */
const ALLOWED_REDEFINITIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({});

/** 組 UI-K2: 画面のテストの補助のフォルダと、画面のサーバの関数でジョブを読み直して待つ、ただ 1 つの補助。 */
const UI_TEST_HELPER_DIRECTORY = 'apps/local-ui/tests/helpers';
const SERVER_FUNCTION_JOB_WAIT_HELPER = `${UI_TEST_HELPER_DIRECTORY}/server-function-job-wait.ts`;

/**
 * 読み込んだテストと補助のファイル（読み込みは 1 回だけ。改行は LF にそろえる。`source-scan.ts` の `readLfTypeScriptFilesUnder`。PRE42-CC 組 G）。
 * 名前はリポジトリの root からのパス。
 */
const LOADED_FILES = readLfTypeScriptFilesUnder([...TEST_DIRECTORIES, 'tests/helpers']).map(({ path, content }) => ({ name: path, text: content }));
/** `directory` の直下（下のフォルダを含めない）の、名前が `suffix` で終わるファイル（名前の順）。 */
const filesDirectlyUnder = (directory: string, suffix: string): readonly { readonly name: string; readonly text: string }[] =>
  LOADED_FILES.filter(({ name }) => name.startsWith(`${directory}/`) && !name.slice(directory.length + 1).includes('/') && name.endsWith(suffix));
/** 読み込んだファイルの本文（無ければ投げる。前の `readFileSync` と同じく、見るはずのファイルが無くなったことに気づく）。 */
const read = (path: string): string => {
  const file = LOADED_FILES.find(({ name }) => name === path);
  if (file === undefined) {
    throw new Error(`missing file: ${path}`);
  }
  return file.text;
};

/** 調べるテストのファイル（名前はリポジトリの root からのパス）。 */
const TEST_FILES = TEST_DIRECTORIES.flatMap((directory) => filesDirectlyUnder(directory, '.test.ts'));

const UI_HELPER_FILES = filesDirectlyUnder(UI_TEST_HELPER_DIRECTORY, '.ts').filter(({ name }) => name !== SERVER_FUNCTION_JOB_WAIT_HELPER);

/** 組 UI-K2: ジョブを読む画面のサーバの関数の名前（文字列）と、繰り返しの始まり。 */
const JOB_READ_FUNCTION = /(['"`])getAuditJobFn\1/u;
const POLLING_STARTS = /\bfor\s*\(\s*;\s*;\s*\)|\bwhile\s*\(|\bexpect\s*\.\s*poll\s*\(/gu;

/**
 * `open` の括弧（`(` か `{`）に対応する閉じ括弧の位置（近似。文字列の中の括弧は数える。`source-scan.ts` の `matchingBracket`。PRE42-CC 組 G）。
 * 見つからなければ、本文の終わり。
 */
const closingOf = (code: string, open: number): number => {
  const close = matchingBracket(code, open);
  return close < 0 ? code.length - 1 : close;
};

/** 組 UI-K2: `getAuditJobFn` を読み直す繰り返しの数（コメントを除いた本文）。 */
const jobReadPollingLoopsIn = (text: string): number => {
  const { code } = scanSource(text);
  return [...code.matchAll(POLLING_STARTS)].filter((match) => {
    const start = match.index ?? 0;
    const headerEnd = start + match[0].length - 1;
    if (match[0].startsWith('expect')) {
      return JOB_READ_FUNCTION.test(code.slice(start, closingOf(code, headerEnd) + 1));
    }
    const afterHeader = match[0].endsWith('(') ? closingOf(code, headerEnd) : headerEnd;
    const bodyOpen = code.indexOf('{', afterHeader);
    return JOB_READ_FUNCTION.test(code.slice(start, bodyOpen < 0 ? afterHeader + 1 : closingOf(code, bodyOpen) + 1));
  }).length;
};

// 補助のファイルが公開する関数と値の名前は、`source-scan.ts` の `exportedNamesOf`（公開の一覧も数える、最も広い形。PRE42-CC 組 G）。

const HELPER_NAMES: readonly string[] = HELPER_FILES.flatMap((path) => exportedNamesOf(read(path)));

/** 関数の定義（どの深さでも）: `function NAME`、`const NAME = (`・`async (`・`<T>(`・`x =>`・`function`。 */
const definesFunction = (text: string, name: string): boolean => new RegExp(
  `^[ \\t]*(?:export[ \\t]+)?(?:async[ \\t]+)?function[ \\t]*\\*?[ \\t]*${name}\\b`
  + `|^[ \\t]*(?:export[ \\t]+)?const[ \\t]+${name}[ \\t]*(?::[^=\\n]*)?=[ \\t]*(?:async[ \\t]*)?(?:\\(|<|[A-Za-z_$][\\w$]*[ \\t]*=>|function\\b)`,
  'mu',
).test(text);

describe('Gate: the job manager tests use the shared helpers (CCX-18)', () => {
  it('reads the names of the shared helpers', () => {
    expect(HELPER_NAMES).toEqual(expect.arrayContaining([
      'waitForJob', 'isJobEnded', 'expectWorkersExited', 'awaitWorkersExit', 'createCountingFork', 'blockingAfterStartFork', 'CONTROL_JOB_TEST_TIMING',
      'waitForJobViaServerFunctions',
    ]));
  });

  it('reads the test files of every scanned directory (UI-T: the integration tests and the UI tests)', () => {
    for (const directory of TEST_DIRECTORIES) {
      expect(TEST_FILES.some(({ name }) => name.startsWith(`${directory}/`)), directory).toBe(true);
    }
  });

  it('does not define again a shared helper or copy the whole job timing in an integration test or a UI test', () => {
    const stopwatch = startCpuStopwatch();
    const found: string[] = [];
    const usedExceptions = new Set<string>();
    for (const { name: fileName, text } of TEST_FILES) {
      for (const helperName of HELPER_NAMES) {
        if (!definesFunction(text, helperName)) {
          continue;
        }
        if (ALLOWED_REDEFINITIONS[fileName]?.[helperName] !== undefined) {
          usedExceptions.add(`${fileName}:${helperName}`);
          continue;
        }
        found.push(`${fileName}: ${helperName}`);
      }
      if (text.includes(TIMING_COPY_MARK)) {
        found.push(`${fileName}: the whole job timing`);
      }
      found.push(...copiesIn(fileName, text));
    }
    expect(found).toEqual([]);
    const declared = Object.entries(ALLOWED_REDEFINITIONS).flatMap(([fileName, entries]) => Object.keys(entries).map((helperName) => `${fileName}:${helperName}`));
    expect(unusedExclusionsOf(declared, usedExceptions)).toEqual([]);
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_MS_PER_FILE * TEST_FILES.length);
  });

  it('finds a redefinition and a timing copy that are placed on purpose (the control)', () => {
    expect(definesFunction('async function waitForJob(jobManager: AuditJobManager, jobId: string) {', 'waitForJob')).toBe(true);
    expect(definesFunction('async function expectWorkersExited(): Promise<void> {', 'expectWorkersExited')).toBe(true);
    expect(definesFunction('const isJobEnded = (job: AuditJobView): boolean => job.finishedAt !== null;', 'isJobEnded')).toBe(true);
    expect(definesFunction('const ended = await waitForJob(currentManager, jobId, isJobEnded);', 'waitForJob')).toBe(false);
    expect('const TEST_TIMING = Object.freeze({ ipcDrainWaitMs: AUDIT_JOB_IPC_DRAIN_WAIT_MS });'.includes(TIMING_COPY_MARK)).toBe(true);
  });

  it('finds a copy of the fake worker values, the job manager options and the output override that are placed on purpose (the control. 6b)', () => {
    expect(HELPER_NAMES).toEqual(expect.arrayContaining(['fakeWorkerValuesOf', 'FAKE_WORKER_EXIT_CODES', 'createFakeWorkerJobManager', 'withOutputDirectory']));
    expect(copiesIn('a.test.ts', 'writeFakeWorker(dir, mode, {\n  protocolVersion: WORKER_PROTOCOL_VERSION,\n  runId,\n});')).toEqual([
      String.raw`a.test.ts: the fake worker values (\bprotocolVersion\s*:\s*WORKER_PROTOCOL_VERSION\b)`,
    ]);
    expect(copiesIn('a.test.ts', 'const values = { exitCodes: { complete: EXIT_CODES.COMPLETE } };')).toEqual([
      String.raw`a.test.ts: the fake worker values (\bexitCodes\s*:\s*\{)`,
    ]);
    expect(copiesIn('a.test.ts', 'resolveContext: (path) => ({ targetConfig: { ...context.targetConfig, output: { directory: OUT } } }),')).toEqual([
      'a.test.ts: the output directory override',
    ]);
    expect(copiesIn('a.test.ts', 'manager = createAuditJobManager({\n  database,\n  timing: { ...CONTROL_JOB_TEST_TIMING, readyTimeoutMs: 1 },\n});')).toEqual([
      'a.test.ts: a job manager with the test timing',
    ]);
    // 補助を使う形と、コメントの中の印と、テストの時間の設定のない作り方（本物のワーカーや既定の時間）は、書き写しではない。
    expect(copiesIn('a.test.ts', [
      '// exitCodes: { complete } and protocolVersion: WORKER_PROTOCOL_VERSION in a comment',
      'const worker = writeFakeWorker(dir, mode, fakeWorkerValuesOf({ runId, otherRunId }));',
      'manager = createFakeWorkerJobManager({ database, workDirectory, worker, timing: CONTROL_JOB_TEST_TIMING });',
      'manager = createAuditJobManager({ database, repositoryRoot, workerPath, resolveContext });',
      'const rounds: { readonly exitCodes: readonly number[] }[] = [];',
      'expect(CONTROL_JOB_TEST_TIMING.watchdogIntervalMs).toBe(100);',
    ].join('\n'))).toEqual([]);
  });

  it('writes no polling loop over getAuditJobFn in a UI test or a UI test helper (UI-K2, CC-112; they use waitForJobViaServerFunctions)', () => {
    const stopwatch = startCpuStopwatch();
    const uiFiles = [...TEST_FILES.filter(({ name }) => name.startsWith('apps/local-ui/tests/')), ...UI_HELPER_FILES];
    expect(UI_HELPER_FILES.length).toBeGreaterThan(0);
    const found = uiFiles.filter(({ text }) => jobReadPollingLoopsIn(text) > 0).map(({ name }) => `${name}: a polling loop over getAuditJobFn`);
    expect(found).toEqual([]);
    // 補助そのものは、名前の決まった関数を持つ（空の補助で PASS しない）。
    expect(exportedNamesOf(read(SERVER_FUNCTION_JOB_WAIT_HELPER))).toContain('waitForJobViaServerFunctions');
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_MS_PER_FILE * uiFiles.length);
  });

  it('finds the polling loops over getAuditJobFn that are placed on purpose (the control. UI-K2)', () => {
    expect(jobReadPollingLoopsIn([
      'const waitForEnd = async (jobId: string) => {',
      '  const deadline = Date.now() + WAIT_LIMIT_MS;',
      '  for (;;) {',
      "    const job = await valueOf<{ active: boolean } | null>('getAuditJobFn', 'GET', { jobId });",
      '    if (job !== null && !job.active) {',
      '      return job;',
      '    }',
      '    if (Date.now() > deadline) {',
      '      throw new Error(`ジョブが終わらなかった: ${JSON.stringify(job)}`);',
      '    }',
      '  }',
      '};',
    ].join('\n'))).toBe(1);
    expect(jobReadPollingLoopsIn([
      'await expect.poll(async () => {',
      "  job = await valueOf<JobDetail | null>('getAuditJobFn', 'GET', { jobId });",
      '  return job?.active;',
      '}, { timeout: JOB_TIMEOUT_MS, interval: POLL_MS }).toBe(false);',
    ].join('\n'))).toBe(1);
    expect(jobReadPollingLoopsIn("while (Date.now() < deadline) {\n  const job = await call('getAuditJobFn', 'GET', { jobId });\n}")).toBe(1);
    // 補助を使う形、ほかの関数の繰り返し、1 回だけ読む形、コメントは数えない。
    expect(jobReadPollingLoopsIn([
      "const readJob = (jobId: string) => valueOf<JobDetail | null>('getAuditJobFn', 'GET', { jobId });",
      'const waitForEnd = (jobId: string) => waitForJobViaServerFunctions(readJob, jobId, (job) => !job.active, JOB_WAIT);',
      "for (;;) {\n  const list = await valueOf('listAuditJobsFn', 'GET');\n  if (list.length > 0) break;\n}",
      "await expect.poll(async () => (await valueOf('listAuditJobsFn', 'GET')).length).toBe(1);",
      "// for (;;) { await valueOf('getAuditJobFn', 'GET', { jobId }); }",
    ].join('\n'))).toBe(0);
  });
});
