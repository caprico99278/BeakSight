// T24c（DEF-057。Task 24 の設計書 4.6）: 同じ出力先に 2 つの起動が重なっても、Run は 1 つだけ始まる。
// - 2 つの起動を、開始の段（実行中の Run の確かめ → 再開する Run の選択 → Run のディレクトリとロックの作成）の間に重なるように動かす。
//   重ね方は時間に左右されない: 中核の依存の注入（`createRunCoordinator`）で、それぞれの Run Coordinator の `run()` を、もう片方の起動が
//   Run Coordinator を作る段に来るか、終わるまで待たせる。開始の守りがなければ、どちらも実行中の Run の確かめを通り、2 つの Run が始まる。
// - 2 つの起動の時計は 1 時間ずらす（Run の ID の秒を違える。同じ秒なら、2 つ目は Run のディレクトリを作れずに終わるため、隙間が見えない）。
// - 期待: 片方だけが Run を実行し（`RAN`）、もう片方は `RUN_ACTIVE`（終了コード 4）。出力先の Run のディレクトリは 1 つ、fixture のサーバに
//   届いた robots.txt の要求は 1 回（Run 1 つ分）。開始のロックのファイルは、終わった後に残らない。
// - 安全のテストの決まり: テストの既定の Chromium（`launchHeadlessChromium`）と、CLI の起動の設定（`launchCliChromium`）の両方で確かめる。
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { executeAuditRun, type AuditRunDependencies, type AuditRunOutcome } from '../../src/cli/audit-run.js';
import { RUN_UNAVAILABLE_EXIT_CODE } from '../../src/cli/exit-codes.js';
import type { AuditConfig } from '../../src/config/types.js';
import { listRunDirectories, outputStartLockPath } from '../../src/core/artifact-layout.js';
import type { BrowserLauncher } from '../../src/orchestration/preflight.js';
import { RunCoordinator } from '../../src/orchestration/run-coordinator.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { createDeferred, type Deferred } from '../helpers/deferred.js';
import { fastRunConfig } from '../helpers/run-harness.js';

const SUITE_TIMEOUT_MS = 300_000;
const START_PATH = '/crawl/index.html';
/** 2 つ目の起動の時計のずれ（Run の ID の秒を違えるため。1 時間）。 */
const SECOND_START_CLOCK_OFFSET_MS = 3_600_000;
/** Run 1 つが、fixture のサーバに robots.txt を求める回数。 */
const ROBOTS_REQUESTS_PER_RUN = 1;
const ROBOTS_PATH = '/robots.txt';

let server: FixtureServer;
let workDirectory: string;
const launchedBrowsers: Browser[] = [];

beforeAll(async () => {
  server = await startFixtureServer();
  workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-output-start-lock-'));
}, SUITE_TIMEOUT_MS);

afterAll(async () => {
  const connected = launchedBrowsers.filter((browser) => browser.isConnected());
  await Promise.all(connected.map(async (browser) => browser.close().catch(() => undefined)));
  await server?.close();
  if (workDirectory !== undefined) {
    await rm(workDirectory, { recursive: true, force: true });
  }
  expect(connected.length, 'Browsers left connected after the Runs').toBe(0);
});

/** 起動した Browser を記録する launcher（いつも headless。`launch` は、テストの既定か CLI の起動の設定）。 */
const recordingLauncher = (launch: () => Promise<Browser>): BrowserLauncher => async () => {
  const browser = await launch();
  launchedBrowsers.push(browser);
  return browser;
};

const LAUNCHERS = [
  { name: 'the default test Chromium (launchHeadlessChromium)', launch: () => launchHeadlessChromium() },
  { name: 'the CLI launch options (launchCliChromium)', launch: () => launchCliChromium() },
] as const;

/** 重なる 2 つの起動の、それぞれの印。 */
interface StartSignals {
  /** その起動が、Run Coordinator を作る段に来た。 */
  readonly reachedCoordinator: Deferred<void>;
  /** その起動の `executeAuditRun` が終わった。 */
  readonly finished: Deferred<void>;
}

/**
 * 2 つの起動を、開始の段の間に重なるように動かす。`index` の起動の Run Coordinator の `run()` は、もう片方の起動が Run Coordinator を作る段に
 * 来るか、終わるまで待つ（時間には左右されない）。
 */
async function runOverlappingStarts(config: AuditConfig, launchBrowser: BrowserLauncher): Promise<readonly AuditRunOutcome[]> {
  const signals: readonly StartSignals[] = [0, 1].map(() => ({ reachedCoordinator: createDeferred<void>(), finished: createDeferred<void>() }));
  const dependenciesFor = (index: number, clockOffsetMs: number): AuditRunDependencies => {
    const other = signals[1 - index]!;
    return {
      launchBrowser,
      clock: () => new Date(Date.now() + clockOffsetMs),
      now: () => Date.now(),
      createRunCoordinator: (dependencies) => {
        signals[index]!.reachedCoordinator.resolve();
        const coordinator = new RunCoordinator(dependencies);
        return {
          run: async () => {
            await Promise.race([other.reachedCoordinator.promise, other.finished.promise]);
            return await coordinator.run();
          },
          checkpointConclusion: () => coordinator.checkpointConclusion(),
        };
      },
    };
  };
  const start = async (index: number, clockOffsetMs: number): Promise<AuditRunOutcome> => {
    try {
      return await executeAuditRun(config, dependenciesFor(index, clockOffsetMs), { startNew: false });
    } finally {
      signals[index]!.finished.resolve();
    }
  };
  return await Promise.all([start(0, 0), start(1, SECOND_START_CLOCK_OFFSET_MS)]);
}

describe.each(LAUNCHERS)('DEF-057: two overlapping starts on the same output directory with $name', ({ name, launch }) => {
  it('starts only one Run; the other start ends with RUN_ACTIVE (exit code 4) and the start lock does not remain', async () => {
    const outputDirectory = join(workDirectory, name.replace(/[^a-z]+/giu, '-'));
    const config = fastRunConfig(server.origin, START_PATH, { target: { id: 'output-start-lock' }, output: { directory: outputDirectory } });
    server.resetRequestObservations();

    const outcomes = await runOverlappingStarts(config, recordingLauncher(launch));

    const runDirectories = await listRunDirectories(outputDirectory);
    const robotsRequests = server.getRequestObservations().filter(({ pathname }) => pathname === ROBOTS_PATH).length;
    expect({ runDirectories: runDirectories.length, robotsRequests }).toEqual({ runDirectories: 1, robotsRequests: ROBOTS_REQUESTS_PER_RUN });
    expect(outcomes.map(({ kind }) => kind).sort()).toEqual(['RAN', 'RUN_ACTIVE']);
    // 片方は、もう片方が開始の段にいる間に来たので、実行中の Run の ID はまだない（`null`）。
    expect(outcomes.find(({ kind }) => kind === 'RUN_ACTIVE')).toEqual({ kind: 'RUN_ACTIVE', activeRunId: null, exitCode: RUN_UNAVAILABLE_EXIT_CODE });
    expect(existsSync(outputStartLockPath(outputDirectory))).toBe(false);
  }, SUITE_TIMEOUT_MS);
});
