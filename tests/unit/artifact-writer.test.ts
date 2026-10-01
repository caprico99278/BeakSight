// U16b（Task 14〜17 の設計書 6.1.1、6.1.2。ARCH05、ARCH08）: artifact の書き出しの唯一の owner（`ArtifactWriter.writeRun`）。
// JSON をメモリの上で組み立てて検証し、スキーマに合わない場合は Run Status を `deriveRunStatus` で導き直してから、一時ファイルと
// rename で書く。書き出すテキストは、UTF-8 と LF にする。
import { lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RUN_ARTIFACT_FILE_NAMES,
  artifactFilePath,
  checkpointArtifactRelativePath,
  checkpointPageArtifactRelativePath,
  pageArtifactRelativePath,
  runArtifactDirectory,
} from '../../src/core/artifact-layout.js';
import type { AuditRunResult, PageAuditResult, PageId, RunSummary } from '../../src/core/contracts.js';
import type { NormalizedHttpUrlEvidence } from '../../src/core/evidence-types.js';
import { createRunId } from '../../src/core/ids.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { deriveRunStatus, type RunStatusInput } from '../../src/core/status.js';
import { createLoadMeter } from '../../src/crawl/load-meter.js';
import { createNavigationPacer } from '../../src/crawl/navigation-pacer.js';
import { CrawlFrontier, type CrawlUrlEntry } from '../../src/orchestration/crawl-frontier.js';
import { IdAllocator } from '../../src/orchestration/id-allocator.js';
import {
  checkRunCheckpointConsistency,
  checkRunCheckpointPageConsistency,
  createRunCheckpoint,
  createRunCheckpointPage,
  createRunLock,
  judgeRunLock,
  renewRunLock,
  type RunCheckpoint,
  type RunCheckpointPage,
  type RunLockHost,
} from '../../src/orchestration/run-checkpoint.js';
import {
  ArtifactWriteError,
  ArtifactWriter,
  type CheckpointFileHandle,
  type CheckpointFileOperations,
} from '../../src/report/artifact-writer.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import {
  FIXTURE_ORIGIN,
  FIXTURE_RUN_ID as RUN_ID,
  PAGE_1,
  PAGE_2,
  PAGE_3,
  auditRun as buildAuditRun,
  dom,
  finding,
  fixtureUrl as url,
  idOf,
  page,
  runSummary,
  screenshot,
} from '../helpers/audit-run-fixture.js';
import { createTestConfig } from '../helpers/test-config.js';

// ---------------------------------------------------------------------------------------------------------------
// スキーマに合う Run の見本（組み立ては `tests/helpers/audit-run-fixture.ts`）
// ---------------------------------------------------------------------------------------------------------------

const E_DOM_1_DESKTOP = dom(1, PAGE_1, 'desktop', '見出し\r\n本文の1行目\r2行目\n3行目');
const E_DOM_1_MOBILE = dom(2, PAGE_1, 'mobile', 'モバイルの本文');
const E_SHOT_1 = screenshot(3, PAGE_1, 'desktop');
/** PAGE-000002 の再試行の前の試行の、Desktop の DOM（可視テキストには使わない）。 */
const E_DOM_2_RETRY = dom(4, PAGE_2, 'desktop', '再試行の前の本文');
const E_DOM_2_MOBILE = dom(5, PAGE_2, 'mobile', '最終の試行のモバイルの本文');

const FINDING = finding(1, 'WARN', 'HTTP', PAGE_1, [idOf(E_DOM_1_DESKTOP)], { ruleId: 'TEST_RULE', message: 'テストの指摘' });

interface RunOptions {
  readonly run?: Partial<RunSummary>;
  readonly statusInput?: Partial<RunStatusInput>;
  /** PAGE-000002 に、スキーマにない項目を加える。 */
  readonly invalidSecondPage?: boolean;
  readonly extraPages?: readonly PageAuditResult[];
}

/** このファイルの Run（見本の補助 `auditRun` に、このファイルのページと Finding を渡したもの。Run Status の入力は、既定で COMPLETE）。 */
function auditRun(options: RunOptions = {}): AuditRunResult {
  const second = page(PAGE_2, '/second.html', 'AUDITED', [E_DOM_2_RETRY, E_DOM_2_MOBILE]);
  return buildAuditRun({
    run: {
      discoveredPageCount: 2,
      auditedPageCount: 2,
      viewportPageCounts: {
        desktop: { audited: 2, partial: 0, failed: 0, skipped: 0 },
        mobile: { audited: 2, partial: 0, failed: 0, skipped: 0 },
      },
      retries: [{
        url: url('/second.html'),
        attempt: 1,
        navigationOutcome: 'TIMEOUT',
        detail: 'TIMEOUT',
        evidenceIds: [E_DOM_2_RETRY.evidenceId],
      }],
      ...options.run,
    },
    pages: [
      page(PAGE_1, '/', 'AUDITED', [E_DOM_1_DESKTOP, E_DOM_1_MOBILE, E_SHOT_1], [FINDING]),
      options.invalidSecondPage === true ? ({ ...second, unexpectedField: true } as PageAuditResult) : second,
      ...(options.extraPages ?? []),
    ],
    findings: [FINDING],
    ...(options.statusInput === undefined ? {} : { statusInput: options.statusInput }),
  });
}

// ---------------------------------------------------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------------------------------------------------

const workDirectories: string[] = [];

afterEach(async () => {
  for (const directory of workDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function outputDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'beaksight-artifact-writer-'));
  workDirectories.push(directory);
  return directory;
}

/** ディレクトリの中のすべてのファイルとディレクトリの、相対パス（区切りは `/`、並べ替え済み）。 */
async function listTree(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .map((entry) => join(entry.parentPath, entry.name).slice(directory.length + 1).replaceAll('\\', '/') + (entry.isDirectory() ? '/' : ''))
    .sort();
}

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8')) as unknown;

// ---------------------------------------------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------------------------------------------

describe('ArtifactWriter.writeRun: the layout (design 6.1.2)', () => {
  it('has a schema-valid Run as the test sample', async () => {
    const result = auditRun();
    await expect(validateArtifact('run', result.run)).resolves.toEqual({ ok: true });
    for (const value of result.pages) {
      await expect(validateArtifact('page', value)).resolves.toEqual({ ok: true });
    }
    expect(deriveRunStatus(result.statusInput)).toBe(result.run.runStatus);
  });

  it('writes run.json, audit.json and pages/<pageId>/page.json and visible-text.txt in the run directory', async () => {
    const root = await outputDirectory();
    const written = await new ArtifactWriter().writeRun(auditRun(), { outputDirectory: root });

    expect(written.runDirectory).toBe(runArtifactDirectory(root, RUN_ID));
    expect(written.files).toEqual([
      'pages/PAGE-000001/page.json',
      'pages/PAGE-000001/visible-text.txt',
      'pages/PAGE-000002/page.json',
      'pages/PAGE-000002/visible-text.txt',
      'run.json',
      'audit.json',
    ]);
    expect(await listTree(root)).toEqual([
      `${RUN_ID}/`,
      `${RUN_ID}/audit.json`,
      `${RUN_ID}/pages/`,
      `${RUN_ID}/pages/PAGE-000001/`,
      `${RUN_ID}/pages/PAGE-000001/page.json`,
      `${RUN_ID}/pages/PAGE-000001/visible-text.txt`,
      `${RUN_ID}/pages/PAGE-000002/`,
      `${RUN_ID}/pages/PAGE-000002/page.json`,
      `${RUN_ID}/pages/PAGE-000002/visible-text.txt`,
      `${RUN_ID}/run.json`,
    ]);
    expect(pageArtifactRelativePath(PAGE_1, 'page')).toBe('pages/PAGE-000001/page.json');
    expect(RUN_ARTIFACT_FILE_NAMES).toEqual({
      run: 'run.json',
      audit: 'audit.json',
      report: 'report.html',
      bundle: 'beaksight-audit-bundle.zip',
    });
  });

  it('writes the run summary, the audit with its schema version and without statusInput, and each page as it is', async () => {
    const root = await outputDirectory();
    const result = auditRun();
    const written = await new ArtifactWriter().writeRun(result, { outputDirectory: root });
    const runDirectory = written.runDirectory;

    expect(await readJson(join(runDirectory, 'run.json'))).toEqual(result.run);
    const audit = await readJson(join(runDirectory, 'audit.json'));
    expect(Object.keys(audit as object)).toEqual(['schemaVersion', 'run', 'pages', 'findings']);
    expect(audit).toEqual({ schemaVersion: 'audit-schema/1.0', run: result.run, pages: result.pages, findings: result.findings });
    expect(JSON.stringify(audit)).not.toContain('statusInput');
    expect(await readJson(join(runDirectory, 'pages/PAGE-000001/page.json'))).toEqual(result.pages[0]);
    await expect(validateArtifact('audit', audit)).resolves.toEqual({ ok: true });
  });

  it('does not write visible-text.txt for a page without a DOM Evidence', async () => {
    const root = await outputDirectory();
    const written = await new ArtifactWriter().writeRun(auditRun({ extraPages: [page(PAGE_3, '/skipped.html', 'SKIPPED')] }), {
      outputDirectory: root,
    });
    expect(written.files).toContain('pages/PAGE-000003/page.json');
    expect(written.files).not.toContain('pages/PAGE-000003/visible-text.txt');
  });

  it('writes the visible text of the Desktop DOM, or of the Mobile DOM of the final attempt when Desktop has none', async () => {
    const root = await outputDirectory();
    const { runDirectory } = await new ArtifactWriter().writeRun(auditRun(), { outputDirectory: root });
    expect(await readFile(join(runDirectory, 'pages/PAGE-000001/visible-text.txt'), 'utf8')).toBe('見出し\n本文の1行目\n2行目\n3行目');
    // PAGE-000002 の Desktop の DOM は、再試行の前の試行のものなので使わない。
    expect(await readFile(join(runDirectory, 'pages/PAGE-000002/visible-text.txt'), 'utf8')).toBe('最終の試行のモバイルの本文');
  });

  it('writes every text file as UTF-8 without a BOM and with LF line endings', async () => {
    const root = await outputDirectory();
    const written = await new ArtifactWriter().writeRun(auditRun(), { outputDirectory: root });
    for (const file of written.files) {
      const bytes = await readFile(join(written.runDirectory, file));
      expect(bytes.includes(0x0d), file).toBe(false);
      expect([...bytes.subarray(0, 3)], file).not.toEqual([0xef, 0xbb, 0xbf]);
      expect(new TextDecoder('utf-8', { fatal: true }).decode(bytes), file).toBe(bytes.toString('utf8'));
    }
    expect((await readFile(join(written.runDirectory, 'run.json'), 'utf8')).endsWith('}\n')).toBe(true);
  });

  it('leaves no temporary file behind', async () => {
    const root = await outputDirectory();
    await new ArtifactWriter().writeRun(auditRun(), { outputDirectory: root });
    expect((await listTree(root)).filter((path) => path.includes('.tmp'))).toEqual([]);
  });
});

describe('ArtifactWriter.writeRun: schema validation and the Run Status (design 6.1.1, A10, ARCH05)', () => {
  it('returns the Run as it is, with schemaValid, when every artifact matches its schema', async () => {
    const root = await outputDirectory();
    const result = auditRun();
    const written = await new ArtifactWriter().writeRun(result, { outputDirectory: root });

    expect(written.schemaValid).toBe(true);
    expect(written.invalidArtifacts).toEqual([]);
    expect(written.result.run).toEqual(result.run);
    expect(written.result.run.runStatus).toBe('COMPLETE');
    expect(written.result.statusInput).toEqual(result.statusInput);
    expect(Object.isFrozen(written.result)).toBe(true);
    expect(Object.isFrozen(written.result.run)).toBe(true);
    expect(Object.isFrozen(written.files)).toBe(true);
  });

  it('derives PARTIAL again with REQUIRED_ARTIFACT_INVALID when a page does not match, and still writes every file', async () => {
    const root = await outputDirectory();
    const written = await new ArtifactWriter().writeRun(auditRun({ invalidSecondPage: true }), { outputDirectory: root });

    expect(written.schemaValid).toBe(false);
    expect(written.invalidArtifacts.map(({ path, schema }) => [path, schema])).toEqual([
      ['pages/PAGE-000002/page.json', 'page'],
      ['audit.json', 'audit'],
    ]);
    expect(written.result.run.runStatus).toBe('PARTIAL');
    expect(written.result.statusInput.requiredArtifactsValid).toBe(false);
    expect(deriveRunStatus(written.result.statusInput)).toBe('PARTIAL');
    const reasons = written.result.run.incompleteReasons;
    expect(reasons.map(({ code }) => code)).toEqual(['REQUIRED_ARTIFACT_INVALID', 'REQUIRED_ARTIFACT_INVALID']);
    expect(reasons[0]?.detail).toMatch(/^page:PAGE-000002:\/ must NOT have additional properties/u);
    expect(reasons[1]?.detail).toMatch(new RegExp(`^audit:${RUN_ID}:/pages/1 `, 'u'));
    expect(written.result.statusInput.incompleteReasons).toEqual(reasons);

    // スキーマに合わない JSON も、隠さずに書く。run.json と audit.json は、導き直した Run Status で書く。
    expect(written.files).toContain('pages/PAGE-000002/page.json');
    const invalidPage = await readJson(join(written.runDirectory, 'pages/PAGE-000002/page.json'));
    expect(invalidPage).toMatchObject({ unexpectedField: true });
    const run = await readJson(join(written.runDirectory, 'run.json'));
    expect(run).toEqual(written.result.run);
    await expect(validateArtifact('run', run)).resolves.toEqual({ ok: true });
    const audit = (await readJson(join(written.runDirectory, 'audit.json'))) as { readonly run: unknown };
    expect(audit.run).toEqual(written.result.run);
  });

  it('does not add the same reason twice when the Run Coordinator already recorded it', async () => {
    const root = await outputDirectory();
    const first = await new ArtifactWriter().writeRun(auditRun({ invalidSecondPage: true }), { outputDirectory: root });
    const pageReason = first.result.run.incompleteReasons[0];
    expect(pageReason?.detail).toMatch(/^page:PAGE-000002:/u);
    if (pageReason === undefined) {
      return;
    }
    const again = await new ArtifactWriter().writeRun(
      auditRun({
        invalidSecondPage: true,
        run: { runStatus: 'PARTIAL', incompleteReasons: [pageReason] },
        statusInput: { requiredArtifactsValid: false, incompleteReasons: [pageReason] },
      }),
      { outputDirectory: await outputDirectory() },
    );
    expect(again.result.run.incompleteReasons.filter(({ detail }) => detail === pageReason.detail)).toHaveLength(1);
  });

  it('lets deriveRunStatus decide: an invalid artifact does not turn ABORTED_BY_SAFETY into PARTIAL', async () => {
    const root = await outputDirectory();
    const written = await new ArtifactWriter().writeRun(
      auditRun({
        invalidSecondPage: true,
        run: { runStatus: 'ABORTED_BY_SAFETY' },
        statusInput: { safetyInvariantViolations: 1 },
      }),
      { outputDirectory: root },
    );
    expect(written.result.run.runStatus).toBe('ABORTED_BY_SAFETY');
    expect(written.result.statusInput.requiredArtifactsValid).toBe(false);
  });

  it('marks an invalid run.json too, and writes it', async () => {
    const root = await outputDirectory();
    const written = await new ArtifactWriter().writeRun(auditRun({ run: { toolVersion: '' } }), { outputDirectory: root });
    expect(written.schemaValid).toBe(false);
    expect(written.invalidArtifacts.map(({ path }) => path)).toEqual(['run.json', 'audit.json']);
    expect(written.result.run.runStatus).toBe('PARTIAL');
    expect(written.result.run.incompleteReasons[0]?.detail).toMatch(new RegExp(`^run:${RUN_ID}:/toolVersion `, 'u'));
    expect(await readJson(join(written.runDirectory, 'run.json'))).toMatchObject({ toolVersion: '', runStatus: 'PARTIAL' });
  });

  it('does not change the input Run', async () => {
    const result = auditRun({ invalidSecondPage: true });
    const before = JSON.stringify(result);
    await new ArtifactWriter().writeRun(result, { outputDirectory: await outputDirectory() });
    expect(JSON.stringify(result)).toBe(before);
    expect(result.run.runStatus).toBe('COMPLETE');
  });
});

describe('ArtifactWriter.writeRun: failures', () => {
  it('throws an ArtifactWriteError when the run directory cannot be made', async () => {
    const root = await outputDirectory();
    const file = join(root, 'not-a-directory');
    await writeFile(file, 'x');
    await expect(new ArtifactWriter().writeRun(auditRun(), { outputDirectory: file })).rejects.toBeInstanceOf(ArtifactWriteError);
  });

  it('throws an ArtifactWriteError when a file cannot be renamed into place, and removes the temporary file', async () => {
    const root = await outputDirectory();
    const runDirectory = runArtifactDirectory(root, RUN_ID);
    // run.json の場所に、ディレクトリを置く（rename が失敗する）。
    await mkdir(join(runDirectory, 'run.json', 'blocker'), { recursive: true });
    const failure = await new ArtifactWriter().writeRun(auditRun(), { outputDirectory: root }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ArtifactWriteError);
    expect((failure as ArtifactWriteError).path).toBe(join(runDirectory, 'run.json'));
    expect((await listTree(root)).filter((path) => path.includes('.tmp'))).toEqual([]);
  });

  it('refuses a Run without the Run Status input', async () => {
    const { statusInput: _statusInput, ...withoutInput } = auditRun();
    await expect(
      new ArtifactWriter().writeRun(withoutInput as AuditRunResult, { outputDirectory: await outputDirectory() }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('refuses a page ID that is not a safe path segment, before writing anything', async () => {
    const root = await outputDirectory();
    const unsafe = { ...page(PAGE_3, '/x.html', 'SKIPPED'), pageId: '../escape' as PageId };
    await expect(new ArtifactWriter().writeRun(auditRun({ extraPages: [unsafe] }), { outputDirectory: root })).rejects.toBeInstanceOf(
      RangeError,
    );
    expect(await listTree(root)).toEqual([]);
  });

  // C16c（CC-027）: ID が安全な区切り1つかどうかは、`isPortableArtifactPathSegment` で確かめる。
  it.each([
    ['empty', ''],
    ['a current-directory segment', '.'],
    ['a parent segment', '..'],
    ['a separator', 'PAGE-000003/x'],
    ['a backslash', 'PAGE-000003\\x'],
    ['a drive', 'C:'],
    ['a NUL character', 'PAGE-000003\0'],
    ['a C1 control character', 'PAGE-000003\u0085'],
  ])('refuses a page ID with %s, before writing anything', async (_name, pageId) => {
    const root = await outputDirectory();
    const unsafe = { ...page(PAGE_3, '/x.html', 'SKIPPED'), pageId: pageId as PageId };
    await expect(new ArtifactWriter().writeRun(auditRun({ extraPages: [unsafe] }), { outputDirectory: root })).rejects.toBeInstanceOf(
      RangeError,
    );
    expect(await listTree(root)).toEqual([]);
  });

  // C16d（C16c の判断1）: ID の形（`isRunId`、`isPageId`）で確かめる。C16c の後に通るようになった値も、`RangeError` にする。
  it.each([
    ['a Japanese word', 'ページ'],
    ['a dot', 'a.b'],
    ['a leading underscore', '_x'],
    ['a leading hyphen', '-x'],
    ['a space', 'a b'],
    ['too few digits', 'PAGE-1'],
    ['the run prefix', 'RUN-000003'],
  ])('refuses a page ID that does not have the shape of a page ID (%s), before writing anything', async (_name, pageId) => {
    const root = await outputDirectory();
    const unsafe = { ...page(PAGE_3, '/x.html', 'SKIPPED'), pageId: pageId as PageId };
    await expect(new ArtifactWriter().writeRun(auditRun({ extraPages: [unsafe] }), { outputDirectory: root })).rejects.toBeInstanceOf(
      RangeError,
    );
    expect(await listTree(root)).toEqual([]);
  });

  it.each([
    ['a Japanese word', 'ラン'],
    ['a dot', 'a.b'],
    ['a leading underscore', '_x'],
    ['a leading hyphen', '-x'],
    ['a space', 'a b'],
    ['too few digits', 'RUN-1'],
    ['the page prefix', 'PAGE-000001'],
  ])('refuses a run ID that does not have the shape of a run ID (%s), before writing anything', async (_name, runId) => {
    const root = await outputDirectory();
    await expect(
      new ArtifactWriter().writeRun(auditRun({ run: { runId: runId as RunSummary['runId'] } }), { outputDirectory: root }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(await listTree(root)).toEqual([]);
  });

  it('refuses a run ID that is not a safe path segment, before writing anything', async () => {
    for (const runId of ['..', '../escape', 'RUN/1', 'RUN\u0000']) {
      const root = await outputDirectory();
      await expect(
        new ArtifactWriter().writeRun(auditRun({ run: { runId: runId as RunSummary['runId'] } }), { outputDirectory: root }),
        runId,
      ).rejects.toBeInstanceOf(RangeError);
      expect(await listTree(root)).toEqual([]);
    }
  });

  it('refuses two pages with the same page ID, before writing anything', async () => {
    const root = await outputDirectory();
    await expect(
      new ArtifactWriter().writeRun(auditRun({ extraPages: [page(PAGE_1, '/again.html', 'SKIPPED')] }), { outputDirectory: root }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(await listTree(root)).toEqual([]);
  });
});

describe('ArtifactWriter.writePresentation: report.html and the bundle go through the writer too (ARCH08)', () => {
  it('writes report.html as UTF-8 with LF, and the bundle bytes as they are, in the run directory', async () => {
    const root = await outputDirectory();
    const writer = new ArtifactWriter();
    const written = await writer.writeRun(auditRun(), { outputDirectory: root });
    const bundle = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x0d, 0x0a]);
    const files = await writer.writePresentation(written, { reportHtml: '<p>日本語</p>\r\n<p>2</p>\r', bundle });

    expect(files).toEqual(['report.html', 'beaksight-audit-bundle.zip']);
    expect(await readFile(join(written.runDirectory, 'report.html'), 'utf8')).toBe('<p>日本語</p>\n<p>2</p>\n');
    expect([...(await readFile(join(written.runDirectory, 'beaksight-audit-bundle.zip')))]).toEqual([...bundle]);
    expect((await listTree(root)).filter((path) => path.includes('.tmp'))).toEqual([]);
  });

  it('writes only the files it is given', async () => {
    const root = await outputDirectory();
    const writer = new ArtifactWriter();
    const written = await writer.writeRun(auditRun(), { outputDirectory: root });
    await expect(writer.writePresentation(written, { reportHtml: 'x' })).resolves.toEqual(['report.html']);
    await expect(writer.writePresentation(written, {})).resolves.toEqual([]);
  });
});

// R3（中断した Run の再開の設計書 4.5）: 最後の書き出しは、前の回の出力が残っていても、中断しなかった場合と同じファイルの集まりにする。
describe('ArtifactWriter.writeRun: no file of an earlier execution is left (resumable run design 4.5)', () => {
  it('removes visible-text.txt that an earlier execution left for a page that now has no visible text', async () => {
    const root = await outputDirectory();
    const writer = new ArtifactWriter();
    const first = await writer.writeRun(auditRun(), { outputDirectory: root });
    expect(first.files).toContain('pages/PAGE-000002/visible-text.txt');

    const again = buildAuditRun({
      run: { discoveredPageCount: 2, auditedPageCount: 1, skippedPageCount: 1 },
      pages: [
        page(PAGE_1, '/', 'AUDITED', [E_DOM_1_DESKTOP, E_DOM_1_MOBILE, E_SHOT_1], [FINDING]),
        page(PAGE_2, '/second.html', 'SKIPPED'),
      ],
      findings: [FINDING],
    });
    const written = await writer.writeRun(again, { outputDirectory: root });

    expect(written.files).toEqual(['pages/PAGE-000001/page.json', 'pages/PAGE-000001/visible-text.txt', 'pages/PAGE-000002/page.json', 'run.json', 'audit.json']);
    expect(await listTree(root)).toEqual([
      `${RUN_ID}/`,
      `${RUN_ID}/audit.json`,
      `${RUN_ID}/pages/`,
      `${RUN_ID}/pages/PAGE-000001/`,
      `${RUN_ID}/pages/PAGE-000001/page.json`,
      `${RUN_ID}/pages/PAGE-000001/visible-text.txt`,
      `${RUN_ID}/pages/PAGE-000002/`,
      `${RUN_ID}/pages/PAGE-000002/page.json`,
      `${RUN_ID}/run.json`,
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// R3: 再開のための保存（チェックポイント）、ロック、再開のときの後始末（中断した Run の再開の設計書 4.1〜4.5）
// 保存とロックの中身は、R2 の `run-checkpoint.ts` の関数で作り、整合の確かめも R2 の関数をそのまま渡す。
// ---------------------------------------------------------------------------------------------------------------

const START_URL = url('/');
const SECOND_URL = url('/second.html');
const THIRD_URL = url('/third.html');

/** 整合の確かめ（R2 の関数。Run Coordinator が読み込みに渡すものと同じ）。 */
const CHECKS = Object.freeze({ checkState: checkRunCheckpointConsistency, checkPage: checkRunCheckpointPageConsistency });

/**
 * 見本の Run の保存（`state.json` の値）。`finishedPages` が 1 なら PAGE-000001 の監査を終えた時点（PAGE-000002 と PAGE-000003 は
 * QUEUED）、2 なら PAGE-000002 の監査も終えた時点（PAGE-000002 は FAILED）のもの。R1 の frontier と採番器、L2 の pacer、
 * L4 の meter、Safety Ledger の snapshot を、実際の部品を動かして作る。
 */
function sampleCheckpoint(finishedPages: 1 | 2): RunCheckpoint {
  const config = createTestConfig(FIXTURE_ORIGIN);
  const allocator = new IdAllocator();
  const frontier = new CrawlFrontier(config.crawl.maxDepth, allocator);
  frontier.discover(START_URL, 0);
  const finish = (status: 'AUDITED' | 'FAILED', links: readonly NormalizedHttpUrlEvidence[]): void => {
    const entry = frontier.next() as CrawlUrlEntry;
    frontier.markAuditing(entry.url);
    frontier.markFinished(entry.url, status);
    for (const link of links) {
      frontier.discover(link, entry.depth + 1);
    }
  };
  finish('AUDITED', [SECOND_URL, THIRD_URL]);
  if (finishedPages === 2) {
    finish('FAILED', []);
  }
  const nowMs = (): number => 1_000;
  return createRunCheckpoint({
    state: 'IN_PROGRESS',
    runId: RUN_ID,
    toolVersion: '0.1.0',
    startedAt: '2026-10-01T00:00:00.000Z',
    savedAt: '2026-10-01T00:05:00.000Z',
    effectiveConfig: config,
    executions: [{ startedAt: '2026-10-01T00:00:00.000Z', finishedAt: null, endReason: null, environment: runSummary().environment }],
    frontier: frontier.snapshot(),
    allocator: allocator.snapshot(),
    progress: {
      reasons: [],
      retries: [],
      safetyViolationDetected: false,
      stoppedBySafetyViolation: false,
      unhandledFailures: 0,
      guardEnabled: true,
      preflightFailed: false,
      pagesStarted: finishedPages,
    },
    safetyLedgerSnapshots: [new SafetyLedger().snapshot()],
    siteMetadata: null,
    load: {
      pacer: createNavigationPacer({ minIntervalMs: 0, now: nowMs, sleep: async () => undefined }).snapshot(),
      meter: createLoadMeter({ allowedOrigins: [FIXTURE_ORIGIN], now: nowMs }).snapshot(),
    },
    completedPageIds: finishedPages === 2 ? [PAGE_1, PAGE_2] : [PAGE_1],
  });
}

/** 見本のページの中の Safety Ledger の snapshot（設計書 4.1。`blocked` 件の POST を遮断した Ledger と、空の Ledger）。 */
const samplePageLedgerSnapshots = (blocked: number) => {
  const ledger = new SafetyLedger();
  for (let index = 0; index < blocked; index += 1) {
    ledger.recordBlockedRequest({ method: 'POST', url: url(`/api/form-${String(index)}`), reason: 'NON_READ_METHOD' });
  }
  return [ledger.snapshot(), new SafetyLedger().snapshot()];
};

/**
 * 見本の Run の、ページの保存の値（PAGE-000001 は AUDITED、PAGE-000002 は再試行の後に FAILED）。ページの中の Safety Ledger の
 * snapshot は、PAGE-000001 が POST を1件、PAGE-000002 が2件遮断したもの。
 */
const samplePage = (pageId: typeof PAGE_1 | typeof PAGE_2): RunCheckpointPage =>
  pageId === PAGE_1
    ? createRunCheckpointPage({
      result: page(PAGE_1, '/', 'AUDITED', [dom(1, PAGE_1, 'desktop', 'トップページ')]),
      retryEvidence: [],
      safetyLedgerSnapshots: samplePageLedgerSnapshots(1),
    })
    : createRunCheckpointPage({
      result: page(PAGE_2, '/second.html', 'FAILED', [dom(3, PAGE_2, 'desktop', '2ページ目')]),
      retryEvidence: [dom(2, PAGE_2, 'desktop', '再試行の前の本文')],
      safetyLedgerSnapshots: samplePageLedgerSnapshots(2),
    });

/** 一時ディレクトリの中の、Run のディレクトリ（まだ作らない）。 */
async function runDirectoryInWork(): Promise<{ readonly root: string; readonly runDirectory: string }> {
  const root = await outputDirectory();
  return { root, runDirectory: runArtifactDirectory(root, RUN_ID) };
}

/**
 * PAGE-000001 を終えた保存（1つ目）と、PAGE-000002 も終えた保存（2つ目）を、この順に書いた Run のディレクトリ。
 * `state.json` は2つ目、`state.prev.json` は1つ目になる。
 */
async function savedRunDirectory(): Promise<{ readonly runDirectory: string; readonly writer: ArtifactWriter }> {
  const { runDirectory } = await runDirectoryInWork();
  const writer = new ArtifactWriter();
  await writer.writeCheckpointPage(runDirectory, samplePage(PAGE_1));
  await writer.writeCheckpointState(runDirectory, sampleCheckpoint(1));
  await writer.writeCheckpointPage(runDirectory, samplePage(PAGE_2));
  await writer.writeCheckpointState(runDirectory, sampleCheckpoint(2));
  return { runDirectory, writer };
}

const checkpointFile = (runDirectory: string, file: 'state' | 'previousState' | 'lock'): string =>
  artifactFilePath(runDirectory, checkpointArtifactRelativePath(file));
const checkpointPageFile = (runDirectory: string, pageId: PageId): string =>
  artifactFilePath(runDirectory, checkpointPageArtifactRelativePath(pageId));

/** 書き出しの途中の一時ファイルの名前の UUID の部分を、`<uuid>` に置き換える。 */
const withoutUuid = (path: string): string => path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, '<uuid>');

/**
 * 呼ばれた操作を `calls` に記録してから、`node:fs/promises` で行うファイルの操作（書き出しの順を確かめる）。ディレクトリを開く操作
 * （`r`）は、ディスクに触れずに記録だけする（ディレクトリの `fsync` を行える環境かどうかに、テストが左右されないようにする）。
 * パスは、Run のディレクトリからの相対パス（区切りは `/`）で記録する。
 */
function recordingFileOperations(runDirectory: string, calls: string[]): CheckpointFileOperations {
  const name = (path: string): string => withoutUuid(relative(runDirectory, path).replaceAll('\\', '/'));
  return {
    mkdir: async (path, options) => {
      calls.push(`mkdir ${name(path)}`);
      return mkdir(path, options);
    },
    open: async (path, flags): Promise<CheckpointFileHandle> => {
      calls.push(`open ${name(path)} ${flags}`);
      if (flags === 'r') {
        return {
          writeFile: async () => undefined,
          sync: async () => {
            calls.push(`sync ${name(path)}`);
          },
          close: async () => {
            calls.push(`close ${name(path)}`);
          },
        };
      }
      const handle = await open(path, flags);
      return {
        writeFile: async (data, options) => {
          calls.push(`write ${name(path)}`);
          await handle.writeFile(data, options);
        },
        sync: async () => {
          calls.push(`sync ${name(path)}`);
          await handle.sync();
        },
        close: async () => {
          calls.push(`close ${name(path)}`);
          await handle.close();
        },
      };
    },
    rename: async (oldPath, newPath) => {
      calls.push(`rename ${name(oldPath)} -> ${name(newPath)}`);
      await rename(oldPath, newPath);
    },
    rm: async (path, options) => {
      calls.push(`rm ${name(path)}`);
      await rm(path, options);
    },
  };
}

describe('ArtifactWriter: writing the checkpoint (resumable run design 4.1〜4.3)', () => {
  it('writes the page checkpoint to checkpoint/pages/<pageId>.json in the artifact JSON format, and returns its path', async () => {
    const { runDirectory } = await runDirectoryInWork();
    const value = samplePage(PAGE_2);

    const written = await new ArtifactWriter().writeCheckpointPage(runDirectory, value);

    expect(written).toBe('checkpoint/pages/PAGE-000002.json');
    expect(await readFile(checkpointPageFile(runDirectory, PAGE_2), 'utf8')).toBe(`${JSON.stringify(value, null, 2)}\n`);
    expect(await listTree(runDirectory)).toEqual(['checkpoint/', 'checkpoint/pages/', 'checkpoint/pages/PAGE-000002.json']);
  });

  it('writes state.json, and moves the current state.json to state.prev.json before replacing it', async () => {
    const { runDirectory } = await runDirectoryInWork();
    const writer = new ArtifactWriter();

    await writer.writeCheckpointState(runDirectory, sampleCheckpoint(1));
    expect(await readJson(checkpointFile(runDirectory, 'state'))).toEqual(sampleCheckpoint(1));
    expect(await listTree(runDirectory)).toEqual(['checkpoint/', 'checkpoint/state.json']);

    await writer.writeCheckpointState(runDirectory, sampleCheckpoint(2));
    expect(await readJson(checkpointFile(runDirectory, 'state'))).toEqual(sampleCheckpoint(2));
    expect(await readJson(checkpointFile(runDirectory, 'previousState'))).toEqual(sampleCheckpoint(1));
    expect(await readFile(checkpointFile(runDirectory, 'state'), 'utf8')).toBe(`${JSON.stringify(sampleCheckpoint(2), null, 2)}\n`);
    expect(await listTree(runDirectory)).toEqual(['checkpoint/', 'checkpoint/state.json', 'checkpoint/state.prev.json']);
  });

  it('fsyncs the temporary file, moves state.json to state.prev.json, renames the temporary file, then fsyncs the directory', async () => {
    const { runDirectory } = await runDirectoryInWork();
    await new ArtifactWriter().writeCheckpointState(runDirectory, sampleCheckpoint(1));
    const calls: string[] = [];
    const writer = new ArtifactWriter({ fileOperations: recordingFileOperations(runDirectory, calls), platform: 'linux' });

    await writer.writeCheckpointState(runDirectory, sampleCheckpoint(2));

    expect(calls).toEqual([
      'mkdir checkpoint',
      'open checkpoint/.state.json.<uuid>.tmp wx',
      'write checkpoint/.state.json.<uuid>.tmp',
      'sync checkpoint/.state.json.<uuid>.tmp',
      'close checkpoint/.state.json.<uuid>.tmp',
      'rename checkpoint/state.json -> checkpoint/state.prev.json',
      'rename checkpoint/.state.json.<uuid>.tmp -> checkpoint/state.json',
      'open checkpoint r',
      'sync checkpoint',
      'close checkpoint',
    ]);
    expect(await readJson(checkpointFile(runDirectory, 'previousState'))).toEqual(sampleCheckpoint(1));
  });

  it('does not fsync the directory on Windows', async () => {
    const { runDirectory } = await runDirectoryInWork();
    const calls: string[] = [];
    const writer = new ArtifactWriter({ fileOperations: recordingFileOperations(runDirectory, calls), platform: 'win32' });

    await writer.writeCheckpointState(runDirectory, sampleCheckpoint(1));
    await writer.writeCheckpointPage(runDirectory, samplePage(PAGE_1));

    expect(calls.filter((call) => call.endsWith(' r') || call === 'sync checkpoint' || call === 'sync checkpoint/pages')).toEqual([]);
    expect(calls.filter((call) => call.startsWith('sync '))).toEqual([
      'sync checkpoint/.state.json.<uuid>.tmp',
      'sync checkpoint/pages/.PAGE-000001.json.<uuid>.tmp',
    ]);
  });

  it('fsyncs the page checkpoint before renaming it into place', async () => {
    const { runDirectory } = await runDirectoryInWork();
    const calls: string[] = [];
    const writer = new ArtifactWriter({ fileOperations: recordingFileOperations(runDirectory, calls), platform: 'linux' });

    await writer.writeCheckpointPage(runDirectory, samplePage(PAGE_1));

    expect(calls).toEqual([
      'mkdir checkpoint/pages',
      'open checkpoint/pages/.PAGE-000001.json.<uuid>.tmp wx',
      'write checkpoint/pages/.PAGE-000001.json.<uuid>.tmp',
      'sync checkpoint/pages/.PAGE-000001.json.<uuid>.tmp',
      'close checkpoint/pages/.PAGE-000001.json.<uuid>.tmp',
      'rename checkpoint/pages/.PAGE-000001.json.<uuid>.tmp -> checkpoint/pages/PAGE-000001.json',
      'open checkpoint/pages r',
      'sync checkpoint/pages',
      'close checkpoint/pages',
    ]);
  });

  it('does not write a state that does not match checkpoint.schema.json, and keeps the current state.json', async () => {
    const { runDirectory } = await runDirectoryInWork();
    const writer = new ArtifactWriter();
    await writer.writeCheckpointState(runDirectory, sampleCheckpoint(1));
    const invalid = { ...sampleCheckpoint(2), state: 'UNKNOWN' } as unknown as RunCheckpoint;

    const failure = await writer.writeCheckpointState(runDirectory, invalid).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ArtifactWriteError);
    expect((failure as ArtifactWriteError).message).toContain('checkpoint');
    expect(await readJson(checkpointFile(runDirectory, 'state'))).toEqual(sampleCheckpoint(1));
    expect(await listTree(runDirectory)).toEqual(['checkpoint/', 'checkpoint/state.json']);
  });

  it('does not write a page checkpoint that does not match checkpoint-page.schema.json', async () => {
    const { runDirectory } = await runDirectoryInWork();
    const invalid = { ...samplePage(PAGE_1), retryEvidence: 'none' } as unknown as RunCheckpointPage;

    await expect(new ArtifactWriter().writeCheckpointPage(runDirectory, invalid)).rejects.toBeInstanceOf(ArtifactWriteError);
    await expect(readdir(runDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not write a page checkpoint without the Safety Ledger snapshots of the page (design 4.1)', async () => {
    const { runDirectory } = await runDirectoryInWork();
    const { safetyLedgerSnapshots: _omitted, ...withoutSnapshots } = samplePage(PAGE_1);

    const failure = await new ArtifactWriter()
      .writeCheckpointPage(runDirectory, withoutSnapshots as unknown as RunCheckpointPage)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ArtifactWriteError);
    expect((failure as ArtifactWriteError).message).toContain('safetyLedgerSnapshots');
    await expect(readdir(runDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a page ID that does not have the shape of a page ID, before writing anything', async () => {
    const { runDirectory } = await runDirectoryInWork();
    for (const pageId of ['../escape', 'PAGE-1', 'notes']) {
      const unsafe = { ...samplePage(PAGE_1), pageId: pageId as PageId };
      await expect(new ArtifactWriter().writeCheckpointPage(runDirectory, unsafe), pageId).rejects.toBeInstanceOf(RangeError);
    }
    await expect(readdir(runDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('throws an ArtifactWriteError and removes the temporary file when the page checkpoint cannot be renamed into place', async () => {
    const { runDirectory } = await runDirectoryInWork();
    await mkdir(join(checkpointPageFile(runDirectory, PAGE_1), 'blocker'), { recursive: true });

    const failure = await new ArtifactWriter().writeCheckpointPage(runDirectory, samplePage(PAGE_1)).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ArtifactWriteError);
    expect((failure as ArtifactWriteError).path).toBe(checkpointPageFile(runDirectory, PAGE_1));
    expect((await listTree(runDirectory)).filter((path) => path.includes('.tmp'))).toEqual([]);
  });
});

describe('ArtifactWriter: reading the checkpoint (resumable run design 4.2, 4.3)', () => {
  it('reads state.json and the page checkpoints of its completed pages, checked by the schema and the consistency checks', async () => {
    const { runDirectory, writer } = await savedRunDirectory();

    const read = await writer.readCheckpoint(runDirectory, CHECKS);

    expect(read).toEqual({
      ok: true,
      source: 'state',
      state: sampleCheckpoint(2),
      pages: [samplePage(PAGE_1), samplePage(PAGE_2)],
      failures: [],
    });
    expect(Object.isFrozen(read)).toBe(true);
    // 型の引数は、整合の確かめの関数から推論される（`RunCheckpoint` と `RunCheckpointPage`）。
    if (read.ok) {
      const state: RunCheckpoint = read.state;
      const pages: readonly RunCheckpointPage[] = read.pages;
      expect(state.completedPageIds).toEqual(pages.map(({ pageId }) => pageId));
    }
  });

  it('uses state.prev.json when state.json is cut off in the middle', async () => {
    const { runDirectory, writer } = await savedRunDirectory();
    const statePath = checkpointFile(runDirectory, 'state');
    await writeFile(statePath, (await readFile(statePath, 'utf8')).slice(0, 120), 'utf8');

    const read = await writer.readCheckpoint(runDirectory, CHECKS);

    expect(read).toMatchObject({ ok: true, source: 'prev', state: sampleCheckpoint(1), pages: [samplePage(PAGE_1)] });
    expect(read.failures).toEqual([{ source: 'state', path: 'checkpoint/state.json', reason: 'is not valid JSON' }]);
  });

  it('uses state.prev.json when state.json does not match checkpoint.schema.json', async () => {
    const { runDirectory, writer } = await savedRunDirectory();
    await writeFile(checkpointFile(runDirectory, 'state'), JSON.stringify({ ...sampleCheckpoint(2), unexpected: true }), 'utf8');

    const read = await writer.readCheckpoint(runDirectory, CHECKS);

    expect(read).toMatchObject({ ok: true, source: 'prev', state: sampleCheckpoint(1) });
    expect(read.failures).toEqual([
      { source: 'state', path: 'checkpoint/state.json', reason: expect.stringMatching(/^does not match the schema checkpoint: \/ must NOT have additional properties/u) },
    ]);
  });

  it('uses state.prev.json when state.json does not pass the consistency check', async () => {
    const { runDirectory, writer } = await savedRunDirectory();
    // PAGE-000002 は FAILED だが、終わったページの一覧にない（スキーマには合う）。
    await writeFile(checkpointFile(runDirectory, 'state'), JSON.stringify({ ...sampleCheckpoint(2), completedPageIds: [PAGE_1] }), 'utf8');

    const read = await writer.readCheckpoint(runDirectory, CHECKS);

    expect(read).toMatchObject({ ok: true, source: 'prev', state: sampleCheckpoint(1) });
    expect(read.failures).toEqual([
      { source: 'state', path: 'checkpoint/state.json', reason: expect.stringMatching(/^is not consistent: .*is not listed in \/completedPageIds/u) },
    ]);
  });

  it('uses state.prev.json when a page checkpoint listed in state.json does not exist', async () => {
    const { runDirectory, writer } = await savedRunDirectory();
    await rm(checkpointPageFile(runDirectory, PAGE_2));

    const read = await writer.readCheckpoint(runDirectory, CHECKS);

    expect(read).toMatchObject({ ok: true, source: 'prev', state: sampleCheckpoint(1), pages: [samplePage(PAGE_1)] });
    expect(read.failures).toEqual([{ source: 'state', path: 'checkpoint/pages/PAGE-000002.json', reason: 'does not exist' }]);
  });

  it.each([
    ['is cut off in the middle', async (path: string) => writeFile(path, (await readFile(path, 'utf8')).slice(0, 80), 'utf8'), 'is not valid JSON'],
    [
      'does not match checkpoint-page.schema.json',
      async (path: string) => writeFile(path, JSON.stringify({ ...samplePage(PAGE_2), retryEvidence: 'none' }), 'utf8'),
      /^does not match the schema checkpoint-page: /u,
    ],
    [
      'does not pass the consistency check',
      async (path: string) => {
        const other = createRunCheckpointPage({ result: page(PAGE_2, '/other.html', 'FAILED'), retryEvidence: [], safetyLedgerSnapshots: [] });
        await writeFile(path, JSON.stringify(other), 'utf8');
      },
      /^is not consistent: .*differs from the URL of its crawl frontier entry/u,
    ],
    [
      'holds another page',
      async (path: string) => writeFile(path, JSON.stringify(samplePage(PAGE_1)), 'utf8'),
      'holds the page ID PAGE-000001 instead of PAGE-000002',
    ],
  ] as const)('uses state.prev.json when a page checkpoint listed in state.json %s', async (_name, breakPage, reason) => {
    const { runDirectory, writer } = await savedRunDirectory();
    await breakPage(checkpointPageFile(runDirectory, PAGE_2));

    const read = await writer.readCheckpoint(runDirectory, CHECKS);

    expect(read).toMatchObject({ ok: true, source: 'prev', state: sampleCheckpoint(1), pages: [samplePage(PAGE_1)] });
    expect(read.failures).toEqual([
      { source: 'state', path: 'checkpoint/pages/PAGE-000002.json', reason: typeof reason === 'string' ? reason : expect.stringMatching(reason) },
    ]);
  });

  it('reads state.prev.json when only state.prev.json exists (stopped between the two renames)', async () => {
    const { runDirectory, writer } = await savedRunDirectory();
    await rm(checkpointFile(runDirectory, 'state'));

    const read = await writer.readCheckpoint(runDirectory, CHECKS);

    expect(read).toMatchObject({ ok: true, source: 'prev', state: sampleCheckpoint(1), pages: [samplePage(PAGE_1)] });
    expect(read.failures).toEqual([{ source: 'state', path: 'checkpoint/state.json', reason: 'does not exist' }]);
  });

  it('returns the reasons of both files, without throwing, when neither can be used', async () => {
    const { runDirectory, writer } = await savedRunDirectory();
    await writeFile(checkpointFile(runDirectory, 'state'), '{', 'utf8');
    await writeFile(checkpointFile(runDirectory, 'previousState'), JSON.stringify({ schemaVersion: 'checkpoint-schema/1.0' }), 'utf8');

    const read = await writer.readCheckpoint(runDirectory, CHECKS);

    expect(read).toEqual({
      ok: false,
      failures: [
        { source: 'state', path: 'checkpoint/state.json', reason: 'is not valid JSON' },
        { source: 'prev', path: 'checkpoint/state.prev.json', reason: expect.stringMatching(/^does not match the schema checkpoint: \/ must include state/u) },
      ],
    });
    // 理由に URL を入れない。
    expect(JSON.stringify(read)).not.toContain(FIXTURE_ORIGIN);
  });

  it('returns "does not exist" for both files when there is no checkpoint', async () => {
    const { runDirectory } = await runDirectoryInWork();
    await mkdir(runDirectory, { recursive: true });

    await expect(new ArtifactWriter().readCheckpoint(runDirectory, CHECKS)).resolves.toEqual({
      ok: false,
      failures: [
        { source: 'state', path: 'checkpoint/state.json', reason: 'does not exist' },
        { source: 'prev', path: 'checkpoint/state.prev.json', reason: 'does not exist' },
      ],
    });
  });

  it('does not put a URL in the reasons, even when the consistency check fails on a URL', async () => {
    const { runDirectory, writer } = await savedRunDirectory();
    const other = createRunCheckpointPage({ result: page(PAGE_2, '/other.html', 'FAILED'), retryEvidence: [], safetyLedgerSnapshots: [] });
    await writeFile(checkpointPageFile(runDirectory, PAGE_2), JSON.stringify(other), 'utf8');
    await writeFile(checkpointFile(runDirectory, 'previousState'), '', 'utf8');

    const read = await writer.readCheckpoint(runDirectory, CHECKS);

    expect(read.ok).toBe(false);
    expect(JSON.stringify(read)).not.toContain(FIXTURE_ORIGIN);
  });
});

/** 深く凍結されているか。 */
const isDeeplyFrozenValue = (value: unknown): boolean =>
  typeof value !== 'object' || value === null || (Object.isFrozen(value) && Object.values(value).every(isDeeplyFrozenValue));

// R5a（中断した Run の再開の設計書 4.7.1 の「途中の Run を探す読み方」）: 途中の Run を探すときは、各 Run の `state.json`（使えなければ
// `state.prev.json`）だけを読む。ページの保存は読まない（終わった Run が出力先に増えても、起動が遅くならないようにするため）。
// 確かめの順と結果の形は、`readCheckpoint` と同じ（例外を投げずに、成功か失敗を返す）。
describe('ArtifactWriter: reading only the state of the checkpoint (resumable run design 4.7.1)', () => {
  it('reads state.json, checked by the schema and the consistency check, without the page checkpoints', async () => {
    const { runDirectory, writer } = await savedRunDirectory();
    const checked: RunCheckpoint[] = [];

    const read = await writer.readCheckpointState(runDirectory, (state: RunCheckpoint) => {
      checked.push(state);
      return checkRunCheckpointConsistency(state);
    });

    expect(read).toEqual({ ok: true, source: 'state', state: sampleCheckpoint(2), failures: [] });
    expect(read).not.toHaveProperty('pages');
    expect(isDeeplyFrozenValue(read)).toBe(true);
    expect(checked).toEqual([sampleCheckpoint(2)]);
    // 型の引数は、整合の確かめの関数から推論される（`RunCheckpoint`）。
    if (read.ok) {
      const state: RunCheckpoint = read.state;
      expect(state.runId).toBe(RUN_ID);
    }
  });

  it('does not read the page checkpoints: a missing or broken page checkpoint does not matter (readCheckpoint falls back)', async () => {
    const { runDirectory, writer } = await savedRunDirectory();
    await rm(checkpointPageFile(runDirectory, PAGE_2));
    await writeFile(checkpointPageFile(runDirectory, PAGE_1), '{', 'utf8');

    await expect(writer.readCheckpointState(runDirectory, checkRunCheckpointConsistency)).resolves.toEqual({
      ok: true,
      source: 'state',
      state: sampleCheckpoint(2),
      failures: [],
    });
    // 対照: ページの保存まで読む `readCheckpoint` は、どちらのファイルも使えない。
    await expect(writer.readCheckpoint(runDirectory, CHECKS)).resolves.toMatchObject({ ok: false });
  });

  it('uses state.prev.json when state.json is cut off in the middle', async () => {
    const { runDirectory, writer } = await savedRunDirectory();
    const statePath = checkpointFile(runDirectory, 'state');
    await writeFile(statePath, (await readFile(statePath, 'utf8')).slice(0, 120), 'utf8');

    await expect(writer.readCheckpointState(runDirectory, checkRunCheckpointConsistency)).resolves.toEqual({
      ok: true,
      source: 'prev',
      state: sampleCheckpoint(1),
      failures: [{ source: 'state', path: 'checkpoint/state.json', reason: 'is not valid JSON' }],
    });
  });

  it('uses state.prev.json when state.json does not match checkpoint.schema.json', async () => {
    const { runDirectory, writer } = await savedRunDirectory();
    await writeFile(checkpointFile(runDirectory, 'state'), JSON.stringify({ ...sampleCheckpoint(2), unexpected: true }), 'utf8');

    const read = await writer.readCheckpointState(runDirectory, checkRunCheckpointConsistency);

    expect(read).toMatchObject({ ok: true, source: 'prev', state: sampleCheckpoint(1) });
    expect(read.failures).toEqual([
      { source: 'state', path: 'checkpoint/state.json', reason: expect.stringMatching(/^does not match the schema checkpoint: \/ must NOT have additional properties/u) },
    ]);
  });

  it('uses state.prev.json when state.json does not pass the consistency check, and when the check throws', async () => {
    const { runDirectory, writer } = await savedRunDirectory();
    await writeFile(checkpointFile(runDirectory, 'state'), JSON.stringify({ ...sampleCheckpoint(2), completedPageIds: [PAGE_1] }), 'utf8');

    const inconsistent = await writer.readCheckpointState(runDirectory, checkRunCheckpointConsistency);
    expect(inconsistent).toMatchObject({ ok: true, source: 'prev', state: sampleCheckpoint(1) });
    expect(inconsistent.failures).toEqual([
      { source: 'state', path: 'checkpoint/state.json', reason: expect.stringMatching(/^is not consistent: .*is not listed in \/completedPageIds/u) },
    ]);

    const throwing = await writer.readCheckpointState(runDirectory, (state: RunCheckpoint) => {
      if (state.completedPageIds.length === 1 && state.frontier.entries.some(({ state: urlState }) => urlState === 'FAILED')) {
        throw new Error('check failed');
      }
      return checkRunCheckpointConsistency(state);
    });
    expect(throwing).toMatchObject({ ok: true, source: 'prev', state: sampleCheckpoint(1) });
    expect(throwing.failures).toEqual([
      { source: 'state', path: 'checkpoint/state.json', reason: 'the consistency check failed: check failed' },
    ]);
  });

  it('returns the reasons of both files, without throwing, when neither can be used', async () => {
    const { runDirectory, writer } = await savedRunDirectory();
    await writeFile(checkpointFile(runDirectory, 'state'), '{', 'utf8');
    await writeFile(checkpointFile(runDirectory, 'previousState'), JSON.stringify({ schemaVersion: 'checkpoint-schema/1.0' }), 'utf8');

    const read = await writer.readCheckpointState(runDirectory, checkRunCheckpointConsistency);

    expect(read).toEqual({
      ok: false,
      failures: [
        { source: 'state', path: 'checkpoint/state.json', reason: 'is not valid JSON' },
        { source: 'prev', path: 'checkpoint/state.prev.json', reason: expect.stringMatching(/^does not match the schema checkpoint: \/ must include state/u) },
      ],
    });
    expect(JSON.stringify(read)).not.toContain(FIXTURE_ORIGIN);
  });

  it('returns "does not exist" for both files when there is no checkpoint, and refuses invalid arguments', async () => {
    const { runDirectory } = await runDirectoryInWork();
    await mkdir(runDirectory, { recursive: true });
    const writer = new ArtifactWriter();

    await expect(writer.readCheckpointState(runDirectory, checkRunCheckpointConsistency)).resolves.toEqual({
      ok: false,
      failures: [
        { source: 'state', path: 'checkpoint/state.json', reason: 'does not exist' },
        { source: 'prev', path: 'checkpoint/state.prev.json', reason: 'does not exist' },
      ],
    });
    await expect(writer.readCheckpointState('', checkRunCheckpointConsistency)).rejects.toBeInstanceOf(TypeError);
    await expect(writer.readCheckpointState(runDirectory, undefined as never)).rejects.toBeInstanceOf(TypeError);
  });
});

// R5a-fix-round-1（中断した Run の再開の設計書 4.2。R5a の報告の発見事項1）: 状態の保存の Run の ID（`runId`）が、Run のディレクトリの名前
// と違う保存は、使えないものとして扱う（再開すると、出力は `<出力先>/<runId>` に、保存は読んだ Run のディレクトリに書かれ、別のディレクトリに
// 分かれるため）。確かめは、スキーマの確かめの後、呼び出し側の整合の確かめ（`checkState`）の前に、`readCheckpoint` と `readCheckpointState`
// の共通の部分で行う（ファイルごと。`state.json` が違えば、`state.prev.json` を確かめる）。
describe('ArtifactWriter: the run ID of the checkpoint must be the name of the run directory (resumable run design 4.2)', () => {
  /** Run のディレクトリの名前（`RUN_ID`）と違う、Run の ID の形の値。 */
  const OTHER_RUN_ID = createRunId(20260924000001);
  /** Run の ID が違う状態の保存を使えなかった理由。 */
  const differentRunIdReason = (savedRunId: string, directoryName: string): string =>
    `/runId (${savedRunId}) differs from the name of the run directory (${directoryName})`;

  /** 状態の保存のファイル（`file`）の `runId` だけを `OTHER_RUN_ID` に書き換える（スキーマと整合の確かめには合う）。 */
  const rewriteRunId = async (runDirectory: string, file: 'state' | 'previousState'): Promise<void> => {
    const path = checkpointFile(runDirectory, file);
    await writeFile(path, JSON.stringify({ ...(await readJson(path) as RunCheckpoint), runId: OTHER_RUN_ID }), 'utf8');
  };

  /** 保存を読む2つの関数（ページの保存まで読む `readCheckpoint` と、状態の保存だけを読む `readCheckpointState`）。 */
  type Reader = 'readCheckpoint' | 'readCheckpointState';
  const READERS: readonly Reader[] = ['readCheckpoint', 'readCheckpointState'];
  const readWith = async (reader: Reader, writer: ArtifactWriter, runDirectory: string, checkState = checkRunCheckpointConsistency) =>
    reader === 'readCheckpoint'
      ? await writer.readCheckpoint(runDirectory, { checkState, checkPage: checkRunCheckpointPageConsistency })
      : await writer.readCheckpointState(runDirectory, checkState);

  it.each(READERS)('%s: uses state.prev.json when the run ID of state.json differs from the name of the run directory', async (reader) => {
    const { runDirectory, writer } = await savedRunDirectory();
    await rewriteRunId(runDirectory, 'state');

    const read = await readWith(reader, writer, runDirectory);

    expect(read).toMatchObject({ ok: true, source: 'prev', state: sampleCheckpoint(1) });
    expect(read.failures).toEqual([
      { source: 'state', path: 'checkpoint/state.json', reason: differentRunIdReason(OTHER_RUN_ID, RUN_ID) },
    ]);
  });

  it.each(READERS)('%s: does not use state.prev.json whose run ID differs (only state.json is used while it exists)', async (reader) => {
    const { runDirectory, writer } = await savedRunDirectory();
    await rewriteRunId(runDirectory, 'previousState');

    // `state.json` は正しいので、そのまま使う（`state.prev.json` は確かめない）。
    await expect(readWith(reader, writer, runDirectory)).resolves.toMatchObject({
      ok: true,
      source: 'state',
      state: sampleCheckpoint(2),
      failures: [],
    });

    // `state.json` がない（2つの rename の間で止まった）と、Run の ID の違う `state.prev.json` も使えない。
    await rm(checkpointFile(runDirectory, 'state'));
    await expect(readWith(reader, writer, runDirectory)).resolves.toEqual({
      ok: false,
      failures: [
        { source: 'state', path: 'checkpoint/state.json', reason: 'does not exist' },
        { source: 'prev', path: 'checkpoint/state.prev.json', reason: differentRunIdReason(OTHER_RUN_ID, RUN_ID) },
      ],
    });
  });

  it.each(READERS)('%s: uses neither file when the checkpoint is in a run directory of another name', async (reader) => {
    const root = await outputDirectory();
    const renamed = runArtifactDirectory(root, OTHER_RUN_ID);
    const writer = new ArtifactWriter();
    await writer.writeCheckpointPage(renamed, samplePage(PAGE_1));
    await writer.writeCheckpointState(renamed, sampleCheckpoint(1));
    await writer.writeCheckpointPage(renamed, samplePage(PAGE_2));
    await writer.writeCheckpointState(renamed, sampleCheckpoint(2));

    await expect(readWith(reader, writer, renamed)).resolves.toEqual({
      ok: false,
      failures: [
        { source: 'state', path: 'checkpoint/state.json', reason: differentRunIdReason(RUN_ID, OTHER_RUN_ID) },
        { source: 'prev', path: 'checkpoint/state.prev.json', reason: differentRunIdReason(RUN_ID, OTHER_RUN_ID) },
      ],
    });
  });

  it.each(READERS)('%s: checks the run ID after the schema, and before the consistency check of the caller', async (reader) => {
    const { runDirectory, writer } = await savedRunDirectory();
    const checked: RunCheckpoint[] = [];
    const checkState = (state: RunCheckpoint) => {
      checked.push(state);
      return checkRunCheckpointConsistency(state);
    };

    // Run の ID の違う `state.json` は、呼び出し側の整合の確かめに渡さない。
    await rewriteRunId(runDirectory, 'state');
    await expect(readWith(reader, writer, runDirectory, checkState)).resolves.toMatchObject({ ok: true, source: 'prev' });
    expect(checked).toEqual([sampleCheckpoint(1)]);

    // スキーマに合わない場合は、Run の ID が違っても、スキーマの理由にする。
    await writeFile(
      checkpointFile(runDirectory, 'state'),
      JSON.stringify({ ...sampleCheckpoint(2), runId: OTHER_RUN_ID, unexpected: true }),
      'utf8',
    );
    const read = await readWith(reader, writer, runDirectory);
    expect(read.failures).toEqual([
      { source: 'state', path: 'checkpoint/state.json', reason: expect.stringMatching(/^does not match the schema checkpoint: \/ must NOT have additional properties/u) },
    ]);
  });
});

// R5a（中断した Run の再開の設計書 4.7.1 の「Run の後」）: 最後の状態が `FINISHED` の Run は、ページの保存（`checkpoint/pages/`）と
// `state.prev.json` を消し、`state.json` だけを残す。ほかの出力と、Run のディレクトリの外には及ばない。リンクはたどらず、消さない。
describe('ArtifactWriter: removing the checkpoint files a finished Run does not need (resumable run design 4.7.1)', () => {
  const putFile = async (path: string): Promise<void> => {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, 'x', 'utf8');
  };
  const filesUnder = async (directory: string): Promise<string[]> =>
    (await listTree(directory)).filter((path) => !path.endsWith('/'));

  it('removes checkpoint/pages/ and state.prev.json, and keeps state.json and the other outputs', async () => {
    const { runDirectory, writer } = await savedRunDirectory();
    for (const path of ['run.json', 'pages/PAGE-000001/page.json', 'pages/PAGE-000002/page.json']) {
      await putFile(artifactFilePath(runDirectory, path));
    }
    const stateBefore = await readFile(checkpointFile(runDirectory, 'state'), 'utf8');

    const removed = await writer.removeFinishedCheckpointFiles(runDirectory);

    expect(removed).toEqual(['checkpoint/pages', 'checkpoint/state.prev.json']);
    expect(Object.isFrozen(removed)).toBe(true);
    expect(await listTree(runDirectory)).toEqual([
      'checkpoint/',
      'checkpoint/state.json',
      'pages/',
      'pages/PAGE-000001/',
      'pages/PAGE-000001/page.json',
      'pages/PAGE-000002/',
      'pages/PAGE-000002/page.json',
      'run.json',
    ]);
    expect(await readFile(checkpointFile(runDirectory, 'state'), 'utf8')).toBe(stateBefore);
  });

  it('removes nothing more when they are already gone, and nothing when there is no checkpoint/', async () => {
    const { runDirectory, writer } = await savedRunDirectory();
    await writer.removeFinishedCheckpointFiles(runDirectory);

    await expect(writer.removeFinishedCheckpointFiles(runDirectory)).resolves.toEqual([]);
    expect(await listTree(runDirectory)).toEqual(['checkpoint/', 'checkpoint/state.json']);

    const { runDirectory: empty } = await runDirectoryInWork();
    await putFile(artifactFilePath(empty, 'run.json'));
    await expect(writer.removeFinishedCheckpointFiles(empty)).resolves.toEqual([]);
    expect(await listTree(empty)).toEqual(['run.json']);
  });

  it('does not touch anything outside the run directory, even with the same names', async () => {
    const { root, runDirectory } = await runDirectoryInWork();
    const sibling = runArtifactDirectory(root, createRunId(20260924000001));
    const outside = ['checkpoint/state.json', 'checkpoint/state.prev.json', 'checkpoint/pages/PAGE-000001.json'];
    for (const path of outside) {
      await putFile(artifactFilePath(root, path));
      await putFile(artifactFilePath(sibling, path));
    }
    await putFile(artifactFilePath(runDirectory, 'checkpoint/state.json'));
    await putFile(artifactFilePath(runDirectory, 'checkpoint/state.prev.json'));
    const outsideBefore = (await filesUnder(root)).filter((path) => !path.startsWith(`${RUN_ID}/`));

    await expect(new ArtifactWriter().removeFinishedCheckpointFiles(runDirectory)).resolves.toEqual(['checkpoint/state.prev.json']);

    expect((await filesUnder(root)).filter((path) => !path.startsWith(`${RUN_ID}/`))).toEqual(outsideBefore);
    expect(await filesUnder(runDirectory)).toEqual(['checkpoint/state.json']);
  });

  it('does not follow or remove a link from checkpoint/ or checkpoint/pages/ to a directory outside the run directory', async () => {
    const { root, runDirectory } = await runDirectoryInWork();
    const outsidePages = join(root, 'outside-pages');
    const outsideCheckpoint = join(root, 'outside-checkpoint');
    await putFile(join(outsidePages, 'PAGE-000001.json'));
    await putFile(join(outsideCheckpoint, 'state.prev.json'));
    await putFile(join(outsideCheckpoint, 'pages', 'PAGE-000001.json'));
    // Windows では、権限のいらない junction にする（リンク先は、どちらも一時ディレクトリの中）。
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';

    // checkpoint/pages/ がリンク。
    await putFile(artifactFilePath(runDirectory, 'checkpoint/state.json'));
    await symlink(outsidePages, artifactFilePath(runDirectory, 'checkpoint/pages'), linkType);
    await expect(new ArtifactWriter().removeFinishedCheckpointFiles(runDirectory)).resolves.toEqual([]);
    expect(await filesUnder(outsidePages)).toEqual(['PAGE-000001.json']);
    expect((await lstat(artifactFilePath(runDirectory, 'checkpoint/pages'))).isSymbolicLink()).toBe(true);

    // checkpoint/ がリンク。
    const { runDirectory: linked } = await runDirectoryInWork();
    await mkdir(linked, { recursive: true });
    await symlink(outsideCheckpoint, join(linked, 'checkpoint'), linkType);
    await expect(new ArtifactWriter().removeFinishedCheckpointFiles(linked)).resolves.toEqual([]);
    expect(await filesUnder(outsideCheckpoint)).toEqual(['pages/PAGE-000001.json', 'state.prev.json']);
  });

  it('refuses an empty run directory', async () => {
    await expect(new ArtifactWriter().removeFinishedCheckpointFiles('')).rejects.toBeInstanceOf(TypeError);
  });
});

describe('ArtifactWriter: the run lock (resumable run design 4.4)', () => {
  const HOST: RunLockHost = Object.freeze({ processId: 4_321, nowMs: 1_000_000, bootedAtMs: 400_000 });

  it('creates checkpoint/run.lock exclusively with the given lock, and fsyncs it', async () => {
    const { runDirectory } = await runDirectoryInWork();
    const calls: string[] = [];
    const writer = new ArtifactWriter({ fileOperations: recordingFileOperations(runDirectory, calls), platform: 'linux' });
    const lock = createRunLock(HOST);

    await expect(writer.acquireRunLock(runDirectory, lock)).resolves.toEqual({ acquired: true });

    expect(await readJson(checkpointFile(runDirectory, 'lock'))).toEqual(lock);
    expect(calls).toEqual([
      'mkdir checkpoint',
      'open checkpoint/run.lock wx',
      'write checkpoint/run.lock',
      'sync checkpoint/run.lock',
      'close checkpoint/run.lock',
      'open checkpoint r',
      'sync checkpoint',
      'close checkpoint',
    ]);
  });

  it('does not take a lock that already exists, and returns its current content for judgeRunLock', async () => {
    const { runDirectory } = await runDirectoryInWork();
    const writer = new ArtifactWriter();
    const lock = createRunLock(HOST);
    await writer.acquireRunLock(runDirectory, lock);

    const second = await writer.acquireRunLock(runDirectory, createRunLock({ ...HOST, processId: 9_999 }));

    expect(second).toEqual({ acquired: false, existing: lock });
    expect(await readJson(checkpointFile(runDirectory, 'lock'))).toEqual(lock);
    if (!second.acquired) {
      const current = { nowMs: HOST.nowMs + 1_000, bootedAtMs: HOST.bootedAtMs, isProcessRunning: () => true };
      expect(judgeRunLock(second.existing, current)).toBe('ACTIVE');
      expect(judgeRunLock(second.existing, { ...current, isProcessRunning: () => false })).toBe('STALE');
    }
  });

  it('returns null as the current content when the existing lock cannot be read as JSON', async () => {
    const { runDirectory } = await runDirectoryInWork();
    await mkdir(join(runDirectory, 'checkpoint'), { recursive: true });
    await writeFile(checkpointFile(runDirectory, 'lock'), '{"processId":', 'utf8');

    const second = await new ArtifactWriter().acquireRunLock(runDirectory, createRunLock(HOST));

    expect(second).toEqual({ acquired: false, existing: null });
    expect(await readFile(checkpointFile(runDirectory, 'lock'), 'utf8')).toBe('{"processId":');
  });

  it('replaces a stale lock and renews the heartbeat by rewriting the whole file, leaving no temporary file', async () => {
    const { runDirectory } = await runDirectoryInWork();
    const writer = new ArtifactWriter();
    await writer.acquireRunLock(runDirectory, createRunLock(HOST));

    const replacement = createRunLock({ processId: 5_555, nowMs: 2_000_000, bootedAtMs: 1_900_000 });
    await writer.rewriteRunLock(runDirectory, replacement);
    expect(await readJson(checkpointFile(runDirectory, 'lock'))).toEqual(replacement);

    const renewed = renewRunLock(replacement, 2_060_000);
    await writer.rewriteRunLock(runDirectory, renewed);
    expect(await readJson(checkpointFile(runDirectory, 'lock'))).toEqual({ ...replacement, heartbeatAtMs: 2_060_000 });
    expect(await listTree(runDirectory)).toEqual(['checkpoint/', 'checkpoint/run.lock']);
  });

  it('fsyncs the temporary file before renaming it into place when it rewrites the lock', async () => {
    const { runDirectory } = await runDirectoryInWork();
    const calls: string[] = [];
    const writer = new ArtifactWriter({ fileOperations: recordingFileOperations(runDirectory, calls), platform: 'win32' });

    await writer.rewriteRunLock(runDirectory, createRunLock(HOST));

    expect(calls).toEqual([
      'mkdir checkpoint',
      'open checkpoint/.run.lock.<uuid>.tmp wx',
      'write checkpoint/.run.lock.<uuid>.tmp',
      'sync checkpoint/.run.lock.<uuid>.tmp',
      'close checkpoint/.run.lock.<uuid>.tmp',
      'rename checkpoint/.run.lock.<uuid>.tmp -> checkpoint/run.lock',
    ]);
  });

  it('removes the lock, and does nothing when there is no lock', async () => {
    const { runDirectory } = await runDirectoryInWork();
    const writer = new ArtifactWriter();
    await writer.acquireRunLock(runDirectory, createRunLock(HOST));

    await writer.releaseRunLock(runDirectory);
    expect(await listTree(runDirectory)).toEqual(['checkpoint/']);
    await expect(writer.releaseRunLock(runDirectory)).resolves.toBeUndefined();
  });

  it('refuses a lock that cannot be written as JSON, before writing anything', async () => {
    const { runDirectory } = await runDirectoryInWork();
    const unwritable = { processId: 1n };

    await expect(new ArtifactWriter().acquireRunLock(runDirectory, unwritable)).rejects.toBeInstanceOf(TypeError);
    await expect(new ArtifactWriter().rewriteRunLock(runDirectory, unwritable)).rejects.toBeInstanceOf(TypeError);
    await expect(readdir(runDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // R4a2a: 古いロックを作り直した後に、自分のものかを読み直すための、ロックの中身の読み取り（設計書 4.4）。
  it('reads the current content of the lock, deeply frozen, without writing anything', async () => {
    const { runDirectory } = await runDirectoryInWork();
    const writer = new ArtifactWriter();
    const lock = createRunLock(HOST);
    await writer.acquireRunLock(runDirectory, lock);
    const calls: string[] = [];
    const reader = new ArtifactWriter({ fileOperations: recordingFileOperations(runDirectory, calls), platform: 'linux' });

    const read = await reader.readRunLock(runDirectory);
    expect(read).toEqual(lock);
    expect(Object.isFrozen(read)).toBe(true);

    const replacement = createRunLock({ ...HOST, processId: 5_555, nowMs: HOST.nowMs + 1 });
    await writer.rewriteRunLock(runDirectory, replacement);
    await expect(reader.readRunLock(runDirectory)).resolves.toEqual(replacement);

    // 読むだけで、ファイルの操作（作成、書き込み、名前の変更、削除）をしない。
    expect(calls).toEqual([]);
    expect(await listTree(runDirectory)).toEqual(['checkpoint/', 'checkpoint/run.lock']);
  });

  it('returns null without creating anything when there is no lock, and when the lock cannot be read as JSON', async () => {
    const { runDirectory } = await runDirectoryInWork();
    const writer = new ArtifactWriter();

    await expect(writer.readRunLock(runDirectory)).resolves.toBeNull();
    await expect(readdir(runDirectory)).rejects.toMatchObject({ code: 'ENOENT' });

    await mkdir(join(runDirectory, 'checkpoint'), { recursive: true });
    await expect(writer.readRunLock(runDirectory)).resolves.toBeNull();

    await writeFile(checkpointFile(runDirectory, 'lock'), '{"processId":', 'utf8');
    await expect(writer.readRunLock(runDirectory)).resolves.toBeNull();
    expect(await readFile(checkpointFile(runDirectory, 'lock'), 'utf8')).toBe('{"processId":');
  });

  it('refuses an empty run directory when it reads the lock', async () => {
    await expect(new ArtifactWriter().readRunLock('')).rejects.toBeInstanceOf(TypeError);
  });
});

describe('ArtifactWriter: cleaning up a run directory before resuming (resumable run design 4.5)', () => {
  const UUID_1 = '0b7c9a43-4f8e-4a55-9d1e-3a5f2c6b7d81';
  const UUID_2 = '0b7c9a43-4f8e-4a55-9d1e-3a5f2c6b7d82';

  const putFile = async (path: string): Promise<void> => {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, 'x', 'utf8');
  };

  /** 後始末で消すものと残すものを、Run のディレクトリ（`base` の下の相対パス）に置く。 */
  const putFiles = async (base: string, paths: readonly string[]): Promise<void> => {
    for (const path of paths) {
      if (path.endsWith('/')) {
        await mkdir(artifactFilePath(base, path.slice(0, -1)), { recursive: true });
      } else {
        await putFile(artifactFilePath(base, path));
      }
    }
  };

  /** 消すもの（PAGE-000001 は終わったページ、PAGE-000002 と PAGE-000003 は終わっていないページ）。 */
  const REMOVED = [
    `.run.json.${UUID_1}.tmp`,
    `.beaksight-preflight-${UUID_2}.tmp`,
    'pages/PAGE-000002',
    'pages/PAGE-000003',
    `pages/PAGE-000001/.page.json.${UUID_1}.tmp`,
    `checkpoint/.state.json.${UUID_1}.tmp`,
    `checkpoint/.run.lock.${UUID_2}.tmp`,
    'checkpoint/pages/PAGE-000002.json',
    `checkpoint/pages/.PAGE-000002.json.${UUID_1}.tmp`,
  ];
  /** 置くもののうち、消すものの中身（`pages/PAGE-000002/` などの下のファイル）。 */
  const INSIDE_REMOVED = [
    'pages/PAGE-000002/desktop/viewport.png',
    'pages/PAGE-000002/retry-1/desktop/viewport.png',
    'pages/PAGE-000003/',
  ];
  /** 残すもの。 */
  const KEPT = [
    'run.json',
    'other.tmp',
    '.beaksight-preflight-note.txt',
    `.run.json.${UUID_1}.bak`,
    'pages/PAGE-000001/page.json',
    'pages/PAGE-000001/desktop/viewport.png',
    `pages/PAGE-000001/desktop/.viewport.png.${UUID_1}.tmp`,
    'pages/notes/memo.txt',
    'pages/PAGE-1/memo.txt',
    'checkpoint/state.json',
    'checkpoint/state.prev.json',
    'checkpoint/run.lock',
    'checkpoint/pages/PAGE-000001.json',
    'checkpoint/pages/notes.json',
    'checkpoint/pages/PAGE-000001.json.bak',
  ];

  const filesUnder = async (directory: string): Promise<string[]> =>
    (await listTree(directory)).filter((path) => !path.endsWith('/'));

  it('removes the unfinished pages, their page checkpoints and the temporary files, and keeps everything else', async () => {
    const { root, runDirectory } = await runDirectoryInWork();
    await putFiles(runDirectory, [...REMOVED.filter((path) => !path.startsWith('pages/PAGE-00000')), ...INSIDE_REMOVED, ...KEPT]);
    await putFiles(runDirectory, [`pages/PAGE-000001/.page.json.${UUID_1}.tmp`]);

    const removed = await new ArtifactWriter().cleanUpForResume(runDirectory, [PAGE_1]);

    expect([...removed].sort()).toEqual([...REMOVED].sort());
    expect(Object.isFrozen(removed)).toBe(true);
    expect(await filesUnder(runDirectory)).toEqual([...KEPT].sort());
    expect(await listTree(root)).toContain(`${RUN_ID}/pages/notes/`);
  });

  it('does not touch anything outside the run directory, even with the same kinds of names', async () => {
    const { root, runDirectory } = await runDirectoryInWork();
    const sibling = runArtifactDirectory(root, createRunId(20260924000001));
    const outside = [
      `.run.json.${UUID_1}.tmp`,
      `.beaksight-preflight-${UUID_2}.tmp`,
      'pages/PAGE-000002/page.json',
      'checkpoint/pages/PAGE-000002.json',
      `checkpoint/.state.json.${UUID_1}.tmp`,
    ];
    await putFiles(root, outside);
    await putFiles(sibling, outside);
    await putFiles(runDirectory, ['run.json']);
    const before = await filesUnder(root);

    await expect(new ArtifactWriter().cleanUpForResume(runDirectory, [])).resolves.toEqual([]);

    expect(await filesUnder(root)).toEqual(before);
  });

  it('does not follow a link from pages/ or checkpoint/ to a directory outside the run directory', async () => {
    const { root, runDirectory } = await runDirectoryInWork();
    const outsidePages = join(root, 'outside-pages');
    const outsideCheckpoint = join(root, 'outside-checkpoint');
    await putFiles(outsidePages, ['PAGE-000002/page.json', `.x.${UUID_1}.tmp`]);
    await putFiles(outsideCheckpoint, [`.state.json.${UUID_1}.tmp`, 'pages/PAGE-000002.json']);
    await mkdir(runDirectory, { recursive: true });
    // Windows では、権限のいらない junction にする（リンク先は、どちらも一時ディレクトリの中）。
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    await symlink(outsidePages, join(runDirectory, 'pages'), linkType);
    await symlink(outsideCheckpoint, join(runDirectory, 'checkpoint'), linkType);
    const before = await filesUnder(outsidePages);
    const beforeCheckpoint = await filesUnder(outsideCheckpoint);

    await expect(new ArtifactWriter().cleanUpForResume(runDirectory, [])).resolves.toEqual([]);

    expect(await filesUnder(outsidePages)).toEqual(before);
    expect(await filesUnder(outsideCheckpoint)).toEqual(beforeCheckpoint);
  });

  it('does nothing in a run directory that has no pages/ and no checkpoint/', async () => {
    const { runDirectory } = await runDirectoryInWork();
    await putFiles(runDirectory, ['run.json']);
    await expect(new ArtifactWriter().cleanUpForResume(runDirectory, [PAGE_1])).resolves.toEqual([]);
    expect(await listTree(runDirectory)).toEqual(['run.json']);
  });

  it('refuses a completed page ID that does not have the shape of a page ID, before removing anything', async () => {
    const { runDirectory } = await runDirectoryInWork();
    await putFiles(runDirectory, ['pages/PAGE-000002/page.json']);
    await expect(new ArtifactWriter().cleanUpForResume(runDirectory, ['../x' as PageId])).rejects.toBeInstanceOf(RangeError);
    expect(await filesUnder(runDirectory)).toEqual(['pages/PAGE-000002/page.json']);
  });
});
