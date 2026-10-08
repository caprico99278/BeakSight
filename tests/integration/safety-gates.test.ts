// T18b: Safety の Gate（GATE-S01〜S10。Task 18 の設計書 4.2、実装タスク指示 第11章）。
// どの Gate も、fixture のサーバの側で「届かなかった」ことを数えて確かめる（`openServerWindow` の差分。Ledger の記録は補助の確認）。
// 各 Gate には、対照の確認（Guard のない Context では、同じ操作がサーバに届くこと）を置き、確認が空振りしないことを示す。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { chromiumLaunchOptions } from '../../src/browser/chromium-launch.js';
import { BrowserContextFactory, type InteractionGuardedSession } from '../../src/browser/context-factory.js';
import { EXIT_CODES, exitCodeForRunStatus } from '../../src/cli/exit-codes.js';
import type { AuditConfig, Viewport } from '../../src/config/types.js';
import { RUN_ARTIFACT_FILE_NAMES, bundleFileName } from '../../src/core/artifact-layout.js';
import type { AuditRunResult } from '../../src/core/contracts.js';
import { wait } from '../../src/core/deadline.js';
import { REDACTED } from '../../src/core/redaction.js';
import {
  auditInteraction,
  InteractionOwnerCleanupError,
  type InteractionAuditResult,
} from '../../src/interaction/isolated-auditor.js';
import { isPassiveRequestGuardClosed, SERVICE_WORKER_REGISTRATION_BLOCKED_MESSAGE } from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { browserOpeningPageAfterNewContext } from '../helpers/browser-opening-page.js';
import { browserFailingNewContext, browserStallingContextClose } from '../helpers/browser-proxies.js';
import {
  BROWSER_DEFAULT_FAVICON_PATH,
  launchHeadlessChromium,
  oopifTargetUrls,
  SITE_PER_PROCESS_ARGS,
  useHeadlessChromium,
} from '../helpers/chromium.js';
import {
  CROSS_SITE_FRAME_PAGE,
  crossSiteFramePath,
  crossSiteOriginOf,
  EXTERNAL_SCHEME_BUTTON_NAME,
  EXTERNAL_SCHEME_BUTTON_PAGE,
  EXTERNAL_SCHEME_KEYS,
  EXTERNAL_SCHEME_NAVIGATION_PAGE,
  EXTERNAL_SCHEME_REDIRECT_FRAME_PAGE,
  EXTERNAL_SCHEME_REDIRECT_PATH,
  EXTERNAL_SCHEME_ROUTES,
  EXTERNAL_SCHEME_TARGETS,
  externalSchemeAttemptRecord,
  externalSchemeFixturePath,
  externalSchemeFixturePathname,
  externalSchemeRedirectFramePath,
  externalSchemeRedirectPath,
  externalSchemeTargetFrameUrls,
  NAVIGATION_TARGET_PAGE,
  safetyExternalSchemeNavigations,
  SELF_NAVIGATING_FRAME_PAGE,
  selfNavigatingFramePath,
  stoppedRedirectRecord,
  type ExternalSchemeKey,
} from '../helpers/external-scheme-fixture.js';
import {
  closeUnguardedUnloadBeaconPage,
  createGateFactory,
  discoverInteractionCandidate,
  expectedWorkerWebSocketState,
  FROZEN_POPUP_LATE_DELIVERY_SETTLE_MS,
  GATE_INTERACTION_TIMING,
  interactionAuditInput,
  leaveUnguardedUnloadBeaconPage,
  NO_NON_READ_REQUESTS,
  openGuardedPassiveSession,
  openGuardedServiceWorkerBypassPage,
  openGuardedSharedWorkerPostsPage,
  openInteractionSessionBeforeFreeze,
  openServerWindow,
  openUnguardedWorkerWebSocketPage,
  pageUrlIs,
  QUIET_PERIOD_MS,
  readWorkerWebSocketState,
  RECORDED_WORKER_WEBSOCKET_KINDS,
  runGuardedSelfNavigationRounds,
  SERVICE_WORKER_BYPASS_FRAMES,
  SERVICE_WORKER_BYPASS_WAYS,
  SERVICE_WORKER_BYPASS_WORKER_PATH,
  serviceWorkerBypassRequestLines,
  runGuardedUnloadBeaconRounds,
  SHARED_WORKER_DISABLED_FIXTURE_STATE,
  SHARED_WORKER_POST_KINDS,
  UNAVAILABLE_WORKER_WEBSOCKET_KINDS,
  UNLOAD_BEACON_ROUNDS_TEST_TIMEOUT_MS,
  UNLOAD_BEACON_SELF_NAVIGATION_TEST_TIMEOUT_MS,
  UNLOAD_BEACON_TARGET_PATH,
  unloadBeaconSelfNavigationPath,
  withGuardedPassivePage,
  withUnguardedPage,
  WORKER_WEBSOCKET_KINDS,
  WORKER_WEBSOCKET_PASSIVE_PAGE,
  workerWebSocketPassivePath,
  workerWebSocketScriptRequestLines,
  type ServerWindow,
} from '../helpers/gate-harness.js';
import {
  cliTargetConfig,
  createRunLauncher,
  expectOnlyReadRequests,
  fastRunConfig,
  findTextOccurrences,
  isPageJsonArtifact,
  readRunArtifactFiles,
  runCliInProcess,
  runWithCoordinator,
  writtenPageResults,
  type CliRunOutcome,
  type RunLauncher,
} from '../helpers/run-harness.js';
import { createTestConfig, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

const viewport: Viewport = Object.freeze({ width: 900, height: 700 });
/** 実際の Run（Run Coordinator と CLI）のテストの上限。 */
const RUN_TEST_TIMEOUT_MS = 120_000;
/** 凍結を待つ上限として注入する、短い期限（ms。製品の既定 `CONTEXT_CLOSE_TIMEOUT_MS` を待たない）。 */
const SHORT_FREEZE_TIMEOUT_MS = 300;

/**
 * S04（DEF-036）: 凍結中のポップアップの中のフォームの POST を確かめる Gate で、同じ監査をくり返す回数。届く場面は毎回は
 * 起きない（修正の前の調査で 40 回中 37 回）ので複数回くり返す。網羅のくり返し（10 回）は `isolated-interaction.test.ts` の
 * DEF-036 のテストが受け持ち、Gate では所要時間を抑えるため回数を減らす。
 */
const S04_POPUP_FORM_POST_AUDIT_ROUNDS = 5;
/**
 * S04（DEF-036）のくり返しの Gate のテストの期限（ms）。回ごとに、候補の探索の読み込み（`GATE_INTERACTION_TIMING.navigationTimeoutMs`）、
 * 1回の監査の期限（`GATE_INTERACTION_TIMING.overallMs`）、待ち時間（`QUIET_PERIOD_MS`）の分と、最後の待ち時間。
 */
const S04_POPUP_FORM_POST_TEST_TIMEOUT_MS = S04_POPUP_FORM_POST_AUDIT_ROUNDS
  * (GATE_INTERACTION_TIMING.navigationTimeoutMs + GATE_INTERACTION_TIMING.overallMs + QUIET_PERIOD_MS)
  + FROZEN_POPUP_LATE_DELIVERY_SETTLE_MS;
/**
 * S04（DEF-039）: 凍結中にページ自身が開いて閉じるポップアップの、ページを離れるときの送信（`pagehide` の beacon と keepalive の
 * POST）を確かめる Gate で、同じ監査をくり返す回数。修正の前の調査では毎回届いた（5/5、8/8）ので、少ない回数でも修正の前には
 * 失敗する。3 つの場面のくり返しは `isolated-interaction.test.ts` の DEF-039 のテストが受け持ち、Gate では同じ処理の中で閉じる
 * 場面だけを、所要時間を抑えた回数で確かめる。
 */
const S04_POPUP_SELF_CLOSE_AUDIT_ROUNDS = 3;
/** S04（DEF-039）のくり返しの Gate のテストの期限（ms）。考え方は `S04_POPUP_FORM_POST_TEST_TIMEOUT_MS` と同じ。 */
const S04_POPUP_SELF_CLOSE_TEST_TIMEOUT_MS = S04_POPUP_SELF_CLOSE_AUDIT_ROUNDS
  * (GATE_INTERACTION_TIMING.navigationTimeoutMs + GATE_INTERACTION_TIMING.overallMs + QUIET_PERIOD_MS)
  + FROZEN_POPUP_LATE_DELIVERY_SETTLE_MS;
/** DEF-039: ページ自身が開いて閉じるポップアップの fixture（`fixtures/site/`）と、同じ処理の中で閉じる場面のボタンの名前。 */
const POPUP_SELF_CLOSE_BEACON_PAGE = '/popup-self-close-beacon.html';
const POPUP_SELF_CLOSE_SAME_TASK_BUTTON = 'Close popup in the same task';
/** DEF-040: Worker の中で WebSocket の接続を開く fixture（`fixtures/site/`）と、そのボタンの名前。 */
const WORKER_WEBSOCKET_PAGE = '/worker-websocket.html';
const WORKER_WEBSOCKET_BUTTON = 'Open WebSocket in worker';

/** page の中の click を数えるスクリプト（S03）。 */
const COUNT_CLICKS_SCRIPT = `globalThis.__gateClicks = 0;
document.addEventListener('click', () => { globalThis.__gateClicks += 1; }, { capture: true });`;
/**
 * 対照の確認で使う、click を数えて既定の動作を止めるスクリプト（S03）。Guard のない Context で `mailto:` や `tel:` を実際に開くと、
 * 端末の外部のアプリが起動しうるので、対照の確認では既定の動作を止める。
 */
const COUNT_CLICKS_PREVENTING_DEFAULT_SCRIPT = `globalThis.__gateClicks = 0;
document.addEventListener('click', (event) => { globalThis.__gateClicks += 1; event.preventDefault(); }, { capture: true });`;

/**
 * page の中の `navigator.serviceWorker.register` の呼び出しを数えるスクリプト（S08。R18 の M2）。
 * 呼び出しは、元の関数（Context の `serviceWorkers: 'block'` による置き換えを含む）にそのまま渡す。
 */
const COUNT_SERVICE_WORKER_REGISTER_CALLS_SCRIPT = `globalThis.__gateServiceWorkerRegisterCalls = 0;
if (globalThis.navigator.serviceWorker !== undefined) {
  const container = globalThis.navigator.serviceWorker;
  const register = container.register;
  container.register = function (...args) {
    globalThis.__gateServiceWorkerRegisterCalls += 1;
    return register.apply(this, args);
  };
}`;

/** `COUNT_SERVICE_WORKER_REGISTER_CALLS_SCRIPT` が数えた回数（スクリプトが働いていなければ -1）。 */
const readServiceWorkerRegisterCalls = (page: Page): Promise<number> => page.evaluate(() => (
  (globalThis as { __gateServiceWorkerRegisterCalls?: number }).__gateServiceWorkerRegisterCalls ?? -1
));

/**
 * fixture のサーバが付ける、機密のヘッダの値（`fixtures/server.ts`）。
 * - `redirect-secret`: `/__technical-redirect` の応答の `Set-Cookie`（その後のリクエストの `Cookie` にも載る）。
 * - `fixture-response-secret`: `/__broken-image.png` の応答の `X-Api-Key`。
 * - `must-not-enter-evidence`: 両方の応答の `X-Unselected-Secret`（記録する対象として選ばないヘッダ）。
 */
const FIXTURE_SECRET_VALUES = Object.freeze(['redirect-secret', 'fixture-response-secret', 'must-not-enter-evidence'] as const);

let browser: Browser;
let server: FixtureServer;
let factory: BrowserContextFactory;
let workDirectory: string;
const launchers: RunLauncher[] = [];

beforeAll(async () => {
  server = await startFixtureServer();
  workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-safety-gates-'));
});

afterAll(async () => {
  for (const launcher of launchers.splice(0)) {
    await launcher.closeAll();
  }
  await server?.close();
  if (workDirectory !== undefined) {
    await rm(workDirectory, { recursive: true, force: true });
  }
});

// afterAll は登録の逆順に実行されるので、ブラウザを閉じてから、サーバと作業のディレクトリを片付ける。
useHeadlessChromium((launched) => {
  browser = launched;
});

beforeAll(() => {
  factory = createGateFactory(browser, server.origin);
});

const urlOf = (path: string): string => `${server.origin}${path}`;

// ---------------------------------------------------------------------------------------------------------------
// 段階ごとの操作
// ---------------------------------------------------------------------------------------------------------------

interface PassiveGateOutcome {
  readonly window: ServerWindow;
  readonly ledger: SafetyLedger;
  /** 待ち終えた時点（後片付けの前）の page の URL。 */
  readonly pageUrl: string;
  /** 待ち終えた時点（後片付けの前）に、Guard が Context を閉じていたか。 */
  readonly guardClosed: boolean;
}

/** `openGuardedPassivePage` の追加の指定（C18b）。 */
interface PassiveGateOptions {
  /** page を読み込む前に加える、初期化のスクリプト。 */
  readonly initScript?: string;
  /** 読み込みの後に、page で行う操作（例: ボタンの click）。 */
  readonly act?: (page: Page) => Promise<void>;
  /** 省略すると、headless の設定の `factory`。 */
  readonly factory?: BrowserContextFactory;
}

/**
 * Guard の付いた Passive の page で `path` を開く。`until` が真になるまで（Ledger の遮断の記録などで、ページの試みが起きたことを
 * 確かめるまで）待ち、さらに `QUIET_PERIOD_MS` だけ待つ。サーバの印は、ページを開く前に付ける。
 */
async function openGuardedPassivePage(
  path: string,
  until: (page: Page, ledger: SafetyLedger) => Promise<boolean>,
  options: PassiveGateOptions = {},
): Promise<PassiveGateOutcome> {
  return await withGuardedPassivePage(options.factory ?? factory, viewport, async (page, context, ledger) => {
    if (options.initScript !== undefined) {
      await page.addInitScript({ content: options.initScript });
    }
    const window = openServerWindow(server);
    await page.goto(urlOf(path), { waitUntil: 'load' });
    await options.act?.(page);
    await expect.poll(() => until(page, ledger)).toBe(true);
    await wait(QUIET_PERIOD_MS);
    return { window, ledger, pageUrl: page.url(), guardClosed: isPassiveRequestGuardClosed(context) };
  });
}

interface InteractionGateOutcome {
  readonly window: ServerWindow;
  readonly result: InteractionAuditResult;
}

/** session に加える、テストの側の準備と後片付けの前の観測。 */
interface SessionHooks {
  /** session を作った直後（page を読み込む前）に呼ぶ。 */
  readonly prepare?: (session: InteractionGuardedSession) => Promise<void>;
  /** session を閉じる直前に呼ぶ。 */
  readonly beforeClose?: (session: InteractionGuardedSession) => Promise<void>;
}

/**
 * 候補を探したうえで、サーバに印を付け、本物の Guard の付いた session で `auditInteraction` を行う（Interaction の段階）。
 * 印の後にサーバに届くのは、隔離した session が `path` を読み込む GET だけのはずである。
 */
async function auditGuardedInteraction(path: string, name: string, hooks: SessionHooks = {}): Promise<InteractionGateOutcome> {
  const candidate = await discoverInteractionCandidate(factory, server.origin, viewport, path, name);
  const sessionFactory = async (sessionViewport: Viewport): Promise<InteractionGuardedSession> => {
    const session = await factory.createInteractionSession(sessionViewport);
    await hooks.prepare?.(session);
    if (hooks.beforeClose === undefined) {
      return session;
    }
    const beforeClose = hooks.beforeClose;
    return Object.freeze({
      ...session,
      close: async (): Promise<void> => {
        await beforeClose(session);
        await session.close();
      },
    });
  };
  const window = openServerWindow(server);
  const result = await auditInteraction(interactionAuditInput({
    factory,
    origin: server.origin,
    viewport,
    path,
    candidate,
    sessionFactory,
  }));
  await wait(QUIET_PERIOD_MS);
  return { window, result };
}

/** Guard のない Context で `path` を開き、名前が `name` のボタンを押す（対照の確認）。`initScript` は、読み込みの前に加える。 */
async function clickUnguarded(
  path: string,
  name: string,
  until: (window: ServerWindow, page: Page) => Promise<boolean> | boolean,
  initScript?: string,
): Promise<ServerWindow> {
  return withUnguardedPage(browser, viewport, async (page) => {
    if (initScript !== undefined) {
      await page.addInitScript({ content: initScript });
    }
    await page.goto(urlOf(path), { waitUntil: 'load' });
    const window = openServerWindow(server);
    await page.getByRole('button', { name }).click();
    await expect.poll(() => until(window, page)).toBe(true);
    return window;
  });
}

const blockedMethodsOf = (entries: readonly { readonly method: string }[]): string[] =>
  [...new Set(entries.map((entry) => entry.method))].sort();

// ---------------------------------------------------------------------------------------------------------------
// GATE-S01・S02: 変更系のメソッド（POST、PUT、PATCH、DELETE）
// ---------------------------------------------------------------------------------------------------------------

describe('GATE-S01 / GATE-S02: non-read methods never reach the server (Passive phase)', () => {
  it('GATE-S01 GATE-S02 Passive: POST (fetch and sendBeacon), PUT and DELETE sent on load do not reach the server', async () => {
    const { window, ledger } = await openGuardedPassivePage(
      '/page-auditor-non-read-requests.html',
      async (_page, pageLedger) => blockedMethodsOf(pageLedger.snapshot().blockedRequests).join() === 'DELETE,POST,PUT',
    );

    expect(window.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
    expect(window.requestLines()).toEqual(['GET /page-auditor-non-read-requests.html']);
    // 補助: Ledger は、試みたリクエストを遮断として記録した（違反はない）。
    expect(ledger.snapshot().blockedRequests.every((entry) => entry.url === urlOf('/__mutation'))).toBe(true);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
  });

  it('GATE-S02 Passive: PATCH sent on load does not reach the server', async () => {
    const { window, ledger } = await openGuardedPassivePage(
      '/passive-patch-request.html',
      async (_page, pageLedger) => blockedMethodsOf(pageLedger.snapshot().blockedRequests).join() === 'PATCH',
    );

    expect(window.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
    expect(window.requestLines()).toEqual(['GET /passive-patch-request.html']);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
  });

  /**
   * DEF-038（設計書 `2026-10-08-beaksight-def-038-passive-page-close-design.md` 4）: ページを離れるとき（`pagehide`・
   * `visibilitychange`）の `sendBeacon` と keepalive の `fetch` の POST は、製品の閉じる手順（`closePassivePageAndContext`）で
   * 閉じても、サーバに届かない。`UNLOAD_BEACON_CLOSE_ROUNDS` 回くり返し、全部の回の後に `FROZEN_POPUP_LATE_DELIVERY_SETTLE_MS`
   * 待ってから、改めて確かめる。
   */
  it('GATE-S01 Passive: POST sent while the page is being left (pagehide, visibilitychange) does not reach the server when the session is closed (DEF-038)', async () => {
    const { failedRounds, allRoundsWindow } = await runGuardedUnloadBeaconRounds(factory, server, viewport);

    expect(failedRounds).toEqual([]);
    expect(allRoundsWindow.count(null, UNLOAD_BEACON_TARGET_PATH)).toBe(0);
    expect(allRoundsWindow.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
  }, UNLOAD_BEACON_ROUNDS_TEST_TIMEOUT_MS);

  it('GATE-S01 control: without the Guard, closing the same page with page.close() delivers POST /__mutation (DEF-038)', async () => {
    const window = await closeUnguardedUnloadBeaconPage(browser, server, viewport);

    expect(window.count('POST', UNLOAD_BEACON_TARGET_PATH)).toBeGreaterThan(0);
  });

  /**
   * DEF-042（設計書 `2026-10-08-beaksight-def-042-guard-fetch-all-design.md` 4）: ページ自身が `location.href` で別の文書へ移るときの
   * `pagehide` の `sendBeacon` と keepalive の `fetch` の POST は、Playwright の route を通らずに出るが、Guard の CDP の横取り（すべての
   * 要求の Request の段階）で止まり、サーバに届かず、`blockedRequests` に残る。`UNLOAD_BEACON_SELF_NAVIGATION_ROUNDS` 回くり返し、
   * 全部の回の後に `FROZEN_POPUP_LATE_DELIVERY_SETTLE_MS` 待ってから、改めて確かめる。
   */
  it('GATE-S01 Passive: POST sent while the page leaves by itself (location.href; pagehide beacon, keepalive fetch) does not reach the server (DEF-042)', async () => {
    const { failedRounds, allRoundsWindow } = await runGuardedSelfNavigationRounds(
      () => openGuardedPassiveSession(factory, viewport),
      server,
      unloadBeaconSelfNavigationPath('same-site'),
      pageUrlIs(urlOf(NAVIGATION_TARGET_PAGE)),
    );

    expect(failedRounds).toEqual([]);
    expect(allRoundsWindow.count(null, UNLOAD_BEACON_TARGET_PATH)).toBe(0);
    expect(allRoundsWindow.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
  }, UNLOAD_BEACON_SELF_NAVIGATION_TEST_TIMEOUT_MS);

  it('GATE-S01 control: without the Guard, the same page leaving by itself delivers POST /__mutation (DEF-042)', async () => {
    const window = await leaveUnguardedUnloadBeaconPage(
      browser,
      server,
      viewport,
      unloadBeaconSelfNavigationPath('same-site'),
      pageUrlIs(urlOf(NAVIGATION_TARGET_PAGE)),
    );

    expect(window.count('POST', UNLOAD_BEACON_TARGET_PATH)).toBeGreaterThan(0);
  });

  it('GATE-S01 GATE-S02 control: without the Guard, the same pages deliver POST, PUT, PATCH and DELETE to the server', async () => {
    const window = openServerWindow(server);
    await withUnguardedPage(browser, viewport, async (page) => {
      await page.goto(urlOf('/page-auditor-non-read-requests.html'), { waitUntil: 'load' });
      // DELETE は、読み込みの後に遅れて送られるので、届くのを待ってから次のページに移る。
      await expect.poll(() => {
        const counters = window.nonReadCounters();
        return counters.post > 0 && counters.put > 0 && counters.delete > 0;
      }).toBe(true);
      await page.goto(urlOf('/passive-patch-request.html'), { waitUntil: 'load' });
      await expect.poll(() => window.nonReadCounters().patch).toBeGreaterThan(0);
    });
  });

  /**
   * DEF-044（設計書 `2026-10-08-beaksight-def-044-046-review-fixes-design.md` 1）: Shared Worker の中の要求は、Playwright の route も
   * Guard の CDP の横取りも通らないので、Shared Worker を Chromium の起動の引数（`CHROMIUM_SHARED_WORKERS_DISABLED_ARGS`）で無効にする。
   * テストの既定の headless shell と、CLI の起動の設定（`chromiumLaunchOptions`）の両方で、Passive の Context と凍結の前の Interaction の
   * session で、Shared Worker が作れず（`typeof SharedWorker === 'undefined'`）、fetch・XHR・keepalive の POST が届かず、違反 0（factory の
   * 自己検査 `SHARED_WORKER_OBSERVED` も出ない）ことを確かめる。対照（引数を外した Chromium で届く）は `gate-fixtures.test.ts`。
   */
  describe.each([
    { name: 'the headless shell (test default)', launch: (): Promise<Browser> => launchHeadlessChromium() },
    { name: 'the CLI Chromium (chromiumLaunchOptions, headless)', launch: (): Promise<Browser> => chromium.launch(chromiumLaunchOptions({ headless: true })) },
  ])('GATE-S01 Shared Worker (DEF-044), with $name', ({ launch }) => {
    let sharedWorkerBrowser: Browser;
    let sharedWorkerFactory: BrowserContextFactory;

    beforeAll(async () => {
      sharedWorkerBrowser = await launch();
      sharedWorkerFactory = createGateFactory(sharedWorkerBrowser, server.origin);
    });

    afterAll(async () => {
      await sharedWorkerBrowser?.close();
    });

    it.each(SHARED_WORKER_POST_KINDS.flatMap((kind) => [
      { kind, phase: 'Passive', open: () => openGuardedPassiveSession(sharedWorkerFactory, viewport) },
      { kind, phase: 'Interaction (before the freeze)', open: () => openInteractionSessionBeforeFreeze(sharedWorkerFactory, viewport) },
    ]))('GATE-S01 $phase: a Shared Worker cannot be created, and its $kind POST never reaches the server, without a violation', async ({ kind, open }) => {
      const outcome = await openGuardedSharedWorkerPostsPage(open, server, kind);

      expect(outcome.window.count(null, '/__mutation')).toBe(0);
      expect(outcome.fixtureState).toEqual(SHARED_WORKER_DISABLED_FIXTURE_STATE);
      expect(outcome.window.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
      expect(outcome.invariantViolations).toEqual([]);
      expect(outcome.closeFailures).toEqual([]);
    });
  });
});

describe('GATE-S01 / GATE-S02: non-read methods never reach the server (Interaction phase)', () => {
  it.each([
    ['GATE-S01', 'POST', '/mutation-button.html', 'Attempt mutation'],
    ['GATE-S02', 'PUT', '/put-request.html', 'Send PUT'],
    ['GATE-S02', 'PATCH', '/patch-request.html', 'Send PATCH'],
    ['GATE-S02', 'DELETE', '/delete-request.html', 'Send DELETE'],
  ] as const)('%s Interaction: %s sent by the clicked control does not reach the server', async (
    _gate,
    method,
    path,
    name,
  ) => {
    const { window, result } = await auditGuardedInteraction(path, name);

    expect(window.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
    expect(window.requestLines()).toEqual([`GET ${path}`]);
    // 補助: 押した操作が試みたリクエストを、凍結が遮断として記録した。
    expect(result.status).toBe('BLOCKED_BY_SAFETY');
    expect(blockedMethodsOf(result.safety.blockedInteractionRequests)).toContain(method);
    expect(result.safety.invariantViolations).toEqual([]);
  });

  it.each([
    ['POST', '/mutation-button.html', 'Attempt mutation'],
    ['PUT', '/put-request.html', 'Send PUT'],
    ['PATCH', '/patch-request.html', 'Send PATCH'],
    ['DELETE', '/delete-request.html', 'Send DELETE'],
  ] as const)('GATE-S01 GATE-S02 control: without the Guard, clicking the same control delivers %s to the server', async (
    method,
    path,
    name,
  ) => {
    await clickUnguarded(path, name, (window) => window.count(method, '/__mutation') > 0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// GATE-S03: mailto:、tel:、外部のアプリの起動
// ---------------------------------------------------------------------------------------------------------------

describe('GATE-S03: mailto:, tel: and external application launches are not performed', () => {
  it.each([
    ['/mailto-link.html', 'Email fixture', 'mailto:fixture@example.test'],
    ['/tel-link.html', 'Call fixture', 'tel:+15550100'],
  ] as const)('GATE-S03 Interaction: %s is not clicked, no page opens, and only the page itself reaches the server', async (
    path,
    name,
    href,
  ) => {
    const observed: { clicks: number | null; pages: number | null } = { clicks: null, pages: null };
    const { window, result } = await auditGuardedInteraction(path, name, {
      prepare: async (session) => {
        await session.page.addInitScript({ content: COUNT_CLICKS_SCRIPT });
      },
      beforeClose: async (session) => {
        observed.pages = session.page.context().pages().length;
        observed.clicks = await session.page.evaluate(() => (globalThis as { __gateClicks?: number }).__gateClicks ?? -1);
      },
    });

    // サーバには、そのページへの GET だけが届く。
    expect(window.requestLines()).toEqual([`GET ${path}`]);
    expectOnlyReadRequests(window.counters(), window.observations());
    // 外部のアプリを起動しうる操作（click）は、行われない。ページも開かない。
    expect(observed).toEqual({ clicks: 0, pages: 1 });
    // 補助: Ledger に遮断が記録される。
    expect(result.status).toBe('REJECTED_UNSAFE');
    expect(result.safety.blockedExternalActions).toEqual([expect.objectContaining({ url: href, reason: 'EXTERNAL_ACTION' })]);
  });

  it.each([
    ['/mailto-link.html', 'Email fixture'],
    ['/tel-link.html', 'Call fixture'],
  ] as const)('GATE-S03 control: without the Guard, the click on %s reaches the link (the default action is prevented by the test)', async (
    path,
    name,
  ) => {
    await clickUnguarded(
      path,
      name,
      async (_window, page) => (await page.evaluate(() => (globalThis as { __gateClicks?: number }).__gateClicks ?? 0)) === 1,
      COUNT_CLICKS_PREVENTING_DEFAULT_SCRIPT,
    );
  });
});

// C18b（DEF-012。Task 19 の前の整理の設計書 4.2）: ページのスクリプトによる外部スキーム（`tel:`、`mailto:`、独自のスキーム）への
// 移動の試みは、Guard が Safety Ledger の `externalSchemeNavigations` に記録する。数え方は、ほかの Gate と同じく、サーバの境界の
// 差分である（Ledger は記録の確認）。
// R7d（中断した Run の再開の設計書 4.10）: CLI の Chromium は、headless でも通常の Chromium の本体を使うので、外部のアプリが
// 起動しうる。そのため、headed と headless を問わず、この移動の試みは安全の不変条件の違反（`EXTERNAL_SCHEME_NAVIGATION_ATTEMPTED`）
// になり、Guard が Context を閉じる。Run は `ABORTED_BY_SAFETY` になる。Guard は headed かどうかを受け取らない。
// 対照の確認（Guard のない Context で、同じ fixture が、その外部スキームの URL への移動のリクエストを出す）は、
// `tests/integration/gate-fixtures.test.ts` の C18b に置く。
// 厳守事項: Chromium は headless だけで起動する。宛先は実在しない。

/** 外部スキームへの移動の試みの、不変条件の違反のコード（R7d。中断した Run の再開の設計書 4.10）。 */
const EXTERNAL_SCHEME_ATTEMPTED_VIOLATION_CODE = 'EXTERNAL_SCHEME_NAVIGATION_ATTEMPTED';

/** ボタンのページで、ボタンを押す（`button-click` の経路の Passive の段階）。 */
const clickExternalSchemeButton = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: EXTERNAL_SCHEME_BUTTON_NAME }).click();
};

describe('GATE-S03: navigations to external schemes by the page are recorded as invariant violations, and nothing but the page reaches the server', () => {
  const cases = EXTERNAL_SCHEME_ROUTES.flatMap((route) => EXTERNAL_SCHEME_KEYS.map((key) => [route, key] as const));

  it.each(cases)('GATE-S03 Passive: %s to %s is recorded, is an invariant violation, the Guard closes the Context, and only the page GET reaches the server', async (
    route,
    key,
  ) => {
    const path = externalSchemeFixturePath(route, key);

    const { window, ledger, pageUrl, guardClosed } = await openGuardedPassivePage(
      path,
      async (page) => isPassiveRequestGuardClosed(page.context()),
      route === 'button-click' ? { act: clickExternalSchemeButton } : {},
    );

    // 補助の確認（RC18a の指摘4）: 「サーバには、そのページへの GET だけが届く」と「page の URL は変わらない」は、Guard がなくても
    // 同じ結果になる（外部スキームはネットワークを通らず、テストの headless のブラウザは外部スキームへ移動しない）。Guard の働きを
    // 見分けているのは、下の Ledger の記録と違反、Context を閉じたことの確認である。
    // サーバには、そのページへの GET だけが届く。
    expect(window.requestLines()).toEqual([`GET ${externalSchemeFixturePathname(route)}`]);
    expectOnlyReadRequests(window.counters(), window.observations());
    // page の URL は変わらない。
    expect(pageUrl).toBe(urlOf(path));
    // Ledger に、そのスキームと経路の記録と、違反がある。Guard は Context を閉じた（Guard の働きを見分ける確認）。
    expect(guardClosed).toBe(true);
    const snapshot = ledger.snapshot();
    expect(snapshot.externalSchemeNavigations).toEqual([externalSchemeAttemptRecord(route, key, 'PASSIVE')]);
    expect(snapshot.invariantViolations).toEqual([
      expect.objectContaining({ code: EXTERNAL_SCHEME_ATTEMPTED_VIOLATION_CODE }),
    ]);
  });

  it.each(EXTERNAL_SCHEME_KEYS)('GATE-S03 Interaction: the clicked button that navigates to %s is recorded, is an invariant violation, the result is BLOCKED_BY_SAFETY, and only the page GET reaches the server', async (
    key,
  ) => {
    const path = externalSchemeFixturePath('button-click', key);
    const observed: { pageUrl: string | null } = { pageUrl: null };

    const { window, result } = await auditGuardedInteraction(path, EXTERNAL_SCHEME_BUTTON_NAME, {
      beforeClose: async (session) => {
        // Guard が閉じた page でも、最後の URL は読める（page の中のスクリプトは、閉じた後には動かせない）。
        observed.pageUrl = session.page.url();
      },
    });

    // click は行われた（候補は、方針で拒否されていない）。fixture のボタンは、押されたときにだけ外部スキームへ移動するので、
    // 凍結の後の移動の試みの記録が、click が行われたことを示す（Guard が session の Context を閉じるので、page の中で数えた
    // click の数は、閉じた後には読めない）。
    expect(result.status).not.toBe('REJECTED_UNSAFE');
    expect(result.safety.externalSchemeNavigations).toEqual([externalSchemeAttemptRecord('button-click', key, 'INTERACTION')]);
    // 凍結の後の外部スキームへの移動の試みなので、結果は BLOCKED_BY_SAFETY になる。移動の試みは違反になり、Guard が session の
    // Context を閉じる（その後の owner の close は、無効にした Context の close の失敗として記録される）。
    expect(result.status).toBe('BLOCKED_BY_SAFETY');
    expect(result.reason).toBe('SAFETY_FREEZE_BLOCKED');
    expect(result.safety.invariantViolations).toEqual([
      expect.objectContaining({ code: EXTERNAL_SCHEME_ATTEMPTED_VIOLATION_CODE }),
      expect.objectContaining({ code: 'INTERACTION_OWNER_CLOSE_FAILED' }),
    ]);
    // page の URL は変わらず、サーバには、そのページへの GET だけが届く。
    expect(observed.pageUrl).toBe(urlOf(path));
    expect(window.requestLines()).toEqual([`GET ${EXTERNAL_SCHEME_BUTTON_PAGE}`]);
    expectOnlyReadRequests(window.counters(), window.observations());
  });

  it('GATE-S03 CLI Run (headless): the page navigation to an external scheme ends with ABORTED_BY_SAFETY and exit code 3, and the written page.json keeps the record', async () => {
    const route = 'location-href';
    const key = 'mailto';
    const window = openServerWindow(server);

    // 開始の URL のクエリ（経路とスキームの選択）を、クロールの正規化で落とさないように、許可するクエリの名前を指定する。
    const cliRun = await runGateCli('s03-external-scheme', externalSchemeFixturePath(route, key), undefined, {
      audit: { screenshots: false },
      crawl: { allowedQueryParameters: ['to', 'via'], minNavigationIntervalMs: 0 },
    });

    expect(cliRun.stderr).toBe('');
    // headless でも、違反として Run を止める（R7d）。
    expect(cliRun.run.runStatus).toBe('ABORTED_BY_SAFETY');
    expect(cliRun.code).toBe(EXIT_CODES.ABORTED_BY_SAFETY);
    expect(cliRun.run.safety.invariantViolations.map((violation) => violation.code))
      .toEqual([EXTERNAL_SCHEME_ATTEMPTED_VIOLATION_CODE]);
    // 書き出した page.json の Safety の Evidence に、外部スキームへの移動の記録が残る。
    const pages = writtenPageResults(await readRunArtifactFiles(cliRun.runDirectory));
    // 監査したページは、その fixture の1つだけである（page の identity の URL は、正規化でクエリの名前の順に並ぶ）。
    const startUrl = new URL(urlOf(externalSchemeFixturePath(route, key)));
    startUrl.searchParams.sort();
    expect(pages.map((page) => page.pageUrl)).toEqual([startUrl.toString()]);
    const recorded = safetyExternalSchemeNavigations(pages);
    expect(recorded).toContainEqual(externalSchemeAttemptRecord(route, key, 'PASSIVE'));
    expect(recorded.every((event) => event.url === EXTERNAL_SCHEME_TARGETS[key].url)).toBe(true);
    // 補助: 記録した試みは、Finding にもなる（C18a の Rule）。
    expect(pages.flatMap((page) => page.findings.map((finding) => finding.ruleId)))
      .toContain('SAFETY_EXTERNAL_SCHEME_NAVIGATION_ATTEMPTED');
    // サーバの境界: GET・HEAD 以外のリクエストは届かない。
    expect(window.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
    expect(window.count('GET', EXTERNAL_SCHEME_NAVIGATION_PAGE)).toBeGreaterThan(0);
  }, RUN_TEST_TIMEOUT_MS);
});

// C18g（RC18a の指摘1・3。Task 19 の前の整理の設計書 4.2「サーバのリダイレクトは、たどる前に止める」、4.2.1）: サーバのリダイレクト
// （`302 Location: <外部スキーム>`）は、Guard が Document の応答の段階で、たどる前に止め、`externalSchemeNavigations` に
// `EXTERNAL_SCHEME_REDIRECT_BLOCKED` で記録する。止めて防げる経路なので、違反にしない（ページのスクリプトによる移動は違反にする
// のと違う。中断した Run の再開の設計書 4.10）。
// 対照の確認（Guard のない Context では、同じ fixture がリダイレクトをたどり、外部スキームへの `request` の事象（`redirectedFrom`
// 付き）が来ること）は、`tests/integration/gate-fixtures.test.ts` の C18g に置く。RC18a の再現（`probe3-frame.log`）では、
// Run の artifact の記録が0件だった。
describe('GATE-S03: server redirects to external schemes are stopped before they are followed, and recorded', () => {
  it.each(EXTERNAL_SCHEME_KEYS)('GATE-S03 Passive: the iframe redirect to %s is stopped and recorded without a violation; only the page and the redirect source reach the server', async (
    key,
  ) => {
    const path = externalSchemeRedirectFramePath(key);
    let externalFrames: string[] | null = null;

    const { window, ledger, pageUrl, guardClosed } = await openGuardedPassivePage(
      path,
      async (page, pageLedger) => {
        externalFrames = externalSchemeTargetFrameUrls(page);
        return pageLedger.snapshot().externalSchemeNavigations.length > 0;
      },
    );

    // Guard の働きを見分ける確認: Ledger に、止めた記録がある。違反にせず、Context も閉じない。
    const snapshot = ledger.snapshot();
    expect(snapshot.externalSchemeNavigations).toEqual([stoppedRedirectRecord(key, 'SUB')]);
    expect(snapshot.invariantViolations).toEqual([]);
    expect(guardClosed).toBe(false);
    // サーバには、ページとリダイレクトの元のリクエストだけが届き、外部スキームへの移動は起きない。
    expect(window.requestLines()).toEqual([`GET ${EXTERNAL_SCHEME_REDIRECT_FRAME_PAGE}`, `GET ${EXTERNAL_SCHEME_REDIRECT_PATH}`]);
    expectOnlyReadRequests(window.counters(), window.observations());
    expect(pageUrl).toBe(urlOf(path));
    expect(externalFrames).toEqual([]);
  });

  it.each(EXTERNAL_SCHEME_KEYS)('GATE-S03 Passive: the main frame redirect to %s is stopped and recorded without a violation; the navigation fails and only the redirect source reaches the server', async (
    key,
  ) => {
    await withGuardedPassivePage(factory, viewport, async (page, context, ledger) => {
      const window = openServerWindow(server);

      const navigation = await page.goto(urlOf(externalSchemeRedirectPath(key))).then(() => 'RESOLVED', () => 'REJECTED');
      await expect.poll(() => ledger.snapshot().externalSchemeNavigations.length).toBeGreaterThan(0);
      await wait(QUIET_PERIOD_MS);

      expect(navigation).toBe('REJECTED');
      const snapshot = ledger.snapshot();
      expect(snapshot.externalSchemeNavigations).toEqual([stoppedRedirectRecord(key, 'MAIN')]);
      // RC18a の指摘3（設計者の判断）: Guard 自身が止めた main frame のリクエストの失敗は、予期した失敗なので、
      // `HTTP_MAIN_FRAME_DELIVERY_FAILED` の違反にしない。違反は0件で、Context も閉じない。
      expect(snapshot.invariantViolations).toEqual([]);
      expect(isPassiveRequestGuardClosed(context)).toBe(false);
      expect(window.requestLines()).toEqual([`GET ${EXTERNAL_SCHEME_REDIRECT_PATH}`]);
      expect(window.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
      expect(page.isClosed() ? [] : externalSchemeTargetFrameUrls(page)).toEqual([]);
    });
  });

  it('GATE-S03 CLI Run (headless): a start page that redirects the main frame to an external scheme is recorded, is not ABORTED_BY_SAFETY, and keeps its navigation failure', async () => {
    const key = 'tel';
    const path = externalSchemeRedirectPath(key);
    const window = openServerWindow(server);

    const cliRun = await runGateCli('s03-external-scheme-main-redirect', path, undefined, {
      audit: { screenshots: false },
      crawl: { allowedQueryParameters: ['to'], minNavigationIntervalMs: 0 },
    });

    expect(cliRun.stderr).toBe('');
    expect(cliRun.run.runStatus).not.toBe('ABORTED_BY_SAFETY');
    expect(cliRun.code).toBe(exitCodeForRunStatus(cliRun.run.runStatus));
    expect(cliRun.run.safety.invariantViolationCount).toBe(0);
    const pages = writtenPageResults(await readRunArtifactFiles(cliRun.runDirectory));
    expect(pages.map((page) => page.pageUrl)).toEqual([urlOf(path)]);
    // ナビゲーションは失敗するので、ページは FAILED になる（今のナビゲーションの失敗の扱いのまま）。
    expect(pages.map((page) => page.status)).toEqual(['FAILED']);
    const recorded = safetyExternalSchemeNavigations(pages);
    expect(recorded).toContainEqual(stoppedRedirectRecord(key, 'MAIN'));
    expect(recorded.every((event) => event.reason === 'EXTERNAL_SCHEME_REDIRECT_BLOCKED')).toBe(true);
    expect(window.count('GET', EXTERNAL_SCHEME_REDIRECT_PATH)).toBeGreaterThan(0);
    expect(window.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
  }, RUN_TEST_TIMEOUT_MS);

  it('GATE-S03 CLI Run (headless): the page with the iframe redirect keeps the stopped redirect in the written page.json, and the Run is not ABORTED_BY_SAFETY', async () => {
    const key = 'custom';
    const path = externalSchemeRedirectFramePath(key);
    const window = openServerWindow(server);

    // 開始の URL のクエリ（宛先の名前の選択）を、クロールの正規化で落とさないように、許可するクエリの名前を指定する。
    const cliRun = await runGateCli('s03-external-scheme-redirect', path, undefined, {
      audit: { screenshots: false },
      crawl: { allowedQueryParameters: ['to'], minNavigationIntervalMs: 0 },
    });

    expect(cliRun.stderr).toBe('');
    expect(cliRun.run.runStatus).not.toBe('ABORTED_BY_SAFETY');
    expect(cliRun.code).toBe(exitCodeForRunStatus(cliRun.run.runStatus));
    expect(cliRun.run.safety.invariantViolationCount).toBe(0);
    const pages = writtenPageResults(await readRunArtifactFiles(cliRun.runDirectory));
    expect(pages.map((page) => page.pageUrl)).toEqual([urlOf(path)]);
    // RC18a の再現では0件だった記録が、書き出した page.json の Safety の Evidence に残る。
    const recorded = safetyExternalSchemeNavigations(pages);
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded.every((event) => event.reason === 'EXTERNAL_SCHEME_REDIRECT_BLOCKED')).toBe(true);
    expect(recorded).toContainEqual(stoppedRedirectRecord(key, 'SUB'));
    // 補助: 止めたリダイレクトは、止めた事象の Finding になる（ページによる移動の試みの Finding にはならない）。
    const ruleIds = pages.flatMap((page) => page.findings.map((finding) => finding.ruleId));
    expect(ruleIds).toContain('SAFETY_EXTERNAL_SCHEME_REDIRECT_BLOCKED');
    expect(ruleIds).not.toContain('SAFETY_EXTERNAL_SCHEME_NAVIGATION_ATTEMPTED');
    // サーバの境界: リダイレクトの元のリクエストは届き、GET・HEAD 以外のリクエストは届かない。
    expect(window.count('GET', EXTERNAL_SCHEME_REDIRECT_PATH)).toBeGreaterThan(0);
    expect(window.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
  }, RUN_TEST_TIMEOUT_MS);
});

// GATE-S03（C18i。RC18b の N1）: 別のプロセスの iframe（OOPIF）の中で始まった移動の、外部スキームへのサーバのリダイレクトも、
// たどる前に止めて記録する。標準の headless は OOPIF を作らないので、この Gate だけは `--site-per-process` を付けた headless の
// Chromium で確かめる（サイトの分離を無効にする引数は使わない）。別のサイトの iframe は、同じ fixture のサーバの別のホスト名
// （`localhost`）で作る。RC18b の再現では、この経路の記録は0件だった。
describe('GATE-S03: server redirects to external schemes inside an out-of-process iframe (OOPIF) are stopped before they are followed, and recorded', () => {
  let isolatedBrowser: Browser | undefined;
  let isolatedFactory: BrowserContextFactory;

  beforeAll(async () => {
    // headless だけで起動する。`--site-per-process` は、別のサイトの iframe を別のプロセスにする（サイトの分離を強める側の引数）。
    const launched = await launchHeadlessChromium({ args: SITE_PER_PROCESS_ARGS });
    isolatedBrowser = launched;
    isolatedFactory = createGateFactory(launched, server.origin);
  });

  afterAll(async () => {
    await isolatedBrowser?.close();
  });

  it.each(EXTERNAL_SCHEME_KEYS)('GATE-S03 Passive OOPIF: the redirect to %s started by the OOPIF is stopped and recorded without a violation; only the pages and the redirect source reach the server', async (
    key,
  ) => {
    const passiveFactory = isolatedFactory;
    const crossSiteOrigin = crossSiteOriginOf(server.origin);
    const path = crossSiteFramePath(selfNavigatingFramePath(key));
    await withGuardedPassivePage(passiveFactory, viewport, async (page, context, ledger) => {
      const window = openServerWindow(server);

      await page.goto(urlOf(path), { waitUntil: 'load' });
      await expect.poll(() => ledger.snapshot().externalSchemeNavigations.length).toBeGreaterThan(0);
      await wait(QUIET_PERIOD_MS);

      // Guard の働きを見分ける確認: 移動は OOPIF の中で始まり、Ledger に止めた記録がある。違反にしない。
      expect((await oopifTargetUrls(isolatedBrowser!)).some((url) => url.startsWith(`${crossSiteOrigin}/`))).toBe(true);
      const snapshot = ledger.snapshot();
      expect(snapshot.externalSchemeNavigations).toEqual([stoppedRedirectRecord(key, 'SUB')]);
      expect(snapshot.invariantViolations).toEqual([]);
      expect(isPassiveRequestGuardClosed(context)).toBe(false);
      // サーバには、ページ、iframe のページ、リダイレクトの元のリクエストだけが届き、外部スキームへの移動は起きない。
      expect(window.requestLines()).toEqual([
        `GET ${CROSS_SITE_FRAME_PAGE}`,
        `GET ${SELF_NAVIGATING_FRAME_PAGE}`,
        `GET ${EXTERNAL_SCHEME_REDIRECT_PATH}`,
      ]);
      expectOnlyReadRequests(window.counters(), window.observations());
      expect(page.url()).toBe(urlOf(path));
      expect(externalSchemeTargetFrameUrls(page)).toEqual([]);
    });
  });

  it('GATE-S03 Passive OOPIF (headless): the redirect started by a nested OOPIF (127.0.0.1 in localhost) is stopped and recorded without a violation', async () => {
    const passiveFactory = isolatedFactory;
    const key: ExternalSchemeKey = 'custom';
    await withGuardedPassivePage(passiveFactory, viewport, async (page, _context, ledger) => {
      const window = openServerWindow(server);

      await page.goto(urlOf(crossSiteFramePath(crossSiteFramePath(selfNavigatingFramePath(key)))), { waitUntil: 'load' });
      await expect.poll(() => ledger.snapshot().externalSchemeNavigations.length).toBeGreaterThan(0);
      await wait(QUIET_PERIOD_MS);

      // RC18c の M2: 入れ子の iframe も、別のプロセスの iframe（OOPIF）である。localhost の OOPIF と、その中の 127.0.0.1 の
      // OOPIF（2つ目の OOPIF）の、どちらの target もある。
      const targets = await oopifTargetUrls(isolatedBrowser!);
      expect(targets.some((url) => url.startsWith(`${crossSiteOriginOf(server.origin)}/`))).toBe(true);
      expect(targets.some((url) => url.startsWith(`${server.origin}/`))).toBe(true);
      expect(ledger.snapshot().externalSchemeNavigations).toEqual([stoppedRedirectRecord(key, 'SUB')]);
      expect(ledger.snapshot().invariantViolations).toEqual([]);
      expect(window.requestLines()).toEqual([
        `GET ${CROSS_SITE_FRAME_PAGE}`,
        `GET ${CROSS_SITE_FRAME_PAGE}`,
        `GET ${SELF_NAVIGATING_FRAME_PAGE}`,
        `GET ${EXTERNAL_SCHEME_REDIRECT_PATH}`,
      ]);
      expect(window.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
    });
  });

  // RC18c の M2: Interaction の段階（凍結の後）でも、OOPIF が自分で始めた移動は、凍結で止まり、サーバに届かない。
  // 対照の確認（Guard のない Context では、同じ OOPIF の移動がリダイレクトをたどる）は、`gate-fixtures.test.ts` の C18i に置く。
  it('GATE-S03 Interaction OOPIF (headless): after the freeze, the OOPIF navigating itself to the redirect is stopped as INTERACTION_FROZEN before the server, without a violation', async () => {
    const crossSiteOrigin = crossSiteOriginOf(server.origin);
    const crossSiteFrames = (page: Page): ReturnType<Page['frames']> =>
      page.frames().filter((frame) => frame.url().startsWith(`${crossSiteOrigin}/`));
    const session = await isolatedFactory.createInteractionSession(viewport);
    try {
      await session.page.goto(urlOf(crossSiteFramePath(selfNavigatingFramePath())), { waitUntil: 'load' });
      await expect.poll(() => crossSiteFrames(session.page).length).toBe(1);
      const [frame] = crossSiteFrames(session.page);
      // iframe は、別のプロセスの iframe（OOPIF）である。
      expect((await oopifTargetUrls(isolatedBrowser!)).some((url) => url.startsWith(`${crossSiteOrigin}/`))).toBe(true);
      await session.activateInteractionFreeze();
      const window = openServerWindow(server);
      const target = externalSchemeRedirectPath('tel');

      await frame!.evaluate((href) => {
        location.href = href;
      }, target);
      await expect.poll(() => session.ledger.snapshot().blockedInteractionNavigations).toContainEqual({
        method: 'GET',
        url: `${crossSiteOrigin}${target}`,
        reason: 'INTERACTION_FROZEN',
      });
      await wait(QUIET_PERIOD_MS);

      // Guard の働きを見分ける確認: 凍結の遮断として記録され、違反はなく、session は閉じない。
      expect(session.ledger.snapshot().invariantViolations).toEqual([]);
      expect(session.ledger.snapshot().externalSchemeNavigations).toEqual([]);
      expect(session.isClosed()).toBe(false);
      // サーバには、リダイレクトの元のリクエストも届かない。
      expect(window.requestLines()).toEqual([]);
      expect(window.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
    } finally {
      if (!session.isClosed()) await session.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// GATE-S04〜S07: Interaction 中のポップアップ、ダウンロード、移動、WebSocket
// ---------------------------------------------------------------------------------------------------------------

describe('GATE-S04: popups during Interaction are blocked', () => {
  it('GATE-S04 Interaction: GET /popup-target.html never reaches the server', async () => {
    const { window, result } = await auditGuardedInteraction('/popup-button.html', 'Open popup');

    expect(window.count(null, '/popup-target.html')).toBe(0);
    expect(window.requestLines()).toEqual(['GET /popup-button.html']);
    expect(window.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
    expect(result.status).toBe('BLOCKED_BY_SAFETY');
    expect(result.safety.blockedPopups.length).toBeGreaterThan(0);
  });

  it('GATE-S04 control: without the Guard, the same click delivers GET /popup-target.html', async () => {
    await clickUnguarded('/popup-button.html', 'Open popup', (window) => window.count('GET', '/popup-target.html') > 0);
  });

  /**
   * DEF-036（設計書 `2026-10-08-beaksight-def-036-frozen-popup-design.md` 4）: 凍結の後に開いたポップアップの中のフォームの POST は、
   * サーバに届かない。届く場面は毎回は起きないので、`S04_POPUP_FORM_POST_AUDIT_ROUNDS` 回くり返し、どの回も確かめる。
   * 回ごとの結果をまとめてから確かめるので、失敗したときは、失敗した回とその内容がすべて分かる。全部の回の後に
   * `FROZEN_POPUP_LATE_DELIVERY_SETTLE_MS` 待ち、Context を閉じた後に遅れて届いた要求がないことを改めて確かめる。
   */
  it('GATE-S04 Interaction: POST /__mutation from a frozen popup form never reaches the server (DEF-036)', async () => {
    const allRoundsWindow = openServerWindow(server);
    const failedRounds: unknown[] = [];

    for (let round = 0; round < S04_POPUP_FORM_POST_AUDIT_ROUNDS; round += 1) {
      const { window, result } = await auditGuardedInteraction('/popup-form-post.html', 'Open popup form');
      const summary = {
        round,
        status: result.status,
        blockedPopups: result.safety.blockedPopups.length,
        delivered: window.count(null, '/__mutation'),
        nonReadCounters: window.nonReadCounters(),
        invariantViolations: result.safety.invariantViolations,
      };
      if (
        summary.status !== 'BLOCKED_BY_SAFETY'
        || summary.blockedPopups === 0
        || summary.delivered !== 0
        || Object.values(summary.nonReadCounters).some((count) => count !== 0)
        || summary.invariantViolations.length !== 0
      ) {
        failedRounds.push(summary);
      }
    }
    await wait(FROZEN_POPUP_LATE_DELIVERY_SETTLE_MS);

    expect(failedRounds).toEqual([]);
    expect(allRoundsWindow.count(null, '/__mutation')).toBe(0);
    expect(allRoundsWindow.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
  }, S04_POPUP_FORM_POST_TEST_TIMEOUT_MS);

  it('GATE-S04 control: without the Guard, the same popup form delivers POST /__mutation', async () => {
    await clickUnguarded('/popup-form-post.html', 'Open popup form', (window) => window.count('POST', '/__mutation') > 0);
  });

  /**
   * DEF-039（設計書 `2026-10-08-beaksight-def-039-040-egress-design.md` 2.1.4）: 凍結の後にページ自身が開いて、同じ処理の中で閉じる
   * ポップアップの、ページを離れるときの送信（`pagehide` の beacon と keepalive の POST）は、Guard の route を通らずに出るが、
   * Interaction の Context の出口の中継（凍結の後はすべて拒む）で止まり、サーバに届かない。`S04_POPUP_SELF_CLOSE_AUDIT_ROUNDS` 回
   * くり返し、どの回も確かめる。
   * DEF-042 の設計書 2.4（出口の中継との重なり）: Guard の CDP の横取り（すべての要求の Request の段階）が、opener の page の session で
   * ポップアップの送信も先に止める（理由 `INTERACTION_FROZEN`）ようになった。そのため、回ごとに、Guard の記録
   * （`blockedInteractionRequests` の `INTERACTION_FROZEN`）か中継の記録（`INTERACTION_FROZEN_EGRESS`）のどちらかがあることを確かめる
   * （中継の記録が 1 回以上という条件は外した）。中継が働く証拠は、中継の単体テスト（`tests/integration/egress-proxy.test.ts`）と
   * factory の部品のテスト（`tests/component/context-factory.test.ts`）で示す（Worker の WebSocket は CSP が Worker の中で止めるので、
   * 中継に CONNECT は来ない。DEF-040 の NP3）。
   */
  it('GATE-S04 Interaction: POST /__mutation sent while a frozen popup closes itself never reaches the server (DEF-039)', async () => {
    const allRoundsWindow = openServerWindow(server);
    const failedRounds: unknown[] = [];
    const egressRecordsByRound: string[][] = [];
    const guardRecordsByRound: string[][] = [];

    for (let round = 0; round < S04_POPUP_SELF_CLOSE_AUDIT_ROUNDS; round += 1) {
      const { window, result } = await auditGuardedInteraction(POPUP_SELF_CLOSE_BEACON_PAGE, POPUP_SELF_CLOSE_SAME_TASK_BUTTON);
      const egressRecords = result.safety.blockedInteractionRequests
        .filter((entry) => entry.reason === 'INTERACTION_FROZEN_EGRESS')
        .map((entry) => `${entry.method} ${entry.url}`);
      const guardRecords = result.safety.blockedInteractionRequests
        .filter((entry) => entry.reason === 'INTERACTION_FROZEN')
        .map((entry) => `${entry.method} ${entry.url}`);
      egressRecordsByRound.push(egressRecords);
      guardRecordsByRound.push(guardRecords);
      const summary = {
        round,
        status: result.status,
        blockedPopups: result.safety.blockedPopups.length,
        delivered: window.count(null, '/__mutation'),
        nonReadCounters: window.nonReadCounters(),
        invariantViolations: result.safety.invariantViolations,
        egressRecords,
        guardRecords,
      };
      if (
        summary.status !== 'BLOCKED_BY_SAFETY'
        || summary.blockedPopups === 0
        || summary.delivered !== 0
        || Object.values(summary.nonReadCounters).some((count) => count !== 0)
        || summary.invariantViolations.length !== 0
        || (summary.egressRecords.length === 0 && summary.guardRecords.length === 0)
      ) {
        failedRounds.push(summary);
      }
    }
    await wait(FROZEN_POPUP_LATE_DELIVERY_SETTLE_MS);
    // 回ごとの中継と Guard の記録（検証の記録のため。既定の報告では、PASS したテストの出力は表示されない）。
    console.info(`DEF-039 GATE-S04 egress records by round: ${JSON.stringify(egressRecordsByRound)}`);
    console.info(`DEF-039 GATE-S04 guard records by round: ${JSON.stringify(guardRecordsByRound)}`);

    expect(failedRounds).toEqual([]);
    expect(allRoundsWindow.count(null, '/__mutation')).toBe(0);
    expect(allRoundsWindow.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
  }, S04_POPUP_SELF_CLOSE_TEST_TIMEOUT_MS);

  it('GATE-S04 control: without the Guard, the same self-closing popup delivers POST /__mutation (DEF-039)', async () => {
    await clickUnguarded(
      POPUP_SELF_CLOSE_BEACON_PAGE,
      POPUP_SELF_CLOSE_SAME_TASK_BUTTON,
      (window) => window.count('POST', '/__mutation') > 0,
    );
  });
});

describe('GATE-S05: downloads during Interaction are blocked', () => {
  it.each([
    ['Attempt HTTP download', 'BLOCKED_BY_SAFETY'],
    ['Direct download', 'REJECTED_UNSAFE'],
  ] as const)('GATE-S05 Interaction: "%s" sends no GET /__download', async (name, status) => {
    const { window, result } = await auditGuardedInteraction('/download-button.html', name);

    expect(window.count(null, '/__download')).toBe(0);
    expect(window.counters().download).toBe(0);
    expect(window.requestLines()).toEqual(['GET /download-button.html']);
    expect(result.status).toBe(status);
  });

  it('GATE-S05 control: without the Guard, the same click delivers GET /__download', async () => {
    await clickUnguarded(
      '/download-button.html',
      'Attempt HTTP download',
      (window) => window.count('GET', '/__download') > 0 && window.counters().download > 0,
    );
  });
});

describe('GATE-S06: navigation during Interaction is blocked', () => {
  it('GATE-S06 Interaction: GET /navigation-target.html never reaches the server', async () => {
    const { window, result } = await auditGuardedInteraction('/navigation-button.html', 'Attempt navigation');

    expect(window.count(null, '/navigation-target.html')).toBe(0);
    expect(window.requestLines()).toEqual(['GET /navigation-button.html']);
    expect(result.status).toBe('BLOCKED_BY_SAFETY');
    expect(result.safety.blockedInteractionNavigations.length).toBeGreaterThan(0);
  });

  it('GATE-S06 control: without the Guard, the same click delivers GET /navigation-target.html', async () => {
    await clickUnguarded(
      '/navigation-button.html',
      'Attempt navigation',
      (window) => window.count('GET', '/navigation-target.html') > 0,
    );
  });

  // RP18 の指摘4（設計書 4.2）: 凍結の失敗の後の無効化（Context を閉じる処理）が終わらず、`auditInteraction` が待つのをやめた後も、
  // 本物の Guard の付いた Context から、POST・移動・読み取りのリクエストがサーバに届かない。
  it('GATE-S06 (RP18-4): after a freeze failure whose invalidation never finishes, POST, navigation and fetches still do not reach the server', async () => {
    const stalling = browserStallingContextClose(browser);
    const stalledFactory = new BrowserContextFactory(stalling.browser, createTestConfig(server.origin), () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
    const path = '/navigation-button.html';
    try {
      const candidate = await discoverInteractionCandidate(factory, server.origin, viewport, path, 'Attempt navigation');
      let captured: InteractionGuardedSession | undefined;
      // 凍結を失敗させる: 凍結の直前に、同じ Context に2つ目の page を factory で開く。本物の Guard の凍結は、owner の page が
      // 1つでないので `failClosed` になり、違反を記録して Context を閉じようとする（その `close()` は止めてあるので、終わらない）。
      const sessionFactory = async (sessionViewport: Viewport): Promise<InteractionGuardedSession> => {
        const session = await stalledFactory.createInteractionSession(sessionViewport);
        captured = session;
        return Object.freeze({
          ...session,
          activateInteractionFreeze: async (): Promise<void> => {
            await stalledFactory.createPassivePage(session.page.context());
            await session.activateInteractionFreeze();
          },
        });
      };
      const window = openServerWindow(server);

      const completion = await auditInteraction(interactionAuditInput({
        factory: stalledFactory,
        origin: server.origin,
        viewport,
        path,
        candidate,
        sessionFactory,
        freezeActivationTimeoutMs: SHORT_FREEZE_TIMEOUT_MS,
      })).then(
        (value) => ({ kind: 'returned' as const, value }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      );

      // `auditInteraction` は、凍結を待つのをやめ、click せずに終えた（owner の後片付けも、終わらない無効化のため終端に達しない）。
      expect(completion.kind).toBe('rejected');
      const cleanupError = completion.kind === 'rejected' ? completion.error : undefined;
      expect(cleanupError).toBeInstanceOf(InteractionOwnerCleanupError);
      const session = captured;
      if (session === undefined) {
        throw new Error('the Interaction session was not created');
      }
      // 無効化は、始まったが終わっていない（Guard は Context を閉じようとして、止まっている）。
      expect(stalling.stalledCloseCalls()).toBeGreaterThan(0);
      expect(isPassiveRequestGuardClosed(session.page.context())).toBe(false);
      expect(session.page.isClosed()).toBe(false);
      // 凍結は、Passive の状態から失敗した（一度も凍結されていない）。
      expect(session.ledger.snapshot().invariantViolations).toContainEqual({
        code: 'INTERACTION_FREEZE_ACTIVATION_FAILED',
        message: 'Interaction freeze requires exactly one current owner page',
      });
      expect(window.requestLines()).toEqual([`GET ${path}`]);

      // 待つのをやめた後の試み。
      const attempts = await attemptPostNavigationAndFetch(session.page);

      expect(attempts).toEqual({ post: 'failed', fetch: 'failed' });
      expect(window.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
      expect(window.count(null, '/navigation-target.html')).toBe(0);
      expect(window.count(null, '/popup-target.html')).toBe(0);
      expect(window.requestLines()).toEqual([`GET ${path}`]);
    } finally {
      await stalling.release();
    }
  });

  it('GATE-S06 (RP18-4) control: without the Guard, the same POST, navigation and fetch reach the server', async () => {
    const window = openServerWindow(server);
    await withUnguardedPage(browser, viewport, async (page) => {
      await page.goto(urlOf('/navigation-button.html'), { waitUntil: 'load' });
      const attempts = await attemptPostNavigationAndFetch(page);
      expect(attempts).toEqual({ post: 'sent', fetch: 'sent' });
    });
    await expect.poll(() => window.count('GET', '/navigation-target.html')).toBeGreaterThan(0);
    expect(window.count('POST', '/__mutation')).toBe(1);
    expect(window.count('GET', '/popup-target.html')).toBe(1);
  });
});

/**
 * page から、POST（fetch）、読み取りの fetch（`/popup-target.html`）、メインフレームの移動（`/navigation-target.html`）を試みる。
 * fetch の結果（届いたか、失敗したか）を返す。移動は結果を待たず、`QUIET_PERIOD_MS` の後に戻る。
 */
async function attemptPostNavigationAndFetch(page: Page): Promise<{ readonly post: string; readonly fetch: string }> {
  const result = await page.evaluate(async () => {
    const outcome = (request: Promise<Response>): Promise<string> => request.then(() => 'sent', () => 'failed');
    const post = await outcome(fetch('/__mutation', { method: 'POST', body: 'gate' }));
    const read = await outcome(fetch('/popup-target.html'));
    return { post, fetch: read };
  });
  await page.evaluate(() => {
    location.href = '/navigation-target.html';
  }).catch(() => undefined);
  await wait(QUIET_PERIOD_MS);
  return result;
}

describe('GATE-S07: WebSockets during Interaction are blocked', () => {
  it('GATE-S07 Interaction: the WebSocket upgrade never reaches the server', async () => {
    const { window, result } = await auditGuardedInteraction('/websocket.html', 'Open WebSocket');

    expect(window.counters().webSocketUpgrade).toBe(0);
    expect(window.requestLines()).toEqual(['GET /websocket.html']);
    expect(result.status).toBe('BLOCKED_BY_SAFETY');
    expect(result.safety.blockedInteractionWebSockets.length).toBeGreaterThan(0);
  });

  it('GATE-S07 control: without the Guard, the same click delivers the WebSocket upgrade', async () => {
    await clickUnguarded('/websocket.html', 'Open WebSocket', (window) => window.counters().webSocketUpgrade > 0);
  });

  /**
   * DEF-040（設計書 `2026-10-08-beaksight-def-039-040-egress-design.md` 2.1.4、2.2。NP3）: 凍結の後に Worker の中で開く WebSocket の
   * 接続は、ページに差し込む方式の差し替え（`routeWebSocket`）を通らないが、Guard が文書と Worker の script に加える CSP
   * （`connect-src http: https: data: blob:`）が Worker の中で止めるので、サーバに届かない（Interaction の Context の出口の中継は、
   * その後ろで、凍結の後のすべての接続を拒む）。CSP が止めた接続は、Guard の page の session の `Log.entryAdded` の観察で、
   * `blockedInteractionWebSockets` に理由 `WORKER_CONNECT_POLICY` で残る（Dedicated Worker。best-effort の観察だが、blob の Worker では
   * 毎回残ることを NP3 で確かめた）。CSP が止めるので中継に CONNECT は来ず、`INTERACTION_FROZEN_EGRESS` の記録は残らない。
   */
  it('GATE-S07 Interaction: the WebSocket upgrade from inside a Worker never reaches the server, and is recorded as WORKER_CONNECT_POLICY (DEF-040)', async () => {
    const { window, result } = await auditGuardedInteraction(WORKER_WEBSOCKET_PAGE, WORKER_WEBSOCKET_BUTTON);

    expect(window.counters().webSocketUpgrade).toBe(0);
    expect(window.requestLines()).toEqual([`GET ${WORKER_WEBSOCKET_PAGE}`]);
    expect(window.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
    expect(result.safety.invariantViolations).toEqual([]);
    expect(result.status).toBe('BLOCKED_BY_SAFETY');
    expect(result.safety.blockedInteractionWebSockets.length).toBeGreaterThan(0);
    expect(result.safety.blockedInteractionWebSockets.every((entry) => (
      entry.url === urlOf('/socket').replace(/^http/, 'ws') && entry.reason === 'WORKER_CONNECT_POLICY'
    ))).toBe(true);
  });

  it('GATE-S07 control: without the Guard, the same click delivers the WebSocket upgrade from inside the Worker (DEF-040)', async () => {
    await clickUnguarded(WORKER_WEBSOCKET_PAGE, WORKER_WEBSOCKET_BUTTON, (window) => window.counters().webSocketUpgrade > 0);
  });

  /**
   * DEF-040 の Passive（設計書 2.2。NP3）: Passive の段階で、読み込みのときに Worker（blob、http の script、Shared、module、入れ子、srcdoc の
   * iframe）の中で開く WebSocket の接続も、同じ CSP で止まり、サーバに届かない。Dedicated の Worker は `blockedWebSockets` に理由
   * `WORKER_CONNECT_POLICY` で残る。Worker の script の GET は、今までどおり届く（Guard は script を止めず、応答にヘッダを加えるだけ）。
   * DEF-044（NP5）: テストの Chromium は Shared Worker を無効にして起動するので、Shared の場面は、Shared Worker が作れず（fixture が
   * `unavailable` を残す）、接続も script の GET も起きず、違反 0 であることを確かめる（`expectedWorkerWebSocketState`）。
   */
  it.each(WORKER_WEBSOCKET_KINDS)('GATE-S07 Passive: the WebSocket upgrade from inside the %s Worker never reaches the server, and Dedicated Workers are recorded as WORKER_CONNECT_POLICY (DEF-040)', async (kind) => {
    const recorded = RECORDED_WORKER_WEBSOCKET_KINDS.includes(kind);
    const { window, ledger } = await openGuardedPassivePage(
      workerWebSocketPassivePath(kind),
      async (page, pageLedger) => (await readWorkerWebSocketState(page)) === expectedWorkerWebSocketState(kind)
        && (!recorded || pageLedger.snapshot().blockedWebSockets.length > 0),
    );

    expect(window.counters().webSocketUpgrade).toBe(0);
    expect(window.requestLines()).toEqual([`GET ${WORKER_WEBSOCKET_PASSIVE_PAGE}`, ...workerWebSocketScriptRequestLines(kind)]);
    expect(window.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
    const snapshot = ledger.snapshot();
    expect(snapshot.invariantViolations).toEqual([]);
    if (recorded) {
      expect(snapshot.blockedWebSockets.length).toBeGreaterThan(0);
    }
    expect(snapshot.blockedWebSockets.every((entry) => (
      entry.url === urlOf('/socket').replace(/^http/, 'ws') && entry.reason === 'WORKER_CONNECT_POLICY'
    ))).toBe(true);
  });

  // DEF-044（NP5）: Shared の場面は、Guard がなくても Shared Worker を作れないので、Upgrade は届かない（Shared Worker の中の通信の対照は、
  // 引数を外した Chromium で行う。`gate-fixtures.test.ts`）。
  it.each(WORKER_WEBSOCKET_KINDS)('GATE-S07 control: without the Guard, the %s Worker delivers the WebSocket upgrade while the page loads, except the Shared Worker that cannot be created (DEF-040, DEF-044)', async (kind) => {
    const window = await openUnguardedWorkerWebSocketPage(browser, server, viewport, kind);

    if (UNAVAILABLE_WORKER_WEBSOCKET_KINDS.includes(kind)) {
      expect(window.counters().webSocketUpgrade).toBe(0);
    } else {
      expect(window.counters().webSocketUpgrade).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// GATE-S08: Service Worker
// ---------------------------------------------------------------------------------------------------------------

describe('GATE-S08: a Service Worker cannot bypass the blocking', () => {
  const path = '/service-worker-post.html';
  const workerPath = '/service-worker-post-worker.js';

  it('GATE-S08 Passive: the worker registered on load is never fetched and its POST never reaches the server', async () => {
    let registerCalls = 0;
    const { window } = await openGuardedPassivePage(path, async (page) => {
      // 登録の試み（`navigator.serviceWorker.register` の呼び出し）が、読み込みの時に起きたことを確かめる（R18 の M2）。
      registerCalls = await readServiceWorkerRegisterCalls(page);
      // Service Worker の登録がないことを、ページの読み込みの後に確かめる（登録の試みは、読み込みの時に行われる）。
      const registrations = await page.evaluate(async () => (
        navigator.serviceWorker === undefined ? 0 : (await navigator.serviceWorker.getRegistrations()).length
      ));
      return registerCalls > 0 && registrations === 0;
    }, { initScript: COUNT_SERVICE_WORKER_REGISTER_CALLS_SCRIPT });

    expect(registerCalls).toBe(1);
    expect(window.count(null, workerPath)).toBe(0);
    expect(window.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
    expect(window.requestLines()).toEqual([`GET ${path}`]);
  });

  it('GATE-S08 Interaction: clicking "Register posting worker" neither fetches the worker nor lets its POST reach the server', async () => {
    const observed: { registerCalls: number | null } = { registerCalls: null };
    const { window, result } = await auditGuardedInteraction(path, 'Register posting worker', {
      prepare: async (session) => {
        await session.page.addInitScript({ content: COUNT_SERVICE_WORKER_REGISTER_CALLS_SCRIPT });
      },
      beforeClose: async (session) => {
        observed.registerCalls = await readServiceWorkerRegisterCalls(session.page);
      },
    });

    // click は行われた（候補は、方針で拒否されていない。R18 の M2）。登録の試みは、読み込みの時と click の時の2回である。
    expect(result.status).not.toBe('REJECTED_UNSAFE');
    expect(observed.registerCalls).toBe(2);
    expect(window.count(null, workerPath)).toBe(0);
    expect(window.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
    expect(window.requestLines()).toEqual([`GET ${path}`]);
    expect(result.safety.invariantViolations).toEqual([]);
  });

  it('GATE-S08 control: without the Guard, the worker is fetched and its POST reaches the server', async () => {
    const window = openServerWindow(server);
    await withUnguardedPage(browser, viewport, async (page) => {
      await page.goto(urlOf(path), { waitUntil: 'load' });
      await expect.poll(() => window.count('POST', '/__mutation')).toBeGreaterThan(0);
    });
    expect(window.count('GET', workerPath)).toBeGreaterThan(0);
  });

  /**
   * DEF-049（設計書 `2026-10-08-beaksight-def-044-046-review-fixes-design.md` 5 と変更履歴の NP6 の Blocker の行）: Playwright の
   * `serviceWorkers: 'block'` は、`navigator.serviceWorker` のインスタンスの `register` を置き換えるだけなので、ページは
   * `ServiceWorkerContainer.prototype.register.call` や、インスタンスの `register` を `delete` した後の呼び出しで迂回できる。Guard の
   * 初期化のスクリプト（主）が、すべての frame の `ServiceWorkerContainer.prototype.register` を、例外を投げる関数に置き換えて固定するので、
   * 2 つの迂回は、ページの文書でも、同じ Origin の iframe でも、about:blank の iframe でも、例外になり、登録 0、Service Worker の script の
   * GET も POST も届かず、違反 0（factory の自己検査 `SERVICE_WORKER_OBSERVED` も出ない）。テストの既定の headless shell と、CLI の起動の
   * 設定（`chromiumLaunchOptions`）の両方で、Passive の Context と凍結の前の Interaction の session で確かめる。対照（Guard がなければ
   * 登録され、POST が届く）は `gate-fixtures.test.ts`。
   */
  describe.each([
    { name: 'the headless shell (test default)', launch: (): Promise<Browser> => launchHeadlessChromium() },
    { name: 'the CLI Chromium (chromiumLaunchOptions, headless)', launch: (): Promise<Browser> => chromium.launch(chromiumLaunchOptions({ headless: true })) },
  ])('GATE-S08 bypass of the instance override (DEF-049), with $name', ({ name, launch }) => {
    let bypassBrowser: Browser;
    let bypassFactory: BrowserContextFactory;

    beforeAll(async () => {
      bypassBrowser = await launch();
      bypassFactory = createGateFactory(bypassBrowser, server.origin);
    });

    afterAll(async () => {
      await bypassBrowser?.close();
    });

    it.each(SERVICE_WORKER_BYPASS_WAYS.flatMap((way) => SERVICE_WORKER_BYPASS_FRAMES.flatMap((where) => [
      { way, where, phase: 'Passive', open: () => openGuardedPassiveSession(bypassFactory, viewport) },
      { way, where, phase: 'Interaction (before the freeze)', open: () => openInteractionSessionBeforeFreeze(bypassFactory, viewport) },
    ])))('GATE-S08 $phase: the $way bypass in the $where frame throws, registers nothing, and neither the worker script nor its POST reaches the server, without a violation', async ({ way, where, phase, open }) => {
      const outcome = await openGuardedServiceWorkerBypassPage(open, server, way, where);
      console.info(`GATE-S08 DEF-049 ${name} ${phase} ${way} ${where}: ${JSON.stringify({
        state: outcome.state,
        registrations: outcome.registrations,
        workerScriptRequests: outcome.window.count(null, SERVICE_WORKER_BYPASS_WORKER_PATH),
        mutationPosts: outcome.window.count('POST', '/__mutation'),
        invariantViolations: outcome.invariantViolations,
      })}`);

      expect(outcome.state).toBe(`threw:${SERVICE_WORKER_REGISTRATION_BLOCKED_MESSAGE}`);
      expect(outcome.registrations).toBe(0);
      expect(outcome.window.count(null, SERVICE_WORKER_BYPASS_WORKER_PATH)).toBe(0);
      expect(outcome.window.count(null, '/__mutation')).toBe(0);
      expect(outcome.window.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
      expect(outcome.window.requestLines().filter((line) => line !== `GET ${BROWSER_DEFAULT_FAVICON_PATH}`))
        .toEqual(serviceWorkerBypassRequestLines(where));
      expect(outcome.invariantViolations).toEqual([]);
      expect(outcome.closeFailures).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// GATE-S09: 機密のヘッダ
// ---------------------------------------------------------------------------------------------------------------

/**
 * 同じプロセスの中で `runCli` を実行する（`runCliInProcess`。設定のファイルは `cliTargetConfig`）。Browser は `wrap` で差し替える。
 * 出力先には、Run のディレクトリが1つだけできる。
 */
async function runGateCli(
  name: string,
  startPath: string,
  wrap?: (real: Browser) => Browser,
  extra: Record<string, unknown> = {},
): Promise<CliRunOutcome> {
  const launcher = createRunLauncher(wrap);
  launchers.push(launcher);
  return await runCliInProcess({
    directory: workDirectory,
    name,
    config: cliTargetConfig(`safety-gate-${name}`, server.origin, startPath, extra),
    launchBrowser: launcher.launcher,
  });
}

describe('GATE-S09: sensitive headers never enter the written artifacts', () => {
  it('GATE-S09 CLI Run: no secret header value appears in run.json, audit.json, page.json, report.html or the bundle contents', async () => {
    const window = openServerWindow(server);

    const cliRun = await runGateCli('s09', '/__technical-redirect', undefined, { audit: { screenshots: true } });

    expect(cliRun.stderr).toBe('');
    expect(cliRun.code).toBe(exitCodeForRunStatus(cliRun.run.runStatus));
    const files = await readRunArtifactFiles(cliRun.runDirectory);
    const paths = files.map((file) => file.path);
    // BN1: バンドルの名前は、最後の実行の終わりの時刻（UTC）を含む（バンドルのファイル名の設計書 2.1）。
    const bundleName = bundleFileName(cliRun.run.executions[cliRun.run.executions.length - 1]?.finishedAt ?? '');
    expect(paths).toEqual(expect.arrayContaining([
      RUN_ARTIFACT_FILE_NAMES.run,
      RUN_ARTIFACT_FILE_NAMES.audit,
      RUN_ARTIFACT_FILE_NAMES.report,
      bundleName,
      `${bundleName}!/run.json`,
    ]));
    const pageJsonFiles = files.filter(isPageJsonArtifact);
    expect(pageJsonFiles.length).toBeGreaterThan(0);
    expect(paths.filter((path) => path.startsWith(`${bundleName}!/`)).length).toBeGreaterThan(1);

    // Gate: 秘密の値は、書き出したどのファイル（ZIP は展開した中身）にもない。
    expect(findTextOccurrences(files, FIXTURE_SECRET_VALUES)).toEqual([]);

    // 対照 1: その Run のリクエストとレスポンスに、秘密の値のヘッダが実際にあった。
    // - Run は、秘密のヘッダを返す2つの URL を読んだ。
    expect(window.count('GET', '/__technical-redirect')).toBeGreaterThan(0);
    expect(window.count('GET', '/__broken-image.png')).toBeGreaterThan(0);
    // - 302 の応答の `Set-Cookie`（redirect-secret）が、その後のリクエストの `Cookie` として届いた。
    expect(window.observations().some((entry) => entry.cookie?.includes('redirect-secret') === true)).toBe(true);
    // - 書き出した Evidence は、そのヘッダを観測し、値を伏せ字にしている（ヘッダが記録の対象になった上で、値が消されている）。
    const pageJsonText = pageJsonFiles.map((file) => Buffer.from(file.bytes).toString('utf8')).join('\n');
    expect(pageJsonText).toMatch(new RegExp(`"x-api-key":\\s*"${escapeRegExp(REDACTED)}"`, 'u'));
    expect(pageJsonText).toMatch(new RegExp(`"set-cookie":\\s*"${escapeRegExp(REDACTED)}"`, 'u'));
    expect(pageJsonText).toMatch(new RegExp(`"cookie":\\s*"${escapeRegExp(REDACTED)}"`, 'u'));

    // 対照 2: fixture のサーバの応答は、秘密の値そのものを持つ（Run の後に、Node から直接読んで確かめる）。
    const redirect = await fetch(urlOf('/__technical-redirect'), { redirect: 'manual' });
    expect(redirect.headers.get('set-cookie')).toContain('redirect-secret');
    expect(redirect.headers.get('x-unselected-secret')).toBe('must-not-enter-evidence');
    const image = await fetch(urlOf('/__broken-image.png'));
    expect(image.headers.get('x-api-key')).toBe('fixture-response-secret');
    await Promise.all([redirect.body?.cancel(), image.body?.cancel()]);
  }, RUN_TEST_TIMEOUT_MS);
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

// ---------------------------------------------------------------------------------------------------------------
// GATE-S10: Guard の初期化の失敗
// ---------------------------------------------------------------------------------------------------------------

describe('GATE-S10: when the Guard cannot be initialized, the target site is never touched', () => {
  /** Run Coordinator を、実際の Chromium（`wrap` で差し替える）で実行する。 */
  async function runCoordinator(
    wrap: (real: Browser) => Browser,
    config: AuditConfig = fastRunConfig(server.origin, '/short-content.html'),
  ): Promise<{ readonly result: AuditRunResult; readonly launcher: RunLauncher }> {
    const launcher = createRunLauncher(wrap);
    launchers.push(launcher);
    const outputDirectory = await mkdtemp(join(workDirectory, 'coordinator-'));
    return { result: await runWithCoordinator({ config, launchBrowser: launcher.launcher, outputDirectory }), launcher };
  }

  const expectNoRequestAtAll = (window: ServerWindow): void => {
    expect(window.observations()).toEqual([]);
    expect(Object.values(window.counters()).every((value) => value === 0)).toBe(true);
  };

  it('GATE-S10 Run Coordinator: a Guard installation failure with a violation is ABORTED_BY_SAFETY and no request reaches the server', async () => {
    const window = openServerWindow(server);

    const { result, launcher } = await runCoordinator((real) => browserOpeningPageAfterNewContext(real));

    expectNoRequestAtAll(window);
    expect(result.run.runStatus).toBe('ABORTED_BY_SAFETY');
    expect(result.run.incompleteReasons).toContainEqual({ code: 'PREFLIGHT_FAILED', detail: 'PASSIVE_GUARD' });
    expect(result.run.safety.invariantViolations.map((violation) => violation.code)).toContain('GUARD_INSTALLATION_FAILED');
    expect(result.pages.every((page) => page.status !== 'AUDITED')).toBe(true);
    expect(launcher.browsers.every((real) => !real.isConnected())).toBe(true);
  }, RUN_TEST_TIMEOUT_MS);

  it('GATE-S10 Run Coordinator: a Context creation failure without a violation is FAILED and no request reaches the server', async () => {
    const window = openServerWindow(server);

    const { result, launcher } = await runCoordinator((real) => browserFailingNewContext(real));

    expectNoRequestAtAll(window);
    expect(result.run.runStatus).toBe('FAILED');
    expect(result.run.incompleteReasons).toContainEqual({ code: 'PREFLIGHT_FAILED', detail: 'PASSIVE_GUARD' });
    expect(result.run.safety.invariantViolationCount).toBe(0);
    expect(launcher.browsers.every((real) => !real.isConnected())).toBe(true);
  }, RUN_TEST_TIMEOUT_MS);

  it('GATE-S10 CLI: a Guard installation failure ends with ABORTED_BY_SAFETY and exit code 3, with no request to the server', async () => {
    const window = openServerWindow(server);

    const cliRun = await runGateCli('s10-aborted', '/short-content.html', (real) => browserOpeningPageAfterNewContext(real));

    // 終了コード 3 を、同じプロセスの中の `runCli` で最後まで通す（設計書 4.2）。GET も、それ以外のリクエストも、0件である。
    expectNoRequestAtAll(window);
    expect(cliRun.run.runStatus).toBe('ABORTED_BY_SAFETY');
    expect(cliRun.code).toBe(EXIT_CODES.ABORTED_BY_SAFETY);
    expect(cliRun.code).toBe(3);
    expect(cliRun.stderr).toBe('');
    expect(cliRun.run.safety.invariantViolations.map((violation) => violation.code)).toContain('GUARD_INSTALLATION_FAILED');
  }, RUN_TEST_TIMEOUT_MS);

  it('GATE-S10 CLI: a Context creation failure without a violation ends with FAILED and exit code 1, with no request to the server', async () => {
    const window = openServerWindow(server);

    const cliRun = await runGateCli('s10-failed', '/short-content.html', (real) => browserFailingNewContext(real));

    expectNoRequestAtAll(window);
    expect(cliRun.run.runStatus).toBe('FAILED');
    expect(cliRun.code).toBe(EXIT_CODES.FAILED);
    expect(cliRun.run.safety.invariantViolationCount).toBe(0);
  }, RUN_TEST_TIMEOUT_MS);

  it('GATE-S10 control: with an unmodified Browser, the same CLI Run reaches the server and exits with the code of its Run Status', async () => {
    const window = openServerWindow(server);

    const cliRun = await runGateCli('s10-control', '/short-content.html', undefined, { audit: { screenshots: false } });

    expect(window.count('GET', '/short-content.html')).toBeGreaterThan(0);
    expect(cliRun.run.runStatus).not.toBe('ABORTED_BY_SAFETY');
    expect(cliRun.code).toBe(exitCodeForRunStatus(cliRun.run.runStatus));
    expect(window.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
  }, RUN_TEST_TIMEOUT_MS);
});
