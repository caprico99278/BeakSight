// T24a（Task 24 の設計書 4.1、7 章の「中核の切り出し」）: `run` のコマンドから切り出した監査の中核（`executeAuditRun`）。
// - 結果は、今の分岐（実行中の Run がある、版の違い、Run のディレクトリを作れない、再開を始められない、Run を実行した）を、閉じた一覧の
//   `kind` で表し、外から要る値（Run の ID、Run のディレクトリ、Run Status、終了コード、再開の判断）を持つ。日本語の文は書かない。
// - 観測の口（`onRunStarting`、`onRunStarted`、`onProgress`、`onNotice`）が呼ばれる順と値。口の例外と reject は、監査を止めない。
// 偽の Run Coordinator（`createRunCoordinator`）で確かめる（Browser を起動しない）。本物の Chromium での確かめは
// `tests/integration/audit-run.test.ts`、CLI の出力が変わらないことは `tests/integration/cli-output-parity.test.ts`。
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AUDIT_RUN_CHECKPOINT_WARNING_KINDS,
  AUDIT_RUN_OUTCOME_KINDS,
  AUDIT_RUN_RESUME_DECISION_KINDS,
  AUDIT_RUN_START_NOTICE_KINDS,
  executeAuditRun,
  type AuditRunDependencies,
  type AuditRunObserver,
  type AuditRunOutcome,
} from '../../src/cli/audit-run.js';
import { EXIT_CODES, RUN_UNAVAILABLE_EXIT_CODE, exitCodeForRunStatus } from '../../src/cli/exit-codes.js';
import type { AuditConfig } from '../../src/config/types.js';
import {
  CHECKPOINT_PAGES_ARTIFACT_DIRECTORY,
  RUN_ARTIFACT_FILE_NAMES,
  artifactFilePath,
  checkpointArtifactRelativePath,
  runArtifactDirectory,
} from '../../src/core/artifact-layout.js';
import type { AuditRunResult, RunProgressReport } from '../../src/core/contracts.js';
import { createRunId } from '../../src/core/ids.js';
import { readPlaywrightVersion, readToolVersion } from '../../src/orchestration/environment.js';
import { createRunLock, currentProcessRunLockHost } from '../../src/core/process-lock.js';
import { checkRunCheckpointConsistency } from '../../src/orchestration/run-checkpoint.js';
import { RunCheckpointSession } from '../../src/orchestration/run-checkpoint-session.js';
import {
  RunDirectoryUnavailableError,
  RunResumeUnavailableError,
  type RunCoordinatorCheckpointConclusion,
  type RunCoordinatorDependencies,
  type RunNotice,
} from '../../src/orchestration/run-coordinator.js';
import { ArtifactWriteError, ArtifactWriter } from '../../src/report/artifact-writer.js';
import { auditRun, FIXTURE_ORIGIN, FIXTURE_RUN_ID } from '../helpers/audit-run-fixture.js';
import { sampleRunCheckpoint, sampleRunCheckpointPage } from '../helpers/run-checkpoint-samples.js';
import { createTestConfig } from '../helpers/test-config.js';

let workDirectory: string;

beforeAll(async () => {
  workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-audit-run-'));
});

afterAll(async () => {
  await rm(workDirectory, { recursive: true, force: true });
});

const failingLaunch = async (): Promise<never> => {
  throw new Error('browser launch is not allowed in this test');
};

/** `name` の出力先に書く設定（見本の保存と同じ対象と開始の URL。出力先は、再開の設定の比較に含まれない）。 */
const configFor = (name: string): AuditConfig => createTestConfig(FIXTURE_ORIGIN, '/', { output: { directory: join(workDirectory, name) } });

/** 進み具合の見本（値は、口に渡ることだけを確かめる）。 */
const PROGRESS_REPORT: RunProgressReport = Object.freeze({
  pagesFinished: 1,
  pagesDiscovered: 2,
  maxPages: 3,
  elapsedMs: 4,
  navigationCount: 5,
  pacingWaitMs: 6,
  requests: Object.freeze({
    allowedOrigins: Object.freeze({ count: 7, peakPerMinute: 7 }),
    otherOrigins: Object.freeze({ count: 0, peakPerMinute: 0 }),
  }),
  recentPerMinute: Object.freeze({ allowedOrigins: 7, otherOrigins: 0 }),
}) as RunProgressReport;

const NOTICE: RunNotice = Object.freeze({ kind: 'SITE_UNAVAILABLE_SLOWDOWN', minIntervalMs: 10_000 });

/** 偽の Run Coordinator の指定。 */
interface FakeCoordinatorOptions {
  /** 偽の `run()`。CLI が作った保存のセッションと、Run Coordinator に渡した依存を受け取る。省略すると、見本の Run（COMPLETE）を返す。 */
  readonly run?: (input: { readonly session: RunCheckpointSession; readonly dependencies: RunCoordinatorDependencies }) => Promise<AuditRunResult>;
  readonly conclusion?: RunCoordinatorCheckpointConclusion;
}

/** 偽の Run Coordinator を使う依存と、作られた Run Coordinator の依存の記録。 */
function fakeDependencies(options: FakeCoordinatorOptions = {}): {
  readonly dependencies: AuditRunDependencies;
  readonly created: RunCoordinatorDependencies[];
} {
  const created: RunCoordinatorDependencies[] = [];
  return {
    created,
    dependencies: {
      launchBrowser: failingLaunch,
      clock: () => new Date(),
      now: () => Date.now(),
      createRunCoordinator: (dependencies) => {
        created.push(dependencies);
        const session = dependencies.checkpointSession as RunCheckpointSession;
        return {
          run: async () => (options.run === undefined ? auditRun() : await options.run({ session, dependencies })),
          checkpointConclusion: () => options.conclusion ?? { action: 'NONE' },
        };
      },
    },
  };
}

/** 呼ばれた観測の口を、名前と値で順に記録する観測の口。 */
function recordingObserver(): { readonly observer: AuditRunObserver; readonly calls: { readonly hook: string; readonly value: unknown }[] } {
  const calls: { readonly hook: string; readonly value: unknown }[] = [];
  return {
    calls,
    observer: {
      onRunStarting: (value) => calls.push({ hook: 'onRunStarting', value }),
      onRunStarted: (value) => calls.push({ hook: 'onRunStarted', value }),
      onProgress: (value) => calls.push({ hook: 'onProgress', value }),
      onNotice: (value) => calls.push({ hook: 'onNotice', value }),
    },
  };
}

/** 偽の `run()` で、保存のセッションを新しい Run として始め、進み具合と知らせを渡してから、見本の Run を返す。 */
const startingRun = (runDirectory: string): NonNullable<FakeCoordinatorOptions['run']> => async ({ session, dependencies }) => {
  await mkdir(runDirectory, { recursive: true });
  await expect(session.start(runDirectory, { mode: 'NEW_RUN' })).resolves.toEqual({ ok: true });
  dependencies.onProgress?.(PROGRESS_REPORT);
  dependencies.onNotice?.(NOTICE);
  return auditRun();
};

/**
 * 見本の保存（開始の URL を終えた `IN_PROGRESS`）を、`outputDirectory` の Run（`FIXTURE_RUN_ID`）のディレクトリに書く。`overrides` は、
 * 状態の保存の項目を置き換える。
 */
async function writeSampleCheckpoint(outputDirectory: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const runDirectory = runArtifactDirectory(outputDirectory, FIXTURE_RUN_ID);
  const writer = new ArtifactWriter();
  const checkpoint = sampleRunCheckpoint({ startPageFinished: true });
  // 版は、今の BeakSight と Playwright のもの（`overrides` で変えない限り、版の違いにしない）。
  const executions = checkpoint.executions.map((execution) => ({
    ...execution,
    environment: { ...execution.environment, playwrightVersion: readPlaywrightVersion() },
  }));
  await writer.writeCheckpointPage(runDirectory, sampleRunCheckpointPage());
  await writer.writeCheckpointState(runDirectory, { ...checkpoint, executions, toolVersion: await readToolVersion(), ...overrides });
  return runDirectory;
}

describe('executeAuditRun: the closed lists of the outcome', () => {
  it('lists the kinds of the outcome, the resume decision, the start notice and the checkpoint warning', () => {
    expect(AUDIT_RUN_OUTCOME_KINDS).toEqual(['RAN', 'RUN_ACTIVE', 'VERSION_MISMATCH', 'RUN_DIRECTORY_UNAVAILABLE', 'RESUME_UNAVAILABLE']);
    expect(AUDIT_RUN_RESUME_DECISION_KINDS).toEqual(['NEW_RUN', 'RESUME', 'FINALIZE_ONLY']);
    expect(AUDIT_RUN_START_NOTICE_KINDS).toEqual(['CHECKPOINT_UNREADABLE', 'CONFIG_DIFFERS']);
    expect(AUDIT_RUN_CHECKPOINT_WARNING_KINDS).toEqual(['CHECKPOINT_FINISH_FAILED', 'CHECKPOINT_CLEANUP_FAILED']);
  });
});

describe('executeAuditRun: a new Run (RAN)', () => {
  it('returns the run ID, the run directory, the Run Status and its exit code, and calls the observer in order', async () => {
    const config = configFor('ran');
    const runDirectory = runArtifactDirectory(config.output.directory, FIXTURE_RUN_ID);
    const { dependencies, created } = fakeDependencies({ run: startingRun(runDirectory) });
    const { observer, calls } = recordingObserver();

    const outcome = await executeAuditRun(config, dependencies, { startNew: false }, observer);

    expect(outcome).toMatchObject({
      kind: 'RAN',
      runId: FIXTURE_RUN_ID,
      runDirectory,
      runStatus: 'COMPLETE',
      exitCode: EXIT_CODES.COMPLETE,
      resumeDecision: { kind: 'NEW_RUN' },
      notices: [],
      checkpointWarnings: [],
    });
    expect(calls.map(({ hook }) => hook)).toEqual(['onRunStarting', 'onRunStarted', 'onProgress', 'onNotice']);
    expect(calls[0]?.value).toEqual({ resumeDecision: { kind: 'NEW_RUN' }, notices: [] });
    expect(calls[1]?.value).toEqual({ runId: FIXTURE_RUN_ID, runDirectory, resumeDecision: { kind: 'NEW_RUN' } });
    expect(calls[2]?.value).toBe(PROGRESS_REPORT);
    expect(calls[3]?.value).toBe(NOTICE);
    // 書き出しも行う。Run Coordinator には、CLI と同じく、保存のセッション（`RunCheckpointSession`）を渡す。
    expect(existsSync(artifactFilePath(runDirectory, RUN_ARTIFACT_FILE_NAMES.report))).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0]?.checkpointSession).toBeInstanceOf(RunCheckpointSession);
    expect(created[0]?.resumeFrom).toBeUndefined();
  });

  it('returns the Run Status after the schema validation of the written Run, with its exit code', async () => {
    const config = configFor('ran-revalidated');
    const [firstPage] = auditRun().pages;
    const invalid = auditRun({ pages: [{ ...firstPage, unexpectedField: true } as unknown as AuditRunResult['pages'][number]] });
    const { dependencies } = fakeDependencies({ run: async () => invalid });

    const outcome = await executeAuditRun(config, dependencies, { startNew: false });

    expect(outcome).toMatchObject({ kind: 'RAN', runStatus: 'PARTIAL', exitCode: EXIT_CODES.PARTIAL });
  });

  it('keeps the audit going when every hook of the observer throws or rejects', async () => {
    const config = configFor('throwing-observer');
    const runDirectory = runArtifactDirectory(config.output.directory, FIXTURE_RUN_ID);
    const { dependencies } = fakeDependencies({ run: startingRun(runDirectory) });
    const hooks: string[] = [];
    const observer: AuditRunObserver = {
      onRunStarting: () => {
        hooks.push('onRunStarting');
        throw new Error('the observer failed');
      },
      onRunStarted: async () => {
        hooks.push('onRunStarted');
        throw new Error('the observer rejected');
      },
      onProgress: () => {
        hooks.push('onProgress');
        throw new Error('the observer failed');
      },
      onNotice: async () => {
        hooks.push('onNotice');
        throw new Error('the observer rejected');
      },
    };

    const outcome = await executeAuditRun(config, dependencies, { startNew: false }, observer);

    expect(hooks).toEqual(['onRunStarting', 'onRunStarted', 'onProgress', 'onNotice']);
    expect(outcome).toMatchObject({ kind: 'RAN', runId: FIXTURE_RUN_ID, exitCode: EXIT_CODES.COMPLETE });
  });

  it('hands the injected stop signal to the Run Coordinator, and works without an observer', async () => {
    const config = configFor('stop-signal');
    const controller = new AbortController();
    const { dependencies, created } = fakeDependencies();

    const outcome = await executeAuditRun(config, { ...dependencies, stopSignal: controller.signal }, { startNew: true });

    expect(outcome.kind).toBe('RAN');
    expect(created[0]?.stopSignal).toBe(controller.signal);
  });

  it('reports the failures of the checkpoint conclusion as warnings, without changing the exit code', async () => {
    const config = configFor('checkpoint-warnings');
    const runDirectory = runArtifactDirectory(config.output.directory, FIXTURE_RUN_ID);
    const blockedPath = join(workDirectory, 'checkpoint-warnings', 'blocked-path');
    const cleanUp = vi.spyOn(ArtifactWriter.prototype, 'removeFinishedCheckpointFiles')
      .mockRejectedValueOnce(new ArtifactWriteError(blockedPath, new Error('EBUSY: resource busy or locked')));
    const { dependencies } = fakeDependencies({
      run: startingRun(runDirectory),
      conclusion: { action: 'FINISH', checkpoint: sampleRunCheckpoint({ state: 'FINISHED' }), finishEvenIfOutputFails: false },
    });

    const outcome = await executeAuditRun(config, dependencies, { startNew: false });

    expect(cleanUp).toHaveBeenCalledWith(runDirectory);
    expect(outcome).toMatchObject({
      kind: 'RAN',
      exitCode: EXIT_CODES.COMPLETE,
      checkpointWarnings: [{ kind: 'CHECKPOINT_CLEANUP_FAILED', path: blockedPath }],
    });
  });

  it('reports the failure to write the final checkpoint as a warning', async () => {
    const config = configFor('finish-warning');
    const runDirectory = runArtifactDirectory(config.output.directory, FIXTURE_RUN_ID);
    const { dependencies } = fakeDependencies({
      run: async (input) => {
        vi.spyOn(input.session, 'finish').mockRejectedValueOnce(new Error('simulated failure of the final checkpoint'));
        return await startingRun(runDirectory)(input);
      },
      conclusion: { action: 'FINISH', checkpoint: sampleRunCheckpoint({ state: 'FINISHED' }), finishEvenIfOutputFails: false },
    });

    const outcome = await executeAuditRun(config, dependencies, { startNew: false });

    expect(outcome).toMatchObject({ kind: 'RAN', checkpointWarnings: [{ kind: 'CHECKPOINT_FINISH_FAILED' }] });
  });

  it('rejects with the error of the Run Coordinator, and with the failure to write the output', async () => {
    const failure = new Error('unexpected failure of the Run Coordinator');
    await expect(executeAuditRun(configFor('coordinator-failure'), fakeDependencies({
      run: async () => {
        throw failure;
      },
    }).dependencies, { startNew: false })).rejects.toBe(failure);

    const config = configFor('output-failure');
    const runDirectory = runArtifactDirectory(config.output.directory, FIXTURE_RUN_ID);
    await expect(executeAuditRun(config, fakeDependencies({
      run: async () => {
        await mkdir(artifactFilePath(runDirectory, RUN_ARTIFACT_FILE_NAMES.run), { recursive: true });
        return auditRun();
      },
    }).dependencies, { startNew: false })).rejects.toBeInstanceOf(ArtifactWriteError);
  });
});

describe('executeAuditRun: the Runs that do not start or cannot be finished', () => {
  it('returns RUN_ACTIVE with the run ID of the running Run, without creating the Run Coordinator or calling the observer', async () => {
    const config = configFor('active');
    const activeRunId = createRunId(20261001000000);
    await new ArtifactWriter().acquireRunLock(
      runArtifactDirectory(config.output.directory, activeRunId),
      createRunLock(currentProcessRunLockHost(Date.now())),
    );
    const { dependencies, created } = fakeDependencies();
    const { observer, calls } = recordingObserver();

    const outcome = await executeAuditRun(config, dependencies, { startNew: true }, observer);

    expect(outcome).toEqual({ kind: 'RUN_ACTIVE', activeRunId, exitCode: RUN_UNAVAILABLE_EXIT_CODE });
    expect(created).toHaveLength(0);
    expect(calls).toEqual([]);
  });

  it('returns RUN_DIRECTORY_UNAVAILABLE with the confirmed Run Status and its exit code', async () => {
    const config = configFor('directory-unavailable');
    const result = auditRun();
    const runDirectory = runArtifactDirectory(config.output.directory, result.run.runId);
    const cause = new Error('EEXIST: file already exists');
    const { dependencies } = fakeDependencies({
      run: async () => {
        throw new RunDirectoryUnavailableError({ result, runDirectory, alreadyExists: true, cause });
      },
    });

    const outcome = await executeAuditRun(config, dependencies, { startNew: false });

    expect(outcome).toEqual({
      kind: 'RUN_DIRECTORY_UNAVAILABLE',
      runId: result.run.runId,
      runDirectory,
      runStatus: result.run.runStatus,
      alreadyExists: true,
      cause,
      exitCode: exitCodeForRunStatus(result.run.runStatus),
      resumeDecision: { kind: 'NEW_RUN' },
      notices: [],
    });
    expect(existsSync(artifactFilePath(runDirectory, RUN_ARTIFACT_FILE_NAMES.run))).toBe(false);
  });

  it('returns RESUME_UNAVAILABLE with the reason and the cause, and exit code 4', async () => {
    const config = configFor('resume-unavailable');
    const runDirectory = runArtifactDirectory(config.output.directory, FIXTURE_RUN_ID);
    const cause = new Error('EACCES: permission denied');
    const { dependencies } = fakeDependencies({
      run: async () => {
        throw new RunResumeUnavailableError({
          runId: FIXTURE_RUN_ID,
          runDirectory,
          reason: 'CHECKPOINT_STORE_FAILED',
          existingLock: null,
          cause,
        });
      },
    });

    const outcome = await executeAuditRun(config, dependencies, { startNew: false });

    expect(outcome).toEqual({
      kind: 'RESUME_UNAVAILABLE',
      runId: FIXTURE_RUN_ID,
      runDirectory,
      reason: 'CHECKPOINT_STORE_FAILED',
      cause,
      exitCode: RUN_UNAVAILABLE_EXIT_CODE,
      resumeDecision: { kind: 'NEW_RUN' },
      notices: [],
    });
  });
});

describe('executeAuditRun: the choice of the Run to resume', () => {
  it('resumes the interrupted Run: RESUME with the finished pages, and onRunStarted with the run ID of the saved Run', async () => {
    const config = configFor('resume');
    const runDirectory = await writeSampleCheckpoint(config.output.directory);
    const { observer, calls } = recordingObserver();
    const { dependencies, created } = fakeDependencies({
      run: async ({ session, dependencies: coordinatorDependencies }) => {
        const completedPageIds = coordinatorDependencies.resumeFrom?.checkpoint.completedPageIds ?? [];
        await expect(session.start(runDirectory, { mode: 'RESUME', completedPageIds })).resolves.toMatchObject({ ok: true });
        return auditRun();
      },
      conclusion: { action: 'ABANDON' },
    });

    const outcome = await executeAuditRun(config, dependencies, { startNew: false }, observer);

    const resumeDecision = { kind: 'RESUME', runId: FIXTURE_RUN_ID, runDirectory, completedPages: 1 };
    expect(created[0]?.resumeFrom?.runDirectory).toBe(runDirectory);
    expect(calls.map(({ hook }) => hook)).toEqual(['onRunStarting', 'onRunStarted']);
    expect(calls[0]?.value).toEqual({ resumeDecision, notices: [] });
    expect(calls[1]?.value).toEqual({ runId: FIXTURE_RUN_ID, runDirectory, resumeDecision });
    expect(outcome).toMatchObject({ kind: 'RAN', runId: FIXTURE_RUN_ID, runDirectory, resumeDecision, notices: [] });
  });

  it('finalizes the interrupted Run after a safety violation: FINALIZE_ONLY with the run ID of the saved Run', async () => {
    const config = configFor('finalize-only');
    const sample = sampleRunCheckpoint({ startPageFinished: true });
    const runDirectory = await writeSampleCheckpoint(config.output.directory, {
      progress: { ...sample.progress, safetyViolationDetected: true },
    });
    const { observer, calls } = recordingObserver();
    const { dependencies, created } = fakeDependencies();

    const outcome = await executeAuditRun(config, dependencies, { startNew: false }, observer);

    const resumeDecision = { kind: 'FINALIZE_ONLY', runId: FIXTURE_RUN_ID, runDirectory };
    expect(created[0]?.resumeFrom?.runDirectory).toBe(runDirectory);
    expect(calls[0]?.value).toEqual({ resumeDecision, notices: [] });
    expect(outcome).toMatchObject({ kind: 'RAN', resumeDecision });
  });

  it('does not look for the interrupted Run with startNew', async () => {
    const config = configFor('resume-start-new');
    await writeSampleCheckpoint(config.output.directory);
    const { observer, calls } = recordingObserver();
    const { dependencies, created } = fakeDependencies();

    await executeAuditRun(config, dependencies, { startNew: true }, observer);

    expect(created[0]?.resumeFrom).toBeUndefined();
    expect(calls[0]?.value).toEqual({ resumeDecision: { kind: 'NEW_RUN' }, notices: [] });
  });

  it('starts a new Run with the CONFIG_DIFFERS notice when the configuration of the interrupted Run differs', async () => {
    const outputDirectory = join(workDirectory, 'config-differs');
    await writeSampleCheckpoint(outputDirectory);
    const config = createTestConfig(FIXTURE_ORIGIN, '/', { output: { directory: outputDirectory }, crawl: { maxPages: 7 } });
    const { observer, calls } = recordingObserver();
    const { dependencies, created } = fakeDependencies();

    const outcome = await executeAuditRun(config, dependencies, { startNew: false }, observer);

    const notices = [{ kind: 'CONFIG_DIFFERS', runId: FIXTURE_RUN_ID, differences: ['crawl.maxPages'] }];
    expect(created[0]?.resumeFrom).toBeUndefined();
    expect(calls[0]?.value).toEqual({ resumeDecision: { kind: 'NEW_RUN' }, notices });
    expect(outcome).toMatchObject({ kind: 'RAN', resumeDecision: { kind: 'NEW_RUN' }, notices });
  });

  it('starts a new Run with the CHECKPOINT_UNREADABLE notice when the checkpoint cannot be read', async () => {
    const config = configFor('unreadable');
    const runDirectory = runArtifactDirectory(config.output.directory, FIXTURE_RUN_ID);
    await mkdir(artifactFilePath(runDirectory, checkpointArtifactRelativePath('state').split('/')[0] ?? ''), { recursive: true });
    await writeFile(artifactFilePath(runDirectory, checkpointArtifactRelativePath('state')), '{ not json', 'utf8');
    const { observer, calls } = recordingObserver();
    const { dependencies } = fakeDependencies();

    const outcome = await executeAuditRun(config, dependencies, { startNew: false }, observer);

    const notices = [{ kind: 'CHECKPOINT_UNREADABLE', runId: FIXTURE_RUN_ID }];
    expect(calls[0]?.value).toEqual({ resumeDecision: { kind: 'NEW_RUN' }, notices });
    expect(outcome).toMatchObject({ kind: 'RAN', notices });
  });

  // LG-4（テストの組の設計書 3.7.3、3.7.5）: 再開に使う保存の前の形は捨てた。前の形の保存は、今の閉じた理由で知らせて、新しい Run として始める
  // （読み替えて再開しない）。
  describe('LG-4: a checkpoint of a previous form is not resumed', () => {
    /** 保存のファイル（Run のディレクトリからの相対パス）の JSON を読み、`change` で書き換えて書き戻す（書き手の検証を通さない）。 */
    const rewriteJson = async (path: string, change: (value: Record<string, unknown>) => Record<string, unknown>): Promise<void> => {
      await writeFile(path, JSON.stringify(change(JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>)), 'utf8');
    };
    const statePathOf = (runDirectory: string): string => artifactFilePath(runDirectory, checkpointArtifactRelativePath('state'));
    const startOf = async (config: AuditConfig): Promise<unknown> => {
      const { observer, calls } = recordingObserver();
      const { dependencies, created } = fakeDependencies();
      await executeAuditRun(config, dependencies, { startNew: false }, observer);
      expect(created[0]?.resumeFrom).toBeUndefined();
      return calls[0]?.value;
    };

    it('starts a new Run with CHECKPOINT_UNREADABLE when the page checkpoint holds a page.json of page-schema/1.0', async () => {
      const config = configFor('lg4-page-schema-10');
      const runDirectory = await writeSampleCheckpoint(config.output.directory);
      const pagesDirectory = artifactFilePath(runDirectory, CHECKPOINT_PAGES_ARTIFACT_DIRECTORY);
      const [pageFile] = await readdir(pagesDirectory);
      await rewriteJson(join(pagesDirectory, pageFile ?? ''), (page) => ({ ...page, result: { ...(page['result'] as object), schemaVersion: 'page-schema/1.0' } }));

      expect(await startOf(config)).toEqual({ resumeDecision: { kind: 'NEW_RUN' }, notices: [{ kind: 'CHECKPOINT_UNREADABLE', runId: FIXTURE_RUN_ID }] });
    });

    it('starts a new Run with CHECKPOINT_UNREADABLE when the counts of the audit stage do not have the counts added later', async () => {
      const full = {
        registeredReadRequestsAllowed: 0, tokenRefreshBlocked: 0, otherNonReadBlocked: 0, serviceUnauthorizedResponses: 0, serviceRequestsAdmitted: 0,
        serviceRequestLimitRefused: 0, allowedOriginDataRequestsBlocked: 0, serviceRequestPacingWaits: 0, serviceRequestPacingWaitMs: 0,
      };
      const { allowedOriginDataRequestsBlocked: _blocked, serviceRequestPacingWaits: _waits, serviceRequestPacingWaitMs: _waitMs, ...previous } = full;
      const withCounts = (counts: object) => (state: Record<string, unknown>): Record<string, unknown> =>
        ({ ...state, load: { ...(state['load'] as object), auditStageCounts: counts } });
      // 対照: 今の形の数を持つ保存は、読めて再開の候補になる（読めない理由は、数がないことだけ）。
      const control = configFor('lg4-counts-control');
      const controlDirectory = await writeSampleCheckpoint(control.output.directory);
      await rewriteJson(statePathOf(controlDirectory), withCounts(full));
      expect(await new ArtifactWriter().readCheckpointState(controlDirectory, checkRunCheckpointConsistency)).toMatchObject({ ok: true });

      const config = configFor('lg4-counts');
      const runDirectory = await writeSampleCheckpoint(config.output.directory);
      await rewriteJson(statePathOf(runDirectory), withCounts(previous));

      expect(await startOf(config)).toEqual({ resumeDecision: { kind: 'NEW_RUN' }, notices: [{ kind: 'CHECKPOINT_UNREADABLE', runId: FIXTURE_RUN_ID }] });
    });

    it('starts a new Run with CONFIG_DIFFERS when the saved settings do not have the audit send policy (not read as READ_ONLY)', async () => {
      const config = configFor('lg4-send-policy');
      const runDirectory = await writeSampleCheckpoint(config.output.directory);
      await rewriteJson(statePathOf(runDirectory), (state) => {
        const effectiveConfig = state['effectiveConfig'] as { readonly audit: Record<string, unknown> };
        const { sendPolicy: _sendPolicy, ...audit } = effectiveConfig.audit;
        return { ...state, effectiveConfig: { ...effectiveConfig, audit } };
      });

      expect(await startOf(config)).toEqual({
        resumeDecision: { kind: 'NEW_RUN' },
        notices: [{ kind: 'CONFIG_DIFFERS', runId: FIXTURE_RUN_ID, differences: ['audit.sendPolicy'] }],
      });
    });
  });

  it('returns VERSION_MISMATCH with the differences of the versions, without creating the Run Coordinator', async () => {
    const config = configFor('version-mismatch');
    const savedVersion = '0.0.0-saved-by-another-version';
    const runDirectory = await writeSampleCheckpoint(config.output.directory, { toolVersion: savedVersion });
    const { observer, calls } = recordingObserver();
    const { dependencies, created } = fakeDependencies();

    const outcome: AuditRunOutcome = await executeAuditRun(config, dependencies, { startNew: false }, observer);

    expect(outcome).toEqual({
      kind: 'VERSION_MISMATCH',
      runId: FIXTURE_RUN_ID,
      runDirectory,
      differences: [{ field: 'toolVersion', saved: savedVersion, current: await readToolVersion() }],
      exitCode: RUN_UNAVAILABLE_EXIT_CODE,
    });
    expect(created).toHaveLength(0);
    expect(calls).toEqual([]);
  });
});
