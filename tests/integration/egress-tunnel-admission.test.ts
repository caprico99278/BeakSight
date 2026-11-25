// RB-4b: 監査するサイトの外の宛先への CONNECT は、待たずに通す（下の場面は、その変わり目に合わせて直した）。
// DEF-125: 出口の中継は、その Context の Guard が通した要求の宛先（host とポート）への CONNECT だけを通し、ほかの CONNECT は拒んで、Safety Ledger に
// 記録する（`blockedInteractionRequests` の `CONNECT <host>:<port>`、理由 `GUARD_BYPASS_EGRESS`。値は残らない）。本物の factory と Guard と、
// 127.0.0.1 の https の自前のサーバ（テストだけの証明書。ブラウザは証明書の誤りを無視する起動の引数）で確かめる。Chromium は headless だけ
// （`BOTH_CHROMIUM_LAUNCHERS`。遅い組は CLI の起動の設定の 1 つ）。インターネットには出ない（宛先は 127.0.0.1 だけ）。
// - ふだんの読み込みは今どおり通る（代表: 中継を作る 2 つの所、Passive の Context の公開の監査（範囲の外の静的な資源、別の Origin へのリダイレクト、
//   別の Origin の iframe、Worker の fetch、事前確認のある fetch）と Interaction）。拒んだ CONNECT の記録は、下の直接の CONNECT の 1 件だけ。
// - Guard が通していない宛先への CONNECT（中継に直接送る）は `403` で拒まれ、その宛先に接続が届かず、記録される。
// - DEF-209・DEF-215（stress-sweep-connect をまとめた）: ページの監査（幅の走査つき）で CONNECT の拒否が残らない。要求の前の接続の拒否は印
//   `preRequestConnection` つきで記録し、安全の指摘にしない。許可の外の Origin には何も届かない。
// 書き込みの段の承認の POST の https の送信（送り手が中継の CONNECT を通る）は、`write-create-run.test.ts` の https の回で確かめる。
import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SAFETY_RULES } from '../../src/audit/safety-rules.js';
import { BrowserContextFactory, EGRESS_TUNNEL_ADMISSION_WAIT_MS } from '../../src/browser/context-factory.js';
import type { Viewport } from '../../src/config/types.js';
import type { EvidenceRecordFor, PageAuditOutcome } from '../../src/core/contracts.js';
import { wait } from '../../src/core/deadline.js';
import type { BlockedInteractionRequestEvent, NormalizedHttpUrlEvidence } from '../../src/core/evidence-types.js';
import { normalizeUrl } from '../../src/crawl/normalize-url.js';
import { collectDomEvidence } from '../../src/evidence/dom-collector.js';
import { IdAllocator } from '../../src/orchestration/id-allocator.js';
import { PageAuditor, type PageAuditCollectors } from '../../src/orchestration/page-auditor.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { overrideBrowser } from '../helpers/browser-proxies.js';
import { BOTH_CHROMIUM_LAUNCHERS, closeTestContexts } from '../helpers/chromium.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { createTestNavigationPacer } from '../helpers/navigation-pacer.js';
import { TEST_FACTORY_OPTIONS, createTestConfig } from '../helpers/test-config.js';
import { LOOPBACK_TEST_CERTIFICATE, LOOPBACK_TEST_KEY, TEST_BROWSER_IGNORE_CERTIFICATE_ERRORS_ARGS } from '../helpers/tls-test-certificate.js';


const VIEWPORT: Viewport = Object.freeze({ width: 1280, height: 800 });
/** ページの JS が、すべての読み込みを終えて `document.title` に結果を書くのを待つ上限（ms）。 */
const PAGE_DONE_TIMEOUT_MS = 15_000;
/** ページの読み込みの後、遅れて来る要求と CONNECT を待つ時間（ms）。 */
const LATE_DELIVERY_SETTLE_MS = 1_000;
/** 直接の CONNECT の答えを待つ上限（ms）。期限ではなく、確かめのための余裕である（中継の知らせの待ちより長い）。 */
const CONNECT_ANSWER_TIMEOUT_MS = 15_000;
/** 1 つの場面の期限（ms）。 */
const SCENARIO_TIMEOUT_MS = 90_000;
/** 1×1 の PNG。 */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** サイトの Origin の名前: A は許可 Origin、B は範囲の外（別の Origin の静的な資源と読み取り）、U は誰も通さない宛先。 */
const SITE_NAMES = ['A', 'B', 'U'] as const;
type SiteName = (typeof SITE_NAMES)[number];

interface HttpsSite {
  readonly servers: Readonly<Record<SiteName, LoopbackHttpServer>>;
  /** 届いた要求（`<名前> <method> <path>`。事前確認の OPTIONS を含む）。 */
  readonly received: string[];
  /** U が受けた TCP の接続の数。 */
  uConnections(): number;
  close(): Promise<void>;
}

/** ページの JS が、すべての読み込みの後に `document.title` に結果を書く（`done:<結果>`）。 */
const PAGE_SCRIPTS = {
  public: (o: Record<SiteName, string>): string => `
    <img src="${o.B}/x.png"><img src="${o.A}/redir"><script src="${o.B}/s.js"></script><iframe src="${o.B}/frame"></iframe>
    <script>
      Promise.all([
        fetch('${o.B}/api', { headers: { 'X-Test': '1' } }).then((r) => r.text()),
        new Promise((resolve) => {
          const worker = new Worker(URL.createObjectURL(new Blob(["fetch('${o.B}/w').then((r) => r.text()).then((t) => postMessage(t), () => postMessage('err'))"], { type: 'text/javascript' })));
          worker.onmessage = (event) => resolve(event.data);
        }),
      ]).then((values) => { document.title = 'done:' + values.join(','); }, (error) => { document.title = 'err:' + error; });
    </script>`,
  // TURN の TCP の場面の、読み込みだけのページ。
  write: (o: Record<SiteName, string>): string => `
    <img id="i" src="${o.A}/x.png">
    <script>
      const image = document.getElementById('i');
      const finish = () => { document.title = 'done:' + image.naturalWidth; };
      if (image.complete) finish(); else image.addEventListener('load', finish);
    </script>`,
} as const;
type PageKind = keyof typeof PAGE_SCRIPTS;

async function startHttpsSite(): Promise<HttpsSite> {
  const received: string[] = [];
  const origins = {} as Record<SiteName, string>;
  const servers = {} as Record<SiteName, LoopbackHttpServer>;
  let uConnections = 0;
  for (const name of SITE_NAMES) {
    servers[name] = await startLoopbackHttpServer((request, response) => {
      const path = new URL(request.url ?? '/', 'https://x').pathname;
      received.push(`${name} ${request.method ?? ''} ${path}`);
      const cors = {
        'access-control-allow-origin': origins.A,
        'access-control-allow-headers': 'authorization, content-type, x-test',
        'access-control-allow-methods': 'GET, POST',
      };
      if (path.startsWith('/page-')) {
        const kind = path.slice('/page-'.length) as PageKind;
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(`<!doctype html><html><head><title>loading</title></head><body><p>DEF-125</p>${PAGE_SCRIPTS[kind](origins)}</body></html>`);
        return;
      }
      if (path === '/redir') {
        response.writeHead(302, { location: `${origins.B}/y.png` });
        response.end();
        return;
      }
      if (path.endsWith('.png')) {
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end(PNG);
        return;
      }
      if (path === '/s.js') {
        response.writeHead(200, { 'content-type': 'text/javascript' });
        response.end('window.def125 = 1;');
        return;
      }
      if (path === '/api' || path === '/w') {
        response.writeHead(200, { ...cors, ...(path === '/w' ? { 'access-control-allow-origin': '*' } : {}), 'content-type': 'text/plain' });
        response.end(path === '/api' ? 'api' : 'w');
        return;
      }
      response.writeHead(200, { ...cors, 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><p>frame</p>');
    }, { tls: { cert: LOOPBACK_TEST_CERTIFICATE, key: LOOPBACK_TEST_KEY } });
    origins[name] = servers[name].origin;
  }
  servers.U.server.on('connection', () => {
    uConnections += 1;
  });
  return {
    servers,
    received,
    uConnections: () => uConnections,
    close: async () => {
      for (const name of SITE_NAMES) {
        await servers[name].close();
      }
    },
  };
}

/** 中継（`proxyServer` の `http://127.0.0.1:<port>`）に生の CONNECT を送り、答えの最初の行を返す（答えがなければ空）。 */
const connectThrough = (proxyServer: string, authority: string): Promise<string> => new Promise((resolvePromise) => {
  const proxyUrl = new URL(proxyServer);
  const socket = netConnect({ host: proxyUrl.hostname, port: Number(proxyUrl.port) });
  let received = '';
  const finish = (): void => {
    clearTimeout(timer);
    socket.destroy();
    resolvePromise(received.split('\r\n')[0] ?? '');
  };
  const timer = setTimeout(finish, CONNECT_ANSWER_TIMEOUT_MS);
  socket.on('error', finish);
  socket.on('close', finish);
  socket.on('data', (chunk: Buffer) => {
    received += chunk.toString('latin1');
    if (received.includes('\r\n')) finish();
  });
  socket.on('connect', () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
});

/** Context ごとの、Playwright に渡した proxy の server を覚える Browser の Proxy（テストが中継に直接 CONNECT を送るため。製品のコードは変えない）。 */
function browserRecordingProxyServers(real: Browser, servers: WeakMap<BrowserContext, string>): Browser {
  return overrideBrowser(real, {
    newContext: async (options?: BrowserContextOptions): Promise<BrowserContext> => {
      const context = await real.newContext(options);
      if (options?.proxy?.server !== undefined) {
        servers.set(context, options.proxy.server);
      }
      return context;
    },
  });
}

/**
 * 場面（Context の種類）。factory が中継を作る 2 つの所（Passive の Context の作り手と、Interaction の session）の代表。ログインの段・監査の段・発見・
 * 書き込みの段の Context は、Passive の Context と同じ作り手の中継（同じ CONNECT の受け入れ）を使う。
 */
const SCENARIOS = ['public audit', 'Interaction'] as const;
type Scenario = (typeof SCENARIOS)[number];

/** 届くはずの要求（ページの文書のほか。並びは問わない。事前確認は Guard が満たすので届かない）。 */
const EXPECTED_REQUESTS: readonly string[] = ['B GET /x.png', 'A GET /redir', 'B GET /y.png', 'B GET /s.js', 'B GET /frame', 'B GET /api', 'B GET /w'];
const EXPECTED_TITLE = 'done:api,w';

/** DEF-209・DEF-215: 監査するページ。 */
const AUDIT_PAGE_PATH = '/stress-connect/page.html';
/** DEF-209: 幅の走査の幅（2 つ）。 */
const STRESS_WIDTHS = [320, 768];
/** DEF-209・SWR: 読み込みの数（Desktop、幅の走査の 2 回（大きさを変えて回す 1 回と、一番狭い幅の照らし合わせの 1 回）、Mobile）。 */
const PAGE_LOADS = 2 + 2;
/** DEF-209: 読み込みの間隔（ms）。中継が知らせのない CONNECT を待つ時間より長くする（待つ間に張った接続は、知らせが来ないまま拒まれる）。 */
const NAVIGATION_INTERVAL_MS = EGRESS_TUNNEL_ADMISSION_WAIT_MS + 1_500;
/** DEF-209・DEF-215 の場面の期限（ms）。 */
const AUDIT_TIMEOUT_MS = 120_000;

/** DEF-209・DEF-215: 要求の記録つきの https の仮のサーバ（どの path にも、アイコンつきのページを返す。ブラウザ自身の favicon の要求は出ない）。 */
async function startRecordingHttpsServer(received: string[]): Promise<LoopbackHttpServer> {
  return await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
    request.resume();
    received.push(`${request.method ?? 'GET'} ${new URL(request.url ?? '/', 'https://127.0.0.1').pathname}`);
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end('<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>page</title></head>'
      + '<body><main><h1>page</h1><p>text</p></main></body></html>');
  }, { tls: { cert: LOOPBACK_TEST_CERTIFICATE, key: LOOPBACK_TEST_KEY } });
}

interface AuditedPage {
  readonly outcome: PageAuditOutcome;
  readonly pageUrl: NormalizedHttpUrlEvidence;
}

/** 安全の Evidence の、中継が拒んだ CONNECT の記録（全部のビューポート）。 */
function connectRecordsOf(outcome: PageAuditOutcome): BlockedInteractionRequestEvent[] {
  return outcome.result.evidence
    .filter((record): record is EvidenceRecordFor<'safety'> => record.type === 'safety')
    .flatMap(({ payload }) => payload.blockedInteractionRequests.filter(({ method }) => method === 'CONNECT'));
}

/** 両方のビューポートで、安全の Rule が作る Finding の Rule の ID。 */
function safetyRuleIdsOf({ outcome, pageUrl }: AuditedPage): string[] {
  return (['desktop', 'mobile'] as const).flatMap((viewport) => SAFETY_RULES.flatMap((rule) => rule.evaluate({
    pageId: outcome.result.pageId,
    pageUrl,
    viewport,
    evidence: outcome.result.evidence,
  }).map(({ ruleId }) => ruleId)));
}

describe.each(BOTH_CHROMIUM_LAUNCHERS)('DEF-125: the egress proxy admits CONNECT only to the destinations the Guard let through (%s)', (launcherName, launch) => {
  let realBrowser: Browser;
  let browser: Browser;
  const proxyServers = new WeakMap<BrowserContext, string>();
  const factories: BrowserContextFactory[] = [];
  let site: HttpsSite | undefined;

  beforeAll(async () => {
    realBrowser = await launch({ args: TEST_BROWSER_IGNORE_CERTIFICATE_ERRORS_ARGS });
    browser = browserRecordingProxyServers(realBrowser, proxyServers);
  });

  afterEach(async () => {
    await Promise.all(factories.splice(0).map((factory) => factory.close()));
    await closeTestContexts(realBrowser);
    await site?.close();
    site = undefined;
  });

  afterAll(async () => {
    await realBrowser?.close();
  });

  const origins = (current: HttpsSite): Record<SiteName, string> =>
    Object.fromEntries(SITE_NAMES.map((name) => [name, current.servers[name].origin])) as Record<SiteName, string>;

  /** `scenario` の Context を本物の factory で開き、page と Ledger と閉じる処理を返す。 */
  const open = async (scenario: Scenario, o: Record<SiteName, string>): Promise<{
    readonly page: Page;
    readonly ledger: () => ReturnType<SafetyLedger['snapshot']>;
    close(): Promise<void>;
  }> => {
    const factory = new BrowserContextFactory(browser, createTestConfig(o.A, '/'), () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
    factories.push(factory);
    if (scenario === 'Interaction') {
      const session = await factory.createInteractionSession(VIEWPORT);
      return { page: session.page, ledger: () => session.ledger.snapshot(), close: () => session.close() };
    }
    const context = await factory.createPassiveContext(VIEWPORT);
    const page = await factory.createPassivePage(context);
    return { page, ledger: () => factory.getSafetyLedger(context).snapshot(), close: () => factory.closePassiveContext(context) };
  };

  /** DEF-209・DEF-215: `origin` の `AUDIT_PAGE_PATH` を、本番と同じ作りの Page Auditor（読み込みの間隔は `NAVIGATION_INTERVAL_MS`）で監査する。 */
  const auditPage = async (origin: string, collectors: Partial<PageAuditCollectors> = {}): Promise<AuditedPage> => {
    const screenshotRootDirectory = await mkdtemp(join(tmpdir(), 'beaksight-stress-connect-'));
    try {
      const config = createTestConfig(origin, AUDIT_PAGE_PATH, {
        crawl: { minNavigationIntervalMs: NAVIGATION_INTERVAL_MS },
        viewports: { stressWidths: STRESS_WIDTHS },
        audit: { performance: false, accessibility: false, screenshots: false, interactions: false },
      });
      const navigationPacer = createTestNavigationPacer(config);
      const allocator = new IdAllocator();
      const contextFactory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), { ...TEST_FACTORY_OPTIONS, navigationPacer });
      factories.push(contextFactory);
      const auditor = new PageAuditor({
        contextFactory,
        config,
        allocator,
        clock: () => new Date(),
        now: () => Date.now(),
        screenshotRootDirectory,
        navigationPacer,
        safetyViolationRecorded: () => false,
        collectors,
      });
      const normalized = normalizeUrl(`${origin}${AUDIT_PAGE_PATH}`, `${origin}${AUDIT_PAGE_PATH}`, new Set());
      if (!normalized.ok) {
        throw new Error('the page URL must normalize');
      }
      return { outcome: await auditor.audit(normalized.url, allocator.allocatePageId()), pageUrl: normalized.url };
    } finally {
      await rm(screenshotRootDirectory, { recursive: true, force: true });
    }
  };

  // RB-4b（設計書 3.2 の X10・X13）: 監査するサイトの外の宛先（ここでは U）への CONNECT は、待たずに通す（ブラウザ自身の外への接続を止めない）。拒む記録は残らない。
  // サイトの宛先への、Guard が通していない CONNECT を拒むことは、ずれの確かめ（`tests/contract/pass-through-paths.test.ts` の中継の代表）に移す。
  it.each(SCENARIOS)('%s: the usual loads pass, and a CONNECT to a destination outside the site passes without a record', async (scenario) => {
    site = await startHttpsSite();
    const o = origins(site);
    const opened = await open(scenario, o);
    let title = '';
    let connectAnswer = '';
    let tunnelRecords: readonly string[] = [];
    let violations: readonly unknown[] = [];
    try {
      await opened.page.goto(`${o.A}/page-public`);
      await opened.page.waitForFunction(() => document.title.startsWith('done:') || document.title.startsWith('err:'), undefined, {
        timeout: PAGE_DONE_TIMEOUT_MS,
      }).catch(() => undefined);
      title = await opened.page.title();
      await wait(LATE_DELIVERY_SETTLE_MS);
      const proxyServer = proxyServers.get(opened.page.context());
      expect(proxyServer).toBeDefined();
      connectAnswer = await connectThrough(proxyServer ?? '', `127.0.0.1:${site.servers.U.port}`);
      const snapshot = opened.ledger();
      tunnelRecords = snapshot.blockedInteractionRequests
        .filter(({ method }) => method === 'CONNECT')
        .map(({ method, url, reason }) => `${method} ${url} ${reason}`);
      violations = snapshot.invariantViolations;
      console.info(`DEF-125 ${launcherName} / ${scenario}: ${JSON.stringify({
        title,
        connectAnswer,
        received: site.received,
        blocked: snapshot.blockedRequests.map(({ method, url, reason }) => `${method} ${url} ${reason}`),
        tunnelRecords,
      })}`);
    } finally {
      await opened.close();
    }
    await wait(LATE_DELIVERY_SETTLE_MS);

    expect(title).toBe(EXPECTED_TITLE);
    expect(site.received).toEqual(expect.arrayContaining(['A GET /page-public', ...EXPECTED_REQUESTS]));
    expect(connectAnswer).toBe('HTTP/1.1 200 Connection Established');
    // 拒んだ CONNECT の記録は残らない（ふだんの読み込みの CONNECT も拒まれない）。
    expect(tunnelRecords.filter((line) => line.includes(`127.0.0.1:${site?.servers.U.port ?? ''}`))).toEqual([]);
    expect(violations).toEqual([]);
  }, SCENARIO_TIMEOUT_MS);

  // RB-4b: WebRTC の TURN の TCP を中継で拒む場面は外した（凍結しない Context では WebRTC を止めず、サイトの外の宛先への CONNECT も通すため。ユーザーの
  // 判断 2026-11-15）。止める先がないので、別の所の確かめはない（凍結しうる Context の WebRTC の止めは、初期化のスクリプトで残る）。

  // DEF-209: 幅の走査は、読み込みの間隔を待ってから、その幅の Context を作る。間隔が中継の待ちより長くても、安全の Evidence に CONNECT の拒否が残らず、
  // サーバに届いた要求は読み込みの分だけ。
  it('DEF-209: the stress sweep of a page audit leaves no CONNECT rejection and sends only the page loads', async () => {
    const received: string[] = [];
    const audited = await (async () => {
      const server = await startRecordingHttpsServer(received);
      try {
        return await auditPage(server.origin);
      } finally {
        await server.close();
      }
    })();

    const [layout] = audited.outcome.result.evidence.filter((record): record is EvidenceRecordFor<'layout'> => record.type === 'layout' && record.viewport === 'desktop');
    expect(layout?.payload.stressSweep?.map(({ width, status }) => [width, status])).toEqual([...STRESS_WIDTHS].reverse().map((width) => [width, 'COMPLETE']));
    expect(connectRecordsOf(audited.outcome)).toEqual([]);
    expect(safetyRuleIdsOf(audited)).toEqual([]);
    expect(received).toEqual(Array.from({ length: PAGE_LOADS }, () => `GET ${AUDIT_PAGE_PATH}`));
  }, AUDIT_TIMEOUT_MS);

  // DEF-215: 中継が CONNECT の受け入れで拒んだ、要求の前の接続（Guard が通した要求がまだない宛先へ、Chromium が先に張ろうとした接続）は、拒否の動きと記録
  // （`CONNECT`・`GUARD_BYPASS_EGRESS`）はそのままに印 `preRequestConnection` を付け、読み取り以外の送信の遮断の指摘にしない。要求の前の接続は、Desktop の
  // 読み込みの後に、その Context の中継へ、許可の外の Origin への生の CONNECT を送って起こす（ページの `<link rel="preconnect">` では、どちらの Chromium も
  // 中継に CONNECT を張らなかった）。その Origin には何も届かない。
  it('DEF-215: a connection before any request is recorded apart, is no safety finding, and reaches nothing outside the allowed origins', async () => {
    const received: string[] = [];
    const otherReceived: string[] = [];
    const other = await startRecordingHttpsServer(otherReceived);
    const server = await startRecordingHttpsServer(received);
    const otherAuthority = new URL(other.origin).host;
    const connectAnswers: string[] = [];
    let audited: AuditedPage;
    try {
      audited = await auditPage(server.origin, {
        collectDomEvidence: async (page, ...rest) => {
          if (connectAnswers.length === 0) {
            connectAnswers.push(await connectThrough(proxyServers.get(page.context()) ?? '', otherAuthority));
          }
          return await collectDomEvidence(page, ...rest);
        },
      });
    } finally {
      await server.close();
      await other.close();
    }

    // RB-4b: 許可の外の Origin（監査するサイトの外）への CONNECT は、待たずに通す（記録しない）。
    expect(connectAnswers).toEqual(['HTTP/1.1 200 Connection Established']);
    expect(connectRecordsOf(audited.outcome)).toEqual([]);
    // 読み取り以外の送信の遮断の指摘にならない（ほかの安全の指摘も出ない）。
    expect(safetyRuleIdsOf(audited)).toEqual([]);
    // 許可の外の Origin には何も届かず、サイトに届いたのは読み込みの分だけ。
    expect(otherReceived).toEqual([]);
    expect(received).toEqual(Array.from({ length: PAGE_LOADS }, () => `GET ${AUDIT_PAGE_PATH}`));
  }, AUDIT_TIMEOUT_MS);
});
