/**
 * Safety の Gate（GATE-S01〜S10。Task 18 の設計書 4.2）と、Guard の統合テストの補助（T18b。CC-029 で整理した）。
 *
 * - Gate は、fixture のサーバの側で「届かなかった」ことを数えて確かめる。数え方は、印を付けた時点からの差分である
 *   （`openServerWindow`）。`getCounters()` と `getRequestObservations()` を、印の時点の値と比べる。サーバの記録を消さない
 *   （`resetCounters` を呼ばない）ので、同じサーバを使うほかの確認と干渉しない。
 * - 対照の確認（Guard のない Context で、同じ操作がサーバに届くこと）に使う、Guard のない page を開く補助を置く。
 * - Guard の付いた Passive の page を開いて閉じる補助（`withGuardedPassivePage`）と、Gate の factory（`createGateFactory`）、
 *   遅れて起きる事象を待つ時間（`QUIET_PERIOD_MS`）を置く（CC-031）。凍結中のポップアップの遅れて届く要求を待つ時間
 *   （`FROZEN_POPUP_LATE_DELIVERY_SETTLE_MS`。DEF-036）も置く。
 * - ページを離れるときの送信が Guard の付いた Passive の閉じる手順で届かないことの確かめと、その対照（DEF-038）を置く。
 * - Worker の中の WebSocket が Guard の付いた session で届かないことの確かめと、その対照（DEF-040。NP3）を置く。
 * - Shared Worker の中の POST の fixture のパスと、fixture が残す Shared Worker の状態の読み取り（DEF-044。NP5）を置く。
 * - Service Worker の登録の迂回の fixture のパスと、Guard の付いた session でその結果を確かめる補助（DEF-049。NP6）を置く。
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
import { wait } from '../../src/core/deadline.js';
import type { BlockedNavigationEvent, BlockedRequestEvent, BlockedWebSocketEvent } from '../../src/core/evidence-types.js';
import { discoverInteractionCandidates, type InteractionCandidateDiscoveryResult } from '../../src/interaction/discover-candidates.js';
import type { InteractionAuditInput } from '../../src/interaction/isolated-auditor.js';
import { closePassivePageAndContext, type PassiveSessionCloseFailure } from '../../src/orchestration/passive-session-close.js';
import type { InteractionCandidate } from '../../src/safety/interaction-policy.js';
import { isPassiveRequestGuardClosed } from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { BROWSER_DEFAULT_FAVICON_PATH } from './chromium.js';
import { closePassiveResources } from './passive-cleanup.js';
import { createTestConfig, TEST_FACTORY_OPTIONS } from './test-config.js';

// ---------------------------------------------------------------------------------------------------------------
// 待つ時間
// ---------------------------------------------------------------------------------------------------------------

/**
 * 記録や遮断を確かめた後に、遅れて起きる事象（遅れて届くリクエスト、違反、Context を閉じる処理）を待つ時間（ms）。
 * 「届かなかった」「起きなかった」ことを確かめる前の余裕であり、期限の値ではない。
 */
export const QUIET_PERIOD_MS = 300;

/**
 * DEF-036: 凍結中のポップアップの要求を確かめるくり返しの監査を全部終えた後に、サーバの記録を改めて確かめる前に待つ時間（ms）。
 * Context を閉じた後に遅れて届く要求を見逃さないためである（修正の前の漏れは、閉じた数 ms 後に届いた）。期限の値ではなく、
 * 確かめる前の余裕である。`isolated-interaction.test.ts` の DEF-036 のテストと、`safety-gates.test.ts` の GATE-S04 で共有する。
 * ページを離れるときの送信の確かめ（DEF-038。`runGuardedUnloadBeaconRounds`）でも、同じ考えで使う。
 */
export const FROZEN_POPUP_LATE_DELIVERY_SETTLE_MS = 1_000;

// ---------------------------------------------------------------------------------------------------------------
// ページを離れるときの送信（DEF-038）
// ---------------------------------------------------------------------------------------------------------------

/** DEF-038: ページを離れるとき（`pagehide` と、隠れたときの `visibilitychange`）だけ、POST /__mutation を送る fixture のページ。 */
export const UNLOAD_BEACON_PAGE = '/unload-beacon.html';

/** `UNLOAD_BEACON_PAGE` が送る POST の宛先のパス。 */
export const UNLOAD_BEACON_TARGET_PATH = '/__mutation';

/**
 * DEF-038: Guard の付いた Passive の page を開き、製品の閉じる手順で閉じる場面を、くり返す回数。修正の前の実験では、page を
 * 先に閉じる手順で 5 回中 5 回届いた。届く場面が毎回は起きない場合にも見逃しにくくするため、複数回くり返す。
 */
export const UNLOAD_BEACON_CLOSE_ROUNDS = 5;

/** `runGuardedUnloadBeaconRounds` の1回（Context と page を開き、fixture を読み込み、閉じる）の上限の見積もり（ms）。期限の値ではない。 */
const UNLOAD_BEACON_ROUND_BUDGET_MS = 5_000;

/**
 * `runGuardedUnloadBeaconRounds` を使うテストの期限（ms）。回ごとの上限の見積もりと待ち時間（`QUIET_PERIOD_MS`）と、最後の待ち時間
 * （`FROZEN_POPUP_LATE_DELIVERY_SETTLE_MS`）。
 */
export const UNLOAD_BEACON_ROUNDS_TEST_TIMEOUT_MS = UNLOAD_BEACON_CLOSE_ROUNDS * (UNLOAD_BEACON_ROUND_BUDGET_MS + QUIET_PERIOD_MS)
  + FROZEN_POPUP_LATE_DELIVERY_SETTLE_MS;

/** `runGuardedUnloadBeaconRounds` の1回の結果のうち、条件を満たさなかった回の内容。 */
export interface UnloadBeaconRoundFailure {
  readonly round: number;
  /** その回に、サーバに届いた POST /__mutation の件数。 */
  readonly delivered: number;
  readonly nonReadCounters: Readonly<Record<NonReadMethodCounterName, number>>;
  readonly invariantViolations: readonly unknown[];
  readonly closeFailures: readonly unknown[];
  readonly pageClosed: boolean;
  readonly guardClosed: boolean;
}

/** `runGuardedUnloadBeaconRounds` の結果。 */
export interface UnloadBeaconRounds {
  /** 条件（届かない、違反 0、閉じる処理の失敗 0、page と Guard が閉じた）を満たさなかった回（くり返しの順）。 */
  readonly failedRounds: readonly UnloadBeaconRoundFailure[];
  /** くり返しを始める前に付けた印からの、サーバの記録（全部の回の後に、`FROZEN_POPUP_LATE_DELIVERY_SETTLE_MS` 待った後）。 */
  readonly allRoundsWindow: ServerWindow;
}

/**
 * DEF-038（設計書 `2026-10-08-beaksight-def-038-passive-page-close-design.md` 4）: `factory` で Guard の付いた Passive の Context と
 * page を開き（製品と同じ作り方）、`UNLOAD_BEACON_PAGE` を読み込み、製品の閉じる手順（`closePassivePageAndContext`）で閉じる。
 * これを `UNLOAD_BEACON_CLOSE_ROUNDS` 回くり返し、条件を満たさなかった回をまとめて返す（失敗した回とその内容がすべて分かる）。
 * 全部の回の後に `FROZEN_POPUP_LATE_DELIVERY_SETTLE_MS` 待つ（Context を閉じた後に遅れて届く要求を見逃さないため）。
 */
export async function runGuardedUnloadBeaconRounds(
  factory: BrowserContextFactory,
  server: FixtureServer,
  viewport: Viewport,
): Promise<UnloadBeaconRounds> {
  const allRoundsWindow = openServerWindow(server);
  const failedRounds: UnloadBeaconRoundFailure[] = [];
  for (let round = 0; round < UNLOAD_BEACON_CLOSE_ROUNDS; round += 1) {
    const context = await factory.createPassiveContext(viewport);
    const page = await factory.createPassivePage(context);
    const ledger = factory.getSafetyLedger(context);
    await page.goto(`${server.origin}${UNLOAD_BEACON_PAGE}`, { waitUntil: 'load' });
    const window = openServerWindow(server);
    const closeFailures = await closePassivePageAndContext(factory, context);
    await wait(QUIET_PERIOD_MS);
    const summary: UnloadBeaconRoundFailure = {
      round,
      delivered: window.count(null, UNLOAD_BEACON_TARGET_PATH),
      nonReadCounters: window.nonReadCounters(),
      invariantViolations: ledger.snapshot().invariantViolations,
      closeFailures: closeFailures.map(({ step, error }) => ({ step, error: String(error) })),
      pageClosed: page.isClosed(),
      guardClosed: isPassiveRequestGuardClosed(context),
    };
    if (
      summary.delivered !== 0
      || Object.values(summary.nonReadCounters).some((count) => count !== 0)
      || summary.invariantViolations.length !== 0
      || summary.closeFailures.length !== 0
      || !summary.pageClosed
      || !summary.guardClosed
    ) {
      failedRounds.push(summary);
    }
  }
  await wait(FROZEN_POPUP_LATE_DELIVERY_SETTLE_MS);
  return { failedRounds, allRoundsWindow };
}

/**
 * DEF-038 の対照: Guard のない Context で `UNLOAD_BEACON_PAGE` を開き、page を `page.close()` で閉じると、POST /__mutation が
 * サーバに届く（fixture が意味を持つことの確かめ。DEF-010 の教訓）。届くまで待ち、印からのサーバの記録を返す。
 */
export async function closeUnguardedUnloadBeaconPage(
  browser: Browser,
  server: FixtureServer,
  viewport: Viewport,
): Promise<ServerWindow> {
  return withUnguardedPage(browser, viewport, async (page) => {
    await page.goto(`${server.origin}${UNLOAD_BEACON_PAGE}`, { waitUntil: 'load' });
    const window = openServerWindow(server);
    expect(window.count('POST', UNLOAD_BEACON_TARGET_PATH)).toBe(0);
    await page.close();
    await expect.poll(() => window.count('POST', UNLOAD_BEACON_TARGET_PATH)).toBeGreaterThan(0);
    return window;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// ページ自身が別の文書へ移るときの送信（DEF-042）
// ---------------------------------------------------------------------------------------------------------------

/**
 * DEF-042: ページを離れるとき（`pagehide`・`visibilitychange`）だけ POST /__mutation を送り、読み込みの後に自分で別の文書へ移る
 * fixture のページ（`fixtures/site/`）。移動の先は、`unloadBeaconSelfNavigationPath` のクエリ `to` で選ぶ。
 */
export const UNLOAD_BEACON_SELF_NAVIGATION_PAGE = '/unload-beacon-self-navigation.html';

/** DEF-042: `fetchLater()` で POST /__mutation を予約し、読み込みの後に自分で別の文書（同じ Origin）へ移る fixture のページ。 */
export const UNLOAD_BEACON_FETCH_LATER_PAGE = '/unload-beacon-fetch-later.html';

/**
 * `UNLOAD_BEACON_SELF_NAVIGATION_PAGE` の移動の先（fixture の固定の一覧の名前）。
 * - `same-site`: 同じ Origin の `/navigation-target.html`（Guard が許可する移動）。
 * - `cross-site`: 同じ fixture のサーバの別のホスト名（`127.0.0.1` と `localhost` の入れ替え）の `/navigation-target.html`。
 *   許可 Origin の外なので、Guard が main frame の移動を止める（DEF-042 の調査の実験 7）。
 */
export type UnloadBeaconSelfNavigationTarget = 'same-site' | 'cross-site';

/** `to` へ自分で移る、`UNLOAD_BEACON_SELF_NAVIGATION_PAGE` のパス（クエリを含む）。 */
export const unloadBeaconSelfNavigationPath = (to: UnloadBeaconSelfNavigationTarget): string =>
  `${UNLOAD_BEACON_SELF_NAVIGATION_PAGE}?to=${to}`;

/**
 * DEF-042: ページ自身の移動の場面を、くり返す回数。修正の前の調査では、どの Chromium でも毎回届いた（5/5、3/3）ので、少ない回数でも
 * 修正の前に失敗する。
 */
export const UNLOAD_BEACON_SELF_NAVIGATION_ROUNDS = 3;

/** `runGuardedSelfNavigationRounds` を使うテストの期限（ms）。考え方は `UNLOAD_BEACON_ROUNDS_TEST_TIMEOUT_MS` と同じ。 */
export const UNLOAD_BEACON_SELF_NAVIGATION_TEST_TIMEOUT_MS = UNLOAD_BEACON_SELF_NAVIGATION_ROUNDS
  * (UNLOAD_BEACON_ROUND_BUDGET_MS + QUIET_PERIOD_MS) + FROZEN_POPUP_LATE_DELIVERY_SETTLE_MS;

/** page の URL が `url` になったか（ページ自身の移動が終わったことの確かめ）。 */
export const pageUrlIs = (url: string) => (page: Page): boolean => page.url() === url;

/** `UNLOAD_BEACON_FETCH_LATER_PAGE` が html 要素に残す、`fetchLater()` の予約の状態（`scheduled`、`unavailable`。なければ `missing`）。 */
export const readFetchLaterState = (page: Page): Promise<string> =>
  page.evaluate(() => document.documentElement.dataset['fetchLater'] ?? 'missing');

/** Guard の付いた session（Passive の Context か、凍結の前の Interaction の session）の、ページ自身の移動の確かめに使う部分。 */
export interface SelfNavigationSession {
  readonly page: Page;
  readonly ledger: SafetyLedger;
  /** 製品の手順で閉じ、閉じる処理の失敗を返す。 */
  close(): Promise<readonly PassiveSessionCloseFailure[]>;
}

/** Guard の付いた Passive の Context と page を開く（製品と同じ作り方）。閉じるのは、製品の手順（`closePassivePageAndContext`）。 */
export async function openGuardedPassiveSession(factory: BrowserContextFactory, viewport: Viewport): Promise<SelfNavigationSession> {
  const context = await factory.createPassiveContext(viewport);
  const page = await factory.createPassivePage(context);
  return {
    page,
    ledger: factory.getSafetyLedger(context),
    close: () => closePassivePageAndContext(factory, context),
  };
}

/**
 * Interaction の session を、凍結の前の状態（候補のページの読み込みの段階）で開く。閉じるのは session の `close()`（その失敗は、
 * `context` の手順の失敗として返す）。
 */
export async function openInteractionSessionBeforeFreeze(
  factory: BrowserContextFactory,
  viewport: Viewport,
): Promise<SelfNavigationSession> {
  const session = await factory.createInteractionSession(viewport);
  return {
    page: session.page,
    ledger: session.ledger,
    close: async (): Promise<readonly PassiveSessionCloseFailure[]> => {
      try {
        await session.close();
        return [];
      } catch (error) {
        return [{ step: 'context', error }];
      }
    },
  };
}

/** `runGuardedSelfNavigationRounds` の1回の結果。 */
export interface SelfNavigationRound {
  readonly round: number;
  /** その回に、サーバに届いた /__mutation への要求の件数（メソッドを問わない）。 */
  readonly delivered: number;
  readonly nonReadCounters: Readonly<Record<NonReadMethodCounterName, number>>;
  readonly blockedRequests: readonly BlockedRequestEvent[];
  readonly blockedNavigations: readonly BlockedNavigationEvent[];
  readonly invariantViolations: readonly unknown[];
  readonly closeFailures: readonly unknown[];
  /** ページ自身の移動が終わった時点（閉じる前）の page の URL。 */
  readonly pageUrl: string;
}

/** `runGuardedSelfNavigationRounds` の結果。 */
export interface SelfNavigationRounds {
  /** すべての回（くり返しの順）。 */
  readonly rounds: readonly SelfNavigationRound[];
  /** 条件（届かない、`blockedRequests` に残る、違反 0、閉じる処理の失敗 0）を満たさなかった回（くり返しの順）。 */
  readonly failedRounds: readonly SelfNavigationRound[];
  /** くり返しを始める前に付けた印からの、サーバの記録（全部の回の後に、`FROZEN_POPUP_LATE_DELIVERY_SETTLE_MS` 待った後）。 */
  readonly allRoundsWindow: ServerWindow;
}

/** `runGuardedSelfNavigationRounds` の追加の指定。 */
export interface SelfNavigationRoundOptions {
  /** ページ自身の移動が終わった後（閉じる前）に行う観測。 */
  readonly inspect?: (page: Page, ledger: SafetyLedger) => Promise<void>;
}

/**
 * DEF-042（設計書 `2026-10-08-beaksight-def-042-guard-fetch-all-design.md` 4）: `open` で Guard の付いた session を開き、`path` を
 * 読み込み、ページ自身の移動が終わる（`settled` が真になる）まで待ち、`QUIET_PERIOD_MS` 待ってから製品の手順で閉じ、さらに
 * `QUIET_PERIOD_MS` 待つ。これを `UNLOAD_BEACON_SELF_NAVIGATION_ROUNDS` 回くり返し、全部の回の後に `FROZEN_POPUP_LATE_DELIVERY_SETTLE_MS`
 * 待つ。条件は、ページを離れるときの送信が /__mutation に届かない、GET・HEAD 以外が届かない、`blockedRequests` に少なくとも 1 件残る、
 * 違反 0、閉じる処理の失敗 0 である。
 */
export async function runGuardedSelfNavigationRounds(
  open: () => Promise<SelfNavigationSession>,
  server: FixtureServer,
  path: string,
  settled: (page: Page, ledger: SafetyLedger) => boolean | Promise<boolean>,
  options: SelfNavigationRoundOptions = {},
): Promise<SelfNavigationRounds> {
  const allRoundsWindow = openServerWindow(server);
  const rounds: SelfNavigationRound[] = [];
  const failedRounds: SelfNavigationRound[] = [];
  for (let round = 0; round < UNLOAD_BEACON_SELF_NAVIGATION_ROUNDS; round += 1) {
    const session = await open();
    const window = openServerWindow(server);
    await session.page.goto(`${server.origin}${path}`, { waitUntil: 'load' });
    await expect.poll(() => settled(session.page, session.ledger)).toBe(true);
    await wait(QUIET_PERIOD_MS);
    const pageUrl = session.page.url();
    await options.inspect?.(session.page, session.ledger);
    const closeFailures = await session.close();
    await wait(QUIET_PERIOD_MS);
    const snapshot = session.ledger.snapshot();
    const summary: SelfNavigationRound = {
      round,
      delivered: window.count(null, UNLOAD_BEACON_TARGET_PATH),
      nonReadCounters: window.nonReadCounters(),
      blockedRequests: snapshot.blockedRequests,
      blockedNavigations: snapshot.blockedNavigations,
      invariantViolations: snapshot.invariantViolations,
      closeFailures: closeFailures.map(({ step, error }) => ({ step, error: String(error) })),
      pageUrl,
    };
    rounds.push(summary);
    if (
      summary.delivered !== 0
      || Object.values(summary.nonReadCounters).some((count) => count !== 0)
      || summary.blockedRequests.length === 0
      || summary.invariantViolations.length !== 0
      || summary.closeFailures.length !== 0
    ) {
      failedRounds.push(summary);
    }
  }
  await wait(FROZEN_POPUP_LATE_DELIVERY_SETTLE_MS);
  return { rounds, failedRounds, allRoundsWindow };
}

/** `leaveUnguardedUnloadBeaconPage` の追加の指定。 */
export interface UnguardedLeaveOptions {
  /** 文書の DOM ができた直後（ページ自身の移動の前）に行う観測（例: `fetchLater()` の予約の状態）。 */
  readonly afterDomContentLoaded?: (page: Page) => Promise<void>;
}

/**
 * DEF-042 の対照: Guard のない Context で `path` を開き、ページ自身の移動が終わる（`settled` が真になる）まで待つと、ページを離れるときの
 * POST /__mutation がサーバに届く（fixture が意味を持つことの確かめ。DEF-010 の教訓）。届くまで待ち、印からのサーバの記録を返す。
 * 読み込みは DOM ができた時点まで待つ（fixture のスクリプトは DOM ができる前に動き、移動は `load` の後に始まる）。
 */
export async function leaveUnguardedUnloadBeaconPage(
  browser: Browser,
  server: FixtureServer,
  viewport: Viewport,
  path: string,
  settled: (page: Page) => boolean | Promise<boolean>,
  options: UnguardedLeaveOptions = {},
): Promise<ServerWindow> {
  return withUnguardedPage(browser, viewport, async (page) => {
    const window = openServerWindow(server);
    await page.goto(`${server.origin}${path}`, { waitUntil: 'domcontentloaded' });
    await options.afterDomContentLoaded?.(page);
    expect(window.count('POST', UNLOAD_BEACON_TARGET_PATH)).toBe(0);
    await expect.poll(() => settled(page)).toBe(true);
    await expect.poll(() => window.count('POST', UNLOAD_BEACON_TARGET_PATH)).toBeGreaterThan(0);
    return window;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Worker の中の WebSocket（DEF-040。NP3）
// ---------------------------------------------------------------------------------------------------------------

/**
 * DEF-040（NP3）: 読み込みのとき（クリックなし）に Worker を作り、その中で同じサーバの `/socket` へ WebSocket の接続を開く fixture の
 * ページ（`fixtures/site/`）。Worker の種類は、クエリ `kind`（`WORKER_WEBSOCKET_KINDS`）で選ぶ。
 */
export const WORKER_WEBSOCKET_PASSIVE_PAGE = '/worker-websocket-passive.html';

/** `WORKER_WEBSOCKET_PASSIVE_PAGE` が読む、http の script の Worker の script のパス（Dedicated、Shared で共用。module は import で読む）。 */
export const WORKER_WEBSOCKET_CONNECT_SCRIPT_PATH = '/worker-websocket-connect.js';
export const WORKER_WEBSOCKET_CONNECT_MODULE_PATH = '/worker-websocket-connect-module.js';
export const WORKER_WEBSOCKET_NESTED_SCRIPT_PATH = '/worker-websocket-nested.js';

/**
 * `WORKER_WEBSOCKET_PASSIVE_PAGE` の Worker の種類（fixture のクエリ `kind` の値）。
 * - `blob`: blob の script の Dedicated Worker。`http`: http の script の Dedicated Worker。`shared`: http の script の Shared Worker。
 * - `module`: module の Worker（接続を開く script を import で読む）。`nested`: http の script の Worker が作る blob の入れ子の Worker。
 * - `srcdoc`: srcdoc の iframe の中の script が作る blob の Worker。
 */
export const WORKER_WEBSOCKET_KINDS = Object.freeze(['blob', 'http', 'shared', 'module', 'nested', 'srcdoc'] as const);
export type WorkerWebSocketKind = (typeof WORKER_WEBSOCKET_KINDS)[number];

/**
 * Guard の記録（Guard の page の session の `Log.entryAdded` の観察。DEF-039・DEF-040 の設計書 2.2）が残るはずの種類。Dedicated の Worker
 * （入れ子、srcdoc の iframe の中を含む）は残る。Shared Worker の違反は page の session に出ないので、記録は求めない。
 */
export const RECORDED_WORKER_WEBSOCKET_KINDS: readonly WorkerWebSocketKind[] = Object.freeze(
  WORKER_WEBSOCKET_KINDS.filter((kind) => kind !== 'shared'),
);

/**
 * DEF-044（設計書 `2026-10-08-beaksight-def-044-046-review-fixes-design.md` 1.2）: Worker を作れない種類。テストの Chromium（既定）と
 * CLI の Chromium は、Shared Worker を無効にする引数（`CHROMIUM_SHARED_WORKERS_DISABLED_ARGS`）で起動するので、`shared` の場面は
 * Shared Worker を作れず（`typeof SharedWorker === 'undefined'`）、fixture は `unavailable` を残す。接続は起きない。
 */
export const UNAVAILABLE_WORKER_WEBSOCKET_KINDS: readonly WorkerWebSocketKind[] = Object.freeze(['shared']);

/** `kind` の場面で、fixture が残すはずの Worker を始めた結果（作れない種類は `unavailable`、ほかは `started`）。 */
export const expectedWorkerWebSocketState = (kind: WorkerWebSocketKind): string => (
  UNAVAILABLE_WORKER_WEBSOCKET_KINDS.includes(kind) ? 'unavailable' : 'started'
);

/** `kind` の Worker で WebSocket を開く、`WORKER_WEBSOCKET_PASSIVE_PAGE` のパス（クエリを含む）。 */
export const workerWebSocketPassivePath = (kind: WorkerWebSocketKind): string => `${WORKER_WEBSOCKET_PASSIVE_PAGE}?kind=${kind}`;

/**
 * `kind` の場面で、ページの GET のほかにサーバに届くはずの、Worker の script の GET（記録の順）。Guard は Worker の script を止めない
 * （script の応答に CSP のヘッダを加えるだけ）ので、Guard の有無で変わらない。Worker を作れない種類（`shared`。DEF-044）は、script を
 * 読まないので、ない。
 */
export function workerWebSocketScriptRequestLines(kind: WorkerWebSocketKind): readonly string[] {
  switch (kind) {
    case 'http':
      return [`GET ${WORKER_WEBSOCKET_CONNECT_SCRIPT_PATH}`];
    case 'shared':
      return [];
    case 'module':
      return [`GET ${WORKER_WEBSOCKET_CONNECT_MODULE_PATH}`, `GET ${WORKER_WEBSOCKET_CONNECT_SCRIPT_PATH}`];
    case 'nested':
      return [`GET ${WORKER_WEBSOCKET_NESTED_SCRIPT_PATH}`];
    case 'blob':
    case 'srcdoc':
      return [];
  }
}

/**
 * `WORKER_WEBSOCKET_PASSIVE_PAGE` が html 要素に残す、Worker を始めた結果（`started`、`unavailable`（Shared Worker がない。DEF-044）、
 * `failed`、`unknown-kind`。なければ `missing`）。
 */
export const readWorkerWebSocketState = (page: Page): Promise<string> =>
  page.evaluate(() => document.documentElement.dataset['workerWebsocket'] ?? 'missing');

/**
 * DEF-040（NP3）: Worker の中の WebSocket の場面を、くり返す回数。NP2 の調査では、修正の前はどの Chromium でも毎回届いた
 * （36/36、24/28 の漏れはすべて SVG の文書）ので、ページ自身の移動の場面（DEF-042）と同じ回数で、修正の前に失敗する。
 */
export const WORKER_WEBSOCKET_ROUNDS = UNLOAD_BEACON_SELF_NAVIGATION_ROUNDS;

/** `runGuardedWorkerWebSocketRounds` を使うテストの期限（ms）。考え方は `UNLOAD_BEACON_ROUNDS_TEST_TIMEOUT_MS` と同じ。 */
export const WORKER_WEBSOCKET_TEST_TIMEOUT_MS = WORKER_WEBSOCKET_ROUNDS
  * (UNLOAD_BEACON_ROUND_BUDGET_MS + QUIET_PERIOD_MS) + FROZEN_POPUP_LATE_DELIVERY_SETTLE_MS;

/** `runGuardedWorkerWebSocketRounds` の1回の結果。 */
export interface WorkerWebSocketRound {
  readonly round: number;
  /** その回に、サーバに届いた WebSocket の Upgrade の件数。 */
  readonly upgrades: number;
  /** その回にサーバに届いた要求（ブラウザ自身のアイコンの要求を除く）。 */
  readonly requestLines: readonly string[];
  readonly blockedWebSockets: readonly BlockedWebSocketEvent[];
  readonly invariantViolations: readonly unknown[];
  readonly closeFailures: readonly unknown[];
  /** 閉じる前の、fixture が残した Worker を始めた結果。 */
  readonly workerState: string;
}

/** `runGuardedWorkerWebSocketRounds` の結果。 */
export interface WorkerWebSocketRounds {
  readonly rounds: readonly WorkerWebSocketRound[];
  /** 条件（届かない、記録が残る（求める種類だけ）、違反 0、閉じる処理の失敗 0）を満たさなかった回（くり返しの順）。 */
  readonly failedRounds: readonly WorkerWebSocketRound[];
  /** くり返しを始める前に付けた印からの、サーバの記録（全部の回の後に、`FROZEN_POPUP_LATE_DELIVERY_SETTLE_MS` 待った後）。 */
  readonly allRoundsWindow: ServerWindow;
}

/** `runGuardedWorkerWebSocketRounds` の追加の指定。 */
export interface WorkerWebSocketRoundOptions {
  /** Worker を始めた後（閉じる前）に行う観測。 */
  readonly inspect?: (page: Page, ledger: SafetyLedger) => Promise<void>;
}

/**
 * DEF-040（DEF-039・DEF-040 の設計書 2.2）: `open` で Guard の付いた session（Passive の Context か、凍結の前の Interaction の session）を
 * 開き、`kind` の Worker で WebSocket を開く fixture を読み込み、Worker を始めたこと（作れない種類は、作れなかったこと。
 * `expectedWorkerWebSocketState`）と、記録が残るはずの種類（`RECORDED_WORKER_WEBSOCKET_KINDS`）
 * では `blockedWebSockets` に記録が残ったことを待ち、`QUIET_PERIOD_MS` 待ってから製品の手順で閉じ、さらに `QUIET_PERIOD_MS` 待つ。
 * これを `WORKER_WEBSOCKET_ROUNDS` 回くり返し、全部の回の後に `FROZEN_POPUP_LATE_DELIVERY_SETTLE_MS` 待つ。
 * 条件は、WebSocket の Upgrade がサーバに届かない、記録が残るはずの種類では記録が 1 件以上ある、違反 0、閉じる処理の失敗 0 である。
 */
export async function runGuardedWorkerWebSocketRounds(
  open: () => Promise<SelfNavigationSession>,
  server: FixtureServer,
  kind: WorkerWebSocketKind,
  options: WorkerWebSocketRoundOptions = {},
): Promise<WorkerWebSocketRounds> {
  const expectsRecord = RECORDED_WORKER_WEBSOCKET_KINDS.includes(kind);
  const allRoundsWindow = openServerWindow(server);
  const rounds: WorkerWebSocketRound[] = [];
  const failedRounds: WorkerWebSocketRound[] = [];
  for (let round = 0; round < WORKER_WEBSOCKET_ROUNDS; round += 1) {
    const session = await open();
    const window = openServerWindow(server);
    await session.page.goto(`${server.origin}${workerWebSocketPassivePath(kind)}`, { waitUntil: 'load' });
    await expect.poll(() => readWorkerWebSocketState(session.page)).toBe(expectedWorkerWebSocketState(kind));
    if (expectsRecord) {
      // 記録は、Worker の中の違反を Guard の page の session が受けてから残る（非同期）。届かないことの確かめと同じ余裕で待つ。
      await expect.poll(
        () => session.ledger.snapshot().blockedWebSockets.length,
        { timeout: FROZEN_POPUP_LATE_DELIVERY_SETTLE_MS },
      ).toBeGreaterThan(0);
    }
    await wait(QUIET_PERIOD_MS);
    const workerState = await readWorkerWebSocketState(session.page);
    await options.inspect?.(session.page, session.ledger);
    const closeFailures = await session.close();
    await wait(QUIET_PERIOD_MS);
    const snapshot = session.ledger.snapshot();
    const summary: WorkerWebSocketRound = {
      round,
      upgrades: window.counters().webSocketUpgrade,
      requestLines: window.requestLines().filter((line) => line !== `GET ${BROWSER_DEFAULT_FAVICON_PATH}`),
      blockedWebSockets: snapshot.blockedWebSockets,
      invariantViolations: snapshot.invariantViolations,
      closeFailures: closeFailures.map(({ step, error }) => ({ step, error: String(error) })),
      workerState,
    };
    rounds.push(summary);
    if (
      summary.upgrades !== 0
      || (expectsRecord && summary.blockedWebSockets.length === 0)
      || summary.invariantViolations.length !== 0
      || summary.closeFailures.length !== 0
    ) {
      failedRounds.push(summary);
    }
  }
  await wait(FROZEN_POPUP_LATE_DELIVERY_SETTLE_MS);
  return { rounds, failedRounds, allRoundsWindow };
}

/**
 * DEF-040 の対照: Guard のない Context で `kind` の Worker の fixture を開くと、WebSocket の Upgrade がサーバに届く（fixture が意味を持つことの
 * 確かめ。DEF-010 の教訓）。届くまで待ち、印からのサーバの記録を返す。
 * Worker を作れない種類（`UNAVAILABLE_WORKER_WEBSOCKET_KINDS`。DEF-044）は、fixture が `unavailable` を残したことを待ち、さらに
 * `QUIET_PERIOD_MS` 待ってから、印からのサーバの記録を返す（Upgrade は届かないはず。確かめは呼び出し側）。
 */
export async function openUnguardedWorkerWebSocketPage(
  browser: Browser,
  server: FixtureServer,
  viewport: Viewport,
  kind: WorkerWebSocketKind,
): Promise<ServerWindow> {
  return withUnguardedPage(browser, viewport, async (page) => {
    const window = openServerWindow(server);
    await page.goto(`${server.origin}${workerWebSocketPassivePath(kind)}`, { waitUntil: 'load' });
    await expect.poll(() => readWorkerWebSocketState(page)).toBe(expectedWorkerWebSocketState(kind));
    if (UNAVAILABLE_WORKER_WEBSOCKET_KINDS.includes(kind)) {
      await wait(QUIET_PERIOD_MS);
    } else {
      await expect.poll(() => window.counters().webSocketUpgrade).toBeGreaterThan(0);
    }
    return window;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Shared Worker の中の POST（DEF-044。NP5）
// ---------------------------------------------------------------------------------------------------------------

/**
 * DEF-044: 読み込みのとき（クリックなし）に blob の script の Shared Worker を作り、その中から `/__mutation` へ POST を送る fixture の
 * ページ（`fixtures/site/`）。POST の種類は、クエリ `kind`（`SHARED_WORKER_POST_KINDS`）で選ぶ。
 */
export const SHARED_WORKER_POSTS_PAGE = '/shared-worker-posts.html';

/** `SHARED_WORKER_POSTS_PAGE` の POST の種類（`fetch` の POST、XHR の POST、keepalive の `fetch` の POST）。 */
export const SHARED_WORKER_POST_KINDS = Object.freeze(['fetch', 'xhr', 'keepalive'] as const);
export type SharedWorkerPostKind = (typeof SHARED_WORKER_POST_KINDS)[number];

/** `kind` の POST を送る、`SHARED_WORKER_POSTS_PAGE` のパス（クエリを含む）。 */
export const sharedWorkerPostsPath = (kind: SharedWorkerPostKind): string => `${SHARED_WORKER_POSTS_PAGE}?kind=${kind}`;

/** `SHARED_WORKER_POSTS_PAGE` が html 要素に残す値（なければ `missing`）。 */
export interface SharedWorkerFixtureState {
  /** `typeof SharedWorker` の値。 */
  readonly type: string;
  /** 始めた結果（`started`、`unavailable`、`failed`、`unknown-kind`）。 */
  readonly state: string;
}

/** Shared Worker を無効にした Chromium で、`SHARED_WORKER_POSTS_PAGE` が残すはずの値。 */
export const SHARED_WORKER_DISABLED_FIXTURE_STATE: SharedWorkerFixtureState = Object.freeze({ type: 'undefined', state: 'unavailable' });

/** `SHARED_WORKER_POSTS_PAGE` が html 要素に残した値を読む。 */
export const readSharedWorkerFixtureState = (page: Page): Promise<SharedWorkerFixtureState> => page.evaluate(() => ({
  type: document.documentElement.dataset['sharedWorkerType'] ?? 'missing',
  state: document.documentElement.dataset['sharedWorker'] ?? 'missing',
}));

/** `openGuardedSharedWorkerPostsPage` の結果。 */
export interface SharedWorkerPostsOutcome {
  /** 閉じる前の、fixture が残した値。 */
  readonly fixtureState: SharedWorkerFixtureState;
  /** 印からのサーバの記録（閉じた後に `QUIET_PERIOD_MS` 待った後）。 */
  readonly window: ServerWindow;
  readonly invariantViolations: readonly unknown[];
  readonly closeFailures: readonly unknown[];
}

/**
 * DEF-044: `open` で Guard の付いた session（Passive の Context か、凍結の前の Interaction の session）を開き、`kind` の
 * `SHARED_WORKER_POSTS_PAGE` を読み込む。fixture が値を残したことを待ち、Shared Worker の POST が届くのに足りる時間
 * （`FROZEN_POPUP_LATE_DELIVERY_SETTLE_MS`）待ってから、製品の手順で閉じ、さらに `QUIET_PERIOD_MS` 待つ。
 */
export async function openGuardedSharedWorkerPostsPage(
  open: () => Promise<SelfNavigationSession>,
  server: FixtureServer,
  kind: SharedWorkerPostKind,
): Promise<SharedWorkerPostsOutcome> {
  const session = await open();
  const window = openServerWindow(server);
  let fixtureState: SharedWorkerFixtureState | undefined;
  let closeFailures: readonly PassiveSessionCloseFailure[] = [];
  try {
    await session.page.goto(`${server.origin}${sharedWorkerPostsPath(kind)}`, { waitUntil: 'load' });
    await expect.poll(async () => (await readSharedWorkerFixtureState(session.page)).state).not.toBe('missing');
    await wait(FROZEN_POPUP_LATE_DELIVERY_SETTLE_MS);
    fixtureState = await readSharedWorkerFixtureState(session.page);
  } finally {
    closeFailures = await session.close();
  }
  await wait(QUIET_PERIOD_MS);
  return {
    fixtureState,
    window,
    invariantViolations: session.ledger.snapshot().invariantViolations,
    closeFailures: closeFailures.map(({ step, error }) => ({ step, error: String(error) })),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Service Worker の登録の迂回（DEF-049。NP6）
// ---------------------------------------------------------------------------------------------------------------

/**
 * DEF-049: 読み込みのときに、Playwright の `serviceWorkers: 'block'` の置き換えを迂回して Service Worker を登録する fixture のページ
 * （`fixtures/site/`）と、その Service Worker の script（install と activate で /__mutation へ POST を送る）。
 */
export const SERVICE_WORKER_BYPASS_PAGE = '/service-worker-bypass.html';
export const SERVICE_WORKER_BYPASS_WORKER_PATH = '/service-worker-bypass-worker.js';
/** `SERVICE_WORKER_BYPASS_PAGE` の iframe（`where=iframe`）が読み込む、同じ Origin の文書。 */
export const SERVICE_WORKER_BYPASS_IFRAME_PATH = '/navigation-target.html';

/** 迂回の方法（`ServiceWorkerContainer.prototype.register.call`、インスタンスの `register` を `delete` した後の呼び出し）。 */
export const SERVICE_WORKER_BYPASS_WAYS = Object.freeze(['prototype', 'delete'] as const);
export type ServiceWorkerBypassWay = (typeof SERVICE_WORKER_BYPASS_WAYS)[number];
/** 呼び出す場所（ページの文書、同じ Origin の iframe、動的に作った about:blank の iframe）。 */
export const SERVICE_WORKER_BYPASS_FRAMES = Object.freeze(['top', 'iframe', 'blank'] as const);
export type ServiceWorkerBypassFrame = (typeof SERVICE_WORKER_BYPASS_FRAMES)[number];

/** `way` と `where` の `SERVICE_WORKER_BYPASS_PAGE` のパス（クエリを含む）。 */
export const serviceWorkerBypassPath = (way: ServiceWorkerBypassWay, where: ServiceWorkerBypassFrame): string =>
  `${SERVICE_WORKER_BYPASS_PAGE}?way=${way}&where=${where}`;

/** `SERVICE_WORKER_BYPASS_PAGE` に Guard の付いた page でサーバに届くはずの要求の一覧（`where=iframe` だけ、iframe の文書の GET）。 */
export const serviceWorkerBypassRequestLines = (where: ServiceWorkerBypassFrame): readonly string[] => [
  `GET ${SERVICE_WORKER_BYPASS_PAGE}`,
  ...(where === 'iframe' ? [`GET ${SERVICE_WORKER_BYPASS_IFRAME_PATH}`] : []),
];

/** `SERVICE_WORKER_BYPASS_PAGE` が html 要素に残した結果を読む（まだなければ `missing`）。 */
export const readServiceWorkerBypassState = (page: Page): Promise<string> =>
  page.evaluate(() => document.documentElement.dataset['serviceWorkerBypass'] ?? 'missing');

/** page の Origin の Service Worker の登録の数（`navigator.serviceWorker` がなければ 0）。 */
export const readServiceWorkerRegistrationCount = (page: Page): Promise<number> => page.evaluate(async () => (
  navigator.serviceWorker === undefined ? 0 : (await navigator.serviceWorker.getRegistrations()).length
));

/** `openGuardedServiceWorkerBypassPage` の結果。 */
export interface ServiceWorkerBypassOutcome {
  /** 閉じる前の、fixture が残した結果。 */
  readonly state: string;
  /** 閉じる前の、Service Worker の登録の数。 */
  readonly registrations: number;
  /** 印からのサーバの記録（閉じた後に `QUIET_PERIOD_MS` 待った後）。 */
  readonly window: ServerWindow;
  readonly invariantViolations: readonly unknown[];
  readonly closeFailures: readonly unknown[];
}

/**
 * DEF-049: `open` で Guard の付いた session（Passive の Context か、凍結の前の Interaction の session）を開き、`way` と `where` の
 * `SERVICE_WORKER_BYPASS_PAGE` を読み込む。fixture が結果を残したことを待ち、Service Worker の POST が届くのに足りる時間
 * （`FROZEN_POPUP_LATE_DELIVERY_SETTLE_MS`）待ってから、登録の数を読み、製品の手順で閉じ、さらに `QUIET_PERIOD_MS` 待つ。
 */
export async function openGuardedServiceWorkerBypassPage(
  open: () => Promise<SelfNavigationSession>,
  server: FixtureServer,
  way: ServiceWorkerBypassWay,
  where: ServiceWorkerBypassFrame,
): Promise<ServiceWorkerBypassOutcome> {
  const session = await open();
  const window = openServerWindow(server);
  let state = 'missing';
  let registrations = -1;
  let closeFailures: readonly PassiveSessionCloseFailure[] = [];
  try {
    await session.page.goto(`${server.origin}${serviceWorkerBypassPath(way, where)}`, { waitUntil: 'load' });
    await expect.poll(() => readServiceWorkerBypassState(session.page)).not.toBe('missing');
    await wait(FROZEN_POPUP_LATE_DELIVERY_SETTLE_MS);
    state = await readServiceWorkerBypassState(session.page);
    registrations = await readServiceWorkerRegistrationCount(session.page);
  } finally {
    closeFailures = await session.close();
  }
  await wait(QUIET_PERIOD_MS);
  return {
    state,
    registrations,
    window,
    invariantViolations: session.ledger.snapshot().invariantViolations,
    closeFailures: closeFailures.map(({ step, error }) => ({ step, error: String(error) })),
  };
}

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
 * 終わったら（`run` や確かめが失敗しても）、`closePassiveResources` で Context を閉じる（page は Context と一緒に閉じる。DEF-038）。
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
// Gate の factory
// ---------------------------------------------------------------------------------------------------------------

/**
 * `browser`（headless で起動したもの）で、Gate と Guard の統合テストの factory を作る。設定は `createTestConfig(origin)`（headless）。
 * Safety Ledger は、Context ごとに新しく作る。出口の中継の上流の方針は、loopback だけ（`TEST_FACTORY_OPTIONS`）。
 * Guard は headed かどうかを受け取らない（中断した Run の再開の設計書 4.10。R7d）ので、headed の設定を注入した factory は作らない。
 */
export function createGateFactory(browser: Browser, origin: string): BrowserContextFactory {
  return new BrowserContextFactory(browser, createTestConfig(origin), () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
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
