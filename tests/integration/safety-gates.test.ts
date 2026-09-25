// T18b: Safety の Gate（GATE-S01〜S10。Task 18 の設計書 4.2、実装タスク指示 第11章）。
// どの Gate も、fixture のサーバの側で「届かなかった」ことを数えて確かめる（`openServerWindow` の差分。Ledger の記録は補助の確認）。
// 各 Gate には、対照の確認（Guard のない Context では、同じ操作がサーバに届くこと）を置き、確認が空振りしないことを示す。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { BrowserContextFactory, type InteractionGuardedSession } from '../../src/browser/context-factory.js';
import { EXIT_CODES, exitCodeForRunStatus } from '../../src/cli/exit-codes.js';
import type { AuditConfig, Viewport } from '../../src/config/types.js';
import { RUN_ARTIFACT_FILE_NAMES } from '../../src/core/artifact-layout.js';
import type { AuditRunResult } from '../../src/core/contracts.js';
import { wait } from '../../src/core/deadline.js';
import { REDACTED } from '../../src/core/redaction.js';
import {
  auditInteraction,
  InteractionOwnerCleanupError,
  type InteractionAuditResult,
} from '../../src/interaction/isolated-auditor.js';
import { isPassiveRequestGuardClosed } from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { browserOpeningPageAfterNewContext } from '../helpers/browser-opening-page.js';
import { browserFailingNewContext, browserStallingContextClose } from '../helpers/browser-proxies.js';
import { launchHeadlessChromium, oopifTargetUrls, SITE_PER_PROCESS_ARGS, useHeadlessChromium } from '../helpers/chromium.js';
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
  safetyExternalSchemeNavigations,
  SELF_NAVIGATING_FRAME_PAGE,
  selfNavigatingFramePath,
  stoppedRedirectRecord,
  type ExternalSchemeKey,
} from '../helpers/external-scheme-fixture.js';
import {
  createModeFactories,
  discoverInteractionCandidate,
  factoryModeCases,
  interactionAuditInput,
  NO_NON_READ_REQUESTS,
  openServerWindow,
  QUIET_PERIOD_MS,
  withGuardedPassivePage,
  withUnguardedPage,
  type FactoryMode,
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
import { createTestConfig } from '../helpers/test-config.js';

const viewport: Viewport = Object.freeze({ width: 900, height: 700 });
/** 実際の Run（Run Coordinator と CLI）のテストの上限。 */
const RUN_TEST_TIMEOUT_MS = 120_000;
/** 凍結を待つ上限として注入する、短い期限（ms。製品の既定 `CONTEXT_CLOSE_TIMEOUT_MS` を待たない）。 */
const SHORT_FREEZE_TIMEOUT_MS = 300;

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
let factories: Readonly<Record<FactoryMode, BrowserContextFactory>>;
let factory: BrowserContextFactory;
let headedFactory: BrowserContextFactory;
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
  // GATE-S03（C18b）: headless のブラウザのまま、設定だけを headed にする factory も作る（Guard に「headed である」と注入する）。
  // 実際の headed のブラウザは、起動しない（外部のアプリが起動するおそれがあるため）。
  factories = createModeFactories(browser, server.origin);
  factory = factories.headless;
  headedFactory = factories['headed (injected)'];
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
// 移動の試みは、Guard が Safety Ledger の `externalSchemeNavigations` に記録する。headless では違反にせず、page はその場に留まる。
// headed では違反として Context を閉じる。数え方は、ほかの Gate と同じく、サーバの境界の差分である（Ledger は記録の確認）。
// 対照の確認（Guard のない Context で、同じ fixture が、その外部スキームの URL への移動のリクエストを出す）は、
// `tests/integration/gate-fixtures.test.ts` の C18b に置く。
// 厳守事項: Chromium は headless だけで起動する。headed の扱いは、設定の注入（`headedFactory`）だけで確かめる。宛先は実在しない。

/** ボタンのページで、ボタンを押す（`button-click` の経路の Passive の段階）。 */
const clickExternalSchemeButton = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: EXTERNAL_SCHEME_BUTTON_NAME }).click();
};

describe('GATE-S03: navigations to external schemes by the page are recorded, and nothing but the page reaches the server', () => {
  const cases = EXTERNAL_SCHEME_ROUTES.flatMap((route) => EXTERNAL_SCHEME_KEYS.map((key) => [route, key] as const));

  it.each(cases)('GATE-S03 Passive (headless): %s to %s is recorded without a violation, the page stays, and only its GET reaches the server', async (
    route,
    key,
  ) => {
    const path = externalSchemeFixturePath(route, key);

    const { window, ledger, pageUrl, guardClosed } = await openGuardedPassivePage(
      path,
      async (_page, pageLedger) => pageLedger.snapshot().externalSchemeNavigations.length > 0,
      route === 'button-click' ? { act: clickExternalSchemeButton } : {},
    );

    // 補助の確認（RC18a の指摘4）: 「サーバには、そのページへの GET だけが届く」と「page の URL は変わらない」は、Guard がなくても
    // 同じ結果になる（外部スキームはネットワークを通らず、headless のブラウザは外部スキームへ移動しない）。Guard の働きを
    // 見分けているのは、下の Ledger の記録の確認である。
    // サーバには、そのページへの GET だけが届く。
    expect(window.requestLines()).toEqual([`GET ${externalSchemeFixturePathname(route)}`]);
    expectOnlyReadRequests(window.counters(), window.observations());
    // page の URL は変わらない。
    expect(pageUrl).toBe(urlOf(path));
    // Ledger に、そのスキームと経路の記録がある（Guard の働きを見分ける確認）。headless では、違反にせず、Context も閉じない。
    const snapshot = ledger.snapshot();
    expect(snapshot.externalSchemeNavigations).toEqual([externalSchemeAttemptRecord(route, key, 'PASSIVE')]);
    expect(snapshot.invariantViolations).toEqual([]);
    expect(guardClosed).toBe(false);
  });

  it.each(EXTERNAL_SCHEME_KEYS)('GATE-S03 Interaction (headless): the clicked button that navigates to %s is recorded, the result is BLOCKED_BY_SAFETY, and only the page GET reaches the server', async (
    key,
  ) => {
    const path = externalSchemeFixturePath('button-click', key);
    const observed: { clicks: number | null; pageUrl: string | null } = { clicks: null, pageUrl: null };

    const { window, result } = await auditGuardedInteraction(path, EXTERNAL_SCHEME_BUTTON_NAME, {
      prepare: async (session) => {
        await session.page.addInitScript({ content: COUNT_CLICKS_SCRIPT });
      },
      beforeClose: async (session) => {
        observed.pageUrl = session.page.url();
        observed.clicks = await session.page.evaluate(() => (globalThis as { __gateClicks?: number }).__gateClicks ?? -1);
      },
    });

    // click は行われた（候補は、方針で拒否されていない）。
    expect(result.status).not.toBe('REJECTED_UNSAFE');
    expect(observed.clicks).toBe(1);
    // 凍結の後の外部スキームへの移動の試みとして記録され、結果は BLOCKED_BY_SAFETY になる。headless では違反にしない。
    expect(result.safety.externalSchemeNavigations).toEqual([externalSchemeAttemptRecord('button-click', key, 'INTERACTION')]);
    expect(result.status).toBe('BLOCKED_BY_SAFETY');
    expect(result.safety.invariantViolations).toEqual([]);
    // page の URL は変わらず、サーバには、そのページへの GET だけが届く。
    expect(observed.pageUrl).toBe(urlOf(path));
    expect(window.requestLines()).toEqual([`GET ${EXTERNAL_SCHEME_BUTTON_PAGE}`]);
    expectOnlyReadRequests(window.counters(), window.observations());
  });

  it.each(EXTERNAL_SCHEME_KEYS)('GATE-S03 Passive (headed injected into a headless browser): location-href to %s records EXTERNAL_SCHEME_NAVIGATION_IN_HEADED_MODE and closes the Context', async (
    key,
  ) => {
    const path = externalSchemeFixturePath('location-href', key);

    const { window, ledger, guardClosed } = await openGuardedPassivePage(
      path,
      async (page) => isPassiveRequestGuardClosed(page.context()),
      { factory: headedFactory },
    );

    expect(guardClosed).toBe(true);
    const snapshot = ledger.snapshot();
    expect(snapshot.externalSchemeNavigations).toEqual([externalSchemeAttemptRecord('location-href', key, 'PASSIVE')]);
    expect(snapshot.invariantViolations).toEqual([
      expect.objectContaining({ code: 'EXTERNAL_SCHEME_NAVIGATION_IN_HEADED_MODE' }),
    ]);
    expect(window.requestLines()).toEqual([`GET ${EXTERNAL_SCHEME_NAVIGATION_PAGE}`]);
    expect(window.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
  });

  it('GATE-S03 CLI Run (headless): the Safety Evidence of the written page.json keeps the external scheme navigation, and the Run is not ABORTED_BY_SAFETY', async () => {
    const route = 'location-href';
    const key = 'mailto';
    const window = openServerWindow(server);

    // 開始の URL のクエリ（経路とスキームの選択）を、クロールの正規化で落とさないように、許可するクエリの名前を指定する。
    const cliRun = await runGateCli('s03-external-scheme', externalSchemeFixturePath(route, key), undefined, {
      audit: { screenshots: false },
      crawl: { allowedQueryParameters: ['to', 'via'] },
    });

    expect(cliRun.stderr).toBe('');
    expect(cliRun.run.runStatus).not.toBe('ABORTED_BY_SAFETY');
    expect(cliRun.code).toBe(exitCodeForRunStatus(cliRun.run.runStatus));
    expect(cliRun.run.safety.invariantViolationCount).toBe(0);
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
// `EXTERNAL_SCHEME_REDIRECT_BLOCKED` で記録する。止めて防げる経路なので、headed（設定の注入）でも違反にしない。
// 対照の確認（Guard のない Context では、同じ fixture がリダイレクトをたどり、外部スキームへの `request` の事象（`redirectedFrom`
// 付き）が来ること）は、`tests/integration/gate-fixtures.test.ts` の C18g に置く。RC18a の再現（`probe3-frame.log`）では、
// Run の artifact の記録が0件だった。
describe('GATE-S03: server redirects to external schemes are stopped before they are followed, and recorded', () => {
  const cases = factoryModeCases(EXTERNAL_SCHEME_KEYS);

  it.each(cases)('GATE-S03 Passive (%s): the iframe redirect to %s is stopped and recorded without a violation; only the page and the redirect source reach the server', async (
    mode,
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
      { factory: factories[mode] },
    );

    // Guard の働きを見分ける確認: Ledger に、止めた記録がある。headless でも headed でも、違反にせず、Context も閉じない。
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

  it.each(cases)('GATE-S03 Passive (%s): the main frame redirect to %s is stopped and recorded without a violation; the navigation fails and only the redirect source reaches the server', async (
    mode,
    key,
  ) => {
    const passiveFactory = factories[mode];
    await withGuardedPassivePage(passiveFactory, viewport, async (page, context, ledger) => {
      const window = openServerWindow(server);

      const navigation = await page.goto(urlOf(externalSchemeRedirectPath(key))).then(() => 'RESOLVED', () => 'REJECTED');
      await expect.poll(() => ledger.snapshot().externalSchemeNavigations.length).toBeGreaterThan(0);
      await wait(QUIET_PERIOD_MS);

      expect(navigation).toBe('REJECTED');
      const snapshot = ledger.snapshot();
      expect(snapshot.externalSchemeNavigations).toEqual([stoppedRedirectRecord(key, 'MAIN')]);
      // RC18a の指摘3（設計者の判断）: Guard 自身が止めた main frame のリクエストの失敗は、予期した失敗なので、
      // `HTTP_MAIN_FRAME_DELIVERY_FAILED` の違反にしない。headed でも違反は0件で、Context も閉じない。
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
      crawl: { allowedQueryParameters: ['to'] },
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
      crawl: { allowedQueryParameters: ['to'] },
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
  const cases = factoryModeCases(EXTERNAL_SCHEME_KEYS);

  let isolatedBrowser: Browser | undefined;
  let isolatedFactories: Readonly<Record<FactoryMode, BrowserContextFactory>>;

  beforeAll(async () => {
    // headless だけで起動する。`--site-per-process` は、別のサイトの iframe を別のプロセスにする（サイトの分離を強める側の引数）。
    const launched = await launchHeadlessChromium({ args: SITE_PER_PROCESS_ARGS });
    isolatedBrowser = launched;
    isolatedFactories = createModeFactories(launched, server.origin);
  });

  afterAll(async () => {
    await isolatedBrowser?.close();
  });

  it.each(cases)('GATE-S03 Passive OOPIF (%s): the redirect to %s started by the OOPIF is stopped and recorded without a violation; only the pages and the redirect source reach the server', async (
    mode,
    key,
  ) => {
    const passiveFactory = isolatedFactories[mode];
    const crossSiteOrigin = crossSiteOriginOf(server.origin);
    const path = crossSiteFramePath(selfNavigatingFramePath(key));
    await withGuardedPassivePage(passiveFactory, viewport, async (page, context, ledger) => {
      const window = openServerWindow(server);

      await page.goto(urlOf(path), { waitUntil: 'load' });
      await expect.poll(() => ledger.snapshot().externalSchemeNavigations.length).toBeGreaterThan(0);
      await wait(QUIET_PERIOD_MS);

      // Guard の働きを見分ける確認: 移動は OOPIF の中で始まり、Ledger に止めた記録がある。headless でも headed でも、違反にしない。
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
    const passiveFactory = isolatedFactories.headless;
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
    const session = await isolatedFactories.headless.createInteractionSession(viewport);
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
    const stalledFactory = new BrowserContextFactory(stalling.browser, createTestConfig(server.origin), () => new SafetyLedger());
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
    expect(paths).toEqual(expect.arrayContaining([
      RUN_ARTIFACT_FILE_NAMES.run,
      RUN_ARTIFACT_FILE_NAMES.audit,
      RUN_ARTIFACT_FILE_NAMES.report,
      RUN_ARTIFACT_FILE_NAMES.bundle,
      `${RUN_ARTIFACT_FILE_NAMES.bundle}!/run.json`,
    ]));
    const pageJsonFiles = files.filter(isPageJsonArtifact);
    expect(pageJsonFiles.length).toBeGreaterThan(0);
    expect(paths.filter((path) => path.startsWith(`${RUN_ARTIFACT_FILE_NAMES.bundle}!/`)).length).toBeGreaterThan(1);

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
