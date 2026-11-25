// 送らずに観察する probe の口（T37b。Task 37 の設計書 3.2 の「Guard の観察の形」、4 章）。Safety Ledger とは別の受け手。
// - factory（`BrowserContextFactory`）が、発見のジョブなどの PRIMARY の Passive の Context ごとに 1 つ作り、Guard の取り付けの指定
//   （`PassiveRequestGuardOptions.submissionObservation`）で渡す。呼び出し側は `factory.submissionObservationOf(context)` で受け取る。
// - 既定は無効。`begin` から `end` の間だけ有効で、Guard は凍結の段（`FROZEN_ACTIVE`）で次の 2 つを行う。口がない Context と、口が無効の間は、Guard の
//   振る舞いを 1 つも変えない。
//   1. 承認した API の Origin への CORS の事前確認を、監査の段と同じく Guard が満たす（`observationAdmitsFrozenPreflight` が真のとき。サーバへ送らない。
//      I18）。ほかの Origin の事前確認は、今どおり止める。
//   2. 止めた要求（`BLOCK_FROZEN`。今どおり止め、凍結の後の止めた記録にも入る）のうち、読み取りでないものの型を作って受ける
//      （`recordObservedFrozenRequest`。型は `src/core/api-request-shape.ts`）。読み取りは数だけ（本文を読まない）。L7: 1 回の観察の型の数で
//      打ち切らない（型を作れなかった要求だけを `unrecordedShapeCount` に数える）。
//   DEF-208-1（設計書 `2026-11-05-beaksight-discovery-coverage-design.md` 3.1）: 口のある Guard は、凍結の間ずっと、凍結の読み取りの判定
//   （`isFrozenReadAdmissible`）と監査の段の判定が通す読み取りを止めない（ここに来る読み取りは、止めたものだけ）。通した読み取りが観察の間の目印を
//   URL に運ぶかは `frozenReadCarriesObservedMarker` で照らす（数だけを残す）。読み取りでない送信は、凍結の間ずっと止める。
// - 値は持たない（I22）: 本文はメモリの中で型を作るためだけに読み、型と数だけを残す。型を作る部品の例外は、文を残さずに数える。
// - Guard のほかから書けないよう、状態はこのファイルの中だけ（`observationStates`）に置く。`observationAdmitsFrozenPreflight`・
//   `recordObservedFrozenRequest`・`recordObservedFrozenPreflight`・`attachSubmissionObservation` は Guard だけが呼ぶ。
import { apiEndpointShapeKeyOf, apiRequestShapeOf, type ApiRequestBody, type ApiRequestOriginShape, type ApiRequestShape } from '../core/api-request-shape.js';
import { requestEndpointPartsOf } from '../core/request-endpoint-key.js';
import { fieldNameHasStateWord } from '../discovery/classify.js';
import { hasAllowedOrigin, isReadMethod } from './request-policy.js';
import { requestCarriesMarker } from './write-stage-unexpected-requests.js';

/**
 * 口の作成の指定（承認した API の Origin と、許可 Origin。factory が渡す）。DEF-220（設計書 `2026-11-08-beaksight-same-origin-api-and-spa-routes-design.md`
 * 3.1 の 2）: 承認したテストの Origin（`approvedTestOrigins`。テスト用のサイト自身の API の区分 `APPROVED_TEST` に当てる Origin）も明示して渡す（許可 Origin の全体は
 * 当てない）。ログインのある形とない形の両方で、factory が認証の指定の承認したテストの Origin を渡す。
 */
export interface SubmissionObservationOptions {
  readonly approvedApiOrigins: readonly string[];
  readonly approvedTestOrigins: readonly string[];
  readonly allowedOrigins: readonly string[];
  /**
   * DEF-276: 凍結を読み取りの安定のためだけに使う口か（凍結の後に押さない。READ の確かめ・入口の確かめ・書き込みのジョブの PRIMARY）。真なら `begin` が投げる
   * （押す観察を始めない）。Guard は、この口の Context の凍結の前のリアルタイムの通信を止めない（`observationPressesAfterFreeze`）。省略は押す口（今どおり）。
   */
  readonly freezeOnlyForReading?: true | undefined;
}

/** 1 回の観察の対象（probe した画面の path と、欄に入れた目印）。 */
export interface SubmissionObservationTarget {
  readonly pagePath: string;
  readonly markers: readonly string[];
}

/**
 * 1 回の観察の結果（値を持たない）。
 * - `shapes`: 止めた読み取りでない要求の型（届いた順。上限まで）。
 * - `nonReadRequestCount`: 止めた読み取りでない要求の数（型を作れなかったものを含む）。
 * - `readRequestCount`: 止めた読み取りの数。
 * - `unrecordedShapeCount`: 読み取りでない要求のうち、上限か部品の失敗で型を受けなかった数。
 * - `preflightsFulfilled`: Guard が満たした、承認した API の Origin への事前確認の数。
 */
export interface SubmissionObservationResult {
  readonly shapes: readonly ApiRequestShape[];
  readonly nonReadRequestCount: number;
  readonly readRequestCount: number;
  readonly unrecordedShapeCount: number;
  readonly preflightsFulfilled: number;
}

/** Guard が渡す、止めた要求の事実（本文は、読み取りでない要求のときだけ読む）。 */
export interface ObservedFrozenRequestFacts {
  readonly method: string;
  readonly url: string;
  readonly resourceType: string;
  readonly headers: Readonly<Record<string, string>> | undefined;
  readonly body: () => ApiRequestBody;
}

interface ActiveObservation {
  readonly target: SubmissionObservationTarget;
  readonly shapes: ApiRequestShape[];
  nonReadRequestCount: number;
  readRequestCount: number;
  unrecordedShapeCount: number;
  preflightsFulfilled: number;
}

interface ObservationState {
  readonly approvedApiOrigins: readonly string[];
  readonly approvedTestOrigins: readonly string[];
  readonly allowedOrigins: readonly string[];
  /** DEF-276: 凍結の後に押す口か（`freezeOnlyForReading` でない）。 */
  readonly pressesAfterFreeze: boolean;
  attached: boolean;
  active: ActiveObservation | null;
  /**
   * DEF-233: この口で始めた観察のすべての目印（`begin` で足す。終えた後も残す。凍結はページを閉じるまで続き、欄に入れた値が残りうるので、凍結の段で通す
   * token の更新の照らしに使う。口は 1 つの Context の 1 画面だけなので、数は押す回数の分まで）。
   */
  readonly seenMarkers: string[];
}

const observationStates = new WeakMap<SubmissionObservation, ObservationState>();

const isStringList = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every((entry) => typeof entry === 'string');

/** 送らずに観察する probe の口（既定は無効）。 */
export class SubmissionObservation {
  constructor(options: SubmissionObservationOptions) {
    if (typeof options !== 'object' || options === null || !isStringList(options.approvedApiOrigins) || !isStringList(options.approvedTestOrigins)
      || !isStringList(options.allowedOrigins) || (options.freezeOnlyForReading !== undefined && options.freezeOnlyForReading !== true)) {
      throw new TypeError('Submission observation requires the approved API Origins, the approved test Origins and the allowed Origins as strings');
    }
    observationStates.set(this, {
      approvedApiOrigins: Object.freeze([...options.approvedApiOrigins]),
      approvedTestOrigins: Object.freeze([...options.approvedTestOrigins]),
      allowedOrigins: Object.freeze([...options.allowedOrigins]),
      pressesAfterFreeze: options.freezeOnlyForReading !== true,
      attached: false,
      active: null,
      seenMarkers: [],
    });
  }

  /** 観察の間か。 */
  get active(): boolean {
    return stateOf(this).active !== null;
  }

  /**
   * 観察を始める（受けた型と数を空にする）。観察の間に呼ぶと `Error`。path が `/` で始まる文字列でないか、目印が文字列の配列でなければ `TypeError`
   * （値を文に入れない。目印の数の上限は、型を作るときに型の作り手が確かめ、超えた要求は型を受けずに数える）。DEF-276: 凍結の後に押さない口
   * （`freezeOnlyForReading`）では `Error`（押す観察を始めない。リアルタイムの通信を止めていない Context で押させない）。
   */
  begin(target: SubmissionObservationTarget): void {
    const state = stateOf(this);
    if (!state.pressesAfterFreeze) {
      throw new Error('Submission observation of a freeze only for reading does not press');
    }
    if (state.active !== null) {
      throw new Error('Submission observation has already begun');
    }
    if (typeof target !== 'object' || target === null || typeof target.pagePath !== 'string' || !target.pagePath.startsWith('/')
      || !isStringList(target.markers)) {
      throw new TypeError('Submission observation requires a page path that starts with "/" and markers as strings');
    }
    state.seenMarkers.push(...target.markers);
    state.active = {
      target: Object.freeze({ pagePath: target.pagePath, markers: Object.freeze([...target.markers]) }),
      shapes: [],
      nonReadRequestCount: 0,
      readRequestCount: 0,
      unrecordedShapeCount: 0,
      preflightsFulfilled: 0,
    };
  }

  /** 観察を終え、結果を返す（口は無効に戻る）。観察の間でなければ `Error`。 */
  end(): SubmissionObservationResult {
    const state = stateOf(this);
    const { active } = state;
    if (active === null) {
      throw new Error('Submission observation has not begun');
    }
    state.active = null;
    return Object.freeze({
      shapes: Object.freeze([...active.shapes]),
      nonReadRequestCount: active.nonReadRequestCount,
      readRequestCount: active.readRequestCount,
      unrecordedShapeCount: active.unrecordedShapeCount,
      preflightsFulfilled: active.preflightsFulfilled,
    });
  }
}

function stateOf(observation: SubmissionObservation): ObservationState {
  const state = observationStates.get(observation);
  if (state === undefined) {
    throw new TypeError('Submission observation was not constructed');
  }
  return state;
}

/** 口を Guard に付ける（Guard の取り付けだけが呼ぶ）。口でないか、すでに別の Guard に付いていれば `TypeError`。 */
export function attachSubmissionObservation(observation: unknown): void {
  const state = observation instanceof SubmissionObservation ? observationStates.get(observation) : undefined;
  if (state === undefined) {
    throw new TypeError('Passive request guard submission observation must be a SubmissionObservation');
  }
  if (state.attached) {
    throw new TypeError('Submission observation is already attached to another Guard');
  }
  state.attached = true;
}

/** DEF-276: 凍結の後に押す口か（唯一の判定。Guard の CSP の選び方と、factory の最初から凍結の口が使う）。 */
export function observationPressesAfterFreeze(observation: SubmissionObservation): boolean {
  return stateOf(observation).pressesAfterFreeze;
}

/** 観察の間で、URL が承認した API の Origin か（凍結の段の事前確認を Guard が満たしてよいか。Origin の判定は `hasAllowedOrigin`）。 */
export function observationAdmitsFrozenPreflight(observation: SubmissionObservation, url: string): boolean {
  const state = observationStates.get(observation);
  if (state === undefined || state.active === null) {
    return false;
  }
  return hasAllowedOrigin(url, new Set(state.approvedApiOrigins));
}

/**
 * URL の Origin の区分（承認した API の Origin の一覧の位置、承認したテストの Origin の一覧の位置（DEF-220）、許可 Origin、そのほか。この順に当てる。Origin の判定は
 * `hasAllowedOrigin`）。
 */
function originShapeOf(url: string, state: ObservationState): ApiRequestOriginShape {
  const index = state.approvedApiOrigins.findIndex((entry) => hasAllowedOrigin(url, new Set([entry])));
  if (index >= 0) {
    return { kind: 'APPROVED_API', index };
  }
  const testIndex = state.approvedTestOrigins.findIndex((entry) => hasAllowedOrigin(url, new Set([entry])));
  if (testIndex >= 0) {
    return { kind: 'APPROVED_TEST', index: testIndex };
  }
  return hasAllowedOrigin(url, new Set(state.allowedOrigins)) ? { kind: 'ALLOWED' } : { kind: 'OTHER' };
}

/**
 * QUIET-3（設計書 `2026-11-24-beaksight-discovery-stuck-step-design.md` 2.3）: 要求の口の鍵（`requestEndpointKeyOf`）を、この口の型と突き合わせる鍵
 * （`apiShapeEndpointKeyOf`）にする（Origin の区分はこの口の一覧で決める）。読めない鍵は null。投げない。
 */
export function observedEndpointShapeKeyOf(observation: SubmissionObservation, endpointKey: string): string | null {
  const state = observationStates.get(observation);
  const parts = requestEndpointPartsOf(endpointKey);
  if (state === undefined || parts === null) return null;
  try {
    return apiEndpointShapeKeyOf(parts.method, originShapeOf(`${parts.origin}/`, state), parts.pathname);
  } catch {
    return null;
  }
}

/** Guard が凍結の段の事前確認を満たした（観察の間だけ数える）。 */
export function recordObservedFrozenPreflight(observation: SubmissionObservation): void {
  const active = observationStates.get(observation)?.active;
  if (active !== null && active !== undefined) {
    active.preflightsFulfilled += 1;
  }
}

/** 本文のない読み取りの照らし（目印は URL だけで照らす）。 */
const NO_REQUEST_BODY: ApiRequestBody = Object.freeze({ kind: 'NONE' });

/**
 * DEF-208-1（設計書 3.1 の設計者の判断 (a)）: Guard が凍結の段で通した読み取りの URL が、観察の間の目印（その押下で欄に入れた値）を運ぶか（数を分けて残すため。
 * 照らし方は書き込みの段と同じ `requestCarriesMarker`）。観察の間でなければ偽。投げない。
 */
export function frozenReadCarriesObservedMarker(observation: SubmissionObservation, url: string): boolean {
  const active = observationStates.get(observation)?.active;
  if (active === null || active === undefined) {
    return false;
  }
  try {
    return requestCarriesMarker(active.target.markers, { url, body: () => NO_REQUEST_BODY });
  } catch {
    return false;
  }
}

/**
 * DEF-233（設計書 `2026-11-09-beaksight-discovery-token-refresh-design.md` 2.1 の 1）: 凍結の段で通す token の更新の候補の URL か本文が、この口で始めた観察の
 * どれかの目印（押すときに欄へ入れた値。観察を終えた後も照らす）を運ぶか（照らし方は書き込みの段と同じ `requestCarriesMarker`。読めない本文は運ぶとみなす）。
 * 観察を 1 度も始めていなければ偽。投げない（照らしの失敗は運ぶとみなす）。
 */
export function frozenRequestCarriesObservedMarker(observation: SubmissionObservation, url: string, body: () => ApiRequestBody): boolean {
  const state = observationStates.get(observation);
  if (state === undefined) {
    return true;
  }
  try {
    return requestCarriesMarker(state.seenMarkers, { url, body });
  } catch {
    return true;
  }
}

/**
 * DEF-233 fix round 1（設計書 2.2）: 値（次の画面へ渡す候補のログインの鍵の値）が、この口で始めた観察のどれかの目印を含むか（照らし方は
 * `frozenRequestCarriesObservedMarker` と同じ。本文はない）。口を作っていなければ含むとみなす。投げない。
 */
export function valueCarriesObservedMarker(observation: SubmissionObservation, value: string): boolean {
  return frozenRequestCarriesObservedMarker(observation, value, () => NO_REQUEST_BODY);
}

/** Guard が凍結の段で止めた要求を受ける（観察の間だけ。読み取りは数だけ。投げない）。 */
export function recordObservedFrozenRequest(observation: SubmissionObservation, facts: ObservedFrozenRequestFacts): void {
  const state = observationStates.get(observation);
  const active = state?.active;
  if (state === undefined || active === null || active === undefined) {
    return;
  }
  if (isReadMethod(facts.method)) {
    active.readRequestCount += 1;
    return;
  }
  active.nonReadRequestCount += 1;
  // L7（N38。上限の撤廃の設計書 4）: 1 回の観察の型の数で打ち切らない（前は 8）。
  try {
    active.shapes.push(apiRequestShapeOf(
      {
        method: facts.method,
        resourceType: facts.resourceType,
        url: facts.url,
        origin: originShapeOf(facts.url, state),
        headers: facts.headers,
        body: facts.body(),
      },
      // T37R-fix-A（I-3）: 論理削除の鍵の判定（状態の欄の名前の判定の owner）を渡し、伏せる前の名前で見た真偽だけを型に残させる。
      { ...active.target, isStateKeyName: fieldNameHasStateWord },
    ));
  } catch {
    // 型を作れなかった（目印の数の上限、本文の読み取りの失敗など）。文は残さず、数だけを残す。
    active.unrecordedShapeCount += 1;
  }
}
