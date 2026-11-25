/**
 * AUD-3（設計書 `doc/design/2026-11-19-beaksight-audit-result-review-fixes-design.md` 6.2 の 3）: フォーカスの確かめの指摘と項目の結びの唯一の所。Rule（同一性の
 * 要素に番号を書く）・指摘の画像と領域（`finding-image-regions.ts`）・表示用モデル（確信度の根拠）が、同じ番号で項目を引く。純粋な関数だけ。
 */
import type { FindingGroupingKeyRecord } from './contracts.js';
import type { FocusCheckEvidence, FocusCheckItemEvidence } from './evidence-types.js';

/**
 * 指摘と項目を結ぶ鍵の名前（値は、フォーカスの確かめの Evidence の `items` の中の位置。0 から）。REV-AUD3 の I-2: 結びだけに使い、fingerprint と候補群の鍵には
 * 入れない（Rule の下書きの `linkKeys`。名前の一覧は `src/audit/finding-grouping-keys.ts` の `LINK_KEY_FIELD_NAMES`）。
 */
export const FOCUS_ITEM_LINK_KEY_NAME = 'focusItem';

/**
 * 指摘の項目（項目の番号で引く。番号のない前の版の指摘は、selector が 1 つの項目にだけ当たるときだけ、その項目）。引けなければ `undefined`（同じ Evidence の
 * 別の項目を根拠にしない）。
 */
export function focusCheckItemOfFinding(keys: readonly FindingGroupingKeyRecord[], payload: FocusCheckEvidence): FocusCheckItemEvidence | undefined {
  const number = keys.find(({ name }) => name === FOCUS_ITEM_LINK_KEY_NAME)?.value;
  if (number !== undefined) {
    return /^\d+$/u.test(number) ? payload.items[Number(number)] : undefined;
  }
  const selector = keys.find(({ name }) => name === 'selector')?.value;
  const matched = payload.items.filter((item) => item.selector === selector);
  return matched.length === 1 ? matched[0] : undefined;
}
