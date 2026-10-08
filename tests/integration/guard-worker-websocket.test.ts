// DEF-040（NP3。設計書 `2026-10-08-beaksight-def-039-040-egress-design.md` 2.2）: Worker（Dedicated、Shared）の中で開く WebSocket の接続は、
// ページに差し込む方式の差し替え（`routeWebSocket`）を通らない。Guard は、文書の始まりに meta の CSP（`connect-src http: https: data: blob:`）を
// 入れてすぐ外し（Context の `addInitScript`）、Worker の script の応答（CDP の Fetch の `Other` の Response の段階）に同じ CSP のヘッダを
// 加えて、Worker の中の WebSocket を止める。記録は、Guard の page の session の `Log.entryAdded`（source worker）の観察で残す（best-effort）。
// - Chromium は headless だけで起動する。テストの既定（headless shell。`launchHeadlessChromium`）と、CLI の起動の設定
//   （`chromiumLaunchOptions`。`chrome.exe` の新しい headless）の両方で確かめる。
// - 127.0.0.1 の fixture のサーバだけを使う。
// - 場面: blob・http の script・Shared・module・入れ子・srcdoc の iframe の Worker。Passive の Context と、Interaction の凍結の前。どれも、
//   WebSocket の Upgrade がサーバに届かず、違反 0。Dedicated の場面は `blockedWebSockets` に理由 `WORKER_CONNECT_POLICY` の記録が残る
//   （Shared Worker の違反は page の session に出ないので、記録は求めない）。対照は、Guard なしで届く。
// - DEF-044（NP5）: テストの Chromium と CLI の Chromium は、Shared Worker を無効にして起動する（`CHROMIUM_SHARED_WORKERS_DISABLED_ARGS`）。
//   Shared の場面は、Shared Worker が作れず（fixture が `unavailable` を残す）、接続も script の GET も起きず、違反 0 であることを確かめる
//   （対照でも届かない）。CSP による Shared Worker の中の WebSocket の止め方は、Shared Worker がないので確かめない。
// - 監査への影響: DOM の Evidence に meta が写らない、console の Evidence に CSP の文が入らない、network の Evidence に加えたヘッダが写らない、
//   WebSocket 以外の接続（fetch、XHR、EventSource、img、script、Worker の中の fetch、data:・blob: への fetch）は変わらない。POST（beacon、ping）は
//   今までどおり Guard が止める。
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { chromiumLaunchOptions } from '../../src/browser/chromium-launch.js';
import type { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { Viewport } from '../../src/config/types.js';
import { wait } from '../../src/core/deadline.js';
import { createPageId } from '../../src/core/ids.js';
import { ConsoleCollector } from '../../src/evidence/console-collector.js';
import { collectDomEvidence } from '../../src/evidence/dom-collector.js';
import { NetworkCollector } from '../../src/evidence/network-collector.js';
import { BROWSER_DEFAULT_FAVICON_PATH, launchHeadlessChromium } from '../helpers/chromium.js';
import {
  createGateFactory,
  expectedWorkerWebSocketState,
  NO_NON_READ_REQUESTS,
  openGuardedPassiveSession,
  openInteractionSessionBeforeFreeze,
  openServerWindow,
  openUnguardedWorkerWebSocketPage,
  QUIET_PERIOD_MS,
  readWorkerWebSocketState,
  RECORDED_WORKER_WEBSOCKET_KINDS,
  runGuardedWorkerWebSocketRounds,
  UNAVAILABLE_WORKER_WEBSOCKET_KINDS,
  UNLOAD_BEACON_TARGET_PATH,
  WORKER_WEBSOCKET_CONNECT_SCRIPT_PATH,
  WORKER_WEBSOCKET_KINDS,
  WORKER_WEBSOCKET_PASSIVE_PAGE,
  WORKER_WEBSOCKET_TEST_TIMEOUT_MS,
  workerWebSocketPassivePath,
  workerWebSocketScriptRequestLines,
  withUnguardedPage,
  type WorkerWebSocketKind,
  type WorkerWebSocketRounds,
} from '../helpers/gate-harness.js';

const viewport: Viewport = Object.freeze({ width: 900, height: 700 });
/** fixture のサーバの WebSocket の受け口（fixture のページは `/socket` へ接続する）。 */
const SOCKET_PATH = '/socket';
/** CSP の違反の文に含まれる語（console の Evidence に入らないことの確かめに使う）。 */
const CSP_TEXT = 'Content Security Policy';
/** DOM・network の Evidence に写らないことを確かめる、meta とヘッダの名前。 */
const CSP_HEADER_NAME = 'content-security-policy';
/** DEF-040 の対照の場面の fixture（`fixtures/site/`）と、その読み込みで届くはずの GET（記録の順は問わない）。 */
const CONNECT_POLICY_CONTROLS_PAGE = '/worker-connect-policy-controls.html';
const CONNECT_POLICY_CONTROL_GET_PATHS = Object.freeze([
  '/external-script.js',
  '/short-content.html',
  '/robots.txt',
  '/sitemap.xml',
  '/unsized-image.svg',
  '/resource-item.css',
] as const);
/** `CONNECT_POLICY_CONTROLS_PAGE` が html 要素に残す、接続の結果の名前と、期待する値。 */
const CONNECT_POLICY_CONTROL_RESULTS = Object.freeze({
  fetchGet: 'done',
  xhrGet: 'done',
  eventSource: 'done',
  image: 'done',
  script: 'done',
  dataFetch: 'ok',
  blobFetch: 'ok',
  workerFetch: 'done',
  beacon: 'queued',
  ping: 'clicked',
} as const);

/** Chromium の起動の仕方（名前と、起動する関数）。 */
interface ChromiumLaunch {
  readonly name: string;
  launch(): Promise<Browser>;
}

const CHROMIUM_LAUNCHES: readonly ChromiumLaunch[] = [
  { name: 'the headless shell (test default)', launch: () => launchHeadlessChromium() },
  { name: 'the CLI Chromium (chromiumLaunchOptions, headless)', launch: () => chromium.launch(chromiumLaunchOptions({ headless: true })) },
];

/** 回ごとの結果を、検証の記録のために出力する（既定の報告では、PASS したテストの出力は表示されない）。 */
function logRounds(label: string, { rounds }: WorkerWebSocketRounds): void {
  console.info(`DEF-040 ${label}: ${JSON.stringify(rounds.map((round) => ({
    round: round.round,
    upgrades: round.upgrades,
    requestLines: round.requestLines,
    blockedWebSockets: round.blockedWebSockets.map((entry) => `${entry.url} ${entry.reason}`),
    violations: round.invariantViolations,
    workerState: round.workerState,
  })))}`);
}

/** `CONNECT_POLICY_CONTROLS_PAGE` が html 要素に残した、接続の結果（名前ごと）。 */
const readConnectPolicyControlResults = (page: Page): Promise<Record<string, string | undefined>> => page.evaluate(
  (names) => Object.fromEntries(names.map((name) => [name, document.documentElement.dataset[name]])),
  Object.keys(CONNECT_POLICY_CONTROL_RESULTS),
);

describe.each(CHROMIUM_LAUNCHES)('DEF-040: WebSockets opened inside Workers are stopped by the Guard, with $name', ({ name, launch }) => {
  let server: FixtureServer;
  let browser: Browser;
  let factory: BrowserContextFactory;

  beforeAll(async () => {
    server = await startFixtureServer();
    browser = await launch();
    factory = createGateFactory(browser, server.origin);
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  const urlOf = (path: string): string => `${server.origin}${path}`;
  const socketUrl = (): string => urlOf(SOCKET_PATH).replace(/^http/, 'ws');
  const expectedRequestLines = (kind: WorkerWebSocketKind): string[] => [
    `GET ${WORKER_WEBSOCKET_PASSIVE_PAGE}`,
    ...workerWebSocketScriptRequestLines(kind),
  ];

  /** すべての回の、届かないこと、記録、要求の一覧を確かめる（Passive と凍結の前で同じ条件）。 */
  function expectRoundsStopped(kind: WorkerWebSocketKind, result: WorkerWebSocketRounds): void {
    expect(result.failedRounds).toEqual([]);
    expect(result.allRoundsWindow.counters().webSocketUpgrade).toBe(0);
    expect(result.allRoundsWindow.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
    expect(result.rounds.map((round) => round.requestLines)).toEqual(result.rounds.map(() => expectedRequestLines(kind)));
    expect(result.rounds.every((round) => round.workerState === expectedWorkerWebSocketState(kind))).toBe(true);
    if (RECORDED_WORKER_WEBSOCKET_KINDS.includes(kind)) {
      expect(result.rounds.every((round) => round.blockedWebSockets.length > 0
        && round.blockedWebSockets.every((entry) => entry.url === socketUrl() && entry.reason === 'WORKER_CONNECT_POLICY'))).toBe(true);
    } else {
      // Shared Worker: 記録は求めないが、残った記録があれば、理由と URL は同じ形である。
      expect(result.rounds.every((round) => round.blockedWebSockets.every((entry) => (
        entry.url === socketUrl() && entry.reason === 'WORKER_CONNECT_POLICY'
      )))).toBe(true);
    }
  }

  it.each(WORKER_WEBSOCKET_KINDS)('Passive: the WebSocket upgrade from inside the %s Worker never reaches the server, is recorded for Dedicated Workers, and there is no violation', async (kind) => {
    const result = await runGuardedWorkerWebSocketRounds(() => openGuardedPassiveSession(factory, viewport), server, kind);
    logRounds(`Passive ${kind} (${name})`, result);

    expectRoundsStopped(kind, result);
  }, WORKER_WEBSOCKET_TEST_TIMEOUT_MS);

  it.each(WORKER_WEBSOCKET_KINDS)('Interaction (before the freeze): the WebSocket upgrade from inside the %s Worker never reaches the server, is recorded for Dedicated Workers, and there is no violation', async (kind) => {
    const result = await runGuardedWorkerWebSocketRounds(() => openInteractionSessionBeforeFreeze(factory, viewport), server, kind);
    logRounds(`Interaction before freeze ${kind} (${name})`, result);

    expectRoundsStopped(kind, result);
  }, WORKER_WEBSOCKET_TEST_TIMEOUT_MS);

  it.each(WORKER_WEBSOCKET_KINDS)('control: without the Guard, the WebSocket upgrade from inside the %s Worker reaches the server, except the Shared Worker that cannot be created (DEF-044)', async (kind) => {
    const window = await openUnguardedWorkerWebSocketPage(browser, server, viewport, kind);

    if (UNAVAILABLE_WORKER_WEBSOCKET_KINDS.includes(kind)) {
      expect(window.counters().webSocketUpgrade).toBe(0);
    } else {
      expect(window.counters().webSocketUpgrade).toBeGreaterThan(0);
    }
  });

  it.each(['blob', 'http'] as const satisfies readonly WorkerWebSocketKind[])('Passive: the audit Evidence (DOM, console, network) of the page with the %s Worker shows neither the meta nor the injected header', async (kind) => {
    const session = await openGuardedPassiveSession(factory, viewport);
    try {
      const consoleHandle = ConsoleCollector.attach(session.page);
      const networkHandle = NetworkCollector.attach(session.page);
      await session.page.goto(urlOf(workerWebSocketPassivePath(kind)), { waitUntil: 'load' });
      await expect.poll(() => readWorkerWebSocketState(session.page)).toBe('started');
      await expect.poll(() => session.ledger.snapshot().blockedWebSockets.length).toBeGreaterThan(0);
      await wait(QUIET_PERIOD_MS);

      const liveMetaCount = await session.page.evaluate(() => document.querySelectorAll('meta[http-equiv]').length);
      const dom = await collectDomEvidence(session.page, createPageId(1));
      const consoleEvidence = await consoleHandle.snapshot();
      const networkEvidence = await networkHandle.snapshot();
      consoleHandle.detach();
      networkHandle.detach();

      expect(liveMetaCount).toBe(0);
      expect(JSON.stringify(dom).toLowerCase()).not.toContain(CSP_HEADER_NAME);
      expect(consoleEvidence.consoleMessages.filter((message) => message.text.includes(CSP_TEXT))).toEqual([]);
      expect(consoleEvidence.pageErrors).toEqual([]);
      const responseHeaderNames = networkEvidence.responses.flatMap((response) => (
        response.headers.status === 'OBSERVED' ? Object.keys(response.headers.values).map((header) => header.toLowerCase()) : []
      ));
      expect(responseHeaderNames).not.toContain(CSP_HEADER_NAME);
      if (kind === 'http') {
        expect(networkEvidence.responses.some((response) => response.url === urlOf(WORKER_WEBSOCKET_CONNECT_SCRIPT_PATH))).toBe(true);
      }
      expect(session.ledger.snapshot().invariantViolations).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it('Passive: the connections other than WebSockets (fetch, XHR, EventSource, img, script, Worker fetch, data:, blob:) are unchanged, and POST (beacon, ping) is still stopped by the Guard', async () => {
    const session = await openGuardedPassiveSession(factory, viewport);
    try {
      const consoleHandle = ConsoleCollector.attach(session.page);
      const window = openServerWindow(server);
      await session.page.goto(urlOf(CONNECT_POLICY_CONTROLS_PAGE), { waitUntil: 'load' });
      await expect.poll(() => readConnectPolicyControlResults(session.page)).toEqual(CONNECT_POLICY_CONTROL_RESULTS);
      await expect.poll(() => session.ledger.snapshot().blockedRequests.length).toBeGreaterThanOrEqual(2);
      await wait(QUIET_PERIOD_MS);
      const consoleEvidence = await consoleHandle.snapshot();
      consoleHandle.detach();

      for (const path of CONNECT_POLICY_CONTROL_GET_PATHS) {
        expect(window.count('GET', path), path).toBeGreaterThan(0);
      }
      expect(window.count(null, UNLOAD_BEACON_TARGET_PATH)).toBe(0);
      expect(window.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
      const snapshot = session.ledger.snapshot();
      expect(snapshot.blockedRequests.every((entry) => (
        entry.method === 'POST' && entry.url === urlOf(UNLOAD_BEACON_TARGET_PATH) && entry.reason === 'NON_READ_METHOD'
      ))).toBe(true);
      expect(snapshot.blockedRequests.length).toBeGreaterThanOrEqual(2);
      expect(snapshot.blockedWebSockets).toEqual([]);
      expect(snapshot.invariantViolations).toEqual([]);
      expect(consoleEvidence.consoleMessages.filter((message) => message.text.includes(CSP_TEXT))).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it('control: without the Guard, the same connections reach the server, and the POST (beacon, ping) reaches it too', async () => {
    await withUnguardedPage(browser, viewport, async (page) => {
      const window = openServerWindow(server);
      await page.goto(urlOf(CONNECT_POLICY_CONTROLS_PAGE), { waitUntil: 'load' });
      await expect.poll(() => readConnectPolicyControlResults(page)).toEqual(CONNECT_POLICY_CONTROL_RESULTS);
      await expect.poll(() => window.count('POST', UNLOAD_BEACON_TARGET_PATH)).toBeGreaterThanOrEqual(2);

      for (const path of CONNECT_POLICY_CONTROL_GET_PATHS) {
        expect(window.count('GET', path), path).toBeGreaterThan(0);
      }
      expect(window.requestLines().filter((line) => line === `GET ${BROWSER_DEFAULT_FAVICON_PATH}`).length).toBeLessThanOrEqual(1);
    });
  });
});
