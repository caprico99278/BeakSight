/**
 * まとめて実行の決まり（FM2d。設計書 `2026-10-19-beaksight-fewer-manual-steps-design.md` 3A.1、5 章の 2026-10-22 の FM2d の Blocker の行）。純粋な関数と
 * 閉じた一覧だけ（管理データ・ジョブの管理・ブラウザに触れない。書き込みの連鎖 `apps/local-ui/src/server/write-chain-policy.ts` と同じ形）。ジョブの管理
 * （`audit-job-manager.ts`）と、画面の表示と、表示のカタログの網羅の確かめが使う。
 * - 段の並び（`chainStagesOfMode`）: `TEST_AUTH_PASSIVE` は監査 → 発見 → READ の確かめ、`TEST_APPROVED_WRITE` は発見 → READ の確かめ（並びの一覧は IPC の契約
 *   `WORKER_CHAIN_STAGE_SEQUENCES`）。公開の監査はログインしないので連鎖しない。
 * - 次の段へ進むか（`chainAdvanceDecisionOf`）: 止める理由（`CHAIN_STOP_REASONS`）に当たらなければ進む（`COMPLETE` と、ページ・時間の上限やページ単位の理由の
 *   `PARTIAL`）。止める理由は、利用者の停止、Safety の違反、セッションの切れ、サイトの不調、サービスの要求の上限、段の失敗（`FAILED`・Run を実行しなかった・
 *   結果を読めない）、プロファイルの改訂の変化。`NEXT_STAGE_REJECTED` は、進むと決めた後に次の段のジョブの行を作れなかったとき（ジョブの管理が付ける）。
 * - READ の確かめ（`chainReadCheckDecisionOf`）: 定義が 1 件以上なら行い、0 件なら「行わなかった」（`NOT_NEEDED`。失敗にしない）。
 * - 連鎖の表示（`StageChainView`）: メモリの中だけ（管理データに書かない。画面のサーバが止まれば消える）。状態と理由の表示は、画面のカタログが持つ。
 */
import type { AuditMode } from '../contracts.js';
import { WORKER_CHAIN_STAGE_SEQUENCES, type WorkerChainStageKind, type WorkerChainStageSequence } from '../worker-protocol.js';
import type { IncompleteReasonCode, RunStatus } from '../../core/contracts.js';
import {
  CHAIN_STAGE_STATES,
  CHAIN_STATES,
  DONE_CHAIN_STAGE_STATE,
  FINISHED_CHAIN_STATE,
  NOT_NEEDED_CHAIN_STAGE_STATE,
  NOT_STARTED_CHAIN_STAGE_STATE,
  PENDING_CHAIN_STAGE_STATE,
  RUNNING_CHAIN_STAGE_STATE,
  RUNNING_CHAIN_STATE,
  STOPPED_CHAIN_STAGE_STATE,
  STOPPED_CHAIN_STATE,
  type ChainStageState,
  type ChainState,
} from '../../core/stage-chain-states.js';

/** まとめて実行を止めた理由（閉じた一覧。判定の順）。 */
export const CHAIN_STOP_REASONS = Object.freeze([
  'USER_STOPPED',
  'SAFETY_VIOLATION',
  'SESSION_LOST',
  'SITE_UNAVAILABLE',
  'SERVICE_REQUEST_LIMIT_REACHED',
  'STAGE_FAILED',
  'PROFILE_REVISION_CHANGED',
  'NEXT_STAGE_REJECTED',
] as const);
export type ChainStopReason = (typeof CHAIN_STOP_REASONS)[number];

/**
 * 連鎖の状態と段の状態（閉じた一覧。PRE42-CC 組 UI-K2（CC-113）: 定義と値の意味は、画面のブラウザ側からも読める純粋なファイル
 * `src/core/stage-chain-states.ts` に移し、ここは同じ名前で公開し直す）。
 */
export {
  CHAIN_STAGE_STATES,
  CHAIN_STATES,
  DONE_CHAIN_STAGE_STATE,
  FINISHED_CHAIN_STATE,
  NOT_NEEDED_CHAIN_STAGE_STATE,
  NOT_STARTED_CHAIN_STAGE_STATE,
  PENDING_CHAIN_STAGE_STATE,
  RUNNING_CHAIN_STAGE_STATE,
  RUNNING_CHAIN_STATE,
  STOPPED_CHAIN_STAGE_STATE,
  STOPPED_CHAIN_STATE,
  type ChainStageState,
  type ChainState,
};

/** モードの段の並び（連鎖しないモードは `null`）。 */
export const chainStagesOfMode = (mode: AuditMode): WorkerChainStageSequence | null => {
  switch (mode) {
    case 'TEST_AUTH_PASSIVE':
      return WORKER_CHAIN_STAGE_SEQUENCES[0];
    case 'TEST_APPROVED_WRITE':
      return WORKER_CHAIN_STAGE_SEQUENCES[1];
    case 'PUBLIC_PASSIVE':
      return null;
  }
};

/** 次の段へ進むかの判定の入力（終えた段の事実）。 */
export interface ChainAdvanceInput {
  /** 利用者が止めた（画面の「やめる」。連鎖の全体を止める）。 */
  readonly stopRequested: boolean;
  /** 段が Run を実行した（`FINISHED` の `RAN`）。 */
  readonly outcomeRan: boolean;
  /** 段の結果のファイルを読めて、記録できた（発見の索引など。読まない段は真）。 */
  readonly stageResultValid: boolean;
  /** 段の Run Status（`FINISHED` の結果の写し。Run を実行しなかったなら `null`）。 */
  readonly stageRunStatus: RunStatus | null;
  /** 段の未完了の理由のコード（`FINISHED` の `incompleteReasonCodes`）。 */
  readonly incompleteReasonCodes: readonly IncompleteReasonCode[];
  /** 段の途中でセッションの切れの知らせ（`AUTH_STATE` の `SESSION_LOST`）を受けた。 */
  readonly sessionLost: boolean;
  /** プロファイルの改訂が、連鎖を始めた時のままで、プロファイルが使える。 */
  readonly profileRevisionUnchanged: boolean;
}

export type ChainAdvanceDecision = { readonly kind: 'CONTINUE' } | { readonly kind: 'STOP'; readonly reason: ChainStopReason };

/**
 * 理由のコードごとの、次の段へ進むかの分類（FM2R の I-4。すべてのコードを型で強制する。core の一覧に値が増え、ここにないと型のエラーになる）。
 * - ページ単位の理由（読み込み・描画・測りの失敗、ページ・深さ・時間の上限）は進む（`CONTINUE`）。
 * - Run 単位の理由（Run の記録・安全の記録・実行の欠け）は止める（`STAGE_FAILED`）。必須の作業の理由（`REQUIRED_WORK_*`）と成果物の不正
 *   （`REQUIRED_ARTIFACT_INVALID`）は、分類に迷うので止める側にした（FM2R の報告）。
 * - 止める要求・安全の違反・セッションの切れ・サイトの不調・サービスの要求の上限は、それぞれの止める理由。
 */
export const CHAIN_REASON_CODE_DECISIONS: { readonly [Code in IncompleteReasonCode]: ChainStopReason | 'CONTINUE' } = Object.freeze({
  DEADLINE_EXCEEDED: 'CONTINUE',
  EVALUATION_FAILED: 'CONTINUE',
  PAGE_CLOSED: 'CONTINUE',
  NAVIGATION_FAILED: 'CONTINUE',
  DOM_READINESS_FAILED: 'CONTINUE',
  SCROLL_TARGET_UNRESOLVED: 'CONTINUE',
  SCROLL_NOT_ADVANCED: 'CONTINUE',
  INNER_SCROLL_CONTAINER_NOT_TRAVERSED: 'CONTINUE',
  INNER_SCROLL_SCAN_LIMIT_REACHED: 'CONTINUE',
  SCROLL_TARGET_UNSTABLE: 'CONTINUE',
  POSITION_NOT_AT_ORIGIN: 'CONTINUE',
  LAYOUT_COMPARISON_LIMIT_REACHED: 'CONTINUE',
  RESOURCE_LIMIT_REACHED: 'CONTINUE',
  INVALID_BROWSER_DATA: 'CONTINUE',
  PAGE_NAVIGATION_LIMIT_REACHED: 'CONTINUE',
  PAGE_SUBRESOURCE_LIMIT_REACHED: 'CONTINUE',
  PREFLIGHT_FAILED: 'STAGE_FAILED',
  RUN_DIRECTORY_UNAVAILABLE: 'STAGE_FAILED',
  SAFETY_INVARIANT_VIOLATION: 'SAFETY_VIOLATION',
  SAFETY_LEDGER_TRUNCATED: 'STAGE_FAILED',
  UNHANDLED_FAILURE: 'STAGE_FAILED',
  MAX_PAGES_REACHED: 'CONTINUE',
  MAX_DEPTH_REACHED: 'CONTINUE',
  MAX_RUNTIME_REACHED: 'CONTINUE',
  REQUIRED_ARTIFACT_INVALID: 'STAGE_FAILED',
  EXECUTION_INCOMPLETE: 'STAGE_FAILED',
  REQUIRED_WORK_SKIPPED: 'STAGE_FAILED',
  REQUIRED_WORK_BLOCKED: 'STAGE_FAILED',
  REQUIRED_WORK_TIMED_OUT: 'STAGE_FAILED',
  REQUIRED_WORK_NOT_OBSERVED: 'STAGE_FAILED',
  REQUIRED_WORK_NOT_VERIFIED: 'STAGE_FAILED',
  REQUIRED_WORK_FAILED: 'STAGE_FAILED',
  COLLECTOR_INCOMPLETE: 'CONTINUE',
  RULE_EVALUATION_FAILED: 'CONTINUE',
  PAGE_CRASHED: 'CONTINUE',
  SAFETY_VIOLATION_ABORT: 'SAFETY_VIOLATION',
  CHECKPOINT_WRITE_FAILED: 'STAGE_FAILED',
  RUN_INTERRUPTED: 'USER_STOPPED',
  SITE_UNAVAILABLE: 'SITE_UNAVAILABLE',
  AUTH_SESSION_LOST: 'SESSION_LOST',
  SERVICE_REQUEST_LIMIT_REACHED: 'SERVICE_REQUEST_LIMIT_REACHED',
});

/** 理由のコードの止める理由（進むなら `null`。表にない値（型の外から来たもの）は、止める側に倒して段の失敗）。 */
const stopReasonOfCode = (code: IncompleteReasonCode): ChainStopReason | null => {
  const decision = (CHAIN_REASON_CODE_DECISIONS as Readonly<Record<string, ChainStopReason | 'CONTINUE' | undefined>>)[code];
  return decision === 'CONTINUE' ? null : (decision ?? 'STAGE_FAILED');
};

/** 進む Run Status（ほかは段の失敗）。 */
const CONTINUING_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(['COMPLETE', 'PARTIAL']);

const STOP = (reason: ChainStopReason): ChainAdvanceDecision => Object.freeze({ kind: 'STOP', reason });
const CONTINUE: ChainAdvanceDecision = Object.freeze({ kind: 'CONTINUE' });

/** 終えた段の後に、次の段へ進むか（止めるなら理由。理由は `CHAIN_STOP_REASONS` の順で最初に当たったもの）。 */
export const chainAdvanceDecisionOf = (input: ChainAdvanceInput): ChainAdvanceDecision => {
  const found = new Set<ChainStopReason>(input.incompleteReasonCodes.flatMap((code) => {
    const reason = stopReasonOfCode(code);
    return reason === null ? [] : [reason];
  }));
  if (input.stopRequested) {
    found.add('USER_STOPPED');
  }
  if (input.stageRunStatus === 'ABORTED_BY_SAFETY') {
    found.add('SAFETY_VIOLATION');
  }
  if (input.sessionLost) {
    found.add('SESSION_LOST');
  }
  if (!input.outcomeRan || !input.stageResultValid || input.stageRunStatus === null || !CONTINUING_RUN_STATUSES.has(input.stageRunStatus)) {
    found.add('STAGE_FAILED');
  }
  if (!input.profileRevisionUnchanged) {
    found.add('PROFILE_REVISION_CHANGED');
  }
  const reason = CHAIN_STOP_REASONS.find((candidate) => found.has(candidate));
  return reason === undefined ? CONTINUE : STOP(reason);
};

/** READ の確かめの段を行うか（定義の件数から）。 */
export const chainReadCheckDecisionOf = (definitions: number): 'RUN' | 'NOT_NEEDED' => (definitions > 0 ? 'RUN' : 'NOT_NEEDED');

/** 連鎖の段 1 つの表示（ジョブの ID は始めた段だけ）。 */
export interface StageChainStageView {
  readonly kind: WorkerChainStageKind;
  readonly state: ChainStageState;
  readonly jobId: string | null;
}

/** 連鎖の表示（メモリの中だけ）。`chainId` は最初の段のジョブの ID。 */
export interface StageChainView {
  readonly chainId: string;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly state: ChainState;
  readonly stopReason: ChainStopReason | null;
  readonly stages: readonly StageChainStageView[];
}
