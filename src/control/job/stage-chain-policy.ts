/**
 * まとめて実行の決まり（FM2d。設計書 `2026-10-19-beaksight-fewer-manual-steps-design.md` 3A.1、5 章の 2026-10-22 の FM2d の Blocker の行）。純粋な関数と
 * 閉じた一覧だけ（管理データ・ジョブの管理・ブラウザに触れない。書き込みの連鎖 `apps/local-ui/src/server/write-chain-policy.ts` と同じ形）。ジョブの管理
 * （`audit-job-manager.ts`）と、画面の表示と、表示のカタログの網羅の確かめが使う。
 * - 段の並び（`chainStagesOfMode`）: `TEST_AUTH_PASSIVE` と `TEST_APPROVED_WRITE`（MI-5 から。前は発見 → READ の確かめ）は監査 → 発見 → READ の確かめ
 *   （並びの一覧は IPC の契約 `WORKER_CHAIN_STAGE_SEQUENCES`）。公開の監査はログインしないので連鎖しない。
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
  // OP-2（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D8'）: 書き込みの段の結果が分からない（送ったか・照合できたかが分からない）。残りの書き込みを止める。
  'WRITE_RESULT_UNKNOWN',
  // OP-F（安全のレビューの M-1）: チェックした画面のうち、試せなかった画面があった（許可を発行できない・値を作れないなど。送っていない）。ほかの画面は試した。
  'WRITE_NOT_TRIED',
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
    // MI-5（設計書 `2026-10-26-beaksight-minimal-input-ux-design.md` 4.5）: 書き込みのモードでも監査を始められる（`execution-policy.ts` の `AUDIT` の行）ので、
    // 認証つきの読み取りの監査と同じ監査 → 発見 → READ の確かめ（前は発見 → READ の確かめ。MI-C で、どのモードも使わなくなった前の並びを IPC の契約の
    // 並びの一覧から外した）。
    case 'TEST_APPROVED_WRITE':
      return WORKER_CHAIN_STAGE_SEQUENCES[0];
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

// ---------------------------------------------------------------------------------------------------------------
// OP-2（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.1 の D7'〜D9'、4.1.2 の案 C）: 連鎖の最後の書き込みの段
// ---------------------------------------------------------------------------------------------------------------

/** 書き込みの段の対象（チェックした画面 1 つ。登録のシナリオと、その台帳に結ぶ更新のシナリオ（なければ null））。 */
export interface ChainWriteTarget {
  readonly createScenarioId: string;
  readonly updateScenarioId: string | null;
}

/** 書き込みの段の対象を決める入力（プロファイルのシナリオ 1 件の事実）。 */
export interface ChainWriteScenarioFact {
  readonly scenarioId: string;
  readonly kind: 'CREATE' | 'UPDATE';
  /** 承認した状態か（チェックした画面のシナリオ。チェックの保存が承認を兼ねる）。 */
  readonly approved: boolean;
  /** 更新の台帳（登録のシナリオ。更新でなければ null）。 */
  readonly ledgerScenarioId: string | null;
}

/**
 * 書き込みの段の対象（チェックした画面ごと。シナリオの順）: 承認した登録のシナリオと、その台帳に結ぶ承認した更新のシナリオ（最初の 1 つ）。承認の有効さ
 * （改訂・認証の設定・期限など）は、段の前の許可の発行が今の判定で確かめる（ここでは決めない。無効なら、その画面は送らない）。
 */
export const chainWriteTargetsOf = (scenarios: readonly ChainWriteScenarioFact[]): readonly ChainWriteTarget[] =>
  Object.freeze(scenarios.filter(({ kind, approved }) => kind === 'CREATE' && approved).map(({ scenarioId }) => Object.freeze({
    createScenarioId: scenarioId,
    updateScenarioId: scenarios.find((item) => item.kind === 'UPDATE' && item.approved && item.ledgerScenarioId === scenarioId)?.scenarioId ?? null,
  })));

/** 書き込みの段 1 つ（対象の位置と、登録か更新か）。 */
export interface ChainWriteStep {
  readonly targetIndex: number;
  readonly kind: 'CREATE' | 'UPDATE';
}

/**
 * 次の書き込みの段（なければ null）。登録の後は、同じ対象の更新（更新のシナリオがあり、登録が照合まで済んで番号が取れたときだけ）、ほかは次の対象の登録。
 * 1 つの画面につき、登録 1 件と更新 1 件まで（同じ段を 2 回返さない。送り直さない）。
 */
export const nextChainWriteStepOf = (
  targets: readonly ChainWriteTarget[],
  last: { readonly step: ChainWriteStep; readonly createRecordId: string | null } | null,
): ChainWriteStep | null => {
  if (last === null) {
    return targets.length > 0 ? { targetIndex: 0, kind: 'CREATE' } : null;
  }
  const target = targets[last.step.targetIndex];
  if (last.step.kind === 'CREATE' && target?.updateScenarioId !== null && target !== undefined && last.createRecordId !== null) {
    return { targetIndex: last.step.targetIndex, kind: 'UPDATE' };
  }
  const next = last.step.targetIndex + 1;
  return next < targets.length ? { targetIndex: next, kind: 'CREATE' } : null;
};

/** 書き込みの段の後に、残りの書き込みを続けるかの判定の入力。 */
export interface ChainWriteAdvanceInput {
  readonly stopRequested: boolean;
  /** 書き込みの結果（締めた結果。締めていなければ null）。 */
  readonly result: string | null;
  /** 段の Run Status（Run を実行しなかったなら null）。 */
  readonly stageRunStatus: RunStatus | null;
  readonly sessionLost: boolean;
  readonly profileRevisionUnchanged: boolean;
}

/** 結果が分からない書き込みの結果（`ActionResult` の `UNKNOWN`）。 */
const UNKNOWN_WRITE_RESULT = 'UNKNOWN';

/**
 * 書き込みの段の後に、残りの書き込みを続けるか（D8'・R2）: 止める要求、安全の違反（Run の状態）、ログインの切れ（ログインし直さない）、改訂の変化、結果が
 * 分からない（締めていない・`UNKNOWN`）なら止める。照合できなかった・送らなかった・失敗した画面の後は、次の画面へ進む（その画面の結果は行に出る）。
 */
export const chainWriteAdvanceDecisionOf = (input: ChainWriteAdvanceInput): ChainAdvanceDecision => {
  if (input.stopRequested) {
    return STOP('USER_STOPPED');
  }
  if (input.stageRunStatus === 'ABORTED_BY_SAFETY') {
    return STOP('SAFETY_VIOLATION');
  }
  if (input.sessionLost) {
    return STOP('SESSION_LOST');
  }
  if (!input.profileRevisionUnchanged) {
    return STOP('PROFILE_REVISION_CHANGED');
  }
  return input.result === null || input.result === UNKNOWN_WRITE_RESULT ? STOP('WRITE_RESULT_UNKNOWN') : CONTINUE;
};

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
  /** OP-2: 行った書き込みの段のジョブ（登録・更新。行った順。なければ空）。点検の要点の 1 行と、行ごとの結果に使う。 */
  readonly writeStageJobIds: readonly string[];
}
