// T30b（Task 30 の設計書 `2026-10-13-beaksight-task-30-approved-create-design.md` 3 章の「書き込みの段」「送る中身の照合」、4 章、6 章）:
// 書き込みの段の Guard（`PassiveRequestGuardOptions.writeStage`）。本物の Guard と、127.0.0.1 の fixture のサーバ
// （`tests/helpers/write-fixture-server.ts`）で確かめる。
// - 承認の要求の形に一致し、送る中身が一致する main frame のナビゲーションの POST が、1 回だけサーバに届く（送信の報告は `SENT` と応答）。
// - 次はサーバに届かない（回ごとにサーバの記録で数え、全部の回の後に `LATE_DELIVERY_SETTLE_MS` だけ待ってもう一度数える。止めた証拠が回ごとに
//   ある）: 2 回目の POST、別の path、別の Origin、未知の欄つき、値の違い、`text/plain`、GET の form、307・308 の再 POST、iframe の中の form、
//   popup の POST、Worker・Service Worker の fetch、`navigator.sendBeacon`、`fetch` の `keepalive`、WebSocket、送信の窓の中の別の要求、送信の前に
//   ページの JS が form の action を書き換える、送信の前にページの JS が欄を足す、UTF-8 でない文書、送信の窓を開かない送信、file の中身。
// - 送信の報告: 通さなかった → `NOT_SENT`、通して応答あり、通して応答なし。
// - CSRF の hidden の値と readonly の値は、Guard の記録（Safety Ledger と書き込みの段の記録）に出ない（目印の値で確かめる）。
// - Chromium は headless だけ。テストの既定（headless shell）と、CLI の起動の設定（`launchCliChromium`）の両方で確かめる。
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import {
  awaitPassiveRequestGuardReady,
  closePassiveGuardedContext,
  installPassiveRequestGuard,
  WriteStageMonitor,
  type GuardWriteStage,
} from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import type { WriteFormEnctype, WritePayloadExpectation } from '../../src/safety/write-payload-policy.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { QUIET_PERIOD_MS } from '../helpers/gate-harness.js';
import { startWriteSubmissionProxy, type WriteSubmissionProxy } from '../helpers/write-submission-proxy.js';
import {
  WRITE_FIXTURE_PATHS,
  startWriteFixtureServer,
  type WriteFixtureRequest,
  type WriteFixtureServer,
  type WriteFormVariant,
} from '../helpers/write-fixture-server.js';

const VIEWPORT = Object.freeze({ width: 900, height: 700 });
/** ナビゲーションの結果（読み込みか、止められた失敗）を待つ上限（ms）。 */
const NAVIGATION_SETTLE_TIMEOUT_MS = 5_000;
/** ページの中の試み（fetch など）の結果を待つ上限（ms）。止められた要求は、すぐに失敗する。 */
const IN_PAGE_ATTEMPT_TIMEOUT_MS = 2_000;
/** 全部の回の後に、遅れて届く要求を見逃さないために待つ時間（ms。設計書 6 章の「2 秒」）。 */
const LATE_DELIVERY_SETTLE_MS = 2_000;
/** 1 つの describe（1 つの Chromium）の全部の回の期限（ms）。 */
/** DEF-099 fix round 1: Guard を閉じてから、送り手が止まるのを待つ上限（ms。送り手の時間の上限 30 秒より十分に短い）。 */
const CLOSE_ABORT_LIMIT_MS = 5_000;
const ROUND_TIMEOUT_MS = 60_000;

const URLENCODED: WriteFormEnctype = 'application/x-www-form-urlencoded';
const MULTIPART: WriteFormEnctype = 'multipart/form-data';
const NAME_VALUE = '山田 太郎';
const MEMO_VALUE = 'メモ & 1+1=2\n二行目';

interface ChromiumLaunch {
  readonly name: string;
  launch(): Promise<Browser>;
}

const CHROMIUM_LAUNCHES: readonly ChromiumLaunch[] = [
  { name: 'the headless shell (test default)', launch: () => launchHeadlessChromium() },
  { name: 'the CLI Chromium (launchCliChromium, headless)', launch: () => launchCliChromium() },
];

/** サーバに届いた、GET と HEAD 以外の要求（WebSocket の upgrade を含む）。 */
const nonReadRequests = (requests: readonly WriteFixtureRequest[]): string[] => requests
  .filter((entry) => entry.method !== 'GET' && entry.method !== 'HEAD')
  .map((entry) => `${entry.site} ${entry.method} ${entry.path}`);

describe.each(CHROMIUM_LAUNCHES)('T30b: the write stage of the Guard, with $name', ({ name, launch }) => {
  let browser: Browser;
  let server: WriteFixtureServer;
  const contexts: BrowserContext[] = [];
  /** これまでの回で、サーバに届いてよいと確かめた GET と HEAD 以外の要求（承認の POST だけ）。 */
  const expectedNonRead: string[] = [];
  /** これまでの回で、止めた証拠のあった回の名前。 */
  const blockedRounds: string[] = [];

  let submissionProxy: WriteSubmissionProxy;

  beforeAll(async () => {
    browser = await launch();
    server = await startWriteFixtureServer();
    // DEF-099 fix: 承認の POST は、Guard が送り手に送らせる（中継を通して 1 回だけ）。
    submissionProxy = await startWriteSubmissionProxy();
  });

  afterAll(async () => {
    await submissionProxy?.close();
    await server?.close();
    await browser?.close();
  });

  afterEach(async () => {
    for (const context of contexts.splice(0)) {
      await closePassiveGuardedContext(context).catch(() => context.close().catch(() => undefined));
    }
  });

  const expectationFor = (
    path: string = WRITE_FIXTURE_PATHS.create,
    enctype: WriteFormEnctype = URLENCODED,
    emptyFileFieldNames: readonly string[] = [],
    methodOverride: 'PUT' | null = null,
  ): WritePayloadExpectation => ({
    request: { origin: server.originA, path, enctype },
    submittedFields: [{ name: 'customer_name', value: NAME_VALUE }, { name: 'memo', value: MEMO_VALUE }],
    passthroughFieldNames: ['csrf_token', 'serial'],
    emptyFileFieldNames,
    methodOverride,
  });

  /** 本物の Guard を付けた Context と page（factory と同じ Context の作り方）。 */
  const openGuarded = async (expectation: WritePayloadExpectation = expectationFor()): Promise<{
    readonly page: Page;
    readonly ledger: SafetyLedger;
    readonly monitor: WriteStageMonitor;
  }> => {
    const context = await browser.newContext({ viewport: VIEWPORT, serviceWorkers: 'block', acceptDownloads: false });
    contexts.push(context);
    const ledger = new SafetyLedger();
    const monitor = new WriteStageMonitor();
    const writeStage: GuardWriteStage = { expectation, monitor };
    await installPassiveRequestGuard(context, ledger, new Set([server.originA]), { writeStage, writeSubmission: submissionProxy.options });
    const page = await context.newPage();
    await awaitPassiveRequestGuardReady(page);
    return { page, ledger, monitor };
  };

  /** 登録の画面を開き、送信の窓を開いてから値を入れ、送る（`openWindow` が偽なら窓を開かない）。結果の読み込みか失敗を待つ。 */
  const submitForm = async (
    page: Page,
    monitor: WriteStageMonitor,
    variant: WriteFormVariant,
    options: { readonly openWindow?: boolean; readonly beforeClick?: () => Promise<void> } = {},
  ): Promise<void> => {
    await page.goto(server.formUrl(variant));
    if (options.openWindow !== false) {
      await monitor.openSubmissionWindow(page);
    }
    await page.fill('#customer_name', NAME_VALUE);
    await page.fill('#memo', MEMO_VALUE);
    await options.beforeClick?.();
    await Promise.all([
      page.waitForEvent('framenavigated', { timeout: NAVIGATION_SETTLE_TIMEOUT_MS }).catch(() => undefined),
      page.click('#go'),
    ]);
    await page.waitForLoadState('load', { timeout: NAVIGATION_SETTLE_TIMEOUT_MS }).catch(() => undefined);
    await wait(QUIET_PERIOD_MS);
  };

  /** 秘密の目印（CSRF の hidden の値と readonly の値）が、Guard の記録に出ない。 */
  const expectNoMarkers = (ledger: SafetyLedger, monitor: WriteStageMonitor): void => {
    const recorded = JSON.stringify([ledger.snapshot(), monitor.snapshot(), monitor.submissionReport()]);
    expect(recorded).not.toContain(server.csrfMarker);
    expect(recorded).not.toContain(server.readonlyMarker);
  };

  /**
   * 回の終わり: 届いた GET と HEAD 以外の要求が、これまでに確かめたものだけで、違反が `allowedViolations` のほかに 0 で、止めた証拠がある。
   */
  const finishBlockedRound = (
    round: string,
    ledger: SafetyLedger,
    monitor: WriteStageMonitor,
    evidence: boolean,
    allowedViolations: readonly string[] = [],
  ): void => {
    console.info(`T30b (${name}) ${round}: server ${JSON.stringify(nonReadRequests(server.requests))}; `
      + `ledger blocked ${JSON.stringify(ledger.snapshot().blockedRequests.map((entry) => `${entry.method} ${new URL(entry.url).pathname}`))}; `
      + `monitor ${JSON.stringify(monitor.snapshot())}`);
    expect(nonReadRequests(server.requests)).toEqual(expectedNonRead);
    expect(ledger.snapshot().invariantViolations.filter((entry) => !allowedViolations.includes(entry.code))).toEqual([]);
    expectNoMarkers(ledger, monitor);
    expect(evidence, `${round}: blocking evidence`).toBe(true);
    blockedRounds.push(round);
  };

  const blockedPosts = (ledger: SafetyLedger, path: string): number => ledger.snapshot().blockedRequests
    .filter((entry) => entry.method === 'POST' && new URL(entry.url).pathname === path).length;

  it('delivers the approved urlencoded POST once, reports SENT with the 303 response, and loads the result page', async () => {
    const { page, ledger, monitor } = await openGuarded();
    expect(monitor.submissionReport()).toEqual({ submission: 'NOT_SENT', responseReceived: false, responseStatus: null, sendAttempts: 0, sendOutcome: null });

    await submitForm(page, monitor, 'plain');

    expectedNonRead.push(`A POST ${WRITE_FIXTURE_PATHS.create}`);
    expect(nonReadRequests(server.requests)).toEqual(expectedNonRead);
    expect(new URL(page.url()).pathname).toBe(WRITE_FIXTURE_PATHS.created);
    await expect(page.textContent('#created')).resolves.toBe('CREATED');
    expect(monitor.submissionReport()).toEqual({ submission: 'SENT', responseReceived: true, responseStatus: 303, sendAttempts: 1, sendOutcome: 'RESPONDED' });
    expect(monitor.snapshot().submissionWindowOpen).toBe(false);
    expect(monitor.unexpectedRequestCount()).toBe(0);
    expect(server.csrfBodies).toBe(1);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    expectNoMarkers(ledger, monitor);

    // 2 回目の POST（同じ Context で、同じ画面から同じ値で）は届かない。
    await submitForm(page, monitor, 'plain');
    finishBlockedRound('a second POST', ledger, monitor, blockedPosts(ledger, WRITE_FIXTURE_PATHS.create) === 1);
    expect(monitor.submissionReport().submission).toBe('SENT');
  }, ROUND_TIMEOUT_MS);

  it('delivers the approved multipart POST with an empty file field once', async () => {
    const { page, ledger, monitor } = await openGuarded(expectationFor(WRITE_FIXTURE_PATHS.create, MULTIPART, ['att']));
    await submitForm(page, monitor, 'file');
    expectedNonRead.push(`A POST ${WRITE_FIXTURE_PATHS.create}`);
    expect(nonReadRequests(server.requests)).toEqual(expectedNonRead);
    expect(server.requests.filter((entry) => entry.method === 'POST').at(-1)?.contentType?.startsWith('multipart/form-data; boundary=')).toBe(true);
    expect(monitor.submissionReport()).toEqual({ submission: 'SENT', responseReceived: true, responseStatus: 303, sendAttempts: 1, sendOutcome: 'RESPONDED' });
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    expectNoMarkers(ledger, monitor);
  }, ROUND_TIMEOUT_MS);

  it('delivers the approved POST with the approved method override (_method=PUT) once (T30b fix round 1)', async () => {
    const { page, ledger, monitor } = await openGuarded(expectationFor(WRITE_FIXTURE_PATHS.create, URLENCODED, [], 'PUT'));
    await submitForm(page, monitor, 'method-override');
    expectedNonRead.push(`A POST ${WRITE_FIXTURE_PATHS.create}`);
    expect(nonReadRequests(server.requests)).toEqual(expectedNonRead);
    expect(monitor.submissionReport()).toEqual({ submission: 'SENT', responseReceived: true, responseStatus: 303, sendAttempts: 1, sendOutcome: 'RESPONDED' });
    expect(ledger.snapshot().invariantViolations).toEqual([]);
  }, ROUND_TIMEOUT_MS);

  it('reports SENT without a response when the server does not answer the approved POST', async () => {
    const { page, ledger, monitor } = await openGuarded(expectationFor(WRITE_FIXTURE_PATHS.createHang));
    await page.goto(server.formUrl('hang'));
    await monitor.openSubmissionWindow(page);
    await page.fill('#customer_name', NAME_VALUE);
    await page.fill('#memo', MEMO_VALUE);
    await page.click('#go', { noWaitAfter: true });
    await wait(QUIET_PERIOD_MS * 2);
    expectedNonRead.push(`A POST ${WRITE_FIXTURE_PATHS.createHang}`);
    expect(nonReadRequests(server.requests)).toEqual(expectedNonRead);
    expect(monitor.submissionReport()).toEqual({ submission: 'SENT', responseReceived: false, responseStatus: null, sendAttempts: 1, sendOutcome: null });
    expect(ledger.snapshot().invariantViolations).toEqual([]);
  }, ROUND_TIMEOUT_MS);

  // T30R-fix-1（M-1）: ページの JS の二重の送信。後の送信がブラウザで前の送信（送り手が送った承認の POST）を取り消すので、送り手の応答の
  // `Fetch.fulfillRequest` が取り消された要求への命令になる。DEF-026 と同じく違反にしない（記録する）。後の送信は回数を使い切っているので止まる。
  // 届く POST は 1 件のまま。
  it('delivers the approved POST once when the page submits twice, without a violation for the canceled request', async () => {
    const { page, ledger, monitor } = await openGuarded();
    await submitForm(page, monitor, 'double-submit');
    await wait(QUIET_PERIOD_MS * 2);
    expectedNonRead.push(`A POST ${WRITE_FIXTURE_PATHS.create}`);
    expect(nonReadRequests(server.requests)).toEqual(expectedNonRead);
    expect(monitor.submissionReport()).toMatchObject({ submission: 'SENT', sendAttempts: 1, sendOutcome: 'RESPONDED' });
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    expectNoMarkers(ledger, monitor);
  }, ROUND_TIMEOUT_MS);

  // T30R-fix-1（M-1）: 送り手が送っている間（応答が遅い）に、後の送信が前の送信を取り消す。取り消しの証拠の保ち時間を過ぎてから届いた応答の
  // `Fetch.fulfillRequest` が、取り消された要求への命令として失敗する。違反にしない（記録する）。届く POST は 1 件のまま。
  it('delivers the approved POST once when the page submits twice during a slow response, without a violation for the canceled request', async () => {
    const { page, ledger, monitor } = await openGuarded(expectationFor(WRITE_FIXTURE_PATHS.createSlow));
    await submitForm(page, monitor, 'double-submit-slow');
    while (monitor.submissionReport().sendOutcome === null) {
      await wait(QUIET_PERIOD_MS);
    }
    await wait(QUIET_PERIOD_MS * 2);
    expectedNonRead.push(`A POST ${WRITE_FIXTURE_PATHS.createSlow}`);
    expect(nonReadRequests(server.requests)).toEqual(expectedNonRead);
    expect(monitor.submissionReport()).toMatchObject({ submission: 'SENT', sendAttempts: 1, sendOutcome: 'RESPONDED' });
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    expect(monitor.snapshot().responseDeliveryCanceled).toBe(true);
  }, ROUND_TIMEOUT_MS);

  // DEF-099 fix round 1: Guard が閉じるとき、送信中の送り手を止める（書いた後なので `NO_RESPONSE`。時間の上限まで待たない）。
  it('stops the write submission in flight when the Guard closes (NO_RESPONSE), without waiting for the time limit', async () => {
    const { page, monitor } = await openGuarded(expectationFor(WRITE_FIXTURE_PATHS.createHang));
    await page.goto(server.formUrl('hang'));
    await monitor.openSubmissionWindow(page);
    await page.fill('#customer_name', NAME_VALUE);
    await page.fill('#memo', MEMO_VALUE);
    await page.click('#go', { noWaitAfter: true });
    await wait(QUIET_PERIOD_MS * 2);
    expectedNonRead.push(`A POST ${WRITE_FIXTURE_PATHS.createHang}`);
    expect(monitor.submissionReport().sendOutcome).toBeNull();
    const context = contexts.pop();
    const closedAt = Date.now();
    await closePassiveGuardedContext(context as BrowserContext);
    while (monitor.submissionReport().sendOutcome === null && Date.now() - closedAt < CLOSE_ABORT_LIMIT_MS) {
      await wait(QUIET_PERIOD_MS);
    }
    expect(monitor.submissionReport()).toMatchObject({ submission: 'SENT', responseReceived: false, sendAttempts: 1, sendOutcome: 'NO_RESPONSE' });
    expect(nonReadRequests(server.requests)).toEqual(expectedNonRead);
  }, ROUND_TIMEOUT_MS);

  it.each<[string, '307' | '308']>([['307', '307'], ['308', '308']])('delivers the approved POST once and blocks the POST that a %s repeats', async (_label, status) => {
    const path = status === '307' ? WRITE_FIXTURE_PATHS.create307 : WRITE_FIXTURE_PATHS.create308;
    const { page, ledger, monitor } = await openGuarded(expectationFor(path));
    await submitForm(page, monitor, status === '307' ? 'create-307' : 'create-308');
    expectedNonRead.push(`A POST ${path}`);
    expect(monitor.submissionReport()).toEqual({ submission: 'SENT', responseReceived: true, responseStatus: Number(status), sendAttempts: 1, sendOutcome: 'RESPONDED' });
    finishBlockedRound(`the POST that a ${status} repeats`, ledger, monitor, blockedPosts(ledger, path) === 1);
  }, ROUND_TIMEOUT_MS);

  interface PayloadRound {
    readonly round: string;
    readonly variant: WriteFormVariant;
    readonly expectation?: () => WritePayloadExpectation;
    readonly openWindow?: boolean;
    readonly beforeClick?: (page: Page) => Promise<void>;
    /** 止めた証拠（書き込みの段の記録と Safety Ledger から）。 */
    readonly evidence: (ledger: SafetyLedger, monitor: WriteStageMonitor) => boolean;
  }

  const payloadReason = (monitor: WriteStageMonitor, reason: keyof ReturnType<WriteStageMonitor['snapshot']>['blockedByPayloadReason']): boolean =>
    monitor.snapshot().blockedByPayloadReason[reason] === 1;

  it.each<PayloadRound>([
    { round: 'a POST to another path', variant: 'other-path', evidence: (ledger) => blockedPosts(ledger, WRITE_FIXTURE_PATHS.otherPath) === 1 },
    { round: 'a POST to another origin', variant: 'other-origin', evidence: (ledger) => blockedPosts(ledger, WRITE_FIXTURE_PATHS.create) === 1 },
    { round: 'a POST with a query', variant: 'query', evidence: (ledger) => blockedPosts(ledger, WRITE_FIXTURE_PATHS.create) === 1 },
    { round: 'a POST with a field that the page adds before the submission', variant: 'js-field', evidence: (_ledger, monitor) => payloadReason(monitor, 'UNKNOWN_FIELD') },
    { round: 'a POST with a value that the page changes before the submission', variant: 'js-value', evidence: (_ledger, monitor) => payloadReason(monitor, 'VALUE_MISMATCH') },
    { round: 'a POST whose action the page rewrites before the submission', variant: 'js-action', evidence: (ledger) => blockedPosts(ledger, WRITE_FIXTURE_PATHS.otherPath) === 1 },
    { round: 'a text/plain POST', variant: 'text-plain', evidence: (_ledger, monitor) => payloadReason(monitor, 'ENCTYPE_NOT_ALLOWED') },
    { round: 'a POST from a document that is not UTF-8', variant: 'sjis', evidence: (_ledger, monitor) => payloadReason(monitor, 'DOCUMENT_CHARSET_NOT_UTF8') },
    { round: 'a POST without the submission window', variant: 'plain', openWindow: false, evidence: (_ledger, monitor) => payloadReason(monitor, 'DOCUMENT_CHARSET_UNKNOWN') },
    {
      round: 'a multipart POST with the content of a file',
      variant: 'file',
      expectation: () => expectationFor(WRITE_FIXTURE_PATHS.create, MULTIPART, ['att']),
      beforeClick: (page) => page.setInputFiles('#att', { name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('FILE-CONTENT') }),
      // file の部品は、ファイル名があれば `FILE_NOT_EMPTY`、中身の bytes を CDP が渡さなければ `BODY_INCOMPLETE`（どちらでも止まる）。
      evidence: (_ledger, monitor) => payloadReason(monitor, 'FILE_NOT_EMPTY') || payloadReason(monitor, 'BODY_INCOMPLETE'),
    },
    {
      round: 'a POST whose _method value the page rewrites to DELETE before the submission (T30b fix round 1)',
      variant: 'method-override-js',
      expectation: () => expectationFor(WRITE_FIXTURE_PATHS.create, URLENCODED, [], 'PUT'),
      evidence: (_ledger, monitor) => payloadReason(monitor, 'METHOD_OVERRIDE_MISMATCH'),
    },
    {
      round: 'a POST with a _method field that the approval does not have (T30b fix round 1)',
      variant: 'method-override',
      evidence: (_ledger, monitor) => payloadReason(monitor, 'METHOD_OVERRIDE_MISMATCH'),
    },
    {
      round: 'a GET form (the values in the query) in the submission window',
      variant: 'get',
      evidence: (_ledger, monitor) => monitor.snapshot().blockedByReason.SUBMISSION_WINDOW >= 1,
    },
  ])('does not deliver $round, and reports NOT_SENT', async ({ round, variant, expectation, openWindow, beforeClick, evidence }) => {
    const { page, ledger, monitor } = await openGuarded(expectation?.());
    await submitForm(page, monitor, variant, {
      ...(openWindow === undefined ? {} : { openWindow }),
      ...(beforeClick === undefined ? {} : { beforeClick: () => beforeClick(page) }),
    });
    expect(monitor.submissionReport()).toEqual({ submission: 'NOT_SENT', responseReceived: false, responseStatus: null, sendAttempts: 0, sendOutcome: null });
    expect(server.requests.some((entry) => entry.path.startsWith(`${WRITE_FIXTURE_PATHS.create}?`) && entry.method === 'GET')).toBe(false);
    finishBlockedRound(round, ledger, monitor, evidence(ledger, monitor));
  }, ROUND_TIMEOUT_MS);

  it('does not deliver the POST of a document that replaced the measured document after the window opened (about:blank and a written form)', async () => {
    const { page, ledger, monitor } = await openGuarded();
    await page.goto(server.formUrl('plain'));
    await monitor.openSubmissionWindow(page);
    await page.evaluate(() => {
      location.href = 'about:blank';
    });
    await page.waitForURL('about:blank', { timeout: NAVIGATION_SETTLE_TIMEOUT_MS });
    await page.setContent(`<form id="f" method="post" action="${server.originA}${WRITE_FIXTURE_PATHS.create}">`
      + '<input name="customer_name" id="customer_name"><textarea name="memo" id="memo"></textarea>'
      + '<button id="go" type="submit">register</button></form>');
    await page.fill('#customer_name', NAME_VALUE);
    await page.fill('#memo', MEMO_VALUE);
    await page.click('#go');
    await wait(QUIET_PERIOD_MS * 2);
    expect(monitor.submissionReport().submission).toBe('NOT_SENT');
    finishBlockedRound('the POST of a document that replaced the measured document', ledger, monitor, payloadReason(monitor, 'DOCUMENT_CHARSET_UNKNOWN'));
  }, ROUND_TIMEOUT_MS);

  it('does not deliver the POST of a form in an iframe', async () => {
    const { page, ledger, monitor } = await openGuarded();
    await page.goto(`${server.originA}${WRITE_FIXTURE_PATHS.framed}`);
    const frame = page.frameLocator('#form-frame');
    await frame.locator('#customer_name').waitFor();
    await monitor.openSubmissionWindow(page);
    await frame.locator('#customer_name').fill(NAME_VALUE);
    await frame.locator('#memo').fill(MEMO_VALUE);
    await frame.locator('#go').click();
    await wait(QUIET_PERIOD_MS * 2);
    expect(monitor.submissionReport().submission).toBe('NOT_SENT');
    finishBlockedRound('the POST of a form in an iframe', ledger, monitor, blockedPosts(ledger, WRITE_FIXTURE_PATHS.create) === 1);
  }, ROUND_TIMEOUT_MS);

  it('does not deliver the POST of a popup (a form with target _blank)', async () => {
    const { page, ledger, monitor } = await openGuarded();
    const popup = page.waitForEvent('popup', { timeout: NAVIGATION_SETTLE_TIMEOUT_MS }).catch(() => null);
    await submitForm(page, monitor, 'popup');
    const opened = await popup;
    await opened?.waitForLoadState('load', { timeout: NAVIGATION_SETTLE_TIMEOUT_MS }).catch(() => undefined);
    await wait(QUIET_PERIOD_MS * 2);
    const snapshot = ledger.snapshot();
    console.info(`T30b (${name}) popup: violations ${JSON.stringify(snapshot.invariantViolations.map((entry) => entry.code))}; `
      + `blocked ${JSON.stringify(snapshot.blockedRequests.map((entry) => `${entry.method} ${new URL(entry.url).pathname}`))}; `
      + `monitor ${JSON.stringify(monitor.snapshot())}`);
    expect(monitor.submissionReport().submission).toBe('NOT_SENT');
    // 今の Guard のとおり、popup の最初のナビゲーションは、Guard が CDP の session を付けた印のない page の要求として route の層で止め、明示の
    // 理由の違反にして Context を閉じる（`PASSIVE_GUARD_PAGE_NOT_READY`。DEF-113 の直しの前は、frame の判定の失敗 `FRAME_CLASSIFICATION_FAILED`
    // だった。fail-closed）。popup の page の CDP の層が先に見た場合は、送信の窓を開いた page でないので文字コードがなく、照合が止める
    // （`DOCUMENT_CHARSET_UNKNOWN`）。どちらでもサーバに届かない。
    const popupViolations = ['PASSIVE_GUARD_PAGE_NOT_READY'];
    finishBlockedRound(
      'the POST of a popup',
      ledger,
      monitor,
      snapshot.invariantViolations.some((entry) => popupViolations.includes(entry.code))
        || blockedPosts(ledger, WRITE_FIXTURE_PATHS.create) >= 1
        || monitor.snapshot().blockedByPayloadReason.DOCUMENT_CHARSET_UNKNOWN === 1,
      popupViolations,
    );
  }, ROUND_TIMEOUT_MS);

  it('does not deliver the requests that the page sends by itself (Worker, Service Worker, sendBeacon, keepalive, fetch, WebSocket, another origin)', async () => {
    const { page, ledger, monitor } = await openGuarded();
    await page.goto(server.formUrl('plain'));
    const outcome = await page.evaluate(async ({ paths, originB, timeoutMs }) => {
      const results: Record<string, string> = {};
      const attempt = async (key: string, run: () => Promise<unknown>): Promise<void> => {
        try {
          const value = await Promise.race([
            run(),
            new Promise((_resolve, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
          ]);
          results[key] = `ok ${String((value as { status?: number } | null)?.status ?? value)}`;
        } catch (error) {
          results[key] = `error ${(error as Error).name}`;
        }
      };
      const body = 'customer_name=x&memo=y';
      await attempt('worker', () => new Promise((resolve, reject) => {
        const worker = new Worker(paths.worker);
        worker.onmessage = (event) => (event.data === 'sent' ? resolve('sent') : reject(new Error('blocked')));
        worker.onerror = () => reject(new Error('worker'));
      }));
      await attempt('serviceWorker', () => ServiceWorkerContainer.prototype.register.call(navigator.serviceWorker, paths.serviceWorker));
      await attempt('fetchPost', () => fetch(paths.create, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } }));
      await attempt('keepalive', () => fetch(paths.create, { method: 'POST', body, keepalive: true }));
      await attempt('beacon', async () => {
        if (!navigator.sendBeacon(paths.create, new Blob([body], { type: 'application/x-www-form-urlencoded' }))) throw new Error('beacon');
        return 'queued';
      });
      await attempt('otherOrigin', () => fetch(`${originB}${paths.collect}`, { method: 'POST', body, mode: 'no-cors' }));
      await attempt('webSocket', () => new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://${location.host}${paths.webSocket}`);
        socket.onopen = () => resolve('open');
        socket.onerror = () => reject(new Error('error'));
        socket.onclose = () => reject(new Error('close'));
      }));
      return results;
    }, { paths: WRITE_FIXTURE_PATHS, originB: server.originB, timeoutMs: IN_PAGE_ATTEMPT_TIMEOUT_MS });
    await wait(QUIET_PERIOD_MS * 2);
    console.info(`T30b (${name}) page requests: ${JSON.stringify(outcome)}`);
    expect(outcome['worker']).not.toBe('ok sent');
    expect(outcome['serviceWorker']?.startsWith('error')).toBe(true);
    expect(outcome['fetchPost']?.startsWith('error')).toBe(true);
    expect(outcome['keepalive']?.startsWith('error')).toBe(true);
    expect(outcome['otherOrigin']?.startsWith('error')).toBe(true);
    expect(outcome['webSocket']?.startsWith('error')).toBe(true);
    expect(server.requests.some((entry) => entry.path.startsWith(WRITE_FIXTURE_PATHS.serviceWorker))).toBe(false);
    expect(monitor.submissionReport().submission).toBe('NOT_SENT');
    const snapshot = ledger.snapshot();
    finishBlockedRound(
      'the requests that the page sends by itself',
      ledger,
      monitor,
      blockedPosts(ledger, WRITE_FIXTURE_PATHS.create) >= 3 && blockedPosts(ledger, WRITE_FIXTURE_PATHS.collect) === 1
        && snapshot.blockedWebSockets.length === 1,
    );
  }, ROUND_TIMEOUT_MS);

  it('blocks another request in the submission window (the value in an image URL), and then delivers the approved POST', async () => {
    const { page, ledger, monitor } = await openGuarded();
    await submitForm(page, monitor, 'window-request');
    expectedNonRead.push(`A POST ${WRITE_FIXTURE_PATHS.create}`);
    expect(server.requests.filter((entry) => entry.path.startsWith(WRITE_FIXTURE_PATHS.pixel))).toEqual([]);
    expect(monitor.unexpectedRequestCount()).toBeGreaterThan(0);
    expect(monitor.submissionReport()).toEqual({ submission: 'SENT', responseReceived: true, responseStatus: 303, sendAttempts: 1, sendOutcome: 'RESPONDED' });
    finishBlockedRound('another request in the submission window', ledger, monitor, monitor.snapshot().blockedByReason.SUBMISSION_WINDOW >= 1);
  }, ROUND_TIMEOUT_MS);

  it('after all the rounds, no request arrives late (counted again after a named wait)', async () => {
    await wait(LATE_DELIVERY_SETTLE_MS);
    console.info(`T30b (${name}) late check: blocked rounds ${blockedRounds.length}; server ${JSON.stringify(nonReadRequests(server.requests))}`);
    expect(nonReadRequests(server.requests)).toEqual(expectedNonRead);
    expect(server.requests.filter((entry) => entry.site === 'B')).toEqual([]);
    expect(blockedRounds.length).toBe(21);
  }, ROUND_TIMEOUT_MS);
});
