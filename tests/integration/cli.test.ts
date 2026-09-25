// U17a（Task 14〜17 の設計書 第7章、6.1.8、実装計画 Task 17 の Step 1・2）: fixture のサイトを 127.0.0.1 で起動し、それを対象にした設定を
// 一時ディレクトリに書いて、一時的なビルドの CLI で `run` を実行する。終了コード、出力先、書き出したファイル、標準出力の要約、
// プロセスが決まった時間の中で終わることを確かめる。
// 実行時間を抑えるため、ページ数の少ない fixture を使い、幅の走査（`stressWidths`）は行わない。
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { EXIT_CODES } from '../../src/cli/exit-codes.js';
import { RUN_ARTIFACT_FILE_NAMES } from '../../src/core/artifact-layout.js';
import type { Finding, PageAuditResult, RunSummary } from '../../src/core/contracts.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { RUN_STATUS_CATALOG, SEVERITY_CATALOG } from '../../src/presentation/catalog.js';
import { formatCount } from '../../src/presentation/format.js';
import { CLI_TEXT, HTML_REPORT_TEXT, RUN_SUMMARY_TEXT } from '../../src/presentation/messages.js';
import {
  expectFinishedInTime,
  onlyRunDirectory,
  runCliProcess,
  STACK_TRACE_LINE,
  type CliProcessResult,
} from '../helpers/cli-process.js';
import { buildIntoTemporaryDirectory, type TemporaryBuild } from '../helpers/temporary-build.js';

const SUITE_TIMEOUT_MS = 300_000;
const JAPANESE_CHARACTER = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;

let server: FixtureServer;
let build: TemporaryBuild;
let workDirectory: string;

beforeAll(async () => {
  server = await startFixtureServer();
  build = await buildIntoTemporaryDirectory();
  workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-cli-integration-'));
}, SUITE_TIMEOUT_MS);

afterAll(async () => {
  await build?.remove();
  await server?.close();
  if (workDirectory !== undefined) {
    await rm(workDirectory, { recursive: true, force: true });
  }
});

/** 一時的なビルドの CLI を、作業のディレクトリ `workDirectory` で、別のプロセスとして起動する（`runCliProcess`）。 */
const runCli = (...arguments_: string[]): Promise<CliProcessResult> => runCliProcess(build, workDirectory, arguments_);

async function writeTargetConfig(name: string, startPath: string, extra: Record<string, unknown>): Promise<string> {
  const path = join(workDirectory, name);
  await writeFile(
    path,
    JSON.stringify({
      target: { id: `cli-${name.replace(/\.json$/u, '')}` },
      site: { startUrl: `${server.origin}${startPath}`, allowedOrigins: [server.origin] },
      viewports: { stressWidths: [] },
      ...extra,
    }),
    'utf8',
  );
  return path;
}

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8')) as unknown;

describe('CLI run: a COMPLETE Run with site ERROR Findings (Task 17 Step 1)', () => {
  let result: CliProcessResult;
  let outputDirectory: string;
  let runDirectory: string;
  let run: RunSummary;
  let findings: readonly Finding[];

  beforeAll(async () => {
    const config = await writeTargetConfig('complete.json', '/js-error.html', { output: { directory: 'configured-output' } });
    outputDirectory = join(workDirectory, 'overridden-output');
    result = await runCli('run', '--config', config, '--output', outputDirectory, '--headless');
    runDirectory = await onlyRunDirectory(outputDirectory);
    run = (await readJson(join(runDirectory, RUN_ARTIFACT_FILE_NAMES.run))) as RunSummary;
    findings = ((await readJson(join(runDirectory, RUN_ARTIFACT_FILE_NAMES.audit))) as { readonly findings: readonly Finding[] }).findings;
  }, SUITE_TIMEOUT_MS);

  it('exits with 0 for COMPLETE even though the site has ERROR Findings', () => {
    expect(run.runStatus).toBe('COMPLETE');
    expect(findings.some((finding) => finding.severity === 'ERROR')).toBe(true);
    expect(result.status, result.stderr).toBe(EXIT_CODES.COMPLETE);
  });

  it('finishes the process within the limit, without a stack trace', () => {
    expectFinishedInTime(result);
    expect(result.stderr).not.toMatch(STACK_TRACE_LINE);
  });

  it('writes into the --output directory instead of the configured one', async () => {
    expect(run.effectiveConfig.output.directory).toBe(outputDirectory);
    await expect(readdir(join(workDirectory, 'configured-output'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writes run.json, audit.json, report.html, the bundle and every page.json, and they match their schemas', async () => {
    await expect(validateArtifact('run', run)).resolves.toEqual({ ok: true });
    await expect(validateArtifact('audit', await readJson(join(runDirectory, RUN_ARTIFACT_FILE_NAMES.audit)))).resolves.toEqual({ ok: true });
    const pages = ((await readJson(join(runDirectory, RUN_ARTIFACT_FILE_NAMES.audit))) as { readonly pages: readonly PageAuditResult[] }).pages;
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) {
      await expect(validateArtifact('page', await readJson(join(runDirectory, 'pages', page.pageId, 'page.json')))).resolves.toEqual({ ok: true });
    }
    const html = await readFile(join(runDirectory, RUN_ARTIFACT_FILE_NAMES.report), 'utf8');
    expect(html).toContain('<html lang="ja">');
    expect(html).toContain(HTML_REPORT_TEXT.title);
    const bundle = unzipSync(new Uint8Array(await readFile(join(runDirectory, RUN_ARTIFACT_FILE_NAMES.bundle))));
    const manifest = JSON.parse(new TextDecoder().decode(bundle['manifest.json'])) as { readonly runId: string; readonly runStatus: string };
    expect(manifest).toMatchObject({ runId: run.runId, runStatus: run.runStatus });
    expect(Object.keys(bundle)).toContain('run.json');
    expect(new TextDecoder().decode(bundle['run.json'])).toBe(await readFile(join(runDirectory, RUN_ARTIFACT_FILE_NAMES.run), 'utf8'));
  });

  it('prints the Run Status, the output directory and the counts from the view model in Japanese', () => {
    expect(result.stdout).toMatch(JAPANESE_CHARACTER);
    expect(result.stdout).toContain(RUN_STATUS_CATALOG.COMPLETE.label);
    expect(result.stdout).toContain(runDirectory);
    expect(result.stdout).toContain(CLI_TEXT.run.outputDirectory);
    expect(result.stdout).toContain(`${RUN_SUMMARY_TEXT.coverage.audited} ${formatCount(run.auditedPageCount)}`);
    const errorCount = findings.filter((finding) => finding.severity === 'ERROR').length;
    expect(result.stdout).toContain(`${SEVERITY_CATALOG.ERROR.label} ${formatCount(errorCount)}`);
    expect(result.stdout).not.toContain(RUN_SUMMARY_TEXT.reasonsHeading);
  });
});

describe('CLI run: a PARTIAL Run (page limit)', () => {
  let result: CliProcessResult;
  let outputDirectory: string;
  let runDirectory: string;
  let run: RunSummary;

  beforeAll(async () => {
    const config = await writeTargetConfig('partial.json', '/crawl/index.html', {
      crawl: { maxPages: 1 },
      audit: { screenshots: false },
      output: { directory: 'partial-output' },
    });
    // 設定の既定値に頼らず、headless に固定する（RC18 の M5）。
    result = await runCli('run', '--config', config, '--headless');
    outputDirectory = join(workDirectory, 'partial-output');
    runDirectory = await onlyRunDirectory(outputDirectory);
    run = (await readJson(join(runDirectory, RUN_ARTIFACT_FILE_NAMES.run))) as RunSummary;
  }, SUITE_TIMEOUT_MS);

  it('exits with 2 for PARTIAL, within the limit', () => {
    expect(run.runStatus).toBe('PARTIAL');
    expect(run.crawlLimits.maxPagesReached).toBe(true);
    expect(result.status, result.stderr).toBe(EXIT_CODES.PARTIAL);
    expectFinishedInTime(result);
  });

  it('writes into the configured output directory (relative to the working directory) when --output is not given', async () => {
    for (const file of Object.values(RUN_ARTIFACT_FILE_NAMES)) {
      await expect(readFile(join(runDirectory, file))).resolves.toBeInstanceOf(Buffer);
    }
  });

  it('prints the PARTIAL label and the number of incomplete reasons', () => {
    expect(result.stdout).toContain(RUN_STATUS_CATALOG.PARTIAL.label);
    expect(result.stdout).toContain(runDirectory);
    expect(result.stdout).toContain(`${RUN_SUMMARY_TEXT.reasonsHeading}: ${formatCount(run.incompleteReasons.length)}`);
    expect(result.stderr).not.toMatch(STACK_TRACE_LINE);
  });
});
