// DEF-027（設計書 `2026-10-05-beaksight-def-027-external-cancel-design.md`）: 読み込み中の main frame の文書の要求が、応答を受ける前に取り消された場合に、
// Guard 自身の証拠（Guard の page の CDP の session で受けた `Network.loadingFailed`）で違反にしないことの判定を、偽の page の session と偽の Context で確かめる
// （証拠の部品の上限、session を閉じた後、区別できない場合。DEF-026 のテストのやり方）。Browser は起動しない。
// SLIM-GROUP（設計書 `2026-11-14-beaksight-slim-and-simplify-design.md` 5.4）: `tests/integration/guard-external-cancel.test.ts`（本物の Chromium の場面。
// Chromium の版を上げるときの束）から、区切りで流す確かめとしてここへ移した。
import type { BrowserContext, Page, Request } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INVALID_INTERCEPTION_ID_FAILURE_TEXTS } from '../../src/browser/playwright-errors.js';
import { wait, yieldMacrotask } from '../../src/core/deadline.js';
import {
  awaitPassiveRequestGuardReady,
  CANCELED_DOCUMENT_EVIDENCE_WAIT_MS,
  closePassiveGuardedContext,
  installPassiveRequestGuard,
  isPassiveRequestGuardClosed,
  MAX_CANCELED_DOCUMENT_EVIDENCE,
} from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { fakeFrame, fakePlaywrightRequest } from '../helpers/fake-playwright-request.js';
import { createGuardHarness, createHarnessPage, GUARD_HARNESS_ROOT_FRAME_ID } from '../helpers/passive-guard-harness.js';

/** L10: 撤廃した、取り消しの証拠を捨てる時間（前の `CANCELED_DOCUMENT_EVIDENCE_RETENTION_MS`。5 秒）の写し。 */
const FORMER_CANCELED_DOCUMENT_EVIDENCE_RETENTION_MS = 5_000;
/** L10: 撤廃した、続けた main frame の文書の要求の記録を捨てる時間（前の `PENDING_MAIN_FRAME_DOCUMENT_RETENTION_MS`。10 分）の写し。 */
const FORMER_PENDING_MAIN_FRAME_DOCUMENT_RETENTION_MS = 600_000;
/** ブラウザが文書の要求を取り消したときの、失敗の理由（Playwright の `requestfailed` と CDP の `Network.loadingFailed` の `errorText`）。 */
const ABORTED = 'net::ERR_ABORTED';
/** 違反にならない取り消しを確かめた後に待つ時間（ms）。Guard が証拠を待つ時間の後に記録される違反も見逃さない。 */
const SETTLE_AFTER_CANCEL_MS = CANCELED_DOCUMENT_EVIDENCE_WAIT_MS * 2;
const STATUS = Object.freeze({ ok: 200, noContent: 204 });
/** 違反の記録（DEF-145: 失敗した main frame の要求の method と path を持つ）。 */
const DELIVERY_FAILED = Object.freeze({
  code: 'HTTP_MAIN_FRAME_DELIVERY_FAILED',
  message: ABORTED,
  request: expect.objectContaining({ method: expect.any(String), path: expect.any(String) }),
});

const FAKE_ORIGIN = 'https://example.test';
const FAKE_ROOT_FRAME_ID = GUARD_HARNESS_ROOT_FRAME_ID;

interface FakeCommand {
  readonly method: string;
  readonly params: { readonly requestId?: string } | undefined;
}

/** 偽の page の session の命令の応答を決める（`undefined` なら、成功）。 */
type FakeResponder = (method: string, params: FakeCommand['params']) => Promise<unknown> | undefined;

interface FakeGuard {
  readonly ledger: SafetyLedger;
  readonly page: Page;
  readonly context: BrowserContext;
  readonly commands: readonly FakeCommand[];
  /** Guard の page の session に、CDP の事象を送る。 */
  emitCdp(method: string, params?: unknown): void;
  /** Guard に、Playwright の `requestfailed` を送る。 */
  emitRequestFailed(request: Request): void;
}

const fakeGuards: BrowserContext[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const context of fakeGuards.splice(0)) {
    await closePassiveGuardedContext(context).catch(() => undefined);
  }
});

/**
 * 偽の Context に Guard を取り付け、偽の page を Guard の準備ができた状態にする。偽の Context と page の session と page は、
 * Guard のテストの共通の補助（`createGuardHarness`・`createHarnessPage`。CC-044）で作る。session の命令の応答は `respond` で決め、
 * `Page.getFrameTree` には main frame（`FAKE_ROOT_FRAME_ID`）を返す。
 */
async function startFakeGuard(respond: FakeResponder = () => undefined): Promise<FakeGuard> {
  const harness = createGuardHarness({ cdpSendOverride: (method, params) => respond(method, params as FakeCommand['params']) });
  const ledger = new SafetyLedger();
  await installPassiveRequestGuard(harness.context, ledger, new Set([FAKE_ORIGIN]));
  const page = createHarnessPage(harness, { url: `${FAKE_ORIGIN}/` });
  await awaitPassiveRequestGuardReady(page);
  fakeGuards.push(harness.context);
  return {
    ledger,
    page,
    context: harness.context,
    commands: harness.cdpCommandLog as readonly FakeCommand[],
    // DEF-042: この偽の Guard が送る `Fetch.requestPaused` は、すべて main frame の文書の要求なので、`resourceType` を `Document` にして渡す。
    emitCdp: (method, params) => harness.emitCdp(
      method,
      method === 'Fetch.requestPaused' ? { resourceType: 'Document', ...(params as object) } : params,
    ),
    emitRequestFailed: (request) => {
      void harness.requestFailedHandler?.(request);
    },
  };
}

/** main frame の文書の要求（偽の Guard の、1つの要求）。 */
interface FakeDocument {
  readonly requestId: string;
  readonly networkId: string;
  readonly url: string;
  readonly method?: string;
}

const fakeDocument = (index: number, url = `${FAKE_ORIGIN}/document-${index}`): FakeDocument => ({
  requestId: `interception-${index}`,
  networkId: `network-${index}`,
  url,
});

/** Guard の page の session に、main frame の文書の要求の Request の段階の一時停止を送り、Guard が `Fetch.continueRequest` を送るまで待つ。 */
async function pauseAndContinue(guard: FakeGuard, document: FakeDocument): Promise<void> {
  const sentBefore = guard.commands.length;
  guard.emitCdp('Fetch.requestPaused', {
    requestId: document.requestId,
    networkId: document.networkId,
    frameId: FAKE_ROOT_FRAME_ID,
    request: { method: document.method ?? 'GET', url: document.url },
  });
  for (let turn = 0; turn < 10; turn += 1) {
    await yieldMacrotask();
    if (guard.commands.slice(sentBefore).some((command) => command.method === 'Fetch.continueRequest'
      && command.params?.requestId === document.requestId)) {
      // 命令の成功の処理（`await` の後）まで進める。
      await yieldMacrotask();
      return;
    }
  }
  throw new Error(`the Guard did not continue ${document.requestId}: ${JSON.stringify(guard.commands.slice(sentBefore))}`);
}

/** 同じ session の、文書の要求の取り消しの証拠（`Network.loadingFailed`）。 */
const canceledEvidence = (document: FakeDocument, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  requestId: document.networkId,
  canceled: true,
  type: 'Document',
  errorText: ABORTED,
  ...overrides,
});

/** Playwright の `requestfailed` が受ける、main frame のナビゲーションの要求（CC-094。DEF-120: 種類は `document`）。 */
const failedNavigation = (page: Page, document: FakeDocument, errorText = ABORTED): Request => fakePlaywrightRequest({
  method: document.method ?? 'GET',
  url: document.url,
  navigation: true,
  frame: fakeFrame(page),
  failureText: errorText,
  response: null,
});

/** Guard の作業が終わり、記録された違反を返す（証拠を待つ時間より長く待つ）。 */
async function violationsAfterSettle(guard: FakeGuard): Promise<readonly { readonly code: string; readonly message: string }[]> {
  await wait(SETTLE_AFTER_CANCEL_MS);
  return guard.ledger.snapshot().invariantViolations;
}

/**
 * SAFE-2 の 4（違反の区分の (3)。設計者の判断）: Guard が取り消しを確かめられない読み取り（GET）の main frame の移動の失敗は、違反にせず、読み取りの失敗の
 * 記録（`readNavigationFailures`）に残し、Context は閉じない。その形（違反がなく、読み取りの失敗の記録があり、Context が開いている）を確かめる。
 */
async function expectReadFailureOnly(guard: FakeGuard): Promise<void> {
  expect(await violationsAfterSettle(guard)).toEqual([]);
  expect((guard.ledger.snapshot().readNavigationFailures?.events ?? []).map(({ method, errorText }) => `${method} ${errorText}`).length)
    .toBeGreaterThan(0);
  expect(isPassiveRequestGuardClosed(guard.context)).toBe(false);
}

describe('DEF-027: the Guard\'s evidence of a main-frame document canceled before any response (fake page session)', () => {
  it('baseline: continued, canceled with net::ERR_ABORTED, and no response → not a violation (the harness reaches the new path)', async () => {
    const guard = await startFakeGuard();
    const document = fakeDocument(1);
    await pauseAndContinue(guard, document);

    guard.emitCdp('Network.loadingFailed', canceledEvidence(document));
    guard.emitRequestFailed(failedNavigation(guard.page, document));

    expect(await violationsAfterSettle(guard)).toEqual([]);
    expect(isPassiveRequestGuardClosed(guard.context)).toBe(false);
  });

  it('the evidence arrives after the requestfailed event, within the wait: not a violation', async () => {
    const guard = await startFakeGuard();
    const document = fakeDocument(1);
    await pauseAndContinue(guard, document);

    guard.emitRequestFailed(failedNavigation(guard.page, document));
    await wait(CANCELED_DOCUMENT_EVIDENCE_WAIT_MS / 5);
    guard.emitCdp('Network.loadingFailed', canceledEvidence(document));

    expect(await violationsAfterSettle(guard)).toEqual([]);
  });

  // 8. 証拠がない場合。
  it('the evidence never arrives: a read failure after the wait (SAFE-2)', async () => {
    const guard = await startFakeGuard();
    const document = fakeDocument(1);
    await pauseAndContinue(guard, document);

    guard.emitRequestFailed(failedNavigation(guard.page, document));

    await expectReadFailureOnly(guard);
  });

  // L10（設計書 `2026-11-09-beaksight-remove-limits-design.md` 4。INV-LIMITS の N22）: 前は、証拠を `MAX_CANCELED_DOCUMENT_EVIDENCE` 件までにし、超えた証拠を
  // 覚えずに違反にした。上限は撤廃したので、前の上限を超えても証拠を覚え、違反にしない。
  it('beyond the former evidence limit: the canceled request\'s evidence is remembered, so it is not a violation (L10)', async () => {
    const guard = await startFakeGuard();
    const document = fakeDocument(1);
    await pauseAndContinue(guard, document);
    for (let index = 0; index < MAX_CANCELED_DOCUMENT_EVIDENCE; index += 1) {
      guard.emitCdp('Network.loadingFailed', { requestId: `other-${index}`, canceled: true, type: 'Document', errorText: ABORTED });
    }

    guard.emitCdp('Network.loadingFailed', canceledEvidence(document));
    guard.emitRequestFailed(failedNavigation(guard.page, document));

    expect(await violationsAfterSettle(guard)).toEqual([]);
  });

  // L10（INV-LIMITS の N22）: 前は、main frame の文書の記録を同じ上限までにし、超えた要求の取り消しを違反にした。上限は撤廃したので、超えた要求も覚え、違反にしない。
  it('beyond the former main-frame document record limit: the request is remembered, so its cancellation is not a violation (L10)', async () => {
    const guard = await startFakeGuard();
    // 応答を受けたまま終わっていない main frame の文書の要求で、記録を上限まで埋める（Response の段階の一時停止で、リダイレクトの
    // 対応付けの登録も消す）。
    for (let index = 0; index < MAX_CANCELED_DOCUMENT_EVIDENCE; index += 1) {
      const filler = fakeDocument(index);
      await pauseAndContinue(guard, filler);
      guard.emitCdp('Fetch.requestPaused', {
        requestId: filler.requestId,
        networkId: filler.networkId,
        frameId: FAKE_ROOT_FRAME_ID,
        request: { method: 'GET', url: filler.url },
        responseStatusCode: STATUS.ok,
        responseHeaders: [],
      });
      await yieldMacrotask();
    }
    expect(guard.ledger.snapshot().invariantViolations).toEqual([]);
    const document = fakeDocument(MAX_CANCELED_DOCUMENT_EVIDENCE);
    await pauseAndContinue(guard, document);

    guard.emitCdp('Network.loadingFailed', canceledEvidence(document));
    guard.emitRequestFailed(failedNavigation(guard.page, document));

    expect(await violationsAfterSettle(guard)).toEqual([]);
  });

  // L10（INV-LIMITS の T29 と設計者の判断 E）: 証拠は時間で捨てず session を閉じるまで持つので、前の保持の時間を過ぎた証拠でも違反にしない。
  it('the evidence is older than the former retention of 5 seconds: not a violation (L10)', async () => {
    const guard = await startFakeGuard();
    const document = fakeDocument(1);
    await pauseAndContinue(guard, document);
    guard.emitCdp('Network.loadingFailed', canceledEvidence(document));

    // 時計だけを進める（Guard の待ちの setTimeout は、実際の時間で動かす）。
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + FORMER_CANCELED_DOCUMENT_EVIDENCE_RETENTION_MS + 1);
    guard.emitRequestFailed(failedNavigation(guard.page, document));

    expect(await violationsAfterSettle(guard)).toEqual([]);
  });

  // L10（INV-LIMITS の T29 と設計者の判断 E）: 記録は時間で捨てないので、前の保持の時間（10 分）を過ぎた後の取り消しも違反にしない。
  it('the record of the continued request is older than the former retention of 10 minutes when it is canceled: not a violation (L10)', async () => {
    const guard = await startFakeGuard();
    const document = fakeDocument(1);
    await pauseAndContinue(guard, document);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + FORMER_PENDING_MAIN_FRAME_DOCUMENT_RETENTION_MS + 1);
    guard.emitCdp('Network.loadingFailed', canceledEvidence(document));
    guard.emitRequestFailed(failedNavigation(guard.page, document));

    expect(await violationsAfterSettle(guard)).toEqual([]);
  });

  it('the session closes while the Guard waits for the evidence: recorded as a read failure (not a violation), and later evidence is ignored', async () => {
    const guard = await startFakeGuard();
    const document = fakeDocument(1);
    await pauseAndContinue(guard, document);

    guard.emitRequestFailed(failedNavigation(guard.page, document));
    await yieldMacrotask();
    guard.emitCdp('close');
    guard.emitCdp('Network.loadingFailed', canceledEvidence(document));

    // SAFE-2 の 4: 取り消しを確かめられない読み取りの失敗は、違反でなく読み取りの失敗の記録になる。session を閉じたこと自体の違反（`CDP_SESSION_DETACHED`）は、
    // 決まりのとおり違反に残る（この確かめの対象ではない）。
    expect(await violationsAfterSettle(guard)).not.toContainEqual(DELIVERY_FAILED);
    expect(guard.ledger.snapshot().readNavigationFailures?.events.map(({ method }) => method)).toEqual(['GET']);
  });

  // 9. 区別できない場合。
  it('two continued requests with the same page, method and URL: the cancellation cannot be told apart, so it is a read failure (SAFE-2)', async () => {
    const guard = await startFakeGuard();
    const url = `${FAKE_ORIGIN}/same`;
    const first = fakeDocument(1, url);
    const second = fakeDocument(2, url);
    await pauseAndContinue(guard, first);
    await pauseAndContinue(guard, second);

    guard.emitCdp('Network.loadingFailed', canceledEvidence(first));
    guard.emitRequestFailed(failedNavigation(guard.page, first));

    await expectReadFailureOnly(guard);
  });

  it('a request that finished (Network.loadingFinished) is no longer a candidate', async () => {
    const guard = await startFakeGuard();
    const url = `${FAKE_ORIGIN}/same`;
    const loaded = fakeDocument(1, url);
    const canceled = fakeDocument(2, url);
    await pauseAndContinue(guard, loaded);
    guard.emitCdp('Network.loadingFinished', { requestId: loaded.networkId });
    await pauseAndContinue(guard, canceled);

    guard.emitCdp('Network.loadingFailed', canceledEvidence(canceled));
    guard.emitRequestFailed(failedNavigation(guard.page, canceled));

    expect(await violationsAfterSettle(guard)).toEqual([]);
  });

  it('the evidence is used once: a second requestfailed for the same request is a read failure (SAFE-2)', async () => {
    const guard = await startFakeGuard();
    const document = fakeDocument(1);
    await pauseAndContinue(guard, document);
    guard.emitCdp('Network.loadingFailed', canceledEvidence(document));

    guard.emitRequestFailed(failedNavigation(guard.page, document));
    await wait(SETTLE_AFTER_CANCEL_MS);
    expect(guard.ledger.snapshot().invariantViolations).toEqual([]);
    guard.emitRequestFailed(failedNavigation(guard.page, document));

    await expectReadFailureOnly(guard);
  });

  // (c) 応答を1つでも受けた要求は、対象にしない。
  it.each([
    ['a Response-stage pause', (guard: FakeGuard, document: FakeDocument): void => guard.emitCdp('Fetch.requestPaused', {
      requestId: document.requestId,
      networkId: document.networkId,
      frameId: FAKE_ROOT_FRAME_ID,
      request: { method: 'GET', url: document.url },
      responseStatusCode: STATUS.noContent,
      responseHeaders: [],
    })],
    ['Network.responseReceived', (guard: FakeGuard, document: FakeDocument): void => guard.emitCdp('Network.responseReceived', {
      requestId: document.networkId,
      type: 'Document',
      frameId: FAKE_ROOT_FRAME_ID,
      response: { status: STATUS.ok },
    })],
    ['a redirect (Network.requestWillBeSent with redirectResponse)', (guard: FakeGuard, document: FakeDocument): void => guard.emitCdp(
      'Network.requestWillBeSent',
      { requestId: document.networkId, type: 'Document', frameId: FAKE_ROOT_FRAME_ID, redirectResponse: { status: 302 } },
    )],
  ] as const)('after %s, a cancellation is a read failure (SAFE-2)', async (_name, respond) => {
    const guard = await startFakeGuard();
    const document = fakeDocument(1);
    await pauseAndContinue(guard, document);

    respond(guard, document);
    await yieldMacrotask();
    guard.emitCdp('Network.loadingFailed', canceledEvidence(document));
    guard.emitRequestFailed(failedNavigation(guard.page, document));

    await expectReadFailureOnly(guard);
  });

  // (b) 取り消しの証拠の形。
  it.each([
    ['not canceled', { canceled: false }],
    ['not a Document', { type: 'Other' }],
    ['another error text', { errorText: 'net::ERR_FAILED' }],
  ] as const)('a loadingFailed that is %s is not the evidence: a read failure (SAFE-2)', async (_name, overrides) => {
    const guard = await startFakeGuard();
    const document = fakeDocument(1);
    await pauseAndContinue(guard, document);

    guard.emitCdp('Network.loadingFailed', canceledEvidence(document, overrides));
    guard.emitRequestFailed(failedNavigation(guard.page, document));

    await expectReadFailureOnly(guard);
  });

  // (a) Guard が許可して進めた（`Fetch.continueRequest` が成功した）要求に限る。一時停止の間に取り消された要求への命令の失敗（DEF-026 で
  // 違反にしない）は、進めたことにならない。
  it('a request canceled while paused (the continue command failed, tolerated by DEF-026): its requestfailed is a read failure (SAFE-2)', async () => {
    const [invalidInterceptionId] = INVALID_INTERCEPTION_ID_FAILURE_TEXTS;
    const document = fakeDocument(1);
    let guardForEvidence: FakeGuard | undefined;
    const guard = await startFakeGuard((method) => (method === 'Fetch.continueRequest'
      ? Promise.resolve().then(() => {
        guardForEvidence?.emitCdp('Network.loadingFailed', canceledEvidence(document));
        throw new Error(invalidInterceptionId);
      })
      : undefined));
    guardForEvidence = guard;
    guard.emitCdp('Fetch.requestPaused', {
      requestId: document.requestId,
      networkId: document.networkId,
      frameId: FAKE_ROOT_FRAME_ID,
      request: { method: 'GET', url: document.url },
    });
    await expect.poll(() => guard.commands.some((command) => command.method === 'Fetch.continueRequest')).toBe(true);

    guard.emitRequestFailed(failedNavigation(guard.page, document));

    // DEF-026 のとおり、命令の失敗は違反にならない。main frame の失敗は、進めた証拠がないので読み取りの失敗。
    await expectReadFailureOnly(guard);
  });

  it('a request of a subframe is not a main-frame candidate: a main-frame failure with the same URL is a read failure (SAFE-2)', async () => {
    const guard = await startFakeGuard();
    const document = fakeDocument(1);
    const sentBefore = guard.commands.length;
    guard.emitCdp('Fetch.requestPaused', {
      requestId: document.requestId,
      networkId: document.networkId,
      frameId: 'child-frame',
      request: { method: 'GET', url: document.url },
    });
    await expect.poll(() => guard.commands.slice(sentBefore).some((command) => command.method === 'Fetch.continueRequest')).toBe(true);
    await yieldMacrotask();

    guard.emitCdp('Network.loadingFailed', canceledEvidence(document));
    guard.emitRequestFailed(failedNavigation(guard.page, document));

    await expectReadFailureOnly(guard);
  });
});
