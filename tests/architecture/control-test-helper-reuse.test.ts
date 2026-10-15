/**
 * ジョブの管理のテストの補助の Gate（CCX-18。CC-072。CCX-16 の `ui-test-helper-reuse` と同じ作り）。
 * - ジョブの管理のテストの補助（`tests/helpers/job-test-support.ts`、`tests/helpers/worker-fork.ts`）が公開する関数と同じ名前の関数を、
 *   結合のテストのファイル（`tests/integration/*.test.ts`）の中で定義し直さない（補助を使う）。
 * - ジョブの管理の時間の設定（`AuditJobTiming`）の全体を書き写さない（`ipcDrainWaitMs: AUDIT_JOB_IPC_DRAIN_WAIT_MS` を書くのは補助だけ。
 *   違う時間は、補助の設定の写しを上書きする）。
 * - 除外はない（閉じた一覧。足すときは理由を書く）。
 * - 判定は、Node.js 標準の `fs`、正規表現、文字列の検索だけで行う。1 ファイル 1 秒以内に終える。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const INTEGRATION_DIRECTORY = 'tests/integration';
const HELPER_FILES = Object.freeze(['tests/helpers/job-test-support.ts', 'tests/helpers/worker-fork.ts']);
/** 時間の設定の全体を書き写した印（補助のほかに書かない）。 */
const TIMING_COPY_MARK = 'ipcDrainWaitMs: AUDIT_JOB_IPC_DRAIN_WAIT_MS';
/** 1 つのファイルの判定の上限（ms）。 */
const MAX_MS_PER_FILE = 1_000;

/** 同じ名前で別の意味の関数（ファイルの名前 → 名前と理由）。今は空。 */
const ALLOWED_REDEFINITIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({});

const read = (path: string): string => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');

const TEST_FILES = readdirSync(INTEGRATION_DIRECTORY).filter((name) => name.endsWith('.test.ts')).sort()
  .map((name) => ({ name, text: read(join(INTEGRATION_DIRECTORY, name)) }));

/** 補助のファイルが公開する関数と値の名前。 */
const exportedNamesOf = (text: string): readonly string[] =>
  [...text.matchAll(/^export\s+(?:async\s+)?(?:function\s*\*?|const)\s+([A-Za-z_$][\w$]*)/gmu)].map((match) => match[1] ?? '');

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
    ]));
  });

  it('does not define again a shared helper or copy the whole job timing in an integration test', () => {
    const started = performance.now();
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
    }
    expect(found).toEqual([]);
    const declared = Object.entries(ALLOWED_REDEFINITIONS).flatMap(([fileName, entries]) => Object.keys(entries).map((helperName) => `${fileName}:${helperName}`));
    expect(declared.filter((entry) => !usedExceptions.has(entry))).toEqual([]);
    expect(performance.now() - started).toBeLessThan(MAX_MS_PER_FILE * TEST_FILES.length);
  });

  it('finds a redefinition and a timing copy that are placed on purpose (the control)', () => {
    expect(definesFunction('async function waitForJob(jobManager: AuditJobManager, jobId: string) {', 'waitForJob')).toBe(true);
    expect(definesFunction('async function expectWorkersExited(): Promise<void> {', 'expectWorkersExited')).toBe(true);
    expect(definesFunction('const isJobEnded = (job: AuditJobView): boolean => job.finishedAt !== null;', 'isJobEnded')).toBe(true);
    expect(definesFunction('const ended = await waitForJob(currentManager, jobId, isJobEnded);', 'waitForJob')).toBe(false);
    expect('const TEST_TIMING = Object.freeze({ ipcDrainWaitMs: AUDIT_JOB_IPC_DRAIN_WAIT_MS });'.includes(TIMING_COPY_MARK)).toBe(true);
  });
});
