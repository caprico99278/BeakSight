// C16a（Task 14〜17 の設計書 6.1.2、6.1.8。CC-023）: artifact の配置（パスの組み立て）の唯一の owner。
// Page Auditor、Run Coordinator、ArtifactWriter、表示用モデルが、どれもここから取る。移す前と同じパスを返すことを確かめる。
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SCREENSHOT_CAPTURE_TYPES } from '../../src/core/evidence-types.js';
import { createPageId, createRunId } from '../../src/core/ids.js';
import {
  CHECKPOINT_ARTIFACT_DIRECTORY,
  CHECKPOINT_ARTIFACT_FILE_NAMES,
  CHECKPOINT_PAGES_ARTIFACT_DIRECTORY,
  DIAGNOSTICS_ARTIFACT_DIRECTORY,
  PAGE_ARTIFACT_FILE_NAMES,
  PAGES_ARTIFACT_DIRECTORY,
  PREFLIGHT_TEMPORARY_FILE_PREFIX,
  PREFLIGHT_TEMPORARY_FILE_SUFFIX,
  RETRY_ARTIFACT_DIRECTORY_PREFIX,
  RUN_ARTIFACT_FILE_NAMES,
  SCREENSHOT_FILE_NAMES,
  artifactFilePath,
  checkpointArtifactRelativePath,
  checkpointPageArtifactRelativePath,
  checkpointPageIdOfFileName,
  createRunArtifactDirectory,
  isPortableArtifactPathSegment,
  isPortableRelativeArtifactPath,
  isPreflightTemporaryFileName,
  listCheckpointRunDirectories,
  listRunDirectories,
  pageArtifactRelativePath,
  runArtifactDirectory,
  screenshotRelativePath,
  siteUnavailableDiagnosticRelativePath,
} from '../../src/core/artifact-layout.js';

const RUN_ID = createRunId(20260924000000);
/** ディレクトリへのリンクの種類（Windows では、権限のいらない junction にする。リンク先は、どれも一時ディレクトリの中）。 */
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';
const PAGE_1 = createPageId(1);
const PAGE_12 = createPageId(12);

describe('artifact layout: names (design 6.1.2)', () => {
  it('names the files of the run directory, the page directory and the screenshots', () => {
    expect(RUN_ARTIFACT_FILE_NAMES).toEqual({
      run: 'run.json',
      audit: 'audit.json',
      report: 'report.html',
      bundle: 'beaksight-audit-bundle.zip',
    });
    expect(PAGE_ARTIFACT_FILE_NAMES).toEqual({ page: 'page.json', visibleText: 'visible-text.txt' });
    expect(PAGES_ARTIFACT_DIRECTORY).toBe('pages');
    expect(RETRY_ARTIFACT_DIRECTORY_PREFIX).toBe('retry-');
    expect(SCREENSHOT_FILE_NAMES).toEqual({ VIEWPORT: 'viewport.png', FULL_PAGE: 'full-page.png' });
    expect(Object.keys(SCREENSHOT_FILE_NAMES).sort()).toEqual([...SCREENSHOT_CAPTURE_TYPES].sort());
  });

  it('freezes the name tables', () => {
    expect(Object.isFrozen(RUN_ARTIFACT_FILE_NAMES)).toBe(true);
    expect(Object.isFrozen(PAGE_ARTIFACT_FILE_NAMES)).toBe(true);
    expect(Object.isFrozen(SCREENSHOT_FILE_NAMES)).toBe(true);
  });
});

describe('artifact layout: paths (design 6.1.2, DEF-007)', () => {
  it('puts the run directory at <output>/<runId>, with the separator of the platform', () => {
    expect(runArtifactDirectory(join('out', 'artifacts'), RUN_ID)).toBe(join('out', 'artifacts', RUN_ID));
    expect(runArtifactDirectory('C:\\work\\artifacts', RUN_ID)).toBe(join('C:\\work\\artifacts', RUN_ID));
  });

  it('makes the paths of the page files relative to the run directory, separated by /', () => {
    expect(pageArtifactRelativePath(PAGE_1, 'page')).toBe('pages/PAGE-000001/page.json');
    expect(pageArtifactRelativePath(PAGE_12, 'visibleText')).toBe('pages/PAGE-000012/visible-text.txt');
  });

  it('makes the screenshot paths relative to the run directory, with retry-<n> for an attempt before a retry', () => {
    expect(screenshotRelativePath(PAGE_1, 'desktop', 'VIEWPORT', null)).toBe('pages/PAGE-000001/desktop/viewport.png');
    expect(screenshotRelativePath(PAGE_1, 'mobile', 'FULL_PAGE', null)).toBe('pages/PAGE-000001/mobile/full-page.png');
    expect(screenshotRelativePath(PAGE_12, 'desktop', 'VIEWPORT', 1)).toBe('pages/PAGE-000012/retry-1/desktop/viewport.png');
    expect(screenshotRelativePath(PAGE_12, 'mobile', 'FULL_PAGE', 3)).toBe('pages/PAGE-000012/retry-3/mobile/full-page.png');
  });

  it('rejects a retry attempt that is not a positive safe integer', () => {
    for (const attempt of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => screenshotRelativePath(PAGE_1, 'desktop', 'VIEWPORT', attempt), String(attempt)).toThrow(RangeError);
    }
  });

  it('turns a relative path into a file path under the run directory, with the separator of the platform', () => {
    const runDirectory = runArtifactDirectory(join('out', 'artifacts'), RUN_ID);
    expect(artifactFilePath(runDirectory, 'pages/PAGE-000001/retry-1/desktop/viewport.png')).toBe(
      join('out', 'artifacts', RUN_ID, 'pages', 'PAGE-000001', 'retry-1', 'desktop', 'viewport.png'),
    );
    expect(artifactFilePath(runDirectory, RUN_ARTIFACT_FILE_NAMES.run)).toBe(join(runDirectory, 'run.json'));
    // Windows では、区切りが `\` になる（ほかの環境では `/`）。
    expect(artifactFilePath('C:\\work\\RUN', 'pages/PAGE-000001/page.json')).toBe(join('C:\\work\\RUN', 'pages', 'PAGE-000001', 'page.json'));
  });
});

// C16c（CC-027）: Run のディレクトリからの相対パスの検証の唯一の owner。スクリーンショットの収集、`ArtifactWriter`、
// ChatGPT 用バンドルが、どれもここを使う。規則は、3か所のうち、いちばん厳しいものに合わせる。
describe('artifact layout: portable relative paths (CC-027)', () => {
  it('accepts ordinary paths, Japanese paths and paths with retry-<n>', () => {
    const accepted = [
      RUN_ARTIFACT_FILE_NAMES.run,
      pageArtifactRelativePath(PAGE_1, 'page'),
      pageArtifactRelativePath(PAGE_12, 'visibleText'),
      screenshotRelativePath(PAGE_1, 'desktop', 'VIEWPORT', null),
      screenshotRelativePath(PAGE_12, 'mobile', 'FULL_PAGE', 3),
      'pages/PAGE-000001/retry-1/desktop/viewport.png',
      'screenshots/PAGE-000010/desktop/full.png',
      'pages/ページ/デスクトップ/画面.png',
      'pages/PAGE-000001/file.name.with.dots.png',
      'pages/PAGE-000001/a b.png',
    ];
    for (const path of accepted) {
      expect(isPortableRelativeArtifactPath(path), path).toBe(true);
    }
  });

  it.each([
    ['an empty path', ''],
    ['a lone current-directory segment', '.'],
    ['a lone parent segment', '..'],
    ['a parent segment', 'pages/PAGE-000001/../../secret.png'],
    ['a parent segment at the start', '../pages/PAGE-000001/page.json'],
    ['a current-directory segment', 'pages/./PAGE-000001/page.json'],
    ['an empty segment', 'pages/PAGE-000001//page.json'],
    ['a trailing separator', 'pages/PAGE-000001/desktop/'],
    ['a POSIX absolute path', '/pages/PAGE-000001/page.json'],
    ['a UNC path', '//server/share/page.json'],
    ['a Windows drive path', 'C:/pages/PAGE-000001/page.json'],
    ['a Windows drive-relative path', 'C:pages/PAGE-000001/page.json'],
    ['a lower-case drive', 'c:/page.json'],
    ['a backslash separator', 'pages\\PAGE-000001\\page.json'],
    ['a backslash inside a segment', 'pages/PAGE-000001/a\\b.png'],
    ['a URL', 'file:///pages/PAGE-000001/page.json'],
    ['an https URL', 'https://host.invalid/pages/page.json'],
    ['a URL scheme without slashes', 'file:pages/page.json'],
    ['a NUL character', 'pages/PAGE-000001/viewport\0.png'],
    ['a tab', 'pages/PAGE-000001/view\tport.png'],
    ['a line feed', 'pages/PAGE-000001/view\nport.png'],
    ['a carriage return', 'pages/PAGE-000001/view\rport.png'],
    ['a unit separator (U+001F)', 'pages/PAGE-000001/view\u001fport.png'],
    ['a delete character (U+007F)', 'pages/PAGE-000001/view\u007fport.png'],
    ['a C1 control character (U+0085)', 'pages/PAGE-000001/view\u0085port.png'],
    ['a C1 control character (U+009F)', 'pages/PAGE-000001/view\u009fport.png'],
  ])('rejects a path with %s', (_name, path) => {
    expect(isPortableRelativeArtifactPath(path)).toBe(false);
  });

  it('rejects a value that is not a string', () => {
    for (const value of [undefined, null, 0, ['pages', 'page.json'], { path: 'pages/page.json' }]) {
      expect(isPortableRelativeArtifactPath(value), String(value)).toBe(false);
    }
  });
});

describe('artifact layout: one portable path segment (CC-027)', () => {
  it('accepts a run ID, a page ID, retry-<n> and a Japanese name as one segment', () => {
    for (const segment of [RUN_ID, PAGE_1, PAGE_12, 'retry-1', 'desktop', 'ページ']) {
      expect(isPortableArtifactPathSegment(segment), segment).toBe(true);
    }
  });

  it('rejects what a whole path rejects, and a separator', () => {
    const rejected = ['', '.', '..', '../escape', 'a/b', 'pages/PAGE-000001', 'a\\b', 'C:', 'c:x', 'file:x', '/a', 'a\0', 'a\u001f', 'a\u0085'];
    for (const segment of rejected) {
      expect(isPortableArtifactPathSegment(segment), JSON.stringify(segment)).toBe(false);
    }
    for (const value of [undefined, null, 1]) {
      expect(isPortableArtifactPathSegment(value), String(value)).toBe(false);
    }
  });
});

// P18d（DEF-009。Task 18 の前の整理の設計書 第6章）: Run のディレクトリは、Run の開始の時点で、排他的に作る。
// 親のディレクトリ（出力先）は recursive で作り、Run のディレクトリそのものは recursive なしで作る（すでにあれば失敗）。
describe('artifact layout: creating the run directory exclusively (DEF-009)', () => {
  let workDirectory: string;

  beforeAll(async () => {
    workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-artifact-layout-'));
  });

  afterAll(async () => {
    await rm(workDirectory, { recursive: true, force: true });
  });

  it('creates the output directory recursively and the run directory under it', async () => {
    const outputDirectory = join(workDirectory, 'nested', 'output');

    const created = await createRunArtifactDirectory(outputDirectory, RUN_ID);

    expect(created).toEqual({ ok: true, runDirectory: runArtifactDirectory(outputDirectory, RUN_ID) });
    expect(await readdir(outputDirectory)).toEqual([RUN_ID]);
    expect(await readdir(runArtifactDirectory(outputDirectory, RUN_ID))).toEqual([]);
  });

  it('fails with alreadyExists when the run directory already exists, and leaves its contents unchanged', async () => {
    const outputDirectory = join(workDirectory, 'existing');
    const runDirectory = runArtifactDirectory(outputDirectory, RUN_ID);
    await mkdir(runDirectory, { recursive: true });
    await writeFile(join(runDirectory, RUN_ARTIFACT_FILE_NAMES.run), 'first run', 'utf8');

    const created = await createRunArtifactDirectory(outputDirectory, RUN_ID);

    expect(created).toMatchObject({ ok: false, runDirectory, alreadyExists: true, error: expect.objectContaining({ code: 'EEXIST' }) });
    expect(await readdir(runDirectory)).toEqual([RUN_ARTIFACT_FILE_NAMES.run]);
    expect(await readFile(join(runDirectory, RUN_ARTIFACT_FILE_NAMES.run), 'utf8')).toBe('first run');
  });

  it('fails without alreadyExists when the output directory cannot be created (a file is in the way)', async () => {
    const blockingFile = join(workDirectory, 'a-file');
    await writeFile(blockingFile, 'not a directory', 'utf8');
    const outputDirectory = join(blockingFile, 'output');

    const created = await createRunArtifactDirectory(outputDirectory, RUN_ID);

    expect(created).toMatchObject({ ok: false, runDirectory: runArtifactDirectory(outputDirectory, RUN_ID), alreadyExists: false });
    expect(created.ok ? null : created.error).toBeInstanceOf(Error);
  });

  it('rejects a run ID that is not one portable path segment, without creating anything', async () => {
    const outputDirectory = join(workDirectory, 'rejected');
    for (const runId of ['', '..', 'RUN-1/escape', 'C:']) {
      await expect(createRunArtifactDirectory(outputDirectory, runId as typeof RUN_ID), JSON.stringify(runId)).rejects.toThrow(RangeError);
    }
    await expect(readdir(outputDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

// R3（中断した Run の再開の設計書 4.1、4.4、4.5）: 再開のための保存（チェックポイント）とロックの配置、PREFLIGHT の一時ファイルの名前。
// 保存のファイルを読み書きするのは `ArtifactWriter` で、名前とパスは、ここから取る。
describe('artifact layout: the checkpoint and the PREFLIGHT temporary file (resumable run design 4.1, 4.4, 4.5)', () => {
  it('names the checkpoint directory, its files and the page checkpoint directory', () => {
    expect(CHECKPOINT_ARTIFACT_DIRECTORY).toBe('checkpoint');
    expect(CHECKPOINT_ARTIFACT_FILE_NAMES).toEqual({ state: 'state.json', previousState: 'state.prev.json', lock: 'run.lock' });
    expect(Object.isFrozen(CHECKPOINT_ARTIFACT_FILE_NAMES)).toBe(true);
    expect(CHECKPOINT_PAGES_ARTIFACT_DIRECTORY).toBe('checkpoint/pages');
  });

  it('makes the checkpoint paths relative to the run directory, separated by /', () => {
    expect(checkpointArtifactRelativePath('state')).toBe('checkpoint/state.json');
    expect(checkpointArtifactRelativePath('previousState')).toBe('checkpoint/state.prev.json');
    expect(checkpointArtifactRelativePath('lock')).toBe('checkpoint/run.lock');
    expect(checkpointPageArtifactRelativePath(PAGE_1)).toBe('checkpoint/pages/PAGE-000001.json');
    expect(checkpointPageArtifactRelativePath(PAGE_12)).toBe('checkpoint/pages/PAGE-000012.json');
    for (const path of [checkpointArtifactRelativePath('state'), checkpointPageArtifactRelativePath(PAGE_12)]) {
      expect(isPortableRelativeArtifactPath(path), path).toBe(true);
    }
  });

  it('reads the page ID from the name of a page checkpoint, and nothing from other names', () => {
    expect(checkpointPageIdOfFileName('PAGE-000001.json')).toBe(PAGE_1);
    expect(checkpointPageIdOfFileName('PAGE-000012.json')).toBe(PAGE_12);
    for (const name of ['PAGE-000001', 'PAGE-000001.json.tmp', 'PAGE-1.json', 'RUN-000001.json', 'notes.json', '.PAGE-000001.json', 'PAGE-000001.JSON']) {
      expect(checkpointPageIdOfFileName(name), name).toBeNull();
    }
  });

  it('names the PREFLIGHT temporary file, and tells such a name from other names', () => {
    expect(PREFLIGHT_TEMPORARY_FILE_PREFIX).toBe('.beaksight-preflight-');
    expect(PREFLIGHT_TEMPORARY_FILE_SUFFIX).toBe('.tmp');
    expect(isPreflightTemporaryFileName('.beaksight-preflight-0b7c9a43-4f8e-4a55-9d1e-3a5f2c6b7d80.tmp')).toBe(true);
    for (const name of ['.beaksight-preflight-.tmp', '.beaksight-preflight-x.txt', 'beaksight-preflight-x.tmp', 'run.json', '.run.json.x.tmp']) {
      expect(isPreflightTemporaryFileName(name), name).toBe(false);
    }
  });
});

// D2（サイトの不調で止めたときの診断の記録の設計書 2.3）: 診断の記録の置き場所。Run のディレクトリの直下の `diagnostics/` に、ページと
// 実行の番号と試行の番号ごとに1つ置く。`checkpoint/` の外なので、Run の終わりの片付け（`checkpoint/` の中だけを消す）で消えない。
// SU5（サイトが応答しないときに Run を止める設計書 3.5.2）: 同じ実行で同じページを 1 回確かめ直すので、名前に試行の番号（1 回目が 1）を加える。
describe('artifact layout: the site-unavailable diagnostics (site-unavailable diagnostics design 2.3)', () => {
  it('names the diagnostics directory directly under the run directory, outside checkpoint/', () => {
    expect(DIAGNOSTICS_ARTIFACT_DIRECTORY).toBe('diagnostics');
    expect(isPortableArtifactPathSegment(DIAGNOSTICS_ARTIFACT_DIRECTORY)).toBe(true);
    expect(DIAGNOSTICS_ARTIFACT_DIRECTORY).not.toBe(CHECKPOINT_ARTIFACT_DIRECTORY);
  });

  it('makes the path of a diagnostic relative to the run directory, with the page ID, the execution number and the attempt number, separated by /', () => {
    expect(siteUnavailableDiagnosticRelativePath(PAGE_12, 1, 1)).toBe('diagnostics/site-unavailable-PAGE-000012-1-1.json');
    expect(siteUnavailableDiagnosticRelativePath(PAGE_12, 1, 2)).toBe('diagnostics/site-unavailable-PAGE-000012-1-2.json');
    expect(siteUnavailableDiagnosticRelativePath(PAGE_1, 3, 1)).toBe('diagnostics/site-unavailable-PAGE-000001-3-1.json');
    const path = siteUnavailableDiagnosticRelativePath(PAGE_12, 2, 1);
    expect(isPortableRelativeArtifactPath(path)).toBe(true);
    expect(path.startsWith(`${DIAGNOSTICS_ARTIFACT_DIRECTORY}/`)).toBe(true);
    expect(path.split('/')).toHaveLength(2);
    expect(artifactFilePath(join('out', RUN_ID), path)).toBe(join('out', RUN_ID, 'diagnostics', 'site-unavailable-PAGE-000012-2-1.json'));
  });

  it('rejects an execution number or an attempt number that is not a positive safe integer', () => {
    for (const number of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => siteUnavailableDiagnosticRelativePath(PAGE_1, number, 1), `execution ${String(number)}`).toThrow(RangeError);
      expect(() => siteUnavailableDiagnosticRelativePath(PAGE_1, 1, number), `attempt ${String(number)}`).toThrow(RangeError);
    }
  });
});

// R3（中断した Run の再開の設計書 4.7）: 出力先の直下の、保存のある Run のディレクトリの一覧（読むだけ。R5 の自動の再開で使う）。
describe('artifact layout: listing the run directories with a checkpoint (resumable run design 4.7)', () => {
  let workDirectory: string;

  beforeAll(async () => {
    workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-artifact-layout-list-'));
  });

  afterAll(async () => {
    await rm(workDirectory, { recursive: true, force: true });
  });

  const putFile = async (path: string, content = '{}'): Promise<void> => {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, content, 'utf8');
  };

  it('lists the directories named like a run ID that have checkpoint/state.json or checkpoint/state.prev.json, by name', async () => {
    const outputDirectory = join(workDirectory, 'output');
    const withState = createRunId(20261001000002);
    const withPreviousOnly = createRunId(20261001000001);
    const withoutCheckpoint = createRunId(20261001000003);
    const withDirectoryAsState = createRunId(20261001000004);
    const asFile = createRunId(20261001000005);
    await putFile(artifactFilePath(runArtifactDirectory(outputDirectory, withState), checkpointArtifactRelativePath('state')));
    await putFile(artifactFilePath(runArtifactDirectory(outputDirectory, withPreviousOnly), checkpointArtifactRelativePath('previousState')));
    await putFile(artifactFilePath(runArtifactDirectory(outputDirectory, withoutCheckpoint), RUN_ARTIFACT_FILE_NAMES.run));
    await mkdir(artifactFilePath(runArtifactDirectory(outputDirectory, withDirectoryAsState), checkpointArtifactRelativePath('state')), {
      recursive: true,
    });
    await putFile(join(outputDirectory, asFile));
    await putFile(artifactFilePath(join(outputDirectory, 'not-a-run'), checkpointArtifactRelativePath('state')));
    await putFile(artifactFilePath(join(outputDirectory, 'RUN-1'), checkpointArtifactRelativePath('state')));

    const listed = await listCheckpointRunDirectories(outputDirectory);

    expect(listed).toEqual([
      { runId: withPreviousOnly, runDirectory: runArtifactDirectory(outputDirectory, withPreviousOnly) },
      { runId: withState, runDirectory: runArtifactDirectory(outputDirectory, withState) },
    ]);
    expect(Object.isFrozen(listed)).toBe(true);
  });

  it('returns an empty list when the output directory does not exist, without creating it', async () => {
    const outputDirectory = join(workDirectory, 'missing');
    await expect(listCheckpointRunDirectories(outputDirectory)).resolves.toEqual([]);
    await expect(readdir(outputDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not count a link named like a run ID, even if it points to a run directory with a checkpoint', async () => {
    const outputDirectory = join(workDirectory, 'checkpoint-link');
    const target = join(workDirectory, 'checkpoint-link-target');
    await putFile(artifactFilePath(target, checkpointArtifactRelativePath('state')));
    await mkdir(outputDirectory, { recursive: true });
    await symlink(target, join(outputDirectory, createRunId(20261001000010)), LINK_TYPE);

    await expect(listCheckpointRunDirectories(outputDirectory)).resolves.toEqual([]);
  });
});

// R5a（中断した Run の再開の設計書 4.7.1 の「実行中の Run の確かめ」）: 出力先の直下の、名前が Run の ID の形のディレクトリの一覧
// （保存の有無を問わない。読むだけ）。`listCheckpointRunDirectories` は、この一覧から保存のあるものを選ぶ（判定を二重に書かない）。
describe('artifact layout: listing the run directories (resumable run design 4.7.1)', () => {
  let workDirectory: string;

  beforeAll(async () => {
    workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-artifact-layout-runs-'));
  });

  afterAll(async () => {
    await rm(workDirectory, { recursive: true, force: true });
  });

  it('lists every directory named like a run ID, with or without a checkpoint, by name', async () => {
    const outputDirectory = join(workDirectory, 'output');
    const second = createRunId(20261001000002);
    const first = createRunId(20261001000001);
    const third = createRunId(20261001000003);
    await mkdir(runArtifactDirectory(outputDirectory, second), { recursive: true });
    await mkdir(artifactFilePath(runArtifactDirectory(outputDirectory, first), CHECKPOINT_ARTIFACT_DIRECTORY), { recursive: true });
    await mkdir(runArtifactDirectory(outputDirectory, third), { recursive: true });
    await writeFile(artifactFilePath(runArtifactDirectory(outputDirectory, third), RUN_ARTIFACT_FILE_NAMES.run), '{}', 'utf8');
    // Run の ID の形でない名前と、Run の ID の名前のファイルは、数えない。
    await mkdir(join(outputDirectory, 'not-a-run'), { recursive: true });
    await mkdir(join(outputDirectory, 'RUN-1'), { recursive: true });
    await writeFile(join(outputDirectory, createRunId(20261001000004)), 'a file', 'utf8');

    const listed = await listRunDirectories(outputDirectory);

    expect(listed).toEqual([first, second, third].map((runId) => ({ runId, runDirectory: runArtifactDirectory(outputDirectory, runId) })));
    expect(Object.isFrozen(listed)).toBe(true);
    expect(listed.every((entry) => Object.isFrozen(entry))).toBe(true);
  });

  it('does not count a link (symlink or junction) named like a run ID', async () => {
    const outputDirectory = join(workDirectory, 'links');
    const target = join(workDirectory, 'link-target');
    const real = createRunId(20261001000001);
    await mkdir(target, { recursive: true });
    await mkdir(runArtifactDirectory(outputDirectory, real), { recursive: true });
    await symlink(target, join(outputDirectory, createRunId(20261001000002)), LINK_TYPE);

    await expect(listRunDirectories(outputDirectory)).resolves.toEqual([{ runId: real, runDirectory: runArtifactDirectory(outputDirectory, real) }]);
  });

  it('returns an empty list when the output directory does not exist, also under a file, without creating it', async () => {
    const missing = join(workDirectory, 'missing');
    await expect(listRunDirectories(missing)).resolves.toEqual([]);
    await expect(readdir(missing)).rejects.toMatchObject({ code: 'ENOENT' });

    const file = join(workDirectory, 'a-file');
    await writeFile(file, 'not a directory', 'utf8');
    await expect(listRunDirectories(join(file, 'output'))).resolves.toEqual([]);
    expect(await readFile(file, 'utf8')).toBe('not a directory');
  });

  it('is the list that listCheckpointRunDirectories chooses from', async () => {
    const outputDirectory = join(workDirectory, 'chosen');
    const withCheckpoint = createRunId(20261001000001);
    const withoutCheckpoint = createRunId(20261001000002);
    await mkdir(artifactFilePath(runArtifactDirectory(outputDirectory, withCheckpoint), CHECKPOINT_ARTIFACT_DIRECTORY), { recursive: true });
    await writeFile(artifactFilePath(runArtifactDirectory(outputDirectory, withCheckpoint), checkpointArtifactRelativePath('state')), '{}', 'utf8');
    await mkdir(runArtifactDirectory(outputDirectory, withoutCheckpoint), { recursive: true });

    const all = await listRunDirectories(outputDirectory);
    const withState = await listCheckpointRunDirectories(outputDirectory);

    expect(all.map(({ runId }) => runId)).toEqual([withCheckpoint, withoutCheckpoint]);
    expect(withState).toEqual(all.filter(({ runId }) => runId === withCheckpoint));
  });
});
