// 送らずに観察する probe の口（T37b。Task 37 の設計書 3.2 の「Guard の観察の形」、4 章）。Safety Ledger とは別の受け手。
// - factory（`BrowserContextFactory`）が、発見のジョブなどの PRIMARY の Passive の Context ごとに 1 つ作り、Guard の取り付けの指定
//   （`PassiveRequestGuardOptions.submissionObservation`）で渡す。呼び出し側は `factory.submissionObservationOf(context)` で受け取る。
// - 既定は無効。`begin` から `end` の間だけ有効で、Guard は凍結の段（`FROZEN_ACTIVE`）で次の 2 つを行う。口がない Context と、口が無効の間は、Guard の
//   振る舞いを 1 つも変えない。
//   1. 承認した API の Origin への CORS の事前確認を、監査の段と同じく Guard が満たす（`observationAdmitsFrozenPreflight` が真のとき。サーバへ送らない。
//      I18）。ほかの Origin の事前確認は、今どおり止める。
//   2. 止めた要求（`BLOCK_FROZEN`。今どおり止め、凍結の後の止めた記録にも入る）のうち、読み取りでないものの型を作って受ける
//      （`recordObservedFrozenRequest`。型は `src/core/api-request-shape.ts`）。読み取りは数だけ（本文を読まない）。1 回の観察の型の数は
//      `MAX_OBSERVED_SUBMISSION_SHAPES` まで（超えた分と、型を作れなかった要求は `unrecordedShapeCount` に数える）。
// - 値は持たない（I22）: 本文はメモリの中で型を作るためだけに読み、型と数だけを残す。型を作る部品の例外は、文を残さずに数える。
// - Guard のほかから書けないよう、状態はこのファイルの中だけ（`observationStates`）に置く。`observationAdmitsFrozenPreflight`・
//   `recordObservedFrozenRequest`・`recordObservedFrozenPreflight`・`attachSubmissionObservation` は Guard だけが呼ぶ。
import { apiRequestShapeOf, type ApiRequestBody, type ApiRequestOriginShape, type ApiRequestShape } from '../core/api-request-shape.js';
import { fieldNameHasStateWord } from '../discovery/classify.js';
import { hasAllowedOrigin, isReadMethod } from './request-policy.js';

/** 1 回の観察（`begin` から `end`）で受ける型の数の上限。 */
export const MAX_OBSERVED_SUBMISSION_SHAPES = 8;

/** 口の作成の指定（承認した API の Origin と、許可 Origin。factory が渡す）。 */
export interface SubmissionObservationOptions {
  readonly approvedApiOrigins: readonly string[];
  readonly allowedOrigins: readonly string[];
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
  readonly allowedOrigins: readonly string[];
  attached: boolean;
  active: ActiveObservation | null;
}

const observationStates = new WeakMap<SubmissionObservation, ObservationState>();

const isStringList = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every((entry) => typeof entry === 'string');

/** 送らずに観察する probe の口（既定は無効）。 */
export class SubmissionObservation {
  constructor(options: SubmissionObservationOptions) {
    if (typeof options !== 'object' || options === null || !isStringList(options.approvedApiOrigins) || !isStringList(options.allowedOrigins)) {
      throw new TypeError('Submission observation requires the approved API Origins and the allowed Origins as strings');
    }
    observationStates.set(this, {
      approvedApiOrigins: Object.freeze([...options.approvedApiOrigins]),
      allowedOrigins: Object.freeze([...options.allowedOrigins]),
      attached: false,
      active: null,
    });
  }

  /** 観察の間か。 */
  get active(): boolean {
    return stateOf(this).active !== null;
  }

  /**
   * 観察を始める（受けた型と数を空にする）。観察の間に呼ぶと `Error`。path が `/` で始まる文字列でないか、目印が文字列の配列でなければ `TypeError`
   * （値を文に入れない。目印の数の上限は、型を作るときに型の作り手が確かめ、超えた要求は型を受けずに数える）。
   */
  begin(target: SubmissionObservationTarget): void {
    const state = stateOf(this);
    if (state.active !== null) {
      throw new Error('Submission observation has already begun');
    }
    if (typeof target !== 'object' || target === null || typeof target.pagePath !== 'string' || !target.pagePath.startsWith('/')
      || !isStringList(target.markers)) {
      throw new TypeError('Submission observation requires a page path that starts with "/" and markers as strings');
    }
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

/** 観察の間で、URL が承認した API の Origin か（凍結の段の事前確認を Guard が満たしてよいか。Origin の判定は `hasAllowedOrigin`）。 */
export function observationAdmitsFrozenPreflight(observation: SubmissionObservation, url: string): boolean {
  const state = observationStates.get(observation);
  if (state === undefined || state.active === null) {
    return false;
  }
  return hasAllowedOrigin(url, new Set(state.approvedApiOrigins));
}

/** URL の Origin の区分（承認した API の Origin の一覧の位置、許可 Origin、そのほか。Origin の判定は `hasAllowedOrigin`）。 */
function originShapeOf(url: string, state: ObservationState): ApiRequestOriginShape {
  const index = state.approvedApiOrigins.findIndex((entry) => hasAllowedOrigin(url, new Set([entry])));
  if (index >= 0) {
    return { kind: 'APPROVED_API', index };
  }
  return hasAllowedOrigin(url, new Set(state.allowedOrigins)) ? { kind: 'ALLOWED' } : { kind: 'OTHER' };
}

/** Guard が凍結の段の事前確認を満たした（観察の間だけ数える）。 */
export function recordObservedFrozenPreflight(observation: SubmissionObservation): void {
  const active = observationStates.get(observation)?.active;
  if (active !== null && active !== undefined) {
    active.preflightsFulfilled += 1;
  }
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
  if (active.shapes.length >= MAX_OBSERVED_SUBMISSION_SHAPES) {
    active.unrecordedShapeCount += 1;
    return;
  }
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
