// ワーカーの側の、書き込みのジョブの IPC の小さな部品（Task 30 の設計書 3 章の「送る直前の確かめ直し」、4 章の「IPC」。T30e）。T30f の書き込みの流れが
// 使う（流れは、送る直前に `requestRecheck` を待ち、許されたときだけ送る。送った・止めた・分からないを `reportSubmission` で 1 回だけ報告する）。
// - 確かめ直しの依頼（`WRITE_RECHECK_REQUEST`）は 1 つのジョブで 1 回だけ送る。2 回目は送らずに `RECHECK_ALREADY_REQUESTED` で拒む。
// - 親の結果（`WRITE_RECHECK_RESULT`）を、名前つきの上限（`WORKER_WRITE_RECHECK_TIMEOUT_MS`）だけ待つ。来なければ `RECHECK_TIMEOUT` で許さない
//   （送らない）。上限の後に届いた結果、依頼していない結果、2 回目の結果は受けない（`receiveRecheckResult` が偽を返す。呼ぶ側が契約の違反として
//   扱う）。
// - 送信の報告（`WRITE_SUBMISSION`）は 1 回だけ送る（2 回目は送らずに偽）。
// 管理データ・ブラウザに触れない。送る関数は呼ぶ側が渡す（本番は、ワーカーのセッションの送る口）。
import {
  WORKER_PROTOCOL_VERSION,
  WORKER_WRITE_RECHECK_TIMEOUT_MS,
  type WorkerToParentMessage,
  type WorkerWriteRecheckRejectionReason,
  type WorkerWriteRecheckResultMessage,
  type WorkerWriteSubmissionMessage,
} from '../control/worker-protocol.js';

/** ワーカーの側だけで決める、許さない理由（親の理由のほか）。 */
export const WORKER_LOCAL_RECHECK_REJECTION_REASONS = Object.freeze(['RECHECK_TIMEOUT', 'RECHECK_ALREADY_REQUESTED'] as const);
export type WorkerLocalRecheckRejectionReason = (typeof WORKER_LOCAL_RECHECK_REJECTION_REASONS)[number];

/** 確かめ直しの結果（許す、または許さない理由）。 */
export type WorkerWriteRecheckOutcome =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: WorkerWriteRecheckRejectionReason | WorkerLocalRecheckRejectionReason };

/** 送信の報告の中身（`NOT_SENT` だけが止めた理由を持つ）。 */
export type WorkerWriteSubmissionReport = Pick<WorkerWriteSubmissionMessage, 'submission' | 'blockReason'>;

/** 部品を作るときに受け取るもの。 */
export interface WorkerWriteIpcOptions {
  /** 親へ送る（ワーカーのセッションの送る口）。 */
  readonly send: (message: WorkerToParentMessage) => void;
  /** 結果を待つ上限（ms。省略すると `WORKER_WRITE_RECHECK_TIMEOUT_MS`）。 */
  readonly timeoutMs?: number;
}

/** 書き込みのジョブの IPC の部品。 */
export interface WorkerWriteIpc {
  /** 確かめ直しを依頼し、結果を待つ（1 回だけ。reject しない）。 */
  readonly requestRecheck: () => Promise<WorkerWriteRecheckOutcome>;
  /** 親の結果を受ける。待っている依頼がなければ偽（受けない）。 */
  readonly receiveRecheckResult: (message: WorkerWriteRecheckResultMessage) => boolean;
  /** 送信を報告する（1 回だけ。2 回目は送らずに偽）。 */
  readonly reportSubmission: (report: WorkerWriteSubmissionReport) => boolean;
}

const ALREADY_REQUESTED: WorkerWriteRecheckOutcome = Object.freeze({ allowed: false, reason: 'RECHECK_ALREADY_REQUESTED' });
const TIMED_OUT: WorkerWriteRecheckOutcome = Object.freeze({ allowed: false, reason: 'RECHECK_TIMEOUT' });
const ALLOWED: WorkerWriteRecheckOutcome = Object.freeze({ allowed: true });

/** 書き込みのジョブの IPC の部品を作る（ジョブごとに 1 つ）。 */
export const createWorkerWriteIpc = (options: WorkerWriteIpcOptions): WorkerWriteIpc => {
  const timeoutMs = options.timeoutMs ?? WORKER_WRITE_RECHECK_TIMEOUT_MS;
  let requested = false;
  let reported = false;
  /** 待っている依頼の受け手（待っていなければ null）。 */
  let pending: ((outcome: WorkerWriteRecheckOutcome) => void) | null = null;

  const requestRecheck = (): Promise<WorkerWriteRecheckOutcome> => {
    if (requested) {
      return Promise.resolve(ALREADY_REQUESTED);
    }
    requested = true;
    return new Promise<WorkerWriteRecheckOutcome>((resolvePromise) => {
      const timer = setTimeout(() => {
        pending = null;
        resolvePromise(TIMED_OUT);
      }, timeoutMs);
      pending = (outcome) => {
        clearTimeout(timer);
        pending = null;
        resolvePromise(outcome);
      };
      options.send({ protocol: WORKER_PROTOCOL_VERSION, type: 'WRITE_RECHECK_REQUEST' });
    });
  };

  const receiveRecheckResult = (message: WorkerWriteRecheckResultMessage): boolean => {
    const receiver = pending;
    if (receiver === null) {
      return false;
    }
    receiver(message.allowed && message.reason === null
      ? ALLOWED
      : Object.freeze({ allowed: false, reason: message.reason ?? 'GRANT_INVALID' }));
    return true;
  };

  const reportSubmission = (report: WorkerWriteSubmissionReport): boolean => {
    if (reported) {
      return false;
    }
    reported = true;
    options.send({ protocol: WORKER_PROTOCOL_VERSION, type: 'WRITE_SUBMISSION', submission: report.submission, blockReason: report.blockReason });
    return true;
  };

  return Object.freeze({ requestRecheck, receiveRecheckResult, reportSubmission });
};
