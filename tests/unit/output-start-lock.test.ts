// SPEC-2 の作り直し（DEF-269〜271。DEF-057 の守り）: 出力先の監査中の印（OS が持ち主の終わりと同時に放す排他）。
// - 排他（`acquireRunExclusion`）: 本物のパイプ（Linux は抽象の名前空間の socket）で確かめる。生きている持ち主がいるときは取れない・持ち主が
//   強制終了したら取れる・死んだ持ち主の後に 3 つが同時に始めても 1 つだけが取れる（REV-SPEC2 の `interleave.mjs` の順）。持ち主は node の子 process。
// - 同じディレクトリの別の綴り（Windows の大文字、`\\?\` の前置き）は、同じ排他になる（名前の元は、ディレクトリの `dev` と `ino`）。
// - 中核（`executeAuditRun`）: 持たれていれば `RUN_ACTIVE`（終了コード 4、Run Coordinator を作らない）。自分の印は Run の終わりまで持ち、
//   例外の経路と、Run を始めない結果でも離す。印を持てたかを決められなければ、保存のセッションを始めない（止まる側。差し替えで作る）。
//   出力先は別の対象と共有するので、印を離しても出力先そのものは消さない（REV-PAR の m-1。前の DEF-081 の後始末はやめた）。
// - CLI（`runAuditCommand`）: 別の Run が動いているときは、Run の ID のない文を標準エラーに出し、終了コード 4。
// 偽の Run Coordinator（`createRunCoordinator`）で確かめる（Browser を起動しない）。同じ出力先の 2 つの起動の結合は
// `tests/integration/output-start-lock.test.ts`（SLIM-GROUP: 2 つの CLI の process の結合は、ここの子 process の排他と重なるので消した）。
// 注意: Claude Code の sandbox の中では、パイプの listen が `EACCES` になる（環境の制約。sandbox の外で流す）。
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { executeAuditRun, type AuditRunDependencies, type AuditRunObserver } from '../../src/cli/audit-run.js';
import { RUN_UNAVAILABLE_EXIT_CODE } from '../../src/cli/exit-codes.js';
import { joinLines } from '../../src/cli/output.js';
import { runAuditCommand } from '../../src/cli/run-command.js';
import type { AuditConfig } from '../../src/config/types.js';
import { runArtifactDirectory } from '../../src/core/artifact-layout.js';
import type { AuditRunResult } from '../../src/core/contracts.js';
import { createRunId } from '../../src/core/ids.js';
import { acquireRunExclusion, type RunExclusion } from '../../src/core/run-exclusion.js';
import type { RunCheckpointSession } from '../../src/orchestration/run-checkpoint-session.js';
import { RunDirectoryUnavailableError, type RunCoordinatorDependencies } from '../../src/orchestration/run-coordinator.js';
import { runActiveInOutputDirectoryText } from '../../src/presentation/messages.js';
import { auditRun, FIXTURE_ORIGIN } from '../helpers/audit-run-fixture.js';
import { captureCliOutput } from '../helpers/run-harness.js';
import { createTestConfig } from '../helpers/test-config.js';
import { TYPESCRIPT_SOURCE_RESOLVE_HOOK } from '../helpers/typescript-source-hook.js';

/**
 * 印を持てたかを決められない場面（`UNAVAILABLE`。止まる側）を作る差し替え。`cause` が `undefined` なら本物の `acquireRunExclusion` のまま
 * （このファイルのほかの場面は、本物のパイプを使う）。
 */
const exclusionFailure = vi.hoisted(() => ({ cause: undefined as Error | undefined }));
vi.mock('../../src/core/run-exclusion.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/run-exclusion.js')>();
  return {
    ...actual,
    acquireRunExclusion: async (outputDirectory: string, targetId: string): Promise<RunExclusion> => exclusionFailure.cause === undefined
      ? await actual.acquireRunExclusion(outputDirectory, targetId)
      : Object.freeze<RunExclusion>({ kind: 'UNAVAILABLE', cause: exclusionFailure.cause }),
  };
});

/** 死んだ持ち主の後に、同時に始める起動の数（REV-SPEC2 の `interleave.mjs` の 3 つ）と、その回の数。 */
const CONTENDERS_AT_ONCE = 3;
const CONTENTION_ROUNDS = 3;
const CHILD_TEST_TIMEOUT_MS = 60_000;

let workDirectory: string;
let caseNumber = 0;

beforeAll(async () => {
  workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-output-start-lock-'));
});

afterAll(async () => {
  await rm(workDirectory, { recursive: true, force: true });
});

/** テストごとに別の出力先。 */
function newOutputDirectory(): string {
  caseNumber += 1;
  return join(workDirectory, `case-${caseNumber}`);
}

/** テストごとに別の出力先に書く設定。 */
const newConfig = (): AuditConfig => createTestConfig(FIXTURE_ORIGIN, '/', { output: { directory: newOutputDirectory() } });

/** 印の対象の ID（設定の `target.id`）と、同じ出力先に書く別の対象の ID（PAR-a）。 */
const TARGET_ID = createTestConfig(FIXTURE_ORIGIN, '/').target.id;
const OTHER_TARGET_ID = `${TARGET_ID}-other`;

const failingLaunch = async (): Promise<never> => {
  throw new Error('browser launch is not allowed in this test');
};

/** 取った排他を離す（取れたときだけ）。 */
async function releaseIfAcquired(exclusion: RunExclusion): Promise<void> {
  if (exclusion.kind === 'ACQUIRED') {
    await exclusion.release();
  }
}

/**
 * 子 process の本文。`ready` を出してから、`go` のファイルを待って（`-` なら待たずに）排他を取り、結果の種類を出す。離さずに、`-` なら
 * 止められるまで、ほかは `<go>.end` のファイルができるまで生きている（相手から見て、持ち主が動いているようにする）。
 */
const CONTENDER_SOURCE = `${TYPESCRIPT_SOURCE_RESOLVE_HOOK}
const { existsSync } = await import('node:fs');
const { acquireRunExclusion } = await import(${JSON.stringify(pathToFileURL(resolve('src/core/run-exclusion.ts')).href)});
const [outputDirectory, goFile, targetId] = process.argv.slice(1);
const waitFor = async (path) => {
  while (!existsSync(path)) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
};
process.stdout.write('ready\\n');
if (goFile !== '-') {
  await waitFor(goFile);
}
const result = await acquireRunExclusion(outputDirectory, targetId);
process.stdout.write('kind:' + result.kind + '\\n');
if (goFile === '-') {
  setInterval(() => undefined, 1000);
} else {
  await waitFor(goFile + '.end');
}
`;

/** 子 process の起動（`ready` と答え（結果の種類）を待てる。`closed` は終わり。`kill` は強制終了）。 */
function startContender(outputDirectory: string, goFile: string): {
  readonly ready: Promise<void>;
  readonly answer: Promise<string>;
  readonly closed: Promise<void>;
  readonly kill: () => void;
} {
  const child = spawn(process.execPath, ['--input-type=module', '-e', CONTENDER_SOURCE, outputDirectory, goFile, TARGET_ID], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let markReady: () => void = () => undefined;
  let markAnswer: (kind: string) => void = () => undefined;
  const ready = new Promise<void>((resolveReady) => {
    markReady = resolveReady;
  });
  const answer = new Promise<string>((resolveAnswer) => {
    markAnswer = resolveAnswer;
  });
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk;
    if (output.includes('ready\n')) {
      markReady();
    }
    const kind = /kind:(\w+)\n/u.exec(output)?.[1];
    if (kind !== undefined) {
      markAnswer(kind);
    }
  });
  child.stderr.resume();
  const closed = new Promise<void>((resolveClosed) => {
    child.on('close', () => {
      markReady();
      markAnswer('');
      resolveClosed();
    });
  });
  return { ready, answer, closed, kill: () => child.kill('SIGKILL') };
}

/** 排他を取って持ち続ける子 process（持ち主）。取れたことを確かめてから返す。 */
async function startOwner(outputDirectory: string): Promise<ReturnType<typeof startContender>> {
  const owner = startContender(outputDirectory, '-');
  expect(await owner.answer).toBe('ACQUIRED');
  return owner;
}

/** 偽の Run Coordinator の `run()`（CLI が作った保存のセッションと、Run Coordinator に渡した依存を受け取る）。 */
type FakeRun = (input: { readonly session: RunCheckpointSession; readonly dependencies: RunCoordinatorDependencies }) => Promise<AuditRunResult>;

/** 偽の Run Coordinator を使う依存。`created` は、Run Coordinator を作った回数の記録。 */
function fakeDependencies(run: FakeRun = async () => auditRun()): {
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
        return { run: async () => await run({ session, dependencies }), checkpointConclusion: () => ({ action: 'NONE' }) };
      },
    },
  };
}

/** 呼ばれた観測の口の名前の記録。 */
function recordingObserver(): { readonly observer: AuditRunObserver; readonly hooks: string[] } {
  const hooks: string[] = [];
  return {
    hooks,
    observer: {
      onRunStarting: () => hooks.push('onRunStarting'),
      onRunStarted: () => hooks.push('onRunStarted'),
      onProgress: () => hooks.push('onProgress'),
      onNotice: () => hooks.push('onNotice'),
    },
  };
}

describe('acquireRunExclusion: the OS releases the exclusion when its owner ends', () => {
  it('cannot be acquired while a living owner process holds it', async () => {
    const outputDirectory = newOutputDirectory();
    const owner = await startOwner(outputDirectory);
    try {
      await expect(acquireRunExclusion(outputDirectory, TARGET_ID)).resolves.toEqual({ kind: 'HELD' });
    } finally {
      owner.kill();
      await owner.closed;
    }
  }, CHILD_TEST_TIMEOUT_MS);

  it('can be acquired right after the owner process is killed', async () => {
    const outputDirectory = newOutputDirectory();
    const owner = await startOwner(outputDirectory);
    owner.kill();
    await owner.closed;

    const exclusion = await acquireRunExclusion(outputDirectory, TARGET_ID);
    expect(exclusion.kind).toBe('ACQUIRED');
    await releaseIfAcquired(exclusion);
  }, CHILD_TEST_TIMEOUT_MS);

  it(`lets only one of ${CONTENDERS_AT_ONCE} starts at once acquire it after a killed owner, in each of ${CONTENTION_ROUNDS} rounds`, async () => {
    const acquiredPerRound: number[] = [];
    for (let round = 1; round <= CONTENTION_ROUNDS; round += 1) {
      const outputDirectory = newOutputDirectory();
      const owner = await startOwner(outputDirectory);
      owner.kill();
      await owner.closed;
      const goFile = join(workDirectory, `go-${String(caseNumber)}`);
      const contenders = Array.from({ length: CONTENDERS_AT_ONCE }, () => startContender(outputDirectory, goFile));
      await Promise.all(contenders.map(async ({ ready }) => await ready));
      await writeFile(goFile, '');
      // どの子 process も、全部が答えるまで持ち続ける（終わって放さない）。
      const kinds = await Promise.all(contenders.map(async ({ answer }) => await answer));
      await writeFile(`${goFile}.end`, '');
      await Promise.all(contenders.map(async ({ closed }) => await closed));
      expect(kinds.every((kind) => kind === 'ACQUIRED' || kind === 'HELD'), kinds.join(',')).toBe(true);
      acquiredPerRound.push(kinds.filter((kind) => kind === 'ACQUIRED').length);
    }
    expect(acquiredPerRound).toEqual(Array.from({ length: CONTENTION_ROUNDS }, () => 1));
  }, CHILD_TEST_TIMEOUT_MS);

  // PAR-a: 印は「出力先 + 対象の ID」の単位。同じ出力先でも対象が違えば両方取れ、同じ対象なら今どおり持たれている。
  it('is per output directory and target: another target in the same directory is acquired, the same target is held', async () => {
    const outputDirectory = newOutputDirectory();
    const first = await acquireRunExclusion(outputDirectory, TARGET_ID);
    const other = await acquireRunExclusion(outputDirectory, OTHER_TARGET_ID);
    try {
      expect([first.kind, other.kind]).toEqual(['ACQUIRED', 'ACQUIRED']);
      await expect(acquireRunExclusion(outputDirectory, TARGET_ID)).resolves.toEqual({ kind: 'HELD' });
    } finally {
      await releaseIfAcquired(first);
      await releaseIfAcquired(other);
    }
  });

  // REV-PAR の m-1: 出力先は別の対象と共有するので、印を離しても出力先そのものは消さない（別の対象の起動が持つ出力先を作り直させない。DEF-081 の
  // 後始末はやめた）。
  it('keeps the shared output directory when a target releases it while another target holds it', async () => {
    const outputDirectory = newOutputDirectory();
    const first = await acquireRunExclusion(outputDirectory, TARGET_ID);
    const other = await acquireRunExclusion(outputDirectory, OTHER_TARGET_ID);
    try {
      const before = statSync(outputDirectory).ino;
      await releaseIfAcquired(first);
      expect(statSync(outputDirectory).ino).toBe(before);
      await expect(acquireRunExclusion(outputDirectory, OTHER_TARGET_ID)).resolves.toEqual({ kind: 'HELD' });
    } finally {
      await releaseIfAcquired(other);
    }
  });

  // REV-SPEC2 第 2 回の C-3（`race2.mjs alias` の順）: 同じディレクトリを別の綴り（大文字、`\\?\` の前置き）で指しても、同じ排他になる。
  it.runIf(process.platform === 'win32')('is the same exclusion for the other spellings of the same output directory (the case, the \\\\?\\ prefix)', async () => {
    const outputDirectory = newOutputDirectory();
    const exclusion = await acquireRunExclusion(outputDirectory, TARGET_ID);
    try {
      expect(exclusion.kind).toBe('ACQUIRED');
      for (const spelling of [outputDirectory.toUpperCase(), `\\\\?\\${outputDirectory}`]) {
        await expect(acquireRunExclusion(spelling, TARGET_ID), spelling).resolves.toEqual({ kind: 'HELD' });
      }
    } finally {
      await releaseIfAcquired(exclusion);
    }
  });
});

describe('executeAuditRun: the exclusion of the output directory', () => {
  it('respects the exclusion held by another start: RUN_ACTIVE, exit code 4, no Run Coordinator', async () => {
    const config = newConfig();
    const other = await acquireRunExclusion(config.output.directory, config.target.id);
    const { dependencies, created } = fakeDependencies();
    const { observer, hooks } = recordingObserver();
    try {
      const outcome = await executeAuditRun(config, dependencies, { startNew: false }, observer);

      expect(outcome).toEqual({ kind: 'RUN_ACTIVE', exitCode: RUN_UNAVAILABLE_EXIT_CODE });
      expect(created).toHaveLength(0);
      expect(hooks).toEqual([]);
    } finally {
      await releaseIfAcquired(other);
    }
  });

  it('prints the text to stderr and exits with code 4 in the CLI', async () => {
    const config = newConfig();
    const other = await acquireRunExclusion(config.output.directory, config.target.id);
    const stdout = captureCliOutput();
    const stderr = captureCliOutput();
    try {
      const exitCode = await runAuditCommand(config, { stdout: stdout.output, stderr: stderr.output }, fakeDependencies().dependencies);

      expect(exitCode).toBe(RUN_UNAVAILABLE_EXIT_CODE);
      expect(stdout.text()).toBe('');
      expect(stderr.text()).toBe(joinLines([runActiveInOutputDirectoryText]));
    } finally {
      await releaseIfAcquired(other);
    }
  });

  it('holds the exclusion while the Run runs, then releases it', async () => {
    const config = newConfig();
    const record: { during?: string } = {};
    const { dependencies } = fakeDependencies(async () => {
      record.during = (await acquireRunExclusion(config.output.directory, config.target.id)).kind;
      return auditRun();
    });

    expect((await executeAuditRun(config, dependencies, { startNew: false })).kind).toBe('RAN');

    expect(record.during).toBe('HELD');
    const after = await acquireRunExclusion(config.output.directory, config.target.id);
    expect(after.kind).toBe('ACQUIRED');
    await releaseIfAcquired(after);
  });

  it('does not start the checkpoint session when it cannot tell whether it holds the exclusion (fail-closed)', async () => {
    const config = newConfig();
    exclusionFailure.cause = new Error('the exclusion cannot be made');
    const { dependencies } = fakeDependencies(async ({ session }) => {
      const runDirectory = runArtifactDirectory(config.output.directory, createRunId(20261009000000));
      await mkdir(runDirectory, { recursive: true });
      await expect(session.start(runDirectory, { mode: 'NEW_RUN' })).rejects.toThrow('the exclusion cannot be made');
      return auditRun();
    });

    try {
      expect((await executeAuditRun(config, dependencies, { startNew: false })).kind).toBe('RAN');
    } finally {
      exclusionFailure.cause = undefined;
    }
  });

  const failures: readonly { readonly name: string; readonly dependencies: (config: AuditConfig) => AuditRunDependencies }[] = [
    {
      name: 'creating the Run Coordinator throws',
      dependencies: () => ({
        ...fakeDependencies().dependencies,
        createRunCoordinator: () => {
          throw new Error('the Run Coordinator could not be created');
        },
      }),
    },
    {
      name: 'the Run does not start (RUN_DIRECTORY_UNAVAILABLE)',
      dependencies: (config) => fakeDependencies(async () => {
        const result = auditRun();
        const runDirectory = runArtifactDirectory(config.output.directory, result.run.runId);
        throw new RunDirectoryUnavailableError({ result, runDirectory, alreadyExists: true, cause: new Error('EEXIST') });
      }).dependencies,
    },
  ];

  it.each(failures)('releases the exclusion when $name', async ({ dependencies }) => {
    const config = newConfig();

    await executeAuditRun(config, dependencies(config), { startNew: false }).catch(() => undefined);

    const after = await acquireRunExclusion(config.output.directory, config.target.id);
    expect(after.kind).toBe('ACQUIRED');
    await releaseIfAcquired(after);
  });

  it('returns RUN_DIRECTORY_UNAVAILABLE as before when the output directory is a file', async () => {
    const config = newConfig();
    await writeFile(config.output.directory, 'not a directory');
    const result = auditRun();
    const runDirectory = runArtifactDirectory(config.output.directory, result.run.runId);
    const { dependencies, created } = fakeDependencies(async () => {
      throw new RunDirectoryUnavailableError({ result, runDirectory, alreadyExists: false, cause: new Error('ENOTDIR') });
    });

    expect((await executeAuditRun(config, dependencies, { startNew: false })).kind).toBe('RUN_DIRECTORY_UNAVAILABLE');
    expect(created).toHaveLength(1);
  });
});
