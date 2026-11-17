/**
 * COV-4 の区切り 3（網羅の設計書 3.2 の 6。設計者の判断 2026-11-10）: 見るだけの点検の操作で開いた状態の監査の、純粋な部品。
 * - 開いた状態の指摘は、開いた状態の記録だけで Rule を評価して作る。そのうち、開く前の画面の指摘と fingerprint が同じもの（開く前からある問題）は除き、
 *   除いた数を数える（消えたように見えないよう、操作の記録の `openedState.duplicateFindingCount` に残し、バンドルの summary に出す）。
 */
import type { Finding } from '../core/contracts.js';

/** 開いた状態の指摘のうち、開く前の画面になかったもの（開いた状態の順）と、除いた数。 */
export interface OpenedStateFindings {
  readonly kept: readonly Finding[];
  readonly droppedCount: number;
}

/** 開いた状態の指摘から、開く前の画面と fingerprint が同じものを除く（判定はここだけ）。 */
export function findingsNotInBase(base: readonly Finding[], opened: readonly Finding[]): OpenedStateFindings {
  const seen = new Set(base.map(({ fingerprint }) => fingerprint));
  const kept = opened.filter(({ fingerprint }) => !seen.has(fingerprint));
  return { kept, droppedCount: opened.length - kept.length };
}
