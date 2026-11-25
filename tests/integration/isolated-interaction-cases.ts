// isolated-interaction のテストの本文と共通の補助（TS-c。設計書 `doc/design/2026-10-24-beaksight-test-suite-tiers-design.md` 3.3）。テストのファイルでは
// ない（Vitest は直接は流さない）。前の `isolated-interaction.test.ts`（466 件）を、describe の単位で 4 つのテストのファイルに分けて流すため、本文を
// ここに残し（複製しない）、describe の組ごとに登録の関数（`register*Cases`）を公開する。
// - `isolated-interaction-discovery.test.ts`: `registerInteractionProbeCases`・`registerCandidateDiscoveryCases`
// - `isolated-interaction-audit.test.ts`: `registerFailClosedAuditCases`・`registerInteractionSessionCases`
// - `isolated-interaction-corrections.test.ts`: `registerC3CorrectionCases('MAIN')`
// - `isolated-interaction-evidence.test.ts`: `registerC3CorrectionCases('F16')`
// このモジュールの最上位の準備（fixture のサーバ、テストの既定の Chromium、factory の `beforeAll`・`afterAll`）は、読み込んだテストのファイルごとに
// 登録される（Vitest はテストのファイルごとにモジュールを読み直す）。テストの名前（describe の名前を含む）は、分ける前と同じ。
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Browser, Page } from 'playwright';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { BrowserContextFactory, type InteractionGuardedSession } from '../../src/browser/context-factory.js';
import type { MainFrameLoadObservation } from '../../src/browser/main-frame-load.js';
import type { AuditConfig, Viewport } from '../../src/config/types.js';
import type { InteractionStatus } from '../../src/core/contracts.js';
import { wait } from '../../src/core/deadline.js';
import { createSha256Fingerprint } from '../../src/core/ids.js';
import {
  INTERACTION_IDENTITY_STATUSES,
  INTERACTION_LIFECYCLE_REASON_CODES,
  INTERACTION_NOT_VERIFIABLE_REASON_CODES,
  INTERACTION_REASON_CODES,
  INTERACTION_REASON_CODES_BY_STATUS,
  type BlockedInteractionRequestEvent,
  type InteractionChangeEvidence,
  type InteractionClosedLifecycle,
  type InteractionLifecycleReasonCode,
  type InteractionReasonCode,
  type InteractionWorkOutcome,
} from '../../src/core/evidence-types.js';
import { VISIBILITY_CHECK_OPTIONS } from '../../src/core/visibility.js';
import {
  discoverInteractionCandidates,
  inspectInteractionCandidateHandle,
  resolveInteractionCandidateHandle,
  INTERACTION_CANDIDATE_SELECTOR,
  interactionCandidateReadsOf,
  withInteractionCandidateReads,
  type InteractionCandidateReads,
} from '../../src/interaction/discover-candidates.js';
import {
  auditInteraction as auditInteractionUnderTest,
  INTERACTION_NOT_VERIFIABLE_REASONS,
  InteractionOwnerCleanupError,
  type InteractionAuditInput,
  type InteractionNonTerminalLifecycle,
} from '../../src/interaction/isolated-auditor.js';
import { classifyInteractionCandidate, type InteractionCandidate } from '../../src/safety/interaction-policy.js';
import { destructiveActionFactsOfNames } from '../../src/discovery/destructive-action.js';
import { CDP_SESSION_DETACHED_MESSAGE } from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { chromiumRunsOf, launchCliChromium, launchHeadlessChromium, useHeadlessChromium } from '../helpers/chromium.js';
import { createDeferred } from '../helpers/deferred.js';
import { fakePlaywrightRequest } from '../helpers/fake-playwright-request.js';
import { guardContextListenerEvents } from '../helpers/passive-guard-harness.js';
import {
  discoverInteractionCandidate,
  FROZEN_POPUP_LATE_DELIVERY_SETTLE_MS,
  GATE_INTERACTION_TIMING,
  interactionAuditInput,
  NO_NON_READ_REQUESTS,
  openServerWindow,
  POPUP_SELF_CLOSE_BEACON_PAGE,
  QUIET_PERIOD_MS,
  withGuardedPassivePage,
} from '../helpers/gate-harness.js';
import { startLoopbackHttpServer } from '../helpers/loopback-server.js';
import {
  adaptFakePage,
  candidateReferenceOf,
  evaluateInCandidateReadWorld,
  fakeCandidateReference,
  isRealPage,
  readsFromEvaluateMocks,
} from '../helpers/interaction-candidate-reads.js';
import { createTestConfig, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';
import { roundsOf } from '../helpers/test-rounds.js';

/**
 * DEF-313（DEF-310 と同じ形）: 読み込みの前の Guard への知らせ（`announceOwnMainFrameNavigation`）は、FRET fix round 1 から page の Context の Guard の状態も
 * 読む。本物の page はいつも Context を持つので、読み込みを差し替えた偽の page にも Context（Guard のない空の物）を持たせる。
 */
const FAKE_GUARD_CONTEXT = Object.freeze({});
const fakeGuardContext = (): object => FAKE_GUARD_CONTEXT;

type ExpectedStructuredInteractionResult = Awaited<ReturnType<typeof auditInteraction>> & {
  readonly work: {
    readonly status: InteractionStatus;
    readonly reason: InteractionReasonCode;
    readonly reasonDetail: string | null;
    readonly evidence: InteractionChangeEvidence;
  };
  readonly lifecycle:
    | {
        readonly status: 'CLOSED';
        readonly reason: InteractionLifecycleReasonCode | null;
        readonly reasonDetail: string | null;
      }
    | { readonly status: 'NON_TERMINAL'; readonly reason: InteractionLifecycleReasonCode; readonly reasonDetail: string | null };
};

/**
 * C18n（Task 19 の前の整理の設計書 5.1）: 技術的な詳細（`reasonDetail`）を持つ理由のコード。ほかのコードの詳細は、いつも null。
 * - 整えたエラーの文言（残らなければ null）: 下準備の失敗、click の失敗と期限切れ、作業の失敗、owner の close の失敗
 * - 切断の後の identityStatus の値: `RETAINED_IDENTITY_LOST`
 */
const ERROR_DETAIL_REASON_CODES: ReadonlySet<string> = new Set([
  'SCROLL_PREPARATION_FAILED',
  'CLICK_TIMED_OUT',
  'CLICK_FAILED',
  'EXECUTION_FAILED',
  'OWNER_CLOSE_FAILED',
]);
/** 理由のコードの形（英数字と `_`）。英文の理由は、この形にならない。 */
const REASON_CODE_PATTERN = /^[A-Z][A-Z_]*$/u;

/** 理由の詳細が、コードに合う形か（詳細を持たないコードでは null、エラーの文言は空でない文字列。LZ-2: 長さの上限（前は 512）はない）。 */
function expectReasonDetailFits(code: string, detail: string | null): void {
  if (code === 'RETAINED_IDENTITY_LOST') {
    expect(INTERACTION_IDENTITY_STATUSES, code).toContain(detail);
  } else if (ERROR_DETAIL_REASON_CODES.has(code)) {
    if (detail !== null) {
      expect(typeof detail, code).toBe('string');
      expect(detail.length, code).toBeGreaterThan(0);
    }
  } else {
    expect(detail, code).toBeNull();
  }
}

/** 作業の結果の理由が、status に合うコードで、詳細がコードに合う形であることを確かめる。 */
function expectCodedWorkReason(work: Pick<InteractionWorkOutcome, 'status' | 'reason' | 'reasonDetail'>): void {
  expect(work.reason, work.reason).toMatch(REASON_CODE_PATTERN);
  expect(INTERACTION_REASON_CODES).toContain(work.reason);
  expect(INTERACTION_REASON_CODES_BY_STATUS[work.status] as readonly string[], `${work.status} ${work.reason}`)
    .toContain(work.reason);
  expectReasonDetailFits(work.reason, work.reasonDetail);
}

/** lifecycle の理由が、null か lifecycle のコードで、詳細がコードに合う形であることを確かめる。 */
function expectCodedLifecycleReason(lifecycle: InteractionClosedLifecycle | InteractionNonTerminalLifecycle): void {
  if (lifecycle.status === 'CLOSED' && lifecycle.reason === null) {
    expect(lifecycle.reasonDetail).toBeNull();
    return;
  }
  expect(INTERACTION_LIFECYCLE_REASON_CODES).toContain(lifecycle.reason);
  expectReasonDetailFits(lifecycle.reason as string, lifecycle.reasonDetail);
}

/**
 * C18n: `auditInteraction` のすべての経路（結果と `InteractionOwnerCleanupError`）で、理由がコードの閉じた一覧の値であり、
 * 英文を含まないことを確かめる。このファイルのテストは、すべてこの関数を通して監査する。
 * 最終の status が作業の status と同じ場合は、最終の理由と詳細が作業のものと同じ。BLOCKED_BY_SAFETY に変えた場合は、詳細は null。
 */
async function auditInteraction(input: InteractionAuditInput): ReturnType<typeof auditInteractionUnderTest> {
  let result: Awaited<ReturnType<typeof auditInteractionUnderTest>>;
  try {
    // T32j-4 fix round 1: 偽の session の page（`evaluate`・`evaluateHandle` に結果を差し込む形）は、製品の候補の読み取りの口に写す。
    const sessionFactory = input.sessionFactory;
    result = await auditInteractionUnderTest(typeof sessionFactory !== 'function' ? input : {
      ...input,
      sessionFactory: async (viewport) => {
        const session = await sessionFactory(viewport);
        adaptFakePage(session.page);
        withoutFakeSettling(session.page);
        return session;
      },
    });
  } catch (error) {
    if (error instanceof InteractionOwnerCleanupError) {
      expectCodedWorkReason(error.work);
      expectCodedLifecycleReason(error.lifecycle);
      expect(error.lifecycle.status).toBe('NON_TERMINAL');
    }
    throw error;
  }
  expectCodedWorkReason(result);
  expectCodedWorkReason(result.work);
  expectCodedLifecycleReason(result.lifecycle);
  if (result.status === result.work.status) {
    expect(result.reason).toBe(result.work.reason);
    expect(result.reasonDetail).toBe(result.work.reasonDetail);
  } else {
    expect(result.status).toBe('BLOCKED_BY_SAFETY');
    expect(result.reasonDetail).toBeNull();
  }
  return result;
}

/**
 * SPEC-5: 押した後は、ページの落ち着き（`waitForPageSettled`）を待ってから 1 回だけ観測する。偽の page は読み込みの段も通信の事象も持たないので、
 * 落ち着きの待ちがすぐ終わる口（事象の登録は何もせず、DOM の準備の待ちは失敗する）を、足りない分だけ足す。本物の page は、そのまま。
 */
function withoutFakeSettling(page: object): void {
  if (isRealPage(page)) return;
  const fake = page as Record<string, unknown>;
  fake['on'] ??= () => page;
  fake['off'] ??= () => page;
  fake['isClosed'] ??= () => false;
  fake['waitForLoadState'] ??= async () => { throw new Error('The fake page has no load state'); };
}

/** 理由のコードと詳細を、まとめて確かめる。 */
function expectReason(
  target: { readonly reason: string | null; readonly reasonDetail: string | null },
  reason: string,
  reasonDetail: string | null = null,
): void {
  expect({ reason: target.reason, reasonDetail: target.reasonDetail }).toEqual({ reason, reasonDetail });
}

function expectedStructuredResult(
  result: Awaited<ReturnType<typeof auditInteraction>>,
): ExpectedStructuredInteractionResult {
  return result as ExpectedStructuredInteractionResult;
}

async function expectOwnerCleanupError(
  completion: Promise<Awaited<ReturnType<typeof auditInteraction>>>,
): Promise<InteractionOwnerCleanupError> {
  const rejection = await completion.catch((error: unknown) => error);
  expect(rejection).toBeInstanceOf(InteractionOwnerCleanupError);
  return rejection as InteractionOwnerCleanupError;
}

function fakeCloseLifecycle(
  closeBehavior: () => Promise<void> = async () => undefined,
): Pick<InteractionGuardedSession, 'close' | 'isClosed'> {
  let closed = false;
  return Object.freeze({
    isClosed: (): boolean => closed,
    close: async (): Promise<void> => {
      await closeBehavior();
      closed = true;
    },
  });
}

const viewport: Viewport = Object.freeze({ width: 900, height: 700 });
let browser: Browser;
let server: FixtureServer;
let factory: BrowserContextFactory;

function boundedResolutionEnvelope(handle: {
  readonly evaluate: (...args: never[]) => Promise<unknown>;
  readonly dispose: () => Promise<unknown>;
}) {
  const property = (value: unknown) => ({
    jsonValue: async () => value,
    dispose: async () => undefined,
    asElement: () => value === handle ? handle : null,
  });
  return {
    getProperties: async () => new Map([
      ['status', property('FOUND')],
      ['domWorkUsed', property(0)],
      ['element', property(handle)],
    ]),
    dispose: async () => undefined,
  };
}

/**
 * F06b: 凍結の前の下準備（探索・handle の解決・観測・スクロール・hover・観測・破棄。SPEC-5）だけを、DOM の作業量0の別の偽の handle で
 * 受け持つ。凍結の後の経路を確かめる既存のテストで、偽のページの呼び出しの順序・handle を、これまでどおり凍結の後の経路に
 * 届けるために使う。最初の探索（引数付きの `evaluate`）と、最初の handle の解決（`evaluateHandle`）だけを受け持ち、
 * ほかの呼び出しは元の偽のページに渡す。下準備の handle の観測は、変わらない候補の記録（属性のない記録）を返す。
 */
function withScrollPreparation(page: Page, candidate: InteractionCandidate): Page {
  // T32j-4 fix round 1: 最初の発見と最初の解決を、製品の候補の読み取りの口で受け持つ。ほかの読み取りは、元の page の読み取り（偽の page なら
  // `evaluate`・`evaluateHandle` の差し込みの写し、本物の page なら isolated world の読み取り）に渡す。
  const base: InteractionCandidateReads = isRealPage(page)
    ? interactionCandidateReadsOf(page)
    : readsFromEvaluateMocks(page as never, interactionCandidateReadsOf(page));
  let discoveryServed = false;
  let resolutionServed = false;
  const preparationId = -1;
  const preparationHandle = {
    evaluate: async () => ({
      status: 'CONNECTED',
      domWorkUsed: 0,
      raw: rawCandidateFor(candidate),
      attributes: { complete: true, entries: [] },
    }),
    scrollIntoViewIfNeeded: async () => undefined,
    hover: async () => undefined,
    dispose: async () => undefined,
  };
  const reads: InteractionCandidateReads = {
    discover: async (target, input, deadlineAtMs) => {
      if (!discoveryServed) {
        discoveryServed = true;
        return { status: 'READ', value: { candidates: [rawCandidateFor(candidate)], completeness: 'COMPLETE', domWorkUsed: 0 } };
      }
      return base.discover(target, input, deadlineAtMs);
    },
    resolve: async (target, input, deadlineAtMs) => {
      if (!resolutionServed) {
        resolutionServed = true;
        return { status: 'READ', value: { status: 'FOUND', domWorkUsed: 0 }, elements: [{ backendNodeId: preparationId, path: [] }] };
      }
      return base.resolve(target, input, deadlineAtMs);
    },
    handleOf: async (target, reference, deadlineAtMs) => (reference.backendNodeId === preparationId
      ? preparationHandle as never
      : base.handleOf(target, reference, deadlineAtMs)),
    inspect: async (target, backendNodeId, input, deadlineAtMs) => (backendNodeId === preparationId
      ? { status: 'READ', value: await preparationHandle.evaluate() }
      : base.inspect(target, backendNodeId, input, deadlineAtMs)),
  };
  return withInteractionCandidateReads(new Proxy(page, {}), reads);
}

function injectedResolutionEnvelope(
  properties: ReadonlyMap<string, unknown>,
  dispose: () => Promise<unknown> = async () => undefined,
) {
  return {
    getProperties: async () => properties,
    dispose,
  };
}

function injectedResolutionPage(envelope: unknown): Page {
  return adaptFakePage({ evaluateHandle: async () => envelope }) as unknown as Page;
}

function rawCandidateFor(candidate: InteractionCandidate) {
  return {
    ordinal: candidate.ordinal,
    tagName: candidate.tagName,
    role: candidate.role,
    accessibleName: candidate.accessibleName,
    normalizedText: candidate.accessibleName,
    ariaExpanded: candidate.ariaExpanded,
    ariaControls: candidate.ariaControls,
    ariaSelected: candidate.ariaSelected,
    controlledVisible: candidate.controlledVisible,
    controlledHidden: candidate.controlledHidden,
    formAssociated: candidate.formAssociated,
    formMethod: candidate.formMethod,
    formAction: candidate.formAction,
    rawHref: candidate.href,
    documentUrl: `${server.origin}/accordion.html`,
    documentOrigin: server.origin,
    download: candidate.download,
    type: candidate.type,
    disabled: candidate.disabled,
    visible: candidate.visible,
    destructiveFacts: destructiveActionFactsOfNames([candidate.accessibleName]),
    boundingBox: candidate.boundingBox,
  };
}

function configFor(origin: string): AuditConfig {
  return createTestConfig(origin, '/index.html', {
    crawl: {
      maxPages: 10,
      maxDepth: 2,
      maxRuntimeMs: 30_000,
      navigationTimeoutMs: 5_000,
      overallPageTimeoutMs: 5_000,
      resourceSettlingTimeoutMs: 500,
      interactionTimeoutMs: 500,
    },
    viewports: { primaryDesktop: viewport, stressWidths: [] },
    output: { directory: './tmp' },
  });
}

// afterAll は登録の逆順に実行されるので、ブラウザを閉じてからサーバを閉じる。
/** F18（R6 の I-2）: 読み込みの遅いページ（`/slow-load-class-toggle.html`）の画像（`/__slow`）の応答を遅らせる時間。 */
const SLOW_IMAGE_DELAY_MS = 1_800;

beforeAll(async () => {
  server = await startFixtureServer({ slowResponseDelayMs: SLOW_IMAGE_DELAY_MS });
});

afterAll(async () => {
  await server?.close();
});

useHeadlessChromium((launched) => {
  browser = launched;
});

beforeAll(() => {
  factory = new BrowserContextFactory(browser, configFor(server.origin), () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
});

/**
 * 候補の探索のテストで、探索の途中や後の Guard の違反を見逃さないための指定（RC18 の M4）。閉じる処理の失敗は捨てるので、
 * page と Context を閉じる前に、Safety Ledger の違反が0件であることを確かめる。
 */
const EXPECT_NO_GUARD_VIOLATIONS = Object.freeze({ expectNoViolations: true });

/**
 * L10（INV-LIMITS の N3・N4）: 本番は DOM の作業量の上限を渡さない（数えるだけで止めない）。上限に達する場面は、テストが上限を注入して確かめる。
 * `INJECTED_MAX_DOM_WORK` は、`total-dom-budget.html`（祖先 20,000 など）と、前の要素の数を差し込む補助の数え方に合わせた注入の値。
 * `INJECTED_TEXT_WALK_DOM_WORK` は、子孫の走査（100,000 個・300 個の子孫の fixture）の途中で止める、小さな注入の値。
 */
const INJECTED_MAX_DOM_WORK = 16_384;
const INJECTED_TEXT_WALK_DOM_WORK = 1_000;

// DEF-036 の凍結中のポップアップの要求のくり返しの確かめ（回数 `frozenPopupAudit`）は、TS-f で `safety-gates.test.ts` の GATE-S04 にまとめた。
// DEF-039 のページ自身が開いて閉じるポップアップの fixture の名前は、`gate-harness.ts` の `POPUP_SELF_CLOSE_BEACON_PAGE`（TS-f。GATE-S04 と、
// その対照と共有）。
/**
 * DEF-039: 凍結中にページ自身が開いて閉じるポップアップの送信を確かめるテストで、同じ場面をくり返す回数。修正の前の調査では、
 * 同じ処理の中で閉じて 5 回中 5 回、300 ms 後に閉じて 8 回中 8 回届いたので、この回数なら修正の前にはほぼ確実に失敗する。値は `test-rounds.ts`
 * （TS-b。ふだんの組と全部の組）。
 */
const FROZEN_POPUP_SELF_CLOSE_ROUNDS = roundsOf('frozenPopupSelfClose');
/** DEF-039: fixture の「後で閉じる」場面が、ポップアップを閉じるまでの時間（ms。fixture の `DELAYED_CLOSE_MS` と同じ値）。 */
const FROZEN_POPUP_SELF_CLOSE_DELAY_MS = 300;
/**
 * DEF-039: 1 回の場面（Interaction の session を開き、fixture を読み込み、凍結し、click し、ポップアップが閉じるのを待ち、閉じる）の
 * 上限の見積もり（ms）。期限の値ではない。
 */
const FROZEN_POPUP_SELF_CLOSE_ROUND_BUDGET_MS = GATE_INTERACTION_TIMING.navigationTimeoutMs
  + FROZEN_POPUP_SELF_CLOSE_DELAY_MS + QUIET_PERIOD_MS + GATE_INTERACTION_TIMING.overallMs;
/** DEF-039 のくり返しのテストの期限（ms）。回ごとの上限の見積もりと、最後の待ち時間。 */
const FROZEN_POPUP_SELF_CLOSE_TEST_TIMEOUT_MS = FROZEN_POPUP_SELF_CLOSE_ROUNDS * FROZEN_POPUP_SELF_CLOSE_ROUND_BUDGET_MS
  + FROZEN_POPUP_LATE_DELIVERY_SETTLE_MS;

async function discover(
  path: string,
  expectedCompleteness: 'COMPLETE' | 'CANDIDATE_LIMIT_REACHED' = 'COMPLETE',
): Promise<readonly InteractionCandidate[]> {
  return withGuardedPassivePage(factory, viewport, async (page) => {
    await page.goto(`${server.origin}${path}`, { waitUntil: 'load' });
    const result = await discoverInteractionCandidates(page);
    expect(result.completeness).toBe(expectedCompleteness);
    return result.candidates;
  }, EXPECT_NO_GUARD_VIOLATIONS);
}

async function totalBudgetPage(section?: string): Promise<Page> {
  const page = await browser.newPage();
  await page.goto(`${server.origin}/total-dom-budget.html`, { waitUntil: 'load' });
  const precondition = await page.evaluate(() => {
    const controlled = document.getElementById('deep-controlled');
    const scopedHost = document.getElementById('deep-chain-host');
    const early = document.getElementById('early');
    let scopedAncestors = 0;
    let parent = controlled?.parentElement ?? null;
    while (parent !== null && parent !== scopedHost) {
      scopedAncestors += 1;
      parent = parent.parentElement;
    }
    return {
      scopedAncestors,
      reachedScopedHost: parent === scopedHost,
      connected: early?.isConnected,
      width: early?.getBoundingClientRect().width ?? 0,
    };
  });
  expect(precondition.scopedAncestors).toBe(20_000);
  expect(precondition.reachedScopedHost).toBe(true);
  expect(precondition.connected).toBe(true);
  expect(precondition.width).toBeGreaterThan(0);
  if (section !== undefined) {
    await page.evaluate((id) => {
      const selected = document.getElementById(id);
      if (selected === null) throw new Error('Missing total budget section');
      document.body.replaceChildren(selected);
    }, section);
  }
  return page;
}

// DEF-073: Interaction の候補の処理は、`document` の名前つきの要素に隠されないように `Document.prototype.createTreeWalker` を呼ぶ。
// 走査を測る補助は、`document` のインスタンスではなく `Document.prototype` の `createTreeWalker` を差し替える（`querySelectorAll` の
// 差し替えと同じ形）。差し替えはそのページの中だけに効き、各テストが `finally` でページを閉じると、ページごと捨てられて元に戻る。
async function installTotalTraversalProbe(page: Page): Promise<() => Promise<number>> {
  await evaluateInCandidateReadWorld(page, (maxNodes) => {
    const original = document.createTreeWalker.bind(document);
    let count = 0;
    Object.defineProperty(Document.prototype, 'createTreeWalker', {
      configurable: true,
      value(root: Node, whatToShow: number, filter?: NodeFilter | null) {
        const walker = original(root, whatToShow, filter);
        return new Proxy(walker, {
          get(target, property) {
            if (property !== 'nextNode') return Reflect.get(target, property, target);
            return () => {
              const node = target.nextNode();
              if (node !== null && ++count > maxNodes) throw new Error('Total DOM traversal exceeded the injected DOM work limit');
              return node;
            };
          },
        });
      },
    });
    Object.defineProperty(globalThis, '__totalDomTraversalCount', { get: () => count });
  }, INJECTED_MAX_DOM_WORK);
  return () => evaluateInCandidateReadWorld(page, () => (
    globalThis as typeof globalThis & { readonly __totalDomTraversalCount: number }
  ).__totalDomTraversalCount);
}

/**
 * 文書の要素の走査（`document.documentElement` を根とする SHOW_ELEMENT の TreeWalker）で、対象の前に `preceding` 個の
 * 一致しない要素を返す偽の TreeWalker を入れる。DOM作業量の境界を、祖先の数によらず正確に作るために使う。
 * 文書の根は走査の最初に1回数えるので、対象に達するまでの消費は `1 + preceding` になる。
 */
async function installPrecedingWorkWalker(page: Page, targetSelector: string, preceding: number): Promise<void> {
  await evaluateInCandidateReadWorld(page, ({ selector, count }) => {
    const target = document.querySelector(selector);
    if (target === null) throw new Error('Missing preceding-work target');
    const dummy = document.createElement('div');
    const originalCreateTreeWalker = document.createTreeWalker.bind(document);
    Object.defineProperty(Document.prototype, 'createTreeWalker', {
      configurable: true,
      value(root: Node, whatToShow: number, filter?: NodeFilter | null) {
        if (root === document.documentElement && whatToShow === NodeFilter.SHOW_ELEMENT) {
          let index = 0;
          return {
            nextNode(): Node | null {
              index += 1;
              if (index <= count) return dummy;
              if (index === count + 1) return target;
              return null;
            },
          };
        }
        return originalCreateTreeWalker(root, whatToShow, filter);
      },
    });
  }, { selector: targetSelector, count: preceding });
}

/**
 * 要素の `getBoundingClientRect` を読んだ回数を数える。候補の処理は、要素の上書きを受けないように `Element.prototype` のメソッドを
 * 呼ぶので（DEF-069）、要素のインスタンスではなく `Element.prototype` を差し替え、対象の要素への呼び出しだけを数える（DEF-075）。
 * 差し替えはそのページの中だけに効き、テストがページを閉じると、ページごと捨てられて元に戻る。
 */
async function installGeometryReadCounter(page: Page, targetSelector: string): Promise<() => Promise<number>> {
  await evaluateInCandidateReadWorld(page, (selector) => {
    const target = document.querySelector(selector);
    if (target === null) throw new Error('Missing geometry target');
    const original = Element.prototype.getBoundingClientRect;
    let reads = 0;
    Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element): DOMRect {
      if (this === target) reads += 1;
      return original.call(this);
    };
    Object.defineProperty(globalThis, '__geometryReads', { configurable: true, get: () => reads });
  }, targetSelector);
  return () => evaluateInCandidateReadWorld(page, () => (
    globalThis as typeof globalThis & { readonly __geometryReads: number }
  ).__geometryReads);
}

/** `installIdentityFactCounters` が数えた値。 */
interface IdentityFactCounts {
  /** 文書の根（html）の `matches` が呼ばれたか。 */
  readonly rootInspected: boolean;
  /** 対象の要素の `getAttribute` が呼ばれた回数。 */
  readonly factReads: number;
}

/**
 * 文書の根の `matches` の呼び出しと、対象の要素の `getAttribute` の呼び出しを数える。数えた値は、ページの中では
 * `globalThis.__identityFactCounts` で読める（走査の差し替えが、根を調べたかで前の要素の数を変えるため）。
 * 候補の処理は `Element.prototype` のメソッドを呼ぶので（DEF-069）、`Element.prototype` を差し替え、根と対象への呼び出しだけを数える
 * （DEF-075）。差し替えはそのページの中だけに効き、テストがページを閉じると、ページごと捨てられて元に戻る。
 */
async function installIdentityFactCounters(page: Page, targetSelector: string): Promise<() => Promise<IdentityFactCounts>> {
  await evaluateInCandidateReadWorld(page, (selector) => {
    const target = document.querySelector(selector);
    if (target === null) throw new Error('Missing identity fact target');
    const root = document.documentElement;
    const counts = { rootInspected: false, factReads: 0 };
    const originalMatches = Element.prototype.matches;
    Element.prototype.matches = function matches(this: Element, selectors: string): boolean {
      if (this === root) counts.rootInspected = true;
      return originalMatches.call(this, selectors);
    } as typeof Element.prototype.matches;
    const originalGetAttribute = Element.prototype.getAttribute;
    Element.prototype.getAttribute = function getAttribute(this: Element, name: string): string | null {
      if (this === target) counts.factReads += 1;
      return originalGetAttribute.call(this, name);
    };
    Object.defineProperty(globalThis, '__identityFactCounts', { configurable: true, get: () => ({ ...counts }) });
  }, targetSelector);
  return () => evaluateInCandidateReadWorld(page, () => (
    globalThis as typeof globalThis & { readonly __identityFactCounts: IdentityFactCounts }
  ).__identityFactCounts);
}

/**
 * TS-c: 候補の探り（DOM の作業量、計測の対照、Task 2 の境界と解決の持ち主）のテストを登録する（`isolated-interaction-discovery.test.ts` が呼ぶ）。
 * 本文は、分ける前の位置と字下げのまま（差分を小さくするため）。
 */
export function registerInteractionProbeCases(): void {
it('exports bounded exact-handle resolution API', async () => {
  const discoveryModule = await import('../../src/interaction/discover-candidates.js');
  expect(discoveryModule).toHaveProperty('resolveInteractionCandidateHandle');
});

// DEF-075: 計測の補助が、候補の処理の読み取りを実際に数えることの対照。作業量の上限に達しない場面では、対象の幾何の読み取り、
// 文書の根の一致判定、対象の属性の読み取りが起きるので、数えた値は 0 にならない（上限に達する場面の「0 回」の確かめが、空振りでないことを示す）。
describe('DEF-075: the instrumentation counts the reads of the interaction probe', () => {
  // T32j-4 fix round 1（対照）: 候補の処理は isolated world で読むので、main world の仕掛けには何も数えられず、製品が読む world の仕掛け
  // （`evaluateInCandidateReadWorld`）には数えられる。このファイルの計測の仕掛けを、製品が読む world に入れる理由。
  it('counts the reads only in the world where the probe reads, not in the main world (the control of the instrumentation)', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<button id="early" type="button" aria-controls="panel" aria-label="Early candidate">x</button><div id="panel">Panel</div>');
      await page.evaluate(() => {
        const target = document.querySelector('#early');
        const original = Element.prototype.getBoundingClientRect;
        let reads = 0;
        Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element): DOMRect {
          if (this === target) reads += 1;
          return original.call(this);
        };
        Object.defineProperty(globalThis, '__mainWorldGeometryReads', { configurable: true, get: () => reads });
      });
      const readTargetGeometry = await installGeometryReadCounter(page, '#early');
      const result = await discoverInteractionCandidates(page);
      expect(result.completeness).toBe('COMPLETE');
      expect(await readTargetGeometry()).toBeGreaterThan(0);
      expect(await page.evaluate(() => (globalThis as typeof globalThis & { readonly __mainWorldGeometryReads: number }).__mainWorldGeometryReads)).toBe(0);
    } finally { await page.close(); }
  });

  it('counts geometry reads of the candidate during discovery without budget pressure', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<button id="early" type="button" aria-controls="panel" aria-label="Early candidate">x</button><div id="panel">Panel</div>');
      const readTargetGeometry = await installGeometryReadCounter(page, '#early');
      const result = await discoverInteractionCandidates(page);
      expect(result.completeness).toBe('COMPLETE');
      expect(await readTargetGeometry()).toBeGreaterThan(0);
    } finally { await page.close(); }
  });

  it('counts geometry reads of the controlled element during retained inspection without budget pressure', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<button type="button" aria-controls="controlled" aria-label="Boundary">Boundary</button><div id="controlled" style="width:1px;height:1px"></div>');
      const handle = await page.locator('button').elementHandle();
      const handleReference = await candidateReferenceOf(page, 'button');
      if (handle === null) throw new Error('Missing control candidate');
      try {
        const readControlledGeometry = await installGeometryReadCounter(page, '#controlled');
        expect(await inspectInteractionCandidateHandle(handleReference, 0)).toMatchObject({ status: 'CONNECTED' });
        expect(await readControlledGeometry()).toBeGreaterThan(0);
      } finally { await handle.dispose(); }
    } finally { await page.close(); }
  });

  it('counts the root match and the attribute reads of the retained candidate without budget pressure', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<button type="button" aria-controls="controlled">Boundary</button><div id="controlled"></div>');
      const handle = await page.locator('button').elementHandle();
      const handleReference = await candidateReferenceOf(page, 'button');
      if (handle === null) throw new Error('Missing control candidate');
      try {
        const readCounts = await installIdentityFactCounters(page, 'button');
        expect(await inspectInteractionCandidateHandle(handleReference, 0)).toMatchObject({ status: 'CONNECTED' });
        const counts = await readCounts();
        expect(counts.rootInspected).toBe(true);
        expect(counts.factReads).toBeGreaterThan(0);
      } finally { await handle.dispose(); }
    } finally { await page.close(); }
  });
});

it('avoids whole-DOM selector enumeration during discovery', async () => {
  const page = await totalBudgetPage();
  try {
    await evaluateInCandidateReadWorld(page, () => {
      Document.prototype.querySelectorAll = () => { throw new Error('Forbidden whole-DOM query'); };
    });
    await expect(discoverInteractionCandidates(page)).resolves.toBeDefined();
  } finally { await page.close(); }
});

it('reports total DOM work exhaustion before a late candidate with immutable completeness (injected limit)', async () => {
  const page = await totalBudgetPage('no-early-candidate');
  try {
    const count = await installTotalTraversalProbe(page);
    const result = await discoverInteractionCandidates(page, INJECTED_MAX_DOM_WORK);
    expect(result.completeness).toBe('DOM_WORK_BUDGET_REACHED');
    expect(result.domWorkUsed).toBe(INJECTED_MAX_DOM_WORK);
    expect(result.candidates).toEqual([]);
    expect(await count()).toBeLessThanOrEqual(result.domWorkUsed);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.candidates)).toBe(true);
  } finally { await page.close(); }
});

// L10（N3・N4）: 上限を渡さない（本番の形）と、前の上限（16,384）を超えても文書の終わりまで探し、後ろの候補を見つける。
it('continues past the former DOM work limit to a late candidate when no limit is given', async () => {
  const page = await totalBudgetPage('no-early-candidate');
  try {
    const result = await discoverInteractionCandidates(page);
    expect(result.completeness).toBe('COMPLETE');
    expect(result.domWorkUsed).toBeGreaterThan(INJECTED_MAX_DOM_WORK);
    expect(result.candidates.map(({ accessibleName }) => accessibleName)).toEqual(['Candidate beyond budget']);
    const resolution = await resolveInteractionCandidateHandle(page, 0);
    expect(resolution.status).toBe('FOUND');
    if (resolution.status !== 'FOUND') throw new Error('Expected the late candidate');
    try {
      expect(resolution.domWorkUsed).toBeGreaterThan(INJECTED_MAX_DOM_WORK);
      await expect(inspectInteractionCandidateHandle(resolution.reference, 0)).resolves.toMatchObject({
        status: 'CONNECTED',
        candidate: { ordinal: 0, accessibleName: 'Candidate beyond budget' },
      });
    } finally { await resolution.reference.handle.dispose(); }
  } finally { await page.close(); }
});

// C3（設計書 2026-09-23 5.5）: 可視判定は祖先をたどらず checkVisibility を1回呼ぶごとに作業量1を消費する。
// 祖先の走査の消費を前提にしていた旧テストを、可視判定の消費が走査と同じ上限を共有することの検証に置き換えた。
it('shares visibility-check work and discards a partial early candidate on budget exhaustion (injected limit)', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<button id="early" type="button" aria-controls="panel" aria-label="Early candidate">x</button><div id="panel">Panel</div>');
    // 根1 + 前の要素 + 候補の走査と一致判定2 + aria-controls の解決1 + 制御対象の可視判定1 + テキスト1 + 候補の可視判定1 = 注入の上限
    await installPrecedingWorkWalker(page, '#early', INJECTED_MAX_DOM_WORK - 7);
    const readTargetGeometry = await installGeometryReadCounter(page, '#early');

    const result = await discoverInteractionCandidates(page, INJECTED_MAX_DOM_WORK);

    expect(result.completeness).toBe('DOM_WORK_BUDGET_REACHED');
    expect(result.domWorkUsed).toBe(INJECTED_MAX_DOM_WORK);
    expect(result.candidates).toEqual([]);
    expect(await readTargetGeometry()).toBe(0);
  } finally { await page.close(); }
});

// L10（N3・N4）: テキストのノードの上限（前は 512。TEXT_NODE_LIMIT_REACHED）は撤廃した。子孫の走査と要素の走査は、注入した DOM の作業量の
// 上限だけを共有する（100 個の候補の子孫 512 個ずつは、注入の上限の途中で尽きる）。
it('uses shared text and enumeration work across candidate subtrees (injected limit)', async () => {
  const page = await totalBudgetPage('many-candidate-subtrees');
  try {
    const count = await installTotalTraversalProbe(page);
    const result = await discoverInteractionCandidates(page, INJECTED_MAX_DOM_WORK);
    expect(result.completeness).toBe('DOM_WORK_BUDGET_REACHED');
    expect(result.domWorkUsed).toBe(INJECTED_MAX_DOM_WORK);
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates.length).toBeLessThan(100);
    expect(result.candidates.some(({ accessibleName }) => accessibleName === 'Repeated candidate 99')).toBe(false);
    expect(await count()).toBeLessThanOrEqual(result.domWorkUsed);
  } finally { await page.close(); }
});

it('walks every candidate subtree to the end when no limit is given', async () => {
  const page = await totalBudgetPage('many-candidate-subtrees');
  try {
    const result = await discoverInteractionCandidates(page);
    expect(result.completeness).toBe('COMPLETE');
    expect(result.domWorkUsed).toBeGreaterThan(INJECTED_MAX_DOM_WORK);
    expect(result.candidates).toHaveLength(100);
    expect(result.candidates.at(-1)).toMatchObject({ ordinal: 99, accessibleName: 'Repeated candidate 99' });
  } finally { await page.close(); }
});

it('bounded exact-handle resolution preserves the child after envelope disposal without whole-DOM queries', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<button type="button">Retained child</button>');
    await evaluateInCandidateReadWorld(page, () => {
      Document.prototype.querySelectorAll = () => { throw new Error('Forbidden whole-DOM query'); };
    });
    const resolution = await resolveInteractionCandidateHandle(page, 0);
    expect(resolution.status).toBe('FOUND');
    if (resolution.status !== 'FOUND') throw new Error('Expected retained child');
    try {
      expect(await resolution.reference.handle.evaluate((element) => element.isConnected)).toBe(true);
      expect(Object.isFrozen(resolution)).toBe(true);
      const snapshot = await inspectInteractionCandidateHandle(resolution.reference, 0);
      expect(snapshot).toMatchObject({ status: 'CONNECTED', candidate: { accessibleName: 'Retained child' } });
    } finally { await resolution.reference.handle.dispose(); }
  } finally { await page.close(); }
});

it('bounded exact-handle resolution distinguishes late-target budget exhaustion from missing (injected limit)', async () => {
  const page = await totalBudgetPage('no-early-candidate');
  try {
    const count = await installTotalTraversalProbe(page);
    expect(await resolveInteractionCandidateHandle(page, 0, INJECTED_MAX_DOM_WORK)).toEqual({
      status: 'DOM_WORK_BUDGET_REACHED',
      domWorkUsed: INJECTED_MAX_DOM_WORK,
    });
    expect(await count()).toBeLessThanOrEqual(INJECTED_MAX_DOM_WORK);
  } finally { await page.close(); }
});

// C3（設計書 2026-09-23 5.5）: 祖先の走査ではなく、候補自身の可視判定が最後の作業量を消費する形に置き換えた。
it('retained inspection reports shared visibility-check budget exhaustion distinctly from disconnected (injected limit)', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<button id="early" type="button" aria-controls="panel" aria-label="Early candidate">x</button><div id="panel">Panel</div>');
    const handle = await page.locator('#early').elementHandle();
    const handleReference = await candidateReferenceOf(page, '#early');
    if (handle === null) throw new Error('Missing early fixture node');
    try {
      // 根1 + 前の要素 + 対象の走査と一致判定2 + 事実の収集の開始1 + aria-controls の解決1 + 制御対象の可視判定1
      // + テキスト1 + 候補の可視判定1 = 注入の上限
      await installPrecedingWorkWalker(page, '#early', INJECTED_MAX_DOM_WORK - 8);
      const readTargetGeometry = await installGeometryReadCounter(page, '#early');

      expect(await inspectInteractionCandidateHandle(handleReference, 0, INJECTED_MAX_DOM_WORK)).toEqual({
        status: 'DOM_WORK_BUDGET_REACHED',
        domWorkUsed: INJECTED_MAX_DOM_WORK,
      });
      expect(await readTargetGeometry()).toBe(0);
    } finally { await handle.dispose(); }
  } finally { await page.close(); }
});

it('retained inspection reports late live-ordinal budget exhaustion distinctly from disconnected (injected limit)', async () => {
  const page = await totalBudgetPage('no-early-candidate');
  const handle = await page.locator('button').elementHandle();
  const handleReference = await candidateReferenceOf(page, 'button');
  if (handle === null) throw new Error('Missing late fixture node');
  try {
    const count = await installTotalTraversalProbe(page);
    expect(await inspectInteractionCandidateHandle(handleReference, 0, INJECTED_MAX_DOM_WORK)).toEqual({
      status: 'DOM_WORK_BUDGET_REACHED',
      domWorkUsed: INJECTED_MAX_DOM_WORK,
    });
    expect(await count()).toBeLessThanOrEqual(INJECTED_MAX_DOM_WORK);
  } finally { await handle.dispose(); await page.close(); }
});

// C3（設計書 2026-09-23 5.5）: 可視判定が祖先をたどらなくなったため、候補の事実の側の消費を、制御対象の祖先の鎖から
// 候補の子孫のテキスト走査に置き換えた。前の要素の走査と事実の収集が、1つの上限を共有することを検証する。
it('retained inspection shares total DOM work between live ordinal and candidate facts (injected limit)', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<button type="button" aria-label="Combined">Combined</button>');
    await page.evaluate(() => {
      const button = document.querySelector('button')!;
      for (let index = 0; index < 16_000; index += 1) button.before(document.createElement('div'));
      // 前の要素の走査の後、子孫のテキストの走査の途中で、注入した DOM の作業量の上限に達する数の子孫。
      for (let index = 0; index < 500; index += 1) button.append(document.createElement('span'));
      let precedingNodes = 0;
      for (let preceding = button.previousElementSibling; preceding !== null; preceding = preceding.previousElementSibling) {
        if (preceding.tagName !== 'DIV') throw new Error('Combined preceding-node scope was contaminated');
        precedingNodes += 1;
      }
      if (precedingNodes !== 16_000) {
        throw new Error(`Combined preceding-node precondition failed: ${precedingNodes}`);
      }
    });
    const handle = await page.locator('button').elementHandle();
    const handleReference = await candidateReferenceOf(page, 'button');
    if (handle === null) throw new Error('Missing combined fixture node');
    try {
      expect(await inspectInteractionCandidateHandle(handleReference, 0, INJECTED_MAX_DOM_WORK)).toEqual({
        status: 'DOM_WORK_BUDGET_REACHED',
        domWorkUsed: INJECTED_MAX_DOM_WORK,
      });
      // L10（N3・N4）: 上限を渡さない（本番の形）と、同じ要素の値を最後まで読む。
      expect(await inspectInteractionCandidateHandle(handleReference, 0)).toMatchObject({
        status: 'CONNECTED',
        candidate: { ordinal: 0, accessibleName: 'Combined', textFingerprint: createSha256Fingerprint('Combined') },
      });
    } finally { await handle.dispose(); }
  } finally { await page.close(); }
});

it('bounded exact-handle resolution and retained inspection distinguish true absence', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<button type="button">Detach</button>');
    expect(await resolveInteractionCandidateHandle(page, 1)).toMatchObject({ status: 'MISSING' });
    const resolution = await resolveInteractionCandidateHandle(page, 0);
    if (resolution.status !== 'FOUND') throw new Error('Expected retained node');
    try {
      await resolution.reference.handle.evaluate((element) => element.remove());
      expect(await inspectInteractionCandidateHandle(resolution.reference, 0)).toMatchObject({ status: 'DISCONNECTED' });
    } finally { await resolution.reference.handle.dispose(); }
  } finally { await page.close(); }
});

describe('Task 2 correction boundaries', () => {
  it('stops before retained candidate facts when exact identity consumes the final work unit (injected limit)', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<button type="button" aria-controls="controlled">Boundary</button><div id="controlled"></div>');
      const handle = await page.locator('button').elementHandle();
      const handleReference = await candidateReferenceOf(page, 'button');
      if (handle === null) throw new Error('Missing boundary candidate');
      try {
        const readCounts = await installIdentityFactCounters(page, 'button');
        await evaluateInCandidateReadWorld(page, (maxDomWork) => {
          const target = document.querySelector('button')!;
          const dummy = document.createElement('div');
          const originalCreateTreeWalker = document.createTreeWalker.bind(document);
          const counts = (): IdentityFactCounts => (
            globalThis as typeof globalThis & { readonly __identityFactCounts: IdentityFactCounts }
          ).__identityFactCounts;
          let descendantWalkers = 0;
          Object.defineProperty(Document.prototype, 'createTreeWalker', {
            configurable: true,
            value(root: Node, whatToShow: number, filter?: NodeFilter | null) {
              if (root === document.documentElement && whatToShow === NodeFilter.SHOW_ELEMENT) {
                let index = 0;
                return {
                  nextNode(): Node | null {
                    index += 1;
                    const preceding = counts().rootInspected ? maxDomWork - 3 : maxDomWork - 2;
                    if (index <= preceding) return dummy;
                    if (index === preceding + 1) return target;
                    return null;
                  },
                };
              }
              if (whatToShow === NodeFilter.SHOW_ALL) descendantWalkers += 1;
              return originalCreateTreeWalker(root, whatToShow, filter);
            },
          });
          Object.defineProperty(globalThis, '__retainedIdentityBoundary', {
            configurable: true,
            get: () => ({ descendantWalkers }),
          });
        }, INJECTED_MAX_DOM_WORK);

        expect(await inspectInteractionCandidateHandle(handleReference, 0, INJECTED_MAX_DOM_WORK)).toEqual({
          status: 'DOM_WORK_BUDGET_REACHED',
          domWorkUsed: INJECTED_MAX_DOM_WORK,
        });
        const counts = await readCounts();
        expect({ rootInspected: counts.rootInspected, factReads: counts.factReads }).toEqual({ rootInspected: true, factReads: 0 });
        expect(await evaluateInCandidateReadWorld(page, () => (
          globalThis as typeof globalThis & {
            readonly __retainedIdentityBoundary: { readonly descendantWalkers: number };
          }
        ).__retainedIdentityBoundary)).toEqual({ descendantWalkers: 0 });
      } finally {
        await handle.dispose();
      }
    } finally {
      await page.close();
    }
  });

  // C3（設計書 2026-09-23 5.5）: 制御対象の祖先の鎖（Proxy）で作業量を消費させる形から、前の要素の走査で消費させ、
  // 制御対象の可視判定（checkVisibility の1回）が最後の作業量を消費する形に置き換えた。
  it('stops before geometry after the final retained visibility debit (injected limit)', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<button type="button" aria-controls="controlled" aria-label="Boundary">Boundary</button><div id="controlled" style="width:1px;height:1px"></div>');
      const handle = await page.locator('button').elementHandle();
      const handleReference = await candidateReferenceOf(page, 'button');
      if (handle === null) throw new Error('Missing visibility boundary candidate');
      try {
        // 根1 + 前の要素 + 対象の走査と一致判定2 + 事実の収集の開始1 + aria-controls の解決1 + 制御対象の可視判定1 = 注入の上限
        await installPrecedingWorkWalker(page, 'button', INJECTED_MAX_DOM_WORK - 6);
        const readControlledGeometry = await installGeometryReadCounter(page, '#controlled');

        expect(await inspectInteractionCandidateHandle(handleReference, 0, INJECTED_MAX_DOM_WORK)).toEqual({
          status: 'DOM_WORK_BUDGET_REACHED',
          domWorkUsed: INJECTED_MAX_DOM_WORK,
        });
        expect(await readControlledGeometry()).toBe(0);
      } finally {
        await handle.dispose();
      }
    } finally {
      await page.close();
    }
  });

  it('keeps the exact retained node connected and returns its new ordinal after insertion', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<button type="button">Target</button>');
      const resolution = await resolveInteractionCandidateHandle(page, 0);
      if (resolution.status !== 'FOUND') throw new Error('Expected retained target');
      try {
        await page.evaluate(() => {
          const unrelated = document.createElement('button');
          unrelated.type = 'button';
          unrelated.textContent = 'Unrelated';
          document.body.prepend(unrelated);
        });
        await expect(inspectInteractionCandidateHandle(resolution.reference, 0)).resolves.toMatchObject({
          status: 'CONNECTED',
          candidate: { ordinal: 1, accessibleName: 'Target' },
        });
      } finally {
        await resolution.reference.handle.dispose();
      }
    } finally {
      await page.close();
    }
  });

  it('keeps the exact retained node connected at the maximum live ordinal 99', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<button type="button">Target</button>');
      const resolution = await resolveInteractionCandidateHandle(page, 0);
      if (resolution.status !== 'FOUND') throw new Error('Expected retained target');
      try {
        await page.evaluate(() => {
          const target = document.querySelector('button');
          if (target === null) throw new Error('Missing retained target');
          const fragment = document.createDocumentFragment();
          for (let index = 0; index < 99; index += 1) {
            const preceding = document.createElement('button');
            preceding.type = 'button';
            preceding.textContent = `Preceding ${index}`;
            fragment.append(preceding);
          }
          target.before(fragment);
        });

        await expect(inspectInteractionCandidateHandle(resolution.reference, 0)).resolves.toMatchObject({
          status: 'CONNECTED',
          candidate: { ordinal: 99, accessibleName: 'Target' },
        });
      } finally {
        await resolution.reference.handle.dispose();
      }
    } finally {
      await page.close();
    }
  });

  // L10（N3・N4）: 順番の上限（前は 99。CANDIDATE_LIMIT_REACHED）は撤廃した。前の上限を超えた順番でも、つながった要素として読む。
  it('keeps the exact retained node connected when it moves to live ordinal 100 beyond the former cap', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<button type="button">Target</button>');
      const resolution = await resolveInteractionCandidateHandle(page, 0);
      if (resolution.status !== 'FOUND') throw new Error('Expected retained target');
      try {
        await page.evaluate(() => {
          const target = document.querySelector('button');
          if (target === null) throw new Error('Missing retained target');
          const fragment = document.createDocumentFragment();
          for (let index = 0; index < 100; index += 1) {
            const preceding = document.createElement('button');
            preceding.type = 'button';
            preceding.textContent = `Preceding ${index}`;
            fragment.append(preceding);
          }
          target.before(fragment);
        });

        const snapshot = await inspectInteractionCandidateHandle(resolution.reference, 0);
        expect(snapshot).toMatchObject({
          status: 'CONNECTED',
          candidate: { ordinal: 100, accessibleName: 'Target' },
        });
        expect(Object.isFrozen(snapshot)).toBe(true);
      } finally {
        await resolution.reference.handle.dispose();
      }
    } finally {
      await page.close();
    }
  });

  it('includes a matching document root in discovery, resolution, and retained inspection', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<button type="button">Child</button>');
      await page.evaluate(() => {
        document.documentElement.setAttribute('role', 'button');
        document.documentElement.setAttribute('aria-label', 'Root candidate');
      });
      const discovery = await discoverInteractionCandidates(page);
      expect(discovery.completeness).toBe('COMPLETE');
      expect(discovery.candidates.map(({ ordinal, tagName, accessibleName }) => [ordinal, tagName, accessibleName])).toEqual([
        [0, 'html', 'Root candidate'],
        [1, 'button', 'Child'],
      ]);
      const resolution = await resolveInteractionCandidateHandle(page, 0);
      if (resolution.status !== 'FOUND') throw new Error('Expected root candidate');
      try {
        expect(await resolution.reference.handle.evaluate((element) => element === document.documentElement)).toBe(true);
        await expect(inspectInteractionCandidateHandle(resolution.reference, 0)).resolves.toMatchObject({
          status: 'CONNECTED',
          candidate: { ordinal: 0, tagName: 'html', accessibleName: 'Root candidate' },
        });
      } finally {
        await resolution.reference.handle.dispose();
      }
    } finally {
      await page.close();
    }
  });

  // L10（N3・N4）: テキストのノードの上限（前は 512。TEXT_NODE_LIMIT_REACHED）は撤廃した。Task 2 fix round 2 の 3 つの場面は、上限なしで
  // 名前と本文の子孫を最後まで走査する形に書き直した（ラベル 300 個 + 文字 1 個、本文 300 個 + 文字 1 個 = 602 個）。
  it('walks the whole label and body text for accessible-name and normalized-text work without a text cap', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<div id="label">Label</div><button type="button" aria-labelledby="label">Body</button>');
      await page.evaluate(() => {
        const label = document.getElementById('label')!;
        const button = document.querySelector('button')!;
        label.prepend(...Array.from({ length: 300 }, () => document.createElement('span')));
        button.prepend(...Array.from({ length: 300 }, () => document.createElement('span')));
      });
      const readAcceptedTextNodes = await installTextTraversalCounter(page);

      const discovery = await discoverInteractionCandidates(page);

      expect(discovery.completeness).toBe('COMPLETE');
      expect(discovery.candidates.map(({ accessibleName, textFingerprint }) => [accessibleName, textFingerprint])).toEqual([
        ['Label', createSha256Fingerprint('Body')],
      ]);
      expect(await readAcceptedTextNodes()).toBe(602);
    } finally {
      await page.close();
    }
  });

  it('walks the whole body text of every candidate without a text cap shared across candidates', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<button type="button" aria-label="First">First body</button><button type="button" aria-label="Second">Second body</button>');
      await page.evaluate(() => {
        for (const button of document.querySelectorAll('button')) {
          button.prepend(...Array.from({ length: 300 }, () => document.createElement('span')));
        }
      });
      const readAcceptedTextNodes = await installTextTraversalCounter(page);

      const discovery = await discoverInteractionCandidates(page);

      expect(discovery.completeness).toBe('COMPLETE');
      expect(discovery.candidates.map(({ accessibleName, textFingerprint }) => [accessibleName, textFingerprint])).toEqual([
        ['First', createSha256Fingerprint('First body')],
        ['Second', createSha256Fingerprint('Second body')],
      ]);
      expect(await readAcceptedTextNodes()).toBe(602);
    } finally {
      await page.close();
    }
  });

  it('walks the whole retained label and body text without a text cap', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<div id="label">Label</div><button type="button" aria-labelledby="label">Body</button>');
      await page.evaluate(() => {
        const label = document.getElementById('label')!;
        const button = document.querySelector('button')!;
        label.prepend(...Array.from({ length: 300 }, () => document.createElement('span')));
        button.prepend(...Array.from({ length: 300 }, () => document.createElement('span')));
      });
      const resolution = await resolveInteractionCandidateHandle(page, 0);
      if (resolution.status !== 'FOUND') throw new Error('Expected retained secondary-cap candidate');
      try {
        const readAcceptedTextNodes = await installTextTraversalCounter(page);

        await expect(inspectInteractionCandidateHandle(resolution.reference, 0)).resolves.toMatchObject({
          status: 'CONNECTED',
          candidate: { accessibleName: 'Label', textFingerprint: createSha256Fingerprint('Body') },
        });
        expect(await readAcceptedTextNodes()).toBe(602);
      } finally {
        await resolution.reference.handle.dispose();
      }
    } finally {
      await page.close();
    }
  });
});

describe('Task 2 correction resolver ownership and envelope validation', () => {
  // T32j-4 fix round 1: 解決は isolated world の読み取り（CDP の session と、その session の中の remote object）で行う。今までの「封筒
  // （JSHandle）の項目を、成功・失敗のどれでも手放す」テストは、同じ性質（読み取りに使った資源を、成功・失敗・期限切れのどれでも残さない）を、
  // 新しい資源で確かめる形に置き換えた: 読み取りの session を必ず切る（session を切ると、その中の remote object も手放される）、操作のために
  // 得た handle のうち使わないものは手放す。偽の CDP の session と page で確かめる（命令の結果を差し込む）。
  interface FakeResolutionOptions {
    /** 解決の読み取りの値（`{ status, domWorkUsed }` の形。形の誤りも差し込む）。 */
    readonly value?: unknown;
    /** 解決の読み取りの要素の位置（要素の数だけ。null は shadow root の中）。 */
    readonly paths?: readonly (readonly number[] | null)[];
    /** 解決の読み取りの、ページの中の関数が例外を投げる。 */
    readonly pageFunctionThrows?: boolean;
    /** 値と位置を受け取る命令が失敗する。 */
    readonly summaryFails?: boolean;
    /** 要素の backendNodeId（解決の読み取り）。 */
    readonly resolvedIds?: readonly number[];
    /** 合図の受け手を付ける命令（`DOM.resolveNode`）が失敗する（解決した要素が、もうない）。 */
    readonly armFails?: boolean;
    /** 合図つきの位置の Locator が返す handle の数（0 は、位置の要素が解決した要素でない）。 */
    readonly handleCount?: number;
    /** session を切る命令が失敗する。 */
    readonly detachFails?: boolean;
  }

  /** 偽の CDP の session と page。開いた・切った session の数と、得た・手放した handle を記録する。 */
  function fakeResolutionPage(options: FakeResolutionOptions = {}) {
    const record = { opened: 0, detached: 0, armed: 0, disarmed: 0, locatorCalls: 0, handles: [] as string[], disposed: [] as string[] };
    const newSession = () => {
      record.opened += 1;
      let readInput: Record<string, unknown> = {};
      return {
        send: async (method: string, params: Record<string, unknown> = {}) => {
          switch (method) {
            case 'Page.getFrameTree':
              return { frameTree: { frame: { id: 'main-frame' }, childFrames: [] } };
            case 'Page.createIsolatedWorld':
              return { executionContextId: 7 };
            case 'DOM.resolveNode': {
              if (options.armFails === true) throw new Error('No node with the given id');
              record.armed += 1;
              return { object: { type: 'object', subtype: 'node', objectId: `armed-${String(params['backendNodeId'])}` } };
            }
            case 'Runtime.callFunctionOn': {
              if (String(params['objectId'] ?? '').startsWith('armed-')) {
                return { result: { type: 'boolean', value: true } };
              }
              const firstArgument = (params['arguments'] as { value: unknown }[] | undefined)?.[0]?.value;
              if (params['executionContextId'] !== undefined && Array.isArray(firstArgument)) {
                record.disarmed += firstArgument.length;
                return { result: { type: 'number', value: firstArgument.length } };
              }
              if (params['executionContextId'] !== undefined) {
                readInput = ((params['arguments'] as { value: Record<string, unknown> }[])[0]?.value) ?? {};
                return options.pageFunctionThrows === true && readInput['mode'] === 'RESOLVE'
                  ? { result: { type: 'undefined' }, exceptionDetails: { text: 'thrown' } }
                  : { result: { type: 'object', objectId: 'envelope' } };
              }
              if (params['arguments'] === undefined) {
                if (options.summaryFails === true && readInput['mode'] === 'RESOLVE') throw new Error('summary failed');
                const verifying = readInput['mode'] !== 'RESOLVE';
                return { result: { type: 'object', value: verifying
                  ? { value: true, paths: readInput['paths'] }
                  : { value: options.value, paths: options.paths ?? [] } } };
              }
              const index = (params['arguments'] as { value: number }[])[0]?.value ?? 0;
              return { result: { type: 'object', subtype: 'node', objectId: `${readInput['mode'] === 'RESOLVE' ? 'resolved' : 'verified'}-${index}` } };
            }
            case 'DOM.describeNode': {
              const objectId = String(params['objectId']);
              const index = Number(objectId.split('-')[1]);
              const backendNodeId = options.resolvedIds?.[index] ?? 100 + index;
              return { node: { backendNodeId } };
            }
            default:
              throw new Error(`unexpected command: ${method}`);
          }
        },
        detach: async () => {
          record.detached += 1;
          if (options.detachFails === true) throw new Error('detach failed');
        },
      };
    };
    const page = {
      context: () => ({ newCDPSession: async () => newSession() }),
      locator: () => ({
        elementHandles: async () => {
          record.locatorCalls += 1;
          return Array.from({ length: options.handleCount ?? 1 }, (_value, index) => {
            const name = `handle-${index}`;
            record.handles.push(name);
            return { dispose: async () => { record.disposed.push(name); } };
          });
        },
      }),
    } as unknown as Page;
    return { page, record };
  }

  it('detaches the read session when reading the resolution result fails (was: cleans every acquired resolver property when status reading fails)', async () => {
    const { page, record } = fakeResolutionPage({ value: { status: 'FOUND', domWorkUsed: 1 }, paths: [[0, 1, 0]], summaryFails: true });
    await expect(resolveInteractionCandidateHandle(page, 0)).rejects.toThrow('Interaction candidate isolated read failed');
    expect(record).toMatchObject({ opened: 1, detached: 1, locatorCalls: 0 });
  });

  it('detaches the read session when the page function throws (was: preserves an undefined resolver rejection after successful cleanup)', async () => {
    const { page, record } = fakeResolutionPage({ pageFunctionThrows: true });
    await expect(resolveInteractionCandidateHandle(page, 0)).rejects.toThrow('Interaction candidate isolated read failed');
    expect(record).toMatchObject({ opened: 1, detached: 1, locatorCalls: 0 });
  });

  it('keeps the read failure when detaching the session also fails (was: retains undefined primary presence with cleanup failures)', async () => {
    const { page, record } = fakeResolutionPage({ value: { status: 'FOUND', domWorkUsed: 1 }, paths: [[0, 1, 0]], summaryFails: true, detachFails: true });
    await expect(resolveInteractionCandidateHandle(page, 0)).rejects.toThrow('Interaction candidate isolated read failed');
    expect(record).toMatchObject({ opened: 1, detached: 1, locatorCalls: 0 });
  });

  // T32R-fix-I1: handle は、合図の受け手を付けた要素だけを返す Locator で得る（得た後に別の確かめをしない）。位置の要素が解決した要素で
  // なければ、Locator は要素を返さないので、handle を得ず、受け手を外し、session をすべて切る。
  it('acquires no handle, disarms the signal and detaches every session when the element at the path is not the resolved element (was: attempts all resolver cleanup after metadata disposal fails and reclaims the prospective FOUND child)', async () => {
    const { page, record } = fakeResolutionPage({ value: { status: 'FOUND', domWorkUsed: 2 }, paths: [[0, 1, 0]], resolvedIds: [41], handleCount: 0 });
    await expect(resolveInteractionCandidateHandle(page, 0)).rejects.toThrow('Interaction candidate handle is unavailable');
    expect(record).toMatchObject({ armed: 1, disarmed: 1, locatorCalls: 1, handles: [], disposed: [] });
    expect(record.opened).toBe(2);
    expect(record.detached).toBe(record.opened);
  });

  it('acquires no handle and detaches every session when the signal receiver cannot be armed', async () => {
    const { page, record } = fakeResolutionPage({ value: { status: 'FOUND', domWorkUsed: 2 }, paths: [[0, 1, 0]], armFails: true });
    await expect(resolveInteractionCandidateHandle(page, 0)).rejects.toThrow('Interaction candidate handle is unavailable');
    expect(record).toMatchObject({ armed: 0, disarmed: 0, locatorCalls: 0, handles: [] });
    expect(record.opened).toBe(2);
    expect(record.detached).toBe(record.opened);
  });

  it('detaches the read session after a successful non-FOUND resolution and acquires no handle (was: disposes unknown resolver properties on a successful non-FOUND envelope)', async () => {
    const { page, record } = fakeResolutionPage({ value: { status: 'MISSING', domWorkUsed: 2 }, paths: [] });
    await expect(resolveInteractionCandidateHandle(page, 0)).resolves.toEqual({ status: 'MISSING', domWorkUsed: 2 });
    expect(record).toMatchObject({ opened: 1, detached: 1, locatorCalls: 0, handles: [] });
  });

  it('disposes every handle when the path matches more than one element (was: reclaims a prospective FOUND child when envelope cleanup fails before transfer)', async () => {
    const { page, record } = fakeResolutionPage({ value: { status: 'FOUND', domWorkUsed: 2 }, paths: [[0, 1, 0]], handleCount: 2 });
    await expect(resolveInteractionCandidateHandle(page, 0)).rejects.toThrow('Interaction candidate handle is unavailable');
    expect(record.disposed.sort()).toEqual(['handle-0', 'handle-1']);
    expect(record).toMatchObject({ armed: 1, disarmed: 1 });
    expect(record.detached).toBe(record.opened);
  });

  it('hands over the verified handle of the resolved element and detaches every session', async () => {
    const { page, record } = fakeResolutionPage({ value: { status: 'FOUND', domWorkUsed: 2 }, paths: [[0, 1, 0]], resolvedIds: [42], handleCount: 1 });
    const resolution = await resolveInteractionCandidateHandle(page, 0);
    expect(resolution).toMatchObject({ status: 'FOUND', domWorkUsed: 2, reference: { backendNodeId: 42 } });
    expect(record.disposed).toEqual([]);
    expect(record).toMatchObject({ armed: 1, disarmed: 1, locatorCalls: 1 });
    expect(record.opened).toBe(2);
    expect(record.detached).toBe(record.opened);
  });

  it.each([
    ['unknown status', { value: { status: 'UNKNOWN', domWorkUsed: 0 }, paths: [] }],
    ['negative work', { value: { status: 'MISSING', domWorkUsed: -1 }, paths: [] }],
    ['work beyond the injected limit', { value: { status: 'MISSING', domWorkUsed: INJECTED_MAX_DOM_WORK + 1 }, paths: [] }],
    ['fractional work', { value: { status: 'MISSING', domWorkUsed: 1.5 }, paths: [] }],
    ['missing FOUND child', { value: { status: 'FOUND', domWorkUsed: 2 }, paths: [] }],
    ['non-element FOUND child', { value: { status: 'FOUND', domWorkUsed: 2 }, paths: [[0, 1, 0]], summaryFails: true }],
    ['contradictory MISSING child', { value: { status: 'MISSING', domWorkUsed: 2 }, paths: [[0, 1, 0]] }],
    ['contradictory budget child', { value: { status: 'DOM_WORK_BUDGET_REACHED', domWorkUsed: 2 }, paths: [[0, 1, 0]] }],
  ] as const)('rejects malformed resolver envelope: %s', async (_label, options) => {
    const { page, record } = fakeResolutionPage(options);
    // L10（N3・N4）: 作業量の範囲の確かめは、上限を注入したときだけ効く（上限なしの形は、下の受け入れの場面）。
    await expect(resolveInteractionCandidateHandle(page, 0, INJECTED_MAX_DOM_WORK)).rejects.toThrow();
    expect(record.locatorCalls).toBe(0);
    expect(record.opened).toBeGreaterThan(0);
    expect(record.detached).toBe(record.opened);
  });

  it.each([
    ['null container', null],
    ['array container', []],
    ['unknown status', { status: 'UNKNOWN', domWorkUsed: 0 }],
    ['negative work', { status: 'DISCONNECTED', domWorkUsed: -1 }],
    ['work beyond the injected limit', { status: 'DOM_WORK_BUDGET_REACHED', domWorkUsed: INJECTED_MAX_DOM_WORK + 1 }],
    ['fractional work', { status: 'DISCONNECTED', domWorkUsed: 1.5 }],
    ['missing CONNECTED raw', { status: 'CONNECTED', domWorkUsed: 1 }],
    ['contradictory DISCONNECTED raw', { status: 'DISCONNECTED', domWorkUsed: 1, raw: {} }],
    ['contradictory budget raw', { status: 'DOM_WORK_BUDGET_REACHED', domWorkUsed: 1, raw: {} }],
    ['contradictory candidate-limit raw', { status: 'CANDIDATE_LIMIT_REACHED', domWorkUsed: 1, raw: {} }],
    ['candidate-limit work beyond the injected limit', { status: 'CANDIDATE_LIMIT_REACHED', domWorkUsed: INJECTED_MAX_DOM_WORK + 1 }],
  ] as const)('rejects malformed retained snapshot: %s', async (_label, value) => {
    const handle = fakeCandidateReference(async () => value);
    await expect(inspectInteractionCandidateHandle(handle, 0, INJECTED_MAX_DOM_WORK)).rejects.toThrow();
  });

  // L10（N3・N4）: 上限を渡さない（本番の形）ときは、前の上限（16,384）を超えた作業量も、そのまま受け取る。
  it('accepts resolver and retained work beyond the former limit when no limit is given', async () => {
    const { page, record } = fakeResolutionPage({ value: { status: 'MISSING', domWorkUsed: INJECTED_MAX_DOM_WORK + 1 }, paths: [] });
    await expect(resolveInteractionCandidateHandle(page, 0)).resolves.toEqual({ status: 'MISSING', domWorkUsed: INJECTED_MAX_DOM_WORK + 1 });
    expect(record.detached).toBe(record.opened);
    const handle = fakeCandidateReference(async () => ({ status: 'DISCONNECTED', domWorkUsed: INJECTED_MAX_DOM_WORK + 1 }));
    await expect(inspectInteractionCandidateHandle(handle, 0)).resolves.toEqual({ status: 'DISCONNECTED', domWorkUsed: INJECTED_MAX_DOM_WORK + 1 });
  });

  // SPEC-5: 保持した要素の観測は、候補の数の上限（L10 で撤廃）で止まった結果（`CANDIDATE_LIMIT_REACHED`）を返さないので、受け取る場面は消した。
  // その値を不正な値として拒むことは、上の「rejects malformed retained snapshot」の candidate-limit の 2 行で確かめる。
});
}

/** Guard の付いた Passive の page で `path` を開き、名前が `name` の候補を探す（探索は COMPLETE であること。CC-029 の共通の補助）。 */
function candidateNamed(path: string, name: string): Promise<InteractionCandidate> {
  return discoverInteractionCandidate(factory, server.origin, viewport, path, name, { expectedCompleteness: 'COMPLETE' });
}

/** `path` の `candidate` を、`factory` の Interaction の session で監査する入力（期限は、共通の補助の `GATE_INTERACTION_TIMING`）。 */
function input(path: string, candidate: InteractionCandidate): InteractionAuditInput {
  return interactionAuditInput({ factory, origin: server.origin, viewport, path, candidate });
}

async function installTextTraversalCounter(page: Page): Promise<() => Promise<number>> {
  await evaluateInCandidateReadWorld(page, () => {
    const original = document.createTreeWalker.bind(document);
    let acceptedTextNodes = 0;
    Object.defineProperty(Document.prototype, 'createTreeWalker', {
      configurable: true,
      value(root: Node, whatToShow: number, filter?: NodeFilter | null) {
        const walker = original(root, whatToShow, filter);
        if (whatToShow !== NodeFilter.SHOW_ALL) return walker;
        const nextNode = walker.nextNode.bind(walker);
        walker.nextNode = () => {
          const node = nextNode();
          if (node !== null) acceptedTextNodes += 1;
          return node;
        };
        return walker;
      },
    });
    Object.defineProperty(globalThis, '__acceptedTextNodes', {
      configurable: true,
      get: () => acceptedTextNodes,
    });
  });
  return () => evaluateInCandidateReadWorld(page, () => (
    globalThis as typeof globalThis & { readonly __acceptedTextNodes: number }
  ).__acceptedTextNodes);
}

/** 子孫の走査（SHOW_ALL）の `nextNode` の呼び出しを数え、`maxNodes` を超えたら投げる（L10: 境は、テストが注入する作業量の上限）。 */
async function installTraversalProbe(page: Page, maxNodes: number): Promise<() => Promise<number>> {
  await evaluateInCandidateReadWorld(page, (maxNodes) => {
    const original = document.createTreeWalker.bind(document);
    let nextNodeCalls = 0;
    Object.defineProperty(Document.prototype, 'createTreeWalker', {
      configurable: true,
      value(root: Node, whatToShow: number, filter?: NodeFilter | null) {
        if (whatToShow !== NodeFilter.SHOW_ALL) return original(root, whatToShow, filter);
        const walker = original(root, whatToShow, filter);
        return new Proxy(walker, {
          get(target, property) {
            if (property !== 'nextNode') {
              return Reflect.get(target, property, target);
            }
            return () => {
              nextNodeCalls += 1;
              if (nextNodeCalls > maxNodes) {
                throw new Error('total node traversal exceeded its bound');
              }
              return target.nextNode();
            };
          },
        });
      },
    });
    Object.defineProperty(globalThis, '__beakSightTraversalCount', {
      configurable: true,
      get: () => nextNodeCalls,
    });
  }, maxNodes);
  return async () => evaluateInCandidateReadWorld(page, () => (
    globalThis as typeof globalThis & { readonly __beakSightTraversalCount: number }
  ).__beakSightTraversalCount);
}

/** 子孫の走査（SHOW_ALL）で返ったノードを、すべての根を通して数え、`maxNodes` を超えたら投げる。 */
async function installAggregateTraversalProbe(page: Page, maxNodes: number): Promise<() => Promise<number>> {
  await evaluateInCandidateReadWorld(page, (maxNodes) => {
    const original = document.createTreeWalker.bind(document);
    let nonNullNextNodeCalls = 0;
    Object.defineProperty(Document.prototype, 'createTreeWalker', {
      configurable: true,
      value(root: Node, whatToShow: number, filter?: NodeFilter | null) {
        if (whatToShow !== NodeFilter.SHOW_ALL) return original(root, whatToShow, filter);
        const walker = original(root, whatToShow, filter);
        return new Proxy(walker, {
          get(target, property) {
            if (property !== 'nextNode') {
              return Reflect.get(target, property, target);
            }
            return () => {
              const node = target.nextNode();
              if (node !== null) {
                nonNullNextNodeCalls += 1;
                if (nonNullNextNodeCalls > maxNodes) {
                  throw new Error('aggregate descendant traversal exceeded its bound');
                }
              }
              return node;
            };
          },
        });
      },
    });
    Object.defineProperty(globalThis, '__beakSightAggregateTraversalCount', {
      configurable: true,
      get: () => nonNullNextNodeCalls,
    });
  }, maxNodes);
  return async () => evaluateInCandidateReadWorld(page, () => (
    globalThis as typeof globalThis & { readonly __beakSightAggregateTraversalCount: number }
  ).__beakSightAggregateTraversalCount);
}

/** TS-c: 候補の探索のテストを登録する（`isolated-interaction-discovery.test.ts` が呼ぶ）。本文は、分ける前の位置と字下げのまま。 */
export function registerCandidateDiscoveryCases(): void {
describe('interaction candidate discovery', () => {
  it('discovers the generic union once in document order, deduplicates it, bounds facts, and leaves DOM untouched', async () => {
    await withGuardedPassivePage(factory, viewport, async (page) => {
      await page.goto(`${server.origin}/accordion.html`, { waitUntil: 'load' });
      const before = await page.content();

      const discovery = await discoverInteractionCandidates(page);
      expect(discovery.completeness).toBe('COMPLETE');
      const candidates = discovery.candidates;

      expect(candidates).toHaveLength(3);
      expect(candidates.map((candidate) => [candidate.ordinal, candidate.tagName, candidate.role])).toEqual([
        [0, 'button', null],
        [1, 'div', 'tab'],
        [2, 'summary', null],
      ]);
      expect(candidates[0]).toMatchObject({
        accessibleName: 'Toggle details',
        ariaExpanded: 'false',
        ariaControls: 'accordion-panel',
        controlledVisible: false,
        controlledHidden: true,
      });
      expect(candidates[0]?.candidateId).toMatch(/^interaction-candidate:sha256:[a-f0-9]{64}$/u);
      expect(candidates[0]?.textFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(Object.isFrozen(candidates)).toBe(true);
      expect(Object.isFrozen(candidates[0])).toBe(true);
      expect(Object.isFrozen(candidates[0]?.boundingBox)).toBe(true);
      expect(await page.content()).toBe(before);
    }, EXPECT_NO_GUARD_VIOLATIONS);
  });

  // L10（N3・N4）: 候補の数の上限（前は 100。CANDIDATE_LIMIT_REACHED）と名前の長さの上限（前は 256）は撤廃した。101 個以上の候補を、
  // 文書の終わりまで残らず見つけ、名前を切り詰めずに残す（fixture は 105 個。名前は 400 文字と番号）。
  it('retains every candidate beyond the former 100 and keeps every persisted name in full', async () => {
    const candidates = await discover('/candidate-overflow.html');

    expect(candidates).toHaveLength(105);
    expect(candidates.map(({ ordinal }) => ordinal)).toEqual(Array.from({ length: 105 }, (_unused, index) => index));
    expect(candidates.at(-1)?.accessibleName).toBe(`${'x'.repeat(400)}-104`);
    expect(candidates.every((candidate, index) => candidate.accessibleName === `${'x'.repeat(400)}-${index}`)).toBe(true);
    expect(candidates.every(Object.isFrozen)).toBe(true);
  });

  it('does not iterate a hostile NodeList or materialize full descendant text during discovery without a limit', async () => {
    await withGuardedPassivePage(factory, viewport, async (page) => {
      await page.goto(`${server.origin}/hostile-candidates.html`, { waitUntil: 'load' });
      await evaluateInCandidateReadWorld(page, () => {
        Object.defineProperty(NodeList.prototype, Symbol.iterator, {
          configurable: true,
          value(): never {
            throw new Error('NodeList iterator must not be used');
          },
        });
        Object.defineProperty(Node.prototype, 'textContent', {
          configurable: true,
          get(): never {
            throw new Error('full textContent must not be materialized');
          },
        });
        Object.defineProperty(Node.prototype, 'nodeValue', {
          configurable: true,
          get(): never {
            throw new Error('full text-node value must not be materialized');
          },
        });
      });

      const discovery = await discoverInteractionCandidates(page);
      expect(discovery.completeness).toBe('COMPLETE');
      expect(discovery.candidates.map(({ accessibleName, textFingerprint }) => [accessibleName, textFingerprint])).toEqual([
        ['Fallback label', createSha256Fingerprint('must-not-require-unbounded-traversal')],
      ]);
    }, EXPECT_NO_GUARD_VIOLATIONS);
  });

  it('does not iterate a hostile NodeList or materialize full descendant text during discovery (injected limit)', async () => {
    await withGuardedPassivePage(factory, viewport, async (page) => {
      await page.goto(`${server.origin}/hostile-candidates.html`, { waitUntil: 'load' });
      await evaluateInCandidateReadWorld(page, (maxTextNodes) => {
        Object.defineProperty(NodeList.prototype, Symbol.iterator, {
          configurable: true,
          value(): never {
            throw new Error('NodeList iterator must not be used');
          },
        });
        Object.defineProperty(Node.prototype, 'textContent', {
          configurable: true,
          get(): never {
            throw new Error('full textContent must not be materialized');
          },
        });
        Object.defineProperty(Node.prototype, 'nodeValue', {
          configurable: true,
          get(): never {
            throw new Error('full text-node value must not be materialized');
          },
        });
        const createTreeWalker = document.createTreeWalker.bind(document);
        Object.defineProperty(Document.prototype, 'createTreeWalker', {
          configurable: true,
          value(root: Node, whatToShow: number, filter?: NodeFilter | null) {
            if (whatToShow !== NodeFilter.SHOW_ALL) return createTreeWalker(root, whatToShow, filter);
            const walker = createTreeWalker(root, whatToShow, filter);
            let nextCalls = 0;
            return new Proxy(walker, {
              get(target, property) {
                if (property === 'nextNode') {
                  return () => {
                    nextCalls += 1;
                    if (nextCalls > maxTextNodes) {
                      throw new Error('bounded text walk exceeded its node limit');
                    }
                    return target.nextNode();
                  };
                }
                return Reflect.get(target, property, target) as unknown;
              },
            });
          },
        });
      }, INJECTED_TEXT_WALK_DOM_WORK);

      const discovery = await discoverInteractionCandidates(page, INJECTED_TEXT_WALK_DOM_WORK);
      expect(discovery.completeness).toBe('DOM_WORK_BUDGET_REACHED');
      const candidates = discovery.candidates;

      expect(candidates).toEqual([]);
    }, EXPECT_NO_GUARD_VIOLATIONS);
  });

  it('bounds total descendant nodes during discovery with all-node traversal (injected limit)', async () => {
    await withGuardedPassivePage(factory, viewport, async (page) => {
      await page.goto(`${server.origin}/hostile-candidates.html`, { waitUntil: 'load' });
      const readNextNodeCalls = await installTraversalProbe(page, INJECTED_TEXT_WALK_DOM_WORK);

      const discovery = await discoverInteractionCandidates(page, INJECTED_TEXT_WALK_DOM_WORK);
      expect(discovery.completeness).toBe('DOM_WORK_BUDGET_REACHED');
      expect(discovery.domWorkUsed).toBe(INJECTED_TEXT_WALK_DOM_WORK);
      const candidates = discovery.candidates;
      const nextNodeCalls = await readNextNodeCalls();

      expect(nextNodeCalls).toBeLessThanOrEqual(INJECTED_TEXT_WALK_DOM_WORK);
      expect(candidates).toEqual([]);
    }, EXPECT_NO_GUARD_VIOLATIONS);
  });

  it('bounds total descendant nodes during retained inspection with all-node traversal (injected limit)', async () => {
    await withGuardedPassivePage(factory, viewport, async (page) => {
      await page.goto(`${server.origin}/hostile-candidates.html`, { waitUntil: 'load' });
      const handle = await page.locator(INTERACTION_CANDIDATE_SELECTOR).first().elementHandle();
      const handleReference = await candidateReferenceOf(page, INTERACTION_CANDIDATE_SELECTOR);
      if (handle === null) {
        throw new Error('fixture candidate handle missing');
      }
      try {
        const readNextNodeCalls = await installTraversalProbe(page, INJECTED_TEXT_WALK_DOM_WORK);

        await expect(inspectInteractionCandidateHandle(handleReference, 0, INJECTED_TEXT_WALK_DOM_WORK)).resolves.toEqual({
          status: 'DOM_WORK_BUDGET_REACHED',
          domWorkUsed: INJECTED_TEXT_WALK_DOM_WORK,
        });
        const nextNodeCalls = await readNextNodeCalls();

        expect(nextNodeCalls).toBeLessThanOrEqual(INJECTED_TEXT_WALK_DOM_WORK);
      } finally {
        await handle.dispose();
      }
    }, EXPECT_NO_GUARD_VIOLATIONS);
  });

  // L10（N3・N4）: 上限を渡さない（本番の形）と、100,000 個の子孫を最後まで走査し、最後の文字を読む。
  it('walks every descendant node during discovery and retained inspection when no limit is given', async () => {
    await withGuardedPassivePage(factory, viewport, async (page) => {
      await page.goto(`${server.origin}/hostile-candidates.html`, { waitUntil: 'load' });
      const discovery = await discoverInteractionCandidates(page);
      expect(discovery.completeness).toBe('COMPLETE');
      expect(discovery.candidates.map(({ textFingerprint }) => textFingerprint)).toEqual([
        createSha256Fingerprint('must-not-require-unbounded-traversal'),
      ]);
      const handle = await page.locator(INTERACTION_CANDIDATE_SELECTOR).first().elementHandle();
      const handleReference = await candidateReferenceOf(page, INTERACTION_CANDIDATE_SELECTOR);
      if (handle === null) {
        throw new Error('fixture candidate handle missing');
      }
      try {
        await expect(inspectInteractionCandidateHandle(handleReference, 0)).resolves.toMatchObject({
          status: 'CONNECTED',
          candidate: { textFingerprint: createSha256Fingerprint('must-not-require-unbounded-traversal') },
        });
      } finally {
        await handle.dispose();
      }
    }, EXPECT_NO_GUARD_VIOLATIONS);
  });

  // L10（N3・N4）: 名前の根（ラベル 2 つ。子孫 300 個ずつ）の走査は、注入した DOM の作業量の上限を共有する。前の要素の走査（約 610）の後、
  // 1 つめの根を走査し終え、2 つめの根の途中で尽きる。
  it('shares the aggregate descendant-node budget across label roots during discovery (injected limit)', async () => {
    await withGuardedPassivePage(factory, viewport, async (page) => {
      await page.goto(`${server.origin}/multi-root-candidates.html`, { waitUntil: 'load' });
      const readNextNodeCalls = await installAggregateTraversalProbe(page, INJECTED_TEXT_WALK_DOM_WORK);

      const discovery = await discoverInteractionCandidates(page, INJECTED_TEXT_WALK_DOM_WORK);
      expect(discovery.completeness).toBe('DOM_WORK_BUDGET_REACHED');
      expect(discovery.domWorkUsed).toBe(INJECTED_TEXT_WALK_DOM_WORK);
      const candidates = discovery.candidates;
      const nextNodeCalls = await readNextNodeCalls();

      expect(nextNodeCalls).toBeGreaterThan(300);
      expect(nextNodeCalls).toBeLessThan(600);
      expect(candidates).toEqual([]);
    }, EXPECT_NO_GUARD_VIOLATIONS);
  });

  it('walks every label root to the end during discovery and retained inspection when no limit is given', async () => {
    await withGuardedPassivePage(factory, viewport, async (page) => {
      await page.goto(`${server.origin}/multi-root-candidates.html`, { waitUntil: 'load' });
      const handle = await page.locator(INTERACTION_CANDIDATE_SELECTOR).first().elementHandle();
      const handleReference = await candidateReferenceOf(page, INTERACTION_CANDIDATE_SELECTOR);
      if (handle === null) {
        throw new Error('fixture candidate handle missing');
      }
      try {
        const readNextNodeCalls = await installAggregateTraversalProbe(page, 1_200);

        const discovery = await discoverInteractionCandidates(page);
        expect(discovery.completeness).toBe('COMPLETE');
        // ラベルの子孫に文字がないので、名前は title に戻る。
        expect(discovery.candidates.map(({ accessibleName }) => accessibleName)).toEqual(['Fallback label']);
        expect(await readNextNodeCalls()).toBe(600);
        await expect(inspectInteractionCandidateHandle(handleReference, 0)).resolves.toMatchObject({
          status: 'CONNECTED',
          candidate: { accessibleName: 'Fallback label' },
        });
        expect(await readNextNodeCalls()).toBe(1_200);
      } finally {
        await handle.dispose();
      }
    }, EXPECT_NO_GUARD_VIOLATIONS);
  });

  it('shares the aggregate descendant-node budget across label roots during retained inspection (injected limit)', async () => {
    await withGuardedPassivePage(factory, viewport, async (page) => {
      await page.goto(`${server.origin}/multi-root-candidates.html`, { waitUntil: 'load' });
      const handle = await page.locator(INTERACTION_CANDIDATE_SELECTOR).first().elementHandle();
      const handleReference = await candidateReferenceOf(page, INTERACTION_CANDIDATE_SELECTOR);
      if (handle === null) {
        throw new Error('fixture candidate handle missing');
      }
      try {
        const readNextNodeCalls = await installAggregateTraversalProbe(page, INJECTED_TEXT_WALK_DOM_WORK);

        await expect(inspectInteractionCandidateHandle(handleReference, 0, INJECTED_TEXT_WALK_DOM_WORK)).resolves.toEqual({
          status: 'DOM_WORK_BUDGET_REACHED',
          domWorkUsed: INJECTED_TEXT_WALK_DOM_WORK,
        });
        const nextNodeCalls = await readNextNodeCalls();

        expect(nextNodeCalls).toBeGreaterThan(300);
        expect(nextNodeCalls).toBeLessThan(600);
      } finally {
        await handle.dispose();
      }
    }, EXPECT_NO_GUARD_VIOLATIONS);
  });

  it('inspects a retained handle without iterating the candidate NodeList', async () => {
    await withGuardedPassivePage(factory, viewport, async (page) => {
      await page.goto(`${server.origin}/accordion.html`, { waitUntil: 'load' });
      const handle = await page.locator(INTERACTION_CANDIDATE_SELECTOR).first().elementHandle();
      const handleReference = await candidateReferenceOf(page, INTERACTION_CANDIDATE_SELECTOR);
      if (handle === null) {
        throw new Error('fixture candidate handle missing');
      }
      try {
        await evaluateInCandidateReadWorld(page, () => {
          Object.defineProperty(NodeList.prototype, Symbol.iterator, {
            configurable: true,
            value(): never {
              throw new Error('NodeList iterator must not be used');
            },
          });
        });

        await expect(inspectInteractionCandidateHandle(handleReference, 0)).resolves.toMatchObject({ status: 'CONNECTED' });
      } finally {
        await handle.dispose();
      }
    }, EXPECT_NO_GUARD_VIOLATIONS);
  });

  // L10（N3・N4）: 順番の上限（前は 99）は撤廃した。前の上限を超えた順番の要素も、つながった候補として読む。
  it('reads a connected retained handle beyond the former ordinal cap as a candidate', async () => {
    await withGuardedPassivePage(factory, viewport, async (page) => {
      await page.goto(`${server.origin}/candidate-overflow.html`, { waitUntil: 'load' });
      const handle = await page.locator(INTERACTION_CANDIDATE_SELECTOR).nth(100).elementHandle();
      const handleReference = await candidateReferenceOf(page, INTERACTION_CANDIDATE_SELECTOR, 100);
      if (handle === null) {
        throw new Error('overflow fixture candidate handle missing');
      }
      try {
        await expect(inspectInteractionCandidateHandle(handleReference, 99)).resolves.toMatchObject({
          status: 'CONNECTED',
          candidate: { ordinal: 100, accessibleName: `${'x'.repeat(400)}-100` },
        });
      } finally {
        await handle.dispose();
      }
    }, EXPECT_NO_GUARD_VIOLATIONS);
  });

  it('discovers hidden and visible generic candidates without aborting the page snapshot', async () => {
    const candidates = await discover('/hidden-candidates.html');
    const hidden = candidates.find((candidate) => candidate.accessibleName === 'Hidden candidate');
    const visible = candidates.find((candidate) => candidate.accessibleName === 'Visible candidate');

    expect(candidates).toHaveLength(2);
    expect(hidden).toMatchObject({
      visible: false,
      boundingBox: { width: 0, height: 0 },
    });
    expect(classifyInteractionCandidate(hidden as InteractionCandidate)).toEqual({
      action: 'REJECT',
      reason: 'NOT_VISIBLE',
    });
    expect(classifyInteractionCandidate(visible as InteractionCandidate)).toEqual({
      action: 'ALLOW',
      reason: 'MECHANICALLY_SAFE',
    });
  });

  it('discovers an unresolved aria-controls candidate and a safe sibling without aborting', async () => {
    const candidates = await discover('/missing-aria-controls.html');
    const unresolved = candidates.find((candidate) => candidate.accessibleName === 'Missing controlled target');

    expect(candidates.map((candidate) => candidate.accessibleName)).toEqual([
      'Missing controlled target',
      'Safe sibling',
    ]);
    expect(unresolved).toMatchObject({
      ariaControls: 'absent-panel',
      controlledVisible: null,
      controlledHidden: null,
    });
  });

  it('keeps semantic identity stable when an unrelated candidate is inserted before it', async () => {
    await withGuardedPassivePage(factory, viewport, async (page) => {
      await page.goto(`${server.origin}/accordion.html`, { waitUntil: 'load' });
      const beforeDiscovery = await discoverInteractionCandidates(page);
      expect(beforeDiscovery.completeness).toBe('COMPLETE');
      const before = beforeDiscovery.candidates
        .find((candidate) => candidate.accessibleName === 'Toggle details');
      await page.evaluate(() => {
        const inserted = document.createElement('button');
        inserted.type = 'button';
        inserted.textContent = 'Unrelated inserted candidate';
        document.body.prepend(inserted);
      });
      const afterDiscovery = await discoverInteractionCandidates(page);
      expect(afterDiscovery.completeness).toBe('COMPLETE');
      const after = afterDiscovery.candidates
        .find((candidate) => candidate.accessibleName === 'Toggle details');
      const unrelated = afterDiscovery.candidates
        .find((candidate) => candidate.accessibleName === 'Unrelated inserted candidate');

      expect(before?.ordinal).toBe(0);
      expect(after?.ordinal).toBe(1);
      expect(after?.candidateId).toBe(before?.candidateId);
      expect(unrelated?.candidateId).not.toBe(after?.candidateId);
    }, EXPECT_NO_GUARD_VIOLATIONS);
  });
});
}

/** TS-c: fail-closed の監査のテストを登録する（`isolated-interaction-audit.test.ts` が呼ぶ）。本文は、分ける前の位置と字下げのまま。 */
export function registerFailClosedAuditCases(): void {
describe('isolated fail-closed interaction audit', () => {
  it('Task 2 fix round 2 keeps identity unestablished when the initial load consumes the deadline', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const page = {
      context: fakeGuardContext, goto: async () => { vi.setSystemTime(3_000); },
    } as unknown as Page;
    const session: InteractionGuardedSession = {
      page,
      ledger: new SafetyLedger(),
      activateInteractionFreeze: async () => undefined,
      ...fakeCloseLifecycle(),
    };
    try {
      // F18（R6 の I-2）で是正: 読み込みには、Interaction の期限ではなく、読み込みの期限（`navigationTimeoutMs`）を使う。
      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        navigationTimeoutMs: 2_000,
        timeoutMs: 2_000,
        deadlineAtMs: 10_000,
        sessionFactory: async () => session,
      });

      expect(result.status).toBe('NOT_VERIFIABLE');
      expectReason(result, 'INITIAL_LOAD_AFTER_LOAD');
      expect(result.evidence.identityStatus).toBe('UNESTABLISHED');
    } finally {
      vi.useRealTimers();
    }
  });

  it('Task 2 fix round 2 keeps identity unestablished for navigation work errors', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    const session: InteractionGuardedSession = {
      page: { context: fakeGuardContext, goto: async (): Promise<never> => { throw new Error('navigation work failed'); } } as unknown as Page,
      ledger: new SafetyLedger(),
      activateInteractionFreeze: async () => undefined,
      ...fakeCloseLifecycle(),
    };

    const result = await auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => session,
    });

    expect(result.status).toBe('EXECUTION_FAILED');
    expectReason(result, 'EXECUTION_FAILED', 'navigation work failed');
    expect(result.evidence.identityStatus).toBe('UNESTABLISHED');
  });

  it.each([
    [
      'ANSI escapes and the Playwright call log',
      [
        '\u001b[31mpage.goto: navigation interrupted\u001b[39m',
        'Call log:',
        '\u001b[2m  - navigating to target, waiting until "load"\u001b[22m',
      ].join('\n'),
      'page.goto: navigation interrupted',
    ],
    ['only control characters', '\u001b[31m\u0007\r\n\u001b[39m', null],
  ] as const)('normalizes an execution failure reason with %s', async (_label, message, expectedReasonDetail) => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    const session: InteractionGuardedSession = {
      page: { context: fakeGuardContext, goto: async (): Promise<never> => { throw new Error(message); } } as unknown as Page,
      ledger: new SafetyLedger(),
      activateInteractionFreeze: async () => undefined,
      ...fakeCloseLifecycle(),
    };

    const result = await auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => session,
    });

    expect(result.status).toBe('EXECUTION_FAILED');
    expectReason(result, 'EXECUTION_FAILED', expectedReasonDetail);
    expect(result.evidence.identityStatus).toBe('UNESTABLISHED');
  });

  it('Task 2 fix round 2 keeps identity unestablished for an unresolved safety transition', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    const page = {
      context: fakeGuardContext, goto: async () => undefined,
      evaluate: async () => true,
    } as unknown as Page;
    const session: InteractionGuardedSession = {
      page: withScrollPreparation(page, candidate),
      ledger: new SafetyLedger(),
      activateInteractionFreeze: async (): Promise<never> => { throw new Error('freeze transition unresolved'); },
      ...fakeCloseLifecycle(),
    };

    const result = await auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => session,
    });

    expect(result.status).toBe('EXECUTION_FAILED');
    expectReason(result, 'EXECUTION_FAILED', 'freeze transition unresolved');
    expect(result.evidence.identityStatus).toBe('UNESTABLISHED');
  });

  it('Task 2 fix round 2 keeps identity unestablished before the first retained observation', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    const rawCandidate = rawCandidateFor(candidate);
    const ledger = new SafetyLedger();
    const targetHandle = {
      evaluate: async () => ({ status: 'CONNECTED', domWorkUsed: 10, raw: rawCandidate }),
      click: async () => {
        ledger.recordBlockedInteractionRequest({
          method: 'GET',
          url: `${server.origin}/blocked-before-observation`,
          reason: 'INTERACTION_FROZEN',
        });
      },
      dispose: async () => undefined,
    };
    const page = {
      context: fakeGuardContext, goto: async () => undefined,
      evaluate: async (_callback: unknown, argument?: unknown) => (
        argument === undefined ? true : { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 20 }
      ),
      evaluateHandle: async () => boundedResolutionEnvelope(targetHandle),
    } as unknown as Page;
    const session: InteractionGuardedSession = {
      page: withScrollPreparation(page, candidate),
      ledger,
      activateInteractionFreeze: async () => undefined,
      ...fakeCloseLifecycle(),
    };

    const result = await auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => session,
    });

    expect(result.status).toBe('BLOCKED_BY_SAFETY');
    expect(result.evidence.identityStatus).toBe('UNESTABLISHED');
  });

  it('Task 2 fix round 2 keeps identity unestablished when the retained node changes before admission', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    const rawCandidate = rawCandidateFor(candidate);
    const changedRawCandidate = { ...rawCandidate, accessibleName: 'Changed retained candidate' };
    const targetHandle = {
      evaluate: async () => ({ status: 'CONNECTED', domWorkUsed: 10, raw: changedRawCandidate }),
      click: async () => undefined,
      dispose: async () => undefined,
    };
    const page = {
      context: fakeGuardContext, goto: async () => undefined,
      evaluate: async (_callback: unknown, argument?: unknown) => (
        argument === undefined ? true : { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 20 }
      ),
      evaluateHandle: async () => boundedResolutionEnvelope(targetHandle),
    } as unknown as Page;
    const session: InteractionGuardedSession = {
      page: withScrollPreparation(page, candidate),
      ledger: new SafetyLedger(),
      activateInteractionFreeze: async () => undefined,
      ...fakeCloseLifecycle(),
    };

    const result = await auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => session,
    });

    expect(result.status).toBe('NOT_VERIFIABLE');
    expectReason(result, 'TARGET_CHANGED_DURING_EXACT_NODE_RESOLUTION');
    expect(result.evidence.identityStatus).toBe('UNESTABLISHED');
  });

  it.each(['complete rediscovery absence', 'complete resolution absence'] as const)(
    'Task 2 fix round 2 preserves MISSING for %s',
    async (branch) => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const rawCandidate = rawCandidateFor(candidate);
      const property = (value: unknown) => ({
        jsonValue: async () => value,
        asElement: () => null,
        dispose: async () => undefined,
      });
      const page = {
        context: fakeGuardContext, goto: async () => undefined,
        evaluate: async (_callback: unknown, argument?: unknown) => (
          argument === undefined
            ? true
            : branch === 'complete rediscovery absence'
              ? { candidates: [], completeness: 'COMPLETE', domWorkUsed: 10 }
              : { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 20 }
        ),
        evaluateHandle: async () => injectedResolutionEnvelope(new Map([
          ['status', property('MISSING')],
          ['domWorkUsed', property(10)],
        ])),
      } as unknown as Page;
      const session: InteractionGuardedSession = {
        page,
        ledger: new SafetyLedger(),
        activateInteractionFreeze: async () => undefined,
        ...fakeCloseLifecycle(),
      };

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        sessionFactory: async () => session,
      });

      expect(result.status).toBe('NOT_VERIFIABLE');
      expect(result.evidence.identityStatus).toBe('MISSING');
    },
  );

  it('returns immutable result axes for a normal successful audit', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    server.resetCounters();
    server.resetRequestObservations();

    const result = await auditInteraction(input('/accordion.html', candidate));

    expect(result.status, JSON.stringify(result)).toBe('VERIFIED');
    expectReason(result, 'OBSERVABLE_STATE_CHANGED');
    expect(expectedStructuredResult(result).work).toEqual({
      status: 'VERIFIED',
      reason: 'OBSERVABLE_STATE_CHANGED',
      reasonDetail: null,
      evidence: result.evidence,
    });
    expect(expectedStructuredResult(result).lifecycle).toEqual({ status: 'CLOSED', reason: null, reasonDetail: null });
    expect(result.evidence).toBe(expectedStructuredResult(result).work.evidence);
    expect(result.evidence.changedFields).toEqual(expect.arrayContaining(['ariaExpanded', 'controlledVisible']));
    expect(result.evidence.before?.ariaExpanded).toBe('false');
    expect(result.evidence.after?.ariaExpanded).toBe('true');
    expect(server.getCounters()).toMatchObject({ get: 1, post: 0, download: 0, webSocketUpgrade: 0 });
    expect(server.getRequestObservations().map((entry) => entry.pathname)).toEqual(['/accordion.html']);
    expect(result.safety.invariantViolations).toEqual([]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(expectedStructuredResult(result).work)).toBe(true);
    expect(Object.isFrozen(expectedStructuredResult(result).lifecycle)).toBe(true);
    expect(Object.isFrozen(result.evidence)).toBe(true);
    expect(Object.isFrozen(result.evidence.changedFields)).toBe(true);
    expect(Object.isFrozen(result.safety)).toBe(true);
    for (const value of Object.values(result.safety)) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });

  // TS-f（B6・B12）: 押した操作のポップアップ・移動・WebSocket・POST が、凍結で止まってサーバに届かない場面と、凍結中のポップアップの要求の
  // くり返しの確かめ（DEF-036）は、同じ確かめをしていた `safety-gates.test.ts` の GATE-S01・S04・S06・S07 に、1 か所にまとめた。

  it('leaves a frozen popup open until the Interaction session close closes it with the Context (DEF-036)', async () => {
    const path = '/popup-form-post.html';
    const candidate = await candidateNamed(path, 'Open popup form');
    const popups: Page[] = [];
    const popupClosedAtOwnerClose: boolean[] = [];
    const sessionFactory = async (sessionViewport: Viewport): Promise<InteractionGuardedSession> => {
      const session = await factory.createInteractionSession(sessionViewport);
      session.page.context().on('page', (opened) => {
        popups.push(opened);
      });
      return {
        ...session,
        close: async (): Promise<void> => {
          popupClosedAtOwnerClose.push(...popups.map((popup) => popup.isClosed()));
          await session.close();
        },
      };
    };

    const result = await auditInteraction({ ...input(path, candidate), sessionFactory });

    expect(result.status).toBe('BLOCKED_BY_SAFETY');
    expect(result.safety.blockedPopups.length).toBeGreaterThan(0);
    expect(result.safety.invariantViolations).toEqual([]);
    expect(popups.length).toBeGreaterThan(0);
    expect(popupClosedAtOwnerClose.length).toBeGreaterThan(0);
    expect(popupClosedAtOwnerClose.every((closed) => !closed)).toBe(true);
    expect(popups.every((popup) => popup.isClosed())).toBe(true);
  });

  /**
   * DEF-039（設計書 `2026-10-08-beaksight-def-039-040-egress-design.md` 2.1.4）: 凍結の後にページ自身が開き、ページ自身が閉じる
   * ポップアップの、ページを離れるときの送信（`pagehide` か `unload` の beacon と keepalive の POST）は、Guard の route を通らずに
   * 出る（Chromium が閉じる途中で出す要求は、CDP の横取りを通らない。推測）。Interaction の Context の出口の中継は、凍結の後は
   * すべての要求を拒むので、サーバに届かない。
   * - 本物の Guard と中継の session を直接使い（`createInteractionSession` → 読み込み → 凍結 → click）、ポップアップが閉じるのを
   *   待ってから session を閉じる。auditor の流れ（ポップアップの事象で直ちに閉じる）は、Gate（`safety-gates.test.ts` の GATE-S04）
   *   が受け持つ。
   * - 3 つの場面（同じ処理の中で閉じる、`FROZEN_POPUP_SELF_CLOSE_DELAY_MS` 後に閉じる、`unload` の beacon）を、それぞれ
   *   `FROZEN_POPUP_SELF_CLOSE_ROUNDS` 回くり返し、どの回も、届かない、GET・HEAD 以外のカウンタが 0、違反 0、`blockedPopups` が
   *   1 件以上、閉じる処理が成功、であることを確かめる。
   * - DEF-042 の設計書 2.4（出口の中継との重なり）: Guard の CDP の横取り（すべての要求の Request の段階）が、opener の page の session
   *   でポップアップの送信も先に止める（理由 `INTERACTION_FROZEN`）ようになった。そのため、回ごとに、Guard の記録
   *   （`blockedInteractionRequests` の `INTERACTION_FROZEN`）か中継の記録（`INTERACTION_FROZEN_EGRESS`）のどちらかがあることを確かめる
   *   （中継の記録が場面ごとに 1 回以上という条件は外した）。中継が働く証拠は、中継の単体テスト（`tests/integration/egress-proxy.test.ts`）と
   *   factory の部品のテスト（`tests/component/context-factory.test.ts`）で示す（Worker の WebSocket は CSP が Worker の中で止めるので、
   *   中継に CONNECT は来ない。DEF-040 の NP3）。
   * - 全部の回の後に `FROZEN_POPUP_LATE_DELIVERY_SETTLE_MS` 待ち、遅れて届いた POST がないことを確かめる。
   * 回ごとの結果をまとめてから確かめるので、失敗したときは、失敗した回とその内容がすべて分かる。
   */
  it.each([
    ['closed in the same task', 'Close popup in the same task'],
    ['closed after a delay', 'Close popup after a delay'],
    ['closed with an unload beacon', 'Close popup with unload beacon'],
  ] as const)('never delivers the leaving requests of a popup the frozen page itself opens and closes (%s; DEF-039)', async (
    _label,
    buttonName,
  ) => {
    const allRoundsWindow = openServerWindow(server);
    const failedRounds: unknown[] = [];
    const egressRecordsByRound: string[][] = [];
    const guardRecordsByRound: string[][] = [];

    for (let round = 0; round < FROZEN_POPUP_SELF_CLOSE_ROUNDS; round += 1) {
      const session = await factory.createInteractionSession(viewport);
      let closeFailure: unknown = null;
      let summary: unknown;
      try {
        await session.page.goto(`${server.origin}${POPUP_SELF_CLOSE_BEACON_PAGE}`, { waitUntil: 'load' });
        await session.activateInteractionFreeze();
        const window = openServerWindow(server);
        await session.page.getByRole('button', { name: buttonName }).click();
        await wait(FROZEN_POPUP_SELF_CLOSE_DELAY_MS + QUIET_PERIOD_MS);
        const snapshot = session.ledger.snapshot();
        const egressRecords = snapshot.blockedInteractionRequests
          .filter((entry) => entry.reason === 'INTERACTION_FROZEN_EGRESS')
          .map((entry) => `${entry.method} ${entry.url}`);
        const guardRecords = snapshot.blockedInteractionRequests
          .filter((entry) => entry.reason === 'INTERACTION_FROZEN')
          .map((entry) => `${entry.method} ${entry.url}`);
        egressRecordsByRound.push(egressRecords);
        guardRecordsByRound.push(guardRecords);
        summary = {
          round,
          delivered: window.count(null, '/__mutation'),
          deliveredLines: window.requestLines(),
          nonReadCounters: window.nonReadCounters(),
          blockedPopups: snapshot.blockedPopups.length,
          invariantViolations: snapshot.invariantViolations,
          egressRecords,
          guardRecords,
        };
      } finally {
        await session.close().catch((error: unknown) => {
          closeFailure = error;
        });
      }
      const result = summary as {
        readonly delivered: number;
        readonly nonReadCounters: Readonly<Record<string, number>>;
        readonly blockedPopups: number;
        readonly invariantViolations: readonly unknown[];
        readonly egressRecords: readonly string[];
        readonly guardRecords: readonly string[];
      };
      if (
        result.delivered !== 0
        || Object.values(result.nonReadCounters).some((count) => count !== 0)
        || result.blockedPopups === 0
        || result.invariantViolations.length !== 0
        || (result.egressRecords.length === 0 && result.guardRecords.length === 0)
        || closeFailure !== null
      ) {
        failedRounds.push({ ...result, closeFailure: closeFailure === null ? null : String(closeFailure) });
      }
    }
    await wait(FROZEN_POPUP_LATE_DELIVERY_SETTLE_MS);
    // 回ごとの中継と Guard の記録（検証の記録のため。既定の報告では、PASS したテストの出力は表示されない）。
    console.info(`DEF-039 ${buttonName} egress records by round: ${JSON.stringify(egressRecordsByRound)}`);
    console.info(`DEF-039 ${buttonName} guard records by round: ${JSON.stringify(guardRecordsByRound)}`);

    expect(failedRounds).toEqual([]);
    expect(allRoundsWindow.count(null, '/__mutation')).toBe(0);
    expect(allRoundsWindow.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
  }, FROZEN_POPUP_SELF_CLOSE_TEST_TIMEOUT_MS);

  it('cancels and records a generated data-URL download without making a server-delivery claim', async () => {
    const candidate = await candidateNamed('/download-button.html', 'Attempt generated download');
    server.resetCounters();
    server.resetRequestObservations();

    const result = await auditInteraction(input('/download-button.html', candidate));

    expect(result.status).toBe('BLOCKED_BY_SAFETY');
    expect(result.safety.blockedDownloads.length).toBeGreaterThan(0);
    expect(server.getCounters().download).toBe(0);
    expect(server.getRequestObservations().map((entry) => entry.pathname)).toEqual(['/download-button.html']);
  });

  // TS-f（B7）: 押した HTTP のダウンロードが凍結で止まり、/__download がサーバに届かない場面は、同じ確かめをしていた
  // `safety-gates.test.ts` の GATE-S05 に、1 か所にまとめた。

  it('does not click an unsafe node inserted between rediscovery and target acquisition', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    let unsafeClickCalls = 0;
    let browserClickEvents = 0;
    const sessionFactory = async (sessionViewport: Viewport): Promise<InteractionGuardedSession> => {
      const session = await factory.createInteractionSession(sessionViewport);
      const page = session.page;
      await page.exposeFunction('__recordUnsafeAcquiredChildClick', () => {
        browserClickEvents += 1;
      });
      const wrappedPage = Object.create(page) as Page;
      // T32j-4 fix round 1: 解決（`RESOLVE`）の直前に危ない要素を差し込む（今までの `evaluateHandle` の差し込みと同じ時点。今までの
      // `locator().nth()` の差し込みは、解決が `evaluateHandle` だったので働いていなかった）。読み取りは本物の isolated world の読み取りに任せる。
      const base = interactionCandidateReadsOf(page);
      const insertBeforeResolution = async (): Promise<void> => {
        await page.evaluate(() => {
          document.addEventListener('click', () => {
            void (globalThis as typeof globalThis & {
              __recordUnsafeAcquiredChildClick(): Promise<void>;
            }).__recordUnsafeAcquiredChildClick();
          }, { capture: true });
          const inserted = document.createElement('a');
          inserted.setAttribute('role', 'button');
          inserted.href = '/navigation-target.html';
          inserted.textContent = 'Unsafe inserted navigation';
          document.body.prepend(inserted);
        });
      };
      withInteractionCandidateReads(wrappedPage, {
        ...base,
        resolve: async (_target, resolveInput, deadlineAtMs) => {
          await insertBeforeResolution();
          return base.resolve(page, resolveInput, deadlineAtMs);
        },
        handleOf: async (_target, reference, deadlineAtMs) => {
          const handle = await base.handleOf(page, reference, deadlineAtMs);
          if (handle === null) {
            return null;
          }
          return new Proxy(handle, {
            get(target, property, receiver) {
              if (property === 'click') {
                return async (clickOptions: { readonly timeout?: number }) => {
                  unsafeClickCalls += 1;
                  return target.click(clickOptions);
                };
              }
              const value: unknown = Reflect.get(target, property, receiver);
              return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
            },
          });
        },
        discover: (_target, discoverInput, deadlineAtMs) => base.discover(page, discoverInput, deadlineAtMs),
        inspect: (_target, backendNodeId, inspectInput, deadlineAtMs) => base.inspect(page, backendNodeId, inspectInput, deadlineAtMs),
      });
      wrappedPage.locator = ((selector: string) => {
        const locator = page.locator(selector);
        return {
          nth(index: number) {
            const target = locator.nth(index);
            const insertUnsafeCandidate = async () => {
              await page.evaluate(() => {
                const inserted = document.createElement('a');
                inserted.setAttribute('role', 'button');
                inserted.href = '/navigation-target.html';
                inserted.textContent = 'Unsafe inserted navigation';
                document.body.prepend(inserted);
              });
            };
            return {
              async click(options: { readonly timeout?: number }) {
                await insertUnsafeCandidate();
                unsafeClickCalls += 1;
                return target.click(options);
              },
              async elementHandle(options: { readonly timeout?: number }) {
                await insertUnsafeCandidate();
                const handle = await target.elementHandle(options);
                if (handle === null) {
                  return null;
                }
                return {
                  evaluate: handle.evaluate.bind(handle),
                  async click(clickOptions: { readonly timeout?: number }) {
                    unsafeClickCalls += 1;
                    return handle.click(clickOptions);
                  },
                  dispose: handle.dispose.bind(handle),
                };
              },
            };
          },
        };
      }) as Page['locator'];
      return Object.freeze({ ...session, page: wrappedPage });
    };

    const result = await auditInteraction({ ...input('/accordion.html', candidate), sessionFactory });

    expect(result.status).toBe('NOT_VERIFIABLE');
    expect(unsafeClickCalls).toBe(0);
    expect(browserClickEvents).toBe(0);
  });

  it.each([
    ['/missing-button.html', 'Detach candidate', 'MISSING'],
    ['/ambiguous-button.html', 'Duplicate candidate', 'AMBIGUOUS'],
    ['/replacement-button.html', 'Replace candidate', 'REPLACED'],
  ] as const)('reports exact retained-node identity loss for %s', async (path, name, identityStatus) => {
    const candidate = await candidateNamed(path, name);

    const result = await auditInteraction(input(path, candidate));

    expect(result.status).toBe('NOT_VERIFIABLE');
    expect(result.evidence.identityStatus).toBe(identityStatus);
    // C18n: 理由はコード、切断の後の identityStatus は詳細に入る。
    expectReason(result, 'RETAINED_IDENTITY_LOST', identityStatus);
  });

  it('verifies visibility evidence when the retained exact node hides itself', async () => {
    const candidate = await candidateNamed('/self-hide-button.html', 'Hide candidate');

    const result = await auditInteraction(input('/self-hide-button.html', candidate));

    expect(result.status, JSON.stringify(result)).toBe('VERIFIED');
    expect(result.evidence.identityStatus).toBe('MATCHED');
    expect(result.evidence.before?.visible).toBe(true);
    expect(result.evidence.after).toMatchObject({
      visible: false,
      boundingBox: { width: 0, height: 0 },
    });
    // F15（設計書 4.4.1）で是正: 大きさの変化（boundingBox）は根拠にしない。
    // SPEC-5（設計書 2026-11-14 5.1）で是正: 対象自身の属性は ARIA の状態と `open` と class の名前だけを根拠にするので、付いた `hidden` 属性は
    // 根拠にしない（見え方の変化 `visible` で確かめる）。
    expect(result.evidence.changedFields).toEqual(['visible']);
    expect(result.evidence.changedAttributes).toEqual([]);
  });

  it('reports an initially duplicated semantic identity as ambiguous in reason and evidence', async () => {
    const candidate = await candidateNamed('/initial-duplicate-button.html', 'Duplicate identity');

    const result = await auditInteraction(input('/initial-duplicate-button.html', candidate));

    expect(result.status).toBe('NOT_VERIFIABLE');
    expectReason(result, 'CANDIDATE_IDENTITY_AMBIGUOUS');
    expect(result.evidence.identityStatus).toBe('AMBIGUOUS');
  });

  // TS-f（B8）: `mailto:`・`tel:` のリンクと直接のダウンロードを押す前に拒否する場面は、同じ確かめをしていた `safety-gates.test.ts` の
  // GATE-S03・S05 に、1 か所にまとめた。
  it.each([
    ['/external-link.html', 'External resource', 1],
    ['/post-form.html', 'Submit', 0],
  ] as const)('mechanically rejects %s before clicking', async (path, name, externalActionCount) => {
    const candidate = await candidateNamed(path, name);
    server.resetCounters();
    server.resetRequestObservations();

    const result = await auditInteraction(input(path, candidate));

    expect(result.status).toBe('REJECTED_UNSAFE');
    expect(result.evidence.identityStatus).toBe('MATCHED');
    expect(result.safety.blockedExternalActions).toHaveLength(externalActionCount);
    expect(server.getRequestObservations().map((entry) => entry.pathname)).toEqual([path]);
    expect(server.getCounters()).toMatchObject({ post: 0, download: 0, webSocketUpgrade: 0 });
  });

  it('blocks Service Worker bypass without fetching the worker script', async () => {
    const candidate = await candidateNamed('/service-worker.html', 'Register worker');
    server.resetCounters();
    server.resetRequestObservations();

    const result = await auditInteraction(input('/service-worker.html', candidate));

    expect(result.status).toBe('NOT_VERIFIABLE');
    expect(server.getRequestObservations().map((entry) => entry.pathname)).toEqual(['/service-worker.html']);
    expect(result.safety.invariantViolations).toEqual([]);
  });

  // SREV-SAFE の I-4: 押すと同じ文書の中で `pushState` もする候補（SPA のタブの切り替えの形）も、止めた移動にならず VERIFIED になる。
  it('closes the owner session exactly once after a verified audit, also when the press pushes a history state', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    let closeCalls = 0;
    let observedPage: Page | undefined;
    const sessionFactory = async (sessionViewport: Viewport): Promise<InteractionGuardedSession> => {
      const session = await factory.createInteractionSession(sessionViewport);
      observedPage = session.page;
      await session.page.addInitScript({ content: "document.addEventListener('click', () => history.pushState({}, '', location.pathname + '?tab=2'), true);" });
      return Object.freeze({
        ...session,
        async close(): Promise<void> {
          closeCalls += 1;
          await session.close();
        },
      });
    };

    const result = await auditInteraction({ ...input('/accordion.html', candidate), sessionFactory });

    expect(result.status, JSON.stringify(result.safety.blockedInteractionNavigations)).toBe('VERIFIED');
    expect(result.safety.blockedInteractionNavigations).toEqual([]);
    expect(closeCalls).toBe(1);
    expect(observedPage?.isClosed()).toBe(true);
  });

  it('does not click when freeze activation fails and still closes once', async () => {
    const candidate = await candidateNamed('/mutation-button.html', 'Attempt mutation');
    let closeCalls = 0;
    const sessionFactory = async (sessionViewport: Viewport): Promise<InteractionGuardedSession> => {
      const session = await factory.createInteractionSession(sessionViewport);
      return Object.freeze({
        ...session,
        async activateInteractionFreeze(): Promise<void> {
          throw new Error('fixture freeze activation failed');
        },
        async close(): Promise<void> {
          closeCalls += 1;
          await session.close();
        },
      });
    };
    server.resetCounters();

    const result = await auditInteraction({ ...input('/mutation-button.html', candidate), sessionFactory });

    expect(result.status).toBe('EXECUTION_FAILED');
    expectReason(result, 'EXECUTION_FAILED', 'fixture freeze activation failed');
    expect(closeCalls).toBe(1);
    expect(server.getCounters().post).toBe(0);
  });

  it('does not click or perform a post evaluation after rediscovery reaches the absolute deadline', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    // 下準備の描画の待ちは、実際に時間が進むのを待つ。偽の時計を実際の時間に合わせて進める。
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(1_000);
    let discoveryEvaluations = 0;
    let clickCalls = 0;
    const rawCandidate = {
      ordinal: candidate.ordinal,
      tagName: candidate.tagName,
      role: candidate.role,
      accessibleName: candidate.accessibleName,
      normalizedText: 'Toggle details',
      ariaExpanded: candidate.ariaExpanded,
      ariaControls: candidate.ariaControls,
      ariaSelected: candidate.ariaSelected,
      controlledVisible: candidate.controlledVisible,
      controlledHidden: candidate.controlledHidden,
      formAssociated: candidate.formAssociated,
      formMethod: candidate.formMethod,
      formAction: candidate.formAction,
      rawHref: candidate.href,
      documentUrl: `${server.origin}/accordion.html`,
      documentOrigin: server.origin,
      download: candidate.download,
      type: candidate.type,
      disabled: candidate.disabled,
      visible: candidate.visible,
      destructiveFacts: destructiveActionFactsOfNames([candidate.accessibleName]),
      boundingBox: candidate.boundingBox,
    };
    const page = {
      context: fakeGuardContext, goto: async () => undefined,
      evaluate: async (_callback: unknown, argument?: unknown) => {
        if (argument === undefined) {
          return true;
        }
        discoveryEvaluations += 1;
        vi.setSystemTime(3_000);
        return { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 0 };
      },
      evaluateHandle: async () => boundedResolutionEnvelope((await page.locator(INTERACTION_CANDIDATE_SELECTOR).nth(candidate.ordinal).elementHandle()) as never),
      locator: () => ({
        nth: () => ({
          click: async () => {
            clickCalls += 1;
          },
        }),
      }),
    } as unknown as Page;
    const session: InteractionGuardedSession = {
      page: withScrollPreparation(page, candidate),
      ledger: new SafetyLedger(),
      activateInteractionFreeze: async () => undefined,
      ...fakeCloseLifecycle(),
    };
    try {
      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        timeoutMs: 2_000,
        deadlineAtMs: 10_000,
        sessionFactory: async () => session,
      });

      expect(result.status).toBe('NOT_VERIFIABLE');
      expect(clickCalls).toBe(0);
      expect(discoveryEvaluations).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves the deadline outcome when deadline handle dispose failed', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    // 下準備の描画の待ちは、実際に時間が進むのを待つ。偽の時計を実際の時間に合わせて進める。
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(1_000);
    let clickCalls = 0;
    let disposeCalls = 0;
    let handleEvaluateCalls = 0;
    const rawCandidate = {
      ordinal: candidate.ordinal,
      tagName: candidate.tagName,
      role: candidate.role,
      accessibleName: candidate.accessibleName,
      normalizedText: 'Toggle details',
      ariaExpanded: candidate.ariaExpanded,
      ariaControls: candidate.ariaControls,
      ariaSelected: candidate.ariaSelected,
      controlledVisible: candidate.controlledVisible,
      controlledHidden: candidate.controlledHidden,
      formAssociated: candidate.formAssociated,
      formMethod: candidate.formMethod,
      formAction: candidate.formAction,
      rawHref: candidate.href,
      documentUrl: `${server.origin}/accordion.html`,
      documentOrigin: server.origin,
      download: candidate.download,
      type: candidate.type,
      disabled: candidate.disabled,
      visible: candidate.visible,
      destructiveFacts: destructiveActionFactsOfNames([candidate.accessibleName]),
      boundingBox: candidate.boundingBox,
    };
    const page = {
      context: fakeGuardContext, goto: async () => undefined,
      evaluate: async (_callback: unknown, argument?: unknown) => (
        argument === undefined ? true : { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 0 }
      ),
      evaluateHandle: async () => boundedResolutionEnvelope((await page.locator(INTERACTION_CANDIDATE_SELECTOR).nth(candidate.ordinal).elementHandle()) as never),
      locator: () => ({
        nth: () => ({
          async click() {
            clickCalls += 1;
            vi.setSystemTime(3_000);
          },
          async elementHandle() {
            vi.setSystemTime(3_000);
            return {
              async evaluate() {
                handleEvaluateCalls += 1;
                return { status: 'CONNECTED', domWorkUsed: 0, raw: rawCandidate };
              },
              async click() {
                clickCalls += 1;
              },
              async dispose(): Promise<never> {
                disposeCalls += 1;
                throw new Error('deadline handle dispose failed');
              },
            };
          },
        }),
      }),
    } as unknown as Page;
    const session: InteractionGuardedSession = {
      page: withScrollPreparation(page, candidate),
      ledger: new SafetyLedger(),
      activateInteractionFreeze: async () => undefined,
      ...fakeCloseLifecycle(),
    };
    try {
      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        timeoutMs: 2_000,
        deadlineAtMs: 10_000,
        sessionFactory: async () => session,
      });

      expect(result.status).toBe('NOT_VERIFIABLE');
      expectReason(result, 'DEADLINE_BEFORE_EXACT_NODE_CLICK');
      expect(result.evidence.after).toBeNull();
      expect(disposeCalls).toBe(1);
      expect(result.safety.invariantViolations).toContainEqual({
        code: 'INTERACTION_HANDLE_DISPOSE_FAILED',
        message: 'deadline handle dispose failed',
      });
      expect(result.safety.invariantViolations.filter(
        ({ code }) => code === 'INTERACTION_HANDLE_DISPOSE_FAILED',
      )).toHaveLength(1);
      expect(clickCalls).toBe(0);
      expect(handleEvaluateCalls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['ordinary Error', 'EXECUTION_FAILED', 'CLICK_FAILED', 'ordinary click consumed deadline'],
    ['TimeoutError', 'NOT_VERIFIABLE', 'CLICK_TIMED_OUT', 'timeout click consumed deadline'],
  ] as const)('reports %s when click reaches the deadline without a post evaluation', async (
    errorKind,
    expectedStatus,
    expectedReasonCode,
    expectedReason,
  ) => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    // 下準備の描画の待ちは、実際に時間が進むのを待つ。偽の時計を実際の時間に合わせて進める。
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(1_000);
    let handleEvaluations = 0;
    const rawCandidate = {
      ordinal: candidate.ordinal,
      tagName: candidate.tagName,
      role: candidate.role,
      accessibleName: candidate.accessibleName,
      normalizedText: 'Toggle details',
      ariaExpanded: candidate.ariaExpanded,
      ariaControls: candidate.ariaControls,
      ariaSelected: candidate.ariaSelected,
      controlledVisible: candidate.controlledVisible,
      controlledHidden: candidate.controlledHidden,
      formAssociated: candidate.formAssociated,
      formMethod: candidate.formMethod,
      formAction: candidate.formAction,
      rawHref: candidate.href,
      documentUrl: `${server.origin}/accordion.html`,
      documentOrigin: server.origin,
      download: candidate.download,
      type: candidate.type,
      disabled: candidate.disabled,
      visible: candidate.visible,
      destructiveFacts: destructiveActionFactsOfNames([candidate.accessibleName]),
      boundingBox: candidate.boundingBox,
    };
    const clickError = new Error(expectedReason);
    clickError.name = errorKind === 'TimeoutError' ? 'TimeoutError' : 'Error';
    const page = {
      context: fakeGuardContext, goto: async () => undefined,
      evaluate: async (_callback: unknown, argument?: unknown) => (
        argument === undefined ? true : { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 0 }
      ),
      evaluateHandle: async () => boundedResolutionEnvelope((await page.locator(INTERACTION_CANDIDATE_SELECTOR).nth(candidate.ordinal).elementHandle()) as never),
      locator: () => ({
        nth: () => ({
          elementHandle: async () => ({
            evaluate: async () => {
              handleEvaluations += 1;
              return { status: 'CONNECTED', domWorkUsed: 0, raw: rawCandidate };
            },
            click: async () => {
              vi.setSystemTime(3_000);
              throw clickError;
            },
            dispose: async () => undefined,
          }),
        }),
      }),
    } as unknown as Page;
    const session: InteractionGuardedSession = {
      page: withScrollPreparation(page, candidate),
      ledger: new SafetyLedger(),
      activateInteractionFreeze: async () => undefined,
      ...fakeCloseLifecycle(),
    };

    try {
      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        sessionFactory: async () => session,
      });

      expect(result.status).toBe(expectedStatus);
      expectReason(result, expectedReasonCode, expectedReason);
      expect(handleEvaluations).toBe(1);
      expect(result.evidence.after).toBeNull();
      expect(result.evidence.changedFields).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['TimeoutError', 'NOT_VERIFIABLE'],
    ['ordinary Error', 'EXECUTION_FAILED'],
  ] as const)('keeps observed evidence and reports %s after click mutates then throws', async (errorKind, expectedStatus) => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    let expanded = false;
    let handleEvaluations = 0;
    const rawCandidate = () => ({
      ordinal: candidate.ordinal,
      tagName: candidate.tagName,
      role: candidate.role,
      accessibleName: candidate.accessibleName,
      normalizedText: 'Toggle details',
      ariaExpanded: expanded ? 'true' : 'false',
      ariaControls: candidate.ariaControls,
      ariaSelected: candidate.ariaSelected,
      controlledVisible: expanded,
      controlledHidden: !expanded,
      formAssociated: candidate.formAssociated,
      formMethod: candidate.formMethod,
      formAction: candidate.formAction,
      rawHref: candidate.href,
      documentUrl: `${server.origin}/accordion.html`,
      documentOrigin: server.origin,
      download: candidate.download,
      type: candidate.type,
      disabled: candidate.disabled,
      visible: candidate.visible,
      destructiveFacts: destructiveActionFactsOfNames([candidate.accessibleName]),
      boundingBox: candidate.boundingBox,
    });
    const clickError = new Error(`${errorKind} after state change`);
    clickError.name = errorKind === 'TimeoutError' ? 'TimeoutError' : 'Error';
    const page = {
      context: fakeGuardContext, goto: async () => undefined,
      evaluate: async (_callback: unknown, argument?: unknown) => (
        argument === undefined ? true : { candidates: [rawCandidate()], completeness: 'COMPLETE', domWorkUsed: 0 }
      ),
      evaluateHandle: async () => boundedResolutionEnvelope((await page.locator(INTERACTION_CANDIDATE_SELECTOR).nth(candidate.ordinal).elementHandle()) as never),
      locator: () => ({
        nth: () => ({
          elementHandle: async () => ({
            evaluate: async () => {
              handleEvaluations += 1;
              return { status: 'CONNECTED', domWorkUsed: 0, raw: rawCandidate() };
            },
            click: async () => {
              expanded = true;
              throw clickError;
            },
            dispose: async () => undefined,
          }),
        }),
      }),
    } as unknown as Page;
    const session: InteractionGuardedSession = {
      page: withScrollPreparation(page, candidate),
      ledger: new SafetyLedger(),
      activateInteractionFreeze: async () => undefined,
      ...fakeCloseLifecycle(),
    };

    const result = await auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => session,
    });

    expect(result.status).toBe(expectedStatus);
    expect(result.status).not.toBe('VERIFIED');
    expect(result.evidence.changedFields).toEqual(expect.arrayContaining(['ariaExpanded', 'controlledVisible']));
    expect(result.evidence.after?.ariaExpanded).toBe('true');
  });

  it('lets a freeze event outrank a click failure and changed evidence', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    const ledger = new SafetyLedger();
    const rawCandidate = {
      ordinal: candidate.ordinal,
      tagName: candidate.tagName,
      role: candidate.role,
      accessibleName: candidate.accessibleName,
      normalizedText: 'Toggle details',
      ariaExpanded: candidate.ariaExpanded,
      ariaControls: candidate.ariaControls,
      ariaSelected: candidate.ariaSelected,
      controlledVisible: candidate.controlledVisible,
      controlledHidden: candidate.controlledHidden,
      formAssociated: candidate.formAssociated,
      formMethod: candidate.formMethod,
      formAction: candidate.formAction,
      rawHref: candidate.href,
      documentUrl: `${server.origin}/accordion.html`,
      documentOrigin: server.origin,
      download: candidate.download,
      type: candidate.type,
      disabled: candidate.disabled,
      visible: candidate.visible,
      destructiveFacts: destructiveActionFactsOfNames([candidate.accessibleName]),
      boundingBox: candidate.boundingBox,
    };
    const page = {
      context: fakeGuardContext, goto: async () => undefined,
      evaluate: async (_callback: unknown, argument?: unknown) => (
        argument === undefined ? true : { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 0 }
      ),
      evaluateHandle: async () => boundedResolutionEnvelope((await page.locator(INTERACTION_CANDIDATE_SELECTOR).nth(candidate.ordinal).elementHandle()) as never),
      locator: () => ({
        nth: () => ({
          elementHandle: async () => ({
            evaluate: async () => ({ status: 'CONNECTED', domWorkUsed: 0, raw: rawCandidate }),
            click: async () => {
              ledger.recordBlockedInteractionRequest({
                method: 'GET',
                url: `${server.origin}/blocked-after-click`,
                reason: 'INTERACTION_FROZEN',
              });
              throw new Error('click failed after freeze event');
            },
            dispose: async () => undefined,
          }),
        }),
      }),
    } as unknown as Page;
    const session: InteractionGuardedSession = {
      page: withScrollPreparation(page, candidate),
      ledger,
      activateInteractionFreeze: async () => undefined,
      ...fakeCloseLifecycle(),
    };

    const result = await auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => session,
    });

    expect(result.status).toBe('BLOCKED_BY_SAFETY');
  });

  it('invalidates the guarded context when freeze is activated twice', async () => {
    const session = await factory.createInteractionSession(viewport);
    await session.page.goto(`${server.origin}/accordion.html`, { waitUntil: 'load' });

    await session.activateInteractionFreeze();
    await expect(session.activateInteractionFreeze()).rejects.toThrow(/invalid from FROZEN_ACTIVE/u);

    await expect.poll(() => session.page.isClosed()).toBe(true);
    expect(session.ledger.snapshot().invariantViolations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'INTERACTION_FREEZE_ACTIVATION_FAILED' }),
    ]));
  });

  it('preserves structured work and non-terminal lifecycle when work and owner close fail', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    let closeCalls = 0;
    const page = {
      context: fakeGuardContext, goto: async (): Promise<never> => { throw new Error('fixture work failed'); },
    } as unknown as Page;
    const session: InteractionGuardedSession & { readonly isClosed: () => boolean } = {
      page,
      ledger: new SafetyLedger(),
      activateInteractionFreeze: async () => undefined,
      isClosed: () => false,
      close: async (): Promise<never> => {
        closeCalls += 1;
        throw new Error('fixture close failed');
      },
    };

    const cleanupError = await expectOwnerCleanupError(auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => session,
    }));

    expect(cleanupError.session).toBe(session);
    expect(cleanupError.work).toEqual({
      status: 'EXECUTION_FAILED',
      reason: 'EXECUTION_FAILED',
      reasonDetail: 'fixture work failed',
      evidence: cleanupError.work.evidence,
    });
    expect(cleanupError.lifecycle).toEqual({
      status: 'NON_TERMINAL',
      reason: 'OWNER_CLOSE_FAILED',
      reasonDetail: 'fixture close failed',
    });
    expect(cleanupError.work.evidence.after).toBeNull();
    expect(closeCalls).toBe(2);
    expect(cleanupError.safety.invariantViolations).toContainEqual({
      code: 'INTERACTION_OWNER_CLOSE_FAILED',
      message: 'fixture close failed',
    });
    expect(cleanupError.safety.invariantViolations.filter(
      ({ code }) => code === 'INTERACTION_OWNER_CLOSE_FAILED',
    )).toHaveLength(2);
  });

  it('owner cleanup retry closes a real Factory Guard session before returning preserved work', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    let capturedSession: InteractionGuardedSession | undefined;
    let capturedContext: ReturnType<Page['context']> | undefined;
    let rawCloseCalls = 0;
    const firstFailure = new Error('first audit owner close failed');

    const result = await auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async (sessionViewport) => {
        const session = await factory.createInteractionSession(sessionViewport);
        capturedSession = session;
        capturedContext = session.page.context();
        const rawClose = capturedContext.close.bind(capturedContext);
        vi.spyOn(capturedContext, 'close').mockImplementation(async () => {
          rawCloseCalls += 1;
          if (rawCloseCalls === 1) throw firstFailure;
          await rawClose();
        });
        return session;
      },
    });

    expect(capturedSession).toBeDefined();
    expect(capturedContext).toBeDefined();
    expect(rawCloseCalls).toBe(2);
    expect(capturedSession?.isClosed()).toBe(true);
    expect(result.status).toBe('BLOCKED_BY_SAFETY');
    expectReason(result, 'OWNER_CLOSE_SAFETY_FAILURE');
    expect(result.work.status).toBe('VERIFIED');
    expectReason(result.work, 'OBSERVABLE_STATE_CHANGED');
    // I1/Q3（設計書 4.1）: 2回目の close は invalidation を経て CLOSED に達するので、前回の失敗にかかわらず
    // invalidated で reject する。最新の異常はその reject になり、1回目の失敗も Ledger に残る。
    expect(result.lifecycle).toEqual({
      status: 'CLOSED',
      reason: 'OWNER_CLOSE_FAILED',
      reasonDetail: 'Passive request guard context was invalidated',
    });
    expect(result.safety.invariantViolations).toEqual(expect.arrayContaining([
      { code: 'GUARDED_CONTEXT_CLOSE_FAILED', message: firstFailure.message },
      { code: 'INTERACTION_OWNER_CLOSE_FAILED', message: firstFailure.message },
      { code: 'INTERACTION_OWNER_CLOSE_FAILED', message: 'Passive request guard context was invalidated' },
    ]));
    expect(result.evidence).toBe(result.work.evidence);
    await expect(factory.closePassiveContext(capturedContext!)).rejects.toThrow(/no longer active|not owned/i);
  });

  it('owner cleanup exhaustion transfers the exact real session for later terminal recovery', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    const firstFailure = new Error('first bounded cleanup failure');
    let capturedSession: InteractionGuardedSession | undefined;
    let capturedContext: ReturnType<Page['context']> | undefined;
    let rawCloseCalls = 0;

    const rejection = await auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async (sessionViewport) => {
        const session = await factory.createInteractionSession(sessionViewport);
        capturedSession = session;
        capturedContext = session.page.context();
        const rawClose = capturedContext.close.bind(capturedContext);
        vi.spyOn(capturedContext, 'close').mockImplementation(async () => {
          rawCloseCalls += 1;
          if (rawCloseCalls === 1) throw firstFailure;
          if (rawCloseCalls === 2) return Promise.reject(undefined);
          await rawClose();
        });
        return session;
      },
    }).catch((error: unknown) => error);

    const cleanupError = rejection as {
      readonly name: string;
      readonly message: string;
      readonly session: InteractionGuardedSession;
      readonly candidateId: string;
      readonly work: ExpectedStructuredInteractionResult['work'];
      readonly lifecycle: InteractionNonTerminalLifecycle;
      readonly safety: ReturnType<SafetyLedger['snapshot']>;
      readonly lastCloseRejected: boolean;
      readonly lastCloseError: unknown;
    };
    expect(cleanupError.name).toBe('InteractionOwnerCleanupError');
    expect(cleanupError.message).toBe('Interaction owner cleanup retry budget exhausted');
    expect(cleanupError.session).toBe(capturedSession);
    expect(cleanupError.candidateId).toBe(candidate.candidateId);
    expect(cleanupError.work.status).toBe('VERIFIED');
    expectReason(cleanupError.work, 'OBSERVABLE_STATE_CHANGED');
    expect(cleanupError.lifecycle).toEqual({ status: 'NON_TERMINAL', reason: 'OWNER_CLOSE_FAILED', reasonDetail: 'undefined' });
    expect(cleanupError.lastCloseRejected).toBe(true);
    expect(Object.hasOwn(cleanupError, 'lastCloseError')).toBe(true);
    expect(cleanupError.lastCloseError).toBeUndefined();
    expect(cleanupError.safety.invariantViolations).toContainEqual({
      code: 'INTERACTION_OWNER_CLEANUP_RETRY_EXHAUSTED',
      message: 'Interaction owner cleanup retry budget exhausted',
    });
    expect(Object.isFrozen(cleanupError)).toBe(true);
    expect(Object.isFrozen(cleanupError.work)).toBe(true);
    expect(Object.isFrozen(cleanupError.lifecycle)).toBe(true);
    expect(Object.isFrozen(cleanupError.safety)).toBe(true);
    expect(rawCloseCalls).toBe(2);
    expect(capturedSession?.isClosed()).toBe(false);

    const module = await import('../../src/interaction/isolated-auditor.js');
    expect(module).toHaveProperty('InteractionOwnerCleanupError');
    // I1/Q3（設計書 4.1）: 非終端の失敗の後でも、invalidation を経た CLOSED は invalidated で reject する。
    await expect(cleanupError.session.close()).rejects.toThrow('Passive request guard context was invalidated');
    expect(rawCloseCalls).toBe(3);
    expect(cleanupError.session.isClosed()).toBe(true);
    await expect(factory.closePassiveContext(capturedContext!)).rejects.toThrow(/no longer active|not owned/i);
  });

  it('owner cleanup retries fulfilled non-terminal close and retains the anomaly after CLOSED', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    const ledger = new SafetyLedger();
    let closeCalls = 0;
    let closed = false;
    const session: InteractionGuardedSession = {
      page: { context: fakeGuardContext, goto: async (): Promise<never> => { throw new Error('fulfilled retry work failed'); } } as unknown as Page,
      ledger,
      activateInteractionFreeze: async () => undefined,
      isClosed: () => closed,
      close: async () => {
        closeCalls += 1;
        if (closeCalls === 2) closed = true;
      },
    };

    const result = await auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => session,
    });

    expect(closeCalls).toBe(2);
    expect(result.status).toBe('BLOCKED_BY_SAFETY');
    expectReason(result, 'OWNER_CLOSE_SAFETY_FAILURE');
    expect(result.work).toEqual({
      status: 'EXECUTION_FAILED',
      reason: 'EXECUTION_FAILED',
      reasonDetail: 'fulfilled retry work failed',
      evidence: result.evidence,
    });
    expect(result.lifecycle).toEqual({
      status: 'CLOSED',
      reason: 'OWNER_CLOSE_NON_TERMINAL',
      reasonDetail: null,
    });
    expect(result.safety.invariantViolations).toContainEqual({
      code: 'INTERACTION_OWNER_CLOSE_NON_TERMINAL',
      message: 'Interaction owner close fulfilled without terminal Guard state',
    });
  });

  it('owner cleanup preserves an undefined rejection after automatic recovery', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    const ledger = new SafetyLedger();
    let closeCalls = 0;
    let closed = false;
    const session: InteractionGuardedSession = {
      page: { context: fakeGuardContext, goto: async (): Promise<never> => { throw new Error('undefined retry work failed'); } } as unknown as Page,
      ledger,
      activateInteractionFreeze: async () => undefined,
      isClosed: () => closed,
      close: async () => {
        closeCalls += 1;
        if (closeCalls === 1) return Promise.reject(undefined);
        closed = true;
      },
    };

    const result = await auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => session,
    });

    expect(closeCalls).toBe(2);
    expect(result.status).toBe('BLOCKED_BY_SAFETY');
    expectReason(result.work, 'EXECUTION_FAILED', 'undefined retry work failed');
    expect(result.lifecycle).toEqual({ status: 'CLOSED', reason: 'OWNER_CLOSE_FAILED', reasonDetail: 'undefined' });
    expect(result.safety.invariantViolations).toContainEqual({
      code: 'INTERACTION_OWNER_CLOSE_FAILED',
      message: 'undefined',
    });
  });

  it('preserves VERIFIED structured work under a rejected non-terminal lifecycle', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    const ownedSession = await factory.createInteractionSession(viewport);
    let closeCalls = 0;
    const session: InteractionGuardedSession & { readonly isClosed: () => boolean } = Object.freeze({
      ...ownedSession,
      isClosed: () => false,
      close: async (): Promise<never> => {
        closeCalls += 1;
        throw new Error('verified close failed');
      },
    });
    try {
      const cleanupError = await expectOwnerCleanupError(auditInteraction({
        ...input('/accordion.html', candidate),
        sessionFactory: async () => session,
      }));

      expect(cleanupError.work.status).toBe('VERIFIED');
      expectReason(cleanupError.work, 'OBSERVABLE_STATE_CHANGED');
      expect(cleanupError.work.evidence.changedFields).toEqual(expect.arrayContaining(['ariaExpanded', 'controlledVisible']));
      expect(cleanupError.lifecycle).toEqual({
        status: 'NON_TERMINAL',
        reason: 'OWNER_CLOSE_FAILED',
        reasonDetail: 'verified close failed',
      });
      expect(closeCalls).toBe(2);
    } finally {
      await ownedSession.close();
    }
  });

  it('records fulfilled without terminal Guard state as a non-terminal lifecycle invariant', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    let closeCalls = 0;
    const ledger = new SafetyLedger();
    const session: InteractionGuardedSession & { readonly isClosed: () => boolean } = {
      page: { context: fakeGuardContext, goto: async (): Promise<never> => { throw new Error('fulfilled non-terminal work failed'); } } as unknown as Page,
      ledger,
      activateInteractionFreeze: async () => undefined,
      isClosed: () => false,
      close: async () => { closeCalls += 1; },
    };

    const cleanupError = await expectOwnerCleanupError(auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => session,
    }));

    expect(cleanupError.work.status).toBe('EXECUTION_FAILED');
    expectReason(cleanupError.work, 'EXECUTION_FAILED', 'fulfilled non-terminal work failed');
    expect(cleanupError.lifecycle).toEqual({
      status: 'NON_TERMINAL',
      reason: 'OWNER_CLOSE_NON_TERMINAL',
      reasonDetail: null,
    });
    expect(closeCalls).toBe(2);
    expect(cleanupError.safety.invariantViolations).toContainEqual({
      code: 'INTERACTION_OWNER_CLOSE_NON_TERMINAL',
      message: 'Interaction owner close fulfilled without terminal Guard state',
    });
  });

  it.each(['INVALIDATING', 'CLOSED'] as const)(
    'returns terminal invalidation structured work and CLOSED lifecycle when the audit joins during %s',
    async (joinTiming) => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const rawCloseGate = createDeferred<void>();
      let rawCloseCalls = 0;
      let contextCleanupCalls = 0;
      // Guard が Context に付ける listener の事象の一覧（DEF-110 fix で `close` が加わった）。Guard の後片付けは、これを同じ順で 1 回ずつ外す。
      const guardListenerEvents = await guardContextListenerEvents();
      const contextCleanupEvents: string[] = [];
      const sessionFactory = async (sessionViewport: Viewport): Promise<InteractionGuardedSession> => {
        const session = await factory.createInteractionSession(sessionViewport);
        const context = session.page.context();
        const rawContextClose = context.close.bind(context);
        const rawContextOff = context.off.bind(context);
        vi.spyOn(context, 'close').mockImplementation(async () => {
          rawCloseCalls += 1;
          await rawCloseGate.promise;
          await rawContextClose();
        });
        vi.spyOn(context, 'off').mockImplementation((event, listener) => {
          contextCleanupCalls += 1;
          contextCleanupEvents.push(String(event));
          if (contextCleanupCalls === 1) {
            throw new Error(`late ${joinTiming} listener cleanup evidence`);
          }
          return rawContextOff(event, listener);
        });
        return Object.freeze({
          ...session,
          async close(): Promise<void> {
            await session.page.close();
            await expect.poll(() => rawCloseCalls).toBe(1);
            if (joinTiming === 'INVALIDATING') {
              const joining = session.close();
              rawCloseGate.resolve(undefined);
              await joining;
              return;
            }
            rawCloseGate.resolve(undefined);
            // Guard の Context の listener をすべて外し終えるまで待つ（数は Guard が付ける一覧から導く）。
            await expect.poll(() => contextCleanupCalls).toBe(guardListenerEvents.length);
            await wait(0);
            await session.close();
          },
        });
      };

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        sessionFactory,
      });

      expect(result.status).toBe('BLOCKED_BY_SAFETY');
      expectReason(result, 'OWNER_CLOSE_SAFETY_FAILURE');
      expect(expectedStructuredResult(result).work.status).toBe('VERIFIED');
      expectReason(expectedStructuredResult(result).work, 'OBSERVABLE_STATE_CHANGED');
      expect(expectedStructuredResult(result).lifecycle).toEqual({
        status: 'CLOSED',
        reason: 'OWNER_CLOSE_FAILED',
        reasonDetail: 'Passive request guard context was invalidated',
      });
      expect(result.evidence).toBe(expectedStructuredResult(result).work.evidence);
      expect(result.evidence.identityStatus).toBe('MATCHED');
      expect(result.evidence.changedFields).toEqual(expect.arrayContaining(['ariaExpanded', 'controlledVisible']));
      expect(result.safety.invariantViolations).toEqual(expect.arrayContaining([
        {
          code: 'CDP_SESSION_DETACHED',
          message: CDP_SESSION_DETACHED_MESSAGE,
        },
        {
          code: 'GUARD_LISTENER_CLEANUP_FAILED',
          message: `late ${joinTiming} listener cleanup evidence`,
        },
        {
          code: 'INTERACTION_OWNER_CLOSE_FAILED',
          message: 'Passive request guard context was invalidated',
        },
      ]));
      expect(rawCloseCalls).toBe(1);
      expect(contextCleanupCalls).toBe(guardListenerEvents.length);
      expect(contextCleanupEvents).toEqual(guardListenerEvents);
    },
  );

  async function auditWithLifecyclePriority(order: 'CLOSE_FIRST' | 'INVALIDATE_FIRST') {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    const rawCloseGate = createDeferred<void>();
    let rawCloseCalls = 0;
    const sessionFactory = async (sessionViewport: Viewport): Promise<InteractionGuardedSession> => {
      const session = await factory.createInteractionSession(sessionViewport);
      const context = session.page.context();
      const rawContextClose = context.close.bind(context);
      vi.spyOn(context, 'close').mockImplementation(async () => {
        rawCloseCalls += 1;
        await rawCloseGate.promise;
        await rawContextClose();
      });
      const invalidate = (): void => {
        // main frame の page を引けない Playwright のリクエスト失敗は、freeze イベントを追加することなく、インストール済みの実際の guard を通して
        // 無効化されなければならない。SAFE-2 の 4: 前のきっかけ（frame を分類できない失敗）は違反でなく記録になったので、page の引き当ての失敗に替えた。
        const emitter = context as unknown as { emit(event: string, value: unknown): boolean };
        // CC-094: 偽の要求は共通の補助で作る（frame の口だけ、page を引けない main frame に替える）。
        emitter.emit('requestfailed', fakePlaywrightRequest({ navigation: true }, {
          frame: () => ({
            parentFrame: () => null,
            page: () => { throw new Error('lifecycle priority page lookup failed'); },
          }),
        }));
      };
      return Object.freeze({
        ...session,
        async close(): Promise<void> {
          if (order === 'INVALIDATE_FIRST') invalidate();
          // raw-closeの境界がゲートされている間に、拒否を即座に観測する。
          const closing = session.close().then(
            () => ({ failed: false as const }),
            (error: unknown) => ({ failed: true as const, error }),
          );
          await expect.poll(() => rawCloseCalls).toBe(1);
          if (order === 'CLOSE_FIRST') invalidate();
          rawCloseGate.resolve(undefined);
          const outcome = await closing;
          if (outcome.failed) throw outcome.error;
        },
      });
    };
    const result = await auditInteraction({ ...input('/accordion.html', candidate), sessionFactory });
    return { result, rawCloseCalls };
  }

  it('lifecycle priority rejects the mutation that drops invalidation during close after VERIFIED work', async () => {
    const { result, rawCloseCalls } = await auditWithLifecyclePriority('CLOSE_FIRST');

    expect(result.status).toBe('BLOCKED_BY_SAFETY');
    expectReason(result, 'OWNER_CLOSE_SAFETY_FAILURE');
    expect(expectedStructuredResult(result).work.status).toBe('VERIFIED');
    expectReason(expectedStructuredResult(result).work, 'OBSERVABLE_STATE_CHANGED');
    expect(expectedStructuredResult(result).lifecycle).toEqual({
      status: 'CLOSED',
      reason: 'OWNER_CLOSE_FAILED',
      reasonDetail: 'Passive request guard context was invalidated',
    });
    expect(result.evidence.identityStatus).toBe('MATCHED');
    expect(result.evidence.changedFields).toEqual(expect.arrayContaining(['ariaExpanded', 'controlledVisible']));
    expect(result.safety.invariantViolations).toEqual(expect.arrayContaining([
      { code: 'INTERACTION_OWNER_CLOSE_FAILED', message: 'Passive request guard context was invalidated' },
    ]));
    expect(result.safety.blockedInteractionRequests).toEqual([]);
    expect(Object.isFrozen(result.safety.invariantViolations)).toBe(true);
    expect(rawCloseCalls).toBe(1);
  });

  it('lifecycle priority rejects the mutation that lets normal close win only when it starts first', async () => {
    const invalidationFirst = await auditWithLifecyclePriority('INVALIDATE_FIRST');
    const closeFirst = await auditWithLifecyclePriority('CLOSE_FIRST');

    expect(closeFirst.result.status).toBe(invalidationFirst.result.status);
    expect([invalidationFirst.result.status, closeFirst.result.status]).toEqual([
      'BLOCKED_BY_SAFETY', 'BLOCKED_BY_SAFETY',
    ]);
    expect([invalidationFirst.rawCloseCalls, closeFirst.rawCloseCalls]).toEqual([1, 1]);
    expect(closeFirst.result.safety).toEqual(invalidationFirst.result.safety);
    expect(closeFirst.result.evidence.changedFields).toEqual(invalidationFirst.result.evidence.changedFields);
  });

  it.each([false, true] as const)(
    'preserves undefined close rejection presence for terminal=%s',
    async (terminal) => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    let closeCalls = 0;
    const ledger = new SafetyLedger();
    const page = {
      context: fakeGuardContext, goto: async (): Promise<never> => { throw new Error('undefined-close work failed'); },
    } as unknown as Page;
    let closed = false;
    const session: InteractionGuardedSession & { readonly isClosed: () => boolean } = {
      page,
      ledger,
      activateInteractionFreeze: async () => undefined,
      isClosed: () => closed,
      close: async (): Promise<never> => {
        closeCalls += 1;
        closed = terminal;
        return Promise.reject(undefined);
      },
    };

    const completion = auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => session,
    });
    if (terminal) {
      const result = await completion;
      expect(result.status).toBe('BLOCKED_BY_SAFETY');
      expectReason(result, 'OWNER_CLOSE_SAFETY_FAILURE');
      expect(result.work.status).toBe('EXECUTION_FAILED');
      expectReason(result.work, 'EXECUTION_FAILED', 'undefined-close work failed');
      expect(result.lifecycle).toEqual({ status: 'CLOSED', reason: 'OWNER_CLOSE_FAILED', reasonDetail: 'undefined' });
      expect(result.evidence).toBe(result.work.evidence);
      expect(closeCalls).toBe(1);
      expect(result.safety.invariantViolations).toEqual([{
        code: 'INTERACTION_OWNER_CLOSE_FAILED',
        message: 'undefined',
      }]);
    } else {
      const cleanupError = await expectOwnerCleanupError(completion);
      expect(cleanupError.work.status).toBe('EXECUTION_FAILED');
      expectReason(cleanupError.work, 'EXECUTION_FAILED', 'undefined-close work failed');
      expect(cleanupError.lifecycle).toEqual({ status: 'NON_TERMINAL', reason: 'OWNER_CLOSE_FAILED', reasonDetail: 'undefined' });
      expect(cleanupError.work.evidence.before?.candidateId).toBe(candidate.candidateId);
      expect(cleanupError.work.evidence.after).toBeNull();
      expect(cleanupError.lastCloseRejected).toBe(true);
      expect(Object.hasOwn(cleanupError, 'lastCloseError')).toBe(true);
      expect(cleanupError.lastCloseError).toBeUndefined();
      expect(closeCalls).toBe(2);
      expect(cleanupError.safety.invariantViolations.filter(
        ({ code }) => code === 'INTERACTION_OWNER_CLOSE_FAILED',
      )).toHaveLength(2);
    }
    },
  );

  it('normalizes a hostile work rejection and still closes exactly once', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    let closeCalls = 0;
    const hostileWorkError = new Proxy(Object.create(null) as object, {
      getPrototypeOf(): never {
        throw new Error('hostile instanceof trap');
      },
    });
    const page = {
      context: fakeGuardContext, goto: async (): Promise<never> => { throw hostileWorkError; },
    } as unknown as Page;
    const session: InteractionGuardedSession = {
      page,
      ledger: new SafetyLedger(),
      activateInteractionFreeze: async () => undefined,
      ...fakeCloseLifecycle(async () => { closeCalls += 1; }),
    };

    const result = await auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => session,
    });

    expect(result.status).toBe('EXECUTION_FAILED');
    expectReason(result, 'EXECUTION_FAILED', 'Interaction error could not be safely normalized');
    expect(result.evidence.before?.candidateId).toBe(candidate.candidateId);
    expect(result.evidence.after).toBeNull();
    expect(closeCalls).toBe(1);
    expect(result.safety.invariantViolations).toEqual([]);
  });

  it('preserves a deadline result when hostile handle dispose rejection normalization fails', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    // 下準備の描画の待ちは、実際に時間が進むのを待つ。偽の時計を実際の時間に合わせて進める。
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(1_000);
    let closeCalls = 0;
    let disposeCalls = 0;
    const rawCandidate = {
      ordinal: candidate.ordinal,
      tagName: candidate.tagName,
      role: candidate.role,
      accessibleName: candidate.accessibleName,
      normalizedText: 'Toggle details',
      ariaExpanded: candidate.ariaExpanded,
      ariaControls: candidate.ariaControls,
      ariaSelected: candidate.ariaSelected,
      controlledVisible: candidate.controlledVisible,
      controlledHidden: candidate.controlledHidden,
      formAssociated: candidate.formAssociated,
      formMethod: candidate.formMethod,
      formAction: candidate.formAction,
      rawHref: candidate.href,
      documentUrl: `${server.origin}/accordion.html`,
      documentOrigin: server.origin,
      download: candidate.download,
      type: candidate.type,
      disabled: candidate.disabled,
      visible: candidate.visible,
      destructiveFacts: destructiveActionFactsOfNames([candidate.accessibleName]),
      boundingBox: candidate.boundingBox,
    };
    const hostileDisposeError = new Proxy(new Error('hidden dispose failure'), {
      get(target, property) {
        if (property === 'message') {
          throw new Error('hostile message getter');
        }
        return Reflect.get(target, property, target) as unknown;
      },
    });
    const page = {
      context: fakeGuardContext, goto: async () => undefined,
      evaluate: async (_callback: unknown, argument?: unknown) => (
        argument === undefined ? true : { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 0 }
      ),
      evaluateHandle: async () => boundedResolutionEnvelope((await page.locator(INTERACTION_CANDIDATE_SELECTOR).nth(candidate.ordinal).elementHandle()) as never),
      locator: () => ({
        nth: () => ({
          elementHandle: async () => {
            vi.setSystemTime(3_000);
            return {
              evaluate: async () => ({ status: 'CONNECTED', domWorkUsed: 0, raw: rawCandidate }),
              click: async () => undefined,
              dispose: async (): Promise<never> => {
                disposeCalls += 1;
                throw hostileDisposeError;
              },
            };
          },
        }),
      }),
    } as unknown as Page;
    const ledger = new SafetyLedger();
    const session: InteractionGuardedSession = {
      page: withScrollPreparation(page, candidate),
      ledger,
      activateInteractionFreeze: async () => undefined,
      ...fakeCloseLifecycle(async () => { closeCalls += 1; }),
    };

    try {
      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        timeoutMs: 2_000,
        deadlineAtMs: 10_000,
        sessionFactory: async () => session,
      });

      expect(result.status).toBe('NOT_VERIFIABLE');
      expectReason(result, 'DEADLINE_BEFORE_EXACT_NODE_CLICK');
      expect(result.evidence.after).toBeNull();
      expect(disposeCalls).toBe(1);
      expect(closeCalls).toBe(1);
      expect(result.safety.invariantViolations).toEqual([{
        code: 'INTERACTION_HANDLE_DISPOSE_FAILED',
        message: 'Interaction error could not be safely normalized',
      }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('normalizes a hostile owner close rejection into a safety result', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    let closeCalls = 0;
    const hostileCloseError = {
      [Symbol.toPrimitive](): never {
        throw new Error('hostile coercion trap');
      },
    };
    const ledger = new SafetyLedger();
    const page = {
      context: fakeGuardContext, goto: async (): Promise<never> => { throw new Error('hostile-close work failed'); },
    } as unknown as Page;
    const session: InteractionGuardedSession = {
      page,
      ledger,
      activateInteractionFreeze: async () => undefined,
      ...fakeCloseLifecycle(async (): Promise<never> => {
        closeCalls += 1;
        throw hostileCloseError;
      }),
    };

    const cleanupError = await expectOwnerCleanupError(auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => session,
    }));

    expect(cleanupError.work.status).toBe('EXECUTION_FAILED');
    expectReason(cleanupError.work, 'EXECUTION_FAILED', 'hostile-close work failed');
    expect(cleanupError.lifecycle).toEqual({
      status: 'NON_TERMINAL',
      reason: 'OWNER_CLOSE_FAILED',
      reasonDetail: 'Interaction error could not be safely normalized',
    });
    expect(cleanupError.work.evidence.before?.candidateId).toBe(candidate.candidateId);
    expect(closeCalls).toBe(2);
    expect(cleanupError.safety.invariantViolations.filter(
      ({ code }) => code === 'INTERACTION_OWNER_CLOSE_FAILED',
    )).toHaveLength(2);
  });

  it('preserves changed evidence when click failure and owner close both fail', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    let expanded = false;
    let closeCalls = 0;
    const rawCandidate = () => ({
      ordinal: candidate.ordinal,
      tagName: candidate.tagName,
      role: candidate.role,
      accessibleName: candidate.accessibleName,
      normalizedText: 'Toggle details',
      ariaExpanded: expanded ? 'true' : 'false',
      ariaControls: candidate.ariaControls,
      ariaSelected: candidate.ariaSelected,
      controlledVisible: expanded,
      controlledHidden: !expanded,
      formAssociated: candidate.formAssociated,
      formMethod: candidate.formMethod,
      formAction: candidate.formAction,
      rawHref: candidate.href,
      documentUrl: `${server.origin}/accordion.html`,
      documentOrigin: server.origin,
      download: candidate.download,
      type: candidate.type,
      disabled: candidate.disabled,
      visible: candidate.visible,
      destructiveFacts: destructiveActionFactsOfNames([candidate.accessibleName]),
      boundingBox: candidate.boundingBox,
    });
    const page = {
      context: fakeGuardContext, goto: async () => undefined,
      evaluate: async (_callback: unknown, argument?: unknown) => (
        argument === undefined ? true : { candidates: [rawCandidate()], completeness: 'COMPLETE', domWorkUsed: 0 }
      ),
      evaluateHandle: async () => boundedResolutionEnvelope((await page.locator(INTERACTION_CANDIDATE_SELECTOR).nth(candidate.ordinal).elementHandle()) as never),
      locator: () => ({
        nth: () => ({
          elementHandle: async () => ({
            evaluate: async () => ({ status: 'CONNECTED', domWorkUsed: 0, raw: rawCandidate() }),
            click: async () => {
              expanded = true;
              throw new Error('original click failure');
            },
            dispose: async () => undefined,
          }),
        }),
      }),
    } as unknown as Page;
    const ledger = new SafetyLedger();
    const session: InteractionGuardedSession = {
      page: withScrollPreparation(page, candidate),
      ledger,
      activateInteractionFreeze: async () => undefined,
      ...fakeCloseLifecycle(async (): Promise<never> => {
        closeCalls += 1;
        throw new Error('fixture close failed');
      }),
    };

    const cleanupError = await expectOwnerCleanupError(auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => session,
    }));

    expect(cleanupError.work.status).toBe('EXECUTION_FAILED');
    expectReason(cleanupError.work, 'CLICK_FAILED', 'original click failure');
    expect(cleanupError.lifecycle).toEqual({
      status: 'NON_TERMINAL',
      reason: 'OWNER_CLOSE_FAILED',
      reasonDetail: 'fixture close failed',
    });
    expect(cleanupError.work.evidence.changedFields).toContain('ariaExpanded');
    expect(closeCalls).toBe(2);
    expect(cleanupError.safety.invariantViolations).toContainEqual({
      code: 'INTERACTION_OWNER_CLOSE_FAILED',
      message: 'fixture close failed',
    });
    expect(cleanupError.safety.invariantViolations.filter(
      ({ code }) => code === 'INTERACTION_OWNER_CLOSE_FAILED',
    )).toHaveLength(2);
  });

  it('lets a freeze event recorded during owner close override a verified work outcome', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    let expanded = false;
    const rawCandidate = () => ({
      ordinal: candidate.ordinal,
      tagName: candidate.tagName,
      role: candidate.role,
      accessibleName: candidate.accessibleName,
      normalizedText: 'Toggle details',
      ariaExpanded: expanded ? 'true' : 'false',
      ariaControls: candidate.ariaControls,
      ariaSelected: candidate.ariaSelected,
      controlledVisible: expanded,
      controlledHidden: !expanded,
      formAssociated: candidate.formAssociated,
      formMethod: candidate.formMethod,
      formAction: candidate.formAction,
      rawHref: candidate.href,
      documentUrl: `${server.origin}/accordion.html`,
      documentOrigin: server.origin,
      download: candidate.download,
      type: candidate.type,
      disabled: candidate.disabled,
      visible: candidate.visible,
      destructiveFacts: destructiveActionFactsOfNames([candidate.accessibleName]),
      boundingBox: candidate.boundingBox,
    });
    const page = {
      context: fakeGuardContext, goto: async () => undefined,
      evaluate: async (_callback: unknown, argument?: unknown) => (
        argument === undefined ? true : { candidates: [rawCandidate()], completeness: 'COMPLETE', domWorkUsed: 0 }
      ),
      evaluateHandle: async () => boundedResolutionEnvelope((await page.locator(INTERACTION_CANDIDATE_SELECTOR).nth(candidate.ordinal).elementHandle()) as never),
      locator: () => ({
        nth: () => ({
          elementHandle: async () => ({
            evaluate: async () => ({ status: 'CONNECTED', domWorkUsed: 0, raw: rawCandidate() }),
            click: async () => { expanded = true; },
            dispose: async () => undefined,
          }),
        }),
      }),
    } as unknown as Page;
    const ledger = new SafetyLedger();
    let closed = false;
    const session: InteractionGuardedSession & { readonly isClosed: () => boolean } = {
      page: withScrollPreparation(page, candidate),
      ledger,
      activateInteractionFreeze: async () => undefined,
      isClosed: () => closed,
      close: async () => {
        ledger.recordBlockedInteractionRequest({
          method: 'GET',
          url: `${server.origin}/late`,
          reason: 'INTERACTION_FROZEN',
        });
        closed = true;
      },
    };

    const result = await auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => session,
    });

    expect(result.status).toBe('BLOCKED_BY_SAFETY');
    expectReason(result, 'SAFETY_FREEZE_BLOCKED');
    expect(expectedStructuredResult(result).work.status).toBe('VERIFIED');
    expect(expectedStructuredResult(result).lifecycle).toEqual({ status: 'CLOSED', reason: null, reasonDetail: null });
    expect(result.evidence.changedFields).toContain('ariaExpanded');
    expect(result.safety.blockedInteractionRequests).toHaveLength(1);
  });

  it('lets freeze evidence outrank an owner close rejection', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    let expanded = false;
    let closeCalls = 0;
    const rawCandidate = () => ({
      ordinal: candidate.ordinal,
      tagName: candidate.tagName,
      role: candidate.role,
      accessibleName: candidate.accessibleName,
      normalizedText: 'Toggle details',
      ariaExpanded: expanded ? 'true' : 'false',
      ariaControls: candidate.ariaControls,
      ariaSelected: candidate.ariaSelected,
      controlledVisible: expanded,
      controlledHidden: !expanded,
      formAssociated: candidate.formAssociated,
      formMethod: candidate.formMethod,
      formAction: candidate.formAction,
      rawHref: candidate.href,
      documentUrl: `${server.origin}/accordion.html`,
      documentOrigin: server.origin,
      download: candidate.download,
      type: candidate.type,
      disabled: candidate.disabled,
      visible: candidate.visible,
      destructiveFacts: destructiveActionFactsOfNames([candidate.accessibleName]),
      boundingBox: candidate.boundingBox,
    });
    const page = {
      context: fakeGuardContext, goto: async () => undefined,
      evaluate: async (_callback: unknown, argument?: unknown) => (
        argument === undefined ? true : { candidates: [rawCandidate()], completeness: 'COMPLETE', domWorkUsed: 0 }
      ),
      evaluateHandle: async () => boundedResolutionEnvelope((await page.locator(INTERACTION_CANDIDATE_SELECTOR).nth(candidate.ordinal).elementHandle()) as never),
      locator: () => ({
        nth: () => ({
          elementHandle: async () => ({
            evaluate: async () => ({ status: 'CONNECTED', domWorkUsed: 0, raw: rawCandidate() }),
            click: async () => { expanded = true; },
            dispose: async () => undefined,
          }),
        }),
      }),
    } as unknown as Page;
    const ledger = new SafetyLedger();
    const session: InteractionGuardedSession & { readonly isClosed: () => boolean } = {
      page: withScrollPreparation(page, candidate),
      ledger,
      activateInteractionFreeze: async () => undefined,
      isClosed: () => false,
      close: async (): Promise<never> => {
        closeCalls += 1;
        ledger.recordBlockedInteractionRequest({
          method: 'GET',
          url: `${server.origin}/late-before-close-rejection`,
          reason: 'INTERACTION_FROZEN',
        });
        throw new Error('freeze owner close failed');
      },
    };

    const cleanupError = await expectOwnerCleanupError(auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => session,
    }));

    expect(cleanupError.work.status).toBe('VERIFIED');
    expect(cleanupError.lifecycle).toEqual({ status: 'NON_TERMINAL', reason: 'OWNER_CLOSE_FAILED', reasonDetail: 'freeze owner close failed' });
    expect(cleanupError.work.evidence.changedFields).toContain('ariaExpanded');
    expect(closeCalls).toBe(2);
    expect(cleanupError.safety.blockedInteractionRequests).toHaveLength(2);
    expect(cleanupError.safety.invariantViolations.filter(
      ({ code }) => code === 'INTERACTION_OWNER_CLOSE_FAILED',
    )).toHaveLength(2);
  });

  it('lets a freeze event recorded during owner close override a rejected-unsafe outcome', async () => {
    const candidate = await candidateNamed('/post-form.html', 'Submit');
    const sessionFactory = async (sessionViewport: Viewport): Promise<InteractionGuardedSession> => {
      const session = await factory.createInteractionSession(sessionViewport);
      return Object.freeze({
        ...session,
        async close(): Promise<void> {
          session.ledger.recordBlockedInteractionRequest({
            method: 'GET',
            url: `${server.origin}/late-after-rejection`,
            reason: 'INTERACTION_FROZEN',
          });
          await session.close();
        },
      });
    };

    const result = await auditInteraction({ ...input('/post-form.html', candidate), sessionFactory });

    expect(result.status).toBe('BLOCKED_BY_SAFETY');
    expectReason(result, 'SAFETY_FREEZE_BLOCKED');
    expect(expectedStructuredResult(result).work.status).toBe('REJECTED_UNSAFE');
    expect(expectedStructuredResult(result).lifecycle).toEqual({ status: 'CLOSED', reason: null, reasonDetail: null });
    expect(result.evidence.identityStatus).toBe('MATCHED');
    expect(result.safety.blockedInteractionRequests).toHaveLength(1);
  });

  it('preserves click-failure status, reason, and observed evidence when handle disposal fails', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    let expanded = false;
    let disposeCalls = 0;
    const rawCandidate = () => ({
      ordinal: candidate.ordinal,
      tagName: candidate.tagName,
      role: candidate.role,
      accessibleName: candidate.accessibleName,
      normalizedText: 'Toggle details',
      ariaExpanded: expanded ? 'true' : 'false',
      ariaControls: candidate.ariaControls,
      ariaSelected: candidate.ariaSelected,
      controlledVisible: expanded,
      controlledHidden: !expanded,
      formAssociated: candidate.formAssociated,
      formMethod: candidate.formMethod,
      formAction: candidate.formAction,
      rawHref: candidate.href,
      documentUrl: `${server.origin}/accordion.html`,
      documentOrigin: server.origin,
      download: candidate.download,
      type: candidate.type,
      disabled: candidate.disabled,
      visible: candidate.visible,
      destructiveFacts: destructiveActionFactsOfNames([candidate.accessibleName]),
      boundingBox: candidate.boundingBox,
    });
    const page = {
      context: fakeGuardContext, goto: async () => undefined,
      evaluate: async (_callback: unknown, argument?: unknown) => (
        argument === undefined ? true : { candidates: [rawCandidate()], completeness: 'COMPLETE', domWorkUsed: 0 }
      ),
      evaluateHandle: async () => boundedResolutionEnvelope((await page.locator(INTERACTION_CANDIDATE_SELECTOR).nth(candidate.ordinal).elementHandle()) as never),
      locator: () => ({
        nth: () => ({
          elementHandle: async () => ({
            evaluate: async () => ({ status: 'CONNECTED', domWorkUsed: 0, raw: rawCandidate() }),
            click: async () => {
              expanded = true;
              throw new Error('original click failure');
            },
            dispose: async (): Promise<never> => {
              disposeCalls += 1;
              throw new Error('handle dispose failure');
            },
          }),
        }),
      }),
    } as unknown as Page;
    const ledger = new SafetyLedger();
    const result = await auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => ({
        page: withScrollPreparation(page, candidate),
        ledger,
        activateInteractionFreeze: async () => undefined,
        ...fakeCloseLifecycle(),
      }),
    });

    expect(result.status).toBe('EXECUTION_FAILED');
    expectReason(result, 'CLICK_FAILED', 'original click failure');
    expect(result.evidence.changedFields).toContain('ariaExpanded');
    expect(disposeCalls).toBe(1);
    expect(result.safety.invariantViolations).toContainEqual({
      code: 'INTERACTION_HANDLE_DISPOSE_FAILED',
      message: 'handle dispose failure',
    });
    expect(result.safety.invariantViolations.filter(
      ({ code }) => code === 'INTERACTION_HANDLE_DISPOSE_FAILED',
    )).toHaveLength(1);
  });

  it('preserves safety status and observed evidence when handle disposal fails', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    const ledger = new SafetyLedger();
    let expanded = false;
    let disposeCalls = 0;
    let handleEvaluations = 0;
    const rawCandidate = () => ({
      ordinal: candidate.ordinal,
      tagName: candidate.tagName,
      role: candidate.role,
      accessibleName: candidate.accessibleName,
      normalizedText: 'Toggle details',
      ariaExpanded: expanded ? 'true' : 'false',
      ariaControls: candidate.ariaControls,
      ariaSelected: candidate.ariaSelected,
      controlledVisible: expanded,
      controlledHidden: !expanded,
      formAssociated: candidate.formAssociated,
      formMethod: candidate.formMethod,
      formAction: candidate.formAction,
      rawHref: candidate.href,
      documentUrl: `${server.origin}/accordion.html`,
      documentOrigin: server.origin,
      download: candidate.download,
      type: candidate.type,
      disabled: candidate.disabled,
      visible: candidate.visible,
      destructiveFacts: destructiveActionFactsOfNames([candidate.accessibleName]),
      boundingBox: candidate.boundingBox,
    });
    const page = {
      context: fakeGuardContext, goto: async () => undefined,
      evaluate: async (_callback: unknown, argument?: unknown) => (
        argument === undefined ? true : { candidates: [rawCandidate()], completeness: 'COMPLETE', domWorkUsed: 0 }
      ),
      evaluateHandle: async () => boundedResolutionEnvelope((await page.locator(INTERACTION_CANDIDATE_SELECTOR).nth(candidate.ordinal).elementHandle()) as never),
      locator: () => ({
        nth: () => ({
          elementHandle: async () => ({
            evaluate: async () => {
              handleEvaluations += 1;
              if (handleEvaluations === 2) {
                ledger.recordBlockedInteractionRequest({
                  method: 'GET',
                  url: `${server.origin}/blocked-during-observation`,
                  reason: 'INTERACTION_FROZEN',
                });
              }
              return { status: 'CONNECTED', domWorkUsed: 0, raw: rawCandidate() };
            },
            click: async () => { expanded = true; },
            dispose: async (): Promise<never> => {
              disposeCalls += 1;
              throw new Error('safety handle dispose failure');
            },
          }),
        }),
      }),
    } as unknown as Page;
    const result = await auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => ({
        page: withScrollPreparation(page, candidate),
        ledger,
        activateInteractionFreeze: async () => undefined,
        ...fakeCloseLifecycle(),
      }),
    });

    expect(result.status).toBe('BLOCKED_BY_SAFETY');
    expectReason(result, 'SAFETY_FREEZE_BLOCKED');
    expect(result.evidence.changedFields).toContain('ariaExpanded');
    expect(disposeCalls).toBe(1);
    expect(result.safety.invariantViolations).toContainEqual({
      code: 'INTERACTION_HANDLE_DISPOSE_FAILED',
      message: 'safety handle dispose failure',
    });
    expect(result.safety.invariantViolations.filter(
      ({ code }) => code === 'INTERACTION_HANDLE_DISPOSE_FAILED',
    )).toHaveLength(1);
  });

  it('preserves a work error and separately ledgers disposal failure when no outcome exists', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    const ledger = new SafetyLedger();
    let disposeCalls = 0;
    let handleEvaluations = 0;
    const rawCandidate = {
      ordinal: candidate.ordinal,
      tagName: candidate.tagName,
      role: candidate.role,
      accessibleName: candidate.accessibleName,
      normalizedText: 'Toggle details',
      ariaExpanded: candidate.ariaExpanded,
      ariaControls: candidate.ariaControls,
      ariaSelected: candidate.ariaSelected,
      controlledVisible: candidate.controlledVisible,
      controlledHidden: candidate.controlledHidden,
      formAssociated: candidate.formAssociated,
      formMethod: candidate.formMethod,
      formAction: candidate.formAction,
      rawHref: candidate.href,
      documentUrl: `${server.origin}/accordion.html`,
      documentOrigin: server.origin,
      download: candidate.download,
      type: candidate.type,
      disabled: candidate.disabled,
      visible: candidate.visible,
      destructiveFacts: destructiveActionFactsOfNames([candidate.accessibleName]),
      boundingBox: candidate.boundingBox,
    };
    const page = {
      context: fakeGuardContext, goto: async () => undefined,
      evaluate: async (_callback: unknown, argument?: unknown) => (
        argument === undefined ? true : { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 0 }
      ),
      evaluateHandle: async () => boundedResolutionEnvelope((await page.locator(INTERACTION_CANDIDATE_SELECTOR).nth(candidate.ordinal).elementHandle()) as never),
      locator: () => ({
        nth: () => ({
          elementHandle: async () => ({
            evaluate: async () => {
              handleEvaluations += 1;
              if (handleEvaluations === 2) {
                throw new Error('original observation failure');
              }
              return { status: 'CONNECTED', domWorkUsed: 0, raw: rawCandidate };
            },
            click: async () => undefined,
            dispose: async (): Promise<never> => {
              disposeCalls += 1;
              throw new Error('observation handle dispose failure');
            },
          }),
        }),
      }),
    } as unknown as Page;
    const result = await auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => ({
        page: withScrollPreparation(page, candidate),
        ledger,
        activateInteractionFreeze: async () => undefined,
        ...fakeCloseLifecycle(),
      }),
    });

    expect(result.status).toBe('EXECUTION_FAILED');
    expectReason(result, 'EXECUTION_FAILED', 'original observation failure');
    expect(disposeCalls).toBe(1);
    expect(result.safety.invariantViolations).toContainEqual({
      code: 'INTERACTION_HANDLE_DISPOSE_FAILED',
      message: 'observation handle dispose failure',
    });
    expect(result.safety.invariantViolations.filter(
      ({ code }) => code === 'INTERACTION_HANDLE_DISPOSE_FAILED',
    )).toHaveLength(1);
  });

  describe('Task 11 cleanup deadline and interaction-wide DOM budget', () => {
    it('bounds a never-settling real Guard close by one cleanup deadline and one raw close owner', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const rawCloseGate = createDeferred<void>();
      const unhandled: unknown[] = [];
      const observeUnhandled = (reason: unknown) => { unhandled.push(reason); };
      process.on('unhandledRejection', observeUnhandled);
      let capturedSession: InteractionGuardedSession | undefined;
      let rawCloseCalls = 0;
      let auditCloseCalls = 0;
      // Q4: 判定枠から実ブラウザのセッション生成時間を除くため、セッションを渡した時刻から測る。
      const sessionReady = createDeferred<number>();
      let completion: Promise<Awaited<ReturnType<typeof auditInteraction>>> | undefined;
      try {
        completion = auditInteraction({
          ...input('/accordion.html', candidate),
          timeoutMs: 80,
          sessionFactory: async (sessionViewport) => {
            const owned = await factory.createInteractionSession(sessionViewport);
            const context = owned.page.context();
            const rawClose = context.close.bind(context);
            vi.spyOn(context, 'close').mockImplementation(async () => {
              rawCloseCalls += 1;
              await rawCloseGate.promise;
              await rawClose();
            });
            const session: InteractionGuardedSession = Object.freeze({
              ...owned,
              page: { context: fakeGuardContext, goto: async (): Promise<never> => { throw new Error('deadline fixture work'); } } as unknown as Page,
              close: async () => {
                auditCloseCalls += 1;
                await owned.close();
              },
            });
            capturedSession = session;
            sessionReady.resolve(Date.now());
            return session;
          },
        });
        const readyAt = await sessionReady.promise;
        const observed = await Promise.race([
          completion.catch((error: unknown) => error),
          new Promise<'STILL_PENDING'>((resolve) => setTimeout(() => resolve('STILL_PENDING'), 240)),
        ]);
        expect(observed).toBeInstanceOf(InteractionOwnerCleanupError);
        const cleanupError = observed as InteractionOwnerCleanupError;
        expect(cleanupError.session).toBe(capturedSession);
        expect(cleanupError.cleanup).toMatchObject({
          kind: 'DEADLINE_EXCEEDED',
          attemptsStarted: 2,
          deadlineReached: true,
          anomaly: 'TIMED_OUT',
          lastCloseRejected: false,
        });
        expect(Object.isFrozen(cleanupError.cleanup)).toBe(true);
        expect(cleanupError.cleanup.deadlineAtMs).toBeGreaterThanOrEqual(readyAt + 80);
        expect(Date.now() - readyAt).toBeLessThan(240);
        expect(auditCloseCalls).toBe(2);
        expect(rawCloseCalls).toBe(1);
        expect(cleanupError.safety.invariantViolations).toContainEqual(expect.objectContaining({
          code: 'INTERACTION_OWNER_CLEANUP_DEADLINE_EXCEEDED',
        }));
      } finally {
        rawCloseGate.resolve();
        await completion?.catch(() => undefined);
        await wait(0);
        process.off('unhandledRejection', observeUnhandled);
      }
      expect(unhandled).toEqual([]);
    });

    it('rechecks terminal Guard truth after the timeout macrotask yield before a second close call', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const closeGate = createDeferred<void>();
      let closeCalls = 0;
      let closed = false;
      let terminalTransitionScheduled = false;
      const session: InteractionGuardedSession = {
        page: { context: fakeGuardContext, goto: async (): Promise<never> => { throw new Error('timeout yield work'); } } as unknown as Page,
        ledger: new SafetyLedger(),
        activateInteractionFreeze: async () => undefined,
        close: async () => {
          closeCalls += 1;
          await closeGate.promise;
        },
        isClosed: () => {
          if (!closed && !terminalTransitionScheduled) {
            terminalTransitionScheduled = true;
            setTimeout(() => { closed = true; }, 0);
          }
          return closed;
        },
      };
      let completion: Promise<Awaited<ReturnType<typeof auditInteraction>>> | undefined;
      try {
        completion = auditInteraction({
          ...input('/accordion.html', candidate),
          timeoutMs: 60,
          sessionFactory: async () => session,
        });
        const observed = await Promise.race([
          completion,
          new Promise<'STILL_PENDING'>((resolve) => setTimeout(() => resolve('STILL_PENDING'), 180)),
        ]);
        expect(observed).not.toBe('STILL_PENDING');
        expect(closeCalls).toBe(1);
        expect((observed as Awaited<ReturnType<typeof auditInteraction>>).lifecycle).toEqual({
          status: 'CLOSED',
          reason: 'OWNER_CLOSE_TIMED_OUT',
          reasonDetail: null,
        });
      } finally {
        closed = true;
        closeGate.resolve();
        await completion?.catch(() => undefined);
      }
    });

    it('yields a macrotask after rejected non-terminal close so delayed terminal settlement suppresses retry', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      let closeCalls = 0;
      let closed = false;
      let transitionScheduled = false;
      const session: InteractionGuardedSession = {
        page: { context: fakeGuardContext, goto: async (): Promise<never> => { throw new Error('rejected yield work'); } } as unknown as Page,
        ledger: new SafetyLedger(),
        activateInteractionFreeze: async () => undefined,
        close: async (): Promise<never> => {
          closeCalls += 1;
          throw new Error('rejected before yield');
        },
        isClosed: () => {
          if (!closed && !transitionScheduled) {
            transitionScheduled = true;
            setTimeout(() => { closed = true; }, 0);
          }
          return closed;
        },
      };

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        timeoutMs: 200,
        sessionFactory: async () => session,
      });

      expect(closeCalls).toBe(1);
      expect(result.status).toBe('BLOCKED_BY_SAFETY');
      expect(result.lifecycle).toEqual({ status: 'CLOSED', reason: 'OWNER_CLOSE_FAILED', reasonDetail: 'rejected before yield' });
    });

    it('contains an undefined rejection observed after first-half timeout and exposes it in cleanup diagnostics', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      let rejectClose!: (reason?: unknown) => void;
      const closePromise = new Promise<void>((_resolve, reject) => { rejectClose = reject; });
      let closeCalls = 0;
      const unhandled: unknown[] = [];
      const observeUnhandled = (reason: unknown) => { unhandled.push(reason); };
      const session: InteractionGuardedSession = {
        page: { context: fakeGuardContext, goto: async (): Promise<never> => { throw new Error('late rejection work'); } } as unknown as Page,
        ledger: new SafetyLedger(),
        activateInteractionFreeze: async () => undefined,
        close: () => {
          closeCalls += 1;
          // Q4: 1回目の前半の期限切れの後（2回目の呼び出しの後）にだけ reject するので、順序が入れ替わらない。
          if (closeCalls === 2) setTimeout(() => rejectClose(undefined), 0);
          return closePromise;
        },
        isClosed: () => false,
      };

      process.on('unhandledRejection', observeUnhandled);
      let cleanupError: InteractionOwnerCleanupError;
      try {
        cleanupError = await expectOwnerCleanupError(auditInteraction({
          ...input('/accordion.html', candidate),
          timeoutMs: 400,
          sessionFactory: async () => session,
        }));
        await wait(0);
      } finally {
        process.off('unhandledRejection', observeUnhandled);
      }

      expect(unhandled).toEqual([]);
      expect(closeCalls).toBe(2);
      // 前半の期限切れ（TIMED_OUT）が先に記録され、その後の reject（CLOSE_FAILED）が最新の異常になる。
      expect(cleanupError.safety.invariantViolations.map(({ code }) => code)).toEqual([
        'INTERACTION_OWNER_CLOSE_TIMED_OUT',
        'INTERACTION_OWNER_CLOSE_FAILED',
        'INTERACTION_OWNER_CLEANUP_RETRY_EXHAUSTED',
      ]);
      expect(cleanupError.cleanup).toMatchObject({
        kind: 'ATTEMPT_BUDGET_EXHAUSTED',
        attemptsStarted: 2,
        deadlineReached: false,
        anomaly: 'REJECTED',
        lastCloseRejected: true,
      });
      expect(Object.hasOwn(cleanupError.cleanup, 'lastCloseError')).toBe(true);
      expect(cleanupError.cleanup.lastCloseError).toBeUndefined();
      expect(cleanupError.lastCloseRejected).toBe(true);
      expect(cleanupError.lastCloseError).toBeUndefined();
    });

    // SPEC-5: 1 回の audit で共有する DOM の作業量（`maxDomWork`）はやめたので、その 3 件は消した。読み取りの部品の作業量の上限（テストが注入する）は、
    // 発見の側の部品に残るので、0 の場面だけを残す。
    it('returns budget-reached from every DOM operation at zero without browser traversal', async () => {
      const page = {
        evaluate: async (): Promise<never> => { throw new Error('zero budget must not evaluate'); },
        evaluateHandle: async (): Promise<never> => { throw new Error('zero budget must not evaluateHandle'); },
      } as unknown as Page;
      const handle = {
        evaluate: async (): Promise<never> => { throw new Error('zero budget must not inspect'); },
      } as unknown as Parameters<typeof inspectInteractionCandidateHandle>[0];
      const settlements = await Promise.allSettled([
        discoverInteractionCandidates(page, 0),
        resolveInteractionCandidateHandle(page, 0, 0),
        inspectInteractionCandidateHandle(handle, 0, 0),
      ]);

      expect(settlements).toEqual([
        { status: 'fulfilled', value: { candidates: [], completeness: 'DOM_WORK_BUDGET_REACHED', domWorkUsed: 0 } },
        { status: 'fulfilled', value: { status: 'DOM_WORK_BUDGET_REACHED', domWorkUsed: 0 } },
        { status: 'fulfilled', value: { status: 'DOM_WORK_BUDGET_REACHED', domWorkUsed: 0 } },
      ]);
    });
  });
});
}

/**
 * TS-c: C3 の是正のテストを登録する（`isolated-interaction-corrections.test.ts` が呼ぶ）。本文は、分ける前の位置と字下げのまま。
 * SLIM BD-5: SPEC-5 の後は F16 R5 の組も軽い（2026-11-15 の測りで 12 秒）ので、前の `isolated-interaction-evidence.test.ts` の組と 1 つにした
 * （前の組の分かれ目は、字下げを保つために、ただの block のまま残す）。
 */
export function registerC3CorrectionCases(): void {
describe('C3 corrections (foundation corrections design 4.2-4.8, 5.5)', () => {
  function toggledRawCandidate(candidate: InteractionCandidate) {
    return {
      ...rawCandidateFor(candidate),
      ariaExpanded: 'true',
      controlledVisible: true,
      controlledHidden: false,
    };
  }

  /** 決着しない場合に、テストのタイムアウトではなく検証の失敗として扱えるよう、枠の時間だけ待つ。 */
  async function settleWithin<T>(promise: Promise<T>, frameMs: number): Promise<T | 'STILL_PENDING'> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<'STILL_PENDING'>((resolve) => { timer = setTimeout(() => resolve('STILL_PENDING'), frameMs); }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** 候補の探索・解決・観測を偽のページで行い、click の後に ariaExpanded が変わるセッションを作る。 */
  function fakeToggleSession(
    candidate: InteractionCandidate,
    hooks: {
      readonly ledger: SafetyLedger;
      readonly onGoto?: () => void;
      readonly onClick?: () => void;
    },
  ): InteractionGuardedSession {
    const rawCandidate = rawCandidateFor(candidate);
    const snapshots = [
      { status: 'CONNECTED', domWorkUsed: 10, raw: rawCandidate },
      { status: 'CONNECTED', domWorkUsed: 10, raw: toggledRawCandidate(candidate) },
    ];
    let snapshotIndex = 0;
    const targetHandle = {
      evaluate: async () => snapshots[Math.min(snapshotIndex++, snapshots.length - 1)],
      click: async () => { hooks.onClick?.(); },
      dispose: async () => undefined,
    };
    const page = {
      context: fakeGuardContext, goto: async () => { hooks.onGoto?.(); },
      evaluate: async (_callback: unknown, argument?: unknown) => (
        argument === undefined ? true : { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 20 }
      ),
      evaluateHandle: async () => boundedResolutionEnvelope(targetHandle),
    } as unknown as Page;
    return {
      page: withScrollPreparation(page, candidate),
      ledger: hooks.ledger,
      activateInteractionFreeze: async () => undefined,
      ...fakeCloseLifecycle(),
    };
  }

  {
  describe('C2 follow-up: only frozen-phase downloads block the interaction', () => {
    it('keeps VERIFIED work when the only download was recorded in the Passive phase', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const ledger = new SafetyLedger();
      const session = fakeToggleSession(candidate, {
        ledger,
        onGoto: () => ledger.recordBlockedDownload({
          url: 'data:text/plain,passive-fixture-download',
          suggestedFilename: 'passive-fixture.txt',
          reason: 'PASSIVE_DOWNLOAD',
        }),
      });

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        sessionFactory: async () => session,
      });

      expect(result.status).toBe('VERIFIED');
      expect(result.work.status).toBe('VERIFIED');
      expect(result.safety.blockedDownloads).toEqual([{
        url: 'data:text/plain,passive-fixture-download',
        suggestedFilename: 'passive-fixture.txt',
        reason: 'PASSIVE_DOWNLOAD',
      }]);
    });

    it('still blocks the interaction for a download recorded after freeze', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const ledger = new SafetyLedger();
      const session = fakeToggleSession(candidate, {
        ledger,
        onClick: () => ledger.recordBlockedDownload({
          url: 'data:text/plain,frozen-fixture-download',
          suggestedFilename: 'frozen-fixture.txt',
          reason: 'INTERACTION_FROZEN',
        }),
      });

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        sessionFactory: async () => session,
      });

      expect(result.status).toBe('BLOCKED_BY_SAFETY');
      expect(result.work.status).toBe('BLOCKED_BY_SAFETY');
    });

    it('verifies a real toggle after the page downloaded during the Passive phase and ledgers that download', async () => {
      const candidate = await candidateNamed('/passive-download-toggle.html', 'Toggle after passive download');
      server.resetCounters();

      const result = await auditInteraction(input('/passive-download-toggle.html', candidate));

      expect(result.status, JSON.stringify(result)).toBe('VERIFIED');
      expect(result.safety.blockedDownloads).toEqual([expect.objectContaining({
        suggestedFilename: 'passive-fixture.txt',
        reason: 'PASSIVE_DOWNLOAD',
      })]);
      expect(server.getCounters()).toMatchObject({ post: 0, download: 0 });
    });
  });

  describe('I3: cleanup retry yield after a fulfilled non-terminal close', () => {
    it('yields a macrotask after fulfilled non-terminal close so delayed terminal settlement suppresses retry', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      let closeCalls = 0;
      let closed = false;
      let transitionScheduled = false;
      const session: InteractionGuardedSession = {
        page: { context: fakeGuardContext, goto: async (): Promise<never> => { throw new Error('fulfilled yield work'); } } as unknown as Page,
        ledger: new SafetyLedger(),
        activateInteractionFreeze: async () => undefined,
        close: async () => { closeCalls += 1; },
        isClosed: () => {
          if (!closed && !transitionScheduled) {
            transitionScheduled = true;
            setTimeout(() => { closed = true; }, 0);
          }
          return closed;
        },
      };

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        timeoutMs: 200,
        sessionFactory: async () => session,
      });

      expect(closeCalls).toBe(1);
      expect(result.status).toBe('BLOCKED_BY_SAFETY');
      expect(result.lifecycle).toEqual({
        status: 'CLOSED',
        reason: 'OWNER_CLOSE_NON_TERMINAL',
        reasonDetail: null,
      });
      expect(result.safety.invariantViolations.map(({ code }) => code)).toEqual([
        'INTERACTION_OWNER_CLOSE_NON_TERMINAL',
      ]);
    });
  });

  describe('Q1: work-phase browser evaluations are bounded by the effective deadline', () => {
    it('finishes with NOT_VERIFIABLE work when the page main thread never yields after freeze', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const unhandled: unknown[] = [];
      const observeUnhandled = (reason: unknown) => { unhandled.push(reason); };
      process.on('unhandledRejection', observeUnhandled);
      const sessionReady = createDeferred<number>();
      let owned: InteractionGuardedSession | undefined;
      const timeoutMs = 1_000;
      let completion: Promise<Awaited<ReturnType<typeof auditInteraction>>> | undefined;
      let observed: unknown = 'NOT_STARTED';
      try {
        completion = auditInteraction({
          ...input('/accordion.html', candidate),
          timeoutMs,
          deadlineAtMs: Date.now() + 60_000,
          sessionFactory: async (sessionViewport) => {
            const session = await factory.createInteractionSession(sessionViewport);
            owned = session;
            sessionReady.resolve(Date.now());
            return Object.freeze({
              ...session,
              activateInteractionFreeze: async () => {
                await session.activateInteractionFreeze();
                // 品質レビュー Q1 の実測条件: setTimeout(() => { while (true) {} }) でメインスレッドを止める。
                await session.page.evaluate(() => {
                  setTimeout(() => {
                    while (true) { /* busy loop */ }
                  }, 0);
                });
              },
            });
          },
        });
        const readyAt = await sessionReady.promise;
        // 作業の期限（timeoutMs）とクリーンアップの期限（timeoutMs）の合計に、余裕を足した枠。
        const frameMs = timeoutMs * 2 + 1_000;
        observed = await Promise.race([
          completion.catch((error: unknown) => error),
          new Promise<'STILL_PENDING'>((resolve) => setTimeout(() => resolve('STILL_PENDING'), frameMs)),
        ]);
        expect(observed).not.toBe('STILL_PENDING');
        expect(Date.now() - readyAt).toBeLessThan(frameMs);
        const work = observed instanceof InteractionOwnerCleanupError
          ? observed.work
          : (observed as Awaited<ReturnType<typeof auditInteraction>>).work;
        expect(work.status).toBe('NOT_VERIFIABLE');
        // C18n: 期限切れの理由のコード（以前の英文が「deadline expired」を含んでいたもの）。
        expect([
          'SESSION_OPEN_DEADLINE',
          'INITIAL_LOAD_BEFORE_LOAD',
          'INITIAL_LOAD_DURING_LOAD',
          'INITIAL_LOAD_AFTER_LOAD',
          'INITIAL_LOAD_BEFORE_RENDER',
          'SCROLL_PREPARATION_DEADLINE',
          'DEADLINE_BEFORE_EXACT_NODE_CLICK',
          'DEADLINE_DURING_POST_CONDITION_OBSERVATION',
        ]).toContain(work.reason);
        expect(work.reasonDetail).toBeNull();
      } finally {
        if (observed === 'STILL_PENDING' || observed instanceof InteractionOwnerCleanupError) {
          await owned?.page.context().close().catch(() => undefined);
        }
        await completion?.catch(() => undefined);
        await wait(0);
        process.off('unhandledRejection', observeUnhandled);
      }
      expect(unhandled).toEqual([]);
    }, 30_000);

    it('finishes the post-click observation and handle disposal when the click starts a never-yielding loop', async () => {
      const candidate = await candidateNamed('/busy-loop-button.html', 'Start busy loop');
      const unhandled: unknown[] = [];
      const observeUnhandled = (reason: unknown) => { unhandled.push(reason); };
      process.on('unhandledRejection', observeUnhandled);
      const sessionReady = createDeferred<number>();
      let owned: InteractionGuardedSession | undefined;
      const timeoutMs = 1_000;
      let completion: Promise<Awaited<ReturnType<typeof auditInteraction>>> | undefined;
      let observed: unknown = 'NOT_STARTED';
      try {
        completion = auditInteraction({
          ...input('/busy-loop-button.html', candidate),
          timeoutMs,
          deadlineAtMs: Date.now() + 60_000,
          sessionFactory: async (sessionViewport) => {
            const session = await factory.createInteractionSession(sessionViewport);
            owned = session;
            sessionReady.resolve(Date.now());
            return session;
          },
        });
        const readyAt = await sessionReady.promise;
        const frameMs = timeoutMs * 2 + 1_000;
        observed = await settleWithin(completion.catch((error: unknown) => error), frameMs);
        expect(observed).not.toBe('STILL_PENDING');
        expect(Date.now() - readyAt).toBeLessThan(frameMs);
        const work = observed instanceof InteractionOwnerCleanupError
          ? observed.work
          : (observed as Awaited<ReturnType<typeof auditInteraction>>).work;
        expect(work.status).not.toBe('VERIFIED');
        expect(['NOT_VERIFIABLE', 'EXECUTION_FAILED']).toContain(work.status);
      } finally {
        if (observed === 'STILL_PENDING' || observed instanceof InteractionOwnerCleanupError) {
          await owned?.page.context().close().catch(() => undefined);
        }
        await completion?.catch(() => undefined);
        await wait(0);
        process.off('unhandledRejection', observeUnhandled);
      }
      expect(unhandled).toEqual([]);
    }, 30_000);

    it('contains a late rejection of an abandoned discovery evaluation', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const unhandled: unknown[] = [];
      const observeUnhandled = (reason: unknown) => { unhandled.push(reason); };
      process.on('unhandledRejection', observeUnhandled);
      const lateDiscovery = createDeferred<never>();
      let discoveryCalls = 0;
      try {
        const page = {
          context: fakeGuardContext, goto: async () => undefined,
          evaluate: async (_callback: unknown, argument?: unknown) => {
            if (argument === undefined) return true;
            discoveryCalls += 1;
            return lateDiscovery.promise;
          },
        } as unknown as Page;

        const settled = await settleWithin(auditInteraction({
          ...input('/accordion.html', candidate),
          // 下準備を終えてから、確かめたい段階に進むよう、期限に余裕を持たせる。
          timeoutMs: 1_000,
          sessionFactory: async () => ({
            page: withScrollPreparation(page, candidate),
            ledger: new SafetyLedger(),
            activateInteractionFreeze: async () => undefined,
            ...fakeCloseLifecycle(),
          }),
        }), 3_000);
        expect(settled).not.toBe('STILL_PENDING');
        const result = settled as Awaited<ReturnType<typeof auditInteraction>>;

        expect(discoveryCalls).toBe(1);
        expect(result.status).toBe('NOT_VERIFIABLE');
        expectReason(result, 'DEADLINE_BEFORE_EXACT_NODE_CLICK');
        lateDiscovery.reject(new Error('late discovery rejection after deadline'));
        await wait(0);
        await wait(0);
      } finally {
        process.off('unhandledRejection', observeUnhandled);
      }
      expect(unhandled).toEqual([]);
    });

    it('disposes a retained handle whose resolution settles only after the deadline', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      let disposeCalls = 0;
      let clickCalls = 0;
      const lateResolution = createDeferred<unknown>();
      const targetHandle = {
        evaluate: async () => { throw new Error('late handle must not be inspected'); },
        click: async () => { clickCalls += 1; },
        dispose: async () => { disposeCalls += 1; },
      };
      const rawCandidate = rawCandidateFor(candidate);
      const page = {
        context: fakeGuardContext, goto: async () => undefined,
        evaluate: async (_callback: unknown, argument?: unknown) => (
          argument === undefined ? true : { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 20 }
        ),
        evaluateHandle: async () => lateResolution.promise,
      } as unknown as Page;

      const settled = await settleWithin(auditInteraction({
        ...input('/accordion.html', candidate),
        // 下準備を終えてから、確かめたい段階に進むよう、期限に余裕を持たせる。
        timeoutMs: 1_000,
        sessionFactory: async () => ({
          page: withScrollPreparation(page, candidate),
          ledger: new SafetyLedger(),
          activateInteractionFreeze: async () => undefined,
          ...fakeCloseLifecycle(),
        }),
      }), 3_000);
      expect(settled).not.toBe('STILL_PENDING');
      const result = settled as Awaited<ReturnType<typeof auditInteraction>>;

      expect(result.status).toBe('NOT_VERIFIABLE');
      expectReason(result, 'DEADLINE_BEFORE_EXACT_NODE_CLICK');
      lateResolution.resolve(boundedResolutionEnvelope(targetHandle));
      await expect.poll(() => disposeCalls).toBe(1);
      expect(clickCalls).toBe(0);
    });
  });

  describe('5.5: discovery visibility uses checkVisibility with the shared options', () => {
    it.each([
      ['a candidate under body{opacity:0}', '<style>body{opacity:0}</style><button type="button">Target</button>', false],
      [
        'a visibility:visible candidate under a visibility:hidden ancestor',
        '<div style="visibility:hidden"><button type="button" style="visibility:visible">Target</button></div>',
        true,
      ],
      [
        'a candidate under a stylesheet display:none ancestor',
        '<style>.gone{display:none}</style><div class="gone"><button type="button">Target</button></div>',
        false,
      ],
    ] as const)('classifies %s in discovery and retained inspection', async (_label, html, expectedVisible) => {
      const page = await browser.newPage();
      try {
        await page.setContent(html);
        const discovery = await discoverInteractionCandidates(page);
        expect(discovery.completeness).toBe('COMPLETE');
        expect(discovery.candidates.map(({ accessibleName, visible }) => [accessibleName, visible])).toEqual([
          ['Target', expectedVisible],
        ]);
        const handle = await page.locator('button').elementHandle();
        const handleReference = await candidateReferenceOf(page, 'button');
        if (handle === null) throw new Error('Missing visibility fixture candidate');
        try {
          await expect(inspectInteractionCandidateHandle(handleReference, 0)).resolves.toMatchObject({
            status: 'CONNECTED',
            candidate: { accessibleName: 'Target', visible: expectedVisible },
          });
        } finally {
          await handle.dispose();
        }
      } finally {
        await page.close();
      }
    });

    it.each([
      [
        'a controlled region under an opacity:0 ancestor',
        '<style>#panel-host{opacity:0}</style><button type="button" aria-controls="panel">Toggle</button><div id="panel-host"><div id="panel">Panel</div></div>',
        false,
      ],
      [
        'a visibility:visible controlled region under a visibility:hidden ancestor',
        '<button type="button" aria-controls="panel">Toggle</button><div style="visibility:hidden"><div id="panel" style="visibility:visible">Panel</div></div>',
        true,
      ],
      [
        'a controlled region under a stylesheet display:none ancestor',
        '<style>.gone{display:none}</style><button type="button" aria-controls="panel">Toggle</button><div class="gone"><div id="panel">Panel</div></div>',
        false,
      ],
    ] as const)('classifies %s in discovery and retained inspection', async (_label, html, expectedVisible) => {
      const page = await browser.newPage();
      try {
        await page.setContent(html);
        const discovery = await discoverInteractionCandidates(page);
        expect(discovery.candidates.map(({ controlledVisible, controlledHidden }) => [controlledVisible, controlledHidden]))
          .toEqual([[expectedVisible, !expectedVisible]]);
        const handle = await page.locator('button').elementHandle();
        const handleReference = await candidateReferenceOf(page, 'button');
        if (handle === null) throw new Error('Missing controlled visibility fixture candidate');
        try {
          await expect(inspectInteractionCandidateHandle(handleReference, 0)).resolves.toMatchObject({
            status: 'CONNECTED',
            candidate: { controlledVisible: expectedVisible, controlledHidden: !expectedVisible },
          });
        } finally {
          await handle.dispose();
        }
      } finally {
        await page.close();
      }
    });

    it('passes VISIBILITY_CHECK_OPTIONS to every checkVisibility call', async () => {
      const page = await browser.newPage();
      try {
        await page.setContent('<button type="button" aria-controls="panel">Toggle</button><div id="panel">Panel</div>');
        await evaluateInCandidateReadWorld(page, () => {
          const original = Element.prototype.checkVisibility;
          const calls: unknown[] = [];
          Element.prototype.checkVisibility = function checkVisibility(options?: CheckVisibilityOptions) {
            calls.push(options);
            return original.call(this, options);
          };
          Object.defineProperty(globalThis, '__checkVisibilityCalls', { configurable: true, get: () => calls });
        });
        const readCalls = () => evaluateInCandidateReadWorld(page, () => (
          globalThis as typeof globalThis & { readonly __checkVisibilityCalls: readonly unknown[] }
        ).__checkVisibilityCalls);

        const discovery = await discoverInteractionCandidates(page);
        expect(discovery.completeness).toBe('COMPLETE');
        // 探索では、制御対象と候補自身について1回ずつ呼ぶ。
        expect(await readCalls()).toEqual([VISIBILITY_CHECK_OPTIONS, VISIBILITY_CHECK_OPTIONS]);
        const handle = await page.locator('button').elementHandle();
        const handleReference = await candidateReferenceOf(page, 'button');
        if (handle === null) throw new Error('Missing option probe candidate');
        try {
          await expect(inspectInteractionCandidateHandle(handleReference, 0)).resolves.toMatchObject({ status: 'CONNECTED' });
          expect(await readCalls()).toEqual(Array.from({ length: 4 }, () => VISIBILITY_CHECK_OPTIONS));
        } finally {
          await handle.dispose();
        }
      } finally {
        await page.close();
      }
    });

    it('debits one DOM-work unit per visibility check regardless of ancestor depth', async () => {
      const page = await browser.newPage();
      try {
        await page.setContent('<button type="button" aria-controls="panel">Toggle</button><div><div id="panel">Panel</div></div>');
        const shallow = await discoverInteractionCandidates(page);
        // 描画される入れ子は深すぎると Chromium のレンダラが落ちるため（約200で再現）、100にとどめる。
        await page.evaluate(() => {
          let parent = document.getElementById('panel')!.parentElement!;
          for (let index = 1; index < 100; index += 1) {
            const wrapper = document.createElement('div');
            parent.replaceWith(wrapper);
            wrapper.append(parent);
            parent = wrapper;
          }
        });
        const precondition = await page.evaluate(() => {
          let depth = 0;
          for (let current = document.getElementById('panel')!.parentElement; current !== document.body; current = current!.parentElement) {
            depth += 1;
          }
          return depth;
        });
        expect(precondition).toBe(100);
        const deep = await discoverInteractionCandidates(page);

        expect(shallow.completeness).toBe('COMPLETE');
        expect(deep.completeness).toBe('COMPLETE');
        // 深い入れ子の分だけ、要素の走査（1要素あたり1）は増える。可視判定の消費は祖先の数によらない。
        expect(deep.domWorkUsed - shallow.domWorkUsed).toBe(100 - 1);
      } finally {
        await page.close();
      }
    });
  });

  describe('Q2: interaction geometry is recorded in page coordinates', () => {
    it('records the same page-coordinate box in discovery and inspection regardless of window scroll', async () => {
      const page = await browser.newPage({ viewport });
      try {
        await page.setContent('<style>body{margin:8px}#spacer{height:2000px}</style><div id="spacer"></div><button type="button">Far</button>');
        const initial = await discoverInteractionCandidates(page);
        const initialBox = initial.candidates[0]?.boundingBox;
        expect(initialBox?.y).toBeCloseTo(2008, 0);
        await page.evaluate(() => window.scrollTo(0, 1_500));
        expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
        const scrolled = await discoverInteractionCandidates(page);
        expect(scrolled.candidates[0]?.boundingBox).toEqual(initialBox);
        const handle = await page.locator('button').elementHandle();
        const handleReference = await candidateReferenceOf(page, 'button');
        if (handle === null) throw new Error('Missing far candidate');
        try {
          const snapshot = await inspectInteractionCandidateHandle(handleReference, 0);
          if (snapshot.status !== 'CONNECTED') throw new Error('Expected connected far candidate');
          expect(snapshot.candidate.boundingBox).toEqual(initialBox);
        } finally {
          await handle.dispose();
        }
      } finally {
        await page.close();
      }
    });
  });

  describe('M2: mechanically excluded candidates are ledgered separately from external actions', () => {
    it.each([
      ['/mechanical-exclusions.html', 'Same-origin link', 'NAVIGATION_HREF'],
      ['/mechanical-exclusions.html', 'Reset form', 'RESET_CONTROL'],
      ['/mechanical-exclusions.html', 'Form-associated button', 'FORM_ASSOCIATED'],
      ['/post-form.html', 'Submit', 'SUBMISSION_CONTROL'],
    ] as const)('records %s %s as an excluded interaction candidate', async (path, name, reason) => {
      const candidate = await candidateNamed(path, name);
      server.resetCounters();
      server.resetRequestObservations();

      const result = await auditInteraction(input(path, candidate));

      expect(result.status).toBe('REJECTED_UNSAFE');
      expect(result.reason).toBe(reason);
      expect(result.safety.excludedInteractionCandidates).toEqual([{ candidateId: candidate.candidateId, reason }]);
      expect(result.safety.blockedExternalActions).toEqual([]);
      expect(server.getRequestObservations().map((entry) => entry.pathname)).toEqual([path]);
      expect(server.getCounters()).toMatchObject({ post: 0, download: 0 });
    });

    it.each([
      ['/mailto-link.html', 'Email fixture', 'EXTERNAL_ACTION'],
      ['/tel-link.html', 'Call fixture', 'EXTERNAL_ACTION'],
      ['/external-link.html', 'External resource', 'EXTERNAL_ACTION'],
      ['/download-button.html', 'Direct download', 'DOWNLOAD'],
    ] as const)('records only the external action for %s %s', async (path, name, reason) => {
      const candidate = await candidateNamed(path, name);

      const result = await auditInteraction(input(path, candidate));

      expect(result.status).toBe('REJECTED_UNSAFE');
      expect(result.safety.blockedExternalActions).toEqual([
        { candidateId: candidate.candidateId, url: candidate.href, reason },
      ]);
      expect(result.safety.excludedInteractionCandidates).toEqual([]);
    });
  });

  describe('Q6: malformed browser geometry is rejected with a bounded message', () => {
    it('rejects a retained snapshot whose bounding box is null without a TypeError', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const handle = fakeCandidateReference(async () => ({
          status: 'CONNECTED',
          domWorkUsed: 1,
          raw: { ...rawCandidateFor(candidate), boundingBox: null },
        }));

      const rejection = await inspectInteractionCandidateHandle(handle, 0).catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(Error);
      expect(rejection).not.toBeInstanceOf(TypeError);
      expect((rejection as Error).message).toBe('Invalid browser interaction bounding box: [retained-handle].boundingBox');
    });

    it('rejects a discovered candidate whose bounding box is null without a TypeError', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const page = {
        evaluate: async () => ({
          candidates: [{ ...rawCandidateFor(candidate), boundingBox: null }],
          completeness: 'COMPLETE',
          domWorkUsed: 20,
        }),
      } as unknown as Page;

      const rejection = await discoverInteractionCandidates(adaptFakePage(page)).catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(Error);
      expect(rejection).not.toBeInstanceOf(TypeError);
      expect((rejection as Error).message).toBe('Invalid browser interaction bounding box: [0].boundingBox');
    });
  });

  describe('F06 R2-N3: the retained target handle disposal is bounded by the effective deadline', () => {
    /** 観測で ariaExpanded が変わり、handle の破棄が `dispose` の振る舞いに従うセッションを作る。 */
    function toggleSessionWithDispose(
      candidate: InteractionCandidate,
      ledger: SafetyLedger,
      dispose: () => Promise<void>,
    ): InteractionGuardedSession {
      const rawCandidate = rawCandidateFor(candidate);
      const snapshots = [
        { status: 'CONNECTED', domWorkUsed: 10, raw: rawCandidate },
        { status: 'CONNECTED', domWorkUsed: 10, raw: toggledRawCandidate(candidate) },
      ];
      let snapshotIndex = 0;
      const targetHandle = {
        evaluate: async () => snapshots[Math.min(snapshotIndex++, snapshots.length - 1)],
        click: async () => undefined,
        dispose,
      };
      const page = {
        context: fakeGuardContext, goto: async () => undefined,
        evaluate: async (_callback: unknown, argument?: unknown) => (
          argument === undefined ? true : { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 20 }
        ),
        evaluateHandle: async () => boundedResolutionEnvelope(targetHandle),
      } as unknown as Page;
      return {
        page: withScrollPreparation(page, candidate),
        ledger,
        activateInteractionFreeze: async () => undefined,
        ...fakeCloseLifecycle(),
      };
    }

    it('finishes the audit when the retained handle disposal never settles', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      let disposeCalls = 0;
      const neverSettles = createDeferred<void>();
      const ledger = new SafetyLedger();

      const settled = await settleWithin(auditInteraction({
        ...input('/accordion.html', candidate),
        // 下準備を終えてから、確かめたい段階に進むよう、期限に余裕を持たせる。
        timeoutMs: 1_500,
        sessionFactory: async () => toggleSessionWithDispose(candidate, ledger, async () => {
          disposeCalls += 1;
          await neverSettles.promise;
        }),
      }), 3_000);

      expect(settled).not.toBe('STILL_PENDING');
      const result = settled as Awaited<ReturnType<typeof auditInteraction>>;
      expect(result.status).toBe('VERIFIED');
      expect(result.evidence.changedFields).toContain('ariaExpanded');
      expect(disposeCalls).toBe(1);
      expect(result.lifecycle).toEqual({ status: 'CLOSED', reason: null, reasonDetail: null });
    });

    it('ledgers a disposal failure that arrives after the deadline, like a late-resolved handle', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const unhandled: unknown[] = [];
      const observeUnhandled = (reason: unknown) => { unhandled.push(reason); };
      process.on('unhandledRejection', observeUnhandled);
      const lateDispose = createDeferred<void>();
      const ledger = new SafetyLedger();
      try {
        const settled = await settleWithin(auditInteraction({
          ...input('/accordion.html', candidate),
          // 下準備を終えてから、確かめたい段階に進むよう、期限に余裕を持たせる。
          timeoutMs: 1_500,
          sessionFactory: async () => toggleSessionWithDispose(candidate, ledger, () => lateDispose.promise),
        }), 3_000);

        expect(settled).not.toBe('STILL_PENDING');
        const result = settled as Awaited<ReturnType<typeof auditInteraction>>;
        expect(result.status).toBe('VERIFIED');
        expect(result.safety.invariantViolations).toEqual([]);

        lateDispose.reject(new Error('late retained handle dispose failure'));
        await expect.poll(() => ledger.snapshot().invariantViolations).toEqual([{
          code: 'INTERACTION_HANDLE_DISPOSE_FAILED',
          message: 'late retained handle dispose failure',
        }]);
        await wait(0);
      } finally {
        process.off('unhandledRejection', observeUnhandled);
      }
      expect(unhandled).toEqual([]);
    });
  });

  // SPEC-5: 押した後の期限切れの代表（押した後の 1 回の観測を、期限の後に始めない。区分は CHECK_NOT_COMPLETED）。
  describe('F06 R2-N4: a work-phase browser evaluation is not started after the deadline', () => {
    it('does not start the post-click inspection when the deadline passes after the click', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const rawCandidate = rawCandidateFor(candidate);
      const realNow = Date.now.bind(Date);
      const deadlineAtMs = realNow() + 5_000;
      let armedCalls: number | undefined;
      let handleEvaluations = 0;
      const targetHandle = {
        evaluate: async () => {
          handleEvaluations += 1;
          return { status: 'CONNECTED', domWorkUsed: 10, raw: rawCandidate };
        },
        click: async () => { armedCalls = 0; },
        dispose: async () => undefined,
      };
      const page = {
        context: fakeGuardContext, goto: async () => undefined,
        evaluate: async (_callback: unknown, argument?: unknown) => (
          argument === undefined ? true : { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 20 }
        ),
        evaluateHandle: async () => boundedResolutionEnvelope(targetHandle),
      } as unknown as Page;
      // click の後、最初の時刻の読み取りは期限の前の時刻を返し、その次の時刻の読み取りからは期限を過ぎた時刻を返す。
      const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
        if (armedCalls === undefined) return realNow();
        armedCalls += 1;
        return armedCalls === 1 ? deadlineAtMs - 1 : deadlineAtMs + 1;
      });
      try {
        const result = await auditInteraction({
          ...input('/accordion.html', candidate),
          timeoutMs: 10_000,
          deadlineAtMs,
          sessionFactory: async () => ({
            page: withScrollPreparation(page, candidate),
            ledger: new SafetyLedger(),
            activateInteractionFreeze: async () => undefined,
            ...fakeCloseLifecycle(),
          }),
        });

        expect(result.status).toBe('NOT_VERIFIABLE');
        expectReason(result, 'DEADLINE_DURING_POST_CONDITION_OBSERVATION');
        // I15a: click の後の観測を終えないまま期限が切れたので、確かめる手順を終えられなかった区分にする。
        expect(result.notVerifiableKind).toBe('CHECK_NOT_COMPLETED');
        expect(handleEvaluations).toBe(1);
      } finally {
        nowSpy.mockRestore();
      }
    });
  });

  // SPEC-5（設計書 2026-11-14 5.1 の案 B）: 凍結の前の下準備は、スクロール・hover・描画 2 回・観測 1 回。残すのは、スクロールで始まる読み込みを
  // Passive で遮断しないこと・下準備と凍結と押す順・凍結の後に現れた要素を押さないこと・下準備の失敗の代表 1 件。
  describe('F06b R2-N1: the target is scrolled into view in the Passive phase before the safety freeze', () => {
    it('verifies an accordion placed offscreen inside an inner scroll container and keeps its scroll-triggered load Passive', async () => {
      const candidate = await candidateNamed('/inner-scroll-accordion.html', 'Inner offscreen toggle');
      expect(candidate.boundingBox.y).toBeGreaterThan(viewport.height);
      server.resetRequestObservations();

      const result = await auditInteraction(input('/inner-scroll-accordion.html', candidate));

      expect(result.status, JSON.stringify(result)).toBe('VERIFIED');
      expect(result.evidence.changedFields).toContain('ariaExpanded');
      expect(result.evidence.changedFields).not.toContain('boundingBox');
      // スクロールで起きた遅延読み込みの通信は、凍結の前（Passive フェーズ）に起き、遮断されない。
      expect(server.getRequestObservations().map((entry) => entry.pathname)).toContain('/resource-item.css');
      expect(result.safety.blockedInteractionRequests).toEqual([]);
    });

    /** 解決と、スクロール・hover・破棄・凍結・click の順序を記録する偽のセッションを作る。click の前は元の状態、click の後は ariaExpanded が変わった状態を返す。 */
    function preparationSession(
      candidate: InteractionCandidate,
      options: {
        readonly events: string[];
        readonly hover?: () => Promise<void>;
      },
    ): InteractionGuardedSession {
      const rawCandidate = rawCandidateFor(candidate);
      let clicked = false;
      const targetHandle = {
        evaluate: async () => ({ status: 'CONNECTED', domWorkUsed: 0, raw: clicked ? toggledRawCandidate(candidate) : rawCandidate }),
        scrollIntoViewIfNeeded: async () => { options.events.push('scroll'); },
        hover: async () => {
          options.events.push('hover');
          await options.hover?.();
        },
        click: async () => {
          options.events.push('click');
          clicked = true;
        },
        dispose: async () => { options.events.push('dispose'); },
      };
      const page = {
        context: fakeGuardContext, goto: async () => undefined,
        evaluate: async (_callback: unknown, argument?: unknown) => (
          argument === undefined ? true : { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 0 }
        ),
        evaluateHandle: async () => {
          options.events.push('resolve');
          return boundedResolutionEnvelope(targetHandle);
        },
      } as unknown as Page;
      return {
        page,
        ledger: new SafetyLedger(),
        activateInteractionFreeze: async () => { options.events.push('freeze'); },
        ...fakeCloseLifecycle(),
      };
    }

    it('scrolls, hovers, and disposes the prepared handle before the freeze, then resolves again and clicks', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const events: string[] = [];

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        sessionFactory: async () => preparationSession(candidate, { events }),
      });

      expect(result.status).toBe('VERIFIED');
      expect(events).toEqual(['resolve', 'scroll', 'hover', 'dispose', 'freeze', 'resolve', 'click', 'dispose']);
    });

    // 下準備の失敗の代表（スクロールと hover の失敗は、同じ理由のコード）。凍結も click もしない。
    it('does not freeze or click when the pre-freeze hover fails', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const events: string[] = [];

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        sessionFactory: async () => preparationSession(candidate, {
          events,
          hover: async () => { throw new Error('hover target detached'); },
        }),
      });

      expect(result.status).toBe('NOT_VERIFIABLE');
      expectReason(result, 'SCROLL_PREPARATION_FAILED', 'hover target detached');
      expect(result.evidence.identityStatus).toBe('UNESTABLISHED');
      expect(events).toEqual(['resolve', 'scroll', 'hover', 'dispose']);
    });

    it('does not click a target that appeared only after the freeze and was never scrolled into view', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const rawCandidate = rawCandidateFor(candidate);
      const events: string[] = [];
      let discoveryIndex = 0;
      const targetHandle = {
        evaluate: async () => ({ status: 'CONNECTED', domWorkUsed: 10, raw: rawCandidate }),
        scrollIntoViewIfNeeded: async () => { events.push('scroll'); },
        click: async () => { events.push('click'); },
        dispose: async () => { events.push('dispose'); },
      };
      const page = {
        context: fakeGuardContext, goto: async () => undefined,
        evaluate: async (_callback: unknown, argument?: unknown) => {
          if (argument === undefined) return true;
          discoveryIndex += 1;
          // 下準備の探索では見つからず、凍結の後の探索で初めて見つかる。
          return { candidates: discoveryIndex === 1 ? [] : [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 20 };
        },
        evaluateHandle: async () => {
          events.push('resolve');
          return boundedResolutionEnvelope(targetHandle);
        },
      } as unknown as Page;

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        sessionFactory: async () => ({
          page,
          ledger: new SafetyLedger(),
          activateInteractionFreeze: async () => { events.push('freeze'); },
          ...fakeCloseLifecycle(),
        }),
      });

      expect(result.status).toBe('NOT_VERIFIABLE');
      expectReason(result, 'TARGET_NOT_SCROLL_PREPARED');
      expect(events).toEqual(['freeze', 'resolve', 'dispose']);
    });
  });

  // SPEC-5: 判定の結合の代表（何もしないボタンは「効いた」にしない）。位置と大きさは根拠にしない（単体は `tests/unit/interaction-collector.test.ts`）。
  describe("F10 R'1-N1': geometry is not evidence when a scroll ancestor scrolled during the click", () => {
    /** click の後の、変化の見えない理由（混雑の下では、落ち着きの待ちが期限まで続くことがある）。 */
    const POST_CLICK_DEADLINE_REASONS = [
      'DEADLINE_DURING_POST_CONDITION_OBSERVATION',
      'NO_OBSERVABLE_CHANGE',
    ];

    it('does not verify an inert button that is initially in view but covered by a fixed overlay', async () => {
      const candidate = await candidateNamed('/covered-inview-inert-button.html', 'Covered in-view inert');
      // 前提: ボタンは初めから画面内にあり、固定表示の帯 #ov（top 300px、高さ 100px）に覆われている。
      expect(candidate.boundingBox.y).toBeGreaterThanOrEqual(300);
      expect(candidate.boundingBox.bottom).toBeLessThanOrEqual(400);

      const result = await auditInteraction({ ...input('/covered-inview-inert-button.html', candidate), timeoutMs: 1_500 });

      expect(result.status, JSON.stringify(result)).toBe('NOT_VERIFIABLE');
      expect(POST_CLICK_DEADLINE_REASONS).toContain(result.reason);
      expect(result.evidence.identityStatus).toBe('MATCHED');
      expect(result.evidence.changedFields).toEqual([]);
      // 下準備の hover が、再試行のスクロールで対象を帯の外に出した。その位置が観測の前の状態になり、click ではずれない。
      expect(result.evidence.before?.boundingBox.y).not.toBeCloseTo(candidate.boundingBox.y, 0);
      expect(result.evidence.after?.boundingBox.y).toBeCloseTo(result.evidence.before?.boundingBox.y ?? Number.NaN, 0);
    });
  });

  // LZ-2: 押す失敗の理由の文言の整え（制御文字・ANSI・Playwright の call log）。
  describe("F14 R''1: a translation of the target is not evidence of the interaction", () => {
    /** click が `clickError` を投げる偽のセッションを作る。 */
    function failingClickSession(candidate: InteractionCandidate, clickError: Error): InteractionGuardedSession {
      const rawCandidate = rawCandidateFor(candidate);
      const targetHandle = {
        evaluate: async () => ({ status: 'CONNECTED', domWorkUsed: 0, raw: rawCandidate }),
        click: async () => { throw clickError; },
        dispose: async () => undefined,
      };
      const page = {
        context: fakeGuardContext, goto: async () => undefined,
        evaluate: async (_callback: unknown, argument?: unknown) => (
          argument === undefined ? true : { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 0 }
        ),
        evaluateHandle: async () => boundedResolutionEnvelope(targetHandle),
      } as unknown as Page;
      return {
        page: withScrollPreparation(page, candidate),
        ledger: new SafetyLedger(),
        activateInteractionFreeze: async () => undefined,
        ...fakeCloseLifecycle(),
      };
    }

    it.each([
      ['Error', 'EXECUTION_FAILED', 'CLICK_FAILED'],
      ['TimeoutError', 'NOT_VERIFIABLE', 'CLICK_TIMED_OUT'],
    ] as const)('removes ANSI escapes and the Playwright call log from a %s click failure reason', async (
      name,
      expectedStatus,
      expectedReasonCode,
    ) => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const clickError = new Error([
        '\u001b[31melementHandle.click: Timeout 500ms exceeded.\u001b[39m',
        'Call log:',
        '\u001b[2m  - attempting click action\u001b[22m',
        '\u001b[2m    - waiting for element to be visible, enabled and stable\u001b[22m',
      ].join('\n'));
      clickError.name = name;

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        sessionFactory: async () => failingClickSession(candidate, clickError),
      });

      expect(result.status).toBe(expectedStatus);
      expectReason(result, expectedReasonCode, 'elementHandle.click: Timeout 500ms exceeded.');
    });

    // C18n: click の期限切れと、ほかの click の失敗は、エラーの文言が残らない場合も、理由のコードで見分けられる。
    it.each([
      ['Error', 'EXECUTION_FAILED', 'CLICK_FAILED'],
      ['TimeoutError', 'NOT_VERIFIABLE', 'CLICK_TIMED_OUT'],
    ] as const)('distinguishes a %s click failure without a usable message by its reason code', async (
      name,
      expectedStatus,
      expectedReasonCode,
    ) => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const clickError = new Error('\u001b[31m\u0007\r\n\u001b[39m');
      clickError.name = name;

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        sessionFactory: async () => failingClickSession(candidate, clickError),
      });

      expect(result.status).toBe(expectedStatus);
      expectReason(result, expectedReasonCode, null);
      expectReason(result.work, expectedReasonCode, null);
    });

    it('replaces stray control characters in a click failure reason and keeps the whole reason (LZ-2)', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const clickError = new Error(`click\u0007 failed\r\n\tbadly\u001b]0;title\u0007 ${'x'.repeat(1_000)}`);

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        sessionFactory: async () => failingClickSession(candidate, clickError),
      });

      expect(result.status).toBe('EXECUTION_FAILED');
      expect(result.reason).toBe('CLICK_FAILED');
      expect(result.reasonDetail).toBe(`click failed badly ${'x'.repeat(1_000)}`);
    });
  });

  // SPEC-5: 根拠になる変化（ARIA の状態・`aria-controls` の先・文字）の結合の代表。根拠の表は単体（`tests/unit/interaction-collector.test.ts`）。
  describe("F15 R''': target geometry alone is never evidence, and the target is hovered before observation", () => {
    it('verifies an accordion by its ARIA state, its own attribute, and the controlled element', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');

      const result = await auditInteraction(input('/accordion.html', candidate));

      expect(result.status, JSON.stringify(result)).toBe('VERIFIED');
      expect(result.evidence.changedFields).toEqual(
        expect.arrayContaining(['ariaExpanded', 'controlledVisible', 'controlledHidden', 'attributes']),
      );
      expect(result.evidence.changedFields).not.toContain('boundingBox');
    });

    it('verifies a button that only toggles the visibility of its aria-controls target', async () => {
      const candidate = await candidateNamed('/controlled-panel-button.html', 'Show panel');

      const result = await auditInteraction(input('/controlled-panel-button.html', candidate));

      expect(result.status, JSON.stringify(result)).toBe('VERIFIED');
      expect(result.evidence.changedFields).toEqual(['controlledVisible', 'controlledHidden']);
    });

    it('verifies a button that only switches its own text', async () => {
      const candidate = await candidateNamed('/text-toggle-button.html', 'Show more');

      const result = await auditInteraction(input('/text-toggle-button.html', candidate));

      expect(result.status, JSON.stringify(result)).toBe('VERIFIED');
      expect(result.evidence.changedFields).toEqual(['textFingerprint']);
    });
  });

  describe("F15 R''' M-3: lifecycle and Ledger reasons are normalized before they are bounded", () => {
    const ANSI_WITH_CALL_LOG = [
      '\u001b[31mbrowserContext.close: Target closed\u001b[39m',
      'Call log:',
      '\u001b[2m  - closing context\u001b[22m',
    ].join('\n');
    /** 前の上限（512 字）で先に切り詰めると、ANSI のエスケープシーケンスの途中（`\u001b[3`）で切れた文言。 */
    const ESCAPE_AT_BOUND = `${'x'.repeat(509)}\u001b[31m${'y'.repeat(100)}`;
    /** LZ-2: 長さの上限はなくなったので、エスケープシーケンスだけを除き、後ろの文字も切り詰めずに残す。 */
    const ESCAPE_AT_BOUND_REASON = `${'x'.repeat(509)}${'y'.repeat(100)}`;

    /** close が `closeError` で拒否されても、終端（CLOSED）に達するセッションを作る。 */
    function rejectingCloseSession(candidate: InteractionCandidate, closeError: Error): InteractionGuardedSession {
      const rawCandidate = rawCandidateFor(candidate);
      // 最初の観測（click の前）は元の状態、その後は ariaExpanded が変わった状態を返す。
      let inspections = 0;
      const targetHandle = {
        evaluate: async () => ({
          status: 'CONNECTED',
          domWorkUsed: 0,
          raw: inspections++ === 0 ? rawCandidate : toggledRawCandidate(candidate),
        }),
        click: async () => undefined,
        dispose: async () => undefined,
      };
      const page = {
        context: fakeGuardContext, goto: async () => undefined,
        evaluate: async (_callback: unknown, argument?: unknown) => (
          argument === undefined ? true : { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 0 }
        ),
        evaluateHandle: async () => boundedResolutionEnvelope(targetHandle),
      } as unknown as Page;
      let closed = false;
      return {
        page: withScrollPreparation(page, candidate),
        ledger: new SafetyLedger(),
        activateInteractionFreeze: async () => undefined,
        isClosed: () => closed,
        close: async () => {
          closed = true;
          throw closeError;
        },
      };
    }

    it.each([
      [
        'ANSI escapes and the Playwright call log',
        ANSI_WITH_CALL_LOG,
        'browserContext.close: Target closed',
        'browserContext.close: Target closed',
      ],
      ['an escape sequence across the former length bound', ESCAPE_AT_BOUND, ESCAPE_AT_BOUND_REASON, ESCAPE_AT_BOUND_REASON],
      // C18n: 文言が残らない場合、lifecycle の詳細は null。Ledger の文言は、これまでどおり代わりの文言（設計書 5.1.2）。
      ['only control characters', '\u001b[31m\u0007\r\n\u001b[39m', null, 'Interaction owner close failed'],
    ] as const)('normalizes an owner close rejection with %s in the lifecycle and Ledger reasons', async (
      _label,
      message,
      expectedReasonDetail,
      expectedLedgerMessage,
    ) => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        sessionFactory: async () => rejectingCloseSession(candidate, new Error(message)),
      });

      expect(expectedStructuredResult(result).lifecycle).toEqual({
        status: 'CLOSED',
        reason: 'OWNER_CLOSE_FAILED',
        reasonDetail: expectedReasonDetail,
      });
      expect(result.safety.invariantViolations).toContainEqual({
        code: 'INTERACTION_OWNER_CLOSE_FAILED',
        message: expectedLedgerMessage,
      });
    });

    it('normalizes a retained handle disposal failure before recording it in the Ledger', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const rawCandidate = rawCandidateFor(candidate);
      // 最初の観測（click の前）は元の状態、その後は ariaExpanded が変わった状態を返す。
      let inspections = 0;
      const targetHandle = {
        evaluate: async () => ({
          status: 'CONNECTED',
          domWorkUsed: 0,
          raw: inspections++ === 0 ? rawCandidate : toggledRawCandidate(candidate),
        }),
        click: async () => undefined,
        dispose: async () => { throw new Error(ESCAPE_AT_BOUND); },
      };
      const page = {
        context: fakeGuardContext, goto: async () => undefined,
        evaluate: async (_callback: unknown, argument?: unknown) => (
          argument === undefined ? true : { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 0 }
        ),
        evaluateHandle: async () => boundedResolutionEnvelope(targetHandle),
      } as unknown as Page;

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        sessionFactory: async () => ({
          page: withScrollPreparation(page, candidate),
          ledger: new SafetyLedger(),
          activateInteractionFreeze: async () => undefined,
          ...fakeCloseLifecycle(),
        }),
      });

      expect(result.status).toBe('VERIFIED');
      expect(result.safety.invariantViolations).toContainEqual({
        code: 'INTERACTION_HANDLE_DISPOSE_FAILED',
        message: ESCAPE_AT_BOUND_REASON,
      });
    });

    it('removes an escape sequence across the former length bound from a click failure reason', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const rawCandidate = rawCandidateFor(candidate);
      const targetHandle = {
        evaluate: async () => ({ status: 'CONNECTED', domWorkUsed: 0, raw: rawCandidate }),
        click: async () => { throw new Error(ESCAPE_AT_BOUND); },
        dispose: async () => undefined,
      };
      const page = {
        context: fakeGuardContext, goto: async () => undefined,
        evaluate: async (_callback: unknown, argument?: unknown) => (
          argument === undefined ? true : { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 0 }
        ),
        evaluateHandle: async () => boundedResolutionEnvelope(targetHandle),
      } as unknown as Page;

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        sessionFactory: async () => ({
          page: withScrollPreparation(page, candidate),
          ledger: new SafetyLedger(),
          activateInteractionFreeze: async () => undefined,
          ...fakeCloseLifecycle(),
        }),
      });

      expect(result.status).toBe('EXECUTION_FAILED');
      expectReason(result, 'CLICK_FAILED', ESCAPE_AT_BOUND_REASON);
    });
  });
  }

  {
  // SPEC-5: 安定と持続の窓・切り詰め・下準備の focus の場面は消した（1 回の観察の判定は単体 `tests/unit/interaction-collector.test.ts` と、
  // F10 の何もしないボタン・F15 の根拠の結合の代表で確かめる）。残すのは、根拠の結合の 2 件と、押す失敗の文言の整え、読み込みの期限と details の値。
  describe('F16 R5: stability and persistence of evidence, details disclosure, and hover identity', () => {
    it('verifies a dialog opener by the visibility of its aria-controls target', async () => {
      const candidate = await candidateNamed('/stateful-widgets.html', 'Open dialog');

      const result = await auditInteraction(input('/stateful-widgets.html', candidate));

      expect(result.status, JSON.stringify(result)).toBe('VERIFIED');
      expect(result.evidence.changedFields).toEqual(['controlledVisible', 'controlledHidden']);
      expect(result.evidence.changedAttributes).toEqual([]);
    });

    // N-4: hover で文字が変わるボタンは、下準備の handle で読んだ hover の後の状態を、凍結の後の探し直しの目印にする。
    it('verifies a button whose text changes on hover and whose aria-pressed toggles on click', async () => {
      const candidate = await candidateNamed('/hover-text-follow-button.html', 'Following');

      const result = await auditInteraction(input('/hover-text-follow-button.html', candidate));

      expect(result.status, JSON.stringify(result)).toBe('VERIFIED');
      expect(result.candidateId).toBe(candidate.candidateId);
      expect(result.evidence.identityStatus).toBe('MATCHED');
      expect(result.evidence.before?.accessibleName).toBe('Following (hover)');
      expect(result.evidence.changedFields).toEqual(['attributes']);
      expect(result.evidence.changedAttributes).toEqual(['aria-pressed']);
    });

    /** click が `clickError` を投げる偽のセッションを作る。 */
    function rejectingClickSession(candidate: InteractionCandidate, clickError: Error): InteractionGuardedSession {
      const rawCandidate = rawCandidateFor(candidate);
      const targetHandle = {
        evaluate: async () => ({ status: 'CONNECTED', domWorkUsed: 0, raw: rawCandidate }),
        click: async () => { throw clickError; },
        dispose: async () => undefined,
      };
      const page = {
        context: fakeGuardContext, goto: async () => undefined,
        evaluate: async (_callback: unknown, argument?: unknown) => (
          argument === undefined ? true : { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 0 }
        ),
        evaluateHandle: async () => boundedResolutionEnvelope(targetHandle),
      } as unknown as Page;
      return {
        page: withScrollPreparation(page, candidate),
        ledger: new SafetyLedger(),
        activateInteractionFreeze: async () => undefined,
        ...fakeCloseLifecycle(),
      };
    }

    // N-6: 珍しい形のエスケープ、双方向の制御文字、サロゲートペアの片方を、理由に残さない。
    it.each([
      ['an unterminated CSI fragment', 'click\u001b[31\nfailed\u001b[0', 'click failed'],
      ['a C1 CSI', 'click \u009b31mfailed\u009b0m', 'click failed'],
      ['a DCS body terminated by ST', 'click \u001bPq#0;2;0;0;0\u001b\\failed', 'click failed'],
      ['an unterminated DCS body', 'click failed \u001bPpayload without terminator', 'click failed'],
      ['a C1 DCS body terminated by a C1 ST', 'click \u0090payload\u009cfailed', 'click failed'],
      ['a C1 OSC body terminated by BEL', 'click \u009d0;title\u0007failed', 'click failed'],
      ['an unterminated OSC body', 'click failed \u001b]8;;secret-link', 'click failed'],
      ['bidirectional controls', 'click ‮failed⁦ badly⁩ ‪‫‬‭⁧⁨', 'click failed badly'],
      // CCX-3: 共通化の前と後で、要約の掃除の結果が変わらないことを固定する（ALM・LRM・RLM、孤立したサロゲート、C0・DEL・C1、行の区切り）。
      ['an Arabic letter mark and directional marks', 'click\u061c fai\u200eled\u200f badly', 'click failed badly'],
      ['lone surrogates', 'click \ud800fai\udbffled\udc00 badly\udfff', 'click failed badly'],
      ['C0, DEL and C1 controls', 'click\u0000failed\u007fbadly\u0085\u0080', 'click failed badly'],
      ['line and paragraph separators', 'click\u2028failed\u2029badly', 'click failed badly'],
    ] as const)('removes %s from a click failure reason', async (_label, message, expectedReason) => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        sessionFactory: async () => rejectingClickSession(candidate, new Error(message)),
      });

      expect(result.status).toBe('EXECUTION_FAILED');
      expectReason(result, 'CLICK_FAILED', expectedReason);
    });

    // LZ-2: 理由の詳細の長さの上限（前は 512 で、その境目のサロゲートの組を切らずに落とした）はなくなった。前の境目にまたがる組も、後ろの文字も残す。
    it('keeps a surrogate pair across the former bound of a click failure reason', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const message = `${'x'.repeat(511)}\u{1F600}tail`;

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        sessionFactory: async () => rejectingClickSession(candidate, new Error(message)),
      });

      expect(result.status).toBe('EXECUTION_FAILED');
      expectReason(result, 'CLICK_FAILED', message);
      expect(result.reasonDetail).not.toMatch(/[\ud800-\udfff]/u);
    });

    describe('F18 R6: the deadline start, CSS custom properties, class names, reason cleanup, and details values', () => {
      // I-2: Interaction の期限は、隔離された Context での読み込みと初期描画が終わった時点から数える。
      it('verifies a class toggle on a page whose load is delayed by a slow image', async () => {
        const path = '/slow-load-class-toggle.html';
        const candidate = await candidateNamed(path, 'Slow load toggle');
        const startedAt = Date.now();

        const result = await auditInteraction(input(path, candidate));

        // 読み込みが実際に遅れたこと（遅れた画像を読み終えるまで load にならないこと）を確かめる。
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(SLOW_IMAGE_DELAY_MS);
        expect(result.status, JSON.stringify(result)).toBe('VERIFIED');
        expect(result.evidence.changedFields).toEqual(['attributes']);
        expect(result.evidence.changedAttributes).toEqual(['class']);
      });

      it('starts the interaction deadline after the initial load and render', async () => {
        const candidate = await candidateNamed('/accordion.html', 'Toggle details');
        const session = fakeToggleSession(candidate, { ledger: new SafetyLedger() });
        // 読み込みに、Interaction の期限の大部分にあたる時間がかかる。
        (session.page as unknown as { goto: () => Promise<void> }).goto = async () => { await wait(1_200); };

        const result = await auditInteraction({
          ...input('/accordion.html', candidate),
          navigationTimeoutMs: 5_000,
          timeoutMs: 1_500,
          sessionFactory: async () => session,
        });

        expect(result.status, result.reason).toBe('VERIFIED');
      });

      /** `goto` に渡された期限を記録し、読み込みの後で失敗する偽のセッションを作る。 */
      function gotoRecordingSession(gotoTimeouts: unknown[]): InteractionGuardedSession {
        return {
          page: {
            context: fakeGuardContext, goto: async (_url: string, options: { readonly timeout?: number }): Promise<never> => {
              gotoTimeouts.push(options.timeout);
              throw new Error('stop after navigation');
            },
          } as unknown as Page,
          ledger: new SafetyLedger(),
          activateInteractionFreeze: async () => undefined,
          ...fakeCloseLifecycle(),
        };
      }

      it('bounds the initial load by the navigation timeout, not by the interaction timeout', async () => {
        const candidate = await candidateNamed('/accordion.html', 'Toggle details');
        const gotoTimeouts: unknown[] = [];

        const result = await auditInteraction({
          ...input('/accordion.html', candidate),
          navigationTimeoutMs: 4_000,
          timeoutMs: 1_000,
          deadlineAtMs: Date.now() + 10_000,
          sessionFactory: async () => gotoRecordingSession(gotoTimeouts),
        });

        expect(result.status).toBe('EXECUTION_FAILED');
        expect(gotoTimeouts).toHaveLength(1);
        expect(gotoTimeouts[0]).toBeGreaterThan(1_000);
        expect(gotoTimeouts[0]).toBeLessThanOrEqual(4_000);
      });

      it('bounds the initial load by the absolute deadline when it comes before the navigation timeout', async () => {
        const candidate = await candidateNamed('/accordion.html', 'Toggle details');
        const gotoTimeouts: unknown[] = [];

        await auditInteraction({
          ...input('/accordion.html', candidate),
          navigationTimeoutMs: 30_000,
          timeoutMs: 2_000,
          deadlineAtMs: Date.now() + 3_000,
          sessionFactory: async () => gotoRecordingSession(gotoTimeouts),
        });

        expect(gotoTimeouts).toHaveLength(1);
        expect(gotoTimeouts[0]).toBeLessThanOrEqual(3_000);
      });

      it('reports a load that exceeds the navigation timeout as NOT_VERIFIABLE with a distinct reason', async () => {
        const candidate = await candidateNamed('/accordion.html', 'Toggle details');
        const session: InteractionGuardedSession = {
          page: {
            context: fakeGuardContext, goto: async (): Promise<never> => {
              const timeout = new Error('page.goto: Timeout 5000ms exceeded.');
              timeout.name = 'TimeoutError';
              throw timeout;
            },
          } as unknown as Page,
          ledger: new SafetyLedger(),
          activateInteractionFreeze: async () => undefined,
          ...fakeCloseLifecycle(),
        };

        const result = await auditInteraction({ ...input('/accordion.html', candidate), sessionFactory: async () => session });

        expect(result.status).toBe('NOT_VERIFIABLE');
        expectReason(result, 'INITIAL_LOAD_DURING_LOAD');
        expect(result.evidence.identityStatus).toBe('UNESTABLISHED');
      });

      it.each([0, -1, 1.5, Number.NaN])('rejects a navigation timeout of %s', async (navigationTimeoutMs) => {
        const candidate = await candidateNamed('/accordion.html', 'Toggle details');

        await expect(auditInteraction({ ...input('/accordion.html', candidate), navigationTimeoutMs }))
          .rejects.toThrow('Interaction navigation timeout must be a positive finite integer');
      });

      // M-3: LRM、RLM、ALM と、孤立したサロゲートを、理由に残さない。
      it.each([
        ['LRM, RLM, and ALM', 'click‎ failed‏ badly؜', 'click failed badly'],
        ['lone surrogates', 'click \ud800failed\udc00 badly', 'click failed badly'],
        ['a lone low surrogate after a valid pair', 'click \u{1F600}\udc00 failed', 'click \u{1F600} failed'],
      ] as const)('removes %s from a click failure reason', async (_label, message, expectedReason) => {
        const candidate = await candidateNamed('/accordion.html', 'Toggle details');

        const result = await auditInteraction({
          ...input('/accordion.html', candidate),
          sessionFactory: async () => rejectingClickSession(candidate, new Error(message)),
        });

        expect(result.status).toBe('EXECUTION_FAILED');
        expectReason(result, 'CLICK_FAILED', expectedReason);
      });

      // M-4:click の前後の、親の details の open の値を Evidence に残す。
      it.each([
        ['Closed disclosure', false, true],
        ['Open disclosure', true, false],
      ] as const)('records the open state before and after the click (%s)', async (name, before, after) => {
        const candidate = await candidateNamed('/details-disclosure.html', name);

        const result = await auditInteraction(input('/details-disclosure.html', candidate));

        expect(result.status, JSON.stringify(result)).toBe('VERIFIED');
        expect(result.evidence.changedFields).toEqual(['detailsOpen']);
        expect(result.evidence.detailsOpenBefore).toBe(before);
        expect(result.evidence.detailsOpenAfter).toBe(after);
        expect(result.work.evidence.detailsOpenBefore).toBe(before);
        expect(result.work.evidence.detailsOpenAfter).toBe(after);
      });
    });
  });
  }

  {
  // SPEC-5（設計書 2026-11-14 5.1）: 根拠にしない属性の一覧・名前の決まり・タブだけの決まりは、全部の候補に当てる 1 つの決まりにした（属性は ARIA の状態と
  // `open` と class の名前だけ。style は根拠にしない）。決まりの表は単体（`tests/unit/interaction-collector.test.ts`）。結合は、class・自動で切り替わる
  // タブ・押しても何も起きないタブ（focus で付く属性と style だけが変わる）の代表だけを残した。
  describe('F20 R8: focus and hover names are not evidence, and explicit tabs are not focused before the freeze', () => {
    const TABS_PAGE = '/focus-activated-tabs.html';
    /** click の後の、変化の見えない理由（混雑の下では、落ち着きの待ちが期限まで続くことがある）。 */
    const POST_CLICK_DEADLINE_REASONS = [
      'DEADLINE_DURING_POST_CONDITION_OBSERVATION',
      'NO_OBSERVABLE_CHANGE',
    ];

    it('keeps verifying a toggle that switches the .active class', async () => {
      const candidate = await candidateNamed('/stateful-widgets.html', 'Class toggle');

      const result = await auditInteraction(input('/stateful-widgets.html', candidate));

      expect(result.status, JSON.stringify(result)).toBe('VERIFIED');
      expect(result.evidence.changedFields).toEqual(['attributes']);
      expect(result.evidence.changedAttributes).toEqual(['class']);
    });

    // Important-2: 自動で切り替わるタブは、凍結の前に focus しないので、click で切り替わったことを確かめられる。
    it('verifies an automatically activated tab that is selected on focus', async () => {
      const candidate = await candidateNamed(TABS_PAGE, 'Auto second tab');

      const result = await auditInteraction(input(TABS_PAGE, candidate));

      expect(result.status, JSON.stringify(result)).toBe('VERIFIED');
      expect(result.evidence.changedFields).toEqual(expect.arrayContaining(['ariaSelected', 'controlledVisible', 'attributes']));
      expect(result.evidence.changedAttributes).toContain('aria-selected');
      expect(result.evidence.changedAttributes).not.toContain('class');
    });

    // 押すと focus で付く `focused` 属性・inline の style（R9 の Important-1）だけが変わる、選ばれているタブ。属性は ARIA の状態と `open` だけを
    // 根拠にするので、何も起きないのに VERIFIED にはならない。
    it.each([
      ['Focused attribute first tab'],
      ['Box shadow first tab'],
    ] as const)('does not verify pressing the already selected tab (%s)', async (name) => {
      const candidate = await candidateNamed(TABS_PAGE, name);

      const result = await auditInteraction(input(TABS_PAGE, candidate));

      expect(result.status, JSON.stringify(result)).toBe('NOT_VERIFIABLE');
      expect(POST_CLICK_DEADLINE_REASONS).toContain(result.reason);
      expect(result.evidence.identityStatus).toBe('MATCHED');
      expect(result.evidence.changedFields).toEqual([]);
      expect(result.evidence.changedAttributes).toEqual([]);
      expect(result.evidence.changedAttributesTruncated).toBe(false);
      expect(result.safety.blockedInteractionRequests).toEqual([]);
    });
  });
  }
});
}

/**
 * TS-c: Interaction の session の区分・期限・読み込みの観測・出口の中継の記録のテストを登録する（SLIM BD-5: 既定の Chromium だけなので、速い組の
 * `isolated-interaction-discovery.test.ts` が呼ぶ。凍結の直後の close の競合は `registerFrozenCloseRaceCases`）。本文は、分ける前の位置と字下げのまま。
 */
export function registerInteractionSessionCases(): void {
// I15a（Task 14〜17 の設計書 5.4.1）: NOT_VERIFIABLE の区分。確かめる手順を最後まで行って変化が見えなかったか、サイトの振る舞いのために
// 確かめられないと結論した場合は OBSERVED_NO_CHANGE、確かめる手順を終えられなかった場合は CHECK_NOT_COMPLETED にする。
// NOT_VERIFIABLE 以外の状態では null にする。
describe('I15a: the kind of NOT_VERIFIABLE in Interaction Evidence', () => {
  const NO_OBSERVABLE_CHANGE_REASON = 'NO_OBSERVABLE_CHANGE';

  function timeoutError(message: string): Error {
    const error = new Error(message);
    error.name = 'TimeoutError';
    return error;
  }

  /** 読み込み（`goto`）だけを差し替えた偽のセッション。 */
  function gotoSession(goto: () => Promise<unknown>, close?: () => Promise<void>): InteractionGuardedSession {
    return {
      page: { context: fakeGuardContext, goto } as unknown as Page,
      ledger: new SafetyLedger(),
      activateInteractionFreeze: async () => undefined,
      ...fakeCloseLifecycle(close),
    };
  }

  /** 下準備のスクロールが、ブラウザの中で期限切れになる偽のセッション。 */
  function scrollTimeoutSession(candidate: InteractionCandidate): InteractionGuardedSession {
    const rawCandidate = rawCandidateFor(candidate);
    const preparationHandle = {
      evaluate: async () => ({
        status: 'CONNECTED',
        domWorkUsed: 0,
        raw: rawCandidate,
        attributes: { complete: true, entries: [] },
      }),
      scrollIntoViewIfNeeded: async () => { throw timeoutError('scroll timed out'); },
      hover: async () => undefined,
      dispose: async () => undefined,
    };
    const page = {
      context: fakeGuardContext, goto: async () => undefined,
      evaluate: async (_callback: unknown, argument?: unknown) => (
        argument === undefined ? true : { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 0 }
      ),
      evaluateHandle: async () => boundedResolutionEnvelope(preparationHandle),
    } as unknown as Page;
    return {
      page,
      ledger: new SafetyLedger(),
      activateInteractionFreeze: async () => undefined,
      ...fakeCloseLifecycle(),
    };
  }

  it('gives OBSERVED_NO_CHANGE to an inert button whose click changes nothing', async () => {
    const candidate = await candidateNamed('/fixed-inert-button.html', 'Fixed inert');

    const result = await auditInteraction({ ...input('/fixed-inert-button.html', candidate), timeoutMs: 1_500 });

    expect(result.status, JSON.stringify(result)).toBe('NOT_VERIFIABLE');
    expectReason(result, NO_OBSERVABLE_CHANGE_REASON);
    expect(result.notVerifiableKind).toBe('OBSERVED_NO_CHANGE');
    // 区分は Evidence の最上位にだけ置き、作業の結果（`work`）には区分を持たせない（C18n で `reasonDetail` を加えた）。
    expect(result.work.status).toBe('NOT_VERIFIABLE');
    expect(Object.keys(result.work).sort()).toEqual(['evidence', 'reason', 'reasonDetail', 'status']);
  });

  it('gives CHECK_NOT_COMPLETED to a load that exceeds the navigation timeout', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');

    const result = await auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => gotoSession(async () => { throw timeoutError('page.goto: Timeout 5000ms exceeded.'); }),
    });

    expect(result.status).toBe('NOT_VERIFIABLE');
    expectReason(result, 'INITIAL_LOAD_DURING_LOAD');
    expect(result.notVerifiableKind).toBe('CHECK_NOT_COMPLETED');
  });

  it('gives CHECK_NOT_COMPLETED to a preparation that exceeds the deadline', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');

    const result = await auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => scrollTimeoutSession(candidate),
    });

    expect(result.status).toBe('NOT_VERIFIABLE');
    expectReason(result, 'SCROLL_PREPARATION_DEADLINE');
    expect(result.notVerifiableKind).toBe('CHECK_NOT_COMPLETED');
  });

  it('gives null to VERIFIED', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');

    const result = await auditInteraction(input('/accordion.html', candidate));

    expect(result.status, JSON.stringify(result)).toBe('VERIFIED');
    expect(result.notVerifiableKind).toBeNull();
  });

  it('gives null to EXECUTION_FAILED', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');

    const result = await auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => gotoSession(async () => { throw new Error('net::ERR_CONNECTION_REFUSED'); }),
    });

    expect(result.status).toBe('EXECUTION_FAILED');
    expect(result.notVerifiableKind).toBeNull();
  });

  it('gives null when a cleanup anomaly turns NOT_VERIFIABLE work into BLOCKED_BY_SAFETY', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    let closeAttempts = 0;

    const result = await auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => gotoSession(
        async () => { throw timeoutError('page.goto: Timeout 5000ms exceeded.'); },
        async () => {
          closeAttempts += 1;
          if (closeAttempts === 1) throw new Error('first close failed');
        },
      ),
    });

    expect(result.work.status).toBe('NOT_VERIFIABLE');
    expect(result.status).toBe('BLOCKED_BY_SAFETY');
    expect(result.notVerifiableKind).toBeNull();
  });

  it('lists every NOT_VERIFIABLE reason once in the reason table, each with a kind', async () => {
    // C18n: 対応表は、今の版が書くコードから区分への対応だけを持つ。英文は持たない（Evidence の理由はコードにし、詳細は `reasonDetail` に入れる）。
    // SPEC-5: 書くコードと読むだけのコードの和がコードの一覧になることは、単体（`tests/unit/interaction-open-ended.test.ts`）で確かめる。
    const table: Readonly<Record<string, unknown>> = INTERACTION_NOT_VERIFIABLE_REASONS;
    const entries = Object.entries(table);
    expect(Object.isFrozen(table)).toBe(true);
    expect(new Set(INTERACTION_NOT_VERIFIABLE_REASON_CODES).size).toBe(INTERACTION_NOT_VERIFIABLE_REASON_CODES.length);
    for (const [code, kind] of entries) {
      expect(code).toMatch(REASON_CODE_PATTERN);
      expect(['OBSERVED_NO_CHANGE', 'CHECK_NOT_COMPLETED'], code).toContain(kind);
    }

    // NOT_VERIFIABLE の結果は、対応表の code を受け取る1つの関数だけが作る。ほかの場所で状態の文字列を書くと、対応表に載らない
    // 理由ができるので、ソースの中の状態の文字列は、その関数の1か所だけにする。対応表の code は、すべて表の外でも使う。
    const source = await readFile(resolve(process.cwd(), 'src/interaction/isolated-auditor.ts'), 'utf8');
    expect(source.match(/'NOT_VERIFIABLE'/gu) ?? []).toHaveLength(1);
    for (const [code] of entries) {
      expect((source.match(new RegExp(`\\b${code}\\b`, 'gu')) ?? []).length, code).toBeGreaterThanOrEqual(2);
    }
  });
});

// P18c（DEF-008。Task 18 の前の整理の設計書 4.2、4.4）: Interaction の session の作成と、凍結の失敗の後の無効化を、期限付きで待つ。
// session の作成が期限を過ぎた場合は、その候補の結果を NOT_VERIFIABLE（CHECK_NOT_COMPLETED）とし、遅れて届いた session は閉じる。
// 凍結を待つ処理が期限を過ぎた場合は、今の失敗の扱い（違反の記録を含む）を変えずに、待つのをやめる。
// どのテストも、実際の期限（`SESSION_OPEN_TIMEOUT_MS`、`CONTEXT_CLOSE_TIMEOUT_MS`）を待たず、短い期限を注入する。
describe('P18c: deadlines of the Interaction session open and the freeze activation (DEF-008)', () => {
  /** 注入する session の作成の期限（ms）。 */
  const SHORT_SESSION_OPEN_TIMEOUT_MS = 100;
  /** 注入する凍結を待つ期限（ms）。 */
  const SHORT_FREEZE_TIMEOUT_MS = 100;
  /** 期限を過ぎてから戻るまでの余裕を含めた、戻るまでの上限（ms）。 */
  const RETURN_LIMIT_MS = 1_500;
  /** 期限のテストの上限。期限を守らない（終わらない処理を待ち続ける）場合は、この時間で失敗する。 */
  const DEADLINE_TEST_TIMEOUT_MS = 5_000;
  const SESSION_OPEN_DEADLINE_REASON = 'SESSION_OPEN_DEADLINE';
  /** 凍結を待つ処理の期限切れは、作業の失敗（EXECUTION_FAILED）になる。詳細は、その失敗の文言。 */
  const FREEZE_DEADLINE_REASON_DETAIL = 'Interaction freeze activation did not finish before its deadline';

  async function collectUnhandled(run: () => Promise<void>): Promise<unknown[]> {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      await run();
      await wait(20);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    return unhandled;
  }

  it('returns NOT_VERIFIABLE (CHECK_NOT_COMPLETED) when the session is not opened before the deadline', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    let factoryCalls = 0;
    const startedAt = performance.now();

    const result = await auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: () => {
        factoryCalls += 1;
        return new Promise<never>(() => undefined);
      },
      sessionOpenTimeoutMs: SHORT_SESSION_OPEN_TIMEOUT_MS,
    });
    const elapsedMs = performance.now() - startedAt;

    expect(factoryCalls).toBe(1);
    expect(elapsedMs).toBeLessThan(RETURN_LIMIT_MS);
    expect(result.status).toBe('NOT_VERIFIABLE');
    expect(result.notVerifiableKind).toBe('CHECK_NOT_COMPLETED');
    expectReason(result, SESSION_OPEN_DEADLINE_REASON);
    expect(result.work).toMatchObject({ status: 'NOT_VERIFIABLE', reason: SESSION_OPEN_DEADLINE_REASON, reasonDetail: null });
    expect(result.candidateId).toBe(candidate.candidateId);
    expect(result.evidence.identityStatus).toBe('UNESTABLISHED');
    expect(result.lifecycle).toEqual({ status: 'CLOSED', reason: 'SESSION_NOT_OPENED', reasonDetail: null });
    // session がないので、Safety の記録は空である（違反を作らない）。
    expect(result.safety.invariantViolationCount).toBe(0);
    expect(result.safety.invariantViolations).toEqual([]);
    expect(Object.isFrozen(result)).toBe(true);
  }, DEADLINE_TEST_TIMEOUT_MS);

  it('closes a session that arrives after the session open deadline', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    const late = createDeferred<InteractionGuardedSession>();
    const closed = createDeferred<undefined>();
    let closeCalls = 0;
    let gotoCalls = 0;
    const lateSession: InteractionGuardedSession = {
      page: { context: fakeGuardContext, goto: async () => { gotoCalls += 1; } } as unknown as Page,
      ledger: new SafetyLedger(),
      activateInteractionFreeze: async () => undefined,
      isClosed: () => closeCalls > 0,
      close: async () => {
        closeCalls += 1;
        closed.resolve(undefined);
      },
    };

    const result = await auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => late.promise,
      sessionOpenTimeoutMs: SHORT_SESSION_OPEN_TIMEOUT_MS,
    });
    expectReason(result, SESSION_OPEN_DEADLINE_REASON);
    expect(closeCalls).toBe(0);
    late.resolve(lateSession);
    await closed.promise;

    expect(closeCalls).toBe(1);
    // 遅れて届いた session では、読み込みも操作もしない。
    expect(gotoCalls).toBe(0);
  }, DEADLINE_TEST_TIMEOUT_MS);

  it('hands a session open failure that arrives after the deadline to the receiver, without an unhandled rejection', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    const late = createDeferred<InteractionGuardedSession>();
    const received = createDeferred<unknown>();
    const lateFailure = new Error('late session open failure');
    let receiverCalls = 0;

    const unhandled = await collectUnhandled(async () => {
      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        sessionFactory: async () => late.promise,
        sessionOpenTimeoutMs: SHORT_SESSION_OPEN_TIMEOUT_MS,
        releaseLateSessionFailure: (error: unknown) => {
          receiverCalls += 1;
          received.resolve(error);
        },
      });
      expectReason(result, SESSION_OPEN_DEADLINE_REASON);
      late.reject(lateFailure);
      await expect(received.promise).resolves.toBe(lateFailure);
    });

    expect(receiverCalls).toBe(1);
    expect(unhandled).toEqual([]);
  }, DEADLINE_TEST_TIMEOUT_MS);

  it('still rejects with a session open failure before the deadline, without calling the late receiver', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    const failure = new Error('session open failure before the deadline');
    let receiverCalls = 0;

    await expect(auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => { throw failure; },
      sessionOpenTimeoutMs: SHORT_SESSION_OPEN_TIMEOUT_MS,
      releaseLateSessionFailure: () => {
        receiverCalls += 1;
      },
    })).rejects.toBe(failure);
    expect(receiverCalls).toBe(0);
  }, DEADLINE_TEST_TIMEOUT_MS);

  it('stops waiting for a freeze activation that does not finish, without changing the violation record', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    const ledger = new SafetyLedger();
    const page = {
      context: fakeGuardContext, goto: async () => undefined,
      evaluate: async () => true,
    } as unknown as Page;
    let closeCalls = 0;
    const session: InteractionGuardedSession = {
      page: withScrollPreparation(page, candidate),
      ledger,
      // Guard の `failClosed` と同じく、違反を記録してから、Context の無効化を待ち続ける。
      activateInteractionFreeze: async (): Promise<never> => {
        ledger.recordInvariantViolation({
          code: 'INTERACTION_FREEZE_ACTIVATION_FAILED',
          message: 'injected freeze activation failure',
        });
        return new Promise<never>(() => undefined);
      },
      ...fakeCloseLifecycle(async () => {
        closeCalls += 1;
      }),
    };
    const startedAt = performance.now();

    const result = await auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => session,
      freezeActivationTimeoutMs: SHORT_FREEZE_TIMEOUT_MS,
    });
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(RETURN_LIMIT_MS);
    // 凍結の失敗と同じ扱い（EXECUTION_FAILED）で、click の前に止まる。
    expect(result.status).toBe('EXECUTION_FAILED');
    expectReason(result, 'EXECUTION_FAILED', FREEZE_DEADLINE_REASON_DETAIL);
    expect(result.evidence.identityStatus).toBe('UNESTABLISHED');
    // 違反の記録は、凍結の処理が記録したものだけで、期限切れの違反を加えない。
    expect(result.safety.invariantViolations).toEqual([
      { code: 'INTERACTION_FREEZE_ACTIVATION_FAILED', message: 'injected freeze activation failure' },
    ]);
    expect(closeCalls).toBe(1);
    expect(result.lifecycle).toEqual({ status: 'CLOSED', reason: null, reasonDetail: null });
  }, DEADLINE_TEST_TIMEOUT_MS);

  it.each([
    ['a zero session open timeout', { sessionOpenTimeoutMs: 0 }],
    ['a non-integer freeze activation timeout', { freezeActivationTimeoutMs: 1.5 }],
    ['a late failure receiver that is not a function', { releaseLateSessionFailure: 'not a function' }],
  ])('rejects %s without opening a session', async (_label, invalid) => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    let factoryCalls = 0;

    await expect(auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => {
        factoryCalls += 1;
        throw new Error('must not open a session');
      },
      ...invalid,
    } as unknown as InteractionAuditInput)).rejects.toThrow(/timeout|receiver/u);
    expect(factoryCalls).toBe(0);
  });
});

// SU2b（サイトが応答しないときに Run を止める設計書 2.1）: 候補の対象のページの読み込み（`page.goto`）の観測を、注入された受け口
// （`afterTargetLoad`）に渡す。観測は `src/browser/main-frame-load.ts` の部品で作り、Interaction は判定をしない（判定は Page Auditor）。
// 503 を返すページは、共通の fixture のサーバにないので、このテストの中の 127.0.0.1 のサーバで、accordion の fixture の文書を
// 200 と 503 で返す。Guard の許可 Origin が、そのサーバになるよう、別の factory を作る。
describe('the observation of the target load of an interaction candidate (site unavailability design 2.1)', () => {
  /** 503 Service Unavailable（サイトの不調の代表。判定は Page Auditor が行う）。 */
  const STATUS_SERVICE_UNAVAILABLE = 503;
  const STATUS_OK = 200;
  const STATUS_NOT_FOUND = 404;
  /** パスごとの status。どのパスも、accordion の fixture の文書を返す。 */
  const STATUS_PATHS = Object.freeze({
    '/available.html': STATUS_OK,
    '/unavailable.html': STATUS_SERVICE_UNAVAILABLE,
  } as const);
  type StatusPath = keyof typeof STATUS_PATHS;
  const CANDIDATE_NAME = 'Toggle details';

  let statusOrigin: string;
  let statusFactory: BrowserContextFactory;
  let closeStatusServer: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const accordion = await readFile(resolve(process.cwd(), 'fixtures/site/accordion.html'), 'utf8');
    const statusServer = await startLoopbackHttpServer((request, response) => {
      const path = (request.url ?? '/').split(/[?#]/u, 1)[0] ?? '/';
      const status = Object.hasOwn(STATUS_PATHS, path) ? STATUS_PATHS[path as StatusPath] : STATUS_NOT_FOUND;
      response.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(accordion),
      });
      response.end(accordion);
    });
    closeStatusServer = statusServer.close;
    statusOrigin = statusServer.origin;
    statusFactory = new BrowserContextFactory(browser, configFor(statusOrigin), () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
  });

  afterAll(async () => {
    await closeStatusServer?.();
  });

  function statusInput(path: StatusPath, candidate: InteractionCandidate): InteractionAuditInput {
    return interactionAuditInput({ factory: statusFactory, origin: statusOrigin, viewport, path, candidate });
  }

  it.each(Object.entries(STATUS_PATHS) as [StatusPath, number][])(
    'passes the observation of the target load of %s (HTTP %d) to afterTargetLoad, and audits as without it',
    async (path, status) => {
      const candidate = await discoverInteractionCandidate(statusFactory, statusOrigin, viewport, path, CANDIDATE_NAME, {
        expectedCompleteness: 'COMPLETE',
      });
      const observations: MainFrameLoadObservation[] = [];

      const observed = await auditInteraction({
        ...statusInput(path, candidate),
        afterTargetLoad: (observation) => {
          observations.push(observation);
        },
      });
      // 受け口を省略した監査（今までの呼び出し）と、結果の状態と理由が同じである（受け口は判定をせず、結果を変えない）。
      const unobserved = await auditInteraction(statusInput(path, candidate));

      expect(observations).toEqual([{ navigationOutcome: 'OK', httpStatus: status, failureDetail: null }]);
      expect(Object.isFrozen(observations[0])).toBe(true);
      expect({ status: observed.status, reason: observed.reason })
        .toEqual({ status: unobserved.status, reason: unobserved.reason });
    },
  );

  it('does not call afterTargetLoad when no budget is left to start the target load', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    // 偽の時計の始まりの時刻と、読み込みの期限（ms）。session の作成が読み込みの期限の時刻に終わるので、読み込みの予算は 0 になる。
    const startedAtMs = 1_000;
    const navigationTimeoutMs = 2_000;
    const navigationDeadlineAtMs = startedAtMs + navigationTimeoutMs;
    let gotoCalls = 0;
    const observations: MainFrameLoadObservation[] = [];
    vi.useFakeTimers();
    vi.setSystemTime(startedAtMs);
    const session: InteractionGuardedSession = {
      page: {
        context: fakeGuardContext, goto: async () => { gotoCalls += 1; },
      } as unknown as Page,
      ledger: new SafetyLedger(),
      activateInteractionFreeze: async () => undefined,
      ...fakeCloseLifecycle(),
    };
    try {
      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        navigationTimeoutMs,
        timeoutMs: GATE_INTERACTION_TIMING.timeoutMs,
        deadlineAtMs: navigationDeadlineAtMs + GATE_INTERACTION_TIMING.overallMs,
        sessionFactory: async () => {
          vi.setSystemTime(navigationDeadlineAtMs);
          return session;
        },
        afterTargetLoad: (observation) => {
          observations.push(observation);
        },
      });

      expectReason(result, 'INITIAL_LOAD_BEFORE_LOAD');
      expect(gotoCalls).toBe(0);
      expect(observations).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects an afterTargetLoad that is not a function without opening a session', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    let factoryCalls = 0;

    await expect(auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: async () => {
        factoryCalls += 1;
        throw new Error('must not open a session');
      },
      afterTargetLoad: 'not a function',
    } as unknown as InteractionAuditInput)).rejects.toThrow(/receiver/u);
    expect(factoryCalls).toBe(0);
  });
});

/**
 * DEF-046（設計書 `2026-10-08-beaksight-def-044-046-review-fixes-design.md` 3）: Interaction の結果の区分（`hasFreezeEvent`）は、
 * `blockedInteractionRequests` のうち、Guard が止めたページの要求（理由 `INTERACTION_FROZEN`）だけを数える。出口の中継の記録
 * （`INTERACTION_FROZEN_EGRESS`、`EGRESS_UPSTREAM_DENIED`）は、Chromium 自身の通信を含みうるので数えない（Ledger には残る）。
 * 本物の Guard の付いた session の凍結の直後に、Ledger に記録を 1 件加えて、変化を確かめられる候補（`/accordion.html`）を監査する。
 */
describe('DEF-046: the egress proxy records do not make the Interaction result BLOCKED_BY_SAFETY', () => {
  /** 凍結の直後に、理由 `reason` の記録を Ledger に 1 件加える session の factory。 */
  const sessionRecordingAfterFreeze = (reason: BlockedInteractionRequestEvent['reason']) => async (
    sessionViewport: Viewport,
  ): Promise<InteractionGuardedSession> => {
    const session = await factory.createInteractionSession(sessionViewport);
    return Object.freeze({
      ...session,
      activateInteractionFreeze: async (): Promise<void> => {
        await session.activateInteractionFreeze();
        session.ledger.recordBlockedInteractionRequest({ method: 'CONNECT', url: 'https://unrelated.example.test:443', reason });
      },
    });
  };

  it.each(['INTERACTION_FROZEN_EGRESS', 'EGRESS_UPSTREAM_DENIED'] as const)('an egress proxy record (%s) alone does not make the result BLOCKED_BY_SAFETY, and stays in the Ledger', async (reason) => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');

    const result = await auditInteraction({ ...input('/accordion.html', candidate), sessionFactory: sessionRecordingAfterFreeze(reason) });

    expect(result.status).toBe('VERIFIED');
    expect(result.safety.blockedInteractionRequests).toEqual([
      { method: 'CONNECT', url: 'https://unrelated.example.test:443', reason },
    ]);
    expect(result.safety.invariantViolations).toEqual([]);
  });

  it('control: a record of the Guard (INTERACTION_FROZEN) makes the result BLOCKED_BY_SAFETY', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');

    const result = await auditInteraction({
      ...input('/accordion.html', candidate),
      sessionFactory: sessionRecordingAfterFreeze('INTERACTION_FROZEN'),
    });

    expect(result.status).toBe('BLOCKED_BY_SAFETY');
    expectReason(result, 'SAFETY_FREEZE_BLOCKED');
  });
});
}

/**
 * SLIM BD-5: 凍結の直後の close の競合（DEF-045）のテストを登録する（`isolated-interaction-audit.test.ts` が呼ぶ。両方の Chromium に広げる組は
 * `chromiumRunsOf` を通す）。本文は、分ける前の位置と字下げのまま。
 */
export function registerFrozenCloseRaceCases(): void {
/** DEF-045 の実機の確かめで、1 ms ごとに POST を出すページ（`fixtures/site/`）。 */
const FROZEN_CLOSE_RACE_PAGE = '/frozen-close-race-posts.html';
/**
 * DEF-045 の実機の確かめで、凍結 → owner の close をくり返す回数。NPR-T21R2 の再現の実験では、修正の前に、どちらの Chromium でも
 * 10 回のうち 1〜3 回で違反が出た。値は `test-rounds.ts`（TS-b。ふだんの組も、回ごとのずらし方を全部通る 5 回）。
 */
const FROZEN_CLOSE_RACE_ROUNDS = roundsOf('frozenCloseRace');
/** 読み込みから凍結までの待ちの、基本の時間と、回ごとにずらす幅・種類の数（閉じる瞬間と、一時停止した要求の重なり方を変える）。 */
const FROZEN_CLOSE_RACE_BEFORE_FREEZE_MS = 50;
const FROZEN_CLOSE_RACE_BEFORE_FREEZE_STEP_MS = 23;
const FROZEN_CLOSE_RACE_BEFORE_FREEZE_STEPS = 5;
/** 凍結から owner の close までの待ちの、基本の時間と、回ごとにずらす幅・種類の数。 */
const FROZEN_CLOSE_RACE_BEFORE_CLOSE_MS = 50;
const FROZEN_CLOSE_RACE_BEFORE_CLOSE_STEP_MS = 40;
const FROZEN_CLOSE_RACE_BEFORE_CLOSE_STEPS = 3;
/** 1 回の上限の目安（ms。読み込み、待ち、閉じる処理）。テストの期限の計算に使う。 */
const FROZEN_CLOSE_RACE_ROUND_BUDGET_MS = 3_000;
const FROZEN_CLOSE_RACE_TEST_TIMEOUT_MS = FROZEN_CLOSE_RACE_ROUNDS * FROZEN_CLOSE_RACE_ROUND_BUDGET_MS
  + FROZEN_POPUP_LATE_DELIVERY_SETTLE_MS;

/**
 * DEF-045（設計書 `2026-10-08-beaksight-def-044-046-review-fixes-design.md` 2）: 1 ms ごとに POST（sendBeacon、keepalive の fetch）を出す
 * ページを、Interaction の session で読み込み、凍結してから owner の close（`session.close()`）を行う。これを
 * `FROZEN_CLOSE_RACE_ROUNDS` 回くり返し、どの回も、違反 0、閉じる処理が成功（無効化で reject しない）であること、全部の回の後に
 * `FROZEN_POPUP_LATE_DELIVERY_SETTLE_MS` 待ってから、GET・HEAD 以外の要求がサーバに届いていないことを確かめる。テストの既定の
 * headless shell と、CLI の起動の設定（`chromiumLaunchOptions`）の両方で確かめる。
 */
describe.each(chromiumRunsOf([
  { name: 'the headless shell (test default)', launch: (): Promise<Browser> => launchHeadlessChromium() },
  // EL-12: 本番と同じ起動の部品（`launchCliChromium`）で起動する。
  { name: 'the CLI Chromium (chromiumLaunchOptions, headless)', launch: (): Promise<Browser> => launchCliChromium() },
]))('DEF-045: the owner close right after the freeze of a page that keeps posting, with $name', ({ name, launch }) => {
  let raceBrowser: Browser;
  let raceFactory: BrowserContextFactory;

  beforeAll(async () => {
    raceBrowser = await launch();
    raceFactory = new BrowserContextFactory(raceBrowser, configFor(server.origin), () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
  });

  afterAll(async () => {
    await raceBrowser?.close();
  });

  it('records no violation and closes without invalidation in every round, and no POST reaches the server', async () => {
    const allRoundsWindow = openServerWindow(server);
    const rounds: unknown[] = [];
    const failedRounds: unknown[] = [];
    for (let round = 0; round < FROZEN_CLOSE_RACE_ROUNDS; round += 1) {
      const session = await raceFactory.createInteractionSession(viewport);
      let closeFailure: string | null = null;
      try {
        await session.page.goto(`${server.origin}${FROZEN_CLOSE_RACE_PAGE}`, { waitUntil: 'load' });
        await wait(FROZEN_CLOSE_RACE_BEFORE_FREEZE_MS + (round % FROZEN_CLOSE_RACE_BEFORE_FREEZE_STEPS) * FROZEN_CLOSE_RACE_BEFORE_FREEZE_STEP_MS);
        await session.activateInteractionFreeze();
        await wait(FROZEN_CLOSE_RACE_BEFORE_CLOSE_MS + (round % FROZEN_CLOSE_RACE_BEFORE_CLOSE_STEPS) * FROZEN_CLOSE_RACE_BEFORE_CLOSE_STEP_MS);
      } finally {
        await session.close().catch((error: unknown) => {
          closeFailure = String(error);
        });
      }
      const snapshot = session.ledger.snapshot();
      const summary = {
        round,
        invariantViolations: snapshot.invariantViolations,
        closeFailure,
        frozenRecords: snapshot.blockedInteractionRequests.filter((entry) => entry.reason === 'INTERACTION_FROZEN').length,
      };
      rounds.push(summary);
      if (summary.invariantViolations.length !== 0 || summary.closeFailure !== null) {
        failedRounds.push(summary);
      }
    }
    await wait(FROZEN_POPUP_LATE_DELIVERY_SETTLE_MS);
    console.info(`DEF-045 ${name}: ${JSON.stringify(rounds)}`);

    expect(failedRounds).toEqual([]);
    expect(rounds.every((round) => (round as { readonly frozenRecords: number }).frozenRecords > 0)).toBe(true);
    expect(allRoundsWindow.count(null, '/__mutation')).toBe(0);
    expect(allRoundsWindow.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
  }, FROZEN_CLOSE_RACE_TEST_TIMEOUT_MS);
});
}
