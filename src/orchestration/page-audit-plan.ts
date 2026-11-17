/**
 * PageAuditor の段の順（RB-10。再構築の設計書 2 章 1・3 章）。次の読み込み（ビューポート・幅の走査の幅・Interaction の候補）を始めない条件の順と、閉じる前に
 * 前の画面を見せたまま待つかを、ここだけで決める。ページには触れない。
 * - 違反の確かめ（`violationRecorded`）は、止めたことを記録する。時刻の読み（`runTimeLimitPassed`）とセッションの切れの確かめも、呼ぶ時点に意味がある。
 *   そのため関数で受け、決まった順に呼び、当たったら後のものを呼ばない（前の if の並びと同じ呼び方）。
 * - 始めない条件に当たった読み込みでは、読み込みの間隔の待ち（`beforeNavigation`）を呼ばない（DEF-209）。呼ぶ側は、この関数の答えを見てから待つ。
 */
import type { IncompleteReason, IncompleteReasonCode } from '../core/contracts.js';
import { AUTH_SESSION_LOST_SKIP_REASON } from './authenticated-run.js';
import { SITE_UNAVAILABLE_SKIP_REASON } from './site-availability.js';

/** 違反を検出したため、始めなかったページとビューポートの理由（`detail` は `null`。C18f）。Run Coordinator も使う。 */
export const SAFETY_VIOLATION_ABORT_REASON: IncompleteReason = Object.freeze({ code: 'SAFETY_VIOLATION_ABORT' satisfies IncompleteReasonCode, detail: null });

/** L0: Run の時間の上限を過ぎたため、始めなかったビューポートの理由。 */
export const RUN_TIME_LIMIT_SKIP_REASON: IncompleteReason = Object.freeze({ code: 'MAX_RUNTIME_REACHED' satisfies IncompleteReasonCode, detail: null });

/** DEF-225: 開くとファイルのダウンロードになったビューポートの理由。同じページの次のビューポートも、この理由で始めない（同じ URL を読み直さない）。 */
export const DOWNLOAD_RESPONSE_REASON: IncompleteReason = Object.freeze({ code: 'DOWNLOAD_RESPONSE' satisfies IncompleteReasonCode, detail: null });

/**
 * 次のビューポートを始めない理由（始めるなら `null`）。順は、違反 → 不調 → セッションの切れ → ダウンロード → Run の時間の上限。最初のビューポートの前には、
 * 違反と時間の上限を確かめない（ページを始めるかは Run Coordinator が決める）。
 */
export function viewportSkipReasonOf(facts: {
  readonly earlierViewports: number;
  readonly violationRecorded: () => boolean;
  readonly siteUnavailable: boolean;
  readonly sessionLost: boolean;
  readonly downloadResponse: boolean;
  readonly runTimeLimitPassed: () => boolean;
}): IncompleteReason | null {
  const later = facts.earlierViewports > 0;
  if (later && facts.violationRecorded()) return SAFETY_VIOLATION_ABORT_REASON;
  if (facts.siteUnavailable) return SITE_UNAVAILABLE_SKIP_REASON;
  if (facts.sessionLost) return AUTH_SESSION_LOST_SKIP_REASON;
  if (facts.downloadResponse) return DOWNLOAD_RESPONSE_REASON;
  if (later && facts.runTimeLimitPassed()) return RUN_TIME_LIMIT_SKIP_REASON;
  return null;
}

/** 幅の走査の次の幅を始めない理由（始めるなら `null`）。順は、違反 → 不調 → セッションの切れ（確かめ直しを含む）。 */
export function stressWidthAbortOf(facts: {
  readonly violationRecorded: () => boolean;
  readonly siteUnavailable: boolean;
  readonly sessionLost: () => boolean;
}): 'SAFETY_VIOLATION_ABORT' | 'SITE_UNAVAILABLE' | 'AUTH_SESSION_LOST' | null {
  if (facts.violationRecorded()) return 'SAFETY_VIOLATION_ABORT';
  if (facts.siteUnavailable) return 'SITE_UNAVAILABLE';
  if (facts.sessionLost()) return 'AUTH_SESSION_LOST';
  return null;
}

/** Interaction の次の候補の扱い。`END` は理由なしで終える（段が止まった）。`STOP` は、残りの候補の数を付けて理由を残して終える。 */
export type InteractionCandidateStep =
  | { readonly kind: 'AUDIT' }
  | { readonly kind: 'END' }
  | { readonly kind: 'STOP'; readonly reason: 'SAFETY_VIOLATION_ABORT' | 'SITE_UNAVAILABLE' | 'limit' };

/**
 * Interaction の次の候補（主の画面の候補と、開いた状態の中の候補で共通）。順は、段が止まった → 違反 → 不調 → 1 ページの上限（`index` は監査を始めた候補の数）。
 */
export function interactionCandidateStepOf(facts: {
  readonly stopped: boolean;
  readonly violationRecorded: () => boolean;
  readonly siteUnavailable: boolean;
  readonly index: number;
  readonly maxInteractionsPerPage: number | undefined;
}): InteractionCandidateStep {
  if (facts.stopped) return { kind: 'END' };
  if (facts.violationRecorded()) return { kind: 'STOP', reason: 'SAFETY_VIOLATION_ABORT' };
  if (facts.siteUnavailable) return { kind: 'STOP', reason: 'SITE_UNAVAILABLE' };
  if (facts.maxInteractionsPerPage !== undefined && facts.index >= facts.maxInteractionsPerPage) return { kind: 'STOP', reason: 'limit' };
  return { kind: 'AUDIT' };
}

/**
 * DEF-236: 次の読み込みを始めうるか。不調・セッションの切れ・Run の時間の上限・違反（止めたことを記録しない確かめ）の後は、始めない。
 */
export function nextLoadMayStart(facts: {
  readonly siteUnavailable: boolean;
  readonly sessionLost: boolean;
  readonly runTimeLimitPassed: () => boolean;
  readonly violationDetected: () => boolean;
}): boolean {
  return !facts.siteUnavailable && !facts.sessionLost && !facts.runTimeLimitPassed() && !facts.violationDetected();
}

/**
 * DEF-236: ビューポートを閉じる前に、前の画面を見せたまま読み込みの間隔を待つか。開いた page で証拠を集め終え、crash していないときだけ、ダウンロードで
 * ない → 次を始めうる → 後に読み込みが続く、の順に確かめる（後に続くかは Run Coordinator に 1 回だけ聞くので、最後）。
 */
export function waitsWithPageShown(facts: {
  readonly evidenceSettled: boolean;
  readonly crashed: boolean;
  readonly downloadBlocked: () => boolean;
  readonly nextLoadMayStart: () => boolean;
  readonly laterLoadFollows: () => boolean;
}): boolean {
  return facts.evidenceSettled && !facts.crashed
    && !facts.downloadBlocked() && facts.nextLoadMayStart() && facts.laterLoadFollows();
}
