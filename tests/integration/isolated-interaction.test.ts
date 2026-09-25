import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Browser, Page } from 'playwright';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { BrowserContextFactory, type InteractionGuardedSession } from '../../src/browser/context-factory.js';
import type { AuditConfig, Viewport } from '../../src/config/types.js';
import type { InteractionStatus } from '../../src/core/contracts.js';
import { wait } from '../../src/core/deadline.js';
import {
  INTERACTION_IDENTITY_STATUSES,
  INTERACTION_LIFECYCLE_REASON_CODES,
  INTERACTION_NOT_VERIFIABLE_REASON_CODES,
  INTERACTION_REASON_CODES,
  INTERACTION_REASON_CODES_BY_STATUS,
  type InteractionChangeEvidence,
  type InteractionClosedLifecycle,
  type InteractionLifecycleReasonCode,
  type InteractionReasonCode,
  type InteractionWorkOutcome,
} from '../../src/core/evidence-types.js';
import { VISIBILITY_CHECK_OPTIONS } from '../../src/core/visibility.js';
import {
  changedInteractionAttributeNames,
  changedInteractionClassNames,
  compareInteractionAttributeRecords,
  compareInteractionScrollRecords,
  discoverInteractionCandidates,
  hasExplicitTabRole,
  inspectInteractionCandidateHandle,
  resolveInteractionCandidateHandle,
  INTERACTION_CANDIDATE_SELECTOR,
} from '../../src/interaction/discover-candidates.js';
import {
  auditInteraction as auditInteractionUnderTest,
  INTERACTION_NOT_VERIFIABLE_REASONS,
  InteractionOwnerCleanupError,
  type InteractionAuditInput,
  type InteractionNonTerminalLifecycle,
} from '../../src/interaction/isolated-auditor.js';
import {
  collectInteractionChangeEvidence,
  INTERACTION_NON_EVIDENCE_ATTRIBUTES,
  INTERACTION_NON_EVIDENCE_NAME_PATTERN,
  MAX_CHANGED_ATTRIBUTE_NAMES,
  retainPersistentInteractionChanges,
} from '../../src/evidence/interaction-collector.js';
import {
  classifyInteractionCandidate,
  INTERACTION_CANDIDATE_LIMITS,
  type InteractionCandidate,
} from '../../src/safety/interaction-policy.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { useHeadlessChromium } from '../helpers/chromium.js';
import { createDeferred } from '../helpers/deferred.js';
import { discoverInteractionCandidate, interactionAuditInput, withGuardedPassivePage } from '../helpers/gate-harness.js';
import { createTestConfig } from '../helpers/test-config.js';

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
 * - 探し直しの completeness の値: `CANDIDATE_REDISCOVERY_INCOMPLETE`
 * - 切断の後の identityStatus の値: `RETAINED_IDENTITY_LOST`
 */
const ERROR_DETAIL_REASON_CODES: ReadonlySet<string> = new Set([
  'SCROLL_PREPARATION_FAILED',
  'HOVER_PREPARATION_FAILED',
  'FOCUS_PREPARATION_FAILED',
  'CLICK_TIMED_OUT',
  'CLICK_FAILED',
  'EXECUTION_FAILED',
  'OWNER_CLOSE_FAILED',
]);
const REDISCOVERY_INCOMPLETE_DETAILS = ['CANDIDATE_LIMIT_REACHED', 'DOM_WORK_BUDGET_REACHED', 'TEXT_NODE_LIMIT_REACHED'];
/** 理由のコードの形（英数字と `_`）。英文の理由は、この形にならない。 */
const REASON_CODE_PATTERN = /^[A-Z][A-Z_]*$/u;

/** 理由の詳細が、コードに合う形か（詳細を持たないコードでは null、エラーの文言は空でない上限内の文字列）。 */
function expectReasonDetailFits(code: string, detail: string | null): void {
  if (code === 'CANDIDATE_REDISCOVERY_INCOMPLETE') {
    expect(REDISCOVERY_INCOMPLETE_DETAILS, code).toContain(detail);
  } else if (code === 'RETAINED_IDENTITY_LOST') {
    expect(INTERACTION_IDENTITY_STATUSES, code).toContain(detail);
  } else if (ERROR_DETAIL_REASON_CODES.has(code)) {
    if (detail !== null) {
      expect(typeof detail, code).toBe('string');
      expect(detail.length, code).toBeGreaterThan(0);
      expect(detail.length, code).toBeLessThanOrEqual(512);
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
    result = await auditInteractionUnderTest(input);
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
 * F06b: 凍結の前の下準備（探索・handle の解決・スクロール・hover・focus・安定性の確認・破棄）だけを、DOM の作業量0の別の偽の handle で
 * 受け持つ。凍結の後の経路を確かめる既存のテストで、偽のページの呼び出しの順序・作業量・handle を、これまでどおり凍結の後の経路に
 * 届けるために使う。最初の探索（引数付きの `evaluate`）と、最初の handle の解決（`evaluateHandle`）だけを受け持ち、
 * ほかの呼び出しは元の偽のページに渡す。
 * F16（設計書 4.4.1 の安定性の確認）で是正: 下準備の handle は、安定性の確認で観測される。変わらない候補の記録を返す。
 * `preparedAttributes` を渡すと、その属性の記録も返す（安定性の確認の終わりと click の前の属性を比べられるようにする）。
 * F20（設計書 4.4.2 手順4、R8 の Important-2）で是正: 下準備の focus の前後では、属性の記録を比べ、比べられない場合は凍結せずに終える。
 * 実際のブラウザは記録を必ず返すので、`preparedAttributes` を渡さない場合は、属性のない記録を返す。
 */
function withScrollPreparation(page: Page, candidate: InteractionCandidate, preparedAttributes?: unknown): Page {
  let discoveryServed = false;
  let resolutionServed = false;
  const preparationHandle = {
    evaluate: async () => ({
      status: 'CONNECTED',
      domWorkUsed: 0,
      raw: rawCandidateFor(candidate),
      attributes: preparedAttributes ?? { complete: true, entries: [] },
    }),
    scrollIntoViewIfNeeded: async () => undefined,
    hover: async () => undefined,
    focus: async () => undefined,
    dispose: async () => undefined,
  };
  return new Proxy(page, {
    get(target, property, receiver) {
      const original: unknown = Reflect.get(target, property, receiver);
      if (property === 'evaluate' && typeof original === 'function') {
        return async (callback: unknown, argument?: unknown) => {
          if (argument !== undefined && !discoveryServed) {
            discoveryServed = true;
            return { candidates: [rawCandidateFor(candidate)], completeness: 'COMPLETE', domWorkUsed: 0 };
          }
          return (original as (...args: unknown[]) => unknown).call(target, callback, argument);
        };
      }
      if (property === 'evaluateHandle' && (typeof original === 'function' || !resolutionServed)) {
        // 元の偽のページに evaluateHandle がなくても、下準備の解決は受け持つ。凍結の後の解決は、元の偽のページに渡す。
        return async (...args: unknown[]) => {
          if (!resolutionServed) {
            resolutionServed = true;
            return boundedResolutionEnvelope(preparationHandle);
          }
          return (original as (...args: unknown[]) => unknown).apply(target, args);
        };
      }
      return original;
    },
  });
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
  return {
    evaluateHandle: async () => envelope,
  } as unknown as Page;
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
  factory = new BrowserContextFactory(browser, configFor(server.origin), () => new SafetyLedger());
});

/**
 * 候補の探索のテストで、探索の途中や後の Guard の違反を見逃さないための指定（RC18 の M4）。閉じる処理の失敗は捨てるので、
 * page と Context を閉じる前に、Safety Ledger の違反が0件であることを確かめる。
 */
const EXPECT_NO_GUARD_VIOLATIONS = Object.freeze({ expectNoViolations: true });

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

it('exports bounded exact-handle resolution API', async () => {
  const discoveryModule = await import('../../src/interaction/discover-candidates.js');
  expect(discoveryModule).toHaveProperty('resolveInteractionCandidateHandle');
});

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

async function installTotalTraversalProbe(page: Page): Promise<() => Promise<number>> {
  await page.evaluate(() => {
    const original = document.createTreeWalker.bind(document);
    let count = 0;
    Object.defineProperty(document, 'createTreeWalker', {
      configurable: true,
      value(root: Node, whatToShow: number, filter?: NodeFilter | null) {
        const walker = original(root, whatToShow, filter);
        return new Proxy(walker, {
          get(target, property) {
            if (property !== 'nextNode') return Reflect.get(target, property, target);
            return () => {
              const node = target.nextNode();
              if (node !== null && ++count > 16_384) throw new Error('Total DOM traversal exceeded 16,384');
              return node;
            };
          },
        });
      },
    });
    Object.defineProperty(globalThis, '__totalDomTraversalCount', { get: () => count });
  });
  return () => page.evaluate(() => (
    globalThis as typeof globalThis & { readonly __totalDomTraversalCount: number }
  ).__totalDomTraversalCount);
}

/**
 * 文書の要素の走査（`document.documentElement` を根とする SHOW_ELEMENT の TreeWalker）で、対象の前に `preceding` 個の
 * 一致しない要素を返す偽の TreeWalker を入れる。DOM作業量の境界を、祖先の数によらず正確に作るために使う。
 * 文書の根は走査の最初に1回数えるので、対象に達するまでの消費は `1 + preceding` になる。
 */
async function installPrecedingWorkWalker(page: Page, targetSelector: string, preceding: number): Promise<void> {
  await page.evaluate(({ selector, count }) => {
    const target = document.querySelector(selector);
    if (target === null) throw new Error('Missing preceding-work target');
    const dummy = document.createElement('div');
    const originalCreateTreeWalker = document.createTreeWalker.bind(document);
    Object.defineProperty(document, 'createTreeWalker', {
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

/** 要素の `getBoundingClientRect` を読んだ回数を数える。 */
async function installGeometryReadCounter(page: Page, targetSelector: string): Promise<() => Promise<number>> {
  await page.evaluate((selector) => {
    const target = document.querySelector(selector);
    if (target === null) throw new Error('Missing geometry target');
    const original = target.getBoundingClientRect.bind(target);
    let reads = 0;
    target.getBoundingClientRect = () => {
      reads += 1;
      return original();
    };
    Object.defineProperty(globalThis, '__geometryReads', { configurable: true, get: () => reads });
  }, targetSelector);
  return () => page.evaluate(() => (
    globalThis as typeof globalThis & { readonly __geometryReads: number }
  ).__geometryReads);
}

it('avoids whole-DOM selector enumeration during discovery', async () => {
  const page = await totalBudgetPage();
  try {
    await page.evaluate(() => {
      Document.prototype.querySelectorAll = () => { throw new Error('Forbidden whole-DOM query'); };
    });
    await expect(discoverInteractionCandidates(page)).resolves.toBeDefined();
  } finally { await page.close(); }
});

it('reports total DOM work exhaustion before a late candidate with immutable completeness', async () => {
  const page = await totalBudgetPage('no-early-candidate');
  try {
    const count = await installTotalTraversalProbe(page);
    const result = await discoverInteractionCandidates(page);
    expect(result.completeness).toBe('DOM_WORK_BUDGET_REACHED');
    expect(result.domWorkUsed).toBe(16_384);
    expect(result.candidates).toEqual([]);
    expect(await count()).toBeLessThanOrEqual(result.domWorkUsed);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.candidates)).toBe(true);
  } finally { await page.close(); }
});

// C3（設計書 2026-09-23 5.5）: 可視判定は祖先をたどらず checkVisibility を1回呼ぶごとに作業量1を消費する。
// 祖先の走査の消費を前提にしていた旧テストを、可視判定の消費が走査と同じ上限を共有することの検証に置き換えた。
it('shares visibility-check work and discards a partial early candidate on budget exhaustion', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<button id="early" type="button" aria-controls="panel" aria-label="Early candidate">x</button><div id="panel">Panel</div>');
    // 根1 + 前の要素 + 候補の走査と一致判定2 + aria-controls の解決1 + 制御対象の可視判定1 + テキスト1 + 候補の可視判定1 = 16,384
    await installPrecedingWorkWalker(page, '#early', 16_377);
    const readTargetGeometry = await installGeometryReadCounter(page, '#early');

    const result = await discoverInteractionCandidates(page);

    expect(result.completeness).toBe('DOM_WORK_BUDGET_REACHED');
    expect(result.domWorkUsed).toBe(16_384);
    expect(result.candidates).toEqual([]);
    expect(await readTargetGeometry()).toBe(0);
  } finally { await page.close(); }
});

it('uses shared text and enumeration work across candidate subtrees', async () => {
  const page = await totalBudgetPage('many-candidate-subtrees');
  try {
    const count = await installTotalTraversalProbe(page);
    const result = await discoverInteractionCandidates(page);
    expect(result.completeness).toBe('TEXT_NODE_LIMIT_REACHED');
    expect(result.domWorkUsed).toBeLessThan(16_384);
    expect(result.candidates).toEqual([]);
    expect(result.candidates.some(({ accessibleName }) => accessibleName === 'Repeated candidate 99')).toBe(false);
    expect(await count()).toBeLessThanOrEqual(result.domWorkUsed);
  } finally { await page.close(); }
});

it('bounded exact-handle resolution preserves the child after envelope disposal without whole-DOM queries', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<button type="button">Retained child</button>');
    await page.evaluate(() => {
      Document.prototype.querySelectorAll = () => { throw new Error('Forbidden whole-DOM query'); };
    });
    const resolution = await resolveInteractionCandidateHandle(page, 0);
    expect(resolution.status).toBe('FOUND');
    if (resolution.status !== 'FOUND') throw new Error('Expected retained child');
    try {
      expect(await resolution.handle.evaluate((element) => element.isConnected)).toBe(true);
      expect(Object.isFrozen(resolution)).toBe(true);
      const snapshot = await inspectInteractionCandidateHandle(resolution.handle, 0);
      expect(snapshot).toMatchObject({ status: 'CONNECTED', candidate: { accessibleName: 'Retained child' } });
    } finally { await resolution.handle.dispose(); }
  } finally { await page.close(); }
});

it('bounded exact-handle resolution distinguishes late-target budget exhaustion from missing', async () => {
  const page = await totalBudgetPage('no-early-candidate');
  try {
    const count = await installTotalTraversalProbe(page);
    expect(await resolveInteractionCandidateHandle(page, 0)).toEqual({ status: 'DOM_WORK_BUDGET_REACHED', domWorkUsed: 16_384 });
    expect(await count()).toBeLessThanOrEqual(16_384);
  } finally { await page.close(); }
});

// C3（設計書 2026-09-23 5.5）: 祖先の走査ではなく、候補自身の可視判定が最後の作業量を消費する形に置き換えた。
it('retained inspection reports shared visibility-check budget exhaustion distinctly from disconnected', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<button id="early" type="button" aria-controls="panel" aria-label="Early candidate">x</button><div id="panel">Panel</div>');
    const handle = await page.locator('#early').elementHandle();
    if (handle === null) throw new Error('Missing early fixture node');
    try {
      // 根1 + 前の要素 + 対象の走査と一致判定2 + 事実の収集の開始1 + aria-controls の解決1 + 制御対象の可視判定1
      // + テキスト1 + 候補の可視判定1 = 16,384
      await installPrecedingWorkWalker(page, '#early', 16_376);
      const readTargetGeometry = await installGeometryReadCounter(page, '#early');

      expect(await inspectInteractionCandidateHandle(handle, 0)).toEqual({ status: 'DOM_WORK_BUDGET_REACHED', domWorkUsed: 16_384 });
      expect(await readTargetGeometry()).toBe(0);
    } finally { await handle.dispose(); }
  } finally { await page.close(); }
});

it('retained inspection reports late live-ordinal budget exhaustion distinctly from disconnected', async () => {
  const page = await totalBudgetPage('no-early-candidate');
  const handle = await page.locator('button').elementHandle();
  if (handle === null) throw new Error('Missing late fixture node');
  try {
    const count = await installTotalTraversalProbe(page);
    expect(await inspectInteractionCandidateHandle(handle, 0)).toEqual({ status: 'DOM_WORK_BUDGET_REACHED', domWorkUsed: 16_384 });
    expect(await count()).toBeLessThanOrEqual(16_384);
  } finally { await handle.dispose(); await page.close(); }
});

// C3（設計書 2026-09-23 5.5）: 可視判定が祖先をたどらなくなったため、候補の事実の側の消費を、制御対象の祖先の鎖から
// 候補の子孫のテキスト走査に置き換えた。前の要素の走査と事実の収集が、1つの上限を共有することを検証する。
it('retained inspection shares total DOM work between live ordinal and candidate facts', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<button type="button" aria-label="Combined">Combined</button>');
    await page.evaluate(() => {
      const button = document.querySelector('button')!;
      for (let index = 0; index < 16_000; index += 1) button.before(document.createElement('div'));
      // テキストのノード上限（512）より先に、DOM作業量の上限に達する数の子孫。
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
    if (handle === null) throw new Error('Missing combined fixture node');
    try {
      expect(await inspectInteractionCandidateHandle(handle, 0)).toEqual({ status: 'DOM_WORK_BUDGET_REACHED', domWorkUsed: 16_384 });
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
      await resolution.handle.evaluate((element) => element.remove());
      expect(await inspectInteractionCandidateHandle(resolution.handle, 0)).toMatchObject({ status: 'DISCONNECTED' });
    } finally { await resolution.handle.dispose(); }
  } finally { await page.close(); }
});

describe('Task 2 correction boundaries', () => {
  it('stops before retained candidate facts when exact identity consumes the final work unit', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<button type="button" aria-controls="controlled">Boundary</button><div id="controlled"></div>');
      const handle = await page.locator('button').elementHandle();
      if (handle === null) throw new Error('Missing boundary candidate');
      try {
        await page.evaluate(() => {
          const target = document.querySelector('button')!;
          const dummy = document.createElement('div');
          const originalCreateTreeWalker = document.createTreeWalker.bind(document);
          const originalRootMatches = document.documentElement.matches.bind(document.documentElement);
          let rootInspected = false;
          let factReads = 0;
          let descendantWalkers = 0;
          document.documentElement.matches = ((selector: string) => {
            rootInspected = true;
            return originalRootMatches(selector);
          }) as typeof document.documentElement.matches;
          const originalGetAttribute = target.getAttribute.bind(target);
          target.getAttribute = ((name: string) => {
            factReads += 1;
            return originalGetAttribute(name);
          }) as typeof target.getAttribute;
          Object.defineProperty(document, 'createTreeWalker', {
            configurable: true,
            value(root: Node, whatToShow: number, filter?: NodeFilter | null) {
              if (root === document.documentElement && whatToShow === NodeFilter.SHOW_ELEMENT) {
                let index = 0;
                return {
                  nextNode(): Node | null {
                    index += 1;
                    const preceding = rootInspected ? 16_381 : 16_382;
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
            get: () => ({ factReads, descendantWalkers }),
          });
        });

        expect(await inspectInteractionCandidateHandle(handle, 0)).toEqual({
          status: 'DOM_WORK_BUDGET_REACHED',
          domWorkUsed: 16_384,
        });
        expect(await page.evaluate(() => (
          globalThis as typeof globalThis & {
            readonly __retainedIdentityBoundary: { readonly factReads: number; readonly descendantWalkers: number };
          }
        ).__retainedIdentityBoundary)).toEqual({ factReads: 0, descendantWalkers: 0 });
      } finally {
        await handle.dispose();
      }
    } finally {
      await page.close();
    }
  });

  // C3（設計書 2026-09-23 5.5）: 制御対象の祖先の鎖（Proxy）で作業量を消費させる形から、前の要素の走査で消費させ、
  // 制御対象の可視判定（checkVisibility の1回）が最後の作業量を消費する形に置き換えた。
  it('stops before geometry after the final retained visibility debit', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<button type="button" aria-controls="controlled" aria-label="Boundary">Boundary</button><div id="controlled" style="width:1px;height:1px"></div>');
      const handle = await page.locator('button').elementHandle();
      if (handle === null) throw new Error('Missing visibility boundary candidate');
      try {
        // 根1 + 前の要素 + 対象の走査と一致判定2 + 事実の収集の開始1 + aria-controls の解決1 + 制御対象の可視判定1 = 16,384
        await installPrecedingWorkWalker(page, 'button', 16_378);
        const readControlledGeometry = await installGeometryReadCounter(page, '#controlled');

        expect(await inspectInteractionCandidateHandle(handle, 0)).toEqual({
          status: 'DOM_WORK_BUDGET_REACHED',
          domWorkUsed: 16_384,
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
        await expect(inspectInteractionCandidateHandle(resolution.handle, 0)).resolves.toMatchObject({
          status: 'CONNECTED',
          candidate: { ordinal: 1, accessibleName: 'Target' },
        });
      } finally {
        await resolution.handle.dispose();
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

        await expect(inspectInteractionCandidateHandle(resolution.handle, 0)).resolves.toMatchObject({
          status: 'CONNECTED',
          candidate: { ordinal: 99, accessibleName: 'Target' },
        });
      } finally {
        await resolution.handle.dispose();
      }
    } finally {
      await page.close();
    }
  });

  it('reports candidate-limit incompleteness when the exact retained node moves to live ordinal 100', async () => {
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

        const snapshot = await inspectInteractionCandidateHandle(resolution.handle, 0);
        expect(snapshot).toEqual({
          status: 'CANDIDATE_LIMIT_REACHED',
          domWorkUsed: expect.any(Number),
        });
        expect(snapshot.status).not.toBe('DISCONNECTED');
        expect(Object.hasOwn(snapshot, 'candidate')).toBe(false);
        expect(Object.isFrozen(snapshot)).toBe(true);
      } finally {
        await resolution.handle.dispose();
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
        expect(await resolution.handle.evaluate((element) => element === document.documentElement)).toBe(true);
        await expect(inspectInteractionCandidateHandle(resolution.handle, 0)).resolves.toMatchObject({
          status: 'CONNECTED',
          candidate: { ordinal: 0, tagName: 'html', accessibleName: 'Root candidate' },
        });
      } finally {
        await resolution.handle.dispose();
      }
    } finally {
      await page.close();
    }
  });

  it('Task 2 fix round 2 shares the secondary text cap across accessible-name and normalized-text work', async () => {
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

      expect(discovery.completeness).toBe('TEXT_NODE_LIMIT_REACHED');
      expect(discovery.candidates).toEqual([]);
      expect(await readAcceptedTextNodes()).toBe(INTERACTION_CANDIDATE_LIMITS.maxTextNodes);
      expect(discovery.domWorkUsed).toBeLessThan(INTERACTION_CANDIDATE_LIMITS.maxDomWork);
    } finally {
      await page.close();
    }
  });

  it('Task 2 fix round 2 shares the secondary text cap across candidates', async () => {
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

      expect(discovery.completeness).toBe('TEXT_NODE_LIMIT_REACHED');
      expect(discovery.candidates.map(({ accessibleName }) => accessibleName)).toEqual(['First']);
      expect(await readAcceptedTextNodes()).toBe(INTERACTION_CANDIDATE_LIMITS.maxTextNodes);
      expect(discovery.domWorkUsed).toBeLessThan(INTERACTION_CANDIDATE_LIMITS.maxDomWork);
    } finally {
      await page.close();
    }
  });

  it('Task 2 fix round 2 shares the retained secondary text cap across accessible-name and normalized-text work', async () => {
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

        await expect(inspectInteractionCandidateHandle(resolution.handle, 0)).resolves.toEqual({
          status: 'TEXT_NODE_LIMIT_REACHED',
          domWorkUsed: expect.any(Number),
        });
        expect(await readAcceptedTextNodes()).toBe(INTERACTION_CANDIDATE_LIMITS.maxTextNodes);
      } finally {
        await resolution.handle.dispose();
      }
    } finally {
      await page.close();
    }
  });
});

describe('Task 2 correction resolver ownership and envelope validation', () => {
  function probeProperty(
    name: string,
    disposed: string[],
    options: {
      readonly value?: unknown;
      readonly element?: unknown;
      readonly readError?: Error;
      readonly disposeError?: Error;
    } = {},
  ) {
    return {
      async jsonValue() {
        if (options.readError !== undefined) throw options.readError;
        return options.value;
      },
      asElement: () => options.element ?? null,
      async dispose() {
        disposed.push(name);
        if (options.disposeError !== undefined) throw options.disposeError;
      },
    };
  }

  it('cleans every acquired resolver property when status reading fails', async () => {
    const disposed: string[] = [];
    const candidate = probeProperty('element', disposed);
    const envelope = injectedResolutionEnvelope(new Map([
      ['status', probeProperty('status', disposed, { readError: new Error('status read failed') })],
      ['domWorkUsed', probeProperty('domWorkUsed', disposed, { value: 1 })],
      ['element', candidate],
      ['extra', probeProperty('extra', disposed, { value: 'unused' })],
    ]), async () => { disposed.push('envelope'); });

    await expect(resolveInteractionCandidateHandle(injectedResolutionPage(envelope), 0)).rejects.toThrow('status read failed');
    expect(disposed.sort()).toEqual(['domWorkUsed', 'element', 'envelope', 'extra', 'status'].sort());
  });

  it('Task 2 fix round 2 preserves an undefined resolver rejection after successful cleanup', async () => {
    const disposed: string[] = [];
    const undefinedRejectingStatus = {
      jsonValue: async (): Promise<never> => Promise.reject(undefined),
      asElement: () => null,
      dispose: async () => { disposed.push('status'); },
    };
    const envelope = injectedResolutionEnvelope(new Map([
      ['status', undefinedRejectingStatus],
      ['domWorkUsed', probeProperty('domWorkUsed', disposed, { value: 1 })],
      ['element', probeProperty('element', disposed)],
      ['extra', probeProperty('extra', disposed, { value: 'unused' })],
    ]), async () => { disposed.push('envelope'); });

    await expect(resolveInteractionCandidateHandle(injectedResolutionPage(envelope), 0)).rejects.toBeUndefined();
    expect(disposed.sort()).toEqual(['domWorkUsed', 'element', 'envelope', 'extra', 'status'].sort());
  });

  it('Task 2 fix round 2 retains undefined primary presence with cleanup failures', async () => {
    const disposed: string[] = [];
    const cleanupError = new Error('metadata cleanup failed');
    const undefinedRejectingStatus = {
      jsonValue: async (): Promise<never> => Promise.reject(undefined),
      asElement: () => null,
      dispose: async () => { disposed.push('status'); },
    };
    const envelope = injectedResolutionEnvelope(new Map([
      ['status', undefinedRejectingStatus],
      ['domWorkUsed', probeProperty('domWorkUsed', disposed, { value: 1, disposeError: cleanupError })],
      ['element', probeProperty('element', disposed)],
      ['extra', probeProperty('extra', disposed, { value: 'unused' })],
    ]), async () => { disposed.push('envelope'); });

    let rejection: unknown;
    try {
      await resolveInteractionCandidateHandle(injectedResolutionPage(envelope), 0);
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(AggregateError);
    expect((rejection as AggregateError).errors).toEqual([undefined, cleanupError]);
    expect(disposed.sort()).toEqual(['domWorkUsed', 'element', 'envelope', 'extra', 'status'].sort());
  });

  it('attempts all resolver cleanup after metadata disposal fails and reclaims the prospective FOUND child', async () => {
    const disposed: string[] = [];
    const candidate = probeProperty('element', disposed);
    candidate.asElement = () => candidate;
    const envelope = injectedResolutionEnvelope(new Map([
      ['status', probeProperty('status', disposed, { value: 'FOUND', disposeError: new Error('status dispose failed') })],
      ['domWorkUsed', probeProperty('domWorkUsed', disposed, { value: 2 })],
      ['element', candidate],
      ['extra', probeProperty('extra', disposed, { value: 'unused' })],
    ]), async () => { disposed.push('envelope'); });

    await expect(resolveInteractionCandidateHandle(injectedResolutionPage(envelope), 0)).rejects.toThrow('status dispose failed');
    expect(disposed.sort()).toEqual(['domWorkUsed', 'element', 'envelope', 'extra', 'status'].sort());
  });

  it('disposes unknown resolver properties on a successful non-FOUND envelope', async () => {
    const disposed: string[] = [];
    const envelope = injectedResolutionEnvelope(new Map([
      ['status', probeProperty('status', disposed, { value: 'MISSING' })],
      ['domWorkUsed', probeProperty('domWorkUsed', disposed, { value: 2 })],
      ['extra', probeProperty('extra', disposed, { value: 'unused' })],
    ]), async () => { disposed.push('envelope'); });

    await expect(resolveInteractionCandidateHandle(injectedResolutionPage(envelope), 0)).resolves.toEqual({
      status: 'MISSING',
      domWorkUsed: 2,
    });
    expect(disposed.sort()).toEqual(['domWorkUsed', 'envelope', 'extra', 'status'].sort());
  });

  it('reclaims a prospective FOUND child when envelope cleanup fails before transfer', async () => {
    const disposed: string[] = [];
    const candidate = probeProperty('element', disposed);
    candidate.asElement = () => candidate;
    const envelope = injectedResolutionEnvelope(new Map([
      ['status', probeProperty('status', disposed, { value: 'FOUND' })],
      ['domWorkUsed', probeProperty('domWorkUsed', disposed, { value: 2 })],
      ['element', candidate],
    ]), async () => {
      disposed.push('envelope');
      throw new Error('envelope dispose failed');
    });

    await expect(resolveInteractionCandidateHandle(injectedResolutionPage(envelope), 0)).rejects.toThrow('envelope dispose failed');
    expect(disposed.sort()).toEqual(['domWorkUsed', 'element', 'envelope', 'status'].sort());
  });

  it.each([
    ['unknown status', new Map<string, unknown>([['status', 'UNKNOWN'], ['domWorkUsed', 0]])],
    ['negative work', new Map<string, unknown>([['status', 'MISSING'], ['domWorkUsed', -1]])],
    ['out-of-range work', new Map<string, unknown>([['status', 'MISSING'], ['domWorkUsed', 16_385]])],
    ['fractional work', new Map<string, unknown>([['status', 'MISSING'], ['domWorkUsed', 1.5]])],
    ['missing FOUND child', new Map<string, unknown>([['status', 'FOUND'], ['domWorkUsed', 2]])],
    ['non-element FOUND child', new Map<string, unknown>([['status', 'FOUND'], ['domWorkUsed', 2], ['element', null]])],
    ['contradictory MISSING child', new Map<string, unknown>([['status', 'MISSING'], ['domWorkUsed', 2], ['element', 'element']])],
    ['contradictory budget child', new Map<string, unknown>([['status', 'DOM_WORK_BUDGET_REACHED'], ['domWorkUsed', 2], ['element', 'element']])],
  ] as const)('rejects malformed resolver envelope: %s', async (_label, values) => {
    const disposed: string[] = [];
    let candidate: ReturnType<typeof probeProperty> | undefined;
    const properties = new Map<string, unknown>();
    for (const [name, value] of values) {
      if (name === 'element') {
        candidate = probeProperty('element', disposed);
        if (value === 'element') candidate.asElement = () => candidate as ReturnType<typeof probeProperty>;
        properties.set(name, candidate);
      } else {
        properties.set(name, probeProperty(name, disposed, { value }));
      }
    }
    const envelope = injectedResolutionEnvelope(properties, async () => { disposed.push('envelope'); });
    await expect(resolveInteractionCandidateHandle(injectedResolutionPage(envelope), 0)).rejects.toThrow();
    expect(disposed).toContain('envelope');
    expect(disposed).toEqual(expect.arrayContaining([...properties.keys()]));
  });

  it.each([
    ['null container', null],
    ['array container', []],
    ['unknown status', { status: 'UNKNOWN', domWorkUsed: 0 }],
    ['negative work', { status: 'DISCONNECTED', domWorkUsed: -1 }],
    ['out-of-range work', { status: 'DOM_WORK_BUDGET_REACHED', domWorkUsed: 16_385 }],
    ['fractional work', { status: 'DISCONNECTED', domWorkUsed: 1.5 }],
    ['missing CONNECTED raw', { status: 'CONNECTED', domWorkUsed: 1 }],
    ['contradictory DISCONNECTED raw', { status: 'DISCONNECTED', domWorkUsed: 1, raw: {} }],
    ['contradictory budget raw', { status: 'DOM_WORK_BUDGET_REACHED', domWorkUsed: 1, raw: {} }],
    ['contradictory candidate-limit raw', { status: 'CANDIDATE_LIMIT_REACHED', domWorkUsed: 1, raw: {} }],
    ['out-of-range candidate-limit work', { status: 'CANDIDATE_LIMIT_REACHED', domWorkUsed: 16_385 }],
  ] as const)('rejects malformed retained snapshot: %s', async (_label, value) => {
    const handle = { evaluate: async () => value } as unknown as Parameters<typeof inspectInteractionCandidateHandle>[0];
    await expect(inspectInteractionCandidateHandle(handle, 0)).rejects.toThrow();
  });

  it('accepts an immutable candidate-limit retained snapshot without a candidate payload', async () => {
    const handle = {
      evaluate: async () => ({ status: 'CANDIDATE_LIMIT_REACHED', domWorkUsed: 205 }),
    } as unknown as Parameters<typeof inspectInteractionCandidateHandle>[0];

    const snapshot = await inspectInteractionCandidateHandle(handle, 0);

    expect(snapshot).toEqual({ status: 'CANDIDATE_LIMIT_REACHED', domWorkUsed: 205 });
    expect(Object.hasOwn(snapshot, 'candidate')).toBe(false);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });
});

/** Guard の付いた Passive の page で `path` を開き、名前が `name` の候補を探す（探索は COMPLETE であること。CC-029 の共通の補助）。 */
function candidateNamed(path: string, name: string): Promise<InteractionCandidate> {
  return discoverInteractionCandidate(factory, server.origin, viewport, path, name, { expectedCompleteness: 'COMPLETE' });
}

/** `path` の `candidate` を、`factory` の Interaction の session で監査する入力（期限は、共通の補助の `GATE_INTERACTION_TIMING`）。 */
function input(path: string, candidate: InteractionCandidate): InteractionAuditInput {
  return interactionAuditInput({ factory, origin: server.origin, viewport, path, candidate });
}

async function installTextTraversalCounter(page: Page): Promise<() => Promise<number>> {
  await page.evaluate(() => {
    const original = document.createTreeWalker.bind(document);
    let acceptedTextNodes = 0;
    Object.defineProperty(document, 'createTreeWalker', {
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
  return () => page.evaluate(() => (
    globalThis as typeof globalThis & { readonly __acceptedTextNodes: number }
  ).__acceptedTextNodes);
}

async function installTraversalProbe(page: Page): Promise<() => Promise<number>> {
  await page.evaluate((maxNodes) => {
    const original = document.createTreeWalker.bind(document);
    let nextNodeCalls = 0;
    Object.defineProperty(document, 'createTreeWalker', {
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
  }, INTERACTION_CANDIDATE_LIMITS.maxTextNodes);
  return async () => page.evaluate(() => (
    globalThis as typeof globalThis & { readonly __beakSightTraversalCount: number }
  ).__beakSightTraversalCount);
}

async function installAggregateTraversalProbe(page: Page): Promise<() => Promise<number>> {
  await page.evaluate((maxNodes) => {
    const original = document.createTreeWalker.bind(document);
    let nonNullNextNodeCalls = 0;
    Object.defineProperty(document, 'createTreeWalker', {
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
  }, INTERACTION_CANDIDATE_LIMITS.maxTextNodes);
  return async () => page.evaluate(() => (
    globalThis as typeof globalThis & { readonly __beakSightAggregateTraversalCount: number }
  ).__beakSightAggregateTraversalCount);
}

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

  it('retains at most 100 candidates and bounds every persisted name', async () => {
    const candidates = await discover('/candidate-overflow.html', 'CANDIDATE_LIMIT_REACHED');

    expect(candidates).toHaveLength(100);
    expect(candidates.at(-1)?.ordinal).toBe(99);
    expect(candidates.every((candidate) => candidate.accessibleName.length <= 256)).toBe(true);
    expect(candidates.every(Object.isFrozen)).toBe(true);
  });

  it('does not iterate a hostile NodeList or materialize full descendant text during discovery', async () => {
    await withGuardedPassivePage(factory, viewport, async (page) => {
      await page.goto(`${server.origin}/hostile-candidates.html`, { waitUntil: 'load' });
      await page.evaluate((maxTextNodes) => {
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
        Object.defineProperty(document, 'createTreeWalker', {
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
      }, INTERACTION_CANDIDATE_LIMITS.maxTextNodes);

      const discovery = await discoverInteractionCandidates(page);
      expect(discovery.completeness).toBe('TEXT_NODE_LIMIT_REACHED');
      const candidates = discovery.candidates;

      expect(candidates).toEqual([]);
    }, EXPECT_NO_GUARD_VIOLATIONS);
  });

  it('bounds total descendant nodes during discovery with all-node traversal', async () => {
    await withGuardedPassivePage(factory, viewport, async (page) => {
      await page.goto(`${server.origin}/hostile-candidates.html`, { waitUntil: 'load' });
      const readNextNodeCalls = await installTraversalProbe(page);

      const discovery = await discoverInteractionCandidates(page);
      expect(discovery.completeness).toBe('TEXT_NODE_LIMIT_REACHED');
      const candidates = discovery.candidates;
      const nextNodeCalls = await readNextNodeCalls();

      expect(nextNodeCalls).toBeLessThanOrEqual(INTERACTION_CANDIDATE_LIMITS.maxTextNodes);
      expect(candidates).toEqual([]);
    }, EXPECT_NO_GUARD_VIOLATIONS);
  });

  it('bounds total descendant nodes during retained inspection with all-node traversal', async () => {
    await withGuardedPassivePage(factory, viewport, async (page) => {
      await page.goto(`${server.origin}/hostile-candidates.html`, { waitUntil: 'load' });
      const handle = await page.locator(INTERACTION_CANDIDATE_SELECTOR).first().elementHandle();
      if (handle === null) {
        throw new Error('fixture candidate handle missing');
      }
      try {
        const readNextNodeCalls = await installTraversalProbe(page);

        await expect(inspectInteractionCandidateHandle(handle, 0)).resolves.toMatchObject({
          status: 'TEXT_NODE_LIMIT_REACHED',
        });
        const nextNodeCalls = await readNextNodeCalls();

        expect(nextNodeCalls).toBeLessThanOrEqual(INTERACTION_CANDIDATE_LIMITS.maxTextNodes);
      } finally {
        await handle.dispose();
      }
    }, EXPECT_NO_GUARD_VIOLATIONS);
  });

  it('shares the aggregate descendant-node budget across label roots during discovery', async () => {
    await withGuardedPassivePage(factory, viewport, async (page) => {
      await page.goto(`${server.origin}/multi-root-candidates.html`, { waitUntil: 'load' });
      const readNextNodeCalls = await installAggregateTraversalProbe(page);

      const discovery = await discoverInteractionCandidates(page);
      expect(discovery.completeness).toBe('TEXT_NODE_LIMIT_REACHED');
      const candidates = discovery.candidates;
      const nextNodeCalls = await readNextNodeCalls();

      expect(nextNodeCalls).toBe(INTERACTION_CANDIDATE_LIMITS.maxTextNodes);
      expect(candidates).toEqual([]);
    }, EXPECT_NO_GUARD_VIOLATIONS);
  });

  it('shares the aggregate descendant-node budget across label roots during retained inspection', async () => {
    await withGuardedPassivePage(factory, viewport, async (page) => {
      await page.goto(`${server.origin}/multi-root-candidates.html`, { waitUntil: 'load' });
      const handle = await page.locator(INTERACTION_CANDIDATE_SELECTOR).first().elementHandle();
      if (handle === null) {
        throw new Error('fixture candidate handle missing');
      }
      try {
        const readNextNodeCalls = await installAggregateTraversalProbe(page);

        await expect(inspectInteractionCandidateHandle(handle, 0)).resolves.toMatchObject({
          status: 'TEXT_NODE_LIMIT_REACHED',
        });
        const nextNodeCalls = await readNextNodeCalls();

        expect(nextNodeCalls).toBe(INTERACTION_CANDIDATE_LIMITS.maxTextNodes);
      } finally {
        await handle.dispose();
      }
    }, EXPECT_NO_GUARD_VIOLATIONS);
  });

  it('inspects a retained handle without iterating the candidate NodeList', async () => {
    await withGuardedPassivePage(factory, viewport, async (page) => {
      await page.goto(`${server.origin}/accordion.html`, { waitUntil: 'load' });
      const handle = await page.locator(INTERACTION_CANDIDATE_SELECTOR).first().elementHandle();
      if (handle === null) {
        throw new Error('fixture candidate handle missing');
      }
      try {
        await page.evaluate(() => {
          Object.defineProperty(NodeList.prototype, Symbol.iterator, {
            configurable: true,
            value(): never {
              throw new Error('NodeList iterator must not be used');
            },
          });
        });

        await expect(inspectInteractionCandidateHandle(handle, 0)).resolves.toMatchObject({ status: 'CONNECTED' });
      } finally {
        await handle.dispose();
      }
    }, EXPECT_NO_GUARD_VIOLATIONS);
  });

  it('keeps a connected retained handle outside the ordinal cap distinct from disconnection', async () => {
    await withGuardedPassivePage(factory, viewport, async (page) => {
      await page.goto(`${server.origin}/candidate-overflow.html`, { waitUntil: 'load' });
      const handle = await page.locator(INTERACTION_CANDIDATE_SELECTOR).nth(100).elementHandle();
      if (handle === null) {
        throw new Error('overflow fixture candidate handle missing');
      }
      try {
        await expect(inspectInteractionCandidateHandle(handle, 99)).resolves.toEqual({
          status: 'CANDIDATE_LIMIT_REACHED',
          domWorkUsed: expect.any(Number),
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

describe('isolated fail-closed interaction audit', () => {
  it('Task 2 fix round 2 keeps identity unestablished when the initial load consumes the deadline', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const page = {
      goto: async () => { vi.setSystemTime(3_000); },
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
      page: { goto: async (): Promise<never> => { throw new Error('navigation work failed'); } } as unknown as Page,
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
      page: { goto: async (): Promise<never> => { throw new Error(message); } } as unknown as Page,
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
      goto: async () => undefined,
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
      goto: async () => undefined,
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
      goto: async () => undefined,
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

  it('Task 2 fix round 2 keeps identity unestablished after disconnection and incomplete rediscovery', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    const rawCandidate = rawCandidateFor(candidate);
    const snapshots = [
      { status: 'CONNECTED', domWorkUsed: 10, raw: rawCandidate },
      { status: 'DISCONNECTED', domWorkUsed: 10 },
    ];
    let snapshotIndex = 0;
    let discoveryIndex = 0;
    const targetHandle = {
      evaluate: async () => snapshots[snapshotIndex++],
      click: async () => undefined,
      dispose: async () => undefined,
    };
    const page = {
      goto: async () => undefined,
      evaluate: async (_callback: unknown, argument?: unknown) => {
        if (argument === undefined) return true;
        discoveryIndex += 1;
        return discoveryIndex === 1
          ? { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 20 }
          : { candidates: [], completeness: 'DOM_WORK_BUDGET_REACHED', domWorkUsed: 16_344 };
      },
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
    expectReason(result, 'DOM_WORK_EXHAUSTED');
    expect(result.evidence.identityStatus).toBe('UNESTABLISHED');
  });

  it.each(['pre-admission inspection', 'retained observation'] as const)(
    'Task 11 final quality maps candidate-limit %s directly without disconnected rediscovery',
    async (branch) => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const rawCandidate = rawCandidateFor(candidate);
      const snapshots = branch === 'pre-admission inspection'
        ? [{ status: 'CANDIDATE_LIMIT_REACHED', domWorkUsed: 205 }]
        : [
            { status: 'CONNECTED', domWorkUsed: 10, raw: rawCandidate },
            { status: 'CANDIDATE_LIMIT_REACHED', domWorkUsed: 205 },
          ];
      let snapshotIndex = 0;
      let discoveryCount = 0;
      const targetHandle = {
        evaluate: async () => snapshots[snapshotIndex++],
        click: async () => {
          if (branch === 'pre-admission inspection') {
            throw new Error('candidate-limit pre-admission must not click');
          }
        },
        dispose: async () => undefined,
      };
      const page = {
        goto: async () => undefined,
        evaluate: async (_callback: unknown, argument?: unknown) => {
          if (argument === undefined) return true;
          discoveryCount += 1;
          if (discoveryCount > 1) {
            throw new Error('candidate-limit retained inspection must not rediscover');
          }
          return { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 20 };
        },
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
      expect(result.reason).toBe(branch === 'pre-admission inspection'
        ? 'TARGET_INSPECTION_CANDIDATE_LIMIT_REACHED'
        : 'RETAINED_INSPECTION_CANDIDATE_LIMIT_REACHED');
      expect(result.evidence).toMatchObject({
        identityStatus: 'UNESTABLISHED',
        after: null,
      });
      expect(result.evidence.identityStatus).not.toBe('MISSING');
      expect(result.evidence.identityStatus).not.toBe('REPLACED');
      expect(discoveryCount).toBe(1);
    },
  );

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
        goto: async () => undefined,
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

  it.each([
    'rediscovery',
    'resolution',
    'pre-admission inspection',
    'retained observation',
  ] as const)('Task 2 correction represents incomplete %s identity as unestablished', async (branch) => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    const rawCandidate = rawCandidateFor(candidate);
    const snapshots = branch === 'pre-admission inspection'
      ? [{ status: 'DOM_WORK_BUDGET_REACHED', domWorkUsed: 16_364 }]
      : branch === 'retained observation'
        ? [
            { status: 'CONNECTED', domWorkUsed: 10, raw: rawCandidate },
            { status: 'DOM_WORK_BUDGET_REACHED', domWorkUsed: 16_354 },
          ]
        : [];
    let snapshotIndex = 0;
    const targetHandle = {
      evaluate: async () => snapshots[snapshotIndex++],
      click: async () => undefined,
      dispose: async () => undefined,
    };
    const property = (value: unknown, element: unknown = null) => ({
      jsonValue: async () => value,
      asElement: () => element,
      dispose: async () => undefined,
    });
    const resolutionEnvelope = branch === 'resolution'
      ? injectedResolutionEnvelope(new Map([
          ['status', property('DOM_WORK_BUDGET_REACHED')],
          ['domWorkUsed', property(16_364)],
        ]))
      : boundedResolutionEnvelope(targetHandle);
    const page = {
      goto: async () => undefined,
      evaluate: async (_callback: unknown, argument?: unknown) => (
        argument === undefined
          ? true
          : branch === 'rediscovery'
            ? { candidates: [], completeness: 'DOM_WORK_BUDGET_REACHED', domWorkUsed: 16_384 }
            : { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 20 }
      ),
      evaluateHandle: async () => resolutionEnvelope,
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
    expectReason(result, 'DOM_WORK_EXHAUSTED');
    expect(result.evidence.identityStatus).toBe('UNESTABLISHED');
  });

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

  it.each([
    ['/popup-button.html', 'Open popup', 'blockedPopups', '/popup-target.html'],
    ['/navigation-button.html', 'Attempt navigation', 'blockedInteractionNavigations', '/navigation-target.html'],
    ['/websocket.html', 'Open WebSocket', 'blockedInteractionWebSockets', '/socket'],
    ['/mutation-button.html', 'Attempt mutation', 'blockedInteractionRequests', '/__mutation'],
  ] as const)('blocks an admitted %s action before its target reaches the server', async (
    path,
    name,
    ledgerKey,
    forbiddenPath,
  ) => {
    const candidate = await candidateNamed(path, name);
    server.resetCounters();
    server.resetRequestObservations();

    const result = await auditInteraction(input(path, candidate));

    expect(result.status).toBe('BLOCKED_BY_SAFETY');
    expect(result.safety[ledgerKey].length).toBeGreaterThan(0);
    expect(server.getRequestObservations().some((entry) => entry.pathname === forbiddenPath)).toBe(false);
    expect(server.getCounters()).toMatchObject({ post: 0, put: 0, patch: 0, delete: 0, download: 0, webSocketUpgrade: 0 });
    expect(result.safety.invariantViolations).toEqual([]);
  });

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

  it('blocks an admitted HTTP download before /__download reaches the fixture server', async () => {
    const candidate = await candidateNamed('/download-button.html', 'Attempt HTTP download');
    server.resetCounters();
    server.resetRequestObservations();

    const result = await auditInteraction(input('/download-button.html', candidate));

    expect(result.status).toBe('BLOCKED_BY_SAFETY');
    expect(result.safety.blockedInteractionRequests.length).toBeGreaterThan(0);
    expect(server.getRequestObservations().some((entry) => entry.pathname === '/__download')).toBe(false);
    expect(server.getCounters().download).toBe(0);
  });

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
      const evaluateHandle = page.evaluateHandle.bind(page) as (...args: never[]) => Promise<unknown>;
      wrappedPage.evaluateHandle = (async (...args: never[]) => {
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
        return evaluateHandle(...args);
      }) as Page['evaluateHandle'];
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
    ['/missing-button.html', 'Remove candidate', 'MISSING'],
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
    // F15（設計書 4.4.1）で是正: 大きさの変化（boundingBox）は根拠にしない。hidden 属性が付くので、対象自身の属性の変化が根拠になる。
    expect(result.evidence.changedFields).toEqual(['visible', 'attributes']);
  });

  it('reports an initially duplicated semantic identity as ambiguous in reason and evidence', async () => {
    const candidate = await candidateNamed('/initial-duplicate-button.html', 'Duplicate identity');

    const result = await auditInteraction(input('/initial-duplicate-button.html', candidate));

    expect(result.status).toBe('NOT_VERIFIABLE');
    expectReason(result, 'CANDIDATE_IDENTITY_AMBIGUOUS');
    expect(result.evidence.identityStatus).toBe('AMBIGUOUS');
  });

  it.each([
    ['/mailto-link.html', 'Email fixture', 1],
    ['/tel-link.html', 'Call fixture', 1],
    ['/external-link.html', 'External resource', 1],
    ['/download-button.html', 'Direct download', 1],
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

  it('closes the owner session exactly once after a verified audit', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    let closeCalls = 0;
    let observedPage: Page | undefined;
    const sessionFactory = async (sessionViewport: Viewport): Promise<InteractionGuardedSession> => {
      const session = await factory.createInteractionSession(sessionViewport);
      observedPage = session.page;
      return Object.freeze({
        ...session,
        async close(): Promise<void> {
          closeCalls += 1;
          await session.close();
        },
      });
    };

    const result = await auditInteraction({ ...input('/accordion.html', candidate), sessionFactory });

    expect(result.status).toBe('VERIFIED');
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
    // F16（設計書 4.4.1）で是正: 凍結の前の安定性の確認は、実際に時間が進むのを待つ。偽の時計を実際の時間に合わせて進める。
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
      boundingBox: candidate.boundingBox,
    };
    const page = {
      goto: async () => undefined,
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
    // F16（設計書 4.4.1）で是正: 凍結の前の安定性の確認は、実際に時間が進むのを待つ。偽の時計を実際の時間に合わせて進める。
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
      boundingBox: candidate.boundingBox,
    };
    const page = {
      goto: async () => undefined,
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
      expectReason(result, 'DEADLINE_DURING_TARGET_HANDLE_ACQUISITION');
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
    // F16（設計書 4.4.1）で是正: 凍結の前の安定性の確認は、実際に時間が進むのを待つ。偽の時計を実際の時間に合わせて進める。
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
      boundingBox: candidate.boundingBox,
    };
    const clickError = new Error(expectedReason);
    clickError.name = errorKind === 'TimeoutError' ? 'TimeoutError' : 'Error';
    const page = {
      goto: async () => undefined,
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
      boundingBox: candidate.boundingBox,
    });
    const clickError = new Error(`${errorKind} after state change`);
    clickError.name = errorKind === 'TimeoutError' ? 'TimeoutError' : 'Error';
    const page = {
      goto: async () => undefined,
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
      boundingBox: candidate.boundingBox,
    };
    const page = {
      goto: async () => undefined,
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
      goto: async (): Promise<never> => { throw new Error('fixture work failed'); },
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
      page: { goto: async (): Promise<never> => { throw new Error('fulfilled retry work failed'); } } as unknown as Page,
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
      page: { goto: async (): Promise<never> => { throw new Error('undefined retry work failed'); } } as unknown as Page,
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
      page: { goto: async (): Promise<never> => { throw new Error('fulfilled non-terminal work failed'); } } as unknown as Page,
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
            // Guard の Context の listener（page、requestfailed、request）の数（C18a で request を加えた）。
            await expect.poll(() => contextCleanupCalls).toBe(3);
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
          message: 'Document interception session detached while its page remained active',
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
      expect(contextCleanupCalls).toBe(3);
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
        // frameが分類できないPlaywrightのリクエスト失敗は、freezeイベントを追加することなく
        // インストール済みの実際のguardを通して無効化されなければならない。
        const emitter = context as unknown as { emit(event: string, value: unknown): boolean };
        emitter.emit('requestfailed', {
          isNavigationRequest: () => true,
          frame: () => { throw new Error('lifecycle priority frame classification failed'); },
        });
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
      { code: 'FRAME_CLASSIFICATION_FAILED', message: 'lifecycle priority frame classification failed' },
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
      goto: async (): Promise<never> => { throw new Error('undefined-close work failed'); },
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
      goto: async (): Promise<never> => { throw hostileWorkError; },
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
    // F16（設計書 4.4.1）で是正: 凍結の前の安定性の確認は、実際に時間が進むのを待つ。偽の時計を実際の時間に合わせて進める。
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
      goto: async () => undefined,
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
      expectReason(result, 'DEADLINE_DURING_TARGET_HANDLE_ACQUISITION');
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
      goto: async (): Promise<never> => { throw new Error('hostile-close work failed'); },
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
      boundingBox: candidate.boundingBox,
    });
    const page = {
      goto: async () => undefined,
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
      boundingBox: candidate.boundingBox,
    });
    const page = {
      goto: async () => undefined,
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
      boundingBox: candidate.boundingBox,
    });
    const page = {
      goto: async () => undefined,
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
      boundingBox: candidate.boundingBox,
    });
    const page = {
      goto: async () => undefined,
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
      boundingBox: candidate.boundingBox,
    });
    const page = {
      goto: async () => undefined,
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
      boundingBox: candidate.boundingBox,
    };
    const page = {
      goto: async () => undefined,
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
    const resolutionEnvelopeWithWork = (handle: unknown, domWorkUsed: number) => {
      const property = (value: unknown) => ({
        jsonValue: async () => value,
        dispose: async () => undefined,
        asElement: () => value === handle ? handle : null,
      });
      return {
        getProperties: async () => new Map([
          ['status', property('FOUND')],
          ['domWorkUsed', property(domWorkUsed)],
          ['element', property(handle)],
        ]),
        dispose: async () => undefined,
      };
    };

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
              page: { goto: async (): Promise<never> => { throw new Error('deadline fixture work'); } } as unknown as Page,
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
        page: { goto: async (): Promise<never> => { throw new Error('timeout yield work'); } } as unknown as Page,
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
        page: { goto: async (): Promise<never> => { throw new Error('rejected yield work'); } } as unknown as Page,
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
        page: { goto: async (): Promise<never> => { throw new Error('late rejection work'); } } as unknown as Page,
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

    it('shares one DOM-work remainder across discovery resolution and inspection before click', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const rawCandidate = rawCandidateFor(candidate);
      const observedLimits: number[] = [];
      let disposeCalls = 0;
      let clickCalls = 0;
      const targetHandle = {
        evaluate: async (_callback: unknown, argument: { readonly limits: { readonly maxDomWork: number } }) => {
          observedLimits.push(argument.limits.maxDomWork);
          return { status: 'CONNECTED', domWorkUsed: 3_384, raw: rawCandidate };
        },
        click: async () => { clickCalls += 1; },
        dispose: async () => { disposeCalls += 1; },
      };
      const page = {
        goto: async () => undefined,
        evaluate: async (_callback: unknown, argument?: { readonly limits: { readonly maxDomWork: number } }) => {
          if (argument === undefined) return true;
          observedLimits.push(argument.limits.maxDomWork);
          return { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 8_000 };
        },
        evaluateHandle: async (_callback: unknown, argument: { readonly limits: { readonly maxDomWork: number } }) => {
          observedLimits.push(argument.limits.maxDomWork);
          return resolutionEnvelopeWithWork(targetHandle, 5_000);
        },
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

      expect(observedLimits).toEqual([16_384, 8_384, 3_384]);
      expect(observedLimits[0]! - observedLimits[1]!
        + observedLimits[1]! - observedLimits[2]!
        + observedLimits[2]!).toBe(16_384);
      expect(result.status).toBe('NOT_VERIFIABLE');
      expectReason(result, 'DOM_WORK_EXHAUSTED');
      expect(clickCalls).toBe(0);
      expect(disposeCalls).toBe(1);
    });

    it('shares the remaining DOM budget across repeated observation and disconnected fallback rediscovery', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const rawCandidate = rawCandidateFor(candidate);
      const observedLimits: number[] = [];
      const snapshots = [
        { status: 'CONNECTED', domWorkUsed: 10, raw: rawCandidate },
        { status: 'CONNECTED', domWorkUsed: 8_000, raw: rawCandidate },
        { status: 'DISCONNECTED', domWorkUsed: 100 },
      ];
      let snapshotIndex = 0;
      let discoveryIndex = 0;
      const targetHandle = {
        evaluate: async (_callback: unknown, argument: { readonly limits: { readonly maxDomWork: number } }) => {
          observedLimits.push(argument.limits.maxDomWork);
          return snapshots[snapshotIndex++];
        },
        click: async () => undefined,
        dispose: async () => undefined,
      };
      const page = {
        goto: async () => undefined,
        evaluate: async (_callback: unknown, argument?: { readonly limits: { readonly maxDomWork: number } }) => {
          if (argument === undefined) return true;
          observedLimits.push(argument.limits.maxDomWork);
          discoveryIndex += 1;
          return discoveryIndex === 1
            ? { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 10 }
            : { candidates: [], completeness: 'DOM_WORK_BUDGET_REACHED', domWorkUsed: 8_254 };
        },
        evaluateHandle: async (_callback: unknown, argument: { readonly limits: { readonly maxDomWork: number } }) => {
          observedLimits.push(argument.limits.maxDomWork);
          return resolutionEnvelopeWithWork(targetHandle, 10);
        },
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

      expect(observedLimits).toEqual([16_384, 16_374, 16_364, 16_354, 8_354, 8_254]);
      expect(result.status).toBe('NOT_VERIFIABLE');
      expectReason(result, 'DOM_WORK_EXHAUSTED');
    });

    it('disposes the exact retained handle once when resolution consumes the final DOM-work unit', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const rawCandidate = rawCandidateFor(candidate);
      let disposeCalls = 0;
      let clickCalls = 0;
      let inspectCalls = 0;
      const targetHandle = {
        evaluate: async () => {
          inspectCalls += 1;
          return { status: 'CONNECTED', domWorkUsed: 0, raw: rawCandidate };
        },
        click: async () => { clickCalls += 1; },
        dispose: async () => { disposeCalls += 1; },
      };
      const page = {
        goto: async () => undefined,
        evaluate: async (_callback: unknown, argument?: unknown) => argument === undefined
          ? true
          : { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 100 },
        evaluateHandle: async () => resolutionEnvelopeWithWork(targetHandle, 16_284),
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

      expect(result.status).toBe('NOT_VERIFIABLE');
      expectReason(result, 'DOM_WORK_EXHAUSTED');
      expect(inspectCalls).toBe(0);
      expect(clickCalls).toBe(0);
      expect(disposeCalls).toBe(1);
    });

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
      goto: async () => { hooks.onGoto?.(); },
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
        page: { goto: async (): Promise<never> => { throw new Error('fulfilled yield work'); } } as unknown as Page,
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
          'SCROLL_PREPARATION_SETTLE_DEADLINE',
          'HOVER_PREPARATION_DEADLINE',
          'FOCUS_PREPARATION_DEADLINE',
          'STABILITY_CHECK_DEADLINE',
          'DEADLINE_AFTER_SAFETY_FREEZE',
          'DEADLINE_DURING_CANDIDATE_REDISCOVERY',
          'DEADLINE_BEFORE_TARGET_HANDLE_ACQUISITION',
          'DEADLINE_DURING_TARGET_HANDLE_ACQUISITION',
          'DEADLINE_DURING_TARGET_FACT_COLLECTION',
          'DEADLINE_DURING_EXACT_NODE_ADMISSION',
          'DEADLINE_BEFORE_EXACT_NODE_CLICK',
          'DEADLINE_BEFORE_POST_CONDITION_OBSERVATION',
          'DEADLINE_DURING_POST_CONDITION_OBSERVATION',
          'PERSISTENCE_CHECK_DEADLINE',
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
          goto: async () => undefined,
          evaluate: async (_callback: unknown, argument?: unknown) => {
            if (argument === undefined) return true;
            discoveryCalls += 1;
            return lateDiscovery.promise;
          },
        } as unknown as Page;

        const settled = await settleWithin(auditInteraction({
          ...input('/accordion.html', candidate),
          // F16（設計書 4.4.1）で是正: 凍結の前の安定性の確認（500ms）を終えてから、確かめたい段階に進むよう、期限を延ばした。
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
        expectReason(result, 'DEADLINE_DURING_CANDIDATE_REDISCOVERY');
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
        goto: async () => undefined,
        evaluate: async (_callback: unknown, argument?: unknown) => (
          argument === undefined ? true : { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 20 }
        ),
        evaluateHandle: async () => lateResolution.promise,
      } as unknown as Page;

      const settled = await settleWithin(auditInteraction({
        ...input('/accordion.html', candidate),
        // F16（設計書 4.4.1）で是正: 凍結の前の安定性の確認（500ms）を終えてから、確かめたい段階に進むよう、期限を延ばした。
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
      expectReason(result, 'DEADLINE_DURING_TARGET_HANDLE_ACQUISITION');
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
        if (handle === null) throw new Error('Missing visibility fixture candidate');
        try {
          await expect(inspectInteractionCandidateHandle(handle, 0)).resolves.toMatchObject({
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
        if (handle === null) throw new Error('Missing controlled visibility fixture candidate');
        try {
          await expect(inspectInteractionCandidateHandle(handle, 0)).resolves.toMatchObject({
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
        await page.evaluate(() => {
          const original = Element.prototype.checkVisibility;
          const calls: unknown[] = [];
          Element.prototype.checkVisibility = function checkVisibility(options?: CheckVisibilityOptions) {
            calls.push(options);
            return original.call(this, options);
          };
          Object.defineProperty(globalThis, '__checkVisibilityCalls', { configurable: true, get: () => calls });
        });
        const readCalls = () => page.evaluate(() => (
          globalThis as typeof globalThis & { readonly __checkVisibilityCalls: readonly unknown[] }
        ).__checkVisibilityCalls);

        const discovery = await discoverInteractionCandidates(page);
        expect(discovery.completeness).toBe('COMPLETE');
        // 探索では、制御対象と候補自身について1回ずつ呼ぶ。
        expect(await readCalls()).toEqual([VISIBILITY_CHECK_OPTIONS, VISIBILITY_CHECK_OPTIONS]);
        const handle = await page.locator('button').elementHandle();
        if (handle === null) throw new Error('Missing option probe candidate');
        try {
          await expect(inspectInteractionCandidateHandle(handle, 0)).resolves.toMatchObject({ status: 'CONNECTED' });
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
        if (handle === null) throw new Error('Missing far candidate');
        try {
          const snapshot = await inspectInteractionCandidateHandle(handle, 0);
          if (snapshot.status !== 'CONNECTED') throw new Error('Expected connected far candidate');
          expect(snapshot.candidate.boundingBox).toEqual(initialBox);
        } finally {
          await handle.dispose();
        }
      } finally {
        await page.close();
      }
    });

    it('does not verify an inert offscreen button whose viewport position changes only by click scrolling', async () => {
      const candidate = await candidateNamed('/offscreen-inert-button.html', 'Offscreen inert');
      expect(candidate.boundingBox.y).toBeCloseTo(2008, 0);

      const result = await auditInteraction({ ...input('/offscreen-inert-button.html', candidate), timeoutMs: 1_000 });

      // 期限が切れる時点によって、クリックの後の期限切れの理由の文言が変わる（F04 の発見事項3）。
      // このテストの目的は、画面外の無反応なボタンを VERIFIED にしないことなので、クリックの後の期限切れの理由のどれかを受け付ける。
      expect(result.status, JSON.stringify(result)).toBe('NOT_VERIFIABLE');
      expect(result.status).not.toBe('VERIFIED');
      expect([
        'DEADLINE_BEFORE_POST_CONDITION_OBSERVATION',
        'DEADLINE_DURING_POST_CONDITION_OBSERVATION',
        'NO_OBSERVABLE_CHANGE',
      ]).toContain(result.reason);
      expect(result.evidence.changedFields).toEqual([]);
      if (result.evidence.after !== null) {
        expect(result.evidence.after.boundingBox).toEqual(candidate.boundingBox);
      }
    });
  });

  describe('M1: text-node limit is distinct from the DOM-work budget', () => {
    it('records the text-node limit reason when rediscovery stops at the text-node limit', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const page = {
        goto: async () => undefined,
        evaluate: async (_callback: unknown, argument?: unknown) => (
          argument === undefined ? true : { candidates: [], completeness: 'TEXT_NODE_LIMIT_REACHED', domWorkUsed: 530 }
        ),
      } as unknown as Page;

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        sessionFactory: async () => ({
          page,
          ledger: new SafetyLedger(),
          activateInteractionFreeze: async () => undefined,
          ...fakeCloseLifecycle(),
        }),
      });

      expect(result.status).toBe('NOT_VERIFIABLE');
      expectReason(result, 'CANDIDATE_REDISCOVERY_INCOMPLETE', 'TEXT_NODE_LIMIT_REACHED');
      expect(result.evidence.identityStatus).toBe('UNESTABLISHED');
    });

    it.each(['pre-admission inspection', 'retained observation'] as const)(
      'records the text-node limit reason for %s',
      async (branch) => {
        const candidate = await candidateNamed('/accordion.html', 'Toggle details');
        const rawCandidate = rawCandidateFor(candidate);
        const snapshots = branch === 'pre-admission inspection'
          ? [{ status: 'TEXT_NODE_LIMIT_REACHED', domWorkUsed: 530 }]
          : [
              { status: 'CONNECTED', domWorkUsed: 10, raw: rawCandidate },
              { status: 'TEXT_NODE_LIMIT_REACHED', domWorkUsed: 530 },
            ];
        let snapshotIndex = 0;
        let clickCalls = 0;
        const targetHandle = {
          evaluate: async () => snapshots[snapshotIndex++],
          click: async () => { clickCalls += 1; },
          dispose: async () => undefined,
        };
        const page = {
          goto: async () => undefined,
          evaluate: async (_callback: unknown, argument?: unknown) => (
            argument === undefined ? true : { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 20 }
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

        expect(result.status).toBe('NOT_VERIFIABLE');
        expect(result.reason).toBe(branch === 'pre-admission inspection'
          ? 'TARGET_INSPECTION_TEXT_NODE_LIMIT_REACHED'
          : 'RETAINED_INSPECTION_TEXT_NODE_LIMIT_REACHED');
        expect(result.evidence.identityStatus).toBe('UNESTABLISHED');
        expect(clickCalls).toBe(branch === 'pre-admission inspection' ? 0 : 1);
      },
    );
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
      const handle = {
        evaluate: async () => ({
          status: 'CONNECTED',
          domWorkUsed: 1,
          raw: { ...rawCandidateFor(candidate), boundingBox: null },
        }),
      } as unknown as Parameters<typeof inspectInteractionCandidateHandle>[0];

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

      const rejection = await discoverInteractionCandidates(page).catch((error: unknown) => error);

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
        goto: async () => undefined,
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
        // F16（設計書 4.4.1）で是正: 凍結の前の安定性の確認（500ms）を終えてから、確かめたい段階に進むよう、期限を延ばした。
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
          // F16（設計書 4.4.1）で是正: 凍結の前の安定性の確認（500ms）を終えてから、確かめたい段階に進むよう、期限を延ばした。
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

  describe('F06 R2-N4: a work-phase browser evaluation is not started after the deadline', () => {
    it('does not start the post-click inspection when the deadline passes after the last remaining-time check', async () => {
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
        goto: async () => undefined,
        evaluate: async (_callback: unknown, argument?: unknown) => (
          argument === undefined ? true : { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 20 }
        ),
        evaluateHandle: async () => boundedResolutionEnvelope(targetHandle),
      } as unknown as Page;
      // click の後、最初の残り時間の確認（観測ループの先頭）までは期限の前の時刻を返し、その次の時刻の読み取りからは期限を過ぎた時刻を返す。
      // 観測ループの先頭の確認とブラウザ内の評価の開始の間に期限が過ぎる競合を、決定的に再現する。
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
        // I15a: click の後の観測を1回も終えないまま期限が切れたので、確かめる手順を終えられなかった区分にする。
        expect(result.notVerifiableKind).toBe('CHECK_NOT_COMPLETED');
        expect(handleEvaluations).toBe(1);
      } finally {
        nowSpy.mockRestore();
      }
    });
  });

  describe('F06b R2-N1: the target is scrolled into view in the Passive phase before the safety freeze', () => {
    /** click の後の期限切れの理由（`:4402` のテストと同じ理由で、どれかを受け付ける）。 */
    const POST_CLICK_DEADLINE_REASONS = [
      'DEADLINE_BEFORE_POST_CONDITION_OBSERVATION',
      'DEADLINE_DURING_POST_CONDITION_OBSERVATION',
      'NO_OBSERVABLE_CHANGE',
    ];

    it('does not verify an inert button placed offscreen inside an inner scroll container', async () => {
      const candidate = await candidateNamed('/inner-scroll-inert-button.html', 'Inner offscreen inert');
      // 前提: ボタンは内側の領域の画面外にあり、ページ全体はスクロールしない。
      expect(candidate.boundingBox.y).toBeGreaterThan(viewport.height);

      const result = await auditInteraction({ ...input('/inner-scroll-inert-button.html', candidate), timeoutMs: 1_500 });

      expect(result.status, JSON.stringify(result)).toBe('NOT_VERIFIABLE');
      expect(POST_CLICK_DEADLINE_REASONS).toContain(result.reason);
      expect(result.evidence.changedFields).toEqual([]);
    });

    it('does not verify an inert position-fixed button on a scrolling page', async () => {
      const candidate = await candidateNamed('/fixed-inert-button.html', 'Fixed inert');

      const result = await auditInteraction({ ...input('/fixed-inert-button.html', candidate), timeoutMs: 1_500 });

      expect(result.status, JSON.stringify(result)).toBe('NOT_VERIFIABLE');
      expect(POST_CLICK_DEADLINE_REASONS).toContain(result.reason);
      expect(result.evidence.changedFields).toEqual([]);
    });

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

    /** 解決と、スクロール・破棄・凍結・click の順序を記録する偽のセッションを作る。 */
    function preparationSession(
      candidate: InteractionCandidate,
      options: {
        readonly events: string[];
        readonly scroll?: (options: { readonly timeout: number }) => Promise<void>;
        readonly hover?: (options: { readonly timeout: number }) => Promise<void>;
        readonly discoveryWork?: readonly number[];
        readonly resolutionWork?: number;
        readonly observedLimits?: number[];
      },
    ): InteractionGuardedSession {
      const rawCandidate = rawCandidateFor(candidate);
      // F16（設計書 4.4.1 の安定性の確認）で是正: 以前は観測の回数で記録を切り替えていた。下準備の handle も安定性の確認で
      // 観測されるので、click の前は元の状態、click の後は ariaExpanded が変わった状態を返す。下準備の観測の作業量は0にする。
      // F20（設計書 4.4.2 手順4）で是正: 下準備の focus の前後で属性の記録を比べるので、凍結の前は属性のない記録を返す。
      let clicked = false;
      let frozen = false;
      let discoveryIndex = 0;
      const targetHandle = {
        evaluate: async () => (clicked
          ? { status: 'CONNECTED', domWorkUsed: 10, raw: toggledRawCandidate(candidate) }
          : frozen
            ? { status: 'CONNECTED', domWorkUsed: 10, raw: rawCandidate }
            : { status: 'CONNECTED', domWorkUsed: 0, raw: rawCandidate, attributes: { complete: true, entries: [] } }),
        scrollIntoViewIfNeeded: async (scrollOptions: { readonly timeout: number }) => {
          options.events.push('scroll');
          await options.scroll?.(scrollOptions);
        },
        hover: async (hoverOptions: { readonly timeout: number }) => {
          options.events.push('hover');
          await options.hover?.(hoverOptions);
        },
        focus: async () => { options.events.push('focus'); },
        click: async () => {
          options.events.push('click');
          clicked = true;
        },
        dispose: async () => { options.events.push('dispose'); },
      };
      const envelopeProperty = (value: unknown) => ({
        jsonValue: async () => value,
        dispose: async () => undefined,
        asElement: () => value === targetHandle ? targetHandle : null,
      });
      const page = {
        goto: async () => undefined,
        evaluate: async (_callback: unknown, argument?: { readonly limits: { readonly maxDomWork: number } }) => {
          if (argument === undefined) return true;
          options.observedLimits?.push(argument.limits.maxDomWork);
          const work = options.discoveryWork ?? [20];
          const domWorkUsed = work[Math.min(discoveryIndex++, work.length - 1)];
          return { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed };
        },
        evaluateHandle: async (_callback: unknown, argument: { readonly limits: { readonly maxDomWork: number } }) => {
          options.observedLimits?.push(argument.limits.maxDomWork);
          options.events.push('resolve');
          return {
            getProperties: async () => new Map([
              ['status', envelopeProperty('FOUND')],
              ['domWorkUsed', envelopeProperty(options.resolutionWork ?? 0)],
              ['element', envelopeProperty(targetHandle)],
            ]),
            dispose: async () => undefined,
          };
        },
      } as unknown as Page;
      return {
        page,
        ledger: new SafetyLedger(),
        activateInteractionFreeze: async () => {
          options.events.push('freeze');
          frozen = true;
        },
        ...fakeCloseLifecycle(),
      };
    }

    // F15（設計書 4.4.2）で是正: 下準備の手順に、スクロールの後の hover を加えた。
    // F16（設計書 4.4.1）で是正: hover の後に focus を加えた。handle の破棄は、安定性の確認の後に行う。
    it('scrolls, hovers, and disposes the prepared handle before the freeze, then resolves again and clicks', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const events: string[] = [];

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        sessionFactory: async () => preparationSession(candidate, { events }),
      });

      expect(result.status).toBe('VERIFIED');
      expect(events).toEqual(['resolve', 'scroll', 'hover', 'focus', 'dispose', 'freeze', 'resolve', 'click', 'dispose']);
    });

    it('does not freeze or click when the pre-freeze scroll fails', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const events: string[] = [];

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        sessionFactory: async () => preparationSession(candidate, {
          events,
          scroll: async () => { throw new Error('scroll target detached'); },
        }),
      });

      expect(result.status).toBe('NOT_VERIFIABLE');
      expectReason(result, 'SCROLL_PREPARATION_FAILED', 'scroll target detached');
      expect(result.evidence.identityStatus).toBe('UNESTABLISHED');
      expect(events).toEqual(['resolve', 'scroll', 'dispose']);
    });

    it.each([
      [
        'ANSI escapes and the Playwright call log',
        [
          '\u001b[31melementHandle.scrollIntoViewIfNeeded: Element is not attached to the DOM\u001b[39m',
          'Call log:',
          '\u001b[2m  - attempting scroll into view action\u001b[22m',
        ].join('\n'),
        'elementHandle.scrollIntoViewIfNeeded: Element is not attached to the DOM',
      ],
      ['only control characters', '\u001b[31m\u0007\r\n\u001b[39m', null],
    ] as const)('normalizes a pre-freeze scroll failure reason with %s', async (_label, message, expectedReasonDetail) => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const events: string[] = [];

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        sessionFactory: async () => preparationSession(candidate, {
          events,
          scroll: async () => { throw new Error(message); },
        }),
      });

      expect(result.status).toBe('NOT_VERIFIABLE');
      expectReason(result, 'SCROLL_PREPARATION_FAILED', expectedReasonDetail);
      expect(events).toEqual(['resolve', 'scroll', 'dispose']);
    });

    it('records the deadline reason when the pre-freeze scroll times out in the browser', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const events: string[] = [];
      const timeout = new Error('scroll timed out');
      timeout.name = 'TimeoutError';

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        sessionFactory: async () => preparationSession(candidate, {
          events,
          scroll: async () => { throw timeout; },
        }),
      });

      expect(result.status).toBe('NOT_VERIFIABLE');
      expectReason(result, 'SCROLL_PREPARATION_DEADLINE');
      expect(events).toEqual(['resolve', 'scroll', 'dispose']);
    });

    it('bounds a never-settling pre-freeze scroll by the effective deadline', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const events: string[] = [];
      const neverSettles = createDeferred<void>();
      let scrollTimeout: number | undefined;

      const settled = await settleWithin(auditInteraction({
        ...input('/accordion.html', candidate),
        timeoutMs: 200,
        sessionFactory: async () => preparationSession(candidate, {
          events,
          scroll: async ({ timeout }) => {
            scrollTimeout = timeout;
            await neverSettles.promise;
          },
        }),
      }), 2_000);

      expect(settled).not.toBe('STILL_PENDING');
      const result = settled as Awaited<ReturnType<typeof auditInteraction>>;
      expect(result.status).toBe('NOT_VERIFIABLE');
      expectReason(result, 'SCROLL_PREPARATION_DEADLINE');
      expect(scrollTimeout).toBeGreaterThan(0);
      expect(scrollTimeout).toBeLessThanOrEqual(200);
      expect(events).toEqual(['resolve', 'scroll', 'dispose']);
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
        goto: async () => undefined,
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

    it('disposes a pre-freeze handle whose resolution settles only after the deadline, without freezing', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const events: string[] = [];
      const lateResolution = createDeferred<unknown>();
      let disposeCalls = 0;
      const lateHandle = {
        evaluate: async (): Promise<never> => { throw new Error('late handle must not be inspected'); },
        scrollIntoViewIfNeeded: async () => { events.push('scroll'); },
        dispose: async () => { disposeCalls += 1; },
      };
      const rawCandidate = rawCandidateFor(candidate);
      const page = {
        goto: async () => undefined,
        evaluate: async (_callback: unknown, argument?: unknown) => (
          argument === undefined ? true : { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 20 }
        ),
        evaluateHandle: async () => lateResolution.promise,
      } as unknown as Page;

      const settled = await settleWithin(auditInteraction({
        ...input('/accordion.html', candidate),
        timeoutMs: 100,
        sessionFactory: async () => ({
          page,
          ledger: new SafetyLedger(),
          activateInteractionFreeze: async () => { events.push('freeze'); },
          ...fakeCloseLifecycle(),
        }),
      }), 2_000);
      expect(settled).not.toBe('STILL_PENDING');
      const result = settled as Awaited<ReturnType<typeof auditInteraction>>;

      expect(result.status).toBe('NOT_VERIFIABLE');
      expectReason(result, 'SCROLL_PREPARATION_DEADLINE');
      lateResolution.resolve(boundedResolutionEnvelope(lateHandle));
      await expect.poll(() => disposeCalls).toBe(1);
      expect(events).toEqual([]);
    });

    it.each([
      ['rediscovery', [INTERACTION_CANDIDATE_LIMITS.maxDomWork], 0, []],
      ['handle resolution', [20], INTERACTION_CANDIDATE_LIMITS.maxDomWork - 20, ['resolve', 'dispose']],
    ] as const)('records the DOM-work reason when the pre-freeze %s exhausts the shared budget', async (
      _stage,
      discoveryWork,
      resolutionWork,
      expectedEvents,
    ) => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const events: string[] = [];

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        sessionFactory: async () => preparationSession(candidate, { events, discoveryWork, resolutionWork }),
      });

      expect(result.status).toBe('NOT_VERIFIABLE');
      expectReason(result, 'SCROLL_PREPARATION_DOM_WORK_EXHAUSTED');
      // 凍結も click も起きない。解決した handle は破棄する。
      expect(events).toEqual(expectedEvents);
    });

    it('debits the pre-freeze DOM work from the budget shared with the frozen phase', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const events: string[] = [];
      const observedLimits: number[] = [];

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        sessionFactory: async () => preparationSession(candidate, {
          events,
          observedLimits,
          discoveryWork: [1_000, 2_000],
          resolutionWork: 300,
        }),
      });

      expect(result.status).toBe('VERIFIED');
      const max = INTERACTION_CANDIDATE_LIMITS.maxDomWork;
      // 下準備の探索（1,000）と解決（300）を差し引いた残りから、凍結の後の探索（2,000）と解決が始まる。
      expect(observedLimits.slice(0, 4)).toEqual([max, max - 1_000, max - 1_300, max - 3_300]);
    });

    describe("F15 R''': the target is hovered with a bound before the freeze", () => {
      const HOVER_DEADLINE_REASON = 'HOVER_PREPARATION_DEADLINE';

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
        expectReason(result, 'HOVER_PREPARATION_FAILED', 'hover target detached');
        expect(result.evidence.identityStatus).toBe('UNESTABLISHED');
        expect(events).toEqual(['resolve', 'scroll', 'hover', 'dispose']);
      });

      it.each([
        [
          'ANSI escapes and the Playwright call log',
          [
            '\u001b[31melementHandle.hover: Element is not attached to the DOM\u001b[39m',
            'Call log:',
            '\u001b[2m  - attempting hover action\u001b[22m',
          ].join('\n'),
          'elementHandle.hover: Element is not attached to the DOM',
        ],
        ['only control characters', '\u001b[31m\u0007\r\n\u001b[39m', null],
      ] as const)('normalizes a pre-freeze hover failure reason with %s', async (_label, message, expectedReasonDetail) => {
        const candidate = await candidateNamed('/accordion.html', 'Toggle details');
        const events: string[] = [];

        const result = await auditInteraction({
          ...input('/accordion.html', candidate),
          sessionFactory: async () => preparationSession(candidate, {
            events,
            hover: async () => { throw new Error(message); },
          }),
        });

        expect(result.status).toBe('NOT_VERIFIABLE');
        expectReason(result, 'HOVER_PREPARATION_FAILED', expectedReasonDetail);
        expect(events).toEqual(['resolve', 'scroll', 'hover', 'dispose']);
      });

      it('records the hover deadline reason when the pre-freeze hover times out in the browser', async () => {
        const candidate = await candidateNamed('/accordion.html', 'Toggle details');
        const events: string[] = [];
        const timeout = new Error('hover timed out');
        timeout.name = 'TimeoutError';

        const result = await auditInteraction({
          ...input('/accordion.html', candidate),
          sessionFactory: async () => preparationSession(candidate, {
            events,
            hover: async () => { throw timeout; },
          }),
        });

        expect(result.status).toBe('NOT_VERIFIABLE');
        expectReason(result, HOVER_DEADLINE_REASON);
        expect(events).toEqual(['resolve', 'scroll', 'hover', 'dispose']);
      });

      it('bounds a never-settling pre-freeze hover by the effective deadline', async () => {
        const candidate = await candidateNamed('/accordion.html', 'Toggle details');
        const events: string[] = [];
        const neverSettles = createDeferred<void>();
        let hoverTimeout: number | undefined;

        const settled = await settleWithin(auditInteraction({
          ...input('/accordion.html', candidate),
          timeoutMs: 200,
          sessionFactory: async () => preparationSession(candidate, {
            events,
            hover: async ({ timeout }) => {
              hoverTimeout = timeout;
              await neverSettles.promise;
            },
          }),
        }), 2_000);

        expect(settled).not.toBe('STILL_PENDING');
        const result = settled as Awaited<ReturnType<typeof auditInteraction>>;
        expect(result.status).toBe('NOT_VERIFIABLE');
        expectReason(result, HOVER_DEADLINE_REASON);
        expect(hoverTimeout).toBeGreaterThan(0);
        expect(hoverTimeout).toBeLessThanOrEqual(200);
        expect(events).toEqual(['resolve', 'scroll', 'hover', 'dispose']);
      });
    });
  });

  describe("F10 R'1-N1': geometry is not evidence when a scroll ancestor scrolled during the click", () => {
    const SCROLLED_GEOMETRY_REASON = 'GEOMETRY_ONLY_CHANGED_WHILE_SCROLLED';
    const UNCOMPARABLE_GEOMETRY_REASON = 'GEOMETRY_ONLY_CHANGED_SCROLL_UNCOMPARABLE';
    const GEOMETRY_ONLY_REASON = 'GEOMETRY_ONLY_CHANGED';

    /** click の後の期限切れの理由。 */
    const POST_CLICK_DEADLINE_REASONS = [
      'DEADLINE_BEFORE_POST_CONDITION_OBSERVATION',
      'DEADLINE_DURING_POST_CONDITION_OBSERVATION',
      'NO_OBSERVABLE_CHANGE',
    ];

    // F15（設計書 4.4.2）で是正: 以前は click の再試行のスクロールで対象の位置が変わり、SCROLLED の理由になることを期待していた。
    // 下準備の hover が、覆われた対象を再試行のスクロールで帯の外に出すので、そのスクロールは凍結の前に済み、click ではスクロールしない。
    it('does not verify an inert button offscreen in an inner scroll container and covered by a fixed overlay after preparation', async () => {
      const candidate = await candidateNamed('/covered-offscreen-inert-button.html', 'Covered offscreen inert');
      // 前提: ボタンは内側の領域の画面外にある。下準備のスクロールで中央（固定表示の帯 #ov の下）に来る。
      expect(candidate.boundingBox.y).toBeGreaterThan(viewport.height);

      const result = await auditInteraction({ ...input('/covered-offscreen-inert-button.html', candidate), timeoutMs: 1_500 });

      expect(result.status, JSON.stringify(result)).toBe('NOT_VERIFIABLE');
      expect(POST_CLICK_DEADLINE_REASONS).toContain(result.reason);
      expect(result.evidence.identityStatus).toBe('MATCHED');
      expect(result.evidence.changedFields).toEqual([]);
      // 下準備の hover の再試行のスクロールは観測の前に済んでいるので、click の前後で対象の位置は変わらない。
      expect(result.evidence.after?.boundingBox.y).toBeCloseTo(result.evidence.before?.boundingBox.y ?? Number.NaN, 0);
    });

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

    it('does not verify an inert button that is covered only after the hover, when the click retry scrolls', async () => {
      const candidate = await candidateNamed('/hover-overlay-inert-button.html', 'Hover overlay inert');
      // 前提: ボタンは初めから画面内にあり、固定表示の帯 #ov（top 300px、高さ 100px）の位置にある。
      // 帯は、下準備の hover の後の2回目の mousemove（click の移動）で現れるので、click の再試行がスクロールする（設計書 4.4.3）。
      expect(candidate.boundingBox.y).toBeGreaterThanOrEqual(300);
      expect(candidate.boundingBox.bottom).toBeLessThanOrEqual(400);

      const result = await auditInteraction({ ...input('/hover-overlay-inert-button.html', candidate), timeoutMs: 2_000 });

      expect(result.status, JSON.stringify(result)).toBe('NOT_VERIFIABLE');
      expectReason(result, SCROLLED_GEOMETRY_REASON);
      expect(result.evidence.identityStatus).toBe('MATCHED');
      expect(result.evidence.changedFields).toEqual([]);
      // 再現の条件: click の再試行のスクロールで、対象の位置が実際に変わった。
      expect(result.evidence.after?.boundingBox.y).not.toBeCloseTo(result.evidence.before?.boundingBox.y ?? Number.NaN, 0);
    });

    it('verifies a covered accordion by its attribute and visibility changes without geometry evidence', async () => {
      const candidate = await candidateNamed('/covered-offscreen-accordion.html', 'Covered offscreen toggle');
      expect(candidate.boundingBox.y).toBeGreaterThan(viewport.height);

      const result = await auditInteraction(input('/covered-offscreen-accordion.html', candidate));

      expect(result.status, JSON.stringify(result)).toBe('VERIFIED');
      expect(result.evidence.changedFields).toEqual(expect.arrayContaining(['ariaExpanded', 'controlledVisible']));
      expect(result.evidence.changedFields).not.toContain('boundingBox');
    });

    it('records scroll positions of the document, inner, and open-shadow-root scroll ancestors', async () => {
      const page = await browser.newPage({ viewport });
      try {
        await page.setContent([
          '<style>html,body{margin:0}#outer{height:200px;overflow-y:auto}.pad{height:1000px}</style>',
          '<div id="outer"><div id="host"><button type="button">Slotted</button></div><div class="pad"></div></div>',
          '<div style="height:3000px"></div>',
        ].join(''));
        await page.evaluate(() => {
          const shadow = document.getElementById('host')!.attachShadow({ mode: 'open' });
          shadow.innerHTML = '<div id="inner" style="height:100px;overflow-y:scroll"><div style="height:50px"></div><slot></slot><div style="height:500px"></div></div>';
        });
        const handle = await page.locator('button').elementHandle();
        if (handle === null) throw new Error('Missing slotted candidate');
        const record = async () => {
          const snapshot = await inspectInteractionCandidateHandle(handle, 0);
          if (snapshot.status !== 'CONNECTED') throw new Error('Expected connected slotted candidate');
          return snapshot.scroll;
        };
        try {
          const initial = await record();
          // 近い祖先から: shadow root の中の #inner、#outer、最後に文書。
          expect(initial).toEqual({ status: 'RECORDED', offsets: [0, 0, 0, 0, 0, 0] });
          const scrollers = [
            ['shadow inner', () => { document.getElementById('host')!.shadowRoot!.getElementById('inner')!.scrollTop = 30; }],
            ['outer', () => { document.getElementById('outer')!.scrollTop = 40; }],
            ['document', () => { window.scrollTo(0, 50); }],
          ] as const;
          for (const [label, scroll] of scrollers) {
            await page.evaluate(scroll);
            expect(compareInteractionScrollRecords(initial, await record()), label).toBe('SCROLLED');
            await page.evaluate(() => {
              document.getElementById('host')!.shadowRoot!.getElementById('inner')!.scrollTop = 0;
              document.getElementById('outer')!.scrollTop = 0;
              window.scrollTo(0, 0);
            });
            expect(compareInteractionScrollRecords(initial, await record()), label).toBe('UNCHANGED');
          }
        } finally {
          await handle.dispose();
        }
      } finally {
        await page.close();
      }
    });

    it.each([
      // 根1 + 前の要素 + 対象の走査と一致判定2 + 事実の収集の開始1 + テキスト1 + 候補の可視判定1 の後、祖先（body、html）に1ずつ。
      ['completes the ancestor walk on the final work unit', 16_376, { status: 'RECORDED', offsets: [0, 0] }],
      ['reports an incomplete ancestor walk at the DOM-work budget', 16_377, { status: 'INCOMPLETE' }],
    ] as const)('%s', async (_label, preceding, expectedScroll) => {
      const page = await browser.newPage();
      try {
        await page.setContent('<button type="button" aria-label="Budget">x</button>');
        const handle = await page.locator('button').elementHandle();
        if (handle === null) throw new Error('Missing budget candidate');
        try {
          await installPrecedingWorkWalker(page, 'button', preceding);
          const snapshot = await inspectInteractionCandidateHandle(handle, 0);
          expect(snapshot).toMatchObject({ status: 'CONNECTED', domWorkUsed: 16_384, scroll: expectedScroll });
        } finally {
          await handle.dispose();
        }
      } finally {
        await page.close();
      }
    });

    it.each([
      ['non-object scroll record', { status: 'CONNECTED', domWorkUsed: 1, scroll: [] }],
      ['non-boolean completeness', { status: 'CONNECTED', domWorkUsed: 1, scroll: { complete: 'yes', offsets: [0, 0] } }],
      ['odd offset count', { status: 'CONNECTED', domWorkUsed: 1, scroll: { complete: true, offsets: [0] } }],
      ['non-finite offset', { status: 'CONNECTED', domWorkUsed: 1, scroll: { complete: true, offsets: [0, null] } }],
      ['contradictory DISCONNECTED scroll', { status: 'DISCONNECTED', domWorkUsed: 1, scroll: { complete: true, offsets: [0, 0] } }],
    ] as const)('rejects a malformed retained scroll record: %s', async (_label, value) => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const snapshot = value.status === 'CONNECTED' ? { ...value, raw: rawCandidateFor(candidate) } : value;
      const handle = { evaluate: async () => snapshot } as unknown as Parameters<typeof inspectInteractionCandidateHandle>[0];

      await expect(inspectInteractionCandidateHandle(handle, 0)).rejects.toThrow('Invalid bounded interaction handle snapshot');
    });

    /**
     * click の前と後の観測で、対象の位置と、スクロールの記録（`scroll`）を返す偽のセッションを作る。
     * `change` が `'TRANSLATE'` なら対象を下へ平行移動させ、`'RESIZE'` なら位置を変えずに高さを広げる。
     */
    function geometrySession(
      candidate: InteractionCandidate,
      scroll: { readonly before?: unknown; readonly after?: unknown },
      change: 'TRANSLATE' | 'RESIZE' = 'TRANSLATE',
    ): InteractionGuardedSession {
      const rawCandidate = rawCandidateFor(candidate);
      const moved = {
        ...rawCandidate,
        boundingBox: change === 'TRANSLATE'
          ? {
            ...candidate.boundingBox,
            y: candidate.boundingBox.y + 200,
            top: candidate.boundingBox.top + 200,
            bottom: candidate.boundingBox.bottom + 200,
          }
          : {
            ...candidate.boundingBox,
            height: candidate.boundingBox.height + 200,
            bottom: candidate.boundingBox.bottom + 200,
          },
      };
      const withScroll = (snapshot: Record<string, unknown>, value: unknown) => (
        value === undefined ? snapshot : { ...snapshot, scroll: value }
      );
      // 期限まで観測を繰り返すので、共有の DOM の作業量の上限に達しないよう、観測の作業量を0にする。
      const snapshots = [
        withScroll({ status: 'CONNECTED', domWorkUsed: 0, raw: rawCandidate }, scroll.before),
        withScroll({ status: 'CONNECTED', domWorkUsed: 0, raw: moved }, scroll.after),
      ];
      let snapshotIndex = 0;
      const targetHandle = {
        evaluate: async () => snapshots[Math.min(snapshotIndex++, snapshots.length - 1)],
        click: async () => undefined,
        dispose: async () => undefined,
      };
      const page = {
        goto: async () => undefined,
        evaluate: async (_callback: unknown, argument?: unknown) => (
          argument === undefined ? true : { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 20 }
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

    // F14（設計書 4.4.1）で是正: 以前は平行移動だけで VERIFIED を期待していた。
    // F15（設計書 4.4.1 の最終の方針）で是正: 以前は大きさの変化だけで VERIFIED を期待していた。位置も大きさも根拠にしない。
    it('does not verify a size-only change even when every recorded scroll position is unchanged', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const recorded = { complete: true, offsets: [0, 120, 0, 0] };

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        // F16（設計書 4.4.1）で是正: 凍結の前の安定性の確認（500ms）を終えてから、確かめたい段階に進むよう、期限を延ばした。
        timeoutMs: 1_500,
        sessionFactory: async () => geometrySession(candidate, { before: recorded, after: { ...recorded } }, 'RESIZE'),
      });

      expect(result.status, result.reason).toBe('NOT_VERIFIABLE');
      expectReason(result, GEOMETRY_ONLY_REASON);
      expect(result.evidence.changedFields).toEqual([]);
      // 大きさの変化そのものは Evidence に残る。
      expect(result.evidence.after?.boundingBox.height).toBe(candidate.boundingBox.height + 200);
    });

    it('does not verify a translation-only change even when every recorded scroll position is unchanged', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const recorded = { complete: true, offsets: [0, 120, 0, 0] };

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        // F16（設計書 4.4.1）で是正: 凍結の前の安定性の確認（500ms）を終えてから、確かめたい段階に進むよう、期限を延ばした。
        timeoutMs: 1_500,
        sessionFactory: async () => geometrySession(candidate, { before: recorded, after: { ...recorded } }, 'TRANSLATE'),
      });

      expect(result.status, result.reason).toBe('NOT_VERIFIABLE');
      expectReason(result, GEOMETRY_ONLY_REASON);
      expect(result.evidence.changedFields).toEqual([]);
      // 平行移動そのものは Evidence に残る。
      expect(result.evidence.after?.boundingBox.y).toBe(candidate.boundingBox.y + 200);
    });

    it.each(['TRANSLATE', 'RESIZE'] as const)(
      'drops geometry evidence when a recorded scroll position changed (%s)',
      async (change) => {
        const candidate = await candidateNamed('/accordion.html', 'Toggle details');

        const result = await auditInteraction({
          ...input('/accordion.html', candidate),
          // F16（設計書 4.4.1）で是正: 凍結の前の安定性の確認（500ms）を終えてから、確かめたい段階に進むよう、期限を延ばした。
          timeoutMs: 1_500,
          sessionFactory: async () => geometrySession(candidate, {
            before: { complete: true, offsets: [0, 120, 0, 0] },
            after: { complete: true, offsets: [0, 320, 0, 0] },
          }, change),
        });

        expect(result.status, result.reason).toBe('NOT_VERIFIABLE');
        expectReason(result, SCROLLED_GEOMETRY_REASON);
        expect(result.evidence.changedFields).toEqual([]);
      },
    );

    it.each([
      ['a scroll record is missing', 'TRANSLATE', undefined, undefined],
      ['the ancestor walk reached the DOM-work budget', 'TRANSLATE', { complete: false, offsets: [] }, { complete: true, offsets: [0, 0] }],
      ['the scroll ancestor chain changed', 'TRANSLATE', { complete: true, offsets: [0, 0] }, { complete: true, offsets: [0, 0, 0, 0] }],
      ['a scroll record is missing', 'RESIZE', undefined, undefined],
      ['the ancestor walk reached the DOM-work budget', 'RESIZE', { complete: false, offsets: [] }, { complete: true, offsets: [0, 0] }],
      ['the scroll ancestor chain changed', 'RESIZE', { complete: true, offsets: [0, 0] }, { complete: true, offsets: [0, 0, 0, 0] }],
    ] as const)('drops geometry evidence when %s (%s)', async (_label, change, before, after) => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        // F16（設計書 4.4.1）で是正: 凍結の前の安定性の確認（500ms）を終えてから、確かめたい段階に進むよう、期限を延ばした。
        timeoutMs: 1_500,
        sessionFactory: async () => geometrySession(candidate, { before, after }, change),
      });

      expect(result.status, result.reason).toBe('NOT_VERIFIABLE');
      expectReason(result, UNCOMPARABLE_GEOMETRY_REASON);
      expect(result.evidence.changedFields).toEqual([]);
    });
  });

  describe("F14 R''1: a translation of the target is not evidence of the interaction", () => {
    const GEOMETRY_ONLY_REASON = 'GEOMETRY_ONLY_CHANGED';

    // F16（設計書 4.4.1 の安定性の確認）で是正: 400ms 後の差し込みは、凍結の前の安定性の確認（500ms）の間に起きるようになった。
    // click の後に起きる平行移動を確かめるため、900ms 後に差し込む fixture に替え、期限を延ばした。
    // 400ms 後に差し込む fixture は、下の「安定性の確認の間に起きる」テストで確かめる。
    it('does not verify an inert button that a late insertion above it shifts after the click', async () => {
      const candidate = await candidateNamed('/delayed-shift-inert-button.html', 'Delayed shift inert');
      // 前提: ボタンは画面外にあり、下準備のスクロールで画面に入ると、遅れて直上に要素が差し込まれる。
      expect(candidate.boundingBox.y).toBeGreaterThan(viewport.height);

      const result = await auditInteraction({ ...input('/delayed-shift-inert-button.html', candidate), timeoutMs: 2_000 });

      expect(result.status, JSON.stringify(result)).toBe('NOT_VERIFIABLE');
      expectReason(result, GEOMETRY_ONLY_REASON);
      expect(result.evidence.identityStatus).toBe('MATCHED');
      expect(result.evidence.changedFields).toEqual([]);
      // 再現の条件: click の後に、対象が大きさを変えずに下へずれた。ずれは Evidence に記録される。
      const before = result.evidence.before?.boundingBox;
      const after = result.evidence.after?.boundingBox;
      expect(after?.y).toBeCloseTo((before?.y ?? Number.NaN) + 120, 0);
      expect(after?.x).toBeCloseTo(before?.x ?? Number.NaN, 0);
      expect(after?.width).toBeCloseTo(before?.width ?? Number.NaN, 0);
      expect(after?.height).toBeCloseTo(before?.height ?? Number.NaN, 0);
      expect(result.safety.blockedInteractionRequests).toEqual([]);
    });

    // F15（設計書 4.4.1 の最終の方針）で是正: 以前は大きさの変化（boundingBox）を根拠にしていた。
    // click で自分の style 属性が変わるので、対象自身の属性の変化（attributes）が根拠になる。
    it('verifies a button whose own size grows on click by its own attribute change', async () => {
      const candidate = await candidateNamed('/self-growing-button.html', 'Grow me');

      const result = await auditInteraction(input('/self-growing-button.html', candidate));

      expect(result.status, JSON.stringify(result)).toBe('VERIFIED');
      expect(result.evidence.changedFields).toEqual(['attributes']);
      expect(result.evidence.after?.boundingBox.width).toBeCloseTo(320, 0);
      expect(result.evidence.after?.boundingBox.height).toBeCloseTo(80, 0);
    });

    it('still verifies an accordion by its ARIA and controlled-element changes', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');

      const result = await auditInteraction(input('/accordion.html', candidate));

      expect(result.status, JSON.stringify(result)).toBe('VERIFIED');
      expect(result.evidence.changedFields).toEqual(expect.arrayContaining(['ariaExpanded', 'controlledVisible']));
      expect(result.evidence.changedFields).not.toContain('boundingBox');
    });

    /** click が `clickError` を投げる偽のセッションを作る。 */
    function failingClickSession(candidate: InteractionCandidate, clickError: Error): InteractionGuardedSession {
      const rawCandidate = rawCandidateFor(candidate);
      const targetHandle = {
        evaluate: async () => ({ status: 'CONNECTED', domWorkUsed: 0, raw: rawCandidate }),
        click: async () => { throw clickError; },
        dispose: async () => undefined,
      };
      const page = {
        goto: async () => undefined,
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

    it('replaces stray control characters in a click failure reason and keeps the bounded length', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const clickError = new Error(`click\u0007 failed\r\n\tbadly\u001b]0;title\u0007 ${'x'.repeat(1_000)}`);

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        sessionFactory: async () => failingClickSession(candidate, clickError),
      });

      expect(result.status).toBe('EXECUTION_FAILED');
      expect(result.reason).toBe('CLICK_FAILED');
      expect(result.reasonDetail?.startsWith('click failed badly xxx')).toBe(true);
      expect(result.reasonDetail).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
      expect(result.reasonDetail?.length).toBeLessThanOrEqual(512);
    });
  });

  describe("F15 R''': target geometry alone is never evidence, and the target is hovered before observation", () => {
    const GEOMETRY_ONLY_REASON = 'GEOMETRY_ONLY_CHANGED';
    const POST_CLICK_DEADLINE_REASONS = [
      'DEADLINE_BEFORE_POST_CONDITION_OBSERVATION',
      'DEADLINE_DURING_POST_CONDITION_OBSERVATION',
      'NO_OBSERVABLE_CHANGE',
    ];

    it.each([
      ['/hover-transform-button.html', 'Hover scale inert'],
      ['/hover-font-weight-button.html', 'Hover bold inert'],
      ['/hover-padding-transition-button.html', 'Hover padding inert'],
      ['/mouseenter-class-button.html', 'Mouseenter class inert'],
    ] as const)('does not verify an inert button whose hover styling changes its size (%s)', async (path, name) => {
      const candidate = await candidateNamed(path, name);

      const result = await auditInteraction({ ...input(path, candidate), timeoutMs: 1_500 });

      expect(result.status, JSON.stringify(result)).toBe('NOT_VERIFIABLE');
      expect([GEOMETRY_ONLY_REASON, ...POST_CLICK_DEADLINE_REASONS]).toContain(result.reason);
      expect(result.evidence.identityStatus).toBe('MATCHED');
      expect(result.evidence.changedFields).toEqual([]);
      // hover は凍結の前の下準備で行うので、観測の前の状態は、すでに hover の後の状態（Passive の探索より大きい）になっている。
      expect(result.evidence.before?.boundingBox.width).toBeGreaterThan(candidate.boundingBox.width + 1);
      expect(result.safety.blockedInteractionRequests).toEqual([]);
    });

    // F16（設計書 4.4.1 の安定性の確認）で是正: 400ms 後の変化は、凍結の前の安定性の確認（500ms）の間に起きるようになった。
    // click の後に起きる大きさの変化を確かめるため、900ms 後に変わる fixture に替え、期限を延ばした。
    it.each([
      ['/delayed-image-in-button.html', 'Delayed image inert'],
      ['/delayed-flex-neighbor-button.html', 'Delayed flex neighbor inert'],
    ] as const)('does not verify an inert button whose size changes after the click by a late layout change (%s)', async (
      path,
      name,
    ) => {
      const candidate = await candidateNamed(path, name);
      // 前提: ボタンは画面外にあり、下準備のスクロールで画面に入ると、遅れてボタンの大きさが変わる。
      expect(candidate.boundingBox.y).toBeGreaterThan(viewport.height);

      const result = await auditInteraction({ ...input(path, candidate), timeoutMs: 2_000 });

      expect(result.status, JSON.stringify(result)).toBe('NOT_VERIFIABLE');
      expectReason(result, GEOMETRY_ONLY_REASON);
      expect(result.evidence.identityStatus).toBe('MATCHED');
      expect(result.evidence.changedFields).toEqual([]);
      // 再現の条件: click の後に、ボタンの高さが実際に伸びた。変化は Evidence に記録される。
      expect(result.evidence.after?.boundingBox.height)
        .toBeGreaterThan((result.evidence.before?.boundingBox.height ?? Number.POSITIVE_INFINITY) + 20);
      expect(result.safety.blockedInteractionRequests).toEqual([]);
    });

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

    it('records the attributes of the target itself, not of its descendants', async () => {
      const page = await browser.newPage({ viewport });
      const content =
        '<button type="button" class="a" data-state="closed"><span class="inner" data-x="1">Own attributes</span></button>';
      const changes = [
        ['descendant attribute', () => { document.querySelector('.inner')!.setAttribute('data-x', '2'); }, 'UNCHANGED'],
        ['own attribute value', () => { document.querySelector('button')!.setAttribute('data-state', 'open'); }, 'CHANGED'],
        ['own attribute added', () => { document.querySelector('button')!.setAttribute('open', ''); }, 'CHANGED'],
        ['own attribute removed', () => { document.querySelector('button')!.removeAttribute('class'); }, 'CHANGED'],
      ] as const;
      try {
        for (const [label, change, expected] of changes) {
          await page.setContent(content);
          const handle = await page.locator('button').elementHandle();
          if (handle === null) throw new Error('Missing attribute candidate');
          const record = async () => {
            const snapshot = await inspectInteractionCandidateHandle(handle, 0);
            if (snapshot.status !== 'CONNECTED') throw new Error('Expected connected attribute candidate');
            return snapshot.attributes;
          };
          try {
            const initial = await record();
            expect(initial, label).toEqual({
              status: 'RECORDED',
              entries: ['type', 'button', 'class', 'a', 'data-state', 'closed'],
            });
            await page.evaluate(change);
            expect(compareInteractionAttributeRecords(initial, await record()), label).toBe(expected);
          } finally {
            await handle.dispose();
          }
        }
      } finally {
        await page.close();
      }
    });

    it('bounds each recorded attribute name and value by the candidate attribute length', async () => {
      const page = await browser.newPage({ viewport });
      try {
        await page.setContent('<button type="button">Long attribute</button>');
        await page.evaluate((length) => {
          document.querySelector('button')!.setAttribute('data-long', 'v'.repeat(length));
        }, INTERACTION_CANDIDATE_LIMITS.maxAttributeLength + 100);
        const handle = await page.locator('button').elementHandle();
        if (handle === null) throw new Error('Missing long attribute candidate');
        try {
          const snapshot = await inspectInteractionCandidateHandle(handle, 0);
          if (snapshot.status !== 'CONNECTED' || snapshot.attributes.status !== 'RECORDED') {
            throw new Error('Expected a recorded attribute list');
          }
          expect(snapshot.attributes.entries).toEqual([
            'type',
            'button',
            'data-long',
            'v'.repeat(INTERACTION_CANDIDATE_LIMITS.maxAttributeLength),
          ]);
        } finally {
          await handle.dispose();
        }
      } finally {
        await page.close();
      }
    });

    it.each([
      // 祖先（body、html）の走査が最後の作業量の2つ前で終わり、属性（type、aria-label）に1ずつ使う。
      ['completes the attribute list on the final work unit', 16_374, { status: 'RECORDED', entries: ['type', 'button', 'aria-label', 'Budget'] }],
      ['reports an incomplete attribute list at the DOM-work budget', 16_375, { status: 'INCOMPLETE' }],
    ] as const)('%s', async (_label, preceding, expectedAttributes) => {
      const page = await browser.newPage();
      try {
        await page.setContent('<button type="button" aria-label="Budget">x</button>');
        const handle = await page.locator('button').elementHandle();
        if (handle === null) throw new Error('Missing budget candidate');
        try {
          await installPrecedingWorkWalker(page, 'button', preceding);
          const snapshot = await inspectInteractionCandidateHandle(handle, 0);
          expect(snapshot).toMatchObject({
            status: 'CONNECTED',
            domWorkUsed: 16_384,
            scroll: { status: 'RECORDED', offsets: [0, 0] },
            attributes: expectedAttributes,
          });
        } finally {
          await handle.dispose();
        }
      } finally {
        await page.close();
      }
    });

    it.each([
      ['non-object attribute record', { status: 'CONNECTED', domWorkUsed: 1, attributes: [] }],
      ['non-boolean completeness', { status: 'CONNECTED', domWorkUsed: 1, attributes: { complete: 'yes', entries: [] } }],
      ['odd entry count', { status: 'CONNECTED', domWorkUsed: 1, attributes: { complete: true, entries: ['class'] } }],
      ['non-string entry', { status: 'CONNECTED', domWorkUsed: 1, attributes: { complete: true, entries: ['class', 1] } }],
      // F20b（設計書 4.4.1「長い class」）: class の値だけは class 専用の上限まで受け取り、ほかの名前と値は、これまでの上限とする。
      [
        'over-long entry',
        {
          status: 'CONNECTED',
          domWorkUsed: 1,
          attributes: {
            complete: true,
            entries: ['data-long', 'x'.repeat(INTERACTION_CANDIDATE_LIMITS.maxAttributeLength + 1)],
          },
        },
      ],
      [
        'over-long class value',
        {
          status: 'CONNECTED',
          domWorkUsed: 1,
          attributes: {
            complete: true,
            entries: ['class', 'x'.repeat(INTERACTION_CANDIDATE_LIMITS.maxClassAttributeLength + 1)],
          },
        },
      ],
      [
        'over-long attribute name',
        {
          status: 'CONNECTED',
          domWorkUsed: 1,
          attributes: { complete: true, entries: ['x'.repeat(INTERACTION_CANDIDATE_LIMITS.maxAttributeLength + 1), 'v'] },
        },
      ],
      [
        'over-long value of an attribute other than class',
        {
          status: 'CONNECTED',
          domWorkUsed: 1,
          attributes: {
            complete: true,
            entries: ['class', 'a', 'style', 'x'.repeat(INTERACTION_CANDIDATE_LIMITS.maxAttributeLength + 1)],
          },
        },
      ],
      ['contradictory DISCONNECTED attributes', { status: 'DISCONNECTED', domWorkUsed: 1, attributes: { complete: true, entries: [] } }],
    ] as const)('rejects a malformed retained attribute record: %s', async (_label, value) => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const snapshot = value.status === 'CONNECTED' ? { ...value, raw: rawCandidateFor(candidate) } : value;
      const handle = { evaluate: async () => snapshot } as unknown as Parameters<typeof inspectInteractionCandidateHandle>[0];

      await expect(inspectInteractionCandidateHandle(handle, 0)).rejects.toThrow('Invalid bounded interaction handle snapshot');
    });

    it('compares attribute records regardless of attribute order and treats missing records as uncomparable', () => {
      const recorded = (entries: readonly string[]) => ({ status: 'RECORDED' as const, entries });
      expect(compareInteractionAttributeRecords(recorded(['a', '1', 'b', '2']), recorded(['b', '2', 'a', '1']))).toBe('UNCHANGED');
      expect(compareInteractionAttributeRecords(recorded(['a', '1']), recorded(['a', '2']))).toBe('CHANGED');
      expect(compareInteractionAttributeRecords(recorded(['a', '1']), recorded(['a', '1', 'b', '']))).toBe('CHANGED');
      expect(compareInteractionAttributeRecords({ status: 'UNRECORDED' }, recorded([]))).toBe('UNCOMPARABLE');
      expect(compareInteractionAttributeRecords(recorded([]), { status: 'INCOMPLETE' })).toBe('UNCOMPARABLE');
    });

    /** click の前と後の観測で、対象の属性の記録（`attributes`）だけを変える偽のセッションを作る。 */
    function attributeSession(
      candidate: InteractionCandidate,
      attributes: { readonly before?: unknown; readonly after?: unknown },
    ): InteractionGuardedSession {
      const rawCandidate = rawCandidateFor(candidate);
      const withAttributes = (value: unknown) => (
        value === undefined
          ? { status: 'CONNECTED', domWorkUsed: 0, raw: rawCandidate }
          : { status: 'CONNECTED', domWorkUsed: 0, raw: rawCandidate, attributes: value }
      );
      const snapshots = [withAttributes(attributes.before), withAttributes(attributes.after)];
      let snapshotIndex = 0;
      const targetHandle = {
        evaluate: async () => snapshots[Math.min(snapshotIndex++, snapshots.length - 1)],
        click: async () => undefined,
        dispose: async () => undefined,
      };
      const page = {
        goto: async () => undefined,
        evaluate: async (_callback: unknown, argument?: unknown) => (
          argument === undefined ? true : { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 0 }
        ),
        evaluateHandle: async () => boundedResolutionEnvelope(targetHandle),
      } as unknown as Page;
      return {
        // F16（設計書 4.4.1 の安定性の確認）で是正: 下準備の観測も、click の前と同じ属性の記録を返す。
        // 記録を比べられない場合は、属性のすべてを「不安定」とみなすためである。
        // F20（設計書 4.4.2 手順4）で是正: 下準備の focus の前後の記録を比べられない場合は、凍結せずに終える（そのテストは F20 にある）。
        // ここで確かめるのは click の前の記録なので、click の前の記録が欠けている場合は、下準備では属性のない記録を返す
        // （下準備の記録と click の前の記録は比べられず、これまでどおり属性のすべてが「不安定」になる）。
        page: withScrollPreparation(
          page,
          candidate,
          (attributes.before as { readonly complete?: unknown } | undefined)?.complete === false ? undefined : attributes.before,
        ),
        ledger: new SafetyLedger(),
        activateInteractionFreeze: async () => undefined,
        ...fakeCloseLifecycle(),
      };
    }

    it('verifies a change of the target own attributes', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        // F16（設計書 4.4.1）で是正: 凍結の前の安定性の確認（500ms）を終えてから、確かめたい段階に進むよう、期限を延ばした。
        timeoutMs: 1_500,
        sessionFactory: async () => attributeSession(candidate, {
          before: { complete: true, entries: ['class', 'collapsed'] },
          after: { complete: true, entries: ['class', 'expanded'] },
        }),
      });

      expect(result.status, result.reason).toBe('VERIFIED');
      expect(result.evidence.changedFields).toEqual(['attributes']);
    });

    it.each([
      ['unchanged attributes', { complete: true, entries: ['class', 'a'] }, { complete: true, entries: ['class', 'a'] }],
      ['a missing attribute record', undefined, { complete: true, entries: ['class', 'b'] }],
      ['an incomplete attribute record', { complete: false, entries: [] }, { complete: true, entries: ['class', 'b'] }],
    ] as const)('does not treat %s as evidence', async (_label, before, after) => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        // F16（設計書 4.4.1）で是正: 凍結の前の安定性の確認（500ms）を終えてから、確かめたい段階に進むよう、期限を延ばした。
        timeoutMs: 1_500,
        sessionFactory: async () => attributeSession(candidate, { before, after }),
      });

      expect(result.status, result.reason).toBe('NOT_VERIFIABLE');
      expect(POST_CLICK_DEADLINE_REASONS).toContain(result.reason);
      expect(result.evidence.changedFields).toEqual([]);
    });
  });

  describe("F15 R''' M-3: lifecycle and Ledger reasons are normalized before they are bounded", () => {
    const ANSI_WITH_CALL_LOG = [
      '\u001b[31mbrowserContext.close: Target closed\u001b[39m',
      'Call log:',
      '\u001b[2m  - closing context\u001b[22m',
    ].join('\n');
    /** 512字で先に切り詰めると、ANSI のエスケープシーケンスの途中（`\u001b[3`）で切れる文言。 */
    const ESCAPE_AT_BOUND = `${'x'.repeat(509)}\u001b[31m${'y'.repeat(100)}`;
    const ESCAPE_AT_BOUND_REASON = `${'x'.repeat(509)}yyy`;

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
        goto: async () => undefined,
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
      ['an escape sequence across the length bound', ESCAPE_AT_BOUND, ESCAPE_AT_BOUND_REASON, ESCAPE_AT_BOUND_REASON],
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
        goto: async () => undefined,
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

    it('removes an escape sequence across the length bound from a click failure reason', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const rawCandidate = rawCandidateFor(candidate);
      const targetHandle = {
        evaluate: async () => ({ status: 'CONNECTED', domWorkUsed: 0, raw: rawCandidate }),
        click: async () => { throw new Error(ESCAPE_AT_BOUND); },
        dispose: async () => undefined,
      };
      const page = {
        goto: async () => undefined,
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

  describe('F16 R5: stability and persistence of evidence, details disclosure, and hover identity', () => {
    const POST_CLICK_DEADLINE_REASONS = [
      'DEADLINE_BEFORE_POST_CONDITION_OBSERVATION',
      'DEADLINE_DURING_POST_CONDITION_OBSERVATION',
      'NO_OBSERVABLE_CHANGE',
    ];
    const STABILITY_DEADLINE_REASON = 'STABILITY_CHECK_DEADLINE';
    const PERSISTENCE_DEADLINE_REASON = 'PERSISTENCE_CHECK_DEADLINE';

    // N-1・N-3: click と関係なく対象自身の属性を変えるだけの、何もしないボタン。
    // 下準備の hover と focus の後の安定性の確認で「不安定」になった項目と、すぐ元に戻る変化は、根拠にしない。
    it.each([
      ['/timer-class-button.html', 'Timer class inert'],
      ['/animation-frame-style-button.html', 'Animation frame style inert'],
      ['/hover-intent-class-button.html', 'Hover intent inert'],
      ['/transition-end-class-button.html', 'Transition end inert'],
      ['/focus-state-buttons.html', 'Focus class inert'],
      ['/focus-state-buttons.html', 'Focus data inert'],
      ['/ripple-button.html', 'Ripple inert'],
    ] as const)('does not verify an inert button whose own attributes change without the click (%s, %s)', async (
      path,
      name,
    ) => {
      const candidate = await candidateNamed(path, name);

      const result = await auditInteraction(input(path, candidate));

      expect(result.status, JSON.stringify(result)).toBe('NOT_VERIFIABLE');
      expect(POST_CLICK_DEADLINE_REASONS).toContain(result.reason);
      expect(result.evidence.identityStatus).toBe('MATCHED');
      expect(result.evidence.changedFields).toEqual([]);
      expect(result.evidence.changedAttributes).toEqual([]);
      expect(result.safety.blockedInteractionRequests).toEqual([]);
    });

    it.each([
      ['/late-shift-inert-button.html', 'Late shift inert'],
      ['/late-image-in-button.html', 'Late image inert'],
      ['/late-flex-neighbor-button.html', 'Flex neighbor inert'],
    ] as const)('does not verify an inert button whose late layout change happens during the stability check (%s)', async (
      path,
      name,
    ) => {
      const candidate = await candidateNamed(path, name);

      const result = await auditInteraction(input(path, candidate));

      expect(result.status, JSON.stringify(result)).toBe('NOT_VERIFIABLE');
      expect(result.evidence.identityStatus).toBe('MATCHED');
      expect(result.evidence.changedFields).toEqual([]);
      expect(result.safety.blockedInteractionRequests).toEqual([]);
    });

    // N-2: 対象が details の summary のときは、親の details の open を開閉の状態として根拠にする。
    it.each(['Closed disclosure', 'Open disclosure'] as const)(
      'verifies a details summary by the open state of its details (%s)',
      async (name) => {
        const candidate = await candidateNamed('/details-disclosure.html', name);

        const result = await auditInteraction(input('/details-disclosure.html', candidate));

        expect(result.status, JSON.stringify(result)).toBe('VERIFIED');
        expect(result.evidence.changedFields).toEqual(['detailsOpen']);
        expect(result.evidence.changedAttributes).toEqual([]);
      },
    );

    // N-5: 対象自身の属性が根拠になったときは、変わった属性の名前を Evidence に残す。
    it.each([
      ['/accordion.html', 'Toggle details', ['aria-expanded']],
      ['/stateful-widgets.html', 'Second tab', ['aria-selected']],
      ['/stateful-widgets.html', 'Class toggle', ['class']],
      ['/stateful-widgets.html', 'Pressed toggle', ['aria-pressed']],
      ['/self-growing-button.html', 'Grow me', ['style']],
    ] as const)('verifies %s %s and records the names of the changed attributes', async (path, name, attributes) => {
      const candidate = await candidateNamed(path, name);

      const result = await auditInteraction(input(path, candidate));

      expect(result.status, JSON.stringify(result)).toBe('VERIFIED');
      expect(result.evidence.changedFields).toContain('attributes');
      expect(result.evidence.changedAttributes).toEqual(attributes);
      expect(Object.isFrozen(result.evidence.changedAttributes)).toBe(true);
      expect(result.evidence.changedAttributesTruncated).toBe(false);
    });

    // F17（F16 の発見事項7）: 変わった属性の名前を上限で切り詰めた場合は、切り詰めたことを Evidence に残す。
    describe('F17: truncation of the changed attribute names is recorded', () => {
      const attributeNames = (count: number): readonly string[] => Array.from(
        { length: count },
        (_unused, index) => `data-changed-${String(index).padStart(3, '0')}`,
      );
      const withAttributes = (
        before: InteractionCandidate,
        names: readonly string[],
      ): InteractionChangeEvidence => collectInteractionChangeEvidence(before, before, {
        difference: { changedAttributeNames: names, changedClassNames: null, detailsOpen: { before: null, after: null } },
      });

      it.each([
        [0, false],
        [1, false],
        [MAX_CHANGED_ATTRIBUTE_NAMES, false],
        [MAX_CHANGED_ATTRIBUTE_NAMES + 1, true],
        [MAX_CHANGED_ATTRIBUTE_NAMES + 40, true],
      ] as const)('records %s changed attribute names with changedAttributesTruncated = %s', async (count, truncated) => {
        const candidate = await candidateNamed('/accordion.html', 'Toggle details');
        const names = attributeNames(count);

        const evidence = withAttributes(candidate, names);

        expect(evidence.changedAttributes).toEqual(names.slice(0, MAX_CHANGED_ATTRIBUTE_NAMES));
        expect(evidence.changedAttributesTruncated).toBe(truncated);
        expect(evidence.changedFields).toEqual(count > 0 ? ['attributes'] : []);
      });

      it('counts only the attribute names that remain evidence after the stability check', async () => {
        const candidate = await candidateNamed('/accordion.html', 'Toggle details');
        const names = attributeNames(MAX_CHANGED_ATTRIBUTE_NAMES + 1);

        const evidence = collectInteractionChangeEvidence(candidate, candidate, {
          difference: { changedAttributeNames: names, changedClassNames: null, detailsOpen: { before: null, after: null } },
          instability: { fields: new Set<string>(), attributeNames: new Set([names[0] ?? '']), classNames: new Set<string>() },
        });

        expect(evidence.changedAttributes).toEqual(names.slice(1));
        expect(evidence.changedAttributesTruncated).toBe(false);
      });

      it('keeps the truncation mark through the persistence check when either observation was truncated', async () => {
        const candidate = await candidateNamed('/accordion.html', 'Toggle details');
        const many = attributeNames(MAX_CHANGED_ATTRIBUTE_NAMES + 1);
        const few = many.slice(0, 2);

        expect(retainPersistentInteractionChanges(withAttributes(candidate, many), withAttributes(candidate, many)))
          .toMatchObject({ changedAttributes: many.slice(0, MAX_CHANGED_ATTRIBUTE_NAMES), changedAttributesTruncated: true });
        expect(retainPersistentInteractionChanges(withAttributes(candidate, many), withAttributes(candidate, few)))
          .toMatchObject({ changedAttributes: few, changedAttributesTruncated: true });
        expect(retainPersistentInteractionChanges(withAttributes(candidate, few), withAttributes(candidate, many)))
          .toMatchObject({ changedAttributes: few, changedAttributesTruncated: true });
        expect(retainPersistentInteractionChanges(withAttributes(candidate, few), withAttributes(candidate, few)))
          .toMatchObject({ changedAttributes: few, changedAttributesTruncated: false });
      });

      it('records changedAttributesTruncated = false when there is no observation after the click', async () => {
        const candidate = await candidateNamed('/accordion.html', 'Toggle details');

        const result = await auditInteraction({ ...input('/accordion.html', candidate), timeoutMs: 200 });

        expect(result.status).toBe('NOT_VERIFIABLE');
        expect(result.evidence.changedAttributesTruncated).toBe(false);
        expect(result.work.evidence.changedAttributesTruncated).toBe(false);
      });
    });

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
      expect(result.evidence.before?.accessibleName).toBe('Unfollow');
      expect(result.evidence.changedFields).toEqual(['attributes']);
      expect(result.evidence.changedAttributes).toEqual(['aria-pressed']);
    });

    it('records the open state of the parent details only for a summary target', async () => {
      const page = await browser.newPage({ viewport });
      try {
        await page.setContent(
          '<details><summary>Summary</summary><p>Body</p></details><button type="button">Plain</button>',
        );
        const summary = await page.locator('summary').elementHandle();
        const button = await page.locator('button').elementHandle();
        if (summary === null || button === null) throw new Error('Missing details candidates');
        const detailsOpen = async (handle: typeof summary, ordinal: number) => {
          const snapshot = await inspectInteractionCandidateHandle(handle, ordinal);
          if (snapshot.status !== 'CONNECTED') throw new Error('Expected a connected details candidate');
          return snapshot.detailsOpen;
        };
        try {
          expect(await detailsOpen(summary, 0)).toBe(false);
          await page.evaluate(() => { document.querySelector('details')!.open = true; });
          expect(await detailsOpen(summary, 0)).toBe(true);
          expect(await detailsOpen(button, 1)).toBeNull();
        } finally {
          await summary.dispose();
          await button.dispose();
        }
      } finally {
        await page.close();
      }
    });

    it('names the changed attributes and treats an empty class or style attribute as absent', () => {
      const recorded = (entries: readonly string[]) => ({ status: 'RECORDED' as const, entries });
      expect(changedInteractionAttributeNames(
        recorded(['type', 'button', 'class', 'a', 'data-x', '1']),
        recorded(['type', 'button', 'data-x', '2', 'aria-pressed', 'true']),
      )).toEqual(['aria-pressed', 'class', 'data-x']);
      // classList.remove や style.x = '' の後に残る、空の class・style は、属性がない場合と同じとみなす。
      expect(changedInteractionAttributeNames(recorded(['type', 'button']), recorded(['type', 'button', 'class', ' ', 'style', ''])))
        .toEqual([]);
      expect(compareInteractionAttributeRecords(recorded(['type', 'button']), recorded(['type', 'button', 'class', ''])))
        .toBe('UNCHANGED');
      // 空の値に意味のある属性（hidden、open など）は、加わった属性として扱う。
      expect(changedInteractionAttributeNames(recorded([]), recorded(['hidden', '', 'open', '']))).toEqual(['hidden', 'open']);
      expect(changedInteractionAttributeNames({ status: 'INCOMPLETE' }, recorded([]))).toBeNull();
    });

    it.each([
      ['non-boolean details state', { status: 'CONNECTED', domWorkUsed: 1, detailsOpen: 'yes' }],
      ['contradictory DISCONNECTED details state', { status: 'DISCONNECTED', domWorkUsed: 1, detailsOpen: true }],
    ] as const)('rejects a malformed retained details state: %s', async (_label, value) => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const snapshot = value.status === 'CONNECTED' ? { ...value, raw: rawCandidateFor(candidate) } : value;
      const handle = { evaluate: async () => snapshot } as unknown as Parameters<typeof inspectInteractionCandidateHandle>[0];

      await expect(inspectInteractionCandidateHandle(handle, 0)).rejects.toThrow('Invalid bounded interaction handle snapshot');
    });

    type ScriptedPhase = 'PREPARED' | 'BASELINE' | 'OBSERVED';
    interface ScriptedSnapshotInput {
      readonly raw?: Record<string, unknown>;
      /** 対象自身の属性の記録。null は、記録を返さない（`UNRECORDED`）。 */
      readonly attributes?: readonly string[] | null;
      readonly detailsOpen?: boolean | null;
    }

    /**
     * 下準備（凍結の前）・凍結の後の click の前・click の後の観測で、それぞれ別の記録を返す偽のセッションを作る。
     * `snapshot(phase, index)` は、その段階の何回目の観測か（0から）を受け取る。
     * F20（設計書 4.4.2 手順4、R8 の Important-2）で是正: 下準備の focus の前後では、属性の記録を比べる。実際のブラウザは記録を必ず返すので、
     * 下準備（`PREPARED`）で `attributes` を指定しない場合は、属性のない記録を返す。記録を返さない場合は、`attributes: null` を指定する。
     */
    function scriptedSession(
      candidate: InteractionCandidate,
      options: {
        readonly events: string[];
        readonly snapshot?: (phase: ScriptedPhase, index: number) => ScriptedSnapshotInput;
        readonly focus?: () => Promise<void>;
        readonly click?: () => Promise<void>;
        readonly preparedWork?: (limit: number, index: number) => number;
      },
    ): InteractionGuardedSession {
      const rawCandidate = rawCandidateFor(candidate);
      let frozen = false;
      let clicked = false;
      const counts: Record<ScriptedPhase, number> = { PREPARED: 0, BASELINE: 0, OBSERVED: 0 };
      const targetHandle = {
        evaluate: async (_callback: unknown, argument: { readonly limits: { readonly maxDomWork: number } }) => {
          const phase: ScriptedPhase = clicked ? 'OBSERVED' : frozen ? 'BASELINE' : 'PREPARED';
          const index = counts[phase]++;
          const scripted = options.snapshot?.(phase, index) ?? {};
          const domWorkUsed = phase === 'PREPARED' ? options.preparedWork?.(argument.limits.maxDomWork, index) ?? 0 : 0;
          const attributes = scripted.attributes === undefined && phase === 'PREPARED' ? [] : scripted.attributes;
          return {
            status: 'CONNECTED',
            domWorkUsed,
            raw: { ...rawCandidate, ...scripted.raw },
            ...(attributes === undefined || attributes === null
              ? {}
              : { attributes: { complete: true, entries: attributes } }),
            ...(scripted.detailsOpen === undefined ? {} : { detailsOpen: scripted.detailsOpen }),
          };
        },
        scrollIntoViewIfNeeded: async () => { options.events.push('scroll'); },
        hover: async () => { options.events.push('hover'); },
        focus: async () => {
          options.events.push('focus');
          await options.focus?.();
        },
        click: async () => {
          options.events.push('click');
          await options.click?.();
          clicked = true;
        },
        dispose: async () => { options.events.push('dispose'); },
      };
      const page = {
        goto: async () => undefined,
        evaluate: async (_callback: unknown, argument?: unknown) => (
          argument === undefined ? true : { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: 20 }
        ),
        evaluateHandle: async () => {
          options.events.push('resolve');
          return boundedResolutionEnvelope(targetHandle);
        },
      } as unknown as Page;
      return {
        page,
        ledger: new SafetyLedger(),
        activateInteractionFreeze: async () => {
          options.events.push('freeze');
          frozen = true;
        },
        ...fakeCloseLifecycle(),
      };
    }

    it('hovers and then focuses the target before the stability check and the freeze', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const events: string[] = [];

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        sessionFactory: async () => scriptedSession(candidate, {
          events,
          snapshot: (phase) => (phase === 'OBSERVED' ? { raw: toggledRawCandidate(candidate) } : {}),
        }),
      });

      expect(result.status, result.reason).toBe('VERIFIED');
      expect(events).toEqual(['resolve', 'scroll', 'hover', 'focus', 'dispose', 'freeze', 'resolve', 'click', 'dispose']);
    });

    it.each([
      [
        'a focus failure',
        async () => { throw new Error('focus target detached'); },
        'FOCUS_PREPARATION_FAILED',
        'focus target detached',
      ],
      [
        'a focus failure with only control characters',
        async () => { throw new Error('\u001b[31m\u0007\r\n\u001b[39m'); },
        'FOCUS_PREPARATION_FAILED',
        null,
      ],
      [
        'a focus timeout in the browser',
        async () => {
          const timeout = new Error('focus timed out');
          timeout.name = 'TimeoutError';
          throw timeout;
        },
        'FOCUS_PREPARATION_DEADLINE',
        null,
      ],
    ] as const)('does not freeze or click after %s', async (_label, focus, expectedReason, expectedReasonDetail) => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const events: string[] = [];

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        sessionFactory: async () => scriptedSession(candidate, { events, focus }),
      });

      expect(result.status).toBe('NOT_VERIFIABLE');
      expectReason(result, expectedReason, expectedReasonDetail);
      expect(result.evidence.identityStatus).toBe('UNESTABLISHED');
      expect(events).toEqual(['resolve', 'scroll', 'hover', 'focus', 'dispose']);
    });

    it('bounds a never-settling pre-freeze focus by the effective deadline', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const events: string[] = [];
      const neverSettles = createDeferred<void>();

      const settled = await settleWithin(auditInteraction({
        ...input('/accordion.html', candidate),
        timeoutMs: 200,
        sessionFactory: async () => scriptedSession(candidate, { events, focus: () => neverSettles.promise }),
      }), 2_000);

      expect(settled).not.toBe('STILL_PENDING');
      const result = settled as Awaited<ReturnType<typeof auditInteraction>>;
      expect(result.status).toBe('NOT_VERIFIABLE');
      expectReason(result, 'FOCUS_PREPARATION_DEADLINE');
      expect(events).toEqual(['resolve', 'scroll', 'hover', 'focus', 'dispose']);
    });

    it('does not freeze or click when the deadline leaves no time for the stability check', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const events: string[] = [];

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        timeoutMs: 300,
        sessionFactory: async () => scriptedSession(candidate, { events }),
      });

      expect(result.status).toBe('NOT_VERIFIABLE');
      expectReason(result, STABILITY_DEADLINE_REASON);
      expect(events).toEqual(['resolve', 'scroll', 'hover', 'focus', 'dispose']);
    });

    it('does not hover, focus, or adopt the state of a prepared handle that is not the discovered candidate', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const events: string[] = [];

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        sessionFactory: async () => scriptedSession(candidate, {
          events,
          // 下準備で解決した handle が、探索と解決の間に差し込まれた別の要素を指している。
          snapshot: (phase, index) => (phase === 'PREPARED' && index === 0
            ? { raw: { accessibleName: 'Inserted other', normalizedText: 'Inserted other' } }
            : {}),
        }),
      });

      expect(result.status).toBe('NOT_VERIFIABLE');
      expectReason(result, 'TARGET_NOT_SCROLL_PREPARED');
      expect(events).toEqual(['resolve', 'dispose', 'freeze', 'resolve', 'dispose']);
    });

    // F20（設計書 4.4.2 手順4、R8 の Important-2）で是正: 下準備の観測に、focus の前後の2回が加わった（1 と 2）。
    // 安定性の確認の観測は 3 から後なので、そこで作業量を使い切らせる。
    it('debits the stability-check inspections from the shared DOM-work budget', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const events: string[] = [];

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        sessionFactory: async () => scriptedSession(candidate, { events, preparedWork: (limit, index) => (index < 3 ? 0 : limit) }),
      });

      expect(result.status).toBe('NOT_VERIFIABLE');
      expectReason(result, 'STABILITY_CHECK_DOM_WORK_EXHAUSTED');
      expect(events).toEqual(['resolve', 'scroll', 'hover', 'focus', 'dispose']);
    });

    describe('F20 R8 Important-2: the preparatory focus of explicit tabs and focus-driven state changes', () => {
      const FOCUS_STATE_CHANGED_REASON = 'FOCUS_PREPARATION_STATE_CHANGED';
      const FOCUS_STATE_UNCOMPARABLE_REASON = 'FOCUS_PREPARATION_STATE_UNCOMPARABLE';
      const FOCUS_DOM_WORK_EXHAUSTED_REASON = 'FOCUS_PREPARATION_DOM_WORK_EXHAUSTED';

      it('hovers but does not focus a target with an explicit tab role, and verifies it by the click', async () => {
        const candidate = await candidateNamed('/focus-activated-tabs.html', 'Manual second tab');
        const events: string[] = [];

        const result = await auditInteraction({
          ...input('/accordion.html', candidate),
          sessionFactory: async () => scriptedSession(candidate, {
            events,
            snapshot: (phase) => (phase === 'OBSERVED'
              ? { raw: { ariaSelected: 'true', controlledVisible: true, controlledHidden: false } }
              : {}),
          }),
        });

        expect(result.status, result.reason).toBe('VERIFIED');
        expect(result.evidence.changedFields).toEqual(['ariaSelected', 'controlledVisible', 'controlledHidden']);
        expect(events).toEqual(['resolve', 'scroll', 'hover', 'dispose', 'freeze', 'resolve', 'click', 'dispose']);
      });

      it.each([
        ['aria-expanded', { raw: { ariaExpanded: 'true' } }],
        ['aria-selected', { raw: { ariaSelected: 'true' } }],
        ['the display of the aria-controls target', { raw: { controlledVisible: true, controlledHidden: false } }],
        ['aria-pressed', { attributes: ['aria-pressed', 'true', 'aria-checked', 'false'] }],
        ['aria-checked', { attributes: ['aria-pressed', 'false', 'aria-checked', 'true'] }],
      ] as const)('stops without the freeze when the preparatory focus changes %s', async (_label, focused) => {
        const candidate = await candidateNamed('/accordion.html', 'Toggle details');
        const events: string[] = [];
        let hasFocus = false;

        const result = await auditInteraction({
          ...input('/accordion.html', candidate),
          sessionFactory: async () => scriptedSession(candidate, {
            events,
            focus: async () => { hasFocus = true; },
            snapshot: (phase) => (phase === 'PREPARED' && hasFocus
              ? { attributes: ['aria-pressed', 'false', 'aria-checked', 'false'], ...focused }
              : { attributes: ['aria-pressed', 'false', 'aria-checked', 'false'] }),
          }),
        });

        expect(result.status).toBe('NOT_VERIFIABLE');
        expectReason(result, FOCUS_STATE_CHANGED_REASON);
        expect(result.evidence.identityStatus).toBe('UNESTABLISHED');
        expect(events).toEqual(['resolve', 'scroll', 'hover', 'focus', 'dispose']);
      });

      it('continues when the preparatory focus changes only attributes other than the ARIA state', async () => {
        const candidate = await candidateNamed('/accordion.html', 'Toggle details');
        const events: string[] = [];
        let hasFocus = false;

        const result = await auditInteraction({
          ...input('/accordion.html', candidate),
          sessionFactory: async () => scriptedSession(candidate, {
            events,
            focus: async () => { hasFocus = true; },
            snapshot: (phase) => (phase === 'OBSERVED'
              ? { raw: toggledRawCandidate(candidate) }
              : { attributes: hasFocus ? ['class', 'is-focused', 'aria-describedby', 'tip'] : [] }),
          }),
        });

        expect(result.status, result.reason).toBe('VERIFIED');
        expect(events).toEqual(['resolve', 'scroll', 'hover', 'focus', 'dispose', 'freeze', 'resolve', 'click', 'dispose']);
      });

      it('fails closed when the attributes before and after the preparatory focus cannot be compared', async () => {
        const candidate = await candidateNamed('/accordion.html', 'Toggle details');
        const events: string[] = [];

        const result = await auditInteraction({
          ...input('/accordion.html', candidate),
          sessionFactory: async () => scriptedSession(candidate, {
            events,
            snapshot: (phase) => (phase === 'PREPARED' ? { attributes: null } : {}),
          }),
        });

        expect(result.status).toBe('NOT_VERIFIABLE');
        expectReason(result, FOCUS_STATE_UNCOMPARABLE_REASON);
        expect(events).toEqual(['resolve', 'scroll', 'hover', 'focus', 'dispose']);
      });

      // 下準備の観測の順序: 0 は同じ要素かの確認、1 は focus の前、2 は focus の後、3 から後は安定性の確認。
      it.each([
        ['before the focus', 1, ['resolve', 'scroll', 'hover', 'dispose']],
        ['after the focus', 2, ['resolve', 'scroll', 'hover', 'focus', 'dispose']],
      ] as const)('debits the inspection %s from the shared DOM-work budget', async (_label, exhaustedAt, expectedEvents) => {
        const candidate = await candidateNamed('/accordion.html', 'Toggle details');
        const events: string[] = [];

        const result = await auditInteraction({
          ...input('/accordion.html', candidate),
          sessionFactory: async () => scriptedSession(candidate, {
            events,
            preparedWork: (limit, index) => (index === exhaustedAt ? limit : 0),
          }),
        });

        expect(result.status).toBe('NOT_VERIFIABLE');
        expectReason(result, FOCUS_DOM_WORK_EXHAUSTED_REASON);
        expect(events).toEqual(expectedEvents);
      });
    });

    it('excludes an attribute that changed during the stability check and verifies a stable one', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const events: string[] = [];
      const pulse = (index: number) => (index % 2 === 0 ? 'a' : 'b');

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        sessionFactory: async () => scriptedSession(candidate, {
          events,
          snapshot: (phase, index) => ({
            attributes: ['class', pulse(phase === 'OBSERVED' ? index + 1 : index), 'aria-pressed', phase === 'OBSERVED' ? 'true' : 'false'],
          }),
        }),
      });

      expect(result.status, result.reason).toBe('VERIFIED');
      expect(result.evidence.changedFields).toEqual(['attributes']);
      expect(result.evidence.changedAttributes).toEqual(['aria-pressed']);
    });

    it.each([
      // F18（R6 の M-2）で是正: class は名前ごとに比べる。click の後の値は、安定性の確認の間に変わった名前（a、b）だけで作る。
      // 安定性の確認の間に一度も現れなかった名前（例: c）が増えた場合は、安定していた名前の変化として根拠になる（下の F18 のテスト）。
      ['changed during the stability check', (phase: ScriptedPhase, index: number) => (
        (phase === 'OBSERVED' ? index + 1 : index) % 2 === 0 ? 'a' : 'b'
      )],
      ['changed between the end of the stability check and the pre-click observation', (phase: ScriptedPhase) => (
        phase === 'BASELINE' ? 'b' : 'a'
      )],
    ] as const)('does not treat an attribute that %s as evidence', async (_label, classValue) => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const events: string[] = [];

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        timeoutMs: 1_500,
        sessionFactory: async () => scriptedSession(candidate, {
          events,
          snapshot: (phase, index) => ({ attributes: ['class', classValue(phase, index)] }),
        }),
      });

      expect(result.status, result.reason).toBe('NOT_VERIFIABLE');
      expect(POST_CLICK_DEADLINE_REASONS).toContain(result.reason);
      expect(result.evidence.changedFields).toEqual([]);
      expect(result.evidence.changedAttributes).toEqual([]);
    });

    it('does not verify a change that reverts before the end of the persistence window', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const events: string[] = [];

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        timeoutMs: 1_500,
        sessionFactory: async () => scriptedSession(candidate, {
          events,
          snapshot: (phase, index) => (phase === 'OBSERVED' && index === 0 ? { raw: toggledRawCandidate(candidate) } : {}),
        }),
      });

      expect(result.status, result.reason).toBe('NOT_VERIFIABLE');
      expect(POST_CLICK_DEADLINE_REASONS).toContain(result.reason);
      expect(result.evidence.changedFields).toEqual([]);
    });

    it('verifies only the changes that persist to the end of the persistence window', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const events: string[] = [];

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        sessionFactory: async () => scriptedSession(candidate, {
          events,
          snapshot: (phase, index) => (phase === 'OBSERVED'
            ? {
              raw: toggledRawCandidate(candidate),
              attributes: ['class', index === 0 ? 'ripple' : '', 'aria-expanded', 'true'],
            }
            : { attributes: ['class', '', 'aria-expanded', 'false'] }),
        }),
      });

      expect(result.status, result.reason).toBe('VERIFIED');
      expect(result.evidence.changedFields).toEqual(['ariaExpanded', 'controlledVisible', 'controlledHidden', 'attributes']);
      expect(result.evidence.changedAttributes).toEqual(['aria-expanded']);
    });

    it('does not verify a change whose persistence window would end after the deadline', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const events: string[] = [];
      let clickStartedAt = 0;

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        timeoutMs: 1_000,
        sessionFactory: async () => scriptedSession(candidate, {
          events,
          // click の後の観測を、期限の少し前（持続の確認の時間が足りない時点）まで遅らせる。
          click: async () => { clickStartedAt = Date.now(); await wait(150); },
          snapshot: (phase) => (phase === 'OBSERVED' ? { raw: toggledRawCandidate(candidate) } : {}),
        }),
      });

      expect(clickStartedAt).toBeGreaterThan(0);
      expect(result.status, result.reason).toBe('NOT_VERIFIABLE');
      expectReason(result, PERSISTENCE_DEADLINE_REASON);
      expect(result.evidence.changedFields).toEqual(expect.arrayContaining(['ariaExpanded']));
    });

    it('verifies a change of the parent details open state from a scripted observation', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const events: string[] = [];

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        sessionFactory: async () => scriptedSession(candidate, {
          events,
          snapshot: (phase) => ({ detailsOpen: phase === 'OBSERVED' }),
        }),
      });

      expect(result.status, result.reason).toBe('VERIFIED');
      expect(result.evidence.changedFields).toEqual(['detailsOpen']);
    });

    it('does not treat a details open state that changed during the stability check as evidence', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const events: string[] = [];

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        timeoutMs: 1_500,
        sessionFactory: async () => scriptedSession(candidate, {
          events,
          snapshot: (phase, index) => ({ detailsOpen: phase === 'PREPARED' ? index % 2 === 0 : true }),
        }),
      });

      expect(result.status, result.reason).toBe('NOT_VERIFIABLE');
      expect(result.evidence.changedFields).toEqual([]);
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
        goto: async () => undefined,
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
    ] as const)('removes %s from a click failure reason', async (_label, message, expectedReason) => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        sessionFactory: async () => rejectingClickSession(candidate, new Error(message)),
      });

      expect(result.status).toBe('EXECUTION_FAILED');
      expectReason(result, 'CLICK_FAILED', expectedReason);
    });

    it('does not split a surrogate pair when it bounds a click failure reason', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const message = `${'x'.repeat(511)}\u{1F600}tail`;

      const result = await auditInteraction({
        ...input('/accordion.html', candidate),
        sessionFactory: async () => rejectingClickSession(candidate, new Error(message)),
      });

      expect(result.status).toBe('EXECUTION_FAILED');
      expectReason(result, 'CLICK_FAILED', 'x'.repeat(511));
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
        const events: string[] = [];
        const scripted = scriptedSession(candidate, {
          events,
          snapshot: (phase) => (phase === 'OBSERVED' ? { raw: toggledRawCandidate(candidate) } : {}),
        });
        // 読み込みに、Interaction の期限の大部分にあたる時間がかかる。
        const session: InteractionGuardedSession = {
          ...scripted,
          page: {
            ...(scripted.page as unknown as Record<string, unknown>),
            goto: async () => { await wait(1_200); },
          } as unknown as Page,
        };

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
            goto: async (_url: string, options: { readonly timeout?: number }): Promise<never> => {
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
            goto: async (): Promise<never> => {
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

      // I-1: style の変化が CSS のカスタムプロパティ（`--*`）だけの場合は、根拠にしない。
      it('does not verify an inert button whose pointerdown leaves only a CSS custom property in its style', async () => {
        const path = '/ripple-custom-property-button.html';
        const candidate = await candidateNamed(path, 'Ripple variable inert');

        const result = await auditInteraction(input(path, candidate));

        expect(result.status, JSON.stringify(result)).toBe('NOT_VERIFIABLE');
        expect(POST_CLICK_DEADLINE_REASONS).toContain(result.reason);
        expect(result.evidence.identityStatus).toBe('MATCHED');
        expect(result.evidence.changedFields).toEqual([]);
        expect(result.evidence.changedAttributes).toEqual([]);
      });

      it('verifies a button whose click changes a regular style property next to a CSS custom property', async () => {
        const path = '/ripple-custom-property-button.html';
        const candidate = await candidateNamed(path, 'Ripple variable grow');

        const result = await auditInteraction(input(path, candidate));

        expect(result.status, JSON.stringify(result)).toBe('VERIFIED');
        expect(result.evidence.changedFields).toEqual(['attributes']);
        expect(result.evidence.changedAttributes).toEqual(['style']);
      });

      describe('style comparison by declaration', () => {
        const recorded = (entries: readonly string[]) => ({ status: 'RECORDED' as const, entries });
        const maxLength = INTERACTION_CANDIDATE_LIMITS.maxAttributeLength;
        const padded = (prefix: string): string => `${prefix} --pad: ${'x'.repeat(maxLength)}`.slice(0, maxLength);

        it.each([
          ['a custom property is added', [], ['style', '--rp-start: 10px 4px;'], []],
          ['a custom property changes next to a regular one', ['style', '--a: 1px; width: 2px;'], ['style', 'width: 2px; --a: 3px;'], []],
          ['a custom property is removed', ['style', '--a: 1px;'], ['style', ''], []],
          ['a custom property with a quoted semicolon changes', ['style', '--a: "x;y";'], ['style', '--a: "z;w";'], []],
          ['a regular property is added next to a custom property', ['style', '--a: 1px;'], ['style', '--a: 1px; width: 320px;'], ['style']],
          ['a regular property changes', ['style', 'width: 1px;'], ['style', 'width: 2px;'], ['style']],
          ['a regular property is removed', ['style', '--a: 1px; width: 1px;'], ['style', '--a: 1px;'], ['style']],
          // 分解できない場合は、これまでの値の比べ方を使う。
          ['a style with a comment changes', ['style', '--a: 1px; /* note */'], ['style', '--a: 2px; /* note */'], ['style']],
          ['a style with an unbalanced quote changes', ['style', '--a: "1px;'], ['style', '--a: "2px;'], ['style']],
          ['a style with a declaration without a colon changes', ['style', '--a: 1px; broken'], ['style', '--a: 2px; broken'], ['style']],
          ['a style that may be truncated changes', ['style', padded('--a: 1px;')], ['style', padded('--a: 2px;')], ['style']],
        ] as const)('names style as changed only when a regular declaration changes: %s', (_label, before, after, expected) => {
          expect(changedInteractionAttributeNames(recorded(before), recorded(after))).toEqual(expected);
        });
      });

      // M-2: class は、名前ごとに、安定しているかを判定して比べる。
      it('verifies a class toggle on a button whose timer toggles another class name', async () => {
        const path = '/timer-class-toggle-button.html';
        const candidate = await candidateNamed(path, 'Timer class toggle');

        const result = await auditInteraction(input(path, candidate));

        expect(result.status, JSON.stringify(result)).toBe('VERIFIED');
        expect(result.evidence.changedFields).toEqual(['attributes']);
        expect(result.evidence.changedAttributes).toEqual(['class']);
      });

      it('verifies a class name that stayed absent during the stability check and appears after the click', async () => {
        const candidate = await candidateNamed('/accordion.html', 'Toggle details');
        const events: string[] = [];
        const pulse = (index: number): string => (index % 2 === 0 ? 'a' : 'b');

        const result = await auditInteraction({
          ...input('/accordion.html', candidate),
          sessionFactory: async () => scriptedSession(candidate, {
            events,
            snapshot: (phase, index) => ({
              attributes: ['class', phase === 'OBSERVED' ? `${pulse(index + 1)} c` : pulse(index)],
            }),
          }),
        });

        expect(result.status, result.reason).toBe('VERIFIED');
        expect(result.evidence.changedAttributes).toEqual(['class']);
      });

      describe('class comparison by name', () => {
        const recorded = (entries: readonly string[]) => ({ status: 'RECORDED' as const, entries });
        // F20b（設計書 4.4.1「長い class」）: class の値は、class 専用の上限で切り詰められた可能性があるかを判定する。
        const maxLength = INTERACTION_CANDIDATE_LIMITS.maxClassAttributeLength;

        it.each([
          ['a name is added', ['class', 'a pulse'], ['class', 'pulse active a'], ['active']],
          ['a name is removed and another added', ['class', 'a pulse'], ['class', 'a active'], ['active', 'pulse']],
          ['the attribute appears', [], ['class', 'x'], ['x']],
          ['only the order and spacing change', ['class', 'a b'], ['class', ' b\ta '], []],
        ] as const)('lists the changed class names when %s', (_label, before, after, expected) => {
          expect(changedInteractionClassNames(recorded(before), recorded(after))).toEqual(expected);
        });

        it('does not name class as changed when only the order of its names changes', () => {
          expect(changedInteractionAttributeNames(recorded(['class', 'a b']), recorded(['class', 'b a']))).toEqual([]);
        });

        it.each([
          ['an incomplete record', { status: 'INCOMPLETE' as const }, recorded(['class', 'a'])],
          ['a class value that may be truncated', recorded(['class', 'a '.repeat(maxLength).slice(0, maxLength)]), recorded(['class', 'a'])],
        ] as const)('cannot compare class names with %s', (_label, before, after) => {
          expect(changedInteractionClassNames(before, after)).toBeNull();
        });

        it('treats class as unstable as a whole when its names cannot be compared and some names were unstable', async () => {
          const candidate = await candidateNamed('/accordion.html', 'Toggle details');
          const difference = { changedAttributeNames: ['class'], changedClassNames: null, detailsOpen: { before: null, after: null } };

          const unstable = collectInteractionChangeEvidence(candidate, candidate, {
            difference,
            instability: { fields: new Set<string>(), attributeNames: new Set<string>(), classNames: new Set(['pulse']) },
          });
          const stable = collectInteractionChangeEvidence(candidate, candidate, { difference });

          expect(unstable.changedAttributes).toEqual([]);
          expect(unstable.changedFields).toEqual([]);
          // F20b（設計書 4.4.1「長い class」）: 名前ごとに比べられない class の変化は、不安定な名前がなくても根拠にしない（fail-closed）。
          expect(stable.changedAttributes).toEqual([]);
          expect(stable.changedFields).toEqual([]);
        });
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

      it('records null open states for a target that is not a details summary', async () => {
        const candidate = await candidateNamed('/accordion.html', 'Toggle details');

        const result = await auditInteraction(input('/accordion.html', candidate));

        expect(result.status, JSON.stringify(result)).toBe('VERIFIED');
        expect(result.evidence.detailsOpenBefore).toBeNull();
        expect(result.evidence.detailsOpenAfter).toBeNull();
      });

      it('records null open states when there is no observation after the click', async () => {
        const candidate = await candidateNamed('/details-disclosure.html', 'Closed disclosure');

        const result = await auditInteraction({ ...input('/details-disclosure.html', candidate), timeoutMs: 200 });

        expect(result.status).toBe('NOT_VERIFIABLE');
        expect(result.evidence.detailsOpenBefore).toBeNull();
        expect(result.evidence.detailsOpenAfter).toBeNull();
      });
    });
  });

  describe('F19 R7: attributes of tooltips and input modality are not evidence', () => {
    const PAGE = '/non-evidence-attribute-buttons.html';
    const POST_CLICK_DEADLINE_REASONS = [
      'DEADLINE_BEFORE_POST_CONDITION_OBSERVATION',
      'DEADLINE_DURING_POST_CONDITION_OBSERVATION',
      'NO_OBSERVABLE_CHANGE',
    ];
    // 設計書 2026-09-23 4.4.1「根拠にしない属性」の一覧。
    // F20（R8 の Important-1）で是正: 設計書の一覧に `data-headlessui-state` が加わった。
    const DESIGN_NON_EVIDENCE_ATTRIBUTES = [
      'aria-describedby',
      'data-state',
      'data-focus-visible',
      'data-focused',
      'data-focus',
      'data-focus-within',
      'data-hovered',
      'data-hover',
      'data-pressed',
      'data-active',
      'data-headlessui-state',
    ] as const;
    const differenceOf = (names: readonly string[]) => ({
      changedAttributeNames: names,
      changedClassNames: null,
      detailsOpen: { before: null, after: null },
    });

    // Important-1: 押したことで tooltip や入力の種類の属性だけが変わったまま残る、何もしないボタン。
    it.each([
      ['Radix tooltip inert'],
      ['Tippy tooltip inert'],
      ['React Aria focus inert'],
    ] as const)('does not verify an inert button whose tooltip or modality attributes change on press (%s)', async (name) => {
      const candidate = await candidateNamed(PAGE, name);

      const result = await auditInteraction(input(PAGE, candidate));

      expect(result.status, JSON.stringify(result)).toBe('NOT_VERIFIABLE');
      expect(POST_CLICK_DEADLINE_REASONS).toContain(result.reason);
      expect(result.evidence.identityStatus).toBe('MATCHED');
      expect(result.evidence.changedFields).toEqual([]);
      expect(result.evidence.changedAttributes).toEqual([]);
      expect(result.evidence.changedAttributesTruncated).toBe(false);
      expect(result.safety.blockedInteractionRequests).toEqual([]);
    });

    // Radix のアコーディオンの形: data-state と aria-expanded が一緒に変わる。data-state を除いても、ARIA の状態で確かめられる。
    it('verifies a Radix-style accordion by its ARIA state, without data-state as evidence', async () => {
      const candidate = await candidateNamed(PAGE, 'Radix accordion toggle');

      const result = await auditInteraction(input(PAGE, candidate));

      expect(result.status, JSON.stringify(result)).toBe('VERIFIED');
      expect(result.evidence.changedFields).toEqual(
        expect.arrayContaining(['ariaExpanded', 'controlledVisible', 'controlledHidden', 'attributes']),
      );
      expect(result.evidence.changedAttributes).toEqual(['aria-expanded']);
      expect(result.evidence.changedAttributesTruncated).toBe(false);
    });

    it('defines the non-evidence attributes in one named constant, as listed in the design', () => {
      expect([...INTERACTION_NON_EVIDENCE_ATTRIBUTES]).toEqual([...DESIGN_NON_EVIDENCE_ATTRIBUTES]);
    });

    it.each(DESIGN_NON_EVIDENCE_ATTRIBUTES)('never counts a change of %s as evidence', async (name) => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');

      const evidence = collectInteractionChangeEvidence(candidate, candidate, { difference: differenceOf([name]) });

      expect(evidence.changedFields).toEqual([]);
      expect(evidence.changedAttributes).toEqual([]);
      expect(evidence.changedAttributesTruncated).toBe(false);
    });

    it('keeps only the attributes that are evidence when they change together with non-evidence attributes', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');

      const evidence = collectInteractionChangeEvidence(candidate, candidate, {
        difference: differenceOf(['aria-expanded', 'data-state', 'aria-describedby', 'data-open']),
      });

      expect(evidence.changedFields).toEqual(['attributes']);
      expect(evidence.changedAttributes).toEqual(['aria-expanded', 'data-open']);
    });

    it('does not count the non-evidence attributes toward the truncation of the changed attribute names', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const evidenceNames = Array.from(
        { length: MAX_CHANGED_ATTRIBUTE_NAMES },
        (_unused, index) => `data-changed-${String(index).padStart(3, '0')}`,
      );

      const evidence = collectInteractionChangeEvidence(candidate, candidate, {
        difference: differenceOf([...evidenceNames, ...DESIGN_NON_EVIDENCE_ATTRIBUTES]),
      });

      expect(evidence.changedAttributes).toEqual(evidenceNames);
      expect(evidence.changedAttributesTruncated).toBe(false);
    });

    // Minor-3: 持続の確認で attributes が根拠から外れた場合は、切り詰めの印を残さない。
    it('clears changedAttributesTruncated when the persistence check drops attributes from the evidence', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const namesWithPrefix = (prefix: string): readonly string[] => Array.from(
        { length: MAX_CHANGED_ATTRIBUTE_NAMES + 1 },
        (_unused, index) => `data-${prefix}-${String(index).padStart(3, '0')}`,
      );
      const latest = collectInteractionChangeEvidence(candidate, candidate, { difference: differenceOf(namesWithPrefix('late')) });
      const earlier = collectInteractionChangeEvidence(candidate, candidate, { difference: differenceOf(namesWithPrefix('early')) });
      expect(latest.changedAttributesTruncated).toBe(true);
      expect(earlier.changedAttributesTruncated).toBe(true);

      const persistent = retainPersistentInteractionChanges(latest, earlier);

      expect(persistent.changedFields).toEqual([]);
      expect(persistent.changedAttributes).toEqual([]);
      expect(persistent.changedAttributesTruncated).toBe(false);
    });
  });

  describe('F20 R8: focus and hover names are not evidence, and explicit tabs are not focused before the freeze', () => {
    const ATTRIBUTES_PAGE = '/non-evidence-attribute-buttons.html';
    const TABS_PAGE = '/focus-activated-tabs.html';
    const POST_CLICK_DEADLINE_REASONS = [
      'DEADLINE_BEFORE_POST_CONDITION_OBSERVATION',
      'DEADLINE_DURING_POST_CONDITION_OBSERVATION',
      'NO_OBSERVABLE_CHANGE',
    ];
    const FOCUS_STATE_CHANGED_REASON = 'FOCUS_PREPARATION_STATE_CHANGED';
    const differenceOf = (names: readonly string[], classNames: readonly string[] | null = null) => ({
      changedAttributeNames: names,
      changedClassNames: classNames,
      detailsOpen: { before: null, after: null },
    });

    // Important-1: Headless UI v2 と MUI の形の、何もしないボタン。押したことで、focus と hover を表す名前だけが変わったまま残る。
    it.each([
      ['Headless UI inert'],
      ['MUI focus visible inert'],
    ] as const)('does not verify an inert button whose focus or hover names change on press (%s)', async (name) => {
      const candidate = await candidateNamed(ATTRIBUTES_PAGE, name);

      const result = await auditInteraction(input(ATTRIBUTES_PAGE, candidate));

      expect(result.status, JSON.stringify(result)).toBe('NOT_VERIFIABLE');
      expect(POST_CLICK_DEADLINE_REASONS).toContain(result.reason);
      expect(result.evidence.identityStatus).toBe('MATCHED');
      expect(result.evidence.changedFields).toEqual([]);
      expect(result.evidence.changedAttributes).toEqual([]);
      expect(result.safety.blockedInteractionRequests).toEqual([]);
    });

    it('keeps verifying a toggle that switches the .active class', async () => {
      const candidate = await candidateNamed('/stateful-widgets.html', 'Class toggle');

      const result = await auditInteraction(input('/stateful-widgets.html', candidate));

      expect(result.status, JSON.stringify(result)).toBe('VERIFIED');
      expect(result.evidence.changedFields).toEqual(['attributes']);
      expect(result.evidence.changedAttributes).toEqual(['class']);
    });

    it('defines the name rule in one named constant that matches focus or hover without regard to case', () => {
      for (const name of ['focus', 'FOCUS', 'Mui-focusVisible', 'is-focused', 'is-hovered', 'data-focus-ring', 'Hover']) {
        expect(INTERACTION_NON_EVIDENCE_NAME_PATTERN.test(name), name).toBe(true);
      }
      for (const name of ['active', 'is-active', 'open', 'data-open', 'selected']) {
        expect(INTERACTION_NON_EVIDENCE_NAME_PATTERN.test(name), name).toBe(false);
      }
    });

    it.each([
      ['data-focus-ring'],
      ['data-is-hovered'],
      ['data-HOVER-state'],
      ['data-headlessui-state'],
    ] as const)('never counts a change of the data attribute %s as evidence', async (name) => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');

      const evidence = collectInteractionChangeEvidence(candidate, candidate, { difference: differenceOf([name]) });

      expect(evidence.changedFields).toEqual([]);
      expect(evidence.changedAttributes).toEqual([]);
    });

    it('keeps a changed attribute whose name contains focus or hover but is not a data attribute', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');

      const evidence = collectInteractionChangeEvidence(candidate, candidate, { difference: differenceOf(['onfocus']) });

      expect(evidence.changedFields).toEqual(['attributes']);
      expect(evidence.changedAttributes).toEqual(['onfocus']);
    });

    it.each([
      [['Mui-focusVisible']],
      [['is-focused']],
      [['is-hovered', 'IS-FOCUS']],
    ] as const)('never counts a change of only the class names %j as evidence', async (classNames) => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');

      const evidence = collectInteractionChangeEvidence(candidate, candidate, {
        difference: differenceOf(['class'], classNames),
      });

      expect(evidence.changedFields).toEqual([]);
      expect(evidence.changedAttributes).toEqual([]);
    });

    it.each([
      [['active']],
      [['is-active']],
      [['is-focused', 'is-open']],
    ] as const)('counts a change of the class names %j as evidence', async (classNames) => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');

      const evidence = collectInteractionChangeEvidence(candidate, candidate, {
        difference: differenceOf(['class'], classNames),
      });

      expect(evidence.changedFields).toEqual(['attributes']);
      expect(evidence.changedAttributes).toEqual(['class']);
    });

    // Important-2: 自動で切り替わるタブは、下準備で focus しないので、click で切り替わったことを確かめられる。
    it('verifies an automatically activated tab that is selected on focus', async () => {
      const candidate = await candidateNamed(TABS_PAGE, 'Auto second tab');

      const result = await auditInteraction(input(TABS_PAGE, candidate));

      expect(result.status, JSON.stringify(result)).toBe('VERIFIED');
      expect(result.evidence.changedFields).toEqual(expect.arrayContaining(['ariaSelected', 'controlledVisible', 'attributes']));
      expect(result.evidence.changedAttributes).toContain('aria-selected');
      expect(result.evidence.changedAttributes).not.toContain('class');
    });

    it('keeps verifying a manually activated tab', async () => {
      const candidate = await candidateNamed(TABS_PAGE, 'Manual second tab');

      const result = await auditInteraction(input(TABS_PAGE, candidate));

      expect(result.status, JSON.stringify(result)).toBe('VERIFIED');
      expect(result.evidence.changedFields).toEqual(expect.arrayContaining(['ariaSelected', 'controlledVisible', 'attributes']));
      expect(result.evidence.changedAttributes).toContain('aria-selected');
      expect(result.evidence.changedAttributes).not.toContain('class');
    });

    it.each([
      ['tab', true],
      ['tab button', true],
      ['\ttab\n', true],
      ['button tab', true],
      ['tablist', false],
      ['tabpanel', false],
      ['button', false],
      ['', false],
      [null, false],
    ] as const)('judges whether the role %j explicitly contains tab', (role, expected) => {
      expect(hasExplicitTabRole(role)).toBe(expected);
    });

    it('does not verify a target without a tab role whose ARIA state changes on the preparatory focus', async () => {
      const candidate = await candidateNamed(TABS_PAGE, 'Focus disclosure');

      const result = await auditInteraction(input(TABS_PAGE, candidate));

      expect(result.status, JSON.stringify(result)).toBe('NOT_VERIFIABLE');
      expectReason(result, FOCUS_STATE_CHANGED_REASON);
      expect(result.evidence.identityStatus).toBe('UNESTABLISHED');
      expect(result.safety.blockedInteractionRequests).toEqual([]);
    });
  });

  describe('F21 R9: attribute changes of an explicit tab are not evidence', () => {
    const TABS_PAGE = '/focus-activated-tabs.html';
    const POST_CLICK_DEADLINE_REASONS = [
      'DEADLINE_BEFORE_POST_CONDITION_OBSERVATION',
      'DEADLINE_DURING_POST_CONDITION_OBSERVATION',
      'NO_OBSERVABLE_CHANGE',
    ];
    const differenceOf = (names: readonly string[], classNames: readonly string[] | null = null) => ({
      changedAttributeNames: names,
      changedClassNames: classNames,
      detailsOpen: { before: null, after: null },
    });

    it('serves Radix-shaped triggers that all start without a tab stop', async () => {
      const page = await browser.newPage({ viewport });
      try {
        await page.goto(`${server.origin}${TABS_PAGE}`);
        const tabIndexes = await page.evaluate(() => Array.from(
          document.querySelectorAll('[role="tablist"][data-roving-activation] [role="tab"]'),
          (tab) => tab.getAttribute('tabindex'),
        ));
        expect(tabIndexes).toEqual(['-1', '-1', '-1', '-1']);
      } finally {
        await page.close();
      }
    });

    // 修正前は、mousedown と focus で変わる tabindex、focus で付く `focused` 属性、focus で変わる inline の style が根拠になり、
    // 何も起きないのに VERIFIED になっていた。
    it.each([
      ['Radix auto first tab'],
      ['Radix manual first tab'],
      ['Focused attribute first tab'],
      ['Box shadow first tab'],
    ] as const)('does not verify pressing the already selected tab (%s)', async (name) => {
      const candidate = await candidateNamed(TABS_PAGE, name);
      expect(hasExplicitTabRole(candidate.role)).toBe(true);

      const result = await auditInteraction(input(TABS_PAGE, candidate));

      expect(result.status, JSON.stringify(result)).toBe('NOT_VERIFIABLE');
      expect(POST_CLICK_DEADLINE_REASONS).toContain(result.reason);
      expect(result.evidence.identityStatus).toBe('MATCHED');
      expect(result.evidence.changedFields).toEqual([]);
      expect(result.evidence.changedAttributes).toEqual([]);
      expect(result.evidence.changedAttributesTruncated).toBe(false);
      expect(result.safety.blockedInteractionRequests).toEqual([]);
    });

    it.each([
      ['Radix auto second tab'],
      ['Radix manual second tab'],
      ['Focused attribute second tab'],
      ['Box shadow second tab'],
    ] as const)('verifies switching to an unselected tab only by the ARIA state and the display (%s)', async (name) => {
      const candidate = await candidateNamed(TABS_PAGE, name);

      const result = await auditInteraction(input(TABS_PAGE, candidate));

      expect(result.status, JSON.stringify(result)).toBe('VERIFIED');
      expect(result.evidence.changedFields).toEqual(expect.arrayContaining(['ariaSelected', 'controlledVisible']));
      expect(result.evidence.changedAttributes).toEqual(['aria-selected']);
      expect(result.evidence.changedAttributes).not.toContain('tabindex');
      expect(result.evidence.changedAttributesTruncated).toBe(false);
    });

    it.each([
      ['Plain active toggle', '/focus-activated-tabs.html'],
      ['Plain open toggle', '/focus-activated-tabs.html'],
      ['Class toggle', '/stateful-widgets.html'],
    ] as const)('keeps verifying the attribute change of a target without a role (%s)', async (name, path) => {
      const candidate = await candidateNamed(path, name);
      expect(hasExplicitTabRole(candidate.role)).toBe(false);

      const result = await auditInteraction(input(path, candidate));

      expect(result.status, JSON.stringify(result)).toBe('VERIFIED');
      expect(result.evidence.changedFields).toEqual(['attributes']);
      expect(result.evidence.changedAttributes).toEqual(['class']);
    });

    it('counts only the ARIA state attributes when attributes other than the ARIA state are not evidence', async () => {
      const candidate = await candidateNamed(TABS_PAGE, 'Radix auto first tab');

      const evidence = collectInteractionChangeEvidence(candidate, candidate, {
        difference: differenceOf(['aria-checked', 'aria-pressed', 'class', 'focused', 'style', 'tabindex'], ['is-open']),
        ariaStateAttributesOnly: true,
      });

      expect(evidence.changedFields).toEqual(['attributes']);
      expect(evidence.changedAttributes).toEqual(['aria-checked', 'aria-pressed']);
      expect(evidence.changedAttributesTruncated).toBe(false);
    });

    it('leaves changedAttributes empty and not truncated when only attributes other than the ARIA state change', async () => {
      const candidate = await candidateNamed(TABS_PAGE, 'Radix auto first tab');
      const names = Array.from({ length: MAX_CHANGED_ATTRIBUTE_NAMES + 1 }, (_unused, index) => `x-${String(index).padStart(3, '0')}`);

      const evidence = collectInteractionChangeEvidence(candidate, candidate, {
        difference: differenceOf([...names, 'tabindex']),
        ariaStateAttributesOnly: true,
      });

      expect(evidence.changedFields).toEqual([]);
      expect(evidence.changedAttributes).toEqual([]);
      expect(evidence.changedAttributesTruncated).toBe(false);
    });

    it('does not count an ARIA state attribute that changed during the stability check', async () => {
      const candidate = await candidateNamed(TABS_PAGE, 'Radix auto first tab');

      const evidence = collectInteractionChangeEvidence(candidate, candidate, {
        difference: differenceOf(['aria-pressed', 'tabindex']),
        instability: {
          fields: new Set<string>(),
          attributeNames: new Set(['aria-pressed']),
          classNames: new Set<string>(),
        },
        ariaStateAttributesOnly: true,
      });

      expect(evidence.changedFields).toEqual([]);
      expect(evidence.changedAttributes).toEqual([]);
    });
  });

  describe('F20b: long class values are recorded up to the class limit and are not evidence when they may be truncated', () => {
    const PAGE = '/non-evidence-attribute-buttons.html';
    const POST_CLICK_DEADLINE_REASONS = [
      'DEADLINE_BEFORE_POST_CONDITION_OBSERVATION',
      'DEADLINE_DURING_POST_CONDITION_OBSERVATION',
      'NO_OBSERVABLE_CHANGE',
    ];
    const recorded = (entries: readonly string[]) => ({ status: 'RECORDED' as const, entries });

    it('serves fixture buttons whose class lengths straddle the attribute limit and the class limit', async () => {
      const page = await browser.newPage({ viewport });
      try {
        await page.goto(`${server.origin}${PAGE}`);
        const lengths: Record<string, number> = await page.evaluate(() => Object.fromEntries(
          ['long-class-focus', 'long-class-toggle', 'huge-class-toggle', 'huge-class-aria-toggle']
            .map((id) => [id, document.getElementById(id)?.getAttribute('class')?.length ?? 0]),
        ));
        for (const id of ['long-class-focus', 'long-class-toggle']) {
          expect(lengths[id], id).toBeGreaterThan(INTERACTION_CANDIDATE_LIMITS.maxAttributeLength);
          expect(lengths[id], id).toBeLessThan(INTERACTION_CANDIDATE_LIMITS.maxClassAttributeLength - 64);
        }
        for (const id of ['huge-class-toggle', 'huge-class-aria-toggle']) {
          expect(lengths[id], id).toBeGreaterThan(INTERACTION_CANDIDATE_LIMITS.maxClassAttributeLength);
        }
      } finally {
        await page.close();
      }
    });

    it('records the class value up to the class limit and the other values up to the attribute limit', async () => {
      const page = await browser.newPage({ viewport });
      try {
        await page.setContent('<button type="button">Long class</button>');
        await page.evaluate(({ classLength, attributeLength }) => {
          const button = document.querySelector('button')!;
          button.setAttribute('class', 'c'.repeat(classLength));
          button.setAttribute('data-long', 'v'.repeat(attributeLength));
        }, {
          classLength: INTERACTION_CANDIDATE_LIMITS.maxClassAttributeLength + 100,
          attributeLength: INTERACTION_CANDIDATE_LIMITS.maxAttributeLength + 100,
        });
        const handle = await page.locator('button').elementHandle();
        if (handle === null) throw new Error('Missing long class candidate');
        try {
          const snapshot = await inspectInteractionCandidateHandle(handle, 0);
          if (snapshot.status !== 'CONNECTED' || snapshot.attributes.status !== 'RECORDED') {
            throw new Error('Expected a recorded attribute list');
          }
          expect(snapshot.attributes.entries).toEqual([
            'type',
            'button',
            'class',
            'c'.repeat(INTERACTION_CANDIDATE_LIMITS.maxClassAttributeLength),
            'data-long',
            'v'.repeat(INTERACTION_CANDIDATE_LIMITS.maxAttributeLength),
          ]);
        } finally {
          await handle.dispose();
        }
      } finally {
        await page.close();
      }
    });

    it('compares a class value longer than the attribute limit by name', () => {
      const utilities = Array.from({ length: 80 }, (_unused, index) => `tw-utility-${index}`).join(' ');
      expect(utilities.length).toBeGreaterThan(INTERACTION_CANDIDATE_LIMITS.maxAttributeLength);

      expect(changedInteractionClassNames(recorded(['class', `btn ${utilities}`]), recorded(['class', `btn focus-visible ${utilities}`])))
        .toEqual(['focus-visible']);
      expect(changedInteractionAttributeNames(recorded(['class', `btn ${utilities}`]), recorded(['class', `${utilities} btn`])))
        .toEqual([]);
    });

    it('does not count a class change as evidence when the class value may be truncated at the class limit', async () => {
      const candidate = await candidateNamed('/accordion.html', 'Toggle details');
      const truncated = (prefix: string): string => `${prefix} ${'u '.repeat(INTERACTION_CANDIDATE_LIMITS.maxClassAttributeLength)}`
        .slice(0, INTERACTION_CANDIDATE_LIMITS.maxClassAttributeLength);
      const before = recorded(['class', truncated('btn')]);
      const after = recorded(['class', truncated('btn is-open')]);

      const evidence = collectInteractionChangeEvidence(candidate, candidate, {
        difference: {
          changedAttributeNames: changedInteractionAttributeNames(before, after),
          changedClassNames: changedInteractionClassNames(before, after),
          detailsOpen: { before: null, after: null },
        },
      });

      expect(changedInteractionAttributeNames(before, after)).toEqual(['class']);
      expect(changedInteractionClassNames(before, after)).toBeNull();
      expect(evidence.changedFields).toEqual([]);
      expect(evidence.changedAttributes).toEqual([]);
    });

    it('does not verify an inert button with a long class whose focus-visible name is removed on press', async () => {
      const candidate = await candidateNamed(PAGE, 'Long class focus visible inert');

      const result = await auditInteraction(input(PAGE, candidate));

      expect(result.status, JSON.stringify(result)).toBe('NOT_VERIFIABLE');
      expect(POST_CLICK_DEADLINE_REASONS).toContain(result.reason);
      expect(result.evidence.identityStatus).toBe('MATCHED');
      expect(result.evidence.changedFields).toEqual([]);
      expect(result.evidence.changedAttributes).toEqual([]);
      expect(result.safety.blockedInteractionRequests).toEqual([]);
    });

    it('verifies a toggle with a long class that switches the is-open class name', async () => {
      const candidate = await candidateNamed(PAGE, 'Long class toggle');

      const result = await auditInteraction(input(PAGE, candidate));

      expect(result.status, JSON.stringify(result)).toBe('VERIFIED');
      expect(result.evidence.changedFields).toEqual(['attributes']);
      expect(result.evidence.changedAttributes).toEqual(['class']);
    });

    it('does not verify a toggle whose class exceeds the class limit when it has no ARIA state (fail-closed)', async () => {
      const candidate = await candidateNamed(PAGE, 'Huge class toggle');

      const result = await auditInteraction(input(PAGE, candidate));

      expect(result.status, JSON.stringify(result)).toBe('NOT_VERIFIABLE');
      expect(POST_CLICK_DEADLINE_REASONS).toContain(result.reason);
      expect(result.evidence.identityStatus).toBe('MATCHED');
      expect(result.evidence.changedFields).toEqual([]);
      expect(result.evidence.changedAttributes).toEqual([]);
      expect(result.safety.blockedInteractionRequests).toEqual([]);
    });

    it('verifies a toggle whose class exceeds the class limit by its ARIA state', async () => {
      const candidate = await candidateNamed(PAGE, 'Huge class ARIA toggle');

      const result = await auditInteraction(input(PAGE, candidate));

      expect(result.status, JSON.stringify(result)).toBe('VERIFIED');
      expect(result.evidence.changedFields).toEqual(expect.arrayContaining(['ariaExpanded', 'attributes']));
      expect(result.evidence.changedAttributes).toEqual(['aria-expanded']);
    });
  });
});

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
      page: { goto } as unknown as Page,
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
      focus: async () => undefined,
      dispose: async () => undefined,
    };
    const page = {
      goto: async () => undefined,
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

  it('gives OBSERVED_NO_CHANGE to a button whose state changes on the preparatory focus', async () => {
    const candidate = await candidateNamed('/focus-activated-tabs.html', 'Focus disclosure');

    const result = await auditInteraction(input('/focus-activated-tabs.html', candidate));

    expect(result.status, JSON.stringify(result)).toBe('NOT_VERIFIABLE');
    expectReason(result, 'FOCUS_PREPARATION_STATE_CHANGED');
    expect(result.notVerifiableKind).toBe('OBSERVED_NO_CHANGE');
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

  it('gives CHECK_NOT_COMPLETED when the DOM work budget is exhausted', async () => {
    const candidate = await candidateNamed('/accordion.html', 'Toggle details');
    const rawCandidate = rawCandidateFor(candidate);
    const page = {
      goto: async () => undefined,
      evaluate: async (_callback: unknown, argument?: unknown) => (
        argument === undefined
          ? true
          : { candidates: [rawCandidate], completeness: 'COMPLETE', domWorkUsed: INTERACTION_CANDIDATE_LIMITS.maxDomWork }
      ),
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

    expect(result.status).toBe('NOT_VERIFIABLE');
    expectReason(result, 'DOM_WORK_EXHAUSTED');
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
    // C18n: 対応表は、コードの一覧（`INTERACTION_NOT_VERIFIABLE_REASON_CODES`）のすべてのコードから区分への対応だけを持つ。
    // 英文は持たない（Evidence の理由はコードにし、詳細は `reasonDetail` に入れる）。
    const table: Readonly<Record<string, unknown>> = INTERACTION_NOT_VERIFIABLE_REASONS;
    const entries = Object.entries(table);
    expect(Object.isFrozen(table)).toBe(true);
    expect(entries).toHaveLength(55);
    expect(Object.keys(table)).toEqual([...INTERACTION_NOT_VERIFIABLE_REASON_CODES]);
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
      page: { goto: async () => { gotoCalls += 1; } } as unknown as Page,
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
      goto: async () => undefined,
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
