/**
 * ロックのファイルの排他的な作成と、古いロックのファイルの原子的な取り直しの手順と、それぞれの一時の名前（DEF-060。T24h-3 で
 * `src/report/artifact-writer.ts` から移した。意味の owner）。Run のロックと出力先の開始のロックが、同じ手順を使う（画面のサーバのロック
 * `src/control/job/instance-lock.ts` は、管理データの 1 行をトランザクションの中で書くので、ファイルを書かない）。
 * - 作成（`createLockFileExclusively`。SR-1-F、DEF-168）: 中身を書き終えた形でだけ見えるように作る。`open(path, 'wx')` で空のファイルを
 *   作ってから中身を書く形は、その間に別の起動が中身のないロックを読み、古いと判定して取り直すので、使わない。
 * - 手順の判断（動かせたか、動かしたものが判定したものか、作れたか）だけをここに置く。ファイルの操作（一時ファイルへの書き出し、`link`、
 *   `rename`、読み取り、戻し、削除）は、呼び出し側が `LockFileCreationOperations`・`LockFileTakeoverOperations` で渡す（本番は
 *   `ArtifactWriter`。ARCH08）。
 * - ロックの判定（`judgeRunLock`）と、判定し直しのループ（`takeOverStaleLock`）は `src/core/process-lock.ts`。
 */
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { errorCodeOf } from './errors.js';
import {
  currentProcessRunLockHost,
  RUN_LOCK_BOOT_TIME_TOLERANCE_MS,
  RUN_LOCK_STALE_AFTER_MS,
  type RunLockTakeover,
} from './process-lock.js';
import { TEMPORARY_FILE_PREFIX, TEMPORARY_FILE_SUFFIX, TEMPORARY_FILE_UUID_SEPARATOR } from './temporary-file-name.js';

/** 古いロックを動かす先の名前の、ロックの名前の後の印（DEF-060）。 */
const MOVED_STALE_LOCK_MARKER = '.stale-';
/** 新しいロックの中身を書く一時ファイルの名前の、ロックの名前の後の印（DEF-168）。 */
const NEW_LOCK_MARKER = '.new-';
/** ロックの一時の名前の、process の ID と時刻の区切り。 */
const LOCK_SIDE_PATH_SEPARATOR = '-';

/**
 * ロック（`path`）の、同じディレクトリの一意の一時の名前。名前は `.<ロックの名前><印><process の ID>-<時刻（ms）>.<UUID>.tmp` で、書き出しの
 * 途中の一時ファイルの形（`isTemporaryFileName`）でもある。そのため、Run のディレクトリでは、消せずに残っても再開のときの後始末
 * （`cleanUpForResume`）が消し、出力先では Run のディレクトリの一覧（Run の ID の形のディレクトリ）に混ざらない。
 */
const lockSidePathFor = (path: string, marker: string): string => join(dirname(path), [
  TEMPORARY_FILE_PREFIX,
  basename(path),
  marker,
  String(process.pid),
  LOCK_SIDE_PATH_SEPARATOR,
  String(Date.now()),
  TEMPORARY_FILE_UUID_SEPARATOR,
  randomUUID(),
  TEMPORARY_FILE_SUFFIX,
].join(''));

/** 古いロック（`path`）を動かす先の、同じディレクトリの一意のパス（DEF-060。`.<ロックの名前>.stale-<process の ID>-<時刻>.<UUID>.tmp`）。 */
export const movedStaleLockPathFor = (path: string): string => lockSidePathFor(path, MOVED_STALE_LOCK_MARKER);

/** 新しいロック（`path`）の中身を書く、同じディレクトリの一意の一時ファイルのパス（DEF-168。`.<ロックの名前>.new-<process の ID>-<時刻>.<UUID>.tmp`）。 */
export const newLockTemporaryPathFor = (path: string): string => lockSidePathFor(path, NEW_LOCK_MARKER);

/** ロックのファイルの作成で使う、ファイルの操作（本番は `ArtifactWriter` が渡す）。 */
export interface LockFileCreationOperations {
  /** `temporaryPath` を新しく作り（すでにあれば失敗）、`content` を書いて `fsync` する。失敗は reject する。 */
  writeNew(temporaryPath: string, content: string): Promise<void>;
  /** `existingPath` の hard link を `newPath` に作る。`newPath` がすでにあれば、`EEXIST` の `code` で reject する。 */
  link(existingPath: string, newPath: string): Promise<void>;
  /** ファイルを消す（なければ何もしない）。reject しない（消せなくても進む）。 */
  remove(path: string): Promise<void>;
}

/** ロックの作成で、一時ファイルを書いて `link` するのを試みる最大の回数（最初の 1 回を含む。下の 3）。 */
export const LOCK_FILE_CREATION_MAX_ATTEMPTS = 2;

/**
 * ロックのファイル（`path`）を、中身（`content`）を書き終えた形でだけ見えるように、排他的に作る（SR-1-F、DEF-168）。作れたら真、すでに
 * あれば（ほかの起動が持つ）偽。
 * 1. 同じディレクトリの一意の一時ファイル（`newLockTemporaryPathFor`）に中身を書いて `fsync` する。
 * 2. `link(一時ファイル, path)` で作る。`path` がすでにあれば（`EEXIST`）偽。
 * 3. 一時ファイルが `link` の前になくなっていた（`ENOENT`。ほかの起動の再開の後始末 `cleanUpForResume` が、一時ファイルの形の名前を消した）
 *    ときは、もう 1 回だけ 1 から行う（`LOCK_FILE_CREATION_MAX_ATTEMPTS`。持ち主のロックがあれば、2 回目は `EEXIST` になる）。
 * 4. 一時ファイルは、成否にかかわらず消す（消せなくても進む）。
 * ほかの失敗（書き出し、`link`）は、そのまま reject する。
 */
export async function createLockFileExclusively(operations: LockFileCreationOperations, path: string, content: string): Promise<boolean> {
  for (let attempt = 1; ; attempt += 1) {
    const temporaryPath = newLockTemporaryPathFor(path);
    try {
      await operations.writeNew(temporaryPath, content);
      try {
        await operations.link(temporaryPath, path);
        return true;
      } catch (error) {
        const code = errorCodeOf(error);
        if (code === 'EEXIST') {
          return false;
        }
        if (code !== 'ENOENT' || attempt >= LOCK_FILE_CREATION_MAX_ATTEMPTS) {
          throw error;
        }
      }
    } finally {
      await operations.remove(temporaryPath);
    }
  }
}

/** 取り直しの札の名前の、ロックの名前の後の印（DEF-170）。書き出しの途中の一時ファイルの形ではない（再開の後始末は、中身の持ち主で決める）。 */
const TAKEOVER_TOKEN_SUFFIX = '.takeover';

/**
 * ロック（`path`）の取り直しの札の、同じディレクトリの決まったパス（DEF-170。`.<ロックの名前>.takeover`）。古いロックを動かす前に、札を
 * `createLockFileExclusively` で作る（取り直しを 1 つずつにする）。中身は持ち主の process の ID と作った時刻（`takeoverTokenContentOf`）。
 */
export const takeoverTokenPathFor = (path: string): string =>
  join(dirname(path), `${TEMPORARY_FILE_PREFIX}${basename(path)}${TAKEOVER_TOKEN_SUFFIX}`);

/** 取り直しの札の中身（JSON。今の process の ID、OS の起動の時刻（DEF-172）、作った時刻）。 */
const takeoverTokenContentOf = (): string => {
  const host = currentProcessRunLockHost(Date.now());
  return JSON.stringify({ processId: host.processId, bootedAtMs: host.bootedAtMs, createdAtMs: host.nowMs });
};

/**
 * 取り直しの札の中身（読んだ値）が、動いている持ち主のものか（DEF-172）。次のすべてを満たすときだけ真（それ以外は死んだ札として扱う）。
 * 1. 持ち主の process の ID があり、その process が動いている（`isProcessRunning`）。
 * 2. OS の起動の時刻（`bootedAtMs`）があり、今の OS の起動の時刻との差が `RUN_LOCK_BOOT_TIME_TOLERANCE_MS` 以内（process の ID の使い回しを除く）。
 * 3. 作った時刻（`createdAtMs`）があり、作ってから `RUN_LOCK_STALE_AFTER_MS` 以内（取り直しは ms で終わるので、それより古い札は残り物）。
 */
export const isLiveTakeoverToken = (value: unknown, isRunning: (processId: number) => boolean, nowMs: number = Date.now()): boolean => {
  const processId = takeoverTokenProcessIdOf(value);
  if (processId === null || !isRunning(processId)) {
    return false;
  }
  const { bootedAtMs, createdAtMs } = value as { readonly bootedAtMs?: unknown; readonly createdAtMs?: unknown };
  if (typeof bootedAtMs !== 'number' || typeof createdAtMs !== 'number') {
    return false;
  }
  const host = currentProcessRunLockHost(nowMs);
  return Math.abs(bootedAtMs - host.bootedAtMs) <= RUN_LOCK_BOOT_TIME_TOLERANCE_MS
    && Math.abs(host.nowMs - createdAtMs) <= RUN_LOCK_STALE_AFTER_MS;
};

/** 取り直しの札の中身（読んだ値）の、持ち主の process の ID（形が違えば `null`）。 */
export const takeoverTokenProcessIdOf = (value: unknown): number | null => {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const processId: unknown = (value as { readonly processId?: unknown }).processId;
  return typeof processId === 'number' && Number.isSafeInteger(processId) && processId > 0 ? processId : null;
};

/** ロック（`path`）の横のファイルの、名前の process の ID の取り出し（`.<ロックの名前><印><ID>-<時刻>.<UUID>.tmp`）。 */
const LOCK_SIDE_FILE_PROCESS_ID_PATTERN = /^(\d+)-\d+\./u;

/**
 * ファイルの名前（`fileName`）が、ロック（`path`）の横のファイル（動かした古いロック `movedStaleLockPathFor`、新しいロックの一時ファイル
 * `newLockTemporaryPathFor`）なら、名前の process の ID。違えば `null`（取り直しの札は `isTakeoverTokenFileName`）。DEF-170: 後始末は、この
 * process が動いている横のファイルを消さない（取り直しの途中の他人のファイルを消さない）。
 */
export const lockSideFileProcessIdOf = (path: string, fileName: string): number | null => {
  for (const marker of [MOVED_STALE_LOCK_MARKER, NEW_LOCK_MARKER]) {
    const head = `${TEMPORARY_FILE_PREFIX}${basename(path)}${marker}`;
    if (fileName.startsWith(head) && fileName.endsWith(TEMPORARY_FILE_SUFFIX)) {
      const match = LOCK_SIDE_FILE_PROCESS_ID_PATTERN.exec(fileName.slice(head.length));
      if (match !== null) {
        return Number(match[1]);
      }
    }
  }
  return null;
};

/** ファイルの名前（`fileName`）が、ロック（`path`）の取り直しの札か（DEF-170）。 */
export const isTakeoverTokenFileName = (path: string, fileName: string): boolean => fileName === basename(takeoverTokenPathFor(path));

/** 古いロックの取り直しで使う、ファイルの操作（本番は `ArtifactWriter` が渡す）。 */
export interface LockFileTakeoverOperations {
  /** `path` を `movedPath` へ名前を変えて動かす。動かせたら真、`path` がなければ（`ENOENT`）偽。ほかの失敗は reject する。 */
  moveAway(path: string, movedPath: string): Promise<boolean>;
  /** ファイルを JSON として読んだ値（ない、読めない、JSON でなければ `null`）。 */
  readJson(path: string): Promise<unknown>;
  /** ファイルがあるか（DEF-170。動かしたファイルがなくなったかを見分ける）。reject しない。 */
  exists(path: string): Promise<boolean>;
  /** `path` に、新しいロックを排他的に作る（`createLockFileExclusively`）。作れたら真、すでにあれば偽。ほかの失敗は reject する。 */
  createExclusive(path: string): Promise<boolean>;
  /** `path` に、`content` のファイルを排他的に作る（`createLockFileExclusively`。取り直しの札）。作れたら真、すでにあれば偽。ほかの失敗は reject する。 */
  createExclusiveFile(path: string, content: string): Promise<boolean>;
  /** 動かしてしまった他人のロック（`movedPath`）を、`path` へ上書きせずに戻す。reject しない。 */
  restore(movedPath: string, path: string): Promise<void>;
  /** ファイルを消す（なければ何もしない）。reject しない（消せなくても進む）。 */
  remove(path: string): Promise<void>;
  /** process が動いているか（取り直しの札の持ち主の判定。本番は `isProcessRunning`）。 */
  isProcessRunning(processId: number): boolean;
}

/** 取り直しの札を作るのを試みる最大の回数（最初の 1 回を含む。死んだ持ち主の札を消した後に、1 回だけやり直す。DEF-170）。 */
export const TAKEOVER_TOKEN_MAX_ATTEMPTS = 2;

const LOCK_TAKEOVER_ACQUIRED: RunLockTakeover = Object.freeze({ outcome: 'ACQUIRED' });
const LOCK_TAKEOVER_CHANGED: RunLockTakeover = Object.freeze({ outcome: 'CHANGED' });
const LOCK_TAKEOVER_LOST: RunLockTakeover = Object.freeze({ outcome: 'LOST' });

/**
 * 判定した古いロックのファイル（`path`。読んだ中身が `judged`）を、原子的に取り直す（DEF-060、DEF-170）。
 * 1. 取り直しの札（`takeoverTokenPathFor`）を作る（`acquireTakeoverToken`）。作れなければ（ほかの起動が取り直している）、`LOST`（fail-closed。
 *    呼び出し側の `takeOverStaleLock` は `CONTENDED` にする）。
 * 2. ロックを、一意の名前（`movedStaleLockPathFor`）へ動かす。ないなら（持ち主が消した）、`CHANGED`（読み直して判定し直す）。
 * 3. 動かしたファイルが、なくなった（ほかの起動の後始末が消した）か、中身が `judged` と違えば（他人の新しいロックやハートビートで書き換えた
 *    ロックを動かしてしまった）、上書きせずに元の名前へ戻し、取り直しに進まずに `LOST`（DEF-170。fail-closed）。
 * 4. 同じなら、新しいロックを排他的に作る（`createLockFileExclusively`）。作れたら `ACQUIRED`、すでにあれば（ほかの起動が先に作った）`LOST`。
 * 5. 動かしたファイルと札は、どの場合も消す（消せなくても進む）。
 * ファイルの操作の失敗（`moveAway`、`createExclusive`、`createExclusiveFile` の reject）は、そのまま reject する。
 */
export async function takeOverLockFile(operations: LockFileTakeoverOperations, path: string, judged: unknown): Promise<RunLockTakeover> {
  const tokenPath = takeoverTokenPathFor(path);
  if (!(await acquireTakeoverToken(operations, tokenPath))) {
    return LOCK_TAKEOVER_LOST;
  }
  try {
    const movedPath = movedStaleLockPathFor(path);
    if (!(await operations.moveAway(path, movedPath))) {
      return LOCK_TAKEOVER_CHANGED;
    }
    try {
      const moved = await operations.readJson(movedPath);
      if (!(await operations.exists(movedPath)) || !isDeepStrictEqual(moved, judged)) {
        await operations.restore(movedPath, path);
        return LOCK_TAKEOVER_LOST;
      }
      return (await operations.createExclusive(path)) ? LOCK_TAKEOVER_ACQUIRED : LOCK_TAKEOVER_LOST;
    } finally {
      await operations.remove(movedPath);
    }
  } finally {
    await operations.remove(tokenPath);
  }
}

/**
 * 取り直しの札（`tokenPath`）を作る（DEF-170）。作れたら真。すでにあれば、持ち主の process が動いている間は偽（ほかの起動が取り直している）。
 * 持ち主が死んでいる（または中身が読めない）ときだけ、札を一意の名前へ動かし、中身が読んだものと同じなら消して、1 回だけやり直す
 * （`TAKEOVER_TOKEN_MAX_ATTEMPTS`）。違えば（ほかの起動が作り直した）、上書きせずに戻して偽。
 */
async function acquireTakeoverToken(operations: LockFileTakeoverOperations, tokenPath: string): Promise<boolean> {
  for (let attempt = 1; ; attempt += 1) {
    if (await operations.createExclusiveFile(tokenPath, takeoverTokenContentOf())) {
      return true;
    }
    if (attempt >= TAKEOVER_TOKEN_MAX_ATTEMPTS) {
      return false;
    }
    const holder = await operations.readJson(tokenPath);
    // DEF-172: 持ち主の process が動いていても、起動の時刻が違う札と、作ってから時間の経った札は、死んだものとして扱う（`isLiveTakeoverToken`）。
    if (isLiveTakeoverToken(holder, (processId) => operations.isProcessRunning(processId))) {
      return false;
    }
    const movedTokenPath = movedStaleLockPathFor(tokenPath);
    if (await operations.moveAway(tokenPath, movedTokenPath)) {
      try {
        if (!isDeepStrictEqual(await operations.readJson(movedTokenPath), holder)) {
          await operations.restore(movedTokenPath, tokenPath);
          return false;
        }
      } finally {
        await operations.remove(movedTokenPath);
      }
    }
  }
}
