// DEF-124（Critical）: ページの JS の WebRTC（STUN・TURN の UDP と TCP・TLS、ICE の接続の確かめ）は、Guard の route も CDP の横取りも通らずに
// サーバへ届き（UDP は出口の中継も通らない。TCP は中継の CONNECT を通るが中身は見えない）、TURN の `username` もそのままの形で届いていた。
// 本物の factory と Guard と、127.0.0.1 の自前の UDP と TCP の受け口（`startWebRtcLeakListeners`）で確かめる。Chromium は headless だけ
// （テストの既定の headless shell と、CLI の起動の設定の `channel: 'chromium'` の両方）。
// - (主) Guard の初期化のスクリプト（`WEBRTC_BLOCK_INIT_SCRIPT`）が、Passive・Interaction・ログインの段（自動ログイン）・監査の段・書き込みの段の
//   Context のすべての文書で、WebRTC の入口を塞ぐ。試みは、どれも `WEBRTC_BLOCKED_MESSAGE` の例外になり（止める経路が働いた証拠）、試みのたびに
//   UDP にも TCP にも届かない。全部の後に名前つきの時間（`LATE_DELIVERY_SETTLE_MS`）だけ待って数え直す。
// - (重ね) 起動の引数（`CHROMIUM_WEBRTC_NON_PROXIED_UDP_DISABLED_ARGS`）が、初期化のスクリプトを外した Context でも、UDP を止める（ICE の UDP の
//   候補が 0 になることが、止める経路が働いた証拠）。
// - (対照) 両方の守りを外すと、同じ STUN の試みが UDP の受け口に届く（受け口と試みが、この環境で意味を持つことの確かめ）。
// インターネットへは出ない（STUN・TURN・ICE の宛先は、127.0.0.1 の自前の受け口だけ）。
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHROMIUM_SHARED_WORKERS_DISABLED_ARGS, CHROMIUM_WEBRTC_NON_PROXIED_UDP_DISABLED_ARGS, chromiumLaunchOptions } from '../../src/browser/chromium-launch.js';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { Viewport } from '../../src/config/types.js';
import { wait } from '../../src/core/deadline.js';
import { WEBRTC_BLOCKED_MESSAGE } from '../../src/core/guard-page-exceptions.js';
import { createLoginCredentialGuard } from '../../src/safety/login-credential-guard.js';
import {
  LoginStageMonitor,
  WriteStageMonitor,
} from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { browserWithoutWebRtcBlock } from '../helpers/browser-proxies.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { TEST_FACTORY_OPTIONS, createTestConfig } from '../helpers/test-config.js';
import { startWebRtcLeakListeners, type WebRtcLeakListeners } from '../helpers/webrtc-leak-listeners.js';

const LAUNCHERS = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI launch settings', () => launchCliChromium()],
] as const;

/**
 * 両方の守り（起動の引数と初期化のスクリプト）を外した対照の起動。テストの既定（headless shell）は Shared Worker の引数だけ、CLI の起動の設定は
 * WebRTC の引数を除いたもの。
 */
const UNPROTECTED_LAUNCHERS = [
  ['the default test Chromium', () => chromium.launch({ headless: true, args: [...CHROMIUM_SHARED_WORKERS_DISABLED_ARGS] })],
  ['the CLI launch settings', () => {
    const options = chromiumLaunchOptions({ headless: true });
    const webRtcArgs: readonly string[] = CHROMIUM_WEBRTC_NON_PROXIED_UDP_DISABLED_ARGS;
    return chromium.launch({ ...options, args: (options.args ?? []).filter((arg) => !webRtcArgs.includes(arg)) });
  }],
] as const;

const VIEWPORT: Viewport = Object.freeze({ width: 1280, height: 800 });
/** 1 回の試みの後、UDP・TCP の受け口に届くのを待つ時間（ms）。直す前は、STUN のパケットが待つ間に届いた。 */
const ATTEMPT_SETTLE_MS = 1_000;
/** 全部の試みの後（Context を閉じた後）に、遅れて届くものを見逃さないために待つ時間（ms）。 */
const LATE_DELIVERY_SETTLE_MS = 2_000;
/** srcdoc の iframe の中の試みの結果を待つ上限（ms）。 */
const FRAME_RESULT_TIMEOUT_MS = 5_000;
/** ICE の候補の収集の終わりを待つ上限（ms）。 */
const GATHERING_TIMEOUT_MS = 5_000;
/** 1 つの Context の試みのすべての期限（ms）。 */
const CONTEXT_TEST_TIMEOUT_MS = 90_000;
/** TURN の `username` と `credential`（テストの仮の値。そのままの形で届くかを数える）。 */
const TURN_USERNAME = 'def124-turn-user';
const TURN_CREDENTIAL = 'def124-turn-secret';
/** 同じ Origin の iframe の文書のパス。 */
const FRAME_PATH = '/frame.html';
/** ログインの段（自動ログイン）の資格情報の部品に入れる値（テストの仮の値）。 */
const LOGIN_CREDENTIALS = Object.freeze({ username: 'def124.user@example.test', password: 'Def124Pass9' });
/** 塞いだ入口の試みの結果。 */
const BLOCKED_RESULT = `threw:${WEBRTC_BLOCKED_MESSAGE}`;

/** `RTCPeerConnection` の作成から、offer を自分の記述にする（ICE の収集が始まる）まで行う式。結果は `ok` か `threw:<文言>`。 */
const connectWith = (constructorExpression: string, configuration: string): string => `(async () => {
  try {
    const Constructor = ${constructorExpression};
    const connection = new Constructor(${configuration});
    connection.createDataChannel('def124');
    await connection.setLocalDescription(await connection.createOffer());
    (globalThis.__def124Connections ??= []).push(connection);
    return 'ok';
  } catch (error) {
    return 'threw:' + (error && error.message);
  }
})()`;

/** 2 つの `RTCPeerConnection` で記述を交わし、`udpPort` の UDP を相手の ICE の候補として足す式（ICE の接続の確かめが、その宛先へ出る）。 */
const remoteCandidateAttempt = (udpPort: number): string => `(async () => {
  try {
    const local = new RTCPeerConnection();
    const remote = new RTCPeerConnection();
    local.createDataChannel('def124');
    const offer = await local.createOffer();
    await local.setLocalDescription(offer);
    await remote.setRemoteDescription(offer);
    const answer = await remote.createAnswer();
    await remote.setLocalDescription(answer);
    await local.setRemoteDescription(answer);
    await local.addIceCandidate({ candidate: 'candidate:1 1 udp 2122260223 127.0.0.1 ${udpPort} typ host generation 0', sdpMid: '0', sdpMLineIndex: 0 });
    (globalThis.__def124Connections ??= []).push(local, remote);
    return 'ok';
  } catch (error) {
    return 'threw:' + (error && error.message);
  }
})()`;

/** ICE の候補の収集の終わりまで待ち、集まった UDP の候補の数を返す式。結果は `gathered:<数>` か `threw:<文言>`。 */
const gatherUdpCandidates = (configuration: string): string => `(async () => {
  try {
    const connection = new RTCPeerConnection(${configuration});
    let udpCandidates = 0;
    const done = new Promise((resolve) => {
      connection.addEventListener('icecandidate', (event) => {
        if (event.candidate === null) {
          resolve();
        } else if (event.candidate.protocol === 'udp') {
          udpCandidates += 1;
        }
      });
      setTimeout(resolve, ${GATHERING_TIMEOUT_MS});
    });
    connection.createDataChannel('def124');
    await connection.setLocalDescription(await connection.createOffer());
    await done;
    (globalThis.__def124Connections ??= []).push(connection);
    return 'gathered:' + udpCandidates;
  } catch (error) {
    return 'threw:' + (error && error.message);
  }
})()`;

const stunConfiguration = (listeners: WebRtcLeakListeners): string =>
  `{ iceServers: [{ urls: 'stun:127.0.0.1:${listeners.udpPort}' }] }`;
const turnConfiguration = (url: string): string =>
  `{ iceServers: [{ urls: '${url}', username: '${TURN_USERNAME}', credential: '${TURN_CREDENTIAL}' }] }`;
const turnUdpConfiguration = (listeners: WebRtcLeakListeners): string =>
  turnConfiguration(`turn:127.0.0.1:${listeners.udpPort}?transport=udp`);

/** 1 つの試み（名前と、ページで評価する式）。 */
interface WebRtcAttempt {
  readonly name: string;
  readonly expression: (listeners: WebRtcLeakListeners) => string;
}

/**
 * 塞いだ入口の試みの一覧（上から順に、同じ page で行う）。ポップアップは、Guard が Context を閉じうるので、最後にする。
 * 直す前は、どれも `ok` になり、UDP または TCP の受け口に届いた。
 */
const BLOCKED_ATTEMPTS: readonly WebRtcAttempt[] = [
  { name: 'STUN over UDP', expression: (listeners) => connectWith('RTCPeerConnection', stunConfiguration(listeners)) },
  { name: 'TURN over UDP with a username', expression: (listeners) => connectWith('RTCPeerConnection', turnUdpConfiguration(listeners)) },
  {
    name: 'TURN over TCP with a username',
    expression: (listeners) => connectWith('RTCPeerConnection', turnConfiguration(`turn:127.0.0.1:${listeners.tcpPort}?transport=tcp`)),
  },
  {
    name: 'TURN over TLS (turns:) with a username',
    expression: (listeners) => connectWith('RTCPeerConnection', turnConfiguration(`turns:127.0.0.1:${listeners.tcpPort}?transport=tcp`)),
  },
  { name: 'ICE checks to a remote UDP candidate', expression: (listeners) => remoteCandidateAttempt(listeners.udpPort) },
  { name: 'the prefixed webkitRTCPeerConnection', expression: (listeners) => connectWith('webkitRTCPeerConnection', stunConfiguration(listeners)) },
  {
    name: 'the constructor of the prototype',
    expression: (listeners) => connectWith('RTCPeerConnection.prototype.constructor', stunConfiguration(listeners)),
  },
  {
    name: 'deleting and redefining the global with the one of another realm',
    expression: (listeners) => `(() => {
      const frame = document.createElement('iframe');
      document.body.append(frame);
      try { delete globalThis.RTCPeerConnection; } catch (error) {}
      try { Object.defineProperty(globalThis, 'RTCPeerConnection', { value: frame.contentWindow.RTCPeerConnection, configurable: true, writable: true }); } catch (error) {}
      return ${connectWith('globalThis.RTCPeerConnection', stunConfiguration(listeners))};
    })()`,
  },
  {
    name: 'a same-origin iframe',
    expression: (listeners) => `new Promise((resolve) => {
      const frame = document.createElement('iframe');
      frame.src = '${FRAME_PATH}';
      frame.addEventListener('load', () => resolve(${connectWith('frame.contentWindow.RTCPeerConnection', stunConfiguration(listeners))}), { once: true });
      document.body.append(frame);
    })`,
  },
  {
    name: 'an about:blank iframe used synchronously',
    expression: (listeners) => `(() => {
      const frame = document.createElement('iframe');
      document.body.append(frame);
      return ${connectWith('frame.contentWindow.RTCPeerConnection', stunConfiguration(listeners))};
    })()`,
  },
  {
    name: 'the own script of a srcdoc iframe',
    expression: (listeners) => `new Promise((resolve) => {
      const onMessage = (event) => {
        if (event.data !== null && typeof event.data === 'object' && typeof event.data.def124 === 'string') {
          removeEventListener('message', onMessage);
          resolve(event.data.def124);
        }
      };
      addEventListener('message', onMessage);
      const frame = document.createElement('iframe');
      frame.srcdoc = ${JSON.stringify(`<script>${connectWith('RTCPeerConnection', stunConfiguration(listeners))}.then((result) => parent.postMessage({ def124: result }, '*'));</script>`)};
      document.body.append(frame);
      setTimeout(() => resolve('no-result'), ${FRAME_RESULT_TIMEOUT_MS});
    })`,
  },
  {
    name: 'a popup (window.open) used synchronously',
    expression: (listeners) => `(() => {
      const popup = window.open('about:blank');
      if (popup === null) {
        return 'no-popup';
      }
      return ${connectWith('popup.RTCPeerConnection', stunConfiguration(listeners))};
    })()`,
  },
];

/** UDP だけを使う試み（起動の引数の守りを確かめる）。結果は、初期化のスクリプトを外しているので、入口が開いている。 */
const UDP_ATTEMPTS: readonly (WebRtcAttempt & { readonly expected: string })[] = [
  { name: 'STUN over UDP', expression: (listeners) => gatherUdpCandidates(stunConfiguration(listeners)), expected: 'gathered:0' },
  { name: 'TURN over UDP with a username', expression: (listeners) => gatherUdpCandidates(turnUdpConfiguration(listeners)), expected: 'gathered:0' },
  { name: 'ICE checks to a remote UDP candidate', expression: (listeners) => remoteCandidateAttempt(listeners.udpPort), expected: 'ok' },
];

/** 1 つの試みの結果（結果の文字列と、その試みの間に届いた数）。 */
interface AttemptOutcome {
  readonly attempt: string;
  readonly result: string;
  readonly udpPackets: number;
  readonly tcpConnections: number;
}

/** `page` で `attempts` を順に行い、試みごとに `ATTEMPT_SETTLE_MS` 待って、その間に届いた数を記録する。評価の失敗も結果にする。 */
async function runAttempts(page: Page, listeners: WebRtcLeakListeners, attempts: readonly WebRtcAttempt[]): Promise<AttemptOutcome[]> {
  const outcomes: AttemptOutcome[] = [];
  for (const attempt of attempts) {
    const udpBefore = listeners.udpPackets();
    const tcpBefore = listeners.tcpConnections();
    let result: string;
    try {
      result = String(await page.evaluate(attempt.expression(listeners)));
    } catch (error) {
      result = `evaluate-failed:${error instanceof Error ? error.message.split('\n')[0] : String(error)}`;
    }
    await wait(ATTEMPT_SETTLE_MS);
    outcomes.push({
      attempt: attempt.name,
      result,
      udpPackets: listeners.udpPackets() - udpBefore,
      tcpConnections: listeners.tcpConnections() - tcpBefore,
    });
  }
  return outcomes;
}

/** ページと同じ Origin の文書を返す、127.0.0.1 のサーバ（どのパスにも同じ HTML）。 */
const startPageServer = (): Promise<LoopbackHttpServer> => startLoopbackHttpServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><html><head><title>DEF-124</title></head><body><p>DEF-124</p></body></html>');
});

/** 開いた Context（page、その Ledger、閉じる処理）。 */
interface OpenedContext {
  readonly page: Page;
  readonly ledger: SafetyLedger;
  close(): Promise<void>;
}

/** 試す Context の種類。 */
const CONTEXT_KINDS = ['Passive', 'Interaction', 'login stage (automated login)', 'audit stage', 'write stage'] as const;
type ContextKind = (typeof CONTEXT_KINDS)[number];

/** 監査の段（認証つきの factory）の指定。ログインの後の状態の代わりに、仮の Cookie を 1 つ持つ。 */
const AUTHENTICATION = Object.freeze({
  initialState: {
    cookies: [{
      name: 'sid',
      value: 'def124-session',
      domain: '127.0.0.1',
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: false,
      sameSite: 'Lax' as const,
    }],
    origins: [],
  },
  filterState: <State>(state: State): State => state,
  auditExclusions: { excludedPathPrefixes: [], auditPathPrefixes: [], dangerousTerms: [] },
});

/** `kind` の Context を、本物の factory で開く。 */
async function openContext(browser: Browser, origin: string, kind: ContextKind, factories: BrowserContextFactory[]): Promise<OpenedContext> {
  const authenticated = kind === 'audit stage' || kind === 'write stage';
  const factory = new BrowserContextFactory(browser, createTestConfig(origin, '/'), () => new SafetyLedger(), {
    ...TEST_FACTORY_OPTIONS,
    ...(authenticated ? { authentication: AUTHENTICATION } : {}),
  });
  factories.push(factory);
  if (kind === 'Interaction') {
    const session = await factory.createInteractionSession(VIEWPORT);
    return { page: session.page, ledger: session.ledger, close: () => session.close() };
  }
  let context: BrowserContext;
  if (kind === 'login stage (automated login)') {
    context = await factory.createLoginStageContext(VIEWPORT, {
      loginPostEndpoints: [],
      maxLoginPosts: 1,
      monitor: new LoginStageMonitor(),
      scriptRequest: {
        scriptLogin: { origin, path: '/token', requiredQuery: [] },
        loginSideRequests: [],
        approvedServiceOrigins: [],
      },
      credentialGuard: createLoginCredentialGuard(LOGIN_CREDENTIALS),
    });
  } else if (kind === 'write stage') {
    context = await factory.createWriteStageContext(VIEWPORT, {
      expectation: {
        request: { origin, path: '/create', enctype: 'application/x-www-form-urlencoded' },
        submittedFields: [{ name: 'memo', value: 'def124' }],
        passthroughFieldNames: [],
        emptyFileFieldNames: [],
      },
      monitor: new WriteStageMonitor(),
    });
  } else {
    context = await factory.createPassiveContext(VIEWPORT);
  }
  const page = await factory.createPassivePage(context);
  return { page, ledger: factory.getSafetyLedger(context), close: () => factory.closePassiveContext(context) };
}

describe.each(LAUNCHERS)('DEF-124: the Guard blocks the WebRTC entry points in every Context (%s)', (launcherName, launch) => {
  let browser: Browser;
  const factories: BrowserContextFactory[] = [];

  beforeAll(async () => {
    browser = await launch();
  });

  afterAll(async () => {
    await Promise.all(factories.splice(0).map((factory) => factory.close()));
    await browser?.close();
  });

  it.each(CONTEXT_KINDS)('the %s Context: every attempt throws the blocked message and nothing reaches the UDP or TCP listener', async (kind) => {
    const listeners = await startWebRtcLeakListeners();
    const server = await startPageServer();
    let outcomes: AttemptOutcome[] = [];
    let invariantViolations: readonly unknown[] = [];
    try {
      const opened = await openContext(browser, server.origin, kind, factories);
      try {
        await opened.page.goto(`${server.origin}/`);
        outcomes = await runAttempts(opened.page, listeners, BLOCKED_ATTEMPTS);
        invariantViolations = opened.ledger.snapshot().invariantViolations;
      } finally {
        await opened.close();
      }
      await wait(LATE_DELIVERY_SETTLE_MS);
      console.info(`DEF-124 ${launcherName} / ${kind}: ${JSON.stringify(outcomes)} (after the wait: udp ${listeners.udpPackets()}, tcp ${
        listeners.tcpConnections()}, the TURN username carried ${listeners.carrying(TURN_USERNAME)})`);
      expect(outcomes).toEqual(BLOCKED_ATTEMPTS.map(({ name }) => ({ attempt: name, result: BLOCKED_RESULT, udpPackets: 0, tcpConnections: 0 })));
      expect(listeners.udpPackets()).toBe(0);
      expect(listeners.tcpConnections()).toBe(0);
      expect(listeners.carrying(TURN_USERNAME)).toBe(0);
      expect(invariantViolations).toEqual([]);
    } finally {
      await server.close();
      await listeners.close();
    }
  }, CONTEXT_TEST_TIMEOUT_MS);
});

describe.each(LAUNCHERS)('DEF-124: the launch arguments stop the non-proxied UDP of WebRTC without the init script (%s)', (launcherName, launch) => {
  let browser: Browser;
  const factories: BrowserContextFactory[] = [];

  beforeAll(async () => {
    browser = browserWithoutWebRtcBlock(await launch());
  });

  afterAll(async () => {
    await Promise.all(factories.splice(0).map((factory) => factory.close()));
    await browser?.close();
  });

  it('gathers no UDP candidate and sends nothing to the UDP listener, although the entry point is open', async () => {
    const listeners = await startWebRtcLeakListeners();
    const server = await startPageServer();
    try {
      const opened = await openContext(browser, server.origin, 'Passive', factories);
      let outcomes: AttemptOutcome[] = [];
      try {
        await opened.page.goto(`${server.origin}/`);
        outcomes = await runAttempts(opened.page, listeners, UDP_ATTEMPTS);
      } finally {
        await opened.close();
      }
      await wait(LATE_DELIVERY_SETTLE_MS);
      console.info(`DEF-124 (launch arguments) ${launcherName}: ${JSON.stringify(outcomes)} (after the wait: udp ${listeners.udpPackets()})`);
      expect(outcomes).toEqual(UDP_ATTEMPTS.map(({ name, expected }) => ({ attempt: name, result: expected, udpPackets: 0, tcpConnections: 0 })));
      expect(listeners.udpPackets()).toBe(0);
      expect(listeners.carrying(TURN_USERNAME)).toBe(0);
    } finally {
      await server.close();
      await listeners.close();
    }
  }, CONTEXT_TEST_TIMEOUT_MS);
});

describe.each(UNPROTECTED_LAUNCHERS)('DEF-124 (control): without both protections, STUN reaches the UDP listener (%s)', (launcherName, launch) => {
  let browser: Browser;
  const factories: BrowserContextFactory[] = [];

  beforeAll(async () => {
    browser = browserWithoutWebRtcBlock(await launch());
  });

  afterAll(async () => {
    await Promise.all(factories.splice(0).map((factory) => factory.close()));
    await browser?.close();
  });

  it('opens a connection and the STUN packets reach the UDP listener', async () => {
    const listeners = await startWebRtcLeakListeners();
    const server = await startPageServer();
    try {
      const opened = await openContext(browser, server.origin, 'Passive', factories);
      let outcomes: AttemptOutcome[] = [];
      try {
        await opened.page.goto(`${server.origin}/`);
        outcomes = await runAttempts(opened.page, listeners, [BLOCKED_ATTEMPTS[0]!]);
      } finally {
        await opened.close();
      }
      console.info(`DEF-124 (control) ${launcherName}: ${JSON.stringify(outcomes)}`);
      expect(outcomes[0]?.result).toBe('ok');
      expect(listeners.udpPackets()).toBeGreaterThan(0);
    } finally {
      await server.close();
      await listeners.close();
    }
  }, CONTEXT_TEST_TIMEOUT_MS);
});
