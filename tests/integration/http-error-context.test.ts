// AUD-7・6b・6c（整理の文書 `doc/design/2026-11-09-beaksight-audit-precision-triage.md`）の結合のテスト（既定の Chromium。サーバは 127.0.0.1 だけ）。
// - AUD-7: 4xx・5xx の応答の文脈（本文の要旨・承認したサービスか）と、画面の誤りの表示を記録し、区分で Finding にするかを決める。
//   - 同じ 401 でも、資格のない要求の後に回復し、画面に誤りがない → EXPECTED_BRANCH（指摘にしない）。回復せず、画面に誤りの表示がある → SITE_FAILURE。
//   - 406 で、データなしの画面（誤りの表示なし。回復しない）→ UNDETERMINED、処理の失敗の画面 → SITE_FAILURE。
//   - 収集の側（承認したサービスの Origin の 401。DEF-206）→ COLLECTION_CAUSED。
//   - 誤りの本文の token のような値は、記録に残らない。
// - AUD-6b: リンクのリダイレクトの鎖と、未検証の理由が `links.json`（表示用モデルの `linkChecks`）に出る。
// - AUD-6c: 操作のない読み込みの INP は未観測。遅いデータの画面で、待ちと通信の時間が分かれる。
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { AuditConfig } from '../../src/config/types.js';
import type { AuditRunResult, PageAuditResult } from '../../src/core/contracts.js';
import type { NormalizedHttpUrlEvidence } from '../../src/core/evidence-types.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { normalizeUrl } from '../../src/crawl/normalize-url.js';
import { IdAllocator } from '../../src/orchestration/id-allocator.js';
import { PageAuditor } from '../../src/orchestration/page-auditor.js';
import { buildReportViewModel } from '../../src/report/view-model.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { auditRun } from '../helpers/audit-run-fixture.js';
import { testContextsOf, useHeadlessChromium } from '../helpers/chromium.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { createTestNavigationPacer } from '../helpers/navigation-pacer.js';
import { createTestConfig, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

const TEST_TIMEOUT_MS = 5 * 60_000;
const SECRET_VALUE = 'abcdef0123456789';
/** 遅いデータの画面: データの要求を始めるまでの待ちと、サーバが応答を返すまでの時間（LCP・FCP が poor の境界を超える長さ）。 */
const SLOW_START_MS = 1_500;
const SLOW_RESPONSE_MS = 3_000;

const html = (title: string, body: string): string => '<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,">'
  + `<title>${title}</title></head><body>${body}</body></html>`;

const script = (code: string): string => `<script>${code}</script>`;

const PAGES: Readonly<Record<string, string>> = {
  // 資格のない 401 の後に、同じ口が 200 を返し、画面は正常。
  '/recovered': html('recovered', '<main><h1>ようこそ</h1><p id="out">読み込み中</p></main>' + script(
    "fetch('/api/me?try=1').then(() => fetch('/api/me?try=2', { headers: { authorization: 'Bearer x' } }))"
    + ".then((r) => r.json()).then((v) => { document.getElementById('out').textContent = v.name; });",
  )),
  // 401 が回復せず、画面に誤りの表示（role=alert）。本文に token のような値。
  '/failed': html('failed', '<main><h1>会員</h1><div id="out"></div></main>' + script(
    "fetch('/api/session').then((r) => { if (!r.ok) { const box = document.getElementById('out'); box.setAttribute('role', 'alert');"
    + " box.textContent = '読み込みに失敗しました'; } });",
  )),
  // 406 で、データなしの画面（誤りの語がない）。
  '/no-data': html('no data', '<main><h1>一覧</h1><p id="out"></p></main>' + script(
    "fetch('/api/list').then(() => { document.getElementById('out').textContent = 'データはありません'; });",
  )),
  // 406 で、処理の失敗の画面（見出しに誤りの語）。
  '/process-failed': html('process failed', '<main><h1>一覧</h1><div id="out"></div></main>' + script(
    "fetch('/api/process').then(() => { const h = document.createElement('h2'); h.textContent = '処理に失敗しました'; document.getElementById('out').append(h); });",
  )),
  // 承認したサービスの Origin（このテストでは同じ Origin を承認したサービスとして渡す）の 401。
  '/service': html('service', '<main><h1>サービス</h1></main>' + script("fetch('/api/service');")),
  // リンク: リダイレクトする内部リンクと、読まない内部リンク。
  '/links': html('links', '<main><h1>リンク</h1><a href="/old">古い場所</a><a href="/unread">読まない所</a></main>'),
  '/target': html('target', '<main><h1>移った先</h1></main>'),
  // 遅いデータの画面: 遅い script（`/slow.js`）が届いてからデータの要求を始め、データが届いてから中身を描く（それまで何も描かない）。
  '/slow-data': '<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>slow</title></head><body>'
    + '<script src="/slow.js"></script></body></html>',
};

/** 遅い script の中身（データの要求を始め、届いたら描く）。 */
const SLOW_SCRIPT = "fetch('/api/slow').then((r) => r.json()).then((v) => { const h = document.createElement('h1'); h.textContent = v.title;"
  + " const p = document.createElement('p'); p.textContent = '本文'.repeat(200); document.body.append(h, p); });";

let browser: Browser;
let server: LoopbackHttpServer | undefined;

useHeadlessChromium((launched) => {
  browser = launched;
});

afterEach(async () => {
  const leftover = testContextsOf(browser);
  for (const context of leftover) {
    await context.close();
  }
  await server?.close();
  server = undefined;
  expect(leftover, 'Contexts left in the browser after the test').toHaveLength(0);
});

const startSite = async (): Promise<string> => {
  server = await startLoopbackHttpServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    const json = (status: number, value: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(value));
    };
    if (path === '/api/me') {
      if (request.headers.authorization === undefined) {
        json(401, { code: 'UNAUTHORIZED', message: 'login required' });
      } else {
        json(200, { name: '利用者' });
      }
      return;
    }
    if (path === '/api/session') {
      json(401, { message: 'ログインしてください', detail: `expired: access_token=${SECRET_VALUE}`, access_token: SECRET_VALUE });
      return;
    }
    if (path === '/api/list' || path === '/api/process') {
      json(406, { code: 'NOT_ACCEPTABLE' });
      return;
    }
    if (path === '/api/service') {
      json(401, { code: 'SERVICE_UNAUTHORIZED' });
      return;
    }
    if (path === '/api/slow') {
      setTimeout(() => json(200, { title: '遅いデータ' }), SLOW_RESPONSE_MS);
      return;
    }
    if (path === '/slow.js') {
      setTimeout(() => response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }).end(SLOW_SCRIPT), SLOW_START_MS);
      return;
    }
    if (path === '/old') {
      response.writeHead(301, { location: '/target' }).end();
      return;
    }
    const page = PAGES[path];
    if (page !== undefined) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page);
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
  });
  return server.origin;
};

const normalized = (url: string, config: AuditConfig): NormalizedHttpUrlEvidence => {
  const result = normalizeUrl(url, url, new Set(config.crawl.allowedQueryParameters));
  if (!result.ok) {
    throw new Error(`fixture URL must normalize: ${url}`);
  }
  return result.url;
};

const auditPages = async (origin: string, paths: readonly string[], approvedServiceOrigins: readonly string[] = []): Promise<readonly PageAuditResult[]> => {
  const config = createTestConfig(origin, '/', {
    viewports: { stressWidths: [] },
    audit: { interactions: false, performance: true, screenshots: false, accessibility: false },
  });
  const allocator = new IdAllocator();
  const auditor = new PageAuditor({
    contextFactory: new BrowserContextFactory(browser, config, () => new SafetyLedger(), TEST_FACTORY_OPTIONS),
    config,
    allocator,
    clock: () => new Date(),
    now: () => Date.now(),
    // 画像を撮らない設定なので、ディレクトリには書かない。
    screenshotRootDirectory: join(tmpdir(), 'beaksight-http-error-context-unused'),
    navigationPacer: createTestNavigationPacer(config),
    safetyViolationRecorded: () => false,
    approvedServiceOrigins,
  });
  const results: PageAuditResult[] = [];
  for (const path of paths) {
    const outcome = await auditor.audit(normalized(`${origin}${path}`, config), allocator.allocatePageId());
    await expect(validateArtifact('page', JSON.parse(JSON.stringify(outcome.result)) as unknown)).resolves.toEqual({ ok: true });
    results.push(outcome.result);
  }
  return results;
};

const resultOf = (pages: readonly PageAuditResult[]): AuditRunResult => auditRun({ pages, findings: pages.flatMap((value) => value.findings) });

const resource4xxOf = (pageResult: PageAuditResult) => pageResult.findings.filter((finding) => finding.ruleId === 'RESOURCE_4XX' && finding.viewport === 'desktop');

describe('AUD-7: the context of the HTTP error responses', () => {
  it('classifies the same 401 and the same 406 by the facts of the screen, and keeps no secret of the body', async () => {
    const origin = await startSite();
    const [recovered, failed, noData, processFailed] = await auditPages(origin, ['/recovered', '/failed', '/no-data', '/process-failed']);
    if (recovered === undefined || failed === undefined || noData === undefined || processFailed === undefined) {
      throw new Error('four pages must be audited');
    }
    // 回復した 401 は指摘にしない。回復しない 401（誤りの表示あり）は指摘にする。
    expect(resource4xxOf(recovered)).toEqual([]);
    expect(resource4xxOf(failed)).toHaveLength(1);
    expect(resource4xxOf(noData)).toHaveLength(1);
    expect(resource4xxOf(processFailed)).toHaveLength(1);

    // 応答の文脈（本文の要旨）が記録され、token のような値は残らない。
    const failedNetwork = failed.evidence.find((record) => record.type === 'network' && record.viewport === 'desktop');
    const sessionResponse = failedNetwork?.type === 'network'
      ? failedNetwork.payload.responses.find((response) => response.url.endsWith('/api/session'))
      : undefined;
    expect(sessionResponse?.errorContext).toMatchObject({
      approvedService: false,
      bodySummary: {
        status: 'OBSERVED',
        format: 'JSON',
        fields: [
          { key: 'message', valueType: 'string', value: 'ログインしてください', secretLike: false },
          { key: 'detail', valueType: 'string', value: null, secretLike: true },
        ],
      },
    });
    expect(JSON.stringify(failed)).not.toContain(SECRET_VALUE);
    // 画面の誤りの表示（role=alert の語）が DOM の記録に残る。
    const failedDom = failed.evidence.find((record) => record.type === 'dom' && record.viewport === 'desktop');
    expect(failedDom?.type === 'dom' ? failedDom.payload.errorDisplay : undefined).toEqual({ status: 'OBSERVED', matches: [{ source: 'ALERT', words: ['失敗'] }] });

    const model = buildReportViewModel(resultOf([recovered, failed, noData, processFailed]));
    const classOf = (pageResult: PageAuditResult): unknown =>
      model.findings.find(({ finding }) => finding.findingId === resource4xxOf(pageResult)[0]?.findingId)?.verification.httpError?.errorClass;
    expect(classOf(failed)).toBe('SITE_FAILURE');
    expect(classOf(noData)).toBe('UNDETERMINED');
    expect(classOf(processFailed)).toBe('SITE_FAILURE');
    // 回復した 401 は、件数と事実だけ（両方のビューポート）。
    expect(model.summary.httpErrorsNotCounted.responses).toEqual(expect.arrayContaining([
      expect.objectContaining({ pageId: recovered.pageId, viewport: 'desktop', status: 401, recovered: true, retryStatuses: [200], errorDisplay: 'NOT_SHOWN' }),
    ]));
  }, TEST_TIMEOUT_MS);

  it('turns the 401 of the approved service origin into COLLECTION_CAUSED (DEF-206)', async () => {
    const origin = await startSite();
    const [service] = await auditPages(origin, ['/service'], [origin]);
    if (service === undefined) {
      throw new Error('the page must be audited');
    }
    const [finding] = resource4xxOf(service);
    expect(finding).toBeDefined();
    const model = buildReportViewModel(resultOf([service]));
    const view = model.findings.find(({ finding: value }) => value.findingId === finding?.findingId);
    expect(view?.beaksightBlockRelation).toMatchObject({ relation: 'POSSIBLE', reason: 'APPROVED_SERVICE_UNAUTHORIZED' });
    expect(view?.verification.httpError?.errorClass).toBe('COLLECTION_CAUSED');
  }, TEST_TIMEOUT_MS);
});

describe('AUD-6b: the link checks from the facts of the crawl', () => {
  it('shows the redirect chain of a navigated link and the reason of an unverified link', async () => {
    const origin = await startSite();
    const [links, old] = await auditPages(origin, ['/links', '/old']);
    if (links === undefined || old === undefined) {
      throw new Error('two pages must be audited');
    }
    const { linkChecks } = buildReportViewModel(resultOf([links, old]));
    const byHref = new Map(linkChecks.links.map((entry) => [entry.href, entry]));
    expect(byHref.get('/old')).toMatchObject({
      status: 'NAVIGATED',
      navigation: expect.arrayContaining([expect.objectContaining({
        viewport: 'desktop',
        httpStatus: 200,
        finalUrl: `${origin}/target`,
        redirectChain: [{ url: `${origin}/old`, status: 301 }, { url: `${origin}/target`, status: 200 }],
      })]),
      access: 'OPEN',
    });
    expect(byHref.get('/unread')).toMatchObject({ status: 'UNVERIFIED', unverified: { reason: 'TARGET_NOT_AUDITED' } });
    expect(linkChecks.counts).toMatchObject({ navigated: 1, unverified: 1 });
  }, TEST_TIMEOUT_MS);
});

describe('AUD-6c: the observation scope of the performance values', () => {
  it('keeps the INP of a load without operations unobserved, and splits the wait and the transfer of a slow data screen', async () => {
    const origin = await startSite();
    const [slow] = await auditPages(origin, ['/slow-data']);
    if (slow === undefined) {
      throw new Error('the page must be audited');
    }
    const performance = slow.evidence.find((record) => record.type === 'performance' && record.viewport === 'desktop');
    expect(performance?.type === 'performance' ? performance.payload.webVitals?.INP.status : undefined).toBe('NOT_OBSERVED');
    expect(performance?.type === 'performance' ? performance.payload.operationsBeforeMeasurement : undefined).toEqual({ scrolled: true, notificationFramePressed: false });
    const observedForMs = performance?.type === 'performance' ? performance.payload.observedForMs : undefined;
    expect(observedForMs).toBeGreaterThan(SLOW_START_MS + SLOW_RESPONSE_MS);

    const observation = buildReportViewModel(resultOf([slow])).summary.performanceObservations.find(({ viewport }) => viewport === 'desktop');
    expect(observation).toMatchObject({ stage: 'performance', inp: 'NOT_OBSERVED', slowMetrics: expect.arrayContaining(['FCP']) });
    expect(observation?.breakdown?.firstDataRequest?.url).toBe(`${origin}/api/slow`);
    expect(observation?.breakdown?.waitUntilFirstDataRequestMs).toBeGreaterThanOrEqual(SLOW_START_MS);
    expect(observation?.breakdown?.firstDataRequest?.communicationMs).toBeGreaterThanOrEqual(SLOW_RESPONSE_MS - 100);
  }, TEST_TIMEOUT_MS);
});
