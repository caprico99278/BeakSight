// SR-1-F2（DEF-170。目当てを絞った再レビュー SR-1R の Critical）: 本物の CLI（同じ process の `runCli`、本物の Chromium、127.0.0.1 の fixture の
// サーバ）を 3 つ、同じ出力先で起動し、古いロックの取り直しを重ねても、途中の Run を再開するのは 1 つだけで、サーバへの読み取りは 1 つ分だけ。
// レビュー担当の実験 `scratchpad\sr-1r\exp\cli-double.test.ts` の `forced` と同じ形: `node:fs/promises` の `rename`・`link` に止め口を入れて順番を
// 決める（時間に左右されない）。
//  段 1（出力先の開始のロック）: A が古い開始のロックを動かす直前で止まる → B が来る → A が動かす → C が来る → A が続ける。
//  段 2（Run のロック）: B が古い Run のロックを動かす直前で止まる → C が来て再開の Run のロックを作る → B が続ける。
// 直す前は、B と C の両方が同じ Run を再開した（ページの GET が単独の倍）。直した後は、取り直しの札で、ほかが取り直している間の起動は止まる
// （止め口に来ない起動は、その起動の終わりで止め口を開ける。待ち続けない）。どの回も、サーバに届くのは GET・HEAD だけ。
import { spawnSync } from 'node:child_process';
import { cpSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { RUN_UNAVAILABLE_EXIT_CODE } from '../../src/cli/exit-codes.js';
import { runCli } from '../../src/cli/main.js';
import { artifactFilePath, checkpointArtifactRelativePath, listRunDirectories, outputStartLockPath } from '../../src/core/artifact-layout.js';
import { wait } from '../../src/core/deadline.js';
import { createRunLock, currentProcessRunLockHost, isProcessRunning, RUN_LOCK_TAKEOVER_GRACE_MS } from '../../src/core/process-lock.js';
import { createNavigationPacer, type NavigationPacer } from '../../src/crawl/navigation-pacer.js';
import type { RunCheckpointSession } from '../../src/orchestration/run-checkpoint-session.js';
import { RunCoordinator } from '../../src/orchestration/run-coordinator.js';
import { formatDuration } from '../../src/presentation/format.js';
import { runLockGraceWaitText, runLockLostText } from '../../src/presentation/messages.js';
import { createDeferred } from '../helpers/deferred.js';
import { captureCliOutput, cliTargetConfig, createRunLauncher } from '../helpers/run-harness.js';

type FileSystem = typeof import('node:fs/promises');
interface FileHooks {
  rename?: ((original: FileSystem['rename'], from: string, to: string) => Promise<void>) | undefined;
  link?: ((original: FileSystem['link'], from: string, to: string) => Promise<void>) | undefined;
  /** 消した後に呼ぶ（消したパス）。 */
  removed?: ((path: string) => void) | undefined;
}

const hooks = vi.hoisted((): FileHooks => ({}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<FileSystem>();
  const rename = async (from: string, to: string): Promise<void> =>
    (hooks.rename === undefined ? original.rename(from, to) : hooks.rename(original.rename, from, to));
  const link = async (from: string, to: string): Promise<void> =>
    (hooks.link === undefined ? original.link(from, to) : hooks.link(original.link, from, to));
  const rm = async (...args: Parameters<FileSystem['rm']>): Promise<void> => {
    await original.rm(...args);
    hooks.removed?.(String(args[0]));
  };
  return { ...original, rename, link, rm, default: { ...original, rename, link, rm } };
});

const SUITE_TIMEOUT_MS = 600_000;
const START_PATH = '/crawl/index.html';
/** 古いロックの OS の起動の時刻のずれ（判定の許しの幅を大きく超える）。 */
const OTHER_BOOT_OFFSET_MS = 86_400_000;
const START_LOCK_NAME = '.beaksight-run-start.lock';
const START_LOCK_MOVED = `${START_LOCK_NAME}.stale-`;
const RUN_LOCK_MOVED = '.run.lock.stale-';
const RUN_LOCK_NEW = '.run.lock.new-';
/** ロックを失った場面の、外から渡す pacer の最小の間隔（ms）と、気づくのを待つ上限と、読み直す間隔（ms）。 */
const NAVIGATION_INTERVAL_MS = 300;
const DETECTION_LIMIT_MS = 10_000;
const DETECTION_POLL_MS = 10;
/** DEF-172: 2 つ目の起動の時計のずれ（ms。スリープの後、時計の跳び、止まった process の後を模す）。 */
const CLOCK_SHIFT_MS = 6 * 60_000;

let server: FixtureServer;
let workDirectory = '';
let configPath = '';
let otherConfigPath = '';
let template = '';
const runLauncher = createRunLauncher();

const dependencies = () => ({ launchBrowser: runLauncher.launcher, clock: () => new Date(), now: () => Date.now() });
/** 前の起動の古いロック（OS の起動の時刻が違い、持ち主の process も終わっている。DEF-172 の猶予を置かずに取り直す形）。 */
const staleLock = (): object => {
  const host = currentProcessRunLockHost(Date.now());
  const finished = spawnSync(process.execPath, ['-e', '']).pid ?? 0;
  if (isProcessRunning(finished)) {
    throw new Error('could not get the ID of a finished process');
  }
  return { ...createRunLock({ ...host, processId: finished }), bootedAtMs: host.bootedAtMs - OTHER_BOOT_OFFSET_MS };
};
const cli = async (output: string): Promise<number> => runCli(['run', '--config', configPath, '--output', output, '--headless'],
  { stdout: captureCliOutput().output, stderr: captureCliOutput().output }, { run: dependencies() });
const pageGets = (): number => server.getRequestObservations().filter(({ method, pathname }) => method === 'GET' && pathname.endsWith('.html')).length;
const nonReadCount = (): number => {
  const { post, put, patch, delete: deleted, options, other } = server.getCounters();
  return post + put + patch + deleted + options + other;
};

beforeAll(async () => {
  server = await startFixtureServer();
  workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-cli-lock-overlap-'));
  configPath = join(workDirectory, 'target.json');
  template = join(workDirectory, 'template');
  await writeFile(configPath, JSON.stringify(cliTargetConfig('lock-overlap', server.origin, START_PATH, { audit: { screenshots: false } })), 'utf8');
  // DEF-172: 同じ出力先の、別の対象の設定（新しい Run を始める形）。
  otherConfigPath = join(workDirectory, 'other-target.json');
  await writeFile(otherConfigPath, JSON.stringify(cliTargetConfig('lock-overlap-other', server.origin, START_PATH, { audit: { screenshots: false } })), 'utf8');
  // 1 ページ目の後に止めた Run（再開の対象）。
  const controller = new AbortController();
  await runCli(['run', '--config', configPath, '--output', template, '--headless'], { stdout: captureCliOutput().output, stderr: captureCliOutput().output }, {
    run: {
      ...dependencies(),
      stopSignal: controller.signal,
      createRunCoordinator: (coordinatorDependencies) => new RunCoordinator({
        ...coordinatorDependencies,
        onProgress: (report) => {
          coordinatorDependencies.onProgress?.(report);
          if (report.pagesFinished === 1) {
            controller.abort();
          }
        },
      }),
    },
  });
  expect(await listRunDirectories(template)).toHaveLength(1);
}, SUITE_TIMEOUT_MS);

afterAll(async () => {
  hooks.rename = undefined;
  hooks.link = undefined;
  const left = await runLauncher.closeAll();
  await server?.close();
  if (workDirectory !== '') {
    await rm(workDirectory, { recursive: true, force: true });
  }
  expect(left).toBe(0);
}, SUITE_TIMEOUT_MS);

/** 止めた Run の写しに、古い Run のロックと古い開始のロックを置く。 */
async function prepare(name: string): Promise<string> {
  const output = join(workDirectory, name);
  cpSync(template, output, { recursive: true });
  const [run] = await listRunDirectories(output);
  if (run === undefined) {
    throw new Error('the stopped run is missing');
  }
  await writeFile(artifactFilePath(run.runDirectory, checkpointArtifactRelativePath('lock')), JSON.stringify(staleLock()), 'utf8');
  await writeFile(outputStartLockPath(output), JSON.stringify(staleLock()), 'utf8');
  return output;
}

describe('DEF-170: three CLI resumes with overlapping takeovers of the stale locks', () => {
  let baseline = 0;

  it('resumes the stopped Run alone (the baseline of the page reads)', async () => {
    const output = await prepare('baseline');
    server.resetCounters();
    server.resetRequestObservations();
    expect(await cli(output)).toBe(0);
    baseline = pageGets();
    expect(baseline).toBeGreaterThan(0);
    expect(nonReadCount()).toBe(0);
  }, SUITE_TIMEOUT_MS);

  it('lets only one of the three resume the Run, and the others stop (forced order)', async () => {
    const output = await prepare('forced');
    const aAtStart = createDeferred<void>();
    const aMayMoveStart = createDeferred<void>();
    const aMovedStart = createDeferred<void>();
    const aMayGoOn = createDeferred<void>();
    const bAtRun = createDeferred<void>();
    const bMayMoveRun = createDeferred<void>();
    const bMovedRun = createDeferred<void>();
    const bMayGoOn = createDeferred<void>();
    const cLinked = createDeferred<void>();
    const cStartLinked = createDeferred<void>();
    const movedRemoved = createDeferred<void>();
    let movedByB = '';
    // Run のロックの止め口は、C を起動する前に来た起動（B）だけ。
    const state = { startMoves: 0, runMoves: 0, bAtRun: false, cLinked: false, cStarted: false };
    hooks.rename = async (original, from, to) => {
      if (to.includes(START_LOCK_MOVED)) {
        state.startMoves += 1;
        if (state.startMoves === 1) {
          aAtStart.resolve();
          await aMayMoveStart.promise;
          await original(from, to);
          aMovedStart.resolve();
          await aMayGoOn.promise;
          return;
        }
      } else if (to.includes(RUN_LOCK_MOVED) && !state.cStarted) {
        state.runMoves += 1;
        if (state.runMoves === 1) {
          state.bAtRun = true;
          bAtRun.resolve();
          await bMayMoveRun.promise;
          await original(from, to);
          movedByB = to;
          bMovedRun.resolve();
          await bMayGoOn.promise;
          return;
        }
      }
      await original(from, to);
    };
    hooks.removed = (path) => {
      if (movedByB !== '' && resolve(path) === resolve(movedByB)) {
        movedRemoved.resolve();
      }
    };
    hooks.link = async (original, from, to) => {
      await original(from, to);
      if (state.cStarted && to.endsWith(START_LOCK_NAME)) {
        cStartLinked.resolve();
      }
      if (!state.cLinked && state.bAtRun && to.endsWith('run.lock') && from.includes(RUN_LOCK_NEW)) {
        state.cLinked = true;
        cLinked.resolve();
        bMayMoveRun.resolve();
        await bMovedRun.promise;
      }
    };
    server.resetCounters();
    server.resetRequestObservations();
    let codes: readonly number[];
    try {
      const runA = cli(output);
      await Promise.race([aAtStart.promise, runA]);
      const runB = cli(output);
      // 直す前は、B は開始のロックを取り直して Run のロックの取り直しで止まる。直した後は、A が札を持つので、B はここに来ずに止まる。
      await Promise.race([bAtRun.promise, runB]);
      aMayMoveStart.resolve();
      await Promise.race([aMovedStart.promise, runA]);
      state.cStarted = true;
      const runC = cli(output);
      // C が空いた名前に開始のロックを作った後に、A を続けさせる（A は作れずに止まる）。
      await Promise.race([cStartLinked.promise, runC]);
      aMayGoOn.resolve();
      await Promise.race([cLinked.promise, runC]);
      bMayMoveRun.resolve();
      await Promise.race([bMovedRun.promise, runB]);
      // 直す前は、C の再開の後始末が、B が動かしたファイルを消す（直した後は、動いている process のものなので消さない。C の終わりまで待つ）。
      await Promise.race([movedRemoved.promise, runC]);
      bMayGoOn.resolve();
      codes = await Promise.all([runA, runB, runC]);
    } finally {
      for (const gate of [aMayMoveStart, aMayGoOn, bMayMoveRun, bMayGoOn]) {
        gate.resolve();
      }
      hooks.rename = undefined;
      hooks.link = undefined;
      hooks.removed = undefined;
    }

    expect(codes.filter((code) => code === 0), JSON.stringify({ codes, pageGets: pageGets(), baseline })).toHaveLength(1);
    expect(pageGets()).toBe(baseline);
    expect(nonReadCount()).toBe(0);
    expect(await listRunDirectories(output)).toHaveLength(1);
  }, SUITE_TIMEOUT_MS);
});

/** Run のディレクトリの中のファイルの、相対パスと大きさと更新の時刻（ロックを失った後に、何も書いていないことを確かめる）。 */
async function treeOf(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
  const described = await Promise.all(files.map(async (path) => {
    const { size, mtimeMs } = await stat(path);
    return `${relative(directory, path)} ${String(size)} ${String(mtimeMs)}`;
  }));
  return described.sort();
}

// SR-1-F2（DEF-170 の設計者の判断）: E3 の形で、Run の途中にロックを別の起動に持たれた起動（B）は、ハートビートで気づいた後に、サイトへの読み込みを
// 続けず、Run のディレクトリに何も書かず、終了コード 4 と日本語の知らせで終える。ハートビートは手で打ち（`checkpointTimers`）、別の起動（C）が
// 取り直したことは、Run のロックを C のロックに書き換えて模す。気づく前に次の読み込みを始めないよう、外から渡す pacer で、気づくまで待たせる。
describe('DEF-170: a CLI Run that lost its lock to another start', () => {
  it('stops loading the site, writes nothing into the run directory, and exits with 4 and the notice', async () => {
    const output = join(workDirectory, 'lock-lost');
    const beats: (() => void)[] = [];
    const timers = {
      setInterval: (callback: () => void) => {
        beats.push(callback);
        return { unref: () => undefined };
      },
      clearInterval: () => undefined,
    };
    const state: { lost: () => boolean; triggered: boolean; atTrigger: { gets: number; tree: readonly string[] } | null; runDirectory: string } = {
      lost: () => false,
      triggered: false,
      atTrigger: null,
      runDirectory: '',
    };
    const detected = createDeferred<void>();
    const inner = createNavigationPacer({ minIntervalMs: NAVIGATION_INTERVAL_MS, now: () => Date.now(), sleep: wait });
    const navigationPacer: NavigationPacer = {
      beforeNavigation: async () => {
        if (state.triggered) {
          await Promise.race([detected.promise, wait(DETECTION_LIMIT_MS)]);
        }
        return await inner.beforeNavigation();
      },
      snapshot: () => inner.snapshot(),
      raiseMinimumInterval: (minIntervalMs) => inner.raiseMinimumInterval(minIntervalMs),
      recordDocumentRequestSent: () => inner.recordDocumentRequestSent(),
    };
    const stdout = captureCliOutput();
    const stderr = captureCliOutput();
    server.resetCounters();
    server.resetRequestObservations();

    const code = await runCli(['run', '--config', configPath, '--output', output, '--headless'], { stdout: stdout.output, stderr: stderr.output }, {
      run: {
        ...dependencies(),
        navigationPacer,
        checkpointTimers: timers,
        createRunCoordinator: (coordinatorDependencies) => {
          const session = coordinatorDependencies.checkpointSession as RunCheckpointSession;
          state.lost = () => session.lockLost;
          return new RunCoordinator({
            ...coordinatorDependencies,
            onProgress: (report) => {
              coordinatorDependencies.onProgress?.(report);
              if (report.pagesFinished !== 1 || state.triggered) {
                return;
              }
              state.triggered = true;
              void (async () => {
                const [run] = await listRunDirectories(output);
                state.runDirectory = run?.runDirectory ?? '';
                // C が取り直したことを模す（同じ process の ID で、取った時刻の違うロック）。
                const lockPath = artifactFilePath(state.runDirectory, checkpointArtifactRelativePath('lock'));
                const other = { ...createRunLock(currentProcessRunLockHost(Date.now())), acquiredAtMs: 1 };
                await writeFile(lockPath, JSON.stringify(other), 'utf8');
                state.atTrigger = { gets: server.getCounters().get, tree: await treeOf(state.runDirectory) };
                beats.forEach((beat) => beat());
                for (let tries = 0; tries < DETECTION_LIMIT_MS / DETECTION_POLL_MS && !state.lost(); tries += 1) {
                  await wait(DETECTION_POLL_MS);
                }
                detected.resolve();
              })();
            },
          });
        },
      },
    });

    expect(state.lost()).toBe(true);
    expect(code, stderr.text()).toBe(RUN_UNAVAILABLE_EXIT_CODE);
    expect(stderr.text().split('\n')).toContain(runLockLostText);
    // 気づいた後は、サーバに読み込みが届かず、Run のディレクトリは何も変わらない（ロックは C のもののまま）。
    expect(server.getCounters().get).toBe(state.atTrigger?.gets);
    expect(await treeOf(state.runDirectory)).toEqual(state.atTrigger?.tree);
    expect(nonReadCount()).toBe(0);
  }, SUITE_TIMEOUT_MS);
});

// SR-1-F4（DEF-172）: 1 つ目の CLI（A）が Run を始めて 1 ページを終えた後に、時計が 6 分進んだ 2 つ目の CLI（B。スリープの後、時計の跳び、止まった
// process の後を模す）を同じ出力先で始める。レビュー担当の実験 `scratchpad\sr-1r2\exp\cli-clock.test.ts` の `real-timer`（同じ設定。A の途中の Run を
// 再開しようとする）と `new-run`（別の対象の設定。同じ出力先に新しい Run を始めようとする）。
// 直す前は、B は A の生きているロックを古いと判定し、両方が最後まで動いた（ページの GET が単独の倍）。直した後は、B は取り直す前の猶予を置き、
// その間に A のハートビートが進むので、動いている Run があるとして始めない（終了コード 4）。猶予の待ちは、B に注入した待ち（`sleep`）で、A の
// ハートビートを手で打って進める（実際には 75 秒待たない）。A は、B が決めるまで次の読み込みを待つ（A が先に終わって、確かめが空振りしないため）。
describe('DEF-172: a second CLI whose clock is 6 minutes ahead starts while the first one runs', () => {
  let newRunBaseline = 0;

  it('runs a new Run alone (the baseline of the page reads)', async () => {
    server.resetCounters();
    server.resetRequestObservations();
    expect(await cli(join(workDirectory, 'new-baseline'))).toBe(0);
    newRunBaseline = pageGets();
    expect(newRunBaseline).toBeGreaterThan(0);
  }, SUITE_TIMEOUT_MS);

  it.each([
    { name: 'real-timer', secondConfig: (): string => configPath },
    { name: 'new-run', secondConfig: (): string => otherConfigPath },
  ])('$name: the second start waits for the heartbeat of the running Run and does not start', async ({ name, secondConfig }) => {
    const output = join(workDirectory, `clock-${name}`);
    const beatsA: (() => void)[] = [];
    const timersA = {
      setInterval: (callback: () => void) => {
        beatsA.push(callback);
        return { unref: () => undefined };
      },
      clearInterval: () => undefined,
    };
    const decided = createDeferred<void>();
    const graceWaits: number[] = [];
    let runB: Promise<number> | null = null;
    const stderrB = captureCliOutput();
    const stdoutB = captureCliOutput();
    const startB = (): Promise<number> => runCli(['run', '--config', secondConfig(), '--output', output, '--headless'], {
      stdout: stdoutB.output, stderr: stderrB.output,
    }, {
      run: {
        launchBrowser: runLauncher.launcher,
        clock: () => new Date(Date.now() + CLOCK_SHIFT_MS),
        now: () => Date.now() + CLOCK_SHIFT_MS,
        sleep: async (ms) => {
          if (ms !== RUN_LOCK_TAKEOVER_GRACE_MS) {
            await wait(ms);
            return;
          }
          graceWaits.push(ms);
          // 猶予の間に、A のハートビート（1 分ごと）が打たれる。
          const [run] = await listRunDirectories(output);
          const lockPath = artifactFilePath(run?.runDirectory ?? '', checkpointArtifactRelativePath('lock'));
          const before = await readFile(lockPath, 'utf8').catch(() => '');
          await wait(DETECTION_POLL_MS);
          beatsA.forEach((beat) => beat());
          for (let tries = 0; tries < DETECTION_LIMIT_MS / DETECTION_POLL_MS; tries += 1) {
            if (await readFile(lockPath, 'utf8').catch(() => before) !== before) {
              break;
            }
            await wait(DETECTION_POLL_MS);
          }
          decided.resolve();
        },
      },
    });
    const inner = createNavigationPacer({ minIntervalMs: NAVIGATION_INTERVAL_MS, now: () => Date.now(), sleep: wait });
    const navigationPacerA: NavigationPacer = {
      beforeNavigation: async () => {
        if (runB !== null) {
          await Promise.race([decided.promise, runB]);
        }
        return await inner.beforeNavigation();
      },
      snapshot: () => inner.snapshot(),
      raiseMinimumInterval: (minIntervalMs) => inner.raiseMinimumInterval(minIntervalMs),
      recordDocumentRequestSent: () => inner.recordDocumentRequestSent(),
    };
    server.resetCounters();
    server.resetRequestObservations();

    const codeA = await runCli(['run', '--config', configPath, '--output', output, '--headless'], {
      stdout: captureCliOutput().output, stderr: captureCliOutput().output,
    }, {
      run: {
        ...dependencies(),
        navigationPacer: navigationPacerA,
        checkpointTimers: timersA,
        createRunCoordinator: (coordinatorDependencies) => new RunCoordinator({
          ...coordinatorDependencies,
          onProgress: (report) => {
            coordinatorDependencies.onProgress?.(report);
            if (report.pagesFinished === 1 && runB === null) {
              runB = startB();
            }
          },
        }),
      },
    });
    const codeB = await (runB ?? Promise.resolve(-1));

    expect({ codeA, codeB }, `${stdoutB.text()}\n${stderrB.text()}`).toEqual({ codeA: 0, codeB: RUN_UNAVAILABLE_EXIT_CODE });
    expect(graceWaits).toContain(RUN_LOCK_TAKEOVER_GRACE_MS);
    // B は、待つことを標準出力に知らせた。
    expect(stdoutB.text().split('\n')).toContain(runLockGraceWaitText(formatDuration(RUN_LOCK_TAKEOVER_GRACE_MS)));
    expect(pageGets()).toBe(newRunBaseline);
    expect(nonReadCount()).toBe(0);
    expect(await listRunDirectories(output)).toHaveLength(1);
  }, SUITE_TIMEOUT_MS);
});
