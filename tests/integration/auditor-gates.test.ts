// T18c（Task 18 の受け入れの Gate 設計書 4.1、4.3。実装タスク指示 第11章）: Auditor の Gate（GATE-A01〜A10）。
// A01〜A09 は、実際の Chromium で、fixture のページを、Run Coordinator か CLI（同じプロセスの中の `runCli`）を通して監査し、
// Finding、Interaction の結果、Run Status を確かめる。A10 は、スキーマに合わない Run を `finishAuditRun` に渡して確かめる。
//
// Run の構成（実行時間を抑えるため、幅の走査とスクリーンショットはしない。Interaction の段階は既定のまま有効）:
// - HUB: 共通のハブのページ `/auditor-hub.html` から、既定の上限でたどる。CLI（`runCli`）で監査する（C18d。CC-029）。
//   ハブは、404 のページ、壊れた画像と JS の例外のページ（`/js-error.html`）、はみ出しのページ（`/overflow.html`）、
//   低いコントラストのページ（`/bad-contrast.html`）へのリンクを持つ。A01〜A06、完了の意味と終了コード 0 を、この1つの Run で確かめる。
//   ハブのページ自身は、A01〜A06 の Finding が出てはならない、同じ Run の中の対照のページである。
// - ACCORDION: `/accordion.html`（A07）。MUTATION: `/mutation-button.html`、POST_FORM: `/post-form.html`（A08）。
//   Interaction の段階の結果と、Run の全体でサーバに届いたリクエストを確かめるので、ページごとに Run を分ける。
// - PAGE_LIMIT: ハブから、`maxPages: 2` でたどる（A09。上限のない HUB の Run が対照）。
// 各 Run は、自分の fixture のサーバを使う。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  startFixtureServer,
  type FixtureRequestObservation,
  type FixtureServer,
  type FixtureServerCounters,
} from '../../fixtures/server.js';
import { EXIT_CODES } from '../../src/cli/exit-codes.js';
import { finishAuditRun } from '../../src/cli/run-command.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { RUN_ARTIFACT_FILE_NAMES, runArtifactDirectory } from '../../src/core/artifact-layout.js';
import type {
  AuditRunResult,
  EvidenceRecord,
  Finding,
  InteractionStatus,
  PageAuditResult,
  RunSummary,
  ViewportProfile,
} from '../../src/core/contracts.js';
import { deriveRunStatus } from '../../src/core/status.js';
import { auditRun } from '../helpers/audit-run-fixture.js';
import { withUnguardedPage } from '../helpers/gate-harness.js';
import {
  captureCliOutput,
  cliTargetConfig,
  createRunLauncher,
  expectOnlyReadRequests,
  expectSchemaValid,
  fastRunConfig,
  findingsOf,
  readJson,
  readRunAudit,
  runCliInProcess,
  runWithCoordinator,
} from '../helpers/run-harness.js';
import type { TestConfigOverrides } from '../helpers/test-config.js';

const RUNS_TIMEOUT_MS = 300_000;

const PATHS = Object.freeze({
  hub: '/auditor-hub.html',
  hubMissing: '/auditor-hub-missing.html',
  technical: '/js-error.html',
  brokenImage: '/__broken-image.png',
  overflow: '/overflow.html',
  contrast: '/bad-contrast.html',
  accordion: '/accordion.html',
  mutationButton: '/mutation-button.html',
  postForm: '/post-form.html',
  mutationEndpoint: '/__mutation',
});

/** Run の結果のうち、Gate で確かめるもの（CLI の Run では、書き出した run.json と audit.json から読み直す）。 */
type GateRunResult = Pick<AuditRunResult, 'run' | 'pages' | 'findings'>;

/** 1つの Run の結果と、その Run の fixture のサーバが受けたリクエスト。 */
interface GateRun {
  readonly origin: string;
  readonly result: GateRunResult;
  readonly counters: Readonly<FixtureServerCounters>;
  readonly observations: readonly Readonly<FixtureRequestObservation>[];
}

/** CLI（`runCli`）で行った Run の結果。`result` は、書き出した run.json と audit.json から読み直したもの。 */
interface CliGateRun extends GateRun {
  readonly exitCode: number;
  readonly stderr: string;
}

const workDirectories: string[] = [];
/** Run が起動する headless の Chromium（起動した Browser が、後に残っていないことを確かめる）。 */
const runLauncher = createRunLauncher();

afterEach(async () => {
  const leftovers = await runLauncher.closeAll();
  expect(leftovers, 'Browsers left connected after the test').toBe(0);
});

afterAll(async () => {
  for (const directory of workDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function workDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `beaksight-auditor-gates-${prefix}-`));
  workDirectories.push(directory);
  return directory;
}

/** fixture のサーバを起動し、`body` の後に、受けたリクエストを読んで閉じる。 */
async function withFixtureServer<T>(body: (server: FixtureServer) => Promise<T>): Promise<{
  readonly value: T;
  readonly counters: Readonly<FixtureServerCounters>;
  readonly observations: readonly Readonly<FixtureRequestObservation>[];
}> {
  const server = await startFixtureServer();
  try {
    const value = await body(server);
    return { value, counters: { ...server.getCounters() }, observations: [...server.getRequestObservations()] };
  } finally {
    await server.close();
  }
}

/** Run Coordinator で、fixture の `startPath` から Run を行う。 */
async function auditWithCoordinator(startPath: string, overrides: TestConfigOverrides = {}): Promise<GateRun> {
  const outputDirectory = await workDirectory('run');
  let origin = '';
  const { value: result, counters, observations } = await withFixtureServer(async (server) => {
    origin = server.origin;
    return await runWithCoordinator({
      config: fastRunConfig(server.origin, startPath, overrides),
      launchBrowser: runLauncher.launcher,
      outputDirectory,
    });
  });
  return { origin, result, counters, observations };
}

/**
 * CLI（同じプロセスの中の `runCli`）で、fixture の `startPath` から Run を行う。設定のファイルを一時ディレクトリに書き、
 * `run --config <ファイル>` を実行する（`runCliInProcess`）。Browser の起動だけを差し替える（起動した Browser を、後で確かめるため）。
 */
async function auditWithCli(startPath: string): Promise<CliGateRun> {
  const directory = await workDirectory('cli');
  let origin = '';
  const { value: cliRun, counters, observations } = await withFixtureServer(async (server) => {
    origin = server.origin;
    return await runCliInProcess({
      directory,
      name: 'auditor-gates',
      config: cliTargetConfig('auditor-gates', server.origin, startPath, { audit: { screenshots: false } }),
      launchBrowser: runLauncher.launcher,
    });
  });
  const audit = await readRunAudit(cliRun.runDirectory);
  const result: GateRunResult = { run: cliRun.run, pages: audit.pages, findings: audit.findings };
  return { origin, result, counters, observations, exitCode: cliRun.code, stderr: cliRun.stderr };
}

// ---------------------------------------------------------------------------------------------------------------
// 確かめ方の補助
// ---------------------------------------------------------------------------------------------------------------

const pathOf = (url: string | null): string | null => (url === null ? null : new URL(url).pathname);
const pageAt = (run: GateRun, path: string): PageAuditResult => {
  const page = run.result.pages.find((candidate) => pathOf(candidate.pageUrl) === path);
  if (page === undefined) {
    throw new Error(`the Run did not audit ${path}: ${run.result.pages.map((candidate) => candidate.pageUrl).join(', ')}`);
  }
  return page;
};

/**
 * Finding が、Rule の ID、ページ、ビューポート、Evidence の参照を持つことを確かめる（設計書 4.3）。
 * - ページ: `pageId` と `pageUrl` が、`page` のもの。
 * - ビューポート: `viewport` が `viewports` のどれか（`null` を含めて指定する）。
 * - Evidence の参照: 1件以上あり、どれも、そのページの Evidence にある。ビューポートのある Finding は、同じビューポートの Evidence を参照する。
 * - Page Rule の Finding（`owner: 'page'`）は、ページの結果（`page.findings`）にも入る。Cross-page の Finding（`owner: 'run'`）は、
 *   Run の Finding の一覧だけに入る（`evaluateCrossPageRules` の結果を、Run Coordinator が Run の一覧に加える）。
 */
function expectWellFormedFinding(
  finding: Finding,
  ruleId: string,
  page: PageAuditResult,
  viewports: readonly (ViewportProfile | null)[],
  owner: 'page' | 'run' = 'page',
): void {
  expect(finding.ruleId).toBe(ruleId);
  expect(finding.pageId).toBe(page.pageId);
  expect(finding.pageUrl).toBe(page.pageUrl);
  expect(viewports).toContain(finding.viewport);
  expect(finding.evidenceRefs.length).toBeGreaterThan(0);
  const evidenceById = new Map(page.evidence.map((record) => [record.evidenceId, record]));
  for (const evidenceId of finding.evidenceRefs) {
    const referenced = evidenceById.get(evidenceId);
    expect(referenced, `${ruleId} refers to ${evidenceId}, which is not the Evidence of ${page.pageId}`).toBeDefined();
    if (finding.viewport !== null) {
      expect(referenced?.viewport).toBe(finding.viewport);
    }
  }
  const pageFindingIds = page.findings.map(({ findingId }) => findingId);
  if (owner === 'page') {
    expect(pageFindingIds).toContain(finding.findingId);
  } else {
    expect(pageFindingIds).not.toContain(finding.findingId);
  }
}

const interactionsOf = (page: PageAuditResult): Extract<EvidenceRecord, { readonly type: 'interaction' }>[] =>
  page.evidence.filter((record): record is Extract<EvidenceRecord, { readonly type: 'interaction' }> => record.type === 'interaction');
const interactionStatuses = (page: PageAuditResult): InteractionStatus[] =>
  interactionsOf(page).map((record) => record.payload.status);

/** GET と HEAD 以外のメソッドが、その Run のサーバに1件も届いていない。 */
const expectOnlyReadRequestsIn = (run: GateRun): void => expectOnlyReadRequests(run.counters, run.observations);

// ---------------------------------------------------------------------------------------------------------------
// Run の実行
// ---------------------------------------------------------------------------------------------------------------

/** `beforeAll` で行う Run の数（HUB、ACCORDION、MUTATION、POST_FORM、PAGE_LIMIT。Run ごとに Chromium を1つ起動する）。 */
const GATE_RUN_COUNT = 5;

let hub: CliGateRun;
let accordion: GateRun;
let mutation: GateRun;
let postForm: GateRun;
let pageLimit: GateRun;

beforeAll(async () => {
  hub = await auditWithCli(PATHS.hub);
  accordion = await auditWithCoordinator(PATHS.accordion);
  mutation = await auditWithCoordinator(PATHS.mutationButton);
  postForm = await auditWithCoordinator(PATHS.postForm);
  pageLimit = await auditWithCoordinator(PATHS.hub, { crawl: { maxPages: 2 } });
}, RUNS_TIMEOUT_MS);

/** 監査の対象のページが1つの Run の、そのページ。 */
const onlyPage = (run: GateRun): PageAuditResult => {
  expect(run.result.pages).toHaveLength(1);
  return run.result.pages[0] as PageAuditResult;
};

/** 問題のない（対照の）ページ。A01〜A06 の Finding が出てはならない。 */
const controlPages = (): readonly { readonly name: string; readonly run: GateRun; readonly page: PageAuditResult }[] => [
  { name: 'hub', run: hub, page: pageAt(hub, PATHS.hub) },
  { name: 'accordion', run: accordion, page: onlyPage(accordion) },
];

const findingsOnPage = (run: GateRun, page: PageAuditResult, ruleId: string): Finding[] =>
  findingsOf(run.result, ruleId).filter((finding) => finding.pageId === page.pageId);

describe('Auditor Gates (Task 18 design 4.3)', () => {
  it('GATE-A01: a 404 page gets an HTTP_4XX Finding (and the pages that answered 200 do not)', () => {
    const missing = pageAt(hub, PATHS.hubMissing);
    expect(missing.viewports.desktop.httpStatus).toBe(404);
    const findings = findingsOnPage(hub, missing, 'HTTP_4XX');
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expectWellFormedFinding(finding, 'HTTP_4XX', missing, ['desktop', 'mobile']);
      expect(finding.severity).toBe('ERROR');
      expect(finding.message).toContain(`${hub.origin}${PATHS.hubMissing}`);
    }
    // 対照: 200 で応答したページ（ハブ、js-error、overflow、bad-contrast）には、HTTP_4XX が出ない。
    const answered = hub.result.pages.filter((page) => page.viewports.desktop.httpStatus === 200);
    expect(answered.length).toBeGreaterThanOrEqual(4);
    expect(findingsOf(hub.result, 'HTTP_4XX').every((finding) => finding.pageId === missing.pageId)).toBe(true);
  });

  it('GATE-A02: a link to the 404 page gets a BROKEN_INTERNAL_LINK Finding on the linking page only', () => {
    const start = pageAt(hub, PATHS.hub);
    const findings = findingsOf(hub.result, 'BROKEN_INTERNAL_LINK');
    expect(findings).toHaveLength(1);
    const [finding] = findings as [Finding];
    expectWellFormedFinding(finding, 'BROKEN_INTERNAL_LINK', start, [null, 'desktop', 'mobile'], 'run');
    expect(finding.severity).toBe('ERROR');
    expect(finding.message).toContain(`${hub.origin}${PATHS.hubMissing}`);
    // 参照する Evidence は、リンクの Evidence を含む。
    const referencedTypes = start.evidence.filter((record) => finding.evidenceRefs.includes(record.evidenceId)).map(({ type }) => type);
    expect(referencedTypes).toContain('link');
    // 対照: 監査して 200 だったページへの内部リンク（js-error、overflow、bad-contrast へのリンク）は、Finding にならない。
    for (const path of [PATHS.technical, PATHS.overflow, PATHS.contrast]) {
      expect(findings.some((candidate) => candidate.message.includes(path)), path).toBe(false);
    }
  });

  it('GATE-A03: an uncaught JS exception gets a PAGE_ERROR Finding (audited through the CLI)', () => {
    const page = pageAt(hub, PATHS.technical);
    const findings = findingsOnPage(hub, page, 'PAGE_ERROR');
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expectWellFormedFinding(finding, 'PAGE_ERROR', page, ['desktop', 'mobile']);
      expect(finding.message).toContain('fixture uncaught exception');
    }
    // 対照: 例外を投げないページには、PAGE_ERROR が出ない。
    for (const control of controlPages()) {
      expect(findingsOnPage(control.run, control.page, 'PAGE_ERROR'), control.name).toEqual([]);
    }
  });

  it('GATE-A04: a broken image gets an IMAGE_LOAD_FAILED Finding (audited through the CLI)', () => {
    const page = pageAt(hub, PATHS.technical);
    const findings = findingsOnPage(hub, page, 'IMAGE_LOAD_FAILED');
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expectWellFormedFinding(finding, 'IMAGE_LOAD_FAILED', page, ['desktop', 'mobile']);
      expect(finding.message).toContain(`${hub.origin}${PATHS.brokenImage}`);
    }
    // 対照: 読み込める画像（data: の GIF）だけのページには、IMAGE_LOAD_FAILED が出ない。
    expect(findingsOnPage(hub, pageAt(hub, PATHS.contrast), 'IMAGE_LOAD_FAILED')).toEqual([]);
    for (const control of controlPages()) {
      expect(findingsOnPage(control.run, control.page, 'IMAGE_LOAD_FAILED'), control.name).toEqual([]);
    }
  });

  it('GATE-A05: a horizontal overflow gets a DOCUMENT_HORIZONTAL_OVERFLOW Finding on the viewport that overflows only', () => {
    const page = pageAt(hub, PATHS.overflow);
    const findings = findingsOnPage(hub, page, 'DOCUMENT_HORIZONTAL_OVERFLOW');
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      // 文書の幅は 1200px。Mobile（390px）でははみ出し、Desktop（1440px）でははみ出さない。
      expectWellFormedFinding(finding, 'DOCUMENT_HORIZONTAL_OVERFLOW', page, ['mobile']);
      expect(finding.severity).toBe('ERROR');
    }
    // 対照: 同じページの Desktop と、はみ出さないページには出ない。
    expect(findings.filter((finding) => finding.viewport === 'desktop')).toEqual([]);
    for (const control of controlPages()) {
      expect(findingsOnPage(control.run, control.page, 'DOCUMENT_HORIZONTAL_OVERFLOW'), control.name).toEqual([]);
    }
  });

  it('GATE-A06: low contrast text gets a COLOR_CONTRAST_VIOLATION Finding', () => {
    const page = pageAt(hub, PATHS.contrast);
    const findings = findingsOnPage(hub, page, 'COLOR_CONTRAST_VIOLATION');
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expectWellFormedFinding(finding, 'COLOR_CONTRAST_VIOLATION', page, ['desktop', 'mobile']);
      expect(finding.category).toBe('ACCESSIBILITY');
    }
    // 対照: 既定の色（白の地に黒の文字）のページには出ない。
    for (const control of controlPages()) {
      expect(findingsOnPage(control.run, control.page, 'COLOR_CONTRAST_VIOLATION'), control.name).toEqual([]);
    }
  });

  it('GATE-A07: a safe accordion is VERIFIED by the Interaction stage of the Run', () => {
    const page = onlyPage(accordion);
    const interactions = interactionsOf(page);
    const toggle = interactions.filter((record) => record.payload.status === 'VERIFIED');
    expect(toggle.length).toBeGreaterThan(0);
    for (const record of toggle) {
      expect(record.pageId).toBe(page.pageId);
      expect(record.viewport).toBe('desktop');
      expect(record.payload.lifecycle.status).toBe('CLOSED');
    }
    // 検証した操作は、ページを変えない（サーバに変更のリクエストが届かない）。
    expectOnlyReadRequestsIn(accordion);
    // 対照: 安全でない操作のページでは、VERIFIED にならない（A08）。
    expect(interactionStatuses(onlyPage(mutation))).not.toContain('VERIFIED');
    expect(interactionStatuses(onlyPage(postForm))).not.toContain('VERIFIED');
  });

  it('GATE-A08: an unsafe fetch POST button is BLOCKED_BY_SAFETY and the POST does not reach the server', () => {
    const page = onlyPage(mutation);
    const statuses = interactionStatuses(page);
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses).toContain('BLOCKED_BY_SAFETY');
    expect(statuses).not.toContain('VERIFIED');
    // サーバの側: `/__mutation` へのリクエストは1件も届かず、GET と HEAD 以外のメソッドも届かない。
    expect(mutation.observations.some(({ pathname }) => pathname === PATHS.mutationEndpoint)).toBe(false);
    expectOnlyReadRequestsIn(mutation);
    expect(mutation.observations.some(({ pathname }) => pathname === PATHS.mutationButton)).toBe(true);
    expect(mutation.result.run.safety.blockedActions.requests).toBeGreaterThan(0);
    expect(mutation.result.run.safety.invariantViolationCount).toBe(0);
  });

  it('GATE-A08: an unsafe POST form submit is REJECTED_UNSAFE before clicking and nothing is posted', () => {
    const page = onlyPage(postForm);
    const statuses = interactionStatuses(page);
    expect(statuses).toContain('REJECTED_UNSAFE');
    expect(statuses).not.toContain('VERIFIED');
    expect(postForm.observations.some(({ pathname }) => pathname === PATHS.mutationEndpoint)).toBe(false);
    expectOnlyReadRequestsIn(postForm);
    expect(postForm.result.run.safety.invariantViolationCount).toBe(0);
  });

  it('GATE-A08 (control): without the Guard, the same button does send the POST that the fixture server counts', async () => {
    // サーバの側の確認が、POST を見つけられることを確かめる。Guard のない Context で、同じボタンを押す。
    const browser = await runLauncher.launcher({ headless: true });
    try {
      const { counters, observations } = await withFixtureServer(async (server) => {
        await withUnguardedPage(browser, DEFAULT_CONFIG.viewports.primaryDesktop, async (page) => {
          await page.goto(`${server.origin}${PATHS.mutationButton}`);
          const posted = page.waitForResponse((response) => new URL(response.url()).pathname === PATHS.mutationEndpoint);
          await page.getByRole('button', { name: 'Attempt mutation' }).click();
          await posted;
        });
      });
      expect(counters.post).toBe(1);
      expect(observations).toContainEqual(expect.objectContaining({ method: 'POST', pathname: PATHS.mutationEndpoint }));
    } finally {
      await browser.close();
    }
  });

  it('GATE-A09: the page limit makes the Run PARTIAL with MAX_PAGES_REACHED (the same site without the limit is COMPLETE)', async () => {
    expect(pageLimit.result.run.runStatus).toBe('PARTIAL');
    expect(pageLimit.result.run.incompleteReasons).toContainEqual({ code: 'MAX_PAGES_REACHED', detail: null });
    expect(pageLimit.result.run.crawlLimits.maxPagesReached).toBe(true);
    expect(pageLimit.result.pages.filter((page) => page.status !== 'SKIPPED')).toHaveLength(2);
    expect(pageLimit.result.pages.filter((page) => page.status === 'SKIPPED').length).toBeGreaterThan(0);
    expectOnlyReadRequestsIn(pageLimit);
    await expectSchemaValid(pageLimit.result);
    // 対照: 同じサイトを既定の上限でたどった Run（HUB）は、上限に達せず、MAX_PAGES_REACHED もない。
    expect(hub.result.run.crawlLimits).toEqual({ maxPagesReached: false, maxDepthReached: false, maxRuntimeReached: false });
    expect(hub.result.run.incompleteReasons.map(({ code }) => code)).not.toContain('MAX_PAGES_REACHED');
    expect(hub.result.run.runStatus).toBe('COMPLETE');
  });

  describe('GATE-A10: a Run with an artifact that does not match its schema is not COMPLETE', () => {
    let directory: string;

    beforeAll(async () => {
      directory = await workDirectory('schema');
    });

    it('GATE-A10: finishAuditRun derives PARTIAL with REQUIRED_ARTIFACT_INVALID and exits with 2', async () => {
      const [firstPage] = auditRun().pages;
      if (firstPage === undefined) {
        throw new Error('the fixture has no page');
      }
      // page のスキーマにない項目を加えた Run。渡す時点の Run Status と、その入力は、COMPLETE のまま。
      const invalid = auditRun({ pages: [{ ...firstPage, unexpectedField: true } as PageAuditResult] });
      expect(invalid.run.runStatus).toBe('COMPLETE');
      expect(deriveRunStatus(invalid.statusInput)).toBe('COMPLETE');
      const outputDirectory = join(directory, 'invalid');

      const exitCode = await finishAuditRun(invalid, outputDirectory, captureCliOutput().output);

      expect(exitCode).toBe(EXIT_CODES.PARTIAL);
      const run = (await readJson(join(runArtifactDirectory(outputDirectory, invalid.run.runId), RUN_ARTIFACT_FILE_NAMES.run))) as RunSummary;
      expect(run.runStatus).toBe('PARTIAL');
      expect(run.runStatus).not.toBe('COMPLETE');
      expect(run.incompleteReasons).toContainEqual({
        code: 'REQUIRED_ARTIFACT_INVALID',
        detail: expect.stringMatching(/^page:PAGE-000001:/u),
      });
    });

    it('GATE-A10 (control): the same Run without the extra field stays COMPLETE and exits with 0', async () => {
      const valid = auditRun();
      const outputDirectory = join(directory, 'valid');

      const exitCode = await finishAuditRun(valid, outputDirectory, captureCliOutput().output);

      expect(exitCode).toBe(EXIT_CODES.COMPLETE);
      const run = (await readJson(join(runArtifactDirectory(outputDirectory, valid.run.runId), RUN_ARTIFACT_FILE_NAMES.run))) as RunSummary;
      expect(run.runStatus).toBe('COMPLETE');
      expect(run.incompleteReasons).toEqual([]);
    });
  });
});

describe('Auditor Gates: ERROR Findings do not decide the Run Status (completion meaning, Task 18 design 4.3)', () => {
  it('the crawl Run with HTTP_4XX and BROKEN_INTERNAL_LINK ERROR Findings is COMPLETE, with no incomplete reason', async () => {
    const codes = hub.result.findings.filter((finding) => finding.severity === 'ERROR').map(({ ruleId }) => ruleId);
    expect(codes).toContain('HTTP_4XX');
    expect(codes).toContain('BROKEN_INTERNAL_LINK');
    expect(hub.result.run.runStatus).toBe('COMPLETE');
    expect(hub.result.run.incompleteReasons).toEqual([]);
    expectOnlyReadRequestsIn(hub);
    await expectSchemaValid(hub.result);
  });

  it('the CLI Run with PAGE_ERROR and IMAGE_LOAD_FAILED ERROR Findings is COMPLETE and exits with 0', async () => {
    const codes = hub.result.findings.filter((finding) => finding.severity === 'ERROR').map(({ ruleId }) => ruleId);
    expect(codes).toContain('PAGE_ERROR');
    expect(codes).toContain('IMAGE_LOAD_FAILED');
    expect(hub.result.run.runStatus).toBe('COMPLETE');
    expect(hub.result.run.incompleteReasons).toEqual([]);
    expect(hub.exitCode, hub.stderr).toBe(EXIT_CODES.COMPLETE);
    expectOnlyReadRequestsIn(hub);
    await expectSchemaValid(hub.result);
  });

  it('leaves no Chromium running after the Runs', () => {
    expect(runLauncher.browsers.length).toBeGreaterThanOrEqual(GATE_RUN_COUNT);
    expect(runLauncher.browsers.every((browser) => !browser.isConnected())).toBe(true);
  });
});
