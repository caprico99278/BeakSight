// T31c（Task 31 の設計書 3 章の「欄の役割」「削除にあたる変更の遮断」の送る中身の照合、「同じ名前の hidden と checkbox の組」、4 章の「照合」）:
// 書き込みの段の Guard（`PassiveRequestGuardOptions.writeStage`）で、更新の画面の POST を照らす。本物の Guard と、127.0.0.1 の fixture のサーバ
// （`tests/helpers/update-payload-fixture-server.ts`）で確かめる。
// - 承認の形の更新の POST（保つ欄は前の値、状態の hidden は前の値、組はチェックあり、チェックしていない checkbox は送らない、`_method=PATCH`）が、
//   urlencoded と multipart のそれぞれで 1 回だけサーバに届く。
// - 送信の前にページの JS が、(a) 保つ欄の値を書き換える、(b) 状態の hidden を `active=0` にする、(c) 組の hidden の値を書き換える・checkbox を
//   外す、(d) ないはずの checkbox をチェックする、のどれでも、POST はサーバに届かない（回ごとにサーバの記録で数え、全部の回の後に
//   `LATE_DELIVERY_SETTLE_MS` だけ待ってもう一度数える）。止めた理由（書き込みの段の記録）が回ごとにある。
// - CSRF の hidden の値は、Guard の記録に出ない（目印の値で確かめる）。
// - Chromium は headless だけ。テストの既定（headless shell）と、CLI の起動の設定（`launchCliChromium`）の両方で確かめる。
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import {
  awaitPassiveRequestGuardReady,
  closePassiveGuardedContext,
  installPassiveRequestGuard,
  WriteStageMonitor,
} from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import type { WriteFormEnctype, WritePayloadBlockReason, WritePayloadExpectation } from '../../src/safety/write-payload-policy.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { QUIET_PERIOD_MS } from '../helpers/gate-harness.js';
import { startWriteSubmissionProxy, type WriteSubmissionProxy } from '../helpers/write-submission-proxy.js';
import {
  UPDATE_FIXTURE_PATHS,
  UPDATE_FIXTURE_VALUES,
  startUpdatePayloadFixtureServer,
  type UpdateFixtureRequest,
  type UpdateFixtureServer,
  type UpdateFormEnctype,
  type UpdateFormVariant,
} from '../helpers/update-payload-fixture-server.js';

const VIEWPORT = Object.freeze({ width: 900, height: 700 });
/** ナビゲーションの結果（読み込みか、止められた失敗）を待つ上限（ms）。 */
const NAVIGATION_SETTLE_TIMEOUT_MS = 5_000;
/** 全部の回の後に、遅れて届く要求を見逃さないために待つ時間（ms。Task 30 の設計書 6 章の「2 秒」）。 */
const LATE_DELIVERY_SETTLE_MS = 2_000;
/** 1 つの回の期限（ms）。 */
const ROUND_TIMEOUT_MS = 60_000;
/** 変える欄に入れる新しい値。 */
const NEW_NAME = '佐藤 花子';

const ENCTYPES: Readonly<Record<UpdateFormEnctype, WriteFormEnctype>> = Object.freeze({
  urlencoded: 'application/x-www-form-urlencoded',
  multipart: 'multipart/form-data',
});

interface ChromiumLaunch {
  readonly name: string;
  launch(): Promise<Browser>;
}

const CHROMIUM_LAUNCHES: readonly ChromiumLaunch[] = [
  { name: 'the headless shell (test default)', launch: () => launchHeadlessChromium() },
  { name: 'the CLI Chromium (launchCliChromium, headless)', launch: () => launchCliChromium() },
];

/** サーバに届いた POST（`path` だけ）。 */
const posts = (requests: readonly UpdateFixtureRequest[]): string[] => requests
  .filter((entry) => entry.method !== 'GET' && entry.method !== 'HEAD')
  .map((entry) => `${entry.method} ${entry.path}`);

/** 止める回（送信の前にページの JS が中身を変える形と、止めた理由）。 */
interface BlockedRound {
  readonly round: string;
  readonly variant: Exclude<UpdateFormVariant, 'plain'>;
  readonly enctype: UpdateFormEnctype;
  readonly reason: WritePayloadBlockReason;
}

const BLOCKED_ROUNDS: readonly BlockedRound[] = [
  { round: '(a) a kept value that the page rewrites', variant: 'js-kept', enctype: 'urlencoded', reason: 'VALUE_MISMATCH' },
  { round: '(b) the state hidden that the page sets to active=0', variant: 'js-state', enctype: 'urlencoded', reason: 'PASSTHROUGH_VALUE_MISMATCH' },
  { round: '(b) the state hidden set to active=0 in multipart', variant: 'js-state', enctype: 'multipart', reason: 'PASSTHROUGH_VALUE_MISMATCH' },
  { round: '(c) the hidden of the pair that the page rewrites', variant: 'js-pair-hidden', enctype: 'urlencoded', reason: 'CHECKBOX_PAIR_MISMATCH' },
  { round: '(c) the checkbox of the pair that the page unchecks', variant: 'js-pair-uncheck', enctype: 'urlencoded', reason: 'CHECKBOX_PAIR_MISMATCH' },
  { round: '(d) a checkbox that the page checks', variant: 'js-absent', enctype: 'urlencoded', reason: 'UNEXPECTED_FIELD_PRESENT' },
];

describe.each(CHROMIUM_LAUNCHES)('T31c: the update payload in the write stage of the Guard, with $name', ({ name, launch }) => {
  let browser: Browser;
  let server: UpdateFixtureServer;
  const contexts: BrowserContext[] = [];
  /** これまでの回で、サーバに届いてよいと確かめた POST（承認の POST だけ）。 */
  const expectedPosts: string[] = [];
  /** これまでの回で、止めた証拠のあった回の名前。 */
  const blockedRounds: string[] = [];

  let submissionProxy: WriteSubmissionProxy;

  beforeAll(async () => {
    browser = await launch();
    server = await startUpdatePayloadFixtureServer();
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

  /** 更新の承認の期待（T31g がワーカーの側で作る形を、テストが手で作る）。 */
  const expectationFor = (enctype: UpdateFormEnctype): WritePayloadExpectation => ({
    request: { origin: server.origin, path: UPDATE_FIXTURE_PATHS.record, enctype: ENCTYPES[enctype] },
    submittedFields: [{ name: 'customer_name', value: NEW_NAME }, { name: 'memo', value: UPDATE_FIXTURE_VALUES.memo }],
    passthroughFieldNames: ['authenticity_token', 'lock_version'],
    emptyFileFieldNames: [],
    methodOverride: 'PATCH',
    checkedPassthroughFields: [{ name: 'active', value: UPDATE_FIXTURE_VALUES.active }],
    checkboxPairs: [{ name: 'published', offValue: UPDATE_FIXTURE_VALUES.publishedOff, checkedValue: UPDATE_FIXTURE_VALUES.publishedOn }],
    absentFieldNames: ['notify'],
  });

  /** 本物の Guard を付けた Context で更新の画面を開き、送信の窓を開いてから変える欄に入れ、送る。結果の読み込みか失敗を待つ。 */
  const submitUpdate = async (variant: UpdateFormVariant, enctype: UpdateFormEnctype): Promise<{
    readonly page: Page;
    readonly ledger: SafetyLedger;
    readonly monitor: WriteStageMonitor;
  }> => {
    const context = await browser.newContext({ viewport: VIEWPORT, serviceWorkers: 'block', acceptDownloads: false });
    contexts.push(context);
    const ledger = new SafetyLedger();
    const monitor = new WriteStageMonitor();
    await installPassiveRequestGuard(context, ledger, new Set([server.origin]), {
      writeStage: { expectation: expectationFor(enctype), monitor },
      writeSubmission: submissionProxy.options,
    });
    const page = await context.newPage();
    await awaitPassiveRequestGuardReady(page);
    await page.goto(server.formUrl(variant, enctype));
    await monitor.openSubmissionWindow(page);
    await page.fill('#customer_name', NEW_NAME);
    await Promise.all([
      page.waitForEvent('framenavigated', { timeout: NAVIGATION_SETTLE_TIMEOUT_MS }).catch(() => undefined),
      page.click('#go'),
    ]);
    await page.waitForLoadState('load', { timeout: NAVIGATION_SETTLE_TIMEOUT_MS }).catch(() => undefined);
    await wait(QUIET_PERIOD_MS);
    return { page, ledger, monitor };
  };

  /** CSRF の目印が、Guard の記録に出ない。 */
  const expectNoMarker = (ledger: SafetyLedger, monitor: WriteStageMonitor): void => {
    expect(JSON.stringify([ledger.snapshot(), monitor.snapshot(), monitor.submissionReport()])).not.toContain(server.csrfMarker);
  };

  it.each<UpdateFormEnctype>(['urlencoded', 'multipart'])('delivers the approved %s update POST once, and reports SENT', async (enctype) => {
    const { page, ledger, monitor } = await submitUpdate('plain', enctype);
    expectedPosts.push(`POST ${UPDATE_FIXTURE_PATHS.record}`);
    console.info(`T31c (${name}) approved ${enctype}: server ${JSON.stringify(posts(server.requests))}; monitor ${JSON.stringify(monitor.snapshot())}`);
    expect(posts(server.requests)).toEqual(expectedPosts);
    expect(server.requests.filter((entry) => entry.method === 'POST').at(-1)?.contentType?.startsWith(ENCTYPES[enctype])).toBe(true);
    expect(new URL(page.url()).pathname).toBe(UPDATE_FIXTURE_PATHS.record);
    await expect(page.textContent('#updated')).resolves.toBe('UPDATED');
    expect(monitor.submissionReport()).toEqual({ submission: 'SENT', responseReceived: true, responseStatus: 303, sendAttempts: 1, sendOutcome: 'RESPONDED' });
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    expectNoMarker(ledger, monitor);
  }, ROUND_TIMEOUT_MS);

  it.each(BLOCKED_ROUNDS)('does not deliver $round ($enctype), and reports NOT_SENT', async ({ round, variant, enctype, reason }) => {
    const { ledger, monitor } = await submitUpdate(variant, enctype);
    console.info(`T31c (${name}) ${round}: server ${JSON.stringify(posts(server.requests))}; monitor ${JSON.stringify(monitor.snapshot())}`);
    expect(posts(server.requests)).toEqual(expectedPosts);
    expect(monitor.submissionReport()).toEqual({ submission: 'NOT_SENT', responseReceived: false, responseStatus: null, sendAttempts: 0, sendOutcome: null });
    expect(monitor.snapshot().blockedByPayloadReason[reason], `${round}: blocking evidence`).toBe(1);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    expectNoMarker(ledger, monitor);
    blockedRounds.push(round);
  }, ROUND_TIMEOUT_MS);

  it('after all the rounds, no POST arrives late (counted again after a named wait)', async () => {
    await wait(LATE_DELIVERY_SETTLE_MS);
    console.info(`T31c (${name}) late check: blocked rounds ${blockedRounds.length}; server ${JSON.stringify(posts(server.requests))}`);
    expect(posts(server.requests)).toEqual(expectedPosts);
    expect(expectedPosts).toHaveLength(2);
    expect(blockedRounds).toHaveLength(BLOCKED_ROUNDS.length);
  }, ROUND_TIMEOUT_MS);
});
