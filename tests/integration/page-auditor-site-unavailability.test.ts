// サイトが応答しないときに Run を止める設計書（`2026-10-05-beaksight-site-unavailability-stop-design.md`）の 3.1。SU2a:
// Passive の読み込み（`navigatePage`）で、サイトの不調（`siteUnavailabilityOf`）を検知したら、そのビューポートの収集をせずに FAILED にし、
// 理由 `SITE_UNAVAILABLE`（`detail` は `<段階>:<判定の詳細>`）を加える。同じページの次のビューポートは始めず、理由 `SITE_UNAVAILABLE`
// （`detail` は `null`）の SKIPPED にする。ページの結果は、最初に検知した不調の詳細（`siteUnavailableDetail`）を持つ。
// SU2b: 幅の走査と Interaction の候補の読み込みでも不調を検知し、その段階の残りの読み込みと、次のビューポートを始めない。
// 作り方は `tests/integration/page-auditor.test.ts` に合わせる（Guard の付いた本物の factory、テストの設定、pacer）。サーバは、
// テストの中の 127.0.0.1 のサーバで、ページのパスへの GET の回数ごとに振る舞いを変える。読み込みの期限は短くする。
// D1（サイトの不調で止めたときの診断の記録の設計書 2.1、2.2）: Passive の各ビューポートの読み込みの観察（`navigationDiagnostics`）を、
// ページの結果（`PageAuditResult`）と Evidence の外に持つ。始めなかったビューポートは `null`。
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { AuditConfig } from '../../src/config/types.js';
import type {
  EvidenceRecord,
  EvidenceRecordFor,
  EvidenceType,
  IncompleteReason,
  NavigationDiagnostics,
  NavigationDocumentRequestDiagnostics,
  PageAuditOutcome,
  ViewportNavigationDiagnostics,
  ViewportProfile,
} from '../../src/core/contracts.js';
import type { NormalizedHttpUrlEvidence } from '../../src/core/evidence-types.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import type { NavigationPacer } from '../../src/crawl/navigation-pacer.js';
import { normalizeUrl } from '../../src/crawl/normalize-url.js';
import { IdAllocator } from '../../src/orchestration/id-allocator.js';
import { PageAuditor, type PageAuditAttempt, type PageAuditorDependencies } from '../../src/orchestration/page-auditor.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { useHeadlessChromium } from '../helpers/chromium.js';
import { createTestNavigationPacer } from '../helpers/navigation-pacer.js';
import { createTestConfig, type TestConfigOverrides } from '../helpers/test-config.js';

const AUDIT_TEST_TIMEOUT_MS = 180_000;
/** 読み込みの期限（ms）。実際に時間切れを起こすので、短くする。 */
const SHORT_NAVIGATION_TIMEOUT_MS = 1_000;
/**
 * ヘッダの後に本文を止める読み込みの期限（ms）。Chromium は、本文が止まった文書の応答の事象（`response`）を、ヘッダを受けてから
 * 約 500ms 後に出す（2026-10-05 に確かめた）。応答を受けたことを観測できるよう、それより十分に長くする。
 */
const STALL_AFTER_HEADERS_NAVIGATION_TIMEOUT_MS = 2_000;
/**
 * 応答しない幅の走査の読み込みを、幅の走査の期限で止めるときの、ページの期限（ms。D3R の Minor-4）。幅の走査の読み込みは、読み込みの期限
 * （`navigationTimeoutMs`）ではなく、ページの期限から導いた走査の期限まで待つので、実際に時間切れを起こすために短くする。Passive の
 * 読み込みと収集（走査の前の段階）が、この期限の中で終わる長さにする。
 */
const SHORT_OVERALL_PAGE_TIMEOUT_MS = 8_000;
/** 監査するページのパス。サーバは、このパスへの GET の回数ごとに振る舞いを変える。 */
const PAGE_PATH = '/site-unavailability.html';

/** テストの中のサーバの address（観察の結果の接続先の IP の確かめにも使う）。 */
const LOOPBACK_ADDRESS = '127.0.0.1';

const OK_STATUS = 200;
const NOT_FOUND_STATUS = 404;
/** そのページだけの不具合のことが多いので、サイトの不調にしない 5xx（設計書 2章）。 */
const INTERNAL_SERVER_ERROR_STATUS = 500;
/** サイトの不調の代表として返す status（503 Service Unavailable。`SITE_UNAVAILABLE_HTTP_STATUSES` の1つ）。 */
const SERVICE_UNAVAILABLE_STATUS = 503;

/** 幅の走査をしない設定と、Interaction をしない設定（ページのパスへの GET を、各ビューポートの読み込みだけにする）。 */
const PASSIVE_LOADS_ONLY: TestConfigOverrides = {
  viewports: { stressWidths: [] },
  audit: { interactions: false },
};
/** 幅の走査を1つの幅で行う設定（不調の後に、幅の走査の読み込みがサーバに届かないことを確かめる）。 */
const ONE_STRESS_WIDTH: TestConfigOverrides = { viewports: { stressWidths: [320] } };
/** 幅の走査の2つの幅（SU2b）。どちらも、主要な2つのビューポートの幅ではないので、走査で調べる。 */
const STRESS_WIDTHS = [320, 768] as const;
/**
 * 幅の走査を2つの幅で行う設定（SU2b。1つ目の幅の読み込みで不調を検知した後に、2つ目の幅の読み込みがサーバに届かないことを確かめる）。
 * Interaction は既定のとおり行う。
 */
const TWO_STRESS_WIDTHS: TestConfigOverrides = { viewports: { stressWidths: [...STRESS_WIDTHS] } };
/** 幅の走査をしない設定（SU2b。ページのパスへの GET を、各ビューポートの読み込みと、Interaction の候補の読み込みだけにする）。 */
const NO_STRESS_WIDTHS: TestConfigOverrides = { viewports: { stressWidths: [] } };
/** 幅の走査を2つの幅で行い、Interaction をしない設定（SU2b の対照。ページのパスへの GET を、各ビューポートと各幅の読み込みにする）。 */
const TWO_STRESS_WIDTHS_WITHOUT_INTERACTIONS: TestConfigOverrides = {
  viewports: { stressWidths: [...STRESS_WIDTHS] },
  audit: { interactions: false },
};
/**
 * Interaction の候補（`button`）を持つ文書の、候補の数（SU2b）。1つ目の候補の読み込みで不調を検知した後に、残りの候補を始めないことを
 * 確かめるので、2つ以上にする。
 */
const CANDIDATE_COUNT = 3;

/** Passive の収集（4. DOM の準備の待ち、controlled scroll、5. 各 collector）の Evidence の種類。 */
const COLLECTION_EVIDENCE_TYPES = [
  'scroll', 'dom', 'layout', 'color', 'accessibility', 'performance', 'screenshot', 'link', 'interaction',
] as const satisfies readonly EvidenceType[];
/** 収集をしなかったビューポートにも残る Evidence の種類（network、console、Safety）。種類の名前の順。 */
const NON_COLLECTION_EVIDENCE_TYPES = ['console', 'network', 'safety'] as const satisfies readonly EvidenceType[];

const SITE_UNAVAILABLE_SKIPPED: IncompleteReason = { code: 'SITE_UNAVAILABLE', detail: null };
const SAFETY_VIOLATION_ABORT: IncompleteReason = { code: 'SAFETY_VIOLATION_ABORT', detail: null };
const NAVIGATION_TIMEOUT: IncompleteReason = { code: 'NAVIGATION_FAILED', detail: 'TIMEOUT' };

/** ページのパスへの GET への振る舞い。 */
type PageResponse =
  /** 接続を受けるが、何も返さない（応答（ヘッダ）のない時間切れ）。 */
  | { readonly kind: 'NO_RESPONSE' }
  /** 200 のヘッダと本文の始まりを返し、本文を止める（応答を受けた後の時間切れ）。 */
  | { readonly kind: 'STALL_AFTER_HEADERS' }
  /** 本文のある文書を、`status` で返す。 */
  | { readonly kind: 'DOCUMENT'; readonly status: number }
  /** Interaction の候補（`button`）を `CANDIDATE_COUNT` 個持つ文書を、200 で返す（SU2b）。 */
  | { readonly kind: 'CANDIDATES_DOCUMENT' };

const NO_RESPONSE: PageResponse = Object.freeze({ kind: 'NO_RESPONSE' });
const STALL_AFTER_HEADERS: PageResponse = Object.freeze({ kind: 'STALL_AFTER_HEADERS' });
const CANDIDATES_DOCUMENT: PageResponse = Object.freeze({ kind: 'CANDIDATES_DOCUMENT' });
const documentWith = (status: number): PageResponse => Object.freeze({ kind: 'DOCUMENT', status });

interface SiteServer {
  readonly origin: string;
  /** サーバが受けた、ページのパスへの GET の回数。 */
  pageGets(): number;
  /** 残った接続（応答しない接続と、本文を止めた接続）を切ってから、サーバを閉じる。何度呼んでもよい。 */
  close(): Promise<void>;
}

let browser: Browser;
const servers: SiteServer[] = [];
const temporaryDirectories: string[] = [];

useHeadlessChromium((launched) => {
  browser = launched;
});

afterEach(async () => {
  // テストが失敗しても、次のテストに Context を残さない。残っていたらテストを失敗にする（`page-auditor.test.ts` と同じ）。
  const leftoverContexts = browser.contexts();
  for (const context of leftoverContexts) {
    await context.close();
  }
  // 応答しない接続と、本文を止めた接続を切ってから、サーバを閉じる。
  for (const server of servers.splice(0)) {
    await server.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
  expect(leftoverContexts, 'Contexts left in the browser after the test').toHaveLength(0);
});

const htmlStart = (title: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main>`;

function respond(pageResponse: PageResponse, response: ServerResponse): void {
  switch (pageResponse.kind) {
    case 'NO_RESPONSE':
      return;
    case 'STALL_AFTER_HEADERS':
      response.writeHead(OK_STATUS, { 'Content-Type': 'text/html; charset=utf-8' });
      response.write(`${htmlStart('Stalled')}<h1>The first part</h1>`);
      return;
    case 'DOCUMENT': {
      const html = `${htmlStart(`Status ${pageResponse.status}`)}<h1>Status ${pageResponse.status}</h1>`
        + '<p>A page of the site.</p></main></body></html>';
      response.writeHead(pageResponse.status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html),
      });
      response.end(html);
      return;
    }
    case 'CANDIDATES_DOCUMENT': {
      const buttons = Array.from(
        { length: CANDIDATE_COUNT },
        (_, index) => `<button type="button">Candidate ${index + 1}</button>`,
      ).join('');
      const html = `${htmlStart('Candidates')}<h1>Candidates</h1>${buttons}</main></body></html>`;
      response.writeHead(OK_STATUS, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html),
      });
      response.end(html);
    }
  }
}

/**
 * テストの中のサーバ（127.0.0.1）を起動する。ページのパスへの n 回目の GET には `responses[n - 1]` で答える（回数が一覧より多ければ、
 * 最後の振る舞い）。ほかのパスは 404。
 */
async function startSiteServer(responses: readonly PageResponse[]): Promise<SiteServer> {
  const lastResponse = responses.at(-1);
  if (lastResponse === undefined) {
    throw new Error('the site server needs at least one page response');
  }
  let pageGets = 0;
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    const pathname = (request.url ?? '/').split(/[?#]/u, 1)[0];
    if (request.method === 'GET' && pathname === PAGE_PATH) {
      pageGets += 1;
      respond(responses[pageGets - 1] ?? lastResponse, response);
      return;
    }
    response.writeHead(NOT_FOUND_STATUS, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('not found');
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const port = await new Promise<number>((resolvePort, reject) => {
    server.once('error', reject);
    server.listen({ host: LOOPBACK_ADDRESS, port: 0 }, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('site server did not bind to a TCP port'));
        return;
      }
      resolvePort(address.port);
    });
  });
  let closing: Promise<void> | undefined;
  const siteServer: SiteServer = {
    origin: `http://${LOOPBACK_ADDRESS}:${port}`,
    pageGets: () => pageGets,
    close: () => {
      closing ??= new Promise<void>((resolveClose, reject) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close((error) => (error === undefined ? resolveClose() : reject(error)));
      });
      return closing;
    },
  };
  servers.push(siteServer);
  return siteServer;
}

interface SiteAuditOptions {
  readonly overrides?: TestConfigOverrides;
  /** 違反の確かめの注入（省略すると、違反では止めないことを明示する `() => false`）。 */
  readonly safetyViolationRecorded?: PageAuditorDependencies['safetyViolationRecorded'];
  /** 再試行を区別する情報（Run Coordinator が渡すもの）。 */
  readonly attempt?: PageAuditAttempt;
}

interface SiteAudit {
  readonly outcome: PageAuditOutcome;
  readonly pageUrl: NormalizedHttpUrlEvidence;
  /** Page Auditor に渡した、ページの読み込みの間隔を守る部品（`navigationCount` で、待ちを呼んだ回数を確かめる）。 */
  readonly pacer: NavigationPacer;
}

function normalized(url: string, config: AuditConfig): NormalizedHttpUrlEvidence {
  const result = normalizeUrl(url, url, new Set(config.crawl.allowedQueryParameters));
  if (!result.ok) {
    throw new Error(`test URL must normalize: ${url}`);
  }
  return result.url;
}

/** Guard の付いた本物の factory と、テストの設定（読み込みの期限は短い）で、`PAGE_PATH` のページを監査する。 */
async function auditSite(server: SiteServer, options: SiteAuditOptions = {}): Promise<SiteAudit> {
  const overrides = options.overrides ?? {};
  const config = createTestConfig(server.origin, '/', {
    ...overrides,
    crawl: { navigationTimeoutMs: SHORT_NAVIGATION_TIMEOUT_MS, ...overrides.crawl },
  });
  const allocator = new IdAllocator();
  const screenshotRootDirectory = await mkdtemp(join(tmpdir(), 'beaksight-site-unavailability-'));
  temporaryDirectories.push(screenshotRootDirectory);
  const pacer = createTestNavigationPacer(config);
  const auditor = new PageAuditor({
    contextFactory: new BrowserContextFactory(browser, config, () => new SafetyLedger()),
    config,
    allocator,
    clock: () => new Date(),
    now: () => Date.now(),
    screenshotRootDirectory,
    navigationPacer: pacer,
    safetyViolationRecorded: options.safetyViolationRecorded ?? (() => false),
  });
  const pageUrl = normalized(`${server.origin}${PAGE_PATH}`, config);
  const outcome = await auditor.audit(pageUrl, allocator.allocatePageId(), options.attempt);
  // どの監査の後にも、ブラウザに Context が残っていない。
  expect(browser.contexts(), 'Contexts left in the browser after audit()').toHaveLength(0);
  return { outcome, pageUrl, pacer };
}

/** `precedesRetry` を呼んだ回数を数える、再試行を区別する情報（再試行はしない）。 */
function countingAttempt(): { readonly attempt: PageAuditAttempt; readonly calls: () => number } {
  let calls = 0;
  return {
    attempt: {
      attempt: 1,
      precedesRetry: () => {
        calls += 1;
        return false;
      },
    },
    calls: () => calls,
  };
}

function evidenceOf<TType extends EvidenceType>(
  outcome: PageAuditOutcome,
  type: TType,
  viewport: ViewportProfile,
): EvidenceRecordFor<TType>[] {
  return outcome.result.evidence.filter(
    (record): record is EvidenceRecordFor<TType> & EvidenceRecord => record.type === type && record.viewport === viewport,
  );
}

function evidenceTypesOf(outcome: PageAuditOutcome, viewport: ViewportProfile): EvidenceType[] {
  return [...new Set(outcome.result.evidence.filter((record) => record.viewport === viewport).map((record) => record.type))]
    .sort();
}

/** 始めなかったビューポートの結果（`skippedPageResult` と同じ形）。 */
function skippedViewport(pageUrl: NormalizedHttpUrlEvidence, reason: IncompleteReason): unknown {
  return {
    requestedUrl: pageUrl,
    finalUrl: null,
    httpStatus: null,
    status: 'SKIPPED',
    incompleteReasons: [reason],
    navigationOutcome: null,
  };
}

async function expectPageSchema(outcome: PageAuditOutcome): Promise<void> {
  await expect(validateArtifact('page', JSON.parse(JSON.stringify(outcome.result)) as unknown)).resolves.toEqual({ ok: true });
}

/**
 * ビューポートの Passive の読み込みの観察で、記録した唯一の main frame の文書の要求（D1。診断の記録の設計書 2.1、2.2）。観察できたこと、
 * 文書の要求が1つだけで、リダイレクトがなく、数だけを数えた分がないことも確かめる。
 */
function onlyObservedDocumentRequest(outcome: PageAuditOutcome, viewport: ViewportProfile): NavigationDocumentRequestDiagnostics {
  return onlyDocumentRequestOf(outcome.navigationDiagnostics[viewport]?.passive ?? null, `${viewport} Passive`);
}

/**
 * 1つの読み込みの観察（`diagnostics`。Passive、幅の走査の幅、Interaction の候補のどれか）で、記録した唯一の main frame の文書の要求（D3）。
 * 観察できたこと、文書の要求が1つだけで、リダイレクトがなく、数だけを数えた分がないことも確かめる。
 */
function onlyDocumentRequestOf(diagnostics: NavigationDiagnostics | null | undefined, label: string): NavigationDocumentRequestDiagnostics {
  expect(diagnostics?.status, `${label} navigation diagnostics: ${JSON.stringify(diagnostics)}`).toBe('OBSERVED');
  if (diagnostics?.status !== 'OBSERVED') {
    throw new Error(`the ${label} load was not observed`);
  }
  expect(diagnostics.documentRequests).toHaveLength(1);
  expect(diagnostics.omittedDocumentRequestCount).toBe(0);
  expect(diagnostics.omittedEventCount).toBe(0);
  const [request] = diagnostics.documentRequests;
  expect(request?.hops).toHaveLength(1);
  return request as NavigationDocumentRequestDiagnostics;
}

/** `viewport` のビューポートの観察の結果（D3。始めなかったビューポートは `null` なので、あることを確かめて返す）。 */
function viewportDiagnosticsOf(outcome: PageAuditOutcome, viewport: ViewportProfile): ViewportNavigationDiagnostics {
  const diagnostics = outcome.navigationDiagnostics[viewport];
  expect(diagnostics, `${viewport} navigation diagnostics`).not.toBeNull();
  return diagnostics as ViewportNavigationDiagnostics;
}

/**
 * 文書の要求の1回分が、要求のヘッダを送り、`status` の応答を受けたことを確かめる（D3）。`status` が `null` なら、応答（ヘッダ）を受けて
 * いないこと（要求はネットワークへ送られたが、応答がない）を確かめる。
 */
function expectHeadersSentAndResponse(request: NavigationDocumentRequestDiagnostics, pageUrl: string, status: number | null): void {
  const [hop] = request.hops;
  expect(hop).toMatchObject({ url: pageUrl, method: 'GET', httpStatus: status });
  expect(hop?.requestHeadersSentAtMs).toEqual(expect.any(Number));
  expect(hop?.requestHeadersSentAtMs as number).toBeGreaterThanOrEqual(hop?.issuedAtMs ?? Number.POSITIVE_INFINITY);
  if (status === null) {
    expect(hop?.responseHeadersReceivedAtMs).toBeNull();
    expect(request.loadingFinishedAtMs).toBeNull();
  } else {
    expect(hop?.responseHeadersReceivedAtMs).toEqual(expect.any(Number));
    expect(hop?.remoteIpAddress).toBe(LOOPBACK_ADDRESS);
  }
}

describe('PageAuditor stops the page when the Passive load detects site unavailability (design 3.1)', () => {
  it('marks Desktop FAILED for a load without a response, does not start Mobile, and keeps the network Evidence', async () => {
    const server = await startSiteServer([NO_RESPONSE]);
    const retry = countingAttempt();
    const { outcome, pageUrl, pacer } = await auditSite(server, { overrides: PASSIVE_LOADS_ONLY, attempt: retry.attempt });
    const { result } = outcome;

    expect(result.viewports.desktop).toMatchObject({
      requestedUrl: pageUrl,
      httpStatus: null,
      status: 'FAILED',
      incompleteReasons: [NAVIGATION_TIMEOUT, { code: 'SITE_UNAVAILABLE', detail: 'passive:TIMEOUT' }],
      navigationOutcome: 'TIMEOUT',
    });
    expect(result.viewports.mobile).toEqual(skippedViewport(pageUrl, SITE_UNAVAILABLE_SKIPPED));
    expect(result.status).toBe('FAILED');
    expect(result.incompleteReasons).toEqual([
      NAVIGATION_TIMEOUT,
      { code: 'SITE_UNAVAILABLE', detail: 'passive:TIMEOUT' },
      SITE_UNAVAILABLE_SKIPPED,
    ]);
    expect(outcome.siteUnavailableDetail).toBe('desktop:passive:TIMEOUT');

    // network、console、Safety の Evidence は、今までどおり記録する。収集の Evidence はない。
    expect(evidenceTypesOf(outcome, 'desktop')).toEqual([...NON_COLLECTION_EVIDENCE_TYPES]);
    const [network] = evidenceOf(outcome, 'network', 'desktop');
    expect(network?.payload.requests.some((request) => request.url === pageUrl)).toBe(true);
    expect(evidenceOf(outcome, 'console', 'desktop')).toHaveLength(1);
    expect(evidenceOf(outcome, 'safety', 'desktop')).toHaveLength(1);
    expect(evidenceTypesOf(outcome, 'mobile')).toEqual([]);

    // Mobile の読み込みはサーバに届かず、ページの読み込みの間隔の待ちも、Desktop の1回だけである。
    expect(server.pageGets()).toBe(1);
    expect(pacer.snapshot().navigationCount).toBe(1);
    // Desktop で不調を検知したので、再試行の判断を呼ばない。
    expect(retry.calls()).toBe(0);
    expect(outcome.safety.invariantViolationCount).toBe(0);
    await expectPageSchema(outcome);

    // D1: Desktop の読み込みの観察は、要求のヘッダを送ったが、応答（ヘッダ）がなかったことを記録する。始めなかった Mobile は `null`。
    const desktop = onlyObservedDocumentRequest(outcome, 'desktop');
    expect(desktop.hops[0]).toMatchObject({ url: pageUrl, responseHeadersReceivedAtMs: null, httpStatus: null });
    expect(desktop.hops[0]?.requestHeadersSentAtMs).toEqual(expect.any(Number));
    expect(desktop.loadingFinishedAtMs).toBeNull();
    expect(outcome.navigationDiagnostics.mobile).toBeNull();
    // 観察の結果は、ページの結果と Evidence に入れない。
    expect(result).not.toHaveProperty('navigationDiagnostics');
    expect(JSON.stringify(result)).not.toContain('requestHeadersSentAtMs');
  }, AUDIT_TEST_TIMEOUT_MS);

  it('marks Desktop FAILED for a 503 with a body without collecting, and the stress sweep load does not reach the server', async () => {
    const server = await startSiteServer([documentWith(SERVICE_UNAVAILABLE_STATUS)]);
    const { outcome, pageUrl, pacer } = await auditSite(server, { overrides: ONE_STRESS_WIDTH });
    const { result } = outcome;

    // 読み込みは `OK`（503 の応答を受けた）だが、不調なので FAILED にする。
    expect(result.viewports.desktop).toMatchObject({
      status: 'FAILED',
      navigationOutcome: 'OK',
      httpStatus: SERVICE_UNAVAILABLE_STATUS,
      incompleteReasons: [{ code: 'SITE_UNAVAILABLE', detail: `passive:HTTP ${SERVICE_UNAVAILABLE_STATUS}` }],
    });
    expect(result.viewports.mobile).toEqual(skippedViewport(pageUrl, SITE_UNAVAILABLE_SKIPPED));
    expect(outcome.siteUnavailableDetail).toBe(`desktop:passive:HTTP ${SERVICE_UNAVAILABLE_STATUS}`);

    // 収集（DOM の準備の待ち、scroll、各 collector、幅の走査、Interaction）をしない。network、console、Safety の Evidence はある。
    expect(evidenceTypesOf(outcome, 'desktop')).toEqual([...NON_COLLECTION_EVIDENCE_TYPES]);
    for (const type of COLLECTION_EVIDENCE_TYPES) {
      expect(evidenceOf(outcome, type, 'desktop'), `desktop ${type}`).toHaveLength(0);
    }
    // 幅の走査の Context を作らないので、Safety の Evidence は Passive の Context の1つだけである。
    expect(evidenceOf(outcome, 'safety', 'desktop')).toHaveLength(1);
    expect(evidenceTypesOf(outcome, 'mobile')).toEqual([]);

    // 幅の走査と Mobile の読み込みは、サーバに届かない。
    expect(server.pageGets()).toBe(1);
    expect(pacer.snapshot().navigationCount).toBe(1);
    await expectPageSchema(outcome);
  }, AUDIT_TEST_TIMEOUT_MS);

  it('audits Desktop with a 200 and marks Mobile FAILED for a 503, with the Mobile detail', async () => {
    const server = await startSiteServer([documentWith(OK_STATUS), documentWith(SERVICE_UNAVAILABLE_STATUS)]);
    const { outcome } = await auditSite(server, { overrides: PASSIVE_LOADS_ONLY });
    const { result } = outcome;

    expect(result.viewports.desktop).toMatchObject({ navigationOutcome: 'OK', httpStatus: OK_STATUS });
    expect(result.viewports.desktop.status).not.toBe('FAILED');
    expect(result.viewports.desktop.incompleteReasons.map((reason) => reason.code)).not.toContain('SITE_UNAVAILABLE');
    expect(evidenceOf(outcome, 'dom', 'desktop')).toHaveLength(1);
    expect(result.viewports.mobile).toMatchObject({
      status: 'FAILED',
      navigationOutcome: 'OK',
      httpStatus: SERVICE_UNAVAILABLE_STATUS,
      incompleteReasons: [{ code: 'SITE_UNAVAILABLE', detail: `passive:HTTP ${SERVICE_UNAVAILABLE_STATUS}` }],
    });
    expect(evidenceTypesOf(outcome, 'mobile')).toEqual([...NON_COLLECTION_EVIDENCE_TYPES]);
    expect(outcome.siteUnavailableDetail).toBe(`mobile:passive:HTTP ${SERVICE_UNAVAILABLE_STATUS}`);
    expect(server.pageGets()).toBe(2);
    await expectPageSchema(outcome);
  }, AUDIT_TEST_TIMEOUT_MS);
});

describe('PageAuditor goes on with the page when the Passive load is not site unavailability (design 2.2, 3.1)', () => {
  // ページの読み込みの時間切れの元の確かめ（両方のビューポートが FAILED になり、両方に network などの Evidence が残る）は、応答を
  // 受けた後の時間切れ（不調ではない）で残す（SU2a の Blocker への回答の 2）。
  it('marks both viewports FAILED with NAVIGATION_FAILED:TIMEOUT when the body stalls after the headers, and records the network Evidence', async () => {
    const server = await startSiteServer([STALL_AFTER_HEADERS]);
    const retry = countingAttempt();
    const { outcome, pageUrl, pacer } = await auditSite(server, {
      overrides: { ...PASSIVE_LOADS_ONLY, crawl: { navigationTimeoutMs: STALL_AFTER_HEADERS_NAVIGATION_TIMEOUT_MS } },
      attempt: retry.attempt,
    });
    const { result } = outcome;

    expect(result.status).toBe('FAILED');
    for (const viewport of ['desktop', 'mobile'] as const) {
      expect(result.viewports[viewport]).toMatchObject({
        status: 'FAILED',
        navigationOutcome: 'TIMEOUT',
        httpStatus: null,
        incompleteReasons: [NAVIGATION_TIMEOUT],
      });
      const [network] = evidenceOf(outcome, 'network', viewport);
      expect(network?.payload.requests.some((request) => request.url === pageUrl)).toBe(true);
      expect(evidenceTypesOf(outcome, viewport)).toEqual([...NON_COLLECTION_EVIDENCE_TYPES]);
      expect(evidenceOf(outcome, 'console', viewport)).toHaveLength(1);
      expect(evidenceOf(outcome, 'safety', viewport)).toHaveLength(1);
    }
    expect(JSON.stringify(result)).not.toContain('SITE_UNAVAILABLE');
    expect(outcome.siteUnavailableDetail).toBeNull();
    expect(server.pageGets()).toBe(2);
    expect(pacer.snapshot().navigationCount).toBe(2);
    // 不調ではないので、今までどおり、Desktop の後に再試行の判断を1回呼ぶ。
    expect(retry.calls()).toBe(1);
    await expectPageSchema(outcome);
  }, AUDIT_TEST_TIMEOUT_MS);

  it.each([NOT_FOUND_STATUS, INTERNAL_SERVER_ERROR_STATUS])(
    'audits both viewports for an HTTP %d response (not site unavailability)',
    async (status) => {
      const server = await startSiteServer([documentWith(status)]);
      const { outcome } = await auditSite(server, { overrides: PASSIVE_LOADS_ONLY });
      const { result } = outcome;

      for (const viewport of ['desktop', 'mobile'] as const) {
        expect(result.viewports[viewport]).toMatchObject({ navigationOutcome: 'OK', httpStatus: status });
        expect(result.viewports[viewport].status).not.toBe('SKIPPED');
        expect(result.viewports[viewport].status).not.toBe('FAILED');
        expect(evidenceOf(outcome, 'dom', viewport)).toHaveLength(1);
      }
      expect(JSON.stringify(result)).not.toContain('SITE_UNAVAILABLE');
      expect(outcome.siteUnavailableDetail).toBeNull();
      expect(server.pageGets()).toBe(2);
      await expectPageSchema(outcome);
    },
    AUDIT_TEST_TIMEOUT_MS,
  );
});

describe('PageAuditor records the navigation diagnostics of the Passive loads (site unavailable diagnostics design 2.1, 2.2)', () => {
  it('records the request, the response, and the end of the Passive load of both viewports for a normal page', async () => {
    const server = await startSiteServer([documentWith(OK_STATUS)]);
    const { outcome, pageUrl } = await auditSite(server, { overrides: PASSIVE_LOADS_ONLY });
    const { result } = outcome;

    for (const viewport of ['desktop', 'mobile'] as const) {
      expect(result.viewports[viewport]).toMatchObject({ navigationOutcome: 'OK', httpStatus: OK_STATUS });
      expect(result.viewports[viewport].status).not.toBe('FAILED');
      const request = onlyObservedDocumentRequest(outcome, viewport);
      expect(request.hops[0]).toMatchObject({ url: pageUrl, method: 'GET', httpStatus: OK_STATUS, remoteIpAddress: LOOPBACK_ADDRESS });
      expect(request.hops[0]?.requestHeadersSentAtMs).toEqual(expect.any(Number));
      expect(request.hops[0]?.responseHeadersReceivedAtMs).toEqual(expect.any(Number));
      expect(request.loadingFinishedAtMs).toEqual(expect.any(Number));
      expect(request.loadingFailure).toBeNull();
      expect(evidenceOf(outcome, 'dom', viewport)).toHaveLength(1);
    }
    expect(result).not.toHaveProperty('navigationDiagnostics');
    expect(JSON.stringify(result)).not.toContain('requestHeadersSentAtMs');
    expect(outcome.siteUnavailableDetail).toBeNull();
    expect(outcome.safety.invariantViolationCount).toBe(0);
    expect(server.pageGets()).toBe(2);
    await expectPageSchema(outcome);
    // D3: 幅の走査と Interaction をしない設定なので、どちらのビューポートも、幅ごとと候補ごとの観察は空である。
    for (const viewport of ['desktop', 'mobile'] as const) {
      expect(viewportDiagnosticsOf(outcome, viewport)).toMatchObject({ stressWidths: [], interactionCandidates: [] });
    }
  }, AUDIT_TEST_TIMEOUT_MS);

  // D3（設計書 2.2 の 2026-10-07 の改訂）: 幅の走査の各幅と、Interaction の各候補の読み込みも観察し、幅ごと（幅の値つき）と候補ごと
  // （候補の順の番号つき）に持つ。監査の結果（ページの結果、Evidence）は変えない。
  it('records the observation of every stress width and every interaction candidate of a normal page, outside the page result', async () => {
    const server = await startSiteServer([CANDIDATES_DOCUMENT]);
    const { outcome, pageUrl } = await auditSite(server, { overrides: TWO_STRESS_WIDTHS });
    const { result } = outcome;

    expect(result.viewports.desktop).toMatchObject({ navigationOutcome: 'OK', httpStatus: OK_STATUS });
    expect(result.viewports.desktop.status).not.toBe('FAILED');
    expect(evidenceOf(outcome, 'layout', 'desktop')[0]?.payload.stressSweep?.map(({ width }) => width)).toEqual([...STRESS_WIDTHS]);
    expect(evidenceOf(outcome, 'interaction', 'desktop')).toHaveLength(CANDIDATE_COUNT);
    expect(outcome.siteUnavailableDetail).toBeNull();
    // Desktop、2つの幅、3つの候補、Mobile の読み込みが、サーバに届く。
    expect(server.pageGets()).toBe(2 + STRESS_WIDTHS.length + CANDIDATE_COUNT);
    await expectPageSchema(outcome);

    const desktop = viewportDiagnosticsOf(outcome, 'desktop');
    expectHeadersSentAndResponse(onlyDocumentRequestOf(desktop.passive, 'desktop Passive'), pageUrl, OK_STATUS);
    expect(desktop.stressWidths.map(({ width }) => width)).toEqual([...STRESS_WIDTHS]);
    for (const { width, diagnostics } of desktop.stressWidths) {
      expectHeadersSentAndResponse(onlyDocumentRequestOf(diagnostics, `stress width ${width}`), pageUrl, OK_STATUS);
    }
    expect(desktop.interactionCandidates.map(({ index }) => index)).toEqual(Array.from({ length: CANDIDATE_COUNT }, (_, index) => index));
    for (const { index, diagnostics } of desktop.interactionCandidates) {
      expectHeadersSentAndResponse(onlyDocumentRequestOf(diagnostics, `interaction candidate ${index}`), pageUrl, OK_STATUS);
    }
    // Mobile は、幅の走査と Interaction をしない。
    expect(viewportDiagnosticsOf(outcome, 'mobile')).toMatchObject({ stressWidths: [], interactionCandidates: [] });
    expectHeadersSentAndResponse(onlyObservedDocumentRequest(outcome, 'mobile'), pageUrl, OK_STATUS);
    // 観察の結果は、ページの結果と Evidence に入れない。
    expect(JSON.stringify(result)).not.toContain('stressWidths');
    expect(JSON.stringify(result)).not.toContain('interactionCandidates');
    expect(Object.isFrozen(desktop.stressWidths)).toBe(true);
    expect(Object.isFrozen(desktop.interactionCandidates)).toBe(true);
  }, AUDIT_TEST_TIMEOUT_MS);
});

describe('PageAuditor prefers the safety violation to site unavailability for the next viewport (design 3.1)', () => {
  it('skips Mobile with SAFETY_VIOLATION_ABORT when a violation is recorded after a Desktop load without a response', async () => {
    const server = await startSiteServer([NO_RESPONSE]);
    let checks = 0;
    // Desktop の読み込みがサーバに届いた後（Desktop の監査の間）に、違反が記録されたとみなす。
    const violationRecorded = (): boolean => {
      checks += 1;
      return server.pageGets() > 0;
    };
    const { outcome, pageUrl } = await auditSite(server, {
      overrides: PASSIVE_LOADS_ONLY,
      safetyViolationRecorded: violationRecorded,
    });
    const { result } = outcome;

    expect(checks).toBeGreaterThan(0);
    expect(result.viewports.desktop.incompleteReasons)
      .toEqual([NAVIGATION_TIMEOUT, { code: 'SITE_UNAVAILABLE', detail: 'passive:TIMEOUT' }]);
    expect(result.viewports.mobile).toEqual(skippedViewport(pageUrl, SAFETY_VIOLATION_ABORT));
    expect(result.incompleteReasons).toContainEqual(SAFETY_VIOLATION_ABORT);
    expect(result.incompleteReasons).not.toContainEqual(SITE_UNAVAILABLE_SKIPPED);
    // 最初に検知した不調の詳細は、そのまま持つ（Run を止める理由の優先は、Run Coordinator が決める）。
    expect(outcome.siteUnavailableDetail).toBe('desktop:passive:TIMEOUT');
    expect(server.pageGets()).toBe(1);
    await expectPageSchema(outcome);
  }, AUDIT_TEST_TIMEOUT_MS);
});

/** ビューポートの理由のうち、理由のコードが `SITE_UNAVAILABLE` のもの。 */
function siteUnavailableReasonsOf(outcome: PageAuditOutcome, viewport: ViewportProfile): IncompleteReason[] {
  return outcome.result.viewports[viewport].incompleteReasons.filter((reason) => reason.code === 'SITE_UNAVAILABLE');
}

/** Interaction の段階を途中で止めた理由（`COLLECTOR_INCOMPLETE` の `interaction:<理由>:remaining=<件数>`）。 */
function interactionStopped(reason: string, remaining: number): IncompleteReason {
  return { code: 'COLLECTOR_INCOMPLETE', detail: `interaction:${reason}:remaining=${remaining}` };
}

// SU2b（設計書 3.1）: 幅の走査と Interaction の候補の読み込みでも、不調を検知したら、その段階の残りの読み込みを始めず、同じページの
// 次のビューポートも始めない。新しい読み込みをしない残りの段階（配色、accessibility、performance、スクリーンショット、Link）は、
// 今までどおり行うので、ビューポートは FAILED ではなく PARTIAL になる。
describe('PageAuditor stops the page when the stress sweep or an interaction candidate load detects site unavailability (design 3.1)', () => {
  it('does not start the next stress width, the interaction candidates, nor Mobile after a 503 of the first stress width', async () => {
    const server = await startSiteServer([CANDIDATES_DOCUMENT, documentWith(SERVICE_UNAVAILABLE_STATUS)]);
    const retry = countingAttempt();
    const { outcome, pageUrl, pacer } = await auditSite(server, { overrides: TWO_STRESS_WIDTHS, attempt: retry.attempt });
    const { result } = outcome;
    const stageDetail = `stress-layout:HTTP ${SERVICE_UNAVAILABLE_STATUS}`;

    // Passive の読み込みは 200 で、収集した。幅の走査の段階は、不調で止まった。Interaction の候補は、1つも始めない。
    expect(result.viewports.desktop).toMatchObject({ status: 'PARTIAL', navigationOutcome: 'OK', httpStatus: OK_STATUS });
    expect(siteUnavailableReasonsOf(outcome, 'desktop')).toEqual([{ code: 'SITE_UNAVAILABLE', detail: stageDetail }]);
    expect(result.viewports.desktop.incompleteReasons).toContainEqual({
      code: 'COLLECTOR_INCOMPLETE',
      detail: 'stress-layout:SITE_UNAVAILABLE',
    });
    expect(result.viewports.desktop.incompleteReasons).toContainEqual(interactionStopped('SITE_UNAVAILABLE', CANDIDATE_COUNT));
    expect(result.viewports.mobile).toEqual(skippedViewport(pageUrl, SITE_UNAVAILABLE_SKIPPED));
    expect(outcome.siteUnavailableDetail).toBe(`desktop:${stageDetail}`);

    // 新しい読み込みをしない残りの段階の Evidence は、今までどおりある。幅の走査の結果は、段階が止まったので記録しない。
    for (const type of ['dom', 'layout', 'color', 'accessibility', 'performance', 'screenshot', 'link'] as const) {
      expect(evidenceOf(outcome, type, 'desktop').length, `desktop ${type}`).toBeGreaterThan(0);
    }
    expect(evidenceOf(outcome, 'layout', 'desktop')[0]?.payload.stressSweep).toBeNull();
    expect(evidenceOf(outcome, 'interaction', 'desktop')).toHaveLength(0);
    // Safety の Evidence は、Passive の Context と、1つ目の幅のセッションの2つだけである（2つ目の幅のセッションを作らない）。
    expect(evidenceOf(outcome, 'safety', 'desktop')).toHaveLength(2);
    expect(evidenceTypesOf(outcome, 'mobile')).toEqual([]);

    // 2つ目の幅、Interaction の候補、Mobile の読み込みは、サーバに届かない。読み込みの間隔の待ちも、Desktop と1つ目の幅の2回だけ。
    expect(server.pageGets()).toBe(2);
    expect(pacer.snapshot().navigationCount).toBe(2);
    // Desktop で不調を検知したので、再試行の判断を呼ばない。
    expect(retry.calls()).toBe(0);
    expect(outcome.safety.invariantViolationCount).toBe(0);
    await expectPageSchema(outcome);

    // D3: Desktop の観察は、Passive（200）と、始めた1つ目の幅（503。幅の値つき）だけを持つ。候補は始めていない。Mobile は `null`。
    const desktop = viewportDiagnosticsOf(outcome, 'desktop');
    expectHeadersSentAndResponse(onlyDocumentRequestOf(desktop.passive, 'desktop Passive'), pageUrl, OK_STATUS);
    expect(desktop.stressWidths.map(({ width }) => width)).toEqual([STRESS_WIDTHS[0]]);
    expectHeadersSentAndResponse(
      onlyDocumentRequestOf(desktop.stressWidths[0]?.diagnostics, `stress width ${STRESS_WIDTHS[0]}`),
      pageUrl,
      SERVICE_UNAVAILABLE_STATUS,
    );
    expect(desktop.interactionCandidates).toEqual([]);
    expect(outcome.navigationDiagnostics.mobile).toBeNull();
    expect(JSON.stringify(result)).not.toContain('stressWidths');
  }, AUDIT_TEST_TIMEOUT_MS);

  it('does not start the next interaction candidates nor Mobile after a 503 of the first candidate load', async () => {
    const server = await startSiteServer([CANDIDATES_DOCUMENT, documentWith(SERVICE_UNAVAILABLE_STATUS)]);
    const retry = countingAttempt();
    const { outcome, pageUrl, pacer } = await auditSite(server, { overrides: NO_STRESS_WIDTHS, attempt: retry.attempt });
    const { result } = outcome;
    const stageDetail = `interaction:HTTP ${SERVICE_UNAVAILABLE_STATUS}`;

    expect(result.viewports.desktop).toMatchObject({ status: 'PARTIAL', navigationOutcome: 'OK', httpStatus: OK_STATUS });
    expect(siteUnavailableReasonsOf(outcome, 'desktop')).toEqual([{ code: 'SITE_UNAVAILABLE', detail: stageDetail }]);
    expect(result.viewports.desktop.incompleteReasons).toContainEqual(interactionStopped('SITE_UNAVAILABLE', CANDIDATE_COUNT - 1));
    expect(result.viewports.mobile).toEqual(skippedViewport(pageUrl, SITE_UNAVAILABLE_SKIPPED));
    expect(outcome.siteUnavailableDetail).toBe(`desktop:${stageDetail}`);

    // 1つ目の候補の結果は、今までどおり記録する。残りの段階の Evidence もある。
    expect(evidenceOf(outcome, 'interaction', 'desktop')).toHaveLength(1);
    for (const type of ['dom', 'layout', 'color', 'screenshot', 'link'] as const) {
      expect(evidenceOf(outcome, type, 'desktop').length, `desktop ${type}`).toBeGreaterThan(0);
    }
    // Safety の Evidence は、Passive の Context と、1つ目の候補の Context の2つだけである。
    expect(evidenceOf(outcome, 'safety', 'desktop')).toHaveLength(2);
    expect(evidenceTypesOf(outcome, 'mobile')).toEqual([]);

    // 2つ目以降の候補と Mobile の読み込みは、サーバに届かない。
    expect(server.pageGets()).toBe(2);
    expect(pacer.snapshot().navigationCount).toBe(2);
    expect(retry.calls()).toBe(0);
    expect(outcome.safety.invariantViolationCount).toBe(0);
    await expectPageSchema(outcome);

    // D3: Desktop の観察は、Passive（200）と、始めた1つ目の候補（503。候補の順の番号つき）だけを持つ。幅の走査はしていない。
    const desktop = viewportDiagnosticsOf(outcome, 'desktop');
    expectHeadersSentAndResponse(onlyDocumentRequestOf(desktop.passive, 'desktop Passive'), pageUrl, OK_STATUS);
    expect(desktop.stressWidths).toEqual([]);
    expect(desktop.interactionCandidates.map(({ index }) => index)).toEqual([0]);
    expectHeadersSentAndResponse(
      onlyDocumentRequestOf(desktop.interactionCandidates[0]?.diagnostics, 'interaction candidate 0'),
      pageUrl,
      SERVICE_UNAVAILABLE_STATUS,
    );
    expect(outcome.navigationDiagnostics.mobile).toBeNull();
    expect(JSON.stringify(result)).not.toContain('interactionCandidates');
  }, AUDIT_TEST_TIMEOUT_MS);

  // D3: 応答しない候補の読み込み（読み込みの期限で止まる）でも、その候補の観察に「要求のヘッダを送った、応答なし」が記録される。
  it('records in the observation of the first candidate that the headers were sent without a response, when the candidate load does not respond', async () => {
    const server = await startSiteServer([CANDIDATES_DOCUMENT, NO_RESPONSE]);
    const { outcome, pageUrl, pacer } = await auditSite(server, { overrides: NO_STRESS_WIDTHS });
    const { result } = outcome;

    // 不調の判定と結果は、今までどおり（候補の読み込みの時間切れは `interaction:TIMEOUT`）。
    expect(result.viewports.desktop).toMatchObject({ status: 'PARTIAL', navigationOutcome: 'OK', httpStatus: OK_STATUS });
    expect(siteUnavailableReasonsOf(outcome, 'desktop')).toEqual([{ code: 'SITE_UNAVAILABLE', detail: 'interaction:TIMEOUT' }]);
    expect(result.viewports.desktop.incompleteReasons).toContainEqual(interactionStopped('SITE_UNAVAILABLE', CANDIDATE_COUNT - 1));
    expect(result.viewports.mobile).toEqual(skippedViewport(pageUrl, SITE_UNAVAILABLE_SKIPPED));
    expect(outcome.siteUnavailableDetail).toBe('desktop:interaction:TIMEOUT');
    expect(evidenceOf(outcome, 'interaction', 'desktop')).toHaveLength(1);
    expect(server.pageGets()).toBe(2);
    expect(pacer.snapshot().navigationCount).toBe(2);
    await expectPageSchema(outcome);

    const desktop = viewportDiagnosticsOf(outcome, 'desktop');
    expectHeadersSentAndResponse(onlyDocumentRequestOf(desktop.passive, 'desktop Passive'), pageUrl, OK_STATUS);
    expect(desktop.stressWidths).toEqual([]);
    expect(desktop.interactionCandidates.map(({ index }) => index)).toEqual([0]);
    // 候補の文書の要求は、ヘッダをネットワークへ送ったが、応答（ヘッダ）を受けていない（サイト側か経路の問題と分かる）。
    expectHeadersSentAndResponse(
      onlyDocumentRequestOf(desktop.interactionCandidates[0]?.diagnostics, 'interaction candidate 0'),
      pageUrl,
      null,
    );
    expect(outcome.navigationDiagnostics.mobile).toBeNull();
  }, AUDIT_TEST_TIMEOUT_MS);

  // D3R の Minor-4: 応答しない幅の読み込み（幅の走査の期限で止まる）でも、その幅の観察に「要求のヘッダを送った、応答なし」が記録される。
  // 幅の走査の期限は、ページの期限から導かれる（`collectorAtMs`）ので、ページの期限（`crawl.overallPageTimeoutMs`）を短くする。
  // Interaction をしない設定なので、候補の予算との関係の検証（`validateInteractionCandidateBudget`）には掛からない。
  it('records in the observation of the first stress width that the headers were sent without a response, when the width load does not respond', async () => {
    const server = await startSiteServer([documentWith(OK_STATUS), NO_RESPONSE]);
    const retry = countingAttempt();
    const { outcome, pageUrl, pacer } = await auditSite(server, {
      overrides: { ...TWO_STRESS_WIDTHS_WITHOUT_INTERACTIONS, crawl: { overallPageTimeoutMs: SHORT_OVERALL_PAGE_TIMEOUT_MS } },
      attempt: retry.attempt,
    });
    const { result } = outcome;

    // 不調の判定と結果は、今までどおり（幅の読み込みの時間切れは `stress-layout:TIMEOUT`）。幅の走査の結果（1つ目の幅は読み込みの期限切れ、
    // 2つ目の幅は始めない）も、観察を始めない場合と同じである。
    expect(result.viewports.desktop).toMatchObject({ navigationOutcome: 'OK', httpStatus: OK_STATUS });
    expect(result.viewports.desktop.status).not.toBe('SKIPPED');
    expect(siteUnavailableReasonsOf(outcome, 'desktop')).toEqual([{ code: 'SITE_UNAVAILABLE', detail: 'stress-layout:TIMEOUT' }]);
    expect(evidenceOf(outcome, 'layout', 'desktop')[0]?.payload.stressSweep).toEqual([
      expect.objectContaining({ width: STRESS_WIDTHS[0], status: 'FAILED', stage: 'NAVIGATION', reason: 'DEADLINE_EXCEEDED' }),
      expect.objectContaining({ width: STRESS_WIDTHS[1], status: 'FAILED', stage: 'NOT_STARTED', reason: 'DEADLINE_EXCEEDED' }),
    ]);
    expect(result.viewports.mobile).toEqual(skippedViewport(pageUrl, SITE_UNAVAILABLE_SKIPPED));
    expect(outcome.siteUnavailableDetail).toBe('desktop:stress-layout:TIMEOUT');
    // 2つ目の幅と Mobile の読み込みは、サーバに届かない。
    expect(server.pageGets()).toBe(2);
    expect(pacer.snapshot().navigationCount).toBe(2);
    expect(retry.calls()).toBe(0);
    expect(outcome.safety.invariantViolationCount).toBe(0);
    await expectPageSchema(outcome);

    const desktop = viewportDiagnosticsOf(outcome, 'desktop');
    expectHeadersSentAndResponse(onlyDocumentRequestOf(desktop.passive, 'desktop Passive'), pageUrl, OK_STATUS);
    expect(desktop.stressWidths.map(({ width }) => width)).toEqual([STRESS_WIDTHS[0]]);
    // 幅の文書の要求は、ヘッダをネットワークへ送ったが、応答（ヘッダ）を受けていない（サイト側か経路の問題と分かる）。
    expectHeadersSentAndResponse(
      onlyDocumentRequestOf(desktop.stressWidths[0]?.diagnostics, `stress width ${STRESS_WIDTHS[0]}`),
      pageUrl,
      null,
    );
    expect(desktop.interactionCandidates).toEqual([]);
    expect(outcome.navigationDiagnostics.mobile).toBeNull();
  }, AUDIT_TEST_TIMEOUT_MS);
});

describe('PageAuditor goes on with the stress sweep when its load is not site unavailability (design 2, 3.1)', () => {
  it.each([NOT_FOUND_STATUS, INTERNAL_SERVER_ERROR_STATUS])(
    'loads the next stress width and audits Mobile after an HTTP %d of the stress sweep loads',
    async (status) => {
      const server = await startSiteServer([
        documentWith(OK_STATUS),
        documentWith(status),
        documentWith(status),
        documentWith(OK_STATUS),
      ]);
      const retry = countingAttempt();
      const { outcome, pacer } = await auditSite(server, {
        overrides: TWO_STRESS_WIDTHS_WITHOUT_INTERACTIONS,
        attempt: retry.attempt,
      });
      const { result } = outcome;

      const [layout] = evidenceOf(outcome, 'layout', 'desktop');
      expect(layout?.payload.stressSweep?.map((width) => width.width)).toEqual([...STRESS_WIDTHS]);
      expect(result.viewports.mobile).toMatchObject({ navigationOutcome: 'OK', httpStatus: OK_STATUS });
      expect(result.viewports.mobile.status).not.toBe('SKIPPED');
      expect(evidenceOf(outcome, 'dom', 'mobile')).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain('SITE_UNAVAILABLE');
      expect(outcome.siteUnavailableDetail).toBeNull();
      // Desktop、2つの幅、Mobile の読み込みが、サーバに届く。
      expect(server.pageGets()).toBe(4);
      expect(pacer.snapshot().navigationCount).toBe(4);
      expect(retry.calls()).toBe(1);
      await expectPageSchema(outcome);
    },
    AUDIT_TEST_TIMEOUT_MS,
  );
});
