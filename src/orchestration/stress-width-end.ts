/**
 * 幅の走査の 1 つの幅の終わり方（page-auditor の `#sweepStressWidths` が使う。判定は、ここだけ）。
 * - B（C18i。RC18b の N2）: 幅の結果が `PAGE_CLOSED` で、違反が記録されていれば、その幅の理由を `SAFETY_VIOLATION_ABORT` にする（Guard が違反で、その幅の
 *   Context を閉じた）。
 * - C（DEF-245 の続き）: 幅の page が外部スキームへ移ろうとした記録が入るか、文書が消えた（閉じた・誤りの画面 `chrome-error://` に替わった。発見の側と
 *   同じ唯一の判定 `documentGoneOf`）なら、その幅を使うのをやめる（幅を終えて次へ進む）。Playwright の 1 手には期限を付けない（事実で決める）。
 * - SWR: 大きさを変えて測った幅と、読み込み直して測った幅の照らし合わせ（`stressLayoutFactKeys`・`sameStressLayoutFacts`）。
 */
import type { Page } from 'playwright';
import type { IncompleteReasonCode } from '../core/contracts.js';
import type { FocusCheckEvidence, LayoutEvidence } from '../core/evidence-types.js';
import { documentGoneOf } from '../discovery/discover-page.js';
import type { SafetyLedgerSnapshot } from '../safety/safety-ledger.js';

const SAFETY_VIOLATION_ABORT: Extract<IncompleteReasonCode, 'SAFETY_VIOLATION_ABORT'> = 'SAFETY_VIOLATION_ABORT';
const PAGE_CLOSED: Extract<IncompleteReasonCode, 'PAGE_CLOSED'> = 'PAGE_CLOSED';

/**
 * DEF-247: 幅の session を閉じる口を、1 回だけ閉じる形にする（何度呼んでも、最初の閉じる処理の結果を返す）。幅を早く終える所（C・見張りが終えた幅）と、collector の
 * 後片付けの両方が呼ぶ。閉じるのは、その幅の session の口（factory が持ち主として Context ごと閉じる。page だけを閉じると、Guard が印のない session の切れを
 * 違反 `CDP_SESSION_DETACHED` にする）。
 */
export function stressWidthSessionCloser(close: () => Promise<void>): () => Promise<void> {
  let closing: Promise<void> | null = null;
  return () => {
    closing ??= close();
    return closing;
  };
}

/** B: 幅の結果の理由（`PAGE_CLOSED` で違反が記録されていれば `SAFETY_VIOLATION_ABORT`。ほかはそのまま）。 */
export function stressWidthIncompleteReasonOf<TReason extends string>(
  reason: TReason,
  violationRecorded: boolean,
): TReason | typeof SAFETY_VIOLATION_ABORT {
  return reason === PAGE_CLOSED && violationRecorded ? SAFETY_VIOLATION_ABORT : reason;
}

/** SWR: 照らし合わせる幅の測り（layout と、その幅のフォーカスの確かめ。読めなければ `null`）。 */
export interface StressWidthFacts {
  readonly layout: LayoutEvidence;
  readonly focus: FocusCheckEvidence | null;
}

/**
 * SWR（設計者の判断 2026-11-17 の 1）: 幅の layout の、指摘になりうる事実の鍵の集合（判定はここだけ）。大きさを変えて測った幅と、読み込み直して測った幅の
 * 照らし合わせに使う（Rule の指摘ではなく Evidence の事実で比べる。位置や大きさは鍵に入れない）。
 * - 横のはみ出し（文書の横のはみ出しと、画面の外へ出た要素）、要素どうしの重なりの組、固定の枠と見出しの重なりの組、見えている固定の枠、見切れた文字、
 *   フォーカスしても隠れた要素。
 */
export function stressLayoutFactKeys(layout: LayoutEvidence, focus: FocusCheckEvidence | null): ReadonlySet<string> {
  const keys = new Set<string>();
  if (layout.document.horizontalOverflowPx > 0) {
    keys.add('DOCUMENT_OVERFLOW');
  }
  for (const { selector } of layout.boxesOutsideViewport) {
    keys.add(`OUTSIDE_VIEWPORT ${selector}`);
  }
  for (const { first, second } of layout.elementOverlaps) {
    keys.add(`ELEMENT_OVERLAP ${first.selector} ${second.selector}`);
  }
  for (const { overlaySelector, headingSelector } of layout.fixedHeadingOverlaps) {
    keys.add(`FIXED_HEADING_OVERLAP ${overlaySelector} ${headingSelector}`);
  }
  for (const fixed of layout.fixedElements) {
    if (fixed.visibility.visible && fixed.viewportIntersectionArea > 0) {
      keys.add(`FIXED_ELEMENT ${fixed.selector}`);
    }
  }
  for (const { selector } of layout.clippedText) {
    keys.add(`CLIPPED_TEXT ${selector}`);
  }
  for (const item of focus?.items ?? []) {
    if (!item.visibleAfterFocus || !item.hitAfterFocus) {
      keys.add(`FOCUS_HIDDEN ${item.selector}`);
    }
  }
  return keys;
}

/** SWR: 2 つの幅の測りの事実の鍵の集合が同じか。 */
export function sameStressLayoutFacts(left: StressWidthFacts, right: StressWidthFacts): boolean {
  const leftKeys = stressLayoutFactKeys(left.layout, left.focus);
  const rightKeys = stressLayoutFactKeys(right.layout, right.focus);
  return leftKeys.size === rightKeys.size && [...leftKeys].every((key) => rightKeys.has(key));
}

/** 監査の途中で、page を使うのをやめた原因（main frame の外部スキームへの移動の記録・文書の消失）。 */
export type AuditDocumentLeftCause = 'EXTERNAL_SCHEME' | 'DOCUMENT_GONE';

/**
 * C と DEF-250 の c（幅の走査と、Desktop・Mobile の Passive の page の共通の判定。同じ意味の判定を 2 か所に書かない）: page を使うのをやめる原因。使えるなら
 * `null`。main frame の外部スキームへの移動の記録は、いつでも見る（子の frame の記録では、page は使える）。文書が消えたか（`documentGoneOf`）は、その読み込みが
 * 終わった後（`navigated`）だけ見る（読み込む前の page は `about:blank` で、http(s) の場所がない）。
 */
export function auditDocumentLeftCause(page: Page, snapshots: readonly SafetyLedgerSnapshot[], navigated: boolean): AuditDocumentLeftCause | null {
  if (snapshots.some((snapshot) => snapshot.externalSchemeNavigations.some(({ frame }) => frame === 'MAIN'))) {
    return 'EXTERNAL_SCHEME';
  }
  return navigated && documentGoneOf(page) ? 'DOCUMENT_GONE' : null;
}
