// MEM-3c（DEF-266。設計書 `2026-11-13-beaksight-run-memory-scaling-design.md` 3 章・6 章）: 再開のときにページの保存を 1 ページずつ読み、要約と圧縮した本体だけを
// 持つ。node の子 process（`--expose-gc`。ブラウザ・ワーカー・サーバは起こさない）で、合成した 40 ページと 120 ページの保存を再開の入力に読み込み、`heapUsed` の
// 最大の増え方が、ページの本体の大きさに比例しないことを確かめる。
// MEM-3d: 同じ作りで、置き場所の Run を Run の終わりの書き出し（writeRun・表示用モデル・HTML・バンドル）まで通す場面も確かめる（測りの作りを共有するため、同じ
// ファイルに置く）。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TYPESCRIPT_SOURCE_RESOLVE_HOOK } from '../helpers/typescript-source-hook.js';

/** 1 ページの本体の、可視テキストの字数（日本語。UTF-8 で約 3 倍のバイト数）。 */
const PAGE_TEXT_LENGTH = 100_000;
/** 子 process の終わりを待つ上限（ミリ秒）。 */
const CHILD_TIMEOUT_MS = 240_000;
/** 本体の大きさの差に対する、`heapUsed` の最大の増え方の差の上限の比（本体を持てば 1 を超える）。 */
const MAX_HEAP_TO_BODY_RATIO = 0.25;

const moduleUrl = (path: string): string => new URL(path, import.meta.url).href;

/** 子 process の本文。保存を書いてから、再開の入力として読み、測った値を 1 行の JSON で書く。 */
const CHILD_SCRIPT = `
${TYPESCRIPT_SOURCE_RESOLVE_HOOK}
const [writerUrl, coordinatorUrl, checkpointUrl, samplesUrl, fixtureModuleUrl, ledgerUrl, outputDirectory, pageCountText, textLengthText] = process.argv.slice(1);
const { ArtifactWriter } = await import(writerUrl);
const { restoredRunPagesCollector } = await import(coordinatorUrl);
const { createRunCheckpoint, createRunCheckpointPage, checkRunCheckpointConsistency, checkRunCheckpointPageConsistency } = await import(checkpointUrl);
const { sampleCrawl, sampleIdleLoad, sampleQuietProgress } = await import(samplesUrl);
const { dom, fixtureUrl, interaction, page, runSummary, FIXTURE_RUN_ID } = await import(fixtureModuleUrl);
const INTERACTIONS_PER_PAGE = 10;
const { SafetyLedger } = await import(ledgerUrl);
const { artifactFilePath, checkpointPageArtifactRelativePath, runArtifactDirectory } = await import(new URL('../../src/core/artifact-layout.ts', writerUrl).href);
const { statSync } = await import('node:fs');
const pageCount = Number(pageCountText);
const text = 'あ'.repeat(Number(textLengthText));
const paths = Array.from({ length: pageCount - 1 }, (_, index) => fixtureUrl('/p' + String(index + 2) + '.html'));
const { config, allocator, frontier } = sampleCrawl([{ status: 'AUDITED', links: paths }, ...paths.map(() => ({ status: 'AUDITED' }))]);
const writer = new ArtifactWriter();
const runDirectory = runArtifactDirectory(outputDirectory, FIXTURE_RUN_ID);
const completedPageIds = [];
let bodyBytes = 0;
for (const entry of frontier.snapshot().entries) {
  const pageId = entry.pageId;
  const evidenceId = allocator.allocateEvidenceId('dom');
  // 要約に残る Interaction の Evidence も、ページごとに持たせる（要約の大きさを測るため）。
  const interactions = Array.from({ length: INTERACTIONS_PER_PAGE }, () =>
    ({ ...interaction(1, pageId, 'VERIFIED', null), evidenceId: allocator.allocateEvidenceId('interaction') }));
  const value = { ...page(pageId, new URL(entry.url).pathname, 'AUDITED', [{ ...dom(1, pageId, 'desktop', text + pageId), evidenceId }, ...interactions]) };
  await writer.writeCheckpointPage(runDirectory, createRunCheckpointPage({ result: value, retryEvidence: [], safetyLedgerSnapshots: [new SafetyLedger().snapshot()] }));
  bodyBytes += statSync(artifactFilePath(runDirectory, checkpointPageArtifactRelativePath(pageId))).size;
  completedPageIds.push(pageId);
}
const startedAt = '2026-10-01T00:00:00.000Z';
await writer.writeCheckpointState(runDirectory, createRunCheckpoint({
  state: 'IN_PROGRESS', runId: FIXTURE_RUN_ID, toolVersion: '0.1.0', startedAt, savedAt: '2026-10-01T00:05:00.000Z', effectiveConfig: config,
  executions: [{ startedAt, finishedAt: null, endReason: null, environment: runSummary().environment }],
  frontier: frontier.snapshot(), allocator: allocator.snapshot(), progress: sampleQuietProgress(pageCount),
  safetyLedgerSnapshots: [new SafetyLedger().snapshot()], siteMetadata: null, load: sampleIdleLoad(), completedPageIds,
}));
globalThis.gc();
const base = process.memoryUsage().heapUsed;
let peak = 0;
const collector = restoredRunPagesCollector();
const read = await writer.readCheckpointCollected(runDirectory, { checkState: checkRunCheckpointConsistency, checkPage: checkRunCheckpointPageConsistency }, {
  begin: () => {
    const collection = collector.begin();
    return {
      add: async (value) => {
        await collection.add(value);
        globalThis.gc();
        peak = Math.max(peak, process.memoryUsage().heapUsed - base);
      },
      finish: () => collection.finish(),
    };
  },
});
globalThis.gc();
const retained = process.memoryUsage().heapUsed - base;
process.stdout.write(JSON.stringify({
  ok: read.ok,
  pages: read.ok ? read.pages.pages.length : 0,
  bodyBytes,
  peak,
  retained,
  summaryBytes: read.ok ? JSON.stringify(read.pages.pages.summaries()).length : 0,
  storedBytes: read.ok ? read.pages.pages.storedByteLength() : 0,
}) + '\\n');
`;

/**
 * MEM-3d: 子 process の本文。合成したページを、戻すたびに測る置き場所に入れ（ページは持たない）、Run の終わりの書き出し（`writeAuditRunOutputs`: writeRun・
 * 表示用モデル・HTML・バンドル）まで通して、測った値を 1 行の JSON で書く。測るのは、本体を戻すたび（前のページを手放した後）と、書き終えた後。
 */
const WRITE_CHILD_SCRIPT = `
${TYPESCRIPT_SOURCE_RESOLVE_HOOK}
const [cliUrl, storeUrl, fixtureModuleUrl, idsUrl, outputDirectory, pageCountText, textLengthText] = process.argv.slice(1);
const { writeAuditRunOutputs } = await import(cliUrl);
const { createRunPageStore, ZLIB_RUN_PAGE_CODEC } = await import(storeUrl);
const { auditRun, dom, page } = await import(fixtureModuleUrl);
const { createPageId } = await import(idsUrl);
const pageCount = Number(pageCountText);
const text = 'あ'.repeat(Number(textLengthText));
let base = 0;
let peak = 0;
const sample = () => {
  globalThis.gc();
  peak = Math.max(peak, process.memoryUsage().heapUsed - base);
};
const store = createRunPageStore({
  codec: { encode: ZLIB_RUN_PAGE_CODEC.encode, decode: async (bytes) => { sample(); return ZLIB_RUN_PAGE_CODEC.decode(bytes); } },
});
let bodyBytes = 0;
for (let index = 0; index < pageCount; index += 1) {
  const pageId = createPageId(index + 1);
  const value = page(pageId, '/p' + String(index + 1) + '.html', 'AUDITED', [dom(index + 1, pageId, 'desktop', text + pageId)]);
  bodyBytes += Buffer.byteLength(JSON.stringify(value));
  await store.add(value, null);
}
const result = { ...auditRun(), pages: store, findings: [] };
globalThis.gc();
base = process.memoryUsage().heapUsed;
const outputs = await writeAuditRunOutputs(result, outputDirectory);
sample();
process.stdout.write(JSON.stringify({ ok: outputs.runDirectory.length > 0, bodyBytes, peak, storedBytes: store.storedByteLength() }) + '\\n');
`;

interface WriteChildMeasure {
  readonly ok: boolean;
  readonly bodyBytes: number;
  readonly peak: number;
  readonly storedBytes: number;
}

interface ChildMeasure {
  readonly ok: boolean;
  readonly pages: number;
  readonly bodyBytes: number;
  readonly peak: number;
  readonly retained: number;
  readonly summaryBytes: number;
  readonly storedBytes: number;
}

let workDirectory = '';

beforeAll(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-resume-memory-'));
});

afterAll(() => {
  rmSync(workDirectory, { recursive: true, force: true });
});

const measure = (pageCount: number): ChildMeasure => {
  const outputDirectory = join(workDirectory, String(pageCount));
  const result = spawnSync(process.execPath, [
    '--expose-gc',
    '--input-type=module',
    '-e',
    CHILD_SCRIPT,
    moduleUrl('../../src/report/artifact-writer.ts'),
    moduleUrl('../../src/orchestration/run-coordinator.ts'),
    moduleUrl('../../src/orchestration/run-checkpoint.ts'),
    moduleUrl('../helpers/run-checkpoint-samples.ts'),
    moduleUrl('../helpers/audit-run-fixture.ts'),
    moduleUrl('../../src/safety/safety-ledger.ts'),
    outputDirectory,
    String(pageCount),
    String(PAGE_TEXT_LENGTH),
  ], { encoding: 'utf8', timeout: CHILD_TIMEOUT_MS, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1) ?? '') as ChildMeasure;
};

describe('MEM-3c: reading the checkpoint pages to resume keeps only the summaries and the compressed bodies', () => {
  it('does not grow the heap with the size of the page bodies (40 and 120 pages)', () => {
    const small = measure(40);
    const large = measure(120);
    // 測った値を残す（設計者への報告のため）。
    console.info(JSON.stringify({ small, large }));

    expect([small.ok, small.pages, large.ok, large.pages]).toEqual([true, 40, true, 120]);
    const bodyGrowth = large.bodyBytes - small.bodyBytes;
    expect(large.peak - small.peak).toBeLessThan(bodyGrowth * MAX_HEAP_TO_BODY_RATIO);
    expect(large.retained - small.retained).toBeLessThan(bodyGrowth * MAX_HEAP_TO_BODY_RATIO);
  }, CHILD_TIMEOUT_MS * 2);
});

/** MEM-3d: 書き出しの子 process を流し、測った値を返す。 */
const measureWrite = (pageCount: number): WriteChildMeasure => {
  const result = spawnSync(process.execPath, [
    '--expose-gc',
    '--input-type=module',
    '-e',
    WRITE_CHILD_SCRIPT,
    moduleUrl('../../src/cli/audit-run.ts'),
    moduleUrl('../../src/core/run-page-store.ts'),
    moduleUrl('../helpers/audit-run-fixture.ts'),
    moduleUrl('../../src/core/ids.ts'),
    join(workDirectory, `write-${String(pageCount)}`),
    String(pageCount),
    String(PAGE_TEXT_LENGTH),
  ], { encoding: 'utf8', timeout: CHILD_TIMEOUT_MS, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1) ?? '') as WriteChildMeasure;
};

// MEM-3d（設計書 6 章）: Run の終わりの書き出し（writeRun・表示用モデル・HTML・バンドル）は、ページの置き場所を 1 ページずつ戻して書く。
describe('MEM-3d: writing the Run from the page store does not hold the page bodies', () => {
  it('does not grow the heap with the size of the page bodies (40 and 120 pages)', () => {
    const small = measureWrite(40);
    const large = measureWrite(120);
    // 測った値を残す（設計者への報告のため）。
    console.info(JSON.stringify({ small, large }));

    expect([small.ok, large.ok]).toEqual([true, true]);
    expect(large.peak - small.peak).toBeLessThan((large.bodyBytes - small.bodyBytes) * MAX_HEAP_TO_BODY_RATIO);
  }, CHILD_TIMEOUT_MS * 2);
});
