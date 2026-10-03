import {
  PAGE_AUDIT_STAGES,
  PAGE_AUDIT_STATUSES,
  type IncompleteReason,
  type IncompleteReasonCode,
  type PageAuditStage,
  type PageAuditStatus,
  type RunStatus,
  type ViewportAuditStatus,
} from './contracts.js';
import { safeErrorMessage } from './errors.js';
import { isNonNegativeSafeInteger } from './guards.js';
import { MAX_ERROR_MESSAGE_LENGTH } from './limits.js';
import type { ArtifactSchemaName } from './schema-validator.js';

export interface RunStatusInput {
  readonly preflightFailed: boolean;
  /** 安全不変条件の違反の件数。0以上の安全な整数でない場合は、違反がないと証明できないので `ABORTED_BY_SAFETY` にする。 */
  readonly safetyInvariantViolations: number;
  /** Safety Ledger の記録が上限で不完全になったか（`SafetyLedgerSnapshot.recordLimits.truncated`）。安全違反ではない。 */
  readonly safetyLedgerTruncated: boolean;
  /** 未完了の理由（理由のコードと補足）。1件でもあれば、内容にかかわらず `COMPLETE` にしない。 */
  readonly incompleteReasons: readonly IncompleteReason[];
  readonly unhandledFailures: number;
  readonly crawlLimitReached: boolean;
  readonly requiredArtifactsValid: boolean;
  readonly executionComplete: boolean;
  readonly skippedRequiredWork: number;
  readonly blockedRequiredWork: number;
  readonly timedOutRequiredWork: number;
  readonly notObservedRequiredWork: number;
  readonly notVerifiedRequiredWork: number;
  readonly failedRequiredWork: number;
  readonly incompleteCollectorCount: number;
  readonly findingCount?: number;
}

const isValidRunStatusInput = (input: RunStatusInput): boolean =>
  typeof input.preflightFailed === 'boolean'
  && typeof input.safetyLedgerTruncated === 'boolean'
  // 要素の形は確かめない。要素が1件でもあれば、形が正しくても不正でも `PARTIAL` になり、結果が変わらないため。
  && Array.isArray(input.incompleteReasons)
  && isNonNegativeSafeInteger(input.unhandledFailures)
  && typeof input.crawlLimitReached === 'boolean'
  && typeof input.requiredArtifactsValid === 'boolean'
  && typeof input.executionComplete === 'boolean'
  && isNonNegativeSafeInteger(input.skippedRequiredWork)
  && isNonNegativeSafeInteger(input.blockedRequiredWork)
  && isNonNegativeSafeInteger(input.timedOutRequiredWork)
  && isNonNegativeSafeInteger(input.notObservedRequiredWork)
  && isNonNegativeSafeInteger(input.notVerifiedRequiredWork)
  && isNonNegativeSafeInteger(input.failedRequiredWork)
  && isNonNegativeSafeInteger(input.incompleteCollectorCount);

export const deriveRunStatus = (input: RunStatusInput): RunStatus => {
  // 違反の判定（違反の件数が1以上）を、PREFLIGHT の失敗の判定より先に行う。PREFLIGHT の Guard の初期化の失敗などで違反が
  // 記録された場合は、`ABORTED_BY_SAFETY` にする（Task 14〜17 の設計書 5.6.7。上位の設計書 9.5）。
  const safetyInvariantViolations: unknown = input?.safetyInvariantViolations;
  const validViolationCount = isNonNegativeSafeInteger(safetyInvariantViolations);
  if (validViolationCount && safetyInvariantViolations > 0) {
    return 'ABORTED_BY_SAFETY';
  }

  if (input?.preflightFailed === true) {
    return 'FAILED';
  }

  // 件数が不正な場合は、違反がないと証明できないので `ABORTED_BY_SAFETY` にする（PREFLIGHT の失敗は、上で `FAILED` にしている）。
  if (!validViolationCount) {
    return 'ABORTED_BY_SAFETY';
  }

  if (!isValidRunStatusInput(input)) {
    return 'PARTIAL';
  }

  if (
    input.executionComplete !== true
    || input.safetyLedgerTruncated
    || input.incompleteReasons.length > 0
    || input.unhandledFailures > 0
    || input.crawlLimitReached
    || !input.requiredArtifactsValid
    || input.skippedRequiredWork > 0
    || input.blockedRequiredWork > 0
    || input.timedOutRequiredWork > 0
    || input.notObservedRequiredWork > 0
    || input.notVerifiedRequiredWork > 0
    || input.failedRequiredWork > 0
    || input.incompleteCollectorCount > 0
  ) {
    return 'PARTIAL';
  }

  return 'COMPLETE';
};


/**
 * ビューポートの状態から、ページ全体の状態を導く（Task 14〜17 の設計書 4.2、4.5.9）。最も悪いものを取る（`FAILED` ＞ `PARTIAL` ＞ `AUDITED`）。
 * `SKIPPED`（そのビューポートを監査しなかった）は、次のように扱う。
 * - すべてのビューポートが `SKIPPED` なら、ページも `SKIPPED` にする。
 * - 一部のビューポートだけが `SKIPPED` なら、ページの監査を終えていないので、ほかが `AUDITED` でも `PARTIAL` にする。
 *   ほかに `FAILED` があれば `FAILED` にする。
 * 空の一覧と、閉じた一覧にない状態は、推測せずに `RangeError` を投げる。
 */
export const derivePageAuditStatus = (viewportStatuses: readonly ViewportAuditStatus[]): PageAuditStatus => {
  if (viewportStatuses.length === 0) {
    throw new RangeError('page audit status needs at least one viewport status');
  }
  for (const status of viewportStatuses) {
    if (!(PAGE_AUDIT_STATUSES as readonly string[]).includes(status)) {
      throw new RangeError(`unsupported viewport audit status: ${String(status)}`);
    }
  }
  if (viewportStatuses.includes('FAILED')) {
    return 'FAILED';
  }
  if (viewportStatuses.every((status) => status === 'SKIPPED')) {
    return 'SKIPPED';
  }
  if (viewportStatuses.includes('PARTIAL') || viewportStatuses.includes('SKIPPED')) {
    return 'PARTIAL';
  }
  return 'AUDITED';
};

/**
 * collector が PARTIAL を返したか、例外を投げた場合の未完了の理由（Task 14〜17 の設計書 4.5.5）。
 * コードは `COLLECTOR_INCOMPLETE`、`detail` は `<段階>:<理由>`。`<理由>` は、collector の PARTIAL の理由か、
 * 例外のときは `pageFailureReason(page)` の値（Interaction の段階では `budget`、`cleanup` なども使う）。
 * 閉じた一覧にない段階と、空の理由は `RangeError` を投げる。結果は凍結する。
 */
export const collectorIncompleteReason = (stage: PageAuditStage, reason: string): IncompleteReason => {
  if (!(PAGE_AUDIT_STAGES as readonly string[]).includes(stage)) {
    throw new RangeError(`unsupported page audit stage: ${String(stage)}`);
  }
  if (typeof reason !== 'string' || reason.length === 0) {
    throw new RangeError('collector incomplete reason must be a non-empty string');
  }
  return Object.freeze({ code: 'COLLECTOR_INCOMPLETE', detail: `${stage}:${reason}` });
};

/**
 * `UNHANDLED_FAILURE` の理由（Task 14〜17 の設計書 4.5.5、5.6.1。CC-021。組み立ては、ここだけで行う）。
 * `detail` は `<場面>:<メッセージ>`。メッセージは `safeErrorMessage(error, MAX_ERROR_MESSAGE_LENGTH)` で、上限
 * （`MAX_ERROR_MESSAGE_LENGTH`）付きの文字列にする。場面は切り詰めない。制御文字は、取り除かずにそのまま残す
 * （Page Auditor と Run Coordinator の2か所の実装が、どちらもこの扱いだった）。
 * 空の場面は `RangeError` を投げる。結果は凍結する。
 */
export const unhandledFailureReason = (scene: string, error: unknown): IncompleteReason => {
  if (typeof scene !== 'string' || scene.length === 0) {
    throw new RangeError('unhandled failure scene must be a non-empty string');
  }
  return Object.freeze({ code: 'UNHANDLED_FAILURE', detail: `${scene}:${safeErrorMessage(error, MAX_ERROR_MESSAGE_LENGTH)}` });
};

/** Rule の評価の失敗（`src/audit/rule-engine.ts` の `RuleEvaluationFailure` と同じ形。core から audit に依存しないため、形で受け取る）。 */
export interface RuleEvaluationFailureLike {
  readonly code: Extract<IncompleteReasonCode, 'RULE_EVALUATION_FAILED'>;
  readonly ruleId: string;
  /** 失敗の内容。Rule Engine が上限（`MAX_ERROR_MESSAGE_LENGTH`）付きにしたもの。 */
  readonly message: string;
}

/**
 * Rule の評価の失敗の理由（Page rule と Cross-page rule。CC-021。組み立ては、ここだけで行う）。
 * コードは失敗のコード（`RULE_EVALUATION_FAILED`）で、`detail` は `<ruleId>:<メッセージ>`。メッセージは、そのまま使う。結果は凍結する。
 */
export const ruleEvaluationFailureReason = (failure: RuleEvaluationFailureLike): IncompleteReason =>
  Object.freeze({ code: failure.code, detail: `${failure.ruleId}:${failure.message}` });

/**
 * スキーマに合わない artifact の理由（Task 14〜17 の設計書 6.1.1、R15d の判断6。CC-022。組み立ては、ここだけで行う）。
 * コードは `REQUIRED_ARTIFACT_INVALID`、`detail` は `<スキーマ>:<ID>:<最初の誤り>`（誤りがなければ `invalid`）。`detail` の全体を
 * `safeErrorMessage` で上限（`MAX_ERROR_MESSAGE_LENGTH`）付きにする。Run Coordinator と `ArtifactWriter` が同じ artifact に
 * 同じ理由を作るので、コードと `detail` で重複を除ける。結果は凍結する。
 */
export const requiredArtifactInvalidReason = (
  schema: ArtifactSchemaName,
  id: string,
  errors: readonly string[],
): IncompleteReason =>
  Object.freeze({
    code: 'REQUIRED_ARTIFACT_INVALID',
    detail: safeErrorMessage(`${schema}:${id}:${errors[0] ?? 'invalid'}`, MAX_ERROR_MESSAGE_LENGTH),
  });
