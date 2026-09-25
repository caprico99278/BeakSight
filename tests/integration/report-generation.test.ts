// U16b（Task 14〜17 の設計書 6.1.1、6.1.2、実装計画 Task 16 の Step 1・2）: fixture の /crawl/ を、実際の Chromium で Run Coordinator が
// クロールした結果を、`ArtifactWriter.writeRun` で書き出す。書いた run.json、audit.json、各 page.json がスキーマに合うことと、
// 表示用モデルの Evidence の場所とスクリーンショットのパスが、書いたファイルを指すことを確かめる。
// 実行時間を抑えるため、幅の走査（`stressWidths`）は行わない（スクリーンショットは撮る）。
import { access, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { runArtifactDirectory } from '../../src/core/artifact-layout.js';
import type { AuditRunResult } from '../../src/core/contracts.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { deriveRunStatus } from '../../src/core/status.js';
import { ArtifactWriter, type ArtifactWriteResult } from '../../src/report/artifact-writer.js';
import { buildReportViewModel } from '../../src/report/view-model.js';
import { createRunLauncher, runWithCoordinator } from '../helpers/run-harness.js';
import { createTestConfig } from '../helpers/test-config.js';

const RUN_TEST_TIMEOUT_MS = 300_000;
const START_PATH = '/crawl/index.html';

let server: FixtureServer;
let outputDirectory: string;
// 厳守事項: Chromium は headless だけで起動する（`createRunLauncher` は、要求された `headless` の値にかかわらず、headless で起動する）。
const runLauncher = createRunLauncher();
let crawled: AuditRunResult;
let written: ArtifactWriteResult;

beforeAll(async () => {
  server = await startFixtureServer();
  outputDirectory = await mkdtemp(join(tmpdir(), 'beaksight-report-generation-'));
  crawled = await runWithCoordinator({
    config: createTestConfig(server.origin, START_PATH, { viewports: { stressWidths: [] } }),
    launchBrowser: runLauncher.launcher,
    outputDirectory,
  });
  written = await new ArtifactWriter().writeRun(crawled, { outputDirectory });
}, RUN_TEST_TIMEOUT_MS);

afterAll(async () => {
  await runLauncher.closeAll();
  await server.close();
  await rm(outputDirectory, { recursive: true, force: true });
});

const readJson = async (relativePath: string): Promise<unknown> =>
  JSON.parse(await readFile(join(written.runDirectory, ...relativePath.split('/')), 'utf8')) as unknown;

/** JSON Pointer（`/evidence/3` など）が指す値。 */
function atPointer(value: unknown, pointer: string): unknown {
  return pointer
    .split('/')
    .slice(1)
    .reduce<unknown>((current, token) => (current as Record<string, unknown> | undefined)?.[token], value);
}

describe('ArtifactWriter.writeRun with a crawl of the fixture site (U16b)', () => {
  it('writes into the run directory of the Run Coordinator, without changing a schema-valid Run', () => {
    expect(written.runDirectory).toBe(runArtifactDirectory(outputDirectory, crawled.run.runId));
    expect(written.schemaValid).toBe(true);
    expect(written.invalidArtifacts).toEqual([]);
    expect(written.result.run).toEqual(crawled.run);
    expect(written.result.statusInput.requiredArtifactsValid).toBe(true);
    expect(deriveRunStatus(written.result.statusInput)).toBe(written.result.run.runStatus);
  });

  it('writes run.json, audit.json and every page.json that match their schemas', async () => {
    await expect(validateArtifact('run', await readJson('run.json'))).resolves.toEqual({ ok: true });
    const audit = await readJson('audit.json');
    await expect(validateArtifact('audit', audit)).resolves.toEqual({ ok: true });
    expect(Object.keys(audit as object)).toEqual(['schemaVersion', 'run', 'pages', 'findings']);
    expect(crawled.pages.length).toBeGreaterThan(1);
    for (const page of crawled.pages) {
      const relativePath = `pages/${page.pageId}/page.json`;
      expect(written.files).toContain(relativePath);
      await expect(validateArtifact('page', await readJson(relativePath))).resolves.toEqual({ ok: true });
    }
  });

  it('writes the visible text of every audited page, as UTF-8 text with LF only', async () => {
    const audited = crawled.pages.filter((page) => page.evidence.some((record) => record.type === 'dom'));
    expect(audited.length).toBeGreaterThan(0);
    for (const page of audited) {
      expect(written.files).toContain(`pages/${page.pageId}/visible-text.txt`);
    }
    for (const file of written.files) {
      const bytes = await readFile(join(written.runDirectory, ...file.split('/')));
      expect(bytes.includes(0x0d), file).toBe(false);
      expect(new TextDecoder('utf-8', { fatal: true }).decode(bytes).length, file).toBeGreaterThanOrEqual(0);
    }
  });

  it('leaves no temporary file in the run directory', async () => {
    const entries = await readdir(written.runDirectory, { recursive: true });
    expect(entries.filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
  });

  it('builds a view model whose Evidence places and screenshot paths point to the written files', async () => {
    const model = buildReportViewModel(written.result);
    expect(model.summary.runStatus).toBe(written.result.run.runStatus);
    expect(model.evidence.length).toBe(crawled.pages.reduce((count, page) => count + page.evidence.length, 0));
    const pageJson = new Map<string, unknown>();
    for (const location of model.evidence) {
      const page = pageJson.get(location.path) ?? (await readJson(location.path));
      pageJson.set(location.path, page);
      expect((atPointer(page, location.pointer) as { readonly evidenceId?: string } | undefined)?.evidenceId).toBe(location.evidenceId);
    }
    const screenshots = model.pages.flatMap((page) => page.screenshots);
    expect(screenshots.length).toBeGreaterThan(0);
    for (const screenshot of screenshots) {
      await expect(access(join(written.runDirectory, ...screenshot.relativePath.split('/')))).resolves.toBeUndefined();
    }
  });
});
