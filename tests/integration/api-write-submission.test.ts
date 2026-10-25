// T39c（Task 39 の設計書 3.4、4 章、5 章の 1・2・4）: API のシナリオの書き込みの段の送り手（Guard が照合に一致した 1 回だけを、同じ本文の bytes で、
// 中継を通して送り、応答をページに返す）と、中継の予算と方針。通す部品（どれも本物。Chromium はテストの既定の headless と、CLI の起動の設定の両方）:
// 認証つきの `BrowserContextFactory` の `createWriteStageContext`（送り方 `API`。送り手の口は Guard の既定の送り手）、その Guard と中継、
// `sendWriteSubmissionOnce`（fetch の形）。サイトはこのテストの中の 127.0.0.1 のサーバ（アプリの http と、API の http と https）。
// - 一致する CREATE（http と https）と UPDATE は、サーバに 1 回だけ届き、応答がページに返り、ページの JS が成功を表示する。2 回目は届かない。
// - 応答の本文から、登録の ID の取り方の鍵で ID を取り出す口（`recordIdOf`）が、使える形の ID を返す。
// - 送り手の失敗（接続が切れる、時間切れ）では再送しない（サーバに 1 回だけ届く）。
// - `Authorization` と応答の本文は、Safety Ledger と書き込みの段の記録と送信の報告に出ない。
// - 中継の予算: 送り手の 1 回の後に、中継へ直に送った同じ形の要求は止まり、記録される。
// - 照合が止める形（値の書き換え）は、本物の送り手でも 0 回。
// - T39R-fix: 窓の前に登録した読み取りの手続きを http で呼んでも、中継の予算（承認の endpoint だけを数える）は残り、承認の書き込みが届く（M-1）。
//   窓の中の手続きの呼び出しは、照合にかけずに止まり（サーバに届かない）、その後の承認の書き込みが 1 回届く（M-2）。
// 届いたかは API のサーバの記録で数える。各場面の終わりに、名前つきの時間（`LATE_DELIVERY_SETTLE_MS`）だけ待ってから数え直す。値は出力しない。
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { apiRecordIdOfResponseBody } from '../../src/control/actions/api-record-id.js';
import { createServiceRequestBudget } from '../../src/crawl/service-request-budget.js';
import type { ApiWritePayloadExpectation } from '../../src/safety/api-write-payload-policy.js';
import { AuditStageMonitor, WriteStageMonitor, type GuardApiWriteStage } from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { overrideBrowser } from '../helpers/browser-proxies.js';
import { closeTestContexts, launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { startLoopbackHttpServer } from '../helpers/loopback-server.js';
import { TEST_FACTORY_OPTIONS, createTestConfig } from '../helpers/test-config.js';
import { LOOPBACK_TEST_CERTIFICATE, LOOPBACK_TEST_KEY, TEST_BROWSER_IGNORE_CERTIFICATE_ERRORS_ARGS } from '../helpers/tls-test-certificate.js';

const LAUNCHERS: readonly (readonly [string, () => Promise<Browser>])[] = [
  ['the default test Chromium', () => launchHeadlessChromium({ args: TEST_BROWSER_IGNORE_CERTIFICATE_ERRORS_ARGS })],
  ['the CLI Chromium', () => launchCliChromium({ args: TEST_BROWSER_IGNORE_CERTIFICATE_ERRORS_ARGS })],
];
const VIEWPORT = Object.freeze({ width: 1280, height: 800 });
const TEST_TIMEOUT_MS = 120_000;
const UI_TIMEOUT_MS = 15_000;
/** 各場面の終わりに、遅れて届く要求を待つ時間（ms）。 */
const LATE_DELIVERY_SETTLE_MS = 1_500;
/** 送り手の時間切れ（製品の `WRITE_SUBMISSION_TIMEOUT_MS`）を待つ上限（ms）。 */
const SENDER_TIMEOUT_WAIT_MS = 40_000;
const MEMBERS_PATH = '/rest/v1/members';
const VALUES = Object.freeze({ name: '試験 太郎', email: 't39c@example.test' });
/** ページの JS が付ける Bearer の目印（記録に出ないことを確かめる）。 */
const BEARER_MARKER = 't39c-bearer-marker';
/** 応答の本文の目印（記録に出ないことを確かめる）と、応答の ID。 */
const RESPONSE_MARKER = 't39c-response-marker';
const RESPONSE_RECORD_ID = 'rec-1001';
const PREFER = 'return=representation';
/** T39R-fix: 登録した読み取りの手続きの呼び出しの path（監査の段の口）と、要求の上限。 */
const RPC_PATH = '/rest/v1/rpc/search';
const SERVICE_LIMITS = Object.freeze({ perMinute: 120, perRun: 600 });

type ApiMode = 'ok' | 'drop' | 'hang';

interface ApiServer {
  readonly origin: string;
  readonly received: { readonly method: string; readonly url: string }[];
  mode: ApiMode;
  close(): Promise<void>;
}

/** API のサーバ（`MEMBERS_PATH` への書き込みを数え、`mode` で答える。事前確認は Guard が満たすので来ない）。 */
async function startApiServer(tls: boolean, appOrigin: () => string): Promise<ApiServer> {
  const state: ApiServer = { origin: '', received: [], mode: 'ok', close: async () => undefined };
  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    request.resume();
    request.on('end', () => {
      state.received.push({ method: request.method ?? '', url: request.url ?? '' });
      if (state.mode === 'drop') {
        request.socket.destroy();
        return;
      }
      if (state.mode === 'hang') {
        return;
      }
      response.writeHead(201, {
        'content-type': 'application/json',
        'access-control-allow-origin': appOrigin(),
        'access-control-allow-headers': 'authorization, content-type, prefer',
        'access-control-allow-methods': 'POST, PATCH',
      });
      response.end(JSON.stringify([{ id: RESPONSE_RECORD_ID, note: RESPONSE_MARKER }]));
    });
  };
  const server = await startLoopbackHttpServer(handler, { tls: tls ? { cert: LOOPBACK_TEST_CERTIFICATE, key: LOOPBACK_TEST_KEY } : undefined });
  server.server.on('secureConnection', (socket: Socket) => socket.on('error', () => undefined));
  (state as { origin: string }).origin = server.origin;
  state.close = () => server.close();
  return state;
}

/** アプリのページ（欄 2 つと保存のボタン。押すと fetch で API に送り、応答の ID を `#result` に出す）。 */
const pageHtml = (apiOrigin: string, method: 'POST' | 'PATCH', recordId: string | null): string => `<!doctype html><html><body>
<input id="name"><input id="email"><button id="save" type="button">保存</button><p id="result" data-state="idle"></p>
<script>
document.getElementById('save').addEventListener('click', async () => {
  const result = document.getElementById('result');
  try {
    const response = await fetch(${JSON.stringify(`${apiOrigin}${MEMBERS_PATH}${recordId === null ? '' : `?id=eq.${recordId}`}`)}, {
      method: ${JSON.stringify(method)},
      headers: { 'content-type': 'application/json', authorization: 'Bearer ${BEARER_MARKER}', prefer: ${JSON.stringify(PREFER)} },
      body: JSON.stringify({ name: document.getElementById('name').value, email: document.getElementById('email').value }),
    });
    const rows = response.ok ? await response.json() : [];
    result.textContent = rows.length === 1 ? rows[0].id : '';
    result.dataset.state = response.ok ? 'saved' : 'error';
  } catch (error) {
    result.dataset.state = 'error';
  }
});
</script></body></html>`;

describe.each(LAUNCHERS)('T39c: the API write sender of the write stage with %s', (_label, launch) => {
  let realBrowser: Browser;
  let browser: Browser;
  const proxyServers = new WeakMap<BrowserContext, string>();
  const cleanups: (() => Promise<void>)[] = [];
  const factories: BrowserContextFactory[] = [];

  beforeAll(async () => {
    realBrowser = await launch();
    // 中継に直に送る確かめのため、Context の proxy の server を覚える（製品のコードは変えない）。
    browser = overrideBrowser(realBrowser, {
      newContext: async (options?: BrowserContextOptions): Promise<BrowserContext> => {
        const context = await realBrowser.newContext(options);
        if (options?.proxy?.server !== undefined) proxyServers.set(context, options.proxy.server);
        return context;
      },
    });
  });

  afterEach(async () => {
    await Promise.all(factories.splice(0).map((factory) => factory.close()));
    await closeTestContexts(realBrowser);
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  afterAll(async () => {
    await realBrowser?.close();
  });

  /** アプリと API のサーバを起動し、API の書き込みの段の Context でページを開く。 */
  const openStage = async (options: {
    readonly tls?: boolean;
    readonly kind?: 'CREATE' | 'UPDATE';
    readonly mode?: ApiMode;
    /** T39R-fix: 監査の段の口（承認したサービスの Origin と、登録した読み取りの手続きの呼び出し `RPC_PATH`）を渡す。 */
    readonly auditRpc?: boolean;
  } = {}) => {
    const kind = options.kind ?? 'CREATE';
    const method = kind === 'CREATE' ? 'POST' : 'PATCH';
    const recordId = kind === 'CREATE' ? null : '1001';
    let appOrigin = '';
    const api = await startApiServer(options.tls === true, () => appOrigin);
    api.mode = options.mode ?? 'ok';
    cleanups.push(() => api.close());
    const app = await startLoopbackHttpServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(pageHtml(api.origin, method, recordId));
    });
    appOrigin = app.origin;
    cleanups.push(() => app.close());
    const factory = new BrowserContextFactory(browser, createTestConfig(appOrigin, '/'), () => new SafetyLedger(), {
      ...TEST_FACTORY_OPTIONS,
      authentication: {
        initialState: { cookies: [], origins: [] },
        filterState: (state) => state,
        auditExclusions: { excludedPathPrefixes: [], auditPathPrefixes: [], dangerousTerms: [] },
        ...(options.auditRpc === true
          ? {
            auditStage: {
              approvedServiceOrigins: [api.origin],
              auditReadRequests: [{ origin: api.origin, path: RPC_PATH, method: 'POST', maxPerPageLoad: 5 }],
              scriptLogin: { origin: api.origin, path: '/auth/v1/token', requiredQuery: [] },
              serviceRequestLimits: SERVICE_LIMITS,
            },
          }
          : {}),
      },
      ...(options.auditRpc === true
        ? { serviceRequestBudget: createServiceRequestBudget({ ...SERVICE_LIMITS, now: () => Date.now() }), auditStageMonitor: new AuditStageMonitor() }
        : {}),
      writeSubmissionCertificates: [LOOPBACK_TEST_CERTIFICATE],
    });
    factories.push(factory);
    const expectation: ApiWritePayloadExpectation = {
      spec: {
        request: { method, origin: api.origin, pathShape: MEMBERS_PATH, queryNames: [], contentType: 'application/json', prefer: [PREFER] },
        keyFields: [{ key: 'email', type: 'string' }, { key: 'name', type: 'string' }],
        pageKeys: [],
        headerNames: ['authorization', 'content-type', 'prefer'],
        filterName: kind === 'CREATE' ? null : 'id',
      },
      values: VALUES,
      recordId,
    };
    const monitor = new WriteStageMonitor();
    const stage: GuardApiWriteStage = {
      transport: 'API',
      expectation,
      monitor,
      // Task 40 の口: 応答の本文から、登録の ID の取り方の鍵で ID を取り出す（メモリの中だけ）。
      recordIdOf: (body) => apiRecordIdOfResponseBody(body, 'id'),
    };
    const context = await factory.createWriteStageContext(VIEWPORT, stage);
    const page = await factory.createPassivePage(context);
    await page.goto(`${appOrigin}/new`);
    return { api, page, monitor, context, ledger: factory.getSafetyLedger(context) };
  };

  const fillAndSave = async (page: Page, monitor: WriteStageMonitor, values: Record<string, string> = VALUES): Promise<void> => {
    await monitor.openSubmissionWindow(page);
    await page.fill('#name', values['name'] ?? '');
    await page.fill('#email', values['email'] ?? '');
    // T40R-fix-A: 値を入れる間は窓の観察の段。押す直前に送信の段を開く（書き込みの入力の部品と同じ順）。
    monitor.openSubmissionPhase();
    await page.click('#save');
  };
  const resultState = (page: Page): Promise<string | null> => page.locator('#result').getAttribute('data-state').catch(() => null);
  const writes = (api: ApiServer): readonly string[] => api.received.map(({ method, url }) => `${method} ${url}`);
  /** 記録（Safety Ledger、書き込みの段の記録、送信の報告）に、Bearer と応答の本文の目印が出ていないこと。 */
  const expectNoSecrets = (ledger: SafetyLedger, monitor: WriteStageMonitor): void => {
    const text = JSON.stringify([ledger.snapshot(), monitor.snapshot(), monitor.submissionReport()]);
    expect(text).not.toContain(BEARER_MARKER);
    expect(text).not.toContain(RESPONSE_MARKER);
  };

  it.each<[string, boolean, 'CREATE' | 'UPDATE']>([
    ['a CREATE over http', false, 'CREATE'],
    ['a CREATE over https', true, 'CREATE'],
    ['an UPDATE over http', false, 'UPDATE'],
  ])('sends %s once, returns the response to the page, and takes the record id', async (_name, tls, kind) => {
    const { api, page, monitor, ledger } = await openStage({ tls, kind });
    await fillAndSave(page, monitor);
    await expect.poll(() => resultState(page), { timeout: UI_TIMEOUT_MS }).toBe('saved');
    expect(await page.textContent('#result')).toBe(RESPONSE_RECORD_ID);
    // 2 回目（同じ画面でもう一度押す）は届かない。
    await page.click('#save');
    await page.waitForTimeout(LATE_DELIVERY_SETTLE_MS);
    const expectedUrl = kind === 'CREATE' ? MEMBERS_PATH : `${MEMBERS_PATH}?id=eq.1001`;
    expect(writes(api)).toEqual([`${kind === 'CREATE' ? 'POST' : 'PATCH'} ${expectedUrl}`]);
    expect(monitor.submissionReport()).toMatchObject({ submission: 'SENT', sendAttempts: 1, sendOutcome: 'RESPONDED', responseReceived: true, responseStatus: 201 });
    expect(monitor.apiWriteRecordId()).toBe(RESPONSE_RECORD_ID);
    expectNoSecrets(ledger, monitor);
  }, TEST_TIMEOUT_MS);

  it('does not send again when the connection closes before a response (NO_RESPONSE)', async () => {
    const { api, page, monitor, ledger } = await openStage({ mode: 'drop' });
    await fillAndSave(page, monitor);
    await expect.poll(() => resultState(page), { timeout: UI_TIMEOUT_MS }).toBe('error');
    await page.waitForTimeout(LATE_DELIVERY_SETTLE_MS);
    expect(writes(api)).toEqual([`POST ${MEMBERS_PATH}`]);
    expect(monitor.submissionReport()).toMatchObject({ submission: 'SENT', sendAttempts: 1, sendOutcome: 'NO_RESPONSE' });
    expect(monitor.apiWriteRecordId()).toBeNull();
    expectNoSecrets(ledger, monitor);
  }, TEST_TIMEOUT_MS);

  it('does not send again when the sender times out (NO_RESPONSE)', async () => {
    const { api, page, monitor } = await openStage({ mode: 'hang' });
    await fillAndSave(page, monitor);
    await expect.poll(() => resultState(page), { timeout: SENDER_TIMEOUT_WAIT_MS, interval: 1_000 }).toBe('error');
    await page.waitForTimeout(LATE_DELIVERY_SETTLE_MS);
    expect(writes(api)).toEqual([`POST ${MEMBERS_PATH}`]);
    expect(monitor.submissionReport()).toMatchObject({ submission: 'SENT', sendAttempts: 1, sendOutcome: 'NO_RESPONSE' });
  }, TEST_TIMEOUT_MS);

  it('stops a write sent straight to the egress proxy after the one of the sender (the request budget), and records it', async () => {
    const { api, page, monitor, context, ledger } = await openStage();
    await fillAndSave(page, monitor);
    await expect.poll(() => resultState(page), { timeout: UI_TIMEOUT_MS }).toBe('saved');
    const proxyUrl = new URL(proxyServers.get(context) ?? 'http://127.0.0.1:9');
    const status = await new Promise<number>((resolvePromise) => {
      const request = httpRequest({
        host: proxyUrl.hostname, port: Number(proxyUrl.port), method: 'POST', path: `${api.origin}${MEMBERS_PATH}`,
        headers: { host: new URL(api.origin).host, 'content-type': 'application/json', connection: 'close' },
      }, (response) => {
        response.resume();
        response.on('end', () => resolvePromise(response.statusCode ?? 0));
      });
      request.on('error', () => resolvePromise(0));
      request.end(JSON.stringify(VALUES));
    });
    await page.waitForTimeout(LATE_DELIVERY_SETTLE_MS);
    expect(status).toBe(403);
    expect(writes(api)).toEqual([`POST ${MEMBERS_PATH}`]);
    expect(ledger.snapshot().blockedInteractionRequests.map(({ method, url, reason }) => `${method} ${new URL(url).pathname} ${reason}`))
      .toContain(`POST ${MEMBERS_PATH} GUARD_BYPASS_EGRESS`);
  }, TEST_TIMEOUT_MS);

  it('still sends nothing for a write the check stops (a value rewritten), with the real sender', async () => {
    const { api, page, monitor } = await openStage();
    await fillAndSave(page, monitor, { name: '書き換え', email: VALUES.email });
    await expect.poll(() => resultState(page), { timeout: UI_TIMEOUT_MS }).toBe('error');
    await page.waitForTimeout(LATE_DELIVERY_SETTLE_MS);
    expect(writes(api)).toEqual([]);
    expect(monitor.snapshot().blockedByPayloadReason.BODY_VALUE_MISMATCH).toBe(1);
    expect(monitor.submissionReport()).toMatchObject({ submission: 'NOT_SENT', sendAttempts: 0 });
  }, TEST_TIMEOUT_MS);

  /** ページの main world から、登録した読み取りの手続きを 1 回呼ぶ（結果の状態の文字だけを返す）。 */
  const callRpc = (page: Page, apiOrigin: string): Promise<string> => page.evaluate(async (url) => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }).then((response) => `status:${String(response.status)}`, () => 'failed'), `${apiOrigin}${RPC_PATH}`);

  it('still sends the approved write after the registered read procedure was called once before the window over http (T39R-fix M-1: the egress budget counts the approved endpoint only)', async () => {
    const { api, page, monitor, ledger } = await openStage({ auditRpc: true });
    expect(await callRpc(page, api.origin)).toBe('status:201');
    await fillAndSave(page, monitor);
    await expect.poll(() => resultState(page), { timeout: UI_TIMEOUT_MS }).toBe('saved');
    await page.waitForTimeout(LATE_DELIVERY_SETTLE_MS);
    expect(writes(api)).toEqual([`POST ${RPC_PATH}`, `POST ${MEMBERS_PATH}`]);
    expect(monitor.submissionReport()).toMatchObject({ submission: 'SENT', sendAttempts: 1, sendOutcome: 'RESPONDED', responseStatus: 201 });
    expect(ledger.snapshot().blockedInteractionRequests).toEqual([]);
    expectNoSecrets(ledger, monitor);
  }, TEST_TIMEOUT_MS);

  it.each<[string, boolean]>([
    ['with the audit stage entry', true],
    ['without the audit stage entry', false],
  ])('blocks a procedure call in the window without the check and still sends the approved write once (T39R-fix M-2, %s)', async (_name, auditRpc) => {
    const { api, page, monitor, ledger } = await openStage({ auditRpc });
    await monitor.openSubmissionWindow(page);
    expect(await callRpc(page, api.origin)).toBe('failed');
    await page.fill('#name', VALUES.name);
    await page.fill('#email', VALUES.email);
    // T40R-fix-A: 押す直前に送信の段を開く。
    monitor.openSubmissionPhase();
    await page.click('#save');
    await expect.poll(() => resultState(page), { timeout: UI_TIMEOUT_MS }).toBe('saved');
    await page.waitForTimeout(LATE_DELIVERY_SETTLE_MS);
    expect(writes(api)).toEqual([`POST ${MEMBERS_PATH}`]);
    expect(Object.values(monitor.snapshot().blockedByPayloadReason).reduce((sum, count) => sum + count, 0)).toBe(0);
    expect(ledger.snapshot().blockedRequests.map(({ method, url, reason }) => `${method} ${new URL(url).pathname} ${reason}`))
      .toContain(`POST ${RPC_PATH} NON_READ_METHOD`);
    expect(monitor.submissionReport()).toMatchObject({ submission: 'SENT', sendAttempts: 1, sendOutcome: 'RESPONDED', responseStatus: 201 });
  }, TEST_TIMEOUT_MS);
});
