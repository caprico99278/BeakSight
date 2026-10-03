import type { Page } from 'playwright';
import type { PartialFailureReason } from '../core/contracts.js';

/** ブラウザ内の処理に失敗したページについて、記録する失敗の理由。 */
export type PageFailureReason = Extract<PartialFailureReason, 'PAGE_CLOSED' | 'EVALUATION_FAILED'>;

/**
 * ブラウザ内の処理（`page.evaluate` や移動）が失敗したときの理由を、ページの状態から決める。
 * ページが閉じていれば `PAGE_CLOSED`、そうでなければ `EVALUATION_FAILED`。
 * `isClosed` が例外を投げた場合は、ページの状態を確かめられないので `EVALUATION_FAILED` とする。
 */
export function pageFailureReason(page: Pick<Page, 'isClosed'>): PageFailureReason {
  try {
    return page.isClosed() ? 'PAGE_CLOSED' : 'EVALUATION_FAILED';
  } catch {
    return 'EVALUATION_FAILED';
  }
}
