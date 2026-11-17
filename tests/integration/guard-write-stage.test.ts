// T30b（Task 30 の設計書 `2026-10-13-beaksight-task-30-approved-create-design.md` 3 章の「書き込みの段」「送る中身の照合」、4 章、6 章）:
// 書き込みの段の Guard（`PassiveRequestGuardOptions.writeStage`）。本物の Guard と、127.0.0.1 の fixture のサーバ
// （`tests/helpers/write-fixture-server.ts`）で確かめる。
// - 承認の要求の形に一致し、送る中身が一致する main frame のナビゲーションの POST が、1 回だけサーバに届く（送信の報告は `SENT` と応答）。
// - 次はサーバに届かない（回ごとにサーバの記録で数え、全部の回の後に `LATE_DELIVERY_SETTLE_MS` だけ待ってもう一度数える。止めた証拠が回ごとに
//   ある）: 2 回目の POST、別の path、別の Origin、未知の欄つき、値の違い、`text/plain`、GET の form、307・308 の再 POST、iframe の中の form、
//   popup の POST、Worker・Service Worker の fetch、`navigator.sendBeacon`、`fetch` の `keepalive`、WebSocket、送信の窓の中の別の要求、送信の前に
//   ページの JS が form の action を書き換える、送信の前にページの JS が欄を足す、UTF-8 でない文書、送信の窓を開かない送信、file の中身。
// - 送信の報告: 通さなかった → `NOT_SENT`、通して応答あり、通して応答なし（Guard を閉じると `NO_RESPONSE`）。
// - CSRF の hidden の値と readonly の値は、Guard の記録（Safety Ledger と書き込みの段の記録）に出ない（目印の値で確かめる）。
// - T31c（もとの guard-update-payload をまとめた）: 更新の POST で、ページの JS が状態の hidden を `active=0`（削除にあたる変更）にすると届かない
//   （urlencoded と multipart）。ほかの更新の書き換えの照合は単体 `tests/unit/write-payload-update.test.ts` と結合 write-update-run に任せる。
// - LU-12a: 前の値を後から入れる口の約束（代表 1。照合の網羅は単体 write-payload-update の「deferred」の場面）。
// - 書き込みの段（form）の Guard の結合の家（SLIM）。Chromium は `BOTH_CHROMIUM_LAUNCHERS`（既定は CLI の起動の設定の 1 つ、両方に広げる回だけ 2 つ）。
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
import { recordPathShapeOf } from '../../src/safety/request-policy.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import type { WriteFormEnctype, WritePayloadExpectation } from '../../src/safety/write-payload-policy.js';
import { BOTH_CHROMIUM_LAUNCHERS } from '../helpers/chromium.js';
import { QUIET_PERIOD_MS } from '../helpers/gate-harness.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import {
  UPDATE_FIXTURE_PATHS,
  UPDATE_FIXTURE_VALUES,
  startUpdatePayloadFixtureServer,
  type UpdateFixtureServer,
  type UpdateFormEnctype,
} from '../helpers/update-payload-fixture-server.js';
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
/** T31c: 更新の画面で変える欄に入れる新しい値。 */
const UPDATED_NAME = '佐藤 花子';

/** サーバに届いた、GET と HEAD 以外の要求（WebSocket の upgrade を含む）。 */
const nonReadRequests = (requests: readonly WriteFixtureRequest[]): string[] => requests
  .filter((entry) => entry.method !== 'GET' && entry.method !== 'HEAD')
  .map((entry) => `${entry.site} ${entry.method} ${entry.path}`);

describe.each(BOTH_CHROMIUM_LAUNCHERS)('T30b: the write stage of the Guard, with %s', (name, launch) => {
  let browser: Browser;
  let server: WriteFixtureServer;
  const contexts: BrowserContext[] = [];
  /** これまでの回で、サーバに届いてよいと確かめた GET と HEAD 以外の要求（承認の POST だけ）。 */
  const expectedNonRead: string[] = [];
  /** これまでの回で、止めた証拠のあった回の名前。 */
  const blockedRounds: string[] = [];

  let submissionProxy: WriteSubmissionProxy;
  /** T31c: 更新の画面のサーバ（状態の hidden の回）。 */
  let updateServer: UpdateFixtureServer;

  beforeAll(async () => {
    browser = await launch();
    server = await startWriteFixtureServer();
    updateServer = await startUpdatePayloadFixtureServer();
    // DEF-099 fix: 承認の POST は、Guard が送り手に送らせる（中継を通して 1 回だけ）。
    submissionProxy = await startWriteSubmissionProxy();
  });

  afterAll(async () => {
    await submissionProxy?.close();
    await updateServer?.close();
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
    // LU-SFIX4（LU-REV の Minor-1）: 前の値を後から入れる印のある期待（一覧の行の更新）は、窓の前に守る型が必須（作り方は Guard と同じ部品 `recordPathShapeOf`）。
    const { path } = expectation.request;
    const guardedPathShape = expectation.deferredPriorValues === undefined ? null : recordPathShapeOf(path, path.split('/').at(-1) ?? '');
    const writeStage: GuardWriteStage = guardedPathShape === null ? { expectation, monitor } : { expectation, monitor, guardedPathShape };
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
    // T40R-fix-A: 値を入れる間は窓の観察の段。押す直前に送信の段を開く（書き込みの入力の部品と同じ順。窓を開かない回は開けない）。
    monitor.openSubmissionPhase();
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

  /** T31c: 更新の画面のサーバに届いた、GET と HEAD 以外の要求（どの回でも 0 件）。 */
  const updateNonReadRequests = (): string[] => updateServer.requests
    .filter((entry) => !READ_METHODS.has(entry.method))
    .map((entry) => `${entry.method} ${entry.path}`);

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

  // DEF-099 fix round 1: Guard が閉じるとき、送信中の送り手を止める（書いた後なので `NO_RESPONSE`。時間の上限まで待たない）。
  // SLIM: 承認の届き方の 4 場面（multipart・`_method=PUT`・応答なし・遅い応答）の代表。閉じる前に「通して応答なし」の報告を確かめる。
  it('reports SENT without a response, and stops the write submission in flight when the Guard closes (NO_RESPONSE), without waiting for the time limit', async () => {
    const { page, ledger, monitor } = await openGuarded(expectationFor(WRITE_FIXTURE_PATHS.createHang));
    await page.goto(server.formUrl('hang'));
    await monitor.openSubmissionWindow(page);
    await page.fill('#customer_name', NAME_VALUE);
    await page.fill('#memo', MEMO_VALUE);
    // T40R-fix-A: 押す直前に送信の段を開く。
    monitor.openSubmissionPhase();
    await page.click('#go', { noWaitAfter: true });
    await wait(QUIET_PERIOD_MS * 2);
    expectedNonRead.push(`A POST ${WRITE_FIXTURE_PATHS.createHang}`);
    expect(nonReadRequests(server.requests)).toEqual(expectedNonRead);
    expect(monitor.submissionReport()).toEqual({ submission: 'SENT', responseReceived: false, responseStatus: null, sendAttempts: 1, sendOutcome: null });
    expect(ledger.snapshot().invariantViolations).toEqual([]);
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
    // T40R-fix-A: 窓を開かなければ送信の段も開けない。承認の形の POST は、照合（前は `DOCUMENT_CHARSET_UNKNOWN` で止めた）の前に、要求の判定で止まる
    // （Safety Ledger に止めた POST が残り、照合にはかけない）。
    {
      round: 'a POST without the submission window',
      variant: 'plain',
      openWindow: false,
      evidence: (ledger, monitor) => blockedPosts(ledger, WRITE_FIXTURE_PATHS.create) === 1
        && Object.values(monitor.snapshot().blockedByPayloadReason).every((count) => count === 0),
    },
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
    // T40R-fix-A: 押す直前に送信の段を開く（送信の段でも、測った文書と違う文書の POST は通さない）。
    monitor.openSubmissionPhase();
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
    // T40R-fix-A: 押す直前に送信の段を開く（送信の段でも、iframe の form の POST は通さない）。
    monitor.openSubmissionPhase();
    await frame.locator('#go').click();
    await wait(QUIET_PERIOD_MS * 2);
    expect(monitor.submissionReport().submission).toBe('NOT_SENT');
    finishBlockedRound('the POST of a form in an iframe', ledger, monitor, blockedPosts(ledger, WRITE_FIXTURE_PATHS.create) === 1);
  }, ROUND_TIMEOUT_MS);

  it('does not deliver the POST of a popup (a form with target _blank)', async () => {
    const { page, ledger, monitor } = await openGuarded();
    const popup = page.waitForEvent('popup', { timeout: NAVIGATION_SETTLE_TIMEOUT_MS }).catch(() => null);
    // DEF-154: 混雑の下では、Guard が popup の最初のナビゲーション（承認の形の POST）を fail-closed で止めて Context を閉じるのが、`page.click` の
    // 戻りより先になる回がある（「Target page, context or browser has been closed」）。その回は、ページが閉じていて、その POST に結びつく
    // fail-closed の記録（`PASSIVE_GUARD_PAGE_NOT_READY`）が Ledger にあるときだけ続け、止めた証拠のある回に数える。ほかの誤りは投げ直す。
    const isFailClosedPopupPost = (entry: { readonly code: string; readonly request?: { readonly method: string; readonly path: string } }): boolean =>
      entry.code === 'PASSIVE_GUARD_PAGE_NOT_READY' && entry.request?.method === 'POST' && entry.request.path === WRITE_FIXTURE_PATHS.create;
    let closedByFailClosed = false;
    try {
      await submitForm(page, monitor, 'popup');
    } catch (error) {
      if (!page.isClosed() || !ledger.snapshot().invariantViolations.some(isFailClosedPopupPost)) throw error;
      closedByFailClosed = true;
    }
    const opened = await popup;
    await opened?.waitForLoadState('load', { timeout: NAVIGATION_SETTLE_TIMEOUT_MS }).catch(() => undefined);
    await wait(QUIET_PERIOD_MS * 2);
    const snapshot = ledger.snapshot();
    console.info(`T30b (${name}) popup: violations ${JSON.stringify(snapshot.invariantViolations.map((entry) => entry.code))}; `
      + `blocked ${JSON.stringify(snapshot.blockedRequests.map((entry) => `${entry.method} ${new URL(entry.url).pathname}`))}; `
      + `monitor ${JSON.stringify(monitor.snapshot())}; closed by fail-closed during the click ${closedByFailClosed}`);
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
      closedByFailClosed
        ? snapshot.invariantViolations.some(isFailClosedPopupPost)
        : snapshot.invariantViolations.some((entry) => popupViolations.includes(entry.code))
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

  // LU-12a（設計書 `2026-11-02-beaksight-list-row-update-design.md` 4.0.1 の K1、5.3 の 2・5.5。LU-9 の API の形と同じ約束）: 前の値を後から入れる印のある
  // フォームの期待。前の値は、窓を一度も開いていない間に 1 回だけ、Guard の口（`supplyFormPriorValues`）で入れる。入れていなければ、窓の中の正しい POST も
  // 照合で止まる（fail-closed）。ここでは `memo` を保つ見える欄（前の値に頼る欄）にする。
  /** LU-12a: 保つ見える欄 `memo` の前の値を後から入れる印のある期待（`memo` を送る欄に持たない）。 */
  const deferredExpectationFor = (): WritePayloadExpectation => ({
    ...expectationFor(),
    submittedFields: [{ name: 'customer_name', value: NAME_VALUE }],
    deferredPriorValues: { keptFieldNames: ['memo'], checkedPassthroughNames: [], keptCheckboxPairNames: [], changedCheckboxPairs: [], nullableFieldNames: [] },
  });
  /** LU-12a: 後から入れる前の値（書き換えられる一覧。写しを確かめる）。 */
  const suppliedPriorValues = (): { keptFields: { name: string; value: string | null }[]; checkedPassthroughFields: []; checkboxPairs: [] } =>
    ({ keptFields: [{ name: 'memo', value: MEMO_VALUE }], checkedPassthroughFields: [], checkboxPairs: [] });
  // SLIM: LU-12a の 5 場面の代表 1。入れていないときの fail-closed（`EXPECTATION_INVALID`）は単体 write-payload-update の「blocks the approved body with
  // EXPECTATION_INVALID before the prior values are supplied」、API の形は guard-api-write-stage の LU-9 に任せる。
  it('delivers the POST once after the prior values are supplied before the window, and rejects the wrong supplies (LU-12a)', async () => {
    // Guard のない口と、印のない期待の口は拒む。
    expect(new WriteStageMonitor().supplyFormPriorValues(suppliedPriorValues())).toBe(false);
    const unmarked = await openGuarded();
    expect(unmarked.monitor.supplyFormPriorValues({ keptFields: [{ name: 'memo', value: '別の値' }], checkedPassthroughFields: [], checkboxPairs: [] })).toBe(false);
    const { page, ledger, monitor } = await openGuarded(deferredExpectationFor());
    const prior = suppliedPriorValues();
    // fix round 1（設計者の判断 (b)）: null を許すのは、印の `nullableFieldNames` の欄だけ。text の欄（`memo`）の null は拒み、状態を変えない。
    expect(monitor.supplyFormPriorValues({ ...prior, keptFields: [{ name: 'memo', value: null }] })).toBe(false);
    // 鍵の集合が違えば拒み、Guard の状態を変えない（続く正しい 1 回を受ける）。API の形の口は、フォームの段では拒む。
    expect(monitor.supplyFormPriorValues({ ...prior, keptFields: [] })).toBe(false);
    expect(monitor.supplyFormPriorValues({ ...prior, keptFields: [...prior.keptFields, { name: 'customer_name', value: NAME_VALUE }] })).toBe(false);
    expect(monitor.supplyApiPriorValues({ keptKeys: [{ key: 'memo', value: MEMO_VALUE }], pageKeyPriorValues: [] })).toBe(false);
    expect(monitor.supplyFormPriorValues(prior)).toBe(true);
    // 2 回目は、同じ値でも拒む。
    expect(monitor.supplyFormPriorValues(prior)).toBe(false);
    // 入れた値は写して持つ（呼び手が後で元の object を変えても照合は変わらない）。
    const [first] = prior.keptFields;
    if (first !== undefined) first.value = '書き換え';
    await submitForm(page, monitor, 'plain');
    expectedNonRead.push(`A POST ${WRITE_FIXTURE_PATHS.create}`);
    expect(nonReadRequests(server.requests)).toEqual(expectedNonRead);
    expect(monitor.submissionReport()).toEqual({ submission: 'SENT', responseReceived: true, responseStatus: 303, sendAttempts: 1, sendOutcome: 'RESPONDED' });
    expect(Object.values(monitor.snapshot().blockedByPayloadReason).every((count) => count === 0)).toBe(true);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    expectNoMarkers(ledger, monitor);
    // 窓を開いた後に入れる値は拒む。
    expect(monitor.supplyFormPriorValues(suppliedPriorValues())).toBe(false);
  }, ROUND_TIMEOUT_MS);

  // T31c（もとの guard-update-payload）: 更新の POST で、送信の前にページの JS が状態の hidden を `active=0`（削除にあたる変更）にすると、届かない。
  const updateExpectationFor = (enctype: UpdateFormEnctype): WritePayloadExpectation => ({
    request: { origin: updateServer.origin, path: UPDATE_FIXTURE_PATHS.record, enctype: enctype === 'multipart' ? MULTIPART : URLENCODED },
    submittedFields: [{ name: 'customer_name', value: UPDATED_NAME }, { name: 'memo', value: UPDATE_FIXTURE_VALUES.memo }],
    passthroughFieldNames: ['authenticity_token', 'lock_version'],
    emptyFileFieldNames: [],
    methodOverride: 'PATCH',
    checkedPassthroughFields: [{ name: 'active', value: UPDATE_FIXTURE_VALUES.active }],
    checkboxPairs: [{ name: 'published', offValue: UPDATE_FIXTURE_VALUES.publishedOff, checkedValue: UPDATE_FIXTURE_VALUES.publishedOn }],
    absentFieldNames: ['notify'],
  });

  it.each<UpdateFormEnctype>(['urlencoded', 'multipart'])('does not deliver the update POST whose state hidden the page sets to active=0 (%s), and reports NOT_SENT (T31c)', async (enctype) => {
    const context = await browser.newContext({ viewport: VIEWPORT, serviceWorkers: 'block', acceptDownloads: false });
    contexts.push(context);
    const ledger = new SafetyLedger();
    const monitor = new WriteStageMonitor();
    await installPassiveRequestGuard(context, ledger, new Set([updateServer.origin]), {
      writeStage: { expectation: updateExpectationFor(enctype), monitor },
      writeSubmission: submissionProxy.options,
    });
    const page = await context.newPage();
    await awaitPassiveRequestGuardReady(page);
    await page.goto(updateServer.formUrl('js-state', enctype));
    await monitor.openSubmissionWindow(page);
    await page.fill('#customer_name', UPDATED_NAME);
    monitor.openSubmissionPhase();
    await Promise.all([
      page.waitForEvent('framenavigated', { timeout: NAVIGATION_SETTLE_TIMEOUT_MS }).catch(() => undefined),
      page.click('#go'),
    ]);
    await page.waitForLoadState('load', { timeout: NAVIGATION_SETTLE_TIMEOUT_MS }).catch(() => undefined);
    await wait(QUIET_PERIOD_MS);
    expect(updateNonReadRequests()).toEqual([]);
    expect(monitor.submissionReport()).toEqual({ submission: 'NOT_SENT', responseReceived: false, responseStatus: null, sendAttempts: 0, sendOutcome: null });
    expect(JSON.stringify([ledger.snapshot(), monitor.snapshot(), monitor.submissionReport()])).not.toContain(updateServer.csrfMarker);
    finishBlockedRound(`the state hidden set to active=0 (${enctype})`, ledger, monitor, payloadReason(monitor, 'PASSTHROUGH_VALUE_MISMATCH'));
  }, ROUND_TIMEOUT_MS);

  // RB-4b: 送信の窓の中のほかの要求（値を入れた画像の URL）を止める場面は外した（書き込みの最中も、サイトの通信は止めない。ユーザーの判断 2026-11-15）。
  // 止める先がないので、別の所の確かめはない。

  it('after all the rounds, no request arrives late (counted again after a named wait)', async () => {
    await wait(LATE_DELIVERY_SETTLE_MS);
    console.info(`T30b (${name}) late check: blocked rounds ${blockedRounds.length}; server ${JSON.stringify(nonReadRequests(server.requests))}`);
    expect(nonReadRequests(server.requests)).toEqual(expectedNonRead);
    expect(server.requests.filter((entry) => entry.site === 'B')).toEqual([]);
    expect(updateNonReadRequests()).toEqual([]);
    expect(blockedRounds.length).toBe(22);
  }, ROUND_TIMEOUT_MS);
});
