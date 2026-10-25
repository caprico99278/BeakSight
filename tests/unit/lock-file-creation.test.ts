// SR-1-F（DEF-168。PRE42 の安全の組の独立のレビュー SR-1 の Important）: ロックのファイルは、中身を書き終えた形でだけ見える。
// - 直す前は、`open(path, 'wx')` で空のファイルを作ってから中身を書いた。その間に別の起動が読むと中身は `null` で、古い（`STALE`）と判定して
//   取り直し、2 つの起動の両方がロックを持った（レビュー担当の実験 `scratchpad\sr-1\exp\lock-race.test.ts`）。
// - 重ね方は時間に左右されない: 片方（B）の `ArtifactWriter` のファイルの操作で、`wx` で開いたファイルへの最初の書き込みを止め、その間に
//   もう片方（A）が始める。直す前は、B が止まるのはロックのファイルそのものへの書き込み、直した後は、同じフォルダの一時ファイルへの書き込み。
// - Run のロック（保存のセッションの再開の始め方）と、出力先の開始のロック（`holdOutputStartLock`）の両方で、片方だけが持つこと。
//   画面のサーバのロックは、管理データの 1 行をトランザクションの中で書くので（ファイルを書かない）、`tests/integration/control-instance-lock.test.ts`
//   で同じ形を確かめる。
// - 部品 `createLockFileExclusively`（`src/core/lock-file.ts`）の判断: 作れた・すでにある・一時ファイルがなくなっていた・失敗の道で、一時ファイルが
//   残らないこと。
import { spawnSync } from 'node:child_process';
import { link, mkdir, mkdtemp, open, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { artifactFilePath, checkpointArtifactRelativePath, outputStartLockPath } from '../../src/core/artifact-layout.js';
import { createLockFileExclusively, type LockFileCreationOperations } from '../../src/core/lock-file.js';
import { createRunLock, currentProcessRunLockHost, isProcessRunning, type RunLock } from '../../src/core/process-lock.js';
import { isTemporaryFileName } from '../../src/core/temporary-file-name.js';
import { holdOutputStartLock } from '../../src/orchestration/output-start-lock.js';
import { RunCheckpointSession } from '../../src/orchestration/run-checkpoint-session.js';
import { ArtifactWriteError, ArtifactWriter, type CheckpointFileOperations } from '../../src/report/artifact-writer.js';
import { createDeferred, type Deferred } from '../helpers/deferred.js';

/** 古いロックの OS の起動の時刻のずれ（判定の許しの幅を大きく超える。死んだ process を起動せずに古いロックを作る）。 */
const OTHER_BOOT_OFFSET_MS = 86_400_000;

let workDirectory = '';
let caseNumber = 0;

beforeAll(async () => {
  workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-lock-file-creation-'));
});

afterAll(async () => {
  await rm(workDirectory, { recursive: true, force: true });
});

const newDirectory = (): string => {
  caseNumber += 1;
  return join(workDirectory, `case-${String(caseNumber)}`);
};

/** 前の起動の古いロック（OS の起動の時刻が違い、持ち主の process も終わっている。DEF-172 の猶予を置かずに取り直す形）。 */
const staleLock = (): RunLock => {
  const host = currentProcessRunLockHost(Date.now());
  const finished = spawnSync(process.execPath, ['-e', '']).pid ?? 0;
  if (isProcessRunning(finished)) {
    throw new Error('could not get the ID of a finished process');
  }
  return { ...createRunLock({ ...host, processId: finished }), bootedAtMs: host.bootedAtMs - OTHER_BOOT_OFFSET_MS };
};

/** 書き込みの止め口（`wx` で開いたファイルへの最初の書き込みに来た、進めてよい）。 */
interface WriteGate {
  readonly reached: Deferred<string>;
  readonly proceed: Deferred<void>;
}

const newWriteGate = (): WriteGate => ({ reached: createDeferred<string>(), proceed: createDeferred<void>() });

/** `node:fs/promises` のままのファイルの操作（差し替える操作だけを上書きして使う）。 */
const nodeFileOperations = (): CheckpointFileOperations => ({
  mkdir: async (path, options) => mkdir(path, options),
  open: async (path, flags) => open(path, flags),
  rename: async (oldPath, newPath) => rename(oldPath, newPath),
  rm: async (path, options) => rm(path, options),
  link: async (existingPath, newPath) => link(existingPath, newPath),
  unlink: async (path) => unlink(path),
});

/** `wx` で開いたファイルへの最初の書き込みだけを、`gate.proceed` まで止めるファイルの操作（ほかは `node:fs/promises` のまま）。 */
function gatedFileOperations(gate: WriteGate): CheckpointFileOperations {
  let first = true;
  return {
    ...nodeFileOperations(),
    open: async (path, flags) => {
      const handle = await open(path, flags);
      if (flags !== 'wx' || !first) {
        return handle;
      }
      first = false;
      return {
        writeFile: async (data, options) => {
          gate.reached.resolve(path);
          await gate.proceed.promise;
          await handle.writeFile(data, options);
        },
        sync: async () => handle.sync(),
        close: async () => handle.close(),
      };
    },
  };
}

/** フォルダの中の、書き出しの途中の一時ファイルの形の名前（残っていないことを確かめる）。 */
const temporaryFilesIn = async (directory: string): Promise<readonly string[]> =>
  (await readdir(directory)).filter((name) => isTemporaryFileName(name));

describe('DEF-168: a lock file is visible only with its content written', () => {
  it('lets only one of two resumes hold the run lock when one reads the lock while the other is writing it', async () => {
    const runDirectory = join(newDirectory(), 'run');
    const lockPath = artifactFilePath(runDirectory, checkpointArtifactRelativePath('lock'));
    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(lockPath, JSON.stringify(staleLock()), 'utf8');

    const gate = newWriteGate();
    const sessionB = new RunCheckpointSession({ store: new ArtifactWriter({ fileOperations: gatedFileOperations(gate) }), now: () => Date.now() });
    const startB = sessionB.start(runDirectory, { mode: 'RESUME', completedPageIds: [] });
    const pausedPath = await gate.reached.promise;
    // A（ふつうの書き手）が、B が中身を書く前に始める。
    const sessionA = new RunCheckpointSession({ store: new ArtifactWriter(), now: () => Date.now() });
    const resultA = await sessionA.start(runDirectory, { mode: 'RESUME', completedPageIds: [] });
    gate.proceed.resolve();
    const resultB = await startB;
    try {
      expect(dirname(pausedPath)).toBe(dirname(lockPath));
      expect([resultA.ok, resultB.ok].filter(Boolean), JSON.stringify({ resultA, resultB })).toHaveLength(1);
      // 持つのは A（B は、A が作ったロックを動いている持ち主のものと判定する）。
      expect(resultA.ok).toBe(true);
      expect(await temporaryFilesIn(dirname(lockPath))).toEqual([]);
      expect(JSON.parse(await readFile(lockPath, 'utf8'))).toMatchObject({ processId: process.pid });
    } finally {
      await sessionA.abandon();
      await sessionB.abandon();
    }
  });

  it('lets only one of two starts hold the output start lock when one reads the lock while the other is writing it', async () => {
    const outputDirectory = newDirectory();
    const lockPath = outputStartLockPath(outputDirectory);
    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(lockPath, JSON.stringify(staleLock()), 'utf8');

    const gate = newWriteGate();
    const startB = holdOutputStartLock(new ArtifactWriter({ fileOperations: gatedFileOperations(gate) }), outputDirectory, Date.now());
    const pausedPath = await gate.reached.promise;
    const resultA = await holdOutputStartLock(new ArtifactWriter(), outputDirectory, Date.now());
    gate.proceed.resolve();
    const resultB = await startB;
    try {
      expect(dirname(pausedPath)).toBe(dirname(lockPath));
      expect([resultA.kind, resultB.kind].filter((kind) => kind === 'ACQUIRED'), JSON.stringify({ resultA, resultB })).toHaveLength(1);
      expect(resultA.kind).toBe('ACQUIRED');
      expect(resultB.kind).toBe('HELD_BY_ANOTHER_START');
      expect(await readdir(outputDirectory)).toEqual([basename(lockPath)]);
    } finally {
      for (const result of [resultA, resultB]) {
        if (result.kind === 'ACQUIRED') {
          await result.release();
        }
      }
    }
  });

  it('creates the run lock through a temporary file and a link, and leaves no temporary file on the failure paths', async () => {
    const runDirectory = join(newDirectory(), 'run');
    const lockPath = artifactFilePath(runDirectory, checkpointArtifactRelativePath('lock'));
    const lock = createRunLock(currentProcessRunLockHost(Date.now()));
    const calls: string[] = [];
    const recording: CheckpointFileOperations = {
      ...nodeFileOperations(),
      open: async (path, flags) => {
        calls.push(`open ${basename(path) === basename(lockPath) ? 'lock' : 'other'} ${flags}`);
        return open(path, flags);
      },
      link: async (existingPath, newPath) => {
        calls.push(`link ${dirname(existingPath) === dirname(newPath) && isTemporaryFileName(basename(existingPath)) ? 'temporary' : 'other'} ${basename(newPath)}`);
        await link(existingPath, newPath);
      },
    };
    await expect(new ArtifactWriter({ fileOperations: recording, platform: 'win32' }).acquireRunLock(runDirectory, lock)).resolves.toEqual({ acquired: true });
    expect(calls).toEqual(['open other wx', `link temporary ${basename(lockPath)}`]);
    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual(lock);
    expect(await temporaryFilesIn(dirname(lockPath))).toEqual([]);

    // すでにあれば、何も変えずに今の中身を返す（一時ファイルは残さない）。
    const other = createRunLock({ ...currentProcessRunLockHost(Date.now()), processId: 7_777 });
    await expect(new ArtifactWriter().acquireRunLock(runDirectory, other)).resolves.toEqual({ acquired: false, existing: lock });
    expect(await temporaryFilesIn(dirname(lockPath))).toEqual([]);

    // link の失敗（EEXIST でない）は ArtifactWriteError で、ロックも一時ファイルも残さない。
    await rm(lockPath);
    const failure = Object.assign(new Error('EIO: i/o error, link'), { code: 'EIO' });
    const failing = new ArtifactWriter({ fileOperations: { ...nodeFileOperations(), link: async () => Promise.reject(failure) } });
    await expect(failing.acquireRunLock(runDirectory, lock)).rejects.toMatchObject({ name: ArtifactWriteError.name, path: lockPath, cause: failure });
    expect(await readdir(dirname(lockPath))).toEqual([]);

    // 書き込みの失敗も同じ。
    const writeFailure = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    const fullDisk = new ArtifactWriter({
      fileOperations: {
        ...nodeFileOperations(),
        open: async (path, flags) => {
          const handle = await open(path, flags);
          return {
            writeFile: async () => Promise.reject(writeFailure),
            sync: async () => handle.sync(),
            close: async () => handle.close(),
          };
        },
      },
    });
    await expect(fullDisk.acquireRunLock(runDirectory, lock)).rejects.toMatchObject({ name: ArtifactWriteError.name, path: lockPath, cause: writeFailure });
    expect(await readdir(dirname(lockPath))).toEqual([]);
  });
});

describe('createLockFileExclusively (the decisions of the lock file creation)', () => {
  const PATH = join('C:', 'work', 'checkpoint', 'run.lock');
  const CONTENT = '{"processId":1}';
  const codeError = (code: string): Error => Object.assign(new Error(code), { code });

  /** 偽のファイルの操作（呼ばれた順を記録する）。`link` の結果を、呼ばれた順に `linkResults` から取る（`null` は成功）。 */
  const fakeOperations = (linkResults: readonly (string | null)[], writeFailure: string | null = null): {
    readonly operations: LockFileCreationOperations;
    readonly calls: string[];
    readonly temporaries: string[];
  } => {
    const calls: string[] = [];
    const temporaries: string[] = [];
    let links = 0;
    return {
      calls,
      temporaries,
      operations: {
        writeNew: async (temporaryPath, content) => {
          temporaries.push(temporaryPath);
          calls.push(`writeNew ${content}`);
          if (writeFailure !== null) {
            throw codeError(writeFailure);
          }
        },
        link: async (existingPath, newPath) => {
          calls.push(`link ${String(temporaries.indexOf(existingPath))} ${newPath === PATH ? 'path' : newPath}`);
          const code = linkResults[links];
          links += 1;
          if (code !== null && code !== undefined) {
            throw codeError(code);
          }
        },
        remove: async (path) => {
          calls.push(`remove ${String(temporaries.indexOf(path))}`);
        },
      },
    };
  };

  it('writes a unique temporary file next to the lock, links it to the lock and removes it', async () => {
    const created = fakeOperations([null]);
    await expect(createLockFileExclusively(created.operations, PATH, CONTENT)).resolves.toBe(true);
    expect(created.calls).toEqual([`writeNew ${CONTENT}`, 'link 0 path', 'remove 0']);
    const [temporary = ''] = created.temporaries;
    expect(dirname(temporary)).toBe(dirname(PATH));
    expect(isTemporaryFileName(basename(temporary))).toBe(true);
    expect(basename(temporary).startsWith(`.${basename(PATH)}.`)).toBe(true);

    const again = fakeOperations([null]);
    await createLockFileExclusively(again.operations, PATH, CONTENT);
    expect(again.temporaries[0]).not.toBe(temporary);
  });

  it('returns false when the lock already exists (EEXIST), and removes the temporary file', async () => {
    const existing = fakeOperations(['EEXIST']);
    await expect(createLockFileExclusively(existing.operations, PATH, CONTENT)).resolves.toBe(false);
    expect(existing.calls).toEqual([`writeNew ${CONTENT}`, 'link 0 path', 'remove 0']);
  });

  it('writes the temporary file once more when it disappeared before the link (ENOENT), and removes both', async () => {
    const vanished = fakeOperations(['ENOENT', 'EEXIST']);
    await expect(createLockFileExclusively(vanished.operations, PATH, CONTENT)).resolves.toBe(false);
    expect(vanished.calls).toEqual([`writeNew ${CONTENT}`, 'link 0 path', 'remove 0', `writeNew ${CONTENT}`, 'link 1 path', 'remove 1']);

    const twice = fakeOperations(['ENOENT', 'ENOENT']);
    await expect(createLockFileExclusively(twice.operations, PATH, CONTENT)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(twice.calls.filter((call) => call.startsWith('remove '))).toEqual(['remove 0', 'remove 1']);
  });

  it('rejects the other failures of the link and of the writing as they are, after removing the temporary file', async () => {
    const linkFailure = fakeOperations(['EPERM']);
    await expect(createLockFileExclusively(linkFailure.operations, PATH, CONTENT)).rejects.toMatchObject({ code: 'EPERM' });
    expect(linkFailure.calls).toEqual([`writeNew ${CONTENT}`, 'link 0 path', 'remove 0']);

    const writeFailure = fakeOperations([null], 'ENOSPC');
    await expect(createLockFileExclusively(writeFailure.operations, PATH, CONTENT)).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(writeFailure.calls).toEqual([`writeNew ${CONTENT}`, 'remove 0']);
  });
});
