// MEM-4（DEF-266。設計書 `2026-11-13-beaksight-run-memory-scaling-design.md` 3 章の MEM-4）: 表示用モデルと HTML のレポートは、ページの置き場所（store）を
// 渡しても、配列を渡したときと同じ値・同じバイト列になる。store のページの本体は、組み立ての間に 1 回だけ戻す。HTML は、節かページ 1 つ分ずつ書く。
// MEM-3d: Run の終わりの書き出し（writeRun から）も、store をそのまま受け取り、配列と同じバイト列を書く。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeAuditRunOutputs } from '../../src/cli/audit-run.js';
import { RUN_ARTIFACT_FILE_NAMES, runArtifactDirectory } from '../../src/core/artifact-layout.js';
import type { AuditRunResult } from '../../src/core/contracts.js';
import { createRunPageStore, runPagesArrayOf, ZLIB_RUN_PAGE_CODEC, type RunPages } from '../../src/core/run-page-store.js';
import { ArtifactWriter, type CheckpointFileOperations } from '../../src/report/artifact-writer.js';
import { renderHtmlReport } from '../../src/report/html-report.js';
import { buildPublishedReportViewModel } from '../../src/report/view-model.js';
import {
  auditRun,
  beaksightBlockAuditRun,
  collectedInPartsAuditRun,
  edgeCaseAuditRun,
} from '../helpers/audit-run-fixture.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** 見本の Run（ページ・Evidence・Finding の形の違うもの）。 */
const SAMPLE_RUNS = Object.freeze({ auditRun, edgeCaseAuditRun, beaksightBlockAuditRun, collectedInPartsAuditRun });

/** 全画面の画像だけがない、とする確かめ（欠けの扱いも比べる）。 */
const exists = async (path: string): Promise<boolean> => !path.endsWith('full-page.png');

/** 同じ Run のページを、戻した回数を数える置き場所に入れたもの。 */
async function storedRunOf(result: AuditRunResult): Promise<{ readonly stored: AuditRunResult<RunPages>; readonly decodes: () => number }> {
  let decodes = 0;
  const store = createRunPageStore<null>({
    codec: {
      encode: ZLIB_RUN_PAGE_CODEC.encode,
      decode: async (bytes) => {
        decodes += 1;
        return ZLIB_RUN_PAGE_CODEC.decode(bytes);
      },
    },
  });
  for (const page of result.pages) {
    await store.add(page, null);
  }
  return { stored: { ...result, pages: store }, decodes: () => decodes };
}

describe('MEM-4: the view model and the HTML report from the page store', () => {
  it.each(Object.entries(SAMPLE_RUNS))('gives the same view model and report.html from the store as from the array (%s)', async (_name, sample) => {
    const result = sample();
    const { stored } = await storedRunOf(result);

    const fromArray = await buildPublishedReportViewModel(result, exists, { plannedWriteScreenCount: 1 });
    const fromStore = await buildPublishedReportViewModel(stored, exists, { plannedWriteScreenCount: 1 });

    expect(JSON.stringify(fromStore)).toBe(JSON.stringify(fromArray));
    expect(renderHtmlReport(fromStore)).toBe(renderHtmlReport(fromArray));
  });

  it('gives back each page body once while building the view model from the store', async () => {
    const result = edgeCaseAuditRun();
    const { stored, decodes } = await storedRunOf(result);

    await buildPublishedReportViewModel(stored, exists);

    expect(decodes()).toBe(result.pages.length);
  });

  it('writes report.html in writes of one section or one page at most, with the same bytes', async () => {
    const outputDirectory = mkdtempSync(join(tmpdir(), 'beaksight-report-page-store-'));
    directories.push(outputDirectory);
    const reportWrites: string[] = [];
    const fileOperations: CheckpointFileOperations = {
      mkdir,
      rename,
      rm,
      open: async (path, flags) => {
        const handle = await open(path, flags);
        return {
          writeFile: async (data, options) => {
            if (basename(path).includes(RUN_ARTIFACT_FILE_NAMES.report)) {
              reportWrites.push(data);
            }
            await handle.writeFile(data, options);
          },
          sync: async () => handle.sync(),
          close: async () => handle.close(),
        };
      },
    };
    const result = edgeCaseAuditRun();

    const outputs = await writeAuditRunOutputs(result, outputDirectory, new ArtifactWriter({ fileOperations }));

    const written = readFileSync(join(runArtifactDirectory(outputDirectory, outputs.runId), RUN_ARTIFACT_FILE_NAMES.report), 'utf8');
    expect(reportWrites.join('')).toBe(written);
    // 節（`<h2>`）とページ・小さな節（`<h3>`）を、1 回の書き込みに 2 つ入れない。
    expect(reportWrites.length).toBeGreaterThan(result.pages.length);
    for (const data of reportWrites) {
      expect((data.match(/<h2 /gu) ?? []).length).toBeLessThanOrEqual(1);
      expect((data.match(/<h3 /gu) ?? []).length).toBeLessThanOrEqual(1);
    }
  });
});

/** Run のディレクトリの、全部のファイル（相対パス → バイト列）。 */
async function filesOf(directory: string): Promise<ReadonlyMap<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      files.set(relative(directory, path).replaceAll('\\', '/'), await readFile(path));
    }
  }
  return files;
}

// MEM-3d（DEF-266）: Run の終わりの書き出し（writeRun・表示用モデル・HTML・バンドル）は、Run Coordinator の置き場所をそのまま受け取る。
describe('MEM-3d: writing the Run from the page store', () => {
  it.each(Object.entries(SAMPLE_RUNS))('writes the same bytes in every file of the Run directory from the store as from the array (%s)', async (_name, sample) => {
    const result = sample();
    const { stored } = await storedRunOf(result);
    const fromArray = mkdtempSync(join(tmpdir(), 'beaksight-mem3d-array-'));
    const fromStore = mkdtempSync(join(tmpdir(), 'beaksight-mem3d-store-'));
    directories.push(fromArray, fromStore);

    await writeAuditRunOutputs(result, fromArray);
    await writeAuditRunOutputs(stored, fromStore);

    const expected = await filesOf(fromArray);
    const actual = await filesOf(fromStore);
    expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [path, bytes] of expected) {
      expect(actual.get(path)?.equals(bytes), path).toBe(true);
    }
  });

  it('gives back each page body at most twice while writing the Run, and returns the redacted pages in a store', async () => {
    const result = edgeCaseAuditRun();
    const { stored, decodes } = await storedRunOf(result);
    const outputDirectory = mkdtempSync(join(tmpdir(), 'beaksight-mem3d-decodes-'));
    directories.push(outputDirectory);

    const written = await new ArtifactWriter().writeRun(stored, { outputDirectory });

    expect(decodes()).toBeLessThanOrEqual(result.pages.length * 2);
    const fromArray = await new ArtifactWriter().writeRun(result, { outputDirectory: mkdtempSync(join(tmpdir(), 'beaksight-mem3d-decodes-')) });
    expect(Array.isArray(written.result.pages)).toBe(false);
    expect(await runPagesArrayOf(written.result.pages)).toEqual(fromArray.result.pages);
  });
});
