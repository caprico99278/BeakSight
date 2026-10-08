import { STATUS_CODES } from 'node:http';
import type {
  BrowserContext,
  CDPSession,
  Download,
  Frame,
  Page,
  Request,
  Route,
} from 'playwright';
import { ERROR_HTTP_STATUS_RANGE, isHttpStatusInRange } from '../audit/rule-helpers.js';
import { isInvalidInterceptionIdFailure } from '../browser/playwright-errors.js';
import type { ResourceDeliveryDecision, ResourceDeliveryRequestFacts } from '../browser/resource-delivery.js';
import { safeErrorMessage } from '../core/errors.js';
import { NON_EXTERNAL_NAVIGATION_SCHEMES, WORKER_CONNECT_POLICY_REASON } from '../core/evidence-types.js';
import {
  MAX_ERROR_MESSAGE_LENGTH,
  MAX_HTTP_METHOD_LENGTH,
  MAX_PENDING_GUARD_REQUEST_TASKS,
  MAX_URL_LENGTH,
} from '../core/limits.js';
import { isHttpProtocol } from '../crawl/normalize-url.js';
import { isNetworkLayerFailure, isResponseReceivedFailure } from './network-layer-failure.js';
import { classifyPassiveRequest, isReadMethod, type PassiveRequestDecision } from './request-policy.js';
import type { SafetyLedger } from './safety-ledger.js';

type BlockDecision = Extract<PassiveRequestDecision, { readonly action: 'BLOCK' }>;
type GuardPhase =
  | 'INSTALLING'
  | 'PASSIVE_ACTIVE'
  | 'FROZEN_ACTIVE'
  | 'PASSIVE_CLOSING'
  | 'FROZEN_CLOSING'
  | 'PASSIVE_INVALIDATING'
  | 'FROZEN_INVALIDATING'
  | 'CLOSED';
type PageGuardStatus = 'INSTALLING' | 'READY' | 'FAILED';
const OWNER_PAGE_CLOSE_MARKER_RETENTION_MS = 100;
const EXPECTED_CDP_FAILURE_RETENTION_MS = 1_000;
/**
 * リダイレクトの対応付けの登録を保持する時間（ms。C18h）。リクエストの段階の登録は、リクエストの開始から数える。リダイレクトの
 * 応答（3xx）を受けたときは、その時点から数え直す。3xx を返すまでのサーバの時間は、数えない（DEF-013）。
 */
const REDIRECT_PREDECESSOR_RETENTION_MS = 1_000;
const GUARD_PENDING_TASK_DRAIN_TIMEOUT_MS = 1_000;
const GUARD_PENDING_TASK_DRAIN_TIMEOUT_MESSAGE =
  'Guard-owned listener tasks did not settle before cleanup deadline';
const MAX_PENDING_GUARD_TASKS = 256;
const MAX_GUARD_PAGE_LISTENER_GROUPS = 64;
const MAX_EXPECTED_CDP_FAILURES = 64;
const MAX_REDIRECT_PREDECESSORS = 64;
const MAX_REDIRECT_REQUEST_ID_LENGTH = 256;
/**
 * 1つの page の中で、同時に横取りを付けておく、別のプロセスの iframe（OOPIF）の session の数の上限（入れ子を含む。C18i）。
 * 超えた OOPIF は、一時停止のまま進めず、`OOPIF_GUARD_ATTACH_FAILED` の違反にして Context を閉じる（fail-closed）。
 */
const MAX_GUARD_OOPIF_SESSIONS = 64;
/**
 * 1つの CDP の session で覚える、文書の要求の、ブラウザによる取り消しの証拠（DEF-026。同じ session の `Network.loadingFailed` で、
 * `canceled` が真で、`type` が `Document` のもの）の数の上限。証拠は、一時停止の通知より先に届く（DEF-026-fix の実験。282件のすべてで、
 * 一時停止の通知の 3〜55ms 前）ので、一時停止の有無によらず覚える。一時停止の通知が来ないまま取り消された文書の要求の証拠も含むので、
 * 40個の iframe を読み込みの途中で消すページで、同時に約40件になった。その数に余裕を見た値にする。
 * 超えた証拠は覚えず、その要求への命令が失敗したら、今のとおり違反にする（fail-closed）。
 * DEF-027: page の session で覚える、main frame の文書の要求の記録（`MainFrameDocumentRecord`）の数も、同じ値までにする。記録は、
 * 要求が終わったら消すか縮めるので、同時に残るのは、ふつうは数件である。超えた要求は覚えず、その取り消しは違反のまま（fail-closed）。
 */
export const MAX_CANCELED_DOCUMENT_EVIDENCE = 256;
/**
 * 文書の要求の取り消しの証拠を覚えておく時間（ms。DEF-026）。証拠を受けた時点から数える。証拠は、一時停止の通知の数十 ms 前に届き、
 * 一時停止から命令の失敗の応答までは、ふつうは数 ms である。Node の事象の処理が遅れた場合と、証拠を待つ時間
 * （`CANCELED_DOCUMENT_EVIDENCE_WAIT_MS`）を足しても余る長さにする。過ぎた証拠は捨て、その要求への命令が失敗したら違反にする。
 * DEF-027: main frame の文書の要求の記録も、その要求の `Network.loadingFailed` を受けた後は、この時間で捨てる（Playwright の
 * `requestfailed` と対応付けるのに、同じ長さで足りる）。
 */
export const CANCELED_DOCUMENT_EVIDENCE_RETENTION_MS = 5_000;
/**
 * Guard の命令が、一時停止の ID が無効な形で失敗したのに、その要求の取り消しの証拠をまだ受けていないときに、証拠を待つ時間（ms。DEF-026）。
 * 実験では、証拠は、いつも一時停止の通知より先に届いた。この時間は、届く順が入れ替わる場合に備えた余裕で、ブラウザの中の事象の遅れ
 * （数 ms から数十 ms）より十分に長く、Guard の作業を長く止めない長さにする。待っても届かなければ、違反にする。
 * Context や page を閉じる途中なら、待たずに違反にする（閉じる処理の drain を止めない）。
 * DEF-027: main frame の読み込みの `requestfailed` を受けて、取り消しの証拠がまだそろっていないときに待つ時間も、同じ値にする
 * （`requestfailed` と、Guard の page の session の事象の順は決まっていない。調査では 1ms ほどの差だった）。
 */
export const CANCELED_DOCUMENT_EVIDENCE_WAIT_MS = 500;
/**
 * Guard が Request の段階で一時停止した main frame の文書の要求の記録（DEF-027。`MainFrameDocumentRecord`）を、その要求が終わる前に
 * 覚えておく時間（ms）。一時停止の通知を受けた時点から数える。要求が終わったら、記録を消す（`Network.loadingFinished`）か、
 * `CANCELED_DOCUMENT_EVIDENCE_RETENTION_MS` に縮める（`Network.loadingFailed`）。
 * 応答を待つ main frame の読み込みは、ページを開いている間（読み込みの期限は設定の `crawl.navigationTimeoutMs`、既定 30秒。ページの期限は
 * `crawl.overallPageTimeoutMs`、既定 60秒）、利用者がタブを閉じるなどで、いつでも取り消されうる。Guard はこれらの設定を受け取らないので、
 * 既定のページの期限の10倍にする。過ぎた記録は捨て、その要求がその後に取り消されたら、違反のまま（fail-closed）。
 */
export const PENDING_MAIN_FRAME_DOCUMENT_RETENTION_MS = 600_000;
/**
 * ブラウザが文書の要求を取り消したときの失敗の理由（Playwright の `requestfailed` の `errorText` と、CDP の `Network.loadingFailed` の
 * `errorText`）。Guard や page を閉じる途中の取り消しと、DEF-027 の取り消しの証拠で使う。
 */
const NAVIGATION_ABORTED_ERROR_TEXT = 'net::ERR_ABORTED';
const GUARD_ERROR_NORMALIZATION_FALLBACK = 'Guard error could not be safely normalized';

/**
 * Guard が、許可（ALLOW）した、ナビゲーションでない要求の届け方を尋ねる部品（サイトへの負荷の制御の設計書 4.7、4.10.3）。
 * factory（`BrowserContextFactory`）が、Run 全体のキャッシュがある場合に、Passive の Context（役割 `PRIMARY` と `REVISIT` の両方）ごとに、
 * その役割の部品を作り、Guard の取り付けの指定で渡す（`PRIMARY` にも渡すのは DEF-031 から）。
 * Guard が尋ねるのは、段階が `PASSIVE_ACTIVE` で、許可の判定（`classifyPassiveRequest`）が ALLOW で、ナビゲーションの要求でない
 * 要求だけである。凍結の段階、閉じている段階、BLOCK の要求は、尋ねる前に Guard が止める。許可の判定は、この部品には委ねない。
 * 判断の意味の owner は `src/browser/resource-delivery.ts`（`decideResourceDelivery`）である。
 */
export interface GuardResourceDelivery {
  /** 届け方を決める。例外を投げない（投げた場合は、Guard が今のままネットワークに送る）。 */
  decide(request: ResourceDeliveryRequestFacts): ResourceDeliveryDecision;
  /** キャッシュから返す直前に呼ぶ（factory の印と、LoadMeter の印を付ける）。例外を投げない。 */
  beforeServeFromRunCache(request: Request): void;
  /** 送らないと決めた直後に呼ぶ（LoadMeter で数える）。例外を投げない。 */
  afterWithhold(request: Request): void;
}

/**
 * Guard の取り付けの指定（省略できる）。
 * - `resourceDelivery`: 許可した、ナビゲーションでない要求の届け方を尋ねる部品（サイトへの負荷の制御の設計書 4.7）。省略した場合は、
 *   今のまま、許可した要求をすべてネットワークに送る。
 * Guard は、headed かどうかを受け取らない（中断した Run の再開の設計書 4.10）。外部スキームへの移動は、headed と headless を問わず、
 * 不変条件の違反として Context を閉じるためである。
 */
export interface PassiveRequestGuardOptions {
  readonly resourceDelivery?: GuardResourceDelivery | undefined;
}

/**
 * navigation の URL が外部スキーム（`NON_EXTERNAL_NAVIGATION_SCHEMES` にないスキーム）なら、そのスキーム（末尾の `:` を除いた形）を返す。
 * 外部スキームでなければ `null` を返す。解析できない URL は例外を投げる（呼び出し側が fail-closed にする）。
 */
function externalNavigationScheme(url: string): string | null {
  const { protocol } = new URL(url);
  return (NON_EXTERNAL_NAVIGATION_SCHEMES as readonly string[]).includes(protocol) ? null : protocol.slice(0, -1);
}

interface ExpectedCdpFailure {
  readonly method: string;
  readonly url: string;
  readonly errorText: string;
  readonly expiresAt: number;
}

interface CorrelationRequest {
  readonly method: string;
  readonly url: string;
}

interface PausedDocumentEvent {
  readonly requestId: string;
  readonly redirectedRequestId?: string;
  /**
   * Network の domain の要求の ID（DEF-026）。同じ session の `Network.loadingFailed` の `requestId` と同じ値で、ブラウザによる取り消しの
   * 証拠を、この要求に対応付けるために使う。ない場合は、対応付けられない（その要求への命令の失敗は、違反のまま）。
   */
  readonly networkId?: string;
  readonly frameId: string;
  /** 要求（method と URL。CORS の事前確認の判定には、要求のヘッダも使う。DEF-042 の設計書 2.4）。 */
  readonly request: CorrelationRequest & { readonly headers?: Readonly<Record<string, string>> };
  /**
   * 要求の種類（CDP の `Network.ResourceType`。DEF-042）。`Document` の事象は、Document の横取り（Request と Response の段階。リダイレクトの
   * 対応付け、取り消しの証拠、外部スキームの判定）で扱う。それ以外の事象は、Request の段階の、ナビゲーションでない要求として判定する
   * （`handlePausedRequest`）。
   */
  readonly resourceType?: string;
  /**
   * 応答の段階（Response stage）の事象だけが持つ項目（C18g）。CDP では、`responseStatusCode` か `responseErrorReason` の
   * どちらかがあれば応答の段階、どちらもなければリクエストの段階である。
   */
  readonly responseStatusCode?: number;
  /** 応答の段階の事象の、応答の status の文言（CDP の `responseStatusText`。空のことがある。DEF-040 の `Fetch.continueResponse` に渡す）。 */
  readonly responseStatusText?: string;
  readonly responseErrorReason?: string;
  readonly responseHeaders?: readonly { readonly name: string; readonly value: string }[];
}

/** 一時停止の事象が、Document の要求のものか（DEF-042。`resourceType` が `Document` の事象だけを Document として扱う）。 */
function isPausedDocument(event: PausedDocumentEvent): boolean {
  return event.resourceType === 'Document';
}

/** 一時停止の事象が、応答の段階のものか（C18g。Document でも、Document 以外（DEF-040 の `Other`）でも同じ判定）。 */
function isPausedResponse(event: PausedDocumentEvent): boolean {
  return event.responseStatusCode !== undefined || event.responseErrorReason !== undefined;
}

/**
 * Document でない一時停止の要求の、判定に使う事実（method と URL。DEF-042）。どちらかが文字列でなければ `null`（呼び出し側が fail-closed に
 * する）。URL の長さの上限（`boundedCorrelationRequest`）は、route の判定と同じく使わない（記録のときに Ledger が切り詰める）。
 */
function pausedRequestFacts(event: PausedDocumentEvent): CorrelationRequest | null {
  const request = event.request as Partial<CorrelationRequest> | undefined;
  return typeof request?.method === 'string' && typeof request.url === 'string'
    ? { method: request.method, url: request.url }
    : null;
}

/** 外部スキームへのリダイレクトの宛先（`Location` を解決した URL と、そのスキーム）。 */
interface ExternalSchemeRedirect {
  readonly url: string;
  readonly scheme: string;
}

/**
 * 応答の段階の Document の事象が、外部スキームへのリダイレクト（3xx で、`Location` が外部スキーム）なら、その宛先を返す（C18g。
 * Task 19 の前の整理の設計書 4.2）。そうでなければ `null` を返す。
 * - `Location` は、相対の URL も、元のリクエストの URL を基準に解決する。
 * - `Location` が複数ある場合（1つの項目の中の改行で区切ったものを含む）は、どれか1つでも外部スキームなら、その宛先を返す。
 * - 解析できない `Location` は例外を投げる（呼び出し側が fail-closed にする）。
 */
function externalSchemeRedirect(event: PausedDocumentEvent): ExternalSchemeRedirect | null {
  for (const location of redirectLocations(event)) {
    const url = new URL(location.trim(), event.request.url).href;
    const scheme = externalNavigationScheme(url);
    if (scheme !== null) {
      return { url, scheme };
    }
  }
  return null;
}

/**
 * 応答の段階の Document の事象が、リダイレクトの応答（3xx で、`Location` を持つ）なら、`Location` の値（1つの項目の中の改行で
 * 区切ったものを分けた、解決の前の値）を返す。そうでなければ空の配列を返す（C18g・C18h）。
 */
function redirectLocations(event: PausedDocumentEvent): string[] {
  const status = event.responseStatusCode;
  if (status === undefined || status < 300 || status > 399) {
    return [];
  }
  return (event.responseHeaders ?? [])
    .filter((header) => header.name.toLowerCase() === 'location')
    .flatMap((header) => header.value.split('\n'));
}

interface RedirectPredecessor {
  readonly request: CorrelationRequest;
  readonly expiresAt: number;
}

type RedirectPredecessorLookup =
  | { readonly kind: 'FOUND'; readonly request: CorrelationRequest }
  | { readonly kind: 'MISSING' }
  | { readonly kind: 'INVALID' };

interface PageDocumentGuard {
  readonly session: CDPSession;
  readonly rootFrameId: string;
  /**
   * page の session の証拠で、main frame の文書の要求（`request`）が、Guard が Request の段階で許可して進めた後に、応答を1つも受けずに
   * ブラウザに取り消されたと確かめられるか（DEF-027。`CanceledDocumentRegistry.awaitMainFrameCancellation`）。
   */
  readonly awaitMainFrameCancellation: (request: CorrelationRequest, waitMs: number) => Promise<boolean>;
}

/**
 * Document の横取りを付ける CDP の session（page の session か、別のプロセスの iframe（OOPIF）の session。C18i）。
 * 横取りの判定（`createDocumentInterception`）は、この形の session を引数に取り、page と OOPIF で同じ処理を使う。
 */
interface GuardCdpChannel {
  readonly send: CDPSession['send'];
}

/**
 * 1つの session の横取り（C18i）。
 * - `onRequestPaused`: その session の `Fetch.requestPaused` を受ける。Document の要求（Request と Response の段階）と、Document でない
 *   要求（Request の段階だけ。DEF-042）の両方。
 * - `onLoadingFailed`: その session の `Network.loadingFailed` を受ける（DEF-026。一時停止した文書の要求の取り消しの証拠）。
 * - `onResponseReceived`・`onRequestWillBeSent`・`onLoadingFinished`: その session の `Network.responseReceived`・
 *   `Network.requestWillBeSent`・`Network.loadingFinished` を受ける（DEF-027。main frame の文書の要求が、応答を受けたか、終わったか）。
 *   page の session だけが受ける（OOPIF の session は、main frame の要求を扱わない）。
 * - `awaitMainFrameCancellation`: main frame の文書の要求の取り消しを、証拠で確かめる（DEF-027。page の session だけが記録を持つ）。
 * - `clear`: その session のリダイレクトの対応付けの登録と、取り消しの証拠の記録を消す（証拠を待っている命令の失敗の扱いは、待たずに
 *   違反にする）。
 */
interface DocumentInterception {
  readonly onRequestPaused: (event: PausedDocumentEvent) => void;
  readonly onLoadingFailed: (event: unknown) => void;
  readonly onResponseReceived: (event: unknown) => void;
  readonly onRequestWillBeSent: (event: unknown) => void;
  readonly onLoadingFinished: (event: unknown) => void;
  readonly awaitMainFrameCancellation: (request: CorrelationRequest, waitMs: number) => Promise<boolean>;
  readonly clear: () => void;
}

/** CDP の Fetch の横取りを付ける（page の session と OOPIF の session で同じパターン。C18g、C18i、DEF-042）。 */
async function enableRequestInterception(channel: GuardCdpChannel): Promise<void> {
  // DEF-026: 一時停止した文書の要求の、ブラウザによる取り消しの証拠（`Network.loadingFailed` の canceled）を受けるため、横取りの前に
  // Network の domain を有効にする。失敗したら、横取りの取り付けの失敗と同じく扱う（呼び出し側が fail-closed にする）。
  await channel.send('Network.enable');
  // Document は、リクエストの段階（許可 Origin とメソッドの判定）と、応答の段階（外部スキームへのリダイレクトを、たどる前に
  // 止める。C18g）の両方で横取りする。
  // DEF-042（設計書 `2026-10-08-beaksight-def-042-guard-fetch-all-design.md` 2.1）: それ以外のすべての要求も、リクエストの段階で
  // 横取りする。ページを離れるときの送信（`pagehide` の `sendBeacon`、keepalive の `fetch`、`fetchLater()`）は、`networkId` なしで
  // 一時停止の通知に来て、Playwright が route を呼ばずに進めるので、Playwright の route では止められないためである。
  // DEF-040（設計書 `2026-10-08-beaksight-def-039-040-egress-design.md` 2.2）: `Other` の応答（Worker の script の応答は、CDP の Fetch では
  // `Other` として来る。`Worker` の種類はない）は、応答の段階でも横取りし、Worker の中の WebSocket を止める CSP のヘッダを加える
  // （`handlePausedResponse`）。CSP のヘッダは文書と Worker 以外の応答には効かないので、`Other` のすべてに加える。
  await channel.send('Fetch.enable', {
    patterns: [
      { urlPattern: '*', resourceType: 'Document', requestStage: 'Request' },
      { urlPattern: '*', resourceType: 'Document', requestStage: 'Response' },
      { urlPattern: '*', requestStage: 'Request' },
      { urlPattern: '*', resourceType: 'Other', requestStage: 'Response' },
    ],
  });
}

/**
 * Guard の page の session で、ブラウザの Log の domain を有効にする（DEF-040 の設計書 2.2）。Worker の中の CSP の違反は、page の console
 * には出ず、page の session の `Log.entryAdded`（source `worker`）に来るので、その観察で、Worker の中で止めた WebSocket を記録する
 * （`workerConnectPolicyViolationUrl`）。page の session だけで行う（OOPIF の session の Worker の違反は、観察しない。設計書 2.2 の残る経路）。
 */
async function enableWorkerConnectPolicyObservation(channel: GuardCdpChannel): Promise<void> {
  await channel.send('Log.enable');
}

/**
 * session の子の、別のプロセスの iframe（OOPIF）に、自動で session を付ける（C18i。RC18b の N1）。
 * - `waitForDebuggerOnStart`: 新しい OOPIF は、その Document を確定する前に止まる。Guard が横取りを付けてから
 *   `Runtime.runIfWaitingForDebugger` で進めるので、横取りを付けるまでの間に、その OOPIF の中の移動は始まらない。
 * - `flatten: false`: 子の session には、この session の `Target.sendMessageToTarget` で命令を送り、
 *   `Target.receivedMessageFromTarget` で応答と事象を受ける（Playwright の CDP の session は、flatten の子の session を扱えないため）。
 * - `filter`: iframe の target だけを付ける（worker などは付けない）。
 * サイトの分離を無効にする起動の引数は、使わない（ブラウザの安全の仕組みを弱めるため）。
 */
async function enableOopifAutoAttach(channel: GuardCdpChannel): Promise<void> {
  await channel.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: false,
    filter: [{ type: 'iframe', exclude: false }],
  });
}

/** OOPIF の session が閉じた（target が消えた、または Guard が後片付けをした）ことを表す（C18i）。 */
const OOPIF_SESSION_CLOSED_MESSAGE = 'OOPIF interception session was detached';

/**
 * 別のプロセスの iframe（OOPIF）の target に付けた、CDP の session（C18i）。flatten でない auto-attach の子の session なので、
 * 親の session（page の session か、親の OOPIF の session）の `Target.sendMessageToTarget` で命令を送り、親が受けた
 * `Target.receivedMessageFromTarget` を `dispatch` に渡して、応答と事象を受ける。
 * - 命令の応答は、命令ごとの番号で対応付ける。session が閉じたら（`close`）、応答を待つ命令をすべて失敗させる（Guard の
 *   後片付けの drain が、応答の来ない命令を待ち続けないため）。
 * - 事象（`Fetch.requestPaused`、入れ子の OOPIF の `Target.*`）は、`onEvent` に渡す。
 */
class OopifTargetChannel implements GuardCdpChannel {
  readonly #parent: GuardCdpChannel;
  readonly #sessionId: string;
  readonly #onEvent: (method: string, params: unknown) => void;
  readonly #pending = new Map<number, { readonly resolve: (value: unknown) => void; readonly reject: (error: unknown) => void }>();
  #lastId = 0;
  #closed = false;

  constructor(parent: GuardCdpChannel, sessionId: string, onEvent: (method: string, params: unknown) => void) {
    this.#parent = parent;
    this.#sessionId = sessionId;
    this.#onEvent = onEvent;
  }

  readonly send = ((method: string, params?: object): Promise<unknown> => this.#send(method, params)) as CDPSession['send'];

  /** session が閉じたか（target が消えたか、Guard が後片付けをしたか）。 */
  get closed(): boolean {
    return this.#closed;
  }

  #send(method: string, params: object | undefined): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(new Error(OOPIF_SESSION_CLOSED_MESSAGE));
    }
    this.#lastId += 1;
    const id = this.#lastId;
    const response = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    // 送る命令そのものが失敗した場合は、下の連鎖が失敗を返す。そのときの応答の待ちの失敗は、ここで封じ込める。
    void response.catch(() => undefined);
    const message = JSON.stringify({ id, method, params: params ?? {} });
    return this.#parent.send('Target.sendMessageToTarget', { sessionId: this.#sessionId, message }).then(
      () => response,
      (error: unknown) => {
        this.#pending.delete(id);
        throw error;
      },
    );
  }

  /** 親が受けた、この session の `Target.receivedMessageFromTarget` の `message` を処理する。解析できない場合は例外を投げる。 */
  dispatch(message: unknown): void {
    if (typeof message !== 'string') {
      throw new Error('OOPIF interception session message is not a string');
    }
    const parsed: unknown = JSON.parse(message);
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('OOPIF interception session message is not an object');
    }
    const { id, method, params, error, result } = parsed as {
      readonly id?: unknown;
      readonly method?: unknown;
      readonly params?: unknown;
      readonly error?: unknown;
      readonly result?: unknown;
    };
    if (id !== undefined) {
      if (typeof id !== 'number') {
        throw new Error('OOPIF interception session response has an invalid id');
      }
      const entry = this.#pending.get(id);
      if (entry === undefined) {
        return;
      }
      this.#pending.delete(id);
      if (error !== undefined) {
        const reason = typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string'
          ? (error as { message: string }).message
          : 'OOPIF interception session command failed';
        entry.reject(new Error(reason));
      } else {
        entry.resolve(result);
      }
      return;
    }
    if (typeof method !== 'string') {
      throw new Error('OOPIF interception session event has no method');
    }
    this.#onEvent(method, params);
  }

  /** session を閉じる。応答を待つ命令は、すべて失敗させる。2回目以降は何もしない。 */
  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of pending) {
      entry.reject(new Error(OOPIF_SESSION_CLOSED_MESSAGE));
    }
  }
}

/** 横取りを付けた OOPIF の session と、その子（入れ子の OOPIF）の session（C18i）。 */
interface OopifGuardNode {
  readonly channel: OopifTargetChannel;
  readonly interception: DocumentInterception;
  readonly children: Map<string, OopifGuardNode>;
}

/** `Target.attachedToTarget` の事象のうち、Guard が使う項目。 */
interface AttachedTargetEvent {
  readonly sessionId?: unknown;
  readonly targetInfo?: { readonly type?: unknown };
  readonly waitingForDebugger?: unknown;
}

/** `Target.receivedMessageFromTarget` と `Target.detachedFromTarget` の事象のうち、Guard が使う項目。 */
interface TargetSessionEvent {
  readonly sessionId?: unknown;
  readonly message?: unknown;
}

interface PageGuardRecord {
  status: PageGuardStatus;
  readonly ready: Promise<PageDocumentGuard>;
}

interface ListenerCleanupGroup {
  active: boolean;
  readonly cleanups: Array<() => void>;
}

interface ListenerCleanupOwnership {
  readonly context: ListenerCleanupGroup;
  readonly pages: Map<Page, ListenerCleanupGroup>;
  pageGroupLimitReported: boolean;
}

interface CloseAttemptResult {
  readonly invalidated: boolean;
}

type CloseAttemptSource = 'OWNER_CLOSE' | 'SAFETY_INVALIDATION';

interface GuardState {
  phase: GuardPhase;
  readonly context: BrowserContext;
  readonly ledger: SafetyLedger;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly pageGuards: WeakMap<Page, PageGuardRecord>;
  readonly pendingTasks: Set<Promise<void>>;
  /**
   * `pendingTasks` のうち、要求の横取りの作業（`handlePausedRequest`。DEF-042 の設計書 2.4）の数。この作業は
   * `MAX_PENDING_GUARD_REQUEST_TASKS` で数え、ほかの作業の上限（`MAX_PENDING_GUARD_TASKS`）には数えない。
   */
  pendingRequestTaskCount: number;
  readonly listenerCleanups: ListenerCleanupOwnership;
  overflowInvalidation: Promise<void> | undefined;
  rawCloseConfirmed: boolean;
  closeAttempt: Promise<CloseAttemptResult> | undefined;
  taskLimitReported: boolean;
  drainTimeoutReported: boolean;
  ensurePageGuard(page: Page): PageGuardRecord;
}

const guardStates = new WeakMap<BrowserContext, GuardState>();
const ownerClosingPages = new WeakSet<Page>();

function isFrozenPhase(phase: GuardPhase): boolean {
  return phase === 'FROZEN_ACTIVE'
    || phase === 'FROZEN_CLOSING'
    || phase === 'FROZEN_INVALIDATING';
}

function isClosingOrInvalidatingPhase(phase: GuardPhase): boolean {
  return phase === 'PASSIVE_CLOSING'
    || phase === 'FROZEN_CLOSING'
    || phase === 'PASSIVE_INVALIDATING'
    || phase === 'FROZEN_INVALIDATING'
    || phase === 'CLOSED';
}

function ownerClosingPhase(phase: GuardPhase): GuardPhase {
  if (phase === 'PASSIVE_ACTIVE') return 'PASSIVE_CLOSING';
  if (phase === 'FROZEN_ACTIVE') return 'FROZEN_CLOSING';
  throw new Error(`Guarded Context close is invalid from ${phase}`);
}

/**
 * 凍結の段階で、命令の失敗を受けた時点で、owner の close（または無効化）がもう始まっているか（DEF-045。設計書
 * `2026-10-08-beaksight-def-044-046-review-fixes-design.md` 2）。`FROZEN_CLOSING`、`FROZEN_INVALIDATING`、close の試みがある
 * （`CLOSED` を含む）のどれか。凍結の分岐で、閉じた形の失敗（`isClosedTargetFailure`）を違反にしないかの判定だけに使う。
 */
function hasFrozenCloseStarted(guardState: GuardState): boolean {
  return guardState.phase === 'FROZEN_CLOSING'
    || guardState.phase === 'FROZEN_INVALIDATING'
    || guardState.closeAttempt !== undefined;
}

/**
 * Context の閉じる処理（owner の close か無効化。Passive と凍結の両方）が、もう始まっているか（DEF-050。設計書
 * `2026-10-08-beaksight-def-044-046-review-fixes-design.md` 6）。閉じる途中・無効化の段階（`CLOSED` を含む）か、close の試みがある。
 * page だけを閉じる途中（`ownerClosingPages`）は含めない。Document の閉じる途中の分岐（`failPausedDocumentForLifecycle`）で、閉じた形の
 * 失敗（`isClosedTargetFailure`）を違反にしないかの判定だけに使う。
 */
function hasContextCloseStarted(guardState: GuardState): boolean {
  return isClosingOrInvalidatingPhase(guardState.phase) || guardState.closeAttempt !== undefined;
}

function invalidatingPhase(phase: GuardPhase): GuardPhase {
  return isFrozenPhase(phase) ? 'FROZEN_INVALIDATING' : 'PASSIVE_INVALIDATING';
}

function errorMessage(error: unknown): string {
  return safeErrorMessage(error, MAX_ERROR_MESSAGE_LENGTH, GUARD_ERROR_NORMALIZATION_FALLBACK);
}

class GuardTaskDrainTimeoutError extends Error {
  constructor() {
    super(GUARD_PENDING_TASK_DRAIN_TIMEOUT_MESSAGE);
    this.name = 'GuardTaskDrainTimeoutError';
  }
}

function boundedCorrelationRequest(method: string, url: string): CorrelationRequest | null {
  if (method.length > MAX_HTTP_METHOD_LENGTH || url.length > MAX_URL_LENGTH) {
    return null;
  }
  return { method: method.slice(0, MAX_HTTP_METHOD_LENGTH).toUpperCase(), url };
}

class ExpectedCdpFailureRegistry {
  readonly #entries = new WeakMap<Page, ExpectedCdpFailure[]>();
  readonly #identityReported = new WeakSet<Page>();
  readonly #limitReported = new WeakSet<Page>();
  readonly #ledger: SafetyLedger;

  constructor(ledger: SafetyLedger) {
    this.#ledger = ledger;
  }

  register(page: Page, request: CorrelationRequest, now: number): ExpectedCdpFailure | null {
    if (
      request.method.length > MAX_HTTP_METHOD_LENGTH
      || request.url.length > MAX_URL_LENGTH
    ) {
      this.#recordIdentityRejected(page);
      return null;
    }
    const live = (this.#entries.get(page) ?? []).filter((entry) => entry.expiresAt >= now);
    if (live.length >= MAX_EXPECTED_CDP_FAILURES) {
      if (!this.#limitReported.has(page)) {
        this.#limitReported.add(page);
        this.#ledger.recordInvariantViolation({
          code: 'EXPECTED_CDP_FAILURE_LIMIT_REACHED',
          message: 'Expected CDP failure correlation limit reached',
        });
      }
      this.#entries.set(page, live);
      return null;
    }
    const expected = {
      method: request.method.slice(0, MAX_HTTP_METHOD_LENGTH).toUpperCase(),
      url: request.url,
      errorText: 'net::ERR_BLOCKED_BY_CLIENT',
      expiresAt: now + EXPECTED_CDP_FAILURE_RETENTION_MS,
    } satisfies ExpectedCdpFailure;
    live.push(expected);
    this.#entries.set(page, live);
    return expected;
  }

  remove(page: Page, expected: ExpectedCdpFailure): void {
    const remaining = (this.#entries.get(page) ?? []).filter((entry) => entry !== expected);
    if (remaining.length === 0) this.#entries.delete(page);
    else this.#entries.set(page, remaining);
  }

  consume(
    page: Page,
    request: CorrelationRequest & { readonly errorText: string },
    now: number,
  ): boolean {
    if (
      request.method.length > MAX_HTTP_METHOD_LENGTH
      || request.url.length > MAX_URL_LENGTH
    ) return false;
    const method = request.method.slice(0, MAX_HTTP_METHOD_LENGTH).toUpperCase();
    const live = (this.#entries.get(page) ?? []).filter((entry) => entry.expiresAt >= now);
    const index = live.findIndex((entry) => entry.method === method
      && entry.url === request.url
      && entry.errorText === request.errorText);
    if (index < 0) {
      if (live.length === 0) this.#entries.delete(page);
      else this.#entries.set(page, live);
      return false;
    }
    live.splice(index, 1);
    if (live.length === 0) this.#entries.delete(page);
    else this.#entries.set(page, live);
    return true;
  }

  clear(page: Page): void {
    this.#entries.delete(page);
    this.#identityReported.delete(page);
    this.#limitReported.delete(page);
  }

  #recordIdentityRejected(page: Page): void {
    if (!this.#identityReported.has(page)) {
      this.#identityReported.add(page);
      this.#ledger.recordInvariantViolation({
        code: 'CDP_CORRELATION_IDENTITY_REJECTED',
        message: 'Expected CDP failure identity exceeded its bound',
      });
    }
  }
}

/**
 * Document のリクエストの requestId と、そのリクエスト（メソッドと URL）の対応付け。リダイレクトの後のリクエスト
 * （`redirectedRequestId` を持つもの）が、元のリクエストを引くために使う（C18h で、登録と消去の時点を整理した）。
 * - 登録: リクエストの段階（`remember`）。応答の段階では、まず登録を消し（`forget`。元のリクエストが終わった）、リダイレクトの
 *   応答（3xx で `Location` を持つ）なら登録し直して、期限をその時点から数える。
 * - 消去: リダイレクトの後のリクエストで使われたとき（`take`）、元のリクエストが終わったとき（`forget`。応答を受けたとき、
 *   Guard がリクエストを失敗させたとき）、期限が切れたとき、Context や page が閉じたとき（`clear`）。
 * - 件数は `MAX_REDIRECT_PREDECESSORS` までとし、超える登録は違反を記録して `false` を返す（呼び出し側が fail-closed にする）。
 */
class RedirectPredecessorRegistry {
  readonly #entries = new Map<string, RedirectPredecessor>();
  readonly #ledger: SafetyLedger;
  #identityReported = false;
  #limitReported = false;

  constructor(ledger: SafetyLedger) {
    this.#ledger = ledger;
  }

  remember(requestId: string, request: CorrelationRequest, now: number): boolean {
    this.#purge(now);
    if (
      requestId.length > MAX_REDIRECT_REQUEST_ID_LENGTH
      || request.method.length > MAX_HTTP_METHOD_LENGTH
      || request.url.length > MAX_URL_LENGTH
    ) {
      this.#recordIdentityRejected();
      return false;
    }
    if (this.#entries.size >= MAX_REDIRECT_PREDECESSORS) {
      if (!this.#limitReported) {
        this.#limitReported = true;
        this.#ledger.recordInvariantViolation({
          code: 'REDIRECT_PREDECESSOR_LIMIT_REACHED',
          message: 'Redirect predecessor correlation limit reached',
        });
      }
      return false;
    }
    this.#entries.set(requestId, {
      request: { method: request.method.slice(0, MAX_HTTP_METHOD_LENGTH).toUpperCase(), url: request.url },
      expiresAt: now + REDIRECT_PREDECESSOR_RETENTION_MS,
    });
    return true;
  }

  /** 元のリクエストが終わったとき（完了か失敗）に、その登録を消す（C18h）。登録がなければ何もしない。 */
  forget(requestId: string): void {
    this.#entries.delete(requestId);
  }

  take(requestId: string, now: number): RedirectPredecessorLookup {
    if (requestId.length > MAX_REDIRECT_REQUEST_ID_LENGTH) {
      this.#recordIdentityRejected();
      return { kind: 'INVALID' };
    }
    this.#purge(now);
    const entry = this.#entries.get(requestId);
    this.#entries.delete(requestId);
    return entry === undefined ? { kind: 'MISSING' } : { kind: 'FOUND', request: entry.request };
  }

  clear(): void {
    this.#entries.clear();
    this.#identityReported = false;
    this.#limitReported = false;
  }

  #purge(now: number): void {
    for (const [requestId, entry] of this.#entries) {
      if (entry.expiresAt < now) this.#entries.delete(requestId);
    }
  }

  #recordIdentityRejected(): void {
    if (!this.#identityReported) {
      this.#identityReported = true;
      this.#ledger.recordInvariantViolation({
        code: 'CDP_CORRELATION_IDENTITY_REJECTED',
        message: 'Redirect predecessor identity exceeded its bound',
      });
    }
  }
}

/** 取り消しの証拠になる `Network.loadingFailed` の、要求の種類（Network の domain の ResourceType。DEF-026）。 */
const CANCELED_DOCUMENT_RESOURCE_TYPE = 'Document';

/** 文書の要求の、ブラウザによる取り消しの証拠（DEF-026。同じ session の `Network.loadingFailed`）。 */
interface CanceledDocumentEvidence {
  /** 期限（ms）。 */
  readonly expiresAt: number;
  /** `Network.loadingFailed` の `errorText`（文字列でなければ `null`）。DEF-027 の対応付けで、`net::ERR_ABORTED` かを確かめる。 */
  readonly errorText: string | null;
}

/**
 * Guard の page の session で、Request の段階で一時停止した main frame の文書の要求の記録（DEF-027。Network の domain の要求の ID ごと）。
 * リダイレクトの先の要求は、同じ ID の記録を上書きする（Network の domain の要求の ID は、リダイレクトの前後で同じ）。
 */
interface MainFrameDocumentRecord {
  /** 最後に Request の段階で一時停止した要求（method と URL）。Playwright の要求との対応付けに使う。 */
  request: CorrelationRequest;
  /** その要求を、Guard が Request の段階で許可して進めた（`Fetch.continueRequest` が成功した）か。 */
  continued: boolean;
  /** 応答を1つでも受けたか（Response の段階の一時停止、`Network.responseReceived`、リダイレクト）。一度真になったら戻らない。 */
  responded: boolean;
  /** 期限（ms）。 */
  expiresAt: number;
}

/** main frame の文書の要求の取り消しを、証拠で確かめた結果（DEF-027）。まだ決められなければ `PENDING`。 */
type MainFrameCancellationState = 'CONFIRMED' | 'REJECTED' | 'PENDING';

/** CDP の事象の `params` から、文字列の `requestId` を取り出す（取り出せなければ `null`）。 */
function eventRequestId(event: unknown): string | null {
  const { requestId } = (typeof event === 'object' && event !== null ? event : {}) as { readonly requestId?: unknown };
  return typeof requestId === 'string' && requestId.length > 0 ? requestId : null;
}

/**
 * 1つの CDP の session で受けた、文書の要求の、ブラウザによる取り消しの証拠を覚え、Guard の命令の失敗と対応付ける（DEF-026。設計書 2章）。
 * - 証拠（`recordLoadingFailed`）: 同じ session の `Network.loadingFailed` で、`canceled` が真で、`type` が `Document` のもの。`requestId` で
 *   覚える。証拠は、一時停止の通知より先に届くので、一時停止の有無によらず覚える。数の上限（`MAX_CANCELED_DOCUMENT_EVIDENCE`）を超える
 *   証拠は覚えない（その要求への命令の失敗は、違反のまま）。覚えておく時間は `CANCELED_DOCUMENT_EVIDENCE_RETENTION_MS` で、過ぎたら捨てる。
 * - 対応付け（`awaitCancellation`）: 命令が失敗した要求の、一時停止の通知の `networkId` の証拠があるか。なければ、決めた時間だけ待つ。
 * - 閉じる（`clear`）: session を閉じたときに、すべての証拠を消し、証拠を待っている扱いを、証拠なしで終わらせる（違反にする）。
 *   その後は、証拠を受けず、待たない。
 *
 * DEF-027（設計書 `2026-10-05-beaksight-def-027-external-cancel-design.md` 2.1、2.1.1、2.2）: page の session では、同じ証拠を、main frame
 * の読み込みの `net::ERR_ABORTED` の確かめにも使う。そこでは、証拠を次の2つに分け、両方がそろって初めて違反にしない（設計書 2.1.1）。
 * - (b) 取り消しの証拠: この部品の証拠（`canceled` が真の、`Document` の `Network.loadingFailed`）のうち、`errorText` が `net::ERR_ABORTED`
 *   のもの。`canceled` は、204 やダウンロードへの切り替わり（応答を受けた後の取り消し）でも真になるので、これだけでは、応答がページに
 *   渡っていないとは言えない。
 * - (c) 応答がページに渡っていないことの証拠: その要求について、応答（Response の段階の一時停止、`Network.responseReceived`、
 *   リダイレクト）を1つも受けていないこと（`MainFrameDocumentRecord.responded` が偽）。204 やダウンロードを外すのは、こちらである。
 * そのため、main frame の文書の要求の記録（`MainFrameDocumentRecord`）を、同じ部品に置く（取り消しの証拠を2か所に持たない）。
 * - 記録（`recordMainFramePaused`・`recordMainFrameContinued`・`recordResponseReceived`・`recordRequestWillBeSent`）: Request の段階の
 *   一時停止で記録を作り、Guard が許可して進めた（命令が成功した。(a)）こと、応答を受けたこと（Response の段階の一時停止、
 *   `Network.responseReceived`、`Network.requestWillBeSent` の `redirectResponse`、リダイレクトの先の一時停止）を記録する。
 *   数の上限は `MAX_CANCELED_DOCUMENT_EVIDENCE`（超えた要求は覚えない）、時間の上限は `PENDING_MAIN_FRAME_DOCUMENT_RETENTION_MS`。
 *   要求が終わったら、記録を消す（`recordLoadingFinished`）か、`CANCELED_DOCUMENT_EVIDENCE_RETENTION_MS` に縮める（`recordLoadingFailed`）。
 * - 確かめ（`awaitMainFrameCancellation`）: Playwright の要求（method と URL）と、記録を1対1に対応付け、(a) 許可して進めた、(b) 取り消しの
 *   証拠がある、(c) 応答がページに渡っていないことの証拠がある、のすべてを満たすときだけ真。使った記録と証拠は消す（1回だけ使う）。
 *   Guard が進める前に取り消された要求（例: 0〜5ms の間隔の `location.replace` の連続）は、(a) を満たさないので、違反のまま残る
 *   （設計書 2.1.1 の限界）。
 */
class CanceledDocumentRegistry {
  /** 証拠の `requestId` と、その期限と `errorText`。 */
  readonly #evidence = new Map<string, CanceledDocumentEvidence>();
  /** 証拠を待っている扱い（`requestId` ごと。証拠を受けたとき、session を閉じたときに呼ぶ）。 */
  readonly #waiters = new Map<string, Set<() => void>>();
  /** main frame の文書の要求の記録（DEF-027。Network の domain の要求の ID ごと。page の session だけが使う）。 */
  readonly #mainFrameDocuments = new Map<string, MainFrameDocumentRecord>();
  /** main frame の取り消しの確かめを待っている扱い（DEF-027。記録や証拠が変わったとき、session を閉じたときに呼ぶ）。 */
  readonly #mainFrameWaiters = new Set<() => void>();
  #cleared = false;

  /** 同じ session の `Network.loadingFailed` を受けたとき。文書の要求の取り消しなら覚え、その要求の証拠を待っている扱いを起こす。 */
  recordLoadingFailed(event: unknown, now: number): void {
    const { requestId, canceled, type, errorText } = (typeof event === 'object' && event !== null ? event : {}) as {
      readonly requestId?: unknown;
      readonly canceled?: unknown;
      readonly type?: unknown;
      readonly errorText?: unknown;
    };
    if (this.#cleared || typeof requestId !== 'string' || requestId.length === 0) {
      return;
    }
    // DEF-027: main frame の文書の要求が終わった。Playwright の要求と対応付けるのに要る時間だけ、記録を残す。
    const record = this.#mainFrameDocuments.get(requestId);
    if (record !== undefined) {
      record.expiresAt = Math.min(record.expiresAt, now + CANCELED_DOCUMENT_EVIDENCE_RETENTION_MS);
    }
    if (canceled !== true || type !== CANCELED_DOCUMENT_RESOURCE_TYPE) {
      this.#wakeMainFrameWaiters();
      return;
    }
    this.#purge(now);
    // 同じ要求の証拠をもう一度受けた場合は、期限を数え直す（数は増えない）。
    if (!this.#evidence.has(requestId) && this.#evidence.size >= MAX_CANCELED_DOCUMENT_EVIDENCE) {
      this.#wakeMainFrameWaiters();
      return;
    }
    this.#evidence.set(requestId, {
      expiresAt: now + CANCELED_DOCUMENT_EVIDENCE_RETENTION_MS,
      errorText: typeof errorText === 'string' ? errorText : null,
    });
    for (const wake of [...(this.#waiters.get(requestId) ?? [])]) wake();
    this.#wakeMainFrameWaiters();
  }

  /**
   * `networkId` の要求の取り消しの証拠を受けているか。まだ受けていなければ、`waitMs` まで待つ（待つ間に証拠を受けたら、すぐに真で解決する）。
   * session を閉じた後は、待たずに偽。
   */
  awaitCancellation(networkId: string, waitMs: number): Promise<boolean> {
    if (this.#hasEvidence(networkId) || waitMs <= 0 || this.#cleared) {
      return Promise.resolve(this.#hasEvidence(networkId));
    }
    return new Promise<boolean>((resolve) => {
      const waiters = this.#waiters.get(networkId) ?? new Set<() => void>();
      this.#waiters.set(networkId, waiters);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (): void => {
        clearTimeout(timer);
        waiters.delete(settle);
        if (waiters.size === 0 && this.#waiters.get(networkId) === waiters) this.#waiters.delete(networkId);
        resolve(this.#hasEvidence(networkId));
      };
      waiters.add(settle);
      timer = setTimeout(settle, waitMs);
    });
  }

  /**
   * main frame の文書の要求を、Request か Response の段階で一時停止した（DEF-027。page の session の、main frame の事象だけ）。
   * - Request の段階: 記録を作る（同じ ID の記録があれば、リダイレクトの先の要求として上書きする）。リダイレクトの先の要求
   *   （`redirectedRequestId` を持つ）は、応答を受けたものとして記録する。`networkId` がない、method や URL が上限を超える、記録の数が上限に
   *   達している場合は、覚えない（その要求の取り消しは、違反のまま）。
   * - Response の段階: 応答を受けたことを記録する。
   */
  recordMainFramePaused(event: PausedDocumentEvent, now: number): void {
    const networkId = typeof event.networkId === 'string' && event.networkId.length > 0 ? event.networkId : null;
    if (this.#cleared || networkId === null) {
      return;
    }
    this.#purgeMainFrameDocuments(now);
    const record = this.#mainFrameDocuments.get(networkId);
    if (isPausedResponse(event)) {
      if (record !== undefined) record.responded = true;
      this.#wakeMainFrameWaiters();
      return;
    }
    const request = boundedCorrelationRequest(event.request.method, event.request.url);
    const redirected = event.redirectedRequestId !== undefined;
    if (record !== undefined) {
      if (request === null) {
        this.#mainFrameDocuments.delete(networkId);
      } else {
        record.request = request;
        record.continued = false;
        record.responded ||= redirected;
      }
      this.#wakeMainFrameWaiters();
      return;
    }
    if (request === null || this.#mainFrameDocuments.size >= MAX_CANCELED_DOCUMENT_EVIDENCE) {
      return;
    }
    // 取り消しの証拠が一時停止の通知より先に届いていた（一時停止の間に取り消された）場合は、その証拠と同じ期限にする。
    this.#mainFrameDocuments.set(networkId, {
      request,
      continued: false,
      responded: redirected,
      expiresAt: this.#evidence.get(networkId)?.expiresAt ?? now + PENDING_MAIN_FRAME_DOCUMENT_RETENTION_MS,
    });
    this.#wakeMainFrameWaiters();
  }

  /** Guard が、`networkId` の要求を Request の段階で許可して進めた（`Fetch.continueRequest` が成功した。DEF-027）。記録がなければ何もしない。 */
  recordMainFrameContinued(networkId: string): void {
    const record = this.#mainFrameDocuments.get(networkId);
    if (this.#cleared || record === undefined) {
      return;
    }
    record.continued = true;
    this.#wakeMainFrameWaiters();
  }

  /** 同じ session の `Network.responseReceived` を受けたとき（DEF-027）。main frame の文書の要求の記録があれば、応答を受けたと記録する。 */
  recordResponseReceived(event: unknown): void {
    this.#markResponded(eventRequestId(event));
  }

  /** 同じ session の `Network.requestWillBeSent` を受けたとき（DEF-027）。リダイレクト（`redirectResponse` がある）なら、応答を受けたと記録する。 */
  recordRequestWillBeSent(event: unknown): void {
    const { redirectResponse } = (typeof event === 'object' && event !== null ? event : {}) as { readonly redirectResponse?: unknown };
    if (redirectResponse !== undefined) {
      this.#markResponded(eventRequestId(event));
    }
  }

  /** 同じ session の `Network.loadingFinished` を受けたとき（DEF-027）。要求は読み込みを終えたので、main frame の文書の要求の記録を消す。 */
  recordLoadingFinished(event: unknown): void {
    const requestId = eventRequestId(event);
    if (requestId !== null && this.#mainFrameDocuments.delete(requestId)) {
      this.#wakeMainFrameWaiters();
    }
  }

  /**
   * Playwright の main frame の要求（`request`。method と URL）について、この session の証拠で、(a) Guard が Request の段階で許可して
   * 進めた、(b) `net::ERR_ABORTED` で取り消された（取り消しの証拠）、(c) 応答を1つも受けていない（応答がページに渡っていないことの証拠）、
   * の3つがそろったと確かめられるか（DEF-027。設計書 2.1 の3、4、2.1.1）。
   * まだ決められなければ、`waitMs` まで待つ（待つ間に記録や証拠が変わったら、その場で確かめ直す）。session を閉じたら、偽。
   */
  awaitMainFrameCancellation(request: CorrelationRequest, waitMs: number): Promise<boolean> {
    const state = this.#settleMainFrameCancellation(request);
    if (state !== 'PENDING' || waitMs <= 0) {
      return Promise.resolve(state === 'CONFIRMED');
    }
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (confirmed: boolean): void => {
        clearTimeout(timer);
        this.#mainFrameWaiters.delete(check);
        resolve(confirmed);
      };
      const check = (): void => {
        const current = this.#settleMainFrameCancellation(request);
        if (current !== 'PENDING') finish(current === 'CONFIRMED');
      };
      this.#mainFrameWaiters.add(check);
      timer = setTimeout(() => finish(this.#settleMainFrameCancellation(request) === 'CONFIRMED'), waitMs);
    });
  }

  /** session を閉じたときに、すべての証拠と記録を消し、証拠を待っている扱いを、証拠なしで終わらせる。 */
  clear(): void {
    this.#cleared = true;
    this.#evidence.clear();
    this.#mainFrameDocuments.clear();
    const waiters = [...this.#waiters.values()].flatMap((set) => [...set]);
    this.#waiters.clear();
    for (const wake of waiters) wake();
    this.#wakeMainFrameWaiters();
  }

  #hasEvidence(networkId: string): boolean {
    const evidence = this.#evidence.get(networkId);
    return evidence !== undefined && evidence.expiresAt >= Date.now();
  }

  #purge(now: number): void {
    for (const [requestId, evidence] of this.#evidence) {
      if (evidence.expiresAt < now) this.#evidence.delete(requestId);
    }
  }

  #purgeMainFrameDocuments(now: number): void {
    for (const [networkId, record] of this.#mainFrameDocuments) {
      if (record.expiresAt < now) this.#mainFrameDocuments.delete(networkId);
    }
  }

  #markResponded(networkId: string | null): void {
    const record = networkId === null ? undefined : this.#mainFrameDocuments.get(networkId);
    if (this.#cleared || record === undefined) {
      return;
    }
    record.responded = true;
    this.#wakeMainFrameWaiters();
  }

  #wakeMainFrameWaiters(): void {
    for (const check of [...this.#mainFrameWaiters]) check();
  }

  /**
   * DEF-027: `request` の取り消しを、いまの記録と証拠で確かめる（設計書 2.1、2.1.1）。(b) の取り消しの証拠（`canceled` が真で、`errorText`
   * が `net::ERR_ABORTED`）は、204 やダウンロードへの切り替わりでもそろうので、(c) の応答がページに渡っていないことの証拠（応答を1つも
   * 受けていない）と両方がそろって初めて `CONFIRMED` にする。
   * - 同じ method と URL の記録（候補）が2つ以上ある: 区別できないので `REJECTED`。
   * - 候補が1つで、応答を受けている（(c) がない）: `REJECTED`。証拠の `errorText` が `net::ERR_ABORTED` でない（(b) がない）: `REJECTED`。
   * - 候補が1つで、(a) 許可して進めた記録、(b) 取り消しの証拠、(c) 応答を受けていないこと、がそろった: その記録と証拠を消して `CONFIRMED`。
   * - 候補がない、(a) か (b) がまだない: `PENDING`。session を閉じた後は `REJECTED`。
   */
  #settleMainFrameCancellation(request: CorrelationRequest): MainFrameCancellationState {
    if (this.#cleared) {
      return 'REJECTED';
    }
    const now = Date.now();
    this.#purge(now);
    this.#purgeMainFrameDocuments(now);
    const candidates = [...this.#mainFrameDocuments].filter(([, record]) => record.request.method === request.method
      && record.request.url === request.url);
    if (candidates.length > 1) {
      return 'REJECTED';
    }
    const [candidate] = candidates;
    if (candidate === undefined) {
      return 'PENDING';
    }
    const [networkId, record] = candidate;
    const evidence = this.#evidence.get(networkId);
    if (record.responded || (evidence !== undefined && evidence.errorText !== NAVIGATION_ABORTED_ERROR_TEXT)) {
      return 'REJECTED';
    }
    if (evidence === undefined || !record.continued) {
      return 'PENDING';
    }
    this.#mainFrameDocuments.delete(networkId);
    this.#evidence.delete(networkId);
    return 'CONFIRMED';
  }
}

/**
 * 一時停止した1つの文書の要求への、Guard の命令（DEF-026）。どちらも `settlePausedDocumentCommand` で結果を決める（ブラウザが取り消した
 * 要求への命令の失敗は、成功と同じに解決する。それ以外の失敗は投げる）。
 */
interface PausedDocumentCommands {
  continueRequest(): Promise<void>;
  failRequest(): Promise<void>;
}

/**
 * 一時停止した文書の要求への Guard の命令（`send`）を送り、その結果を決める（DEF-026。設計書 2章）。page の session と OOPIF の session、
 * Request の段階と Response の段階の、すべての `Fetch.continueRequest` と `Fetch.failRequest` は、この関数で結果を決める。
 * - 成功: 解決する。
 * - 失敗: 次のすべてを満たすときだけ、ブラウザが取り消した要求への命令として、成功と同じに解決する。
 *   1. 失敗の文言が、一時停止の ID が無効な形（`isInvalidInterceptionIdFailure`）である。
 *   2. 一時停止の通知に `networkId` がある。
 *   3. 同じ session で、その `networkId` の取り消しの証拠を受けている（一時停止の通知より前に受けたものを含む）。まだなら、
 *      `CANCELED_DOCUMENT_EVIDENCE_WAIT_MS` まで待つ。Guard や page が閉じる途中（`closing` が真）なら待たない。待つ間に session を
 *      閉じた（`clear`）場合も、待つのをやめる。
 *   どれかを満たさなければ、受けた失敗をそのまま投げる（呼び出し側が、今のとおり違反にする。fail-closed）。
 */
async function settlePausedDocumentCommand(
  send: () => Promise<unknown>,
  canceledDocuments: CanceledDocumentRegistry,
  networkId: string | null,
  closing: () => boolean,
): Promise<void> {
  try {
    await send();
  } catch (error) {
    if (
      networkId === null
      || !isInvalidInterceptionIdFailure(errorMessage(error))
      || !(await canceledDocuments.awaitCancellation(networkId, closing() ? 0 : CANCELED_DOCUMENT_EVIDENCE_WAIT_MS))
    ) {
      throw error;
    }
  }
}

/**
 * Document でない一時停止の要求への Guard の命令（`send`）を送り、その結果を決める（DEF-042。設計書 2.1）。
 * - 成功: 解決する。
 * - 失敗の文言が、一時停止の ID が無効な形（`isInvalidInterceptionIdFailure`）なら、ブラウザが先に取り消した要求への命令として、成功と
 *   同じに解決する。Document の取り消しの証拠（DEF-026。`CanceledDocumentRegistry`）は Document の要求だけを対象にし、Document でない
 *   要求には集めない（ページを離れるときに取り消される要求は数が多く、証拠の上限を超えうるため）。
 * - それ以外の失敗は、そのまま投げる（呼び出し側が違反にする。fail-closed）。
 */
async function settlePausedRequestCommand(send: () => Promise<unknown>): Promise<void> {
  try {
    await send();
  } catch (error) {
    if (!isInvalidInterceptionIdFailure(errorMessage(error))) {
      throw error;
    }
  }
}

/**
 * Guard の CDP の命令が、session か target が閉じたために失敗したときの、失敗の文言の閉じた一覧（DEF-042 の設計書 2.4）。
 * - page の session（Playwright の `CDPSession.send`）: Playwright が、閉じた target への命令に付ける文言（Playwright 1.62.1。
 *   `fixture-full-crawl` の CLI の Chromium で、Context を閉じる途中に実際に起きた失敗から取った）。
 * - OOPIF の session（`OopifTargetChannel`）: Guard 自身が、閉じた session への命令を失敗させるときの文言。
 * 照合は完全一致で、前方一致や部分一致にはしない（一覧にない文言は、閉じた失敗とみなさない。違反にする側に倒す）。
 */
const CLOSED_TARGET_FAILURE_TEXTS: ReadonlySet<string> = new Set([
  'cdpSession.send: Target page, context or browser has been closed',
  OOPIF_SESSION_CLOSED_MESSAGE,
]);

/** 命令の失敗の文言が、session か target が閉じた形（`CLOSED_TARGET_FAILURE_TEXTS` のどれか）と完全に一致するか。 */
function isClosedTargetFailure(message: string): boolean {
  return CLOSED_TARGET_FAILURE_TEXTS.has(message);
}

/**
 * CORS の事前確認（preflight）の要求の `networkId` を覚えておく時間（ms。DEF-042 の設計書 2.4）。`Network.requestWillBeSent`
 * （`initiator.type` が `preflight`）を受けてから数える。同じ要求の `Fetch.requestPaused`（Request の段階）は、ふつう数 ms 以内に届く。
 * 過ぎた記録は捨て、その要求は、ヘッダ（`Access-Control-Request-Method`）で判定する。
 */
const PREFLIGHT_INITIATOR_RETENTION_MS = 1_000;
/** 同時に覚えておく、CORS の事前確認の要求の `networkId` の数の上限。超えた要求は覚えず、ヘッダで判定する。 */
const MAX_PREFLIGHT_INITIATORS = 256;

/**
 * 同じ session の `Network.requestWillBeSent` で、`initiator.type` が `preflight` だった要求の `networkId` の記録（DEF-042 の設計書 2.4。
 * CORS の事前確認の判定の第一の根拠）。
 */
class PreflightInitiatorRegistry {
  readonly #entries = new Map<string, number>();

  /** `Network.requestWillBeSent` を受けたとき。事前確認の要求なら、その `requestId` を覚える。 */
  record(event: unknown, now: number): void {
    const { requestId, initiator } = (typeof event === 'object' && event !== null ? event : {}) as {
      readonly requestId?: unknown;
      readonly initiator?: { readonly type?: unknown };
    };
    if (typeof requestId !== 'string' || requestId.length === 0 || initiator?.type !== 'preflight') {
      return;
    }
    this.#purge(now);
    if (this.#entries.size >= MAX_PREFLIGHT_INITIATORS) {
      return;
    }
    this.#entries.set(requestId, now + PREFLIGHT_INITIATOR_RETENTION_MS);
  }

  /** `networkId` の要求が事前確認として覚えられているか。あれば、その記録を消して真を返す。 */
  take(networkId: string, now: number): boolean {
    this.#purge(now);
    return this.#entries.delete(networkId);
  }

  clear(): void {
    this.#entries.clear();
  }

  #purge(now: number): void {
    for (const [requestId, expiresAt] of this.#entries) {
      if (expiresAt <= now) this.#entries.delete(requestId);
    }
  }
}

/** 要求のヘッダ（CDP の `Network.Headers`）から、名前が `name`（大文字小文字を区別しない）のものの値を返す。なければ `undefined`。 */
function requestHeader(headers: Readonly<Record<string, string>> | undefined, name: string): string | undefined {
  if (headers === undefined) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted && typeof value === 'string') return value;
  }
  return undefined;
}

/** CORS の事前確認の要求が持つヘッダの名前。 */
const ACCESS_CONTROL_REQUEST_METHOD_HEADER = 'Access-Control-Request-Method';
const ACCESS_CONTROL_REQUEST_HEADERS_HEADER = 'Access-Control-Request-Headers';
/** `Fetch.fulfillRequest` で事前確認に返す応答の状態（Playwright と同じ `204 No Content`）。 */
const PREFLIGHT_RESPONSE_CODE = 204;
const PREFLIGHT_RESPONSE_PHRASE = 'No Content';
/** 要求に `Access-Control-Request-Method` がないときに返す `Access-Control-Allow-Methods` の値（Playwright と同じ）。 */
const PREFLIGHT_DEFAULT_ALLOW_METHODS = 'GET, POST, OPTIONS, DELETE';

/**
 * CORS の事前確認に返す応答のヘッダ（DEF-042 の設計書 2.4）。Playwright が横取りのあるときに事前確認を自分で満たす処理
 * （`isInterceptedOptionsPreflight`）と同じ値にする: `Access-Control-Allow-Origin` は要求の `Origin` か `*`、`Allow-Methods` は要求の
 * `Access-Control-Request-Method` か既定の一覧、`Allow-Credentials` は `true`、`Allow-Headers` は要求の `Access-Control-Request-Headers`
 * があるときだけ、その値。
 */
function preflightResponseHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): { name: string; value: string }[] {
  const responseHeaders = [
    { name: 'Access-Control-Allow-Origin', value: requestHeader(headers, 'Origin') ?? '*' },
    { name: 'Access-Control-Allow-Methods', value: requestHeader(headers, ACCESS_CONTROL_REQUEST_METHOD_HEADER) ?? PREFLIGHT_DEFAULT_ALLOW_METHODS },
    { name: 'Access-Control-Allow-Credentials', value: 'true' },
  ];
  const requestedHeaders = requestHeader(headers, ACCESS_CONTROL_REQUEST_HEADERS_HEADER);
  if (requestedHeaders !== undefined) {
    responseHeaders.push({ name: 'Access-Control-Allow-Headers', value: requestedHeaders });
  }
  return responseHeaders;
}

/**
 * Worker の中の WebSocket を止める CSP の policy（DEF-040。設計書 `2026-10-08-beaksight-def-039-040-egress-design.md` 2.2。NP2 の調査で確定）。
 * `connect-src` は、WebSocket（`ws:`・`wss:`）と `about:` などのスキームへの接続を止め、http(s)・data・blob への接続（fetch、XHR、beacon、
 * EventSource、ping、img、script）は変えない。Guard が、次の 2 つの経路で、Passive と Interaction のすべての Context に適用する。
 * - 文書: Context の `addInitScript`（`WORKER_CONNECT_POLICY_INIT_SCRIPT`）で、文書の始まりに meta の CSP を入れてすぐ外す。meta を外しても
 *   policy は文書に残り、blob・data の Worker（入れ子、srcdoc・about:blank の iframe の中を含む）に引き継がれる。DOM の Evidence には写らない。
 *   Document の応答にヘッダを加えても、文書の CSP としては効かない（NP2）ので、meta が要る。
 * - http(s) の script の Worker（Dedicated、Shared、module）: Worker の CSP は script の応答のものなので、CDP の Fetch の `Other` の応答の
 *   段階で、同じ policy のヘッダを加える（`handlePausedResponse`）。
 * 残る経路（設計書 2.2）: SVG の文書（meta を入れられない）、WebTransport（`https:` で許される。推測）。
 */
export const WORKER_CONNECT_POLICY = 'connect-src http: https: data: blob:';

/** 応答に加える CSP のヘッダの名前（meta の `http-equiv` も同じ名前）。 */
const CONTENT_SECURITY_POLICY_HEADER = 'Content-Security-Policy';

/**
 * 文書の始まりに meta の CSP（`WORKER_CONNECT_POLICY`）を入れてすぐ外す、Context の初期化のスクリプト（DEF-040。設計書 2.2）。
 * meta の CSP は head の中でだけ効くので、head がまだなければ（HTML の解析の前に動くとき）、head ができるのを MutationObserver で待つ。
 * HTML の解析は、script を実行する前に microtask の checkpoint を行うので、ページの最初の script より前に policy が効く。
 */
export const WORKER_CONNECT_POLICY_INIT_SCRIPT = `(() => {
  const enforce = () => {
    const meta = document.createElement('meta');
    meta.httpEquiv = ${JSON.stringify(CONTENT_SECURITY_POLICY_HEADER)};
    meta.content = ${JSON.stringify(WORKER_CONNECT_POLICY)};
    document.head.prepend(meta);
    meta.remove();
  };
  if (document.head !== null) {
    enforce();
    return;
  }
  const observer = new MutationObserver(() => {
    if (document.head !== null) {
      observer.disconnect();
      enforce();
    }
  });
  observer.observe(document, { childList: true, subtree: true });
})();`;

/**
 * Service Worker の登録の入口を塞いだ関数が投げる例外の文言（DEF-049。設計書 `2026-10-08-beaksight-def-044-046-review-fixes-design.md` 5 と
 * 変更履歴の NP6 の Blocker の行）。ページの回避の試みは、この文言の例外になる（ページの console に出て、Evidence に写る）。
 */
export const SERVICE_WORKER_REGISTRATION_BLOCKED_MESSAGE = 'Service Worker registration blocked by BeakSight';

/**
 * Service Worker の登録の入口を塞ぐ、Context の初期化のスクリプト（DEF-049 の主な防御）。Playwright の `serviceWorkers: 'block'` は、
 * `navigator.serviceWorker` のインスタンスの `register` を置き換えるだけなので、ページは `ServiceWorkerContainer.prototype.register.call` や、
 * インスタンスの `register` を `delete` した後の呼び出しで迂回できる（登録された Service Worker の中の要求は、Guard の route も CDP の
 * 横取りも通らない）。そこで、文書ごとに次を行う。
 * - `ServiceWorkerContainer.prototype.register` を、`SERVICE_WORKER_REGISTRATION_BLOCKED_MESSAGE` の例外を投げる関数に置き換え、
 *   `writable: false`・`configurable: false` で固定する（ページは定義し直せない）。
 * - `Navigator.prototype.serviceWorker` の getter を、元の getter のまま `configurable: false` にする（同じ Container を返し続ける）。
 * 通常の呼び出し（Playwright がインスタンスに付けた `register`）は、今までどおり何もせずに解決する。Context の初期化のスクリプトは、
 * すべての frame（同じ Origin の iframe、about:blank・srcdoc の iframe、ポップアップ）の文書に付く（NP6 の実験で、すべての経路が
 * 止まることを確かめた）。それでも登録された場合は、factory の自己検査（`SERVICE_WORKER_OBSERVED`）が Context を閉じる。
 */
export const SERVICE_WORKER_REGISTRATION_BLOCK_INIT_SCRIPT = `(() => {
  const Container = globalThis.ServiceWorkerContainer;
  if (typeof Container === 'function') {
    const register = function register() {
      throw new Error(${JSON.stringify(SERVICE_WORKER_REGISTRATION_BLOCKED_MESSAGE)});
    };
    Object.defineProperty(Container.prototype, 'register', {
      value: register,
      writable: false,
      enumerable: true,
      configurable: false,
    });
  }
  const NavigatorConstructor = globalThis.Navigator;
  const descriptor = typeof NavigatorConstructor === 'function'
    ? Object.getOwnPropertyDescriptor(NavigatorConstructor.prototype, 'serviceWorker')
    : undefined;
  if (descriptor !== undefined && descriptor.configurable) {
    Object.defineProperty(NavigatorConstructor.prototype, 'serviceWorker', {
      get: descriptor.get,
      enumerable: descriptor.enumerable,
      configurable: false,
    });
  }
})();`;

/** `Fetch.continueResponse` に渡す応答の文言が、ブラウザからも Node の一覧（`STATUS_CODES`）からも取れないときの値。 */
const DEFAULT_RESPONSE_PHRASE = 'OK';

/**
 * `Fetch.continueResponse` に渡す、`Other` の応答に CSP のヘッダ（`WORKER_CONNECT_POLICY`）を加えた指定（DEF-040。設計書 2.2）。
 * - status のある応答: `responseCode`・`responsePhrase`・`responseHeaders`（元のヘッダ + CSP）の 3 つを必ず渡す。`responseHeaders` だけを
 *   渡すと Chromium が受け付けず、要求が一時停止のまま残る（NP2 で固まった原因）。文言は、ブラウザの `responseStatusText`、なければ
 *   Node の `STATUS_CODES`、それもなければ `DEFAULT_RESPONSE_PHRASE`。
 * - status のない応答（ネットワークの失敗。`responseErrorReason`）: 本文がなく Worker は動かないので、何も変えずに続ける（`requestId` だけ）。
 */
function workerConnectPolicyResponse(event: PausedDocumentEvent): {
  readonly requestId: string;
  readonly responseCode?: number;
  readonly responsePhrase?: string;
  readonly responseHeaders?: { readonly name: string; readonly value: string }[];
} {
  const status = event.responseStatusCode;
  if (status === undefined) {
    return { requestId: event.requestId };
  }
  const statusText = event.responseStatusText;
  return {
    requestId: event.requestId,
    responseCode: status,
    responsePhrase: typeof statusText === 'string' && statusText.length > 0
      ? statusText
      : STATUS_CODES[status] ?? DEFAULT_RESPONSE_PHRASE,
    responseHeaders: [
      ...(event.responseHeaders ?? []).map(({ name, value }) => ({ name, value })),
      { name: CONTENT_SECURITY_POLICY_HEADER, value: WORKER_CONNECT_POLICY },
    ],
  };
}

/** `Log.entryAdded` の `entry.source` のうち、Worker の中の文。 */
const WORKER_LOG_SOURCE = 'worker';
/**
 * Chromium が、`WORKER_CONNECT_POLICY` の違反のときに Log に残す文の形（Chromium 151。NP3 で両方の Chromium で確かめた）:
 * `Connecting to '<url>' violates the following Content Security Policy directive: "<policy>". The action has been blocked.`
 * policy の部分を照合するので、サイト自身の CSP の違反（別の policy の文）は記録しない。
 */
const WORKER_CONNECT_POLICY_VIOLATION_PREFIX = "Connecting to '";
const WORKER_CONNECT_POLICY_VIOLATION_SUFFIX = `' violates the following Content Security Policy directive: "${WORKER_CONNECT_POLICY}"`;
/** WebSocket の URL のスキーム（`URL.protocol` の形）。`connect-src` は `about:` などへの fetch も止めるが、それは WebSocket の記録にしない。 */
const WEBSOCKET_PROTOCOLS: ReadonlySet<string> = new Set(['ws:', 'wss:']);

/**
 * Guard の page の session の `Log.entryAdded` の事象が、Worker の中の WebSocket を `WORKER_CONNECT_POLICY` で止めた文なら、その WebSocket の
 * URL を返す（DEF-040 の設計書 2.2 の記録）。それ以外（Worker 以外の文、別の policy の違反、WebSocket でない接続、解析できない URL）は `null`。
 */
export function workerConnectPolicyViolationUrl(event: unknown): string | null {
  const { entry } = (typeof event === 'object' && event !== null ? event : {}) as { readonly entry?: unknown };
  const { source, text } = (typeof entry === 'object' && entry !== null ? entry : {}) as {
    readonly source?: unknown;
    readonly text?: unknown;
  };
  if (source !== WORKER_LOG_SOURCE || typeof text !== 'string' || !text.startsWith(WORKER_CONNECT_POLICY_VIOLATION_PREFIX)) {
    return null;
  }
  const end = text.indexOf(WORKER_CONNECT_POLICY_VIOLATION_SUFFIX, WORKER_CONNECT_POLICY_VIOLATION_PREFIX.length);
  if (end < 0) {
    return null;
  }
  const url = text.slice(WORKER_CONNECT_POLICY_VIOLATION_PREFIX.length, end);
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return null;
  }
  return WEBSOCKET_PROTOCOLS.has(protocol) ? url : null;
}

function recordGuardTaskDrainTimeoutOnce(guardState: GuardState): void {
  if (guardState.drainTimeoutReported) return;
  guardState.drainTimeoutReported = true;
  guardState.ledger.recordInvariantViolation({
    code: 'GUARD_PENDING_TASK_DRAIN_TIMEOUT',
    message: GUARD_PENDING_TASK_DRAIN_TIMEOUT_MESSAGE,
  });
}

async function drainGuardTasks(
  guardState: GuardState,
  onDrained: () => void,
): Promise<'DRAINED' | 'TIMED_OUT'> {
  const deadlineAt = Date.now() + GUARD_PENDING_TASK_DRAIN_TIMEOUT_MS;
  while (guardState.pendingTasks.size > 0) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      recordGuardTaskDrainTimeoutOnce(guardState);
      return 'TIMED_OUT';
    }
    const stableTasks = Array.from(guardState.pendingTasks);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const settled = await Promise.race([
        Promise.allSettled(stableTasks).then(() => true),
        new Promise<false>((resolveTimeout) => {
          timer = setTimeout(() => resolveTimeout(false), remainingMs);
        }),
      ]);
      if (!settled) {
        recordGuardTaskDrainTimeoutOnce(guardState);
        return 'TIMED_OUT';
      }
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
  // 終端状態への遷移と、最終的な空集合の観測は1つの同期境界を成す。
  // その間にプロトコルコールバックが割り込むことはできない。
  onDrained();
  return 'DRAINED';
}

function runListenerCleanups(guardState: GuardState, cleanups: readonly (() => void)[]): void {
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch (error) {
      guardState.ledger.recordInvariantViolation({
        code: 'GUARD_LISTENER_CLEANUP_FAILED',
        message: errorMessage(error),
      });
    }
  }
}

function takeListenerCleanups(group: ListenerCleanupGroup): Array<() => void> {
  if (!group.active) return [];
  group.active = false;
  return group.cleanups.splice(0);
}

function releasePageListenerGroup(guardState: GuardState, page: Page): void {
  const group = guardState.listenerCleanups.pages.get(page);
  if (group === undefined) return;
  guardState.listenerCleanups.pages.delete(page);
  runListenerCleanups(guardState, takeListenerCleanups(group));
}

function detachGuardListeners(guardState: GuardState): void {
  const pageGroups = Array.from(guardState.listenerCleanups.pages.values());
  guardState.listenerCleanups.pages.clear();
  const cleanups = [
    ...takeListenerCleanups(guardState.listenerCleanups.context),
    ...pageGroups.flatMap((group) => takeListenerCleanups(group)),
  ];
  runListenerCleanups(guardState, cleanups);
}

function classifyMainFrame(request: Request, ledger: SafetyLedger): boolean | undefined {
  if (!request.isNavigationRequest()) {
    return false;
  }
  try {
    return request.frame().parentFrame() === null;
  } catch (error) {
    ledger.recordInvariantViolation({
      code: 'FRAME_CLASSIFICATION_FAILED',
      message: errorMessage(error),
    });
    return undefined;
  }
}

function ensureCloseAttempt(
  guardState: GuardState,
  source: CloseAttemptSource,
): Promise<CloseAttemptResult> {
  if (guardState.phase === 'CLOSED') {
    return Promise.resolve(Object.freeze({ invalidated: true }));
  }
  if (guardState.closeAttempt !== undefined) return guardState.closeAttempt;

  // 最初のraw-closeの副作用より前に公開し、同期的なコールバックが確実に合流できるようにする。
  let begin!: () => void;
  const start = new Promise<void>((resolve) => { begin = resolve; });
  const attempt = (async (): Promise<CloseAttemptResult> => {
    await start;
    if (!guardState.rawCloseConfirmed) {
      try {
        await guardState.context.close();
        guardState.rawCloseConfirmed = true;
      } catch (error) {
        guardState.phase = invalidatingPhase(guardState.phase);
        guardState.ledger.recordInvariantViolation({
          code: source === 'OWNER_CLOSE'
            ? 'GUARDED_CONTEXT_CLOSE_FAILED'
            : 'GUARD_CONTEXT_INVALIDATION_FAILED',
          message: errorMessage(error),
        });
        throw error;
      }
    }

    detachGuardListeners(guardState);
    let invalidated = false;
    const drainResult = await drainGuardTasks(guardState, () => {
      invalidated = guardState.phase === 'PASSIVE_INVALIDATING'
        || guardState.phase === 'FROZEN_INVALIDATING';
      guardState.phase = 'CLOSED';
    });
    if (drainResult === 'TIMED_OUT') {
      guardState.phase = invalidatingPhase(guardState.phase);
      throw new GuardTaskDrainTimeoutError();
    }
    return Object.freeze({ invalidated });
  })();
  guardState.closeAttempt = attempt;
  void attempt.then(
    () => undefined,
    () => {
      if (guardState.closeAttempt === attempt && guardState.phase !== 'CLOSED') {
        guardState.closeAttempt = undefined;
      }
    },
  );
  begin();
  return attempt;
}

async function invalidateContext(context: BrowserContext, _ledger: SafetyLedger): Promise<void> {
  const guardState = guardStates.get(context);
  if (guardState === undefined || guardState.phase === 'CLOSED') return;
  guardState.phase = invalidatingPhase(guardState.phase);
  await ensureCloseAttempt(guardState, 'SAFETY_INVALIDATION');
}

function containInvalidationFailure(completion: Promise<void>, ledger: SafetyLedger): Promise<void> {
  return completion.catch((error: unknown) => {
    try {
      if (error instanceof GuardTaskDrainTimeoutError) return;
    } catch {
      // raw-closeの任意の拒否理由は、prototypeの検査中に例外を投げることがある。
    }
    ledger.recordInvariantViolation({
      code: 'GUARD_CONTEXT_INVALIDATION_OWNER_FAILED',
      message: errorMessage(error),
    });
  });
}

function initiateInvalidation(context: BrowserContext, ledger: SafetyLedger): Promise<void> {
  return containInvalidationFailure(invalidateContext(context, ledger), ledger);
}

function beginOverflowInvalidationOnce(guardState: GuardState): void {
  if (guardState.overflowInvalidation !== undefined || guardState.phase === 'CLOSED') {
    return;
  }
  const reservedInvalidation = invalidateContext(guardState.context, guardState.ledger).finally(() => {
    guardState.overflowInvalidation = undefined;
  });
  guardState.overflowInvalidation = reservedInvalidation;
  void reservedInvalidation.catch(() => undefined);
}

/**
 * Guard の作業の種類（DEF-042 の設計書 2.4）。`REQUEST` は要求の横取りの作業（`handlePausedRequest`）で、上限は
 * `MAX_PENDING_GUARD_REQUEST_TASKS`。`GENERAL` はそれ以外の作業で、上限は `MAX_PENDING_GUARD_TASKS`（要求の横取りの作業は数えない）。
 */
type GuardTaskKind = 'GENERAL' | 'REQUEST';

function admitGuardTask(guardState: GuardState, purpose: string, kind: GuardTaskKind): boolean {
  const pending = kind === 'REQUEST'
    ? guardState.pendingRequestTaskCount
    : guardState.pendingTasks.size - guardState.pendingRequestTaskCount;
  const limit = kind === 'REQUEST' ? MAX_PENDING_GUARD_REQUEST_TASKS : MAX_PENDING_GUARD_TASKS;
  if (pending >= limit) {
    if (!guardState.taskLimitReported) {
      guardState.taskLimitReported = true;
      guardState.ledger.recordInvariantViolation({ code: 'GUARD_TASK_LIMIT_REACHED', message: purpose });
    }
    beginOverflowInvalidationOnce(guardState);
    return false;
  }
  return true;
}

function trackGuardTask(
  guardState: GuardState,
  purpose: string,
  rejectionCode: string,
  factory: () => Promise<unknown>,
  kind: GuardTaskKind = 'GENERAL',
): boolean {
  if (!admitGuardTask(guardState, purpose, kind)) return false;
  let owned!: Promise<void>;
  owned = Promise.resolve().then(factory).then(
    () => undefined,
    (error: unknown) => guardState.ledger.recordInvariantViolation({
      code: rejectionCode,
      message: errorMessage(error),
    }),
  ).finally(() => {
    guardState.pendingTasks.delete(owned);
    if (kind === 'REQUEST') guardState.pendingRequestTaskCount -= 1;
  });
  guardState.pendingTasks.add(owned);
  if (kind === 'REQUEST') guardState.pendingRequestTaskCount += 1;
  return true;
}

/** 決着がつくまでプロトコル証跡の所有権を保持する。無効化への合流は、そのdrainの外側でのみ行う。 */
function runGuardProtocolTask(
  guardState: GuardState,
  purpose: string,
  rejectionCode: string,
  factory: (requestInvalidation: () => void) => Promise<void>,
): Promise<void> {
  // 拒否されたHTTPは一時停止のままとなり、拒否されたWebSocketはサーバーへ接続しない。
  // オーバーフロー時にfallback/continue/connectへ逃げてはならない。
  if (guardState.phase === 'CLOSED') {
    return Promise.resolve();
  }
  if (!admitGuardTask(guardState, purpose, 'GENERAL')) return Promise.resolve();
  let invalidationRequested = false;
  let invalidation: Promise<void> | undefined;
  let failed = false;
  let failure: unknown;
  let owned!: Promise<void>;
  owned = Promise.resolve().then(() => factory(() => { invalidationRequested = true; })).catch((error: unknown) => {
    failed = true;
    failure = error;
    if (!invalidationRequested) {
      guardState.ledger.recordInvariantViolation({ code: rejectionCode, message: errorMessage(error) });
      invalidationRequested = true;
    }
  }).finally(() => {
    guardState.pendingTasks.delete(owned);
    // 証跡は確定しており、この作業はもうpendingTasksには含まれていない。昇格は
    // ここで同期的に行われ、drain中のownerがCLOSEDに到達するより先に完了する。
    if (invalidationRequested) {
      invalidation = invalidateContext(guardState.context, guardState.ledger);
      void containInvalidationFailure(invalidation, guardState.ledger);
    }
  });
  guardState.pendingTasks.add(owned);
  return owned.then(async () => {
    await invalidation;
    if (failed) throw failure;
  });
}

function recordBlockedDecision(
  ledger: SafetyLedger,
  decision: BlockDecision,
  request: { readonly method: string; readonly url: string },
): void {
  if (decision.category === 'REQUEST') {
    ledger.recordBlockedRequest({ ...request, reason: decision.reason });
  } else if (decision.category === 'NAVIGATION') {
    ledger.recordBlockedNavigation({ ...request, reason: decision.reason });
  } else {
    ledger.recordInvariantViolation({
      code: 'UNEXPECTED_HTTP_DECISION',
      message: `HTTP policy returned ${decision.category}`,
    });
  }
}

async function abortHttpRequest(
  requestInvalidation: () => void,
  route: Route,
  ledger: SafetyLedger,
  decision: BlockDecision,
  request: { readonly method: string; readonly url: string },
): Promise<void> {
  try {
    await route.abort('blockedbyclient');
    recordBlockedDecision(ledger, decision, request);
  } catch (error) {
    ledger.recordInvariantViolation({ code: 'HTTP_ABORT_FAILED', message: errorMessage(error) });
    requestInvalidation();
    throw error;
  }
}

async function abortUnreadyNavigation(
  requestInvalidation: () => void,
  route: Route,
  ledger: SafetyLedger,
): Promise<void> {
  let abortFailed = false;
  let abortError: unknown;
  try {
    await route.abort('blockedbyclient');
  } catch (error) {
    abortFailed = true;
    abortError = error;
    ledger.recordInvariantViolation({ code: 'HTTP_ABORT_FAILED', message: errorMessage(error) });
  }
  requestInvalidation();
  if (abortFailed) {
    throw abortError;
  }
}

async function abortInteractionRequest(
  requestInvalidation: () => void,
  route: Route,
  ledger: SafetyLedger,
  request: { readonly method: string; readonly url: string; readonly navigation: boolean },
): Promise<void> {
  ledger.recordBlockedInteractionRequest({
    method: request.method,
    url: request.url,
    reason: 'INTERACTION_FROZEN',
  });
  if (request.navigation) {
    ledger.recordBlockedInteractionNavigation({
      method: request.method,
      url: request.url,
      reason: 'INTERACTION_FROZEN',
    });
  }
  try {
    await route.abort('blockedbyclient');
  } catch (error) {
    ledger.recordInvariantViolation({ code: 'INTERACTION_HTTP_ABORT_FAILED', message: errorMessage(error) });
    requestInvalidation();
    throw error;
  }
}

async function continueNative(requestInvalidation: () => void, route: Route, ledger: SafetyLedger): Promise<void> {
  try {
    await route.fallback();
  } catch (error) {
    ledger.recordInvariantViolation({ code: 'HTTP_FALLBACK_FAILED', message: errorMessage(error) });
    try {
      await route.abort('blockedbyclient');
    } catch (abortError) {
      ledger.recordInvariantViolation({ code: 'HTTP_ABORT_FAILED', message: errorMessage(abortError) });
    }
    requestInvalidation();
    throw error;
  }
}

async function failPausedDocumentForLifecycle(
  context: BrowserContext,
  commands: PausedDocumentCommands,
  ledger: SafetyLedger,
  expectedCdpFailures: ExpectedCdpFailureRegistry,
  page: Page,
  request: CorrelationRequest,
): Promise<void> {
  const expectedFailure = expectedCdpFailures.register(page, request, Date.now());
  try {
    await commands.failRequest();
  } catch (error) {
    if (expectedFailure !== null) expectedCdpFailures.remove(page, expectedFailure);
    const message = errorMessage(error);
    // DEF-050: Context の閉じる処理が始まった後の、閉じた形の失敗は、target とともに消えた要求として違反にしない（DEF-042 の設計書
    // 2.4、DEF-045 と同じ考え）。page だけを閉じる途中など、Context の閉じる処理の前の同じ失敗は、今までどおり違反。
    const guardState = guardStates.get(context);
    if (isClosedTargetFailure(message) && guardState !== undefined && hasContextCloseStarted(guardState)) return;
    ledger.recordInvariantViolation({
      code: 'CDP_LIFECYCLE_FAIL_REQUEST_FAILED',
      message,
    });
    if (!isClosingOrInvalidatingPhase(guardStates.get(context)?.phase ?? 'CLOSED')) {
      initiateInvalidation(context, ledger);
    }
  }
}

export async function awaitPassiveRequestGuardReady(page: Page): Promise<void> {
  const context = page.context();
  const guardState = guardStates.get(context);
  if (guardState === undefined) {
    throw new Error('Passive request guard is not installed for this page context');
  }
  if (isClosingOrInvalidatingPhase(guardState.phase)) {
    const failedReadiness = guardState.pageGuards.get(page);
    if (failedReadiness?.status === 'FAILED') {
      await failedReadiness.ready.catch((cause: unknown) => {
        throw new Error('Passive request guard context was invalidated', { cause });
      });
    }
    throw new Error('Passive request guard context was invalidated');
  }
  if (guardState.phase !== 'PASSIVE_ACTIVE') {
    throw new Error('Passive request guard is not installed for this page context');
  }
  if (page.isClosed()) {
    throw new Error('Passive request guard cannot become ready for a closed page');
  }
  await guardState.ensurePageGuard(page).ready;
  await Promise.resolve();
  await Promise.resolve();
  if (guardState.phase !== 'PASSIVE_ACTIVE') {
    throw new Error('Passive request guard context was invalidated');
  }
  if (page.isClosed()) {
    throw new Error('Passive request guard page closed during setup');
  }
}

function requireGuardState(context: BrowserContext, allowed: readonly GuardPhase[]): GuardState {
  const guardState = guardStates.get(context);
  if (guardState === undefined || !allowed.includes(guardState.phase)) {
    throw new Error(`Passive request guard phase is not allowed (${guardState?.phase ?? 'MISSING'})`);
  }
  return guardState;
}

function requireActiveGuardState(context: BrowserContext, allowed: readonly GuardPhase[]): GuardState {
  const guardState = guardStates.get(context);
  if (guardState === undefined) {
    throw new Error('Passive request guard is not installed for this context');
  }
  if (isClosingOrInvalidatingPhase(guardState.phase)) {
    throw new Error('Passive request guard context was invalidated');
  }
  return requireGuardState(context, allowed);
}

export function assertPassiveRequestGuardActive(context: BrowserContext): void {
  requireActiveGuardState(context, ['PASSIVE_ACTIVE', 'FROZEN_ACTIVE']);
}

/** ファクトリは、raw closeとタスクのdrainが両方とも終端状態に達した後にのみ所有権を解放できる。 */
export function isPassiveRequestGuardClosed(context: BrowserContext): boolean {
  return guardStates.get(context)?.phase === 'CLOSED';
}

/** 既存のpassive guardを、以降のあらゆる新規アクティビティを凍結する状態へ不可逆的に変更する。 */
export async function activateInteractionFreeze(page: Page): Promise<void> {
  const context = page.context();
  const guardState = requireActiveGuardState(context, ['PASSIVE_ACTIVE', 'FROZEN_ACTIVE']);
  const failClosed = async (message: string): Promise<never> => {
    guardState.ledger.recordInvariantViolation({ code: 'INTERACTION_FREEZE_ACTIVATION_FAILED', message });
    await invalidateContext(context, guardState.ledger);
    throw new Error(message);
  };
  if (guardState.phase !== 'PASSIVE_ACTIVE') {
    return failClosed(`Interaction freeze transition is invalid from ${guardState.phase}`);
  }
  if (page.isClosed() || guardState.pageGuards.get(page)?.status !== 'READY') {
    return failClosed('Interaction freeze requires the current guarded page to be ready');
  }
  const activePages = context.pages().filter((candidate) => !candidate.isClosed());
  if (activePages.length !== 1 || activePages[0] !== page) {
    return failClosed('Interaction freeze requires exactly one current owner page');
  }
  let currentUrl: URL;
  try {
    currentUrl = new URL(page.url());
  } catch {
    return failClosed('Interaction freeze requires a completed initial HTTP(S) load');
  }
  if (!isHttpProtocol(currentUrl.protocol)) {
    return failClosed('Interaction freeze requires a completed initial HTTP(S) load');
  }
  guardState.phase = 'FROZEN_ACTIVE';
}

/**
 * Guard の付いたページを個別に閉じると、ページを離れるときの送信が Guard を通らずに出る（DEF-038。Playwright は、閉じ始めたページの
 * 要求で Context の route を呼ばない）。production では使わない。テストの後片付けだけで使う（production の page は、
 * `closePassiveGuardedContext` で Context と一緒に閉じる）。
 */
export async function closePassiveGuardedPage(page: Page): Promise<void> {
  const context = page.context();
  const guardState = requireActiveGuardState(context, ['PASSIVE_ACTIVE', 'FROZEN_ACTIVE']);
  if (guardState.pageGuards.get(page)?.status !== 'READY') {
    throw new Error('Passive request guard is not ready for this page');
  }
  if (ownerClosingPages.has(page)) {
    throw new Error('Passive guarded page close is already in progress');
  }
  ownerClosingPages.add(page);
  let closeSucceeded = false;
  try {
    await page.close();
    releasePageListenerGroup(guardState, page);
    closeSucceeded = true;
  } catch (error) {
    guardState.ledger.recordInvariantViolation({
      code: 'GUARDED_PAGE_CLOSE_FAILED',
      message: errorMessage(error),
    });
    await invalidateContext(context, guardState.ledger).catch(() => undefined);
    throw error;
  } finally {
    if (closeSucceeded) {
      setTimeout(() => ownerClosingPages.delete(page), OWNER_PAGE_CLOSE_MARKER_RETENTION_MS);
    } else {
      ownerClosingPages.delete(page);
    }
  }
}

export async function closePassiveGuardedContext(context: BrowserContext): Promise<void> {
  const existingState = guardStates.get(context);
  const guardState = existingState !== undefined
    && existingState.phase !== 'CLOSED'
    && isClosingOrInvalidatingPhase(existingState.phase)
    ? existingState
    : requireActiveGuardState(context, ['PASSIVE_ACTIVE', 'FROZEN_ACTIVE']);
  const startedInvalidating = guardState.phase === 'PASSIVE_INVALIDATING'
    || guardState.phase === 'FROZEN_INVALIDATING';
  if (!isClosingOrInvalidatingPhase(guardState.phase)) {
    guardState.phase = ownerClosingPhase(guardState.phase);
  }
  const result = await ensureCloseAttempt(guardState, 'OWNER_CLOSE');
  if (startedInvalidating || result.invalidated) {
    throw new Error('Passive request guard context was invalidated');
  }
}

export async function installPassiveRequestGuard(
  context: BrowserContext,
  ledger: SafetyLedger,
  allowedOrigins: ReadonlySet<string>,
  options: PassiveRequestGuardOptions = {},
): Promise<void> {
  const existingState = guardStates.get(context);
  if (existingState !== undefined) {
    const message = `Passive request guard is already installed or invalidated (${existingState.phase})`;
    ledger.recordInvariantViolation({ code: 'GUARD_REPEAT_INSTALLATION', message });
    throw new Error(message);
  }

  const authoritySnapshot = new Set(allowedOrigins);
  const pageGuards = new WeakMap<Page, PageGuardRecord>();
  const pendingTasks = new Set<Promise<void>>();
  const expectedCdpFailures = new ExpectedCdpFailureRegistry(ledger);
  const expectedRouteFailures = new WeakSet<Request>();
  const recordedFrozenPopups = new WeakSet<Page>();
  const guardState: GuardState = {
    phase: 'INSTALLING',
    context,
    ledger,
    allowedOrigins: authoritySnapshot,
    pageGuards,
    pendingTasks,
    pendingRequestTaskCount: 0,
    listenerCleanups: {
      context: { active: true, cleanups: [] },
      pages: new Map<Page, ListenerCleanupGroup>(),
      pageGroupLimitReported: false,
    },
    overflowInvalidation: undefined,
    rawCloseConfirmed: false,
    closeAttempt: undefined,
    taskLimitReported: false,
    drainTimeoutReported: false,
    ensurePageGuard(page: Page): PageGuardRecord {
      const existing = pageGuards.get(page);
      if (existing !== undefined) {
        return existing;
      }
      const listenerGroup = guardState.listenerCleanups.pages.get(page);
      if (listenerGroup === undefined || !listenerGroup.active) {
        throw new Error('Passive request guard page has no listener cleanup owner');
      }
      let record: PageGuardRecord;
      let resolveReady!: (guard: PageDocumentGuard) => void;
      let rejectReady!: (error: unknown) => void;
      const ready = new Promise<PageDocumentGuard>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      void ready.catch(() => undefined);
      record = { status: 'INSTALLING', ready };
      pageGuards.set(page, record);
      const admitted = trackGuardTask(
        guardState,
        'CDP page guard readiness',
        'GUARD_PAGE_READINESS_TASK_FAILED',
        async (): Promise<void> => {
      try {
        const session = await context.newCDPSession(page);
        const frameTree = await session.send('Page.getFrameTree');
        const rootFrameId = frameTree.frameTree.frame.id;
        // C18i（RC18b の N1）: 1つの CDP の session（page の session か、別のプロセスの iframe（OOPIF）の session）の Document の
        // 横取り。page と OOPIF で同じ判定（リダイレクトの対応付け、`expectedCdpFailures`、外部スキームへのリダイレクトの判定、閉じる
        // 途中と凍結の後の扱い）を使う。リダイレクトの対応付けの登録は、session ごとに持つ（requestId は、その session の中で対応付く）。
        // OOPIF の事象の frame は、page の root frame ではないので、main frame として扱わない。
        // DEF-027: `mainFrameId` は、main frame の文書の要求を記録する session（page の session）で、その root frame の ID。OOPIF の session は
        // `null`（main frame の要求を扱わないので、記録しない）。
        const createDocumentInterception = (channel: GuardCdpChannel, mainFrameId: string | null): DocumentInterception => {
          const redirectedPredecessors = new RedirectPredecessorRegistry(ledger);
          // DEF-026（設計書 `2026-10-05-beaksight-def-026-guard-canceled-document-design.md`）: この session で受けた、文書の要求の、
          // ブラウザによる取り消しの証拠（同じ session の `Network.loadingFailed` の canceled で、type が Document）。一時停止した文書の要求
          // への命令（`Fetch.continueRequest`、`Fetch.failRequest`）の結果は、すべて `settlePausedDocumentCommand` で、一時停止の通知の
          // `networkId` と証拠を対応付けて決める。
          // DEF-027: page の session では、main frame の文書の要求の記録も持つ（`CanceledDocumentRegistry` の DEF-027 の部分）。
          const canceledDocuments = new CanceledDocumentRegistry();
          const closingForCommands = (): boolean => isClosingOrInvalidatingPhase(guardState.phase) || ownerClosingPages.has(page);
          const pausedDocumentCommands = (event: PausedDocumentEvent): PausedDocumentCommands => {
            const networkId = typeof event.networkId === 'string' && event.networkId.length > 0 ? event.networkId : null;
            const settle = (send: () => Promise<unknown>): Promise<void> =>
              settlePausedDocumentCommand(send, canceledDocuments, networkId, closingForCommands);
            return {
              continueRequest: () => settle(async () => {
                await channel.send('Fetch.continueRequest', { requestId: event.requestId });
                // DEF-027（設計書 2.1 の3 (a)）: Request の段階の命令が成功した（Guard が許可して進めた）ことだけを記録する。命令が失敗した
                // 場合（ブラウザが取り消したもので、DEF-026 で成功と同じに解決する場合を含む）は、ここに来ないので記録しない。
                if (networkId !== null && !isPausedResponse(event)) {
                  canceledDocuments.recordMainFrameContinued(networkId);
                }
              }),
              failRequest: () => settle(() => channel.send('Fetch.failRequest', {
                requestId: event.requestId,
                errorReason: 'BlockedByClient',
              })),
            };
          };
          // C18g（RC18a の指摘1・3。Task 19 の前の整理の設計書 4.2「サーバのリダイレクトは、たどる前に止める」、4.2.1）:
          // Document の応答の段階で、3xx の `Location` が外部スキームなら、リダイレクトをたどる前にリクエストを失敗させ、
          // `externalSchemeNavigations` に `EXTERNAL_SCHEME_REDIRECT_BLOCKED` で記録する。止めて防げる経路なので、違反にしない
          // （止められないページのスクリプトによる移動とは違う）。ほかの応答は、そのまま続ける（リクエストの段階の判定、許可 Origin と
          // メソッドの判定は、変えない）。
          // - 凍結の後に届いた応答（凍結の前に続けたリクエストの応答）も、同じく調べる（段階は `INTERACTION`）。凍結の後に始まった
          //   リクエストは、これまでどおりリクエストの段階で `INTERACTION_FROZEN` として止まるので、応答の段階に来ない。
          // - 解析できない `Location` は、fail-closed にする（リクエストを失敗させ、違反を記録して Context を閉じる）。
          // - main frame のリダイレクトを止めた場合も記録する。Guard 自身が止めたそのリクエストの失敗は、予期した失敗として登録し、
          //   `HTTP_MAIN_FRAME_DELIVERY_FAILED` の違反にしない（RC18a の指摘3。設計者の判断）。ナビゲーション自体は失敗のまま残る。
          // C18h（DEF-013。設計書 4.6）: 応答を受けた時点で、元のリクエストは終わる（完了か失敗）ので、リダイレクトの対応付けの登録を
          // まず消す。続けるリダイレクトの応答（3xx で `Location` を持つ）だけ、登録し直して、期限をこの時点から数える。3xx を返すまでの
          // サーバの時間を、期限に数えないためである。登録できない場合（件数の上限など）は、登録の側が違反を記録し、この応答を失敗させて
          // Context を閉じる（リクエストの段階の登録と同じ fail-closed）。
          const handlePausedDocumentResponse = async (
            event: PausedDocumentEvent,
            phase: GuardPhase,
            commands: PausedDocumentCommands,
          ): Promise<void> => {
            redirectedPredecessors.forget(event.requestId);
            if (isClosingOrInvalidatingPhase(phase) || ownerClosingPages.has(page)) {
              await failPausedDocumentForLifecycle(
                context,
                commands,
                ledger,
                expectedCdpFailures,
                page,
                event.request,
              );
              return;
            }
            if (phase !== 'PASSIVE_ACTIVE' && phase !== 'FROZEN_ACTIVE') {
              ledger.recordInvariantViolation({
                code: 'CDP_DOCUMENT_PHASE_INVALID',
                message: `Paused Document response observed during ${phase}`,
              });
              await failPausedDocumentForLifecycle(
                context,
                commands,
                ledger,
                expectedCdpFailures,
                page,
                event.request,
              );
              return;
            }
            let redirect: ExternalSchemeRedirect | null;
            try {
              redirect = externalSchemeRedirect(event);
            } catch (error) {
              ledger.recordInvariantViolation({ code: 'EXTERNAL_SCHEME_DETECTION_FAILED', message: errorMessage(error) });
              try {
                await commands.failRequest();
              } catch (failError) {
                ledger.recordInvariantViolation({
                  code: 'CDP_FAIL_REQUEST_FAILED',
                  message: errorMessage(failError),
                });
              }
              initiateInvalidation(context, ledger);
              return;
            }
            if (redirect === null) {
              if (
                redirectLocations(event).length > 0
                && !redirectedPredecessors.remember(event.requestId, event.request, Date.now())
              ) {
                try {
                  await commands.failRequest();
                } catch (error) {
                  ledger.recordInvariantViolation({
                    code: 'CDP_FAIL_REQUEST_FAILED',
                    message: errorMessage(error),
                  });
                }
                initiateInvalidation(context, ledger);
                return;
              }
              try {
                await commands.continueRequest();
              } catch (error) {
                ledger.recordInvariantViolation({
                  code: 'CDP_CONTINUE_REQUEST_FAILED',
                  message: errorMessage(error),
                });
                initiateInvalidation(context, ledger);
              }
              return;
            }
            const isMainFrame = event.frameId === rootFrameId;
            // main frame では、Guard 自身が止めたこのリクエストの失敗（`requestfailed` の `net::ERR_BLOCKED_BY_CLIENT`）を、
            // 予期した失敗として1回だけ登録する（`HTTP_MAIN_FRAME_DELIVERY_FAILED` の違反にしない。設計者の判断）。`requestfailed` が
            // `failRequest` の完了より先に届きうるので、送る前に登録し、送れなかった場合は取り消す（違反のまま）。subframe の失敗は
            // 違反の判定に使わないので、登録しない。登録できない場合（上限など）は、登録の側が違反を記録し、失敗は違反のまま残る。
            const expectedFailure = isMainFrame
              ? expectedCdpFailures.register(page, event.request, Date.now())
              : null;
            try {
              await commands.failRequest();
            } catch (error) {
              if (expectedFailure !== null) expectedCdpFailures.remove(page, expectedFailure);
              // 止められたか分からないので、止めた記録にはしない。
              ledger.recordInvariantViolation({
                code: 'CDP_FAIL_REQUEST_FAILED',
                message: errorMessage(error),
              });
              initiateInvalidation(context, ledger);
              return;
            }
            ledger.recordExternalSchemeNavigation({
              url: redirect.url,
              scheme: redirect.scheme,
              frame: isMainFrame ? 'MAIN' : 'SUB',
              phase: phase === 'FROZEN_ACTIVE' ? 'INTERACTION' : 'PASSIVE',
              reason: 'EXTERNAL_SCHEME_REDIRECT_BLOCKED',
            });
          };
          // DEF-042（設計書 `2026-10-08-beaksight-def-042-guard-fetch-all-design.md` 2.1）: Document でない要求（画像、スクリプト、fetch、
          // XHR、sendBeacon（Ping）、`fetchLater()`、ページを離れるときの送信など）の、Request の段階の一時停止。Playwright は、`networkId` の
          // ない要求（ページを離れるときの送信）で route を呼ばずに進めるので、Guard が CDP の段階で判定する。
          // - 判定は route と同じ `classifyPassiveRequest`（ナビゲーションでない要求として。許可 Origin の判定は main frame のナビゲーション
          //   だけに働くので、ここでは method の判定になる）。記録の種類と理由も route と同じ（`recordBlockedDecision`、`INTERACTION_FROZEN`）。
          //   閉じる途中は、route と同じく記録しない。
          // - Guard の session は、Playwright の session より先に要求を見る（後から付けた session の横取りが外側になる。実際の Chromium で
          //   確かめた: `guard-unload-requests.test.ts` の「記録は 1 回」のテストが、route の見た要求を出力する）。CDP で止めた要求は route に
          //   来ないので、記録は重複しない。許可した要求は、Playwright の session で止まり、route の判定（キャッシュから返す処理を含む）に進む。
          // - Document の記録（リダイレクトの対応付け、取り消しの証拠、`expectedCdpFailures`）には関わらない。Document でない要求の失敗
          //   （`requestfailed`）は、違反の判定に使わないためである。
          // - method か URL が文字列でない要求は、止めて違反にし、Context を閉じる（fail-closed。Document の扱いと同じ）。
          // - 閉じる途中・無効化の段階（owner の close を始めた後）で、命令が session か target の閉鎖で失敗した場合
          //   （`isClosedTargetFailure`）は、target とともに消えた要求として扱い、違反にも記録にもしない（DEF-042 の設計書 2.4。根拠は
          //   DEF-038 の Gate: Context の破棄で、止めたままの要求は両方の Chromium で届かない。試した範囲の確かめで、Chromium の仕組みと
          //   しての保証ではない）。閉じる途中でない段階の失敗は、今までどおり違反。
          // - CORS の事前確認（`OPTIONS`。`Network.requestWillBeSent` の `initiator.type` が `preflight`。取れなければ
          //   `Access-Control-Request-Method` ヘッダあり）は、Playwright が横取りのあるときに行うのと同じく、`Fetch.fulfillRequest`
          //   （204 と CORS のヘッダ）で満たし、記録しない（サーバに届かない。設計書 2.4）。事前確認でない `OPTIONS` は止めて記録する。
          // - 作業の数は、ほかの作業とは別の上限（`MAX_PENDING_GUARD_REQUEST_TASKS`）で数える（設計書 2.4）。
          const preflightInitiators = new PreflightInitiatorRegistry();
          const pausedRequestCommands = (event: PausedDocumentEvent): PausedDocumentCommands & {
            fulfillPreflight(): Promise<void>;
            continueResponseWithWorkerConnectPolicy(): Promise<void>;
          } => ({
            continueRequest: () => settlePausedRequestCommand(() => channel.send('Fetch.continueRequest', { requestId: event.requestId })),
            failRequest: () => settlePausedRequestCommand(() => channel.send('Fetch.failRequest', {
              requestId: event.requestId,
              errorReason: 'BlockedByClient',
            })),
            fulfillPreflight: () => settlePausedRequestCommand(() => channel.send('Fetch.fulfillRequest', {
              requestId: event.requestId,
              responseCode: PREFLIGHT_RESPONSE_CODE,
              responsePhrase: PREFLIGHT_RESPONSE_PHRASE,
              responseHeaders: preflightResponseHeaders(event.request.headers),
              body: '',
            })),
            // DEF-040: `Other` の応答に、Worker の中の WebSocket を止める CSP のヘッダを加えて続ける（`workerConnectPolicyResponse`）。
            continueResponseWithWorkerConnectPolicy: () => settlePausedRequestCommand(() => channel.send(
              'Fetch.continueResponse',
              workerConnectPolicyResponse(event),
            )),
          });
          /**
           * DEF-040（設計書 `2026-10-08-beaksight-def-039-040-egress-design.md` 2.2）: Document でない要求（`Other`。Worker の script）の、
           * Response の段階の一時停止。応答に CSP のヘッダ（`WORKER_CONNECT_POLICY`）を加えて続ける。
           * - `PASSIVE_ACTIVE` と `FROZEN_ACTIVE`: ヘッダを加えて続ける（凍結の後に届く応答は、凍結の前に続けた要求のもの。凍結の後に始まった
           *   要求は、Request の段階で止まるので、ここに来ない）。
           * - 閉じる途中・無効化の段階: Request の段階と同じく止める（session か target の閉鎖による失敗は、違反にしない）。
           * - fail-closed: `continueResponse` が `Invalid InterceptionId` 以外で失敗したら、その応答を止め（`BlockedByClient`）、違反
           *   `WORKER_CONNECT_POLICY_INJECTION_FAILED` を記録して Context を無効にする（Worker が CSP なしで動くのを防ぐ）。
           */
          const handlePausedResponse = (event: PausedDocumentEvent): void => {
            const commands = pausedRequestCommands(event);
            trackGuardTask(guardState, 'paused CDP response', 'GUARD_CDP_PAUSED_TASK_FAILED', async () => {
              const phase = guardState.phase;
              if (isClosingOrInvalidatingPhase(phase) || ownerClosingPages.has(page)) {
                try {
                  await commands.failRequest();
                } catch (error) {
                  const message = errorMessage(error);
                  if (isClosedTargetFailure(message)) {
                    return;
                  }
                  ledger.recordInvariantViolation({ code: 'CDP_LIFECYCLE_FAIL_REQUEST_FAILED', message });
                  if (!isClosingOrInvalidatingPhase(guardState.phase)) {
                    initiateInvalidation(context, ledger);
                  }
                }
                return;
              }
              if (phase !== 'PASSIVE_ACTIVE' && phase !== 'FROZEN_ACTIVE') {
                ledger.recordInvariantViolation({
                  code: 'CDP_RESPONSE_PHASE_INVALID',
                  message: `Paused response observed during ${phase}`,
                });
              } else {
                try {
                  await commands.continueResponseWithWorkerConnectPolicy();
                  return;
                } catch (error) {
                  ledger.recordInvariantViolation({
                    code: 'WORKER_CONNECT_POLICY_INJECTION_FAILED',
                    message: errorMessage(error),
                  });
                }
              }
              try {
                await commands.failRequest();
              } catch (error) {
                ledger.recordInvariantViolation({ code: 'CDP_FAIL_REQUEST_FAILED', message: errorMessage(error) });
              }
              initiateInvalidation(context, ledger);
            }, 'REQUEST');
          };
          /** 一時停止した要求が、CORS の事前確認か（第一の根拠は `initiator`、取れなければヘッダ）。 */
          const isPreflight = (event: PausedDocumentEvent, facts: CorrelationRequest): boolean => {
            if (facts.method.toUpperCase() !== 'OPTIONS') return false;
            const networkId = typeof event.networkId === 'string' && event.networkId.length > 0 ? event.networkId : null;
            const byInitiator = networkId !== null && preflightInitiators.take(networkId, Date.now());
            return byInitiator || requestHeader(event.request.headers, ACCESS_CONTROL_REQUEST_METHOD_HEADER) !== undefined;
          };
          const handlePausedRequest = (event: PausedDocumentEvent): void => {
            const commands = pausedRequestCommands(event);
            trackGuardTask(guardState, 'paused CDP request', 'GUARD_CDP_PAUSED_TASK_FAILED', async () => {
              const phase = guardState.phase;
              const facts = pausedRequestFacts(event);
              /** 止める。失敗したら `code` の違反を記録して偽を返す（止められたか分からないので、呼び出し側は止めた記録にしない）。 */
              const fail = async (code: string): Promise<boolean> => {
                try {
                  await commands.failRequest();
                  return true;
                } catch (error) {
                  ledger.recordInvariantViolation({ code, message: errorMessage(error) });
                  return false;
                }
              };
              if (isFrozenPhase(phase)) {
                if (facts !== null) {
                  ledger.recordBlockedInteractionRequest({ method: facts.method, url: facts.url, reason: 'INTERACTION_FROZEN' });
                }
                // DEF-045: owner の close を始めた後の、閉じた形の失敗は、target とともに消えた要求として違反にしない（記録は残す）。
                try {
                  await commands.failRequest();
                } catch (error) {
                  const message = errorMessage(error);
                  if (isClosedTargetFailure(message) && hasFrozenCloseStarted(guardState)) return;
                  ledger.recordInvariantViolation({ code: 'INTERACTION_CDP_FAIL_REQUEST_FAILED', message });
                  initiateInvalidation(context, ledger);
                }
                return;
              }
              if (isClosingOrInvalidatingPhase(phase) || ownerClosingPages.has(page)) {
                try {
                  await commands.failRequest();
                } catch (error) {
                  const message = errorMessage(error);
                  if (isClosedTargetFailure(message)) {
                    return;
                  }
                  ledger.recordInvariantViolation({ code: 'CDP_LIFECYCLE_FAIL_REQUEST_FAILED', message });
                  if (!isClosingOrInvalidatingPhase(guardState.phase)) {
                    initiateInvalidation(context, ledger);
                  }
                }
                return;
              }
              if (phase !== 'PASSIVE_ACTIVE') {
                ledger.recordInvariantViolation({
                  code: 'CDP_REQUEST_PHASE_INVALID',
                  message: `Paused request observed during ${phase}`,
                });
                await fail('CDP_FAIL_REQUEST_FAILED');
                initiateInvalidation(context, ledger);
                return;
              }
              if (facts === null) {
                ledger.recordInvariantViolation({
                  code: 'CDP_REQUEST_FACTS_INVALID',
                  message: 'Paused request had no method or URL',
                });
                await fail('CDP_FAIL_REQUEST_FAILED');
                initiateInvalidation(context, ledger);
                return;
              }
              if (isPreflight(event, facts)) {
                try {
                  await commands.fulfillPreflight();
                } catch (error) {
                  ledger.recordInvariantViolation({
                    code: 'CDP_PREFLIGHT_FULFILL_FAILED',
                    message: errorMessage(error),
                  });
                  initiateInvalidation(context, ledger);
                }
                return;
              }
              const decision = classifyPassiveRequest({
                kind: 'HTTP',
                method: facts.method,
                url: facts.url,
                isNavigationRequest: false,
                isMainFrame: false,
              }, authoritySnapshot);
              if (decision.action === 'BLOCK') {
                if (await fail('CDP_FAIL_REQUEST_FAILED')) {
                  recordBlockedDecision(ledger, decision, facts);
                } else {
                  initiateInvalidation(context, ledger);
                }
                return;
              }
              try {
                await commands.continueRequest();
              } catch (error) {
                ledger.recordInvariantViolation({
                  code: 'CDP_CONTINUE_REQUEST_FAILED',
                  message: errorMessage(error),
                });
                initiateInvalidation(context, ledger);
              }
            }, 'REQUEST');
          };
          const onRequestPaused = (event: PausedDocumentEvent): void => {
            // DEF-042: Document でない要求は、Request の段階のナビゲーションでない要求として判定する（Document の記録には関わらない）。
            // DEF-040: その Response の段階（`Other` の応答）は、CSP のヘッダを加えて続ける。
            if (!isPausedDocument(event)) {
              if (isPausedResponse(event)) {
                handlePausedResponse(event);
              } else {
                handlePausedRequest(event);
              }
              return;
            }
            // DEF-027: main frame の文書の要求の一時停止を、事象を受けた順に記録する（Request の段階は記録を作り、Response の段階は応答を
            // 受けたと記録する）。Guard の作業（下の非同期の処理）の順は、事象の順と入れ替わることがある（DEF-026-fix の報告）ため、ここで
            // 同期に記録する。
            if (mainFrameId !== null && event.frameId === mainFrameId) {
              canceledDocuments.recordMainFramePaused(event, Date.now());
            }
            // DEF-026: この要求への命令（結果は、取り消しの証拠と対応付けて決める）。
            const commands = pausedDocumentCommands(event);
            trackGuardTask(guardState, 'paused CDP Document request', 'GUARD_CDP_PAUSED_TASK_FAILED', async () => {
              const phase = guardState.phase;
              if (isPausedResponse(event)) {
                await handlePausedDocumentResponse(event, phase, commands);
                return;
              }
              const interceptedRequest = boundedCorrelationRequest(event.request.method, event.request.url);
              if (interceptedRequest === null) {
                expectedCdpFailures.register(page, event.request, Date.now());
                try {
                  await commands.failRequest();
                } catch (error) {
                  ledger.recordInvariantViolation({
                    code: 'CDP_FAIL_REQUEST_FAILED',
                    message: errorMessage(error),
                  });
                }
                initiateInvalidation(context, ledger);
                return;
              }
              const redirectedLookup = event.redirectedRequestId === undefined
                ? undefined
                : redirectedPredecessors.take(event.redirectedRequestId, Date.now());
              if (redirectedLookup !== undefined && redirectedLookup.kind !== 'FOUND') {
                if (redirectedLookup.kind === 'MISSING') {
                  ledger.recordInvariantViolation({
                    code: 'REDIRECT_PREDECESSOR_MISSING',
                    message: 'Supplied redirect predecessor was unavailable',
                  });
                }
                try {
                  await commands.failRequest();
                } catch (error) {
                  ledger.recordInvariantViolation({
                    code: 'CDP_FAIL_REQUEST_FAILED',
                    message: errorMessage(error),
                  });
                }
                initiateInvalidation(context, ledger);
                return;
              }
              const redirectedFrom = redirectedLookup?.request;
              const playwrightVisibleRequest = redirectedFrom ?? interceptedRequest;
              if (isFrozenPhase(phase)) {
                const expectedFailure = expectedCdpFailures.register(page, playwrightVisibleRequest, Date.now());
                ledger.recordBlockedInteractionRequest({
                  method: interceptedRequest.method,
                  url: interceptedRequest.url,
                  reason: 'INTERACTION_FROZEN',
                });
                ledger.recordBlockedInteractionNavigation({
                  method: interceptedRequest.method,
                  url: interceptedRequest.url,
                  reason: 'INTERACTION_FROZEN',
                });
                let invalidationNeeded = expectedFailure === null;
                try {
                  await commands.failRequest();
                } catch (error) {
                  if (expectedFailure !== null) expectedCdpFailures.remove(page, expectedFailure);
                  const message = errorMessage(error);
                  // DEF-045: owner の close を始めた後の、閉じた形の失敗は、target とともに消えた要求として違反にしない（記録は残す）。
                  if (!(isClosedTargetFailure(message) && hasFrozenCloseStarted(guardState))) {
                    ledger.recordInvariantViolation({
                      code: 'INTERACTION_CDP_FAIL_REQUEST_FAILED',
                      message,
                    });
                    invalidationNeeded = true;
                  }
                }
                if (invalidationNeeded) initiateInvalidation(context, ledger);
                return;
              }
              if (isClosingOrInvalidatingPhase(phase) || ownerClosingPages.has(page)) {
                await failPausedDocumentForLifecycle(
                  context,
                  commands,
                  ledger,
                  expectedCdpFailures,
                  page,
                  playwrightVisibleRequest,
                );
                return;
              }
              if (phase !== 'PASSIVE_ACTIVE') {
                ledger.recordInvariantViolation({
                  code: 'CDP_DOCUMENT_PHASE_INVALID',
                  message: `Paused Document observed during ${phase}`,
                });
                await failPausedDocumentForLifecycle(
                  context,
                  commands,
                  ledger,
                  expectedCdpFailures,
                  page,
                  playwrightVisibleRequest,
                );
                return;
              }
              if (!redirectedPredecessors.remember(event.requestId, interceptedRequest, Date.now())) {
                try {
                  await commands.failRequest();
                } catch (error) {
                  ledger.recordInvariantViolation({
                    code: 'CDP_FAIL_REQUEST_FAILED',
                    message: errorMessage(error),
                  });
                }
                initiateInvalidation(context, ledger);
                return;
              }
              const decision = classifyPassiveRequest({
                kind: 'HTTP',
                method: interceptedRequest.method,
                url: event.request.url,
                isNavigationRequest: true,
                isMainFrame: event.frameId === rootFrameId,
              }, authoritySnapshot);
              if (decision.action === 'BLOCK') {
                // C18h: Guard がこのリクエストを失敗させるので、リクエストは終わる。リダイレクトの対応付けの登録を消す。
                redirectedPredecessors.forget(event.requestId);
                let expectedFailure: ExpectedCdpFailure | undefined;
                if (redirectedFrom !== undefined) {
                  expectedFailure = expectedCdpFailures.register(page, redirectedFrom, Date.now()) ?? undefined;
                }
                try {
                  await commands.failRequest();
                  recordBlockedDecision(ledger, decision, {
                    method: event.request.method,
                    url: event.request.url,
                  });
                } catch (error) {
                  if (expectedFailure !== undefined) {
                    expectedCdpFailures.remove(page, expectedFailure);
                  }
                  ledger.recordInvariantViolation({
                    code: 'CDP_FAIL_REQUEST_FAILED',
                    message: errorMessage(error),
                  });
                  initiateInvalidation(context, ledger);
                }
                if (redirectedFrom !== undefined && expectedFailure === undefined) {
                  initiateInvalidation(context, ledger);
                }
                return;
              }
              try {
                await commands.continueRequest();
              } catch (error) {
                ledger.recordInvariantViolation({
                  code: 'CDP_CONTINUE_REQUEST_FAILED',
                  message: errorMessage(error),
                });
                initiateInvalidation(context, ledger);
              }
            });
          };
          // DEF-026: 同じ session の `Network.loadingFailed`（取り消しの証拠）を受ける。
          const onLoadingFailed = (event: unknown): void => canceledDocuments.recordLoadingFailed(event, Date.now());
          return Object.freeze({
            onRequestPaused,
            onLoadingFailed,
            // DEF-027: 同じ session の、main frame の文書の要求が応答を受けたか、終わったか（記録のない要求の事象は、何もしない）。
            onResponseReceived: (event: unknown): void => canceledDocuments.recordResponseReceived(event),
            // DEF-042 の設計書 2.4: CORS の事前確認の要求（`initiator.type` が `preflight`）も、ここで覚える。
            onRequestWillBeSent: (event: unknown): void => {
              canceledDocuments.recordRequestWillBeSent(event);
              preflightInitiators.record(event, Date.now());
            },
            onLoadingFinished: (event: unknown): void => canceledDocuments.recordLoadingFinished(event),
            awaitMainFrameCancellation: (request: CorrelationRequest, waitMs: number): Promise<boolean> =>
              canceledDocuments.awaitMainFrameCancellation(request, waitMs),
            clear: () => {
              redirectedPredecessors.clear();
              canceledDocuments.clear();
              preflightInitiators.clear();
            },
          });
        };
        const pageInterception = createDocumentInterception(session, rootFrameId);
        // C18i: page の子の OOPIF の session（入れ子の OOPIF の session は、その親の OOPIF の node の `children` に持つ）。
        const pageOopifSessions = new Map<string, OopifGuardNode>();
        let oopifSessionCount = 0;
        const failOopifGuard = (code: string, message: string): void => {
          ledger.recordInvariantViolation({ code, message });
          initiateInvalidation(context, ledger);
        };
        /** OOPIF の session を閉じ、その登録（リダイレクトの対応付け）と、入れ子の OOPIF の session を消す。 */
        const disposeOopifSession = (node: OopifGuardNode): void => {
          node.channel.close();
          node.interception.clear();
          disposeOopifSessions(node.children);
          oopifSessionCount -= 1;
        };
        const disposeOopifSessions = (sessions: Map<string, OopifGuardNode>): void => {
          const nodes = [...sessions.values()];
          sessions.clear();
          for (const node of nodes) disposeOopifSession(node);
        };
        /**
         * 親の session（page か OOPIF）に、子の OOPIF が付いた（`Target.attachedToTarget`）。子は、その Document を確定する前に
         * 止まっている（`waitForDebuggerOnStart`）。子の session に、page と同じ横取りと、入れ子の OOPIF への自動の付与を付けてから、
         * `Runtime.runIfWaitingForDebugger` で進める（横取りを付けるまでの間に、子の中の移動は始まらない）。
         * fail-closed: 付けられなかった場合（命令を送れない、`Fetch.enable` などが失敗の応答を受ける、止まっていない、iframe でない、
         * 上限を超えた）は、`OOPIF_GUARD_ATTACH_FAILED` の違反にして Context を閉じ、子は進めない。
         * - 付ける途中で子の target が消えた（`Target.detachedFromTarget` で session が閉じた）場合は、横取りする frame がもうないので、
         *   違反にしない。
         * - Guard が閉じる途中（page の閉じる途中を含む）の場合は、子を進めない（止めたまま、page や Context とともに閉じる）。
         */
        const onOopifAttached = (parent: GuardCdpChannel, sessions: Map<string, OopifGuardNode>, params: unknown): void => {
          const event = (typeof params === 'object' && params !== null ? params : {}) as AttachedTargetEvent;
          const { sessionId } = event;
          if (typeof sessionId !== 'string' || sessionId.length === 0) {
            failOopifGuard('OOPIF_GUARD_ATTACH_FAILED', 'OOPIF target was attached without a session id');
            return;
          }
          if (sessions.has(sessionId)) {
            return;
          }
          if (oopifSessionCount >= MAX_GUARD_OOPIF_SESSIONS) {
            failOopifGuard('OOPIF_GUARD_ATTACH_FAILED', 'OOPIF guard session limit reached');
            return;
          }
          const children = new Map<string, OopifGuardNode>();
          let interception: DocumentInterception | undefined;
          const channel = new OopifTargetChannel(parent, sessionId, (method, eventParams) => {
            if (method === 'Fetch.requestPaused') {
              interception?.onRequestPaused(eventParams as PausedDocumentEvent);
              return;
            }
            // DEF-026: この OOPIF の session の `Network.loadingFailed`（取り消しの証拠）。
            if (method === 'Network.loadingFailed') {
              interception?.onLoadingFailed(eventParams);
              return;
            }
            // DEF-042 の設計書 2.4: この OOPIF の session の `Network.requestWillBeSent`（CORS の事前確認の判定の根拠）。
            if (method === 'Network.requestWillBeSent') {
              interception?.onRequestWillBeSent(eventParams);
              return;
            }
            onTargetEvent(channel, children, method, eventParams);
          });
          interception = createDocumentInterception(channel, null);
          sessions.set(sessionId, { channel, interception, children });
          oopifSessionCount += 1;
          trackGuardTask(guardState, 'OOPIF document interception attach', 'GUARD_OOPIF_ATTACH_TASK_FAILED', async () => {
            const closing = (): boolean => isClosingOrInvalidatingPhase(guardState.phase) || ownerClosingPages.has(page);
            if (closing() || channel.closed) {
              return;
            }
            if (event.targetInfo?.type !== 'iframe') {
              failOopifGuard('OOPIF_GUARD_ATTACH_FAILED', 'An auto-attached target was not an iframe');
              return;
            }
            if (event.waitingForDebugger !== true) {
              failOopifGuard('OOPIF_GUARD_ATTACH_FAILED', 'OOPIF target was attached after it had started running');
              return;
            }
            try {
              await enableRequestInterception(channel);
              await enableOopifAutoAttach(channel);
              if (closing() || channel.closed) {
                return;
              }
              await channel.send('Runtime.runIfWaitingForDebugger');
            } catch (error) {
              if (!channel.closed) {
                failOopifGuard('OOPIF_GUARD_ATTACH_FAILED', errorMessage(error));
              }
            }
          });
        };
        /** 親の session（page か OOPIF）が受けた、子の OOPIF の事象を扱う。扱った場合は真を返す。 */
        const onTargetEvent = (
          parent: GuardCdpChannel,
          sessions: Map<string, OopifGuardNode>,
          method: string,
          params: unknown,
        ): boolean => {
          if (method === 'Target.attachedToTarget') {
            onOopifAttached(parent, sessions, params);
            return true;
          }
          const event = (typeof params === 'object' && params !== null ? params : {}) as TargetSessionEvent;
          const node = typeof event.sessionId === 'string' ? sessions.get(event.sessionId) : undefined;
          if (method === 'Target.receivedMessageFromTarget') {
            try {
              node?.channel.dispatch(event.message);
            } catch (error) {
              failOopifGuard('OOPIF_GUARD_PROTOCOL_FAILED', errorMessage(error));
            }
            return true;
          }
          if (method === 'Target.detachedFromTarget') {
            // OOPIF が閉じた（iframe が消えた、または親と同じプロセスに移った）。その session と登録を消す。違反にはしない。
            if (node !== undefined && typeof event.sessionId === 'string') {
              sessions.delete(event.sessionId);
              disposeOopifSession(node);
            }
            return true;
          }
          return false;
        };
        const onPageOopifAttached = (params: unknown): void => {
          onTargetEvent(session, pageOopifSessions, 'Target.attachedToTarget', params);
        };
        const onPageOopifMessage = (params: unknown): void => {
          onTargetEvent(session, pageOopifSessions, 'Target.receivedMessageFromTarget', params);
        };
        const onPageOopifDetached = (params: unknown): void => {
          onTargetEvent(session, pageOopifSessions, 'Target.detachedFromTarget', params);
        };
        const onSessionClose = (): void => {
          pageInterception.clear();
          disposeOopifSessions(pageOopifSessions);
          expectedCdpFailures.clear(page);
          releasePageListenerGroup(guardState, page);
          if (
            !ownerClosingPages.has(page)
            && !isClosingOrInvalidatingPhase(guardState.phase)
          ) {
            ledger.recordInvariantViolation({
              code: 'CDP_SESSION_DETACHED',
              message: 'Document interception session detached while its page remained active',
            });
            initiateInvalidation(context, ledger);
          }
        };
        if (!listenerGroup.active || guardState.listenerCleanups.pages.get(page) !== listenerGroup) {
          throw new Error('Passive request guard page listener cleanup owner was released during setup');
        }
        session.on('close', onSessionClose);
        listenerGroup.cleanups.push(() => session.off('close', onSessionClose));
        session.on('Fetch.requestPaused', pageInterception.onRequestPaused);
        listenerGroup.cleanups.push(() => session.off('Fetch.requestPaused', pageInterception.onRequestPaused));
        // DEF-026: page の session の `Network.loadingFailed`（一時停止した文書の要求の取り消しの証拠）。
        session.on('Network.loadingFailed', pageInterception.onLoadingFailed);
        listenerGroup.cleanups.push(() => session.off('Network.loadingFailed', pageInterception.onLoadingFailed));
        // DEF-027: page の session の、main frame の文書の要求が応答を受けたか（`Network.responseReceived`、リダイレクトの
        // `Network.requestWillBeSent`）と、読み込みを終えたか（`Network.loadingFinished`）。
        session.on('Network.responseReceived', pageInterception.onResponseReceived);
        listenerGroup.cleanups.push(() => session.off('Network.responseReceived', pageInterception.onResponseReceived));
        session.on('Network.requestWillBeSent', pageInterception.onRequestWillBeSent);
        listenerGroup.cleanups.push(() => session.off('Network.requestWillBeSent', pageInterception.onRequestWillBeSent));
        session.on('Network.loadingFinished', pageInterception.onLoadingFinished);
        listenerGroup.cleanups.push(() => session.off('Network.loadingFinished', pageInterception.onLoadingFinished));
        session.on('Target.attachedToTarget', onPageOopifAttached);
        listenerGroup.cleanups.push(() => session.off('Target.attachedToTarget', onPageOopifAttached));
        session.on('Target.receivedMessageFromTarget', onPageOopifMessage);
        listenerGroup.cleanups.push(() => session.off('Target.receivedMessageFromTarget', onPageOopifMessage));
        session.on('Target.detachedFromTarget', onPageOopifDetached);
        listenerGroup.cleanups.push(() => session.off('Target.detachedFromTarget', onPageOopifDetached));
        // DEF-040（設計書 2.2）: page の session の `Log.entryAdded`（source `worker`）で、Worker の中の WebSocket を CSP で止めたことを記録する
        // （best-effort の観察。Shared Worker の違反は来ない）。Passive の段階は `blockedWebSockets`、凍結の段階は
        // `blockedInteractionWebSockets` に、理由 `WORKER_CONNECT_POLICY` で残す。閉じる途中は、route と同じく記録しない。
        const onLogEntryAdded = (event: unknown): void => {
          const url = workerConnectPolicyViolationUrl(event);
          if (url === null) {
            return;
          }
          const phase = guardState.phase;
          if (isFrozenPhase(phase)) {
            ledger.recordBlockedInteractionWebSocket({ url, reason: WORKER_CONNECT_POLICY_REASON });
          } else if (phase === 'PASSIVE_ACTIVE') {
            ledger.recordBlockedWebSocket({ url, reason: WORKER_CONNECT_POLICY_REASON });
          }
        };
        session.on('Log.entryAdded', onLogEntryAdded);
        listenerGroup.cleanups.push(() => session.off('Log.entryAdded', onLogEntryAdded));
        // C18h: page の listener を外すとき（page が閉じたとき、Context が閉じたとき）に、リダイレクトの対応付けの登録を消す。
        // CDP の session の `close`（`onSessionClose`）が先に届いた場合も、同じく消える。
        // C18i: OOPIF の session も閉じ、その登録を消す（応答を待つ命令を失敗させ、後片付けの drain が待ち続けないようにする）。
        listenerGroup.cleanups.push(() => pageInterception.clear());
        listenerGroup.cleanups.push(() => disposeOopifSessions(pageOopifSessions));
        await enableRequestInterception(session);
        // C18i: 横取りを付けた後に、OOPIF への自動の付与を始める。どちらかが失敗したら、page の準備の失敗（`CDP_SETUP_FAILED`）として
        // Context を閉じる（fail-closed）。
        await enableOopifAutoAttach(session);
        // DEF-040: Worker の中の CSP の違反の観察（記録のため）。失敗したら、上と同じく page の準備の失敗にする。
        await enableWorkerConnectPolicyObservation(session);
        const guard = { session, rootFrameId, awaitMainFrameCancellation: pageInterception.awaitMainFrameCancellation };
        record.status = 'READY';
        resolveReady(guard);
      } catch (error) {
        record.status = 'FAILED';
        releasePageListenerGroup(guardState, page);
        ledger.recordInvariantViolation({ code: 'CDP_SETUP_FAILED', message: errorMessage(error) });
        initiateInvalidation(context, ledger);
        rejectReady(error);
      }
        },
      );
      if (!admitted) {
        releasePageListenerGroup(guardState, page);
        const error = new Error('Passive request guard task admission was denied');
        record.status = 'FAILED';
        rejectReady(error);
      }
      return record;
    },
  };
  guardStates.set(context, guardState);

  if (context.pages().length > 0) {
    const error = new Error('Passive request guard must be installed before creating any pages');
    ledger.recordInvariantViolation({ code: 'GUARD_INSTALLATION_FAILED', message: error.message });
    await invalidateContext(context, ledger).catch(() => undefined);
    throw error;
  }

  /**
   * DEF-036（設計書 `2026-10-08-beaksight-def-036-frozen-popup-design.md` 2.1）: 凍結の段階で開いたポップアップを、1つのページにつき
   * 1回だけ `blockedPopups` に記録する。`page.close()` は呼ばない。Playwright は、`page.close()` を呼んだページの要求で Context の
   * route の処理を呼ばなくなり、Chromium は target を閉じる途中で、止める前の要求をネットワークへ出すことがあるからである。
   * ポップアップの中の要求は、凍結の段階の Context の `route`（すべての HTTP の要求）と `routeWebSocket` が止めて記録する。ポップアップは、
   * Interaction の Context を閉じるときに、Context と一緒に閉じる。ポップアップには `ensurePageGuard` を付けない。
   * ポップアップを閉じる処理だけが使っていた違反のコード `INTERACTION_POPUP_CLOSE_FAILED` と `GUARD_POPUP_CLOSE_TASK_FAILED` は、
   * この変更で記録しなくなった（どちらも、スキーマの enum や型の閉じた一覧には載っていない文字列なので、一覧の変更はない。前の結果の
   * ファイルに残っていても、読み込みには影響しない）。
   */
  const recordFrozenPopup = (page: Page): void => {
    if (recordedFrozenPopups.has(page)) {
      return;
    }
    recordedFrozenPopups.add(page);
    ledger.recordBlockedPopup({ url: page.url(), reason: 'INTERACTION_FROZEN' });
  };
  const onPage = (page: Page): void => {
    const phase = guardState.phase;
    if (isFrozenPhase(phase)) {
      recordFrozenPopup(page);
      return;
    }
    if (isClosingOrInvalidatingPhase(phase)) {
      return;
    }
    if (phase !== 'PASSIVE_ACTIVE') {
      ledger.recordInvariantViolation({
        code: 'GUARD_PAGE_PHASE_INVALID',
        message: `Page observed during ${phase}`,
      });
      initiateInvalidation(context, ledger);
      return;
    }
    if (guardState.listenerCleanups.pages.has(page)) {
      return;
    }
    if (guardState.listenerCleanups.pages.size >= MAX_GUARD_PAGE_LISTENER_GROUPS) {
      if (!guardState.listenerCleanups.pageGroupLimitReported) {
        guardState.listenerCleanups.pageGroupLimitReported = true;
        ledger.recordInvariantViolation({
          code: 'GUARD_LISTENER_GROUP_LIMIT_REACHED',
          message: 'Guard page/CDP listener cleanup group limit reached',
        });
      }
      initiateInvalidation(context, ledger);
      return;
    }
    const listenerGroup: ListenerCleanupGroup = { active: true, cleanups: [] };
    guardState.listenerCleanups.pages.set(page, listenerGroup);
    // Contextは acceptDownloads: false で作るので、ブラウザはダウンロードを保存しない。
    // ここでは、どのフェーズでページが起こしたダウンロードも記録し、念のため取り消す。
    const onDownload = (download: Download): void => {
      const downloadPhase = guardState.phase;
      if (downloadPhase === 'CLOSED') {
        return;
      }
      const frozen = isFrozenPhase(downloadPhase);
      ledger.recordBlockedDownload({
        url: download.url(),
        suggestedFilename: download.suggestedFilename(),
        reason: frozen ? 'INTERACTION_FROZEN' : 'PASSIVE_DOWNLOAD',
      });
      trackGuardTask(
        guardState,
        frozen ? 'frozen download cancel' : 'passive download cancel',
        'GUARD_DOWNLOAD_CANCEL_TASK_FAILED',
        async (): Promise<void> => {
          try {
            await download.cancel();
          } catch (error) {
            ledger.recordInvariantViolation({
              code: frozen ? 'INTERACTION_DOWNLOAD_CANCEL_FAILED' : 'PASSIVE_DOWNLOAD_CANCEL_FAILED',
              message: errorMessage(error),
            });
            initiateInvalidation(context, ledger);
          }
        },
      );
    };
    const onPopup = (popup: Page): void => {
      if (isFrozenPhase(guardState.phase)) {
        recordFrozenPopup(popup);
      }
    };
    const onFrameNavigated = (frame: Frame): void => {
      if (isFrozenPhase(guardState.phase)) {
        ledger.recordBlockedInteractionNavigation({
          method: 'GET',
          url: frame.url(),
          reason: 'INTERACTION_FROZEN',
        });
      }
    };
    try {
      page.on('download', onDownload);
      listenerGroup.cleanups.push(() => page.off('download', onDownload));
      page.on('popup', onPopup);
      listenerGroup.cleanups.push(() => page.off('popup', onPopup));
      page.on('framenavigated', onFrameNavigated);
      listenerGroup.cleanups.push(() => page.off('framenavigated', onFrameNavigated));
      guardState.ensurePageGuard(page);
    } catch (error) {
      releasePageListenerGroup(guardState, page);
      ledger.recordInvariantViolation({
        code: 'GUARD_PAGE_LISTENER_SETUP_FAILED',
        message: errorMessage(error),
      });
      initiateInvalidation(context, ledger);
    }
  };
  /**
   * DEF-027: `page` の Guard の page の session の証拠で、main frame の要求 `request` を、Guard が Request の段階で許可して進めた後に、
   * 応答を1つも受けずにブラウザが取り消したと確かめられるか（`CanceledDocumentRegistry.awaitMainFrameCancellation`。設計書 2.1 の3、4、
   * 2.2）。page の Guard の準備ができていない、method や URL が上限（`boundedCorrelationRequest`）を超える場合は、偽。証拠がまだそろって
   * いなければ `CANCELED_DOCUMENT_EVIDENCE_WAIT_MS` まで待つ。Guard や page が閉じる途中なら、待たない。
   */
  const isMainFrameCancellationConfirmed = async (page: Page, request: Request): Promise<boolean> => {
    const correlation = boundedCorrelationRequest(request.method(), request.url());
    const pageGuard = pageGuards.get(page);
    if (correlation === null || pageGuard?.status !== 'READY') {
      return false;
    }
    const { awaitMainFrameCancellation } = await pageGuard.ready;
    const closing = isClosingOrInvalidatingPhase(guardState.phase) || ownerClosingPages.has(page);
    return awaitMainFrameCancellation(correlation, closing ? 0 : CANCELED_DOCUMENT_EVIDENCE_WAIT_MS);
  };
  const onRequestFailed = (request: Request): void => {
    const completion = runGuardProtocolTask(
      guardState,
      'requestfailed callback',
      'GUARD_REQUEST_FAILED_TASK_FAILED',
      async (requestInvalidation): Promise<void> => {
        if (expectedRouteFailures.has(request)) {
          return;
        }
        const isMainFrame = classifyMainFrame(request, ledger);
        if (isMainFrame === undefined) {
          requestInvalidation();
          return;
        }
        let requestPage: Page | undefined;
        if (isMainFrame) {
          try {
            requestPage = request.frame().page();
          } catch (error) {
            ledger.recordInvariantViolation({ code: 'CDP_PAGE_LOOKUP_FAILED', message: errorMessage(error) });
            requestInvalidation();
            return;
          }
        }
        const message = request.failure()?.errorText ?? 'main-frame request failed without an error reason';
        if (requestPage !== undefined) {
          if (expectedCdpFailures.consume(requestPage, {
            method: request.method(),
            url: request.url(),
            errorText: message,
          }, Date.now())) return;
        }
        if (isMainFrame && boundedCorrelationRequest(request.method(), request.url()) === null) {
          ledger.recordInvariantViolation({ code: 'HTTP_MAIN_FRAME_DELIVERY_FAILED', message });
          requestInvalidation();
          return;
        }
        const decision = classifyPassiveRequest({
          kind: 'HTTP',
          method: request.method(),
          url: request.url(),
          isNavigationRequest: request.isNavigationRequest(),
          isMainFrame,
        }, authoritySnapshot);
        if (decision.action === 'ALLOW' && request.isNavigationRequest() && isMainFrame) {
          if (
            message === NAVIGATION_ABORTED_ERROR_TEXT
            && requestPage !== undefined
            && (
              ownerClosingPages.has(requestPage)
              || isClosingOrInvalidatingPhase(guardState.phase)
            )
          ) {
            return;
          }
          // DEF-004: 許可した読み取りのナビゲーションの、閉じた一覧に載るネットワークの層の失敗は、Guard の違反ではない。
          // DEF-004b: 凍結中は、これまでどおり違反とする（fail-closed）。
          if (
            !isFrozenPhase(guardState.phase)
            && isReadMethod(request.method())
            && isNetworkLayerFailure(message)
          ) {
            return;
          }
          // DEF-029: 許可した読み取りのナビゲーションが、凍結の前に、応答（ヘッダ）を受けた後の失敗の閉じた一覧に載る理由で失敗し、
          // その要求の応答の HTTP の status が 4xx・5xx なら、要求はサーバに届き、サーバが失敗の status で答えた（配送は確か）ので、
          // Guard の違反ではない。応答がない、取り出しが失敗する、status が範囲の外の場合は、これまでどおり違反とする（fail-closed）。
          if (
            !isFrozenPhase(guardState.phase)
            && isReadMethod(request.method())
            && isResponseReceivedFailure(message)
          ) {
            let responseStatus: number | null = null;
            try {
              responseStatus = (await request.response())?.status() ?? null;
            } catch {
              // 応答の取り出しの失敗は、応答がないものとして扱う（違反のまま）。
            }
            if (isHttpStatusInRange(responseStatus, ERROR_HTTP_STATUS_RANGE)) {
              return;
            }
          }
          // DEF-027（設計書 `2026-10-05-beaksight-def-027-external-cancel-design.md` 2.1、2.1.1）: 許可した読み取りのナビゲーションが、
          // 凍結の前に `net::ERR_ABORTED` で失敗し、Guard の page の session の証拠で、その要求（page、method、URL で1対1に対応付けたもの）に
          // ついて、(a) Guard が Request の段階で許可して進めた、(b) 取り消しの証拠がある、(c) 応答（ヘッダ）を1つも受けていない（応答が
          // ページに渡っていないことの証拠）の3つを確かめた場合は、Guard の違反ではない（BeakSight の外の操作か、ページのスクリプトによる
          // 取り消し）。確かめられない場合は、これまでどおり違反とする（fail-closed）。Guard が進める前に取り消された要求は、(a) がないので
          // 違反のまま残る（設計書 2.1.1 の限界）。
          if (
            !isFrozenPhase(guardState.phase)
            && isReadMethod(request.method())
            && message === NAVIGATION_ABORTED_ERROR_TEXT
            && requestPage !== undefined
            && await isMainFrameCancellationConfirmed(requestPage, request)
          ) {
            return;
          }
          ledger.recordInvariantViolation({ code: 'HTTP_MAIN_FRAME_DELIVERY_FAILED', message });
          requestInvalidation();
        }
      },
    );
    void completion.catch(() => undefined);
  };
  // C18a（DEF-012）: 外部スキームはネットワークを通らないので、route と CDP の Fetch は働かない。Playwright の `request` の
  // 事象は、ページのスクリプトによる移動の経路（main frame・subframe、凍結の前後）で来るので、ここで検出して記録する。止めることはできない。
  // サーバのリダイレクト（3xx の `Location` が外部スキーム）は、この事象が来ないので、Document の応答の段階で、たどる前に止める（C18g）。
  // 中断した Run の再開の設計書 4.10（R7d）: CLI の Chromium は、headless でも通常の Chromium の本体を使うので、headed と headless を
  // 問わず、外部のアプリが起動したかもしれない。そのため、不変条件の違反として記録し、Context を閉じる（起きた可能性を隠さずに止める）。
  // 検出の処理が例外を投げた場合は、違反を記録して Context を閉じる（fail-closed）。
  const onRequest = (request: Request): void => {
    const phase = guardState.phase;
    if (phase === 'CLOSED') {
      return;
    }
    try {
      if (!request.isNavigationRequest()) {
        return;
      }
      const url = request.url();
      const scheme = externalNavigationScheme(url);
      if (scheme === null) {
        return;
      }
      ledger.recordInvariantViolation({
        code: 'EXTERNAL_SCHEME_NAVIGATION_ATTEMPTED',
        message: `Navigation to the external scheme ${scheme} was attempted; `
          + 'the browser may have launched an external application',
      });
      // popup（`window.open`）の navigation は frame ができる前に出るので、frame の種類が分からない。推し量って記録せず、
      // 既存の frame の分類の失敗（`FRAME_CLASSIFICATION_FAILED`）も記録する。
      const isMainFrame = classifyMainFrame(request, ledger);
      if (isMainFrame !== undefined) {
        ledger.recordExternalSchemeNavigation({
          url,
          scheme,
          frame: isMainFrame ? 'MAIN' : 'SUB',
          phase: isFrozenPhase(phase) ? 'INTERACTION' : 'PASSIVE',
          reason: 'EXTERNAL_SCHEME_NAVIGATION',
        });
      }
      initiateInvalidation(context, ledger);
    } catch (error) {
      ledger.recordInvariantViolation({ code: 'EXTERNAL_SCHEME_DETECTION_FAILED', message: errorMessage(error) });
      initiateInvalidation(context, ledger);
    }
  };

  try {
    // DEF-040（設計書 2.2）: ページを作る前に、文書の始まりに meta の CSP を入れてすぐ外すスクリプトを、Context のすべての文書に付ける
    // （Worker の中の WebSocket を止める policy。`WORKER_CONNECT_POLICY_INIT_SCRIPT`）。Passive と Interaction のすべての Context に付ける。
    await context.addInitScript({ content: WORKER_CONNECT_POLICY_INIT_SCRIPT });
    // DEF-049: 同じく、すべての文書で、Service Worker の登録の入口を塞ぐ（`SERVICE_WORKER_REGISTRATION_BLOCK_INIT_SCRIPT`）。
    await context.addInitScript({ content: SERVICE_WORKER_REGISTRATION_BLOCK_INIT_SCRIPT });
    context.on('page', onPage);
    guardState.listenerCleanups.context.cleanups.push(() => context.off('page', onPage));
    context.on('requestfailed', onRequestFailed);
    guardState.listenerCleanups.context.cleanups.push(() => context.off('requestfailed', onRequestFailed));
    context.on('request', onRequest);
    guardState.listenerCleanups.context.cleanups.push(() => context.off('request', onRequest));

    await context.routeWebSocket(/.*/, (webSocketRoute) => runGuardProtocolTask(
      guardState, 'WebSocket route callback', 'GUARD_WEBSOCKET_ROUTE_TASK_FAILED', async (requestInvalidation) => {
        const phase = guardState.phase;
        if (isFrozenPhase(phase)) {
          ledger.recordBlockedInteractionWebSocket({
            url: webSocketRoute.url(),
            reason: 'INTERACTION_FROZEN',
          });
          try {
            await webSocketRoute.close({ code: 1008, reason: 'INTERACTION_FROZEN' });
          } catch (error) {
            ledger.recordInvariantViolation({ code: 'WEBSOCKET_CLOSE_FAILED', message: errorMessage(error) });
            requestInvalidation();
          }
          return;
        }
        if (isClosingOrInvalidatingPhase(phase)) {
          try {
            await webSocketRoute.close({ code: 1008, reason: 'GUARD_LIFECYCLE_CLOSED' });
          } catch (error) {
            ledger.recordInvariantViolation({ code: 'WEBSOCKET_CLOSE_FAILED', message: errorMessage(error) });
            requestInvalidation();
          }
          return;
        }
        if (phase !== 'PASSIVE_ACTIVE') {
          ledger.recordInvariantViolation({
            code: 'WEBSOCKET_PHASE_INVALID',
            message: `WebSocket observed during ${phase}`,
          });
          try {
            await webSocketRoute.close({ code: 1008, reason: 'GUARD_PHASE_INVALID' });
          } catch (error) {
            ledger.recordInvariantViolation({ code: 'WEBSOCKET_CLOSE_FAILED', message: errorMessage(error) });
          }
          requestInvalidation();
          return;
        }
        const decision = classifyPassiveRequest({ kind: 'WEBSOCKET', url: webSocketRoute.url() }, authoritySnapshot);
        if (decision.action === 'ALLOW') {
          ledger.recordInvariantViolation({
            code: 'UNEXPECTED_WEBSOCKET_ALLOW',
            message: `Passive WebSocket policy unexpectedly returned ${decision.delivery}`,
          });
          requestInvalidation();
          return;
        }
        if (decision.category !== 'WEBSOCKET') {
          ledger.recordInvariantViolation({
            code: 'UNEXPECTED_WEBSOCKET_DECISION',
            message: `WebSocket policy returned ${decision.category}`,
          });
          requestInvalidation();
          return;
        }
        ledger.recordBlockedWebSocket({ url: webSocketRoute.url(), reason: decision.reason });
        try {
          await webSocketRoute.close({ code: 1008, reason: decision.reason });
        } catch (error) {
          ledger.recordInvariantViolation({ code: 'WEBSOCKET_CLOSE_FAILED', message: errorMessage(error) });
          requestInvalidation();
        }
      },
    ));

    await context.route('**/*', (route) => runGuardProtocolTask(
      guardState, 'HTTP route callback', 'GUARD_HTTP_ROUTE_TASK_FAILED', async (requestInvalidation) => {
        const request = route.request();
        const phase = guardState.phase;
        if (isFrozenPhase(phase)) {
          const isNavigationRequest = request.isNavigationRequest();
          expectedRouteFailures.add(request);
          await abortInteractionRequest(requestInvalidation, route, ledger, {
            method: request.method(),
            url: request.url(),
            navigation: isNavigationRequest,
          });
          return;
        }
        if (isClosingOrInvalidatingPhase(phase)) {
          try {
            await route.abort('blockedbyclient');
          } catch (error) {
            ledger.recordInvariantViolation({ code: 'HTTP_ABORT_FAILED', message: errorMessage(error) });
            requestInvalidation();
          }
          return;
        }
        if (phase !== 'PASSIVE_ACTIVE') {
          ledger.recordInvariantViolation({
            code: 'HTTP_ROUTE_PHASE_INVALID',
            message: `HTTP route observed during ${phase}`,
          });
          try {
            await route.abort('blockedbyclient');
          } catch (error) {
            ledger.recordInvariantViolation({ code: 'HTTP_ABORT_FAILED', message: errorMessage(error) });
          }
          requestInvalidation();
          return;
        }
        const isNavigationRequest = request.isNavigationRequest();
        const isMainFrame = classifyMainFrame(request, ledger);
        if (isMainFrame === undefined) {
          expectedRouteFailures.add(request);
          await abortUnreadyNavigation(requestInvalidation, route, ledger);
          return;
        }
        const decision = classifyPassiveRequest({
          kind: 'HTTP',
          method: request.method(),
          url: request.url(),
          isNavigationRequest,
          isMainFrame,
        }, authoritySnapshot);
  
        if (isNavigationRequest) {
          let page: Page;
          try {
            page = request.frame().page();
          } catch (error) {
            ledger.recordInvariantViolation({ code: 'CDP_PAGE_LOOKUP_FAILED', message: errorMessage(error) });
            expectedRouteFailures.add(request);
            await abortUnreadyNavigation(requestInvalidation, route, ledger);
            throw error;
          }
          const pageGuard = pageGuards.get(page);
          if (pageGuard?.status !== 'READY') {
            ledger.recordInvariantViolation({
              code: 'PASSIVE_GUARD_PAGE_NOT_READY',
              message: `Navigation started before explicit page readiness: ${request.method()} ${request.url()}`,
            });
            expectedRouteFailures.add(request);
            await abortUnreadyNavigation(requestInvalidation, route, ledger);
            return;
          }
        }
  
        if (decision.action === 'BLOCK') {
          expectedRouteFailures.add(request);
          await abortHttpRequest(requestInvalidation, route, ledger, decision, {
            method: request.method(),
            url: request.url(),
          });
          return;
        }
        // サイトへの負荷の制御の設計書 4.7: ここに来るのは、段階が `PASSIVE_ACTIVE` で、許可の判定が ALLOW の要求だけである
        // （凍結の段階、閉じている段階、BLOCK は、ここより前で止めている）。ナビゲーションの要求と、届け方の部品がない場合は、今のまま
        // ネットワークに送る。部品があれば、届け方を尋ねる。部品が選べるのは、ネットワーク、キャッシュから返す、送らない、の3つだけで、
        // 後の2つはネットワークに何も送らない（その前に `expectedRouteFailures` に登録する）。部品の例外では、今のままネットワークに
        // 送る。部品の例外と、キャッシュから返す・送らない処理の失敗は、Guard の外に投げず、Ledger にも記録しない（安全のための遮断では
        // なく、安全には関わらないため）。
        const resourceDelivery = options.resourceDelivery;
        if (isNavigationRequest || resourceDelivery === undefined) {
          await continueNative(requestInvalidation, route, ledger);
          return;
        }
        let delivery: ResourceDeliveryDecision | undefined;
        try {
          delivery = resourceDelivery.decide({
            method: request.method(),
            resourceType: request.resourceType(),
            url: request.url(),
            isNavigationRequest,
          });
        } catch {
          delivery = undefined;
        }
        if (delivery?.kind === 'FROM_RUN_CACHE') {
          expectedRouteFailures.add(request);
          try {
            resourceDelivery.beforeServeFromRunCache(request);
          } catch {
            // 印の失敗は、外に投げない（キャッシュから返す）。
          }
          try {
            const { status, headers, body } = delivery.resource;
            await route.fulfill({
              status,
              headers: { ...headers },
              body: Buffer.from(body.buffer, body.byteOffset, body.byteLength),
            });
          } catch {
            try {
              await route.abort('blockedbyclient');
            } catch {
              // 返すのにも止めるのにも失敗した場合も、外に投げない（ネットワークには送っていない）。
            }
          }
          return;
        }
        if (delivery?.kind === 'WITHHOLD') {
          expectedRouteFailures.add(request);
          try {
            await route.abort('blockedbyclient');
          } catch {
            // 止めるのに失敗しても、外に投げない（ネットワークには送っていない）。
          }
          try {
            resourceDelivery.afterWithhold(request);
          } catch {
            // 数えるのに失敗しても、外に投げない。
          }
          return;
        }
        await continueNative(requestInvalidation, route, ledger);
      },
    ));
  } catch (error) {
    ledger.recordInvariantViolation({ code: 'GUARD_INSTALLATION_FAILED', message: errorMessage(error) });
    await invalidateContext(context, ledger).catch(() => undefined);
    throw error;
  }

  if (guardState.phase !== 'INSTALLING') {
    // 失敗した試行は既にクリアされている可能性があるため、installationはそれを再試行してはならない。
    await guardState.closeAttempt;
    throw new Error(`Passive request guard installation was invalidated (${guardState.phase})`);
  }
  guardState.phase = 'PASSIVE_ACTIVE';
}
