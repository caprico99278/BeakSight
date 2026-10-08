// R17f（Task 14〜17 の設計書 第7章、6.1.1、6.1.8。R17 の指摘2）: 確定した `AuditRunResult` から、書き出し、表示用モデル、終了コードまでを
// 行う関数（`finishAuditRun`）。終了コードは、`ArtifactWriter.writeRun` がスキーマの検証で導き直した後の Run Status から決める。
// ブラウザは起動しない（Run Coordinator は使わない）。
// P18d（R17r の Minor-2）: 本番の `run`（`runAuditCommand`）が、Run Coordinator の後の書き出しと終了コードを `finishAuditRun` に
// 任せることも、Run Coordinator を差し替える口（`createRunCoordinator`）で確かめる。
// R5a（中断した Run の再開の設計書 4.7、4.7.1）: 偽の Run Coordinator は、保存の終わり方（`checkpointConclusion()`）も返す。`run` が、保存の
// セッションと止める印を Run Coordinator に渡すことと、本番の Browser の起動が Playwright の既定のシグナルの処理を止めることも確かめる。
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { chromium, type Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CHROMIUM_PRELOADING_DISABLED_ARGS, CHROMIUM_SHARED_WORKERS_DISABLED_ARGS } from '../../src/browser/chromium-launch.js';
import { EXIT_CODES } from '../../src/cli/exit-codes.js';
import { runNoticeLines } from '../../src/cli/output.js';
import { finishAuditRun, PRODUCTION_RUN_DEPENDENCIES, runAuditCommand } from '../../src/cli/run-command.js';
import {
  LEGACY_BUNDLE_FILE_NAME,
  RUN_ARTIFACT_FILE_NAMES,
  artifactFilePath,
  bundleFileName,
  isBundleFileName,
  runArtifactDirectory,
} from '../../src/core/artifact-layout.js';
import type { PageAuditResult, RunSummary } from '../../src/core/contracts.js';
import { deriveRunStatus } from '../../src/core/status.js';
import { RunCheckpointSession } from '../../src/orchestration/run-checkpoint-session.js';
import {
  SITE_UNAVAILABLE_RECHECK_DELAYS_MS,
  type RunCoordinatorCheckpointConclusion,
  type RunCoordinatorDependencies,
  type RunNotice,
} from '../../src/orchestration/run-coordinator.js';
import { RUN_STATUS_CATALOG } from '../../src/presentation/catalog.js';
import { CLI_TEXT, labelWithCodeText } from '../../src/presentation/messages.js';
import { auditRun } from '../helpers/audit-run-fixture.js';
import { captureCliOutput } from '../helpers/run-harness.js';
import { createTestConfig } from '../helpers/test-config.js';

let workDirectory: string;

beforeAll(async () => {
  workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-run-command-'));
});

afterAll(async () => {
  await rm(workDirectory, { recursive: true, force: true });
});

/** Run の最後の実行の終わりの時刻から作った、ChatGPT 用バンドルの名前（BN1。バンドルのファイル名の設計書 2.1）。 */
const lastBundleFileName = (run: Pick<RunSummary, 'executions'>): string =>
  bundleFileName(run.executions[run.executions.length - 1]?.finishedAt ?? '');

/** `auditRun()` の既定のページに、page のスキーマにない項目を加えた Run。`run.runStatus` と `statusInput` は、COMPLETE のまま。 */
function schemaInvalidRun() {
  const [firstPage] = auditRun().pages;
  if (firstPage === undefined) {
    throw new Error('the fixture has no page');
  }
  return auditRun({ pages: [{ ...firstPage, unexpectedField: true } as PageAuditResult] });
}

describe('finishAuditRun: the exit code comes from the Run Status after the schema validation (R17 finding 2)', () => {
  it('exits with 2 (PARTIAL) for a Run whose page does not match the schema, although the Run was COMPLETE before writing', async () => {
    const result = schemaInvalidRun();
    expect(result.run.runStatus).toBe('COMPLETE');
    expect(deriveRunStatus(result.statusInput)).toBe('COMPLETE');
    const outputDirectory = join(workDirectory, 'invalid');
    const stdout = captureCliOutput();

    const code = await finishAuditRun(result, outputDirectory, stdout.output);

    expect(code).toBe(EXIT_CODES.PARTIAL);
    const runDirectory = runArtifactDirectory(outputDirectory, result.run.runId);
    const run = JSON.parse(await readFile(join(runDirectory, RUN_ARTIFACT_FILE_NAMES.run), 'utf8')) as RunSummary;
    expect(run.runStatus).toBe('PARTIAL');
    expect(run.incompleteReasons.map(({ code: reasonCode }) => reasonCode)).toContain('REQUIRED_ARTIFACT_INVALID');
    // 表示も、導き直した後の Run Status で示す。
    expect(stdout.text()).toContain(labelWithCodeText(RUN_STATUS_CATALOG.PARTIAL.label, 'PARTIAL'));
    expect(stdout.text()).not.toContain(labelWithCodeText(RUN_STATUS_CATALOG.COMPLETE.label, 'COMPLETE'));
    expect(stdout.text()).toContain(runDirectory);
  });

  it('exits with 0 (COMPLETE) for a Run whose artifacts match their schemas, and writes the report and the bundle', async () => {
    const result = auditRun();
    const outputDirectory = join(workDirectory, 'valid');
    const stdout = captureCliOutput();

    const code = await finishAuditRun(result, outputDirectory, stdout.output);

    expect(code).toBe(EXIT_CODES.COMPLETE);
    const runDirectory = runArtifactDirectory(outputDirectory, result.run.runId);
    for (const file of [...Object.values(RUN_ARTIFACT_FILE_NAMES), lastBundleFileName(result.run)]) {
      await expect(readFile(join(runDirectory, file))).resolves.toBeInstanceOf(Buffer);
    }
    expect(stdout.text()).toContain(labelWithCodeText(RUN_STATUS_CATALOG.COMPLETE.label, 'COMPLETE'));
  });
});

// BN1（バンドルのファイル名の設計書 2.2、4）: Run の後、Run のディレクトリには、最後の実行の終わりの時刻の名前のバンドルが1つだけある。
// 中断した Run を再開して書き出した後も1つだけで、名前は、再開した実行の終わりの時刻になる（前の回のバンドルと、前の形の名前のバンドルは消える）。
describe('finishAuditRun: only the newest bundle is left in the run directory (bundle file name design 2.2)', () => {
  const bundlesIn = async (runDirectory: string): Promise<readonly string[]> => (await readdir(runDirectory)).filter(isBundleFileName);

  it('leaves one bundle named with the end of the execution after a Run, and one named with the end of the resumed execution after a resume', async () => {
    const outputDirectory = join(workDirectory, 'bundle-name');
    const first = auditRun();
    const [firstExecution] = first.run.executions;
    const resumed = auditRun({
      run: {
        executions: [
          { ...firstExecution, endReason: 'STOPPED_BY_RUNTIME_LIMIT' },
          { startedAt: '2026-10-08T03:00:00.000Z', finishedAt: '2026-10-08T03:09:30.000Z', endReason: 'COMPLETED' },
        ],
        finishedAt: '2026-10-08T03:09:30.000Z',
      },
    });
    const runDirectory = runArtifactDirectory(outputDirectory, first.run.runId);

    // 最初の実行。前の形の名前のバンドル（この変更の前の版が書いたもの）が残っている Run のディレクトリに書く。
    await mkdir(runDirectory, { recursive: true });
    await writeFile(join(runDirectory, LEGACY_BUNDLE_FILE_NAME), 'earlier form', 'utf8');
    const firstStdout = captureCliOutput();
    await finishAuditRun(first, outputDirectory, firstStdout.output);

    expect(await bundlesIn(runDirectory)).toEqual([lastBundleFileName(first.run)]);
    expect(firstStdout.text()).toContain(artifactFilePath(runDirectory, lastBundleFileName(first.run)));

    // 再開した実行。
    const resumedStdout = captureCliOutput();
    await finishAuditRun(resumed, outputDirectory, resumedStdout.output);

    expect(await bundlesIn(runDirectory)).toEqual(['beaksight-audit-bundle_20261008030930.zip']);
    expect(lastBundleFileName(resumed.run)).toBe('beaksight-audit-bundle_20261008030930.zip');
    expect(resumedStdout.text()).toContain(artifactFilePath(runDirectory, 'beaksight-audit-bundle_20261008030930.zip'));
    expect(unzipSync(new Uint8Array(await readFile(join(runDirectory, 'beaksight-audit-bundle_20261008030930.zip'))))).toHaveProperty(['run.json']);
  });
});

describe('runAuditCommand: the production run hands the confirmed Run to finishAuditRun (R17r Minor-2)', () => {
  const failingLaunch = async (): Promise<never> => {
    throw new Error('browser launch is not allowed in this test');
  };

  it('exits with the Run Status after the schema validation (2, PARTIAL), not the one the Run Coordinator returned (COMPLETE)', async () => {
    const result = schemaInvalidRun();
    expect(result.run.runStatus).toBe('COMPLETE');
    const outputDirectory = join(workDirectory, 'run-command');
    const config = createTestConfig('http://127.0.0.1:9', '/', { output: { directory: outputDirectory } });
    const stdout = captureCliOutput();
    const stderr = captureCliOutput();
    const coordinatorDependencies: RunCoordinatorDependencies[] = [];
    const clock = (): Date => new Date('2026-09-25T00:00:00.000Z');
    const now = (): number => 0;

    const code = await runAuditCommand(config, { stdout: stdout.output, stderr: stderr.output }, {
      launchBrowser: failingLaunch,
      clock,
      now,
      createRunCoordinator: (dependencies) => {
        coordinatorDependencies.push(dependencies);
        // 保存のセッションを始めない偽の Run Coordinator なので、保存の終わり方は `NONE`（R5a。CLI は何もしない）。
        return { run: async () => result, checkpointConclusion: (): RunCoordinatorCheckpointConclusion => ({ action: 'NONE' }) };
      },
    });

    // Run Coordinator には、注入したものと、解決した出力先を渡す。
    expect(coordinatorDependencies).toHaveLength(1);
    expect(coordinatorDependencies[0]).toMatchObject({ config, launchBrowser: failingLaunch, clock, now, outputDirectory });
    // R5a（中断した Run の再開の設計書 4.7.1）: 保存のセッションも作って渡す。途中の Run がないので、再開の入力は渡さない。止める印も、
    // 注入していないので渡さない。
    expect(coordinatorDependencies[0]?.checkpointSession).toBeInstanceOf(RunCheckpointSession);
    expect(coordinatorDependencies[0]?.resumeFrom).toBeUndefined();
    expect(coordinatorDependencies[0]?.stopSignal).toBeUndefined();
    // 終了コードと書き出しは、`finishAuditRun` と同じく、導き直した後の Run Status（PARTIAL）による。
    expect(code).toBe(EXIT_CODES.PARTIAL);
    const runDirectory = runArtifactDirectory(outputDirectory, result.run.runId);
    const run = JSON.parse(await readFile(join(runDirectory, RUN_ARTIFACT_FILE_NAMES.run), 'utf8')) as RunSummary;
    expect(run.runStatus).toBe('PARTIAL');
    for (const file of [...Object.values(RUN_ARTIFACT_FILE_NAMES), lastBundleFileName(run)]) {
      await expect(readFile(join(runDirectory, file))).resolves.toBeInstanceOf(Buffer);
    }
    expect(stdout.text()).toContain(labelWithCodeText(RUN_STATUS_CATALOG.PARTIAL.label, 'PARTIAL'));
    expect(stdout.text()).toContain(runDirectory);
    expect(stderr.text()).toBe('');
  });

  // R5a（中断した Run の再開の設計書 4.7.1）: 止める印は、注入されたものを、そのまま Run Coordinator に渡す（R5b がシグナルとつなぐ口）。
  it('hands the injected stop signal to the Run Coordinator as it is', async () => {
    const outputDirectory = join(workDirectory, 'stop-signal');
    const config = createTestConfig('http://127.0.0.1:9', '/', { output: { directory: outputDirectory } });
    const controller = new AbortController();
    const coordinatorDependencies: RunCoordinatorDependencies[] = [];

    const code = await runAuditCommand(config, { stdout: captureCliOutput().output, stderr: captureCliOutput().output }, {
      launchBrowser: failingLaunch,
      clock: () => new Date('2026-09-25T00:00:01.000Z'),
      now: () => 0,
      stopSignal: controller.signal,
      createRunCoordinator: (dependencies) => {
        coordinatorDependencies.push(dependencies);
        return { run: async () => auditRun(), checkpointConclusion: (): RunCoordinatorCheckpointConclusion => ({ action: 'NONE' }) };
      },
    });

    expect(code).toBe(EXIT_CODES.COMPLETE);
    expect(coordinatorDependencies[0]?.stopSignal).toBe(controller.signal);
  });

  // SU5、SU6（サイトが応答しないときに Run を止める設計書 3.5.4、3.6.2）: Run Coordinator の知らせの口（`onNotice`）を渡し、受けた知らせ
  // （確かめ直しと減速）を、進み具合の行と同じく標準出力に1行で書く（開始の行の後、結果の前）。文言は `runNoticeLines`。
  it('hands a notice receiver to the Run Coordinator, and writes each notice to stdout as one line between the start and the result', async () => {
    const outputDirectory = join(workDirectory, 'notice');
    const config = createTestConfig('http://127.0.0.1:9', '/', { output: { directory: outputDirectory } });
    const stdout = captureCliOutput();
    const stderr = captureCliOutput();
    const notice: RunNotice = {
      kind: 'SITE_UNAVAILABLE_RECHECK',
      url: 'http://127.0.0.1:9/a.html',
      delayMs: SITE_UNAVAILABLE_RECHECK_DELAYS_MS[0] as number,
      attempt: 1,
      maxAttempts: SITE_UNAVAILABLE_RECHECK_DELAYS_MS.length,
    };
    const second: RunNotice = { kind: 'SITE_UNAVAILABLE_SLOWDOWN', minIntervalMs: 10_000 };

    const code = await runAuditCommand(config, { stdout: stdout.output, stderr: stderr.output }, {
      launchBrowser: failingLaunch,
      clock: () => new Date('2026-09-25T00:00:02.000Z'),
      now: () => 0,
      createRunCoordinator: (dependencies) => ({
        run: async () => {
          dependencies.onNotice?.(notice);
          dependencies.onNotice?.(second);
          return auditRun();
        },
        checkpointConclusion: (): RunCoordinatorCheckpointConclusion => ({ action: 'NONE' }),
      }),
    });

    expect(code).toBe(EXIT_CODES.COMPLETE);
    expect(stderr.text()).toBe('');
    const lines = stdout.text().split('\n');
    const first = runNoticeLines(notice)[0] ?? '';
    const last = runNoticeLines(second)[0] ?? '';
    expect(lines.filter((line) => line === first)).toHaveLength(1);
    expect(lines.filter((line) => line === last)).toHaveLength(1);
    expect(lines.indexOf(CLI_TEXT.run.started)).toBeLessThan(lines.indexOf(first));
    expect(lines.indexOf(first)).toBeLessThan(lines.indexOf(last));
    expect(lines.indexOf(last)).toBeLessThan(lines.indexOf(CLI_TEXT.run.resultHeading));
  });
});

// R5a（中断した Run の再開の設計書 4.7）: Playwright の既定のシグナルの処理を止める。Ctrl+C などで、Playwright が Browser を閉じて
// プロセスを終えると、最後の処理（出力の書き出し）が行われないため（シグナルは、R5b で BeakSight が受ける）。
// R7a（中断した Run の再開の設計書 4.10。RR の Critical-1）: headless と headed の両方で、Playwright に同梱の Chromium の `channel: 'chromium'`
// （GUI のプログラムの chrome.exe を、新しい headless の方式で動かす）で起動する。既定の headless の chrome-headless-shell.exe はコンソールの
// プログラムなので、Windows では、1回目の Ctrl+C の CTRL_C_EVENT を受けて終わってしまうためである。
// DEF-023（サイトへの負荷の制御の設計書 4.9）: ページの先読みを止める起動の引数（`CHROMIUM_PRELOADING_DISABLED_ARGS`）も渡す。値は
// `src/browser/chromium-launch.ts` の1か所にあり、先読みが止まることは tests/integration/preloading-disabled.test.ts で確かめる。
// DEF-044（NP5）: Shared Worker を無効にする起動の引数（`CHROMIUM_SHARED_WORKERS_DISABLED_ARGS`）も渡す。効くことは、
// tests/integration/safety-gates.test.ts の GATE-S01 の Shared Worker の場面で確かめる。
describe('PRODUCTION_RUN_DEPENDENCIES: the browser launch does not let Playwright handle the signals', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([true, false])('launches Chromium with headless %s, with the channel chromium, with the args that stop preloading and disable Shared Workers, and with handleSIGINT, handleSIGTERM and handleSIGHUP false', async (headless) => {
    const browser = { marker: 'the fake browser' } as unknown as Browser;
    const launch = vi.spyOn(chromium, 'launch').mockResolvedValue(browser);

    await expect(PRODUCTION_RUN_DEPENDENCIES.launchBrowser({ headless })).resolves.toBe(browser);

    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith({
      headless,
      channel: 'chromium',
      args: [...CHROMIUM_PRELOADING_DISABLED_ARGS, ...CHROMIUM_SHARED_WORKERS_DISABLED_ARGS],
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
  });
});
