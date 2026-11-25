// R17f（Task 14〜17 の設計書 第7章、6.1.1、6.1.8。R17 の指摘2）: 確定した `AuditRunResult` から、書き出し、表示用モデル、終了コードまでを
// 行う関数（`finishAuditRun`）。終了コードは、`ArtifactWriter.writeRun` がスキーマの検証で導き直した後の Run Status から決める。
// ブラウザは起動しない（Run Coordinator は使わない）。
// P18d（R17r の Minor-2）: 本番の `run`（`runAuditCommand`）が、Run Coordinator の後の書き出しと終了コードを `finishAuditRun` に
// 任せることも、Run Coordinator を差し替える口（`createRunCoordinator`）で確かめる。
// R5a（中断した Run の再開の設計書 4.7、4.7.1）: 偽の Run Coordinator は、保存の終わり方（`checkpointConclusion()`）も返す。`run` が、保存の
// セッションと止める印を Run Coordinator に渡すことと、本番の Browser の起動が Playwright の既定のシグナルの処理を止めることも確かめる。
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { unzipSync } from 'fflate';
import { chromium } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  CHROMIUM_PROFILE_DIRECTORY_PREFIX,
  CHROMIUM_DISABLED_FEATURES_ARGS,
  CHROMIUM_PRELOADING_DISABLED_ARGS,
  CHROMIUM_SHARED_WORKERS_DISABLED_ARGS,
} from '../../src/browser/chromium-launch.js';
import { writeAuditRunOutputs } from '../../src/cli/audit-run.js';
import { EXIT_CODES, RUN_UNAVAILABLE_EXIT_CODE } from '../../src/cli/exit-codes.js';
import { runNoticeLines } from '../../src/cli/output.js';
import { finishAuditRun, PRODUCTION_RUN_DEPENDENCIES, runAuditCommand } from '../../src/cli/run-command.js';
import {
  CHECKPOINT_ARTIFACT_DIRECTORY,
  RUN_ARTIFACT_FILE_NAMES,
  artifactFilePath,
  bundleFileName,
  checkpointArtifactRelativePath,
  isBundleFileName,
  runArtifactDirectory,
} from '../../src/core/artifact-layout.js';
import type { AuditRunResult, PageAuditResult, RunSummary } from '../../src/core/contracts.js';
import { deriveRunStatus } from '../../src/core/status.js';
import type { RunCheckpoint } from '../../src/orchestration/run-checkpoint.js';
import { RunCheckpointSession } from '../../src/orchestration/run-checkpoint-session.js';
import {
  RunResumeUnavailableError,
  SITE_UNAVAILABLE_RECHECK_DELAYS_MS,
  type RunCoordinatorCheckpointConclusion,
  type RunCoordinatorDependencies,
  type RunNotice,
  type RunResumeUnavailableReason,
} from '../../src/orchestration/run-coordinator.js';
import { RUN_STATUS_CATALOG } from '../../src/presentation/catalog.js';
import {
  CLI_TEXT,
  HTML_REPORT_TEXT,
  checkpointStoreFailedText,
  finishedCheckpointCleanupFailedText,
  labelWithCodeText,
} from '../../src/presentation/messages.js';
import { ArtifactWriteError, ArtifactWriter } from '../../src/report/artifact-writer.js';
import { CHATGPT_BUNDLE_FILE_NAMES, type ChatGptBundleManifest } from '../../src/report/chatgpt-bundle.js';
import { auditRun, edgeCaseAuditRun, FIXTURE_RUN_ID } from '../helpers/audit-run-fixture.js';
import { fakePersistentChromium } from '../helpers/fake-persistent-chromium.js';
import { sampleRunCheckpoint, sampleRunCheckpointPage } from '../helpers/run-checkpoint-samples.js';
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
// 中断した Run を再開して書き出した後も1つだけで、名前は、再開した実行の終わりの時刻になる（前の回のバンドルは消える）。
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

    // 最初の実行。
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

// PRE42-BN（2026-10-24 のユーザーの判断）: 画面のジョブ（プロファイルの名前あり）の書き出し（`writeAuditRunOutputs`。ワーカーが通る監査の中核の書き出し）は、
// 名前つきのバンドルを書く。再開でプロファイルの名前が変わった後も、前の名前のバンドルを消して1つだけ残す。名前は、成果物の中身（ZIP の中、run.json、
// audit.json、report.html）に入れない。CLI（名前なし）の形は、今のまま。
describe('writeAuditRunOutputs: the profile name in the bundle name (PRE42-BN)', () => {
  const bundlesIn = async (runDirectory: string): Promise<readonly string[]> => (await readdir(runDirectory)).filter(isBundleFileName);
  const EARLIER_NAME = '前の名前';
  const PROFILE_NAME = '管理画面';

  it('writes the named bundle, removes the bundle of the earlier name on a resume, and keeps the name out of the contents', async () => {
    const outputDirectory = join(workDirectory, 'bundle-profile-name');
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

    await writeAuditRunOutputs(first, outputDirectory, undefined, EARLIER_NAME);
    const firstName = bundleFileName(first.run.executions[first.run.executions.length - 1]?.finishedAt ?? '', EARLIER_NAME);
    expect(firstName.startsWith(`beaksight-audit-bundle_${EARLIER_NAME}_`)).toBe(true);
    expect(await bundlesIn(runDirectory)).toEqual([firstName]);

    // 再開した実行（プロファイルの名前が変わった後）。
    await writeAuditRunOutputs(resumed, outputDirectory, undefined, PROFILE_NAME);
    const named = `beaksight-audit-bundle_${PROFILE_NAME}_20261008030930.zip`;
    expect(await bundlesIn(runDirectory)).toEqual([named]);
    const entries = unzipSync(new Uint8Array(await readFile(join(runDirectory, named))));
    expect(entries).toHaveProperty(['run.json']);
    for (const [entryName, bytes] of Object.entries(entries)) {
      const text = Buffer.from(bytes).toString('utf8');
      expect(text.includes(PROFILE_NAME) || text.includes(EARLIER_NAME), entryName).toBe(false);
    }
    for (const file of Object.values(RUN_ARTIFACT_FILE_NAMES)) {
      const text = await readFile(join(runDirectory, file), 'utf8');
      expect(text.includes(PROFILE_NAME) || text.includes(EARLIER_NAME), file).toBe(false);
    }

    // CLI（名前なし）で書き直すと、今の形の名前になり、名前つきのバンドルは消える。
    await writeAuditRunOutputs(resumed, outputDirectory);
    expect(await bundlesIn(runDirectory)).toEqual(['beaksight-audit-bundle_20261008030930.zip']);
  });
});

// AUD-1c（設計書 `2026-11-09-beaksight-audit-precision-triage.md`）: 本番の書き出し（`writeAuditRunOutputs`）は、発表の前に参照先があるかを確かめてから
// 表示用モデルを作る。欠けの数は `null` でなく、HTML とバンドルは同じ数を示す。見本の Run の画像は書き出されない（`writeRun` は画像を書かない）ので、5 枚が欠ける。
describe('writeAuditRunOutputs: the references are checked before publishing (AUD-1c)', () => {
  it('shows the same missing count, not null, in the report and in the bundle', async () => {
    const outputDirectory = join(workDirectory, 'checked-references');
    const result = edgeCaseAuditRun();
    const outputs = await writeAuditRunOutputs(result, outputDirectory);
    const runDirectory = runArtifactDirectory(outputDirectory, outputs.runId);
    const [bundleName] = (await readdir(runDirectory)).filter(isBundleFileName);
    const entries = unzipSync(new Uint8Array(await readFile(join(runDirectory, bundleName ?? ''))));
    const manifest = JSON.parse(Buffer.from(entries[CHATGPT_BUNDLE_FILE_NAMES.manifest] ?? new Uint8Array()).toString('utf8')) as ChatGptBundleManifest;

    expect(manifest.missingArtifactCount).toBe(5);
    expect(manifest.omittedFiles.filter(({ reason }) => reason === 'ARTIFACT_FILE_NOT_FOUND')).toHaveLength(5);
    const html = await readFile(join(runDirectory, RUN_ARTIFACT_FILE_NAMES.report), 'utf8');
    expect(html).toContain(HTML_REPORT_TEXT.record.missingArtifacts('5'));
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

// R5a（中断した Run の再開の設計書 4.7.1）: Run の後の保存の終わり方（`FINISH`・`ABANDON`・`NONE`）、`finish` と片付けの失敗、Run Coordinator の
// 例外、再開を始められない理由を、偽の Run Coordinator で確かめる（Browser を起動しない。SLIM-GROUP で `tests/integration/cli-resume.test.ts` から移した）。
describe('R5a: after the Run, the CLI follows the checkpoint conclusion of the Run Coordinator (resumable run design 4.7.1)', () => {
  interface FakeRun {
    readonly outcome: { readonly code: number; readonly stdout: string; readonly stderr: string } | null;
    readonly rejection: unknown;
    readonly runDirectory: string;
    readonly finish: MockInstance<RunCheckpointSession['finish']>;
    readonly abandon: MockInstance<RunCheckpointSession['abandon']>;
  }

  interface FakeRunOptions {
    /** 偽の `run()` で、CLI の保存のセッションを始め、ページの保存と状態の保存を1回ずつ書く。 */
    readonly startSession: boolean;
    readonly conclusion: RunCoordinatorCheckpointConclusion;
    /** 偽の `run()` の終わり方（省略すると、見本の Run（COMPLETE）を返す）。 */
    readonly run?: (runDirectory: string) => Promise<AuditRunResult>;
    /** 保存のセッションの `finish` を、実際には行わずに失敗させる。 */
    readonly failFinish?: boolean;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const failingLaunch = async (): Promise<never> => {
    throw new Error('browser launch is not allowed in this test');
  };

  /** Run のディレクトリの `checkpoint/` の下のファイルの、`checkpoint/` からの相対パス（区切りは `/`。名前の順）。 */
  async function checkpointFilesIn(runDirectory: string): Promise<string[]> {
    const directory = artifactFilePath(runDirectory, CHECKPOINT_ARTIFACT_DIRECTORY);
    if (!existsSync(directory)) {
      return [];
    }
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => relative(directory, join(entry.parentPath, entry.name)).split('\\').join('/'))
      .sort();
  }

  const readState = async (runDirectory: string): Promise<RunCheckpoint> =>
    JSON.parse(await readFile(artifactFilePath(runDirectory, checkpointArtifactRelativePath('state')), 'utf8')) as RunCheckpoint;

  /** 偽の Run Coordinator で `run` を行う。CLI が作った保存のセッションの `finish` と `abandon` を見張る。 */
  async function runWithFakeCoordinator(name: string, options: FakeRunOptions): Promise<FakeRun> {
    const config = createTestConfig('http://127.0.0.1:9', '/', { output: { directory: join(workDirectory, name) } });
    const runDirectory = runArtifactDirectory(join(workDirectory, name), FIXTURE_RUN_ID);
    let finish: MockInstance<RunCheckpointSession['finish']> | undefined;
    let abandon: MockInstance<RunCheckpointSession['abandon']> | undefined;
    const stdout = captureCliOutput();
    const stderr = captureCliOutput();
    let outcome: FakeRun['outcome'] = null;
    let rejection: unknown = null;
    try {
      const code = await runAuditCommand(config, { stdout: stdout.output, stderr: stderr.output }, {
        launchBrowser: failingLaunch,
        clock: () => new Date(),
        now: () => Date.now(),
        createRunCoordinator: (coordinatorDependencies: RunCoordinatorDependencies) => {
          const session = coordinatorDependencies.checkpointSession as RunCheckpointSession;
          expect(session).toBeInstanceOf(RunCheckpointSession);
          finish = vi.spyOn(session, 'finish');
          if (options.failFinish === true) {
            finish.mockRejectedValueOnce(new Error('simulated failure of the final checkpoint'));
          }
          abandon = vi.spyOn(session, 'abandon');
          return {
            run: async () => {
              if (options.startSession) {
                await mkdir(runDirectory, { recursive: true });
                await expect(session.start(runDirectory, { mode: 'NEW_RUN' })).resolves.toEqual({ ok: true });
                await session.savePage(sampleRunCheckpointPage());
                await session.saveState(sampleRunCheckpoint({ startPageFinished: true }));
              }
              return options.run === undefined ? auditRun() : options.run(runDirectory);
            },
            checkpointConclusion: () => options.conclusion,
          };
        },
      });
      outcome = { code, stdout: stdout.text(), stderr: stderr.text() };
    } catch (error) {
      rejection = error;
    }
    if (finish === undefined || abandon === undefined) {
      throw new Error('the fake Run Coordinator was not created');
    }
    return { outcome, rejection, runDirectory, finish, abandon };
  }

  /**
   * `FINISH` の終わり方。`finishEvenIfOutputFails`（出力の書き出しに失敗しても `finish` を行うか。R7c）は、省略すると偽（違反のない Run）。
   * 出力の書き出しに失敗した場合の保存の終わり方（4 つの終わり方のすべて）は、`tests/unit/cli.test.ts` で確かめる（TEST-SLIM J2）。
   */
  const finishConclusion = (state: 'FINISHED' | 'STOPPED', finishEvenIfOutputFails = false): RunCoordinatorCheckpointConclusion =>
    ({ action: 'FINISH', checkpoint: sampleRunCheckpoint({ state }), finishEvenIfOutputFails });

  it('FINISH with FINISHED: finishes the session with the final checkpoint, then leaves only state.json', async () => {
    const finalCheckpoint = sampleRunCheckpoint({ state: 'FINISHED' });
    const fake = await runWithFakeCoordinator('after-finish-finished', {
      startSession: true,
      conclusion: { action: 'FINISH', checkpoint: finalCheckpoint, finishEvenIfOutputFails: false },
    });

    expect(fake.outcome?.code).toBe(EXIT_CODES.COMPLETE);
    expect(fake.outcome?.stderr).toBe('');
    expect(fake.finish).toHaveBeenCalledTimes(1);
    expect(fake.finish).toHaveBeenCalledWith(finalCheckpoint);
    expect(fake.abandon).not.toHaveBeenCalled();
    expect(await checkpointFilesIn(fake.runDirectory)).toEqual(['state.json']);
    expect(await readState(fake.runDirectory)).toEqual(sampleRunCheckpoint({ state: 'FINISHED' }));
    // 出力は、保存の終わりの前に書いた。
    expect(existsSync(artifactFilePath(fake.runDirectory, RUN_ARTIFACT_FILE_NAMES.report))).toBe(true);
  });

  it('FINISH with STOPPED: finishes the session, and keeps the page checkpoints and state.prev.json for the resume', async () => {
    const fake = await runWithFakeCoordinator('after-finish-stopped', { startSession: true, conclusion: finishConclusion('STOPPED') });

    expect(fake.outcome?.code).toBe(EXIT_CODES.COMPLETE);
    expect(fake.finish).toHaveBeenCalledTimes(1);
    expect(fake.abandon).not.toHaveBeenCalled();
    expect(await checkpointFilesIn(fake.runDirectory)).toEqual(['pages/PAGE-000001.json', 'state.json', 'state.prev.json']);
    expect((await readState(fake.runDirectory)).state).toBe('STOPPED');
  });

  it('ABANDON: abandons the session after writing the output, and keeps the checkpoint', async () => {
    const fake = await runWithFakeCoordinator('after-abandon', { startSession: true, conclusion: { action: 'ABANDON' } });

    expect(fake.outcome?.code).toBe(EXIT_CODES.COMPLETE);
    expect(fake.outcome?.stderr).toBe('');
    expect(fake.abandon).toHaveBeenCalledTimes(1);
    expect(fake.finish).not.toHaveBeenCalled();
    expect(await checkpointFilesIn(fake.runDirectory)).toEqual(['pages/PAGE-000001.json', 'state.json']);
    expect((await readState(fake.runDirectory)).state).toBe('IN_PROGRESS');
  });

  it('NONE: neither finishes nor abandons the session', async () => {
    const fake = await runWithFakeCoordinator('after-none', { startSession: false, conclusion: { action: 'NONE' } });

    expect(fake.outcome?.code).toBe(EXIT_CODES.COMPLETE);
    expect(fake.outcome?.stderr).toBe('');
    expect(fake.finish).not.toHaveBeenCalled();
    expect(fake.abandon).not.toHaveBeenCalled();
    expect(await checkpointFilesIn(fake.runDirectory)).toEqual([]);
  });

  it('warns on stderr when the final checkpoint cannot be written, abandons the session, and keeps the exit code of the Run Status', async () => {
    const fake = await runWithFakeCoordinator('after-finish-failure', {
      startSession: true,
      conclusion: finishConclusion('FINISHED'),
      failFinish: true,
    });

    expect(fake.outcome?.code).toBe(EXIT_CODES.COMPLETE);
    expect(fake.outcome?.stderr.split('\n')).toContain(CLI_TEXT.resume.finishFailed);
    expect(fake.finish).toHaveBeenCalledTimes(1);
    expect(fake.abandon).toHaveBeenCalledTimes(1);
    expect(fake.abandon.mock.invocationCallOrder[0]).toBeGreaterThan(fake.finish.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY);
    // 片付けもしない（保存の状態は、最後に書けた IN_PROGRESS のまま）。
    expect(await checkpointFilesIn(fake.runDirectory)).toEqual(['pages/PAGE-000001.json', 'state.json']);
  });

  it('warns on stderr with the path when the checkpoint files of the finished Run cannot be removed, and keeps the exit code', async () => {
    const blockedPath = join(workDirectory, 'after-cleanup-failure', 'blocked-path');
    const cleanUp = vi.spyOn(ArtifactWriter.prototype, 'removeFinishedCheckpointFiles')
      .mockRejectedValueOnce(new ArtifactWriteError(blockedPath, new Error('EBUSY: resource busy or locked')));

    const fake = await runWithFakeCoordinator('after-cleanup-failure', { startSession: true, conclusion: finishConclusion('FINISHED') });

    expect(fake.outcome?.code).toBe(EXIT_CODES.COMPLETE);
    expect(cleanUp).toHaveBeenCalledWith(fake.runDirectory);
    expect(fake.outcome?.stderr.split('\n')).toContain(finishedCheckpointCleanupFailedText(blockedPath));
    expect(fake.finish).toHaveBeenCalledTimes(1);
    expect(fake.abandon).not.toHaveBeenCalled();
  });

  it.each([
    ['ABANDON', 1],
    ['NONE', 0],
  ] as const)('rejects with the unexpected error of the Run Coordinator, abandoning the session only for %s', async (action, abandons) => {
    const unexpected = new Error('unexpected failure of the Run Coordinator');
    const fake = await runWithFakeCoordinator(`after-unexpected-${action.toLowerCase()}`, {
      startSession: action === 'ABANDON',
      conclusion: { action },
      run: async () => {
        throw unexpected;
      },
    });

    expect(fake.rejection).toBe(unexpected);
    expect(fake.abandon).toHaveBeenCalledTimes(abandons);
    expect(fake.finish).not.toHaveBeenCalled();
  });

  it.each([
    ['CHECKPOINT_STORE_FAILED', checkpointStoreFailedText],
  ] as const satisfies readonly (readonly [RunResumeUnavailableReason, (runId: string) => string])[])(
    'exits with 4 with the message for %s when the resume cannot start, writing no output',
    async (reason, text) => {
      const name = `resume-unavailable-${reason.toLowerCase()}`;
      const cause = new Error('EACCES: permission denied, open checkpoint/state.json');
      const fake = await runWithFakeCoordinator(name, {
        startSession: false,
        conclusion: { action: 'NONE' },
        run: async (runDirectory) => {
          throw new RunResumeUnavailableError({ runId: FIXTURE_RUN_ID, runDirectory, reason, cause });
        },
      });

      expect(fake.outcome?.code).toBe(RUN_UNAVAILABLE_EXIT_CODE);
      const lines = fake.outcome?.stderr.split('\n') ?? [];
      expect(lines[0]).toBe(text(FIXTURE_RUN_ID));
      expect(lines).toContain(`${CLI_TEXT.detailsHeading}:`);
      expect(lines.filter((line) => line.includes(cause.message))).toHaveLength(1);
      // 出力を作らない（結果の要約も示さない）。
      expect(fake.outcome?.stdout).not.toContain(CLI_TEXT.run.resultHeading);
      // REV-PAR の m-1: 出力先は別の対象と共有するので、印の後始末では消さない（空の出力先は残る）。書かないのは Run のディレクトリと成果物。
      const outputDirectory = join(workDirectory, name);
      expect(existsSync(outputDirectory) ? await readdir(outputDirectory, { recursive: true }) : []).toEqual([]);
      expect(fake.finish).not.toHaveBeenCalled();
      expect(fake.abandon).not.toHaveBeenCalled();
    },
  );
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
// `--disable-features` の 1 つの引数（`CHROMIUM_DISABLED_FEATURES_ARGS`。Playwright の既定の値を含む）も渡す。実際に渡った値は
// tests/integration/preloading-disabled.test.ts で確かめる。
describe('PRODUCTION_RUN_DEPENDENCIES: the browser launch does not let Playwright handle the signals', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([true, false])('launches Chromium with headless %s, with the channel chromium, with the args that stop preloading and disable Shared Workers, and with handleSIGINT, handleSIGTERM and handleSIGHUP false', async (headless) => {
    // EL-12: 起動は、外部のアプリの起動を止める起動の部品（一時のプロファイルの `launchPersistentContext`）で、値はそのまま渡す。
    const fake = fakePersistentChromium();
    const launch = vi.spyOn(chromium, 'launchPersistentContext').mockResolvedValue(fake.context);

    await expect(PRODUCTION_RUN_DEPENDENCIES.launchBrowser({ headless })).resolves.toBe(fake.browser);
    await fake.browser.close();

    expect(launch).toHaveBeenCalledTimes(1);
    expect(String(launch.mock.calls[0]?.[0]).startsWith(join(tmpdir(), CHROMIUM_PROFILE_DIRECTORY_PREFIX))).toBe(true);
    expect(launch.mock.calls[0]?.[1]).toEqual({
      headless,
      channel: 'chromium',
      args: [
        ...CHROMIUM_PRELOADING_DISABLED_ARGS,
        ...CHROMIUM_DISABLED_FEATURES_ARGS,
        ...CHROMIUM_SHARED_WORKERS_DISABLED_ARGS,
      ],
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
  });
});
