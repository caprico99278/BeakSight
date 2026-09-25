// T19a（Task 19 の設計書 第4章。上位の実装計画 Task 19 の Step 3）: 専用の fixture のサイト（`fixtures/site/full-crawl/`）を、
// 一時ディレクトリにビルドした本物の CLI（`dist/cli/index.js`）で、別のプロセスとして最後まで監査する。
//
// - 設定は、製品の既定値（`DEFAULT_CONFIG`）のまま、`site`（入口と許可 Origin）と出力先だけを変える。幅の走査、スクリーンショット、
//   Interaction の段階も、既定のまま行う。起動には、必ず `--headless` を付ける。
// - 確かめること（設計書 4.2）: 終了コード 0 と `COMPLETE`、監査したページの一覧、壊したページごとの ruleId、対照のページ、
//   Guard の有効と不変条件の違反0件、サーバに届いたリクエストが GET と HEAD だけ、artifact とスキーマ、期限とスタックトレース。
//
// fixture のサイトの構成（深さは、入口からのリンクの数。discovery の順）:
//   index.html（0） → links.html（1）、technical.html（1）、layout.html（1）、control.html（1）
//   links.html（1） → missing.html（2。このサーバにない 404 のページ）、contrast.html（2）、accessibility.html（2）
// fixture のサーバは、`/robots.txt` と `/sitemap.xml` を、このサイト専用のもの（`fixtures/site/full-crawl/`）で返す
// （`siteMetadataDirectory`。T19a-fix-round-1）。sitemap には、missing.html を除く7ページを載せる。
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startFixtureServer,
  type FixtureRequestObservation,
  type FixtureServer,
  type FixtureServerCounters,
} from '../../fixtures/server.js';
import { EXIT_CODES } from '../../src/cli/exit-codes.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import {
  artifactFilePath,
  pageArtifactRelativePath,
  RUN_ARTIFACT_FILE_NAMES,
} from '../../src/core/artifact-layout.js';
import type { EvidenceRecord, Finding, PageAuditResult, RunSummary } from '../../src/core/contracts.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { CHATGPT_BUNDLE_FILE_NAMES, type ChatGptBundleManifest } from '../../src/report/chatgpt-bundle.js';
import { HTML_REPORT_TEXT } from '../../src/presentation/messages.js';
import {
  expectFinishedInTime,
  onlyRunDirectory,
  runCliProcess,
  STACK_TRACE_LINE,
  type CliProcessResult,
} from '../helpers/cli-process.js';
import {
  expectOnlyReadRequests,
  expectSchemaValid,
  findingsOf,
  readJson,
  readRunArtifactFiles,
  readRunAudit,
  type ArtifactFileContent,
} from '../helpers/run-harness.js';
import { buildIntoTemporaryDirectory, type TemporaryBuild } from '../helpers/temporary-build.js';

/** ビルドと、既定の設定での CLI の1回の Run を含む、`beforeAll` の上限。 */
const SUITE_TIMEOUT_MS = 300_000;
const TARGET_ID = 'fixture-full-crawl';

/** 専用の fixture のサイトのページ（パス）。 */
const PATHS = Object.freeze({
  start: '/full-crawl/index.html',
  links: '/full-crawl/links.html',
  technical: '/full-crawl/technical.html',
  layout: '/full-crawl/layout.html',
  control: '/full-crawl/control.html',
  missing: '/full-crawl/missing.html',
  contrast: '/full-crawl/contrast.html',
  accessibility: '/full-crawl/accessibility.html',
});

/** 監査するページの一覧（発見の順。入口から幅優先でたどる）。これと完全に一致しなければならない。 */
const EXPECTED_AUDITED_PATHS: readonly string[] = Object.freeze([
  PATHS.start,
  PATHS.links,
  PATHS.technical,
  PATHS.layout,
  PATHS.control,
  PATHS.missing,
  PATHS.contrast,
  PATHS.accessibility,
]);

/**
 * 壊したページごとに、必ず出なければならない Finding の ruleId（どの Rule が検出するかは、`src/audit/` の各 Rule で確かめた）。
 * - links: 404 のページへのリンク → `BROKEN_INTERNAL_LINK`（Cross-page rule。リンクを持つページの Finding）
 * - missing: 404 のページ → `HTTP_4XX`
 * - technical: 読み込めない画像 → `IMAGE_LOAD_FAILED`、捕まえられない JavaScript の例外 → `PAGE_ERROR`
 * - layout: 横方向のはみ出し（Mobile と狭い幅） → `DOCUMENT_HORIZONTAL_OVERFLOW`
 * - contrast: コントラストの低い文字 → `COLOR_CONTRAST_VIOLATION`
 * - accessibility: 名前のないボタン → axe の `button-name` → `A11Y_BUTTON_NAME`
 */
const EXPECTED_RULE_IDS_BY_PATH: Readonly<Record<string, readonly string[]>> = Object.freeze({
  [PATHS.links]: ['BROKEN_INTERNAL_LINK'],
  [PATHS.missing]: ['HTTP_4XX'],
  [PATHS.technical]: ['IMAGE_LOAD_FAILED', 'PAGE_ERROR'],
  [PATHS.layout]: ['DOCUMENT_HORIZONTAL_OVERFLOW'],
  [PATHS.contrast]: ['COLOR_CONTRAST_VIOLATION'],
  [PATHS.accessibility]: ['A11Y_BUTTON_NAME'],
});

/**
 * fixture のサーバが `/robots.txt` と `/sitemap.xml` を返すディレクトリ（`fixtures/site/` からの相対のパス。T19a-fix-round-1）。
 * このサイト専用の sitemap は、実在する7ページを載せ、404 になる missing.html は載せない。
 */
const SITE_METADATA_DIRECTORY = 'full-crawl';

/** sitemap に載せたページ（`fixtures/site/full-crawl/sitemap.xml`）。監査するページのうち、missing.html 以外のすべて。 */
const SITEMAP_PATHS: readonly string[] = Object.freeze(EXPECTED_AUDITED_PATHS.filter((path) => path !== PATHS.missing));

/**
 * Run の中で、fixture のサーバに届いてよいパス（`/full-crawl/` の下と、サイトの metadata の `/robots.txt` と `/sitemap.xml`）。
 * サイトの metadata は、サーバが `SITE_METADATA_DIRECTORY` のファイルから返すが、ブラウザが要求するパスは Origin の直下である。
 */
const ALLOWED_REQUEST_PATH = /^\/full-crawl\/|^\/robots\.txt$|^\/sitemap\.xml$/u;

let server: FixtureServer;
let build: TemporaryBuild;
let workDirectory: string;
let outputDirectory: string;
let configPath: string;
let result: CliProcessResult;
let runDirectory: string;
let run: RunSummary;
let audit: { readonly pages: readonly PageAuditResult[]; readonly findings: readonly Finding[] };
let files: readonly ArtifactFileContent[];
let counters: Readonly<FixtureServerCounters>;
let observations: readonly Readonly<FixtureRequestObservation>[];

beforeAll(async () => {
  server = await startFixtureServer({ siteMetadataDirectory: SITE_METADATA_DIRECTORY });
  build = await buildIntoTemporaryDirectory();
  workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-fixture-full-crawl-'));
  outputDirectory = join(workDirectory, 'output');
  configPath = join(workDirectory, 'full-crawl.json');
  // 製品の既定値のまま、`site` だけを指定する（出力先は `--output` で変える）。
  await writeFile(
    configPath,
    JSON.stringify({
      target: { id: TARGET_ID },
      site: { startUrl: `${server.origin}${PATHS.start}`, allowedOrigins: [server.origin] },
    }),
    'utf8',
  );
  server.resetCounters();
  server.resetRequestObservations();
  // 厳守事項: Chromium は headless だけで起動する（`--headless` を必ず付ける）。
  result = await runCliProcess(build, workDirectory, ['run', '--config', configPath, '--output', outputDirectory, '--headless']);
  counters = server.getCounters();
  observations = server.getRequestObservations();
  console.info(`fixture full crawl: the CLI process took ${result.elapsedMs} ms (exit code ${String(result.status)})`);
  runDirectory = await onlyRunDirectory(outputDirectory);
  run = (await readJson(join(runDirectory, RUN_ARTIFACT_FILE_NAMES.run))) as RunSummary;
  audit = await readRunAudit(runDirectory);
  files = await readRunArtifactFiles(runDirectory);
}, SUITE_TIMEOUT_MS);

afterAll(async () => {
  await build?.remove();
  await server?.close();
  if (workDirectory !== undefined) {
    await rm(workDirectory, { recursive: true, force: true });
  }
});

const urlOf = (path: string): string => `${server.origin}${path}`;
const pathOf = (url: string | null): string | null => (url === null ? null : new URL(url).pathname);
/** そのページ（パス）の Finding の ruleId の一覧（重複なし、並べ替え済み）。 */
const ruleIdsOn = (path: string): string[] =>
  [...new Set(audit.findings.filter((finding) => pathOf(finding.pageUrl) === path).map(({ ruleId }) => ruleId))].sort();
const pageAt = (path: string): PageAuditResult => {
  const page = audit.pages.find((candidate) => pathOf(candidate.pageUrl) === path);
  if (page === undefined) {
    throw new Error(`the Run did not audit ${path}`);
  }
  return page;
};
const interactionsOf = (page: PageAuditResult): Extract<EvidenceRecord, { readonly type: 'interaction' }>[] =>
  page.evidence.filter((record): record is Extract<EvidenceRecord, { readonly type: 'interaction' }> => record.type === 'interaction');
const fileAt = (path: string): ArtifactFileContent | undefined => files.find((file) => file.path === path);
const textOf = (file: ArtifactFileContent | undefined): string => Buffer.from(file?.bytes ?? new Uint8Array()).toString('utf8');

describe('fixture full crawl through the built CLI with the default settings (Task 19 design 4.2)', () => {
  it('exits with 0 and the Run is COMPLETE, with no incomplete reason', () => {
    expect(run.runStatus, JSON.stringify(run.incompleteReasons)).toBe('COMPLETE');
    expect(run.incompleteReasons).toEqual([]);
    expect(result.status, result.stderr).toBe(EXIT_CODES.COMPLETE);
  });

  it('uses the product defaults except the site and the output directory', () => {
    expect(run.target.id).toBe(TARGET_ID);
    expect(run.effectiveConfig.site).toEqual({ startUrl: urlOf(PATHS.start), allowedOrigins: [server.origin] });
    expect(run.effectiveConfig.output.directory).toBe(outputDirectory);
    expect(run.effectiveConfig.crawl).toEqual(DEFAULT_CONFIG.crawl);
    expect(run.effectiveConfig.browser).toEqual(DEFAULT_CONFIG.browser);
    expect(run.effectiveConfig.browser.headed).toBe(false);
    expect(run.effectiveConfig.viewports).toEqual(DEFAULT_CONFIG.viewports);
    expect(run.effectiveConfig.audit).toEqual(DEFAULT_CONFIG.audit);
    // 上限で止まって PARTIAL にならないよう、ページ数の上限は、見つかるページの数より大きい。
    expect(run.effectiveConfig.crawl.maxPages).toBeGreaterThan(EXPECTED_AUDITED_PATHS.length);
  });

  it('audits exactly the expected pages of the fixture site, down to depth 2', () => {
    expect(audit.pages.map((page) => pathOf(page.pageUrl))).toEqual(EXPECTED_AUDITED_PATHS);
    expect(audit.pages.every((page) => page.status === 'AUDITED')).toBe(true);
    expect(run.discoveredPageCount).toBe(EXPECTED_AUDITED_PATHS.length);
    expect(run.auditedPageCount).toBe(EXPECTED_AUDITED_PATHS.length);
    expect(run.crawlLimits).toEqual({ maxPagesReached: false, maxDepthReached: false, maxRuntimeReached: false });
    expect(pageAt(PATHS.missing).viewports.desktop.httpStatus).toBe(404);
  });

  it.each(Object.entries(EXPECTED_RULE_IDS_BY_PATH))('reports the expected Findings on the broken page %s', (path, ruleIds) => {
    const page = pageAt(path);
    const found = ruleIdsOn(path);
    for (const ruleId of ruleIds) {
      expect(found, `${ruleId} on ${path}`).toContain(ruleId);
    }
    for (const finding of audit.findings.filter((candidate) => ruleIds.includes(candidate.ruleId) && pathOf(candidate.pageUrl) === path)) {
      expect(finding.pageId).toBe(page.pageId);
    }
  });

  it('reports no Finding at all on the control page', () => {
    // 対照のページを監査したこと（監査していなければ、Finding がないのは当然で、確かめにならない）。
    const control = pageAt(PATHS.control);
    expect(control.status).toBe('AUDITED');
    // Run の Finding の一覧（Cross-page rule の Finding を含む）にも、ページの結果にも、1件もない。
    expect(ruleIdsOn(PATHS.control)).toEqual([]);
    expect(control.findings).toEqual([]);
  });

  it('reads the sitemap of this site on the start page', () => {
    // 入口のページに、このサイト専用の sitemap の Evidence があり、載せた7ページを読めている（読めなければ、sitemap の Rule は
    // 判定しないので、下の2つの確かめで Finding がないことが、確かめにならない）。
    const sitemaps = pageAt(PATHS.start).evidence.flatMap((record) =>
      record.type === 'metadata' && record.payload.kind === 'SITEMAP_XML' ? [record.payload] : []);
    expect(sitemaps).toHaveLength(1);
    expect(sitemaps[0]?.outcome).toBe('OK');
    expect(sitemaps[0]?.sitemapUrls).toEqual(SITEMAP_PATHS.map(urlOf));
    expect(sitemaps[0]?.sitemapUrlsTruncated).toBe(false);
  });

  it('reports DISCOVERED_URL_NOT_IN_SITEMAP only on the 404 page, which the sitemap does not list', () => {
    expect(findingsOf(audit, 'DISCOVERED_URL_NOT_IN_SITEMAP').map((finding) => pathOf(finding.pageUrl))).toEqual([PATHS.missing]);
  });

  it('reports no SITEMAP_URL_NOT_DISCOVERED, since the crawl discovers every page of the sitemap', () => {
    expect(findingsOf(audit, 'SITEMAP_URL_NOT_DISCOVERED')).toEqual([]);
  });

  it('verifies the safe disclosure button of the control page in the Interaction stage', () => {
    const interactions = interactionsOf(pageAt(PATHS.control));
    expect(interactions.length).toBeGreaterThan(0);
    expect(interactions.map((record) => record.payload.status)).toContain('VERIFIED');
  });

  it('keeps the Guard enabled, with no safety invariant violation and nothing to block', () => {
    expect(run.safety.guardEnabled).toBe(true);
    expect(run.safety.invariantViolationCount).toBe(0);
    expect(run.safety.invariantViolations).toEqual([]);
    expect(run.safety.recordTruncated).toBe(false);
    // fixture のサイトは、外部の読み込み、外部スキーム、フォーム、ダウンロード、変更系のリクエストを持たない。
    expect(run.safety.blockedActions).toEqual({
      requests: 0,
      navigations: 0,
      externalActions: 0,
      popups: 0,
      downloads: 0,
      webSockets: 0,
    });
  });

  it('sends only GET and HEAD to the fixture server, and only for the fixture site', () => {
    expect(observations.length).toBeGreaterThan(0);
    expectOnlyReadRequests(counters, observations);
    const outside = [...new Set(observations.map(({ pathname }) => pathname))].filter((pathname) => !ALLOWED_REQUEST_PATH.test(pathname));
    expect(outside).toEqual([]);
  });

  it('writes run.json, audit.json, report.html, every page.json and the bundle, and they match their schemas', async () => {
    for (const name of Object.values(RUN_ARTIFACT_FILE_NAMES)) {
      expect(fileAt(name), name).toBeDefined();
    }
    await expect(validateArtifact('audit', await readJson(join(runDirectory, RUN_ARTIFACT_FILE_NAMES.audit)))).resolves.toEqual({ ok: true });
    const writtenPages: PageAuditResult[] = [];
    for (const page of audit.pages) {
      const relativePath = pageArtifactRelativePath(page.pageId, 'page');
      expect(fileAt(relativePath), relativePath).toBeDefined();
      writtenPages.push((await readJson(artifactFilePath(runDirectory, relativePath))) as PageAuditResult);
    }
    await expectSchemaValid({ run, pages: writtenPages, findings: audit.findings });
    expect(textOf(fileAt(RUN_ARTIFACT_FILE_NAMES.report))).toContain(HTML_REPORT_TEXT.title);

    // ChatGPT 用のバンドル: manifest が同じ Run を指し、run.json と各 page.json を、書き出したものと同じバイト列で含む。
    const inBundle = (name: string): ArtifactFileContent | undefined => fileAt(`${RUN_ARTIFACT_FILE_NAMES.bundle}!/${name}`);
    const manifest = JSON.parse(textOf(inBundle(CHATGPT_BUNDLE_FILE_NAMES.manifest))) as ChatGptBundleManifest;
    expect(manifest).toMatchObject({ runId: run.runId, runStatus: 'COMPLETE' });
    expect(manifest.omittedFiles.filter(({ reason }) => reason === 'ARTIFACT_FILE_NOT_FOUND')).toEqual([]);
    expect(textOf(inBundle(RUN_ARTIFACT_FILE_NAMES.run))).toBe(textOf(fileAt(RUN_ARTIFACT_FILE_NAMES.run)));
    for (const page of audit.pages) {
      const relativePath = pageArtifactRelativePath(page.pageId, 'page');
      expect(textOf(inBundle(relativePath)), relativePath).toBe(textOf(fileAt(relativePath)));
    }
  });

  it('finishes the CLI process within the limit, without a stack trace', () => {
    expectFinishedInTime(result);
    expect(result.stdout).not.toMatch(STACK_TRACE_LINE);
    expect(result.stderr).not.toMatch(STACK_TRACE_LINE);
  });
});
