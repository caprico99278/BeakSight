// スクリプトで送るログインの段の、token の送信の応答の状態の観測の唯一の部品（T36b。Task 36 の設計書 3.4・4 章）。
// - Guard が CDP の層で token の送信を通したら（`sent`。CDP の `Fetch.requestPaused` の `networkId`）、同じ session の `Network.responseReceived` の
//   状態のコードと `Retry-After` のヘッダの値（`responseReceived`）、または `Network.loadingFailed`（`loadingFailed`。応答がない）を、その送信に
//   対応付けて覚える。本文は読まない（成功の応答の本文は token を含む）。ほかのヘッダも持たない。
// - 送信ごとの状態（`TOKEN_RESPONSE_STATES`）: `RESPONDED`（応答を受けた）、`FAILED`（応答なしで終わった）、`PENDING`（まだ。時間切れの判断は読む側。
//   `networkId` のない送信と、Guard が観察しない session（別のプロセスの iframe の応答）の送信も、ここに残る）。最初の結果だけを残す。
// - `Retry-After` は、短い（`MAX_RETRY_AFTER_VALUE_LENGTH` まで）印字できる ASCII の値だけを残す（ほかは `null`）。読み方（秒か日付か）は、ワーカーの側の
//   今の部品（`src/control/auth/automated-login-timing.ts`）。
// - 送信の数の上限は、token の送信の回数の上限（認証の設定の `maxLoginAttempts`）で決まる。念のため、覚える数を `MAX_OBSERVED_TOKEN_REQUESTS` までにする。
import { isRecord } from '../core/guards.js';
import { RETRY_AFTER_HEADER, headerValueOf } from './http-headers.js';

/** 送信ごとの応答の状態（閉じた一覧）。 */
export const TOKEN_RESPONSE_STATES = Object.freeze(['PENDING', 'RESPONDED', 'FAILED'] as const);
export type TokenResponseState = (typeof TOKEN_RESPONSE_STATES)[number];

/** `Retry-After` の値の最大長（HTTP の日付は 29 文字）。 */
export const MAX_RETRY_AFTER_VALUE_LENGTH = 64;

/** 覚える token の送信の数の上限（それより後の送信は覚えない）。 */
export const MAX_OBSERVED_TOKEN_REQUESTS = 16;

/** token の送信 1 つの応答の観測（値は状態のコードと `Retry-After` だけ）。 */
export interface TokenResponseObservation {
  readonly state: TokenResponseState;
  /** 応答の状態のコード（`RESPONDED` だけ。ほかは `null`）。 */
  readonly status: number | null;
  /** `Retry-After` のヘッダの値（`RESPONDED` で、ヘッダがあり、短い印字できる値のときだけ。ほかは `null`）。 */
  readonly retryAfter: string | null;
}

/** 印字できる ASCII（空白から `~` まで）だけの値。 */
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/u;

interface MutableObservation {
  state: TokenResponseState;
  status: number | null;
  retryAfter: string | null;
}

/**
 * `Retry-After` の値（大文字と小文字を区別しない名前。短い印字できる値だけ）。T36R-fix（T36R の M-5）: 名前とヘッダの読み方は、共通の部品
 * （`http-headers.ts`。Guard の要求のヘッダの読み方と同じ）。
 */
function retryAfterOf(headers: unknown): string | null {
  const value = headerValueOf(headers, RETRY_AFTER_HEADER);
  return value !== undefined && value.length <= MAX_RETRY_AFTER_VALUE_LENGTH && PRINTABLE_ASCII.test(value) ? value : null;
}

/** token の送信の応答の状態を覚える部品（Guard の中で、ログインの段の記録ごとに 1 つ）。 */
export class TokenResponseTracker {
  readonly #observations: MutableObservation[] = [];
  readonly #byNetworkId = new Map<string, MutableObservation>();

  /** Guard が token の送信を通した（`networkId` がなければ、対応付けられないまま `PENDING` で残る）。 */
  sent(networkId: string | undefined): void {
    if (this.#observations.length >= MAX_OBSERVED_TOKEN_REQUESTS) {
      return;
    }
    const observation: MutableObservation = { state: 'PENDING', status: null, retryAfter: null };
    this.#observations.push(observation);
    if (typeof networkId === 'string' && networkId.length > 0) {
      this.#byNetworkId.set(networkId, observation);
    }
  }

  /** `Network.responseReceived` の事象（ほかの要求と、形の違う事象は何もしない）。 */
  responseReceived(event: unknown): void {
    if (!isRecord(event) || typeof event['requestId'] !== 'string' || !isRecord(event['response'])) {
      return;
    }
    const observation = this.#byNetworkId.get(event['requestId']);
    const { status, headers } = event['response'];
    if (observation === undefined || observation.state !== 'PENDING' || typeof status !== 'number' || !Number.isSafeInteger(status)) {
      return;
    }
    observation.state = 'RESPONDED';
    observation.status = status;
    observation.retryAfter = retryAfterOf(headers);
  }

  /** `Network.loadingFailed` の事象（応答なしで終わった。ほかの要求と、形の違う事象は何もしない）。 */
  loadingFailed(event: unknown): void {
    if (!isRecord(event) || typeof event['requestId'] !== 'string') {
      return;
    }
    const observation = this.#byNetworkId.get(event['requestId']);
    if (observation === undefined || observation.state !== 'PENDING') {
      return;
    }
    observation.state = 'FAILED';
  }

  /** 送信の順の写し（凍結）。 */
  snapshot(): readonly TokenResponseObservation[] {
    return Object.freeze(this.#observations.map(({ state, status, retryAfter }) => Object.freeze({ state, status, retryAfter })));
  }
}
