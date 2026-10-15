/**
 * リンクをたどらない成果物の読み取り（Task 24 の設計書 4.5、4.7、5 章。T24b）。
 * Run のディレクトリ（`root`）からの相対パス（区切りは `/`）のファイルを、次の順に確かめてから読む。
 * 1. パスが安全か（`isPortableRelativeArtifactPath`。DEF-056 で、Windows の代替データストリーム、末尾の点と空白、デバイス名も拒む）。
 * 2. どの区切りも、リンク（symlink、junction）でなく、途中の区切りはディレクトリであるか（`inspectRealArtifactEntry`。`lstat` は最後の
 *    区切りのリンクしか見分けないので、区切りごとに確かめる）。
 * 3. 最後の区切りがファイルであるか。
 * 4. 実際のパス（`realpath`）が、`root` の実際のパスの中にあるか。
 * 5. 大きさが上限（`DEFAULT_CONTAINED_ARTIFACT_FILE_MAX_BYTES`。呼び出し側が渡せる）以下か。
 * 6. 開いたファイルが、確かめたファイル（`lstat` の装置と inode）と同じか（確かめと開くの間の入れ替えを見分ける）。読む量も上限で止める。
 * 通らない場合は、閉じた一覧の理由（`CONTAINED_ARTIFACT_READ_FAILURE_REASONS`）で返す（例外にしない）。
 *
 * - `root` そのものは、呼び出し側が決めた値として、リンクかどうかを問わない（`ArtifactWriter` と同じ）。中のファイルの実際のパスが、
 *   `root` の実際のパスの中にあることを確かめる。
 * - 符号化（パーセント符号化など）は、ここでは decode しない。呼び出し側が decode した後の値を渡す。
 * - 入れ替えの見分けは、できる限りのものである（確かめと開くの間に、同じファイルを指すように戻された場合は見分けない。その場合も、読む
 *   のは確かめたファイルそのものである）。O_NOFOLLOW がある環境では、開くときにも最後の区切りのリンクをたどらない。
 * - `inspectRealArtifactEntry` は、`ArtifactWriter` の非公開の `listRealDirectory`・`isRealEntry`（`hasRealDirectorySegments`）と同じ
 *   意味の判定である（共用できる形。`ArtifactWriter` はこの Task では変えない）。
 */
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { artifactFilePath, isPortableRelativeArtifactPath } from './artifact-layout.js';
import { errorCodeOf } from './errors.js';
import { isPositiveSafeInteger } from './guards.js';

/**
 * 読むファイルの大きさの既定の上限（バイト）。値の根拠: 256 MiB。成果物でいちばん大きくなりうるのは ChatGPT 用バンドルの ZIP で、
 * スクリーンショットだけで最大 64 MiB（`CHATGPT_BUNDLE_SCREENSHOT_BUDGET_BYTES`）に JSON などが加わる。それを十分に超え、
 * 読み取りでメモリを使い過ぎない値（T24b の仮の値。設計者の確認待ち）。
 */
export const DEFAULT_CONTAINED_ARTIFACT_FILE_MAX_BYTES = 256 * 1024 * 1024;

/** 1回に読む量（バイト）。読む量を上限で止めるため、少しずつ読む。 */
const READ_CHUNK_BYTES = 64 * 1024;

/**
 * 読めなかった理由（閉じた一覧）。
 * - `UNSAFE_PATH`: 相対パスが安全でない（`isPortableRelativeArtifactPath` が偽。文字列でない値を含む）。
 * - `NOT_FOUND`: ない（`root` がない、ディレクトリでない、途中の区切りがディレクトリでない場合を含む）。
 * - `LINK`: どれかの区切りが、リンク（symlink、junction）である。
 * - `NOT_A_FILE`: 最後の区切りが、ファイルでない（ディレクトリなど）。
 * - `OUTSIDE_ROOT`: 実際のパスが、`root` の実際のパスの中にない。
 * - `TOO_LARGE`: 大きさが上限を超える（確かめた後に大きくなった場合を含む）。
 * - `CHANGED`: 開いたファイルが、確かめたファイルでない（確かめと開くの間に、入れ替わった）。
 */
export const CONTAINED_ARTIFACT_READ_FAILURE_REASONS = Object.freeze([
  'UNSAFE_PATH',
  'NOT_FOUND',
  'LINK',
  'NOT_A_FILE',
  'OUTSIDE_ROOT',
  'TOO_LARGE',
  'CHANGED',
] as const);
export type ContainedArtifactReadFailureReason = (typeof CONTAINED_ARTIFACT_READ_FAILURE_REASONS)[number];

/** `readContainedArtifactFile` の結果。読めた場合は、ファイルの中身そのもの。 */
export type ContainedArtifactFileReading =
  | { readonly ok: true; readonly bytes: Buffer }
  | { readonly ok: false; readonly reason: ContainedArtifactReadFailureReason };

/** 読み取りで使うファイルシステムの操作（本番は `NODE_CONTAINED_ARTIFACT_FILE_SYSTEM`。テストで入れ替えられる）。 */
export interface ContainedArtifactFileSystem {
  /** リンクをたどらずに、種類と大きさと装置と inode を返す（bigint）。 */
  readonly lstat: (path: string) => Promise<BigIntStats>;
  /** リンクをたどって、種類を返す（bigint）。 */
  readonly stat: (path: string) => Promise<BigIntStats>;
  /** 実際のパス（リンクと junction を解いたもの）。 */
  readonly realpath: (path: string) => Promise<string>;
  /** ファイルを開く（`flags` は `node:fs` の `constants` の組み合わせ）。 */
  readonly open: (path: string, flags: number) => Promise<FileHandle>;
}

/** 本番のファイルシステムの操作（`node:fs/promises` をそのまま使う）。 */
export const NODE_CONTAINED_ARTIFACT_FILE_SYSTEM: ContainedArtifactFileSystem = Object.freeze({
  lstat: async (path: string) => lstat(path, { bigint: true }),
  stat: async (path: string) => stat(path, { bigint: true }),
  realpath: async (path: string) => realpath(path),
  open: async (path: string, flags: number) => open(path, flags),
});

/** `readContainedArtifactFile` の指定。 */
export interface ContainedArtifactFileReadOptions {
  /** 大きさの上限（バイト。正の安全な整数）。既定は `DEFAULT_CONTAINED_ARTIFACT_FILE_MAX_BYTES`。 */
  readonly maxBytes?: number;
  /** ファイルシステムの操作。既定は `NODE_CONTAINED_ARTIFACT_FILE_SYSTEM`。 */
  readonly fileSystem?: ContainedArtifactFileSystem;
}

/**
 * `inspectRealArtifactEntry` の結果。
 * - `MISSING`: ない（途中の区切りが、リンクでもディレクトリでもない場合を含む）。
 * - `LINK`: どれかの区切りが、リンク（symlink、junction）である。
 * - `FILE`、`DIRECTORY`、`OTHER`: どの区切りもリンクでなく、最後の区切りが、その種類である。`stats` は、最後の区切りの `lstat`（bigint）。
 */
export type RealArtifactEntry =
  | { readonly kind: 'MISSING' }
  | { readonly kind: 'LINK' }
  | { readonly kind: 'FILE' | 'DIRECTORY' | 'OTHER'; readonly stats: BigIntStats };

const MISSING_ENTRY: RealArtifactEntry = Object.freeze({ kind: 'MISSING' });
const LINK_ENTRY: RealArtifactEntry = Object.freeze({ kind: 'LINK' });

/** 開くときの指定（読むだけ。O_NOFOLLOW がある環境では、最後の区切りのリンクをたどらない。Windows にはない）。 */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

/** ないことを表す、ファイルシステムの失敗の `code`。 */
const MISSING_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);
/** O_NOFOLLOW で開いたものがリンクだったことを表す、ファイルシステムの失敗の `code`。 */
const LINK_OPEN_CODE = 'ELOOP';

// ファイルシステムの失敗の `code` の取り出し（`errorCodeOf`。なければ `null`）は、`./errors.ts` に移した（CC-062。CCX-11）。

const failure = (reason: ContainedArtifactReadFailureReason): ContainedArtifactFileReading => Object.freeze({ ok: false, reason });

/** `path` が、`directory` の中（`directory` そのものを除く）にあるか（どちらも絶対パス。区切りは実行している環境のもの）。 */
export const isInsideDirectory = (directory: string, path: string): boolean => {
  const fromDirectory = relative(directory, path);
  return fromDirectory.length > 0 && fromDirectory !== '..' && !fromDirectory.startsWith(`..${sep}`) && !isAbsolute(fromDirectory);
};

/**
 * Run のディレクトリ（`root`）からの相対パス（`relativePath`。区切りは `/`）を、リンクをたどらずに調べる。区切りごとに `lstat` し、
 * リンクがあれば `LINK`、途中の区切りがディレクトリでなければ `MISSING`、最後の区切りは、その種類を返す。`root` そのものは調べない。
 * - ない（`ENOENT`）場合は `MISSING`。調べられないほかの失敗は、その例外をそのまま投げる（`ArtifactWriter` の判定と同じ扱い）。
 * - `relativePath` が安全でない（`isPortableRelativeArtifactPath` が偽）場合は、何も調べずに `RangeError` を投げる（呼び出し側の誤り）。
 */
export async function inspectRealArtifactEntry(
  root: string,
  relativePath: string,
  fileSystem: ContainedArtifactFileSystem = NODE_CONTAINED_ARTIFACT_FILE_SYSTEM,
): Promise<RealArtifactEntry> {
  if (!isPortableRelativeArtifactPath(relativePath)) {
    throw new RangeError(`not a portable relative artifact path: ${JSON.stringify(relativePath)}`);
  }
  const segments = relativePath.split('/');
  for (let count = 1; count <= segments.length; count += 1) {
    let stats: BigIntStats;
    try {
      stats = await fileSystem.lstat(artifactFilePath(root, segments.slice(0, count).join('/')));
    } catch (error) {
      if (errorCodeOf(error) === 'ENOENT') {
        return MISSING_ENTRY;
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      return LINK_ENTRY;
    }
    if (count < segments.length) {
      if (!stats.isDirectory()) {
        return MISSING_ENTRY;
      }
      continue;
    }
    const kind = stats.isFile() ? 'FILE' : stats.isDirectory() ? 'DIRECTORY' : 'OTHER';
    return Object.freeze({ kind, stats });
  }
  // `split` の結果は1つ以上なので、ここには来ない。
  return MISSING_ENTRY;
}

/** `root` の実際のパス。ないか、ディレクトリでない場合は `null`。調べられないほかの失敗は、その例外を投げる。 */
async function realDirectoryOrNull(root: string, fileSystem: ContainedArtifactFileSystem): Promise<string | null> {
  try {
    const realRoot = await fileSystem.realpath(root);
    return (await fileSystem.stat(realRoot)).isDirectory() ? realRoot : null;
  } catch (error) {
    const code = errorCodeOf(error);
    if (code !== null && MISSING_CODES.has(code)) {
      return null;
    }
    throw error;
  }
}

/** 開いたファイルから、上限（`maxBytes`）を1バイトでも超えるまで読む。超えたら `null`。 */
async function readUpTo(handle: FileHandle, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.alloc(READ_CHUNK_BYTES);
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) {
      return Buffer.concat(chunks, total);
    }
    total += bytesRead;
    if (total > maxBytes) {
      return null;
    }
    chunks.push(chunk.subarray(0, bytesRead));
  }
}

/**
 * Run のディレクトリ（`root`）からの相対パス（`relativePath`。区切りは `/`。decode した後の値）のファイルを、リンクをたどらずに読む
 * （このファイルの先頭の説明の順に確かめる）。通らない場合は、理由（`CONTAINED_ARTIFACT_READ_FAILURE_REASONS`）を返す。
 * - `options.maxBytes` が正の安全な整数でない場合は、呼び出し側の誤りとして `RangeError` を投げる（何も読まない）。
 * - 上の理由に当たらない入出力の失敗（権限がないなど）は、その例外をそのまま投げる。
 */
export async function readContainedArtifactFile(
  root: string,
  relativePath: string,
  options: ContainedArtifactFileReadOptions = {},
): Promise<ContainedArtifactFileReading> {
  const maxBytes = options.maxBytes ?? DEFAULT_CONTAINED_ARTIFACT_FILE_MAX_BYTES;
  if (!isPositiveSafeInteger(maxBytes)) {
    throw new RangeError(`max bytes must be a positive safe integer: ${String(maxBytes)}`);
  }
  if (!isPortableRelativeArtifactPath(relativePath)) {
    return failure('UNSAFE_PATH');
  }
  const fileSystem = options.fileSystem ?? NODE_CONTAINED_ARTIFACT_FILE_SYSTEM;
  const realRoot = await realDirectoryOrNull(root, fileSystem);
  if (realRoot === null) {
    return failure('NOT_FOUND');
  }
  const entry = await inspectRealArtifactEntry(root, relativePath, fileSystem);
  if (entry.kind === 'MISSING') {
    return failure('NOT_FOUND');
  }
  if (entry.kind === 'LINK') {
    return failure('LINK');
  }
  if (entry.kind !== 'FILE') {
    return failure('NOT_A_FILE');
  }
  const path = artifactFilePath(root, relativePath);
  let realPath: string;
  try {
    realPath = await fileSystem.realpath(path);
  } catch (error) {
    const code = errorCodeOf(error);
    if (code !== null && MISSING_CODES.has(code)) {
      return failure('NOT_FOUND');
    }
    throw error;
  }
  if (!isInsideDirectory(realRoot, realPath)) {
    return failure('OUTSIDE_ROOT');
  }
  if (entry.stats.size > BigInt(maxBytes)) {
    return failure('TOO_LARGE');
  }
  let handle: FileHandle;
  try {
    handle = await fileSystem.open(path, OPEN_FLAGS);
  } catch (error) {
    const code = errorCodeOf(error);
    if (code === LINK_OPEN_CODE) {
      return failure('LINK');
    }
    if (code !== null && MISSING_CODES.has(code)) {
      return failure('NOT_FOUND');
    }
    throw error;
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== entry.stats.dev || opened.ino !== entry.stats.ino) {
      return failure('CHANGED');
    }
    if (!opened.isFile()) {
      return failure('NOT_A_FILE');
    }
    const bytes = await readUpTo(handle, maxBytes);
    return bytes === null ? failure('TOO_LARGE') : Object.freeze({ ok: true, bytes });
  } finally {
    await handle.close();
  }
}
