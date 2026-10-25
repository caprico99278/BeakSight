// EL-12（設計書 `2026-10-24-beaksight-external-launch-block-design.md` 3.3〜3.5・5 章。DEF-171）: 外部スキームへの移動を、Guard を付けた Context
// （Passive と、凍結の後の Interaction）が、両方の Chromium（テストの既定の headless shell と、本番と同じ起動の部品の CLI の Chromium）で今と同じ形で
// 記録し、閉じることを確かめる。CLI の Chromium は一時のプロファイルの設定で移動そのものを止め（OS のアプリへ渡さない）、Guard は CDP の事象で検出する。
// - 経路: BeakSight の goto、`location.href`、click、iframe、302 の main と frame、`window.open`、`a target=_blank`、`form target=_blank`、OOPIF の
//   スクリプトの移動。
// - CLI の Chromium では、設定が効いていること（守りのない Context の、登録のない独自のスキームへの移動が `ERR_BLOCKED_BY_ADMINISTRATOR` になる）と、
//   自己検査の合格と不合格（Preferences を置かない起動で `EXTERNAL_LAUNCH_BLOCK_UNAVAILABLE`）も確かめる。
//
// 厳守事項: Chromium は headless だけで起動する。外部スキームの宛先は、実在しないもの（`fixtures/external-scheme-targets.ts`）だけ。守りのない Context で
// 移動させるのは、設定ありの CLI の Chromium の、登録のない独自のスキーム（`custom`）だけ（設定なしの Chromium に `mailto:` などを流さない。EL-0 の手違い）。
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { externalSchemeNavigationViolationMessage, isPassiveRequestGuardClosed, WriteStageMonitor } from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import {
  launchCliChromium,
  launchCliChromiumWithoutExternalLaunchBlock,
  launchTestDefaultChromium,
  SITE_PER_PROCESS_ARGS,
  testContextsOf,
} from '../helpers/chromium.js';
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
const ATTEMPTED = 'EXTERNAL_SCHEME_NAVIGATION_ATTEMPTED';
const FRAME_CLASSIFICATION_FAILED = 'FRAME_CLASSIFICATION_FAILED';
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

/** 違反の文（今の形）。 */
const attemptedViolation = (scheme: string): { readonly code: string; readonly message: string } => ({
  code: ATTEMPTED,
  message: externalSchemeNavigationViolationMessage(scheme),
});

/** 移動の試みの後、Context が閉じるまで待ち、違反が 1 回だけ、記録が `expected`（popup は空で、frame の分類の失敗の違反つき）であることを確かめる。 */
async function expectRecordedOnce(
  ledger: SafetyLedger,
  isClosed: () => boolean,
  expected: ExternalSchemeNavigationEvent | null,
): Promise<void> {
  await expect.poll(isClosed).toBe(true);
  await wait(QUIET_PERIOD_MS);
  const snapshot = ledger.snapshot();
  const { scheme } = EXTERNAL_SCHEME_TARGETS[KEY];
  expect(snapshot.invariantViolations.filter(({ code }) => code === ATTEMPTED)).toEqual([attemptedViolation(scheme)]);
  if (expected === null) {
    expect(snapshot.externalSchemeNavigations).toEqual([]);
    expect(snapshot.invariantViolations.map(({ code }) => code)).toContain(FRAME_CLASSIFICATION_FAILED);
    return;
  }
  expect(snapshot.externalSchemeNavigations).toEqual([expected]);
  expect(snapshot.invariantViolations).toEqual([attemptedViolation(scheme)]);
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

describe.each([
  { kind: 'the headless shell (test default)', cli: false, launch: () => launchTestDefaultChromium({ args: SITE_PER_PROCESS_ARGS }) },
  { kind: 'the CLI Chromium (the launch component)', cli: true, launch: () => launchCliChromium({ args: SITE_PER_PROCESS_ARGS }) },
])('EL-12: the Guard records an external scheme navigation once and closes the Context, with $kind', ({ cli, launch }) => {
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
    await withGuardedPassivePage(factory, viewport, async (page, context, ledger) => {
      await page.goto(pageUrl(), { waitUntil: 'load' });
      await attempt(page, run, targetUrl);
      await expectRecordedOnce(ledger, () => isPassiveRequestGuardClosed(context), frame === null ? null : {
        url: recordedUrlOf(name, targetUrl), scheme, frame, phase: 'PASSIVE', reason: 'EXTERNAL_SCHEME_NAVIGATION',
      });
    });
  });

  it.each(SCRIPT_ROUTES)('Interaction (after the freeze): $name', async ({ name, frame, run }) => {
    const session = await factory.createInteractionSession(viewport);
    try {
      await session.page.goto(pageUrl(), { waitUntil: 'load' });
      await session.activateInteractionFreeze();
      await attempt(session.page, run, targetUrl);
      await expectRecordedOnce(session.ledger, () => session.isClosed(), frame === null ? null : {
        url: recordedUrlOf(name, targetUrl), scheme, frame, phase: 'INTERACTION', reason: 'EXTERNAL_SCHEME_NAVIGATION',
      });
    } finally {
      if (!session.isClosed()) await session.close().catch(() => undefined);
    }
  });

  // EL-F（EL-R の I1）: 凍結の後に開いたポップアップ（Guard の page の準備を付けない頁）を、`about:blank` で開いてから外部スキームへ移す。opener の
  // `Page.windowOpen` は `about:blank` で、設定ありの Chromium では `request` も来ないので、直す前は記録 0 だった。宛先は登録のない独自のスキーム。
  it('Interaction (after the freeze): a popup opened as about:blank and then sent to the external scheme is recorded once and closes the session', async () => {
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
      await expect.poll(() => session.isClosed(), { timeout: 10_000 }).toBe(true);
      await wait(QUIET_PERIOD_MS);
      const snapshot = session.ledger.snapshot();
      expect(snapshot.invariantViolations.filter(({ code }) => code === ATTEMPTED)).toEqual([attemptedViolation(custom.scheme)]);
      expect(snapshot.externalSchemeNavigations).toEqual([
        { url: custom.url, scheme: custom.scheme, frame: 'MAIN', phase: 'INTERACTION', reason: 'EXTERNAL_SCHEME_NAVIGATION' },
      ]);
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

  /** ポップアップの移動の記録が 1 回だけあり、Context が閉じたこと。 */
  const expectSyncPopupRecorded = async (ledger: SafetyLedger, isClosed: () => boolean, phase: ExternalSchemeNavigationEvent['phase']): Promise<void> => {
    const custom = EXTERNAL_SCHEME_TARGETS.custom;
    await expect.poll(isClosed, { timeout: 10_000 }).toBe(true);
    await wait(QUIET_PERIOD_MS);
    const snapshot = ledger.snapshot();
    expect(snapshot.invariantViolations.filter(({ code }) => code === ATTEMPTED)).toEqual([attemptedViolation(custom.scheme)]);
    expect(snapshot.externalSchemeNavigations).toEqual([
      { url: custom.url, scheme: custom.scheme, frame: 'MAIN', phase, reason: 'EXTERNAL_SCHEME_NAVIGATION' },
    ]);
  };

  it('Passive: a popup sent to the external scheme right after window.open is recorded once and closes the Context', async () => {
    await withGuardedPassivePage(factory, viewport, async (page, context, ledger) => {
      await page.goto(pageUrl(), { waitUntil: 'load' });
      await syncPopupAssign(page, EXTERNAL_SCHEME_TARGETS.custom.url);
      await expectSyncPopupRecorded(ledger, () => isPassiveRequestGuardClosed(context), 'PASSIVE');
    });
  });

  it.each([
    ['before the freeze', false, 'PASSIVE'],
    ['after the freeze', true, 'INTERACTION'],
  ] as const)('Interaction (%s): a popup sent to the external scheme right after window.open is recorded once and closes the session', async (_label, frozen, phase) => {
    const session = await factory.createInteractionSession(viewport);
    try {
      await session.page.goto(pageUrl(), { waitUntil: 'load' });
      if (frozen) await session.activateInteractionFreeze();
      await syncPopupAssign(session.page, EXTERNAL_SCHEME_TARGETS.custom.url);
      await expectSyncPopupRecorded(session.ledger, () => session.isClosed(), phase);
    } finally {
      if (!session.isClosed()) await session.close().catch(() => undefined);
    }
  });

  it.each([
    ['the manual login stage', true],
    ['the automated login stage', false],
  ] as const)('%s: a popup sent to the external scheme right after window.open is recorded once and closes the Context', async (_label, manual) => {
    const context = await factory.createLoginStageContext(viewport, {
      loginPostEndpoints: [{ origin: server.origin, path: '/login' }],
      maxLoginPosts: 1,
      ...(manual ? { manualPassThrough: true as const } : {}),
    });
    try {
      const page = await factory.createPassivePage(context);
      await page.goto(pageUrl(), { waitUntil: 'load' });
      await syncPopupAssign(page, EXTERNAL_SCHEME_TARGETS.custom.url);
      await expectSyncPopupRecorded(factory.getSafetyLedger(context), () => isPassiveRequestGuardClosed(context), 'PASSIVE');
    } finally {
      await factory.closePassiveContext(context).catch(() => undefined);
    }
  });

  it('the write stage: a popup sent to the external scheme right after window.open is recorded once and closes the Context', async () => {
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
      await expectSyncPopupRecorded(writeFactory.getSafetyLedger(context), () => isPassiveRequestGuardClosed(context), 'PASSIVE');
    } finally {
      await writeFactory.closePassiveContext(context).catch(() => undefined);
      await writeFactory.close().catch(() => undefined);
    }
  });

  // EL-F2（EL-R2 の N2）: PDF の表示の拡張の頁でも、`window.open` で開くのは今どおり外部スキームへの移動の試み（除くのは PDF の頁の sub frame だけ）。
  it('Passive: window.open of the PDF viewer extension page is still an external scheme navigation', async () => {
    await withGuardedPassivePage(factory, viewport, async (page, context, ledger) => {
      await page.goto(pageUrl(), { waitUntil: 'load' });
      await page.evaluate((url) => {
        window.open(url);
      }, `chrome-extension://${CHROMIUM_PDF_VIEWER_EXTENSION_ID}/index.html`).catch(() => undefined);
      await expect.poll(() => isPassiveRequestGuardClosed(context), { timeout: 10_000 }).toBe(true);
      await wait(QUIET_PERIOD_MS);
      expect(ledger.snapshot().invariantViolations.filter(({ code }) => code === ATTEMPTED)).toEqual([attemptedViolation('chrome-extension')]);
    });
  });

  it('Passive: a goto by BeakSight to the external scheme fails, is recorded once, and closes the Context', async () => {
    await withGuardedPassivePage(factory, viewport, async (page, context, ledger) => {
      await expect(page.goto(targetUrl)).rejects.toThrow();
      await expectRecordedOnce(ledger, () => isPassiveRequestGuardClosed(context), {
        url: targetUrl, scheme, frame: 'MAIN', phase: 'PASSIVE', reason: 'EXTERNAL_SCHEME_NAVIGATION',
      });
    });
  });

  it('Passive: a script navigation inside an OOPIF is recorded once as a sub frame and closes the Context', async () => {
    await withGuardedPassivePage(factory, viewport, async (page, context, ledger) => {
      await page.goto(`${server.origin}${crossSiteFramePath(externalSchemeFixturePath('location-href', KEY))}`).catch(() => undefined);
      await expectRecordedOnce(ledger, () => isPassiveRequestGuardClosed(context), {
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
      if (!cli && path === '/pdf') {
        // テストの既定の headless shell には PDF の表示の拡張がなく、main frame の PDF はダウンロードとして取り消される（今の扱い。外部スキームとは別）。
        // 本番の Chromium（CLI の組）でだけ、続けて読み込めることまで確かめる。
        expect(ledger.snapshot().invariantViolations.map(({ code }) => code)).not.toContain(ATTEMPTED);
        return;
      }
      expect(ledger.snapshot().invariantViolations).toEqual([]);
      expect(isPassiveRequestGuardClosed(context)).toBe(false);
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
 * EL-3: 起動の部品の後片付けで、一時のプロファイルが残らない（通常の close、予期しない切断、自己検査の不合格、起動の失敗）。プロファイルの置き場所は、
 * 本番の依存の作り方を包んで覚える（作り方そのものは本番のまま）。
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
  const cliOptions = (): LaunchOptions => chromiumLaunchOptions({ headless: true });

  it('removes the profile once browser.close() returns', async () => {
    const { dependencies, directories } = recordingDependencies();
    const browser = await launchChromiumWith(cliOptions(), dependencies);
    expect(directories).toHaveLength(1);
    expect(existsSync(directories[0] ?? '')).toBe(true);

    await browser.close();

    expect(existsSync(directories[0] ?? '')).toBe(false);
  });

  it('removes the profile after an unexpected disconnect (Chromium closed from outside)', async () => {
    const { dependencies, directories } = recordingDependencies();
    const browser = await launchChromiumWith(cliOptions(), dependencies);
    const session = await browser.newBrowserCDPSession();

    await session.send('Browser.close').catch(() => undefined);

    await expect.poll(() => browser.isConnected(), { timeout: 10_000 }).toBe(false);
    await expect.poll(() => existsSync(directories[0] ?? ''), { timeout: 10_000 }).toBe(false);
  });

  it('removes the profile when the self-check refuses (no Preferences, an unregistered custom scheme only)', async () => {
    const { dependencies, directories } = recordingDependencies({ writeProfilePreferences: async () => undefined });

    const failure = await launchChromiumWith(cliOptions(), dependencies).then(async (browser) => {
      await browser.close();
      return null;
    }, (error: unknown) => error);

    expect(isChromiumLaunchRefused(failure, 'EXTERNAL_LAUNCH_BLOCK_UNAVAILABLE')).toBe(true);
    expect(existsSync(directories[0] ?? '')).toBe(false);
  });

  it('removes the profile when Chromium cannot be launched', async () => {
    const { dependencies, directories } = recordingDependencies();
    const { channel: _channel, ...withoutChannel } = cliOptions();

    await expect(launchChromiumWith({ ...withoutChannel, executablePath: join(tmpdir(), 'beaksight-no-such-chromium.exe') }, dependencies))
      .rejects.toThrow();

    expect(directories).toHaveLength(1);
    expect(existsSync(directories[0] ?? '')).toBe(false);
  });
});

// EL-F（EL-R の M1・M2）: 本物の CLI の Chromium で、自己検査が許した種類の止まり（許す一覧の上書き）も断ることと、既定の Context からどこへも要求が
// 出ないこと。
describe('EL-F: the self-check also checks the allowed schemes, and the default Context sends nothing', () => {
  it('refuses when the allow list of the profile does not allow http and https (an overridden allow list)', async () => {
    const dependencies: ChromiumLaunchDependencies = {
      ...PRODUCTION_CHROMIUM_LAUNCH_DEPENDENCIES,
      writeProfilePreferences: async (profileDirectory) => {
        await mkdir(join(profileDirectory, 'Default'), { recursive: true });
        await writeFile(
          join(profileDirectory, 'Default', 'Preferences'),
          JSON.stringify({ policy: { url_blocklist: ['*'], url_allowlist: ['about:*', 'data:*', 'blob:*'] } }),
        );
      },
    };

    const failure = await launchChromiumWith(chromiumLaunchOptions({ headless: true }), dependencies).then(async (browser) => {
      await browser.close();
      return null;
    }, (error: unknown) => error);

    expect(isChromiumLaunchRefused(failure, 'EXTERNAL_LAUNCH_BLOCK_UNAVAILABLE')).toBe(true);
    expect(String(failure)).toContain('an allowed scheme (http:)');
  });

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

describe('EL-12: the self-check of the launch component', () => {
  it('refuses with EXTERNAL_LAUNCH_BLOCK_UNAVAILABLE when the profile has no Preferences (the CLI Chromium, an unregistered custom scheme)', async () => {
    const failure = await launchCliChromiumWithoutExternalLaunchBlock().then(async (browser) => {
      await browser.close();
      return null;
    }, (error: unknown) => error);
    expect(isChromiumLaunchRefused(failure, 'EXTERNAL_LAUNCH_BLOCK_UNAVAILABLE')).toBe(true);
  });

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
