// AS-c fix round 1（設計書 `doc/design/2026-10-19-beaksight-audit-send-policy-design.md` 5 章の「AS-R … とユーザーの判断」の行）: 独立レビュー（AS-R）の指摘の直しを、
// 本物の部品（`BrowserContextFactory` と、その Guard と出口の中継。Chromium はテストの既定の headless と、CLI の起動の設定の両方）で確かめる。サイトは 127.0.0.1 の
// サーバ（許可 Origin、承認したサービスの Origin、ほかの Origin）。届いたかは、サーバの記録で数える。
// - I-2（AS-R の A07・A08）: method の上書き（ヘッダ・form の本文の `_method`）が `DELETE` の要求は、届かない（`NON_READ_METHOD`）。上書きが `DELETE` でなければ
//   今どおり届く。
// - C-1・C-2（AS-R の M01〜M06、D14・D16。ユーザーの判断: 限界として受け入れ、検知だけ足す）: ページのスクリプトが Playwright の WebSocket の模擬を迂回して開いた
//   接続と、Worker の中の接続は、止められない（届く）。Safety Ledger の通した接続の記録と数は、ブラウザが実際に開いた接続（CDP の事象）から作り、Guard の
//   route を通らずに開いた接続（`outsideGuard`）と、危険な語の接続（`dangerous`）に印を付ける。Context は無効にしない。
import type { Browser, BrowserContext, Frame, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AuditConfig } from '../../src/config/types.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { PassedAuditSendWebSocketsRecord } from '../../src/core/evidence-types.js';
import { SafetyLedger, type SafetyLedgerSnapshot } from '../../src/safety/safety-ledger.js';
import {
  ARRIVAL_POLL_MS,
  ARRIVAL_TIMEOUT_MS,
  NO_CORS_PATH_PREFIX,
  PAGE_PATH,
  SILENT_PREFLIGHT_PATH_PREFIX,
  bypassWebSocketMock,
  corsFetchFromPage,
  nonReads,
  openWebSocketFromPage,
  openWebSocketFromWorker,
  postUntypedBlobFromPage,
  redirectUrlOf,
  sendFromPage,
  startRecordingServer,
  wait,
  waitForArrivals,
  webSocketOriginOf,
  type RecordingServer,
} from '../helpers/audit-send-site.js';
import { closeTestContexts, launchCliChromium, launchHeadlessChromium, oopifTargetUrls, SITE_PER_PROCESS_ARGS } from '../helpers/chromium.js';
import { fastRunConfig } from '../helpers/run-harness.js';
import { TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

const LAUNCHERS: readonly (readonly [string, (args?: readonly string[]) => Promise<Browser>])[] = [
  ['the default test Chromium', (args = []) => launchHeadlessChromium({ args })],
  ['the CLI Chromium', (args = []) => launchCliChromium({ args })],
];
const TEST_TIMEOUT_MS = 120_000;
/** 止めるべき要求の、全部の回の後に、遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 1_000;
/** 止めるべき要求を確かめる回の数（回ごとに新しい Context で読み込む）。 */
const BLOCK_ROUNDS = 2;
/** 模擬を迂回して開く接続の数（1 つの Context の上限 10 本を超える）。 */
const BYPASS_SOCKETS = 12;
const MULTIPART_BOUNDARY = 'beaksight-boundary';
/** AS-c fix round 2（I-C）: route の通過が照らし合わせの時間（`AUDIT_SEND_WEBSOCKET_MATCH_WINDOW_MS`）を過ぎるまで待つ時間（ms）。 */
const STALE_ADMISSION_WAIT_MS = 1_000;
/** AS-c fix round 3（V04・V05）: 本文の上限（1 MiB）を超える本文の大きさ（bytes）。 */
const OVER_LIMIT_BODY_BYTES = 1_200_000;

/** 通した接続の記録の行を、比べやすい文字列にする（`<Origin><path> <数>` と印）。 */
const connectionRows = (record: PassedAuditSendWebSocketsRecord | undefined): readonly string[] =>
  (record?.connections ?? []).map(({ origin, path, count, outsideGuard, dangerous }) =>
    `${origin}${path} ${count}${outsideGuard === true ? ' OUTSIDE_GUARD' : ''}${dangerous === true ? ' DANGEROUS' : ''}`);

/** サーバに届いた WebSocket の接続の path。 */
const upgrades = (site: RecordingServer): readonly string[] => site.requests.filter((entry) => entry.startsWith('UPGRADE '));

describe.each(LAUNCHERS)('AS-c fix round 1: the review findings with PASS_EXCEPT_DELETE with %s', (_label, launch) => {
  let browser: Browser;
  let app: RecordingServer;
  let service: RecordingServer;
  let other: RecordingServer;
  const factories: BrowserContextFactory[] = [];

  beforeAll(async () => {
    browser = await launch();
  });

  afterEach(async () => {
    await Promise.all(factories.splice(0).map((factory) => factory.close()));
    await closeTestContexts(browser);
    await Promise.all([app, service, other].filter((site) => site !== undefined).map((site) => site.server.close()));
  });

  afterAll(async () => {
    await browser?.close();
  });

  const startSites = async (): Promise<void> => {
    [app, service, other] = await Promise.all([startRecordingServer(), startRecordingServer(), startRecordingServer()]);
  };

  const configOf = (): AuditConfig => fastRunConfig(app.server.origin, PAGE_PATH);

  const factoryOf = (send: boolean, target: Browser = browser, limits: { readonly maxPassedPerContext?: number } = {}): BrowserContextFactory => {
    const factory = new BrowserContextFactory(target, configOf(), () => new SafetyLedger(), {
      ...TEST_FACTORY_OPTIONS,
      ...(send
        ? { auditSend: { policy: 'PASS_EXCEPT_DELETE', approvedServiceOrigins: [service.server.origin], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS, ...limits } }
        : {}),
    });
    factories.push(factory);
    return factory;
  };

  const openPage = async (factory: BrowserContextFactory): Promise<{ readonly page: Page; readonly ledger: () => SafetyLedgerSnapshot }> => {
    const context: BrowserContext = await factory.createPassiveContext(configOf().viewports.primaryDesktop);
    const page = await factory.createPassivePage(context);
    await page.goto(`${app.server.origin}${PAGE_PATH}`);
    await page.frameLocator('#child').locator('#frame-form').waitFor({ state: 'attached' });
    return { page, ledger: () => factory.getSafetyLedger(context).snapshot() };
  };

  /** ページの FormData（multipart。ファイルなし）の POST（応答の状態。届かなければ 0）。 */
  const formDataPost = (page: Page, url: string, method: string): Promise<number> => page.evaluate(async ({ target, override }) => {
    const form = new FormData();
    form.append('name', 'value');
    form.append('_method', override);
    try {
      return (await fetch(target, { method: 'POST', body: form })).status;
    } catch {
      return 0;
    }
  }, { target: url, override: method });

  /** Ledger の通した接続の数が `count` になるまで待つ（観察の事象は、接続が開いた後に届きうる）。 */
  const waitForPassedSockets = async (ledger: () => SafetyLedgerSnapshot, count: number): Promise<SafetyLedgerSnapshot> => {
    const deadline = Date.now() + ARRIVAL_TIMEOUT_MS;
    while (Date.now() < deadline && (ledger().passedAuditSendWebSockets?.count ?? 0) < count) {
      await wait(ARRIVAL_POLL_MS);
    }
    return ledger();
  };

  it('I-2: blocks a method override to DELETE in the headers or the form body, every round, and they never arrive', async () => {
    await startSites();
    const factory = factoryOf(true);
    const url = (path: string): string => `${app.server.origin}${path}`;
    for (let round = 0; round < BLOCK_ROUNDS; round += 1) {
      const { page, ledger } = await openPage(factory);
      expect(await sendFromPage(page, url('/api/a07-header'), 'POST', { 'content-type': 'text/plain', 'X-HTTP-Method-Override': 'DELETE' }, 'payload')).toBe(0);
      expect(await sendFromPage(page, url('/api/a07-method'), 'POST', { 'content-type': 'text/plain', 'X-HTTP-Method': 'delete' }, 'payload')).toBe(0);
      expect(await sendFromPage(page, url('/api/a07-override'), 'PUT', { 'content-type': 'text/plain', 'X-Method-Override': 'Delete' }, 'payload')).toBe(0);
      expect(await sendFromPage(page, url('/api/a08-urlencoded'), 'POST', { 'content-type': 'application/x-www-form-urlencoded' }, 'name=v&_method=DELETE')).toBe(0);
      expect(await formDataPost(page, url('/api/a08-multipart'), 'delete')).toBe(0);
      expect(await sendFromPage(page, url('/api/a08-manual-multipart'), 'POST', { 'content-type': `multipart/form-data; boundary=${MULTIPART_BOUNDARY}` },
        `--${MULTIPART_BOUNDARY}\r\nContent-Disposition: form-data; name="_method"\r\n\r\nDELETE\r\n--${MULTIPART_BOUNDARY}--\r\n`)).toBe(0);
      await wait(ARRIVAL_POLL_MS * 4);
      expect(nonReads(app)).toEqual([]);
      const snapshot = ledger();
      expect(snapshot.invariantViolationCount).toBe(0);
      expect(snapshot.passedAuditSendRequests).toBeUndefined();
      expect(snapshot.blockedRequests.map(({ method, url: blocked, reason }) => `${method} ${new URL(blocked).pathname} ${reason}`)).toEqual([
        'POST /api/a07-header NON_READ_METHOD',
        'POST /api/a07-method NON_READ_METHOD',
        'PUT /api/a07-override NON_READ_METHOD',
        'POST /api/a08-urlencoded NON_READ_METHOD',
        'POST /api/a08-multipart NON_READ_METHOD',
        'POST /api/a08-manual-multipart NON_READ_METHOD',
      ]);
    }
    await wait(LATE_REQUEST_WAIT_MS);
    expect(nonReads(app)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // AS-c fix round 2（I-E。AS-R2 の A26・A27）: `Content-Type` のない本文（型のない Blob）は urlencoded として読み、JSON の本文は最上位の `_method` を見る。
  it('I-E: blocks _method=DELETE in a body without Content-Type and in the top level of a JSON body, and they never arrive', async () => {
    await startSites();
    const factory = factoryOf(true);
    const { page, ledger } = await openPage(factory);
    expect(await postUntypedBlobFromPage(page, `${app.server.origin}/api/a26-blob`, '_method=DELETE')).toBe(0);
    expect(await sendFromPage(page, `${app.server.origin}/api/a27-json`, 'POST', { 'content-type': 'application/json' }, '{"_method":"DELETE"}')).toBe(0);
    expect(await postUntypedBlobFromPage(page, `${app.server.origin}/api/blob-ok`, 'name=v')).toBe(200);
    expect(await sendFromPage(page, `${app.server.origin}/api/json-ok`, 'POST', { 'content-type': 'application/json' }, '{"item":{"_method":"DELETE"}}')).toBe(200);
    await waitForArrivals(app, ['POST /api/blob-ok', 'POST /api/json-ok']);
    await wait(LATE_REQUEST_WAIT_MS);
    expect(nonReads(app)).toEqual(['POST /api/blob-ok', 'POST /api/json-ok']);
    const snapshot = ledger();
    expect(snapshot.invariantViolationCount).toBe(0);
    expect(snapshot.blockedRequests.map(({ method, url, reason }) => `${method} ${new URL(url).pathname} ${reason}`)).toEqual([
      'POST /api/a26-blob NON_READ_METHOD',
      'POST /api/a27-json NON_READ_METHOD',
    ]);
  }, TEST_TIMEOUT_MS);

  // AS-c fix round 3（AS-R3 の V04・V05）: 上限（1 MiB）を超える本文は、本文の `_method` を調べずに通す（ヘッダの上書きは今どおり止める）。
  it('passes a JSON body and an untyped Blob body over the limit, and keeps blocking an override header on a large body', async () => {
    await startSites();
    const { page, ledger } = await openPage(factoryOf(true));
    const pad = 'x'.repeat(OVER_LIMIT_BODY_BYTES);
    expect(await sendFromPage(page, `${app.server.origin}/api/ok-v04`, 'POST', { 'content-type': 'application/json' }, `{"pad":"${pad}"}`)).toBe(200);
    expect(await postUntypedBlobFromPage(page, `${app.server.origin}/api/ok-v05`, `pad=${pad}`)).toBe(200);
    expect(await sendFromPage(page, `${app.server.origin}/api/v06-header`, 'POST', { 'content-type': 'text/plain', 'X-HTTP-Method-Override': 'DELETE' }, pad)).toBe(0);
    await waitForArrivals(app, ['POST /api/ok-v04', 'POST /api/ok-v05']);
    await wait(LATE_REQUEST_WAIT_MS);
    expect(nonReads(app)).toEqual(['POST /api/ok-v04', 'POST /api/ok-v05']);
    const snapshot = ledger();
    expect(snapshot.invariantViolationCount).toBe(0);
    expect(snapshot.blockedRequests.map(({ method, url, reason }) => `${method} ${new URL(url).pathname} ${reason}`)).toEqual(['POST /api/v06-header NON_READ_METHOD']);
  }, TEST_TIMEOUT_MS);

  // AS-c fix round 2（I-D。AS-R2 の B03・B07・F41）: リダイレクトの先の要求（route が呼ばれない段）も、CDP の層で通した要求として記録する。上限の数と記録の数が
  // そろう。
  it('I-D: records each hop of a 307 redirect, and the count of the limit matches the record', async () => {
    await startSites();
    const factory = factoryOf(true, browser, { maxPassedPerContext: 3 });
    const { page, ledger } = await openPage(factory);
    expect(await sendFromPage(page, redirectUrlOf(app.server.origin, 307, 'b07', `${app.server.origin}/api/ok-b07`), 'POST', { 'content-type': 'text/plain' }, 'x')).toBe(200);
    expect(await sendFromPage(page, redirectUrlOf(app.server.origin, 307, 'b03', `${other.server.origin}/api/ok-b03`), 'POST', { 'content-type': 'text/plain' }, 'x')).toBe(0);
    await waitForArrivals(app, ['POST /api/ok-b07']);
    const snapshot = ledger();
    // 上限 3 件: 1 本目の 2 段（リダイレクトと先）と、2 本目の 1 段目。2 本目の先（ほかの Origin）は上限で止まる。
    expect(snapshot.passedAuditSendRequests?.count).toBe(3);
    expect(snapshot.passedAuditSendRequests?.requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'POST /redirect/307/b07',
      'POST /api/ok-b07',
      'POST /redirect/307/b03',
    ]);
    expect(snapshot.blockedRequests.map(({ method, url, reason }) => `${method} ${new URL(url).pathname} ${reason}`)).toEqual([
      'POST /api/ok-b03 AUDIT_SEND_OVER_LIMIT',
    ]);
    await wait(LATE_REQUEST_WAIT_MS);
    expect(nonReads(other)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // AS-c fix round 3（AS-R3 の B03・W4）: ほかの Origin への 307 の先も、届いたら CDP の層で記録する（`redirectedRequestId` のない段も、同じ Network の
  // 要求の ID を手がかりにする）。
  it('I-D: records the hop of a 307 redirect to another Origin that arrives', async () => {
    await startSites();
    const factory = factoryOf(true);
    const { page, ledger } = await openPage(factory);
    expect(await sendFromPage(page, redirectUrlOf(app.server.origin, 307, 'w4', `${other.server.origin}/api/ok-w4`), 'POST', { 'content-type': 'text/plain' }, 'x')).toBe(200);
    expect(await waitForArrivals(other, ['POST /api/ok-w4'])).toContain('POST /api/ok-w4');
    const snapshot = ledger();
    expect(snapshot.passedAuditSendRequests?.requests.map(({ method, origin, path }) => `${method} ${origin}${path}`)).toEqual([
      `POST ${app.server.origin}/redirect/307/w4`,
      `POST ${other.server.origin}/api/ok-w4`,
    ]);
    expect(snapshot.passedAuditSendRequests).toMatchObject({ count: 2, otherOrigins: 1 });
  }, TEST_TIMEOUT_MS);

  it('I-2: keeps passing the overrides that are not DELETE', async () => {
    await startSites();
    const factory = factoryOf(true);
    const { page, ledger } = await openPage(factory);
    expect(await sendFromPage(page, `${app.server.origin}/api/put-override`, 'POST', { 'content-type': 'text/plain', 'X-HTTP-Method-Override': 'PUT' }, 'payload')).toBe(200);
    expect(await formDataPost(page, `${app.server.origin}/api/patch-form`, 'patch')).toBe(200);
    expect(await waitForArrivals(app, ['POST /api/put-override', 'POST /api/patch-form'])).toEqual(expect.arrayContaining(['POST /api/put-override', 'POST /api/patch-form']));
    expect(ledger().passedAuditSendRequests?.count).toBe(2);
  }, TEST_TIMEOUT_MS);

  it('C-1: records the connections that bypassed the WebSocket mock from the browser facts, with marks, without invalidating the Context', async () => {
    await startSites();
    const factory = factoryOf(true);
    const { page, ledger } = await openPage(factory);
    const appSocket = webSocketOriginOf(app.server.origin);
    const otherSocket = webSocketOriginOf(other.server.origin);
    // 今どおり route を通って開く接続（印なし）。出口の中継は、Guard が通した接続の宛先だけを通すので、ほかの Origin へも先に 1 本を開いておく。
    expect(await openWebSocketFromPage(page, `${appSocket}/ws/realtime`)).toBe('open');
    expect(await openWebSocketFromPage(page, `${otherSocket}/ws/other-realtime`)).toBe('open');
    // 模擬の迂回（AS-R の M01・M02・M04・M05）。止められない（届く）。
    await bypassWebSocketMock(page, `${appSocket}/ws/logout-m01`, 'apiConnect');
    await bypassWebSocketMock(page, `${appSocket}/ws/ok-m02`, 'urlSwap', `${appSocket}/ws/delete-m02`);
    await bypassWebSocketMock(page, `${otherSocket}/ws/remove-m04`, 'apiConnect');
    const child = page.frames().find((frame: Frame) => frame.url().endsWith('/frame'));
    expect(child).toBeDefined();
    await bypassWebSocketMock(child!, `${appSocket}/ws/logout-m05`, 'apiConnect');
    await waitForArrivals(app, ['UPGRADE /ws/realtime', 'UPGRADE /ws/logout-m01', 'UPGRADE /ws/delete-m02', 'UPGRADE /ws/logout-m05']);
    await waitForArrivals(other, ['UPGRADE /ws/other-realtime', 'UPGRADE /ws/remove-m04']);
    const arrived = upgrades(app).length + upgrades(other).length;
    expect(arrived).toBe(6);
    const snapshot = await waitForPassedSockets(ledger, arrived);
    // 記録の数は、ブラウザが実際に開いた接続の数と同じ。
    expect(snapshot.passedAuditSendWebSockets?.count).toBe(arrived);
    expect(connectionRows(snapshot.passedAuditSendWebSockets)).toEqual(expect.arrayContaining([
      `${appSocket}/ws/realtime 1`,
      `${otherSocket}/ws/other-realtime 1`,
      `${appSocket}/ws/logout-m01 1 OUTSIDE_GUARD DANGEROUS`,
      `${appSocket}/ws/delete-m02 1 OUTSIDE_GUARD DANGEROUS`,
      `${otherSocket}/ws/remove-m04 1 OUTSIDE_GUARD DANGEROUS`,
      `${appSocket}/ws/logout-m05 1 OUTSIDE_GUARD DANGEROUS`,
    ]));
    expect(snapshot.passedAuditSendWebSockets).toMatchObject({ outsideGuard: 4, dangerous: 4 });
    // Context は無効にしない（ページは読み込める）。
    expect(snapshot.invariantViolationCount).toBe(0);
    await page.reload();
    expect(await page.title()).toBe('p');
  }, TEST_TIMEOUT_MS);

  // AS-c fix round 2（I-C。AS-R2 の R07・R08x）: route が通した数との照らし合わせは、Guard が `connectToServer()` を呼んだ後の短い時間に観察した接続とだけ行う。
  // 照らせなかった route の通過（迂回で URL を差し替えた、先に開いていた）は残らず、後で同じ URL へ開いた接続は route の外（`outsideGuard`）になる。
  it('I-C: does not match a later connection with a stale admission of the route', async () => {
    await startSites();
    const factory = factoryOf(true);
    const { page, ledger } = await openPage(factory);
    const appSocket = webSocketOriginOf(app.server.origin);
    expect(await openWebSocketFromPage(page, `${appSocket}/ws/realtime`)).toBe('open');
    // R08x: route は ok-r08x を通したが、本物の接続は delete-r08 へ開いた（route の通過は使われずに残る）。
    await bypassWebSocketMock(page, `${appSocket}/ws/ok-r08x`, 'urlSwap', `${appSocket}/ws/delete-r08`);
    // R07: 模擬を迂回して先に開き、その後に route が通した。
    await bypassWebSocketMock(page, `${appSocket}/ws/ok-r07`, 'apiConnect');
    await wait(STALE_ADMISSION_WAIT_MS);
    expect(await openWebSocketFromWorker(page, `${appSocket}/ws/ok-r08x`)).toBe('open');
    expect(await openWebSocketFromWorker(page, `${appSocket}/ws/ok-r07`)).toBe('open');
    const snapshot = await waitForPassedSockets(ledger, 5);
    const rows = connectionRows(snapshot.passedAuditSendWebSockets);
    expect(rows).toEqual(expect.arrayContaining([
      `${appSocket}/ws/realtime 1`,
      `${appSocket}/ws/delete-r08 1 OUTSIDE_GUARD DANGEROUS`,
      `${appSocket}/ws/ok-r08x 1 OUTSIDE_GUARD`,
    ]));
    // 後で Worker から開いた ok-r07 は、route の外。
    expect(rows.filter((row) => row.startsWith(`${appSocket}/ws/ok-r07 `) && row.endsWith('OUTSIDE_GUARD')).length).toBeGreaterThanOrEqual(1);
    expect(rows.some((row) => row === `${appSocket}/ws/ok-r08x 1`)).toBe(false);
  }, TEST_TIMEOUT_MS);

  it('C-1: counts every connection that bypassed the mock over the limit (M06)', async () => {
    await startSites();
    const factory = factoryOf(true);
    const { page, ledger } = await openPage(factory);
    const appSocket = webSocketOriginOf(app.server.origin);
    for (let index = 0; index < BYPASS_SOCKETS; index += 1) {
      await bypassWebSocketMock(page, `${appSocket}/ws/lim-${String(index).padStart(2, '0')}`, 'apiConnect');
    }
    await wait(ARRIVAL_POLL_MS * 4);
    const arrived = upgrades(app).filter((entry) => entry.includes('/ws/lim-')).length;
    expect(arrived).toBe(BYPASS_SOCKETS);
    const snapshot = await waitForPassedSockets(ledger, BYPASS_SOCKETS);
    expect(snapshot.passedAuditSendWebSockets?.count).toBe(BYPASS_SOCKETS);
    // 上限を超えた分（route が止めた接続）は、少なくとも route を通らずに開いた印を持つ。
    expect(snapshot.passedAuditSendWebSockets?.outsideGuard).toBeGreaterThanOrEqual(BYPASS_SOCKETS - 10);
  }, TEST_TIMEOUT_MS);

  it('C-2: records the connections in a Worker from the browser facts, with marks (D14, D16)', async () => {
    await startSites();
    const factory = factoryOf(true);
    const { page, ledger } = await openPage(factory);
    const appSocket = webSocketOriginOf(app.server.origin);
    const otherSocket = webSocketOriginOf(other.server.origin);
    // 出口の中継は、Guard が通した接続の宛先だけを通すので、先にページから 1 本ずつ開いておく（Worker の接続は、その宛先へだけ届く）。
    expect(await openWebSocketFromPage(page, `${appSocket}/ws/realtime`)).toBe('open');
    expect(await openWebSocketFromPage(page, `${otherSocket}/ws/other-realtime`)).toBe('open');
    expect(await openWebSocketFromWorker(page, `${appSocket}/ws/logout-d14`)).toBe('open');
    expect(await openWebSocketFromWorker(page, `${appSocket}/ws/ok-d15`)).toBe('open');
    expect(await openWebSocketFromWorker(page, `${otherSocket}/ws/delete-d16`)).toBe('open');
    const snapshot = await waitForPassedSockets(ledger, 5);
    expect(snapshot.passedAuditSendWebSockets?.count).toBe(5);
    expect(connectionRows(snapshot.passedAuditSendWebSockets)).toEqual([
      `${appSocket}/ws/realtime 1`,
      `${otherSocket}/ws/other-realtime 1`,
      `${appSocket}/ws/logout-d14 1 OUTSIDE_GUARD DANGEROUS`,
      `${appSocket}/ws/ok-d15 1 OUTSIDE_GUARD`,
      `${otherSocket}/ws/delete-d16 1 OUTSIDE_GUARD DANGEROUS`,
    ]);
    expect(snapshot.invariantViolationCount).toBe(0);
  }, TEST_TIMEOUT_MS);

  // I-1（AS-R の P01・P02。設計書 5 章の「AS-c fix round 1 の Blocker」の行）: 通す見込みの要求の、ほかの Origin への CORS の事前確認は、Guard が同じ形の
  // 事前確認をサーバへ送り、その応答でブラウザの事前確認を満たす。CORS を許さないサーバには事前確認だけが届き、本番の要求は届かない。CORS を許すサーバには
  // 事前確認と本番の両方が届く。送った事前確認は、通した要求（`OPTIONS`。ほかの Origin）として記録する。
  it('I-1: sends the preflight to another Origin and answers the browser with the real response', async () => {
    await startSites();
    const factory = factoryOf(true);
    const { page, ledger } = await openPage(factory);
    expect(await corsFetchFromPage(page, `${other.server.origin}${NO_CORS_PATH_PREFIX}/p01`, 'PUT', 'omit')).toBe(0);
    expect(await corsFetchFromPage(page, `${other.server.origin}${NO_CORS_PATH_PREFIX}/p02`, 'POST', 'include')).toBe(0);
    expect(await corsFetchFromPage(page, `${other.server.origin}/api/cors-put`, 'PUT', 'omit')).toBe(200);
    await waitForArrivals(other, ['PUT /api/cors-put']);
    await wait(LATE_REQUEST_WAIT_MS);
    expect(other.preflights).toEqual([`${NO_CORS_PATH_PREFIX}/p01`, `${NO_CORS_PATH_PREFIX}/p02`, '/api/cors-put']);
    expect(nonReads(other)).toEqual(['PUT /api/cors-put']);
    const snapshot = ledger();
    expect(snapshot.invariantViolationCount).toBe(0);
    expect(snapshot.passedAuditSendRequests?.requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `OPTIONS ${NO_CORS_PATH_PREFIX}/p01`,
      `OPTIONS ${NO_CORS_PATH_PREFIX}/p02`,
      'OPTIONS /api/cors-put',
      'PUT /api/cors-put',
    ]);
    expect(snapshot.passedAuditSendRequests?.otherOrigins).toBe(4);
  }, TEST_TIMEOUT_MS);

  // I-1: サーバが事前確認に応答しない（時間切れ）ときは、拒む応答でブラウザの事前確認を満たす（本番の要求は届かない）。
  it('I-1: answers the browser with a rejection when the server does not answer the preflight in time', async () => {
    await startSites();
    const { page, ledger } = await openPage(factoryOf(true));
    expect(await corsFetchFromPage(page, `${other.server.origin}${SILENT_PREFLIGHT_PATH_PREFIX}/put`, 'PUT', 'omit')).toBe(0);
    await wait(LATE_REQUEST_WAIT_MS);
    expect(other.preflights).toEqual([`${SILENT_PREFLIGHT_PATH_PREFIX}/put`]);
    expect(nonReads(other)).toEqual([]);
    const snapshot = ledger();
    expect(snapshot.invariantViolationCount).toBe(0);
    expect(snapshot.passedAuditSendRequests?.requests.map(({ method, path }) => `${method} ${path}`)).toEqual([`OPTIONS ${SILENT_PREFLIGHT_PATH_PREFIX}/put`]);
  }, TEST_TIMEOUT_MS);

  // I-1: 承認したサービスの Origin（AS-R の P05）と許可 Origin は、今のまま Guard が事前確認を返す（サーバに事前確認を送らない）。既定の READ_ONLY も今のまま。
  it('I-1: keeps answering the preflight to the approved service Origin by the Guard, and keeps READ_ONLY', async () => {
    await startSites();
    const { page } = await openPage(factoryOf(true));
    // 本番の要求は届く（応答に CORS のヘッダがないので、ページの fetch は失敗する）。
    await corsFetchFromPage(page, `${service.server.origin}${NO_CORS_PATH_PREFIX}/p05`, 'PATCH', 'include');
    expect(await waitForArrivals(service, [`PATCH ${NO_CORS_PATH_PREFIX}/p05`])).toContain(`PATCH ${NO_CORS_PATH_PREFIX}/p05`);
    expect(service.preflights).toEqual([]);
    const readOnly = await openPage(factoryOf(false));
    expect(await corsFetchFromPage(readOnly.page, `${other.server.origin}${NO_CORS_PATH_PREFIX}/ro`, 'PUT', 'omit')).toBe(0);
    await wait(LATE_REQUEST_WAIT_MS);
    expect(other.preflights).toEqual([]);
    expect(nonReads(other)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // C-1: 別のプロセスの iframe（OOPIF）の中の接続も、観察の session が子の target に付いて数える。観察の付与は、Guard の OOPIF の横取り（止めて付ける）を
  // 妨げない（違反 0、iframe は読み込める）。
  it('C-1: records the connections in an out-of-process iframe, and keeps the Guard of the iframe working', async () => {
    await startSites();
    const isolated = await launch(SITE_PER_PROCESS_ARGS);
    try {
      const factory = factoryOf(true, isolated);
      const context: BrowserContext = await factory.createPassiveContext(configOf().viewports.primaryDesktop);
      const page = await factory.createPassivePage(context);
      await page.goto(`${app.server.origin}${PAGE_PATH}`);
      // 同じサーバの別のホスト名（`localhost`）の iframe は、別のサイトなので別のプロセス（OOPIF）になる。
      const crossSiteFrameUrl = `http://localhost:${String(app.server.port)}/frame`;
      await page.evaluate((source) => {
        const frame = document.createElement('iframe');
        frame.id = 'cross-site';
        frame.src = source;
        document.body.appendChild(frame);
      }, crossSiteFrameUrl);
      await page.frameLocator('#cross-site').locator('#frame-form').waitFor({ state: 'attached' });
      expect(await oopifTargetUrls(isolated)).toContain(crossSiteFrameUrl);
      const frame = page.frames().find((candidate) => candidate.url() === crossSiteFrameUrl);
      expect(frame).toBeDefined();
      const appSocket = webSocketOriginOf(app.server.origin);
      // 出口の中継が通す宛先にするため、ページから先に 1 本を開く。
      expect(await openWebSocketFromPage(page, `${appSocket}/ws/realtime`)).toBe('open');
      // 模擬は Guard の route が閉じる（危険な語）が、迂回した本物の接続はサーバに届く。
      await bypassWebSocketMock(frame!, `${appSocket}/ws/logout-oopif`, 'apiConnect');
      expect(await waitForArrivals(app, ['UPGRADE /ws/logout-oopif'])).toContain('UPGRADE /ws/logout-oopif');
      const snapshot = await waitForPassedSockets(() => factory.getSafetyLedger(context).snapshot(), 2);
      expect(connectionRows(snapshot.passedAuditSendWebSockets)).toEqual([
        `${appSocket}/ws/realtime 1`,
        `${appSocket}/ws/logout-oopif 1 OUTSIDE_GUARD DANGEROUS`,
      ]);
      expect(snapshot.invariantViolationCount).toBe(0);
    } finally {
      await isolated.close();
    }
  }, TEST_TIMEOUT_MS);

  // M-3（AS-R の PX02）: about:blank のポップアップの realm の POST は、ブラウザから送られない（Playwright が進めない）。送った事実の時点（route の層が進める時点。
  // route を通らない送信は CDP の層が進める時点）で記録するので、届かない要求を通したと記録しない。Worker の送信と beacon は、今どおり届いて記録する。
  it('M-3: records a passed request when it is sent, not for a request in a fresh about:blank popup that never leaves the browser', async () => {
    await startSites();
    const factory = factoryOf(true);
    const { page, ledger } = await openPage(factory);
    const popupResult = await page.evaluate(async (target) => {
      const popup = window.open('about:blank');
      if (popup === null) return 'null';
      try {
        const sent = (popup as unknown as { fetch: typeof fetch }).fetch(target, { method: 'POST', body: 'x' });
        const response = await Promise.race([sent, new Promise<null>((resolveLater) => setTimeout(() => resolveLater(null), 3_000))]);
        return response === null ? 'pending' : `status:${response.status}`;
      } catch {
        return 'failed';
      }
    }, `${app.server.origin}/api/popup-px02`);
    expect(popupResult).not.toMatch(/^status:/u);
    const workerStatus = await page.evaluate((target) => new Promise<string>((resolveState) => {
      const source = 'self.onmessage=async(e)=>{try{const r=await fetch(e.data,{method:"POST",body:"x"});postMessage("status:"+r.status)}catch(x){postMessage("failed")}};';
      const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
      worker.onmessage = (event) => resolveState(String(event.data));
      worker.postMessage(target);
    }), `${app.server.origin}/api/worker-post`);
    expect(workerStatus).toBe('status:200');
    expect(await page.evaluate((target) => navigator.sendBeacon(target, 'x'), `${app.server.origin}/api/beacon`)).toBe(true);
    await waitForArrivals(app, ['POST /api/worker-post', 'POST /api/beacon']);
    await wait(LATE_REQUEST_WAIT_MS);
    expect(nonReads(app)).toEqual(['POST /api/worker-post', 'POST /api/beacon']);
    const snapshot = ledger();
    expect(snapshot.passedAuditSendRequests?.requests.map(({ method, path }) => `${method} ${path}`)).toEqual(['POST /api/worker-post', 'POST /api/beacon']);
    expect(snapshot.passedAuditSendRequests?.count).toBe(2);
  }, TEST_TIMEOUT_MS);

  it('keeps the default (no policy) without the observation: the mock bypass and the Worker connections do not open', async () => {
    await startSites();
    const factory = factoryOf(false);
    const { page, ledger } = await openPage(factory);
    const appSocket = webSocketOriginOf(app.server.origin);
    expect(await bypassWebSocketMock(page, `${appSocket}/ws/ro-bypass`, 'apiConnect')).not.toBe('open');
    expect(await openWebSocketFromWorker(page, `${appSocket}/ws/ro-worker`)).not.toBe('open');
    await wait(LATE_REQUEST_WAIT_MS);
    expect(upgrades(app)).toEqual([]);
    expect(ledger().passedAuditSendWebSockets).toBeUndefined();
  }, TEST_TIMEOUT_MS);
});
