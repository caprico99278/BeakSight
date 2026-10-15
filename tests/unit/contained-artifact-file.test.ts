// T24b（Task 24 の設計書 4.5、4.7、5 章）: リンクをたどらない成果物の読み取りの部品。Run のディレクトリ（`root`）からの相対パスを、
// 強めた `isPortableRelativeArtifactPath`（DEF-056）で確かめ、区切りごとに `lstat` でリンク（symlink、junction）を拒み、実際のパス
// （`realpath`）が `root` の中にあり、ファイルであり、大きさが上限以下であることを確かめてから読む。理由は閉じた一覧の値で返す。
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CONTAINED_ARTIFACT_READ_FAILURE_REASONS,
  DEFAULT_CONTAINED_ARTIFACT_FILE_MAX_BYTES,
  NODE_CONTAINED_ARTIFACT_FILE_SYSTEM,
  inspectRealArtifactEntry,
  isInsideDirectory,
  readContainedArtifactFile,
  type ContainedArtifactFileSystem,
} from '../../src/core/contained-artifact-file.js';
import {
  PAGES_ARTIFACT_DIRECTORY,
  RUN_ARTIFACT_FILE_NAMES,
  artifactFilePath,
  pageArtifactRelativePath,
  screenshotRelativePath,
} from '../../src/core/artifact-layout.js';
import { createPageId } from '../../src/core/ids.js';

/** ディレクトリへのリンクの種類（Windows では、権限のいらない junction にする。リンク先は、どれも一時ディレクトリの中）。 */
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';
const PAGE_1 = createPageId(1);
const RUN_JSON = RUN_ARTIFACT_FILE_NAMES.run;
const PAGE_JSON = pageArtifactRelativePath(PAGE_1, 'page');
const SCREENSHOT = screenshotRelativePath(PAGE_1, 'desktop', 'VIEWPORT', null);
const PAGE_DIRECTORY = `${PAGES_ARTIFACT_DIRECTORY}/${PAGE_1}`;
const RUN_JSON_TEXT = '{"run":true}';
const PAGE_JSON_TEXT = '{"page":1}';
const SECRET_TEXT = 'outside of the run directory';
/** 外のファイルを指すリンクの名前（Run のディレクトリの直下）。 */
const LINK_TO_OUTSIDE = 'linked';
/** 外のファイル（リンクの先のディレクトリの中）の名前。 */
const SECRET_FILE = 'secret.txt';

describe('readContainedArtifactFile (T24b)', () => {
  let workDirectory: string;
  let root: string;
  let outside: string;
  /** 作ったリンク（片付けで、リンクの先を消さないよう、先に unlink する）。 */
  const links: string[] = [];

  const makeDirectoryLink = async (target: string, path: string): Promise<void> => {
    await symlink(target, path, LINK_TYPE);
    links.push(path);
  };

  beforeAll(async () => {
    workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-contained-artifact-'));
    root = join(workDirectory, 'run');
    outside = join(workDirectory, 'outside');
    await mkdir(artifactFilePath(root, PAGE_DIRECTORY), { recursive: true });
    await mkdir(join(artifactFilePath(root, SCREENSHOT), '..'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(artifactFilePath(root, RUN_JSON), RUN_JSON_TEXT, 'utf8');
    await writeFile(artifactFilePath(root, PAGE_JSON), PAGE_JSON_TEXT, 'utf8');
    await writeFile(artifactFilePath(root, SCREENSHOT), Buffer.from([0, 1, 2, 3]));
    await writeFile(join(outside, SECRET_FILE), SECRET_TEXT, 'utf8');
    await makeDirectoryLink(outside, artifactFilePath(root, LINK_TO_OUTSIDE));
  });

  afterAll(async () => {
    for (const link of links) {
      await unlink(link);
    }
    await rm(workDirectory, { recursive: true, force: true });
  });

  it('names the closed list of reasons and a default size limit', () => {
    expect(CONTAINED_ARTIFACT_READ_FAILURE_REASONS).toEqual([
      'UNSAFE_PATH',
      'NOT_FOUND',
      'LINK',
      'NOT_A_FILE',
      'OUTSIDE_ROOT',
      'TOO_LARGE',
      'CHANGED',
    ]);
    expect(Object.isFrozen(CONTAINED_ARTIFACT_READ_FAILURE_REASONS)).toBe(true);
    expect(Number.isSafeInteger(DEFAULT_CONTAINED_ARTIFACT_FILE_MAX_BYTES)).toBe(true);
    expect(DEFAULT_CONTAINED_ARTIFACT_FILE_MAX_BYTES).toBeGreaterThan(0);
  });

  it('reads a file directly under the run directory and a file in a page directory', async () => {
    const run = await readContainedArtifactFile(root, RUN_JSON);
    const page = await readContainedArtifactFile(root, PAGE_JSON);
    const screenshot = await readContainedArtifactFile(root, SCREENSHOT);

    expect(run.ok && run.bytes.toString('utf8')).toBe(RUN_JSON_TEXT);
    expect(page.ok && page.bytes.toString('utf8')).toBe(PAGE_JSON_TEXT);
    expect(screenshot.ok && [...screenshot.bytes]).toEqual([0, 1, 2, 3]);
    expect(Object.isFrozen(run)).toBe(true);
  });

  it.each([
    ['an empty path', ''],
    ['a parent segment', '..'],
    ['a parent segment to the outside', `../outside/${SECRET_FILE}`],
    ['a parent segment in the middle', `${PAGES_ARTIFACT_DIRECTORY}/../../outside/${SECRET_FILE}`],
    ['a POSIX absolute path', '/etc/hosts'],
    ['a Windows absolute path', 'C:/Windows/win.ini'],
    ['a backslash', `${PAGES_ARTIFACT_DIRECTORY}\\${PAGE_1}\\page.json`],
    ['an alternate data stream (DEF-056)', `${RUN_JSON}:stream`],
    ['a trailing dot (DEF-056)', `${RUN_JSON}.`],
    ['a trailing space (DEF-056)', `${RUN_JSON} `],
    ['a device name (DEF-056)', 'NUL'],
    ['a device name with an extension (DEF-056)', 'con.json'],
    ['a NUL character', `${RUN_JSON}\0`],
  ])('returns UNSAFE_PATH, without reading, for %s', async (_name, path) => {
    await expect(readContainedArtifactFile(root, path)).resolves.toEqual({ ok: false, reason: 'UNSAFE_PATH' });
  });

  it('returns UNSAFE_PATH for a value that is not a string', async () => {
    for (const value of [undefined, null, 1, [RUN_JSON]]) {
      await expect(readContainedArtifactFile(root, value as unknown as string), String(value)).resolves.toEqual({ ok: false, reason: 'UNSAFE_PATH' });
    }
  });

  // 符号化は、呼び出し側が decode してから渡す。decode した後の値が、`..`、`\`、`:`、制御文字を含めば拒む。
  it('rejects the decoded value of an encoded path, and does not decode a value by itself', async () => {
    for (const encoded of [
      '%2e%2e%2foutside%2fsecret.txt',
      '%2E%2E/outside/secret.txt',
      '..%5Coutside%5Csecret.txt',
      'pages%2F..%2F..%2Foutside%2Fsecret.txt',
      'run.json%3A%24DATA',
      'run.json%00',
      'run.json%2E',
      'NUL%2Etxt',
    ]) {
      const decoded = decodeURIComponent(encoded);
      await expect(readContainedArtifactFile(root, decoded), decoded).resolves.toEqual({ ok: false, reason: 'UNSAFE_PATH' });
    }
    // decode していない値は、そのままの名前として扱う（そういう名前のファイルはない）。
    await expect(readContainedArtifactFile(root, '%2e%2e%2foutside%2fsecret.txt')).resolves.toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('returns NOT_FOUND for a missing file, a file used as a directory, and a missing run directory', async () => {
    await expect(readContainedArtifactFile(root, RUN_ARTIFACT_FILE_NAMES.audit)).resolves.toEqual({ ok: false, reason: 'NOT_FOUND' });
    await expect(readContainedArtifactFile(root, `${PAGE_DIRECTORY}/missing/page.json`)).resolves.toEqual({ ok: false, reason: 'NOT_FOUND' });
    await expect(readContainedArtifactFile(root, `${RUN_JSON}/page.json`)).resolves.toEqual({ ok: false, reason: 'NOT_FOUND' });
    await expect(readContainedArtifactFile(join(workDirectory, 'missing-run'), RUN_JSON)).resolves.toEqual({ ok: false, reason: 'NOT_FOUND' });
    await expect(readContainedArtifactFile(artifactFilePath(root, RUN_JSON), RUN_JSON)).resolves.toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('returns NOT_A_FILE for a directory', async () => {
    await expect(readContainedArtifactFile(root, PAGES_ARTIFACT_DIRECTORY)).resolves.toEqual({ ok: false, reason: 'NOT_A_FILE' });
    await expect(readContainedArtifactFile(root, PAGE_DIRECTORY)).resolves.toEqual({ ok: false, reason: 'NOT_A_FILE' });
  });

  it('returns LINK for a link (junction on Windows) in the middle of the path, without reading the file it leads to', async () => {
    await expect(readContainedArtifactFile(root, `${LINK_TO_OUTSIDE}/${SECRET_FILE}`)).resolves.toEqual({ ok: false, reason: 'LINK' });
  });

  it('returns LINK for a link (junction on Windows) as the last segment', async () => {
    await expect(readContainedArtifactFile(root, LINK_TO_OUTSIDE)).resolves.toEqual({ ok: false, reason: 'LINK' });
  });

  it('returns LINK for a link to a directory inside the run directory, too', async () => {
    const inner = `${PAGES_ARTIFACT_DIRECTORY}/inner-link`;
    await makeDirectoryLink(artifactFilePath(root, PAGE_DIRECTORY), artifactFilePath(root, inner));

    await expect(readContainedArtifactFile(root, `${inner}/page.json`)).resolves.toEqual({ ok: false, reason: 'LINK' });
  });

  // ファイルへの symbolic link は、Windows では権限（開発者モードなど）がないと作れない。どの環境でも同じに確かめるため、
  // `lstat` がリンクと答えるファイルシステムを渡す（判定が `lstat` の `isSymbolicLink` によることを確かめる）。
  it('returns LINK when lstat says that the last segment is a symbolic link to a file', async () => {
    const linkPath = artifactFilePath(root, RUN_JSON);
    const fileSystem: ContainedArtifactFileSystem = {
      ...NODE_CONTAINED_ARTIFACT_FILE_SYSTEM,
      lstat: async (path) => {
        const stats = await NODE_CONTAINED_ARTIFACT_FILE_SYSTEM.lstat(path);
        return path === linkPath ? Object.assign(Object.create(stats) as typeof stats, { isSymbolicLink: () => true, isFile: () => false }) : stats;
      },
    };

    await expect(readContainedArtifactFile(root, RUN_JSON, { fileSystem })).resolves.toEqual({ ok: false, reason: 'LINK' });
  });

  it('returns OUTSIDE_ROOT when the real path of the file is outside the run directory', async () => {
    const realRunJson = await realpath(artifactFilePath(root, RUN_JSON));
    const realSecret = await realpath(join(outside, SECRET_FILE));
    const fileSystem: ContainedArtifactFileSystem = {
      ...NODE_CONTAINED_ARTIFACT_FILE_SYSTEM,
      realpath: async (path) => {
        const real = await NODE_CONTAINED_ARTIFACT_FILE_SYSTEM.realpath(path);
        return real === realRunJson ? realSecret : real;
      },
    };

    await expect(readContainedArtifactFile(root, RUN_JSON, { fileSystem })).resolves.toEqual({ ok: false, reason: 'OUTSIDE_ROOT' });
  });

  it('returns CHANGED when the file opened is not the file checked (it was replaced between the check and the open)', async () => {
    const checked = artifactFilePath(root, RUN_JSON);
    const fileSystem: ContainedArtifactFileSystem = {
      ...NODE_CONTAINED_ARTIFACT_FILE_SYSTEM,
      open: async (path, flags) => NODE_CONTAINED_ARTIFACT_FILE_SYSTEM.open(path === checked ? artifactFilePath(root, PAGE_JSON) : path, flags),
    };

    await expect(readContainedArtifactFile(root, RUN_JSON, { fileSystem })).resolves.toEqual({ ok: false, reason: 'CHANGED' });
  });

  it('returns TOO_LARGE for a file larger than the limit, and reads a file of exactly the limit', async () => {
    const size = Buffer.byteLength(RUN_JSON_TEXT);

    await expect(readContainedArtifactFile(root, RUN_JSON, { maxBytes: size - 1 })).resolves.toEqual({ ok: false, reason: 'TOO_LARGE' });
    const exact = await readContainedArtifactFile(root, RUN_JSON, { maxBytes: size });
    expect(exact.ok && exact.bytes.toString('utf8')).toBe(RUN_JSON_TEXT);
  });

  it('returns TOO_LARGE when the file grows beyond the limit after it was checked', async () => {
    const size = Buffer.byteLength(RUN_JSON_TEXT);
    const checked = artifactFilePath(root, RUN_JSON);
    // 確かめた時点の大きさを、上限以下に見せる（その後で大きくなった場合と同じ）。
    const fileSystem: ContainedArtifactFileSystem = {
      ...NODE_CONTAINED_ARTIFACT_FILE_SYSTEM,
      lstat: async (path) => {
        const stats = await NODE_CONTAINED_ARTIFACT_FILE_SYSTEM.lstat(path);
        return path === checked ? Object.assign(Object.create(stats) as typeof stats, { size: 1n }) : stats;
      },
    };

    await expect(readContainedArtifactFile(root, RUN_JSON, { fileSystem, maxBytes: size - 1 })).resolves.toEqual({ ok: false, reason: 'TOO_LARGE' });
  });

  it('rejects a size limit that is not a positive safe integer, as a mistake of the caller', async () => {
    for (const maxBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(readContainedArtifactFile(root, RUN_JSON, { maxBytes }), String(maxBytes)).rejects.toThrow(RangeError);
    }
  });

  // Run のディレクトリそのもの（`root`）は、呼び出し側が決めた値として、リンクかどうかを問わない（`ArtifactWriter` と同じ）。
  // 中のファイルの実際のパスが、`root` の実際のパスの中にあることを確かめる。
  it('reads through a run directory that is itself a link, inside its real path', async () => {
    const linkedRoot = join(workDirectory, 'linked-run');
    await makeDirectoryLink(root, linkedRoot);

    const read = await readContainedArtifactFile(linkedRoot, RUN_JSON);
    expect(read.ok && read.bytes.toString('utf8')).toBe(RUN_JSON_TEXT);
  });

  it('leaves the files and the links as they were', async () => {
    expect(await readFile(join(outside, SECRET_FILE), 'utf8')).toBe(SECRET_TEXT);
    expect(await readFile(artifactFilePath(root, RUN_JSON), 'utf8')).toBe(RUN_JSON_TEXT);
    expect((await lstat(artifactFilePath(root, LINK_TO_OUTSIDE))).isSymbolicLink()).toBe(true);
  });
});

// `ArtifactWriter` の非公開の `listRealDirectory`・`isRealEntry` と同じ意味の判定（どの区切りも、リンクでないディレクトリで、最後の区切りの
// 種類を `lstat` で見る）。共用できる形で `src/core/` に置く。
describe('inspectRealArtifactEntry (T24b)', () => {
  let workDirectory: string;
  let root: string;
  const links: string[] = [];

  beforeAll(async () => {
    workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-real-entry-'));
    root = join(workDirectory, 'run');
    await mkdir(artifactFilePath(root, PAGE_DIRECTORY), { recursive: true });
    await writeFile(artifactFilePath(root, PAGE_JSON), PAGE_JSON_TEXT, 'utf8');
    const target = join(workDirectory, 'target');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'page.json'), PAGE_JSON_TEXT, 'utf8');
    const link = artifactFilePath(root, LINK_TO_OUTSIDE);
    await symlink(target, link, LINK_TYPE);
    links.push(link);
  });

  afterAll(async () => {
    for (const link of links) {
      await unlink(link);
    }
    await rm(workDirectory, { recursive: true, force: true });
  });

  it('tells a file, a directory, a missing entry and a link, without following links', async () => {
    await expect(inspectRealArtifactEntry(root, PAGE_JSON)).resolves.toMatchObject({ kind: 'FILE' });
    await expect(inspectRealArtifactEntry(root, PAGE_DIRECTORY)).resolves.toMatchObject({ kind: 'DIRECTORY' });
    await expect(inspectRealArtifactEntry(root, PAGES_ARTIFACT_DIRECTORY)).resolves.toMatchObject({ kind: 'DIRECTORY' });
    await expect(inspectRealArtifactEntry(root, `${PAGE_DIRECTORY}/visible-text.txt`)).resolves.toEqual({ kind: 'MISSING' });
    await expect(inspectRealArtifactEntry(root, `${PAGE_JSON}/x`)).resolves.toEqual({ kind: 'MISSING' });
    await expect(inspectRealArtifactEntry(root, LINK_TO_OUTSIDE)).resolves.toEqual({ kind: 'LINK' });
    await expect(inspectRealArtifactEntry(root, `${LINK_TO_OUTSIDE}/page.json`)).resolves.toEqual({ kind: 'LINK' });
  });

  it('gives the lstat of the last segment for a file, with the size, the device and the inode', async () => {
    const entry = await inspectRealArtifactEntry(root, PAGE_JSON);
    const expected = await lstat(artifactFilePath(root, PAGE_JSON), { bigint: true });

    expect(entry.kind === 'FILE' && [entry.stats.size, entry.stats.dev, entry.stats.ino]).toEqual([expected.size, expected.dev, expected.ino]);
  });

  it('throws a RangeError for a path that is not portable, without looking at the file system', async () => {
    for (const path of ['', '..', `${PAGES_ARTIFACT_DIRECTORY}/../x`, 'NUL', 'a:b']) {
      await expect(inspectRealArtifactEntry(root, path), JSON.stringify(path)).rejects.toThrow(RangeError);
    }
  });

  it('passes on a failure other than a missing entry', async () => {
    const failure = Object.assign(new Error('denied'), { code: 'EACCES' });
    const fileSystem: ContainedArtifactFileSystem = {
      ...NODE_CONTAINED_ARTIFACT_FILE_SYSTEM,
      lstat: async () => {
        throw failure;
      },
    };

    await expect(inspectRealArtifactEntry(root, PAGE_JSON, fileSystem)).rejects.toBe(failure);
  });
});

describe('isInsideDirectory (T24b)', () => {
  const base = resolve(tmpdir(), 'beaksight-inside');

  it('is true only for a path strictly inside the directory', () => {
    expect(isInsideDirectory(base, join(base, 'run.json'))).toBe(true);
    expect(isInsideDirectory(base, join(base, 'pages', 'PAGE-000001', 'page.json'))).toBe(true);
    expect(isInsideDirectory(base, join(base, '..x'))).toBe(true);
    expect(isInsideDirectory(base, base)).toBe(false);
    expect(isInsideDirectory(base, join(base, '..'))).toBe(false);
    expect(isInsideDirectory(base, join(base, '..', 'outside', 'secret.txt'))).toBe(false);
    expect(isInsideDirectory(base, `${base}-sibling${sep}run.json`)).toBe(false);
  });
});

// 本物のファイルシステムの部品が、`node:fs/promises` をそのまま使うこと（大きさと種類を bigint の `lstat` で返す）。
describe('NODE_CONTAINED_ARTIFACT_FILE_SYSTEM (T24b)', () => {
  it('uses lstat, stat and realpath of node:fs/promises with bigint stats, and opens a file handle', async () => {
    const workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-contained-fs-'));
    try {
      const file = join(workDirectory, RUN_JSON);
      await writeFile(file, RUN_JSON_TEXT, 'utf8');
      expect((await NODE_CONTAINED_ARTIFACT_FILE_SYSTEM.lstat(file)).size).toBe(BigInt(Buffer.byteLength(RUN_JSON_TEXT)));
      expect((await NODE_CONTAINED_ARTIFACT_FILE_SYSTEM.stat(workDirectory)).isDirectory()).toBe(true);
      expect(await NODE_CONTAINED_ARTIFACT_FILE_SYSTEM.realpath(file)).toBe(await realpath(file));
      const handle = await NODE_CONTAINED_ARTIFACT_FILE_SYSTEM.open(file, constants.O_RDONLY);
      try {
        expect((await handle.stat()).size).toBe((await stat(file)).size);
      } finally {
        await handle.close();
      }
    } finally {
      await rm(workDirectory, { recursive: true, force: true });
    }
  });
});
