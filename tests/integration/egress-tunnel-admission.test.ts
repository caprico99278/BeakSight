// DEF-125: 出口の中継は、その Context の Guard が通した要求の宛先（host とポート）への CONNECT だけを通し、ほかの CONNECT は拒んで、Safety Ledger に
// 記録する（`blockedInteractionRequests` の `CONNECT <host>:<port>`、理由 `GUARD_BYPASS_EGRESS`。値は残らない）。本物の factory と Guard と、
// 127.0.0.1 の https の自前のサーバ（テストだけの証明書。ブラウザは証明書の誤りを無視する起動の引数）で確かめる。Chromium は headless だけ
// （テストの既定の headless shell と、CLI の起動の設定の両方）。インターネットには出ない（宛先は 127.0.0.1 だけ）。
// - ふだんの読み込みは今どおり通る: 公開の監査（範囲の外の静的な資源、別の Origin へのリダイレクト、別の Origin の iframe、Worker の fetch、
//   事前確認のある fetch）、Interaction、ログインの段（token の送信と、承認したサービスの Origin の読み取り）、監査の段（承認したサービスの Origin と
//   範囲の外の静的な資源）、発見（落ち着きの待ちと凍結が読み切れる）、書き込みの段の読み込み。どの場面でも、拒んだ CONNECT の記録は、下の直接の
//   CONNECT の 1 件だけ（ふだんの読み込みの CONNECT は拒まれない）。
// - Guard が通していない宛先への CONNECT（中継に直接送る）は `403` で拒まれ、その宛先に接続が届かず、記録される。
// 書き込みの段の承認の POST の https の送信（送り手が中継の CONNECT を通る）は、`write-create-run.test.ts` の https の回で確かめる。
import { connect as netConnect } from 'node:net';
import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BrowserContextFactory, type AuditStageServiceRequests } from '../../src/browser/context-factory.js';
import type { Viewport } from '../../src/config/types.js';
import { wait } from '../../src/core/deadline.js';
import { createServiceRequestBudget } from '../../src/crawl/service-request-budget.js';
import { discoverPageCandidates } from '../../src/discovery/discover-page.js';
import { AuditStageMonitor, LoginStageMonitor, WriteStageMonitor } from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { browserWithoutWebRtcBlock, overrideBrowser } from '../helpers/browser-proxies.js';
import { closeTestContexts, launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { TEST_FACTORY_OPTIONS, createTestConfig } from '../helpers/test-config.js';
import { LOOPBACK_TEST_CERTIFICATE, LOOPBACK_TEST_KEY, TEST_BROWSER_IGNORE_CERTIFICATE_ERRORS_ARGS } from '../helpers/tls-test-certificate.js';

const LAUNCHERS = [
  ['the default test Chromium', () => launchHeadlessChromium({ args: TEST_BROWSER_IGNORE_CERTIFICATE_ERRORS_ARGS })],
  ['the CLI launch settings', () => launchCliChromium({ args: TEST_BROWSER_IGNORE_CERTIFICATE_ERRORS_ARGS })],
] as const;

const VIEWPORT: Viewport = Object.freeze({ width: 1280, height: 800 });
/** ページの JS が、すべての読み込みを終えて `document.title` に結果を書くのを待つ上限（ms）。 */
const PAGE_DONE_TIMEOUT_MS = 15_000;
/** ページの読み込みの後、遅れて来る要求と CONNECT を待つ時間（ms）。 */
const LATE_DELIVERY_SETTLE_MS = 1_000;
/** 直接の CONNECT の答えを待つ上限（ms）。期限ではなく、確かめのための余裕である（中継の知らせの待ちより長い）。 */
const CONNECT_ANSWER_TIMEOUT_MS = 15_000;
/** 1 つの場面の期限（ms）。 */
const SCENARIO_TIMEOUT_MS = 90_000;
/** 拒んだ CONNECT の記録の理由。 */
const TUNNEL_REJECTION_REASON = 'GUARD_BYPASS_EGRESS';
/** 1×1 の PNG。 */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** サイトの Origin の名前: A は許可 Origin、B は範囲の外（別の Origin の静的な資源と読み取り）、T は token、S は承認したサービス、U は誰も通さない宛先。 */
const SITE_NAMES = ['A', 'B', 'T', 'S', 'U'] as const;
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
  // 発見は、別の Origin の iframe を読み切れない（`INCOMPLETE_FRAME_OR_CLOSED_SHADOW`）ので、iframe のない形にする。
  discovery: (o: Record<SiteName, string>): string => `
    <img src="${o.B}/x.png"><img src="${o.A}/redir"><script src="${o.B}/s.js"></script>
    <script>
      fetch('${o.B}/api', { headers: { 'X-Test': '1' } }).then((r) => r.text())
        .then((t) => { document.title = 'done:' + t; }, (error) => { document.title = 'err:' + error; });
    </script>`,
  login: (o: Record<SiteName, string>): string => `
    <script>
      fetch('${o.T}/token?grant_type=password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
        .then((r) => r.text())
        .then(() => fetch('${o.S}/api', { headers: { 'X-Test': '1' } }))
        .then((r) => r.text())
        .then((t) => { document.title = 'done:' + t; }, (error) => { document.title = 'err:' + error; });
    </script>`,
  audit: (o: Record<SiteName, string>): string => `
    <img src="${o.B}/x.png"><script src="${o.B}/s.js"></script>
    <script>
      fetch('${o.S}/api', { headers: { authorization: 'Bearer def125' } })
        .then((r) => r.text())
        .then((t) => { document.title = 'done:' + t; }, (error) => { document.title = 'err:' + error; });
    </script>`,
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
      if (path === '/token') {
        response.writeHead(200, { ...cors, 'content-type': 'application/json' });
        response.end('{"access_token":"def125"}');
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

/** 場面（Context の種類と、読み込むページ）。 */
const SCENARIOS = ['public audit', 'Interaction', 'login stage', 'audit stage', 'discovery', 'write stage'] as const;
type Scenario = (typeof SCENARIOS)[number];

const PAGE_OF: Readonly<Record<Scenario, PageKind>> = {
  'public audit': 'public',
  Interaction: 'public',
  'login stage': 'login',
  'audit stage': 'audit',
  discovery: 'discovery',
  'write stage': 'write',
};

/** 場面ごとの、届くはずの要求（ページの文書のほか。並びは問わない。事前確認は Guard が満たすので届かない）。 */
const EXPECTED_REQUESTS: Readonly<Record<PageKind, readonly string[]>> = {
  public: ['B GET /x.png', 'A GET /redir', 'B GET /y.png', 'B GET /s.js', 'B GET /frame', 'B GET /api', 'B GET /w'],
  discovery: ['B GET /x.png', 'A GET /redir', 'B GET /y.png', 'B GET /s.js', 'B GET /api'],
  login: ['T POST /token', 'S GET /api'],
  audit: ['B GET /x.png', 'B GET /s.js', 'S GET /api'],
  write: ['A GET /x.png'],
};
const EXPECTED_TITLE: Readonly<Record<PageKind, string>> = {
  public: 'done:api,w',
  discovery: 'done:api',
  login: 'done:api',
  audit: 'done:api',
  write: 'done:1',
};

describe.each(LAUNCHERS)('DEF-125: the egress proxy admits CONNECT only to the destinations the Guard let through (%s)', (launcherName, launch) => {
  let realBrowser: Browser;
  let browser: Browser;
  const proxyServers = new WeakMap<BrowserContext, string>();
  const factories: BrowserContextFactory[] = [];
  let site: HttpsSite | undefined;

  beforeAll(async () => {
    realBrowser = await launch();
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

  const auditStageOf = (o: Record<SiteName, string>): AuditStageServiceRequests => ({
    approvedServiceOrigins: [o.S],
    auditReadRequests: [],
    scriptLogin: { origin: o.T, path: '/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] },
    serviceRequestLimits: { perMinute: 120, perRun: 600 },
  });

  /** `scenario` の Context を本物の factory で開き、page と Ledger と閉じる処理を返す。 */
  const open = async (scenario: Scenario, o: Record<SiteName, string>): Promise<{
    readonly page: Page;
    readonly ledger: () => ReturnType<SafetyLedger['snapshot']>;
    close(): Promise<void>;
  }> => {
    const authenticated = scenario === 'audit stage' || scenario === 'write stage';
    const config = createTestConfig(o.A, '/');
    const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), {
      ...TEST_FACTORY_OPTIONS,
      ...(authenticated
        ? {
          authentication: {
            initialState: { cookies: [], origins: [] },
            filterState: (state) => state,
            auditExclusions: { excludedPathPrefixes: [], auditPathPrefixes: [], dangerousTerms: [] },
            ...(scenario === 'audit stage' ? { auditStage: auditStageOf(o) } : {}),
          },
          ...(scenario === 'audit stage'
            ? { serviceRequestBudget: createServiceRequestBudget({ perMinute: 120, perRun: 600, now: () => Date.now() }), auditStageMonitor: new AuditStageMonitor() }
            : {}),
        }
        : {}),
    });
    factories.push(factory);
    if (scenario === 'Interaction') {
      const session = await factory.createInteractionSession(VIEWPORT);
      return { page: session.page, ledger: () => session.ledger.snapshot(), close: () => session.close() };
    }
    let context: BrowserContext;
    if (scenario === 'login stage') {
      context = await factory.createLoginStageContext(VIEWPORT, {
        loginPostEndpoints: [],
        maxLoginPosts: 1,
        monitor: new LoginStageMonitor(),
        scriptRequest: {
          scriptLogin: { origin: o.T, path: '/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] },
          loginSideRequests: [],
          approvedServiceOrigins: [o.S, o.T],
        },
      });
    } else if (scenario === 'write stage') {
      context = await factory.createWriteStageContext(VIEWPORT, {
        expectation: {
          request: { origin: o.A, path: '/create', enctype: 'application/x-www-form-urlencoded' },
          submittedFields: [{ name: 'memo', value: 'def125' }],
          passthroughFieldNames: [],
          emptyFileFieldNames: [],
        },
        monitor: new WriteStageMonitor(),
      });
    } else {
      context = await factory.createPassiveContext(VIEWPORT);
    }
    const page = await factory.createPassivePage(context);
    return { page, ledger: () => factory.getSafetyLedger(context).snapshot(), close: () => factory.closePassiveContext(context) };
  };

  it.each(SCENARIOS)('%s: the usual loads pass, and a CONNECT to a destination the Guard did not let through is rejected and recorded', async (scenario) => {
    site = await startHttpsSite();
    const o = origins(site);
    const kind = PAGE_OF[scenario];
    const opened = await open(scenario, o);
    let title = '';
    let connectAnswer = '';
    let tunnelRecords: readonly string[] = [];
    let violations: readonly unknown[] = [];
    let incompleteReasons: readonly string[] = [];
    try {
      await opened.page.goto(`${o.A}/page-${kind}`);
      await opened.page.waitForFunction(() => document.title.startsWith('done:') || document.title.startsWith('err:'), undefined, {
        timeout: PAGE_DONE_TIMEOUT_MS,
      }).catch(() => undefined);
      title = await opened.page.title();
      await wait(LATE_DELIVERY_SETTLE_MS);
      const proxyServer = proxyServers.get(opened.page.context());
      expect(proxyServer).toBeDefined();
      connectAnswer = await connectThrough(proxyServer ?? '', `127.0.0.1:${site.servers.U.port}`);
      if (scenario === 'discovery') {
        incompleteReasons = (await discoverPageCandidates(opened.page, { classificationPolicy: { allowedOrigins: new Set([o.A]) } })).incompleteReasons;
      }
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

    expect(title).toBe(EXPECTED_TITLE[kind]);
    expect(site.received).toEqual(expect.arrayContaining([`A GET /page-${kind}`, ...EXPECTED_REQUESTS[kind]]));
    expect(incompleteReasons).toEqual([]);
    expect(connectAnswer).toBe('HTTP/1.1 403 Forbidden');
    expect(site.uConnections()).toBe(0);
    expect(site.received.filter((line) => line.startsWith('U '))).toEqual([]);
    // 拒んだ CONNECT は、直接送った 1 件だけ（ふだんの読み込みの CONNECT は拒まれない）。
    expect(tunnelRecords).toEqual([`CONNECT 127.0.0.1:${site.servers.U.port} ${TUNNEL_REJECTION_REASON}`]);
    expect(violations).toEqual([]);
  }, SCENARIO_TIMEOUT_MS);

  it('the TCP of WebRTC (TURN over TCP) that does not go through the Guard is rejected at CONNECT and recorded, even without the DEF-124 init script', async () => {
    site = await startHttpsSite();
    const o = origins(site);
    const factory = new BrowserContextFactory(browserWithoutWebRtcBlock(browser), createTestConfig(o.A, '/'), () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
    factories.push(factory);
    const context = await factory.createPassiveContext(VIEWPORT);
    let result = '';
    let tunnelRecords: readonly string[] = [];
    try {
      const page = await factory.createPassivePage(context);
      await page.goto(`${o.A}/page-write`);
      result = String(await page.evaluate(`(async () => {
        try {
          const connection = new RTCPeerConnection({ iceServers: [{ urls: 'turn:127.0.0.1:${site?.servers.U.port}?transport=tcp', username: 'def125', credential: 'def125' }] });
          connection.createDataChannel('def125');
          await connection.setLocalDescription(await connection.createOffer());
          globalThis.__def125 = connection;
          return 'ok';
        } catch (error) {
          return 'threw:' + error.message;
        }
      })()`));
      // 中継の知らせの待ち（`EGRESS_TUNNEL_ADMISSION_WAIT_MS`）より長く待つ。
      await wait(CONNECT_ANSWER_TIMEOUT_MS / 3);
      tunnelRecords = factory.getSafetyLedger(context).snapshot().blockedInteractionRequests
        .filter(({ method }) => method === 'CONNECT')
        .map(({ method, url, reason }) => `${method} ${url} ${reason}`);
    } finally {
      await factory.closePassiveContext(context);
    }
    await wait(LATE_DELIVERY_SETTLE_MS);
    console.info(`DEF-125 ${launcherName} / WebRTC TURN over TCP: ${JSON.stringify({ result, uConnections: site.uConnections(), tunnelRecords })}`);
    // 入口が開いていること（DEF-124 の守りを外したこと）を確かめ、中継が U への CONNECT を拒んで記録したことを確かめる。
    expect(result).toBe('ok');
    expect(site.uConnections()).toBe(0);
    expect(tunnelRecords).toContain(`CONNECT 127.0.0.1:${site.servers.U.port} ${TUNNEL_REJECTION_REASON}`);
  }, SCENARIO_TIMEOUT_MS);
});
