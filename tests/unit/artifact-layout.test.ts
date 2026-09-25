// C16a（Task 14〜17 の設計書 6.1.2、6.1.8。CC-023）: artifact の配置（パスの組み立て）の唯一の owner。
// Page Auditor、Run Coordinator、ArtifactWriter、表示用モデルが、どれもここから取る。移す前と同じパスを返すことを確かめる。
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SCREENSHOT_CAPTURE_TYPES } from '../../src/core/evidence-types.js';
import { createPageId, createRunId } from '../../src/core/ids.js';
import {
  PAGE_ARTIFACT_FILE_NAMES,
  PAGES_ARTIFACT_DIRECTORY,
  RETRY_ARTIFACT_DIRECTORY_PREFIX,
  RUN_ARTIFACT_FILE_NAMES,
  SCREENSHOT_FILE_NAMES,
  artifactFilePath,
  createRunArtifactDirectory,
  isPortableArtifactPathSegment,
  isPortableRelativeArtifactPath,
  pageArtifactRelativePath,
  runArtifactDirectory,
  screenshotRelativePath,
} from '../../src/core/artifact-layout.js';

const RUN_ID = createRunId(20260924000000);
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
