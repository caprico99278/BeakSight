// ログインの段で止めた読み取りでない要求の一覧の唯一の owner（T34e。Task 34 の設計書 3.5 と 8 章の T34e の行）。
// - 利用者が「ログインに伴う送信」に何を登録すればよいかを決める材料。Guard がログインの段の記録（`LoginStageMonitor`）の中に持ち、ワーカーが IPC の
//   `AUTH_STATE` に載せ、ジョブの管理が管理データのジョブの行に残し、ローカルの画面だけに出す（Run の成果物には入れない）。
// - 1 行は、Origin と path（fragment・本文・値は持たない。query は T43d の名前の記録だけ）、要求の種類（`RequestResourceType`）、止めた理由
//   （`LOGIN_STAGE_BLOCKED_REQUEST_REASONS`）、回数。同じ Origin・path・種類・理由は重ねず、回数を足す（飽和）。
// - 一覧は上限（`MAX_LOGIN_STAGE_BLOCKED_REQUESTS`）まで。上限を超えた新しい行と、HTTP(S) の Origin の正規の直列化を作れない URL は、数だけ
//   （`unlisted`）。一覧に入っている行は、上限の後も回数を足す。
// - path は、値に見える区切りを伏せ（`src/core/url-path-redaction.ts` の `redactValueLikePathSegments`。T34e fix round 1。送信先の path は伏せない）、
//   上限の長さ（`MAX_LOGIN_STAGE_BLOCKED_PATH_LENGTH`）で切り、切った後にもう一度伏せる（切った区切りが値に見える形になりうるため）。
// - IPC の側の同じ意味の定義（`src/control/worker-protocol.ts` の `WORKER_LOGIN_STAGE_…`）との一致は、`tests/unit/script-login-boundary-consistency.test.ts`
//   で確かめる（`src/control/` と `src/safety/` は互いを読み込めない）。
// - T43d（Task 43 の設計書 4.4）: 行に、query の名前の一覧（値なし。上限つき）と、閉じた一覧の名前（今は `grant_type`）の決まった形の値を足す（任意の
//   項目 `query`。query のない行は持たない）。形と判定の owner は `src/discovery/login-observation.ts`（IPC の検証も同じ部品を使う）。値の違う行は重ねず、
//   名前は同じ行の間で足し合わせる。資格情報を含む要求は、今どおり行を作らない（T36R-fix。Guard が行にする前に止める）。
import { MAX_URL_LENGTH } from '../core/limits.js';
import { saturatingAdd, saturatingIncrement } from '../core/saturating-count.js';
import { redactValueLikePathSegments } from '../core/url-path-redaction.js';
import { canonicalHttpOriginOf } from '../crawl/normalize-url.js';
import { loginObservedQueryOf, mergeLoginObservedQuery, type LoginObservedQuery } from '../discovery/login-observation.js';
import { LOGIN_CREDENTIAL_BLOCK_REASON } from './login-credential-guard.js';
import { SCRIPT_LOGIN_BLOCK_REASONS, type ScriptLoginBlockReason, type RequestResourceType } from './request-policy.js';

/**
 * 止めた理由（閉じた一覧）: スクリプトで送るログインの詳しい理由（`SCRIPT_LOGIN_BLOCK_REASONS`）と、フォームの送信のログインの段の理由
 * `NON_READ_METHOD`（許した送信先への POST のほかの、読み取りでない要求。要求の判定の理由のまま）。
 * T36R-fix（T36R の M-2）: 資格情報を含む要求の理由（`LOGIN_CREDENTIAL_BLOCK_REASON`）は数だけで、行の理由には入れない（path に値が入りうるため）。
 */
export type LoginStageBlockedRequestReason = Exclude<ScriptLoginBlockReason, typeof LOGIN_CREDENTIAL_BLOCK_REASON> | 'NON_READ_METHOD';

/** 行の理由か（資格情報を含む要求の理由のほか）。 */
export const isLoginStageBlockedRequestReason = <Reason extends ScriptLoginBlockReason | 'NON_READ_METHOD'>(
  reason: Reason,
): reason is Exclude<Reason, typeof LOGIN_CREDENTIAL_BLOCK_REASON> => reason !== LOGIN_CREDENTIAL_BLOCK_REASON;

export const LOGIN_STAGE_BLOCKED_REQUEST_REASONS: readonly LoginStageBlockedRequestReason[] = Object.freeze([
  ...SCRIPT_LOGIN_BLOCK_REASONS.filter(isLoginStageBlockedRequestReason),
  'NON_READ_METHOD' as const,
]);

/** 一覧の行の上限（Task 34 の設計書 8 章の T34e の行）。 */
export const MAX_LOGIN_STAGE_BLOCKED_REQUESTS = 8;

/** path の最大長（UTF-16 のコード単位。長い path は、この長さで切る）。 */
export const MAX_LOGIN_STAGE_BLOCKED_PATH_LENGTH = 1_024;

/** Origin の最大長（記録する URL の上限と同じ。超える Origin は一覧に入れない）。 */
const MAX_LOGIN_STAGE_BLOCKED_ORIGIN_LENGTH = MAX_URL_LENGTH;

/** 一覧の 1 行（値・本文を持たない。query は名前と閉じた一覧の名前の値だけ。T43d）。 */
export interface LoginStageBlockedRequest {
  readonly origin: string;
  /** `/` で始まる path（query・fragment なし。値に見える区切りは `REDACTED_PATH_SEGMENT` に伏せてある）。 */
  readonly path: string;
  readonly resourceType: RequestResourceType;
  readonly reason: LoginStageBlockedRequestReason;
  /** 止めた回数（1 以上。飽和）。 */
  readonly count: number;
  /** T43d: query の名前（値なし）と、閉じた一覧の名前の値（query のない行は持たない）。 */
  readonly query?: LoginObservedQuery;
  /**
   * ML-a-fix（設計書 `2026-10-19-beaksight-manual-login-pass-through-design.md` 6 章の ML-R の行の I-1）: この行を最初に見たのが、そのログインの段の最初の token の
   * 送信より前だった（`true` だけ。値を持たない）。手動のログインの段で通した一覧だけが付ける（自動の登録が、ログインに伴う送信を見分ける）。
   */
  readonly beforeToken?: true;
}

/** 一覧の写し（凍結）。 */
export interface LoginStageBlockedRequests {
  readonly requests: readonly LoginStageBlockedRequest[];
  /** 一覧に入れなかった、止めた要求の数（上限を超えた新しい行と、Origin を作れない URL。飽和）。 */
  readonly unlisted: number;
}

interface MutableEntry {
  readonly origin: string;
  readonly path: string;
  readonly resourceType: RequestResourceType;
  readonly reason: LoginStageBlockedRequestReason;
  count: number;
  query: LoginObservedQuery | null;
  readonly beforeToken: boolean;
}

/** token の形の query の記録か（閉じた一覧の名前（`grant_type`）の値を記録した。ML-a-fix）。 */
const isTokenShapedQuery = (query: LoginObservedQuery | null): boolean => query !== null && query.values.length > 0;

/**
 * ML-a-fix: URL が token の形の要求か（query に、閉じた一覧の名前（`grant_type`）の、記録してよい値がある。判定は一覧の行と同じ部品 `loginObservedQueryOf`）。
 * Guard が、ログインの段の最初の token の送信を見分けるのに使う。読めない URL は偽。
 */
export const isTokenShapedLoginUrl = (url: string): boolean => {
  try {
    return isTokenShapedQuery(loginObservedQueryOf(new URL(url).searchParams));
  } catch {
    return false;
  }
};

/**
 * 記録する path（`URL.pathname`）の表記: 値に見える区切りを伏せてから上限の長さ（`MAX_LOGIN_STAGE_BLOCKED_PATH_LENGTH`）で切り、切った後にもう一度伏せる
 * （値の一部だけが残る形にしない。切った区切りが値に見える形になっても伏せる）。DEF-138: セッションの切れの証拠の path も、この決まりで作る。
 */
export const recordedRequestPathOf = (pathname: string): string =>
  redactValueLikePathSegments(redactValueLikePathSegments(pathname).slice(0, MAX_LOGIN_STAGE_BLOCKED_PATH_LENGTH));

/** 一覧の Origin と path と query の記録（作れなければ `undefined`）。 */
const locationOf = (url: string): { readonly origin: string; readonly path: string; readonly query: LoginObservedQuery | null } | undefined => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const origin = canonicalHttpOriginOf(parsed.origin);
  if (origin === undefined || origin.length > MAX_LOGIN_STAGE_BLOCKED_ORIGIN_LENGTH) {
    return undefined;
  }
  return { origin, path: recordedRequestPathOf(parsed.pathname), query: loginObservedQueryOf(parsed.searchParams) };
};

/**
 * ログインの段で止めた読み取りでない要求の一覧（1 つのログインの段に 1 つ。Guard だけが `record` で書く）。値・本文・query を受け取っても持たない
 * （`record` は URL から Origin と path だけを取り出す）。
 */
export class LoginStageBlockedRequestList {
  readonly #entries = new Map<string, MutableEntry>();
  #unlisted = 0;

  /**
   * 要求を 1 つ記録する。ML-a-fix: `beforeToken` は、その要求がログインの段の最初の token の送信より前か（行を最初に作った回の値を残す）。token の形の行（閉じた
   * 一覧の `grant_type` の値を記録した行。ML-R の M-1）は、一覧が上限で埋まっていても必ず残す（token の形でない最後の行を一覧から外し、その回数を数だけにする）。
   */
  record(url: string, resourceType: RequestResourceType, reason: LoginStageBlockedRequestReason, beforeToken = false): void {
    const location = locationOf(url);
    if (location === undefined) {
      this.#unlisted = saturatingIncrement(this.#unlisted);
      return;
    }
    // T43d: 閉じた一覧の名前の値が違う要求は、別の行にする（名前は同じ行の間で足し合わせる）。
    const key = JSON.stringify([location.origin, location.path, resourceType, reason, location.query?.values ?? []]);
    const entry = this.#entries.get(key);
    if (entry !== undefined) {
      entry.count = saturatingIncrement(entry.count);
      entry.query = mergeLoginObservedQuery(entry.query, location.query);
      return;
    }
    if (this.#entries.size >= MAX_LOGIN_STAGE_BLOCKED_REQUESTS && !this.#makeRoomFor(location.query)) {
      this.#unlisted = saturatingIncrement(this.#unlisted);
      return;
    }
    this.#entries.set(key, { ...location, resourceType, reason, count: 1, beforeToken: beforeToken === true });
  }

  /** ML-a-fix（ML-R の M-1）: token の形の行のために、token の形でない最後の行を一覧から外す（外せたら真。回数は数だけに移す）。 */
  #makeRoomFor(query: LoginObservedQuery | null): boolean {
    if (!isTokenShapedQuery(query)) {
      return false;
    }
    const victim = [...this.#entries].reverse().find(([, candidate]) => !isTokenShapedQuery(candidate.query));
    if (victim === undefined) {
      return false;
    }
    this.#entries.delete(victim[0]);
    this.#unlisted = saturatingAdd(this.#unlisted, victim[1].count);
    return true;
  }

  /** 一覧の写し（記録した順。凍結）。 */
  snapshot(): LoginStageBlockedRequests {
    return Object.freeze({
      requests: Object.freeze([...this.#entries.values()].map(({ origin, path, resourceType, reason, count, query, beforeToken }) =>
        Object.freeze({ origin, path, resourceType, reason, count, ...(query === null ? {} : { query }), ...(beforeToken ? { beforeToken: true as const } : {}) }))),
      unlisted: this.#unlisted,
    });
  }
}
