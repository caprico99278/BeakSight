// AUD-1d（ユーザーの判断 2026-11-09）: ChatGPT 用バンドルの部の名前（`artifact-layout.ts` の 1 か所）と、部ごとの書き出し・古い部の片付け（`ArtifactWriter`）と、
// CLI の結果の行（全部の部のパス）。ブラウザは使わない。
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSummaryLines } from '../../src/cli/output.js';
import {
  artifactFilePath,
  bundleFileName,
  bundleFileNameTimestampOf,
  bundleFilePartOf,
  isBundleFileName,
  newestBundleFileSetOf,
} from '../../src/core/artifact-layout.js';
import { ArtifactWriter } from '../../src/report/artifact-writer.js';
import { buildReportViewModel } from '../../src/report/view-model.js';
import { auditRun } from '../helpers/audit-run-fixture.js';

const FINISHED_AT = '2026-11-09T01:02:03.000Z';
const STAMP = '20261109010203';

let workDirectory: string;
beforeAll(async () => {
  workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-bundle-parts-'));
});
afterAll(async () => {
  await rm(workDirectory, { recursive: true, force: true });
});

describe('AUD-1d: the names of the bundle parts', () => {
  it('keeps the current name for one part, and adds _part<n> after the time for two parts or more', () => {
    expect(bundleFileName(FINISHED_AT)).toBe(`beaksight-audit-bundle_${STAMP}.zip`);
    expect(bundleFileName(FINISHED_AT, undefined, { partNumber: 1, partCount: 1 })).toBe(`beaksight-audit-bundle_${STAMP}.zip`);
    expect(bundleFileName(FINISHED_AT, undefined, { partNumber: 2, partCount: 3 })).toBe(`beaksight-audit-bundle_${STAMP}_part2.zip`);
    expect(bundleFileName(FINISHED_AT, '管理画面', { partNumber: 1, partCount: 2 })).toBe(`beaksight-audit-bundle_管理画面_${STAMP}_part1.zip`);
  });

  it('rejects a part number outside 1 to the part count', () => {
    for (const part of [{ partNumber: 0, partCount: 2 }, { partNumber: 3, partCount: 2 }, { partNumber: 1.5, partCount: 2 }, { partNumber: 1, partCount: 0 }]) {
      expect(() => bundleFileName(FINISHED_AT, undefined, part), JSON.stringify(part)).toThrow(RangeError);
    }
  });

  it('recognizes the part names, with their time, their part and their set', () => {
    const part2 = `beaksight-audit-bundle_管理画面_${STAMP}_part2.zip`;
    expect(isBundleFileName(part2)).toBe(true);
    expect(bundleFileNameTimestampOf(part2)).toBe(STAMP);
    expect(bundleFilePartOf(part2)).toEqual({ setName: `beaksight-audit-bundle_管理画面_${STAMP}.zip`, partNumber: 2 });
    expect(bundleFilePartOf(`beaksight-audit-bundle_${STAMP}.zip`)).toEqual({ setName: `beaksight-audit-bundle_${STAMP}.zip`, partNumber: null });
    for (const name of [`beaksight-audit-bundle_${STAMP}_part0.zip`, `beaksight-audit-bundle_${STAMP}_part.zip`, `beaksight-audit-bundle_${STAMP}_Part1.zip`]) {
      expect(isBundleFileName(name), name).toBe(false);
    }
    // 名前の部分が `_part` で終わっても、日時の前なので部の印と取り違えない。
    expect(bundleFilePartOf(`beaksight-audit-bundle_x_part2_${STAMP}.zip`)).toEqual({ setName: `beaksight-audit-bundle_x_part2_${STAMP}.zip`, partNumber: null });
  });

  it('selects every part of the newest set, in the part order', () => {
    const older = `beaksight-audit-bundle_20261108010203.zip`;
    const names = [
      `beaksight-audit-bundle_${STAMP}_part2.zip`,
      older,
      'run.json',
      `beaksight-audit-bundle_${STAMP}_part1.zip`,
      `beaksight-audit-bundle_${STAMP}_part10.zip`,
    ];
    expect(newestBundleFileSetOf(names)).toEqual([
      `beaksight-audit-bundle_${STAMP}_part1.zip`,
      `beaksight-audit-bundle_${STAMP}_part2.zip`,
      `beaksight-audit-bundle_${STAMP}_part10.zip`,
    ]);
    expect(newestBundleFileSetOf([older, 'report.html'])).toEqual([older]);
    expect(newestBundleFileSetOf(['report.html'])).toEqual([]);
  });
});

describe('AUD-1d: writing the parts and removing the older ones', () => {
  it('writes every part under its name, and removes the parts of the earlier writing when it writes one ZIP', async () => {
    const writer = new ArtifactWriter();
    const written = await writer.writeRun(auditRun(), { outputDirectory: join(workDirectory, 'writer') });
    const bundlesIn = async (): Promise<readonly string[]> => (await readdir(written.runDirectory)).filter(isBundleFileName).sort();

    const names = await writer.writePresentation(written, {
      bundle: { bytes: [Uint8Array.from([1]), Uint8Array.from([2]), Uint8Array.from([3])], lastExecutionFinishedAt: FINISHED_AT },
    });
    expect(names).toEqual([1, 2, 3].map((partNumber) => bundleFileName(FINISHED_AT, undefined, { partNumber, partCount: 3 })));
    expect(await bundlesIn()).toEqual([...names].sort());

    // 前の回の部が残っていても、1 つの ZIP を書いた後は、その 1 つだけが残る。
    await writeFile(artifactFilePath(written.runDirectory, `beaksight-audit-bundle_20261101000000_part1.zip`), Uint8Array.from([9]));
    const single = await writer.writePresentation(written, { bundle: { bytes: Uint8Array.from([4]), lastExecutionFinishedAt: FINISHED_AT } });
    expect(single).toEqual([bundleFileName(FINISHED_AT)]);
    expect(await bundlesIn()).toEqual([bundleFileName(FINISHED_AT)]);
  });

  // MEM-2（DEF-266）: 部を 1 つずつ受け取り、次の部を作る前に、前の部を書き終える。
  it('writes the parts given one at a time, each before the next part is made (MEM-2)', async () => {
    const writer = new ArtifactWriter();
    const written = await writer.writeRun(auditRun(), { outputDirectory: join(workDirectory, 'streamed') });
    const names = [1, 2].map((partNumber) => bundleFileName(FINISHED_AT, undefined, { partNumber, partCount: 2 }));
    const seenBeforeSecond: string[] = [];
    async function* parts(): AsyncGenerator<Uint8Array> {
      yield Uint8Array.from([1]);
      seenBeforeSecond.push(...(await readdir(written.runDirectory)).filter(isBundleFileName));
      yield Uint8Array.from([2]);
    }

    expect(await writer.writePresentation(written, { bundle: { bytes: { partCount: 2, parts: parts() }, lastExecutionFinishedAt: FINISHED_AT } })).toEqual(names);
    expect(seenBeforeSecond).toEqual([names[0]]);
    expect([...await readFile(artifactFilePath(written.runDirectory, names[1] ?? ''))]).toEqual([2]);
  });

  it('rejects an empty list of parts before writing', async () => {
    const writer = new ArtifactWriter();
    const written = await writer.writeRun(auditRun(), { outputDirectory: join(workDirectory, 'empty') });
    await expect(writer.writePresentation(written, { bundle: { bytes: [], lastExecutionFinishedAt: FINISHED_AT } })).rejects.toThrow(RangeError);
  });
});

describe('AUD-1d: the result lines of the CLI', () => {
  it('shows the path of every part when the bundle is in parts, and one path for one ZIP', () => {
    const { summary } = buildReportViewModel(auditRun());
    const runDirectory = join('artifacts', 'RUN-1');
    const finishedAt = summary.executions.lastFinishedAt;
    const parts = [1, 2].map((partNumber) => artifactFilePath(runDirectory, bundleFileName(finishedAt, undefined, { partNumber, partCount: 2 })));
    const multi = runSummaryLines(summary, runDirectory, 2).join('\n');
    for (const path of parts) {
      expect(multi).toContain(path);
    }
    expect(runSummaryLines(summary, runDirectory).join('\n')).toContain(artifactFilePath(runDirectory, bundleFileName(finishedAt)));
  });
});
