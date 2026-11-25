import { STATUS_CODES } from 'node:http';
import type {
  BrowserContext,
  CDPSession,
  Download,
  Frame,
  Page,
  Request,
  Route,
  WebSocketRoute,
} from 'playwright';
import { isInvalidInterceptionIdFailure } from '../browser/playwright-errors.js';
import type { ResourceDeliveryDecision, ResourceDeliveryRequestFacts } from '../browser/resource-delivery.js';
import { AUDIT_SEND_PASS_EXCEPT_DELETE } from '../core/audit-send-policy.js';
import { BLOCKED_BY_CLIENT_DOCUMENT_FAILURE_TEXT } from '../core/blocked-by-client-failures.js';
import { awaitBeforeDeadline } from '../core/deadline.js';
import { PROGRESS_WATCH_QUIET_LIMIT_MS, watchProgress } from '../core/progress-watch.js';
import { safeErrorMessage } from '../core/errors.js';
import {
  CHROMIUM_EXTENSION_PROTOCOL,
  NON_EXTERNAL_CHROMIUM_EXTENSION_IDS,
  NON_EXTERNAL_NAVIGATION_SCHEMES,
  WORKER_CONNECT_POLICY_REASON,
  type BlockedEventPhase,
} from '../core/evidence-types.js';
import {
  SERVICE_WORKER_REGISTRATION_BLOCKED_ERROR_NAME,
  SERVICE_WORKER_REGISTRATION_BLOCKED_MESSAGE_PARTS,
  WEBRTC_BLOCKED_ERROR_NAME,
  WEBRTC_BLOCKED_MESSAGE,
} from '../core/guard-page-exceptions.js';
import { isRecord } from '../core/guards.js';
import { deepFreeze } from '../core/immutable.js';
import { ERROR_HTTP_STATUS_RANGE, isHttpStatusInRange, REDIRECTION_HTTP_STATUS_RANGE } from '../core/http-status.js';
import { saturatingAdd, saturatingIncrement } from '../core/saturating-count.js';
// T40R2-fix（Task 40 の設計書 7 章の「T40R2」の行の M-3）: 書き込みの段の送り方は、シナリオの送り方と同じ値（core の名前つきの定数）。
import { API_SCENARIO_TRANSPORT, FORM_SCENARIO_TRANSPORT } from '../core/scenario-transport.js';
import { isHttpProtocol } from '../crawl/normalize-url.js';
import {
  LOGIN_CREDENTIAL_BLOCK_REASON,
  NO_BODY_TEXT,
  NO_COOKIES,
  UNREADABLE_COOKIES,
  carriesLoginCredential,
  cookieTextsOf,
  discardLoginCredentialGuard,
  isLoginCredentialGuard,
  requestBodyTextOf,
  requestBodyTextOfBuffer,
  type CookieTexts,
  type LoginCredentialGuard,
  type RequestBodyText,
} from './login-credential-guard.js';
// CC-096 の B: 要求の本文の部品の base64 の decode は共通の部品（ログインの資格情報の守りと同じ）。
import { decodeBase64BodyParts } from './request-body.js';
// T36R-fix（T36R の M-5）: 大文字と小文字を区別しないヘッダの読み方は共通の部品（token の応答の観測と同じ）。
import { headerValueOf } from './http-headers.js';
import {
  LoginStageBlockedRequestList,
  isLoginStageBlockedRequestReason,
  isTokenShapedLoginUrl,
  type LoginStageBlockedRequests,
} from './login-stage-blocked-requests.js';
import { TokenResponseTracker, type TokenResponseObservation } from './token-response-observation.js';
import { isNetworkLayerFailure, isResponseReceivedFailure } from './network-layer-failure.js';
import {
  AUDIT_STAGE_BLOCK_REASONS,
  SCRIPT_LOGIN_BLOCK_REASONS,
  canonicalPassiveAllowedOrigins,
  NOTIFICATION_DISMISSAL_BLOCK_REASON,
  SCROLL_KEY_PRESS_BLOCK_REASON,
  SUBMISSION_POST_METHOD,
  classifyPassiveRequest,
  hasAllowedOrigin,
  isApiWriteCheckTarget,
  isAuditSendDangerousWebSocket,
  isFrozenReadAdmissible,
  isFrozenTokenRefreshAdmissible,
  isReadMethod,
  isSpeculativeRequestHeaders,
  isTokenRefreshRequest,
  recordPathShapeOf,
  requestResourceTypeOf,
  requestResourceTypeOfRequest,
  type AuditExclusionPolicy,
  type AuditSendPolicy,
  type AuditStageAdmission,
  type AuditStageBlockReason,
  type AuditStagePolicy,
  type LoginPostEndpoint,
  type LoginStageAdmission,
  type ManualLoginPassThroughReason,
  type HttpRequestFacts,
  type NotificationPressMode,
  type PassiveRequestDecision,
  type PassiveRequestPolicyOptions,
  type RequestResourceType,
  type RequestSentContent,
  type RequiredQueryParameter,
  type ScriptLoginBlockReason,
  type ScriptRequestLoginPolicy,
  type SubmissionEndpoint,
  type SubmissionStageBlockReason,
} from './request-policy.js';
import type { InvariantViolationInput, SafetyLedger } from './safety-ledger.js';
import type { FrozenRefreshReference } from '../core/session-key-values.js';
import { observeCreatedWebSockets, type ObservedWebSocket } from './audit-send-websocket-observer.js';
import { openRelayedWebSocket, relayHandshakeHeadersOf, type RelayedWebSocket } from './websocket-relay.js';
import {
  attachSubmissionObservation,
  frozenReadCarriesObservedMarker,
  frozenRequestCarriesObservedMarker,
  observationAdmitsFrozenPreflight,
  observationPressesAfterFreeze,
  recordObservedFrozenPreflight,
  recordObservedFrozenRequest,
  type SubmissionObservation,
} from './submission-observation.js';
import {
  checkWritePayload,
  formMethodOverrideValuesOf,
  indexedListCopyOf,
  writeDeferredPriorValuesCopyOf,
  writeExpectationWithPriorValues,
  type WritePayloadExpectation,
  type WriteSuppliedPriorValues,
} from './write-payload-policy.js';
import {
  WRITE_STAGE_PAYLOAD_BLOCK_REASONS,
  apiWriteCheckPathOf,
  apiWriteExpectationWithPriorValues,
  apiWritePriorValuesCopyOf,
  checkApiWritePayload,
  type ApiWritePageKeyValue,
  type ApiWritePayloadBlockReason,
  type ApiWritePayloadExpectation,
  type ApiWriteSuppliedPriorValues,
  type WriteStagePayloadBlockReason,
} from './api-write-payload-policy.js';
import {
  WRITE_STAGE_AUDIT_SEND_PASSED,
  WriteStageUnexpectedRequestList,
  type WriteStageRequestDestination,
  type WriteStageRequestTiming,
  type WriteStageUnexpectedRequests,
} from './write-stage-unexpected-requests.js';
import {
  PREFLIGHT_METHOD,
  sendWriteSubmissionOnce,
  type WriteSubmissionOptions,
  type WriteSubmissionOutcome,
} from './write-submission-sender.js';

type BlockDecision = Extract<PassiveRequestDecision, { readonly action: 'BLOCK' }>;
/** Guard の段階（CC-050 の `decideGuardRequest` の入力）。 */
export type GuardPhase =
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
/*
 * L10（設計書 `2026-11-09-beaksight-remove-limits-design.md` 4。INV-LIMITS の T29 と設計者の判断 E）: 証拠と対応付けの記録は、時間で捨てない。期限を持たず、
 * 使ったとき（1 回だけ使う）か、持ち主（page・session・Context）を閉じたときに捨てる（番兵の値の期限は使わない。設計書 6.1）。前は、Guard の命令の失敗の
 * 予期 1 秒、リダイレクトの前の要求 1 秒、文書の取り消しの証拠 5 秒、止めたダウンロード 5 秒、応答を待つ main frame の文書 10 分で捨てていた
 * （捨てた後に届いた事象を違反にしていた）。
 */
const GUARD_PENDING_TASK_DRAIN_TIMEOUT_MS = 1_000;
const GUARD_PENDING_TASK_DRAIN_TIMEOUT_MESSAGE =
  'Guard-owned listener tasks did not settle before cleanup deadline';
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
 * Guard の命令が、一時停止の ID が無効な形で失敗したのに、その要求の取り消しの証拠をまだ受けていないときに、証拠を待つ時間（ms。DEF-026）。
 * 実験では、証拠は、いつも一時停止の通知より先に届いた。この時間は、届く順が入れ替わる場合に備えた余裕で、ブラウザの中の事象の遅れ
 * （数 ms から数十 ms）より十分に長く、Guard の作業を長く止めない長さにする。待っても届かなければ、違反にする。
 * Context や page を閉じる途中なら、待たずに違反にする（閉じる処理の drain を止めない）。
 * DEF-027: main frame の読み込みの `requestfailed` を受けて、取り消しの証拠がまだそろっていないときに待つ時間も、同じ値にする
 * （`requestfailed` と、Guard の page の session の事象の順は決まっていない。調査では 1ms ほどの差だった）。
 */
export const CANCELED_DOCUMENT_EVIDENCE_WAIT_MS = 500;
/**
 * DEF-225: 凍結の前に、main frame の読み取り（GET・HEAD）の移動が、応答（ヘッダ）を受けた後に `net::ERR_ABORTED` で失敗したときに、同じ page・同じ URL の、
 * Guard が止めたダウンロード（`PASSIVE_DOWNLOAD`）の記録を待つ時間（ms）。実機（2026-11-08、テストの既定と CLI の 2 つの Chromium、goto と押下の各 3〜5 回）では、
 * いつも `requestfailed` が先に来て、`download`（CDP の `Page.downloadWillBegin` の後）は 0.3〜4ms 後だった。この時間は、その遅れより十分に長く、Guard の作業を
 * 長く止めない長さにする（DEF-027 の待ちと同じ値。閉じる処理の作業の待ちより短い）。待っても届かなければ、今までどおり違反にする。
 */
export const PASSIVE_DOWNLOAD_EVIDENCE_WAIT_MS = CANCELED_DOCUMENT_EVIDENCE_WAIT_MS;
/**
 * DEF-052（設計書 `2026-10-09-beaksight-def-052-guard-evidence-wait-design.md` 2.1）: 証拠の待ち（`CANCELED_DOCUMENT_EVIDENCE_WAIT_MS`）の
 * タイマーが切れた後に、Node がすでに受け取っている CDP の事象を処理するために `setImmediate` で譲る回数の上限。譲るたびに証拠を見て、
 * 届いたらそこで決める。時間の長さでは決めない（待ちの全体は、待ちの時間とこの回数の Node の処理で終わる）。
 * 根拠（実験。Playwright 1.62.1、両方の Chromium）: Node が止まっている間に Chromium が送った事象は、止まりが解けた後のタイマーから
 * 数えて 3 回譲ると session の事象の処理に届いた（受信の後に PipeTransport と in-process の接続で `setImmediate` が 2 段。1 件でも、
 * 1 KB の事象 20 件でも 3 回）。1 KB の事象 200 件の溜まりは、CLI の Chromium で 7〜10 回だった。その溜まりまでを読む値にする。
 */
export const CANCELED_DOCUMENT_EVIDENCE_RECEIVED_EVENT_YIELDS = 16;
/**
 * DEF-052（設計書 2.2）: 1つの session で、取り消しの証拠を上限（`MAX_CANCELED_DOCUMENT_EVIDENCE`）のために覚えなかった要求の ID を
 * 覚えておく数の上限。診断（`evidence-dropped-at-capacity`）だけに使い、違反にするかの判定には使わない。L10: 時間では捨てない（session を閉じても
 * 消さない）。覚えきれない ID の診断は `evidence-not-received` になる（数の累計には数える）。
 */
export const MAX_DROPPED_CANCELED_DOCUMENT_IDS = 256;
/**
 * DEF-052（設計書 2.2）: 一時停止の ID が無効な形の命令の失敗を、取り消しの証拠がないために違反にしたときの理由の語（閉じた一覧）。
 * - `NETWORK_ID_MISSING`: 一時停止の通知に `networkId` がない（証拠と対応付けられない）。
 * - `CLOSING_NOT_WAITED`: Guard か page を閉じる途中で、証拠を待たなかった。
 * - `SESSION_CLEARED`: 証拠を待つ間か、その前に、session を閉じた（証拠を消した）。
 * - `EVIDENCE_NOT_RECEIVED`: 待っても、その要求の証拠が届かなかった（期限を過ぎた証拠、取り消しの証拠にならない事象を含む）。
 * - `EVIDENCE_DROPPED_AT_CAPACITY`: その要求の証拠を、数の上限のために覚えなかった。
 */
export const CANCELED_DOCUMENT_EVIDENCE_MISSING_REASON = Object.freeze({
  NETWORK_ID_MISSING: 'network-id-missing',
  CLOSING_NOT_WAITED: 'closing-not-waited',
  SESSION_CLEARED: 'session-cleared',
  EVIDENCE_NOT_RECEIVED: 'evidence-not-received',
  EVIDENCE_DROPPED_AT_CAPACITY: 'evidence-dropped-at-capacity',
} as const);
export type CanceledDocumentEvidenceMissingReason =
  typeof CANCELED_DOCUMENT_EVIDENCE_MISSING_REASON[keyof typeof CANCELED_DOCUMENT_EVIDENCE_MISSING_REASON];
/** DEF-052（設計書 2.2）: 違反の文の後ろに付ける診断の見出しの語。 */
const CANCELED_DOCUMENT_EVIDENCE_DIAGNOSTIC_LABEL = 'canceled-document-evidence';
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
  /**
   * ログインの段の指定（Task 25 の設計書 4.2。T25b）。ある場合だけ、許した送信先への main frame のナビゲーションの POST を、
   * `maxLoginPosts` 回まで許す（判定は `classifyPassiveRequest` の `authSetup` の口。数え方は `SubmissionPostAdmission`）。省略した場合は、
   * 今と完全に同じ（公開監査）。
   */
  readonly loginStage?: GuardLoginStage | undefined;
  /**
   * 書き込みの段の指定（T30b。Task 30 の設計書 3 章の「書き込みの段」、4 章）。ある場合だけ、承認の要求の形に一致する main frame の
   * ナビゲーションの POST を、送る中身の照合（`checkWritePayload`）が `ALLOW` のときに 1 回だけ許す（判定は `classifyPassiveRequest` の
   * `writeStage` の口。数え方はログインの段と同じ `SubmissionPostAdmission`）。ログインの段の指定と一緒には渡せない（`TypeError`）。
   * 省略した場合は、今と完全に同じ。
   */
  readonly writeStage?: GuardWriteStage | undefined;
  /**
   * 書き込みの送信の送り手の指定（DEF-099 fix。Task 30 の設計書 11 章の DEF-099 の行）。書き込みの段の指定（`writeStage`）と一緒に必ず渡す
   * （ない、形が違う、は `TypeError`）。Guard は、送る中身の照合が `ALLOW` の承認の POST を、ブラウザに送らせず（`Fetch.continueRequest` に
   * しない）、照合した同じ本文の bytes で送り手（`sendWriteSubmissionOnce`。中継を通して 1 回だけ）に送らせ、応答を `Fetch.fulfillRequest` で
   * 返す（応答がなければ `Fetch.failRequest`）。書き込みの段のほかでは使わない（ログインの段は、ブラウザが送る今のまま）。
   */
  readonly writeSubmission?: WriteSubmissionOptions | undefined;
  /**
   * AS-c fix round 1（I-1。監査の段の送信の扱いの設計書 5 章の「AS-c fix round 1 の Blocker」の行）: 監査の段の送信の扱い（`auditSend`）で、ほかの Origin への
   * CORS の事前確認をサーバへ送る送り手の指定（中継の待ち受けと `Accept-Language`。形は `writeSubmission` と同じ）。`auditSend` と一緒のときだけ使う（形が
   * 違えば `TypeError`）。省略すると、事前確認は今のまま Guard が返す。
   */
  readonly auditSendPreflight?: WriteSubmissionOptions | undefined;
  /**
   * T35b（Task 35 の設計書 3.2、3.4）: スクリプトで送るログインの監査の段の指定（`GuardAuditStage`）。ある場合だけ、登録した読み取りの手続きの
   * 呼び出しを、この Context（読み込み）の項目ごとの回数まで通し、承認したサービスの Origin への要求を上限の部品で数える（判定は
   * `classifyPassiveRequest` の `auditStage` の口）。ログインの段と書き込みの段の指定と一緒には渡せない（`TypeError`）。省略した場合は、今と同じ。
   */
  readonly auditStage?: GuardAuditStage | undefined;
  /**
   * AS-a（設計書 `2026-10-19-beaksight-audit-send-policy-design.md` 2.2・2.3）: 監査の段の送信の扱い `PASS_EXCEPT_DELETE` の指定（`GuardAuditSend`）。ある場合だけ、
   * ページが自分で出す読み取りでない要求のうち、削除・削除の上書き・危険な語・許可 Origin の外への main frame の移動でないもの（RB-4b から form の送信も）を通し、
   * Safety Ledger の通した要求の記録に残す（判定は `classifyPassiveRequest` の `auditSend` の口。数えない）。形が違う、ログインの段と書き込みの段の
   * 指定と一緒、は `TypeError`。スクリプトで送るログインの監査の段の指定（`auditStage`）とは一緒に受ける。省略した場合は、今と同じ（読み取りだけ）。
   */
  readonly auditSend?: GuardAuditSend | undefined;
  /**
   * RB-4b（設計書 `2026-11-15-beaksight-test-rebuild-design.md` 3.2）: リアルタイムの通信（WebSocket）を止めない指定。factory が、凍結しない Context（Passive と
   * 書き込みの段）だけに渡す（Interaction と、ログインの段には渡さない）。ある場合は、送信の扱いによらず（READ_ONLY でも）、WebSocket の接続を通し（SD-2:
   * 危険な語の接続も）、Worker の中の WebSocket を止める CSP も当てない（`AUDIT_SEND_CONNECT_POLICY`）。RB-4 fix: 凍結の後に押しうる Guard（Isolated Interaction
   * Context と、押す観察の口のある Guard。DEF-276 で、凍結の後に押さない口 `freezeOnlyForReading` を除いた）は、この指定があっても Worker の中の WebSocket を止める
   * （`WORKER_CONNECT_POLICY`）。
   */
  readonly realtimePassThrough?: true | undefined;
  /**
   * DEF-276-relay: 文書の WebSocket を Node の側で中継する口（`websocket-relay.ts`。Context の出口の中継の待ち受けと、テストだけ足す証明書）。factory が、凍結の後に
   * 押す観察の口のある Context（操作さがしの PRIMARY）だけに渡す。ある場合、文書の CSP が ws を止める Context（`WORKER_CONNECT_POLICY`）で、route が通した文書の
   * WebSocket を、ページの中の接続でなく中継でつなぐ（凍結の前だけ。凍結と閉じでは、中継した接続を切る）。ほかの Context は今のまま（`connectToServer`）。
   */
  readonly webSocketRelay?: GuardWebSocketRelay | undefined;
  /**
   * 監査の段の除外の指定（Task 25 の設計書 4.2。T25b round 1）。ある場合だけ、許可 Origin への GET と HEAD でも、除外に当たる要求を
   * 止め、Safety Ledger の `blockedAuditExclusions` に記録する（判定は `classifyPassiveRequest` の `auditExclusions` の口）。route の層、
   * CDP の層、`requestfailed` の判定のすべてに同じ値を渡す。Guard は、取り付けの時点で写しを取る。省略した場合は、今と完全に同じ。
   */
  readonly auditExclusions?: AuditExclusionPolicy | undefined;
  /**
   * 出口の中継の凍結の口（DEF-085。Task 27 の設計書 11 章の 2026-10-12 の行の (2)）。ある場合だけ、次の 2 つの時点で、凍結の理由
   * （`EGRESS_FREEZE_CAUSES`）を渡して、同期で呼ぶ。何度呼ばれてもよい口を渡す。例外は違反 `GUARD_EGRESS_FREEZE_FAILED` に記録し、Guard の処理は
   * 続ける。省略した場合は、今と同じ。
   * - `CONTEXT_CLOSE`: Guard が Context を閉じる直前（無効化による close と持ち主の close。`ensureCloseAttempt` の始め）。Context の破棄の途中に
   *   始まったポップアップの最初のナビゲーションは、Guard の横取りを外れて出ることがある（CLI の Chromium）ので、凍結した中継が拒む。
   * - `INTERACTION_FREEZE`: Guard が凍結の段（`FROZEN_ACTIVE`）に入った直後（`activateInteractionFreeze`。fix round 3 の I2）。
   */
  readonly egressFreeze?: ((cause: EgressFreezeCause) => void) | undefined;
  /**
   * 出口の中継に、Guard が通した要求の宛先を知らせる口（DEF-125）。ある場合だけ、`decideGuardRequest` の結果が `ALLOW` のとき（CDP の要求の層・
   * Document の層・route の層のどれでも。命令を送る前）に、その要求の URL を渡して、同期で呼ぶ。factory は、その Context の中継の
   * `admitTunnelDestinationOf` を渡す（中継は、知らせた宛先への CONNECT だけを通す）。判定は `classifyPassiveRequest` の 1 か所のままで、この口は
   * 判定をしない。例外は違反 `GUARD_EGRESS_ADMISSION_FAILED` に記録し、Guard の処理は続ける（知らせのない CONNECT は中継が拒む。fail-closed）。
   * 省略した場合は、今と同じ。
   * BN-R0 fix round 1（I-1）: `decideGuardRequest` の `ALLOW` の知らせでは、要求の method も渡す（中継が、Guard が通したページの文書でない読み取りだけを、
   * 監査の段の除外に当たる URL でも通すため）。ほかの知らせ（事前確認の送り、WebSocket）では、method を渡さない。
   * DEF-208-1（設計書 `2026-11-05-beaksight-discovery-coverage-design.md` 3.1 の設計者の判断 (b)）: 凍結の段で通した読み取り（`frozenRead` の `ALLOW`）の知らせでは、
   * 3 つ目に真を渡す（中継は、凍結の後でも、その写しに当たる読み取りだけを通す）。ほかの知らせでは渡さない。
   * SREV-SAFE の M-2: 凍結の段の知らせでは、4 つ目に知らせた層を渡す（1 つの要求を CDP の層と route の層の両方が知らせるので、中継の写しは CDP の層だけを数える）。
   */
  readonly onEgressDestinationAdmitted?: ((url: string, method?: string, frozenRead?: boolean, layer?: GuardRequestLayer) => void) | undefined;
  /**
   * SREV-SAFE の N-1: route の層が要求を止めたときに、その method と URL を知らせる口（route の層に来るのは CDP の層が許した要求なので、CDP の層の知らせで数えた
   * 中継の写しを 1 つ戻す）。口の例外は違反 `GUARD_EGRESS_ADMISSION_FAILED` に記録し、投げない。省略した場合は、何もしない。
   */
  readonly onEgressDestinationWithdrawn?: ((url: string, method: string) => void) | undefined;
  /**
   * main frame の文書の要求を送った時刻の記録の口（DEF-100 fix。手順書 `doc/spec/site-load.md`）。ある場合だけ、次の時点で、同期で呼ぶ。factory は、
   * Run（監査・発見・READ の確かめ・書き込み）で 1 つの読み込みの間隔の部品（`NavigationPacer.recordDocumentRequestSent`）を渡す。pacer は、次の
   * 読み込みを、記録した最も遅い時刻からも間隔以上空ける（サイトに届く間隔を設定以上にする）。例外は違反 `GUARD_DOCUMENT_SENT_RECORD_FAILED` に
   * 記録し、Guard の処理は続ける。省略した場合は、今と同じ。page の main frame の要求だけ（リダイレクトの先の要求と、ポップアップの page の main
   * frame の要求も含む。iframe の要求は含まない）。
   * - 送った時刻: Guard が、Request の段階で許して進めた（`Fetch.continueRequest` が成功した）直後。書き込みの段の承認の POST は、送り手
   *   （`sendWriteSubmissionOnce`）が要求の bytes を書き始める直前（`onRequestWriteStart`）。
   * - 応答を受けた時刻: Guard が、Response の段階の一時停止を受けたとき（書き込みの段の承認の POST は、送り手が応答を受けて返したとき）。
   *   送った時刻の記録は、要求がサイトに届く前のことがある（ブラウザと中継の処理の順による）。応答を受けた時刻は、サイトに届いた後なので、
   *   ここでも記録して、次の読み込みの要求がサイトに届くのは、前の要求が届いてから間隔以上後であることを、処理の順によらずに保つ。
   *   応答のない要求（失敗、取り消し）は、送った時刻だけで数える。
   */
  readonly onMainFrameDocumentSent?: (() => void) | undefined;
  /**
   * T37b（Task 37 の設計書 3.2 の「Guard の観察の形」）: 送らずに観察する probe の口（`src/safety/submission-observation.ts`）。factory が PRIMARY の
   * Passive の Context ごとに 1 つ渡す（ほかの Guard に付いた口は `TypeError`）。口が有効の間（`begin` から `end`）だけ、凍結の段（`FROZEN_ACTIVE`）の
   * CDP の要求の層で、承認した API の Origin への事前確認を満たし、止めた要求（今どおり止めて記録する）を口に渡す。省略した場合と、口が無効の間は、
   * 今と同じ。
   */
  readonly submissionObservation?: SubmissionObservation | undefined;
  /**
   * L10 の後の安全の側の設計の変更（設計者の判断）: 凍結の段（`FROZEN_ACTIVE`）で、凍結の読み取りの判定（`isFrozenReadAdmissible`）に当たる読み取りを、監査の段と同じ
   * 判定にかけて通すか。factory が Isolated Interaction Context の Guard に真を渡す（押した後に fetch でデータが届いて開く部品を確かめるため）。観察の口
   * （`submissionObservation`）のある Guard は、この印がなくても通す（DEF-208-1）。書き込み・削除・資格情報・main frame の移動は、今どおり凍結で止める
   * （判定の部品は同じ）。token の更新と事前確認は、観察の口のある Guard だけが通す（この印では通さない）。ログインの段と書き込みの段の指定とは、一緒に受けない。
   */
  readonly admitFrozenReads?: true | undefined;
  /**
   * DEF-233 fix round 3（SREV-233 の確かめ直しの N-1）: 凍結の段で通すサイトの token の更新の比べの相手（凍結の前に通して確かめた更新の本文の形と header、今の鍵の値。
   * factory が作る）。観察の口のある Guard だけが使う。省略・null・例外は、凍結の段の更新を通さない。
   */
  readonly frozenTokenRefreshReference?: (() => FrozenRefreshReference | null) | undefined;
  /**
   * DEF-233 fix round 2（SREV-233 の M-3）・fix round 3: Guard が token の更新の形の要求を通した知らせ（CDP の層。`frozen` は凍結の段に通したもの。`request` は
   * その要求の header と本文の文字列）。factory が、その応答だけを比べの相手として覚え、凍結の前の更新は、応答で成功の鍵が更新されたと確かめてから、本文の形・header・
   * 必須の query の値を Run の中で覚える。口の例外は違反に記録し、投げない。
   */
  readonly onTokenRefreshAdmitted?: ((
    url: string,
    frozen: boolean,
    request: { readonly headers: Readonly<Record<string, string>>; readonly body: string | null },
  ) => void) | undefined;
  /**
   * DEF-233 fix round 2: 同じ Run の中で凍結の前に通した token の更新の、必須の query の名前と値（factory が Run の中で覚える）。凍結の段で通す更新の必須の query の値は、
   * OAuth の標準の更新の値か、これだけ。省略・例外は空。
   */
  readonly frozenTokenRefreshQueryValues?: (() => ReadonlyMap<string, ReadonlySet<string>>) | undefined;
  /**
   * DEF-129: ページが始めた文書の読み込みの回数に、frame ごとの上限（`PAGE_INITIATED_NAVIGATION_LIMIT_PER_FRAME`。T37R2-fix で子の frame も）を置くか。factory が、Passive の Context
   * （ログインの段と書き込みの段を除く）に真を渡す。BeakSight 自身の読み込みは、`announceOwnMainFrameNavigation` で知らせてから始める。省略は、今どおり
   * 数えない（Guard を直接付けるテストなど）。ログインの段と書き込みの段の指定とは、一緒に受けない（数えない）。
   */
  readonly pageNavigationLimit?: boolean | undefined;
  /**
   * DEF-245: 閉じるときに Guard の作業の終わりを待つ見張り（`drainGuardTasks`）の、反応なしの長さ（ms。正の安全な整数）。省略すると本番の
   * `PROGRESS_WATCH_QUIET_LIMIT_MS`。factory が、Run の見張りの長さ（`progressWatchQuietLimitMs`）の指定を渡す（テストが短くする口）。
   */
  readonly drainQuietLimitMs?: number | undefined;
}

/**
 * 凍結の段で、凍結の読み取りの判定に当たる読み取りを通す Guard か（唯一の判定）。観察の口のある Guard（操作さがしの PRIMARY の Passive の Context。DEF-208-1）と、
 * 印 `admitFrozenReads` のある Guard（Isolated Interaction Context）だけ。ほかの Guard は、凍結の段ですべて止める。
 */
export function admitsFrozenReads(options: Pick<PassiveRequestGuardOptions, 'submissionObservation' | 'admitFrozenReads'>): boolean {
  return options.submissionObservation !== undefined || options.admitFrozenReads === true;
}

/**
 * 出口の中継の凍結の理由の閉じた一覧（DEF-085 fix round 3）。`CONTEXT_CLOSE` は Guard が Context を閉じる直前、`INTERACTION_FREEZE` は Guard が
 * 凍結の段に入った直後。中継の拒否を Safety Ledger に記録するかは、factory がこの理由で決める（閉じる直前の凍結の後の拒否は、記録しない）。
 */
export const EGRESS_FREEZE_CAUSES = Object.freeze(['CONTEXT_CLOSE', 'INTERACTION_FREEZE'] as const);
export type EgressFreezeCause = (typeof EGRESS_FREEZE_CAUSES)[number];

/** 監査の段の除外の指定の写し（取り付けの後に呼び出し側が配列を書き換えても、判定は変わらない）。 */
function snapshotAuditExclusions(policy: AuditExclusionPolicy): AuditExclusionPolicy {
  const copy = (values: readonly string[]): readonly string[] => Object.freeze(values.map((value) => String(value)));
  return Object.freeze({
    excludedPathPrefixes: copy(policy.excludedPathPrefixes),
    auditPathPrefixes: copy(policy.auditPathPrefixes),
    dangerousTerms: copy(policy.dangerousTerms),
  });
}

/** 判定の関数に渡す、送信の段の口（ログインの段の `authSetup` か、書き込みの段の `writeStage`。T30b）。 */
type SubmissionStagePolicyPart = Pick<PassiveRequestPolicyOptions, 'authSetup' | 'writeStage'>;

/**
 * 判定の関数に渡す口（T25b。T30b で書き込みの段の口を、T35b で監査の段の口を足した）。送信の段の口も除外の口も監査の段の口もなければ `undefined`
 * （判定の関数は、口のない今の判定を行う）。
 */
function requestPolicyOf(
  stage: SubmissionStagePolicyPart | undefined,
  auditExclusions: AuditExclusionPolicy | undefined,
  auditStage?: AuditStagePolicy,
  auditSend?: AuditSendPolicy,
): PassiveRequestPolicyOptions | undefined {
  if (stage === undefined && auditExclusions === undefined && auditStage === undefined && auditSend === undefined) {
    return undefined;
  }
  // RB-14b（X1）: ログインの段の口は、監査の段と送信の扱いの口と一緒に作らない（Guard の取り付けが拒む組み合わせ）。
  if (stage?.authSetup !== undefined) {
    return { authSetup: stage.authSetup, auditExclusions };
  }
  return {
    ...(stage?.writeStage === undefined ? {} : { writeStage: stage.writeStage }),
    auditExclusions,
    ...(auditStage === undefined ? {} : { auditStage }),
    // AS-a: 監査の段の送信の扱いの口（ある場合だけ）。
    ...(auditSend === undefined ? {} : { auditSend }),
  };
}

/** RB-4b・RB-14b: 判定の口に、リアルタイムの通信を止めない口を足す（ログインの段の口とは一緒に取り付けないので、ログインの段の口はそのまま）。 */
function withRealtimePassThrough(policy: PassiveRequestPolicyOptions | undefined): PassiveRequestPolicyOptions | undefined {
  return policy?.authSetup !== undefined ? policy : { ...policy, realtimePassThrough: true };
}

/**
 * AS-a: 監査の段の送信の扱いの、削除のほかを通す値（設計書 2.1 の `auditSendPolicy`。今のまま読み取りだけの `READ_ONLY` は、口を渡さないことで表す）。
 * AS-b: 値の一覧の owner は `src/core/audit-send-policy.ts`。ここでは同じ定数を公開し直す。
 */
export { AUDIT_SEND_PASS_EXCEPT_DELETE };

/**
 * AS-c fix round 1（I-1。設計書 5 章の「AS-c fix round 1 の Blocker」の行）: Guard がほかの Origin へ送る CORS の事前確認の、送ってから応答を受け終わるまでの
 * 上限（ms。中継への接続から数える）。過ぎたら、ブラウザの事前確認を拒む応答で満たす。
 */
export const AUDIT_SEND_PREFLIGHT_TIMEOUT_MS = 10_000;

/**
 * DEF-276-relay: 文書の WebSocket の中継の、握手（中継への接続から 101 まで）と、こちらから閉じるときの上限（ms）。過ぎたら、ページには失敗として閉じる。
 */
export const WEBSOCKET_RELAY_HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * DEF-276-relay（REV-DEF276 の M-2）: 文書の WebSocket の中継の、送りの列（まだサーバへ書き出していない bytes）の上限（16MiB）。超える送りでは、接続を切って
 * 止めた WebSocket として記録する。
 */
export const WEBSOCKET_RELAY_MAX_SEND_QUEUE_BYTES = 16 * 1024 * 1024;

/** DEF-276-relay: 文書の WebSocket の中継の口（`PassiveRequestGuardOptions.webSocketRelay`）。 */
export interface GuardWebSocketRelay {
  /** Context の出口の中継の待ち受け（中継が接続するのはここだけ）。 */
  readonly proxy: { readonly host: string; readonly port: number };
  /** テストだけ: 信頼する証明書を足す（PEM）。 */
  readonly additionalTrustedCertificates?: readonly string[] | undefined;
}

/** WebSocket の close の code: 接続できなかった・切れた（ページに失敗として知らせる）。 */
const WEBSOCKET_ABNORMAL_CLOSE_CODE = 1006;

/**
 * AS-c fix round 2（I-C。設計書 5 章の「AS-R2」の行）: Guard の route が通して `connectToServer()` を呼んだ接続と、ブラウザが開いた接続の観察を照らし合わせる
 * 時間（ms）。呼んだ後からこの時間の内に観察した、同じ URL の接続だけを、route を通った接続とする（ほかは route の外 `outsideGuard`）。負荷が高く観察が
 * 遅れると、route を通った接続も route の外と数えることがある（数えすぎの側。検知は最善の努力の範囲）。
 */
export const AUDIT_SEND_WEBSOCKET_MATCH_WINDOW_MS = 500;

/** AS-c fix round 1（I-1）: 事前確認の応答がない・時間切れのときに、ブラウザの事前確認に返す拒む応答の状態（CORS のヘッダは付けない）。 */
const AUDIT_SEND_PREFLIGHT_REJECT_CODE = 403;

/**
 * Guard の取り付けの指定の、監査の段の送信の扱い（AS-a。平らなデータ）。Guard は、取り付けの時点で値の写しを取る。
 * - `policy`: `AUDIT_SEND_PASS_EXCEPT_DELETE` だけ。
 * - `approvedServiceOrigins`: 承認したサービスの Origin（許可 Origin と合わせて、通してよい送り先）。
 * - `dangerousTerms`: path か query に含まれていたら通さない語（呼び出し側が既定の危険な語を渡す。`src/safety/` は認証の設定の契約を読まない）。
 * L10・SPEC-1: 1 つの Context で通す数の上限の指定（前の `maxPassedPerContext`・`maxWebSocketsPerContext`）は撤廃した。
 */
export interface GuardAuditSend {
  readonly policy: typeof AUDIT_SEND_PASS_EXCEPT_DELETE;
  readonly approvedServiceOrigins: readonly string[];
  readonly dangerousTerms: readonly string[];
  /**
   * OP-Q（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.8 の Q1）: 書き込みの作業の中の Passive の Context（送る前の確かめと照合の READ）の印（その作業の
   * 承認した送信の送信先）。ある場合は、判定の口に写し（要求の判定の owner が、書き込みの段の値を入れる前と同じ決まりを加える）、WebSocket を通さず、ほかの Origin
   * への事前確認の送り手（`auditSendPreflight`）も受けない（`TypeError`）。省略は監査の段の決まりのまま。
   */
  readonly writeJobEndpoint?: { readonly origin: string; readonly path: string } | undefined;
}

/** AS-a: Guard の取り付けの指定の、監査の段の送信の扱いの形か（factory の指定の確かめも、これを使う）。 */
export function isGuardAuditSend(value: unknown): value is GuardAuditSend {
  if (!isRecord(value) || value.policy !== AUDIT_SEND_PASS_EXCEPT_DELETE) {
    return false;
  }
  const isStrings = (items: unknown): boolean => Array.isArray(items) && items.every((item) => typeof item === 'string');
  // OP-Q（Q1）: 書き込みの作業の印は、省略か、Origin と path の文字列の組だけ。
  const { writeJobEndpoint } = value;
  const isEndpoint = writeJobEndpoint === undefined
    || (isRecord(writeJobEndpoint) && isStrings([writeJobEndpoint['origin'], writeJobEndpoint['path']]));
  return isStrings(value.approvedServiceOrigins)
    && isStrings(value.dangerousTerms)
    && isEndpoint;
}

/**
 * Guard の取り付けの指定の、スクリプトで送るログインの監査の段（T35b。Task 35 の設計書 3.2、3.4。factory が Context の役割ごとに組み立てる）。
 * - `approvedServiceOrigins`・`scriptLogin`: 監査の段の口の値（`AuditStagePolicy`）。
 * - `auditReadRequests`: 登録した読み取りの手続きの呼び出し（`maxPerPageLoad` は、この Context（読み込み）あたりの回数）。
 * - `readRequestsAllowed`: 登録した呼び出しを通すか（最初の読み込み `PRIMARY` だけ真。幅の走査と Interaction（`REVISIT`）は偽で、どの呼び出しも
 *   `READ_REQUEST_OVER_LIMIT` で止める）。T35R-fix（T35R の C-1）: 真でなければ、承認したサービスの Origin への読み取りも、sub frame の文書を含めて
 *   送らない（判定の口の `serviceOriginRequestsWithheld`。`SERVICE_ORIGIN_REVISIT` で止める）。凍結の段は、今どおりすべてを止める。
 *   T44b（Task 44 の設計書 3.1 の P1-1）: factory は、監査の段の送信の扱い `PASS_EXCEPT_DELETE` の Context（幅の走査の `REVISIT` を含む）にも真を渡す
 *   （Interaction の Context は今どおり偽）。
 * - `serviceRequestBudget`: 承認したサービスの Origin への要求の上限の部品（実行で 1 つ。`src/crawl/service-request-budget.ts`）。ある Context だけ、
 *   CDP の層で通す前に数え、断られた要求を `SERVICE_REQUEST_LIMIT_REACHED` で止めて Safety Ledger に記録する。T35R-fix: 数えるのは、判定が通した要求の
 *   うち、印（`auditStageAdmission`）があるものに加えて、URL が承認したサービスの Origin のもの全部（守りを重ねる）。
 * - `monitor`: 監査の段の記録（Run で 1 つ。`AuditStageMonitor`）。
 * Guard は、取り付けの時点で値の写しを取る（部品は写さない）。
 */
export interface GuardAuditStage {
  readonly approvedServiceOrigins: readonly string[];
  readonly auditReadRequests: readonly {
    readonly origin: string;
    readonly path: string;
    readonly method: string;
    readonly maxPerPageLoad: number;
  }[];
  readonly scriptLogin: {
    readonly origin: string;
    readonly path: string;
    readonly requiredQuery: readonly RequiredQueryParameter[];
  };
  readonly readRequestsAllowed: boolean;
  readonly serviceRequestBudget?: { tryConsume(): boolean } | undefined;
  readonly monitor?: AuditStageMonitor | undefined;
}

/**
 * スクリプトで送るログインの監査の段の記録の写し（T35b。Task 35 の設計書 3.7。数だけで、URL・本文・値を持たない。T35c が `run.json` の
 * `authentication` に書く）。
 * - `registeredReadRequestsAllowed`: 通した、登録した読み取りの手続きの呼び出しの数。
 * - `blockedByReason`: 止めた読み取りでない要求の数（理由ごと。`AUDIT_STAGE_BLOCK_REASONS`）。
 * - `tokenRefreshBlocked`: `blockedByReason.TOKEN_REFRESH`（止めた token の更新）。
 * - `otherNonReadBlocked`: `blockedByReason` の、`TOKEN_REFRESH` のほかの合計（止めた、そのほかの読み取りでない要求）。
 * - `serviceRequestLimitBlocked`: 承認したサービスの Origin への要求の上限で止めた要求の数。
 * - `serviceOriginNonReadBlocked`（T37d。Task 37 の設計書 3.5、設計者の判断「止めた読み取りの数の扱い」）: `blockedByReason.UNREGISTERED_NON_READ` の
 *   うち、宛先が承認したサービスの Origin の要求の数（登録していない手続きの呼び出しなど。許可 Origin への計測の送信は数えない）。数えるだけで、判定は
 *   変えない。READ の確かめが、1 つの定義の読み込みの前と後の差で、判定できない定義を決める。
 */
export interface AuditStageMonitorSnapshot {
  readonly registeredReadRequestsAllowed: number;
  readonly blockedByReason: Readonly<Record<AuditStageBlockReason, number>>;
  readonly tokenRefreshBlocked: number;
  readonly otherNonReadBlocked: number;
  readonly serviceRequestLimitBlocked: number;
  readonly serviceOriginNonReadBlocked: number;
  /**
   * T37R-fix-B（T37R の M-5）: `blockedByReason.UNREGISTERED_NON_READ` のうち、宛先が許可 Origin で、要求の種類が `fetch`・`xhr` の要求の数（`ping`・
   * `beacon` などの計測の送信は数えない）。数えるだけで、判定は変えない。T37R-fix-B2（設計書 8 章の最後の行）: 成果物の `authentication` に残すだけで、
   * 描けなかった画面の判定には使わない（`fetch` で送る計測の送信と見分けられないため）。
   */
  readonly allowedOriginDataRequestsBlocked: number;
}

/** 監査の段の、Guard だけが書く数（`AuditStageMonitor` ごと。モジュールの外から書けない。T35b）。 */
interface AuditStageState {
  registeredReadRequestsAllowed: number;
  readonly blockedByReason: Record<AuditStageBlockReason, number>;
  serviceRequestLimitBlocked: number;
  /** T37d: 止めた `UNREGISTERED_NON_READ` のうち、宛先が承認したサービスの Origin の数。 */
  serviceOriginNonReadBlocked: number;
  /** T37R-fix-B（M-5）: 止めた `UNREGISTERED_NON_READ` のうち、宛先が許可 Origin で種類が `fetch`・`xhr` の数。 */
  allowedOriginDataRequestsBlocked: number;
}

const auditStageStates = new WeakMap<AuditStageMonitor, AuditStageState>();

/**
 * スクリプトで送るログインの監査の段の記録（T35b。Run で 1 つを作り、factory の指定 `auditStageMonitor` で、その Run のすべての Context の Guard に
 * 渡す）。書くのは Guard だけ（`auditStageStates`）。
 */
export class AuditStageMonitor {
  constructor() {
    auditStageStates.set(this, {
      registeredReadRequestsAllowed: 0,
      blockedByReason: Object.fromEntries(AUDIT_STAGE_BLOCK_REASONS.map((reason) => [reason, 0])) as Record<AuditStageBlockReason, number>,
      serviceRequestLimitBlocked: 0,
      serviceOriginNonReadBlocked: 0,
      allowedOriginDataRequestsBlocked: 0,
    });
  }

  snapshot(): AuditStageMonitorSnapshot {
    const state = auditStageStateOf(this);
    const otherNonReadBlocked = AUDIT_STAGE_BLOCK_REASONS
      .filter((reason) => reason !== 'TOKEN_REFRESH')
      .reduce((sum, reason) => saturatingAdd(sum, state.blockedByReason[reason]), 0);
    return Object.freeze({
      registeredReadRequestsAllowed: state.registeredReadRequestsAllowed,
      blockedByReason: Object.freeze({ ...state.blockedByReason }),
      tokenRefreshBlocked: state.blockedByReason.TOKEN_REFRESH,
      otherNonReadBlocked,
      serviceRequestLimitBlocked: state.serviceRequestLimitBlocked,
      serviceOriginNonReadBlocked: state.serviceOriginNonReadBlocked,
      allowedOriginDataRequestsBlocked: state.allowedOriginDataRequestsBlocked,
    });
  }
}

/** 監査の段の数（部品の constructor が必ず作る）。 */
function auditStageStateOf(monitor: AuditStageMonitor): AuditStageState {
  const state = auditStageStates.get(monitor);
  if (state === undefined) {
    throw new TypeError('Audit stage monitor has no state');
  }
  return state;
}

/**
 * Guard の取り付けの指定の、ログインの段（Task 25 の設計書 4.1 の `loginPostEndpoints`・`maxLoginPosts`、4.2）。平らなデータ。
 * Guard は、取り付けの時点で写しを取る（後から書き換えても、判定は変わらない）。
 * - `loginPostEndpoints`: 許す送信先（Origin と path の完全一致。`LoginPostEndpoint`）。
 * - `maxLoginPosts`: この Context で許す POST の回数の上限。0 以上の安全な整数でなければ 0（1 回も許さない。fail-closed）とする。
 */
export interface GuardLoginStage {
  readonly loginPostEndpoints: readonly LoginPostEndpoint[];
  readonly maxLoginPosts: number;
  /**
   * T26g-1: ログインの段の記録と、自動ログインの送信の窓の口（`LoginStageMonitor`）。Guard は写しを取らず、この部品に書く。省略した場合は、
   * Guard が自分の部品を持つ（窓は開かない。記録は外から読めない）。
   */
  readonly monitor?: LoginStageMonitor | undefined;
  /**
   * T34b（Task 34 の設計書 3.3）: スクリプトで送るログイン（ログインの送り方 `SCRIPT_REQUEST`）の指定（`GuardScriptLogin`）。ある場合だけ、
   * 登録した token の送信を `maxLoginPosts` 回まで、登録したログインに伴う送信を項目ごとの上限まで、承認したサービスの Origin への読み取りを
   * 通す（判定は `classifyPassiveRequest` の `authSetup.scriptRequest` の口）。このとき `loginPostEndpoints` は使わない（空でよい。フォームの
   * 送信先への POST も通さない）。省略した場合は、フォームの送信のログイン（今のまま）。
   */
  readonly scriptRequest?: GuardScriptLogin | undefined;
  /**
   * T36b（Task 36 の設計書 3.3）: 自動ログインの、入れる資格情報から作った部品（`src/safety/login-credential-guard.ts` の
   * `createLoginCredentialGuard`）。`scriptRequest` があるときだけ使い、判定が通した要求のうち、承認した token の送信のほかのすべて（登録したログインに
   * 伴う送信、ナビゲーション、読み取りなど）の URL と本文に資格情報が含まれていれば止める。手動のログインでは渡さない。Guard は、Context を閉じたら
   * 値を捨てる。
   */
  readonly credentialGuard?: LoginCredentialGuard | undefined;
  /**
   * ML-a（設計書 `2026-10-19-beaksight-manual-login-pass-through-design.md` 2.1）: 手動のログインの段（人が headed の Browser で操作する段）の印。ある場合は、
   * 今の決まりで止める、ページの読み取りでない要求（ログインの送信、手続きの呼び出し）を、止めずに通し（判定の口の
   * `manualPassThrough`）、読み取りでない要求の形（Origin・path・種類・query の名前と閉じた一覧の値・回数）を、記録（`monitor` の `passedRequests`）に残す。
   * 回数（`maxLoginPosts`）には数えない。自動ログインの段は付けない（`credentialGuard` と一緒なら印は働かない）。ダウンロード、外部のアプリの起動、
   * WebSocket、読み取り（許可 Origin の外への読み取りを止める。T26g-1）、許可 Origin の外への main frame の移動、閉じた後の要求、出口の中継の守りは今のまま。
   */
  readonly manualPassThrough?: true | undefined;
  /**
   * T44R（Task 44 のレビューの M-1）: 手動のログインの段で、`scriptRequest` がないとき（token の送信先がまだない、スクリプトで送るログインの設定）の、
   * プロファイルの承認したサービスの Origin。ナビゲーションでない読み取り（GET と HEAD）を通し、`serviceOriginReads` に数える（判定は
   * `classifyPassiveRequest` の `authSetup.manualServiceReadOrigins` の口）。`manualPassThrough` があり、`scriptRequest` と `credentialGuard` がないときだけ
   * 使う（ほかは使わない。fail-closed）。
   */
  readonly manualServiceReadOrigins?: readonly string[] | undefined;
  /**
   * DEF-193（設計書 `2026-11-04-beaksight-login-session-design.md` 3.2）: 自動ログインの段の指定の印（作るのは factory の `createLoginStageContext`。監査の段の送信の
   * 扱いが `PASS_EXCEPT_DELETE` のとき）。`scriptRequest` と `credentialGuard` があり、`manualPassThrough` がないときだけ働く（判定の口の
   * `authSetup.automatedPassThrough`）。今の決まりで止める、ページの登録のない読み取りでない要求と token の更新を通し（SD-2: 削除と危険な語も）、回数に数えず、
   * 形を通した送信の一覧に記録する。資格情報を含む要求は、今どおり止める（`credentialCheckedDecision`）。
   */
  readonly automatedPassThrough?: true | undefined;
}

/**
 * 登録したログインに伴う送信の指定（T34b。認証の設定 v3 の `loginSideRequests` の項目と同じ形）。`maxPerLoginStage` は、この Context で
 * 許す回数。0 以上の安全な整数でなければ 0（1 回も許さない。fail-closed）とする。
 */
export interface GuardLoginSideRequest {
  readonly origin: string;
  readonly path: string;
  readonly method: string;
  readonly maxPerLoginStage: number;
}

/**
 * スクリプトで送るログインの指定（T34b。平らなデータ。Guard は取り付けの時点で写しを取る）。
 * - `scriptLogin`: token の送信先（認証の設定 v3 の `scriptLogin` と同じ形。method は `POST` に固定）。
 * - `loginSideRequests`: 登録したログインに伴う送信（`GuardLoginSideRequest`。既定は空）。
 * - `approvedServiceOrigins`: 承認したサービスの Origin（プロファイルの `approvedServiceOrigins`）。
 */
export interface GuardScriptLogin {
  readonly scriptLogin: {
    readonly origin: string;
    readonly path: string;
    readonly requiredQuery: readonly RequiredQueryParameter[];
  };
  readonly loginSideRequests: readonly GuardLoginSideRequest[];
  readonly approvedServiceOrigins: readonly string[];
}

/**
 * Guard の取り付けの指定の、書き込みの段（T30b。Task 30 の設計書 3 章、4 章）。
 * - `expectation`: 承認の要求の形と、送ってよい欄（`WritePayloadExpectation`）。Guard は、取り付けの時点で写しを取る。送信先は
 *   `expectation.request` の Origin と path。許す POST は 1 回だけ（`WRITE_STAGE_MAX_POSTS`。指定では変えられない）。
 * - `monitor`: 書き込みの段の記録・送信の窓・送信の報告の口（`WriteStageMonitor`）。1 つの部品は 1 つの Guard にだけ付けられる。
 */
export interface GuardFormWriteStage {
  /** 送り方（T39b。省略は `FORM`。今までの指定のまま）。 */
  readonly transport?: typeof FORM_SCENARIO_TRANSPORT;
  readonly expectation: WritePayloadExpectation;
  readonly monitor: WriteStageMonitor;
  /**
   * LU-SFIX3-B（LU-SREV3 の Important-2）: フォームの更新で、送信先の最後の区切りが対象の番号のとき、窓の前（N2）に守る送信先の path の型（最後の区切りを
   * `{id}` にした形。作り方は `recordPathShapeOf` の 1 か所）。守るのは、この型と表の path（`guardedWriteEndpointPathsOf`）。承認の POST の照らしは、今のとおり
   * 具体的な path（`expectation.request.path`）。省略は今のまま（具体的な path とその下だけを守る。登録）。LU-SFIX4: 前の値を後から入れる印のある期待（一覧の
   * 行から開くフォームの更新）では必須（省くと受けない）。
   */
  readonly guardedPathShape?: string | undefined;
}

/**
 * T39b（Task 39 の設計書 3.3）: API のシナリオの書き込みの段の、送り手の口に渡す要求（Guard が照合した、同じ本文の bytes）。ヘッダは一時停止の要求の
 * ヘッダのまま（`Authorization` などを含む。記録しない）。`pageKeyValues` は、照合が返したページが決める鍵の値。
 */
export interface AdmittedApiWriteRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
  readonly pageKeyValues: Readonly<Record<string, ApiWritePageKeyValue>>;
}

/**
 * T39b: API の書き込みの、送り手の口（中身は T39c）。照合に一致した 1 回だけを受け、送り手の結果（`WriteSubmissionOutcome`）を返す。Guard は、
 * `RESPONDED` なら応答を `Fetch.fulfillRequest` でページに返し、ほかは要求を失敗させる（form の送り手と同じ扱い）。口がなければ、送らずに止める
 * （`NOT_WRITTEN` と同じ扱い）。
 */
export type ApiWriteHandoff = (request: AdmittedApiWriteRequest) => Promise<WriteSubmissionOutcome>;

/**
 * T39b（Task 39 の設計書 3.1、3.3）: API のシナリオの書き込みの段の指定。
 * - `expectation`: 承認した API の指定と生成した値と台帳の ID（`ApiWritePayloadExpectation`。Guard は、取り付けの時点で写しを取る）。照合にかけるのは、
 *   送信の窓の中の、承認した API の Origin への `POST`・`PATCH` のうち、main frame のページのスクリプトが送った fetch・xhr の 1 回目だけ。
 * - `monitor`: 書き込みの段の記録・送信の窓・送信の報告の口（form と同じ部品。窓は、入力の部品が値を入れ始める前に `openSubmissionWindow(page)` で開く）。
 * - `handoff`: 送り手の口（`ApiWriteHandoff`）。省略すると、Guard の既定の送り手（T39c）: factory が渡す書き込みの送り手の指定（`writeSubmission`。中継の
 *   宛先、言語、テストだけの証明書。Guard が閉じるときに止める口を足す）で、`sendWriteSubmissionOnce` の fetch の形（`requestKind: 'FETCH'`）で 1 回だけ
 *   送る。テストは、送らない偽物を渡せる。
 * - `recordIdOf`（T39c。Task 40 の口）: 応答の本文から登録の ID を取り出す関数（`src/control/actions/api-record-id.ts` の
 *   `apiRecordIdOfResponseBody` を、呼び出し側が登録の ID の取り方の鍵で包んで渡す）。Guard は `RESPONDED` の本文をメモリの中で 1 回だけ渡し、返った ID を
 *   `WriteStageMonitor.apiWriteRecordId()` で読めるようにする。本文は持たない。
 */
export interface GuardApiWriteStage {
  readonly transport: typeof API_SCENARIO_TRANSPORT;
  readonly expectation: ApiWritePayloadExpectation;
  readonly monitor: WriteStageMonitor;
  readonly handoff?: ApiWriteHandoff | undefined;
  readonly recordIdOf?: ((body: Buffer) => string | null) | undefined;
}

/** 書き込みの段の指定（送り方で分かれる。T39b）。 */
export type GuardWriteStage = GuardFormWriteStage | GuardApiWriteStage;

/** 書き込みの段の指定が、API のシナリオのものか（T39b）。 */
export const isGuardApiWriteStage = (stage: GuardWriteStage): stage is GuardApiWriteStage => stage.transport === API_SCENARIO_TRANSPORT;

/** 書き込みの段で許す POST の回数（承認された 1 回の CREATE。T30b）。 */
const WRITE_STAGE_MAX_POSTS = 1;

/** 送信の段の記録の写しの共通の部分（種類ごとの数だけ。URL・値・本文を持たない）。 */
interface SubmissionStageMonitorSnapshot {
  /** 送信の段だけの理由（`SUBMISSION_STAGE_BLOCK_REASONS`）で止めた数。 */
  readonly blockedByReason: Readonly<Record<SubmissionStageBlockReason, number>>;
  /** 送信の窓の中で、今の判定（GET と HEAD 以外、許可 Origin の外への main frame の移動、WebSocket）で止めた数。 */
  readonly blockedByOtherRulesInWindow: number;
  /** 送信の窓が開いているか。 */
  readonly submissionWindowOpen: boolean;
}

/**
 * スクリプトで送るログインの段の記録の数（T34b。Task 34 の設計書 3.5。URL・本文・値を持たない）。フォームの送信のログインでは、どれも 0 と空。
 * - `tokenRequestsAllowed`: 通した token の送信の数。
 * - `sideRequestsAllowed`: 通したログインに伴う送信の数（登録した項目の順に、項目ごと）。
 * - `serviceOriginReads`: 通した、承認したサービスの Origin への読み取りの数（Guard の CDP の層で数える）。
 * - `blockedByScriptReason`: 止めた読み取りでない要求の数（理由ごと。`SCRIPT_LOGIN_BLOCK_REASONS`）。`TOKEN_REQUEST_OVER_LIMIT` が、上限を
 *   超えて止めた token の送信の数（`LoginStageMonitor.tokenRequestsBlockedOverLimit`）。
 */
export interface ScriptLoginStageCounts {
  readonly tokenRequestsAllowed: number;
  readonly sideRequestsAllowed: readonly number[];
  readonly serviceOriginReads: number;
  readonly blockedByScriptReason: Readonly<Record<ScriptLoginBlockReason, number>>;
}

/**
 * ログインの段の記録の写し（種類ごとの数だけ。URL・値・本文を持たない）。T34b: スクリプトで送るログインの数（`scriptRequest`）を足した。
 * T34e: 止めた読み取りでない要求の一覧（`blockedRequests`。Origin と path と種類と理由と回数だけ。query・本文・値を持たない。
 * `src/safety/login-stage-blocked-requests.ts`）を足した。スクリプトで送るログインでも、フォームの送信のログインでも持つ。
 */
export interface LoginStageMonitorSnapshot extends SubmissionStageMonitorSnapshot {
  readonly scriptRequest: ScriptLoginStageCounts;
  readonly blockedRequests: LoginStageBlockedRequests;
  /**
   * ML-a: 手動のログインの段で通した読み取りでない要求の一覧（止めた一覧と同じ形と上限。理由は、通さなければ止めた理由。値・本文を持たない）。手動のログインの
   * 段のほかは空。
   */
  readonly passedRequests: LoginStageBlockedRequests;
}

/**
 * 送信の段（ログインの段と書き込みの段）の記録と送信の窓の共通の部分（T26g-1。T30b で共通にした）。
 * - 記録: Guard が、送信の段で止めた要求を、種類ごとの数で書く（Safety Ledger には書かない。URL・値・本文を持たない）。
 * - 送信の窓: 段の流れが、値を入れ始める直前に開く。Guard が、許した送信先への main frame のナビゲーションの POST を CDP の層で通した時点で
 *   閉じる（`closeSubmissionWindow`。Guard の中で決めるので、続く要求と競合しない）。閉じた後は開き直せない。開いている間、Guard は許した POST の
 *   ほかのすべての要求を止める（判定は要求の判定の owner の段の口）。
 * - 予期しない要求の数（`unexpectedRequestCount`）: 窓の中で止めた要求の数。値を運べないブラウザ自身の favicon は数えない。
 */
abstract class SubmissionStageMonitor {
  #submissionWindowOpen = false;
  #submissionWindowClosed = false;
  readonly #blockedByReason: Record<SubmissionStageBlockReason, number> = {
    OUTSIDE_ALLOWED_ORIGINS: 0,
    SUBMISSION_WINDOW: 0,
    SUBMISSION_WINDOW_BROWSER_FAVICON: 0,
  };
  #blockedByOtherRulesInWindow = 0;
  /** OP-N（N1）: 送信の窓の中で止めた、予期しない要求の数（`SUBMISSION_WINDOW` と窓の中のほかの判定のうち、`tolerated` でないもの）。 */
  #unexpectedInWindow = 0;

  /** 送信の窓を開く（閉じた後は何もしない）。開いたら真。 */
  protected openWindow(): boolean {
    if (this.#submissionWindowClosed) {
      return false;
    }
    this.#submissionWindowOpen = true;
    return true;
  }

  /** 送信の窓を閉じる（Guard が、許した送信先への POST を通した時点で呼ぶ）。 */
  closeSubmissionWindow(): void {
    this.#submissionWindowOpen = false;
    this.#submissionWindowClosed = true;
  }

  isSubmissionWindowOpen(): boolean {
    return this.#submissionWindowOpen;
  }

  /**
   * 送信の段だけの理由で止めた要求を数える。OP-N（N1）: `tolerated`（書き込みの段の、値を入れた後の目印のない読み取り）は、予期しない要求の数に数えない。
   */
  recordStageBlock(reason: SubmissionStageBlockReason, tolerated = false): void {
    this.#blockedByReason[reason] = saturatingIncrement(this.#blockedByReason[reason]);
    if (reason === 'SUBMISSION_WINDOW' && !tolerated) {
      this.#unexpectedInWindow = saturatingIncrement(this.#unexpectedInWindow);
    }
  }

  /**
   * 今の判定で止めた要求を、判定の時点で窓が開いていたなら数える。OP-N（N1）: `tolerated`（書き込みの段の、値を入れた後の目印のない読み取りと WebSocket）は、
   * 予期しない要求の数に数えない。
   */
  recordOtherBlock(submissionWindowOpenAtDecision: boolean, tolerated = false): void {
    if (submissionWindowOpenAtDecision) {
      this.#blockedByOtherRulesInWindow = saturatingIncrement(this.#blockedByOtherRulesInWindow);
      if (!tolerated) {
        this.#unexpectedInWindow = saturatingIncrement(this.#unexpectedInWindow);
      }
    }
  }

  /**
   * 送信の窓の中で止めた、予期しない要求の数（ブラウザ自身の favicon を除く）。OP-N（N1）: 書き込みの段の、値を入れた後に止めた、目印のない読み取りと WebSocket
   * （`tolerated` を付けて数えたもの）は数えない（止めたまま。種類ごとの数には今どおり数える）。
   */
  unexpectedRequestCount(): number {
    return this.#unexpectedInWindow;
  }

  /** OP-N（N1）: 送信の窓を一度でも開いたか（開いている、または承認の送信を通して閉じた）。 */
  hasSubmissionWindowOpened(): boolean {
    return this.#submissionWindowOpen || this.#submissionWindowClosed;
  }

  protected stageSnapshot(): SubmissionStageMonitorSnapshot {
    return {
      blockedByReason: Object.freeze({ ...this.#blockedByReason }),
      blockedByOtherRulesInWindow: this.#blockedByOtherRulesInWindow,
      submissionWindowOpen: this.#submissionWindowOpen,
    };
  }
}

/**
 * ログインの段の記録と、自動ログインの送信の窓（T26g-1。Task 26 の設計書の変更履歴の「T26R」の行の C1、「Blocker: T26g-1」の行）。
 * 記録と窓の決まりは `SubmissionStageMonitor`。窓は、自動ログインの段が、値を入れ始める直前に `openSubmissionWindow` で開く。
 * 手動のログインの段は、窓を開かない（人が入力するので、窓の始まりを決められない）。
 */
export class LoginStageMonitor extends SubmissionStageMonitor {
  constructor() {
    super();
    loginStageStates.set(this, {
      tokenRequestsAllowed: 0,
      sideRequestsAllowed: [],
      serviceOriginReads: 0,
      blockedByScriptReason: Object.fromEntries(SCRIPT_LOGIN_BLOCK_REASONS.map((reason) => [reason, 0])) as Record<ScriptLoginBlockReason, number>,
      blockedRequests: new LoginStageBlockedRequestList(),
      passedRequests: new LoginStageBlockedRequestList(),
      tokenSeen: false,
      tokenResponses: new TokenResponseTracker(),
    });
  }

  /** 送信の窓を開く（値を入れ始める直前。閉じた後は何もしない）。 */
  openSubmissionWindow(): void {
    this.openWindow();
  }

  /**
   * T34b（Task 34 の設計書 3.4）: 上限を超えて止めた token の送信の数（スクリプトで送るログイン）。1 以上なら、ログインの試みが上限を超えた。
   * 上限の中で止めた送信（種類や query の違い）は含めない。ワーカーが、Safety Ledger の読み直しの代わりに読む口。
   */
  tokenRequestsBlockedOverLimit(): number {
    return loginStageStateOf(this).blockedByScriptReason.TOKEN_REQUEST_OVER_LIMIT;
  }

  /**
   * T36b（Task 36 の設計書 3.3）: 資格情報が含まれていたので止めた要求の数（理由 `LOGIN_CREDENTIAL_IN_REQUEST`。token の送信のほかのすべての要求。
   * 自動ログインの部品を渡したときだけ数える）。値・URL を持たない。
   */
  credentialRequestsBlocked(): number {
    return loginStageStateOf(this).blockedByScriptReason[LOGIN_CREDENTIAL_BLOCK_REASON];
  }

  /**
   * T36b（Task 36 の設計書 3.4）: Guard が通した token の送信ごとの応答の状態（通した順。状態のコードと `Retry-After` の値だけ。本文は読まない）。
   * 区分（`SUCCESS` などへの写し）は読む側（T36c）が行う。
   */
  tokenResponses(): readonly TokenResponseObservation[] {
    return loginStageStateOf(this).tokenResponses.snapshot();
  }

  snapshot(): LoginStageMonitorSnapshot {
    const state = loginStageStateOf(this);
    return Object.freeze({
      ...this.stageSnapshot(),
      scriptRequest: Object.freeze({
        tokenRequestsAllowed: state.tokenRequestsAllowed,
        sideRequestsAllowed: Object.freeze([...state.sideRequestsAllowed]),
        serviceOriginReads: state.serviceOriginReads,
        blockedByScriptReason: Object.freeze({ ...state.blockedByScriptReason }),
      }),
      blockedRequests: state.blockedRequests.snapshot(),
      passedRequests: state.passedRequests.snapshot(),
    });
  }
}

/**
 * スクリプトで送るログインの段の、Guard だけが書く数（`LoginStageMonitor` ごと。モジュールの外から書けない。T34b）。T34e: 止めた読み取りでない要求の
 * 一覧（`blockedRequests`。ログインの送り方によらない）も、ここに持つ。
 */
interface LoginStageScriptState {
  tokenRequestsAllowed: number;
  sideRequestsAllowed: number[];
  serviceOriginReads: number;
  readonly blockedByScriptReason: Record<ScriptLoginBlockReason, number>;
  readonly blockedRequests: LoginStageBlockedRequestList;
  /** ML-a: 手動のログインの段で通した読み取りでない要求の一覧（止めた一覧と同じ部品）。 */
  readonly passedRequests: LoginStageBlockedRequestList;
  /**
   * ML-a-fix（ML-R の I-1）: このログインの段で、token の送信をもう通したか（登録した token の送信を通したか、token の形の要求を手動のログインの段で通した）。
   * 通した一覧の行の「token の送信より前」の印を決める。
   */
  tokenSeen: boolean;

  /** T36b: 通した token の送信の応答の状態。 */
  readonly tokenResponses: TokenResponseTracker;
  /**
   * T36R-fix（T36R の I-1）: この記録を付けた Guard の、自動ログインの資格情報の部品（方針で止めた要求を、止めた一覧に入れる前に比べる。なければ
   * `undefined`）。Guard が取り付けの時点で置く。
   */
  credentialGuard?: LoginCredentialGuard | undefined;
}

const loginStageStates = new WeakMap<LoginStageMonitor, LoginStageScriptState>();

/** スクリプトで送るログインの段の数（部品の constructor が必ず作る）。 */
function loginStageStateOf(monitor: LoginStageMonitor): LoginStageScriptState {
  const state = loginStageStates.get(monitor);
  if (state === undefined) {
    throw new TypeError('Login stage monitor has no state');
  }
  return state;
}

/** 書き込みの段の送信の報告の、POST を通したか（T30b）。`SENT` は、Guard が承認の POST を CDP の層で通した（通そうとした）こと。 */
export const WRITE_SUBMISSION_STATES = Object.freeze(['NOT_SENT', 'SENT'] as const);
export type WriteSubmissionState = (typeof WRITE_SUBMISSION_STATES)[number];

/**
 * 書き込みの段の送り手の結果の種類（DEF-099 fix）: `NOT_WRITTEN`（要求の bytes を書く前に止まった。届いていない）、`NO_RESPONSE`（書いた後に
 * 応答がない・切れた・時間切れ）、`RESPONDED`（応答を受けた）。送り手を呼ぶ前は null。
 */
export type WriteSubmissionSendOutcome = WriteSubmissionOutcome['kind'];

/**
 * 書き込みの段の送信の報告（T30b。ワーカーの書き込みの流れが読む）。
 * - `submission`: 承認の POST を通したか。`NOT_SENT` は、Guard が承認の POST を一度も通していない（サーバに届いていない）ことを表す。
 *   `SENT` は、通した（通そうとした）こと。通す命令が失敗した場合も `SENT`（届いたかは分からない側に倒す）。
 * - `responseReceived`・`responseStatus`: 通した POST の応答（HTTP の status。リダイレクトの 3xx を含む）を Guard が受けたか。
 */
export interface WriteSubmissionReport {
  readonly submission: WriteSubmissionState;
  readonly responseReceived: boolean;
  readonly responseStatus: number | null;
  /** DEF-099 fix: 送り手に送らせた回数（0 か 1。Guard は 2 回目を送らせない）。 */
  readonly sendAttempts: number;
  /** DEF-099 fix: 送り手の結果の種類（送らせる前、送り手が終わる前は null）。 */
  readonly sendOutcome: WriteSubmissionSendOutcome | null;
}

/** 書き込みの段の記録の写し（種類ごとの数だけ。URL・値・本文を持たない）。 */
export interface WriteStageMonitorSnapshot extends SubmissionStageMonitorSnapshot {
  /** 送る中身の照合（form の `checkWritePayload`、T39b から API の `checkApiWritePayload`）で止めた数（理由ごと）。 */
  readonly blockedByPayloadReason: Readonly<Record<WriteStagePayloadBlockReason, number>>;
  /** 送信の窓を開いたときに、文書の文字コードを読めたか（値は `submissionReport` にも出さない）。 */
  readonly documentCharsetRead: boolean;
  /**
   * T30R-fix-1（M-1）: 送り手が送っている間に、ブラウザが承認の POST の要求を取り消した（ページの JS の二重の送信など）ので、送り手の応答を
   * ブラウザに返せなかった（`Fetch.fulfillRequest` の失敗を違反にせず、ここに記録する）。
   */
  readonly responseDeliveryCanceled: boolean;
  /**
   * OP-M: 書き込みの段で止めた、承認した送信のほかの要求の一覧（送り方・送り先の区分・path の形・種類・時点・理由・目印の真偽。値・Origin を持たない。
   * `src/safety/write-stage-unexpected-requests.ts`）。止める判定には使わない。
   */
  readonly unexpectedRequests: WriteStageUnexpectedRequests['requests'];
  /** OP-M: 一覧に入れなかった、止めた要求の数（上限を超えた新しい形と、型を作れなかった要求）。 */
  readonly unexpectedRequestsUnlisted: number;
  /**
   * OP-N（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.7 の N2）: 監査の段の送信の扱い `PASS_EXCEPT_DELETE` で通した、サイトが自動で送る通信の一覧
   * （止めた一覧と同じ形と上限。理由は `WRITE_STAGE_AUDIT_SEND_PASSED`。値・Origin を持たない）。書き込みには数えない。
   */
  readonly passedRequests: WriteStageUnexpectedRequests['requests'];
  /** OP-N: 通した一覧に入れなかった要求の数。 */
  readonly passedRequestsUnlisted: number;
}

/** 書き込みの段の、Guard だけが書く状態（`WriteStageMonitor` ごと。モジュールの外から書けない）。 */
interface WriteStageState {
  readonly blockedByPayloadReason: Record<WriteStagePayloadBlockReason, number>;
  /** T39b: API の書き込みで、照合に一致して送り手の口に渡した要求の、ページが決める鍵の値（渡す前は null。書き込みの結果の記録に残すもの）。 */
  apiPageKeyValues: Readonly<Record<string, ApiWritePageKeyValue>> | null;
  /** T39c: API の書き込みの応答の本文から取り出した、使える形の登録の ID（取り出す口がない・取れない・応答がない場合は null）。 */
  apiRecordId: string | null;
  /**
   * T40R-fix-A: 送信の窓の送信の段が開いているか（`openSubmissionPhase`。窓を開いた後、押す直前に開く）。開くまでは、窓の観察の段（承認の送信も通さず、
   * 止めて数える）。書き込みの流れの部品だけが Node の側で開く（ページから開く口はない）。
   */
  submissionPhaseOpen: boolean;
  submission: WriteSubmissionState;
  responseReceived: boolean;
  responseStatus: number | null;
  sendAttempts: number;
  sendOutcome: WriteSubmissionSendOutcome | null;
  responseDeliveryCanceled: boolean;
  documentCharsetRead: boolean;
  /** 付けた Guard の、文書の文字コードを読む口（取り付けの時点で付ける。1 つの部品に 1 回だけ）。 */
  measureDocument: ((page: Page) => Promise<void>) | undefined;
  /** OP-M: 止めた、承認した送信のほかの要求の一覧（取り付けの時点で、入れる値を目印にして作り直す）。 */
  unexpectedRequests: WriteStageUnexpectedRequestList;
  /** OP-M: 送り先の区分の決め方（取り付けの時点で付ける。付いていなければ一覧に入れない）。 */
  destinationOf: ((url: string) => WriteStageRequestDestination) | undefined;
  /** OP-N（N2）: 送信の扱いの口で通した要求の一覧（取り付けの時点で、止めた一覧と同じ目印で作り直す）。 */
  passedRequests: WriteStageUnexpectedRequestList;
  /**
   * LU-9・LU-12a（設計書 `2026-11-02-beaksight-list-row-update-design.md` 5.3 の 2）: 前の値を後から入れる口の、送り方ごとの入れ物（取り付けの時点で、
   * 印のある期待のときだけ付ける。印のない期待・Guard に付けていない部品は undefined で、前の値の口は常に拒む）。
   */
  deferredPrior: DeferredPriorSlot | undefined;
}

/**
 * LU-9・LU-12a: 前の値を後から入れる口の入れ物（送り方で分かれる。API とフォームの 2 つの口が共有する）。`deferred` は印のある期待の写し、`supplied` は
 * 前の値を入れた期待（写して凍らせたもの。入れる前は null）。Guard の照合は、`supplied` があればそれで、なければ印のある期待（必ず止まる）で照らす。
 */
type DeferredPriorSlot =
  | { readonly transport: typeof API_SCENARIO_TRANSPORT; readonly deferred: ApiWritePayloadExpectation; supplied: ApiWritePayloadExpectation | null }
  | { readonly transport: typeof FORM_SCENARIO_TRANSPORT; readonly deferred: WritePayloadExpectation; supplied: WritePayloadExpectation | null };
/** 送り方を確かめた後の入れ物（期待の型で読む形）。 */
interface TypedDeferredPriorSlot<E> {
  readonly deferred: E;
  supplied: E | null;
}

/**
 * LU-12a（2 つの口の共通の部分。ユーザーの方針の共通化）: 前の値を後から入れる口の決まり。入れたら真。次のときは偽を返し、Guard の状態を変えない。
 * - 送信の窓を一度でも開いた後（開いている、または承認の送信を通して閉じた）。
 * - 送り方の違う段、印のない期待、Guard に付けていない部品（入れ物がない）。
 * - すでに入れた後（同じ値でも 2 回目は拒む）。
 * - `merge`（照合の側の、前の値を入れた期待の作り手。受けた値を添字で写してから確かめる）が null を返すか、投げる。
 * 入れた期待は凍らせて持つ（呼び手が後で元の object を変えても、照合は変わらない）。前の値は記録・例外の文に残さない。
 */
function supplyDeferredPriorValues<E>(
  monitor: WriteStageMonitor,
  transport: DeferredPriorSlot['transport'],
  merge: (deferred: E) => E | null,
): boolean {
  const slot = writeStageStateOf(monitor).deferredPrior;
  if (monitor.hasSubmissionWindowOpened() || slot === undefined || slot.transport !== transport || slot.supplied !== null) {
    return false;
  }
  const typed = slot as unknown as TypedDeferredPriorSlot<E>;
  let supplied: E | null;
  try {
    supplied = merge(typed.deferred);
  } catch {
    return false;
  }
  if (supplied === null) {
    return false;
  }
  typed.supplied = deepFreeze(supplied);
  return true;
}

/** LU-9・LU-12a: 照合に使う、前の値を入れた期待（送り方が同じ入れ物で、入れた後だけ。ほかは null で、呼び出し側は段の期待で照らす）。 */
function suppliedPriorExpectationOf<E>(
  monitor: WriteStageMonitor,
  transport: DeferredPriorSlot['transport'],
): E | null {
  const slot = writeStageStateOf(monitor).deferredPrior;
  return slot !== undefined && slot.transport === transport ? (slot as unknown as TypedDeferredPriorSlot<E>).supplied : null;
}

const writeStageStates = new WeakMap<WriteStageMonitor, WriteStageState>();

/** 書き込みの段の状態（部品の constructor が必ず作る）。 */
function writeStageStateOf(monitor: WriteStageMonitor): WriteStageState {
  const state = writeStageStates.get(monitor);
  if (state === undefined) {
    throw new TypeError('Write stage monitor has no state');
  }
  return state;
}

/**
 * 書き込みの段の記録・送信の窓・送信の報告（T30b。Task 30 の設計書 3 章の「書き込みの段」、4 章）。記録と窓の決まりは `SubmissionStageMonitor`。
 * - 送信の窓: ワーカーの書き込みの流れが、値を入れ始める直前に `openSubmissionWindow(page)` で開く。開いたら、Guard が、その page の main frame の
 *   文書の文字コード（`document.characterSet`）を isolated world で読む（ページの JS の書き換えの影響を受けない）。承認の POST の CDP の段階では、
 *   ブラウザが文書に命令を届けないので、送る前に読む。読んだ後に main frame の文書が変わったら（`Page.frameNavigated`・`Page.documentOpened`）、
 *   読んだ値を捨てる。読めなければ、承認の POST は `DOCUMENT_CHARSET_UNKNOWN` で止まる。
 * - T40R-fix-A: 窓は 2 段。開いた直後は観察の段（値を入れる間。承認の形の送信も照合にかけずに止めて数える）。押す直前に書き込みの入力の部品が
 *   `openSubmissionPhase()` で送信の段を開き、Guard が照合にかけて 1 回を通すのは送信の段の中だけ。
 * - 記録: 送る中身の照合で止めた理由の数（`blockedByPayloadReason`）。値・名前・URL を持たない。
 * - 送信の報告（`submissionReport`）: Guard が承認の POST を通したか、通した POST の応答を受けたか。
 * - LU-9: 前の値を後から入れる印のある API の期待では、窓を一度も開いていない間に 1 回だけ、前の値を入れる（`supplyApiPriorValues`）。入れていなければ、
 *   窓の中の送信は照合で止まる。窓の前（N2）の守りは変えない。
 * 状態を書くのは Guard だけ（`writeStageStates`）。
 */
export class WriteStageMonitor extends SubmissionStageMonitor {
  constructor() {
    super();
    writeStageStates.set(this, {
      // T39b: form の照合と API の照合の理由を合わせた一覧（Schema の Guard の要約の鍵と同じ）。
      blockedByPayloadReason: Object.fromEntries(WRITE_STAGE_PAYLOAD_BLOCK_REASONS.map((reason) => [reason, 0])) as Record<WriteStagePayloadBlockReason, number>,
      apiPageKeyValues: null,
      apiRecordId: null,
      submissionPhaseOpen: false,
      submission: 'NOT_SENT',
      responseReceived: false,
      responseStatus: null,
      sendAttempts: 0,
      sendOutcome: null,
      responseDeliveryCanceled: false,
      documentCharsetRead: false,
      measureDocument: undefined,
      unexpectedRequests: new WriteStageUnexpectedRequestList([]),
      destinationOf: undefined,
      passedRequests: new WriteStageUnexpectedRequestList([]),
      deferredPrior: undefined,
    });
  }

  /**
   * LU-9（設計書 `2026-11-02-beaksight-list-row-update-design.md` 4.0.1 の K1、5.3 の 2）: 前の値を後から入れる印のある API の期待に、前の値（保つ鍵と
   * ページが決める鍵の値）を 1 回だけ入れる。入れたら真。次のときは偽を返し、Guard の状態を変えない。
   * - 送信の窓を一度でも開いた後（開いている、または承認の送信を通して閉じた）。
   * - すでに入れた後（同じ値でも 2 回目は拒む）。
   * - 印のない期待（今の更新・登録）、form の書き込みの段、Guard に付けていない部品。
   * - 鍵の集合が期待を作る時の集合と違う、値の形が今の前の値の決まりに合わない（照合の側の `apiWriteExpectationWithPriorValues`）、読めない入力。
   * 入れた値は写して凍らせて持つ（呼び手が後で元の object を変えても、照合は変わらない）。前の値は記録・例外の文に残さない。
   * LU-12a: 窓の前・1 回だけ・状態を変えない・凍らせて持つ決まりは、フォームの口と共通の `supplyDeferredPriorValues`。受けた値の写しは照合の側
   * （`apiWriteExpectationWithPriorValues` が `apiWritePriorValuesCopyOf` で、確かめる前に添字で写す）。
   */
  supplyApiPriorValues(prior: ApiWriteSuppliedPriorValues): boolean {
    return supplyDeferredPriorValues<ApiWritePayloadExpectation>(this, API_SCENARIO_TRANSPORT, (deferred) => apiWriteExpectationWithPriorValues(deferred, prior));
  }

  /**
   * LU-12a（設計書 `2026-11-02-beaksight-list-row-update-design.md` 4.0.1 の K1、5.3 の 2・5.5）: 前の値を後から入れる印のあるフォームの期待に、前の値
   * （保つ見える欄・値を照らす hidden・組の値）を 1 回だけ入れる。約束は `supplyApiPriorValues` と同じ（共通の `supplyDeferredPriorValues`）: 窓を一度でも
   * 開いた後・2 回目・印のない期待・API の段・Guard に付けていない部品・鍵の集合が違う・値の形が今のフォームの期待の決まりに合わない（照合の側の
   * `writeExpectationWithPriorValues`）・読めない入力では偽を返し、Guard の状態を変えない。受けた値は照合の側が添字で写して凍らせる。
   */
  supplyFormPriorValues(prior: WriteSuppliedPriorValues): boolean {
    return supplyDeferredPriorValues<WritePayloadExpectation>(this, FORM_SCENARIO_TRANSPORT, (deferred) => writeExpectationWithPriorValues(deferred, prior));
  }

  /**
   * 送信の窓を開き（値を入れ始める直前。閉じた後は何もしない）、`page`（Guard の付いた Context の page）の文書の文字コードを読む。読めなかった
   * 場合も投げない（承認の POST が止まる）。Guard に付けていない部品では、窓だけを開く。
   */
  async openSubmissionWindow(page: Page): Promise<void> {
    if (!this.openWindow()) {
      return;
    }
    await writeStageStateOf(this).measureDocument?.(page);
  }

  /**
   * T40R-fix-A（Task 40 の設計書 7 章の T40R の I-1）: 送信の窓の送信の段を開く（押す直前の確かめ（止める印、監査の段、確かめ直し）の後、押す直前に、書き込みの
   * 入力の部品が呼ぶ）。窓が開いていないとき（開く前、承認の送信を通して閉じた後）は何もしない。開くまでは窓の観察の段で、Guard は承認の形の送信も照合に
   * かけずに止めて数える。開いた後に照合にかけて通すのは 1 回だけ（今の決まり）。開いたら真。
   */
  openSubmissionPhase(): boolean {
    if (!this.isSubmissionWindowOpen()) {
      return false;
    }
    writeStageStateOf(this).submissionPhaseOpen = true;
    return true;
  }

  /** T40R-fix-A: 送信の窓の送信の段が開いているか。 */
  isSubmissionPhaseOpen(): boolean {
    return writeStageStateOf(this).submissionPhaseOpen;
  }

  /**
   * T39b: API の書き込みで、Guard が照合に一致して送り手の口に渡した要求の、ページが決める鍵の値（鍵ごとの JSON の値。渡す前は null）。Task 38 の
   * 判断 (1) の、書き込みの結果の記録に残す値（ほかの値は持たない）。
   */
  apiWritePageKeyValues(): Readonly<Record<string, ApiWritePageKeyValue>> | null {
    return writeStageStateOf(this).apiPageKeyValues;
  }

  /**
   * T39c（Task 40 の D3 の口）: API の書き込みの応答の本文から、指定の `recordIdOf` が取り出した、使える形の登録の ID（なければ null）。応答の本文は
   * 持たない。
   */
  apiWriteRecordId(): string | null {
    return writeStageStateOf(this).apiRecordId;
  }

  submissionReport(): WriteSubmissionReport {
    const state = writeStageStateOf(this);
    return Object.freeze({
      submission: state.submission,
      responseReceived: state.responseReceived,
      responseStatus: state.responseStatus,
      sendAttempts: state.sendAttempts,
      sendOutcome: state.sendOutcome,
    });
  }

  snapshot(): WriteStageMonitorSnapshot {
    const state = writeStageStateOf(this);
    return Object.freeze({
      ...this.stageSnapshot(),
      blockedByPayloadReason: Object.freeze({ ...state.blockedByPayloadReason }),
      documentCharsetRead: state.documentCharsetRead,
      responseDeliveryCanceled: state.responseDeliveryCanceled,
      ...unexpectedRequestsSnapshotOf(state.unexpectedRequests),
      ...passedRequestsSnapshotOf(state.passedRequests),
    });
  }
}

/** OP-N: 通した一覧の写しを、1 つの配列（`passedRequests`）と、一覧に入れなかった数（`passedRequestsUnlisted`）に分ける。 */
const passedRequestsSnapshotOf = (
  list: WriteStageUnexpectedRequestList,
): Pick<WriteStageMonitorSnapshot, 'passedRequests' | 'passedRequestsUnlisted'> => {
  const { requests, unlisted } = list.snapshot();
  return { passedRequests: requests, passedRequestsUnlisted: unlisted };
};

/** OP-M: 一覧の写しを、1 つの配列（`unexpectedRequests`）と、一覧に入れなかった数（`unexpectedRequestsUnlisted`）に分ける。 */
const unexpectedRequestsSnapshotOf = (
  list: WriteStageUnexpectedRequestList,
): Pick<WriteStageMonitorSnapshot, 'unexpectedRequests' | 'unexpectedRequestsUnlisted'> => {
  const { requests, unlisted } = list.snapshot();
  return { unexpectedRequests: requests, unexpectedRequestsUnlisted: unlisted };
};

/**
 * OP-M: 書き込みの段で止めた要求の時点。判定の時点で送信の窓が開いていなければ、値を入れる前（窓を閉じた後は、送信の段を開いた後なので押した後）。
 * 開いていれば、送信の段を開く前は値を入れた後、開いた後は押した後。
 */
const writeStageTimingOf = (state: WriteStageState, submissionWindowOpenAtDecision: boolean): WriteStageRequestTiming => {
  if (state.submissionPhaseOpen) {
    return 'AFTER_PRESS';
  }
  return submissionWindowOpenAtDecision ? 'AFTER_FILL' : 'BEFORE_FILL';
};

/**
 * OP-M: 書き込みの段で止めた、承認した送信のほかの要求を一覧に記録する（Guard に付いた部品だけ。止め方と、ほかの記録は変えない）。本文は、行を作るとき
 * だけ読む。
 */
function recordWriteStageUnexpectedRequest(
  monitor: WriteStageMonitor,
  request: { readonly method: string; readonly url: string; readonly resourceType: RequestResourceType; readonly body: () => RequestBodyText },
  reason: string,
  submissionWindowOpenAtDecision: boolean,
): void {
  const state = writeStageStateOf(monitor);
  if (state.destinationOf === undefined) {
    return;
  }
  state.unexpectedRequests.record({
    ...request,
    destination: state.destinationOf(request.url),
    timing: writeStageTimingOf(state, submissionWindowOpenAtDecision),
    reason,
  });
}

/** 送信の段の種類（判定の口の名前と、止めた理由の種類 `LOGIN_STAGE`・`WRITE_STAGE`）。 */
type SubmissionStageKind = 'LOGIN_STAGE' | 'WRITE_STAGE';

/** 回数の上限の指定を、許す回数にする（0 以上の安全な整数でなければ 0。fail-closed）。 */
const postLimitOf = (maxPosts: number): number => (Number.isSafeInteger(maxPosts) && maxPosts > 0 ? maxPosts : 0);

/**
 * L11（設計書 `2026-11-09-beaksight-remove-limits-design.md` 4。設計者の判断 (b)）: 登録した送信先（ログインに伴う送信 `loginSideRequests`、監査の段の読み取りの
 * 手続きの呼び出し `auditReadRequests`）は、回数を数えずに何回でも通す。判定の口には、項目ごとに、いつもこの残り（1）を渡し、通しても減らさない
 * （`maxPerLoginStage`・`maxPerPageLoad` は使わない。名前の削除は LZ）。登録していない送信の扱い、資格情報の守り、削除の止めは変えない。
 */
const REGISTERED_REQUEST_ALWAYS_ADMITTED = 1;

/** スクリプトで送るログインの指定の写し（T34b。取り付けの後に呼び出し側が書き換えても、判定は変わらない）。 */
interface ScriptLoginSnapshot {
  readonly scriptLogin: ScriptRequestLoginPolicy['scriptLogin'];
  /** 登録したログインに伴う送信の送信先と method（回数の上限は `limits`）。 */
  readonly sides: readonly { readonly origin: string; readonly path: string; readonly method: string }[];
  readonly limits: readonly number[];
  readonly approvedServiceOrigins: readonly string[];
}

function snapshotScriptLogin(script: GuardScriptLogin): ScriptLoginSnapshot {
  const { scriptLogin } = script;
  return Object.freeze({
    scriptLogin: Object.freeze({
      origin: String(scriptLogin.origin),
      path: String(scriptLogin.path),
      requiredQuery: Object.freeze(scriptLogin.requiredQuery.map(({ name, value }) => Object.freeze({ name: String(name), value: String(value) }))),
    }),
    sides: Object.freeze(script.loginSideRequests.map(({ origin, path, method }) =>
      Object.freeze({ origin: String(origin), path: String(path), method: String(method) }))),
    limits: Object.freeze(script.loginSideRequests.map(({ maxPerLoginStage }) => maxPerLoginStage)),
    approvedServiceOrigins: Object.freeze(script.approvedServiceOrigins.map((origin) => String(origin))),
  });
}

/** スクリプトで送るログインの判定の口（項目ごとの残りの回数 `sideRemaining` つき。T34b）。 */
const scriptRequestPolicyOf = (script: ScriptLoginSnapshot, sideRemaining: readonly number[]): ScriptRequestLoginPolicy => ({
  scriptLogin: script.scriptLogin,
  loginSideRequests: script.sides.map((side, index) => ({ ...side, remainingPosts: sideRemaining[index] ?? 0 })),
  approvedServiceOrigins: script.approvedServiceOrigins,
});

/**
 * 送信の段（ログインの段と書き込みの段）の POST の数え方（Task 25 の設計書 4.2。T25b。T30b で書き込みの段と共通にした）。1 つの Context の
 * Guard に 1 つ。
 * - 判定は、route の層と CDP の層の両方で `classifyPassiveRequest` の段の口（`authSetup` か `writeStage`）に、同じ送信先を渡して行う。
 * - 数えるのは、CDP の層（Guard の page の session の Document の横取り）だけである。Guard の session は Playwright の session より先に
 *   要求を見る（外側の横取り。DEF-042 の確かめ）ので、main frame のナビゲーションの POST は、まず CDP の層で、残りの回数そのものを
 *   渡して判定する。ALLOW なら（書き込みの段では、さらに送る中身の照合が `ALLOW` なら）、続ける前に残りを 1 減らし、route の層への「許した印」を
 *   1 つ置く。リダイレクトでやり直す POST（307、308）は route の層に来ないが、CDP の層に来るので、同じく数える。
 * - route の層では、残りの回数の代わりに「CDP の層が許した、同じ method と URL の要求の印があれば 1、なければ 0」を渡す。ALLOW なら
 *   印を 1 つ使う。印のない POST（CDP の層が許していない要求）は、route の層でも止まる（fail-closed）。これで、1 つの要求を両方の層で
 *   二重に数えない。
 * - 印の数は、許した回数を超えない。
 * - Safety Ledger には、許した POST を記録しない（ほかの ALLOW の要求と同じ。値や本文も記録しない）。止めた POST は、今までどおり
 *   `blockedRequests`（`NON_READ_METHOD`）に残る。
 */
class SubmissionPostAdmission {
  readonly kind: SubmissionStageKind;
  readonly #endpoints: readonly SubmissionEndpoint[];
  #remainingPosts: number;
  /** T34b: スクリプトで送るログインの指定の写し（ない場合はフォームの送信のログインか、書き込みの段）。 */
  readonly #script: ScriptLoginSnapshot | undefined;
  /** T34b: 登録したログインに伴う送信の、項目ごとの残りの回数（`#script` の `loginSideRequests` の順）。 */
  readonly #sideRemaining: number[];
  /** 送信の段の記録と送信の窓（ログインの段は、指定にあればそれ、なければ Guard の自分の部品）。 */
  readonly monitor: SubmissionStageMonitor;
  /** CDP の層が許して、route の層がまだ見ていない要求の印（T35b で、監査の段と共通の `RouteTicketBook` にした）。 */
  readonly #routeTickets = new RouteTicketBook();
  /** T39b: API の書き込みの段の、承認した API の Origin（form の書き込みの段とログインの段は undefined）。 */
  readonly #apiOrigin: string | undefined;
  /**
   * LU-5（fix round 1 の案 A）: API の書き込みの段の、照合へ回す要求の path（照合の側の `apiWriteCheckPathOf`。作れない期待は空の文字で、どの要求にも
   * 当たらない。fail-closed）。form の書き込みの段とログインの段は undefined。
   */
  readonly #apiWritePath: string | undefined;
  /** LU-SFIX3-B: フォームの書き込みの段の、窓の前（N2）に守る送信先の path の型（フォームの更新で送信先の最後の区切りが対象の番号のときだけ。ほかは undefined）。 */
  readonly #guardedPathShape: string | undefined;
  /** ML-a: 手動のログインの段（判定の口に `manualPassThrough` を渡す）。ログインの段だけ。 */
  readonly #manualPassThrough: boolean;
  /** T44R の M-1: 手動のログインの段の、スクリプトの口がないときの承認したサービスの Origin（写し。ほかは undefined）。 */
  readonly #manualServiceReadOrigins: readonly string[] | undefined;
  /** DEF-193: 自動ログインの段の通し方の印（スクリプトで送るログインの段で、手動の段でないときだけ真）。 */
  readonly #automatedPassThrough: boolean;
  /**
   * L12a（設計書 `2026-11-09-beaksight-remove-limits-design.md`、L12 の判断）: 書き込みの段の押した後の扱いを使うか（送信の扱いが `PASS_EXCEPT_DELETE` の書き込みの
   * 段だけ真。偽なら、押した後も今の書き込みの段の決まりで止める）。
   */
  readonly #afterPress: boolean;

  constructor(
    kind: SubmissionStageKind,
    endpoints: readonly SubmissionEndpoint[],
    maxPosts: number,
    monitor: SubmissionStageMonitor,
    script?: GuardScriptLogin,
    apiOrigin?: string,
    manualPassThrough = false,
    manualServiceReadOrigins?: readonly string[],
    apiWritePath?: string,
    guardedPathShape?: string,
    automatedPassThrough = false,
    afterPress = false,
  ) {
    this.kind = kind;
    this.#afterPress = kind === 'WRITE_STAGE' && afterPress;
    this.#manualPassThrough = kind === 'LOGIN_STAGE' && manualPassThrough === true;
    this.#automatedPassThrough = kind === 'LOGIN_STAGE' && !this.#manualPassThrough && script !== undefined && automatedPassThrough;
    this.#manualServiceReadOrigins = this.#manualPassThrough && script === undefined && manualServiceReadOrigins !== undefined
      ? Object.freeze(manualServiceReadOrigins.map((origin) => String(origin)))
      : undefined;
    this.#apiOrigin = kind === 'WRITE_STAGE' && apiOrigin !== undefined ? String(apiOrigin) : undefined;
    this.#apiWritePath = this.#apiOrigin !== undefined && apiWritePath !== undefined ? String(apiWritePath) : undefined;
    this.#guardedPathShape = kind === 'WRITE_STAGE' && this.#apiOrigin === undefined && guardedPathShape !== undefined ? String(guardedPathShape) : undefined;
    this.#endpoints = Object.freeze(endpoints.map((endpoint) =>
      Object.freeze({ origin: String(endpoint.origin), path: String(endpoint.path) })));
    this.#remainingPosts = postLimitOf(maxPosts);
    this.monitor = monitor;
    this.#script = kind === 'LOGIN_STAGE' && script !== undefined ? snapshotScriptLogin(script) : undefined;
    // L11: 登録したログインに伴う送信は、回数を数えずに通す（`REGISTERED_REQUEST_ALWAYS_ADMITTED`）。
    this.#sideRemaining = this.#script?.limits.map(() => REGISTERED_REQUEST_ALWAYS_ADMITTED) ?? [];
    if (this.#script !== undefined && monitor instanceof LoginStageMonitor) {
      // 項目ごとの数を、登録した項目の数だけ用意する（同じ部品を、もう一度付けた場合も、項目の数に合わせ直す。数は 0 から）。
      loginStageStateOf(monitor).sideRequestsAllowed = this.#script.limits.map(() => 0);
    }
  }

  /** 残りの回数 `remainingPosts`（スクリプトで送るログインでは token の送信）と、ログインに伴う送信の項目ごとの残り `sideRemaining` の、段の口。 */
  #stagePolicy(remainingPosts: number, sideRemaining: readonly number[]): SubmissionStagePolicyPart {
    const submissionWindowOpen = this.monitor.isSubmissionWindowOpen();
    const [writeEndpoint] = this.#endpoints;
    if (this.kind === 'LOGIN_STAGE') {
      const script = this.#script;
      return {
        authSetup: {
          loginPostEndpoints: this.#endpoints,
          remainingPosts,
          submissionWindowOpen,
          ...(script === undefined ? {} : { scriptRequest: scriptRequestPolicyOf(script, sideRemaining) }),
          ...(this.#manualPassThrough ? { manualPassThrough: true as const } : {}),
          ...(this.#manualServiceReadOrigins === undefined ? {} : { manualServiceReadOrigins: this.#manualServiceReadOrigins }),
          // DEF-193: 自動ログインの段の通し方の印（CDP の層と route の層の両方の判定に同じに渡す）。
          ...(this.#automatedPassThrough ? { automatedPassThrough: true as const } : {}),
        },
      };
    }
    // 書き込みの段の送信先は 1 つ（取り付けで確かめる）。ない場合は、どの POST も許さない（fail-closed）。T39b: API の書き込みの段は、承認した API の
    // Origin を渡す（判定が form の送信を通さず、窓の中の API の書き込みの 1 回目だけを照合にかける）。
    // T40R-fix-A（Task 40 の設計書 7 章の T40R の I-1）: 送信の段（`WriteStageMonitor.openSubmissionPhase`。押す直前の確かめの後に開く）が開くまでは、承認の
    // 送信も通さない（残りの回数 0 として判定する。照合にかけず、送り手にも渡さない）。窓の観察の段（値を入れる間）に出た読み取りでない要求は、今の判定で
    // 止まり、窓の中の止めた要求として数える（`unexpectedRequestCount`）。
    const admittable = this.monitor instanceof WriteStageMonitor && writeStageStateOf(this.monitor).submissionPhaseOpen ? remainingPosts : 0;
    const apiOrigin = this.#apiOrigin === undefined
      ? {}
      : { apiOrigin: this.#apiOrigin, ...(this.#apiWritePath === undefined ? {} : { apiWritePath: this.#apiWritePath }) };
    // OP-N（N2）: 送信の窓を一度でも開いたか（値を入れ始めた後）。開いた後は、監査の段の送信の扱いの口を使わない（OP-REV3 の C-2）。
    const valuesEntered = this.monitor.hasSubmissionWindowOpened();
    // LU-SFIX3-B: フォームの更新の、窓の前（N2）に守る送信先の path の型（承認の POST の照らしは `writeEndpoint` の具体的な path のまま）。
    const guarded = this.#guardedPathShape === undefined ? {} : { guardedPathShape: this.#guardedPathShape };
    // L12a: 送信の段を開いた後（押した後）は、押した後の扱いの口を渡す（送信の扱いが `PASS_EXCEPT_DELETE` の段だけ）。承認した送信の応答を受けるまでは、
    // 承認の送信先とその下への読み取りでない要求を通さない（`approvedWriteResponded`）。
    const afterPress = this.#afterPress && this.monitor instanceof WriteStageMonitor && writeStageStateOf(this.monitor).submissionPhaseOpen
      ? { afterPress: Object.freeze({ approvedWriteResponded: writeStageStateOf(this.monitor).responseReceived }) }
      : {};
    return writeEndpoint === undefined
      ? { writeStage: { writeEndpoint: { origin: '', path: '' }, remainingPosts: 0, submissionWindowOpen, valuesEntered, ...apiOrigin } }
      : { writeStage: { writeEndpoint, remainingPosts: admittable, submissionWindowOpen, valuesEntered, ...apiOrigin, ...guarded, ...afterPress } };
  }

  /** CDP の層の判定の口（残りの回数そのもの）。 */
  cdpStagePolicy(): SubmissionStagePolicyPart {
    return this.#stagePolicy(this.#remainingPosts, this.#sideRemaining);
  }

  /**
   * CDP の層で、非読み取りの要求を ALLOW した（続ける前に呼ぶ）。残りを 1 減らす。route の層が見る要求（リダイレクトでない要求）なら、
   * 印を 1 つ置く。
   * T34b: スクリプトで送るログインでは、判定が通した理由（`admission`）の残りを減らして数える。ログインに伴う送信は、その項目の残りを減らす。
   * token の送信は、token の残りを減らし、送信の窓を開く（token の送信を通した時点から成功の確かめまで。設計書 3.3）。
   */
  admitAtCdp(method: string, url: string, routeWillSee: boolean, admission?: LoginStageAdmission): void {
    if (this.#script !== undefined && this.monitor instanceof LoginStageMonitor) {
      const state = loginStageStateOf(this.monitor);
      if (admission?.kind === 'LOGIN_SIDE_REQUEST' && admission.index < this.#sideRemaining.length) {
        // L11: 残りは減らさない（何回でも通す）。通した数だけを記録する。
        state.sideRequestsAllowed[admission.index] = saturatingIncrement(state.sideRequestsAllowed[admission.index] ?? 0);
      } else {
        this.#remainingPosts = Math.max(0, this.#remainingPosts - 1);
        state.tokenRequestsAllowed = saturatingIncrement(state.tokenRequestsAllowed);
        // ML-a-fix: token の送信を通した（後に通した送信は、token の送信より前の印を持たない）。
        state.tokenSeen = true;
        this.monitor.openSubmissionWindow();
      }
    } else {
      this.#remainingPosts = Math.max(0, this.#remainingPosts - 1);
      // T26g-1: 許した送信先への POST を通したので、送信の窓を閉じる（続く要求は、段の通常の判定に戻る）。
      this.monitor.closeSubmissionWindow();
    }
    if (routeWillSee) {
      this.#routeTickets.place(method, url);
    }
  }

  /**
   * ML-a: 手動のログインの段の口が通した読み取りでない要求の形を、通した一覧に記録する（回数は減らさない。理由が行の理由でない・ないときは記録しない）。
   */
  recordManualPass(url: string, resourceType: RequestResourceType, reason: ManualLoginPassThroughReason | null): void {
    if (reason !== null && isLoginStageBlockedRequestReason(reason) && this.monitor instanceof LoginStageMonitor) {
      // ML-a-fix（ML-R の I-1）: 行に「token の送信より前」の印を残す。token の形の要求（`grant_type` の値を記録したもの）を通したら、以後の行は印を持たない。
      const state = loginStageStateOf(this.monitor);
      const tokenShaped = isTokenShapedLoginUrl(url);
      state.passedRequests.record(url, resourceType, reason, !state.tokenSeen && !tokenShaped);
      if (tokenShaped) {
        state.tokenSeen = true;
      }
    }
  }

  /**
   * DEF-194: 自動ログインの段の口（DEF-193）が通した読み取りでない要求の形を、通した一覧に、登録の対象でない理由（`AUTOMATED_LOGIN_PASSED`）で記録する
   * （回数は減らさない。token の送信より前の印は付けない。手動の段の自動の登録だけが使う印のため）。
   */
  recordAutomatedPass(url: string, resourceType: RequestResourceType): void {
    if (this.monitor instanceof LoginStageMonitor) {
      loginStageStateOf(this.monitor).passedRequests.record(url, resourceType, 'AUTOMATED_LOGIN_PASSED', false);
    }
  }

  /** 残りの回数を 0 にする（T30b: 書き込みの段で、送る中身の照合が承認の形の POST を止めた。以後、どの POST も許さない）。 */
  spend(): void {
    this.#remainingPosts = 0;
  }

  /** route の層の判定の口（CDP の層が許した同じ要求の印があれば 1、なければ 0）。 */
  routeStagePolicy(method: string, url: string): SubmissionStagePolicyPart {
    // T34b: 印は method と URL の組なので、CDP の層が通した送信先（token かログインに伴う送信のどれか）だけに当たる。どの送信先にも同じ数を渡す。
    const remaining = this.#routeTickets.has(method, url) ? 1 : 0;
    return this.#stagePolicy(remaining, this.#sideRemaining.map(() => remaining));
  }

  /** route の層で、非読み取りの要求を ALLOW した。印を 1 つ使う。 */
  consumeAtRoute(method: string, url: string): void {
    this.#routeTickets.consume(method, url);
  }
}

/**
 * CDP の層が許して、route の層がまだ見ていない要求の印（Task 25 の設計書 4.2 の数え方。T35b で、送信の段の数え方と監査の段の読み取りの手続きの
 * 呼び出しの数え方に共通にした）。鍵は `method URL`、値は数。CDP の層で許した、route の層が見る要求（リダイレクトでない要求）ごとに 1 つ置き、
 * route の層で ALLOW したら 1 つ使う。印のない読み取りでない要求は、route の層でも止まる（fail-closed）。
 */
class RouteTicketBook {
  readonly #tickets = new Map<string, number>();

  static #keyOf(method: string, url: string): string {
    return `${method} ${url}`;
  }

  place(method: string, url: string): void {
    const key = RouteTicketBook.#keyOf(method, url);
    this.#tickets.set(key, (this.#tickets.get(key) ?? 0) + 1);
  }

  has(method: string, url: string): boolean {
    return (this.#tickets.get(RouteTicketBook.#keyOf(method, url)) ?? 0) > 0;
  }

  consume(method: string, url: string): void {
    const key = RouteTicketBook.#keyOf(method, url);
    const tickets = this.#tickets.get(key) ?? 0;
    if (tickets <= 1) {
      this.#tickets.delete(key);
    } else {
      this.#tickets.set(key, tickets - 1);
    }
  }
}

/**
 * スクリプトで送るログインの監査の段の、登録した読み取りの手続きの呼び出しの数え方（T35b。Task 35 の設計書 3.2。1 つの Context の Guard に 1 つ）。
 * 送信の段の数え方（`SubmissionPostAdmission`）と同じく、CDP の層で残りの回数そのものを渡して判定し、ALLOW なら項目の残りを 1 減らして route の層への
 * 印を置く。route の層では、印があれば 1、なければ 0 を、どの項目にも渡す。`readRequestsAllowed` が偽の Context（幅の走査と Interaction）は、どの
 * 項目の残りも 0 から始める。
 */
class AuditReadAdmission {
  readonly #policy: AuditStagePolicy;
  readonly #remaining: number[];
  readonly #routeTickets = new RouteTicketBook();
  readonly monitor: AuditStageMonitor | undefined;

  constructor(stage: GuardAuditStage) {
    const { scriptLogin } = stage;
    this.#policy = Object.freeze({
      approvedServiceOrigins: Object.freeze(stage.approvedServiceOrigins.map((origin) => String(origin))),
      auditReadRequests: Object.freeze(stage.auditReadRequests.map(({ origin, path, method }) =>
        Object.freeze({ origin: String(origin), path: String(path), method: String(method), remainingPosts: 0 }))),
      scriptLogin: Object.freeze({
        origin: String(scriptLogin.origin),
        path: String(scriptLogin.path),
        requiredQuery: Object.freeze(scriptLogin.requiredQuery.map(({ name, value }) => Object.freeze({ name: String(name), value: String(value) }))),
      }),
      // T35R-fix（T35R の C-1）: 最初の読み込みでない Context（幅の走査と Interaction）は、サービスの Origin へ送らない（真でなければ送らない。fail-closed）。
      serviceOriginRequestsWithheld: stage.readRequestsAllowed !== true,
    });
    // L11: 登録した読み取りの手続きの呼び出しは、最初の読み込みの Context では回数を数えずに通す（`REGISTERED_REQUEST_ALWAYS_ADMITTED`）。幅の走査と
    // Interaction の Context は、今どおり通さない（0）。
    this.#remaining = stage.auditReadRequests.map(() => (stage.readRequestsAllowed === true ? REGISTERED_REQUEST_ALWAYS_ADMITTED : 0));
    this.monitor = stage.monitor instanceof AuditStageMonitor ? stage.monitor : undefined;
  }

  #policyWith(remaining: readonly number[]): AuditStagePolicy {
    return {
      ...this.#policy,
      auditReadRequests: this.#policy.auditReadRequests.map((request, index) => ({ ...request, remainingPosts: remaining[index] ?? 0 })),
    };
  }

  /** CDP の層の判定の口（残りの回数そのもの）。 */
  cdpPolicy(): AuditStagePolicy {
    return this.#policyWith(this.#remaining);
  }

  /** route の層の判定の口（CDP の層が許した同じ要求の印があれば 1、なければ 0）。 */
  routePolicy(method: string, url: string): AuditStagePolicy {
    const remaining = this.#routeTickets.has(method, url) ? 1 : 0;
    return this.#policyWith(this.#remaining.map(() => remaining));
  }

  /** CDP の層で、登録した読み取りの手続きの呼び出しを ALLOW した（続ける前に呼ぶ）。その項目の残りを 1 減らして数え、route の層への印を置く。 */
  admitAtCdp(method: string, url: string, _admission: Extract<AuditStageAdmission, { readonly kind: 'AUDIT_READ_REQUEST' }>): void {
    // L11: 残りは減らさない（何回でも通す）。通した数だけを記録する。
    if (this.monitor !== undefined) {
      const state = auditStageStateOf(this.monitor);
      state.registeredReadRequestsAllowed = saturatingIncrement(state.registeredReadRequestsAllowed);
    }
    this.#routeTickets.place(method, url);
  }

  /** route の層で、読み取りでない要求を ALLOW した。印を 1 つ使う。 */
  consumeAtRoute(method: string, url: string): void {
    this.#routeTickets.consume(method, url);
  }
}

/**
 * AS-a（設計書 `2026-10-19-beaksight-audit-send-policy-design.md` 2.2）: 監査の段の送信の扱い `PASS_EXCEPT_DELETE` の口（1 つの Context の Guard に 1 つ）。
 * RB-4a（X2。設計書 `2026-11-15-beaksight-test-rebuild-design.md` 3.2）: 数の上限の名残（残りの数、route の層への印、「あと 1 つ」）は外した。数えないので、
 * CDP の層と route の層は、同じ口で同じ判定をする（同じ要求を両方の層で判定しても答えは同じ）。CDP の層を通らずに route の層に来た要求（CDP の付く前の
 * ポップアップの要求など）も、同じ決まり（削除・削除の上書き・危険な語は止める）で判定する。
 */
class AuditSendAdmission {
  /** AS-c: 許可 Origin と承認したサービスの Origin（正規の形。通した要求がほかの Origin へのものかを見分けるため）。 */
  readonly #knownOrigins: ReadonlySet<string>;
  /** 判定の口（取り付けの時点の写し）。 */
  readonly #policy: AuditSendPolicy;
  /** AS-c: WebSocket の route の判定の口（`webSockets` の印つき）。 */
  readonly #webSocketPolicy: AuditSendPolicy;
  /** OP-Q（Q1）: 書き込みの作業の中の Passive の Context の口か。 */
  readonly forWriteJob: boolean;

  constructor(send: GuardAuditSend, allowedOrigins: ReadonlySet<string>) {
    const approvedServiceOrigins = Object.freeze(send.approvedServiceOrigins.map((origin) => String(origin)));
    // OP-Q（Q1）: 書き込みの作業の中の Passive の Context の印の写し（承認した送信の送信先）。
    const writeJobEndpoint = send.writeJobEndpoint === undefined
      ? undefined
      : Object.freeze({ origin: String(send.writeJobEndpoint.origin), path: String(send.writeJobEndpoint.path) });
    this.forWriteJob = writeJobEndpoint !== undefined;
    this.#policy = Object.freeze({
      approvedServiceOrigins,
      dangerousTerms: Object.freeze(send.dangerousTerms.map((term) => String(term))),
      ...(writeJobEndpoint === undefined ? {} : { writeJobEndpoint }),
    });
    this.#webSocketPolicy = Object.freeze({ ...this.#policy, webSockets: true });
    this.#knownOrigins = canonicalPassiveAllowedOrigins(new Set([...allowedOrigins, ...approvedServiceOrigins]));
  }

  /** CDP の層・route の層・`requestfailed` の判定の口。 */
  policy(): AuditSendPolicy {
    return this.#policy;
  }

  /** AS-c: WebSocket の route の判定の口。 */
  webSocketPolicy(): AuditSendPolicy {
    return this.#webSocketPolicy;
  }

  /** AS-c: 通した要求の送り先が、許可 Origin と承認したサービスの Origin のほか（ほかの Origin）か。 */
  isOtherOrigin(url: string): boolean {
    return !hasAllowedOrigin(url, this.#knownOrigins);
  }
}

/** 承認したサービスの Origin への要求の上限で止めた判定（T35b。`classifyPassiveRequest` は返さない。Guard が作る）。 */
const SERVICE_REQUEST_LIMIT_DECISION: BlockDecision = Object.freeze({
  action: 'BLOCK',
  category: 'REQUEST',
  reason: 'SERVICE_REQUEST_LIMIT_REACHED',
});

/**
 * 自動ログインの資格情報の守りで止めた判定（T36b。`classifyPassiveRequest` は返さない。Guard が作る）。`reason` は閉じた一覧の値を置くだけ
 * （`recordBlockedDecision` は、この判定を Safety Ledger に書かず、ログインの段の記録に数える）。
 */
const LOGIN_CREDENTIAL_DECISION: BlockDecision = Object.freeze({
  action: 'BLOCK',
  category: 'REQUEST',
  reason: 'NON_READ_METHOD',
  loginCredential: true,
});

/** 判定が通した要求が、承認したサービスの Origin への要求として数える要求か（T35b）。 */
const isCountedServiceRequest = (admission: AuditStageAdmission | undefined): boolean =>
  admission?.kind === 'SERVICE_ORIGIN_READ' || (admission?.kind === 'AUDIT_READ_REQUEST' && admission.serviceOrigin);

/** 書き込みの段の指定の写し（取り付けの後に呼び出し側が配列を書き換えても、照合は変わらない。T30b）。 */
function snapshotWriteExpectation(expectation: WritePayloadExpectation): WritePayloadExpectation {
  // LU-SFIX1（LU-SREV1 の Minor-1 と同じ形）: 一覧の `map`・`Symbol.iterator` を呼ばず、添字の繰り返しで写す（`indexedListCopyOf`）。一覧でなければ、今と
  // 同じく投げる（取り付けの前の `TypeError`）。
  const listCopy = <T>(list: unknown, copyEntry: (entry: never) => T): readonly T[] => {
    const copied = indexedListCopyOf(list, copyEntry as (entry: unknown) => T);
    if (copied === null) {
      throw new TypeError('Write stage expectation is malformed');
    }
    return copied;
  };
  const copy = (values: readonly string[]): readonly string[] => listCopy(values, (value: string) => value);
  type Field = WritePayloadExpectation['submittedFields'][number];
  type Pair = NonNullable<WritePayloadExpectation['checkboxPairs']>[number];
  return Object.freeze({
    request: Object.freeze({ ...expectation.request }),
    submittedFields: listCopy(expectation.submittedFields, (field: Field) => Object.freeze({ name: field.name, value: field.value })),
    passthroughFieldNames: copy(expectation.passthroughFieldNames),
    emptyFileFieldNames: copy(expectation.emptyFileFieldNames),
    // T30b fix round 1: 値を照らす method の上書きの期待（省略は null）。
    methodOverride: expectation.methodOverride ?? null,
    // T31c: 値を照らす hidden の欄、同じ名前の hidden と checkbox の組、送らないことを期待する欄（省略は空の一覧。照合は省略と同じに扱う）。
    checkedPassthroughFields: listCopy(expectation.checkedPassthroughFields ?? [], (field: Field) => Object.freeze({ name: field.name, value: field.value })),
    checkboxPairs: listCopy(expectation.checkboxPairs ?? [],
      (pair: Pair) => Object.freeze({ name: pair.name, offValue: pair.offValue, checkedValue: pair.checkedValue })),
    absentFieldNames: copy(expectation.absentFieldNames ?? []),
    // LU-12a: 前の値を後から入れる印も写す（照合の側の唯一の写し方。形が違えば、照合と前の値の口が必ず拒む形に置き換える。印は残す。fail-closed）。
    ...(expectation.deferredPriorValues === undefined ? {} : { deferredPriorValues: writeDeferredPriorValuesCopyOf(expectation.deferredPriorValues) as WritePayloadExpectation['deferredPriorValues'] }),
  });
}

/** LU-9: 前の値を後から入れる印の写し（保つ鍵の名前は文字だけを残し、ほかは拒む形の null にする。一覧でなければ空の object）。 */
function deferredPriorValuesCopyOf(mark: unknown): unknown {
  // LU-SFIX1（LU-SREV1 の Minor-1）: 一覧の `map` を呼ばず、添字の繰り返しで写す（`indexedListCopyOf`）。
  const names = indexedListCopyOf(isRecord(mark) ? mark['keptKeys'] : undefined, (name) => (typeof name === 'string' ? name : null));
  return names === null ? {} : { keptKeys: names };
}

/**
 * T39b: API の書き込みの段の指定の写し（JSON の値だけの平らなデータなので、JSON で写して凍らせる。取り付けの後に呼び出し側が書き換えても、照合は
 * 変わらない）。照合の形の確かめは `checkApiWritePayload` が行う（形が違えば `EXPECTATION_INVALID` で止まる）。
 */
function snapshotApiWriteExpectation(expectation: ApiWritePayloadExpectation): ApiWritePayloadExpectation {
  const json: unknown = JSON.parse(JSON.stringify({ spec: expectation.spec, values: expectation.values, recordId: expectation.recordId }));
  // T41c: 更新の前の値（保つ鍵、ページが決める鍵）も写す。JSON で写すと有限でない数が null に変わる（誤りの期待が通る形になる）ので、項目ごとに写す。
  // scalar でない値・一覧でない形は、照合が必ず拒む形（空の object）に置き換える（呼び出し側の object を凍らせない）。
  const copy = {
    ...(json as object),
    ...(expectation.keptKeys === undefined ? {} : { keptKeys: apiWritePriorValuesCopyOf(expectation.keptKeys) }),
    ...(expectation.pageKeyPriorValues === undefined ? {} : { pageKeyPriorValues: apiWritePriorValuesCopyOf(expectation.pageKeyPriorValues) }),
    // DEF-198: ほかの filter の照らす値も、前の値と同じ写し方で写す（写さなければ照合が期待の誤りで止める）。
    ...(expectation.otherFilterValues === undefined ? {} : { otherFilterValues: apiWritePriorValuesCopyOf(expectation.otherFilterValues) }),
    // DEF-203: 台帳の登録の値と照らす鍵の値も、同じ写し方で写す（写さなければ照合が期待の誤りで止める）。
    ...(expectation.ledgerKeyValues === undefined ? {} : { ledgerKeyValues: apiWritePriorValuesCopyOf(expectation.ledgerKeyValues) }),
    // LU-9: 前の値を後から入れる印（保つ鍵の名前の一覧）も写す。形が違えば、照合と前の値の口が必ず拒む形（空の object）に置き換える（印は残す。fail-closed）。
    ...(expectation.deferredPriorValues === undefined ? {} : { deferredPriorValues: deferredPriorValuesCopyOf(expectation.deferredPriorValues) }),
  };
  const freeze = (value: unknown): void => {
    if (typeof value === 'object' && value !== null) {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
  };
  freeze(copy);
  return copy as ApiWritePayloadExpectation;
}

/** 確かめて写した書き込みの段の指定（送り方で分かれる。T39b）。 */
type AcceptedWriteStage =
  | {
    readonly transport: typeof FORM_SCENARIO_TRANSPORT;
    readonly expectation: WritePayloadExpectation;
    readonly monitor: WriteStageMonitor;
    readonly guardedPathShape?: string | undefined;
  }
  | {
    readonly transport: typeof API_SCENARIO_TRANSPORT;
    readonly expectation: ApiWritePayloadExpectation;
    readonly monitor: WriteStageMonitor;
    readonly handoff: ApiWriteHandoff | undefined;
    readonly recordIdOf: ((body: Buffer) => string | null) | undefined;
  };

/**
 * 書き込みの段の指定を確かめて写す（T30b）。形が違う、部品がすでに別の Guard に付いている、は `TypeError`（取り付けの前に投げる。値を文に入れない）。
 * T39b: API の書き込みの段（`transport: 'API'`）は、承認した API の Origin と path の型が文字列で、送り手の口が関数か省略であること。
 */
function acceptWriteStage(writeStage: GuardWriteStage): AcceptedWriteStage {
  if (typeof writeStage !== 'object' || writeStage === null || !(writeStage.monitor instanceof WriteStageMonitor)) {
    throw new TypeError('Write stage requires a WriteStageMonitor');
  }
  if (writeStageStateOf(writeStage.monitor).measureDocument !== undefined) {
    throw new TypeError('Write stage monitor is already attached to a Guard');
  }
  if (writeStage.transport === API_SCENARIO_TRANSPORT) {
    let apiExpectation: ApiWritePayloadExpectation;
    try {
      apiExpectation = snapshotApiWriteExpectation(writeStage.expectation);
    } catch {
      throw new TypeError('Write stage API expectation is malformed');
    }
    const request: unknown = isRecord(apiExpectation.spec) ? apiExpectation.spec.request : undefined;
    const approvedOrigin: unknown = isRecord(request) ? request['origin'] : undefined;
    if (!isRecord(request) || typeof approvedOrigin !== 'string' || typeof request.pathShape !== 'string'
      || (writeStage.handoff !== undefined && typeof writeStage.handoff !== 'function')
      || (writeStage.recordIdOf !== undefined && typeof writeStage.recordIdOf !== 'function')) {
      throw new TypeError('Write stage API expectation is malformed');
    }
    return {
      transport: API_SCENARIO_TRANSPORT,
      expectation: apiExpectation,
      monitor: writeStage.monitor,
      handoff: writeStage.handoff,
      recordIdOf: writeStage.recordIdOf,
    };
  }
  if (writeStage.transport !== undefined && writeStage.transport !== FORM_SCENARIO_TRANSPORT) {
    throw new TypeError('Write stage transport must be FORM or API');
  }
  let expectation: WritePayloadExpectation;
  try {
    expectation = snapshotWriteExpectation(writeStage.expectation);
  } catch {
    throw new TypeError('Write stage expectation is malformed');
  }
  const { origin, path } = expectation.request;
  if (typeof origin !== 'string' || typeof path !== 'string') {
    throw new TypeError('Write stage expectation is malformed');
  }
  // LU-SFIX3-B: 守る送信先の型は、送信先の path の最後の区切りを `{id}` にした形だけ（作り方の唯一の部品 `recordPathShapeOf` と同じ値）。
  const { guardedPathShape } = writeStage;
  if (guardedPathShape !== undefined
    && (typeof guardedPathShape !== 'string' || recordPathShapeOf(path, path.split('/').at(-1) ?? '') !== guardedPathShape)) {
    throw new TypeError('Write stage guarded path shape must be the request path with the last segment as the record id');
  }
  // LU-SFIX4（LU-REV の Minor-1。設計書 5.5 の 6）: 一覧の行から開くフォームの更新（前の値を後から入れる印のある期待）は、窓の前（N2）に開き手を押すので、守る型を
  // 必須にする（渡し忘れた呼び手で、同じ表のほかの行・表の path への要求が N2 で届かないように。受けなければ Context を作らず、窓を開かない。fail closed）。
  if (expectation.deferredPriorValues !== undefined && guardedPathShape === undefined) {
    throw new TypeError('Write stage of a deferred prior values expectation requires the guarded path shape');
  }
  return {
    transport: FORM_SCENARIO_TRANSPORT, expectation, monitor: writeStage.monitor, ...(guardedPathShape === undefined ? {} : { guardedPathShape: String(guardedPathShape) }),
  };
}

/**
 * 書き込みの段の指定を、受け付けられるなら写す（T30b。factory が Context を作る前に確かめる口。`WriteStageMonitor` の部品で、まだどの Guard にも付いておらず、
 * 指定の写しが取れて、送信先の Origin と path が文字列のとき）。LU-SFIX1（LU-SREV1 の Minor-5）: Guard の取り付けと同じ確かめと写し（`acceptWriteStage`。期待は
 * 写して凍らせ、部品と口はそのまま。前の `isAcceptableGuardWriteStage` を置き換えた）。受け付けられなければ null。factory は、この写しを Guard と中継の両方に渡す（中継の送信先と予算の path を、Guard と同じ写しから作る）。写しをもう一度
 * 写しても同じ値になる。
 */
export function guardWriteStageCopyOf(value: unknown): GuardWriteStage | null {
  try {
    return acceptWriteStage(value as GuardWriteStage);
  } catch {
    return null;
  }
}

/** `Page.frameNavigated`・`Page.documentOpened` の事象の frame の ID（読めなければ `null`。T30b）。 */
function mainFrameIdOfPageEvent(event: unknown): string | null {
  const frame = isRecord(event) ? event['frame'] : undefined;
  const id = isRecord(frame) ? frame['id'] : undefined;
  return typeof id === 'string' ? id : null;
}

/** 書き込みの段の、文書の文字コードを読む isolated world の名前（Playwright の world と重ならない名前）。 */
const WRITE_STAGE_CHARSET_WORLD_NAME = '__beaksight_write_stage_charset__';
/** 文書の文字コードを読む式（isolated world で評価する。ページの JS の書き換えの影響を受けない）。 */
const DOCUMENT_CHARSET_EXPRESSION = 'document.characterSet';
// L12b: 文書の文字コードを読む CDP の命令の全体の期限（前は 2 秒）は撤廃した（今は L0 の反応なしの長さで見放す。下の送り手の側）。定数は LZ-1 で消した。

/** DEF-144: 外部スキームへの移動の試みの違反のコード（Guard の記録と、probe の段で発見を続ける判定 `isProbeExternalSchemeViolation` が共有する）。 */
export const EXTERNAL_SCHEME_NAVIGATION_VIOLATION_CODE = 'EXTERNAL_SCHEME_NAVIGATION_ATTEMPTED';
/**
 * 外部スキームへの移動の試みの違反の文（英語。記録の唯一の作り方）。EL-F（EL-R の M5）: 本番の Chromium は一時のプロファイルの設定で移動を止め、外部の
 * アプリへ渡さない（起動の部品の自己検査で、効いていることを確かめてから始める）ので、「起動したかもしれない」から、今の守りに合う文にした。
 */
export const externalSchemeNavigationViolationMessage = (scheme: string): string =>
  `The page tried to navigate to the external scheme ${scheme}; the browser blocked it and did not pass it to an external application`;
/**
 * Guard の page の文書の横取りの session が、持ち主の閉じ方（`closePassiveGuardedPage`・Context の閉じ）を通らずに外れたときの違反（`CDP_SESSION_DETACHED`）の文。
 * L10（Guard の持ち主の調べ）: 前の文「page remained active」は、ブラウザが page を自分で閉じた場合（印のない閉じ。DEF-038 のとおり漏れの疑い）と合わない
 * ので、実態に合わせた（判定は変えない）。
 */
export const CDP_SESSION_DETACHED_MESSAGE =
  'Document interception session detached without the owner closing the page (an unmarked page close or a detach while the page was open)';
/** DEF-144: frame の判定の失敗の違反のコード（`window.open` の外部スキームの移動で、あわせて記録される）。 */
export const FRAME_CLASSIFICATION_FAILED_VIOLATION_CODE = 'FRAME_CLASSIFICATION_FAILED';
/**
 * DEF-145: Guard が通した main frame の要求が、届いたか分からないまま失敗した違反のコード（Guard の記録と、probe の段の読み取りの移動の取り消しで発見を
 * 続ける判定が共有する）。違反は失敗した要求（`request`）を持つ。
 */
export const HTTP_MAIN_FRAME_DELIVERY_FAILED_VIOLATION_CODE = 'HTTP_MAIN_FRAME_DELIVERY_FAILED';

/**
 * DEF-213: ネットワークへ出ない文書のスキーム（`blob:` はブラウザの中の blob の登録から、`data:` は URL の中身から読む。サーバへ要求を出さない）。
 * `NON_EXTERNAL_NAVIGATION_SCHEMES` の部分の閉じた一覧。
 */
const NETWORK_FREE_DOCUMENT_SCHEMES: ReadonlySet<string> = new Set(['blob:', 'data:'] satisfies (typeof NON_EXTERNAL_NAVIGATION_SCHEMES)[number][]);

/**
 * DEF-213: 失敗した main frame の移動が、ネットワークへ出なかったと分かるか。行き先のスキームが `blob:`・`data:` で、サーバのリダイレクトの続きでない
 * （`redirectedFrom()` がない。リダイレクトの元の http(s) の要求は届いているので、今の判定のまま）ものだけ。解析できない URL・事実を読めない要求は偽
 * （今の判定のまま。fail-closed）。
 */
function isNetworkFreeMainFrameNavigationFailure(request: Pick<Request, 'url' | 'redirectedFrom'>): boolean {
  try {
    return NETWORK_FREE_DOCUMENT_SCHEMES.has(new URL(request.url()).protocol) && request.redirectedFrom() === null;
  } catch {
    return false;
  }
}

/**
 * navigation の URL が外部スキーム（`NON_EXTERNAL_NAVIGATION_SCHEMES` にないスキーム）なら、そのスキーム（末尾の `:` を除いた形）を返す。
 * 外部スキームでなければ `null` を返す。解析できない URL は例外を投げる（呼び出し側が fail-closed にする）。DEF-144: probe の部品が、押す前に送信ボタンの
 * 移動の先を見分けるためにも使う（判定を複製しない）。
 */
export function externalNavigationScheme(url: string): string | null {
  const { protocol } = new URL(url);
  return (NON_EXTERNAL_NAVIGATION_SCHEMES as readonly string[]).includes(protocol) ? null : protocol.slice(0, -1);
}

/**
 * EL-F（EL-R の I2）・EL-F2（EL-R2 の N2）: URL が、Chromium に組み込みの PDF の表示の拡張の頁（閉じた一覧の ID の `chrome-extension:`）か。PDF の頁を開くと
 * Chromium がこの頁の sub frame を作るので、外部スキームの検出は、`Page.frameStartedNavigating` の sub frame のときだけ、これを外部スキームにしない
 * （`window.open` や main frame の移動など、ほかの経路は今どおり外部スキーム）。解析できない URL は偽。
 */
export function isChromiumPdfViewerFrameUrl(url: string): boolean {
  try {
    const { protocol, host } = new URL(url);
    return protocol === CHROMIUM_EXTENSION_PROTOCOL && (NON_EXTERNAL_CHROMIUM_EXTENSION_IDS as readonly string[]).includes(host);
  } catch {
    return false;
  }
}

/**
 * EL-12（設計書 `2026-10-24-beaksight-external-launch-block-design.md` 3.3・3.5）: 外部スキームへの移動を検出する事象の出どころ。
 * - `CDP_STARTED`: page と OOPIF の session の `Page.frameStartedNavigating`（frame の ID で main か sub か）。
 * - `CDP_WINDOW_OPEN`: opener の session の `Page.windowOpen`（popup の frame はまだないので、frame の種類は分からない）。
 * - `CDP_UNREACHABLE`: 予備。`Page.frameNavigated` の `unreachableUrl`（ブロックのエラーの頁が確かになった移動）。
 * - `REQUEST`: Playwright の `request` の事象（テストの既定の headless shell では、CDP の事象と両方来る）。
 */
type ExternalNavigationSource = 'CDP_STARTED' | 'CDP_WINDOW_OPEN' | 'CDP_UNREACHABLE' | 'REQUEST';

/** EL-12: 同じ移動の別の出どころの事象を、同じ移動とみなす時間（ms）。両方の事象は、同じ移動について数 ms の差で届く。 */
export const EXTERNAL_NAVIGATION_DUPLICATE_WINDOW_MS = 5_000;
/** EL-12: 1 つの Context で覚えておく、検出した移動の数の上限（古いものから捨てる）。 */
export const MAX_EXTERNAL_NAVIGATION_DETECTIONS = 64;

/**
 * EL-12: 外部スキームへの移動を、出どころ（`ExternalNavigationSource`）が違っても 1 回だけ記録するための登録（Context ごと）。
 * `admit(source, url, now)` は、まだ同じ出どころが付いていない、期限の中の同じ URL の検出があれば、その出どころを足して偽（記録しない）を返す。
 * なければ新しい検出として覚えて真（記録する）を返す。同じ出どころの 2 回目は、別の移動として真を返す（別の移動を隠さない）。
 */
export class ExternalNavigationDetections {
  #entries: { readonly url: string; readonly expiresAt: number; readonly sources: Set<ExternalNavigationSource> }[] = [];

  admit(source: ExternalNavigationSource, url: string, now: number): boolean {
    this.#entries = this.#entries.filter((entry) => entry.expiresAt > now);
    const same = this.#entries.find((entry) => entry.url === url && !entry.sources.has(source));
    if (same !== undefined) {
      same.sources.add(source);
      return false;
    }
    // L10（INV-LIMITS の N22）: 覚える数の上限（前は `MAX_EXTERNAL_NAVIGATION_DETECTIONS` 64 で、古いものから捨てた）は撤廃した（同じ移動とみなす時間の
    // 窓を過ぎた検出だけを捨てる）。
    this.#entries.push({ url, expiresAt: now + EXTERNAL_NAVIGATION_DUPLICATE_WINDOW_MS, sources: new Set([source]) });
    return true;
  }
}

/**
 * EL-12: CDP の事象の外部スキームの移動の検出で、見ない URL（空と `javascript:`）か。`javascript:` はスクリプトの実行で、OS に渡らない（今の
 * `request` の口でも来ない。EL-0 の調べで `Page.frameStartedNavigating` も来ないことを確かめた。`Page.windowOpen` には来る）。
 */
function isIgnoredCdpNavigationUrl(url: string): boolean {
  return url === '' || url.toLowerCase().startsWith('javascript:');
}

/**
 * EL-12: `Page.frameStartedNavigating`・`Page.frameNavigated`・`Page.windowOpen` の事象から、移動の URL と frame の ID を読む（読めなければ `null`）。
 * `Page.frameNavigated` は `frame.unreachableUrl`（ブロックのエラーの頁の元の URL）と `frame.id` を読む。
 */
export function externalNavigationFactsOf(
  method: string,
  params: unknown,
): { readonly source: Exclude<ExternalNavigationSource, 'REQUEST'>; readonly url: string; readonly frameId: string | null } | null {
  if (!isRecord(params)) {
    return null;
  }
  if (method === 'Page.frameStartedNavigating') {
    const { url, frameId } = params;
    return typeof url === 'string' && typeof frameId === 'string' ? { source: 'CDP_STARTED', url, frameId } : null;
  }
  if (method === 'Page.windowOpen') {
    const { url } = params;
    return typeof url === 'string' ? { source: 'CDP_WINDOW_OPEN', url, frameId: null } : null;
  }
  if (method === 'Page.frameNavigated') {
    const frame = params['frame'];
    if (!isRecord(frame)) return null;
    const { unreachableUrl, id } = frame;
    return typeof unreachableUrl === 'string' && unreachableUrl !== '' && typeof id === 'string'
      ? { source: 'CDP_UNREACHABLE', url: unreachableUrl, frameId: id }
      : null;
  }
  return null;
}

/** EL-12: 外部スキームの移動の検出に使う CDP の事象の名前（page の session と OOPIF の session の両方で聞く）。 */
export const EXTERNAL_NAVIGATION_CDP_EVENTS = Object.freeze(['Page.frameStartedNavigating', 'Page.windowOpen', 'Page.frameNavigated'] as const);

/** EL-12: `Page.windowOpen` の外部スキームの移動で、frame の種類が分からないことの違反の文（`FRAME_CLASSIFICATION_FAILED`。今の形を保つ）。 */
export const WINDOW_OPEN_FRAME_UNAVAILABLE_MESSAGE = 'Frame for this window.open navigation is not available before the popup is created';

interface ExpectedCdpFailure {
  readonly method: string;
  readonly url: string;
  readonly errorText: string;
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
  readonly request: CorrelationRequest & {
    readonly headers?: Readonly<Record<string, string>>;
    /** T30b: 本文があるか（CDP の `hasPostData`）。書き込みの段の送る中身の照合だけが使う。 */
    readonly hasPostData?: boolean;
    /** T30b: 本文の部品（CDP の `postDataEntries`。`bytes` は base64）。書き込みの段の送る中身の照合だけが使う（Guard は中身を読まない）。 */
    readonly postDataEntries?: readonly { readonly bytes?: string }[];
  };
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
  if (status === undefined || !isHttpStatusInRange(status, REDIRECTION_HTTP_STATUS_RANGE)) {
    return [];
  }
  return (event.responseHeaders ?? [])
    .filter((header) => header.name.toLowerCase() === 'location')
    .flatMap((header) => header.value.split('\n'));
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
  /** DEF-245: 閉じるときの作業の待ちの見張りの反応なしの長さ（`PassiveRequestGuardOptions.drainQuietLimitMs`。省略は本番の長さ）。 */
  readonly drainQuietLimitMs: number | undefined;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly pageGuards: WeakMap<Page, PageGuardRecord>;
  readonly pendingTasks: Set<Promise<void>>;
  /**
   * `pendingTasks` のうち、要求の横取りの作業（`handlePausedRequest`。DEF-042 の設計書 2.4）の数（L10 で作業の数の上限は撤廃した。数えるだけ）。
   */
  pendingRequestTaskCount: number;
  readonly listenerCleanups: ListenerCleanupOwnership;
  overflowInvalidation: Promise<void> | undefined;
  rawCloseConfirmed: boolean;
  /**
   * DEF-110 fix: Guard がこの Context の `close` の事象を見たか（取り付けの始めに聞き始める）。Context の close が reject されたときに、
   * Context がもう存在しないことを文言に頼らずに確かめる証し（`isGuardedContextGone`）。
   */
  contextCloseObserved: boolean;
  closeAttempt: Promise<CloseAttemptResult> | undefined;
  taskLimitReported: boolean;
  drainTimeoutReported: boolean;
  /** 出口の中継の凍結の口（DEF-085。`PassiveRequestGuardOptions.egressFreeze`）。なければ `undefined`。 */
  readonly egressFreeze: ((cause: EgressFreezeCause) => void) | undefined;
  /** SAFE-2 の 1: ログインの段か書き込みの段の指定を受けた Guard か（読み込む前の凍結の口 `activateInteractionFreezeBeforeLoad` が拒む）。 */
  readonly submissionStage: boolean;
  /** DEF-099 fix round 1: 書き込みの段の送信中の送り手を止める口（書き込みの段だけ。閉じ始めるときに呼ぶ）。なければ `undefined`。 */
  readonly abortWriteSubmission: (() => void) | undefined;
  /** DEF-276-relay: 中継している文書の WebSocket（握手の途中を含む）を切る口。凍結と閉じ（`freezeEgress`）で、すべて呼ぶ。 */
  readonly webSocketRelayCuts: Set<() => void>;
  /**
   * DEF-210（通知の枠の設計書 3.2.1）: 通知の枠の閉じる押下の期間の扱い（押す期間でなければ `null`）。`beginNotificationPress` が入れ、`endNotificationPress` と
   * 凍結（`activateInteractionFreeze`）が外す。判定の口（CDP の層と route の層）に、`notificationPress` として渡す。
   */
  notificationPress: NotificationPressMode | null;
  /**
   * fix round 3（設計書 3.2.2 の 4）: 押す期間の main frame の移動（`AUDIT` は止めずに数える。RB-14a）と、押す期間に開いたポップアップの数
   * （`notificationPressNavigationsOf` で読む）。呼ぶ側は、1 以上のビューポート（幅）を測らない。
   */
  notificationPressNavigations: number;
  /**
   * RB-14a（X11）: 見るだけの点検の押す期間に、止めずに数えた main frame の移動の行き先（`notificationPressNavigationTargetsOf` で読む。記録には書かない）。
   * 呼ぶ側は、セッションの切れの判定に使う（前は、止めた移動の記録の行き先で見た）。
   */
  notificationPressNavigationTargets: string[];
  /**
   * REV-EV4（設計書 `2026-11-16-beaksight-finding-evidence-design.md` 3.4）: 横にスクロールする領域のキーの押下の期間か（`beginScrollKeyPress` が入れ、
   * `endScrollKeyPress` と凍結が外す）。判定の口に `scrollKeyPress` として渡し、その期間の main frame の移動とポップアップを止める（違反にしない）。
   */
  scrollKeyPress: boolean;
  /**
   * FRET（設計書 `2026-11-24-beaksight-dialog-focus-return-design.md` の設計変更履歴の 2026-11-25）: キーの押下の期間のうち、窓を開くボタンの押す期間（Enter を
   * 押してから、窓を閉じて落ち着くまで）か（`scrollKeyPressGuardOf` の `pressPeriod` が入れ、外す。凍結とキーの押下の期間の終わりも外す）。判定の口に
   * `scrollKeyPress: 'DIALOG_PRESS'` として渡し、読み取りでない要求も止める。
   */
  dialogPress: boolean;
  /**
   * FRET（2026-11-25 fix round 1 の判断）: 窓を開くボタンの確かめが 1 つでも押した後、その Context の page を閉じるまで（BeakSight 自身の次の読み込み
   * `announceOwnMainFrameNavigation`・閉じる前の離れる手順 `announcePageLeave`（fix round 3）・凍結で外す）、押す期間の止め（`DIALOG_PRESS`）を続けるか（`scrollKeyPressGuardOf` の `holdPressStop` が入れる）。FRET は
   * ビューポートの点検の最後の段なので、その後の点検の証拠には混ざらない。止めた要求は今の止めの記録のまま Ledger に残る。
   */
  dialogPressHold: boolean;
  /**
   * FRET fix round 4（2026-11-26）: 止めの続きのある（押した）page が、閉じる前の離れる手順を始めた（`announcePageLeave`）。真の後に通した読み取りでない要求は、
   * Ledger の通した要求の記録の `afterDialogPressLeave` に数える。
   */
  dialogPressLeaving: boolean;
  /**
   * FRET fix round 4: 押す期間に、押す前から開いていた WebSocket の接続が送った frame の数（止めない。`scrollKeyPressGuardOf` の `webSocketFramesSent` で読む）。
   */
  dialogPressWebSocketFrames: number;
  /** fix round 5: 押す期間の外の、止めの続き（hold）の間に、前から開いていた接続が送った frame の数（止めない。`webSocketFramesSentAfterPress` で読む）。 */
  dialogPressHoldWebSocketFrames: number;
  /** REV-EV4: キーの押下の期間に止めた main frame の移動とポップアップの数（`scrollKeyPressGuardOf` の `blocked` で読む）。FRET: 押す期間に止めた要求も数える。 */
  scrollKeyPressBlocks: number;
  /**
   * COV-2c（SREV-COV の C-1）: 凍結の段で、1 回だけ通してよい main frame の文書の移動の行き先（fragment を外した URL。`admitFrozenMainFrameDocument` が入れ、
   * 返した口が外す）。なければ `null`（今どおり凍結の段の main frame の移動はすべて止める）。
   */
  frozenMainFrameDocument: FrozenMainFrameDocumentAdmission | null;
  ensurePageGuard(page: Page): PageGuardRecord;
}

const guardStates = new WeakMap<BrowserContext, GuardState>();
const ownerClosingPages = new WeakSet<Page>();

/**
 * BN-a（設計書 `2026-10-23-beaksight-bundle-beaksight-block-noise-design.md` 3.1）: 止めた事象の時点の唯一の決め方。Guard の段階が閉じる途中・無効化・閉じた後か、
 * 持ち主が閉じ始めた page か、BeakSight が閉じる前に離れ始めた page（`announcePageLeave`）なら `CLOSING`、ほかは `LOAD`。段階・page が分からない（`null`）ときは、
 * 分かる方だけで決める。判定と止め方には使わない（記録の印だけ）。
 */
function blockedEventPhaseOf(phase: GuardPhase | null, page: Page | null): BlockedEventPhase {
  if (phase !== null && isClosingOrInvalidatingPhase(phase)) {
    return 'CLOSING';
  }
  // DEF-236: 見せたままの待ちの印（`announcePacingWait`）の後も `CLOSING`（証拠を集め終え、閉じる前に待つ間）。
  const navigationState = page === null ? undefined : mainFrameNavigationStates.get(page);
  return page !== null && (ownerClosingPages.has(page) || navigationState?.leaving === true || navigationState?.pacingWait === true) ? 'CLOSING' : 'LOAD';
}

/** BN-a: route の要求の page（記録の時点の印だけに使う。Service Worker の要求など、page を引けなければ `null`。投げない）。 */
function requestPageForPhase(request: Request): Page | null {
  try {
    return request.frame().page();
  } catch {
    return null;
  }
}

/**
 * BN-a: page の今の時点（`blockedEventPhaseOf`。その Context の Guard の段階と、page の閉じ方・離れ方から決める）。network の collector が、失敗の行の時点の印に
 * 使う（Safety Ledger の止めた事象の時点と同じ決め方）。Guard のない Context の page は、page の離れ方だけで決める。読むだけで、段階も記録も変えない。
 */
export function pageEventPhaseOf(page: Page): BlockedEventPhase {
  let phase: GuardPhase | null = null;
  try {
    phase = guardStates.get(page.context())?.phase ?? null;
  } catch {
    phase = null;
  }
  return blockedEventPhaseOf(phase, page);
}

function isFrozenPhase(phase: GuardPhase): boolean {
  return phase === 'FROZEN_ACTIVE'
    || phase === 'FROZEN_CLOSING'
    || phase === 'FROZEN_INVALIDATING';
}

/**
 * 段階が、閉じる途中・無効化・閉じた後か。DEF-144（設計書 `2026-10-20-beaksight-probe-external-scheme-design.md` 2.3）: probe の部品が、Guard が Context を
 * 閉じ始めたこと（`CONTEXT_CLOSED_BY_GUARD`）を見分けるためにも使う。
 */
export function isClosingOrInvalidatingPhase(phase: GuardPhase): boolean {
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
  return safeErrorMessage(error, GUARD_ERROR_NORMALIZATION_FALLBACK);
}

class GuardTaskDrainTimeoutError extends Error {
  constructor() {
    super(GUARD_PENDING_TASK_DRAIN_TIMEOUT_MESSAGE);
    this.name = 'GuardTaskDrainTimeoutError';
  }
}

/**
 * 対応付けに使う要求（method は大文字）。L10（設計書 `2026-11-09-beaksight-remove-limits-design.md` 4。INV-LIMITS の N23 の Guard の分）: method と URL の長さの
 * 上限（前は `MAX_HTTP_METHOD_LENGTH`・`MAX_URL_LENGTH` を超えたら null で、要求を止めて違反にした）は撤廃した。いつも対応付ける（null を返さない。呼び出し側の形は
 * 名前の削除と一緒に LZ で整える）。
 */
function boundedCorrelationRequest(method: string, url: string): CorrelationRequest | null {
  return { method: method.toUpperCase(), url };
}

/**
 * Guard が自分で失敗させた文書の要求の、命令の失敗の予期（page ごと）。L10（T29）: 期限を持たず、使ったとき（`consume`・`remove`）か、page の session を
 * 閉じたとき（`clear`）に捨てる。単体テストが、時間が経っても捨てないことと、閉じたら捨てることを確かめるために公開する（Guard の外では使わない）。
 */
export class ExpectedCdpFailureRegistry {
  readonly #entries = new WeakMap<Page, ExpectedCdpFailure[]>();

  constructor(_ledger: SafetyLedger) {
    // L10: 違反を記録する場面（上限・長さ）がなくなったので、Ledger は使わない（呼び出し側の形は変えない）。
  }

  register(page: Page, request: CorrelationRequest, _now: number, errorText = BLOCKED_BY_CLIENT_DOCUMENT_FAILURE_TEXT): ExpectedCdpFailure | null {
    // L10（INV-LIMITS の N22・N23 と設計者の判断 E）: 登録の数の上限（前は `MAX_EXPECTED_CDP_FAILURES` 64 で `EXPECTED_CDP_FAILURE_LIMIT_REACHED`）と、method・URL
    // の長さの上限（前は `CDP_CORRELATION_IDENTITY_REJECTED`）は撤廃した。登録は、使うか page を閉じるまで持つ（時間で捨てない）。
    // SREV-SAFE の I-1: 予期する失敗の文言は、止め方で決める（`blockedMainFrameNavigationFailureTextOf`。省略は `ERR_BLOCKED_BY_CLIENT`）。
    const live = [...(this.#entries.get(page) ?? [])];
    const expected = {
      method: request.method.toUpperCase(),
      url: request.url,
      errorText,
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
    _now: number,
  ): boolean {
    const method = request.method.toUpperCase();
    const live = [...(this.#entries.get(page) ?? [])];
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
  }
}

/**
 * DEF-052・DEF-225: 待ちのタイマーが切れた後、Node がすでに受け取っている事象を処理するため、決まる（`isDecided`）まで `setImmediate` で最大
 * `CANCELED_DOCUMENT_EVIDENCE_RECEIVED_EVENT_YIELDS` 回譲ってから `settle` を呼ぶ（時間の長さでは決めない）。
 */
function settleAfterReceivedEvents(isDecided: () => boolean, settle: () => void): void {
  let remainingYields = CANCELED_DOCUMENT_EVIDENCE_RECEIVED_EVENT_YIELDS;
  const readReceivedEvents = (): void => {
    if (remainingYields <= 0 || isDecided()) {
      settle();
      return;
    }
    remainingYields -= 1;
    setImmediate(readReceivedEvents);
  };
  readReceivedEvents();
}

/**
 * DEF-225: Guard が凍結の前に止めたダウンロード（`PASSIVE_DOWNLOAD`）の記録（page ごと、URL だけ）と、同じ page の main frame の読み取りの移動の失敗との
 * 1 対 1 の対応付け。
 * - 記録（`record`）: `download` の事象で、URL を覚える（L10: 数と長さの上限なし）。
 * - 対応付け（`awaitAndConsume`）: 同じ page・同じ URL の記録を 1 つ消して真。なければ `waitMs` まで待つ（記録が来たらその場で確かめ直す）。
 *   ほかの URL の記録は使わない。1 つの記録は 1 回だけ使う。
 * - 閉じる（`clear`）: page の session を閉じたときに、その page の記録を捨てる。L10（T29）: 記録は期限を持たない（時間では捨てない）。
 * 単体テストが、時間が経っても捨てないことと、閉じたら捨てることを確かめるために公開する（Guard の外では使わない）。
 */
export class PassiveDownloadRegistry {
  readonly #entries = new WeakMap<Page, { readonly url: string }[]>();
  readonly #waiters = new WeakMap<Page, Set<() => void>>();

  record(page: Page, url: string, _now: number): void {
    const live = [...(this.#entries.get(page) ?? [])];
    // L10（INV-LIMITS の N22・N23）: 覚える数の上限（前は `MAX_PASSIVE_DOWNLOAD_EVIDENCE_PER_PAGE` 16）と URL の長さの上限（`MAX_URL_LENGTH`）は撤廃した
    // （超えた記録を覚えず、その失敗を違反にしていた）。page の寿命まで持つ（設計者の判断 E。時間で捨てない）。
    live.push({ url });
    this.#entries.set(page, live);
    for (const wake of [...(this.#waiters.get(page) ?? [])]) wake();
  }

  awaitAndConsume(page: Page, url: string, waitMs: number): Promise<boolean> {
    if (this.#consume(page, url)) return Promise.resolve(true);
    if (waitMs <= 0) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const waiters = this.#waiters.get(page) ?? new Set<() => void>();
      this.#waiters.set(page, waiters);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const finish = (consumed: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        waiters.delete(check);
        resolve(consumed);
      };
      const check = (): void => {
        if (!settled && this.#consume(page, url)) finish(true);
      };
      waiters.add(check);
      timer = setTimeout(() => settleAfterReceivedEvents(() => settled, () => finish(this.#consume(page, url))), waitMs);
    });
  }

  /** page の session を閉じたときに、その page の記録を捨てる（L10。持ち主を閉じたら捨てる）。待っている対応付けは、それぞれの待ちの時間で終わる。 */
  clear(page: Page): void {
    this.#entries.delete(page);
  }

  #consume(page: Page, url: string): boolean {
    const live = [...(this.#entries.get(page) ?? [])];
    const index = live.findIndex((entry) => entry.url === url);
    if (index >= 0) live.splice(index, 1);
    if (live.length === 0) this.#entries.delete(page);
    else this.#entries.set(page, live);
    return index >= 0;
  }
}

/**
 * Document のリクエストの requestId と、そのリクエスト（メソッドと URL）の対応付け。リダイレクトの後のリクエスト
 * （`redirectedRequestId` を持つもの）が、元のリクエストを引くために使う（C18h で、登録と消去の時点を整理した）。
 * - 登録: リクエストの段階（`remember`）。応答の段階では、まず登録を消し（`forget`。元のリクエストが終わった）、リダイレクトの
 *   応答（3xx で `Location` を持つ）なら登録し直して、期限をその時点から数える。
 * - 消去: リダイレクトの後のリクエストで使われたとき（`take`）、元のリクエストが終わったとき（`forget`。応答を受けたとき、
 *   Guard がリクエストを失敗させたとき）、Context や page が閉じたとき（`clear`）。
 * - L10（設計書 `2026-11-09-beaksight-remove-limits-design.md` 4。INV-LIMITS の N22・N23・T29 と設計者の判断 E）: 件数の上限（前は `MAX_REDIRECT_PREDECESSORS`
 *   64 で、超える登録は `REDIRECT_PREDECESSOR_LIMIT_REACHED` の違反）、要求の ID・method・URL の長さの上限（前は `CDP_CORRELATION_IDENTITY_REJECTED` の違反）、
 *   時間で捨てる決まり（前は `REDIRECT_PREDECESSOR_RETENTION_MS` 1 秒）は撤廃した。登録は持ち主（Context・page）の寿命まで持つ。
 */
class RedirectPredecessorRegistry {
  readonly #entries = new Map<string, CorrelationRequest>();

  constructor(_ledger: SafetyLedger) {
    // L10: 違反を記録する場面（上限・長さ）がなくなったので、Ledger は使わない（呼び出し側の形は変えない）。
  }

  remember(requestId: string, request: CorrelationRequest, _now: number): boolean {
    this.#entries.set(requestId, { method: request.method.toUpperCase(), url: request.url });
    return true;
  }

  /** 元のリクエストが終わったとき（完了か失敗）に、その登録を消す（C18h）。登録がなければ何もしない。 */
  forget(requestId: string): void {
    this.#entries.delete(requestId);
  }

  take(requestId: string, _now: number): RedirectPredecessorLookup {
    const entry = this.#entries.get(requestId);
    this.#entries.delete(requestId);
    return entry === undefined ? { kind: 'MISSING' } : { kind: 'FOUND', request: entry };
  }

  clear(): void {
    this.#entries.clear();
  }
}

/** 取り消しの証拠になる `Network.loadingFailed` の、要求の種類（Network の domain の ResourceType。DEF-026）。 */
const CANCELED_DOCUMENT_RESOURCE_TYPE = 'Document';

/** 文書の要求の、ブラウザによる取り消しの証拠（DEF-026。同じ session の `Network.loadingFailed`）。 */
interface CanceledDocumentEvidence {
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
 *   証拠は覚えない（その要求への命令の失敗は、違反のまま）。L10（T29）: 証拠は期限を持たず、使ったときか session を閉じたときに捨てる。
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
 *   L10（N22・T29）: 数の上限と時間の上限は撤廃した。要求が読み込みを終えたら記録を消し（`recordLoadingFinished`）、取り消されたら、確かめで使うか
 *   session を閉じるまで残す（`recordLoadingFailed`）。
 * - 確かめ（`awaitMainFrameCancellation`）: Playwright の要求（method と URL）と、記録を1対1に対応付け、(a) 許可して進めた、(b) 取り消しの
 *   証拠がある、(c) 応答がページに渡っていないことの証拠がある、のすべてを満たすときだけ真。使った記録と証拠は消す（1回だけ使う）。
 *   Guard が進める前に取り消された要求（例: 0〜5ms の間隔の `location.replace` の連続）は、(a) を満たさないので、違反のまま残る
 *   （設計書 2.1.1 の限界）。
 */
export class CanceledDocumentRegistry {
  /** 証拠の `requestId` と、その `errorText`。 */
  readonly #evidence = new Map<string, CanceledDocumentEvidence>();
  /** 証拠を待っている扱い（`requestId` ごと。証拠を受けたとき、session を閉じたときに呼ぶ）。 */
  readonly #waiters = new Map<string, Set<() => void>>();
  /** main frame の文書の要求の記録（DEF-027。Network の domain の要求の ID ごと。page の session だけが使う）。 */
  readonly #mainFrameDocuments = new Map<string, MainFrameDocumentRecord>();
  /** main frame の取り消しの確かめを待っている扱い（DEF-027。記録や証拠が変わったとき、session を閉じたときに呼ぶ）。 */
  readonly #mainFrameWaiters = new Set<() => void>();
  /**
   * DEF-052（設計書 2.2）: 上限のために覚えなかった証拠の要求の ID（診断だけに使う。`MAX_DROPPED_CANCELED_DOCUMENT_IDS` 件まで）。
   * session を閉じても消さない（閉じた後の失敗の診断にも使うため。数の上限があるので増え続けない）。L10: 時間では捨てない。
   */
  readonly #droppedAtCapacity = new Set<string>();
  /** DEF-052（設計書 2.2）: 上限のために覚えなかった証拠の数の累計（ID を覚えきれなかったものも数える）。 */
  #droppedAtCapacityCount = 0;
  #cleared = false;

  /** 同じ session の `Network.loadingFailed` を受けたとき。文書の要求の取り消しなら覚え、その要求の証拠を待っている扱いを起こす。 */
  recordLoadingFailed(event: unknown, _now: number): void {
    const { requestId, canceled, type, errorText } = (typeof event === 'object' && event !== null ? event : {}) as {
      readonly requestId?: unknown;
      readonly canceled?: unknown;
      readonly type?: unknown;
      readonly errorText?: unknown;
    };
    if (this.#cleared || typeof requestId !== 'string' || requestId.length === 0) {
      return;
    }
    // DEF-027: main frame の文書の要求が終わった。L10（T29）: その記録は、Playwright の要求との対応付けで使うか、session を閉じるまで残す（時間で縮めない）。
    if (canceled !== true || type !== CANCELED_DOCUMENT_RESOURCE_TYPE) {
      this.#wakeMainFrameWaiters();
      return;
    }
    // L10（INV-LIMITS の N22）: 覚える数の上限（前は `MAX_CANCELED_DOCUMENT_EVIDENCE` 256。超えた証拠は覚えず、その要求への命令の失敗を違反にした）は撤廃した。
    // 同じ要求の証拠をもう一度受けた場合は、上書きする（数は増えない）。
    this.#evidence.set(requestId, {
      errorText: typeof errorText === 'string' ? errorText : null,
    });
    for (const wake of [...(this.#waiters.get(requestId) ?? [])]) wake();
    this.#wakeMainFrameWaiters();
  }

  /**
   * `networkId` の要求の取り消しの証拠を受けているか。まだ受けていなければ、`waitMs` まで待つ（待つ間に証拠を受けたら、すぐに真で解決する）。
   * session を閉じた後は、待たずに偽。
   * DEF-052（設計書 2.1）: 待ちのタイマーが切れても、すぐには偽で決めない。Node がすでに受け取っている CDP の事象（Node の処理が止まって
   * いた間に届き、まだ session の事象の処理に渡っていないもの）を処理するため、`setImmediate` で、証拠が届くか session を閉じるまで、
   * 最大 `CANCELED_DOCUMENT_EVIDENCE_RECEIVED_EVENT_YIELDS` 回譲ってから、もう一度だけ証拠を見て決める。違反にしない条件は変えない。
   */
  awaitCancellation(networkId: string, waitMs: number): Promise<boolean> {
    if (this.#hasEvidence(networkId) || waitMs <= 0 || this.#cleared) {
      return Promise.resolve(this.#hasEvidence(networkId));
    }
    return new Promise<boolean>((resolve) => {
      const waiters = this.#waiters.get(networkId) ?? new Set<() => void>();
      this.#waiters.set(networkId, waiters);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        waiters.delete(settle);
        if (waiters.size === 0 && this.#waiters.get(networkId) === waiters) this.#waiters.delete(networkId);
        resolve(this.#hasEvidence(networkId));
      };
      waiters.add(settle);
      timer = setTimeout(
        () => settleAfterReceivedEvents(() => settled || this.#cleared || this.#hasEvidence(networkId), settle),
        waitMs,
      );
    });
  }

  /**
   * DEF-052（設計書 2.2）: `networkId` の要求の証拠がなかった理由（`awaitCancellation` が偽で終わった後に呼ぶ。`waitMs` はそこで使った待ちの
   * 時間）。上限のために覚えなかった ID なら `EVIDENCE_DROPPED_AT_CAPACITY`、session を閉じた後なら `SESSION_CLEARED`、待たなかったなら
   * `CLOSING_NOT_WAITED`、それ以外は `EVIDENCE_NOT_RECEIVED`。診断だけに使う。
   */
  missingEvidenceReason(networkId: string, waitMs: number, _now: number): CanceledDocumentEvidenceMissingReason {
    if (this.#droppedAtCapacity.has(networkId)) return CANCELED_DOCUMENT_EVIDENCE_MISSING_REASON.EVIDENCE_DROPPED_AT_CAPACITY;
    if (this.#cleared) return CANCELED_DOCUMENT_EVIDENCE_MISSING_REASON.SESSION_CLEARED;
    if (waitMs <= 0) return CANCELED_DOCUMENT_EVIDENCE_MISSING_REASON.CLOSING_NOT_WAITED;
    return CANCELED_DOCUMENT_EVIDENCE_MISSING_REASON.EVIDENCE_NOT_RECEIVED;
  }

  /** DEF-052（設計書 2.2）: この session で、上限のために覚えなかった証拠の数の累計。 */
  get droppedAtCapacityCount(): number {
    return this.#droppedAtCapacityCount;
  }

  /**
   * main frame の文書の要求を、Request か Response の段階で一時停止した（DEF-027。page の session の、main frame の事象だけ）。
   * - Request の段階: 記録を作る（同じ ID の記録があれば、リダイレクトの先の要求として上書きする）。リダイレクトの先の要求
   *   （`redirectedRequestId` を持つ）は、応答を受けたものとして記録する。`networkId` がない、method や URL が上限を超える、記録の数が上限に
   *   達している場合は、覚えない（その要求の取り消しは、違反のまま）。
   * - Response の段階: 応答を受けたことを記録する。
   */
  recordMainFramePaused(event: PausedDocumentEvent, _now: number): void {
    const networkId = typeof event.networkId === 'string' && event.networkId.length > 0 ? event.networkId : null;
    if (this.#cleared || networkId === null) {
      return;
    }
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
    // L10（INV-LIMITS の N22）: 記録の数の上限（前は `MAX_CANCELED_DOCUMENT_EVIDENCE` 256。超えた要求は覚えず、その取り消しを違反にした）は撤廃した。
    if (request === null) {
      return;
    }
    // L10（T29）: 記録は期限を持たない（使うか、読み込みを終えるか、session を閉じるまで持つ）。
    this.#mainFrameDocuments.set(networkId, {
      request,
      continued: false,
      responded: redirected,
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
    return this.#evidence.has(networkId);
  }

  /** DEF-052（設計書 2.2）: 上限のために覚えなかった証拠を数え、その ID を上限つきで覚える（覚えきれなければ数えるだけ）。 */
  #recordDroppedAtCapacity(requestId: string, _now: number): void {
    this.#droppedAtCapacityCount = saturatingIncrement(this.#droppedAtCapacityCount);
    if (this.#droppedAtCapacity.has(requestId) || this.#droppedAtCapacity.size < MAX_DROPPED_CANCELED_DOCUMENT_IDS) {
      this.#droppedAtCapacity.add(requestId);
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
  /**
   * SAFE-2 の 2（DEF-242）: 止めた要求に、204（No Content）で応える（サーバへは届けない。main frame の移動なら、今の文書が残る）。page の session の命令だけが
   * 持つ（ほかの session は省略）。
   */
  fulfillNoContent?(): Promise<void>;
}

/** SAFE-2 の 2（DEF-242）: 止めた main frame の移動への応え方を決めるための事実（`blockedMainFrameNavigationResponseOf` が読む）。 */
export interface BlockedMainFrameNavigationFacts {
  readonly phase: GuardPhase;
  /** 止めた文書の要求が、page の main frame の移動か。 */
  readonly mainFrame: boolean;
  /** BeakSight 自身の読み込み（`announceOwnMainFrameNavigation` で知らせた次の要求）か。 */
  readonly ownNavigation: boolean;
  /** 観察の口のある Context（操作さがし）の Guard か。 */
  readonly observing: boolean;
  /** REV-EV4: 横にスクロールする領域のキーの押下の期間に止めた移動か（省略は偽）。 */
  readonly scrollKeyPress?: boolean;
}

/** SAFE-2 の 2（DEF-242）: 止めた main frame の移動の応え方（`NO_CONTENT` は 204 で応えて今の文書を残す。`BLOCKED_BY_CLIENT` は今どおり失敗にする）。 */
export type BlockedMainFrameNavigationResponse = 'NO_CONTENT' | 'BLOCKED_BY_CLIENT';

/** 止めた main frame の移動に応える status（No Content。Chromium は移動をやめ、今の文書を残す）。 */
const NO_CONTENT_STATUS = 204;

/**
 * SAFE-2 の 2（DEF-242。設計者の判断）: 止めた main frame の移動への応え方（唯一の判定）。ページが始めた main frame の移動を、凍結の段（`FROZEN_ACTIVE`）で、観察の口の
 * ある Context（操作さがし）で止めたときだけ、204 で応えて今の文書を残す（誤りの画面に替わって候補を読めなくなるのを防ぐ）。ほか（監査の段・閉じる途中・子の frame・
 * BeakSight 自身の読み込み・Isolated Interaction Context）は、今どおり `ERR_BLOCKED_BY_CLIENT`（BN の遮断の結び付き・network の collector・load-meter・
 * site-availability の前提を変えない）。どちらでも、止めた記録（理由と URL）は今どおり残す。
 * REV-EV4: 監査の段の、横にスクロールする領域のキーの押下の期間に止めた、ページが始めた main frame の移動も、204 で応えて今の文書を残す（その画面の点検を続ける）。
 */
export function blockedMainFrameNavigationResponseOf(facts: BlockedMainFrameNavigationFacts): BlockedMainFrameNavigationResponse {
  if (facts.phase === 'PASSIVE_ACTIVE' && facts.mainFrame && !facts.ownNavigation && facts.scrollKeyPress === true) {
    return 'NO_CONTENT';
  }
  return facts.phase === 'FROZEN_ACTIVE' && facts.mainFrame && !facts.ownNavigation && facts.observing ? 'NO_CONTENT' : 'BLOCKED_BY_CLIENT';
}

/**
 * SREV-SAFE の I-1: 止めた main frame の移動の後に、ブラウザが出す失敗の文言（Guard が予期した失敗として登録する値）。204 で応えた移動は、Chromium が
 * `net::ERR_ABORTED` で終える（止めた記録は残すので、読み取りの失敗の記録にはしない）。ほかは `net::ERR_BLOCKED_BY_CLIENT`。
 */
export function blockedMainFrameNavigationFailureTextOf(response: BlockedMainFrameNavigationResponse): string {
  return response === 'NO_CONTENT' ? NAVIGATION_ABORTED_ERROR_TEXT : BLOCKED_BY_CLIENT_DOCUMENT_FAILURE_TEXT;
}

/** DEF-099 fix: 書き込みの段の承認の POST の、送り手の応答をブラウザに返す命令と、応答のない失敗を伝える命令（Request の段階の事象だけ）。 */
interface WriteSubmissionCommands {
  fulfillRequest(response: { readonly status: number; readonly headers: readonly { readonly name: string; readonly value: string }[]; readonly body: Buffer }):
    Promise<void>;
  failRequestAs(errorReason: string): Promise<void>;
}

/** DEF-099 fix: 送り手の結果ごとの、ブラウザに伝える失敗の理由（CDP の `Network.ErrorReason`）。 */
const WRITE_SUBMISSION_FAILURE_REASONS: Readonly<Record<Exclude<WriteSubmissionSendOutcome, 'RESPONDED'>, string>> = Object.freeze({
  NOT_WRITTEN: 'ConnectionFailed',
  NO_RESPONSE: 'ConnectionClosed',
});

/** DEF-099 fix: 書き込みの送信の送り手の指定として受け付けられるか（中継の待ち受けと、`Accept-Language`、テストだけの信頼の証明書）。 */
function acceptWriteSubmission(value: unknown): WriteSubmissionOptions {
  if (!isRecord(value) || !isRecord(value['proxy']) || typeof value['proxy']['host'] !== 'string' || !Number.isInteger(value['proxy']['port'])
    || (value['acceptLanguage'] !== null && typeof value['acceptLanguage'] !== 'string')) {
    throw new TypeError('Write stage requires a write submission sender with an egress proxy');
  }
  const certificates = value['additionalTrustedCertificates'];
  if (certificates !== undefined && (!Array.isArray(certificates) || !certificates.every((certificate) => typeof certificate === 'string'))) {
    throw new TypeError('Write submission trusted certificates must be strings');
  }
  const timeoutMs = value['timeoutMs'];
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new TypeError('Write submission timeout must be a positive number');
  }
  return Object.freeze({
    proxy: Object.freeze({ host: value['proxy']['host'] as string, port: value['proxy']['port'] as number }),
    acceptLanguage: value['acceptLanguage'] as string | null,
    ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }),
    ...(certificates === undefined ? {} : { additionalTrustedCertificates: Object.freeze([...(certificates as string[])]) }),
  });
}

/**
 * DEF-099 fix: 照合した承認の POST の本文の bytes（CDP の `postDataEntries` の base64 をつないだもの。照合と同じ値）。
 * CC-096 の B: この関数と `apiWriteBodyOf` は、本文の読み方を単体のテスト（`tests/unit/request-body.test.ts`）で固定するために公開する（状態を持たない
 * 純粋な関数。Guard のほかから使わない）。
 */
export const writeSubmissionBodyOf = (event: PausedDocumentEvent): Buffer =>
  decodeBase64BodyParts(event.request.postDataEntries ?? []);

/**
 * T39b: API の書き込みの照合に渡す、一時停止の要求の本文の bytes（`postDataEntries` を base64 で decode してつないだもの）。本文がない（`hasPostData`
 * が偽）、部品がない、bytes のない部品がある（Blob の本文など、読み切れない）なら null（照合は `BODY_UNAVAILABLE` で止める）。
 */
export const apiWriteBodyOf = (event: PausedDocumentEvent): Buffer | null => {
  const entries = event.request.postDataEntries;
  if (event.request.hasPostData !== true || entries === undefined || entries.length === 0
    || entries.some((entry) => typeof entry.bytes !== 'string')) {
    return null;
  }
  return decodeBase64BodyParts(entries);
};

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
 *   どれかを満たさなければ、失敗を投げる（呼び出し側が、今のとおり違反にする。fail-closed）。1 を満たさない失敗は、受けたものをそのまま
 *   投げる。1 を満たし、2 か 3 を満たさない失敗は、元の文言の後ろに、証拠がなかった理由の診断を付けた失敗にして投げる（DEF-052。設計書
 *   `2026-10-09-beaksight-def-052-guard-evidence-wait-design.md` 2.2。`canceledEvidenceDiagnosticMessage`）。
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
    const message = errorMessage(error);
    if (!isInvalidInterceptionIdFailure(message)) {
      throw error;
    }
    const failedAt = Date.now();
    if (networkId === null) {
      throw new Error(canceledEvidenceDiagnosticMessage(message, {
        reason: CANCELED_DOCUMENT_EVIDENCE_MISSING_REASON.NETWORK_ID_MISSING,
        waitedMs: 0,
        elapsedMs: 0,
        droppedAtCapacity: canceledDocuments.droppedAtCapacityCount,
      }));
    }
    const waitMs = closing() ? 0 : CANCELED_DOCUMENT_EVIDENCE_WAIT_MS;
    if (await canceledDocuments.awaitCancellation(networkId, waitMs)) {
      return;
    }
    const decidedAt = Date.now();
    throw new Error(canceledEvidenceDiagnosticMessage(message, {
      reason: canceledDocuments.missingEvidenceReason(networkId, waitMs, decidedAt),
      waitedMs: waitMs,
      elapsedMs: Math.max(0, decidedAt - failedAt),
      droppedAtCapacity: canceledDocuments.droppedAtCapacityCount,
    }));
  }
}

/** DEF-052（設計書 2.2）: 取り消しの証拠がなかった理由の診断の値（数と、閉じた一覧の語だけ。URL やページの文字は入れない）。 */
interface CanceledEvidenceDiagnostic {
  readonly reason: CanceledDocumentEvidenceMissingReason;
  /** 使った待ちの時間（ms。待たなかったなら 0）。 */
  readonly waitedMs: number;
  /** 命令の失敗を受けてから、違反にすると決めるまでに実際に経った時間（ms）。`waitedMs` との差が大きければ、Node の処理が止まっていた。 */
  readonly elapsedMs: number;
  /** その session で、上限のために覚えなかった証拠の数の累計。 */
  readonly droppedAtCapacity: number;
}

/**
 * DEF-052（設計書 2.2）: 違反の文。元の文言（`isInvalidInterceptionIdFailure` の閉じた一覧のどれか）を先頭にそのまま残し、その後ろに
 * `[canceled-document-evidence: reason=<理由>; waited-ms=<整数>; elapsed-ms=<整数>; dropped-at-capacity=<整数>]` を付ける。
 * LZ-2: 文は切り詰めないので、診断が欠けることはない。
 */
function canceledEvidenceDiagnosticMessage(original: string, diagnostic: CanceledEvidenceDiagnostic): string {
  return `${original} [${CANCELED_DOCUMENT_EVIDENCE_DIAGNOSTIC_LABEL}: reason=${diagnostic.reason}; waited-ms=${diagnostic.waitedMs}; `
    + `elapsed-ms=${diagnostic.elapsedMs}; dropped-at-capacity=${diagnostic.droppedAtCapacity}]`;
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

/**
 * DEF-225: ダウンロードの取り消し（`download.cancel()`）が、Context が消えたために失敗したときの文言の形（閉じた一覧。Playwright 1.64.1・CLI の Chromium で実際に
 * 起きた失敗から取った）。
 * - Playwright の client が Context を閉じたと知った後: `download.cancel: Target page, context or browser has been closed`。
 * - Chromium が Context を消した後で、client がまだ知らない間: `download.cancel: Protocol error (Browser.cancelDownload): Failed to find browser context for id <32 桁の 16 進>`。
 * どちらも文全体の一致で比べる（部分一致にしない。一覧にない文言は違反にする側に倒す）。
 * 根拠（2026-11-08 の実機。CLI の Chromium、`acceptDownloads: false` の Context、小さい本文と 1.3MB をゆっくり送る本文の各 3 回）: 取り消しを呼ばなくても、Chromium は
 * ダウンロードを始めた直後に自分で取り消し（CDP の `Page.downloadProgress` が `inProgress:0` の次に `canceled:0`）、Playwright の `download.failure()` は受け付けない
 * 設定の文を返し、`downloadsPath` にファイルはできなかった。Context を閉じた後の取り消しも同じで、ファイルはできなかった。
 */
const DOWNLOAD_CANCEL_CONTEXT_GONE_FAILURE_FORMS: readonly RegExp[] = Object.freeze([
  /^download\.cancel: Target page, context or browser has been closed$/u,
  /^download\.cancel: Protocol error \(Browser\.cancelDownload\): Failed to find browser context for id [0-9A-F]{32}$/u,
]);

/** DEF-225: 取り消しの失敗の文言が、Context が消えた形（`DOWNLOAD_CANCEL_CONTEXT_GONE_FAILURE_FORMS`）か。 */
function isDownloadCancelAfterContextGoneFailure(message: string): boolean {
  return DOWNLOAD_CANCEL_CONTEXT_GONE_FAILURE_FORMS.some((form) => form.test(message));
}

/** 命令の失敗の文言が、session か target が閉じた形（`CLOSED_TARGET_FAILURE_TEXTS` のどれか）と完全に一致するか。 */
function isClosedTargetFailure(message: string): boolean {
  return CLOSED_TARGET_FAILURE_TEXTS.has(message);
}

/**
 * CDPX: OOPIF の target が先に外れたために、その session への命令が失敗したときの文言の閉じた一覧（完全一致）。
 * - 親の session（Playwright の `CDPSession.send`）の `Target.sendMessageToTarget` が、もうない session に送ったときの文言（Playwright 1.64.1。
 *   両方の Chromium で、要求を止めている間に iframe が消えたときに実際に起きた失敗から取った）。
 * - Guard が `Target.detachedFromTarget` を受けて閉じた OOPIF の session への命令の文言（`OOPIF_SESSION_CLOSED_MESSAGE`）。
 */
const DETACHED_OOPIF_TARGET_FAILURE_TEXTS: ReadonlySet<string> = new Set([
  'cdpSession.send: Protocol error (Target.sendMessageToTarget): No session with given id',
  OOPIF_SESSION_CLOSED_MESSAGE,
]);

/**
 * CDPX: Guard が許した（ALLOW）要求を続ける命令を送り、失敗を扱う（Request の段階と Response の段階の、すべての `continueRequest` の失敗の判定の 1 か所）。
 * - Request の段階で、OOPIF の target が先に外れた失敗（`DETACHED_OOPIF_TARGET_FAILURE_TEXTS`）は、違反にせず数だけ記録する。target が外れると、Chromium は
 *   止めていた要求を、続けたのと同じに解き放つ（両方の Chromium で確かめた）。許した要求なので、届いても安全の決まりに反しない。
 * - ほかの失敗と、Response の段階の失敗は、今どおり違反にして Context を無効にする（fail-closed）。止める命令（`failRequest`）の失敗は、ここを通さない
 *   （外れると止めるはずの要求が解き放たれるので、違反のまま）。
 * - DEF-292 の残り: target が外れた失敗のとき、`onDetachedContinue` を呼ぶ（解き放たれた要求を、呼ぶ側が「通した」一覧に記録する）。
 */
async function continueAllowedRequest(
  continueRequest: () => Promise<void>,
  stage: 'REQUEST' | 'RESPONSE',
  context: BrowserContext,
  ledger: SafetyLedger,
  onDetachedContinue?: () => void,
): Promise<void> {
  try {
    await continueRequest();
  } catch (error) {
    const message = errorMessage(error);
    if (stage === 'REQUEST' && DETACHED_OOPIF_TARGET_FAILURE_TEXTS.has(message)) {
      ledger.recordDetachedTargetContinue();
      onDetachedContinue?.();
      return;
    }
    ledger.recordInvariantViolation({ code: 'CDP_CONTINUE_REQUEST_FAILED', message });
    initiateInvalidation(context, ledger);
  }
}

/** DEF-292 の残り: URL の fragment（`#` から後）を除いた形。 */
const withoutUrlFragment = (url: string): string => {
  const at = url.indexOf('#');
  return at < 0 ? url : url.slice(0, at);
};

/** DEF-292 の残り: route の層の記録を待つ要求（method と URL）。 */
interface AwaitedRouteRequest {
  readonly method: string;
  readonly url: string;
}

/** DEF-292 の残り: 記録待ちの行（命令を送る session と、その page と、要求）。 */
interface AwaitedRouteEntry {
  readonly owner: object;
  readonly page: object;
  readonly request: AwaitedRouteRequest;
}

/**
 * DEF-292 の残り: 監査の段の送信の扱いの口が通した、Network の要求の ID のある要求の「通した」の記録は、route の層が残す（ブラウザが送る時点）。CDP の層が続ける
 * 命令を送る前に、その要求を、命令を送る session（`owner`）ごとに「route の層の記録待ち」に置く。
 * - route の層は、要求を見たら（判定によらず）待ちの行を 1 つ外す（method と URL で対応付ける。`takeAtRoute`）。
 * - 続ける命令が失敗したら、呼ぶ側が行を外す（`withdraw`）。
 * - 続ける命令は届いたが、route の層に着く前に OOPIF の target が外れたら、その session の待ちの行を「通した」へ移す（`moveDetached`）。移した行は覚えておき、後から
 *   route の層に同じ要求が来ても、二重に記録しない（`takeAtRoute` が `MOVED` を返す）。
 * - session を閉じたら（target が外れたのでないとき）、その session の行は記録せずに捨てる（`discard`）。page を閉じたら、その page の行（移した行も）を
 *   捨てる（`discardPage`）。Context を閉じたら、すべて捨てる（`clear`）。
 * - REV-CP の Minor-1: route の層は、要求の frame の page（持ち主の page）の行だけを外す。Playwright の公開の口からは、要求の frame の CDP の session（OOPIF）を
 *   引けないので、同じ page の中では、最初に一致した行を外す。page を引けない要求は、どの page の行でも外す。
 * 単体テストが、page ごとに外すことと、閉じたら捨てることを確かめるために公開する（Guard の外では使わない）。
 */
export class AwaitedRouteAuditSends {
  readonly #awaiting: AwaitedRouteEntry[] = [];
  readonly #moved: { readonly page: object; readonly request: AwaitedRouteRequest }[] = [];

  /** 待ちに置き、その行を返す（`withdraw` に渡す）。 */
  add(owner: object, page: object, request: AwaitedRouteRequest): AwaitedRouteEntry {
    const entry = { owner, page, request };
    this.#awaiting.push(entry);
    return entry;
  }

  /** 置いた行を外す（続ける命令が失敗したとき）。まだ待ちにあった（route の層も、target の外れも、まだ外していない）なら真。 */
  withdraw(entry: AwaitedRouteEntry): boolean {
    const at = this.#awaiting.indexOf(entry);
    if (at < 0) return false;
    this.#awaiting.splice(at, 1);
    return true;
  }

  /**
   * route の層が見た要求の行を外す。待ちの行なら `AWAITING`、target が外れて移した行なら `MOVED`、どちらでもなければ `null`。URL は fragment を除いて比べる
   * （CDP の要求の URL は fragment を持たず、Playwright の文書の要求の URL は持つことがある）。
   */
  takeAtRoute(page: object | undefined, method: string, url: string): 'AWAITING' | 'MOVED' | null {
    const target = withoutUrlFragment(url);
    const same = (row: { readonly page: object; readonly request: AwaitedRouteRequest }): boolean =>
      (page === undefined || row.page === page) && row.request.method === method && withoutUrlFragment(row.request.url) === target;
    const awaiting = this.#awaiting.findIndex(same);
    if (awaiting >= 0) {
      this.#awaiting.splice(awaiting, 1);
      return 'AWAITING';
    }
    const moved = this.#moved.findIndex(same);
    if (moved >= 0) {
      this.#moved.splice(moved, 1);
      return 'MOVED';
    }
    return null;
  }

  /** target が外れた session の待ちの行を外して返す（呼ぶ側が「通した」に記録する）。 */
  moveDetached(owner: object): readonly AwaitedRouteRequest[] {
    const rows = this.#takeWhere((entry) => entry.owner === owner);
    this.#moved.push(...rows);
    return rows.map(({ request }) => request);
  }

  /** 閉じた session の待ちの行を、記録せずに捨てる。 */
  discard(owner: object): void {
    this.#takeWhere((entry) => entry.owner === owner);
  }

  /** 閉じた page の待ちの行と移した行を、記録せずに捨てる。 */
  discardPage(page: object): void {
    this.#takeWhere((entry) => entry.page === page);
    for (let at = this.#moved.length - 1; at >= 0; at -= 1) {
      if (this.#moved[at]?.page === page) this.#moved.splice(at, 1);
    }
  }

  /** Context を閉じたら、すべての行を捨てる。 */
  clear(): void {
    this.#awaiting.length = 0;
    this.#moved.length = 0;
  }

  #takeWhere(matches: (entry: AwaitedRouteEntry) => boolean): AwaitedRouteEntry[] {
    const taken: AwaitedRouteEntry[] = [];
    for (let at = this.#awaiting.length - 1; at >= 0; at -= 1) {
      const entry = this.#awaiting[at];
      if (entry !== undefined && matches(entry)) {
        taken.unshift(entry);
        this.#awaiting.splice(at, 1);
      }
    }
    return taken;
  }
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
  readonly #entries = new Set<string>();

  /** `Network.requestWillBeSent` を受けたとき。事前確認の要求なら、その `requestId` を覚える。 */
  record(event: unknown, _now: number): void {
    const { requestId, initiator } = (typeof event === 'object' && event !== null ? event : {}) as {
      readonly requestId?: unknown;
      readonly initiator?: { readonly type?: unknown };
    };
    if (typeof requestId !== 'string' || requestId.length === 0 || initiator?.type !== 'preflight') {
      return;
    }
    // L10（設計者の判断 E と INV-LIMITS の N22）: 覚える数の上限（前は `MAX_PREFLIGHT_INITIATORS` 256）と、時間で捨てる決まり（前は
    // `PREFLIGHT_INITIATOR_RETENTION_MS` 1 秒）は撤廃した。使うか、session を閉じる（`clear`）まで持つ。
    this.#entries.add(requestId);
  }

  /** `networkId` の要求が事前確認として覚えられているか。あれば、その記録を消して真を返す。 */
  take(networkId: string, _now: number): boolean {
    return this.#entries.delete(networkId);
  }

  clear(): void {
    this.#entries.clear();
  }
}

/**
 * T39b: ページのスクリプトが始めた要求の frame の記録を覚えておく時間（ms）と、件数の上限。`Network.requestWillBeSent` は、ふつう一時停止の通知の
 * 前に届く（T39b の実験で、両方の Chromium の main frame の fetch で確かめた）。
 */
const SCRIPT_INITIATOR_RETENTION_MS = 30_000;
const MAX_SCRIPT_INITIATORS = 256;
/**
 * T39b: API の書き込みの照合にかける要求の一時停止で、その要求の `Network.requestWillBeSent` がまだ届いていないときに待つ時間（ms）。届かなければ、main
 * frame のページのスクリプトの要求とみなさない（止まる。fail-closed）。Worker の要求は、page の session に `Network.requestWillBeSent` が届かない（実験）。
 */
const SCRIPT_INITIATOR_WAIT_MS = 1_000;

/**
 * T39b（Task 39 の設計書 3.3）: 同じ session の `Network.requestWillBeSent` で、開始の種類（`initiator.type`）が `script` だった要求の frame の記録。
 * API の書き込みの段で、照合にかける要求が、page の main frame のページのスクリプトの要求か（Worker・iframe・ブラウザの送信でないか）を決めるのに使う。
 * page の session の Fetch は、Worker の要求も main frame の frame の ID で一時停止するが、その `Network.requestWillBeSent` は Worker の target に届き、
 * page の session には届かない（T39b の実験。両方の Chromium）。
 */
class ScriptInitiatorRegistry {
  /**
   * 要求の ID → 始めた frame。L10（設計者の判断 D・E と INV-LIMITS の N22）: 覚える数の上限（前は `MAX_SCRIPT_INITIATORS` 256。超えた要求は覚えず、確かめられ
   * ない要求として止めた）と、時間で捨てる決まり（前は `SCRIPT_INITIATOR_RETENTION_MS` 30 秒）は撤廃した。使うか、session を閉じる（`clear`）まで持つ。発信元を
   * 確かめられない書き込みを止める決まり（S7）は今のまま。
   */
  readonly #entries = new Map<string, string>();
  readonly #waiters = new Map<string, Set<() => void>>();

  /** `Network.requestWillBeSent` を受けたとき。スクリプトが始めた要求なら、その `requestId` と frame を覚える。 */
  record(event: unknown, _now: number): void {
    const { requestId, frameId, initiator } = (typeof event === 'object' && event !== null ? event : {}) as {
      readonly requestId?: unknown;
      readonly frameId?: unknown;
      readonly initiator?: { readonly type?: unknown };
    };
    if (typeof requestId !== 'string' || requestId.length === 0 || typeof frameId !== 'string' || initiator?.type !== 'script') {
      return;
    }
    this.#entries.set(requestId, frameId);
    const waiters = this.#waiters.get(requestId);
    if (waiters !== undefined) {
      this.#waiters.delete(requestId);
      for (const wake of waiters) wake();
    }
  }

  /** `networkId` の要求を始めた frame（スクリプトの要求の記録がなければ、`waitMs` まで待ち、なお無ければ null）。記録は使ったら消す。 */
  async frameOf(networkId: string, waitMs: number): Promise<string | null> {
    if (!this.#entries.has(networkId)) {
      await new Promise<void>((resolve) => {
        const waiters = this.#waiters.get(networkId) ?? new Set<() => void>();
        this.#waiters.set(networkId, waiters);
        const wake = (): void => {
          clearTimeout(timer);
          waiters.delete(wake);
          if (waiters.size === 0 && this.#waiters.get(networkId) === waiters) this.#waiters.delete(networkId);
          resolve();
        };
        const timer = setTimeout(wake, waitMs);
        waiters.add(wake);
      });
    }
    const frameId = this.#entries.get(networkId);
    this.#entries.delete(networkId);
    return frameId ?? null;
  }

  clear(): void {
    this.#entries.clear();
    for (const waiters of this.#waiters.values()) {
      for (const wake of waiters) wake();
    }
    this.#waiters.clear();
  }
}

/** T36R-fix: http(s) の URL の文字列か（Cookie を読む要求か。解析できない URL は違う）。 */
function isHttpUrlText(url: string): boolean {
  try {
    return isHttpProtocol(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** CORS の事前確認の要求が持つヘッダの名前。 */
const ACCESS_CONTROL_REQUEST_METHOD_HEADER = 'Access-Control-Request-Method';
/** T30b: 書き込みの段の送る中身の照合に渡す、要求の本文の種類のヘッダの名前。 */
const CONTENT_TYPE_REQUEST_HEADER = 'Content-Type';
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
    { name: 'Access-Control-Allow-Origin', value: headerValueOf(headers, 'Origin') ?? '*' },
    { name: 'Access-Control-Allow-Methods', value: headerValueOf(headers, ACCESS_CONTROL_REQUEST_METHOD_HEADER) ?? PREFLIGHT_DEFAULT_ALLOW_METHODS },
    { name: 'Access-Control-Allow-Credentials', value: 'true' },
  ];
  const requestedHeaders = headerValueOf(headers, ACCESS_CONTROL_REQUEST_HEADERS_HEADER);
  if (requestedHeaders !== undefined) {
    responseHeaders.push({ name: 'Access-Control-Allow-Headers', value: requestedHeaders });
  }
  return responseHeaders;
}

/** AS-c fix round 1（I-1）: サーバの事前確認の応答のうち、ブラウザに返すヘッダの名前の始まり（CORS のヘッダだけ。小文字で比べる）。 */
const CORS_RESPONSE_HEADER_PREFIX = 'access-control-';

/**
 * AS-c fix round 1（I-1）: サーバの事前確認の応答のヘッダのうち、ブラウザの事前確認に返すもの（`Access-Control-*` だけ。`Set-Cookie` などは返さない）。
 */
function corsResponseHeadersOf(headers: readonly { readonly name: string; readonly value: string }[]): readonly { readonly name: string; readonly value: string }[] {
  return headers.filter(({ name }) => name.toLowerCase().startsWith(CORS_RESPONSE_HEADER_PREFIX));
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

/**
 * AS-c の WebSocket の Blocker の判断 W1（設計書 `2026-10-19-beaksight-audit-send-policy-design.md` 5 章）: 監査の段の送信の扱い `PASS_EXCEPT_DELETE` の Passive の
 * Context だけに当てる policy（`WORKER_CONNECT_POLICY` に `ws:`・`wss:` を足したもの）。ページ（文書）の WebSocket は、Guard の `routeWebSocket` が判定・記録・
 * 上限を当ててからつなぐ（`connectToServer` はページの中で本物の WebSocket を作るので、文書の policy が `ws:`・`wss:` を許す必要がある）。http(s) の script の
 * Worker の応答のヘッダも、同じ policy にそろえる。限界: Worker（blob・data の Worker と、http(s) の script の Worker）の WebSocket は、Guard の route を通らず、
 * 記録されずに通る（ユーザーの方針「ページが自分で出す送信は問題ない」により受け入れた）。凍結の後に押しうる Context（Interaction と操作さがしの PRIMARY）は
 * `WORKER_CONNECT_POLICY` のまま（RB-4 fix。DEF-276 で、凍結の後に押さない PRIMARY を除いた）。
 */
export const AUDIT_SEND_CONNECT_POLICY = 'connect-src http: https: data: blob: ws: wss:';

/** 応答に加える CSP のヘッダの名前（meta の `http-equiv` も同じ名前）。 */
const CONTENT_SECURITY_POLICY_HEADER = 'Content-Security-Policy';

/**
 * 文書の始まりに meta の CSP（`policy`。既定は `WORKER_CONNECT_POLICY`、AS-c の `PASS_EXCEPT_DELETE` は `AUDIT_SEND_CONNECT_POLICY`）を入れてすぐ外す、Context の
 * 初期化のスクリプトを作る（DEF-040。設計書 2.2）。
 * meta の CSP は head の中でだけ効くので、head がまだなければ（HTML の解析の前に動くとき）、head ができるのを MutationObserver で待つ。
 * HTML の解析は、script を実行する前に microtask の checkpoint を行うので、ページの最初の script より前に policy が効く。
 */
export const connectPolicyInitScriptOf = (policy: string): string => `(() => {
  const enforce = () => {
    const meta = document.createElement('meta');
    meta.httpEquiv = ${JSON.stringify(CONTENT_SECURITY_POLICY_HEADER)};
    meta.content = ${JSON.stringify(policy)};
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

/** 既定の policy（`WORKER_CONNECT_POLICY`）の初期化のスクリプト（AS-c で `connectPolicyInitScriptOf` から作るようにした。中身は前と同じ）。 */
export const WORKER_CONNECT_POLICY_INIT_SCRIPT = connectPolicyInitScriptOf(WORKER_CONNECT_POLICY);

/**
 * Service Worker の登録の入口を塞ぐ、Context の初期化のスクリプト（DEF-049 の主な防御）。登録された Service Worker の中の要求は、Guard の
 * route も CDP の横取りも通らないので、文書ごとに次を行う。
 * - `ServiceWorkerContainer.prototype.register` を、`DOMException`（名前 `SERVICE_WORKER_REGISTRATION_BLOCKED_ERROR_NAME`）で拒否する Promise を
 *   返す関数に置き換え、`writable: false`・`configurable: false` で固定する（ページは定義し直せない）。名前と文言は `src/core/guard-page-exceptions.ts`
 *   の 1 か所（T44R2 の I-4。PAGE_ERROR の Rule が、守りの例外を見分けるのにも使う）。T44R2 の M-2: 形は、Chromium（CLI の起動の chrome.exe 156）が
 *   自分で登録を断るとき（クッキーを止めたプロファイル。実機で確かめた）の形 `NotSupportedError: Failed to register a ServiceWorker for scope
 *   ('<scope>') with script ('<script>'): The user denied permission to use Service Worker.` に寄せる。script は、第 1 引数を文書の base の URL で
 *   解決した URL、scope は、第 2 引数の `scope` があればそれを同じく解決した URL、なければ script の URL のディレクトリ（Chromium の既定と同じ）。
 *   解決できなければ空にする（引数の誤りの `TypeError` の形には寄せていない。T44R2 の M-2 の残り）。解決のときにページの値の `toString` などが
 *   動くことがあるが、どの場合も拒否するだけで、登録には進まない。
 * - `Navigator.prototype.serviceWorker` の getter を、元の getter のまま `configurable: false` にする（同じ Container を返し続ける）。
 * UPG-SW: Playwright 1.64.1 の `serviceWorkers: 'block'` は、インスタンスではなく `ServiceWorkerContainer.prototype.register` を置き換える
 * （microsoft/playwright の PR #43134。1.62.1 まではインスタンスの `register` だけだったので、`prototype.register.call` や `delete` の後の呼び出しで
 * 迂回できた）。このスクリプトは、その後に原型を固定するので、ページの通常の呼び出しも迂回も、すべてここに届く。関数は同期で投げずに、拒否する
 * Promise を返す（Service Worker を使えないブラウザで、ページがふつうに受ける形。同期で投げると、ページのスクリプトの残りが止まり、捕捉されない
 * 例外にもなる。ページの自然な動きを止めないため）。引数の数は、元の関数と同じ 1 つにする。拒否に使う `Promise.reject`・`DOMException`・`URL`・
 * `String` と、`Node.prototype.baseURI` の getter は、ページのスクリプトより前に、この realm のものを取っておく（`document.baseURI` は、DOM clobbering
 * で隠されうるので、getter を直に呼ぶ）。Context の初期化のスクリプトは、すべての frame（同じ Origin の iframe、
 * about:blank・srcdoc の iframe、ポップアップ）の文書に付く（NP6 の実験で、すべての経路が止まることを確かめた）。それでも登録された場合は、
 * factory の自己検査（`SERVICE_WORKER_OBSERVED`）が Context を閉じる。
 */
export const SERVICE_WORKER_REGISTRATION_BLOCK_INIT_SCRIPT = `(() => {
  const Container = globalThis.ServiceWorkerContainer;
  if (typeof Container === 'function') {
    const DOMExceptionConstructor = globalThis.DOMException;
    const URLConstructor = globalThis.URL;
    const StringConstructor = globalThis.String;
    const reject = globalThis.Promise.reject.bind(globalThis.Promise);
    const baseURIDescriptor = typeof globalThis.Node === 'function'
      ? Object.getOwnPropertyDescriptor(globalThis.Node.prototype, 'baseURI')
      : undefined;
    const baseURIGetter = baseURIDescriptor === undefined ? undefined : baseURIDescriptor.get;
    const documentObject = globalThis.document;
    const resolve = (value, base) => {
      try {
        return new URLConstructor(StringConstructor(value), base).href;
      } catch {
        return '';
      }
    };
    const register = function register(scriptURL) {
      const options = arguments.length > 1 ? arguments[1] : undefined;
      let base;
      try {
        base = baseURIGetter === undefined ? undefined : baseURIGetter.call(documentObject);
      } catch {
        base = undefined;
      }
      const script = resolve(scriptURL, base);
      let scope = '';
      try {
        const requestedScope = options !== undefined && options !== null ? options.scope : undefined;
        scope = requestedScope !== undefined ? resolve(requestedScope, base) : (script === '' ? '' : resolve('./', script));
      } catch {
        scope = '';
      }
      return reject(new DOMExceptionConstructor(
        ${JSON.stringify(SERVICE_WORKER_REGISTRATION_BLOCKED_MESSAGE_PARTS.beforeScope)} + scope
          + ${JSON.stringify(SERVICE_WORKER_REGISTRATION_BLOCKED_MESSAGE_PARTS.beforeScript)} + script
          + ${JSON.stringify(SERVICE_WORKER_REGISTRATION_BLOCKED_MESSAGE_PARTS.end)},
        ${JSON.stringify(SERVICE_WORKER_REGISTRATION_BLOCKED_ERROR_NAME)},
      ));
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

/**
 * 塞ぐ WebRTC の入口（文書の大域の名前）の閉じた一覧（DEF-124）。`webkitRTCPeerConnection` は、Chromium では `RTCPeerConnection` と同じ関数。
 * ほかの入口は、Chromium 151（Playwright 1.62.1）で、両方の Chromium で確かめて、塞がなくてよいとした（DEF-124-fix の実験）:
 * `RTCIceTransport`・`RTCDataChannel` はページから作れない（Illegal constructor）。`RTCPeerConnection` は Worker の中にない（`undefined`）。
 * Direct Sockets（`UDPSocket`・`TCPSocket`）は文書にない。`WebTransport`（QUIC の UDP）は、出口の中継を付けた Context では、文書からも Worker
 * からも UDP の受け口に何も届かなかった（中継の設定のためと推測。Chromium の資料では確かめていない）。
 */
export const WEBRTC_BLOCKED_GLOBAL_NAMES = Object.freeze(['RTCPeerConnection', 'webkitRTCPeerConnection'] as const);

/**
 * WebRTC の入口を塞ぐ、Context の初期化のスクリプト（DEF-124 の主な防御。Service Worker の `SERVICE_WORKER_REGISTRATION_BLOCK_INIT_SCRIPT` と
 * 同じ形）。WebRTC の通信（STUN・TURN の UDP、ICE の接続の確かめ、TURN の TCP・TLS）は、Guard の route も CDP の横取りも通らない（UDP は出口の
 * 中継も通らず、TCP は中継の CONNECT を通るが中身は見えない）。TURN の `username` も、そのままの形でサーバに届く。そこで、文書ごとに、
 * `WEBRTC_BLOCKED_GLOBAL_NAMES` の大域の名前を、`WEBRTC_BLOCKED_MESSAGE` の例外（`DOMException` の `WEBRTC_BLOCKED_ERROR_NAME`。構築子が投げる、
 * ブラウザのふつうの形。名前と文言は `src/core/guard-page-exceptions.ts` の 1 か所で、道具の名前を含まない。`DOMException` は、ページのスクリプトより
 * 前に、この realm のものを取っておく）を投げる関数に置き換え、`writable: false`・`configurable: false` で
 * 固定する（ページは `delete` も定義し直しもできない。`RTCPeerConnection.prototype.constructor` も置き換えた関数になる）。元の関数は、ページから
 * 届く所に残らない。Context の初期化のスクリプトは、すべての frame（同じ Origin・別の Origin の iframe、about:blank・srcdoc・data・blob の
 * iframe、`document.write` で書き直した文書、SVG の文書、ポップアップ）の文書に付く（DEF-124-fix の実験で、別の realm から借りる経路を含めて
 * すべて止まることを確かめた）。WebRTC が使われたことを factory が知る CDP の事象はないので、自己検査はない。RB-4b: 付けるのは、凍結しうる Context だけ。
 */
export const WEBRTC_BLOCK_INIT_SCRIPT = `(() => {
  const DOMExceptionConstructor = globalThis.DOMException;
  const blocked = function RTCPeerConnection() {
    throw new DOMExceptionConstructor(${JSON.stringify(WEBRTC_BLOCKED_MESSAGE)}, ${JSON.stringify(WEBRTC_BLOCKED_ERROR_NAME)});
  };
  for (const name of ${JSON.stringify(WEBRTC_BLOCKED_GLOBAL_NAMES)}) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    if (descriptor === undefined) {
      continue;
    }
    Object.defineProperty(globalThis, name, {
      value: blocked,
      writable: false,
      enumerable: descriptor.enumerable,
      configurable: false,
    });
  }
})();`;

/** `Fetch.continueResponse` に渡す応答の文言が、ブラウザからも Node の一覧（`STATUS_CODES`）からも取れないときの値。 */
const DEFAULT_RESPONSE_PHRASE = 'OK';

/**
 * `Fetch.continueResponse` に渡す、`Other` の応答に CSP のヘッダ（`policy`。その Context の policy。既定は `WORKER_CONNECT_POLICY`）を加えた指定（DEF-040。
 * 設計書 2.2。AS-c で policy を引数にした）。
 * - status のある応答: `responseCode`・`responsePhrase`・`responseHeaders`（元のヘッダ + CSP）の 3 つを必ず渡す。`responseHeaders` だけを
 *   渡すと Chromium が受け付けず、要求が一時停止のまま残る（NP2 で固まった原因）。文言は、ブラウザの `responseStatusText`、なければ
 *   Node の `STATUS_CODES`、それもなければ `DEFAULT_RESPONSE_PHRASE`。
 * - status のない応答（ネットワークの失敗。`responseErrorReason`）: 本文がなく Worker は動かないので、何も変えずに続ける（`requestId` だけ）。
 */
function workerConnectPolicyResponse(event: PausedDocumentEvent, policy: string): {
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
      { name: CONTENT_SECURITY_POLICY_HEADER, value: policy },
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

/**
 * 閉じるときに、Guard の作業が終わるのを待つ。L10（設計書 `2026-11-09-beaksight-remove-limits-design.md` 4。INV-LIMITS の T30 と設計者の判断 E）: 待ちの期限
 * （前は `GUARD_PENDING_TASK_DRAIN_TIMEOUT_MS` 1 秒）は置かず、L0 の見張り（`watchProgress`）で終える。作業が 1 つ終わるたびに進みの印を付け、作業が終わらない
 * まま反応なしの長さ（`PROGRESS_WATCH_QUIET_LIMIT_MS`）が過ぎたら、今どおり「状態が分からない」の違反（`GUARD_PENDING_TASK_DRAIN_TIMEOUT`）にする。
 */
async function drainGuardTasks(
  guardState: GuardState,
  onDrained: () => void,
): Promise<'DRAINED' | 'TIMED_OUT'> {
  const outcome = await watchProgress(async (signals) => {
    const stopped = new Promise<void>((resolveStopped) => {
      if (signals.signal.aborted) resolveStopped();
      else signals.signal.addEventListener('abort', () => resolveStopped(), { once: true });
    });
    for (;;) {
      if (signals.signal.aborted) return false;
      if (guardState.pendingTasks.size === 0) {
        // 終端状態への遷移と、最終的な空集合の観測は1つの同期境界を成す。
        // その間にプロトコルコールバックが割り込むことはできない。
        onDrained();
        return true;
      }
      const stableTasks = Array.from(guardState.pendingTasks);
      for (const task of stableTasks) {
        void task.then(() => signals.mark('BROWSER_RESPONSE'), () => signals.mark('BROWSER_RESPONSE'));
      }
      await Promise.race([Promise.allSettled(stableTasks), stopped]);
    }
  }, { quietLimitMs: guardState.drainQuietLimitMs });
  if (outcome.status === 'FULFILLED' && outcome.value) {
    return 'DRAINED';
  }
  recordGuardTaskDrainTimeoutOnce(guardState);
  return 'TIMED_OUT';
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

/**
 * AS-c fix round 1（I-2）: Playwright の要求（route の層と `requestfailed`）の送る中身（ヘッダと本文）。method の上書きの判定（`classifyPassiveRequest`）に
 * 渡す。ヘッダが読めなければ、ヘッダなしと同じ（本文の判定は、form の `Content-Type` がないので働かない。CDP の層が先に同じ判定をする）。
 */
function requestSentContentOf(request: Request): RequestSentContent {
  let headers: Readonly<Record<string, string>> | undefined;
  try {
    headers = request.headers();
  } catch {
    headers = undefined;
  }
  return { headers, formMethodOverrides: () => formMethodOverrideValuesOf(headers, () => requestBodyTextOfBuffer(request.postDataBuffer())) };
}

/**
 * Playwright の要求が main frame の移動か（ナビゲーションでなければ偽）。frame を引けなければ `undefined` を返し、`onFailure` を呼ぶ。SAFE-2 の 4（違反の区分の (3)）:
 * 前は違反 `FRAME_CLASSIFICATION_FAILED` を記録したが、今は呼ぶ側が frame の判定の失敗の記録（`frameClassificationFailures`）に残す（違反にしない）。
 */
function classifyMainFrame(request: Request, onFailure: () => void): boolean | undefined {
  if (!request.isNavigationRequest()) {
    return false;
  }
  try {
    return request.frame().parentFrame() === null;
  } catch {
    onFailure();
    return undefined;
  }
}

/**
 * 出口の中継の凍結の口（DEF-085）を、理由 `cause` で呼ぶ。口がなければ何もしない。口の例外は違反 `GUARD_EGRESS_FREEZE_FAILED` に記録し、投げない
 * （Guard の処理を続ける。閉じる処理では、閉じることが fail-closed の側である）。close の試みのたびと、凍結の段に入ったときに呼ぶ（口は何度呼ばれて
 * もよい）。
 */
function freezeEgress(guardState: GuardState, cause: EgressFreezeCause): void {
  // DEF-276-relay: 中継している文書の WebSocket を先に切る（凍結の後と閉じる途中に、ページの送りをサーバへ渡さない。中継のトンネルも凍結で切れる）。
  for (const cut of [...guardState.webSocketRelayCuts]) cut();
  guardState.webSocketRelayCuts.clear();
  if (guardState.egressFreeze === undefined) return;
  try {
    guardState.egressFreeze(cause);
  } catch (error) {
    guardState.ledger.recordInvariantViolation({ code: 'GUARD_EGRESS_FREEZE_FAILED', message: errorMessage(error) });
  }
}

/**
 * DEF-110 fix: Context の close が reject されたときに、その Context がもう存在しないことを、文言に頼らずに確かめられたか（Guard の close の
 * 経路のすべて（持ち主の close と無効化。Passive、Interaction、ログインの段、書き込みの段の Context）の判定は、ここだけで行う）。
 * - 証しは、Guard がその Context の `close` の事象を見たこと（`contextCloseObserved`）。Playwright の `close()` 自身が、成功を返す前に待つ事象と
 *   同じで、Browser が切れたときにも、その Browser のすべての Context に出る。ほかの Context の事象は数えない。
 * - reject の文言（Chromium の版で変わり、後ろに Browser のログが付く）では判定しない。
 * - 確かめられなければ偽（今のまま違反にする。fail-closed）。
 */
function isGuardedContextGone(guardState: GuardState): boolean {
  return guardState.contextCloseObserved;
}

function ensureCloseAttempt(
  guardState: GuardState,
  source: CloseAttemptSource,
): Promise<CloseAttemptResult> {
  if (guardState.phase === 'CLOSED') {
    return Promise.resolve(Object.freeze({ invalidated: true }));
  }
  if (guardState.closeAttempt !== undefined) return guardState.closeAttempt;

  // DEF-085: Context を閉じ始める前に（同じ同期の区間で）、出口の中継を凍結する。破棄の途中に始まったポップアップの最初の
  // ナビゲーションは、Guard の横取りを外れて出ることがあるので、凍結した中継が拒む。
  freezeEgress(guardState, 'CONTEXT_CLOSE');
  // DEF-099 fix round 1: 書き込みの段の送信中の送り手を止める（書いた後なら `NO_RESPONSE`。時間の上限まで待たない）。
  guardState.abortWriteSubmission?.();

  // 最初のraw-closeの副作用より前に公開し、同期的なコールバックが確実に合流できるようにする。
  let begin!: () => void;
  const start = new Promise<void>((resolve) => { begin = resolve; });
  const attempt = (async (): Promise<CloseAttemptResult> => {
    await start;
    if (!guardState.rawCloseConfirmed) {
      try {
        await guardState.context.close();
      } catch (error) {
        // DEF-110 fix: 期限で見捨てた close が、Browser を閉じた後に reject された場合など、Context がもう存在しないことを確かめられた
        // ときだけ、閉じたとみなす（違反にしない）。確かめられなければ、今のまま違反にする。
        if (!isGuardedContextGone(guardState)) {
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
      guardState.rawCloseConfirmed = true;
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

/**
 * Guard の作業の種類（DEF-042 の設計書 2.4）。`REQUEST` は要求の横取りの作業（`handlePausedRequest`）、`GENERAL` はそれ以外の作業。L10: 数の上限は撤廃した
 * （SPEC-1 で受ける・受けないの口も消した。作業はいつも受ける）。`REQUEST` の作業の数（`pendingRequestTaskCount`）は、今どおり数える。
 */
type GuardTaskKind = 'GENERAL' | 'REQUEST';

function trackGuardTask(
  guardState: GuardState,
  _purpose: string,
  rejectionCode: string,
  factory: () => Promise<unknown>,
  kind: GuardTaskKind = 'GENERAL',
): boolean {
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

/**
 * CC-050（Task 32 の設計書 4.4）: 要求を見た Guard の層。
 * - `CDP_REQUEST`: Guard の CDP の session の、Document でない要求の Request の段階（`handlePausedRequest`）。
 * - `CDP_DOCUMENT`: Guard の CDP の session の、Document の要求の Request の段階（`onRequestPaused` の Document の分岐）。
 * - `ROUTE`: Context の `route('**\/*')`（`installPassiveRequestGuard` の route の処理）。
 */
export type GuardRequestLayer = 'CDP_REQUEST' | 'CDP_DOCUMENT' | 'ROUTE';

/** 段階が `PASSIVE_ACTIVE` で、Guard の判定（`classifyPassiveRequest`）と層ごとの準備をした結果（`decideGuardRequest` の `evaluate`）。 */
export type GuardPolicyOutcome =
  /** 判定の結果。 */
  | { readonly kind: 'DECISION'; readonly decision: PassiveRequestDecision }
  /** CORS の事前確認（`CDP_REQUEST` だけ）。Guard が 204 で満たし、記録しない。 */
  | { readonly kind: 'PREFLIGHT' }
  /** 層の準備（リダイレクトの対応付けの登録、frame の判定）が失敗した。記録は準備の側が済ませた。止めて Context を無効にする。 */
  | { readonly kind: 'UNAVAILABLE' };

/** 要求の method と URL（`decideGuardRequest` の入力と結果）。 */
export interface GuardRequestIdentity {
  readonly method: string;
  readonly url: string;
}

/** `decideGuardRequest` の入力。 */
export interface GuardRequestInput {
  readonly layer: GuardRequestLayer;
  readonly phase: GuardPhase;
  /** 持ち主が閉じ始めた page（`ownerClosingPages`）の要求か。CDP の層だけが見る（route は今までどおり見ないので、偽を渡す）。 */
  readonly ownerClosingPage: boolean;
  /** 要求の method と URL。CDP の層で取り出せなかった場合は `null`。 */
  readonly request: GuardRequestIdentity | null;
  /** 凍結の段の記録で、ナビゲーションの記録（`blockedInteractionNavigations`）も残すか。 */
  readonly navigation: boolean;
  /**
   * DEF-113: Guard が CDP の session を付けた印（準備のできた page の記録 `pageGuards` の `READY`）のない page の、ナビゲーションの要求なら、
   * その違反の文。そうでなければ `null`。route の層だけが渡す（CDP の層の要求は、印のある page のものである）。
   */
  readonly unguardedPageNavigation: string | null;
  /** 段階が `PASSIVE_ACTIVE` で、要求の事実がそろい、CDP の付いた page の要求のときだけ、その要求で 1 回だけ呼ぶ（判定と層ごとの準備）。 */
  readonly evaluate: (request: GuardRequestIdentity) => GuardPolicyOutcome;
  /**
   * T37b（Task 37 の設計書 3.2 の「Guard の観察の形」）: 送らずに観察する probe の口が有効の間に、凍結の段の CORS の事前確認を Guard が満たしてよいか
   * （承認した API の Origin への事前確認か）。CDP の要求の層だけが、口のある Guard で渡す。段階が `FROZEN_ACTIVE` で、持ち主が閉じ始めた page でなく、
   * 要求の事実があるときだけ、その要求で 1 回だけ呼ぶ。省略（口がない）と偽は、今どおり凍結の段で止める。
   */
  readonly frozenPreflight?: ((request: GuardRequestIdentity) => boolean) | undefined;
  /**
   * DEF-208-1（設計書 `2026-11-05-beaksight-discovery-coverage-design.md` 3.1 と設計者の判断）: 凍結の段で、この要求を監査の段と同じ判定（`evaluate`）にかけて
   * よいか（凍結の読み取りの判定 `isFrozenReadAdmissible`）。観察の口のある Guard（操作さがしの PRIMARY の Passive の Context）の 3 つの層が渡す。段階が
   * `FROZEN_ACTIVE` で、持ち主が閉じ始めた page でなく、要求の事実があり、事前確認でないときだけ、その要求で 1 回だけ呼ぶ。真なら `evaluate` の判定に従い、
   * ALLOW なら通す（`frozenRead` の印つきの `ALLOW`。上限の口も今どおり当てる）。偽と省略、判定が止めるものは、今どおり凍結で止める。
   */
  readonly frozenRead?: ((request: GuardRequestIdentity) => boolean) | undefined;
  /**
   * DEF-129（ページ自身の読み込み直しの上限）: この要求が、ページが始めた文書の読み込みで、その frame の数が上限（`PAGE_INITIATED_NAVIGATION_LIMIT_PER_FRAME`）
   * の中か（数える）。CDP の文書の層だけが、Passive の段（ログインの段と書き込みの段でない）の文書の要求（リダイレクトの続きでない。main frame と、
   * T37R2-fix で子の frame）で渡す。
   * 段階が `PASSIVE_ACTIVE` で、要求の事実があり、持ち主が閉じ始めた page でなく、判定が通す（ALLOW）ときだけ、判定の後に 1 回だけ呼ぶ（判定が止める
   * 読み込みは数えない）。偽なら、上限で止める（`PAGE_NAVIGATION_LIMIT_REACHED`）。省略は、今どおり数えない。T44R の I-1: ページを離れた後は、判定
   * （`PAGE_LEAVE_REQUEST_LIMIT_REACHED`）を返し、その判定で止める。
   */
  readonly admitPageNavigation?: (() => PageLimitAdmission) | undefined;
  // DEF-130-fix の文書でない要求の数の上限の口（`admitSubresourceRequest`）は、L10 で上限を撤廃した後はいつも通したので、SPEC-1 で消した。
}

// DEF-129 の、frame ごとのページが始めた文書の読み込みの回数の上限（前は 2 回）は、L10（S4）で撤廃した（同じ移りのくり返しで止める。
// `admitFrameNavigationTransition`）。SPEC-1 で名前も消した。

// DEF-130-fix の 1 画面の読み込みあたりの、ページが出す文書でない要求の数の上限（前は 1,000。超えたら `PAGE_SUBRESOURCE_LIMIT_REACHED`）は、L10（S5）で
// 撤廃した（数えるだけ）。定数は LZ-1 で消した。

// T44R の I-1 の、ページを離れ始めた後の文書でない要求の数の上限（前は 1 回の離れ方あたり 30。超えたら `PAGE_LEAVE_REQUEST_LIMIT_REACHED`）は、L10（S6）で
// 撤廃した。定数は LZ-1 で消した。

/**
 * L10 の S4（設計者の判断。2026-11-12）: 1 つの frame の、この読み込み（数え始め）の後の移りの記録。輪の判定（`admitFrameNavigationTransition`）だけが書く。
 */
export interface FrameNavigationRecord {
  /** 今の文書の URL（fragment を外した形。数え始めの文書か、最後に通したページが始めた読み込み）。 */
  current: string;
  /** 通した移り（前の URL → 次の URL の組）。 */
  readonly transitions: Set<string>;
}

/** L10 の S4: 数え始めの文書の URL から、移りの記録を作る。 */
export const startFrameNavigationRecord = (url: string): FrameNavigationRecord => ({ current: frameDocumentKeyOf(url), transitions: new Set() });

/** L10 の S4: 記録を、数え始めの文書の URL から数え直す（同じ記録の物を使い続ける main frame の口）。 */
const restartFrameNavigationRecord = (record: FrameNavigationRecord, url: string): void => {
  record.current = frameDocumentKeyOf(url);
  record.transitions.clear();
};

/**
 * L10 の S4（設計者の判断。2026-11-12）: ページが始めた読み込みの輪の判定（Guard のただ 1 か所）。同じ移り（前の URL → 次の URL の組）が、この読み込みの中で
 * 2 回目に出たら輪とみなして偽（止める）。1 回目の自分への読み込み直し（A→A）や A→B→A は通す。回数の上限ではなく、同じ移りのくり返しという事実で決める。
 */
export function admitFrameNavigationTransition(record: FrameNavigationRecord, url: string): boolean {
  const next = frameDocumentKeyOf(url);
  const transition = JSON.stringify([record.current, next]);
  if (record.transitions.has(transition)) {
    return false;
  }
  record.transitions.add(transition);
  record.current = next;
  return true;
}

/** DEF-129・T37R2-fix: 1 つの frame の、ページが始めた読み込みの数。 */
interface FrameNavigationCount extends FrameNavigationRecord {
  /** 数え始めの後に、ページが始めた読み込みの数。 */
  pageInitiated: number;
}

/** DEF-129: page の文書の読み込みの数（Guard だけが書く）。 */
interface MainFrameNavigationState extends FrameNavigationCount {
  /** BeakSight 自身の読み込みを知らされ、まだその文書の要求が来ていない。 */
  ownNavigationPending: boolean;
  /** main frame の文書の要求を、1 つでも受けた。 */
  firstDocumentSeen: boolean;
  /** ページが始めた読み込み（main frame か子の frame）を、上限で止めたことがある。 */
  limitReached: boolean;
  /** T37R2-fix: 子の frame（frame の ID）ごとの、最初の文書の後の、ページが始めた読み込みの数。BeakSight 自身の読み込みで空にする。 */
  readonly childFrames: Map<string, FrameNavigationCount>;
  /**
   * T44b（Task 44 の設計の変更の履歴の「T44b の報告」の行の、設計者の判断の (2)）: BeakSight が閉じる前にページを離れ始めた（`announcePageLeave`）。真の後の
   * ページが始めた文書の読み込みは止める（`PAGE_LEAVE_LIMIT_DECISION`）。
   */
  leaving: boolean;
  /**
   * DEF-236（設計書 `2026-11-09-beaksight-visible-pacing-wait-design.md` 3.1 の 2）: BeakSight が、証拠を集め終えた後に、この page を見せたまま読み込みの間隔を
   * 待ち始めた（`announcePacingWait`）。真の後の文書の読み込みは、その画面の数（DEF-129 の輪の判定）に入れない。判定（DELETE・危険な語・
   * 資格情報などの止め）、通した送信の記録、サービスへの要求の上限の数は変えない。止めた事象の時点の印は `CLOSING`。
   */
  pacingWait: boolean;
  /** DEF-208-1: 凍結の段で Guard が通した（サーバへ送った）読み取りの数（文書でない要求と子の frame の文書。CDP の層で数える。値と URL は持たない）。 */
  frozenReadRequests: number;
  /** DEF-208-1（設計者の判断 (a)）: そのうち、観察の間の目印（欄に入れた値）を URL に運んだものの数。 */
  frozenMarkerReadRequests: number;
  /** DEF-233: 凍結の段で Guard が通した（サーバへ送った）サイトの token の更新の数（`isFrozenTokenRefreshAdmissible`。CDP の層で数える。値と URL は持たない）。 */
  frozenTokenRefreshRequests: number;
  /** DEF-225: Guard が止めたダウンロードと対応付けた、main frame の読み取りの移動の失敗があった（凍結の前。違反にしなかったもの）。 */
  mainFrameDownloadBlocked: boolean;
}

const mainFrameNavigationStates = new WeakMap<Page, MainFrameNavigationState>();

/** page の main frame の読み込みの数（なければ作る）。 */
const mainFrameNavigationStateOf = (page: Page): MainFrameNavigationState => {
  const existing = mainFrameNavigationStates.get(page);
  if (existing !== undefined) {
    return existing;
  }
  const created: MainFrameNavigationState = {
    ownNavigationPending: false,
    firstDocumentSeen: false,
    pageInitiated: 0,
    current: '',
    transitions: new Set(),
    limitReached: false,
    childFrames: new Map(),
    leaving: false,
    pacingWait: false,
    frozenReadRequests: 0,
    frozenMarkerReadRequests: 0,
    frozenTokenRefreshRequests: 0,
    mainFrameDownloadBlocked: false,
  };
  mainFrameNavigationStates.set(page, created);
  return created;
};

/**
 * T44b（Task 44 の設計の変更の履歴の「T44b の報告」の行の、設計者の判断の (2)）: BeakSight が、閉じる前にこの page を離れ始める（factory が about:blank への
 * 移動の直前に呼ぶ）。この後にページが始めた文書の読み込みは止める（`PAGE_LEAVE_LIMIT_DECISION`）。
 * 判定（`classifyPassiveRequest`）、通した送信の記録、サービスへの要求の上限の数は変えない。戻す口は持たない（離れた page は、そのまま Context と閉じる）。
 */
export function announcePageLeave(page: Page): void {
  const state = mainFrameNavigationStateOf(page);
  state.leaving = true;
  // FRET fix round 3（設計書の設計変更履歴の 2026-11-26）: 閉じる前の離れる手順の前に、窓を開くボタンを押した後の止めの続きを外す（SD-2 2.4 の閉じる時の後始末の
  // 送信を、今の判定で届ける）。読み込みの間隔の待ち（`announcePacingWait`）の間は外さない。
  const guardState = guardStates.get(page.context());
  if (guardState !== undefined) {
    // FRET fix round 4: 押した page の離れる手順の間に通した読み取りでない要求を、記録で見分けられるようにする（止めない。限界の記録）。
    guardState.dialogPressLeaving ||= guardState.dialogPressHold;
    guardState.dialogPressHold = false;
  }
}

/**
 * DEF-236（設計書 `2026-11-09-beaksight-visible-pacing-wait-design.md` 3.1 の 2）: BeakSight が、証拠を集め終えた後に、この page を閉じずに見せたまま、読み込みの
 * 間隔を待ち始める（Page Auditor と 1 画面の読み込みが、待ちの直前に呼ぶ）。この後の文書の読み込みは、その画面の数（DEF-129 の輪の判定）に入れない。
 * `announcePageLeave` とは別の口である（移動の止めは当てない。
 * サイトが自然に出す通信と移動は、判定が通すものを通す）。判定（`classifyPassiveRequest`。DELETE・危険な語・資格情報などの止め）、通した送信の記録、サービスへの
 * 要求の上限の数は変えない。止めた事象の時点の印は `CLOSING`（`blockedEventPhaseOf`）。戻す口は持たない（待ちの後、page は Context と閉じる）。
 */
export function announcePacingWait(page: Page): void {
  mainFrameNavigationStateOf(page).pacingWait = true;
}

/** DEF-236: この page で、読み込みの間隔の待ちを始めたか（`announcePacingWait`。読むだけ）。 */
export function isPacingWaitAnnounced(page: Page): boolean {
  return mainFrameNavigationStates.get(page)?.pacingWait === true;
}

/**
 * DEF-129: BeakSight 自身が、この page の main frame を読み込む（`page.goto` の直前に呼ぶ。`src/browser/main-frame-load.ts` の `settleMainFrameLoad` と、
 * 幅の走査の読み込みが呼ぶ）。次の main frame の文書の要求を BeakSight 自身の読み込みとして数えず、ページが始めた読み込みの数を数え直す。Guard の
 * ない page でも害はない（数を持つだけ）。
 */
export function announceOwnMainFrameNavigation(page: Page): void {
  const state = mainFrameNavigationStateOf(page);
  state.ownNavigationPending = true;
  // FRET（2026-11-25 fix round 1 の判断）: BeakSight 自身の次の読み込みの前に、窓を開くボタンの押した後の止めの続きを外す（読み込みと、その後の点検は今の扱い）。
  const guardState = guardStates.get(page.context());
  if (guardState !== undefined) {
    guardState.dialogPressHold = false;
  }
}

/**
 * DEF-129: ページが始めた main frame の読み込みを、1 つ数える（数えてよいか、止めるか）。BeakSight 自身の読み込み（知らされた次の要求）と、最初の
 * main frame の文書の要求は数えない（真。数え始める）。L10 の S4: ほかは数え、この読み込みの中で同じ移りがくり返されたら（輪）偽（止めた印を残す）。
 */
const admitMainFrameNavigation = (page: Page, url: string): PageLimitAdmission => {
  const state = mainFrameNavigationStateOf(page);
  // T44R の I-1: ページを離れ始めた後の文書の読み込みは止める（読み取りの判定の印は付けない）。
  if (state.leaving) {
    return PAGE_LEAVE_LIMIT_DECISION;
  }
  // DEF-236: 見せたままの待ちの間に画面が始めた読み込みは、その画面の数と上限に入れない（判定が通したものは通す）。
  if (state.pacingWait) {
    return true;
  }
  if (state.ownNavigationPending || !state.firstDocumentSeen) {
    state.ownNavigationPending = false;
    state.firstDocumentSeen = true;
    state.pageInitiated = 0;
    // L10 の S4: 移りの記録も、この読み込みから数え直す（数え始めの文書から）。
    restartFrameNavigationRecord(state, url);
    // T37R2-fix: 前の文書の子の frame の数は使わない（新しい文書の子の frame は、別の ID）。
    state.childFrames.clear();
    return true;
  }
  return admitPageInitiatedNavigation(state, state, url);
};

/**
 * T37R2-fix（T37R2 の I-1）: ページが始めた子の frame の文書の読み込みを、1 つ数える。その frame の最初の文書の要求は数えない（真。数え始める）。
 * ほかは main frame と同じく数え、L10 の S4: その frame で同じ移りがくり返されたら（輪）偽（止めた印を page に残す）。
 */
const admitChildFrameNavigation = (page: Page, frameId: string, url: string): PageLimitAdmission => {
  const state = mainFrameNavigationStateOf(page);
  // T44R の I-1: ページを離れ始めた後の子の frame の文書の読み込みも止める（読み取りの判定の印は付けない）。
  if (state.leaving) {
    return PAGE_LEAVE_LIMIT_DECISION;
  }
  // DEF-236: 見せたままの待ちの間の子の frame の読み込みも、数と上限に入れない。
  if (state.pacingWait) {
    return true;
  }
  const count = state.childFrames.get(frameId);
  if (count === undefined) {
    state.childFrames.set(frameId, { pageInitiated: 0, ...startFrameNavigationRecord(url) });
    return true;
  }
  return admitPageInitiatedNavigation(state, count, url);
};

/**
 * DEF-129・T37R2-fix: frame の、ページが始めた読み込みを 1 つ数える。main frame と子の frame が共有する。
 * L10（設計書 `2026-11-09-beaksight-remove-limits-design.md` 4。INV-LIMITS の S4 と設計者の判断）: 回数の上限（前は `PAGE_INITIATED_NAVIGATION_LIMIT_PER_FRAME`
 * 2 回）は撤廃し、回数でなく事実で終える。同じ frame で同じ移りがくり返されたら（`admitFrameNavigationTransition`）、輪とみなして偽（page に止めた印を残す。止めた
 * 記録の理由は前と同じ `PAGE_NAVIGATION_LIMIT_REACHED`）。輪にならない移動の続きは、通して L0 の見張りで終える。
 */
const admitPageInitiatedNavigation = (state: MainFrameNavigationState, count: FrameNavigationCount, url: string): boolean => {
  count.pageInitiated = saturatingIncrement(count.pageInitiated);
  if (!admitFrameNavigationTransition(count, url)) {
    state.limitReached = true;
    return false;
  }
  return true;
};

/**
 * DEF-129・T37R2-fix: page の読み込みの事実（`pageLoadFactsOf`）。SPEC-1: 文書でない要求の上限の印（DEF-130-fix の `subresourceLimitReached`）と、成果物に残した
 * 要求の数（`documentRequests`・`childFrameDocumentRequests`・`subresourceRequests`。どの表示も読まなかった）は消した。
 */
export interface PageLoadFacts {
  /** ページが始めた読み込み（main frame か子の frame）を、上限で止めたか。 */
  readonly limitReached: boolean;
  /** DEF-208-1: 凍結の段で Guard が通した読み取りの数（操作さがしの記録に残す。値と URL は持たない）。`pageLoadFactsOf` は必ず書く。 */
  readonly frozenReadRequests?: number;
  /** DEF-208-1: そのうち、観察の間の目印を URL に運んだものの数。`pageLoadFactsOf` は必ず書く。 */
  readonly frozenMarkerReadRequests?: number;
  /** DEF-233: 凍結の段で Guard が通したサイトの token の更新の数（読み取りの数には入れない）。`pageLoadFactsOf` は必ず書く。 */
  readonly frozenTokenRefreshRequests?: number;
  /**
   * DEF-225: 凍結の前に、main frame の読み取りの移動が、Guard が止めたダウンロード（同じ page・同じ URL）のために失敗した（その画面はファイルのダウンロードに
   * なる。違反にしていない）。`pageLoadFactsOf` は必ず書く。
   */
  readonly mainFrameDownloadBlocked?: boolean;
}

/** DEF-129: Guard が、ページが始めた読み込み（文書）を上限で止めたか（その画面は読み切れない。各段の唯一の判定）。 */
export const isPageLoadLimitReached = (facts: PageLoadFacts): boolean => facts.limitReached;

/**
 * DEF-129: page の読み込みの事実（読むだけ）。main frame の文書の要求を受けていない page は `null`。1 画面を読む流れ
 * （`src/worker/worker-run-session.ts` の `visitGuardedPage`、監査の 1 画面）が、Context を閉じた後に読み、止めた画面を読み切れない画面にする。
 */
export function pageLoadFactsOf(page: Page): PageLoadFacts | null {
  const state = mainFrameNavigationStates.get(page);
  return state === undefined || !state.firstDocumentSeen
    ? null
    : Object.freeze({
      limitReached: state.limitReached,
      frozenReadRequests: state.frozenReadRequests,
      frozenMarkerReadRequests: state.frozenMarkerReadRequests,
      frozenTokenRefreshRequests: state.frozenTokenRefreshRequests,
      mainFrameDownloadBlocked: state.mainFrameDownloadBlocked,
    });
}

/** DEF-129: 上限で止めたページが始めた main frame の読み込みの判定（Safety Ledger の止めた要求の理由）。 */
const PAGE_NAVIGATION_LIMIT_DECISION: Extract<PassiveRequestDecision, { readonly action: 'BLOCK' }> = Object.freeze({
  action: 'BLOCK',
  category: 'REQUEST',
  reason: 'PAGE_NAVIGATION_LIMIT_REACHED',
});

/**
 * T44R の I-1: ページを離れ始めた後（`announcePageLeave`）に止めた要求の判定（Safety Ledger の止めた要求の理由）。離れた後の文書でない要求のうち
 * 上限（前は 30。L10 で撤廃した）を超えたものと、離れた後の文書の読み込み（ページが始めた移動、ポップアップが opener を戻す移動。BeakSight の about:blank への
 * 移動はサイトへの要求ではないので、ここに来ない）。そのページの読み取りの判定の印（`limitReached`）は付けない。
 */
const PAGE_LEAVE_LIMIT_DECISION: Extract<PassiveRequestDecision, { readonly action: 'BLOCK' }> = Object.freeze({
  action: 'BLOCK',
  category: 'REQUEST',
  reason: 'PAGE_LEAVE_REQUEST_LIMIT_REACHED',
});

/** 上限の口の結果: 真は通す、偽は今の上限で止める、判定（`PAGE_LEAVE_LIMIT_DECISION`）はその判定で止める（T44R の I-1）。 */
type PageLimitAdmission = boolean | BlockDecision;

/**
 * `decideGuardRequest` の結果（動作と記録）。止める命令（CDP の `Fetch.failRequest`、route の `abort`）と、その失敗の扱いは、層ごとの呼び出し側が
 * 行う。止める前の記録は `recordGuardVerdictBeforeBlock`、判定で止めた記録は止めた後に `recordBlockedDecision` で書く。
 */
export type GuardRequestVerdict =
  /** 凍結の段: 止める。記録は `INTERACTION_FROZEN`（要求の method と URL があれば要求の記録、`navigation` ならナビゲーションの記録も）。 */
  | {
    readonly kind: 'BLOCK_FROZEN';
    readonly request: GuardRequestIdentity | null;
    readonly navigation: boolean;
  }
  /** 閉じる途中・無効化の段（持ち主が閉じ始めた page を含む）: 止める。記録しない（Context とともに消える要求）。 */
  | { readonly kind: 'BLOCK_LIFECYCLE' }
  /** 段階の誤り、要求の事実の欠け、CDP の付いていない page の要求（DEF-113）: 違反を記録して止め、Context を無効にする。 */
  | { readonly kind: 'BLOCK_INVALID'; readonly violation: InvariantViolationInput }
  /** 層の準備の失敗: 止めて Context を無効にする（記録は準備の側が済ませた）。 */
  | { readonly kind: 'BLOCK_UNAVAILABLE' }
  /** CORS の事前確認: Guard が満たす（サーバに届かない）。記録しない。T37b: 凍結の段では、観察の口が認めた事前確認だけ（`frozenPreflight`）。 */
  | { readonly kind: 'FULFILL_PREFLIGHT' }
  /** 判定で止める。止めた後に、判定の理由で記録する（`recordBlockedDecision`）。 */
  | { readonly kind: 'BLOCK_POLICY'; readonly request: GuardRequestIdentity; readonly decision: BlockDecision }
  /** 判定で通す（route の層では、届け方の部品（`resourceDelivery`）を尋ねる）。 */
  | {
    readonly kind: 'ALLOW';
    readonly request: GuardRequestIdentity;
    readonly decision: Extract<PassiveRequestDecision, { readonly action: 'ALLOW' }>;
    /** DEF-208-1: 凍結の段で、凍結の読み取りの判定で通した読み取り（数えて、中継に凍結の後の写しとして知らせる）。 */
    readonly frozenRead?: true;
  };

/** 段階の誤りの違反のコードと、その文の書き出し（層ごと。今までの文のまま）。 */
const GUARD_PHASE_INVALID_VIOLATIONS: Readonly<Record<GuardRequestLayer, { readonly code: string; readonly observed: string }>> = Object.freeze({
  CDP_REQUEST: Object.freeze({ code: 'CDP_REQUEST_PHASE_INVALID', observed: 'Paused request' }),
  CDP_DOCUMENT: Object.freeze({ code: 'CDP_DOCUMENT_PHASE_INVALID', observed: 'Paused Document' }),
  ROUTE: Object.freeze({ code: 'HTTP_ROUTE_PHASE_INVALID', observed: 'HTTP route' }),
});

/** DEF-113: CDP の付いていない page の要求を止めた、明示の理由（違反のコード）。 */
export const UNGUARDED_PAGE_REQUEST_VIOLATION_CODE = 'PASSIVE_GUARD_PAGE_NOT_READY';

/**
 * CC-050（Task 32 の設計書 4.4）: Guard の段階と要求の判定から、動作（通す・止める・無効化）と記録（Ledger の理由、違反）を決める。Guard の
 * CDP の横取りの 2 か所（`handlePausedRequest`、Document の `onRequestPaused`）と route の処理が、この関数だけで決める（判定そのものは
 * `classifyPassiveRequest` の 1 か所のまま、`evaluate` の中で呼ぶ）。順は次のとおり（今までの 3 か所の順と同じ）。
 * 1. 凍結の段（閉じる途中・無効化の凍結の段を含む）: 止めて `INTERACTION_FROZEN` で記録する。T37b: ただし `FROZEN_ACTIVE` で、持ち主が閉じ始めた
 *    page でなく、要求の事実があり、観察の口が認めた（`frozenPreflight` が真の）CORS の事前確認は、Guard が満たす（`FULFILL_PREFLIGHT`。記録しない）。
 *    DEF-208-1: 同じ条件で、凍結の読み取りの判定（`frozenRead`。観察の口のある Guard だけが渡す）が真の読み取りは、`evaluate` の判定にかけ、ALLOW なら上限の
 *    口を当てて通す（`frozenRead` の印つきの `ALLOW`）。判定が止めるものは、今どおり凍結で止める。
 * 2. 閉じる途中・無効化の段（`CLOSED` を含む）と、持ち主が閉じ始めた page（CDP の層だけ）: 止める。記録しない。
 * 3. `PASSIVE_ACTIVE` でない段（取り付けの途中）: 段階の誤りの違反を記録し、止めて無効にする。
 * 4. 要求の事実（method と URL）がない（CDP の層）: 違反 `CDP_REQUEST_FACTS_INVALID` を記録し、止めて無効にする。
 * 5. CDP の付いていない page のナビゲーション（route の層。DEF-113）: frame の判定の成否に頼らず、違反
 *    `PASSIVE_GUARD_PAGE_NOT_READY`（URL つき）を記録し、止めて無効にする。
 * 6. ほかは `evaluate`（判定と層ごとの準備）の結果に従う。
 * `evaluate` を呼ぶほかは、副作用を持たない（記録も命令も、呼び出し側が結果に従って行う）。
 */
export function decideGuardRequest(input: GuardRequestInput): GuardRequestVerdict {
  const { phase } = input;
  if (isFrozenPhase(phase)) {
    if (
      phase === 'FROZEN_ACTIVE'
      && !input.ownerClosingPage
      && input.request !== null
      && input.frozenPreflight !== undefined
      && input.frozenPreflight(input.request)
    ) {
      return { kind: 'FULFILL_PREFLIGHT' };
    }
    // DEF-208-1: 凍結の読み取りの判定に当たる読み取りは、監査の段と同じ判定にかけ、通すものは通す（止めるものは今どおり凍結で止める）。
    if (
      phase === 'FROZEN_ACTIVE'
      && !input.ownerClosingPage
      && input.request !== null
      && input.frozenRead !== undefined
      && input.frozenRead(input.request)
    ) {
      const { request } = input;
      const outcome = input.evaluate(request);
      if (outcome.kind === 'UNAVAILABLE') return { kind: 'BLOCK_UNAVAILABLE' };
      if (outcome.kind === 'DECISION' && outcome.decision.action === 'ALLOW') {
        const admitted = admittedVerdictOf(input, request, outcome.decision);
        return admitted.kind === 'ALLOW' ? { ...admitted, frozenRead: true } : admitted;
      }
    }
    return { kind: 'BLOCK_FROZEN', request: input.request, navigation: input.navigation };
  }
  if (isClosingOrInvalidatingPhase(phase) || input.ownerClosingPage) {
    return { kind: 'BLOCK_LIFECYCLE' };
  }
  // DEF-144: 要求の事実があれば、違反に結びつく要求として付ける（Ledger が method と Origin と path だけを残す）。
  const violationRequest = input.request === null ? {} : { request: input.request };
  if (phase !== 'PASSIVE_ACTIVE') {
    const { code, observed } = GUARD_PHASE_INVALID_VIOLATIONS[input.layer];
    return { kind: 'BLOCK_INVALID', violation: { code, message: `${observed} observed during ${phase}`, ...violationRequest } };
  }
  if (input.request === null) {
    return { kind: 'BLOCK_INVALID', violation: { code: 'CDP_REQUEST_FACTS_INVALID', message: 'Paused request had no method or URL' } };
  }
  if (input.unguardedPageNavigation !== null) {
    return { kind: 'BLOCK_INVALID', violation: { code: UNGUARDED_PAGE_REQUEST_VIOLATION_CODE, message: input.unguardedPageNavigation, request: input.request } };
  }
  const { request } = input;
  const outcome = input.evaluate(request);
  if (outcome.kind === 'PREFLIGHT') return { kind: 'FULFILL_PREFLIGHT' };
  if (outcome.kind === 'UNAVAILABLE') return { kind: 'BLOCK_UNAVAILABLE' };
  const { decision } = outcome;
  if (decision.action === 'BLOCK') {
    return { kind: 'BLOCK_POLICY', request, decision };
  }
  return admittedVerdictOf(input, request, decision);
}

/** DEF-208-1: 凍結の段で通した子の frame の文書の URL を覚える数の上限。 */
const MAX_FROZEN_FRAME_DOCUMENTS = 256;

/** fix round 2: Run の中で覚えた更新の必須の query の値がないとき。 */
const NO_LEARNED_QUERY_VALUES: ReadonlyMap<string, ReadonlySet<string>> = new Map();

/** DEF-208-1: 子の frame の文書の URL の比べる形（fragment を外す）。 */
const frameDocumentKeyOf = (url: string): string => url.split('#', 1)[0] ?? url;

/** 判定が通す要求に、上限の口（DEF-129・T44R の I-1）を当てる（`decideGuardRequest` の通常の段と、DEF-208-1 の凍結の読み取りが共有する）。 */
function admittedVerdictOf(
  input: GuardRequestInput,
  request: GuardRequestIdentity,
  decision: Extract<PassiveRequestDecision, { readonly action: 'ALLOW' }>,
): GuardRequestVerdict {
  // DEF-129: 判定が通す（サーバへ送る）ページが始めた文書の読み込みだけを数え、上限を超えたら止める（判定が止める読み込みは数えない）。
  // T44R の I-1: 口が判定を返したら（ページを離れた後）、その判定で止める。
  const navigationAdmission = input.admitPageNavigation?.() ?? true;
  if (navigationAdmission !== true) {
    return { kind: 'BLOCK_POLICY', request, decision: navigationAdmission === false ? PAGE_NAVIGATION_LIMIT_DECISION : navigationAdmission };
  }
  return { kind: 'ALLOW', request, decision };
}

/**
 * `decideGuardRequest` の結果のうち、止める命令の前に書く記録（凍結の段の `INTERACTION_FROZEN`、違反）を書く（今までの 3 か所と同じ順と形）。
 * ほかの結果では何もしない（判定で止めた記録は、止めた後に `recordBlockedDecision` で書く）。
 */
function recordGuardVerdictBeforeBlock(ledger: SafetyLedger, verdict: GuardRequestVerdict): void {
  if (verdict.kind === 'BLOCK_FROZEN') {
    if (verdict.request === null) return;
    ledger.recordBlockedInteractionRequest({ method: verdict.request.method, url: verdict.request.url, reason: 'INTERACTION_FROZEN' });
    if (verdict.navigation) {
      ledger.recordBlockedInteractionNavigation({ method: verdict.request.method, url: verdict.request.url, reason: 'INTERACTION_FROZEN' });
    }
    return;
  }
  if (verdict.kind === 'BLOCK_INVALID') {
    ledger.recordInvariantViolation(verdict.violation);
  }
}

/**
 * 止めた要求の記録の入力。`mainFrameNavigation` は、監査の段の除外の記録（`blockedAuditExclusions`。T25b round 1）だけに使う
 * （ほかの記録には渡さない。記録の形は変えない）。`resourceType`（T34e）は、ログインの段で止めた読み取りでない要求の一覧だけに使う（省略は `other`）。
 */
interface BlockedRequestFacts {
  readonly method: string;
  readonly url: string;
  readonly mainFrameNavigation: boolean;
  /** BN-a: Safety Ledger の止めた要求・監査の段の除外の記録にも残す（設計書 `2026-10-23-beaksight-bundle-beaksight-block-noise-design.md` 3.1 の 1）。 */
  readonly resourceType: RequestResourceType;
  /** BN-a: 止めた時点（`blockedEventPhaseOf`。止めた要求・移動・監査の段の除外の記録に残す）。 */
  readonly phase: BlockedEventPhase;
  /** BN-R1 の M-2: 先読みの要求か（`isSpeculativeRequestHeaders`。止めた要求・監査の段の除外の記録の印 `speculative`）。 */
  readonly speculative: boolean;
  /** T36R-fix（T36R の I-1）: 要求のヘッダ（自動ログインの資格情報の守りの比べだけに使う。記録しない）。 */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** OP-M: 要求の本文の読み方（書き込みの段の止めた要求の一覧の、目印の真偽だけに使う。本文は記録しない。省略は本文なし）。 */
  readonly body?: (() => RequestBodyText) | undefined;
}

/**
 * T26g-1: 送信の段の記録の口（ログインの段と書き込みの段の Guard だけ。T30b で共通にした）。
 * - `category`: その Guard の段の、止めた理由の種類（`LOGIN_STAGE` か `WRITE_STAGE`）。違う種類の理由は、判定の誤りとして違反にする。
 * - `submissionWindowOpenAtDecision`: 判定に渡した口で送信の窓が開いていたか。
 * - `payloadBlockReason`（書き込みの段だけ）: 送る中身の照合で止めた承認の形の POST の理由。ある場合は、窓の中の予期しない要求には数えず、書き込みの段の
 *   記録の理由ごとの数に数える（Safety Ledger には、ほかの止めた POST と同じく `NON_READ_METHOD` で残す）。
 */
interface StageRecording {
  readonly monitor: SubmissionStageMonitor;
  readonly category: SubmissionStageKind;
  readonly submissionWindowOpenAtDecision: boolean;
  readonly payloadBlockReason?: WriteStagePayloadBlockReason | undefined;
}

/** 判定に渡した口から、送信の段の記録の口を作る（送信の段でなければ `undefined`）。T39b: 照合の理由は form と API の両方。 */
function stageRecordingOf(
  admission: SubmissionPostAdmission | undefined,
  policy: PassiveRequestPolicyOptions | undefined,
  payloadBlockReason?: WriteStagePayloadBlockReason,
): StageRecording | undefined {
  if (admission === undefined) {
    return undefined;
  }
  const submissionWindowOpenAtDecision = admission.kind === 'LOGIN_STAGE'
    ? policy?.authSetup?.submissionWindowOpen === true
    : policy?.writeStage?.submissionWindowOpen === true;
  return { monitor: admission.monitor, category: admission.kind, submissionWindowOpenAtDecision, payloadBlockReason };
}

/** T37R-fix-B（M-5）: 許可 Origin への、データを取る読み取りでない要求として数える要求の種類（計測の送信 `ping`・`beacon` などは数えない）。 */
const AUDIT_STAGE_DATA_REQUEST_RESOURCE_TYPES: ReadonlySet<RequestResourceType> = new Set<RequestResourceType>(['fetch', 'xhr']);

/**
 * OP-M: 書き込みの段の Guard が止めた要求を、承認した送信のほかの要求の一覧に記録する（書き込みの段の記録でなければ何もしない）。理由は、送信の段の理由、
 * 送る中身の照合の理由、ほかの判定の理由のどれか。
 */
function recordWriteStageBlockedFacts(stage: StageRecording, request: BlockedRequestFacts, reason: string): void {
  if (!(stage.monitor instanceof WriteStageMonitor)) {
    return;
  }
  recordWriteStageUnexpectedRequest(stage.monitor, {
    method: request.method,
    url: request.url,
    resourceType: requestResourceTypeOf(request.resourceType),
    body: request.body ?? ((): RequestBodyText => NO_BODY_TEXT),
  }, reason, stage.submissionWindowOpenAtDecision);
}

/**
 * OP-N（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.7 の N1）: 書き込みの段の、値を入れた後（送信の窓の観察の段）に止めた要求のうち、取りやめに
 * 数えないものか。読み取り（GET・HEAD）で、URL と本文に入れた値（目印）がないもの（照らしは `WriteStageUnexpectedRequestList.carriesMarker`。読めない本文は
 * あるとみなす）。止めることは変えない。書き込みの段でない、窓の外、送信の段を開いた後、読み取りでない要求は偽。
 */
function toleratedInWriteWindow(
  monitor: SubmissionStageMonitor,
  submissionWindowOpenAtDecision: boolean,
  request: { readonly method: string; readonly url: string; readonly body?: (() => RequestBodyText) | undefined },
): boolean {
  if (!(monitor instanceof WriteStageMonitor) || !submissionWindowOpenAtDecision || !isReadMethod(request.method)) {
    return false;
  }
  const state = writeStageStateOf(monitor);
  return !state.submissionPhaseOpen && !state.unexpectedRequests.carriesMarker({ url: request.url, body: request.body ?? ((): RequestBodyText => NO_BODY_TEXT) });
}

/** OP-N（N1）: 書き込みの段の、値を入れた後に止めた WebSocket（張り直し）のうち、URL に入れた値（目印）がなく、取りやめに数えないものか。 */
function toleratedWebSocketInWriteWindow(monitor: SubmissionStageMonitor, url: string): boolean {
  return toleratedInWriteWindow(monitor, monitor.isSubmissionWindowOpen(), { method: WEBSOCKET_HANDSHAKE_METHOD, url });
}

/**
 * OP-N（N2）: 書き込みの段の Guard が、送信の扱いの口で通した要求を、通した一覧に記録する（書き込みの段でなければ何もしない）。時点は、値を入れる前だけ（窓を
 * 開いた後は通さない。OP-REV3 の C-2）。本文は、行を作るときだけ読む。
 */
function recordWriteStagePassedRequest(
  monitor: WriteStageMonitor,
  request: { readonly method: string; readonly url: string; readonly resourceType: RequestResourceType; readonly body: () => RequestBodyText },
): void {
  const state = writeStageStateOf(monitor);
  if (state.destinationOf === undefined) {
    return;
  }
  state.passedRequests.record({
    ...request,
    destination: state.destinationOf(request.url),
    timing: writeStageTimingOf(state, false),
    reason: WRITE_STAGE_AUDIT_SEND_PASSED,
  });
}

/** OP-M: WebSocket の始まりの要求の method と、要求の種類（一覧の行に書く）。 */
const WEBSOCKET_HANDSHAKE_METHOD = 'GET';
const WEBSOCKET_RESOURCE_TYPE: RequestResourceType = 'websocket';

/** OP-M: 書き込みの段の Guard が止めた WebSocket を、承認した送信のほかの要求の一覧に記録する（書き込みの段の記録でなければ何もしない）。 */
function recordWriteStageBlockedWebSocket(monitor: SubmissionStageMonitor | undefined, url: string, reason: string): void {
  if (!(monitor instanceof WriteStageMonitor)) {
    return;
  }
  recordWriteStageUnexpectedRequest(monitor, {
    method: WEBSOCKET_HANDSHAKE_METHOD,
    url,
    resourceType: WEBSOCKET_RESOURCE_TYPE,
    body: (): RequestBodyText => NO_BODY_TEXT,
  }, reason, monitor.isSubmissionWindowOpen());
}

function recordBlockedDecision(
  ledger: SafetyLedger,
  decision: BlockDecision,
  request: BlockedRequestFacts,
  stage?: StageRecording,
  auditMonitor?: AuditStageMonitor,
  auditServiceOrigins?: ReadonlySet<string>,
  auditAllowedOrigins?: ReadonlySet<string>,
): void {
  if (decision.category === 'REQUEST' && decision.loginCredential === true) {
    // T36b（Task 36 の設計書 3.3）: 資格情報の守りで止めた要求は、ログインの段の記録に数だけを書く（URL・本文・値を残さない。Safety Ledger には
    // 書かない。URL の query や path に資格情報が入っているため）。T36c（設計者の判断 1）: 数は、止めた理由ごとの数の
    // `LOGIN_CREDENTIAL_IN_REQUEST` に足す（IPC と管理データに数だけが残る）。止めた一覧には、Origin と path も載せない（path に値が入りうるため）。
    if (stage?.monitor instanceof LoginStageMonitor) {
      const state = loginStageStateOf(stage.monitor);
      state.blockedByScriptReason[LOGIN_CREDENTIAL_BLOCK_REASON] = saturatingIncrement(state.blockedByScriptReason[LOGIN_CREDENTIAL_BLOCK_REASON]);
    }
    return;
  }
  const { method, url } = request;
  if (decision.category === 'REQUEST' && stage?.monitor instanceof LoginStageMonitor) {
    // T36R-fix（T36R の I-1）: 自動ログインのログインの段で、方針で止めた要求も、止めた一覧に行を作る前に比べる（URL とヘッダ。止めた要求の本文と
    // Cookie は送っていないので比べない）。含まれていれば、行を作らず（Safety Ledger にも書かず）、資格情報の数に回す（結果は、設計者の判断 3 で
    // `AUTH_RESULT_UNKNOWN`）。
    const state = loginStageStateOf(stage.monitor);
    const { credentialGuard } = state;
    if (credentialGuard !== undefined && carriesLoginCredential(credentialGuard, {
      url,
      readMethod: isReadMethod(method),
      body: NO_BODY_TEXT,
      headers: request.headers,
      cookies: NO_COOKIES,
    })) {
      state.blockedByScriptReason[LOGIN_CREDENTIAL_BLOCK_REASON] = saturatingIncrement(state.blockedByScriptReason[LOGIN_CREDENTIAL_BLOCK_REASON]);
      return;
    }
  }
  if (decision.category === 'REQUEST' && auditMonitor !== undefined) {
    // T35b: スクリプトで送るログインの監査の段で止めた要求を、詳しい理由ごと（と、承認したサービスの Origin への要求の上限で止めた数）に数える
    // （Safety Ledger には、今どおり止めた理由だけを書く）。
    const state = auditStageStateOf(auditMonitor);
    if (decision.auditStageBlock !== undefined) {
      state.blockedByReason[decision.auditStageBlock] = saturatingIncrement(state.blockedByReason[decision.auditStageBlock]);
      // T37d: 登録していない読み取りでない要求のうち、宛先が承認したサービスの Origin のものも数える（判定は変えない）。
      if (decision.auditStageBlock === 'UNREGISTERED_NON_READ' && auditServiceOrigins !== undefined && hasAllowedOrigin(url, auditServiceOrigins)) {
        state.serviceOriginNonReadBlocked = saturatingIncrement(state.serviceOriginNonReadBlocked);
      } else if (
        // T37R-fix-B（M-5）: 宛先が許可 Origin で、種類が `fetch`・`xhr` の読み取りでない要求も数える（計測の送信は数えない。判定は変えない）。
        decision.auditStageBlock === 'UNREGISTERED_NON_READ'
        && auditAllowedOrigins !== undefined
        && hasAllowedOrigin(url, auditAllowedOrigins)
        && request.resourceType !== undefined
        && AUDIT_STAGE_DATA_REQUEST_RESOURCE_TYPES.has(request.resourceType)
      ) {
        state.allowedOriginDataRequestsBlocked = saturatingIncrement(state.allowedOriginDataRequestsBlocked);
      }
    } else if (decision.reason === 'SERVICE_REQUEST_LIMIT_REACHED') {
      state.serviceRequestLimitBlocked = saturatingIncrement(state.serviceRequestLimitBlocked);
    }
  }
  if (decision.category === 'LOGIN_STAGE' || decision.category === 'WRITE_STAGE') {
    // T26g-1・T30b: 送信の段だけの理由で止めた要求。Safety Ledger には書かず、段の記録に数える（URL・値は持たない）。
    const decidedStage: SubmissionStageKind = decision.category;
    if (stage === undefined || stage.category !== decidedStage) {
      ledger.recordInvariantViolation({ code: 'UNEXPECTED_HTTP_DECISION', message: `HTTP policy returned ${decision.category}` });
      return;
    }
    stage.monitor.recordStageBlock(decision.reason, toleratedInWriteWindow(stage.monitor, stage.submissionWindowOpenAtDecision, request));
    recordWriteStageBlockedFacts(stage, request, decision.reason);
    return;
  }
  if (stage?.payloadBlockReason !== undefined && stage.monitor instanceof WriteStageMonitor) {
    const state = writeStageStateOf(stage.monitor);
    state.blockedByPayloadReason[stage.payloadBlockReason] = saturatingIncrement(state.blockedByPayloadReason[stage.payloadBlockReason]);
    recordWriteStageBlockedFacts(stage, request, stage.payloadBlockReason);
  } else {
    stage?.monitor.recordOtherBlock(stage.submissionWindowOpenAtDecision, toleratedInWriteWindow(stage.monitor, stage.submissionWindowOpenAtDecision, request));
    if (stage !== undefined) recordWriteStageBlockedFacts(stage, request, decision.reason);
  }
  if (decision.category === 'REQUEST' && decision.scriptLoginBlock !== undefined && stage?.monitor instanceof LoginStageMonitor) {
    // T34b: スクリプトで送るログインの段で止めた、読み取りでない要求を、詳しい理由ごとに数える（Safety Ledger には、今どおり `NON_READ_METHOD`）。
    const state = loginStageStateOf(stage.monitor);
    state.blockedByScriptReason[decision.scriptLoginBlock] = saturatingIncrement(state.blockedByScriptReason[decision.scriptLoginBlock]);
  }
  // SD-2: 自動ログインの段の口の決まりで止めた行（前の DEF-194 の `AUTOMATED_LOGIN_RULE_BLOCKED`）は作らない（判定がその印を返さない）。
  const rowReason = decision.category === 'REQUEST' && decision.reason === 'NON_READ_METHOD' ? decision.scriptLoginBlock ?? decision.reason : undefined;
  if (rowReason !== undefined && isLoginStageBlockedRequestReason(rowReason) && stage?.monitor instanceof LoginStageMonitor) {
    // T34e: ログインの段で止めた読み取りでない要求を、一覧に載せる（Origin と path と種類と理由だけ。ログインの送り方によらない）。理由は、スクリプトで
    // 送るログインの詳しい理由か、フォームの送信のログインの `NON_READ_METHOD`。T36R-fix（T36R の M-2）: 資格情報を含む要求の理由は行にしない（数だけ）。
    loginStageStateOf(stage.monitor).blockedRequests.record(url, requestResourceTypeOf(request.resourceType), rowReason);
  }
  // BN-a: 止めた要求の記録に、要求の種類と時点を残す（止め方と記録の場所は変えない）。
  const { resourceType, phase } = request;
  // BN-R1 の M-2: 先読みの要求の印（先読みのときだけ）。
  const speculative = request.speculative ? { speculative: true as const } : {};
  if (decision.category === 'REQUEST') {
    ledger.recordBlockedRequest({ method, url, reason: decision.reason, resourceType, phase, ...speculative });
  } else if (decision.category === 'NAVIGATION') {
    ledger.recordBlockedNavigation({ method, url, reason: decision.reason, phase });
  } else if (decision.category === 'AUDIT_EXCLUSION') {
    // T25b round 1（Task 25 の設計書 4.2）: 監査の段の除外で止めた要求。値や本文は記録しない。
    ledger.recordBlockedAuditExclusion({
      method,
      url,
      mainFrameNavigation: request.mainFrameNavigation,
      reason: decision.reason,
      resourceType,
      phase,
      ...speculative,
    });
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
  request: BlockedRequestFacts,
  stage?: StageRecording,
  auditMonitor?: AuditStageMonitor,
  auditServiceOrigins?: ReadonlySet<string>,
  auditAllowedOrigins?: ReadonlySet<string>,
): Promise<void> {
  try {
    await route.abort('blockedbyclient');
    recordBlockedDecision(ledger, decision, request, stage, auditMonitor, auditServiceOrigins, auditAllowedOrigins);
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

/** 凍結の段の route の要求を止める（記録は、止める前に `recordGuardVerdictBeforeBlock` が書く）。 */
async function abortInteractionRequest(
  requestInvalidation: () => void,
  route: Route,
  ledger: SafetyLedger,
): Promise<void> {
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
): Promise<boolean> {
  const expectedFailure = expectedCdpFailures.register(page, request, Date.now());
  try {
    await commands.failRequest();
    // BN-a: 止める命令が成功した（呼び出し側が、閉じる途中に止めた要求として記録する）。
    return true;
  } catch (error) {
    if (expectedFailure !== null) expectedCdpFailures.remove(page, expectedFailure);
    const message = errorMessage(error);
    // DEF-050: Context の閉じる処理が始まった後の、閉じた形の失敗は、target とともに消えた要求として違反にしない（DEF-042 の設計書
    // 2.4、DEF-045 と同じ考え）。page だけを閉じる途中など、Context の閉じる処理の前の同じ失敗は、今までどおり違反。
    const guardState = guardStates.get(context);
    if (isClosedTargetFailure(message) && guardState !== undefined && hasContextCloseStarted(guardState)) return false;
    ledger.recordInvariantViolation({
      code: 'CDP_LIFECYCLE_FAIL_REQUEST_FAILED',
      message,
    });
    if (!isClosingOrInvalidatingPhase(guardStates.get(context)?.phase ?? 'CLOSED')) {
      initiateInvalidation(context, ledger);
    }
    return false;
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

/**
 * DEF-210（通知の枠の設計書 3.2.1 の 1）: 通知の枠の閉じる押下の期間を始める（`mode` の扱いで判定する）。Guard が付いて Passive の段（`PASSIVE_ACTIVE`）の page
 * でなければ始めず、偽を返す（呼ぶ側は押さない。守れないときは押さない）。例外を投げない。
 */
export function beginNotificationPress(page: Page, mode: NotificationPressMode): boolean {
  try {
    const guardState = requireActiveGuardState(page.context(), ['PASSIVE_ACTIVE']);
    if (guardState.pageGuards.get(page)?.status !== 'READY') {
      return false;
    }
    guardState.notificationPress = mode;
    return true;
  } catch {
    return false;
  }
}

/**
 * fix round 3（設計書 3.2.2 の 4）: 押す期間の main frame の移動と、押す期間に開いたポップアップの数（Context を閉じた後も読める）。Guard がなければ 0。
 */
export function notificationPressNavigationsOf(page: Page): number {
  return guardStates.get(page.context())?.notificationPressNavigations ?? 0;
}

/** RB-14a（X11）: 見るだけの点検の押す期間に、止めずに数えた main frame の移動の行き先（Context を閉じた後も読める）。Guard がなければ空。 */
export function notificationPressNavigationTargetsOf(page: Page): readonly string[] {
  return [...(guardStates.get(page.context())?.notificationPressNavigationTargets ?? [])];
}

/** DEF-210: 通知の枠の閉じる押下の期間を終える（見るだけの点検。操作さがしは凍結で終わる）。Guard がなければ何もしない。例外を投げない。 */
export function endNotificationPress(page: Page): void {
  const guardState = guardStates.get(page.context());
  if (guardState !== undefined) {
    guardState.notificationPress = null;
  }
}

/**
 * REV-EV4（設計書 `2026-11-16-beaksight-finding-evidence-design.md` 3.4）: 横にスクロールする領域のキーの押下の期間の口（`begin` は Guard が付いて Passive の段の
 * 準備のできた page でなければ始めず偽を返す。呼ぶ側は押さない。`blocked` は、その期間に止めた main frame の移動とポップアップの数）。例外を投げない。
 * FRET（2026-11-25）: `pressPeriod` は、キーの押下の期間の中の、窓を開くボタンの押す期間を入れ外しする（その間は読み取りでない要求も止める）。キーの押下の期間で
 * ないときは入れない。`end` は押す期間も外す。
 */
export function scrollKeyPressGuardOf(page: Page): {
  readonly begin: () => boolean;
  readonly end: () => void;
  readonly blocked: () => number;
  readonly pressPeriod: (on: boolean) => void;
  readonly holdPressStop: () => void;
  readonly webSocketFramesSent: () => number;
  readonly webSocketFramesSentAfterPress: () => number;
} {
  return {
    // fix round 5: 押した後の止めの続き（hold）の間に、前から開いていた接続が送った frame の数（止めない）。
    webSocketFramesSentAfterPress: () => guardStates.get(page.context())?.dialogPressHoldWebSocketFrames ?? 0,
    // FRET fix round 4: 押す期間に、押す前から開いていた WebSocket の接続が送った frame の数（止めない。観察のある Context だけ数える）。
    webSocketFramesSent: () => guardStates.get(page.context())?.dialogPressWebSocketFrames ?? 0,
    pressPeriod: (on: boolean) => {
      const guardState = guardStates.get(page.context());
      if (guardState !== undefined) {
        guardState.dialogPress = on && guardState.scrollKeyPress;
      }
    },
    // FRET（2026-11-25 fix round 1 の判断）: キーの押下の期間の中で呼ぶと、押す期間の止めを、BeakSight 自身の次の読み込み（か凍結・Context を閉じる）まで続ける。
    holdPressStop: () => {
      const guardState = guardStates.get(page.context());
      if (guardState !== undefined && guardState.scrollKeyPress) {
        guardState.dialogPressHold = true;
      }
    },
    begin: () => {
      try {
        const guardState = requireActiveGuardState(page.context(), ['PASSIVE_ACTIVE']);
        if (guardState.pageGuards.get(page)?.status !== 'READY') {
          return false;
        }
        guardState.scrollKeyPress = true;
        return true;
      } catch {
        return false;
      }
    },
    end: () => {
      const guardState = guardStates.get(page.context());
      if (guardState !== undefined) {
        guardState.scrollKeyPress = false;
        guardState.dialogPress = false;
      }
    },
    blocked: () => guardStates.get(page.context())?.scrollKeyPressBlocks ?? 0,
  };
}

/** DEF-210: 押した値の移りうる先のうち、ページの JS を動かすだけで移らないスキーム（押してよい。DEF-144 の操作さがしの扱いと同じ）。 */
const PRESSABLE_SCRIPT_SCHEME = 'javascript:';

/**
 * DEF-144（設計書 `2026-10-20-beaksight-probe-external-scheme-design.md` 2.1）: 移りうる先（属性の書かれたままの値）のどれかが、外部スキーム（`externalNavigationScheme`。
 * http(s)・about・data・blob のほか）を指すか。値は画面の URL を基準に解く（相対の URL は今の扱いのまま）。`javascript:` と、解けない値は、今の扱いのまま（押す）。
 * DEF-210（通知の枠の設計書 3.2.1 の 5）: 操作さがしの押す部品から、この部品へ移した（通知の枠の閉じるボタンの見分けも使う）。
 */
export const pointsToExternalScheme = (targets: readonly string[], baseUrl: string): boolean => targets.some((raw) => {
  const value = raw.trim();
  if (value === '' || !URL.canParse(value, baseUrl)) {
    return false;
  }
  const url = new URL(value, baseUrl);
  if (url.protocol === PRESSABLE_SCRIPT_SCHEME) {
    return false;
  }
  try {
    return externalNavigationScheme(url.href) !== null;
  } catch {
    return false;
  }
});

export function assertPassiveRequestGuardActive(context: BrowserContext): void {
  requireActiveGuardState(context, ['PASSIVE_ACTIVE', 'FROZEN_ACTIVE']);
}

/** ファクトリは、raw closeとタスクのdrainが両方とも終端状態に達した後にのみ所有権を解放できる。 */
export function isPassiveRequestGuardClosed(context: BrowserContext): boolean {
  return guardStates.get(context)?.phase === 'CLOSED';
}

/**
 * T37R-fix-A（Task 37 の設計書 8 章の T37R の行の M-4）: page の Context の Guard の段階を読む（読み取りだけ。段階も記録も変えない）。Guard のない
 * Context の page は `null`。probe の押す前の凍結の確かめ（`src/interaction/submission-probe.ts`）が、`FROZEN_ACTIVE` を例外に頼らずに確かめるために使う。
 */
export function passiveRequestGuardStageOf(page: Page): GuardPhase | null {
  return guardStates.get(page.context())?.phase ?? null;
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
  enterInteractionFreeze(guardState);
}

/** Guard を凍結の段に入れる（凍結の 2 つの入口が共用する。条件は呼ぶ側が確かめる）。 */
function enterInteractionFreeze(guardState: GuardState): void {
  guardState.phase = 'FROZEN_ACTIVE';
  // DEF-210（通知の枠の設計書 3.2.1 の 3）: 操作さがしの閉じる押下の期間は、凍結で終わる（凍結の後は、凍結の決まりで扱う）。
  guardState.notificationPress = null;
  // REV-EV4: 領域のキーの押下の期間も、凍結で終わる。FRET: 窓を開くボタンの押す期間も。
  guardState.scrollKeyPress = false;
  guardState.dialogPress = false;
  guardState.dialogPressHold = false;
  // DEF-085 fix round 3（I2）: Guard が凍結の段に入った直後に、出口の中継も凍結する（発見の凍結を含む。Guard の凍結の前に中継を凍結すると、
  // まだ正当な要求を中継が拒むので、この順にする）。
  freezeEgress(guardState, 'INTERACTION_FREEZE');
}

/** SAFE-2 の 1: 読み込む前の凍結の条件を判定するための事実（`freezeBeforeLoadRefusalOf` が読む）。 */
export interface FreezeBeforeLoadFacts {
  readonly phase: GuardPhase;
  /** page の Guard の準備ができているか（`pageGuards` の `READY`）で、page が閉じていないか。 */
  readonly pageReady: boolean;
  /** その page が、Context の開いたただ 1 つの page か。 */
  readonly onlyOwnerPage: boolean;
  /** page の今の URL。 */
  readonly url: string;
  /** ログインの段か書き込みの段の Guard か。 */
  readonly submissionStage: boolean;
}

/** まだ何も読み込んでいない page の URL（Context の最初の page）。 */
const NOT_YET_LOADED_PAGE_URL = 'about:blank';

/**
 * SAFE-2 の 1（COV-2c の M-1）: 読み込む前の凍結（`activateInteractionFreezeBeforeLoad`）を拒む理由（拒まないなら `null`。条件の唯一の判定）。Guard が
 * `PASSIVE_ACTIVE` で、ログインの段・書き込みの段の Guard でなく、準備のできた page がただ 1 つで、その page がまだ読み込んでいない（`about:blank`）ときだけ通す。
 */
export function freezeBeforeLoadRefusalOf(facts: FreezeBeforeLoadFacts): string | null {
  if (facts.phase !== 'PASSIVE_ACTIVE') {
    return `Interaction freeze before the load is invalid from ${facts.phase}`;
  }
  if (facts.submissionStage) {
    return 'Interaction freeze before the load is not available for the login stage or the write stage';
  }
  if (!facts.pageReady) {
    return 'Interaction freeze before the load requires the current guarded page to be ready';
  }
  if (!facts.onlyOwnerPage) {
    return 'Interaction freeze before the load requires exactly one current owner page';
  }
  if (facts.url !== NOT_YET_LOADED_PAGE_URL) {
    return 'Interaction freeze before the load requires a page that has not loaded a document';
  }
  return null;
}

/**
 * SAFE-2 の 1（COV-2c の M-1）: まだ読み込んでいない page（`about:blank`）の Guard を、凍結の段にする（不可逆）。読み込みの最初から凍結した Context で、操作さがしの
 * 祖先の画面を読み込むため（`BrowserContextFactory.openFrozenObservationContext` だけが使う）。凍結の決まりで止める範囲と、凍結の後の読み取りの決まりは、
 * `activateInteractionFreeze` の凍結と同じ。出口の中継も、同じ順（Guard の凍結の直後）で凍結する。条件（`freezeBeforeLoadRefusalOf`）に合わなければ、違反
 * `INTERACTION_FREEZE_ACTIVATION_FAILED` を記録して Context を無効にし、`Error` を投げる（`activateInteractionFreeze` と同じ fail-closed）。
 */
export async function activateInteractionFreezeBeforeLoad(page: Page): Promise<void> {
  const context = page.context();
  const guardState = requireActiveGuardState(context, ['PASSIVE_ACTIVE', 'FROZEN_ACTIVE']);
  const activePages = context.pages().filter((candidate) => !candidate.isClosed());
  const refusal = freezeBeforeLoadRefusalOf({
    phase: guardState.phase,
    pageReady: !page.isClosed() && guardState.pageGuards.get(page)?.status === 'READY',
    onlyOwnerPage: activePages.length === 1 && activePages[0] === page,
    url: page.url(),
    submissionStage: guardState.submissionStage,
  });
  if (refusal !== null) {
    guardState.ledger.recordInvariantViolation({ code: 'INTERACTION_FREEZE_ACTIVATION_FAILED', message: refusal });
    await invalidateContext(context, guardState.ledger);
    throw new Error(refusal);
  }
  enterInteractionFreeze(guardState);
}

/**
 * COV-2c（SREV-COV の C-1。網羅の設計書）: 凍結の段（`FROZEN_ACTIVE`）の Context で、指定した行き先（http(s) の URL。fragment は比べない）への main frame の文書の
 * 移動（GET）を、凍結の読み取りと同じ判定（`isFrozenReadAdmissible` と監査の段の判定）で通す口を開け、閉じる口を返す。操作さがしの押下から生まれた移り先を、読み込みの
 * 最初から凍結した Context で読むために、factory だけが使う（`BrowserContextFactory.loadFrozenDocument`）。通した要求のリダイレクトの先は、口の行き先を移して同じ判定に
 * かける（ログインの画面への転送を見分けるため）。ほかの行き先と、読み取りでない移動は、今どおり凍結で止める。移った後の文書の JS の送信も、凍結の決まりのまま（読み取りでない送信は観察の口が受けて止める）。凍結の段でない・page がただ 1 つの
 * 準備のできた page でない・行き先が http(s) でないときは、何もせずに `Error`。開いている口があれば、新しい行き先に替える。
 */
export function admitFrozenMainFrameDocument(page: Page, url: string): () => void {
  const guardState = requireActiveGuardState(page.context(), ['FROZEN_ACTIVE']);
  if (page.isClosed() || guardState.pageGuards.get(page)?.status !== 'READY') {
    throw new Error('A frozen document load requires the current guarded page to be ready');
  }
  const activePages = page.context().pages().filter((candidate) => !candidate.isClosed());
  if (activePages.length !== 1 || activePages[0] !== page) {
    throw new Error('A frozen document load requires exactly one current owner page');
  }
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new Error('A frozen document load requires an HTTP(S) URL');
  }
  if (!isHttpProtocol(target.protocol)) {
    throw new Error('A frozen document load requires an HTTP(S) URL');
  }
  const admitted: FrozenMainFrameDocumentAdmission = { url: frameDocumentKeyOf(target.href) };
  guardState.frozenMainFrameDocument = admitted;
  return () => {
    if (guardState.frozenMainFrameDocument === admitted) {
      guardState.frozenMainFrameDocument = null;
    }
  };
}

/** COV-2c（C-1）: 凍結の段で通す main frame の文書の移動の口（行き先は、リダイレクトの続きで移る）。 */
interface FrozenMainFrameDocumentAdmission {
  url: string;
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
  if (options.egressFreeze !== undefined && typeof options.egressFreeze !== 'function') {
    throw new TypeError('Passive request guard egress freeze must be a function');
  }
  // DEF-276-relay: 中継の口は、出口の中継の待ち受けを持ち、凍結の口と一緒に受ける（凍結と閉じで切るため）。ログインの段と書き込みの段には渡さない。
  const relay = options.webSocketRelay;
  if (relay !== undefined && (!isRecord(relay) || !isRecord(relay.proxy) || typeof relay.proxy.host !== 'string'
    || !Number.isSafeInteger(relay.proxy.port) || options.egressFreeze === undefined || options.loginStage !== undefined || options.writeStage !== undefined)) {
    throw new TypeError('Passive request guard WebSocket relay is malformed');
  }
  if (options.onMainFrameDocumentSent !== undefined && typeof options.onMainFrameDocumentSent !== 'function') {
    throw new TypeError('Passive request guard main frame document sent hook must be a function');
  }
  // DEF-100 fix: main frame の文書の要求を送った時刻の記録の口（取り付けの時点の写し）。口の例外は違反に記録し、投げない。
  const mainFrameDocumentSentHook = options.onMainFrameDocumentSent;
  const recordMainFrameDocumentSent = (): void => {
    if (mainFrameDocumentSentHook === undefined) return;
    try {
      mainFrameDocumentSentHook();
    } catch (error) {
      ledger.recordInvariantViolation({ code: 'GUARD_DOCUMENT_SENT_RECORD_FAILED', message: errorMessage(error) });
    }
  };
  if (options.onEgressDestinationAdmitted !== undefined && typeof options.onEgressDestinationAdmitted !== 'function') {
    throw new TypeError('Passive request guard egress destination hook must be a function');
  }
  // DEF-125: Guard が通した要求（`decideGuardRequest` の `ALLOW`）の宛先を、出口の中継に知らせる口（取り付けの時点の写し）。3 つの層の判定の直後に、
  // 命令を送る前に呼ぶ（中継に来る CONNECT より先に知らせる）。口の例外は違反に記録し、投げない。
  const egressDestinationHook = options.onEgressDestinationAdmitted;
  const admitEgressDestinationOf = (verdict: GuardRequestVerdict, layer: GuardRequestLayer): void => {
    if (verdict.kind !== 'ALLOW' || egressDestinationHook === undefined) return;
    try {
      // BN-R0 fix round 1（I-1）: method も渡す（中継が、Guard が通したページの文書でない読み取りを見分ける）。
      // DEF-208-1: 凍結の段で通した読み取りは、印を渡す（中継が、凍結の後でもその写しに当たる読み取りだけを通す）。
      // SREV-SAFE の M-2: 知らせた層も渡す（1 つの要求を CDP の層と route の層の両方が知らせるので、中継の写しは CDP の層の知らせだけを数える）。
      if (verdict.frozenRead === true) {
        egressDestinationHook(verdict.request.url, verdict.request.method, true, layer);
      } else {
        egressDestinationHook(verdict.request.url, verdict.request.method);
      }
    } catch (error) {
      ledger.recordInvariantViolation({ code: 'GUARD_EGRESS_ADMISSION_FAILED', message: errorMessage(error) });
    }
  };
  if (options.onEgressDestinationWithdrawn !== undefined && typeof options.onEgressDestinationWithdrawn !== 'function') {
    throw new TypeError('Passive request guard egress withdrawal hook must be a function');
  }
  // SREV-SAFE の N-1: route の層が止めた要求を、中継に知らせる（CDP の層の知らせで数えた写しを 1 つ戻す）。口の例外は違反に記録し、投げない。
  const egressWithdrawalHook = options.onEgressDestinationWithdrawn;
  const withdrawEgressDestinationOf = (verdict: GuardRequestVerdict): void => {
    if (verdict.kind === 'ALLOW' || egressWithdrawalHook === undefined || !('request' in verdict) || verdict.request === null) return;
    try {
      egressWithdrawalHook(verdict.request.url, verdict.request.method);
    } catch (error) {
      ledger.recordInvariantViolation({ code: 'GUARD_EGRESS_ADMISSION_FAILED', message: errorMessage(error) });
    }
  };
  if (options.loginStage !== undefined && options.writeStage !== undefined) {
    throw new TypeError('Passive request guard cannot combine the login stage and the write stage');
  }
  // T35b: 監査の段の指定は、送信の段の指定と一緒には受けない（factory はどちらか 1 つだけを渡す）。
  // T39b: API の書き込みの段の指定とは一緒に受ける（書き込みの段でも、承認したサービスの Origin の読み取りを、監査の段と同じ判定と上限で通す）。
  if (options.auditStage !== undefined && (options.loginStage !== undefined
    || (options.writeStage !== undefined && (options.writeStage as Partial<GuardApiWriteStage>).transport !== API_SCENARIO_TRANSPORT))) {
    throw new TypeError('Passive request guard cannot combine the audit stage with the login stage or the form write stage');
  }
  // AS-a: 監査の段の送信の扱いの指定は、形を確かめ、ログインの段の指定と一緒には受けない（今の決まりのまま）。
  // OP-N（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.7 の N2）: 書き込みの段の指定とは一緒に受ける（判定は要求の判定の owner の
  // `writeStageAuditSendApplies`。WebSocket には使わない）。書き込みの段では、ほかの Origin への事前確認の送り手（`auditSendPreflight`）は受けない（書き込みの段は
  // 許可 Origin と承認したサービスの Origin のほかへ送らないので、使わない）。
  if (options.auditSend !== undefined && !isGuardAuditSend(options.auditSend)) {
    throw new TypeError('Passive request guard audit send policy is malformed');
  }
  if (options.auditSend !== undefined && options.loginStage !== undefined) {
    throw new TypeError('Passive request guard cannot combine the audit send policy with the login stage');
  }
  // RB-4b: リアルタイムの通信を止めない指定は、Isolated Interaction Context（凍結の読み取りの印 `admitFrozenReads`）とログインの段とは一緒に受けない
  // （fail-closed）。PRIMARY の Passive の Context（送らずに観察する probe の口）は、`PASS_EXCEPT_DELETE` と同じく受ける。
  if (
    options.realtimePassThrough !== undefined
    && (options.realtimePassThrough !== true || options.loginStage !== undefined || options.admitFrozenReads === true)
  ) {
    throw new TypeError('Passive request guard realtime pass-through is malformed or combined with a freezable Context or the login stage');
  }
  if (options.auditSendPreflight !== undefined && options.writeStage !== undefined) {
    throw new TypeError('Passive request guard cannot combine the audit send preflight with the write stage');
  }
  // OP-Q（Q1）: 書き込みの作業の中の Passive の Context（印 `writeJobEndpoint`）も、ほかの Origin への事前確認の送り手を受けない（許可 Origin と承認したサービスの
  // Origin のほかへ送らない）。
  if (options.auditSendPreflight !== undefined && options.auditSend?.writeJobEndpoint !== undefined) {
    throw new TypeError('Passive request guard cannot combine the audit send preflight with the write job audit send policy');
  }
  // T37b: 送らずに観察する probe の口は、ログインの段と書き込みの段の指定と一緒には受けない（factory は PRIMARY の Passive の Context だけに渡す）。
  if (options.submissionObservation !== undefined && (options.loginStage !== undefined || options.writeStage !== undefined)) {
    throw new TypeError('Passive request guard cannot combine the submission observation with the login stage or the write stage');
  }
  // 凍結の読み取りを通す印（Isolated Interaction Context）も、ログインの段と書き込みの段の指定と一緒には受けない。
  if (options.admitFrozenReads !== undefined && (options.admitFrozenReads !== true || options.loginStage !== undefined || options.writeStage !== undefined)) {
    throw new TypeError('Passive request guard cannot combine the frozen read admission with the login stage or the write stage');
  }
  const frozenReadsAdmitted = admitsFrozenReads(options);
  // T30b: 書き込みの段の指定は、取り付けの前に確かめて写す（形が違う、部品がすでに別の Guard に付いている、は `TypeError`）。
  const writeStage = options.writeStage === undefined ? undefined : acceptWriteStage(options.writeStage);
  // T37b: 観察の口を付ける（口でない、すでに別の Guard に付いている、は `TypeError`）。
  const submissionObservation = options.submissionObservation;
  if (submissionObservation !== undefined) {
    attachSubmissionObservation(submissionObservation);
  }
  /**
   * T37b: 凍結の段で止めた要求を、観察の口に渡す（口が有効の間だけ口が受ける。読み取りでない要求の本文は、口が型を作るときだけ読む）。止め方と記録は
   * 変えない。
   */
  const observeFrozenRequest = (
    request: GuardRequestIdentity | null,
    event: PausedDocumentEvent,
  ): void => {
    if (submissionObservation === undefined || request === null) return;
    recordObservedFrozenRequest(submissionObservation, {
      method: request.method,
      url: request.url,
      resourceType: requestResourceTypeOf(event.resourceType),
      headers: event.request.headers,
      body: () => requestBodyTextOf(event.request.hasPostData, event.request.postDataEntries),
    });
  };
  /**
   * DEF-208-1: 凍結の段の、凍結の読み取りの判定の口（凍結の読み取りを通す Guard だけ。`admitsFrozenReads`: 観察の口のある Guard と、Isolated Interaction Context
   * の Guard。ほかの Guard は省略して、今どおり凍結の段ですべて止める）。判定は `isFrozenReadAdmissible` の 1 か所。token の更新は観察の口のある Guard だけ
   * （`frozenTokenRefreshAdmitted` が口を見る）。
   */
  const frozenReadOf = (
    facts: Omit<HttpRequestFacts, 'kind'>,
    policy: () => PassiveRequestPolicyOptions | undefined,
    body: () => RequestBodyText = () => NO_BODY_TEXT,
    headers: Readonly<Record<string, string>> | undefined = undefined,
  ): ((request: GuardRequestIdentity) => boolean) | undefined =>
    (!frozenReadsAdmitted
      ? undefined
      : (): boolean => {
        const current = policy();
        return (isFrozenReadAdmissible({ kind: 'HTTP', ...facts }, authoritySnapshot, current) && frozenNonReadAllowedHere(facts.method, facts.url, body))
          || frozenTokenRefreshAdmitted(facts, current, body, headers)
          || frozenMainFrameDocumentAdmitted(facts, current);
      });
  /**
   * SAFE-2 の 3: 凍結の読み取りの判定に当たった要求のうち、読み取りでないもの（登録した読み取りの手続きの呼び出し）を、この Guard で通してよいか。観察の口のある
   * Guard（操作さがし）だけで、本文と URL に観察の目印を含まないときだけ通す（目印を含む呼び出しは、押下で出た送信として、今どおり凍結で止めて観察の口に渡す）。
   * Isolated Interaction Context の Guard（観察の口がない）は、押下で出た送信を見分けられないので、読み取りでない要求を通さない。読み取りは、いつも真。
   */
  const frozenNonReadAllowedHere = (method: string, url: string, body: () => RequestBodyText): boolean =>
    isReadMethod(method)
    || (submissionObservation !== undefined && !frozenRequestCarriesObservedMarker(submissionObservation, url, body));
  /**
   * COV-2c（SREV-COV の C-1。網羅の設計書）: 凍結の段で、呼ぶ側が指定した行き先（`admitFrozenMainFrameDocument`）への main frame の文書の移動（GET）か。判定は
   * 凍結の読み取りの判定（`isFrozenReadAdmissible`）を共用する（main frame の移動でない読み取りと同じ条件を当てる。別の比べ方を作らない）。真なら、Guard が監査の段の
   * 判定にかけて通す（`frozenRead` の印つき）。指定がない・行き先が違う・読み取りでない・判定に当たらないときは偽（今どおり凍結で止める）。
   */
  const frozenMainFrameDocumentAdmitted = (facts: Omit<HttpRequestFacts, 'kind'>, policy: PassiveRequestPolicyOptions | undefined): boolean => {
    const admitted = guardState.frozenMainFrameDocument;
    return admitted !== null && facts.isNavigationRequest && facts.isMainFrame && facts.method === 'GET'
      && frameDocumentKeyOf(facts.url) === admitted.url
      && isFrozenReadAdmissible({ kind: 'HTTP', ...facts, isMainFrame: false }, authoritySnapshot, policy);
  };
  /**
   * COV-2c（C-1）: 通した行き先の main frame の文書の要求がリダイレクトされたら、口の行き先を、そのリダイレクトの先に移す（1 つの読み込みの続きだけを追う。
   * ログインの画面への転送でセッションの切れを見分けられるように）。先も、上の判定（凍結の読み取りと同じ判定）にかける。リダイレクトでない・前の要求が口の行き先で
   * ないときは何もしない。
   */
  const followFrozenMainFrameDocumentRedirect = (predecessorUrl: string | undefined, url: string, isMainFrame: boolean): void => {
    const admitted = guardState.frozenMainFrameDocument;
    if (admitted !== null && isMainFrame && predecessorUrl !== undefined && frameDocumentKeyOf(predecessorUrl) === admitted.url) {
      admitted.url = frameDocumentKeyOf(url);
    }
  };
  /** fix round 3（N-1）: 凍結の段で通す更新の比べの相手（factory の口。なければ・例外は null で、凍結の段の更新を通さない）。 */
  const frozenTokenRefreshReferenceOf = (): FrozenRefreshReference | null => {
    try {
      return options.frozenTokenRefreshReference?.() ?? null;
    } catch {
      return null;
    }
  };
  /**
   * DEF-233（設計書 `2026-11-09-beaksight-discovery-token-refresh-design.md` 2.1）: 凍結の段で通してよいサイトの token の更新か（観察の口のある Guard だけ。
   * 判定は `isFrozenTokenRefreshAdmissible` の 1 か所。目印は、その口で始めた観察のすべての目印で、URL と本文を照らす）。fix round 3（N-1）: 本文と header は、
   * 凍結の前に確かめた更新と同じ形で、本文の値は今の鍵の値だけ（押下の観察の間も同じ判定。Blocker 1 の後の設計者の判断 (a)）。
   */
  const frozenTokenRefreshAdmitted = (
    facts: Omit<HttpRequestFacts, 'kind'>,
    policy: PassiveRequestPolicyOptions | undefined,
    body: () => RequestBodyText,
    headers: Readonly<Record<string, string>> | undefined,
  ): boolean => {
    const observation = submissionObservation;
    return observation !== undefined && policy !== undefined
      && isFrozenTokenRefreshAdmissible({ kind: 'HTTP', ...facts }, policy, {
        body,
        headers,
        reference: frozenTokenRefreshReferenceOf(),
        carriesMarker: () => frozenRequestCarriesObservedMarker(observation, facts.url, body),
      }, frozenTokenRefreshQueryValuesOf());
  };
  /** fix round 2: Run の中で凍結の前に通した更新の必須の query の値（factory の口。なければ・例外は空）。 */
  const frozenTokenRefreshQueryValuesOf = (): ReadonlyMap<string, ReadonlySet<string>> => {
    try {
      return options.frozenTokenRefreshQueryValues?.() ?? NO_LEARNED_QUERY_VALUES;
    } catch {
      return NO_LEARNED_QUERY_VALUES;
    }
  };
  /**
   * fix round 2（SREV-233 の C-1）: 凍結の段の、token の更新の事前確認を Guard が満たしてよいか（本文がないので、URL と方針の判定と、URL の目印だけを見る。
   * 本番の要求は、満たした後に中身で判定する。事前確認はサーバへ送らない）。
   */
  const frozenTokenRefreshPreflightAdmitted = (facts: Omit<HttpRequestFacts, 'kind'>, policy: PassiveRequestPolicyOptions | undefined): boolean => {
    const observation = submissionObservation;
    return observation !== undefined && policy !== undefined
      && isFrozenTokenRefreshAdmissible({ kind: 'HTTP', ...facts }, policy, null, frozenTokenRefreshQueryValuesOf())
      && !frozenRequestCarriesObservedMarker(observation, facts.url, () => NO_BODY_TEXT);
  };
  /**
   * fix round 2（SREV-233 の M-3）・fix round 3: token の更新の形の要求を通したことを、要求の header と本文とともに factory に知らせる（CDP の層だけ）。口の例外は
   * 違反に記録する。
   */
  const notifyTokenRefreshAdmitted = (
    verdict: GuardRequestVerdict,
    policy: PassiveRequestPolicyOptions | undefined,
    headers: Readonly<Record<string, string>> | undefined,
    body: () => RequestBodyText,
  ): void => {
    const hook = options.onTokenRefreshAdmitted;
    if (hook === undefined || verdict.kind !== 'ALLOW' || policy === undefined || !isTokenRefreshRequest(verdict.request, policy)) return;
    try {
      const text = body();
      hook(verdict.request.url, verdict.frozenRead === true, { headers: { ...(headers ?? {}) }, body: text.kind === 'TEXT' ? text.text : null });
    } catch (error) {
      ledger.recordInvariantViolation({ code: 'GUARD_TOKEN_REFRESH_NOTICE_FAILED', message: errorMessage(error) });
    }
  };
  /**
   * DEF-233（設計書 2.1 の 3）: 凍結で止めた要求が token の更新の形なら、監査の段の記録の `TOKEN_REFRESH` に数える（`tokenRefreshBlocked`。止め方と Safety Ledger の
   * 記録は変えない）。監査の段の口がない Guard は数えない。
   */
  const countFrozenTokenRefreshBlocked = (request: GuardRequestIdentity | null, policy: PassiveRequestPolicyOptions | undefined): void => {
    if (request === null || policy === undefined || auditMonitor === undefined || !isTokenRefreshRequest(request, policy)) return;
    const state = auditStageStateOf(auditMonitor);
    state.blockedByReason.TOKEN_REFRESH = saturatingIncrement(state.blockedByReason.TOKEN_REFRESH);
  };
  /**
   * DEF-208-1: 凍結の段で通した読み取りを、page の数に数える（CDP の層だけが呼ぶ。目印を運んだものは別にも数える）。DEF-233: 通した token の更新（読み取りで
   * ない）は、読み取りの数に入れず、別に数える。
   */
  const countFrozenRead = (page: Page, verdict: GuardRequestVerdict, policy: PassiveRequestPolicyOptions | undefined = undefined): void => {
    if (verdict.kind !== 'ALLOW' || verdict.frozenRead !== true) return;
    const state = mainFrameNavigationStateOf(page);
    // SAFE-2 の 3: 登録した読み取りの手続きの呼び出し（読み取りでないが、token の更新の形でない）は、読み取りの数に入れる。
    if (!isReadMethod(verdict.request.method) && (policy === undefined || isTokenRefreshRequest(verdict.request, policy))) {
      state.frozenTokenRefreshRequests = saturatingIncrement(state.frozenTokenRefreshRequests);
      return;
    }
    state.frozenReadRequests = saturatingIncrement(state.frozenReadRequests);
    if (submissionObservation !== undefined && frozenReadCarriesObservedMarker(submissionObservation, verdict.request.url)) {
      state.frozenMarkerReadRequests = saturatingIncrement(state.frozenMarkerReadRequests);
    }
  };
  /**
   * DEF-208-1: 凍結の段で通した子の frame の文書の URL（fragment を外した形。止めた移動の記録と見分ける）。L10（INV-LIMITS の N22）: 数の上限（前は
   * `MAX_FROZEN_FRAME_DOCUMENTS` 256 で、古いものから捨てた）は撤廃した。Context の寿命まで持つ。
   */
  const frozenFrameDocuments = new Set<string>();
  /**
   * SREV-SAFE の I-4: page ごとの、main frame の文書の替わり（page の session の CDP の `Page.frameNavigated`）の受け口。page の session の準備で付ける外部スキームの
   * 検出の listener（`EXTERNAL_NAVIGATION_CDP_EVENTS`）から呼ぶ（同じ事象に listener を重ねない）。
   */
  const mainFrameDocumentObservers = new WeakMap<Page, (params: unknown, rootFrameId: string) => void>();
  const rememberFrozenFrameDocument = (verdict: GuardRequestVerdict): void => {
    if (verdict.kind !== 'ALLOW' || verdict.frozenRead !== true) return;
    frozenFrameDocuments.add(frameDocumentKeyOf(verdict.request.url));
  };
  // DEF-099 fix: 書き込みの段は、送り手の指定が必ず要る（ないなら、ブラウザに送らせないために取り付けない）。
  const acceptedWriteSubmission = writeStage === undefined ? undefined : acceptWriteSubmission(options.writeSubmission);
  // DEF-099 fix round 1: Guard が閉じ始めるときに、送信中の送り手を止める口。
  const writeSubmissionAbort = acceptedWriteSubmission === undefined ? undefined : new AbortController();
  const writeSubmission = acceptedWriteSubmission === undefined || writeSubmissionAbort === undefined
    ? undefined
    : Object.freeze({ ...acceptedWriteSubmission, signal: writeSubmissionAbort.signal });
  // AS-c fix round 1（I-1）: 監査の段の送信の扱いの、ほかの Origin への事前確認の送り手（`auditSend` と一緒のときだけ。時間の上限は名前つきの値）。
  const auditSendPreflightAbort = new AbortController();
  const auditSendPreflight = options.auditSend === undefined || options.auditSendPreflight === undefined
    ? undefined
    : Object.freeze({
      ...acceptWriteSubmission(options.auditSendPreflight),
      timeoutMs: AUDIT_SEND_PREFLIGHT_TIMEOUT_MS,
      signal: auditSendPreflightAbort.signal,
    });

  const authoritySnapshot = new Set(allowedOrigins);
  // T25b（Task 25 の設計書 4.2）: ログインの段の指定がある場合だけ、POST の数え方を持つ。T30b: 書き込みの段の指定がある場合も、同じ数え方を
  // 持つ（送信先は承認の要求の形の 1 つ、回数は 1）。どちらもない場合は、判定に口を渡さない（今と同じ）。
  const submissionAdmission = options.loginStage !== undefined
    ? new SubmissionPostAdmission(
      'LOGIN_STAGE',
      options.loginStage.loginPostEndpoints,
      options.loginStage.maxLoginPosts,
      options.loginStage.monitor instanceof LoginStageMonitor ? options.loginStage.monitor : new LoginStageMonitor(),
      // T34b: スクリプトで送るログインの指定（ある場合だけ。写しを取る）。
      options.loginStage.scriptRequest,
      undefined,
      // ML-a: 手動のログインの段の印（判定の口に渡す。自動ログインの資格情報の部品とは一緒に受けない）。
      options.loginStage.manualPassThrough === true && options.loginStage.credentialGuard === undefined,
      // T44R の M-1: 手動のログインの段の、token の送信先がまだない設定の承認したサービスの Origin（スクリプトの口があれば使わない）。
      options.loginStage.manualServiceReadOrigins,
      undefined,
      undefined,
      // DEF-193: 自動ログインの段の通し方の印（資格情報の部品のある、スクリプトで送るログインの段だけ。資格情報の守りなしには通さない）。
      options.loginStage.credentialGuard !== undefined && options.loginStage.automatedPassThrough === true,
    )
    : writeStage === undefined
      ? undefined
      : writeStage.transport === API_SCENARIO_TRANSPORT
        // T39b: API の書き込みの段の送信先は、承認した API の Origin と path の型（数え方は form と同じ 1 回。照合にかけるのは窓の中の 1 回目だけ）。
        ? new SubmissionPostAdmission(
          'WRITE_STAGE',
          [{ origin: writeStage.expectation.spec.request.origin, path: writeStage.expectation.spec.request.pathShape }],
          WRITE_STAGE_MAX_POSTS,
          writeStage.monitor,
          undefined,
          writeStage.expectation.spec.request.origin,
          false,
          undefined,
          // LU-5（fix round 1 の案 A）: 照合へ回す要求の path（照合の側の唯一の部品。窓の前の守りは、上の送信先の path の型のまま）。
          apiWriteCheckPathOf(writeStage.expectation) ?? '',
          undefined,
          false,
          // L12a: 押した後の扱い（送信の扱いの口があるときだけ）。
          options.auditSend !== undefined,
        )
        : new SubmissionPostAdmission(
          'WRITE_STAGE',
          [{ origin: writeStage.expectation.request.origin, path: writeStage.expectation.request.path }],
          WRITE_STAGE_MAX_POSTS,
          writeStage.monitor,
          undefined,
          undefined,
          false,
          undefined,
          undefined,
          // LU-SFIX3-B: 窓の前（N2）に守る送信先の path の型（フォームの更新で、送信先の最後の区切りが対象の番号のときだけ）。
          writeStage.guardedPathShape,
          false,
          // L12a: 押した後の扱い（送信の扱いの口があるときだけ）。
          options.auditSend !== undefined,
        );
  // T36b（Task 36 の設計書 3.3・3.4）: 自動ログインの資格情報の部品（スクリプトで送るログインの段だけ。渡された値をそのまま使う。作り方の違う部品は、
  // 比べの部品がどの送信にも含まれるとみなす）と、token の送信の応答の観測（ログインの段の記録の中）。
  const scriptLoginStage = options.loginStage?.scriptRequest;
  const credentialGuard = scriptLoginStage === undefined ? undefined : options.loginStage?.credentialGuard;
  /**
   * T36b（設計者の判断で範囲を広げた。T36a の懸念）: 自動ログインのログインの段で、判定が通した要求のうち、承認した token の送信のほかのすべて
   * （main frame・sub frame のナビゲーション、読み取り、ページの送信、Worker など）の URL と本文に、入れた資格情報が含まれていれば、止める判定に替える。
   * CDP の層（要求と文書）と route の層の、すべての判定の口で同じに当てる。本文は、要るときだけ読む（`bodyOf`）。
   * T36R-fix（T36R の C-1・M-8）: 要求のヘッダの値と、その要求に付く Cookie（判定の前に `cookieTextsFor` で読んだもの）も比べる。読み取りかは、要求の
   * 判定の owner の `isReadMethod` で決めて渡す（ユーザー名は、読み取りでない要求だけで比べる）。
   */
  const credentialCheckedDecision = (
    decision: PassiveRequestDecision,
    request: { readonly method: string; readonly url: string; readonly headers: Readonly<Record<string, string>> | undefined },
    bodyOf: () => RequestBodyText,
    cookies: CookieTexts,
  ): PassiveRequestDecision => (
    credentialGuard !== undefined
      && decision.action === 'ALLOW'
      && decision.loginStageAdmission?.kind !== 'SCRIPT_LOGIN_TOKEN'
      && carriesLoginCredential(credentialGuard, {
        url: request.url,
        readMethod: isReadMethod(request.method),
        body: bodyOf(),
        headers: request.headers,
        cookies,
      })
      ? LOGIN_CREDENTIAL_DECISION
      : decision
  );
  /**
   * T36R-fix（T36R の C-1）: 要求に付く Cookie（名前と値）を、判定の前（送る前）に読む。自動ログインの部品があるときだけ。ブラウザの Context の Cookie
   * の保存（`BrowserContext.cookies(url)`。その URL に付きうる Cookie。送り方による絞り込みはしないので、付かない Cookie も含みうる。止めすぎは安全の
   * 側）から読む。http(s) でない URL は、付く Cookie がない。読めなければ、含まれるとみなす（`UNREADABLE_COOKIES`。fail-closed）。
   */
  const cookieTextsFor = async (url: string): Promise<CookieTexts> => {
    if (credentialGuard === undefined || !isHttpUrlText(url)) {
      return NO_COOKIES;
    }
    try {
      return cookieTextsOf(await context.cookies(url));
    } catch {
      return UNREADABLE_COOKIES;
    }
  };
  /** T36b: 自動ログインの資格情報の値を捨てる（Context を閉じたときと、Guard の後片付け。何度呼んでもよい）。 */
  const discardCredentialGuard = (): void => {
    if (isLoginCredentialGuard(credentialGuard)) {
      discardLoginCredentialGuard(credentialGuard);
    }
  };
  const loginMonitor = submissionAdmission?.monitor instanceof LoginStageMonitor ? submissionAdmission.monitor : undefined;
  const tokenResponseTracker = scriptLoginStage === undefined || loginMonitor === undefined
    ? undefined
    : loginStageStateOf(loginMonitor).tokenResponses;
  if (loginMonitor !== undefined && credentialGuard !== undefined) {
    // T36R-fix（T36R の I-1）: 方針で止めた要求を、止めた一覧に入れる前に比べるため、記録に部品を置く。
    loginStageStateOf(loginMonitor).credentialGuard = credentialGuard;
  }
  /**
   * T30b: 書き込みの段の、送信の窓を開いたときに読んだ文書の事実（どの page の main frame の文書か、その文字コード）。読んだ後に、その page の
   * main frame の文書が変わったら、文字コードを捨てる（`null`）。
   */
  const writeDocument: { page: Page | null; charset: string | null } = { page: null, charset: null };
  /** T39b: API の書き込みの段の指定（form の書き込みの段とほかの段は undefined）。 */
  const apiWriteStage = writeStage?.transport === API_SCENARIO_TRANSPORT ? writeStage : undefined;
  /**
   * T39b: API の書き込みの段で、送信の窓を開いた page（`WriteStageMonitor.openSubmissionWindow(page)`）。照合にかけるのは、この page の main frame の
   * ページのスクリプトの要求だけ（ポップアップなど、ほかの page の要求は照合にかけない）。
   */
  let apiWriteWindowPage: Page | null = null;
  /** T30b: 書き込みの段で、Guard が通した承認の POST（page と CDP の Fetch の要求の ID。応答の段階を対応付ける）。 */
  let admittedWritePost: { readonly page: Page; readonly requestId: string } | null = null;
  // T25b round 1（Task 25 の設計書 4.2）: 監査の段の除外の指定がある場合だけ、その写しを、route の層・CDP の層・`requestfailed` の
  // 判定のすべてに渡す。ない場合は、口を渡さない（今と同じ）。
  const auditExclusions = options.auditExclusions === undefined ? undefined : snapshotAuditExclusions(options.auditExclusions);
  // T35b（Task 35 の設計書 3.2、3.4）: スクリプトで送るログインの監査の段の指定がある場合だけ、登録した読み取りの手続きの呼び出しの数え方と、承認した
  // サービスの Origin への要求の上限の部品と、監査の段の記録を持つ。
  const auditReadAdmission = options.auditStage === undefined ? undefined : new AuditReadAdmission(options.auditStage);
  const serviceRequestBudget = options.auditStage?.serviceRequestBudget;
  /** T35R-fix: 上限の部品で数える、承認したサービスの Origin（取り付けの時点の写し）。 */
  const countedServiceOrigins: ReadonlySet<string> = new Set((options.auditStage?.approvedServiceOrigins ?? []).map((origin) => String(origin)));
  const auditMonitor = auditReadAdmission?.monitor;
  /**
   * T35b: 判定が通した要求が、承認したサービスの Origin への要求で、上限の部品が断ったら、上限で止めた判定を返す（数えて通すなら `null`）。CDP の層で
   * 通す前に、1 つの要求に 1 回だけ呼ぶ（route の層では数えない）。T35R-fix（T35R の C-1）: 印がなくても、URL が承認したサービスの Origin なら数える。
   */
  const serviceRequestLimitOf = (decision: PassiveRequestDecision, url: string): BlockDecision | null => {
    if (
      decision.action !== 'ALLOW'
      || serviceRequestBudget === undefined
      || !(isCountedServiceRequest(decision.auditStageAdmission) || hasAllowedOrigin(url, countedServiceOrigins))
    ) {
      return null;
    }
    return serviceRequestBudget.tryConsume() ? null : SERVICE_REQUEST_LIMIT_DECISION;
  };
  // AS-a（設計書 `2026-10-19-beaksight-audit-send-policy-design.md` 2.2）: 監査の段の送信の扱いの指定がある場合だけ、通した数の数え方を持ち、その口を
  // route の層・CDP の層・`requestfailed` の判定のすべてに渡す。ない場合は、口を渡さない（今と同じ）。
  // AS-c の WebSocket の Blocker の判断 W1: 監査の段の送信の扱いの口がある Context（`PASS_EXCEPT_DELETE` の Passive の Context。Interaction・ログインの段・
  // 書き込みの段には口が渡らない）だけ、文書と http(s) の script の Worker の CSP に `ws:`・`wss:` を足す。ほかは今のまま（`WORKER_CONNECT_POLICY`）。
  // OP-N: 書き込みの段は、送信の扱いの口があっても WebSocket を通さないので、今のまま（`WORKER_CONNECT_POLICY`）。
  // OP-Q（Q1）: 書き込みの作業の中の Passive の Context（印 `writeJobEndpoint`）も、WebSocket を通さないので、今のまま。
  // RB-4b: リアルタイムの通信を止めない指定があれば、送信の扱いと段によらず `ws:`・`wss:` を許す（Worker の中の接続も止めない）。
  const realtimePassThrough = options.realtimePassThrough === true;
  // RB-4b: Isolated Interaction Context（`admitFrozenReads`）は、送信の扱いの口があっても、押した後の凍結を迂回させないため、今どおり WebSocket を止める。
  // RB-4 fix（REV-RB4 の C-1）: 凍結しうる Context（`admitsFrozenReads`。観察の口のある発見の PRIMARY も）は、リアルタイムの通信を止めない指定があっても、Worker の
  // 中の WebSocket を止める（凍結の後は CSP を替えられず、中継は凍結の読み取りで通した host:port への CONNECT を通し続けるため）。
  // DEF-276: ただし、凍結の後に押さない口（`freezeOnlyForReading`。押す観察を始められない）の Context は、凍結の前のリアルタイムの通信を止めない。
  const pressesAfterFreeze = options.admitFrozenReads === true
    || (options.submissionObservation !== undefined && observationPressesAfterFreeze(options.submissionObservation));
  const connectPolicy = pressesAfterFreeze
    || (!realtimePassThrough
      && (options.auditSend === undefined || writeStage !== undefined || options.auditSend.writeJobEndpoint !== undefined))
    ? WORKER_CONNECT_POLICY
    : AUDIT_SEND_CONNECT_POLICY;
  // AS-c: ほかの Origin の見分けには、許可 Origin と、口の承認したサービスの Origin と、監査の段の承認したサービスの Origin を使う。
  const auditSendAdmission = options.auditSend === undefined
    ? undefined
    : new AuditSendAdmission(options.auditSend, new Set([...authoritySnapshot, ...(options.auditStage?.approvedServiceOrigins ?? [])]));
  /**
   * OP-N（N2）: WebSocket に使う、送信の扱いの数え方（書き込みの段では持たない。値を入れる前に開いた接続は、値を入れた後も開いたままになり、Guard が送受信を
   * 見ないため。WebSocket の判定・観察・記録は、今の書き込みの段のまま）。
   */
  // OP-Q（Q1）: 書き込みの作業の中の Passive の Context も持たない（WebSocket を通さない）。
  // RB-4b: Isolated Interaction Context（`admitFrozenReads`）も持たない（WebSocket を通さない。押した後の凍結を迂回させないため）。
  const webSocketAuditSendAdmission = writeStage === undefined && auditSendAdmission?.forWriteJob !== true && options.admitFrozenReads !== true
    ? auditSendAdmission
    : undefined;

  /** OP-N（N2）: CDP の層で、送信の扱いの口が通した要求を、書き込みの段の通した一覧に記録する（書き込みの段でなければ何もしない）。 */
  const recordWriteStagePassedOf = (request: GuardRequestIdentity, event: PausedDocumentEvent): void => {
    if (writeStage === undefined) {
      return;
    }
    recordWriteStagePassedRequest(writeStage.monitor, {
      method: request.method,
      url: request.url,
      resourceType: requestResourceTypeOf(event.resourceType),
      body: () => requestBodyTextOf(event.request.hasPostData, event.request.postDataEntries),
    });
  };
  /**
   * DEF-210: 押す期間なら、判定の口に、閉じる押下の期間の扱いを足す（押す期間でなければ、そのまま）。REV-EV4: 領域のキーの押下の期間なら、その印も足す。
   */
  const withNotificationPress = (policy: PassiveRequestPolicyOptions | undefined): PassiveRequestPolicyOptions | undefined => {
    const mode = guardState.notificationPress;
    const pressed = mode === null ? policy : { ...policy, notificationPress: mode };
    // FRET: 窓を開くボタンの押す期間と、押した後に page を閉じるまでの続きは、読み取りでない要求も止める印を渡す。
    if (guardState.dialogPress || guardState.dialogPressHold) {
      return { ...pressed, scrollKeyPress: 'DIALOG_PRESS' };
    }
    return guardState.scrollKeyPress ? { ...pressed, scrollKeyPress: true } : pressed;
  };
  /** CDP の層の判定の口。 */
  const cdpRequestPolicy = (): PassiveRequestPolicyOptions | undefined => withNotificationPress(
    requestPolicyOf(submissionAdmission?.cdpStagePolicy(), auditExclusions, auditReadAdmission?.cdpPolicy(), auditSendAdmission?.policy()));
  /** route の層の判定の口（RB-4a の X2: 送信の扱いの口は CDP の層と同じ）。 */
  const routeRequestPolicy = (method: string, url: string): PassiveRequestPolicyOptions | undefined => withNotificationPress(
    requestPolicyOf(
      submissionAdmission?.routeStagePolicy(method, url),
      auditExclusions,
      auditReadAdmission?.routePolicy(method, url),
      auditSendAdmission?.policy(),
    ));
  /**
   * `requestfailed` の判定の口。ログインの段の口は渡さない（許したログインの POST の失敗は、今の POST と同じく違反にしない）。除外の口は
   * 渡す（CDP の層で止めた main frame の移動の失敗を、許した移動の失敗（`HTTP_MAIN_FRAME_DELIVERY_FAILED`）と取り違えないため）。AS-a: 監査の段の送信の
   * 扱いの口も渡す（ナビゲーションの判定は変わらない）。
   */
  const requestFailedPolicy = requestPolicyOf(undefined, auditExclusions, undefined, auditSendAdmission?.policy());
  /**
   * AS-c fix round 1（C-1・C-2。設計書 5 章の「AS-R … とユーザーの判断」の行）: Guard の route が通した WebSocket の接続（URL ごとの数。上限は 1 つの Context の
   * 接続の上限）。ブラウザが開いた接続の観察（`observeCreatedWebSockets`）で、同じ URL の接続を 1 つずつ照らして減らす。照らせない接続は、route を通らずに
   * 開いた接続（ページのスクリプトが模擬を迂回した接続、Worker の中の接続）で、記録に印 `outsideGuard` を付ける。
   * AS-c fix round 2（I-C。設計書 5 章の「AS-R2」の行）: 持つのは、route の通過ごとの照らし合わせの締め切り（`connectToServer()` を呼んだ時刻に
   * `AUDIT_SEND_WEBSOCKET_MATCH_WINDOW_MS` を足した時刻）。照らせるのは、`connectToServer()` を呼んだ後から締め切りまでに観察した接続だけ（それより前と
   * 後の接続は route の外）。締め切りを過ぎた通過は、照らさずに捨てる（古い通過が後の接続と照らし合わされない）。
   */
  const routeAdmittedWebSockets = new Map<string, number[]>();
  /** 締め切りを過ぎた route の通過を捨てる。 */
  const pruneRouteAdmittedWebSockets = (now: number): void => {
    for (const [key, deadlines] of routeAdmittedWebSockets) {
      const live = deadlines.filter((deadline) => deadline >= now);
      if (live.length === 0) {
        routeAdmittedWebSockets.delete(key);
      } else {
        routeAdmittedWebSockets.set(key, live);
      }
    }
  };
  /** route が通して `connectToServer()` を呼んだ接続の、照らし合わせの締め切りを置く。 */
  const admitRouteWebSocket = (url: string): void => {
    const now = Date.now();
    pruneRouteAdmittedWebSockets(now);
    const key = webSocketKeyOf(url);
    routeAdmittedWebSockets.set(key, [...(routeAdmittedWebSockets.get(key) ?? []), now + AUDIT_SEND_WEBSOCKET_MATCH_WINDOW_MS]);
  };
  /**
   * AS-a・AS-c: 監査の段の送信の扱いの口が通した要求を、Safety Ledger の通した要求の記録に残す（値は残さない。ほかの Origin へ通した要求かも数える）。
   * AS-c fix round 1（M-3）: 残すのは、ブラウザが送る時点（route の層が進める時点か、route を通らない要求を CDP の層が進める時点）。
   */
  /**
   * AS-c fix round 3（AS-R3 の B03・W4）: 監査の段の送信の扱いの口が CDP の層で進めた要求の、Network の要求の ID（リダイレクトの先の段を見分ける手がかり。
   * L10（INV-LIMITS の N22）: 数の上限は撤廃した。Context の寿命まで持つ）。
   */
  const auditSendNetworkIds = new Set<string>();
  const rememberAuditSendNetworkId = (networkId: string): void => {
    auditSendNetworkIds.add(networkId);
  };
  const recordPassedAuditSendRequest = (method: string, url: string): void => {
    if (auditSendAdmission !== undefined) {
      ledger.recordPassedAuditSendRequest({
        method, url, otherOrigin: auditSendAdmission.isOtherOrigin(url), ...(guardState.dialogPressLeaving ? { afterDialogPressLeave: true } : {}),
      });
    }
  };
  /** DEF-292 の残り: route の層の「通した」の記録を待つ要求（続ける命令の後に OOPIF の target が外れたら、ここから「通した」へ移す）。 */
  const awaitedRouteAuditSends = new AwaitedRouteAuditSends();
  /**
   * DEF-292 の残り: route の層が「通した」を記録する要求（Network の要求の ID のある、口が通した要求）を続ける。続ける前に記録待ちに置き、target が外れて命令が
   * 失敗したら（Chromium が解き放つ）、ここで「通した」に記録する。ほかの失敗では記録しない（今どおり違反）。
   */
  const continueRouteRecordedAuditSend = async (
    owner: object,
    ownerPage: Page,
    request: AwaitedRouteRequest,
    continueRequest: () => Promise<void>,
  ): Promise<void> => {
    const entry = awaitedRouteAuditSends.add(owner, ownerPage, request);
    let continued = false;
    await continueAllowedRequest(async () => {
      await continueRequest();
      continued = true;
    }, 'REQUEST', context, ledger, () => {
      // 命令を待つ間に target の外れで既に移した（記録した）行は、二重に記録しない。
      if (awaitedRouteAuditSends.withdraw(entry)) recordPassedAuditSendRequest(request.method, request.url);
    });
    if (!continued) awaitedRouteAuditSends.withdraw(entry);
  };
  /** DEF-292 の残り: OOPIF の target が外れた session の、route の層の記録待ちの要求を「通した」に記録する。 */
  const recordDetachedAwaitedAuditSends = (owner: object): void => {
    for (const { method, url } of awaitedRouteAuditSends.moveDetached(owner)) recordPassedAuditSendRequest(method, url);
  };
  const webSocketKeyOf = (url: string): string => {
    try {
      return new URL(url).href;
    } catch {
      return url;
    }
  };
  /** 観察した接続を、Safety Ledger の通した接続の記録に残す（止めない。Context も無効にしない）。 */
  const recordObservedWebSocket = ({ url }: ObservedWebSocket): void => {
    if (webSocketAuditSendAdmission === undefined) {
      return;
    }
    // AS-c fix round 2（I-C）: 締め切りの内の route の通過（同じ URL）があれば、いちばん古いものと照らす。
    pruneRouteAdmittedWebSockets(Date.now());
    const key = webSocketKeyOf(url);
    const [, ...rest] = routeAdmittedWebSockets.get(key) ?? [];
    const matched = routeAdmittedWebSockets.has(key);
    if (rest.length > 0) {
      routeAdmittedWebSockets.set(key, rest);
    } else {
      routeAdmittedWebSockets.delete(key);
    }
    const policy = requestPolicyOf(undefined, auditExclusions, auditReadAdmission?.cdpPolicy(), webSocketAuditSendAdmission.webSocketPolicy()) ?? {};
    ledger.recordPassedAuditSendWebSocket({ url, outsideGuard: !matched, dangerous: isAuditSendDangerousWebSocket(url, policy) });
  };
  /**
   * AS-c fix round 1: `page` に、ブラウザが開く WebSocket の接続の観察を付ける（Guard の横取りの session とは別の、観察のための session）。付けられなければ
   * （page が閉じる途中など）、観察なしとする（Guard の判定と page の準備は変えない。限界は `doc/spec/safety.md`）。session は page の後片付けで閉じる。
   */
  const observeAuditSendWebSockets = async (page: Page, listenerGroup: ListenerCleanupGroup): Promise<void> => {
    let session: CDPSession | undefined;
    try {
      session = await context.newCDPSession(page);
      const opened = session;
      // FRET fix round 4: 押す期間に、押す前から開いていた接続が送った frame を数える（止めない）。
      // fix round 5: 押した後の止めの続き（hold）の間に送った frame も、「押した後」の数として別に数える（止めない）。
      const stop = await observeCreatedWebSockets(opened, recordObservedWebSocket, () => {
        if (guardState.dialogPress) guardState.dialogPressWebSocketFrames = saturatingIncrement(guardState.dialogPressWebSocketFrames);
        else if (guardState.dialogPressHold) {
          guardState.dialogPressHoldWebSocketFrames = saturatingIncrement(guardState.dialogPressHoldWebSocketFrames);
          // fix round 5（設計者の判断 (A)）: 確かめの後に送った分も分かるように、Ledger に数える（止めない）。
          ledger.recordWebSocketFrameAfterDialogPress();
        }
      });
      listenerGroup.cleanups.push(() => {
        stop();
        void opened.detach().catch(() => undefined);
      });
    } catch {
      void session?.detach().catch(() => undefined);
    }
  };
  /**
   * EL-12（設計書 `2026-10-24-beaksight-external-launch-block-design.md` 3.3・3.5）: 外部スキームへの移動の検出と記録（唯一の記録の所）。本番の Chromium は
   * 一時のプロファイルの設定で外部スキームへの移動を止める（OS のアプリへ渡さない）ので、Playwright の `request` は来ない。検出は CDP の事象
   * （`CDP_STARTED`・`CDP_WINDOW_OPEN`・予備の `CDP_UNREACHABLE`）で行い、`request`（テストの既定の headless shell で両方来る）と合わせて、同じ移動は
   * 1 回だけ記録する（`ExternalNavigationDetections`）。SAFE-2 の 4（違反の区分の (3)。設計者の判断）: frame の種類が分かれば `externalSchemeNavigations`
   * （`EXTERNAL_SCHEME_NAVIGATION`）、分からなければ（`window.open`）frame の判定の失敗の記録（`frameClassificationFailures`）に残す。違反
   * （前は `EXTERNAL_SCHEME_NAVIGATION_ATTEMPTED`・`FRAME_CLASSIFICATION_FAILED`）にせず、Context も閉じない（ブラウザが止めていて、外へは何も渡っていない）。
   * `frame` は `'MAIN'`・`'SUB'`、分からなければ `undefined`（`classifyMainFrame` が分類の失敗を記録した場合は、`frameFailure: 'RECORDED'` で、ここでは記録しない）。
   */
  /**
   * SAFE-2 の 4（違反の区分の (3)）: Playwright の要求の frame を引けなかったことを、frame の判定の失敗の記録に残す（URL を読めなければ空。違反にしない）。
   * 時点は、凍結の段（閉じる途中を含む）なら `INTERACTION`、ほかは `PASSIVE`。
   */
  const recordFrameClassificationFailureOf = (request: Request): void => {
    let url = '';
    try {
      url = request.url();
    } catch {
      url = '';
    }
    ledger.recordFrameClassificationFailure({ url, phase: isFrozenPhase(guardState.phase) ? 'INTERACTION' : 'PASSIVE' });
  };
  /**
   * SAFE-2 の 4: 失敗した main frame の要求が読み取り（GET・HEAD）なら、読み取りの失敗の記録に残して真（呼ぶ側は違反にしない）。読み取りでなければ偽（今どおり違反）。
   */
  const recordReadNavigationFailureIfRead = (request: Request, errorText: string): boolean => {
    const method = request.method();
    if (!isReadMethod(method)) return false;
    ledger.recordReadNavigationFailure({
      method,
      url: request.url(),
      errorText,
      phase: isFrozenPhase(guardState.phase) ? 'INTERACTION' : 'PASSIVE',
    });
    return true;
  };
  const externalNavigationDetections = new ExternalNavigationDetections();
  const recordExternalSchemeNavigationAttempt = (
    source: ExternalNavigationSource,
    url: string,
    frame: () => 'MAIN' | 'SUB' | undefined,
    frameFailureMessage: string | null,
  ): void => {
    const phase = guardState.phase;
    if (phase === 'CLOSED') {
      return;
    }
    try {
      const scheme = externalNavigationScheme(url);
      // EL-F（EL-R の M5）: 同じ移動の同一視は URL だけで行う。別の移動が同じ URL で同一視されても、最初の 1 件（違反と Context を閉じること）は必ず
      // 残るので、安全の確かめは弱まらない。
      if (scheme === null || !externalNavigationDetections.admit(source, url, Date.now())) {
        return;
      }
      // SAFE-2 の 4（違反の区分の (3)。設計者の判断）: ブラウザが外部スキームへの移動を止めていて、外へは何も渡っていないので、違反
      // （前は `EXTERNAL_SCHEME_NAVIGATION_ATTEMPTED`）にせず、Context も閉じない。記録して続ける。
      // popup（`window.open`）の navigation は frame ができる前に出るので、frame の種類が分からない。推し量って記録せず、
      // frame の判定の失敗の記録（`frameClassificationFailures`。前は違反 `FRAME_CLASSIFICATION_FAILED`）に残す。
      const recordedPhase = isFrozenPhase(phase) ? 'INTERACTION' as const : 'PASSIVE' as const;
      const kind = frame();
      if (kind !== undefined) {
        ledger.recordExternalSchemeNavigation({
          url,
          scheme,
          frame: kind,
          phase: recordedPhase,
          reason: 'EXTERNAL_SCHEME_NAVIGATION',
        });
      } else if (frameFailureMessage !== null) {
        ledger.recordFrameClassificationFailure({ url, phase: recordedPhase });
      }
    } catch (error) {
      ledger.recordInvariantViolation({ code: 'EXTERNAL_SCHEME_DETECTION_FAILED', message: errorMessage(error) });
      initiateInvalidation(context, ledger);
    }
  };
  /**
   * EL-12: page か OOPIF の session（`channel`）の CDP の事象（`EXTERNAL_NAVIGATION_CDP_EVENTS`）を、外部スキームの移動の検出に渡す。`mainFrameId` は
   * page の session の root frame の ID（OOPIF の session は `null`。OOPIF の frame は、どれも sub frame）。外部スキームの `CDP_STARTED`・`CDP_UNREACHABLE` の
   * 後は、`Page.stopLoading` を送る（ブロックのエラーの頁を確かにしない。送れなくても、Context は閉じる）。
   */
  const onExternalNavigationCdpEvent = (channel: GuardCdpChannel, mainFrameId: string | null, method: string, params: unknown): void => {
    if (guardState.phase === 'CLOSED') {
      return;
    }
    const facts = externalNavigationFactsOf(method, params);
    if (facts === null || isIgnoredCdpNavigationUrl(facts.url)) {
      return;
    }
    let scheme: string | null;
    try {
      scheme = externalNavigationScheme(facts.url);
    } catch (error) {
      ledger.recordInvariantViolation({ code: 'EXTERNAL_SCHEME_DETECTION_FAILED', message: errorMessage(error) });
      initiateInvalidation(context, ledger);
      return;
    }
    if (scheme === null) {
      return;
    }
    const { frameId } = facts;
    // EL-F2（N2）: PDF の表示の拡張の sub frame の始まり（PDF の頁・iframe・embed）だけは、外部スキームにしない。
    if (facts.source === 'CDP_STARTED' && frameId !== mainFrameId && isChromiumPdfViewerFrameUrl(facts.url)) {
      return;
    }
    if (facts.source !== 'CDP_WINDOW_OPEN') {
      void channel.send('Page.stopLoading').catch(() => undefined);
    }
    recordExternalSchemeNavigationAttempt(
      facts.source,
      facts.url,
      () => (frameId === null ? undefined : frameId === mainFrameId ? 'MAIN' : 'SUB'),
      WINDOW_OPEN_FRAME_UNAVAILABLE_MESSAGE,
    );
  };
  /**
   * EL-F2（EL-R2 の N1）: CDP の session を付けた時点で、すでに確かになっていた外部スキームへの移動を拾う。`w = window.open('about:blank');
   * w.location.href = '<外部スキーム>'` を待たずに続けると、opener の `Page.windowOpen` は `about:blank` で、ポップアップの移動はその session の
   * `Page.enable` の前に、Chromium の設定が止めたエラーの頁として終わる。`Page.getFrameTree` の frame と子の frame の `unreachableUrl`（root の frame に
   * なければ、`Page.getNavigationHistory` の今の項目）を外部スキームの判定に通し、当たれば今と同じ形で記録して Context を閉じる（出どころは
   * `CDP_UNREACHABLE`。1 回だけ記録の仕組みを通る）。`channel` は page の session（root の frame は main frame）。
   */
  const recordSettledExternalNavigations = async (channel: GuardCdpChannel): Promise<void> => {
    const { frameTree } = await channel.send('Page.getFrameTree');
    const settled: { readonly url: string; readonly frame: 'MAIN' | 'SUB' }[] = [];
    const visit = (node: { readonly frame: { readonly unreachableUrl?: string }; readonly childFrames?: readonly unknown[] }, frame: 'MAIN' | 'SUB'): void => {
      const { unreachableUrl } = node.frame;
      if (typeof unreachableUrl === 'string' && unreachableUrl !== '') {
        settled.push({ url: unreachableUrl, frame });
      }
      for (const child of node.childFrames ?? []) {
        visit(child as typeof node, 'SUB');
      }
    };
    visit(frameTree, 'MAIN');
    if (!settled.some(({ frame }) => frame === 'MAIN')) {
      const history = await channel.send('Page.getNavigationHistory');
      const current = history.entries[history.currentIndex];
      if (current !== undefined) {
        settled.push({ url: current.url, frame: 'MAIN' });
      }
    }
    for (const { url, frame } of settled) {
      if (isIgnoredCdpNavigationUrl(url) || (frame === 'SUB' && isChromiumPdfViewerFrameUrl(url))) {
        continue;
      }
      recordExternalSchemeNavigationAttempt('CDP_UNREACHABLE', url, () => frame, null);
    }
  };
  const pageGuards = new WeakMap<Page, PageGuardRecord>();
  const pendingTasks = new Set<Promise<void>>();
  const expectedCdpFailures = new ExpectedCdpFailureRegistry(ledger);
  // DEF-225: 凍結の前に Guard が止めたダウンロードの記録（main frame の読み取りの移動の失敗と 1 対 1 に対応付ける）。
  const passiveDownloads = new PassiveDownloadRegistry();
  const expectedRouteFailures = new WeakSet<Request>();
  const recordedFrozenPopups = new WeakSet<Page>();
  const guardState: GuardState = {
    phase: 'INSTALLING',
    context,
    ledger,
    drainQuietLimitMs: options.drainQuietLimitMs,
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
    contextCloseObserved: false,
    closeAttempt: undefined,
    taskLimitReported: false,
    drainTimeoutReported: false,
    egressFreeze: options.egressFreeze,
    webSocketRelayCuts: new Set(),
    // SAFE-2 の 1: ログインの段か書き込みの段の Guard か（読み込む前の凍結の口が拒む）。
    submissionStage: options.loginStage !== undefined || options.writeStage !== undefined,
    notificationPress: null,
    notificationPressNavigations: 0,
    notificationPressNavigationTargets: [],
    scrollKeyPress: false,
    dialogPress: false,
    dialogPressHold: false,
    dialogPressLeaving: false,
    dialogPressWebSocketFrames: 0,
    dialogPressHoldWebSocketFrames: 0,
    scrollKeyPressBlocks: 0,
    // COV-2c（C-1）: 凍結の段で 1 回だけ通す main frame の文書の移動（既定はなし）。
    frozenMainFrameDocument: null,
    // AS-c fix round 1（I-1）: 閉じ始めるときに、送っている事前確認も止める（同じ口で止める）。
    abortWriteSubmission: writeSubmissionAbort === undefined && auditSendPreflight === undefined
      ? undefined
      : () => {
        writeSubmissionAbort?.abort();
        auditSendPreflightAbort.abort();
      },
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
                // DEF-100 fix: page の main frame の文書の要求を進めた時刻を、読み込みの間隔の起点として記録する（OOPIF の session と iframe は除く）。
                if (!isPausedResponse(event) && mainFrameId !== null && event.frameId === mainFrameId) {
                  recordMainFrameDocumentSent();
                }
              }),
              failRequest: () => settle(() => channel.send('Fetch.failRequest', {
                requestId: event.requestId,
                errorReason: 'BlockedByClient',
              })),
              // SAFE-2 の 2（DEF-242）: 204 で応える（サーバへ届けない）。
              fulfillNoContent: () => settle(() => channel.send('Fetch.fulfillRequest', {
                requestId: event.requestId,
                responseCode: NO_CONTENT_STATUS,
                responseHeaders: [],
                body: '',
              })),
            };
          };
          /** T30R-fix-1（M-1）: 送り手が送っている承認の POST の要求（Network の要求の ID）と、その間にブラウザが取り消したもの。 */
          const submittingNetworkIds = new Set<string>();
          const canceledDuringSubmission = new Set<string>();
          /**
           * DEF-099 fix: 書き込みの段の承認の POST への命令（送り手の応答を返す、応答のない失敗を伝える）。T30R-fix-1（M-1）: 応答を返す命令が、
           * 取り消された要求への命令として失敗し（`isInvalidInterceptionIdFailure`）、送っている間にその要求の取り消しを受けていたら、DEF-026 と同じく
           * ブラウザが取り消した要求として扱う（違反にせず、`responseDeliveryCanceled` に記録する）。取り消しでない失敗は、今どおり投げる（違反）。
           */
          const writeSubmissionCommands = (event: PausedDocumentEvent, monitor: WriteStageMonitor): WriteSubmissionCommands => {
            const networkId = typeof event.networkId === 'string' && event.networkId.length > 0 ? event.networkId : null;
            const settle = (send: () => Promise<unknown>): Promise<void> =>
              settlePausedDocumentCommand(send, canceledDocuments, networkId, closingForCommands);
            return {
              fulfillRequest: async (response) => {
                let failure: unknown;
                try {
                  await channel.send('Fetch.fulfillRequest', {
                    requestId: event.requestId,
                    responseCode: response.status,
                    responseHeaders: response.headers.map(({ name, value }) => ({ name, value })),
                    body: response.body.toString('base64'),
                  });
                  return;
                } catch (error) {
                  failure = error;
                }
                if (networkId !== null && canceledDuringSubmission.has(networkId) && isInvalidInterceptionIdFailure(errorMessage(failure))) {
                  // 送っている間に取り消しを受けた要求（取り消しの証拠の保ち時間を過ぎていてもよい）。
                  writeStageStateOf(monitor).responseDeliveryCanceled = true;
                  return;
                }
                // ほかは、DEF-026 の決め方（取り消しの証拠があれば違反にしない。なければ投げる）。
                await settle(() => Promise.reject(failure));
              },
              failRequestAs: (errorReason) => settle(() => channel.send('Fetch.failRequest', {
                requestId: event.requestId,
                errorReason: errorReason as 'ConnectionClosed',
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
            // T30b: Guard が通した承認の POST の応答（status）を受けた。送信の報告に書く（閉じる途中でも、サーバは応答している）。
            if (
              writeStage !== undefined
              && mainFrameId !== null
              && admittedWritePost?.page === page
              && admittedWritePost.requestId === event.requestId
              && typeof event.responseStatusCode === 'number'
            ) {
              const writeState = writeStageStateOf(writeStage.monitor);
              writeState.responseReceived = true;
              writeState.responseStatus = event.responseStatusCode;
            }
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
              await continueAllowedRequest(commands.continueRequest, 'RESPONSE', context, ledger);
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
          // - 作業の数は、ほかの作業とは別に数える（設計書 2.4。L10 で上限は撤廃した）。
          const preflightInitiators = new PreflightInitiatorRegistry();
          // T39b: ページのスクリプトが始めた要求の frame（API の書き込みの段の、照合にかける要求の確かめ）。
          const scriptInitiators = new ScriptInitiatorRegistry();
          const pausedRequestCommands = (event: PausedDocumentEvent): PausedDocumentCommands & {
            fulfillPreflight(): Promise<void>;
            continueResponseWithWorkerConnectPolicy(): Promise<void>;
            fulfillApiWrite(response: Extract<WriteSubmissionOutcome, { readonly kind: 'RESPONDED' }>): Promise<boolean>;
            failApiWriteAs(errorReason: string): Promise<void>;
            fulfillPreflightWith(status: number, headers: readonly { readonly name: string; readonly value: string }[]): Promise<void>;
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
            // AS-c fix round 1（I-1）: サーバの事前確認の応答（状態と CORS のヘッダ）か、拒む応答で、ブラウザの事前確認を満たす。
            fulfillPreflightWith: (status: number, headers: readonly { readonly name: string; readonly value: string }[]) =>
              settlePausedRequestCommand(() => channel.send('Fetch.fulfillRequest', {
                requestId: event.requestId,
                responseCode: status,
                responsePhrase: STATUS_CODES[status] ?? '',
                responseHeaders: headers.map(({ name, value }) => ({ name, value })),
                body: '',
              })),
            // DEF-040: `Other` の応答に、Worker の中の WebSocket を止める CSP のヘッダを加えて続ける（`workerConnectPolicyResponse`）。
            continueResponseWithWorkerConnectPolicy: () => settlePausedRequestCommand(() => channel.send(
              'Fetch.continueResponse',
              workerConnectPolicyResponse(event, connectPolicy),
            )),
            // T39b: API の書き込みの送り手の応答を、ブラウザに送らせずにページへ返す（form の送り手と同じ `Fetch.fulfillRequest`）。T40R-fix-A（Task 40 の
            // 設計書 7 章の T40R の I-2 の (c)）: 返せたら真。一時停止の ID が無効な形の失敗（`settlePausedRequestCommand` と同じ見分け。ブラウザが先に要求を
            // 取り消した。ページの JS の取り消しなど）は、応答をページに返せなかったとして偽（違反にしない）。ほかの失敗は今どおり投げる。
            fulfillApiWrite: async (response: Extract<WriteSubmissionOutcome, { readonly kind: 'RESPONDED' }>): Promise<boolean> => {
              try {
                await channel.send('Fetch.fulfillRequest', {
                  requestId: event.requestId,
                  responseCode: response.status,
                  responseHeaders: response.headers.map(({ name, value }) => ({ name, value })),
                  body: response.body.toString('base64'),
                });
                return true;
              } catch (error) {
                if (isInvalidInterceptionIdFailure(errorMessage(error))) {
                  return false;
                }
                throw error;
              }
            },
            // T39b: API の書き込みを送らなかった・応答がなかったことを、要求の失敗としてページに伝える（form の送り手と同じ理由の写し）。
            failApiWriteAs: (errorReason: string) => settlePausedRequestCommand(() => channel.send('Fetch.failRequest', {
              requestId: event.requestId,
              errorReason: errorReason as 'ConnectionClosed',
            })),
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
          /**
           * 一時停止した要求が、CORS の事前確認か（第一の根拠は `initiator`、取れなければヘッダ）。
           * DEF-217: `initiator` の記録は、取ると消える（`take`）。1 つの一時停止の事象で何度も問う（DEF-208-1 の凍結の段の読み取りの判定と、判定の
           * `evaluate`）ので、事象ごとに最初に取った結果を覚えて、2 回目からはそれを返す（2 回目に記録がないとして、事前確認を止めない）。
           */
          const preflightByInitiatorOfEvent = new WeakMap<PausedDocumentEvent, boolean>();
          const isPreflight = (event: PausedDocumentEvent, facts: CorrelationRequest): boolean => {
            if (facts.method.toUpperCase() !== 'OPTIONS') return false;
            let byInitiator = preflightByInitiatorOfEvent.get(event);
            if (byInitiator === undefined) {
              const networkId = typeof event.networkId === 'string' && event.networkId.length > 0 ? event.networkId : null;
              byInitiator = networkId !== null && preflightInitiators.take(networkId, Date.now());
              preflightByInitiatorOfEvent.set(event, byInitiator);
            }
            return byInitiator || headerValueOf(event.request.headers, ACCESS_CONTROL_REQUEST_METHOD_HEADER) !== undefined;
          };
          /**
           * AS-c fix round 1（I-1。設計書 5 章の「AS-c fix round 1 の Blocker」の行）: Guard がサーバへ送る事前確認なら、その送り先の URL（送らないなら null）。
           * 送るのは、監査の段の送信の扱いの口と事前確認の送り手があり、本番の要求（`Access-Control-Request-Method` の method と同じ URL）を、今の口が通す
           * 見込みのもの（`auditSendAdmission` の印つきの ALLOW）だけ。REV-RB14 の I-1: 送り先の Origin は問わない（許可 Origin と承認したサービスの Origin への
           * 事前確認も、サーバの答えで満たす。サーバが拒む本番の要求をブラウザに送らせない）。ほかは今のまま Guard が返す（通さない本番の要求、`READ_ONLY`）。
           */
          const auditSendPreflightUrlOf = (event: PausedDocumentEvent): string | null => {
            if (auditSendAdmission === undefined || auditSendPreflight === undefined || typeof event.request.url !== 'string') {
              return null;
            }
            const method = headerValueOf(event.request.headers, ACCESS_CONTROL_REQUEST_METHOD_HEADER);
            if (method === undefined) {
              return null;
            }
            const decision = classifyPassiveRequest(
              { kind: 'HTTP', method, url: event.request.url, isNavigationRequest: false, isMainFrame: false },
              authoritySnapshot,
              cdpRequestPolicy(),
            );
            return decision.action === 'ALLOW' && decision.auditSendAdmission === true ? event.request.url : null;
          };
          /**
           * AS-c fix round 1（I-1）: 事前確認を、同じ形（`Origin`・`Access-Control-Request-Method`・`Access-Control-Request-Headers` など。資格情報なし）で
           * 中継を通してサーバへ 1 回送り（`sendWriteSubmissionOnce` の `PREFLIGHT`。上限 `AUDIT_SEND_PREFLIGHT_TIMEOUT_MS`）、その応答の状態と CORS のヘッダで
           * ブラウザの事前確認を満たす。応答がない・時間切れ・送れないは、拒む応答（`AUDIT_SEND_PREFLIGHT_REJECT_CODE`。CORS のヘッダなし）で満たす（ブラウザは
           * 本番の要求を送らない）。書いた（送った）事前確認は、通した要求（`OPTIONS`）として Ledger に記録する。
           * 満たす命令の失敗は、今の事前確認と同じく違反にして Context を閉じる。
           */
          const forwardAuditSendPreflight = async (
            event: PausedDocumentEvent,
            commands: ReturnType<typeof pausedRequestCommands>,
            url: string,
          ): Promise<void> => {
            if (auditSendAdmission === undefined || auditSendPreflight === undefined) {
              return;
            }
            // DEF-125: https の送り先は、中継の CONNECT を通す宛先に加える（Guard が通した要求と同じ）。
            if (egressDestinationHook !== undefined) {
              try {
                egressDestinationHook(url);
              } catch (error) {
                ledger.recordInvariantViolation({ code: 'GUARD_EGRESS_ADMISSION_FAILED', message: errorMessage(error) });
              }
            }
            let outcome: WriteSubmissionOutcome;
            try {
              outcome = await sendWriteSubmissionOnce(
                { url, method: PREFLIGHT_METHOD, headers: Object.freeze({ ...(event.request.headers ?? {}) }), body: Buffer.alloc(0), requestKind: 'PREFLIGHT' },
                auditSendPreflight,
              );
            } catch {
              outcome = Object.freeze({ kind: 'NO_RESPONSE', reason: 'CONNECTION_CLOSED' });
            }
            if (outcome.kind !== 'NOT_WRITTEN') {
              recordPassedAuditSendRequest(PREFLIGHT_METHOD, url);
            }
            try {
              await (outcome.kind === 'RESPONDED'
                ? commands.fulfillPreflightWith(outcome.status, corsResponseHeadersOf(outcome.headers))
                : commands.fulfillPreflightWith(AUDIT_SEND_PREFLIGHT_REJECT_CODE, []));
            } catch (error) {
              ledger.recordInvariantViolation({ code: 'CDP_PREFLIGHT_FULFILL_FAILED', message: errorMessage(error) });
              initiateInvalidation(context, ledger);
            }
          };
          /**
           * T39b（Task 39 の設計書 3.3）: 照合に一致した API の書き込み（窓の中の 1 回目）を、ブラウザに送らせず、同じ本文の bytes で送り手の口に渡す
           * （中身は T39c）。送信の報告は form の送り手と同じに書く（通そうとしたので `SENT`、送らせた回数 1、結果の種類）。
           * - `RESPONDED`: 応答の status を送信の報告に書き、応答を `Fetch.fulfillRequest` でページに返す。
           * - `NOT_WRITTEN`（口がない場合を含む）: 送信の報告を `NOT_SENT` に戻し（届いていない）、要求を失敗させる。
           * - `NO_RESPONSE`: 送信の報告は `SENT` のまま（届いたかは分からない）、要求を失敗させる。
           * 命令の失敗は違反にして Context を閉じる。口の例外は `NO_RESPONSE` と同じに扱う（送ったかが分からない側に倒す）。
           */
          const handOffApiWrite = async (
            event: PausedDocumentEvent,
            commands: ReturnType<typeof pausedRequestCommands>,
            stage: Extract<AcceptedWriteStage, { readonly transport: typeof API_SCENARIO_TRANSPORT }>,
            pageKeyValues: Readonly<Record<string, ApiWritePageKeyValue>>,
          ): Promise<void> => {
            const state = writeStageStateOf(stage.monitor);
            state.submission = 'SENT';
            state.sendAttempts = saturatingIncrement(state.sendAttempts);
            state.apiPageKeyValues = pageKeyValues;
            const body = apiWriteBodyOf(event) ?? Buffer.alloc(0);
            const admitted: AdmittedApiWriteRequest = Object.freeze({
              method: event.request.method,
              url: event.request.url,
              headers: Object.freeze({ ...(event.request.headers ?? {}) }),
              body,
              pageKeyValues,
            });
            // T39c: 口がなければ、Guard の既定の送り手（factory が渡す `writeSubmission` と、閉じるときに止める口）で、fetch の形で 1 回だけ送る。
            // DEF-100 fix と同じく、書き始める直前と応答を受けた時点を、読み込みの間隔の起点として記録する。
            const handoff: ApiWriteHandoff | undefined = stage.handoff ?? (writeSubmission === undefined
              ? undefined
              : async (request) => {
                const outcome = await sendWriteSubmissionOnce(
                  { url: request.url, method: request.method, headers: request.headers, body: request.body, requestKind: 'FETCH' },
                  writeSubmission,
                  { onRequestWriteStart: recordMainFrameDocumentSent },
                );
                if (outcome.kind === 'RESPONDED') {
                  recordMainFrameDocumentSent();
                }
                return outcome;
              });
            let outcomeKind: WriteSubmissionSendOutcome;
            let responded: Extract<WriteSubmissionOutcome, { readonly kind: 'RESPONDED' }> | null = null;
            if (handoff === undefined) {
              outcomeKind = 'NOT_WRITTEN';
            } else {
              try {
                const outcome = await handoff(admitted);
                outcomeKind = outcome.kind;
                responded = outcome.kind === 'RESPONDED' ? outcome : null;
              } catch {
                outcomeKind = 'NO_RESPONSE';
              }
            }
            state.sendOutcome = outcomeKind;
            try {
              if (responded !== null) {
                state.responseReceived = true;
                state.responseStatus = responded.status;
                // T39c（Task 40 の口）: 応答の本文から、使える形の登録の ID だけを取り出す（本文は持たない。口の例外は ID なし）。
                if (stage.recordIdOf !== undefined) {
                  try {
                    const recordId = stage.recordIdOf(responded.body);
                    state.apiRecordId = typeof recordId === 'string' ? recordId : null;
                  } catch {
                    state.apiRecordId = null;
                  }
                }
                // T40R-fix-A: 応答をページに返せなかったら、form の送り手と同じ印に残す（書き込みの流れが、画面から ID を取る形で判定に使う）。
                if (!(await commands.fulfillApiWrite(responded))) {
                  state.responseDeliveryCanceled = true;
                }
                return;
              }
              if (outcomeKind === 'NOT_WRITTEN') {
                state.submission = 'NOT_SENT';
              }
              await commands.failApiWriteAs(WRITE_SUBMISSION_FAILURE_REASONS[outcomeKind === 'RESPONDED' ? 'NO_RESPONSE' : outcomeKind]);
            } catch (error) {
              ledger.recordInvariantViolation({ code: 'CDP_FAIL_REQUEST_FAILED', message: errorMessage(error) });
              initiateInvalidation(context, ledger);
            }
          };
          const handlePausedRequest = (event: PausedDocumentEvent): void => {
            const commands = pausedRequestCommands(event);
            trackGuardTask(guardState, 'paused CDP request', 'GUARD_CDP_PAUSED_TASK_FAILED', async () => {
              // T36R-fix（T36R の C-1）: 自動ログインの資格情報の守りで比べる、この要求に付く Cookie（判定の前に読む。部品がなければ、待たずに読まない）。
              const cookies = credentialGuard === undefined ? NO_COOKIES : await cookieTextsFor(event.request.url);
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
              // T39b: API の書き込みの段で、窓の中の、承認した API の Origin への `POST`・`PATCH` が、窓を開いた page の main frame のページの
              // スクリプトの要求か（同じ session の `Network.requestWillBeSent` の frame と開始の種類。届いていなければ、名前つきの時間まで待つ）。
              const mainFrameScript = apiWriteStage !== undefined
                && apiWriteStage.monitor.isSubmissionWindowOpen()
                && apiWriteWindowPage === page
                && mainFrameId !== null
                && event.frameId === mainFrameId
                && typeof event.networkId === 'string'
                && event.networkId.length > 0
                && isApiWriteCheckTarget(event.request.method, event.request.url, apiWriteStage.expectation.spec.request.origin)
                && (await scriptInitiators.frameOf(event.networkId, SCRIPT_INITIATOR_WAIT_MS)) === mainFrameId;
              /** T39b: API の書き込みの照合が止めた理由（止めた要求を段の記録に数える）と、一致したときのページが決める鍵の値。 */
              let apiPayloadBlockReason: ApiWritePayloadBlockReason | undefined;
              let apiPageKeyValues: Readonly<Record<string, ApiWritePageKeyValue>> | undefined;
              // CC-050: 段階と判定から、動作と記録を決める（`decideGuardRequest`）。ここは、その結果に従って CDP の命令を送る。
              let subresourcePolicy: PassiveRequestPolicyOptions | undefined;
              /** DEF-233: 凍結の段の事前確認を、観察の口が認めた（承認した API の Origin の）ものか（観察の口の事前確認の数に入れるのは、それだけ）。 */
              let observedPreflight = false;
              /** AS-c fix round 1（I-2）・DEF-233: method の上書きの判定に使う、ヘッダと本文（判定と、凍結の段の token の更新の判定が共用する）。 */
              const pausedSentContent: RequestSentContent = {
                headers: event.request.headers,
                formMethodOverrides: () => formMethodOverrideValuesOf(
                  event.request.headers,
                  () => requestBodyTextOf(event.request.hasPostData, event.request.postDataEntries),
                ),
              };
              const verdict = decideGuardRequest({
                layer: 'CDP_REQUEST',
                phase,
                ownerClosingPage: ownerClosingPages.has(page),
                request: facts,
                navigation: false,
                unguardedPageNavigation: null,
                // T37b: 観察の口が有効の間の、承認した API の Origin への凍結の段の事前確認（口の判定を先に見て、事前確認の記録を無駄に使わない）。
                ...(submissionObservation === undefined
                  ? {}
                  : {
                    frozenPreflight: (request: GuardRequestIdentity): boolean => {
                      if (!isPreflight(event, request)) return false;
                      observedPreflight = observationAdmitsFrozenPreflight(submissionObservation, request.url);
                      // DEF-233: 凍結の段で通すサイトの token の更新の事前確認も、Guard が満たす（サーバへ送らない。判定は本番の要求と同じ部品。事前確認は
                      // 本文を持たないので、目印は URL で照らす）。
                      return observedPreflight || frozenTokenRefreshPreflightAdmitted({
                        method: headerValueOf(event.request.headers, ACCESS_CONTROL_REQUEST_METHOD_HEADER) ?? SUBMISSION_POST_METHOD,
                        url: request.url,
                        isNavigationRequest: false,
                        isMainFrame: false,
                        resourceType: requestResourceTypeOf(event.resourceType),
                      }, cdpRequestPolicy());
                    },
                  }),
                // DEF-208-1: 凍結の段の読み取り（文書でない要求。事前確認は上の口が先に見る）。DEF-233: サイトの token の更新も同じ口で見る（本文は要るときだけ読む）。
                ...(facts === null || isPreflight(event, facts) ? {} : {
                  frozenRead: frozenReadOf({
                    method: facts.method,
                    url: facts.url,
                    isNavigationRequest: false,
                    isMainFrame: false,
                    resourceType: requestResourceTypeOf(event.resourceType),
                    sentContent: pausedSentContent,
                  }, cdpRequestPolicy, () => requestBodyTextOf(event.request.hasPostData, event.request.postDataEntries), event.request.headers),
                }),
                evaluate: (request): GuardPolicyOutcome => {
                  if (isPreflight(event, request)) return { kind: 'PREFLIGHT' };
                  subresourcePolicy = cdpRequestPolicy();
                  // T36b: 自動ログインの資格情報の守り（token の送信のほか）。
                  const classified = credentialCheckedDecision(classifyPassiveRequest({
                    kind: 'HTTP',
                    method: request.method,
                    url: request.url,
                    isNavigationRequest: false,
                    isMainFrame: false,
                    // T34b: CDP の事象の要求の種類（`Fetch`・`XHR`・`Ping` など）を、閉じた一覧に正規化して渡す。
                    resourceType: requestResourceTypeOf(event.resourceType),
                    // T39b: API の書き込みの段の、窓を開いた page の main frame のページのスクリプトの要求か。
                    mainFrameScript,
                    // AS-c fix round 1（I-2）: method の上書きの判定に使う、ヘッダと本文（本文は form のときだけ読む）。
                    sentContent: pausedSentContent,
                    // L12b: リダイレクトの続き（書き込みの段の押した後の扱いは、本文の送り直しを通さない）。
                    ...(event.redirectedRequestId === undefined ? {} : { redirectReplay: true }),
                  }, authoritySnapshot, subresourcePolicy), { method: request.method, url: request.url, headers: event.request.headers },
                  () => requestBodyTextOf(event.request.hasPostData, event.request.postDataEntries), cookies);
                  if (classified.action === 'ALLOW' && classified.writeStageApiWrite === true) {
                    // T39b: 照合にかける要求（窓の中の 1 回目）。続ける前に、一時停止の要求の事実（method、URL、ヘッダ、本文の bytes）を承認した型と
                    // 生成した値に照らす（同期の純粋な関数。照合と数えるの間に、ほかの要求の判定は入らない）。止めたら、以後どの書き込みも許さない。
                    if (apiWriteStage === undefined || submissionAdmission === undefined) {
                      return { kind: 'DECISION', decision: { action: 'BLOCK', category: 'REQUEST', reason: 'NON_READ_METHOD' } };
                    }
                    // LU-9: 前の値を後から入れる印のある期待は、入れた期待で照らす。入れていなければ印のある期待のまま照らし、必ず
                    // `EXPECTATION_INVALID` で止まる（fail-closed）。
                    const checked = checkApiWritePayload(suppliedPriorExpectationOf<ApiWritePayloadExpectation>(apiWriteStage.monitor, API_SCENARIO_TRANSPORT) ?? apiWriteStage.expectation, {
                      method: event.request.method,
                      url: event.request.url,
                      headers: event.request.headers ?? {},
                      body: apiWriteBodyOf(event),
                    });
                    if (checked.decision !== 'ALLOW') {
                      submissionAdmission.spend();
                      apiPayloadBlockReason = checked.decision;
                      return { kind: 'DECISION', decision: { action: 'BLOCK', category: 'REQUEST', reason: 'NON_READ_METHOD' } };
                    }
                    apiPageKeyValues = checked.pageKeyValues;
                  }
                  return { kind: 'DECISION', decision: classified };
                },
              });
              // DEF-125: 通した要求の宛先を、中継に知らせる（命令を送る前）。
              admitEgressDestinationOf(verdict, 'CDP_REQUEST');
              countFrozenRead(page, verdict, subresourcePolicy ?? cdpRequestPolicy());
              // fix round 2（SREV-233 の M-3）・fix round 3: 通した token の更新を、要求の header と本文とともに factory に知らせる。
              notifyTokenRefreshAdmitted(verdict, subresourcePolicy ?? cdpRequestPolicy(), event.request.headers,
                () => requestBodyTextOf(event.request.hasPostData, event.request.postDataEntries));
              recordGuardVerdictBeforeBlock(ledger, verdict);
              if (verdict.kind === 'BLOCK_FROZEN') {
                // T37b: 観察の口が有効なら、止める要求の型を口に渡す（止め方と記録は今どおり）。
                observeFrozenRequest(verdict.request, event);
                // DEF-233: 凍結で止めた token の更新を、監査の段の記録に数える（CDP の層で数える）。
                countFrozenTokenRefreshBlocked(verdict.request, cdpRequestPolicy());
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
              if (verdict.kind === 'BLOCK_LIFECYCLE') {
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
                  return;
                }
                // BN-a（設計書 3.1 の 2）: 閉じる途中に止めた要求を、止めた後に記録する（止め方は変えない。数だけでなく、読めた要求の形も残す）。
                ledger.recordBlockedClosingRequest(facts === null
                  ? null
                  : {
                    method: facts.method,
                    url: facts.url,
                    resourceType: requestResourceTypeOf(event.resourceType),
                    speculative: isSpeculativeRequestHeaders(event.request.headers),
                  });
                return;
              }
              if (verdict.kind === 'BLOCK_INVALID' || verdict.kind === 'BLOCK_UNAVAILABLE') {
                await fail('CDP_FAIL_REQUEST_FAILED');
                initiateInvalidation(context, ledger);
                return;
              }
              if (verdict.kind === 'FULFILL_PREFLIGHT') {
                // AS-c fix round 1（I-1）: 監査の段の送信の扱いで、ほかの Origin への通す見込みの要求の事前確認は、サーバへ送って、その応答で満たす。
                const forwardUrl = phase === 'PASSIVE_ACTIVE' ? auditSendPreflightUrlOf(event) : null;
                if (forwardUrl !== null) {
                  await forwardAuditSendPreflight(event, commands, forwardUrl);
                  return;
                }
                try {
                  await commands.fulfillPreflight();
                  // T37b: 凍結の段で満たした事前確認（観察の口が認めたもの）を、口に数える。
                  // DEF-233: token の更新の事前確認（観察の口が認めたものでない）は、押下の観察に混ぜない。
                  if (submissionObservation !== undefined && isFrozenPhase(phase) && observedPreflight) recordObservedFrozenPreflight(submissionObservation);
                } catch (error) {
                  ledger.recordInvariantViolation({
                    code: 'CDP_PREFLIGHT_FULFILL_FAILED',
                    message: errorMessage(error),
                  });
                  initiateInvalidation(context, ledger);
                }
                return;
              }
              const { request } = verdict;
              // T35b: 承認したサービスの Origin への要求は、通す前に上限の部品で数える。断られたら、上限で止めた判定として止めて記録する。
              const blockDecision = verdict.kind === 'BLOCK_POLICY' ? verdict.decision : serviceRequestLimitOf(verdict.decision, request.url);
              if (blockDecision !== null) {
                if (await fail('CDP_FAIL_REQUEST_FAILED')) {
                  // FRET（2026-11-25 fix round 1 の判断）: 窓を開くボタンの押す期間の止めで止めた、文書でない要求（main frame の fetch など）も数える。
                  if (blockDecision.action === 'BLOCK' && blockDecision.category === 'REQUEST' && blockDecision.reason === SCROLL_KEY_PRESS_BLOCK_REASON) {
                    guardState.scrollKeyPressBlocks = saturatingIncrement(guardState.scrollKeyPressBlocks);
                  }
                  recordBlockedDecision(
                    ledger,
                    blockDecision,
                    // T34e: 要求の種類（ログインの段で止めた読み取りでない要求の一覧だけが使う）。
                    // T36R-fix: ヘッダ（自動ログインの資格情報の守りの比べだけに使う）。
                    {
                      method: request.method,
                      url: request.url,
                      mainFrameNavigation: false,
                      resourceType: requestResourceTypeOf(event.resourceType),
                      // BN-a: 止めた時点（ページを離れた後なら `CLOSING`）。
                      phase: blockedEventPhaseOf(guardState.phase, page),
                      speculative: isSpeculativeRequestHeaders(event.request.headers),
                      headers: event.request.headers,
                      // OP-M: 書き込みの段の止めた要求の一覧の、目印の真偽だけに使う（記録しない）。
                      body: () => requestBodyTextOf(event.request.hasPostData, event.request.postDataEntries),
                    },
                    stageRecordingOf(submissionAdmission, subresourcePolicy, apiPayloadBlockReason),
                    auditMonitor,
                    countedServiceOrigins,
                    authoritySnapshot,
                  );
                } else {
                  initiateInvalidation(context, ledger);
                }
                return;
              }
              if (verdict.kind !== 'ALLOW') {
                return;
              }
              // T35b: 監査の段の登録した読み取りの手続きの呼び出しを、続ける前に数える（この層だけで数える）。
              const { auditStageAdmission } = verdict.decision;
              if (auditReadAdmission !== undefined && auditStageAdmission?.kind === 'AUDIT_READ_REQUEST') {
                auditReadAdmission.admitAtCdp(request.method, request.url, auditStageAdmission);
              }
              // AS-a: 監査の段の送信の扱いの口が通した要求を、続ける前に記録する（RB-4a の X2: 数えない）。
              const auditSendNetworkId = typeof event.networkId === 'string' && event.networkId.length > 0 ? event.networkId : null;
              /** DEF-292 の残り: 「通した」の記録を route の層に任せる要求か（続ける命令の後に target が外れたら、ここで記録する）。 */
              let routeRecordedAuditSend = false;
              if (
                auditSendAdmission !== undefined
                && verdict.decision.auditSendAdmission === true
                && (event.redirectedRequestId !== undefined || (auditSendNetworkId !== null && auditSendNetworkIds.has(auditSendNetworkId)))
              ) {
                // AS-c fix round 2（I-D。設計書 5 章の「AS-R2」の行）: リダイレクトの先の要求（307・308 の段）は、Playwright が route を呼ばずに進めるので、
                // この層で通した要求として記録する。
                // AS-c fix round 3（AS-R3 の B03・W4）: ほかの Origin への段は `redirectedRequestId` を持たないことがあるので、この口が既に進めた要求と同じ
                // Network の要求の ID（リダイレクトの間は同じ ID）も、リダイレクトの先の手がかりにする。
                recordPassedAuditSendRequest(request.method, request.url);
                recordWriteStagePassedOf(request, event);
              } else if (auditSendAdmission !== undefined && verdict.decision.auditSendAdmission === true) {
                recordWriteStagePassedOf(request, event);
                if (auditSendNetworkId !== null) {
                  rememberAuditSendNetworkId(auditSendNetworkId);
                }
                // AS-c fix round 1（M-3）: Safety Ledger の通した要求の記録（値は残さない）は、ブラウザが送る時点に寄せる。Network の要求の ID のある要求は、
                // Playwright の route の層が進める時点で残す（route の層の ALLOW の所。about:blank のポップアップの realm の要求のように、Playwright が
                // 進めず届かない要求は残さない）。ID のない要求（ページを離れるときの送信など）は、Playwright が route を呼ばずに進めるので、ここで残す。
                if (!(typeof event.networkId === 'string' && event.networkId.length > 0)) {
                  recordPassedAuditSendRequest(request.method, request.url);
                } else {
                  routeRecordedAuditSend = true;
                }
              }
              // T25b: フォームの送信のログインの段の口は、ナビゲーションでない要求の POST を許さない（ここで ALLOW になる非読み取りの要求はない）。
              // 判定の口を route の層と同じにするため、同じ数え方を通す。T30b: 書き込みの段の口も同じ（main frame のナビゲーションだけを許す）。
              // T34b: スクリプトで送るログインの段の口は、登録した token の送信とログインに伴う送信（fetch か xhr）をここで許すので、判定が通した
              // 理由の残りを、続ける前に減らす（この層だけで数える）。サービスの Origin への読み取りは、ここで数える（route の層では数えない）。
              const { loginStageAdmission } = verdict.decision;
              // T36b（Task 36 の設計書 3.4）: 通す token の送信の、応答の状態を観測する（Network の domain の要求の ID で対応付ける）。
              if (loginStageAdmission?.kind === 'SCRIPT_LOGIN_TOKEN') {
                tokenResponseTracker?.sent(event.networkId);
              }
              // T39b: API の書き込みの段で通した、照合に一致した書き込み（送り手の口に渡す。ブラウザには送らせないので、route の層への印を置かない）。
              const apiWrite = verdict.decision.writeStageApiWrite === true && apiWriteStage !== undefined && apiPageKeyValues !== undefined;
              // T39b: 監査の段の口が通した読み取りでない要求（登録した読み取りの手続きの呼び出し。API の書き込みの段の窓の外）は、送信の段の回数に数えない。
              // ML-a: 手動のログインの段の口が通した要求は、回数に数えず、読み取りでない要求の形だけを通した一覧に記録する。
              // DEF-193: 自動ログインの段の口が通した要求も、回数に数えない。DEF-194: 通した一覧の行の理由は、登録の対象でない理由にする。
              const manualPass = verdict.decision.manualLoginPassThrough;
              const automatedPass = verdict.decision.automatedLoginPassThrough;
              if (automatedPass !== undefined && submissionAdmission !== undefined) {
                if (!isReadMethod(request.method)) {
                  submissionAdmission.recordAutomatedPass(request.url, requestResourceTypeOf(event.resourceType));
                }
              } else if (manualPass !== undefined && submissionAdmission !== undefined) {
                if (!isReadMethod(request.method)) {
                  submissionAdmission.recordManualPass(request.url, requestResourceTypeOf(event.resourceType), manualPass.reason);
                }
              } else if (
                submissionAdmission !== undefined
                && !isReadMethod(request.method)
                && auditStageAdmission === undefined
                // OP-N（N2）: 書き込みの段で、送信の扱いの口が通した要求は、承認した送信の回数に数えず、送信の窓も閉じない（承認した 1 件だけを数える）。
                && verdict.decision.auditSendAdmission !== true
              ) {
                submissionAdmission.admitAtCdp(request.method, request.url, !apiWrite, loginStageAdmission);
              } else if (loginStageAdmission?.kind === 'SERVICE_ORIGIN_READ' && submissionAdmission?.monitor instanceof LoginStageMonitor) {
                const state = loginStageStateOf(submissionAdmission.monitor);
                state.serviceOriginReads = saturatingIncrement(state.serviceOriginReads);
              }
              if (apiWrite && apiWriteStage !== undefined && apiPageKeyValues !== undefined) {
                await handOffApiWrite(event, commands, apiWriteStage, apiPageKeyValues);
                return;
              }
              if (routeRecordedAuditSend) {
                await continueRouteRecordedAuditSend(channel, page, { method: request.method, url: request.url }, commands.continueRequest);
                return;
              }
              await continueAllowedRequest(commands.continueRequest, 'REQUEST', context, ledger);
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
              // DEF-100 fix: 応答を受けた（要求はサイトに届いた後である）時刻を、読み込みの間隔の起点として記録する。
              if (isPausedResponse(event)) {
                recordMainFrameDocumentSent();
              }
            }
            // DEF-026: この要求への命令（結果は、取り消しの証拠と対応付けて決める）。
            const commands = pausedDocumentCommands(event);
            trackGuardTask(guardState, 'paused CDP Document request', 'GUARD_CDP_PAUSED_TASK_FAILED', async () => {
              // T36R-fix（T36R の C-1）: 自動ログインの資格情報の守りで比べる、この文書の要求に付く Cookie（Request の段階だけ。判定の前に読む。部品が
              // なければ、待たずに読まない）。
              const cookies = credentialGuard === undefined || isPausedResponse(event) ? NO_COOKIES : await cookieTextsFor(event.request.url);
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
              // CC-050: 段階と判定から、動作と記録を決める（`decideGuardRequest`）。ここは、その結果に従って CDP の命令を送る。
              let documentPolicy: PassiveRequestPolicyOptions | undefined;
              /** T30b: 書き込みの段で、承認の形の POST を送る中身の照合が止めた理由。 */
              let payloadBlockReason: WriteStagePayloadBlockReason | undefined;
              // DEF-129: Passive の段（送信の段でない）の page の、文書の要求（リダイレクトの続きでない）は、ページが始めた読み込みの数を frame ごとに
              // 数える（main frame と、T37R2-fix で子の frame。別のプロセスの iframe の session の要求は、すべて子の frame）。
              const isMainFrameDocument = mainFrameId !== null && event.frameId === rootFrameId;
              // RB-14a（X11）: 見るだけの点検の押す期間の main frame の移動は、止めずに数える（移った画面は、呼ぶ側が点検しない）。
              if (guardState.notificationPress === 'AUDIT' && isMainFrameDocument && redirectedFrom === undefined) {
                guardState.notificationPressNavigations = saturatingIncrement(guardState.notificationPressNavigations);
                guardState.notificationPressNavigationTargets.push(event.request.url);
              }
              // COV-2c（C-1）: 凍結の段で通した main frame の文書の要求のリダイレクトの先は、口の行き先を移してから判定する。
              followFrozenMainFrameDocumentRedirect(redirectedFrom?.url, event.request.url, event.frameId === rootFrameId);
              const countsPageNavigation = options.pageNavigationLimit === true
                && submissionAdmission === undefined
                && redirectedFrom === undefined;
              const verdict = decideGuardRequest({
                layer: 'CDP_DOCUMENT',
                phase,
                ownerClosingPage: ownerClosingPages.has(page),
                request: interceptedRequest,
                navigation: true,
                unguardedPageNavigation: null,
                ...(countsPageNavigation
                  ? {
                    admitPageNavigation: (): PageLimitAdmission =>
                      (isMainFrameDocument
                        ? admitMainFrameNavigation(page, event.request.url)
                        : admitChildFrameNavigation(page, event.frameId, event.request.url)),
                  }
                  : {}),
                // DEF-208-1: 凍結の段の、子の frame の文書の読み取り（main frame の移動は、判定が偽を返して今どおり止める）。
                frozenRead: frozenReadOf({
                  method: interceptedRequest.method,
                  url: event.request.url,
                  isNavigationRequest: true,
                  isMainFrame: event.frameId === rootFrameId,
                  resourceType: requestResourceTypeOf(event.resourceType),
                }, cdpRequestPolicy),
                evaluate: (): GuardPolicyOutcome => {
                  if (!redirectedPredecessors.remember(event.requestId, interceptedRequest, Date.now())) {
                    return { kind: 'UNAVAILABLE' };
                  }
                  documentPolicy = cdpRequestPolicy();
                  // T36b: 自動ログインの資格情報の守り（ナビゲーションの GET を含む。token の送信のほか）。
                  const classified = credentialCheckedDecision(classifyPassiveRequest({
                    kind: 'HTTP',
                    method: interceptedRequest.method,
                    url: event.request.url,
                    isNavigationRequest: true,
                    isMainFrame: event.frameId === rootFrameId,
                    // T34b: Document の横取りの事象（種類は `Document`）。
                    resourceType: requestResourceTypeOf(event.resourceType),
                    // L12b: リダイレクトの続き（書き込みの段の押した後の扱いは、本文の送り直しを通さない）。
                    ...(redirectedFrom === undefined ? {} : { redirectReplay: true }),
                    // RB-4b（X1）: 文書の要求（form の送信）も、method の上書き（ヘッダと本文の `_method`）で削除を伝えるかを判定に渡す（文書の送信を通すので）。
                    sentContent: {
                      headers: event.request.headers,
                      formMethodOverrides: () => formMethodOverrideValuesOf(
                        event.request.headers,
                        () => requestBodyTextOf(event.request.hasPostData, event.request.postDataEntries),
                      ),
                    },
                  }, authoritySnapshot, documentPolicy), { method: interceptedRequest.method, url: event.request.url, headers: event.request.headers },
                  () => requestBodyTextOf(event.request.hasPostData, event.request.postDataEntries), cookies);
                  if (
                    classified.action === 'ALLOW'
                    && writeStage !== undefined
                    && submissionAdmission !== undefined
                    && !isReadMethod(interceptedRequest.method)
                    // L12a: 押した後の扱いで通したページの送信（承認した送信でない）は、照合にかけない（承認の回数にも数えない。下の記録の所）。
                    && classified.auditSendAdmission !== true
                  ) {
                    // T30b: 承認の形の POST の本文を、続ける前に照合する（同期の関数。照合と数えるの間に、ほかの要求の判定は入らない）。文書の文字コードは、
                    // この page で送信の窓を開いたときに読んだ値（その後に main frame の文書が変わっていれば `null`）。照合が止めたら、以後どの POST も
                    // 許さない（回数を使い切る）。
                    // T39b: API の書き込みの段は、文書の要求（form の送信）を送らない（判定は通さないが、通した場合も止める。fail-closed）。
                    if (writeStage.transport === API_SCENARIO_TRANSPORT) {
                      submissionAdmission.spend();
                      return { kind: 'DECISION', decision: { action: 'BLOCK', category: 'REQUEST', reason: 'NON_READ_METHOD' } };
                    }
                    // LU-12a: 前の値を後から入れる印のある期待は、入れた期待で照らす。入れていなければ印のある期待のまま照らし、必ず
                    // `EXPECTATION_INVALID` で止まる（fail-closed。API の形と同じ扱い）。
                    const payloadVerdict = checkWritePayload(suppliedPriorExpectationOf<WritePayloadExpectation>(writeStage.monitor, FORM_SCENARIO_TRANSPORT) ?? writeStage.expectation, {
                      method: event.request.method,
                      url: event.request.url,
                      isMainFrameNavigation: mainFrameId !== null && event.frameId === rootFrameId,
                      contentType: headerValueOf(event.request.headers, CONTENT_TYPE_REQUEST_HEADER) ?? null,
                      hasPostData: event.request.hasPostData === true,
                      postDataEntries: event.request.postDataEntries ?? null,
                      documentCharset: mainFrameId !== null && writeDocument.page === page ? writeDocument.charset : null,
                    });
                    if (payloadVerdict !== 'ALLOW') {
                      submissionAdmission.spend();
                      payloadBlockReason = payloadVerdict;
                      return { kind: 'DECISION', decision: { action: 'BLOCK', category: 'REQUEST', reason: 'NON_READ_METHOD' } };
                    }
                  }
                  return { kind: 'DECISION', decision: classified };
                },
              });
              // DEF-125: 通した文書の要求の宛先を、中継に知らせる（命令を送る前。リダイレクトの先も、ここで知らせる）。
              admitEgressDestinationOf(verdict, 'CDP_DOCUMENT');
              countFrozenRead(page, verdict);
              rememberFrozenFrameDocument(verdict);
              if (verdict.kind === 'BLOCK_FROZEN') {
                // SAFE-2 の 2（DEF-242）: 操作さがしの凍結の段で、ページが始めた main frame の移動は、204 で応えて今の文書を残す（止めた記録は今どおり）。
                const noContent = commands.fulfillNoContent !== undefined && blockedMainFrameNavigationResponseOf({
                  phase,
                  mainFrame: isMainFrameDocument && redirectedFrom === undefined,
                  // 凍結の段の BeakSight 自身の読み込みは、口（`admitFrozenMainFrameDocument`）が行き先を通すので、ここ（凍結で止めた移動）には来ない。止めた main frame
                  // の移動は、ページが始めたもの（DEF-129 の `ownNavigationPending` は、凍結の段では数え直さないので使わない）。
                  ownNavigation: false,
                  observing: submissionObservation !== undefined,
                }) === 'NO_CONTENT';
                // SREV-SAFE の I-1: 204 で応えた移動も、その後の `net::ERR_ABORTED` を予期した失敗として登録する（読み取りの失敗の記録にしない。止めた記録は下で残す）。
                const expectedFailure = expectedCdpFailures.register(
                  page, playwrightVisibleRequest, Date.now(), blockedMainFrameNavigationFailureTextOf(noContent ? 'NO_CONTENT' : 'BLOCKED_BY_CLIENT'),
                );
                recordGuardVerdictBeforeBlock(ledger, verdict);
                // T37b: 観察の口が有効なら、止める文書の要求の型も口に渡す（止め方と記録は今どおり）。
                observeFrozenRequest(verdict.request, event);
                let invalidationNeeded = expectedFailure === null;
                try {
                  await (noContent && commands.fulfillNoContent !== undefined ? commands.fulfillNoContent() : commands.failRequest());
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
              if (verdict.kind === 'BLOCK_LIFECYCLE' || verdict.kind === 'BLOCK_INVALID') {
                recordGuardVerdictBeforeBlock(ledger, verdict);
                const failed = await failPausedDocumentForLifecycle(
                  context,
                  commands,
                  ledger,
                  expectedCdpFailures,
                  page,
                  playwrightVisibleRequest,
                );
                if (verdict.kind === 'BLOCK_INVALID') initiateInvalidation(context, ledger);
                // BN-a（設計書 3.1 の 2）: 閉じる途中に止めた文書の要求を、止めた後に記録する（止め方は変えない）。
                if (verdict.kind === 'BLOCK_LIFECYCLE' && failed) {
                  ledger.recordBlockedClosingRequest({
                    method: interceptedRequest.method,
                    url: interceptedRequest.url,
                    resourceType: requestResourceTypeOf(event.resourceType),
                    speculative: isSpeculativeRequestHeaders(event.request.headers),
                  });
                }
                return;
              }
              if (verdict.kind === 'BLOCK_UNAVAILABLE' || verdict.kind === 'FULFILL_PREFLIGHT') {
                // リダイレクトの対応付けの登録の失敗（登録の側が違反を記録した）。Document の要求に CORS の事前確認はない（来ない結果）。
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
              // T35b: 承認したサービスの Origin への文書の要求（サブ frame の移動）も、通す前に上限の部品で数える。断られたら、上限で止めた判定にする。
              const decision: PassiveRequestDecision = serviceRequestLimitOf(verdict.decision, interceptedRequest.url) ?? verdict.decision;
              /** DEF-099 fix: この要求が、Guard が通した承認の POST（送り手に送らせる）か。 */
              let admittedWrite = false;
              if (decision.action === 'ALLOW' && decision.manualLoginPassThrough !== undefined && submissionAdmission !== undefined) {
                // ML-a: 手動のログインの段の口が通した文書の要求（フォームの送信、サブ frame の移動）は、回数に数えず、読み取りでない要求の形だけを記録する。
                if (!isReadMethod(interceptedRequest.method)) {
                  submissionAdmission.recordManualPass(event.request.url, requestResourceTypeOf(event.resourceType), decision.manualLoginPassThrough.reason);
                }
              } else if (decision.action === 'ALLOW' && writeStage !== undefined && decision.auditSendAdmission === true) {
                // L12a: 書き込みの段の押した後に、ページが自分で送った文書の要求（form の送信など）。承認した送信の回数に数えず、送り手にも渡さない（ブラウザが
                // そのまま送る）。承認した送信のほかの送信として、通した一覧に記録する。
                if (!isReadMethod(interceptedRequest.method)) {
                  recordWriteStagePassedOf({ method: interceptedRequest.method, url: event.request.url }, event);
                }
              } else if (decision.action === 'ALLOW' && submissionAdmission !== undefined && !isReadMethod(interceptedRequest.method)) {
                // T25b: 送信の段で許した POST を、続ける前に数える（この層だけで数える）。リダイレクトでやり直す POST は route の層に
                // 来ないので、route の層への印を置かない。T30R-fix-1（M-4）: 送り手が送る承認の POST（書き込みの段）も、ブラウザには送らせず
                // （`Fetch.fulfillRequest` で応答を返す）、route の層に来ないので、印を置かない（使われない印を残さない）。
                const sentBySender = writeStage !== undefined && writeSubmission !== undefined;
                submissionAdmission.admitAtCdp(
                  interceptedRequest.method,
                  event.request.url,
                  redirectedFrom === undefined && !sentBySender,
                  decision.loginStageAdmission,
                );
                if (writeStage !== undefined) {
                  // T30b: 通す（通そうとする）ので、送信の報告を `SENT` にする（通す命令が失敗しても `SENT` のまま。届いたかは分からない側）。
                  writeStageStateOf(writeStage.monitor).submission = 'SENT';
                  admittedWritePost = { page, requestId: event.requestId };
                  admittedWrite = true;
                }
              }
              if (decision.action === 'BLOCK') {
                // C18h: Guard がこのリクエストを失敗させるので、リクエストは終わる。リダイレクトの対応付けの登録を消す。
                redirectedPredecessors.forget(event.requestId);
                let expectedFailure: ExpectedCdpFailure | undefined;
                /** REV-EV4: 領域のキーの押下の期間に止めた main frame の移動を、204 で応えるか。 */
                let keyPressNoContent = false;
                // FRET: 窓を開くボタンの押す期間に止めた子の frame の要求も数える（main frame の要求は下の登録で数える）。
                if (decision.category === 'REQUEST' && decision.reason === SCROLL_KEY_PRESS_BLOCK_REASON && event.frameId !== rootFrameId) {
                  guardState.scrollKeyPressBlocks = saturatingIncrement(guardState.scrollKeyPressBlocks);
                }
                if (redirectedFrom !== undefined) {
                  expectedFailure = expectedCdpFailures.register(page, redirectedFrom, Date.now()) ?? undefined;
                } else if (
                  (decision.category === 'LOGIN_STAGE' || decision.category === 'WRITE_STAGE' || (decision.category === 'REQUEST' && decision.loginCredential === true)
                    // DEF-129: 上限で止めたページが始めた main frame の読み込みも、Guard が止めたことを登録する（許した移動の失敗と取り違えない）。
                    // T44R の I-1: ページを離れた後に止めた main frame の読み込みも同じ。
                    || (decision.category === 'REQUEST'
                      && (decision.reason === 'PAGE_NAVIGATION_LIMIT_REACHED' || decision.reason === 'PAGE_LEAVE_REQUEST_LIMIT_REACHED'
                        // fix round 3（設計書 3.2.2 の 4）: 通知の枠の閉じる押下の期間に止めた main frame の移動も、Guard が止めたことを登録する。
                        || decision.reason === NOTIFICATION_DISMISSAL_BLOCK_REASON
                        // REV-EV4: 領域のキーの押下の期間に止めた main frame の移動も、Guard が止めたことを登録する。
                        || decision.reason === SCROLL_KEY_PRESS_BLOCK_REASON)))
                  && event.frameId === rootFrameId
                ) {
                  if (decision.category === 'REQUEST' && decision.reason === NOTIFICATION_DISMISSAL_BLOCK_REASON) {
                    guardState.notificationPressNavigations = saturatingIncrement(guardState.notificationPressNavigations);
                  }
                  if (decision.category === 'REQUEST' && decision.reason === SCROLL_KEY_PRESS_BLOCK_REASON) {
                    guardState.scrollKeyPressBlocks = saturatingIncrement(guardState.scrollKeyPressBlocks);
                  }
                  // REV-EV4: 領域のキーの押下の期間に止めた main frame の移動は、204 で応えて今の文書を残す（その後の `net::ERR_ABORTED` を予期した失敗にする）。
                  keyPressNoContent = commands.fulfillNoContent !== undefined && blockedMainFrameNavigationResponseOf({
                    phase,
                    mainFrame: true,
                    ownNavigation: false,
                    observing: false,
                    scrollKeyPress: decision.category === 'REQUEST' && decision.reason === SCROLL_KEY_PRESS_BLOCK_REASON,
                  }) === 'NO_CONTENT';
                  // T36b: 資格情報の守りで止めた main frame の移動（フォームの既定の GET の送信など）も、同じく Guard が止めたことを登録する。
                  // T26g-1: 送信の段だけの理由で止めた main frame の移動（送信の窓の中の GET など。T30b: 書き込みの段も）。`requestfailed` の判定は
                  // 段の口を持たないので、Guard が止めたことを登録し、許した移動の失敗（`HTTP_MAIN_FRAME_DELIVERY_FAILED`）と取り違えない。
                  expectedFailure = expectedCdpFailures.register(
                    page, playwrightVisibleRequest, Date.now(), blockedMainFrameNavigationFailureTextOf(keyPressNoContent ? 'NO_CONTENT' : 'BLOCKED_BY_CLIENT'),
                  ) ?? undefined;
                }
                try {
                  await (keyPressNoContent && commands.fulfillNoContent !== undefined ? commands.fulfillNoContent() : commands.failRequest());
                  recordBlockedDecision(ledger, decision, {
                    method: event.request.method,
                    url: event.request.url,
                    mainFrameNavigation: event.frameId === rootFrameId,
                    resourceType: requestResourceTypeOf(event.resourceType),
                    // BN-a: 止めた時点（ページを離れた後なら `CLOSING`）。
                    phase: blockedEventPhaseOf(guardState.phase, page),
                    speculative: isSpeculativeRequestHeaders(event.request.headers),
                    headers: event.request.headers,
                    // OP-M: 書き込みの段の止めた要求の一覧の、目印の真偽だけに使う（記録しない）。
                    body: () => requestBodyTextOf(event.request.hasPostData, event.request.postDataEntries),
                  }, stageRecordingOf(submissionAdmission, documentPolicy, payloadBlockReason), auditMonitor, countedServiceOrigins, authoritySnapshot);
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
              if (admittedWrite && writeStage !== undefined && writeSubmission !== undefined) {
                await submitAdmittedWrite(event, writeStage.monitor, writeSubmission);
                return;
              }
              // DEF-292 の残り: 口が通した文書の要求の「通した」の記録は route の層が残す（リダイレクトの先の段は route の層に来ないので、今どおり記録しない）。
              // 続ける命令の後に target が外れたら、ここで記録する。
              if (auditSendAdmission !== undefined && decision.action === 'ALLOW' && decision.auditSendAdmission === true && redirectedFrom === undefined) {
                await continueRouteRecordedAuditSend(channel, page, interceptedRequest, commands.continueRequest);
                return;
              }
              await continueAllowedRequest(commands.continueRequest, 'REQUEST', context, ledger);
            });
          };
          /**
           * DEF-099 fix（Task 30 の設計書 11 章の DEF-099 の行）: Guard が通した承認の POST を、ブラウザに送らせず、照合した同じ本文の bytes で送り手に
           * 1 回だけ送らせる（中継を通す。再試行しない）。送り手の結果を送信の報告に書く（送った回数 1、結果の種類）。
           * - `RESPONDED`: 応答を、Document の応答の段階と同じ扱い（`handlePausedDocumentResponse`。送信の報告の status、外部スキームへの
           *   リダイレクトの止め方、リダイレクトの対応付けを今の時刻から数え直す）に通し、続ける命令の代わりに `Fetch.fulfillRequest` で返す。
           * - `NOT_WRITTEN`: 送信の報告を `NOT_SENT` に戻し（届いていない）、`Fetch.failRequest` で伝える。
           * - `NO_RESPONSE`: 送信の報告は `SENT` のまま（届いたかは分からない）、`Fetch.failRequest` で伝える。
           * POST の main frame の失敗は、`requestfailed` の判定で今の POST と同じく違反にしない。命令の失敗は違反にして Context を閉じる。
           */
          const submitAdmittedWrite = async (
            event: PausedDocumentEvent,
            monitor: WriteStageMonitor,
            options: WriteSubmissionOptions,
          ): Promise<void> => {
            const state = writeStageStateOf(monitor);
            state.sendAttempts = saturatingIncrement(state.sendAttempts);
            // T30R-fix-1（M-1）: 送っている間の取り消しを覚える。
            const submittingNetworkId = typeof event.networkId === 'string' && event.networkId.length > 0 ? event.networkId : null;
            if (submittingNetworkId !== null) {
              submittingNetworkIds.add(submittingNetworkId);
            }
            // DEF-100 fix: 送り手が要求の bytes を書き始める時刻を、読み込みの間隔の起点として記録する。
            const outcome = await sendWriteSubmissionOnce({
              url: event.request.url,
              method: event.request.method,
              headers: event.request.headers ?? {},
              body: writeSubmissionBodyOf(event),
            }, options, { onRequestWriteStart: recordMainFrameDocumentSent });
            state.sendOutcome = outcome.kind;
            // DEF-100 fix: 応答を受けた（承認の POST はサイトに届いた後である）時刻も、読み込みの間隔の起点として記録する。
            if (outcome.kind === 'RESPONDED') {
              recordMainFrameDocumentSent();
            }
            const commands = writeSubmissionCommands(event, monitor);
            if (outcome.kind !== 'RESPONDED') {
              if (outcome.kind === 'NOT_WRITTEN') {
                state.submission = 'NOT_SENT';
              }
              try {
                await commands.failRequestAs(WRITE_SUBMISSION_FAILURE_REASONS[outcome.kind]);
              } catch (error) {
                ledger.recordInvariantViolation({ code: 'CDP_FAIL_REQUEST_FAILED', message: errorMessage(error) });
                initiateInvalidation(context, ledger);
              }
              return;
            }
            const responseEvent: PausedDocumentEvent = {
              ...event,
              responseStatusCode: outcome.status,
              responseHeaders: outcome.headers.map(({ name, value }) => ({ name, value })),
            };
            await handlePausedDocumentResponse(responseEvent, guardState.phase, {
              continueRequest: () => commands.fulfillRequest(outcome),
              failRequest: () => commands.failRequestAs('BlockedByClient'),
            });
          };
          // DEF-026: 同じ session の `Network.loadingFailed`（取り消しの証拠）を受ける。
          const onLoadingFailed = (event: unknown): void => {
            canceledDocuments.recordLoadingFailed(event, Date.now());
            // T36b: 通した token の送信が、応答なしで終わった（ほかの要求は何もしない）。
            tokenResponseTracker?.loadingFailed(event);
            // T30R-fix-1（M-1）: 送り手が送っている承認の POST の要求の取り消し（Document）は、送り終わるまで覚える（取り消しの証拠の保ち時間を
            // 過ぎても、応答を返す命令の失敗を取り消しと分かるように）。
            const { requestId, canceled, type } = (typeof event === 'object' && event !== null ? event : {}) as {
              readonly requestId?: unknown;
              readonly canceled?: unknown;
              readonly type?: unknown;
            };
            if (typeof requestId === 'string' && submittingNetworkIds.has(requestId) && canceled === true && type === CANCELED_DOCUMENT_RESOURCE_TYPE) {
              canceledDuringSubmission.add(requestId);
            }
          };
          return Object.freeze({
            onRequestPaused,
            onLoadingFailed,
            // DEF-027: 同じ session の、main frame の文書の要求が応答を受けたか、終わったか（記録のない要求の事象は、何もしない）。
            // T36b: 通した token の送信の応答の状態のコードと `Retry-After`（ほかの要求は何もしない）。
            onResponseReceived: (event: unknown): void => {
              canceledDocuments.recordResponseReceived(event);
              tokenResponseTracker?.responseReceived(event);
            },
            // DEF-042 の設計書 2.4: CORS の事前確認の要求（`initiator.type` が `preflight`）も、ここで覚える。
            onRequestWillBeSent: (event: unknown): void => {
              canceledDocuments.recordRequestWillBeSent(event);
              preflightInitiators.record(event, Date.now());
              // T39b: API の書き込みの段の、page の main frame のページのスクリプトの要求かの記録（page の session だけ）。
              if (mainFrameId !== null && apiWriteStage !== undefined) scriptInitiators.record(event, Date.now());
            },
            onLoadingFinished: (event: unknown): void => canceledDocuments.recordLoadingFinished(event),
            awaitMainFrameCancellation: (request: CorrelationRequest, waitMs: number): Promise<boolean> =>
              canceledDocuments.awaitMainFrameCancellation(request, waitMs),
            clear: () => {
              redirectedPredecessors.clear();
              canceledDocuments.clear();
              preflightInitiators.clear();
              scriptInitiators.clear();
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
          // DEF-292 の残り: target が外れたのでなく閉じた session の、route の層の記録待ちの行は、記録せずに捨てる（外れたときは先に移してある）。
          awaitedRouteAuditSends.discard(node.channel);
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
          // L10（INV-LIMITS の N22）: 同時に横取りを付ける OOPIF の数の上限（前は `MAX_GUARD_OOPIF_SESSIONS` 64 で、超えたら `OOPIF_GUARD_ATTACH_FAILED` にして
          // Context を閉じた）は撤廃した。どの OOPIF にも横取りを付ける。
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
            // T36b: この OOPIF の session の `Network.responseReceived`（通した token の送信の応答の状態。別のプロセスの iframe が送った場合）。
            if (method === 'Network.responseReceived') {
              interception?.onResponseReceived(eventParams);
              return;
            }
            // DEF-042 の設計書 2.4: この OOPIF の session の `Network.requestWillBeSent`（CORS の事前確認の判定の根拠）。
            if (method === 'Network.requestWillBeSent') {
              interception?.onRequestWillBeSent(eventParams);
              return;
            }
            // EL-12: この OOPIF の session の外部スキームへの移動の事象（OOPIF の frame は、どれも sub frame）。
            if ((EXTERNAL_NAVIGATION_CDP_EVENTS as readonly string[]).includes(method)) {
              onExternalNavigationCdpEvent(channel, null, method, eventParams);
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
              // EL-12: 外部スキームへの移動の検出のため、子を進める前に `Page` の domain を有効にする（失敗は `OOPIF_GUARD_ATTACH_FAILED`）。
              await channel.send('Page.enable');
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
              // DEF-292 の残り: 続ける命令は届いたが route の層に着く前に外れた要求（Chromium が解き放つ）を、「通した」に記録する（入れ子の OOPIF も）。
              const recordDetached = (detached: OopifGuardNode): void => {
                recordDetachedAwaitedAuditSends(detached.channel);
                for (const child of detached.children.values()) recordDetached(child);
              };
              recordDetached(node);
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
          awaitedRouteAuditSends.discard(session);
          pageInterception.clear();
          disposeOopifSessions(pageOopifSessions);
          expectedCdpFailures.clear(page);
          // L10（T29）: 止めたダウンロードの記録も、持ち主の page の session を閉じたときに捨てる（期限を持たない）。
          passiveDownloads.clear(page);
          releasePageListenerGroup(guardState, page);
          if (
            !ownerClosingPages.has(page)
            && !isClosingOrInvalidatingPhase(guardState.phase)
          ) {
            ledger.recordInvariantViolation({
              code: 'CDP_SESSION_DETACHED',
              message: CDP_SESSION_DETACHED_MESSAGE,
            });
            initiateInvalidation(context, ledger);
          }
        };
        if (!listenerGroup.active || guardState.listenerCleanups.pages.get(page) !== listenerGroup) {
          throw new Error('Passive request guard page listener cleanup owner was released during setup');
        }
        session.on('close', onSessionClose);
        listenerGroup.cleanups.push(() => session.off('close', onSessionClose));
        // DEF-292 の残り（REV-CP の Minor-3）: page の後片付けで、その page の「通した」の記録待ちの行を捨てる。
        listenerGroup.cleanups.push(() => awaitedRouteAuditSends.discardPage(page));
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
            // BN-a: 止めた時点（ページを離れた後なら `CLOSING`）。
            ledger.recordBlockedWebSocket({ url, reason: WORKER_CONNECT_POLICY_REASON, phase: blockedEventPhaseOf(phase, page) });
            // OP-N（N1）: 書き込みの段の、値を入れた後の目印のない WebSocket は、止めたまま、予期しない要求の数に数えない。
            submissionAdmission?.monitor.recordOtherBlock(
              submissionAdmission.monitor.isSubmissionWindowOpen(),
              toleratedWebSocketInWriteWindow(submissionAdmission.monitor, url),
            );
            // OP-M: 書き込みの段なら、止めた要求の一覧にも記録する（本文はない）。
            recordWriteStageBlockedWebSocket(submissionAdmission?.monitor, url, WORKER_CONNECT_POLICY_REASON);
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
        // EL-12: 外部スキームへの移動の検出（`Page.frameStartedNavigating`・`Page.windowOpen`・予備の `Page.frameNavigated`）。page の準備の前に聞き始め、
        // `Page.enable` を送る（失敗したら、上と同じく page の準備の失敗 `CDP_SETUP_FAILED` にする。fail-closed）。
        for (const method of EXTERNAL_NAVIGATION_CDP_EVENTS) {
          const onExternalNavigationEvent = (params: unknown): void => {
            onExternalNavigationCdpEvent(session, rootFrameId, method, params);
            // SREV-SAFE の I-4: main frame の文書の替わりの記録も、同じ事象で受ける。
            if (method === 'Page.frameNavigated') mainFrameDocumentObservers.get(page)?.(params, rootFrameId);
          };
          session.on(method, onExternalNavigationEvent);
          listenerGroup.cleanups.push(() => session.off(method, onExternalNavigationEvent));
        }
        await session.send('Page.enable');
        // EL-F2（N1）: 付ける前にすでに確かになっていた外部スキームへの移動（ポップアップの最初の移動など）も拾う。
        await recordSettledExternalNavigations(session);
        // AS-c fix round 1（C-1・C-2）: 監査の段の送信の扱いの口がある Context だけ、ブラウザが開く WebSocket の接続を観察する（page の準備の前に付け、最初の
        // 読み込みの接続から観察する。付けられなくても、page の準備は失敗にしない）。
        if (webSocketAuditSendAdmission !== undefined) {
          await observeAuditSendWebSockets(page, listenerGroup);
        }
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

  if (writeStage !== undefined) {
    /**
     * T30b: 書き込みの段の送信の窓を開いたときに、`page` の main frame の文書の文字コードを読む（`WriteStageMonitor.openSubmissionWindow`）。
     * - 読むのは Guard の page の session の isolated world（ページの JS の書き換えの影響を受けない）。page の session の `Page` の domain を有効にし、
     *   main frame の文書が変わった（`Page.frameNavigated`・`Page.documentOpened`）ら、読んだ値を捨てる（listener は page の後片付けで外す）。
     * - 読めない（page がこの Context のものでない、Guard の準備ができていない、命令の失敗、`WRITE_STAGE_CHARSET_READ_TIMEOUT_MS` を過ぎた）場合は、
     *   値を持たない（承認の POST は `DOCUMENT_CHARSET_UNKNOWN` で止まる）。例外を投げない。
     */
    const measureWriteDocument = async (page: Page): Promise<void> => {
      writeDocument.page = null;
      writeDocument.charset = null;
      if (page.context() !== context || page.isClosed() || guardState.phase !== 'PASSIVE_ACTIVE') {
        return;
      }
      const record = pageGuards.get(page);
      const listenerGroup = guardState.listenerCleanups.pages.get(page);
      if (record?.status !== 'READY' || listenerGroup === undefined || !listenerGroup.active) {
        return;
      }
      const { session, rootFrameId } = await record.ready;
      let documentChanged = false;
      const onDocumentChange = (event: unknown): void => {
        if (mainFrameIdOfPageEvent(event) !== rootFrameId) {
          return;
        }
        documentChanged = true;
        if (writeDocument.page === page) {
          writeDocument.charset = null;
        }
      };
      session.on('Page.frameNavigated', onDocumentChange);
      listenerGroup.cleanups.push(() => session.off('Page.frameNavigated', onDocumentChange));
      session.on('Page.documentOpened', onDocumentChange);
      listenerGroup.cleanups.push(() => session.off('Page.documentOpened', onDocumentChange));
      const read = (async () => {
        await session.send('Page.enable');
        const world = await session.send('Page.createIsolatedWorld', { frameId: rootFrameId, worldName: WRITE_STAGE_CHARSET_WORLD_NAME });
        return session.send('Runtime.evaluate', {
          expression: DOCUMENT_CHARSET_EXPRESSION,
          contextId: world.executionContextId,
          returnByValue: true,
        });
      })();
      // L12b（設計書 `2026-11-09-beaksight-remove-limits-design.md` 6.2。T34 の送り手の側）: 前の 2 秒の上限は
      // 撤廃し、1 回のブラウザの呼び出しを見放す長さ（L0 の反応なしの長さ `PROGRESS_WATCH_QUIET_LIMIT_MS`。書き込みの入力の部品の 1 手と同じ）だけ待つ。
      const outcome = await awaitBeforeDeadline(read, Date.now() + PROGRESS_WATCH_QUIET_LIMIT_MS);
      if (outcome.status !== 'FULFILLED' || documentChanged || outcome.value.exceptionDetails !== undefined) {
        return;
      }
      const charset: unknown = outcome.value.result.value;
      if (typeof charset === 'string') {
        writeDocument.page = page;
        writeDocument.charset = charset;
        writeStageStateOf(writeStage.monitor).documentCharsetRead = true;
      }
    };
    writeStageStateOf(writeStage.monitor).measureDocument = async (page: Page): Promise<void> => {
      // T39b: 窓を開いた page を覚える（最初の 1 回だけ。窓は開き直せない）。
      if (apiWriteStage !== undefined && apiWriteWindowPage === null) {
        apiWriteWindowPage = page;
      }
      try {
        await measureWriteDocument(page);
      } catch {
        // 読めなかった（値を持たない。承認の POST は止まる）。
      }
    };
    // OP-M: 止めた、承認した送信のほかの要求の一覧。目印は、この段で入れる生成した値（API は鍵ごとの値、form は送る欄の値）。送り先の区分は、許可 Origin
    // （テスト環境）→ 承認したサービスの Origin（監査の段の承認したサービスの Origin と、承認した API の Origin）→ 許可の外、の順に決める。
    const writeStageState = writeStageStateOf(writeStage.monitor);
    // LU-9・LU-12a（設計書 5.3 の 2）: 前の値を後から入れる印のある期待だけ、送り方の前の値の口を開く（写しの期待。入れるのは窓を開く前の 1 回だけ）。
    if (writeStage.expectation.deferredPriorValues !== undefined) {
      writeStageState.deferredPrior = writeStage.transport === API_SCENARIO_TRANSPORT
        ? { transport: API_SCENARIO_TRANSPORT, deferred: writeStage.expectation, supplied: null }
        : { transport: FORM_SCENARIO_TRANSPORT, deferred: writeStage.expectation, supplied: null };
    }
    const writeStageMarkers = writeStage.transport === API_SCENARIO_TRANSPORT
      ? Object.values(writeStage.expectation.values).filter((value): value is string => value !== null)
      : writeStage.expectation.submittedFields.map(({ value }) => value);
    writeStageState.unexpectedRequests = new WriteStageUnexpectedRequestList(writeStageMarkers);
    // OP-N（N2）: 送信の扱いの口で通した要求の一覧（同じ目印。通すのは値を入れる前だけ）。
    writeStageState.passedRequests = new WriteStageUnexpectedRequestList(writeStageMarkers);
    const writeStageServiceOrigins: ReadonlySet<string> = new Set([
      ...countedServiceOrigins,
      ...(writeStage.transport === API_SCENARIO_TRANSPORT ? [writeStage.expectation.spec.request.origin] : []),
    ]);
    writeStageState.destinationOf = (url: string): WriteStageRequestDestination => {
      if (hasAllowedOrigin(url, authoritySnapshot)) return 'TEST_ORIGIN';
      return hasAllowedOrigin(url, writeStageServiceOrigins) ? 'APPROVED_SERVICE_ORIGIN' : 'OUTSIDE_ALLOWED_ORIGINS';
    };
  }

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
    watchFrozenPopupExternalNavigation(page);
  };
  /**
   * EL-F（EL-R の I1）: 凍結の段階のポップアップ（`ensurePageGuard` を付けない頁）にも、外部スキームへの移動の検出だけを付ける。CDP の session を作り、
   * `EXTERNAL_NAVIGATION_CDP_EVENTS` の listener と `Page.enable` だけを付ける（ほかの Guard の処理は、今どおり付けない）。ポップアップを `about:blank` で
   * 開いてから外部スキームへ移す形（`w = window.open('about:blank'); w.location.href = 'mailto:…'`）は、opener の `Page.windowOpen` に来ず、設定ありの
   * Chromium では `request` も来ないためである。付けられなかったとき（ポップアップが閉じた後を除く）は、page の準備の失敗（`CDP_SETUP_FAILED`）として
   * Context を閉じる（fail-closed）。session は、ポップアップと一緒に閉じる。
   * EL-F2（EL-R2 の N1）: `Page.enable` の後に、付ける前にすでに確かになっていた移動（`recordSettledExternalNavigations`）も拾う。
   * EL-F2（EL-R2 の N3）: listener の組は、page の組と同じ登録（`listenerCleanups.pages`）と上限（`MAX_GUARD_PAGE_LISTENER_GROUPS`）で数え、上限を超えたら
   * page の組と同じく `GUARD_LISTENER_GROUP_LIMIT_REACHED` で Context を閉じる。ポップアップが閉じたら、listener を外し session を切る。
   */
  const watchFrozenPopupExternalNavigation = (page: Page): void => {
    // 閉じる途中（無効化を含む）は付けない（ポップアップは Context と一緒に閉じる。page の組と同じ扱い）。
    if (guardState.listenerCleanups.pages.has(page) || isClosingOrInvalidatingPhase(guardState.phase) || guardState.phase === 'CLOSED') {
      return;
    }
    // L10（INV-LIMITS の N22）: listener の組の数の上限（前は `MAX_GUARD_PAGE_LISTENER_GROUPS` 64 で `GUARD_LISTENER_GROUP_LIMIT_REACHED`）は撤廃した。
    const listenerGroup: ListenerCleanupGroup = { active: true, cleanups: [] };
    guardState.listenerCleanups.pages.set(page, listenerGroup);
    const onPopupClose = (): void => releasePageListenerGroup(guardState, page);
    page.on('close', onPopupClose);
    listenerGroup.cleanups.push(() => page.off('close', onPopupClose));
    trackGuardTask(guardState, 'frozen popup external scheme watch', 'GUARD_FROZEN_POPUP_WATCH_TASK_FAILED', async () => {
      try {
        const opened = await context.newCDPSession(page);
        listenerGroup.cleanups.push(() => void opened.detach().catch(() => undefined));
        if (!listenerGroup.active) {
          // 付ける途中で、ポップアップか Context が閉じた（後片付けは済んでいる）。
          void opened.detach().catch(() => undefined);
          return;
        }
        const frameTree = await opened.send('Page.getFrameTree');
        const rootFrameId = frameTree.frameTree.frame.id;
        for (const method of EXTERNAL_NAVIGATION_CDP_EVENTS) {
          const onExternalNavigationEvent = (params: unknown): void => onExternalNavigationCdpEvent(opened, rootFrameId, method, params);
          opened.on(method, onExternalNavigationEvent);
          listenerGroup.cleanups.push(() => opened.off(method, onExternalNavigationEvent));
        }
        await opened.send('Page.enable');
        await recordSettledExternalNavigations(opened);
      } catch (error) {
        releasePageListenerGroup(guardState, page);
        if (page.isClosed() || isClosingOrInvalidatingPhase(guardState.phase) || guardState.phase === 'CLOSED') {
          return;
        }
        ledger.recordInvariantViolation({ code: 'CDP_SETUP_FAILED', message: errorMessage(error) });
        initiateInvalidation(context, ledger);
      }
    });
  };
  /**
   * fix round 3（設計書 3.2.2 の 4）: route に来たナビゲーションの要求が、通知の枠の閉じる押下の期間に開いたポップアップ（CDP を付けていない page）のものか。
   * 押す期間で、要求の page を引けないか、押す期間のポップアップの page のときに真。
   */
  const notificationPressPopups = new WeakSet<Page>();
  const isNotificationPressPopupRequest = (request: Request): boolean => {
    // REV-EV4: 領域のキーの押下の期間に開いたポップアップも同じ扱い。
    // FRET: 窓を開くボタンを押した後の止めの続きの間のポップアップも同じ扱い。
    if (guardState.notificationPress === null && !guardState.scrollKeyPress && !guardState.dialogPressHold) return false;
    try {
      const requestPage = request.frame().page();
      return notificationPressPopups.has(requestPage) || pageGuards.get(requestPage)?.status !== 'READY';
    } catch {
      return true;
    }
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
    // fix round 3（設計書 3.2.2 の 4）: 通知の枠の閉じる押下の期間に開いたポップアップは、Guard が止めたポップアップとして記録して閉じる（Guard を付けない。違反に
    // しない）。ポップアップの文書の要求は、route の層が止める（`isNotificationPressPopupRequest`）。
    if (guardState.notificationPress !== null && !guardState.listenerCleanups.pages.has(page)) {
      notificationPressPopups.add(page);
      guardState.notificationPressNavigations = saturatingIncrement(guardState.notificationPressNavigations);
      ledger.recordBlockedPopup({ url: page.url(), reason: NOTIFICATION_DISMISSAL_BLOCK_REASON });
      void page.close().catch(() => undefined);
      return;
    }
    // REV-EV4: 領域のキーの押下の期間に開いたポップアップも、Guard が止めたポップアップとして記録して閉じる（違反にしない）。
    if ((guardState.scrollKeyPress || guardState.dialogPressHold) && !guardState.listenerCleanups.pages.has(page)) {
      notificationPressPopups.add(page);
      guardState.scrollKeyPressBlocks = saturatingIncrement(guardState.scrollKeyPressBlocks);
      ledger.recordBlockedPopup({ url: page.url(), reason: SCROLL_KEY_PRESS_BLOCK_REASON });
      void page.close().catch(() => undefined);
      return;
    }
    if (guardState.listenerCleanups.pages.has(page)) {
      return;
    }
    // L10（INV-LIMITS の N22）: listener の組の数の上限（前は `MAX_GUARD_PAGE_LISTENER_GROUPS` 64 で `GUARD_LISTENER_GROUP_LIMIT_REACHED`）は撤廃した。
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
      // DEF-225: 凍結の前のダウンロードだけを、main frame の読み取りの移動の失敗と対応付けるために覚える（凍結の段の扱いは変えない）。
      if (!frozen) passiveDownloads.record(page, download.url(), Date.now());
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
            // DEF-225: Guard が Context を閉じ始めた後の、Context が消えた形の取り消しの失敗は、違反にしない（DEF-050 と同じ考え）。Context は
            // `acceptDownloads: false` で作るので、Chromium が自分で取り消し、何も保存しない（`isDownloadCancelAfterContextGoneFailure` の根拠）。閉じる前の失敗と、
            // ほかの形の失敗と、凍結の段の失敗は、今までどおり違反。
            if (!frozen && isDownloadCancelAfterContextGoneFailure(errorMessage(error)) && hasContextCloseStarted(guardState)) {
              return;
            }
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
    /** SREV-SAFE の I-3: この page の main frame の、直前の文書の URL（fragment を外した形。`#` だけの移動を見分ける）。 */
    let previousMainFrameDocument: string | null = null;
    const recordFrozenFrameNavigation = (url: string, mainFrame: boolean): void => {
      const documentKey = frameDocumentKeyOf(url);
      const sameDocument = mainFrame && previousMainFrameDocument === documentKey;
      if (mainFrame) previousMainFrameDocument = documentKey;
      // DEF-208-1: 凍結の段で通した文書（子の frame と、SREV-SAFE の I-3 から main frame の口で通した文書とそのリダイレクトの先）の移動は、止めた移動として記録しない。
      // SREV-SAFE の I-3: 同じ文書の中の `#` だけの移動と、最初の about:blank も、止めた移動ではない（本当に止めた移動は、要求の層が止めた記録に残す）。
      if (isFrozenPhase(guardState.phase) && !frozenFrameDocuments.has(documentKey) && !sameDocument && url !== 'about:blank') {
        ledger.recordBlockedInteractionNavigation({
          method: 'GET',
          url,
          reason: 'INTERACTION_FROZEN',
        });
      }
    };
    /**
     * SREV-SAFE の I-4: main frame の文書の替わりは、page の session の準備ができた後（`READY`）は、CDP の `Page.frameNavigated`（文書が替わったときだけ出る。同じ
     * 文書の中の `pushState`・`replaceState`・`#` は `Page.navigatedWithinDocument` で、ここには来ない）で記録する（`blob:`・`data:` への移動も、ここで記録する）。
     * 準備の前・失敗の間は、main frame も Playwright の事象で記録する（fail-closed）。
     */
    const onFrameNavigated = (frame: Frame): void => {
      const mainFrame = frame === page.mainFrame();
      if (mainFrame && pageGuards.get(page)?.status === 'READY') return;
      recordFrozenFrameNavigation(frame.url(), mainFrame);
    };
    mainFrameDocumentObservers.set(page, (params: unknown, rootFrameId: string): void => {
      const frame = isRecord(params) && isRecord(params.frame) ? params.frame : null;
      if (frame === null || frame.id !== rootFrameId || typeof frame.url !== 'string') return;
      recordFrozenFrameNavigation(frame.url + (typeof frame.urlFragment === 'string' ? frame.urlFragment : ''), true);
    });
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
  /**
   * DEF-225: main frame の読み取りの移動 `request`（応答を受けた後に失敗したもの）が、同じ page・同じ URL の、Guard が凍結の前に止めたダウンロードの記録と
   * 1 対 1 に対応付けられるか（`PassiveDownloadRegistry`）。応答（ヘッダ）を受けていない、応答を取り出せない、page の Guard の準備ができていない場合は、偽。
   * 記録がまだなければ `PASSIVE_DOWNLOAD_EVIDENCE_WAIT_MS` まで待つ（実機では `requestfailed` が先に来る）。
   */
  const isMainFrameDownloadConfirmed = async (page: Page, request: Request): Promise<boolean> => {
    if (pageGuards.get(page)?.status !== 'READY') {
      return false;
    }
    let responded = false;
    try {
      responded = (await request.response()) !== null;
    } catch {
      // 応答の取り出しの失敗は、応答がないものとして扱う（違反のまま）。
    }
    if (!responded) {
      return false;
    }
    // 失敗を受けた時点で閉じる途中なら、ここへは来ない（閉じる途中の `net::ERR_ABORTED` は、その前に違反にしない）。失敗の後に閉じ始めても（監査は、読み込みの
    // 失敗を受けるとすぐに閉じる）、待ちを縮めない（ダウンロードの事象は失敗の数 ms 後に来る。待ちは閉じる処理の作業の待ち `GUARD_PENDING_TASK_DRAIN_TIMEOUT_MS`
    // より短い）。
    return passiveDownloads.awaitAndConsume(page, request.url(), PASSIVE_DOWNLOAD_EVIDENCE_WAIT_MS);
  };
  /**
   * DEF-113（Task 32 の設計書 4.4）: route に来たナビゲーションの要求が、Guard が CDP の session を付けた印（`pageGuards` の `READY`）のある
   * page のものでなければ、違反の文を返す（あれば `null`）。印のない page は、page を引けないもの（ポップアップの最初の要求は frame がまだない）、
   * 準備の途中のもの、準備に失敗したものである。frame の判定（`classifyMainFrame`）の成否には頼らない。
   */
  const unguardedPageNavigationOf = (request: Request): string | null => {
    const target = `${request.method()} ${request.url()}`;
    let page: Page;
    try {
      page = request.frame().page();
    } catch (error) {
      return `Navigation started before explicit page readiness: ${target} (no page is available for the request: ${errorMessage(error)})`;
    }
    return pageGuards.get(page)?.status === 'READY' ? null : `Navigation started before explicit page readiness: ${target}`;
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
        // SAFE-2 の 4: frame を引けない失敗した要求は、frame の判定の失敗の記録に残す（違反にせず、Context も閉じない。要求はもう失敗している）。
        const isMainFrame = classifyMainFrame(request, () => recordFrameClassificationFailureOf(request));
        if (isMainFrame === undefined) {
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
        // DEF-213: ページが main frame を `blob:`・`data:` へ移そうとして失敗した（不正な blob の `net::ERR_FILE_NOT_FOUND` など）。要求はネットワークへ
        // 出ていない（配送の失敗ではない）ので、`HTTP_MAIN_FRAME_DELIVERY_FAILED` の違反にしない（凍結の前後とも。Context は閉じない）。移動は失敗のまま
        // 残る。http(s) の移動の失敗と、リダイレクトの続きの失敗は、今の判定のまま。
        if (isMainFrame && request.isNavigationRequest() && isNetworkFreeMainFrameNavigationFailure(request)) {
          return;
        }
        if (isMainFrame && boundedCorrelationRequest(request.method(), request.url()) === null) {
          // SAFE-2 の 4: 読み取りの失敗は、違反でなく読み取りの失敗の記録にする（Context は閉じない）。
          if (recordReadNavigationFailureIfRead(request, message)) return;
          // DEF-145: 違反に、失敗した main frame の要求（method と URL。Ledger が Origin と path だけを残す）を付ける。
          ledger.recordInvariantViolation({
            code: HTTP_MAIN_FRAME_DELIVERY_FAILED_VIOLATION_CODE,
            message,
            request: { method: request.method(), url: request.url() },
          });
          requestInvalidation();
          return;
        }
        const decision = classifyPassiveRequest({
          kind: 'HTTP',
          method: request.method(),
          url: request.url(),
          isNavigationRequest: request.isNavigationRequest(),
          isMainFrame,
          resourceType: requestResourceTypeOfRequest(request),
          // AS-c fix round 1（I-2）: 止めた要求の失敗を、止めた判定と同じに読むため、method の上書きの中身も渡す。
          sentContent: requestSentContentOf(request),
        }, authoritySnapshot, requestFailedPolicy);
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
          // DEF-225: 許可した読み取りのナビゲーションが、凍結の前に、応答（ヘッダ）を受けた後に `net::ERR_ABORTED` で失敗し、同じ page・同じ URL の、Guard が
          // 止めたダウンロード（`PASSIVE_DOWNLOAD`。本文はページにも保存にも渡っていない）と 1 対 1 に対応付けられた場合は、Guard 自身が止めたことによる予期した
          // 失敗で、Guard の違反ではない（Context は閉じない）。その page の読み込みの事実に印を付ける（監査はその画面を理由つきの読めなかった画面にする）。
          // 対応付けられない場合（ダウンロードの記録がない、別の URL、記録を使い終えた、待っても来ない）は、これまでどおり違反とする（fail-closed）。
          if (
            !isFrozenPhase(guardState.phase)
            && isReadMethod(request.method())
            && message === NAVIGATION_ABORTED_ERROR_TEXT
            && requestPage !== undefined
            && await isMainFrameDownloadConfirmed(requestPage, request)
          ) {
            mainFrameNavigationStateOf(requestPage).mainFrameDownloadBlocked = true;
            return;
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
          // SAFE-2 の 4（違反の区分の (3)。DEF-145 のとおり、届いたか分からない読み取り）: 読み取り（GET・HEAD）の main frame の移動の配送の失敗は、読み取りなので、
          // 届いても届かなくても安全の決まりに反しない。違反にせず、読み取りの失敗の記録（`readNavigationFailures`）に残し、Context は閉じない。発見の流れは、
          // この記録で probe の読み取りの移動の取り消しを見分ける（`probeRecordContinuationOf`）。
          if (recordReadNavigationFailureIfRead(request, message)) return;
          // DEF-145: 違反に、失敗した main frame の要求（method と URL。Ledger が Origin と path だけを残す）を付ける（読み取りでない要求）。
          ledger.recordInvariantViolation({
            code: HTTP_MAIN_FRAME_DELIVERY_FAILED_VIOLATION_CODE,
            message,
            request: { method: request.method(), url: request.url() },
          });
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
  // EL-12: 本番の Chromium（一時のプロファイルの設定あり）では、この事象は外部スキームの移動で来ない（Chromium が移動を止め、OS へ渡さない）。
  // 検出は CDP の事象（`onExternalNavigationCdpEvent`）で行い、この事象（テストの既定の headless shell では両方来る）とは 1 回だけ記録する
  // （`recordExternalSchemeNavigationAttempt`）。記録の形は今と同じ。
  const onRequest = (request: Request): void => {
    if (guardState.phase === 'CLOSED') {
      return;
    }
    try {
      if (!request.isNavigationRequest()) {
        return;
      }
      const url = request.url();
      // popup（`window.open`）の navigation は frame ができる前に出るので、frame の種類が分からない（`classifyMainFrame` の失敗を、frame の判定の失敗の
      // 記録 `frameClassificationFailures` に残す。SAFE-2 の 4: 違反にしない）。
      recordExternalSchemeNavigationAttempt('REQUEST', url, () => {
        const isMainFrame = classifyMainFrame(request, () => recordFrameClassificationFailureOf(request));
        return isMainFrame === undefined ? undefined : isMainFrame ? 'MAIN' : 'SUB';
      }, null);
    } catch (error) {
      ledger.recordInvariantViolation({ code: 'EXTERNAL_SCHEME_DETECTION_FAILED', message: errorMessage(error) });
      initiateInvalidation(context, ledger);
    }
  };

  try {
    // DEF-110 fix: Context の close の事象を、ほかの何より先に聞き始める（close の reject の後に、Context がもう存在しないことの証しにする）。
    const onContextClose = (): void => {
      guardState.contextCloseObserved = true;
      // T36b: Context を閉じたら、自動ログインの資格情報の値を捨てる。
      discardCredentialGuard();
      // DEF-292 の残り（REV-CP の Minor-3）: 「通した」の記録待ちの行と、target の外れで移した行の覚えも捨てる。
      awaitedRouteAuditSends.clear();
    };
    context.on('close', onContextClose);
    guardState.listenerCleanups.context.cleanups.push(() => context.off('close', onContextClose));
    // T36b: Guard の後片付け（閉じる前を含む）でも捨てる（Context の close の事象を聞かなくなった後に閉じても、値を残さない）。
    guardState.listenerCleanups.context.cleanups.push(discardCredentialGuard);
    // DEF-040（設計書 2.2）: ページを作る前に、文書の始まりに meta の CSP を入れてすぐ外すスクリプトを、Context のすべての文書に付ける
    // （Worker の中の WebSocket を止める policy。`WORKER_CONNECT_POLICY_INIT_SCRIPT`）。Passive と Interaction のすべての Context に付ける。
    // AS-c: 監査の段の送信の扱いの口がある Context だけ、`ws:`・`wss:` を許す policy（`connectPolicy`）。
    await context.addInitScript({ content: connectPolicy === WORKER_CONNECT_POLICY ? WORKER_CONNECT_POLICY_INIT_SCRIPT : connectPolicyInitScriptOf(connectPolicy) });
    // DEF-049: 同じく、すべての文書で、Service Worker の登録の入口を塞ぐ（`SERVICE_WORKER_REGISTRATION_BLOCK_INIT_SCRIPT`）。
    await context.addInitScript({ content: SERVICE_WORKER_REGISTRATION_BLOCK_INIT_SCRIPT });
    // DEF-124: 凍結しうる Context（Isolated Interaction Context と、送らずに観察する probe の口のある PRIMARY の Passive の Context。`admitsFrozenReads`）だけ、
    // すべての文書で、WebRTC の入口を塞ぐ（`WEBRTC_BLOCK_INIT_SCRIPT`）。STUN・TURN・ICE の通信は、Guard の route も CDP の横取りも出口の中継の凍結も通らず、
    // 押した後の凍結を迂回しうるためである。RB-4b（設計書 3.2 の X6）: ほかの Context は、サイト自身のリアルタイムの通信として止めない。
    if (admitsFrozenReads(options)) {
      await context.addInitScript({ content: WEBRTC_BLOCK_INIT_SCRIPT });
    }
    context.on('page', onPage);
    guardState.listenerCleanups.context.cleanups.push(() => context.off('page', onPage));
    context.on('requestfailed', onRequestFailed);
    guardState.listenerCleanups.context.cleanups.push(() => context.off('requestfailed', onRequestFailed));
    context.on('request', onRequest);
    guardState.listenerCleanups.context.cleanups.push(() => context.off('request', onRequest));

    /** DEF-276-relay: 中継の握手のときの User-Agent（Context で 1 つ。読めなければ送らない）。 */
    let relayUserAgent: Promise<string> | undefined;
    /** REV-DEF276 の M-1: ブラウザの User-Agent（CDP の `Browser.getVersion`。ページから読まない。Context で 1 回だけ読む。読めなければ送らない）。 */
    const browserUserAgentOf = async (): Promise<string> => {
      const session = await context.browser()?.newBrowserCDPSession();
      if (session === undefined) return '';
      try {
        const version = await session.send('Browser.getVersion');
        return version.userAgent;
      } finally {
        await session.detach().catch(() => undefined);
      }
    };
    /** 読めない URL の frame と、http(s) でない frame は数えない。 */
    const httpOriginOf = (frame: Frame): string | null => {
      try {
        const location = new URL(frame.url());
        return isHttpProtocol(location.protocol) ? location.origin : null;
      } catch {
        return null;
      }
    };
    /**
     * DEF-276-relay（REV-DEF276 の I-1）: 中継の握手のヘッダ。開いている page の main frame と、そのほかの frame の Origin、宛先の URL で読んだ Cookie、ブラウザの
     * User-Agent を集め、決め方は `relayHandshakeHeadersOf`（websocket-relay.ts）に任せる。
     */
    const relayHeadersOf = async (url: string): Promise<Record<string, string>> => {
      const pages = context.pages().filter((page) => !page.isClosed());
      const mainFrameOrigins = pages.flatMap((page) => httpOriginOf(page.mainFrame()) ?? []);
      const frameOrigins = pages.flatMap((page) => page.frames().filter((frame) => frame !== page.mainFrame()).flatMap((frame) => httpOriginOf(frame) ?? []));
      // Cookie は、同じ場所の http(s) の URL で読む（ws と http は同じ Cookie を使う）。
      const cookies = await context.cookies(url.replace(/^ws/u, 'http'));
      relayUserAgent ??= browserUserAgentOf().catch(() => '');
      return relayHandshakeHeadersOf({ url, mainFrameOrigins, frameOrigins, cookies, userAgent: await relayUserAgent });
    };
    /**
     * DEF-276-relay: route が通した文書の WebSocket を、Node の側の中継でつなぐ（握手を待ってから route の処理を終える。ページの `open` は、握手が成った後）。
     * 握手に失敗したら、ページには失敗（code 1006）として閉じる。成ったら、送り手の扱いの口があれば通した接続として記録する（ブラウザは接続を開かないので、
     * 観察 `recordObservedWebSocket` には来ない）。凍結と閉じでは `freezeEgress` が切る。凍結の後のページの送りは、サーバへ渡さない。
     */
    const relayDocumentWebSocket = async (webSocketRoute: WebSocketRoute, relay: GuardWebSocketRelay): Promise<void> => {
      const url = webSocketRoute.url();
      const handshake = new AbortController();
      const cutHandshake = (): void => handshake.abort();
      guardState.webSocketRelayCuts.add(cutHandshake);
      let opened: RelayedWebSocket | undefined;
      try {
        // ヘッダを作る間（Cookie と User-Agent の読み）も、握手の上限で区切る。
        const headers = await awaitBeforeDeadline(relayHeadersOf(url), Date.now() + WEBSOCKET_RELAY_HANDSHAKE_TIMEOUT_MS);
        if (headers.status !== 'FULFILLED') throw new Error('WebSocket relay headers are unavailable');
        opened = await openRelayedWebSocket({
          url,
          proxy: relay.proxy,
          headers: headers.value,
          protocols: webSocketRoute.protocols(),
          handshakeTimeoutMs: WEBSOCKET_RELAY_HANDSHAKE_TIMEOUT_MS,
          maxSendQueueBytes: WEBSOCKET_RELAY_MAX_SEND_QUEUE_BYTES,
          additionalTrustedCertificates: relay.additionalTrustedCertificates,
          signal: handshake.signal,
        });
      } catch {
        opened = undefined;
      } finally {
        guardState.webSocketRelayCuts.delete(cutHandshake);
      }
      const live = (): boolean => !isFrozenPhase(guardState.phase) && !isClosingOrInvalidatingPhase(guardState.phase) && guardState.phase !== 'CLOSED';
      if (opened === undefined || handshake.signal.aborted || !live()) {
        opened?.destroy();
        await webSocketRoute.close({ code: WEBSOCKET_ABNORMAL_CLOSE_CODE, reason: '' }).catch(() => undefined);
        return;
      }
      const server = opened;
      const cut = (): void => server.destroy();
      guardState.webSocketRelayCuts.add(cut);
      webSocketRoute.onMessage((message) => {
        if (live()) server.send(message);
      });
      webSocketRoute.onClose((code, reason) => server.close(code, reason ?? ''));
      server.onMessage((data) => webSocketRoute.send(data));
      server.onClose((code, reason, cause) => {
        guardState.webSocketRelayCuts.delete(cut);
        // REV-DEF276 の M-2: 送りの列が上限を超えて切った接続は、止めた WebSocket として記録する（理由 `WEBSOCKET_SEND_QUEUE_FULL`）。
        if (cause === 'SEND_QUEUE_FULL') {
          ledger.recordBlockedWebSocket({ url, reason: 'WEBSOCKET_SEND_QUEUE_FULL', phase: blockedEventPhaseOf(guardState.phase, null) });
        }
        void webSocketRoute.close({ code, reason }).catch(() => undefined);
      });
      if (webSocketAuditSendAdmission !== undefined) {
        const policy = requestPolicyOf(undefined, auditExclusions, auditReadAdmission?.cdpPolicy(), webSocketAuditSendAdmission.webSocketPolicy()) ?? {};
        ledger.recordPassedAuditSendWebSocket({ url, outsideGuard: false, dangerous: isAuditSendDangerousWebSocket(url, policy) });
      }
    };

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
        // AS-c: 監査の段の送信の扱いの口があれば、WebSocket の残りの数つきの口で判定する（監査の段の口と除外の口も渡す。送信の段の口は渡さない。
        // 送信の段と一緒の口は、Guard の取り付けで拒んである）。口がなければ、今の判定（`PASSIVE_WEBSOCKET`）。
        // OP-N: 書き込みの段では、送信の扱いの口を WebSocket に使わない（`webSocketAuditSendAdmission`）。
        // L12a: 書き込みの段で送信の扱いの口があれば、書き込みの段の口（押した後の扱いを含む）で判定する（押した後だけ通す）。
        const writeStageWebSocketPolicy = webSocketAuditSendAdmission === undefined && writeStage !== undefined && auditSendAdmission !== undefined
          ? requestPolicyOf(submissionAdmission?.cdpStagePolicy(), auditExclusions)
          : undefined;
        const baseWebSocketPolicy = webSocketAuditSendAdmission === undefined
          ? writeStageWebSocketPolicy
          : requestPolicyOf(undefined, auditExclusions, auditReadAdmission?.cdpPolicy(), webSocketAuditSendAdmission.webSocketPolicy());
        // RB-4b: リアルタイムの通信を止めない指定があれば、その口を足す（送信の扱いの口がない READ_ONLY と、書き込みの段の押す前でも通す）。
        const webSocketPolicy = realtimePassThrough
          ? withRealtimePassThrough(
            baseWebSocketPolicy ?? requestPolicyOf(submissionAdmission?.cdpStagePolicy(), auditExclusions, auditReadAdmission?.cdpPolicy()),
          )
          : baseWebSocketPolicy;
        // FRET fix round 3: 窓を開くボタンの押す期間と押した後の止めの続きは、その印も渡す（新しい接続を止める）。ほかの期間は今の判定のまま。
        const decision = classifyPassiveRequest({ kind: 'WEBSOCKET', url: webSocketRoute.url() }, authoritySnapshot, withNotificationPress(webSocketPolicy));
        if (
          decision.action === 'ALLOW'
          && decision.auditSendWebSocketAdmission === true
          && (webSocketAuditSendAdmission !== undefined || writeStageWebSocketPolicy !== undefined || realtimePassThrough)
        ) {
          // ページの接続をサーバへつなぐ（以後の送受信は、ページとサーバの間でそのまま渡す。記録しない）。接続は出口の中継を通る。
          // AS-c fix round 1（C-1・C-2）: 記録は、ブラウザが実際に開いた接続の観察（`recordObservedWebSocket`）で残す。ここでは、route が通したことだけを残す。
          // L12a: 書き込みの段の押した後は数えず、承認した送信のほかの送信として、通した一覧に記録する。
          if (writeStage !== undefined) {
            recordWriteStagePassedRequest(writeStage.monitor, {
              method: WEBSOCKET_HANDSHAKE_METHOD,
              url: webSocketRoute.url(),
              resourceType: WEBSOCKET_RESOURCE_TYPE,
              body: (): RequestBodyText => NO_BODY_TEXT,
            });
          }
          // DEF-125: 出口の中継に、この接続の宛先を知らせる（Chromium は ws(s) を中継の CONNECT で通す。知らせのない宛先は中継が拒む）。
          if (egressDestinationHook !== undefined) {
            try {
              egressDestinationHook(webSocketRoute.url());
            } catch (error) {
              ledger.recordInvariantViolation({ code: 'GUARD_EGRESS_ADMISSION_FAILED', message: errorMessage(error) });
            }
          }
          // DEF-276-relay: 文書の CSP が ws を止める Context（操作さがしの PRIMARY）では、ページの中で接続できないので、Node の側で中継する。
          if (options.webSocketRelay !== undefined && connectPolicy === WORKER_CONNECT_POLICY) {
            await relayDocumentWebSocket(webSocketRoute, options.webSocketRelay);
            return;
          }
          try {
            webSocketRoute.connectToServer();
          } catch (error) {
            ledger.recordInvariantViolation({ code: 'WEBSOCKET_CONNECT_FAILED', message: errorMessage(error) });
            requestInvalidation();
            return;
          }
          // AS-c fix round 2（I-C）: `connectToServer()` を呼んだ後に、照らし合わせの時間（`AUDIT_SEND_WEBSOCKET_MATCH_WINDOW_MS`）の締め切りを置く。
          // L12a: 書き込みの段（観察を付けない）では置かない。
          if (webSocketAuditSendAdmission !== undefined) {
            admitRouteWebSocket(webSocketRoute.url());
          }
          return;
        }
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
        // BN-a: 止めた時点。WebSocket の route は page を持たないので、Guard の段階だけで決める（ここは `PASSIVE_ACTIVE` なので `LOAD`）。
        ledger.recordBlockedWebSocket({ url: webSocketRoute.url(), reason: decision.reason, phase: blockedEventPhaseOf(phase, null) });
        // FRETWS（設計書 `2026-11-25-beaksight-discovery-sibling-press-design.md` 2.2）: 窓を開くボタンの押す期間に止めた接続も、押す期間の止めの数に数える。
        if (decision.reason === SCROLL_KEY_PRESS_BLOCK_REASON) {
          guardState.scrollKeyPressBlocks = saturatingIncrement(guardState.scrollKeyPressBlocks);
        }
        // T26g-1: 送信の窓の中の WebSocket も、予期しない要求として数える。OP-N（N1）: 書き込みの段の、値を入れた後の目印のない WebSocket（張り直し）は、止めた
        // まま、予期しない要求の数に数えない。
        submissionAdmission?.monitor.recordOtherBlock(
          submissionAdmission.monitor.isSubmissionWindowOpen(),
          toleratedWebSocketInWriteWindow(submissionAdmission.monitor, webSocketRoute.url()),
        );
        // OP-M: 書き込みの段なら、止めた要求の一覧にも記録する（本文はない）。
        recordWriteStageBlockedWebSocket(submissionAdmission?.monitor, webSocketRoute.url(), decision.reason);
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
        // CC-050: route の役割は 2 つである（T32-research-3。Task 32 の設計書 4.4）。
        // (1) Guard が CDP の session を付けていない page の要求の網: PASSIVE の段のポップアップの最初の要求（DEF-113）と、凍結の段の
        //     ポップアップ（CDP を付けない。DEF-036）の要求は、ここだけが止める。CDP の付いた page・Worker・iframe の要求は、Guard の CDP の
        //     横取りが先に見て止める（ここに来るのは、CDP が許した要求である）。
        // (2) キャッシュの返し: 許した要求の届け方（`resourceDelivery`。サイトへの負荷の制御の設計書 4.7）。
        // 動作と記録は、CDP の層と同じ `decideGuardRequest` で決める。ここは、その結果に従って route の命令を送る。
        const request = route.request();
        // DEF-292 の残り: CDP の層が置いた「通した」の記録待ちの行を外す（判定によらず。target の外れで既に記録した要求は、下で二重に記録しない）。
        const awaitedAtRoute = awaitedRouteAuditSends.takeAtRoute(requestPageForPhase(request) ?? undefined, request.method().toUpperCase(), request.url());        const isNavigationRequest = request.isNavigationRequest();
        // fix round 3（設計書 3.2.2 の 4）: 通知の枠の閉じる押下の期間に開いたポップアップの文書の要求は、Guard が止めた要求として止める（CDP の付いていない page の
        // 違反 `PASSIVE_GUARD_PAGE_NOT_READY` にしない）。止めたポップアップは `onPage` が記録する。
        if (guardState.phase === 'PASSIVE_ACTIVE' && isNavigationRequest && isNotificationPressPopupRequest(request)) {
          expectedRouteFailures.add(request);
          try {
            await route.abort('blockedbyclient');
          } catch (error) {
            ledger.recordInvariantViolation({ code: 'HTTP_ABORT_FAILED', message: errorMessage(error) });
            requestInvalidation();
          }
          return;
        }
        let routePolicy: PassiveRequestPolicyOptions | undefined;
        let isMainFrame = false;
        /** SAFE-2 の 4: frame の判定に失敗した要求か（止めるが、Context は閉じない）。 */
        let frameUnclassified = false;
        // T36R-fix（T36R の C-1）: 自動ログインの資格情報の守りで比べる、この要求に付く Cookie とヘッダ（判定の前に読む。部品がなければ、待たずに読まない）。
        const cookies = credentialGuard === undefined ? NO_COOKIES : await cookieTextsFor(request.url());
        const routeHeaders = credentialGuard === undefined ? undefined : request.headers();
        const verdict = decideGuardRequest({
          layer: 'ROUTE',
          phase: guardState.phase,
          ownerClosingPage: false,
          request: { method: request.method(), url: request.url() },
          navigation: isNavigationRequest,
          unguardedPageNavigation: isNavigationRequest ? unguardedPageNavigationOf(request) : null,
          // DEF-208-1: 凍結の段の読み取り。CDP の付いた page（`pageGuards` の `READY`）の要求だけ（凍結の段のポップアップと、page を引けない要求は今どおり止める）。
          // 凍結の読み取りを通す Guard だけ（`admitsFrozenReads`）。
          ...(!frozenReadsAdmitted ? {} : {
            frozenRead: ({ method, url }: GuardRequestIdentity): boolean => {
              let isMainFrameRequest: boolean;
              try {
                const frame = request.frame();
                const framePage = frame.page();
                if (pageGuards.get(framePage)?.status !== 'READY') return false;
                isMainFrameRequest = frame === framePage.mainFrame();
              } catch {
                return false;
              }
              // COV-2c（C-1）: CDP の層と同じく、通した main frame の文書の要求のリダイレクトの先へ、口の行き先を移す。
              if (isNavigationRequest) followFrozenMainFrameDocumentRedirect(request.redirectedFrom()?.url(), url, isMainFrameRequest);
              const frozenFacts = {
                method,
                url,
                isNavigationRequest,
                isMainFrame: isMainFrameRequest,
                resourceType: requestResourceTypeOfRequest(request),
                sentContent: requestSentContentOf(request),
              };
              const frozenPolicy = routeRequestPolicy(method, url);
              // DEF-233: サイトの token の更新も、CDP の層と同じ部品で見る（本文は Playwright の要求の本文。要るときだけ読む）。
              return (isFrozenReadAdmissible({ kind: 'HTTP', ...frozenFacts }, authoritySnapshot, frozenPolicy)
                && frozenNonReadAllowedHere(method, url, () => requestBodyTextOfBuffer(request.postDataBuffer())))
                || frozenTokenRefreshAdmitted(frozenFacts, frozenPolicy, () => requestBodyTextOfBuffer(request.postDataBuffer()), request.headers())
                // COV-2c（C-1）: 呼ぶ側が指定した行き先への main frame の文書の移動（CDP の層と同じ部品）。
                || frozenMainFrameDocumentAdmitted(frozenFacts, frozenPolicy);
            },
          }),
          evaluate: ({ method, url }): GuardPolicyOutcome => {
            const mainFrame = classifyMainFrame(request, () => {
              frameUnclassified = true;
              recordFrameClassificationFailureOf(request);
            });
            if (mainFrame === undefined) return { kind: 'UNAVAILABLE' };
            isMainFrame = mainFrame;
            routePolicy = routeRequestPolicy(method, url);
            return {
              kind: 'DECISION',
              // T36b: 自動ログインの資格情報の守り（CDP の層を通らない要求の網。本文は Playwright の要求の本文）。
              decision: credentialCheckedDecision(classifyPassiveRequest(
                // T34b: route の要求の種類（Playwright の `resourceType()`）を、閉じた一覧に正規化して渡す。
                {
                  kind: 'HTTP',
                  method,
                  url,
                  isNavigationRequest,
                  isMainFrame,
                  resourceType: requestResourceTypeOfRequest(request),
                  // AS-c fix round 1（I-2）: method の上書きの判定に使う、ヘッダと本文（CDP の層と同じ判定。本文は form のときだけ読む）。
                  sentContent: requestSentContentOf(request),
                },
                authoritySnapshot,
                routePolicy,
              ), { method, url, headers: routeHeaders }, () => requestBodyTextOfBuffer(request.postDataBuffer()), cookies),
            };
          },
        });
        // DEF-125: 通した要求の宛先を、中継に知らせる（命令を送る前。CDP の付いていない page の要求も、ここで知らせる）。
        admitEgressDestinationOf(verdict, 'ROUTE');
        withdrawEgressDestinationOf(verdict);
        recordGuardVerdictBeforeBlock(ledger, verdict);
        if (verdict.kind === 'BLOCK_FROZEN') {
          expectedRouteFailures.add(request);
          await abortInteractionRequest(requestInvalidation, route, ledger);
          return;
        }
        if (verdict.kind === 'BLOCK_LIFECYCLE') {
          try {
            await route.abort('blockedbyclient');
          } catch (error) {
            ledger.recordInvariantViolation({ code: 'HTTP_ABORT_FAILED', message: errorMessage(error) });
            requestInvalidation();
            return;
          }
          // BN-a（設計書 3.1 の 2）: 閉じる途中に止めた要求を、止めた後に記録する（止め方は変えない）。
          ledger.recordBlockedClosingRequest({
            method: request.method(),
            url: request.url(),
            resourceType: requestResourceTypeOfRequest(request),
            speculative: isSpeculativeRequestHeaders(requestSentContentOf(request).headers),
          });
          return;
        }
        if (verdict.kind === 'BLOCK_INVALID' || verdict.kind === 'BLOCK_UNAVAILABLE' || verdict.kind === 'FULFILL_PREFLIGHT') {
          // 段階の誤り、CDP の付いていない page のナビゲーション（DEF-113）、frame の判定の失敗。route に CORS の事前確認は来ない（来ない結果）。
          // SAFE-2 の 4: frame の判定の失敗だけは、要求を止めて記録し（`frameClassificationFailures`）、Context は閉じない（違反にしない）。
          expectedRouteFailures.add(request);
          await abortUnreadyNavigation(verdict.kind === 'BLOCK_UNAVAILABLE' && frameUnclassified ? () => undefined : requestInvalidation, route, ledger);
          return;
        }
        if (verdict.kind === 'BLOCK_POLICY') {
          expectedRouteFailures.add(request);
          // FRET（2026-11-25 fix round 1 の判断）: 窓を開くボタンの押す期間の止めを、route の層で止めた要求（main frame の fetch など）も数える。
          if (verdict.decision.category === 'REQUEST' && verdict.decision.reason === SCROLL_KEY_PRESS_BLOCK_REASON && !(isNavigationRequest && isMainFrame)) {
            guardState.scrollKeyPressBlocks = saturatingIncrement(guardState.scrollKeyPressBlocks);
          }
          await abortHttpRequest(requestInvalidation, route, ledger, verdict.decision, {
            method: verdict.request.method,
            url: verdict.request.url,
            mainFrameNavigation: isNavigationRequest && isMainFrame,
            resourceType: requestResourceTypeOfRequest(request),
            // BN-a: 止めた時点（要求の page がページを離れた後なら `CLOSING`）。
            phase: blockedEventPhaseOf(guardState.phase, requestPageForPhase(request)),
            speculative: isSpeculativeRequestHeaders(requestSentContentOf(request).headers),
            headers: routeHeaders,
            // OP-M: 書き込みの段の止めた要求の一覧の、目印の真偽だけに使う（記録しない）。
            body: () => requestBodyTextOfBuffer(request.postDataBuffer()),
          }, stageRecordingOf(submissionAdmission, routePolicy), auditMonitor, countedServiceOrigins, authoritySnapshot);
          return;
        }
        if (submissionAdmission !== undefined && !isReadMethod(verdict.request.method)) {
          // T25b: CDP の層が数えて置いた印を 1 つ使う（この層では数えない）。
          submissionAdmission.consumeAtRoute(verdict.request.method, verdict.request.url);
        }
        if (auditReadAdmission !== undefined && !isReadMethod(verdict.request.method)) {
          // T35b: 監査の段の登録した読み取りの手続きの呼び出しも、CDP の層が置いた印を 1 つ使う（この層では数えない）。
          auditReadAdmission.consumeAtRoute(verdict.request.method, verdict.request.url);
        }
        if (auditSendAdmission !== undefined && verdict.decision.auditSendAdmission === true && awaitedAtRoute !== 'MOVED') {
          // AS-c fix round 1（M-3）: 通した要求の記録は、ブラウザが送る時点（ここで進める）に残す。
          recordPassedAuditSendRequest(verdict.request.method, verdict.request.url);
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
