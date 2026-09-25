// U16b（Task 14〜17 の設計書 6.1.1、6.1.2。ARCH05、ARCH08）: artifact の書き出しの唯一の owner（`ArtifactWriter.writeRun`）。
// JSON をメモリの上で組み立てて検証し、スキーマに合わない場合は Run Status を `deriveRunStatus` で導き直してから、一時ファイルと
// rename で書く。書き出すテキストは、UTF-8 と LF にする。
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RUN_ARTIFACT_FILE_NAMES, pageArtifactRelativePath, runArtifactDirectory } from '../../src/core/artifact-layout.js';
import type { AuditRunResult, PageAuditResult, PageId, RunSummary } from '../../src/core/contracts.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { deriveRunStatus, type RunStatusInput } from '../../src/core/status.js';
import { ArtifactWriteError, ArtifactWriter } from '../../src/report/artifact-writer.js';
import {
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
  screenshot,
} from '../helpers/audit-run-fixture.js';

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
