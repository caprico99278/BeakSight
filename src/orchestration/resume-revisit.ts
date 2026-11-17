/**
 * EV-5（設計書 `doc/design/2026-11-16-beaksight-finding-evidence-design.md` 2 章のユーザーの判断・3.5）: 時間切れで止まった Run を続けるとき、再開の列の先に置く
 * 画面の決まりの唯一の owner。Run Coordinator は、保存から戻したページごとに `pageRevisitFactOf` を 1 回だけ作り、`revisitOrderOf` の順に読み直してから、まだ
 * 見ていない画面へ進む。
 * - 一部だけ終わった画面: Run の時間の上限で止めた段・ビューポートの理由（`MAX_RUNTIME_REACHED`、段の `<段>:MAX_RUNTIME_REACHED`、期限切れ
 *   `DEADLINE_EXCEEDED`。段の期限は Run の時間の上限より後にしない）があるページ。
 * - 証拠の足りない指摘の確かめ: 画像に対象が写っていない（`TARGET_NOT_IN_IMAGE`）・対象まで動かして撮れなかった（`NOT_OPERATED`）指摘のあるページ。追加の証拠は
 *   同じ読み込みの中で取りきる作りなので、そのページを読み直す。準備の終わらない画面（`PAGE_NOT_READY`）は、読み直しで取る証拠ではないので数えない。
 * - 読み直しの終わり（構造の事実。回数で決めない）: 読み直した後も確かめを待つ指摘が減らなくなったら（または 0 になったら）終える（`readAgainAfterRevisit`）。
 * 読み込みは、今の移動の間隔の守り（Run Coordinator の pacer）の中で数える。
 */
import type { IncompleteReason, PageAuditResult, RunExecutionEndReason } from '../core/contracts.js';
import { isUncollectedAuditStatus } from '../core/status.js';
import { findingHoldReasonsOnPage, type FindingHoldReason } from '../core/finding-image-regions.js';

/** 読み直しで取りに行く保留の理由（画像に写っていない・動かして撮れなかった）。 */
const REVISIT_HOLD_REASONS: ReadonlySet<FindingHoldReason> = new Set<FindingHoldReason>(['TARGET_NOT_IN_IMAGE', 'NOT_OPERATED']);

/** Run の時間の上限で止めた理由のコードと、段の理由（`COLLECTOR_INCOMPLETE` の `<段>:<理由>`）の理由。 */
const RUN_TIME_LIMIT_REASONS: ReadonlySet<string> = new Set(['MAX_RUNTIME_REACHED', 'DEADLINE_EXCEEDED']);

/** 1 つのページの、再開の列の先に置くかの事実。 */
export interface PageRevisitFact {
  /** Run の時間の上限で、一部だけ終わった（段かビューポートを止めた）。 */
  readonly cutByRunTimeLimit: boolean;
  /** 読み直しで取りに行く理由で、確かめを待つ指摘の数。 */
  readonly heldFindingCount: number;
  /** REV-EV5 の I-1: 見た（`SKIPPED` でない）ビューポートの数。 */
  readonly collectedViewportCount: number;
}

const isRunTimeLimitReason = ({ code, detail }: IncompleteReason): boolean =>
  RUN_TIME_LIMIT_REASONS.has(code)
  || (code === 'COLLECTOR_INCOMPLETE' && detail !== null && RUN_TIME_LIMIT_REASONS.has(detail.slice(detail.lastIndexOf(':') + 1)));

/** ページの結果から、再開の列の先に置くかの事実を作る（入力を変えない）。 */
export function pageRevisitFactOf(page: PageAuditResult): PageRevisitFact {
  const reasons = [...page.incompleteReasons, ...Object.values(page.viewports).flatMap((viewport) => viewport.incompleteReasons)];
  return {
    cutByRunTimeLimit: reasons.some(isRunTimeLimitReason),
    heldFindingCount: findingHoldReasonsOnPage(page).filter((reason) => reason !== null && REVISIT_HOLD_REASONS.has(reason)).length,
    collectedViewportCount: Object.values(page.viewports).filter(({ status }) => !isUncollectedAuditStatus(status)).length,
  };
}

/**
 * REV-EV5 の I-1: 読み直しの結果を採るか。読み直しが時間切れで途中になり、前の結果より見たビューポートが少ないときは採らない（サイトの不調のときと同じく捨て、前の
 * 結果を残す。読み直しを終えたページにも入れないので、次の時間切れの再開で読み直す）。
 */
export const keepsRevisit = (before: PageRevisitFact, after: PageRevisitFact): boolean =>
  !(after.cutByRunTimeLimit && after.collectedViewportCount < before.collectedViewportCount);

/**
 * 時間切れで止まった Run を続ける再開か（保存の実行の記録のどれかが、実行時間の上限で停止で終わった）。REV-EV5 の I-2: 時間切れの後の再開が別の理由（サイトの
 * 不調・止める印）で止まっても、次の再開で残りを読み直す（読み直しを終えたページは `revisitedPageIds` で除く）。時間切れのない Run（止める印だけで止めた Run など）
 * では、終えたページを読み直さない。
 */
export const resumesAfterRunTimeLimit = (executions: readonly { readonly endReason: RunExecutionEndReason | null }[]): boolean =>
  executions.some(({ endReason }) => endReason === 'STOPPED_BY_RUNTIME_LIMIT');

/** 読み直すページか（一部だけ終わったか、確かめを待つ指摘がある）。 */
export const needsRevisit = (fact: PageRevisitFact): boolean => fact.cutByRunTimeLimit || fact.heldFindingCount > 0;

/** 再開の列の先に置くページの順（一部だけ終わったページが先、確かめを待つ指摘のあるページが後。それぞれの中は入力の順）。読み直さないページは除く。 */
export function revisitOrderOf<T extends { readonly fact: PageRevisitFact }>(pages: readonly T[]): readonly T[] {
  return [
    ...pages.filter(({ fact }) => fact.cutByRunTimeLimit),
    ...pages.filter(({ fact }) => !fact.cutByRunTimeLimit && fact.heldFindingCount > 0),
  ];
}

/**
 * 読み直した後に、もう 1 回読み直すか。また一部だけで終わったら読み直さない（時間の上限は、次の再開で続ける）。確かめを待つ指摘が残り、前より減った（前が一部だけ
 * なら、比べる数がないので残っていれば）ときだけ読み直す。
 */
export function readAgainAfterRevisit(before: PageRevisitFact, after: PageRevisitFact): boolean {
  if (after.cutByRunTimeLimit || after.heldFindingCount === 0) {
    return false;
  }
  return before.cutByRunTimeLimit || after.heldFindingCount < before.heldFindingCount;
}
