/**
 * Safety の Gate（GATE-S01〜S10。Task 18 の設計書 4.2）と、Guard の統合テストの補助（T18b。CC-029 で整理した）。
 *
 * - Gate は、fixture のサーバの側で「届かなかった」ことを数えて確かめる。数え方は、印を付けた時点からの差分である
 *   （`openServerWindow`）。`getCounters()` と `getRequestObservations()` を、印の時点の値と比べる。サーバの記録を消さない
 *   （`resetCounters` を呼ばない）ので、同じサーバを使うほかの確認と干渉しない。
 * - 対照の確認（Guard のない Context で、同じ操作がサーバに届くこと）に使う、Guard のない page を開く補助を置く。
 * - Guard の付いた Passive の page を開いて閉じる補助（`withGuardedPassivePage`）と、headless と headed の注入の、2つの設定の
 *   factory（`FACTORY_MODES`、`createModeFactories`）、遅れて起きる事象を待つ時間（`QUIET_PERIOD_MS`）を置く（CC-031）。
 * - Interaction の段階の確認に使う、候補の探索と `auditInteraction` の入力の組み立てを置く。
 * - ほかの補助の置き場所（CC-029）:
 *   - Run の起動、CLI の出力の受け取り、artifact の読み取り、Run の結果の確かめ方: `run-harness.ts`
 *   - Browser の Proxy（`newContext` の失敗、`context.close()` の停止）: `browser-proxies.ts`
 *   - 外部スキームへの移動の fixture の宛先、経路、パスと、Ledger に残るはずの値: `external-scheme-fixture.ts`
 *   - headless の Chromium の起動（`--site-per-process` を含む）と、OOPIF の target の一覧: `chromium.ts`
 */
import type { Browser, BrowserContext, Page } from 'playwright';
import { expect } from 'vitest';
import type { FixtureRequestObservation, FixtureServer, FixtureServerCounters } from '../../fixtures/server.js';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { Viewport } from '../../src/config/types.js';
import { discoverInteractionCandidates, type InteractionCandidateDiscoveryResult } from '../../src/interaction/discover-candidates.js';
import type { InteractionAuditInput } from '../../src/interaction/isolated-auditor.js';
import type { InteractionCandidate } from '../../src/safety/interaction-policy.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { closePassiveResources } from './passive-cleanup.js';
import { createTestConfig } from './test-config.js';

// ---------------------------------------------------------------------------------------------------------------
// 待つ時間
// ---------------------------------------------------------------------------------------------------------------

/**
 * 記録や遮断を確かめた後に、遅れて起きる事象（遅れて届くリクエスト、違反、Context を閉じる処理）を待つ時間（ms）。
 * 「届かなかった」「起きなかった」ことを確かめる前の余裕であり、期限の値ではない。
 */
export const QUIET_PERIOD_MS = 300;

// ---------------------------------------------------------------------------------------------------------------
// サーバの境界で数える
// ---------------------------------------------------------------------------------------------------------------

export type FixtureCounterName = keyof FixtureServerCounters;

/** GET・HEAD 以外のメソッドのカウンタ（fixture のサーバは、GET・HEAD 以外のすべてのメソッドを、このどれかで数える）。 */
export const NON_READ_METHOD_COUNTERS = Object.freeze(['post', 'put', 'patch', 'delete', 'options', 'other'] as const);
export type NonReadMethodCounterName = (typeof NON_READ_METHOD_COUNTERS)[number];

/** `NON_READ_METHOD_COUNTERS` のすべてが 0 の値（`toEqual` の期待値に使う）。 */
export const NO_NON_READ_REQUESTS: Readonly<Record<NonReadMethodCounterName, number>> = Object.freeze({
  post: 0,
  put: 0,
  patch: 0,
  delete: 0,
  options: 0,
  other: 0,
});

/** 印を付けた時点からの、fixture のサーバの記録の差分。 */
export interface ServerWindow {
  /** 印の時点からの、カウンタの増分。 */
  counters(): Readonly<Record<FixtureCounterName, number>>;
  /** 印の時点からの、GET・HEAD 以外のメソッドのカウンタの増分。 */
  nonReadCounters(): Readonly<Record<NonReadMethodCounterName, number>>;
  /** 印の時点の後に記録されたリクエスト（記録の順）。WebSocket の Upgrade は含まない（`counters().webSocketUpgrade` で数える）。 */
  observations(): readonly Readonly<FixtureRequestObservation>[];
  /** 印の時点の後に記録されたリクエストの `<メソッド> <パス>` の一覧（記録の順）。 */
  requestLines(): readonly string[];
  /** 印の時点の後に記録された、`method` と `pathname` が一致するリクエストの件数。`method` が `null` なら、メソッドを問わない。 */
  count(method: string | null, pathname: string): number;
}

/**
 * fixture のサーバに印を付け、その時点からの差分を返す `ServerWindow` を作る。
 * 印の後に、ほかの処理がサーバの記録を消した（`resetCounters`・`resetRequestObservations`）場合は、差分が意味を持たないので投げる。
 */
export function openServerWindow(server: FixtureServer): ServerWindow {
  const baseCounters = server.getCounters();
  const baseObservationCount = server.getRequestObservations().length;

  const counters = (): Readonly<Record<FixtureCounterName, number>> => {
    const current = server.getCounters();
    const delta = {} as Record<FixtureCounterName, number>;
    for (const name of Object.keys(current) as FixtureCounterName[]) {
      const value = current[name] - baseCounters[name];
      if (value < 0) {
        throw new Error(`the fixture server counter ${name} was reset after the window was opened`);
      }
      delta[name] = value;
    }
    return Object.freeze(delta);
  };
  const observations = (): readonly Readonly<FixtureRequestObservation>[] => {
    const all = server.getRequestObservations();
    if (all.length < baseObservationCount) {
      throw new Error('the fixture server request observations were reset after the window was opened');
    }
    return all.slice(baseObservationCount);
  };
  return Object.freeze({
    counters,
    nonReadCounters: (): Readonly<Record<NonReadMethodCounterName, number>> => {
      const delta = counters();
      return Object.freeze(Object.fromEntries(NON_READ_METHOD_COUNTERS.map((name) => [name, delta[name]])) as Record<
        NonReadMethodCounterName,
        number
      >);
    },
    observations,
    requestLines: (): readonly string[] => observations().map((entry) => `${entry.method} ${entry.pathname}`),
    count: (method: string | null, pathname: string): number => observations().filter((entry) => (
      (method === null || entry.method === method) && entry.pathname === pathname
    )).length,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// 対照の確認（Guard のない Context）
// ---------------------------------------------------------------------------------------------------------------

/**
 * Guard を取り付けない Context で page を1つ開き、`run` に渡す。終わったら（失敗しても）Context を閉じる。
 * 対照の確認（同じ操作が、Guard がなければサーバに届くこと）に使う。
 */
export async function withUnguardedPage<T>(
  browser: Browser,
  viewport: Viewport,
  run: (page: Page) => Promise<T>,
): Promise<T> {
  const context = await browser.newContext({ viewport });
  try {
    return await run(await context.newPage());
  } finally {
    await context.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Guard の付いた Passive の page
// ---------------------------------------------------------------------------------------------------------------

/** `withGuardedPassivePage` の追加の指定。 */
export interface GuardedPassivePageOptions {
  /** Context を作った直後（page を開く前）に呼ぶ（例: Context の関数を差し替える）。 */
  readonly prepare?: (context: BrowserContext) => void;
  /**
   * `true` にすると、`run` が終わった後（page と Context を閉じる前）に、Safety Ledger の違反が0件であることを確かめる（RC18 の M4）。
   * 閉じる処理の失敗は捨てるので、Guard が Context を無効にした違反を、閉じる処理の失敗では見つけられないためである。
   * 既定は `false`（確かめない）。違反を確かめるテストも、この補助を使うためである。
   */
  readonly expectNoViolations?: boolean;
}

/** Safety Ledger の違反が0件であることを確かめる。違反があれば、件数と違反の一覧（コードと文言）が分かる形で失敗する。 */
function expectNoLedgerViolations(ledger: SafetyLedger): void {
  const { invariantViolationCount, invariantViolations } = ledger.snapshot();
  expect(
    { invariantViolationCount, invariantViolations },
    `Safety Ledger violations: ${JSON.stringify(invariantViolations)}`,
  ).toEqual({ invariantViolationCount: 0, invariantViolations: [] });
}

/**
 * `factory` で、Guard の付いた Passive の Context と page を開き、page、Context、その Context の Safety Ledger を `run` に渡す。
 * `options.expectNoViolations` のときは、`run` の後に、Safety Ledger の違反が0件であることを確かめる。
 * 終わったら（`run` や確かめが失敗しても）、`closePassiveResources` で page と Context を閉じる。
 */
export async function withGuardedPassivePage<T>(
  factory: BrowserContextFactory,
  viewport: Viewport,
  run: (page: Page, context: BrowserContext, ledger: SafetyLedger) => Promise<T>,
  options: GuardedPassivePageOptions = {},
): Promise<T> {
  const context = await factory.createPassiveContext(viewport);
  let page: Page | undefined;
  try {
    options.prepare?.(context);
    page = await factory.createPassivePage(context);
    const ledger = factory.getSafetyLedger(context);
    const result = await run(page, context, ledger);
    if (options.expectNoViolations === true) {
      expectNoLedgerViolations(ledger);
    }
    return result;
  } finally {
    await closePassiveResources({ factory, context, page });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// headless と headed の注入
// ---------------------------------------------------------------------------------------------------------------

/**
 * Guard の設定の2つの形（テストの題名に使う）。
 * - `headless`: 設定も headless である。
 * - `headed (injected)`: headless のブラウザのまま、設定だけを headed（`browser.headed: true`）にして、Guard に「headed である」と
 *   注入する。実際の headed のブラウザは起動しない（端末の外部のアプリが起動するおそれがあるため）。
 */
export const FACTORY_MODES = Object.freeze(['headless', 'headed (injected)'] as const);
export type FactoryMode = (typeof FACTORY_MODES)[number];

/**
 * `browser`（headless で起動したもの）で、`FACTORY_MODES` のそれぞれの設定の factory を作る。
 * 設定は `createTestConfig(origin)` で、headed の注入だけが違う。Safety Ledger は、Context ごとに新しく作る。
 */
export function createModeFactories(browser: Browser, origin: string): Readonly<Record<FactoryMode, BrowserContextFactory>> {
  return Object.freeze({
    headless: new BrowserContextFactory(browser, createTestConfig(origin), () => new SafetyLedger()),
    'headed (injected)': new BrowserContextFactory(
      browser,
      createTestConfig(origin, '/', { browser: { headed: true } }),
      () => new SafetyLedger(),
    ),
  });
}

/** `FACTORY_MODES` と `values` のすべての組み合わせ（`it.each` の行。設定の形の順に、`values` の順）。 */
export function factoryModeCases<T>(values: readonly T[]): (readonly [FactoryMode, T])[] {
  return FACTORY_MODES.flatMap((mode) => values.map((value) => [mode, value] as const));
}

// ---------------------------------------------------------------------------------------------------------------
// Interaction の段階
// ---------------------------------------------------------------------------------------------------------------

/** Gate の Interaction の確認の期限（ms）。製品の値ではなく、fixture の小さなページに合わせた、テストの値である。 */
export const GATE_INTERACTION_TIMING = Object.freeze({
  navigationTimeoutMs: 5_000,
  timeoutMs: 2_000,
  overallMs: 5_000,
});

/** `discoverInteractionCandidate` の追加の指定。 */
export interface InteractionCandidateDiscoveryOptions {
  /** 指定すると、探索の結果の `completeness` がこの値であることを確かめる（省略すると、確かめない）。 */
  readonly expectedCompleteness?: InteractionCandidateDiscoveryResult['completeness'];
}

/**
 * Guard の付いた Passive の page で `path` を開き、名前が `name` の Interaction の候補を探す。
 * 探索でも `path` への GET がサーバに届くので、数える確認は、この後に `openServerWindow` で印を付けてから行う。
 */
export async function discoverInteractionCandidate(
  factory: BrowserContextFactory,
  origin: string,
  viewport: Viewport,
  path: string,
  name: string,
  options: InteractionCandidateDiscoveryOptions = {},
): Promise<InteractionCandidate> {
  const context = await factory.createPassiveContext(viewport);
  let page: Page | undefined;
  try {
    page = await factory.createPassivePage(context);
    await page.goto(`${origin}${path}`, { waitUntil: 'load' });
    const { candidates, completeness } = await discoverInteractionCandidates(page);
    if (options.expectedCompleteness !== undefined) {
      expect(completeness).toBe(options.expectedCompleteness);
    }
    const found = candidates.find((candidate) => candidate.accessibleName === name);
    if (found === undefined) {
      throw new Error(`missing fixture interaction candidate: ${path} ${name}`);
    }
    return found;
  } finally {
    await closePassiveResources({ factory, context, page });
  }
}

/** `interactionAuditInput` の指定。 */
export interface InteractionGateInputOptions {
  readonly factory: BrowserContextFactory;
  readonly origin: string;
  readonly viewport: Viewport;
  readonly path: string;
  readonly candidate: InteractionCandidate;
  /** 省略すると、`factory.createInteractionSession`。 */
  readonly sessionFactory?: InteractionAuditInput['sessionFactory'];
  /** 凍結を待つ上限（ms）。期限のテストで、短い期限を注入する。 */
  readonly freezeActivationTimeoutMs?: number;
}

/** `auditInteraction` の入力（期限は `GATE_INTERACTION_TIMING`）。 */
export function interactionAuditInput(options: InteractionGateInputOptions): InteractionAuditInput {
  return {
    sessionFactory: options.sessionFactory ?? ((sessionViewport) => options.factory.createInteractionSession(sessionViewport)),
    targetUrl: `${options.origin}${options.path}`,
    candidate: options.candidate,
    viewport: options.viewport,
    navigationTimeoutMs: GATE_INTERACTION_TIMING.navigationTimeoutMs,
    timeoutMs: GATE_INTERACTION_TIMING.timeoutMs,
    deadlineAtMs: Date.now() + GATE_INTERACTION_TIMING.overallMs,
    ...(options.freezeActivationTimeoutMs === undefined ? {} : { freezeActivationTimeoutMs: options.freezeActivationTimeoutMs }),
  };
}
