// DEF-026（設計書 `2026-10-05-beaksight-def-026-guard-canceled-document-design.md`）: Guard の CDP の層が一時停止した文書の要求を、
// ブラウザが取り消した場合（読み込みの途中で iframe が消された、など）に、Guard の命令（`Fetch.continueRequest`、`Fetch.failRequest`）が
// 一時停止の ID が無効なために失敗しても、取り消しの証拠（同じ session の `Network.loadingFailed` の canceled）を ID で対応付けられたなら、
// 違反にしない。証拠がなければ、今のとおり違反にする（fail-closed）。
//
// - Chromium は、CLI と同じ起動の設定（`chromiumLaunchOptions`。headless）で起動する。CLI の Chromium は、別のサイトの iframe を
//   別のプロセス（OOPIF）にする。
// - 競合は数 ms なので、DEF-026 の調査で毎回起きた条件（iframe を数十個作り、0〜9ms 後に消す）を使う。
// - 許可 Origin の外は、127.0.0.1 の別のポートの fixture のサーバで確かめる。別のサイト（OOPIF）は、同じ fixture のサーバを
//   別のホスト名（`localhost`）で読む。インターネット上のサイトは使わない。
import { chromium, type Browser, type BrowserContext, type CDPSession } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { chromiumLaunchOptions } from '../../src/browser/chromium-launch.js';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { INVALID_INTERCEPTION_ID_FAILURE_TEXTS } from '../../src/browser/playwright-errors.js';
import { ResourceCache, type ResourceDeliveryRole } from '../../src/browser/resource-delivery.js';
import type { Viewport } from '../../src/config/types.js';
import { wait } from '../../src/core/deadline.js';
import { createLoadMeter } from '../../src/crawl/load-meter.js';
import { isPassiveRequestGuardClosed } from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { oopifTargetUrls } from '../helpers/chromium.js';
import { crossSiteFramePath, crossSiteOriginOf } from '../helpers/external-scheme-fixture.js';
import { NO_NON_READ_REQUESTS, openServerWindow, type ServerWindow } from '../helpers/gate-harness.js';
import { closePassiveResources } from '../helpers/passive-cleanup.js';
import { createTestConfig } from '../helpers/test-config.js';

const viewport: Viewport = Object.freeze({ width: 800, height: 600 });
/** 読み込みの途中で iframe を消す fixture のページ。 */
const REMOVED_FRAMES_PAGE = '/removed-frames-while-loading.html';
/** fixture のページが作る iframe の数（DEF-026 の調査で毎回競合が起きた数）。 */
const REMOVED_FRAME_COUNT = 40;
/** i 番目の iframe を、作ってから `i % REMOVED_FRAME_SPREAD_MS` ms 後に消す（0〜9ms。DEF-026 の調査と同じ）。 */
const REMOVED_FRAME_SPREAD_MS = 10;
/**
 * ページの読み込みの後に待つ時間（ms）。Guard が取り消しの証拠を待つ時間（`CANCELED_DOCUMENT_EVIDENCE_WAIT_MS` の 500ms）の後に記録される
 * 違反と、Context を閉じる処理も見逃さないよう、その2倍待つ。
 */
const SETTLE_AFTER_LOAD_MS = 1_000;
/** 競合が起きなかった場合に、新しい Context で開き直す回数の上限（調査では毎回起きたので、ふつうは1回で済む）。 */
const MAX_RACE_ATTEMPTS = 3;
/** 多くの iframe を作るテストの上限（ms）。 */
const RACE_TEST_TIMEOUT_MS = 60_000;

let browser: Browser;
/** 許可 Origin のサーバ（ページと、同じ Origin・別のサイトの iframe）。 */
let allowedServer: FixtureServer;
/** 許可 Origin の外のサーバ（127.0.0.1 の別のポート）。 */
let outsideServer: FixtureServer;
let factory: BrowserContextFactory;
let tokenCounter = 0;

beforeAll(async () => {
  allowedServer = await startFixtureServer();
  outsideServer = await startFixtureServer();
  // CLI と同じ起動の設定（headless）。
  browser = await chromium.launch(chromiumLaunchOptions({ headless: true }));
  const config = createTestConfig(allowedServer.origin);
  // 読み込み直しの Context（`REVISIT`）の届け方の部品が働くよう、Run と同じく、Run 全体のキャッシュと負荷の記録を渡す。
  factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), {
    resourceCache: new ResourceCache(),
    loadMeter: createLoadMeter({ allowedOrigins: config.site.allowedOrigins, now: () => Date.now() }),
  });
});

afterAll(async () => {
  await browser?.close();
  await allowedServer?.close();
  await outsideServer?.close();
});

// Context の関数の差し替え（`vi.spyOn`）は、テストごとに元に戻す。
afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------------------------
// Guard の CDP の命令の観測（Guard のコードは変えない。Guard の CDP の session を Proxy で包み、命令と応答を記録するだけ）
// ---------------------------------------------------------------------------------------------------------------

type GuardCommandMethod = 'Fetch.continueRequest' | 'Fetch.failRequest';

/** Guard が一時停止した文書の要求に送った命令の、1件の記録。 */
interface GuardCommandEntry {
  /** 命令を送った session（`page`、または OOPIF の session の `page>…` の経路）。 */
  readonly session: string;
  readonly method: GuardCommandMethod;
  /** 一時停止の段階（応答の段階の項目があれば `Response`）。 */
  readonly stage: 'Request' | 'Response';
  readonly url: string;
  /** 失敗の文言。成功なら `null`、応答がまだなら `undefined`。 */
  failure: string | null | undefined;
}

const isGuardCommandMethod = (method: unknown): method is GuardCommandMethod =>
  method === 'Fetch.continueRequest' || method === 'Fetch.failRequest';

/** Guard の CDP の session（page と、その子の OOPIF の session）の、一時停止の通知と、命令と、その応答を記録する。 */
class GuardCommandLog {
  readonly entries: GuardCommandEntry[] = [];
  readonly #paused = new Map<string, { readonly stage: GuardCommandEntry['stage']; readonly url: string }>();
  readonly #nested = new Map<string, GuardCommandEntry>();

  /** `session` の `Fetch.requestPaused` を受けた。 */
  paused(session: string, event: unknown): void {
    const { requestId, request, responseStatusCode, responseErrorReason } = event as {
      readonly requestId: string;
      readonly request: { readonly url: string };
      readonly responseStatusCode?: number;
      readonly responseErrorReason?: string;
    };
    const stage = responseStatusCode !== undefined || responseErrorReason !== undefined ? 'Response' : 'Request';
    this.#paused.set(`${session}|${requestId}`, { stage, url: request.url });
  }

  /** `session` の `Target.receivedMessageFromTarget` を受けた（子の session の事象と応答。入れ子を含む）。 */
  received(session: string, event: unknown): void {
    const { sessionId, message } = event as { readonly sessionId: string; readonly message: string };
    const child = `${session}>${sessionId}`;
    const parsed = JSON.parse(message) as {
      readonly id?: number;
      readonly method?: string;
      readonly params?: unknown;
      readonly error?: { readonly message?: string };
    };
    if (parsed.method === 'Fetch.requestPaused') {
      this.paused(child, parsed.params);
    } else if (parsed.method === 'Target.receivedMessageFromTarget') {
      this.received(child, parsed.params);
    } else if (parsed.id !== undefined) {
      const entry = this.#nested.get(`${child}|${parsed.id}`);
      if (entry !== undefined) {
        this.#nested.delete(`${child}|${parsed.id}`);
        entry.failure = parsed.error === undefined ? null : String(parsed.error.message);
      }
    }
  }

  /**
   * page の session に送る命令を見る。page の session の Guard の命令なら、その記録を返す（応答は呼び出し側が `settle` で記録する）。
   * 子の session への Guard の命令（`Target.sendMessageToTarget` の中。入れ子を含む）なら、記録を作って応答を待ち、`null` を返す。
   */
  sent(method: string, params: unknown): GuardCommandEntry | null {
    if (isGuardCommandMethod(method)) {
      return this.#start('page', method, (params as { readonly requestId: string }).requestId);
    }
    if (method !== 'Target.sendMessageToTarget') {
      return null;
    }
    let session = 'page';
    let current = params as { readonly sessionId: string; readonly message: string };
    for (;;) {
      session = `${session}>${current.sessionId}`;
      const inner = JSON.parse(current.message) as { readonly id: number; readonly method: string; readonly params: unknown };
      if (inner.method === 'Target.sendMessageToTarget') {
        current = inner.params as typeof current;
        continue;
      }
      if (isGuardCommandMethod(inner.method)) {
        const entry = this.#start(session, inner.method, (inner.params as { readonly requestId: string }).requestId);
        this.#nested.set(`${session}|${inner.id}`, entry);
      }
      return null;
    }
  }

  /** page の session の命令の結果を記録する。 */
  settle(entry: GuardCommandEntry, failure: string | null): void {
    entry.failure = failure;
  }

  /** 失敗した命令の記録。 */
  failures(): readonly GuardCommandEntry[] {
    return this.entries.filter((entry) => typeof entry.failure === 'string');
  }

  #start(session: string, method: GuardCommandMethod, requestId: string): GuardCommandEntry {
    const paused = this.#paused.get(`${session}|${requestId}`);
    const entry: GuardCommandEntry = {
      session,
      method,
      stage: paused?.stage ?? 'Request',
      url: paused?.url ?? '',
      failure: undefined,
    };
    this.entries.push(entry);
    return entry;
  }
}

/** `observeGuardSession` の指定。 */
interface GuardSessionObservation {
  readonly log: GuardCommandLog;
  /** 真なら、Guard が page の session に付ける `Network.loadingFailed` の listener を、付けずに捨てる（取り消しの証拠を落とす差し替え）。 */
  readonly dropLoadingFailed?: boolean;
}

/** Guard の page の CDP の session を、命令と応答を記録する Proxy で包む。 */
function observeGuardSession(real: CDPSession, { log, dropLoadingFailed = false }: GuardSessionObservation): CDPSession {
  // Guard の listener より先に付けるので、Guard より先に一時停止の通知と子の session の応答を記録できる。
  real.on('Fetch.requestPaused', (event) => log.paused('page', event));
  real.on('Target.receivedMessageFromTarget', (event) => log.received('page', event));
  return new Proxy(real, {
    get(target, property, receiver): unknown {
      if (property === 'send') {
        return async (method: string, params?: object): Promise<unknown> => {
          const send = target.send.bind(target) as (name: string, parameters?: object) => Promise<unknown>;
          const entry = log.sent(method, params);
          if (entry === null) {
            return send(method, params);
          }
          try {
            const result = await send(method, params);
            log.settle(entry, null);
            return result;
          } catch (error) {
            log.settle(entry, error instanceof Error ? error.message : String(error));
            throw error;
          }
        };
      }
      if (dropLoadingFailed && (property === 'on' || property === 'off')) {
        const original = (Reflect.get(target, property, receiver) as (event: string, listener: unknown) => unknown).bind(target);
        return (event: string, listener: unknown): unknown => (event === 'Network.loadingFailed' ? receiver : original(event, listener));
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------
// 開くページ
// ---------------------------------------------------------------------------------------------------------------

/** 読み込みの途中で iframe を消すページの、iframe の置き場所。 */
type RemovedFramesScenario = 'SAME_ORIGIN' | 'OUTSIDE_ALLOWED_ORIGIN' | 'NESTED_IN_OOPIF';

/** 1回の試行で使う、iframe のパスの印（試行ごとに違う値。英数字と `-`）。 */
function nextToken(scenario: RemovedFramesScenario, role: ResourceDeliveryRole): string {
  tokenCounter += 1;
  return `${scenario.toLowerCase().replaceAll('_', '-')}-${role.toLowerCase()}-${tokenCounter}`;
}

/** iframe を消すページの、許可 Origin のサーバの中のパス（クエリを含む）。 */
function removedFramesPath(scenario: RemovedFramesScenario, token: string): string {
  const query = new URLSearchParams({
    count: String(REMOVED_FRAME_COUNT),
    spread: String(REMOVED_FRAME_SPREAD_MS),
    token,
    ...(scenario === 'OUTSIDE_ALLOWED_ORIGIN' ? { target: outsideServer.origin } : {}),
  });
  const path = `${REMOVED_FRAMES_PAGE}?${query.toString()}`;
  // OOPIF の中の入れ子: 別のサイト（`localhost`）の iframe の中で、そのページが同じサイトの iframe を作って消す。
  return scenario === 'NESTED_IN_OOPIF' ? crossSiteFramePath(path) : path;
}

/** 1回の試行の結果。 */
interface RemovedFramesAttempt {
  readonly log: GuardCommandLog;
  readonly invariantViolations: readonly { readonly code: string; readonly message: string }[];
  readonly closed: boolean;
  readonly oopifTargets: readonly string[];
  /** 要求の URL の Origin を受けるサーバの、試行の始めからの記録。 */
  readonly windowOf: (url: string) => ServerWindow;
  readonly allowedWindow: ServerWindow;
  readonly outsideWindow: ServerWindow;
}

/**
 * `role` の Guard の付いた Context で、iframe を消すページを開き、読み込みの後に `SETTLE_AFTER_LOAD_MS` 待って、結果を返す。
 * 終わったら page と Context を閉じる。
 */
async function openRemovedFramesPage(
  scenario: RemovedFramesScenario,
  role: ResourceDeliveryRole,
  options: { readonly dropLoadingFailed?: boolean } = {},
): Promise<RemovedFramesAttempt> {
  const log = new GuardCommandLog();
  const allowedWindow = openServerWindow(allowedServer);
  const outsideWindow = openServerWindow(outsideServer);
  const context: BrowserContext = await factory.createPassiveContext(viewport, role);
  const page = await (async () => {
    const original = context.newCDPSession.bind(context);
    vi.spyOn(context, 'newCDPSession').mockImplementation(async (target) => observeGuardSession(await original(target), {
      log,
      ...(options.dropLoadingFailed === undefined ? {} : { dropLoadingFailed: options.dropLoadingFailed }),
    }));
    return factory.createPassivePage(context);
  })();
  try {
    const ledger = factory.getSafetyLedger(context);
    await page.goto(`${allowedServer.origin}${removedFramesPath(scenario, nextToken(scenario, role))}`, { waitUntil: 'load' })
      .catch(() => undefined);
    await wait(SETTLE_AFTER_LOAD_MS);
    const { invariantViolations } = ledger.snapshot();
    return {
      log,
      invariantViolations,
      closed: isPassiveRequestGuardClosed(context),
      oopifTargets: await oopifTargetUrls(browser),
      windowOf: (url) => (new URL(url).origin === outsideServer.origin ? outsideWindow : allowedWindow),
      allowedWindow,
      outsideWindow,
    };
  } finally {
    await closePassiveResources({ factory, context, page });
  }
}

/** 試行で、確かめたい競合（Guard の命令が失敗した）が起きたか。OOPIF の中の入れ子では、OOPIF の session で起きたことを求める。 */
function raceObserved(scenario: RemovedFramesScenario, attempt: RemovedFramesAttempt): boolean {
  const failures = attempt.log.failures();
  return scenario === 'NESTED_IN_OOPIF'
    ? failures.some((entry) => entry.session !== 'page')
    : failures.length > 0;
}

// ---------------------------------------------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------------------------------------------

const SCENARIOS = [
  ['SAME_ORIGIN', 'PRIMARY'],
  ['SAME_ORIGIN', 'REVISIT'],
  ['OUTSIDE_ALLOWED_ORIGIN', 'PRIMARY'],
  ['OUTSIDE_ALLOWED_ORIGIN', 'REVISIT'],
  ['NESTED_IN_OOPIF', 'PRIMARY'],
  ['NESTED_IN_OOPIF', 'REVISIT'],
] as const satisfies readonly (readonly [RemovedFramesScenario, ResourceDeliveryRole])[];

describe('DEF-026: a document request that the browser canceled while the Guard paused it is not a violation', () => {
  it.each(SCENARIOS)('%s iframes removed while loading, %s Context: no violation, the Context stays open, and the canceled requests never reach the server', async (
    scenario,
    role,
  ) => {
    let attempt: RemovedFramesAttempt | undefined;
    for (let index = 0; index < MAX_RACE_ATTEMPTS; index += 1) {
      attempt = await openRemovedFramesPage(scenario, role);
      // 修正の前は、ここで `CDP_CONTINUE_REQUEST_FAILED`（`Invalid InterceptionId`）が記録され、Guard が Context を閉じる（RED）。
      expect(attempt.invariantViolations, `Safety Ledger violations: ${JSON.stringify(attempt.invariantViolations)}`).toEqual([]);
      expect(attempt.closed).toBe(false);
      if (raceObserved(scenario, attempt)) {
        break;
      }
    }
    if (attempt === undefined) throw new Error('no attempt was made');
    // 競合が実際に起きた（Guard の命令が、一時停止の ID が無効なために失敗した）。起きなければ、このテストは何も確かめていない。
    expect(raceObserved(scenario, attempt), `Guard commands: ${JSON.stringify(attempt.log.entries)}`).toBe(true);
    const failures = attempt.log.failures();
    // 失敗は、すべて一時停止の ID が無効な形（ブラウザが取り消した要求）である。ほかの失敗は起きていない。
    expect(failures.every((entry) => (INVALID_INTERCEPTION_ID_FAILURE_TEXTS as readonly string[]).includes(entry.failure ?? '')), JSON.stringify(failures))
      .toBe(true);
    // Request の段階で取り消された要求は、サーバに届かなかった。
    for (const entry of failures.filter(({ stage }) => stage === 'Request')) {
      expect(attempt.windowOf(entry.url).count(null, new URL(entry.url).pathname), `${entry.url} reached the server`).toBe(0);
    }
    // iframe の置き場所の確かめ。
    if (scenario === 'OUTSIDE_ALLOWED_ORIGIN') {
      expect(failures.every((entry) => new URL(entry.url).origin === outsideServer.origin)).toBe(true);
    }
    if (scenario === 'NESTED_IN_OOPIF') {
      expect(attempt.oopifTargets.some((url) => url.startsWith(`${crossSiteOriginOf(allowedServer.origin)}/`))).toBe(true);
    }
    expect(attempt.allowedWindow.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
    expect(attempt.outsideWindow.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
  }, RACE_TEST_TIMEOUT_MS);

  it('control: when the cancellation evidence (Network.loadingFailed) never reaches the Guard, the failed command stays a violation and the Context closes', async () => {
    let attempt: RemovedFramesAttempt | undefined;
    for (let index = 0; index < MAX_RACE_ATTEMPTS; index += 1) {
      attempt = await openRemovedFramesPage('SAME_ORIGIN', 'PRIMARY', { dropLoadingFailed: true });
      if (raceObserved('SAME_ORIGIN', attempt)) {
        break;
      }
    }
    if (attempt === undefined) throw new Error('no attempt was made');
    expect(raceObserved('SAME_ORIGIN', attempt), `Guard commands: ${JSON.stringify(attempt.log.entries)}`).toBe(true);
    expect(attempt.invariantViolations).toContainEqual({
      code: 'CDP_CONTINUE_REQUEST_FAILED',
      message: 'cdpSession.send: Protocol error (Fetch.continueRequest): Invalid InterceptionId.',
    });
    expect(attempt.closed).toBe(true);
  }, RACE_TEST_TIMEOUT_MS);
});
