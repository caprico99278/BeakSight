/**
 * Guard の初期化のスクリプトがページに返す、守りの例外の名前と文言（ただ 1 つの置き場所。UPG-SW、T44R2 の I-4・M-2）。Guard
 * （`src/safety/passive-request-guard.ts` の初期化のスクリプト）と、PAGE_ERROR の Rule（`src/audit/technical-rules.ts`）の両方が参照する。
 * BN-b: BeakSight の起動の引数（`--disable-shared-workers`）のために Chromium 自身が出す、SharedWorker がないときの例外の名前と文言も、ここに置く
 *   （Guard は投げない。PAGE_ERROR の Rule の見分けだけが参照する）。
 * - 文言は、そのブラウザで本当に使えないときに返るような、道具の名前を含まない一般の文にする（ページのスクリプトが文言を読めるので、BeakSight の
 *   守りだとサイトに分からないようにする。ユーザーの方針）。
 * - 守りの例外は、サイトの欠陥ではないので、PAGE_ERROR の Finding にしない（`isGuardBlockedPageError`）。page.json の Evidence（記録した事実）には
 *   そのまま残す。見分けは、例外の名前と文言の組で行う。Chromium で、ページがこの組と同じ例外を自分で起こすことは、まずない。
 * - 限界（T44R3 の M-4）: ページが同じ名前と文言の例外を自分で投げると、見分けられない（Finding にならない）。守りの拒否を包み直して投げる例外
 *   （ライブラリの形。名前や文言が変わる）は、ページの欠陥として Finding に残る（正しい振る舞い）。
 */
import { MAX_ERROR_MESSAGE_LENGTH } from './limits.js';

/**
 * Service Worker の登録の拒否の、例外の名前（`DOMException`）。M-2: Chromium（CLI の起動の chrome.exe 156）が、クッキーを止めたプロファイルで自分で
 * 登録を断ったときの形（実機で確かめた）に寄せた。
 */
export const SERVICE_WORKER_REGISTRATION_BLOCKED_ERROR_NAME = 'NotSupportedError';

/**
 * Service Worker の登録の拒否の文言の部品（M-2。Chromium の形 `Failed to register a ServiceWorker for scope ('<scope>') with script ('<script>'):
 * The user denied permission to use Service Worker.`）。scope と script は、登録の呼び出しの URL を解決した絶対の URL（解決できなければ空）。
 * ページの中で組み立てるので、部品を文字列で渡す（`serviceWorkerRegistrationBlockedMessageOf` と同じ並び）。
 */
export const SERVICE_WORKER_REGISTRATION_BLOCKED_MESSAGE_PARTS = Object.freeze({
  beforeScope: "Failed to register a ServiceWorker for scope ('",
  beforeScript: "') with script ('",
  end: "'): The user denied permission to use Service Worker.",
} as const);

/** scope と script の絶対の URL の、Service Worker の登録の拒否の文言（テストと説明のため。ページの中では同じ並びで組み立てる）。 */
export const serviceWorkerRegistrationBlockedMessageOf = (scope: string, script: string): string =>
  `${SERVICE_WORKER_REGISTRATION_BLOCKED_MESSAGE_PARTS.beforeScope}${scope}`
  + `${SERVICE_WORKER_REGISTRATION_BLOCKED_MESSAGE_PARTS.beforeScript}${script}${SERVICE_WORKER_REGISTRATION_BLOCKED_MESSAGE_PARTS.end}`;

/** WebRTC の構築子の例外の、名前（`DOMException`。構築子が投げる、ブラウザのふつうの形）。 */
export const WEBRTC_BLOCKED_ERROR_NAME = 'NotSupportedError';

/** WebRTC の構築子の例外の文言（DEF-124。道具の名前を含まない一般の文）。 */
export const WEBRTC_BLOCKED_MESSAGE = "Failed to construct 'RTCPeerConnection': The operation is not supported.";

/**
 * SharedWorker がないときの例外の名前（BN-b）。BeakSight は Chromium を `--disable-shared-workers`（`CHROMIUM_SHARED_WORKERS_DISABLED_ARGS`。
 * DEF-044）で起動するので、ページから `SharedWorker` が見えない。ページが `new SharedWorker(...)` を呼ぶと、Chromium（V8）自身がこの例外を出す
 * （Guard が投げるのではない）。テストの既定の headless shell と、CLI の起動の chrome.exe（どちらも 156）で確かめた。
 */
export const SHARED_WORKER_DISABLED_ERROR_NAME = 'ReferenceError';

/**
 * SharedWorker がないときの例外の文言（BN-b。両方の Chromium で、`new SharedWorker(...)`・strict mode・module・タイマーと Promise の中の呼び出しの
 * どれでも同じ）。`new window.SharedWorker(...)` の形は `TypeError`（`window.SharedWorker is not a constructor`）で、ここには入らない（Finding に残る）。
 */
export const SHARED_WORKER_DISABLED_MESSAGE = 'SharedWorker is not defined';

/**
 * `isGuardBlockedPageError` が見る、捕捉されない例外の事実（PageErrorEvidence の一部）。T44R4 の M-1: Evidence の `truncated` は、名前・文言・
 * stack のどれかが切り詰められたときに真になるので、見分けには使わない（文言の切り詰めは、文言の長さで判断する）。
 */
export interface PageErrorIdentity {
  readonly name: string;
  readonly message: string;
}

/**
 * Service Worker の登録の拒否の文言の形か（始まり・scope と script の区切り・終わり）。T44R3 の M-4: 切り詰められたときも、上限の内に区切りが
 * あることを求める（始まりだけを真似たページ自身の例外を、守りの例外とみなさない）。scope が長く、区切りが上限の外にくる文言は、見分けられない
 * ので、守りの例外とみなさず、Finding に残す（安全の側に倒す）。T44R4 の M-1: 文言が切り詰められたかは、文言の長さが、Evidence の文言の上限
 * （`MAX_ERROR_MESSAGE_LENGTH`。`console-collector.ts` が同じ定数で切り詰める）に達しているかで判断する（stack だけの切り詰めでは、終わりを比べる）。
 * 上限ちょうどの長さで切り詰められていない文言も、切り詰めた側に数える（ページが同じ形を真似た場合の、見分けの限界の内）。
 */
const isServiceWorkerRegistrationBlockedMessage = (message: string): boolean => {
  const { beforeScope, beforeScript, end } = SERVICE_WORKER_REGISTRATION_BLOCKED_MESSAGE_PARTS;
  if (!message.startsWith(beforeScope) || !message.includes(beforeScript, beforeScope.length)) {
    return false;
  }
  return message.length >= MAX_ERROR_MESSAGE_LENGTH || message.endsWith(end);
};

/**
 * 捕捉されない例外が、BeakSight の守りの例外（Service Worker の登録の拒否、WebRTC の構築子の例外、起動の引数で SharedWorker がないときの例外）か
 * （ただ 1 つの判定。T44R2 の I-4、BN-b）。名前と文言の組で見分ける。名前が同じでも文言が違うもの（ページ自身の `SecurityError`・
 * `NotSupportedError`、別の名前の未定義の `ReferenceError` など）は、守りの例外ではない。
 */
export const isGuardBlockedPageError = (error: PageErrorIdentity): boolean =>
  (error.name === SERVICE_WORKER_REGISTRATION_BLOCKED_ERROR_NAME && isServiceWorkerRegistrationBlockedMessage(error.message))
  || (error.name === WEBRTC_BLOCKED_ERROR_NAME && error.message === WEBRTC_BLOCKED_MESSAGE)
  || (error.name === SHARED_WORKER_DISABLED_ERROR_NAME && error.message === SHARED_WORKER_DISABLED_MESSAGE);

/**
 * BN-c（設計者の判断 2）: `new window.SharedWorker(...)` の形で、起動の引数で無効にした SharedWorker をページが呼んだときに、Chromium（V8）自身が出す例外の名前と
 * 文言（BN-b の報告。両方の Chromium 156）。`isGuardBlockedPageError` と違い、ページ自身の欠陥と見分けきれないので、PAGE_ERROR の Finding には残し、表示用モデルの
 * 区分で `POSSIBLE`（理由 `DISABLED_FEATURE`）にする。
 */
export const SHARED_WORKER_PROPERTY_DISABLED_ERROR_NAME = 'TypeError';
export const SHARED_WORKER_PROPERTY_DISABLED_MESSAGE = 'window.SharedWorker is not a constructor';

/**
 * 捕捉されない例外が、BeakSight が起動の引数で無効にした機能をページが呼んだ形で、Finding に残すもの（ただ 1 つの判定。BN-c）。名前と文言の組で見分ける。
 * 守りの例外（`isGuardBlockedPageError`。Finding にしない）とは重ならない。
 */
export const isBeakSightDisabledFeaturePageError = (error: PageErrorIdentity): boolean =>
  error.name === SHARED_WORKER_PROPERTY_DISABLED_ERROR_NAME && error.message === SHARED_WORKER_PROPERTY_DISABLED_MESSAGE;

/**
 * BN-c（設計書 3.3）: 捕まえない fetch の失敗の、Chromium の例外の名前と文言（設計書 2 章の「ブラウザ側に残る決まった形」）。BeakSight が止めた fetch もこの形になるが、
 * どの呼び出しかの記録はないので、表示用モデルの区分では、同じ読み込みでデータの要求を止めていれば `POSSIBLE` にとどめる。
 */
export const FETCH_FAILURE_ERROR_NAME = 'TypeError';
export const FETCH_FAILURE_MESSAGE = 'Failed to fetch';

/** 捕捉されない例外が、捕まえない fetch の失敗の形か（BN-c）。 */
export const isFetchFailurePageError = (error: PageErrorIdentity): boolean =>
  error.name === FETCH_FAILURE_ERROR_NAME && error.message === FETCH_FAILURE_MESSAGE;
