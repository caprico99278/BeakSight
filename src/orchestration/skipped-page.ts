import {
  INCOMPLETE_REASON_CODES,
  VIEWPORT_PROFILES,
  type IncompleteReason,
  type PageAuditResult,
  type PageId,
  type ViewportAuditResult,
  type ViewportAuditStatus,
  type ViewportProfile,
} from '../core/contracts.js';
import type { NormalizedHttpUrlEvidence } from '../core/evidence-types.js';
import { isRecord } from '../core/guards.js';
import { deepFreeze } from '../core/immutable.js';
import { derivePageAuditStatus } from '../core/status.js';

const SKIPPED: Extract<ViewportAuditStatus, 'SKIPPED'> = 'SKIPPED';

/**
 * 監査しなかった URL の `PageAuditResult`（Task 14〜17 の設計書 5.6.3）。Run Coordinator は、上限（ページ数・深さ・実行時間）の
 * ために監査しなかった URL にも、この関数で結果を作る。Cross-page rule は、これらを「検証できなかったリンク」として数える。
 * - 両方のビューポートを `SKIPPED` にし、`navigationOutcome`・`finalUrl`・`httpStatus` を `null` にする。
 * - 各ビューポートの理由と、ページ全体の理由を `reason` の1件にする（ページ全体の理由は、両方のビューポートの同じ理由を
 *   1つにまとめたもの。設計書 4.5.5）。
 * - Evidence と Finding は空にする。
 * - ページの状態は `derivePageAuditStatus` で導く（`SKIPPED`）。
 *
 * 引数が不正な場合は `TypeError` を投げる。結果は深く凍結し、呼び出し側の `reason` を共有しない。
 */
export function skippedPageResult(url: NormalizedHttpUrlEvidence, pageId: PageId, reason: IncompleteReason): PageAuditResult {
  if (typeof url !== 'string' || url.length === 0) {
    throw new TypeError('skipped page URL must be a non-empty string');
  }
  if (typeof pageId !== 'string' || pageId.length === 0) {
    throw new TypeError('skipped page ID must be a non-empty string');
  }
  if (
    !isRecord(reason)
    || !(INCOMPLETE_REASON_CODES as readonly unknown[]).includes(reason.code)
    || !Object.hasOwn(reason, 'detail')
    || (reason.detail !== null && typeof reason.detail !== 'string')
  ) {
    throw new TypeError('skipped page reason must be an incomplete reason with a known code and a detail');
  }

  const viewport = (): ViewportAuditResult => ({
    requestedUrl: url,
    finalUrl: null,
    httpStatus: null,
    status: SKIPPED,
    incompleteReasons: [{ code: reason.code, detail: reason.detail }],
    navigationOutcome: null,
  });
  const viewports = Object.fromEntries(VIEWPORT_PROFILES.map((profile) => [profile, viewport()])) as Record<
    ViewportProfile,
    ViewportAuditResult
  >;
  return deepFreeze({
    schemaVersion: 'page-schema/1.0',
    pageId,
    pageUrl: url,
    status: derivePageAuditStatus(VIEWPORT_PROFILES.map((profile) => viewports[profile].status)),
    viewports,
    evidence: [],
    findings: [],
    incompleteReasons: [{ code: reason.code, detail: reason.detail }],
  });
}
