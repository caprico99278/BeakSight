// BN-c・BN-d（設計書 `doc/design/2026-10-23-beaksight-bundle-beaksight-block-noise-design.md` 5 章の受け入れ条件 1・2。指示書の 3 で読み替えた場面）:
// 127.0.0.1 の自前のサイトを Run Coordinator で実際の Chromium（テストの既定の headless）で監査し、書き出した Run から表示用モデルとバンドルを作る。
// - 読み込みの最中に BeakSight が止めた POST（READ_ONLY。データの遮断）の画面: 敏感な Rule（MISSING_TITLE）は `POSSIBLE`、敏感でない Rule（HTTP_4XX）は `NONE`。
// - 止めた main frame の移動でエラーの画面に替わる画面: DEF-250 の案 c で、そのビューポートをその場で終える（`DOCUMENT_LEFT_DURING_AUDIT`）。エラーの画面は
//   測らないので、その Evidence と指摘はない。FIN-1（SD-2 の 2.4）: その移動は止めない（許可 Origin の外の .invalid の宛先なので、移った先は誤りの画面になる）。
// L10（INV-LIMITS の S5 の撤廃）で、読み込みの最中に BeakSight が script を止める場面（前は 1 画面の要求の上限 1000 を超えた後の script。その SCRIPT_LOAD_FAILED を
// `CAUSED` にした）は作れなくなったので外した。監査の段で読み取りを止める決まりを新しく置くことは「サイトの通信は止めない」の方針に反するので置かない（設計者の判断 (a)）。
// 案 c の後は、この画面の組で `CAUSED` になる指摘はない。`CAUSED` の判定は単体の `beaksight-block-relation.test.ts` が確かめる。`POSSIBLE` は READ_ONLY で止めた
// POST の遮断で確かめる。
// - 閉じる途中に要求を出す画面: 閉じる途中の遮断（`blockedClosingRequests`・時点 `CLOSING`）は `POSSIBLE` の元にしない（MISSING_TITLE は `NONE`）。
// - 遮断のない画面: すべて `NONE`。
// - バンドルの本体（指摘のファイルの `main`）に、`CAUSED`・`POSSIBLE`・SAFETY の指摘が入らない。外した指摘は `excluded` に理由つきで残る（REC-4）。
// - BN-a（もと beaksight-block-records。SAFE-B2 でまとめた）: 同じ Run の page.json に、読み込みの最中に止めた要求の時点（`LOAD`）・種類（`resourceType`）・
//   読み込みの印（`PAGE_AUDIT`）、network の失敗の BeakSight の遮断の印が残る。閉じる途中の遮断は止めた要求の一覧と数・SAFETY の指摘に入れない。読み取りで
//   ない要求はサーバに届かない。
// サイトへの負荷: 6 ページ（と入口）。どの画面も、読み込みで出す要求は数個（127.0.0.1 の自前のサーバだけ）。
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { artifactFilePath } from '../../src/core/artifact-layout.js';
import type { AuditRunResult, Finding } from '../../src/core/contracts.js';
import type { NetworkEvidence, SafetyEventsEvidence } from '../../src/core/evidence-types.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { ArtifactWriter, type ArtifactWriteResult } from '../../src/report/artifact-writer.js';
import { createChatGptBundle } from '../../src/report/chatgpt-bundle.js';
import { buildReportViewModel, type FindingView, type ReportViewModel } from '../../src/report/view-model.js';
import { bundledFindingsOf } from '../helpers/bundle-findings.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { createRunLauncher, runWithCoordinator } from '../helpers/run-harness.js';
import { createTestConfig } from '../helpers/test-config.js';

const RUN_TEST_TIMEOUT_MS = 300_000;
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;

const INDEX_PATH = '/bn-c/index.html';
const POSTED_PATH = '/bn-c/posted.html';
const CLOSING_PATH = '/bn-c/closing.html';
const CLEAN_PATH = '/bn-c/clean.html';
const ANALYTICS_PATH = '/bn-c/analytics.html';
const NAVAWAY_PATH = '/bn-c/navaway.html';
const NAVLATE_PATH = '/bn-c/navlate.html';
/** 測った後に移動するまでの時間（ms。BN-R1 の確かめ直しの `/admin/navlate-1500` と同じ）。 */
const NAVLATE_DELAY_MS = 1_500;
const MISSING_IMAGE_PATH = '/bn-c/img/missing.png';

const INDEX_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>入口</title></head>
<body><main><h1>入口</h1><a href="${POSTED_PATH}">送信</a> <a href="${CLOSING_PATH}">閉じる</a> <a href="${CLEAN_PATH}">遮断なし</a> <a href="${ANALYTICS_PATH}">計測</a> <a href="${NAVAWAY_PATH}">離れる</a> <a href="${NAVLATE_PATH}">遅い移動</a></main></body></html>`;

/**
 * 読み込みの最中にデータを POST する画面（READ_ONLY では BeakSight が止める。データの遮断）。題がない（MISSING_TITLE）。404 で返す（HTTP_4XX。サーバが返した応答の
 * 事実で、遮断では変わらない）。
 */
const POSTED_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"></head>
<body><main><h1>送信</h1></main><script>
fetch('/bn-c/save', { method: 'POST', body: 'state=1' }).catch(() => 0);
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
 * BN-R1 の I-1: 読み込みの後に、ページが自分で許可 Origin の外へ移動する画面（Guard が main frame の移動を止め、BeakSight はエラーの画面に替わったビューポートを測らずに終える。DEF-250 の案 c）。
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
  [POSTED_PATH]: [HTTP_NOT_FOUND, POSTED_HTML],
  [CLOSING_PATH]: [HTTP_OK, CLOSING_HTML],
  [CLEAN_PATH]: [HTTP_OK, CLEAN_HTML],
  [ANALYTICS_PATH]: [HTTP_OK, ANALYTICS_HTML],
  [NAVAWAY_PATH]: [HTTP_OK, NAVAWAY_HTML],
});

/** BN-a: Guard が正規化した、ページの fetch の要求の種類（keepalive の fetch を、Chromium は `xhr` として渡すことがある）。 */
const FETCH_RESOURCE_TYPES: readonly string[] = ['fetch', 'xhr'];

let app: LoopbackHttpServer;
/** サーバに届いた、読み取りでない要求（`<method> <path>`。READ_ONLY の Run では空）。 */
const nonReadArrivals: string[] = [];
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
      if (!READ_METHODS.has(request.method ?? '')) {
        nonReadArrivals.push(`${request.method ?? ''} ${path}`);
      }
      const html = HTML_PAGES[path];
      if (html !== undefined) {
        response.writeHead(html[0], { 'content-type': 'text/html; charset=utf-8' }).end(html[1]);
      } else if (path === MISSING_IMAGE_PATH) {
        response.writeHead(HTTP_NOT_FOUND, { 'content-type': 'text/plain' }).end('not found');
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
  // L10（S5 の撤廃）: 前の「止めた script の SCRIPT_LOAD_FAILED を CAUSED にする」場面は外した（ファイルの頭の注記）。CAUSED の判定は単体で確かめる。
  it('makes a sensitive Rule POSSIBLE and a Rule that a block cannot change NONE on the page whose POST was blocked while loading (READ_ONLY)', () => {
    const titles = findingsOf(POSTED_PATH, 'MISSING_TITLE');
    expect(titles.length).toBeGreaterThan(0);
    expect(relationsOf(titles).every((relation) => relation === 'POSSIBLE'), JSON.stringify(relationsOf(titles))).toBe(true);
    const statuses = findingsOf(POSTED_PATH, 'HTTP_4XX');
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

  // DEF-250 の案 c: main frame の移動でエラーの画面に替わったら、そのビューポートをその場で終える（`DOCUMENT_LEFT_DURING_AUDIT`）。エラーの画面は測らないので、
  // その Evidence と指摘はない。FIN-1（SD-2）: 移動は止めないので、止めた記録は残らない。
  it('ends the viewport when the page own main frame navigation replaces the page, without measuring the error page, and records no stop of it', () => {
    const navaway = written.result.pages.find((value) => new URL(value.pageUrl).pathname === NAVAWAY_PATH);
    expect(navaway, 'the page that navigates away').toBeDefined();
    const evidence = navaway?.evidence ?? [];
    for (const viewport of ['desktop', 'mobile'] as const) {
      expect(navaway?.viewports[viewport].incompleteReasons.map(({ code }) => code), viewport).toContain('DOCUMENT_LEFT_DURING_AUDIT');
      // FIN-1（SD-2 の 2.4）: ページ自身の main frame の移動は、許可 Origin の外でも止めない（止めた記録は残らない）。
      const blocked = evidence.flatMap((record) => (record.type === 'safety' && record.viewport === viewport
        ? record.payload.blockedNavigations.map((event) => new URL(event.url).hostname)
        : []));
      expect(blocked, viewport).not.toContain('beaksight-bn-r1.invalid');
    }
    // 止めた移動の後は、その画面を測らない（パフォーマンスも DOM も測らない）。エラーの画面の Evidence はない。
    const measuredTypes = new Set(['performance', 'dom', 'accessibility', 'layout']);
    expect(evidence.filter((record) => measuredTypes.has(record.type)).map((record) => `${record.viewport ?? ''}:${record.type}`)).toEqual([]);
    // エラーの画面の指摘（止めた移動が原因の指摘）はない。
    const navawayFindings = model.findings.filter(({ finding }) => finding.pageUrl !== null && new URL(finding.pageUrl).pathname === NAVAWAY_PATH);
    expect(navawayFindings.filter((view) => view.beaksightBlockRelation?.reason === 'MAIN_FRAME_NAVIGATION_BLOCKED'
      || view.beaksightBlockRelation?.reason === 'MAIN_FRAME_NAVIGATION_BLOCKED_UNCONFIRMED').map((view) => view.finding.ruleId)).toEqual([]);
  });

  // BN-R1 の N-1: 測った後に移動する画面の、元の画面の本当の欠陥（lang の欠け）は、遮断が原因にしない。
  it('does not make the real defect of the page measured before its late navigation CAUSED', () => {
    const langs = findingsOf(NAVLATE_PATH, 'MISSING_HTML_LANG');
    expect(langs.length).toBeGreaterThan(0);
    expect(relationsOf(langs).some((relation) => relation === 'CAUSED'), JSON.stringify(langs.map((view) => view.beaksightBlockRelation))).toBe(false);
  });

  // REC-4: 指摘はページごとの指摘のファイルにある（本体は `main`、外した指摘は `excluded`）。
  it('keeps the CAUSED, POSSIBLE and SAFETY Findings out of main, and puts them in excluded with their relation', () => {
    const body = bundledFindingsOf<{ readonly finding: Finding }>(bundle, 'main');
    const related = bundledFindingsOf<{ readonly finding: Finding; readonly beaksightBlockRelation: { readonly relation: string } | null }>(bundle, 'excluded');
    const excludedIds = new Set(model.excludedFindings.map((view) => view.finding.findingId));
    // この画面の組で `CAUSED` になる本当の指摘はない（ファイルの頭の注記。`CAUSED` の判定は単体の `beaksight-block-relation.test.ts` が確かめる）。ここでは、
    // `CAUSED`・`POSSIBLE` の指摘があれば、どれも本体から外れることを確かめる（`POSSIBLE` は必ずある）。
    for (const view of model.findings) {
      const relation = view.beaksightBlockRelation?.relation;
      if (relation === 'CAUSED' || relation === 'POSSIBLE') {
        expect(excludedIds.has(view.finding.findingId), `${view.finding.ruleId} ${relation}`).toBe(true);
      }
    }
    expect(model.excludedFindings.some((view) => view.beaksightBlockRelation?.relation === 'POSSIBLE')).toBe(true);
    expect(body.some((entry) => excludedIds.has(entry.finding.findingId))).toBe(false);
    expect(body.some((entry) => entry.finding.severity === 'SAFETY')).toBe(false);
    expect(body.map((entry) => entry.finding.findingId).sort()).toEqual(model.mainFindings.map((view) => view.finding.findingId).sort());
    expect(related.map((entry) => entry.finding.findingId).sort()).toEqual([...excludedIds].sort());
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

  // BN-a（設計書 3.1。もと beaksight-block-records）: 本物の Guard と PageAuditor が書いた page.json の、止めた記録の時点・種類・読み込みの印。記録の形の網羅は
  // 単体の `beaksight-block-marks.test.ts` が確かめる（この Run は READ_ONLY。SD-2 の後、PASS_EXCEPT_DELETE では離れるときの DELETE が届くことは
  // `guard-audit-send-revisit-close.test.ts` の P1-2 が確かめる）。
  it('BN-a: writes the block during the load with phase LOAD and its resource type, marks the network failures, and keeps the closing blocks apart', async () => {
    const pageOf = (path: string) => written.result.pages.find((value) => new URL(value.pageUrl).pathname === path);
    const posted = pageOf(POSTED_PATH);
    const closing = pageOf(CLOSING_PATH);
    expect(posted, 'the posted page').toBeDefined();
    expect(closing, 'the closing page').toBeDefined();
    for (const page of [posted, closing]) {
      const validation = await validateArtifact('page', page);
      expect(validation.ok ? [] : validation.errors).toEqual([]);
    }
    const pageAuditSafetyOf = (page: typeof posted, viewport: 'desktop' | 'mobile'): SafetyEventsEvidence | undefined => (page?.evidence ?? [])
      .flatMap((record) => (record.type === 'safety' && record.viewport === viewport ? [record.payload as SafetyEventsEvidence] : []))
      .find(({ load }) => load?.kind === 'PAGE_AUDIT');
    for (const viewport of ['desktop', 'mobile'] as const) {
      const postedSafety = pageAuditSafetyOf(posted, viewport);
      expect(postedSafety, viewport).toBeDefined();
      const blocked = (postedSafety?.blockedRequests ?? []).map(({ method, url, reason, resourceType, phase }) => ({ method, path: new URL(url).pathname, reason, resourceType, phase }));
      expect(blocked, viewport).toEqual([{ method: 'POST', path: '/bn-c/save', reason: 'NON_READ_METHOD', resourceType: expect.any(String), phase: 'LOAD' }]);
      expect(FETCH_RESOURCE_TYPES).toContain(blocked[0]?.resourceType);
      const network = (posted?.evidence ?? []).flatMap((record) => (record.type === 'network' && record.viewport === viewport ? [record.payload as NetworkEvidence] : []));
      const failures = network.flatMap(({ failures: rows }) => rows);
      expect(failures.map(({ url, resourceType, blockedByBeakSight, phase }) => ({ path: new URL(url).pathname, resourceType, blockedByBeakSight, phase })), viewport)
        .toEqual(expect.arrayContaining([{ path: '/bn-c/save', resourceType: 'fetch', blockedByBeakSight: true, phase: 'LOAD' }]));
      for (const failure of failures) {
        expect(typeof failure.blockedByBeakSight).toBe('boolean');
        expect(failure.phase).toBe('LOAD');
      }
      // 閉じる途中に止めた要求（ブラウザの内部の順に左右されるので、あれば）は、止めた要求の一覧と数には入れない。
      const closingSafety = pageAuditSafetyOf(closing, viewport);
      expect(closingSafety?.blockedRequests, viewport).toEqual([]);
      expect(closingSafety?.blockedRequestsByMethod, viewport).toEqual({});
      for (const event of closingSafety?.blockedClosingRequests?.events ?? []) {
        expect(event.phase).toBe('CLOSING');
      }
    }
    expect(closing?.findings.filter(({ category }) => category === 'SAFETY')).toEqual([]);
    // 止める決まりは変わらない（読み込みの最中の POST・計測の POST・閉じるときの DELETE は届かない）。
    expect(nonReadArrivals).toEqual([]);
  });
});
