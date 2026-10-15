/**
 * 古いロックのファイルの原子的な取り直しの手順と、古いロックを動かす先の名前（DEF-060。T24h-3 で `src/report/artifact-writer.ts` から
 * 移した。意味の owner）。Run のロック、出力先の開始のロック、画面のサーバのロック（DEF-061）が、同じ手順を使う。
 * - 手順の判断（動かせたか、動かしたものが判定したものか、作れたか）だけをここに置く。ファイルの操作（`rename`、`wx` での作成、読み取り、
 *   戻し、削除）は、呼び出し側が `LockFileTakeoverOperations` で渡す（本番は `ArtifactWriter`。ARCH08）。
 * - ロックの判定（`judgeRunLock`）と、判定し直しのループ（`takeOverStaleLock`）は `src/core/process-lock.ts`。
 */
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { RunLockTakeover } from './process-lock.js';
import { TEMPORARY_FILE_PREFIX, TEMPORARY_FILE_SUFFIX, TEMPORARY_FILE_UUID_SEPARATOR } from './temporary-file-name.js';

/** 古いロックを動かす先の名前の、ロックの名前の後の印（DEF-060）。 */
const MOVED_STALE_LOCK_MARKER = '.stale-';
/** 古いロックを動かす先の名前の、process の ID と時刻の区切り。 */
const MOVED_STALE_LOCK_SEPARATOR = '-';

/**
 * 古いロック（`path`）を動かす先の、同じディレクトリの一意のパス（DEF-060）。名前は
 * `.<ロックの名前>.stale-<process の ID>-<時刻（ms）>.<UUID>.tmp` で、書き出しの途中の一時ファイルの形（`isTemporaryFileName`）でもある。
 * そのため、Run のディレクトリでは、消せずに残っても再開のときの後始末（`cleanUpForResume`）が消し、出力先では Run のディレクトリの一覧
 * （Run の ID の形のディレクトリ）に混ざらない。
 */
export const movedStaleLockPathFor = (path: string): string => join(dirname(path), [
  TEMPORARY_FILE_PREFIX,
  basename(path),
  MOVED_STALE_LOCK_MARKER,
  String(process.pid),
  MOVED_STALE_LOCK_SEPARATOR,
  String(Date.now()),
  TEMPORARY_FILE_UUID_SEPARATOR,
  randomUUID(),
  TEMPORARY_FILE_SUFFIX,
].join(''));

/** 古いロックの取り直しで使う、ファイルの操作（本番は `ArtifactWriter` が渡す）。 */
export interface LockFileTakeoverOperations {
  /** `path` を `movedPath` へ名前を変えて動かす。動かせたら真、`path` がなければ（`ENOENT`）偽。ほかの失敗は reject する。 */
  moveAway(path: string, movedPath: string): Promise<boolean>;
  /** ファイルを JSON として読んだ値（ない、読めない、JSON でなければ `null`）。 */
  readJson(path: string): Promise<unknown>;
  /** `path` に、新しいロックを排他的に作る（`wx`）。作れたら真、すでにあれば偽。ほかの失敗は reject する。 */
  createExclusive(path: string): Promise<boolean>;
  /** 動かしてしまった他人のロック（`movedPath`）を、`path` へ上書きせずに戻す。reject しない。 */
  restore(movedPath: string, path: string): Promise<void>;
  /** ファイルを消す（なければ何もしない）。reject しない（消せなくても進む）。 */
  remove(path: string): Promise<void>;
}

const LOCK_TAKEOVER_ACQUIRED: RunLockTakeover = Object.freeze({ outcome: 'ACQUIRED' });
const LOCK_TAKEOVER_CHANGED: RunLockTakeover = Object.freeze({ outcome: 'CHANGED' });
const LOCK_TAKEOVER_LOST: RunLockTakeover = Object.freeze({ outcome: 'LOST' });

/**
 * 判定した古いロックのファイル（`path`。読んだ中身が `judged`）を、原子的に取り直す（DEF-060）。
 * 1. ロックを、一意の名前（`movedStaleLockPathFor`）へ動かす。ないなら（ほかの起動が先に動かした、持ち主が消した）、`CHANGED`。
 * 2. 動かしたファイルの中身が `judged` と違えば（ほかの起動が新しく作ったロックや、ハートビートで書き換えたロックを動かしてしまった）、
 *    上書きせずに元の名前へ戻し、`CHANGED`。
 * 3. 同じなら、古いロックを動かせたのは自分だけなので、`wx` で新しいロックを作る。作れたら `ACQUIRED`、すでにあれば（ほかの起動が先に
 *    作った）`LOST`。
 * 4. 動かしたファイルは、どの場合も消す（消せなくても進む）。
 * ファイルの操作の失敗（`moveAway`、`createExclusive` の reject）は、そのまま reject する。
 */
export async function takeOverLockFile(operations: LockFileTakeoverOperations, path: string, judged: unknown): Promise<RunLockTakeover> {
  const movedPath = movedStaleLockPathFor(path);
  if (!(await operations.moveAway(path, movedPath))) {
    return LOCK_TAKEOVER_CHANGED;
  }
  try {
    if (!isDeepStrictEqual(await operations.readJson(movedPath), judged)) {
      await operations.restore(movedPath, path);
      return LOCK_TAKEOVER_CHANGED;
    }
    return (await operations.createExclusive(path)) ? LOCK_TAKEOVER_ACQUIRED : LOCK_TAKEOVER_LOST;
  } finally {
    await operations.remove(movedPath);
  }
}
