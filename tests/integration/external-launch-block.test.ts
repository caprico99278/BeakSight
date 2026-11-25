// EL-12（設計書 `2026-10-24-beaksight-external-launch-block-design.md` 3.3〜3.5・5 章。DEF-171）: 外部スキームへの移動を、Guard を付けた Context
// （Passive と、凍結の後の Interaction）が、両方の Chromium（テストの既定の headless shell と、本番と同じ起動の部品の CLI の Chromium）で 1 回だけ記録する
// ことを確かめる（SAFE-2 の 4 から、違反にせず、Context も閉じない）。CLI の Chromium は一時のプロファイルの設定で移動そのものを止め（OS のアプリへ渡さない）、
// Guard は CDP の事象で検出する。
// - 経路: BeakSight の goto、`location.href`、click、iframe、302 の main と frame、`window.open`、`a target=_blank`、`form target=_blank`、OOPIF の
//   スクリプトの移動。
// - CLI の Chromium では、設定が効いていること（守りのない Context の、登録のない独自のスキームへの移動が `ERR_BLOCKED_BY_ADMINISTRATOR` になる）と、
//   自己検査の合格と不合格（Preferences を置かない起動で `EXTERNAL_LAUNCH_BLOCK_UNAVAILABLE`）も確かめる。
//
// 厳守事項: Chromium は headless だけで起動する。外部スキームの宛先は、実在しないもの（`fixtures/external-scheme-targets.ts`）だけ。守りのない Context で
// 移動させるのは、設定ありの CLI の Chromium の、登録のない独自のスキーム（`custom`）だけ（設定なしの Chromium に `mailto:` などを流さない。EL-0 の手違い）。
// 例外（PRN）: 印刷の画面の場面だけは、設定ありの CLI の Chromium を headed で起動する（headless では印刷がもともと何もしないため）。外部スキームへは移らない。
import { existsSync } from 'node:fs';
import type { Browser, LaunchOptions, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import {
  chromiumLaunchOptions,
  EXTERNAL_LAUNCH_BLOCKED_ERROR_TEXT,
  isChromiumLaunchRefused,
  launchChromiumWith,
  PRODUCTION_CHROMIUM_LAUNCH_DEPENDENCIES,
  type ChromiumLaunchDependencies,
} from '../../src/browser/chromium-launch.js';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { Viewport } from '../../src/config/types.js';
import { wait } from '../../src/core/deadline.js';
import { CHROMIUM_PDF_VIEWER_EXTENSION_ID, type ExternalSchemeNavigationEvent } from '../../src/core/evidence-types.js';
import { isPassiveRequestGuardClosed, WriteStageMonitor } from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import {
  chromiumRunsOf,
  launchCliChromium,
  launchTestDefaultChromium,
  SITE_PER_PROCESS_ARGS,
  testContextsOf,
} from '../helpers/chromium.js';
import { withTestOnlyNoInternetArgs } from '../helpers/test-chromium-args.js';
import {
  crossSiteFramePath,
  EXTERNAL_SCHEME_TARGETS,
  externalSchemeFixturePath,
  externalSchemeRedirectFramePath,
  externalSchemeRedirectPath,
  NAVIGATION_TARGET_PAGE,
  stoppedRedirectRecord,
  type ExternalSchemeKey,
} from '../helpers/external-scheme-fixture.js';
import { createGateFactory, QUIET_PERIOD_MS, withGuardedPassivePage } from '../helpers/gate-harness.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { createTestConfig, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

const viewport: Viewport = Object.freeze({ width: 800, height: 600 });
const KEY: ExternalSchemeKey = 'mailto';

/** ページのスクリプトで移動を試みる経路（凍結の前後で同じ）。`frame` は記録の frame（`null` は popup で、frame の種類が分からない）。 */
const SCRIPT_ROUTES = Object.freeze([
  { name: 'location.href', frame: 'MAIN', run: (target: string) => { window.location.href = target; } },
  {
    name: 'an anchor click',
    frame: 'MAIN',
    run: (target: string) => {
      const anchor = document.createElement('a');
      anchor.href = target;
      document.body.append(anchor);
      anchor.click();
    },
  },
  {
    name: 'an iframe',
    frame: 'SUB',
    run: (target: string) => {
      const frame = document.createElement('iframe');
      frame.src = target;
      document.body.append(frame);
    },
  },
  { name: 'window.open', frame: null, run: (target: string) => { window.open(target); } },
  {
    name: 'an anchor with target _blank',
    frame: null,
    run: (target: string) => {
      const anchor = document.createElement('a');
      anchor.href = target;
      anchor.target = '_blank';
      document.body.append(anchor);
      anchor.click();
    },
  },
  {
    name: 'a form with target _blank',
    frame: null,
    run: (target: string) => {
      const form = document.createElement('form');
      form.method = 'get';
      form.action = target;
      form.target = '_blank';
      document.body.append(form);
      form.submit();
    },
  },
] as const);

/** 経路の移動の記録の URL（form の GET の送信は、空のクエリの `?` が付く）。 */
const recordedUrlOf = (name: string, url: string): string => (name === 'a form with target _blank' ? `${url}?` : url);

/** popup の移動の記録（frame の種類が分からないので、frame の判定の失敗の記録 `frameClassificationFailures` に残る）に、`url` があるか。 */
const frameFailureRecorded = (ledger: SafetyLedger, url: string): boolean =>
  ledger.snapshot().frameClassificationFailures?.events.some((event) => event.url === url) ?? false;

/**
 * 移動の試みが記録されたことを確かめる。SAFE-2 の 4（違反の区分の (3)。設計者の判断）: 前は、違反（`EXTERNAL_SCHEME_NAVIGATION_ATTEMPTED`・
 * `FRAME_CLASSIFICATION_FAILED`）を記録して Context を閉じた。今は、記録だけを残す（外から見える結果は記録）。`expected` が `null` の popup は、frame の判定の失敗の
 * 記録（`popupUrl`）に残り、外部スキームの記録はない。ほかは、外部スキームの記録が `expected` の 1 件だけ。
 */
async function expectRecordedOnce(
  ledger: SafetyLedger,
  expected: ExternalSchemeNavigationEvent | null,
  popupUrl: string = EXTERNAL_SCHEME_TARGETS[KEY].url,
): Promise<void> {
  if (expected === null) {
    await expect.poll(() => frameFailureRecorded(ledger, popupUrl)).toBe(true);
    await wait(QUIET_PERIOD_MS);
    expect(ledger.snapshot().externalSchemeNavigations).toEqual([]);
    return;
  }
  await expect.poll(() => ledger.snapshot().externalSchemeNavigations.length).toBeGreaterThan(0);
  await wait(QUIET_PERIOD_MS);
  expect(ledger.snapshot().externalSchemeNavigations).toEqual([expected]);
}

/** 移動を試みる（Guard が先に閉じると `evaluate` が失敗することがあるので、その失敗は受ける）。 */
const attempt = (page: Page, run: (target: string) => void, target: string): Promise<void> =>
  page.evaluate(run, target).catch(() => undefined);

let server: FixtureServer;
/** EL-F: PDF の頁を返すサーバ（fixture のサーバに PDF の頁がないため）。 */
let pdfServer: LoopbackHttpServer;
/** 1 ページの小さな PDF。 */
const PDF_BYTES = Buffer.from('%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
/** PDF の表示の拡張の frame ができるのを待つ時間（ms）。 */
const PDF_SETTLE_MS = 1_500;

beforeAll(async () => {
  server = await startFixtureServer();
  pdfServer = await startLoopbackHttpServer((request, response) => {
    if (request.url === '/pdf') {
      response.writeHead(200, { 'content-type': 'application/pdf' });
      response.end(PDF_BYTES);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(request.url === '/pdf-frame'
      ? '<!doctype html><title>pdf frame</title><iframe src="/pdf"></iframe><embed src="/pdf" type="application/pdf">'
      : '<!doctype html><title>pdf home</title><p>home</p>');
  });
});

afterAll(async () => {
  await pdfServer?.close();
  await server?.close();
});

describe.each(chromiumRunsOf([
  { kind: 'the headless shell (test default)', cli: false, launch: () => launchTestDefaultChromium({ args: SITE_PER_PROCESS_ARGS }) },
  { kind: 'the CLI Chromium (the launch component)', cli: true, launch: () => launchCliChromium({ args: SITE_PER_PROCESS_ARGS }) },
]))('EL-12: the Guard records an external scheme navigation once (SAFE-2: without closing the Context), with $kind', ({ cli, launch }) => {
  let browser: Browser;
  let factory: BrowserContextFactory;
  const pageUrl = (): string => `${server.origin}${NAVIGATION_TARGET_PAGE}`;
  const { url: targetUrl, scheme } = EXTERNAL_SCHEME_TARGETS[KEY];

  beforeAll(async () => {
    browser = await launch();
    factory = createGateFactory(browser, server.origin);
  });

  afterAll(async () => {
    await browser?.close();
  });

  it.each(SCRIPT_ROUTES)('Passive: $name', async ({ name, frame, run }) => {
    await withGuardedPassivePage(factory, viewport, async (page, _context, ledger) => {
      await page.goto(pageUrl(), { waitUntil: 'load' });
      await attempt(page, run, targetUrl);
      await expectRecordedOnce(ledger, frame === null ? null : {
        url: recordedUrlOf(name, targetUrl), scheme, frame, phase: 'PASSIVE', reason: 'EXTERNAL_SCHEME_NAVIGATION',
      }, recordedUrlOf(name, targetUrl));
    });
  });

  it.each(SCRIPT_ROUTES)('Interaction (after the freeze): $name', async ({ name, frame, run }) => {
    const session = await factory.createInteractionSession(viewport);
    try {
      await session.page.goto(pageUrl(), { waitUntil: 'load' });
      await session.activateInteractionFreeze();
      await attempt(session.page, run, targetUrl);
      await expectRecordedOnce(session.ledger, frame === null ? null : {
        url: recordedUrlOf(name, targetUrl), scheme, frame, phase: 'INTERACTION', reason: 'EXTERNAL_SCHEME_NAVIGATION',
      }, recordedUrlOf(name, targetUrl));
    } finally {
      if (!session.isClosed()) await session.close().catch(() => undefined);
    }
  });

  // EL-F（EL-R の I1）: 凍結の後に開いたポップアップ（Guard の page の準備を付けない頁）を、`about:blank` で開いてから外部スキームへ移す。opener の
  // `Page.windowOpen` は `about:blank` で、設定ありの Chromium では `request` も来ないので、直す前は記録 0 だった。宛先は登録のない独自のスキーム。
  it('Interaction (after the freeze): a popup opened as about:blank and then sent to the external scheme is recorded once', async () => {
    const session = await factory.createInteractionSession(viewport);
    const custom = EXTERNAL_SCHEME_TARGETS.custom;
    try {
      await session.page.goto(pageUrl(), { waitUntil: 'load' });
      await session.activateInteractionFreeze();
      await session.page.evaluate((target) => {
        const opened = window.open('about:blank');
        setTimeout(() => {
          if (opened !== null) opened.location.href = target;
        }, 300);
      }, custom.url).catch(() => undefined);
      await expectRecordedOnce(session.ledger,
        { url: custom.url, scheme: custom.scheme, frame: 'MAIN', phase: 'INTERACTION', reason: 'EXTERNAL_SCHEME_NAVIGATION' });
    } finally {
      if (!session.isClosed()) await session.close().catch(() => undefined);
    }
  });

  // EL-F2（EL-R2 の N1）: `w = window.open('about:blank'); w.location.href = '<外部スキーム>'` を待たずに続ける形。ポップアップの移動は、Guard がそのポップアップに
  // CDP の session を付ける前に、設定が止めたエラーの頁として終わる（直す前は、CLI の Chromium のどの Context でも記録 0）。Guard は、付けた時点の frame の
  // `unreachableUrl` から拾う。6 つの Context（Passive、Interaction の凍結の前と後、ログインの段の手動と自動、書き込みの段）。宛先は登録のない独自のスキーム。
  const syncPopupAssign = (page: Page, target: string): Promise<void> => page.evaluate((url) => {
    const opened = window.open('about:blank');
    if (opened !== null) opened.location.href = url;
  }, target).catch(() => undefined);

  /** ポップアップの移動の記録が 1 回だけあること（SAFE-2 の 4 から、違反にせず、Context も閉じない）。 */
  const expectSyncPopupRecorded = async (ledger: SafetyLedger, phase: ExternalSchemeNavigationEvent['phase']): Promise<void> => {
    const custom = EXTERNAL_SCHEME_TARGETS.custom;
    await expectRecordedOnce(ledger, { url: custom.url, scheme: custom.scheme, frame: 'MAIN', phase, reason: 'EXTERNAL_SCHEME_NAVIGATION' });
  };

  it('Passive: a popup sent to the external scheme right after window.open is recorded once', async () => {
    await withGuardedPassivePage(factory, viewport, async (page, _context, ledger) => {
      await page.goto(pageUrl(), { waitUntil: 'load' });
      await syncPopupAssign(page, EXTERNAL_SCHEME_TARGETS.custom.url);
      await expectSyncPopupRecorded(ledger, 'PASSIVE');
    });
  });

  it.each([
    ['before the freeze', false, 'PASSIVE'],
    ['after the freeze', true, 'INTERACTION'],
  ] as const)('Interaction (%s): a popup sent to the external scheme right after window.open is recorded once', async (_label, frozen, phase) => {
    const session = await factory.createInteractionSession(viewport);
    try {
      await session.page.goto(pageUrl(), { waitUntil: 'load' });
      if (frozen) await session.activateInteractionFreeze();
      await syncPopupAssign(session.page, EXTERNAL_SCHEME_TARGETS.custom.url);
      await expectSyncPopupRecorded(session.ledger, phase);
    } finally {
      if (!session.isClosed()) await session.close().catch(() => undefined);
    }
  });

  it.each([
    ['the manual login stage', true],
    ['the automated login stage', false],
  ] as const)('%s: a popup sent to the external scheme right after window.open is recorded once', async (_label, manual) => {
    const context = await factory.createLoginStageContext(viewport, {
      loginPostEndpoints: [{ origin: server.origin, path: '/login' }],
      maxLoginPosts: 1,
      ...(manual ? { manualPassThrough: true as const } : {}),
    });
    try {
      const page = await factory.createPassivePage(context);
      await page.goto(pageUrl(), { waitUntil: 'load' });
      await syncPopupAssign(page, EXTERNAL_SCHEME_TARGETS.custom.url);
      await expectSyncPopupRecorded(factory.getSafetyLedger(context), 'PASSIVE');
    } finally {
      await factory.closePassiveContext(context).catch(() => undefined);
    }
  });

  it('the write stage: a popup sent to the external scheme right after window.open is recorded once', async () => {
    const writeFactory = new BrowserContextFactory(browser, createTestConfig(server.origin, '/'), () => new SafetyLedger(), {
      ...TEST_FACTORY_OPTIONS,
      authentication: {
        initialState: { cookies: [], origins: [] },
        filterState: (state) => state,
        auditExclusions: { excludedPathPrefixes: [], auditPathPrefixes: [], dangerousTerms: [] },
      },
    });
    const context = await writeFactory.createWriteStageContext(viewport, {
      expectation: {
        request: { origin: server.origin, path: '/write', enctype: 'application/x-www-form-urlencoded' },
        submittedFields: [{ name: 'memo', value: 'x' }],
        passthroughFieldNames: [],
        emptyFileFieldNames: [],
      },
      monitor: new WriteStageMonitor(),
    });
    try {
      const page = await writeFactory.createPassivePage(context);
      await page.goto(pageUrl(), { waitUntil: 'load' });
      await syncPopupAssign(page, EXTERNAL_SCHEME_TARGETS.custom.url);
      await expectSyncPopupRecorded(writeFactory.getSafetyLedger(context), 'PASSIVE');
    } finally {
      await writeFactory.closePassiveContext(context).catch(() => undefined);
      await writeFactory.close().catch(() => undefined);
    }
  });

  // EL-F2（EL-R2 の N2）: PDF の表示の拡張の頁でも、`window.open` で開くのは今どおり外部スキームへの移動の試み（除くのは PDF の頁の sub frame だけ）。
  it('Passive: window.open of the PDF viewer extension page is still an external scheme navigation', async () => {
    await withGuardedPassivePage(factory, viewport, async (page, _context, ledger) => {
      await page.goto(pageUrl(), { waitUntil: 'load' });
      const extensionUrl = `chrome-extension://${CHROMIUM_PDF_VIEWER_EXTENSION_ID}/index.html`;
      await page.evaluate((url) => {
        window.open(url);
      }, extensionUrl).catch(() => undefined);
      await expectRecordedOnce(ledger, null, extensionUrl);
    });
  });

  it('Passive: a goto by BeakSight to the external scheme fails and is recorded once', async () => {
    await withGuardedPassivePage(factory, viewport, async (page, _context, ledger) => {
      await expect(page.goto(targetUrl)).rejects.toThrow();
      await expectRecordedOnce(ledger, {
        url: targetUrl, scheme, frame: 'MAIN', phase: 'PASSIVE', reason: 'EXTERNAL_SCHEME_NAVIGATION',
      });
    });
  });

  it('Passive: a script navigation inside an OOPIF is recorded once as a sub frame', async () => {
    await withGuardedPassivePage(factory, viewport, async (page, _context, ledger) => {
      await page.goto(`${server.origin}${crossSiteFramePath(externalSchemeFixturePath('location-href', KEY))}`).catch(() => undefined);
      await expectRecordedOnce(ledger, {
        url: targetUrl, scheme, frame: 'SUB', phase: 'PASSIVE', reason: 'EXTERNAL_SCHEME_NAVIGATION',
      });
    });
  });

  it.each([
    ['main frame', 'MAIN'],
    ['frame', 'SUB'],
  ] as const)('Passive: a 302 of the %s to the external scheme is stopped before it is followed (no violation, the Context stays open)', async (_label, frame) => {
    await withGuardedPassivePage(factory, viewport, async (page, context, ledger) => {
      const path = frame === 'MAIN' ? externalSchemeRedirectPath(KEY) : externalSchemeRedirectFramePath(KEY);
      await page.goto(`${server.origin}${path}`, { waitUntil: 'load' }).catch(() => undefined);
      await expect.poll(() => ledger.snapshot().externalSchemeNavigations.length).toBeGreaterThan(0);
      await wait(QUIET_PERIOD_MS);
      expect(ledger.snapshot().externalSchemeNavigations).toEqual([stoppedRedirectRecord(KEY, frame, 'PASSIVE')]);
      expect(ledger.snapshot().invariantViolations).toEqual([]);
      expect(isPassiveRequestGuardClosed(context)).toBe(false);
    });
  });

  // EL-F（EL-R の I2。前からあった）: PDF の頁（main frame、iframe と embed）で、Chromium の組み込みの PDF の表示の拡張の frame
  // （`chrome-extension://<CHROMIUM_PDF_VIEWER_EXTENSION_ID>/…`）を外部スキームとみなさない。違反にならず、Context を閉じず、続けて読み込める。
  it.each(['/pdf', '/pdf-frame'])('Passive: the PDF page %s is not an external scheme navigation, and the Context keeps working', async (path) => {
    const pdfFactory = createGateFactory(browser, pdfServer.origin);
    await withGuardedPassivePage(pdfFactory, viewport, async (page, context, ledger) => {
      await page.goto(`${pdfServer.origin}${path}`).catch(() => undefined);
      await wait(PDF_SETTLE_MS);
      expect(ledger.snapshot().externalSchemeNavigations).toEqual([]);
      expect(ledger.snapshot().frameClassificationFailures).toBeUndefined();
      if (!cli && path === '/pdf') {
        // テストの既定の headless shell には PDF の表示の拡張がなく、main frame の PDF はダウンロードとして取り消される（今の扱い。外部スキームとは別）。
        // 本番の Chromium（CLI の組）でだけ、続けて読み込めることまで確かめる。
        return;
      }
      await expect(page.goto(`${pdfServer.origin}/`, { waitUntil: 'load' })).resolves.not.toBeNull();
      expect(isPassiveRequestGuardClosed(context)).toBe(false);
    });
  });

  it.runIf(cli)('the profile policy blocks the navigation itself in a Context without the Guard (an unregistered custom scheme only)', async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await expect(page.goto(EXTERNAL_SCHEME_TARGETS.custom.url)).rejects.toThrow(EXTERNAL_LAUNCH_BLOCKED_ERROR_TEXT);
    } finally {
      await context.close();
    }
  });

  it.runIf(cli)('the launch component leaves only its default Context, which is not a Run Context', () => {
    expect(browser.contexts()).toHaveLength(1 + testContextsOf(browser).length);
  });
});

/**
 * EL-3: 起動の部品の後片付けで、一時のプロファイルが残らない。プロファイルの置き場所は、本番の依存の作り方を包んで覚える（作り方そのものは本番のまま）。
 * SAFE-B5: 通常の close・予期しない切断・起動の失敗の後片付けの順は、単体 `tests/unit/chromium-launch.test.ts`（偽の persistent の Chromium）が確かめるので、
 * 本物の Chromium とファイルでは、自己検査の不合格（Preferences を置かない起動。EL-12 の自己検査の不合格の場面を兼ねる）の 1 場面だけにした。
 */
describe('EL-3: the launch component leaves no temporary profile behind', () => {
  const recordingDependencies = (overrides: Partial<ChromiumLaunchDependencies> = {}): {
    readonly dependencies: ChromiumLaunchDependencies;
    readonly directories: string[];
  } => {
    const directories: string[] = [];
    return {
      directories,
      dependencies: {
        ...PRODUCTION_CHROMIUM_LAUNCH_DEPENDENCIES,
        ...overrides,
        createProfileDirectory: async () => {
          const directory = await PRODUCTION_CHROMIUM_LAUNCH_DEPENDENCIES.createProfileDirectory();
          directories.push(directory);
          return directory;
        },
      },
    };
  };
  // RB-4 fix（M-1）: テストだけの外へ出ない引数を足す。
  const cliOptions = (): LaunchOptions => {
    const options = chromiumLaunchOptions({ headless: true });
    return { ...options, args: [...withTestOnlyNoInternetArgs(options.args ?? [])] };
  };

  it('refuses with EXTERNAL_LAUNCH_BLOCK_UNAVAILABLE and removes the profile when the self-check fails (no Preferences, an unregistered custom scheme only)', async () => {
    const { dependencies, directories } = recordingDependencies({ writeProfilePreferences: async () => undefined });

    const failure = await launchChromiumWith(cliOptions(), dependencies).then(async (browser) => {
      await browser.close();
      return null;
    }, (error: unknown) => error);

    expect(isChromiumLaunchRefused(failure, 'EXTERNAL_LAUNCH_BLOCK_UNAVAILABLE')).toBe(true);
    expect(directories).toHaveLength(1);
    expect(existsSync(directories[0] ?? '')).toBe(false);
  });
});

// EL-F（EL-R の M2）: 本物の CLI の Chromium で、既定の Context からどこへも要求が出ないこと。SAFE-B5: 許す一覧の上書き（M1）を断る場面は、単体
// `tests/unit/chromium-launch.test.ts` の「an allowed scheme (http, https) is blocked」が確かめるので、ここからは外した。
describe('EL-F: the default Context of the launch component sends nothing', () => {
  it('blocks every request of the default Context (a page opened there reaches no server)', async () => {
    let hits = 0;
    const target = await startLoopbackHttpServer((_request, response) => {
      hits += 1;
      response.end('<p>reached</p>');
    });
    const browser = await launchCliChromium();
    try {
      const [defaultContext] = browser.contexts();
      const page = await defaultContext!.newPage();
      await expect(page.goto(`${target.origin}/`, { timeout: 5_000 })).rejects.toThrow();
      await wait(QUIET_PERIOD_MS);
      expect(hits).toBe(0);
    } finally {
      await browser.close();
      await target.close();
    }
  });
});

/**
 * PRN: 起動の部品の一時のプロファイルの設定で、印刷を止める（headed でも印刷の画面を開かない）。印刷の画面が開くと、そのページへの操作は閉じるまで返らない。
 * 押した後の 1 手と読み取りが、この窓の中で返ることを確かめる（直す前は返らなかった）。値は待ちの窓で、場面の時間の上限ではない。
 */
const PRINT_RESPONSE_WINDOW_MS = 2_000;
/** 本体と iframe で `print()` を呼ぶボタン（押した後に、押したボタンの名前を書く）。 */
const PRINT_PAGE = `<!doctype html><title>print</title><body>
<button id="page" onclick="window.print(); document.body.dataset.done = 'page';">page</button>
<button id="frame" onclick="const f = document.createElement('iframe'); document.body.append(f); f.contentWindow.print(); document.body.dataset.done = 'frame';">frame</button>
</body>`;

/** `call` が窓の中で返った値（返らなければ誤り）。 */
const withinPrintWindow = <T>(call: Promise<T>): Promise<T> => Promise.race([
  call,
  wait(PRINT_RESPONSE_WINDOW_MS).then(() => { throw new Error(`no response within ${String(PRINT_RESPONSE_WINDOW_MS)} ms (a print dialog is open)`); }),
]);

describe('PRN: the launch component opens no print dialog', () => {
  it('returns the click and the next page read right after print() in the page and in an iframe (headed)', async () => {
    const site = await startLoopbackHttpServer((_request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(PRINT_PAGE);
    });
    const options = chromiumLaunchOptions({ headless: false });
    const browser = await launchChromiumWith({ ...options, args: [...withTestOnlyNoInternetArgs(options.args ?? [])] });
    try {
      const page = await (await browser.newContext()).newPage();
      await page.goto(`${site.origin}/`);
      for (const id of ['page', 'frame']) {
        await withinPrintWindow(page.locator(`#${id}`).click({ noWaitAfter: true, timeout: PRINT_RESPONSE_WINDOW_MS }));
        await expect(withinPrintWindow(page.evaluate(() => document.body.dataset['done']))).resolves.toBe(id);
      }
    } finally {
      await browser.close();
      await site.close();
    }
  });
});

// SAFE-B5: 自己検査の不合格（Preferences を置かない起動）は、EL-3 の場面が、プロファイルの後片付けと一緒に確かめる。
describe('EL-12: the self-check of the launch component', () => {
  it('passes with the Preferences and keeps no page in the default Context (headless)', async () => {
    const browser = await launchCliChromium();
    try {
      expect(browser.contexts()).toHaveLength(1);
      expect(browser.contexts()[0]?.pages()).toEqual([]);
      expect(testContextsOf(browser)).toEqual([]);
    } finally {
      await browser.close();
    }
  });
});
