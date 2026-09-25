// R17f（Task 14〜17 の設計書 第7章、6.1.1、6.1.8。R17 の指摘2）: 確定した `AuditRunResult` から、書き出し、表示用モデル、終了コードまでを
// 行う関数（`finishAuditRun`）。終了コードは、`ArtifactWriter.writeRun` がスキーマの検証で導き直した後の Run Status から決める。
// ブラウザは起動しない（Run Coordinator は使わない）。
// P18d（R17r の Minor-2）: 本番の `run`（`runAuditCommand`）が、Run Coordinator の後の書き出しと終了コードを `finishAuditRun` に
// 任せることも、Run Coordinator を差し替える口（`createRunCoordinator`）で確かめる。
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXIT_CODES } from '../../src/cli/exit-codes.js';
import { finishAuditRun, runAuditCommand } from '../../src/cli/run-command.js';
import { RUN_ARTIFACT_FILE_NAMES, runArtifactDirectory } from '../../src/core/artifact-layout.js';
import type { PageAuditResult, RunSummary } from '../../src/core/contracts.js';
import { deriveRunStatus } from '../../src/core/status.js';
import type { RunCoordinatorDependencies } from '../../src/orchestration/run-coordinator.js';
import { RUN_STATUS_CATALOG } from '../../src/presentation/catalog.js';
import { labelWithCodeText } from '../../src/presentation/messages.js';
import { auditRun } from '../helpers/audit-run-fixture.js';
import { captureCliOutput } from '../helpers/run-harness.js';
import { createTestConfig } from '../helpers/test-config.js';

let workDirectory: string;

beforeAll(async () => {
  workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-run-command-'));
});

afterAll(async () => {
  await rm(workDirectory, { recursive: true, force: true });
});

/** `auditRun()` の既定のページに、page のスキーマにない項目を加えた Run。`run.runStatus` と `statusInput` は、COMPLETE のまま。 */
function schemaInvalidRun() {
  const [firstPage] = auditRun().pages;
  if (firstPage === undefined) {
    throw new Error('the fixture has no page');
  }
  return auditRun({ pages: [{ ...firstPage, unexpectedField: true } as PageAuditResult] });
}

describe('finishAuditRun: the exit code comes from the Run Status after the schema validation (R17 finding 2)', () => {
  it('exits with 2 (PARTIAL) for a Run whose page does not match the schema, although the Run was COMPLETE before writing', async () => {
    const result = schemaInvalidRun();
    expect(result.run.runStatus).toBe('COMPLETE');
    expect(deriveRunStatus(result.statusInput)).toBe('COMPLETE');
    const outputDirectory = join(workDirectory, 'invalid');
    const stdout = captureCliOutput();

    const code = await finishAuditRun(result, outputDirectory, stdout.output);

    expect(code).toBe(EXIT_CODES.PARTIAL);
    const runDirectory = runArtifactDirectory(outputDirectory, result.run.runId);
    const run = JSON.parse(await readFile(join(runDirectory, RUN_ARTIFACT_FILE_NAMES.run), 'utf8')) as RunSummary;
    expect(run.runStatus).toBe('PARTIAL');
    expect(run.incompleteReasons.map(({ code: reasonCode }) => reasonCode)).toContain('REQUIRED_ARTIFACT_INVALID');
    // 表示も、導き直した後の Run Status で示す。
    expect(stdout.text()).toContain(labelWithCodeText(RUN_STATUS_CATALOG.PARTIAL.label, 'PARTIAL'));
    expect(stdout.text()).not.toContain(labelWithCodeText(RUN_STATUS_CATALOG.COMPLETE.label, 'COMPLETE'));
    expect(stdout.text()).toContain(runDirectory);
  });

  it('exits with 0 (COMPLETE) for a Run whose artifacts match their schemas, and writes the report and the bundle', async () => {
    const result = auditRun();
    const outputDirectory = join(workDirectory, 'valid');
    const stdout = captureCliOutput();

    const code = await finishAuditRun(result, outputDirectory, stdout.output);

    expect(code).toBe(EXIT_CODES.COMPLETE);
    const runDirectory = runArtifactDirectory(outputDirectory, result.run.runId);
    for (const file of Object.values(RUN_ARTIFACT_FILE_NAMES)) {
      await expect(readFile(join(runDirectory, file))).resolves.toBeInstanceOf(Buffer);
    }
    expect(stdout.text()).toContain(labelWithCodeText(RUN_STATUS_CATALOG.COMPLETE.label, 'COMPLETE'));
  });
});

describe('runAuditCommand: the production run hands the confirmed Run to finishAuditRun (R17r Minor-2)', () => {
  const failingLaunch = async (): Promise<never> => {
    throw new Error('browser launch is not allowed in this test');
  };

  it('exits with the Run Status after the schema validation (2, PARTIAL), not the one the Run Coordinator returned (COMPLETE)', async () => {
    const result = schemaInvalidRun();
    expect(result.run.runStatus).toBe('COMPLETE');
    const outputDirectory = join(workDirectory, 'run-command');
    const config = createTestConfig('http://127.0.0.1:9', '/', { output: { directory: outputDirectory } });
    const stdout = captureCliOutput();
    const stderr = captureCliOutput();
    const coordinatorDependencies: RunCoordinatorDependencies[] = [];
    const clock = (): Date => new Date('2026-09-25T00:00:00.000Z');
    const now = (): number => 0;

    const code = await runAuditCommand(config, { stdout: stdout.output, stderr: stderr.output }, {
      launchBrowser: failingLaunch,
      clock,
      now,
      createRunCoordinator: (dependencies) => {
        coordinatorDependencies.push(dependencies);
        return { run: async () => result };
      },
    });

    // Run Coordinator には、注入したものと、解決した出力先を渡す。
    expect(coordinatorDependencies).toHaveLength(1);
    expect(coordinatorDependencies[0]).toMatchObject({ config, launchBrowser: failingLaunch, clock, now, outputDirectory });
    // 終了コードと書き出しは、`finishAuditRun` と同じく、導き直した後の Run Status（PARTIAL）による。
    expect(code).toBe(EXIT_CODES.PARTIAL);
    const runDirectory = runArtifactDirectory(outputDirectory, result.run.runId);
    const run = JSON.parse(await readFile(join(runDirectory, RUN_ARTIFACT_FILE_NAMES.run), 'utf8')) as RunSummary;
    expect(run.runStatus).toBe('PARTIAL');
    for (const file of Object.values(RUN_ARTIFACT_FILE_NAMES)) {
      await expect(readFile(join(runDirectory, file))).resolves.toBeInstanceOf(Buffer);
    }
    expect(stdout.text()).toContain(labelWithCodeText(RUN_STATUS_CATALOG.PARTIAL.label, 'PARTIAL'));
    expect(stdout.text()).toContain(runDirectory);
    expect(stderr.text()).toBe('');
  });
});
