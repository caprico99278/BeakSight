/**
 * 「登録してから更新する」の決まり（T41g。Task 41 の設計書 3.5.1。ユーザーの判断「1で進めて。明日の検証に必要。」）。純粋な関数と閉じた一覧だけ（管理データ・
 * ジョブの管理・ブラウザに触れない）。続けて始める部品（`write-job-functions.ts`）と、画面の表示と、表示のカタログの網羅の確かめが使う。
 * - 続けて更新を始めるか（`writeChainUpdateDecisionOf`）: 登録のジョブの結果が照合済み（`VERIFIED`）で、登録の ID が取れていて、更新の予定の対象
 *   （`readPlannedUpdateTarget`）がその ID と同じときだけ始める（予定の ID を許可の発行に渡す）。ほかは始めず、理由を返す。
 * - 開始の画面に「登録してから更新する」を出すか（`writeChainOfferOf`）: 更新の対象がない（許可の発行の `TARGET_RECORD_UNAVAILABLE` にあたる）か、
 *   最新のレコードで前の更新が照合済みにならずに止まった（前の結果が締めてあって `VERIFIED` でない）とき。
 * - 状態と理由の表示はカタログ（`WRITE_CHAIN_STATE_CATALOG`・`WRITE_CHAIN_STOP_REASON_CATALOG`）と文言（`LOCAL_UI_WRITE_TEXT.chain`）。
 */
import { VERIFIED_ACTION_RESULT, type ActionResult } from '../../../../src/control/actions/action-contracts.js';
import { MINUTE_MS } from '../../../../src/core/time-units.js';
import { PENDING_WRITE_CHAIN_STATES, WRITE_CHAIN_STATES, type WriteChainState } from '../../../../src/core/write-chain-states.js';

/**
 * 続けて始める状態（閉じた一覧）。PRE42-CC 組 UI-K2（CC-113）: 定義と値の意味は、画面のブラウザ側からも読める純粋なファイル
 * `src/core/write-chain-states.ts` に移し、ここは同じ名前で公開し直す（まだ決まっていない状態 `PENDING_WRITE_CHAIN_STATES` も）。
 */
export { PENDING_WRITE_CHAIN_STATES, WRITE_CHAIN_STATES, type WriteChainState };

/**
 * 更新を始めなかった理由（閉じた一覧）。
 * - `CREATE_NOT_VERIFIED`: 登録のジョブの結果が照合済みでない（結果がない、照合できていない、分からない、止めた、など）。
 * - `CREATE_RECORD_ID_MISSING`: 照合済みだが、登録の ID が記録にない。
 * - `PLANNED_TARGET_MISMATCH`: 更新の予定の対象が、登録の ID と違う（ほかの登録が新しい、予定がない）。
 * - `UPDATE_START_REJECTED`: 更新の許可の発行かジョブの開始が拒んだ（理由は開始の結果）。
 * - `CREATE_WAIT_TIMEOUT`: 登録のジョブが待つ上限の時間の中で終わらなかった。
 */
export const WRITE_CHAIN_STOP_REASONS = Object.freeze([
  'CREATE_NOT_VERIFIED',
  'CREATE_RECORD_ID_MISSING',
  'PLANNED_TARGET_MISMATCH',
  'UPDATE_START_REJECTED',
  'CREATE_WAIT_TIMEOUT',
] as const);
export type WriteChainStopReason = (typeof WRITE_CHAIN_STOP_REASONS)[number];

/** 「登録してから更新する」を出す理由（閉じた一覧）。`NO_TARGET`: 更新の対象がない。`PREVIOUS_UPDATE_STOPPED`: 最新のレコードで前の更新が止まった。 */
export const WRITE_CHAIN_OFFER_REASONS = Object.freeze(['NO_TARGET', 'PREVIOUS_UPDATE_STOPPED'] as const);
export type WriteChainOfferReason = (typeof WRITE_CHAIN_OFFER_REASONS)[number];

/** 続けて更新を始めるかの判定の入力。 */
export interface WriteChainUpdateInput {
  /** 登録のジョブの結果（締めていなければ null）。 */
  readonly createResult: ActionResult | null;
  /** 登録の ID（取れていなければ null）。 */
  readonly createRecordId: string | null;
  /** 更新の予定の対象（`readPlannedUpdateTarget`。なければ null）。 */
  readonly plannedTarget: string | null;
}

/** 続けて更新を始めるかの判定。 */
export type WriteChainUpdateDecision =
  | { readonly kind: 'START_UPDATE'; readonly targetRecordId: string }
  | { readonly kind: 'STOP'; readonly reason: WriteChainStopReason };

/** 登録のジョブの後に、続けて更新を始めるか（始めるなら予定の ID）。 */
export const writeChainUpdateDecisionOf = (input: WriteChainUpdateInput): WriteChainUpdateDecision => {
  if (input.createResult !== VERIFIED_ACTION_RESULT) {
    return { kind: 'STOP', reason: 'CREATE_NOT_VERIFIED' };
  }
  if (input.createRecordId === null) {
    return { kind: 'STOP', reason: 'CREATE_RECORD_ID_MISSING' };
  }
  return input.plannedTarget === input.createRecordId
    ? { kind: 'START_UPDATE', targetRecordId: input.createRecordId }
    : { kind: 'STOP', reason: 'PLANNED_TARGET_MISMATCH' };
};

/**
 * T41g-3（Task 41 の設計書 3.5.1 の末尾）: 自動ログインの最小の間隔を待つ上限（ms。間隔の 5 分（`AUTO_LOGIN_MIN_INTERVAL_MS`）より長い 10 分）。次に始められる
 * 時刻がこれより先なら待たない。
 */
export const WRITE_CHAIN_LOGIN_WAIT_LIMIT_MS = 10 * MINUTE_MS;

/** 自動ログインの最小の間隔で止めた理由（開始の前の確かめの理由。ジョブの管理と同じ値）。 */
const AUTO_LOGIN_RATE_LIMITED = 'AUTO_LOGIN_RATE_LIMITED';
/** 開始の前の確かめ（ジョブの管理）の段。 */
const START_STAGE = 'START';

/** 更新を始められなかった結果のうち、やり直すかの判定に使う項目（画面のサーバの開始の結果の形）。 */
export interface WriteChainStartFailure {
  readonly stage: string;
  readonly reason: string;
  readonly nextAllowedAt?: string | null;
}

/** やり直すかの判定。`WAIT`: `until`（ISO 8601）まで待ってから 1 回だけやり直す。`STOP`: やり直さない。 */
export type WriteChainRetry = { readonly kind: 'WAIT'; readonly until: string } | { readonly kind: 'STOP' };

/**
 * T41g-3: 更新を始められなかったときに、待ってやり直すか。開始の前の確かめが自動ログインの最小の間隔（`AUTO_LOGIN_RATE_LIMITED`）で止め、次に始められる
 * 時刻があり、その時刻が今から `limitMs` の中のときだけ待つ。ほかの理由・時刻がない・読めない・上限を超える時刻は、やり直さない（間隔の決まりは変えない）。
 */
export const writeChainRetryOf = (failure: WriteChainStartFailure, now: Date, limitMs: number): WriteChainRetry => {
  const next = failure.nextAllowedAt ?? null;
  if (failure.stage !== START_STAGE || failure.reason !== AUTO_LOGIN_RATE_LIMITED || next === null) {
    return { kind: 'STOP' };
  }
  const until = new Date(next);
  const wait = until.getTime() - now.getTime();
  return Number.isFinite(wait) && wait <= limitMs ? { kind: 'WAIT', until: until.toISOString() } : { kind: 'STOP' };
};

/** 開始の画面に出すかの判定の入力（前の更新は、その更新のシナリオの最後の書き込みの結果）。 */
export interface WriteChainOfferInput {
  readonly plannedTarget: string | null;
  readonly lastUpdate: { readonly targetRecordId: string | null; readonly result: ActionResult | null } | null;
}

/** 「登録してから更新する」を出す理由（出さないなら null）。 */
export const writeChainOfferOf = (input: WriteChainOfferInput): WriteChainOfferReason | null => {
  if (input.plannedTarget === null) {
    return 'NO_TARGET';
  }
  const last = input.lastUpdate;
  return last !== null && last.targetRecordId === input.plannedTarget && last.result !== null && last.result !== VERIFIED_ACTION_RESULT
    ? 'PREVIOUS_UPDATE_STOPPED'
    : null;
};
