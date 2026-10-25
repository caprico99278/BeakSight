// BN-c・BN-d（設計書 `doc/design/2026-10-23-beaksight-bundle-beaksight-block-noise-design.md` 5 章の受け入れ条件 1・2。指示書の 3 で読み替えた場面）:
// 127.0.0.1 の自前のサイトを Run Coordinator で実際の Chromium（テストの既定の headless）で監査し、書き出した Run から表示用モデルとバンドルを作る。
// - 読み込みの最中に BeakSight が止めた script（1 画面の要求の上限）: その SCRIPT_LOAD_FAILED は `CAUSED`。敏感な Rule（MISSING_TITLE）は `POSSIBLE`、
//   敏感でない Rule（HTTP_4XX）は `NONE`。
// - 閉じる途中に要求を出す画面: 閉じる途中の遮断（`blockedClosingRequests`・時点 `CLOSING`）は `POSSIBLE` の元にしない（MISSING_TITLE は `NONE`）。
// - 遮断のない画面: すべて `NONE`。
// - バンドルの本体（findings.json）に、`CAUSED`・`POSSIBLE`・SAFETY の指摘が入らない。外した指摘は beaksight-related-findings.json に理由つきで残る。
// サイトへの負荷: 3 ページ（と入口）。上限の画面は、1 画面の要求の上限（1000）を超えるため、1 つの読み込みで約 1000 の同期の XHR を出す（127.0.0.1 の自前のサーバだけ）。
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { artifactFilePath } from '../../src/core/artifact-layout.js';
import type { AuditRunResult, EvidenceRecordFor, Finding } from '../../src/core/contracts.js';
import { PAGE_SUBRESOURCE_REQUEST_LIMIT } from '../../src/safety/passive-request-guard.js';
import { ArtifactWriter, type ArtifactWriteResult } from '../../src/report/artifact-writer.js';
import { beaksightBlockRelationOf, indexBeakSightBlocks } from '../../src/report/beaksight-block-relation.js';
import { createChatGptBundle } from '../../src/report/chatgpt-bundle.js';
import { buildReportViewModel, type FindingView, type ReportViewModel } from '../../src/report/view-model.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { createRunLauncher, runWithCoordinator } from '../helpers/run-harness.js';
import { createTestConfig } from '../helpers/test-config.js';

const RUN_TEST_TIMEOUT_MS = 300_000;
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;

const INDEX_PATH = '/bn-c/index.html';
const LIMITED_PATH = '/bn-c/limited.html';
const CLOSING_PATH = '/bn-c/closing.html';
const CLEAN_PATH = '/bn-c/clean.html';
const ANALYTICS_PATH = '/bn-c/analytics.html';
const NAVAWAY_PATH = '/bn-c/navaway.html';
const NAVLATE_PATH = '/bn-c/navlate.html';
/** 測った後に移動するまでの時間（ms。BN-R1 の確かめ直しの `/admin/navlate-1500` と同じ）。 */
const NAVLATE_DELAY_MS = 1_500;
const MISSING_IMAGE_PATH = '/bn-c/img/missing.png';
const DATA_PATH = '/bn-c/data';
const LATE_SCRIPT_PATH = '/bn-c/late.js';
/** 上限を確実に超える同期の XHR の数（超えた分は BeakSight が止める）。 */
const SYNC_REQUEST_COUNT = PAGE_SUBRESOURCE_REQUEST_LIMIT + 5;

const INDEX_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>入口</title></head>
<body><main><h1>入口</h1><a href="${LIMITED_PATH}">上限</a> <a href="${CLOSING_PATH}">閉じる</a> <a href="${CLEAN_PATH}">遮断なし</a> <a href="${ANALYTICS_PATH}">計測</a> <a href="${NAVAWAY_PATH}">離れる</a> <a href="${NAVLATE_PATH}">遅い移動</a></main></body></html>`;

/** 1 画面の要求の上限を同期の XHR で超え、その後に script を読み込む（その script を BeakSight が止める）。題がない（MISSING_TITLE）。404 で返す（HTTP_4XX）。 */
const LIMITED_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"></head>
<body><main><h1>上限</h1></main><script>
for (let i = 0; i < ${SYNC_REQUEST_COUNT}; i += 1) {
  try { const x = new XMLHttpRequest(); x.open('GET', '${DATA_PATH}?i=' + i, false); x.send(); } catch (error) { /* 上限の後は止められる */ }
}
// 先読み（preload scanner）が上限の前に読まないよう、XHR の後に script の要素を足す。
const late = document.createElement('script');
late.src = '${LATE_SCRIPT_PATH}';
document.body.appendChild(late);
</script></body></html>`;

/** 閉じるときに要求を出す画面（BN-a の結合テストと同じ形）。題がない（MISSING_TITLE）。 */
const CLOSING_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"></head>
<body><main><h1>閉じる</h1></main><script>
let n = 0;
setInterval(() => { fetch('/bn-c/close-poll?i=' + (n += 1), { keepalive: true }).catch(() => 0); }, 100);
addEventListener('pagehide', () => {
  fetch('/bn-c/close-delete', { method: 'DELETE', keepalive: true }).catch(() => 0);
  for (let i = 0; i < 20; i += 1) fetch('/bn-c/close-hide?i=' + i, { keepalive: true }).catch(() => 0);
});
</script></body></html>`;

/** 遮断のない画面。題がない（MISSING_TITLE）。 */
const CLEAN_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"></head>
<body><main><h1>遮断なし</h1><p>本文です。</p></main></body></html>`;

/**
 * BN-R1 の M-3: 計測の POST（READ_ONLY では BeakSight が止める。データの遮断）と、404 の画像と、題の欠けの画面。欠けの指摘と例外は `POSSIBLE`、表示された要素の欠陥
 * （画像の失敗・axe）は `NONE`。
 */
const ANALYTICS_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"></head>
<body><main><h1>計測</h1><img alt="a" src="${MISSING_IMAGE_PATH}"></main><script>
fetch('/bn-c/collect', { method: 'POST', body: 'e=view', keepalive: true }).catch(() => 0);
</script></body></html>`;

/**
 * BN-R1 の I-1: 読み込みの後に、ページが自分で許可 Origin の外へ移動する画面（Guard が main frame の移動を止め、BeakSight は止めた後のエラーの画面を測る）。
 * 行き先は名前の解決できない `.invalid` で、Guard が送る前に止める（どこにも接続しない）。
 */
const NAVAWAY_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>離れる</title></head>
<body><main><h1>離れる</h1><p>本文です。</p></main><script>setTimeout(() => { location.href = 'https://beaksight-bn-r1.invalid/away'; }, 300);</script></body></html>`;

/**
 * BN-R1 の N-1: 題はあり lang がない画面で、測った後（1.5 秒後）にページが自分で許可 Origin の外へ移動する（Guard が止める）。DOM の Evidence は元の画面を測るので、
 * lang の欠けは本当の欠陥で、遮断が原因にしない。行き先は名前の解決できない `.invalid` で、Guard が送る前に止める。
 */
const NAVLATE_HTML = `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>遅い移動</title></head>
<body><main><h1>遅い移動</h1><p>本文です。</p></main><script>setTimeout(() => { location.href = 'https://beaksight-bn-r1.invalid/late'; }, ${NAVLATE_DELAY_MS});</script></body></html>`;

const HTML_PAGES: Readonly<Record<string, readonly [number, string]>> = Object.freeze({
  [NAVLATE_PATH]: [HTTP_OK, NAVLATE_HTML],
  [INDEX_PATH]: [HTTP_OK, INDEX_HTML],
  [LIMITED_PATH]: [HTTP_NOT_FOUND, LIMITED_HTML],
  [CLOSING_PATH]: [HTTP_OK, CLOSING_HTML],
  [CLEAN_PATH]: [HTTP_OK, CLEAN_HTML],
  [ANALYTICS_PATH]: [HTTP_OK, ANALYTICS_HTML],
  [NAVAWAY_PATH]: [HTTP_OK, NAVAWAY_HTML],
});

let app: LoopbackHttpServer;
let outputDirectory: string;
const runLauncher = createRunLauncher();
let written: ArtifactWriteResult;
let model: ReportViewModel;
let bundle: Readonly<Record<string, Uint8Array>>;

beforeAll(async () => {
  app = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
    request.on('data', () => undefined);
    request.on('end', () => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      const html = HTML_PAGES[path];
      if (html !== undefined) {
        response.writeHead(html[0], { 'content-type': 'text/html; charset=utf-8' }).end(html[1]);
      } else if (path === MISSING_IMAGE_PATH) {
        response.writeHead(HTTP_NOT_FOUND, { 'content-type': 'text/plain' }).end('not found');
      } else if (path === LATE_SCRIPT_PATH) {
        response.writeHead(HTTP_OK, { 'content-type': 'text/javascript' }).end('window.lateLoaded = true;');
      } else if (path.startsWith('/bn-c/')) {
        response.writeHead(HTTP_OK, { 'content-type': 'application/json' }).end('{}');
      } else {
        response.writeHead(HTTP_NOT_FOUND, { 'content-type': 'text/plain' }).end('not found');
      }
    });
  });
  outputDirectory = await mkdtemp(join(tmpdir(), 'beaksight-bn-cd-'));
  const result: AuditRunResult = await runWithCoordinator({
    config: createTestConfig(app.origin, INDEX_PATH, { viewports: { stressWidths: [] } }),
    launchBrowser: runLauncher.launcher,
    outputDirectory,
  });
  written = await new ArtifactWriter().writeRun(result, { outputDirectory });
  model = buildReportViewModel(written.result);
  const zip = await createChatGptBundle(model, written.result, async (relativePath) => {
    try {
      return new Uint8Array(await readFile(artifactFilePath(written.runDirectory, relativePath)));
    } catch {
      return null;
    }
  });
  bundle = unzipSync(zip);
}, RUN_TEST_TIMEOUT_MS);

afterAll(async () => {
  await runLauncher.closeAll();
  await app?.close();
  if (outputDirectory !== undefined) {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

/** ページの URL の path が `path` の Finding（Rule の別）。 */
const findingsOf = (path: string, ruleId: string): readonly FindingView[] =>
  model.findings.filter(({ finding }) => finding.pageUrl !== null && new URL(finding.pageUrl).pathname === path && finding.ruleId === ruleId);

const relationsOf = (views: readonly FindingView[]): readonly (string | null)[] => views.map((view) => view.beaksightBlockRelation?.relation ?? null);

const jsonOf = (path: string): unknown => JSON.parse(new TextDecoder().decode(bundle[path] ?? new Uint8Array())) as unknown;

describe('BN-c・BN-d: the relation of the Findings to the BeakSight blocks on the fixture site', () => {
  it('makes the SCRIPT_LOAD_FAILED of the script that BeakSight blocked while loading (the request limit) CAUSED', () => {
    const scriptFailures = findingsOf(LIMITED_PATH, 'SCRIPT_LOAD_FAILED');
    expect(scriptFailures.length).toBeGreaterThan(0);
    expect(relationsOf(scriptFailures).every((relation) => relation === 'CAUSED'), JSON.stringify(relationsOf(scriptFailures))).toBe(true);
    for (const view of scriptFailures) {
      expect(view.beaksightBlockRelation?.reason).toBe('TARGET_REQUEST_BLOCKED');
      expect(view.beaksightBlockRelation?.blocks.some((block) => block.requestKind === 'SCRIPT' && block.url?.includes(LATE_SCRIPT_PATH) === true)).toBe(true);
    }
  });

  it('makes a sensitive Rule POSSIBLE and a Rule that a block cannot change NONE on the page with the blocks while loading', () => {
    const titles = findingsOf(LIMITED_PATH, 'MISSING_TITLE');
    expect(titles.length).toBeGreaterThan(0);
    expect(relationsOf(titles).every((relation) => relation === 'POSSIBLE'), JSON.stringify(relationsOf(titles))).toBe(true);
    const statuses = findingsOf(LIMITED_PATH, 'HTTP_4XX');
    expect(statuses.length).toBeGreaterThan(0);
    expect(relationsOf(statuses).every((relation) => relation === 'NONE'), JSON.stringify(relationsOf(statuses))).toBe(true);
  });

  it('does not use the blocks while closing for POSSIBLE, and makes every site quality Finding of the page without blocks NONE', () => {
    const closing = model.findings.filter(({ finding }) => finding.pageUrl !== null && new URL(finding.pageUrl).pathname === CLOSING_PATH);
    const clean = model.findings.filter(({ finding }) => finding.pageUrl !== null && new URL(finding.pageUrl).pathname === CLEAN_PATH);
    expect(findingsOf(CLOSING_PATH, 'MISSING_TITLE').length).toBeGreaterThan(0);
    expect(findingsOf(CLEAN_PATH, 'MISSING_TITLE').length).toBeGreaterThan(0);
    // 閉じる途中の遮断があっても（ブラウザの内部の順に左右される）、結び付く読み込みの遮断はない（`NO_BLOCK_IN_LOAD`）。
    for (const view of [...findingsOf(CLOSING_PATH, 'MISSING_TITLE'), ...findingsOf(CLEAN_PATH, 'MISSING_TITLE')]) {
      expect(view.beaksightBlockRelation?.reason).toBe('NO_BLOCK_IN_LOAD');
    }
    for (const view of [...closing, ...clean]) {
      if (view.beaksightBlockRelation !== null) {
        expect(view.beaksightBlockRelation.relation, `${view.finding.ruleId} ${view.finding.pageUrl ?? ''}`).toBe('NONE');
      }
    }
  });

  // BN-R1 の M-3 と設計者の判断: READ_ONLY で計測の POST を止めた画面でも、欠けの指摘（題の欠け。axe の題の欠けも同じ）は影響の可能性、サーバが返した応答の事実
  // （404 の画像の RESOURCE_4XX）と表示された要素の欠陥（画像の失敗）は本体に残る。
  it('splits the missing title, the 404 image and its 4xx response of the page whose analytics POST was blocked (READ_ONLY) as the table says', () => {
    for (const ruleId of ['MISSING_TITLE', 'A11Y_DOCUMENT_TITLE']) {
      const views = findingsOf(ANALYTICS_PATH, ruleId);
      expect(views.length, ruleId).toBeGreaterThan(0);
      expect(relationsOf(views).every((relation) => relation === 'POSSIBLE'), `${ruleId} ${JSON.stringify(relationsOf(views))}`).toBe(true);
    }
    for (const ruleId of ['RESOURCE_4XX', 'IMAGE_LOAD_FAILED']) {
      const views = findingsOf(ANALYTICS_PATH, ruleId);
      expect(views.length, ruleId).toBeGreaterThan(0);
      expect(relationsOf(views).every((relation) => relation === 'NONE'), `${ruleId} ${JSON.stringify(relationsOf(views))}`).toBe(true);
    }
  });

  // BN-R1 の I-1: 止めた main frame の移動の後に測ったエラーの画面の指摘は、遮断が原因。
  // BN-R1 の N-1: エラーの画面を測ったと記録から分かる Evidence（パフォーマンスの Evidence の navigation timing の URL が止めた移動の行き先で、その後に記録した
  // Evidence）の指摘だけを遮断が原因にし、分からない Evidence（DOM・axe はパフォーマンスより先に記録する）の指摘は影響の可能性にとどめる。
  it('makes the Findings of the error page after a blocked main frame navigation CAUSED only when the records show the error page, and POSSIBLE otherwise', () => {
    const navaway = written.result.pages.find((value) => new URL(value.pageUrl).pathname === NAVAWAY_PATH);
    expect(navaway, 'the page that navigates away').toBeDefined();
    const performances = (navaway?.evidence ?? []).filter((record): record is EvidenceRecordFor<'performance'> => record.type === 'performance');
    const blockedUrls = (navaway?.evidence ?? []).flatMap((record) =>
      (record.type === 'safety' ? record.payload.blockedNavigations.filter((event) => event.phase === 'LOAD').map((event) => event.url) : []));
    // 記録の手がかり: パフォーマンスの Evidence が測った文書の URL が、止めた移動の行き先（エラーの画面）。
    const errorPagePerformances = performances.filter((record) => blockedUrls.includes(record.payload.navigationTiming?.url ?? ''));
    expect(errorPagePerformances.length, JSON.stringify(performances.map((record) => record.payload.navigationTiming?.url))).toBeGreaterThan(0);
    const since = new Map(errorPagePerformances.map((record) => [record.viewport, record.observedAt] as const));
    const observedAtOf = new Map((navaway?.evidence ?? []).map((record) => [record.evidenceId, record] as const));

    const measured = model.findings.filter(({ finding, beaksightBlockRelation }) =>
      finding.pageUrl !== null && new URL(finding.pageUrl).pathname === NAVAWAY_PATH && beaksightBlockRelation !== null && finding.ruleId !== 'HTTP_4XX');
    expect(measured.length, 'the error page has Findings').toBeGreaterThan(0);
    for (const view of measured) {
      const afterErrorPage = view.finding.evidenceRefs.some((evidenceId) => {
        const record = observedAtOf.get(evidenceId);
        const start = record === undefined ? undefined : since.get(record.viewport);
        return record !== undefined && start !== undefined && record.observedAt >= start;
      });
      expect(view.beaksightBlockRelation, view.finding.ruleId).toMatchObject(afterErrorPage
        ? { relation: 'CAUSED', reason: 'MAIN_FRAME_NAVIGATION_BLOCKED' }
        : { relation: 'POSSIBLE', reason: 'MAIN_FRAME_NAVIGATION_BLOCKED_UNCONFIRMED' });
    }
    // 本当の記録で、エラーの画面を測ったパフォーマンスの Evidence を参照する指摘は、遮断が原因になる。
    const [errorPagePerformance] = errorPagePerformances;
    if (errorPagePerformance !== undefined && navaway !== undefined) {
      const probe: Finding = { ...(measured[0]?.finding as Finding), ruleId: 'POOR_LCP', viewport: errorPagePerformance.viewport, evidenceRefs: [errorPagePerformance.evidenceId] };
      expect(beaksightBlockRelationOf(indexBeakSightBlocks(written.result), probe)).toMatchObject({ relation: 'CAUSED', reason: 'MAIN_FRAME_NAVIGATION_BLOCKED' });
    }
  });

  // BN-R1 の N-1: 測った後に移動する画面の、元の画面の本当の欠陥（lang の欠け）は、遮断が原因にしない。
  it('does not make the real defect of the page measured before its late navigation CAUSED', () => {
    const langs = findingsOf(NAVLATE_PATH, 'MISSING_HTML_LANG');
    expect(langs.length).toBeGreaterThan(0);
    expect(relationsOf(langs).some((relation) => relation === 'CAUSED'), JSON.stringify(langs.map((view) => view.beaksightBlockRelation))).toBe(false);
  });

  it('keeps the CAUSED, POSSIBLE and SAFETY Findings out of findings.json, and puts them in the related file with their relation', () => {
    const body = jsonOf('findings.json') as readonly { readonly finding: Finding }[];
    const related = jsonOf('beaksight-related-findings.json') as readonly { readonly finding: Finding; readonly beaksightBlockRelation: { readonly relation: string } | null }[];
    const excludedIds = new Set(model.excludedFindings.map((view) => view.finding.findingId));
    expect(model.excludedFindings.some((view) => view.beaksightBlockRelation?.relation === 'CAUSED')).toBe(true);
    expect(model.excludedFindings.some((view) => view.beaksightBlockRelation?.relation === 'POSSIBLE')).toBe(true);
    expect(body.some((entry) => excludedIds.has(entry.finding.findingId))).toBe(false);
    expect(body.some((entry) => entry.finding.severity === 'SAFETY')).toBe(false);
    expect(body.map((entry) => entry.finding.findingId)).toEqual(model.mainFindings.map((view) => view.finding.findingId));
    expect(related.map((entry) => entry.finding.findingId)).toEqual([...excludedIds]);
    for (const entry of related) {
      expect(entry.beaksightBlockRelation === null ? entry.finding.severity : entry.beaksightBlockRelation.relation).not.toBe('NONE');
    }
  });

  it('writes the same counts in the README and summary.json as the relations', () => {
    const summary = jsonOf('summary.json') as { readonly beaksightBlockRelation: { readonly mainFindingCounts: { readonly total: number } } };
    expect(summary.beaksightBlockRelation.mainFindingCounts.total).toBe(model.mainFindings.length);
    const readme = new TextDecoder().decode(bundle['README.md'] ?? new Uint8Array());
    expect(readme).toContain(`: ${String(model.mainFindings.length)}件`);
  });
});
