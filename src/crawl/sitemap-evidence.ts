import type { EvidenceRecordFor } from '../core/contracts.js';
import type { SitemapEvidence } from '../core/evidence-types.js';

/**
 * sitemap.xml の `metadata` の Evidence の記録から、Cross-page rule に渡す sitemap の Evidence を作る
 * （Task 14〜17 の設計書 5.6.2）。この変換は、ここだけで行う。
 * - `evidenceId` は、記録の ID をそのまま使う（sitemap の Finding は、この Evidence を参照する）。
 * - `urls` は、記録の `sitemapUrls`（`<loc>` の値を正規化した値）の写し。
 * - `truncated` は、記録の `sitemapUrlsTruncated`。URL は切り詰める前の本文から取り出すので、本文だけを切り詰めた
 *   （`textTruncated`）ことでは、切り詰めとみなさない。
 *
 * 次の場合は、判定に使える sitemap がないので `null` を返す（Cross-page rule は sitemap の Rule を評価しない）。
 * - robots.txt の記録
 * - 取得の結果が `OK` でない（ない、または取得できなかった）
 * - URL を取り出せなかった（`sitemapUrls` が `null`）
 *
 * 結果は凍結する。
 */
export function sitemapEvidenceFromMetadata(record: EvidenceRecordFor<'metadata'>): SitemapEvidence | null {
  const { payload } = record;
  if (payload.kind !== 'SITEMAP_XML' || payload.outcome !== 'OK' || payload.sitemapUrls === null) {
    return null;
  }
  return Object.freeze({
    evidenceId: record.evidenceId,
    urls: Object.freeze([...payload.sitemapUrls]),
    truncated: payload.sitemapUrlsTruncated,
  });
}
