/**
 * ページ本体の要求の観察の唯一の owner（サイトの不調で止めたときの診断の記録の設計書 2.1）。
 * Passive の読み込みの間、Guard とは別の CDP の session で、main frame の文書の要求の事象（発行、ヘッダの送信、応答、終わり・失敗）を
 * 観察し、要求ごとの記録（`NavigationDiagnostics`。型の owner は `src/core/contracts.ts`）にする。サイトの不調で止まったときに、
 * 要求がネットワークへ送られたかを見分けるための記録である。
 *
 * - 観察の session に、この部品が自分で送る命令は、閉じた一覧（`NAVIGATION_DIAGNOSTICS_CDP_COMMANDS`）の、main frame の ID を読む
 *   命令と `Network.enable` だけである。Fetch の domain は使わない（要求を止めたり、変えたり、作ったりしない）。Playwright 自身が
 *   session の開閉で送る命令は、`NAVIGATION_DIAGNOSTICS_CDP_COMMANDS` の説明に書く。
 * - 要求と応答の header の中身と、本文は記録しない（Cookie を含むため）。
 * - 判定はしない（サイトの不調の判定は `src/orchestration/site-availability.ts`）。
 */
import { isIP } from 'node:net';
import type { CDPSession, Page } from 'playwright';
import type {
  NavigationDiagnostics,
  NavigationDocumentLoadingFailure,
  NavigationDocumentRequestDiagnostics,
  NavigationDocumentRequestHop,
  ObservedNavigationDiagnostics,
} from '../core/contracts.js';
import { awaitBeforeDeadline } from '../core/deadline.js';
import { ERROR_MESSAGE_FALLBACK, safeErrorMessage } from '../core/errors.js';
import { isNonNegativeSafeInteger, isRecord } from '../core/guards.js';
import { deepFreeze } from '../core/immutable.js';
import { MAX_ERROR_MESSAGE_LENGTH, MAX_HTTP_METHOD_LENGTH, MAX_URL_LENGTH } from '../core/limits.js';
import { truncateText } from '../core/text.js';

/**
 * 1回の観察（1つのビューポートの Passive の読み込み）で記録する、main frame の文書の要求の最大件数（設計書 2.1）。超えた要求は、
 * 数だけを記録する（`omittedDocumentRequestCount`）。
 * 値の根拠: 1回の読み込みの文書の要求は、ふつう1件で、リダイレクトは同じ要求の続きとして記録するので、件数を増やさない。ページの
 * スクリプトによる移動（`location.replace` の連続など）を数件記録しても余る数にした（設計者の決定）。
 */
export const MAX_NAVIGATION_DIAGNOSTICS_DOCUMENT_REQUESTS = 16;

/**
 * 1回の観察で記録する、文書の要求の事象（`Network.*` の事象1件）の最大件数（設計書 2.1）。超えた事象は、数だけを記録する
 * （`omittedEventCount`）。記録しなかった要求の事象は、数えない（その要求は `omittedDocumentRequestCount` に数える）。
 * 値の根拠: 1回分の要求（リダイレクトを含まない）の事象は、発行、ヘッダの送信、応答の2つ、終わりの5件ほどである。文書の要求の上限の
 * 全部に、リダイレクトを1回ずつ含めても収まる数にした（設計者の決定）。
 */
export const MAX_NAVIGATION_DIAGNOSTICS_EVENTS = 128;

/** main frame の CDP の frame の ID を読む命令（読むだけで、状態を変えない）。 */
const FRAME_TREE_COMMAND = 'Page.getFrameTree';
/** Network の事象を受けるための命令。要求を止めたり変えたりしない。 */
const NETWORK_ENABLE_COMMAND = 'Network.enable';

/**
 * 観察の session に、この部品が自分で送る命令の閉じた一覧（設計書 2.1、3章: 安全の不変条件を変えない）。この部品が自分で送る命令は、
 * この2つだけである（session を閉じる `detach` の呼び出しを除く）。Fetch の domain を使わないので、要求を止めたり、変えたり、
 * 作ったりしない。
 * ほかに、session を開くとき（`newCDPSession`）と閉じるとき（`detach`）に、Playwright 自身が `Target.attachToTarget`（root の
 * session に）、`Runtime.runIfWaitingForDebugger`、`Target.detachFromTarget` を送る。どれも要求を止めたり変えたりしない（設計書 2.1 の
 * 2026-10-06 の追補。PCR-DR の Minor-2）。
 */
export const NAVIGATION_DIAGNOSTICS_CDP_COMMANDS = Object.freeze([FRAME_TREE_COMMAND, NETWORK_ENABLE_COMMAND] as const);

/** 観察を始める処理が、期限までに終わらなかった（期限を過ぎてから呼ばれた場合を含む）ときの、観察できなかった理由。 */
export const NAVIGATION_DIAGNOSTICS_START_DEADLINE_MESSAGE = 'Navigation diagnostics did not start before its deadline';

/** 文書の要求の、Network の domain の資源の種類。 */
const DOCUMENT_RESOURCE_TYPE = 'Document';
/** CDP の `wallTime`（秒）を、`Date.now()` と同じ ms にする倍率。 */
const MILLISECONDS_PER_SECOND = 1_000;

/** `startNavigationDiagnostics` の指定。 */
export interface NavigationDiagnosticsOptions {
  /**
   * 観察を始める処理（session を開く、main frame の ID を読む、`Network.enable`）の期限（`Date.now()` と同じ基準の絶対時刻）。
   * この時刻までに終わらなければ、観察できなかったとする（読み込みは止めない）。
   */
  readonly deadlineAtMs: number;
}

/** 始めた観察。 */
export interface NavigationDiagnosticsRecorder {
  /**
   * 観察を止め、session の `detach` を求め、凍結した結果を返す。`detach` の終わりは待たない（読み込みが終わっていない page では、
   * Chromium は、その page への CDP の命令に、読み込みが終わるまで答えないため。session は、遅くとも page を閉じたときに閉じる）。
   * 何度呼んでもよく（2回目からは、同じ結果を返す）、page が閉じていても例外を投げない。
   */
  finish(): Promise<NavigationDiagnostics>;
}

/**
 * `page` の main frame の文書の要求の観察を始める（設計書 2.1）。例外を投げない。
 * Guard とは別の CDP の session（`page.context().newCDPSession(page)`）を開き、main frame の ID を読み（`Page.getFrameTree` の root）、
 * Network の事象の受け口を付けてから `Network.enable` を送る。始められなかった場合（session を開けない、命令が失敗した、
 * `options.deadlineAtMs` までに終わらない）は、観察できなかったこと（`NOT_OBSERVED`）と理由を `finish` で返す。期限を過ぎてから開いた
 * session は、開いた時点で閉じる。
 * 記録する要求: `Network.requestWillBeSent` の `type` が `Document` で、`frameId` が main frame の ID のもの。同じ要求の ID の
 * リダイレクトは、同じ要求の続き（`hops`）にする。
 * 時刻: 要求の発行は CDP の `wallTime`（秒）を ms に丸めたもの（なければ受けた時刻）。ほかの事象は、事象を受けた時刻（`Date.now()`）。
 */
export async function startNavigationDiagnostics(
  page: Page,
  options: NavigationDiagnosticsOptions,
): Promise<NavigationDiagnosticsRecorder> {
  const { deadlineAtMs } = options;
  if (!Number.isFinite(deadlineAtMs) || Date.now() >= deadlineAtMs) {
    return notObservedRecorder(NAVIGATION_DIAGNOSTICS_START_DEADLINE_MESSAGE);
  }
  const observation = new NavigationObservation();
  const started = await awaitBeforeDeadline(observation.open(page), deadlineAtMs);
  switch (started.status) {
    case 'FULFILLED':
      return observedRecorder(observation, started.value, Date.now());
    case 'REJECTED':
      observation.stop();
      return notObservedRecorder(safeErrorMessage(started.reason, MAX_ERROR_MESSAGE_LENGTH));
    case 'DEADLINE_EXCEEDED':
      observation.stop();
      return notObservedRecorder(NAVIGATION_DIAGNOSTICS_START_DEADLINE_MESSAGE);
  }
}

function notObservedRecorder(reason: string): NavigationDiagnosticsRecorder {
  const result: NavigationDiagnostics = deepFreeze({ status: 'NOT_OBSERVED', reason });
  return Object.freeze({ finish: (): Promise<NavigationDiagnostics> => Promise.resolve(result) });
}

function observedRecorder(
  observation: NavigationObservation,
  log: DocumentRequestLog,
  observationStartedAtMs: number,
): NavigationDiagnosticsRecorder {
  let result: NavigationDiagnostics | null = null;
  return Object.freeze({
    finish: (): Promise<NavigationDiagnostics> => {
      if (result === null) {
        observation.stop();
        result = deepFreeze({
          status: 'OBSERVED',
          observationStartedAtMs,
          observationEndedAtMs: Date.now(),
          ...log.snapshot(),
        });
      }
      return Promise.resolve(result);
    },
  });
}

/** 受ける Network の事象の名前と、それを受ける記録の関数の名前（`DocumentRequestLog`）。 */
const NETWORK_EVENT_RECEIVERS = Object.freeze([
  ['Network.requestWillBeSent', 'onRequestWillBeSent'],
  ['Network.requestWillBeSentExtraInfo', 'onRequestHeadersSent'],
  ['Network.responseReceivedExtraInfo', 'onResponseExtraInfo'],
  ['Network.responseReceived', 'onResponseReceived'],
  ['Network.loadingFinished', 'onLoadingFinished'],
  ['Network.loadingFailed', 'onLoadingFailed'],
] as const satisfies readonly (readonly [string, Exclude<keyof DocumentRequestLog, 'snapshot'>])[]);
type NetworkEventName = (typeof NETWORK_EVENT_RECEIVERS)[number][0];

/** 観察の session と、その事象の受け口。止めた後は、事象を受けず、遅れて開いた session も閉じる。 */
class NavigationObservation {
  #session: CDPSession | null = null;
  readonly #listeners: Array<readonly [NetworkEventName, (event: unknown) => void]> = [];
  #stopped = false;

  /** session を開き、main frame の ID を読み、事象の受け口を付けてから `Network.enable` を送る。記録を返す。 */
  async open(page: Page): Promise<DocumentRequestLog> {
    const session = await page.context().newCDPSession(page);
    if (this.#stopped) {
      // 始める処理の期限を過ぎてから開いた session は、使わずに閉じる。
      requestDetach(session);
      throw new Error(NAVIGATION_DIAGNOSTICS_START_DEADLINE_MESSAGE);
    }
    this.#session = session;
    const { frameTree } = await session.send(FRAME_TREE_COMMAND);
    if (this.#stopped) {
      // 期限を過ぎて止めた後は、`Network.enable` を送らない（session は `stop` が閉じた）。
      throw new Error(NAVIGATION_DIAGNOSTICS_START_DEADLINE_MESSAGE);
    }
    const log = new DocumentRequestLog(frameTree.frame.id);
    for (const [name, receiver] of NETWORK_EVENT_RECEIVERS) {
      const listener = (event: unknown): void => log[receiver](event, Date.now());
      session.on(name, listener);
      this.#listeners.push([name, listener]);
    }
    await session.send(NETWORK_ENABLE_COMMAND);
    return log;
  }

  /** 事象の受け口を外し、session の `detach` を求める（終わりは待たない）。何度呼んでもよい。 */
  stop(): void {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    const session = this.#session;
    if (session === null) {
      return;
    }
    for (const [name, listener] of this.#listeners.splice(0)) {
      session.off(name, listener);
    }
    requestDetach(session);
  }
}

/**
 * session の `detach` を求める。終わりを待たず、失敗（page や Context がすでに閉じた場合など）は無視する。
 * `detach` では、Playwright 自身が `Target.detachFromTarget` を送る（この部品が送る命令の一覧 `NAVIGATION_DIAGNOSTICS_CDP_COMMANDS`
 * には含めない。session を開くときに Playwright が送る `Target.attachToTarget` と `Runtime.runIfWaitingForDebugger` も同じ。
 * 設計書 2.1 の 2026-10-06 の追補）。
 */
function requestDetach(session: CDPSession): void {
  try {
    session.detach().catch(() => undefined);
  } catch {
    // すでに閉じた session。閉じる必要はない。
  }
}

/** 記録の途中の、文書の要求の1回分。`extraInfoExpected` と `responseExtraInfoMatched` は、ExtraInfo の事象の対応付けだけに使う。 */
interface HopRecord {
  readonly url: string;
  readonly method: string;
  readonly truncated: boolean;
  readonly issuedAtMs: number;
  requestHeadersSentAtMs: number | null;
  responseHeadersReceivedAtMs: number | null;
  httpStatus: number | null;
  remoteIpAddress: string | null;
  remotePort: number | null;
  /**
   * この回の要求に、ネットワークの層の事象（`requestWillBeSentExtraInfo`、`responseReceivedExtraInfo`）があるか。リダイレクトの
   * `redirectHasExtraInfo` か、応答の `hasExtraInfo` で分かる。まだ分からなければ `null`。偽の回（内部のリダイレクトなど、
   * ネットワークに出ない回）には、ExtraInfo の事象を対応付けない。
   */
  extraInfoExpected: boolean | null;
  /** 応答の ExtraInfo（`responseReceivedExtraInfo`）を、この回に対応付けたか。 */
  responseExtraInfoMatched: boolean;
}

interface RequestRecord {
  readonly hops: HopRecord[];
  loadingFinishedAtMs: number | null;
  loadingFailure: NavigationDocumentLoadingFailure | null;
}

/**
 * main frame の文書の要求の記録（設計書 2.1）。事象は `unknown` として受け、形を確かめてから使う（形の違う事象は無視する）。
 *
 * ExtraInfo の事象（要求の ID しか持たない）の、回（`hops`）への対応付け:
 * - `requestWillBeSentExtraInfo`: ヘッダを送った時刻がまだなく、ExtraInfo がないと分かっていない、最も早い回。
 * - `responseReceivedExtraInfo`: ヘッダを送った回のうち、応答の ExtraInfo をまだ対応付けておらず、ExtraInfo がないと分かっていない、
 *   最も早い回。リダイレクトの応答の ExtraInfo が、次の回の発行の後に届いても、リダイレクトした回に対応付ける。
 * ネットワークの層の ExtraInfo は、1回のネットワークの要求ごとに、要求、応答の順に出るので、この順で対応が付く。
 */
class DocumentRequestLog {
  readonly #mainFrameId: string;
  readonly #requests = new Map<string, RequestRecord>();
  #eventCount = 0;
  #omittedDocumentRequestCount = 0;
  #omittedEventCount = 0;

  constructor(mainFrameId: string) {
    this.#mainFrameId = mainFrameId;
  }

  /** `Network.requestWillBeSent`: main frame の文書の要求の発行。記録した要求の ID なら、リダイレクト（同じ要求の次の回）。 */
  onRequestWillBeSent(event: unknown, receivedAtMs: number): void {
    if (!isRecord(event) || typeof event.requestId !== 'string') {
      return;
    }
    const request = this.#requests.get(event.requestId);
    if (request === undefined) {
      // 記録していない要求のリダイレクト（数だけ数えた要求の続き）は、記録しない。
      if (event.type !== DOCUMENT_RESOURCE_TYPE || event.frameId !== this.#mainFrameId || event.redirectResponse !== undefined) {
        return;
      }
      if (this.#requests.size >= MAX_NAVIGATION_DIAGNOSTICS_DOCUMENT_REQUESTS || this.#eventCount >= MAX_NAVIGATION_DIAGNOSTICS_EVENTS) {
        this.#omittedDocumentRequestCount += 1;
        return;
      }
      this.#eventCount += 1;
      this.#requests.set(event.requestId, { hops: [hopOf(event, receivedAtMs)], loadingFinishedAtMs: null, loadingFailure: null });
      return;
    }
    if (!this.#admitEvent()) {
      return;
    }
    const redirected = request.hops.at(-1);
    if (redirected !== undefined && isRecord(event.redirectResponse)) {
      recordResponse(redirected, event.redirectResponse, receivedAtMs);
      if (typeof event.redirectHasExtraInfo === 'boolean') {
        redirected.extraInfoExpected = event.redirectHasExtraInfo;
      }
    }
    request.hops.push(hopOf(event, receivedAtMs));
  }

  /** `Network.requestWillBeSentExtraInfo`: 要求のヘッダをネットワークへ送った。 */
  onRequestHeadersSent(event: unknown, receivedAtMs: number): void {
    const request = this.#recordedRequestOf(event);
    if (request === undefined || !this.#admitEvent()) {
      return;
    }
    const hop = request.hops.find((candidate) => candidate.requestHeadersSentAtMs === null && candidate.extraInfoExpected !== false);
    if (hop !== undefined) {
      hop.requestHeadersSentAtMs = receivedAtMs;
    }
  }

  /** `Network.responseReceivedExtraInfo`: ネットワークの層で、応答のヘッダを受けた。 */
  onResponseExtraInfo(event: unknown, receivedAtMs: number): void {
    const request = this.#recordedRequestOf(event);
    if (request === undefined || !this.#admitEvent() || !isRecord(event)) {
      return;
    }
    const hop = request.hops.find((candidate) =>
      candidate.requestHeadersSentAtMs !== null && !candidate.responseExtraInfoMatched && candidate.extraInfoExpected !== false);
    if (hop !== undefined) {
      hop.responseExtraInfoMatched = true;
      recordResponseHeaders(hop, receivedAtMs, event.statusCode);
    }
  }

  /** `Network.responseReceived`: 最後の回の応答（status、接続先の IP と port）。 */
  onResponseReceived(event: unknown, receivedAtMs: number): void {
    const request = this.#recordedRequestOf(event);
    if (request === undefined || !this.#admitEvent() || !isRecord(event)) {
      return;
    }
    const hop = request.hops.at(-1);
    if (hop !== undefined && isRecord(event.response)) {
      recordResponse(hop, event.response, receivedAtMs);
      if (typeof event.hasExtraInfo === 'boolean') {
        hop.extraInfoExpected = event.hasExtraInfo;
      }
    }
  }

  /** `Network.loadingFinished`: 読み込みが終わった。 */
  onLoadingFinished(event: unknown, receivedAtMs: number): void {
    const request = this.#recordedRequestOf(event);
    if (request === undefined || !this.#admitEvent()) {
      return;
    }
    request.loadingFinishedAtMs ??= receivedAtMs;
  }

  /** `Network.loadingFailed`: 読み込みが失敗した（`errorText`、`canceled`）。 */
  onLoadingFailed(event: unknown, receivedAtMs: number): void {
    const request = this.#recordedRequestOf(event);
    if (request === undefined || !this.#admitEvent() || !isRecord(event)) {
      return;
    }
    request.loadingFailure ??= {
      failedAtMs: receivedAtMs,
      errorText: typeof event.errorText === 'string'
        ? truncateText(event.errorText, MAX_ERROR_MESSAGE_LENGTH).text
        : ERROR_MESSAGE_FALLBACK,
      canceled: event.canceled === true,
    };
  }

  /** 記録の写し（ExtraInfo の対応付けの項目を除く）。 */
  snapshot(): Pick<ObservedNavigationDiagnostics, 'documentRequests' | 'omittedDocumentRequestCount' | 'omittedEventCount'> {
    const documentRequests: NavigationDocumentRequestDiagnostics[] = [...this.#requests.values()].map((request) => ({
      hops: request.hops.map((hop): NavigationDocumentRequestHop => ({
        url: hop.url,
        method: hop.method,
        truncated: hop.truncated,
        issuedAtMs: hop.issuedAtMs,
        requestHeadersSentAtMs: hop.requestHeadersSentAtMs,
        responseHeadersReceivedAtMs: hop.responseHeadersReceivedAtMs,
        httpStatus: hop.httpStatus,
        remoteIpAddress: hop.remoteIpAddress,
        remotePort: hop.remotePort,
      })),
      loadingFinishedAtMs: request.loadingFinishedAtMs,
      loadingFailure: request.loadingFailure === null ? null : { ...request.loadingFailure },
    }));
    return {
      documentRequests,
      omittedDocumentRequestCount: this.#omittedDocumentRequestCount,
      omittedEventCount: this.#omittedEventCount,
    };
  }

  /** 記録した要求の ID の事象なら、その要求。そうでなければ `undefined`（記録していない要求の事象は、数えない）。 */
  #recordedRequestOf(event: unknown): RequestRecord | undefined {
    return isRecord(event) && typeof event.requestId === 'string' ? this.#requests.get(event.requestId) : undefined;
  }

  /** 記録した要求の事象を1件数える。事象の上限に達していれば、記録しなかった数を数えて偽を返す。 */
  #admitEvent(): boolean {
    if (this.#eventCount >= MAX_NAVIGATION_DIAGNOSTICS_EVENTS) {
      this.#omittedEventCount += 1;
      return false;
    }
    this.#eventCount += 1;
    return true;
  }
}

/** `Network.requestWillBeSent` の事象から、文書の要求の1回分を作る。header は読まない。 */
function hopOf(event: Readonly<Record<string, unknown>>, receivedAtMs: number): HopRecord {
  const request = isRecord(event.request) ? event.request : {};
  const url = truncateText(typeof request.url === 'string' ? request.url : '', MAX_URL_LENGTH);
  const method = truncateText(typeof request.method === 'string' ? request.method : '', MAX_HTTP_METHOD_LENGTH);
  return {
    url: url.text,
    method: method.text,
    truncated: url.truncated || method.truncated,
    issuedAtMs: wallTimeMs(event.wallTime) ?? receivedAtMs,
    requestHeadersSentAtMs: null,
    responseHeadersReceivedAtMs: null,
    httpStatus: null,
    remoteIpAddress: null,
    remotePort: null,
    extraInfoExpected: null,
    responseExtraInfoMatched: false,
  };
}

/** CDP の `wallTime`（UNIX エポックからの秒）を、`Date.now()` と同じ基準の ms に丸める。正の有限の数でなければ `null`。 */
function wallTimeMs(wallTime: unknown): number | null {
  return typeof wallTime === 'number' && Number.isFinite(wallTime) && wallTime > 0
    ? Math.round(wallTime * MILLISECONDS_PER_SECOND)
    : null;
}

/** 応答のヘッダを受けた時刻と status を、まだなければ記録する（最初に受けたものを残す）。 */
function recordResponseHeaders(hop: HopRecord, receivedAtMs: number, status: unknown): void {
  hop.responseHeadersReceivedAtMs ??= receivedAtMs;
  if (hop.httpStatus === null && isNonNegativeSafeInteger(status)) {
    hop.httpStatus = status;
  }
}

/** CDP の応答（`Network.Response`）の、status と接続先の IP と port を、まだなければ記録する。header は読まない。 */
function recordResponse(hop: HopRecord, response: Readonly<Record<string, unknown>>, receivedAtMs: number): void {
  recordResponseHeaders(hop, receivedAtMs, response.status);
  hop.remoteIpAddress ??= ipAddressOf(response.remoteIPAddress);
  if (hop.remotePort === null && isNonNegativeSafeInteger(response.remotePort)) {
    hop.remotePort = response.remotePort;
  }
}

/** IP アドレス（IPv6 の角括弧は外す）。IP アドレスでなければ `null`（空文字列を含む）。 */
function ipAddressOf(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const address = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  return isIP(address) === 0 ? null : address;
}
